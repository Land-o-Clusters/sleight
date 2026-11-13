// Live-only adapter for RT13. Nothing is started at import or construction.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { PROBE_APPS, main, parseProbeOptions, assertProbeSafety } from './runtime-probe.mjs';
import { ROOT, runtimeBuild, sourceIdentity, outputStem, writeRuntimeReport } from './runtime-arm.mjs';
import { validRuntimeReceipt } from './runtime-gate.mjs';
import { awaitEngineIdle, bindOwnBinary, observeRuntimeAttempt, hashHelper } from './runtime-evidence.mjs';
import { retryDocumentBinding } from './sitting-process.mjs';

export async function bindProbeFixture(sittingGuard, request, lease) {
  if (!sittingGuard?.afterOpen) return;
  if (request.bundle !== 'com.apple.TextEdit') return sittingGuard.afterOpen(request, lease);
  return retryDocumentBinding(() => sittingGuard.afterOpen(request, lease), {
    ...sittingGuard.bindingRetryOptions, attempts: sittingGuard.bindingAttempts,
    check: sittingGuard.check,
  });
}

// The fixed UC2F payload replaces the whole owned document. Compare every code
// unit, including combining marks and trailing whitespace, after saving it.
export async function measureTextDelivery({ text, prepare, action, readback, now = () => performance.now() }) {
  await prepare();
  const start = now(), reply = await action(text), elapsedMs = now() - start;
  const actual = await readback(), exactText = actual === text;
  return { elapsedMs, exactText, textMatches: exactText, caretConfirmed: exactText,
    characters: typeof actual === 'string' ? [...actual].length : null,
    charactersDelivered: reply?.charactersDelivered ?? null,
    charactersPosted: reply?.charactersPosted ?? null, delivery: reply?.delivery ?? null,
    textBeliefFallback: reply?.textBeliefFallback ?? null, compositionBypassed: reply?.compositionBypassed ?? null };
}

export async function restartTextProbeFixture({ close, reset, launch }) {
  if ((await close())?.confirmed !== true) throw Error('CLEANUP_UNCONFIRMED');
  await reset();
  await launch();
}

// UC2G is a separate measurement sitting, never part of RT1 qualification.
export function helperLifecyclePlan() {
  return [
    { id: 'helper-cold-ping', metric: 'spawnToPing', app: 'calculator', trials: 20 },
    { id: 'helper-cold-click', metric: 'readToFirstClick', app: 'calculator', trials: 20,
      reference: { metric: 'spawnToFirstClickWithInProcessRead', p50Ms: 111 } },
    { id: 'helper-idle-rss', metric: 'idleRss', app: 'textedit', trials: 1, reads: 1 },
  ];
}
export function helperLifecycleSummary(rows) {
  const values = rows.map(row => row.elapsedMs).sort((a, b) => a - b);
  const rank = p => values.length ? values[Math.ceil(values.length * p) - 1] : null;
  return { count: values.length, p50Ms: rank(0.5), p90Ms: rank(0.9) };
}
export function helperLifecycleClickCorrect(tree) {
  return /^\t*\d+ (?:text field|text entry area|text)(?: \([^)]*\))?(?: (?:Description: Edit field, )?Value: 7|, Value: 7| 7)(?:,|$)/m.test(tree);
}
export async function measureHelperLifecycleCell(cell, { prepare, createClient, readFixture, clickFixture, rss,
  check, now = () => performance.now() }) {
  if (!helperLifecyclePlan().some(row => row.metric === cell.metric)) throw Error('HELPER_METRIC_INVALID');
  await check();
  const preparing = now(), host = await prepare(), prepareMs = now() - preparing;
  if (host.status !== 'ready') throw Error('HELPER_UNAVAILABLE');
  let spawnedAt, pingAt, child;
  const client = createClient({ prepare: async () => ({ ...host, spawn(options) {
    if (child) throw Error('HELPER_RESTART_DURING_MEASUREMENT');
    spawnedAt = now(); child = host.spawn(options);
    // Timestamp the first complete handshake response, excluding the public
    // ping's second round trip. The client still validates the full envelope.
    const firstLine = bytes => {
      if (Buffer.from(bytes).includes(10)) { pingAt = now(); child.stdout.off('data', firstLine); }
    };
    child.stdout.on('data', firstLine);
    return child;
  } }) });
  try {
    await check();
    if (cell.metric === 'spawnToPing') await client.ping();
    else await readFixture(client);
    const readAt = now();
    if (spawnedAt === undefined || pingAt === undefined || !Number.isSafeInteger(child?.pid) || child.pid < 1 ||
        !/^[a-f0-9]{64}$/.test(host.build ?? ''))
      throw Error('HELPER_IDENTITY_UNAVAILABLE');
    const result = { prepareMs, spawnToPingMs: pingAt - spawnedAt, build: host.build, pid: child.pid, path: host.binary };
    if (cell.metric === 'spawnToPing') return { ...result, elapsedMs: result.spawnToPingMs };
    if (cell.metric === 'readToFirstClick') {
      await check(); const click = await clickFixture(client), clickedAt = click?.clickedAt ?? now();
      return { ...result, elapsedMs: clickedAt - readAt, acquireReadMs: readAt - spawnedAt,
        spawnToFirstClickMs: clickedAt - spawnedAt, correct: click?.correct === true };
    }
    await check(); const memory = await rss(child.pid);
    if (memory?.pid !== child.pid || memory.path !== host.binary || typeof memory.started !== 'string' ||
        !Number.isSafeInteger(memory.rssBytes) || memory.rssBytes < 1) throw Error('HELPER_RSS_UNAVAILABLE');
    return { ...result, ...memory };
  } finally { await client.close(); }
}

export async function runHelperLifecycleProbe(options, { backend, takeLock, platform = process.platform,
  held = () => existsSync('/tmp/sleight-hold'), publish = writeRuntimeReport } = {}) {
  const plan = helperLifecyclePlan();
  if (options.dryRun) return { schema: 'sleight.helper-lifecycle/1', dryRun: true, plan, totalTrials: 41 };
  assertProbeSafety({ ...options, platform, held: held(), running: [] }, plan);
  const stem = outputStem(options.out);
  const report = { schema: 'sleight.helper-lifecycle/1', plan, cells: [], cleanupConfirmed: false, complete: false };
  let unlock, fixture, cleanupFailed = false;
  const check = () => { options.signal?.throwIfAborted(); if (held()) throw Error('HOLD'); };
  try {
    check(); unlock = await takeLock();
    report.build = await backend.metadata();
    if (report.build?.runtime !== 'own' || report.build.sleightDirty !== false) throw Error('RUNTIME_IDENTITY_UNAVAILABLE');
    assertProbeSafety({ ...options, platform, held: held(), running: await backend.inventory() }, plan);
    for (const cell of plan) {
      check(); const row = { ...cell, measurements: [] }; report.cells.push(row);
      try {
        // Pings need no app. The other cells own exactly one fixture each.
        if (cell.metric !== 'spawnToPing') fixture = await backend.prepare(cell);
        for (let trial = 0; trial < cell.trials; trial++) {
          check(); row.measurements.push(await backend.measureHelperLifecycle(cell, fixture));
        }
        if (cell.metric !== 'idleRss') row.summary = helperLifecycleSummary(row.measurements);
      } finally {
        if (fixture) {
          if ((await backend.closeFixture(fixture))?.confirmed !== true) cleanupFailed = true;
          fixture = undefined;
        }
      }
      if (cleanupFailed) throw Error('CLEANUP_UNCONFIRMED');
    }
    report.complete = report.cells.every(row => row.measurements.length === row.trials &&
      (row.metric !== 'readToFirstClick' || row.measurements.every(value => value.correct)));
  } catch (error) { report.error = error.code ?? error.message; }
  finally {
    try { if ((await backend.close())?.confirmed !== true) cleanupFailed = true; }
    catch { cleanupFailed = true; }
    report.cleanupConfirmed = !cleanupFailed;
    if (unlock && report.cleanupConfirmed) await unlock();
    publish(stem, report, '# Helper lifecycle measurements\n\n```json\n' + JSON.stringify(report, null, 2) + '\n```\n');
  }
  return report;
}

