import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseLiveChecksArgs, dryRunReport, planStaleBatch, judgeStaleNumber, judgeKeyboardTap,
  judgeHelperResend, judgeMenuBar, classifyTapSources, runMenuBar, accessibilityGrant,
  appAncestorFromRows,
} from '../bench/live-checks-1-1.mjs';

const script = fileURLToPath(new URL('../bench/live-checks-1-1.mjs', import.meta.url));
const historyTree = [
  'Window: "Calculator", App: Calculator.',
  '0 standard window Calculator',
  '\t1 list HistoryView',
  '\t2 button Description: All Clear, ID: AllClear',
  '\t3 button Description: 7, ID: Seven',
  '\t4 button Multiply',
  '\t5 button Description: 8, ID: Eight',
  '\t6 button Description: Equals, ID: Equals',
  '\t7 button Description: Clear Memory, ID: MemoryClear',
].join('\n');

function runScript(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('argument parsing accepts one check and the two flags', () => {
  assert.deepEqual(parseLiveChecksArgs(['node', 'live-checks', 'menu-bar', '--dry-run']),
    { check: 'menu-bar', dryRun: true, ownerAway: false });
  assert.deepEqual(parseLiveChecksArgs(['node', 'live-checks', '--owner-away', 'stale-number']),
    { check: 'stale-number', dryRun: false, ownerAway: true });
  for (const check of ['stale-number', 'keyboard-tap', 'helper-resend', 'menu-bar']) {
    assert.equal(parseLiveChecksArgs(['node', 'live-checks', check, '--dry-run', '--owner-away']).check, check);
  }
});

test('argument parsing rejects a missing check, an unknown check and an unknown flag', () => {
  assert.throws(() => parseLiveChecksArgs(['node', 'live-checks']), /stale-number/);
  assert.throws(() => parseLiveChecksArgs(['node', 'live-checks', 'calculator']), /stale-number/);
  assert.throws(() => parseLiveChecksArgs(['node', 'live-checks', 'stale-number', '--verbose']), /Unknown argument/);
  assert.throws(() => parseLiveChecksArgs(['node', 'live-checks', 'stale-number', 'menu-bar']), /one check/);
});

test('a live invocation without --owner-away stops before the lock', async () => {
  const result = await runScript(['stale-number']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--owner-away/);
  assert.doesNotMatch(result.stderr + result.stdout, /sleight-live\.lock/);
});

test('dry-run prints a plan and drives nothing, including while the live lock is held', async () => {
  for (const check of ['stale-number', 'keyboard-tap', 'helper-resend', 'menu-bar']) {
    const result = await runScript([check, '--dry-run']);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.dryRun, true);
    assert.equal(report.check, check);
    assert.equal(report.drives, false);
    assert.equal(report.lock, false);
    assert.equal(report.killsHelper, false);
    assert.equal(report.installsTap, false);
    assert.deepEqual(report, dryRunReport(check));
  }
  const keyboard = dryRunReport('keyboard-tap');
  const helper = dryRunReport('helper-resend');
  assert.equal(keyboard.skipped, true);
  assert.equal(helper.skipped, true);
  assert.match(helper.reason, /kill/i);
  assert.equal(dryRunReport('stale-number').skipped, undefined);
  assert.equal(dryRunReport('menu-bar').readOnly, true);
});

test('the Calculator batch uses numbers from the history-open tree and refuses a closed history', () => {
  assert.deepEqual(planStaleBatch(historyTree), {
    numbers: [2, 3, 4, 5, 6],
    expected: '56',
    code: 'await app.click(2); await app.click(3); await app.click(4); await app.click(5); await app.click(6)',
  });
  const closed = historyTree.replace('\t1 list HistoryView\n', '');
  assert.equal(planStaleBatch(closed).error !== undefined, true);
  assert.equal(planStaleBatch(closed).code, undefined);
  // Two different lines for one label stay ambiguous, unlike byte-identical duplicates.
  const ambiguous = historyTree + '\n\t8 button Description: Multiply, ID: MultiplyTwo';
  assert.equal(planStaleBatch(ambiguous).code, undefined);
});

