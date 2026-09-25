/* 主线程：仅负责 UI、权限交互与定时调度，重活全部交给 Worker */
const worker = new Worker('worker.js');

const $ = (sel) => document.querySelector(sel);
const els = {
  pickBtn: $('#pickBtn'),
  reauthBtn: $('#reauthBtn'),
  scanNowBtn: $('#scanNowBtn'),
  banner: $('#banner'),
  dirName: $('#dirName'),
  quotaInfo: $('#quotaInfo'),
  lastSnap: $('#lastSnap'),
  nextScan: $('#nextScan'),
  intervalInput: $('#intervalInput'),
  progressWrap: $('#progressWrap'),
  progressBar: $('#progressBar'),
  progressText: $('#progressText'),
  snapList: $('#snapList'),
  diffA: $('#diffA'),
  diffB: $('#diffB'),
  diffBtn: $('#diffBtn'),
  diffResult: $('#diffResult'),
  manifestView: $('#manifestView'),
  toast: $('#toast'),
};

let dirHandle = null;
let permissionOk = false;
let snapshots = [];
let scanTimer = null;
let countdown = 0;
let busyOp = null;

init();

async function init() {
  if (!('showDirectoryPicker' in window)) {
    toast('当前浏览器不支持 File System Access API，请使用 Chrome / Edge', true);
    els.pickBtn.disabled = true;
  }
  dirHandle = await idbGet('handles', 'root');
  const savedInterval = await idbGet('meta', 'interval');
  els.intervalInput.value = savedInterval || 60;
  if (dirHandle) {
    els.dirName.textContent = dirHandle.name;
    await refreshPermission();
  } else {
    setNextScanText('未授权目录');
  }
  await refreshSnapshots();
  await refreshQuota();
  worker.postMessage({ type: 'checkInterrupted' });
  setInterval(tick, 1000);
  setInterval(refreshQuota, 15000);
}

els.pickBtn.onclick = async () => {
  try {
    const handle = await showDirectoryPicker({ mode: 'readwrite' });
    dirHandle = handle;
    await idbPut('handles', handle, 'root');
    els.dirName.textContent = handle.name;
    permissionOk = true;
    hideBanner();
    toast('目录授权成功：' + handle.name);
    startCountdown();
    requestScan();
  } catch (err) {
    if (err.name !== 'AbortError') toast('授权失败：' + err.message, true);
  }
};

els.reauthBtn.onclick = async () => {
  if (!dirHandle) return;
  const perm = await dirHandle.requestPermission({ mode: 'readwrite' });
  if (perm === 'granted') {
    permissionOk = true;
    hideBanner();
    toast('权限已恢复，自动扫描继续');
    startCountdown();
  } else {
    toast('权限仍未授予', true);
  }
};

els.scanNowBtn.onclick = () => requestScan();

els.intervalInput.onchange = async () => {
  const v = Math.max(5, parseInt(els.intervalInput.value, 10) || 60);
  els.intervalInput.value = v;
  await idbPut('meta', v, 'interval');
  startCountdown();
};

els.diffBtn.onclick = () => {
  const a = parseInt(els.diffA.value, 10);
  const b = parseInt(els.diffB.value, 10);
  if (!a || !b || a === b) { toast('请选择两个不同的快照', true); return; }
  worker.postMessage({ type: 'diff', payload: { a, b } });
};

async function refreshPermission() {
  if (!dirHandle) return;
  const perm = await dirHandle.queryPermission({ mode: 'readwrite' });
  permissionOk = perm === 'granted';
  if (permissionOk) {
    hideBanner();
    startCountdown();
  } else {
    showBanner('目录访问权限未授予或已被撤销，自动扫描已暂停。点击「重新授权」恢复。');
    setNextScanText('已暂停（权限缺失）');
  }
}

function showBanner(text) {
  els.banner.textContent = '';
  const span = document.createElement('span');
  span.textContent = text + ' ';
  els.banner.appendChild(span);
  els.banner.appendChild(els.reauthBtn);
  els.reauthBtn.style.display = '';
  els.banner.style.display = 'flex';
}
function hideBanner() { els.banner.style.display = 'none'; }

function requestScan() {
  if (!permissionOk) { showBanner('权限缺失，无法扫描。'); return; }
  worker.postMessage({ type: 'scan' });
}

