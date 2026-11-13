import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as collector from '../bench/windows/uc3f-collect.mjs';
import * as diagnostics from '../bench/windows/uc3f-diagnostics.mjs';
import * as exporter from '../bench/windows/uc3f-export.mjs';
import { evaluateSafetyEvidence } from '../bench/windows/driver-sitting.mjs';
import { syntheticObserver } from './fixtures/uc3f-observer-synthetic.mjs';
import { fakeWindows } from './fixtures/windows-driver-fake.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

// Offline witnesses only. No PowerShell, desktop reads or native children.
const root = new URL('../bench/windows/', import.meta.url);
const revision = 'a'.repeat(40), token = 'c'.repeat(32);
const lines = records => records.map(JSON.stringify).join('\n') + '\n';
const failure = code => Object.assign(Error('private exception text'), { code });
const counts = { postedMessages: 0, patternCalls: 0, uiaFetches: 0, captures: 0, finalReads: 0 };
async function mutated(file, before, after) {
  const url = new URL(file, root), source = readFileSync(url, 'utf8');
  assert.ok(source.includes(before), `${file}: mutation anchor`);
  const changed = source.replace(before, after).replace(/from '(\.\.?\/[^']+)'/g,
    (_all, path) => `from '${new URL(path, url).href}'`).replaceAll('import.meta.url', JSON.stringify(url.href));
  return import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'));
}

const observed = rowId => syntheticObserver({ startTickMs: 100, durationMs: 1000,
  lease: { row: rowId, token, expiresUtc: '2026-11-05T06:00:00.000Z' } });
async function collect(api, { pollError = false, processError = false, unmeasured, identity = true } = {}) {
  const rowId = 'cancel-frame', observations = observed(rowId);
  if (pollError) Object.assign(observations.at(-1), { pollError: true, stopReason: 'observer-error' });
  if (!identity) observations[0].rowToken = 'd'.repeat(32);
  let raw;
  const result = await api.collectRow({ revision, rowId, ownerAway: true, rowToken: token }, {
    tick: () => 200, guard: async () => {}, preflight: async () => {},
    setup: async (_row, { register }) => register(fakeWindows[0]),
    startObserver: async () => ({ ready: true, invocation: '1', finish: async () => {
      return diagnostics.observerResult({ status: processError ? 1 : 0, stderr: 'SLEIGHT_UC3F_OBSERVER_READY' }, lines(observations));
    } }),
    measure: async () => ({ driver: [], ...(unmeasured && { unmeasured }) }),
    closeClients: async () => {}, writeRaw: async (_row, records) => { raw = records; },
  });
  return { result, raw };
}
async function observerWitness(api = collector) {
  const { result, raw } = await collect(api, { pollError: true, processError: true });
  assert.equal(result.code, 'OBSERVER_POLL_FAILED');
  assert.equal(result.hookRemoved, true);
  assert.equal(raw.filter(r => r.kind === 'observer').length, observed('cancel-frame').length);
  assert.equal(raw.at(-1).hookRemoved, true);
  assert.equal(exporter.exportRawLogs([lines(raw)], revision).diagnostics[0].code, 'OBSERVER_POLL_FAILED');
}
test('observer poll failure retains records and hook removal despite exit 1 and a readiness marker', () => observerWitness());
test('hook removal requires the current row identity even when both native removals succeeded', async () => {
  const { result } = await collect(collector, { pollError: true, processError: true, identity: false });
  assert.equal(result.hookRemoved, false);
});
test('a nonzero observer exit with otherwise complete proof still fails', async () => {
  const { result } = await collect(collector, { processError: true });
  assert.equal(result.code, 'OBSERVER_PROCESS_FAILED'); assert.equal(result.hookRemoved, true);
});
test('broken variants: dropping failed observer records or merging removal with proof fails the witness', async () => {
  for (const [before, after] of [
    ['text = error.observerText; finishError = error;', 'throw error;'],
    ['hookRemoved = observerRemoval(lines, { token: o.rowToken, row: row.id }, observer.invocation);', 'hookRemoved = false;'],
    ["if (end.pollError) fail('OBSERVER_POLL_FAILED');", ''],
  ]) await assert.rejects(observerWitness(await mutated('uc3f-collect.mjs', before, after)), assert.AssertionError);
});
test('observer readiness text never becomes a failure code', () => {
  assert.throws(() => diagnostics.observerResult({ status: 1, stderr: 'SLEIGHT_UC3F_OBSERVER_READY' }, 'records'),
    { code: 'OBSERVER_PROCESS_FAILED', observerText: 'records' });
});

