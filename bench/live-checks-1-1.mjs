// Owner-away checks for behavior that has unit tests and no live run yet.
// One subcommand. --dry-run prints the plan and does not take the lock or drive an app.
// Live runs publish docs/benchmarks/2026-10-10-live-checks-<name>-<stamp>.json.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { hasIdentifier, hasLabel } from '../plugins/sleight/lib/document-scope.mjs';
import { calculatorValue } from './calculator-value.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
export const CHECKS = ['stale-number', 'keyboard-tap', 'helper-resend', 'menu-bar'];
const STATUS_APPS = ['Clock', 'Control Center'];
const HELPER_SKIP = 'Forcing the "native pipe startup failed" race means killing OpenAI\'s helper process. This check does not kill that process, and it does not quit or restart ChatGPT.';

export function parseLiveChecksArgs(argv) {
  const positionals = [];
  let dryRun = false, ownerAway = false;
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--owner-away') ownerAway = true;
    else if (arg.startsWith('-')) throw new Error('Unknown argument ' + arg);
    else positionals.push(arg);
  }
  if (positionals.length !== 1 || !CHECKS.includes(positionals[0])) {
    throw new Error('Expected one check: ' + CHECKS.join(', '));
  }
  return { check: positionals[0], dryRun, ownerAway };
}

export function dryRunReport(check) {
  const common = { dryRun: true, check, drives: false, lock: false, killsHelper: false, installsTap: false };
  if (check === 'keyboard-tap') return {
    ...common, skipped: true,
    reason: 'bench/keyboard-taps.swift lists taps with CGGetEventTapList. No file under bench/ installs a tap, so this check skips rather than creating one.',
  };
  if (check === 'helper-resend') return { ...common, skipped: true, reason: HELPER_SKIP };
  if (check === 'menu-bar') return {
    ...common, readOnly: true,
    would: 'List status items, open Clock or Control Center, and close it. No menu item is chosen.',
  };
  if (check === 'stale-number') return {
    ...common,
    would: 'Launch Calculator in the background only when it is not running, open its history if needed, and send one batch of numbered clicks. The first click closes the history. Pass when the result names the remap and the display is 56.',
  };
  throw new Error('Expected one check: ' + CHECKS.join(', '));
}

function buttons(tree) {
  const found = [];
  for (const line of tree.split('\n')) {
    const match = /^\t*(\d+) (.*)$/.exec(line);
    if (match && /^button(?: |$)/.test(match[2])) found.push({ n: Number(match[1]), line: match[2] });
  }
  return found;
}

function oneButton(tree, id, label) {
  const hits = buttons(tree).filter(button => (id && (hasIdentifier(button.line, id) || hasLabel(button.line, id))) || (label && hasLabel(button.line, label)));
  return hits.length === 1 ? hits[0].n : undefined;
}

// Numbers from a history-open Calculator tree: clear, 7, multiply, 8, equals.
// The first click closes the history and the later numbers go stale inside the call.
export function planStaleBatch(tree) {
  if (!tree.includes('list HistoryView')) {
    return { error: 'Calculator history is closed, so the first click would not renumber the keypad' };
  }
  const numbers = [
    oneButton(tree, 'AllClear', 'All Clear') ?? oneButton(tree, undefined, 'Clear'),
    oneButton(tree, 'Seven', '7'),
    oneButton(tree, 'Multiply', 'Multiply'),
    oneButton(tree, 'Eight', '8'),
    oneButton(tree, 'Equals', 'Equals') ?? oneButton(tree, undefined, '='),
  ];
  if (numbers.some(n => n === undefined)) {
    // The candidate lines show what matched, so a failed live run is enough to fix the plan.
    const wanted = [['AllClear', 'All Clear'], ['Seven', '7'], ['Multiply', 'Multiply'], ['Eight', '8'], ['Equals', 'Equals']];
    const candidates = wanted.map(([id, label]) => ({ id, lines: buttons(tree).filter(b => hasIdentifier(b.line, id) || hasLabel(b.line, id) || hasLabel(b.line, label)).map(b => b.line) }));
    return { error: 'Calculator keypad buttons were not unique in the history-open tree: ' + JSON.stringify(candidates) };
  }
  return { numbers, expected: '56', code: numbers.map(n => `await app.click(${n})`).join('; ') };
}

