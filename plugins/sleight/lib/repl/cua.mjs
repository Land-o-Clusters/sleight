// Sleight's native app API. Importing this module does not inspect the desktop.
import { inspect } from 'node:util';
import { createMacClipboardPreserver } from '../mac-driver/preserve.mjs';
import { verifyWindowIdentity } from './identity.mjs';
import { MAC_API_ALIASES, normalizeMacAction, apiMisuse, validateMacRead, validateMacAcquisition } from './arguments.mjs';
import { documentReadText } from './document-read.mjs';
import { nativeListPicker } from './helper-runtime.mjs';

export const TRUNCATED_READ_NOTICE = 'sleight: this read is truncated. Read again before relying on missing elements.';
export const MAC_HANDLE_LINE = 'Handle: keep the app variable returned by cua.getApp for later calls.';
export const MAC_MENU_PRESS_NOTICE = 'Menu pressed via AX.';

const invalid = () => { throw Object.assign(Error('INVALID_PARAMS'), { code: 'INVALID_PARAMS' }); };
const optionsOf = value => {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value;
};
const targetOf = (value, focused = false) => {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)) return value;
  if (focused && value && typeof value === 'object' && Object.keys(value).length === 1 && value.focused === true) return { focused: true };
  if (value && typeof value === 'object' && Object.keys(value).length === 1 &&
      ['id', 'label', 'line'].some(key => typeof value[key] === 'string' && value[key].length)) return value;
  return invalid();
};

