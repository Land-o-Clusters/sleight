// Benchmark-only admission to V7's inherited IPC boundary. This never reads the
// owner's installed opt-in config and is never imported by plugin code.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createV3Bridge } from '../../plugins/sleight/lib/direct-browser/worker.mjs';
import { fixturePolicy } from './setup.mjs';
import { workerSwitches } from '../replay/switches.mjs';

const runProductMetadata = async (...args) => (await import('../../plugins/sleight/lib/launch.mjs')).runScript(...args);
async function readHandoffPresence(run) {
  let timer;
  try {
    // Use the relay's reader and policy, including its 1500 ms read budget.
    // Older A-side plugins have no reader; they retain their existing wait.
    return await Promise.race([
      import('../../plugins/sleight/lib/remote-approvals.mjs').then(async ({ createRemoteApprovals, isPresent }) =>
        isPresent(await createRemoteApprovals({ run }).presence())),
      new Promise(resolve => { timer = setTimeout(() => resolve(true), 1500); timer.unref?.(); }),
    ]);
  } catch { return true; } finally { clearTimeout(timer); }
}

export async function createSession({ origins, taskMessage, forkWorker = fork, realBrowser, runMetadata = runProductMetadata } = {}) {
  // Tasks on the public web name no local fixture; any origins that are named still have to be runner fixtures.
  if (!Array.isArray(origins)) throw Error('Runner fixture origins required');
  if (origins.length) fixturePolicy(origins);
  if (typeof taskMessage !== 'string' || !taskMessage.trim() || Buffer.byteLength(taskMessage) > 65536) throw Error('Runner task message required');
  // Everything below forks the worker, selects the connection and binds the turn. None of it sends a command to the
  // browser: the worker connects in its first call's prepare(), never in begin (tests/direct-browser-v3-installed-worker
  // "turns without browser calls never connect"). So any failure here is marked beforeCdp and the protocol may start
  // once more. A begin that connected would make this unsafe.
  const startupError = (error, stage) => Object.assign(error instanceof Error ? error : Error('V3_STARTUP_FAILED'),
    { beforeCdp: true, ...(typeof error?.stage === 'string' ? {} : { stage }) });
  let bridge;
  try { bridge = await createV3Bridge({}, {
    readConfig: () => ({}), acceptPackage: () => ({ current: () => true }),
    forkWorker(_installedEntry, _args, options) {
      // The child receives no credentials, host Claude config, loaders or private
      // engine channels. Only the runner fixture origins enter its environment, SLEIGHT_TRACE (a folder or 1) so the
      // worker's startup phases and hand events reach the same trace file as this server's, SLEIGHT_HAND, so the arm's
      // hand-off setting reaches the worker's ghost hand (without it the worker's hand ran in every turbo round), and the
      // metrics destination and LB1/LB2 and model-time A/B switches, so the worker records its phases beside this task's cleanup receipt.
      const env = Object.fromEntries(['HOME', 'USER', 'PATH', 'TMPDIR', 'LANG', 'DISPLAY', 'XDG_RUNTIME_DIR', 'SLEIGHT_TRACE', 'SLEIGHT_HAND', 'SLEIGHT_TURBO_METRICS', 'SLEIGHT_LB12', 'SLEIGHT_MT'].flatMap(key =>
        typeof process.env[key] === 'string' ? [[key, process.env[key]]] : []));
      Object.assign(env, workerSwitches(process.env));
      env.SLEIGHT_TURBO_ORIGINS = JSON.stringify(origins);
      if (realBrowser) env.SLEIGHT_TURBO_REAL_BROWSER = JSON.stringify(realBrowser);
      return forkWorker(fileURLToPath(new URL('./v3-worker.mjs', import.meta.url)), [], { ...options, env });
    },
  }); } catch (error) { throw startupError(error, 'bridge'); }
  let closing;
  try {
    if (!await bridge.bind({ ...bridge.bootstrapEnvelope(), event: 'begin', turn: 'benchturn', text: taskMessage })) throw Error('V3_PRIVATE_PROVIDERS_UNAVAILABLE');
    return Object.freeze({
      call: async input => {
        const waiting = input?.name === 'browser_tabs' && input.arguments?.do === 'handoff' && input.arguments.wait === true;
        return waiting ? bridge.call(input, { handoffPresent: await readHandoffPresence(runMetadata) }) : bridge.call(input);
      }, delivered: bridge.delivered,
      close: () => closing ??= bridge.close() });
  } catch (error) { await bridge.close(); throw startupError(error, 'bind'); }
}

// Only actual lifecycle evidence can populate these fields. A worker revocation
// alone says nothing about browser closure, profiles, sockets or companion tabs.
export function cleanupMetric(receipt) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { version: 3, phase: 'cleanup', turboTabsLeft: count(receipt?.turboTabsLeft),
    tabsAfterBrowserClose: count(receipt?.tabsAfterBrowserClose), browserClosed: receipt?.browserClosed === true,
    profileDeleted: receipt?.profileDeleted === true, socketsClosed: receipt?.socketsClosed === true };
}
