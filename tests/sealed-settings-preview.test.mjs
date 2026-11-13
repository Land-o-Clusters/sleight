import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import * as seals from '../plugins/sleight/lib/sealed-settings.mjs';
import { shimText } from '../plugins/sleight/lib/settings-link.mjs';
import { verifyScheduledSettings } from '../plugins/sleight/lib/routine-launcher.mjs';
import { loadPreapproved, livePreapproved, PreapprovedApps } from '../plugins/sleight/lib/preapproved.mjs';
import { RoutineStore } from '../plugins/sleight/lib/routines.mjs';
import { readPermissions, createPermissionCheck } from '../plugins/sleight/lib/permissions.mjs';
import { readInstalledConfigFile } from '../plugins/sleight/lib/direct-browser/installed-config.mjs';
import { readHandConfig } from '../plugins/sleight/lib/hand/settings.mjs';
import * as oldPreapproved from './fixtures/sealed-settings-int22/preapproved.mjs';
import * as oldPermissions from './fixtures/sealed-settings-int22/permissions.mjs';
import * as oldInstalled from './fixtures/sealed-settings-int22/installed-config.mjs';
import * as oldHand from './fixtures/sealed-settings-int22/hand-settings.mjs';
import { readOwner, liveOtherOwner } from '../plugins/sleight/lib/direct-browser/turbo-setup.mjs';
import { readAppOptIns } from '../plugins/sleight/lib/direct-browser/electron-config.mjs';
import { createGrantStore } from '../plugins/sleight/lib/direct-browser/electron-consent.mjs';
import { WatchStore } from '../plugins/sleight/lib/watches.mjs';
import * as oldTurbo from './fixtures/sealed-settings-int22/turbo-setup.mjs';
import * as oldApps from './fixtures/sealed-settings-int22/electron-config.mjs';
import * as oldGrants from './fixtures/sealed-settings-int22/electron-consent.mjs';
import * as oldRoutines from './fixtures/sealed-settings-int22/routines.mjs';
import * as oldWatches from './fixtures/sealed-settings-int22/watches.mjs';


test('1.6.0 pins sealed settings enforcement off', () => {
  assert.equal(seals.SETTINGS_BUILD_POLICY.enforce, false);
  assert.equal(seals.SETTINGS_BUILD_POLICY.team, null);
  assert.equal(Object.isFrozen(seals.SETTINGS_BUILD_POLICY), true);
});

