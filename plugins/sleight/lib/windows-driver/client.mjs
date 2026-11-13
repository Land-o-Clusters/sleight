// Compatibility entry point, including the frozen native Windows wire name.
import { createWindowsDriverClient as transport } from '../driver-client.mjs';
import { ACTION_METHODS } from './actions.mjs';
import { windowsClipboardBlockedRows, windowsClipboardResult } from './clipboard.mjs';
import { windowBinding } from '../repl/identity.mjs';
export { WINDOWS_DRIVER_PROTOCOL as DRIVER_PROTOCOL, DRIVER_LINE_LIMIT } from '../driver-client.mjs';

export function createWindowsDriverClient(options) {
  const client = transport(options);
  let read;
  const bindings = new Map();
  const readMethods = ['getAXState', 'getScreenshot', 'getAXStateAndScreenshot', 'verifyWindowIdentity'];
  const boundWindow = params => {
    const admitted = bindings.get(params?.windowId);
    return admitted && admitted.processStart === params?.processStart && !Object.hasOwn(params, 'bindingId')
      ? { ...params, bindingId: admitted.bindingId } : params;
  };
  const observe = async result => {
    try { windowsClipboardResult(result); }
    catch (error) {
      if (error.code === 'DRIVER_PROTOCOL') { read = undefined; bindings.clear(); await client.close(); }
      throw error;
    }
    if (Array.isArray(result?.windows)) bindings.clear();
    for (const window of [...(result?.windows ?? []), ...(result?.window ? [result.window] : [])]) {
      if (window && typeof window.bindingId === 'string') bindings.set(window.windowId, { ...window });
    }
    if (typeof result?.text === 'string' && Number.isSafeInteger(result.readId) && result.window)
      read = { windowId: result.window.windowId, processStart: result.window.processStart,
        readId: result.readId, text: result.text };
    return result;
  };
  const bind = params => {
    if (!params || typeof params !== 'object') return params;
    const { clipboardBlocked: _untrustedVerdict, ...publicParams } = params;
    // The native driver refuses a missing label verdict. Never invent an empty
    // verdict when no acknowledged map matches the complete action identity.
    return read && ['windowId', 'processStart', 'readId'].every(key => publicParams[key] === read[key])
      ? { ...publicParams, clipboardBlocked: windowsClipboardBlockedRows(read.text) } : publicParams;
  };
  return Object.freeze({ ...Object.fromEntries(Object.entries(client).map(([method, fn]) => [method, (...args) => {
    if (readMethods.includes(method)) {
      const [windowId, { processStart, bindingId, ...requestOptions } = {}] = args;
      const params = windowBinding({ windowId, processStart, ...bindingId !== undefined ? { bindingId } : {} });
      return client.request(method, boundWindow(params), requestOptions).then(observe);
    }
    if (method === 'request' && readMethods.includes(args[0])) args[1] = boundWindow(args[1]);
    if (method === 'request' && (ACTION_METHODS.includes(args[0]) || args[0] === 'stuckMenuEscape')) args[1] = bind(args[1]);
    if (ACTION_METHODS.includes(method)) args[0] = boundWindow(bind(args[0]));
    if (method === 'restart' || method === 'close') { read = undefined; bindings.clear(); }
    // Retain synchronous argument validation from the transport.
    return fn(...args).then(observe);
  }])) });
}