export function judgeStaleNumber({ text = '', display, expected, error = false }) {
  const named = /renumbered the window|was found by its line|stale-remapped/.test(text);
  const displayOk = display === expected;
  const passed = !error && named && displayOk;
  const reason = passed ? undefined : !named ? 'result did not name the remap'
    : !displayOk ? `display ${display} was not ${expected}` : 'call failed';
  return { passed, named, displayOk, ...(reason ? { reason } : {}) };
}

export function judgeKeyboardTap({ actedOn = [], taps = [], notice = '' }) {
  const held = [...new Set(taps.filter(tap => actedOn.includes(tap.app) || actedOn.includes(tap.bundleId)).map(tap => tap.app || tap.bundleId))];
  const warned = /sleight-warning: (.+?) hold(?:s)? a keyboard event tap/.exec(notice)?.[1].split(' and ') ?? [];
  const passed = held.length === warned.length && held.every(app => warned.includes(app));
  return { passed, held, warned };
}

export function classifyTapSources(sources) {
  const installer = sources.find(source => /CGEventTapCreate\s*\(/.test(source.text));
  if (installer) return { installs: true, skip: false, path: installer.path };
  return {
    installs: false, skip: true,
    reason: 'No bench fixture installs a keyboard event tap. bench/keyboard-taps.swift only lists taps.',
  };
}

export function judgeHelperResend({ sawStartupFailure = false, resends = 0, killedHelper = false }) {
  const passed = sawStartupFailure === true && resends === 1 && !killedHelper;
  return { passed };
}

export function judgeMenuBar(recorded) {
  const passed = STATUS_APPS.includes(recorded.app)
    && recorded.apps?.includes(recorded.app)
    && (recorded.opened === 'menu' || recorded.opened === 'window')
    && recorded.closed === true
    && !recorded.windowStillOpen
    && recorded.chose === undefined
    && recorded.pressed === undefined;
  return { passed };
}

function scrub(value) {
  const home = homedir(), name = userInfo().username;
  const walk = item => {
    if (typeof item === 'string') return item.replaceAll(home, '~').replaceAll(name, '[user]');
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, walk(child)]));
    return item;
  };
  return walk(value);
}

function publish(check, report) {
  const output = join(root, `docs/benchmarks/2026-10-10-live-checks-${check}-${Date.now()}.json`);
  writeFileSync(output, JSON.stringify(scrub(report), null, 2) + '\n');
  console.log(JSON.stringify(scrub({ output, check, passed: report.passed, skipped: report.skipped, error: report.error })));
}

function tapSources() {
  return readdirSync(join(root, 'bench')).filter(name => /tap/i.test(name)).map(name => ({
    path: `bench/${name}`, text: readFileSync(join(root, 'bench', name), 'utf8'),
  }));
}

