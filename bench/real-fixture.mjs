import { execFile } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runOwned } from './preapproved-process.mjs';
import { heliumHelper } from './real-helium.mjs';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('./real-fixture.js', import.meta.url));

// Finder receipts contain only fixed identifiers, numeric evidence and flags.
// Titles, paths, dialog text and raw helper output never enter this schema.
const finderEnums = {
  stage: ['identified', 'identified-process', 'armed', 'ready', 'closed', 'setup-failure', 'untouched', 'action', 'retry',
    'finder-relaunch', 'finder-recovered', 'finder-window-retained', 'finder-folder-submitted', 'finder-failure', 'menu-items', 'menu-cancel', 'readiness'],
  app: ['Finder'], bundle: ['com.apple.finder'], observedBundle: ['com.apple.finder'],
  cleanup: ['nothing created', 'closed retained fixture', 'unconfirmed'],
  setupCase: ['already-running', 'cold-launch'], attribute: ['AXWindows', 'AXRole', 'AXValue', 'AXFocusedWindow'],
  reason: ['three AXWindows timeouts', 'malformed-list', 'missing-element', 'failed-self-identity', 'non-window-or-stale', 'duplicate-identity'],
  identityReason: ['target-unavailable', 'bundle-mismatch', 'pid-invalid', 'start-unavailable', 'pid-changed', 'start-changed', 'terminated'],
  role: ['AXWindow', 'AXSheet', 'AXDialog', 'AXGroup', 'AXButton'], phase: ['cleanup', 'observation'],
  roleReadCode: [0, -25212, -25202, 'other'], roleState: ['nil', 'empty', 'known-nonwindow', 'other-string', 'nonstring'],
  roleKnown: ['AXApplication', 'AXSystemWide', 'AXWindow', 'AXSheet', 'AXDrawer', 'AXDialog', 'AXGroup', 'AXButton', 'AXScrollArea', 'AXUnknown'],
  roleNativeType: ['cf-string', 'other', 'unavailable'], roleNativeWindowEqual: ['yes', 'no', 'unavailable'],
  roleDeepWindowEqual: ['yes', 'no', 'unavailable'],
  failureReason: ['unclassified', 'ledger-unconfirmed', 'inventory-unconfirmed', 'baseline-changed', 'previous-absent',
    'window-before-new-command', 'new-window-ambiguous', 'new-window-unconfirmed', 'new-window-identity-changed', 'foreign-dialog',
    'window-vanished', 'window-focus-lost', 'window-focus-changed', 'focused-ancestry-unconfirmed', 'menu-unavailable',
    'menu-item-unavailable', 'ax-read-failed', 'ax-press-failed', 'ax-write-failed', 'opening-interrupted', 'retained-reference-unavailable',
    'fixture-location-mismatch', 'fixture-ownership-unconfirmed', 'extra-window-unconfirmed', 'fixture-identity-changed',
    'fixture-still-open', 'dialog-present', 'menu-cancel-target-unconfirmed', 'menu-cancel-failed', 'cancellation-app-identity-lost'],
  errorName: ['unavailable', 'other', 'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError',
    'NSInvalidArgumentException', 'NSRangeException', 'NSInternalInconsistencyException', 'NSUnknownKeyException', 'NSGenericException'],
  errorCode: ['unavailable', 'other', 0, -25200, -25201, -25202, -25203, -25204, -25205, -25206, -25207, -25208, -25209,
    -25210, -25211, -25212, -25213, -25214],
  command: ['new-window', 'go-to-folder'], menuCancelMethod: ['AXCancel'],
};
const finderNumbers = new Set(['pid', 'fromPid', 'toPid', 'startedAtMs', 'fromStartedAtMs', 'toStartedAtMs',
  'processStartedAtMs', 'code', 'count', 'index', 'duplicateIndex', 'axCode', 'waitMs', 'totalWaitMs', 'elapsedMs', 'enabled']);
const finderFlags = new Set(['running', 'launched', 'fresh', 'actionTaken', 'referenceExported', 'originalExitConfirmed', 'appAbsent',
  'windowCleanupConfirmed', 'helperCollectionConfirmed', 'menuCancelled', 'finished', 'titleMatches', 'appQuit', 'stop']);
