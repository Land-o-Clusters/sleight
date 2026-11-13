// Guest-only UC3F collection. Importing and planning never start a child.
// Raw records are observations, not passing samples. The exporter grades them.
// sleight.uc3f-transport/1: file-request
import { constants, lstatSync, realpathSync, writeFileSync, mkdirSync, unlinkSync,
  openSync, closeSync, fstatSync, readSync, existsSync, renameSync } from 'node:fs';
import { win32, join, dirname, basename, resolve } from 'node:path';
import { uptime } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as sitting from './driver-sitting.mjs';
import { createWindowsDriverClient } from '../../plugins/sleight/lib/windows-driver/client.mjs';
import { windowsDiagnostics } from '../../plugins/sleight/lib/windows-driver/diagnostics.mjs';
import { ACTION_METHODS } from '../../plugins/sleight/lib/windows-driver/actions.mjs';
import { createWindowsReplClient } from '../../plugins/sleight/lib/windows-repl/client.mjs';
import { verifyWindowIdentity, windowBinding } from '../../plugins/sleight/lib/windows-repl/identity.mjs';
import { prepareWindowsHandHost } from '../../plugins/sleight/lib/direct-browser/windows-host.mjs';
import { createWindowsSafety } from '../../plugins/sleight/lib/windows-driver/safety.mjs';
import { isMain, ROOT } from './kit.mjs';
import { runGuestChild as runChild } from './guest-child.mjs';
import { guestSelftestPlan, guestDiagnosticPlan, runGuestSelftest } from './uc3f-selftest.mjs';
import { proveFixtureLaunch, bindRefusedFixture, bindTerminalSettingsFixture, requireCalculatorRefusals, FIXTURE_LAUNCHER, guestFixtureSource, createGuestInspector, powershellCall, runDirectTrial, openTerminalSettings } from './uc3f-fixtures.mjs';
export { assertFixtureArguments, proveActivatedFixture, proveRefusedCalculator, proveFixtureLaunch, bindRefusedFixture, bindTerminalSettingsFixture, requireCalculatorRefusals, GUEST_FAILURE, GUEST_OPERATIONS, GUEST_FIXTURE, FIXTURE_LAUNCHER, guestFixtureSource, createGuestInspector, inspectorBinding, powershellCall, runDirectTrial, openTerminalSettings, asciiJSON } from './uc3f-fixtures.mjs';
import { preflightNotepad } from './notepad-state.mjs';
import { observerRemoval, observerResult, recordSetup, stoppedFixture, waitFixtureInput, fileFailureRecorder,
  readTelemetryFailure, directReply, discoveryWindows, requireFixtureForeground } from './uc3f-diagnostics.mjs';
import { typingReadMetadata } from './typing-diagnostic.mjs';
import { versionResource, assertVersionCopied } from './version-resource.mjs';
import { STUB_SOURCE, STUB_TITLE, STUB_CLASS, METADATA_STUB, NEUTRAL_STUB, NEUTRAL_VERSION, qualifyRenamedStubs } from './browser-stub.mjs';

export const RAW_SCHEMA = 'sleight.windows-uc3f-raw/1';
export const TRANSPORT_PROTOCOL = 'sleight.uc3f-transport/1';
// Timing fields are observations from an instrumented native reply. A missing
// field is never replaced by request wall time or an expected value.
export const COST_FIELDS = Object.freeze({
  'session-probe': ['elapsedMs'], 'lock-check': ['elapsedMs'], 'desktop-check': ['elapsedMs'], 'person-input': ['elapsedMs'], 'budget-check': ['elapsedMs'], 'hook-install': ['elapsedMs'], 'hook-remove': ['elapsedMs'], 'hook-callback': ['elapsedUs'] });
