#!/usr/bin/env node
// Dry runs read data only. Live harnesses are separate owned child processes.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { runOwned } from './preapproved-process.mjs';

const root = new URL('../', import.meta.url).pathname;
const execute = promisify(execFile);
const hold = '/tmp/sleight-hold', lock = '/tmp/sleight-live.lock';
const scrub = value => String(value).replaceAll(homedir(), '~').replace(/\/Users\/[^/\s"']+/g, '~');
const bench = (...args) => ['node', 'bench/run.mjs', ...args];
const h2h = ['--arm', 'sleight,codex', '--tasks', 'calculator-click,textedit-edit,textedit-save', '--runs', '3'];
// Codex arms set ChatGPT's "Always allow" list to the benchmark apps and restore it on exit (owner's OK,
// 2026-10-09); a killed runner leaves it changed, so STATE names the backup to restore from.

// Phrases match the away sitting in STATE, not its owner-present or release lists.
const definitions = [
  { id: 'h2h-clean', phrase: 'Codex head-to-head with clean arms', command: bench(...h2h, '--clean-arms', '--owner-away'),
    evidence: '2026-10-10-h2h-clean-arms.json' },
  { id: 'h2h-normal', phrase: "owner's setup", command: bench(...h2h, '--owner-away'),
    evidence: '2026-10-10-h2h-normal-setup.json' },
  { id: 'textedit-drag', phrase: 'textedit-drag', command: bench('--arm', 'sleight', '--tasks', 'textedit-drag', '--runs', '3', '--owner-away'),
    evidence: '2026-10-10-release-haiku-3.json', task: 'textedit-drag', repetitions: 3 },
  { id: 'chess-points', phrase: 'Chess with computed points', command: ['node', 'bench/reliability-live.mjs', 'chess-after'],
    evidence: '2026-10-08-reliability-chess-after-20261008181417620.json' },
  { id: 'simulator-form', phrase: 'simulator-form x3', command: bench('--arm', 'sleight', '--tasks', 'simulator-form', '--runs', '3', '--owner-away'),
    evidence: '2026-10-09-release-1.1.0.json', task: 'simulator-form', repetitions: 3 },
  { id: 'save-delivery', phrase: '--delivery-check', command: ['node', 'bench/textedit-save-lock.mjs', '--delivery-check'],
    evidence: '2026-10-10-save-lock-delivery-1791683287210.json' },
  { id: 'save-lock', phrase: 'then the full run', command: ['node', 'bench/textedit-save-lock.mjs'],
    evidence: '2026-10-10-save-lock-experiment-1791679933967.json' },
  { id: 'select-all', phrase: 'select-all', command: ['node', 'bench/small-fixes-textedit.mjs', '--quick'],
    evidence: '2026-10-11-exact-text-1791680045503.json' },
  { id: 'stale-number', phrase: 'stale-number', command: ['node', 'bench/live-checks-1-1.mjs', 'stale-number', '--owner-away'],
    evidence: '2026-10-10-live-checks-stale-number-1791679612845.json' },
  { id: 'menu-bar', phrase: 'menu-bar', command: ['node', 'bench/live-checks-1-1.mjs', 'menu-bar', '--owner-away'],
    evidence: '2026-10-10-live-checks-menu-bar-1791676640273.json' },
  { id: 'shop-smoke', phrase: 'shop smoke tasks', command: bench('--arm', 'sleight', '--suite', 'real', '--tasks', 'real-shop-target,real-shop-bestbuy', '--runs', '1', '--owner-away'),
    evidence: '2026-10-10-real-shop-smoke.json' },
  { id: 'best-buy', phrase: 'Best Buy', command: bench('--arm', 'sleight', '--suite', 'real', '--tasks', 'real-shop-bestbuy', '--runs', '1', '--owner-away'),
    evidence: '2026-10-11-real-shop-bestbuy-traced.json' },
  { id: 'quiet-cpu', phrase: 'quiet-box CPU comparison', command: null,
    blocked: 'Covered by h2h-clean: its own-CPU numbers are the quiet-box comparison when no other project ran a window.' },
];

export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--owner-away') options.ownerAway = true;
    else if (arg === '--only' || arg === '--from') {
      if (options[arg.slice(2)] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Invalid ${arg}`);
      options[arg.slice(2)] = args[++i];
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.only && options.from) throw new Error('Use either --only or --from');
  return options;
}

function estimate(definition) {
  const source = definition.evidence && `docs/benchmarks/${definition.evidence}`;
  if (!source) return { estimatedMinutes: null, estimateSource: 'No dedicated past result', estimateBasis: 'unknown' };
  let seconds;
  try {
    const data = JSON.parse(readFileSync(join(root, source), 'utf8'));
    if (Array.isArray(data.results)) {
      const rows = data.results.filter(row => (!definition.task || row.task === definition.task) && Number.isFinite(row.seconds));
      if (rows.length) seconds = rows.reduce((sum, row) => sum + row.seconds, 0) * (definition.repetitions ? definition.repetitions / rows.length : 1);
    } else seconds = (Date.parse(data.finished) - Date.parse(data.started)) / 1000;
  } catch { /* Missing measurements stay unknown. */ }
  return { estimatedMinutes: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 6) / 10 : null,
    estimateSource: source, estimateBasis: definition.task ? 'mean recorded task time times selected repetitions' : 'recorded run time, failures included' };
}

export function buildPlan(options = {}, state = readFileSync(join(root, 'docs/status/STATE.md'), 'utf8')) {
  const next = state.split('Next, in order:')[1]?.split('\n3.')[0];
  const away = next?.slice(next.indexOf('\n2.')).replace(/\s+/g, ' ');
  if (!away || !away.includes('one away sitting')) throw new Error('STATE away sitting list is missing');
  // Pin the entire paragraph, so a newly inserted step cannot silently disappear.
  if (createHash('sha256').update(away).digest('hex') !== 'd2de075443668ae9fe8d2558ff726b99bdc3c5fc2175d185e852cbb75d26f8b3') {
    throw new Error('STATE away sitting changed since d21965c; review the step mapping');
  }
  let cursor = 0;
  let steps = definitions.map(definition => {
    const at = away.indexOf(definition.phrase, cursor);
    if (at < 0) throw new Error(`STATE away sitting changed at ${definition.id}; review the commands`);
    cursor = at + definition.phrase.length;
    const { evidence, task, repetitions, phrase, ...step } = definition;
    return { ...step, ...estimate(definition) };
  });
  if (options.only && options.from) throw new Error('Use either --only or --from');
  const selected = options.only?.split(',') ?? (options.from ? [options.from] : []);
  if (new Set(selected).size !== selected.length || selected.some(id => !steps.some(step => step.id === id))) throw new Error('Unknown or duplicate step selector');
  if (options.only) steps = steps.filter(step => selected.includes(step.id));
  if (options.from) steps = steps.slice(steps.findIndex(step => step.id === options.from));
  return { dryRun: Boolean(options.dryRun), drives: false, lock: false, stateSource: 'docs/status/STATE.md',
    windowMinutes: [75, 90], estimateNote: 'Past timings exclude some setup and cleanup. Unknown estimates are null. The 75 to 90 minute window is not a measured total.',
    watchers: ['.dev/passes/front-watch.sh', 'bench/keyboard-taps.swift (precompiled cache binary)'], steps };
}

export function frontReport(line, baseline) {
  const match = /^\d{2}:\d{2}:\d{2}(?:\.\S+)? (.+)$/.exec(line.trim());
  if (!match) return { baseline, stop: 'foreground watcher report missing or malformed' };
  if (baseline && match[1] !== baseline) return { baseline, stop: 'foreground changed' };
  return { baseline: match[1] };
}

// Taps held before the sitting starts (a window manager, Siri) are the owner's and stay; a process
// that installs one during the sitting stops it. The first live start stopped on Magnet's and Siri's
// standing taps (2026-10-11). The engine's helper holds two taps from its first key action in every
// session, Codex's too, and stopped the second start; `engine` names its pids.
export const ENGINE_HELPER = /\/\.codex\/computer-use\/[^/]+\.app\/|\bcom\.openai\.sky\.CUAService\b/;
export function tapReport(text, baseline, engine = new Set(), paths = new Map()) {
  try {
    const taps = JSON.parse(text);
    if (!Array.isArray(taps) || taps.some(tap => !tap || !Number.isInteger(tap.pid) || typeof tap.app !== 'string')) throw new Error();
    const added = taps.filter(tap => !baseline?.has(tap.pid) && !engine.has(tap.pid));
    return added.length ? `keyboard tap reported (${[...new Set(added.map(tap => paths.get(tap.pid) ? `${tap.app} at ${paths.get(tap.pid)}` : tap.app))].join(', ')})` : undefined;
  } catch { return 'keyboard watcher report malformed'; }
}
export function tapBaseline(text) {
  try { return new Set(JSON.parse(text).map(tap => tap.pid)); } catch { return undefined; }
}

// Injected dependencies let tests exercise scheduling without a subprocess or app.
export async function runSteps(steps, deps) {
  let failed = false;
  for (const step of steps) {
    const start = deps.now();
    const before = await deps.check();
    if (before) {
      deps.log({ step: step.id, start, end: deps.now(), exitCode: 125, results: [], stop: before });
      return 2;
    }
    let result;
    if (step.blocked || !step.command) result = { code: 126, blocked: step.blocked ?? 'No command' };
    else {
      try { result = await deps.run(step); }
      catch { result = { code: 127, blocked: 'Step process could not start' }; }
    }
    const row = { step: step.id, start, end: deps.now(), exitCode: result.code ?? 1, results: await deps.results(step) };
    if (result.stop) row.stop = result.stop;
    if (result.blocked) row.blocked = result.blocked;
    deps.log(row);
    if (result.stop) return 2;
    failed ||= row.exitCode !== 0;
  }
  return failed ? 1 : 0;
}

export async function runHarness(step, signal, {
  drive = runOwned, interrupt = pid => process.kill(pid, 'SIGINT'), cleanupMs = 30000,
  schedule = setTimeout, unschedule = clearTimeout,
} = {}) {
  if (signal.aborted) return { code: 130, stop: signal.reason, stdout: '', stderr: '' };
  const forced = new AbortController();
  let pid, timer, cancelling = false;
  const cancel = () => {
    if (!pid || cancelling) return;
    cancelling = true;
    // Only the harness gets SIGINT first. Its finally block owns app and engine cleanup.
    try { interrupt(pid); }
    catch (error) { if (error.code !== 'ESRCH') forced.abort(); }
    timer = schedule(() => forced.abort(), cleanupMs);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const command = step.command[0] === 'node' ? process.execPath : step.command[0];
    const result = await drive(command, step.command.slice(1), { cwd: root, signal: forced.signal,
      timeoutMs: 90 * 60 * 1000, onSpawn: ownedPid => { pid = ownedPid; if (signal.aborted) cancel(); } });
    const stop = forced.signal.aborted || result.exit.signal ? 'signal termination; app and detached engine cleanup unconfirmed' :
      signal.aborted ? signal.reason : !result.groupClean ? 'owned process group cleanup unconfirmed' :
        result.timedOut ? 'step exceeded 90 minute limit; cleanup unconfirmed' : undefined;
    return { code: result.exit.code ?? 1, stdout: result.stdout, stderr: result.stderr, ...(stop && { stop }) };
  } finally {
    unschedule(timer); signal.removeEventListener('abort', cancel);
  }
}

function artifacts() {
  const files = new Map();
  for (const folder of ['bench/results', 'docs/benchmarks']) {
    if (!existsSync(join(root, folder))) continue;
    for (const name of readdirSync(join(root, folder))) {
      if (!name.endsWith('.json')) continue;
      const path = join(folder, name), stat = statSync(join(root, path));
      files.set(path, `${stat.mtimeMs}:${stat.size}`);
    }
  }
  return files;
}

async function watch(controller) {
  const script = join(root, '.dev/passes/front-watch.sh');
  const taps = join(homedir(), 'Library/Caches/sleight-bench/keyboard-taps');
  if (!existsSync(script) || !existsSync(taps)) throw new Error('Existing front watcher and precompiled keyboard-taps binary are required; no step started');
  let baseline, tapsBefore, stopping = false, buffer = '', timer;
  const stop = reason => { if (!controller.signal.aborted) controller.abort(reason); };
  const child = spawn('/bin/zsh', [script], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  child.on('error', () => stop('foreground watcher failed'));
  child.on('close', () => { if (!stopping) stop('foreground watcher exited'); });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const report = frontReport(buffer.slice(0, newline), baseline);
      buffer = buffer.slice(newline + 1); baseline = report.baseline;
      if (report.stop) stop(report.stop);
    }
  });
  let polling = Promise.resolve();
  const poll = () => {
    polling = (async () => {
      if (existsSync(hold)) stop('hold exists');
      try {
        const { stdout } = await execute(taps, [], { timeout: 3000, maxBuffer: 1024 * 1024 });
        tapsBefore ??= tapBaseline(stdout);
        const engine = new Set(), paths = new Map();
        for (const pid of new Set(JSON.parse(stdout).map(tap => tap.pid))) {
          if (tapsBefore?.has(pid)) continue;
          const path = await execute('/bin/ps', ['-o', 'comm=', '-p', String(pid)], { timeout: 2000 }).then(r => r.stdout.trim(), () => '');
          const bundle = await execute('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', String(pid)], { timeout: 2000 }).then(r => r.stdout.trim(), () => '');
          paths.set(pid, scrub(path || bundle || 'unknown'));
          // A tap whose process has already exited can't hold the keyboard: the third start stopped on
          // one with no name and no process left (2026-10-11).
          if (ENGINE_HELPER.test(path) || ENGINE_HELPER.test(bundle) || !path) engine.add(pid);
        }
        const reason = tapReport(stdout, tapsBefore, engine, paths); if (reason) stop(reason);
      } catch { stop('keyboard watcher failed'); }
      if (!stopping) timer = setTimeout(poll, 500);
    })();
  };
  const dispose = async () => {
    stopping = true; clearTimeout(timer); await polling;
    if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await closed;
  };
  poll(); await polling;
  const deadline = Date.now() + 5000;
  while (!baseline && !controller.signal.aborted && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  if (!baseline) stop('foreground watcher baseline missing');
  return { dispose };
}

async function live(plan) {
  // This runner never owns or removes the shared lock. Each existing harness owns it.
  if (existsSync(hold) || existsSync(lock)) throw new Error('Hold or live lock exists; no watcher or step started');
  const controller = new AbortController();
  const interrupted = () => controller.abort('operator interrupt');
  process.on('SIGINT', interrupted); process.on('SIGTERM', interrupted);
  let watcher;
  const bank = mkdtempSync('/private/tmp/sleight-away-');
  let before = artifacts(), stepLog;
  try {
    watcher = await watch(controller);
    return await runSteps(plan.steps, {
      now: () => new Date().toISOString(),
      check: async () => controller.signal.aborted ? controller.signal.reason : existsSync(hold) ? 'hold exists' : existsSync(lock) ? 'live lock retained' : undefined,
      run: async step => {
        before = artifacts(); stepLog = join(bank, `${step.id}.log`);
        const result = await runHarness(step, controller.signal);
        // Private child output is never sent to the terminal or published by this runner.
        writeFileSync(stepLog, scrub(result.stdout + '\n' + result.stderr), { mode: 0o600 });
        return { code: result.code,
          ...(result.stop ? { stop: result.stop } : existsSync(lock) ? { stop: 'live lock retained' } : {}) };
      },
      results: async () => [...artifacts()].filter(([path, identity]) => before.get(path) !== identity).map(([path]) => path),
      log: row => {
        const receipt = join(bank, `${row.step}.json`);
        const record = { ...row, receipt: scrub(receipt), ...(stepLog && { log: scrub(stepLog) }) };
        writeFileSync(receipt, JSON.stringify(record) + '\n', { mode: 0o600 });
        console.log(JSON.stringify(record)); stepLog = undefined; before = artifacts();
      },
    });
  } finally {
    await watcher?.dispose();
    process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted);
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2)), plan = buildPlan(options);
    if (options.dryRun) { console.log(JSON.stringify(plan, null, 2)); return; }
    if (!options.ownerAway) throw new Error('Live sitting requires --owner-away after the owner grants the complete window');
    process.exitCode = await live(plan);
  } catch (error) { console.error(scrub(error.message)); process.exitCode = 2; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