const finderObjects = new Set(['finderRelaunch', 'finderRecovery', 'finderAXError', 'finderFailure', 'finderCleanupFailure',
  'finderMenuCleanupFailure', 'readiness', 'appDialog', 'diagnostic']);
const finderLists = new Set(['menuCommands', 'retries', 'cleanupRetries', 'observationRetries']);
const finderBirths = new Set(['pidBirth', 'fromPidBirth', 'toPidBirth']);
export function finderDiagnostic(value, depth = 0) {
  const safe = {};
  if (!value || typeof value !== 'object' || depth > 6) return safe;
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(finderEnums[key]) && finderEnums[key].includes(item)) safe[key] = item;
    else if (finderBirths.has(key) && typeof item === 'string' && /^[1-9][0-9]{0,15}\.[0-9]{6}$/.test(item) &&
      item.length === item.trim().length && Number.isSafeInteger(Number(item.split('.')[0]))) safe[key] = item;
    else if (finderNumbers.has(key) && typeof item === 'number' && Number.isFinite(item)) safe[key] = item;
    else if (finderFlags.has(key) && typeof item === 'boolean') safe[key] = item;
    else if (['cleanupError', 'menuCleanupError', 'closeFailure'].includes(key) && item) safe[key] = true;
    else if (finderObjects.has(key) && item && typeof item === 'object') safe[key] = finderDiagnostic(item, depth + 1);
    else if (finderLists.has(key) && Array.isArray(item)) safe[key] = item.slice(0, 128).map(value => finderDiagnostic(value, depth + 1));
  }
  return safe;
}
export function finderFailureDiagnostic(error) {
  const text = String(error?.message ?? error ?? '');
  const diagnostic = {};
  const reason = /reason=(malformed-list|missing-element|failed-self-identity|non-window-or-stale|duplicate-identity)(?=[ \]])/.exec(text);
  if (reason) diagnostic.reason = reason[1];
  const role = /role=(AXWindow|AXSheet|AXDialog|AXGroup|AXButton)(?=[ \]])/.exec(text);
  if (role) diagnostic.role = role[1];
  for (const key of ['count', 'index', 'duplicateIndex']) {
    const match = new RegExp('(?: |\\[)' + key + '=(\\d+)(?=[ \\]])').exec(text);
    if (match && Number.isSafeInteger(Number(match[1]))) diagnostic[key] = Number(match[1]);
  }
  const axCode = /(?: |\[)axCode=(-?\d+)(?=[ \]])/.exec(text);
  if (axCode && Number.isSafeInteger(Number(axCode[1]))) diagnostic.axCode = Number(axCode[1]);
  const roleReadCode = /(?: |\[)roleReadCode=(0|-25212|-25202|other)(?=[ \]])/.exec(text);
  if (roleReadCode) diagnostic.roleReadCode = roleReadCode[1] === 'other' ? 'other' : Number(roleReadCode[1]);
  const roleState = /(?: |\[)roleState=(nil|empty|known-nonwindow|other-string|nonstring)(?=[ \]])/.exec(text);
  if (roleState) diagnostic.roleState = roleState[1];
  const roleKnown = /(?: |\[)roleKnown=(AXApplication|AXSystemWide|AXWindow|AXSheet|AXDrawer|AXDialog|AXGroup|AXButton|AXScrollArea|AXUnknown)(?=[ \]])/.exec(text);
  if (roleKnown) diagnostic.roleKnown = roleKnown[1];
  for (const [key, values] of [['roleNativeType', 'cf-string|other|unavailable'], ['roleNativeWindowEqual', 'yes|no|unavailable'],
    ['roleDeepWindowEqual', 'yes|no|unavailable']]) {
    const match = new RegExp('(?: |\\[)' + key + '=(' + values + ')(?=[ \\]])').exec(text);
    if (match) diagnostic[key] = match[1];
  }
  const ax = /AX fixture read failed: (-25204|-25205|-25202) \((AXWindows|AXFocusedWindow|AXRole|AXValue)\)/.exec(text);
  if (ax) { diagnostic.code = Number(ax[1]); diagnostic.attribute = ax[2]; }
  return diagnostic;
}
function finderHelperFailure(error, failure) {
  const diagnostic = finderFailureDiagnostic(error);
  Object.assign(diagnostic, finderDiagnostic({ finderFailure: failure }).finderFailure);
  return 'Finder helper failed' + (Object.keys(diagnostic).length ? ' [' + Object.entries(diagnostic).map(([k, v]) => `${k}=${v}`).join(' ') + ']' : '');
}

