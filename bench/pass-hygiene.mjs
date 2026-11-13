import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runOwned } from './preapproved-process.mjs';
import { swiftModuleCache } from './swift-cache.mjs';

const processKey = item => `${item.pid}:${Math.round(item.start * 1000)}:${item.bundle}`;
const windowKey = item => `${processKey(item)}:${item.id}`;
const identity = ({ pid, start, bundle }) => ({ pid, start, bundle });
const valid = item => Number.isSafeInteger(item.pid) && item.pid > 0 && Number.isFinite(item.start) && item.start > 0 && typeof item.bundle === 'string' && item.bundle.length > 0;

function matchesFixture(window, { fixturePaths = [], fixtureNames = [] }) {
  let document = window.document;
  if (typeof document === 'string' && document.startsWith('file:')) {
    try { document = fileURLToPath(document); } catch { document = undefined; }
  }
  return fixtureNames.includes(window.title) || fixturePaths.some(path => typeof document === 'string' &&
    (document === path || document.startsWith(path + sep)));
}

// Include off-screen baseline windows too: changing Spaces never transfers ownership.
export function planWindows(before, after, launched = [], touchedApps = [], armPids = [], touchedProcesses = new Map(), fixtures = {}) {
  const oldWindows = new Set(before.windows.map(windowKey)), oldApps = new Set(before.apps.map(processKey));
  const owned = new Set(launched.filter(valid).map(processKey)), quits = new Set();
  const members = new Set(armPids), processes = after.processes ?? [];
  for (let grew = true; grew;) {
    grew = false;
    for (const proc of processes) if (members.has(proc.ppid) && !members.has(proc.pid)) { members.add(proc.pid); grew = true; }
  }
  const attributed = window => owned.has(processKey(window)) || members.has(window.pid) ||
    processes.some(proc => proc.pid === window.pid && touchedProcesses.get(proc.pid) === proc.start && Math.round(proc.start * 1000) === Math.round(window.start * 1000));
  const touched = window => attributed(window) || touchedApps.includes(window.bundle) || touchedApps.includes(window.name);
  const plan = [];
  for (const window of after.windows) {
    if (!valid(window) || !Number.isSafeInteger(window.id) || oldWindows.has(windowKey(window))) continue;
    const key = processKey(window);
    if (owned.has(key) && !oldApps.has(key) && !before.windows.some(old => processKey(old) === key)) {
      if (!quits.has(key)) { plan.push({ ...identity(window), action: 'quit' }); quits.add(key); }
    } else {
      const fixture = matchesFixture(window, fixtures);
      plan.push({ ...window, action: touched(window) && (fixture || (!oldApps.has(key) && attributed(window))) ? 'close' : 'keep',
        ...(fixture && { fixtures }) });
    }
  }
  for (const app of after.apps.filter(valid)) {
    const key = processKey(app);
    if (owned.has(key) && !oldApps.has(key) && !quits.has(key) && !before.windows.some(old => processKey(old) === key)) {
      plan.push({ ...identity(app), action: 'quit' }); quits.add(key);
    }
  }
  return plan;
}

export async function finishWindows(before, { snapshot, act, launched = [], daemons = [], dryRun = false,
  touchedApps = [], armPids = [], touchedProcesses = new Map(), fixturePaths = [], fixtureNames = [], daemonPaths = [], blocked = false, beforeAction = async () => {}, log = console.log } = {}) {
  const result = { planned: [], leftWindows: [], errors: [] };
  for (const daemon of daemons) {
    log(`${dryRun ? 'would stop' : 'stop'} owned daemon ${daemon.name ?? ''}`);
    if (!dryRun) try { await daemon.stop(); } catch (error) { result.errors.push(error.message); }
  }
  let current;
  try { current = await snapshot(); }
  catch (error) { blocked = true; result.errors.push(error.message); }
  // A discovery timeout must not prevent exact launch receipts from getting their gentle Quit.
  const known = current ?? { apps: launched, windows: [] };
  result.planned = planWindows(before, known, launched, touchedApps, armPids, touchedProcesses, { fixturePaths, fixtureNames });
  const oldProcesses = new Set((before.processes ?? []).map(proc => `${proc.pid}:${proc.start}`));
  for (const proc of current?.processes ?? []) {
    if (daemonPaths.includes(proc.path) && proc.start > before.at && !oldProcesses.has(`${proc.pid}:${proc.start}`)) {
      const item = { ...proc, action: 'stop' };
      result.planned.unshift(item);
      log(`${dryRun ? 'would stop' : 'stop'} owned daemon ${JSON.stringify(item)}`);
      if (!dryRun) try { await act(item); } catch (error) { result.errors.push(error.message); }
    }
  }
  const stoppedApps = new Set(), phantoms = new Set(), dialogs = new Map();
  for (const item of result.planned.filter(item => item.action !== 'stop')) {
    log(`${dryRun ? 'would ' : blocked && item.action === 'close' ? 'kept: ' : ''}${item.action} ${JSON.stringify(item)}`);
    if (item.action === 'keep' || dryRun || stoppedApps.has(processKey(item)) || (blocked && item.action === 'close')) continue;
    if (item.action === 'close') {
      try { await beforeAction(); }
      catch (error) { blocked = true; result.errors.push(error.message); continue; }
    }
    try {
      const outcome = await act(item);
      if (outcome?.skipped === 'no-ax-window' && item.onScreen === false) phantoms.add(windowKey(item));
      if (outcome?.dialog) { stoppedApps.add(processKey(item)); dialogs.set(processKey(item), identity(item)); }
    } catch (error) { result.errors.push(error.message); stoppedApps.add(processKey(item)); }
  }
  let after = current;
  if (!dryRun) try { after = await snapshot(); } catch (error) { result.errors.push(error.message); }
  result.leftWindows = after ? planWindows(before, after).filter(item => item.onScreen !== false || !phantoms.has(windowKey(item))).map(({ action, ...window }) => window) : [];
  for (const item of result.planned.filter(item => item.action === 'quit')) {
    if ((!after || after.apps.some(app => processKey(app) === processKey(item))) && !result.leftWindows.some(window => processKey(window) === processKey(item))) {
      result.leftWindows.push({ ...identity(item), reason: after ? 'still running after Quit' : 'Quit unconfirmed: snapshot unavailable' });
    }
  }
  labelDialogs(result.leftWindows, after, dialogs);
  for (const item of result.leftWindows) log(`leftWindows ${JSON.stringify(item)}`);
  return result;
}

