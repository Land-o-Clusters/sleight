import { createActionLedger } from './action-ledger.mjs';
import { identityErrorStep } from '../repl/identity-steps.mjs';
import { isDeepStrictEqual } from 'node:util';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { win32Environment, darwinEnvironment } from '../platform/paths.mjs';
import { createWindowsDriverClient } from '../windows-driver/client.mjs';
import { replDocumentation } from './docs.mjs';
import { formatMacDriverError, MAC_DRIVER_NEXT, MAC_DRIVER_MENU_DETAILS } from '../mac-driver/errors.mjs';
import { DRIVER_ACTION_METHODS } from '../mac-driver/protocol.mjs';
import { normalizeRuntimeCell } from '../runtime-api.mjs';
import { MAC_API_FIXES } from './arguments.mjs';
import { runtimeHelperSource, helperInspection, validateHelperInspection } from './helpers.mjs';
import { PAUSED_NOTE } from '../session-pause.mjs';
import { selectReplNode, nodeSelectionRefusals } from './node.mjs';

export const WINDOWS_SAFETY_UNAVAILABLE = 'Windows native access requires an active safety policy for approval, forbidden-target and lease checks. No driver request ran.';
export const WINDOWS_REPL_NODE_UNSUPPORTED = 'REPL_NODE_UNSUPPORTED: Windows JavaScript needs Node 25 or later with network permissions.';
export const MAC_SAFETY_UNAVAILABLE = 'Mac native access requires an active safety policy for approval, forbidden-target and lease checks. No driver request ran.';
export const REPL_NODE_UNSUPPORTED = 'REPL_NODE_UNSUPPORTED: Install Node 25 or later with network permissions, from nodejs.org or Homebrew. Check doctor for refusal reasons.';
const failure = text => ({ isError: true, content: [{ type: 'text', text }] });
export function replWorkerArguments(flags = process.allowedNodeEnvironmentFlags, platform = process.platform) {
  if (!flags.has('--permission') || !flags.has('--allow-net')) throw Error(platform === 'win32' ? WINDOWS_REPL_NODE_UNSUPPORTED : REPL_NODE_UNSUPPORTED);
  return ['--permission', `--allow-fs-read=${fileURLToPath(new URL('./', import.meta.url))}`,
    `--allow-fs-read=${fileURLToPath(new URL('../../vendor/meriyah/dist/meriyah.min.mjs', import.meta.url))}`,
    `--allow-fs-read=${fileURLToPath(new URL('../mac-driver/preserve.mjs', import.meta.url))}`];
}
export const windowsWorkerArguments = flags => replWorkerArguments(flags, 'win32');
const methods = new Set(['getState', 'listApps', 'getApp', 'getAXState', 'getScreenshot', 'getAXStateAndScreenshot',
  'click', 'doubleClick', 'rightClick', 'setValue', 'performSecondaryAction', 'scroll', 'selectText', 'drag', 'typeText', 'paste', 'pressKey']);

