#!/usr/bin/env node
// Engine compatibility on this Mac: did a ChatGPT update break sleight? The static half (bench/compat-static.mjs) reads
// a release's files anywhere; this half runs the installed engine.
//
//   npm run compat                       engine checks only: no app, no window, about 20 s
//   npm run compat -- --owner-away       also the live checks: Calculator and a Safari page, about 2 min
//   node bench/compat.mjs --launch-shape  read launch config and file metadata, run only the runtime's --help
//   node bench/compat.mjs --watch        what scripts/watch.sh runs daily: acts only when the engine version changes
//   node bench/compat.mjs --publish [--static-log FILE]...   merge the logs into docs/results/engine-compat.md
//
// Engine checks: doctor; the raw engine's tools/list, API docs, confirmations policy and a REPL probe of cua's methods
// and the shapes of getState and listApps; sleight's launcher starting and listing its tools; the raw docs diffed against
// the last version that passed. Live checks open windows, so they need --owner-away, wait out /tmp/sleight-hold, take
// /tmp/sleight-live.lock without waiting, and use only a Calculator or Safari they launch. Flags: --report FILE,
// --record (append to ~/Library/Logs/sleight/compat.jsonl), --min-idle S (live checks only after S seconds without input).
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DOCS_CODE, engineDocsText } from '../scripts/engine-docs.mjs';
import { openClient, textOf } from './compat/client.mjs';
import { PROBE_CODE, checkApiContract, checkPolicyRewrite, checkWorkflowRewrite, checkReplProbe, checkToolSurface, parseProbe } from './compat/contract.mjs';
import { SAFE_VERSION, plistString } from './compat/static.mjs';
import { collectionCertain, documentationBootstrapChecks } from './compat/documentation.mjs';

const execute = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LAUNCHER = join(ROOT, 'plugins', 'sleight', 'bin', 'sleight-mcp');
export const logsDir = (home = homedir()) => join(home, 'Library', 'Logs', 'sleight');

// reason is sleight's own wording and may be published; detail can hold engine or system text and stays in the local
// report (publish copies reasons only).
const step = (id, status, reason, detail) => ({ id, status, ...(reason ? { reason } : {}), ...(detail ? { detail: scrub(detail).slice(0, 500) } : {}) });
const scrub = text => String(text ?? '').replaceAll(homedir(), '~').replaceAll(userInfo().username, '[user]');
const atomic = (path, text) => { const temp = `${path}.${process.pid}.tmp`; writeFileSync(temp, text); renameSync(temp, path); };
const readOr = (path, fallback) => { try { return readFileSync(path, 'utf8').trim(); } catch { return fallback; } };

export function verdictOf(steps) {
  if (steps.some(s => s.status === 'fail')) return 'fail';
  return steps.some(s => s.status === 'error') ? 'error' : 'pass';
}