// The label goes on the dialog's own window, never on another window of the same app. A dialog
// the helper met while acting carries no window ID, so it is listed by process unless the final
// snapshot names its window.
function labelDialogs(leftWindows, after, dialogs = new Map()) {
  const label = window => Object.assign(window, { reason: 'application dialog',
    instruction: 'Resolve the application dialog manually before the next pass; hygiene left it unanswered.' });
  for (const window of after?.windows ?? []) if (window.dialog) {
    label(leftWindows.find(item => windowKey(item) === windowKey(window)) ?? leftWindows[leftWindows.push({ ...window }) - 1]);
    dialogs.delete(processKey(window));
  }
  for (const dialog of dialogs.values()) {
    label(leftWindows.find(item => item.id === undefined && processKey(item) === processKey(dialog)) ?? leftWindows[leftWindows.push({ ...dialog }) - 1]);
  }
}

// Without a baseline no window can be told apart from the owner's, so nothing closes. Exact launch
// receipts still get the one gentle Quit; a Save sheet stays unanswered and the app is listed.
export async function quitLaunched({ snapshot, act, launched = [], dryRun = false, log = console.log } = {}) {
  const result = { planned: [], leftWindows: [], errors: [] };
  for (const item of launched.filter(valid)) {
    if (!result.planned.some(quit => processKey(quit) === processKey(item))) result.planned.push({ ...identity(item), action: 'quit' });
  }
  for (const item of result.planned) {
    log(`${dryRun ? 'would ' : ''}quit ${JSON.stringify(item)}`);
    if (!dryRun) try { await act(item); } catch (error) { result.errors.push(error.message); }
  }
  if (dryRun || !result.planned.length) return result;
  let after;
  try { after = await snapshot(); } catch (error) { result.errors.push(error.message); }
  for (const item of result.planned) {
    if (after && !after.apps.some(app => processKey(app) === processKey(item))) continue;
    const sheets = (after?.windows ?? []).filter(window => window.dialog && processKey(window) === processKey(item));
    result.leftWindows.push(...sheets.length ? sheets.map(window => ({ ...window }))
      : [{ ...identity(item), reason: after ? 'still running after Quit' : 'Quit unconfirmed: snapshot unavailable' }]);
  }
  labelDialogs(result.leftWindows, { windows: result.leftWindows.filter(window => window.dialog) });
  for (const item of result.leftWindows) log(`leftWindows ${JSON.stringify(item)}`);
  return result;
}