export function costSamples(caseId, samples) {
  const fields = COST_FIELDS[caseId];
  if (!fields || !Array.isArray(samples) || samples.length > 1 || samples.some(s => !exact(s, fields) ||
      fields.some(k => !Number.isFinite(s[k]) || s[k] < 0))) fail('CHECKPOINT_TIMING_INVALID');
  return structuredClone(samples);
}
const fail = code => { throw Object.assign(Error(code), { code }); };
const codeOf = e => typeof e?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(e.code) ? e.code : 'COLLECTION_FAILED';
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => object(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const uint = n => Number.isSafeInteger(n) && n >= 0;
const delay = ms => new Promise(done => setTimeout(done, ms));
const digest = text => createHash('sha256').update(text).digest('hex');

export function selectCases(row, cases, presence) {
  const allowed = presence === 'away' ? ['notepad', 'wpf', 'calculator-refused'] : ['background-word'];
  if (cases !== undefined && (row.id !== 'person-idle' || JSON.stringify(cases) !== JSON.stringify(allowed))) fail('INVALID_OPTIONS');
  return row.id === 'person-idle' ? row.cases.filter(c => allowed.includes(c.id)) : row.cases;
}

// IDs and counts from UC3E. Use its exported table after integration and reject
// drift, rather than using its expected outcomes to generate observations.
const layouts = [
  ['person-idle', [['notepad', 50], ['wpf', 50], ['calculator-refused', 10], ['background-word', 20]]],
  ['person-key-before', [['scheduled-key', 20]]], ['person-key-during', [['typing', 10]]],
  ['lock-refused', [['read', 10], ['capture', 10], ['action', 10], ['unlocked-action', 50], ['wts-query', 1000], ['flags', 1]]],
  ['lock-during-type', [['typing', 10]]], ['screensaver-refused', [['screensaver', 5]]],
  ['session-switch-refused', [['switch', 5]]],
  ['uac-refused', [['prompt', 10], ['idle-probe', 100], ['idle-action', 50]]],
  ['uac-hint', [['raised-prompt', 10]]], ['escape-stop-hardware', [['hardware', 10]]],
  ['escape-ignored-injected', [['injected', 10]]], ['escape-ignored-posted', [['posted', 10]]],
  ['cancel-frame', [['cancel-first', 5], ['job-first', 5]]],
  ...['direct-launch-terminal', 'direct-launch-override'].map(id => [id,
    ['direct-terminal', 'parent-terminal', 'direct-settings', 'parent-settings'].map(c => [c, 10])]),
  ['browser-refused-edge', [['name', 10], ['hwnd', 10], ['notepad', 50], ['wpf', 100]]],
  ['browser-refused-firefox', [['name', 10], ['hwnd', 10]]], ['browser-refused-renamed', [['renamed', 10]]],
  ['checkpoint-cost', [...['session-probe', 'lock-check', 'desktop-check', 'person-input', 'budget-check', 'hook-install', 'hook-remove'].map(c => [c, 50]), ['hook-callback', 100]]],
];
const presentRows = new Set(['lock-refused', 'lock-during-type', 'screensaver-refused', 'session-switch-refused',
  'uac-refused', 'uac-hint', 'escape-stop-hardware']);
export const casePresence = (rowId, caseId) => presentRows.has(rowId) || caseId === 'background-word' ? 'present' : 'away';

export function collectorPlan(rowIds = layouts.map(([id]) => id)) {
  if (!Array.isArray(rowIds) || !rowIds.length || new Set(rowIds).size !== rowIds.length ||
      rowIds.some(id => !layouts.some(([name]) => name === id))) fail('UNKNOWN_SAFETY_ROW');
  const integrated = sitting.UC3F_ROWS;
  if (integrated && JSON.stringify(integrated.map(r => [r.id, r.cases.map(c => [c.id, c.trials])])) !== JSON.stringify(layouts))
    fail('INVALID_OPTIONS');
  return rowIds.map(id => ({ id, cases: layouts.find(([name]) => name === id)[1].map(([caseId, trials]) =>
    ({ id: caseId, trials, presence: casePresence(id, caseId) })),
  ...(id === 'checkpoint-cost' ? { measurementOnly: 'bounds not registered' } : {}) }));
}

// The VM runner creates the bank. No caller-selected fixture HWNDs.
export function parseCollectArgs(args) {
  const o = { rows: [] }, seen = new Set();
  for (let n = 0; n < args.length; n++) {
    const flag = args[n];
    if (seen.has(flag) && flag !== '--row') fail('INVALID_OPTIONS');
    seen.add(flag);
    if (flag === '--dry-run') { o.dryRun = true; continue; }
    if (flag === '--owner-away') { o.ownerAway = true; continue; }
    const value = args[++n];
    if (!value || value.startsWith('--')) fail('INVALID_OPTIONS');
    if (flag === '--row') o.rows.push(value);
    else if (flag === '--cases') o.cases = value.split(',');
    else if (flag === '--bank') o.bank = value;
    else if (flag === '--revision' && /^[a-f0-9]{40}$/.test(value)) o.revision = value;
    else fail('INVALID_OPTIONS');
  }
  if (!o.rows.length) o.rows = layouts.map(([id]) => id);
  collectorPlan(o.rows);
  if (o.cases) {
    if (o.rows.length !== 1) fail('INVALID_OPTIONS');
    selectCases(collectorPlan(o.rows)[0], o.cases, o.ownerAway ? 'away' : 'present');
  }
  if (!o.dryRun && (!/^C:\\sleight-setup\\uc3f-[a-f0-9]{16}$/.test(o.bank ?? '') || !o.revision || o.rows.length !== 1)) fail('INVALID_OPTIONS');
  return o;
}

function ordinary(path, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail('BANK_IDENTITY');
  return stat;
}
export function checkBank(bank) {
  if (!/^C:\\sleight-setup\\uc3f-[a-f0-9]{16}$/.test(bank)) fail('BANK_IDENTITY');
  for (let at = bank; ; at = dirname(at)) {
    ordinary(at, true);
    if (dirname(at) === at) break;
  }
  if (realpathSync(bank).toLowerCase() !== bank.toLowerCase()) fail('BANK_IDENTITY');
}

function readOrdinary(path, limit = 4096, bytesOnly = false) {
  let fd, operation = 'lstat';
  try {
    const initial = ordinary(path);
    operation = 'open'; fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    operation = 'fstat';
    const stat = fstatSync(fd);
    if (!stat.isFile() || initial.dev !== stat.dev || initial.ino !== stat.ino || stat.size > limit) fail('RAW_FILE_INVALID');
    const bytes = Buffer.alloc(limit + 1);
    let size = 0, n;
    operation = 'read';
    while (size < bytes.length && (n = readSync(fd, bytes, size, bytes.length - size, size)) > 0) size += n;
    if (size > limit) fail('RAW_FILE_INVALID');
    return bytesOnly ? bytes.subarray(0, size) : bytes.subarray(0, size).toString('utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    error.fileDiagnostic = { path, operation, fd: fd ?? null, code: codeOf(error) };
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

// PowerShell and the WPF receiver briefly hold their published files open on
// Windows. Retry only that sharing failure, while the row remains active.
export async function readPublishedFile(path, { read = readOrdinary, limit = 4096, check, sleep = delay, retries = 20, audit = () => {} }) {
  for (let attempt = 0; ; attempt++) {
    await check();
    try { return read(path, limit); }
    catch (error) {
      audit({ ...error.fileDiagnostic ?? { path, operation: 'read', fd: null, code: codeOf(error) }, attempt });
      if (error.code !== 'EBUSY' || attempt >= retries) throw error;
      await sleep(50);
    }
  }
}

export function assertObserverProof(lines, trials, rowContext, invocation) {
  const start = lines[0], end = lines.at(-1), polls = lines.filter(r => r.kind === 'poll');
  if (start?.kind !== 'start' || end?.kind !== 'end') fail('OBSERVER_UNPROVED');
  if (end.records !== lines.length || lines.some((r, n) => r.seq !== n + 1)) fail('OBSERVER_UNPROVED');
  if (end.truncated || end.diskError) fail('OBSERVER_UNPROVED');
  if (end.pollError) fail('OBSERVER_POLL_FAILED');
  if (end.hookRemoved !== true || end.keyboardHookRemoved !== true || end.mouseHookRemoved !== true ||
      end.keyboardHookInstalled !== true || end.mouseHookInstalled !== true || end.callbackError || end.pollError ||
      !['completed', 'stop-requested', 'lease-expired'].includes(end.stopReason) ||
      start.rowToken !== rowContext.token || start.rowId !== rowContext.row || start.invocation !== invocation ||
      lines.slice(1, -1).some(r => !['poll', 'key', 'mouse'].includes(r.kind)) ||
      lines.some((r, n) => n > 0 && r.tickMs < lines[n - 1].tickMs)) fail('OBSERVER_UNPROVED');
  const maxGap = start.heartbeatMs + 100, coverage = [start, ...polls, end];
  if (!polls.length || coverage.some((r, n) => n > 0 && r.tickMs - coverage[n - 1].tickMs > maxGap) ||
      polls.some((r, n) => r.maxGapMs > 100 || r.pollCount < 1 || n > 0 &&
        (r.pollCount <= polls[n - 1].pollCount || r.maxGapMs < polls[n - 1].maxGapMs ||
         r.tickMs - polls[n - 1].tickMs > (r.pollCount - polls[n - 1].pollCount) * 100)) ||
      end.pollCount !== polls.at(-1).pollCount ||
      trials.some(r => r.startTickMs < polls[0].tickMs || r.endTickMs > polls.at(-1).tickMs || r.endTickMs < r.startTickMs))
    fail('OBSERVER_UNPROVED');
}

export function assertClockSample(before, guestTick, after) {
  if (![before, guestTick, after].every(uint) || after < before || after - before > 10000 ||
      guestTick < before - 250 || guestTick > after + 250) fail('CLOCK_SOURCE_MISMATCH');
}

export async function requestObserverStop(bank, requestInvocation, observerInvocation, rowContext,
  { write = writeFileSync, rename = renameSync, sleep = delay } = {}) {
  if (!/^[1-9][0-9]{0,5}$/.test(requestInvocation ?? '') || !/^[0-9]{1,4}$/.test(observerInvocation ?? ''))
    fail('OBSERVER_UNPROVED');
  const bytes = readOrdinary(join(bank, `${requestInvocation}.request.json`), 16384, true);
  const request = JSON.parse(bytes.toString('utf8'));
  validateTransportRequest(request, requestInvocation, /^uc3f-([a-f0-9]{16})$/.exec(basename(bank))?.[1]);
  if (!['row', 'selftest'].includes(request.operation) || request.payload.row.id !== rowContext.row) fail('INVALID_REQUEST');
  const path = join(bank, `${requestInvocation}.observer-${observerInvocation}.stop.request.json`);
  if (existsSync(path)) {
    if (!readOrdinary(path, 16384, true).equals(bytes)) fail('INVALID_REQUEST');
  } else {
    const temporary = path + '.tmp';
    let created = false;
    try {
      write(temporary, bytes, { flag: 'wx', mode: 0o600 }); created = true;
      for (let attempt = 0; ; attempt++) {
        try { rename(temporary, path); break; }
        catch (error) {
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 3) throw error;
          await sleep(50);
        }
      }
    } finally { if (created && existsSync(temporary)) unlinkSync(temporary); }
  }
  return path;
}

export async function runObserver(command, args, settings, { execute = runChild, check, requestStop,
  registerStop = () => {}, schedule = setTimeout, cancel = clearTimeout } = {}) {
  await check();
  const controller = new AbortController();
  let fault, timer, stopTimer, checking = false, stopping = false, stopExpired = false, finished = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    // Start even if publication fails. Wait for runChild's owned-tree cleanup.
    if (!finished) stopTimer = schedule(() => { stopExpired = true; controller.abort(); }, 10000);
    await requestStop();
  };
  registerStop(stop);
  timer = setInterval(async () => {
    if (checking || fault) return;
    checking = true;
    try { await check(); } catch (error) {
      fault = codeOf(error);
      try { await stop(); } catch { /* the stop deadline still bounds the observer */ }
    } finally { checking = false; }
  }, 100);
  try {
    const result = await execute(command, args, { ...settings, signal: controller.signal });
    if (stopExpired) fail('OBSERVER_STOP_TIMEOUT');
    if (fault) fail(fault);
    await check();
    return result;
  } finally { finished = true; clearInterval(timer); if (stopTimer !== undefined) cancel(stopTimer); }
}

export function validateTransportRequest(request, invocation, token) {
  if (!exact(request, ['protocol', 'operation', 'invocation', 'token', 'presence', 'vmId', 'expected', 'payload']) ||
      request.protocol !== TRANSPORT_PROTOCOL || request.invocation !== invocation || request.token !== token ||
      !/^[1-9][0-9]{0,5}$/.test(invocation) || !/^[a-f0-9]{16}$/.test(token) ||
      !['row', 'selftest'].includes(request.operation) || !['away', 'present'].includes(request.presence)) fail('INVALID_REQUEST');
  const expected = request.expected;
  if (!exact(expected, ['schema', 'hostName', 'vmId', 'manufacturer', 'model', 'build', 'hostnameSha256', 'machineGuidSha256', 'provenance']) ||
      expected.schema !== 'sleight.uc3f-vm-record/1' || request.vmId !== expected.vmId || !/^[A-Za-z0-9-]{1,80}$/.test(request.vmId ?? '') ||
      !/^192\.168\.64\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/.test(expected.hostName ?? '') ||
      expected.manufacturer !== 'QEMU' || !/^[A-Za-z0-9 ._-]{1,80}$/.test(expected.model ?? '') ||
      !Number.isSafeInteger(expected.build) || expected.build < 22000 ||
      ![expected.hostnameSha256, expected.machineGuidSha256].every(v => /^[a-f0-9]{64}$/.test(v ?? '')) ||
      !exact(expected.provenance, ['hostname', 'machineGuid', 'encoding']) ||
      expected.provenance.hostname !== 'Win32_ComputerSystem.Name' ||
      expected.provenance.machineGuid !== 'HKLM\\SOFTWARE\\Microsoft\\Cryptography\\MachineGuid' ||
      expected.provenance.encoding !== 'sha256:utf8:trim:lowercase') fail('VM_IDENTITY_MISMATCH');
  const payload = request.payload;
  if (request.operation === 'selftest') {
    const planned = [...guestSelftestPlan(), ...guestDiagnosticPlan()].find(p => p.id === payload?.job?.id);
    if (!exact(payload, ['job', 'row']) || !planned || JSON.stringify(payload.job) !== JSON.stringify(planned) || request.presence !== 'away' ||
        payload.row.id !== planned.rowId || payload.row.presence !== 'away') fail('INVALID_REQUEST');
  } else {
    if (!exact(payload, ['row']) || !object(payload.row)) fail('INVALID_REQUEST');
    const row = payload.row;
    if (!exact(row, row.id === 'person-idle' ? ['id', 'presence', 'cases'] : ['id', 'presence']) || row.presence !== request.presence) fail('INVALID_REQUEST');
    const plan = collectorPlan([row.id])[0];
    if (row.id !== 'person-idle' && presentRows.has(row.id) !== (request.presence === 'present')) fail('INVALID_REQUEST');
    selectCases(plan, row.cases, request.presence);
  }
  return request;
}

export function readTransportRequest(args, { validateBank = checkBank } = {}) {
  if (args.length !== 4) fail('INVALID_OPTIONS');
  const values = new Map();
  for (let n = 0; n < args.length; n += 2) {
    if (!['--transport-request', '--transport-result'].includes(args[n]) || values.has(args[n]) || !args[n + 1]) fail('INVALID_OPTIONS');
    values.set(args[n], args[n + 1]);
  }
  if (values.size !== 2) fail('INVALID_OPTIONS');
  const requestPath = resolve(values.get('--transport-request')), resultPath = resolve(values.get('--transport-result'));
  const bank = dirname(requestPath), match = /^([1-9][0-9]{0,5})\.request\.json$/.exec(basename(requestPath));
  validateBank(bank);
  if (!match || dirname(resultPath) !== bank || basename(resultPath) !== `${match[1]}.value.json` || existsSync(resultPath)) fail('INVALID_REQUEST');
  const token = /^uc3f-([a-f0-9]{16})$/.exec(basename(bank))?.[1];
  let request;
  try { request = JSON.parse(readOrdinary(requestPath, 16384)); } catch { fail('INVALID_REQUEST'); }
  validateTransportRequest(request, match[1], token);
  return { request, bank, resultPath };
}

// G7's request number distinguishes a repeated row; row id makes ownership visible.
export function rowFilePrefix(requestInvocation, rowId) {
  if (!/^[1-9][0-9]{0,5}$/.test(requestInvocation ?? '') || !layouts.some(([id]) => id === rowId)) fail('INVALID_REQUEST');
  return `${requestInvocation}.${rowId}.`;
}
const rowEvidence = /^(?:(?:[1-9][0-9]{0,5}\.[a-z0-9-]+\.)?(?:owner-go-[a-z0-9-]+|go-[0-9]{1,4}|(?:observer|inject|direct)-[0-9]{1,4}\.jsonl)|launch-intent-[1-9][0-9]{0,5}-[a-z-]+\.json)$/;
export function assertFixture(window, fixtures) {
  const fixture = fixtures.find(f => f.windowId === window?.windowId && f.pid === window?.pid && f.processStart === window?.processStart);
  if (!fixture) fail('FOREGROUND_NOT_FIXTURE');
  windowBinding(window);
  for (const key of ['image', 'className']) if (window[key] !== fixture[key]) fail('FIXTURE_IDENTITY_CHANGED');
  if (typeof fixture.title === 'string' && String(window.title).replace(/^\*/, '') !== fixture.title.replace(/^\*/, '')) fail('FIXTURE_IDENTITY_CHANGED');
  if (!['low', 'medium'].includes(window.integrity)) fail('FIXTURE_IDENTITY_CHANGED');
  return fixture;
}

const observerKeys = {
  start: ['sessionId', 'integrity', 'pollMs', 'maxRecords', 'heartbeatMs', 'maxBytes', 'invocation', 'rowToken', 'rowId'],
  poll: ['foregroundHwnd', 'foregroundPid', 'lastInputOk', 'lastInputTickMs', 'wtsOk', 'wtsState', 'wtsFlags', 'desktopOpened', 'desktop', 'pollCount', 'maxGapMs'],
  key: ['foregroundHwnd', 'foregroundPid', 'eventTickMs', 'key', 'phase', 'injected', 'lowerIntegrityInjected'],
  mouse: ['foregroundHwnd', 'foregroundPid', 'eventTickMs', 'phase', 'injected', 'lowerIntegrityInjected'],
  end: ['keyboardHookInstalled', 'mouseHookInstalled', 'keyboardHookRemoved', 'mouseHookRemoved', 'hookRemoved',
    'keyboardHookError', 'mouseHookError', 'truncated', 'callbackError', 'pollError', 'diskError', 'stopReason', 'records', 'pollCount'],
};
const mouseSummaryKeys = ['firstTickMs', 'lastTickMs', 'firstEventTickMs', 'firstForegroundHwnd', 'firstForegroundPid', 'eventCount'];
const inputSummaryKeys = ['lastInputFirstTickMs', 'lastInputChanges'];
const injectorKeys = ['schema', 'kind', 'invocation', 'operation', 'key', 'tickMs', 'eventTickMs', 'vk', 'sentInputs', 'code'];
export function parseGuestLines(text, kind) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > (kind === 'observer' ? 8 : 16) * 1024 * 1024) fail('RAW_LINE_INVALID');
  return text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(Boolean).map(line => {
    if (Buffer.byteLength(line) > 2048) fail('RAW_LINE_INVALID');
    let r;
    try { r = JSON.parse(line); } catch { fail('RAW_LINE_INVALID'); }
    if (kind !== 'observer' && kind !== 'injector') fail('RAW_LINE_INVALID');
    if (kind === 'observer' && !Object.hasOwn(observerKeys, r?.kind)) fail('RAW_LINE_INVALID');
    const summary = kind === 'observer' ? r.kind === 'mouse' && Object.hasOwn(r, 'eventCount') ? mouseSummaryKeys :
      r.kind === 'poll' && Object.hasOwn(r, 'lastInputChanges') ? inputSummaryKeys : [] : [];
    const keys = kind === 'observer' ? ['schema', 'kind', 'tickMs', 'seq', ...observerKeys[r.kind], ...r.kind === 'start' && Object.hasOwn(r, 'leaseExpiresUtc') ? ['leaseExpiresUtc'] : [], ...summary] : injectorKeys;
    if (!exact(r, keys) || r.schema !== (kind === 'observer' ? 'sleight.windows-uc3f-observer/2' : 'sleight.windows-uc3f-inject/1') ||
        !uint(r.tickMs) || Object.values(r).some(v => typeof v === 'string' && (Buffer.byteLength(v) > 256 || /iVBORw0KGgo|[\r\n]/.test(v)))) fail('RAW_LINE_INVALID');
    if (kind === 'observer') {
      if (!uint(r.seq) || r.seq < 1 || r.seq > 32768 || !Object.hasOwn(observerKeys, r.kind)) fail('RAW_LINE_INVALID');
      for (const key of ['injected', 'lowerIntegrityInjected', 'lastInputOk', 'wtsOk', 'desktopOpened', 'hookRemoved',
        'keyboardHookInstalled', 'mouseHookInstalled', 'keyboardHookRemoved', 'mouseHookRemoved', 'truncated', 'callbackError', 'pollError', 'diskError'])
        if (Object.hasOwn(r, key) && typeof r[key] !== 'boolean') fail('RAW_LINE_INVALID');
      if (r.kind === 'key' && (!['escape', 'other'].includes(r.key) || !['down', 'up'].includes(r.phase))) fail('RAW_LINE_INVALID');
      if (r.kind === 'mouse' && !['move', 'down', 'up', 'wheel', 'other'].includes(r.phase)) fail('RAW_LINE_INVALID');
      if (['key', 'mouse'].includes(r.kind) && (!uint(r.eventTickMs) || r.eventTickMs > 0xffffffff)) fail('RAW_LINE_INVALID');
      if (r.kind === 'mouse' && summary.length && (!uint(r.eventCount) || r.eventCount < 1 ||
          !uint(r.firstTickMs) || !uint(r.lastTickMs) || r.firstTickMs > r.lastTickMs || r.lastTickMs > r.tickMs ||
          !uint(r.firstEventTickMs) || r.firstEventTickMs > 0xffffffff || !uint(r.firstForegroundPid) ||
          !/^0x[0-9a-f]{1,16}$/.test(r.firstForegroundHwnd))) fail('RAW_LINE_INVALID');
      if (r.kind === 'poll' && summary.length && (!uint(r.lastInputChanges) ||
          !uint(r.lastInputFirstTickMs) || r.lastInputFirstTickMs > 0xffffffff)) fail('RAW_LINE_INVALID');
      if (r.kind === 'start' && (!uint(r.sessionId) || r.sessionId === 0 || !['low', 'medium'].includes(r.integrity) ||
          r.pollMs !== 10 || r.maxRecords !== 32768 || r.heartbeatMs !== 1000 || r.maxBytes !== 8 * 1024 * 1024 ||
          !/^[0-9]{1,4}$/.test(r.invocation) || !/^[a-f0-9]{32}$/.test(r.rowToken) || !layouts.some(([id]) => id === r.rowId))) fail('RAW_LINE_INVALID');
      if (r.kind === 'poll' && (!uint(r.pollCount) || !uint(r.maxGapMs) || !uint(r.lastInputTickMs) || r.lastInputTickMs > 0xffffffff ||
          !['Default', 'Winlogon', 'Screen-saver', 'other', 'unavailable'].includes(r.desktop) ||
          !['wtsState', 'wtsFlags'].every(k => Number.isInteger(r[k]) && r[k] >= -0x80000000 && r[k] <= 0x7fffffff) ||
          !r.lastInputOk && r.lastInputTickMs !== 0 || !r.wtsOk && (r.wtsState !== -1 || r.wtsFlags !== -1) ||
          !r.desktopOpened && r.desktop !== 'unavailable')) fail('RAW_LINE_INVALID');
      if (['poll', 'key', 'mouse'].includes(r.kind) && (!uint(r.foregroundPid) || !/^0x[0-9a-f]{1,16}$/.test(r.foregroundHwnd))) fail('RAW_LINE_INVALID');
      if (r.kind === 'end' && (!uint(r.pollCount) || !uint(r.records) || r.records < 2 || r.records > 32768 ||
          !['keyboardHookError', 'mouseHookError'].every(k => uint(r[k])) ||
          r.hookRemoved !== (r.keyboardHookRemoved && r.mouseHookRemoved) ||
          !['completed', 'stop-requested', 'lease-expired', 'lease-revoked', 'record-limit', 'hook-install-failed', 'observer-error', 'disk-error', 'stop-invalid'].includes(r.stopReason))) fail('RAW_LINE_INVALID');
    } else if (r.kind !== 'injector' || !/^[0-9]{1,4}$/.test(r.invocation) || !['key', 'lock', 'screensaver', 'session-switch'].includes(r.operation) ||
        !['escape', 'other', 'none'].includes(r.key) || ![0, 27, 81].includes(r.vk) || !uint(r.sentInputs) || r.sentInputs > 2 ||
        !uint(r.eventTickMs) || r.eventTickMs !== r.tickMs % 0x100000000 || !/^[A-Z][A-Z0-9_]{0,63}$/.test(r.code) ||
        r.vk !== (r.operation === 'key' ? r.key === 'escape' ? 27 : 81 : 0) ||
        r.key !== (r.operation === 'key' ? r.key === 'escape' ? 'escape' : 'other' : 'none') ||
        r.sentInputs === 2 && (r.code !== 'OK' || r.operation !== 'key')) fail('RAW_LINE_INVALID');
    return r;
  });
}

