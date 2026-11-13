import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { userInfo } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports, registerHooks } from 'node:module';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

const mutations = {
  busy: ['mac-driver/build.mjs', 'waitForBuild: true', 'waitForBuild: false'],
  backoff: ['direct-browser/host.mjs', "if (automatic && stage === 'compile'", "if (false && stage === 'compile'"],
  priority: ['direct-browser/host.mjs', "background ? '20' : '10'", "background ? '20' : '0'"],
  abort: ['direct-browser/host.mjs', 'await delay(250, undefined, { signal });', 'await delay(250);'],
  doctor: ['runtime-doctor.mjs', 'if (failure?.retryAfterMs > 0) {', 'if (false) {'],
  toolchain: ['direct-browser/host-cache.mjs', 'return digest(JSON.stringify({ selected, arch: process.arch, files }));',
    "return 'a'.repeat(64);"],
};
let hook;
if (process.env.GLS1B_MUTANT) {
  const [file, before, after] = mutations[process.env.GLS1B_MUTANT];
  const target = new URL('../plugins/sleight/lib/' + file, import.meta.url).href;
  hook = registerHooks({ load(url, context, next) {
    const loaded = next(url, context);
    if (url !== target) return loaded;
    assert.ok(String(loaded.source).includes(before), 'GLS1B mutation anchor');
    return { ...loaded, source: String(loaded.source).replace(before, after) };
  } });
}
const { prepareNativeHelpers } = await import('../plugins/sleight/lib/direct-browser/host.mjs');
const { prepareMacDriver } = await import('../plugins/sleight/lib/mac-driver/build.mjs');
const { runtimeBuildState, runtimeDoctorSection } = await import('../plugins/sleight/lib/runtime-doctor.mjs');
const { helperToolchainKey } = await import('../plugins/sleight/lib/direct-browser/host-cache.mjs');
hook?.deregister();

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const compilerFailure = () => Object.assign(Error('compiler failed'), { code: 1,
  stderr: 'error: unable to load standard library\n3 | private compiler source\nerror: second private diagnostic' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const skip = process.platform !== 'darwin';
function fixture(t) {
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-gls1b-build-'))));
  const cacheRoot = join(root, 'cache'), sourceRoot = join(root, 'sources');
  mkdirSync(sourceRoot, { mode: 0o700 });
  const selectedSources = { 'peer-host': 'peer-host.c', 'glide-engine': 'glide-engine.swift' };
  const inventory = { accepted: true, protocol: 1, helperMode: 'source', node: process.version,
    files: Object.values(selectedSources).map(name => {
      writeFileSync(join(sourceRoot, name), name, { mode: 0o600 });
      return { path: 'native/' + name, sha256: digest(name) };
    }) };
  return { root, cacheRoot, sourceRoot, selectedSources, inventory };
}
const build = (f, options = {}) => prepareNativeHelpers({ ...f, automatic: true, waitForBuild: true,
  compile: async ({ name, binary }) => writeFileSync(binary, 'fixture ' + name, { mode: 0o700 }), ...options }, f.selectedSources);

test('two Glide starts share the locked build and reuse its verified publication', { skip, timeout: 10000 }, async t => {
  const f = fixture(t), wait = deferred(); let calls = 0;
  const prepare = options => prepareNativeHelpers({ ...options, compile: async ({ name, binary }) => {
    calls++; await wait.promise; writeFileSync(binary, 'fixture ' + name, { mode: 0o700 });
  } }, { 'peer-host': 'peer-host.c', 'glide-engine': 'glide-engine.swift' });
  const options = { cacheRoot: f.cacheRoot, tools: async () => true, prepare, prebuilt: () => undefined };
  const first = prepareMacDriver(options);
  try {
    while (!calls) await delay(1);
    const second = prepareMacDriver(options);
    assert.equal(await Promise.race([second, delay(50, 'waiting')]), 'waiting', 'busy must not become a session failure');
    wait.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 'ready'); assert.equal(b.status, 'ready');
    assert.equal(a.binary, b.binary); assert.equal(calls, 2, 'one peer and one driver compilation');
    assert.equal(existsSync(join(f.cacheRoot, 'build.lock')), false);
  } finally { wait.resolve(); await first; }
});

test('a waiting builder aborts promptly without removing the other builders lock', { skip, timeout: 10000 }, async t => {
  const f = fixture(t), wait = deferred(), owner = new AbortController(); let started = false;
  const first = build(f, { compile: async ({ binary }) => { started = true; await wait.promise; writeFileSync(binary, 'fixture', { mode: 0o700 }); } });
  try {
    while (!started) await delay(1);
    const second = build(f, { signal: owner.signal });
    await delay(30); const stopAt = performance.now(); owner.abort();
    const result = await second;
    assert.ok(performance.now() - stopAt < 150, 'abort waited for lock polling');
    assert.equal(result.detail.errorCode, 'ABORT_ERR');
    assert.equal(existsSync(join(f.cacheRoot, 'build.lock')), true);
    assert.equal(readdirSync(f.cacheRoot).some(name => name.includes('failed')), false);
  } finally { wait.resolve(); await first; }
});

test('a busy build wait has a deadline and is never recorded as a compiler failure', { skip, timeout: 10000 }, async t => {
  const f = fixture(t), wait = deferred(); let started = false, now = 0, waiting = false;
  const first = build(f, { compile: async ({ binary }) => { started = true; await wait.promise; writeFileSync(binary, 'fixture', { mode: 0o700 }); } });
  try {
    while (!started) await delay(1);
    t.mock.method(performance, 'now', () => now);
    const second = build(f, { onProgress: row => { if (row.stage === 'lock') waiting = true; } });
    while (!waiting) await delay(1);
    now = 600001;
    const result = await second;
    assert.equal(result.code, 'HOST_BUILD_BUSY');
    assert.equal(readdirSync(f.cacheRoot).some(name => name.includes('failed')), false);
    assert.equal(existsSync(join(f.cacheRoot, 'build.lock')), true);
  } finally { wait.resolve(); await first; }
});

test('automatic compile failures back off for one hour across starts and record one bounded diagnostic', { skip }, async t => {
  const f = fixture(t); let now = 100000000, calls = 0;
  t.mock.method(Date, 'now', () => now);
  const options = { toolchain: () => 'a'.repeat(64), compile: async () => { calls++; throw compilerFailure(); } };
  assert.equal((await build(f, options)).status, 'unavailable');
  assert.equal(calls, 1);
  const files = readdirSync(f.cacheRoot).filter(name => name.endsWith('.startup-failed.json'));
  assert.equal(files.length, 1);
  const record = readFileSync(join(f.cacheRoot, files[0]), 'utf8');
  assert.equal(JSON.parse(record).diagnostic, 'error: unable to load standard library');
  assert.doesNotMatch(record, /private compiler source|second private diagnostic/);
  assert.ok(Buffer.byteLength(record) <= 1024);
  assert.equal((await build(f, options)).code, 'HOST_COMPILE_BACKOFF'); assert.equal(calls, 1);
  now += 3599999;
  assert.equal((await build(f, options)).code, 'HOST_COMPILE_BACKOFF'); assert.equal(calls, 1);
  now++;
  await build(f, options); assert.equal(calls, 2);
  await build(f, { ...options, toolchain: () => 'b'.repeat(64) }); assert.equal(calls, 3, 'changed toolchain permits retry');
  const file = f.inventory.files[1]; file.sha256 = digest('changed source');
  writeFileSync(join(f.sourceRoot, 'glide-engine.swift'), 'changed source');
  await build(f, options); assert.equal(calls, 4, 'changed source permits retry');
});

test('a competing failure is rechecked after the build lock is acquired', { skip }, async t => {
  const f = fixture(t), wait = deferred(); let calls = 0, started = false;
  const options = { toolchain: () => 'a'.repeat(64), compile: async () => { calls++; started = true; await wait.promise; throw compilerFailure(); } };
  const first = build(f, options);
  try {
    while (!started) await delay(1);
    const second = build(f, options);
    await delay(30); wait.resolve();
    await first;
    assert.equal((await second).code, 'HOST_COMPILE_BACKOFF'); assert.equal(calls, 1);
  } finally { wait.resolve(); await first; }
});

test('successful builds and cache hits take precedence over old automatic failure memory', { skip }, async t => {
  const f = fixture(t), toolchain = () => 'a'.repeat(64);
  await build(f, { toolchain, compile: async () => { throw compilerFailure(); } });
  const ready = await build(f, { automatic: false, toolchain });
  assert.equal(ready.status, 'ready');
  assert.equal(readdirSync(f.cacheRoot).some(name => name.endsWith('.startup-failed.json')), false);
  assert.equal((await build(f, { toolchain, compile: () => assert.fail('warm cache must not compile') })).status, 'ready');
});

for (const [name, failure] of [
  ['timeout', { code: 'ETIMEDOUT', killed: true }], ['source mismatch', { message: 'HOST_SOURCE_MISMATCH' }],
  ['disk full', { code: 'ENOSPC' }], ['Xcode license', { code: 69, stderr: 'You have not agreed to the Xcode license agreements.' }],
  ['diagnostic disk full', { code: 1, stderr: 'error: unable to write output file: No space left on device' }],
  ['diagnostic license', { code: 1, stderr: 'error: Xcode license has not been accepted' }],
  ['quoted disk full', { code: 1, stderr: "error: unable to write output file: 'No space left on device'" }],
  ['quoted license', { code: 1, stderr: "error: 'Xcode license has not been accepted'" }],
  ['signal', { code: 1, signal: 'SIGKILL', stderr: 'error: cannot find type X in scope' }],
  ['no error diagnostic', { code: 1, stderr: 'source: cannot find type X in scope\nnote: no such module' }],
  ['echoed error string', { code: 1, stderr: '12 | let text = "error: cannot find type X in scope"\n   |             ^' }],
  ['frontend signal 9', { code: 1, stderr: 'error: compile command failed due to signal 9 (use -v to see invocation)' }],
  ['frontend killed', { code: 1, stderr: 'error: unable to execute command: Killed: 9' }],
  ['bare killed', { code: 1, stderr: 'Killed: 9\nerror: compile command failed' }],
  ['bare segmentation fault', { code: 1, stderr: 'Segmentation fault: 11\nerror: compile command failed' }],
  ['diagnostic segmentation fault', { code: 1, stderr: 'error: Segmentation fault: 11' }],
  ['abort trap', { code: 1, stderr: 'Abort trap: 6\nerror: compile command failed' }],
  ['diagnostic abort trap', { code: 1, stderr: 'error: unable to execute command: Abort trap: 6' }],
  ['out of memory', { code: 1, stderr: 'error: out of memory' }],
  ['stack dump', { code: 1, stderr: 'error: cannot find type X in scope\nStack dump:\n0. Program arguments: swift-frontend' }],
  ['quoted memory failure', { code: 1, stderr: "error: unable to execute command: 'out of memory'" }],
]) test('GLS3 ' + name + ' clears on the next automatic preparation', { skip }, async t => {
  const f = fixture(t);
  await build(f, { compile: async () => { throw Object.assign(Error('compiler failed'), failure); } });
  assert.equal(readdirSync(f.cacheRoot).some(name => name.endsWith('.startup-failed.json')), false);
  assert.equal((await build(f)).status, 'ready');
});

for (const [name, stderr] of [
  ['member', "Driver.swift:5:3: error: value of type 'X' has no member 'y'\n5 | x.y()"],
  ['identifier', "Driver.swift:5:3: error: use of unresolved identifier 'x'"],
  ['argument', "Driver.swift:5:3: error: missing argument for parameter 'x' in call"],
  ['availability', "Driver.swift:5:3: error: 'foo' is only available in macOS 15.0 or newer"],
  ['echoed resource', "Driver.swift:5:3: error: cannot find 'x' in scope\n5 | let resource = x\n  |                `- error: cannot find 'x' in scope"],
  ['echoed license', "Driver.swift:5:3: error: cannot find 'x' in scope\n5 | let license = x"],
  ['other deterministic diagnostic', 'error: circular reference'],
  ['unknown compiler location', "<unknown>:0: error: unable to load standard library for target 'arm64-apple-macos'"],
  ['line-only location', 'Driver.swift:5: error: circular reference'],
  ['resource identifier', "Driver.swift:5:3: error: cannot find 'resource' in scope"],
  ['license identifier', "Driver.swift:5:3: error: cannot find 'license' in scope"],
  ['license property', "Driver.swift:5:3: error: value of type 'License' has no member 'expired'"],
  ['license-like identifier', "Driver.swift:5:3: error: use of unresolved identifier 'licenseNotAccepted'"],
  ['license-like parameter', "Driver.swift:5:3: error: missing argument for parameter 'notAcceptedLicense' in call"],
  ['crash-like identifier', "Driver.swift:5:3: error: cannot find 'KilledProcess' in scope"],
  ['quoted crash identifier', "Driver.swift:5:3: error: value of type 'X' has no member 'Stack dump'"],
  ['echoed crash strings', 'error: circular reference\n5 | let s = "Segmentation fault: 11, out of memory"\n  | `- error: circular reference'],
]) test('GLINT3 diagnostic ' + name + ' backs off only for the same source and toolchain', { skip }, async t => {
  const f = fixture(t); let calls = 0;
  const options = { toolchain: () => 'a'.repeat(64), compile: async () => {
    calls++; throw Object.assign(Error('compiler failed'), { code: 1, stderr });
  } };
  await build(f, options);
  assert.equal((await build(f, options)).code, 'HOST_COMPILE_BACKOFF');
  assert.equal(calls, 1);
  await build(f, { ...options, toolchain: () => 'b'.repeat(64) }); assert.equal(calls, 2);
  f.inventory.files[1].sha256 = digest('changed source');
  writeFileSync(join(f.sourceRoot, 'glide-engine.swift'), 'changed source');
  await build(f, options); assert.equal(calls, 3);
});

test('server initiated product compiler launches peer and Swift at nice 10', { skip }, async t => {
  const f = fixture(t), calls = [];
  t.mock.method(childProcess, 'spawn', (file, args) => {
    calls.push({ file, args });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    writeFileSync(args.at(-1), 'fixture binary', { mode: 0o700 });
    setImmediate(() => child.emit('close', 0, null)); return child;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.equal((await build(f, { compile: undefined })).status, 'ready');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.file, '/usr/bin/nice'); assert.deepEqual(call.args.slice(0, 3), ['-n', '10', '/usr/bin/xcrun']);
  }
});

test('doctor reads a saved compile failure without starting a compiler', { skip }, async t => {
  t.mock.method(Date, 'now', () => 100000000);
  const root = fixture(t).cacheRoot;
  const prepare = (options, selected) => prepareNativeHelpers({ ...options, compile: async () => { throw compilerFailure(); } }, selected);
  await prepareMacDriver({ cacheRoot: root, tools: async () => true, prepare, prebuilt: () => undefined });
  const state = runtimeBuildState({ cacheRoot: root });
  assert.match(state.status, /compile failed.*HOST_COMPILE_FAILED.*retry/);
  assert.match(state.status, /clear.*startup-failed\.json/i);
  const marker = readdirSync(root).find(name => name.endsWith('.startup-failed.json'));
  assert.equal(state.status, `compile failed (HOST_COMPILE_FAILED; automatic retry in 3600 s; clear ${marker} in the helper cache to retry now); error: unable to load standard library`);
  assert.doesNotMatch(state.status, /private compiler source|second private diagnostic/);
  const result = runtimeDoctorSection({ platform: 'darwin', env: { SLEIGHT_RUNTIME: 'own' }, buildState: () => state,
    compilerState: () => 'found', lastProbe: () => 'none', rendererRecords: () => '0', consentRecipe: () => 'default',
    selectNode: () => ({ execPath: '/fixture/node', version: 'v26.0.0' }) });
  assert.equal(result.ok, false);
  assert.equal(result.lines.find(line => line.startsWith('helper    ')), `helper    ${state.status}`);
});

test('GLINT4 saved doctor cause is bounded, scrubbed and compatible with old markers', { skip }, async t => {
  const cacheRoot = fixture(t).cacheRoot;
  const stderr = `Driver.swift:9:3: error: cannot load '${userInfo().homedir}/private-module'\n` +
    '9 | PRIVATE SOURCE\nerror: SECOND ERROR';
  const prepare = (options, selected) => prepareNativeHelpers({ ...options,
    compile: async () => { throw Object.assign(Error('compiler failed'), { code: 1, stderr }); } }, selected);
  await prepareMacDriver({ cacheRoot, tools: async () => true, prepare, prebuilt: () => undefined });
  const saved = readdirSync(cacheRoot).find(name => name.endsWith('.startup-failed.json'));
  const path = join(cacheRoot, saved), marker = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(marker.diagnostic, "error: cannot load '~/private-module'");
  const state = runtimeBuildState({ cacheRoot });
  assert.ok(state.status.endsWith("; error: cannot load '~/private-module'"), state.status);
  assert.doesNotMatch(state.status, /PRIVATE SOURCE|SECOND ERROR/);
  // Readback sanitizes even a diagnostic rewritten in a valid user-owned marker.
  marker.diagnostic = `error: '${userInfo().homedir}/module' ` + 'é'.repeat(600);
  // Keep the 1 KB marker budget when exercising readback, rather than making it
  // fail the existing whole-marker size check before diagnostic handling.
  marker.diagnostic = marker.diagnostic.slice(0, 300);
  writeFileSync(path, JSON.stringify(marker), { mode: 0o600 });
  const modified = runtimeBuildState({ cacheRoot });
  const line = modified.status.slice(modified.status.indexOf('; error: ') + 2);
  assert.ok(Buffer.byteLength(line) <= 240);
  assert.ok(line.startsWith("error: '~/module' "));
  delete marker.diagnostic; writeFileSync(path, JSON.stringify(marker), { mode: 0o600 });
  const legacy = runtimeBuildState({ cacheRoot });
  assert.match(legacy.status, /compile failed.*automatic retry/);
  assert.doesNotMatch(legacy.status, /; error:/);
});

test('toolchain identity changes with selection and compiler replacement without executing either', () => {
  let selection = '/fixture/DeveloperA', replacement = 1;
  const io = { realpathSync: path => path === '/var/db/xcode_select_link' ? selection : path,
    statSync: () => ({ dev: 1, ino: replacement, size: 100, mtimeMs: 200, ctimeMs: 200 }) };
  const first = helperToolchainKey({ io });
  assert.equal(helperToolchainKey({ io }), first);
  replacement++;
  assert.notEqual(helperToolchainKey({ io }), first);
  replacement = 1; selection = '/fixture/DeveloperB';
  assert.notEqual(helperToolchainKey({ io }), first);
});

test('GLS3 the last successful compile duration informs a changed-source build on the same toolchain', { skip }, async t => {
  const f = fixture(t); let now = 0;
  t.mock.method(performance, 'now', () => now);
  const toolchain = () => 'a'.repeat(64);
  assert.equal((await build(f, { toolchain, compile: async ({ binary }) => {
    now += 12500; writeFileSync(binary, 'fixture', { mode: 0o700 });
  } })).status, 'ready');
  const file = f.inventory.files[1]; file.sha256 = digest('changed source');
  writeFileSync(join(f.sourceRoot, 'glide-engine.swift'), 'changed source');
  const events = [];
  assert.equal((await build(f, { toolchain, onProgress: event => events.push(event) })).status, 'ready');
  assert.equal(events.find(event => event.stage === 'compile').expectedCompileMs, 25000);
  const other = [];
  file.sha256 = digest('another source'); writeFileSync(join(f.sourceRoot, 'glide-engine.swift'), 'another source');
  await build(f, { toolchain: () => 'b'.repeat(64), onProgress: event => other.push(event) });
  assert.equal(other.find(event => event.stage === 'compile').expectedCompileMs, undefined);
});