// Help comes from the resolved Node executable, never from the configured engine args or environment.
// Keep every alias: for example --loader, --experimental-loader=... both consume a value.
function nodeOptionArities(help) {
  const options = new Map();
  const section = help.split(/^Options:[ \t]*\r?$/m)[1]?.split(/^Environment variables:/m)[0];
  if (!section) return options;
  for (const line of section.split('\n')) {
    const spec = /^ {2}(-[^\s,]+(?:, -[^\s,]+)*)(?:\s|$)/.exec(line)?.[1];
    if (!spec) continue;
    const names = [...spec.matchAll(/(?:^|, )(-{1,2}[\w-]+)/g)].map(match => match[1]);
    const takesValue = /(?<!\[)=/.test(spec) || /--print \[\.\.\.\]/.test(line);
    // This help row groups two distinct switches rather than aliases: only --experimental-config-file
    // has a value. Optional inspector/FIPS values use [=...] and do not consume the next argument.
    for (const name of names) options.set(name, name === '--experimental-default-config-file' ? false : takesValue);
  }
  return options;
}

// This check never starts the engine or reads script contents. Non-path values are placeholders so a title,
// inline program or future credential argument cannot end up in a local report.
export async function launchShapeCheck({ env = process.env, resolve: findServer, server, nodeHelp, run = execute } = {}) {
  const { engineLaunchPaths, NODE_VALUE_FLAGS, resolveServer } = await import('../plugins/sleight/lib/launch.mjs');
  const result = { id: 'launch-shape', status: 'fail' };
  const checked = reason => ({ version: server?.version, result: { ...result, reason } });
  try { server ??= (findServer ?? resolveServer)(env); }
  catch { return checked('could not resolve the installed engine'); }
  if (!server || server.error) return checked('could not resolve the installed engine');
  const args = server.args;
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || !arg)) return checked('launch args must be nonempty strings');
  const paths = engineLaunchPaths(args);
  const pathValue = value => value.startsWith('file:') || isAbsolute(value) || /^\.\.?\//.test(value);
  const valueShape = value => pathValue(value) ? value.replaceAll(homedir(), '~') : '<value>';
  result.shape = args.map(arg => {
    if (!arg.startsWith('-')) return valueShape(arg);
    const eq = arg.indexOf('=');
    return eq < 0 ? arg : `${arg.slice(0, eq)}=${valueShape(arg.slice(eq + 1))}`;
  });
  try {
    nodeHelp ??= (await run(server.command, ['--help'], { env: {}, timeout: 10000, maxBuffer: 1 << 20 })).stdout;
  } catch { return checked('could not read the Node runtime option help'); }
  const arities = nodeOptionArities(String(nodeHelp));
  if (!arities.has('--import') || !arities.has('--require')) return checked('could not parse the Node runtime option help');
  result.nodeValueOptions = [...arities].filter(([, takesValue]) => takesValue).map(([name]) => name).sort();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) continue;
    const name = arg.split('=')[0], inline = arg.includes('=');
    if (!arities.has(name)) return checked(`unknown option arity: ${name}`);
    if (arities.get(name) !== NODE_VALUE_FLAGS.has(name)) return checked(`launch parser does not consume the Node option consistently: ${name}`);
    if (arities.get(name) && (!inline && (!args[i + 1] || args[i + 1].startsWith('-')) || inline && arg.endsWith('='))) {
      return checked(`missing option value: ${name}`);
    }
    if (arities.get(name) && !inline) i++;
  }
  const isFile = path => { try { return Boolean(path) && statSync(path).isFile(); } catch { return false; } };
  if (!isFile(paths.script)) return checked('missing server script file');
  const missing = paths.optionFiles.filter(path => !isFile(path));
  if (missing.length) return checked(`${missing.length} missing option file${missing.length === 1 ? '' : 's'}`);
  result.status = 'pass';
  return checked(`${args.length} launch arguments, ${paths.optionFiles.length} option file${paths.optionFiles.length === 1 ? '' : 's'}`);
}

export async function runDoctor(launcher, env, run = execute) {
  let stdout = '', code = 0;
  try { ({ stdout } = await run(launcher, ['--doctor'], { env, timeout: 90000, maxBuffer: 8 << 20 })); }
  catch (error) { stdout = error.stdout ?? ''; code = typeof error.code === 'number' ? error.code : 1; if (!stdout) stdout = error.message; }
  const printed = /^Codex computer-use (\S+)$/m.exec(stdout)?.[1];
  const version = printed && SAFE_VERSION.test(printed) ? printed : undefined;
  const problem = stdout.split('\n').find(line => /^(?:MISSING|PROBLEM)\b|FAILED|^sleight: /.test(line.trim()));
  if (code === 0 && version) return { version, code, result: step('doctor', 'pass', `engine ${version}`) };
  return { version, code, result: step('doctor', 'fail', version ? `the doctor reported a problem (exit ${code})` : 'the doctor printed no plain engine version', problem?.trim()) };
}

