// SIT1 orchestration. Live dependencies load only after an explicit live command.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, lstatSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { personConfirmationResult, helperConfirm } from '../plugins/sleight/lib/person-confirm.mjs';
import { noHold, publishJSON, checkJSONOutput, sittingCommand, jsonChild, startGuard, retryDocumentBinding } from './sitting-process.mjs';

export const WITNESS = Object.freeze({ name: 'RT25 Probe Witness', bundle: 'org.sleight.bench.rt25-witness' });
export const OBSERVED_KINDS = Object.freeze(['getApp', 'click', 'double-click', 'key', 'type', 'scroll', 'drag', 'screenshot', 'read', 'combined-read', 'open-g']);
export function engineCallKind(code) {
  if (code.includes('cua.getApp(')) return 'getApp';
  if (code.includes('getAXStateAndScreenshot(')) return 'combined-read';
  if (code.includes('getScreenshot(')) return 'screenshot';
  const method = /\["([A-Za-z]+)"\]/.exec(code)?.[1];
  if (method === 'click') return /"clickCount":2/.test(code) ? 'double-click' : 'click';
  const kind = ({ pressKey: 'key', typeText: 'type', scroll: 'scroll', drag: 'drag' })[method];
  if (kind) return kind;
  if (code.includes('getAXState(')) return 'read';
  throw Error('HID_KIND_UNMEASURED');
}
export function pulseModel(operations, resets) {
  if (!Array.isArray(operations) || !Array.isArray(resets) || operations.length !== OBSERVED_KINDS.length * 3 ||
      new Set(operations.map(op => op?.label)).size !== operations.length ||
      operations.some(op => !OBSERVED_KINDS.includes(op?.kind) || typeof op.label !== 'string') ||
      resets.some(r => typeof r?.label !== 'string')) return { stable: false };
  const pulses = operations.map(op => ({ kind: op.kind, label: op.label, resets: resets.filter(r => r.label === op.label).length }));
  const perKind = Object.fromEntries(OBSERVED_KINDS.map(kind => {
    const counts = pulses.filter(p => p.kind === kind).map(p => p.resets);
    return [kind, { counts, stable: counts.length === 3 && counts.every(n => n === counts[0] && n <= 32) }];
  }));
  const stable = Object.values(perKind).every(p => p.stable) && resets.every(r => pulses.some(p => p.label === r.label));
  return { pulses, perKind, stable, resetCounts: stable ? Object.fromEntries(Object.entries(perKind).map(([k, p]) => [k, p.counts[0]])) : undefined };
}
export function observationCounts(report, metadata, now = Date.now()) {
  const evidence = report?.results?.[0]?.evidence;
  const identity = value => ({ ...value, engine: value?.engine ? { ...value.engine, at: undefined } : undefined });
  if (report?.schema !== 'sleight.owner-away-sitting/1' || report.observeOnly !== true || report.completed !== true || report.cleanupConfirmed !== true || report.stop ||
      !Number.isFinite(Date.parse(report.finishedAt)) || now - Date.parse(report.finishedAt) < 0 || now - Date.parse(report.finishedAt) > 6 * 3600000 ||
      (metadata?.source && metadata.source.sleightDirty !== false) ||
      JSON.stringify(identity(report.metadata)) !== JSON.stringify(identity(metadata)) || evidence?.stable !== true) throw Error('HID_OBSERVATION_REQUIRED');
  const model = pulseModel(evidence.operations ?? [], evidence.resets ?? []);
  if (!model.stable || JSON.stringify(model.resetCounts) !== JSON.stringify(evidence.resetCounts)) throw Error('HID_PULSE_MODEL_UNCONFIRMED');
  // A stable 0 is valid (reads and background clicks leave HID idle alone); the guard then accepts no reset for
  // that kind, so any person input during it stops the sitting (sleight-arch, 2026-11-01).
  if (OBSERVED_KINDS.some(kind => !Number.isInteger(model.resetCounts[kind]))) throw Error('HID_PULSE_MODEL_UNCONFIRMED');
  // Timing and repeatability do not identify the source of an HID reset. A
  // person's first click inside a call would consume the same count allowance.
  if (Object.values(model.resetCounts).some(count => count !== 0)) throw Error('HID_SOURCE_UNCONFIRMED');
  return model.resetCounts;
}
export function observationSummary(report) {
  const evidence = report?.results?.[0]?.evidence;
  return { source: report?.metadata?.source, perKind: evidence?.perKind,
    resetCounts: evidence?.resetCounts, sittingReady: report?.completed === true &&
      report.cleanupConfirmed === true && evidence?.stable === true &&
      OBSERVED_KINDS.every(kind => evidence.resetCounts?.[kind] === 0) };
}
export async function placeWitnessCover({ witness, guard, cover, check, wait = sleep, attempts = [] }) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    await check();
    witness.send({ op: 'order-back' });
    await wait(300);
    await check();
    const record = { token: cover.tag, attempt, waitMs: 300 }; attempts.push(record);
    try {
      await guard.call({ op: 'place-cover', pid: cover.lease.pid, token: cover.tag });
      record.ok = true; return;
    } catch (error) {
      record.code = safeCode(error);
      if (error.message !== 'COVER_OR_POINTER_UNCONFIRMED' || attempt === 4) throw error;
    }
  }
}
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const safeCode = e => /^[A-Z][A-Z0-9_]{0,79}$/.test(e?.message) ? e.message : 'SITTING_FAILED';
// This child inherits fd 0 and its process group. Its non-drawing mode checks
// /dev/tty, the foreground group and an allow-list ending at local Terminal.
export async function verifyOwnerTerminal(tool, { stdin = process.stdin, stdout = process.stdout,
  env = process.env, signal, spawnChild = spawn } = {}) {
  if (stdin.isTTY !== true || stdout.isTTY !== true ||
      ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'].some(key => env[key])) throw Error('LOCAL_OWNER_TTY_REQUIRED');
  signal?.throwIfAborted();
  const child = spawnChild(tool, ['--owner-terminal'], { stdio: ['inherit', 'pipe', 'pipe'] });
  let output = '', failed = false;
  child.stdout.on('data', bytes => { output += bytes; if (output.length > 1024) { failed = true; child.kill('SIGKILL'); } });
  child.stderr.resume(); child.once('error', () => { failed = true; });
  const abort = () => { failed = true; child.kill('SIGKILL'); };
  const timer = setTimeout(abort, 5000);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const code = await new Promise(accept => child.once('close', accept));
    signal?.throwIfAborted();
    if (failed || code !== 0 || output.trim() !== 'OWNER_TERMINAL_CONFIRMED') throw Error('LOCAL_OWNER_TTY_REQUIRED');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export async function promptHandsOff({ tools, plannedSeconds, signal }, { verify = verifyOwnerTerminal,
  stdin = process.stdin, stdout = process.stdout, makeInterface = createInterface } = {}) {
  await verify(join(tools, 'guard'), { stdin, stdout, signal });
  signal?.throwIfAborted();
  stdout.write(`Planned hands-off block: ${plannedSeconds} seconds (${plannedSeconds / 60} minutes), computed from the selected rows, plus cleanup.\n`);
  stdout.write('Stay at this Mac and keep hands off the keyboard, mouse and trackpad. Press Control-C in this Terminal to stop at any time. Type go, then keep hands off: ');
  // Use the verified fd, not a separately opened tty that could differ from stdin.
  const terminal = makeInterface({ input: stdin, output: stdout, terminal: true });
  let abort;
  try {
    const answer = await new Promise((accept, reject) => {
      const fail = () => reject(signal?.reason ?? Error('OWNER_GO_REQUIRED'));
      terminal.once('close', fail);
      terminal.once('SIGINT', () => reject(Error('OWNER_STOPPED')));
      abort = () => { fail(); terminal.close(); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else terminal.question('', accept);
    });
    signal?.throwIfAborted();
    if (answer !== 'go') throw Error('OWNER_GO_REQUIRED');
    return true;
  } finally { signal?.removeEventListener('abort', abort); terminal.close(); }
}
// Ancestry and typed go only slow automation. The system sheet proves a person
// at this Mac once, before any live resource starts; the owner then observes.
export const OWNER_PRESENT_SITTING = 'owner-present-sitting';
// Settings retain their existing unknown-presence policy. This sitting requires
// a readable, unlocked session and a finite idle clock below 120 seconds.
export async function handsOffPresence({ runScript = async (...args) =>
  (await import('../plugins/sleight/lib/launch.mjs')).runScript(...args) } = {}) {
  const state = await runScript('remote-approvals.js', { operation: 'presence' });
  if (typeof state?.locked !== 'boolean' || !Number.isFinite(state.idleSeconds) || state.idleSeconds < 0) return undefined;
  return !state.locked && state.idleSeconds < 120;
}
export async function confirmHandsOff({ signal } = {}, { confirm = helperConfirm, runScript,
  presence = () => handsOffPresence({ runScript }), presenceMs = 5000,
  notice = text => process.stdout.write(text), ...timing } = {}) {
  let timer, abort;
  const strictPresence = async () => {
    try {
      return await Promise.race([
        Promise.resolve().then(presence).then(value => value === true, () => false),
        new Promise(resolve => {
          timer = setTimeout(() => resolve(false), presenceMs);
          abort = () => resolve(false);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        }),
      ]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
  const result = await personConfirmationResult({ key: OWNER_PRESENT_SITTING }, { confirm, presence: strictPresence, signal, ...timing,
    notice: text => notice(text ?? 'Confirm with Touch ID or your password to start this hands-off input check (60 s, Cancel or Ctrl-C stops it).\n') });
  signal?.throwIfAborted();
  if (result !== 'ok') throw Error('OWNER_PERSON_CONFIRMATION_REQUIRED');
  return true;
}
// Timing is association only. The inferred input time comes from the sampled
// idle clock, not a hardware observer or a receipt from the input poster.
export function handsOffEvidence(records = [], resetFrom = 0) {
  const windows = [];
  for (const r of records) if (r.record === 'posted-action-window') {
    if (r.open) windows.push({ window: r.window, label: r.label, start: r.uptime, end: null, tailMs: r.tailMs });
    else { const w = windows.findLast(w => w.window === r.window); if (w) w.end = r.uptime; }
  }
  const resets = records.slice(resetFrom).filter(r => r.record === 'hid-reset').map(r => {
    const input = r.inferredInputUptime ?? r.uptime - r.idleMs / 1000;
    const postedActions = windows.map(w => ({ window: w.window, label: w.label,
      offsetFromStartMs: (input - w.start) * 1000,
      offsetFromEndMs: w.end === null ? null : (input - w.end) * 1000,
      insidePostedActionWindow: input >= w.start && (w.end === null || input <= w.end + w.tailMs / 1000) }));
    return { ...r, inferredInputUptime: input, postedActions,
      insidePostedActionWindow: postedActions.some(w => w.insidePostedActionWindow) };
  });
  return { ownerObserved: true, resetCount: resets.length,
    insidePostedActionWindows: resets.filter(r => r.insidePostedActionWindow).length,
    outsidePostedActionWindows: resets.filter(r => !r.insidePostedActionWindow).length,
    windows, resets, foreignWindows: records.filter(r => r.record === 'foreign-window-seen'),
    foreignWindowCounts: records.findLast(r => r.record === 'foreign-window-counts')?.windows ?? [] };
}
export function markOwnerObservedRows(value) {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value.cells) || value.cells.length > 0) value.ownerObserved = true;
  if (value.measurement) markOwnerObservedRows(value.measurement);
  for (const key of ['cells', 'results', 'trialsData', 'baselineData', 'apps', 'samples', 'trials', 'shots']) for (const row of value[key] ?? []) markOwnerObservedRows(row);
}
export function ownerAwayPlan({ measurementsOnly = false } = {}) {
  const plan = { expectedMinutes: 30, maximumMinutes: 35, qualification: false,
    probes: [[1, 'witness', 8], [6, 'read-latencies', 8], [2, 'secure-input', 3], [3, 'covered-scroll', 4], [4, 'same-titles', 2], [5, 'screenshot-format', 1],
      [8, 'coordinate-parents', 2], [9, 'space-delivery', 1], [10, 'context-menu-parents', 1]]
      .map(([id, name, minutes]) => ({ id, name, minutes })),
    skipped: [{ id: 7, reason: 'Screen lock requires the owner to unlock; owner-away mode skips it.' }],
    attended: ['Moving the witness to another Space', 'Tiling and proving a Split View witness'],
    measurements: { coordinatePointsPerApp: 25, maximumParentNodes: 66, deliveryTrials: 3, contextMenuSamples: 3 } };
  return measurementsOnly ? { ...plan, expectedMinutes: 4, maximumMinutes: 10, probes: plan.probes.filter(p => p.id >= 8) } : plan;
}
export function sessionApproval(params) {
  const app = /^Allow Computer Use to use "(.+)"\?$/.exec(params.message ?? '')?.[1];
  if (![WITNESS.name, WITNESS.bundle, 'Calculator', 'com.apple.calculator', 'TextEdit', 'com.apple.TextEdit', 'Google Chrome', 'com.google.Chrome'].includes(app)) throw Error('APPROVAL_REFUSED');
  // This is loaded at module scope through the dynamic import in live setup;
  // the synchronous policy has no persistence or Always allow path.
  const properties = params.requestedSchema?.properties;
  const field = properties && Object.keys(properties).join();
  const session = field === 'choice' ? 'session' : field === 'remember' ? 'This session' : undefined;
  const choices = properties?.[field]?.enum;
  if (!session || !Array.isArray(choices) || !choices.includes(session) || params.mode === 'url' ||
      !Array.isArray(params.requestedSchema.required ?? []) ||
      (params.requestedSchema.required ?? []).some(k => k !== field)) throw Error('APPROVAL_REFUSED');
  return { action: 'accept', content: { [field]: session } };
}

// Metadata only: image bytes stay inside the ChatGPT REPL. Also injected there.
export function sittingScreenshotSize(bytes) {
  const fail = () => { throw Error('DRAG_SCREENSHOT_UNAVAILABLE'); };
  if (!(bytes instanceof Uint8Array) || bytes.length < 24) return fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width, height;
  if (view.getUint32(0) === 0x89504e47 && view.getUint32(4) === 0x0d0a1a0a) {
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let at = 2; at + 9 < bytes.length && bytes[at] === 0xff;) {
      const marker = bytes[at + 1], length = view.getUint16(at + 2);
      if (length < 2 || at + length + 2 > bytes.length) return fail();
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        height = view.getUint16(at + 5); width = view.getUint16(at + 7); break;
      }
      at += length + 2;
    }
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
      width > 16384 || height > 16384 || width * height > 16777216) return fail();
  return [width, height];
}
export async function runOwnerAway({ backend, observeOnly = false, measurementsOnly = false, ownerPresentHandsOff = false, clock = () => performance.now() } = {}) {
  if (ownerPresentHandsOff && observeOnly) throw Error('INVALID_OPTION_COMBINATION');
  if (observeOnly && measurementsOnly) throw Error('INVALID_OPTION_COMBINATION');
  const plan = observeOnly ? { expectedMinutes: 1, maximumMinutes: 5, probes: [{ id: 0, name: 'observe-hid', seconds: 60 }], skipped: [] } : ownerAwayPlan({ measurementsOnly });
  const report = { schema: 'sleight.owner-away-sitting/1', sitting: true, qualification: false, observeOnly,
    measurementsOnly, ownerPresentHandsOff, deliveryMeasured: false, unmeasured: ['off-space', 'split-view'],
    ...plan, startedAt: new Date().toISOString(), results: [], completed: false };
  report.plannedSeconds = plan.probes.reduce((sum, row) => sum + (row.seconds ?? row.minutes * 60), 0);
  let began = clock();
  try {
    report.metadata = await backend.start();
    const admitted = ownerPresentHandsOff && report.metadata?.ownerConfirmed === true;
    if (ownerPresentHandsOff && !admitted) throw Error('OWNER_PERSON_CONFIRMATION_REQUIRED');
    if (admitted) began = clock();
    for (const probe of plan.probes) {
      if (clock() - began > plan.maximumMinutes * 60000) throw Error('DEADLINE_EXCEEDED');
      await backend.check();
      const resetFrom = backend.inputRecords?.().length ?? 0;
      const result = { id: probe.id, name: probe.name, ...(admitted && { ownerObserved: true }), startedAt: new Date().toISOString() }; report.results.push(result);
      try {
        result.evidence = await backend.probe(probe);
        if (observeOnly && result.evidence.stable !== true) throw Error('HID_PULSE_MODEL_UNCONFIRMED');
      }
      catch (e) { result.error = safeCode(e); result.evidence ??= backend.snapshot?.(); throw e; }
      finally {
        if (admitted) {
          result.inputObservation = handsOffEvidence(backend.inputRecords?.(), resetFrom);
          markOwnerObservedRows(result.evidence);
        }
        if (probe.id === 9 && result.evidence) {
          report.deliveryMeasured = result.evidence.deliveryMeasured === true;
          report.unmeasured = result.evidence.unmeasured ?? report.unmeasured;
        }
      }
      await backend.check(); result.finishedAt = new Date().toISOString();
    }
  } catch (error) { report.stop = backend.stopCode?.() ?? safeCode(error); report.inputReadiness = error.readiness ?? backend.snapshot?.().inputReadiness; }
  finally {
    try { report.cleanup = await backend.close(); report.cleanupConfirmed = report.cleanup?.confirmed === true; } catch { report.cleanupConfirmed = false; }
    report.stop = backend.stopCode?.() ?? report.stop;
    if (ownerPresentHandsOff) {
      report.inputObservation = handsOffEvidence(backend.inputRecords?.());
      delete report.inputObservation.ownerObserved;
      if (report.results.some(row => row.ownerObserved === true)) report.ownerObserved = true;
    }
    if (!report.cleanupConfirmed) report.stop ??= 'CLEANUP_UNCONFIRMED';
    report.completed = !report.stop && report.results.length === plan.probes.length;
    report.elapsedMs = clock() - began; report.finishedAt = new Date().toISOString();
  }
  return report;
}

export async function buildSittingTools(dir) {
  if (resolve(dir) !== dir) throw Error('ABSOLUTE_TOOLS_REQUIRED');
  mkdirSync(dir, { mode: 0o700 });
  const { runOwned } = await import('./preapproved-process.mjs');
  const compile = async (name, args) => {
    const result = await runOwned('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(dir, 'modules'), ...args], { timeoutMs: 180000 });
    if (result.exit?.code !== 0 || !result.groupClean) throw Error('BUILD_FAILED');
    return name;
  };
  try {
  await compile('guard', [join(ROOT, 'bench/sitting-guard.swift'), '-o', join(dir, 'guard')]);
  const app = join(dir, WITNESS.name + '.app'), contents = join(app, 'Contents');
  mkdirSync(join(contents, 'MacOS'), { recursive: true, mode: 0o700 });
  writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>witness</string><key>CFBundleName</key><string>${WITNESS.name}</string><key>CFBundleDisplayName</key><string>${WITNESS.name}</string><key>CFBundleIdentifier</key><string>${WITNESS.bundle}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`, { mode: 0o600 });
  await compile('witness', [join(ROOT, 'bench/runtime-probe-host.swift'), '-o', join(contents, 'MacOS/witness')]);
  const { buildTool } = await import('./rt31-probe.mjs');
  await buildTool(join(dir, 'rt31-probe'));
  return { guard: join(dir, 'guard'), witness: join(contents, 'MacOS/witness'), rt31: join(dir, 'rt31-probe'), drawing: false };
  } finally { rmSync(join(dir, 'modules'), { recursive: true, force: true }); }
}

export async function createOwnerAwayBackend({ tools, out, observeOnly = false, observation, includeChrome = false, ownerPresentHandsOff = false, plannedSeconds = 1800 }, dependencies = {}) {
  if (ownerPresentHandsOff && observeOnly) throw Error('INVALID_OPTION_COMBINATION');
  const probeClient = dependencies.probeClient ?? (await import('./double-keys-client.mjs')).probeClient;
  const benchmarkDecision = dependencies.benchmarkDecision ?? (await import('./approve.mjs')).benchmarkDecision;
  const openFixture = dependencies.openFixture ?? (await import('./real-fixture.mjs')).openFixture;
  const acquireLiveLock = dependencies.acquireLiveLock ?? (await import('./live-lock.mjs')).acquireLiveLock;
  const checkHold = dependencies.noHold ?? noHold;
  const makeGuard = dependencies.startGuard ?? startGuard, makeWitness = dependencies.jsonChild ?? jsonChild;
  const bank = mkdtempSync(join(dependencies.temporaryRoot ?? '/private/tmp', 'sleight-sit1-')), fixtures = [];
  let unlock, engine, engineClosing, closing, witness, guard, guardReady = false, latencies, phaseCtx, cleanup = true, stopped, selectedBundle;
  const resetCounts = {};
  let inputReadiness, ownerConfirmed = false;
  let chromeLaunchIntended = false;
  const operations = [], allWitnesses = [], bindingAttempts = [], coverAttempts = [];
  const bindingRetryOptions = { attempts: bindingAttempts, check: () => boundary(),
    now: dependencies.now, wait: dependencies.sleep };
  let measurement;
  const controller = new AbortController();
  let ownerInterrupts = 0, forcing, lockRelease, acquiringLock;
  const releaseLock = () => lockRelease ??= Promise.resolve(acquiringLock).then(() => unlock?.());
  const bounded = async operation => {
    let timer;
    try { return await Promise.race([Promise.resolve().then(operation), new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); }
    finally { clearTimeout(timer); }
  };
  const forceStop = () => forcing ??= (async () => {
    stopped = 'OWNER_FORCE_STOPPED'; cleanup = false; controller.abort(Error(stopped));
    try { witness?.send({ op: 'secure-off' }); } catch {}
    await bounded(() => Promise.allSettled([engine, latencies].map(client => client?.forceClose?.())));
    await bounded(() => Promise.allSettled([witness, guard].map(child => child?.forceClose?.())));
    try { await bounded(releaseLock); } catch { cleanup = false; }
    finally { (dependencies.forceExit ?? (code => process.exit(code)))(130); }
  })();
  const interrupt = signal => {
    if (ownerPresentHandsOff && signal === 'SIGINT' && ++ownerInterrupts > 1) { void forceStop(); return; }
    try { witness?.send({ op: 'secure-off' }); } catch { cleanup = false; }
    stopped ??= ownerPresentHandsOff && signal === 'SIGINT' ? 'OWNER_STOPPED' : 'INTERRUPTED'; controller.abort(Error(stopped)); void closeEngine().catch(() => { cleanup = false; });
  };
  const ownerInterrupt = () => interrupt('SIGINT');
  const boundary = async () => { checkHold(); if (stopped) throw Error(stopped); await guard.check(); if (stopped) throw Error(stopped); };
  const evaluate = async code => {
    await boundary();
    const op = { startedAt: new Date().toISOString(), kind: engineCallKind(code), method: /sitApp\["([A-Za-z]+)"\]/.exec(code)?.[1] ??
      (code.includes('cua.getApp(') ? 'getApp' : code.includes('getScreenshot()') ? 'getScreenshot' : 'getAXState') }; operations.push(op);
    op.label = `${op.kind}-${operations.length}`;
    // Record potential edits before dispatch, including an error or lost reply.
    if (selectedBundle === 'com.apple.TextEdit' && ['click', 'double-click', 'key', 'type', 'drag'].includes(op.kind)) await guard.call({ op: 'fixture-write' });
    let result;
    try { result = await guard.engineWindow(() => {
      if (stopped) throw Error(stopped);
      controller.signal.throwIfAborted();
      return engine.call('js', { code, title: 'Owned sitting fixture', timeout_ms: 30000 });
    }, op.label, op.kind); }
    catch (error) { throw stopped ? Error(stopped) : error; }
    op.elapsedMs = Date.now() - Date.parse(op.startedAt);
    op.engineReceipt = result.engineReceipt;
    op.warnings = (result.content ?? []).filter(c => c.type === 'text').flatMap(c => c.text.split('\n')).filter(t => !t.startsWith('SIT1JSON:') && /identity|same.title|ambig|selected window/i.test(t));
    if (result.isError) {
      op.error = 'ENGINE_CALL_FAILED';
      // Diagnostics for live sittings only: the engine's own error text, from the sitting's fixture apps.
      if (process.env.SLEIGHT_SITTING_DEBUG === '1') {
        op.errorText = (result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n').slice(0, 1200);
        op.code = code.slice(0, 400);
      }
      throw Error('ENGINE_CALL_FAILED');
    }
    await boundary();
    const line = (result.content ?? []).filter(c => c.type === 'text').flatMap(c => c.text.split('\n')).findLast(t => t.startsWith('SIT1JSON:'));
    if (!line) throw Error('ENGINE_REPLY_UNAVAILABLE');
    try { const parsed = JSON.parse(line.slice(9)); op.recorded = true; return parsed; } catch { throw Error('ENGINE_REPLY_INVALID'); }
  };
  const acquire = async (bundle, readState = true) => {
    await evaluate(`var sitApp = await cua.getApp(${JSON.stringify(bundle)}); console.log('SIT1JSON:{}');`);
    selectedBundle = bundle;
    return readState ? read() : undefined;
  };
  const action = (method, ...args) => evaluate(`await sitApp[${JSON.stringify(method)}](...${JSON.stringify(args)}); console.log('SIT1JSON:{}');`);
  const dragWitness = async () => {
    const geometry = async () => {
      await boundary();
      const at = witness.records.length;
      witness.send({ op: 'delivery-state' });
      const row = await witness.wait(r => r.record === 'callback' && r.name === 'deliveryState', 3000, at);
      const details = row?.details;
      const g = details && { windowSize: [details.dragWidth, details.dragHeight],
        from: [details.dragFromX, details.dragFromY], to: [details.dragToX, details.dragToY] };
      const pair = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
      if (details?.onActiveSpace !== true || details.visible !== true || details.miniaturized !== false ||
          !Number.isSafeInteger(details.windowNumber) || details.windowNumber <= 0 || !g ||
          !pair(g.windowSize) || g.windowSize.some(n => n <= 0) || !pair(g.from) || !pair(g.to) ||
          [g.from, g.to].some(point => point.some((n, axis) => n <= 0 || n >= g.windowSize[axis]))) throw Error('DRAG_GEOMETRY_UNAVAILABLE');
      return { windowNumber: details.windowNumber, ...g };
    };
    const before = await geometry();
    const shot = await evaluate(`var sitDragShot = await sitApp.getAXStateAndScreenshot({emit:false,disableDiffing:true}); console.log('SIT1JSON:'+JSON.stringify({pixels:(${sittingScreenshotSize.toString()})(sitDragShot.screenshot)}));`);
    const after = await geometry();
    // DRAG_GEOMETRY_CHANGED also covers invalid screenshot dimensions.
    if (JSON.stringify(before) !== JSON.stringify(after) || !Array.isArray(shot.pixels) || shot.pixels.length !== 2 ||
        shot.pixels.some(n => !Number.isSafeInteger(n) || n <= 0 || n > 16384)) throw Error('DRAG_GEOMETRY_CHANGED');
    const scale = shot.pixels.map((n, i) => n / after.windowSize[i]);
    if (scale.some(n => n < 0.25 || n > 4) || Math.abs(scale[0] / scale[1] - 1) > 0.03) throw Error('DRAG_GEOMETRY_SCALE');
    const point = value => value.map((n, i) => n * scale[i]);
    await action('drag', point(after.from), point(after.to));
  };
  const read = () => evaluate(`console.log('SIT1JSON:'+JSON.stringify({text:await sitApp.getAXState({emit:false,disableDiffing:true})}));`);
  const closeEngine = async () => { if (engine) await (engineClosing ??= engine.close()); };
  const guardedOpen = async (command, args, options) => {
    await boundary();
    if (command !== '/usr/bin/open' || !args.includes('-g')) throw Error('BACKGROUND_LAUNCH_REQUIRED');
    const name = args[args.indexOf('-a') + 1];
    const bundle = args.includes('-b') ? args[args.indexOf('-b') + 1] : ({ TextEdit: 'com.apple.TextEdit', Calculator: 'com.apple.calculator' })[name];
    if (!['com.apple.TextEdit', 'com.apple.calculator', 'com.google.Chrome'].includes(bundle)) throw Error('FIXTURE_IDENTITY');
    await guard.call({ op: 'expect-app', bundle });
    if (bundle === 'com.google.Chrome') chromeLaunchIntended = true;
    const op = { kind: 'open-g', label: `open-g-${operations.length + 1}` }; operations.push(op);
    return guard.engineWindow(() => {
      if (stopped) throw Error(stopped);
      controller.signal.throwIfAborted();
      return (dependencies.open ?? promisify(execFile))(command, args, { ...options, signal: controller.signal });
    }, op.label, op.kind);
  };
  const quitFixtures = async (contexts, bundles) => {
    // Collect retained AX helper processes before native quit. Stop/hold never
    // cancels this cleanup path, and it never uses the helper's activate fallback.
    let failure;
    // A stopped relay must finish collection before a clean-state read can
    // authorize quit. A late in-flight key must not dirty a checked document.
    if (stopped) try { await closeEngine(); } catch (e) { failure ??= e; }
    for (const ctx of contexts) for (const lease of ctx.windowLeases ?? []) {
      try { if (!await lease.dispose()) throw Error('FIXTURE_HELPER_UNCOLLECTED'); } catch (e) { failure ??= e; }
    }
    if (failure) throw failure;
    let state;
    try { state = await guard.quitFixtures(bundles); } catch (e) { failure ??= e; }
    if (failure) throw failure;
    return state;
  };
  const startEngine = async () => {
    if (stopped) throw Error(stopped);
    engineClosing = undefined;
    engine = await probeClient({ command: join(ROOT, 'plugins/sleight/bin/sleight-mcp'), args: [], env: { ...process.env,
      SLEIGHT_RUNTIME: 'engine', SLEIGHT_HAND: '0', SLEIGHT_CURSOR: '0', SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_REMOTE_APPROVALS: '0', BENCH_SUITE: 'real' } },
    { relay: false, signal: controller.signal, detached: ownerPresentHandsOff, onClient: client => { engine = client; }, record: () => {}, approve: params => {
      const answer = sessionApproval(params);
      const decision = benchmarkDecision({ mcp_server_name: 'plugin:sleight:computer', message: params.message, requested_schema: params.requestedSchema, mode: params.mode }, { BENCH_SUITE: 'real' });
      if (decision?.hookSpecificOutput?.action !== 'accept' ||
          JSON.stringify(decision.hookSpecificOutput.content) !== JSON.stringify(answer.content)) throw Error('APPROVAL_REFUSED');
      return answer;
    } });
  };
  async function document(tag, name = tag + '.txt', text = tag + '\n' + 'owned sitting line\n'.repeat(150)) {
    await boundary();
    const dir = join(bank, tag); mkdirSync(dir, { mode: 0o700 });
    const path = join(dir, name); writeFileSync(path, text, { mode: 0o600 });
    await guard.call({ op: 'expect-document', target: path });
    if (!phaseCtx) { phaseCtx = { dir: bank, nonce: 'SIT1-fixtures', ownerAway: false, fixtureRoot: bank }; fixtures.push(phaseCtx); }
    const ctx = phaseCtx;
    const lease = await openFixture(ctx, { app: 'TextEdit', bundle: 'com.apple.TextEdit', target: path, token: tag, mode: 'document', stopOnLiveHold: true }, { open: guardedOpen });
    await retryDocumentBinding(() => guard.call({ op: 'bind-document' }), bindingRetryOptions);
    await boundary();
    return { path, ctx, lease, tag };
  }
  async function closeDocs() {
    if (fixtures.length) await quitFixtures(fixtures, ['com.apple.TextEdit', 'com.apple.calculator']);
    fixtures.length = 0; phaseCtx = undefined;
  }
  async function coverWitness(tag, readState = true) {
    const cover = await document(tag);
    await placeWitnessCover({ witness, guard, cover, check: boundary, wait: dependencies.sleep ?? sleep, attempts: coverAttempts });
    await acquire(WITNESS.bundle, readState);
    const pointer = await guard.call({ op: 'check' });
    if (pointer.pointerUnchanged !== true) throw Error('POINTER_CHANGED');
    return cover;
  }
  async function closeWitness() {
    if (!witness) return;
    await guard.quitFixtures([WITNESS.bundle]);
    await witness.close(); witness = undefined;
  }
  async function startWitness() {
    if (witness) return;
    const tool = join(tools, WITNESS.name + '.app/Contents/MacOS/witness');
    await guard.call({ op: 'expect-app', bundle: WITNESS.bundle });
    witness = makeWitness(tool, ['--witness-events', '--max-seconds', '1800'], { detached: ownerPresentHandsOff });
    allWitnesses.push(witness);
    await witness.wait(r => r.record === 'callback' && r.name === 'fixtureReady', 10000, 0);
    witness.send({ op: 'start' });
    await witness.wait(r => r.record === 'state', 5000, 0);
  }
  function evidence(from) { return witness.records.slice(from); }
  return {
    inputRecords: () => guard?.records ?? [], stopCode: () => stopped,
    snapshot: () => ({ inputReadiness, bindingAttempts, coverAttempts, operations, measurement, witness: witness?.records, guard: guard?.records.at(-1) }),
    async start() {
      checkHold();
      if ((dependencies.platform ?? process.platform) !== 'darwin' || !(dependencies.env ?? process.env).CLAUDE_CONFIG_DIR) throw Error('ISOLATED_MAC_HOST_REQUIRED');
      for (const path of [join(tools, 'guard'), join(tools, WITNESS.name + '.app/Contents/MacOS/witness')]) {
        if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw Error('TOOL_UNSAFE');
      }
      if (ownerPresentHandsOff) {
        process.on('SIGINT', ownerInterrupt); process.on('SIGTERM', interrupt); process.on('SIGHUP', interrupt);
        try {
          const typedGo = await (dependencies.promptHandsOff ?? promptHandsOff)({ tools, plannedSeconds, signal: controller.signal });
          if (typedGo !== true) throw Error('OWNER_GO_REQUIRED');
          checkHold();
          ownerConfirmed = await (dependencies.confirmHandsOff ?? confirmHandsOff)({ signal: controller.signal });
          if (ownerConfirmed !== true) throw Error('OWNER_PERSON_CONFIRMATION_REQUIRED');
          checkHold();
          controller.signal.throwIfAborted();
        } catch (error) { if (error.message === 'OWNER_STOPPED' && !stopped) ownerInterrupt(); throw stopped ? Error(stopped) : error; }
      }
      const metadata = dependencies.metadata ?? (async () => {
        const { readEngine } = await import('./engine-version.mjs');
        const { sourceIdentity } = await import('./runtime-arm.mjs');
        const { release, arch } = await import('node:os');
        return { engine: readEngine(), source: sourceIdentity(), macOSKernel: release(), architecture: arch() };
      });
      const identity = await metadata();
      (dependencies.printSource ?? (source => console.error(JSON.stringify({ source }))))(identity.source);
      if (identity.source && identity.source.sleightDirty !== false) throw Error('CLEAN_SOURCE_REQUIRED');
      guard = makeGuard(join(tools, 'guard'), { kind: 'runtime', observeOnly, ownerPresentHandsOff, ownerConfirmed, resetCounts, exemptSystemOverlay: true, onStop: code => {
        // Release secure input before waiting for relay shutdown or cleanup.
        try { witness?.send({ op: 'secure-off' }); } catch { cleanup = false; }
        stopped ??= code; controller.abort(Error(code)); void closeEngine().catch(() => { cleanup = false; });
      } });
      inputReadiness = await guard.readiness();
      // The current observation recipe suppresses the HID stop. No independently
      // qualified hardware protection exists in this runner, so it cannot run away.
      if (observeOnly) throw Object.assign(Error('HID_SOURCE_UNCONFIRMED'), { readiness: inputReadiness });
      if (!observeOnly && !ownerPresentHandsOff) {
        const readObservation = dependencies.readObservation ?? (path => {
          const s = lstatSync(path);
          if (!s.isFile() || s.isSymbolicLink() || s.size > 64 * 1024 * 1024) throw Error('HID_OBSERVATION_REQUIRED');
          return JSON.parse(readFileSync(path, 'utf8'));
        });
        Object.assign(resetCounts, observationCounts(await readObservation(observation), identity));
      }
      if (stopped) throw Error(stopped);
      acquiringLock = Promise.resolve().then(() => acquireLiveLock()).then(release => { unlock = release; });
      await acquiringLock;
      if (!ownerPresentHandsOff) { process.on('SIGINT', ownerInterrupt); process.on('SIGTERM', interrupt); process.on('SIGHUP', interrupt); }
      if (stopped) throw Error(stopped);
      await guard.start(); guardReady = true; await boundary();
      await startEngine();
      if (stopped) { await closeEngine(); throw Error(stopped); }
      return { ...identity, inputReadiness, ...(ownerPresentHandsOff && { ownerConfirmed: true }) };
    }, check: boundary,
    async probe(probe) {
      if (probe.id === 0) {
        const now = dependencies.now ?? (() => performance.now()), wait = dependencies.sleep ?? sleep;
        const began = now();
        await startWitness();
        for (let round = 0; round < 3; round++) {
          await coverWitness(`SIT1-observe-${round}`, false);
          await action('click', { id: 'plain' });
          await action('typeText', 'SIT1-observe');
          await action('click', { id: 'probe-button' }, { clickCount: 2 });
          await action('pressKey', 'super+s');
          await action('scroll', { id: 'scroll' }, 'down', 1);
          await dragWitness();
          await evaluate("var shot = await sitApp.getScreenshot(); console.log('SIT1JSON:{}');");
          await read();
          await closeDocs();
        }
        while (now() - began < 60000) { await wait(Math.min(250, 60000 - (now() - began))); await boundary(); }
        const resets = guard.records.filter(r => r.record === 'hid-reset');
        return { observationMs: now() - began, engineCalls: operations.filter(op => op.kind !== 'open-g').length, operations, resets,
          ...pulseModel(operations, resets), bindingAttempts, witness: [...witness.records] };
      }
      if (probe.id === 6) {
        await closeDocs(); await closeWitness();
        await closeEngine(); engine = undefined;
        const createLiveProbe = dependencies.createLiveProbe ?? (await import('./runtime-probe-live.mjs')).createLiveProbe;
        const runProbePlan = dependencies.runProbePlan ?? (await import('./runtime-probe.mjs')).runProbePlan;
        latencies = await createLiveProbe({ runtime: 'own', sitting: true, signal: controller.signal, sittingGuard: {
          ownerPresentHandsOff, check: boundary, bindingAttempts, bindingRetryOptions,
          engineWindow: (fn, label, callKind) => guard.engineWindow(() => {
            if (stopped) throw Error(stopped);
            controller.signal.throwIfAborted();
            return fn();
          }, label, callKind), fixtureOptions: { open: guardedOpen },
          beforeOpen: request => request.bundle === 'com.apple.TextEdit' ? guard.call({ op: 'expect-document', target: request.target }) : undefined,
          afterOpen: request => request.bundle === 'com.apple.TextEdit' ? guard.call({ op: 'bind-document' }) : undefined,
          closeFixtures: ctx => quitFixtures([ctx], ['com.apple.TextEdit', 'com.apple.calculator']),
        } });
        const publishObserved = async () => {
          const write = dependencies.writeRuntimeReport ?? (await import('./runtime-arm.mjs')).writeRuntimeReport;
          return (stem, report, markdown) => {
            markOwnerObservedRows(report);
            report.inputObservation = handsOffEvidence(guard.records);
            if (!report.ownerObserved) delete report.inputObservation.ownerObserved;
            write(stem, report, markdown + `\nOwner-observed hands-off block. HID resets recorded: ${report.inputObservation.resetCount}. See JSON for each reset's posted-action timing.\n`);
          };
        };
        const r = await runProbePlan({ sitting: true, ownerAway: true, out: out + '-latency', signal: controller.signal }, {
          backend: latencies, takeLock: async () => async () => {}, held: () => !!stopped,
          ...(ownerPresentHandsOff && { publish: await publishObserved() }),
        });
        if (ownerPresentHandsOff) markOwnerObservedRows(r);
        if (stopped) throw Error(stopped);
        if (!r.cleanupConfirmed) cleanup = false;
        latencies = undefined;
        if (r.stop || !r.cleanupConfirmed) throw Error(r.stop ?? 'CLEANUP_UNCONFIRMED');
        await startEngine();
        return r;
      }
      await startWitness(); const from = witness.records.length;
      if (probe.id === 8) {
        const { sampleCoordinateParents } = await import('./runtime-probe-live.mjs');
        measurement = { apps: [], skipped: [
          ...['com.apple.Safari', 'com.microsoft.VSCode'].map(bundle => ({ bundle, sampled: 0, refusalRate: null,
            reason: 'OWNED_ISOLATED_FIXTURE_REQUIRED' })),
          { bundle: 'com.apple.iWork.Numbers', sampled: 0, refusalRate: null, reason: 'NOT_ON_REAL_SUITE_ALLOWLIST' },
        ] };
        await document('SIT1-parent-samples');
        await openFixture(phaseCtx, { app: 'Calculator', bundle: 'com.apple.calculator', target: '', token: 'SIT1-parent-calc', mode: 'inherit', stopOnLiveHold: true }, { open: guardedOpen });
        for (const bundle of ['com.apple.TextEdit', 'com.apple.calculator', WITNESS.bundle]) {
          await acquire(bundle, false);
          const app = { bundle, samples: [] }; measurement.apps.push(app);
          await sampleCoordinateParents({ bundle, check: boundary, sample: row => guard.call(row), evidence: app });
        }
        const chrome = includeChrome === true ? await guard.call({ op: 'optional-chrome' }) :
          { available: false, reason: 'PROMPT_FREE_LAUNCH_UNVERIFIED' };
        if (chrome.available === true) {
          // A fresh profile and process only. A running browser is never acquired.
          const profile = join(bank, 'chrome-profile'); mkdirSync(profile, { mode: 0o700 });
          const page = join(bank, 'SIT1-chrome.html');
          writeFileSync(page, '<!doctype html><title>SIT1-coordinate</title><button>Owned button</button><canvas width="200" height="200"></canvas>', { mode: 0o600 });
          await guardedOpen('/usr/bin/open', ['-g', '-n', '-b', 'com.google.Chrome', '--args',
            '--user-data-dir=' + profile, '--use-mock-keychain', '--password-store=basic', '--disable-sync',
            '--disable-background-networking', '--no-first-run', '--no-default-browser-check', 'file://' + page], {});
          let ready = false;
          for (let tick = 0; tick < 100 && !ready; tick++) {
            await boundary(); ready = (await guard.call({ op: 'chrome-fixture-ready' })).ready === true;
            if (!ready) await (dependencies.sleep ?? sleep)(50);
          }
          if (!ready) throw Error('FIXTURE_IDENTITY');
          await acquire('com.google.Chrome', false);
          const app = { bundle: 'com.google.Chrome', samples: [] }; measurement.apps.push(app);
          await sampleCoordinateParents({ bundle: app.bundle, check: boundary, sample: row => guard.call(row), evidence: app });
          await quitFixtures([], ['com.google.Chrome']);
          chromeLaunchIntended = false;
        } else {
          measurement.skipped.push({ bundle: 'com.google.Chrome', sampled: 0, refusalRate: null,
            reason: ['APP_ALREADY_RUNNING', 'APP_NOT_INSTALLED', 'PROMPT_FREE_LAUNCH_UNVERIFIED'].includes(chrome.reason) ? chrome.reason : 'OWNED_ISOLATED_FIXTURE_REQUIRED' });
        }
        await closeDocs(); return measurement;
      }
      if (probe.id === 9) {
        const { measureEngineDelivery } = await import('./runtime-probe-live.mjs');
        measurement = { trials: [] };
        await acquire(WITNESS.bundle, false);
        return measureEngineDelivery({ engineOnly: true, action, check: boundary, records: () => witness.records,
          evidence: measurement, state: async () => {
            await boundary(); const at = witness.records.length; witness.send({ op: 'delivery-state' });
            const row = await witness.wait(r => r.record === 'callback' && r.name === 'deliveryState', 3000, at);
            await boundary(); return row.details;
          } });
      }
      if (probe.id === 10) {
        measurement = { samples: [], requested: 3, inputCalls: 0 };
        await acquire(WITNESS.bundle, false);
        await boundary(); await guard.call({ op: 'expect-context-menu', bundle: WITNESS.bundle });
        const at = witness.records.length; witness.send({ op: 'context-menu-open' });
        const ready = await witness.wait(r => r.record === 'callback' && ['contextMenuReady', 'contextMenuClosed'].includes(r.name), 3000, at);
        if (ready.name === 'contextMenuClosed') {
          return Object.assign(measurement, { sampled: 0, refusals: 0, refusalRate: null, status: 'skipped', reason: 'BACKGROUND_MENU_UNAVAILABLE' });
        }
        for (let index = 0; index < 3; index++) {
          await boundary();
          const row = await guard.call({ op: 'context-menu-parent', bundle: WITNESS.bundle });
          if (typeof row.sample?.refused !== 'boolean' || !Array.isArray(row.sample.roles) ||
              row.sample.roles.some(role => typeof role !== 'string') || !Number.isSafeInteger(row.sample.nodes) ||
              row.sample.nodes < 0 || row.sample.nodes > 66) throw Error('PARENT_SAMPLE_INVALID');
          const roles = row.sample.roles, menu = roles.indexOf('AXMenu');
          measurement.samples.push({ ...row.sample, menuParentRole: menu >= 0 ? roles[menu + 1] ?? null : null,
            menuReachesApplication: menu >= 0 && row.sample.terminal === 'AXApplication' });
          const refusals = measurement.samples.filter(r => !r.menuReachesApplication).length;
          Object.assign(measurement, { sampled: measurement.samples.length, refusals,
            refusalRate: refusals / measurement.samples.length, menuToApplication: measurement.samples.length - refusals });
          await boundary();
        }
        await witness.wait(r => r.record === 'callback' && r.name === 'contextMenuClosed', 3000, at);
        await boundary();
        const refusals = measurement.samples.filter(r => !r.menuReachesApplication).length;
        return Object.assign(measurement, { sampled: 3, refusals, refusalRate: refusals / 3,
          menuToApplication: 3 - refusals, witness: evidence(from) });
      }
      if (probe.id === 1) {
        await acquire(WITNESS.bundle); const beforeAction = evidence(from);
        for (let i = 0; i < 3; i++) await action('click', { id: 'probe-button' });
        for (let i = 0; i < 3; i++) await action('click', { id: 'probe-button' }, { clickCount: 2 });
        for (let i = 0; i < 3; i++) await action('pressKey', 'super+s');
        await action('click', { id: 'plain' });
        for (let i = 0; i < 3; i++) await action('typeText', 'SIT1-token');
        await coverWitness('SIT1-drag-cover');
        for (let i = 0; i < 3; i++) await dragWitness();
        const log = evidence(from); await closeDocs();
        return { beforeFirstAction: beforeAction, witness: log, counts: {
          singleClicks: 3, doubleClicks: 3, chords: 3, textCalls: 3, drags: 3, fieldSetupClicks: 1,
          saves: log.filter(r => r.record === 'callback' && r.name === 'save').length,
          drops: log.filter(r => r.record === 'callback' && r.name === 'drop' && r.details.accepted === true).length,
        } };
      }
      if (probe.id === 2) {
        const fixture = await document('SIT1-secure'); await acquire('com.apple.TextEdit');
        const at = witness.records.length; witness.send({ op: 'secure-on' });
        await witness.wait(r => r.record === 'state' && r.secureInput === true && r.secureFieldFocused === true && r.secureInputPID === witness.child.pid, 3000, at);
        try {
          for (let i = 0; i < 3; i++) await action('typeText', 'SIT1-dummy');
          for (let i = 0; i < 2; i++) await action('pressKey', 'super+s');
          return { textRead: await read(), fileBytes: Buffer.byteLength(readFileSync(fixture.path)), witness: evidence(from) };
        } finally {
          const n = witness.records.length; witness.send({ op: 'secure-off' });
          await witness.wait(r => r.record === 'state' && r.secureInput === false, 3000, n); await closeDocs();
        }
      }
      if (probe.id === 3) {
        const cover = await coverWitness('SIT1-scroll-cover');
        const coverBefore = await guard.call({ op: 'cover-state', pid: cover.lease.pid, token: cover.tag });
        const covers = [];
        for (let i = 0; i < 3; i++) {
          await action('scroll', { id: 'scroll' }, 'down', 1);
          const state = await guard.call({ op: 'cover-state', pid: cover.lease.pid, token: cover.tag }); covers.push(state);
          if (JSON.stringify(state.values) !== JSON.stringify(coverBefore.values)) throw Error('COVER_MOVED');
        }
        const log = evidence(from); await closeDocs(); return { coverBefore, covers, witness: log };
      }
      if (probe.id === 4) {
        await document('SIT1-twin-a', 'SIT1-twin.txt'); await document('SIT1-twin-b', 'SIT1-twin.txt');
        const firstRead = await acquire('com.apple.TextEdit');
        const target = /^\s*(\d+) text entry area\b/m.exec(firstRead.text)?.[1];
        if (!target) throw Error('CLICK_TARGET_UNAVAILABLE');
        await action('click', Number(target)); const secondRead = await read(); await closeDocs();
        return { firstRead, secondRead, operations: [...operations] };
      }
      if (probe.id === 5) {
        await document('SIT1-format');
        const shots = [];
        for (const bundle of ['com.apple.TextEdit', 'com.apple.calculator']) {
          if (bundle.endsWith('calculator')) {
            const ctx = phaseCtx;
            await openFixture(ctx, { app: 'Calculator', bundle, target: '', token: 'SIT1-calc', mode: 'inherit', stopOnLiveHold: true }, { open: guardedOpen });
          }
          await acquire(bundle);
          const shot = await evaluate("var shot = await sitApp.getScreenshot(); console.log('SIT1JSON:'+JSON.stringify(shot));");
          const imageSize = dependencies.imageSize ?? (await import('../plugins/sleight/lib/relay.mjs')).imageSize;
          const dimensions = imageSize(shot.data);
          if (!dimensions || !['image/png', 'image/jpeg'].includes(shot.mimeType)) throw Error('SCREENSHOT_FORMAT_UNAVAILABLE');
          const facts = await guard.call({ op: 'fixture-frame', bundle });
          shots.push({ bundle, mimeType: shot.mimeType, bytes: Buffer.from(shot.data, 'base64').length, pixels: dimensions, windowPoints: facts.size });
        }
        await closeDocs(); return { shots };
      }
      throw Error('INVALID_PROBE');
    },
    close() { return closing ??= (async () => {
      // After any stop, only owned fixture cleanup continues. Engine input ends.
      try { if (latencies) { const r = await latencies.close(); cleanup &&= r.confirmed === true; } } catch { cleanup = false; }
      try { await closeDocs(); } catch { cleanup = false; }
      let desktop;
      if (guardReady) try {
        desktop = await quitFixtures(fixtures, ['com.apple.TextEdit', 'com.apple.calculator', WITNESS.bundle,
          ...(chromeLaunchIntended ? ['com.google.Chrome'] : [])]);
      } catch { cleanup = false; }
      try { await closeEngine(); } catch { cleanup = false; }
      for (const child of [witness, guard]) try { await child?.close(); } catch { cleanup = false; }
      let lockReleased = !unlock, lockError;
      if (unlock) try { await releaseLock(); lockReleased = true; } catch { cleanup = false; lockError = 'LIVE_LOCK_RELEASE_FAILED'; }
      process.off('SIGINT', ownerInterrupt); process.off('SIGTERM', interrupt); process.off('SIGHUP', interrupt);
      return { confirmed: cleanup, bankRetained: bank, lockReleased, ...(lockError && { lockError }), coverAttempts,
        desktop, witnesses: allWitnesses.map(w => w.records.filter(r => r.record === 'summary')),
        guard: guard?.records.filter(r => r.record === 'guard').at(-1), guardRecords: guard?.records, bindingAttempts, operations };
    })(); },
  };
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const options = {}, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const k = args[i]; if (seen.has(k)) throw Error('DUPLICATE_OPTION'); seen.add(k);
    if (['--owner-away', '--owner-present-hands-off', '--sitting', '--dry-run', '--build-only', '--observe-only', '--measurements-only', '--include-chrome'].includes(k)) options[k.slice(2)] = true;
    else if (['--tools', '--out', '--observation'].includes(k) && args[i + 1] && !args[i + 1].startsWith('--')) options[k.slice(2)] = args[++i];
    else throw Error('INVALID_OPTION');
  }
  const ownerPresentHandsOff = options['owner-present-hands-off'] === true;
  if (ownerPresentHandsOff && (options['owner-away'] || options['observe-only'] || options.observation || options['build-only'])) throw Error('INVALID_OPTION_COMBINATION');
  if (options['observe-only'] && options['measurements-only']) throw Error('INVALID_OPTION_COMBINATION');
  if (options['observe-only'] && options['include-chrome']) {
    console.error('--include-chrome cannot be used with --observe-only');
    throw Error('INVALID_OPTION_COMBINATION');
  }
  if (options['build-only']) { noHold(); console.log(JSON.stringify(await buildSittingTools(options.tools))); return 0; }
  if (!(options['owner-away'] || ownerPresentHandsOff) || !options.sitting) throw Error('OWNER_AWAY_SITTING_REQUIRED');
  const command = sittingCommand('bench/runtime-probe-live.mjs', args);
  const measurementsOnly = options['measurements-only'] === true;
  const includeChrome = options['include-chrome'] === true;
  const plan = ownerAwayPlan({ measurementsOnly });
  const plannedSeconds = options['observe-only'] ? 60 : plan.probes.reduce((sum, row) => sum + row.minutes * 60, 0);
  if (options['dry-run']) { console.log(JSON.stringify({ dryRun: true, measurementsOnly, includeChrome, ownerPresentHandsOff, plannedSeconds, ...(options['observe-only'] ? { observeOnly: true, seconds: 60, rounds: 3, callKinds: OBSERVED_KINDS, engineCalls: 30, launches: 3, blocked: 'HID_SOURCE_UNCONFIRMED', independentHardwareProtectionRequired: true, admittedEngineCalls: 0, admittedLaunches: 0 } : { ...plan, observationRequired: !ownerPresentHandsOff, ...(ownerPresentHandsOff && { ownerTypedGoRequired: true, localTerminalRequired: true, personConfirmationRequired: true }) }), command }, null, 2)); return 0; }
  if (!options.tools || !options.out) throw Error('TOOLS_AND_OUTPUT_REQUIRED');
  if (!options['observe-only'] && !ownerPresentHandsOff && !options.observation) throw Error('HID_OBSERVATION_REQUIRED');
  checkJSONOutput(options.out); checkJSONOutput(options.out + '-latency.json'); checkJSONOutput(options.out + '-latency.md');
  console.error(command + (options['observe-only'] ? '\nObservation duration: at least 60 seconds; guard limit: 5 minutes, plus cleanup.' : `\nPlanned allocation: ${plan.expectedMinutes} minutes; hard limit: ${plan.maximumMinutes} minutes.`));
  const report = await runOwnerAway({ backend: await createOwnerAwayBackend({ ...options, ownerPresentHandsOff, plannedSeconds, observeOnly: options['observe-only'], includeChrome: options['include-chrome'] }, dependencies), ownerPresentHandsOff, observeOnly: options['observe-only'], measurementsOnly });
  publishJSON(options.out, report);
  if (ownerPresentHandsOff) console.log(JSON.stringify({ result: report.stop ?? 'COMPLETED', ownerObserved: report.ownerObserved === true, plannedSeconds, hidResets: report.inputObservation.resetCount, insidePostedActionWindows: report.inputObservation.insidePostedActionWindows, outsidePostedActionWindows: report.inputObservation.outsidePostedActionWindows }));
  if (options['observe-only']) console.log(JSON.stringify(observationSummary(report)));
  return report.completed ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(code => { process.exitCode = code; }).catch(e => { console.error(safeCode(e)); process.exitCode = 1; });
