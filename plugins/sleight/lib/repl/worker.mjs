// One disposable Node child per JavaScript session. This is a mistake guard,
// not a security sandbox. The parent owns driver admission and the hard deadline.
import os from 'node:os';
import { start } from 'node:repl';
import { PassThrough } from 'node:stream';
import { inspect, types } from 'node:util';
import { fileURLToPath } from 'node:url';
import { create as createDomain } from 'node:domain';
import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import { registerHooks } from 'node:module';
import { runInNewContext, runInContext } from 'node:vm';
import { createCua } from './cua.mjs';
import { replDocumentation } from './docs.mjs';
import { rebindCell } from './rebindings.mjs';

export const RESULT_LIMIT = 8 * 1024 * 1024;
export function createEvaluator({ request, platform = process.platform, helperSource }) {
  const documentation = replDocumentation(platform);
  let active, closed = false;
  const scope = new AsyncLocalStorage();
  const helperScope = new AsyncLocalStorage();
  let nextHelper = 0;
  const helpers = helperSource && platform === 'darwin' ? {
    current: () => helperScope.getStore(),
    async run(name, operation) {
      const state = helperScope.getStore() ?? { name, id: ++nextHelper };
      return helperScope.run(state, async () => {
        if (state.error) throw state.error;
        const result = await operation();
        // Browser helpers catch locator failures to offer fallbacks. A parent
        // refusal is terminal even if the reused helper catches that exception.
        if (state.error) throw state.error;
        return result;
      });
    },
  } : undefined;
  const timers = new Map();
  const sources = new Map();
  let nextTimer = 0;
  const currentCell = () => active && scope.getStore() === active ? active : undefined;
  // Also collect timers obtained through a host-realm constructor escape.
  const timerHook = createHook({
    init(id, type, _trigger, resource) {
      const cell = scope.getStore();
      if (cell && (type === 'Timeout' || type === 'Immediate')) {
        sources.set(id, { type, resource });
        // A stale promise can create host timers after evaluate's cleanup. Cancel
        // after initialization, before the timers phase, including ref'ed intervals.
        if (cell.ended) queueMicrotask(() => {
          if (type === 'Immediate') clearImmediate(resource); else clearTimeout(resource);
          sources.delete(id);
        });
      }
    },
    destroy(id) { sources.delete(id); },
  }).enable();
  function append(item) {
    if (!currentCell()) return;
    const bytes = Buffer.byteLength(JSON.stringify(item));
    if (active.bytes + bytes > RESULT_LIMIT || active.items.length >= 1024) throw Object.assign(Error('REPL_OUTPUT_LIMIT'), { code: 'REPL_OUTPUT_LIMIT' });
    active.bytes += bytes; active.items.push(item);
  }
  function write(value) {
    if (!currentCell()) return;
    active.emitted.add(value);
    append({ type: 'text', text: typeof value === 'string' ? value :
      value && typeof value === 'object' ? JSON.stringify(value) : inspect(value) });
  }
  async function emitImage(value) {
    let data, mimeType;
    if (typeof value === 'string') {
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
      if (match) [, mimeType, data] = match;
    } else if (value && typeof value === 'object') {
      mimeType = value.mimeType ?? 'image/png';
      if (typeof value.data === 'string') data = value.data;
      else if (ArrayBuffer.isView(value.bytes)) data = Buffer.from(value.bytes.buffer, value.bytes.byteOffset, value.bytes.byteLength).toString('base64');
      else if (types.isAnyArrayBuffer(value.bytes)) data = Buffer.from(value.bytes).toString('base64');
    }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType) || !data ||
        data.length > RESULT_LIMIT || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw Error('INVALID_IMAGE');
    currentCell()?.emitted.add(value); append({ type: 'image', data, mimeType });
  }
  const input = new PassThrough(), output = new PassThrough();
  output.resume();
  // Before Node 25.9 the REPL emits errors on its own domain without calling
  // eval's callback. Share that domain, and enter it explicitly on newer Node.
  const evaluationDomain = createDomain();
  evaluationDomain.on('error', error => currentCell()?.reject?.(error));
  const replOptions = { input, output, terminal: false, prompt: '', useGlobal: false, ignoreUndefined: true };
  let repl;
  try { repl = start({ ...replOptions, domain: evaluationDomain }); }
  catch (error) {
    // New REPLs reject the removed option. Other startup failures still surface.
    if (error.code !== 'ERR_INVALID_ARG_VALUE' || !error.message.includes("'options.domain'")) throw error;
    repl = start(replOptions);
  }
  // The REPL owns a node:vm context and its built-in evaluator retains lexical
  // declarations across cells, including declarations rewritten for top-level await.
  const context = repl.context;
  let declared = new Set();
  // Clear all REPL-added names, including lazy, non-enumerable builtin getters.
  const intrinsics = new Set(runInNewContext('Reflect.ownKeys(globalThis)'));
  for (const key of Reflect.ownKeys(context)) if (!intrinsics.has(key)) delete context[key];
  Object.defineProperty(context, 'console', { enumerable: true });
  if (helpers) helpers.kit = runInContext(helperSource, context);
  let postRead = false;
  const { finishCell, isActionResult, ...cua } = createCua({ platform, helpers, request: async (method, params) => {
    const cell = currentCell();
    if (!cell) throw Error('REPL_CELL_ENDED');
    const helper = helpers?.current();
    if (helper?.error) throw helper.error;
    let reply;
    try { reply = await request(method, params, { ...helper ? { helper: helper.name, helperId: helper.id } : {}, ...postRead ? { postRead: true } : {} }); }
    catch (error) { if (helper) helper.error ??= error; throw error; }
    if (active !== cell) throw Error('REPL_CELL_ENDED');
    return reply;
  }, write, emitImage, observe: window => { if (currentCell()) active.window = window; } });
  cua.rewriteDocumentation = async () => { write(documentation); return platform === 'darwin' ? documentation : undefined; };
  const log = (...values) => write(values.map(value => typeof value === 'string' ? value : inspect(value)).join(' '));
  const sleight = helpers ? Object.fromEntries(['fillForm', 'dragTo', 'pickFromList'].map(name =>
    [name, (...args) => helpers.run(name, () => helpers.kit[name](...args))])) : {};
  Object.assign(context, { cua, nodeRepl: { write, emitImage }, sleight,
    console: { log, error: log, info: log, warn: log, debug: log,
      dir: value => write(inspect(value)), table: value => write(inspect(value)) },
    setTimeout(fn, ms, ...args) {
      const cell = currentCell();
      if (!cell) throw Error('REPL_CELL_ENDED');
      if (typeof fn !== 'function') throw Error('INVALID_CALLBACK');
      const id = ++nextTimer;
      const timer = setTimeout(() => { timers.delete(id); if (currentCell() === cell) fn(...args); }, ms);
      // Return an opaque id, never a host Timeout with a refresh() escape.
      timers.set(id, timer); return id;
    },
    clearTimeout(id) { clearTimeout(timers.get(id)); timers.delete(id); },
  });
  function cancelTimers() {
    for (const { type, resource } of sources.values()) {
      if (type === 'Immediate') clearImmediate(resource); else clearTimeout(resource);
    }
    sources.clear(); timers.clear();
  }
  return {
    async evaluate(code) {
      if (closed || active) throw Error(closed ? 'REPL_CLOSED' : 'REPL_BUSY');
      if (typeof code !== 'string' || Buffer.byteLength(code) > 1024 * 1024) throw Error('INVALID_PARAMS');
      const cell = active = { items: [], emitted: new Set(), bytes: 0 };
      let isError = false, nextDeclared;
      try {
        if (platform === 'darwin') {
          const normalized = rebindCell(code, declared);
          code = normalized.code; nextDeclared = normalized.names;
        }
        const value = await new Promise((resolve, reject) => {
          cell.reject = reject;
          scope.run(cell, () => evaluationDomain.run(() => repl.eval(code + '\n', context, 'sleight-cell',
            (error, value) => error ? reject(error) : resolve(value))));
        });
        if (nextDeclared) declared = nextDeclared;
        if (value !== undefined && !cell.emitted.has(value) && !cua.isHandle(value) && !isActionResult(value)) scope.run(cell, () => write(value));
      } catch (error) {
        // A failed initializer can still leave a usable binding (Node hoists
        // await-cell names). Retain only names that the VM actually initialized.
        // Skip own accessors. Identifier lookup can still invoke a getter on
        // the cell's prototype chain. TDZ lookups remain unrecorded, and no
        // cell is ever replayed.
        if (nextDeclared) for (const name of nextDeclared) {
          try {
            if (Object.getOwnPropertyDescriptor(context, name)?.get) continue;
            runInContext(name, context); declared.add(name);
          } catch {}
        }
        isError = true;
        const text = (platform === 'darwin' && typeof error?.message === 'string' && error.message.startsWith('sleight: ')
          ? error.message : `${error?.code ?? error?.name ?? 'Error'}: ${error?.message ?? 'JavaScript failed.'}`).slice(0, 4096);
        // Preserve earlier items, even if an output-limit error caused the stop.
        cell.items.push({ type: 'text', text });
      } finally {
        try {
          postRead = true;
          await scope.run(cell, finishCell);
        } catch (error) {
          isError = true;
          cell.items.push({ type: 'text', text: String(error?.message ?? 'DRIVER_FAILED').slice(0, 4096) });
        } finally { postRead = false; cell.ended = true; delete cell.reject; active = undefined; cancelTimers(); }
      }
      return { isError, content: cell.items, ...(cell.window ? { _meta: { 'codex/toolSurface': {
        kind: 'computer', app: { appId: cell.window.bundleId || cell.window.aumid || cell.window.image, name: cell.window.app },
        window: cell.window,
      } } } : {}) };
    },
    close() { closed = true; cancelTimers(); timerHook.disable(); scope.disable(); helperScope.disable(); repl.close(); input.destroy(); output.destroy(); },
  };
}

