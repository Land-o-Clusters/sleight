// The runner owns every process it starts. It never discovers, activates or closes installed-browser targets.
import { spawn, fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { OwnedTools } from './live-checks-1-5.mjs';
import { serveFixtures } from './live-checks-1-5-fixtures.mjs';
import { realBrowserPlan, prepareRealProfile, browserVersion } from './fowl/real-browser.mjs';

const execute = promisify(execFile);
export async function versions(browser) {
  const { readEngine } = await import('./engine-version.mjs');
  const p = realBrowserPlan({ browser, round: 'lc1-version' });
  return { browserVersion: browserVersion(p.executable), engineVersion: readEngine() };
}

function observeChild(child) {
  let closed = false;
  const done = new Promise(resolve => {
    child.once('error', () => {});
    child.once('close', () => { closed = true; resolve(); });
  });
  return { child, done, get closed() { return closed; } };
}
async function waitChild(record, ms) {
  let timer;
  try { await Promise.race([record.done, new Promise(resolve => { timer = setTimeout(resolve, ms); })]); }
  finally { clearTimeout(timer); }
  return record.closed;
}
async function stopChild(record) {
  if (!record || record.closed) return true;
  // These are exact retained ChildProcess handles, never process-name or process-table cleanup.
  record.child.kill('SIGTERM');
  if (await waitChild(record, 5000)) return true;
  record.forcedKill = true;
  record.child.kill('SIGKILL');
  return waitChild(record, 5000);
}

export function createRuntime({ browser, check, signal, waitHold }) {
  let fixtures, realBrowser, browserChild, workerChild, bridge, tools, starting, closing, profileParent, turnFinished = false;
  const cleanupFiles = new Map();
  const previousPointInput = process.env.SLEIGHT_POINT_INPUT;
  const runtime = {
    signal, check, pointInput: check.id === 'points',
    get origin() { return fixtures?.origin; },
    get fixtures() { return fixtures; },
    async prepare() {
      starting ??= (async () => {
        signal.throwIfAborted();
        fixtures = await serveFixtures();
        signal.throwIfAborted();
        const plan = realBrowserPlan({ browser, round: 'lc1-' + randomUUID(), profile: browser === 'chrome' ? 'benchmark' : 'fresh' });
        // Only Chrome's exactly named profile is copied. Helium's data folder is never read.
        // No owner-process gate, resetRealBrowser or inventory-wide cleanup is used: the owner's browsers may remain open.
        mkdirSync(dirname(dirname(plan.profileRoot)), { recursive: true, mode: 0o700 });
        mkdirSync(dirname(plan.profileRoot), { mode: 0o700 });
        profileParent = dirname(plan.profileRoot);
        mkdirSync(plan.profileRoot, { mode: 0o700 });
        if (realpathSync(plan.profileRoot) !== plan.profileRoot || lstatSync(plan.profileRoot).isSymbolicLink()) throw Error('LC1_PROFILE_UNSAFE');
        const prepared = prepareRealProfile(plan);
        signal.throwIfAborted();
        const args = prepared.spawnArgs.slice(0, -1).filter(arg => arg !== '--new-window');
        // No copied sessions, extensions, sync or first-run UI. The first fixture tab is opened by turbo.
        args.push('--no-startup-window', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions');
        browserChild = observeChild(spawn(plan.command, args, { stdio: 'ignore' }));
        const port = join(plan.profileRoot, 'DevToolsActivePort'), deadline = Date.now() + 15000;
        while (!existsSync(port) || !/^\d+\n\/devtools\/browser\/[^\s]+\n?$/.test(readFileSync(port, 'utf8'))) {
          signal.throwIfAborted();
          if (browserChild.closed || Date.now() > deadline) throw Error('LC1_BROWSER_START_FAILED');
          await sleep(50, undefined, { signal });
        }
        realBrowser = { ...plan, ...prepared.record, pid: browserChild.child.pid };
        signal.throwIfAborted();
        const { createV3Bridge } = await import('../plugins/sleight/lib/direct-browser/worker.mjs');
        const { buildConfig } = await import('../plugins/sleight/lib/direct-browser/turbo-setup.mjs');
        const config = buildConfig({ browser: realBrowser });
        if (check.id === 'points') process.env.SLEIGHT_POINT_INPUT = '1';
        bridge = await createV3Bridge({ startupTimeoutMs: Math.min(check.capMs, 120000), timeoutMs: Math.min(check.capMs, 300000) }, {
          readConfig: () => config, acceptPackage: () => ({ current: () => true }), shareConsent: async () => null,
          forkWorker(_entry, _args, options) {
            signal.throwIfAborted();
            const env = Object.fromEntries(['HOME', 'USER', 'PATH', 'TMPDIR', 'LANG', 'CLAUDE_CONFIG_DIR'].flatMap(key =>
              typeof process.env[key] === 'string' ? [[key, process.env[key]]] : []));
            Object.assign(env, { SLEIGHT_TURBO_REAL_BROWSER: JSON.stringify(realBrowser), SLEIGHT_HAND: '0',
              SLEIGHT_TURBO_ORIGINS: JSON.stringify([fixtures.origin]), ...(check.id === 'points' ? { SLEIGHT_POINT_INPUT: '1' } : {}) });
            workerChild = observeChild(fork(fileURLToPath(new URL('./live-checks-1-5-worker.mjs', import.meta.url)), [], { ...options, env }));
            return workerChild.child;
          },
        });
        signal.throwIfAborted();
        const text = check.id === 'turn-gif' ? 'Record this turn.\nFill Name with LC1, then click First action then Second action on the public fixture.'
          : check.id === 'download' ? 'Download the same-origin fixture PDF. Keep it in sleight storage.'
          : check.id === 'motion-frames' ? 'Inspect animation on the hover fixture.'
          : 'Test the local public fixture. Inspect viewport, color scheme, reduced motion and touch. Do not authorize payments or cookie acceptance.';
        if (!await bridge.bind({ ...bridge.bootstrapEnvelope(), event: 'begin', turn: 'lc1', text })) throw Error('LC1_TURN_BIND_FAILED');
        tools = new OwnedTools(bridge, fixtures.origin, signal);
      })();
      return starting;
    },
    async call(name, args, options) {
      await waitHold({ signal }); signal.throwIfAborted();
      return tools.call(name, args, options);
    },
    async finishTurn() { const receipt = await bridge.endTurn(); turnFinished = true; return receipt; },
    async clipboard() {
      const { stdout } = await execute('/usr/bin/pbpaste', [], { encoding: 'buffer', timeout: 5000, maxBuffer: 16 * 1024 * 1024, signal });
      return stdout;
    },
    async frontmost() {
      // Fixed read-only NSWorkspace inspector, as required by the operator's host-inspection policy.
      const { stdout } = await execute(join(homedir(), '.codex/bin/codex-macos-inspect'), ['frontmost-window'], { timeout: 15000, signal });
      const rows = JSON.parse(stdout), pid = rows?.[0]?.ownerPID;
      if (!Number.isSafeInteger(pid) || pid < 1) return { bundleId: null, pid: null };
      const info = await execute(join(homedir(), '.codex/bin/codex-macos-inspect'), ['app-info', String(pid)], { timeout: 15000, signal });
      const app = JSON.parse(info.stdout)?.[0];
      return { bundleId: app?.bundleIdentifier ?? null, pid };
    },
    async windowSizes() {
      const { stdout } = await execute(join(homedir(), '.codex/bin/codex-macos-inspect'), ['windows-for-pid', String(realBrowser.pid)], { timeout: 15000, signal });
      return JSON.parse(stdout).filter(row => row.layer === 0).map(row => ({ window: row.windowNumber, bounds: row.bounds }));
    },
    ownFile(path) { cleanupFiles.set(path, { file: lstatSync(path), parent: lstatSync(dirname(path)) }); },
    async close() {
      closing ??= (async () => {
        const errors = [];
        // If setup is still in progress, stop its owned child before waiting for the setup promise to settle.
        if (signal.aborted && !tools && workerChild) await stopChild(workerChild);
        if (starting) await starting.catch(() => {});
        if (bridge) {
          let timer;
          try {
            const receipt = await Promise.race([(async () => {
              if (tools && !turnFinished) await tools.closeTabs().catch(error => errors.push(error.message));
              const ended = await bridge.endTurn();
              const closed = await bridge.close();
              return { ended, closed };
            })(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('LC1_WORKER_CLEANUP_TIMEOUT')), 15000); })]);
            if (receipt.ended?.cleanup?.length || receipt.closed?.cleanup?.length) errors.push('Worker cleanup receipt retained resources');
          } catch (error) { errors.push(error.message); }
          finally { clearTimeout(timer); }
        }
        // Process exit closes this private profile's targets even if an individual tab snapshot failed.
        const workerStopped = await stopChild(workerChild), browserStopped = await stopChild(browserChild);
        if (!workerStopped || !browserStopped) errors.push('Owned child exit unproved');
        if (workerChild?.forcedKill) errors.push('Worker forced exit; native helper cleanup unproved');
        if (fixtures) try { await fixtures.close(); } catch (error) { errors.push(error.message); }
        for (const [path, identity] of cleanupFiles) try {
          if (existsSync(path)) {
            const now = lstatSync(path);
            if (now.dev !== identity.file.dev || now.ino !== identity.file.ino || now.isSymbolicLink()) throw Error('Owned artifact identity changed');
            rmSync(path);
          }
          const parent = lstatSync(dirname(path));
          if (parent.dev === identity.parent.dev && parent.ino === identity.parent.ino) {
            const { rmdirSync } = await import('node:fs');
            try { rmdirSync(dirname(path)); } catch (error) { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error; }
          }
        } catch (error) { if (error.code !== 'ENOENT') errors.push(error.message); }
        if (browserStopped && workerStopped && !workerChild?.forcedKill && profileParent) try { rmSync(profileParent, { recursive: true }); } catch (error) { errors.push(error.message); }
        if (previousPointInput === undefined) delete process.env.SLEIGHT_POINT_INPUT;
        else process.env.SLEIGHT_POINT_INPUT = previousPointInput;
        // A private browser's confirmed exit is stronger cleanup evidence than a failed per-tab receipt.
        const cleanedUp = workerStopped && browserStopped && !errors.some(e => e !== 'Worker cleanup receipt retained resources' && e !== 'LC1_WORKER_CLEANUP_TIMEOUT');
        return { cleanedUp, workerStopped, browserStopped, privateProfileRemoved: profileParent ? !existsSync(profileParent) : true, ...(errors.length ? { notes: errors } : {}) };
      })();
      return closing;
    },
  };
  return runtime;
}
