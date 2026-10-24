import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTasks } from '../../../tasks.mjs';
import { armPaths, composerPlan, CURSOR_PIN, guardLive, DESKTOP_BLOCKERS } from './contract.mjs';
import { inspectBundle, readLoginReadiness, setupPlan } from './setup.mjs';
import { runDesktop } from './run.mjs';
import { DesktopDriver } from './desktop.mjs';
import { scrubCursor } from './scrub.mjs';

export function parseOptions(argv) {
  const args = {};
  const flags = ['dry-run', 'owner-away', 'allow-benchmark-app-prompts', 'no-allow-benchmark-app-prompts', 'no-hub', 'world'];
  const values = ['suite', 'arm', 'tasks', 'runs', 'out', 'surface', 'real-browser', 'real-profile', 'only', 'model', 'effort'];
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].slice(2);
    if (!argv[i].startsWith('--')) throw Error('invalid Cursor option');
    if (Object.hasOwn(args, key)) throw Error(`duplicate Cursor option: ${key}`);
    if (flags.includes(key)) args[key] = true;
    else if (values.includes(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) args[key] = argv[++i];
    else throw Error(`unknown or incomplete Cursor option: ${argv[i]}`);
  }
  if (args.model && args.model !== 'Grok 4.7 High') throw Error('Cursor desktop requires Grok 4.7 High');
  if (args.effort && args.effort !== 'high') throw Error('Cursor desktop requires high effort');
  return args;
}

export function nativePlan(args = {}) {
  if (args.arm && args.arm !== 'cursor-cu') throw Error('Cursor desktop native qualification runs one arm at a time');
  if (args.suite && args.suite !== 'world') throw Error('Cursor desktop uses --suite world');
  const requested = args.tasks?.split(','), all = getTasks('world');
  const tasks = all.filter(t => requested ? requested.includes(t.id) : ['native', 'cross-app'].includes(t.half) && !t.ownerPresent && !t.heldOut && !t.optional && !['slack-post', 'spotify-play'].includes(t.id));
  if (!tasks.length || requested?.some(id => !tasks.some(t => t.id === id))) throw Error('unknown Cursor world task');
  if (tasks.some(t => t.half === 'browser' || t.ownerPresent || ['slack-post', 'spotify-play'].includes(t.id))) throw Error('Cursor native qualification excludes browser and owner-account tasks');
  const count = Number(args.runs ?? 3);
  if (!Number.isSafeInteger(count) || count < 1 || count > 5) throw Error('Cursor runs must be 1..5');
  return { arm: 'cursor-cu', suite: 'world', route: 'desktop', liveReady: false, blockers: DESKTOP_BLOCKERS, dryRun: !!args['dry-run'], pin: CURSOR_PIN,
    out: resolve(args.out ?? join(homedir(), 'Library/Caches/sleight-bench/cursor-cu-arm/results', `native-${randomUUID()}.json`)),
    ownerAway: !!args['owner-away'], setup: setupPlan(),
    composer: composerPlan({ prompt: '<shared world fixture prompt>', allowBenchmarkAppPrompts: !args['no-allow-benchmark-app-prompts'] }),
    runs: Array.from({ length: count }, (_, i) => tasks.map(task => ({ task: task.id, run: i + 1, check: 'shared world task.check',
      allowedApps: task.allowedApps, timeoutMs: task.timeoutMs }))).flat(),
    timingBoundary: 'harness submit to persisted clientSettleTime; setup, checks and cleanup excluded',
    qualificationOnly: true, claimBlocker: 'supervised calibration and owner go' };
}

export async function runCursorPlan(plan, { signal, ...options } = {}) {
  return runDesktop(plan, { driver: new DesktopDriver(), signal, ...options });
}

