import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync,
  lstatSync, utimesSync, renameSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPackageInventory, packageFiles } from '../plugins/sleight/lib/direct-browser/session-host.mjs';
import { acceptedInstalledPackage } from '../plugins/sleight/lib/direct-browser/installed-config.mjs';
import { buildReceipt } from '../plugins/sleight/lib/direct-browser/turbo-setup.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

function fixture(t) {
  const root = trackTemp(mkdtempSync(join(realpathSync(tmpdir()), 'sleight-package-cache-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const content = { 'host.mjs': 'export const value = 1;', 'native/peer-host.c': 'peer',
    'native/consent-host.swift': 'consent', 'playwright-files.json': '{}',
    'skills/rules.md': 'trusted text', 'characters/preview.webp': 'inert preview' };
  for (const [path, bytes] of Object.entries(content)) {
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes);
  }
  const receipt = { accepted: true, protocol: 1, node: process.version, helperMode: 'source',
    files: packageFiles(root).map(path => { const bytes = readFileSync(join(root, path));
      return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }) };
  return { root, receipt, content, inventory: createPackageInventory({ root, receipt }) };
}
function countReads(t) {
  const original = fs.readFileSync; let reads = 0;
  t.mock.method(fs, 'readFileSync', (...args) => { reads++; return original(...args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return () => reads;
}
test('non-macOS checks reject same-size tampering even when filesystem timestamps collide', t => {
  const f = fixture(t), file = join(f.root, 'host.mjs'), before = lstatSync(file, { bigint: true });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  // Model the unchanged timestamp tuple observed for immediate writes on Linux.
  // Reads and writes still use the real file.
  const originalLstat = fs.lstatSync, originalFstat = fs.fstatSync;
  const coarse = stat => {
    if (stat.dev === before.dev && stat.ino === before.ino) {
      stat.mtimeNs = before.mtimeNs; stat.ctimeNs = before.ctimeNs;
    }
    return stat;
  };
  t.mock.method(fs, 'lstatSync', (...args) => coarse(originalLstat(...args)));
  t.mock.method(fs, 'fstatSync', (...args) => coarse(originalFstat(...args)));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(f.inventory.current(), true);
  writeFileSync(file, 'x'.repeat(Buffer.byteLength(f.content['host.mjs'])));
  assert.equal(f.inventory.current(), false, 'the receipt hash must win over unchanged stat fields');
  assert.equal(createPackageInventory({ root: f.root, receipt: f.receipt }).current(), false);
});
test('full hashes expire at 1 s despite repeated checks and start before hashing', t => {
  const f = fixture(t), reads = countReads(t);
  let now = 0n;
  t.mock.method(process.hrtime, 'bigint', () => now);
  assert.equal(f.inventory.current(), true);
  const count = f.receipt.files.length;
  for (now = 100_000_000n; now < 1_000_000_000n; now += 100_000_000n) assert.equal(f.inventory.current(), true);
  assert.equal(reads(), count * (process.platform === 'darwin' ? 1 : 10), 'only macOS reuses metadata before expiry');
  assert.equal(f.inventory.current(), true);
  assert.equal(reads(), count * (process.platform === 'darwin' ? 2 : 11), 'exactly 1 s forces a full hash');
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (...args) => { now += 200_000_000n; return original(...args); });
  syncBuiltinESMExports();
  now = 2_000_000_000n;
  assert.equal(f.inventory.current(), true);
  const before = reads();
  assert.equal(f.inventory.current(), true);
  assert.equal(reads(), before + count, 'a hash taking over 1 s cannot seed a fresh reuse window');
});
test('unchanged macOS checks reuse bytes; other platforms and metadata changes rehash every file', t => {
  const f = fixture(t), reads = countReads(t), count = f.receipt.files.length;
  assert.equal(f.inventory.current(), true); assert.equal(reads(), count);
  for (let i = 0; i < 5; i++) assert.equal(f.inventory.current(), true);
  assert.equal(reads(), count * (process.platform === 'darwin' ? 1 : 6));
  chmodSync(join(f.root, 'host.mjs'), 0o600);
  assert.equal(f.inventory.current(), true); assert.equal(reads(), count * (process.platform === 'darwin' ? 2 : 7));
  assert.equal(f.inventory.current(), true); assert.equal(reads(), count * (process.platform === 'darwin' ? 2 : 8));
});
for (const path of ['host.mjs', 'skills/rules.md', 'characters/preview.webp'])
  test(`same-size tampering with restored mtime is detected: ${path}`, t => {
    const f = fixture(t), file = join(f.root, path), before = lstatSync(file);
    assert.equal(f.inventory.current(), true);
    writeFileSync(file, 'x'.repeat(Buffer.byteLength(f.content[path])));
    utimesSync(file, before.atime, before.mtime);
    assert.equal(lstatSync(file).size, before.size);
    assert.equal(f.inventory.current(), false);
    assert.equal(f.inventory.current(), false, 'a failed check cannot reuse the earlier snapshot');
    writeFileSync(file, f.content[path]); assert.equal(f.inventory.current(), true);
  });
for (const change of ['replacement', 'symlink', 'directory-symlink', 'writable-file', 'writable-directory', 'added', 'removed', 'root-replacement'])
  test(`a cached package rejects ${change}`, t => {
    const f = fixture(t), file = join(f.root, 'host.mjs');
    assert.equal(f.inventory.current(), true);
    if (change === 'replacement') { writeFileSync(file + '.new', 'export const value = 2;'); renameSync(file + '.new', file); }
    if (change === 'symlink') { rmSync(file); symlinkSync(join(f.root, 'skills/rules.md'), file); }
    if (change === 'directory-symlink') { renameSync(join(f.root, 'native'), join(f.root, 'old-native')); symlinkSync('old-native', join(f.root, 'native')); }
    if (change === 'writable-file') chmodSync(file, 0o666);
    if (change === 'writable-directory') chmodSync(join(f.root, 'native'), 0o777);
    if (change === 'added') writeFileSync(join(f.root, 'injected.mjs'), 'injected');
    if (change === 'removed') rmSync(file);
    if (change === 'root-replacement') {
      renameSync(f.root, f.root + '.old'); mkdirSync(f.root);
      t.after(() => rmSync(f.root + '.old', { recursive: true, force: true }));
      for (const [path, bytes] of Object.entries(f.content)) {
        mkdirSync(dirname(join(f.root, path)), { recursive: true }); writeFileSync(join(f.root, path), bytes);
      }
    }
    assert.equal(f.inventory.current(), false);
  });
test('an identical atomic replacement invalidates the cache and rehashes the whole package', t => {
  const f = fixture(t), reads = countReads(t), file = join(f.root, 'host.mjs');
  assert.equal(f.inventory.current(), true);
  writeFileSync(file + '.new', f.content['host.mjs']); renameSync(file + '.new', file);
  assert.equal(f.inventory.current(), true); assert.equal(reads(), f.receipt.files.length * 2);
});
test('a mutation during hashing cannot seed a successful cache snapshot', t => {
  const f = fixture(t), original = fs.readFileSync; let reads = 0;
  t.mock.method(fs, 'readFileSync', (...args) => {
    const bytes = original(...args);
    if (++reads === f.receipt.files.length) writeFileSync(join(f.root, f.receipt.files[0].path), 'changed after its hash');
    return bytes;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal(f.inventory.current(), false);
  assert.equal(f.inventory.current(), false);
});
test('cache state belongs to one receipt and inventory, never another acceptance', t => {
  const f = fixture(t); assert.equal(f.inventory.current(), true);
  const receipt = structuredClone(f.receipt); receipt.files[0].sha256 = '0'.repeat(64);
  assert.equal(createPackageInventory({ root: f.root, receipt }).current(), false);
});
test('nanosecond-only identity changes invalidate a cache even within one millisecond', t => {
  const f = fixture(t), reads = countReads(t);
  assert.equal(f.inventory.current(), true);
  const originalLstat = fs.lstatSync, originalFstat = fs.fstatSync;
  const shift = stat => { if (stat.isFile()) {
    const old = stat.ctimeMs; stat.ctimeNs += 1n; assert.equal(stat.ctimeMs, old);
  } return stat; };
  t.mock.method(fs, 'lstatSync', (...args) => shift(originalLstat(...args)));
  t.mock.method(fs, 'fstatSync', (...args) => shift(originalFstat(...args)));
  syncBuiltinESMExports();
  assert.equal(f.inventory.current(), true); assert.equal(reads(), f.receipt.files.length * 2);
});
test('installed acceptance keeps entry hashes and only macOS reuses an unchanged package', t => {
  const pluginRoot = fileURLToPath(new URL('../plugins/sleight', import.meta.url)), config = buildReceipt({ pluginRoot });
  const reads = countReads(t), accepted = acceptedInstalledPackage(config, { pluginRoot });
  assert.equal(reads(), config.receipt.files.length + 3);
  assert.equal(accepted.current(), true); assert.equal(reads(), config.receipt.files.length * (process.platform === 'darwin' ? 1 : 2) + 6);
});
test('a failed metadata check invalidates the previous successful snapshot', t => {
  const f = fixture(t), reads = countReads(t), original = fs.lstatSync; let fail = true;
  assert.equal(f.inventory.current(), true);
  t.mock.method(fs, 'lstatSync', (...args) => {
    if (fail) { fail = false; throw Error('fixture read failure'); }
    return original(...args);
  });
  syncBuiltinESMExports();
  assert.equal(f.inventory.current(), false);
  assert.equal(f.inventory.current(), true); assert.equal(reads(), f.receipt.files.length * 2);
});
