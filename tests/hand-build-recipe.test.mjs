import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { prepareNativeHelpers, prepareHandHost, createNativeProcessProvider } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { helperBuildKey, helperBuildRecipes, helperCompileArgs, nativeHelpersBuilt, handHostRecipe } from '../plugins/sleight/lib/direct-browser/host-cache.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const hashes = { 'peer-host.c': digest('peer'), 'consent-host.swift': digest('consent') };
const oldKey = sources => digest(JSON.stringify({ protocol: 1, arch: process.arch, sources }));
const keyWithRecipes = (sources, recipes) => digest(JSON.stringify({ protocol: 1, arch: process.arch, sources, recipes }));
const paths = { sources: ['source'], binary: 'binary', moduleCache: 'modules' };

test('CP1A2 the compiler policy has no import cycle through sealed settings', async () => {
  const leaf = await import('../plugins/sleight/lib/settings-build-policy.mjs');
  const settings = await import('../plugins/sleight/lib/sealed-settings.mjs');
  assert.equal(settings.SETTINGS_BUILD_POLICY, leaf.SETTINGS_BUILD_POLICY);
  assert.equal(Object.isFrozen(leaf.SETTINGS_BUILD_POLICY), true);
  const cacheSource = readFileSync(new URL('../plugins/sleight/lib/direct-browser/host-cache.mjs', import.meta.url), 'utf8');
  const policySource = readFileSync(new URL('../plugins/sleight/lib/settings-build-policy.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(cacheSource, /from ['"]\.\.\/sealed-settings\.mjs/);
  assert.doesNotMatch(policySource, /\bimport\s/);
});

test('CP1A recipe keys change with compiler flags while source hashes stay identical', () => {
  const recipes = helperBuildRecipes(hashes);
  assert.deepEqual(recipes['consent-host'].args, ['swiftc', '-O', '-module-cache-path', '<module-cache>', '<source>', '-o', '<binary>']);
  assert.equal(helperBuildKey(hashes), keyWithRecipes(hashes, recipes));
  assert.notEqual(helperBuildKey(hashes), oldKey(hashes));
  recipes['consent-host'].args = recipes['consent-host'].args.filter(arg => arg !== '-O');
  assert.notEqual(helperBuildKey(hashes), keyWithRecipes(hashes, recipes), 'an unoptimized recipe cannot reuse the optimized key');
  assert.deepEqual(helperCompileArgs('peer-host', paths), ['clang', '-Wall', '-Werror', '-fmodules-cache-path=modules', 'source', '-lbsm', '-o', 'binary']);
  assert.deepEqual(helperCompileArgs('glide-engine', paths), ['swiftc', '-module-cache-path', 'modules', 'source', '-o', 'binary']);
  assert.deepEqual(helperCompileArgs('pdf-host', paths), ['swiftc', '-module-cache-path', 'modules', 'source', '-o', 'binary']);
  const sealed = helperBuildRecipes({ ...hashes, '../../mac-driver/native/SealedSettings.swift': digest('seal') });
  assert.ok(sealed['consent-host'].args.includes('SLEIGHT_SEALED_SETTINGS'));
  assert.deepEqual(sealed['peer-host'], helperBuildRecipes(hashes)['peer-host']);
});

test('CP1A2 cold consent returns the default host before optimization and switches only on another preparation', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), tasks = [], calls = [];
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const options = { ...f, scheduleUpgrade: task => tasks.push(task), compile: async ({ name, binary, recipe, background }) => {
    calls.push({ name, recipe, background });
    if (recipe === 'optimized') await blocked;
    writeFileSync(binary, recipe + name, { mode: 0o700 });
  } };
  const first = await prepareNativeHelpers(options);
  assert.equal(first.status, 'ready'); assert.equal(first.recipe, 'default');
  assert.equal(first.directory, join(f.cacheRoot, helperBuildKey(hashes, 'default')));
  assert.equal(calls.length, 2); assert.ok(calls.every(c => c.recipe === 'default' && !c.background));
  assert.equal(tasks.length, 1);
  const upgrading = tasks.shift()();
  const during = await prepareNativeHelpers(options);
  assert.equal(during.recipe, 'default'); assert.equal(tasks.length, 0, 'one upgrade per bank');
  assert.equal(typeof createNativeProcessProvider(first.receipt), 'function', 'foreground receipt stays usable');
  release(); await upgrading;
  assert.equal(calls.length, 4); assert.ok(calls.slice(2).every(c => c.recipe === 'optimized' && c.background));
  const next = await prepareNativeHelpers(options);
  assert.equal(next.recipe, 'optimized'); assert.notEqual(next.directory, first.directory);
  assert.equal(typeof createNativeProcessProvider(first.receipt), 'function', 'upgrade must not replace the running bank');
  assert.equal(tasks.length, 0);
  const record = JSON.parse(readFileSync(next.record)); delete record.recipes;
  writeFileSync(next.record, JSON.stringify(record));
  const fallback = await prepareNativeHelpers(options);
  assert.equal(fallback.recipe, 'default', 'bad optimized record never issues a receipt');
  assert.equal(tasks.length, 1); await tasks.shift()();
  assert.equal((await prepareNativeHelpers(options)).recipe, 'optimized', 'recipe mismatch rebuilds');
});

