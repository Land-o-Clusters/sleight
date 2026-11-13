import { callLocalTool, runScript, localToolDefinitions } from '../launch.mjs';
import { createDragViaDriver } from '../drag-via-driver.mjs';
import { createMacDriverTools, createMacDriverToolScheduler, macDriverStuckEscapeNote } from './tools.mjs';
import { hasMacInputRegistrar, ownsMacInputRegistrar, waitForMacInputRegistrar } from './input-registrar.mjs';

// Only the parent's capability can register local input tools. A deferred
// capability advertises them, but grants input only after helper validation.
export function createMacRuntimeTools({ driver, schedule = createMacDriverToolScheduler(), bindings, current = () => {},
  fallback = null, runLocal = runScript, blocked, allowForbidden, inputRegistrar, beginStop, inputForWindows = (_windows, perform) => perform() } = {}) {
  const tools = createMacDriverTools({ driver, schedule, fallback });
  const inputEnabled = ownsMacInputRegistrar(inputRegistrar, driver);
  const notices = [];
  const checked = options => () => { current(); options?.current?.(); };
  const localTools = Object.freeze({
    // Hover and foreground menu/status actions have no background runtime
    // contract. Only the reviewed local operations enter the gate tool list.
    tools: Object.freeze(inputEnabled ? localToolDefinitions({})
      .filter(tool => ['select_window', 'open_file', 'drag'].includes(tool.name)) : []),
    reopen: (bundleId, path, options) => tools.reopenDocument(bundleId, path,
      { ...options, current: checked(options) }),
    async call(name, args, approve, _runLocal, resolved, prepared, options = {}) {
      await waitForMacInputRegistrar(inputRegistrar, driver, options.timeoutMs);
      if (!hasMacInputRegistrar(inputRegistrar, driver)) throw Object.assign(Error('METHOD_NOT_FOUND'),
        { code: 'METHOD_NOT_FOUND', delivery: 'not-sent', retry: 'safe' });
      const check = checked(options); check();
      options = { ...options, allowForbidden: await allowForbidden?.() === true };
      if (name !== 'drag') return tools.call(name, args, approve, resolved, prepared,
        { ...options, blocked, current: check });
      const run = createDragViaDriver({
        driver: {
          resolveApp: selector => schedule(() => driver.request('resolveApp', { selector, launch: false })),
          verifyWindowIdentity: (windowId, params) => schedule(() => driver.request('verifyWindowIdentity', { windowId, ...params })),
        },
        bindings, runLocal: async (script, request, options) => {
          if (script !== 'drag.js') return runLocal(script, request, options);
          const bound = await bindings(request);
          check();
          return inputForWindows([bound.source, ...bound.destination ? [bound.destination] : []], () => runLocal(script, request, options));
        }, current: check, beginStop,
      });
      return callLocalTool(name, args, approve, run, resolved, prepared, { ...options, current: check,
        resolve: async selector => (await schedule(() => driver.request('resolveApp', { selector, launch: false }))).app?.id ?? '' });
    },
  });
  const escape = tools.stuckEscape({ current, binding: async target => {
    current();
    // bindings renews the existing identity-keyed lease. It refuses ambiguity
    // instead of picking another window with the same title.
    const bound = await bindings({ app: target.appId,
      ...target.windowNumber !== undefined ? { windowId: target.windowNumber } : {} });
    current(); return { window: bound?.source, lease: bound?.sourceLease };
  } });
  return Object.freeze({ localTools,
    spaceProbe: (...args) => tools.probe(...args),
    keyboardTaps: () => tools.keyboardTaps(),
    keyboardTapState: () => tools.keyboardTapState(),
    stuckEscape: escape && {
      check: target => escape.check(target),
      async send(...args) {
        const result = await escape.send(...args);
        const note = macDriverStuckEscapeNote(result);
        if (note && !notices.includes(note)) notices.push(note);
        return result;
      },
    },
    takeNotices: () => notices.splice(0),
    cancelPending() { tools.cancelPending(); },
  });
}