// Drop content at the read boundary. In particular, never serialize a screenshot,
// AX text, title, arbitrary exception message or a claimed hardware source.
export function projectReply(reply, error = false) {
  const r = {}, input = error ? reply : reply ?? {};
  const bools = ['unhealthy', 'secureDesktopSeen', 'inFlight', 'windowMatched'];
  for (const k of bools) if (typeof input?.[k] === 'boolean') r[k] = input[k];
  if (input?.windowMatched === null) r.windowMatched = null;
  for (const k of ['typed', 'requestedUnits', 'escapeStops', 'cancelled']) if (uint(input?.[k])) r[k] = input[k];
  for (const k of ['elapsedMs', 'settleMs']) if (Number.isFinite(input?.[k]) && input[k] >= 0) r[k] = input[k];
  if (Array.isArray(input?.limits)) r.limits = input.limits.filter(v => ['secure-desktop-seen'].includes(v));
  for (const [k, pattern] of Object.entries({ code: /^[A-Z][A-Z0-9_]{0,79}$/, reason: /^[a-z][a-z-]{0,63}$/,
    delivery: /^(?:not-sent|sent-unverified)$/, retry: /^(?:safe|read-first)$/, replyMode: /^(?:cap|budget|deadline)$/,
    settleMode: /^(?:event-quiet|poll-stable|cap|budget|deadline)$/ }))
    if (typeof input?.[k] === 'string' && pattern.test(input[k])) r[k] = input[k];
  if (object(input?.counters)) {
    r.counters = {};
    for (const k of ['postedMessages', 'patternCalls', 'uiaFetches', 'captures', 'finalReads'])
      if (uint(input.counters[k])) r.counters[k] = input.counters[k];
  }
  return { ok: !error, ...r, ...windowsDiagnostics(input) };
}

