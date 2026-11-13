// Offline UC3F projection. Importing never starts a child or reads a desktop.
// sleight.uc3f-transport/1: file-request
import { constants, lstatSync, openSync, fstatSync, readSync, closeSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname, basename, resolve, win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { UC3F_ROWS, evaluateSafetyEvidence } from './driver-sitting.mjs';
import { RAW_SCHEMA, parseGuestLines, assertObserverProof, checkBank, casePresence, costSamples, validateTypingTarget } from './uc3f-collect.mjs';
import { ROOT, isMain, runChild } from './kit.mjs';

export const EVIDENCE_SCHEMA = 'sleight.windows-uc3f-evidence/1';
export const ATTESTATION_SCHEMA = 'sleight.windows-uc3f-attestation/1';
export const ATTESTATION_NOTICE = 'Attestation is not authentication. A same-user process can regenerate the bundle and sidecar.';
const fail = (code = 'UC3F_EVIDENCE_INVALID', field) => { throw Object.assign(Error(code), { code, ...(field && { field }) }); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => object(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const uint = x => Number.isSafeInteger(x) && x >= 0;
const hash = x => createHash('sha256').update(x).digest('hex');
const sha = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const revisionOK = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const utc = x => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) &&
  Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;

// Bounded descriptor reads bind the bytes hashed to the bytes parsed. No link or
// oversized file is followed, including on Windows where O_NOFOLLOW is absent.
export function readBounded(path, limit = 1024 * 1024) {
  const initial = lstatSync(path);
  if (!initial.isFile() || initial.isSymbolicLink()) fail();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== initial.dev || stat.ino !== initial.ino || stat.size > limit) fail();
    const bytes = Buffer.alloc(limit + 1);
    let size = 0, n;
    while (size < bytes.length && (n = readSync(fd, bytes, size, bytes.length - size, size)) > 0) size += n;
    if (size > limit) fail();
    return bytes.subarray(0, size);
  } finally { closeSync(fd); }
}

function contextOK(c) {
  const vm = c?.vm;
  return exact(c, ['revision', 'kitManifestSha256', 'exporterSha256', 'observerSha256', 'vm', 'userSidSha256']) &&
    revisionOK(c.revision) && ['kitManifestSha256', 'exporterSha256', 'observerSha256', 'userSidSha256'].every(k => sha(c[k])) &&
    exact(vm, ['vmId', 'manufacturer', 'model', 'build', 'hostnameSha256', 'machineGuidSha256']) &&
    typeof vm.vmId === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(vm.vmId) && vm.manufacturer === 'QEMU' &&
    typeof vm.model === 'string' && /^[A-Za-z0-9 ._-]{1,80}$/.test(vm.model) && uint(vm.build) && vm.build >= 22000 &&
    sha(vm.hostnameSha256) && sha(vm.machineGuidSha256);
}

export function createAttestation(bundleBytes, context, exportedUtc = new Date().toISOString()) {
  if (!contextOK(context) || !utc(exportedUtc)) fail();
  const bundle = JSON.parse(bundleBytes.toString('utf8'));
  if (bundle.revision !== context.revision) fail();
  return { schema: ATTESTATION_SCHEMA, bundleSha256: hash(bundleBytes), ...structuredClone(context), exportedUtc,
    notice: ATTESTATION_NOTICE };
}

export function verifyAttestation(bundleBytes, attestation, expected) {
  if (!contextOK(expected) || !exact(attestation, ['schema', 'bundleSha256', ...Object.keys(expected), 'exportedUtc', 'notice']) ||
      attestation.schema !== ATTESTATION_SCHEMA || attestation.notice !== ATTESTATION_NOTICE || !utc(attestation.exportedUtc) ||
      attestation.bundleSha256 !== hash(bundleBytes) ||
      Object.keys(expected).some(k => !isDeepStrictEqual(attestation[k], expected[k]))) fail();
  const bundle = JSON.parse(bundleBytes.toString('utf8'));
  if (!exact(bundle, ['schema', 'revision', 'rows']) || bundle.schema !== EVIDENCE_SCHEMA || bundle.revision !== expected.revision ||
      !Array.isArray(bundle.rows) || bundle.rows.length > UC3F_ROWS.length || new Set(bundle.rows.map(r => r?.id)).size !== bundle.rows.length ||
      bundle.rows.some(r => !exact(r, ['id', 'evidence']) || !UC3F_ROWS.some(rule => rule.id === r.id))) fail();
  return new Map(bundle.rows.map(r => [r.id, r.evidence]));
}

