import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as productionExporter from '../bench/windows/uc3f-export.mjs';
import { UC3F_ROWS, evaluateSafetyEvidence, runSitting, parseSittingArgs, validateResult } from '../bench/windows/driver-sitting.mjs';
import { collectRow, RAW_SCHEMA, createGuestBackend, parseGuestLines, costSamples, requireCalculatorRefusals } from '../bench/windows/uc3f-collect.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { fakeWindows } from './fixtures/windows-driver-fake.mjs';
import { integer, runChild } from '../bench/windows/kit.mjs';

const revision = 'a'.repeat(40), stamp = Date.parse('2026-11-02T01:00:00.000Z');
const digest = x => createHash('sha256').update(x).digest('hex');
const context = { revision, kitManifestSha256: 'b'.repeat(64), exporterSha256: 'c'.repeat(64), observerSha256: 'd'.repeat(64),
  vm: { vmId: 'test-vm', manufacturer: 'QEMU', model: 'Virtual Machine', build: 26200,
    hostnameSha256: 'e'.repeat(64), machineGuidSha256: 'f'.repeat(64) }, userSidSha256: '1'.repeat(64) };
const source = readFileSync(new URL('../bench/windows/uc3f-export.mjs', import.meta.url), 'utf8');
const mutations = {
  calculatorRoutes: ["if (c.id === 'calculator-refused') {", "if (false) {"],
  eventWindow: ['observer.reduce((count, event) => count + hookEventCount(event, t), 0)', "observer.filter(r => ['key', 'mouse'].includes(r.kind) && r.tickMs >= t.startTickMs && r.tickMs <= t.endTickMs).length"],
  eventWeight: ['event.eventCount ?? 1', '1'],
  eventOverlap: ['first <= trial.endTickMs && last >= trial.startTickMs', 'first >= trial.startTickMs && last <= trial.endTickMs'],
  keyClock: ['event.firstTickMs === undefined ? Math.min(event.tickMs, hookEventTick(event))', 'event.firstTickMs === undefined ? event.tickMs'],
  safetySummary: ['...summarizeExport(result.bundle)', ''],
  duplicateCases: ['if (previous.some(p => p.header.cases.some(c => part.header.cases.some(x => c.id === x.id))))', 'if (false)'],
  flags: ['const injectedFlag = event.injected || event.lowerIntegrityInjected;', 'const injectedFlag = false;'],
  hash: ['attestation.bundleSha256 !== hash(bundleBytes) ||', 'false ||'],
  vocabulary: ["fail('RAW_KEYS_INVALID');", 'return;'],
  receipt: ['assertObserverProof(observer, trials,', '/* broken proof */ void (observer, trials,'],
  scoped: ['(?:[1-9][0-9]{0,5}\\.[a-z0-9-]+\\.)?', ''],
  scopedInjector: ['(?:[1-9][0-9]{0,5}\\.[a-z0-9-]+\\.)?inject-', 'inject-'],
  cost: ["trials.flatMap(t => t.costSamples)", '[]'],
  costMarker: ["...row.id === 'checkpoint-cost' ? { measurementOnly: 'bounds not registered' } : {}", ''],
  inputSummary: ['(p.lastInputChanges ?? 0) === 0', 'true'],
  signedDelta: ['if (delta >= 0x80000000) delta -= 0x100000000;', ''],
  mouseFirstClock: ['Math.min(event.firstTickMs, hookEventTick(event, event.firstTickMs, event.firstEventTickMs))', 'event.firstTickMs'],
  mouseLastClock: ['Math.max(event.lastTickMs, hookEventTick(event, event.lastTickMs))', 'event.lastTickMs'],
  mouseMinCallback: ['Math.min(event.firstTickMs, hookEventTick(event, event.firstTickMs, event.firstEventTickMs))', 'hookEventTick(event, event.firstTickMs, event.firstEventTickMs)'],
  mouseMaxCallback: ['Math.max(event.lastTickMs, hookEventTick(event, event.lastTickMs))', 'hookEventTick(event, event.lastTickMs)'],
  rowTotal: ['total: safetyRules.length', 'total: 18'],
  stdout: ["process.stdout.write(JSON.stringify(result) + '\\n');", ''],
};
let exporter = productionExporter;
let parseArgs = parseSittingArgs;
let evaluate = evaluateSafetyEvidence;
if (process.env.UC3G4_BROKEN === 'optional') {
  const driverUrl = new URL('../bench/windows/driver-sitting.mjs', import.meta.url);
  const driverSource = readFileSync(driverUrl, 'utf8');
  const anchor = 'if (!o.dryRun && Boolean(o.safetyEvidence) !== Boolean(o.safetyAttestation))';
  assert.ok(driverSource.includes(anchor));
  const body = driverSource.match(/export function parseSittingArgs\([^]*?\n\}/)[0].replace('export ', '').replace(anchor, 'if (false)');
  const phases = driverSource.match(/const phases = [^;]+;/)[0], targets = driverSource.match(/const targets = [^;]+;/)[0];
  parseArgs = Function('integer', 'failure', `${phases}\n${targets}\n${body}\nreturn parseSittingArgs;`)(integer,
    code => Object.assign(Error(code), { code }));
} else if (['costVerdict', 'costCounts', 'costNote'].includes(process.env.UC3G4_BROKEN)) {
  const url = new URL('../bench/windows/driver-sitting.mjs', import.meta.url);
  const text = readFileSync(url, 'utf8');
  const [before, after] = process.env.UC3G4_BROKEN === 'costVerdict' ? ["...skipped(note)", '...passed()'] :
    process.env.UC3G4_BROKEN === 'costNote' ? ["'not measured: no timing producer'", "'bounds not registered'"] :
      ['count: c.samples.length, plannedCount: planned', 'count: 0, plannedCount: planned'];
  assert.ok(text.includes(before));
  const changed = text.replace(before, after).replace(/from '(\.\.?\/[^']+)'/g,
    (_all, path) => `from '${new URL(path, url).href}'`).replace('if (isMain(import.meta.url))', 'if (false)')
    .replaceAll('import.meta.url', JSON.stringify(url.href));
  evaluate = (await import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'))).evaluateSafetyEvidence;
} else if (process.env.UC3G4_BROKEN) {
  const mutation = mutations[process.env.UC3G4_BROKEN];
  assert.ok(mutation && source.includes(mutation[0]), 'mutation anchor');
  const changed = source.replace(mutation[0], mutation[1]).replace(/from '(\.\/[^']+)'/g,
    (_whole, path) => `from '${new URL(path, new URL('../bench/windows/uc3f-export.mjs', import.meta.url)).href}'`)
    .replace('if (isMain(import.meta.url))', 'if (false)');
  exporter = await import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'));
}
const templates = readFileSync(new URL('./fixtures/uc3f-observer-lines.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
const counts = () => ({ postedMessages: 0, patternCalls: 0, uiaFetches: 0, captures: 0, finalReads: 0 });
const lines = records => records.map(r => JSON.stringify(r)).join('\n') + '\n';
const records = text => text.trim().split('\n').map(JSON.parse);
const present = id => ['lock-refused', 'lock-during-type', 'screensaver-refused', 'session-switch-refused', 'uac-refused',
  'uac-hint', 'escape-stop-hardware'].includes(id);

// Independent observed facts for an offline instrumented guest. collectRow and
// projectTrial produce the real G3 envelope; no expected value generates facts.
function measuredFacts(rowId, caseId, start) {
  const reply = (method, at, fields = {}) => ({ tickMs: start + at, replyTickMs: start + at + 20, method,
    ...method === 'typeText' ? { requestedUnits: 3000 } : {}, raw: { ok: true, windowMatched: true, counters: counts(), ...fields } });
  const refusal = (code, reason, after = false) => ({ ok: false, code, reason, unhealthy: false,
    delivery: after ? 'sent-unverified' : 'not-sent', retry: after ? 'read-first' : 'safe', ...after ? { typed: 128 } : {} });
  const recovery = () => reply('getAXState', 350);
  const injection = (operation = 'key', key = 'other', at = 100) => JSON.stringify({ schema: 'sleight.windows-uc3f-inject/1',
    kind: 'injector', invocation: '2', operation, key: operation === 'key' ? key : 'none', tickMs: start + at,
    eventTickMs: (start + at) % 0x100000000, vk: operation === 'key' ? key === 'escape' ? 27 : 81 : 0,
    sentInputs: operation === 'key' ? 2 : 0, code: 'OK' });
  const facts = { driver: [reply('getAXState', 50)], fixture: { effectObserved: true, keyUpsDelivered: true, postsAfterStop: 0 } };
  if (caseId === 'background-word') facts.typingTarget = { kind: 'wpf', pid: 42, windowId: '102', fixturePid: 41,
    fixtureWindowId: '101', tickMs: start, lastInputTickMs: start % 0x100000000 };
  if (rowId === 'person-idle' || caseId === 'unlocked-action' || caseId === 'idle-action') facts.driver.push(reply('typeText', 200));
  if (caseId === 'calculator-refused') facts.driver = [...Array(5).fill(undefined), ...Array(2).fill(['getAXState', 'getScreenshot', 'getAXStateAndScreenshot']).flat()]
    .map((admissionFor, i) => ({ ...reply('getApp', 50 + i * 25, { ok: false, code: 'HOSTED_APP_UNRESOLVED' }), ...admissionFor ? { admissionFor } : {} }));
  if (rowId === 'person-key-before') {
    facts.driver.push(reply('typeText', 200, refusal('PERSON_TOOK_OVER', 'person-active')));
    facts.injector = injection(); facts.injectorInvocation = '2';
  }
  if (['person-key-during', 'lock-during-type', 'escape-stop-hardware', 'cancel-frame'].includes(rowId)) {
    const code = rowId === 'person-key-during' ? 'PERSON_TOOK_OVER' : rowId === 'lock-during-type' ? 'SCREEN_LOCKED' : 'USER_STOPPED';
    const reason = rowId === 'person-key-during' ? 'person-active' : rowId === 'lock-during-type' ? 'session-locked' : rowId === 'cancel-frame' ? 'cancel' : 'escape';
    const action = reply('typeText', 200, refusal(code, reason, true));
    action.requestedUnits = rowId === 'escape-stop-hardware' ? 4000 : 3000;
    facts.driver.push(action);
    if (rowId === 'person-key-during') { facts.injector = injection(); facts.injectorInvocation = '2'; }
    if (rowId === 'escape-stop-hardware') {
      facts.fixture.escapeDowns = 1;
      const next = reply('typeText', 300, refusal('USER_STOPPED', 'escape')); next.requestedUnits = 1; facts.driver.push(next);
    }
    if (rowId === 'cancel-frame') facts.parent = { jobId: 1, jobReplyId: 1, cancelId: 2, cancelReplyId: 2, flagMs: 5 };
  }
  if (rowId === 'lock-refused' && ['read', 'capture', 'action'].includes(caseId) ||
      ['screensaver-refused', 'session-switch-refused'].includes(rowId)) {
    const reason = rowId === 'screensaver-refused' ? 'screensaver' : rowId === 'session-switch-refused' ? 'session-disconnected' : 'session-locked';
    facts.driver = [reply(caseId === 'capture' ? 'getScreenshot' : caseId === 'action' ? 'typeText' : 'getAXState', 200,
      refusal('SCREEN_LOCKED', reason)), recovery()];
    if (rowId === 'session-switch-refused') facts.parent = { driverPid: 44, resumedDriverPid: 44 };
  }
  if (rowId === 'uac-refused' && caseId === 'prompt') facts.driver = [reply('getAXState', 200,
    refusal('SECURE_DESKTOP_ACTIVE', 'secure-desktop')), recovery()];
  if (rowId === 'uac-hint') facts.driver = [reply('click', 200, { settleMode: 'cap', secureDesktopSeen: true }), recovery()];
  if (rowId === 'escape-ignored-injected') {
    facts.driver.push(reply('typeText', 200, { escapeStops: 0 }));
    facts.injector = injection('key', 'escape'); facts.injectorInvocation = '2';
  }
  if (rowId === 'escape-ignored-posted') facts.driver.push(reply('stuckMenuEscape', 200, { escapeStops: 0 }));
  if (rowId.startsWith('direct-launch')) {
    const override = rowId === 'direct-launch-override', direct = caseId.startsWith('direct');
    facts.launch = { source: direct ? 'scheduled-direct' : 'parent', override, ...direct ? { nonceSha256: '9'.repeat(64) } : {} };
    facts.driver = [reply('getAXState', 200, override && caseId.endsWith('terminal') ? {} :
      { ok: false, code: caseId.endsWith('settings') ? 'FORBIDDEN_SETTINGS' : 'FORBIDDEN_TARGET' })];
  }
  if (rowId.startsWith('browser-refused')) {
    facts.parent = { cards: 0, leases: 0, contentReads: 0 };
    if (!['notepad', 'calculator', 'wpf'].includes(caseId)) facts.driver = [reply('getAXState', 200, { ok: false, code: 'BROWSER_TARGET_REFUSED' })];
    if (caseId === 'renamed') facts.pe = { originalFilenamePreserved: true, productNamePreserved: true };
  }
  if (rowId === 'checkpoint-cost') facts.costSamples = caseId === 'hook-callback' ? [{ elapsedUs: 25 }] :
    [{ elapsedMs: 2.75 }];
  return facts;
}

async function rawLog(rowId, ownerAway = !present(rowId), disk) {
  let tick = 100, log;
  const lease = { row: rowId, presence: ownerAway ? 'away' : 'present', token: '2'.repeat(32),
    issuedUtc: new Date(stamp).toISOString(), expiresUtc: new Date(stamp + 900000).toISOString() };
  const observer = [];
  let pollCount = 0, lastPoll = 100;
  const poll = (at, extra = {}) => {
    pollCount += Math.max(1, Math.floor((at - lastPoll) / 10)); lastPoll = at;
    observer.push({ ...templates.find(r => r.kind === 'poll'), tickMs: at,
      pollCount, maxGapMs: 10, lastInputTickMs: 50, ...extra });
  };
  const observerLines = () => {
    const all = [{ ...templates[0], tickMs: 99, rowId, rowToken: lease.token, invocation: '1', leaseExpiresUtc: lease.expiresUtc },
      ...observer.sort((a, b) => a.tickMs - b.tickMs), { ...templates.at(-1), tickMs: tick + 1,
        pollCount: observer.filter(p => p.kind === 'poll').at(-1).pollCount }];
    all.forEach((r, n) => { r.seq = n + 1; }); all.at(-1).records = all.length;
    return lines(all);
  };
  const backend = {
    now: () => stamp, tick: () => tick++, guard: async () => {}, lease: async () => lease,
    preflight: async () => {}, setup: async (_r, { register }) => register({ ...fakeWindows[0] }),
    inspect: async f => f, readGo: async () => true, closeFixture: async () => {}, removeTasks: async () => {},
    removeRenamedCopy: async () => {}, closeClients: async () => {},
    cleanupCheck: async () => ({ tasks: [], fixturePids: [], bankFiles: [], renamedCopies: [], hookRemoved: true, sessionRestored: true }),
    startObserver: async () => ({ ready: true, invocation: '1', finish: async () => observerLines() }),
    measure: async ({ rowId, caseId }) => {
      const start = tick - 1;
      poll(start);
      if (rowId === 'lock-refused' && ['read', 'capture', 'action'].includes(caseId)) poll(start + 100, { wtsFlags: 0 });
      else if (rowId === 'uac-hint' || rowId === 'uac-refused' && caseId === 'prompt') poll(start + 100, { desktop: 'Winlogon' });
      else poll(start + 100);
      if (['escape-stop-hardware', 'escape-ignored-injected'].includes(rowId)) observer.push({
        ...templates.find(r => r.kind === 'key'), tickMs: start + 100, eventTickMs: (start + 100) % 0x100000000,
        key: 'escape', phase: 'down', injected: rowId === 'escape-ignored-injected', lowerIntegrityInjected: false });
      poll(start + 400); poll(start + 500);
      tick = start + 500;
      return measuredFacts(rowId, caseId, start);
    },
    writeRaw: async (_id, output) => { log = lines(output); },
  };
  if (disk) {
    const { bank, invocation } = disk;
    const request = { protocol: 'sleight.uc3f-transport/1', operation: 'row', invocation, token: '3'.repeat(16),
      presence: ownerAway ? 'away' : 'present', vmId: context.vm.vmId,
      expected: { ...context.vm, schema: 'sleight.uc3f-vm-record/1', hostName: '192.168.64.7', provenance: { hostname: 'Win32_ComputerSystem.Name',
        machineGuid: 'HKLM\\SOFTWARE\\Microsoft\\Cryptography\\MachineGuid', encoding: 'sha256:utf8:trim:lowercase' } },
      payload: { row: { id: rowId, presence: lease.presence, ...rowId === 'person-idle' ?
        { cases: ownerAway ? ['notepad', 'wpf', 'calculator-refused'] : ['background-word'] } : {} } } };
    writeFileSync(join(bank, `${invocation}.request.json`), JSON.stringify(request), { flag: 'wx' });
    writeFileSync(join(bank, 'lease.json'), JSON.stringify(lease));
    let finishChild, observerPath;
    const real = createGuestBackend({ bank, rows: [rowId], revision, ownerAway, rowToken: lease.token, transportInvocation: invocation }, {
      platform: 'win32', now: () => stamp, tick: () => tick, validateBank: () => {},
      execute: async (_command, args, options) => {
        assert.equal(options.normalPriority, true);
        const helper = args[args.indexOf('-Invocation') + 1];
        observerPath = join(bank, `${invocation}.${rowId}.observer-${helper}.jsonl`);
        writeFileSync(observerPath, '', { flag: 'wx' });
        options.onStderr('SLEIGHT_UC3F_OBSERVER_READY');
        return new Promise(done => { finishChild = done; });
      },
    });
    backend.startObserver = async (...args) => {
      const handle = await real.startObserver(...args);
      return { ...handle, finish: async () => {
        writeFileSync(observerPath, observerLines()); finishChild({ status: 0 });
        return handle.finish();
      } };
    };
    backend.writeRaw = async (id, output) => { log = lines(output); await real.writeRaw(id, output); };
  }
  const result = await collectRow({ revision, rowId, ownerAway, rowToken: lease.token }, backend);
  assert.equal(result.status, 'recorded', JSON.stringify(result));
  return log;
}
let fakeLogs;
async function allLogs() {
  if (!fakeLogs) {
    const next = [];
    for (const row of UC3F_ROWS) next.push(await rawLog(row.id));
    next.push(await rawLog('person-idle', false));
    fakeLogs = next;
  }
  return [...fakeLogs];
}
const verdict = (result, id) => evaluate(id, result.bundle.rows.find(r => r.id === id)?.evidence);
async function temporary(fn) {
  const path = trackTemp(mkdtempSync(join(tmpdir(), 'uc3g4-')));
  try { return await fn(path); } finally { rmSync(path, { recursive: true, force: true }); }
}
function mutateLog(logs, id, edit) {
  return logs.map(text => { const r = records(text); if (r[0].rowId !== id) return text; edit(r); return lines(r); });
}

test('exporter exposes offline projection and attestation entry points', () => {
  for (const name of ['exportRawLogs', 'createAttestation', 'verifyAttestation', 'main'])
    assert.equal(typeof exporter[name], 'function', name);
});

test('background-word retains the actual typing target and rejects stale, repeated or fixture-target evidence', async () => {
  for (const kind of ['wpf', 'word']) {
    const logs = mutateLog(await allLogs(), 'person-idle', rows => {
      for (const t of rows.filter(r => r.caseId === 'background-word')) t.typingTarget.kind = kind;
    });
    const result = exporter.exportRawLogs(logs, revision);
    const sample = result.bundle.rows.find(r => r.id === 'person-idle').evidence.cases.find(c => c.id === 'background-word');
    assert.deepEqual(sample.samples.map(s => s.typingTarget), Array(20).fill(kind));
    assert.equal(verdict(result, 'person-idle').status, 'pass');
  }
  for (const edit of [t => { t.typingTarget.pid = t.typingTarget.fixturePid; },
    t => { t.typingTarget.windowId = t.typingTarget.fixtureWindowId; },
    t => { t.typingTarget.lastInputTickMs = t.typingTarget.tickMs - 2001; },
    t => { t.typingTarget.kind = 'other'; }, t => { delete t.typingTarget; }]) {
    const logs = mutateLog(await allLogs(), 'person-idle', rows => {
      const t = rows.find(r => r.caseId === 'background-word'); if (t) edit(t);
    });
    const result = exporter.exportRawLogs(logs, revision);
    assert.notEqual(verdict(result, 'person-idle').status, 'pass');
  }
  const repeated = mutateLog(await allLogs(), 'person-idle', rows => {
    const trials = rows.filter(r => r.caseId === 'background-word');
    if (trials.length) trials[1].typingTarget.lastInputTickMs = trials[0].typingTarget.lastInputTickMs;
  });
  assert.notEqual(verdict(exporter.exportRawLogs(repeated, revision), 'person-idle').status, 'pass');
});

test('UC3E prerequisite fixes remain present with eight observed-effect cases and frozen unset bounds', () => {
  assert.equal(UC3F_ROWS.find(r => r.id === 'escape-stop-hardware').cases[0].expect.injectedFlag, false);
  assert.equal(UC3F_ROWS.flatMap(r => r.cases).filter(c => c.expect.effectObserved === true).length, 8);
  assert.equal(UC3F_ROWS.at(-1).measurementOnly, true);
  assert.equal(Object.hasOwn(UC3F_ROWS.at(-1), 'noise'), false);
});

test('G3 fake collection exports 18 passing rows and measured cost without qualification', async () => {
  const logs = await allLogs(), result = exporter.exportRawLogs(logs, revision);
  assert.equal(logs.length, 20);
  assert.equal(result.bundle.rows.length, 19, JSON.stringify(result.diagnostics));
  for (const row of UC3F_ROWS.slice(0, -1)) assert.equal(verdict(result, row.id).status, 'pass', row.id);
  const cost = verdict(result, 'checkpoint-cost');
  assert.equal(cost.status, 'skip'); assert.equal(cost.note, 'bounds not registered');
  assert.equal(cost.costs['session-probe'].count, 50); assert.equal(cost.costs['session-probe'].p90Ms, 2.75);
  assert.equal(cost.costs['hook-callback'].count, 100); assert.equal(cost.costs['hook-callback'].p99Us, 25);
  assert.equal(result.bundle.rows.flatMap(r => r.evidence.cases).reduce((n, c) => n + c.samples.length, 0), 2201);
});

test('invariant 7: either injection flag and injector correlation prevent a hardware pass', async () => {
  for (const flag of ['injected', 'lowerIntegrityInjected']) {
    const logs = mutateLog(await allLogs(), 'escape-stop-hardware', r => {
      r.find(x => x.kind === 'observer' && x.observation.kind === 'key').observation[flag] = true;
    });
    const result = exporter.exportRawLogs(logs, revision);
    assert.notEqual(verdict(result, 'escape-stop-hardware').status, 'pass');
    assert.equal(result.bundle.rows.find(r => r.id === 'escape-stop-hardware').evidence.cases[0].samples[0].source, 'scheduled-sendinput');
  }
  for (const at of [0, -1, -1999, 1999, 2000]) {
    const logs = mutateLog(await allLogs(), 'escape-stop-hardware', r => {
      const trial = r.find(x => x.kind === 'trial');
      const tick = trial.startTickMs + 100 + at;
      // Direct attribution unit below covers injector records outside this trial.
      if (tick >= trial.startTickMs && tick <= trial.endTickMs) trial.injector = [{ schema: 'sleight.windows-uc3f-inject/1', kind: 'injector',
        invocation: '2', operation: 'key', key: 'escape', tickMs: tick, eventTickMs: tick % 0x100000000, vk: 27, sentInputs: 2, code: 'OK' }];
    });
    if (at === 0 || at === -1) assert.notEqual(verdict(exporter.exportRawLogs(logs, revision), 'escape-stop-hardware').status, 'pass');
  }
});

test('hardware source derives from flags and logs, with a two-second inclusive correlation window and tick wrap', () => {
  const t = { startTickMs: 0x100000000 + 100, endTickMs: 0x100000000 + 500 };
  const event = { kind: 'key', key: 'escape', phase: 'down', tickMs: t.startTickMs + 100,
    eventTickMs: 200, injected: false, lowerIntegrityInjected: false };
  assert.equal(exporter.escapeAttribution(t, [event], []).source, 'owner-keyboard');
  for (const offset of [-2000, -1999, 0, 1999, 2000])
    assert.throws(() => exporter.escapeAttribution(t, [event], [{ tickMs: event.tickMs + offset }]), /INJECTION_UNATTRIBUTED/);
  assert.equal(exporter.escapeAttribution(t, [event], [{ tickMs: event.tickMs + 2001 }]).source, 'owner-keyboard');
  assert.throws(() => exporter.escapeAttribution(t, [], []), /ESCAPE_UNPROVED/);
  assert.throws(() => exporter.escapeAttribution(t, [event, event], []), /ESCAPE_UNPROVED/);
});

for (const fault of ['overflow', 'disk', 'gap', 'missing-receipt', 'heartbeat', 'collector-failure', 'cleanup', 'unmeasured'])
  test(`G3 not measured ${fault} never exports a passing row`, async () => {
    const logs = mutateLog(await allLogs(), 'person-key-before', r => {
      const end = r.findLast(x => x.kind === 'observer' && x.observation.kind === 'end');
      if (fault === 'overflow') end.observation.truncated = true;
      if (fault === 'disk') end.observation.diskError = true;
      if (fault === 'gap') r.find(x => x.kind === 'observer' && x.observation.kind === 'poll').observation.seq++;
      if (fault === 'missing-receipt') r.splice(r.indexOf(end), 1);
      if (fault === 'heartbeat') r.find(x => x.kind === 'observer' && x.observation.kind === 'poll').observation.maxGapMs = 101;
      if (fault === 'collector-failure') r.at(-1).code = 'OBSERVER_OVERFLOW';
      if (fault === 'cleanup') r.at(-1).hookRemoved = false;
      if (fault === 'unmeasured') r.find(x => x.kind === 'trial').unmeasured = 'DRIVER_TELEMETRY_INCOMPLETE';
    });
    assert.equal(verdict(exporter.exportRawLogs(logs, revision), 'person-key-before').status, 'skip');
  });

test('invariant 10: unknown keys are dropped, taint their row and never leak into a bundle', async () => {
  for (const location of ['header', 'trial', 'reply', 'fixture', 'parent', 'observer']) {
    const logs = mutateLog(await allLogs(), 'escape-stop-hardware', r => {
      const t = r.find(x => x.kind === 'trial');
      const target = { header: r[0], trial: t, reply: t.driver[0], fixture: t.fixture,
        parent: (t.parent ??= {}), observer: r.find(x => x.kind === 'observer').observation }[location];
      target.windowTitle = 'PRIVATE_TITLE';
    });
    const result = exporter.exportRawLogs(logs, revision);
    assert.notEqual(verdict(result, 'escape-stop-hardware').status, 'pass', location);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TITLE|windowTitle/);
  }
  for (const value of ['x'.repeat(257), 'iVBORw0KGgoPRIVATE']) {
    const logs = mutateLog(await allLogs(), 'person-idle', r => { r[0].screenshot = value; });
    assert.equal(verdict(exporter.exportRawLogs(logs, revision), 'person-idle').status, 'skip');
  }
});

test('missing telemetry, duplicate cases, wrong revision and split Word cases fail closed', async () => {
  for (const edit of [r => { delete r.find(x => x.kind === 'trial').fixture.keyUpsDelivered; },
    r => { r[0].revision = 'b'.repeat(40); }, r => { r.find(x => x.kind === 'trial').driver[0].tickMs = 0; }]) {
    const logs = mutateLog(await allLogs(), 'escape-stop-hardware', edit);
    assert.equal(verdict(exporter.exportRawLogs(logs, revision), 'escape-stop-hardware').status, 'skip');
  }
  const logs = await allLogs();
  assert.equal(verdict(exporter.exportRawLogs(logs.filter(t => !(records(t)[0].rowId === 'person-idle' && records(t)[0].cases.length === 1)), revision), 'person-idle').status, 'skip');
  assert.equal(verdict(exporter.exportRawLogs([...logs.filter(t => records(t)[0].rowId !== 'checkpoint-cost'), logs[0]], revision), 'person-idle').status, 'skip');
});

test('invariant 9: exact byte hash and each independently pinned identity field are required', async () => {
  const bytes = Buffer.from(JSON.stringify(exporter.exportRawLogs(await allLogs(), revision).bundle));
  const a = exporter.createAttestation(bytes, context, new Date(stamp).toISOString());
  assert.equal(exporter.verifyAttestation(bytes, a, context).size, 19);
  const changed = Buffer.from(bytes), byte = changed.indexOf('"typed":128') + '"typed":'.length;
  assert.ok(byte > 0); changed[byte] = '2'.charCodeAt(0);
  assert.throws(() => exporter.verifyAttestation(changed, a, context), /UC3F_EVIDENCE_INVALID/);
  assert.throws(() => exporter.verifyAttestation(Buffer.concat([bytes, Buffer.from(' ')]), a, context), /UC3F_EVIDENCE_INVALID/);
  for (const key of ['bundleSha256', 'revision', 'kitManifestSha256', 'exporterSha256', 'observerSha256', 'userSidSha256']) {
    const bad = structuredClone(a); bad[key] = '0'.repeat(key === 'revision' ? 40 : 64);
    assert.throws(() => exporter.verifyAttestation(bytes, bad, context), /UC3F_EVIDENCE_INVALID/, key);
  }
  for (const key of Object.keys(a.vm)) {
    const bad = structuredClone(a); bad.vm[key] = key === 'build' ? 26201 : 'different';
    assert.throws(() => exporter.verifyAttestation(bytes, bad, context), /UC3F_EVIDENCE_INVALID/, key);
  }
  assert.match(a.notice, /not authentication/);
  assert.throws(() => exporter.verifyAttestation(bytes, undefined, context));
  assert.throws(() => exporter.verifyAttestation(bytes, a, undefined));
});

test('N row archives use the same projection as two blocks, including split person-idle cases', async () => {
  const logs = await allLogs();
  const sources = logs.map(log => {
    const bundleBytes = Buffer.from(JSON.stringify(exporter.exportRawLogs([log], revision).bundle) + '\n');
    const raw = { schema: 'sleight.uc3f-row-raw/1', context, logs: [log], injectorLogs: [] };
    raw.sha256 = createHash('sha256').update(JSON.stringify({ logs: raw.logs, injectorLogs: [] })).digest('hex');
    return { raw, bundleBytes, attestation: exporter.createAttestation(bundleBytes, context, new Date(stamp).toISOString()) };
  });
  assert.ok(sources.length > 2);
  const combined = exporter.combineRowData(sources);
  assert.deepEqual(combined.bundle, exporter.exportRawLogs(logs, revision).bundle);
  assert.equal(combined.bundle.rows.length, 19);
  assert.equal(exporter.verifyAttestation(combined.bundleBytes, combined.attestation, context).size, 19);
  const tampered = structuredClone(sources); tampered[0].raw.logs[0] += ' ';
  assert.throws(() => exporter.combineRowData(tampered), /UC3F_EVIDENCE_INVALID/);
  const mixed = structuredClone(sources); mixed[0].raw.context.kitManifestSha256 = 'f'.repeat(64);
  assert.throws(() => exporter.combineRowData(mixed), /UC3F_EVIDENCE_INVALID/);
  const duplicate = exporter.combineRowData([sources[0], sources[0]]);
  assert.equal(duplicate.bundle.rows.length, 0);
  assert.ok(duplicate.diagnostics.some(d => d.code === 'RAW_CASE_DUPLICATE'));
});

test('sitting requires a sidecar; one-byte or identity changes invalidate all 19 rows', async () => temporary(async path => {
  const bundle = exporter.exportRawLogs(await allLogs(), revision).bundle;
  const bytes = Buffer.from(JSON.stringify(bundle)), evidence = join(path, 'input.json'), sidecar = join(path, 'attestation.json');
  writeFileSync(evidence, bytes); writeFileSync(sidecar, JSON.stringify(exporter.createAttestation(bytes, context, new Date(stamp).toISOString())));
  const options = { phase: 'safety', runs: 20, dpi: 100, origin: 'standard', size: 'compact', revision, safetyEvidence: evidence, safetyAttestation: sidecar };
  const deps = { platform: 'win32', assertUnelevated: async () => {}, loadSafetyModule: async () => null, safetyContext: context };
  const good = await runSitting(options, deps);
  assert.equal(good.steps.filter(r => r.summary.pass).length, 18); assert.equal(validateResult(good), true);
  for (const scenario of ['missing', 'byte', 'identity']) {
    writeFileSync(evidence, scenario === 'byte' ? Buffer.concat([bytes, Buffer.from(' ')]) : bytes);
    const opts = { ...options, ...scenario === 'missing' ? { safetyAttestation: undefined } : {} };
    const report = await runSitting(opts, { ...deps, ...scenario === 'identity' ? { safetyContext: { ...context, userSidSha256: '9'.repeat(64) } } : {} });
    const rows = report.steps.filter(r => UC3F_ROWS.some(rule => rule.id === r.id));
    assert.equal(rows.length, 19); assert.ok(rows.every(r => r.trials[0].code === 'UC3F_EVIDENCE_INVALID'));
    assert.equal(report.verdict, 'failed'); assert.equal(validateResult(report), true);
  }
  assert.throws(() => parseSittingArgs(['--phase', 'safety', '--output', 'out.json', '--revision', revision, '--safety-evidence', evidence]), /UC3F_EVIDENCE_INVALID/);
  assert.equal(parseSittingArgs(['--dry-run', '--safety-evidence', 'unreadable']).dryRun, true);
}));

test('exclusive bank publication yields a byte-verifiable sidecar and refuses overwrites and symlinks', async () => temporary(async bank => {
  mkdirSync(join(bank, 'raw'));
  writeFileSync(join(bank, 'raw', 'person-key-before.jsonl'), await rawLog('person-key-before'));
  const result = await exporter.exportBank({ bank, revision, context, now: () => stamp });
  const bytes = readFileSync(join(bank, 'uc3f-observations.json'));
  assert.deepEqual(result, { exported: true, rows: 1, unmeasured: 18, ...exporter.summarizeExport(JSON.parse(bytes)) });
  assert.equal(exporter.verifyAttestation(bytes, JSON.parse(readFileSync(join(bank, 'uc3f-observations.attestation.json'))), context).size, 1);
  await assert.rejects(exporter.exportBank({ bank, revision, context, now: () => stamp }), /EEXIST/);
  const alias = join(bank, 'alias.json'); symlinkSync(join(bank, 'uc3f-observations.json'), alias);
  assert.throws(() => exporter.readBounded(alias));
  assert.throws(() => exporter.readBounded(join(bank, 'raw')));
  assert.throws(() => exporter.readBounded(join(bank, 'uc3f-observations.json'), 1));
}));

test('independent injector logs cannot be ignored by the hardware row', async () => {
  const logs = [await rawLog('escape-stop-hardware')], trial = records(logs[0]).find(r => r.kind === 'trial');
  const tick = trial.startTickMs + 100;
  const injection = JSON.stringify({ schema: 'sleight.windows-uc3f-inject/1', kind: 'injector', invocation: '2', operation: 'key',
    key: 'escape', tickMs: tick, eventTickMs: tick % 0x100000000, vk: 27, sentInputs: 2, code: 'OK' });
  assert.equal(verdict(exporter.exportRawLogs(logs, revision), 'escape-stop-hardware').status, 'pass');
  assert.equal(verdict(exporter.exportRawLogs(logs, revision, [injection]), 'escape-stop-hardware').status, 'skip');
});

test('collector setup receipts remain in the bank and never enter exported row archives', async () => temporary(async bank => {
  mkdirSync(join(bank, 'raw'));
  writeFileSync(join(bank, 'raw', '2.person-key-before.person-key-before.jsonl'), await rawLog('person-key-before'));
  writeFileSync(join(bank, 'raw', '2.person-key-before.launch-notepad.json'), '{"title":"private-fixture-title"}');
  writeFileSync(join(bank, 'raw', '2.person-key-before.binding-notepad-1.json'), '{"windows":[]}');
  for (const name of ['cancel-order-job-first-0', 'parent-unproved-parent-terminal-0', 'terminal-controls-direct-settings-0', 'foreground-1'])
    writeFileSync(join(bank, 'raw', `2.person-key-before.${name}.json`), '{"tree":"private-control-tree"}');
  writeFileSync(join(bank, 'raw', '2.person-key-before.file-io-1.json'), JSON.stringify({
    path: 'C:\\fixture\\receiver.json', operation: 'read', fd: 19, code: 'EBUSY', attempt: 2, count: 1001,
  }));
  await exporter.exportBank({ bank, revision, context, now: () => stamp });
  const raw = readFileSync(join(bank, 'uc3f-row-raw.json'), 'utf8');
  assert.equal(raw.includes('private-fixture-title'), false);
  assert.equal(raw.includes('private-control-tree'), false);
  assert.equal(raw.includes('C:'), false);
  assert.equal(JSON.parse(raw).logs.length, 1);
  assert.deepEqual(JSON.parse(raw).ioDiagnostics, [{ file: 'receiver.json', operation: 'read', fd: 19, code: 'EBUSY', attempt: 2, count: 1001 }]);
  const counted = JSON.parse(raw);
  for (const count of [0, -1, 1.5, '2']) {
    counted.ioDiagnostics[0].count = count;
    assert.throws(() => exporter.rawArchiveHash(counted), { code: 'UC3F_EVIDENCE_INVALID' });
  }
  delete counted.ioDiagnostics[0].count;
  assert.doesNotThrow(() => exporter.rawArchiveHash(counted), 'legacy archives without a count remain valid');
  const parsed = JSON.parse(raw), changed = structuredClone(parsed);
  changed.ioDiagnostics[0].fd++;
  assert.notEqual(exporter.rawArchiveHash(changed), parsed.sha256);
  for (const bad of [{ ...parsed.ioDiagnostics[0], title: 'private' }, { ...parsed.ioDiagnostics[0], file: 'C:\\private' },
    { ...parsed.ioDiagnostics[0], file: 'private-document.txt' },
    { ...parsed.ioDiagnostics[0], attempt: 21 }, { ...parsed.ioDiagnostics[0], operation: 'read-content' }])
    assert.throws(() => exporter.rawArchiveHash({ ...parsed, ioDiagnostics: [bad] }));
}));

test('attestation context pins manifest bytes, exporter and observer hashes, VM identity and SID without leaking SID', async () => temporary(async root => {
  mkdirSync(join(root, 'bench', 'windows'), { recursive: true });
  const files = ['uc3f-export.mjs', 'uc3f-observer.ps1'].map((name, n) => {
    const bytes = Buffer.from(`fixture ${n}`), path = `bench/windows/${name}`;
    writeFileSync(join(root, path), bytes); return { path, bytes: bytes.length, sha256: digest(bytes) };
  });
  const manifest = Buffer.from(JSON.stringify({ schema: 'sleight.windows-guest-kit/1', commit: revision, files }));
  writeFileSync(join(root, 'guest-manifest.json'), manifest);
  writeFileSync(join(root, 'vm-identity.json'), JSON.stringify(context.vm));
  let calls = 0;
  const execute = async (command, args, settings) => {
    calls++; assert.match(command, /whoami\.exe$/); assert.deepEqual(args, ['/user', '/fo', 'csv', '/nh']);
    assert.equal(settings.timeout, 10000); assert.equal(settings.maxBytes, 4096);
    return { status: 0, stdout: '"fixture-user","S-1-5-21-123-456-789-1001"' };
  };
  const c = await exporter.loadAttestationContext({ revision, bank: root, root, execute, env: {} });
  assert.equal(c.kitManifestSha256, digest(manifest)); assert.equal(c.exporterSha256, files[0].sha256);
  assert.equal(c.observerSha256, files[1].sha256); assert.deepEqual(c.vm, context.vm);
  assert.doesNotMatch(JSON.stringify(c), /fixture-user|S-1-5/); assert.equal(calls, 1);
  writeFileSync(join(root, files[0].path), 'changed');
  await assert.rejects(exporter.loadAttestationContext({ revision, bank: root, root, execute, env: {} }), /UC3F_EVIDENCE_INVALID/);
  assert.equal(calls, 1, 'no process starts after a kit mismatch');
}));

test('G7 file-request export binds request and VM identity before publishing its reply', async () => temporary(async root => {
  const bank = join(root, 'uc3f-' + '3'.repeat(16)); mkdirSync(bank); mkdirSync(join(bank, 'raw'));
  writeFileSync(join(bank, 'raw', 'person-key-before.jsonl'), await rawLog('person-key-before'));
  writeFileSync(join(root, 'guest-manifest.json'), JSON.stringify({ commit: revision }));
  const lease = { row: 'export', presence: 'away', operations: ['export'], token: '4'.repeat(32),
    issuedUtc: new Date(stamp).toISOString(), expiresUtc: new Date(stamp + 60000).toISOString() };
  const expected = { ...context.vm };
  const request = { protocol: 'sleight.uc3f-transport/1', operation: 'export', invocation: '1', token: '3'.repeat(16),
    presence: 'away', vmId: context.vm.vmId, expected, payload: {} };
  const requestPath = join(bank, '1.request.json'), resultPath = join(bank, '1.value.json');
  const args = ['--transport-request', requestPath, '--transport-result', resultPath];
  const deps = { platform: 'win32', validateBank: () => {}, now: () => stamp, root, loadContext: async () => context };
  writeFileSync(join(bank, 'lease.json'), JSON.stringify(lease));
  writeFileSync(requestPath, JSON.stringify({ ...request, vmId: 'other' }));
  await assert.rejects(exporter.main(args, deps), /VM_IDENTITY_MISMATCH/);
  writeFileSync(requestPath, JSON.stringify(request));
  const result = await exporter.main(args, deps);
  assert.equal(result.exported, true); assert.deepEqual(JSON.parse(readFileSync(resultPath)), { exported: true });
  await assert.rejects(exporter.main(args, deps), /EEXIST/);
  await assert.rejects(exporter.main(args, { ...deps, platform: 'darwin' }), /WINDOWS_REQUIRED/);
}));

test('false and missing positive-effect receipts cannot become passes', async () => {
  for (const value of [false, undefined]) {
    const logs = mutateLog(await allLogs(), 'person-idle', r => {
      const f = r.find(x => x.kind === 'trial').fixture;
      if (value === undefined) delete f.effectObserved; else f.effectObserved = value;
    });
    assert.notEqual(verdict(exporter.exportRawLogs(logs, revision), 'person-idle').status, 'pass');
  }
  const logs = mutateLog(await allLogs(), 'escape-stop-hardware', r => { r.find(x => x.kind === 'trial').fixture.escapeDowns = -1; });
  assert.notEqual(verdict(exporter.exportRawLogs(logs, revision), 'escape-stop-hardware').status, 'pass');
});

test('WTS flags follow the refused and recovered samples rather than searching for desired values', async () => {
  const logs = mutateLog(await allLogs(), 'lock-refused', r => {
    for (const record of r) if (record.kind === 'observer' && record.observation.kind === 'poll')
      record.observation.wtsFlags = record.observation.wtsFlags === 0 ? 1 : 0;
  });
  assert.notEqual(verdict(exporter.exportRawLogs(logs, revision), 'lock-refused').status, 'pass');
});

test('CLI attestation option is mandatory whenever evidence is supplied', () => {
  const args = ['--phase', 'safety', '--output', 'out.json', '--revision', revision];
  assert.throws(() => parseArgs([...args, '--safety-evidence', 'bundle.json']), /UC3F_EVIDENCE_INVALID/);
  assert.throws(() => parseArgs([...args, '--safety-attestation', 'sidecar.json']), /UC3F_EVIDENCE_INVALID/);
  assert.equal(parseArgs([...args, '--safety-evidence', 'bundle.json', '--safety-attestation', 'sidecar.json']).safetyAttestation, 'sidecar.json');
});

test('first recovery failure cannot be replaced by a later successful reply', async () => {
  const logs = mutateLog(await allLogs(), 'uac-hint', r => {
    const trial = r.find(x => x.kind === 'trial'), recovery = trial.driver.at(-1);
    trial.driver.splice(trial.driver.length - 1, 0, { ...recovery, tickMs: recovery.tickMs - 50,
      replyTickMs: recovery.replyTickMs - 50, ok: false, windowMatched: false, code: 'SCREEN_LOCKED' });
  });
  assert.notEqual(verdict(exporter.exportRawLogs(logs, revision), 'uac-hint').status, 'pass');
});

test('scoped bank: six collections include Escape, injector and cost rows through the real observer and raw lifecycle', async () => temporary(async root => {
  const bank = join(root, 'uc3f-' + '3'.repeat(16)); mkdirSync(bank);
  for (const [index, [id, away]] of [['person-idle', true], ['person-key-before', true], ['person-idle', false],
    ['escape-stop-hardware', false], ['escape-ignored-injected', true], ['checkpoint-cost', true]].entries())
    await rawLog(id, away, { bank, invocation: String(index + 1) });
  assert.equal(readdirSync(join(bank, 'raw')).length, 6);
  assert.equal(readdirSync(bank).filter(n => /observer-1\.jsonl$/.test(n)).length, 6);
  assert.equal(readdirSync(bank).filter(n => /stop\.request\.json$/.test(n)).length, 6);
  const result = await exporter.exportBank({ bank, revision, context, now: () => stamp });
  assert.deepEqual({ exported: result.exported, rows: result.rows, unmeasured: result.unmeasured }, { exported: true, rows: 5, unmeasured: 14 });
  assert.deepEqual(result.safetyRows, { total: 18, pass: 4, fail: 0, skip: 14 });
  const evidence = exporter.verifyAttestation(readFileSync(join(bank, 'uc3f-observations.json')),
    JSON.parse(readFileSync(join(bank, 'uc3f-observations.attestation.json'))), context);
  for (const id of ['person-idle', 'person-key-before', 'escape-stop-hardware', 'escape-ignored-injected'])
    assert.equal(evaluateSafetyEvidence(id, evidence.get(id)).status, 'pass');
  assert.equal(evaluateSafetyEvidence('checkpoint-cost', evidence.get('checkpoint-cost')).status, 'skip');
  assert.equal(evidence.get('person-idle').cases.reduce((n, c) => n + c.samples.length, 0), 130);
}));

test('scoped independent injector file prevents a hardware pass in an exported bank', async () => temporary(async root => {
  const bank = join(root, 'uc3f-' + '3'.repeat(16)); mkdirSync(bank);
  const raw = await rawLog('escape-stop-hardware', false, { bank, invocation: '1' });
  const trial = records(raw).find(r => r.kind === 'trial'), tickMs = trial.startTickMs + 100;
  writeFileSync(join(bank, '2.escape-ignored-injected.inject-1.jsonl'), JSON.stringify({
    schema: 'sleight.windows-uc3f-inject/1', kind: 'injector', invocation: '1', operation: 'key', key: 'escape',
    tickMs, eventTickMs: tickMs % 0x100000000, vk: 27, sentInputs: 2, code: 'OK' }));
  await exporter.exportBank({ bank, revision, context, now: () => stamp });
  const bundle = JSON.parse(readFileSync(join(bank, 'uc3f-observations.json')));
  assert.equal(evaluateSafetyEvidence('escape-stop-hardware', bundle.rows[0]?.evidence).status, 'skip');
}));

test('duplicate repeated cases in a scoped bank fail closed without choosing a winning run', async () => temporary(async root => {
  const bank = join(root, 'uc3f-' + '3'.repeat(16)); mkdirSync(bank);
  for (const [index, id] of ['person-key-before', 'person-key-during', 'person-key-before'].entries())
    await rawLog(id, true, { bank, invocation: String(index + 1) });
  await exporter.exportBank({ bank, revision, context, now: () => stamp });
  const bundle = JSON.parse(readFileSync(join(bank, 'uc3f-observations.json')));
  assert.equal(evaluateSafetyEvidence('person-key-before', bundle.rows.find(r => r.id === 'person-key-before')?.evidence).status, 'skip');
  assert.equal(evaluateSafetyEvidence('person-key-during', bundle.rows.find(r => r.id === 'person-key-during')?.evidence).status, 'pass');
}));

test('cost export retains only measured numbers and counts, including missing samples', async () => {
  const log = await rawLog('checkpoint-cost');
  const result = exporter.exportRawLogs([log], revision), full = verdict(result, 'checkpoint-cost');
  assert.equal(result.bundle.rows[0].evidence.measurementOnly, 'bounds not registered');
  assert.equal(full.status, 'skip'); assert.equal(full.note, 'bounds not registered');
  assert.equal(full.costs['lock-check'].count, 50); assert.equal(full.costs['hook-remove'].p90Ms, 2.75);
  const partial = records(log);
  for (const t of partial.filter(r => r.kind === 'trial' && (r.caseId === 'lock-check' || r.trial % 2 === 0))) {
    t.costSamples = []; t.unmeasured = 'CHECKPOINT_TIMING_UNAVAILABLE';
  }
  const measured = verdict(exporter.exportRawLogs([lines(partial)], revision), 'checkpoint-cost');
  assert.equal(measured.status, 'skip'); assert.equal(measured.note, 'bounds not registered');
  assert.deepEqual(measured.costs['lock-check'], { count: 0, plannedCount: 50, p50Ms: null, p90Ms: null });
  assert.equal(measured.costs['session-probe'].count, 25);
  assert.equal(measured.costs['hook-callback'].count, 50);
  assert.equal(measured.evidence.cases.reduce((n, c) => n + c.samples.length, 0), 200);
  const bytes = Buffer.from(JSON.stringify(result.bundle));
  assert.equal(exporter.verifyAttestation(bytes, exporter.createAttestation(bytes, context), context).size, 1);
  for (const bad of [NaN, -1, Infinity, '2']) assert.throws(() => costSamples('hook-callback', [{ elapsedUs: bad }]));
  assert.throws(() => costSamples('session-probe', [{ elapsedMs: 1, windowTitle: 'PRIVATE' }]));
  await temporary(async bank => {
    mkdirSync(join(bank, 'raw'));
    writeFileSync(join(bank, 'raw', '1.checkpoint-cost.checkpoint-cost.jsonl'), log);
    assert.deepEqual(await exporter.exportBank({ bank, revision, context, now: () => stamp }),
      { exported: true, rows: 1, unmeasured: 18, measurementOnly: 1, ...exporter.summarizeExport(result.bundle) });
    const rows = exporter.verifyAttestation(readFileSync(join(bank, 'uc3f-observations.json')),
      JSON.parse(readFileSync(join(bank, 'uc3f-observations.attestation.json'))), context);
    assert.equal(evaluate('checkpoint-cost', rows.get('checkpoint-cost')).costs['session-probe'].count, 50);
  });
  for (const t of partial.filter(r => r.kind === 'trial')) { t.costSamples = []; t.unmeasured = 'CHECKPOINT_TIMING_UNAVAILABLE'; }
  const empty = verdict(exporter.exportRawLogs([lines(partial)], revision), 'checkpoint-cost');
  assert.equal(empty.status, 'skip'); assert.equal(empty.note, 'not measured: no timing producer');
  assert.equal(empty.evidence.cases.flatMap(c => c.samples).length, 0);
  assert.equal(empty.costs['hook-callback'].p99Us, null);
});

test('event windows: late mouse summaries count all events and overlapping boundary summaries fail closed', async () => {
  const raw = records(await rawLog('escape-ignored-posted'));
  const trial = raw.findLast(r => r.kind === 'trial');
  const mouse = templates.find(r => r.kind === 'mouse');
  for (const [name, first, last, published, expected] of [
    ['late publication', trial.endTickMs - 200, trial.endTickMs - 200, trial.endTickMs + 1, 5],
    ['straddles start', trial.startTickMs - 1, trial.startTickMs + 1, trial.endTickMs + 1, 5],
    ['straddles end', trial.endTickMs - 1, trial.endTickMs + 1, trial.endTickMs + 1, 5],
    ['straddles both', trial.startTickMs - 1, trial.endTickMs + 1, trial.endTickMs + 1, 5],
    ['touches start', trial.startTickMs - 1, trial.startTickMs, trial.endTickMs + 1, 5],
    ['touches end', trial.endTickMs, trial.endTickMs, trial.endTickMs + 1, 5],
    ['before window', trial.startTickMs - 2, trial.startTickMs - 1, trial.endTickMs - 1, 0],
    ['after window', trial.endTickMs + 1, trial.endTickMs + 1, trial.endTickMs + 1, 0],
  ]) {
    const rows = structuredClone(raw);
    rows.splice(-1, 0, { schema: RAW_SCHEMA, kind: 'observer', rowId: trial.rowId, observation: {
      ...mouse, tickMs: published, firstTickMs: first, lastTickMs: last, eventCount: 5,
      firstEventTickMs: first % 0x100000000, eventTickMs: last % 0x100000000,
      firstForegroundHwnd: mouse.foregroundHwnd, firstForegroundPid: mouse.foregroundPid,
    } });
    resequenceObserver(rows);
    const result = exporter.exportRawLogs([lines(rows)], revision);
    assert.deepEqual(result.diagnostics, [], name);
    const evidence = result.bundle.rows[0]?.evidence;
    assert.equal(evidence?.cases[0].samples.at(-1).hookEvents, expected, name);
    // The immediately preceding trial contains the "before window" events.
    assert.equal(evaluate('escape-ignored-posted', evidence).status, expected || name === 'before window' ? 'fail' : 'pass', name);
  }
});

function resequenceObserver(rows) {
  const slots = rows.flatMap((r, n) => r.kind === 'observer' ? [n] : []);
  const observations = slots.map(n => rows[n].observation).sort((a, b) => a.tickMs - b.tickMs || (a.kind === 'end' ? 1 : -1));
  observations.forEach((r, n) => { r.seq = n + 1; rows[slots[n]].observation = r; });
  observations.at(-1).records = observations.length;
}

test('event windows: key event clocks, including DWORD wrap, decide hook counts and Escape attribution', async () => {
  const raw = records(await rawLog('escape-ignored-posted'));
  const trial = raw.findLast(r => r.kind === 'trial');
  const key = templates.find(r => r.kind === 'key');
  for (const eventAt of [trial.startTickMs - 1, trial.startTickMs, trial.endTickMs]) {
    const rows = structuredClone(raw);
    rows.splice(-1, 0, { schema: RAW_SCHEMA, kind: 'observer', rowId: trial.rowId,
      observation: { ...key, tickMs: trial.endTickMs + 1, eventTickMs: eventAt % 0x100000000 } });
    resequenceObserver(rows);
    const result = exporter.exportRawLogs([lines(rows)], revision);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.bundle.rows[0].evidence.cases[0].samples.at(-1).hookEvents, 1);
  }
  const start = 0x100000000 - 100, end = 0x100000000 + 100;
  const event = { ...key, kind: 'key', key: 'escape', phase: 'down', tickMs: end + 1,
    eventTickMs: (end - 1) % 0x100000000, injected: false, lowerIntegrityInjected: false };
  assert.equal(exporter.escapeAttribution({ startTickMs: start, endTickMs: end }, [event], []).eventTick, end - 1);
});

