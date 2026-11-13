import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClipboardSnapshotStore, recoverClipboardSnapshots, sweepClipboardSnapshots } from '../plugins/sleight/lib/clipboard-recovery.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const minute = 60000;
const original = [[{ type: 'public.utf8-plain-text', data: Buffer.from('saved fixture').toString('base64') }]];
const staged = [[{ type: 'public.utf8-plain-text', data: Buffer.from('staged fixture').toString('base64') },
  { type: 'org.nspasteboard.TransientType', data: '' }]];
function fixture(t) {
  const root = trackTemp(fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'sleight-int27h-legacy-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 1800000000000, boot = 'fixture-boot';
  const options = { directory: join(root, 'clipboard'), now: () => now, bootSession: () => boot, excludeFromBackup() {} };
  const store = createClipboardSnapshotStore(options), notices = [];
  const save = () => {
    const token = store.save({ original, staged }), path = join(store.directory, 'runtime-' + token.name);
    fs.renameSync(join(store.directory, token.name), path);
    return path;
  };
  return { root, store, notices, path: save(), save, age: ms => { now += ms; },
    reboot() { boot = 'next-boot'; return createClipboardSnapshotStore(options); } };
}
function sweep(f, store = f.store) {
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
  const saved = names.map(name => childProcess[name]), calls = [];
  names.forEach(name => { childProcess[name] = () => { calls.push(name); throw Error('unexpected pasteboard child'); }; });
  syncBuiltinESMExports();
  try { sweepClipboardSnapshots({ store, notice: (code, path) => f.notices.push({ code, path }) }); }
  finally { names.forEach((name, i) => { childProcess[name] = saved[i]; }); syncBuiltinESMExports(); }
  assert.deepEqual(calls, [], 'legacy cleanup never launches pasteboard IO');
}
test('INT27H expired legacy bytes are zeroed and deleted with no pasteboard IO', t => {
  const f = fixture(t), fd = fs.openSync(f.path, 'r'), size = fs.fstatSync(fd).size;
  f.age(11 * minute);
  try {
    sweep(f);
    assert.equal(fs.existsSync(f.path), false);
    const bytes = Buffer.alloc(size);
    assert.equal(fs.readSync(fd, bytes, 0, size, 0), size);
    assert.ok(bytes.every(byte => byte === 0));
  } finally { fs.closeSync(fd); }
});
test('INT27H an older legacy record from another boot is deleted', t => {
  const f = fixture(t); f.age(11 * minute); sweep(f, f.reboot());
  assert.equal(fs.existsSync(f.path), false);
});
for (const minutes of [0, 9, 10]) test(`INT27H fresh legacy record at ${minutes} minutes stays byte-for-byte`, t => {
  const f = fixture(t), bytes = fs.readFileSync(f.path); f.age(minutes * minute); sweep(f);
  assert.deepEqual(fs.readFileSync(f.path), bytes);
  assert.deepEqual(f.notices, []);
});
test('INT27H legacy-only inventory reaches the sweep while restoration still sees no records', async t => {
  const f = fixture(t), calls = [];
  assert.equal(f.store.hasSnapshots(), false);
  assert.deepEqual(f.store.list(), []);
  const io = Object.assign(async request => { calls.push(request); throw Error('legacy restoration attempted'); }, { snapshotStore: f.store });
  await recoverClipboardSnapshots(io);
  assert.deepEqual(calls, []);
  f.age(11 * minute); sweep(f);
  assert.equal(fs.existsSync(f.path), false);
});
test('INT27H legacy symlink is skipped and its target is unchanged', t => {
  const f = fixture(t), target = join(f.root, 'target.bin'), bytes = fs.readFileSync(f.path);
  fs.renameSync(f.path, target); fs.symlinkSync(target, f.path); f.age(11 * minute); sweep(f);
  assert.equal(fs.lstatSync(f.path).isSymbolicLink(), true);
  assert.deepEqual(fs.readFileSync(target), bytes);
  assert.ok(f.notices.some(n => n.code === 'CLIPBOARD_SNAPSHOT_SKIPPED_UNSAFE'));
});
test('INT27H wrong-owner legacy metadata is skipped without changing bytes', t => {
  const f = fixture(t), bytes = fs.readFileSync(f.path), originalStat = fs.fstatSync;
  f.age(11 * minute);
  fs.fstatSync = (...args) => {
    const value = originalStat(...args);
    return Object.assign(Object.create(Object.getPrototypeOf(value)), value, { uid: value.uid + 1 });
  };
  syncBuiltinESMExports();
  try { sweep(f); }
  finally { fs.fstatSync = originalStat; syncBuiltinESMExports(); }
  assert.deepEqual(fs.readFileSync(f.path), bytes);
  assert.ok(f.notices.some(n => n.code === 'CLIPBOARD_SNAPSHOT_SKIPPED_UNSAFE'));
});
for (const unsafe of ['mode', 'hardlink']) test('INT27H legacy ' + unsafe + ' is skipped', t => {
  const f = fixture(t), bytes = fs.readFileSync(f.path);
  if (unsafe === 'mode') fs.chmodSync(f.path, 0o644);
  else fs.linkSync(f.path, join(f.root, 'other-link'));
  f.age(11 * minute); sweep(f);
  assert.deepEqual(fs.readFileSync(f.path), bytes);
  assert.ok(f.notices.some(n => n.code === 'CLIPBOARD_SNAPSHOT_SKIPPED_UNSAFE'));
});
test('INT27H deleting two legacy records prints one notice and keeps a fresh third record', t => {
  const f = fixture(t), second = f.save(); f.age(11 * minute); const fresh = f.save();
  sweep(f);
  assert.equal(fs.existsSync(f.path), false); assert.equal(fs.existsSync(second), false); assert.equal(fs.existsSync(fresh), true);
  assert.deepEqual(f.notices, [{ code: 'CLIPBOARD_LEGACY_SNAPSHOTS_DISCARDED', path: f.store.directory }]);
  sweep(f);
  assert.equal(f.notices.length, 1, 'a later sweep with no deletions prints no extra notice');
});