export async function loadAttestationContext({ revision, bank, root = ROOT, execute = runChild, env = process.env }) {
  if (!revisionOK(revision)) fail();
  const manifestBytes = readBounded(join(root, 'guest-manifest.json'), 4 * 1024 * 1024);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schema !== 'sleight.windows-guest-kit/1' || manifest.commit !== revision || !Array.isArray(manifest.files)) fail();
  const fileHash = path => {
    const entries = manifest.files.filter(f => f.path === path), bytes = readBounded(join(root, path));
    if (entries.length !== 1 || entries[0].sha256 !== hash(bytes) || entries[0].bytes !== bytes.length) fail();
    return hash(bytes);
  };
  const exporterSha256 = fileHash('bench/windows/uc3f-export.mjs'), observerSha256 = fileHash('bench/windows/uc3f-observer.ps1');
  const identity = JSON.parse(readBounded(join(bank, 'vm-identity.json'), 16384));
  const vm = Object.fromEntries(['vmId', 'manufacturer', 'model', 'build', 'hostnameSha256', 'machineGuidSha256'].map(k => [k, identity[k]]));
  // whoami reads account metadata only. It never opens a window or asks a secret.
  const result = await execute(win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'],
    { env, timeout: 10000, maxBytes: 4096, lowPriority: true });
  const sids = result.stdout?.match(/S-1-5-(?:\d+-)*\d+/g);
  if (result.status !== 0 || result.reason || result.cleanup === 'tree-unconfirmed' || sids?.length !== 1) fail();
  const context = { revision, kitManifestSha256: hash(manifestBytes), exporterSha256, observerSha256, vm,
    userSidSha256: hash(sids[0].trim().toLowerCase()) };
  if (!contextOK(context)) fail();
  return context;
}

// Unknown raw keys taint the row and never reach the output. Strings have a
// separate privacy bound even when their containing field would be dropped.
function bounded(value, depth = 0) {
  if (depth > 12) fail('RAW_LINE_INVALID');
  if (typeof value === 'string' && (Buffer.byteLength(value) > 256 || /iVBORw0KGgo|[\r\n]/.test(value))) fail('RAW_LINE_INVALID');
  if (Array.isArray(value)) { if (value.length > 4096) fail('RAW_LINE_INVALID'); value.forEach(v => bounded(v, depth + 1)); }
  else if (object(value)) Object.values(value).forEach(v => bounded(v, depth + 1));
}
function keys(value, required, optional = []) {
  if (!object(value) || required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => ![...required, ...optional].includes(k)))
    fail('RAW_KEYS_INVALID');
}
function validateTrial(t) {
  keys(t, ['schema', 'kind', 'rowId', 'caseId', 'trial', 'startTickMs', 'endTickMs', 'driver'],
    ['fixture', 'parent', 'pe', 'launch', 'injector', 'unmeasured', 'costSamples', 'typingTarget']);
  if (t.caseId === 'background-word') {
    const target = validateTypingTarget(t.typingTarget);
    if (target.tickMs > t.startTickMs || t.startTickMs - target.tickMs > 2000 ||
        (t.startTickMs % 0x100000000 - target.lastInputTickMs + 0x100000000) % 0x100000000 > 2000) fail('TYPING_TARGET_UNPROVED');
  } else if (t.typingTarget !== undefined) fail('TRIAL_INVALID');
  if (![t.trial, t.startTickMs, t.endTickMs].every(uint) || t.endTickMs < t.startTickMs || !Array.isArray(t.driver) || t.driver.length > 64) fail('TRIAL_INVALID');
  if (t.rowId === 'checkpoint-cost') {
    costSamples(t.caseId, t.costSamples);
    if (t.unmeasured !== undefined && (t.unmeasured !== 'CHECKPOINT_TIMING_UNAVAILABLE' || t.costSamples.length !== 0) ||
        t.costSamples.length === 0 && t.unmeasured !== 'CHECKPOINT_TIMING_UNAVAILABLE') fail('MEASUREMENT_UNAVAILABLE');
  } else if (t.costSamples !== undefined || t.unmeasured !== undefined &&
      !(t.unmeasured === 'OBSERVER_JOIN_REQUIRED' && ['wts-query', 'flags'].includes(t.caseId)))
    fail(/^[A-Z][A-Z0-9_]{0,79}$/.test(t.unmeasured ?? '') ? t.unmeasured : 'MEASUREMENT_UNAVAILABLE');
  for (const d of t.driver) {
    keys(d, ['tickMs', 'replyTickMs', 'ok'], ['method', 'admissionFor', 'requestedUnits', 'unhealthy', 'secureDesktopSeen', 'inFlight', 'windowMatched',
      'typed', 'escapeStops', 'cancelled', 'elapsedMs', 'settleMs', 'limits', 'code', 'reason', 'delivery', 'retry', 'replyMode', 'settleMode', 'counters', 'lifecycleEvents', 'identityChecks']);
    if (d.admissionFor !== undefined && (t.caseId !== 'calculator-refused' || d.method !== 'getApp' ||
        !['getAXState', 'getScreenshot', 'getAXStateAndScreenshot'].includes(d.admissionFor))) fail('TRIAL_INVALID');
    if (!uint(d.tickMs) || !uint(d.replyTickMs) || d.replyTickMs < d.tickMs || d.tickMs < t.startTickMs || d.replyTickMs > t.endTickMs ||
        typeof d.ok !== 'boolean') fail('TRIAL_INVALID');
    if (d.counters !== undefined) keys(d.counters, [], ['postedMessages', 'patternCalls', 'uiaFetches', 'captures', 'finalReads']);
  }
  if (t.fixture !== undefined) keys(t.fixture, [], ['postedMessages', 'keyUps', 'keyDowns', 'escapeDowns', 'postsAfterStop', 'tickMs',
    'textLength', 'invocations', 'keyUpsDelivered', 'effectObserved', 'events']);
  if (t.fixture !== undefined && Object.entries(t.fixture).some(([key, value]) =>
    key === 'events' ? !Array.isArray(value) : ['keyUpsDelivered', 'effectObserved'].includes(key) ? typeof value !== 'boolean' : !uint(value))) fail('TRIAL_INVALID');
  if (t.fixture?.events !== undefined) for (const event of t.fixture.events) {
    keys(event, ['tickMs', 'message']);
    if (!uint(event.tickMs) || ![0x100, 0x101, 0x102, 0x104, 0x105].includes(event.message)) fail('TRIAL_INVALID');
  }
  if (t.parent !== undefined) keys(t.parent, [], ['cards', 'leases', 'contentReads', 'jobId', 'cancelId', 'jobReplyId', 'cancelReplyId',
    'flagMs', 'driverPid', 'resumedDriverPid']);
  if (t.pe !== undefined) keys(t.pe, [], ['originalFilenamePreserved', 'productNamePreserved']);
  if (t.launch !== undefined) keys(t.launch, ['source', 'override'], ['nonceSha256']);
  if (t.injector !== undefined) parseGuestLines(t.injector.map(r => JSON.stringify(r)).join('\n'), 'injector');
}