test('event clocks: signed DWORD deltas count keys ahead of callbacks and across either wrap edge', async () => {
  const raw = records(await rawLog('escape-ignored-posted'));
  const trial = raw.findLast(r => r.kind === 'trial'), key = templates.find(r => r.kind === 'key');
  const rows = structuredClone(raw);
  rows.splice(-1, 0, { schema: RAW_SCHEMA, kind: 'observer', rowId: trial.rowId,
    observation: { ...key, tickMs: trial.endTickMs - 1, eventTickMs: trial.endTickMs % 0x100000000 } });
  resequenceObserver(rows);
  const result = exporter.exportRawLogs([lines(rows)], revision);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.bundle.rows[0].evidence.cases[0].samples.at(-1).hookEvents, 1);
  assert.equal(verdict(result, trial.rowId).status, 'fail');
});

test('event clocks: Escape resolves signed DWORD deltas on both sides of wrap', async t => {
  const key = templates.find(r => r.kind === 'key');
  for (const [callback, dword, want] of [
    [5000, 5001, 5001], [5000, 4999, 4999],
    [0x100000000 - 1, 0, 0x100000000],
    [0x100000000, 0xffffffff, 0x100000000 - 1],
    [0x200000000 - 1, 0, 0x200000000],
    [0x200000000, 0xffffffff, 0x200000000 - 1],
  ]) await t.test(`callback ${callback}, event ${dword} resolves to ${want}`, () => {
    const event = { ...key, key: 'escape', phase: 'down', tickMs: callback, eventTickMs: dword,
      injected: false, lowerIntegrityInjected: false };
    assert.equal(exporter.escapeAttribution({ startTickMs: want, endTickMs: want }, [event], []).eventTick, want);
  });
});

