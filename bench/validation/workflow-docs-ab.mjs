#!/usr/bin/env node
// WF3 runs both flag settings on one candidate. The existing harnesses own fixtures and the live lock.
// Default mode only prints a plan. Runtime injection is an import-only seam for offline tests.
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEngine } from '../engine-version.mjs';
import { ccCatalog } from '../world/cc-held-out.mjs';
import { roundCommand, safeResult } from './validation-140.mjs';
import { outsideGit } from '../world/arms/browser.mjs';
import { hasPermissionRefusal } from '../permission-refusal.mjs';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const RESET = '2026-10-21T15:00:00Z';
const MODEL = 'claude-haiku-5-5';
const UPSTREAM = '6a12d606511d8fd7cb6a32530aafb068cc64aeb2';
const SOURCE_PATHS = ['plugins', 'bench', 'scripts', 'package.json', 'package-lock.json'];
const SURVEYS = 'bench/world/tasks/browser-open-heldout.json';
const sha = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const git = (root, ...args) => execFileSync('/usr/bin/git', ['-C', root, ...args], {
  encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});

export function sourcePins(build, root = ROOT) {
  const inventory = git(root, 'ls-tree', '-r', build, '--', ...SOURCE_PATHS).split('\n')
    .filter(line => line && !line.includes('\tbench/results/'));
  return { build, pluginTree: git(root, 'rev-parse', `${build}:plugins`).trim(), harnessHash: sha(inventory.join('\n')) };
}

export function verifySources(plan) {
  if (git(ROOT, 'rev-parse', 'HEAD').trim() !== plan.build) throw Error('Candidate build changed; use the pinned checkout');
  if (JSON.stringify(sourcePins(plan.build)) !== JSON.stringify(plan.pins)) throw Error('Candidate source pins changed');
  if (git(ROOT, 'status', '--porcelain', '--untracked-files=no').trim()) throw Error('Candidate has tracked changes');
  const changes = git(ROOT, 'status', '--porcelain', '--untracked-files=all', '--', ...SOURCE_PATHS)
    .split('\n').filter(line => line && !line.slice(3).startsWith('bench/results/'));
  if (changes.length) throw Error('Candidate plugin or harness is dirty; commit and pin it before running');
  const cache = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser');
  if (git(cache, 'rev-parse', 'HEAD').trim() !== UPSTREAM ||
      git(cache, 'diff') !== readFileSync(join(ROOT, 'bench/fowl/sleight-surface.patch'), 'utf8') ||
      git(cache, 'diff', '--cached').trim())
    throw Error('FowlBrowser cache must already have the production pin and exact sleight patch; prepare it outside this run');
}

export function makeWorkflowPlan({ build, engine, out, pins }) {
  if (!/^[a-f0-9]{40}$/.test(build ?? '')) throw Error('--build requires a full candidate commit SHA');
  if (!/^\d+(\.\d+)+$/.test(engine ?? '')) throw Error('--engine requires an explicit engine version');
  out = resolve(out ?? join(realpathSync(tmpdir()), `sleight-wf3-${build.slice(0, 12)}-${randomUUID()}`));
  outputParents(out);
  outsideGit(out);
  pins ??= sourcePins(build);
  const catalog = json(join(ROOT, SURVEYS));
  const groups = ['safari', 'firefox'].map(browser => ({ id: `as3-${browser}`, runner: 'browser', browser,
    tasks: ['survey-p09', 'survey-p10'], catalog: SURVEYS }));
  for (const id of ['cc-dropdown-slow-firefox', 'cc-dropdown-slow-safari', 'cc-calendar-ambiguous-firefox']) {
    const rows = ccCatalog.filter(row => row.task === id);
    if (rows.length !== 1 || rows[0].half !== 'browser') throw Error(`Missing or duplicate CC identity: ${id}`);
    groups.push({ id, runner: 'native', browser: rows[0].browser, tasks: [id], catalog: 'bench/world/tasks/cc-held-out.json' });
  }
  for (const group of groups) group.taskPins = Object.fromEntries(group.tasks.map(id => {
    const matches = (group.runner === 'browser' ? catalog : ccCatalog).filter(row => (row.name ?? row.task) === id);
    if (matches.length !== 1) throw Error(`Missing or duplicate task: ${id}`);
    const task = matches[0];
    return [id, { hash: sha(JSON.stringify(task)), prompt: task.prompt, promptHash: sha(task.prompt) }];
  }));
  const rounds = [];
  for (let n = 1; n <= 3; n++) for (const group of groups) for (const task of group.tasks)
    for (const side of n % 2 ? ['docs0', 'default'] : ['default', 'docs0'])
      rounds.push({ id: `${group.id}${group.runner === 'browser' ? `-${task}` : ''}-${side}-r${n}`,
        group: group.id, runner: group.runner, browser: group.browser, tasks: [task], model: MODEL, side, n });
  return { schema: 1, study: 'WF3', live: false, root: ROOT, build, pins, engine, model: MODEL, effort: 'high',
    quotaReset: RESET, upstream: UPSTREAM, groups, rounds,
    out,
    treatment: { docs0: { SLEIGHT_WORKFLOW_DOCS: '0' }, default: {} },
    promptEvidence: 'Task definitions and the entire prompt harness are pinned. Native runs do not persist rendered prompts; browser effort is pinned by the invocation, not a result field.',
    note: 'The flag also controls action-number compaction. This measures the whole flag, not only Workflow wording.' };
}

