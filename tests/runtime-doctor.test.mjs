import { offlineDoctor } from './fixtures/preapproved-storage.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, symlinkSync, utimesSync, chmodSync, linkSync, readFileSync, lstatSync, readdirSync, openSync, fstatSync, closeSync, readSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { helperBuildKey, helperBuildRecipes } from '../plugins/sleight/lib/direct-browser/host-cache.mjs';
import { runtimeCompilerState, runtimeBuildState, runtimeLastProbe, runtimeRendererRecords, runtimeDoctorSection } from '../plugins/sleight/lib/runtime-doctor.mjs';
import { doctor } from '../plugins/sleight/lib/launch.mjs';

const build = 'a'.repeat(64), binaryBuild = 'b'.repeat(64);
const source = () => `let driverBuild = "${build}"\n// synthetic source\n`;
const peer = () => Buffer.from('synthetic peer');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const bank = t => {
  const path = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-runtime-doctor-'))));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
const report = () => ({ schema: 'sleight.runtime-probe/2', runtime: 'own', finishedAt: '2026-10-31T20:00:00Z',
  driverIdentity: { version: '1', build: binaryBuild }, cleanupConfirmed: true,
  verdict: { verdict: 'step1: mechanisms-pass' }, cells: [
    { passed: true, trialsData: [{ runtimeReceipt: { driverSourceBuild: build } }] },
    { passed: false, trialsData: [{ runtimeReceipt: { driverSourceBuild: build } }] },
  ] });
const section = options => runtimeDoctorSection({ platform: 'darwin', env: {},
  node: { execPath: '/fixture/node', version: 'v25.0.0', allowedNodeEnvironmentFlags: new Set(['--permission', '--allow-net']) },
  buildState: () => ({ build, status: 'not compiled for this source' }),
  selectNode: () => ({ execPath: '/fixture/node', version: 'v25.0.0' }),
  compilerState: () => 'found (fake files)', lastProbe: () => 'none saved', rendererRecords: () => '0 record(s)', consentRecipe: () => 'default', grants: { accessibility: true, screenRecording: false }, ...options });

test('doctor reports the launcher Node and worker flags without probing another executable', () => {
  const result = section({ env: { SLEIGHT_RUNTIME: 'own' } });
  assert.equal(result.ok, true);
  assert.ok(result.lines.includes('node      /fixture/node (v25.0.0; relay executable)'));
  assert.match(result.lines.join('\n'), /worker    ready.*--permission.*--allow-net/);
});

test('engine diagnosis omits the preview worker status regardless of Node flag support', () => {
  for (const flags of [[], ['--permission'], ['--allow-net'], ['--permission', '--allow-net']]) {
    const result = section({
      node: { execPath: '/fixture/node', version: 'v24.0.0', allowedNodeEnvironmentFlags: new Set(flags) },
    });
    assert.equal(result.selected, 'engine');
    assert.equal(result.ok, flags.includes('--permission') && flags.includes('--allow-net'));
    assert.ok(result.lines.some(line => line.startsWith('node      ')));
    assert.equal(result.lines.some(line => line.startsWith('worker    ')), false);
  }
});

for (const flags of [[], ['--permission'], ['--allow-net']]) {
  test(`missing worker flags refuse own diagnosis even with a cached helper: ${flags.join(',') || 'none'}`, () => {
    const result = section({ env: { SLEIGHT_RUNTIME: 'own' },
      selectNode: () => undefined,
      node: { execPath: '/fixture/bundled-node', version: 'v24.0.0', allowedNodeEnvironmentFlags: new Set(flags) },
      buildState: () => ({ build, status: 'compiled (fake)' }) });
    assert.equal(result.ok, false);
    assert.match(result.lines.join('\n'), /node      \/fixture\/bundled-node/);
    assert.match(result.lines.join('\n'), /worker    unavailable.*REPL_NODE_UNSUPPORTED/);
  });
}

test('doctor names the fallback Node and never probes for the engine', () => {
  const fallback = section({ env: { SLEIGHT_RUNTIME: 'own' },
    selectNode: () => ({ execPath: '/fixture/path-node', version: 'v26.12.1' }) });
  assert.equal(fallback.ok, true);
  assert.match(fallback.lines.join('\n'), /worker    ready \(\/fixture\/path-node; v26.12.1;/);
  section({ selectNode: () => assert.fail('engine must not probe') });
});

test('GL2B doctor worker line includes candidate refusal reasons even when a later Node qualifies', () => {
  for (const ready of [false, true]) {
    const selectNode = Object.assign(() => ready ? { execPath: '/fixture/good-node', version: 'v26.0.0' } : undefined,
      { refusals: [{ path: '/fixture/bin/node', reason: 'mode' }],
        lastRefusal: { path: '/fixture/bin/node', reason: 'mode' } });
    const result = section({ env: { SLEIGHT_RUNTIME: 'own' }, selectNode });
    const line = result.lines.find(line => line.startsWith('worker    '));
    assert.match(line, /\/fixture\/bin\/node: mode/);
    assert.ok(line.length < 700);
  }
});

test('selection defaults to engine; own is explicit; invalid settings refuse without inspection', () => {
  assert.equal(section().selected, 'engine');
  assert.equal(section({ env: { SLEIGHT_RUNTIME: 'engine' } }).selected, 'engine');
  const own = section({ env: { SLEIGHT_RUNTIME: 'own' } });
  assert.equal(own.ok, true);
  assert.match(own.lines.join('\n'), /own \(SLEIGHT_RUNTIME=own\)/);
  assert.match(own.lines.join('\n'), /Accessibility: granted; Screen Recording: not granted/);
  for (const value of ['', 'OWN', 'other', 'secret\nvalue']) {
    const result = section({ env: { SLEIGHT_RUNTIME: value }, buildState: () => assert.fail('must not inspect') });
    assert.equal(result.ok, false);
    assert.equal(result.selected, 'invalid');
    assert.doesNotMatch(result.lines.join('\n'), /secret/);
  }
});

test('unavailable platform never inspects the Mac build', () => {
  assert.equal(section({ platform: 'linux', buildState: () => assert.fail('must not inspect') }).ok, false);
});

test('source failure and missing compilers fail; matching cached build needs no compiler', () => {
  assert.equal(section({ buildState: () => ({ build: null, status: 'source unreadable' }) }).ok, false);
  assert.equal(section({ compilerState: () => 'not found' }).ok, false);
  assert.equal(section({ compilerState: () => 'not found', buildState: () => ({ build, status: 'compiled (fake)' }) }).ok, true);
});

test('compiler discovery uses selected developer files and never runs a command', () => {
  const calls = [];
  assert.match(runtimeCompilerState({ io: {
    realpathSync(path) { calls.push(path); return '/fixture/Developer'; },
    statSync(path) { calls.push(path); return { isFile: () => path.startsWith('/fixture/Developer/usr/bin/') }; },
  } }), /^found/);
  assert.ok(calls.includes('/fixture/Developer/usr/bin/swiftc'));
  assert.ok(calls.includes('/fixture/Developer/usr/bin/clang'));
});

test('compiler discovery requires both Swift and Clang and handles missing selection', () => {
  assert.match(runtimeCompilerState({ io: {
    realpathSync() { throw Error('no selection'); },
    statSync(path) { return { isFile: () => path.endsWith('/swiftc') }; },
  } }), /^not found/);
});

test('build diagnosis hashes the same assembled source and peer as first-use compilation', t => {
  const cacheRoot = bank(t), hashes = { 'peer-host.c': digest(peer()), 'glide-engine.swift': digest(source()) };
  const directory = join(cacheRoot, helperBuildKey(hashes));
  const options = { source, peer, cacheRoot };
  assert.deepEqual(runtimeBuildState(options), { build, status: 'not compiled for this source' });
  mkdirSync(directory, { mode: 0o700 });
  const binaries = { 'peer-host': 'peer binary', 'glide-engine': 'driver binary' };
  for (const [name, bytes] of Object.entries(binaries)) writeFileSync(join(directory, name), bytes, { mode: 0o700 });
  const record = { protocol: 1, arch: process.arch, sources: hashes, recipes: helperBuildRecipes(hashes),
    binaries: Object.fromEntries(Object.entries(binaries).map(([name, bytes]) => [name, digest(bytes)])) };
  const save = () => writeFileSync(join(directory, 'build.json'), JSON.stringify(record), { mode: 0o600 });
  save();
  assert.match(runtimeBuildState(options).status, /^compiled/);
  for (const recipes of [undefined, {}]) {
    record.recipes = recipes; save();
    assert.equal(runtimeBuildState(options).status, 'cached build invalid or unreadable');
  }
  record.recipes = helperBuildRecipes(hashes); save();

  writeFileSync(join(directory, 'glide-engine'), 'tampered');
  assert.equal(runtimeBuildState(options).status, 'cached build invalid or unreadable');
  writeFileSync(join(directory, 'glide-engine'), binaries['glide-engine']);
  record.arch = 'other'; save();
  assert.equal(runtimeBuildState(options).status, 'cached build invalid or unreadable');
  record.arch = process.arch; record.sources['peer-host.c'] = '0'.repeat(64); save();
  assert.equal(runtimeBuildState(options).status, 'cached build invalid or unreadable');
});

test('a linked binary cannot count as a compiled build', t => {
  const cacheRoot = bank(t), hashes = { 'peer-host.c': digest(peer()), 'glide-engine.swift': digest(source()) };
  const directory = join(cacheRoot, helperBuildKey(hashes));
  mkdirSync(directory);
  const target = join(cacheRoot, 'target'); writeFileSync(target, 'bytes', { mode: 0o700 });
  for (const name of ['peer-host', 'glide-engine']) symlinkSync(target, join(directory, name));
  writeFileSync(join(directory, 'build.json'), JSON.stringify({ protocol: 1, arch: process.arch, sources: hashes, recipes: helperBuildRecipes(hashes),
    binaries: { 'peer-host': digest('bytes'), 'glide-engine': digest('bytes') } }), { mode: 0o600 });
  assert.equal(runtimeBuildState({ source, peer, cacheRoot }).status, 'cached build invalid or unreadable');
});

test('missing or malformed source has no invented hash', () => {
  assert.deepEqual(runtimeBuildState({ source: () => { throw Error('missing'); } }), { build: null, status: 'source unreadable' });
  assert.equal(runtimeBuildState({ source: () => 'invalid' }).build, null);
});

test('last probe reports counts and compares source receipts, not the executable hash', t => {
  const directory = bank(t), path = join(directory, 'runtime-probe-first.json');
  writeFileSync(path, JSON.stringify(report()));
  const line = runtimeLastProbe({ directory, build });
  assert.match(line, /2026-10-31T20:00:00.000Z: step1: mechanisms-pass; 1\/2 cells passed; cleanup confirmed; current source; saved result only/);
  assert.match(runtimeLastProbe({ directory, build: 'c'.repeat(64) }), /different or unknown source/);
});

test('newest invalid report cannot be replaced by an older passing report', t => {
  const directory = bank(t), old = join(directory, 'runtime-probe-old.json'), latest = join(directory, 'runtime-probe-new.json');
  writeFileSync(old, JSON.stringify(report())); utimesSync(old, 1, 1);
  writeFileSync(latest, '{invalid');
  assert.match(runtimeLastProbe({ directory, build }), /^latest saved report invalid/);
});

test('stopped, sitting and unconfirmed-cleanup probes remain labelled saved observations', t => {
  const directory = bank(t), path = join(directory, 'runtime-probe.json');
  for (const verdict of ['step1: stopped', 'step1: sitting-not-qualification', 'step1: stop-program', 'step1: diagnose-and-fix']) {
    const data = report(); data.verdict.verdict = verdict; data.cleanupConfirmed = false;
    writeFileSync(path, JSON.stringify(data));
    const line = runtimeLastProbe({ directory, build });
    assert.ok(line.includes(verdict)); assert.match(line, /cleanup unconfirmed/); assert.match(line, /saved result only/);
  }
});

test('unrelated JSON and linked reports are not read', t => {
  const directory = bank(t), target = join(directory, 'private.json');
  writeFileSync(target, JSON.stringify(report()));
  symlinkSync(target, join(directory, 'runtime-probe-link.json'));
  assert.match(runtimeLastProbe({ directory }), /^none saved/);
  assert.match(runtimeLastProbe({ directory: join(directory, 'absent') }), /^none saved/);
  const link = join(directory, 'linked'); symlinkSync(directory, link);
  assert.match(runtimeLastProbe({ directory: link }), /folder is linked/);
});

test('invalid probe values never print arbitrary report content', t => {
  const directory = bank(t), path = join(directory, 'runtime-probe.json');
  for (const extra of [{ schema: 'other' }, { runtime: 'engine' }, { dryRun: true }, { finishedAt: null },
    { finishedAt: 'not a date' }, { cells: [null] }, { verdict: { verdict: 'PRIVATE CONTENT\npass' } }]) {
    writeFileSync(path, JSON.stringify({ ...report(), ...extra }));
    const line = runtimeLastProbe({ directory, build });
    assert.match(line, /invalid or unreadable/); assert.doesNotMatch(line, /PRIVATE CONTENT/);
  }
});

test('oversized probe report is refused before reading bytes', () => {
  let reads = 0;
  assert.match(runtimeLastProbe({ directory: '/fixture', io: {
    realpathSync: path => path, readdirSync: () => ['runtime-probe.json'],
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 16 * 1024 * 1024 + 1, mtimeMs: 1 }),
    readFileSync: () => { reads++; throw Error('must not read'); },
  } }), /invalid or unreadable/);
  assert.equal(reads, 0);
});