function hookEventTick(event, tickMs = event.tickMs, eventTickMs = event.eventTickMs) {
  // Resolve the nearest DWORD epoch on either side of the callback clock.
  // A small lead must stay ahead, including when it crosses the wrap boundary.
  let delta = (tickMs % 0x100000000 - eventTickMs + 0x100000000) % 0x100000000;
  if (delta >= 0x80000000) delta -= 0x100000000;
  return tickMs - delta;
}

export function hookEventCount(event, trial) {
  if (!['key', 'mouse'].includes(event.kind)) return 0;
  const first = event.firstTickMs === undefined ? Math.min(event.tickMs, hookEventTick(event)) :
    Math.min(event.firstTickMs, hookEventTick(event, event.firstTickMs, event.firstEventTickMs));
  const last = event.lastTickMs === undefined ? Math.max(event.tickMs, hookEventTick(event)) :
    Math.max(event.lastTickMs, hookEventTick(event, event.lastTickMs));
  // A summary cannot place individual events inside its interval. Count the
  // whole bucket on any overlap, including endpoints, to preserve zero claims.
  return first <= trial.endTickMs && last >= trial.startTickMs ? event.eventCount ?? 1 : 0;
}

export function escapeAttribution(t, observer, injectors) {
  const events = observer.filter(r => r.kind === 'key' && r.key === 'escape' && r.phase === 'down' &&
    hookEventTick(r) >= t.startTickMs && hookEventTick(r) <= t.endTickMs);
  if (events.length !== 1) fail('ESCAPE_UNPROVED');
  const event = events[0];
  const eventTick = hookEventTick(event);
  if (eventTick < t.startTickMs || eventTick > t.endTickMs) fail('ESCAPE_UNPROVED');
  const injectedFlag = event.injected || event.lowerIntegrityInjected;
  const nearby = injectors.some(i => Math.abs(i.tickMs - eventTick) <= 2000);
  const inTrial = injectors.some(i => i.tickMs >= t.startTickMs && i.tickMs <= t.endTickMs);
  if (!injectedFlag && (nearby || inTrial)) fail('INJECTION_UNATTRIBUTED');
  return { source: injectedFlag ? 'scheduled-sendinput' : 'owner-keyboard', injectedFlag, eventTick };
}