test('CP1A3 failed background optimization backs off for 24 hours across callers and source changes retry', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), tasks = [];
  let clock = 100000000;
  t.mock.method(Date, 'now', () => clock);
  const options = { ...f, scheduleUpgrade: task => tasks.push(task), compile: async ({ name, binary, recipe }) => {
    if (recipe === 'optimized') throw Error('fixture compile failure');
    writeFileSync(binary, name, { mode: 0o700 });
  } };
  const first = await prepareNativeHelpers(options); await tasks.shift()();
  assert.equal(first.recipe, 'default');
  assert.equal(typeof createNativeProcessProvider(first.receipt), 'function');
  const next = await prepareNativeHelpers(options);
  assert.equal(next.recipe, 'default'); assert.equal(tasks.length, 0, 'same key must back off after failure');
  const marker = join(f.cacheRoot, helperBuildKey(hashes) + '.failed.json');
  assert.deepEqual(JSON.parse(readFileSync(marker)), { key: helperBuildKey(hashes), failedAt: clock });
  assert.equal((await prepareNativeHelpers({ ...options, upgradeSignal: new AbortController().signal })).recipe, 'default');
  assert.equal(tasks.length, 0, 'another lifetime reads the on-disk marker');
  clock += 24 * 3600000 - 1;
  await prepareNativeHelpers(options); assert.equal(tasks.length, 0, 'still backed off at 24 hours minus 1 ms');
  clock++;
  await prepareNativeHelpers(options); assert.equal(tasks.length, 1, '24 hours permits one retry'); await tasks.shift()();
  const changed = 'changed consent';
  writeFileSync(join(f.sourceRoot, 'consent-host.swift'), changed);
  f.inventory.files.find(file => file.path.endsWith('consent-host.swift')).sha256 = digest(changed);
  await prepareNativeHelpers(options); assert.equal(tasks.length, 1, 'source changes permit an immediate retry'); await tasks.shift()();

});

test('INT23 future-dated optimization failure expires and permits a retry', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), tasks = [], now = 100000000;
  t.mock.method(Date, 'now', () => now);
  await prepareNativeHelpers({ ...f, recipe: 'default' });
  const marker = join(f.cacheRoot, helperBuildKey(hashes) + '.failed.json');
  writeFileSync(marker, JSON.stringify({ key: helperBuildKey(hashes), failedAt: now + 1e9 }), { mode: 0o600 });
  const ready = await prepareNativeHelpers({ ...f, scheduleUpgrade: task => tasks.push(task) });
  assert.equal(ready.recipe, 'default');
  assert.equal(tasks.length, 1, 'a future marker must not suppress optimization');
  await tasks.shift()();
  assert.equal(handHostRecipe(f), 'optimized');
  assert.equal(existsSync(marker), false);
});

