// Only check4.mjs's explicit owner-away path imports this adapter. No module-level effects.
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireLiveLock } from '../live-lock.mjs';
import { waitForBenchmark } from '../hold.mjs';
import { idleSeconds } from '../compat/live.mjs';
import { observePermission } from '../real-permission.mjs';
import { loadRecording } from '../replay/recording.mjs';
import { buildIdentity, liveIteration, replayControl } from '../replay/run.mjs';
import { engineIteration, readReplayEngine } from '../replay/engine-identity.mjs';
import { createReplayRecorder } from '../replay/evidence.mjs';
import { buildCheck4, prepareMabel, HOST } from './check4-build.mjs';
import { allowedCheck4Replay, prepareCheck4Replay, recordedCoverage } from './check4-fixtures.mjs';
import { runTasks, check4RunVerdict, check4CostOptions } from './check4.mjs';
import { taskResult } from './check4-measurement.mjs';
import { stageRunGuard, jsonChild, runLiveStage, holdStageAwake } from './stage-live.mjs';
import { stageVerdict, reportMarkdown as costMarkdown } from './stage-cost.mjs';
import { auditStageTrace } from '../../tests/fixtures/stage-stateful-fuzz.mjs';
import { runModelBench } from './check4-model.mjs';
import { fixtureArea, withFixtureArea, areaRefusalCollected } from './check4-area.mjs';
const repo = fileURLToPath(new URL('../..', import.meta.url));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const held = () => existsSync('/tmp/sleight-hold');
// The full check uses a plain nice-0 Node launcher for ST9. Its task children retain the lane's nice-20 policy.
export const check4TaskSpawner = spawnChild => (command, args, options) =>
  spawnChild('/usr/bin/nice', ['-n', '20', command, ...args], options);
export function writeJSON(path, value) {
  const temp = path + '.partial'; writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(temp, path);
}
export function assertIdle(value) {
  if (!Number.isFinite(value) || value < 30) throw Error(`Check 4 owner-return guard: HID idle ${Number.isFinite(value) ? value.toFixed(1) : 'unknown'} s; needs 30 s`);
}
export async function recordingPreflight(execute) {
  try { await execute('/usr/bin/pgrep', ['-x', 'Calculator'], { timeout: 10000, killSignal: 'SIGKILL' }); }
  catch (error) { if (error.code === 1) return { calculatorClosed: true }; throw error; }
  throw Error('Check 4 recording requires Calculator to be closed');
}
// The ChatGPT engine's input and the benchmark's end-of-run mouse-up reset HID idle like a person does (2026-11-04:
// check 4 stopped itself 7 s into its first task). So the owner-return guard runs at task boundaries only, and waits
// for idle to climb back past 30 s: one posted event resets it once, while a person keeps resetting it.
export async function settleIdle({ read, wait = ms => new Promise(r => setTimeout(r, ms)), signal, limitMs = 120000, now = Date.now } = {}) {
  const began = now();
  for (;;) {
    signal?.throwIfAborted();
    const value = await read();
    if (Number.isFinite(value) && value >= 30) return { waitedMs: now() - began };
    if (now() - began >= limitMs) assertIdle(value);
    await wait(1000);
  }
}
export const hostCollectionConfirmed = (fixtureCleanup, serverStarted, receipt) =>
  fixtureCleanup === true && (!serverStarted || receipt?.collected === true);
