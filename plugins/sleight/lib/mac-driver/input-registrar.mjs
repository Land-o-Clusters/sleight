// This module lives in the trusted parent. The worker has neither imports nor
// access to these capabilities. A JSON lookalike cannot enable registration.
import { DRIVER_ACTION_METHODS } from './protocol.mjs';

export const MAC_INPUT_GATE_NOTICES = Object.freeze({ otherSpace: 'The window is minimized or on another Space.' });
export const MAC_PREPARING_NOTICE = 'DRIVER_PREPARING: Building Glide. No cell code ran. Remaining: <s> s. The next call waits by itself.';
export const MAC_COMPILE_BACKOFF_NOTICE = 'Glide helper failed to build. Next automatic try in <s> s. Run sleight-mcp --doctor for the cause. No cell code ran.';
const preparing = () => Object.assign(Error(MAC_PREPARING_NOTICE), { code: 'DRIVER_PREPARING', delivery: 'not-sent', retry: 'safe' });
export function macPreparingError(remainingMs) {
  const error = preparing();
  error.message = Number.isFinite(remainingMs) && remainingMs > 0
    ? error.message.replace('<s>', String(Math.ceil(remainingMs / 1000)))
    : error.message.replace('Building Glide.', 'Glide build is still running.').replace(' Remaining: <s> s.', '');
  return error;
}

const registrars = new WeakMap();
const preparations = new WeakMap();

// Reserve aliases before compilation without granting input. A capability only
// enters registrars after the helper's build and input state both validate.
export function deferMacInputRegistrar(driver, expectedBuild, failure = () => undefined) {
  const registrar = Object.freeze({});
  const state = { aliases: new Map([[registrar, driver]]), promise: undefined, error: undefined, started: undefined, finished: undefined,
    async prepare() {
      return state.promise ??= Promise.resolve().then(async () => {
        state.started = performance.now();
        state.backoff = undefined;
        try {
          await prepareMacInputRegistrar(driver, expectedBuild);
          for (const [alias, client] of state.aliases) registrars.set(alias, client);
        } catch (error) {
          const cause = failure() ?? error;
          // Even a lock held past the bounded build wait is transient. The
          // transport already permits another attempt; keep this capability pending.
          if (['HOST_BUILD_BUSY', 'HOST_COMPILE_BACKOFF'].includes(cause?.code)) {
            state.promise = undefined;
            if (cause.code === 'HOST_COMPILE_BACKOFF') {
              state.backoff = true;
              const seconds = Math.ceil(cause.retryAfterMs / 1000);
              const message = Number.isFinite(seconds) && seconds > 0
                ? MAC_COMPILE_BACKOFF_NOTICE.replace('<s>', String(seconds))
                : MAC_COMPILE_BACKOFF_NOTICE.replace('Next automatic try in <s> s.', 'Automatic retry is pending.');
              throw Object.assign(Error(message), { code: 'HOST_COMPILE_BACKOFF', delivery: 'not-sent', retry: 'safe' });
            }
            throw preparing();
          }
          state.error = macInputUnavailable(cause);
          throw state.error;
        } finally { state.finished = performance.now(); }
      });
    } };
  preparations.set(registrar, { driver, state });
  return registrar;
}

// Startup owns this work. A rejected background build is retained for the next
// call, without an unhandled rejection or a compilation wait in tools/list.
export function startMacInputPreparation(value, driver) {
  const preparation = preparations.get(value);
  if (preparation?.driver === driver) void preparation.state.prepare().catch(() => {});
}

export function macInputPreparation(value, driver) {
  const preparation = preparations.get(value);
  if (preparation?.driver !== driver) return undefined;
  const state = preparation.state;
  return { status: state.error ? 'unavailable' : hasMacInputRegistrar(value, driver) ? 'ready' : state.backoff ? 'backoff' : 'preparing',
    elapsedMs: state.started === undefined ? 0 : Math.max(0, (state.finished ?? performance.now()) - state.started) };
}

// Report fixed diagnostic codes, never compiler stderr or local file paths.
export function macInputUnavailable(error) {
  const cause = [error?.code, error?.message].find(value => /^[A-Z][A-Z0-9_]{0,63}$/.test(value ?? '')) ?? 'BUILD_FAILED';
  return Object.assign(Error(`Glide unavailable (${cause}).`), { code: 'DRIVER_UNAVAILABLE', causeCode: cause,
    delivery: 'not-sent', retry: 'safe' });
}

export const ownsMacInputRegistrar = (value, driver) => hasMacInputRegistrar(value, driver) ||
  driver !== undefined && preparations.get(value)?.driver === driver;

export function macInputState(value, driver) {
  if (hasMacInputRegistrar(value, driver)) return 'Input is on. Stop and Escape end the action.';
  const preparation = preparations.get(value);
  return preparation?.driver === driver && preparation?.state.error
    ? `Input is unavailable (${preparation.state.error.causeCode}).` : 'Input is unavailable (helper not prepared).';
}

export async function waitForMacInputRegistrar(value, driver, timeoutMs = 30000, signal) {
  const preparation = preparations.get(value);
  if (!preparation || preparation.driver !== driver) return;
  let timer, abort;
  try {
    signal?.throwIfAborted();
    await Promise.race([preparation.state.prepare(), new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(preparing()), timeoutMs);
    })]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

// Installed startup calls this factory against the build it compiled or loaded.
// Only this parent can hand the resulting capability to the runtime wrappers.
export async function prepareMacInputRegistrar(driver, expectedBuild) {
  if (typeof expectedBuild !== 'string' || !/^[a-f0-9]{64}$/.test(expectedBuild)) throw Error('MAC_INPUT_GATE_DISABLED');
  // ping.build hashes the composed helper source and protocol constants.
  const hello = await driver.ping();
  if (typeof hello?.build !== 'string' || hello.build !== expectedBuild) throw Error('MAC_INPUT_GATE_DISABLED');
  const state = await driver.request('inputGateState', {});
  if (state?.enabled !== true || Object.keys(state).length !== 1) throw Error('MAC_INPUT_GATE_DISABLED');
  const registrar = Object.freeze({});
  registrars.set(registrar, driver);
  return registrar;
}

export const hasMacInputRegistrar = (value, driver) => value !== null && typeof value === 'object' && registrars.get(value) === driver && driver !== undefined;
export const admitsMacInput = (registrar, method, driver) => hasMacInputRegistrar(registrar, driver) && DRIVER_ACTION_METHODS.includes(method);

// Scheduler and local-tool wrappers are made by the parent around this exact
// client. Only that parent can delegate its existing capability to an alias.
export function bindMacInputRegistrar(value, driver, alias) {
  if (!ownsMacInputRegistrar(value, driver)) return;
  const bound = Object.freeze({});
  if (hasMacInputRegistrar(value, driver)) registrars.set(bound, alias);
  const preparation = preparations.get(value);
  if (preparation) {
    preparation.state.aliases.set(bound, alias);
    preparations.set(bound, { driver: alias, state: preparation.state });
  }
  return bound;
}
