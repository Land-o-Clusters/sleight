#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadRecording } from './recording.mjs';
import { replayCalls, parseEnv, schedule, summarize } from './engine.mjs';
import { resultText } from './mapping.mjs';
import { requireReplayLauncher } from './launcher-contract.mjs';
import { windowReceipts, isNativeSelection } from './frames.mjs';
import { prepareReplay } from './fixtures.mjs';
import { campaignEvidence } from './checks.mjs';
import { createReplayRecorder } from './evidence.mjs';
import { engineIteration, readReplayEngine, replayEngineEnvironment } from './engine-identity.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
export function options(argv) {
  const out = { repeat: 1, 'deadline-ms': 300000 };
  const values = new Set(['task', 'arm', 'run', 'evidence', 'env', 'compare', 'old-worktree', 'new-worktree', 'repeat', 'out', 'check', 'deadline-ms']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--owner-away', '--plan', '--help'].includes(arg)) out[arg.slice(2)] = true;
    else if (arg.startsWith('--') && values.has(arg.slice(2))) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw Error(`Missing value for ${arg}`);
      if (out[arg.slice(2)] !== undefined && !['--repeat', '--deadline-ms'].includes(arg)) throw Error(`Repeated ${arg}`);
      out[arg.slice(2)] = argv[++i];
    } else if (!arg.startsWith('--') && !out.input) out.input = arg;
    else throw Error(`Unexpected argument: ${arg}`);
  }
  out.repeat = Number(out.repeat);
  out['deadline-ms'] = Number(out['deadline-ms']);
  if (!Number.isSafeInteger(out['deadline-ms']) || out['deadline-ms'] < 1 || out['deadline-ms'] > 3600000) throw Error('--deadline-ms must be 1 to 3600000');
  if (out.run !== undefined) { out.run = Number(out.run); if (!Number.isSafeInteger(out.run) || out.run < 1) throw Error('Invalid --run'); }
  if ((out['old-worktree'] !== undefined) !== (out['new-worktree'] !== undefined)) throw Error('Supply both --old-worktree and --new-worktree');
  if (out['old-worktree'] !== undefined && out.compare !== undefined) throw Error('Worktree comparison cannot combine with --compare; --env applies to both builds');
  return out;
}

const expand = value => value.replace(/^~(?=\/)/, homedir());
export function loadCheck(id) {
  if (!/^[A-Z]+\d+$/.test(id)) throw Error('Invalid check id');
  return JSON.parse(readFileSync(new URL(`./checks/${id}.json`, import.meta.url), 'utf8'));
}