test('INT23 the default upgrade scheduler cancels its timer when its owner aborts', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), owner = new AbortController(), later = globalThis.setTimeout, clear = globalThis.clearTimeout;
  let scheduled, cancelled = false, unrefs = 0;
  const token = { unref() { unrefs++; } };
  t.mock.method(globalThis, 'setTimeout', (task, ms, ...args) => {
    if (ms === 1000) { scheduled = task; return token; }
    return later(task, ms, ...args);
  });
  t.mock.method(globalThis, 'clearTimeout', timer => {
    if (timer === token) cancelled = true;
    else clear(timer);
  });
  await prepareNativeHelpers({ ...f, upgradeSignal: owner.signal });
  assert.equal(typeof scheduled, 'function'); assert.equal(unrefs, 1);
  owner.abort();
  assert.equal(cancelled, true, 'the real default scheduler must call clearTimeout');
  assert.deepEqual(f.calls, ['peer-host', 'consent-host']);
  assert.equal(handHostRecipe(f), 'default');
});

test('CP1A2 cached predicates reject tampered binaries even with a matching recipe and rebuild', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), first = await prepareNativeHelpers({ ...f, recipe: 'default' });
  assert.equal(nativeHelpersBuilt(f), true); assert.equal(handHostRecipe(f), 'default');
  writeFileSync(join(first.directory, 'consent-host'), 'tampered binary');
  assert.equal(nativeHelpersBuilt(f), false); assert.equal(handHostRecipe(f), 'not built');
  const rebuilt = await prepareNativeHelpers({ ...f, recipe: 'default' });
  assert.equal(rebuilt.status, 'ready'); assert.equal(f.calls.length, 4); assert.equal(nativeHelpersBuilt(f), true);
});

test('CP1A2 a cached default host never starts an upgrade when Apple tools are missing', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), tasks = [], launches = [];
  await prepareNativeHelpers({ ...f, recipe: 'default' });
  const first = await prepareNativeHelpers({ ...f, compile: undefined, tools: async () => false, scheduleUpgrade: task => tasks.push(task) });
  assert.equal(first.recipe, 'default');
  t.mock.method(childProcess, 'spawn', (...args) => { launches.push(args); throw Error('fixture compiler unavailable'); });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await tasks.shift()(); assert.equal(f.calls.length, 2);
  assert.equal(launches.length, 0, 'missing-tools upgrade must not invoke xcrun');
});

test('CP1A2 product background compiler uses nice 20 and the sealed combined source matches its receipt', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), calls = [], tasks = [];
  const seal = join(f.sourceRoot, '../../mac-driver/native'); mkdirSync(seal, { recursive: true, mode: 0o700 });
  writeFileSync(join(seal, 'SealedSettings.swift'), 'sealed settings', { mode: 0o600 });
  f.inventory.files.push({ path: 'mac-driver/native/SealedSettings.swift', sha256: digest('sealed settings') });
  t.mock.method(childProcess, 'spawn', (file, args) => {
    calls.push({ file, args });
    if (args.includes('SLEIGHT_SEALED_SETTINGS')) assert.equal(readFileSync(args.at(-3), 'utf8'), 'sealed settings\nconsent');
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    writeFileSync(args.at(-1), 'compiled fixture', { mode: 0o700 });
    setImmediate(() => child.emit('close', 0, null)); return child;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await prepareNativeHelpers({ ...f, compile: undefined, scheduleUpgrade: task => tasks.push(task) });
  assert.equal(result.recipe, 'default'); assert.equal(calls[1].args.includes('-O'), false);
  assert.ok(JSON.parse(readFileSync(result.record)).recipes['consent-host'].args.includes('SLEIGHT_SEALED_SETTINGS'));
  await tasks.shift()();
  assert.equal(calls.length, 4);
  for (const call of calls.slice(2)) { assert.equal(call.file, '/usr/bin/nice'); assert.deepEqual(call.args.slice(0, 3), ['-n', '20', '/usr/bin/xcrun']); }
  assert.equal(calls[3].args.includes('-O'), true);
});