// The raw engine, with no sleight relay in between: what the engine itself offers.
export async function rawEngineChecks(server, env, { open = openClient } = {}) {
  const steps = [];
  let client, docs;
  try {
    client = await open({ command: server.command, args: server.args, env: { ...env, ...server.env }, turnMeta: true, name: 'sleight-compat-engine' });
    steps.push(...checkToolSurface(await client.listTools()));
    const first = await client.call('js', { code: DOCS_CODE, timeout_ms: 30000 });
    const items = (first?.content ?? []).filter(item => item?.type === 'text').map(item => item.text);
    try { docs = engineDocsText(first); steps.push(...checkApiContract(docs)); }
    catch (error) { steps.push(step('api-contract', 'fail', error.message.split(':')[0])); }
    steps.push(...checkPolicyRewrite(items), ...checkWorkflowRewrite(items));
    const probe = await client.call('js', { code: PROBE_CODE, timeout_ms: 30000 });
    const surfaces = server.env?.CUA_REPL_ENABLED_SURFACES;
    steps.push(...(probe?.isError ? [step('repl-probe', 'fail', `the probe returned an error${surfaces ? ` (surfaces ${surfaces})` : ''}`, textOf(probe).split('\n')[0])]
      : checkReplProbe(parseProbe(textOf(probe)), { surfaces })));
    const ended = await client.endTurn();
    steps.push(ended?.isError ? step('turn-end', 'fail', 'turn_ended with the relay\'s arguments returned an error') : step('turn-end', 'pass'));
  } catch (error) {
    steps.push(step('engine-session', 'error', 'the engine session stopped', error.message));
  } finally {
    await client?.close();
  }
  return { steps, docs };
}

// sleight's own launcher: does it start against this engine and list its tools? It gets the surfaces the raw engine ran
// with, so both sessions match.
export async function launcherChecks(launcher, env, { open = openClient, surfaces = 'computer' } = {}) {
  let client;
  try {
    client = await open({ command: launcher, env: { ...env, SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_SURFACES: surfaces }, name: 'sleight-compat' });
    const names = new Set((await client.listTools() ?? []).map(tool => tool?.name));
    const missing = ['js', 'select_window'].filter(name => !names.has(name));
    return [missing.length ? step('sleight-start', 'fail', `sleight's tool list lacks ${missing.join(', ')}`) : step('sleight-start', 'pass', `${names.size} tools`)];
  } catch (error) {
    return [step('sleight-start', 'fail', "sleight's launcher didn't start", error.message)];
  } finally {
    await client?.close();
  }
}

// The raw docs against the last version that passed, kept beside watch.sh's snapshots in ~/Library/Logs/sleight.
export async function docsDiff(logs, version, docs, accepted, run = execute) {
  if (!docs) return [];
  const path = join(logs, `engine-raw-${version}.md`);
  atomic(path, docs);
  const base = accepted && accepted !== version ? join(logs, `engine-raw-${accepted}.md`) : undefined;
  if (!base || !existsSync(base)) return [step('api-docs', 'pass', accepted && accepted !== version ? `no raw snapshot of ${accepted} to compare` : 'no earlier version to compare')];
  const diff = await run('/usr/bin/diff', ['-u', base, path], { maxBuffer: 64 << 20 }).then(r => r.stdout, error => {
    if (error.code === 1) return error.stdout;
    throw error;
  });
  const changed = diff.split('\n').filter(line => /^[+-](?![+-])/.test(line)).length;
  if (!changed) return [step('api-docs', 'pass', `unchanged since ${accepted}`)];
  atomic(join(logs, `engine-raw-${version}.diff`), diff);
  return [step('api-docs', 'warn', `${changed} lines changed since ${accepted}; see ~/Library/Logs/sleight/engine-raw-${version}.diff`)];
}

// The surfaces sleight's launcher would start this engine with (launch.mjs selectSurfaces: SLEIGHT_SURFACES, else browser
// and computer when the extension cache says a Codex browser extension is connected, else computer). resolveServer alone
// always says computer, and the engine then defines no browser methods, which read as an engine break (CF2, 2026-10-19).
export async function launcherSurfaces(server, env, select) {
  select ??= (await import('../plugins/sleight/lib/launch.mjs')).selectSurfaces;
  const cache = select(server, env);
  // The launcher refreshes the cache after its first client call. The suite only reads it.
  await cache?.close?.();
  return server.env.CUA_REPL_ENABLED_SURFACES;
}

// Another project's timed window or a live run (a benchmark race) holds the Mac: nothing starts the engine meanwhile.
export function busy({ holdPath = '/tmp/sleight-hold', lockPath = '/tmp/sleight-live.lock', exists = existsSync } = {}) {
  if (exists(holdPath)) return `${holdPath} exists (another project's timed window)`;
  if (exists(lockPath)) return `${lockPath} exists (a live run is going)`;
  return undefined;
}

