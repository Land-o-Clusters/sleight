import { fork } from 'node:child_process';
import { appendFileSync, closeSync, constants, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readInstalledConfig, readInstalledConfigFile, acceptedInstalledPackage, installedConfigPath } from './installed-config.mjs';
import { browserTools, validateToolCall, createToolDispatcher } from './tools.mjs';
import { validImages } from './screenshot.mjs';
import { MOTION_SIDE } from './motion.mjs';
import { HANDOFF_WAIT_MS } from './handoff.mjs';
import { createV3TurnBinding, createV3Context, recordingPermission } from './v3-context.mjs';
import { browserApplicationName } from './browsers.mjs';
import { readHandConfig } from '../hand/settings.mjs';
import { createPermissionCheck, stampUse } from '../permissions.mjs';
import { validHostLabel } from '../host-label.mjs';
import { isMainModule } from '../main-module.mjs';
import { recoverNativeClipboard } from '../clipboard.mjs';

const bridges = new WeakSet(), frontends = new WeakSet();
export const isV3Bridge = value => !!value && bridges.has(value);
export const isV3Frontend = value => !!value && frontends.has(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
// The relay's engine app approvals this session, by bundle id. They decide nothing alone: an app also needs the
// operator's opt-in file and its own debugger grant before turbo touches it.
const bundleId = value => typeof value === 'string' && value.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+$/.test(value);
const approvedApps = value => Array.isArray(value) && value.length <= 64 && value.every(bundleId) && new Set(value).size === value.length;
// Why turbo lost the browser connection goes to the relay's trace file (SLEIGHT_TRACE, see launch.mjs) as a code from
// selected-connection.mjs, never a frame's content. The relay is this worker's parent, so its pid names the file.
const lossCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,47}$/.test(value) ? value : 'UNKNOWN';
function traceLoss(reason) {
  const setting = process.env.SLEIGHT_TRACE;
  if (!setting || !process.ppid) return;
  try {
    const dir = setting === '1' ? join(homedir(), 'Library', 'Logs', 'sleight') : setting;
    appendFileSync(join(dir, `trace-${process.ppid}.jsonl`), JSON.stringify({ t: new Date().toISOString(), direction: 'turbo-connection-lost', msg: { code: lossCode(reason) } }) + '\n');
  } catch {}
}
// Why a worker failed to start, for the trace and the bench's task folder: the stage that failed and a code (our own
// error code, a system error code such as ETIMEDOUT, or the error's class), never a message, page content or a path.
const startupStage = value => typeof value === 'string' && /^[a-z][a-z-]{1,31}$/.test(value) ? value : undefined;
const startupCode = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{1,47}$/.test(value) ? value : undefined;
export function startupReason(error) {
  if (typeof error?.message === 'string' && /^[A-Z][A-Z0-9_]{2,47}$/.test(error.message)) return error.message;
  if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,47}$/.test(error.code)) return error.code;
  return startupCode(error?.constructor?.name) ?? 'UNKNOWN';
}
// The frame a worker that failed to start sends its relay. code keeps the relay's meaning (one of the unsafe codes, or
// V3_RUNTIME_UNAVAILABLE); stage and reason are diagnostics only.
export function unavailableFrame(error, fallbackStage = 'startup') {
  return { version: 3, status: 'unavailable', code: unsafeStartup.has(error?.message) ? error.message : 'V3_RUNTIME_UNAVAILABLE',
    stage: startupStage(error?.stage) ?? fallbackStage, reason: startupReason(error) };
}
// A failed start goes to the relay's trace file (SLEIGHT_TRACE) as one event. The bridge runs in the relay, so its own pid names the file.
export function traceStartupFailure(detail, { setting = process.env.SLEIGHT_TRACE, relayPid = process.pid } = {}) {
  if (!setting || !Number.isSafeInteger(relayPid) || relayPid < 1) return;
  try {
    const dir = setting === '1' ? join(homedir(), 'Library', 'Logs', 'sleight') : setting;
    mkdirSync(dir, { recursive: true });
    const msg = { code: startupCode(detail?.code) ?? 'UNKNOWN', stage: startupStage(detail?.stage) ?? 'startup',
      reason: startupCode(detail?.reason) ?? 'UNKNOWN', ...(Number.isSafeInteger(detail?.attempt) ? { attempt: detail.attempt } : {}),
      ...(typeof detail?.retrying === 'boolean' ? { retrying: detail.retrying } : {}) };
    appendFileSync(join(dir, `trace-${relayPid}.jsonl`), JSON.stringify({ t: new Date().toISOString(), direction: 'turbo-startup-failed', msg }) + '\n', { mode: 0o600 });
  } catch {}
}
// Only these failures of a relay's bridge startup can pass on a second try: the worker crashed (a signal or a non-zero
// exit, or its channel closed first), the process table was full, or Chrome changed an entry between two reads. Chrome
// closed, or open without remote debugging, stays as it is. A hung worker (worker-timeout, 120 s) is not retried, so the
// wait never doubles and no second worker runs beside a stuck one.
const transientReasons = new Set(['STALE_INSTANCE', 'EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'EINTR', 'ETIMEDOUT']);
export const transientStartup = error => error?.stage === 'worker-disconnect' ||
  error?.stage === 'worker-exit' && error.reason !== 'EXIT_0' || transientReasons.has(error?.reason);
const phases = new Set(('worker-spawn-start worker-spawned bridge-ready tools-registered turn-begin first-call-admitted call-start call-result '
  + 'turn-end-requested turn-end worker-entry helpers-check-start helpers-check-end connection-select-start connection-select-end '
  + 'worker-ready connection-start connection-end runtime-ready '
  + 'browser-open-start browser-open-create-start browser-open-create-end browser-open-attach-end browser-open-identify-end '
  + 'browser-open-adopt-end browser-open-ready-end browser-open-goto-start browser-open-goto-end browser-open-capture-start '
  + 'browser-open-capture-end browser-open-end').split(' '));
// Numeric ordinals correlate calls without recording user text, tool arguments or page results.
// Both processes append to the relay's existing trace file. Disabled tracing reads no clock and does no I/O.
export function createWorkerTrace({ setting = process.env.SLEIGHT_TRACE, metrics = process.env.SLEIGHT_TURBO_METRICS, relayPid = process.ppid, now = Date.now } = {}) {
  const dir = setting === '1' ? join(homedir(), 'Library', 'Logs', 'sleight') : setting;
  // The bridge starts before launch.mjs initializes relay tracing.
  let fd, metricFd;
  if (dir && Number.isSafeInteger(relayPid) && relayPid > 0) try {
    mkdirSync(dir, { recursive: true }); fd = openSync(join(dir, `trace-${relayPid}.jsonl`), 'a', 0o600);
  } catch {}
  if (metrics) try {
    if (metrics.startsWith('/') && resolve(metrics) === metrics && basename(metrics) === 'turbo-metrics.jsonl' && realpathSync(dirname(metrics)) === dirname(metrics))
      metricFd = openSync(metrics, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  } catch {}
  const trace = (phase, turn, call) => {
    const openPhase = typeof phase === 'string' && phase.startsWith('browser-open-');
    if (fd === undefined && (metricFd === undefined || !openPhase)) return;
    if (!phases.has(phase) || [turn, call].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 0))) return;
    try {
      const t = new Date(now()).toISOString(), msg = { phase, ...(turn !== undefined ? { turn } : {}), ...(call !== undefined ? { call } : {}) };
      if (fd !== undefined) try { writeSync(fd, JSON.stringify({ t, direction: 'turbo-phase', msg }) + '\n'); } catch {}
      if (metricFd !== undefined && openPhase) try { writeSync(metricFd, JSON.stringify({ version: 3, t, ...msg }) + '\n'); } catch {}
    } catch {}
  };
  trace.close = () => { const old = [fd, metricFd]; fd = metricFd = undefined; for (const value of old) if (value !== undefined) try { closeSync(value); } catch {} };
  return trace;
}
function phaseTrace(dependencies, relayPid) {
  const trace = dependencies.tracePhase ?? createWorkerTrace({ relayPid });
  const emit = (...args) => { try { trace(...args); } catch {} };
  emit.close = () => { try { trace.close?.(); } catch {} };
  return emit;
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const unproved = () => ({ revoked: true, cleanup: [{ resource: 'v3-worker', status: 'retained', code: 'CLEANUP_UNPROVED' }] });
export const failure = (unknown = false) => ({ text: unknown ? 'Input outcome is unconfirmed. Read state before retrying' + (process.env.SLEIGHT_MT === '0' ? '; use the engine browser path if needed.' : '.')
  : 'Turbo is unavailable for this turn. Use the engine browser path.', isError: !unknown });
// The model sees which application turbo selected, so a task naming it needs no engine search.
// The name comes only from the operator-owned config's executable path and a fixed list, never a page.
export const applicationName = browserApplicationName;
// The person's "Turn turbo off" click in the menu bar: the same opt-out file the launcher writes. turbo-setup loads only then.
// The menu's footer: the installed plugin's own version.
const pluginVersion = (() => {
  try {
    const { version } = JSON.parse(readFileSync(fileURLToPath(new URL('../../.claude-plugin/plugin.json', import.meta.url)), 'utf8'));
    return /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version) ? version : undefined;
  } catch { return undefined; }
})();
async function optOut() {
  const { writeConfigFile } = await import('./turbo-setup.mjs');
  writeConfigFile(installedConfigPath(), { version: 1, enabled: false });
}
// The person's click on the menu's Ghost Hand row: hand.json's enabled flag, written as the launcher's hand command writes it.
async function setHand(enabled) { (await import('../hand/command.mjs')).writeHandSetting({ enabled }); }
const unsafeStartup = new Set(['HOST_PACKAGE_MISMATCH', 'HOST_SOURCE_MISMATCH', 'HOST_CACHE_UNSAFE', 'INSTALLED_CONFIG_UNSAFE']);
// The admin secret of the resident Electron app hosts. The MCP server process makes it once and hands it to each worker
// it forks in the begin frames (IPC only, never argv, env or disk), so a new worker can still administer a host that
// an earlier worker of this server started. A host from an earlier server run stays foreign (docs/known-problems.md).
let appSecret;
export const serverAppSecret = () => (appSecret ??= randomBytes(32).toString('base64url'));
const validAppSecret = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(value);
const printableName = value => typeof value === 'string' && /^[^\x00-\x1f\x7f]{1,64}$/.test(value);
const foreignHost = name => { const app = printableName(name) ? name : 'The app';
  return { text: `${app} is held by an earlier sleight session's host, so turbo can't reach it. Quit the ${app} window sleight opened (the app's own Quit), then retry. Nothing was sent.`, isError: true }; };
// The relaunch flow's fallbacks (electron-relaunch.mjs) say what happened to the user's app; the text names only the recipe's app.
const APP_NOTICE = /^ELECTRON_(?:RELAUNCH_[A-Z_]{1,32}|APP_OTHER_USER|USER_PROFILE_UNSUPPORTED)$/;
const appNotice = error => APP_NOTICE.test(error?.message ?? '') && typeof error.notice === 'string' && error.notice.length <= 600 &&
  error.notice.startsWith(error.message + ': ') && /^[^\x00-\x1f\x7f]+$/.test(error.notice) ? { text: error.notice, isError: true } : undefined;
// The call that prepares an app turn waits, per app and one app after another, on sleight's own cards (120 s each, debugger
// and relaunch), the app's own Quit (60 s), the reopen and its windows (30 s). The begin reply carries that deadline, capped
// at 10 minutes, so the bridge does not take the wait for a hung worker; later calls keep the default.
const APP_PREPARE_WAIT_MS = 330000, APP_PREPARE_CAP_MS = 600000;
const PDF_BUILD_WAIT_MS = 330000; // compiler 300 s, parser 10 s, and collection/identity checks
const MAX_HANDOFF_TABS = 1024;
// Until the registry reports its population, a missing card gets at most ten minutes.
// The drain frame sizes that ceiling to five seconds per tab plus the card wait.
const HANDOFF_DRAIN_WAIT_MS = 600000;
const validWait = value => Number.isSafeInteger(value) && value >= 1000 && value <= APP_PREPARE_CAP_MS;
export function handoffRpcWaitMs(waitMs, ownedTabs) {
  if (!Number.isSafeInteger(waitMs) || waitMs <= 0 || waitMs > HANDOFF_WAIT_MS ||
      !Number.isSafeInteger(ownedTabs) || ownedTabs < 1 || ownedTabs > MAX_HANDOFF_TABS) throw Error('INVALID_HANDOFF_WAIT');
  return Math.min(HANDOFF_DRAIN_WAIT_MS, waitMs + 5000 * ownedTabs);
}

export async function createV3Bridge({ startupTimeoutMs = 120000, timeoutMs = 31000 } = {}, dependencies = {}) {
  const config = (dependencies.readConfig ?? readInstalledConfig)();
  if (!config) return null;
  const accepted = (dependencies.acceptPackage ?? acceptedInstalledPackage)(config);
  if (!accepted.current()) throw Error('HOST_PACKAGE_MISMATCH');
  if (![startupTimeoutMs, timeoutMs].every(n => Number.isInteger(n) && n > 0 && n <= 300000)) throw Error('TRUSTED_ROUTE_REQUIRED');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:NODE_|DYLD_|LD_)/.test(key)) delete env[key];
  const trace = phaseTrace(dependencies, process.pid);
  trace('worker-spawn-start');
  // The session's shared host (the ghost hand's) serves turbo's consent channel too, so one glove serves both. The worker gets
  // the channel's ends as fds 4 and 5 and talks to the host directly; the relay retains idle copies for reattachment.
  // Without a shared host the worker opens its own, as before.
  let shared, child;
  try { shared = await (dependencies.shareConsent ?? (await import('../hand/client.mjs')).shareConsent)(); }
  catch (error) { trace.close(); throw Object.assign(error, { stage: 'worker-spawn', reason: startupReason(error) }); }
  try { child = (dependencies.forkWorker ?? fork)(fileURLToPath(new URL('./worker.mjs', import.meta.url)), shared ? ['--shared-ui', ...(Number.isSafeInteger(shared.pid) && shared.pid > 0 ? ['--shared-hand-pid=' + shared.pid] : [])] : [],
    { env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc', ...shared ? [shared.write, shared.read] : []], serialization: 'json' }); }
  catch (error) { shared?.detached?.(); trace.close(); throw Object.assign(Error('V3_WORKER_UNAVAILABLE'), { stage: 'worker-spawn', reason: startupReason(error) }); }
  finally { shared?.release(); }
  child.once('exit', () => shared?.detached?.());
  trace('worker-spawned');
  let hello, active = false, lost = false, generation = 0, sequence = 0, ending, callTimeoutMs = timeoutMs;
  let traceTurn = 0, traceCall = 0, toolsRegistered = false;
  const pending = new Map(), turns = new Set(); let deliveries = new WeakMap(), resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timer = setTimeout(() => lose(undefined, 'worker-timeout'), startupTimeoutMs);
  const current = () => { try { return accepted.current() === true; } catch { return false; } };
  function fence() { active = false; generation++; deliveries = new WeakMap(); }
  // stage and reason say why a worker never became ready (unavailableFrame); after hello they are unused.
  function lose(code = 'V3_WORKER_UNAVAILABLE', stage = 'worker-disconnect', reason) {
    if (lost) return;
    lost = true; fence(); clearTimeout(timer);
    const error = Error(typeof code === 'string' ? code : 'V3_WORKER_UNAVAILABLE');
    if (!hello) Object.assign(error, { stage, reason: reason ?? error.message });
    rejectReady(error);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('V3_WORKER_UNAVAILABLE')); }
    pending.clear();
    try { if (child.connected) child.disconnect(); child.unref?.(); } catch {}
    trace.close();
  }
  child.on('message', frame => {
    if (lost) return;
    if (shared && exact(frame, ['version', 'hand']) && frame.version === 3) { shared.send?.(frame.hand); return; }
    if (!hello && (exact(frame, ['version', 'status', 'code']) || exact(frame, ['version', 'status', 'code', 'stage', 'reason'])) &&
        frame.version === 3 && frame.status === 'unavailable') {
      const code = unsafeStartup.has(frame.code) ? frame.code : 'V3_RUNTIME_UNAVAILABLE';
      lose(code, startupStage(frame.stage) ?? 'startup', startupCode(frame.reason) ?? code); return;
    }
    if (!hello && exact(frame, ['version', 'session', 'nonce', 'browser']) && frame.version === 3 && id(frame.session) &&
        /^[a-f0-9]{64}$/.test(frame.nonce) && /^b[A-Za-z0-9_-]{1,63}$/.test(frame.browser)) {
      hello = frame; clearTimeout(timer); trace('bridge-ready'); resolveReady(); return;
    }
    if (hello && exact(frame, ['version', 'id', 'handoffDrain']) && frame.version === 3) {
      const entry = pending.get(frame.id), detail = frame.handoffDrain;
      try {
        if (!entry?.handoff || entry.draining || entry.extended || !exact(detail, ['ownedTabs'])) throw Error();
        const wait = handoffRpcWaitMs(HANDOFF_WAIT_MS, detail.ownedTabs);
        clearTimeout(entry.timer); entry.draining = true;
        entry.timer = setTimeout(() => lose(), wait);
      } catch { lose(undefined, 'worker-protocol'); }
      return;
    }
    if (hello && exact(frame, ['version', 'id', 'handoff']) && frame.version === 3) {
      const entry = pending.get(frame.id), detail = frame.handoff;
      try {
        if (!entry?.handoff || entry.extended || !exact(detail, ['deadline', 'waitMs', 'ownedTabs']) ||
            !Number.isSafeInteger(detail.deadline) || detail.deadline <= Date.now() || detail.deadline > Date.now() + detail.waitMs) throw Error();
        const wait = handoffRpcWaitMs(detail.waitMs, detail.ownedTabs);
        clearTimeout(entry.timer); entry.extended = true;
        entry.timer = setTimeout(() => lose(), Math.max(1, detail.deadline - Date.now() + wait - detail.waitMs));
      } catch { lose(undefined, 'worker-protocol'); }
      return;
    }
    // Only the trusted worker's active PDF compiler can extend this exact page-reading request, once.
    if (hello && exact(frame, ['version', 'id', 'pdfBuild']) && frame.version === 3 && frame.pdfBuild === true) {
      const entry = pending.get(frame.id);
      if (!active || !current() || !entry || entry.pdfBuild || !['browser_read', 'browser_open', 'browser_act', 'browser_fill'].includes(entry.tool)) { lose(undefined, 'worker-protocol'); return; }
      entry.pdfBuild = true; clearTimeout(entry.timer);
      entry.timer = setTimeout(() => lose(), PDF_BUILD_WAIT_MS); return;
    }
    if (!hello || !exact(frame, ['version', 'id', 'result']) || frame.version !== 3 || !pending.has(frame.id)) { lose(undefined, 'worker-protocol'); return; }
    const entry = pending.get(frame.id); pending.delete(frame.id); clearTimeout(entry.timer); entry.resolve(frame.result);
  });
  // Before hello, an exit or a closed channel waits 50 ms, so the worker's own unavailable frame (sent just before it
  // disconnects) names the failure rather than the exit that followed it.
  const ended = (stage, reason) => hello ? lose(undefined, stage, reason) : setTimeout(() => lose(undefined, stage, reason), 50);
  child.on('error', error => lose(undefined, 'worker-spawn', startupReason(error)));
  child.on('exit', (code, signal) => ended('worker-exit', startupCode(signal) ?? (Number.isSafeInteger(code) ? 'EXIT_' + code : undefined)));
  child.on('disconnect', () => ended('worker-disconnect'));
  function rpc(method, params, deadlineMs = timeoutMs) {
    if (lost || !current() || pending.size >= 32) return Promise.reject(Error('V3_WORKER_UNAVAILABLE'));
    const frame = { version: 3, id: 'q' + (++sequence), method, params };
    if (Buffer.byteLength(JSON.stringify(frame)) > 131072) return Promise.reject(Error('INVALID_ARGUMENT'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { lose(); reject(Error('V3_WORKER_UNAVAILABLE')); }, deadlineMs);
      pending.set(frame.id, { resolve, reject, timer, handoff: method === 'call' && params.name === 'browser_tabs' && params.arguments?.do === 'handoff' && params.arguments.wait === true, ...(method === 'call' ? { tool: params.name } : {}) });
      try { child.send(frame, error => { if (error) lose(); }); } catch { lose(); }
    });
  }
  await ready;
  if (!current()) { lose(); throw Object.assign(Error('HOST_PACKAGE_MISMATCH'), { stage: 'package', reason: 'HOST_PACKAGE_MISMATCH' }); }
  function endTurn() {
    fence();
    if (!ending) {
      const turn = traceTurn; trace('turn-end-requested', turn);
      ending = rpc('end', {}).catch(unproved).finally(() => { trace('turn-end', turn); ending = undefined; });
    }
    return ending;
  }
  const bridge = Object.freeze({ browser: hello.browser, application: applicationName(config.executable),
    bootstrapEnvelope: () => ({ version: 1, session: hello.session, nonce: hello.nonce }),
    tools: () => {
      const tools = browserTools(hello.browser);
      if (!toolsRegistered) { toolsRegistered = true; trace('tools-registered'); }
      return tools;
    },
    // apps: the relay's own list of engine-approved bundle ids, never a field of the hook's frame.
    // host: the relay's label for the MCP client (host-label.mjs), for the menu bar. Never a field of the hook's frame.
    async bind(frame, apps = [], host) {
      if (!exact(frame, ['version', 'session', 'nonce', 'event', 'turn', 'text']) || frame.version !== 1 ||
          frame.session !== hello.session || frame.nonce !== hello.nonce || frame.event !== 'begin' || !id(frame.turn) ||
          typeof frame.text !== 'string' || Buffer.byteLength(frame.text) > 65536 || !approvedApps(apps) || turns.has(frame.turn) || lost || !current()) throw Error('TRUSTED_TURN_REQUIRED');
      turns.add(frame.turn); fence(); const epoch = generation;
      callTimeoutMs = timeoutMs;
      trace('turn-begin', ++traceTurn); traceCall = 0;
      const result = await rpc('begin', { turn: frame.turn, text: frame.text, apps: [...apps], appSecret: serverAppSecret(),
        ...(validHostLabel(host) ? { host } : {}) });
      if (epoch !== generation || lost || !current()) return false;
      active = result?.available === true;
      // An app turn's first calls prepare it and may wait on the user's clicks; the worker names that deadline, within 10 minutes.
      // It lasts until the first call returns, when preparation is over.
      if (active && validWait(result.waitMs) && result.waitMs > timeoutMs) callTimeoutMs = result.waitMs;
      return active;
    },
    async call(input) {
      let request;
      try { request = validateToolCall(input, hello.browser); } catch { return { text: 'Invalid turbo arguments. Use the documented five tool schemas.', isError: true }; }
      if (!active || lost || !current()) return failure();
      const epoch = generation;
      const turn = traceTurn, call = ++traceCall;
      if (call === 1) trace('first-call-admitted', turn);
      trace('call-start', turn, call);
      try {
        const waiting = request.name === 'browser_tabs' && request.arguments.do === 'handoff' && request.arguments.wait === true;
        const reply = await rpc('call', request, waiting ? HANDOFF_DRAIN_WAIT_MS : callTimeoutMs);
        if (epoch === generation) callTimeoutMs = timeoutMs;
        if (!active || lost || epoch !== generation || !current()) return failure(request.name !== 'browser_read');
        const result = reply?.result, hasImages = Object.hasOwn(result ?? {}, 'images');
        const frames = request.name === 'browser_act' ? request.arguments.frames : undefined;
        const imageRequested = request.name === 'browser_read' && request.arguments.screenshot === true
          || request.name === 'browser_act' && (request.arguments.observe === 'screenshot' || frames !== undefined);
        if (!exact(reply, ['resultId', 'result']) || !id(reply.resultId) || !exact(result, hasImages ? ['text', 'isError', 'images'] : ['text', 'isError'])
          || typeof result.text !== 'string' || typeof result.isError !== 'boolean' || result.text.length > 100000) throw Error();
        if (hasImages && (result.isError || !imageRequested
          || !validImages(result.images, frames === undefined ? {} : { maxImages: frames, maxSide: MOTION_SIDE })
          || frames !== undefined && result.images.length !== frames)) throw Error();
        if (!result.isError) deliveries.set(result, { id: reply.resultId, hash: hash(result), epoch });
        return result;
      } catch { lose(); return failure(request.name !== 'browser_read'); }
      finally { trace('call-result', turn, call); }
    },
    delivered(result) {
      const record = deliveries.get(result); deliveries.delete(result);
      if (!record || !active || lost || !current() || record.epoch !== generation || record.hash !== hash(result)) return false;
      rpc('delivered', { resultId: record.id, hash: record.hash }).catch(() => {}); return true;
    },
    end: endTurn, endTurn,
    async detach() { const receipt = await endTurn(); lose(); return receipt; },
    async close() { fence(); try { return await rpc('close', {}); } catch { return unproved(); } finally { lose(); } },
  });
  bridges.add(bridge); return bridge;
}
export function createV3Frontend(bridge) {
  if (!isV3Bridge(bridge)) throw Error('TRUSTED_ROUTE_REQUIRED');
  const frontend = Object.freeze({ browser: bridge.browser, application: bridge.application, tools: bridge.tools, call: bridge.call, delivered: bridge.delivered, end: bridge.endTurn });
  frontends.add(frontend); return frontend;
}

