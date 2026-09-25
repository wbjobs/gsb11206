// Main thread: UI, permission lifecycle, scheduling. All heavy lifting
// (walk/hash/rollback) happens in the module worker.

import {
  openDb, saveHandle, loadHandle, clearHandle, listSnapshots, getEntries,
  updateSnapshot, getMeta, setMeta, storageEstimate,
} from './db.js';
import { diffEntries } from './diff.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  db: null,
  worker: null,
  handle: null,
  permission: 'unsupported', // 'granted' | 'prompt' | 'denied' | 'unsupported'
  scanning: false,
  rollingBack: false,
  snapshots: [],
  selected: new Set(),
  timerId: null,
};

init();

async function init() {
  if (!('showDirectoryPicker' in window)) {
    showBanner('当前浏览器不支持 File System Access API，请使用 Chrome / Edge 最新版。', 'error');
    disableAll();
    return;
  }
  state.db = await openDb();
  state.worker = new Worker('./js/worker.js', { type: 'module' });
  state.worker.onmessage = onWorkerMessage;
  state.worker.onerror = (e) => toast(`Worker 错误：${e.message}`, 'error');

  // Snapshots left in 'running' state mean the page closed mid-scan:
  // mark them interrupted so their entries can be reused on resume.
  for (const s of await listSnapshots(state.db)) {
    if (s.status === 'running') {
      await updateSnapshot(state.db, s.id, { status: 'interrupted', finishedAt: Date.now() });
    }
  }

  bindUi();
  await restoreHandle();
  await refreshSnapshots();
  await refreshQuota();
  setInterval(refreshQuota, 15000);
  restartTimer();
}

function bindUi() {
  $('#btnPick').addEventListener('click', pickDirectory);
  $('#btnReauth').addEventListener('click', reauthorize);
  $('#btnForget').addEventListener('click', forgetDirectory);
  $('#btnScan').addEventListener('click', () => startScan('manual'));
  $('#btnCancel').addEventListener('click', () => {
    state.worker.postMessage({ type: 'cancel' });
  });
  $('#btnCompare').addEventListener('click', compareSelected);
  $('#btnRollback').addEventListener('click', rollbackSelected);
  $('#btnDelete').addEventListener('click', deleteSelected);
  $('#intervalSelect').addEventListener('change', async (e) => {
    await setMeta(state.db, 'scanIntervalSec', Number(e.target.value));
    restartTimer();
  });
  getMeta(state.db, 'scanIntervalSec').then((v) => {
    $('#intervalSelect').value = String(v ?? 60);
  });
}

// ------------------------------------------------------- permissions

async function pickDirectory() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (err) {
    if (err.name !== 'AbortError') toast(`选择目录失败：${err.message}`, 'error');
    return;
  }
  state.handle = handle;
  await saveHandle(state.db, handle);
  if (navigator.storage?.persist) {
    try { await navigator.storage.persist(); } catch { /* best effort */ }
  }
  await checkPermission();
  await refreshQuota();
  if (state.permission === 'granted') startScan('manual');
}

async function restoreHandle() {
  const row = await loadHandle(state.db);
  if (!row) {
    renderPermission();
    return;
  }
  state.handle = row.handle;
  await checkPermission();
}

async function checkPermission() {
  if (!state.handle) {
    state.permission = 'prompt';
    renderPermission();
    return;
  }
  try {
    state.permission = await state.handle.queryPermission({ mode: 'readwrite' });
  } catch {
    state.permission = 'denied';
  }
  renderPermission();
}

async function reauthorize() {
  if (!state.handle) return pickDirectory();
  try {
    const result = await state.handle.requestPermission({ mode: 'readwrite' });
    state.permission = result;
  } catch {
    state.permission = 'denied';
  }
  renderPermission();
  if (state.permission === 'granted') {
    toast('权限已恢复', 'ok');
    await refreshSnapshots();
  }
}