// Setup capabilities belong to browser data. The older Firefox grid/spa tasks
// retain their IDs and setup outside this catalog.
export const webBrowsers = [
  { id: 'safari', app: 'Safari', bundle: 'com.apple.Safari', extension: false, legacyKinds: [], fixtureHelper: 'created-window', fixtureLaunch: 'retained-url' },
  { id: 'helium', app: 'Helium', bundle: 'net.imput.helium', extension: true, legacyKinds: [], fixtureHelper: 'created-window', fixtureLaunch: 'new-instance' },
  { id: 'chrome', app: 'Google Chrome', bundle: 'com.google.Chrome', extension: true, legacyKinds: [], fixtureHelper: 'accessibility', fixtureLaunch: 'file-menu' },
  { id: 'firefox', app: 'Firefox', bundle: 'org.mozilla.firefox', extension: false, legacyKinds: ['grid', 'spa'], fixtureHelper: 'accessibility', fixtureLaunch: 'file-menu' },
  { id: 'arc', app: 'Arc', bundle: 'company.thebrowser.Browser', extension: true, legacyKinds: [], fixtureHelper: 'accessibility', fixtureLaunch: 'file-menu' },
];

// A long-lived JXA host read an owned Excel process as gone while an independent inspector found the same pid alive
// (Office investigation, 2026-10-17). An exit the JXA helpers report counts only when the kernel agrees: no such pid,
// another user's process, a zombie, or one that started after the launched app did (a reused pid).
export async function processExitConfirmed(pid, startedAtMs, { kill = (id, signal) => process.kill(id, signal), ps = processState } = {}) {
  if (!(Number.isInteger(pid) && pid > 0)) return false;
  try { kill(pid, 0); } catch (error) { if (error.code === 'ESRCH' || error.code === 'EPERM') return true; throw error; }
  const state = await ps(pid);
  if (!state || state.zombie) return true;
  return startedAtMs > 0 && state.startedAtMs > startedAtMs + 5000;
}

async function processState(pid) {
  let stdout;
  try { ({ stdout } = await execute('/bin/ps', ['-o', 'stat=', '-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' }, timeout: 5000 })); }
  catch (error) { if (error.code === 1 && !String(error.stdout ?? '').trim()) return null; throw error; }
  const match = /^\s*(\S+)\s+(.+?)\s*$/.exec(stdout);
  if (!match) throw new Error(`Process ${pid} state unreadable`);
  return { zombie: match[1].startsWith('Z'), startedAtMs: new Date(match[2]).getTime() };
}

async function fixtureHelper(request, signal) {
  return webBrowsers.find(browser => browser.bundle === request.bundle)?.fixtureHelper === 'created-window'
    ? { command: await heliumHelper(signal), args: [] }
    : { command: '/usr/bin/osascript', args: ['-l', 'JavaScript', script] };
}

// The child retains its AX window reference through cleanup. Finder also retains
// its baseline inventory so cleanup can refuse extra windows without adopting
// them by path. Only explicit creation identities permit closing.
// A document app launched without these restores the owner's windows and iCloud "Untitled" documents (TextEdit did, 2026-10-16),
// and then can't quit cleanly. The other bench launchers pass the same flags (bench/tasks.mjs).
const DOCUMENT_LAUNCH = ['--args', '-ApplePersistenceIgnoreState', 'YES', '-NSShowAppCentricOpenPanelInsteadOfUntitledFile', 'NO',
  '-NSDocumentSaveNewDocumentsToCloud', 'NO'];
