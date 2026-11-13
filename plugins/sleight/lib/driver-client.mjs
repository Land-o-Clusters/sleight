import { macClientFault as macFault } from './mac-driver/client.mjs';
import { prepareWindowsHandHost } from './direct-browser/windows-host.mjs';
import { ACTION_METHODS as WINDOWS_ACTION_METHODS, validateActionParams } from './windows-driver/actions.mjs';
import { foregroundFallback } from './windows-driver/routes.mjs';
import { windowBinding as windowsBinding } from './windows-repl/identity.mjs';
import { validCheckpointTimings } from './windows-driver/checkpoint-timings.mjs';
import { windowsDiagnostics } from './windows-driver/diagnostics.mjs';
import { macFocusDiagnostics } from './repl/focus-steps.mjs';
import { randomBytes } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { prepareMacDriver } from './mac-driver/build.mjs';
import { validateSemanticArguments } from './mac-driver/semantic.mjs';
import { MAC_DRIVER_SENTENCES, MAC_DRIVER_PARAM_FIELDS, formatMacDriverError } from './mac-driver/errors.mjs';
import { DRIVER_API_VERSION, DRIVER_CODES, DRIVER_ACTION_METHODS as ACTION_METHODS, DRIVER_CORE_METHODS, DRIVER_SESSION_EXEMPT_METHODS, driverContext } from './mac-driver/protocol.mjs';
const SESSION_EXEMPT_METHODS = new Set(DRIVER_SESSION_EXEMPT_METHODS);
const MEMOIZED_BUILD_FAILURES = new Set(['APPLE_TOOLS_MISSING', 'HOST_BUILD_FAILED']);
const windowsFault = (code, message = code, unhealthy = false) => Object.assign(new Error(message), { code, unhealthy });
const windowBinding = ({ windowId, processStart }) => ({ windowId, processStart });
const validBuildHash = value => typeof value === 'string' && value.length === 64 &&
  [...value].every(character => '0123456789abcdef'.includes(character));

export const DRIVER_PROTOCOL = 'sleight.driver/1';
export const WINDOWS_DRIVER_PROTOCOL = 'sleight.windows-driver/1';
export const DRIVER_LINE_LIMIT = 64 * 1024 * 1024;

function validHookCallbacks(value, scope = 'through-next-hook') {
  if (!value || Object.keys(value).sort().join(' ') !== 'callbacks capacity maxUs omitted p50Us p99Us sampled samplesUs saturated scope' ||
      value.scope !== scope || value.capacity !== 8192 ||
      !Number.isInteger(value.callbacks) || value.callbacks < 0 || value.callbacks > 2147483647 ||
      value.sampled !== Math.min(value.callbacks, value.capacity) || value.omitted !== value.callbacks - value.sampled ||
      value.saturated !== (value.callbacks === 2147483647) || !Array.isArray(value.samplesUs) ||
      value.samplesUs.length !== value.sampled || value.samplesUs.some(n => !Number.isFinite(n) || n < 0)) return false;
  if (value.sampled === 0) return value.p50Us === null && value.p99Us === null && value.maxUs === null;
  const sorted = [...value.samplesUs].sort((a, b) => a - b);
  return value.p50Us === sorted[Math.ceil(sorted.length * 0.50) - 1] &&
    value.p99Us === sorted[Math.ceil(sorted.length * 0.99) - 1] &&
    Number.isFinite(value.maxUs) && value.maxUs >= sorted.at(-1);
}

// Construction and import are inert. A call on another platform refuses before preparation.
function parseDriverJSON(bytes) {
  const fail = () => { throw macFault('DRIVER_PROTOCOL', 'Invalid driver JSON.', true); };
  if (bytes.length > DRIVER_LINE_LIMIT) fail();
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('JSON is not UTF-8'); }
  let i = 0;
  const space = () => { while (/[\t\r\n ]/.test(source[i] ?? '\0')) i++; };
  const string = () => {
    const start = i++;
    while (i < source.length) { if (source[i++] === '"') return JSON.parse(source.slice(start, i)); if (source[i - 1] === '\\') i++; }
    fail('unterminated JSON string');
  };
  const value = depth => {
    if (depth > 128) fail('JSON nesting too deep'); space();
    if (source[i] === '"') { string(); return; }
    if (source[i] === '{') {
      i++; space(); const keys = new Set(); if (source[i] === '}') { i++; return; }
      while (i < source.length) {
        space(); if (source[i] !== '"') fail('invalid JSON key'); const key = string();
        if (keys.has(key)) fail('duplicate JSON key'); keys.add(key); space(); if (source[i++] !== ':') fail('invalid JSON colon');
        value(depth + 1); space(); const end = source[i++]; if (end === '}') return; if (end !== ',') fail('invalid JSON object');
      }
    } else if (source[i] === '[') {
      i++; space(); if (source[i] === ']') { i++; return; }
      while (i < source.length) { value(depth + 1); space(); const end = source[i++]; if (end === ']') return; if (end !== ',') fail('invalid JSON array'); }
    } else {
      const token = source.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
      if (token) { i += token[0].length; return; }
    }
    fail('invalid JSON value');
  };
  try { value(0); space(); if (i !== source.length) fail('trailing JSON data'); return JSON.parse(source); }
  catch (error) { throw error; }
}

const focusFaults = new Set(macFocusDiagnostics());

// Only fixed focus fields cross stderr, never arbitrary helper output or text.
function focusDiagnostic(line) {
  try {
    const record = JSON.parse(line);
    if (record?.event !== 'keyboard-belief' || typeof record.beliefCleared !== 'boolean') return;
    const safe = { event: record.event, beliefCleared: record.beliefCleared };
    for (const key of ['fakeActiveMs', 'elapsedMs', 'guardMs', 'snapshotMs', 'beliefMs', 'restoreMs']) {
      if (!Number.isFinite(record[key]) || record[key] < 0 || record[key] > 600000) return;
      safe[key] = record[key];
    }
    for (const key of ['checkMs', 'identityMs', 'preflightMs', 'cleanupMs',
      'estimatedKeyMs', 'projectedMs', 'cleanupReserveMs', 'finalGuardMs']) {
      if (record[key] === undefined) continue;
      if (!Number.isFinite(record[key]) || record[key] < 0 || record[key] > 600000) return;
      safe[key] = record[key];
    }
    for (const key of ['guardCount', 'strokePosts']) {
      if (record[key] === undefined) continue;
      if (!Number.isSafeInteger(record[key]) || record[key] < 0 || record[key] > 600000) return;
      safe[key] = record[key];
    }
    if (record.yielded !== undefined) {
      if (typeof record.yielded !== 'boolean') return;
      safe.yielded = record.yielded;
    }
    if (record.fault !== undefined) {
      if (!focusFaults.has(record.fault)) return;
      safe.fault = record.fault;
    }
    return 'sleight: focus belief: ' + JSON.stringify(safe);
  } catch {}
}