function sampleFor(row, c, t, observer, trials, injectors) {
  if (c.id === 'calculator-refused') {
    const admissions = [...Array(5).fill(undefined), ...Array(2).fill(['getAXState', 'getScreenshot', 'getAXStateAndScreenshot']).flat()];
    if (t.driver.length !== admissions.length || t.driver.some((r, i) => r.method !== 'getApp' || r.admissionFor !== admissions[i] || r.ok !== false ||
        r.code !== 'HOSTED_APP_UNRESOLVED' || !['postedMessages', 'patternCalls', 'uiaFetches', 'captures'].every(k => r.counters?.[k] === 0)))
      fail('CALCULATOR_REFUSAL_UNPROVED');
  }
  const within = observer.filter(p => p.kind === 'poll' && p.tickMs >= t.startTickMs && p.tickMs <= t.endTickMs);
  const prior = observer.findLast(p => p.kind === 'poll' && p.tickMs <= t.startTickMs);
  const next = observer.find(p => p.kind === 'poll' && p.tickMs >= t.endTickMs);
  const polls = [prior, ...within, next].filter(Boolean);
  const pump = t.driver.find(d => d.method === 'typeText' && d.requestedUnits > 1);
  const d = (row.id === 'uac-hint' ? t.driver.find(d => d.secureDesktopSeen || d.limits?.includes('secure-desktop-seen')) : undefined) ??
    t.driver.find(d => !d.ok) ?? t.driver.at(-1);
  const success = t.driver.length > 0 && t.driver.every(r => r.ok === true);
  const recovery = t.driver.find(r => d && r.tickMs > d.replyTickMs);
  const values = { ...d, ...d?.counters, ...t.parent, ...t.pe,
    requestedUnits: pump?.requestedUnits, keyUpsDelivered: t.fixture?.keyUpsDelivered, postsAfterStop: t.fixture?.postsAfterStop };
  if (c.id === 'background-word') {
    if (trials.some(other => other !== t && other.caseId === c.id && other.typingTarget?.lastInputTickMs === t.typingTarget.lastInputTickMs)) fail('TYPING_TARGET_UNPROVED');
    values.typingTarget = t.typingTarget.kind;
  }
  values.refused = !success;
  values.effectObserved = t.fixture?.effectObserved;
  if (c.id === 'idle-probe' || row.id.startsWith('browser-refused') && ['notepad', 'calculator', 'wpf'].includes(c.id))
    values.effectObserved = success && t.driver.at(-1)?.windowMatched === true;
  if (row.id === 'person-idle') {
    if (!prior || !next || !polls.every(p => p.lastInputOk)) fail('LAST_INPUT_UNPROVED');
    values.lastInputUnchanged = polls.every(p => p.lastInputTickMs === prior.lastInputTickMs &&
      (p.lastInputChanges ?? 0) === 0 && (p.lastInputFirstTickMs ?? prior.lastInputTickMs) === prior.lastInputTickMs);
  }
  if (row.id === 'person-key-before' || row.id === 'person-key-during') {
    const injection = t.injector?.find(i => i.operation === 'key' && i.key === 'other' && i.code === 'OK' && i.sentInputs === 2);
    if (!injection || !pump) fail('INJECTOR_UNPROVED');
    values.source = 'scheduled-sendinput';
    values.keyLeadMs = pump.tickMs - injection.tickMs;
  }
  if (row.id === 'escape-stop-hardware' || row.id === 'escape-ignored-injected') {
    const attribution = escapeAttribution(t, observer, injectors);
    Object.assign(values, attribution);
    values.stopMs = d?.replyTickMs - attribution.eventTick;
    if (typeof t.fixture?.escapeDowns === 'number') values.swallowed = t.fixture.escapeDowns === 0;
    const nextAction = pump && t.driver.find(r => r.tickMs > pump.replyTickMs && r.method === 'typeText');
    values.nextCode = nextAction?.code;
    values.nextPosts = nextAction?.counters?.postedMessages;
    values.nextPatternCalls = nextAction?.counters?.patternCalls;
  }
  if (row.id === 'escape-ignored-posted') {
    if (!t.driver.some(r => r.method === 'stuckMenuEscape')) fail('POSTED_ESCAPE_UNPROVED');
    values.source = 'stuck-menu-escape';
    values.hookEvents = observer.reduce((count, event) => count + hookEventCount(event, t), 0);
  }
  if (row.id.startsWith('escape-ignored')) {
    const counts = t.driver.map(r => r.escapeStops).filter(uint);
    if (counts.length) values.escapeStops = Math.max(...counts);
  }
  if (c.id === 'wts-query') {
    if (!within.length) fail('WTS_UNPROVED');
    values.ok = within.every(p => p.wtsOk);
  }
  if (c.id === 'flags') {
    const firstLock = trials.find(r => r.driver.some(reply => reply.code === 'SCREEN_LOCKED'));
    const refused = firstLock?.driver.find(reply => reply.code === 'SCREEN_LOCKED');
    const firstAfter = firstLock?.driver.find(reply => reply.tickMs > refused.replyTickMs);
    const locked = refused && observer.findLast(p => p.kind === 'poll' && p.tickMs <= refused.tickMs);
    const unlocked = firstAfter && observer.find(p => p.kind === 'poll' && p.tickMs >= firstAfter.replyTickMs);
    if (!locked?.wtsOk || !unlocked?.wtsOk || locked.tickMs < firstLock.startTickMs || unlocked.tickMs > firstLock.endTickMs) fail('WTS_UNPROVED');
    values.locked = locked.wtsFlags; values.unlocked = unlocked.wtsFlags;
    values.firstAfterUnlockPassed = firstAfter.ok === true && firstAfter.windowMatched === true;
  }
  if (row.id === 'session-switch-refused') values.resumedWithoutRestart = uint(t.parent?.driverPid) && t.parent.driverPid > 0 &&
    t.parent.driverPid === t.parent.resumedDriverPid && recovery?.ok === true && recovery?.windowMatched === true;
  if (row.id === 'uac-refused' && c.id === 'prompt') {
    const secure = within.filter(p => p.desktopOpened && p.desktop === 'Winlogon');
    if (!secure.length || !d) fail('SECURE_DESKTOP_UNPROVED');
    values.firstCall = t.driver.find(r => r.tickMs >= secure[0].tickMs) === d;
    values.inputWhilePrompt = injectors.filter(i => i.sentInputs > 0 && secure.some(p => i.tickMs >= p.tickMs && i.tickMs <= (next?.tickMs ?? t.endTickMs))).length;
  }
  if (row.id === 'uac-refused' && c.id.startsWith('idle-')) values.falseSecureRefusal = t.driver.some(r => r.code === 'SECURE_DESKTOP_ACTIVE');
  if (row.id === 'uac-hint') {
    values.secureDesktopSeen = d?.secureDesktopSeen === true || d?.limits?.includes('secure-desktop-seen') === true;
    values.replyMode = d?.replyMode ?? d?.settleMode;
    let episodes = 0, secure = false;
    for (const p of polls) { const seen = p.desktopOpened && p.desktop === 'Winlogon'; if (seen && !secure) episodes++; secure = seen; }
    if (!episodes) fail('SECURE_DESKTOP_UNPROVED');
    values.stackedPrompts = episodes - 1;
    values.firstAfterAnswerPassed = recovery?.ok === true && recovery?.windowMatched === true;
  }
  if (row.id === 'cancel-frame') {
    const p = t.parent;
    if (!p || ![p.jobId, p.cancelId, p.jobReplyId, p.cancelReplyId].every(uint) || p.jobId === p.cancelId) fail('CANCEL_UNPROVED');
    values.jobReplyMatched = p.jobId === p.jobReplyId; values.cancelReplyMatched = p.cancelId === p.cancelReplyId;
    const job = t.driver.find(r => r.method === 'typeText' && r.requestedUnits === 3000);
    if (!job) fail('CANCEL_UNPROVED');
    Object.assign(values, job, job.counters, { requestedUnits: job.requestedUnits });
  }
  if (row.id.startsWith('direct-launch')) {
    if (!t.launch || t.launch.source === 'scheduled-direct' && !sha(t.launch.nonceSha256)) fail('LAUNCH_UNPROVED');
    values.source = t.launch.source; values.override = t.launch.override;
    values.readPassed = success && t.driver.at(-1)?.windowMatched === true;
  }
  const sample = {};
  for (const key of Object.keys(c.expect)) {
    if (values[key] === undefined) fail('MEASUREMENT_UNAVAILABLE', key);
    if (typeof values[key] === 'string' && !UC3F_ROWS.some(r => r.cases.some(rule => {
      const expect = rule.expect[key];
      return typeof expect === 'string' ? expect === values[key] : expect?.oneOf?.includes(values[key]);
    }))) fail('RAW_VOCABULARY_INVALID');
    sample[key] = values[key];
  }
  return sample;
}