for (const setting of ['own', 'invalid']) test(`doctor ${setting} returns before all engine or host probes`, async () => {
  const lines = [], forbidden = () => assert.fail('offline runtime doctor must not call another section or launch path');
  const code = await doctor({ ...offlineDoctor, env: { SLEIGHT_RUNTIME: setting }, platform: 'darwin', app: 'Fixture',
    runtime: options => section(options), log: line => lines.push(line), documentation: forbidden,
    turbo: forbidden, hand: forbidden, permissions: forbidden, settings: forbidden, codex: forbidden,
    cursor: forbidden, grok: forbidden, grokbot: forbidden, launchctlList: forbidden, forbiddenTargets: forbidden });
  assert.equal(code, setting === 'own' ? 0 : 1);
  assert.match(lines.join('\n'), /runtime \(opt-in preview\)/);
  assert.doesNotMatch(lines.join('\n'), /live read/);
});

const restore = { pid: 42, processStart: '1.2', bundleId: 'test.fixture', attribute: 'AXManualAccessibility', original: false };
const recordName = row => `renderer-${row.pid}-${row.processStart}-${row.attribute}.json`;
const saveRestore = (directory, row = restore) => {
  const path = join(directory, recordName(row));
  writeFileSync(path, JSON.stringify(row), { mode: 0o600 });
  return path;
};

