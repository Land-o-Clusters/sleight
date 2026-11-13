// Owned JSON-lines children. Construction is inert; EOF requests collection.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { lstatSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export function noHold() {
  try { lstatSync('/tmp/sleight-hold'); } catch (e) { if (e.code === 'ENOENT') return; }
  throw Error('TIMED_WINDOW_HOLD');
}
export function sittingCommand(script, args) {
  const quote = value => /^[a-zA-Z0-9_./:=-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
  return 'CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node ' +
    [script, ...args.filter(v => v !== '--dry-run')].map(quote).join(' ');
}
export function checkJSONOutput(path) {
  if (!path) throw Error('OUTPUT_REQUIRED');
  const target = resolve(path);
  for (let p = dirname(target); ; p = dirname(p)) {
    const s = lstatSync(p);
    if (!s.isDirectory() || s.isSymbolicLink()) throw Error('OUTPUT_UNSAFE');
    if (dirname(p) === p) break;
  }
  try { lstatSync(target); } catch (e) { if (e.code === 'ENOENT') return target; throw e; }
  throw Error('OUTPUT_EXISTS');
}
export function publishJSON(path, report) {
  const target = checkJSONOutput(path);
  writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}
export function jsonChild(command, args, { onRecord = () => {}, onFault = () => {}, maxBytes = 64 * 1024 * 1024, detached = false } = {}) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], detached });
  let fault, exit, bytes = 0;
  const records = [], waiters = [];
  const reject = e => { if (!fault) onFault(e); fault ??= e; for (const w of waiters.splice(0)) w.reject(fault); };
  child.stdin.on('error', reject); child.on('error', reject); child.stderr.resume();
  const done = new Promise(resolveDone => child.once('close', (code, signal) => { exit = { code, signal }; reject(Error('CHILD_EXIT')); resolveDone(exit); }));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    bytes += Buffer.byteLength(line);
    if (bytes > maxBytes || line.length > 1024 * 1024) { reject(Error('OUTPUT_LIMIT')); child.stdin.end(); return; }
    try {
      const r = JSON.parse(line); records.push(r); onRecord(r);
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].predicate(r)) waiters.splice(i, 1)[0].resolve(r);
    } catch { reject(Error('CHILD_PROTOCOL')); child.stdin.end(); }
  });
  const send = row => { if (fault) throw fault; child.stdin.write(JSON.stringify(row) + '\n'); };
  const wait = (predicate, timeoutMs = 5000, from = records.length) => {
    const existing = records.slice(from).find(predicate);
    if (existing) return Promise.resolve(existing);
    if (fault) return Promise.reject(fault);
    return new Promise((resolveWait, rejectWait) => {
      const timer = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); rejectWait(Error('CHILD_TIMEOUT')); }, timeoutMs);
      const w = { predicate, resolve: r => { clearTimeout(timer); resolveWait(r); }, reject: e => { clearTimeout(timer); rejectWait(e); } };
      waiters.push(w);
    });
  };
  return { child, records, send, wait, done,
    async forceClose() {
      child.stdin.end();
      if (!exit || detached) try { detached ? process.kill(-child.pid, 'SIGKILL') : child.kill('SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      await done; lines.close();
    },
    async call(row) { const from = records.length; send(row); const r = await wait(r => r.reply === row.op, 5000, from); if (r.error) throw Object.assign(Error(r.error), { reply: r }); return r; },
    async close() {
      child.stdin.end();
      let timer;
      try { await Promise.race([done, new Promise((_, rejectWait) => { timer = setTimeout(() => rejectWait(Error('CLEANUP_UNCONFIRMED')), 10000); })]); }
      finally { clearTimeout(timer); }
      if (exit?.code !== 0 || exit.signal) throw Error('CLEANUP_UNCONFIRMED');
      lines.close();
    },
  };
}

// Retry only a failed bind that still owns its pending expectation. The guard
// retains the target and first window identity across these metadata-only calls.
export async function retryDocumentBinding(bind, { check = async () => {}, attempts = [],
  now = () => performance.now(), wait = sleep } = {}) {
  const began = now();
  let lastFailure;
  for (let attempt = 1; ; attempt++) {
    if (lastFailure && now() - began >= 3000) throw lastFailure;
    await check();
    if (lastFailure && now() - began >= 3000) throw lastFailure;
    let reply, failure;
    try { reply = await bind(); }
    catch (error) {
      if (error.message !== 'FIXTURE_BINDING_REQUIRED') throw error;
      failure = error; reply = error.reply;
    }
    const code = reply?.bindCode ?? (failure || reply?.error ? 'DETAIL_UNAVAILABLE' : 'BOUND');
    attempts.push({ attempt, elapsedMs: now() - began, code,
      ...(reply?.candidateCount !== undefined && { candidateCount: reply.candidateCount }),
      pendingDocument: reply?.pendingDocument === true });
    if (!failure && !reply?.error) return reply;
    failure ??= Object.assign(Error(reply.error), { reply });
    failure.bindCode = code; failure.bindingAttempts = attempts;
    lastFailure = failure;
    const remaining = 3000 - (now() - began);
    if (reply?.pendingDocument !== true || remaining <= 0) throw failure;
    await wait(Math.min(100, remaining));
  }
}

// Strict availability contract. Grants and quiet idle clocks are never qualification.
export function inputReadinessFailure(row) {
  if (row?.schema !== 'sleight.input-readiness/1' || row.qualification !== false || row.drawing !== false ||
      ['permissionRequests', 'tapOpens', 'deviceOpens', 'actionCalls'].some(key => row[key] !== 0)) return 'INPUT_READINESS_INVALID';
  const grants = ['quartzListen', 'hidListen'].map(key => row.grants?.[key]);
  if (grants.some(value => !['granted', 'denied'].includes(value))) return 'INPUT_GRANTS_UNKNOWN';
  if (grants.includes('denied')) return 'INPUT_GRANTS_DENIED';
  if (['quartzHID', 'quartzSession', 'ioHIDSystem'].some(key => !Number.isFinite(row.idleMs?.[key]) || row.idleMs[key] < 0)) return 'INPUT_IDLE_UNAVAILABLE';
  return row.ready === true && row.error === null ? undefined : 'INPUT_READINESS_INVALID';
}

export const VM_IDENTITY_FIELDS = Object.freeze(['PROCESS_START', 'WINDOW_COUNT', 'WINDOW_ID', 'WINDOW_TITLE', 'WINDOW_BOUNDS']);
// The sample's stop carries window identity and cover. hidIdleMs is the person check.
export function resumeAfterOverlay(sample) {
  if (!sample || typeof sample !== 'object') throw Error('GUARD_STALE');
  if (sample.stop) throw Error(sample.stop);
  if (sample.identityField) throw Error('IDENTITY_CHANGED');
  if (sample.systemOverlayActive) throw Error('SYSTEM_OVERLAY_ACTIVE');
  if (!Number.isFinite(sample.hidIdleMs) || sample.hidIdleMs < 0) throw Error('PERSON_ACTIVE');
  return sample;
}
// Metadata checks continue while paused, so HID activity and identity changes
// still stop immediately. A fresh preflight and sample precede the next step.
export async function waitForSystemOverlay({ check, preflight, now = () => performance.now(), wait = sleep }) {
  if (typeof preflight !== 'function') throw Error('PREFLIGHT_REQUIRED');
  let sample = await check();
  if (!sample.systemOverlayActive) return sample;
  const began = now();
  for (;;) {
    if (now() - began >= 30000) throw Error('SYSTEM_OVERLAY_PERSISTENT');
    await wait(Math.min(50, 30000 - (now() - began)));
    sample = await check();
    if (now() - began >= 30000) throw Error('SYSTEM_OVERLAY_PERSISTENT');
    if (sample.systemOverlayActive) continue;
    await preflight();
    sample = await check();
    if (!sample.systemOverlayActive) return sample;
  }
}
export function startGuard(tool, { kind, observeOnly = false, ownerPresentHandsOff = false, blockSeconds, ownerConfirmed = false, exemptSystemOverlay = false, resetCounts, onStop = () => {}, childFactory = jsonChild } = {}) {
  let stopped, sample, receivedAt, readiness, closing = false, armed = false;
  const stop = code => { if (!stopped && !closing) {
    stopped = code;
    onStop(code, code === 'IDENTITY_CHANGED' && VM_IDENTITY_FIELDS.includes(sample?.identityField) ? sample.identityField : undefined);
  } };
  const proc = childFactory(tool, ['--serve'], { detached: ownerPresentHandsOff, onRecord: r => {
    if (r.record === 'guard') { sample = r; receivedAt = performance.now(); if (r.stop) stop(r.stop); }
  }, onFault: () => stop('GUARD_EXIT') });
  const watchdog = setInterval(() => { if (armed && (!sample || performance.now() - receivedAt > 500)) stop('GUARD_STALE'); }, 100);
  return { ...proc,
    async readiness() {
      if (stopped) throw Error(stopped);
      try {
        readiness ??= await proc.call({ op: 'input-readiness' });
        const failure = inputReadinessFailure(readiness);
        if (failure) stop(failure);
      } catch (error) {
        if (error.reply?.schema === 'sleight.input-readiness/1') readiness = error.reply;
        stop(readiness ? inputReadinessFailure(readiness) ?? error.message : error.message);
      }
      if (stopped) throw Object.assign(Error(stopped), { readiness });
      return readiness;
    },
    async start() {
      if (stopped || armed || closing) throw Error(stopped ?? 'GUARD_ALREADY_STARTED');
      try {
        if (kind === 'runtime') await this.readiness();
        await proc.call({ op: 'arm', kind, observeOnly,
          ...(ownerPresentHandsOff && { ownerPresentHandsOff, ownerConfirmed }),
          ...(exemptSystemOverlay === true && { exemptSystemOverlay: true }),
          ...(['uc3f-away', 'uc3f-present'].includes(kind) && { blockSeconds, ownerConfirmed }) });
        if (stopped) throw Error(stopped);
        armed = true;
      } catch (error) { stop(error.message); throw Error(stopped); }
    },
    async engineWindow(operation, label = 'engine', callKind = label) {
      await this.beforeInput(async () => resumeAfterOverlay(await this.check()));
      const allowance = ownerPresentHandsOff ? 0 : observeOnly ? 32 : resetCounts?.[callKind];
      if (!Number.isSafeInteger(allowance) || allowance < 0 || allowance > 32) throw Error('HID_KIND_UNMEASURED');
      if (!observeOnly && allowance !== 0) { stop('HID_SOURCE_UNCONFIRMED'); throw Error(stopped); }
      let opened;
      try { opened = await proc.call({ op: 'engine-window', open: true, label, allowance }); }
      catch (error) { stop(error.message); throw Error(stopped); }
      let result, failure;
      try {
        // The open reply can race a stop record. Check again at dispatch.
        await this.check();
        if (stopped || closing) throw Error(stopped ?? 'GUARD_CLOSED');
        result = await operation();
      } catch (error) { failure = error; }
      try {
        await proc.call({ op: 'engine-window', open: false, label });
        await sleep(opened.tailMs);
        await this.check();
      } catch (error) { failure ??= error; }
      if (failure) throw failure;
      return result;
    },
    async quitFixtures(bundles) {
      await proc.call({ op: 'quit-fixtures', bundles });
      const end = performance.now() + 12000;
      while (performance.now() < end) {
        const state = await proc.call({ op: 'cleanup-check' });
        if (!Array.isArray(state.pending)) throw Error('CLEANUP_PROTOCOL');
        if (!state.pending.length) return state;
        await sleep(50);
      }
      throw Error('CLEANUP_UNCONFIRMED');
    },
    async check() {
      try {
        noHold();
        if (stopped || closing) throw Error(stopped ?? 'GUARD_CLOSED');
        if (!armed) throw Error('GUARD_NOT_ARMED');
        await proc.call({ op: 'check' });
        if (stopped) throw Error(stopped);
        if (!sample || performance.now() - receivedAt > 500) throw Error('GUARD_STALE');
        return sample;
      } catch (error) { stop(error.message); throw Error(stopped ?? error.message); }
    },
    async forceClose() { closing = true; clearInterval(watchdog); await proc.forceClose(); },
    async beforeInput(preflight) {
      if (typeof preflight !== 'function') throw Error('PREFLIGHT_REQUIRED');
      try { return await waitForSystemOverlay({ check: () => this.check(), preflight }); }
      catch (error) { if (error.message === 'SYSTEM_OVERLAY_PERSISTENT') stop(error.message); throw error; }
    },
    async close() { closing = true; clearInterval(watchdog); await proc.close(); },
  };
}
