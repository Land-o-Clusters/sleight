#!/usr/bin/env node
// Offline by default only with --dry-run. Imported modules perform no browser discovery.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { scrubText } from './release-pass.mjs';

const specs = [
  ['screenshot', 60, 15], ['motion-frames', 60, 15], ['points', 60, 20], ['mailto-detach', 60, 20],
  ['viewport', 60, 20], ['download', 60, 20], ['pdf', 300, 45], ['developer-reads', 60, 15],
  ['paste', 90, 30], ['turn-gif', 90, 30], ['watch-tick', 60, 1], ['turn-stats', 10, 1],
  ['whole-thread', 90, 30], ['cookie-wall', 60, 20],
];
export const CHECKS = specs.map(([id, seconds, expectedSeconds]) => Object.freeze({ id, capMs: seconds * 1000, expectedSeconds,
  ...(['turn-stats', 'watch-tick'].includes(id) ? { skipReason: id === 'turn-stats'
    ? 'Turn stats need the Claude Code mod lifecycle; this scripted tool caller cannot verify them.'
    : 'The sleight-mcp watch CLI has no unscheduled one-tick mode. run-now needs an installed watch; installing launchd is outside this check.' } : {}),
  run: async runtime => (await import('./live-checks-1-5-checks.mjs')).runCheck(id, runtime) }));

export function parseArgs(argv) {
  const result = { browser: undefined, checks: CHECKS.map(c => c.id), dryRun: false, ownerAway: false }, seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (seen.has(arg)) throw Error('Repeated argument ' + arg);
    seen.add(arg);
    if (arg === '--browser') result.browser = argv[++i];
    else if (arg === '--checks') result.checks = (argv[++i] ?? '').split(',');
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--owner-away') result.ownerAway = true;
    else throw Error('Unknown argument ' + arg);
  }
  if (!['chrome', 'helium'].includes(result.browser)) throw Error('Expected --browser chrome|helium');
  if (!result.checks.length || new Set(result.checks).size !== result.checks.length || result.checks.some(id => !CHECKS.some(c => c.id === id)))
    throw Error('Expected --checks ' + CHECKS.map(c => c.id).join(','));
  return result;
}

export function plan(options) {
  return { schema: 1, dryRun: true, browser: options.browser, drives: false, lock: false,
    profile: options.browser === 'chrome' ? 'private copy of sleight benchmark' : 'fresh private Helium profile',
    connection: 'installed turbo selected connection and worker; no Playwright driver calls from this runner',
    pages: '127.0.0.1 fixtures only; only browser_open handles are usable',
    checks: options.checks.map(id => {
      const { capMs, expectedSeconds } = CHECKS.find(c => c.id === id);
      return { id, capMs, expectedSeconds, ...(id === 'turn-stats' ? { skipReason: 'Turn stats need the Claude Code mod lifecycle.' }
        : id === 'watch-tick' ? { skipReason: 'The watch CLI has no unscheduled one-tick mode; run-now requires an installed watch.' } : {}),
        ...(id === 'screenshot' ? { zoom: 'skip: turbo has no page zoom operation' } : {}) };
    }),
    output: `docs/benchmarks/<date>-live-checks-1-5-${options.browser}-<stamp>.json`,
    liveRequires: '--owner-away; cooperative live lock; hold waits before setup and between checks',
  };
}

export async function waitForHold({ signal, exists = existsSync, pause = sleep, interval = 1000 } = {}) {
  while (exists('/tmp/sleight-hold')) { signal?.throwIfAborted(); await pause(interval, undefined, { signal }); }
  signal?.throwIfAborted();
}