export async function engineTier({ launcher = LAUNCHER, env = process.env, logs = logsDir(), doctor, resolve: resolveServer, select, open = openClient, run = execute, nodeHelp,
  holdPath, lockPath } = {}) {
  const waiting = busy({ holdPath, lockPath });
  if (waiting) return { version: doctor?.version, pending: waiting, steps: [step('engine', 'pending', waiting)] };
  const ran = doctor ?? await runDoctor(launcher, env, run);
  const steps = [ran.result];
  if (ran.result.status !== 'pass') return { version: ran.version, steps };
  resolveServer ??= (await import('../plugins/sleight/lib/launch.mjs')).resolveServer;
  const server = resolveServer(env);
  if (server.error) return { version: ran.version, steps: [...steps, step('engine-session', 'fail', 'no engine to start', server.error)] };
  const launch = await launchShapeCheck({ server, env, nodeHelp, run });
  steps.push(launch.result);
  if (launch.result.status !== 'pass') return { version: ran.version, steps };
  const surfaces = await launcherSurfaces(server, env, select);
  const raw = await rawEngineChecks(server, env, { open });
  const bootstrap = await documentationBootstrapChecks(server, env, { open });
  steps.push(...raw.steps, bootstrap);
  if (!collectionCertain(bootstrap.cleanup)) return { version: ran.version, steps };
  steps.push(...await launcherChecks(launcher, env, { open, surfaces }));
  try { steps.push(...await docsDiff(logs, ran.version, raw.docs, readOr(join(logs, 'compat-accepted'), undefined), run)); }
  catch (error) { steps.push(step('api-docs', 'warn', "the docs diff couldn't run", error.message)); }
  return { version: ran.version, steps };
}

// The live checks: one launcher session, approvals limited to Calculator and Safari on the benchmark's allowlist.
export async function compatApproval(params) {
  const { benchmarkDecision } = await import('./approve.mjs');
  const { COMPAT_APPS } = await import('./compat/live.mjs');
  // The launcher rewrites local prompts for this client's initialize name, sleight-compat-live. Normalize only
  // that fixed host; the benchmark's app allowlist and session-only choices still make the approval decision.
  const message = (params?.message ?? '').replace(/^Allow Sleight Compat Live to /, 'Allow Claude to ');
  const app = /^Allow Computer Use to use "(.+)"\?$/.exec(message)?.[1] ?? /^Allow Claude to select a window in (.+?)\? /.exec(message)?.[1];
  if (!COMPAT_APPS.includes(app)) return { action: 'decline' };
  const decision = benchmarkDecision({ mcp_server_name: 'plugin:sleight:computer', message, requested_schema: params.requestedSchema, mode: params.mode }, { BENCH_SUITE: 'real' });
  return decision?.hookSpecificOutput?.action === 'accept' ? { action: 'accept', content: decision.hookSpecificOutput.content ?? {} } : { action: 'decline' };
}