export function fixtureReadFailure(stage, method, expected, observed) {
  const identity = value => Object.fromEntries(['windowId', 'pid', 'processStart', 'bindingId', 'windowGeneration', 'topologyGeneration']
    .filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
  return { proof: stage, object: method, expected: identity(expected), ...(observed && { observed: identity(observed) }) };
}

export function verifyFixtureRead(expected, observed, stage, method) {
  try { return verifyWindowIdentity(expected, observed); }
  catch (error) { error.detail = fixtureReadFailure(stage, method, expected, observed); throw error; }
}

export async function waitForGo({ readGo, check, sleep = delay, timeoutMs = 120000, clock = Date.now }) {
  const start = clock();
  while (true) {
    await check();
    if (await readGo()) return;
    if (clock() - start >= timeoutMs) fail('OWNER_GO_TIMEOUT');
    await sleep(100);
  }
}

export function hardwareReady(state, fixtures) {
  return uint(state.tickMs) && uint(state.lastInputTickMs) &&
    (state.tickMs % 0x100000000 - state.lastInputTickMs + 0x100000000) % 0x100000000 >= 500 &&
    fixtures.some(f => f.target === 'wpf' && f.pid === state.foregroundPid);
}

export async function collectRow(o, backend) {
  if (!/^[a-f0-9]{40}$/.test(o.revision ?? '')) fail('INVALID_OPTIONS');
  const row = collectorPlan([o.rowId])[0];
  row.cases = selectCases(row, o.cases, o.ownerAway ? 'away' : 'present');
  const records = [{ schema: RAW_SCHEMA, kind: 'row', rowId: row.id, revision: o.revision,
    cases: row.cases.map(c => ({ id: c.id, trials: c.trials, presence: c.presence })) }];
  const requiredPresence = row.cases.some(c => c.presence === 'present') ? 'present' : 'away';
  // person-idle is split across two sittings; their disjoint case IDs are joined
  // by the exporter. No away invocation silently attempts background-word.
  if (requiredPresence === 'present' && o.ownerAway) fail('OWNER_PRESENT_REQUIRED');
  if (requiredPresence === 'away' && !o.ownerAway) fail('OWNER_AWAY_REQUIRED');
  const check = async () => {
    if (o.signal?.aborted) fail('COLLECTION_INTERRUPTED');
    await backend.guard();
  };
  let fixtures = [], observer, resultCode, failureDetail, trials = 0, hookRemoved = false;
  try {
    await check();
    await backend.preflight();
    await backend.setup(row, { check, register: fixture => {
      windowBinding(fixture);
      if (!Number.isSafeInteger(fixture.pid) || fixture.pid < 1 || fixtures.some(f => f.windowId === fixture.windowId)) fail('FIXTURE_IDENTITY_CHANGED');
      fixtures.push(Object.freeze({ ...fixture }));
    } });
    if (!fixtures.length) fail('FIXTURE_MISSING');
    // Receipts remain registered on partial setup failure. Discovery is never
    // a source of ownership.
    fixtures.forEach(f => assertFixture(f, fixtures));
    observer = await backend.startObserver(row, { check });
    if (observer.ready !== true) fail('OBSERVER_UNPROVED');
    const request = async (driver, method, target, params = {}) => {
      await check();
      assertFixture(target, fixtures);
      const current = await backend.inspect(target);
      assertFixture(current, fixtures);
      // Forbidden targets retain their refusal metadata for the experiment;
      // other targets use the product's complete identity comparison.
      if (!target.refused) verifyFixtureRead(target, current, 'fixture-before-request', method);
      const tickMs = backend.tick();
      try {
        const binding = ACTION_METHODS.includes(method) || method === 'stuckMenuEscape'
          ? { windowId: current.windowId, processStart: current.processStart } : target.refusalOnly && params.windowId === target.coreWindowId
          ? { windowId: target.coreWindowId, processStart: target.processStart } : windowBinding(current);
        const reply = await driver.request(method, method === 'getApp' ? params : { ...params, ...binding });
        if (reply.window && !target.refused) verifyFixtureRead(current, reply.window, 'fixture-after-request', method);
        return { tickMs, replyTickMs: backend.tick(), method, requestedUnits: ['typeText', 'paste'].includes(method) ? params.args?.at(-1)?.length : undefined,
          reply, raw: projectReply({ ...reply, ...reply.window ? { windowMatched: true } : {} }) };
      } catch (e) {
        if (['IDENTITY_CHANGED', 'FIXTURE_IDENTITY_CHANGED', 'DRIVER_PROTOCOL', 'DRIVER_EXIT'].includes(e.code)) {
          e.detail ??= fixtureReadFailure('driver-request', method, current);
          e.detail.reply = projectReply(e, true);
          if (e.code === 'IDENTITY_CHANGED') {
            try {
              await check();
              const fresh = await driver.request('getApp', { selector: { windowId: current.windowId } });
              e.detail.fresh = fixtureReadFailure('fresh-admission-after-stop', 'getApp', current, fresh.window);
            } catch (freshError) { e.detail.freshCode = codeOf(freshError); }
          }
          throw e;
        }
        return { tickMs, replyTickMs: backend.tick(), method, requestedUnits: ['typeText', 'paste'].includes(method) ? params.args?.at(-1)?.length : undefined,
          raw: projectReply(e, true) };
      }
    };
    for (const c of row.cases) {
      for (let trial = 0; trial < c.trials; trial++) {
        await check();
        if (c.presence === 'present') await waitForGo({ check, readGo: () => backend.readGo(row.id, c.id, trial),
          sleep: backend.sleep, clock: backend.now });
        const startTickMs = backend.tick();
        const rebindSettings = (previous, next) => {
          const old = assertFixture(previous, fixtures);
          if (old.target !== 'terminal' || old.pid !== next.pid || old.processStart !== next.processStart || old.image !== next.image ||
              next.refused !== 'FORBIDDEN_SETTINGS') fail('FIXTURE_IDENTITY_CHANGED');
          windowBinding(next);
          const index = fixtures.indexOf(old);
          fixtures[index] = Object.freeze({ ...next, target: 'terminal' });
          return fixtures[index];
        };
        const facts = await backend.measure({ rowId: row.id, caseId: c.id, trial, fixtures, request, check, rebindSettings });
        if (facts.unmeasured && facts.unmeasured !== 'OBSERVER_JOIN_REQUIRED' &&
            !(row.id === 'checkpoint-cost' && facts.unmeasured === 'CHECKPOINT_TIMING_UNAVAILABLE')) resultCode ??= codeOf({ code: facts.unmeasured });
        await check();
        const endTickMs = backend.tick();
        records.push({ schema: RAW_SCHEMA, kind: 'trial', rowId: row.id, caseId: c.id, trial,
          startTickMs, endTickMs, ...projectTrial(facts, { startTickMs, endTickMs, caseId: c.id, rowId: row.id }) });
        trials++;
      }
    }
  } catch (e) { resultCode = codeOf(e); failureDetail = e.detail; backend.recordFileFailure?.(e.fileDiagnostic); }
  finally {
    if (observer) {
      try {
        let text, finishError;
        try { text = await observer.finish(); }
        catch (error) { text = error.observerText; finishError = error; failureDetail ??= error.detail; }
        if (text === undefined) throw finishError;
        const lines = parseGuestLines(text, 'observer');
        records.push(...lines.map(observation => ({ schema: RAW_SCHEMA, kind: 'observer', rowId: row.id, observation })));
        hookRemoved = observerRemoval(lines, { token: o.rowToken, row: row.id }, observer.invocation);
        assertObserverProof(lines, records.filter(r => r.kind === 'trial'), { token: o.rowToken, row: row.id }, observer.invocation);
        if (finishError) throw finishError;
      } catch (error) { resultCode ??= codeOf(error); }
    }
    try { await backend.closeClients(); } catch (error) { resultCode ??= codeOf(error); }
  }
  records.push({ schema: RAW_SCHEMA, kind: 'end', rowId: row.id, trials, hookRemoved, code: resultCode ?? 'RECORDED' });
  await backend.writeRaw(row.id, records);
  return { rowId: row.id, status: resultCode ? 'fail' : 'recorded', code: resultCode ?? 'RECORDED', trials, hookRemoved,
    ...(failureDetail && { failureDetail }) };
}

export function projectTrial(facts, interval) {
  if (!object(facts) || !Array.isArray(facts.driver)) fail('TRIAL_INVALID');
  const result = { driver: facts.driver.map(d => {
    if (!uint(d.tickMs) || !uint(d.replyTickMs) || d.replyTickMs < d.tickMs) fail('TRIAL_INVALID');
    if (d.method !== undefined && !['getAXState', 'getScreenshot', 'getAXStateAndScreenshot', 'typeText', 'paste', 'click', 'stuckMenuEscape', 'pressKey', 'cancel',
      ...interval.rowId === 'checkpoint-cost' ? ['turn-end'] : [], ...interval.caseId === 'calculator-refused' ? ['getApp'] : []].includes(d.method)) fail('TRIAL_INVALID');
    if (d.admissionFor !== undefined && (interval.caseId !== 'calculator-refused' || d.method !== 'getApp' ||
        !['getAXState', 'getScreenshot', 'getAXStateAndScreenshot'].includes(d.admissionFor))) fail('TRIAL_INVALID');
    return { tickMs: d.tickMs, replyTickMs: d.replyTickMs,
      ...d.admissionFor ? { admissionFor: d.admissionFor } : {},
      ...d.method ? { method: d.method } : {}, ...uint(d.requestedUnits) ? { requestedUnits: d.requestedUnits } : {},
      ...projectReply(d.raw, d.raw?.ok === false) };
  }) };
  if (facts.typingTarget !== undefined) result.typingTarget = validateTypingTarget(facts.typingTarget);
  if (facts.injector !== undefined) {
    result.injector = parseGuestLines(facts.injector, 'injector');
    if (!/^[0-9]{1,4}$/.test(facts.injectorInvocation ?? '') || result.injector.length !== 1 ||
        result.injector.some(r => r.invocation !== facts.injectorInvocation ||
          r.tickMs < interval.startTickMs || r.tickMs > interval.endTickMs)) fail('INJECTOR_UNPROVED');
  }
  if (facts.fixture !== undefined) {
    result.fixture = {};
    for (const k of ['postedMessages', 'keyUps', 'keyDowns', 'escapeDowns', 'postsAfterStop', 'tickMs', 'textLength', 'invocations'])
      if (uint(facts.fixture[k])) result.fixture[k] = facts.fixture[k];
    for (const k of ['keyUpsDelivered', 'effectObserved']) if (typeof facts.fixture[k] === 'boolean') result.fixture[k] = facts.fixture[k];
    if (facts.fixture.events !== undefined) {
      if (!Array.isArray(facts.fixture.events) || facts.fixture.events.length > 4096 || facts.fixture.events.some(e =>
        !exact(e, ['tickMs', 'message']) || !uint(e.tickMs) || ![0x100, 0x101, 0x102, 0x104, 0x105].includes(e.message))) fail('TRIAL_INVALID');
      result.fixture.events = structuredClone(facts.fixture.events);
    }
  }
  if (facts.parent !== undefined) {
    result.parent = {};
    for (const k of ['cards', 'leases', 'contentReads', 'jobId', 'cancelId', 'jobReplyId', 'cancelReplyId', 'flagMs', 'driverPid', 'resumedDriverPid'])
      if (uint(facts.parent[k])) result.parent[k] = facts.parent[k];
  }
  if (facts.pe !== undefined) result.pe = Object.fromEntries(['originalFilenamePreserved', 'productNamePreserved']
    .filter(k => typeof facts.pe[k] === 'boolean').map(k => [k, facts.pe[k]]));
  if (facts.launch !== undefined) {
    if (!['scheduled-direct', 'parent'].includes(facts.launch.source) || typeof facts.launch.override !== 'boolean') fail('TRIAL_INVALID');
    result.launch = { source: facts.launch.source, override: facts.launch.override };
    if (facts.launch.nonceSha256 !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(facts.launch.nonceSha256)) fail('TRIAL_INVALID');
      result.launch.nonceSha256 = facts.launch.nonceSha256;
    }
  }
  if (facts.unmeasured !== undefined) {
    if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(facts.unmeasured)) fail('TRIAL_INVALID');
    result.unmeasured = facts.unmeasured;
  }
  if (interval.rowId === 'checkpoint-cost') {
    result.costSamples = costSamples(interval.caseId, facts.costSamples ?? []);
    if (result.costSamples.length === 0) result.unmeasured ??= 'CHECKPOINT_TIMING_UNAVAILABLE';
  } else if (facts.costSamples !== undefined) fail('CHECKPOINT_TIMING_INVALID');
  return result;
}

export function boundInjectorSource(text, rowId, requestInvocation) {
  const prefix = rowFilePrefix(requestInvocation, rowId);
  for (const name of ['go-$Invocation', 'inject-$Invocation.jsonl']) {
    if (text.split('"' + name + '"').length !== 2) fail('INJECTOR_UNPROVED');
    text = text.replace('"' + name + '"', '"' + prefix + name + '"');
  }
  return text;
}

