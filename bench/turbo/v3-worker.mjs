// Benchmark fork entry: the real installed v3 worker (V7) with V10's trust join, over a
// sleight-owned headless Chromium with a temporary profile. Benchmark-only providers stand
// in for the opt-in config, package acceptance, native helpers and the native consent
// window. Nothing here is imported by plugin code.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serveV3Worker, startInstalledV3Worker, unavailableFrame } from '../../plugins/sleight/lib/direct-browser/worker.mjs';
import { createCDPFilter } from '../../plugins/sleight/lib/direct-browser/cdp-filter.mjs';

const vendor = new URL('../../plugins/sleight/vendor/playwright-core/browsers.json', import.meta.url);

export function headlessExecutable(home = homedir()) {
  const spec = JSON.parse(readFileSync(vendor, 'utf8')).browsers.find(b => b.name === 'chromium-headless-shell');
  const executable = join(home, 'Library/Caches/ms-playwright', 'chromium_headless_shell-' + spec.revision,
    'chrome-headless-shell-' + (process.platform === 'darwin' ? 'mac-' + process.arch : 'linux64'), 'chrome-headless-shell');
  if (!existsSync(executable)) throw Error('BENCH_BROWSER_MISSING');
  return executable;
}

// The browser reaches the public web like the user's own Chrome does, so public-site tasks (Wikipedia, MDN) run on the
// product's path. It stays a separate headless Chromium with a temporary profile: the owner's real browsers are never
// touched. The product's own guards still apply on top: the DevTools port and endpoint guards, http(s)-only opens.
export const BENCH_BROWSER_ARGS = ['--headless', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', 'about:blank'];

export async function launchOwnedBrowser({ spawnBrowser = spawn, timeoutMs = 15000 } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-bench-v3-')));
  const child = spawnBrowser(headlessExecutable(), ['--user-data-dir=' + root, ...BENCH_BROWSER_ARGS], { stdio: 'ignore' });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(done => child.once('exit', done));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise(done => setTimeout(done, 5000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    rmSync(root, { recursive: true, force: true });
  };
  const file = join(root, 'DevToolsActivePort'), deadline = Date.now() + timeoutMs;
  while (!existsSync(file) || readFileSync(file, 'utf8').trim().split('\n').length < 2) {
    if (Date.now() > deadline || child.exitCode !== null) { await stop(); throw Error('BENCH_BROWSER_START_FAILED'); }
    await new Promise(done => setTimeout(done, 100));
  }
  const [port, path] = readFileSync(file, 'utf8').trim().split('\n');
  return { endpoint: 'ws://127.0.0.1:' + port + path, stop };
}

export function selectedConnection(endpoint, browser = 'bbench') {
  let socket, serial = 0, disconnected = false;
  const pending = new Map(), listeners = new Set(), losses = new Set();
  const session = { sessionId: 'root',
    on(name, fn) { if (name !== 'event') throw Error('unsupported subscription'); listeners.add(fn); },
    off(name, fn) { if (name !== 'event') throw Error('unsupported subscription'); listeners.delete(fn); },
    send(method, params = {}, route = 'root') {
      if (socket?.readyState !== 1) return Promise.reject(Error('browser connection closed'));
      const id = ++serial;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(route === 'root' ? {} : { sessionId: route }) })); });
    } };
  return { selectedBrowser: browser, session, endpoint,
    async connect() {
      socket = new WebSocket(endpoint);
      socket.addEventListener('message', event => {
        const frame = JSON.parse(event.data);
        if (frame.id) { const entry = pending.get(frame.id); pending.delete(frame.id);
          if (!entry) return; if (frame.error) entry.reject(Error(frame.error.message)); else entry.resolve(frame.result); }
        else for (const fn of listeners) fn(frame);
      });
      socket.addEventListener('close', () => { disconnected = true;
        for (const entry of pending.values()) entry.reject(Error('browser connection closed')); pending.clear();
        for (const fn of losses) fn(); });
      await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true }); });
      return session;
    },
    verifyConnection: async candidate => candidate === session && socket?.readyState === 1,
    async disconnect() {
      if (!socket || disconnected) return true;
      await new Promise(resolve => { socket.addEventListener('close', resolve, { once: true }); socket.close(); });
      return disconnected;
    },
    onConnectionLoss(fn) { losses.add(fn); return () => losses.delete(fn); },
    createFilter() { return createCDPFilter({ session, protectedPort: Number(new URL(endpoint).port) }); } };
}

// Tests that bring their own page providers serve the five tools directly.
export function serveBenchWorker({ channel, begin, close }) {
  return serveV3Worker({ channel, browser: 'bbench', begin, close });
}

// No person watches a benchmark round, so the consent window shows nothing and accepts no
// event: anything that needs the user's confirmation stays unconfirmed and the task fails.
export const benchUi = Object.freeze({ present() {}, authenticate: () => false, revoke() {}, close() {} });

export async function realBrowserDependencies(browser, dependencies = {}) {
  const validate = dependencies.validate ?? (await import('../fowl/real-browser.mjs')).validateRealBrowser;
  validate(browser);
  const createConfig = dependencies.createConfig ?? (await import('../../plugins/sleight/lib/direct-browser/turbo-setup.mjs')).buildConfig;
  const selectConnection = dependencies.selectConnection ?? (await import('../../plugins/sleight/lib/direct-browser/selected-connection.mjs')).createSelectedConnection;
  const config = createConfig({ browser });
  return {
    readConfig: () => config,
    // Keep the installed loader's source acceptance, helper receipts, process
    // birth, selected profile and listener checks on the real-browser path.
    selectConnection: async options => {
      const selected = await selectConnection(options);
      if (selected.identity.pid !== browser.pid) throw Error('BENCH_BROWSER_PROCESS_MISMATCH');
      return { ...selected, selectedBrowser: 'bbench' };
    },
    createUi: () => benchUi,
  };
}

// The bench's own steps before the installed worker's name their stage too, for the task folder's startup record.
const atStage = (stage, work) => work().catch(error => {
  try { if (error && typeof error === 'object' && error.stage === undefined) error.stage = stage; } catch {}
  throw error;
});

export async function startBenchWorker({ channel = process, launch = launchOwnedBrowser,
  realBrowser = process.env.SLEIGHT_TURBO_REAL_BROWSER ? JSON.parse(process.env.SLEIGHT_TURBO_REAL_BROWSER) : null,
  startInstalled = startInstalledV3Worker, realOptions = realBrowserDependencies } = {}) {
  if (realBrowser) return startInstalled({ channel }, await atStage('bench-config', () => realOptions(realBrowser)));
  const owned = await atStage('bench-browser', () => launch());
  const host = await startInstalledV3Worker({ channel }, {
    readConfig: () => ({}), acceptPackage: () => ({ current: () => true }),
    prepareHelpers: async () => ({ status: 'ready', receipt: {} }),
    selectConnection: async () => selectedConnection(owned.endpoint),
    createUi: () => benchUi,
  }).catch(async error => { await owned.stop(); throw error; });
  host.closed.then(() => owned.stop(), () => owned.stop());
  return host;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && process.send) {
  startBenchWorker().catch(error => {
    if (process.connected) { process.send(unavailableFrame(error, 'bench-setup')); process.disconnect(); }
  });
}