for (const [reason, text] of [['assistive-technology-running', 'assistive technology running'],
  ['value-changed-since', 'value changed since'], ['identity-changed', 'identity changed'], ['lease-unavailable', 'lease unavailable'],
  ['recovery-disabled', 'automatic recovery disabled']]) {
  test(`offline renderer diagnosis reports saved ${reason} without live inspection`, t => {
    const directory = bank(t);
    saveRestore(directory, { ...restore, recoveryReason: reason });
    const line = runtimeRendererRecords({ directory });
    assert.ok(line.includes(`last recovery: ${text}`));
    assert.ok(line.includes('current value not inspected'));
    assert.ok(line.includes('the app may still carry this enabled attribute'));
    assert.ok(line.includes('automatic recovery leaves it unchanged'));
    assert.ok(line.includes('quitting the app clears it'));
    assert.ok(line.includes('if the recorded process already exited, nothing remains'));
  });
}

test('offline renderer reasons accept only fixed strings', t => {
  for (const recoveryReason of [null, true, ['identity-changed'], {}, 'PRIVATE CONTENT\nidentity changed', 'other']) {
    const directory = bank(t);
    saveRestore(directory, { ...restore, recoveryReason });
    const line = runtimeRendererRecords({ directory });
    assert.match(line, /^0 record\(s\); 1 invalid/);
    assert.doesNotMatch(line, /PRIVATE CONTENT/);
  }
});