// The installed join supplies owned pages and snapshots. Only the worker begin
// binding supplies user authority; MCP arguments never reach this constructor.
export async function createV3TurnRuntime({ binding, browser, pages, snapshot, ui, endpoint, dependencies = {} }) {
  const [{ runSteps }, { fillFields }, { deliverSnapshot }] = await Promise.all([
    import('./act.mjs'), import('./fill.mjs'), import('./rules.mjs'),
  ]);
  const ctx = (dependencies.createContext ?? createV3Context)({ binding, browser, ui });
  const permitted = recordingPermission(binding);
  let recording;
  if (permitted() && dependencies.recordingSupported !== false) {
    const [{ createTurnRecording }, { captureRecordingFrame }] = await Promise.all([import('../turn-recording.mjs'), import('./recording.mjs')]);
    recording = createTurnRecording({ current: permitted, capture: (entry, target) => captureRecordingFrame(entry,
      { pages, current: permitted, endpoint, sites: dependencies.sites, target }), ...dependencies.recording });
  }
  const originals = new WeakMap();
  let pdf, pdfBuilding;
  if (dependencies.pdfInventory || dependencies.pdfExtract) {
    const [{ createPdfReader }, { pdfFileAllowed }] = await Promise.all([import('./pdf.mjs'), import('./v3-context.mjs')]);
    let prepared;
    pdf = createPdfReader({ authorizeFile: path => pdfFileAllowed(binding, path),
      extract: dependencies.pdfExtract ?? (async (path, cursor, { signal }) => {
        const { preparePdfHelper, extractPdf } = await import('./host.mjs');
        let built;
        try {
          built = await (prepared ??= (dependencies.preparePdfHelper ?? preparePdfHelper)({ inventory: dependencies.pdfInventory, signal,
            onProgress: event => { if (event.stage === 'compile') pdfBuilding?.(); } }));
        } catch (error) { prepared = undefined; throw error; }
        if (built.status !== 'ready') {
          prepared = undefined;
          throw Error('PDF helper needs Apple command-line tools and a successful local build.');
        }
        return (dependencies.extractPdf ?? extractPdf)(built.receipt, path, cursor, { signal });
      }) });
  }
  let recordingStarted = false, recordingReported = false;
  const runtime = createToolDispatcher({ browser, pages, snapshot, ctx, endpoint, sites: dependencies.sites, onSite: dependencies.onSite,
    pdf,
    tracePhase: dependencies.tracePhase, ...(recording ? { onAction: recording.capture } : {}),
    runSteps: dependencies.runSteps ?? runSteps, fillFields: dependencies.fillFields ?? fillFields,
    deliverSnapshot(state, capture) {
      if (capture.state !== state || !Number.isSafeInteger(capture.number) || capture.number < 1 ||
          !Number.isFinite(capture.capturedAt) || capture.capturedAt < 0) return false;
      if (dependencies.acknowledgeSnapshot && dependencies.acknowledgeSnapshot(capture.page, capture.number) !== true) return false;
      deliverSnapshot(state, capture);
      // V6's boolean means a submit fence was released, rather than whether
      // an ordinary snapshot was accepted. Both count as delivered text here.
      return true;
    } });
  return Object.freeze({ async call(request, control) {
      let notified = false;
      pdfBuilding = () => { if (!notified) { notified = true; control?.pdfBuilding?.(); } };
      try {
        const result = await runtime.call(request, control);
        if (!recording && !permitted()) return result;
        const notes = [];
        if (!recordingStarted) {
          recordingStarted = true;
          notes.push(recording ? 'Recording this turn: frames are pixelated everywhere; the outline shows where the action landed. Blocks are at least 32 CSS px and scale with visible fonts and viewport size. Fields and editable controls are black; targeted frames, canvases, images, SVGs and videos are black. DOM reads have a 5,000-element field cap and 50 ms budget; exceeding either skips frames. GIF caps: 30 frames, 640 by 480 pixels, 12 MiB. The pointer and target outline are drawn on top. Saved path follows at turn end.'
            : 'Recording: unavailable for app windows; no frames saved.');
        }
        if (recording?.warning()) notes.push(recording.warning());
        if (!notes.length) return result;
        const noted = { ...result, text: result.text + '\n' + notes.join('\n') };
        originals.set(noted, { result, text: noted.text, isError: noted.isError }); return noted;
      } finally { pdfBuilding = undefined; }
    }, delivered(result) {
      const original = originals.get(result); originals.delete(result);
      if (!original) return runtime.delivered(result);
      return result.text === original.text && result.isError === original.isError && runtime.delivered(original.result);
    },
    async end() { const recordingEnded = recording?.end(); const cleanup = ctx.dispose(); const previous = await runtime.end();
      await recordingEnded;
      const receipt = { ...previous, cleanup: [...previous.cleanup] };
      if (recording && !recordingReported) { recordingReported = true; receipt.recording = recording.note(); }
      if ((await cleanup).retained) receipt.cleanup.push({ resource: 'uploads', status: 'retained', code: 'CLEANUP_UNPROVED' });
      return receipt;
    },
  });
}