function fixture(t) {
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-recipe-'))));
  const sourceRoot = join(root, 'lib/direct-browser/native'), cacheRoot = join(root, 'cache');
  mkdirSync(sourceRoot, { recursive: true, mode: 0o700 }); mkdirSync(cacheRoot, { mode: 0o700 });
  const inventory = { accepted: true, protocol: 1, helperMode: 'source', node: process.version,
    files: Object.keys(hashes).map(name => {
      const bytes = name === 'peer-host.c' ? 'peer' : 'consent';
      writeFileSync(join(sourceRoot, name), bytes, { mode: 0o600 });
      return { path: 'native/' + name, sha256: digest(bytes) };
    }) };
  const calls = [];
  const compile = async ({ name, binary }) => { calls.push(name); writeFileSync(binary, 'fixture ' + name, { mode: 0o700 }); };
  return { sourceRoot, cacheRoot, inventory, compile, calls, upgradeSignal: new AbortController().signal };
}

function seed(f, key, recipes) {
  const directory = join(f.cacheRoot, key), binaries = {};
  mkdirSync(directory, { mode: 0o700 });
  for (const name of ['peer-host', 'consent-host']) {
    writeFileSync(join(directory, name), 'fixture ' + name, { mode: 0o700 });
    binaries[name] = digest('fixture ' + name);
  }
  writeFileSync(join(directory, 'build.json'), JSON.stringify({ protocol: 1, arch: process.arch,
    sources: hashes, binaries, ...recipes ? { recipes } : {} }), { mode: 0o600 });
}

for (const variant of ['old-key', 'missing-recipe', 'unoptimized-recipe']) {
  test('CP1A rejects ' + variant + ' cache evidence and builds before issuing a receipt', { skip: process.platform !== 'darwin' }, async t => {
    const f = fixture(t), recipes = helperBuildRecipes(hashes);
    if (variant === 'unoptimized-recipe') recipes['consent-host'].args = recipes['consent-host'].args.filter(arg => arg !== '-O');
    seed(f, variant === 'old-key' ? oldKey(hashes) : helperBuildKey(hashes), variant === 'unoptimized-recipe' ? recipes : undefined);
    assert.equal(nativeHelpersBuilt(f), false, 'doctor must not report an old recipe as built');
    const result = await prepareNativeHelpers({ ...f, recipe: 'optimized' });
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.deepEqual(f.calls, ['peer-host', 'consent-host']);
    const record = JSON.parse(readFileSync(result.record));
    assert.deepEqual(record.recipes, helperBuildRecipes(hashes));
    assert.equal(nativeHelpersBuilt(f), true);
    assert.equal(typeof createNativeProcessProvider(result.receipt), 'function');
    const reused = await prepareNativeHelpers({ ...f, recipe: 'optimized' });
    assert.equal(reused.directory, result.directory); assert.equal(f.calls.length, 2);
    delete record.recipes;
    writeFileSync(result.record, JSON.stringify(record), { mode: 0o600 });
    assert.equal(nativeHelpersBuilt(f), false);
    assert.throws(() => createNativeProcessProvider(result.receipt), /HOST_PACKAGE_MISMATCH/);
  });
}

test('CP1A default product compiler uses the recorded optimized arguments and keeps compiler ownership', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), calls = [];
  t.mock.method(childProcess, 'spawn', (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    writeFileSync(args.at(-1), 'compiled fixture', { mode: 0o700 });
    setImmediate(() => child.emit('close', 0, null));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await prepareNativeHelpers({ ...f, recipe: 'optimized', compile: undefined });
  assert.equal(result.status, 'ready', JSON.stringify(result)); assert.equal(calls.length, 2);
  const recipes = JSON.parse(readFileSync(result.record)).recipes;
  for (const [i, name] of ['peer-host', 'consent-host'].entries()) {
    const { file, args, options } = calls[i];
    assert.equal(file, recipes[name].command);
    const bank = args.at(-1).slice(0, args.at(-1).lastIndexOf('/'));
    const expected = recipes[name].args.map(arg => arg.replace('<module-cache>', join(bank, 'module-cache'))
      .replace('<source>', join(bank, name + (name === 'peer-host' ? '.c' : '.swift'))).replace('<binary>', join(bank, name)));
    assert.deepEqual(args, expected);
    assert.equal(options.detached, true); assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  }
  assert.equal(calls[1].args[1], '-O');
});