async function reasonWitness(api = collector) {
  const { result, raw } = await collect(api, { unmeasured: 'REPLY_ORDER_NOT_OBSERVED' });
  assert.equal(result.code, 'REPLY_ORDER_NOT_OBSERVED');
  assert.equal(exporter.exportRawLogs([lines(raw)], revision).diagnostics[0].code, 'REPLY_ORDER_NOT_OBSERVED');
}
test('cancel reply-order failure keeps its exact cause in the row and export', () => reasonWitness());
test('broken variant: collapsing cancel order to generic measurement failure fails the witness', async () => {
  await assert.rejects(reasonWitness(await mutated('uc3f-collect.mjs', 'resultCode ??= codeOf({ code: facts.unmeasured });',
    "resultCode ??= 'MEASUREMENT_UNAVAILABLE';")), assert.AssertionError);
});

async function inputWitness(api = diagnostics) {
  let clock = 0, reads = 0;
  await api.waitFixtureInput({ sent: { tickMs: 100 }, finished: () => false, now: () => clock,
    check: async () => {}, sleep: async ms => { clock += ms; }, read: async () => ({ events: ++reads === 1 ?
      [{ tickMs: 50, message: 0x102 }] : [{ tickMs: 110, message: 0x102 }] }) });
  assert.equal(reads, 2);
}
test('cancel preparation waits for this job to deliver a character instead of using frame write time', () => inputWitness());
test('cancel preparation refuses a finished job and a pump with no observed delivery', async () => {
  for (const finished of [true, false]) {
    let clock = 0;
    await assert.rejects(diagnostics.waitFixtureInput({ sent: { tickMs: 100 }, finished: () => finished,
      now: () => clock, check: async () => {}, sleep: async ms => { clock += ms; }, read: async () => ({ events: [] }) }),
    { code: finished ? 'CANCEL_JOB_ALREADY_FINISHED' : 'CANCEL_INPUT_NOT_OBSERVED' });
  }
});
test('broken variant: using a previous job delivery fails the input witness', async () => {
  await assert.rejects(inputWitness(await mutated('uc3f-diagnostics.mjs', 'e.tickMs > sent.tickMs', 'true')), assert.AssertionError);
});
test('a failed input witness still sends the exact job cancellation and awaits both replies', async () => {
  const frames = []; let resolveJob, cancelled;
  const client = { frames: () => frames, request(method, params) {
    if (method === 'typeText') {
      frames.push({ kind: 'sent', method, id: 7, tickMs: 100 });
      return new Promise(resolve => { resolveJob = resolve; });
    }
    cancelled = params.id;
    frames.push({ kind: 'sent', method, id: 8, tickMs: 200 }, { kind: 'reply', method, id: 8, tickMs: 200 },
      { kind: 'reply', method: 'typeText', id: 7, tickMs: 200 });
    resolveJob({ code: 'USER_STOPPED', typed: 0 }); return Promise.resolve({ code: 'CANCELLED' });
  } };
  await assert.rejects(collector.runCancelTrial({ client, target: fakeWindows[0], readId: 1, order: 'cancel-first',
    tick: () => 200, now: () => 0, check: async () => {}, sleep: async () => {},
    waitForInput: async () => { throw failure('CANCEL_INPUT_NOT_OBSERVED'); } }), {
      code: 'CANCEL_INPUT_NOT_OBSERVED', detail: { job: 'USER_STOPPED', cancel: 'CANCELLED', typed: 0 } });
  assert.equal(cancelled, 7);
});