export function buildIdentity(path, label) {
  let worktree, commit, trackedDirty, trackedDiffSHA256;
  try {
    worktree = realpathSync(expand(path));
    const git = args => execFileSync('/usr/bin/git', ['-C', worktree, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (realpathSync(git(['rev-parse', '--show-toplevel'])) !== worktree) throw Error('Expected worktree root');
    commit = git(['rev-parse', 'HEAD']);
    trackedDirty = Boolean(git(['status', '--porcelain', '--untracked-files=no']));
    trackedDiffSHA256 = createHash('sha256').update(git(['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv'])).digest('hex');
  } catch { throw Error(`Expected Git worktree root with a commit: ${path}`); }
  for (const file of ['plugins/sleight/lib/launch.mjs', 'bench/turbo/v3-server.mjs'])
    if (!existsSync(join(worktree, file))) throw Error(`Build missing ${file}: ${worktree}`);
  requireReplayLauncher(worktree);
  return { label, worktree, commit, trackedDirty, trackedDiffSHA256 };
}

// The safety shim belongs to the harness; both product servers belong to the selected build.
export function replayServers(servers, worktree = repo) {
  const specs = { ...(servers ?? {}), 'plugin:sleight:computer': {
    command: process.execPath, args: [join(repo, 'bench/replay/server.mjs'), '--worktree', worktree],
    env: { SLEIGHT_SURFACES: 'computer', SLEIGHT_TURBO: '0' },
  } };
  if (specs['sleight-turbo']) specs['sleight-turbo'] = { ...specs['sleight-turbo'],
    command: process.execPath, args: [join(worktree, 'bench/turbo/v3-server.mjs')] };
  return specs;
}

export async function clientsFor({ servers, policy, env, turbo, gateWindow }, switches, dir, record, worktree, { beforeLaunch, connect } = {}) {
  const { probeClient } = await import('../double-keys-client.mjs');
  connect ??= probeClient;
  const { answerElicitation, guardReason } = await import('../codex-sleight-proxy.mjs');
  const host = Object.fromEntries(['HOME', 'USER', 'PATH', 'TMPDIR', 'LANG', 'TERM'].flatMap(k => process.env[k] ? [[k, process.env[k]]] : []));
  const engineEnv = replayEngineEnvironment();
  const base = { ...host, ...env, ...switches, CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'lane-claude-')),
    SLEIGHT_HAND: '0', SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_TRACE: dir, SLEIGHT_TRACE_CODE: '1', SLEIGHT_REPLAY_ENV: JSON.stringify(switches) };
  // Arm environments can carry a reused Claude config. Only our private config reaches children.
  const specs = replayServers(servers, worktree);
  const clients = new Map(), exits = new Map();
  let declined = false;
  const close = async () => {
    const errors = [];
    let unconfirmed = false;
    for (const [name, client] of [...clients].reverse()) {
      // A nonzero exit is a run failure, but the close event still proves collection.
      try {
        await client.close();
        if (!exits.has(name)) throw Error(`Owned ${name} server exit unconfirmed`);
        const exit = exits.get(name);
        if (exit.code !== 0) errors.push(`Owned ${name} server exited (${exit.signal ?? exit.code})`);
      } catch (error) { unconfirmed = true; errors.push(error.message); }
    }
    if (errors.length) throw Object.assign(Error(errors.join('; ')), { cleanupConfirmed: !unconfirmed, cleanupUnconfirmed: unconfirmed });
  };
  try {
    const children = Object.entries(specs).map(([name, spec]) => {
      if (!['plugin:sleight:computer', 'sleight-turbo'].includes(name)) throw Error(`Unsupported server ${name}`);
      return [name, { ...spec, args: spec.args ?? [], inheritEnvironment: false, env: { ...base, ...spec.env,
        ...switches, ...engineEnv, CLAUDE_CONFIG_DIR: base.CLAUDE_CONFIG_DIR, SLEIGHT_TRACE: dir, SLEIGHT_HAND: '0', SLEIGHT_APPROVAL_PROMPT: 'client' } }];
    });
    await beforeLaunch?.(children.find(([name]) => name === 'plugin:sleight:computer')[1].env);
    for (const [name, child] of children) {
      const client = await connect(child, {
        relay: false, label: name, timeoutMs: 120000,
        record: entry => { record({ event: 'mcp', server: name, ...entry }); if (entry.event === 'engine-close') exits.set(name, entry); },
        approve: async params => {
          const answer = await answerElicitation(params, { policy, env: base });
          // No remembered grants, arbitrary form answers, URL cards or payment confirmations.
          const choices = params?.requestedSchema?.properties?.choice?.enum ?? [];
          const required = params?.requestedSchema?.required ?? [];
          const supported = params.mode !== 'url' && required.every(key => key === 'choice') &&
            (!choices.length || choices.includes('session') || choices.includes('once'));
          const accepted = supported && answer.action === 'accept';
          declined ||= !accepted;
          record({ event: 'approval', server: name, message: params.message, action: accepted ? 'accept' : 'decline' });
          return accepted ? { action: 'accept', content: choices.length ? { choice: choices.includes('session') ? 'session' : 'once' } : {} } : { action: 'decline' };
        },
      });
      clients.set(name, client);
    }
    return { close, call: async (server, name, args) => {
      const reason = await guardReason(name, args, { env: base, gateWindow: gateWindow === true, turboBrowser: turbo ? 'bbench' : undefined });
      if (reason) throw Error(`Benchmark guard: ${reason}`);
      if (!clients.has(server)) throw Error(`Recorded server unavailable: ${server}`);
      declined = false;
      const result = await clients.get(server).call(name, args);
      return declined ? { ...result, isError: true, content: [...result.content ?? [], { type: 'text', text: 'Replay approval declined; diverged.' }] } : result;
    } };
  } catch (error) { await close(); throw error; }
}

