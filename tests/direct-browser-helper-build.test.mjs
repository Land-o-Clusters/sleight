import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, lstatSync, chmodSync, symlinkSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { macCommandSkip } from './requirements.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import * as host from '../plugins/sleight/lib/direct-browser/host.mjs';

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
    options: { inventory, sourceRoot, cacheRoot, compile, ...options } };
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
  const second = await host.prepareNativeHelpers(f.options);
  assert.equal(second.status, 'ready'); assert.equal(second.directory, first.directory); assert.equal(f.builds(), 2);
  assert.equal(typeof host.createNativeProcessProvider(second.receipt), 'function');
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
  const f = fixture(t), controller = new AbortController(), original = childProcess.execFile;
  let child, stopped, source;
  const abortSeen = new Promise(resolve => { stopped = resolve; });
  t.after(() => { childProcess.execFile = original; syncBuiltinESMExports(); });
  childProcess.execFile = (_command, args, options, callback) => {
    assert.equal(options.killSignal, 'SIGKILL');
    source = args[args.indexOf('-o') - 2];
    child = new EventEmitter();
    options.signal.addEventListener('abort', () => {
      callback(Object.assign(Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' })); stopped();
    });
    return child;
  };
  syncBuiltinESMExports();
  const building = host.prepareNativeHelpers({ ...f.options, compile: undefined, signal: controller.signal });
  controller.abort(); await abortSeen;
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
  const execFile = childProcess.execFile, cache = swiftModuleCache();
  t.after(() => { childProcess.execFile = execFile; syncBuiltinESMExports(); });
  // Exercise the default compiler and its deadline, but reuse SDK modules in
  // this fixture instead of rebuilding AppKit alongside the other test files.
  childProcess.execFile = (command, args, options, callback) => {
    assert.equal(command, '/usr/bin/xcrun');
    assert.equal(options.timeout, 300000);
    assert.deepEqual(options.env, { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' });
    const index = args.indexOf('-module-cache-path');
    const moduleCache = index < 0 ? args.find(arg => arg.startsWith('-fmodules-cache-path=')).split('=')[1] : args[index + 1];
    assert.ok(moduleCache.startsWith(root + '/cache/'));
    assert.equal(lstatSync(moduleCache).mode & 0o777, 0o700);
    const shared = args.map((arg, i) => i === index + 1 && index >= 0 ? cache
      : arg.startsWith('-fmodules-cache-path=') ? '-fmodules-cache-path=' + cache : arg);
    return execFile(command, shared, options, callback);
  };
  syncBuiltinESMExports();
  const sourceRoot = fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/native/', import.meta.url)).replace(/\/$/, '');
  const inventory = { accepted: true, protocol: 1, helperMode: 'source', node: process.version,
    files: ['peer-host.c', 'consent-host.swift'].map(name => ({ path: 'native/' + name, sha256: hash(readFileSync(join(sourceRoot, name))) })) };
  const result = await host.prepareNativeHelpers({ inventory, sourceRoot, cacheRoot: join(root, 'cache') });
  assert.equal(result.status, 'ready', JSON.stringify(result));
  for (const name of ['peer-host', 'consent-host']) assert.ok(lstatSync(join(result.directory, name)).size > 1000);
  assert.equal(typeof host.createNativeProcessProvider(result.receipt), 'function');
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
    seen ??= JSON.parse(readFileSync(join(f.cacheRoot, 'build.lock', 'owner.json'), 'utf8')); await compile(data);
  } });
  assert.equal(result.status, 'ready');
  assert.equal(seen.pid, process.pid); assert.ok(Math.abs(seen.started - startOf()) < 2000); assert.ok(Math.abs(seen.created - Date.now()) < 60000);
});