async function forgetDirectory() {
  await clearHandle(state.db);
  state.handle = null;
  state.permission = 'prompt';
  renderPermission();
}

function onPermissionRevoked() {
  state.permission = 'denied';
  renderPermission();
  showBanner('目录访问权限已被撤销，扫描与回滚已暂停。点击「重新授权」恢复。', 'error');
}

function renderPermission() {
  const hasHandle = !!state.handle;
  const granted = state.permission === 'granted';
  $('#dirName').textContent = hasHandle ? state.handle.name : '未选择目录';
  $('#btnScan').disabled = !granted || state.scanning || state.rollingBack;
  $('#btnRollback').disabled = !granted || state.rollingBack || state.scanning;
  $('#btnReauth').hidden = granted;
  $('#btnForget').hidden = !hasHandle;
  $('#intervalSelect').disabled = !granted;
  const badge = $('#permBadge');
  badge.textContent = { granted: '已授权', prompt: '待授权', denied: '已撤销' }[state.permission] || state.permission;
  badge.className = `badge ${granted ? 'ok' : 'warn'}`;
  if (granted) hideBanner();
  else if (hasHandle && state.permission === 'denied') {
    showBanner('目录访问权限已被撤销，扫描与回滚已暂停。点击「重新授权」恢复。', 'error');
  } else if (hasHandle) {
    showBanner('需要授权后才能扫描目录。', 'warn');
  }
}

// ----------------------------------------------------------- scanning

function startScan(trigger) {
  if (!state.handle || state.scanning || state.rollingBack) return;
  if (state.permission !== 'granted') {
    showBanner('没有目录权限，无法扫描。', 'warn');
    return;
  }
  state.scanning = true;
  renderPermission();
  showProgress('扫描中…');
  state.worker.postMessage({ type: 'scan', handle: state.handle, trigger });
}

function restartTimer() {
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = setInterval(async () => {
    const sec = Number($('#intervalSelect').value);
    if (!sec || sec <= 0) return;
    if (state.scanning || state.rollingBack) return;
    if (state.permission !== 'granted') return;
    const last = (await getMeta(state.db, 'lastScanAt')) || 0;
    if (Date.now() - last >= sec * 1000) {
      await setMeta(state.db, 'lastScanAt', Date.now());
      startScan('auto');
    }
  }, 1000);
}

// ------------------------------------------------------ worker events