test('preview readers spawn zero helpers and perform only the legacy read', t => {
  const root = fs.realpathSync(trackTemp(fs.mkdtempSync(join(tmpdir(), 'sleight-seal-preview-'))));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'permissions.json');
  fs.writeFileSync(file, '{"version":1,"apps":[],"sites":[]}', { mode: 0o600 });
  const counts = { lstat: 0, read: 0, helper: 0, spawn: 0, root: 0 };
  const lstat = fs.lstatSync, read = fs.readFileSync;
  t.mock.method(fs, 'lstatSync', (...args) => { counts.lstat++; return lstat(...args); });
  t.mock.method(fs, 'readFileSync', (...args) => { counts.read++; return read(...args); });
  t.mock.method(childProcess, 'spawnSync', () => { counts.spawn++; throw Error('unexpected spawn'); });
  syncBuiltinESMExports();
  try {
    const options = { get root() { counts.root++; return root; }, verify() {
      counts.helper++;
      return { enforcing: false, get: name => ({ file: name, state: 'unsealed' }) };
    } };
    assert.equal(seals.readSettingsBytes(file, undefined, options), read(file, 'utf8'));
    assert.equal(seals.settingsFilePresent(file, options), true);
    assert.equal(seals.observeSettingsFile(file, options), undefined);
    assert.deepEqual(counts, { lstat: 0, read: 1, helper: 0, spawn: 0, root: 0 });
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('preview doctor invokes one fake helper and reports every verdict without an unavailable command', () => {
  let calls = 0;
  const states = ['unsealed', 'tampered', 'stale', 'unsafe'];
  const line = seals.settingsSealDoctorLine({ verify: () => seals.verifySettings({
    proveHelper: () => ({ signed: false }), helper: () => {
      calls++;
      return { enforcement: false, stdout: seals.SEALED_SETTINGS_FILES.map((file, i) =>
        JSON.stringify({ file, state: states[i % states.length] })).join('\n') };
    },
  }) });
  assert.equal(calls, 1);
  for (const state of states) assert.ok(line.includes(state));
  assert.match(line, /adoption comes with the signed release/);
  assert.doesNotMatch(line, /sleight-mcp settings (adopt|repair)/);
});

test('preview shim contains no seal-module import or helper verification', () => {
  const text = shimText('/fixture/plugin', '/fixture/home');
  assert.doesNotMatch(text, /import\(|sealed-settings|observeSettingsFile|pathToFileURL/);
  assert.match(text, /shim integrity check failed/);
});

test('preview scheduled ticks load no seal module and launch no verifier', async () => {
  let loads = 0, helpers = 0;
  await verifyScheduledSettings('/fixture/plugin/bin/sleight-mcp', '/fixture/home', 'a'.repeat(20), 'watch', {
    load: async () => { loads++; return { SETTINGS_BUILD_POLICY: { enforce: false },
      verifySettings() { helpers++; return { enforcing: false, entries: () => [] }; } }; },
  });
  assert.equal(loads, 0);
  assert.equal(helpers, 0);
});

test('preview native menu and launchd notes defer adoption to the signed release', () => {
  const source = fs.readFileSync(new URL('../plugins/sleight/lib/mac-driver/native/SealedSettings.swift', import.meta.url), 'utf8');
  const menu = source.slice(source.indexOf('func settingsMenuSealLine()'));
  assert.doesNotMatch(menu, /run sleight-mcp settings/);
  assert.match(menu, /adoption comes with the signed release/);
  assert.ok(menu.indexOf('if !settingsEnforcementRequested()') < menu.indexOf('settingsAccountHome()'));
  assert.match(seals.settingsSealNote({ file: 'permissions.json', state: 'tampered' }), /adoption comes with the signed release/);
});

test('preview adapters match int22 filesystem calls and spawn zero helpers', async t => {
  const home = fs.realpathSync(trackTemp(fs.mkdtempSync(join(tmpdir(), 'sleight-seal-adapters-'))));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'Library/Application Support/sleight');
  fs.mkdirSync(root, { mode: 0o700, recursive: true });
  for (const [file, data] of Object.entries({
    'preapproved.json': { version: 1, apps: [] }, 'permissions.json': { version: 1, apps: [], sites: [] },
    'turbo.json': { version: 1, enabled: false }, 'hand.json': { version: 1, enabled: false },
    'turbo-owner.json': { version: 1, sleight: null, pluginRoot: '/fixture/plugin', sha256: 'a'.repeat(64) },
    'turbo-apps.json': { version: 1, apps: {} }, 'electron-grants.json': { version: 2, grants: [] },
  })) fs.writeFileSync(join(root, file), JSON.stringify(data), { mode: 0o600 });
  const step = code => ({ tool: 'js', args: { code }, positions: [] });
  const script = { sleightReplay: 1, steps: [step('let app = await cua.getApp("com.apple.calculator");'),
    step('await app.click({"id":"Seven"});')] };
  const routine = new RoutineStore({ home }).plan(script, '15m');
  fs.mkdirSync(routine.directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(routine.directory, 'routine.json'), JSON.stringify({ seconds: 900 }), { mode: 0o600 });
  fs.writeFileSync(join(routine.directory, 'script.json'), JSON.stringify(script), { mode: 0o600 });
  const watchId = 'a'.repeat(20), watchDirectory = join(root, 'watches', watchId);
  fs.mkdirSync(watchDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(join(watchDirectory, 'state.json'), JSON.stringify({ matched: true, at: '2026-11-01T00:00:00.000Z' }), { mode: 0o600 });
  const user = os.userInfo(), calls = [];
  t.mock.method(os, 'userInfo', () => ({ ...user, homedir: home }));
  for (const name of ['lstatSync', 'realpathSync', 'openSync', 'fstatSync', 'readFileSync', 'closeSync', 'existsSync', 'readdirSync']) {
    const original = fs[name];
    t.mock.method(fs, name, (...args) => { calls.push([name, typeof args[0] === 'number' ? '<fd>' : args[0], ...args.slice(1)]); return original(...args); });
  }
  let spawns = 0;
  t.mock.method(childProcess, 'spawnSync', () => { spawns++; throw Error('unexpected spawn'); });
  syncBuiltinESMExports();
  try {
    const live = module => {
      const view = module.livePreapproved(module.loadPreapproved());
      return [view.size, view.list(), view.allows('com.apple.calculator', 'low')];
    };
    const permissionWatch = module => {
      const view = module.createPermissionCheck({ path: join(root, 'permissions.json') });
      return [view.state(), view.app({ bundleId: 'com.apple.calculator' }), view.sitesLimited()];
    };
    const watchNotes = Store => {
      const store = new Store({ home });
      store.list = () => [{ id: watchId, directory: watchDirectory, paused: false }];
      return store.notes();
    };
    const adapters = [
      ['loadPreapproved', () => loadPreapproved().size, () => oldPreapproved.loadPreapproved().size],
      ['readPermissions', () => readPermissions(join(root, 'permissions.json')), () => oldPermissions.readPermissions(join(root, 'permissions.json'))],
      ['readInstalledConfigFile', () => readInstalledConfigFile(join(root, 'turbo.json')), () => oldInstalled.readInstalledConfigFile(join(root, 'turbo.json'))],
      ['readHandConfig', () => readHandConfig(join(root, 'hand.json')), () => oldHand.readHandConfig(join(root, 'hand.json'))],
      ['livePreapproved', () => live({ livePreapproved, loadPreapproved }), () => live(oldPreapproved)],
      ['createPermissionCheck', () => permissionWatch({ createPermissionCheck }), () => permissionWatch(oldPermissions)],
      ['readOwner', () => readOwner(join(root, 'turbo.json')), () => oldTurbo.readOwner(join(root, 'turbo.json'))],
      ['readAppOptIns', () => readAppOptIns(join(root, 'turbo-apps.json')), () => oldApps.readAppOptIns(join(root, 'turbo-apps.json'))],
      ['createGrantStore', () => createGrantStore({ path: join(root, 'electron-grants.json') }).list(), () => oldGrants.createGrantStore({ path: join(root, 'electron-grants.json') }).list()],
      ['RoutineStore.load', () => new RoutineStore({ home }).load(routine.id), () => new oldRoutines.RoutineStore({ home }).load(routine.id)],
      ['WatchStore.notes', () => watchNotes(WatchStore), () => watchNotes(oldWatches.WatchStore)],
    ];
    assert.equal(adapters.length, 11);
    for (const [name, current, previous] of adapters) await t.test(name, () => {
      calls.length = 0; const expected = previous(), before = [...calls];
      calls.length = 0; const actual = current();
      assert.deepEqual(actual, expected);
      assert.deepEqual([...calls], before, name);
    });
    assert.equal(spawns, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('an installed preview launcher skips verifier loading and enforcement refuses preview or load failure', async t => {
  const home = fs.realpathSync(trackTemp(fs.mkdtempSync(join(tmpdir(), 'sleight-seal-install-'))));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let loads = 0, bootstraps = 0;
  const store = new RoutineStore({ home, confirm: async () => true, launchctl: async () => { bootstraps++; },
    preapproved: () => new PreapprovedApps({ version: 1, apps: [{ app: 'com.apple.calculator', riskLevel: 'medium' }] }),
  });
  const step = code => ({ tool: 'js', args: { code }, positions: [] });
  const plan = await store.add({ sleightReplay: 1, steps: [step('let app = await cua.getApp("com.apple.calculator");'),
    step('await app.click({"id":"Seven"});')] }, '15m');
  const installed = await import(pathToFileURL(plan.launcherPath).href);
  await installed.verifyScheduledSettings('/fixture/bin/sleight-mcp', home, plan.id, 'routine', {
    load: async () => { loads++; throw Error('unexpected verifier import'); },
  });
  assert.equal(bootstraps, 1);
  assert.equal(loads, 0);
  await assert.rejects(verifyScheduledSettings('/fixture/bin/sleight-mcp', '/fixture/home', 'a'.repeat(20), 'routine', {
    enforce: true, load: async () => ({ verifySettings: () => ({ enforcing: false }) }),
  }), /SETTINGS_UNTRUSTED/);
  await assert.rejects(verifyScheduledSettings('/fixture/bin/sleight-mcp', '/fixture/home', 'a'.repeat(20), 'routine', {
    enforce: true, load: async () => { throw Error('module unavailable'); },
  }), /SETTINGS_UNTRUSTED/);
});

test('all preview settings names, including routine and watch JSON, leave no I4 note or verifier call', () => {
  const root = join(tmpdir(), 'sleight-preview-virtual'), id = 'a'.repeat(20);
  let calls = 0;
  const options = { root, verify: () => { calls++; throw Error('unexpected helper'); } };
  for (const file of [...seals.SEALED_SETTINGS_FILES, `routines/${id}/script.json`, `watches/${id}/state.json`]) {
    assert.equal(seals.observeSettingsFile(join(root, file), options), undefined);
  }
  assert.equal(calls, 0);
  assert.deepEqual(seals.takeSettingsSealNotes(), []);
});


test('approval polling also catches identity and permission changes without an extra stat', t => {
  const initial = new PreapprovedApps({ version: 1, apps: [] });
  let stat = { dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5, mode: 0o600, uid: 6, nlink: 1 };
  let grants = 0, permissions = 0, stats = 0;
  t.mock.method(fs, 'lstatSync', () => { stats++; return stat; });
  syncBuiltinESMExports();
  try {
    const live = livePreapproved(initial, { load: () => { grants++; return initial; } });
    const check = createPermissionCheck({ read: () => { permissions++; return { state: 'ok', apps: [], sites: [] }; } });
    stats = 0; // Count polling separately from each reader's initial fingerprint.
    const poll = () => { live.list(); check.state(); };
    poll(); assert.equal(stats, 2);
    for (const key of ['dev', 'ctimeMs', 'mode', 'uid', 'nlink']) { stat = { ...stat, [key]: stat[key] + 1 }; poll(); }
    assert.equal(grants, 5); assert.equal(permissions, 6); assert.equal(stats, 12);
    for (const key of ['ino', 'size', 'mtimeMs']) { stat = { ...stat, [key]: stat[key] + 1 }; poll(); }
    assert.equal(grants, 8); assert.equal(permissions, 9); assert.equal(stats, 18);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('installer refuses missing or duplicate policy markers before launchctl', async t => {
  const original = fs.readFileSync;
  for (const marker of ['', '/* settings build policy */ false\n/* settings build policy */ false']) {
    const home = fs.realpathSync(trackTemp(fs.mkdtempSync(join(tmpdir(), 'sleight-stamp-refuse-'))));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const commands = [];
    const store = new RoutineStore({ home, launchctl: async args => commands.push(args) });
    const script = { sleightReplay: 1, steps: [{ tool: 'js', args: { code: 'let app = await cua.getApp("com.apple.calculator");' }, positions: [] }] };
    const plan = store.plan(script, '15m');
    t.mock.method(fs, 'readFileSync', (path, ...args) => String(path).endsWith('/lib/routine-launcher.mjs') ? marker : original(path, ...args));
    syncBuiltinESMExports();
    try {
      await assert.rejects(store.install(plan, script, {}), /settings build policy marker/);
      assert.deepEqual(commands, []);
      assert.equal(fs.existsSync(plan.launcherPath), false);
      assert.equal(fs.existsSync(plan.directory), false);
    } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  }
});

test('an installed enforced launcher verifies by its stamped default and refuses preview', async t => {
  const home = fs.realpathSync(trackTemp(fs.mkdtempSync(join(tmpdir(), 'sleight-stamp-enforced-'))));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const origin = new URL('../plugins/sleight/lib/routines.mjs', import.meta.url);
  // Inject build policy in a private module copy. Production installers take no policy override.
  let source = fs.readFileSync(origin, 'utf8').replace(', SETTINGS_BUILD_POLICY }', ' }');
  source = source.replace(/from '(\.[^']+)'/g, (_, specifier) => `from '${new URL(specifier, origin).href}'`);
  source += '\nconst SETTINGS_BUILD_POLICY = Object.freeze({ enforce: true });\n';
  fs.copyFileSync(new URL('../plugins/sleight/lib/routine-launcher.mjs', import.meta.url), join(home, 'routine-launcher.mjs'));
  const modulePath = join(home, 'enforced-installer.mjs'); fs.writeFileSync(modulePath, source);
  const { RoutineStore: EnforcedStore } = await import(pathToFileURL(modulePath).href);
  let bootstraps = 0, loads = 0;
  const store = new EnforcedStore({ home, launchctl: async () => { bootstraps++; } });
  const script = { sleightReplay: 1, steps: [{ tool: 'js', args: { code: 'let app = await cua.getApp("com.apple.calculator");' }, positions: [] }] };
  const plan = await store.install(store.plan(script, '15m'), script, {});
  const installed = await import(pathToFileURL(plan.launcherPath).href);
  assert.equal(bootstraps, 1);
  await assert.rejects(installed.verifyScheduledSettings('/fixture/bin/sleight-mcp', home, plan.id, 'routine', {
    load: async () => { loads++; return { verifySettings: () => ({ enforcing: false }) }; },
  }), /SETTINGS_UNTRUSTED/);
  assert.equal(loads, 1);
  await installed.verifyScheduledSettings('/fixture/bin/sleight-mcp', home, plan.id, 'routine', {
    load: async () => ({ verifySettings: () => ({ enforcing: true, entries: () => [], get: file => ({ file, state: 'trusted' }) }) }),
  });
});


test('enforced I4, doctor and menu advice no longer describes a future signed release', async t => {
  const row = { file: 'permissions.json', state: 'tampered' };
  const note = seals.settingsSealNote(row, { enforce: true });
  assert.match(note, /settings untrusted/);
  assert.doesNotMatch(note, /adoption comes/);
  const line = seals.settingsSealDoctorLine({ verify: () => ({ enforcing: true, entries: () => [row] }) });
  assert.match(line, /enforced.*settings untrusted/);
  assert.doesNotMatch(line, /adoption comes/);
  const home = fs.realpathSync(trackTemp(fs.mkdtempSync(join(tmpdir(), 'sleight-seal-advice-'))));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const origin = new URL('../plugins/sleight/lib/sealed-settings.mjs', import.meta.url);
  const policyURL = new URL('../plugins/sleight/lib/settings-build-policy.mjs', import.meta.url);
  const policySource = fs.readFileSync(policyURL, 'utf8');
  assert.equal(policySource.split('enforce: false').length, 2, 'the fixture must enable the actual build policy');
  const policyFixture = 'data:text/javascript;base64,' + Buffer.from(policySource.replace('enforce: false', 'enforce: true')).toString('base64');
  const policyImport = "from './settings-build-policy.mjs'";
  let source = fs.readFileSync(origin, 'utf8');
  assert.equal(source.split(policyImport).length, 2);
  source = source.replace(policyImport, `from '${policyFixture}'`);
  source = source.replace(/from '(\.[^']+)'/g, (_, specifier) => `from '${new URL(specifier, origin).href}'`);
  const modulePath = join(home, 'enforced-settings.mjs'); fs.writeFileSync(modulePath, source);
  const enforced = await import(pathToFileURL(modulePath).href);
  assert.equal(enforced.SETTINGS_BUILD_POLICY.enforce, true);
  assert.equal(Object.isFrozen(enforced.SETTINGS_BUILD_POLICY), true);
  assert.equal(enforced.settingsSealNote(row), note);
  const failure = enforced.settingsSealDoctorLine({ verify: () => { throw Error('offline fake unavailable'); } });
  assert.match(failure, /enforced: helper unavailable, settings untrusted/);
  assert.doesNotMatch(failure, /adoption comes/);
  const swift = fs.readFileSync(new URL('../plugins/sleight/lib/mac-driver/native/SealedSettings.swift', import.meta.url), 'utf8');
  const menu = swift.slice(swift.indexOf('func settingsMenuSealLine()'));
  const enforcingBranch = menu.slice(menu.indexOf('    do {'));
  assert.match(enforcingBranch, /settings untrusted/);
  assert.doesNotMatch(enforcingBranch, /adoption comes|helper unavailable, preview/);
});


test('preview owner hashing preserves int22 raw bytes for invalid UTF-8', t => {
  const root = fs.realpathSync(trackTemp(fs.mkdtempSync(join(tmpdir(), 'sleight-owner-bytes-'))));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'turbo.json'), bytes = Buffer.from([0xff, 0x7b, 0x7d]);
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.notEqual(hash(bytes), hash(bytes.toString('utf8')));
  fs.writeFileSync(configPath, bytes, { mode: 0o600 });
  const pluginRoot = join(root, 'other-plugin');
  fs.mkdirSync(join(pluginRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(join(pluginRoot, '.claude-plugin/plugin.json'), '{"version":"1.6.0"}');
  fs.writeFileSync(join(root, 'turbo-owner.json'), JSON.stringify({ version: 1, sleight: '1.6.0', pluginRoot, sha256: hash(bytes) }), { mode: 0o600 });
  const original = fs.readFileSync, calls = [];
  t.mock.method(fs, 'readFileSync', (...args) => { calls.push(args); return original(...args); });
  syncBuiltinESMExports();
  try {
    const options = { configPath, pluginRoot: join(root, 'this-plugin'), data: {} };
    oldTurbo.liveOtherOwner(options); const before = [...calls];
    calls.length = 0; liveOtherOwner(options);
    assert.deepEqual([...calls], before);
    assert.ok(calls.some(([file]) => file === join(pluginRoot, '.claude-plugin/plugin.json')),
      'the raw hash matched, so owner validation continued');
    assert.deepEqual(calls.find(([file]) => file === configPath), [configPath]);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