function parseRaw(text, revision) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16 * 1024 * 1024) fail('RAW_LINE_INVALID');
  const records = text.trim().split(/\r?\n/).map(line => {
    if (Buffer.byteLength(line) > 256 * 1024) fail('RAW_LINE_INVALID');
    const r = JSON.parse(line); bounded(r); return r;
  });
  const header = records[0], end = records.at(-1);
  keys(header, ['schema', 'kind', 'rowId', 'revision', 'cases']);
  const row = UC3F_ROWS.find(r => r.id === header.rowId);
  if (!row || header.kind !== 'row' || header.revision !== revision || records.some(r => r.schema !== RAW_SCHEMA || r.rowId !== row.id)) fail('RAW_IDENTITY_INVALID');
  if (!Array.isArray(header.cases) || !header.cases.length || new Set(header.cases.map(c => c.id)).size !== header.cases.length) fail('RAW_CASE_INVALID');
  for (const c of header.cases) {
    const expected = row.cases.find(x => x.id === c.id);
    if (!exact(c, ['id', 'trials', 'presence']) || !expected || c.trials !== expected.trials || c.presence !== casePresence(row.id, c.id)) fail('RAW_CASE_INVALID');
  }
  const trials = records.filter(r => r.kind === 'trial');
  keys(end, ['schema', 'kind', 'rowId', 'trials', 'code'], ['hookRemoved', 'cleanupConfirmed']);
  if (end.kind !== 'end' || end.trials !== trials.length) fail('ROW_NOT_MEASURED');
  if (end.code !== 'RECORDED') fail(/^[A-Z][A-Z0-9_]{0,79}$/.test(end.code ?? '') ? end.code : 'ROW_NOT_MEASURED');
  if ((end.hookRemoved ?? end.cleanupConfirmed) !== true) fail('ROW_NOT_MEASURED');
  for (const r of records.slice(1, -1)) {
    if (r.kind === 'trial') validateTrial(r);
    else if (r.kind === 'observer') keys(r, ['schema', 'kind', 'rowId', 'observation']);
    else fail('ROW_NOT_MEASURED');
  }
  for (const c of header.cases) {
    const actual = trials.filter(r => r.caseId === c.id);
    if (actual.length !== c.trials || actual.some((r, n) => r.trial !== n)) fail('RAW_CASE_INVALID');
  }
  if (trials.some(t => !header.cases.some(c => c.id === t.caseId))) fail('RAW_CASE_INVALID');
  const observer = parseGuestLines(records.filter(r => r.kind === 'observer').map(r => JSON.stringify(r.observation)).join('\n'), 'observer');
  const start = observer[0];
  assertObserverProof(observer, trials, { token: start.rowToken, row: row.id }, start.invocation);
  const injectors = trials.flatMap(t => t.injector ?? []);
  for (const t of trials) if (t.injector?.some(i => i.tickMs < t.startTickMs || i.tickMs > t.endTickMs)) fail('INJECTOR_UNPROVED');
  return { row, header, trials, observer, injectors };
}

