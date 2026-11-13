import { macIdentityError } from '../repl/identity-steps.mjs';
// The parent keeps approvals, leases and policy. This adapter only replaces the
// selected local helper transport. Construction and imports do not start a host.
import { callLocalTool, validateLocalToolArguments, openDocument, reopenDocument, prepareOpenFile, runScript } from '../launch.mjs';
import { localTargetPolicy } from '../local-tool-policy.mjs';
import { sendStuckEscape, checkStuckMenu } from '../stuck-escape.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verifyWindowIdentity as verifyDriverIdentity } from '../repl/identity.mjs';

export const MAC_LOCAL_TOOL_METHOD = 'localTool';
export const MAC_LOCAL_TOOL_SCRIPTS = Object.freeze([
  'menubar.js', 'select-window.js', 'open-file-window.js', 'stuck-escape.js',
  'front-restore.js', 'keyboard-taps.js', 'app-health.js',
]);
const supported = new Set(MAC_LOCAL_TOOL_SCRIPTS);
const toolNames = new Set(['menu_bar', 'notifications', 'select_window', 'open_file']);
export const MAC_LOCAL_TOOL_NOTICES = Object.freeze({
  escapeUnknown: 'sleight may have sent one Escape to close a stuck menu. Delivery could not be confirmed. Read the window before sending more input.',
  restarted: 'The shared helper was restarted after this local tool timed out. Earlier app and element bindings expired. Acquire the app and read again.',
  restartFailed: 'The shared helper could not restart after this local tool timed out. Earlier bindings are invalid. Stop and tell the user.',
});
const preparationFailures = new Set(['DRIVER_UNAVAILABLE', 'PLATFORM', 'DRIVER_VERSION_MISMATCH', 'DRIVER_EXIT',
  'DRIVER_IO', 'DRIVER_PROTOCOL', 'DRIVER_UNHEALTHY', 'DEADLINE_EXCEEDED']);
const unavailable = error => error?.unavailable === true && error?.refused !== true && error?.delivery === 'not-sent';
const refusal = error => Object.assign(new Error(String(error?.message ?? error)), error,
  { delivery: 'not-sent', retry: 'safe', refused: true, unavailable: false });

// The same script runner as the engine path, restricted to this adapter's tools.
// open-file-window.js is a read-only probe; a write uses the launcher's validated
// background open instead of treating the probe's reply as proof of an open.
export function createMacDriverToolFallback({ run = runScript, exec = promisify(execFile) } = {}) {
  return async (script, request, { beforeDispatch, ...options } = {}) => {
    if (!supported.has(script)) throw new Error(`Unsupported local helper: ${script}`);
    beforeDispatch?.();
    if (script === 'open-file-window.js' && request.op === 'open') {
      const result = await openDocument({ app: request.appId, path: request.path }, { bundleId: request.appId,
        current: beforeDispatch, exec: (file, argv) => exec(file, argv, { timeout: 15000 }) });
      return result.isError ? { ok: false, error: result.content[0].text } : { ok: true };
    }
    return run(script, request, options);
  };
}

// RT8 uses this formatter for the runtime Escape result. The engine formatter
// remains unchanged. The uncertain result also carries this text on its own.
export const macDriverStuckEscapeNote = (result, fallback) => result?.posted === 'unknown'
  ? [result.text ?? MAC_LOCAL_TOOL_NOTICES.escapeUnknown, fallback].filter(Boolean).join('\n')
  : result?.released === false ? [fallback, result.releaseError].filter(Boolean).join('\n') : fallback;
const failure = message => ({ content: [{ type: 'text', text: message }], isError: true });
const recoveryResult = error => error?.helperRestarted === undefined ? {} :
  { helperRestarted: error.helperRestarted, error: error.message };
const budget = (script, request) => script === 'stuck-escape.js' ? 5000 : script === 'front-restore.js' ? 2000
  : script === 'app-health.js' ? Math.max(2000, (request.deadlineSeconds ?? 0.5) * 1000 + 1500)
    : script === 'open-file-window.js' ? request.op === 'open' ? 15000 : 1000 : 30000;
const changesApp = (script, request) => script === 'select-window.js' ||
  script === 'menubar.js' && (['open', 'choose', 'press', 'close'].includes(request.op) ||
    request.caller === 'notifications' && request.op === 'notify-press') ||
  script === 'open-file-window.js' && request.op === 'open' || script === 'front-restore.js' && request.action === 'finish';
const notDispatched = error => error?.delivery === 'not-sent' || error?.delivery === undefined &&
  ['INVALID_PARAMS', 'METHOD_NOT_FOUND', 'DRIVER_UNAVAILABLE', 'PLATFORM', 'DRIVER_BUSY'].includes(error?.code);

