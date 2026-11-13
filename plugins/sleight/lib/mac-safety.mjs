import { macIdentityError } from './repl/identity-steps.mjs';
// Native admission belongs to the parent, never to evaluated JavaScript.
import { createDriverSafety, dispatchDriverAction } from './driver-safety.mjs';
import { execFileSync } from 'node:child_process';
import { verifyWindowIdentity } from './repl/identity.mjs';
import { DRIVER_ACTION_METHODS } from './mac-driver/protocol.mjs';
import { formatMacDriverError, personWaitNotice } from './mac-driver/errors.mjs';
import { isOwnHost, ownLine } from './own-host.mjs';
import { matchBlockedApp, isForbiddenSettingsWindow, forbiddenTargetWarning, ALLOW_FORBIDDEN_COMMAND } from './blocked-apps.mjs';
import { pageSite } from './permissions.mjs';
import { systemExecutable } from './platform/darwin-ancestry.mjs';
import { classifyAncestorPath, knownNonAppAncestorPath } from './app-policy/ancestry.mjs';
import { admitsMacInput, MAC_INPUT_GATE_NOTICES } from './mac-driver/input-registrar.mjs';
import { helperInspection, validateHelperInspection } from './repl/helpers.mjs';
import { normalizeMacAction } from './repl/arguments.mjs';
import { resolveMacPolicyTargets } from './mac-driver/diff.mjs';

export const MAC_SAFETY_NOTICES = Object.freeze({
  policy: 'sleight: app policy is unavailable. No app content was read. Stop and tell the user.',
  permissions: 'sleight: permissions are unavailable. No app content was read. Stop and tell the user.',
  ancestry: 'sleight: the agent host could not be verified. No app content was read. Stop and tell the user.',
  declined: 'sleight: app access was declined for this session. Stop and tell the user.',
  settings: 'sleight: this settings window controls automation permissions. Only the user may operate it.',
  forbidden: `sleight: this app is a terminal or agent host. Only the user may lift this refusal with \`${ALLOW_FORBIDDEN_COMMAND}\`.`,
});
export const MAC_WINDOW_NOTICES = Object.freeze({
  hidden: 'sleight: the app is hidden; ask the user to unhide it on this Space before input.',
  minimized: 'sleight: the window is minimized; ask the user to restore it on this Space before input.',
  otherSpace: 'sleight: the window is on another Space or off screen; ask the user to bring it to this Space before input.',
  fullScreenOtherSpace: 'sleight: the window is in a full-screen Space outside the current Space; ask the user to bring it to this Space before input.',
  fullScreenCurrentSpace: 'sleight: the window is full screen on the current Space.',
  splitView: 'sleight: Split View or partial full screen; ask the user to exit Split View before input.',
  unverified: 'sleight: the window\'s current Space could not be verified; ask the user to bring it to this Space and read again.',
});
// Pin the native refusal wording too. Only these exact helper messages bypass
// the generic error formatter; app text can never supply a new instruction.
export const MAC_WINDOW_REFUSALS = Object.freeze(Object.fromEntries(Object.entries(MAC_WINDOW_NOTICES)
  .filter(([key]) => key !== 'fullScreenCurrentSpace')
  .map(([key, note]) => [key, note.replace(/ before input\.$/, '.') +
    ' Input refused.'])));
// Derive advice only from parent-observed metadata, never from app text.
export function macWindowNote(window) {
  if (window?.hidden === true) return MAC_WINDOW_NOTICES.hidden;
  if (window?.minimized === true) return MAC_WINDOW_NOTICES.minimized;
  if (window?.onScreen === false) return window.fullScreen === true
    ? MAC_WINDOW_NOTICES.fullScreenOtherSpace : MAC_WINDOW_NOTICES.otherSpace;
  if (window?.onScreen === true && window.fullScreen === true) {
    if (window.fullScreenTile === true) return MAC_WINDOW_NOTICES.splitView;
    if (window.fullScreenTile === false) return MAC_WINDOW_NOTICES.fullScreenCurrentSpace;
    return MAC_WINDOW_NOTICES.unverified;
  }
}
const fail = (code, message = code, details = {}) => { throw Object.assign(Error(message), { code, parentSafety: true, delivery: 'not-sent',
  retry: ['TARGET_CHANGED', 'READ_FIRST_REQUIRED'].includes(code) ? 'read-first' : 'safe', ...details }); };
const changed = step => { throw Object.assign(macIdentityError(step), { parentSafety: true, delivery: 'not-sent', retry: 'safe' }); };
const validString = value => typeof value === 'string' && value.length > 0 && value.length <= 32768 &&
  value.isWellFormed() && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
const binding = window => ({ windowId: window.windowId, processStart: window.processStart });
const boundsEqual = (a, b) => ['x', 'y', 'width', 'height'].every(key => Number.isFinite(a?.[key]) && a[key] === b?.[key]);
// The opaque process start is part of the lease key. Titles never move a lease.
export const macLeaseTarget = window => ({ appId: window.bundleId,
  title: JSON.stringify([window.windowId, window.pid, window.processStart]), url: null });