// Only renderer metadata crosses this parser. Never forward arbitrary output.
function rendererDiagnostic(line) {
  if (line === 'sleight: renderer recovery state unavailable; activation disabled.') return line;
  const match = /^sleight: renderer recovery(?: pending)?: (.+)$/.exec(line);
  if (!match) return;
  try {
    const report = JSON.parse(match[1]), safe = {};
    for (const key of ['restored', 'skipped', 'quarantined', 'pruned', 'failed']) {
      if (!Number.isSafeInteger(report[key]) || report[key] < 0) return;
      safe[key] = report[key];
    }
    for (const key of ['retained', 'reasonSaveFailed']) {
      if (report[key] === undefined) continue;
      if (!Number.isSafeInteger(report[key]) || report[key] < 0) return;
      safe[key] = report[key];
    }
    if (typeof report.complete !== 'boolean' || !Array.isArray(report.remaining)) return;
    safe.complete = report.complete;
    for (const key of ['remaining', 'dropped']) {
      if (report[key] === undefined && key === 'dropped') continue;
      if (!Array.isArray(report[key])) return;
      safe[key] = report[key].slice(0, 32).map(row => {
        if (!Number.isInteger(row.pid) || row.pid < 1 || row.pid > 2147483647 ||
            typeof row.processStart !== 'string' || row.processStart.length > 64 ||
            !/^[0-9]+[.][0-9]+$/.test(row.processStart) || /[\r\n]/.test(row.processStart) ||
            typeof row.bundleId !== 'string' || !/^[A-Za-z0-9._+-]{1,255}$/.test(row.bundleId) || /[\r\n]/.test(row.bundleId) ||
            !['AXManualAccessibility', 'AXEnhancedUserInterface'].includes(row.attribute) ||
            !['deadline', 'remove-failed', 'process-unavailable', 'restore-failed', 'already-restored', 'attribute-not-enabled',
              'assistive-technology-running', 'value-changed-since', 'identity-changed', 'lease-unavailable', 'recovery-disabled'].includes(row.reason) &&
            !Object.hasOwn(DRIVER_CODES, row.reason)) throw Error('INVALID_DIAGNOSTIC');
        return Object.fromEntries(['pid', 'processStart', 'bundleId', 'attribute', 'reason'].map(name => [name, row[name]]));
      });
    }
    return 'sleight: renderer recovery: ' + JSON.stringify(safe);
  } catch { return; }
}

// Read identities are protocol fields only at the result/parameter root. Bound
// the walk independently of JSON depth so future compound shapes fail closed.
function hasNestedReadIdentity(root) {
  const pending = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (++nodes > 50000) return true;
    for (const [key, child] of Object.entries(value)) {
      if (pending.length >= 50000) return true;
      if (depth > 0 && (key === 'readId' || key === 'afterReadId')) return true;
      if (child && typeof child === 'object') pending.push({ value: child, depth: depth + 1 });
    }
  }
  return false;
}

