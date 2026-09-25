// Snapshot worker: all heavy work (walking the tree, hashing, writing
// snapshots, rollback) runs here so the main thread stays responsive.

import { Sha256 } from './sha256.js';
import { diffEntries, planRollback, verifyRollback, parentPath } from './diff.js';
import {
  openDb, createSnapshot, updateSnapshot, listSnapshots, getSnapshot,
  deleteSnapshotRecord, putEntries, getEntries, putChunks, getChunkBlobs,
  gcChunks, storageEstimate,
} from './db.js';

const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB
const ENTRY_FLUSH_EVERY = 50;       // batch entry writes
const PROGRESS_EVERY_MS = 120;
const QUOTA_HEADROOM = 32 * 1024 * 1024; // keep this much free, else fail early

let db = null;
let cancelled = false;

const post = (msg) => self.postMessage(msg);

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (!db) db = await openDb();
    switch (msg.type) {
      case 'scan':
        await runScan(msg.handle, msg.trigger || 'manual');
        break;
      case 'rollback':
        await runRollback(msg.handle, msg.snapshotId);
        break;
      case 'deleteSnapshot':
        await runDeleteSnapshot(msg.snapshotId);
        break;
      case 'cancel':
        cancelled = true;
        break;
    }
  } catch (err) {
    reportError(msg.type, err);
  }
};

function reportError(op, err) {
  const revoked = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
  const quota = err && (err.name === 'QuotaExceededError' ||
    (typeof err.message === 'string' && err.message.includes('配额')));
  post({
    type: 'opError',
    op,
    reason: revoked ? 'permission' : quota ? 'quota' : 'unknown',
    message: err?.message || String(err),
  });
}

function checkCancelled() {
  if (cancelled) {
    cancelled = false;
    throw new DOMException('操作已取消', 'AbortError');
  }
}

async function ensureQuota(neededBytes) {
  const est = await storageEstimate();
  if (!est || !est.quota) return;
  const free = est.quota - est.usage;
  if (free < neededBytes + QUOTA_HEADROOM) {
    throw new DOMException(
      `存储配额不足：约剩 ${formatBytes(Math.max(free, 0))}，本次需要约 ${formatBytes(neededBytes)}`,
      'QuotaExceededError');
  }
}

// ---------------------------------------------------------------- scan