/** The tool runtime over an app turn's surface (electron-runtime createAppTurn): the registry read path, the delivered-read
 * acknowledgment and the fenced runners. The installed worker and the EPV3-8 harness both compose an app turn here. */
export function createAppTurnRuntime({ surface, binding, browser, ui, sites, onSite, createRuntime } = {}) {
  return (createRuntime ?? createV3TurnRuntime)({ binding, browser, pages: surface.pages, snapshot: surface.snapshot, ui, endpoint: undefined,
    dependencies: { createContext: () => surface.context, runSteps: surface.runSteps, fillFields: surface.fillFields, acknowledgeSnapshot: surface.acknowledgeSnapshot, sites, onSite, recordingSupported: false } });
}

// Only an inherited fork channel reaches this entry. MCP calls carry tool JSON,
// while begin frames carry the relay hook's authenticated user message separately.
export function serveV3Worker({ channel, browser, begin, current = () => true, close = async () => ({ revoked: true, cleanup: [] }) }) {
  const session = 'v3' + randomBytes(16).toString('hex'), nonce = randomBytes(32).toString('hex');
  let runtime, generation = 0, work = Promise.resolve(), queued = 0, ended = false;
  const seen = new Set(), turns = new Set(), results = new Map();
  const lost = () => { ended = true; Promise.resolve(fence()).catch(() => {}); };
  const send = frame => {
    if (channel.connected === false) return;
    try { channel.send(frame, error => { if (error) lost(); }); } catch { lost(); }
  };
  function fence() { generation++; results.clear(); const old = runtime; runtime = undefined; return old?.end() ?? Promise.resolve({ revoked: true, cleanup: [] }); }
  channel.on('disconnect', () => { ended = true; Promise.resolve(fence()).catch(() => {}); });
  channel.on('message', frame => {
    if (ended) return;
    if (!exact(frame, ['version', 'id', 'method', 'params']) || frame.version !== 3 || !id(frame.id) || seen.has(frame.id) ||
        seen.size >= 65536 || Buffer.byteLength(JSON.stringify(frame)) > 131072) { ended = true; Promise.resolve(fence()).catch(() => {}); return; }
    seen.add(frame.id);
    const respond = result => send({ version: 3, id: frame.id, result });
    if (frame.method === 'end' || frame.method === 'close') {
      if (!exact(frame.params, [])) return respond(unproved());
      if (frame.method === 'close') ended = true;
      const stopped = fence();
      Promise.resolve(stopped).then(async receipt => {
        if (frame.method === 'close') { await work.catch(() => {}); return close(); }
        return receipt;
      }).then(respond, () => respond(unproved()));
      return;
    }
    if (frame.method === 'begin') {
      const keys = ['turn', 'text', 'apps', ...['appSecret', 'host'].filter(key => Object.hasOwn(frame.params ?? {}, key))];
      if (!exact(frame.params, keys) || !id(frame.params.turn) || turns.has(frame.params.turn) ||
          typeof frame.params.text !== 'string' || Buffer.byteLength(frame.params.text) > 65536 || !approvedApps(frame.params.apps) ||
          (Object.hasOwn(frame.params, 'host') && !validHostLabel(frame.params.host))) return respond({ available: false });
      turns.add(frame.params.turn); const stopped = fence(), epoch = generation, apps = Object.freeze([...frame.params.apps]);
      const secret = validAppSecret(frame.params.appSecret) ? frame.params.appSecret : undefined, host = frame.params.host;
      work = work.catch(() => {}).then(async () => {
        await stopped;
        if (ended || epoch !== generation || !current()) return { available: false };
        const message = Object.freeze({ source: 'user', session, turn: frame.params.turn, id: frame.params.turn, text: frame.params.text });
        const binding = createV3TurnBinding(message, () => !ended && epoch === generation && current());
        const prepared = await begin(message, binding, { apps, ...(secret ? { appSecret: secret } : {}), ...(host ? { host } : {}) });
        if (ended || epoch !== generation || !current()) { await prepared?.end(); return { available: false }; }
        runtime = prepared; return { available: !!runtime, ...(runtime && validWait(runtime.waitMs) ? { waitMs: runtime.waitMs } : {}) };
      });
      work.then(respond, () => respond({ available: false })); return;
    }
    if (!['call', 'delivered'].includes(frame.method) || queued >= 32) return respond({ resultId: frame.id, result: failure() });
    const epoch = generation; queued++;
    const operation = work.catch(() => {}).then(async () => {
      if (!runtime || ended || epoch !== generation || !current()) return { resultId: frame.id, result: failure() };
      if (frame.method === 'delivered') {
        if (!exact(frame.params, ['resultId', 'hash'])) return false;
        const record = results.get(frame.params.resultId); results.delete(frame.params.resultId);
        return !!record && record.runtime === runtime && record.hash === frame.params.hash && record.hash === hash(record.result) && runtime.delivered(record.result) === true;
      }
      const request = validateToolCall(frame.params, browser), owner = runtime;
      const result = await owner.call(request, { handoffDrain: detail => send({ version: 3, id: frame.id, handoffDrain: detail }),
        handoffDeadline: detail => send({ version: 3, id: frame.id, handoff: detail }), pdfBuilding: () => {
        if (epoch === generation && !ended && runtime === owner && ['browser_read', 'browser_open', 'browser_act', 'browser_fill'].includes(request.name))
          send({ version: 3, id: frame.id, pdfBuild: true });
      } });
      if (epoch !== generation || ended || runtime !== owner) return { resultId: frame.id, result: failure(request.name !== 'browser_read') };
      if (results.size >= 128) results.delete(results.keys().next().value);
      results.set(frame.id, { runtime: owner, result, hash: hash(result) });
      return { resultId: frame.id, result };
    });
    work = operation.catch(() => {});
    operation.then(respond, () => respond({ resultId: frame.id, result: failure() })).finally(() => { queued--; });
  });
  return Object.freeze({ ready: () => send({ version: 3, session, nonce, browser }), end: fence,
    drain: () => work.catch(() => {}) });
}