export function createDriverClient({ driverPlatform = process.platform, platform = process.platform,
  prepare = driverPlatform === 'win32' ? prepareWindowsHandHost : prepareMacDriver,
  hostOptions = {}, timeoutMs = 5000, lineLimit = DRIVER_LINE_LIMIT,
  diagnostics = message => process.stderr.write(message + '\n'),
  minimumApiVersion = DRIVER_API_VERSION, requiredMethods = DRIVER_CORE_METHODS, driveLocked = false, failureMemoMs = 300000,
  turnEndIdleMs = driverPlatform === 'darwin' && process.env.SLEIGHT_HELPER_TURN_END_EXIT === '1' ? 60000 : 0,
  actionEvents, stopControl, checkpointTimings = false } = {}) {
  const mac = driverPlatform === 'darwin';
  const protocol = mac ? DRIVER_PROTOCOL : WINDOWS_DRIVER_PROTOCOL;
  const methods = mac ? ACTION_METHODS : WINDOWS_ACTION_METHODS;
  const fault = mac ? macFault : windowsFault;
  if (!['darwin', 'win32'].includes(driverPlatform)) throw fault('PLATFORM');
  if (typeof checkpointTimings !== 'boolean' || mac && checkpointTimings) throw fault('INVALID_PARAMS');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 ||
      !Number.isInteger(lineLimit) || lineLimit < 1 || lineLimit > DRIVER_LINE_LIMIT || mac && (
      !Number.isInteger(minimumApiVersion) || minimumApiVersion < 1 || !Array.isArray(requiredMethods) ||
      requiredMethods.some(method => typeof method !== 'string' || !method) || typeof driveLocked !== 'boolean' ||
      !Number.isInteger(failureMemoMs) || failureMemoMs < 1 || failureMemoMs > 3600000 ||
      !Number.isInteger(turnEndIdleMs) || turnEndIdleMs < 0 || turnEndIdleMs > 3600000)) throw fault('INVALID_PARAMS');
  let generation, starting, retiring = Promise.resolve(), disposed = false;
  let cancelEpoch = 0, windowsRetirement, windowsTurn = 1, windowsTurnLost = false;
  const pending = new Map(), retireListeners = new Set();
  let unavailable, retirementFailure, userStopped = false, activeStop, stopAfterSuccess = false;
  // Native read counters restart at 1. The public range never overlaps an
  // earlier incarnation, including helpers retired without returning a read.
  let readCeiling = 0;
  let idleTimer, idleDeadline, idleBoundary, activeRequests = 0;
  const cancelIdleExit = () => { clearTimeout(idleTimer); idleTimer = undefined; idleDeadline = undefined; idleBoundary = undefined; };
  function scheduleIdleExit() {
    if (!mac || !turnEndIdleMs || idleDeadline === undefined || idleBoundary?.ready === false || activeRequests || starting || disposed || !generation) return;
    clearTimeout(idleTimer);
    const g = generation;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (idleBoundary?.ready === false || activeRequests || starting || generation !== g || idleDeadline === undefined) return;
      stop(g, fault('DRIVER_RESTARTED'));
    }, Math.max(0, idleDeadline - Date.now()));
    idleTimer.unref?.();
  }
  const cancelledBeforeSend = method => Object.assign(fault('USER_STOPPED'), {
    reason: 'cancel', delivery: 'not-sent', retry: 'safe',
    ...['typeText', 'paste'].includes(method) ? { typed: 0 } : {},
  });
  const stoppedInput = () => Object.assign(fault('USER_STOPPED', MAC_DRIVER_SENTENCES.USER_STOPPED),
    { delivery: 'not-sent', retry: 'safe', next: 'stop-tell-user' });
  const stoppedRetired = g => Object.assign(stoppedInput(), { unhealthy: true, delivery: 'unknown', retry: 'read-first',
    stopHelperRetired: true, stopRelease: g?.stopRelease ?? 'unconfirmed' });
  function sendStopControl(g, name, call) {
    if (!g || g.stopped || disposed) return;
    if (name === 'stop' || name === 'release') g.stopRelease = undefined;
    try { g.child.stdin.write(JSON.stringify({ protocol, platform: 'darwin', nonce: g.nonce,
      control: name, ...call !== undefined ? { call } : {} }) + '\n'); }
    catch { stop(g, fault('DRIVER_IO', undefined, true)); }
  }
  function personStop(operation) {
    if (!operation.live || activeStop !== operation || operation.stopRequested) return;
    operation.stopRequested = true;
    userStopped = true;
    if (operation.completed) { stopAfterSuccess = true; return; }
    if (!operation.stopTimer) operation.stopTimer = setTimeout(() => {
      const error = stoppedRetired(operation.g);
      stop(operation.g, error, 'SIGKILL');
    }, 500); // Stop release backstop
    if (operation.id !== undefined) sendStopControl(operation.g, 'stop', operation.id);
  }
  function stop(g, error, signal) {
    if (!g || g.stopped) return;
    // A reset or failed peer may have unreported physical Escape evidence.
    // Keep input closed until the trusted parent ends this logical turn.
    if (!mac && g.turn === windowsTurn) windowsTurnLost = true;
    g.stopped = true;
    if (generation === g) {
      generation = undefined; cancelIdleExit();
      // Retained read IDs and element maps belong to this helper incarnation.
      for (const listener of retireListeners) {
        try { listener(error); }
        catch { retirementFailure ??= Object.assign(fault('DRIVER_UNHEALTHY', undefined, true), { delivery: 'not-sent', retry: 'safe' }); }
      }
    }
    for (const [id, call] of pending) if (call.g === g) {
      clearTimeout(call.timer); pending.delete(id);
      call.reject(mac && call.action && error.delivery === undefined
        ? Object.assign(fault(error.code, error.message, error.unhealthy), error, { delivery: 'unknown', retry: 'read-first' }) : error);
    }
    g.parts = []; g.bytes = 0;
    try { g.actionWire?.close(); g.geometryWire?.close(); } catch {}
    // The handle belongs to this client; never signal a PID found through inventory.
    if (!g.closed) {
      retiring = g.closedPromise; g.child.kill(signal);
      if (mac) {
        g.killTimer = setTimeout(() => { if (!g.closed) g.child.kill('SIGKILL'); }, 1000);
        g.killTimer.unref?.();
      }
    }
  }
  async function waitForRetirement() {
    if (!mac) return retiring;
    let timer;
    try { await Promise.race([retiring, new Promise((_, reject) => { timer = setTimeout(() => reject(fault('DRIVER_RETIRE_TIMEOUT', undefined, true)), 3000); })]); }
    finally { clearTimeout(timer); }
  }
  function response(g, bytes) {
    let value;
    try { value = mac ? parseDriverJSON(bytes) : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
      return stop(g, fault('DRIVER_PROTOCOL', 'Invalid driver response.', true));
    }
    if (mac && ['released', 'released-posted'].includes(value?.control)) {
      if (value.protocol !== protocol || value.platform !== 'darwin' || value.nonce !== g.nonce ||
          Object.keys(value).sort().join() !== (value.control === 'released-posted' ? 'control,nonce,platform,protocol,release,token' : 'control,nonce,platform,protocol,release') ||
          !['posted', 'unconfirmed'].includes(value.release)) return stop(g, fault('DRIVER_PROTOCOL', undefined, true));
      if (value.control === 'released-posted') {
        if (g.postedRelease?.token === value.token) { g.postedRelease.resolve(value.release); g.postedRelease = undefined; }
      }
      else g.stopRelease = value.release;
      return;
    }
    const call = pending.get(value?.id);
    if (mac && value?.checkpoint !== undefined) {
      if (Object.keys(value).sort().join(' ') !== 'checkpoint id nonce platform protocol' ||
          value.protocol !== protocol || value.platform !== 'darwin' || value.nonce !== g.nonce ||
          value.checkpoint !== 'person-wait' || !call || call.g !== g || !call.action || call.checkpoint)
        return stop(g, fault('DRIVER_PROTOCOL', 'Invalid admission checkpoint.', true));
      call.checkpoint = true;
      Promise.resolve().then(async () => {
        if (call.cancelled || typeof call.beforeInput !== 'function') throw fault('PERSON_TOOK_OVER');
        await call.beforeInput();
      }).then(() => {
        if (pending.get(value.id) === call) control(g, value.id, call.cancelled ? 'deny' : 'allow');
      }, error => {
        call.guardFailure = error;
        if (pending.get(value.id) === call) control(g, value.id, 'deny');
      });
      return;
    }
    if (!mac) {
      const lateCancel = g.lateCancels.has(value?.id);
      const keys = value && typeof value === 'object' ? Object.keys(value).sort().join(' ') : '';
      if (value?.protocol !== protocol || value.nonce !== g.nonce || (!call || call.g !== g) && !lateCancel ||
          typeof value.ok !== 'boolean' || keys !== (value.ok ? 'id nonce ok protocol result' : 'error id nonce ok protocol') ||
          !value.ok && (typeof value.error?.code !== 'string' || typeof value.error?.message !== 'string' ||
            typeof value.error?.unhealthy !== 'boolean' || 'pointerRefusal' in value.error || 'pasteRefusal' in value.error)) return stop(g, fault('DRIVER_PROTOCOL', 'Invalid driver envelope.', true));
      if (!value.ok) {
        const error = value.error;
        if (('delivery' in error || 'retry' in error) &&
            (!['not-sent', 'sent-unverified', 'sent-verified', 'unknown'].includes(error.delivery) ||
              error.retry !== (error.delivery === 'not-sent' && error.code !== 'CLIPBOARD_CHANGED' ? 'safe' : 'read-first')) ||
            'reason' in error && (typeof error.reason !== 'string' || !/^[a-z][a-z-]{0,79}$/.test(error.reason)) ||
            'typed' in error && (!Number.isSafeInteger(error.typed) || error.typed < 0) ||
            'personTookOver' in error && typeof error.personTookOver !== 'boolean' ||
            'limits' in error && (!Array.isArray(error.limits) || error.limits.length > 64 ||
              error.limits.some(limit => typeof limit !== 'string' || limit.length > 256 || /[\x00-\x1f\x7f]/.test(limit))))
          return stop(g, fault('DRIVER_PROTOCOL', 'Invalid driver error disposition.', true));
      }
      const report = value.ok ? value.result : value.error;
      // Malformed optional telemetry is dropped, without changing the verdict.
      const diagnostic = windowsDiagnostics(report);
      if (report && typeof report === 'object') {
        delete report.lifecycleEvents; delete report.identityChecks;
        Object.assign(report, diagnostic);
      }
      if (report && (Object.hasOwn(report, 'escapeStops') && (!Number.isSafeInteger(report.escapeStops) || report.escapeStops < 0) ||
          Object.hasOwn(report, 'counters') && (!report.counters || typeof report.counters !== 'object' || Array.isArray(report.counters) ||
            Object.keys(report.counters).sort().join(' ') !== 'captures finalReads patternCalls postedMessages uiaFetches' ||
            Object.values(report.counters).some(n => !Number.isSafeInteger(n) || n < 0))))
        return stop(g, fault('DRIVER_PROTOCOL', 'Invalid driver operation counts.', true));
      if (call?.method === 'cancel' || lateCancel) {
        const target = call?.cancelTarget ?? g.lateCancels.get(value.id);
        if (value.ok && (value.result?.cancelled !== target || typeof value.result?.inFlight !== 'boolean'))
          return stop(g, fault('DRIVER_PROTOCOL', 'Invalid cancel response.', true));
        if (lateCancel) { g.lateCancels.delete(value.id); return; }
      }
      if (['turn-start', 'turn-end'].includes(call?.method) && value.ok && (
          Object.keys(value.result ?? {}).filter(key => ['lifecycleEvents', 'identityChecks'].includes(key) || call.method === 'turn-end' && key === 'escapeStops' ? false : checkpointTimings && call.method === 'turn-end' &&
            ['checkpointTimings', 'checkpointTimingSamples'].includes(key) ? false : true).sort().join(' ') !== (call.method === 'turn-end' &&
            Object.hasOwn(value.result ?? {}, 'hookCallbacks') ?
              (Object.hasOwn(value.result, 'hookOwnCallbacks') ? 'active hookCallbacks hookOwnCallbacks turn' : 'active hookCallbacks turn') : 'active turn') ||
          value.result.turn !== call.turn || value.result.active !== (call.method === 'turn-start')))
        return stop(g, fault('DRIVER_PROTOCOL', 'Invalid turn response.', true));
      if (call?.method === 'turn-end' && value.ok && Object.hasOwn(value.result, 'hookCallbacks') &&
          !validHookCallbacks(value.result.hookCallbacks))
        return stop(g, fault('DRIVER_PROTOCOL', 'Invalid hook callback samples.', true));
      if (call?.method === 'turn-end' && value.ok && Object.hasOwn(value.result, 'hookOwnCallbacks') &&
          (!validHookCallbacks(value.result.hookOwnCallbacks, 'before-next-hook') ||
            value.result.hookOwnCallbacks.callbacks !== value.result.hookCallbacks.callbacks ||
            value.result.hookOwnCallbacks.maxUs > value.result.hookCallbacks.maxUs ||
            value.result.hookOwnCallbacks.samplesUs.some((n, i) => n > value.result.hookCallbacks.samplesUs[i])))
        return stop(g, fault('DRIVER_PROTOCOL', 'Invalid own hook callback samples.', true));
      if (value.ok && (Object.hasOwn(value.result ?? {}, 'checkpointTimings') || Object.hasOwn(value.result ?? {}, 'checkpointTimingSamples')) &&
          (!checkpointTimings || ['ping', 'cancel', 'turn-start'].includes(call?.method) || !validCheckpointTimings(value.result)))
        return stop(g, fault('DRIVER_PROTOCOL', 'Invalid checkpoint samples.', true));
      clearTimeout(call.timer); pending.delete(value.id);
      if (value.ok) call.resolve(value.result);
      else {
        const error = Object.assign(fault(value.error.code, value.error.message, value.error.unhealthy),
          Object.fromEntries(['delivery', 'retry', 'reason', 'typed', 'personTookOver', 'limits', 'escapeStops', 'counters']
            .filter(key => Object.hasOwn(value.error, key)).map(key => [key, value.error[key]])), diagnostic);
        if (error.reason === 'hook-unhook-exhausted') error.unhealthy = true;
        call.reject(error);
        if (error.unhealthy) stop(g, error);
      }
      return;
    }
    const keys = value && typeof value === 'object' ? Object.keys(value).filter(key => key !== 'context').sort().join(' ') : '';
    const contextOK = value?.ok ? !Object.hasOwn(value, 'context') :
      (value?.context === undefined && call?.context === undefined || value?.context && call?.context &&
        Object.keys(value.context).length === Object.keys(call.context).length &&
        Object.keys(value.context).every(key => value.context[key] === call.context[key]));
    if (value?.protocol !== DRIVER_PROTOCOL || value.platform !== 'darwin' || value.nonce !== g.nonce || !call || call.g !== g ||
        !contextOK || typeof value.ok !== 'boolean' || keys !== (value.ok ? 'id nonce ok platform protocol result' : 'error id nonce ok platform protocol') ||
        !value.ok && (typeof value.error?.code !== 'string' || typeof value.error?.message !== 'string' ||
          typeof value.error?.unhealthy !== 'boolean' || !Object.hasOwn(DRIVER_CODES, value.error?.code ?? '') ||
          value.error.next !== DRIVER_CODES[value.error.code]?.next)) return stop(g, fault('DRIVER_PROTOCOL', 'Invalid driver envelope.', true));
    if (value.ok && (!value.result || typeof value.result !== 'object' || Array.isArray(value.result))) return stop(g, fault('DRIVER_PROTOCOL', undefined, true));
    const cap = value.ok ? value.result?.personWaitCapMs : value.error?.personWaitCapMs;
    if (cap !== undefined && (!Number.isSafeInteger(cap) || cap < 0 || cap > 8000))
      return stop(g, fault('DRIVER_PROTOCOL', 'Invalid person wait cap.', true));
    const personWait = value.ok ? value.result?.waitedForPersonMs : value.error?.waitedForPersonMs;
    if (personWait !== undefined && (!Number.isSafeInteger(personWait) || personWait < 0 || personWait > 30000))
      return stop(g, fault('DRIVER_PROTOCOL', 'Invalid person wait receipt.', true));
    if (value.ok && 'clipboardChanged' in value.result &&
        (typeof value.result.clipboardChanged !== 'boolean' || value.result.clipboardChanged &&
          (!['not-sent', 'sent-unverified', 'sent-verified', 'unknown'].includes(value.result.delivery) ||
            value.result.retry !== (value.result.delivery === 'not-sent' ? 'safe' : 'read-first')))) {
      return stop(g, fault('DRIVER_PROTOCOL', 'Invalid clipboard change result.', true));
    }
    if (!value.ok) {
      const error = value.error, hasDisposition = 'delivery' in error || 'retry' in error;
      if ('field' in error && (error.code !== 'INVALID_PARAMS' || !MAC_DRIVER_PARAM_FIELDS.includes(error.field)))
        return stop(g, fault('DRIVER_PROTOCOL', 'Invalid parameter diagnostic.', true));
      if (DRIVER_CODES[error.code].unhealthy && !error.unhealthy || (hasDisposition || call.action) &&
          (!['not-sent', 'sent-unverified', 'sent-verified', 'unknown'].includes(error.delivery) ||
            error.retry !== (error.delivery === 'not-sent' && error.code !== 'CLIPBOARD_CHANGED' ? 'safe' : 'read-first')) ||
          'clipboardChanged' in error && typeof error.clipboardChanged !== 'boolean' ||
          'personTookOver' in error && typeof error.personTookOver !== 'boolean' ||
          'targetRole' in error && !(error.code === 'TARGET_CHANGED' && error.delivery === 'not-sent' &&
            ['button', 'container', 'sheet', 'dialog', 'other'].includes(error.targetRole)) ||
          'clipboard' in error && error.clipboard !== 'untouched' ||
          'textInput' in error && !(error.code === 'ACTION_UNSUPPORTED' && ['unsupported', 'unsupported-controls'].includes(error.textInput) && error.delivery === 'not-sent' && error.retry === 'safe') ||
          'pointerRefusal' in error && !(error.code === 'ACTION_UNSUPPORTED' && error.pointerRefusal === 'incomplete-ancestry' && error.delivery === 'not-sent' && error.retry === 'safe') ||
          'menuRefusal' in error && !(error.code === 'ACTION_UNSUPPORTED' && ['menu-compound', 'not-requested', 'person-popup'].includes(error.menuRefusal) && error.delivery === 'not-sent' && error.retry === 'safe') ||
          'pasteRefusal' in error && !(call.method === 'paste' && error.code === 'AX_UNAVAILABLE' && error.pasteRefusal === 'busy' && error.delivery === 'not-sent' && error.retry === 'safe' && error.unhealthy === false) ||
          'fakeActiveMs' in error && (!Number.isFinite(error.fakeActiveMs) || error.fakeActiveMs < 0) ||
          ['focusChanged', 'focusRestored', 'compositionBypassed', 'textBeliefFallback'].some(key => key in error && typeof error[key] !== 'boolean') ||
          'charactersPosted' in error && (!Number.isSafeInteger(error.charactersPosted) || error.charactersPosted < 0) ||
          'charactersDelivered' in error && (!Number.isSafeInteger(error.charactersDelivered) || error.charactersDelivered < 0)) return stop(g, fault('DRIVER_PROTOCOL', 'Invalid driver error disposition.', true));
      if ('stopRelease' in error && !(error.code === 'USER_STOPPED' && ['posted', 'unconfirmed'].includes(error.stopRelease)))
        return stop(g, fault('DRIVER_PROTOCOL', undefined, true));
      if ('matchCount' in error && (error.code !== 'AMBIGUOUS_ELEMENT' || !Number.isSafeInteger(error.matchCount) ||
          error.matchCount < 2 || error.matchCount > 1_048_576)) return stop(g, fault('DRIVER_PROTOCOL', 'Invalid semantic match count.', true));
    }
    if (value.ok && hasNestedReadIdentity(value.result))
      return stop(g, fault('DRIVER_PROTOCOL', 'Nested read identity in driver result.', true));
    if (value.ok && Object.hasOwn(value.result, 'readId')) {
      const nativeRead = value.result.readId, publicRead = g.readBase + nativeRead;
      if (!Number.isSafeInteger(nativeRead) || nativeRead < 1 || !Number.isSafeInteger(publicRead))
        return stop(g, fault('DRIVER_PROTOCOL', undefined, true));
      readCeiling = Math.max(readCeiling, publicRead);
      value.result.readId = publicRead;
    }
    clearTimeout(call.timer); pending.delete(value.id);
    g.geometryWire?.finish(value.id);
    if (call.guardFailure) {
      const result = value.ok ? value.result : value.error;
      call.reject(Object.assign(call.guardFailure, {
        delivery: result.delivery ?? 'unknown', retry: result.retry ?? 'read-first',
        ...result.timing ? { timing: result.timing } : {},
        ...result.waitedForPersonMs !== undefined ? { waitedForPersonMs: result.waitedForPersonMs } : {},
        ...result.personWaitCapMs !== undefined ? { personWaitCapMs: result.personWaitCapMs } : {},
      }));
      if (!value.ok && value.error.unhealthy) stop(g, fault(value.error.code, undefined, true));
      return;
    }
    if (call.operation && value.ok) call.operation.completed = true;
    if (value.ok && value.result.clipboardChanged === true) {
      const result = value.result;
      const error = Object.assign(fault('CLIPBOARD_CHANGED', MAC_DRIVER_SENTENCES.CLIPBOARD_CHANGED, result.unhealthy === true),
        { delivery: result.delivery, retry: 'read-first', clipboardChanged: true },
        Object.fromEntries(['timing', 'menuFallbackCount', 'charactersDelivered', 'charactersPosted', 'focusChanged', 'focusRestored', 'compositionBypassed', 'textBeliefFallback', 'personTookOver', 'waitedForPersonMs', 'personWaitCapMs', 'step'].filter(key => Object.hasOwn(result, key)).map(key => [key, result[key]])));
      if (call.context) error.context = call.context;
      call.reject(error);
      if (error.unhealthy) stop(g, error);
      return;
    }
    if (value.ok) {
      // Reuse the existing conditional sentence, with no new prompt wording.
      if (value.result.delivery === 'sent-unverified' &&
          (value.result.observation === 'unavailable' || ['setValue', 'performSecondaryAction', 'paste'].includes(call.method) || call.method === 'click' && value.result.semanticPress === true)) {
        value.result.note = MAC_DRIVER_SENTENCES.ACTION_UNCONFIRMED;
      }
      call.resolve(value.result);
      if (value.result.unhealthy === true) stop(g, fault('DRIVER_UNHEALTHY', undefined, true));
    }
    else {
      // The closed helper table has no contention code. Only the validated
      // typed refusal selects this local code, never provider diagnostics.
      const busy = value.error.pasteRefusal === 'busy';
      const changed = value.error.clipboardChanged === true && value.error.code !== 'USER_STOPPED';
      const error = Object.assign(fault(changed ? 'CLIPBOARD_CHANGED' : busy ? 'DRIVER_BUSY' : value.error.code,
        changed ? MAC_DRIVER_SENTENCES.CLIPBOARD_CHANGED : busy ? undefined : value.error.message, value.error.unhealthy),
        Object.fromEntries(['field', 'timing', 'next', 'context', 'delivery', 'retry', 'personTookOver', 'targetRole', 'waitedForPersonMs', 'personWaitCapMs', 'fakeActiveMs', 'charactersDelivered', 'charactersPosted', 'focusChanged', 'focusRestored', 'compositionBypassed', 'textBeliefFallback', 'matchCount', 'clipboard', 'textInput', 'menuRefusal', 'pointerRefusal', 'clipboardChanged', 'menuFallbackCount', 'step', 'stopRelease'].filter(key => Object.hasOwn(value.error, key)).map(key => [key, value.error[key]])),
        value.error.reason === 'person-pointer' ? { reason: 'person-pointer' } : {});
      if (changed) { error.next = DRIVER_CODES.CLIPBOARD_CHANGED.next; error.retry = 'read-first'; delete error.clipboard; delete error.textInput; delete error.pointerRefusal; delete error.menuRefusal; delete error.targetRole; }
      if (value.context) error.context = value.context;
      call.reject(error);
      if (error.unhealthy) stop(g, error);
    }
  }
  function data(g, chunk) {
    if (g.stopped) return;
    const bytes = Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length && !g.stopped) {
      const lf = bytes.indexOf(10, start), end = lf < 0 ? bytes.length : lf;
      const part = bytes.subarray(start, end);
      if (g.bytes + part.length > lineLimit) return stop(g, fault('DRIVER_LINE_LIMIT', undefined, true));
      g.parts.push(part); g.bytes += part.length;
      if (lf < 0) break;
      const line = Buffer.concat(g.parts, g.bytes); g.parts = []; g.bytes = 0;
      response(g, line); start = lf + 1;
    }
  }
  async function start() {
    if (disposed) throw fault('DRIVER_CLOSED');
    if (retirementFailure) throw Object.assign(fault(retirementFailure.code, undefined, true), retirementFailure);
    if (platform !== driverPlatform) throw fault('PLATFORM');
    if (generation && !generation.stopped) { if (mac) await generation.ready; return generation; }
    if (mac && unavailable && Date.now() < unavailable.until) throw unavailable.error;
    if (starting) return starting;
    starting = (async () => {
      await waitForRetirement();
      if (disposed) throw fault('DRIVER_CLOSED');
      if (retirementFailure) throw Object.assign(fault(retirementFailure.code, undefined, true), retirementFailure);
      let host;
      try {
        host = await prepare({ ...hostOptions, platform, ...!mac ? { kind: 'driver' } : {} });
        if (!mac && disposed) throw fault('DRIVER_CLOSED');
        if (host.status !== 'ready') throw fault(host.code ?? 'DRIVER_UNAVAILABLE');
      } catch (cause) {
        if (!mac) throw cause;
        // Keep build diagnostics private while retaining transient retry policy.
        const error = fault('DRIVER_UNAVAILABLE');
        // Busy locks, unsafe banks and cancelled builds can recover immediately.
        const compileFailed = cause.code === 'NATIVE_HELPERS_UNAVAILABLE' && host?.detail?.stage === 'compile' &&
          host.detail.errorCode !== 'ABORT_ERR';
        if (MEMOIZED_BUILD_FAILURES.has(cause.code) || compileFailed) unavailable = { error, until: Date.now() + failureMemoMs };
        throw error;
      }
      if (disposed) throw fault('DRIVER_CLOSED');
      const nonce = randomBytes(32).toString('hex'), child = host.spawn({ nonce, ...mac && actionEvents?.enabled ? { actionEvents: true } : {}, ...mac && actionEvents?.geometryEnabled ? { geometryEvents: true } : {} });
      const g = { child, nonce, token: Symbol(), next: 0, parts: [], bytes: 0, stopped: false, closed: false, readBase: readCeiling,
        ...!mac ? { lateCancels: new Map() } : {} };
      try { if (mac && child.stdio?.[3]) g.actionWire = actionEvents?.wire({ nonce, stream: child.stdio[3] }); } catch {}
      try { if (mac && child.stdio?.[4]) g.geometryWire = actionEvents?.geometryWire({ nonce, stream: child.stdio[4] }); } catch {}
      g.closedPromise = new Promise(resolve => child.once('close', () => {
        g.closed = true; clearTimeout(g.killTimer); resolve(); stop(g, fault(g.bytes ? 'DRIVER_PROTOCOL' : 'DRIVER_EXIT', undefined, true));
      }));
      generation = g;
      child.stdout.on('data', chunk => data(g, chunk));
      child.stdout.once('error', () => stop(g, fault('DRIVER_IO', undefined, true)));
      child.stdout.once('end', () => stop(g, fault(g.bytes ? 'DRIVER_PROTOCOL' : 'DRIVER_EXIT', undefined, true)));
      if (mac) {
        // Bound partial lines and output count while continuously draining stderr.
        let diagnostic = '', oversized = false, diagnosticCount = 0;
        const emitDiagnostic = () => {
          const message = !oversized && diagnosticCount < 64 && (focusDiagnostic(diagnostic) ?? rendererDiagnostic(diagnostic));
          diagnostic = ''; oversized = false;
          if (message) { diagnosticCount++; try { diagnostics(message); } catch {} }
        };
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', chunk => {
          for (const piece of String(chunk).split(/(?<=\n)/)) {
            if (!oversized) {
              if (diagnostic.length + piece.length > 65536) { diagnostic = ''; oversized = true; }
              else diagnostic += piece.replace(/\n$/, '');
            }
            if (piece.endsWith('\n')) emitDiagnostic();
          }
        });
        child.stderr?.once('end', emitDiagnostic);
      } else child.stderr?.resume();
      child.stderr?.once('error', () => stop(g, fault('DRIVER_IO', undefined, true)));
      child.once('error', () => stop(g, fault('DRIVER_IO', undefined, true)));
      child.stdin.on('error', () => stop(g, fault('DRIVER_IO', undefined, true)));
      if (mac) g.ready = (async () => {
        const hello = await send(g, 'ping', {}, timeoutMs);
        if (hello.protocol !== DRIVER_PROTOCOL || !Number.isInteger(hello.apiVersion) || hello.apiVersion < minimumApiVersion ||
            !/^[a-f0-9]{64}$/.test(hello.build ?? '') || host.build && hello.build !== host.build ||
            !Array.isArray(hello.methods) || requiredMethods.some(method => !hello.methods.includes(method))) {
          const error = fault('DRIVER_VERSION_MISMATCH', 'Driver version or methods do not match this client.', true);
          stop(g, error); throw error;
        }
        g.methods = Object.freeze([...hello.methods]);
        // This generation spoke the verified handshake. Its binary identity
        // comes from the validated launch receipt, never a benchmark preflight.
        if (validBuildHash(host.binarySha256)) g.runtimeReceipt = {
          driverVersion: String(hello.apiVersion), driverSourceBuild: hello.build, driverBuild: host.binarySha256,
          ping: { protocol: hello.protocol, apiVersion: hello.apiVersion, build: hello.build },
        };
      })();
      if (mac) await g.ready;
      return g;
    })();
    try { return await starting; } finally { starting = undefined; }
  }
  function request(method, params = {}, options = {}) {
    if (!mac) return requestNative(method, params, options);
    // A pending barrier belongs to the ending turn's cells and cleanup. New
    // cells call beginTurn first; their requests still cancel the deadline.
    if (idleBoundary?.ready !== false) cancelIdleExit();
    activeRequests++;
    const run = () => requestNative(method, params, options);
    const finished = () => { activeRequests--; scheduleIdleExit(); };
    try {
      const result = actionEvents ? actionEvents.run(method, params, options?.context, run) : run();
      return Promise.resolve(result).finally(finished);
    } catch (error) { finished(); throw error; }
  }
  async function requestNative(method, params = {}, { timeoutMs: budget = timeoutMs, context, beforeInput, checkActive } = {}) {
    if (typeof method !== 'string' || !method || !params || Array.isArray(params) || typeof params !== 'object' ||
        !Number.isInteger(budget) || budget < 1 || budget > 30000) throw fault('INVALID_PARAMS');
    // Private lifecycle frames have no request/worker entry point.
    if (!mac && ['turn-start', 'turn-end'].includes(method)) throw fault('METHOD_NOT_FOUND');
    if (!mac && Object.hasOwn(params, 'checkpointTimings')) throw fault('INVALID_PARAMS');
    if (!mac && method === 'cancel' && (Object.keys(params).join(' ') !== 'id' ||
        !Number.isSafeInteger(params.id) || params.id < 1)) throw fault('INVALID_PARAMS');
    if (mac) {
      if (beforeInput !== undefined && typeof beforeInput !== 'function' || checkActive !== undefined && typeof checkActive !== 'function') throw fault('INVALID_PARAMS');
      context = driverContext(context);
      if (Object.hasOwn(params, 'allowLocked')) throw fault('INVALID_PARAMS');
      validateSemanticArguments(method, params.args);
      // Only the owner policy supplied at client construction can add this field.
      // A raw/model request has no route to override the policy.
      const allowed = ['windowId', 'processStart', 'readId', 'target', 'selector', 'launch', 'depth', 'budgetMs',
        ...['getAXState', 'getAXStateAndScreenshot'].includes(method) ? ['reuseIfUnchanged', 'menuRequests'] : [],
        'args', 'read', 'personToken', ...['click', 'doubleClick', 'rightClick'].includes(method) ? ['coordinateReadId'] : [],
        'quietMs', 'capMs', 'afterReadId', 'extendForBusy', 'busyCapMs', 'includeScroll', 'waitForWindow',
        ...['getScreenshot', 'getAXStateAndScreenshot'].includes(method) ? ['format', 'scale'] : []];
      const invalid = SESSION_EXEMPT_METHODS.has(method) ? undefined : Object.keys(params).find(key => !allowed.includes(key));
      if (invalid !== undefined) throw Object.assign(fault('INVALID_PARAMS'), { field: MAC_DRIVER_PARAM_FIELDS.includes(invalid) ? invalid : 'params' });
      // Match DriverTree's parent-authenticated disclosure request: [String],
      // at most 128 titles, each at most 1024 UTF-8 bytes.
      if (Object.hasOwn(params, 'menuRequests') && (!Array.isArray(params.menuRequests) || params.menuRequests.length > 128 ||
          !Array.from(params.menuRequests).every(title => typeof title === 'string' && Buffer.byteLength(title) <= 1024)))
        throw Object.assign(fault('INVALID_PARAMS'), { field: 'menuRequests' });
      if (!SESSION_EXEMPT_METHODS.has(method) && driveLocked) params = { ...params, allowLocked: true };
    }
    const admission = cancelEpoch;
    const cancellable = !mac && !['cancel', 'ping'].includes(method);
    // A request admitted during retirement belongs to the replacement peer,
    // unless another cancellation fences it while it waits.
    while (!mac && windowsRetirement) await windowsRetirement;
    if (cancellable && admission !== cancelEpoch) throw cancelledBeforeSend(method);
    let g;
    try { g = await start(); }
    catch (error) {
      if (cancellable && admission !== cancelEpoch) throw cancelledBeforeSend(method);
      throw error;
    }
    // Preparation and even a warm start yield before the first frame is sent.
    if (cancellable && admission !== cancelEpoch) throw cancelledBeforeSend(method);
    const local = method === 'localTool' && params.args;
    const localRead = local && (['keyboard-taps.js', 'app-health.js'].includes(local[0]) ||
      local[0] === 'menubar.js' && ['apps', 'notifications'].includes(local[1]?.op) ||
      local[0] === 'stuck-escape.js' && local[1]?.op === 'check' ||
      local[0] === 'open-file-window.js' && !local[1]?.op);
    const input = mac && (methods.includes(method) || method === 'stuckMenuEscape' || local && !localRead);
    if (input && userStopped) throw stoppedInput();
    if (mac) {
      if (hasNestedReadIdentity(params)) throw fault('INVALID_PARAMS');
      params = { ...params };
      for (const key of ['readId', 'afterReadId']) if (Object.hasOwn(params, key)) {
        const publicRead = params[key], nativeRead = publicRead - g.readBase;
        // Check the incarnation immediately before send, after lazy startup.
        if (!Number.isSafeInteger(publicRead) || nativeRead < 1)
          throw Object.assign(fault('STALE_READ', formatMacDriverError({ code: 'STALE_READ', delivery: 'not-sent', retry: 'safe' })),
            { parentSafety: true, delivery: 'not-sent', retry: 'safe' });
        params[key] = nativeRead;
      }
    }
    if (mac && !g.methods.includes(method)) {
      const error = fault('DRIVER_VERSION_MISMATCH', 'Driver does not advertise the requested method.', true);
      stop(g, error); throw error;
    }
    if (mac) checkActive?.();
    if (!mac && (methods.includes(method) || method === 'stuckMenuEscape')) {
      if (windowsTurnLost) throw Object.assign(fault('USER_STOPPED'), {
        reason: 'turn-unproven', delivery: 'not-sent', retry: 'safe',
        ...['typeText', 'paste'].includes(method) ? { typed: 0 } : {},
      });
      // Publish the promise before yielding so concurrent actions share one start.
      if (g.turn !== windowsTurn) {
        const startingTurn = windowsTurn;
        g.turnReady = send(g, 'turn-start', { turn: windowsTurn }, timeoutMs);
        g.turn = windowsTurn;
        g.turnReady = g.turnReady.catch(error => {
          // A refused start owns no native turn. A later trusted end must not
          // send INVALID_PARAMS and accidentally retire this healthy peer.
          if (g.turn === startingTurn) g.turn = undefined;
          throw error;
        });
      }
      await g.turnReady;
      if (admission !== cancelEpoch) throw cancelledBeforeSend(method);
    }
    if (!input || !stopControl) return send(g, method, params, budget, mac ? context : undefined, beforeInput);
    if (activeStop) throw fault('DRIVER_BUSY');
    const operation = { g, live: true };
    activeStop = operation;
    let end;
    try {
      try { end = await stopControl.begin(params, () => personStop(operation)); }
      catch (error) { if (!userStopped) throw error; }
      // A person can stop on the first displayed frame, before the ordinary
      // request is sent. Ask the helper only to cancel and release prior holds.
      if (userStopped) operation.cancelBeforeInput = true;
      const action = send(g, method, params, budget, context, beforeInput, operation);
      const lost = end?.failure?.then(error => {
        if (operation.completed || !operation.live) return action;
        operation.hostFailure = Object.assign(error, { delivery: 'unknown', retry: 'read-first' });
        sendStopControl(g, 'stop', operation.id);
        operation.stopTimer = setTimeout(() => stop(g, Object.assign(operation.hostFailure,
          { unhealthy: true, stopHelperRetired: true, stopRelease: g.stopRelease ?? 'unconfirmed' }), 'SIGKILL'), 500);
        // Wait for release/unwind or the backstop before reporting the host loss.
        return action.then(() => { throw operation.hostFailure; }, () => { throw operation.hostFailure; });
      });
      const result = await (lost ? Promise.race([action, lost]) : action);
      if (userStopped && !operation.completed) {
        const error = stoppedRetired(g);
        stop(g, error, 'SIGKILL'); throw error;
      }
      if (end?.controlUnavailable) result.stopControlUnavailable = true;
      return result;
    } catch (error) {
      if (operation.hostFailure) throw operation.hostFailure;
      if (userStopped && (error.code !== 'USER_STOPPED' || error.unhealthy)) {
        const stopped = stoppedRetired(g);
        stop(g, stopped, 'SIGKILL'); throw stopped;
      }
      throw error;
    } finally {
      clearTimeout(operation.stopTimer);
      operation.live = false;
      if (activeStop === operation) activeStop = undefined;
      await end?.();
    }
  }
  function endWindowsTurn() {
    cancelEpoch++;
    const turn = windowsTurn++;
    windowsTurnLost = false;
    const g = generation;
    // An end never starts a helper, including during a cold preparation.
    if (!g || g.turn !== turn) return Promise.resolve();
    return send(g, 'turn-end', { turn }, timeoutMs);
  }
  function control(g, id, command) {
    if (g.stopped || g.closed) return;
    try { g.child.stdin.write(JSON.stringify({ protocol, platform: 'darwin', nonce: g.nonce, id, control: command }) + '\n'); }
    catch { stop(g, fault('DRIVER_IO', undefined, true)); }
  }
  function cancelPending() {
    if (!mac) return;
    for (const [id, call] of pending) if (call.action && !call.cancelled) {
      call.cancelled = true;
      control(call.g, id, 'cancel');
    }
  }
  function send(g, method, params, budget, context, beforeInput, operation) {
    const cancelling = !mac && method === 'cancel';
    const lifecycle = !mac && ['turn-start', 'turn-end'].includes(method);
    if (g.stopped || disposed && !cancelling) throw fault('DRIVER_CLOSED');
    // Reserve control capacity even when all 32 data slots are occupied.
    if (pending.size >= (cancelling || lifecycle ? 64 : 32)) throw fault('DRIVER_BUSY');
    if (g.next >= Number.MAX_SAFE_INTEGER) { stop(g, fault('DRIVER_PROTOCOL', undefined, true)); throw fault('DRIVER_PROTOCOL'); }
    const id = ++g.next;
    if (operation) operation.id = id;
    const observeGeometry = mac && !operation?.cleanup && g.geometryWire &&
      (ACTION_METHODS.includes(method) || ['getApp', 'getAXState', 'getAXStateAndScreenshot', 'getScreenshot'].includes(method));
    let line;
    try { line = JSON.stringify({ protocol, ...mac ? { platform: 'darwin' } : {}, nonce: g.nonce, id, method, params, deadline: Date.now() + budget,
      ...!mac && checkpointTimings && !['ping', 'cancel'].includes(method) ? { checkpointTimings: true } : {},
      ...operation?.cancelBeforeInput ? { control: 'cancel-before-input' } : {}, ...context !== undefined ? { context } : {} }); }
    catch (error) { if (!mac) throw error; throw fault('INVALID_PARAMS'); }
    // Reserve the fixed private token field before either wire owns this id.
    // Serialize params once: caller toJSON hooks cannot throw after registration.
    const bytes = Buffer.byteLength(line) + (observeGeometry ? 50 : 0);
    if (bytes > lineLimit) throw fault('DRIVER_LINE_LIMIT');
    if (g.child.stdin.writableLength + bytes + 1 > lineLimit + 1) throw fault('DRIVER_BUSY');
    try { if (!operation?.cleanup) g.actionWire?.begin(id, method, params); } catch {}
    const geometryTurn = observeGeometry ? g.geometryWire.begin(id, g.actionWire?.identity(id)) : undefined;
    if (geometryTurn) {
      g.actionWire?.bindTurn(id, geometryTurn);
      line = line.slice(0, -1) + ',"geometryTurn":"' + geometryTurn + '"}';
    }
    return new Promise((resolve, reject) => {
      // A lost action reply cannot prove non-delivery. Never replay it.
      const action = methods.includes(method) || method === 'stuckMenuEscape';
      const grace = !mac && action ? 350 : 0;
      const timer = setTimeout(() => {
        if (cancelling) {
          pending.delete(id);
          // A timed-out control reply may cross the job's reply. Retain bounded
          // ids so it cannot be mistaken for a forged data response later.
          if (g.lateCancels.size >= 32) stop(g, fault('DRIVER_PROTOCOL', 'Too many unanswered cancels.', true));
          else g.lateCancels.set(id, params.id);
          reject(fault('DEADLINE_EXCEEDED')); return;
        }
        stop(g, fault('DEADLINE_EXCEEDED',
        action ? mac ? 'Driver action timed out. Input may have been delivered. Read again before repeating.' :
          'Driver action timed out. Input may have landed; read again before repeating.' : 'Driver request timed out.', true));
      }, cancelling ? Math.min(budget, 300) : budget + grace);
      if (mac) pending.set(id, { g, method, resolve, reject, timer, context, action, beforeInput, operation });
      else {
        let finish;
        const done = new Promise(resolve => { finish = resolve; });
        pending.set(id, { g, method, resolve(value) { finish(); resolve(value); },
          reject(error) { finish(); reject(error); }, done, timer, context, action,
          ...lifecycle ? { turn: params.turn } : {},
          ...cancelling ? { cancelTarget: params.id } : {} });
      }
      try { g.child.stdin.write(line + '\n'); } catch { stop(g, fault('DRIVER_IO', undefined, true)); }
    });
  }
  function cancel() {
    cancelEpoch++;
    // Do not start or replace a host to cancel it. Include reads and captures;
    // cancel frames and health probes never cancel themselves.
    const calls = [...pending.entries()].filter(([, call]) => !['cancel', 'ping', 'turn-start', 'turn-end'].includes(call.method));
    return Promise.all(calls.map(([id, call]) => {
      if (!call.cancelling) {
        try { call.cancelling = send(call.g, 'cancel', { id }, 300).catch(() => {}); }
        catch { call.cancelling = Promise.resolve(); }
      }
      return call.cancelling;
    }));
  }
  async function cancelAndCollect() {
    const jobs = [...pending.values()].filter(call => !['cancel', 'ping', 'turn-start', 'turn-end'].includes(call.method));
    let timer;
    try {
      // The acknowledgment proves flag delivery, not release of held input.
      // Give the original jobs the same bounded window to report cleanup.
      await Promise.all([cancel(), Promise.race([
        Promise.all(jobs.map(call => call.done)),
        new Promise(resolve => { timer = setTimeout(resolve, 300); }),
      ])]);
    } finally { clearTimeout(timer); }
  }
  function retireWindows(code, closing = false) {
    if (closing) disposed = true;
    const previous = windowsRetirement;
    const cancelled = cancelAndCollect();
    const retirement = (async () => {
      if (previous) await previous.catch(() => {});
      await cancelled;
      if (starting) await starting.catch(() => {});
      unavailable = undefined;
      if (generation) stop(generation, fault(code, undefined, !closing));
      await waitForRetirement();
    })();
    windowsRetirement = retirement;
    const clear = () => { if (windowsRetirement === retirement) windowsRetirement = undefined; };
    retirement.then(clear, clear);
    return retirement;
  }
  return Object.freeze({ request, cancelPending, ...!mac ? { cancel, endWindowsTurn } : {},
    get helperGeneration() { return generation?.token; },
    ...mac ? {
      runtimeReceipt: () => generation && !generation.stopped && generation.runtimeReceipt
        ? structuredClone(generation.runtimeReceipt) : undefined,
      get stopAfterSuccess() { return stopAfterSuccess; },
      async releasePostedInput(identity, holds) {
        const g = generation;
        if (!g || g.stopped || g.postedRelease) return 'unconfirmed';
        let timer;
        const token = randomBytes(16).toString('hex');
        try {
          return await new Promise(resolve => {
            g.postedRelease = { resolve, token };
            timer = setTimeout(() => { g.postedRelease = undefined; resolve('unconfirmed'); }, 90);
            try { g.child.stdin.write(JSON.stringify({ protocol, platform: 'darwin', nonce: g.nonce, control: 'release-posted', token,
              params: { windowId: identity.windowId, processStart: identity.processStart, pid: identity.pid, holds } }) + '\n'); }
            catch { g.postedRelease = undefined; resolve('unconfirmed'); }
          });
        } finally { clearTimeout(timer); }
      },
      async stopHeld() {
        userStopped = true;
        // An in-flight native call owns its own finally cleanup. A stepped
        // helper also has to release modifiers retained in this native helper.
        if (activeStop && !activeStop.completed) { personStop(activeStop); return; }
        if (!generation || generation.stopped) return;
        const g = generation;
        sendStopControl(g, 'release');
        const timer = setTimeout(() => stop(g, stoppedRetired(g), 'SIGKILL'), 500);
        try { await send(g, 'modifiers', {}, 500, undefined, undefined, { cancelBeforeInput: true, cleanup: true }); }
        catch (error) { if (error.code !== 'USER_STOPPED' || error.unhealthy) throw error; }
        finally { clearTimeout(timer); }
      },
      userPrompt() {
      // Parent-only continuation from an attributed prompt, never a helper method
      // that evaluated code can invoke. A new prompt cannot revive a running call.
      if (activeStop || [...pending.values()].some(call => call.action)) return false;
      userStopped = false;
      stopAfterSuccess = false;
      sendStopControl(generation, 'prompt');
      return true;
    } } : {},
    ...(mac ? Object.fromEntries(ACTION_METHODS.map(method => [method, (identity, args, options) =>
      request(method, { ...Object.fromEntries(['windowId', 'processStart', 'readId', 'personToken'].filter(key => Object.hasOwn(identity, key)).map(key => [key, identity[key]])), args, read: options?.read ?? 'none' }, options)])) : Object.fromEntries(WINDOWS_ACTION_METHODS.map(method => [method, (identity, args, options = {}) => {
      const { bindingId, ...actionIdentity } = identity;
      const params = structuredClone(validateActionParams(method, { ...actionIdentity, args }));
      const bound = { windowId: params.windowId, processStart: params.processStart, readId: params.readId,
        ...bindingId !== undefined ? { bindingId } : {} };
      const { foreground, ...requestOptions } = options;
      return foregroundFallback({ action: method, identity: bound, args: params.args, foreground,
        background: () => request(method, params, requestOptions),
        verify: () => request('verifyWindowIdentity', windowsBinding(bound), requestOptions),
      });
    }]))),
    ...mac ? {
      onRetire(listener) {
        if (typeof listener !== 'function') throw new TypeError('A retirement listener is required');
        retireListeners.add(listener); return () => retireListeners.delete(listener);
      },
      beginTurn: cancelIdleExit,
      endGeometryTurn() {
        const g = generation, turn = g?.geometryWire?.end();
        if (!g || !turn || g.stopped) return;
        try { g.child.stdin.write(JSON.stringify({ protocol, platform: 'darwin', nonce: g.nonce, control: 'geometry-end', turn }) + '\n'); }
        catch { g.geometryWire.close(); }
      },
      endTurn({ after } = {}) {
        cancelIdleExit();
        if (disposed || !turnEndIdleMs) return;
        idleDeadline = Date.now() + turnEndIdleMs;
        const boundary = idleBoundary = { ready: !after };
        if (after) Promise.resolve(after).then(() => {
          if (idleBoundary !== boundary) return;
          boundary.ready = true; scheduleIdleExit();
        }, () => { if (idleBoundary === boundary) cancelIdleExit(); });
        scheduleIdleExit();
      },
      health: options => request('health', {}, options),
      listWindows: options => request('listWindows', {}, options),
      resolveApp: (selector, options) => request('resolveApp', { selector }, options),
    } : {},
    ping: options => request('ping', {}, options),
    getState: options => request('getState', {}, options),
    listApps: options => request('listApps', {}, options),
    getApp: (selector, options) => request('getApp', { selector }, options),
    ...Object.fromEntries(['getAXState', 'getScreenshot', 'getAXStateAndScreenshot', 'verifyWindowIdentity'].map(method =>
      [method, mac ? async (windowId, { processStart, depth, budgetMs, format, scale, ...options } = {}) => request(method, { ...windowBinding({ windowId, processStart }),
        ...depth !== undefined ? { depth } : {}, ...budgetMs !== undefined ? { budgetMs } : {},
        ...format !== undefined ? { format } : {}, ...scale !== undefined ? { scale } : {} }, options) : async (windowId, { processStart, ...options } = {}) => request(method, windowsBinding({ windowId, processStart }), options)])),
    async restart() {
      cancelIdleExit();
      if (!mac) return retireWindows('DRIVER_RESTARTED');
      if (starting) await starting.catch(() => {}); unavailable = undefined;
      if (generation) stop(generation, fault('DRIVER_RESTARTED', undefined, true)); await waitForRetirement();
    },
    async close() {
      cancelIdleExit();
      if (!mac) return retireWindows('DRIVER_CLOSED', true);
      disposed = true; if (starting) await starting.catch(() => {});
      if (generation) stop(generation, fault('DRIVER_CLOSED')); await waitForRetirement();
    },
  });
}

export function createMacDriverClient({ platform = process.platform, prepare, hostOptions, timeoutMs, lineLimit,
  diagnostics, minimumApiVersion, requiredMethods, driveLocked, failureMemoMs, turnEndIdleMs, actionEvents, stopControl } = {}) {
  return createDriverClient({ driverPlatform: 'darwin', platform, prepare, hostOptions, timeoutMs, lineLimit,
    diagnostics, minimumApiVersion, requiredMethods, driveLocked, failureMemoMs, turnEndIdleMs, actionEvents, stopControl });
}
export function createWindowsDriverClient({ platform = process.platform, prepare, hostOptions, timeoutMs, lineLimit, checkpointTimings = false } = {}) {
  return createDriverClient({ driverPlatform: 'win32', platform, prepare, hostOptions, timeoutMs, lineLimit, checkpointTimings });
}
