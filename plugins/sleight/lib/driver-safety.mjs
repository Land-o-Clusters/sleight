// The worker may escape its REPL realm. Every IPC parameter is checked here.
// Only this parent-side dispatcher can inspect inventory, approve apps or hold leases.
import { windowsClipboardBlockedRows, windowsClipboardResult, windowsClipboardError } from './windows-driver/clipboard.mjs';
import { win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { ACTION_METHODS, validateActionParams } from './windows-driver/actions.mjs';
import { windowBinding, verifyWindowIdentity } from './windows-repl/identity.mjs';
import { forbiddenWindowsTarget, windowsForbiddenWarning } from './blocked-apps-windows.mjs';
import { windowsIdentityStep } from './windows-driver/errors.mjs';

// Parent-owned dispatch, serialization and action transaction for both platforms.
import { createMacSafety } from './mac-safety.mjs';
import { DRIVER_ACTION_METHODS, DRIVER_CODES } from './mac-driver/protocol.mjs';
import { MAC_DRIVER_SENTENCES } from './mac-driver/errors.mjs';

export const WINDOWS_ESCAPE_SESSION_NOTICE = 'Input lease: Stop lasts for this session; start a new session to continue.';
export const WINDOWS_TURN_END_FAILURE = 'Windows turn cleanup failed (reason=<reason>). Input was not sent. Input remains blocked until a successful trusted turn end or a new session.';
export function windowsTurnEndFailure(reason) {
  return WINDOWS_TURN_END_FAILURE.replace('<reason>', /^[a-z][a-z-]{0,39}$/.test(reason ?? '') ? reason : 'turn-end-failed');
}

// Continuations retain each adapter's await boundaries. In particular, there
// must be no new microtask between the last active check, Pause and input.
export function dispatchDriverAction({ read, admit, checkPause, send, observe }) {
  return read(snapshot => admit(snapshot, admission => {
    if (admission?.inspected === true) return true;
    checkPause();
    return send(admission, result => observe(result, snapshot, admission));
  }));
}

export function createDriverSafety({ platform = process.platform, ...options } = {}, adapter) {
  if (!adapter) {
    if (platform === 'darwin') return createMacSafety(options);
    if (platform === 'win32') return windowsSafetyAdapter(options);
    throw Object.assign(Error('PLATFORM'), { code: 'PLATFORM' });
  }
  const { queue, epoch, fail, dispatch, onError } = adapter;
  let clipboardStopped = false, clipboardTurn = 0, userStopped = false, inputTurn = 0;
  let lifecycleAttributed = false, sessionStopped = false, endFailure;
  const observeStop = (error, turn = inputTurn) => {
    if (platform === 'win32' && turn === inputTurn && error.code === 'USER_STOPPED' && ['escape', 'turn-unproven'].includes(error.reason)) {
      userStopped = true;
      if (!lifecycleAttributed) sessionStopped = true;
    }
  };
  const checkUserStop = method => {
    if ((userStopped || sessionStopped) && (ACTION_METHODS.includes(method) || method === 'stuckMenuEscape')) {
      const error = windowsClipboardError(Object.assign(
      Error('USER_STOPPED'), { code: 'USER_STOPPED', reason: userStopped === 'turn-end-failed' ? endFailure : userStopped === 'turn-ending' ? 'turn-ending' : 'escape', delivery: 'not-sent', retry: 'safe', unhealthy: false,
        ...['typeText', 'paste'].includes(method) ? { typed: 0 } : {} }));
      if (userStopped === 'turn-end-failed') error.message = windowsTurnEndFailure(endFailure);
      if (sessionStopped) error.message += ' ' + WINDOWS_ESCAPE_SESSION_NOTICE;
      throw error;
    }
  };
  const stoppedInput = method => ['darwin', 'win32'].includes(platform) && clipboardStopped && DRIVER_ACTION_METHODS.includes(method);
  const clipboardFailure = () => {
    const error = Object.assign(Error(MAC_DRIVER_SENTENCES.CLIPBOARD_CHANGED), { code: 'CLIPBOARD_CHANGED',
      delivery: 'not-sent', retry: 'read-first', next: DRIVER_CODES.CLIPBOARD_CHANGED.next });
    return platform === 'win32' ? windowsClipboardError(error) : error;
  };
  return {
    // The parent turn lifecycle clears this. Unattributed ends outside a
    // bootstrapped mod session and the idle end can reach it too. Cells,
    // helper restarts and js_reset share the stop outside the worker's realm.
    endClipboardTurn() { clipboardStopped = false; clipboardTurn++; },
    windowsLifecycleAttributed() { lifecycleAttributed = true; },
    async endWindowsTurn(end) {
      // Fence old observations before awaiting the native end acknowledgment.
      const turn = ++inputTurn;
      userStopped = 'turn-ending';
      let result;
      try { result = await end(); }
      catch (error) {
        if (turn === inputTurn) {
          endFailure = /^[a-z][a-z-]{0,39}$/.test(error?.reason ?? '') ? error.reason : 'turn-end-failed';
          userStopped = 'turn-end-failed';
        }
        throw error;
      }
      if (turn === inputTurn) userStopped = false;
      return result;
    },
    checkUserStop,
    observeStop,
    stopObserver() { const turn = inputTurn; return error => observeStop(error, turn); },
    request(method, params, context = {}) {
      try { checkUserStop(method); } catch (error) { return Promise.reject(error); }
      if (stoppedInput(method)) return Promise.reject(clipboardFailure());
      // Serialize the entire approval wait and bound forged concurrent IPC.
      if (queue.queued >= 8) return Promise.reject(Object.assign(Error('DRIVER_BUSY'), { code: 'DRIVER_BUSY' }));
      queue.queued++;
      const generation = epoch();
      const turn = clipboardTurn;
      const input = inputTurn;
      let call = queue.serial.then(() => {
        if (generation !== epoch()) fail('REPL_CELL_ENDED');
        checkUserStop(method);
        if (stoppedInput(method)) throw clipboardFailure();
        return dispatch(method, params, context);
      });
      call = call.catch(error => {
        observeStop(error, input);
        if (['darwin', 'win32'].includes(platform) && turn === clipboardTurn && error.clipboardChanged === true) clipboardStopped = true;
        onError?.(error, method);
        if (platform === 'win32' && userStopped === 'turn-end-failed' && error.code === 'USER_STOPPED' && error.reason === endFailure)
          error.message = windowsTurnEndFailure(endFailure);
        if (sessionStopped && error.code === 'USER_STOPPED') error.message += ' ' + WINDOWS_ESCAPE_SESSION_NOTICE;
        throw error;
      });
      call = call.finally(() => { queue.queued--; });
      queue.serial = call.catch(() => {}); return call;
    },
  };
}

export function createWindowsSafety({ driver, lease, approve, allowForbidden, stuckEscape } = {}) {
  return createDriverSafety({ platform: 'win32', driver, lease, approve, allowForbidden, stuckEscape });
}
export const WINDOWS_STUCK_ESCAPE_NOTE = 'sleight posted one Escape to the stuck menu while input was idle.';

const fail = (code, message = code) => { throw Object.assign(Error(message), { code }); };
const keys = (p, expected) => {
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).sort().join(' ') !== expected) fail('INVALID_PARAMS');
};
const validString = s => typeof s === 'string' && !!s.trim() && s.length <= 32768 && !/[\x00-\x1f\x7f]/.test(s) && s.isWellFormed();
const appKey = w => (w.aumid || w.image).toLowerCase();
const approvalKey = w => {
  if (typeof w.imageIdentity !== 'string' || /^[1-9][0-9]{0,18}:[1-9][0-9]{0,18}$/.exec(w.imageIdentity)?.[0] !== w.imageIdentity) fail('TARGET_UNAVAILABLE');
  return JSON.stringify([appKey(w), w.image.toLowerCase(), w.imageIdentity]);
};
// UIA appends owned popups, including ownerless menus. Reserve the executable
// across sessions until independent popup/window lease admission exists. AUMID
// is optional, so it cannot be the lease principal. HWND identity stays bound.
export const windowsLeaseTarget = w => ({ ...w, appId: w.image.toLowerCase(), title: w.windowId, url: null });
function validate(method, params) {
  if (method === 'getState' || method === 'listApps') keys(params, '');
  else if (method === 'getApp') {
    keys(params, 'selector');
    if (typeof params.selector === 'string') { if (!validString(params.selector)) fail('INVALID_PARAMS'); }
    else {
      keys(params.selector, 'windowId');
      windowBinding({ ...params.selector, processStart: '1' });
    }
  } else if (['getAXState', 'getScreenshot', 'getAXStateAndScreenshot'].includes(method)) {
    keys(params, 'processStart windowId'); windowBinding(params);
  } else if (ACTION_METHODS.includes(method)) {
    // Private label verdicts are built after the fresh parent read, never by the worker.
    keys(params, 'args processStart readId windowId');
    validateActionParams(method, params);
  }
  else fail('METHOD_NOT_FOUND');
}

