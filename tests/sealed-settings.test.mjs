import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { fakeSettings, fixtureStore, fixedFiles, sidecar } from './fixtures/sealed-settings-fake.mjs';
import { PreapprovedApps } from '../plugins/sleight/lib/preapproved.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appRefusal, siteRefusal, pageRefusal, readPermissions } from '../plugins/sleight/lib/permissions.mjs';
import { loadPreapproved } from '../plugins/sleight/lib/preapproved.mjs';
import { readInstalledConfigFile } from '../plugins/sleight/lib/direct-browser/installed-config.mjs';
import { readHandConfig } from '../plugins/sleight/lib/hand/settings.mjs';
import { readAppOptIns } from '../plugins/sleight/lib/direct-browser/electron-config.mjs';
import { helperBuildRecipes, helperBuildKey, helperSourceHashes, handInventory } from '../plugins/sleight/lib/direct-browser/host-cache.mjs';
import { digest } from './fixtures/sealed-settings-fake.mjs';
import { REQUIRED_STATUS_FLAGS } from '../plugins/sleight/lib/direct-browser/executable-trust.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

export function sealedSettingsCases(api) {
const A = JSON.stringify({ version: 1, apps: [{ app: 'Calculator', riskLevel: 'low' }] });
const B = JSON.stringify({ version: 1, apps: [{ app: 'Mail', riskLevel: 'high' }] });
function setup(t, options) {
  const root = fs.realpathSync(trackTemp(fs.mkdtempSync(join(tmpdir(), 'sleight-sealed-'))));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fakeSettings(root, options);
}
const snapshot = fake => api.verifySettings({ helper: fake.helper, proveHelper: () => ({ signed: true }) });
const grants = view => new PreapprovedApps(JSON.parse(api.trustedSettingsContent(view, 'preapproved.json', 'grant') ?? '{"version":1,"apps":[]}'));
const state = (fake, file = 'preapproved.json') => snapshot(fake).get(file).state;

test('case 01: a shell-forged grant is unsealed and the report gives no content', t => {
  const f = setup(t); fs.writeFileSync(join(f.root, 'preapproved.json'), B, { mode: 0o600 });
  const view = snapshot(f); assert.equal(view.get('preapproved.json').state, 'unsealed');
  assert.equal(grants(view).allows('Mail', 'high'), false);
  assert.equal(api.settingsSealNote(view.get('preapproved.json')), 'sleight settings: preapproved.json unsealed; adoption comes with the signed release.');
});
test('case 02: file edits from every interpreter have the same verdict', t => {
  const f = setup(t);
  for (const method of ['python', 'node', 'osascript', 'vim', 'sed', 'tee', 'cp', 'heredoc']) {
    f.put('preapproved.json', A); fs.writeFileSync(join(f.root, 'preapproved.json'), B);
    assert.equal(state(f), 'tampered', method);
  }
});
test('case 03: changing one entry invalidates the whole grant file', t => {
  const f = setup(t); f.put('preapproved.json', A);
  fs.writeFileSync(join(f.root, 'preapproved.json'), JSON.stringify({ version: 1, apps: [...JSON.parse(A).apps, ...JSON.parse(B).apps] }));
  assert.equal(state(f), 'tampered'); assert.equal(grants(snapshot(f)).size, 0);
});
test('case 04: a sidecar made with an attacker key fails', t => {
  const f = setup(t); f.put('preapproved.json', A);
  fs.writeFileSync(join(f.root, 'preapproved.json.seal'), sidecar({ ...fixtureStore(), key: Buffer.alloc(32, 99).toString('base64url') }, 'preapproved.json', 1, Buffer.from(A)));
  assert.equal(state(f), 'tampered');
});
test('case 05: replaying an old pair after revoke is stale', t => {
  const f = setup(t); f.put('preapproved.json', A);
  const old = fs.readFileSync(join(f.root, 'preapproved.json.seal'));
  f.put('preapproved.json', B); fs.writeFileSync(join(f.root, 'preapproved.json'), A); fs.writeFileSync(join(f.root, 'preapproved.json.seal'), old);
  assert.equal(state(f), 'stale'); assert.equal(grants(snapshot(f)).size, 0);
});
test('case 06: another installation with the same key still cannot replay a pair', t => {
  const f = setup(t); f.put('preapproved.json', A); f.store.installId = Buffer.alloc(16, 22).toString('base64url');
  assert.equal(state(f), 'tampered');
});
test('case 07: helper proof rejects a swapped helper before accepting lines', t => {
  const f = setup(t); f.put('preapproved.json', A); let called = 0;
  assert.throws(() => api.verifySettings({ helper: (...args) => { called++; return f.helper(...args); }, proveHelper: () => false }), /HELPER_UNTRUSTED/);
  assert.equal(called, 0);
});
test('case 08: writeSettings accepts only fixed intents and refuses bytes', () => {
  for (const intent of [{ family: 'write', op: 'file', content: B }, { family: 'allow', op: 'add', args: ['Mail', 'high'], content: B }])
    assert.throws(() => api.writeSettings(intent, { helper: () => assert.fail('no dispatch'), proveHelper: () => true }), /SETTINGS_INTENT_REFUSED/);
});
test('case 09: posted-click authorization cannot reach the new write path', () => {
  assert.throws(() => api.writeSettings({ family: 'allow', op: 'add', args: ['Mail', 'high'] }, {
    helper: () => { throw Error('PERSON_INPUT_REQUIRED'); }, proveHelper: () => true }), /PERSON_INPUT_REQUIRED/);
});
test('case 10: lost key store never recreates or blesses files', t => {
  const f = setup(t); f.put('preapproved.json', A);
  const absent = fakeSettings(f.root, { store: null }); assert.equal(state(absent), 'tampered');
  assert.match(api.settingsSealNote(snapshot(absent).get('preapproved.json')), /adoption comes with the signed release/);
});
test('case 11: replacement key has no authority over an existing pair', t => {
  const f = setup(t); f.put('preapproved.json', A); f.store.key = Buffer.alloc(32, 88).toString('base64url');
  assert.equal(state(f), 'tampered');
});
test('case 12: verified content A survives a later disk replacement B', t => {
  const f = setup(t); f.put('preapproved.json', A);
  const view = snapshot(f); fs.writeFileSync(join(f.root, 'preapproved.json'), B);
  assert.equal(grants(view).allows('Calculator', 'low'), true); assert.equal(grants(view).allows('Mail', 'high'), false);
  f.put('preapproved.json', A);
  const read = () => api.verifySettings({ helper: args => {
    const result = f.helper(args); fs.writeFileSync(join(f.root, 'preapproved.json'), B); return { ...result, enforcement: true };
  }, proveHelper: () => ({ signed: true }) });
  const list = new PreapprovedApps(JSON.parse(api.readSettingsBytes(join(f.root, 'preapproved.json'),
    () => fs.readFileSync(join(f.root, 'preapproved.json'), 'utf8'), { verify: read, root: f.root, enforce: true })));
  assert.equal(list.allows('Calculator', 'low'), true); assert.equal(list.allows('Mail', 'high'), false);
});
test('case 13: symlinks, hardlinks and wrong modes refuse', t => {
  const f = setup(t); f.put('preapproved.json', A); const path = join(f.root, 'preapproved.json');
  fs.linkSync(path, join(f.root, 'hardlink')); assert.equal(state(f), 'unsafe'); fs.unlinkSync(join(f.root, 'hardlink'));
  fs.chmodSync(path, 0o644); assert.equal(state(f), 'unsafe'); fs.chmodSync(path, 0o600);
  fs.renameSync(path, path + '.old'); fs.symlinkSync(path + '.old', path); assert.equal(state(f), 'unsafe');
});
test('case 14: downgrade writes remain raw JSON and come back unsealed', t => {
  const f = setup(t); f.put('preapproved.json', A); assert.equal(new PreapprovedApps(JSON.parse(fs.readFileSync(join(f.root, 'preapproved.json')))).size, 1);
  fs.unlinkSync(join(f.root, 'preapproved.json.seal')); fs.writeFileSync(join(f.root, 'preapproved.json'), B);
  assert.equal(state(f), 'unsealed');
});
test('case 15: a full snapshot restores trust, settings-only restore is stale', t => {
  const f = setup(t); f.put('preapproved.json', A); const saved = structuredClone(f.store), seal = fs.readFileSync(join(f.root, 'preapproved.json.seal'));
  f.put('preapproved.json', A); fs.writeFileSync(join(f.root, 'preapproved.json.seal'), seal); assert.equal(state(f), 'stale');
  assert.equal(state(fakeSettings(f.root, { store: saved })), 'trusted');
});
test('case 16: HOME and SLEIGHT variables cannot change a verdict', t => {
  const f = setup(t); f.put('preapproved.json', A); const before = snapshot(f).get('preapproved.json'), old = { ...process.env };
  t.after(() => { process.env = old; });
  const sources = [];
  function walk(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:mjs|js|swift|c)$/.test(entry.name)) sources.push(fs.readFileSync(path, 'utf8'));
    }
  }
  walk(fileURLToPath(new URL('../plugins/sleight/lib/', import.meta.url)));
  const source = sources.join('\n');
  for (const value of ['0', '1']) { for (const name of new Set(source.match(/SLEIGHT_[A-Z_0-9]+/g))) process.env[name] = value; process.env.HOME = f.root; assert.deepEqual(snapshot(f).get('preapproved.json'), before); }
});
test('case 17: absent-but-recorded permissions refuses every strict check', t => {
  const f = setup(t); f.put('permissions.json', '{"version":1,"apps":[],"sites":[]}'); fs.unlinkSync(join(f.root, 'permissions.json'));
  const view = snapshot(f); assert.equal(view.get('permissions.json').state, 'tampered');
  assert.throws(() => api.trustedSettingsContent(view, 'permissions.json', 'deny'), /SETTINGS_UNTRUSTED/);
  const enforcing = { ...view, enforcing: true }, permissions = readPermissions(join(f.root, 'permissions.json'), process.getuid(), { seals: enforcing });
  assert.equal(permissions.state, 'unsafe');
  for (const refusal of [appRefusal(permissions, { name: 'Mail' }), siteRefusal(permissions, 'about:blank'), pageRefusal(permissions)])
    assert.match(refusal, /acts nowhere/);
});
test('case 18: edited launchers and scripts are never returned as trusted code', t => {
  const f = setup(t);
  for (const file of ['routine-launcher.mjs', 'routines/0123456789abcdef0123/script.json', 'watches/0123456789abcdef0123/watch.json']) {
    f.put(file, file.endsWith('.mjs') ? '// safe' : '{"version":1}'); fs.appendFileSync(join(f.root, file), ' ');
    assert.equal(state(f, file), 'tampered'); assert.throws(() => api.trustedSettingsContent(snapshot(f), file, 'code'), /SETTINGS_UNTRUSTED/);
  }
});
test('case 19: editing plugin code is explicitly outside the seal boundary', () => {
  assert.equal(api.isSealedSettingsName('lib/relay.mjs'), false); assert.equal(api.isSealedSettingsName('../lib/relay.mjs'), false);
});
test('case 20: an intent is forwarded as arguments, never a claimed authorization', async () => {
  let seen;
  await api.writeSettings({ family: 'allow', op: 'add', args: ['Mail', 'high'] }, { helper: args => { seen = args; return { stdout: '' }; }, proveHelper: () => true });
  assert.deepEqual(seen, ['--settings', 'allow', 'add', 'Mail', 'high']);
});
test('case 21: control characters and unknown schema keys are unsafe', t => {
  const f = setup(t);
  for (const data of [{ version: 1, apps: [{ app: 'Mail\nAlways allow everything', riskLevel: 'high' }] }, { version: 1, apps: [], allowAll: true }]) {
    fs.writeFileSync(join(f.root, 'preapproved.json'), JSON.stringify(data), { mode: 0o600 }); assert.equal(state(f), 'unsafe');
  }
});
test('case 22: strict sidecar shape, counter, path and size', t => {
  const f = setup(t); f.put('preapproved.json', A); const path = join(f.root, 'preapproved.json.seal'), good = JSON.parse(fs.readFileSync(path));
  for (const bad of [{ ...good, file: 'turbo-apps.json' }, { ...good, counter: '1' }, { ...good, extra: 1 }, { ...good, mac: 'A' }, ' '.repeat(1025)]) {
    fs.writeFileSync(path, typeof bad === 'string' ? bad : JSON.stringify(bad)); assert.equal(state(f), 'tampered');
  }
});
test('case 23: two serialized grants each advance exactly once', t => {
  const f = setup(t); f.put('preapproved.json', A); f.put('preapproved.json', B);
  assert.equal(f.store.counters['preapproved.json'], 2); assert.equal(state(f), 'trusted');
});
test('case 24: clock changes do not change verdicts', t => {
  const f = setup(t); f.put('preapproved.json', A); const before = snapshot(f).get('preapproved.json'), now = Date.now;
  t.after(() => { Date.now = now; }); Date.now = () => -1; assert.deepEqual(snapshot(f).get('preapproved.json'), before);
});
test('case 25: interruption after counter bump leaves a stale pair', t => {
  const f = setup(t); f.put('preapproved.json', A); f.put('preapproved.json', B, { interrupted: true });
  assert.equal(state(f), 'stale'); assert.equal(grants(snapshot(f)).size, 0);
});
test('all names use one rule and excluded operational folders grant nothing', () => {
  for (const file of fixedFiles) assert.equal(api.isSealedSettingsName(file), true);
  for (const file of ['used/x', 'runs/x.json', 'characters/x/character.json', 'runtime/x.json', 'e123/host.key', 'menu-hand.lock', '../permissions.json']) assert.equal(api.isSealedSettingsName(file), false);
});
test('verification and preview reads preserve a forged file inode, bytes and mtime', t => {
  const f = setup(t); const path = join(f.root, 'preapproved.json'); fs.writeFileSync(path, B, { mode: 0o600 });
  const before = fs.statSync(path); snapshot(f);
  const result = api.readSettingsPreview(path, () => new PreapprovedApps(JSON.parse(fs.readFileSync(path))), { verify: () => snapshot(f), root: f.root, enforce: true });
  assert.equal(result.allows('Mail', 'high'), true, 'preview preserves current trust');
  const after = fs.statSync(path); assert.deepEqual([after.ino, after.mtimeMs, fs.readFileSync(path, 'utf8')], [before.ino, before.mtimeMs, B]);
  assert.equal(fs.existsSync(path + '.seal'), false);
});
test('preview verdicts stay outside every tool reply and remain in the doctor', t => {
  api.takeSettingsSealNotes(); t.after(() => api.takeSettingsSealNotes());
  const f = setup(t);
  for (const state of ['unsealed', 'tampered', 'stale', 'unsafe']) {
    const verify = () => api.verifySettings({ proveHelper: () => ({ signed: true }), helper: () => ({
      enforcement: false, stdout: fixedFiles.map(file => JSON.stringify({ file, state })).join('\n'),
    }) });
    for (const file of fixedFiles) api.observeSettingsFile(join(f.root, file), { verify, root: f.root });
    for (const result of [{ content: [{ type: 'text', text: 'App state' }] },
      { content: [{ type: 'text', text: 'Action refused' }], isError: true }, { content: [] }]) {
      const message = { jsonrpc: '2.0', id: 1, result }, before = structuredClone(message);
      api.appendSettingsSealNotes(message); assert.deepEqual(message, before, state);
    }
    assert.deepEqual(api.takeSettingsSealNotes(), [], 'preview cannot leave a note for a later reply');
    const doctor = api.settingsSealDoctorLine({ verify });
    assert.match(doctor, /^seals     preview, trust unchanged:/);
    for (const file of fixedFiles) assert.ok(doctor.includes(`${file} ${state}`));
  }
});
test('preview helper failure leaves tool replies unchanged and is reported by the doctor', t => {
  api.takeSettingsSealNotes(); t.after(() => api.takeSettingsSealNotes());
  const f = setup(t), verify = () => { throw Error('HELPER_UNTRUSTED'); };
  api.observeSettingsFile(join(f.root, 'permissions.json'), { verify, root: f.root });
  const message = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'App state' }] } };
  const before = structuredClone(message); api.appendSettingsSealNotes(message);
  assert.deepEqual(message, before); assert.deepEqual(api.takeSettingsSealNotes(), []);
  assert.match(api.settingsSealDoctorLine({ verify }), /preview, trust unchanged: helper unavailable/);
});
test('enforced verdict adds exactly one I4 line to the first tool reply', t => {
  api.takeSettingsSealNotes(); t.after(() => api.takeSettingsSealNotes());
  const f = setup(t, { enforce: true }), file = 'preapproved.json', path = join(f.root, file);
  fs.writeFileSync(path, B, { mode: 0o600 });
  const verify = () => snapshot(f), options = { verify, root: f.root, enforce: true };
  assert.equal(api.observeSettingsFile(path, options).enforcing, true);
  api.observeSettingsFile(path, options);
  // Protocol notifications and catalog replies must not consume the pending line.
  const notification = { method: 'notifications/test', result: { content: [] } };
  api.appendSettingsSealNotes(notification); assert.deepEqual(notification.result.content, []);
  const catalog = { id: 0, result: { tools: [] } };
  api.appendSettingsSealNotes(catalog); assert.deepEqual(catalog.result, { tools: [] });
  const note = 'sleight settings: preapproved.json unsealed; adoption comes with the signed release.';
  const first = { id: 1, result: { content: [{ type: 'text', text: 'App state' }] } };
  api.appendSettingsSealNotes(first); api.appendSettingsSealNotes(first);
  assert.deepEqual(first.result.content, [{ type: 'text', text: 'App state' }, { type: 'text', text: note }]);
  assert.equal(first.result.content[1].text.split('\n').length, 1);
  api.observeSettingsFile(path, options);
  // A changed stat key with the same verdict must not repeat the report either.
  fs.appendFileSync(path, ' '); api.observeSettingsFile(path, options);
  const second = { id: 2, result: { content: [] } }; api.appendSettingsSealNotes(second);
  assert.deepEqual(second.result.content, []); assert.deepEqual(api.takeSettingsSealNotes(), []);
  assert.match(api.settingsSealDoctorLine({ verify }), /enforced: preapproved.json unsealed/);
});
test('protocol rejects duplicates, unexpected names, content on untrusted lines and incomplete output', () => {
  for (const stdout of ['{"file":"preapproved.json","state":"tampered","content":"secret"}\n', '{"file":"../x","state":"trusted","content":"x"}\n', '',
    '{"file":"preapproved.json","state":"unsealed"}\n{"file":"preapproved.json","state":"unsealed"}\n'])
    assert.throws(() => api.verifySettings({ helper: () => ({ stdout }), proveHelper: () => true }), /SETTINGS_PROTOCOL/);
});
test('all enforced reader adapters consume helper content without a disk read', t => {
  const f = setup(t, { enforce: true }); f.put('preapproved.json', A);
  f.put('permissions.json', '{"version":1,"apps":[],"sites":[]}'); f.put('turbo.json', '{"version":1,"enabled":false}');
  f.put('hand.json', '{"version":1,"enabled":false}'); f.put('turbo-apps.json', '{"version":1,"apps":{}}');
  const view = snapshot(f);
  for (const name of fixedFiles) if (fs.existsSync(join(f.root, name))) fs.unlinkSync(join(f.root, name));
  const noIO = new Proxy({}, { get() { assert.fail('an enforced reader touched disk'); } });
  assert.equal(loadPreapproved(noIO, { seals: view }).allows('Calculator', 'low'), true);
  assert.equal(readPermissions(join(f.root, 'permissions.json'), process.getuid(), { seals: view }).state, 'ok');
  assert.equal(readInstalledConfigFile(join(f.root, 'turbo.json'), { seals: view }).enabled, false);
  assert.equal(readHandConfig(join(f.root, 'hand.json'), process.getuid(), { platform: 'darwin', seals: view }).state, 'off');
  assert.deepEqual(readAppOptIns(join(f.root, 'turbo-apps.json'), { seals: view }).apps, {});
});
test('an unsigned proof cannot turn on enforcement', t => {
  const f = setup(t, { enforce: true });
  assert.throws(() => api.verifySettings({ helper: f.helper, proveHelper: () => ({ signed: false }) }), /HELPER_UNTRUSTED/);
});
test('CryptoKit and the fake use constant-time comparisons and reject unequal lengths', () => {
  const swift = fs.readFileSync(new URL('../plugins/sleight/lib/mac-driver/native/SealedSettings.swift', import.meta.url), 'utf8');
  const fake = fs.readFileSync(new URL('./fixtures/sealed-settings-fake.mjs', import.meta.url), 'utf8');
  assert.match(swift, /HMAC<SHA256>\.isValidAuthenticationCode\(/); assert.match(fake, /timingSafeEqual\(expected, given\)/);
});
for (const recipe of ['optimized', 'default']) test('build-hash proof catches recipe, binary and record tampering: ' + recipe, { skip: process.platform !== 'darwin' }, t => {
  const f = setup(t), sourceRoot = join(f.root, 'lib/direct-browser/native'), cacheRoot = join(f.root, 'cache');
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 }); fs.mkdirSync(join(f.root, 'lib/mac-driver/native'), { recursive: true, mode: 0o700 });
  for (const name of ['peer-host.c', 'consent-host.swift']) fs.writeFileSync(join(sourceRoot, name), '// fixture\n', { mode: 0o600 });
  fs.writeFileSync(join(f.root, 'lib/mac-driver/native/SealedSettings.swift'), '// fixture\n', { mode: 0o600 });
  const hashes = helperSourceHashes(handInventory(sourceRoot)), directory = join(cacheRoot, helperBuildKey(hashes, recipe));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const bytes = '#!/bin/sh\nexit 0\n', binary = join(directory, 'consent-host');
  fs.writeFileSync(binary, bytes, { mode: 0o700 });
  fs.writeFileSync(join(directory, 'peer-host'), bytes, { mode: 0o700 });
  fs.writeFileSync(join(directory, 'build.json'), JSON.stringify({ protocol: 1, arch: process.arch, sources: hashes, recipes: helperBuildRecipes(hashes, recipe), binaries: { 'consent-host': digest(bytes), 'peer-host': digest(bytes) } }), { mode: 0o600 });
  const recordPath = join(directory, 'build.json'), record = JSON.parse(fs.readFileSync(recordPath));
  for (const recipes of [undefined, {}]) {
    fs.writeFileSync(recordPath, JSON.stringify({ ...record, recipes }));
    assert.throws(() => api.cachedSettingsHelper({ sourceRoot, cacheRoot }), /HELPER_UNTRUSTED/);
  }
  fs.writeFileSync(recordPath, JSON.stringify(record));
  const helper = api.cachedSettingsHelper({ sourceRoot, cacheRoot }); assert.equal(api.proveSettingsHelper(helper).signed, false);
  fs.appendFileSync(binary, '# swapped\n'); assert.equal(api.proveSettingsHelper(helper), false);
  fs.writeFileSync(binary, bytes); fs.appendFileSync(join(directory, 'build.json'), ' '); assert.equal(api.proveSettingsHelper(helper), false);
});
test('signed child proof pins the Team, running cdhash, hardened flags and incarnation before reading settings', () => {
  const identity = { team: 'ABCDEFGHIJ', helperId: 'com.landoclusters.sleight.helper', peerId: 'com.landoclusters.sleight.peer' };
  const child = { pid: 123, executable: '/fixture/consent-host', peer: '/fixture/peer-host', identity };
  const status = { uid: process.getuid(), pid: 123, start: 1000, incarnation: 'p123-s1-u0', flags: REQUIRED_STATUS_FLAGS, arch: 'arm64', cdhash: 'a'.repeat(40) };
  const calls = [], run = (file, args) => {
    calls.push([file, args]); return { status: 0, stdout: file === child.peer ? JSON.stringify(status) : '',
      stderr: args.includes('--display') ? 'CodeDirectory v=20500 flags=0x12200(runtime,kill,library-validation)' : '' };
  };
  assert.equal(api.proveSignedSettingsChild(child, { run }).signed, true);
  assert.equal(calls.filter(([file]) => file === child.peer).length, 2);
  assert.ok(calls.some(([file, args]) => file === '/usr/bin/codesign' && args.some(arg => arg.includes('cdhash H"' + status.cdhash + '"'))));
  assert.ok(calls.every(([file, args]) => file !== '/usr/bin/codesign' || !args.includes('--verify') || args.some(arg => arg.includes('"ABCDEFGHIJ"'))));
  for (const bit of [0x1, 0x200, 0x2000, 0x10000]) {
    assert.throws(() => api.proveSignedSettingsChild(child, { run: (file, args) => file === child.peer
      ? { status: 0, stdout: JSON.stringify({ ...status, flags: status.flags & ~bit }) } : run(file, args) }), /HELPER_UNTRUSTED/);
  }
  assert.throws(() => api.proveSignedSettingsChild(child, { run: () => ({ status: 1 }) }), /HELPER_UNTRUSTED/);
  let reads = 0;
  assert.throws(() => api.proveSignedSettingsChild(child, { run: (file, args) => file === child.peer ? { status: 0,
    stdout: JSON.stringify({ ...status, incarnation: ++reads === 1 ? status.incarnation : 'p123-s2-u0' }) } : run(file, args) }), /HELPER_UNTRUSTED/);
});
test('the signed transport waits for external proof before reading content or releasing verification', async () => {
  function fixture() {
    const child = new EventEmitter(); Object.assign(child, { pid: 123, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
    child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()];
    child.kill = () => { child.exitCode = 1; queueMicrotask(() => child.emit('close', 1)); return true; };
    child.stdin.on('data', bytes => {
      assert.equal(bytes.toString(), 'go\n');
      child.stdout.end('{"file":"preapproved.json","state":"unsealed"}\n');
      child.stderr.end('{"settingsEnforcement":true}\n'); child.exitCode = 0; queueMicrotask(() => child.emit('close', 0));
    });
    queueMicrotask(() => child.stdio[3].end('{"settingsReady":1,"pid":123}\n'));
    return child;
  }
  const child = fixture(); let proven = false;
  const result = await api.runSignedSettingsVerification({ binary: '/fixture/consent-host', peer: '/fixture/peer-host' }, {
    launch: () => child, prove: () => {
      assert.equal(child.stdout.listenerCount('data'), 0); proven = true; return { signed: true };
    },
  });
  assert.equal(proven, true); assert.equal(result.enforcement, true); assert.match(result.stdout, /"unsealed"/);
  const refused = fixture();
  await assert.rejects(api.runSignedSettingsVerification({ binary: '/fixture/consent-host', peer: '/fixture/peer-host' },
    { launch: () => refused, prove: () => false }), /HELPER_UNTRUSTED/);
  assert.notEqual(refused.exitCode, null);
});
test('an enforcement build never falls back to raw grants when helper proof is unavailable', async t => {
  const f = setup(t), original = new URL('../plugins/sleight/lib/sealed-settings.mjs', import.meta.url);
  let source = fs.readFileSync(original, 'utf8');
  source = source.replace("import { SETTINGS_BUILD_POLICY } from './settings-build-policy.mjs';",
    "const SETTINGS_BUILD_POLICY = Object.freeze({ enforce: true, team: null });");
  source = source.replace(/from '(\.[^']+)'/g, (_, specifier) => `from '${new URL(specifier, original).href}'`);
  const path = join(f.root, 'enforced-build.mjs'); fs.writeFileSync(path, source);
  const strict = await import(pathToFileURL(path).href);
  let rawReads = 0;
  const options = { root: f.root, verify: () => { throw Error('HELPER_UNTRUSTED'); } };
  assert.equal(strict.readSettingsBytes(join(f.root, 'preapproved.json'), () => { rawReads++; return B; }, options), undefined);
  assert.equal(rawReads, 0);
  assert.throws(() => strict.readSettingsBytes(join(f.root, 'permissions.json'), () => '{"version":1,"apps":[],"sites":[]}', options), /SETTINGS_UNTRUSTED/);
});
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  sealedSettingsCases(await import('../plugins/sleight/lib/sealed-settings.mjs').catch(() => ({})));
