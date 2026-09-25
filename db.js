/* IndexedDB 封装，主线程与 Web Worker 共用（不依赖 window） */
const DB_NAME = 'fs-snapshot-tool';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('snapshots')) {
        db.createObjectStore('snapshots', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let _dbPromise = null;
function db() {
  if (!_dbPromise) _dbPromise = openDB();
  return _dbPromise;
}

function isQuotaError(err) {
  return err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED');
}

async function idbReq(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const result = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(result && result.result !== undefined ? result.result : undefined);
    tx.onerror = () => {
      const err = tx.error;
      if (isQuotaError(err)) {
        const q = new Error('存储配额不足，无法写入快照数据');
        q.code = 'quota';
        reject(q);
      } else {
        reject(err);
      }
    };
    tx.onabort = () => reject(tx.error);
  });
}

function idbGet(store, key) {
  return idbReq(store, 'readonly', (os) => os.get(key));
}
function idbGetAll(store) {
  return idbReq(store, 'readonly', (os) => os.getAll());
}
function idbPut(store, value, key) {
  return idbReq(store, 'readwrite', (os) => os.put(value, key));
}
function idbAdd(store, value) {
  return idbReq(store, 'readwrite', (os) => os.add(value));
}
function idbDelete(store, key) {
  return idbReq(store, 'readwrite', (os) => os.delete(key));
}
async function idbHas(store, key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction(store).objectStore(store).getKey(key);
    r.onsuccess = () => resolve(r.result !== undefined);
    r.onerror = () => reject(r.error);
  });
}
