/* 快照引擎：全部重活都在 Worker 中执行，主线程只负责渲染 */
importScripts('db.js');

const CHUNK_SIZE = 1024 * 1024;
const QUOTA_HEADROOM = 64 * 1024 * 1024;
const PROGRESS_SAVE_EVERY = 20;

let busy = false;

onmessage = async (e) => {
  const { type, payload } = e.data || {};
  try {
    if (type === 'scan') {
      if (!busy) { busy = true; await scan(); busy = false; }
    } else if (type === 'rollback') {
      if (!busy) { busy = true; await rollback(payload.id); busy = false; }
    } else if (type === 'diff') {
      await diffSnapshots(payload.a, payload.b);
    } else if (type === 'manifest') {
      await sendManifest(payload.id);
    } else if (type === 'deleteSnapshot') {
      await deleteSnapshot(payload.id);
    } else if (type === 'checkInterrupted') {
      await checkInterrupted();
    }
  } catch (err) {
    busy = false;
    reportError(type, err);
  }
};

function post(msg) { postMessage(msg); }

function reportError(op, err) {
  if (err && err.code === 'quota') {
    post({ type: 'quota-exceeded', op, message: err.message });
  } else if (err && (err.name === 'NotAllowedError' || err.code === 'permission')) {
    post({ type: 'permission-lost', op });
  } else {
    post({ type: 'error', op, message: String((err && err.message) || err) });
  }
}

async function getRootHandle(mode) {
  const handle = await idbGet('handles', 'root');
  if (!handle) { post({ type: 'error', message: '尚未授权目录' }); return null; }
  const perm = await handle.queryPermission({ mode: mode || 'read' });
  if (perm !== 'granted') {
    post({ type: 'permission-lost' });
    return null;
  }
  return handle;
}

async function* walk(dirHandle, prefix) {
  for await (const [name, handle] of dirHandle.entries()) {
    const path = prefix ? prefix + '/' + name : name;
    if (handle.kind === 'file') {
      yield { kind: 'file', path, handle };
    } else {
      yield { kind: 'dir', path, handle };
      yield* walk(handle, path);
    }
  }
}

async function resolveDir(root, parts, create) {
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: !!create });
  }
  return dir;
}

async function resolveFile(root, path) {
  const parts = path.split('/');
  const dir = await resolveDir(root, parts.slice(0, -1), false);
  return dir.getFileHandle(parts[parts.length - 1]);
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function ensureQuota(incomingBytes) {
  if (!navigator.storage || !navigator.storage.estimate) return;
  const { usage, quota } = await navigator.storage.estimate();
  if (!quota) return;
  const remaining = quota - (usage || 0);
  if (remaining < Math.min(incomingBytes, QUOTA_HEADROOM) + QUOTA_HEADROOM) {
    const err = new Error('存储配额不足：剩余约 ' + formatSize(Math.max(remaining, 0)) + '，请清理快照或扩大配额');
    err.code = 'quota';
    throw err;
  }
}

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

async function hashAndStoreFile(file) {
  const chunkHashes = [];
  for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
    const blob = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
    const buf = await blob.arrayBuffer();
    const hash = await sha256Hex(buf);
    chunkHashes.push(hash);
    if (!(await idbHas('chunks', hash))) {
      await idbPut('chunks', { hash, blob }, hash);
    }
  }
  const fileHash = await sha256Hex(new TextEncoder().encode(chunkHashes.join(':')));
  if (!(await idbHas('files', fileHash))) {
    await idbPut('files', { hash: fileHash, size: file.size, chunkHashes }, fileHash);
  }
  return fileHash;
}

async function hashFileOnly(file) {
  const chunkHashes = [];
  for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
    const blob = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
    chunkHashes.push(await sha256Hex(await blob.arrayBuffer()));
  }
  return sha256Hex(new TextEncoder().encode(chunkHashes.join(':')));
}

async function getLatestSnapshot() {
  const all = await idbGetAll('snapshots');
  if (!all.length) return null;
  return all.sort((a, b) => b.id - a.id)[0];
}