// The experiment is separate from transport so fakes exercise real request and
// intervention order. No expected result or row plan is used as a measurement.
export async function measureGuestTrial(context, io) {
  const { rowId, caseId, trial, fixtures, request, check } = context;
  const driver = [], facts = { driver };
  if (rowId === 'checkpoint-cost' && io.checkpointTimingProducer !== true)
    return { driver, costSamples: [], unmeasured: 'CHECKPOINT_TIMING_UNAVAILABLE' };
  let targetName = ['notepad', 'calculator-refused', 'wpf'].includes(caseId) ? caseId : 'wpf';
  if (caseId === 'background-word') targetName = 'notepad';
  if (rowId.startsWith('direct-launch')) targetName = 'terminal';
  if (rowId.startsWith('browser-refused') && !['notepad', 'calculator', 'wpf'].includes(caseId))
    targetName = rowId.endsWith('firefox') ? 'firefox' : 'edge';
  if (caseId === 'renamed' && fixtures.some(f => f.target === 'metadata-stub')) targetName = 'metadata-stub';
  let target = fixtures.find(f => f.target === targetName);
  if (!target) fail('FIXTURE_MISSING');
  const client = await io.client({ override: rowId === 'direct-launch-override' });
  // Each hardware observation needs a fresh turn. Keep the second action in
  // that turn so it still proves Escape remains latched, then reset next trial.
  if (rowId === 'escape-stop-hardware') await client.request('turn-end', {});
  const call = async (method, params = {}, selected = client) => {
    const result = await request(selected, method, target, params);
    driver.push(result);
    return result;
  };
  const action = async (method = 'typeText', units = 200) => {
    const read = await call('getAXState');
    if (!read.reply) return read;
    const editor = /(?:^|\n)\s*(\d+) (?:text entry area|text area|text field)\b/.exec(read.reply.text ?? '');
    const button = new RegExp('(?:^|\\n)\\s*(\\d+) button[^\\n]*, ID: ' +
      (rowId === 'uac-hint' ? 'UacButton' : '(?:num7Button|InvokeButton)') + '(?=,|\\r?\\n|$)').exec(read.reply.text ?? '');
    if (method === 'click' && !button || method === 'typeText' && !editor) fail('FIXTURE_ELEMENT_MISSING');
    const args = method === 'click' ? [Number(button[1])] : method === 'stuckMenuEscape' ? ['Escape'] : ['q'.repeat(units)];
    return call(method, { readId: read.reply.readId, args });
  };
  if (rowId === 'checkpoint-cost') {
    // One driving turn per trial. Every safety check stays enabled. The sample
    // is the checkpoint's own native clock, never a round trip or an on/off pair.
    let result, ended;
    try { result = await action(caseId === 'hook-install' ? 'click' : 'typeText', 1); }
    finally { ended = await call('turn-end'); }
    if (caseId === 'hook-callback') {
      const own = ended.reply?.hookOwnCallbacks;
      if (own?.samplesUs?.length) ended.reply.checkpointTimings = {
        ...ended.reply.checkpointTimings, 'hook-callback': { elapsedUs: own.samplesUs[0] },
      };
    }
    const measured = (caseId === 'hook-remove' || caseId === 'hook-callback' ? ended : result).reply?.checkpointTimings?.[caseId];
    facts.costSamples = costSamples(caseId, measured === undefined ? [] : [measured]);
    if (!facts.costSamples.length) facts.unmeasured = 'CHECKPOINT_TIMING_UNAVAILABLE';
  } else if (caseId === 'wts-query' || caseId === 'flags') {
    // The observer is the WTS/flag source, not a successful ping substitute.
    await io.sleep(caseId === 'wts-query' ? 10 : 100);
    facts.unmeasured = 'OBSERVER_JOIN_REQUIRED';
  } else if (rowId.startsWith('browser-refused')) {
    const parent = await io.parent(target, request);
    const before = parent.counts();
    const r = await parent.acquire(caseId === 'name' ? target.app : { windowId: target.windowId });
    driver.push(r);
    const after = parent.counts();
    facts.parent = Object.fromEntries(['cards', 'leases', 'contentReads'].map(k => [k, after[k] - before[k]]));
    if (caseId === 'renamed') {
      const matched = target.browserRefusal?.matchedFields;
      facts.pe = Array.isArray(matched) ? {
        originalFilenamePreserved: matched.includes('originalFilename'),
        productNamePreserved: matched.includes('productName'),
      } : io.pe();
    }
  } else if (rowId.startsWith('direct-launch')) {
    if (caseId.endsWith('settings')) {
      target = await io.settings(target);
      if (caseId.startsWith('direct')) {
        const r = await io.direct(target, rowId === 'direct-launch-override');
        driver.push(...r.driver); facts.parent = r.parent; facts.launch = r.launch;
        if (r.unmeasured) facts.unmeasured = r.unmeasured;
      } else {
        const parent = await io.parent(target, request, rowId === 'direct-launch-override');
        driver.push(await parent.acquire({ windowId: target.windowId })); facts.parent = parent.counts();
        facts.launch = { source: 'parent', override: rowId === 'direct-launch-override' };
      }
    } else if (caseId.startsWith('direct')) {
      const r = await io.direct(target, rowId === 'direct-launch-override');
      driver.push(...r.driver); facts.parent = r.parent; facts.launch = r.launch;
      if (r.unmeasured) facts.unmeasured = r.unmeasured;
    } else {
      const parent = await io.parent(target, request, rowId === 'direct-launch-override');
      const r = await parent.acquire({ windowId: target.windowId });
      driver.push(r); facts.parent = parent.counts();
      facts.launch = { source: 'parent', override: rowId === 'direct-launch-override' };
    }
  } else if (caseId === 'calculator-refused') {
    await requireCalculatorRefusals(target, async (method, params, admissionFor) => {
      const result = await call(method, params);
      if (admissionFor) result.admissionFor = admissionFor;
      if (result.raw.ok === false) throw Object.assign(Error(result.raw.code), { code: result.raw.code });
    });
  } else if (rowId === 'person-idle' || caseId === 'unlocked-action' || caseId === 'idle-action') {
    const before = await call('getAXState');
    await action(targetName === 'calculator' ? 'click' : 'typeText');
    const after = await call('getAXState');
    facts.fixture = { effectObserved: typeof before.reply?.text === 'string' && typeof after.reply?.text === 'string' &&
      before.reply.text !== after.reply.text };
  } else if (caseId === 'idle-probe') await call('getAXState');
  else if (rowId === 'person-key-before') {
    const read = await call('getAXState');
    if (!read.reply) return facts;
    const editor = /(?:^|\n)\s*(\d+) (?:text entry area|text area|text field)\b/.exec(read.reply.text ?? '');
    if (!editor) fail('FIXTURE_ELEMENT_MISSING');
    const injection = await io.arm('key', target, { key: 'q', leadMs: 0 });
    await check(); await injection.go();
    facts.injector = await injection.finish(); facts.injectorInvocation = injection.invocation;
    await io.sleep(100);
    await call('typeText', { readId: read.reply.readId, args: ['q'.repeat(200)] });
  } else if (rowId === 'person-key-during' || rowId === 'lock-during-type' || rowId === 'escape-ignored-injected') {
    const operation = rowId === 'lock-during-type' ? 'lock' : 'key';
    const injection = await io.arm(operation, target, { key: rowId === 'escape-ignored-injected' ? 'escape' : 'q', leadMs: 100 });
    // Start the pump before releasing the already registered injector.
    const work = action('typeText', 3000);
    await check(); await injection.go();
    await work; facts.injector = await injection.finish(); facts.injectorInvocation = injection.invocation;
    if (operation === 'lock') {
      const recovery = await io.recover(target, trial);
      if (recovery?.reply) driver.push(recovery.reply);
      if (recovery?.parent) facts.parent = recovery.parent;
    }
  } else if (rowId === 'lock-refused' || rowId === 'screensaver-refused' || rowId === 'session-switch-refused') {
    let actionParams;
    if (caseId === 'action') {
      const read = await call('getAXState');
      if (!read.reply) return facts;
      const editor = /(?:^|\n)\s*(\d+) (?:text entry area|text area|text field)\b/.exec(read.reply.text ?? '');
      if (!editor) fail('FIXTURE_ELEMENT_MISSING');
      actionParams = { readId: read.reply.readId, args: ['q'] };
    }
    const operation = rowId === 'lock-refused' ? 'lock' : rowId === 'screensaver-refused' ? 'screensaver' : 'session-switch';
    const injection = await io.arm(operation, target, { leadMs: 0 });
    await check(); await injection.go(); facts.injector = await injection.finish(); facts.injectorInvocation = injection.invocation;
    await call(caseId === 'capture' ? 'getScreenshot' : caseId === 'action' ? 'typeText' : 'getAXState',
      actionParams ?? {});
    const recovery = await io.recover(target, trial);
    if (recovery?.reply) driver.push(recovery.reply);
    if (recovery?.parent) facts.parent = recovery.parent;
  } else if (rowId === 'uac-refused' || rowId === 'uac-hint') {
    await io.requireDefaultDesktop();
    if (rowId === 'uac-refused') {
      await io.raisePrompt(target);
      await call('getAXState');
    } else await action('click');
    const recovery = await io.recover(target, trial);
    if (recovery?.reply) driver.push(recovery.reply);
    if (recovery?.parent) facts.parent = recovery.parent;
  } else if (rowId === 'escape-stop-hardware') {
    await action('typeText', 4000);
    await action('typeText', 1);
  } else if (rowId === 'escape-ignored-posted') await action('stuckMenuEscape');
  else if (rowId === 'cancel-frame') {
    const read = await call('getAXState');
    if (!read.reply) return facts;
    const cancelled = await io.cancel({ client, target, readId: read.reply.readId, order: caseId });
    driver.push(...cancelled.driver); facts.parent = cancelled.parent;
    if (cancelled.unmeasured) facts.unmeasured = cancelled.unmeasured;
  } else fail('UNKNOWN_SAFETY_ROW');
  facts.unmeasured ??= readTelemetryFailure(driver);
  return facts;
}

export function assertVmIdentity(current, pinned) {
  const keys = ['manufacturer', 'model', 'hostnameSha256', 'machineGuidSha256', ...pinned?.vmId ? ['vmId', 'build'] : []];
  if (!exact(current, keys) || !object(pinned) || current.manufacturer !== 'QEMU' ||
      !current.model || !['hostnameSha256', 'machineGuidSha256'].every(k => /^[a-f0-9]{64}$/.test(current[k])) ||
      keys.some(k => current[k] !== pinned[k])) fail('VM_IDENTITY_MISMATCH');
}

// Tap the native envelope before the product client formats an error, retaining
// counters and reason/typed fields that older parent clients do not expose.
export function instrumentedClient({ override = false, checkpointTimings = false, directSpawn = spawn, prepare = prepareWindowsHandHost,
  createClient = createWindowsDriverClient, onRequest = () => {}, tick = () => Math.floor(uptime() * 1000), check, beforeInput } = {}) {
  let pending = '', nativeChild;
  const calls = [], byId = new Map(), wire = [];
  const run = (command, args, options) => {
    if (!args.includes('--driver')) return directSpawn(command, args, options);
    const child = directSpawn(command, args, { ...options, env: { ...options.env, SLEIGHT_DRIVER_COUNTERS: '1',
      ...override ? { SLEIGHT_ALLOW_FORBIDDEN_TARGETS: '1' } : {} } });
    nativeChild = child;
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (bytes, ...rest) => {
      try {
        const frame = JSON.parse(String(bytes));
        const call = calls.find(c => c.id === undefined && c.method === frame.method);
        if (call) {
          call.id = frame.id; call.tickMs = tick(); byId.set(frame.id, call);
          wire.push({ kind: 'sent', id: frame.id, method: frame.method, tickMs: call.tickMs });
        }
      } catch { /* Only metadata from complete product frames is retained. */ }
      return write(bytes, ...rest);
    };
    child.stdout.on('data', bytes => {
      pending += bytes.toString('utf8');
      if (Buffer.byteLength(pending) > 4 * 1024 * 1024) { pending = ''; return; }
      for (let at; (at = pending.indexOf('\n')) >= 0;) {
        const line = pending.slice(0, at); pending = pending.slice(at + 1);
        try {
          const envelope = JSON.parse(line);
          const call = byId.get(envelope.id);
          if (call && typeof envelope.ok === 'boolean') {
            call.raw = envelope.ok ? projectReply(envelope.result) : projectReply(envelope.error, true);
            call.replyTickMs = tick();
            wire.push({ kind: 'reply', id: envelope.id, method: call.method, tickMs: call.replyTickMs });
          }
        } catch { /* The product parser owns malformed envelope handling. */ }
      }
    });
    return child;
  };
  const client = createClient({ platform: 'win32', checkpointTimings, prepare: options => prepare({ ...options, run }) });
  return {
    get pid() { return nativeChild?.pid; },
    frames: () => structuredClone(wire),
    async request(method, params) {
      if (ACTION_METHODS.includes(method) || method === 'stuckMenuEscape') await beforeInput?.(params);
      await check?.();
      const call = { method }; calls.push(call); onRequest(method);
      let finished = false, checking = false, stopReason, stopping;
      const watcher = check && setInterval(async () => {
        if (finished || checking || stopReason) return;
        checking = true;
        try { await check(); }
        catch (e) {
          if (finished) return;
          stopReason = Object.assign(Error(codeOf(e)), { code: codeOf(e) });
          // The native cancel has its own 1 s deadline and the product client's
          // retirement path. No request is replayed after a stopped row.
          stopping = call.id === undefined ? Promise.resolve() : client.request('cancel', { id: call.id }, { timeoutMs: 1000 }).catch(() => {});
          stopping.catch(() => {});
        } finally { checking = false; }
      }, 100);
      try {
        const result = await (method === 'turn-end' ? client.endWindowsTurn() : client.request(method, params));
        if (stopReason) throw stopReason;
        return { ...result, ...call.raw && Object.fromEntries(Object.entries(call.raw).filter(([k]) => k !== 'ok')) };
      } catch (e) {
        if (stopReason) throw stopReason;
        // The raw tap never replaces a transport failure with a native success.
        if (call.raw?.ok === false && call.raw.code === e.code) Object.assign(e, Object.fromEntries(Object.entries(call.raw).filter(([k]) => k !== 'ok')));
        throw e;
      } finally {
        finished = true; clearInterval(watcher);
        if (stopping) await stopping;
        const at = calls.indexOf(call); if (at >= 0) calls.splice(at, 1); if (call.id !== undefined) byId.delete(call.id);
      }
    },
    // Guest lifetime belongs to the VM restore, including failed requests.
    close: async () => {},
  };
}

export async function runCancelTrial({ client, target, readId, order, tick, now, sleep, check, waitForInput }) {
  if (!['cancel-first', 'job-first'].includes(order) || typeof client.frames !== 'function') fail('CANCEL_TRANSPORT_UNAVAILABLE');
  const before = client.frames().length, jobStart = tick();
  let jobFinished = false;
  const job = client.request('typeText', { windowId: target.windowId, processStart: target.processStart, readId, args: ['q'.repeat(3000)] })
    .then(r => projectReply(r), e => projectReply(e, true)).finally(() => { jobFinished = true; });
  const deadline = now() + 5000;
  let sent;
  while (now() < deadline) {
    await check();
    sent = client.frames().slice(before).find(f => f.kind === 'sent' && f.method === 'typeText');
    if (sent) break;
    await sleep(1);
  }
  if (!sent) { await job; fail('CANCEL_JOB_ID_UNPROVED'); }
  // A written frame is not a running pump. The guest waits for a receiver event;
  // callers without that observer retain the bounded lead used by older kits.
  let leadFailure;
  try {
    if (waitForInput) { await waitForInput({ sent, finished: () => jobFinished }); await check(); }
    else { await sleep(100); await check(); }
  }
  catch (error) { leadFailure = error; }
  const cancelStart = tick();
  // Requests are written while the job runs. Promise await order is not claimed
  // as wire reply order; the native trace records whichever order occurred.
  const cancel = client.request('cancel', { id: sent.id }).then(r => projectReply(r), e => projectReply(e, true));
  const [jobRaw, cancelRaw] = await Promise.all([job, cancel]);
  if (leadFailure) {
    leadFailure.detail = { ...leadFailure.detail, job: jobRaw.code, cancel: cancelRaw.code, typed: jobRaw.typed };
    throw leadFailure;
  }
  const trace = client.frames().slice(before), jobReply = trace.find(f => f.kind === 'reply' && f.id === sent.id);
  const cancelSent = trace.find(f => f.kind === 'sent' && f.method === 'cancel');
  const cancelReply = trace.find(f => f.kind === 'reply' && f.id === cancelSent?.id);
  if (!jobReply || !cancelSent || !cancelReply) fail('CANCEL_REPLY_UNPROVED');
  const observedOrder = trace.indexOf(cancelReply) < trace.indexOf(jobReply) ? 'cancel-first' : 'job-first';
  return { driver: [{ method: 'typeText', requestedUnits: 3000, tickMs: jobStart, replyTickMs: jobReply.tickMs, raw: jobRaw },
    { method: 'cancel', tickMs: cancelStart, replyTickMs: cancelReply.tickMs, raw: cancelRaw }],
  parent: { jobId: sent.id, jobReplyId: jobReply.id, cancelId: cancelSent.id, cancelReplyId: cancelReply.id,
    flagMs: cancelReply.tickMs - cancelSent.tickMs },
  // inputLeadMs is the observed frame-send to cancel-send interval, including
  // receiver preparation. Cross-process tick comparability is assumed.
  orderEvidence: { requested: order, observed: observedOrder, inputLeadMs: cancelSent.tickMs - sent.tickMs,
    tickClockAssumption: 'Node os.uptime() and guest GetTickCount64 are comparable; unmeasured', frames: trace.filter(f =>
    [sent.id, cancelSent.id].includes(f.id)).map(({ kind, method, id, tickMs }) => ({ kind, method, id, tickMs })) },
  ...observedOrder !== order ? { unmeasured: 'REPLY_ORDER_NOT_OBSERVED' } : {} };
}