test('renderer diagnosis names each saved record and its pending reason without inspecting an app', t => {
  const directory = bank(t);
  saveRestore(directory);
  saveRestore(directory, { ...restore, pid: 77, bundleId: 'test.other', attribute: 'AXEnhancedUserInterface' });
  const line = runtimeRendererRecords({ directory });
  assert.match(line, /^2 record\(s\):/);
  assert.match(line, /test.fixture pid 42 start 1.2 AXManualAccessibility: pending/);
  assert.match(line, /test.other pid 77 start 1.2 AXEnhancedUserInterface: pending/);
  assert.match(line, /current value not inspected/);
  assert.equal(line.split('quitting the app clears it').length - 1, 2);
  assert.equal(line.split('the app may still carry this enabled attribute').length - 1, 2);
  const result = section({ rendererRecords: () => line });
  assert.equal(result.lines.filter(row => row.startsWith('renderer  ')).length, 1);
  assert.ok(result.lines.includes('renderer  ' + line));
});

test('renderer diagnosis accepts RTW2B bundleID records while new records use bundleId', t => {
  const directory = bank(t), { bundleId, ...row } = restore;
  saveRestore(directory, { ...row, bundleID: bundleId });
  assert.match(runtimeRendererRecords({ directory }), /^1 record\(s\): test.fixture pid 42/);
});

