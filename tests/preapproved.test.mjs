import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { loadPreapproved, PreapprovedApps } from '../plugins/sleight/lib/preapproved.mjs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';

const config = { version: 1, apps: [{ app: 'com.apple.calculator', riskLevel: 'medium' }] };
const fixed = join(userInfo().homedir, 'Library/Application Support/sleight/preapproved.json');
test('OS identity is resolved when loading, never while importing', async t => {
  const original = os.userInfo;
  t.after(() => { os.userInfo = original; syncBuiltinESMExports(); });
  let calls = 0;
  os.userInfo = () => { calls++; return { ...original(), homedir: '/private/tmp/account-' + calls }; };
  syncBuiltinESMExports();
  const fresh = await import('../plugins/sleight/lib/preapproved.mjs?identity-at-load');
  assert.equal(calls, 0);
  for (let n = 1; n <= 2; n++) {
    fresh.loadPreapproved({ lstatSync(path) {
      assert.equal(path, `/private/tmp/account-${n}/Library/Application Support/sleight/preapproved.json`);
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    } });
    assert.equal(calls, n);
  }
});
function fixture(t) {
  const bank = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'sleight-preapproved-')));
  t.after(() => fs.rmSync(bank, { recursive: true, force: true }));
  const file = join(bank, 'preapproved.json');
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  // Only the filesystem boundary is substituted. The loader still chooses its path.
  const io = { ...fs };
  for (const name of ['lstatSync', 'openSync', 'realpathSync']) {
    io[name] = (path, ...args) => {
      assert.equal(path, fixed);
      const value = fs[name](file, ...args);
      return name === 'realpathSync' ? (value === file ? fixed : value) : value;
    };
  }
  return { file, bank, io };
}

test('reads only the fixed OS user path despite environment and project settings', async t => {
  const { bank, io } = fixture(t);
  fs.writeFileSync(join(bank, 'settings.json'), JSON.stringify({ env: {
    HOME: bank, SLEIGHT_PREAPPROVED: join(bank, 'settings.json'),
    SLEIGHT_PREAPPROVED_APPS: 'Mail',
  }, preapproved: { version: 1, apps: [{ app: 'Mail', riskLevel: 'high' }] } }));
  const previous = { ...process.env }, cwd = process.cwd();
  t.after(() => { process.env = previous; process.chdir(cwd); });
  process.chdir(bank);
  process.env.HOME = bank;
  process.env.SLEIGHT_PREAPPROVED = join(bank, 'settings.json');
  process.env.SLEIGHT_PREAPPROVED_APPS = 'Mail';
  const fresh = await import('../plugins/sleight/lib/preapproved.mjs?adversarial-home');
  const list = fresh.loadPreapproved(io);
  assert.equal(list.allows('com.apple.calculator', 'low'), true);
  assert.equal(list.allows('Mail', 'low'), false);
});

test('missing list approves nothing', t => {
  const { file, io } = fixture(t); fs.unlinkSync(file);
  assert.equal(loadPreapproved(io).allows('com.apple.calculator', 'low'), false);
});
for (const mode of [0o620, 0o602, 0o666]) {
  test(`refuses writable permissions ${mode.toString(8)}`, t => {
    const { file, io } = fixture(t); fs.chmodSync(file, mode);
    assert.throws(() => loadPreapproved(io), /writable/i);
  });
}
test('refuses a symlink even when its target is private', t => {
  const { file, bank, io } = fixture(t);
  const target = join(bank, 'target'); fs.renameSync(file, target); fs.symlinkSync(target, file);
  assert.throws(() => loadPreapproved(io), /symlink/i);
});
test('refuses a symlinked parent resolving to another location', t => {
  const { io } = fixture(t); io.realpathSync = () => '/tmp/project/preapproved.json';
  assert.throws(() => loadPreapproved(io), /symlink/i);
});
test('refuses another owner and nonregular files', t => {
  const { io } = fixture(t), stat = io.lstatSync(fixed);
  io.lstatSync = () => ({ ...stat, uid: stat.uid + 1, isSymbolicLink: () => false, isFile: () => true });
  assert.throws(() => loadPreapproved(io), /owner/i);
  io.lstatSync = () => ({ ...stat, isSymbolicLink: () => false, isFile: () => false });
  assert.throws(() => loadPreapproved(io), /regular/i);
});
test('validates the opened file again and refuses a replacement', t => {
  const { io } = fixture(t), fstat = io.fstatSync;
  io.fstatSync = fd => { const stat = fstat(fd); stat.ino++; return stat; };
  assert.throws(() => loadPreapproved(io), /changed/i);
});
test('the loaded list is a startup snapshot', t => {
  const { file, io } = fixture(t), list = loadPreapproved(io);
  fs.writeFileSync(file, JSON.stringify({ version: 1, apps: [{ app: 'Mail', riskLevel: 'high' }] }));
  assert.equal(list.allows('com.apple.calculator', 'medium'), true);
  assert.equal(list.allows('Mail', 'low'), false);
});
test('risk ceilings reject higher, missing and unknown risk; identifiers match exactly', () => {
  const list = new PreapprovedApps(config);
  for (const risk of ['low', 'medium']) assert.equal(list.allows('com.apple.calculator', risk), true);
  for (const risk of ['high', undefined, null, 'critical', 0]) assert.equal(list.allows('com.apple.calculator', risk), false);
  for (const app of ['Calculator', 'COM.APPLE.CALCULATOR', '/tmp/com.apple.calculator', '*', 'Mail']) {
    assert.equal(list.allows(app, 'low'), false);
  }
});
test('rejects malformed lists, wildcards, duplicates and unrecognized fields', t => {
  for (const bad of [null, {}, { ...config, version: 2 }, { ...config, apps: ['Calculator'] },
    { ...config, path: '/tmp/elsewhere' }, { ...config, apps: [{ app: '*', riskLevel: 'high' }] },
    { ...config, apps: [{ app: 'Calculator', riskLevel: 'critical' }] },
    { ...config, apps: [{ app: 'Calculator', riskLevel: 'low', persist: 'always' }] },
    { ...config, apps: [config.apps[0], config.apps[0]] }]) {
    assert.throws(() => new PreapprovedApps(bad));
  }
  const { file, io } = fixture(t); fs.writeFileSync(file, '{');
  assert.throws(() => loadPreapproved(io), /Preapproved apps/);
});