test('CP1A cancellation retains the build lock until compiler close and keeps the 300000 ms deadline', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), controller = new AbortController(), timer = globalThis.setTimeout;
  let child, compilerSource, deadline;
  t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
    if (ms === 300000) deadline = ms;
    return timer(fn, ms, ...args);
  });
  t.mock.method(childProcess, 'spawn', (_file, args) => {
    compilerSource = args[args.indexOf('-o') - 2];
    child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    return child;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let returned = false;
  const pending = prepareNativeHelpers({ ...f, recipe: 'optimized', compile: undefined, signal: controller.signal }).then(value => { returned = true; return value; });
  controller.abort(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(deadline, 300000); assert.equal(returned, false);
  assert.equal(existsSync(join(f.cacheRoot, helperBuildKey(hashes) + '.lock')), true); assert.equal(existsSync(compilerSource), true);
  child.emit('close', null, 'SIGKILL');
  const result = await pending;
  assert.equal(result.detail.errorCode, 'ABORT_ERR');
  assert.equal(existsSync(join(f.cacheRoot, helperBuildKey(hashes) + '.lock')), false); assert.equal(existsSync(compilerSource), false);
});


test('CP1A2 a prepared hand handle picks a validated upgrade on its next spawn, without launching a host', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), tasks = [], launches = [];
  const ready = await prepareHandHost({ ...f, tools: async () => true, scheduleUpgrade: task => tasks.push(task),
    compile: async ({ name, binary, recipe }) => writeFileSync(binary, recipe + name, { mode: 0o700 }) });
  t.mock.method(childProcess, 'spawn', (file, args) => { launches.push({ file, args }); return {}; });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  ready.spawn(); assert.equal(handHostRecipe(f), 'default');
  await tasks.shift()(); assert.equal(handHostRecipe(f), 'optimized');
  const record = join(f.cacheRoot, helperBuildKey(hashes), 'build.json'), contents = readFileSync(record);
  const bad = JSON.parse(contents); delete bad.recipes; writeFileSync(record, JSON.stringify(bad));
  ready.spawn(); assert.equal(launches[1].file, launches[0].file, 'tampered receipt cannot switch the host');
  assert.equal(handHostRecipe(f), 'default');
  writeFileSync(record, contents);
  ready.spawn();
  assert.notEqual(launches[2].file, launches[0].file);
  assert.equal(launches[2].file, join(f.cacheRoot, helperBuildKey(hashes), 'consent-host'));
  assert.equal(launches.length, 3);
});

for (const interrupted of [false, true]) test(`CP1A3 one-shot hand preparation ${interrupted ? 'interrupted' : 'returns'} without starting optimization`, { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), tasks = [];
  const controller = new AbortController();
  const ready = await prepareHandHost({ ...f, upgradeSignal: undefined, signal: controller.signal,
    tools: async () => true, scheduleUpgrade: task => tasks.push(task) });
  assert.equal(ready.status, 'ready');
  if (interrupted) controller.abort();
  assert.equal(tasks.length, 0, 'a one-shot caller never leaves an upgrade to run after return or Ctrl-C');
  assert.deepEqual(f.calls, ['peer-host', 'consent-host']);
  assert.ok(readdirSync(f.cacheRoot).every(name => !name.startsWith('build-') && !name.endsWith('.lock')));
});

for (const mode of ['return', 'interrupt']) test(`CP1A3 one-shot subprocess ${mode} leaves zero background compilers`, { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t);
  const child = childProcess.spawn(process.execPath, [new URL('./fixtures/consent-prepare-cli.mjs', import.meta.url).pathname,
    f.sourceRoot, f.cacheRoot, mode], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000, killSignal: 'SIGKILL' });
  let output = '', stderr = '', interrupted = false;
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.stdout.on('data', bytes => {
    output += bytes;
    if (mode === 'interrupt' && output.includes('ready\n') && !interrupted) { interrupted = true; child.kill('SIGINT'); }
  });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  assert.equal(stderr, '');
  assert.deepEqual(result, mode === 'return' ? { code: 0, signal: null } : { code: null, signal: 'SIGINT' });
  assert.equal(output, 'default:peer-host\ndefault:consent-host\nready\n');
  assert.ok(readdirSync(f.cacheRoot).every(name => !name.startsWith('build-') && !name.endsWith('.lock')));
});

