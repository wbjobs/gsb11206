// Pure snapshot logic shared by the worker (browser) and Node tests.
// Entries: { path, kind: 'file'|'dir', size, mtime, hash, chunks: [hash...] }

export function entriesToMap(entries) {
  const map = new Map();
  for (const e of entries) map.set(e.path, e);
  return map;
}

// Compare two snapshots' entries. Returns { added, removed, modified }.
// added/removed: arrays of entries; modified: [{ path, before, after }].
export function diffEntries(oldEntries, newEntries) {
  const oldMap = entriesToMap(oldEntries);
  const newMap = entriesToMap(newEntries);
  const added = [];
  const removed = [];
  const modified = [];
  for (const [path, after] of newMap) {
    const before = oldMap.get(path);
    if (!before) {
      added.push(after);
    } else if (before.kind !== after.kind ||
               (after.kind === 'file' && before.hash !== after.hash)) {
      modified.push({ path, before, after });
    }
  }
  for (const [path, before] of oldMap) {
    if (!newMap.has(path)) removed.push(before);
  }
  const byPath = (a, b) => {
    const pa = a.path ?? a.after?.path;
    const pb = b.path ?? b.after?.path;
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  };
  added.sort(byPath);
  removed.sort(byPath);
  modified.sort(byPath);
  return { added, removed, modified };
}

export function isManifestEqual(aEntries, bEntries) {
  const d = diffEntries(aEntries, bEntries);
  return d.added.length === 0 && d.removed.length === 0 && d.modified.length === 0;
}

// Plan a rollback: bring the working directory back to `manifestEntries`.
// currentEntries: scan of the working tree (files need hash when decidable).
// Returns { restore, deleteFiles, createDirs, removeDirs }.
//  - restore: manifest file entries that are missing or content-differs
//  - deleteFiles: current file paths not present in the manifest
//  - createDirs: manifest dirs missing on disk (sorted shallow-first)
//  - removeDirs: top-most current dirs not in the manifest (recursive removal)
export function planRollback(manifestEntries, currentEntries) {
  const manifest = entriesToMap(manifestEntries);
  const current = entriesToMap(currentEntries);

  const restore = [];
  const createDirs = [];
  for (const [path, want] of manifest) {
    const have = current.get(path);
    if (want.kind === 'dir') {
      if (!have || have.kind !== 'dir') createDirs.push(path);
    } else {
      if (!have || have.kind !== 'file' || have.hash !== want.hash) restore.push(want);
    }
  }

  const deleteFiles = [];
  const extraDirs = [];
  for (const [path, have] of current) {
    const want = manifest.get(path);
    if (have.kind === 'file') {
      if (!want || want.kind !== 'file') deleteFiles.push(path);
    } else if (!want || want.kind !== 'dir') {
      extraDirs.push(path);
    }
  }

  // Keep only top-most extra dirs; children disappear with the recursive remove.
  const extraDirSet = new Set(extraDirs);
  const removeDirs = extraDirs
    .filter((d) => {
      let parent = parentPath(d);
      while (parent !== null) {
        if (extraDirSet.has(parent)) return false;
        parent = parentPath(parent);
      }
      return true;
    })
    .sort();

  createDirs.sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1));
  restore.sort((a, b) => (a.path < b.path ? -1 : 1));
  deleteFiles.sort();
  return { restore, deleteFiles, createDirs, removeDirs };
}

export function parentPath(path) {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? null : path.slice(0, idx);
}

function depth(path) {
  return path.split('/').length;
}

// Verify a rollback result: every manifest file must exist with the same hash,
// and no extra files may remain. Returns { ok, mismatches, extras, missing }.
export function verifyRollback(manifestEntries, afterEntries) {
  const manifest = entriesToMap(manifestEntries);
  const after = entriesToMap(afterEntries);
  const mismatches = [];
  const missing = [];
  const extras = [];
  for (const [path, want] of manifest) {
    const have = after.get(path);
    if (!have) {
      missing.push(path);
    } else if (want.kind === 'file' && (have.kind !== 'file' || have.hash !== want.hash)) {
      mismatches.push(path);
    } else if (want.kind === 'dir' && have.kind !== 'dir') {
      mismatches.push(path);
    }
  }
  for (const [path] of after) {
    if (!manifest.has(path)) extras.push(path);
  }
  return { ok: missing.length === 0 && mismatches.length === 0 && extras.length === 0,
           missing, mismatches, extras };
}