// Keep Win32 identity checks warm. Starting PowerShell for each action would
// move a nominal 100 ms injected-key lead outside UC3E's 50 to 150 ms band.
export function fixtureTargets(row) {
  if (row.id === 'browser-refused-renamed') return ['metadata-stub', 'neutral-stub'];
  return row.id.startsWith('direct-launch') ? ['terminal'] : row.id.startsWith('browser-refused') ?
    [row.id.endsWith('firefox') ? 'firefox' : 'edge', ...row.id.endsWith('edge') ? ['notepad', 'wpf'] : []] :
    row.id === 'person-idle' ? row.cases.some(c => c.id === 'wpf') ? ['notepad', 'wpf', 'calculator-refused'] : ['notepad', 'wpf'] : ['wpf'];
}

export function validateTypingTarget(value) {
  if (!exact(value, ['kind', 'pid', 'windowId', 'fixturePid', 'fixtureWindowId', 'tickMs', 'lastInputTickMs']) ||
      !['word', 'wpf'].includes(value.kind) || ![value.pid, value.fixturePid, value.tickMs, value.lastInputTickMs].every(uint) ||
      value.pid < 1 || value.fixturePid < 1 || value.pid === value.fixturePid ||
      ![value.windowId, value.fixtureWindowId].every(id => typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id)) ||
      value.windowId === value.fixtureWindowId || value.lastInputTickMs >= 0x100000000 ||
      (value.tickMs % 0x100000000 - value.lastInputTickMs + 0x100000000) % 0x100000000 > 2000) fail('TYPING_TARGET_UNPROVED');
  return { ...value };
}

export function backgroundTypingReady(state, fixtures, previousTick) {
  const fixture = fixtures.find(f => f.target === 'notepad');
  if (!fixture || state.unlocked !== true || state.connected !== true || !uint(state.lastInputTickMs) ||
      state.lastInputTickMs === previousTick || state.foregroundPid === fixture.pid || state.foregroundWindowId === fixture.windowId) return;
  const receiver = fixtures.find(f => f.target === 'wpf' && f.pid === state.foregroundPid && f.windowId === state.foregroundWindowId &&
    f.processStart === state.foregroundProcessStart && f.image === state.foregroundImage);
  const kind = state.word === true ? 'word' : receiver ? 'wpf' : undefined;
  if (!kind) return;
  try { return validateTypingTarget({ kind, pid: state.foregroundPid, windowId: state.foregroundWindowId,
    fixturePid: fixture.pid, fixtureWindowId: fixture.windowId, tickMs: state.tickMs, lastInputTickMs: state.lastInputTickMs }); }
  catch { return; }
}