export async function openFixture(ctx, request, { run = runOwned, open = execute, launch, helper = fixtureHelper, exited = processExitConfirmed, log = console.error } = {}) {
  const finderFolder = request.bundle === 'com.apple.finder' && request.mode === 'folder';
  const fixtureLaunch = webBrowsers.find(browser => browser.bundle === request.bundle)?.fixtureLaunch;
  const createdWindow = ['retained-url', 'new-instance'].includes(fixtureLaunch);
  const blankWindow = fixtureLaunch === 'retained-url' || (request.fixtureKind === 'web-page' && fixtureLaunch !== 'new-instance');
  if ((request.fixtureKind === 'web-page' || fixtureLaunch === 'retained-url') && ctx.ownerAway !== true) {
    throw Object.assign(new Error('Browser blank-window setup requires an explicit owner-away boundary'), { noMutation: true });
  }
  request = { ...request, runToken: ctx.nonce || request.runToken, fixtureLaunch,
    ...(request.bundle === 'com.apple.finder' && request.mode === 'folder' && { fixtureRoot: ctx.fixtureRoot || ctx.dir }),
    stopOnAppDialog: ctx.stopOnAppDialog || request.stopOnAppDialog, ownerAway: ctx.ownerAway === true };
  ctx.signal?.throwIfAborted();
  ctx.cleanupSignal?.throwIfAborted();
  const startedAtMs = Date.now();
  ctx.windowLeases ??= [];
  const launchedProcesses = ctx.windowLeases.filter(lease => lease.launched && lease.running === false &&
    lease.setupCase === 'cold-launch' && lease.bundle === request.bundle && lease.pid > 0 && lease.processStartedAtMs > 0)
    .map(({ pid, bundle, processStartedAtMs }) => ({ pid, bundle, processStartedAtMs }));
  const control = join(ctx.dir, `window-${ctx.windowLeases.length}-control.json`);
  const signal = ctx.signal;
  const controller = new AbortController();
  // Ordinary cancellation still needs this child's retained window reference.
  // A permission stop ends all AX activity immediately instead.
  const helperSignal = AbortSignal.any([controller.signal, ctx.cleanupSignal].filter(Boolean));
  const stages = new Map();
  const diagnostics = { app: request.app, bundle: request.bundle, retries: [], totalWaitMs: 0, actionTaken: false };
  if (finderFolder) diagnostics.launched = false;
  (ctx.fixtureDiagnostics ??= []).push(diagnostics);
  const stage = name => {
    if (!stages.has(name)) stages.set(name, Promise.withResolvers());
    return stages.get(name);
  };
  // A disagreement keeps the live lock: executeRealTask and the runner read ctx.exitDisagreements before releasing it.
  const confirmExit = async (processes, step) => {
    for (const { pid, processStartedAtMs } of processes) {
      let gone = false, failure;
      try { gone = await exited(pid, processStartedAtMs); } catch (error) { failure = error.message; }
      if (gone) continue;
      diagnostics.cleanup = 'unconfirmed';
      diagnostics.exitDisagreement = { step, pid, ...(failure && { failure }) };
      (ctx.exitDisagreements ??= []).push({ app: request.app, bundle: request.bundle, step, pid });
      throw new Error(`Owned ${request.app} exit disagreement after ${step}: the JXA helper read pid ${pid} as gone, ` +
        `${failure ? `and the independent check failed (${failure})` : 'but the process is still running'}; live lock kept`);
    }
  };
  let buffer = '', response, completed;
  const untouched = result => result.groupClean === true && result.stdout?.split('\n').some(line => {
    try {
      const event = JSON.parse(line);
      return event.stage === 'untouched' || (event.stage === 'setup-failure' &&
        ['nothing created', 'closed retained fixture', 'unconfirmed'].includes(event.cleanup) &&
        (!(createdWindow || finderFolder) || event.cleanup !== 'unconfirmed') && !event.cleanupError);
    } catch { return false; }
  });
  const lease = {
    app: request.app,
    pids: [],
    launched: false,
    diagnostics,
    // The cold-launch lease of this run whose exact process (pid, bundle, start time) this lease attached to, if any.
    ownerLease() {
      if (lease.running !== true || !(lease.pid > 0) || !(lease.processStartedAtMs > 0) || lease.bundle !== request.bundle) return undefined;
      if (!launchedProcesses.some(item => item.pid === lease.pid && item.bundle === request.bundle &&
        item.processStartedAtMs === lease.processStartedAtMs)) return undefined;
      return ctx.windowLeases.find(other => other !== lease && other.running === false && other.launched && other.setupCase === 'cold-launch' &&
        other.pid === lease.pid && other.bundle === request.bundle && other.processStartedAtMs === lease.processStartedAtMs);
    },
    async quit({ final = false } = {}) {
      if (lease.running !== false || !lease.launched || request.app === 'Finder' || diagnostics.appQuit) return;
      if (createdWindow && diagnostics.windowCleanupConfirmed !== true) {
        throw new Error(`Owned ${request.app} window cleanup unconfirmed; app quit refused`);
      }
      const collected = await lease.dispose();
      diagnostics.helperCollectionConfirmed = collected;
      if (!collected && !final) throw new Error('Fixture helper collection unconfirmed; app quit refused');
      // Office may answer only the exact owned file's Don't Save sheet, after
      // checking the launched PID, bundle and start time again.
      if (!final) { await ctx.beforeFixtureCleanup?.(); ctx.cleanupSignal?.throwIfAborted(); }
      if (!lease.pid) throw new Error('Launched app identity unconfirmed; quit refused');
      const result = await run('/usr/bin/osascript', ['-l', 'JavaScript', script,
        JSON.stringify({ bundle: lease.bundle || request.bundle, mode: 'quit', pid: Number(lease.pid),
          ...(lease.processStartedAtMs > 0 && { processStartedAtMs: lease.processStartedAtMs }),
          ...(/^com\.microsoft\.(Word|Excel)$/.test(request.bundle) && request.mode === 'document' && {
            fixture: { mode: request.mode, target: request.target, token: request.token, runToken: request.runToken,
              ...(diagnostics.fixtureWindow && { fixtureWindow: diagnostics.fixtureWindow }) } }),
          ...(request.fixtureKind && { fixtureKind: request.fixtureKind, target: request.target }), ...(request.stopOnLiveHold && { stopOnLiveHold: true }) })], {
        signal: final ? undefined : ctx.cleanupSignal, timeoutMs: 35000,
      });
      for (const line of result.stdout?.split('\n') ?? []) {
        try {
          const event = JSON.parse(line);
          if (event.stage === 'quit' && event.quitWait) diagnostics.quitWait = event.quitWait;
          if (event.fixtureSheet) (diagnostics.fixtureSheets ??= []).push(event.fixtureSheet);
        } catch {}
      }
      if (!result.groupClean || result.exit?.code !== 0) throw new Error(`Launched ${request.app} quit unconfirmed${result.stderr?.trim() ? ': ' + result.stderr.trim() : ''}`);
      await confirmExit([{ pid: Number(lease.pid), processStartedAtMs: lease.processStartedAtMs }], 'quit');
      diagnostics.appQuit = true;
    },
    async close() {
      if (completed && untouched(completed)) { diagnostics.windowCleanupConfirmed = true; return; }
      if (ctx.cleanupSignal?.aborted) { await lease.dispose(); throw new Error('Fixture cleanup stopped by a permission window'); }
      writeControl('close');
      let timer;
      const result = await Promise.race([response, new Promise(resolve => { timer = setTimeout(() => {
        controller.abort(); resolve({ error: 'Fixture cleanup timed out', groupClean: false });
      }, 30000); })]).finally(() => clearTimeout(timer));
      if (untouched(result)) { diagnostics.windowCleanupConfirmed = true; return; }
      const closed = result.stdout?.split('\n').map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(event => event?.stage === 'closed');
      if (!result.groupClean || result.error || result.exit.code !== 0 || !closed) {
        diagnostics.closeFailure = result.stderr?.trim() || result.error;
        diagnostics.cleanup = 'unconfirmed';
        throw new Error(`Owned ${request.app} fixture window cleanup unconfirmed${diagnostics.closeFailure ? ': ' + diagnostics.closeFailure : ''}`);
      }
      // The helper skips the close when it reads the app as gone. That read came from a long-lived host, so the kernel must agree.
      if (closed.appAbsent === true) await confirmExit([{ pid: Number(lease.pid), processStartedAtMs: lease.processStartedAtMs }], 'window cleanup');
      diagnostics.windowCleanupConfirmed = true;
    },
    async recover() {
      if (request.mode !== 'document') throw new Error('Fixture recovery requires a document fixture');
      // A second document opened in the app an earlier lease of this run launched (textedit-two-windows and
      // textedit-window-drag). That lease recovers first and quits the app, which takes this window with it, so this one
      // only confirms the exact process is gone. Before this, such a cleanup failure stopped its pass (2 on 2026-10-19).
      const owner = createdWindow || !lease.launched ? undefined : lease.ownerLease();
      if (owner) {
        if (owner.diagnostics.appQuit !== true) throw new Error('Fixture recovery requires the launching lease to quit its app first');
        diagnostics.appQuit = false;
        diagnostics.helperCollectionConfirmed = await lease.dispose();
        if (!diagnostics.helperCollectionConfirmed) throw new Error('Fixture helper collection unconfirmed; recovery refused');
        await confirmExit([{ pid: Number(lease.pid), processStartedAtMs: lease.processStartedAtMs }], 'recovery');
        diagnostics.cleanup = 'closed with launched app';
        diagnostics.windowCleanupConfirmed = true;
        diagnostics.appQuit = true;
        return;
      }
      if (createdWindow || lease.running !== false || !lease.launched) throw new Error('Fixture recovery requires an app launched by this run');
      diagnostics.appQuit = false;
      diagnostics.helperCollectionConfirmed = await lease.dispose();
      if (!diagnostics.helperCollectionConfirmed) throw new Error('Fixture helper collection unconfirmed; recovery refused');
      await ctx.beforeFixtureCleanup?.();
      ctx.cleanupSignal?.throwIfAborted();
      const result = await run('/usr/bin/osascript', ['-l', 'JavaScript', script, JSON.stringify({
        ...request, mode: 'recover', fixtureMode: request.mode, running: lease.running, launched: lease.launched,
        fixtureDir: ctx.dir, runToken: ctx.nonce || request.token, startedAtMs,
        fixtureWindows: ctx.windowLeases.filter(other => other.pid === lease.pid &&
          other.processStartedAtMs === lease.processStartedAtMs && other.bundle === lease.bundle)
          .map(other => other.diagnostics.fixtureWindow).filter(Boolean),
        pids: [...new Set([...lease.pids, lease.pid].filter(pid => Number.isInteger(pid) && pid > 0))],
      })], { signal: ctx.cleanupSignal, timeoutMs: 90000 });
      const receipt = result.stdout?.split('\n').map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(event => event?.stage === 'recovered');
      if (!result.groupClean || result.exit?.code !== 0 || !receipt) throw new Error(`Owned ${request.app} fixture recovery unconfirmed${result.stderr?.trim() ? ': ' + result.stderr.trim() : ''}`);
      const starts = new Map((Array.isArray(receipt.processes) ? receipt.processes : []).map(item => [item.pid, item.processStartedAtMs]));
      if (lease.pid > 0 && lease.processStartedAtMs > 0) starts.set(lease.pid, lease.processStartedAtMs);
      const quitPids = [...new Set([lease.pid, ...(Array.isArray(receipt.pids) ? receipt.pids : [])].filter(pid => Number.isInteger(pid) && pid > 0))];
      await confirmExit(quitPids.map(pid => ({ pid, processStartedAtMs: starts.get(pid) })), 'recovery');
      diagnostics.cleanup = 'closed retained fixture';
      diagnostics.windowCleanupConfirmed = true;
      diagnostics.appQuit = true;
    },
    async dispose() { controller.abort(); return (await response).groupClean === true; },
  };
  let command;
  const writeControl = command => {
    const next = control + '.next';
    writeFileSync(next, JSON.stringify({
    command, cancelled: signal?.aborted === true, launched: lease.launched,
    ...(lease.simulatorBooted === true ? { simulatorBooted: true } : {}),
    }), { mode: 0o600 });
    renameSync(next, control);
  };
  const cancelSetup = () => {
    try { writeControl('cancel'); }
    catch {
      // A failed notification cannot leave setup running. The lost reference
      // keeps window cleanup unconfirmed and the owning lock retained.
      diagnostics.cleanup = 'unconfirmed';
      diagnostics.cancellationDeliveryFailed = true;
      controller.abort();
    }
  };
  writeControl('waiting');
  signal?.addEventListener('abort', cancelSetup, { once: true });
  if (signal?.aborted) cancelSetup();
  const beginLaunch = (launched = true) => {
    signal?.throwIfAborted();
    lease.launched = launched;
    diagnostics.launched = launched;
    writeControl('launching');
  };
  Object.defineProperty(beginLaunch, 'simulatorBooted', {
    set(value) { lease.simulatorBooted = value === true; },
    get() { return lease.simulatorBooted === true; },
  });
  try { command = await helper(request, signal); }
  catch (error) { signal?.removeEventListener('abort', cancelSetup); if (error.noMutation === true) diagnostics.cleanup = 'nothing created'; throw error; }
  if (signal?.aborted) { signal.removeEventListener('abort', cancelSetup); signal.throwIfAborted(); }
  ctx.windowLeases.push(lease);
  response = run(command.command, [...command.args, JSON.stringify({ ...request, control, startedAtMs, launchedProcesses })], {
    signal: helperSignal, timeoutMs: 600000, graceMs: 1000,
    onStdout: data => {
      buffer += String(data);
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (finderFolder) event = finderDiagnostic(event);
        if (typeof event.running === 'boolean') { lease.running = event.running; diagnostics.running = event.running; }
        if (event.pid > 0) { lease.pid = event.pid; diagnostics.pid = event.pid; }
        if (event.bundle) { lease.bundle = event.bundle; diagnostics.observedBundle = event.bundle; }
        if (event.processStartedAtMs > 0) { lease.processStartedAtMs = event.processStartedAtMs; diagnostics.processStartedAtMs = event.processStartedAtMs; }
        if (event.setupCase) lease.setupCase = event.setupCase;
        const recorded = [...(Array.isArray(event.pids) ? event.pids : []), event.pid,
          event.processHandoff?.fromPid, event.processHandoff?.toPid].filter(pid => Number.isInteger(pid) && pid > 0);
        if (recorded.length) { lease.pids = [...new Set([...lease.pids, ...recorded])]; diagnostics.pids = lease.pids; }
        if (event.processHandoff) diagnostics.processHandoff = event.processHandoff;
        // A fixture save prompt the helper answered at cleanup: which button, on which window, from where.
        if (event.fixtureSheet) (diagnostics.fixtureSheets ??= []).push(event.fixtureSheet);
        if (event.appDialog) {
          (diagnostics.appDialogs ??= []).push(event.appDialog);
          if (event.appDialog.stop !== false) diagnostics.appDialog = event.appDialog;
          ctx.onAppDialog?.(event.appDialog);
        }
        if (event.stage === 'finder-relaunch' && event.finderRelaunch)
          log(`FINDER_RELAUNCH: ${event.finderRelaunch.reason} (pid ${event.finderRelaunch.pid})`);
        if (event.stage === 'retry') {
          const retry = { code: event.code, waitMs: event.waitMs, totalWaitMs: event.totalWaitMs, setupCase: event.setupCase };
          if (['cleanup', 'observation'].includes(event.phase)) {
            (diagnostics[event.phase + 'Retries'] ??= []).push(retry);
            diagnostics[event.phase + 'TotalWaitMs'] = event.totalWaitMs;
          } else diagnostics.retries.push(retry);
        }
        for (const key of ['finderRelaunch', 'finderRecovery', 'finderAXError', 'finderFailure', 'finderCleanupFailure', 'finderMenuCleanupFailure', 'fixtureWindow', 'menuCleanup', 'menuCleanupError', 'menuCleared', 'menuEscapePid', 'windows', 'fresh', 'totalWaitMs', 'actionTaken', 'cleanup', 'cleanupError', 'menuCancelled', 'menuCancelMethod', 'menuItems', 'menuCommands', 'readiness', 'navigation', 'creation', 'foregroundFallback', 'launchWait', 'readWait', 'cleanupReadWait', 'observationReadWait', 'setupCase', 'inheritReady', 'placement']) {
          if (event[key] !== undefined) diagnostics[key] = event[key];
        }
        ctx.onFixtureDiagnostics?.(diagnostics);
        if (event.stage) stage(event.stage).resolve(event);
      }
    },
  }).catch(error => ({ error: error.message, groupClean: false })).then(result => {
    if (finderFolder) result = { ...result,
      stdout: String(result.stdout ?? '').split('\n').flatMap(line => {
        try { return [JSON.stringify(finderDiagnostic(JSON.parse(line)))]; } catch { return []; }
      }).join('\n'),
      stderr: result.stderr ? finderHelperFailure(result.stderr, diagnostics.finderFailure) : '',
      error: result.error ? finderHelperFailure(result.error, diagnostics.finderFailure) : undefined,
    };
    completed = result; return result; }).finally(() => signal?.removeEventListener('abort', cancelSetup));
  const waitStage = async name => {
    signal?.throwIfAborted();
    let timer, onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error('Fixture setup cancelled'));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    try {
      return await Promise.race([aborted, stage(name).promise, response.then(result => {
        throw Object.assign(new Error(`Fixture setup failed: ${result.stderr?.trim() || result.error || 'helper exited before readiness'}`),
          { noMutation: untouched(result) });
      }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture setup readiness timed out')), finderFolder ? 75000 : 40000); })]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  };
  try {
  if (blankWindow) {
    await waitStage('launch');
    signal?.throwIfAborted();
    beginLaunch();
    await open('/usr/bin/open', fixtureLaunch === 'retained-url' ? ['-g', '-a', request.app, '--args', '-ApplePersistenceIgnoreState', 'YES'] : ['-g', '-b', request.bundle], { signal, timeout: 15000 });
  }
  await waitStage('armed');
  signal?.throwIfAborted();
  if (finderFolder) beginLaunch(false); // The AX helper creates the window, with no open-document Apple Event.
  else if (launch) await launch(beginLaunch);
  else if (request.fixtureKind === 'web-page' && fixtureLaunch !== 'retained-url' && fixtureLaunch !== 'new-instance') {
    await open('/usr/bin/open', ['-g', '-b', request.bundle, request.target], { signal, timeout: 15000 });
  } else if (fixtureLaunch !== 'retained-url') {
    beginLaunch();
    const args = fixtureLaunch === 'new-instance'
      ? ['-n', '-g', '-a', request.app, '--args', '--new-window', request.target]
      : ['-g', '-a', request.app, ...(request.target ? [request.target] : []), ...(request.mode === 'document' ? DOCUMENT_LAUNCH : [])];
    await open('/usr/bin/open', args, { signal, timeout: 15000 });
  }
  signal?.throwIfAborted();
  writeControl('opened');
  await waitStage('ready');
  signal?.throwIfAborted();
  return lease;
  } catch (error) {
    // LaunchServices errors and readiness deadlines can precede the helper's
    // recovery receipt. Await that receipt before deciding acquisition status.
    try { await ctx.beforeFixtureCleanup?.(); await lease.close(); error.noMutation = true; } catch {}
    if (finderFolder && diagnostics.finderAXError) error.fixtureSetupFailure = 'finder-ax';
    error.fixtureDiagnostics = diagnostics;
    throw error;
  }
}

export async function closeFixtures(ctx) {
  const errors = [];
  for (const lease of [...ctx.windowLeases ?? []].reverse()) {
    try { await lease.close(); } catch (error) { errors.push(error.message); }
    try {
      if (lease.running === false && lease.launched) {
        if (!await lease.dispose()) throw new Error('Fixture helper collection unconfirmed; app quit refused');
        await lease.quit();
      }
    } catch (error) { errors.push(error.message); }
  }
  if (errors.length) throw new Error(errors.join('; '));
}

export async function retryFixtureCleanup(ctx) {
  const leases = ctx.windowLeases ?? [];
  if (!leases.length || ctx.pendingAcquisitions?.size) throw new Error('Fixture recovery ownership unconfirmed');
  // A lease that attached to an app another lease launched recovers after it, once that lease has quit the app.
  const adopted = lease => typeof lease.ownerLease === 'function' && !!lease.ownerLease();
  // Mail's retained import has its own cleanup protocol and no document recovery.
  // Skip only leases whose cleanup already proved both the window and helper gone.
  const ordered = [...leases].reverse().filter(lease => !(lease.cleaned === true &&
    lease.diagnostics?.windowCleanupConfirmed === true && lease.diagnostics?.helperCollectionConfirmed === true));
  for (const lease of ordered.filter(lease => !adopted(lease))) await lease.recover();
  for (const lease of ordered.filter(adopted)) await lease.recover();
}