async function scan() {
  const root = await getRootHandle('read');
  if (!root) return;

  const lastSnap = await getLatestSnapshot();
  const baseManifest = (lastSnap && lastSnap.entries) || {};

  let state = await idbGet('state', 'scanState');
  let fileList, entries, doneIndex, startedAt;
  if (state && state.fileList) {
    ({ fileList, entries, doneIndex, startedAt } = state);
    post({ type: 'scan-resumed', done: doneIndex, total: fileList.length });
  } else {
    fileList = [];
    let walked = 0;
    for await (const item of walk(root, '')) {
      if (item.kind !== 'file') continue;
      const f = await item.handle.getFile();
      fileList.push({ path: item.path, size: f.size, mtime: f.lastModified });
      if (++walked % 50 === 0) post({ type: 'progress', phase: 'walk', total: walked });
    }
    entries = {};
    doneIndex = 0;
    startedAt = Date.now();
  }

  for (let i = doneIndex; i < fileList.length; i++) {
    const meta = fileList[i];
    const prev = baseManifest[meta.path];
    if (prev && prev.s === meta.size && prev.m === meta.mtime) {
      entries[meta.path] = prev;
    } else {
      await ensureQuota(meta.size);
      const fh = await resolveFile(root, meta.path);
      const file = await fh.getFile();
      const hash = await hashAndStoreFile(file);
      entries[meta.path] = { h: hash, s: meta.size, m: meta.mtime };
    }
    if ((i + 1) % PROGRESS_SAVE_EVERY === 0 || i === fileList.length - 1) {
      await idbPut('state', { key: 'scanState', fileList, entries, doneIndex: i + 1, startedAt }, 'scanState');
      post({ type: 'progress', phase: 'scan', done: i + 1, total: fileList.length });
    }
  }

  const totalBytes = Object.values(entries).reduce((acc, e2) => acc + e2.s, 0);
  const snap = {
    createdAt: Date.now(),
    startedAt,
    entries,
    stats: { files: fileList.length, bytes: totalBytes },
  };
  const id = await idbAdd('snapshots', snap);
  await idbDelete('state', 'scanState');
  post({ type: 'scan-done', id, stats: snap.stats });
}

async function checkInterrupted() {
  const state = await idbGet('state', 'scanState');
  if (state && state.fileList) {
    post({ type: 'interrupted-scan', done: state.doneIndex, total: state.fileList.length });
  }
  const rb = await idbGet('state', 'rollbackState');
  if (rb && rb.ops) {
    post({ type: 'interrupted-rollback', snapshotId: rb.snapshotId, done: rb.doneIndex, total: rb.ops.length });
  }
}

function diffManifests(aEntries, bEntries) {
  const added = [], removed = [], modified = [];
  for (const path of Object.keys(bEntries)) {
    if (!(path in aEntries)) added.push(path);
    else if (aEntries[path].h !== bEntries[path].h) modified.push(path);
  }
  for (const path of Object.keys(aEntries)) {
    if (!(path in bEntries)) removed.push(path);
  }
  const byPath = (x, y) => x.localeCompare(y);
  return { added: added.sort(byPath), removed: removed.sort(byPath), modified: modified.sort(byPath) };
}

async function diffSnapshots(aId, bId) {
  const a = await idbGet('snapshots', aId);
  const b = await idbGet('snapshots', bId);
  if (!a || !b) { post({ type: 'error', op: 'diff', message: '快照不存在' }); return; }
  post({ type: 'diff-result', a: aId, b: bId, result: diffManifests(a.entries, b.entries) });
}

async function sendManifest(id) {
  const snap = await idbGet('snapshots', id);
  if (!snap) { post({ type: 'error', op: 'manifest', message: '快照不存在' }); return; }
  post({ type: 'manifest', id, createdAt: snap.createdAt, stats: snap.stats, entries: snap.entries });
}

async function rollback(snapshotId) {
  const root = await getRootHandle('readwrite');
  if (!root) return;
  const snap = await idbGet('snapshots', snapshotId);
  if (!snap) { post({ type: 'error', op: 'rollback', message: '快照不存在' }); return; }
  const target = snap.entries;

  let journal = await idbGet('state', 'rollbackState');
  let ops, doneIndex;
  if (journal && journal.snapshotId === snapshotId && journal.ops) {
    ({ ops, doneIndex } = journal);
    post({ type: 'rollback-resumed', done: doneIndex, total: ops.length });
  } else {
    ops = await buildRollbackPlan(root, target);
    doneIndex = 0;
    await idbPut('state', { key: 'rollbackState', snapshotId, ops, doneIndex }, 'rollbackState');
  }

  let written = 0, deleted = 0, dirsRemoved = 0;
  for (let i = doneIndex; i < ops.length; i++) {
    const op = ops[i];
    if (op.type === 'write') {
      await writeFileFromChunks(root, op.path, op.h);
      written++;
    } else if (op.type === 'delete') {
      await deleteFileQuiet(root, op.path);
      deleted++;
    } else if (op.type === 'rmdir') {
      if (await removeDirQuiet(root, op.path)) dirsRemoved++;
    }
    await idbPut('state', { key: 'rollbackState', snapshotId, ops, doneIndex: i + 1 }, 'rollbackState');
    if ((i + 1) % 5 === 0 || i === ops.length - 1) {
      post({ type: 'rollback-progress', done: i + 1, total: ops.length });
    }
  }

  const mismatches = await verifyRollback(root, target);
  if (mismatches.length === 0) {
    await idbDelete('state', 'rollbackState');
  }
  post({
    type: 'rollback-done',
    snapshotId,
    ok: mismatches.length === 0,
    written, deleted, dirsRemoved,
    mismatches,
  });
}