function startCountdown() {
  clearInterval(scanTimer);
  countdown = parseInt(els.intervalInput.value, 10) || 60;
}

function tick() {
  if (!permissionOk || busyOp) return;
  countdown--;
  if (countdown <= 0) {
    requestScan();
    countdown = parseInt(els.intervalInput.value, 10) || 60;
  }
  setNextScanText(countdown + ' 秒后自动扫描');
}

function setNextScanText(t) { els.nextScan.textContent = t; }

worker.onmessage = async (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'progress':
      busyOp = 'scan';
      if (msg.phase === 'walk') {
        showProgress(-1, '正在遍历目录… 已发现 ' + msg.total + ' 个文件');
      } else {
        showProgress(msg.done / msg.total, '扫描中 ' + msg.done + ' / ' + msg.total);
      }
      break;
    case 'scan-resumed':
      toast('检测到中断的扫描，已从 ' + msg.done + '/' + msg.total + ' 处续扫');
      break;
    case 'scan-done':
      busyOp = null;
      hideProgress();
      toast('快照 #' + msg.id + ' 完成：' + msg.stats.files + ' 个文件，共 ' + formatSize(msg.stats.bytes));
      await refreshSnapshots();
      await refreshQuota();
      startCountdown();
      break;
    case 'permission-lost':
      busyOp = null;
      hideProgress();
      permissionOk = false;
      showBanner('目录访问权限已被撤销，自动扫描已暂停（降级模式：数据仍可查看）。');
      setNextScanText('已暂停（权限缺失）');
      break;
    case 'quota-exceeded':
      busyOp = null;
      hideProgress();
      toast('存储配额不足：' + msg.message + '。可删除旧快照释放空间。', true);
      break;
    case 'interrupted-scan':
      toast('发现未完成的扫描（' + msg.done + '/' + msg.total + '），将自动续扫');
      if (permissionOk) requestScan();
      break;
    case 'interrupted-rollback':
      toast('发现未完成的回滚（快照 #' + msg.snapshotId + '，' + msg.done + '/' + msg.total + '），可重新执行回滚自动续传');
      break;
    case 'rollback-resumed':
      toast('回滚中断续传：从 ' + msg.done + '/' + msg.total + ' 处继续');
      break;
    case 'rollback-progress':
      busyOp = 'rollback';
      showProgress(msg.done / msg.total, '回滚中 ' + msg.done + ' / ' + msg.total);
      break;
    case 'rollback-done':
      busyOp = null;
      hideProgress();
      if (msg.ok) {
        toast('回滚完成并已校验一致：写入 ' + msg.written + '，删除 ' + msg.deleted + '，清理空目录 ' + msg.dirsRemoved);
      } else {
        toast('回滚未完全成功，不一致项：\n' + msg.mismatches.join('\n'), true);
      }
      break;
    case 'diff-result':
      renderDiff(msg.result);
      break;
    case 'manifest':
      renderManifest(msg);
      break;
    case 'snapshot-deleted':
      toast('快照 #' + msg.id + ' 已删除，未引用数据已回收');
      await refreshSnapshots();
      await refreshQuota();
      break;
    case 'error':
      busyOp = null;
      hideProgress();
      toast('错误：' + msg.message, true);
      break;
  }
};

async function refreshSnapshots() {
  snapshots = (await idbGetAll('snapshots')).sort((a, b) => b.id - a.id);
  els.lastSnap.textContent = snapshots.length
    ? '#' + snapshots[0].id + ' · ' + new Date(snapshots[0].createdAt).toLocaleString()
    : '暂无';
  els.snapList.textContent = '';
  for (const snap of snapshots) {
    const li = document.createElement('li');
    const info = document.createElement('span');
    info.textContent = '#' + snap.id + ' · ' + new Date(snap.createdAt).toLocaleString() +
      ' · ' + snap.stats.files + ' 文件 / ' + formatSize(snap.stats.bytes);
    li.appendChild(info);
    li.appendChild(makeBtn('查看', () => worker.postMessage({ type: 'manifest', payload: { id: snap.id } })));
    li.appendChild(makeBtn('回滚到此', () => confirmRollback(snap.id)));
    li.appendChild(makeBtn('删除', () => {
      if (confirm('确定删除快照 #' + snap.id + '？未被引用的文件数据将一并回收。')) {
        worker.postMessage({ type: 'deleteSnapshot', payload: { id: snap.id } });
      }
    }));
    els.snapList.appendChild(li);
  }
  for (const sel of [els.diffA, els.diffB]) {
    sel.textContent = '';
    for (const snap of snapshots) {
      const opt = document.createElement('option');
      opt.value = snap.id;
      opt.textContent = '#' + snap.id + ' · ' + new Date(snap.createdAt).toLocaleString();
      sel.appendChild(opt);
    }
  }
  if (snapshots.length >= 2) els.diffB.selectedIndex = 1;
}