async function stopWitness(api = diagnostics) {
  let clock = 0, reads = 0;
  const facts = { driver: [{ method: 'typeText', replyTickMs: 200, raw: { ok: false, code: 'USER_STOPPED' } }] };
  const result = await api.stoppedFixture(facts, { now: () => clock, check: async () => {}, sleep: async ms => { clock += ms; },
    read: async () => ({ tickMs: ++reads === 1 ? 190 : 310, truncated: false, keyUpsDelivered: true,
      events: [{ tickMs: 180, message: 0x102 }, { tickMs: 220, message: 0x102 }] }) });
  assert.equal(reads, 2); assert.equal(result.postsAfterStop, 1);
}
test('cancel cleanup waits for a fresh receiver snapshot and counts delivery after the reply', () => stopWitness());
test('stale, truncated and missing-event receiver snapshots never prove zero posts', async () => {
  const facts = { driver: [{ method: 'typeText', replyTickMs: 200, raw: { ok: false, code: 'USER_STOPPED' } }] };
  for (const snapshot of [{ tickMs: 190, events: [] }, { tickMs: 310 }, { tickMs: 310, events: [], truncated: true }]) {
    let clock = 0;
    await assert.rejects(diagnostics.stoppedFixture(facts, { read: async () => snapshot, now: () => clock,
      check: async () => {}, sleep: async ms => { clock += ms; } }), /FIXTURE_(?:STOP_UNPROVED|LOG_TRUNCATED)/);
  }
});
test('broken variants: accepting stale snapshots or inventing zero posts fails the stop witness', async () => {
  for (const [before, after] of [
    ['fixture.tickMs >= job.replyTickMs + graceMs', 'true'],
    ['fixture.events.filter(e => e.tickMs >= job.replyTickMs).length', '0'],
  ]) await assert.rejects(stopWitness(await mutated('uc3f-diagnostics.mjs', before, after)), assert.AssertionError);
});
function cancelRaw() {
  const rowId = 'cancel-frame', observations = observed(rowId), records = [
    { schema: collector.RAW_SCHEMA, kind: 'row', rowId, revision,
      cases: ['cancel-first', 'job-first'].map(id => ({ id, trials: 5, presence: 'away' })) },
  ];
  for (const caseId of ['cancel-first', 'job-first']) for (let trial = 0; trial < 5; trial++) records.push({
    schema: collector.RAW_SCHEMA, kind: 'trial', rowId, caseId, trial, startTickMs: 200, endTickMs: 500,
    driver: [{ method: 'typeText', requestedUnits: 3000, tickMs: 210, replyTickMs: 350, ok: false,
      code: 'USER_STOPPED', reason: 'cancel', typed: 20, delivery: 'sent-unverified', retry: 'read-first', unhealthy: false, counters: counts }],
    parent: { jobId: 4, cancelId: 5, jobReplyId: 4, cancelReplyId: 5, flagMs: 0 },
    fixture: { tickMs: 500, keyUpsDelivered: true, postsAfterStop: 0 },
  });
  records.push(...observations.map(observation => ({ schema: collector.RAW_SCHEMA, kind: 'observer', rowId, observation })),
    { schema: collector.RAW_SCHEMA, kind: 'end', rowId, trials: 10, hookRemoved: true, code: 'RECORDED' });
  return records;
}
async function exportWitness(api = exporter) {
  const records = cancelRaw();
  const good = api.exportRawLogs([lines(records)], revision);
  assert.equal(good.diagnostics.length, 0);
  assert.equal(evaluateSafetyEvidence('cancel-frame', good.bundle.rows[0].evidence).status, 'pass');
  delete records[1].fixture.postsAfterStop;
  assert.deepEqual(api.exportRawLogs([lines(records)], revision).diagnostics,
    [{ id: 'cancel-frame', code: 'MEASUREMENT_UNAVAILABLE', field: 'postsAfterStop' }]);
}
test('exporter identifies the exact missing cancel field and grades complete observations', () => exportWitness());
test('broken variant: dropping the missing-field name fails the export witness', async () => {
  await assert.rejects(exportWitness(await mutated('uc3f-export.mjs', "fail('MEASUREMENT_UNAVAILABLE', key)",
    "fail('MEASUREMENT_UNAVAILABLE')")), assert.AssertionError);
});
test('exportBank accepts retained discovery diagnostics beside raw trials', async t => {
  const bank = registerTemp(t, mkdtempSync(join(tmpdir(), 'wh1i-export-'))); mkdirSync(join(bank, 'raw'));
  writeFileSync(join(bank, 'raw/cancel-frame.jsonl'), lines(cancelRaw()));
  writeFileSync(join(bank, 'raw/discovery-calculator-refused-1.json'), JSON.stringify({ ok: false, code: 'WINDOW_NOT_FOUND' }));
  writeFileSync(join(bank, 'raw/1.cancel-frame.discovery-wpf-1.json'), JSON.stringify({ ok: true, windows: [] }));
  const context = { revision, kitManifestSha256: 'b'.repeat(64), exporterSha256: 'c'.repeat(64), observerSha256: 'd'.repeat(64),
    vm: { vmId: 'fixture', manufacturer: 'QEMU', model: 'Virtual Machine', build: 26200,
      hostnameSha256: 'e'.repeat(64), machineGuidSha256: 'f'.repeat(64) }, userSidSha256: '1'.repeat(64) };
  const result = await exporter.exportBank({ bank, revision, context });
  assert.equal(result.rows, 1);
});