test('the plan takes the first of byte-identical duplicates and fails on lines that differ', () => {
  // Calculator's history-open tree listed every keypad line twice, byte-identical apart from the
  // element number (2026-10-10-live-checks-stale-number-1791679612845.json).
  const duplicated = [
    'Window: "Calculator", App: Calculator.',
    '0 standard window Calculator',
    '\t1 list HistoryView',
    '\t2 button Description: All Clear, ID: AllClear',
    '\t3 button Description: 7, ID: Seven',
    '\t4 button Multiply',
    '\t5 button Description: 8, ID: Eight',
    '\t6 button Description: Equals, ID: Equals',
    '\t7 button Description: All Clear, ID: AllClear',
    '\t8 button Description: 7, ID: Seven',
    '\t9 button Multiply',
    '\t10 button Description: 8, ID: Eight',
    '\t11 button Description: Equals, ID: Equals',
  ].join('\n');
  assert.deepEqual(planStaleBatch(duplicated), {
    numbers: [2, 3, 4, 5, 6],
    expected: '56',
    code: 'await app.click(2); await app.click(3); await app.click(4); await app.click(5); await app.click(6)',
  });
  const differing = historyTree + '\n\t8 button Description: 7';
  const plan = planStaleBatch(differing);
  assert.equal(plan.code, undefined);
  assert.match(plan.error, /not unique/);
  assert.match(plan.error, /button Description: 7, ID: Seven/);
  assert.match(plan.error, /"button Description: 7"/);
});

test('stale-number passes only when the result names the remap and the display is 56', () => {
  const pass = judgeStaleNumber({
    text: 'sleight: click(3) went to element 2, the same "button Description: 7, ID: Seven": an earlier action in this call renumbered the window.',
    display: '56', expected: '56',
  });
  assert.equal(pass.passed, true);
  assert.equal(judgeStaleNumber({
    text: 'sleight: numbers in this window changed since you saw them, so 3 was found by its line "button Description: 7, ID: Seven".',
    display: '56', expected: '56',
  }).passed, true);
  assert.equal(judgeStaleNumber({ text: 'renumbered the window', display: '55', expected: '56' }).passed, false);
  assert.equal(judgeStaleNumber({ text: '56', display: '56', expected: '56' }).passed, false);
  assert.equal(judgeStaleNumber({ text: 'renumbered the window', display: '56', expected: '56', error: true }).passed, false);
});

test('keyboard-tap passes when the turn-end notice names an acted-on app that holds a tap', () => {
  const notice = 'sleight-warning: Device Hub holds a keyboard event tap. If your keys stop working, quit Device Hub.';
  assert.equal(judgeKeyboardTap({
    actedOn: ['Device Hub'], taps: [{ app: 'Device Hub', pid: 42 }], notice,
  }).passed, true);
  assert.equal(judgeKeyboardTap({
    actedOn: ['Device Hub'], taps: [{ app: 'Device Hub', pid: 42 }], notice: '',
  }).passed, false);
  assert.equal(judgeKeyboardTap({
    actedOn: ['Calculator'], taps: [{ app: 'Device Hub', pid: 42 }], notice: '',
  }).passed, true);
  assert.equal(judgeKeyboardTap({
    actedOn: ['Calculator'], taps: [{ app: 'Device Hub', pid: 42 }], notice,
  }).passed, false);
});

test('a tap lister is not a fixture that installs a tap', () => {
  const listed = classifyTapSources([
    { path: 'bench/keyboard-taps.swift', text: 'CGGetEventTapList(count, &taps, &count)' },
  ]);
  assert.equal(listed.installs, false);
  assert.equal(listed.skip, true);
  const installer = classifyTapSources([
    { path: 'bench/keyboard-taps.swift', text: 'CGGetEventTapList(0, nil, &count)' },
    { path: 'bench/install-tap.swift', text: 'CGEventTapCreate(kCGSessionEventTap, .headInsertEventTap, .defaultTap, events, nil, nil)' },
  ]);
  assert.equal(installer.installs, true);
  assert.equal(installer.path, 'bench/install-tap.swift');
});

test('helper-resend passes only a single resend of a startup failure', () => {
  assert.equal(judgeHelperResend({ sawStartupFailure: true, resends: 1 }).passed, true);
  assert.equal(judgeHelperResend({ sawStartupFailure: true, resends: 0 }).passed, false);
  assert.equal(judgeHelperResend({ sawStartupFailure: true, resends: 2 }).passed, false);
  assert.equal(judgeHelperResend({ sawStartupFailure: false, resends: 1 }).passed, false);
  assert.equal(judgeHelperResend({ sawStartupFailure: true, resends: 1, killedHelper: true }).passed, false);
});