// RT8 shares this scheduler with the REPL's requests on the same driver client.
// A request's wire deadline starts only when the previous request has finished.
export function createMacDriverToolScheduler() {
  let tail = Promise.resolve(), pending = 0;
  return operation => {
    if (pending >= 32) return Promise.reject(Object.assign(new Error('DRIVER_BUSY'),
      { code: 'DRIVER_BUSY', delivery: 'not-sent', retry: 'safe' }));
    pending++;
    const result = tail.then(operation).finally(() => { pending--; });
    tail = result.catch(() => {});
    return result;
  };
}

export function createMacDriverTools({ driver, fallback = createMacDriverToolFallback(), resolve, schedule = createMacDriverToolScheduler(), ...documentOptions } = {}) {
  if (typeof driver?.request !== 'function' || typeof driver?.ping !== 'function') throw new TypeError('A Mac driver client with ping is required');
  if (typeof schedule !== 'function') throw new TypeError('A driver request scheduler is required');
  let generation = 0;
  function dispatch(method, params, { beforeDispatch, onUnavailable, ...options } = {}) {
    const admitted = generation;
    return schedule(async () => {
      const guard = () => { try {
        if (admitted !== generation) throw new Error('Input lease: this call was stopped.');
        const guarded = beforeDispatch?.();
        if (guarded && typeof guarded.then === 'function') throw new TypeError('beforeDispatch must be synchronous');
        if (admitted !== generation) throw new Error('Input lease: this call was stopped.');
      } catch (error) { throw refusal(error); } };
      guard();
      // Only preparation failure proves this local action was never dispatched.
      // Recheck Stop and policy after preparation, including on the script path.
      try {
        const hello = await driver.ping();
        if (Array.isArray(hello?.methods) && !hello.methods.includes(method)) {
          throw Object.assign(new Error('DRIVER_VERSION_MISMATCH'), { code: 'DRIVER_VERSION_MISMATCH' });
        }
      }
      catch (error) {
        guard();
        if (!preparationFailures.has(error?.code) || error?.refused === true) throw refusal(error);
        const failure = Object.assign(new Error(String(error?.message ?? error)), error,
          { delivery: 'not-sent', retry: 'safe', unavailable: true, refused: false });
        if (onUnavailable && unavailable(failure)) return onUnavailable(guard);
        throw failure;
      }
      guard();
      try { return await driver.request(method, typeof params === 'function' ? params() : params, options); }
      catch (error) {
        if (method !== MAC_LOCAL_TOOL_METHOD || error?.code !== 'DEADLINE_EXCEEDED') throw error;
        // A hard watchdog may retire the process. Never replay the timed-out
        // input. Repair the shared client before the scheduler admits more work.
        let restarted = false;
        try {
          if (typeof driver.restart === 'function') { await driver.restart(); await driver.ping(); restarted = true; }
        } catch { /* The failure text below retains the unhealthy state. */ }
        const message = `${error.message} ${restarted ? MAC_LOCAL_TOOL_NOTICES.restarted : MAC_LOCAL_TOOL_NOTICES.restartFailed}`;
        throw Object.assign(new Error(message), error, { message, helperRestarted: restarted, unavailable: false });
      }
    });
  }
  async function run(script, request = {}, options = {}) {
    if (!supported.has(script)) throw new Error(`Unsupported local helper: ${script}`);
    // No fallback after dispatch, including timeout or a lost reply. A menu
    // press, open or Escape might already have reached its target.
    try {
      let payload;
      try { payload = structuredClone(request); }
      catch { throw Object.assign(new Error('INVALID_PARAMS'), { code: 'INVALID_PARAMS', delivery: 'not-sent', retry: 'safe' }); }
      const { beforeDispatch, ...wire } = options;
      const result = await dispatch(MAC_LOCAL_TOOL_METHOD, () => ({ args: [script, payload] }), {
        timeoutMs: budget(script, payload), ...wire, beforeDispatch: () => beforeDispatch?.(payload),
        ...fallback && !payload.driverIdentity ? { onUnavailable: guard => fallback(script, payload, { ...wire, beforeDispatch: guard }) } : {},
      });
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid local tool reply');
      return result;
    } catch (error) {
      if (script === 'stuck-escape.js' && request.op !== 'check') {
        // Preserve the spent-episode guard when the process dies after key-down.
        // Only a positive pre-dispatch refusal proves no Escape was sent.
        const notSent = notDispatched(error);
        return { ok: false, posted: !notSent, ...!notSent ? { uncertain: true, text: MAC_LOCAL_TOOL_NOTICES.escapeUnknown } : {},
          ...error.helperRestarted !== undefined ? { helperRestarted: error.helperRestarted } : {}, error: String(error.message ?? error) };
      }
      if (changesApp(script, request) && !notDispatched(error)) {
        throw Object.assign(new Error(String(error?.message ?? error) +
          ' Input may have been delivered. Read again before repeating.'), error,
        { delivery: error?.delivery ?? 'unknown', retry: 'read-first' });
      }
      throw error;
    }
  }
  const resolveId = resolve ?? (async selector => {
    try { return (await dispatch('resolveApp', { selector })).app?.id ?? ''; }
    catch (error) { return fallback && unavailable(error) ? prepareOpenFile({ app: selector }, () => false).bundleId : ''; }
  });
  const execOpen = async (_file, argv, options) => {
    const result = await run('open-file-window.js', { op: 'open', appId: argv[2], path: argv[3] }, options);
    if (!result.ok) throw new Error(result.error ?? 'Background open failed');
  };
  async function open(args, options = {}) {
    let recovery;
    const current = options.current ?? documentOptions.current;
    const blocked = options.blocked ?? documentOptions.blocked;
    const check = appId => {
      if (recovery === MAC_LOCAL_TOOL_NOTICES.restartFailed) throw new Error(recovery);
      current?.();
      const refusal = blocked?.(appId, args.app);
      if (refusal) throw new Error(refusal);
    };
    const result = await openDocument(args, { ...documentOptions, ...options, resolve: resolveId,
      hasDocument: async (appId, path) => {
        try {
          const reply = await run('open-file-window.js', { appId, path }, { beforeDispatch: () => check(appId) });
          return reply.ok === true && reply.matches === true;
        } catch (error) {
          if (error.helperRestarted !== undefined) recovery = error.helperRestarted ? MAC_LOCAL_TOOL_NOTICES.restarted : MAC_LOCAL_TOOL_NOTICES.restartFailed;
          throw error;
        }
      },
      exec: (file, argv) => execOpen(file, argv, { beforeDispatch: () => check(argv[2]) }),
    });
    // The launcher's optional document probe catches read errors. Preserve the
    // binding-expiry notice when it proceeds to a separately admitted open.
    if (recovery) result.content.push({ type: 'text', text: recovery });
    return result;
  }
  return Object.freeze({ run, openDocument: open,
    cancelPending() { generation++; },
    reopenDocument: (bundleId, path, options = {}) => reopenDocument(bundleId, path, { ...options,
      exec: (file, argv) => execOpen(file, argv, { beforeDispatch: options.current }) }),
    stuckEscape({ identity, binding, current = () => {}, env = process.env }) {
      if (env.SLEIGHT_STUCK_ESCAPE === '0') return;
      // Runtime bindings come from the parent's admitted read bank. Never
      // resolve a title to a fresh process here or fall back to a legacy post.
      if (binding) {
        const verified = async target => {
          current();
          const bound = structuredClone(await binding(target));
          const expected = bound?.window ?? bound;
          verifyDriverIdentity(expected, expected, 'darwin');
          if (expected.bundleId !== target.appId || expected.title !== target.title || target.url ||
              target.windowNumber !== undefined && String(target.windowNumber) !== expected.windowId)
            throw macIdentityError('window-metadata');
          const reply = await dispatch('verifyWindowIdentity', { windowId: expected.windowId, processStart: expected.processStart }, { beforeDispatch: current });
          current(); verifyDriverIdentity(expected, reply?.window, 'darwin');
          if (reply.window.title !== expected.title) throw macIdentityError('title');
          return { window: expected, lease: bound?.lease };
        };
        const payload = window => ({ appId: window.bundleId, pid: window.pid, processStart: window.processStart,
          driverIdentity: Object.fromEntries(['windowId', 'pid', 'processStart', 'bundleId', 'title', 'identityVerified'].map(key => [key, window[key]])) });
        return {
          async send(target, grant, { since, clock = () => performance.now() } = {}) {
            try {
              if (!Number.isFinite(since)) return { posted: false, reason: 'result time unknown' };
              const bound = await verified(target), { window } = bound;
              const health = await dispatch('health', {}, { beforeDispatch: current });
              current();
              const elapsed = clock() - since;
              if (!Number.isFinite(elapsed) || elapsed < 0 || !Number.isFinite(health?.hidIdleSeconds) || health.hidIdleSeconds < elapsed / 1000)
                return { posted: false, reason: 'user input since the result' };
              const request = { ...payload(window), lease: structuredClone(bound.lease ?? grant), quietSeconds: 0.5, waitSeconds: 1.5 };
              const result = await run('stuck-escape.js', request, { beforeDispatch: value => {
                current(); value.resultAt = Date.now() - Math.max(0, clock() - since);
              } });
              if (result.uncertain) return { posted: 'unknown', selected: null,
                text: [MAC_LOCAL_TOOL_NOTICES.escapeUnknown, result.helperRestarted === undefined ? undefined :
                  result.helperRestarted ? MAC_LOCAL_TOOL_NOTICES.restarted : MAC_LOCAL_TOOL_NOTICES.restartFailed].filter(Boolean).join('\n') };
              return result.posted === true ? { posted: true, selected: typeof result.selected === 'boolean' ? result.selected : null,
                ...result.released === false ? { released: false,
                  ...typeof result.releaseError === 'string' ? { releaseError: result.releaseError } : {} } : {} }
                : { posted: false, reason: result.error ?? 'helper failed' };
            } catch (error) { return { posted: false, reason: String(error?.message ?? error) }; }
          },
          async check(target) {
            try {
              const { window } = await verified(target);
              const result = await run('stuck-escape.js', { ...payload(window), op: 'check' }, { beforeDispatch: current });
              if (result.ok === true && typeof result.selected === 'boolean' && typeof result.open === 'boolean')
                return { selected: result.selected, open: result.open };
            } catch { /* An unverified menu cannot rearm an episode. */ }
          },
        };
      }
      return {
        async send(target, grant, { since, clock } = {}) {
          let uncertain = false, recovery;
          const now = clock ?? (() => performance.now());
          const result = await sendStuckEscape(target, grant, { identity, since, clock: now,
            run: async (script, request) => {
              const r = await run(script, request, { beforeDispatch: payload => {
                payload.resultAt = Date.now() - Math.max(0, now() - since);
              } });
              uncertain = r.uncertain === true;
              if (r.helperRestarted !== undefined) recovery = r.helperRestarted ? MAC_LOCAL_TOOL_NOTICES.restarted : MAC_LOCAL_TOOL_NOTICES.restartFailed;
              return r;
            } });
          // Keep the episode spent and disclose possible input in result text.
          return uncertain ? { ...result, posted: 'unknown', text: [MAC_LOCAL_TOOL_NOTICES.escapeUnknown, recovery].filter(Boolean).join('\n') } : result;
        },
        check: target => checkStuckMenu(target, { identity, run }),
      };
    },
    async call(name, args, approve, resolved, prepared, options = {}) {
      if (!toolNames.has(name)) throw new Error(`Unsupported driver local tool: ${name}`);
      try { validateLocalToolArguments(name, args, options); }
      catch (error) { return failure(error.message); }
      let policy = localTargetPolicy(name, args, resolved, options.allowForbidden);
      if (policy.refusal) return failure(policy.refusal);
      // Menubar apps may have no ordinary windows. Resolve their bundle rather
      // than borrowing a window target from an earlier call.
      if ((name === 'select_window' || name === 'menu_bar' && args.op !== 'apps') && !resolved) {
        try { resolved = { app: args.app, appId: await resolveId(args.app) }; }
        catch (error) { return failure(String(error?.message ?? error)); }
        policy = localTargetPolicy(name, args, resolved, options.allowForbidden);
        if (policy.refusal) return failure(policy.refusal);
      }
      if (name !== 'open_file') return callLocalTool(name, args, approve, (script, request, runOptions) =>
        run(script, request, { ...runOptions, beforeDispatch: () => {
          options.current?.();
          const refusal = resolved?.appId && options.blocked?.(resolved.appId, args.app);
          if (refusal) throw new Error(refusal);
        } }), resolved, prepared, options);
      options.current?.();
      // Reuse the launcher's approval and blocked-app ordering, supplying a
      // prepared document implementation instead of its default spawn path.
      let bundleId = prepared?.bundleId;
      if (options.blocked) {
        bundleId ??= resolveId(String(args.app ?? '').trim()).catch(() => '');
        const id = await bundleId;
        const refusal = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(id) && options.blocked(id, args.app);
        if (refusal) return failure(refusal);
      }
      options.current?.();
      if (!await approve(['open_file', args.app], `Allow Claude to open files in ${args.app}? They open in the background.`,
        policy.warning ? { appWarning: policy.warning, noPreapproved: true } : undefined)) {
        return failure(`The user didn't allow opening files in ${args.app}. Stop and tell them; don't work around it.`);
      }
      return open(args, { ...prepared, ...bundleId ? { bundleId } : {}, ...options,
        ...prepared ? { fast: true, target: resolved } : {} });
    },
    probe: (app, { deadlineSeconds = 0.5 } = {}) => run('app-health.js', { app, deadlineSeconds })
      .catch(error => ({ status: 'unknown', ...recoveryResult(error) })),
    frontRestore: request => run('front-restore.js', request).catch(error => ({ status: 'unknown', ...recoveryResult(error) })),
    keyboardTapState: () => run('keyboard-taps.js').catch(error => ({ ok: false, error: 'Keyboard tap scan unavailable', ...recoveryResult(error) })),
    keyboardTaps: async () => { const r = await run('keyboard-taps.js').catch(() => ({})); return r.ok ? r.taps : []; },
  });
}