test('CP1A3 cancellation before upgrade start releases ownership and does not compile', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), tasks = [], controller = new AbortController();
  const options = { ...f, upgradeSignal: controller.signal, scheduleUpgrade: task => tasks.push(task) };
  const first = await prepareNativeHelpers(options);
  controller.abort(); await tasks.shift()();
  assert.deepEqual(f.calls, ['peer-host', 'consent-host']);
  assert.equal(typeof createNativeProcessProvider(first.receipt), 'function');
  assert.equal(readdirSync(f.cacheRoot).some(name => name.endsWith('.failed.json')), false, 'cancellation is not a compiler failure');
  await prepareNativeHelpers({ ...options, upgradeSignal: new AbortController().signal });
  assert.equal(tasks.length, 1, 'another lifetime may take ownership'); await tasks.shift()();
});

test('CP1A3 running optimization is cancelled with its owner and cleans its bank after compiler close', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), tasks = [], controller = new AbortController(), stops = [];
  const first = await prepareNativeHelpers({ ...f, recipe: 'default' });
  let child, compilerBank;
  t.after(() => child?.emit('close', null, 'SIGKILL'));
  t.mock.method(childProcess, 'spawn', (_file, args) => {
    compilerBank = args.at(-1).slice(0, args.at(-1).lastIndexOf('/'));
    child = new EventEmitter(); child.pid = 123456;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); return child;
  });
  t.mock.method(process, 'kill', (pid, signal) => { stops.push([pid, signal]); });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await prepareNativeHelpers({ ...f, compile: undefined, upgradeSignal: controller.signal, scheduleUpgrade: task => tasks.push(task) });
  const pending = tasks.shift()();
  while (!child) await new Promise(resolve => setImmediate(resolve));
  controller.abort(); assert.deepEqual(stops, [[-123456, 'SIGKILL']]);
  assert.equal(existsSync(compilerBank), true, 'bank stays owned until close');
  assert.equal(existsSync(join(f.cacheRoot, helperBuildKey(hashes) + '.lock')), true);
  child.emit('close', null, 'SIGKILL'); await pending;
  assert.equal(existsSync(compilerBank), false);
  assert.equal(existsSync(join(f.cacheRoot, helperBuildKey(hashes) + '.lock')), false);
  assert.equal(readdirSync(f.cacheRoot).some(name => name.endsWith('.failed.json')), false);
  assert.equal(typeof createNativeProcessProvider(first.receipt), 'function');
});

for (const recipe of ['default', 'optimized']) test(`CP1A3 ${recipe} builder rechecks a competing publication after taking the lock`, { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t); let published = false;
  const result = await prepareNativeHelpers({ ...f, recipe, onProgress: event => {
    if (event.stage === 'lock' && !published) { published = true; seed(f, helperBuildKey(hashes, recipe), helperBuildRecipes(hashes, recipe)); }
  } });
  assert.equal(result.status, 'ready'); assert.equal(published, true);
  assert.equal(f.calls.length, 0, 'a complete competing bank must not be rebuilt or removed');
  assert.equal(existsSync(join(f.cacheRoot, recipe === 'optimized' ? helperBuildKey(hashes) + '.lock' : 'build.lock')), false);
});


test('CP1A3 an optimization failure published by another owner after scheduling stops a duplicate compile', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), tasks = [];
  await prepareNativeHelpers({ ...f, scheduleUpgrade: task => tasks.push(task), onUpgradeProgress: event => {
    if (event.stage === 'lock') writeFileSync(join(f.cacheRoot, helperBuildKey(hashes) + '.failed.json'),
      JSON.stringify({ key: helperBuildKey(hashes), failedAt: Date.now() }), { mode: 0o600 });
  } });
  await tasks.shift()();
  assert.deepEqual(f.calls, ['peer-host', 'consent-host']);
  assert.equal(handHostRecipe(f), 'default');
  assert.equal(existsSync(join(f.cacheRoot, helperBuildKey(hashes) + '.lock')), false);
});

