import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, openSync, closeSync, fstatSync, readdirSync, statSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyWindowIdentity } from './window-identity.mjs';
import { tabFocusRefusal } from './menu-continuation.mjs';
import { memberCall, literalValue } from './code-ast.mjs';

// Only an awaited Cmd+T, literal URL, Return chain. The splitter already excludes intervening reads and other handles.
export function nativeTabPlan(plan) {
  if (plan?.actions?.length !== 3 || plan.actions[0].selector?.kind !== 'key' ||
      !/^(?:super|cmd|command|meta)\+t$/i.test(plan.actions[0].selector.value) ||
      plan.actions[2].selector?.kind !== 'key' || !/^(?:return|enter)$/i.test(plan.actions[2].selector.value)) return false;
  const action = plan.actions[1], call = action.node?.type === 'AwaitExpression' ? memberCall(action.node.argument) : null;
  const url = call && literalValue(call.args[0]);
  return Boolean(call && !call.optional && !call.computed && call.receiver.type === 'Identifier' &&
    call.receiver.name === action.handle && call.method === 'typeText' && call.args.length === 1 &&
    typeof url === 'string' && /^https?:\/\/[^\s\u0000-\u001f]+$/i.test(url));
}

// Keep the failed structural check separate from the native walk's reason in diagnostics.
export function tabChromeRefusal(c) {
  if (!c) return 'missing-certificate';
  if (c.complete !== true) return 'native-incomplete';
  if (!Number.isSafeInteger(c.group) || c.group <= 0) return 'tab-group';
  if (!Array.isArray(c.children) || c.children.length !== c.childCount || c.childCount <= 0 || c.childCount > 256 ||
      !c.children.every(r => Number.isSafeInteger(r) && r > 0) || new Set(c.children).size !== c.children.length) return 'children';
  if (!Array.isArray(c.tabs) || c.tabs.length !== c.tabCount || c.tabCount <= 0 || !c.tabs.every(t =>
      Number.isSafeInteger(t?.ref) && c.children.includes(t.ref) && typeof t.selected === 'boolean') ||
      new Set(c.tabs.map(t => t.ref)).size !== c.tabCount || c.tabs.filter(t => t.selected).length !== 1) return 'tab-selection';
  if (!Number.isSafeInteger(c.addressField) || c.addressField <= 0) return 'address-field';
}

// The same identity and focus evidence as the tab continuation, sampled again inside its remainder.
// `since` and `now` are wall-clock milliseconds, since the guard and relay have different performance clocks.
export function tabProbeRefusal(expected, observed, since, now, transition = false, baselineOnly = false) {
  if (!Number.isSafeInteger(expected?.windowNumber) || expected.windowNumber <= 0) return 'no-window-number';
  if (!expected.nativeIdentity) return 'no-baseline';
  if (typeof observed?.title !== 'string' || !(observed.url === null || typeof observed.url === 'string') ||
      typeof observed.epoch !== 'string' || observed.window <= 0 || observed.pid <= 0 || observed.processStart <= 0) return 'malformed-identity';
  try { verifyWindowIdentity(transition ? { ...expected, title: observed?.title, url: observed?.url } : expected, observed); } catch { return 'identity-mismatch'; }
  if (observed.windowNumber !== expected.windowNumber) return 'window-number-changed';
  if (observed.headerMatches !== 1 || observed.windowSubrole !== 'AXStandardWindow') return 'ambiguous-header';
  if (!Number.isFinite(observed.hidIdleSeconds) || observed.hidIdleSeconds <= 0 ||
      !Number.isFinite(since) || !Number.isFinite(now) || now < since || observed.hidIdleSeconds < (now - since) / 1000) return 'hid-input';
  const was = expected.nativeIdentity.chrome, current = observed.chrome;
  if (tabChromeRefusal(was) || tabChromeRefusal(current)) return 'incomplete-chrome';
  if (was.group !== current.group || was.addressField !== current.addressField) return 'chrome-replaced';
  if (transition) {
    const added = current.children.filter(r => !was.children.includes(r));
    const addedTabs = current.tabs.filter(t => !was.tabs.some(old => old.ref === t.ref));
    if (current.childCount !== was.childCount + 1 || current.tabCount !== was.tabCount + 1 || added.length !== 1 ||
        addedTabs.length !== 1 || addedTabs[0].ref !== added[0] || !addedTabs[0].selected ||
        JSON.stringify(current.children.filter(r => r !== added[0])) !== JSON.stringify(was.children) ||
        JSON.stringify(current.tabs.filter(t => t.ref !== added[0]).map(t => t.ref)) !== JSON.stringify(was.tabs.map(t => t.ref))) return 'no-new-tab';
  } else if (JSON.stringify(current.children) !== JSON.stringify(was.children) || JSON.stringify(current.tabs) !== JSON.stringify(was.tabs)) return 'tab-strip-changed';
  if (baselineOnly) return;
  if (current.focused !== current.addressField) return 'focus-not-address';
  return tabFocusRefusal(observed);
}