async function buildRollbackPlan(root, target) {
  const ops = [];
  const currentFiles = [];
  const currentDirs = [];
  for await (const item of walk(root, '')) {
    if (item.kind === 'file') currentFiles.push(item.path);
    else currentDirs.push(item.path);
  }
  const currentSet = new Set(currentFiles);

  for (const path of currentFiles) {
    const t = target[path];
    if (!t) {
      ops.push({ type: 'delete', path });
      continue;
    }
    const fh = await resolveFile(root, path);
    const f = await fh.getFile();
    if (f.size === t.s && f.lastModified === t.m) continue;
    const hash = await hashFileOnly(f);
    if (hash !== t.h) ops.push({ type: 'write', path, h: t.h });
  }
  for (const path of Object.keys(target)) {
    if (!currentSet.has(path)) ops.push({ type: 'write', path, h: target[path].h });
  }

  const targetDirs = new Set();
  for (const path of Object.keys(target)) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) targetDirs.add(parts.slice(0, i).join('/'));
  }
  const extraDirs = currentDirs
    .filter((d) => !targetDirs.has(d))
    .sort((a, b) => b.split('/').length - a.split('/').length);
  for (const d of extraDirs) ops.push({ type: 'rmdir', path: d });
  return ops;
}

async function writeFileFromChunks(root, path, fileHash) {
  const rec = await idbGet('files', fileHash);
  if (!rec) throw new Error('快照数据缺失：' + fileHash);
  const parts = path.split('/');
  const dir = await resolveDir(root, parts.slice(0, -1), true);
  const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await fh.createWritable();
  try {
    for (const chunkHash of rec.chunkHashes) {
      const chunk = await idbGet('chunks', chunkHash);
      if (!chunk) throw new Error('快照分块缺失：' + chunkHash);
      await writable.write(chunk.blob);
    }
    await writable.close();
  } catch (err) {
    try { await writable.abort(); } catch (e) { /* ignore */ }
    throw err;
  }
  const written = await fh.getFile();
  const actual = await hashFileOnly(written);
  if (actual !== fileHash) {
    throw new Error('回滚校验失败：' + path + ' 写入内容与快照不一致');
  }
}

async function deleteFileQuiet(root, path) {
  try {
    const parts = path.split('/');
    const dir = await resolveDir(root, parts.slice(0, -1), false);
    await dir.removeEntry(parts[parts.length - 1]);
  } catch (err) { /* 文件已不存在等情况忽略 */ }
}

async function removeDirQuiet(root, path) {
  try {
    const parts = path.split('/');
    const parent = await resolveDir(root, parts.slice(0, -1), false);
    await parent.removeEntry(parts[parts.length - 1]);
    return true;
  } catch (err) {
    return false;
  }
}

async function verifyRollback(root, target) {
  const mismatches = [];
  const seen = new Set();
  for await (const item of walk(root, '')) {
    if (item.kind !== 'file') continue;
    seen.add(item.path);
    const t = target[item.path];
    if (!t) { mismatches.push(item.path + '（多余文件）'); continue; }
    const f = await item.handle.getFile();
    const hash = await hashFileOnly(f);
    if (hash !== t.h) mismatches.push(item.path + '（内容不一致）');
  }
  for (const path of Object.keys(target)) {
    if (!seen.has(path)) mismatches.push(path + '（缺失）');
  }
  return mismatches;
}

async function deleteSnapshot(id) {
  await idbDelete('snapshots', id);
  const referencedFiles = new Set();
  const referencedChunks = new Set();
  for (const snap of await idbGetAll('snapshots')) {
    for (const e2 of Object.values(snap.entries)) referencedFiles.add(e2.h);
  }
  const allFiles = await idbGetAll('files');
  for (const f of allFiles) {
    if (referencedFiles.has(f.hash)) {
      for (const c of f.chunkHashes) referencedChunks.add(c);
    } else {
      await idbDelete('files', f.hash);
    }
  }
  const allChunks = await idbGetAll('chunks');
  for (const c of allChunks) {
    if (!referencedChunks.has(c.hash)) await idbDelete('chunks', c.hash);
  }
  post({ type: 'snapshot-deleted', id });
}