function windowsSafetyAdapter({ driver, lease, approve, allowForbidden = process.env.SLEIGHT_ALLOW_FORBIDDEN_TARGETS === '1',
  stuckEscape = process.env.SLEIGHT_STUCK_ESCAPE !== '0' } = {}) {
  const acquired = new Map(), approved = new Set(), menus = new Map(), pendingEscapes = new Map(), actionCells = new Set();
  let policy;
  const queue = { serial: Promise.resolve(), queued: 0 };
  let closed = false, epoch = 0, closing;
  const refuseWindow = (code, window) => {
    const step = windowsIdentityStep(window?.refusalStep);
    fail(code, code + (step && ['TARGET_UNAVAILABLE', 'HOSTED_APP_UNRESOLVED'].includes(code) ? ': step=' + step : ''));
  };
  const check = (w, expected = w) => {
    try { verifyWindowIdentity(expected, w); }
    catch (error) { refuseWindow(error.code, w); }
    const refusal = forbiddenWindowsTarget(w, { allowForbidden });
    if (refusal) fail(refusal.code, refusal.code + ': ' + refusal.message);
    return w;
  };
  async function foregroundResult(result, active) {
    if (!Object.hasOwn(result, 'foregroundChanged') && !Object.hasOwn(result, 'foregroundExecutable')) return result;
    const name = result.foregroundExecutable;
    let executable = null;
    if (typeof name === 'string' && name.length > 0 && name.length <= 260 && name.isWellFormed() &&
        name === name.trim() && !/^[.]+$|[.]$|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>:"/\\|?*]/u.test(name)) {
      // Basenames alone cannot identify renamed forbidden apps or native refusals.
      // Inspect fresh metadata after input, and withhold unknown or ambiguous names.
      let state;
      try { state = await driver.request('getState', {}); } catch { /* Observation failure does not retry completed input. */ }
      active();
      const matches = Array.isArray(state?.windows) ? state.windows.filter(w =>
        typeof w?.image === 'string' && win32.basename(w.image).toLowerCase() === name.toLowerCase()) : [];
      if (matches.length && matches.every(w => { try { check(w); return true; } catch { return false; } })) executable = name;
    }
    return { ...result, foregroundChanged: typeof result.foregroundChanged === 'boolean' ? result.foregroundChanged : null,
      foregroundExecutable: executable };
  }
  async function dispatch(method, params, context) {
    validate(method, params);
    const generation = epoch;
    const observeTurnStop = requests.stopObserver();
    const active = () => {
      if (closed || generation !== epoch || context.isActive?.() === false) fail('REPL_CELL_ENDED');
    };
    active();
    if (ACTION_METHODS.includes(method) && !['beforeAction', 'checkPause'].every(key => typeof policy?.[key] === 'function'))
      fail('WINDOWS_SAFETY_UNAVAILABLE');
    if (ACTION_METHODS.includes(method)) { actionCells.add(context.cell); pendingEscapes.delete(context.cell); }
    if (method === 'getState' || method === 'listApps') {
      const state = await driver.request('getState', {}); active();
      if (!Array.isArray(state?.windows)) fail('DRIVER_PROTOCOL');
      const windows = state.windows.map(w => {
        const { hostedSelectorHashes: _privateSelectors, ...publicWindow } = w;
        let safe = true, refusal; try { check(w); } catch (error) { safe = false; refusal = error.code; }
        let allowed = false;
        if (safe) { try { allowed = approved.has(approvalKey(w)); } catch { safe = false; } }
        return { ...publicWindow, title: allowed ? w.title : null, image: allowed ? w.image : null, imageIdentity: allowed ? w.imageIdentity : null,
          originalFilename: allowed ? w.originalFilename : null, productName: allowed ? w.productName : null,
          app: safe ? w.app : null, aumid: safe ? w.aumid : null, className: allowed ? w.className : null,
          ...!safe ? { refused: w.refused || refusal || 'TARGET_REFUSED' } : {} };
      });
      const apps = new Map();
      for (const [i, w] of windows.entries()) {
        const key = JSON.stringify([w.pid, w.processStart]);
        if (!apps.has(key)) apps.set(key, { id: w.aumid || w.image || (w.app ? win32.basename(state.windows[i].image) : null),
          name: w.app, pid: w.pid, processStart: w.processStart, windows: [] });
        apps.get(key).windows.push(w);
      }
      return { windows, apps: [...apps.values()] };
    }
    let entry;
    if (method === 'getApp') {
      const state = await driver.request('getState', {}); active();
      if (!Array.isArray(state?.windows)) fail('DRIVER_PROTOCOL');
      const selector = params.selector;
      if (typeof selector === 'string') {
        const hash = createHash('sha256').update(selector.toLowerCase()).digest('hex');
        const hosted = state.windows.find(w => w.refused === 'HOSTED_APP_UNRESOLVED' && w.hostedSelectorHashes?.includes(hash));
        if (hosted) refuseWindow('HOSTED_APP_UNRESOLVED', hosted);
      }
      const identityNames = w => [w.app, w.image, w.aumid, w.originalFilename, w.productName,
        typeof w.image === 'string' ? win32.basename(w.image) : null];
      const named = w => identityNames(w).some(value => typeof value === 'string' && value.toLowerCase() === selector.toLowerCase());
      const matches = w => typeof selector === 'object' ? w.windowId === selector.windowId :
        [...identityNames(w), w.title]
          .some(value => typeof value === 'string' && value.toLowerCase() === selector.toLowerCase());
      const candidates = state.windows.filter(w => matches(w) && (typeof selector === 'object' ||
        !w.popup && !w.refused && !forbiddenWindowsTarget(w, { allowForbidden })));
      if (!candidates.length) {
        const hosted = state.windows.find(w => matches(w) && w.refused === 'HOSTED_APP_UNRESOLVED');
        if (hosted) refuseWindow('HOSTED_APP_UNRESOLVED', hosted);
        if (typeof selector === 'string') {
          const matching = state.windows.filter(w => !w.popup && matches(w));
          // A title alone never discloses a refused app's category.
          if (matching.length && matching.every(w => named(w) && !w.refused &&
              forbiddenWindowsTarget(w, { allowForbidden })?.code === 'BROWSER_TARGET_REFUSED')) fail('BROWSER_TARGET_REFUSED');
        }
        if (typeof selector === 'string' && state.windows.some(w => matches(w) &&
            w.refused === 'ELEVATED_TARGET' &&
            !forbiddenWindowsTarget(w, { allowForbidden }))) fail('ELEVATED_TARGET');
        fail('WINDOW_NOT_FOUND');
      }
      if (candidates.length !== 1) fail('AMBIGUOUS_APP');
      const w = check(candidates[0]);
      const app = appKey(w);
      const approval = approvalKey(w);
      if (!approved.has(approval)) {
        // No title, tree or capture has been read. The card contains the application id only.
        if (await approve({ app, image: w.image, name: w.app, riskLevel: 'high', warning: windowsForbiddenWarning(w) }) !== true) fail('APP_DECLINED');
        active(); approved.add(approval);
      }
      active();
      await lease.ready?.(); active();
      const key = lease.acquire(windowsLeaseTarget(w), 'app');
      entry = { window: { ...w }, key, readId: undefined, text: undefined };
      acquired.set(w.windowId, entry);
    } else {
      entry = acquired.get(params.windowId);
      if (!entry) fail('APP_NOT_ACQUIRED');
      if (params.processStart !== entry.window.processStart) fail('IDENTITY_CHANGED');
      if (ACTION_METHODS.includes(method) && params.readId !== entry.readId) fail('STALE_READ');
    }
    // Renewal proves the secret token, holder and expiry from the private store each time.
    lease.renew([entry.key]); active();
    const binding = windowBinding(entry.window);
    const observation = await driver.request('verifyWindowIdentity', binding); active();
    check(observation?.window, entry.window);
    lease.renew([entry.key]); active();
    if (ACTION_METHODS.includes(method)) {
      const before = entry.text;
      return dispatchDriverAction({
        read: async next => {
          const read = await driver.request('getAXState', binding); active();
          check(read?.window, entry.window);
          if (typeof read.text !== 'string' || !Number.isSafeInteger(read.readId) || read.readId < 1) fail('DRIVER_PROTOCOL');
          entry.readId = read.readId; entry.text = read.text;
          context.observe?.(read); policy.observe?.(read);
          return next(read);
        },
        admit: async (read, commit) => {
          const args = await policy.beforeAction({ method, args: params.args, window: read.window, text: read.text, focusedElement: read.focusedElement, before, cell: context.cell }); active();
          // The fresh parent read owns the native element map. Never reuse the worker's read id.
          params = { ...params, readId: read.readId, args, clipboardBlocked: windowsClipboardBlockedRows(read.text) };
          validateActionParams(method, params);
          return commit();
        },
        checkPause: () => { active(); requests.checkUserStop(method); policy.checkPause(context.cell); },
        send: async (_admission, next) => next(windowsClipboardResult(await driver.request(method, params))),
        observe: observeResult,
      });
    }
    async function observeResult(result) {
      active();
      check(result?.window, entry.window);
      if (Object.hasOwn(result, 'foregroundChanged') || Object.hasOwn(result, 'foregroundExecutable'))
        result = await foregroundResult(result, active);
      if (typeof result.text === 'string') {
        if (!Number.isSafeInteger(result.readId) || result.readId < 1) fail('DRIVER_PROTOCOL');
        entry.readId = result.readId; entry.text = result.text;
        policy?.observe?.(result);
        const menuAt = result.text.search(/^\t*\d+ menu(?! (?:bar|item)(?:\s|$))(?:\s|$)/m);
        const menu = menuAt < 0 ? undefined : result.text.slice(menuAt);
        const action = actionCells.has(context.cell);
        const previous = menus.get(binding.windowId);
        if (!menu || action) menus.delete(binding.windowId);
        else {
          const episode = previous?.menu === menu ? previous : { cell: context.cell, menu, attempted: false };
          menus.set(binding.windowId, episode);
          if (stuckEscape && episode === previous && previous.cell !== context.cell && !episode.attempted) {
            pendingEscapes.set(context.cell, async () => {
              episode.attempted = true;
              const workerReadId = entry.readId;
              lease.renew([entry.key]); active();
              if (typeof policy?.checkPause !== 'function') fail('WINDOWS_SAFETY_UNAVAILABLE');
              requests.checkUserStop('stuckMenuEscape'); policy.checkPause(context.cell);
              try {
                // Internal method. The native driver samples GetLastInputInfo immediately before posting.
                const escaped = windowsClipboardResult(await driver.request('stuckMenuEscape', { ...binding, readId: entry.readId, args: ['Escape'],
                  clipboardBlocked: windowsClipboardBlockedRows(entry.text) }));
                active(); check(escaped?.window, entry.window); entry.readId = escaped.readId;
                let final = escaped;
                if (method === 'getAXStateAndScreenshot') {
                  lease.renew([entry.key]); active();
                  check((await driver.request('verifyWindowIdentity', binding))?.window, entry.window); active();
                  final = await driver.request('getAXStateAndScreenshot', binding); active();
                  check(final?.window, entry.window); entry.readId = final.readId;
                }
                if (!Number.isSafeInteger(entry.readId) || entry.readId < 1 || typeof final.text !== 'string') fail('DRIVER_PROTOCOL');
                // The worker already received its read. Keep that acknowledged id
                // until its next reply; action admission binds a fresh parent read.
                entry.readId = workerReadId; entry.text = final.text;
                const actionFields = Object.fromEntries(['action', 'route', 'limits', 'confirmation', 'settle', 'typed', 'valueChanged', 'escapeStops', 'counters']
                  .filter(key => Object.hasOwn(result, key)).map(key => [key, result[key]]));
                const foreground = Object.fromEntries(['foregroundChanged', 'foregroundExecutable']
                  .filter(key => Object.hasOwn(escaped, key)).map(key => [key, escaped[key]]));
                const observed = await foregroundResult({ ...final, ...actionFields, ...foreground, notices: [WINDOWS_STUCK_ESCAPE_NOTE] }, active);
                policy?.observe?.(observed);
                return observed;
              } catch (error) {
                observeTurnStop(error);
                if (!['USER_ACTIVE', 'IDLE_UNAVAILABLE'].includes(error.code)) throw windowsClipboardError(error);
              }
            });
          }
        }
      }
      return result;
    }
    return observeResult(await driver.request(method === 'getApp' ? 'getAXState' : method, binding));
  }
  const requests = createDriverSafety({ platform: 'win32' }, { queue, epoch: () => epoch, fail, dispatch, onError: windowsClipboardError });
  function cancelAndRelease(closeLease = false) {
    epoch++; acquired.clear(); menus.clear(); pendingEscapes.clear(); actionCells.clear();
    const operations = [() => driver.cancel?.(), () => policy?.reset?.(), () => closeLease ? lease.close() : lease.release()];
    const results = operations.map(operation => {
      try { return Promise.resolve(operation()); }
      catch (error) { return Promise.reject(error); }
    });
    const cleanup = Promise.allSettled(results).then(results => {
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Windows safety cleanup failed.');
    });
    // Legacy relay turn cleanup may be fire-and-forget. Awaiters still receive
    // the original rejection, without an unhandled rejection in that caller.
    cleanup.catch(() => {});
    return cleanup;
  }
  return {
    setPolicy(value) { policy = value; },
    async finishCell(cell) {
      const escape = pendingEscapes.get(cell); pendingEscapes.delete(cell);
      // Worker guard reads may precede its action. Decide only after the entire cell,
      // when the parent knows whether any native action was requested in that cell.
      const acted = actionCells.delete(cell);
      try {
        if (escape && !acted) {
          // Reads remain available after Escape, without automatic input.
          try { requests.checkUserStop('stuckMenuEscape'); }
          catch (error) { if (error.code === 'USER_STOPPED') return; throw error; }
          return await escape();
        }
      }
      finally { policy?.endCell?.(cell); }
    },
    ...requests,
    reset() { return cancelAndRelease(); },
    endTurn({ clipboardTurnEnded = true, windowsTurnEnded = false } = {}) {
      if (clipboardTurnEnded) requests.endClipboardTurn();
      const cleanup = cancelAndRelease();
      if (!windowsTurnEnded) return cleanup;
      return requests.endWindowsTurn(() => Promise.all([cleanup, driver.endWindowsTurn?.()]).then(([, result]) => result));
    },
    close() {
      if (closed) return closing; closed = true;
      return closing = cancelAndRelease(true);
    },
  };
}
