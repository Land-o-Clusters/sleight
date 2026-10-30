import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, chownSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { acceptedInstalledPackage, INSTALLED_ENTRIES, readInstalledConfig } from '../plugins/sleight/lib/direct-browser/installed-config.mjs';
import { packageFiles } from '../plugins/sleight/lib/direct-browser/session-host.mjs';
import { compareVersions, detectBrowser, doctorLines, ensureTurboConfig, executableProblem, inspectConfig, moveCommand, ownerPath, readOwner, statusLines, turboCommand,
  turboDiagnosis, writeConfigFile } from '../plugins/sleight/lib/direct-browser/turbo-setup.mjs';
import { createHash } from 'node:crypto';
import { ensureInstalledTurbo, prepareInstalledStartup, doctor } from '../plugins/sleight/lib/launch.mjs';
import { applicationName } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { writableTreeSkip } from './requirements.mjs';

const realPlugin = fileURLToPath(new URL('../plugins/sleight', import.meta.url));
// Fixture packages must not be group-writable (the package check refuses that), whatever umask the runner has.
process.umask(0o022);
const checkoutSkip = writableTreeSkip(realPlugin);
// A temp home with Library/Application Support/sleight/turbo.json, a fake /Applications, and optional browsers.
function world(t, { chrome = false, helium = false, chromeMode = 0o755 } = {}) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'sleight-turbo-setup-')); trackTemp(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), apps = join(root, 'Applications');
  mkdirSync(home); mkdirSync(apps);
  const install = (app, binary, mode = 0o755) => {
    const dir = join(apps, app + '.app/Contents/MacOS'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, binary), '#!/bin/sh\n'); chmodSync(join(dir, binary), mode);
  };
  if (chrome) install('Google Chrome', 'Google Chrome', chromeMode);
  if (helium) install('Helium', 'Helium');
  const configPath = join(home, 'Library/Application Support/sleight/turbo.json');
  return { root, home, apps, configPath, install, base: { configPath, home, apps, pluginRoot: realPlugin } };
}
function pluginCopy(t, root, name = 'plugin') {
  const copy = join(root, name); cpSync(realPlugin, copy, { recursive: true });
  return copy;
}

const browsers = [
  ['chrome', 'Google Chrome', 'com.google.Chrome', 'Google/Chrome', 'chrome', true],
  ['helium', 'Helium', 'net.imput.helium', 'net.imput.helium', 'chrome', true],
  ['chrome-beta', 'Google Chrome Beta', 'com.google.Chrome.beta', 'Google/Chrome Beta', 'chrome', false],
  ['chrome-dev', 'Google Chrome Dev', 'com.google.Chrome.dev', 'Google/Chrome Dev', 'chrome', false],
  ['chrome-canary', 'Google Chrome Canary', 'com.google.Chrome.canary', 'Google/Chrome Canary', 'chrome', false],
  ['chromium', 'Chromium', 'org.chromium.Chromium', 'Chromium', 'chrome', false],
  ['brave', 'Brave Browser', 'com.brave.Browser', 'BraveSoftware/Brave-Browser', 'brave', false],
  ['edge', 'Microsoft Edge', 'com.microsoft.edgemac', 'Microsoft Edge', 'edge', false],
  ['vivaldi', 'Vivaldi', 'com.vivaldi.Vivaldi', 'Vivaldi', 'vivaldi', false],
];

