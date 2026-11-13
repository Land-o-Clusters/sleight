import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, lstatSync, chmodSync, symlinkSync, existsSync, utimesSync,
  cpSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { macCommandSkip } from './requirements.mjs';
import * as host from '../plugins/sleight/lib/direct-browser/host.mjs';
import { pruneHelperCache } from '../plugins/sleight/lib/direct-browser/host-cache.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const native = process.platform === 'darwin';
const skip = !native && 'Darwin first-use native helpers unavailable';
function fixture(t, options = {}) {
  const root = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-turbo-build-')))));
  const sourceRoot = join(root, 'sources'), cacheRoot = join(root, 'cache');
  mkdirSync(sourceRoot, { mode: 0o700 });
  const names = ['peer-host.c', 'consent-host.swift'];
  for (const name of names) writeFileSync(join(sourceRoot, name), 'original ' + name, { mode: 0o600 });
  const inventory = { accepted: true, protocol: 1, helperMode: 'source', node: process.version,
    files: names.map(name => ({ path: 'native/' + name, sha256: hash(readFileSync(join(sourceRoot, name))) })) };
  let builds = 0;
  async function compile({ source, binary, moduleCache, bank, name }) {
    builds++;
    assert.equal(lstatSync(bank).mode & 0o777, 0o700);
    assert.ok(moduleCache.startsWith(bank + '/'));
    writeFileSync(binary, 'built ' + name + ': ' + readFileSync(source), { mode: 0o700 });
  }
  return { root, sourceRoot, cacheRoot, inventory, names, builds: () => builds,
    options: { inventory, sourceRoot, cacheRoot, compile, scheduleUpgrade: () => {}, ...options } };
}
test('first use builds privately, records exact hashes and reuses verified binaries', { skip }, async t => {
  const f = fixture(t);
  assert.equal(typeof host.prepareNativeHelpers, 'function', 'first-use compiler is missing');
  const first = await host.prepareNativeHelpers(f.options);
  assert.equal(first.status, 'ready'); assert.equal(f.builds(), 2);
  const record = JSON.parse(readFileSync(first.record, 'utf8'));
  for (const name of f.names) assert.equal(record.sources[name], hash(readFileSync(join(f.sourceRoot, name))));
  for (const name of ['peer-host', 'consent-host']) {
    assert.equal(record.binaries[name], hash(readFileSync(join(first.directory, name))));
    assert.equal(lstatSync(join(first.directory, name)).mode & 0o777, 0o700);
  }
  assert.equal(lstatSync(f.cacheRoot).mode & 0o777, 0o700);
  assert.equal(lstatSync(first.directory).mode & 0o777, 0o700);
  assert.equal(lstatSync(first.record).mode & 0o777, 0o600);
  assert.equal(existsSync(join(first.directory, 'module-cache')), false, 'SDK modules are build inputs, not runtime files');
  const second = await host.prepareNativeHelpers(f.options);
  assert.equal(second.status, 'ready'); assert.equal(second.directory, first.directory); assert.equal(f.builds(), 2);
  assert.equal(typeof host.createNativeProcessProvider(second.receipt), 'function');
});
test('a verified cache hit refreshes last use for other sessions', { skip }, async t => {
  const f = fixture(t), first = await host.prepareNativeHelpers(f.options);
  const old = new Date(Date.now() - 25 * 3600000);
  utimesSync(first.directory, old, old);
  const started = Date.now();
  const next = await host.prepareNativeHelpers(f.options);
  assert.equal(next.status, 'ready'); assert.equal(f.builds(), 2);
  assert.ok(lstatSync(next.directory).mtimeMs >= started, 'cache hits record use even when no helper runs');
});
for (const [operation, code] of [['openSync', 'EROFS'], ['futimesSync', 'EIO'], ['futimesSync', 'HOST_CACHE_UNSAFE']])
  test(`cache marker ${operation} ${code} preserves the verified bank without compiling`, { skip }, async t => {
    const f = fixture(t), first = await host.prepareNativeHelpers(f.options);
    const paths = [first.directory, first.record, ...['peer-host', 'consent-host'].map(name => join(first.directory, name))];
    const before = paths.map(path => ({ ino: lstatSync(path).ino, mtime: lstatSync(path).mtimeMs,
      bytes: path === first.directory ? readdirSync(path) : readFileSync(path) }));
    const original = fs[operation]; let attempts = 0;
    t.mock.method(fs, operation, (...args) => {
      if (operation === 'futimesSync' || args[0] === first.directory) {
        attempts++; throw Object.assign(Error(code), { code });
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const next = await host.prepareNativeHelpers(f.options);
    assert.equal(next.status, 'ready'); assert.equal(next.directory, first.directory);
    assert.equal(f.builds(), 2); assert.equal(attempts, 1);
    assert.equal(typeof host.createNativeProcessProvider(next.receipt), 'function');
    assert.deepEqual(paths.map(path => ({ ino: lstatSync(path).ino, mtime: lstatSync(path).mtimeMs,
      bytes: path === first.directory ? readdirSync(path) : readFileSync(path) })), before);
  });
for (const fails of [false, true]) test(`long-session marker refresh is deferred and hourly, failure=${fails}`, { skip }, async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t), first = await host.prepareNativeHelpers(f.options), initial = now;
  const touch = fs.futimesSync; let attempts = 0;
  t.mock.method(fs, 'futimesSync', (...args) => {
    attempts++;
    if (fails) throw Object.assign(Error('fixture touch denied'), { code: 'EROFS' });
    return touch(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const use = () => host.createNativeProcessProvider(first.receipt);
  use(); now = initial + 3600000 - 1; use();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 0);
  for (let hour = 1; hour <= 25; hour++) {
    now = initial + hour * 3600000;
    use(); use(); use();
    assert.equal(attempts, hour - 1, 'launch validation returns before the marker write');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts, hour);
    if (!fails) assert.ok(Math.abs(lstatSync(first.directory).mtimeMs - now) < 1);
    now += 3600000 - 1; use();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(attempts, hour, 'failed writes are throttled too');
  }
  assert.equal(f.builds(), 2);
  writeFileSync(join(first.directory, 'peer-host'), 'tampered');
  now += 3600000;
  assert.throws(use, /HOST_PACKAGE_MISMATCH/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 25, 'failed validation cannot refresh last use');
});
test('unsafe directory validation still refuses before any marker write', { skip }, async t => {
  const f = fixture(t), first = await host.prepareNativeHelpers(f.options);
  chmodSync(first.directory, 0o755);
  let attempts = 0;
  t.mock.method(fs, 'futimesSync', () => { attempts++; }); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const next = await host.prepareNativeHelpers(f.options);
  assert.equal(next.status, 'unavailable'); assert.equal(next.code, 'HOST_CACHE_UNSAFE');
  assert.throws(() => host.createNativeProcessProvider(first.receipt), /HOST_PACKAGE_MISMATCH/);
  assert.equal(attempts, 0); assert.equal(lstatSync(first.directory).mode & 0o777, 0o755);
});
test('a cache hit returns while background module-cache removal is pending', { skip }, async t => {
  const f = fixture(t), first = await host.prepareNativeHelpers(f.options);
  const modules = join(first.directory, 'module-cache'); mkdirSync(modules);
  const remove = fsPromises.rm;
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; });
  const removing = new Promise(resolve => { entered = resolve; });
  t.mock.method(fsPromises, 'rm', async (path, options) => {
    if (path === modules) { entered(); await pending; }
    return remove(path, options);
  });
  syncBuiltinESMExports();
  t.after(() => { release(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  const ready = host.prepareNativeHelpers(f.options);
  const result = await Promise.race([ready, new Promise(resolve => setTimeout(() => resolve('blocked'), 1000))]);
  release(); await ready;
  assert.notEqual(result, 'blocked', 'module-cache removal must not delay a verified cache hit');
  assert.equal(result.status, 'ready');
  await removing;
});
for (const what of ['binary', 'record', 'source']) test('tampered ' + what + ' is refused before launch and rebuilt from accepted source', { skip }, async t => {
  const f = fixture(t), first = await host.prepareNativeHelpers(f.options);
  if (what === 'binary') writeFileSync(join(first.directory, 'peer-host'), 'replaced');
  else if (what === 'record') writeFileSync(first.record, '{}');
  else {
    writeFileSync(join(f.sourceRoot, 'peer-host.c'), 'updated source');
    f.inventory.files[0].sha256 = hash('updated source');
  }
  assert.throws(() => host.createNativeProcessProvider(first.receipt), /HOST_PACKAGE_MISMATCH/);
  const next = await host.prepareNativeHelpers(f.options);
  assert.equal(next.status, 'ready'); assert.equal(f.builds(), 4);
  assert.equal(typeof host.createNativeProcessProvider(next.receipt), 'function');
});
test('unaccepted source edits and forged local receipts never start a helper', { skip }, async t => {
  const f = fixture(t), first = await host.prepareNativeHelpers(f.options);
  assert.throws(() => host.createNativeProcessProvider({ ...first.receipt }), /DISTRIBUTION_ACCEPTANCE_REQUIRED/);
  writeFileSync(join(f.sourceRoot, 'peer-host.c'), 'unaccepted replacement');
  const result = await host.prepareNativeHelpers(f.options);
  assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'HOST_SOURCE_MISMATCH');
  assert.equal(f.builds(), 2);
});
for (const kind of ['writable', 'symlink']) test(kind + ' cache root refuses without changing it', { skip }, async t => {
  const f = fixture(t);
  if (kind === 'writable') mkdirSync(f.cacheRoot, { mode: 0o755 });
  else symlinkSync(f.sourceRoot, f.cacheRoot);
  const result = await host.prepareNativeHelpers(f.options);
  assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'HOST_CACHE_UNSAFE');
  assert.equal(f.builds(), 0);
  assert.equal(kind === 'symlink' ? lstatSync(f.cacheRoot).isSymbolicLink() : lstatSync(f.cacheRoot).mode & 0o777, kind === 'symlink' ? true : 0o755);
});
for (const code of ['ENOENT', 'BUILD_FAILED']) test('compiler ' + code + ' returns typed unavailable and no local receipt', { skip }, async t => {
  const f = fixture(t, { async compile() { throw Object.assign(Error('private compiler details'), { code }); } });
  const result = await host.prepareNativeHelpers(f.options);
  assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'NATIVE_HELPERS_UNAVAILABLE');
  assert.equal(result.fallback, 'engine'); assert.match(result.message, /command-line tools/i);
  assert.doesNotMatch(JSON.stringify(result), /private compiler details/); assert.equal(result.receipt, undefined);
  assert.equal(existsSync(join(f.cacheRoot, 'build.lock')), false);
});
test('linked cache ancestor refuses before creating anything through the link', { skip }, async t => {
  const f = fixture(t), linked = join(f.root, 'linked'); symlinkSync(f.sourceRoot, linked);
  const result = await host.prepareNativeHelpers({ ...f.options, cacheRoot: join(linked, 'new-cache') });
  assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'HOST_CACHE_UNSAFE');
  assert.equal(existsSync(join(f.sourceRoot, 'new-cache')), false);
});
test('a compiler failure reports its stage, cache key, source hashes and bounded stderr', { skip }, async t => {
  const events = [];
  const f = fixture(t);
  const result = await host.prepareHandHost({ ...f.options, tools: async () => true, onProgress: event => events.push(event),
    async compile(data) {
      if (data.name === 'peer-host') return f.options.compile(data);
      throw Object.assign(Error('private compiler details'), { code: 1, signal: null,
        stderr: data.source + ':12: error: invalid Swift\n' + 'x'.repeat(10000) });
    } });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.detail.stage, 'compile');
  assert.equal(result.detail.helper, 'consent-host');
  assert.equal(result.detail.compiler, 'swiftc');
  assert.equal(result.detail.exitCode, 1);
  assert.match(result.detail.key, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.detail.sources, Object.fromEntries(f.inventory.files.map(x => [x.path.slice(7), x.sha256])));
  assert.match(result.detail.stderr, /consent-host\.swift:12: error: invalid Swift/);
  assert.ok(result.detail.stderr.length <= 4096);
  assert.doesNotMatch(result.detail.stderr, new RegExp(f.root));
  assert.ok(events.some(e => e.stage === 'compile' && e.helper === 'peer-host'));
  assert.equal(events.at(-1).status, 'unavailable');
  assert.equal(existsSync(join(f.cacheRoot, 'build.lock')), false);
});
test('a compiler abort is identified and releases its bank and lock', { skip }, async t => {
  const controller = new AbortController(), f = fixture(t);
  controller.abort();
  const result = await host.prepareNativeHelpers({ ...f.options, signal: controller.signal });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.detail.errorCode, 'ABORT_ERR');
  assert.equal(f.builds(), 0);
  assert.equal(existsSync(join(f.cacheRoot, 'build.lock')), false);
});
test('an aborted compiler keeps its bank and lock until the child closes', { skip }, async t => {
  const f = fixture(t), controller = new AbortController(), original = childProcess.spawn;
  let child, source, started;
  const compilerStarted = new Promise(resolve => { started = resolve; });
  t.after(() => { childProcess.spawn = original; syncBuiltinESMExports(); });
  childProcess.spawn = (_command, args, options) => {
    assert.equal(options.detached, true);
    source = args[args.indexOf('-o') - 2];
    child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    started();
    return child;
  };
  syncBuiltinESMExports();
  const building = host.prepareNativeHelpers({ ...f.options, compile: undefined, signal: controller.signal });
  await compilerStarted;
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  const lock = join(f.cacheRoot, 'build.lock');
  assert.equal(existsSync(lock), true, 'the compiler still owns its lock');
  assert.equal(existsSync(source), true, 'the compiler still owns its source bank');
  child.emit('close', null, 'SIGKILL');
  const result = await building;
  assert.equal(result.detail.errorCode, 'ABORT_ERR');
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(source), false);
});
test('concurrent first use retains the builders lock and publishes one complete bank', { skip }, async t => {
  const f = fixture(t); let release;
  const wait = new Promise(resolve => release = resolve);
  const building = host.prepareNativeHelpers({ ...f.options, async compile(data) { await wait; await f.options.compile(data); } });
  // Preparation takes the exclusive lock before its first compiler await.
  const other = await host.prepareNativeHelpers(f.options);
  assert.equal(other.status, 'unavailable'); assert.equal(other.code, 'HOST_BUILD_BUSY');
  assert.equal(existsSync(join(f.cacheRoot, 'build.lock')), true);
  release(); assert.equal((await building).status, 'ready'); assert.equal(f.builds(), 2);
});
test('source mutation during compilation never publishes a usable receipt', { skip }, async t => {
  const f = fixture(t), compile = f.options.compile;
  const result = await host.prepareNativeHelpers({ ...f.options, async compile(data) {
    await compile(data); writeFileSync(join(f.sourceRoot, 'peer-host.c'), 'changed during build');
  } });
  assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'HOST_SOURCE_MISMATCH');
  assert.equal(result.receipt, undefined);
});
test('writable cached executable rebuilds and stale launch receipt refuses', { skip }, async t => {
  const f = fixture(t), first = await host.prepareNativeHelpers(f.options);
  chmodSync(join(first.directory, 'peer-host'), 0o777);
  assert.throws(() => host.createNativeProcessProvider(first.receipt), /HOST_PACKAGE_MISMATCH/);
  assert.equal((await host.prepareNativeHelpers(f.options)).status, 'ready'); assert.equal(f.builds(), 4);
});
test('peer provider checks again at invocation instead of trusting its earlier path', { skip }, async t => {
  const f = fixture(t), first = await host.prepareNativeHelpers(f.options);
  const provider = host.createNativeProcessProvider(first.receipt);
  writeFileSync(join(first.directory, 'peer-host'), 'replacement between calls');
  await assert.rejects(provider(1, '/fixture/browser'), /SELECTED_PROCESS_UNPROVED/);
});
test('Darwin first-use compiler builds both real sources without launching consent UI', {
  skip: macCommandSkip('xcrun'),
}, async t => {
  assert.equal(typeof host.prepareNativeHelpers, 'function', 'first-use compiler is missing');
  const root = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-turbo-compile-')))));
  const spawn = childProcess.spawn, cache = join(root, 'modules'); mkdirSync(cache, { mode: 0o700 });
  t.after(() => { childProcess.spawn = spawn; syncBuiltinESMExports(); });
  // Exercise the default compiler and its deadline, but reuse SDK modules in
  // this fixture instead of rebuilding AppKit alongside the other test files.
  childProcess.spawn = (command, args, options) => {
    assert.equal(command, '/usr/bin/xcrun');
    assert.equal(options.detached, true);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.deepEqual(options.env, { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' });
    const index = args.indexOf('-module-cache-path');
    const moduleCache = index < 0 ? args.find(arg => arg.startsWith('-fmodules-cache-path=')).split('=')[1] : args[index + 1];
    assert.ok(moduleCache.startsWith(root + '/cache/'));
    assert.equal(lstatSync(moduleCache).mode & 0o777, 0o700);
    const shared = args.map((arg, i) => i === index + 1 && index >= 0 ? cache
      : arg.startsWith('-fmodules-cache-path=') ? '-fmodules-cache-path=' + cache : arg);
    return spawn(command, shared, options);
  };
  syncBuiltinESMExports();
  const sourceRoot = fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/native/', import.meta.url)).replace(/\/$/, '');
  const inventory = { accepted: true, protocol: 1, helperMode: 'source', node: process.version,
    files: ['peer-host.c', 'consent-host.swift'].map(name => ({ path: 'native/' + name, sha256: hash(readFileSync(join(sourceRoot, name))) })) };
  const result = await host.prepareNativeHelpers({ inventory, sourceRoot, cacheRoot: join(root, 'cache'), scheduleUpgrade: () => {} });
  assert.equal(result.status, 'ready', JSON.stringify(result));
  for (const name of ['peer-host', 'consent-host']) assert.ok(lstatSync(join(result.directory, name)).size > 1000);
  assert.equal(existsSync(join(result.directory, 'module-cache')), false);
  // Remove even this test's compiler cache before starting either published binary.
  await fsPromises.rm(cache, { recursive: true });
  const run = (name, args, input = '') => new Promise((resolve, reject) => {
    const child = childProcess.execFile(join(result.directory, name), args, { timeout: 10000 }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
    child.stdin.end(input);
  });
  const metadata = JSON.parse(await run('peer-host', ['--process-pid', String(process.pid), realpathSync(process.execPath)]));
  assert.equal(metadata.pid, process.pid);
  const dump = JSON.parse(await run('consent-host', ['--ring-plan-dump'], ''));
  assert.equal(dump.effect, 'end');
  const invalid = await new Promise(resolve => {
    const child = childProcess.execFile(join(result.directory, 'consent-host'), ['--ring-plan-dump'], { timeout: 10000 }, error => resolve(error));
    child.stdin.end('{}\n');
  });
  assert.equal(invalid?.code, 65, 'stdin validation remains active without SDK modules');
  assert.equal(typeof host.createNativeProcessProvider(result.receipt), 'function');
  let bytes = 0;
  for (const name of ['peer-host', 'consent-host', 'peer-host.c', 'consent-host.swift', 'build.json', 'owner.json'])
    bytes += lstatSync(join(result.directory, name)).size;
  t.diagnostic(`published entry: ${bytes} bytes, 0 module-cache bytes`);
  // Measure retention with real compiled bytes, with deterministic process data in this temporary root.
  const key = result.directory.split('/').at(-1), currentKeys = new Set([key]), now = Date.now();
  for (let i = 1; i <= 5; i++) {
    const copy = join(root, 'cache', String(i).padStart(64, '0'));
    cpSync(result.directory, copy, { recursive: true });
    utimesSync(copy, new Date(now - 25 * 3600000 - i * 1000), new Date(now - 25 * 3600000 - i * 1000));
  }
  utimesSync(result.directory, new Date(now - 25 * 3600000 - 10000), new Date(now - 25 * 3600000 - 10000));
  await pruneHelperCache({ cacheRoot: join(root, 'cache'), currentKeys, processes: async () => [] });
  assert.equal(readdirSync(join(root, 'cache')).length, 3);
  let retained = 0;
  for (const dir of readdirSync(join(root, 'cache')))
    for (const file of readdirSync(join(root, 'cache', dir))) retained += lstatSync(join(root, 'cache', dir, file)).size;
  assert.equal(retained, bytes * 3);
  t.diagnostic(`retention measured: 6 entries -> 3 entries, ${bytes * 6} -> ${retained} file bytes`);
});

// A build lock names its owner (pid, process start, creation time). A session killed mid-compile leaves its lock behind, and
// the next build reclaims it once the owner is gone, its pid now belongs to a later process, or it is older than two compiles.
const startOf = () => Date.now() - process.uptime() * 1000;
async function deadPid() {
  const child = childProcess.spawn(process.execPath, ['-e', '']);
  await new Promise(resolve => child.on('exit', resolve));
  return child.pid;
}
function plantLock(f, owner, { ageMs = 0 } = {}) {
  const lock = join(f.cacheRoot, 'build.lock');
  mkdirSync(f.cacheRoot, { recursive: true, mode: 0o700 }); chmodSync(f.cacheRoot, 0o700);
  mkdirSync(lock, { mode: 0o700 });
  if (owner) writeFileSync(join(lock, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
  if (ageMs) { const then = new Date(Date.now() - ageMs); utimesSync(lock, then, then); }
  return lock;
}
test('a lock left by a dead owner is reclaimed, and the build goes ahead and releases its own lock', { skip }, async t => {
  const f = fixture(t), lock = plantLock(f, { pid: await deadPid(), started: startOf(), created: Date.now() });
  const result = await host.prepareNativeHelpers(f.options);
  assert.equal(result.status, 'ready', JSON.stringify(result)); assert.equal(f.builds(), 2);
  assert.equal(existsSync(lock), false);
});
test('a live owner\'s lock is respected and left as it is', { skip }, async t => {
  const owner = { pid: process.pid, started: startOf(), created: Date.now() };
  const f = fixture(t), lock = plantLock(f, owner);
  const result = await host.prepareNativeHelpers(f.options);
  assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'HOST_BUILD_BUSY'); assert.equal(f.builds(), 0);
  assert.deepEqual(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')), owner);
});
for (const [name, owner, options] of [
  ['its pid now belongs to a later process', () => ({ pid: process.pid, started: startOf() - 3600000, created: Date.now() })],
  ['it is older than two compiles', () => ({ pid: process.pid, started: startOf(), created: Date.now() - 601000 })],
  ['it has no owner file and is older than two compiles', () => undefined, { ageMs: 601000 }],
]) test('a lock is reclaimed when ' + name, { skip }, async t => {
  const f = fixture(t), lock = plantLock(f, owner(), options);
  const result = await host.prepareNativeHelpers(f.options);
  assert.equal(result.status, 'ready', JSON.stringify(result)); assert.equal(existsSync(lock), false);
});
test('a fresh lock without an owner file is still busy (its owner may be writing it)', { skip }, async t => {
  const f = fixture(t); plantLock(f);
  assert.equal((await host.prepareNativeHelpers(f.options)).code, 'HOST_BUILD_BUSY');
});
test('the build writes its own owner record while it holds the lock', { skip }, async t => {
  let seen;
  const f = fixture(t), compile = f.options.compile;
  const result = await host.prepareNativeHelpers({ ...f.options, async compile(data) {
    seen ??= JSON.parse(readFileSync(join(f.cacheRoot, 'build.lock', 'owner.json'), 'utf8'));
    const stageOwner = JSON.parse(readFileSync(join(data.bank, 'owner.json'), 'utf8'));
    assert.equal(stageOwner.pid, process.pid); assert.ok(Math.abs(stageOwner.started - startOf()) < 2000);
    await compile(data);
  } });
  assert.equal(result.status, 'ready');
  assert.equal(seen.pid, process.pid); assert.ok(Math.abs(seen.started - startOf()) < 2000); assert.ok(Math.abs(seen.created - Date.now()) < 60000);
});

test('module-cache cleanup failure never changes a verified successful build to unavailable', { skip }, async t => {
  const f = fixture(t);
  t.mock.method(fsPromises, 'rm', async () => { throw Object.assign(Error('fixture cleanup denied'), { code: 'EACCES' }); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await host.prepareNativeHelpers(f.options);
  assert.equal(result.status, 'ready');
  assert.equal(typeof host.createNativeProcessProvider(result.receipt), 'function');
  assert.ok(existsSync(join(result.directory, 'module-cache')), 'the failure was exercised');
  t.mock.restoreAll(); syncBuiltinESMExports();
  assert.equal((await host.prepareNativeHelpers(f.options)).status, 'ready');
  const deadline = Date.now() + 2000;
  while (existsSync(join(result.directory, 'module-cache')) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(existsSync(join(result.directory, 'module-cache')), false, 'a verified cache hit retries module cleanup');
});


test('GL1A: the distinct driver source uses plain swiftc flags without sealed settings', { skip }, async t => {
  const f = fixture(t), selected = { 'peer-host': 'peer-host.c', 'glide-engine': 'glide-engine.swift' };
  writeFileSync(join(f.sourceRoot, 'glide-engine.swift'), 'driver source', { mode: 0o600 });
  f.inventory.files = Object.values(selected).map(name => ({ path: 'native/' + name, sha256: hash(readFileSync(join(f.sourceRoot, name))) }));
  const calls = [];
  t.mock.method(childProcess, 'spawn', (file, args) => {
    calls.push({ file, args });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    writeFileSync(args[args.indexOf('-o') + 1], 'compiled', { mode: 0o700 });
    setImmediate(() => child.emit('close', 0, null)); return child;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await host.prepareNativeHelpers({ ...f.options, compile: undefined }, selected);
  assert.equal(result.status, 'ready', result.code);
  const swift = calls.find(call => call.args[0] === 'swiftc');
  assert.ok(swift);
  assert.deepEqual(swift.args.slice(0, 2), ['swiftc', '-module-cache-path']);
  assert.equal(swift.args.length, 6);
  assert.doesNotMatch(swift.args.join(' '), /SLEIGHT_.*SETTINGS|settings-consent/);
});