async function directWitness(api = collector, alter = {}) {
  const target = { windowId: '101', pid: 42, processStart: '134000000000000000', image: 'C:\\fixture\\WindowsTerminal.exe' };
  let script;
  const result = await api.runDirectTrial({ target, override: true, bank: 'C:\\sleight-setup\\uc3f-0123456789abcdef',
    ownerAway: true, rowId: 'direct-launch-override', tick: () => 200, now: () => 0, sleep: async () => {}, check: async () => {},
    prepare: async () => ({ status: 'ready', receipt: {} }), executableOf: () => 'host.exe', nextInvocation: () => '1',
    writeOwned: (_name, text) => { script = text; return 'direct.ps1'; }, psCall: async () => {}, exists: () => true,
    read: () => {
      // Emulate only the script's reviewed metadata-copy loop. Native execution
      // and PowerShell syntax are deliberately outside this offline witness.
      const copy = /foreach \(\$key in @\('windowId','pid','processStart','image'\)\)/.test(script);
      return JSON.stringify({ id: 1, replyId: 1, pid: 909, raw: { ok: true, counters: counts,
        ...(copy && { window: { ...target, ...alter } }) } });
    } });
  assert.equal(result.driver[0].raw.windowMatched, Object.keys(alter).length === 0);
  assert.equal(Object.hasOwn(result.driver[0].raw, 'window'), false);
  return result;
}
test('direct override retains identity-matched read proof through the generated script and projection', async () => {
  await directWitness();
  for (const [key, value] of Object.entries({ windowId: '102', pid: 43, processStart: '134000000000000001', image: 'C:\\foreign.exe' }))
    await directWitness(collector, { [key]: value });
});
test('broken variants: losing direct window metadata at either projection boundary fails the witness', async () => {
  for (const [before, after] of [
    ["@('windowId','pid','processStart','image')", "@('pid')"],
    ['directReply(result.raw, target, projectReply)', 'projectReply(result.raw, result.raw.ok === false)'],
  ]) await assert.rejects(directWitness(await mutated('uc3f-fixtures.mjs', before, after)), assert.AssertionError);
});