export async function liveIteration(recording, { env, dir, signal, abort, beforeCall, beforeLaunch, record, worktree = repo, prepared, comparison = 'recording' }) {
  const { withNative, withRace } = await import('./fixtures.mjs');
  prepared ??= prepareReplay(recording, join(dir, 'fixture'));
  const { mapper } = prepared;
  const drive = async config => {
    const clients = await clientsFor(config, env, dir, record, worktree, { beforeLaunch });
    let result;
    try { result = await replayCalls(recording.calls, { mapper, call: clients.call, signal, beforeCall, record, comparison }); }
    catch (error) {
      // A replay failure stays the reason; a close failure after it is added, never put in its place.
      await clients.close().catch(closeError => { error.message += `; ${closeError.message}`; Object.assign(error, { cleanupUnconfirmed: closeError.cleanupUnconfirmed }); });
      throw error;
    }
    await clients.close();
    return result;
  };
  const fixture = await (recording.kind === 'race' ? withRace : withNative)(recording,
    { dir: join(dir, 'fixture'), repo: worktree, mapper, signal, abort, beforeCall, drive, env, prepared });
  const result = fixture.replay ?? { verdict: 'diverge', reason: fixture.lifecycle.reason ?? fixture.lifecycle.cleanupError ?? 'fixture failed', calls: [], totalToolMs: 0 };
  if (!fixture.cleanupConfirmed) result.verdict = 'diverge';
  result.cleanupConfirmed = fixture.cleanupConfirmed;
  result.lifecycle = fixture.lifecycle;
  return result;
}

export function replayControl({ parent, deadlineMs, hold = () => existsSync('/tmp/sleight-hold') } = {}) {
  const controller = new AbortController();
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  const timer = deadlineMs === undefined ? undefined : setTimeout(() => controller.abort(Error(`Replay iteration deadline after ${deadlineMs} ms`)), deadlineMs);
  return { signal, abort: reason => controller.abort(reason), dispose: () => clearTimeout(timer), beforeCall: async () => {
    signal.throwIfAborted();
    if (hold()) controller.abort(Error('Live replay stopped: /tmp/sleight-hold exists'));
    signal.throwIfAborted();
  } };
}

export function comparisonRoles(variants, check, comparingBuilds) {
  if (variants.length === 1) return { candidate: 'A' };
  if (comparingBuilds) return { candidate: 'B', baseline: 'A' };
  if (!check?.switch) return { candidate: 'A', baseline: 'B' };
  const candidate = variants.find(v => v.env[check.switch] === '1')?.variant;
  const baseline = variants.find(v => v.env[check.switch] === '0')?.variant;
  if (!candidate || !baseline || candidate === baseline) throw Error(`Comparison needs ${check.switch}=1 and ${check.switch}=0`);
  return { candidate, baseline };
}