export function exportRawLogs(logs, revision, injectorLogs = []) {
  if (!Array.isArray(logs) || logs.length > 20 || !revisionOK(revision)) fail();
  if (!Array.isArray(injectorLogs) || injectorLogs.length > 10000) fail();
  const independentInjectors = injectorLogs.flatMap(text => parseGuestLines(text, 'injector'));
  const parts = new Map(), rejected = new Set(), diagnostics = [];
  for (const text of logs) {
    let id;
    try {
      id = JSON.parse(text.split(/\r?\n/, 1)[0]).rowId;
      const part = parseRaw(text, revision);
      const previous = parts.get(id) ?? [];
      if (previous.some(p => p.header.cases.some(c => part.header.cases.some(x => c.id === x.id)))) fail('RAW_CASE_DUPLICATE');
      previous.push(part); parts.set(id, previous);
    } catch (error) {
      if (!UC3F_ROWS.some(r => r.id === id)) fail();
      rejected.add(id); diagnostics.push({ id, code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code ?? '') ? error.code : 'RAW_LINE_INVALID' });
    }
  }
  const rows = [];
  for (const row of UC3F_ROWS) {
    if (rejected.has(row.id) || !parts.has(row.id)) continue;
    const group = parts.get(row.id);
    try {
      const cases = row.cases.map(c => {
        const part = group.find(p => p.header.cases.some(x => x.id === c.id));
        if (!part) fail('RAW_CASE_MISSING');
        const trials = part.trials.filter(t => t.caseId === c.id);
        return { id: c.id, samples: row.id === 'checkpoint-cost' ? trials.flatMap(t => t.costSamples) : trials.map(t =>
          sampleFor(row, c, t, part.observer, part.trials, [...independentInjectors, ...group.flatMap(p => p.injectors)])) };
      });
      rows.push({ id: row.id, evidence: { cases,
        ...row.id === 'checkpoint-cost' ? { measurementOnly: 'bounds not registered' } : {} } });
    } catch (error) { diagnostics.push({ id: row.id, code: error.code ?? 'MEASUREMENT_UNAVAILABLE', ...(error.field && { field: error.field }) }); }
  }
  return { bundle: { schema: EVIDENCE_SCHEMA, revision, rows }, diagnostics };
}

export function summarizeExport(bundle) {
  const evidence = new Map(bundle.rows.map(r => [r.id, r.evidence]));
  const safetyRules = UC3F_ROWS.filter(r => r.id !== 'checkpoint-cost');
  const safetyRows = { total: safetyRules.length, pass: 0, fail: 0, skip: 0 };
  for (const row of safetyRules)
    safetyRows[evaluateSafetyEvidence(row.id, evidence.get(row.id)).status]++;
  const cost = evaluateSafetyEvidence('checkpoint-cost', evidence.get('checkpoint-cost'));
  const samples = Object.values(cost.costs ?? {}).reduce((n, c) => n + c.count, 0);
  return { safetyRows, checkpointCost: { status: cost.status, samples, note: cost.note },
    safetyPhase: { verdict: safetyRows.fail ? 'failed' : 'incomplete', exitCode: safetyRows.fail ? 1 : 2,
      note: safetyRows.fail ? 'Unsafe safety observations fail the safety phase (exit 1).' :
        'The cost row is unqualified. The safety phase remains incomplete (exit 2) while cost is unmeasured.' } };
}