const denial = "osascript is not allowed assistive access. macOS hasn't given the app running Claude Code Accessibility permission. Turn it on under System Settings → Privacy & Security → Accessibility (for Terminal, iTerm or Claude, whichever runs this session).";
const iterm = '/Applications/iTerm.app/Contents/MacOS/iTerm2';

test('the app ancestor is the nearest .app-bundle process walking up from this one', () => {
  const rows = new Map([
    [1, { ppid: 0, path: '/sbin/launchd' }],
    [210, { ppid: 1, path: iterm }],
    [310, { ppid: 210, path: '/opt/homebrew/bin/node' }],
    [410, { ppid: 310, path: '/opt/homebrew/bin/node' }],
  ]);
  assert.equal(appAncestorFromRows(410, rows), iterm);
  assert.equal(appAncestorFromRows(410, new Map([
    [310, { ppid: 1, path: '/opt/homebrew/bin/node' }], [1, { ppid: 0, path: '/sbin/launchd' }],
  ])), undefined);
});

test('an assistive-access denial names the found process; other errors and no process stay failures', async () => {
  assert.deepEqual(await accessibilityGrant(denial, async () => iterm),
    { processPath: iterm, reason: `needs the owner to grant Accessibility to ${iterm}` });
  assert.equal(await accessibilityGrant(denial, async () => undefined), undefined);
  assert.equal(await accessibilityGrant('Neither Clock nor Control Center has a status item', async () => iterm), undefined);
});

test('menu-bar reports an accessibility denial as an owner action instead of a failure', async () => {
  const client = { call: async () => ({ isError: true, content: [{ type: 'text', text: denial }] }) };
  const report = {};
  await runMenuBar(client, report, { cleanup: true, statusApp: undefined }, async () => ({
    processPath: '/Applications/Claude.app/Contents/MacOS/Claude',
    reason: 'needs the owner to grant Accessibility to /Applications/Claude.app/Contents/MacOS/Claude',
  }));
  assert.equal(report.skipped, true);
  assert.equal(report.passed, false);
  assert.equal(report.reason, 'needs the owner to grant Accessibility to /Applications/Claude.app/Contents/MacOS/Claude');
  assert.equal(report.needsAccessibility, '/Applications/Claude.app/Contents/MacOS/Claude');
  assert.equal(report.error, undefined);
  await assert.rejects(() => runMenuBar(
    { call: async () => ({ isError: true, content: [{ type: 'text', text: 'Neither Clock nor Control Center has a status item' }] }) },
    {}, { cleanup: true, statusApp: undefined }, async () => undefined,
  ));
});

test('menu-bar passes a listed Clock or Control Center item that was opened and closed, and nothing else', () => {
  assert.equal(judgeMenuBar({
    apps: ['Clock', 'Control Center'], app: 'Clock', opened: 'menu', closed: true, windowStillOpen: false,
  }).passed, true);
  assert.equal(judgeMenuBar({
    apps: ['Control Center'], app: 'Control Center', opened: 'window', closed: true,
  }).passed, true);
  assert.equal(judgeMenuBar({
    apps: ['Clock'], app: 'Clock', opened: 'menu', closed: true, chose: ['Date & Time'],
  }).passed, false);
  assert.equal(judgeMenuBar({
    apps: ['Clock'], app: 'Clock', opened: 'menu', closed: true, pressed: 1,
  }).passed, false);
  assert.equal(judgeMenuBar({
    apps: ['Clock'], app: 'Clock', opened: 'menu', closed: false,
  }).passed, false);
  assert.equal(judgeMenuBar({
    apps: ['Clock'], app: 'Clock', opened: 'menu', closed: true, windowStillOpen: true,
  }).passed, false);
  assert.equal(judgeMenuBar({
    apps: ['Wi-Fi'], app: 'Wi-Fi', opened: 'menu', closed: true,
  }).passed, false);
  assert.equal(judgeMenuBar({
    apps: ['Control Center'], app: 'Clock', opened: 'menu', closed: true,
  }).passed, false);
});