export async function main(argv = process.argv.slice(2), {
  iteration: runIteration = liveIteration, readEngine = readReplayEngine, identifyBuild = buildIdentity,
  acquireLock, permissionCheck, hold = () => existsSync('/tmp/sleight-hold'),
} = {}) {
  const opts = options(argv);
  if (opts.help) {
    console.log('node bench/replay/run.mjs TASK_FOLDER | RESULTS.json --task ID [--arm ARM --run N --evidence DIR]\n' +
      '  [--check DP1] [--plan | --owner-away] [--repeat N] [--env SLEIGHT_X=1]\n' +
      '  [--compare SLEIGHT_X=0 | --old-worktree OLD --new-worktree NEW] [--deadline-ms N] [--out DIR]');
    return;
  }
  const check = opts.check && loadCheck(opts.check);
  if (check?.comparison === 'worktrees' && opts['old-worktree'] === undefined)
    throw Error(`${check.id} requires --old-worktree OLD --new-worktree NEW; it has no feature switch`);
  const input = opts.input ?? (check && expand(check.source));
  if (!input) throw Error('A task folder, results file or --check is required');
  const recording = loadRecording(expand(input), { task: opts.task ?? check?.task, arm: opts.arm ?? check?.arm,
    run: opts.run ?? check?.run, evidence: opts.evidence });
  const env = parseEnv(opts.env ?? (check?.switch ? `${check.switch}=1` : ''));
  const comparingBuilds = opts['old-worktree'] !== undefined;
  const variants = comparingBuilds ? [
    { variant: 'A', env, build: identifyBuild(opts['old-worktree'], 'old') },
    { variant: 'B', env, build: identifyBuild(opts['new-worktree'], 'new') },
  ] : [{ variant: 'A', env }, ...(opts.compare !== undefined ? [{ variant: 'B', env: parseEnv(opts.compare) }] : [])];
  if (comparingBuilds && variants[0].build.worktree === variants[1].build.worktree) throw Error('Comparison requires distinct worktrees');
  const order = schedule(opts.repeat, variants);
  // --plan shares the exact no-launch fixture validation used by live iterations.
  const preview = prepareReplay(recording, join(tmpdir(), 'sleight-replay-plan', 'fixture'));
  const roles = comparisonRoles(variants, check, comparingBuilds);
  const comparison = comparingBuilds ? 'worktrees' : opts.compare !== undefined ? 'switches' : 'recording';
  const plan = { source: recording.transcript, transcriptSHA256: recording.transcriptSHA256, kind: recording.kind, task: recording.task, calls: recording.calls.length,
    windowFrames: recording.calls.flatMap((call, index) => isNativeSelection(call) ? windowReceipts(resultText(call.result)).filter(row => row.frame).map(row => ({ index, ...row })) : []),
    nativeFixture: preview.native && { nonce: preview.native.ctx.nonce, suite: preview.native.suite, oldDir: preview.native.oldDir },
    deadlineMs: opts['deadline-ms'], roles, schedule: order, check, model: false, comparison, mode: comparingBuilds ? 'worktrees' : 'switches', worktree: repo,
    commit: execFileSync('/usr/bin/git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    trackedDirty: Boolean(execFileSync('/usr/bin/git', ['-C', repo, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()),
    recordedCommit: recording.row?.sleightCommit ?? recording.metadata?.sleight?.commit ?? null };
  if (opts.plan) { console.log(JSON.stringify(plan, null, 2)); return plan; }
  if (!opts['owner-away']) throw Error('Live replay requires --owner-away; use --plan for offline inspection');
  const { acquireLiveLock } = await import('../live-lock.mjs');
  const { observePermission } = await import('../real-permission.mjs');
  const { assertCheck } = await import('./checks.mjs');
  const controller = replayControl({ hold }), abort = () => controller.abort(Error('Replay interrupted'));
  const { beforeCall } = controller;
  await beforeCall();
  let out = opts.out ? resolve(opts.out) : mkdtempSync(join(tmpdir(), 'sleight-replay-'));
  if (opts.out) mkdirSync(out, { mode: 0o700 });
  out = realpathSync(out);
  const unlock = await (acquireLock ?? acquireLiveLock)();
  let cleanupConfirmed = true, monitor, observing, failure;
  const runs = []; let assessment;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, abort);
  try {
    writeFileSync(join(out, 'plan.json'), JSON.stringify(plan, null, 2), { mode: 0o600 });
    const observe = async () => {
      if (hold()) abort();
      try { if (await (permissionCheck ?? observePermission)()) controller.abort(Error('macOS permission prompt; replay stopped')); }
      catch (error) { controller.abort(error); }
    };
    await observe(); controller.signal.throwIfAborted();
    monitor = setInterval(() => { if (!observing) observing = observe().finally(() => { observing = undefined; }); }, 2000);
    for (const step of order) {
      await beforeCall();
      const dir = join(out, `${runs.length + 1}-${step.variant}`); mkdirSync(dir, { mode: 0o700 });
      const record = createReplayRecorder(dir);
      if (step.build) {
        const current = identifyBuild(step.build.worktree, step.build.label);
        if (current.commit !== step.build.commit || current.trackedDirty !== step.build.trackedDirty || current.trackedDiffSHA256 !== step.build.trackedDiffSHA256)
          throw Error(`Build identity changed: ${step.build.label}`);
      }
      const prepared = prepareReplay(recording, join(dir, 'fixture'));
      const iteration = replayControl({ parent: controller.signal, deadlineMs: opts['deadline-ms'], hold });
      // From setup until cleanup proves otherwise, the lock belongs to this iteration.
      cleanupConfirmed = false;
      let result;
      try {
        result = await engineIteration(beforeLaunch => runIteration(recording, { env: step.env, dir, signal: iteration.signal, abort: iteration.abort,
          beforeCall: iteration.beforeCall, beforeLaunch, record, worktree: step.build?.worktree, prepared, comparison }), {
          deferred: true, previous: runs.map(run => run.engine), read: env => readEngine({ env, worktree: step.build?.worktree ?? repo }),
        });
      } catch (error) {
        // A server-close error can attest server collection alone, not fixture teardown.
        result = { verdict: 'diverge', reason: error.message, calls: [], totalToolMs: 0, cleanupConfirmed: false, engine: error.engine };
        failure = error.message;
      } finally { iteration.dispose(); }
      cleanupConfirmed = result.cleanupConfirmed;
      if (check) result.check = assertCheck(check, { ...result, env: step.env }, dir);
      const row = { ...step, ...result }; runs.push(row);
      writeFileSync(join(dir, 'result.json'), JSON.stringify(row, null, 2), { mode: 0o600 });
      console.log(`${step.variant} #${step.iteration}: ${row.verdict}, ${row.calls.length}/${recording.calls.length} calls, ${row.totalToolMs.toFixed(1)} tool ms${row.reason ? ` (${row.reason})` : ''}`);
      if (row.check) console.log(`${check.id}: ${row.check.verdict}${row.check.reason ? ` (${row.check.reason})` : ''}${row.check.failures ? ` (${row.check.failures.join('; ')})` : ''}`);
      if (!cleanupConfirmed || row.engine?.reason || failure) break;
    }
  } catch (error) {
    failure = error.message;
    throw error;
  } finally {
    clearInterval(monitor); await observing;
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(sig, abort);
    const summary = summarize(runs);
    assessment = campaignEvidence(runs, check, roles);
    if (failure || !cleanupConfirmed || runs.length !== order.length) assessment.verdict = 'diverge';
    writeFileSync(join(out, 'summary.json'), JSON.stringify({ runs, summary, cleanupConfirmed, failure, ...assessment }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(summary, null, 2)); console.log(`Campaign: ${assessment.verdict}`); console.log(`Evidence: ${out}`);
    if (cleanupConfirmed) await unlock();
    else console.error('Cleanup unproved. Retained /tmp/sleight-live.lock and fixture evidence.');
  }
  if (assessment.verdict !== 'pass') process.exitCode = 1;
  return runs;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); } catch (error) { console.error(`Replay stopped: ${error.message}`); process.exitCode = 1; }
}