// Raw row archives retain split cases (person-idle away/present). The projection
// remains exportRawLogs for two blocks or N independent row sittings.
export function rawArchiveHash(raw) {
  if (raw.ioDiagnostics !== undefined && (!Array.isArray(raw.ioDiagnostics) || raw.ioDiagnostics.length > 1024 ||
      raw.ioDiagnostics.some(r => !exact(r, ['file', 'operation', 'fd', 'code', 'attempt', ...Object.hasOwn(r ?? {}, 'count') ? ['count'] : []]) ||
        r.count !== undefined && (!Number.isSafeInteger(r.count) || r.count < 1) ||
        typeof r.file !== 'string' || !/^(?:receiver\.json|(?:[1-9][0-9]{0,5}\.[a-z0-9-]+\.)?(?:observer|inject|direct)-[0-9]{1,4}\.jsonl)$/.test(r.file) ||
        !['lstat', 'open', 'fstat', 'read'].includes(r.operation) ||
        !(r.fd === null || Number.isSafeInteger(r.fd) && r.fd >= 0) ||
        !/^[A-Z][A-Z0-9_]{0,79}$/.test(r.code) || !Number.isInteger(r.attempt) || r.attempt < 0 || r.attempt > 20))) fail();
  return hash(JSON.stringify({ logs: raw.logs, injectorLogs: raw.injectorLogs,
    ...raw.ioDiagnostics !== undefined ? { ioDiagnostics: raw.ioDiagnostics } : {} }));
}
export function combineRowData(sources) {
  if (!Array.isArray(sources) || !sources.length || sources.length > 20) fail();
  let expected;
  const logs = [], injectors = [];
  for (const { raw, bundleBytes, attestation } of sources) {
    if (!contextOK(raw?.context) || raw.schema !== 'sleight.uc3f-row-raw/1' ||
        raw.sha256 !== rawArchiveHash(raw)) fail();
    expected ??= raw.context;
    if (!isDeepStrictEqual(expected, raw.context)) fail();
    verifyAttestation(bundleBytes, attestation, expected);
    const projected = exportRawLogs(raw.logs, expected.revision, raw.injectorLogs);
    if (hash(Buffer.from(JSON.stringify(projected.bundle) + '\n')) !== attestation.bundleSha256) fail();
    logs.push(...raw.logs); injectors.push(...raw.injectorLogs);
  }
  const projected = exportRawLogs(logs, expected.revision, injectors);
  const bundleBytes = Buffer.from(JSON.stringify(projected.bundle) + '\n');
  return { ...projected, bundleBytes, attestation: createAttestation(bundleBytes, expected), sources: sources.length };
}
export function combineRowExports(sources, bank) {
  const result = combineRowData(sources.map(s => ({ raw: JSON.parse(readBounded(s.rawOut, 32 * 1024 * 1024)),
    bundleBytes: readBounded(s.evidenceOut), attestation: JSON.parse(readBounded(s.attestationOut, 16384)) })));
  const bundle = join(bank, `combined-${sources.length}-observations.json`), attestation = join(bank, `combined-${sources.length}-observations.attestation.json`);
  // Repeated resumes use the same immutable source list. Existing outputs must
  // verify, and their bundle bytes must equal the new projection.
  if (sources.length && (() => { try { lstatSync(bundle); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } })()) {
    const previous = readBounded(bundle), sidecar = JSON.parse(readBounded(attestation, 16384));
    const { schema: _schema, bundleSha256: _hash, exportedUtc: _utc, notice: _notice, ...context } = result.attestation;
    verifyAttestation(previous, sidecar, context);
    if (!previous.equals(result.bundleBytes)) fail();
  } else {
    writeFileSync(bundle, result.bundleBytes, { flag: 'wx', mode: 0o600 });
    writeFileSync(attestation, JSON.stringify(result.attestation) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return { bundle, attestation, sources: result.sources, rows: result.bundle.rows.length, diagnostics: result.diagnostics };
}

export async function exportBank({ bank, revision, root = ROOT, context, now = Date.now, check = () => {}, execute, env }) {
  check();
  const raw = join(bank, 'raw'), stat = lstatSync(raw);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  const entries = readdirSync(raw).sort();
  const setupReceipt = /^(?:[1-9][0-9]{0,5}\.[a-z0-9-]+\.)?(?:notepad-state-[1-9][0-9]*|renamed-runtime|edge-metadata|edge-background|terminal-preflight|launch-[a-z-]+|(?:binding|discovery)-[a-z-]+-[1-9][0-9]*|stub-refusal|file-io-[1-9][0-9]*|foreground-[0-9]+|(?:parent-unproved|terminal-controls|cancel-order)-[a-z-]+-[0-9]+)\.json$/;
  const names = entries.filter(name => !setupReceipt.test(name));
  if (entries.length > 10000) fail();
  if (names.length > 20 || names.some(name => !/^(?:[1-9][0-9]{0,5}\.[a-z0-9-]+\.)?(?:person-idle-(?:away|present)|[a-z]+(?:-[a-z]+)*)\.jsonl$/.test(name))) fail();
  const injections = readdirSync(bank).filter(name => /^(?:[1-9][0-9]{0,5}\.[a-z0-9-]+\.)?inject-[0-9]{1,4}\.jsonl$/.test(name));
  const result = exportRawLogs(names.map(name => readBounded(join(raw, name), 16 * 1024 * 1024).toString('utf8')), revision,
    injections.map(name => readBounded(join(bank, name), 2048).toString('utf8')));
  const expected = context ?? await loadAttestationContext({ revision, bank, root, execute, env });
  const bytes = Buffer.from(JSON.stringify(result.bundle) + '\n');
  if (bytes.length > 1024 * 1024) fail();
  const attestation = createAttestation(bytes, expected, new Date(now()).toISOString());
  const attestationBytes = Buffer.from(JSON.stringify(attestation) + '\n');
  // Claim both outputs before writing either. A partial publication has no usable
  // sidecar and is retained for inspection, never overwritten on a retry.
  check();
  const output = join(bank, 'uc3f-observations.json'), sidecar = join(bank, 'uc3f-observations.attestation.json');
  const first = openSync(output, 'wx', 0o600);
  try {
    const second = openSync(sidecar, 'wx', 0o600);
    try { check(); writeFileSync(first, bytes); writeFileSync(second, attestationBytes); }
    finally { closeSync(second); }
  } finally { closeSync(first); }
  verifyAttestation(readBounded(output), JSON.parse(readBounded(sidecar, 16384)), expected);
  const rawExport = { schema: 'sleight.uc3f-row-raw/1', context: expected,
    logs: names.map(name => readBounded(join(raw, name), 16 * 1024 * 1024).toString('utf8')),
    injectorLogs: injections.map(name => readBounded(join(bank, name), 2048).toString('utf8')) };
  const ioFiles = entries.filter(name => /(?:^|\.)file-io-[1-9][0-9]*\.json$/.test(name));
  if (ioFiles.length) rawExport.ioDiagnostics = ioFiles.map(name => {
    const r = JSON.parse(readBounded(join(raw, name), 4096));
    return { file: String(r.path).split(/[\\/]/).at(-1), operation: r.operation, fd: r.fd, code: r.code, attempt: r.attempt ?? 0,
      ...r.count !== undefined ? { count: r.count } : {} };
  });
  rawExport.logs.forEach(text => parseRaw(text, revision));
  rawExport.sha256 = rawArchiveHash(rawExport);
  writeFileSync(join(bank, 'uc3f-row-raw.json'), JSON.stringify(rawExport) + '\n', { flag: 'wx', mode: 0o600 });
  const measuredOnly = result.bundle.rows.filter(r => r.id === 'checkpoint-cost').length;
  return { exported: true, rows: result.bundle.rows.length, unmeasured: UC3F_ROWS.length - result.bundle.rows.length,
    ...measuredOnly ? { measurementOnly: measuredOnly } : {}, ...summarizeExport(result.bundle) };
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  if ((dependencies.platform ?? process.platform) !== 'win32') fail('WINDOWS_REQUIRED');
  if (args.length !== 4) fail('INVALID_REQUEST');
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--transport-request', '--transport-result'].includes(args[i]) || values.has(args[i])) fail('INVALID_REQUEST');
    values.set(args[i], args[i + 1]);
  }
  const requestPath = resolve(values.get('--transport-request')), resultPath = resolve(values.get('--transport-result'));
  const bank = dirname(requestPath), invocation = /^([1-9][0-9]{0,5})\.request\.json$/.exec(basename(requestPath))?.[1];
  (dependencies.validateBank ?? checkBank)(bank);
  const request = JSON.parse(readBounded(requestPath, 16384));
  if (!invocation || dirname(resultPath) !== bank || basename(resultPath) !== `${invocation}.value.json` ||
      !exact(request, ['protocol', 'operation', 'invocation', 'token', 'presence', 'vmId', 'expected', 'payload']) ||
      request.protocol !== 'sleight.uc3f-transport/1' || request.operation !== 'export' || request.invocation !== invocation ||
      request.token !== /^uc3f-([a-f0-9]{16})$/.exec(basename(bank))?.[1] || !['away', 'present'].includes(request.presence) ||
      !exact(request.payload, [])) fail('INVALID_REQUEST');
  const { now = Date.now, root = ROOT } = dependencies;
  const check = () => {};
  const manifest = JSON.parse(readBounded(join(root, 'guest-manifest.json'), 4 * 1024 * 1024));
  const context = await (dependencies.loadContext ?? loadAttestationContext)({ revision: manifest.commit, bank, root,
    execute: dependencies.execute, env: dependencies.env });
  if (request.vmId !== context.vm.vmId || Object.keys(context.vm).some(k => request.expected?.[k] !== context.vm[k])) fail('VM_IDENTITY_MISMATCH');
  const result = await exportBank({ bank, revision: manifest.commit, root, context, now, check });
  check();
  writeFileSync(resultPath, JSON.stringify({ exported: true }), { flag: 'wx', mode: 0o600 });
  return result;
}
if (isMain(import.meta.url)) main().then(result => {
  process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = 0;
}).catch(error => {
  process.stderr.write(/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code ?? '') ? error.code + '\n' : 'UC3F_EVIDENCE_INVALID\n'); process.exitCode = 1;
});
