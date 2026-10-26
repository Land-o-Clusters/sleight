// VC10: high-stakes settings changes wait for macOS's own Touch ID or password sheet (lib/person-confirm.mjs, the consent
// host's --confirm-person mode). Every confirmation here is injected or a stand-in evaluator: no test shows a real sheet. The
// only real host runs are the --confirm-person-check mode, which prints the reason and exits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { statSync, utimesSync } from 'node:fs';
import { prepareConfirmHost } from '../plugins/sleight/lib/direct-browser/host.mjs';
import { join } from 'node:path';
import { confirmationLine, confirmationRefusal, helperConfirm, highStakesChange } from '../plugins/sleight/lib/person-confirm.mjs';
import { insideSettings, settingsCommand, writeOutsideSettings } from '../plugins/sleight/lib/person-gate.mjs';
import { replayCommand, settingsChangeRefusal } from '../plugins/sleight/lib/launch.mjs';
import { permissionsCommand } from '../plugins/sleight/lib/permissions-command.mjs';
import { permissionsPath } from '../plugins/sleight/lib/permissions.mjs';
import { macCommandSkip } from './requirements.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';

const hostSource = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
const confirmSource = readFileSync(new URL('../plugins/sleight/lib/person-confirm.mjs', import.meta.url), 'utf8');
const launchSource = readFileSync(new URL('../plugins/sleight/lib/launch.mjs', import.meta.url), 'utf8');
const tempHome = t => registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-person-confirm-'))));

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
  [['permissions', 'sites', 'only', 'https://example.com'], { key: 'permissions-sites' }],
  [['permissions', 'sites', 'all'], { key: 'permissions-sites' }],
  [['permissions', 'repair'], { key: 'permissions-repair' }],
  [['permissions', 'repair', '--discard'], { key: 'permissions-repair' }],
  [['routine', 'add', 'script.json', '--every', '1h'], { key: 'routine-add' }],
  [['routine', 'unlock', 'r1'], { key: 'routine-unlock' }],
  [['watch', 'https://example.com', '--find', 'x', '--every', '1h'], { key: 'watch-add' }],
  [['watch', 'record', 't.jsonl', '--every', '1h'], { key: 'watch-add' }],
  [['watch', 'unlock', 'w1'], { key: 'watch-unlock' }],
  // Forms the modules reject as usage still ask, so a writer added later is covered before anyone lists it.
  [['turbo'], { key: 'settings' }], [['turbo', 'frobnicate'], { key: 'settings' }], [['permissions', 'frobnicate'], { key: 'settings' }],
  [['allow', 'add', 'TextEdit'], { key: 'settings' }], [['allow', 'remove'], { key: 'settings' }],
  [['permissions', 'revoke'], { key: 'settings' }], [['routine', 'frobnicate'], { key: 'settings' }], [['watch', 'frobnicate'], { key: 'settings' }],
];
// Settings changes that only take access away or change how sleight looks: the terminal check alone (sleight-arch, 2026-10-26).
// Revoking and allow remove only take access away, so they're here too.
const LOW = [
  ['hand', 'on'], ['hand', 'off'], ['hand', 'capture', 'visible'], ['hand'], ['cursor', 'style', 'ring'], ['cursor', 'import', '/tmp/x', '--yes'],
  ['cursor', 'remove', 'test-cat'], ['turbo', 'off'], ['turbo', 'app', 'off', 'com.example.app'], ['permissions', 'block', 'com.example.app'],
  ['permissions', 'block', 'https://example.com'], ['permissions', 'memory', 'clear', 'all'], ['routine', 'remove', 'r1'], ['routine', '--remove', 'r1'],
  ['watch', 'remove', 'w1'], ['permissions', 'revoke', 'all'], ['permissions', 'revoke', 'turbo'], ['permissions', 'revoke', 'com.example.App'],
  ['permissions', 'revoke', 'https://example.com'], ['allow', 'remove', 'TextEdit'], ['allow', 'remove', 'com.apple.TextEdit'],
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
  assert.deepEqual(asked.map(([change, options]) => [change, options.timeoutMs, typeof options.ready, options.abandoned()]),
    [[{ key: 'turbo-on', subject: 'Google Chrome' }, 60000, 'function', true]], 'abandoned turns true once the answer is in');
  const lines = {
    failed: 'Touch ID or the password did not match', cancelled: 'the confirmation was cancelled', timeout: 'nobody confirmed within 60 s',
    invalid: 'the confirmation helper refused the request', anything: 'Touch ID or the password did not match',
  };
  for (const [code, reason] of Object.entries(lines)) {
    assert.equal(await confirmationRefusal(['permissions', 'unblock', 'com.example.App'], { confirm: confirm(code) }),
      `sleight: permissions unblock needs Touch ID or your password, so nothing changed. Reason: ${reason}.`);
  }
  for (const code of ['unavailable', 'no helper']) {
    const line = await confirmationRefusal(['permissions', 'sites', 'all'], { confirm: confirm(code) });
    assert.match(line, /^sleight: permissions sites needs Touch ID or your password, so nothing changed\. Reason: .+\. (?:Set a login password to make this change|Apple's command-line tools build it \(xcode-select --install\))\.$/);
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
  const line = await confirmationRefusal(['permissions', 'repair'], { confirm: (change, { ready }) => { ready(); return new Promise(() => {}); }, timeoutMs: 20, graceMs: 20 });
  assert.equal(line, confirmationLine('permissions repair', 'timeout'));
  assert.ok(Date.now() - started < 2000);
});

// Sonnet review finding 2: the sheet's 60 s start once the helper is built, and a build past its cap never shows a sheet.
test('a slow build isn\'t charged to the sheet\'s clock, and a build past its cap refuses without a sheet', async () => {
  const later = ms => new Promise(resolve => setTimeout(resolve, ms));
  // The build takes 3 times the sheet's whole allowance, then the person answers at once.
  let spawned = 0;
  const host = { status: 'ready', spawn: () => { spawned++; const child = new EventEmitter(); child.kill = () => {}; child.stdout = new PassThrough();
    child.sleightExpected = { path: '/x', sha256: 'a' }; setImmediate(() => { child.stdout.write('{"path":"/x","sha256":"a"}\n'); child.stdout.end(); child.emit('close', 0, null); }); return child; } };
  const confirm = (change, options) => helperConfirm(change, { ...options, prepare: async () => { await later(90); return host; } });
  assert.equal(await confirmationRefusal(['turbo', 'on'], { confirm, timeoutMs: 10, graceMs: 20, buildMs: 1000 }), undefined);
  assert.equal(spawned, 1);
  // Past the build cap: the refusal names the build, and the helper never starts, even when the build finishes afterwards.
  const slow = (change, options) => helperConfirm(change, { ...options, prepare: async () => { await later(80); return host; } });
  assert.equal(await confirmationRefusal(['turbo', 'on'], { confirm: slow, buildMs: 20 }),
    'sleight: turbo on needs Touch ID or your password, so nothing changed. Reason: building the confirmation helper took too long, so no dialog was shown.');
  await later(120);
  assert.equal(spawned, 1, 'no sheet after the command gave up');
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
  notices.length = 0;
  await confirmationRefusal(['turbo', 'app', 'on', 'com.example.App'], { confirm: async () => 'ok', notice: text => notices.push(text) });
  assert.match(notices[0], /^sleight: turbo app on \(com\.example\.App\) changes what sleight may do\./, 'the notice names what the sheet names');
});

test('the launcher: the terminal check first, then the confirmation, and only undefined dispatches', async () => {
  let asked = 0;
  const confirmation = { confirm: async () => { asked++; return 'cancelled'; }, presence: async () => true, notice: () => {} };
  assert.match(await settingsChangeRefusal(['turbo', 'on'], { gate: () => 'refused by the terminal check', confirmation }), /terminal check/);
  assert.equal(asked, 0, 'a refused terminal check never shows the sheet');
  // The 10 s session-age bar goes only to high-stakes forms (Sonnet review finding 1).
  const bars = [];
  const gate = (args, options) => { bars.push([args.join(' '), options.freshMs]); return 'refused'; };
  for (const args of [['turbo', 'on'], ['turbo', 'off'], ['permissions', 'revoke', 'all'], ['hand', 'on'], ['routine', 'add', 's.json', '--every', '1h']]) await settingsChangeRefusal(args, { gate, confirmation });
  assert.deepEqual(bars, [['turbo on', 10000], ['turbo off', 0], ['permissions revoke all', 0], ['hand on', 0], ['routine add s.json --every 1h', 10000]]);
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
  for (const args of [['permissions', 'unblock', 'com.example.App'], ['permissions', 'sites', 'all'], ['permissions', 'repair', '--discard']]) {
    for (const result of ['failed', 'cancelled', 'timeout', 'unavailable']) {
      assert.equal(typeof await attempt(args, result), 'string', `${args.join(' ')} ${result}`);
      assert.equal(readFileSync(path, 'utf8'), before, `${args.join(' ')} after ${result}`);
    }
  }
  assert.equal(await attempt(['permissions', 'unblock', 'com.example.App'], 'ok'), 0);
  assert.notEqual(readFileSync(path, 'utf8'), before);
  assert.doesNotMatch(readFileSync(path, 'utf8'), /com\.example\.App/);
});

test('the helper: its exit code is the answer once its first line matches the copy, a helper that can\'t run refuses, and a stuck one is stopped', async () => {
  const spawned = [], EXPECTED = { path: '/private/run-x/consent-host', sha256: 'a'.repeat(64) };
  const host = (code, { report = JSON.stringify(EXPECTED), expected = EXPECTED } = {}) => async () => ({ status: 'ready', spawn: (key, subject) => {
    const child = new EventEmitter(); child.kill = signal => { child.killed = signal; };
    child.stdout = new PassThrough(); child.sleightExpected = expected;
    spawned.push({ key, subject, child });
    if (code !== undefined) setImmediate(() => { if (report !== null) child.stdout.write(report + '\n'); child.emit('exit', code, null); setImmediate(() => child.emit('close', code, null)); });
    return child;
  } });
  const expected = { 0: 'ok', 1: 'failed', 2: 'cancelled', 3: 'timeout', 64: 'invalid', 69: 'unavailable', 9: 'failed', null: 'failed' };
  for (const [code, result] of Object.entries(expected)) {
    assert.equal(await helperConfirm({ key: 'turbo-on', subject: 'Helium' }, { prepare: host(code === 'null' ? null : Number(code)) }), result, code);
  }
  assert.deepEqual(spawned.map(({ key, subject }) => [key, subject])[0], ['turbo-on', 'Helium']);
  // A pass from a helper whose first line doesn't name the copy and its hash isn't trusted.
  for (const [name, options] of [['no line', { report: null }], ['garbage', { report: 'hello' }],
    ['another file', { report: JSON.stringify({ ...EXPECTED, path: '/tmp/evil' }) }], ['another hash', { report: JSON.stringify({ ...EXPECTED, sha256: 'b'.repeat(64) }) }],
    ['no expectation', { expected: null }]]) {
    assert.equal(await helperConfirm({ key: 'turbo-on' }, { prepare: host(0, options) }), 'unverified', name);
  }
  assert.equal(await helperConfirm({ key: 'turbo-on' }, { prepare: host(64, { report: null }) }), 'invalid', 'exit 64 with no line is a refused request');
  assert.equal(confirmationLine('turbo on', 'unverified'), "sleight: turbo on needs Touch ID or your password, so nothing changed. Reason: the confirmation helper isn't the file sleight checked.");
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

// Security review (2026-10-26): the write checks the folder it actually opens, so a parent swapped for a link between the
// check and the open can't send it into the settings folder.
test('record\'s write holds the folder it checked: a parent swapped for a link afterwards still gets the file, never settings', async t => {
  const home = tempHome(t), settings = join(home, 'Library/Application Support/sleight'), work = join(home, 'work');
  mkdirSync(settings, { recursive: true }); mkdirSync(work);
  const transcript = join(home, 'empty.jsonl');
  writeFileSync(transcript, '');
  const swap = () => { renameSync(work, work + '.moved'); symlinkSync(settings, work); };
  assert.equal(await replayCommand(['record', transcript, join(work, 'out.json')], { home, between: swap }), 0);
  assert.deepEqual(readdirSync(settings), [], 'nothing landed in the settings folder');
  assert.equal(JSON.parse(readFileSync(join(work + '.moved', 'out.json'), 'utf8')).sleightReplay, 1, 'the file went to the folder that was checked');
  // With the link already in place when the write starts, the folder it opens is the settings folder, so it refuses.
  assert.equal(await replayCommand(['record', transcript, join(work, 'again.json')], { home }), 2);
  assert.deepEqual(readdirSync(settings), []);
  const cwd = process.cwd();
  assert.throws(() => writeOutsideSettings(join(work, 'x.json'), 'x', { home }), { code: 'SETTINGS_OUT' });
  assert.equal(process.cwd(), cwd, 'the working folder is restored after a refusal');
  // A file planted as a link at the name is never followed, and exclusive refuses an existing file.
  symlinkSync(join(settings, 'turbo.json'), join(work + '.moved', 'planted.json'));
  assert.throws(() => writeOutsideSettings(join(work + '.moved', 'planted.json'), 'x', { home }),
    { code: 'SETTINGS_OUT', message: "record doesn't write through a link at the output path; pick another output path" });
  assert.equal(await replayCommand(['record', transcript, join(work + '.moved', 'planted.json')], { home }), 2, 'the launcher refuses with that line, not a raw ELOOP');
  assert.equal(existsSync(join(settings, 'turbo.json')), false);
  assert.throws(() => writeOutsideSettings(join(work + '.moved', 'out.json'), 'x', { home, exclusive: true }), { code: 'EEXIST' });
  assert.equal(process.cwd(), cwd);
});

// Security review (2026-10-26): the helper that answers is a private copy of bytes hashed through one open file, in a fresh
// 0700 run folder beside the build cache, never the cached path itself. A shell script stands in for the build and reports its
// own path and hash the way the host does.
test('the confirmation helper runs from a private copy in the guarded cache, and its report must match', { skip: process.platform !== 'darwin' && 'macOS only' }, async t => {
  const root = tempHome(t), sourceRoot = join(root, 'sources'), cacheRoot = join(root, 'cache', 'turbo-host'), runRoot = join(root, 'cache');
  mkdirSync(sourceRoot, { mode: 0o700 });
  for (const name of ['peer-host.c', 'consent-host.swift']) writeFileSync(join(sourceRoot, name), 'source ' + name, { mode: 0o600 });
  const script = (code, tail = '') => '#!/bin/sh\nh=$(/usr/bin/shasum -a 256 "$0" | /usr/bin/cut -d " " -f 1)\n' +
    `printf '{"path":"%s","sha256":"%s"}\\n' "$0" "$h"\nexit ${code}\n${tail}`;
  const compile = async ({ name, binary }) => writeFileSync(binary, name === 'consent-host' ? script(0) : 'peer', { mode: 0o700 });
  const runs = [];
  const run = (file, args, options) => {
    runs.push({ file, args, stdio: options.stdio, bytes: readFileSync(file, 'utf8'), mode: statSync(file).mode & 0o777, folder: statSync(join(file, '..')).mode & 0o777 });
    // Swap the cached binary once the copy exists: what runs is still the copy.
    writeFileSync(join(cacheRoot, readdirSync(cacheRoot).find(name => /^[a-f0-9]{64}$/.test(name)), 'consent-host'), script(0, '# swapped\n'));
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', 0, null));
    return child;
  };
  const prepared = await prepareConfirmHost({ sourceRoot, cacheRoot, compile, tools: async () => true, run });
  assert.equal(prepared.status, 'ready', JSON.stringify(prepared));
  const child = prepared.spawn('turbo-on', 'Google Chrome');
  await new Promise(resolve => child.once('exit', resolve));
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].args, ['--confirm-person', 'turbo-on', 'Google Chrome']);
  assert.deepEqual(runs[0].stdio, ['ignore', 'pipe', 'ignore']);
  assert.equal(runs[0].bytes, script(0), 'the copy holds the bytes that were hashed');
  assert.ok(runs[0].file.startsWith(runRoot + '/run-') && !runs[0].file.startsWith(cacheRoot), runs[0].file);
  assert.deepEqual([runs[0].mode, runs[0].folder], [0o700, 0o700]);
  assert.equal(child.sleightExpected.path, runs[0].file);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(readdirSync(runRoot).filter(name => name.startsWith('run-')), [], 'the run folder is removed when the helper exits');
  // The swapped cache file now fails its hash, so the next confirmation never runs it.
  assert.throws(() => prepared.spawn('turbo-on'), /HOST_PACKAGE_MISMATCH/);
  assert.equal(runs.length, 1);
  assert.throws(() => prepared.spawn('Turbo On'), /CONFIRM_INVALID/);
  // A spawn that fails leaves no run folder.
  rmSync(cacheRoot, { recursive: true, force: true });
  const failing = await prepareConfirmHost({ sourceRoot, cacheRoot, compile, tools: async () => true, run: () => { throw Error('spawn failed'); } });
  assert.throws(() => failing.spawn('turbo-on'), /spawn failed/);
  assert.deepEqual(readdirSync(runRoot).filter(name => name.startsWith('run-')), []);
  // SIGTERM or SIGHUP to the launcher stops the helper and removes the folder at once (Sonnet review finding 4); a folder a
  // killed launcher left behind more than 10 minutes ago goes at the next confirmation.
  const stale = join(runRoot, 'run-OLD123');
  mkdirSync(stale, { mode: 0o700 }); writeFileSync(join(stale, 'consent-host'), 'x'); utimesSync(stale, new Date(Date.now() - 3600000), new Date(Date.now() - 3600000));
  const fresh = join(runRoot, 'run-NEW123');
  mkdirSync(fresh, { mode: 0o700 });
  const kills = [];
  const lingering = await prepareConfirmHost({ sourceRoot, cacheRoot, compile, tools: async () => true,
    run: () => { const child = new EventEmitter(); child.kill = signal => kills.push(signal); return child; } });
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
    const before = process.listenerCount(signal);
    lingering.spawn('turbo-on');
    assert.equal(existsSync(stale), false, 'the stale folder was swept');
    assert.deepEqual(readdirSync(runRoot).filter(name => name.startsWith('run-') && name !== 'run-NEW123').length, 1);
    process.emit(signal, signal);
    assert.deepEqual(readdirSync(runRoot).filter(name => name.startsWith('run-')), ['run-NEW123'], `${signal} removed the run folder`);
    assert.equal(kills.at(-1), 'SIGTERM');
    assert.equal(process.listenerCount(signal), before, `${signal}'s handler is gone with the folder`);
  }
  rmSync(fresh, { recursive: true });
  // End to end with a real spawn of the copy: the stand-in reports the copy's path and hash, then exits 0, so the answer is ok.
  const real = await prepareConfirmHost({ sourceRoot, cacheRoot, compile, tools: async () => true });
  assert.equal(await helperConfirm({ key: 'turbo-on' }, { prepare: async () => real }), 'ok');
  assert.deepEqual(readdirSync(runRoot).filter(name => name.startsWith('run-')), []);
});

test('the host source: the CLI mode runs before any window code, and the menu\'s Revoke rows answer at once', () => {
  const mode = hostSource.indexOf('if arguments.first == "--confirm-person"'), app = hostSource.indexOf('let app = NSApplication.shared');
  assert.ok(mode > 0 && mode < app);
  assert.match(hostSource, /^import LocalAuthentication$/m);
  // Revoke and Revoke All only take access away (sleight-arch, 2026-10-26), so no menu row calls the confirmation.
  const click = /@objc func permissionClick\(_ sender: NSMenuItem\) \{([\s\S]*?)\n {4}\}/.exec(hostSource)?.[1];
  assert.ok(click);
  assert.doesNotMatch(click, /confirmPerson/);
  assert.equal((hostSource.match(/confirmPerson\(reason, evaluator: localAuthentication\(\)\)/g) ?? []).length, 1, 'only the CLI mode asks');
  // LAContext appears only inside the seam's production evaluator.
  assert.equal((hostSource.match(/LAContext\(\)/g) ?? []).length, 1);
});

test('Swift: the confirmation answers once per ask, times out, cancels, and builds reasons only from its table', { skip: macCommandSkip('xcrun') }, async t => {
  const block = /\/\/ BEGIN PERSON CONFIRM\n([\s\S]*?)\/\/ END PERSON CONFIRM/.exec(hostSource)?.[1];
  assert.ok(block);
  const dir = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-person-confirm-swift-'))));
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
});

test('Swift: the whole host compiles, and --confirm-person-check parses its arguments without showing anything', { skip: macCommandSkip('xcrun') }, async t => {
  const dir = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-person-confirm-host-'))));
  const binary = join(dir, 'consent-host');
  const built = spawnSync('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-module-cache-path', swiftModuleCache(),
    new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url).pathname, '-o', binary], { encoding: 'utf8', timeout: 600000 });
  assert.equal(built.status, 0, built.stderr);
  const check = (...args) => spawnSync(binary, ['--confirm-person-check', ...args], { encoding: 'utf8', timeout: 10000 });
  // The first line is the self-report helperConfirm compares: this binary's own path and hash.
  const report = JSON.stringify({ path: binary, sha256: createHash('sha256').update(readFileSync(binary)).digest('hex') });
  assert.deepEqual([check('turbo-on', 'Google Chrome').status, check('turbo-on', 'Google Chrome').stdout], [0, report + '\nturn on sleight turbo for Google Chrome\n']);
  assert.equal(check('permissions-sites').stdout, report + '\nchange the sites sleight may act on\n');
  for (const args of [[], ['nope'], ['permissions-revoke'], ['allow-remove'], ['turbo-on', 'Firefox'], ['permissions-unblock', 'com.example.App to stay safe'], ['turbo-on', 'Helium', 'x']]) {
    const run = check(...args);
    assert.deepEqual([run.status, run.stdout], [64, ''], args.join(' '));
  }
});