test('renderer diagnosis is inert with absent files and excludes unrelated or quarantined data', t => {
  const directory = bank(t);
  writeFileSync(join(directory, '.quarantine-fixture'), 'PRIVATE CONTENT');
  writeFileSync(join(directory, 'unrelated.json'), 'PRIVATE CONTENT');
  assert.equal(runtimeRendererRecords({ directory }), '0 record(s)');
  assert.equal(runtimeRendererRecords({ directory: join(directory, 'absent') }), '0 record(s)');
});

test('renderer diagnosis refuses links, hardlinks, public modes and invalid content without printing it', t => {
  for (const kind of ['symlink', 'hardlink', 'mode', 'oversize', 'bad-json', 'bad-bundle', 'extra', 'name-mismatch', 'both-keys']) {
    const directory = bank(t), path = saveRestore(directory);
    if (kind === 'symlink') {
      rmSync(path); writeFileSync(join(directory, 'target'), 'PRIVATE CONTENT');
      symlinkSync(join(directory, 'target'), path);
    } else if (kind === 'hardlink') linkSync(path, join(directory, 'target'));
    else if (kind === 'mode') chmodSync(path, 0o644);
    else if (kind === 'oversize') writeFileSync(path, 'PRIVATE CONTENT'.repeat(100));
    else if (kind === 'bad-json') writeFileSync(path, '{PRIVATE CONTENT');
    else writeFileSync(path, JSON.stringify({ ...restore, ...kind === 'bad-bundle' ? { bundleId: 'test.fixture\n' } :
      kind === 'extra' ? { title: 'PRIVATE CONTENT' } : kind === 'both-keys' ? { bundleID: 'PRIVATE CONTENT' } : { pid: 77 } }));
    const line = runtimeRendererRecords({ directory });
    assert.match(line, /^0 record\(s\); 1 invalid or unreadable record\(s\)/, kind);
    assert.doesNotMatch(line, /PRIVATE CONTENT/);
    assert.ok(readFileSync(path).length > 0);
  }
});

test('renderer diagnosis refuses linked or public record directories', t => {
  const root = bank(t), directory = join(root, 'records'), linked = join(root, 'linked');
  mkdirSync(directory, { mode: 0o700 }); saveRestore(directory); symlinkSync(directory, linked);
  assert.match(runtimeRendererRecords({ directory: linked }), /folder is linked/);
  chmodSync(directory, 0o755);
  assert.match(runtimeRendererRecords({ directory }), /folder permissions/);
});