async function helperLifecycleMain(args) {
  const options = parseProbeOptions(args.filter(arg => arg !== '--helper-lifecycle'));
  if (options.sitting || options.parity || options.fixRound) throw Error('HELPER_OPTIONS_INVALID');
  if (options.dryRun) { console.log(JSON.stringify(await runHelperLifecycleProbe(options), null, 2)); return 0; }
  assertProbeSafety({ ...options, held: existsSync('/tmp/sleight-hold'), running: [] }, helperLifecyclePlan());
  outputStem(options.out);
  const controller = new AbortController(), interrupt = () => controller.abort(Error('INTERRUPTED'));
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    const { acquireLiveLock } = await import('./live-lock.mjs');
    const backend = await createLiveProbe({ runtime: 'own', signal: controller.signal });
    const report = await runHelperLifecycleProbe({ ...options, signal: controller.signal }, { backend,
      takeLock: () => acquireLiveLock(undefined, { signal: controller.signal }) });
    return report.complete && report.cleanupConfirmed && !report.error ? 0 : 1;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}

// OS2 metadata samples use the guard's app-scoped hit test, never a runtime input method.
export async function sampleCoordinateParents({ bundle, sample, check, evidence = { samples: [] } }) {
  for (let index = 0; index < 25; index++) {
    await check();
    const row = await sample({ op: 'coordinate-parent', bundle, index });
    const value = row?.sample;
    if (typeof value?.refused !== 'boolean' || !Number.isSafeInteger(value.nodes) || value.nodes < 0 || value.nodes > 66 ||
        !Array.isArray(value.roles) || value.roles.some(role => typeof role !== 'string')) throw Error('PARENT_SAMPLE_INVALID');
    evidence.samples.push({ index, ...value });
    const refusals = evidence.samples.filter(row => row.refused).length;
    Object.assign(evidence, { bundle, requested: 25, sampled: evidence.samples.length, refusals,
      refusalRate: refusals / evidence.samples.length, maximumNodes: 66, inputCalls: 0 });
    await check();
  }
  const refusals = evidence.samples.filter(row => row.refused).length;
  return Object.assign(evidence, { bundle, requested: 25, sampled: evidence.samples.length, refusals,
    refusalRate: refusals / evidence.samples.length, maximumNodes: 66, inputCalls: 0 });
}

export async function measureEngineDelivery({ state, action, records, check, engineOnly, evidence = { trials: [] } }) {
  if (engineOnly !== true) throw Error('ENGINE_ONLY_REQUIRED');
  const splitView = { state: 'split-view', status: 'attended', attempts: 0, clicksReceived: 0, typesReceived: 0,
    reason: 'Split View tiling and proof require an attended setup; the sitting never tiles or switches Spaces.' };
  await check();
  const initial = await state();
  const offSpace = { state: 'off-space', status: 'attended', attempts: 0, clicksReceived: 0, typesReceived: 0,
    reason: 'The witness is on the active Space; moving it requires an attended setup.' };
  const valid = value => value && typeof value.onActiveSpace === 'boolean' && value.visible === true &&
    value.miniaturized === false && Number.isSafeInteger(value.windowNumber) && value.windowNumber > 0;
  Object.assign(evidence, { engineOnly: true, states: [offSpace, splitView], engineCalls: 0, engineCallsAttempted: 0,
    deliveryMeasured: false, unmeasured: ['off-space', 'split-view'] });
  if (!valid(initial)) throw Error('DELIVERY_STATE_UNAVAILABLE');
  if (initial.onActiveSpace) return Object.assign(evidence, { engineOnly: true, states: [offSpace, splitView], engineCalls: 0, engineCallsAttempted: 0 });
  offSpace.status = 'measured'; delete offSpace.reason;
  const requireState = async () => {
    await check(); const current = await state();
    if (!valid(current) || current.onActiveSpace || current.windowNumber !== initial.windowNumber) throw Error('DELIVERY_STATE_CHANGED');
  };
  for (let index = 0; index < 3; index++) {
    const trial = { index, engineCalls: 0, engineCallsAttempted: 0 }; evidence.trials.push(trial);
    const from = records().length;
    const dispatch = async (method, value) => {
      await requireState(); trial.engineCallsAttempted++; evidence.engineCallsAttempted++;
      await action(method, value); trial.engineCalls++; evidence.engineCalls++;
    };
    await dispatch('click', { id: 'probe-button' });
    await dispatch('click', { id: 'plain' });
    const baseline = records().filter(r => r.name === 'textChange' && r.target === 'plain').at(-1)?.details?.length ?? 0;
    const token = 'OS2-token';
    await dispatch('typeText', token);
    await requireState();
    const received = records().slice(from);
    trial.clickReceived = received.some(r => r.record === 'callback' && r.name === 'button' && r.target === 'probe-button');
    trial.typeReceived = received.filter(r => r.record === 'callback' && r.name === 'textChange' && r.target === 'plain').at(-1)?.details?.length === baseline + token.length;
    trial.witness = received;
    offSpace.attempts++; offSpace.clicksReceived += Number(trial.clickReceived); offSpace.typesReceived += Number(trial.typeReceived);
  }
  return Object.assign(evidence, { engineOnly: true, states: [offSpace, splitView], engineCalls: evidence.trials.reduce((n, row) => n + row.engineCalls, 0),
    deliveryMeasured: true, unmeasured: ['split-view'] });
}

