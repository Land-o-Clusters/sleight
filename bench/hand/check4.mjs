#!/usr/bin/env node
// Live check 4. Module import and --dry-run have no child processes or writes.
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const TASKS = Object.freeze(['textedit-drag', 'finder-move', 'preview-read', 'calculator-click', 'textedit-calculator']);
export const MODEL_TASKS = Object.freeze([...TASKS, 'textedit-window-drag', 'preview-early-scroll']);
export function modelBenchCommand(id, config = '<attempt>/bench-config.json') {
  return ['node', 'bench/run.mjs', '--suite', 'world', '--arm', 'sleight', '--tasks', id, '--runs', '1',
    '--model', 'claude-haiku-5-5', '--effort', 'high', '--auth', 'login', '--owner-away', '--check4-config', config];
}
export function check4RunVerdict(state) {
  if (state.plan?.smoke || state.plan?.singleTask) return state.plan.tasks.length === 1 &&
    state.plan.tasks.every(({ id }) => state.tasks?.[id]?.complete === true && state.tasks[id].verdict === 'pass' &&
      (state.plan.smoke ? (state.tasks[id].smoke?.shownAtStageFamily === true || state.tasks[id].smoke?.shownAtStage === true) && state.tasks[id].smoke?.targetsReceived === true &&
        state.tasks[id].panelAgreement?.passed === true : state.tasks[id].measured === true)) ?
    state.plan.smoke ? 'smoke-pass' : 'single-task-pass' : 'fail';
  const tasks = state.plan?.continuationFrom ? state.plan.tasks.map(t => t.id) : state.plan?.drive === 'model' ? MODEL_TASKS : TASKS;
  const tasksPassed = tasks.every(id => state.tasks?.[id]?.complete === true && state.tasks[id].measured === true && state.tasks[id].verdict === 'pass');
  if (state.plan?.costsDeferred) return tasksPassed ? 'tasks-pass' : 'fail';
  return tasksPassed && state.costs?.complete === true && state.costs.result?.verdict === 'pass' ? 'pass' : 'fail';
}
export function check4Options(argv, env = process.env) {
  const systemTemp = realpathSync('/tmp');
  const opts = { drive: 'model', out: join(systemTemp, 'charcheck4'), recordings: join(systemTemp, 'charcheck4-recordings.json') };
  if (env.SLEIGHT_OWNER_AWAY_FILE) opts.ownerAwayFile = resolve(env.SLEIGHT_OWNER_AWAY_FILE);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--owner-away') opts.ownerAway = true;
    else if (arg === '--resume') opts.resume = true;
    else if (arg === '--smoke') opts.smoke = true;
    else if (arg === '--skip-costs') opts.skipCosts = true;
    else if (arg === '--record-window-frames') opts.recordWindowFrames = true;
    else if (arg === '--from-task' && MODEL_TASKS.includes(argv[i + 1])) opts.fromTask = argv[++i];
    else if (arg === '--tasks' && MODEL_TASKS.includes(argv[i + 1])) opts.tasks = [argv[++i]];
    else if (arg === '--drive' && ['model', 'replay'].includes(argv[i + 1])) opts.drive = argv[++i];
    else if (['--out', '--recordings'].includes(arg) && argv[i + 1] && !argv[i + 1].startsWith('--')) opts[arg.slice(2)] = resolve(argv[++i]);
    else if (arg === '--owner-away-file' && argv[i + 1] && !argv[i + 1].startsWith('--')) opts.ownerAwayFile = resolve(argv[++i]);
    else throw Error(`Unexpected argument ${arg}`);
  }
  // Require the canonical system temporary bank before taking the live lock.
  if (!opts.out.startsWith(systemTemp + '/')) throw Error(`Check 4 --out must be under ${systemTemp}/`);
  if ((opts.smoke || opts.tasks) && opts.drive !== 'model') throw Error('Single-task and smoke runs require --drive model');
  if (opts.fromTask && (opts.drive !== 'model' || opts.smoke || opts.tasks || !opts.skipCosts))
    throw Error('--from-task requires model driving, --skip-costs and no single-task or smoke selector');
  return opts;
}
export function check4Plan(opts) {
  const drive = opts.drive ?? 'model';
  const selected = opts.fromTask ? MODEL_TASKS.slice(MODEL_TASKS.indexOf(opts.fromTask)) :
    opts.tasks ?? (opts.smoke ? ['calculator-click'] : drive === 'model' ? MODEL_TASKS : TASKS);
  return { schema: 'sleight.character-check4/1', drive, smoke: opts.smoke === true, singleTask: Boolean(opts.tasks), tasks: selected.map(id => ({ id, engine: 'ChatGPT', character: 'mabel', size: 'stage',
    fixtureRetries: 1, ...(drive === 'model' ? { benchCommand: modelBenchCommand(id),
      ...(id === 'textedit-window-drag' ? { crossWindowDrag: true, requires: 'benchmark drag-method check and host cross-window frame' } : {}),
      ...(id === 'preview-early-scroll' ? { earlyScroll: true, requires: 'correlated scroll among the first two action-bearing calls after open_file' } : {}) }
      : { ...(id === 'finder-move' ? { requires: 'cross-window drag in recording' } : {}),
        ...(id === 'preview-read' ? { requires: 'scroll in first fifth; otherwise explicit recorded fallback' } : {}) }) })),
    ...(opts.fromTask ? { continuationFrom: opts.fromTask } : {}),
    ...(opts.recordWindowFrames ? { recordWindowFrames: true } : {}),
    recordings: opts.recordings, recordingBankExample: 'bench/hand/check4-recordings.example.json', out: opts.out, samplingHz: 20, gapHiddenAboveMs: 100, visibilityBar: 0.8,
    samplerIntersectionBar: 0, traceIntersectionBar: 0, lock: '/tmp/sleight-live.lock', hold: '/tmp/sleight-hold', minHidIdleS: 30,
    ...(opts.skipCosts ? { costsDeferred: true } : {}),
    costs: opts.smoke || opts.tasks || opts.skipCosts ? null : { adapter: 'runLiveStage', sizes: 'all', character: 'mabel', limits: 'unchanged STAGE_BUDGET', pointer: 'unchanged behavior.pointer',
      note: 'existing pacing and capture phases also run unchanged; no new video recording' },
    expectedMinutes: opts.smoke || opts.tasks ? 5 : drive === 'model' ? 100 : 90, processesStarted: 0, filesWritten: 0 };
}
export async function runTasks(tasks, state, deps) {
  for (const task of tasks) {
    if (state.tasks[task.id]?.complete) continue;
    await deps.boundary();
    const previous = state.tasks[task.id];
    const row = state.tasks[task.id] = { complete: false, attempts: previous?.attempts ?? [] };
    await deps.checkpoint(state);
    for (let attempt = 1; attempt <= 2; attempt++) {
      await deps.boundary();
      const result = await deps.attempt(task, attempt);
      row.attempts.push(result);
      Object.assign(row, result, { complete: false });
      await deps.checkpoint(state);
      if (result.cleanupConfirmed !== true) throw Error(`Task ${task.id} cleanup unproved; lock retained`);
      if (result.stopped) throw Error(result.reason ?? 'check 4 interrupted');
      if (!result.fixtureFailure || attempt === 2) break;
    }
    row.complete = true;
    if (!row.measured) { row.visibleShare = null; if (row.verdict !== 'fail' && !row.smoke) row.verdict = 'unmeasured'; }
    await deps.checkpoint(state);
  }
  return state;
}
// The stage fixture raises the changing backdrop only while this marker exists (stage-fixture.swift begin()).
export const check4CostOptions = (opts, { character, out }) =>
  ({ ownerAway: true, size: 'all', character, out: join(out, 'costs'), ownerAwayFile: opts.ownerAwayFile });
export async function main(argv = process.argv.slice(2), deps = {}) {
  const opts = check4Options(argv, deps.env), plan = check4Plan(opts);
  if (opts.dryRun) { (deps.print ?? console.log)(JSON.stringify(plan, null, 2)); return plan; }
  if (!opts.ownerAway) throw Error('Live check 4 requires --owner-away; use --dry-run for the plan');
  if (plan.costs && !(opts.ownerAwayFile && (deps.exists ?? existsSync)(opts.ownerAwayFile)))
    throw Error('Check 4 costs need --owner-away-file FILE (or SLEIGHT_OWNER_AWAY_FILE) naming a present owner-away marker');
  const live = deps.live ?? (await import('./check4-live.mjs')).runCheck4;
  return live(opts, plan);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  // No top-level await: check4-live.mjs imports this module back, and a cycle through a top-level await never settles.
  main().then(result => { if (!result?.processesStarted && result?.verdict && !['pass', 'smoke-pass', 'single-task-pass', 'tasks-pass'].includes(result.verdict)) process.exitCode = 1; },
    error => { console.error(`Check 4 stopped: ${error.message}`); process.exitCode = 1; });
}