test('CP1A3 a successful retry removes expired failure memory and leaves only complete banks', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), tasks = [];
  await prepareNativeHelpers({ ...f, recipe: 'default' });
  const marker = join(f.cacheRoot, helperBuildKey(hashes) + '.failed.json');
  writeFileSync(marker, JSON.stringify({ key: helperBuildKey(hashes), failedAt: Date.now() - 24 * 3600000 }), { mode: 0o600 });
  await prepareNativeHelpers({ ...f, scheduleUpgrade: task => tasks.push(task) });
  assert.equal(tasks.length, 1); await tasks.shift()();
  assert.equal(handHostRecipe(f), 'optimized'); assert.equal(existsSync(marker), false);
  assert.ok(readdirSync(f.cacheRoot).every(name => /^[a-f0-9]{64}$/.test(name)));
});


for (const end of ['exit', 'SIGINT', 'SIGTERM']) test(`CP1A3 background compiler ownership ends on parent ${end}`, { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), tasks = [], stops = [], before = process.listeners(end);
  await prepareNativeHelpers({ ...f, recipe: 'default' });
  let child;
  t.after(() => child?.emit('close', null, 'SIGKILL'));
  t.mock.method(childProcess, 'spawn', () => {
    child = new EventEmitter(); child.pid = 123456;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); return child;
  });
  t.mock.method(process, 'kill', (pid, signal) => { stops.push([pid, signal]); });
  // SIGTERM models a host with its own shutdown handler. SIGINT models Node's default action.
  const count = process.listenerCount.bind(process);
  t.mock.method(process, 'listenerCount', event => event === end && end === 'SIGTERM' ? 2 : count(event));
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await prepareNativeHelpers({ ...f, compile: undefined, tools: async () => true, scheduleUpgrade: task => tasks.push(task) });
  const pending = tasks.shift()();
  while (!child) await new Promise(resolve => setImmediate(resolve));
  const installed = process.listeners(end).filter(fn => !before.includes(fn));
  assert.equal(installed.length, 1, 'the compiler must own a shutdown listener');
  installed[0]();
  assert.deepEqual(stops, end === 'SIGINT' ? [[-123456, 'SIGKILL'], [process.pid, 'SIGINT']] : [[-123456, 'SIGKILL']]);
  child.emit('close', null, 'SIGKILL'); await pending;
  assert.deepEqual(process.listeners(end), before, 'compiler close releases its shutdown listener');
  assert.equal(readdirSync(f.cacheRoot).some(name => name.endsWith('.failed.json')), false);
});


test('CP1A3 a once-only host signal handler keeps its shutdown semantics after dispatch', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t), tasks = [], stops = [];
  await prepareNativeHelpers({ ...f, recipe: 'default' });
  const hostHandler = () => {};
  process.once('SIGTERM', hostHandler);
  const before = process.listeners('SIGTERM');
  let child;
  t.after(() => { child?.emit('close', null, 'SIGKILL'); process.off('SIGTERM', hostHandler); });
  t.mock.method(childProcess, 'spawn', () => {
    child = new EventEmitter(); child.pid = 123456;
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); return child;
  });
  t.mock.method(process, 'kill', (pid, signal) => { stops.push([pid, signal]); });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await prepareNativeHelpers({ ...f, compile: undefined, tools: async () => true, scheduleUpgrade: task => tasks.push(task) });
  const pending = tasks.shift()();
  while (!child) await new Promise(resolve => setImmediate(resolve));
  const installed = process.listeners('SIGTERM').filter(fn => !before.includes(fn));
  // EventEmitter removes a once listener before calling the next listener.
  process.rawListeners('SIGTERM').find(fn => fn.listener === hostHandler)();
  installed[0]();
  assert.deepEqual(stops, [[-123456, 'SIGKILL']], 'the host still owns termination after its once callback ran');
  child.emit('close', null, 'SIGKILL'); await pending;
});
