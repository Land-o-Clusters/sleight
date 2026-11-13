// Reviewer's adversarial cases, restricted to owned temporary package fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, lstatSync, utimesSync,
  renameSync, linkSync, copyFileSync, constants } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createPackageInventory, packageFiles } from '../plugins/sleight/lib/direct-browser/session-host.mjs';
function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'pv1-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const content = { 'host.mjs': 'export const value = 1;', 'native/peer-host.c': 'peer', 'native/consent-host.swift': 'consent',
    'playwright-files.json': '{}', 'lib/act.mjs': 'export const act = 1;', 'characters/a.webp': 'art-a' };
  for (const [path, bytes] of Object.entries(content)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes); }
  const receipt = { accepted: true, protocol: 1, node: process.version, helperMode: 'source',
    files: packageFiles(root).map(path => { const bytes = readFileSync(join(root, path));
      return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }) };
  return { root, receipt, content, inventory: createPackageInventory({ root, receipt }) };
}
const flip = (file, orig) => writeFileSync(file, 'x'.repeat(Buffer.byteLength(orig)));

// 1. Shared-mapping write: bytes change, no stat field changes while the mapping lives.
test('a write through a live MAP_SHARED mapping is detected at the first check after the 1 s TTL',
  { skip: !existsSync('/usr/bin/python3') && 'needs /usr/bin/python3' }, async t => {
  const f = fixture(t), file = join(f.root, 'lib/act.mjs');
  assert.equal(f.inventory.current(), true);
  const acceptedAt = performance.now(), before = lstatSync(file, { bigint: true });
  const holder = spawn('/usr/bin/python3', ['-I', '-c', `
import mmap,os,sys,select
fd=os.open(sys.argv[1],os.O_RDWR); m=mmap.mmap(fd,0); m[0:6]=b'EVIL!!'; print('stored',flush=True)
select.select([sys.stdin],[],[],10); m.close(); os.close(fd)
`, file], { stdio: ['pipe', 'pipe', 'inherit'] });
  const closed = new Promise((resolve, reject) => { holder.once('error', reject); holder.once('close', resolve); });
  t.after(async () => { holder.stdin.end(); await closed; });
  await Promise.race([new Promise(r => holder.stdout.once('data', r)), closed.then(() => { throw Error('mapping fixture exited before storing'); })]);
  assert.match(readFileSync(file, 'utf8'), /^EVIL!!/, 'a plain read sees the mapped bytes');
  const st = lstatSync(file, { bigint: true });
  if (process.platform === 'darwin') for (const key of ['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtimeNs', 'ctimeNs'])
    assert.equal(st[key], before[key], `mapped store leaves ${key} unchanged on APFS`);
  // Exercise repeated fast-path hits: none may slide the full-verification deadline.
  while (performance.now() - acceptedAt < 1000) {
    if (!f.inventory.current()) break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(f.inventory.current(), false, 'verifier accepted a package whose bytes differ from the receipt');
  t.diagnostic(`mapped modification refused ${Math.round(performance.now() - acceptedAt)} ms after acceptance`);
  assert.equal(holder.exitCode, null, 'mapping remains live until after the refusal');
});

// 2. Many back-to-back same-size writes with no utimes: racy-timestamp check.
test('300 immediate same-size rewrites are each detected', t => {
  const f = fixture(t), file = join(f.root, 'lib/act.mjs'), orig = f.content['lib/act.mjs'];
  for (let i = 0; i < 300; i++) {
    assert.equal(f.inventory.current(), true, `restore ${i}`);
    flip(file, orig); assert.equal(f.inventory.current(), false, `flip ${i}`);
    writeFileSync(file, orig);
  }
});
test('write immediately after an accepted check, mtime restored with nanoseconds', t => {
  const f = fixture(t), file = join(f.root, 'lib/act.mjs'), orig = f.content['lib/act.mjs'];
  for (let i = 0; i < 100; i++) {
    assert.equal(f.inventory.current(), true);
    const st = lstatSync(file); flip(file, orig); utimesSync(file, st.atime, st.mtime);
    assert.equal(f.inventory.current(), false, `iteration ${i}`);
    writeFileSync(file, orig);
  }
});

// 3. Metadata operations that do not change bytes still pass, and operations that could hide a change do not.
test('hard link to a package file, write through the other name', t => {
  const f = fixture(t), file = join(f.root, 'lib/act.mjs'), other = f.root + '.link';
  t.after(() => rmSync(other, { force: true }));
  assert.equal(f.inventory.current(), true);
  linkSync(file, other); assert.equal(f.inventory.current(), true, 'bytes unchanged, nlink changed: rehash passes');
  assert.equal(f.inventory.current(), true);
  flip(other, f.content['lib/act.mjs']); assert.equal(f.inventory.current(), false);
});
test('xattr and chmod round trip trigger a rehash only', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t), file = join(f.root, 'host.mjs');
  assert.equal(f.inventory.current(), true);
  execFileSync('/usr/bin/xattr', ['-w', 'com.example.x', '1', file]);
  const a = lstatSync(file, { bigint: true });
  assert.equal(f.inventory.current(), true);
  chmodSync(file, 0o600); chmodSync(file, 0o644);
  assert.equal(f.inventory.current(), true);
  assert.ok(lstatSync(file, { bigint: true }).ctimeNs > a.ctimeNs, 'xattr and chmod advance ctime');
});
test('rename-over with a clone (APFS clonefile) and with a copy', t => {
  const f = fixture(t), file = join(f.root, 'host.mjs');
  assert.equal(f.inventory.current(), true);
  const evil = file + '.evil'; writeFileSync(evil, 'export const value = 9;');
  const before = lstatSync(file, { bigint: true });
  copyFileSync(evil, file + '.c', constants.COPYFILE_FICLONE); renameSync(file + '.c', file);
  assert.notEqual(lstatSync(file, { bigint: true }).ino, before.ino);
  rmSync(evil);
  assert.equal(f.inventory.current(), false);
});
test('swapping two package files by rename is refused', t => {
  const f = fixture(t), a = join(f.root, 'host.mjs'), b = join(f.root, 'lib/act.mjs'), tmp = join(f.root, 'swap.tmp');
  assert.equal(f.inventory.current(), true);
  renameSync(a, tmp); renameSync(b, a); renameSync(tmp, b);
  assert.equal(f.inventory.current(), false);
});
test('a second inventory on a tampered tree does not inherit the first one\'s snapshot', t => {
  const f = fixture(t), file = join(f.root, 'host.mjs');
  assert.equal(f.inventory.current(), true);
  flip(file, f.content['host.mjs']);
  assert.equal(createPackageInventory({ root: f.root, receipt: f.receipt }).current(), false);
  assert.equal(f.inventory.current(), false);
});
test('a changed receipt hash never reuses a snapshot', t => {
  const f = fixture(t); assert.equal(f.inventory.current(), true);
  const receipt = JSON.parse(JSON.stringify(f.receipt)); receipt.files[0].sha256 = '0'.repeat(64);
  assert.equal(createPackageInventory({ root: f.root, receipt }).current(), false);
});
