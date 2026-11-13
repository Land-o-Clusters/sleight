// Test-owned Chromium only. Playwright launches it as a process-group leader.
// Keep teardown failures visible even if a later cleanup retries close().
import { once } from 'node:events';

export const TEST_CHROMIUM_CLOSE_MS = 10000;
const REAP_MS = 1000;
const owners = new WeakMap();

export function boundTestChromium(browser, child, { timeoutMs = TEST_CHROMIUM_CLOSE_MS } = {}) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 1 || child.pid === process.pid || typeof child.once !== 'function')
    throw Error('Test Chromium close needs its own launched process handle');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > TEST_CHROMIUM_CLOSE_MS)
    throw Error('Test Chromium close deadline must be between 1 and 10000 ms');
  if (owners.has(browser)) return browser;
  const exited = child.exitCode != null || child.signalCode != null;
  const closed = exited && (child.stdio ?? []).every(stream => !stream || stream.destroyed);
  const state = { timeoutMs, child, failure: null, killing: null, closed };
  child.once('close', () => { state.closed = true; });
  const protect = (resource, label) => {
    if (owners.has(resource)) return resource;
    owners.set(resource, state);
    const close = resource.close.bind(resource);
    let closing;
    resource.close = (...args) => state.failure ? bounded(state, label, () => {})
      : closing ??= bounded(state, label, () => close(...args));
    return resource;
  };
  protect(browser, 'browser.close');
  for (const context of browser.contexts()) protect(context, 'context.close');
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => protect(await newContext(...args), 'context.close');
  return browser;
}

async function forceClose(state, label) {
  if (state.killing) return state.killing;
  const outcome = state.closed ? 'child already collected, no signal sent to process group'
    : 'SIGKILL required for owned process group';
  state.failure = Object.assign(Error(`Test Chromium ${label} exceeded ${state.timeoutMs} ms; ${outcome} ${state.child.pid}`),
    { code: 'ERR_TEST_CHROMIUM_CLOSE_TIMEOUT' });
  state.killing = (async () => {
    const { child } = state;
    if (state.closed) return;
    // Register before signaling so a fast exit cannot strand the reap. Never
    // signal a scanned PID, another browser, or our own process group.
    const exited = once(child, 'close');
    let timer;
    try {
      if (process.platform === 'win32') throw Error('owned Chromium process-group cleanup requires a POSIX host');
      process.kill(-child.pid, 'SIGKILL');
      await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('owned browser exit was not observed within 1000 ms after SIGKILL')), REAP_MS);
      })]);
    } catch (error) {
      if (error.code !== 'ESRCH') state.failure.message += '; ' + error.message;
    } finally { clearTimeout(timer); }
  })();
  return state.killing;
}

async function bounded(state, label, close) {
  if (state.failure) { await state.killing; throw state.failure; }
  let timer;
  const expired = Symbol('close deadline');
  try {
    const result = await Promise.race([Promise.resolve().then(close), new Promise(resolve => {
      timer = setTimeout(() => resolve(expired), state.timeoutMs);
    })]);
    if (result === expired) {
      await forceClose(state, label);
      throw state.failure;
    }
    if (state.failure) { await state.killing; throw state.failure; }
    return result;
  } finally { clearTimeout(timer); }
}

// Include registry/CDP cleanup before close in the same budget. Otherwise an
// unresponsive browser can strand teardown before context.close is reached.
export function closeTestChromium(owner, close) {
  if (!owner) return Promise.resolve().then(close);
  const state = owners.get(owner);
  if (!state) throw Error('Test Chromium teardown needs its owned launch handle');
  return bounded(state, 'teardown', close);
}

export function protectLaunchedTestChromium(browser) {
  // All callers use Playwright's collocated JS API. This pinned seam gives the
  // actual launched ChildProcess, unlike a browser PID inferred from a profile
  // or a CDP connection, which cannot prove ownership.
  const child = browser._connection?.toImpl?.(browser)?.options?.browserProcess?.process;
  return boundTestChromium(browser, child);
}