// An inventory is information, never ownership. In particular a matching URL in an owner's tab confers nothing.
export class OwnedTools {
  constructor(client, origin, signal) { this.client = client; this.origin = origin; this.signal = signal; this.tabs = new Set(); }
  async call(name, args, { allowError = false, cleanup = false } = {}) {
    if (!cleanup) this.signal?.throwIfAborted();
    if (!['browser_open', 'browser_read', 'browser_act', 'browser_fill', 'browser_tabs'].includes(name)) throw Error('Unknown turbo tool');
    if (name === 'browser_open') {
      const url = new URL(args.url);
      if (url.origin !== this.origin || url.protocol !== 'http:' || url.username || url.password) throw Error('Only the local fixture origin may open');
    } else if (name !== 'browser_tabs' || args.do !== 'list') {
      if (!this.tabs.has(args.tab)) throw Error('Tab was not opened by this runner');
      if (name === 'browser_tabs' && !['close', 'list'].includes(args.do)) throw Error('Ownership release, focus and handoff are not used by this runner');
      if (args.file || (args.steps ?? []).some(s => s.url !== undefined)) throw Error('Only observed fixture refs may navigate');
    }
    const result = await this.client.call({ name, arguments: args });
    if (name === 'browser_open') {
      // Retain a handle even if its first snapshot fails, so cleanup can close it.
      const tab = /^(t[A-Za-z0-9_-]{1,64})(?:\s|$)/m.exec(result.text ?? '')?.[1];
      if (tab) this.tabs.add(tab);
      if (!result.isError && !tab) throw Error('browser_open returned no owned handle');
    }
    if (!result.isError) this.client.delivered?.(result);
    if (!allowError && result.isError) throw Error(result.text || 'Turbo call failed');
    if (name === 'browser_tabs' && args.do === 'close' && !result.isError) this.tabs.delete(args.tab);
    return result;
  }
  async closeTabs() {
    const failures = [];
    for (const tab of [...this.tabs]) try { await this.call('browser_tabs', { do: 'close', tab }, { cleanup: true }); }
    catch (error) { failures.push(error.message); }
    if (failures.length) throw Error('Owned tab cleanup: ' + failures.join('; '));
  }
}