// Opening a FIFO for reading signals demand without a sandboxed write or socket. The relay owns
// creation and publication. Each FIFO is consumed once, so holding a reader cannot queue more walks.
export function createTabProbe({ directory, observe, intervalMs = 10, timeoutMs = 600, deadlineMs = 650, freshMs = 100,
  now = Date.now, trace = () => {} } = {}) {
  const calls = new Map();
  const failure = (step, error) => ({ failureStep: step, errno: error?.code ?? null, syscall: error?.syscall ?? null,
    exitCode: Number.isInteger(error?.status) ? error.status : null });
  // The lease directory is shared by relays. Active calls live for at most 10 s; retain recent files.
  if (directory) try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!(entry.isFile() || entry.isFIFO()) || !/^tab-.+\.(?:obs|req(?:-[0-7])?)(?:\.tmp)?$/.test(entry.name)) continue;
      const path = join(directory, entry.name);
      if (now() - statSync(path).mtimeMs > 60000) rmSync(path, { force: true });
    }
  } catch { /* Cleanup failure cannot authorize a certificate. */ }
  const poll = async call => {
    if (call.ended || call.failed || now() >= call.until) return;
    let requested = false;
    if (call.samples < call.requests.length) try {
      // ENXIO means no reader yet. NONBLOCK keeps both processes cancellable.
      const fd = openSync(call.requests[call.samples], constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        if (!fstatSync(fd).isFIFO()) throw Object.assign(Error('tab request is not a FIFO'), { code: 'EINVAL', syscall: 'fstat' });
        requested = true;
      } finally { closeSync(fd); }
    } catch (error) {
      if (error.code !== 'ENXIO') {
        call.failed = true;
        trace('tab-probe-channel', { id: call.id, channel: 'read-fifo', ...failure('request-accept', error) });
        return;
      }
    }
    if (requested) {
      const request = ++call.samples;
      const start = now();
      let timer, observed, failed, timedOut = false;
      try {
        observed = await Promise.race([Promise.resolve().then(() => observe({ ...call.target, focus: true, tabCertificate: true,
          ...(call.mode === 'new-tab' ? { followTab: true } : {}) })),
          new Promise(resolve => { timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs); })]);
        if (!observed) failed = failure('native-observe', { code: timedOut ? 'ETIMEDOUT' : 'ENODATA' });
      } catch (error) { failed = failure('native-observe', error); }
      finally { clearTimeout(timer); }
      if (call.ended) return;
      try {
        writeFileSync(call.path + '.tmp', JSON.stringify({ request, start, end: now(), observed, failure: failed }), { mode: 0o600 });
        renameSync(call.path + '.tmp', call.path);
      } catch (error) { trace('tab-probe-channel', { id: call.id, channel: 'read-fifo', ...failure('observation-publish', error) }); }
      if (!observed) { call.failed = true; return; } // Never queue behind a timed-out native call.
    }
    call.timer = setTimeout(() => poll(call), intervalMs);
    call.timer.unref?.();
  };
  return {
    begin(id, target, since = now(), mode = 'remainder') {
      if (!directory || !target?.appId || !target.nativeIdentity || calls.has(id)) return;
      const stem = join(directory, `tab-${randomUUID()}`);
      const requests = Array.from({ length: 8 }, (_, i) => stem + '.req-' + i);
      const call = { id, path: stem + '.obs', requests, target, mode, samples: 0, until: now() + 10000 };
      calls.set(id, call);
      const started = performance.now();
      try { execFileSync('/usr/bin/mkfifo', ['-m', '600', ...requests], { stdio: 'pipe', timeout: 1000 }); }
      catch (error) {
        call.failed = true;
        return { target, mode, channel: 'read-fifo', failure: failure('request-create', error) };
      } finally { trace('tab-probe-create', { id, channel: 'read-fifo', ms: performance.now() - started, ok: !call.failed }); }
      void poll(call);
      return { path: call.path, request: stem + '.req', target, since, deadlineMs, freshMs, mode, channel: 'read-fifo' };
    },
    end(id) {
      const call = calls.get(id);
      if (!call) return;
      call.ended = true; calls.delete(id); clearTimeout(call.timer);
      for (const path of [call.path, call.path + '.tmp', ...call.requests]) try { rmSync(path, { force: true }); } catch {}
    },
    dispose() { for (const id of calls.keys()) this.end(id); },
  };
}