// Signals during a live check: close the client, quit what the check launched, release the lock, then die of the same
// signal. One handler set at a time; a second signal while cleaning up kills at once.
async function withSignals(cleanup, work) {
  let cleaning;
  const handler = signal => {
    if (cleaning) process.kill(process.pid, 'SIGKILL');
    cleaning = Promise.race([cleanup().catch(() => {}), new Promise(resolve => setTimeout(resolve, 30000).unref())])
      .finally(() => { process.removeListener('SIGINT', handler); process.removeListener('SIGTERM', handler); process.kill(process.pid, signal); });
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  try { return await work(); }
  finally { process.removeListener('SIGINT', handler); process.removeListener('SIGTERM', handler); }
}

export async function liveTier({ ownerAway, minIdleSeconds = 0, launcher = LAUNCHER, env = process.env, holdPath = '/tmp/sleight-hold',
  lockPath = '/tmp/sleight-live.lock', live, lock, open = openClient } = {}) {
  live ??= await import('./compat/live.mjs');
  const gate = live.liveGate({ ownerAway, holdPath, minIdleSeconds, idleSeconds: minIdleSeconds > 0 ? await live.idleSeconds() : undefined });
  if (gate.pending) return { pending: gate.pending, steps: [step('live', 'pending', gate.pending)] };
  lock ??= (await import('./live-lock.mjs')).acquireLiveLock;
  let unlock;
  try { unlock = await lock(lockPath, { wait: false }); }
  catch (error) { return { pending: 'another live run holds the lock', steps: [step('live', 'pending', 'another live run holds the lock', error.message)] }; }
  const steps = [];
  let client, dir, launched, page, safariSince, safariDiagnostics, released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try { await unlock?.(); }
    catch (error) { steps.push(step('live-lock', 'fail', "couldn't release the live lock", error.message)); }
  };
  // What a signal leaves behind: the session, the Calculator this run launched, the fixture window, the lock.
  const cleanup = async () => {
    await client?.close();
    if (launched && live.quitApp) await live.quitApp(live.CALCULATOR, launched).catch(() => {});
    await page?.close().catch(() => {});
    if (safariSince && live.quitLaunchedSince) await live.quitLaunchedSince(live.SAFARI, safariSince, { pid: safariDiagnostics?.pid, unprovenWindow: safariDiagnostics?.cleanup === 'unproven window left open' }).catch(() => {});
    await release();
  };
  const hold = () => (existsSync(holdPath) ? step('live', 'pending', `${holdPath} exists (another project's timed window)`) : undefined);
  await withSignals(cleanup, async () => {
    try {
      const held = hold();
      if (held) { steps.push(held); return; }
      client = await open({ command: launcher, env: { ...env, SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_SURFACES: 'computer' }, approve: compatApproval, timeoutMs: 120000, name: 'sleight-compat-live' });
      steps.push(await live.runCalculator(client, { ...live, launchApp: async bundle => (launched = await live.launchApp(bundle)),
        quitApp: async (bundle, pid) => { await live.quitApp(bundle, pid); launched = undefined; } }));
      const between = hold();
      if (between) { steps.push(between); return; }
      dir = mkdtempSync(join(tmpdir(), 'sleight-compat-live-'));
      const nonce = randomBytes(6).toString('hex');
      const { openFixture, closeFixtures } = live.fixtures ?? await import('./real-fixture.mjs');
      steps.push(await live.runBrowserRead(client, { ...live, openPage: async () => {
        safariSince = Date.now();
        const opened = await live.openSafariPage({ nonce, dir, open: openFixture, close: closeFixtures, onDiagnostics: value => { safariDiagnostics = value; } });
        page = { ...opened, close: async () => { const close = opened.close; page = undefined; await close(); } };
        return page;
      } }));
      // runBrowserRead quit any Safari it launched; a Safari started later isn't this run's.
      safariSince = undefined;
    } catch (error) {
      steps.push(step('live', 'error', 'the live checks stopped', error.message));
    } finally {
      await client?.close();
      client = undefined;
      if (dir) rmSync(dir, { recursive: true, force: true });
      // A check that left an app or window behind keeps the lock, as the benchmark does, so nothing else runs into it.
      if (steps.some(s => s.cleanup)) steps.push(step('live-lock', 'fail', 'kept the live lock because cleanup failed; remove it after checking the Mac', lockPath));
      else await release();
    }
  });
  return { steps };
}

function liveStatus(steps) {
  const live = steps.filter(s => s.id.startsWith('live'));
  if (!live.length) return 'not run';
  if (live.some(s => s.status === 'pending')) return 'pending';
  return verdictOf(live) === 'pass' ? (live.every(s => s.status === 'skip') ? 'skipped' : 'pass') : 'fail';
}

export function appVersion(env = process.env) {
  const plist = join(env.SLEIGHT_CHATGPT_APP || '/Applications/ChatGPT.app', 'Contents', 'Info.plist');
  return existsSync(plist) ? plistString(readFileSync(plist, 'utf8'), 'CFBundleShortVersionString') : undefined;
}

