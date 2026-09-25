// Pure-logic tests runnable with: node test/run-tests.mjs
import { createHash, randomBytes } from 'node:crypto';
import { Sha256, sha256Hex } from '../js/sha256.js';
import { diffEntries, planRollback, verifyRollback, isManifestEqual } from '../js/diff.js';

let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`FAIL  ${name}`); }
}

function refSha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// ---- sha256 ----------------------------------------------------------
console.log('sha256');
assert(sha256Hex('') === refSha256(Buffer.alloc(0)), 'empty input');
assert(sha256Hex('abc') === refSha256(Buffer.from('abc')), '"abc" vector');
assert(sha256Hex('hello world') === refSha256(Buffer.from('hello world')), 'hello world');

{
  // chunked updates must equal one-shot (covers block-boundary edge cases)
  for (const size of [1, 55, 56, 63, 64, 65, 127, 128, 129, 1000, 1 << 20]) {
    const data = randomBytes(size);
    const h = new Sha256();
    let offset = 0;
    while (offset < data.length) {
      const take = Math.min(7 + (offset % 13), data.length - offset); // odd chunk sizes
      h.update(data.subarray(offset, offset + take));
      offset += take;
    }
    if (h.digestHex() !== refSha256(data)) {
      assert(false, `chunked hash size=${size}`);
    }
  }
  assert(true, 'chunked updates match node crypto for 11 sizes');
}

{
  // digest() must not destroy the instance state
  const h = new Sha256();
  h.update('part1-');
  const mid = h.digestHex();
  h.update('part2');
  assert(h.digestHex() === refSha256(Buffer.from('part1-part2')), 'digest is non-destructive');
  assert(mid === refSha256(Buffer.from('part1-')), 'mid digest correct');
}

// ---- diffEntries -----------------------------------------------------
console.log('diffEntries');
const file = (path, hash, size = 10) => ({ path, kind: 'file', size, mtime: 1, hash, chunks: [] });
const dir = (path) => ({ path, kind: 'dir', size: 0, mtime: 0, hash: '', chunks: [] });

{
  const oldE = [file('a.txt', 'h1'), file('b.txt', 'h2'), file('c.txt', 'h3'), dir('d')];
  const newE = [file('a.txt', 'h1'), file('b.txt', 'h2x'), file('e.txt', 'h4'), dir('d')];
  const d = diffEntries(oldE, newE);
  assert(d.added.length === 1 && d.added[0].path === 'e.txt', 'added detected');
  assert(d.removed.length === 1 && d.removed[0].path === 'c.txt', 'removed detected');
  assert(d.modified.length === 1 && d.modified[0].path === 'b.txt', 'modified detected');
  assert(!isManifestEqual(oldE, newE), 'manifests differ');
  assert(isManifestEqual(oldE, [...oldE]), 'identical manifests equal');
  assert(isManifestEqual(oldE, [...oldE].reverse()), 'order-independent equality');
}

// ---- planRollback ----------------------------------------------------
console.log('planRollback');
{
  const manifest = [
    file('keep.txt', 'k1'), file('changed.txt', 'want'), file('restored.txt', 'r1'),
    dir('sub'), file('sub/inner.txt', 'i1'),
  ];
  const current = [
    file('keep.txt', 'k1'),            // unchanged
    file('changed.txt', 'have'),       // differs -> restore
    // restored.txt missing            -> restore
    file('extra.txt', 'x1'),           // not in manifest -> delete
    dir('sub'), file('sub/inner.txt', 'i1'),
    dir('junk'), file('junk/a.txt'),   // extra dir tree -> remove top dir
    dir('junk/deep'),
  ];
  const plan = planRollback(manifest, current);
  const restorePaths = plan.restore.map((e) => e.path).sort();
  assert(JSON.stringify(restorePaths) === JSON.stringify(['changed.txt', 'restored.txt']),
    'restore set correct');
  assert(JSON.stringify(plan.deleteFiles) === JSON.stringify(['extra.txt', 'junk/a.txt']),
    'delete files correct');
  assert(JSON.stringify(plan.removeDirs) === JSON.stringify(['junk']),
    'only top-most extra dir removed');
  assert(plan.createDirs.length === 0, 'no dirs to create');

  const plan2 = planRollback(manifest, current.filter((e) => e.path !== 'sub'));
  assert(plan2.createDirs.includes('sub'), 'missing dir scheduled for creation');
}

// ---- verifyRollback --------------------------------------------------
console.log('verifyRollback');
{
  const manifest = [file('a.txt', 'h1'), dir('d'), file('d/b.txt', 'h2')];
  const good = [file('a.txt', 'h1'), dir('d'), file('d/b.txt', 'h2')];
  assert(verifyRollback(manifest, good).ok, 'exact match verifies ok');
  const bad = [file('a.txt', 'hX'), dir('d'), file('d/b.txt', 'h2')];
  const r1 = verifyRollback(manifest, bad);
  assert(!r1.ok && r1.mismatches.includes('a.txt'), 'hash mismatch detected');
  const r2 = verifyRollback(manifest, [file('a.txt', 'h1'), dir('d')]);
  assert(!r2.ok && r2.missing.includes('d/b.txt'), 'missing file detected');
  const r3 = verifyRollback(manifest, [...good, file('extra.txt', 'e')]);
  assert(!r3.ok && r3.extras.includes('extra.txt'), 'extra file detected');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