let publicationOwnerNames = [];
export function scrub(value, { home = homedir(), names = publicationOwnerNames } = {}) {
  const aliases = [userInfo().username, ...names].flatMap(name => [name, ...name.split(/[\s._-]+/u)]).filter(Boolean);
  const clean = text => scrubText(text, home, aliases);
  const walk = v => typeof v === 'string' ? clean(v)
    : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [clean(k), walk(x)])) : v;
  return walk(value);
}
export async function publishReport(report, { root = fileURLToPath(new URL('../docs/benchmarks', import.meta.url)), stamp = Date.now() + '-' + process.pid, names } = {}) {
  // Match the release pass: resolve the owner's full name only when publishing, never during a dry run.
  if (!names) {
    const { execFileSync } = await import('node:child_process');
    const fullName = execFileSync('/usr/bin/id', ['-F'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (!fullName) throw Error('Owner name lookup unavailable; refusing publication');
    names = [fullName];
  }
  publicationOwnerNames = names;
  mkdirSync(root, { recursive: true });
  const file = join(root, `${report.started.slice(0, 10)}-live-checks-1-5-${report.browser}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(scrub(report, { names }), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return file;
}

async function bounded(work, capMs, controller) {
  let timer, onAbort;
  const stopped = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason ?? Error('Interrupted'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => controller.abort(Error('CHECK_TIME_CAP_' + capMs + 'ms')), capMs);
    if (controller.signal.aborted) onAbort();
  });
  try { return await Promise.race([Promise.resolve().then(work), stopped]); }
  finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); }
}

export async function runLiveChecks(options, dependencies = {}) {
  if (options.dryRun) return plan(options);
  if (!options.ownerAway) throw Error('Live checks require --owner-away. Refusing before the live lock.');
  const definitions = dependencies.definitions ?? CHECKS;
  const waitHold = dependencies.waitHold ?? waitForHold;
  const publish = dependencies.publish ?? publishReport;
  const report = { schema: 1, started: new Date().toISOString(), browser: options.browser, ownerAway: true, dryRun: false,
    browserVersion: null, engineVersion: null, checks: [], cleanup: true };
  let unlock, safe = true;
  try {
    await waitHold({ signal: dependencies.signal });
    const acquire = dependencies.acquireLock ?? (await import('./live-lock.mjs')).acquireLiveLock;
    const lockController = new AbortController(), lockWaitMs = dependencies.lockWaitMs ?? 300000;
    const timer = setTimeout(() => lockController.abort(Error('LIVE_LOCK_WAIT_CAP_' + lockWaitMs + 'ms')), lockWaitMs);
    try {
      unlock = await acquire(undefined, { wait: true, interval: 15000,
        signal: dependencies.signal ? AbortSignal.any([dependencies.signal, lockController.signal]) : lockController.signal });
    } finally { clearTimeout(timer); }
    await waitHold({ signal: dependencies.signal });
    const versions = dependencies.versions ?? (await import('./live-checks-1-5-runtime.mjs')).versions;
    Object.assign(report, await versions(options.browser));
    for (const id of options.checks) {
      const check = definitions.find(c => c.id === id);
      if (!check) throw Error('Unknown check ' + id);
      const row = { id, status: 'skip', ms: 0, capMs: check.capMs, measured: {} };
      report.checks.push(row);
      if (!safe || dependencies.signal?.aborted) { row.reason = !safe ? 'Previous cleanup is unproved; no further browser work.' : 'Run interrupted'; continue; }
      if (check.skipReason) { row.reason = check.skipReason; continue; }
      await waitHold({ signal: dependencies.signal });
      const controller = new AbortController();
      const abort = () => controller.abort(dependencies.signal.reason);
      dependencies.signal?.addEventListener('abort', abort, { once: true });
      const started = performance.now();
      let runtime;
      try {
        // Runtime construction is inert. prepare() owns setup and observes the same cap as calls.
        const factory = dependencies.createRuntime ?? (await import('./live-checks-1-5-runtime.mjs')).createRuntime;
        runtime = await factory({ browser: options.browser, check, signal: controller.signal, waitHold });
        const measured = await bounded(async () => { await runtime.prepare?.(); return check.run(runtime); }, check.capMs, controller);
        if (measured?.skipReason) { row.reason = measured.skipReason; row.measured = measured.measured ?? {}; }
        else { row.status = 'pass'; row.measured = measured ?? {}; }
      } catch (error) { row.status = 'fail'; row.reason = String(error.message ?? error); row.measured = runtime?.measured ?? {}; }
      finally {
        controller.abort(Error('Check finished'));
        dependencies.signal?.removeEventListener('abort', abort);
        try {
          row.cleanup = runtime ? await runtime.close() : { cleanedUp: true };
          if (row.cleanup?.cleanedUp !== true) safe = false;
        } catch (error) { safe = false; row.cleanup = { cleanedUp: false, reason: error.message }; }
        if (!safe) { row.status = 'fail'; row.reason = [row.reason, 'Cleanup unproved'].filter(Boolean).join('; '); }
        row.ms = Math.round(performance.now() - started);
      }
    }
  } catch (error) {
    report.error = error.message;
    for (const id of options.checks) if (!report.checks.some(c => c.id === id)) report.checks.push({ id, status: 'skip', ms: 0,
      capMs: definitions.find(c => c.id === id)?.capMs, measured: {}, reason: error.message });
  } finally {
    report.cleanup = safe;
    if (unlock && safe) try { await unlock(); report.lockReleased = true; }
    catch (error) { report.lockRetained = true; report.cleanup = false; report.lockError = error.message; }
    else if (unlock) report.lockRetained = true;
    report.finished = new Date().toISOString();
    report.counts = Object.fromEntries(['pass', 'fail', 'skip'].map(status => [status, report.checks.filter(c => c.status === status).length]));
    report.completed = !report.error && report.cleanup;
    report.passed = report.completed && report.checks.every(c => c.status === 'pass');
    report.output = await publish(report);
  }
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv), controller = new AbortController();
  const abort = () => controller.abort(Error('Run interrupted'));
  if (!options.dryRun) { process.once('SIGINT', abort); process.once('SIGTERM', abort); }
  try {
    const report = await runLiveChecks(options, { signal: controller.signal });
    console.log(JSON.stringify(scrub(report), null, 2));
    if (!options.dryRun && (!report.completed || report.counts.fail > 0)) process.exitCode = 1;
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // No top-level await: the runtime module imports OwnedTools from this file, and a dynamic import of it while this module
  // is still evaluating would wait on itself forever (exit 13, 2026-10-25).
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