// Compile and invoke only inside the runner's live lock, never on import or a planning dry run.
export async function beginWindowControl({ home = homedir(), cacheDir = join(home, 'Library', 'Caches', 'sleight-bench', 'window-control'),
  run = runOwned, signal, includeFloating = false } = {}) {
  const source = fileURLToPath(new URL('./pass-hygiene.swift', import.meta.url));
  const checked = async (command, args, options) => {
    const result = await run(command, args, options);
    if (result.groupClean !== true) throw Object.assign(new Error('Pass hygiene process group cleanup unconfirmed'), { uncollected: true });
    if (result.exit?.code !== 0 || result.timedOut || result.cancelled || result.spawnError) {
      throw new Error(`Pass hygiene helper failed: ${result.stderr?.trim() || result.spawnError || result.exit?.code}`);
    }
    return result.stdout;
  };
  const version = await checked('/usr/bin/xcrun', ['swiftc', '--version'], { timeoutMs: 10000, signal });
  const hash = createHash('sha256').update(readFileSync(source)).update('\0').update(version).digest('hex').slice(0, 16);
  mkdirSync(cacheDir, { recursive: true });
  const binary = join(cacheDir, `pass-hygiene-${hash}`);
  if (!existsSync(binary)) {
    const bank = mkdtempSync(join(cacheDir, 'pass-hygiene-build-')), output = join(bank, 'helper');
    const modules = swiftModuleCache(home);
    let uncollected = false;
    try {
      await checked('/usr/bin/xcrun', ['swiftc', '-module-cache-path', modules, source, '-o', output], { timeoutMs: 180000, signal });
      renameSync(output, binary);
    } catch (error) { uncollected = error.uncollected === true; throw error; }
    finally { if (!uncollected) rmSync(bank, { recursive: true, force: true }); }
  }
  const call = async request => JSON.parse(await checked(binary, [JSON.stringify(request)], { timeoutMs: 10000 }));
  const snapshot = async () => {
    const value = await call({ action: 'snapshot', ...(includeFloating && { includeFloating: true }) });
    if (!value || !Array.isArray(value.apps) || !Array.isArray(value.windows) || !value.apps.every(valid) ||
      !value.windows.every(window => valid(window) && Number.isSafeInteger(window.id) && window.id > 0 &&
        value.apps.some(app => processKey(app) === processKey(window)))) {
      throw new Error('Pass hygiene snapshot unavailable or incomplete');
    }
    return value;
  };
  return { snapshot, act: call };
}

export async function beginPassHygiene(options = {}) {
  const { snapshot, act: call } = await beginWindowControl(options);
  let baselineError;
  // A failed baseline still returns a receipts-only handle on the error: boundary snapshots can
  // prove later launches, and finish quits only those and the leases' receipts. An uncollected
  // helper gets no handle, so no further helper runs.
  let before;
  try { before = await snapshot(); } catch (error) { if (error.uncollected) throw error; baselineError = error; }
  const launches = [], members = new Map(), trackingErrors = [], roots = new Map();
  let latest = before, pendingLaunch, trackingErrorCount = 0;
  const recordError = error => {
    trackingErrorCount++;
    if (trackingErrors.length < 20) trackingErrors.push(error.message);
  };
  const observe = value => {
    const processes = value.processes ?? [], live = new Map(processes.map(proc => [proc.pid, proc]));
    for (const [pid, registeredAt] of roots) {
      const root = live.get(pid);
      if (root && root.start > (before?.at ?? 0) && root.start <= registeredAt && !members.has(pid)) members.set(pid, root.start);
    }
    roots.clear();
    for (let grew = true; grew;) {
      grew = false;
      for (const proc of processes) {
        const parent = live.get(proc.ppid);
        if (parent && members.get(parent.pid) === parent.start && members.get(proc.pid) !== proc.start) {
          members.set(proc.pid, proc.start); grew = true;
        }
      }
    }
    if (pendingLaunch) {
      launches.push(...value.apps.filter(app => !pendingLaunch.existing.has(processKey(app)) &&
        (pendingLaunch.apps.includes(app.bundle) || pendingLaunch.apps.includes(app.name))));
      pendingLaunch = undefined;
    }
    latest = value;
    return value;
  };
  const handle = {
    // Registration runs from onSpawn, inside task timing. Inventory waits for a boundary.
    recordArm(pid) { roots.set(pid, Date.now() / 1000); },
    async betweenTasks() {
      try { observe(await snapshot()); }
      catch (error) { recordError(error); latest = undefined; pendingLaunch = undefined; roots.clear(); }
    },
    async trackLaunch(apps, operation) {
      pendingLaunch = latest && { apps, existing: new Set(latest.apps.map(processKey)) };
      return operation();
    },
    get hygieneError() {
      return trackingErrorCount ? { errors: [...trackingErrors], count: trackingErrorCount } : undefined;
    },
    async finish(options = {}) {
      if (pendingLaunch) await this.betweenTasks();
      const launched = [...launches, ...(options.launched ?? [])], observed = async () => observe(await snapshot());
      const result = before ? await finishWindows(before, { ...options, armPids: [], launched, snapshot: observed, act: call, touchedProcesses: members })
        : await quitLaunched({ launched, snapshot: observed, act: call, dryRun: options.dryRun, log: options.log });
      result.errors.push(...trackingErrors);
      result.trackingErrors = [...trackingErrors];
      result.trackingErrorCount = trackingErrorCount;
      return result;
    },
  };
  if (baselineError) throw Object.assign(baselineError, { receiptsOnly: handle });
  return handle;
}