// No inherited experiment flags, API credentials, Claude identity or loader controls.
export function workflowEnvironment(side, host = process.env) {
  if (!['docs0', 'default'].includes(side)) throw Error('Unknown WF3 side');
  return { ...Object.fromEntries(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM']
    .filter(key => typeof host[key] === 'string').map(key => [key, host[key]])),
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', SLEIGHT_BENCH_HAND: '0', SLEIGHT_NO_HUB: '1',
    SLEIGHT_TURBO: '0', SLEIGHT_SURFACES: 'computer',
    ...(side === 'docs0' ? { SLEIGHT_WORKFLOW_DOCS: '0' } : {}) };
}

export function productionGate(out, exists = existsSync) {
  if (exists('/tmp/sleight-hold')) throw Error('Benchmark hold is active');
  if (exists('/tmp/sleight-live.lock')) throw Error('Live lock is held; never remove it from this driver');
  if (exists(join(out, 'pause'))) throw Error('WF3 pause is active');
}

function outputParents(out) {
  for (let path = out; ; path = dirname(path)) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw Error('Output has a symlink ancestor');
    if (dirname(path) === path) break;
  }
}

async function child(round, invocation, log, signal) {
  const config = mkdtempSync(join(tmpdir(), 'lane-claude-'));
  const env = { ...workflowEnvironment(round.side), CLAUDE_CONFIG_DIR: config };
  if (round.runner === 'browser') env.SLEIGHT_TRACE = `${join(dirname(log), round.id)}.trace`;
  try {
    return await new Promise((done, fail) => {
      const p = spawn(invocation.command, invocation.args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const stop = () => { p.kill('SIGINT'); };
      signal.addEventListener('abort', stop, { once: true });
      p.stdout.on('data', data => appendFileSync(log, data));
      p.stderr.on('data', data => appendFileSync(log, data));
      p.once('error', fail);
      p.once('close', (code, childSignal) => {
        signal.removeEventListener('abort', stop);
        done({ code, signal: childSignal });
      });
    });
  } finally { rmSync(config, { recursive: true, force: true }); }
}

const stops = ['permissionPrompt', 'permissionRefusal', 'observerError', 'appDialog', 'approvalStop', 'cancelled'];
export function collectWorkflow(round, plan, log) {
  const stem = join(plan.out, round.id);
  const result = round.runner === 'browser' ? stem : /^results: (.+)$/m.exec(readFileSync(log, 'utf8'))?.[1];
  if (!result || !safeResult(result, round.runner, round.tasks, plan.engine, plan.model, plan.build))
    throw Error('Incomplete identity, model, engine or cleanup evidence');
  const group = plan.groups.find(g => g.id === round.group);
  let rows;
  if (round.runner === 'browser') {
    if (existsSync(join(result, 'harness-failure.json'))) throw Error('Browser harness failure');
    const raw = json(join(result, 'results.json'));
    const commits = json(join(result, 'commits.json'));
    if (commits.build.dirty || commits.harness?.commit !== plan.build || commits.harness.dirty || commits.fowlbrowser?.commit !== plan.upstream)
      throw Error('Browser build or harness differs from candidate');
    rows = raw.map(row => {
      // Production records refusals in errorClass and stream-json tool results, not row.run flags.
      // Use the native stop predicate so scoring precedence or a later success cannot hide a refusal.
      const events = readFileSync(join(result, row.task.name, 'events.jsonl'), 'utf8');
      if (row.errorClass?.class === 'approval refused' ||
          events.split('\n').some(line => {
            let event; try { event = JSON.parse(line); } catch { return false; }
            return hasPermissionRefusal(event);
          }) ||
          stops.some(key => row.run[key])) throw Error('Browser permission or safety stop');
      const config = json(join(result, row.task.name, 'mcp.json')).mcpServers['plugin:sleight:computer'];
      const flag = config?.env?.SLEIGHT_WORKFLOW_DOCS;
      if ((round.side === 'docs0' ? flag !== '0' : flag !== undefined) || config?.env?.SLEIGHT_TURBO !== '0' ||
          row.task.browser !== round.browser ||
          row.task.prompt !== group.taskPins[row.task.name].prompt)
        throw Error('Browser treatment, prompt, effort or safety evidence mismatch');
      return { task: row.task.name, passed: row.outcome?.ok === true, seconds: row.wallMs / 1000,
        apiMs: row.run.result.duration_api_ms, turns: row.run.result.num_turns, toolCalls: row.toolCalls, toolErrors: row.toolErrors };
    });
  } else {
    const raw = json(result);
    if (raw.sleight?.dirty || raw.ownerAway !== true || raw.hygieneError || raw.passCleanupErrors?.length ||
        raw.results.some(row => stops.some(key => row[key]))) throw Error('Native safety or build evidence mismatch');
    rows = raw.results.map(row => {
      // Dynamic fixture URLs vary, but every other byte must match the pinned task prompt.
      const expected = group.taskPins[row.task].prompt.replace('{url}', '{fixture-url}');
      if (row.prompt !== undefined && row.prompt.replace(/http:\/\/127\.0\.0\.1:\d+\/held-out\/[a-z-]+\/[A-Za-z0-9_-]+\//g, '{fixture-url}') !== expected)
        throw Error('Native prompt differs from pinned task template');
      return { task: row.task, passed: row.passed === true, seconds: row.seconds, apiMs: row.timing?.modelMs,
        toolMs: row.timing?.toolWallMs, engineMs: row.timing?.engineMs,
        turns: row.turns, toolCalls: row.toolCalls, toolErrors: row.toolErrors };
    });
    writeFileSync(`${stem}.json`, readFileSync(result), { flag: 'wx', mode: 0o600 });
  }
  if (rows.some(row => !Number.isFinite(row.seconds) || row.seconds < 0)) throw Error('Invalid task timing');
  return { safe: true, result, rows };
}

export function workflowSummary(plan, rows) {
  const cells = plan.groups.flatMap(group => group.tasks.flatMap(task => ['docs0', 'default'].map(side => {
    const runs = rows.filter(row => row.group === group.id && row.task === task && row.side === side);
    const values = runs.filter(r => r.passed).map(r => r.seconds).sort((a, b) => a - b), passes = values.length;
    return { group: group.id, task, side, runs: runs.length, passes,
      medianSeconds: passes ? values[Math.floor((passes - 1) / 2)] : null,
      rangeSeconds: passes ? [values[0], values.at(-1)] : null,
      expectedSeconds: passes ? runs.reduce((sum, r) => sum + r.seconds, 0) / passes : null };
  })));
  return { schema: 1, build: plan.build, pins: plan.pins, engine: plan.engine, model: plan.model, effort: plan.effort,
    complete: cells.every(cell => cell.runs === 3), passes: rows.filter(r => r.passed).length,
    tasks: rows.length, cells, rows };
}

export async function runWorkflow(plan, { ownerAway = false, runtime = {} } = {}) {
  const rt = { now: () => new Date(), verifyPins: verifySources,
    readEngine: () => readEngine({ env: workflowEnvironment('default') }), gate: productionGate,
    run: child, collect: collectWorkflow, ...runtime };
  if (!(rt.now().getTime() >= Date.parse(RESET))) throw Error(`WF3 waits for quota reset ${RESET}`);
  if (!ownerAway) throw Error('WF3 live runs require --owner-away after the owner confirms an away window');
  // Rebuild the fixed matrix so neither a saved plan nor a test seam can alter production CLI task selection.
  const expected = makeWorkflowPlan({ build: plan.build, engine: plan.engine, out: plan.out, pins: plan.pins });
  if (JSON.stringify(expected) !== JSON.stringify(plan)) throw Error('WF3 plan changed');
  const controller = new AbortController();
  const stop = () => controller.abort(Error('WF3 interrupted; preserve partial evidence'));
  const verify = () => {
    controller.signal.throwIfAborted(); rt.verifyPins(plan);
    if (rt.readEngine().version !== plan.engine) throw Error('Pinned engine changed or is unavailable');
    rt.gate(plan.out);
  };
  outputParents(plan.out); outsideGit(plan.out); verify();
  if (existsSync(plan.out)) throw Error('Output already exists; choose a fresh --out, never rewrite evidence');
  mkdirSync(dirname(plan.out), { recursive: true, mode: 0o700 });
  mkdirSync(plan.out, { mode: 0o700 });
  save(join(plan.out, 'plan.json'), plan);
  for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(event, stop);
  const rows = [];
  try {
    for (const round of plan.rounds) {
      verify();
      const stem = join(plan.out, round.id), log = `${stem}.log`;
      const invocation = roundCommand(round, ROOT, stem);
      const receipt = { ...round, build: plan.build, engine: plan.engine, pins: plan.pins,
        invocation, environment: workflowEnvironment(round.side, {}), safe: false, startedAt: rt.now().toISOString() };
      try {
        Object.assign(receipt, await rt.run(round, invocation, log, controller.signal));
        if (![0, 1].includes(receipt.code) || receipt.signal) throw Error('Runner exit or signal requires a stop');
        Object.assign(receipt, rt.collect(round, plan, log));
        if (!receipt.safe) throw Error('Unproved cleanup; preserve the production harness lock and fixture');
        rows.push(...receipt.rows.map(row => ({ ...row, group: round.group, side: round.side, round: round.n })));
        verify();
      } catch (error) { receipt.safe = false; receipt.error = error.message; throw error; }
      finally { receipt.finishedAt = rt.now().toISOString(); save(`${stem}.receipt.json`, receipt); }
    }
    const summary = workflowSummary(plan, rows);
    save(join(plan.out, 'summary.json'), summary);
    return summary;
  } catch (error) {
    save(join(plan.out, 'failure.json'), { message: error.message, completedTasks: rows.length, at: rt.now().toISOString() });
    throw error;
  } finally { for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(event, stop); }
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (options[key] !== undefined) throw Error(`Duplicate option: ${key}`);
    if (['--run', '--plan', '--owner-away'].includes(key)) options[key] = true;
    else if (['--build', '--engine', '--out'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) options[key] = args[++i];
    else throw Error(`Unknown or incomplete option: ${key}`);
  }
  if (options['--run'] && options['--plan']) throw Error('Choose --run or --plan');
  // Refuse live CLI before source reads, engine inspection, lock access or writes.
  if (options['--run'] && Date.now() < Date.parse(RESET)) throw Error(`WF3 waits for quota reset ${RESET}`);
  const plan = makeWorkflowPlan({ build: options['--build'], engine: options['--engine'], out: options['--out'] });
  if (!options['--run']) { console.log(JSON.stringify(plan, null, 2)); return 0; }
  const summary = await runWorkflow(plan, { ownerAway: options['--owner-away'] === true });
  console.log(`WF3 ${summary.passes}/${summary.tasks} passed; evidence: ${plan.out}`);
  return summary.complete && summary.passes === summary.tasks ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`WF3 stopped: ${error.message}`); process.exitCode = 1; }
}