export async function nativeMain(argv, runtime = {}) {
  const args = parseOptions(argv), plan = nativePlan(args);
  if (args['dry-run']) { (runtime.print ?? console.log)(JSON.stringify(plan, null, 2)); return plan; }
  (runtime.guard ?? guardLive)({ ownerAway: plan.ownerAway });
  await (runtime.preflight ?? (p => new DesktopDriver().preflight(p)))({ paths: armPaths() });
  (runtime.inspect ?? inspectBundle)(armPaths().app);
  const readiness = await (runtime.readiness ?? readLoginReadiness)();
  if (!readiness.authStored) throw Error('Cursor desktop isolated login missing; run node bench/world/arms/cursor-cu/setup.mjs');
  if (existsSync(plan.out)) throw Error('Cursor result output already exists');
  const { acquireLiveLock } = await import('../../../live-lock.mjs');
  const { executeRealTask } = await import('../../../real-run.mjs');
  const { observePermission } = await import('../../../real-permission.mjs');
  const release = await (runtime.lock ?? acquireLiveLock)();
  const controller = new AbortController(), abort = () => controller.abort();
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, abort);
  const results = []; let clean = true;
  try {
    const all = getTasks('world');
    for (const row of plan.runs) {
      if ((runtime.held ?? (() => existsSync('/tmp/sleight-hold')))()) throw Error('sleight-hold appeared');
      const task = all.find(t => t.id === row.task);
      const ctx = { dir: join(armPaths().workspace, `fixture-${randomUUID()}`), nonce: randomUUID().slice(0, 8), ownerAway: true, stopOnAppDialog: true };
      const result = await (runtime.execute ?? executeRealTask)(task, ctx, { signal: controller.signal, lockHeld: true,
        permissionCheck: observePermission, stop: abort,
        drive: async prompt => {
          const p = composerPlan({ prompt, allowedApps: row.allowedApps, timeoutMs: row.timeoutMs,
            allowBenchmarkAppPrompts: !args['no-allow-benchmark-app-prompts'] });
          const out = await (runtime.run ?? runCursorPlan)(p, { signal: controller.signal });
          return { code: out.is_error ? 1 : 0, out, agentSeconds: out.agentSeconds, agentTiming: out.agentTiming, groupClean: out.groupClean, reason: out.reason, safetyStop: out.safetyStop,
            ...(/approval stop/.test(out.reason ?? '') && { approvalStop: out.reason }) };
        } });
      const inner = result.out?.duration_ms != null;
      // The task check graded Cursor's raw answer inside executeRealTask. The saved row keeps a scrubbed copy.
      const saved = result.out ? { ...result.out, result: scrubCursor(result.out.result ?? '') } : result.out;
      results.push({ ...row, ...result, out: saved, arm: 'cursor-cu', outerSeconds: result.seconds, seconds: inner ? result.out.duration_ms / 1000 : result.seconds,
        secondsTiming: inner ? { start: 'submit', end: 'persisted-clientSettleTime', startupIncluded: false }
          : { start: 'outer-drive', end: 'task-check', startupIncluded: true },
        timingBoundary: inner ? plan.timingBoundary : 'outer drive through task check, including startup', qualificationOnly: true });
      if (result.groupClean === false || result.cleanupUnconfirmed || ctx.fixtureLockUnconfirmed || result.liveLockKept) clean = false;
      mkdirSync(resolve(plan.out, '..'), { recursive: true, mode: 0o700 });
      writeFileSync(plan.out, JSON.stringify({ ...plan, results, groupClean: clean }, null, 2), { mode: 0o600 });
      if (!clean || controller.signal.aborted || result.approvalStop || result.safetyStop) break;
    }
  } finally {
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(s, abort);
    if (clean) await release();
    else console.error('Cursor cleanup unverified; live lock retained');
  }
  const failed = results.length !== plan.runs.length || results.some(r => !r.passed);
  if (failed) process.exitCode = 1;
  return { results, failed, groupClean: clean };
}

export async function chromeMain(argv, runtime = {}) {
  const args = parseOptions(argv);
  if (args.surface !== 'cursor-cu' || args['real-browser'] !== 'chrome') throw Error('Cursor race requires --surface cursor-cu --real-browser chrome');
  if (!args['dry-run']) { guardLive({ ownerAway: args['owner-away'] }); await new DesktopDriver().preflight({ paths: armPaths() }); }
  const { runRealGate } = await import('../../../fowl/real-gate.mjs');
  // The task definitions live in the repository, so dry plans work before a Fowl clone exists.
  const tasks = JSON.parse(readFileSync(new URL('../../tasks/fowlbrowser.json', import.meta.url), 'utf8'));
  const result = await (runtime.run ?? runRealGate)({ args, tasks, mcpRoot: join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser'),
    ...(args['dry-run'] && { runtime: {
      readEngine: () => ({ used: false, reason: 'Cursor desktop uses its own computer-use helper' }),
      readVersion: () => null, preflight: () => ['live admission requires calibration and no foreign Cursor'],
    } }) });
  return { result, failed: !!process.exitCode };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, ...argv] = process.argv.slice(2);
    if (mode === '--chrome') await chromeMain(argv);
    else if (mode === '--native') await nativeMain(argv);
    else throw Error('choose --native or --chrome');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
