// IndexedDB layer. Shared by the page and the worker.
//
// Stores:
//   handles   : out-of-line keys, persists the FileSystemDirectoryHandle
//   snapshots : { id, createdAt, finishedAt, status, trigger, rootName,
//                 fileCount, dirCount, totalSize, error }
//               status: 'running' | 'done' | 'interrupted' | 'failed'
//   entries   : keyPath [snapshotId, path], index 'bySnapshot' on snapshotId
//               { snapshotId, path, kind, size, mtime, hash, chunks }
//   chunks    : content-addressed file data, keyPath 'hash' -> { hash, blob }
//   meta      : small key/value bag (settings, last-scan info)

const DB_NAME = 'local-file-snapshots';
const DB_VERSION = 1;

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
      if (!db.objectStoreNames.contains('snapshots')) {
        db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('entries')) {
        const entries = db.createObjectStore('entries', { keyPath: ['snapshotId', 'path'] });
        entries.createIndex('bySnapshot', 'snapshotId', { unique: false });
      }
      if (!db.objectStoreNames.contains('chunks')) {
        db.createObjectStore('chunks', { keyPath: 'hash' });
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveHandle(db, handle) {
  const tx = db.transaction('handles', 'readwrite');
  tx.objectStore('handles').put({ handle, name: handle.name, savedAt: Date.now() }, 'root');
  await txDone(tx);
}

export async function loadHandle(db) {
  const tx = db.transaction('handles', 'readonly');
  const row = await reqToPromise(tx.objectStore('handles').get('root'));
  return row || null;
}

export async function clearHandle(db) {
  const tx = db.transaction('handles', 'readwrite');
  tx.objectStore('handles').delete('root');
  await txDone(tx);
}

export async function createSnapshot(db, fields) {
  const tx = db.transaction('snapshots', 'readwrite');
  const id = await reqToPromise(tx.objectStore('snapshots').add({
    createdAt: Date.now(),
    finishedAt: null,
    status: 'running',
    trigger: 'manual',
    rootName: '',
    fileCount: 0,
    dirCount: 0,
    totalSize: 0,
    error: null,
    ...fields,
  }));
  await txDone(tx);
  return id;
}

export async function updateSnapshot(db, id, patch) {
  const tx = db.transaction('snapshots', 'readwrite');
  const store = tx.objectStore('snapshots');
  const row = await reqToPromise(store.get(id));
  if (row) store.put({ ...row, ...patch, id });
  await txDone(tx);
}

export async function getSnapshot(db, id) {
  const tx = db.transaction('snapshots', 'readonly');
  return reqToPromise(tx.objectStore('snapshots').get(id));
}

export async function listSnapshots(db) {
  const tx = db.transaction('snapshots', 'readonly');
  const all = await reqToPromise(tx.objectStore('snapshots').getAll());
  return all.sort((a, b) => b.id - a.id);
}

export async function deleteSnapshotRecord(db, id) {
  const tx = db.transaction(['snapshots', 'entries'], 'readwrite');
  tx.objectStore('snapshots').delete(id);
  const idx = tx.objectStore('entries').index('bySnapshot');
  const keys = await reqToPromise(idx.getAllKeys(id));
  for (const key of keys) tx.objectStore('entries').delete(key);
  await txDone(tx);
}

export async function putEntries(db, snapshotId, entries) {
  if (entries.length === 0) return;
  const tx = db.transaction('entries', 'readwrite');
  const store = tx.objectStore('entries');
  for (const e of entries) store.put({ ...e, snapshotId });
  await txDone(tx);
}

export async function getEntries(db, snapshotId) {
  const tx = db.transaction('entries', 'readonly');
  return reqToPromise(tx.objectStore('entries').index('bySnapshot').getAll(snapshotId));
}

// Store chunks content-addressed; existing hashes are skipped (dedup).
export async function putChunks(db, chunks) {
  if (chunks.length === 0) return;
  const tx = db.transaction('chunks', 'readwrite');
  const store = tx.objectStore('chunks');
  for (const { hash, blob } of chunks) {
    const existing = await reqToPromise(store.getKey(hash));
    if (!existing) store.put({ hash, blob });
  }
  await txDone(tx);
}

export async function getChunkBlobs(db, hashes) {
  const tx = db.transaction('chunks', 'readonly');
  const store = tx.objectStore('chunks');
  const out = [];
  for (const hash of hashes) {
    const row = await reqToPromise(store.get(hash));
    if (!row) throw new Error(`快照数据缺失：块 ${hash.slice(0, 12)}… 不存在（存储可能被清理）`);
    out.push(row.blob);
  }
  return out;
}

// Remove chunks no longer referenced by any remaining snapshot entry.
export async function gcChunks(db, onProgress) {
  const referenced = new Set();
  {
    const tx = db.transaction('entries', 'readonly');
    const all = await reqToPromise(tx.objectStore('entries').getAll());
    for (const e of all) if (e.chunks) for (const h of e.chunks) referenced.add(h);
  }
  const tx = db.transaction('chunks', 'readwrite');
  const store = tx.objectStore('chunks');
  const keys = await reqToPromise(store.getAllKeys());
  let removed = 0;
  for (const key of keys) {
    if (!referenced.has(key)) {
      store.delete(key);
      removed++;
      if (onProgress) onProgress(removed);
    }
  }
  await txDone(tx);
  return removed;
}

export async function getMeta(db, key) {
  const tx = db.transaction('meta', 'readonly');
  return reqToPromise(tx.objectStore('meta').get(key));
}

export async function setMeta(db, key, value) {
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put(value, key);
  await txDone(tx);
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage, quota };
}