test('event clocks: mouse bounds include delayed callbacks and event clocks ahead of callbacks', async () => {
  const raw = records(await rawLog('escape-ignored-posted'));
  const trial = raw.findLast(r => r.kind === 'trial'), mouse = templates.find(r => r.kind === 'mouse');
  for (const [name, callback, eventAt] of [
    ['delayed callback', trial.endTickMs + 5, trial.endTickMs - 3],
    ['ahead event at start', trial.startTickMs - 1, trial.startTickMs],
  ]) {
    const rows = structuredClone(raw);
    rows.find(r => r.kind === 'observer' && r.observation.kind === 'end').observation.tickMs = trial.endTickMs + 7;
    rows.splice(-1, 0, { schema: RAW_SCHEMA, kind: 'observer', rowId: trial.rowId, observation: {
      ...mouse, tickMs: trial.endTickMs + 6, firstTickMs: callback, lastTickMs: callback, eventCount: 1,
      firstEventTickMs: eventAt % 0x100000000, eventTickMs: eventAt % 0x100000000,
      firstForegroundHwnd: mouse.foregroundHwnd, firstForegroundPid: mouse.foregroundPid,
    } });
    resequenceObserver(rows);
    const result = exporter.exportRawLogs([lines(rows)], revision);
    assert.deepEqual(result.diagnostics, [], name);
    assert.equal(result.bundle.rows[0].evidence.cases[0].samples.at(-1).hookEvents, 1, name);
    assert.equal(verdict(result, trial.rowId).status, 'fail', name);
  }
});