// RT2 docs/design/mac-driver.md (codex/rt2, 2026-10-30): binding + readId + positional args.
// No driver protocol, safety or input implementation lives in the harness.
export function driverProbeAdapter(client, { processIdentity = () => undefined, sitting = false, inputAdmission = false } = {}) {
  let binding, readId, pendingInput = false, driverRequests = 0, runNonce, startPing;
  const request = async (method, params) => {
    let result;
    try { result = await client.request(method, params); }
    catch (error) {
      if (error.unhealthy) throw Error('DRIVER_UNHEALTHY');
      if (error.delivery && error.delivery !== 'not-sent') throw Error('INPUT_DELIVERY_UNCONFIRMED');
      throw error;
    }
    if (result?.personTookOver) throw Error('PERSON_TOOK_OVER');
    if (result?.unhealthy) throw Error('DRIVER_UNHEALTHY');
    if (result?.window && binding && (result.window.windowId !== binding.windowId || result.window.processStart !== binding.processStart)) throw Error('IDENTITY_CHANGED');
    if (Number.isSafeInteger(result?.readId)) readId = result.readId;
    if (!['ping', 'health'].includes(method)) driverRequests++;
    return result;
  };
  return {
    async beginRun(nonce) {
      runNonce = nonce; driverRequests = 0; startPing = undefined;
      try { startPing = await request('ping', { runNonce }); }
      catch { throw Error('RUNTIME_RECEIPT_INVALID'); }
      if (startPing?.runNonce !== runNonce || !Number.isSafeInteger(startPing.apiVersion) || startPing.apiVersion < 1 ||
          !/^[a-f0-9]{64}$/.test(startPing.build ?? '')) throw Error('RUNTIME_RECEIPT_INVALID');
    },
    async receipt(build, processEvidence) {
      let ping;
      try { ping = await request('ping', { runNonce }); }
      catch { throw Error('RUNTIME_RECEIPT_INVALID'); }
      if (!startPing || startPing.build !== ping.build || startPing.apiVersion !== ping.apiVersion) throw Error('RUNTIME_RECEIPT_INVALID');
      const serving = processIdentity();
      const binaries = processEvidence?.binaries?.filter(binary => binary.pid === serving?.pid && binary.path === serving?.path) ?? [];
      const receipt = { schema: 'sleight.runtime-receipt/1', runtime: 'own', runNonce, runtimeBuild: build,
        driverVersion: String(ping.apiVersion), driverSourceBuild: ping.build,
        driverBuild: binaries.length === 1 ? binaries[0].sha256 : undefined, driverRequests,
        driverPid: serving?.pid, driverPath: serving?.path, engineHelperStarts: processEvidence?.engineHelperStarts, ping };
      if (!sitting && !validRuntimeReceipt(receipt, { nonce: runNonce, build, processEvidence: bindOwnBinary(receipt, processEvidence) })) throw Error('RUNTIME_RECEIPT_INVALID');
      return receipt;
    },
    async preflight() {
      const ping = await request('ping', {});
      const required = ['getApp', 'getAXState', 'getAXStateAndScreenshot', ...(sitting ? [] : ['click', 'pressKey', 'typeText', 'settle']),
        ...(inputAdmission ? ['personState'] : [])];
      if (!Array.isArray(ping?.methods) || required.some(method => !ping.methods.includes(method))) throw Error('RUNTIME_ABSENT: RT2 to RT7 methods missing: ' + required.filter(m => !ping?.methods?.includes(m)).join(', '));
      const health = await request('health', {});
      if (health?.accessibility !== true || health?.screenRecording !== true) throw Error('RUNTIME_GRANTS_REQUIRED');
    },
    async acquire(selector) {
      binding = undefined; pendingInput = false;
      const reply = await request('getApp', { selector, launch: false });
      if (!/^[1-9]\d*$/.test(reply?.window?.windowId ?? '') || !reply.window.processStart || typeof reply.window.processStart !== 'string' || !Number.isSafeInteger(reply.readId) || reply.readId < 1) throw Error('DRIVER_PROTOCOL');
      binding = { windowId: reply.window.windowId, processStart: reply.window.processStart };
      return reply;
    },
    async read(combined = false) {
      if (pendingInput) {
        const settled = await request('settle', { ...binding, afterReadId: readId });
        if (settled.settled !== true) throw Error('SETTLE_UNCONFIRMED');
        pendingInput = false;
      }
      return request(combined ? 'getAXStateAndScreenshot' : 'getAXState', { ...binding });
    },
    async act(method, ...args) {
      if (sitting) throw Error('SITTING_READ_ONLY');
      if (!binding || !Number.isSafeInteger(readId)) throw Error('NO_BOUND_READ');
      let personToken;
      if (inputAdmission) {
        const person = await request('personState', { ...binding });
        if (typeof person?.token !== 'string' || !person.token || person.personTookOver !== false) throw Error('PERSON_TOOK_OVER');
        personToken = person.token;
      }
      const reply = await request(method, { ...binding, readId, args,
        ...(inputAdmission && { personToken, read: 'none' }) });
      if (!['sent-unverified', 'sent-verified'].includes(reply?.delivery)) throw Error('INPUT_DELIVERY_UNCONFIRMED');
      pendingInput = true; return reply;
    },
    async settle() {
      const reply = await request('settle', { ...binding, afterReadId: readId });
      if (reply.settled !== true) throw Error('SETTLE_UNCONFIRMED');
    },
    async forceClose() {
      try { await client.stopHeld?.(); }
      finally { return client.forceClose ? client.forceClose() : client.close(); }
    },
    close: () => client.close(),
  };
}
// Observation faults are retained without skipping or replaying the read.
// The qualification path still uses the strict observer unchanged.
export async function observeSittingAttempt(operation, { inventory, hash = hashHelper, ...options } = {}) {
  const observationErrors = [];
  const record = error => observationErrors.push(/^[A-Z][A-Z0-9_]+/.exec(error.code ?? error.message)?.[0] ?? 'PROCESS_OBSERVATION_FAILED');
  const safeInventory = async () => {
    try {
      const value = await inventory();
      if (![value?.helpers, value?.drivers].every(rows => Array.isArray(rows) && rows.every(p =>
        Number.isSafeInteger(p?.pid) && p.pid > 0 && typeof p.started === 'string' && !!p.started &&
        typeof p.path === 'string' && p.path.startsWith('/')))) throw Error('PROCESS_INVENTORY_INVALID');
      return value;
    } catch (error) { record(error); return { helpers: [], drivers: [] }; }
  };
  try {
    const result = await observeRuntimeAttempt(operation, { ...options, inventory: safeInventory,
      hash: path => { try { return hash(path); } catch (error) { record(error); return undefined; } } });
    return { ...result, processEvidence: { ...result.processEvidence, required: false, observationErrors } };
  } catch (error) {
    error.processEvidence = { ...error.processEvidence, required: false, observationErrors };
    throw error;
  }
}
// Abort begins owned-client shutdown without waiting for the in-flight read.
// Every later method refuses before reaching that client; close remains usable.
export function abortableProbeAdapter(adapter, signal) {
  let closing;
  const close = () => {
    signal?.removeEventListener('abort', abort);
    return closing ??= Promise.resolve().then(() => adapter.close());
  };
  const abort = () => { void close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return Object.fromEntries(Object.entries({ ...adapter, close }).map(([key, value]) => [key,
    !['close', 'forceClose'].includes(key) && typeof value === 'function' ? (...args) => { signal?.throwIfAborted(); return value(...args); } : value]));
}
export function engineProbeAdapter(client, { engineWindow = operation => operation(), splitAcquisition = false, signal } = {}) {
  let receipt;
  const evaluate = async (code, kind = 'read') => {
    const reply = await engineWindow(() => {
      signal?.throwIfAborted();
      return client.call('js', { code: `${code}`, title: 'Runtime mechanism probe', timeout_ms: 30000 });
    }, 'latency-engine', kind);
    // RT8 exports the serving relay's identity as a sideband, outside tool text.
    // A missing sideband stays missing; readEngine's expected version is no substitute.
    if (reply?.engineReceipt) receipt = reply.engineReceipt;
    if (reply?.isError) throw Error('ENGINE_CALL_FAILED');
    const line = (reply.content ?? []).filter(c => c.type === 'text').flatMap(c => c.text.split('\n')).findLast(t => t.startsWith('RT13JSON:'));
    if (!line) throw Error('ENGINE_REPLY_UNAVAILABLE');
    try { return JSON.parse(line.slice(9)); } catch { throw Error('ENGINE_REPLY_INVALID'); }
  };
  return {
    engineReceipt: () => receipt,
    preflight: async () => {},
    acquire: async selector => {
      if (splitAcquisition) {
        await evaluate(`var rt13App = await cua.getApp(${JSON.stringify(selector)}); console.log('RT13JSON:{}');`, 'getApp');
        return evaluate(`console.log('RT13JSON:'+JSON.stringify({text:await rt13App.getAXState({emit:false,disableDiffing:true})}));`);
      }
      return evaluate(`var rt13App = await cua.getApp(${JSON.stringify(selector)}); console.log('RT13JSON:'+JSON.stringify({text:await rt13App.getAXState({emit:false,disableDiffing:true})}));`);
    },
    read: combined => evaluate(combined
      ? `var rt13Read = await rt13App.getAXStateAndScreenshot({emit:false,disableDiffing:true}); console.log('RT13JSON:'+JSON.stringify({text:rt13Read.state,screenshot:rt13Read.screenshot}));`
      : `console.log('RT13JSON:'+JSON.stringify({text:await rt13App.getAXState({emit:false,disableDiffing:true})}));`, combined ? 'combined-read' : 'read'),
    act: (method, ...args) => evaluate(`await rt13App[${JSON.stringify(method)}](...${JSON.stringify(args)}); console.log('RT13JSON:{}');`),
    settle: async () => {}, // Engine reads already perform their own settle.
    async forceClose() {
      try { await client.stopHeld?.(); }
      finally { return client.forceClose ? client.forceClose() : client.close(); }
    },
    close: () => client.close(),
  };
}
// Own native observer/cover process; stdin EOF is the only normal shutdown route.
// An uncertain collection keeps the bank and the cooperative live lock.
export const startProbeWitness = (bank, options) => startWitness(bank, 'runtime-probe-host', options);
export const startProcessWitness = (bank, options) => startWitness(bank, 'runtime-process-host', options);
async function startWitness(bank, source, { runProcess, signal, detached = false } = {}) {
  const binary = join(bank, source);
  const result = await runProcess('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'module-cache'),
    fileURLToPath(new URL(`./${source}.swift`, import.meta.url)), '-o', binary], { timeoutMs: 180000, signal });
  if (!result.groupClean || result.exit?.code !== 0) throw Object.assign(Error('WITNESS_BUILD_FAILED'), { cleanupConfirmed: result.groupClean === true });
  const child = spawn(binary, ['--serve'], { stdio: ['pipe', 'pipe', 'pipe'], detached });
  child.stderr.resume();
  const pending = [];
  let exited = false, exitCode, fault;
  const fail = error => { fault = error; while (pending.length) pending.shift().reject(error); };
  const done = new Promise(resolve => child.once('close', code => { exited = true; exitCode = code; fail(Error('WITNESS_EXIT')); resolve(); }));
  child.once('error', fail); child.stdin.on('error', fail);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const waiter = pending.shift();
    if (!waiter) { fail(Error('WITNESS_PROTOCOL')); return; }
    try { const value = JSON.parse(line); if (value.error) waiter.reject(Error(value.error)); else waiter.resolve(value); }
    catch (error) { waiter.reject(error); }
  });
  return {
    call: row => {
      if (fault || exited) return Promise.reject(fault ?? Error('WITNESS_EXIT'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(Error('WITNESS_TIMEOUT')), row.op === 'renderer-launch' ? 45000 : 15000);
        pending.push({ resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
        child.stdin.write(JSON.stringify(row) + '\n');
      });
    },
    async close() {
      child.stdin.end();
      let timer;
      try { await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('WITNESS_CLEANUP_UNCONFIRMED')), 10000); })]); }
      finally { clearTimeout(timer); lines.close(); }
      if (!exited || exitCode !== 0) throw Error('WITNESS_CLEANUP_UNCONFIRMED');
    },
  };
}
export async function createLiveProbe({ runtime, signal, root = ROOT, sitting = false, sittingGuard } = {}) {
  if (sittingGuard && !sitting) throw Error('SITTING_GUARD_ONLY');
  if (sitting) runtime = 'own';
  // Check availability before creating any helper, fixture or lock.
  if (runtime === 'own') runtimeBuild(root, runtime);
  let driverFactory;
  if (runtime === 'own') {
    const module = await import(pathToFileURL(join(root, 'plugins/sleight/lib/mac-driver/client.mjs')));
    driverFactory = module.createMacDriverClient;
    if (typeof driverFactory !== 'function') throw Error('RUNTIME_ABSENT: RT2 createMacDriverClient unavailable');
  }
  let bank, witness, processWitness, driver, currentSide, active, cleanupFault = false, currentTrace = [];
  const drivers = new Map(), openingClients = new Set();
  const fixtures = new Set();
  const { readEngine } = await import('./engine-version.mjs');
  const { runOwned } = await import('./preapproved-process.mjs');
  const { openFixture, closeFixtures } = await import('./real-fixture.mjs');
  const { writeDocument, readDocument } = await import('./battery/documents.mjs');
  const boundary = () => { signal?.throwIfAborted(); if (existsSync('/tmp/sleight-hold')) throw Error('HOLD'); };
  const observe = async (fixture, op = 'sample') => {
    boundary();
    return witness.call({ op, marker: fixture.cell.app === 'calculator' ? '' : fixture.marker });
  };
  const initialize = async () => {
    if (witness) return;
    bank = mkdtempSync('/private/tmp/sleight-rt13-');
    try {
      try { processWitness = await startProcessWitness(bank, { runProcess: runOwned, signal, detached: sittingGuard?.ownerPresentHandsOff === true }); }
      catch (error) {
        if (!sitting || error.cleanupConfirmed === false || signal?.aborted) throw error;
        // The sitting can still collect reads when its optional scanner failed
        // to build. Each attempted sample records the missing observer.
      }
      witness = await startProbeWitness(bank, { runProcess: runOwned, signal, detached: sittingGuard?.ownerPresentHandsOff === true });
    } catch (error) { if (error.cleanupConfirmed === false) cleanupFault = true; throw error; }
  };
  const processInventory = () => {
    if (!processWitness) throw Error('PROCESS_INVENTORY_UNAVAILABLE');
    return processWitness.call({ op: 'inventory' });
  };
  const initDriver = async (side = runtime) => {
    if (currentSide && currentSide !== side) {
      await drivers.get(currentSide)?.close(); drivers.delete(currentSide);
    }
    currentSide = side;
    if (drivers.has(side)) { driver = drivers.get(side); return; }
    if (side === 'own') {
      const { prepareMacDriver } = await import(pathToFileURL(join(root, 'plugins/sleight/lib/mac-driver/build.mjs')));
      let serving;
      driver = driverProbeAdapter(driverFactory({ prepare: async options => {
        const host = await prepareMacDriver(options);
        return { ...host, spawn: options => { const child = host.spawn(options);
          serving = { pid: child.pid, path: host.binary }; return child; } };
      } }), { processIdentity: () => serving, sitting });
    }
    else {
      const { probeClient } = await import('./double-keys-client.mjs');
      const { benchmarkDecision } = await import('./approve.mjs');
      driver = engineProbeAdapter(await probeClient({ command: join(root, 'plugins/sleight/bin/sleight-mcp'), args: [],
        env: { ...process.env, SLEIGHT_RUNTIME: side, SLEIGHT_HAND: '0', SLEIGHT_CURSOR: '0', BENCH_ROOT: root,
          SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_REMOTE_APPROVALS: '0', BENCH_SUITE: 'real' } }, { relay: false, signal, detached: !!sittingGuard?.ownerPresentHandsOff, onClient: client => openingClients.add(client), record: () => {}, approve: async params => {
          const requestedApp = /^Allow Computer Use to use "(.+)"\?$/.exec(params.message ?? '')?.[1];
          const app = active && PROBE_APPS[active.cell.app];
          if (!app || ![app.app, app.bundle, ...(active.cell.app === 'word' ? ['Word'] : active.cell.app === 'excel' ? ['Excel'] : [])].includes(requestedApp)) throw Error('APPROVAL_REFUSED');
          const decision = benchmarkDecision({ mcp_server_name: 'plugin:sleight:computer', message: params.message,
            requested_schema: params.requestedSchema, mode: params.mode }, { BENCH_SUITE: 'real' })?.hookSpecificOutput;
          if (decision?.action !== 'accept') throw Error('APPROVAL_REFUSED');
          return { action: 'accept', content: decision.content ?? {} };
        } }), { engineWindow: sittingGuard?.engineWindow, splitAcquisition: !!sittingGuard, signal });
    }
    if (sittingGuard?.ownerPresentHandsOff) driver = abortableProbeAdapter(driver, signal);
    drivers.set(side, driver);
    openingClients.clear();
    await driver.preflight();
  };
  const launch = async fixture => {
    boundary();
    const app = PROBE_APPS[fixture.cell.app];
    const running = (await witness.call({ op: 'inventory' })).apps;
    if (fixture.cell.app !== 'finder' && running.some(item => item.bundle === app.bundle)) throw Error('APP_ALREADY_RUNNING');
    const ctx = fixture.ctx = { dir: fixture.dir, nonce: fixture.marker, ownerAway: !sittingGuard, signal: sittingGuard ? undefined : signal, fixtureRoot: bank };
    fixtures.add(fixture);
    if (app.format === 'html') {
      fixture.server = createServer((req, res) => {
        if (req.method !== 'GET' || req.url !== `/${fixture.marker}/`) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); res.end(readFileSync(fixture.path));
      });
      await new Promise((resolve, reject) => { fixture.server.once('error', reject); fixture.server.listen(0, '127.0.0.1', resolve); });
      fixture.url = `http://127.0.0.1:${fixture.server.address().port}/${fixture.marker}/`;
    }
    const request = { ...app, bundle: app.bundle, target: fixture.url ?? fixture.path ?? '', token: fixture.marker,
      mode: app.format === 'folder' ? 'folder' : app.format === 'html' ? 'web' : app.format ? 'document' : 'inherit',
      stopOnLiveHold: true, ...(app.format === 'html' && { fixtureKind: 'web-page' }) };
    await sittingGuard?.beforeOpen?.(request);
    const lease = await openFixture(ctx, request, sittingGuard?.fixtureOptions);
    await bindProbeFixture(sittingGuard, request, lease);
    assertProbeFixtureLease(fixture.cell, lease);
    fixture.lease = lease;
    await witness.call({ op: 'bind', bundle: app.bundle });
    active = fixture;
    await initDriver();
    await driver.acquire(app.bundle);
    fixture.lastRead = await driver.read(false);
  };
  const closeFixture = async fixture => {
    let confirmed = true;
    try {
      if (sittingGuard) {
        if (fixture.ctx) await sittingGuard.closeFixtures(fixture.ctx);
      } else {
        await witness.call({ op: 'uncover' });
        if (existsSync('/tmp/sleight-hold') || signal?.aborted) throw Error('CLEANUP_DEFERRED');
        if (fixture.newDocument) {
          if ((await witness.call({ op: 'close-new' })).confirmed !== true) throw Error('CLEANUP_UNCONFIRMED');
          fixture.newDocument = false;
        }
        if (fixture.ctx) await closeFixtures(fixture.ctx);
      }
      // Independent NSWorkspace inventory confirms helper cleanup rather than trusting its receipt alone.
      const running = (await witness.call({ op: 'inventory' })).apps;
      if (fixture.cell.app === 'finder') {
        if (fixture.lease?.diagnostics?.windowCleanupConfirmed !== true) throw Error('FINDER_WINDOW_CLEANUP_UNCONFIRMED');
        if ((await observe(fixture)).gone !== true) throw Error('FINDER_WINDOW_CLEANUP_UNCONFIRMED');
      } else if (running.some(item => item.bundle === PROBE_APPS[fixture.cell.app].bundle)) throw Error('APP_EXIT_UNCONFIRMED');
    } catch { confirmed = false; }
    try {
      if (fixture.server) {
        const server = fixture.server;
        await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
        fixture.server = undefined;
      }
    } catch { confirmed = false; }
    if (confirmed) {
      fixtures.delete(fixture); if (active === fixture) active = undefined;
      return { confirmed: true };
    }
    cleanupFault = true; return { confirmed: false };
  };
  const read = async (combined = false) => {
    boundary();
    // The post-input read includes RT6's settle. No polling read can mask a stale first result.
    const start = performance.now(), reply = await driver.read(combined);
    currentTrace.push({ op: combined ? 'combined-read' : 'ax-read', elapsedMs: performance.now() - start,
      readId: reply.readId ?? null, truncated: reply.truncated === true });
    if (typeof reply.text !== 'string' || !reply.text.startsWith('Window:') || reply.truncated) throw Error('READ_UNAVAILABLE');
    if (active) active.lastRead = reply;
    return reply;
  };
  const act = async (method, ...args) => {
    if (sitting) throw Error('SITTING_READ_ONLY');
    boundary(); const start = performance.now();
    try {
      const reply = await driver.act(method, ...args);
      currentTrace.push({ op: method, elapsedMs: performance.now() - start, delivery: reply.delivery ?? 'engine-acknowledged' });
      return reply;
    } catch (error) {
      currentTrace.push({ op: method, elapsedMs: performance.now() - start,
        error: /^[A-Z][A-Z0-9_]+/.exec(error.code ?? error.message)?.[0] ?? 'ACTION_FAILED' });
      throw error;
    }
  };
  const find = (tree, expression) => {
    const matches = tree.split('\n').map(line => /^\t*(\d+) (.*)$/.exec(line)).filter(m => m && expression.test(m[2]));
    if (matches.length !== 1) throw Error('TARGET_UNAVAILABLE');
    return Number(matches[0][1]);
  };
  const clickBody = async fixture => {
    const state = await observe(fixture);
    if (!state.bodyPoint) throw Error('CARET_TARGET_UNAVAILABLE');
    await act('click', state.bodyPoint); await read();
  };
  const saveFile = async fixture => { await act('pressKey', 'super+s'); await read(); return readDocument(fixture.path, PROBE_APPS[fixture.cell.app].format); };
  const hasSheet = tree => /^\t*\d+ (?:sheet|dialog)\b/m.test(tree);
  const newDocument = async (fixture, index) => {
    if (fixture.newDocument) {
      if ((await witness.call({ op: 'close-new' })).confirmed !== true) throw Error('CLEANUP_UNCONFIRMED');
      fixture.newDocument = false;
      await driver.acquire(PROBE_APPS.textedit.bundle);
    }
    await witness.call({ op: 'before-new' });
    await act('pressKey', 'super+n');
    // Never replay the creation chord. Only observe the one newly-created AX window.
    let retained = false;
    for (let tick = 0; tick < 20 && !retained; tick++) {
      try { await witness.call({ op: 'retain-new' }); retained = true; }
      catch (error) { if (error.message !== 'NEW_WINDOW_UNCONFIRMED') throw error; await sleep(50); }
    }
    if (!retained) { cleanupFault = true; throw Error('NEW_WINDOW_UNCONFIRMED'); }
    fixture.newDocument = true;
    await driver.acquire(PROBE_APPS.textedit.bundle);
    fixture.newText = fixture.marker + '-new-' + index;
    await act('typeText', fixture.newText);
    const reply = await read();
    if (!reply.text.includes(fixture.newText)) throw Error('CARET_UNCONFIRMED');
    if (!(await observe(fixture)).bodyPoint) throw Error('CARET_UNCONFIRMED');
  };
  const saveSheet = async fixture => {
    await act('pressKey', 'super+s');
    const state = await read();
    if (!hasSheet(state.text)) throw Error('SAVE_SHEET_UNAVAILABLE');
    return state;
  };
  const finishSaveSheet = async (fixture, index, state) => {
    const name = find(state.text, /(?:text field|text entry area).*Save As/i);
    await act('click', name); await act('pressKey', 'super+a');
    const target = `${fixture.marker}-${index}.rtf`;
    await act('typeText', target);
    await act('pressKey', 'super+shift+g'); await read();
    await act('typeText', fixture.dir); await act('pressKey', 'Return'); await read();
    const before = await read();
    if (!hasSheet(before.text)) throw Error('SAVE_SHEET_UNAVAILABLE');
    await act('pressKey', 'Return');
    const next = await read();
    fixture.savedPath = join(fixture.dir, target);
    return { sheetBefore: true, sheetGoneInNextRead: !hasSheet(next.text),
      fileMatches: existsSync(fixture.savedPath) && readFileSync(fixture.savedPath, 'utf8').includes(fixture.newText) };
  };
  return {
    metadata(side = runtime) {
      const engine = readEngine();
      return { runtime: side, runtimeBuild: runtimeBuild(root, side, engine.version), engineVersion: engine.version, engineBuild: engine.chatgptBuild,
        ...sourceIdentity(root),
        buildKind: 'source hash (own); engine version (engine); serving binary hash in trial process evidence' };
    },
    async inventory() { await initialize(); return (await witness.call({ op: 'inventory' })).apps; },
    async measureHelperLifecycle(cell, fixture) {
      boundary(); await initialize();
      if (cell.metric === 'readToFirstClick') {
        await initDriver('own');
        await driver.acquire(PROBE_APPS.calculator.bundle);
        await act('pressKey', 'Escape'); await read();
      }
      // Collect the setup helper before measuring a new process, every trial.
      await drivers.get('own')?.close(); drivers.delete('own');
      const { prepareMacDriver } = await import(pathToFileURL(join(root, 'plugins/sleight/lib/mac-driver/build.mjs')));
      let adapter, initial;
      const before = fixture ? await observe(fixture) : undefined;
      try {
        const result = await measureHelperLifecycleCell(cell, {
          prepare: () => prepareMacDriver({ signal }), createClient: driverFactory, check: boundary,
          async readFixture(client) {
            adapter = driverProbeAdapter(client);
            initial = await adapter.acquire(PROBE_APPS[cell.app].bundle);
            if (!initial.text?.startsWith('Window:') || initial.truncated) throw Error('READ_UNAVAILABLE');
            if (cell.app === 'textedit' && !initial.text.includes(fixture.marker)) throw Error('IDENTITY_CHANGED');
          },
          async clickFixture() {
            const target = find(initial.text, /button.*(?:Seven|7)(?:,|$)/);
            boundary(); await adapter.act('click', target);
            const clickedAt = performance.now();
            boundary(); const next = await adapter.read();
            return { clickedAt, correct: helperLifecycleClickCorrect(next.text) };
          },
          async rss(pid) {
            const rows = (await processInventory()).drivers.filter(row => row.pid === pid);
            if (rows.length !== 1) throw Error('HELPER_IDENTITY_UNAVAILABLE');
            return processWitness.call({ op: 'rss', ...rows[0] });
          },
        });
        if (fixture) {
          const after = await observe(fixture);
          if (before.background !== true || after.background !== true) throw Error('FOCUS_CHANGED');
        }
        return result;
      } catch (error) {
        if (error.code === 'DRIVER_RETIRE_TIMEOUT') cleanupFault = true;
        throw error;
      }
    },
    async prepare(cell) {
      boundary();
      const dir = join(bank, randomUUID()); mkdirSync(dir, { mode: 0o700 });
      const marker = 'RT13-' + randomUUID(), format = PROBE_APPS[cell.app].format;
      const fixture = { cell, dir, marker };
      if (format === 'folder') { fixture.path = join(dir, marker); mkdirSync(fixture.path); writeFileSync(join(fixture.path, marker + '.txt'), marker); }
      else if (format === 'html') {
        fixture.path = join(dir, marker + '.html');
        writeFileSync(fixture.path, `<!doctype html><title>${marker}</title><p>${marker}</p><label>RT13 field<input aria-label="RT13 field" value="${marker}"></label>`);
      } else if (format) { fixture.path = join(dir, marker + '.' + format); writeDocument(fixture.path, format, marker); }
      try { await launch(fixture); }
      catch (error) { if (fixtures.has(fixture) && !(await closeFixture(fixture)).confirmed) cleanupFault = true; throw error; }
      return fixture;
    },
    async waitForEngineIdle() {
      // Close the engine client once at the block boundary before waiting.
      await initDriver('own');
      try { return await awaitEngineIdle(processInventory, { signal, boundary }); }
      catch (error) {
        if (!sitting || signal?.aborted || error.message === 'HOLD') throw error;
        return { ...error.idleWait, outcome: error.idleWait?.outcome ?? 'unavailable',
          error: /^[A-Z][A-Z0-9_]+/.exec(error.message)?.[0] ?? 'PROCESS_OBSERVATION_FAILED' };
      }
    },
    async trial(cell, fixture, index, { runtime: side = runtime, runNonce } = {}) {
      await initDriver(side);
      const idleWait = side === 'own' && !sitting
        ? await awaitEngineIdle(processInventory, { signal, boundary }) : undefined;
      try {
        const observed = await (sitting ? observeSittingAttempt : observeRuntimeAttempt)(() => this.performTrial(cell, fixture, index, { runtime: side, runNonce }),
          { inventory: processInventory });
        let runtimeReceipt;
        try { runtimeReceipt = side === 'own' ? await driver.receipt(runtimeBuild(root, 'own'), observed.processEvidence) : undefined; }
        catch (error) { throw Object.assign(error, { processEvidence: observed.processEvidence }); }
        return { ...observed.value, runtimeReceipt, idleWait, processEvidence: side === 'own'
          ? bindOwnBinary(runtimeReceipt, observed.processEvidence) : observed.processEvidence,
          ...(side === 'engine' && { engineReceipt: driver.engineReceipt?.() }) };
      } catch (error) { throw Object.assign(error, { idleWait }); }
    },
    async performTrial(cell, fixture, index, { runtime: side, runNonce }) {
      currentTrace = [];
      try {
        if (sitting && (cell.group !== 6 || !['calculator', 'textedit'].includes(cell.app) ||
            !['idleRead', 'combinedRead', 'acquisition'].includes(cell.metric))) throw Error('SITTING_READ_ONLY');
        boundary();
        await initDriver(side);
        if (side === 'own') await driver.beginRun(runNonce);
        if (cell.uc2f === true && index > 0) {
          await restartTextProbeFixture({ close: () => closeFixture(fixture),
            reset: () => writeDocument(fixture.path, PROBE_APPS[cell.app].format, fixture.marker), launch: () => launch(fixture) });
        } else if (cell.mechanism === 'covered-click' && index > 0) {
          if (!(await closeFixture(fixture)).confirmed) throw Error('CLEANUP_UNCONFIRMED');
          await launch(fixture);
        }
        // Bind the serving client after switching sides, outside the timed region.
        await initDriver(side);
        await driver.acquire(PROBE_APPS[cell.app].bundle);
        await driver.read(false);
        if (['save-chord', 'go-to-folder-chord', 'sheet-settle'].includes(cell.mechanism)) await newDocument(fixture, index);
        const before = await observe(fixture);
        if (before.background !== true) throw Error('FOCUS_CHANGED');
        let evidence = { observed: true, background: true, posted: true };
        if (cell.mechanism === 'covered-click') {
          const covered = await observe(fixture, 'cover');
          if (!covered.closePoint) throw Error('CLOSE_TARGET_UNAVAILABLE');
          await act('click', covered.closePoint);
          let after;
          for (let tick = 0; tick < 20; tick++) { after = await observe(fixture); if (after.gone) break; await sleep(50); }
          evidence = { ...evidence, covered: covered.covered, windowClosed: after.gone === true };
        } else if (cell.mechanism === 'save-chord') {
          const state = await saveSheet(fixture);
          evidence.fileMatches = (await finishSaveSheet(fixture, index, state)).fileMatches;
        } else if (cell.mechanism === 'go-to-folder-chord') {
          await saveSheet(fixture); await act('pressKey', 'super+shift+g');
          const next = await read();
          evidence = { ...evidence, saveSheetBefore: true, goToFolderAfter: /Go to (?:the )?folder/i.test(next.text) };
          await act('pressKey', 'Escape'); await act('pressKey', 'Escape'); await read();
        } else if (cell.mechanism === 'type-at-caret') {
          const token = `rt13type${index}x`;
          if (cell.uc2f === true) {
            if (cell.app !== 'textedit' || typeof cell.text !== 'string') throw Error('TEXT_PROBE_FIXTURE_REQUIRED');
            evidence = { ...evidence, ...await measureTextDelivery({ text: cell.text,
              prepare: async () => { await clickBody(fixture); await act('pressKey', 'super+a'); await read(); },
              action: text => act('typeText', text), readback: () => saveFile(fixture) }) };
          } else if (cell.app === 'safari') {
            const target = find((await read()).text, /(?:text field|text entry area).*RT13 field/);
            await act('click', target); await read(); await act('typeText', token);
            evidence.textMatches = (await read()).text.split('\n').some(line => /(?:text field|text entry area)/.test(line) && line.includes(token));
          } else if (cell.app === 'excel') {
            await act('pressKey', 'ctrl+Home'); await read(); await act('typeText', token); await act('pressKey', 'Return');
            evidence.textMatches = (await saveFile(fixture)).includes(token);
          } else {
            await clickBody(fixture); await act('typeText', token); evidence.textMatches = (await saveFile(fixture)).includes(token);
          }
          evidence.caretConfirmed = evidence.textMatches;
        } else if (cell.mechanism === 'covered-capture') {
          const covered = await observe(fixture, 'cover');
          const reply = await read(true), image = reply.screenshot;
          const rendered = image?.data ? await witness.call({ op: 'image', base64: image.data, marker: cell.app === 'calculator' ? '0' : fixture.marker }) : {};
          evidence = { ...evidence, covered: covered.covered, singleReply: true, treePresent: !!reply.text,
            imagePresent: typeof image?.data === 'string', imageMatchesWindow: rendered.matches === true };
        } else if (cell.mechanism === 'hid-idle') {
          evidence.hid = {};
          for (const kind of ['click', 'key', 'type']) {
            const start = await observe(fixture), t = performance.now();
            if (kind === 'click') { if (!start.bodyPoint) throw Error('CARET_TARGET_UNAVAILABLE'); await act('click', start.bodyPoint); }
            if (kind === 'key') await act('pressKey', 'End');
            if (kind === 'type') await act('typeText', 'rt13idle');
            const end = await observe(fixture);
            evidence.hid[kind] = { beforeMs: start.idleMs, afterMs: end.idleMs, elapsedMs: performance.now() - t };
          }
          await saveFile(fixture);
        } else if (cell.mechanism === 'sheet-settle') evidence = { ...evidence, ...await finishSaveSheet(fixture, index, await saveSheet(fixture)) };
        else if (cell.mechanism === 'menu-settle') {
          const first = await read(); evidence.menuAbsentBefore = (await observe(fixture)).menuOpen === false;
          const target = find(first.text, /menu bar item.*View/);
          await act('click', target);
          const next = await read();
          evidence.menuInNextRead = /^\t*\d+ menu(?:$| (?!bar\b))/m.test(next.text) && (await observe(fixture)).menuOpen === true;
          await act('pressKey', 'Escape'); await read();
        } else if (cell.group === 6) {
          let result, start;
          if (cell.metric === 'postInputRead') {
            await act('pressKey', cell.app === 'calculator' ? 'Escape' : 'Home'); await read();
            await act('pressKey', cell.app === 'calculator' ? '7' : 'End'); start = performance.now(); result = await read();
          }
          else if (cell.metric === 'warmClick') {
            await act('pressKey', cell.app === 'calculator' ? 'Escape' : 'super+Home'); await read();
            const tree = (await read()).text;
            const target = cell.app === 'calculator' ? find(tree, /button.*(?:Seven|7)(?:,|$)/) : before.bodyPoint;
            if (target == null) throw Error('CLICK_TARGET_UNAVAILABLE');
            start = performance.now(); result = await act('click', target);
          } else { start = performance.now(); result = cell.metric === 'acquisition' ? await driver.acquire(PROBE_APPS[cell.app].bundle) : await read(cell.metric === 'combinedRead'); }
          evidence.elapsedMs = performance.now() - start;
          evidence.correct = !!result && (cell.metric === 'warmClick' || typeof result.text === 'string' && result.text.startsWith('Window:') && !result.truncated) &&
            (cell.metric !== 'combinedRead' || typeof result.screenshot?.data === 'string');
          if (cell.metric === 'warmClick' || cell.metric === 'postInputRead') {
            if (cell.app === 'textedit') evidence.correct &&= (await observe(fixture)).caretRange?.[0] > 0;
            else {
              const next = cell.metric === 'warmClick' ? await read() : result;
              evidence.correct &&= /^\t*\d+ (?:text|text field|text entry area)(?: \([^)]*\))?(?:, Value: | )7(?:,|$)/m.test(next.text);
            }
          }
        }
        const after = await observe(fixture);
        evidence.background = before.background === true && after.background === true;
        return { ...evidence, trace: currentTrace };
      } catch (error) { error.trace = currentTrace; throw error; }
    },
    closeFixture,
    async forceClose() {
      await Promise.allSettled([...drivers.values(), ...openingClients].map(client => client.forceClose?.()));
      await Promise.allSettled([witness, processWitness].map(child => child?.forceClose?.()));
    },
    async close() {
      for (const fixture of fixtures) await closeFixture(fixture);
      for (const client of [...drivers.values(), ...openingClients]) { try { await client.close(); } catch { cleanupFault = true; } }
      try { await witness?.close(); } catch { cleanupFault = true; }
      try { await processWitness?.close(); } catch { cleanupFault = true; }
      if (!cleanupFault && fixtures.size === 0 && bank) { rmSync(bank, { recursive: true }); bank = undefined; }
      else if (bank) console.error('RT13 bank retained: ' + bank);
      return { confirmed: !cleanupFault && fixtures.size === 0 };
    },
  };
}