export function bankTasks(bank, plan, load = loadRecording) {
  if (bank.schema !== 'sleight.character-check4-recordings/1' || !bank.tasks || typeof bank.tasks !== 'object') throw Error('Invalid check 4 recordings bank');
  return plan.tasks.map(task => {
    let source = bank.tasks[task.id], recording, coverage, note;
    try {
      if (!source) throw Error(`No recording for ${task.id}`);
      recording = load(source.input, source);
      if (recording.kind !== 'native' || recording.task.id !== task.id) throw Error('Recording task does not match bank slot');
      coverage = recordedCoverage(recording);
      if (task.id === 'finder-move' && !coverage.crossWindowDrag) throw Error('Finder recording has no cross-window drag');
      if (task.id === 'preview-read' && coverage.scrollIndex < 0) {
        note = 'preview-read recording has no scroll';
        source = bank.scrollFallback;
        if (!source) throw Error(`${note}; explicit scrollFallback recording required`);
        recording = load(source.input, source); coverage = recordedCoverage(recording);
        if (recording.kind !== 'native' || !allowedCheck4Replay(recording.task.id) || coverage.scrollIndex < 0)
          throw Error('Scroll fallback must be an allowed native fixture task and contain a scroll');
        note += `; replaying ${recording.task.id} for the scroll task`;
      }
      // Call count cannot establish elapsed driving time. The live trace supplies the first-fifth check.
      return { ...task, source, recording, coverage, note };
    } catch (error) { return { ...task, unavailable: error.message, note }; }
  });
}
export function check4Markdown(state) {
  const lines = ['# Character live check 4', '', `Verdict: ${state.verdict ?? 'incomplete'}.`, '',
    ...(state.plan?.smoke || state.plan?.singleTask ? [`Scope: ${state.plan.smoke ? 'smoke' : 'single task'}. Costs: not run.`, ''] : []),
    ...(state.plan?.continuationFrom ? [`Scope: continuation from ${state.plan.continuationFrom}, ${state.plan.tasks.length} tasks. Costs: not run.`, ''] : []),
    ...(state.plan?.costsDeferred && !state.plan?.smoke && !state.plan?.singleTask && !state.plan?.continuationFrom ? ['Scope: all tasks. Costs: not run.', ''] : []),
    '| Task | Benchmark pass | Measured | Stage family | Stage family to benchmark exit | Driving end source | Full stage | Any rung | First frame ms | First stage-family frame ms | Early-scroll action ordinal | First-scroll time fraction | Fixture frames and free space | Independent art contacts | Rung time ms | Sampler intersections | Trace intersections | Bounds difference pt | Re-seated | Verdict |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const [id, row] of Object.entries(state.tasks)) lines.push(`| ${id} | ${row.benchmarkPassed ?? 'replay'} | ${row.measured === true} | ${row.visibleShare === null || row.visibleShare === undefined ? 'unmeasured' : (row.visibleShare * 100).toFixed(2) + '%'} | ${row.exitDriving?.visibleShare == null ? 'unmeasured' : (row.exitDriving.visibleShare * 100).toFixed(2) + '%'} | ${row.driving?.endSource ?? 'unmeasured'} | ${row.fullStageShare == null ? 'unmeasured' : (row.fullStageShare * 100).toFixed(2) + '%'} | ${row.visibleAnyRung == null ? 'unmeasured' : (row.visibleAnyRung * 100).toFixed(2) + '%'} | ${row.timeToFirstFrameMs ?? 'unmeasured'} | ${row.timeToFirstStageFamilyFrameMs ?? 'unmeasured'} | ${row.earlyScrollWitness?.ordinal == null ? 'unmeasured' : row.earlyScrollWitness.ordinal + ' (' + (row.earlyScrollWitness.withinFirstTwoActions ? 'within first two' : 'after first two') + ')'} | ${row.firstScrollFractionOfDrivingTime ?? 'unmeasured'} | ${JSON.stringify(row.fixtureFrames ?? [])} | ${row.judgedIndependentArtIntersections ?? row.independentArtIntersections ?? 'unmeasured'} | ${JSON.stringify(row.timeByRungMs ?? {})} | ${row.samplerIntersections ?? 'unmeasured'} | ${row.auditStageTrace?.intersections ?? 'unmeasured'} | ${row.maxWindowBoundsDifferencePt ?? 'unmeasured'} | ${row.turnEndedReseated ?? false} | ${row.verdict ?? 'incomplete'} |`);
  for (const [id, row] of Object.entries(state.tasks)) {
    lines.push('', `${id}: ${[row.note, row.reason].filter(Boolean).join('. ') || 'completed'}. Hide transitions: ${JSON.stringify(row.hideReasonCounts ?? {})}.`,
      `Current driving: ${JSON.stringify(row.driving ?? null)}. Benchmark-exit driving: ${JSON.stringify(row.exitDriving ?? null)}. Early-scroll witness: ${JSON.stringify(row.earlyScrollWitness ?? null)}.`,
      `Samples: ${row.samples ?? 0}. Gaps over 100 ms: ${row.gaps?.length ?? 0}. Visible milliseconds at requested ${row.requestedSize ?? 'stage'} size: ${row.visibleMs ?? 'unmeasured'} of ${row.durationMs ?? 'unmeasured'}. Renderer time ms: ${JSON.stringify(row.timeByRendererMs ?? {})}.`);
  }
  if (state.costs?.result) lines.push('', costMarkdown(state.costs.result));
  if (state.failure) lines.push('', `Stopped: ${state.failure}`);
  return lines.join('\n') + '\n';
}
async function attemptTask(task, number, context) {
  if (task.unavailable) return { measured: false, fixtureFailure: true, cleanupConfirmed: true, visibleShare: null, verdict: 'unmeasured', reason: task.unavailable };
  const { out, work, binaries, mabel, guard, controller, previousEngines } = context;
  const dir = mkdtempSync(join(out, `${task.id}-${number}-`)), status = join(dir, 'host-status.json'), tracePath = join(dir, 'host-trace.json'), pidsPath = join(dir, 'task-pids.json');
  const pids = new Set(); writeJSON(pidsPath, { pids: [] });
  const addPid = pid => { if (Number.isSafeInteger(pid)) { pids.add(pid); writeJSON(pidsPath, { pids: [...pids] }); } };
  const config = join(dir, 'server.json');
  const collectionPath = join(dir, 'host-collection.json');
  writeJSON(config, { worktree: repo, binary: binaries.host, character: mabel.folder, status, trace: tracePath, collection: collectionPath });
  let prepared;
  try {
    prepared = prepareCheck4Replay(task.recording, join(dir, 'fixture'), task.source.fixture, { onPid: addPid });
    // Ordinary TextEdit replay also reports all fixture PIDs after its unchanged setup.
    const setup = prepared.native.definition.setup;
    prepared.native.definition = { ...prepared.native.definition, setup: async ctx => {
      await setup(ctx);
      for (const value of Object.values(ctx)) if (value && typeof value === 'object') addPid(value.pid);
    } };
  } catch (error) { return { measured: false, fixtureFailure: true, cleanupConfirmed: true, visibleShare: null, verdict: 'unmeasured', reason: error.message, dir }; }
  const sampler = jsonChild(binaries.sampler, ['--status', status, '--pids', pidsPath], {}, { spawnChild: (...args) => guard.spawn(...args) });
  sampler.child.stdout.on('data', chunk => appendFileSync(join(dir, 'sampler.jsonl'), chunk, { mode: 0o600 }));
  const iteration = replayControl({ parent: controller.signal, deadlineMs: 300000, hold: held });
  const record = createReplayRecorder(dir);
  let start, end, reseated = false, trace, result, collected = false, serverStarted = false;
  const mark = async label => {
    const from = sampler.rows.length; sampler.write(JSON.stringify({ mark: label }) + '\n');
    return (await sampler.wait(r => r.mark === label, 5000, from)).t;
  };
  try {
    const { probeClient } = await import('../double-keys-client.mjs');
    result = await engineIteration(beforeLaunch => liveIteration(task.recording, { env: {}, dir, prepared,
      signal: iteration.signal, abort: iteration.abort, beforeCall: iteration.beforeCall, beforeLaunch, record,
      clientOptions: { connect: (spec, options) => { serverStarted = true; return probeClient({ ...spec,
        args: [join(repo, 'bench/hand/check4-server.mjs'), config], env: { ...spec.env, SLEIGHT_HAND: '1', SLEIGHT_RUNTIME: 'engine' },
      }, { ...options, signal: iteration.signal }); } },
      beforeDrive: async () => { await sampler.wait(r => Number.isFinite(r.t), 5000); start = await mark('driving-start'); },
      afterDrive: async (clients, replay) => {
        end = await mark('driving-end');
        if (replay.verdict === 'pass') {
          const terminal = await clients.call('plugin:sleight:computer', 'turn_ended', {});
          if (terminal?.isError) return;
          // Real terminal dispatch followed by the normal host poll, without injecting an art frame.
          const until = Date.now() + 10000;
          while (Date.now() < until) {
            iteration.signal.throwIfAborted(); await sleep(50);
            const row = sampler.rows.findLast(r => r.valid);
            if (row?.t > end && row.panel.onScreen && row.status?.size === 'stage' && row.status?.turnTargets <= 1 &&
                ['handback', 'done'].includes(row.status.eventState)) { reseated = true; break; }
          }
          await sleep(300); // Observe the final periodic trace publication before closing the owning server.
        }
        if (existsSync(tracePath)) trace = json(tracePath);
      },
    }), { deferred: true, previous: previousEngines, read: env => readReplayEngine({ env, worktree: repo }) });
    collected = hostCollectionConfirmed(result.cleanupConfirmed, serverStarted, existsSync(collectionPath) ? json(collectionPath) : null);
    if (result.engine) previousEngines.push(result.engine);
  } catch (error) {
    result = { verdict: 'diverge', reason: error.message, cleanupConfirmed: false, engine: error.engine };
  } finally {
    iteration.dispose();
    const exit = await sampler.close();
    if (exit.code !== 0) { collected = false; result.reason = `Sampler collection failed: ${exit.signal ?? exit.code}`; }
  }
  const rows = sampler.rows.filter(r => r.source === 'CGWindowListCopyWindowInfo');
  let audit;
  if (trace?.complete === true) {
    try { audit = { ...auditStageTrace(trace), complete: true }; } catch (error) { audit = { complete: false, reason: error.message }; }
  }
  const measured = taskResult({ taskId: task.id, replay: { ...result, cleanupConfirmed: collected }, rows, start, end, audit, reseated });
  const firstScroll = trace?.records?.find(r => r.input?.event?.state === 'scroll')?.input.now;
  const scrollFraction = Number.isFinite(firstScroll) && end > start ? (firstScroll * 1000 - start) / (end - start) : null;
  const answer = { ...measured, dir, note: task.note, engine: result.engine, coverage: task.coverage,
    actualTask: task.recording.task.id, firstScrollFractionOfDrivingTime: scrollFraction, stopped: controller.signal.aborted || Boolean(result.engine?.reason),
    recordingSHA256: task.recording.transcriptSHA256 };
  if (!answer.characterNeverShown && task.id === 'preview-read' && !(scrollFraction >= 0 && scrollFraction <= 0.2)) {
    answer.measured = false; answer.visibleShare = null; answer.verdict = 'unmeasured'; answer.reason = 'No real scroll frame in first fifth of driving time';
  }
  writeJSON(join(dir, 'result.json'), answer); return answer;
}
export async function runCheck4(opts, plan) {
  if (!opts.ownerAway || process.platform !== 'darwin') throw Error('Live check 4 needs macOS and --owner-away');
  const model = plan.drive === 'model';
  const bankBytes = model ? null : readFileSync(opts.recordings), tasks = model ? plan.tasks : bankTasks(JSON.parse(bankBytes), plan);
  const sourceHash = hash(readFileSync(HOST)), identity = { build: buildIdentity(repo, 'check4'), sourceHash,
    ...(plan.continuationFrom ? { continuationFrom: plan.continuationFrom } : {}),
    ...(plan.recordWindowFrames ? { recordWindowFrames: true } : {}),
    smoke: plan.smoke, singleTask: plan.singleTask, ...(plan.costsDeferred ? { costsDeferred: true } : {}),
    ...(model ? { drive: 'model', commands: tasks.map(t => t.benchCommand) } : {
      recordingsSHA256: hash(bankBytes), transcripts: tasks.map(t => [t.id, t.recording?.transcriptSHA256 ?? t.unavailable]) }) };
  const out = resolve(opts.out);
  let state;
  if (opts.resume) {
    const stat = lstatSync(out); if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(out) !== out) throw Error('Invalid resume bank');
    state = json(join(out, 'check4.json'));
    if (JSON.stringify(state.identity) !== JSON.stringify(identity)) throw Error('Resume source or recording bank identity changed');
    if (state.cleanupConfirmed !== true) throw Error('Previous cleanup unproved; retain its lock and resolve ownership before resuming');
  } else {
    mkdirSync(out, { mode: 0o700 });
    state = { schema: plan.schema, identity, plan, tasks: {}, waits: [], cleanupConfirmed: true };
  }
  delete state.failure;
  const controller = new AbortController(), guard = stageRunGuard({ timeoutMs: 180 * 60 * 1000 });
  const taskSpawn = check4TaskSpawner((...args) => guard.spawn(...args));
  guard.signal.addEventListener('abort', () => controller.abort(guard.signal.reason), { once: true });
  const abort = error => { controller.abort(error); guard.abort(error); };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const interrupt = () => abort(Error('Check 4 interrupted'));
  for (const signal of signals) process.on(signal, interrupt);
  let unlock, monitor, watching, active = false, canUnlock = true;
  const checkpoint = async () => { writeJSON(join(out, 'check4.json'), state); writeFileSync(join(out, 'check4.md'), check4Markdown(state), { mode: 0o600 }); };
  const boundary = async () => {
    controller.signal.throwIfAborted();
    const began = Date.now();
    if (await waitForBenchmark({ signal: controller.signal, interval: 60000 })) state.waits.push({ kind: 'hold', began, ended: Date.now() });
    const idleBegan = Date.now(), settled = await settleIdle({ read: idleSeconds, signal: controller.signal });
    if (settled.waitedMs > 1000) state.waits.push({ kind: 'idle', began: idleBegan, ended: Date.now() });
    controller.signal.throwIfAborted();
  };
  const observe = async () => {
    try { if (active && held()) throw Error('Check 4 quiet window ended');
      if (await observePermission()) throw Error('macOS permission prompt; check 4 stopped'); }
    catch (error) { abort(error); }
  };
  try {
    await boundary();
    const lockStart = Date.now();
    unlock = await acquireLiveLock('/tmp/sleight-live.lock', { wait: true, interval: 60000, signal: controller.signal });
    if (Date.now() - lockStart > 1000) state.waits.push({ kind: 'live-lock', began: lockStart, ended: Date.now() });
    await boundary();
    if (plan.recordWindowFrames) state.recordingPreflight = await recordingPreflight(guard.execute);
    monitor = setInterval(() => { if (!watching) watching = observe().finally(() => { watching = undefined; }); }, 500);
    const awake = holdStageAwake({ spawnChild: (...args) => guard.spawn(...args),
      onUnexpectedExit: () => abort(Error('Check 4 sleep assertion exited')) });
    guard.onClose(() => awake.close()); await awake.ready;
    const work = realpathSync(mkdtempSync(join(out, 'work-')));
    const binaries = await buildCheck4(work, guard.execute), mabel = await prepareMabel(work);
    state.character = mabel.identity;
    await checkpoint();
    const previousEngines = Object.values(state.tasks).flatMap(t => t.attempts ?? []).map(a => a.engine).filter(Boolean);
    await runTasks(tasks, state, { boundary, checkpoint, attempt: async (task, number) => {
      active = true; canUnlock = false; state.cleanupConfirmed = false; await checkpoint();
      const areaRecords = [];
      let result, taskStarted = false;
      try { result = await withFixtureArea(() => fixtureArea(binaries.area, { spawnChild: taskSpawn,
        record: row => { areaRecords.push(row); writeJSON(join(out, `area-${task.id}-${number}.json`), areaRecords); } }), async () => {
      taskStarted = true;
      let result;
      if (model) {
        const dir = realpathSync(mkdtempSync(join(out, `${task.id}-${number}-`)));
        const { dev, ino } = statSync('/tmp/sleight-live.lock');
        result = await runModelBench(task, { dir, repo, smoke: plan.smoke, config: { binary: binaries.host, character: mabel.folder,
          ...(plan.recordWindowFrames ? { recordWindowFrames: true } : {}),
          lock: { dev, ino, ownerPid: process.pid } }, signal: controller.signal, spawnChild: taskSpawn,
          startSampler: async config => {
            const sampler = jsonChild(binaries.sampler, ['--status', config.status, '--pids', config.pids], {}, { spawnChild: taskSpawn });
            sampler.child.stdout.on('data', chunk => appendFileSync(join(dir, 'sampler.jsonl'), chunk, { mode: 0o600 }));
            await sampler.wait(r => Number.isFinite(r.t) && Number.isFinite(r.epochMs), 5000);
            return sampler;
          } });
        writeJSON(join(dir, 'result.json'), result);
      } else result = await attemptTask(task, number, { out, work, binaries, mabel, guard, controller, previousEngines });
      return result;
      }); } catch (error) {
        // A collected area refusal before any task owns no fixture or server. Its restoration receipt closes cleanup.
        if (areaRefusalCollected(taskStarted, areaRecords)) canUnlock = true;
        throw error;
      }
      result.fixtureArea = areaRecords;
      active = false; canUnlock = result.cleanupConfirmed; state.cleanupConfirmed = canUnlock;
      return result;
    } });
    if (plan.costs && !state.costs?.complete) {
      await boundary(); active = true; canUnlock = false; state.cleanupConfirmed = false; await checkpoint();
      // Exactly the existing phases and judge. The outer run retains the one live lock through both adapters.
      try {
        const evidence = await runLiveStage(check4CostOptions(opts, { character: mabel.folder, out }),
          { acquireLock: async () => async () => {}, signal: controller.signal });
        const result = stageVerdict(evidence);
        state.costs = { complete: true, result }; writeJSON(join(out, 'stage-cost.json'), evidence);
      } catch (error) {
        const partial = join(out, 'costs', 'stage-cost.partial.json');
        if (existsSync(partial)) state.costs = { complete: false, result: stageVerdict(json(partial)), failure: error.message };
        throw error;
      }
      active = false; canUnlock = true; state.cleanupConfirmed = true;
    }
    state.verdict = check4RunVerdict(state);
  } catch (error) { state.failure = error.message; state.verdict = 'stopped'; throw error; }
  finally {
    clearInterval(monitor); await watching;
    for (const signal of signals) process.removeListener(signal, interrupt);
    try { await guard.close(); } catch (error) { canUnlock = false; state.failure = error.message; }
    state.cleanupConfirmed = canUnlock;
    await checkpoint();
    if (unlock && canUnlock) await unlock();
    else if (unlock) console.error('Cleanup unproved. Retained /tmp/sleight-live.lock and check 4 evidence.');
  }
  console.log(check4Markdown(state)); return state;
}