// Each walk uses one deadline across its child calls, including bundle IO.
function ancestryBudget(now, budgetMs = 3000) {
  const deadline = now() + budgetMs;
  return () => { const left = deadline - now(); if (left <= 0) throw Error('ANCESTRY_UNAVAILABLE'); return left; };
}
function readParentPid(pid, run, left) {
  const parent = String(run('/bin/ps', ['-p', String(pid), '-o', 'ppid='],
    { killSignal: 'SIGKILL', encoding: 'utf8', timeout: left(), stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  left();
  if (!/^[1-9][0-9]*$/.test(parent) || !Number.isSafeInteger(Number(parent))) throw Error('ANCESTRY_UNAVAILABLE');
  return Number(parent);
}
export function macProcessParents({ pid, run = execFileSync, now = Date.now, budgetMs = 3000 } = {}) {
  const rows = [], seen = new Set(), left = ancestryBudget(now, budgetMs);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw Error('ANCESTRY_UNAVAILABLE');
  for (let depth = 0; pid > 1 && depth < 32; depth++) {
    if (seen.has(pid)) throw Error('ANCESTRY_UNAVAILABLE');
    seen.add(pid); rows.push(pid);
    pid = readParentPid(pid, run, left);
  }
  if (pid !== 1) throw Error('ANCESTRY_UNAVAILABLE');
  return rows;
}
// Root-owned login/sudo rows may have no user-readable lsof entry. Only the
// fixed system pass-through paths may use ps identity instead of mapped text.
function ancestorExecutable(pid, left, run) {
  const options = { killSignal: 'SIGKILL', encoding: 'utf8', timeout: left(), stdio: ['ignore', 'pipe', 'ignore'] };
  const command = String(run('/bin/ps', ['-p', String(pid), '-o', 'comm='], options)).trim();
  left();
  if (knownNonAppAncestorPath(command)) return command;
  options.timeout = left();
  return /^n(.+)$/m.exec(run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], options))?.[1];
}
export function macProcessAncestry({ pid = process.pid, run = execFileSync, executable,
  now = Date.now, readBundleId = (plist, timeout) => String(run('/usr/bin/plutil',
    ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist],
    { killSignal: 'SIGKILL', encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] })).trim() } = {}) {
  const rows = [], seen = new Set(), left = ancestryBudget(now);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw Error('ANCESTRY_UNAVAILABLE');
  for (let depth = 0; pid > 1 && depth < 32; depth++) {
    if (seen.has(pid)) throw Error('ANCESTRY_UNAVAILABLE');
    seen.add(pid);
    const path = executable ? executable(pid, left()) : ancestorExecutable(pid, left, run);
    left();
    if (!validString(path)) throw Error('ANCESTRY_UNAVAILABLE');
    const classification = classifyAncestorPath(path, plist => readBundleId(plist, left()));
    left();
    const ppid = readParentPid(pid, run, left);
    rows.push({ pid, ppid, path, ...classification ?? { bundleId: null } });
    pid = ppid;
  }
  if (pid > 1 || !rows.length) throw Error('ANCESTRY_UNAVAILABLE');
  return rows;
}

// Keep the positional injection seam for existing callers. The shipped RT28
// evaluator takes metadata and settings objects, built only from parent facts.
export async function loadMacAppPolicy({ load = () => import('./app-policy.mjs'), executable = systemExecutable } = {}) {
  try {
    const module = await load();
    if (typeof module.evaluateAppPolicy === 'function') return (bundleId, processAncestry, windowTitle,
      { app = {}, operation, allowForbiddenTargets = false } = {}) => {
      let executablePath;
      try { if (Number.isSafeInteger(app.pid) && app.pid > 1) executablePath = executable(app.pid, 1000); }
      catch { /* Missing identity remains invalid metadata, never a display-name fallback. */ }
      const verdict = module.evaluateAppPolicy({ bundleId, processAncestry, windowTitle, operation,
        executableName: typeof executablePath === 'string' ? executablePath.split('/').at(-1) : undefined,
        executablePath, secureInput: app.secureInput, focusedSecureField: app.focusedSecureField,
        windowSubrole: app.windowSubrole, windowIdentifier: app.windowIdentifier }, { allowForbiddenTargets });
      return { ...verdict, message: verdict.sentence, riskLevel: 'high' };
    };
  } catch { /* A failed or malformed policy load grants nothing. */ }
  return () => ({ allow: false, code: 'APP_POLICY_UNAVAILABLE', message: MAC_SAFETY_NOTICES.policy });
}

function validate(method, params, input = false) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) fail('INVALID_PARAMS');
  let allowed;
  if (input) {
    allowed = ['windowId', 'processStart', 'readId', 'args', 'read'];
    if (typeof params.windowId !== 'string' || !/^[1-9][0-9]*$/.test(params.windowId) || !validString(params.processStart) ||
        !Number.isSafeInteger(params.readId) || params.readId < 1 || !Array.isArray(params.args) ||
        params.read !== undefined && !['full', 'none'].includes(params.read)) fail('INVALID_PARAMS');
    const normalized = normalizeMacAction(method, params.args);
    if (normalized.method !== method || JSON.stringify(normalized.args) !== JSON.stringify(params.args)) fail('INVALID_PARAMS');
  } else if (['getState', 'listApps'].includes(method)) allowed = [];
  else if (method === 'getApp') {
    allowed = ['selector', 'launch'];
    const selector = params.selector;
    if (!validString(selector) && !(selector && Object.keys(selector).length === 1 &&
      typeof selector.windowId === 'string' && /^[1-9][0-9]*$/.test(selector.windowId))) fail('INVALID_PARAMS');
    if (params.launch !== undefined && typeof params.launch !== 'boolean') fail('INVALID_PARAMS');
  } else if (['getAXState', 'getScreenshot', 'getAXStateAndScreenshot'].includes(method)) {
    const capture = method !== 'getAXState';
    allowed = ['windowId', 'processStart', ...method === 'getScreenshot' ? [] : ['depth', 'budgetMs'],
      ...capture ? ['format', 'scale'] : []];
    if (typeof params.windowId !== 'string' || !/^[1-9][0-9]*$/.test(params.windowId) || !validString(params.processStart)) fail('INVALID_PARAMS');
    for (const [key, min, max] of [['depth', 0, 64], ['budgetMs', 1, 30000]])
      if (params[key] !== undefined && (!Number.isInteger(params[key]) || params[key] < min || params[key] > max)) fail('INVALID_PARAMS');
    if (capture && (params.format !== undefined && !['png', 'jpeg'].includes(params.format) ||
        params.scale !== undefined && !['pixel', 'point'].includes(params.scale))) fail('INVALID_PARAMS');
  } else fail('METHOD_NOT_FOUND', formatMacDriverError({ code: 'METHOD_NOT_FOUND', delivery: 'not-sent' }, { action: true }));
  if (Object.keys(params).some(key => !allowed.includes(key))) fail('INVALID_PARAMS');
}

