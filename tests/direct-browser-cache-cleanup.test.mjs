import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, existsSync, symlinkSync, utimesSync, readdirSync,
  lstatSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cache from '../plugins/sleight/lib/direct-browser/host-cache.mjs';

const hour = 3600000, now = Date.now(), key = n => n.toString(16).padStart(64, '0');
function fixture(t, folder = 'cache') {
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-cache-cleanup-'))));
  t.after(() => removeTemp(root));
  mkdirSync(join(root, folder), { mode: 0o700 });
  const cacheRoot = realpathSync(join(root, folder));
  const entry = (name, age = 0, owner) => {
    const path = join(cacheRoot, name); mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, 'consent-host'), Buffer.alloc(1000), { mode: 0o700 });
    if (owner) writeFileSync(join(path, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
    utimesSync(path, new Date(now - age), new Date(now - age)); return path;
  };
  const clean = (options = {}) => cache.pruneHelperCache({ cacheRoot, currentKeys: new Set(),
    processes: async () => [], now: () => now, ...options });
  return { root, cacheRoot, entry, clean };
}
test('stale staging is removed; fresh, live-owned and uncertain staging is kept', async t => {
  const f = fixture(t);
  f.entry('build-stale1', hour + 1);
  f.entry('build-fresh1', hour - 1);
  f.entry('build-live01', hour * 2, { pid: 42 });
  f.entry('build-dead01', hour * 2, { pid: 43 });
  f.entry('build-bad001', hour * 2); writeFileSync(join(f.cacheRoot, 'build-bad001/owner.json'), 'invalid');
  await f.clean({ processes: async () => [{ pid: 42, path: '/fixture/node' }] });
  assert.deepEqual(readdirSync(f.cacheRoot).sort(), ['build-bad001', 'build-fresh1', 'build-live01']);
});
test('an active legacy build lock or compiler protects staging without a live owner', async t => {
  const f = fixture(t); f.entry('build-stale1', hour * 2);
  mkdirSync(join(f.cacheRoot, 'build.lock'), { mode: 0o700 });
  await f.clean(); assert.ok(existsSync(join(f.cacheRoot, 'build-stale1')));
  rmSync(join(f.cacheRoot, 'build.lock'), { recursive: true });
  await f.clean({ processes: async () => [{ pid: 42, path: '/Xcode/usr/bin/swift-frontend' }] });
  assert.ok(existsSync(join(f.cacheRoot, 'build-stale1')));
});
test('symlinks in the root and inside removed entries never lead cleanup outside the root', async t => {
  const f = fixture(t), outside = join(f.root, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'keep'), 'keep');
  symlinkSync(outside, join(f.cacheRoot, key(1)));
  symlinkSync(outside, join(f.cacheRoot, 'build-linked'));
  const stale = f.entry('build-stale1', hour * 2); symlinkSync(outside, join(stale, 'module-cache'));
  utimesSync(stale, new Date(now - hour * 2), new Date(now - hour * 2));
  await f.clean();
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'keep');
  assert.ok(lstatSync(join(f.cacheRoot, key(1))).isSymbolicLink());
  assert.ok(lstatSync(join(f.cacheRoot, 'build-linked')).isSymbolicLink());
  assert.equal(existsSync(stale), false);
});
test('published pruning keeps the current hash, two most recently used and a running binary', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 6; i++) f.entry(key(i), 25 * hour + i * 1000);
  await f.clean({ currentKeys: new Set([key(5)]), processes: async () => [{ pid: 42, path: join(f.cacheRoot, key(6), 'consent-host') }] });
  assert.deepEqual(readdirSync(f.cacheRoot).sort(), [1, 2, 5, 6].map(key));
  t.diagnostic('retained 4 entries, 4000 fixture binary bytes (current + newest 2 + running)');
});
test('another session hash used one hour ago survives while one unused for 25 hours is pruned', async t => {
  const f = fixture(t);
  f.entry(key(1), 1000); f.entry(key(2), 2000);
  f.entry(key(3), hour); f.entry(key(4), 25 * hour); f.entry(key(5), 26 * hour);
  await f.clean();
  assert.deepEqual(readdirSync(f.cacheRoot).sort(), [1, 2, 3].map(key));
});
for (const form of ['NFC', 'NFD']) test('running executable paths compare in NFC: ' + form, async t => {
  const f = fixture(t, 'caf\u00e9');
  for (let i = 1; i <= 4; i++) f.entry(key(i), 25 * hour + i * 1000);
  await f.clean({ processes: async () => [{ pid: 42, path: join(f.cacheRoot, key(4), 'consent-host').normalize(form) }] });
  assert.deepEqual(readdirSync(f.cacheRoot).sort(), [1, 2, 4].map(key));
});
for (const processes of [async () => { throw Error('process inventory unavailable'); }, async () => [{ pid: 42, path: 'unknown' }]])
  test('uncertain process inventory preserves all entries', async t => {
    const f = fixture(t); for (let i = 1; i <= 4; i++) f.entry(key(i), 25 * hour + i * 1000);
    f.entry('build-stale1', hour * 2);
    await f.clean({ processes }); assert.equal(readdirSync(f.cacheRoot).length, 5);
  });
test('a linked cache root is refused without touching its target', async t => {
  const f = fixture(t); f.entry('build-stale1', hour * 2);
  const link = join(f.root, 'link'); symlinkSync(f.cacheRoot, link);
  await f.clean({ cacheRoot: link }); assert.ok(existsSync(join(f.cacheRoot, 'build-stale1')));
});
test('cleanup failure is contained', async t => {
  const f = fixture(t);
  await assert.doesNotReject(f.clean({ cacheRoot: join(f.root, 'missing') }));
});
test('cleanup is scheduled once, returns before inventory, and keeps hashes requested after scheduling', async t => {
  const f = fixture(t); for (let i = 1; i <= 5; i++) f.entry(key(i), 25 * hour + i * 1000);
  const isolated = await import('../plugins/sleight/lib/direct-browser/host-cache.mjs?cleanup-scheduler-test');
  let calls = 0, finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const processes = async () => { calls++; await pending; return []; };
  assert.equal(isolated.scheduleHelperCacheCleanup({ cacheRoot: f.cacheRoot, key: key(4), processes }), undefined);
  assert.equal(calls, 0, 'scheduling does not synchronously scan');
  isolated.scheduleHelperCacheCleanup({ cacheRoot: f.cacheRoot, key: key(5), processes: () => assert.fail('second cleanup') });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 1, 'the background scan is pending while callers have returned');
  finish();
  const deadline = Date.now() + 2000;
  while (existsSync(join(f.cacheRoot, key(3))) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(readdirSync(f.cacheRoot).sort(), [1, 2, 4, 5].map(key));
});