export function makeReport({ version, steps, source, tier, now = new Date(), env = process.env }) {
  let commit;
  try { commit = execFileSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  return { checkedAt: now.toISOString(), source, tier, appVersion: appVersion(env), engineVersion: version, sleight: commit,
    verdict: verdictOf(steps), live: liveStatus(steps), steps };
}

export function summary(report) {
  return [`compat ${report.engineVersion ?? '?'} (ChatGPT ${report.appVersion ?? '?'}): ${report.verdict.toUpperCase()}, live ${report.live}`,
    ...report.steps.map(s => `  ${s.status.padEnd(7)} ${s.id}${s.reason ? `: ${s.reason}` : ''}`)].join('\n');
}

export function record(logs, report) {
  mkdirSync(logs, { recursive: true });
  appendFileSync(join(logs, 'compat.jsonl'), JSON.stringify(report) + '\n');
  // The docs baseline moves only when every engine check passed.
  if (report.tier !== 'live' && report.verdict === 'pass' && report.engineVersion) atomic(join(logs, 'compat-accepted'), report.engineVersion + '\n');
}

// The latest record for a version, from compat.jsonl.
export function lastRecord(logs, version, match = () => true) {
  const lines = readOr(join(logs, 'compat.jsonl'), '').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const entry = JSON.parse(lines[i]); if (entry.engineVersion === version && match(entry)) return entry; } catch {}
  }
  return undefined;
}

const stamp = () => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
async function notify(message, run = execute) {
  const quoted = message.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  await run('osascript', ['-e', `display notification "${quoted}" with title "sleight watch"`]).catch(() => {});
}

// One state lock for the watch job and manual runs, so two never write the logs at once.
// The pid is written by rename, so a reader sees no pid or a whole one. A lock without a pid younger than a minute is
// still being taken; an older one, or one whose pid is gone, is stale.
export function takeStateLock(logs, { now = Date.now } = {}) {
  const path = join(logs, 'compat.lock');
  try { mkdirSync(path); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(readOr(join(path, 'pid'), '0'));
    let alive = false;
    if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
    else { try { alive = now() - statSync(path).mtimeMs < 60000; } catch {} }
    if (alive) return undefined;
    rmSync(path, { recursive: true, force: true });
    try { mkdirSync(path); } catch (e) { if (e.code === 'EEXIST') return undefined; throw e; }
  }
  writeFileSync(join(path, `pid.${process.pid}`), String(process.pid));
  renameSync(join(path, `pid.${process.pid}`), join(path, 'pid'));
  return () => rmSync(path, { recursive: true, force: true });
}