async function runScan(handle, trigger) {
  // Reuse maps: last finished snapshot + any interrupted snapshots newer
  // than it. Interrupted entries win (they are newer), which is what makes
  // an interrupted snapshot resumable without re-hashing.
  const snapshots = await listSnapshots(db);
  const done = snapshots.filter((s) => s.status === 'done');
  const interrupted = snapshots.filter((s) => s.status === 'interrupted');
  const reuse = new Map(); // path -> entry
  const lastDone = done[0] || null;
  if (lastDone) {
    for (const e of await getEntries(db, lastDone.id)) reuse.set(e.path, e);
  }
  for (const s of interrupted) {
    if (!lastDone || s.id > lastDone.id) {
      for (const e of await getEntries(db, s.id)) {
        if (e.kind === 'file') reuse.set(e.path, e);
      }
    }
  }

  const snapshotId = await createSnapshot(db, { trigger, rootName: handle.name });
  post({ type: 'scanStarted', snapshotId, reusedFiles: reuse.size });

  const entries = [];
  let pending = [];
  let scannedFiles = 0;
  let reusedFiles = 0;
  let hashedBytes = 0;
  let lastProgress = 0;

  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    await putEntries(db, snapshotId, batch);
  };

  const progress = (currentPath, force) => {
    const now = Date.now();
    if (!force && now - lastProgress < PROGRESS_EVERY_MS) return;
    lastProgress = now;
    post({
      type: 'scanProgress', snapshotId, currentPath,
      scannedFiles, reusedFiles, hashedBytes,
    });
  };

  try {
    const stack = [{ dir: handle, prefix: '' }];
    while (stack.length > 0) {
      checkCancelled();
      const { dir, prefix } = stack.pop();
      for await (const [name, child] of dir.entries()) {
        checkCancelled();
        const path = prefix + name;
        if (child.kind === 'directory') {
          const entry = { path, kind: 'dir', size: 0, mtime: 0, hash: '', chunks: [] };
          entries.push(entry);
          pending.push(entry);
          stack.push({ dir: child, prefix: path + '/' });
          progress(path);
          continue;
        }
        const file = await child.getFile();
        const prev = reuse.get(path);
        if (prev && prev.size === file.size && prev.mtime === file.lastModified) {
          const entry = { path, kind: 'file', size: prev.size, mtime: prev.mtime,
                          hash: prev.hash, chunks: prev.chunks };
          entries.push(entry);
          pending.push(entry);
          reusedFiles++;
        } else {
          await ensureQuota(file.size);
          const entry = await hashAndStoreFile(path, file, (bytes) => {
            hashedBytes += bytes;
            progress(path);
          });
          entries.push(entry);
          pending.push(entry);
        }
        scannedFiles++;
        if (pending.length >= ENTRY_FLUSH_EVERY) await flush();
        progress(path);
      }
    }
    await flush();

    // Skip creating a duplicate snapshot when nothing changed.
    if (lastDone) {
      const prevEntries = await getEntries(db, lastDone.id);
      const d = diffEntries(prevEntries, entries);
      if (d.added.length === 0 && d.removed.length === 0 && d.modified.length === 0) {
        await deleteSnapshotRecord(db, snapshotId);
        post({ type: 'scanNoChange', basedOn: lastDone.id });
        return;
      }
    }

    const fileCount = entries.filter((e) => e.kind === 'file').length;
    const dirCount = entries.length - fileCount;
    const totalSize = entries.reduce((sum, e) => sum + (e.size || 0), 0);
    await updateSnapshot(db, snapshotId, {
      status: 'done', finishedAt: Date.now(), fileCount, dirCount, totalSize,
    });
    post({ type: 'scanDone', snapshotId, fileCount, dirCount, totalSize, reusedFiles });
  } catch (err) {
    if (err.name === 'AbortError') {
      await updateSnapshot(db, snapshotId, { status: 'interrupted', finishedAt: Date.now() });
      post({ type: 'scanInterrupted', snapshotId });
    } else {
      await updateSnapshot(db, snapshotId, {
        status: err.name === 'QuotaExceededError' ? 'failed' : 'interrupted',
        finishedAt: Date.now(),
        error: err.message || String(err),
      });
      throw err;
    }
  }
}

async function hashAndStoreFile(path, file, onBytes) {
  const hasher = new Sha256();
  const chunkHashes = [];
  const chunksToStore = [];
  for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
    checkCancelled();
    const blob = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));
    const buf = new Uint8Array(await blob.arrayBuffer());
    hasher.update(buf);
    const chunkHasher = new Sha256();
    chunkHasher.update(buf);
    const hash = chunkHasher.digestHex();
    chunkHashes.push(hash);
    chunksToStore.push({ hash, blob: new Blob([buf]) });
    if (chunksToStore.length >= 8) {
      await putChunks(db, chunksToStore);
      chunksToStore.length = 0;
    }
    onBytes(buf.length);
  }
  await putChunks(db, chunksToStore);
  return {
    path, kind: 'file', size: file.size, mtime: file.lastModified,
    hash: hasher.digestHex(), chunks: chunkHashes,
  };
}

// ------------------------------------------------------------- rollback

async function runRollback(handle, snapshotId) {
  const snapshot = await getSnapshot(db, snapshotId);
  if (!snapshot || snapshot.status !== 'done') {
    post({ type: 'rollbackFailed', snapshotId, message: '快照不存在或未完整，无法回滚' });
    return;
  }
  const manifest = await getEntries(db, snapshotId);
  post({ type: 'rollbackStarted', snapshotId, total: manifest.length });

  try {
    // 1. Scan current state (hashing only files that may differ).
    const current = await scanCurrent(handle, manifest);

    // 2. Plan.
    const plan = planRollback(manifest, current);
    post({ type: 'rollbackPlan', snapshotId, plan: summarizePlan(plan) });

    // 3. Execute: mkdirs -> restore files -> delete extras -> remove dirs.
    for (const dirPath of plan.createDirs) {
      checkCancelled();
      await ensureDir(handle, dirPath);
    }
    let restored = 0;
    for (const entry of plan.restore) {
      checkCancelled();
      await restoreFile(handle, entry);
      restored++;
      post({ type: 'rollbackProgress', snapshotId, phase: 'restore',
             done: restored, total: plan.restore.length, currentPath: entry.path });
    }
    let deleted = 0;
    for (const path of plan.deleteFiles) {
      checkCancelled();
      await removeFile(handle, path);
      deleted++;
      post({ type: 'rollbackProgress', snapshotId, phase: 'delete',
             done: deleted, total: plan.deleteFiles.length, currentPath: path });
    }
    for (const dirPath of plan.removeDirs) {
      checkCancelled();
      await removeDir(handle, dirPath);
    }

    // 4. Verify: re-scan and compare against the manifest.
    const after = await scanCurrent(handle, manifest);
    const result = verifyRollback(manifest, after);
    if (result.ok) {
      post({ type: 'rollbackDone', snapshotId,
             restored: plan.restore.length, deleted: plan.deleteFiles.length });
    } else {
      post({ type: 'rollbackFailed', snapshotId,
             message: `回滚校验失败：缺失 ${result.missing.length}，不一致 ${result.mismatches.length}，残留 ${result.extras.length}`,
             detail: result });
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      post({ type: 'rollbackFailed', snapshotId,
             message: '回滚被中断，目录可能处于不一致状态，请重新执行回滚' });
    } else {
      throw err;
    }
  }
}