test('renderer diagnosis never prepares, spawns, runs recovery or inspects live processes', t => {
  const directory = bank(t); saveRestore(directory);
  const calls = [];
  const io = new Proxy({ realpathSync, lstatSync, readdirSync, openSync, fstatSync, readSync, closeSync }, {
    get(target, name) { assert.ok(Object.hasOwn(target, name), `unexpected capability ${String(name)}`);
      return (...args) => { calls.push(name); return target[name](...args); }; },
  });
  assert.match(runtimeRendererRecords({ directory, io }), /^1 record/);
  assert.ok(calls.includes('readSync')); assert.ok(calls.includes('closeSync'));
});


import { ordinary, handInventory, helperSourceHashes } from '../plugins/sleight/lib/direct-browser/host-cache.mjs';
import { cachedSettingsHelper } from '../plugins/sleight/lib/sealed-settings.mjs';
import { prepareConfirmHost } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { EventEmitter } from 'node:events';

test('GL1A 4: a symlinked glide-engine never supplies bytes for a build receipt', t => {
  const root = bank(t), target = join(root, 'ordinary'), link = join(root, 'glide-engine');
  writeFileSync(target, 'driver bytes', { mode: 0o700 });
  symlinkSync(target, link);
  assert.throws(() => ordinary(link, 0o700), /HOST_PACKAGE_MISMATCH/);
});

test('GL1A 13: a Glide build cannot supply the settings helper or confirmation host', { skip: process.platform !== 'darwin' }, async t => {
  const root = bank(t), sourceRoot = join(root, 'lib/direct-browser/native'), cacheRoot = join(root, 'cache/turbo-host');
  mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'lib/mac-driver/native'), { recursive: true, mode: 0o700 });
  for (const name of ['peer-host.c', 'consent-host.swift']) writeFileSync(join(sourceRoot, name), '// source\n', { mode: 0o600 });
  writeFileSync(join(root, 'lib/mac-driver/native/SealedSettings.swift'), '// seal\n', { mode: 0o600 });
  const hashes = helperSourceHashes(handInventory(sourceRoot)), directory = join(cacheRoot, helperBuildKey(hashes));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const name of ['glide-engine', 'consent-host', 'peer-host']) writeFileSync(join(directory, name), 'binary', { mode: 0o700 });
  writeFileSync(join(directory, 'build.json'), JSON.stringify({ protocol: 1, arch: process.arch, sources: hashes, recipes: helperBuildRecipes(hashes),
    binaries: { 'glide-engine': digest('binary'), 'peer-host': digest('binary') } }), { mode: 0o600 });
  assert.throws(() => cachedSettingsHelper({ sourceRoot, cacheRoot }), /HELPER_UNTRUSTED/);
  // The ordinary confirmation builder ignores the driver bank, even if it carries matching hashes.
  const driverBank = join(cacheRoot, 'mac-driver', helperBuildKey(hashes));
  mkdirSync(driverBank, { recursive: true, mode: 0o700 });
  let spawned;
  const host = await prepareConfirmHost({ sourceRoot, cacheRoot, tools: async () => true,
    compile: async ({ binary, name }) => writeFileSync(binary, 'compiled ' + name, { mode: 0o700 }),
    run(file) { spawned = file; const child = new EventEmitter(); setImmediate(() => child.emit('exit', 0)); return child; } });
  assert.equal(host.status, 'ready');
  const child = host.spawn('turbo-on', 'Google Chrome');
  await new Promise(resolve => child.once('exit', resolve));
  assert.equal(spawned.includes('/mac-driver/'), false);
  assert.match(spawned, /\/run-[^/]+\/consent-host$/);
});


test('CP1A2 doctor names the consent recipe for the next launch without claiming a live switch', () => {
  for (const recipe of ['default', 'optimized', 'not built']) {
    assert.ok(section({ consentRecipe: () => recipe }).lines.includes(`consent   ${recipe} recipe for next host launch (running host unchanged)`));
  }
});
