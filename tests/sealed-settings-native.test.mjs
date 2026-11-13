import { test as nodeTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { fakeSettings, fixtureStore } from './fixtures/sealed-settings-fake.mjs';
import { loadPreapproved } from './fixtures/sealed-settings-int22/preapproved.mjs';
import { readPermissions } from './fixtures/sealed-settings-int22/permissions.mjs';
import { readInstalledConfigFile } from './fixtures/sealed-settings-int22/installed-config.mjs';
import { readHandConfig } from './fixtures/sealed-settings-int22/hand-settings.mjs';
import { withPreapprovedLock } from '../plugins/sleight/lib/preapproved.mjs';

export function nativeSettingsCases({ source = fileURLToPath(new URL('../plugins/sleight/lib/mac-driver/native/SealedSettings.swift', import.meta.url)), productionCheck = true } = {}) {
const test = (name, action) => nodeTest(name, { skip: process.platform !== 'darwin' }, action);
const main = fileURLToPath(new URL('./fixtures/sealed-settings-main.swift', import.meta.url));
const consent = fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url));
const vectors = fileURLToPath(new URL('./fixtures/sealed-settings-vectors.json', import.meta.url));
const v = JSON.parse(fs.readFileSync(vectors));
const bank = fs.realpathSync(trackTemp(fs.mkdtempSync(join(tmpdir(), 'sleight-seal-native-'))));
const binary = join(bank, 'test-helper'), production = join(bank, 'production-helper');
const probe = join(bank, 'probe-helper');
after(() => fs.rmSync(bank, { recursive: true, force: true }));
const run = (file, args, options = {}) => spawnSync(file, args, { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL',
  maxBuffer: 4 * 1024 * 1024, ...options });
before(() => {
  if (process.platform !== 'darwin') return;
  assert.equal(fs.existsSync(source), true, 'the native settings module exists');
  fs.writeFileSync(join(bank, 'main.swift'), fs.readFileSync(main));
  fs.writeFileSync(join(bank, 'production.swift'), fs.readFileSync(source, 'utf8') + '\n' + fs.readFileSync(consent, 'utf8'));
  for (const [out, flags, inputs] of [[binary, ['-D', 'SLEIGHT_TEST_KEYSTORE', '-D', 'SLEIGHT_KEYSTORE_PROBE'], [source, join(bank, 'main.swift')]],
    ...productionCheck ? [[production, ['-D', 'SLEIGHT_SEALED_SETTINGS'], [join(bank, 'production.swift')]],
      [probe, ['-D', 'SLEIGHT_SEALED_SETTINGS', '-D', 'SLEIGHT_KEYSTORE_PROBE'], [join(bank, 'production.swift')]]] : []]) {
    const built = run('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-module-cache-path', join(bank, 'modules'), ...flags, ...inputs, '-o', out]);
    assert.equal(built.status, 0, built.stderr);
  }
});
function fixture(t) {
  const root = join(bank, 'settings-' + Math.random().toString(16).slice(2)); fs.mkdirSync(root, { mode: 0o700 });
  const key = join(bank, 'key-' + Math.random().toString(16).slice(2) + '.json');
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(key, { force: true }); });
  return { root, key, call: (op, ...args) => run(binary, [root, key, op, ...args]), seed() { const r = this.call('fixture', vectors); assert.equal(r.status, 0, r.stderr); } };
}
const verdicts = f => { const r = f.call('verify'); assert.equal(r.status, 0, r.stderr); return new Map(r.stdout.trim().split('\n').map(line => { const v = JSON.parse(line); return [v.file, v]; })); };

