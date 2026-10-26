// VC10: high-stakes settings changes wait for macOS's own Touch ID or password sheet (lib/person-confirm.mjs, the consent
// host's --confirm-person mode). Every confirmation here is injected or a stand-in evaluator: no test shows a real sheet. The
// only real host runs are the --confirm-person-check mode, which prints the reason and exits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confirmationLine, confirmationRefusal, helperConfirm, highStakesChange } from '../plugins/sleight/lib/person-confirm.mjs';
import { insideSettings, settingsCommand } from '../plugins/sleight/lib/person-gate.mjs';
import { replayCommand, settingsChangeRefusal } from '../plugins/sleight/lib/launch.mjs';
import { permissionsCommand } from '../plugins/sleight/lib/permissions-command.mjs';
import { permissionsPath } from '../plugins/sleight/lib/permissions.mjs';
import { macCommandSkip } from './requirements.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';

const hostSource = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
const confirmSource = readFileSync(new URL('../plugins/sleight/lib/person-confirm.mjs', import.meta.url), 'utf8');
const launchSource = readFileSync(new URL('../plugins/sleight/lib/launch.mjs', import.meta.url), 'utf8');
const tempHome = t => { const home = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-person-confirm-'))); t.after(() => rmSync(home, { recursive: true, force: true })); return home; };

// Every high-stakes path the CLI has, with the key and the only argument text that reaches the sheet.
const HIGH = [
  [['turbo', 'on'], { key: 'turbo-on' }],
  [['turbo', 'on', '--browser', 'chrome'], { key: 'turbo-on', subject: 'Google Chrome' }],
  [['turbo', 'on', '--browser', 'helium'], { key: 'turbo-on', subject: 'Helium' }],
  [['turbo', 'on', '--browser', 'Approve this now'], { key: 'turbo-on' }],
  [['turbo', 'app', 'on', 'com.microsoft.VSCode'], { key: 'turbo-app-on', subject: 'com.microsoft.VSCode' }],
  [['turbo', 'app', 'on', 'not a bundle id'], { key: 'turbo-app-on' }],
  [['permissions', 'unblock', 'com.example.App'], { key: 'permissions-unblock', subject: 'com.example.App' }],
  [['permissions', 'unblock', 'https://example.com'], { key: 'permissions-unblock' }],
  [['permissions', 'revoke', 'all'], { key: 'permissions-revoke-all' }],
  [['permissions', 'revoke', 'turbo'], { key: 'permissions-revoke' }],
  [['permissions', 'revoke', 'com.example.App'], { key: 'permissions-revoke', subject: 'com.example.App' }],
  [['permissions', 'revoke', 'https://example.com'], { key: 'permissions-revoke' }],
  [['permissions', 'sites', 'only', 'https://example.com'], { key: 'permissions-sites' }],
  [['permissions', 'sites', 'all'], { key: 'permissions-sites' }],
  [['permissions', 'repair'], { key: 'permissions-repair' }],
  [['permissions', 'repair', '--discard'], { key: 'permissions-repair' }],
  [['allow', 'remove', 'com.apple.TextEdit'], { key: 'allow-remove', subject: 'com.apple.TextEdit' }],
  [['allow', 'remove', 'TextEdit'], { key: 'allow-remove' }],
  [['routine', 'add', 'script.json', '--every', '1h'], { key: 'routine-add' }],
  [['routine', 'unlock', 'r1'], { key: 'routine-unlock' }],
  [['watch', 'https://example.com', '--find', 'x', '--every', '1h'], { key: 'watch-add' }],
  [['watch', 'record', 't.jsonl', '--every', '1h'], { key: 'watch-add' }],
  [['watch', 'unlock', 'w1'], { key: 'watch-unlock' }],
  // Forms the modules reject as usage still ask, so a writer added later is covered before anyone lists it.
  [['turbo'], { key: 'settings' }], [['turbo', 'frobnicate'], { key: 'settings' }], [['permissions', 'frobnicate'], { key: 'settings' }],
  [['allow', 'add', 'TextEdit'], { key: 'settings' }], [['routine', 'frobnicate'], { key: 'settings' }], [['watch', 'frobnicate'], { key: 'settings' }],
];
// Settings changes that only narrow what sleight does or change how it looks: the terminal check alone.
const LOW = [
  ['hand', 'on'], ['hand', 'off'], ['hand', 'capture', 'visible'], ['hand'], ['cursor', 'style', 'ring'], ['cursor', 'import', '/tmp/x', '--yes'],
  ['cursor', 'remove', 'test-cat'], ['turbo', 'off'], ['turbo', 'app', 'off', 'com.example.app'], ['permissions', 'block', 'com.example.app'],
  ['permissions', 'block', 'https://example.com'], ['permissions', 'memory', 'clear', 'all'], ['routine', 'remove', 'r1'], ['routine', '--remove', 'r1'],
  ['watch', 'remove', 'w1'],
];
const READS = [['hand', 'status'], ['turbo', 'status'], ['permissions'], ['permissions', 'list'], ['allow', 'list'], ['routine', 'list'],
  ['routine', 'run-now', 'r1'], ['watch', 'list'], ['watch', 'run-now', 'w1'], ['stats'], ['record', 'x.jsonl'], []];

test('every high-stakes form has its key, low-stakes and read-only forms have none', () => {
  for (const [args, expected] of HIGH) assert.deepEqual(highStakesChange(args), expected, args.join(' '));
  for (const args of [...LOW, ...READS]) assert.equal(highStakesChange(args), undefined, args.join(' '));
  for (const [args] of HIGH) assert.equal(typeof settingsCommand(args), 'string', `${args.join(' ')} also passes the terminal check first`);
  assert.equal(highStakesChange('turbo on'), undefined);
});

test('the sheet text comes only from the host\'s table: every key and browser name here is in it', () => {
  const keys = new Set(HIGH.map(([, change]) => change.key));
  const table = /let personConfirmReasons[^=]*= \[([\s\S]*?)\n\]/.exec(hostSource)?.[1];
  assert.ok(table);
  for (const key of keys) assert.match(table, new RegExp(`"${key}": \\(`), key);
  const names = [.../const BROWSER_NAMES = \{([\s\S]*?)\};/.exec(confirmSource)[1].matchAll(/: '([^']+)'/g)].map(m => m[1]);
  const swiftNames = /let personConfirmBrowsers: Set<String> = \[([\s\S]*?)\]/.exec(hostSource)[1].match(/"[^"]+"/g).map(JSON.parse);
  assert.deepEqual([...new Set(names)].sort(), [...swiftNames].sort());
});

test('a pass lets the change through; every other answer refuses in one line that names why', async () => {
  const asked = [];
  const confirm = result => async (change, options) => { asked.push([change, options]); return result; };
  assert.equal(await confirmationRefusal(['turbo', 'on', '--browser', 'chrome'], { confirm: confirm('ok') }), undefined);
  assert.deepEqual(asked, [[{ key: 'turbo-on', subject: 'Google Chrome' }, { timeoutMs: 60000 }]]);
  const lines = {
    failed: 'Touch ID or the password did not match', cancelled: 'the confirmation was cancelled', timeout: 'nobody confirmed within 60 s',
    invalid: 'the confirmation helper refused the request', anything: 'Touch ID or the password did not match',
  };
  for (const [code, reason] of Object.entries(lines)) {
    assert.equal(await confirmationRefusal(['permissions', 'unblock', 'com.example.App'], { confirm: confirm(code) }),
      `sleight: permissions unblock needs Touch ID or your password, so nothing changed. Reason: ${reason}.`);
  }
  for (const code of ['unavailable', 'no helper']) {
    const line = await confirmationRefusal(['allow', 'remove', 'TextEdit'], { confirm: confirm(code) });
    assert.match(line, /^sleight: allow remove needs Touch ID or your password, so nothing changed\. Reason: .+\. .+; Revoke also works from the menu bar\.$/);
    assert.equal(line.split('\n').length, 1);
  }
  assert.equal(await confirmationRefusal(['turbo', 'on'], { confirm: async () => { throw Error('helper crashed'); } }), confirmationLine('turbo on', 'failed'));
  assert.equal(await confirmationRefusal(['turbo', 'on']), confirmationLine('turbo on', 'no helper'), 'no confirmation function refuses');
});

test('low-stakes and read-only forms never ask', async () => {
  let asked = 0;
  for (const args of [...LOW, ...READS]) assert.equal(await confirmationRefusal(args, { confirm: async () => { asked++; return 'failed'; } }), undefined, args.join(' '));
  assert.equal(asked, 0);
});

test('a confirmation that never answers times out and refuses', async () => {
  const started = Date.now();
  const line = await confirmationRefusal(['permissions', 'repair'], { confirm: () => new Promise(() => {}), timeoutMs: 20, graceMs: 20 });
  assert.equal(line, confirmationLine('permissions repair', 'timeout'));
  assert.ok(Date.now() - started < 2000);
});

test('remote use: a Mac nobody is at refuses outright and never asks, so nothing goes to the phone', async () => {
  let asked = 0;
  const confirm = async () => { asked++; return 'ok'; };
  const line = await confirmationRefusal(['turbo', 'on'], { confirm, presence: async () => false });
  assert.equal(line, 'sleight: turbo on needs Touch ID or your password, so nothing changed. Reason: nobody is at the Mac, and settings changes never go to remote approvals.');
  assert.equal(asked, 0);
  // An unknown presence leaves the decision to the sheet, which needs a person anyway.
  for (const presence of [async () => undefined, async () => { throw Error('no metadata'); }, async () => true]) {
    assert.equal(await confirmationRefusal(['turbo', 'on'], { confirm, presence }), undefined);
  }
  assert.equal(asked, 3);
});

test('the person sees one notice in the terminal before the sheet', async () => {
  const notices = [];
  await confirmationRefusal(['routine', 'add', 's.json', '--every', '1h'], { confirm: async () => 'ok', notice: text => notices.push(text) });
  assert.deepEqual(notices, ['sleight: routine add changes what sleight may do. Confirm with Touch ID or your password in the macOS dialog (60 s, Cancel or Ctrl-C stops it).\n']);
});

test('the launcher: the terminal check first, then the confirmation, and only undefined dispatches', async () => {
  let asked = 0;
  const confirmation = { confirm: async () => { asked++; return 'cancelled'; }, presence: async () => true, notice: () => {} };
  assert.match(await settingsChangeRefusal(['turbo', 'on'], { gate: () => 'refused by the terminal check', confirmation }), /terminal check/);
  assert.equal(asked, 0, 'a refused terminal check never shows the sheet');
  assert.equal(await settingsChangeRefusal(['hand', 'on'], { gate: () => undefined, confirmation }), undefined);
  assert.equal(asked, 0);
  assert.equal(await settingsChangeRefusal(['turbo', 'on'], { gate: () => undefined, confirmation }), confirmationLine('turbo on', 'cancelled'));
  assert.equal(asked, 1);
  assert.match(await settingsChangeRefusal(['turbo', 'on'], { gate: () => { throw Error('x'); }, confirmation }), /Reason: check failed\.$/);
  // The main block writes the refusal and stops; every dispatch is in the else branches after it.
  assert.match(launchSource, /const refusal = SETTINGS_COMMANDS\.includes\(process\.argv\[2\]\) \? await settingsChangeRefusal\(process\.argv\.slice\(2\)\) : undefined;\n {2}if \(refusal\) \{ process\.stderr\.write\(refusal \+ '\\n'\); process\.exitCode = 3; \}\n {2}else if/);
});

test('a failed, cancelled or timed-out confirmation leaves permissions.json as it was; a pass writes it', async t => {
  const home = tempHome(t), uid = process.getuid(), path = permissionsPath(home), out = () => {};
  mkdirSync(join(home, 'Library/Application Support/sleight'), { recursive: true, mode: 0o700 });
  const run = args => permissionsCommand(args.slice(1), { home, uid, out, appNames: () => [] });
  assert.equal(run(['permissions', 'block', 'com.example.App']), 0, 'blocking is low-stakes and needs no sheet');
  assert.equal(run(['permissions', 'sites', 'only', 'https://a.example', 'https://b.example']), 0);
  const before = readFileSync(path, 'utf8');
  const attempt = async (args, result) => {
    const refusal = await settingsChangeRefusal(args, { gate: () => undefined, confirmation: { confirm: async () => result, presence: async () => true, notice: () => {} } });
    return refusal ?? run(args);
  };
  for (const args of [['permissions', 'unblock', 'com.example.App'], ['permissions', 'sites', 'all'], ['permissions', 'revoke', 'https://a.example'],
    ['permissions', 'repair', '--discard']]) {
    for (const result of ['failed', 'cancelled', 'timeout', 'unavailable']) {
      assert.equal(typeof await attempt(args, result), 'string', `${args.join(' ')} ${result}`);
      assert.equal(readFileSync(path, 'utf8'), before, `${args.join(' ')} after ${result}`);
    }
  }
  assert.equal(await attempt(['permissions', 'unblock', 'com.example.App'], 'ok'), 0);
  assert.notEqual(readFileSync(path, 'utf8'), before);
  assert.doesNotMatch(readFileSync(path, 'utf8'), /com\.example\.App/);
});

test('the helper: its exit code is the answer, a helper that can\'t run refuses, and a stuck one is stopped', async () => {
  const spawned = [];
  const host = code => async () => ({ status: 'ready', spawn: (key, subject) => {
    const child = new EventEmitter(); child.kill = signal => { child.killed = signal; };
    spawned.push({ key, subject, child });
    if (code !== undefined) setImmediate(() => child.emit('exit', code, null));
    return child;
  } });
  const expected = { 0: 'ok', 1: 'failed', 2: 'cancelled', 3: 'timeout', 64: 'invalid', 69: 'unavailable', 9: 'failed', null: 'failed' };
  for (const [code, result] of Object.entries(expected)) {
    assert.equal(await helperConfirm({ key: 'turbo-on', subject: 'Helium' }, { prepare: host(code === 'null' ? null : Number(code)) }), result, code);
  }
  assert.deepEqual(spawned.map(({ key, subject }) => [key, subject])[0], ['turbo-on', 'Helium']);
  assert.equal(await helperConfirm({ key: 'turbo-on' }, { prepare: async () => ({ status: 'unavailable', code: 'APPLE_TOOLS_MISSING' }) }), 'no helper');
  assert.equal(await helperConfirm({ key: 'turbo-on' }, { prepare: async () => { throw Error('build failed'); } }), 'no helper');
  assert.equal(await helperConfirm({ key: 'turbo-on' }, { prepare: async () => ({ status: 'ready', spawn: () => { throw Error('CONFIRM_INVALID'); } }) }), 'no helper');
  const stuck = host(undefined);
  assert.equal(await helperConfirm({ key: 'turbo-on' }, { prepare: stuck, timeoutMs: 1 }), 'timeout');
  assert.equal(spawned.at(-1).child.killed, 'SIGTERM');
});

test('record refuses an output in sleight\'s settings folder, through links, case, hard links and missing folders', async t => {
  const home = tempHome(t), settings = join(home, 'Library/Application Support/sleight'), elsewhere = join(home, 'elsewhere');
  mkdirSync(settings, { recursive: true }); mkdirSync(elsewhere);
  writeFileSync(join(settings, 'permissions.json'), '{}');
  symlinkSync(settings, join(elsewhere, 'link-to-settings'));
  symlinkSync(join(settings, 'permissions.json'), join(elsewhere, 'file-link.json'));
  linkSync(join(settings, 'permissions.json'), join(elsewhere, 'hard.json'));
  for (const path of [join(settings, 'permissions.json'), join(settings, 'new.json'), join(settings, 'routines/new/script.json'), settings,
    join(home, 'Library/application support/SLEIGHT/turbo.json'), join(elsewhere, 'link-to-settings/turbo.json'), join(elsewhere, 'file-link.json'),
    join(elsewhere, 'hard.json'), join(elsewhere, '../Library/Application Support/sleight/x.json'), '', undefined]) {
    assert.equal(insideSettings(path, { home }), true, String(path));
  }
  for (const path of [join(elsewhere, 'out.json'), join(elsewhere, 'missing/out.json'), join(home, 'Library/Application Support/sleight-other/x.json')]) {
    assert.equal(insideSettings(path, { home }), false, path);
  }
  // The launcher's record: refused before anything is read or written, and an ordinary output still works.
  const transcript = join(elsewhere, 'empty.jsonl');
  writeFileSync(transcript, '');
  const before = readFileSync(join(settings, 'permissions.json'), 'utf8');
  for (const out of [join(settings, 'permissions.json'), join(elsewhere, 'hard.json'), join(elsewhere, 'link-to-settings/new.json')]) {
    assert.equal(await replayCommand(['record', transcript, out], { home }), 2, out);
  }
  assert.equal(readFileSync(join(settings, 'permissions.json'), 'utf8'), before);
  assert.equal(existsSync(join(settings, 'new.json')), false);
  assert.equal(await replayCommand(['record', '--watch', 'com.example.App', join(settings, 'watch.json')], { home }), 2);
  assert.equal(existsSync(join(settings, 'watch.json')), false);
  assert.equal(await replayCommand(['record', transcript, join(elsewhere, 'out.json')], { home }), 0);
  assert.equal(JSON.parse(readFileSync(join(elsewhere, 'out.json'), 'utf8')).sleightReplay, 1);
});

test('the host source: the CLI mode runs before any window code, and the menu\'s Revoke rows ask before writing', () => {
  const mode = hostSource.indexOf('if arguments.first == "--confirm-person"'), app = hostSource.indexOf('let app = NSApplication.shared');
  assert.ok(mode > 0 && mode < app);
  assert.match(hostSource, /^import LocalAuthentication$/m);
  const click = /@objc func permissionClick\(_ sender: NSMenuItem\) \{([\s\S]*?)\n {4}\}/.exec(hostSource)?.[1];
  assert.ok(click);
  assert.match(click, /guard let confirm = menuConfirmArguments\(event\) else \{ writePermissionEvent\(event\); return \}/);
  assert.match(click, /confirmPerson\(reason, evaluator: personEvaluator\(\)\) \{ \[weak self\] result in\n\s*if result == \.confirmed \|\| result == \.unavailable && self\?\.confirmOnCard\(reason\) == true \{ writePermissionEvent\(event\) \}/);
  assert.equal((click.match(/writePermissionEvent/g) ?? []).length, 2);
  // LAContext appears only inside the seam's production evaluator.
  assert.equal((hostSource.match(/LAContext\(\)/g) ?? []).length, 1);
});

test('Swift: the confirmation answers once per ask, times out, cancels, and builds reasons only from its table', { skip: macCommandSkip('xcrun') }, async t => {
  const block = /\/\/ BEGIN PERSON CONFIRM\n([\s\S]*?)\/\/ END PERSON CONFIRM/.exec(hostSource)?.[1];
  assert.ok(block);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-person-confirm-swift-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const swift = join(dir, 'main.swift'), binary = join(dir, 'fixture');
  writeFileSync(swift, 'import Foundation\nimport LocalAuthentication\n' + block + readFileSync(new URL('./fixtures/person-confirm.swift', import.meta.url), 'utf8'));
  const built = spawnSync('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-module-cache-path', swiftModuleCache(), swift, '-o', binary], { encoding: 'utf8', timeout: 600000 });
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 20000 });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.deepEqual(out.answers, { confirmed: [0], failed: [1], cancelled: [2], unavailable: [69], timeout: [3], late: [3], cancel: [2] });
  assert.deepEqual(out.cancels, { timeout: 1, late: 1, cancel: 1 }, 'a timeout or cancel withdraws the sheet');
  assert.deepEqual(out.reasons, {
    'turbo-on': 'turn on sleight turbo', 'turbo-on Google Chrome': 'turn on sleight turbo for Google Chrome',
    'turbo-app-on bundle': 'let sleight turbo drive com.example.App', 'unblock free text': 'nil', 'unknown key': 'nil',
    'subject on a plain key': 'nil', 'browser name elsewhere': 'let sleight turbo drive Google Chrome', 'too many': 'nil',
  });
  assert.deepEqual(out.menu, { 'revoke-all': ['permissions-revoke-all'], 'revoke electron': ['permissions-revoke', 'com.example.App'],
    'revoke app name': ['permissions-revoke'], block: ['nil'] });
});

test('Swift: the whole host compiles, and --confirm-person-check parses its arguments without showing anything', { skip: macCommandSkip('xcrun') }, async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-person-confirm-host-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binary = join(dir, 'consent-host');
  const built = spawnSync('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-module-cache-path', swiftModuleCache(),
    new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url).pathname, '-o', binary], { encoding: 'utf8', timeout: 600000 });
  assert.equal(built.status, 0, built.stderr);
  const check = (...args) => spawnSync(binary, ['--confirm-person-check', ...args], { encoding: 'utf8', timeout: 10000 });
  assert.deepEqual([check('turbo-on', 'Google Chrome').status, check('turbo-on', 'Google Chrome').stdout], [0, 'turn on sleight turbo for Google Chrome\n']);
  assert.equal(check('permissions-revoke-all').stdout, 'revoke everything sleight may do\n');
  for (const args of [[], ['nope'], ['turbo-on', 'Firefox'], ['permissions-unblock', 'com.example.App to stay safe'], ['turbo-on', 'Helium', 'x']]) {
    const run = check(...args);
    assert.deepEqual([run.status, run.stdout], [64, ''], args.join(' '));
  }
});