export function assertProbeFixtureLease(cell, lease) {
  if (cell.app === 'finder') {
    // real-fixture.js snapshots Finder's existing windows, creates one through AX,
    // retains that exact reference, and closes only that window at cleanup.
    if (lease?.bundle !== 'com.apple.finder' || lease.running !== true || lease.launched !== false ||
        lease.setupCase !== 'already-running' || !(lease.pid > 0)) throw Error('FINDER_FIXTURE_UNCONFIRMED');
  } else if (lease?.running !== false || lease.launched !== true) throw Error('APP_ALREADY_RUNNING');
}

// Separate from RT13 qualification. This adapter always uses the own driver,
// never an engine or CDP client, and owns only its temporary fixture host.
export async function createRendererProbe({ signal, driverBinary, driverSha256, check } = {}) {
  if (typeof check !== 'function') throw Error('SITTING_GUARD_REQUIRED');
  const { createMacDriverClient } = await import('../plugins/sleight/lib/mac-driver/client.mjs');
  const { macDriverBuildInfo } = await import('../plugins/sleight/lib/mac-driver/build.mjs');
  const { environment } = await import('../plugins/sleight/lib/direct-browser/host.mjs');
  const { runOwned } = await import('./preapproved-process.mjs');
  const { sourceIdentity, runtimeBuild } = await import('./runtime-arm.mjs');
  if (!/^[a-f0-9]{64}$/.test(driverSha256 ?? '') || hashHelper(driverBinary) !== driverSha256) throw Error('RENDERER_GATE_HELPER_REQUIRED');
  const identity = macDriverBuildInfo();
  const prepare = async () => {
    if (hashHelper(driverBinary) !== driverSha256) throw Error('HELPER_BINARY_CHANGED');
    return { status: 'ready', binary: driverBinary, build: identity.build, spawn: ({ nonce }) => {
      if (hashHelper(driverBinary) !== driverSha256) throw Error('HELPER_BINARY_CHANGED');
      return spawn(driverBinary, [], { env: { ...environment(), SLEIGHT_DRIVER_NONCE: nonce }, stdio: ['pipe', 'pipe', 'pipe'] });
    } };
  };
  const bank = mkdtempSync('/private/tmp/sleight-uc2c-host-');
  let host, driver, root, cleanupFault = false;
  const boundary = () => { signal?.throwIfAborted(); if (existsSync('/tmp/sleight-hold')) throw Error('HOLD'); };
  return {
    metadata: () => ({ ...sourceIdentity(ROOT), runtimeBuild: runtimeBuild(ROOT, 'own'),
      driverBuild: identity.build, driverSha256: hashHelper(driverBinary) }),
    async prepare(cell) {
      boundary(); await check();
      // Check the compile-time gate before any fixture or witness can draw.
      const client = createMacDriverClient({ prepare });
      driver = driverProbeAdapter(client, { inputAdmission: true });
      await driver.preflight();
      if ((await client.request('inputGateState', {})).enabled !== true) throw Error('RENDERER_GATE_HELPER_REQUIRED');
      boundary(); await check();
      host ??= await startWitness(bank, 'runtime-renderer-host', { runProcess: runOwned, signal });
      root = mkdtempSync('/private/tmp/sleight-uc2c-');
      boundary(); await check();
      const launched = await host.call({ op: 'renderer-launch', app: cell.app, root });
      if (launched.temporaryProfile !== true || launched.bundle !== cell.bundle) throw Error('RENDERER_FIXTURE_UNSAFE');
      await driver.acquire({ windowId: launched.windowId });
      return { driver, witness: { call: async row => {
        // A cancellation still permits the witness to finish its bounded log.
        if (row.op !== 'renderer-watch-end') { boundary(); await check(); }
        return host.call(row);
      } } };
    },
    async closeFixture() {
      let confirmed = true;
      try { await driver?.close(); driver = undefined; } catch { confirmed = false; }
      try { if (host && (await host.call({ op: 'renderer-close' })).confirmed !== true) confirmed = false; } catch { confirmed = false; }
      if (confirmed && root) { rmSync(root, { recursive: true }); root = undefined; }
      cleanupFault ||= !confirmed;
      return { confirmed };
    },
    async close() {
      await this.closeFixture();
      try { await host?.close(); } catch { cleanupFault = true; }
      if (!cleanupFault) rmSync(bank, { recursive: true });
      else console.error('UC2C fixture bank retained: ' + bank);
      return { confirmed: !cleanupFault };
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = process.argv.includes('--renderer-background')
      ? await (await import('./runtime-renderer-probe.mjs')).rendererProbeMain()
      : process.argv.includes('--helper-lifecycle') ? await helperLifecycleMain(process.argv.slice(2))
      : (process.argv.includes('--owner-away') || process.argv.includes('--owner-present-hands-off')) && process.argv.includes('--sitting')
      ? await (await import('./runtime-owner-away.mjs')).main() : await main();
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