export function createGuestBackend(o, { platform = process.platform, execute = runChild, now = Date.now,
  tick = () => Math.floor(uptime() * 1000), sleep = delay, prepare = prepareWindowsHandHost,
  createClient = createWindowsDriverClient, directSpawn, createRepl = createWindowsReplClient, validateBank = checkBank,
  root = ROOT, guestCall, makeInspector = createGuestInspector, assertStandardUser = sitting.assertStandardUser,
  notepadPreflight = preflightNotepad } = {}) {
  // This check precedes even a bank read or host prepare call.
  if (platform !== 'win32') fail('WINDOWS_REQUIRED');
  if (!Array.isArray(o.rows) || o.rows.length !== 1 || !/^[a-f0-9]{40}$/.test(o.revision ?? '')) fail('INVALID_OPTIONS');
  collectorPlan(o.rows);
  validateBank(o.bank);
  const rawDir = join(o.bank, 'raw');
  if (!existsSync(rawDir)) mkdirSync(rawDir, { mode: 0o700 });
  ordinary(rawDir, true);
  const rawSuffix = o.rows[0] === 'person-idle' ? o.ownerAway ? '-away' : '-present' : '';
  const prefix = o.transportInvocation ? rowFilePrefix(o.transportInvocation, o.rows[0]) : '';
  const rawPath = join(rawDir, `${prefix}${o.rows[0]}${rawSuffix}.jsonl`);
  if (existsSync(rawPath)) fail('INVALID_OPTIONS');
  const ps = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const env = sitting.collectorWindowsEnv(process.env), token = win32.basename(o.bank);
  let invocation = 0, pe, observerPending, promptPending, inspector;
  let edgeMetadata, metadataWindow, neutralWindow;
  const launched = [], registered = [], clients = new Map(), repls = [], reads = new Map(), ownedFiles = new Set();
  const writeOwned = (name, bytes) => {
    const path = join(o.bank, name);
    if (name.endsWith('.ps1')) bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(bytes)]);
    writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
    ownedFiles.add(name);
    return path;
  };
  const writeEvidence = (name, value) => {
    const path = join(rawDir, `${prefix}${name}`);
    writeFileSync(path, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    return path;
  };
  const fileFailures = fileFailureRecorder(writeEvidence), recordFileFailure = fileFailures.record;
  const readPublished = (path, check, limit, retries) => readPublishedFile(path, { check, sleep, limit, retries, audit: recordFileFailure });
  const guard = async () => { validateBank(o.bank); };
  const invokeGuest = guestCall ?? powershellCall(o, { execute, validateBank });
  const psCall = async (operation, values) => {
    try {
      const result = await invokeGuest(operation, values);
      o.selftestOperations?.push({ operation: `guest-${operation}`, status: 'pass', code: 'OK' });
      return result;
    } catch (error) {
      o.selftestOperations?.push({ operation: `guest-${operation}`, status: 'fail', code: codeOf(error) });
      throw error;
    }
  };
  const client = async ({ override = false } = {}) => {
    const key = override ? 'override' : 'standard';
    if (!clients.has(key)) clients.set(key, instrumentedClient({ override, checkpointTimings: o.rows[0] === 'checkpoint-cost', prepare, createClient, directSpawn, tick, check: async () => {
      if (o.signal?.aborted) fail('COLLECTION_INTERRUPTED');
      await guard();
    }, beforeInput: async params => {
      await o.beforeInput?.();
      await guard();
      const fixture = launched.find(f => f.pid === params?.pid && f.windowId === params?.windowId);
      if (fixture) await inspect(fixture);
    } }));
    return clients.get(key);
  };
  const inspect = async f => {
    inspector ??= makeInspector({ ...o, executable: ps, env, writeOwned });
    const native = await inspector.inspect(f);
    if (native.processStart !== f.processStart) fail('FIXTURE_IDENTITY_CHANGED');
    if (native.pid !== f.pid || native.image !== f.image) fail('FIXTURE_IDENTITY_CHANGED');
    if (native.className !== f.className) fail('FIXTURE_IDENTITY_CHANGED');
    if (String(native.title).replace(/^\*/, '') !== String(f.title).replace(/^\*/, '')) fail('FIXTURE_IDENTITY_CHANGED');
    // The product verifies HWND and all remaining identity fields at the read
    // boundary. Native PID/start is checked even while getState is locked out.
    return { ...f, ...native };
  };
  const goTicks = new Map(), typingTargets = new Map();
  const readGo = async (rowId, caseId, trial) => {
    const path = join(o.bank, `${prefix}owner-go-${rowId}-${caseId}-${trial}`);
    if (existsSync(path)) fail('OWNER_GO_TIMEOUT');
    // G7 obtains the owner's go for the entire row. These files record guest
    // readiness, not another approval or evidence that a trial passed.
    const before = tick(), state = await psCall('readiness'), after = tick();
    assertClockSample(before, state.tickMs, after);
    if (state.unlocked !== true || state.connected !== true) return false;
    if (caseId === 'background-word') {
      let target = backgroundTypingReady(state, registered, goTicks.get(caseId));
      if (!target) return false;
      if (target.kind === 'wpf') await inspect(registered.find(f => f.target === 'wpf' && f.pid === target.pid));
      target = backgroundTypingReady({ ...state, tickMs: tick() }, registered, goTicks.get(caseId));
      if (!target) return false;
      typingTargets.set(trial, target);
    }
    if (caseId === 'hardware' && !hardwareReady(state, registered)) return false;
    goTicks.set(caseId, state.lastInputTickMs);
    writeFileSync(path, JSON.stringify({ bank: token, rowId, caseId, trial, go: true, observedTickMs: state.tickMs }), { flag: 'wx', mode: 0o600 });
    return true;
  };
  const backend = {
    now, tick, sleep, guard, inspect, readGo,
    async typingDiagnostic(fixture) {
      await inspect(fixture);
      const value = await psCall('typing-diagnostic', { fixture });
      const c = await client();
      await c.request('getApp', { selector: { windowId: fixture.windowId } });
      const read = await c.request('getAXState', windowBinding(fixture));
      value.driver = typingReadMetadata(read);
      writeEvidence(`typing-diagnostic-${fixture.target}.json`, value);
      return value;
    },
    readiness: () => psCall('readiness'),
    desktop: () => psCall('desktop'),
    available: target => psCall('available', { target }),
    async selftestInjector(fixture, { check }) {
      await check(); await inspect(fixture);
      const id = String(++invocation);
      // No go file is created. The production worker compiles,
      // opens its log, then exits at the bounded go wait before its input call.
      writeOwned('bound-injector.ps1', boundInjectorSource(readOrdinary(join(root, 'bench/windows/uc3f-inject.ps1'), 256 * 1024), o.rows[0], o.transportInvocation));
      const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File',
        join(o.bank, 'bound-injector.ps1'), '-Bank', o.bank, '-Invocation', id, '-Presence', 'away', '-Operation', 'key',
        '-FixturePid', String(fixture.pid), '-FixtureStart', fixture.processStart, '-WaitMs', '100'];
      await psCall('register-injector', { invocation: id, arguments: args.map(s => '"' + s.replaceAll('"', '') + '"').join(' ') });
      const path = join(o.bank, `${prefix}inject-${id}.jsonl`), end = now() + 30000;
      while (now() < end) {
        await check();
        if (existsSync(path) && readOrdinary(path).trim()) {
          const lines = parseGuestLines(readOrdinary(path), 'injector');
          if (lines.length !== 1 || lines[0].invocation !== id || lines[0].code !== 'GO_TIMEOUT' || lines[0].sentInputs !== 0) fail('INJECTOR_UNPROVED');
          return { code: 'GO_TIMEOUT', sentInputs: 0 };
        }
        await sleep(100);
      }
      fail('INJECTOR_TIMEOUT');
    },
    async preflight() {
      await assertStandardUser({ execute, env });
      const before = tick(), current = await psCall('preflight'), after = tick();
      assertClockSample(before, current.tickMs, after);
      const { tickMs: _clock, ...identity } = current;
      const pinned = o.expected ?? JSON.parse(readOrdinary(join(o.bank, 'vm-identity.json')));
      assertVmIdentity(identity, pinned);
      if (o.expected) {
        const identityPath = join(o.bank, 'vm-identity.json');
        if (existsSync(identityPath)) {
          const { sessionId: _session, elevated: _elevated, ...saved } = JSON.parse(readOrdinary(identityPath));
          assertVmIdentity(identity, saved);
        }
        else writeFileSync(identityPath, JSON.stringify(o.expected), { flag: 'wx', mode: 0o600 });
      }
      const manifest = JSON.parse(readOrdinary(join(root, 'guest-manifest.json'), 1024 * 1024));
      if (manifest.commit !== o.revision) fail('KIT_REVISION_MISMATCH');
      for (const path of ['bench/windows/uc3f-collect.mjs', 'bench/windows/uc3f-fixtures.mjs', 'bench/windows/uc3f-observer.ps1', 'bench/windows/uc3f-inject.ps1']) {
        const entry = manifest.files?.find(f => f.path === path);
        if (!entry || digest(readOrdinary(join(root, path), 256 * 1024)) !== entry.sha256) fail('KIT_HASH_MISMATCH');
      }
    },
    async setup(row, { check, register }) {
      const targets = o.selftestTarget ? [o.selftestTarget] : fixtureTargets(row);
      const typingTarget = row.id === 'person-idle' && row.cases.some(c => c.id === 'background-word');
      if (targets.includes('notepad')) {
        let auditIndex = 0;
        await notepadPreflight({ call: psCall, check,
          audit: receipt => writeEvidence(`notepad-state-${++auditIndex}.json`, receipt),
        });
      }
      if (targets.includes('wpf')) {
        const name = typingTarget ? 'typing-receiver' : 'receiver';
        writeOwned(name + '.ps1', guestFixtureSource({ ...o, typingTarget }));
        writeOwned(typingTarget ? 'typing-fixture-launcher.cs' : 'fixture-launcher.cs', typingTarget ?
          FIXTURE_LAUNCHER.replaceAll('receiver.ps1', 'typing-receiver.ps1').replaceAll('receiver-startup.json', 'typing-receiver-startup.json') : FIXTURE_LAUNCHER);
        await psCall('compile-fixture', { typingTarget });
        ownedFiles.add(name + '.exe');
      }
      const notepadFile = `driver-notepad.txt-${token}.txt`, browserFile = `browser-${token}.html`;
      if (targets.includes('notepad')) writeOwned(notepadFile, 'UC3F');
      if (targets.some(t => ['edge', 'firefox'].includes(t))) writeOwned(browserFile, `<title>${token}</title><p>UC3F</p>`);
      if (targets.includes('metadata-stub')) {
        edgeMetadata = await psCall('edge-metadata');
        assertVersionCopied(edgeMetadata, edgeMetadata);
        writeEvidence('edge-metadata.json', edgeMetadata);
        writeOwned('uc3f-browser-stub.cs', STUB_SOURCE);
        for (const [name, fields] of [['uc3f-metadata-stub', edgeMetadata], ['uc3f-neutral-stub', NEUTRAL_VERSION]]) {
          writeOwned(name + '.res', versionResource(fields));
          const built = await psCall('compile-stub', { stub: name });
          ownedFiles.add(name + '.exe');
          assertVersionCopied(fields, await psCall('stub-metadata', { stub: name }));

        }
      }
      for (const target of targets) {
        await check();
        const args = target === 'cover' ? sitting.fixtureArguments('cover').map(arg =>
          arg === 'bench/windows/fixtures/driver-wpf.ps1' ? win32.join(root, arg) : arg) : target === 'wpf' ? [o.bank] : target === 'edge' ?
          [`--user-data-dir=${win32.join(o.bank, 'edge-profile')}`, '--no-first-run', '--no-default-browser-check', '--inprivate', '--new-window', `file:///${win32.join(o.bank, browserFile).replaceAll('\\', '/')}`] :
          target === 'firefox' ? ['-no-remote', '-profile', win32.join(o.bank, 'firefox-profile'), `file:///${win32.join(o.bank, browserFile).replaceAll('\\', '/')}`] :
          target === 'notepad' ? [win32.join(o.bank, notepadFile)] : target === 'terminal' ? ['--window', 'new', 'new-tab', '--title', token, '--suppressApplicationTitle'] : [];
        if (target === 'firefox') mkdirSync(join(o.bank, 'firefox-profile'), { mode: 0o700 });
        const proof = await recordSetup(() => psCall('launch', { target, args, typingTarget: target === 'wpf' && typingTarget }), writeEvidence,
          `launch-${target}.json`, (r, error) => error ? projectReply(r, true) : r);
        const receipt = proveFixtureLaunch(proof, { target, token });
        launched.push(receipt);
        if (target === 'calculator-refused') {
          const c = await client();
          let attempt = 0;
          await requireCalculatorRefusals(receipt, (method, params, admissionFor) => recordSetup(() => c.request(method, params),
            (name, reply) => writeEvidence(name, { method, selector: params.selector, admissionFor, ...reply }),
            `discovery-${target}-${++attempt}.json`, projectReply), { identityRetries: 3, sleep });
          const fixture = { ...receipt, target, refusalObserved: true };
          registered.push(fixture); register(fixture);

          continue;
        }
        const end = now() + 15000;
        let found, bindingAttempt = 0;
        while (now() < end) {
          await check();
          const c = await client();
          const state = await recordSetup(() => c.request('getState', {}), writeEvidence,
            `discovery-${target}-${bindingAttempt + 1}.json`, (r, error) => ({ ...projectReply(r, error),
              ...Array.isArray(r?.windows) ? { windows: discoveryWindows(r.windows.filter(w => w.pid === receipt.pid && w.processStart === receipt.processStart)) } : {} }));
          // Retain only this launch's metadata, beside its native receipt.
          // No UIA read, document content or unrelated window title is stored.
          const matching = state.windows?.filter(w => w.pid === proof.launcher.pid || proof.windows?.some(p => p.pid === w.pid)) ?? [];
          writeEvidence(`binding-${target}-${++bindingAttempt}.json`, { windows: discoveryWindows(matching) });
          const candidates = state.windows?.filter(w => w.pid === receipt.pid && w.processStart === receipt.processStart);
          if (candidates?.length === 1 && candidates[0].windowId === receipt.windowId) { found = candidates[0]; break; }
          await sleep(100);
        }
        if (!found) fail('FIXTURE_LAUNCH_UNPROVED');
        if (['cover', 'terminal'].includes(target) && found.refused === 'FORBIDDEN_TARGET') {
          const native = await psCall('inspect', { fixture: receipt });
          const fixture = bindRefusedFixture(receipt, found, native, target);
          const c = await client();
          try { await c.request('getApp', { selector: { windowId: receipt.windowId } }); fail('FIXTURE_IDENTITY_CHANGED'); }
          catch (error) { if (error.code !== 'FORBIDDEN_TARGET') throw error; }
          fixture.refusalObserved = true;
          registered.push(fixture); register(fixture);

          continue;
        }
        if (found.image !== receipt.image || found.title !== receipt.title) fail('FIXTURE_IDENTITY_CHANGED');
        if (receipt.activation && found.aumid !== receipt.activation.aumid) fail('FIXTURE_IDENTITY_CHANGED');
        if (receipt.coreWindowId && ['coreWindowId', 'framePid', 'frameProcessStart', 'className'].some(k => found[k] !== receipt[k]))
          fail('FIXTURE_IDENTITY_CHANGED');
        // Reuse the sitting's discovery for recognized fixture apps. Browser
        // rows intentionally have no fixture-page title and use launch identity.
        const discovered = sitting.discoverTargets({ windows: [found] });
        if (['notepad', 'calculator', 'cover'].includes(target) && !discovered.some(d => d.target === target)) fail('FIXTURE_LAUNCH_UNPROVED');
        if (target === 'wpf' && (win32.basename(found.image) !== (typingTarget ? 'typing-receiver.exe' : 'receiver.exe') || found.title !== 'Sleight WDR7 WPF')) fail('FIXTURE_LAUNCH_UNPROVED');
        if ((target === 'metadata-stub' || target === 'neutral-stub') && (win32.basename(found.image) !== (target === 'metadata-stub' ? METADATA_STUB : NEUTRAL_STUB) ||
            found.title !== STUB_TITLE || found.className !== STUB_CLASS)) fail('FIXTURE_LAUNCH_UNPROVED');
        if (target === 'metadata-stub') metadataWindow = found;
        if (target === 'neutral-stub') neutralWindow = found;
        const fixture = { ...receipt, ...found, target };
        registered.push(fixture); register(fixture);

      }
      if (targets.includes('metadata-stub')) {
        const verdict = await qualifyRenamedStubs({ metadataWindow, neutralWindow, source: edgeMetadata, launched: true, driver: await client() });
        const metadataFixture = registered.find(f => f.target === 'metadata-stub');
        if (metadataFixture) metadataFixture.browserRefusal = verdict.metadata;

        writeEvidence('stub-refusal.json', {
          code: verdict.metadata.code, matchedFields: verdict.metadata.matchedFields,
          neutralCode: verdict.neutral.code, product: verdict.product, source: edgeMetadata,
        });
        return { matchedFields: verdict.metadata.matchedFields, browserRefusal: verdict.product.metadata };
      }
    },
    async startObserver(row, { check }) {
      await check();
      const id = String(++invocation);
      if (!o.transportInvocation) fail('OBSERVER_UNPROVED');
      const budget = { seconds: 900, timeout: 910000 };
      const requestStop = () => requestObserverStop(o.bank, o.transportInvocation, id, { token: o.rowToken, row: row.id });
      let ready, stopObserver = async () => {};
      const readyPromise = new Promise(resolveReady => { ready = resolveReady; });

      observerPending = runObserver(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        join(root, 'bench/windows/uc3f-observer.ps1'), '-Bank', o.bank, '-Invocation', id, '-Seconds', String(budget.seconds), '-RequestInvocation', o.transportInvocation],
      { cwd: o.bank, env, timeout: budget.timeout, maxBytes: 16 * 1024 * 1024, normalPriority: true,
        onStderr: s => { if (s.includes('SLEIGHT_UC3F_OBSERVER_READY')) ready(true); } }, { execute, check, requestStop, registerStop: stop => { stopObserver = stop; } });
      observerPending.then(() => ready(false), () => ready(false));
      let readyTimer;
      const didStart = await Promise.race([readyPromise, new Promise(done => { readyTimer = setTimeout(() => done(false), 15000); })]);
      clearTimeout(readyTimer);
      // Even a missed ready line returns the handle so finally awaits removal.
      return { ready: didStart, invocation: id, finish: async () => {
        let stopError, r;
        try { await stopObserver(); } catch (error) { stopError = error; }
        try { r = await observerPending; } catch (error) { r = { status: 1, error }; }
        const path = join(o.bank, `${prefix}observer-${id}.jsonl`);
        if (!existsSync(path)) fail('OBSERVER_UNPROVED');
        const text = await readPublished(path, check, 8 * 1024 * 1024);
        return observerResult(r, text, stopError);
      } };
    },
    async measure(context) {
      const io = {
        client, sleep, pe: () => pe, retainedReadId: target => reads.get(target.windowId),
        async arm(operation, fixture, { key = 'q', leadMs = 100 }) {
          await context.check();
          await inspect(fixture);
          if (++invocation > 9999) fail('INVOCATION_LIMIT');
          const id = String(invocation);
          if (!ownedFiles.has('bound-injector.ps1')) writeOwned('bound-injector.ps1',
            boundInjectorSource(readOrdinary(join(root, 'bench/windows/uc3f-inject.ps1'), 256 * 1024), o.rows[0], o.transportInvocation));
          const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
            join(o.bank, 'bound-injector.ps1'), '-Bank', o.bank, '-Invocation', id,
            '-Presence', o.ownerAway ? 'away' : 'present', '-Operation', operation, '-FixturePid', String(fixture.pid), '-FixtureStart', fixture.processStart,
            '-LeadMs', String(leadMs), '-WaitMs', '30000', ...operation === 'key' ? ['-Key', key] : []];
          // All task arguments are generated fixed words or validated bank and
          // decimal identities. No caller-supplied command reaches the task.
          const argumentsText = args.map(s => '"' + s.replaceAll('"', '') + '"').join(' ');
          await psCall('register-injector', { invocation: id, arguments: argumentsText });
          return {
            invocation: id,
            async go() {
              await o.beforeInput?.();
              await context.check();
              await inspect(fixture);
              await requireFixtureForeground(() => psCall('foreground'),
                value => writeEvidence(`foreground-${id}.json`, value), fixture);
              writeFileSync(join(o.bank, `${prefix}go-${id}`), '', { flag: 'wx', mode: 0o600 });
            },
            async finish() {
              const path = join(o.bank, `${prefix}inject-${id}.jsonl`), deadline = now() + 35000;
              while (now() < deadline) {
                await context.check();
                if (existsSync(path)) {
                  const text = await readPublished(path, context.check);
                  if (text.trim()) {
                    const line = parseGuestLines(text, 'injector');
                    if (line.length !== 1 || line[0].invocation !== id) fail('INJECTOR_UNPROVED');
                    if (line[0].code !== 'OK') fail(line[0].code);
                    return text;
                  }
                }
                await sleep(10);
              }
              fail('INJECTOR_TIMEOUT');
            },
          };
        },
        async recover(target, trial) {
          const c = await client(), driverPid = c.pid;
          await waitForGo({ check: context.check, readGo: () => readGo(context.rowId, `recovered-${context.caseId}`, trial), sleep, clock: now });
          // The person restores the session. The collector never supplies input.
          const reply = await context.request(c, 'getAXState', target);
          if (!reply.raw.ok) fail('OWNER_RECOVERY_UNPROVED');
          if (promptPending) { await promptPending; promptPending = undefined; }
          return { reply, parent: { driverPid, resumedDriverPid: c.pid } };
        },
        async parent(target, request, override = false) {
          const counts = { cards: 0, leases: 0, contentReads: 0 };
          const counterKeys = ['postedMessages', 'patternCalls', 'uiaFetches', 'captures', 'finalReads'];
          const nativeCounters = [];
          const recordCounters = reply => { nativeCounters.push(reply?.counters); return reply; };
          const rawClient = await client({ override });
          const safeDriver = { request: async (method, params) => {
            if (method === 'getState') return recordCounters(await rawClient.request(method, params));
            if (['getAXState', 'getScreenshot', 'getAXStateAndScreenshot'].includes(method)) counts.contentReads++;
            const reply = await request(rawClient, method, target, params);
            recordCounters(reply.raw);
            if (!reply.raw.ok) throw Object.assign(Error(reply.raw.code), reply.raw);
            return reply.reply;
          } };
          const safety = createWindowsSafety({ driver: safeDriver, allowForbidden: override,
            lease: { ready: async () => {}, acquire: () => { counts.leases++; return 'collector'; }, renew() {}, release() {}, close() {} },
            approve: async () => { counts.cards++; return true; } });
          repls.push({ safety });
          return { counts: () => ({ ...counts }), async acquire(selector) {
            const tickMs = tick();
            // Parent dispatch is the observation source. REPL output is never
            // parsed as a native error or accepted as a passing assertion.
            let captured;
            const beforeCounters = nativeCounters.length;
            const observe = (method, params, info) => safety.request(method, params, info).then(
              reply => { captured = directReply({ ...reply, ok: true }, target, projectReply); return reply; },
              error => { captured = projectReply(error, true); throw error; });
            const measured = createRepl({ platform, driver: rawClient, dispatch: observe });
            repls.push({ repl: measured });
            await context.check();
            const result = await measured.execute({ code: `var uc3fApp = await cua.getApp(${JSON.stringify(selector)});` });
            if (!captured) writeEvidence(`parent-unproved-${context.caseId}-${context.trial}.json`, {
              // Fixed classification only. Worker text can contain app data.
              isError: result.isError === true, dispatchObserved: false,
              contentTypes: (result.content ?? []).map(item => item.type).slice(0, 8),
            });
            const observedCounters = nativeCounters.slice(beforeCounters);
            if (captured && observedCounters.length && observedCounters.every(c => counterKeys.every(k => uint(c?.[k]))))
              captured.counters = Object.fromEntries(counterKeys.map(k => [k, observedCounters.reduce((sum, c) => sum + c[k], 0)]));
            return { tickMs, replyTickMs: tick(), raw: captured ?? { ok: false, code: 'PARENT_RESULT_UNPROVED' } };
          } };
        },
        async requireDefaultDesktop() {
          await context.check();
          if (!(await psCall('desktop')).isDefault) fail('SECURE_DESKTOP_NO_INJECT');
        },
        async settings(fixture) {
          await context.check();
          if (fixture.refused === 'FORBIDDEN_SETTINGS') return fixture;
          writeEvidence(`terminal-controls-${context.caseId}-${context.trial}.json`, await psCall('terminal-control-tree', { fixture }));
          await openTerminalSettings({ beforeInput: o.beforeInput, check: context.check, inspect, call: psCall }, fixture);
          const deadline = now() + 10000;
          while (now() < deadline) {
            await context.check();
            const state = await (await client()).request('getState', {});
            const found = state.windows?.filter(w => w.pid === fixture.pid && w.processStart === fixture.processStart && w.refused === 'FORBIDDEN_SETTINGS');
            if (found?.length === 1) {
              const native = await psCall('inspect', { fixture: { ...fixture, title: 'Settings' } });
              const bound = bindTerminalSettingsFixture(fixture, found[0], native);
              const index = registered.findIndex(f => f.windowId === fixture.windowId && f.pid === fixture.pid && f.processStart === fixture.processStart);
              if (index < 0) fail('FIXTURE_IDENTITY_CHANGED');
              const adopted = context.rebindSettings(fixture, bound);
              registered[index] = adopted;
              return adopted;
            }
            await sleep(50);
          }
          fail('OWNED_TERMINAL_SETTINGS_UNPROVED');
        },
        async raisePrompt(fixture) {
          if (promptPending) fail('PROMPT_ALREADY_PENDING');
          await o.beforeInput?.();
          await context.check();
          await inspect(fixture);
          promptPending = psCall('raise-prompt', { fixture });
          promptPending.catch(() => {});
          const deadline = now() + 15000;
          while (now() < deadline) {
            await context.check();
            if (!(await psCall('desktop')).isDefault) return;
            await sleep(10);
          }
          fail('SECURE_PROMPT_UNPROVED');
        },
        async direct(target, override) {
          return runDirectTrial({ target, override, ...o, rowId: context.rowId, tick, now, psCall, prepare,
            writeOwned, read: readOrdinary, check: context.check, sleep, nextInvocation: () => String(++invocation) });
        },
        async cancel({ client: c, target, readId, order }) {
          const result = await runCancelTrial({ client: c, target, readId, order, tick, now, sleep, check: context.check,
            waitForInput: ({ sent, finished }) => waitFixtureInput({ sent, finished, now, sleep, check: context.check,
              read: async () => JSON.parse(await readPublished(join(o.bank, 'receiver.json'), context.check, 4 * 1024 * 1024, 0)) }) });
          writeEvidence(`cancel-order-${context.caseId}-${context.trial}.json`, result.orderEvidence);
          return result;
        },
      };
      const recordRequest = context.request;
      io.checkpointTimingProducer = o.rows[0] === 'checkpoint-cost';
      const facts = await measureGuestTrial({ ...context, request: async (...args) => {
        const r = await recordRequest(...args);
        if (Number.isSafeInteger(r.reply?.readId)) reads.set(args[2].windowId, r.reply.readId);
        return r;
      } }, io);
      if (context.caseId === 'background-word') facts.typingTarget = validateTypingTarget(typingTargets.get(context.trial));
      if (context.caseId !== 'background-word' && context.fixtures.some(f => f.target === 'wpf') && existsSync(join(o.bank, 'receiver.json'))) {
        const fixture = await stoppedFixture(facts, { check: context.check, now, sleep,
          read: async () => JSON.parse(await readPublished(join(o.bank, 'receiver.json'), context.check, 4 * 1024 * 1024)) });
        if (fixture.truncated) fail('FIXTURE_LOG_TRUNCATED');

        facts.fixture = { ...fixture, ...facts.fixture, events: fixture.events?.filter(e => e.tickMs >= (facts.driver[0]?.tickMs ?? tick())) };
      }
      return facts;
    },
    recordFileFailure,
    // Restore is the only cleanup. Do not close clients, workers or inspectors.
    async closeClients() {},
    async writeRaw(rowId, records) {
      ordinary(rawDir, true);
      if (rowId !== o.rows[0]) fail('UNKNOWN_SAFETY_ROW');
      fileFailures.flush();
      writeFileSync(rawPath, records.map(r => JSON.stringify(r)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });

    },
  };
  return backend;
}