test('event windows: one mouse summary spanning two consecutive trials counts in both', async () => {
  const rows = records(await rawLog('escape-ignored-posted'));
  const [left, right] = rows.filter(r => r.kind === 'trial').slice(-2);
  const mouse = templates.find(r => r.kind === 'mouse');
  const first = left.endTickMs - 1, last = right.startTickMs + 1;
  assert.ok(left.endTickMs < right.startTickMs);
  rows.splice(-1, 0, { schema: RAW_SCHEMA, kind: 'observer', rowId: left.rowId, observation: {
    ...mouse, tickMs: right.endTickMs + 1, firstTickMs: first, lastTickMs: last, eventCount: 5,
    firstEventTickMs: first % 0x100000000, eventTickMs: last % 0x100000000,
    firstForegroundHwnd: mouse.foregroundHwnd, firstForegroundPid: mouse.foregroundPid,
  } });
  resequenceObserver(rows);
  const result = exporter.exportRawLogs([lines(rows)], revision);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.bundle.rows[0].evidence.cases[0].samples.slice(-2).map(s => s.hookEvents), [5, 5]);
  assert.equal(verdict(result, left.rowId).status, 'fail');
});

test('safety summary: total follows a reduced row table', async () => {
  const url = new URL('../bench/windows/uc3f-export.mjs', import.meta.url);
  let changed = source;
  if (process.env.UC3G4_BROKEN === 'rowTotal') changed = changed.replace(...mutations.rowTotal);
  changed = changed.replace('import { UC3F_ROWS, evaluateSafetyEvidence }', 'import { UC3F_ROWS as registeredRows, evaluateSafetyEvidence }')
    .replace('export const EVIDENCE_SCHEMA', "const UC3F_ROWS = registeredRows.filter(r => r.id !== 'person-idle');\nexport const EVIDENCE_SCHEMA")
    .replace(/from '(\.\/[^']+)'/g, (_whole, path) => `from '${new URL(path, url).href}'`)
    .replace('if (isMain(import.meta.url))', 'if (false)');
  const reduced = await import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'));
  assert.deepEqual(reduced.summarizeExport({ rows: [] }).safetyRows, { total: 17, pass: 0, fail: 0, skip: 17 });
});