export function runWorker() {
  // Refuse weaker runtimes even if this module is launched outside the client.
  if (!process.permission || !process.allowedNodeEnvironmentFlags.has('--allow-net') ||
      ['net', 'fs.write', 'child', 'worker', 'addons'].some(name => process.permission.has(name))) {
    throw Error('REPL_PERMISSIONS_REQUIRED');
  }
  // All worker dependencies are statically loaded. Refuse subsequent imports,
  // including the REPL's default dynamic-import loader and escaped host Functions.
  registerHooks({ resolve() { throw Object.assign(Error('REPL_IMPORT_DISABLED'), { code: 'REPL_IMPORT_DISABLED' }); } });
  // Node's permission model does not deny signalling another same-user process.
  // Lock signal entry points and native-binding lookups before evaluating code.
  const denySignal = () => { throw Object.assign(Error('REPL_PROCESS_CONTROL_DISABLED'), { code: 'ERR_ACCESS_DENIED' }); };
  for (const key of ['kill', '_kill', '_debugProcess', 'binding', '_linkedBinding', 'abort', 'chdir', 'umask', 'setuid', 'seteuid', 'setgid', 'setegid', 'setgroups', 'initgroups'])
    Object.defineProperty(process, key, { value: denySignal, writable: false, configurable: false });
  Object.defineProperty(os, 'setPriority', { value: denySignal, writable: false, configurable: false });
  let next = 0, current, ended = false;
  const pending = new Map();
  const send = value => { if (process.connected) process.send(value); };
  let evaluator;
  const request = (method, params, metadata) => new Promise((resolve, reject) => {
    if (pending.size >= 32) { reject(Error('DRIVER_BUSY')); return; }
    const id = ++next; pending.set(id, { resolve, reject }); send({ type: 'driver', id, cell: current, method, params, ...metadata });
  });
  process.on('message', async message => {
    if (ended) return;
    if (message?.type === 'driver-result') {
      const call = pending.get(message.id); if (!call) return;
      pending.delete(message.id);
      if (message.error) call.reject(Object.assign(Error(message.error.message), message.error));
      else call.resolve(message.result);
    } else if (message?.type === 'evaluate' && current === undefined) {
      current = message.id;
      evaluator ??= createEvaluator({ platform: process.argv[2] ?? 'win32', request, helperSource: message.helperSource });
      try { send({ type: 'result', id: current, result: await evaluator.evaluate(message.code) }); }
      catch { send({ type: 'result', id: current, result: { isError: true, content: [{ type: 'text', text: 'REPL_FAILED' }] } }); }
      finally {
        current = undefined;
        for (const call of pending.values()) call.reject(Error('REPL_CELL_ENDED'));
        pending.clear();
      }
    }
  });
  process.once('disconnect', () => { ended = true; evaluator?.close(); process.exit(); });
}
if (process.argv[1] === fileURLToPath(import.meta.url) && process.send) runWorker();

export const createWindowsEvaluator = options => createEvaluator({ ...options, platform: 'win32' });