export async function runTransportRequest(args, dependencies = {}) {
  const { request, bank, resultPath } = readTransportRequest(args, dependencies);
  try {
    if ((dependencies.platform ?? process.platform) !== 'win32') fail('WINDOWS_REQUIRED');
    const { now = Date.now } = dependencies, presence = request.presence;
    const o = { bank, expected: request.expected, ownerAway: presence === 'away', transportInvocation: request.invocation };
    let value;
    if (request.operation === 'selftest') {
      o.beforeInput = async () => fail('SELFTEST_INPUT_REFUSED');
      const manifest = JSON.parse(readOrdinary(join(dependencies.root ?? ROOT, 'guest-manifest.json'), 1024 * 1024));
      const { job } = request.payload;
      Object.assign(o, { rows: [job.rowId], rowToken: request.token.repeat(2), revision: manifest.commit, selftestTarget: job.target,
        selftestOperations: [] });
      const backend = (dependencies.createBackend ?? createGuestBackend)(o, dependencies);
      value = await runGuestSelftest(o, job, backend);
    } else if (request.operation === 'row') {
      const row = request.payload.row;
      const root = dependencies.root ?? ROOT;
      const manifest = JSON.parse(readOrdinary(join(root, 'guest-manifest.json'), 1024 * 1024));
      if (!/^[a-f0-9]{40}$/.test(manifest.commit ?? '')) fail('KIT_REVISION_MISMATCH');
      Object.assign(o, { rows: [row.id], cases: row.cases, rowToken: request.token.repeat(2), revision: manifest.commit });
      const backend = (dependencies.createBackend ?? createGuestBackend)(o, dependencies);
      const result = await collectRow({ ...o, rowId: row.id }, backend);
      const failureDetail = result.failureDetail && (Buffer.byteLength(JSON.stringify(result.failureDetail)) <= 16384
        ? result.failureDetail : { proof: 'diagnostic-limit', object: row.id });
      if (failureDetail) writeFileSync(join(bank, 'raw', `${request.invocation}.failure.json`),
        JSON.stringify({ guestCode: result.code, failureDetail }), { flag: 'wx', mode: 0o600 });
      value = { row: row.id, collected: result.status === 'recorded', hookRemoved: result.hookRemoved, code: result.code,
        ...(failureDetail && { failureDetail }) };
    }
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > 32768) fail('INVALID_REQUEST');
    writeFileSync(resultPath, bytes, { flag: 'wx', mode: 0o600 });
    return { mode: 'file-request', value };
  } catch (error) {
    // The request and result path are validated before writing any diagnostic.
    // Never replace a value already published by this or another invocation.
    if (!existsSync(resultPath)) {
      const failure = { guestCode: codeOf(error), failureDetail: error.detail ?? { proof: codeOf(error), object: request.operation } };
      if (Buffer.byteLength(JSON.stringify(failure)) > 16384) failure.failureDetail = { proof: 'diagnostic-limit', object: request.operation };
      const raw = join(bank, 'raw');
      if (existsSync(raw)) {
        ordinary(raw, true);
        const diagnostic = join(raw, `${request.invocation}.failure.json`);
        if (!existsSync(diagnostic)) writeFileSync(diagnostic, JSON.stringify(failure), { flag: 'wx', mode: 0o600 });
      }
      writeFileSync(resultPath, JSON.stringify({ guestCode: codeOf(error) }), { flag: 'wx', mode: 0o600 });
    }
    throw error;
  }
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  if (args.some(arg => arg === '--transport-request' || arg === '--transport-result')) return runTransportRequest(args, dependencies);
  const o = parseCollectArgs(args), print = dependencies.print ?? (s => process.stdout.write(s));
  if (o.dryRun) {
    const result = { schema: RAW_SCHEMA, mode: 'dry-run', rows: collectorPlan(o.rows) };
    print(JSON.stringify(result, null, 2) + '\n'); return result;
  }
  if ((dependencies.platform ?? process.platform) !== 'win32') fail('WINDOWS_REQUIRED');
  const controller = new AbortController(), interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const runtime = { ...o, signal: controller.signal, rowToken: randomBytes(16).toString('hex') };
    const backend = (dependencies.createBackend ?? createGuestBackend)(runtime, dependencies);
    const result = await collectRow({ ...runtime, rowId: o.rows[0] }, backend);
    print(JSON.stringify(result) + '\n');
    return result;
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
}
if (isMain(import.meta.url)) main().then(r => { process.exit(['dry-run', 'file-request'].includes(r.mode) || r.status === 'recorded' && r.hookRemoved ? 0 : r.status === 'skip' ? 2 : 1); })
  .catch(e => { process.stderr.write(codeOf(e) + '\n'); process.exit(1); });