// No process starts at construction. The parent supplies admission outside the eval realm.
// Tests inject both admission and a driver; no environment flag enables native access.
function macDriver() {
  let loaded;
  const get = () => loaded ??= import('../mac-driver/client.mjs').then(module => module.createMacDriverClient());
  return {
    async request(...args) { return (await get()).request(...args); },
    async restart() { if (loaded) await (await loaded).restart(); },
    async close() { if (loaded) await (await loaded).close(); },
  };
}
export function createReplClient({ platform = process.platform,
  driver = platform === 'win32' ? createWindowsDriverClient() : macDriver(),
  admit = async () => false, dispatch, inspectHelperCall, onReset = () => {}, finalize = result => result,
  environment = platform === 'win32' ? win32Environment : darwinEnvironment, spawn = fork, timeoutMs = 30000,
  supportedPlatform, selectNode = selectReplNode, fullDocumentation = process.env.SLEIGHT_ENGINE_DOCS === 'full' } = {}) {
  let generation, retiring = Promise.resolve(), pending, next = 0, disposed = false, resetting = false;
  const lateActions = [];
  let handles = new Set(['app']), misuseCount = 0, referenceShown = false;
  const misuse = message => {
    const result = failure(message);
    if (++misuseCount > 3 && !referenceShown) {
      referenceShown = true; result.content.push({ type: 'text', text: replDocumentation(platform) });
    }
    return result;
  };
  const refuse = (message, context = {}, parseError = false) => finalize(parseError ? failure(message) : misuse(message),
    { results: new Map(), methods: [], errors: [], noInput: true }, { ...context, docs: false });
  async function retire(reason) {
    const previous = retiring;
    const g = generation; generation = undefined;
    if (pending) { pending.dead = true; clearTimeout(pending.timer); pending.resolve?.(failure(reason)); pending = undefined; }
    // A replacement waits for the worker, driver and parent's reset callback.
    // Timeout results can be returned before this cleanup finishes.
    const workerClosed = previous.then(async () => {
      if (g) {
        // Only this client's child is signalled, never a discovered PID.
        const deadline = setTimeout(() => g.child.kill('SIGKILL'), 2000);
        try { g.child.kill(); await g.closed; }
        finally { clearTimeout(deadline); }
      }
    });
    const cleanup = workerClosed.then(async () => {
      await driver.restart();
      await onReset();
    });
    // Keep cleanup ordered without making one failed attempt poison later calls.
    // The caller still receives this cleanup's error once.
    retiring = cleanup.catch(() => {});
    await cleanup;
  }
  async function start(call) {
    await retiring;
    if (disposed) throw Error('REPL_CLOSED');
    if (pending !== call) throw Error('REPL_RESET');
    if (!['darwin', 'win32'].includes(platform) || supportedPlatform && supportedPlatform !== platform) throw Error('PLATFORM');
    if (generation) return generation;
    const node = platform === 'darwin' ? selectNode() : undefined;
    if (platform === 'darwin' && !node) {
      const reasons = nodeSelectionRefusals(selectNode);
      throw Error(REPL_NODE_UNSUPPORTED + (reasons ? ` Refused: ${reasons}.` : ''));
    }
    const child = spawn(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [platform], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: environment(),
      execArgv: replWorkerArguments(platform === 'darwin' ? node?.flags ?? new Set() : undefined, platform), windowsHide: true,
      ...(node?.fallback ? { execPath: node.execPath } : {}),
    });
    const g = generation = { child, docs: false, closed: new Promise(resolve => child.once('close', resolve)) };
    child.stdout.resume(); child.stderr.resume();
    child.on('message', async message => {
      if (message?.type === 'driver' && (generation !== g || !pending || pending.id !== message.cell || pending.finishing)) {
        if (DRIVER_ACTION_METHODS.includes(message.method)) {
          const row = { method: message.method, args: structuredClone(message.params?.args ?? []),
            disposition: 'refused REPL_CELL_ENDED', late: true };
          if (pending && !pending.dead) pending.ledger.late(row); else lateActions.push(row);
        }
        if (child.connected) child.send({ type: 'driver-result', id: message.id, error: {
          code: 'REPL_CELL_ENDED', message: 'REPL_CELL_ENDED', delivery: 'not-sent', retry: 'safe' } });
        return;
      }
      if (generation !== g || !pending) return;
      if (message?.type === 'result' && message.id === pending.id) {
        const call = pending;
        if (call.finishing) return;
        call.finishing = true;
        // A forged early result cannot outrun driver work or erase its parent observations.
        while (call.work.size) await Promise.allSettled([...call.work]);
        if (generation !== g || pending !== call) return;
        clearTimeout(call.timer); call.resolve(message.result);
      } else if (message?.type === 'driver' && message.cell === pending.id) {
        const cell = pending;
        if (cell.finishing) return;
        const action = DRIVER_ACTION_METHODS.includes(message.method);
        const helperRead = ['pickFromList', 'fillForm', 'dragTo'].includes(message.helper) && message.method === 'getAXState';
        const ledgerRow = platform === 'darwin' && (action || helperRead) ? cell.ledger.arrive(message) : undefined;
        if (cell.work.size >= 8) {
          const error = { code: 'DRIVER_BUSY', delivery: 'not-sent', retry: 'safe',
            message: platform === 'darwin' ? formatMacDriverError({ code: 'DRIVER_BUSY', delivery: 'not-sent', retry: 'safe' },
              { action }) : 'DRIVER_BUSY' };
          if (ledgerRow) {
            cell.ledger.settle(ledgerRow, message.method, { error });
            error.message = `sleight: action ${cell.ledger.rows.indexOf(ledgerRow) + 1} ${message.method}: ` + error.message.replace(/^sleight: /, '');
          }
          if (cell.facts.errors.length < 8) cell.facts.errors.push(error);
          if (child.connected) child.send({ type: 'driver-result', id: message.id, error });
          return;
        }
        let finish;
        const work = new Promise(resolve => { finish = resolve; });
        cell.work.add(work);
        const observe = result => {
          if (result && typeof result === 'object') {
            const key = result.window?.windowId ?? 'inventory';
            if (cell.facts.results.size >= 64 && !cell.facts.results.has(key)) throw Object.assign(
              Error('DRIVER_OBSERVATION_LIMIT'), { code: 'DRIVER_OBSERVATION_LIMIT' });
            const before = cell.facts.results.get(key);
            cell.facts.results.delete(key);
            cell.facts.results.set(key, { ...before, ...structuredClone(result) });
          }
        };
        let reply, boundTargets, driverCall = false;
        try {
          if (!Number.isSafeInteger(message.id) || message.id <= 0) throw Error('INVALID_PARAMS');
          if (!methods.has(message.method)) throw Error('METHOD_NOT_FOUND');
          const isActive = () => generation === g && pending === cell;
          if (cell.facts.methods.length < 1024) cell.facts.methods.push(message.method);
          let inspected;
          if (platform === 'darwin' && message.helper !== undefined && DRIVER_ACTION_METHODS.includes(message.method)) {
            cell.facts.helperInput = true;
            const id = message.id, method = message.method, helper = message.helper;
            if (!Array.isArray(message.params?.args)) throw Object.assign(Error('INVALID_PARAMS'), { code: 'INVALID_PARAMS', delivery: 'not-sent', retry: 'safe' });
            inspected = helperInspection(helper, method, message.params);
            validateHelperInspection(inspected);
            let allowed;
            try { allowed = await inspectHelperCall?.(inspected, { isActive, cell: cell.id, messageId: id, observe }); }
            catch (error) {
              const resync = error.parentSafety === true && error.delivery === 'not-sent' &&
                Number.isSafeInteger(error.readId) && error.readId > 0 ? { readId: error.readId } : {};
              if (error.paused === true && error.parentSafety === true) throw Object.assign(Error(PAUSED_NOTE),
                { code: 'PAUSED', parentSafety: true, delivery: 'not-sent', retry: 'safe', ...resync });
              if (platform === 'darwin' && error.parentSafety === true && error.code === 'ACTION_UNSUPPORTED' &&
                  error.delivery === 'not-sent' && error.retry === 'safe' && Object.hasOwn(MAC_DRIVER_MENU_DETAILS, error.menuRefusal ?? ''))
                throw Object.assign(Error(formatMacDriverError(error)), { code: error.code, menuRefusal: error.menuRefusal,
                  parentSafety: true, delivery: 'not-sent', retry: 'safe', ...resync });
              const code = /^[A-Z][A-Z_]{1,63}$/.test(error.code) ? error.code : 'MAC_SAFETY_UNAVAILABLE';
              throw Object.assign(Error(code + (code === 'IDENTITY_CHANGED' && identityErrorStep(error) ? ' step=' + identityErrorStep(error) : '') + ': ' + MAC_DRIVER_NEXT['stop-tell-user']), { code, parentSafety: true, delivery: 'not-sent', retry: 'safe', ...resync });
            }
            if (allowed !== true) throw Object.assign(Error(MAC_SAFETY_UNAVAILABLE), { code: 'MAC_SAFETY_UNAVAILABLE', delivery: 'not-sent', retry: 'safe' });
            if (!isActive()) return;
            if (message.id !== id || message.method !== method || message.helper !== helper || !isDeepStrictEqual(message.params, inspected.params))
              throw Object.assign(Error('INVALID_PARAMS'), { code: 'INVALID_PARAMS', parentSafety: true, delivery: 'not-sent', retry: 'safe' });
          }
          const displayRead = platform === 'darwin' && ['getAXState', 'getAXStateAndScreenshot'].includes(message.method);
          const fullRead = displayRead && message.params?.disableDiffing === true;
          let requestParams = inspected ? structuredClone(inspected.params) : message.params;
          if (displayRead && requestParams && Object.hasOwn(requestParams, 'disableDiffing')) {
            const { disableDiffing, ...nativeParams } = requestParams; requestParams = nativeParams;
          }
          if (dispatch) {
            driverCall = true;
            reply = { result: await dispatch(message.method, requestParams,
              { cell: cell.id, isActive, observe, helper: message.helper, messageId: message.id, fullRead, postRead: message.postRead === true, boundTargets: targets => {
                boundTargets = targets;
                if (ledgerRow && !cell.dead && targets?.length) ledgerRow.bound = [...targets];
              } }) };
          }
          else {
            if (await admit(message.method, requestParams) !== true) throw Object.assign(
              Error(platform === 'win32' ? WINDOWS_SAFETY_UNAVAILABLE : MAC_SAFETY_UNAVAILABLE),
              { code: platform === 'win32' ? 'WINDOWS_SAFETY_UNAVAILABLE' : 'MAC_SAFETY_UNAVAILABLE', delivery: 'not-sent', retry: 'safe' });
            // Dispatchers perform method admission before checking retained reads.
            // Direct clients still reject a missing read before reaching a driver.
            if (platform === 'darwin' && DRIVER_ACTION_METHODS.includes(message.method) &&
                !Number.isSafeInteger(message.params?.readId)) throw Object.assign(Error('STALE_READ'),
              { code: 'STALE_READ', delivery: 'not-sent', retry: 'safe' });
            if (!isActive()) return;
            driverCall = true;
            reply = { result: await driver.request(message.method, requestParams) };
          }
          if (message.helper === 'pickFromList') {
            if (message.method === 'getAXState') cell.facts.pickerReads = (cell.facts.pickerReads ?? 0) + 1;
            if (message.method === 'pressKey' && reply.result?.delivery !== 'not-sent') cell.facts.pickerKeys = (cell.facts.pickerKeys ?? 0) + 1;
          }
          if (DRIVER_ACTION_METHODS.includes(message.method) && (reply.result?.delivery !== 'not-sent' || reply.result?.charactersDelivered > 0)) cell.facts.inputPossible = true;
          // Recording a received reply is parent bookkeeping, outside the driver fault boundary.
          driverCall = false;
          if (reply.result) observe(reply.result);
          if (action && reply.result && (cell.facts.actionReplies?.length ?? 0) < 1024)
            (cell.facts.actionReplies ??= []).push(structuredClone(reply.result));
        } catch (error) {
          if (driverCall && DRIVER_ACTION_METHODS.includes(message.method) && (error.delivery !== 'not-sent' || error.charactersDelivered > 0)) cell.facts.inputPossible = true;
          reply = { error: { code: error.code ?? 'DRIVER_FAILED',
          message: platform === 'darwin' && driverCall && error.parentSafety !== true
            ? formatMacDriverError(error, { method: message.method, action: DRIVER_ACTION_METHODS.includes(message.method) }) : error.message,
          ...['not-sent', 'sent-unverified', 'sent-verified', 'unknown'].includes(error.delivery) ? { delivery: error.delivery } : {},
          ...['safe', 'read-first'].includes(error.retry) ? { retry: error.retry } : {},
          ...Number.isSafeInteger(error.readId) && error.readId > 0 ? { readId: error.readId } : {},
          ...typeof error.unhealthy === 'boolean' ? { unhealthy: error.unhealthy } : {},
          ...typeof error.personTookOver === 'boolean' ? { personTookOver: error.personTookOver } : {},
          ...Number.isSafeInteger(error.charactersDelivered) ? { charactersDelivered: error.charactersDelivered } : {},
        } };
          if (['pickFromList', 'fillForm', 'dragTo'].includes(message.helper)) {
            // Preserve the picker's stop shape even when its terminal parent
            // refusal prevents the reused body's final read and summary.
            reply.error.message = `${message.helper} stopped (${reply.error.code}): ${reply.error.message}` +
              (message.helper === 'pickFromList' ? ` [${cell.facts.pickerReads ?? 0} reads, ${cell.facts.pickerKeys ?? 0} keys]` : '');
          }
          if (ledgerRow && /delivery=|retry=/.test(reply.error.message))
            reply.error.message = `sleight: action ${cell.ledger.rows.indexOf(ledgerRow) + 1} ${message.method}: ` + reply.error.message.replace(/^sleight: /, '');
          if (cell.facts.errors.length < 8) cell.facts.errors.push(reply.error);
        } finally {
          if (ledgerRow && !cell.dead) cell.ledger.settle(ledgerRow, message.method, reply, boundTargets);
          cell.work.delete(work); finish();
        }
        if (generation === g && pending === cell && child.connected) child.send({ type: 'driver-result', id: message.id, ...reply });
      }
    });
    const lost = () => { if (generation === g) retire('REPL_EXIT: JavaScript session ended. Acquire the app again.').catch(() => {}); };
    child.once('error', lost); child.once('close', lost);
    return g;
  }
  return {
    preflight: code => normalizeRuntimeCell(code, handles),
    async execute({ code, timeout_ms = timeoutMs } = {}, context = {}) {
      if (typeof code !== 'string' || Buffer.byteLength(code) > 1024 * 1024 ||
          !Number.isInteger(timeout_ms) || timeout_ms < 1 || timeout_ms > 120000) return failure('INVALID_PARAMS');
      if (pending || resetting) return failure('REPL_BUSY');
      let normalized;
      if (platform === 'darwin') {
        try { normalized = normalizeRuntimeCell(code, handles); }
        catch { return failure('Runtime preflight failed'); }
        if (normalized.fix) return refuse(normalized.fix, context, normalized.parseError);
        code = normalized.code;
      }
      // Reserve the slot before asynchronous startup so concurrent calls cannot share it.
      const call = pending = { id: ++next, ledger: createActionLedger(lateActions.splice(0)), work: new Set(), facts: { results: new Map(), methods: [], errors: [] } };
      try {
        const g = await start(call);
        if (pending !== call) return failure('REPL_RESET');
        const docs = !g.docs; g.docs = true;
        const result = await new Promise(resolve => {
          call.resolve = resolve;
          call.timer = setTimeout(() => { retire('REPL_TIMEOUT: JavaScript timed out. The session was reset; acquire the app again.').catch(() => {}); }, timeout_ms);
          g.child.send({ type: 'evaluate', id: call.id, code,
            ...(docs && platform === 'darwin' ? { helperSource: runtimeHelperSource(process.env.SLEIGHT_COMPLETENESS === '1') } : {}) }, error => {
            if (error && pending === call) retire('REPL_IO').catch(() => {});
          });
        });
        if (normalized) handles = normalized.handles;
        if (!result.isError && call.facts.helperInput && call.facts.errors.length) {
          result.isError = true;
          result.content = [...result.content ?? [], ...call.facts.errors.map(error => ({ type: 'text', text: error.message }))];
        }
        if (platform === 'darwin') {
          const jsError = result.content?.find(item => item.type === 'text' && /^(?:TypeError|ReferenceError|SyntaxError):/.test(item.text));
          if (jsError) jsError.text += '\nFix: ' + MAC_API_FIXES.javascript;
          if (call.facts.errors.length) result.isError = true;
          const misleading = result.content?.some(item => item.type === 'text' && /^sleight:.*(?:refused|Operation not sent|delivery=)/m.test(item.text));
          const ledger = call.ledger.format(result.isError || misleading);
          call.facts.ledger = ledger;
          call.facts.dead = call.dead === true;
          if (ledger) {
            // The parent ledger alone states delivery, including earlier input.
            result.content = (result.content ?? []).map(item => item.type === 'text'
              ? { ...item, text: item.text.replace(/ ?Operation not sent\./g, '') } : item);
            result.content = [{ type: 'text', text: ledger }, ...result.content];
          }
        }
        const includeDocs = docs && (platform !== 'darwin' || fullDocumentation) && !referenceShown;
        if (includeDocs && platform === 'darwin') referenceShown = true;
        const displayed = includeDocs ? { ...result, content: [...call.facts.ledger ? result.content.slice(0, 1) : [],
          { type: 'text', text: replDocumentation(platform) }, ...result.content?.slice(call.facts.ledger ? 1 : 0) ?? []] } : result;
        const projected = await finalize(displayed, call.facts, { ...context, docs, cell: call.id });
        if (pending === call) pending = undefined;
        return projected;
      } catch (error) { if (pending === call) pending = undefined; return failure(error.message); }
    },
    async reset() {
      resetting = true;
      handles = new Set(['app']);
      try { await retire('REPL_RESET'); return { content: [{ type: 'text', text: platform === 'win32' ? 'Windows JavaScript session reset.' : 'Mac JavaScript session reset.' }] }; }
      finally { resetting = false; }
    },
    async close() {
      disposed = true;
      try { await retire('REPL_CLOSED'); }
      finally { await driver.close(); }
    },
  };
}

// The old factory keeps its Windows-only gate even on a Mac host.
export const createWindowsReplClient = options => createReplClient({ ...options, supportedPlatform: 'win32' });
export const createMacReplClient = options => createReplClient({ ...options, supportedPlatform: 'darwin' });