test('Swift and Node use byte-identical shared fixture sidecars (M9)', t => {
  const f = fixture(t); f.seed();
  const other = join(bank, 'node-fixture'); fs.mkdirSync(other, { mode: 0o700 });
  const fake = fakeSettings(other, { store: fixtureStore() });
  for (const entry of v.files) {
    fake.put(entry.file, entry.content);
    assert.equal(fs.readFileSync(join(f.root, entry.file + '.seal'), 'utf8'), fs.readFileSync(join(other, entry.file + '.seal'), 'utf8'), entry.file);
    assert.deepEqual(verdicts(f).get(entry.file), fake.verify(entry.file));
  }
});
test('native MAC byte changes, replay, cross-name and cross-install refusals (M1-M4)', t => {
  const f = fixture(t); f.seed(); const name = 'preapproved.json', file = join(f.root, name), seal = file + '.seal';
  const bytes = fs.readFileSync(file), side = fs.readFileSync(seal), key = fs.readFileSync(f.key);
  fs.appendFileSync(file, ' '); assert.equal(verdicts(f).get(name).state, 'tampered'); fs.writeFileSync(file, bytes);
  assert.equal(f.call('bump', name).status, 0); assert.equal(verdicts(f).get(name).state, 'stale'); fs.writeFileSync(f.key, key);
  const record = JSON.parse(key); record.installId = Buffer.alloc(16, 9).toString('base64url'); fs.writeFileSync(f.key, JSON.stringify(record));
  assert.equal(verdicts(f).get(name).state, 'tampered'); fs.writeFileSync(f.key, key);
  const renamed = join(f.root, 'turbo.json'); fs.copyFileSync(join(f.root, 'hand.json'), renamed);
  const swapped = JSON.parse(fs.readFileSync(join(f.root, 'hand.json.seal'))); swapped.file = 'turbo.json';
  fs.writeFileSync(renamed + '.seal', JSON.stringify(swapped)); assert.equal(verdicts(f).get('turbo.json').state, 'tampered');
  fs.writeFileSync(file, bytes); fs.writeFileSync(seal, side); assert.equal(verdicts(f).get(name).state, 'trusted');
});
test('native rejects unsafe chain, permissions, hardlinks and symlink leaves', t => {
  const f = fixture(t); f.seed(); const file = join(f.root, 'preapproved.json');
  fs.chmodSync(file, 0o644); assert.equal(verdicts(f).get('preapproved.json').state, 'unsafe'); fs.chmodSync(file, 0o600);
  fs.linkSync(file, file + '.link'); assert.equal(verdicts(f).get('preapproved.json').state, 'unsafe'); fs.unlinkSync(file + '.link');
  fs.renameSync(file, file + '.old'); fs.symlinkSync(file + '.old', file); assert.equal(verdicts(f).get('preapproved.json').state, 'unsafe');
});
test('native strict sidecars have 4 keys and at most 1024 bytes', t => {
  const f = fixture(t); f.seed(); const file = join(f.root, 'preapproved.json.seal'), original = JSON.parse(fs.readFileSync(file));
  for (const value of [{ ...original, counter: '1' }, { ...original, version: true }, { ...original, extra: 1 }, { ...original, mac: 'AA' }, ' '.repeat(1025)]) {
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); assert.equal(verdicts(f).get('preapproved.json').state, 'tampered');
  }
});
test('native verification preserves unsealed files and never creates a key (M8)', t => {
  const f = fixture(t), file = join(f.root, 'preapproved.json'); fs.writeFileSync(file, v.files[0].content, { mode: 0o600 });
  const before = fs.statSync(file); assert.equal(verdicts(f).get('preapproved.json').state, 'unsealed');
  const after = fs.statSync(file); assert.equal(before.ino, after.ino); assert.equal(before.mtimeMs, after.mtimeMs);
  assert.equal(fs.existsSync(f.key), false); assert.equal(fs.existsSync(file + '.seal'), false);
});
test('native recorded absence and lost store fail closed (M11)', t => {
  const f = fixture(t); f.seed(); fs.unlinkSync(join(f.root, 'permissions.json'));
  assert.equal(verdicts(f).get('permissions.json').state, 'tampered'); fs.unlinkSync(f.key);
  assert.equal(verdicts(f).get('preapproved.json').state, 'tampered'); assert.equal(fs.existsSync(f.key), false);
  assert.equal(verdicts(f).get('permissions.json').state, 'tampered', 'the remaining sidecar records prior presence even when the key is gone');
});
test('native adoption requires the typed word and confirmation and skips grants (M12)', t => {
  for (const [word, result] of [['wrong', 'ok'], ['adopt', 'cancelled']]) {
    const f = fixture(t), file = join(f.root, 'hand.json'); fs.writeFileSync(file, '{"version":1,"enabled":false}', { mode: 0o600 });
    assert.notEqual(f.call('adopt', word, result).status, 0); assert.equal(fs.existsSync(f.key), false); assert.equal(fs.existsSync(file + '.seal'), false);
  }
  const f = fixture(t); for (const entry of v.files.slice(0, 4)) fs.writeFileSync(join(f.root, entry.file), entry.content, { mode: 0o600 });
  assert.equal(f.call('adopt', 'adopt', 'ok').status, 0); assert.equal(fs.existsSync(join(f.root, 'preapproved.json.seal')), false);
  assert.equal(verdicts(f).get('hand.json').state, 'trusted');
});
test('native posted Always allow cannot write or advance the counter (M14)', t => {
  const f = fixture(t), refused = f.call('click', 'Mail', 'posted');
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /PERSON_INPUT_REQUIRED/);
  assert.equal(fs.existsSync(f.key), false); assert.equal(fs.existsSync(join(f.root, 'preapproved.json.seal')), false);
  assert.notEqual(f.call('apply', 'posted', 'allow', 'add', 'Mail', 'high').status, 0);
  assert.equal(fs.existsSync(f.key), false); assert.equal(fs.existsSync(join(f.root, 'preapproved.json.seal')), false);
});
test('int22 readers parse native-written JSON and ignore sidecars (M13)', t => {
  const f = fixture(t); f.seed();
  assert.equal(readPermissions(join(f.root, 'permissions.json')).state, 'ok');
  assert.equal(readInstalledConfigFile(join(f.root, 'turbo.json')).enabled, false);
  assert.equal(readHandConfig(join(f.root, 'hand.json')).state, 'off');
  const io = { ...fs };
  for (const name of ['lstatSync', 'openSync', 'realpathSync']) io[name] = (path, ...args) => name === 'realpathSync' ? path : fs[name](join(f.root, 'preapproved.json'), ...args);
  assert.equal(loadPreapproved(io).allows('Calculator', 'low'), true);
});
test('production binary has no FileKeyStore marker or test arguments (M16)', () => {
  assert.equal(fs.readFileSync(binary).includes(Buffer.from('SLEIGHT_TEST_FILE_KEYSTORE')), true);
  assert.equal(fs.readFileSync(production).includes(Buffer.from('SLEIGHT_TEST_FILE_KEYSTORE')), false);
  assert.equal(fs.readFileSync(production).includes(Buffer.from('FileKeyStore')), false);
  assert.equal(run(production, ['--confirm-person-check', 'settings']).status, 0);
  assert.equal(run(production, ['--settings', 'verify', '--test-store', bank]).status, 64);
  // This build omits enforcement: validation refuses before any key-store API or UI.
  const preview = run(production, ['--settings', 'allow', 'add', 'Mail', 'high']);
  assert.equal(preview.status, 65); assert.match(preview.stderr, /SETTINGS_PREVIEW_ONLY/);
});
test('every native intent rejects a trailing content argument (M7)', t => {
  const f = fixture(t);
  const sourceText = fs.readFileSync(source, 'utf8'), listed = [...sourceText.matchAll(/SettingsIntentForm\("([^"]+)"/g)].map(m => m[1]);
  const forms = ['verify', 'allow add', 'allow remove', 'turbo on', 'turbo off', 'turbo app on', 'turbo app off', 'permissions block',
    'permissions unblock', 'permissions sites', 'permissions revoke', 'permissions repair', 'hand off', 'routine add', 'routine unlock',
    'routine remove', 'watch record', 'watch unlock', 'watch remove', 'adopt', 'repair'];
  assert.deepEqual(listed, forms);
  for (const form of forms) assert.notEqual(f.call('intent', ...form.split(' '), '{"content":"forged"}').status, 0, form);
});
test('the probe build compiles separately; the live probe is never invoked', () => {
  assert.equal(fs.readFileSync(probe).includes(Buffer.from('key-store-probe status=')), true);
  assert.equal(fs.readFileSync(probe).includes(Buffer.from('SLEIGHT_TEST_FILE_KEYSTORE')), false);
  assert.equal(fs.readFileSync(production).includes(Buffer.from('key-store-probe status=')), false);
});
test('cases 04 and 11: a key-store access denial yields no trusted content and cannot write', t => {
  const f = fixture(t); f.seed(); const before = fs.readFileSync(f.key), r = f.call('denied-key-store');
  assert.equal(r.status, 0, r.stderr);
  for (const line of r.stdout.trim().split('\n')) { const row = JSON.parse(line); assert.notEqual(row.state, 'trusted'); assert.equal(row.content, undefined); }
  assert.deepEqual(fs.readFileSync(f.key), before);
});
test('case 16: native account paths and verdicts ignore fake HOME', t => {
  const f = fixture(t); f.seed(); const result = run(binary, [f.root, f.key, 'verify'], { env: { ...process.env, HOME: f.root, SLEIGHT_SETTINGS_SEAL: '0', SLEIGHT_HAND: '1' } });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, f.call('verify').stdout);
  const home = run(binary, [f.root, f.key, 'home'], { env: { ...process.env, HOME: f.root } });
  assert.equal(home.status, 0, home.stderr); assert.notEqual(home.stdout.trim(), f.root);
});
test('case 23: two real helper processes serialize concurrent Always allow writes', async t => {
  const f = fixture(t);
  const child = name => new Promise((resolve, reject) => {
    const c = spawn(binary, [f.root, f.key, 'click', name, 'physical'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; c.stderr.on('data', b => { errors += b; }); c.once('error', reject); c.once('close', code => resolve({ code, errors }));
  });
  const results = await Promise.all([child('Mail'), child('Calculator')]);
  for (const result of results) assert.equal(result.code, 0, result.errors);
  const record = JSON.parse(fs.readFileSync(f.key)); assert.equal(record.counters['preapproved.json'], 2);
  const row = verdicts(f).get('preapproved.json'); assert.equal(row.state, 'trusted');
  assert.deepEqual(JSON.parse(row.content).apps.map(a => a.app).sort(), ['Calculator', 'Mail']);
});
test('native writer waits for the legacy Node approval lock', async t => {
  const f = fixture(t), lock = join(f.root, 'preapproved.json.lock');
  let proc, done;
  withPreapprovedLock(join(f.root, 'preapproved.json'), () => {
    proc = spawn(binary, [f.root, f.key, 'click', 'Mail', 'physical'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; proc.stderr.on('data', bytes => stderr += bytes); proc.stdout.resume();
    done = new Promise((resolve, reject) => { proc.once('error', reject); proc.once('close', code => resolve({ code, stderr })); });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    assert.equal(fs.existsSync(f.key), false);
    assert.equal(JSON.parse(fs.readFileSync(lock)).pid, process.pid);
  });
  const result = await done; assert.equal(result.code, 0, result.stderr);
  assert.equal(verdicts(f).get('preapproved.json').state, 'trusted');
  assert.equal(fs.existsSync(lock), false);
});
test('native approval writer reclaims a dead owner and refuses a symlinked lock', t => {
  const f = fixture(t), dead = f.call('verify'), lock = join(f.root, 'preapproved.json.lock');
  assert.equal(dead.status, 0, dead.stderr);
  fs.writeFileSync(lock, JSON.stringify({ pid: dead.pid }), { mode: 0o600 });
  const written = f.call('click', 'Mail', 'physical');
  assert.equal(written.status, 0, written.stderr); assert.equal(fs.existsSync(lock), false);
  const target = join(f.root, 'untouched'); fs.writeFileSync(target, 'private'); fs.symlinkSync(target, lock);
  assert.notEqual(f.call('click', 'Calculator', 'physical').status, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), 'private');
  assert.deepEqual(JSON.parse(verdicts(f).get('preapproved.json').content).apps.map(app => app.app), ['Mail']);
});
test('adoption of other settings does not acquire the approval-file lock', t => {
  const f = fixture(t), target = join(f.root, 'untouched'), lock = join(f.root, 'preapproved.json.lock');
  fs.writeFileSync(target, 'private'); fs.symlinkSync(target, lock);
  const result = f.call('adopt', 'adopt', 'ok');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(target, 'utf8'), 'private'); assert.equal(fs.lstatSync(lock).isSymbolicLink(), true);
});
test('native Always allow commits both separately prepared protected-card intents', t => {
  const f = fixture(t), result = f.call('two-intents');
  assert.equal(result.status, 0, result.stderr);
  const row = verdicts(f).get('preapproved.json');
  assert.equal(row.state, 'trusted');
  assert.deepEqual(JSON.parse(row.content).apps.map(app => app.app).sort(), ['Calculator', 'Mail']);
});
test('case 25: an interrupted native write after counter persistence is stale', t => {
  const f = fixture(t); f.seed(); const before = fs.readFileSync(join(f.root, 'preapproved.json'));
  assert.notEqual(f.call('torn', 'preapproved.json').status, 0);
  assert.equal(verdicts(f).get('preapproved.json').state, 'stale'); assert.deepEqual(fs.readFileSync(join(f.root, 'preapproved.json')), before);
});
test('native removal intents seal without a sheet and keep replay counters', t => {
  const f = fixture(t); f.seed(); const old = fs.readFileSync(join(f.root, 'preapproved.json.seal'));
  assert.equal(f.call('apply', 'no-sheet', 'allow', 'remove', 'Calculator').status, 0);
  assert.equal(verdicts(f).get('preapproved.json').state, 'trusted');
  assert.deepEqual(JSON.parse(verdicts(f).get('preapproved.json').content).apps, []);
  assert.equal(JSON.parse(fs.readFileSync(f.key)).counters['preapproved.json'], 2);
  fs.writeFileSync(join(f.root, 'preapproved.json'), v.files[0].content); fs.writeFileSync(join(f.root, 'preapproved.json.seal'), old);
  assert.equal(verdicts(f).get('preapproved.json').state, 'stale');
});
test('a denied sheet does not write and a confirmed site limit is sealed', t => {
  const f = fixture(t); f.seed(); const before = fs.readFileSync(f.key);
  assert.notEqual(f.call('apply', 'cancelled', 'permissions', 'sites', 'https://example.com').status, 0);
  assert.deepEqual(fs.readFileSync(f.key), before);
  assert.equal(f.call('apply', 'confirmed', 'permissions', 'sites', 'https://example.com').status, 0);
  assert.deepEqual(JSON.parse(verdicts(f).get('permissions.json').content).only, ['https://example.com']);
});
test('native readiness carries no settings and waits for the verifier before any key-store read', t => {
  const f = fixture(t);
  const r = run(binary, [f.root, f.key, 'handshake'], { input: 'go\n', stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, 'verified transport\n');
  assert.deepEqual(Object.keys(JSON.parse(r.output[3])).sort(), ['pid', 'settingsReady']);
  assert.equal(JSON.parse(r.output[3]).pid, r.pid); assert.equal(fs.existsSync(f.key), false);
  const refused = run(binary, [f.root, f.key, 'handshake'], { input: 'forged\n', stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  assert.notEqual(refused.status, 0); assert.equal(refused.stdout, ''); assert.equal(fs.existsSync(f.key), false);
});
test('preview menu reports its state without accessing settings or a key store', t => {
  const f = fixture(t), result = f.call('menu-line');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Sealed settings: preview, trust unchanged; adoption comes with the signed release.\n');
  assert.equal(fs.existsSync(f.key), false);
  assert.deepEqual(fs.readdirSync(f.root), []);
});
test('native writes enforce each reader size cap before advancing a counter', t => {
  const f = fixture(t); f.seed(); const before = fs.readFileSync(f.key);
  assert.equal(f.call('oversize').status, 65);
  assert.deepEqual(fs.readFileSync(f.key), before); assert.equal(fs.existsSync(join(f.root, 'turbo-owner.json')), false);
});
}
if (process.argv[1] === fileURLToPath(import.meta.url)) nativeSettingsCases();