// This source substitution exercises main and publication. It does not exercise isMain.
test('exporter stdout: real main publishes JSON summary and exits zero with incomplete safety', async () => temporary(async root => {
  const bank = join(root, 'uc3f-' + '3'.repeat(16)); mkdirSync(bank); mkdirSync(join(bank, 'raw'));
  writeFileSync(join(root, 'guest-manifest.json'), JSON.stringify({ commit: revision }));
  const lease = { row: 'export', presence: 'away', operations: ['export'], token: '4'.repeat(32),
    issuedUtc: new Date(stamp).toISOString(), expiresUtc: new Date(stamp + 60000).toISOString() };
  const request = { protocol: 'sleight.uc3f-transport/1', operation: 'export', invocation: '1', token: '3'.repeat(16),
    presence: 'away', vmId: context.vm.vmId, expected: context.vm, payload: {} };
  const requestPath = join(bank, '1.request.json'), resultPath = join(bank, '1.value.json');
  writeFileSync(join(bank, 'lease.json'), JSON.stringify(lease)); writeFileSync(requestPath, JSON.stringify(request));
  const url = new URL('../bench/windows/uc3f-export.mjs', import.meta.url);
  let changed = source;
  if (process.env.UC3G4_BROKEN === 'stdout') changed = changed.replace(...mutations.stdout);
  // Replace only Windows metadata dependencies. Run the real main, publication
  // and CLI completion handler in a child, without whoami or any Windows host.
  changed = changed.replace(/from '(\.\/[^']+)'/g, (_whole, path) => `from '${new URL(path, url).href}'`)
    .replace('if (isMain(import.meta.url)) main()', `main(${JSON.stringify(['--transport-request', requestPath, '--transport-result', resultPath])}, {
      platform: 'win32', validateBank: () => {}, now: () => ${stamp}, root: ${JSON.stringify(root)},
      loadContext: async () => (${JSON.stringify(context)}) })`);
  const script = join(root, 'export-cli.mjs'); writeFileSync(script, changed);
  const child = await runChild(process.execPath, [script], { timeout: 10000, maxBytes: 16384 });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.reason, null); assert.equal(child.stderr, '');
  assert.notEqual(child.stdout.trim(), '', 'successful export must print its summary');
  const output = JSON.parse(child.stdout);
  assert.equal(child.stdout.trim().split('\n').length, 1);
  assert.deepEqual(output.safetyRows, { total: 18, pass: 0, fail: 0, skip: 18 });
  assert.equal(output.exported, true); assert.equal(output.safetyPhase.exitCode, 2);
  assert.equal(output.safetyPhase.verdict, 'incomplete');
  assert.deepEqual(JSON.parse(readFileSync(resultPath)), { exported: true });
  assert.equal(JSON.parse(readFileSync(join(bank, 'uc3f-observations.json'))).rows.length, 0);
}));