function toolText(result) {
  return (result?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}

function toolJson(result) {
  if (result?.isError) throw new Error(toolText(result));
  return JSON.parse(toolText(result));
}

async function calculatorState() {
  const { stdout } = await execute('/usr/bin/osascript', ['-l', 'JavaScript', join(root, 'bench/waits-targeting-fixture.js'),
    JSON.stringify({ op: 'running', appId: 'com.apple.calculator' })], { timeout: 15000 });
  return JSON.parse(stdout);
}

async function waitForCalculator() {
  for (let i = 0; i < 50; i++) {
    const state = await calculatorState();
    if (state.pids.length === 1) return;
    if (state.pids.length > 1) throw new Error('Calculator process count is ' + state.pids.length);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Calculator did not stay at one process');
}

async function quitCalculator() {
  await execute('/usr/bin/osascript', ['-l', 'JavaScript', join(root, 'bench/waits-targeting-fixture.js'),
    JSON.stringify({ op: 'quit', appId: 'com.apple.calculator' })], { timeout: 15000 });
  for (let i = 0; i < 30; i++) {
    if (!(await calculatorState()).running) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Owned Calculator quit unconfirmed');
}

function labeledNumber(tree, label) {
  const hits = [];
  for (const line of tree.split('\n')) {
    const match = /^\t*(\d+) (.*)$/.exec(line);
    if (match && hasLabel(match[2], label)) hits.push(Number(match[1]));
  }
  return hits.length === 1 ? hits[0] : undefined;
}

async function readCalculator(client) {
  const result = await client.call('js', {
    code: 'nodeRepl.write(await app.getAXState({ disableDiffing: true }))', timeout_ms: 60000,
  });
  if (result?.isError) throw new Error(toolText(result));
  return toolText(result);
}

async function revealHistory(client, tree) {
  if (tree.includes('list HistoryView')) return tree;
  const show = labeledNumber(tree, 'Show History');
  if (show !== undefined) {
    const clicked = await client.call('js', { code: `await app.click(${show})`, timeout_ms: 60000 });
    if (clicked?.isError) throw new Error(toolText(clicked));
  } else {
    await execute('/usr/bin/osascript', ['-e',
      'tell application "System Events" to tell process "Calculator" to click menu item "Show History" of menu 1 of menu bar item "View" of menu bar 1'],
      { timeout: 15000 });
  }
  return readCalculator(client);
}

// This check's own answer for Clock and Control Center. Other apps stay on the benchmark allowlist.
async function statusApproval(params, fallback) {
  const menu = /^Allow Claude to use (.+)'s menu bar item\?$/.exec(params.message ?? '');
  if (!menu) return fallback(params);
  if (STATUS_APPS.includes(menu[1])) return { action: 'accept', content: {} };
  return { action: 'decline' };
}

async function connect(traces, { launcher = false } = {}) {
  const { resolveServer } = await import('../plugins/sleight/lib/launch.mjs');
  const { probeClient, benchmarkApproval } = await import('./double-keys-client.mjs');
  // menu_bar is one of sleight's local tools, which only the launcher registers: through a bare
  // relay the call failed with "unknown tool: menu_bar" (2026-10-10).
  if (launcher) {
    return probeClient({ command: new URL('../plugins/sleight/bin/sleight-mcp', import.meta.url).pathname, args: [],
      env: { SLEIGHT_SURFACES: 'computer', SLEIGHT_APPROVAL_PROMPT: 'client' } }, {
      relay: false, timeoutMs: 120000,
      approve: params => statusApproval(params, benchmarkApproval),
      record: event => { if (event.direction) traces.push(event.direction); },
    });
  }
  const server = resolveServer({ ...process.env, SLEIGHT_SURFACES: 'computer' });
  if (server.error) throw new Error(server.error);
  return probeClient(server, {
    relay: true, timeoutMs: 120000, relayOptions: { changeReview: false },
    approve: params => statusApproval(params, benchmarkApproval),
    record: event => { if (event.direction) traces.push(event.direction); },
  });
}

async function runStaleNumber(client, report, traces) {
  const before = await calculatorState();
  if (before.pids.length > 1) throw new Error('Calculator process count is ' + before.pids.length);
  report.launched = !before.running;
  if (report.launched) {
    await execute('/usr/bin/open', ['-g', '-b', 'com.apple.calculator'], { timeout: 15000 });
    await waitForCalculator();
  }
  const acquired = await client.call('js', { code: 'var app = await cua.getApp("com.apple.calculator")', timeout_ms: 60000 });
  if (acquired?.isError) throw new Error(toolText(acquired));
  let tree = await revealHistory(client, await readCalculator(client));
  const plan = planStaleBatch(tree);
  if (plan.error) throw new Error(plan.error);
  report.numbers = plan.numbers;
  const batch = await client.call('js', { code: plan.code, timeout_ms: 90000 });
  const shown = toolText(batch);
  let display;
  try { display = calculatorValue(shown); }
  catch { display = calculatorValue(await readCalculator(client)); }
  const judgment = judgeStaleNumber({
    text: shown + '\n' + traces.join('\n'), display, expected: plan.expected, error: !!batch?.isError,
  });
  report.display = display;
  report.judgment = judgment;
  report.passed = judgment.passed;
  if (!judgment.passed) throw new Error(judgment.reason);
}

async function runMenuBar(client, report, state) {
  const listed = toolJson(await client.call('menu_bar', { op: 'apps' }));
  const names = listed.apps ?? [];
  const app = STATUS_APPS.find(name => names.includes(name));
  report.statusItemCount = names.length;
  if (!app) throw new Error('Neither Clock nor Control Center has a status item');
  state.statusApp = app;
  report.app = app;
  const opened = toolJson(await client.call('menu_bar', { op: 'open', app }));
  report.opened = opened.opened;
  report.menuItems = opened.menu?.length;
  report.elements = opened.elements?.length;
  const closed = toolJson(await client.call('menu_bar', { op: 'close', app }));
  report.closed = closed.closed === true;
  report.windowStillOpen = closed.windowStillOpen === true;
  const judgment = judgeMenuBar({
    apps: names, app, opened: opened.opened, closed: report.closed, windowStillOpen: report.windowStillOpen,
  });
  report.passed = judgment.passed;
  if (!judgment.passed) throw new Error('menu bar item was not opened and closed read-only');
  if (report.windowStillOpen) throw new Error('status item stayed open');
}

async function runDriving(check) {
  if (existsSync('/tmp/sleight-hold')) throw new Error('sleight-hold exists; live work stopped');
  const { acquireLiveLock } = await import('./live-lock.mjs');
  const report = { started: new Date().toISOString(), check, ownerAway: true, dryRun: false };
  const state = { cleanup: true, statusApp: undefined };
  const traces = [];
  let unlock, client;
  try {
    unlock = await acquireLiveLock();
    if (existsSync('/tmp/sleight-hold')) throw new Error('sleight-hold exists; live work stopped');
    client = await connect(traces, { launcher: check === 'menu-bar' });
    if (check === 'stale-number') await runStaleNumber(client, report, traces);
    else await runMenuBar(client, report, state);
  } catch (error) {
    report.error = error.message;
    report.passed = false;
    process.exitCode = 1;
  } finally {
    if (state.statusApp && client) {
      try {
        const closed = toolJson(await client.call('menu_bar', { op: 'close', app: state.statusApp }));
        if (closed.windowStillOpen) state.cleanup = false;
        report.finalClose = { closed: closed.closed === true, windowStillOpen: closed.windowStillOpen === true };
      } catch (error) {
        state.cleanup = false;
        report.cleanupError = error.message;
      }
    }
    try { await client?.close(); }
    catch (error) { state.cleanup = false; report.cleanupError = error.message; }
    if (report.launched) {
      try { await quitCalculator(); report.calculatorQuit = true; }
      catch (error) { state.cleanup = false; report.cleanupError = error.message; }
    }
    try {
      if (unlock && state.cleanup) { await unlock(); report.lockReleased = true; }
      else if (unlock) report.lockRetained = true;
    } catch (error) {
      report.lockError = error.message;
      process.exitCode = 1;
    }
    report.finished = new Date().toISOString();
    publish(check, report);
  }
}

async function main() {
  let args;
  try { args = parseLiveChecksArgs(process.argv); }
  catch (error) { console.error(error.message); process.exitCode = 1; return; }
  if (args.dryRun) { console.log(JSON.stringify(dryRunReport(args.check))); return; }
  if (!args.ownerAway) {
    console.error('Live checks require --owner-away. Refusing before the live lock.');
    process.exitCode = 1;
    return;
  }
  if (args.check === 'keyboard-tap') {
    const status = classifyTapSources(tapSources());
    const reason = status.installs
      ? `${status.path} installs a keyboard event tap. This check does not run it, because nothing in bench/ removes a tap it installed.`
      : status.reason;
    publish(args.check, {
      started: new Date().toISOString(), check: args.check, ownerAway: true, skipped: true, passed: false,
      installsTap: false, killsHelper: false, reason,
    });
    return;
  }
  if (args.check === 'helper-resend') {
    publish(args.check, {
      started: new Date().toISOString(), check: args.check, ownerAway: true, skipped: true, passed: false,
      killsHelper: false, installsTap: false, reason: HELPER_SKIP,
    });
    return;
  }
  await runDriving(args.check);
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return pathToFileURL(process.argv[1]).href === import.meta.url; }
}

if (invokedDirectly()) await main();