export function createCua({ request: driverRequest, write, emitImage, observe = () => {}, platform = 'win32', helpers }) {
  if (!['darwin', 'win32'].includes(platform)) throw Error('PLATFORM');
  const verify = (expected, observed) => verifyWindowIdentity(expected, observed, platform);
  const readOptions = options => {
    if (platform !== 'darwin') return {};
    const params = {};
    for (const [key, min, max] of [['depth', 0, 64], ['budgetMs', 1, 30000]]) {
      if (options[key] !== undefined) {
        if (!Number.isInteger(options[key]) || options[key] < min || options[key] > max) return invalid();
        params[key] = options[key];
      }
    }
    // Parent-only display preference; the runtime strips it before native IPC.
    if (options.disableDiffing === true) params.disableDiffing = true;
    return params;
  };
  const handles = new WeakSet(), actionResults = new WeakSet();
  const pendingReads = new Map();
  const strictText = platform === 'darwin' ? createMacClipboardPreserver({
    dispatchPaste: (target, ...args) => target.paste(...args),
    dispatchPressKey: (target, ...args) => target.pressKey(...args),
  }) : undefined;
  const captureOptions = options => {
    if (platform !== 'darwin') return {};
    const params = {};
    for (const [key, values] of [['format', ['png', 'jpeg']], ['scale', ['pixel', 'point']]]) {
      if (options[key] !== undefined) {
        if (!values.includes(options[key])) return invalid();
        params[key] = options[key];
      }
    }
    return params;
  };
  let incarnation = 0;
  async function request(method, params) {
    let reply;
    try {
      reply = await driverRequest(method, params);
      if (platform === 'darwin' && reply?.unhealthy === true)
        throw Object.assign(Error('DRIVER_UNHEALTHY'), { code: 'DRIVER_UNHEALTHY', unhealthy: true });
    } catch (error) {
      if (platform === 'darwin' && error.unhealthy === true) incarnation++;
      throw error;
    }
    if (!Array.isArray(reply?.notices)) return reply;
    // A guard may suppress its read's tree. Automatic input still needs a receipt.
    const { notices, ...result } = reply;
    for (const notice of notices) if (typeof notice === 'string') write(notice);
    return result;
  }
  function readResult(result, options = {}) {
    if (typeof result?.text !== 'string' || typeof result.window?.windowId !== 'string' ||
        typeof result.window?.processStart !== 'string' ||
        platform === 'darwin' && (!Number.isSafeInteger(result.readId) || result.readId < 1)) throw Error('DRIVER_PROTOCOL');
    observe(result.window);
    const text = result.text, supplement = platform === 'darwin' ? documentReadText(result) : '';
    if (options.emit !== false) {
      write(text);
      if (supplement) write(supplement);
    }
    if (platform === 'darwin' && result.truncated === true) write(TRUNCATED_READ_NOTICE);
    return text;
  }
  async function captureResult(result, options) {
    if (result.screenshot) {
      if (options.emit !== false) {
        if (platform === 'darwin' && typeof result.capture?.note === 'string') write(result.capture.note);
        await emitImage(result.screenshot);
      }
      return result.screenshot;
    }
    if (!result.capture || typeof result.capture.note !== 'string') throw Error('DRIVER_PROTOCOL');
    if (options.emit !== false) write(result.capture.note);
    return null;
  }
  function appFor(result, options) {
    const observed = { ...result.window };
    verify(observed, observed);
    if (!Number.isSafeInteger(result.readId) || result.readId < 1) throw Error('DRIVER_PROTOCOL');
    readResult(result, options);
    if (platform === 'darwin' && options.emit !== false) write(MAC_HANDLE_LINE);
    const identity = { windowId: observed.windowId, processStart: observed.processStart };
    const readKey = JSON.stringify([identity.windowId, identity.processStart]);
    const acquiredIn = incarnation;
    let latestRead = result.readId;
    let latestText = result.text, helperLock, previousClick;
    const failHelper = error => {
      const helper = helpers?.current();
      if (helper) helper.error ??= error;
      throw error;
    };
    const call = async (method, params = {}) => {
      if (helperLock && helpers.current() !== helperLock) throw Error('REPL_BUSY');
      if (acquiredIn !== incarnation) throw Object.assign(Error('APP_HANDLE_EXPIRED'), { code: 'APP_HANDLE_EXPIRED' });
      let reply;
      try { reply = await request(method, { ...identity, ...params }); }
      catch (error) {
        if (platform === 'darwin' && error.delivery === 'not-sent' && Number.isSafeInteger(error.readId) && error.readId > 0)
          latestRead = error.readId;
        throw error;
      }
      if (['getAXState', 'getScreenshot', 'getAXStateAndScreenshot'].includes(method) && !reply?.window) throw Error('DRIVER_PROTOCOL');
      if (reply?.window) { verify(observed, reply.window); observe(reply.window); }
      if (typeof reply?.text === 'string') latestText = reply.text;
      return reply;
    };
    const app = {
      async getAXState(options) {
        options = optionsOf(options);
        const params = readOptions(options);
        latestRead = undefined;
        const result = await call('getAXState', params);
        const state = readResult(result, options); latestRead = result.readId;
        pendingReads.delete(readKey);
        if (platform === 'darwin' && result.automaticScreenshot === true) await captureResult(result, options);
        return state;
      },
      async getScreenshot(options) {
        options = optionsOf(options);
        const result = await call('getScreenshot', captureOptions(options));
        return captureResult(result, options);
      },
      async getAXStateAndScreenshot(options) {
        options = optionsOf(options);
        const params = { ...readOptions(options), ...captureOptions(options) };
        latestRead = undefined;
        const result = await call('getAXStateAndScreenshot', params);
        const state = readResult(result, options);
        const screenshot = await captureResult(result, options); latestRead = result.readId;
        pendingReads.delete(readKey);
        return { state, screenshot };
      },
    };
    // Retain the original reader, outside the model's writable handle methods.
    const refresh = app.getAXState;
    const action = async (method, args) => {
      // The parent checks registration before the retained read, including when
      // an earlier read failed and this handle has no current read ID.
      const clickLine = method === 'click' && typeof args[0] === 'number' && helpers
        ? helpers.kit.elements(latestText).get(args[0]) : undefined;
      previousClick = undefined;
      const result = await call(method, { args, readId: latestRead });
      if (platform === 'darwin' && result?.delivery !== 'not-sent') pendingReads.set(readKey, refresh);
      if (platform === 'darwin' && result?.semantics === 'menu-accessibility') write(MAC_MENU_PRESS_NOTICE);
      if (typeof clickLine === 'string' && result?.delivery !== 'not-sent') previousClick = { number: args[0], line: clickLine };
      if (typeof result?.text === 'string') { latestRead = undefined; readResult(result); latestRead = result.readId; pendingReads.delete(readKey); }
      else if (platform === 'darwin' && Number.isSafeInteger(result?.readId) && result.readId > 0) latestRead = result.readId;
      if (Array.isArray(result?.limits) && result.limits.length)
        write(JSON.stringify({ action: method, route: result.route, confirmation: result.confirmation, limits: result.limits }));
      if (platform === 'darwin' && result && typeof result === 'object') actionResults.add(result);
      return result;
    };
    for (const method of ['click', 'doubleClick', 'rightClick', 'scroll', 'selectText', 'setValue', 'performSecondaryAction']) {
      app[method] = async (target, ...args) => action(method, [targetOf(target, platform === 'darwin' && ['click', 'setValue', 'selectText'].includes(method)), ...args]);
    }
    for (const method of ['typeText', 'paste', 'pressKey']) {
      app[method] = async (text, ...args) => {
        if (typeof text !== 'string') return invalid();
        return action(method, [text, ...args]);
      };
    }
    app.drag = async (from, to, ...args) => action('drag', [targetOf(from), targetOf(to), ...args]);
    if (platform === 'darwin') {
      for (const method of ['getAXState', 'getScreenshot', 'getAXStateAndScreenshot']) {
        const original = app[method];
        app[method] = (...args) => {
          try { validateMacRead(method, args); return original(...args).catch(failHelper); }
          catch (error) { return failHelper(error); }
        };
      }
      for (const method of ['click', 'doubleClick', 'rightClick', 'scroll', 'selectText', 'setValue',
        'performSecondaryAction', 'typeText', 'paste', 'pressKey', 'drag']) {
        app[method] = async (...input) => {
          try {
            const normalized = normalizeMacAction(method, input);
            return await action(normalized.method, normalized.args);
          } catch (error) { return failHelper(error); }
        };
      }
      // Aliases exist only in source preflight, before relay policy inspection.
      if (helpers) app.pickFromList = nativeListPicker({ app, ...helpers, text: () => latestText, clicked: () => previousClick,
        lock(owner) {
          if (helperLock) throw Error('REPL_BUSY');
          helperLock = owner; return () => { helperLock = undefined; };
        } });
    }
    // Handles are writable because the relay's advisory guard wraps their methods.
    Object.defineProperty(app, inspect.custom, { value: () => platform === 'darwin' ? '[Mac app handle]' : '[Windows app handle]' });
    handles.add(app);
    if (platform !== 'darwin') return app;
    const proxy = new Proxy(strictText.wrap(app), { get(target, key, receiver) {
      if (typeof key !== 'string' || key in target || key === 'then') return Reflect.get(target, key, receiver);
      if (Object.hasOwn(MAC_API_ALIASES, key)) return () => failHelper(apiMisuse(key));
      return undefined;
    } });
    handles.add(proxy);
    return proxy;
  }
  return {
    isActionResult: value => actionResults.has(value),
    async finishCell() {
      const reads = [...pendingReads.values()]; pendingReads.clear();
      for (const refresh of reads) await refresh();
    },
    async getApp(selector, options) {
      if (platform === 'darwin') validateMacAcquisition([selector, options]);
      options = optionsOf(options);
      if (!(typeof selector === 'string' && selector.trim()) &&
          !(selector && typeof selector === 'object' && Object.keys(selector).length === 1 &&
            typeof selector.windowId === 'string' && /^[1-9]\d*$/.test(selector.windowId))) return invalid();
      if (options.launch !== undefined && typeof options.launch !== 'boolean') return invalid();
      const result = await request('getApp', { selector,
        ...(platform === 'darwin' && options.launch !== undefined ? { launch: options.launch } : {}) });
      const app = appFor(result, options);
      if (platform === 'darwin' && result.automaticScreenshot === true) await captureResult(result, options);
      return app;
    },
    async getState(options) {
      options = optionsOf(options);
      const state = await request('getState', {});
      if (options.emit !== false) write(state);
      return state;
    },
    async listApps(options) {
      options = optionsOf(options);
      const state = await request('listApps', {});
      if (!Array.isArray(state?.apps)) throw Error('DRIVER_PROTOCOL');
      if (options.emit !== false) write(state.apps);
      return state.apps;
    },
    isHandle: value => handles.has(value),
  };
}

export const createWindowsCua = options => createCua({ ...options, platform: 'win32' });