export function createMacSafety({ driver, lease, approve, policy, ancestry = macProcessAncestry,
  targetParents = (pid, budgetMs) => macProcessParents({ pid, budgetMs }),
  allowForbidden = () => false, permissions, ownHostPid = () => false, refreshApprovals = () => {}, approvalScope = 'session',
  beforeLeaseEnd, inputRegistrar, now = Date.now, timingNow = () => performance.now(), diagnostics = line => process.stderr.write(line + '\n'),
  readReuse = process.env.SLEIGHT_GLIDE_READ_REUSE !== '0' } = {}) {
  const acquired = new Map(), decisions = new Map(), decisionNames = new Map();
  const endings = new Set(), inspections = new Map();
  const outcomes = new Map(), deliveredCoordinates = new Map(), readReceipts = new WeakMap();
  let outcomeSequence = 0, observationSequence = 0, helperEpoch = 0;
  const windowKey = window => JSON.stringify([window?.windowId, window?.processStart]);
  const rememberRead = (result, sequence) => {
    if (result && (typeof result.text === 'string' && result.truncated !== true || result.screenshot))
      readReceipts.set(result, { epoch, helperEpoch, generation: driver.helperGeneration,
        observation: ++observationSequence, key: windowKey(result.window), sequence });
    return result;
  };
  const clearEvidence = () => { outcomes.clear(); deliveredCoordinates.clear(); };
  const assertInput = window => {
    if (outcomes.has(windowKey(window)))
      fail('READ_FIRST_REQUIRED', formatMacDriverError({ code: 'READ_FIRST_REQUIRED', delivery: 'not-sent', retry: 'read-first' }));
  };
  const inputForWindows = async (windows, perform) => {
    for (const window of windows) assertInput(window);
    const generation = epoch, sequence = ++outcomeSequence;
    for (const window of windows) outcomes.set(windowKey(window), sequence);
    try {
      const result = await perform();
      if (generation === epoch && (['not-sent', 'sent-verified', 'sent-unverified'].includes(result?.delivery) || result?.deliveryVerified === true || result?.posted === false))
        for (const window of windows) if (outcomes.get(windowKey(window)) === sequence) outcomes.delete(windowKey(window));
      return result;
    } catch (error) {
      if (generation === epoch && error.delivery === 'not-sent') for (const window of windows)
        if (outcomes.get(windowKey(window)) === sequence) outcomes.delete(windowKey(window));
      throw error;
    }
  };
  const queue = { queued: 0, serial: Promise.resolve() };
  let runtimePolicy;
  let epoch = 0, closed = false, preparingClose = false, hostChain, unsafeLeaseEnd, hostLookupLogged = false;
  const leased = (method, ...args) => {
    try { return lease[method](...args); }
    catch (error) { fail('LEASE_REFUSED', error.message); }
  };
  // Invalidation is synchronous. Start the bounded undo even while a read is
  // in flight. New admissions still wait for that read and all lease endings.
  const finishLeases = (entries, release) => {
    if (unsafeLeaseEnd) {
      const refused = Promise.reject(unsafeLeaseEnd);
      queue.serial = Promise.allSettled([queue.serial, refused]).then(() => {});
      return refused;
    }
    if (!beforeLeaseEnd || !entries.length && !endings.size) return release();
    const restoring = Promise.resolve().then(() => entries.length ? beforeLeaseEnd(entries) : undefined);
    const ending = Promise.allSettled([...endings, restoring]).then(async results => {
      // A prior release failure cannot suppress this ending's release. A failed
      // current undo/retirement must retain its lease until safe or expired.
      if (results.at(-1).status === 'rejected') { unsafeLeaseEnd = results.at(-1).reason; throw unsafeLeaseEnd; }
      if (unsafeLeaseEnd) throw unsafeLeaseEnd;
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      try { await release(); } catch (error) { failures.push(error); }
      if (failures.length) throw failures[0];
    }).finally(() => { endings.delete(ending); });
    endings.add(ending);
    queue.serial = Promise.allSettled([queue.serial, ending]).then(() => {});
    return ending;
  };
  const clearAcquired = () => { const entries = [...acquired.values()]; acquired.clear(); return entries; };
  async function checkTarget(app) {
    // null alone represents an app that is not running. Missing or malformed
    // process identity must never bypass the descendant refusal.
    if (app.pid === null) return;
    const unavailable = () => fail('ANCESTRY_UNAVAILABLE', MAC_SAFETY_NOTICES.ancestry, { targetAncestry: true });
    if (!Number.isSafeInteger(app.pid) || app.pid <= 1) unavailable();
    const left = ancestryBudget(now);
    try {
      const parents = await targetParents(app.pid, left());
      left();
      if (!Array.isArray(parents) || !parents.length || parents.some(pid => !Number.isSafeInteger(pid) || pid < 1)) unavailable();
      for (const pid of new Set([app.pid, ...parents])) {
        if (pid === process.pid) fail('OWN_HOST_REFUSED', ownLine());
        const owned = await ownHostPid(pid, left());
        left();
        if (owned) fail('OWN_HOST_REFUSED', ownLine(typeof owned === 'string' ? owned : undefined));
      }
    } catch (error) {
      if (error.code === 'OWN_HOST_REFUSED') throw error;
      unavailable();
    }
  }
  async function check(app, title = '', expected, operation, policyWindow = app, targetCache) {
    if (!app || !validString(app.bundleId ?? app.id)) fail('IDENTITY_UNVERIFIED');
    const id = app.bundleId ?? app.id;
    if (isOwnHost(id, app.app, app.name, app.path))
      fail('OWN_HOST_REFUSED', ownLine(id, app.app, app.name, app.path));
    const key = JSON.stringify([app.pid, app.processStart]);
    if (targetCache && Number.isSafeInteger(app.pid) && app.pid > 1) {
      if (!targetCache.has(key)) targetCache.set(key, checkTarget(app));
      await targetCache.get(key);
    } else await checkTarget(app);
    let chain;
    // The server's launching host stays its host across worker resets and turns.
    if (!hostChain) {
      const started = now();
      hostChain = Promise.resolve().then(ancestry).catch(error => { hostChain = undefined; throw error; }).finally(() => {
        if (!hostLookupLogged) {
          hostLookupLogged = true;
          try { diagnostics(`sleight: Glide first host ancestry lookup ${Math.max(0, now() - started)} ms`); } catch { /* Diagnostics grant nothing. */ }
        }
      });
    }
    try { chain = await hostChain; } catch { fail('ANCESTRY_UNAVAILABLE', MAC_SAFETY_NOTICES.ancestry); }
    if (!Array.isArray(chain) || !chain.length || chain.some(row => !row || !Number.isSafeInteger(row.pid) || !validString(row.path)))
      fail('ANCESTRY_UNAVAILABLE', MAC_SAFETY_NOTICES.ancestry);
    for (const [index, row] of chain.entries()) {
      if (Object.hasOwn(row, 'bundleId') && (typeof row.bundleId !== 'string' || !row.bundleId.trim()))
        throw Object.assign(Error('APP_POLICY_INVALID_METADATA'), { code: 'APP_POLICY_INVALID_METADATA',
          cause: `processAncestry[${index}]`, parentSafety: true, delivery: 'not-sent', retry: 'safe' });
    }
    const host = chain.some(row => row.pid === app.pid ||
      typeof row.bundleId === 'string' && row.bundleId.toLowerCase() === id.toLowerCase() ||
      app.path && row.path.toLowerCase().startsWith(app.path.toLowerCase().replace(/\/$/, '') + '/'));
    const forbidden = matchBlockedApp(app.app ?? app.name, id);
    const settings = isForbiddenSettingsWindow({ appId: id, app: app.app ?? app.name, title });
    if (settings) fail('FORBIDDEN_SETTINGS', MAC_SAFETY_NOTICES.settings);
    const lifted = await allowForbidden() === true;
    const verdict = await policy?.(id, chain.map(row => row.kind !== undefined ?
      row.kind === 'non-app' && !Object.hasOwn(row, 'bundleId') ? { kind: 'non-app' } : null :
      Object.hasOwn(row, 'bundleId') ?
      typeof row.bundleId === 'string' && row.bundleId.trim() ? { bundleId: row.bundleId } : null :
      classifyAncestorPath(row.path)), title,
      { app: { ...app, secureInput: policyWindow?.secureInput, focusedSecureField: policyWindow?.focusedSecureField,
        windowSubrole: policyWindow?.windowSubrole, windowIdentifier: policyWindow?.windowIdentifier },
      operation, allowForbiddenTargets: lifted });
    if (!verdict || typeof verdict.allow !== 'boolean') fail('APP_POLICY_UNAVAILABLE', MAC_SAFETY_NOTICES.policy);
    if (!verdict.allow && verdict.code === 'APP_POLICY_INVALID_METADATA')
      throw Object.assign(Error(verdict.code), { code: verdict.code, cause: verdict.cause,
        parentSafety: true, delivery: 'not-sent', retry: 'safe' });
    if (!verdict.allow && !(verdict.overridable === true && lifted))
      fail(verdict.code ?? 'APP_POLICY_REFUSED', verdict.message ?? MAC_SAFETY_NOTICES.policy);
    if ((host || forbidden) && !lifted) fail('FORBIDDEN_TARGET', MAC_SAFETY_NOTICES.forbidden);
    const blocked = permissions?.app?.({ bundleId: id, name: app.app ?? app.name });
    if (blocked) fail('APP_BLOCKED', blocked);
    if (expected) {
      verifyWindowIdentity(expected, app, 'darwin');
      // Input never adopts geometry that changed since this session's read,
      // including a move that leaves the title unchanged.
      if ((DRIVER_ACTION_METHODS.includes(operation) || expected.title !== app.title) &&
          !boundsEqual(expected.bounds, app.bounds)) changed('bounds');
    }
    const warning = lifted && (host || forbidden) ? forbiddenTargetWarning(id) ??
      forbiddenTargetWarning(app.app ?? app.name, { agentHost: host }) : undefined;
    return { riskLevel: verdict.riskLevel ?? 'high', warning: [warning, verdict.warning].filter(Boolean).join('\n') || undefined };
  }
  async function dispatch(method, params, context) {
    const began = timingNow();
    const generation = epoch;
    // The production preview refuses before driver access. Only a capability
    // obtained by the trusted gate host can reach the input admission seam.
    const input = DRIVER_ACTION_METHODS.includes(method);
    if (input && !admitsMacInput(inputRegistrar, method, driver)) {
      const note = macWindowNote(acquired.get(params?.windowId)?.window);
      fail('METHOD_NOT_FOUND', [formatMacDriverError({ code: 'METHOD_NOT_FOUND', delivery: 'not-sent' }, { action: true }),
        note].filter(Boolean).join('\n'));
    }
    validate(method, params, input);
    params = structuredClone(params);
    if (input) assertInput(params);
    // Method admission precedes retained-number validation. An absent operation
    // cannot become a stale-number refusal or read any app content.
    const inspectionKey = JSON.stringify([context.cell, context.messageId]);
    const inspected = input && !context.inspectOnly ? inspections.get(inspectionKey) : undefined;
    if (inspected) {
      inspections.delete(inspectionKey);
      if (inspected.method !== method || JSON.stringify(inspected.params) !== JSON.stringify(params)) fail('INVALID_PARAMS');
    }
    context.beforeRequest?.(method, { ...structuredClone(params), ...inspected ? { readId: inspected.readId } : {} });
    if (!['app', 'page', 'sitesLimited'].every(key => typeof permissions?.[key] === 'function'))
      fail('PERMISSIONS_UNAVAILABLE', MAC_SAFETY_NOTICES.permissions);
    const active = () => {
      refreshApprovals();
      if (unsafeLeaseEnd) fail('LEASE_REFUSED', unsafeLeaseEnd.message);
      if (closed || preparingClose || generation !== epoch || context.isActive?.() === false) fail('REPL_CELL_ENDED');
    };
    active();
    const verify = async window => {
      try {
        const verified = await driver.request('verifyWindowIdentity', binding(window)); active();
        verifyWindowIdentity({ ...window, identityVerified: true }, verified?.window, 'darwin');
        return verified;
      } catch (error) {
        // The current AX window may disappear after a Space move. Accept only
        // the helper's fixed advice, even when the preceding read was on-screen.
        const note = Object.values(MAC_WINDOW_NOTICES).find(note => error.message === `${error.code}\n${note}`) ?? macWindowNote(window);
        if (note && ['IDENTITY_UNVERIFIED', 'IDENTITY_CHANGED', 'AX_UNAVAILABLE', 'STALE_ELEMENT', 'WINDOW_NOT_FOUND'].includes(error.code)) {
          error.message = `${formatMacDriverError(error)}\n${note}`;
          error.parentSafety = true;
        }
        throw error;
      }
    };
    if (input && !['beforeAction', 'checkPause'].every(key => typeof runtimePolicy?.[key] === 'function'))
      fail('MAC_SAFETY_UNAVAILABLE');
    if (['getState', 'listApps'].includes(method)) {
      const state = await driver.request('getState', {}); active();
      if (!Array.isArray(state.apps)) fail('DRIVER_PROTOCOL');
      const apps = [], errors = [], targetCache = new Map();
      for (const app of state.apps) {
        try {
          await check(app, '', undefined, method, app, targetCache);
          apps.push({ id: app.bundleId ?? app.id, name: app.name, running: app.running, useCount: app.useCount });
        }
        catch (error) {
          if (error.code === 'APP_POLICY_INVALID_METADATA')
            errors.push({ app: app.bundleId ?? app.id, code: error.code, cause: error.cause });
          else if (!error.targetAncestry && ['APP_POLICY_UNAVAILABLE', 'ANCESTRY_UNAVAILABLE'].includes(error.code)) throw error;
          // No unapproved titles, paths, windows or policy-refused apps leave the parent.
        }
        active();
      }
      return method === 'listApps' ? { apps, errors } : { apps, windows: [], errors };
    }
    let entry;
    if (method === 'getApp') {
      const resolved = await driver.request('resolveApp', { selector: params.selector, launch: false }); active();
      const app = resolved?.app;
      const first = resolved.windows?.find?.(w => w?.identityVerified === true && w.windowSubrole === 'AXStandardWindow') ?? resolved.windows?.[0];
      const wording = await check(app, first?.title ?? '', undefined, method, first); active();
      if (!Array.isArray(resolved.windows)) fail('DRIVER_PROTOCOL');
      if (!resolved.windows.length) fail('NO_WINDOWS_AVAILABLE', formatMacDriverError({ code: 'NO_WINDOWS_AVAILABLE' }));
      // CG order can put a dialog or panel first (TextEdit's untitled AXDialog, live 2026-11-06). Prefer the first
      // verified standard window, as the helper's own getApp does; identity checks below still apply to it.
      const candidate = resolved.windows.find(w => w?.identityVerified === true && w.windowSubrole === 'AXStandardWindow') ?? resolved.windows[0];
      if (candidate.bundleId !== app.id) changed('bundle-id');
      if (candidate.pid !== app.pid) changed('pid');
      if (candidate.processStart !== app.processStart) changed('process-start');
      if (typeof params.selector === 'object' && candidate.windowId !== params.selector.windowId) changed('window-id');
      const id = app.id.toLowerCase();
      let answer = decisions.get(id);
      if (!decisions.has(id) || approvalScope !== 'session') {
        answer = await approve?.({ app: app.id, name: app.name, ...wording }); active();
        if (approvalScope === 'session') {
          decisionNames.set(id, app.name?.toLowerCase());
          decisions.set(id, answer === true);
        }
      }
      if (answer !== true) fail('APP_DECLINED', MAC_SAFETY_NOTICES.declined);
      // Metadata resolution is not AX corroboration. Verify before leasing or reading.
      const verified = await verify(candidate);
      await check(verified.window, verified.window.title, undefined, method); active();
      const window = structuredClone(verified.window);
      const key = leased('acquire', macLeaseTarget(window), 'window');
      entry = { window, bundleId: app.id, path: app.path, key };
      acquired.set(window.windowId, entry);
    } else {
      entry = acquired.get(params.windowId);
      if (!entry) fail('APP_NOT_ACQUIRED');
      if (params.processStart !== entry.window.processStart) changed('process-start');
      if (approvalScope === 'once') {
        const wording = await check({ ...entry.window, path: entry.path }, entry.window.title, undefined, method); active();
        const answer = await approve?.({ app: entry.bundleId, name: entry.window.app, ...wording }); active();
        if (answer !== true) fail('APP_DECLINED', MAC_SAFETY_NOTICES.declined);
      }
    }
    leased('renew', [entry.key]); active();
    const observed = await verify(entry.window);
    await check({ ...observed.window, path: entry.path }, observed.window?.title, entry.window, method); active();
    if (input && (observed.window.onScreen !== true || observed.window.minimized === true))
      fail('NO_WINDOWS_AVAILABLE', MAC_INPUT_GATE_NOTICES.otherSpace);
    leased('renew', [entry.key]); active();
    // Native site identity has no trusted metadata-only reader yet. Fail closed
    // before content/capture whenever the user has site limits.
    if (permissions?.sitesLimited?.()) {
      const refusal = permissions.page?.({ unproven: true });
      fail('SITE_UNPROVEN', refusal ?? 'SITE_UNPROVEN');
    }
    let admitted = method === 'getApp' ? binding(entry.window) : params;
    if (input) {
      if (observed.window.onScreen !== true || observed.window.minimized === true) fail('NO_WINDOWS_AVAILABLE');
      const before = context.fullTree?.(params) ?? entry.text;
      const timing = { admissionMs: timingNow() - began, admissionReadMs: 0, personMs: 0, policyMs: 0,
        driverMs: 0, sendMs: 0, settleMs: 0, postReadMs: 0, observeMs: 0 };
      let phase, phaseStart = timingNow(), nativeTiming, admissionReadId;
      const mark = next => {
        const at = timingNow();
        if (phase) timing[phase] += Math.max(0, at - phaseStart);
        phase = next; phaseStart = at;
      };
      const finish = () => {
        mark();
        timing.nativeTimingAvailable = ['sendMs', 'settleMs', 'postReadMs']
          .every(key => Number.isFinite(nativeTiming?.[key]) && nativeTiming[key] >= 0);
        for (const key of ['sendMs', 'settleMs', 'postReadMs'])
          if (Number.isFinite(nativeTiming?.[key]) && nativeTiming[key] >= 0) timing[key] = nativeTiming[key];
        timing.totalMs = Math.max(0, timingNow() - began);
        return timing;
      };
      return dispatchDriverAction({
        read: async next => {
          mark('admissionReadMs');
          // A delivered explicit read can save the first action's walk. Input
          // consumes the candidate even on refusal; later actions walk normally
          // rather than repeatedly establishing new observer/digest proofs.
          const reuseReadId = entry.reuseReadId;
          delete entry.reuseReadId;
          const read = await driver.request('getAXState', { ...binding(entry.window),
            ...runtimePolicy?.menuReadRequests ? { menuRequests: runtimePolicy.menuReadRequests() } : {},
            ...readReuse && reuseReadId !== undefined ? { reuseIfUnchanged: reuseReadId } : {} }); active();
          await check({ ...read?.window, path: entry.path }, read?.window?.title, entry.window, method); active();
          if (typeof read.text !== 'string' || !Number.isSafeInteger(read.readId) || read.readId < 1) fail('DRIVER_PROTOCOL');
          if (read.window.onScreen !== true || read.window.minimized === true)
            fail('NO_WINDOWS_AVAILABLE', MAC_INPUT_GATE_NOTICES.otherSpace);
          const refusal = permissions.page(pageSite(read.text, read.window));
          if (refusal) fail('SITE_BLOCKED', refusal);
          context.observe?.(read); runtimePolicy.observe?.(read, { action: true });
          entry.readId = read.readId; admissionReadId = read.readId;
          return next(read);
        },
        admit: async (read, commit) => {
          mark('personMs');
          const requestReadId = params.readId;
          admitted = { ...params, readId: read.readId };
          // The second number check sees the new parent map, but its baseline is
          // still the last delivered tree. An internal read never calls endCell.
          const complete = context.beforeRequest?.(method, admitted);
          if (inspected && JSON.stringify(inspected.args) !== JSON.stringify(admitted.args)) fail('STALE_READ');
          const person = await driver.request('personState', binding(entry.window)); active();
          // Only current activity may wait. A takeover since the last request
          // invalidates that read and must never reach the person's new caret.
          if (typeof person?.token !== 'string' || !person.token ||
              person.personTookOver !== false && !(person.personTookOver === true &&
                person.reason === 'person-active')) fail('PERSON_TOOK_OVER');
          mark('policyMs');
          const policyArgs = resolveMacPolicyTargets(method, admitted.args, read.text);
          const action = { method, args: policyArgs, window: structuredClone(read.window), text: read.text, before,
            readId: requestReadId, helper: context.helper, cell: context.cell, personToken: person.token };
          const policyContext = { isActive: () => { active(); return true; }, ...action };
          if (context.inspectOnly) {
            const proposal = helperInspection(context.helper, method, { ...params, args: policyArgs });
            if (await runtimePolicy.inspectHelperStep?.(proposal, policyContext) !== true) fail('MAC_SAFETY_UNAVAILABLE');
            active();
            inspections.set(inspectionKey, { method, params: structuredClone(params), args: structuredClone(admitted.args), readId: read.readId });
            return commit({ inspected: true });
          }
          const verdict = await runtimePolicy.beforeAction(action, policyContext); active();
          if (!verdict || !Array.isArray(verdict.args)) fail('MAC_SAFETY_UNAVAILABLE');
          const normalized = normalizeMacAction(method, verdict.args);
          if (normalized.method !== method || JSON.stringify(normalized.args) !== JSON.stringify(policyArgs)) fail('INVALID_PARAMS');
          admitted = { ...admitted, personToken: verdict.personToken ?? person.token };
          if (['click', 'doubleClick', 'rightClick'].includes(method) && Array.isArray(admitted.args[0])) {
            const capture = deliveredCoordinates.get(windowKey(params));
            if (!capture || capture.generation !== driver.helperGeneration) fail('TARGET_CHANGED', formatMacDriverError({ code: 'TARGET_CHANGED', delivery: 'not-sent', retry: 'read-first' }));
            admitted.coordinateReadId = capture.id;
          }
          leased('renew', [entry.key]); active();
          return commit({ complete });
        },
        checkPause: () => { runtimePolicy.checkPause(context.cell); },
        send: async (_admission, next) => {
          mark('driverMs');
          const key = windowKey(params), sequence = ++outcomeSequence;
          _admission.outcomeSequence = sequence;
          // Mark before awaiting input. Lost replies and post-input validation
          // failures cannot reopen admission, even when they carry no receipt.
          outcomes.set(key, sequence);
          let result;
          try { result = await driver.request(method, admitted, { checkActive: () => { active(); runtimePolicy.checkPause(context.cell); }, beforeInput: async () => {
            active();
            await check({ ...entry.window, path: entry.path }, entry.window.title, entry.window, method); active();
            if (approvalScope === 'session' && decisions.get(entry.bundleId.toLowerCase()) !== true) fail('APP_DECLINED');
            leased('renew', [entry.key]); active();
            runtimePolicy.checkPause(context.cell);
          } }); }
          catch (error) {
            nativeTiming = error.timing;
            if (generation === epoch && error.delivery === 'not-sent' && outcomes.get(key) === sequence) outcomes.delete(key);
            throw error;
          }
          nativeTiming = result?.timing;
          active();
          const waited = personWaitNotice(result?.waitedForPersonMs);
          if (waited) result.notices = [...Array.isArray(result.notices) ? result.notices : [], waited];
          return next(result);
        },
        observe: async (result, read, admission) => {
          mark('observeMs');
          // A successful native menu press may resize this same window (for
          // example a mode change). Its complete following read can establish
          // that geometry. Never adopt it from a tree-free/partial receipt or
          // during admission; process/window identity and policy still match.
          const menuRead = result?.semantics === 'menu-accessibility' &&
            ['sent-verified', 'sent-unverified'].includes(result.delivery) && typeof result.text === 'string' &&
            result.truncated === false && Number.isSafeInteger(result.readId) && result.readId > read.readId;
          const expected = menuRead ? { ...read.window, bounds: result.window?.bounds } : read.window;
          await check({ ...result?.window, path: entry.path }, result?.window?.title, expected, method); active();
          if (typeof result?.text === 'string') {
            if (!Number.isSafeInteger(result.readId) || result.readId < 1) fail('DRIVER_PROTOCOL');
            const blocked = permissions.page(pageSite(result.text, result.window));
            if (blocked) fail('SITE_BLOCKED', blocked);
            context.observe?.(result); runtimePolicy.observe?.(result, { action: true });
            entry.text = result.text;
            entry.readId = result.readId;
          }
          // Input admission may have advanced the map even when the native
          // receipt omits its tree. Return that validated map's ID to the handle.
          if (typeof result?.text !== 'string' && result?.observation !== 'unavailable')
            result = { ...result, readId: entry.readId };
          if (result?.delivery !== 'not-sent') admission.complete?.();
          entry.window = structuredClone(result.window);
          // A normal reply acknowledges dispatch even without effect proof.
          // Clear only after validating it; malformed/lost replies stay latched.
          if (generation === epoch && ['not-sent', 'sent-verified', 'sent-unverified'].includes(result?.delivery) &&
              outcomes.get(windowKey(params)) === admission.outcomeSequence) outcomes.delete(windowKey(params));
          return rememberRead(result, admission.outcomeSequence);
        },
      }).then(result => {
        const measured = finish();
        if (result && typeof result === 'object') result.timing = measured;
        return result;
      }, error => {
        error.timing = finish();
        // An admission read advances the native map even when policy refuses
        // input. This synchronizes the handle only, never the delivered tree.
        if (admissionReadId !== undefined && error.delivery === 'not-sent') error.readId = admissionReadId;
        throw error;
      });
    }
    // Combined captures retain their native full-walk contract. Their registrar
    // does not accept the standalone reader's internal reuse proof parameter.
    const seedReadReuse = readReuse && ['getApp', 'getAXState'].includes(method);
    if (seedReadReuse)
      admitted = { ...admitted, reuseIfUnchanged: 0 }; // Seed a proof; explicit reads still walk.
    if (runtimePolicy?.menuReadRequests && ['getApp', 'getAXState', 'getAXStateAndScreenshot'].includes(method))
      admitted = { ...admitted, menuRequests: runtimePolicy.menuReadRequests() };
    const readSequence = outcomeSequence;
    const result = await driver.request(method === 'getApp' ? 'getAXState' : method, admitted); active();
    await check({ ...result?.window, path: entry.path }, result?.window?.title, observed.window, method); active();
    if (typeof result.text === 'string') {
      if (!Number.isSafeInteger(result.readId) || result.readId < 1) fail('DRIVER_PROTOCOL');
      const refusal = permissions?.page?.(pageSite(result.text, { ...result.window, url: result.window.url }));
      if (refusal) fail('SITE_BLOCKED', refusal);
    }
    entry.window = structuredClone(result.window);
    const note = macWindowNote(result.window);
    if (note) result.spaceNote = note;
    if (typeof result.text === 'string') {
      entry.text = result.text; entry.readId = result.readId;
      if (seedReadReuse) entry.reuseReadId = result.readId;
      else delete entry.reuseReadId;
      runtimePolicy?.observe?.(result);
    }
    return rememberRead(result, readSequence);
  }
  const requests = createDriverSafety({ platform: 'darwin' }, { queue, epoch: () => epoch, fail, dispatch,
    onError(error, method) {
      if (error.code === 'NO_WINDOWS_AVAILABLE' && Object.values(MAC_WINDOW_REFUSALS).includes(error.message)) {
        error.message = `${formatMacDriverError(error, { action: DRIVER_ACTION_METHODS.includes(method) })}\n${error.message}`;
        error.parentSafety = true;
      }
    },
  });
  return {
    setPolicy(value) { runtimePolicy = value; },
    cancelPending() { epoch++; driver.cancelPending?.(); },
    finishCell(cell) { runtimePolicy?.endCell?.(cell); for (const key of inspections.keys()) if (JSON.parse(key)[0] === cell) inspections.delete(key); },
    inspectHelperCall(proposal, context = {}) {
      try { validateHelperInspection(proposal); }
      catch { return Promise.reject(Object.assign(Error('INVALID_PARAMS'), { code: 'INVALID_PARAMS', parentSafety: true, delivery: 'not-sent', retry: 'safe' })); }
      return this.request(proposal.method, proposal.params, { ...context, helper: proposal.helper, inspectOnly: true });
    },
    ...requests,
    inputForWindows,
    // Only parent-observed results surviving the final output callback count.
    // A delayed callback for a read taken before later input cannot clear it.
    recordReadDelivery(result, { screenshotDelivered = false } = {}) {
      const receipt = readReceipts.get(result);
      if (!receipt || receipt.epoch !== epoch || receipt.helperEpoch !== helperEpoch || receipt.generation !== driver.helperGeneration || closed) return;
      const pending = outcomes.get(receipt.key);
      if (pending !== undefined && pending <= receipt.sequence) outcomes.delete(receipt.key);
      if (screenshotDelivered && result.screenshot && Number.isSafeInteger(result.coordinateReadId) && result.coordinateReadId > 0 &&
          receipt.observation >= (deliveredCoordinates.get(receipt.key)?.observation ?? 0))
        deliveredCoordinates.set(receipt.key, { id: result.coordinateReadId, generation: receipt.generation, observation: receipt.observation });
    },
    helperRestarted() { helperEpoch++; deliveredCoordinates.clear(); },
    invalidateCoordinateDelivery(window) { deliveredCoordinates.delete(windowKey(window)); },
    revoke(apps) {
      const removed = new Set(apps.map(app => app.toLowerCase()));
      epoch++; driver.cancelPending?.(); runtimePolicy?.reset?.(); inspections.clear(); deliveredCoordinates.clear();
      for (const id of decisions.keys()) if (removed.has(id) || removed.has(decisionNames.get(id))) {
        decisions.delete(id); decisionNames.delete(id);
      }
      const entries = [];
      for (const [id, entry] of acquired) if (removed.has(entry.window.bundleId?.toLowerCase()) ||
          removed.has(entry.bundleId.toLowerCase()) ||
          removed.has(entry.window.app?.toLowerCase())) {
        acquired.delete(id); entries.push(entry);
      }
      if (entries.length) return finishLeases(entries, () => leased('release', entries.map(entry => entry.key)));
    },
    reset() { epoch++; driver.cancelPending?.(); runtimePolicy?.reset?.(); inspections.clear(); deliveredCoordinates.clear(); return finishLeases(clearAcquired(), () => lease.release()); },
    endTurn({ clipboardTurnEnded = true } = {}) {
      if (clipboardTurnEnded) requests.endClipboardTurn();
      epoch++; driver.cancelPending?.(); runtimePolicy?.reset?.(); inspections.clear(); clearEvidence();
      return finishLeases(clearAcquired(), () => lease.release());
    },
    // Shutdown restores before retiring the helper, but keeps leases until its
    // child has been collected. close() performs the final lease close.
    prepareClose() { if (closed) return; preparingClose = true; epoch++; driver.cancelPending?.(); runtimePolicy?.reset?.(); inspections.clear(); return finishLeases(clearAcquired(), () => {}); },
    abandon() { closed = true; epoch++; driver.cancelPending?.(); runtimePolicy?.reset?.(); inspections.clear(); acquired.clear(); decisions.clear(); decisionNames.clear(); },
    close() {
      if (closed) return;
      closed = true; epoch++; driver.cancelPending?.(); runtimePolicy?.reset?.(); inspections.clear(); decisions.clear(); decisionNames.clear();
      return finishLeases(clearAcquired(), () => lease.close());
    },
  };
}