// scripts/watch.sh: doctor every day; the engine checks when the version changed (or --force); the live checks when
// SLEIGHT_COMPAT_LIVE=1 (watch-install.sh --live), the Mac has been idle 5 minutes, and this version has no live result.
export async function runWatch({ env = process.env, logs = logsDir(), force = false, deps = {} } = {}) {
  const log = message => appendFileSync(join(logs, 'watch.log'), `${stamp()} ${message}\n`);
  const tell = deps.notify ?? notify;
  mkdirSync(logs, { recursive: true });
  const unlock = takeStateLock(logs);
  if (!unlock) { log('another compatibility run is in progress; skipped'); return 0; }
  try {
    // While the hold or a live run is on, nothing starts the engine and the version stays for the next run.
    const waiting = busy({ holdPath: deps.holdPath, lockPath: deps.lockPath });
    if (waiting) { log(`deferred: ${waiting}`); return 0; }
    const statePath = join(logs, 'watch-engine-version');
    const previous = readOr(statePath, undefined);
    const doctor = await runDoctor(deps.launcher ?? LAUNCHER, env, deps.run);
    if (doctor.result.status !== 'pass') {
      // A launch change may be why doctor failed. Preserve its shape even before the session checks can run.
      const launch = await launchShapeCheck({ env, resolve: deps.resolve, nodeHelp: deps.nodeHelp, run: deps.run });
      const report = makeReport({ version: doctor.version ?? launch.version, steps: [doctor.result, launch.result], source: 'watch', tier: 'engine', env });
      record(logs, report);
      log(`launch-shape: ${launch.result.status}; ${JSON.stringify(launch.result)}`);
      log(`doctor FAILED: ${doctor.result.reason}`);
      await tell(`Doctor failed: the ChatGPT computer-use engine is missing or broken. See ${join(logs, 'watch.log')}`);
      return 1;
    }
    const version = doctor.version;
    const liveWanted = env.SLEIGHT_COMPAT_LIVE === '1';
    const last = lastRecord(logs, version);
    const changed = previous !== version;
    // A live check that couldn't start (pending), never ran, or found its app already open tries again on the next run,
    // but only after the engine checks for this version passed.
    const enginePassed = lastRecord(logs, version, entry => entry.tier !== 'live')?.verdict === 'pass';
    const livePending = liveWanted && enginePassed && last && ['pending', 'not run', 'skipped'].includes(last.live);
    if (!changed && !force && !livePending) { log(`doctor ok, engine ${version} unchanged`); return 0; }

    let steps, tier;
    if (!changed && !force) { tier = 'live'; steps = []; }
    else {
      tier = 'engine';
      const tierResult = await engineTier({ env, logs, doctor, ...deps });
      if (tierResult.pending) { log(`deferred: ${tierResult.pending}`); return 0; }
      ({ steps } = tierResult);
    }
    if (liveWanted && verdictOf(steps) === 'pass') {
      tier = tier === 'live' ? 'live' : 'engine+live';
      steps.push(...(await liveTier({ ownerAway: true, minIdleSeconds: 300, env, ...deps.liveOptions })).steps);
    }
    const report = makeReport({ version, steps, source: 'watch', tier, env });
    record(logs, report);
    const reportPath = join(logs, `compat-${version}-${report.checkedAt.replace(/[:.]/g, '-')}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    log(`${tier} checks on engine ${version}: ${report.verdict}, live ${report.live}; report ${reportPath}`);
    for (const check of steps.filter(s => ['launch-shape', 'api-docs'].includes(s.id))) {
      log(`${check.id}: ${check.status}; ${JSON.stringify(check)}`);
    }
    // An "error" (the check couldn't run) keeps the old version, so tomorrow's run tries again.
    if (tier !== 'live' && report.verdict !== 'error') atomic(statePath, version + '\n');
    const failed = report.steps.find(s => ['fail', 'error'].includes(s.status));
    if (failed) await tell(`ChatGPT engine ${version}: compatibility check ${report.verdict.toUpperCase()} at ${failed.id}${failed.reason ? ` (${failed.reason})` : ''}. See ${reportPath}`);
    else if (tier !== 'live') await tell(`ChatGPT engine updated to ${version}. sleight passed the compatibility check${report.live === 'pass' ? ', live checks included' : ` (live checks ${report.live})`}.`);
    return report.verdict === 'pass' ? 0 : 1;
  } finally {
    unlock();
  }
}

// docs/results: merge the Mac log and any static results into the checked-in data file, and render the page.
const PAGE_HEAD = `# Engine compatibility

Each row is one compatibility check of sleight against a ChatGPT release, newest first, with its UTC date. "Static" rows come
from \`bench/compat-static.mjs\`, which reads a release's engine files without running them. "Mac" rows come from
\`bench/compat.mjs\` on the development Mac: the engine checks run the installed engine with no app, and the live checks
drive Calculator and a local page in Safari through sleight. Rows marked "watch task" predate the suite: \`scripts/watch.sh\`
ran the doctor, an API docs diff and the calculator-click benchmark task. [engine-notes.md](../engine-notes.md) describes
the checks, and this page is rebuilt with \`node bench/compat.mjs --publish\`.

| Checked (UTC) | ChatGPT | Engine | Where | Result | Live | Warnings and failures |
| --- | --- | --- | --- | --- | --- | --- |
`;

export function mergeEntries(existing, incoming) {
  const key = entry => `${entry.checkedAt}|${entry.source}|${entry.engineVersion ?? entry.appVersion}`;
  const seen = new Map(existing.map(entry => [key(entry), entry]));
  for (const entry of incoming) {
    if (!entry?.checkedAt) continue;
    const { checkedAt, source, tier, appVersion: app, engineVersion, sleight, verdict, live, steps = [] } = entry;
    seen.set(key(entry), { checkedAt, source, ...(tier ? { tier } : {}), appVersion: app ?? null, engineVersion: engineVersion ?? null,
      ...(sleight ? { sleight } : {}), verdict, ...(live ? { live } : {}),
      notes: steps.filter(s => ['warn', 'fail', 'error'].includes(s.status)).map(s => `${s.id}: ${scrub(s.reason ?? s.status)}`) });
  }
  return [...seen.values()].sort((a, b) => a.checkedAt.localeCompare(b.checkedAt));
}

export function renderPage(entries) {
  const where = entry => ({ static: 'Static', watch: 'Mac', manual: 'Mac', 'watch-task': 'Mac (watch task)' })[entry.source] ?? entry.source;
  const cell = text => String(text ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
  const rows = [...entries].reverse().map(entry => `| ${entry.checkedAt.slice(0, 16).replace('T', ' ')} | ${cell(entry.appVersion ?? '')} | ${cell(entry.engineVersion ?? '')} | ${where(entry)} | ${entry.verdict} | ${entry.live ?? ''} | ${cell((entry.notes ?? []).join('; '))} |`);
  return PAGE_HEAD + rows.join('\n') + '\n';
}

export function publish({ logs = logsDir(), staticLogs = [], data = join(ROOT, 'docs/results/data/engine-compat.json'), page = join(ROOT, 'docs/results/engine-compat.md') } = {}) {
  // A static log is results.jsonl (JSON Lines) or a single report (compat-report.json from the workflow's artifact).
  const readLines = path => {
    const text = readOr(path, '');
    try { const whole = JSON.parse(text); return Array.isArray(whole) ? whole : [whole]; } catch {}
    return text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  };
  const existing = existsSync(data) ? JSON.parse(readFileSync(data, 'utf8')).entries : [];
  const entries = mergeEntries(existing, [...readLines(join(logs, 'compat.jsonl')), ...staticLogs.flatMap(readLines)]);
  mkdirSync(dirname(data), { recursive: true });
  writeFileSync(data, JSON.stringify({ entries }, null, 2) + '\n');
  writeFileSync(page, renderPage(entries));
  return entries.length;
}

function option(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--launch-shape')) {
    const launch = await launchShapeCheck();
    const report = makeReport({ version: launch.version, steps: [launch.result], source: 'manual', tier: 'launch-shape' });
    const reportPath = option(argv, 'report');
    if (reportPath) writeFileSync(resolve(reportPath), JSON.stringify(report, null, 2) + '\n');
    console.log(summary(report));
    console.log(`  shape: ${JSON.stringify(launch.result.shape ?? [])}`);
    return report.verdict === 'pass' ? 0 : 1;
  }
  if (argv.includes('--publish')) {
    const staticLogs = argv.flatMap((arg, i) => (arg === '--static-log' && argv[i + 1] ? [resolve(argv[i + 1])] : []));
    console.log(`published ${publish({ staticLogs })} entries to docs/results/engine-compat.md`);
    return 0;
  }
  if (argv.includes('--watch')) return runWatch({ force: argv.includes('--force') });
  const minIdle = option(argv, 'min-idle');
  if (minIdle !== undefined && !/^\d+$/.test(minIdle)) { console.error('--min-idle takes a whole number of seconds'); return 2; }
  const logs = logsDir();
  mkdirSync(logs, { recursive: true });
  const unlock = takeStateLock(logs);
  if (!unlock) { console.error('another compatibility run is in progress'); return 2; }
  try {
    const engine = await engineTier({ logs });
    if (engine.pending) { console.log(`compat: not started, ${engine.pending}`); return 2; }
    const steps = [...engine.steps];
    const ownerAway = argv.includes('--owner-away');
    if (verdictOf(steps) === 'pass') steps.push(...(await liveTier({ ownerAway, minIdleSeconds: Number(minIdle ?? 0) })).steps);
    const ranLive = steps.some(s => s.id.startsWith('live') && s.status !== 'pending');
    const report = makeReport({ version: engine.version, steps, source: 'manual', tier: ranLive ? 'engine+live' : 'engine' });
    if (argv.includes('--record')) record(logs, report);
    const reportPath = option(argv, 'report');
    if (reportPath) writeFileSync(resolve(reportPath), JSON.stringify(report, null, 2) + '\n');
    console.log(summary(report));
    return report.verdict === 'pass' ? 0 : 1;
  } finally {
    unlock();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