// The fixed installed entry owns native UI and the approved upstream connection.
// Dependency injection is a module-only test seam; IPC cannot choose a provider,
// endpoint, package, loader, authority or executable.
export async function startInstalledV3Worker({ channel }, dependencies = {}) {
  const trace = phaseTrace(dependencies, process.ppid);
  trace('worker-entry');
  let parentLost = channel.connected === false, stopped = false, selected, ui, protocol, timer, unsubscribe;
  let accepted, connecting = false, retryConnection = false, connected = false, sequence = 0, closing, terminalLoss = false, resolveClosed, finalReceipt;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const resources = new Set();
  // Opted-in Electron apps (EPV3-7): this session's id at the resident hosts, the debugger consent, one admin
  // client per app host, qualification receipts and the latest begin frame's engine approvals.
  let appSession, appConsent, appConnected = false, turnApps = Object.freeze([]), hostSecret;
  let traceTurn = 0;
  let browserName; // the menu bar's browser line, from the operator-owned config's executable only
  let hostName; // the menu bar's host line, from the MCP client's own clientInfo (the relay's label), never guessed
  let optOutFailed = false;
  // The user's site blocks, read again when permissions.json changes, and the site turbo last worked on, for the menu's Never
  // Act on row. used(key) records a permission's last use (permissions.mjs stampUse); only the installed entry passes it.
  const sites = dependencies.sites ?? createPermissionCheck().site;
  let currentSite;
  const noteSite = origin => { if (origin === currentSite) return; currentSite = origin; try { status(); } catch {} };
  // The relay's shared host holds this session's consent channel, on fds 4 and 5.
  const sharedUi = dependencies.sharedUi ?? process.argv.includes('--shared-ui');
  const optedOut = () => { try { return (dependencies.readConfigFile ?? readInstalledConfigFile)()?.enabled === false; } catch { return false; } };
  const admins = new Map(), receipts = new Map();
  // This session's relaunch answers: an app whose relaunch card the user cancelled is not asked about again.
  const appMemory = Object.freeze({ declined: new Set() });
  // admins: bundle id -> the pending { admin, registry, profile } of that app's resident host.
  const eachAdmin = action => Promise.allSettled([...admins.values()].map(async pending => action((await pending).admin)));
  const revokeApps = () => eachAdmin(admin => appSession && admin.revoke({ session: appSession }));
  const current = () => {
    try { return !parentLost && !stopped && accepted.current() === true; } catch { return false; }
  };
  const startupCurrent = () => { if (parentLost || channel.connected === false) throw Error('PARENT_GONE');
    if (!accepted.current()) throw Error('HOST_PACKAGE_MISMATCH'); };
  const loss = () => { parentLost = true; terminalLoss = true; close().catch(() => {}); };
  channel.on('disconnect', loss);
  const retained = resource => ({ resource, status: 'retained', code: 'CLEANUP_UNPROVED' });
  async function collect(resource) {
    if (resource.collecting) return resource.collecting;
    resource.collecting = (async () => {
      const cleanup = [];
      let recording;
      if (resource.runtime) {
        const turn = await resource.runtime.end().catch(unproved);
        cleanup.push(...turn.cleanup.filter(row => row.resource !== 'owned-tabs'));
        recording = turn.recording;
      }
      let tabs = true;
      try { if (resource.pages) tabs = (await resource.pages.endTurn()).cleanedUp === true; } catch { tabs = false; }
      if (!tabs) {
        cleanup.push(retained('owned-tabs'));
        if (!terminalLoss) return { revoked: true, cleanup, ...(recording ? { recording } : {}) };
      }
      let detached = true;
      try { if (resource.filter) detached = await resource.filter.dispose() === true; } catch { detached = false; }
      if (!detached) {
        cleanup.push(retained('cdp-filter'));
        if (!terminalLoss) return { revoked: true, cleanup, ...(recording ? { recording } : {}) };
      }
      try { await resource.browser?.close(); } catch { cleanup.push(retained('playwright-connection')); }
      try { await resource.listener?.close(); } catch { cleanup.push(retained('cdp-listener')); }
      if (resource.apps) {
        // Releases control and this worker's channels. The app, its windows and the host's pipe stay.
        const { releaseAppConnection } = await import('./electron-runtime.mjs');
        for (const connection of resource.apps) cleanup.push(...await releaseAppConnection(connection));
        try { if (resource.consentTurn) appConsent?.endTurn(resource.consentTurn.session, resource.consentTurn.turn); } catch {}
        if (!cleanup.length) appConnected = false;
      }
      if (!cleanup.length) resources.delete(resource);
      return { revoked: true, cleanup, ...(recording ? { recording } : {}) };
    })().finally(() => { resource.collecting = undefined; });
    return resource.collecting;
  }
  async function close() {
    stopped = true;
    if (finalReceipt) return finalReceipt;
    if (closing) return closing;
    closing = (async () => {
      await protocol?.end().catch(unproved);
      await protocol?.drain();
      const receipts = await Promise.all([...resources].map(collect));
      const cleanup = receipts.flatMap(receipt => receipt.cleanup);
      if (!cleanup.length || terminalLoss) {
        let disconnected = !selected;
        try { if (selected) disconnected = await selected.disconnect(selected.session) === true; } catch {}
        connected = false;
        if (!disconnected) cleanup.push(retained('browser-connection'));
        // The session ends at every app host: its grants and tickets go, and each host parks the app's connection.
        if (appSession) {
          try { appConsent?.revokeSession(appSession); } catch {}
          await revokeApps();
          await eachAdmin(admin => admin.close?.());
          admins.clear(); appConnected = false;
        }
      }
      if (!cleanup.length || terminalLoss) {
        finalReceipt = { revoked: true, cleanup };
        unsubscribe?.(); (dependencies.clearSchedule ?? clearInterval)(timer); ui?.close();
        channel.off('disconnect', loss);
        if (terminalLoss && channel.connected) channel.disconnect?.();
        trace.close();
        resolveClosed(finalReceipt);
      }
      return { revoked: true, cleanup };
    })().finally(() => { closing = undefined; });
    return closing;
  }
  function status() {
    if (!ui) return;
    const state = resources.size && (parentLost || stopped) ? 'cleanup-required' : stopped ? 'paused'
      : connected || appConnected ? parentLost ? 'connected-idle' : 'connected' : 'disconnected';
    // The menu bar shows the state, the browser and the payment check beside the person's own controls. Turning turbo off
    // writes the launcher's opt-out and disconnects; only the person's click in sleight's own window sends it.
    const payments = ['always', 'never'].includes(process.env.SLEIGHT_CONFIRM_PAYMENTS) ? process.env.SLEIGHT_CONFIRM_PAYMENTS : 'ask';
    // The Ghost Hand row shows the user's hand setting (an unsafe file keeps the hand off), and its choice flips it. On the
    // shared host the hand channel adds its own row, so the status frame has none.
    let hand;
    try { hand = (dependencies.readHand ?? readHandConfig)().state === 'on' ? 'on' : 'off'; } catch { hand = 'off'; }
    const handChoices = sharedUi ? [] : [hand === 'on' ? 'hand-off' : 'hand-on'];
    // Never Act on <site>: only while connected, for the site turbo last worked on, unless it is already refused there.
    let site;
    try { site = state === 'connected' && currentSite && !sites(currentSite) ? currentSite : undefined; } catch { site = undefined; }
    const siteChoices = site ? ['block-site'] : [];
    ui.present('v3-control-' + (++sequence), { status: state, ...(browserName ? { browser: browserName } : {}), ...(hostName ? { host: hostName } : {}), payments, ...sharedUi ? {} : { hand },
      ...(site ? { site } : {}), ...(optOutFailed ? { optOut: 'failed' } : {}), ...(pluginVersion ? { version: pluginVersion } : {}) },
      // Paused has no Pause: turbo resumes when Claude next asks, through the session card.
      state === 'cleanup-required' ? ['cleanup', ...handChoices] : state === 'paused' ? ['disconnect', ...handChoices, 'turbo-off'] : ['pause', 'disconnect', ...siteChoices, ...handChoices, 'turbo-off'], async event => {
      if (ui.authenticate(event) !== true) return;
      if (event.action === 'block-site' && site) {
        // The person's click blocks the site this frame named, never one from the event. A failed write re-presents the row.
        try { await (dependencies.blockSite ?? (await import('../permissions-command.mjs')).blockSiteForUser)(site); } catch {}
        status();
      } else if (['hand-on', 'hand-off'].includes(event.action)) {
        // A failed write re-presents the row as it was. The relay's hand client sees the file change and hides at once.
        try { await (dependencies.setHand ?? setHand)(event.action === 'hand-on'); } catch {}
        status();
      } else if (event.action === 'turbo-off') {
        // A failed write leaves turbo connected and says so in the menu, so nobody believes turbo is off when it isn't.
        try { await (dependencies.turboOff ?? optOut)(); optOutFailed = false; } catch { optOutFailed = true; status(); return; }
        await close();
      } else if (['disconnect','cleanup'].includes(event.action)) await close();
      else if (event.action === 'pause') { stopped = true; await protocol?.end(); await revokeApps(); status(); }
    }, { deadline: Date.now() + 300000 });
  }
  // Which startup step is running, so a failure can say where it stopped (unavailableFrame).
  let stage = 'config';
  try {
    stage = 'clipboard-recovery';
    await (dependencies.recoverClipboard ?? recoverNativeClipboard)();
    stage = 'config';
    const config = (dependencies.readConfig ?? readInstalledConfig)();
    if (!config) throw Error('SETTING_OFF');
    stage = 'package';
    accepted = (dependencies.acceptPackage ?? acceptedInstalledPackage)(config); startupCurrent();
    try { browserName = applicationName(config.executable); } catch {}
    const host = await import('./host.mjs'); startupCurrent();
    stage = 'helpers';
    trace('helpers-check-start');
    const built = await (dependencies.prepareHelpers ?? host.prepareNativeHelpers)({ inventory: config.receipt }); startupCurrent();
    trace('helpers-check-end');
    if (built.status !== 'ready') throw Error(built.code);
    const { createSelectedConnection } = await import('./selected-connection.mjs'); startupCurrent();
    stage = 'connection-select';
    trace('connection-select-start');
    selected = await (dependencies.selectConnection ?? createSelectedConnection)({ config, nativeReceipt: built.receipt }); startupCurrent();
    trace('connection-select-end');
    stage = 'ui';
    ui = (dependencies.createUi ?? (sharedUi ? host.createSharedUi : host.createNativeUi))(built.receipt, () => { if (finalReceipt) return; terminalLoss = true; close().catch(() => {}); });
    startupCurrent();
    stage = 'serve';
    const browser = selected.selectedBrowser;
    // Which opted-in apps this turn is for: enabled in the operator's opt-in file and approved by the engine this session.
    // An unreadable or unsafe opt-in file leaves the browser path as it is.
    async function appSelections(apps) {
      if (!apps.length) return [];
      let optIns;
      try { optIns = await (dependencies.readAppOptIns ?? (await import('./electron-config.mjs')).readAppOptIns)(); }
      catch (error) { dependencies.onError?.(error); return []; }
      if (!optIns || typeof optIns.apps !== 'object' || !optIns.apps) return [];
      return Object.entries(optIns.apps).filter(([key, row]) => bundleId(key) && row?.enabled === true && apps.includes(key))
        .slice(0, 4).map(([key]) => ({ bundleId: key }));
    }
    function subscribe() {
      unsubscribe = selected.onConnectionLoss(reason => {
        try { (dependencies.traceLoss ?? traceLoss)(lossCode(reason)); } catch {}
        connected = false;
        if (!connecting && !stopped) { retryConnection = true; protocol?.end().catch(() => {}); }
      });
    }
    subscribe();
    protocol = serveV3Worker({ channel, browser: selected.selectedBrowser, current,
      async begin(message, binding, { apps = [], appSecret: secret, host } = {}) {
        const turnNo = ++traceTurn;
        if (!current() || resources.size) throw Error('CLEANUP_UNPROVED');
        if (validHostLabel(host) && host !== hostName) { hostName = host; try { status(); } catch {} }
        turnApps = Object.freeze([...apps]);
        hostSecret ??= secret;
        const selections = await appSelections(apps);
        if (!current() || resources.size) throw Error('CLEANUP_UNPROVED');
        const resource = {}; resources.add(resource);
        let preparing, ending, turnEnded = false;
        // An opted-in app the engine approved this session takes this turn's tools; Chrome is not connected.
        async function prepareApps() {
          const runtimeModule = await import('./electron-runtime.mjs');
          const { loadPlaywrightCore } = await import('./worlds.mjs');
          const playwright = (dependencies.loadPlaywright ?? loadPlaywrightCore)({ turbo: true }).inprocess.playwright;
          const app = dependencies.app ?? {};
          appSession = message.session;
          appConsent ??= await (dependencies.createConsent ?? runtimeModule.createWorkerConsent)({ ui, approvedApps: () => turnApps, dependencies: app,
            onAlwaysUsed: bundleId => dependencies.used?.('electron:' + bundleId) });
          resource.apps = []; resource.consentTurn = { session: message.session, turn: message.turn };
          for (const { bundleId } of selections) {
            if (!current() || turnEnded) throw Error('TRUSTED_TURN_REQUIRED');
            if (!admins.has(bundleId)) admins.set(bundleId, (dependencies.connectAppHost ?? runtimeModule.connectAppHost)({ bundleId, secret: hostSecret, dependencies: app }));
            let host;
            try { host = await admins.get(bundleId); } catch (error) { admins.delete(bundleId); throw error; }
            if (!current() || turnEnded) throw Error('TRUSTED_TURN_REQUIRED');
            resource.apps.push(await (dependencies.selectAppConnection ?? runtimeModule.selectAppConnection)({ bundleId, session: message.session, turn: message.turn,
              apps, ui, consent: appConsent, registry: host.registry, admin: host.admin, playwright, windows: dependencies.runWindows ?? runtimeModule.runWindowHelper,
              profile: host.profile, receipts, memory: appMemory, dependencies: app }));
          }
          if (!current() || turnEnded) throw Error('TRUSTED_TURN_REQUIRED');
          const surface = await (dependencies.createAppTurn ?? runtimeModule.createAppTurn)({ connections: resource.apps, binding, consent: appConsent, ui, dependencies: app });
          resource.pages = surface.pages; appConnected = true;
          const runtime = await createAppTurnRuntime({ surface, binding, browser: selected.selectedBrowser, ui, sites, onSite: noteSite, createRuntime: dependencies.createRuntime });
          resource.runtime = runtime;
          trace('runtime-ready');
          return runtime;
        }
        async function prepare() {
          try {
            if (selections.length) return await prepareApps();
            if (!connected) {
              connecting = true;
              try {
                if (retryConnection) {
                  unsubscribe?.();
                  selected = await (dependencies.selectConnection ?? createSelectedConnection)({ config, nativeReceipt: built.receipt });
                  if (selected.selectedBrowser !== browser) throw Error('STALE_INSTANCE');
                  subscribe(); retryConnection = false;
                }
                if (!current() || turnEnded) throw Error('TRUSTED_TURN_REQUIRED');
                trace('connection-start');
                if (await selected.connect() !== selected.session) throw Error('STALE_INSTANCE');
                connected = true;
                trace('connection-end');
              } catch (error) {
                retryConnection = await selected.disconnect(selected.session).catch(() => false) === true;
                if (!retryConnection) stopped = true;
                throw error;
              } finally { connecting = false; }
            }
            if (!current() || turnEnded) throw Error('TRUSTED_TURN_REQUIRED');
            if (!current() || !await selected.verifyConnection(selected.session)) throw Error('STALE_INSTANCE');
            const { loadPlaywrightCore } = await import('./worlds.mjs');
            const playwright = (dependencies.loadPlaywright ?? loadPlaywrightCore)({ turbo: true }).inprocess.playwright;
            resource.filter = selected.createFilter();
            resource.listener = await resource.filter.listen();
            resource.browser = await playwright.chromium.connectOverCDP(resource.listener.endpoint, { noDefaults: true, timeout: 10000 });
            if (!current() || turnEnded) throw Error('TRUSTED_TURN_REQUIRED');
            const [{ createPageRegistry }, snapshots] = await Promise.all([import('./page.mjs'),
              dependencies.snapshot ? Promise.resolve({ snapshot: dependencies.snapshot }) : import('./snapshot.mjs')]);
            const session = await resource.browser.newBrowserCDPSession();
            resource.pages = (dependencies.createPages ?? createPageRegistry)({ browser: resource.browser, session,
              endpoint: selected.endpoint, endpointBlocked: resource.filter.endpointBlocked, upstream: selected.session, ownTarget: resource.filter.own, releaseTarget: resource.filter.release, frames: resource.filter.frames });
            const runtime = await (dependencies.createRuntime ?? createV3TurnRuntime)({ binding, browser: selected.selectedBrowser, pages: resource.pages,
              snapshot: snapshots.snapshot, ui, endpoint: selected.endpoint, dependencies: {
                // Acknowledgment is coupled to the exact output identity in the
                // fork protocol. Merely taking a snapshot never admits its refs.
                acknowledgeSnapshot: snapshots.acknowledgeSnapshot, sites, onSite: noteSite, pdfInventory: config.receipt,
                tracePhase: (phase, call) => trace(phase, turnNo, call),
              } });
            resource.runtime = runtime;
            trace('runtime-ready');
            dependencies.used?.('turbo');
            return runtime;
          } catch (error) { dependencies.onError?.(error); await collect(resource); throw error; }
        }
        async function verified() {
          if (!resource.apps) return selected.verifyConnection(selected.session);
          const checks = await Promise.all(resource.apps.map(async connection => connection.grant.current() &&
            await connection.provider.verifyConnection(connection.provider.session) === true));
          return checks.every(Boolean);
        }
        return Object.freeze({
          async call(request, options) {
            if (!current() || turnEnded) return failure();
            try {
              const runtime = await (preparing ??= prepare());
              if (!current() || turnEnded || !await verified()) throw Error('STALE_INSTANCE');
              return await runtime.call(request, options);
            } catch (error) { return error?.message === 'ELECTRON_HOST_FOREIGN' ? foreignHost(error.appName) : appNotice(error) ?? failure(); }
          },
          ...(selections.length ? { waitMs: Math.min(APP_PREPARE_CAP_MS, selections.length * APP_PREPARE_WAIT_MS) } : {}),
          delivered: result => !turnEnded && resource.runtime?.delivered(result) === true,
          end() {
            turnEnded = true;
            if (!ending) ending = (async () => { await preparing?.catch(() => {}); return collect(resource); })();
            return ending;
          },
        });
      }, close });
    timer = (dependencies.schedule ?? setInterval)(() => {
      // An opt-out written since startup (another session's menu, or `sleight-mcp turbo off`) ends this session's turbo too.
      if (optedOut()) { close().catch(() => {}); return; }
      try { status(); } catch { terminalLoss = true; close().catch(() => {}); }
    }, 60000);
    status(); trace('worker-ready'); protocol.ready();
    return Object.freeze({ close, closed });
  } catch (error) {
    try { if (error && typeof error === 'object' && error.stage === undefined) error.stage = stage; } catch {}
    await close(); channel.off('disconnect', loss); throw error;
  }
}
async function installedMain() { return startInstalledV3Worker({ channel: process }, { used: key => stampUse(key) }); }

if (isMainModule(import.meta.url) && process.send) {
  installedMain().catch(error => { if (process.connected) {
    process.send(unavailableFrame(error));
    process.disconnect();
  } });
}