async function onWorkerMessage(event) {
  const msg = event.data;
  switch (msg.type) {
    case 'scanStarted':
      showProgress(`扫描中…（可复用 ${msg.reusedFiles} 个历史文件记录）`);
      break;
    case 'scanProgress':
      showProgress(`扫描中… 已处理 ${msg.scannedFiles} 个文件` +
        `（复用 ${msg.reusedFiles}，新读取 ${formatBytes(msg.hashedBytes)}） ${msg.currentPath}`);
      break;
    case 'scanDone':
      state.scanning = false;
      hideProgress();
      toast(`快照 #${msg.snapshotId} 完成：${msg.fileCount} 个文件，${formatBytes(msg.totalSize)}`, 'ok');
      await setMeta(state.db, 'lastScanAt', Date.now());
      await refreshSnapshots();
      await refreshQuota();
      renderPermission();
      break;
    case 'scanNoChange':
      state.scanning = false;
      hideProgress();
      toast('目录无变化，未生成新快照', 'ok');
      await setMeta(state.db, 'lastScanAt', Date.now());
      renderPermission();
      break;
    case 'scanInterrupted':
      state.scanning = false;
      hideProgress();
      toast(`快照 #${msg.snapshotId} 已中断，下次扫描将自动续扫`, 'warn');
      await refreshSnapshots();
      renderPermission();
      break;
    case 'rollbackStarted':
      showProgress('回滚中…');
      break;
    case 'rollbackPlan':
      showProgress(`回滚中… 计划：恢复 ${msg.plan.restore}，删除 ${msg.plan.deleteFiles}，` +
        `建目录 ${msg.plan.createDirs}，删目录 ${msg.plan.removeDirs}`);
      break;
    case 'rollbackProgress':
      showProgress(`回滚中（${msg.phase === 'restore' ? '恢复' : '清理'} ${msg.done}/${msg.total}） ${msg.currentPath}`);
      break;
    case 'rollbackDone':
      state.rollingBack = false;
      hideProgress();
      toast(`回滚完成并已校验：恢复 ${msg.restored} 个文件，删除 ${msg.deleted} 个多余文件`, 'ok');
      await refreshSnapshots();
      renderPermission();
      break;
    case 'rollbackFailed':
      state.rollingBack = false;
      hideProgress();
      toast(`回滚失败：${msg.message}`, 'error');
      renderPermission();
      break;
    case 'snapshotDeleted':
      toast(`快照 #${msg.snapshotId} 已删除，回收 ${msg.chunksRemoved} 个数据块`, 'ok');
      state.selected.delete(msg.snapshotId);
      await refreshSnapshots();
      await refreshQuota();
      break;
    case 'opError':
      state.scanning = false;
      state.rollingBack = false;
      hideProgress();
      if (msg.reason === 'permission') {
        onPermissionRevoked();
      } else if (msg.reason === 'quota') {
        showBanner(`存储配额不足：${msg.message}。可删除旧快照释放空间。`, 'error');
      } else {
        toast(`操作失败：${msg.message}`, 'error');
      }
      await refreshSnapshots();
      await refreshQuota();
      renderPermission();
      break;
  }
}

// -------------------------------------------------------- snapshot UI

async function refreshSnapshots() {
  state.snapshots = await listSnapshots(state.db);
  const tbody = $('#snapshotRows');
  tbody.textContent = '';
  for (const s of state.snapshots) {
    const tr = document.createElement('tr');
    if (s.status !== 'done') tr.className = 'row-muted';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selected.has(s.id);
    cb.disabled = s.status !== 'done';
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(s.id);
      else state.selected.delete(s.id);
      updateActionButtons();
    });
    const statusText = {
      done: '完成', running: '进行中', interrupted: '已中断（可续）', failed: '失败',
    }[s.status] || s.status;
    tr.append(
      td(cb),
      td(`#${s.id}`),
      td(formatTime(s.createdAt)),
      td(s.trigger === 'auto' ? '定时' : '手动'),
      td(statusText),
      td(s.status === 'done' ? `${s.fileCount} 文件 / ${s.dirCount} 目录` : (s.error || '—')),
      td(s.status === 'done' ? formatBytes(s.totalSize) : '—'),
    );
    tbody.append(tr);
  }
  updateActionButtons();
}

function updateActionButtons() {
  const n = state.selected.size;
  $('#btnCompare').disabled = n !== 2;
  $('#btnRollback').disabled = n !== 1 || state.rollingBack || state.permission !== 'granted';
  $('#btnDelete').disabled = n === 0;
}

async function compareSelected() {
  const ids = [...state.selected].sort((a, b) => a - b);
  const [oldEntries, newEntries] = await Promise.all([
    getEntries(state.db, ids[0]),
    getEntries(state.db, ids[1]),
  ]);
  const diff = diffEntries(oldEntries, newEntries);
  renderDiff(ids[0], ids[1], diff);
}

function renderDiff(oldId, newId, diff) {
  const box = $('#diffResult');
  box.textContent = '';
  const title = document.createElement('h3');
  title.textContent = `快照 #${oldId} → #${newId}：` +
    `新增 ${diff.added.length}，删除 ${diff.removed.length}，修改 ${diff.modified.length}`;
  box.append(title);
  if (diff.added.length + diff.removed.length + diff.modified.length === 0) {
    box.append(el('p', '两个快照内容完全一致。'));
    return;
  }
  box.append(diffList('新增', diff.added.map((e) => `${e.path}${e.kind === 'dir' ? '/' : ''}`), 'added'));
  box.append(diffList('删除', diff.removed.map((e) => `${e.path}${e.kind === 'dir' ? '/' : ''}`), 'removed'));
  box.append(diffList('修改', diff.modified.map((m) =>
    `${m.path}（${formatBytes(m.before.size)} → ${formatBytes(m.after.size)}）`), 'modified'));
}