for (const [id, name, bundleId, profile, scheme, qualified] of browsers) {
  test(`browser table resolves ${id} without probing a real installation`, t => {
    const w = world(t), probed = [];
    const found = detectBrowser({ home: w.home, apps: w.apps, browser: id, problem: path => { probed.push(path); } });
    assert.equal(found.ok, true);
    assert.equal(found.id, id); assert.equal(found.name, name); assert.equal(found.bundleId, bundleId);
    assert.equal(found.executable, join(w.apps, `${name}.app/Contents/MacOS/${name}`));
    assert.equal(found.profileRoot, join(w.home, 'Library/Application Support', profile));
    assert.equal(found.inspectURL, `${scheme}://inspect/#remote-debugging`); assert.equal(found.qualified, qualified);
    assert.deepEqual(probed, [found.executable]);
    assert.equal(applicationName(found.executable), name);
  });
  if (qualified) continue;
  test(`${id} requires the exact qualification override and uses its own inspect address`, { skip: checkoutSkip }, t => {
    const w = world(t), url = `${scheme}://inspect/#remote-debugging`;
    w.install(name, name);
    const run = env => {
      const out = [], code = turboCommand(['on', '--browser', id], { ...w.base, env, out: text => out.push(text) });
      return { code, text: out.join('') };
    };
    for (const env of [{}, { SLEIGHT_TURBO_UNQUALIFIED: '0' }, { SLEIGHT_TURBO_UNQUALIFIED: 'true' }]) {
      const refused = run(env);
      assert.equal(refused.code, 1); assert.match(refused.text, /isn't qualified yet/);
      assert.ok(refused.text.includes(name) && refused.text.includes(url));
      assert.match(refused.text, /DevToolsActivePort/); assert.match(refused.text, /user.*(?:app|document|focus)/i);
      assert.equal(existsSync(w.configPath), false);
    }
    assert.equal(ensureTurboConfig(w.base).reason, 'BROWSER_NOT_FOUND');
    assert.equal(ensureTurboConfig({ ...w.base, browser: id }).reason, 'BROWSER_UNQUALIFIED');
    assert.equal(existsSync(w.configPath), false);
    const allowed = run({ SLEIGHT_TURBO_UNQUALIFIED: '1' });
    assert.equal(allowed.code, 0); assert.ok(allowed.text.includes(url));
    assert.equal(readInstalledConfig(w.configPath, {}), null, 'off without the override');
    const config = readInstalledConfig(w.configPath, { SLEIGHT_TURBO_UNQUALIFIED: '1' });
    assert.equal(config.executable, join(w.apps, `${name}.app/Contents/MacOS/${name}`));
    assert.equal(config.profileRoot, join(w.home, 'Library/Application Support', profile));
    const diagnosis = turboDiagnosis({ ...w.base, helperCache: join(w.root, 'cache') });
    assert.equal(diagnosis.browser.qualified, false);
    assert.ok(doctorLines(diagnosis).join('\n').includes(url));
    assert.equal(existsSync(diagnosis.browser.profileRoot), false);
    chmodSync(config.executable, 0o775);
    const unsafe = run({ SLEIGHT_TURBO_UNQUALIFIED: '1' });
    assert.equal(unsafe.code, 1); assert.match(unsafe.text, /writable by others/);
  });
}

test('doctor lists every known browser, installation and qualification, even when opted out', t => {
  const w = world(t, { chrome: true, helium: true }); w.install('Brave Browser', 'Brave Browser');
  for (const off of [false, true]) {
    if (off) turboCommand(['off'], { ...w.base, out() {} });
    const diagnosis = turboDiagnosis(w.base), text = doctorLines(diagnosis).join('\n');
    assert.equal(diagnosis.browsers.length, browsers.length);
    for (const [id, name, , , , qualified] of browsers) {
      const entry = diagnosis.browsers.find(b => b.id === id);
      assert.equal(entry.installed, ['chrome', 'helium', 'brave'].includes(id));
      assert.equal(entry.qualified, qualified);
      assert.ok(text.includes(`${name}: ${entry.installed ? 'installed' : 'not installed'}, ${qualified ? 'qualified' : 'unqualified'}`), text);
    }
  }
});

test('unqualified refusal preserves an explicit opt-out and usage lists all browser keys', t => {
  const w = world(t), out = [];
  turboCommand(['off'], { ...w.base, out() {} });
  const before = readFileSync(w.configPath, 'utf8');
  assert.equal(turboCommand(['on', '--browser', 'brave'], { ...w.base, env: {}, out() {} }), 1);
  assert.equal(readFileSync(w.configPath, 'utf8'), before);
  assert.equal(turboCommand([], { ...w.base, out: text => out.push(text) }), 2);
  for (const [id] of browsers) assert.ok(out.join('').includes(id));
  for (const browser of ['', '__proto__', 'constructor']) {
    assert.equal(detectBrowser({ home: w.home, apps: w.apps, browser }).code, 'BROWSER_UNKNOWN');
  }
});

test('qualification override never adds an automatic candidate or rewrites an unqualified selection', t => {
  const beforeEnv = process.env.SLEIGHT_TURBO_UNQUALIFIED;
  t.after(() => { if (beforeEnv === undefined) delete process.env.SLEIGHT_TURBO_UNQUALIFIED; else process.env.SLEIGHT_TURBO_UNQUALIFIED = beforeEnv; });
  process.env.SLEIGHT_TURBO_UNQUALIFIED = '1';
  const w = world(t); w.install('Brave Browser', 'Brave Browser');
  assert.equal(detectBrowser({ home: w.home, apps: w.apps }).code, 'BROWSER_NOT_FOUND');
  assert.equal(ensureTurboConfig(w.base).reason, 'BROWSER_NOT_FOUND');
  const copy = pluginCopy(t, w.root), base = { ...w.base, pluginRoot: copy };
  assert.equal(turboCommand(['on', '--browser', 'brave'], { ...base, out() {} }), 0);
  const before = readFileSync(w.configPath, 'utf8'); w.install('Google Chrome', 'Google Chrome');
  writeFileSync(join(copy, 'lib/relay.mjs'), '// changed package\n');
  const result = ensureTurboConfig(base);
  assert.equal(result.action, 'skipped'); assert.equal(result.reason, 'BROWSER_UNQUALIFIED');
  assert.equal(readFileSync(w.configPath, 'utf8'), before);
});

test('a config written for a qualification check loads as off without the override, and no message names the override', t => {
  const beforeEnv = process.env.SLEIGHT_TURBO_UNQUALIFIED;
  t.after(() => { if (beforeEnv === undefined) delete process.env.SLEIGHT_TURBO_UNQUALIFIED; else process.env.SLEIGHT_TURBO_UNQUALIFIED = beforeEnv; });
  const w = world(t); w.install('Brave Browser', 'Brave Browser');
  const copy = pluginCopy(t, w.root), base = { ...w.base, pluginRoot: copy };
  const said = [];
  delete process.env.SLEIGHT_TURBO_UNQUALIFIED;
  turboCommand(['on', '--browser', 'brave'], { ...base, out: text => said.push(text) });
  assert.doesNotMatch(said.join('\n'), /SLEIGHT_TURBO_UNQUALIFIED/);
  process.env.SLEIGHT_TURBO_UNQUALIFIED = '1';
  assert.equal(turboCommand(['on', '--browser', 'brave'], { ...base, out() {} }), 0);
  assert.ok(readInstalledConfig(w.configPath));
  delete process.env.SLEIGHT_TURBO_UNQUALIFIED;
  assert.equal(readInstalledConfig(w.configPath), null);
  assert.ok(readInstalledConfig(w.configPath, { SLEIGHT_TURBO_UNQUALIFIED: '1' }));
});

test('a written file is accepted by the real reader and package check', { skip: checkoutSkip }, t => {
  const w = world(t, { chrome: true });
  const result = ensureTurboConfig(w.base);
  assert.equal(result.action, 'wrote'); assert.equal(result.browser, 'Google Chrome');
  const config = readInstalledConfig(w.configPath);
  assert.equal(config.enabled, true);
  assert.equal(config.executable, join(w.apps, 'Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert.equal(config.profileRoot, join(w.home, 'Library/Application Support/Google/Chrome'));
  assert.deepEqual(Object.keys(config.entryHashes).sort(), [...INSTALLED_ENTRIES].sort());
  assert.deepEqual(config.receipt.files.map(f => f.path).sort(), packageFiles(realPlugin).sort());
  assert.equal(config.receipt.helperMode, 'source'); assert.equal(config.receipt.protocol, 1); assert.equal(config.receipt.node, process.version);
  assert.equal(acceptedInstalledPackage(config, { pluginRoot: realPlugin }).current(), true);
  assert.equal(acceptedInstalledPackage(config).current(), true);
  assert.equal(ensureTurboConfig(w.base).action, 'none');
});

test('the file is private and owned by the user, in a private folder it created', { skip: checkoutSkip }, t => {
  const w = world(t, { helium: true });
  ensureTurboConfig(w.base);
  const stat = lstatSync(w.configPath);
  assert.equal(stat.mode & 0o777, 0o600); assert.equal(stat.uid, process.getuid()); assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(lstatSync(join(w.home, 'Library/Application Support/sleight')).mode & 0o777, 0o700);
});

test('a write never goes through a linked file or folder', t => {
  const w = world(t, { chrome: true });
  const dir = join(w.home, 'Library/Application Support/sleight'), target = join(w.root, 'elsewhere.json');
  mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(target, 'precious', { mode: 0o600 });
  symlinkSync(target, w.configPath);
  assert.throws(() => writeConfigFile(w.configPath, { version: 1, enabled: false }), /TURBO_CONFIG_LINKED/);
  assert.equal(readFileSync(target, 'utf8'), 'precious');
  assert.equal(ensureTurboConfig(w.base).state, 'unsafe');
  assert.equal(readFileSync(target, 'utf8'), 'precious');
  const out = []; assert.equal(turboCommand(['on'], { ...w.base, out: x => out.push(x) }), 1);
  assert.equal(readFileSync(target, 'utf8'), 'precious');
  const real = join(w.root, 'real-dir'), link = join(w.root, 'linked-dir'); mkdirSync(real, { mode: 0o700 }); symlinkSync(real, link);
  assert.throws(() => writeConfigFile(join(link, 'turbo.json'), { version: 1, enabled: false }), /TURBO_DIRECTORY_UNSAFE/);
  assert.deepEqual(readdirSync(real), []);
});

test('an opt-out is never overwritten at startup, however stale the package looks', { skip: checkoutSkip }, t => {
  const w = world(t, { chrome: true });
  assert.equal(turboCommand(['off'], { ...w.base, out() {} }), 0);
  const before = readFileSync(w.configPath, 'utf8');
  assert.deepEqual(JSON.parse(before), { version: 1, enabled: false });
  assert.equal(ensureTurboConfig(w.base).action, 'skipped');
  assert.equal(ensureTurboConfig({ ...w.base, browser: 'chrome' }).state, 'opted-out');
  assert.equal(readFileSync(w.configPath, 'utf8'), before);
  assert.equal(readInstalledConfig(w.configPath), null);
  assert.equal(turboCommand(['on'], { ...w.base, out() {} }), 0);
  assert.equal(JSON.parse(readFileSync(w.configPath, 'utf8')).enabled, true);
});

test('a file the reader would refuse is left alone at startup, opt-out or not', t => {
  const w = world(t, { chrome: true });
  mkdirSync(join(w.home, 'Library/Application Support/sleight'), { recursive: true, mode: 0o700 });
  writeFileSync(w.configPath, JSON.stringify({ version: 1, enabled: false }), { mode: 0o644 });
  const result = ensureTurboConfig(w.base);
  assert.equal(result.action, 'skipped'); assert.equal(result.state, 'unsafe'); assert.match(result.message, /turbo stays off/);
  assert.equal(lstatSync(w.configPath).mode & 0o777, 0o644);
});

test('a stale receipt is rewritten: changed package, changed node, malformed receipt', t => {
  const w = world(t, { chrome: true, helium: true });
  const copy = pluginCopy(t, w.root), base = { ...w.base, pluginRoot: copy };
  assert.equal(ensureTurboConfig(base).action, 'wrote');
  assert.equal(ensureTurboConfig(base).action, 'none');
  writeFileSync(join(copy, 'lib/relay.mjs'), readFileSync(join(copy, 'lib/relay.mjs'), 'utf8') + '\n// plugin update\n');
  assert.equal(inspectConfig(base).state, 'stale');
  const updated = ensureTurboConfig(base);
  assert.equal(updated.action, 'wrote'); assert.equal(updated.reason, 'package-changed');
  assert.equal(acceptedInstalledPackage(readInstalledConfig(w.configPath), { pluginRoot: copy }).current(), true);
  const data = JSON.parse(readFileSync(w.configPath, 'utf8'));
  data.receipt.node = 'v0.0.1'; writeFileSync(w.configPath, JSON.stringify(data), { mode: 0o600 });
  assert.equal(ensureTurboConfig(base).reason, 'node-changed');
  assert.equal(readInstalledConfig(w.configPath).receipt.node, process.version);
  writeFileSync(w.configPath, JSON.stringify({ version: 1, enabled: true }), { mode: 0o600 });
  assert.equal(ensureTurboConfig(base).reason, 'malformed');
  assert.equal(acceptedInstalledPackage(readInstalledConfig(w.configPath), { pluginRoot: copy }).current(), true);
});

test('a rewrite keeps the browser the user chose', t => {
  const w = world(t, { chrome: true, helium: true });
  const copy = pluginCopy(t, w.root), base = { ...w.base, pluginRoot: copy };
  assert.equal(turboCommand(['on', '--browser', 'helium'], { ...base, out() {} }), 0);
  writeFileSync(join(copy, 'lib/relay.mjs'), readFileSync(join(copy, 'lib/relay.mjs'), 'utf8') + '\n// update\n');
  assert.equal(ensureTurboConfig(base).browser, 'Helium');
  assert.match(readInstalledConfig(w.configPath).executable, /Helium\.app/);
});

test('no browser means no file and one clear reason', t => {
  const w = world(t);
  const result = ensureTurboConfig(w.base);
  assert.equal(result.action, 'skipped'); assert.equal(result.reason, 'BROWSER_NOT_FOUND');
  assert.match(result.message, /^turbo stays off: No supported browser found/);
  assert.equal(existsSync(w.configPath), false);
  const out = []; assert.equal(turboCommand(['on'], { ...w.base, out: x => out.push(x) }), 1);
  assert.match(out.join(''), /turbo stays off/); assert.equal(existsSync(w.configPath), false);
});

test('detection prefers Chrome, falls back to Helium, and --browser overrides', t => {
  const both = world(t, { chrome: true, helium: true });
  assert.equal(detectBrowser({ home: both.home, apps: both.apps }).id, 'chrome');
  assert.equal(detectBrowser({ home: both.home, apps: both.apps, browser: 'helium' }).id, 'helium');
  assert.equal(detectBrowser({ home: both.home, apps: both.apps, browser: 'chrome' }).id, 'chrome');
  const onlyHelium = world(t, { helium: true });
  const found = detectBrowser({ home: onlyHelium.home, apps: onlyHelium.apps });
  assert.equal(found.id, 'helium'); assert.equal(found.profileRoot, join(onlyHelium.home, 'Library/Application Support/net.imput.helium'));
  assert.equal(detectBrowser({ home: onlyHelium.home, apps: onlyHelium.apps, browser: 'chrome' }).code, 'BROWSER_NOT_FOUND');
  assert.equal(detectBrowser({ home: onlyHelium.home, apps: onlyHelium.apps, browser: 'firefox' }).code, 'BROWSER_UNKNOWN');
  const out = []; assert.equal(turboCommand(['on', '--browser', 'firefox'], { ...onlyHelium.base, out: x => out.push(x) }), 1);
});

test('a browser executable the connection would refuse is skipped, with the reason', t => {
  const shared = world(t, { chrome: true, helium: true, chromeMode: 0o775 });
  assert.equal(detectBrowser({ home: shared.home, apps: shared.apps }).id, 'helium');
  const only = world(t, { chrome: true, chromeMode: 0o775 });
  const refused = detectBrowser({ home: only.home, apps: only.apps });
  assert.equal(refused.code, 'BROWSER_EXECUTABLE_UNSAFE'); assert.match(refused.message, /writable by others \(mode 775\)/);
  assert.equal(ensureTurboConfig(only.base).action, 'skipped'); assert.equal(existsSync(only.configPath), false);
});

test('a group-writable signed browser passes setup only when its bundle signature checks; world-writable never', t => {
  const w = world(t, { chrome: true, helium: true, chromeMode: 0o775 }), calls = [];
  const chrome = join(w.apps, 'Google Chrome.app/Contents/MacOS/Google Chrome');
  const check = (path, ok) => executableProblem(path, undefined, { appRoots: [w.apps], verify: (...args) => { calls.push(args); return ok; } });
  assert.equal(check(chrome, true), undefined);
  assert.match(calls[0][1], /^identifier "com\.google\.Chrome" and anchor apple generic .*"EQHXZ8M8AV"$/);
  assert.match(check(chrome, false), /writable by others \(mode 775\), and its signature is not Google Chrome's from team EQHXZ8M8AV/);
  calls.length = 0; chmodSync(chrome, 0o777);
  assert.match(check(chrome, true), /^writable by others \(mode 777\)$/); assert.equal(calls.length, 0);
  w.install('Brave Browser', 'Brave Browser', 0o775);
  assert.match(check(join(w.apps, 'Brave Browser.app/Contents/MacOS/Brave Browser'), true), /^writable by others \(mode 775\)$/, 'no Team ID, no relaxation');
  assert.equal(calls.length, 0);
  chmodSync(chrome, 0o775);
  assert.match(executableProblem(chrome, undefined, { appRoots: ['/Applications'], verify: () => true }), /^writable by others/, 'outside the app roots');
  assert.match(doctorLines({ state: 'current', browsers: [], browser: { name: 'Google Chrome', executable: chrome, qualified: true }, executableProblem: check(chrome, false), helpers: true, port: true }).join('\n'),
    /fix: reinstall Google Chrome from its maker/);
  // The verdict shape: a refusal for Finder metadata names the xattr fix instead of blaming the signature.
  assert.equal(check(chrome, { ok: true }), undefined);
  assert.match(check(chrome, { ok: false, reason: 'signature' }), /and its signature is not Google Chrome's from team EQHXZ8M8AV$/);
  const metadata = check(chrome, { ok: false, reason: 'detritus' }), bundle = join(w.apps, 'Google Chrome.app');
  assert.equal(metadata, `writable by others (mode 775), and codesign --strict refuses its bundle for Finder metadata rather than its signature (xattr -rc "${bundle}" clears it)`);
  const doctor = doctorLines({ state: 'current', browsers: [], browser: { name: 'Google Chrome', executable: chrome, qualified: true }, executableProblem: metadata, helpers: true, port: true }).join('\n');
  assert.match(doctor, /PROBLEM {3}browser: Google Chrome, .*Finder metadata/);
  assert.ok(doctor.includes(`fix: xattr -rc "${bundle}" strips the metadata`), doctor);
  assert.doesNotMatch(doctor, /reinstall Google Chrome/);
});

test('setup tolerates group write only for admin (80) or the user\'s primary group', t => {
  const w = world(t, { chrome: true, chromeMode: 0o775 }), chrome = join(w.apps, 'Google Chrome.app/Contents/MacOS/Google Chrome');
  const gid = lstatSync(chrome).gid, check = primaryGid => executableProblem(chrome, undefined, { appRoots: [w.apps], verify: () => true, primaryGid });
  assert.equal(check(gid), undefined, 'the user\'s own primary group');
  assert.match(check(gid + 1000), new RegExp(`^writable by others \\(mode 775\\) through group ${gid}, which is neither admin nor your own group$`),
    'staff (or whatever group the file has) when the user\'s primary group is another');
  if (process.platform === 'darwin' && process.getgroups().includes(12)) {
    chownSync(chrome, -1, 12);
    assert.match(check(20), /through group 12, which is neither admin nor your own group$/, 'everyone');
  }
  if (process.platform === 'darwin' && process.getgroups().includes(80)) {
    chownSync(chrome, -1, 80); assert.equal(check(gid + 1000), undefined, 'admin');
  }
});

test('the group-write relaxation never covers Chrome Beta, Dev or Canary, even with SLEIGHT_TURBO_UNQUALIFIED=1', t => {
  const w = world(t), before = process.env.SLEIGHT_TURBO_UNQUALIFIED, calls = [];
  t.after(() => { if (before === undefined) delete process.env.SLEIGHT_TURBO_UNQUALIFIED; else process.env.SLEIGHT_TURBO_UNQUALIFIED = before; });
  process.env.SLEIGHT_TURBO_UNQUALIFIED = '1';
  for (const name of ['Google Chrome Beta', 'Google Chrome Dev', 'Google Chrome Canary']) {
    w.install(name, name, 0o775);
    assert.match(executableProblem(join(w.apps, `${name}.app/Contents/MacOS/${name}`), undefined,
      { appRoots: [w.apps], verify: () => { calls.push(name); return true; } }), /^writable by others \(mode 775\)$/, name);
  }
  assert.deepEqual(calls, []);
});

test('writes are atomic: no partial file, no temp leftovers, the old file survives a failed write', { skip: checkoutSkip }, t => {
  const w = world(t, { chrome: true });
  ensureTurboConfig(w.base);
  const before = readFileSync(w.configPath, 'utf8'), dir = join(w.home, 'Library/Application Support/sleight');
  const circular = {}; circular.self = circular;
  assert.throws(() => writeConfigFile(w.configPath, circular), /circular|cyclic/i);
  assert.equal(readFileSync(w.configPath, 'utf8'), before);
  assert.deepEqual(readdirSync(dir).sort(), ['turbo-owner.json', 'turbo.json']);
  writeConfigFile(w.configPath, { version: 1, enabled: false });
  assert.deepEqual(readdirSync(dir).sort(), ['turbo-owner.json', 'turbo.json']);
  assert.equal(lstatSync(w.configPath).mode & 0o777, 0o600);
});

// Two copies of sleight on one Mac: the owner's install and a dev build, or an update while an older session still runs.
// B differs from A by one line, so A's receipt is package-changed for B. B sits in a folder with a space to check the quoting.
function twoCopies(t, options = { chrome: true, helium: true }) {
  const w = world(t, options), a = pluginCopy(t, w.root, 'install'), b = pluginCopy(t, w.root, 'dev build');
  writeFileSync(join(b, 'lib/relay.mjs'), readFileSync(join(b, 'lib/relay.mjs'), 'utf8') + '\n// dev build\n');
  const version = JSON.parse(readFileSync(join(realPlugin, '.claude-plugin/plugin.json'), 'utf8')).version;
  return { w, a, b, version, A: { ...w.base, pluginRoot: a }, B: { ...w.base, pluginRoot: b }, bytes: () => readFileSync(w.configPath, 'utf8') };
}

test('two live copies starting in turns never flip the receipt; the second names the turbo on that moves it', t => {
  const { w, a, b, version, A, B, bytes } = twoCopies(t);
  assert.equal(ensureTurboConfig(A).action, 'wrote');
  const written = bytes(), owner = readOwner(w.configPath);
  assert.equal(owner.pluginRoot, a); assert.equal(owner.sleight, version); assert.equal(owner.version, 1);
  assert.equal(owner.sha256, createHash('sha256').update(readFileSync(w.configPath)).digest('hex'));
  const sidecar = lstatSync(ownerPath(w.configPath));
  assert.equal(sidecar.mode & 0o777, 0o600); assert.equal(sidecar.uid, process.getuid()); assert.ok(sidecar.isFile() && !sidecar.isSymbolicLink());
  const ownerBytes = readFileSync(ownerPath(w.configPath), 'utf8');
  for (let round = 0; round < 3; round++) {
    const second = ensureTurboConfig(B);
    assert.equal(second.action, 'skipped'); assert.equal(second.state, 'stale'); assert.equal(second.reason, 'RECEIPT_FOR_OTHER_PACKAGE');
    assert.equal(second.owner, a);
    assert.equal(second.message, `turbo stays off in this copy of sleight: turbo.json's receipt belongs to sleight ${version} at ${a}, which is ` +
      `still installed. To move turbo to this copy, run '${b}/bin/sleight-mcp' turbo on --browser chrome (the other copy then stays off until its own turbo on).`);
    assert.equal(ensureTurboConfig(A).action, 'none');
    assert.equal(bytes(), written); assert.equal(readFileSync(ownerPath(w.configPath), 'utf8'), ownerBytes);
  }
  assert.equal(acceptedInstalledPackage(readInstalledConfig(w.configPath), { pluginRoot: a }).current(), true);
  const d = turboDiagnosis({ ...B, helperCache: join(w.root, 'cache') });
  assert.equal(d.reason, 'RECEIPT_FOR_OTHER_PACKAGE');
  assert.match(doctorLines(d).join('\n'), new RegExp(`PROBLEM +config: the receipt belongs to sleight ${version.replaceAll('.', '\\.')} at .*install, which is still installed\\n +fix: '.*dev build/bin/sleight-mcp' turbo on --browser chrome moves turbo to this copy`));
  assert.doesNotMatch(doctorLines(d).join('\n'), /start a new Claude Code session/);
  assert.match(statusLines(d).join('\n'), /turbo +off \(the receipt belongs to sleight .* at .*install; '.*dev build\/bin\/sleight-mcp' turbo on --browser chrome moves it here\)/);
  assert.equal(turboDiagnosis({ ...A, helperCache: join(w.root, 'cache') }).owner, undefined);
});

test('the move command keeps a browser the user chose and leaves a plain path unquoted', t => {
  const { w, a, A, B } = twoCopies(t);
  assert.equal(turboCommand(['on', '--browser', 'helium'], { ...A, out() {} }), 0);
  assert.match(ensureTurboConfig(B).message, /turbo on --browser helium \(/);
  assert.equal(moveCommand(a), `${a}/bin/sleight-mcp turbo on`);
  assert.equal(moveCommand(join(w.root, "it's")), `'${w.root}/it'\\''s/bin/sleight-mcp' turbo on`);
});

test('turbo on is what moves the receipt between live copies, and the copy it left then waits', t => {
  const { w, a, b, A, B } = twoCopies(t);
  ensureTurboConfig(A);
  assert.equal(turboCommand(['on', '--browser', 'chrome'], { ...B, out() {} }), 0);
  assert.equal(readOwner(w.configPath).pluginRoot, b);
  assert.equal(acceptedInstalledPackage(readInstalledConfig(w.configPath), { pluginRoot: b }).current(), true);
  const before = readFileSync(w.configPath, 'utf8');
  const left = ensureTurboConfig(A);
  assert.equal(left.reason, 'RECEIPT_FOR_OTHER_PACKAGE'); assert.equal(left.owner, b);
  assert.ok(left.message.includes(`run ${a}/bin/sleight-mcp turbo on --browser chrome`), left.message);
  assert.equal(ensureTurboConfig(B).action, 'none'); assert.equal(readFileSync(w.configPath, 'utf8'), before);
  assert.equal(turboCommand(['on', '--browser', 'chrome'], { ...A, out() {} }), 0);
  assert.equal(readOwner(w.configPath).pluginRoot, a); assert.equal(ensureTurboConfig(B).reason, 'RECEIPT_FOR_OTHER_PACKAGE');
});

test('a normal update still takes the receipt over: the old copy is gone, orphaned or changed', t => {
  for (const retire of [root => rmSync(root, { recursive: true, force: true }), root => writeFileSync(join(root, '.orphaned_at'), '1792529263995'),
    root => writeFileSync(join(root, 'lib/relay.mjs'), '// a later version in place\n')]) {
    const { w, b, A, B } = twoCopies(t);
    ensureTurboConfig(A); retire(A.pluginRoot);
    const updated = ensureTurboConfig(B);
    assert.equal(updated.action, 'wrote'); assert.equal(updated.reason, 'package-changed');
    assert.equal(readOwner(w.configPath).pluginRoot, b);
    assert.equal(acceptedInstalledPackage(readInstalledConfig(w.configPath), { pluginRoot: b }).current(), true);
  }
});

const setVersion = (root, version) => {
  const file = join(root, '.claude-plugin/plugin.json'), manifest = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...manifest, version }, null, 2) + '\n');
};

test('the newer copy wins: a lower-version owner is replaced with no .orphaned_at marker, and the doctor stops naming it', t => {
  const { w, b, A, B } = twoCopies(t);
  setVersion(A.pluginRoot, '1.4.0'); setVersion(b, '1.4.1');
  ensureTurboConfig(A);
  assert.equal(existsSync(join(A.pluginRoot, '.orphaned_at')), false);
  assert.equal(turboDiagnosis({ ...B, helperCache: join(w.root, 'cache') }).owner, undefined);
  const updated = ensureTurboConfig(B);
  assert.equal(updated.action, 'wrote'); assert.equal(updated.reason, 'package-changed');
  assert.equal(readOwner(w.configPath).pluginRoot, b); assert.equal(readOwner(w.configPath).sleight, '1.4.1');
  assert.equal(acceptedInstalledPackage(readInstalledConfig(w.configPath), { pluginRoot: b }).current(), true);
  // The older copy now sees a newer owner and leaves it.
  assert.equal(ensureTurboConfig(A).reason, 'RECEIPT_FOR_OTHER_PACKAGE');
  assert.equal(ensureTurboConfig(B).action, 'none');
});

test('versions compare as semver, not as text: 1.10.0 is newer than 1.9.0 and a prerelease is older than its release', t => {
  const { b, A, B } = twoCopies(t);
  setVersion(A.pluginRoot, '1.9.0'); setVersion(b, '1.10.0');
  ensureTurboConfig(A);
  assert.equal(ensureTurboConfig(B).action, 'wrote');
  const rc = twoCopies(t);
  setVersion(rc.A.pluginRoot, '1.4.1-rc.1'); setVersion(rc.b, '1.4.1');
  ensureTurboConfig(rc.A);
  assert.equal(ensureTurboConfig(rc.B).action, 'wrote');
  assert.equal(compareVersions('1.4.1-rc.2', '1.4.1-rc.10') < 0, true);
  assert.equal(compareVersions('1.4.1+build.5', '1.4.1'), 0);
  assert.equal(compareVersions('1.4', '1.4.0'), 0);
  assert.equal(compareVersions('1.4.1', 'dev'), null);
});

test('two copies at the same version never flip, whichever starts first and whatever build text follows the version', t => {
  const { w, a, b, A, B } = twoCopies(t);
  setVersion(A.pluginRoot, '1.4.1'); setVersion(b, '1.4.1+dev.2');
  ensureTurboConfig(A);
  const written = readFileSync(w.configPath, 'utf8');
  for (let round = 0; round < 3; round++) {
    const second = ensureTurboConfig(B);
    assert.equal(second.reason, 'RECEIPT_FOR_OTHER_PACKAGE'); assert.equal(second.owner, a);
    assert.equal(ensureTurboConfig(A).action, 'none');
  }
  assert.equal(readFileSync(w.configPath, 'utf8'), written);
});

test('a higher-version owner is left alone and named in the message', t => {
  const { w, a, A, B } = twoCopies(t);
  setVersion(A.pluginRoot, '2.0.0'); setVersion(B.pluginRoot, '1.4.1');
  ensureTurboConfig(A);
  const written = readFileSync(w.configPath, 'utf8'), result = ensureTurboConfig(B);
  assert.equal(result.action, 'skipped'); assert.equal(result.reason, 'RECEIPT_FOR_OTHER_PACKAGE'); assert.equal(result.owner, a);
  assert.match(result.message, new RegExp(`belongs to sleight 2\\.0\\.0 at ${a.replaceAll('.', '\\.')}, which is still installed`));
  assert.equal(readFileSync(w.configPath, 'utf8'), written);
  assert.equal(readOwner(w.configPath).pluginRoot, a);
});

test('a sidecar that cannot be written is reported in the start result and by turbo on, and the receipt still stands', t => {
  const w = world(t, { chrome: true }), sidecar = ownerPath(w.configPath);
  mkdirSync(sidecar, { recursive: true }); writeFileSync(join(sidecar, 'keep'), 'x');
  const result = ensureTurboConfig(w.base);
  assert.equal(result.action, 'wrote'); assert.equal(result.ownerWritten, false);
  assert.match(result.message, /turbo is on with Google Chrome\..*turbo-owner\.json note .* could not be saved/);
  assert.equal(inspectConfig(w.base).state, 'current');
  const lines = []; assert.equal(turboCommand(['on', '--browser', 'chrome'], { ...w.base, out: text => lines.push(text) }), 0);
  assert.match(lines.join(''), /turbo-owner\.json note .* could not be saved/);
  rmSync(sidecar, { recursive: true });
  rmSync(w.configPath);
  const healthy = ensureTurboConfig(w.base);
  assert.equal(healthy.action, 'wrote'); assert.equal(healthy.ownerWritten, true); assert.doesNotMatch(healthy.message, /turbo-owner/);
});

test('a tampered, missing or out-of-date sidecar falls back to rewriting the receipt', t => {
  const { w, a, b, A, B } = twoCopies(t), sidecar = ownerPath(w.configPath);
  const edit = change => { const data = JSON.parse(readFileSync(sidecar, 'utf8')); change(data); writeFileSync(sidecar, JSON.stringify(data), { mode: 0o600 }); };
  const cases = {
    missing: () => rmSync(sidecar),
    'group-readable': () => chmodSync(sidecar, 0o644),
    linked: () => { const real = join(w.root, 'elsewhere.json'); writeFileSync(real, readFileSync(sidecar), { mode: 0o600 }); rmSync(sidecar); symlinkSync(real, sidecar); },
    'other bytes': () => edit(data => { data.sha256 = '0'.repeat(64); }),
    'extra key': () => edit(data => { data.accepted = true; }),
    'relative root': () => edit(data => { data.pluginRoot = 'install'; }),
    'not JSON': () => writeFileSync(sidecar, '{', { mode: 0o600 }),
    'malformed version text': () => edit(data => { data.sleight = '1.4.0 \n; rm -rf'; }),
    'version that is not text': () => edit(data => { data.sleight = 140; }),
    'over-long root': () => edit(data => { data.pluginRoot = '/' + 'a'.repeat(2000); }),
    // A 1.4.0 server rewrites turbo.json without a sidecar, so the sidecar it left no longer matches the file's bytes.
    'turbo.json rewritten without it': () => writeConfigFile(w.configPath, { ...JSON.parse(readFileSync(w.configPath, 'utf8')), profileRoot: join(w.home, 'p') }),
  };
  for (const [name, tamper] of Object.entries(cases)) {
    assert.equal(turboCommand(['on', '--browser', 'chrome'], { ...A, out() {} }), 0, name);
    assert.equal(readOwner(w.configPath)?.pluginRoot, a, name);
    tamper();
    const result = ensureTurboConfig(B);
    assert.equal(result.action, 'wrote', name); assert.equal(result.reason, 'package-changed', name);
    assert.equal(readOwner(w.configPath)?.pluginRoot, b, name);
    assert.equal(lstatSync(sidecar).isSymbolicLink(), false, name);
  }
  assert.equal(readFileSync(join(w.root, 'elsewhere.json'), 'utf8').includes(a), true, 'a linked sidecar is replaced, never written through');
});

test('a node change for the same copy still rewrites, and the sidecar follows the rewrite', t => {
  const { w, a, A } = twoCopies(t);
  ensureTurboConfig(A);
  const data = JSON.parse(readFileSync(w.configPath, 'utf8')); data.receipt.node = 'v0.0.1';
  writeConfigFile(w.configPath, data);
  const result = ensureTurboConfig(A);
  assert.equal(result.action, 'wrote'); assert.equal(result.reason, 'node-changed');
  assert.equal(readOwner(w.configPath).pluginRoot, a);
  assert.equal(readOwner(w.configPath).sha256, createHash('sha256').update(readFileSync(w.configPath)).digest('hex'));
});

test('status and doctor report each state with the one fix', { skip: checkoutSkip }, t => {
  const none = world(t);
  assert.match(doctorLines(turboDiagnosis(none.base)).join('\n'), /not set up yet[\s\S]*fix: No supported browser found/);
  const w = world(t, { helium: true }), cache = join(w.root, 'cache');
  assert.match(doctorLines(turboDiagnosis({ ...w.base, helperCache: cache })).join('\n'), /fix: start a new Claude Code session, or run sleight-mcp turbo on/);
  ensureTurboConfig(w.base);
  let d = turboDiagnosis({ ...w.base, helperCache: cache }), text = doctorLines(d).join('\n');
  assert.equal(d.enabled, true); assert.equal(d.port, false); assert.equal(d.helpers, false);
  assert.match(text, /ok +config: on/); assert.match(text, /ok +browser: Helium/);
  assert.match(text, /PROBLEM +native helpers: not compiled yet\n +fix: .*xcode-select --install/);
  assert.match(text, /PROBLEM +remote debugging: off[\s\S]*fix: turn on remote debugging in Helium: chrome:\/\/inspect\/#remote-debugging/);
  assert.match(statusLines(d).join('\n'), /turbo +on\nbrowser +Helium\nprofile +.*net\.imput\.helium\nremote debugging +off/);
  mkdirSync(d.browser.profileRoot, { recursive: true }); writeFileSync(join(d.browser.profileRoot, 'DevToolsActivePort'), '9222\n/devtools/browser/x\n');
  d = turboDiagnosis({ ...w.base, helperCache: cache }); text = doctorLines(d).join('\n');
  assert.equal(d.port, true); assert.match(text, /ok +remote debugging: on/); assert.doesNotMatch(text, /turn on remote debugging/);
  assert.match(statusLines(d).join('\n'), /remote debugging +on/);
  const copy = pluginCopy(t, w.root), stale = { ...w.base, pluginRoot: copy };
  // The copy takes the receipt first: a receipt the unchanged real package issued would name a live other copy.
  turboCommand(['on', '--browser', 'helium'], { ...stale, out() {} }); writeFileSync(join(copy, 'lib/relay.mjs'), 'changed\n');
  assert.match(doctorLines(turboDiagnosis(stale)).join('\n'), /PROBLEM +config: receipt stale \(plugin files changed\)\n +fix: start a new Claude Code session/);
  turboCommand(['off'], { ...w.base, out() {} });
  assert.match(doctorLines(turboDiagnosis(w.base)).join('\n'), /you turned turbo off\n +fix: sleight-mcp turbo on/);
  assert.match(statusLines(turboDiagnosis(w.base)).join('\n'), /turbo +off \(you turned it off\)/);
});

test('turbo commands: on, off, status, usage', { skip: checkoutSkip }, t => {
  const w = world(t, { chrome: true, helium: true });
  const run = args => { const out = []; const code = turboCommand(args, { ...w.base, out: x => out.push(x) }); return { code, text: out.join('') }; };
  assert.equal(run([]).code, 2); assert.equal(run(['bogus']).code, 2); assert.equal(run(['off', '--browser', 'chrome']).code, 2); assert.equal(run(['status', 'x']).code, 2);
  assert.match(run(['status']).text, /turbo +off \(not set up yet\)/);
  const on = run(['on', '--browser', 'helium']);
  assert.equal(on.code, 0); assert.match(on.text, /turbo is on with Helium[\s\S]*chrome:\/\/inspect\/#remote-debugging/);
  assert.match(run(['status']).text, /turbo +on\nbrowser +Helium/);
  assert.match(run(['off']).text, /turbo is off/);
  assert.match(run(['status']).text, /turbo +off \(you turned it off\)/);
  assert.equal(run(['on']).code, 0); assert.match(run(['status']).text, /browser +Google Chrome/);
});

test('startup hashing time on the real package', { skip: checkoutSkip }, t => {
  const w = world(t, { chrome: true });
  const first = ensureTurboConfig(w.base), second = ensureTurboConfig(w.base);
  t.diagnostic(`files ${packageFiles(realPlugin).length}; absent -> written ${first.ms} ms; current check ${second.ms} ms`);
  assert.equal(first.action, 'wrote'); assert.equal(second.action, 'none');
  assert.ok(first.ms < 5000 && second.ms < 5000);
});

test('launcher startup: ensure runs before the bridge, only when asked, and never blocks startup', async t => {
  const order = [];
  await prepareInstalledStartup(() => { order.push('bridge'); return null; }, () => {}, { ensure: async () => { order.push('ensure'); } });
  assert.deepEqual(order, ['ensure', 'bridge']);
  order.length = 0;
  await prepareInstalledStartup(() => { order.push('bridge'); return null; }, () => {});
  assert.deepEqual(order, ['bridge']);
  const result = await prepareInstalledStartup(() => null, () => {}, { ensure: async () => { throw Error('SETUP_BROKE'); } });
  assert.equal(result.directBrowser, undefined); assert.equal(result.turboUnavailable, undefined);
});

test('launcher startup writes when absent or stale, logs one line, and leaves an opt-out alone', async t => {
  const w = world(t, { chrome: true }), copy = pluginCopy(t, w.root), lines = [];
  const ensure = log => ensureInstalledTurbo(log, { ...w.base, pluginRoot: copy });
  await prepareInstalledStartup(() => null, () => {}, { ensure, log: x => lines.push(x) });
  assert.equal(readInstalledConfig(w.configPath).enabled, true);
  assert.equal(lines.length, 1); assert.match(lines[0], /^sleight: turbo is on with Google Chrome/);
  await prepareInstalledStartup(() => null, () => {}, { ensure, log: x => lines.push(x) });
  assert.equal(lines.length, 1);
  writeFileSync(join(copy, 'lib/relay.mjs'), readFileSync(join(copy, 'lib/relay.mjs'), 'utf8') + '\n// update\n');
  await prepareInstalledStartup(() => null, () => {}, { ensure, log: x => lines.push(x) });
  assert.equal(lines.length, 2);
  assert.equal(acceptedInstalledPackage(readInstalledConfig(w.configPath), { pluginRoot: copy }).current(), true);
  turboCommand(['off'], { ...w.base, pluginRoot: copy, out() {} });
  await prepareInstalledStartup(() => null, () => {}, { ensure, log: x => lines.push(x) });
  assert.equal(lines.length, 2); assert.equal(readInstalledConfig(w.configPath), null);
  assert.deepEqual(JSON.parse(readFileSync(w.configPath, 'utf8')), { version: 1, enabled: false });
});

test('launcher startup logs one line and keeps the engine when setup cannot write', async t => {
  const none = world(t), lines = [];
  await prepareInstalledStartup(() => null, () => {}, { ensure: log => ensureInstalledTurbo(log, none.base), log: x => lines.push(x) });
  assert.equal(lines.length, 1); assert.match(lines[0], /turbo stays off: No supported browser found/); assert.equal(existsSync(none.configPath), false);
  const w = world(t, { chrome: true }), failures = [];
  const directory = dirname(w.configPath), marker = join(directory, 'owned-marker');
  mkdirSync(directory, { recursive: true, mode: 0o700 }); writeFileSync(marker, 'owned write obstruction', { mode: 0o600 });
  chmodSync(directory, 0o770);
  let result, bridgeStarted = false;
  const startup = await prepareInstalledStartup(() => { bridgeStarted = true; return null; }, () => assert.fail('setup failure must retain the engine'), {
    ensure: async log => { result = await ensureInstalledTurbo(log, w.base); }, log: x => failures.push(x),
  });
  assert.equal(result.action, 'failed'); assert.equal(failures.length, 1); assert.match(failures[0], /turbo stays off: could not write turbo\.json/);
  assert.equal(result.reason, 'TURBO_DIRECTORY_UNSAFE');
  assert.equal(existsSync(w.configPath), false);
  assert.equal(readFileSync(marker, 'utf8'), 'owned write obstruction');
  assert.equal(bridgeStarted, true); assert.equal(startup.directBrowser, undefined); assert.equal(startup.turboUnavailable, undefined);
});

test('doctor prints the turbo section after its version, read-only', async t => {
  const w = world(t, { helium: true }), lines = [];
  const code = await doctor({ env: { CODEX_HOME: '/no-such-sleight-home', SLEIGHT_CHATGPT_APP: '/no-such-ChatGPT.app' }, log: x => lines.push(x),
    turbo: async () => doctorLines(turboDiagnosis(w.base)) });
  assert.equal(code, 1);
  assert.match(lines[0], /^sleight \d+\.\d+\.\d+$/);
  assert.equal(lines[1], 'turbo (direct browser path)'); assert.match(lines.join('\n'), /not set up yet/);
  assert.equal(existsSync(w.configPath), false);
});

test('the package walk leaves out what Claude Code writes into a plugin folder, and nothing else', t => {
  const root = mkdtempSync(join(tmpdir(), 'turbo-walk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, body] of [['host.mjs', 'x'], ['.in_use/4242', ''], ['.claude-plugin/plugin.json', '{}'], ['.claude-plugin/types/a.d.ts', ''], ['lib/.in_use', 'y']]) {
    mkdirSync(join(root, dirname(path)), { recursive: true }); writeFileSync(join(root, path), body, { mode: 0o644 });
  }
  assert.deepEqual(packageFiles(root).sort(), ['.claude-plugin/plugin.json', 'host.mjs', 'lib/.in_use']);
});