function summarizePlan(plan) {
  return {
    restore: plan.restore.length,
    deleteFiles: plan.deleteFiles.length,
    createDirs: plan.createDirs.length,
    removeDirs: plan.removeDirs.length,
  };
}

// Walk the working tree. Files whose size+mtime match the manifest keep the
// manifest hash (trusted unchanged); everything else is re-hashed.
async function scanCurrent(handle, manifest) {
  const manifestMap = new Map(manifest.map((e) => [e.path, e]));
  const entries = [];
  const stack = [{ dir: handle, prefix: '' }];
  while (stack.length > 0) {
    checkCancelled();
    const { dir, prefix } = stack.pop();
    for await (const [name, child] of dir.entries()) {
      checkCancelled();
      const path = prefix + name;
      if (child.kind === 'directory') {
        entries.push({ path, kind: 'dir', size: 0, mtime: 0, hash: '', chunks: [] });
        stack.push({ dir: child, prefix: path + '/' });
      } else {
        const file = await child.getFile();
        const want = manifestMap.get(path);
        if (want && want.kind === 'file' &&
            want.size === file.size && want.mtime === file.lastModified) {
          entries.push({ path, kind: 'file', size: file.size,
                         mtime: file.lastModified, hash: want.hash, chunks: [] });
        } else {
          const hasher = new Sha256();
          for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
            checkCancelled();
            const buf = new Uint8Array(
              await file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size)).arrayBuffer());
            hasher.update(buf);
          }
          entries.push({ path, kind: 'file', size: file.size,
                         mtime: file.lastModified, hash: hasher.digestHex(), chunks: [] });
        }
      }
    }
  }
  return entries;
}

async function ensureDir(root, dirPath) {
  const parts = dirPath.split('/');
  let dir = root;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
}

async function restoreFile(root, entry) {
  const parent = parentPath(entry.path);
  const dir = parent ? await getDir(root, parent, true) : root;
  const name = entry.path.slice(parent ? parent.length + 1 : 0);
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const blobs = await getChunkBlobs(db, entry.chunks);
  const writable = await fileHandle.createWritable();
  try {
    for (const blob of blobs) await writable.write(blob);
    await writable.close();
  } catch (err) {
    try { await writable.abort(); } catch { /* ignore */ }
    throw err;
  }
}

async function getDir(root, dirPath, create) {
  let dir = root;
  for (const part of dirPath.split('/')) {
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return dir;
}

async function removeFile(root, path) {
  const parent = parentPath(path);
  const dir = parent ? await getDir(root, parent, false) : root;
  const name = path.slice(parent ? parent.length + 1 : 0);
  await dir.removeEntry(name);
}

async function removeDir(root, dirPath) {
  const parent = parentPath(dirPath);
  const dir = parent ? await getDir(root, parent, false) : root;
  const name = dirPath.slice(parent ? parent.length + 1 : 0);
  await dir.removeEntry(name, { recursive: true });
}

// -------------------------------------------------------------- delete

async function runDeleteSnapshot(snapshotId) {
  await deleteSnapshotRecord(db, snapshotId);
  const removed = await gcChunks(db);
  post({ type: 'snapshotDeleted', snapshotId, chunksRemoved: removed });
}

// -------------------------------------------------------------- utils

function formatBytes(bytes) {
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