function makeBtn(text, fn) {
  const b = document.createElement('button');
  b.textContent = text;
  b.className = 'small';
  b.onclick = fn;
  return b;
}

function confirmRollback(id) {
  if (!permissionOk) { showBanner('权限缺失，无法回滚。'); return; }
  if (confirm('确定将目录回滚到快照 #' + id + '？\n新增的多余文件会被删除，被修改的文件会被覆盖。')) {
    worker.postMessage({ type: 'rollback', payload: { id } });
  }
}

function renderDiff(result) {
  const box = els.diffResult;
  box.textContent = '';
  box.appendChild(diffSection('新增（' + result.added.length + '）', result.added, 'added'));
  box.appendChild(diffSection('删除（' + result.removed.length + '）', result.removed, 'removed'));
  box.appendChild(diffSection('修改（' + result.modified.length + '）', result.modified, 'modified'));
  if (!result.added.length && !result.removed.length && !result.modified.length) {
    box.textContent = '两个快照内容完全一致。';
  }
}

function diffSection(title, paths, cls) {
  const div = document.createElement('div');
  const h = document.createElement('h4');
  h.textContent = title;
  h.className = cls;
  div.appendChild(h);
  const ul = document.createElement('ul');
  for (const p of paths.slice(0, 200)) {
    const li = document.createElement('li');
    li.textContent = p;
    ul.appendChild(li);
  }
  if (paths.length > 200) {
    const li = document.createElement('li');
    li.textContent = '… 其余 ' + (paths.length - 200) + ' 项省略';
    ul.appendChild(li);
  }
  div.appendChild(ul);
  return div;
}

function renderManifest(msg) {
  const box = els.manifestView;
  box.textContent = '';
  const h = document.createElement('h3');
  h.textContent = '快照 #' + msg.id + ' · ' + new Date(msg.createdAt).toLocaleString() +
    ' · ' + msg.stats.files + ' 文件 / ' + formatSize(msg.stats.bytes);
  box.appendChild(h);
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const t of ['路径', '大小', '内容哈希']) {
    const th = document.createElement('th');
    th.textContent = t;
    head.appendChild(th);
  }
  table.appendChild(head);
  const paths = Object.keys(msg.entries).sort();
  for (const p of paths.slice(0, 500)) {
    const tr = document.createElement('tr');
    const e2 = msg.entries[p];
    for (const v of [p, formatSize(e2.s), e2.h.slice(0, 12) + '…']) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  box.appendChild(table);
  if (paths.length > 500) {
    const more = document.createElement('p');
    more.textContent = '… 其余 ' + (paths.length - 500) + ' 项省略';
    box.appendChild(more);
  }
}

async function refreshQuota() {
  if (!navigator.storage || !navigator.storage.estimate) {
    els.quotaInfo.textContent = '不支持查询';
    return;
  }
  const { usage, quota } = await navigator.storage.estimate();
  els.quotaInfo.textContent = formatSize(usage || 0) + ' / ' + formatSize(quota || 0);
}

function showProgress(ratio, text) {
  els.progressWrap.style.display = 'block';
  els.progressBar.style.width = ratio < 0 ? '100%' : Math.round(ratio * 100) + '%';
  els.progressBar.classList.toggle('indeterminate', ratio < 0);
  els.progressText.textContent = text;
}
function hideProgress() { els.progressWrap.style.display = 'none'; }

let toastTimer = null;
function toast(text, isError) {
  els.toast.textContent = text;
  els.toast.className = isError ? 'toast error' : 'toast';
  els.toast.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.style.display = 'none'; }, isError ? 8000 : 4000);
}

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