const calculatorProof = () => {
  const processStart = '134381325118728105', image = 'C:\\Apps\\CalculatorApp.exe';
  return { refusalOnly: true, baselineWindows: ['12'], activationSince: '134381325118000000', newFrameIds: ['99'],
    calculatorProcesses: [{ pid: 4240, processStart }],
    launcher: { pid: 4240, processStart, observedEnd: processStart, image },
    activation: { aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', pid: 4240, processStart, exited: false },
    expectedImage: image, frameHostImage: 'C:\\Windows\\System32\\ApplicationFrameHost.exe', systemDirectory: 'C:\\Windows\\System32',
    windows: [{ windowId: '99', pid: 4240, processStart, image, title: 'Calculator', className: 'ApplicationFrameWindow',
      coreWindowId: '100', corePid: 4240, coreProcessStart: processStart, coreTitle: 'Calculator',
      coreClassName: 'Windows.UI.Core.CoreWindow', framePid: 2812, frameProcessStart: '134381300000000000',
      frameImage: 'C:\\Windows\\System32\\ApplicationFrameHost.exe', refusalOnly: true }] };
};
async function setupWitness(t, api = collector, target = 'calculator-refused', stage = 'discovery') {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'wh1i-setup-'))), bank = join(dir, 'uc3f-0123456789abcdef');
  mkdirSync(bank); mkdirSync(join(bank, 'raw'));
  const image = `C:\\Apps\\${target === 'edge' ? 'msedge' : 'firefox'}.exe`;
  const proof = target === 'calculator-refused' ? calculatorProof() : {
    expectedImage: image, launcher: { pid: 42, processStart: '134000000000000000',
      observedEnd: '134000000000000000', image },
    windows: [{ windowId: '101', pid: 42, processStart: '134000000000000000', image,
      title: 'uc3f-0123456789abcdef', className: 'Fixture' }] };
  const backend = api.createGuestBackend({ bank, rows: ['person-idle'], revision, ownerAway: true, selftestTarget: target }, {
    platform: 'win32', validateBank() {},
    execute: async () => assert.fail('offline setup must never start a native child'),
    guestCall: async operation => { assert.equal(operation, 'launch'); if (stage === 'launch') throw failure('GUEST_EXCEPTION_UNCLASSIFIED'); return proof; },
    createClient: () => ({ request: async () => { throw failure('WINDOW_NOT_FOUND'); } }),
    prepare: async () => 'host.exe',
  });
  await assert.rejects(backend.setup({ id: 'person-idle', cases: [] }, { check: async () => {}, register() {} }),
    { code: stage === 'launch' ? 'GUEST_EXCEPTION_UNCLASSIFIED' : 'WINDOW_NOT_FOUND' });
  const names = readdirSync(join(bank, 'raw'));
  assert.ok(names.includes(`launch-${target}.json`));
  const receipts = names.map(name => [name, JSON.parse(readFileSync(join(bank, 'raw', name)))]);
  const receipt = stage === 'launch' ? receipts.find(([name]) => name === `launch-${target}.json`)[1] :
    receipts.find(([name]) => name.startsWith(`discovery-${target}-`))?.[1];
  assert.ok(receipt, 'failed discovery reply must be retained');
  assert.equal(receipt.code, stage === 'launch' ? 'GUEST_EXCEPTION_UNCLASSIFIED' : 'WINDOW_NOT_FOUND');
  assert.equal(JSON.stringify(receipts).includes('private exception text'), false);
  return { bank, names };
}
test('Calculator refusal-only setup retains its failed discovery without changing the fixture', t => setupWitness(t));
test('browser setup retains a failed launch receipt and a failed discovery receipt', async t => {
  await setupWitness(t, collector, 'edge', 'launch');
  await setupWitness(t, collector, 'edge');
});
test('ordinary Edge requests omit renamed and both strict-mode accesses check property presence', async () => {
  const audit = source => {
    const evaluate = (line, request, target = 'edge') => {
      const expression = line.slice(line.indexOf('if (') + 4, line.lastIndexOf(') {'));
      const js = expression.replaceAll("(HasField $r 'renamed')", 'has()').replaceAll('$r.renamed', 'read()')
        .replaceAll('$target', 'target').replaceAll('-eq', '===').replaceAll('-and', '&&')
        .replaceAll('-or', '||').replaceAll('-not', '!');
      assert.equal(js.replace(/has\(\)|read\(\)|target|'edge'|[\s=!&|()]/g, ''), '', 'reviewed boolean subset only');
      return runInNewContext(js, { target, has: () => Object.hasOwn(request, 'renamed'), read: () => {
        assert.ok(Object.hasOwn(request, 'renamed'), 'strict property access requires the field'); return request.renamed;
      } }, { timeout: 100 });
    };
    const launch = source.split('\n').find(line => line.includes("$programs.edge = Join-Path $r.bank 'msedge-harness.exe'"));
    const staged = source.split('\n').find(line => line.includes("-not $r.renamed) { throw 'INVALID_REQUEST'"));
    assert.ok(launch && staged);
    for (const request of [{}, { renamed: false }, { renamed: true }]) {
      assert.equal(Boolean(evaluate(launch, request)), request.renamed === true);
      assert.equal(Boolean(evaluate(staged, request)), request.renamed !== true);
    }
    assert.equal(Boolean(evaluate(launch, {}, 'firefox')), false);
  };
  audit(collector.GUEST_OPERATIONS);
  for (const remove of ["(HasField $r 'renamed') -and ", "-not (HasField $r 'renamed') -or "])
    assert.throws(() => audit(collector.GUEST_OPERATIONS.replace(remove, '')), assert.AssertionError);
  const call = collector.powershellCall({ bank: 'C:\\sleight-setup\\uc3f-0123456789abcdef', ownerAway: true }, {
    validateBank() {}, execute: async (_ps, _args, { input }) => {
      const payload = /\$r = '(.*)' \| ConvertFrom-Json/.exec(input)?.[1];
      assert.ok(payload); assert.equal(Object.hasOwn(JSON.parse(payload), 'renamed'), false);
      return { status: 1, stderr: 'FIXTURE_START_FAILED' };
    },
  });
  await assert.rejects(call('launch', { target: 'edge', args: [] }), { code: 'FIXTURE_START_FAILED' });
});
test('broken variants: dropping launch or discovery failures fails the setup witnesses', async t => {
  const broken = await mutated('uc3f-diagnostics.mjs', 'write(name, project(error, true));', '');
  const send = () => Promise.reject(failure('WINDOW_NOT_FOUND')), saved = [];
  const witness = async api => {
    await assert.rejects(api.recordSetup(send, (...r) => saved.push(r), 'discovery.json', collector.projectReply));
    assert.equal(saved.length, 1);
  };
  await assert.rejects(witness(broken), assert.AssertionError);
  await setupWitness(t);
});