function diffList(label, items, cls) {
  const wrap = document.createElement('div');
  wrap.append(el('h4', `${label}（${items.length}）`));
  const ul = document.createElement('ul');
  ul.className = `diff-list ${cls}`;
  for (const item of items.slice(0, 200)) {
    const li = document.createElement('li');
    li.textContent = item;
    ul.append(li);
  }
  if (items.length > 200) {
    const li = document.createElement('li');
    li.textContent = `… 其余 ${items.length - 200} 条省略`;
    ul.append(li);
  }
  wrap.append(ul);
  return wrap;
}

// ------------------------------------------------------ rollback / delete

async function rollbackSelected() {
  const id = [...state.selected][0];
  const snapshot = state.snapshots.find((s) => s.id === id);
  if (!snapshot || snapshot.status !== 'done') return;
  const ok = confirm(
    `确定将目录「${state.handle.name}」回滚到快照 #${id}（${formatTime(snapshot.createdAt)}）吗？\n\n` +
    '这会：\n· 恢复被修改/删除的文件\n· 删除快照之后新增的文件\n\n回滚完成后会自动校验一致性。');
  if (!ok) return;
  state.rollingBack = true;
  renderPermission();
  updateActionButtons();
  state.worker.postMessage({ type: 'rollback', handle: state.handle, snapshotId: id });
}

async function deleteSelected() {
  const ids = [...state.selected];
  if (!confirm(`确定删除 ${ids.length} 个快照？未引用的数据块会被回收。`)) return;
  for (const id of ids) {
    state.worker.postMessage({ type: 'deleteSnapshot', snapshotId: id });
  }
}

// ------------------------------------------------------------- quota UI

async function refreshQuota() {
  const est = await storageEstimate();
  if (!est || !est.quota) {
    $('#quotaText').textContent = '存储用量未知';
    return;
  }
  const pct = Math.min(100, (est.usage / est.quota) * 100);
  $('#quotaFill').style.width = `${pct}%`;
  $('#quotaFill').className = pct > 90 ? 'fill danger' : pct > 70 ? 'fill warn' : 'fill';
  $('#quotaText').textContent =
    `已用 ${formatBytes(est.usage)} / 约 ${formatBytes(est.quota)}（${pct.toFixed(1)}%）`;
  if (pct > 90) showBanner('存储配额即将耗尽，新快照可能失败。请删除旧快照释放空间。', 'warn');
}

// ------------------------------------------------------------- helpers

function td(node) {
  const cell = document.createElement('td');
  if (typeof node === 'string') cell.textContent = node;
  else cell.append(node);
  return cell;
}

function el(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function showProgress(text) {
  $('#progress').hidden = false;
  $('#progressText').textContent = text;
  $('#btnCancel').hidden = false;
}

function hideProgress() {
  $('#progress').hidden = true;
  $('#btnCancel').hidden = true;
}

function showBanner(text, kind) {
  const banner = $('#banner');
  banner.textContent = text;
  banner.className = `banner ${kind}`;
  banner.hidden = false;
}

function hideBanner() {
  $('#banner').hidden = true;
}

function toast(text, kind) {
  const box = $('#toasts');
  const node = el('div', text);
  node.className = `toast ${kind}`;
  box.append(node);
  setTimeout(() => node.remove(), 6000);
}

function disableAll() {
  for (const btn of document.querySelectorAll('button')) btn.disabled = true;
}

function formatTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function formatBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 'B';
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value.toFixed(1)} ${unit}`;
}