test('coalesced last-input changes cannot export person-idle as unchanged', async () => {
  const logs = mutateLog([await rawLog('person-idle'), await rawLog('person-idle', false)], 'person-idle', r => {
    const poll = r.find(x => x.kind === 'observer' && x.observation.kind === 'poll').observation;
    poll.lastInputFirstTickMs = poll.lastInputTickMs; poll.lastInputChanges = 2;
  });
  const result = exporter.exportRawLogs(logs, revision);
  assert.equal(result.bundle.rows.length, 1, JSON.stringify(result.diagnostics));
  assert.equal(verdict(result, 'person-idle').status, 'fail');
});

test('safety summary: 18 passing rows stand alone while zero cost samples keep safety incomplete with exit 2', async () => temporary(async bank => {
  mkdirSync(join(bank, 'raw'));
  const logs = await allLogs();
  for (const [n, raw] of logs.entries()) {
    const rows = records(raw), id = rows[0].rowId;
    if (id === 'checkpoint-cost') for (const t of rows.filter(r => r.kind === 'trial')) {
      t.driver = []; t.costSamples = []; t.unmeasured = 'CHECKPOINT_TIMING_UNAVAILABLE';
    }
    writeFileSync(join(bank, 'raw', `${n + 1}.${id}.${id}${id === 'person-idle' ? n === 0 ? '-away' : '-present' : ''}.jsonl`), lines(rows));
  }
  const result = await exporter.exportBank({ bank, revision, context, now: () => stamp });
  assert.deepEqual(result.safetyRows, { total: 18, pass: 18, fail: 0, skip: 0 });
  assert.deepEqual(result.checkpointCost, { status: 'skip', samples: 0, note: 'not measured: no timing producer' });
  assert.equal(result.safetyPhase.verdict, 'incomplete'); assert.equal(result.safetyPhase.exitCode, 2);
  assert.match(result.safetyPhase.note, /incomplete \(exit 2\).*unmeasured/);
  const bytes = readFileSync(join(bank, 'uc3f-observations.json'));
  const bundle = JSON.parse(bytes);
  assert.equal(bundle.rows.length, 19);
  const bad = structuredClone(bundle);
  bad.rows.find(r => r.id === 'escape-ignored-posted').evidence.cases[0].samples[0].hookEvents = 5;
  const summary = exporter.summarizeExport(bad);
  assert.deepEqual(summary.safetyRows, { total: 18, pass: 17, fail: 1, skip: 0 });
  assert.equal(summary.safetyPhase.exitCode, 1);
  let runbook = readFileSync(new URL('../bench/windows/driver-sitting-runbook.md', import.meta.url), 'utf8');
  if (process.env.UC3G4_RUNBOOK_BROKEN === 'incomplete') runbook = runbook.replace(/The exporter reports the 18 safety rows'[^]*?Supplied timing samples/, 'Supplied timing samples');
  assert.match(runbook, /18 safety rows[\s\S]{0,250}incomplete[\s\S]{0,80}exit 2/);
}));

test('INT22L input counts include both callback and event clocks for keys and mouse', () => {
  const trial = { startTickMs: 100, endTickMs: 200 };
  assert.equal(exporter.hookEventCount({ kind: 'key', tickMs: 150, eventTickMs: 50 }, trial), 1);
  assert.equal(exporter.hookEventCount({ kind: 'mouse', tickMs: 160, firstTickMs: 150, lastTickMs: 160,
    firstEventTickMs: 20, eventTickMs: 30, eventCount: 4 }, trial), 4);
  assert.equal(exporter.hookEventCount({ kind: 'mouse', tickMs: 160, firstTickMs: 150, lastTickMs: 160,
    firstEventTickMs: 300, eventTickMs: 400, eventCount: 6 }, trial), 6);
  const wrap = 0x100000000;
  assert.equal(exporter.hookEventCount({ kind: 'mouse', tickMs: wrap + 160,
    firstTickMs: wrap + 150, lastTickMs: wrap + 160, firstEventTickMs: wrap - 20,
    eventTickMs: 30, eventCount: 5 }, { startTickMs: wrap + 100, endTickMs: wrap + 200 }), 5);
});

test('UC3GFIX10 exporter requires all eleven refused Calculator lookups and reads with zero native effects', async () => {
  const away = records(await rawLog('person-idle')), presentLog = await rawLog('person-idle', false);
  for (const mutate of [
    t => { t.driver = t.driver.filter(d => d.method === 'getAXState').slice(0, 1); },
    t => { delete t.driver.at(-1).admissionFor; },
    t => { t.driver.at(-1).admissionFor = 'getAXState'; },
    t => { t.driver.splice(0, 1); }, t => { t.driver.splice(1, 1); },
    t => { t.driver.at(-1).ok = true; },
    t => { t.driver.at(-1).code = 'WINDOW_NOT_FOUND'; },
    t => { t.driver[0].counters.postedMessages = 1; },
    t => { t.driver.at(-1).counters.captures = 1; },
  ]) {
    const changed = structuredClone(away);
    mutate(changed.find(r => r.kind === 'trial' && r.caseId === 'calculator-refused'));
    const result = exporter.exportRawLogs([lines(changed), presentLog], revision);
    assert.equal(result.bundle.rows.length, 0);
    assert.ok(result.diagnostics.some(d => d.code === 'CALCULATOR_REFUSAL_UNPROVED'));
  }
});

test('exporter accepts Calculator acquisition refusals emitted by the real collector', async () => {
  const away = records(await rawLog('person-idle')), present = await rawLog('person-idle', false);
  for (const trial of away.filter(r => r.kind === 'trial' && r.caseId === 'calculator-refused')) {
    const observed = [];
    await requireCalculatorRefusals({ windowId: '99', coreWindowId: '100', pid: 4240, processStart: '134382652462791842' }, async (method, params, admissionFor) => {
      assert.equal(method, 'getApp'); assert.ok(params.selector);
      const at = trial.startTickMs + 25 + observed.length * 25;
      observed.push({ method, ...admissionFor ? { admissionFor } : {}, tickMs: at, replyTickMs: at + 20, ok: false, code: 'HOSTED_APP_UNRESOLVED', counters: counts() });
      throw Object.assign(Error('HOSTED_APP_UNRESOLVED'), { code: 'HOSTED_APP_UNRESOLVED' });
    });
    trial.driver = observed;
  }
  const result = exporter.exportRawLogs([lines(away), present], revision);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.bundle.rows.length, 1);
  assert.equal(result.bundle.rows[0].id, 'person-idle');
  assert.equal(evaluate('person-idle', result.bundle.rows[0].evidence).status, 'pass');
});
