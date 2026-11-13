import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import * as collector from '../bench/windows/uc3f-collect.mjs';
import * as diagnostics from '../bench/windows/uc3f-diagnostics.mjs';
import { syntheticObserver } from './fixtures/uc3f-observer-synthetic.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';

const revision = 'a'.repeat(40), token = 'c'.repeat(32), root = new URL('../bench/windows/', import.meta.url);
const fault = code => Object.assign(Error(code), { code });
const fixture = { windowId: '101', pid: 42, processStart: '134382652462791842', bindingId: 'b'.repeat(32),
  image: 'C:\\fixture\\receiver.exe', className: 'Fixture', title: 'fixture', target: 'wpf', integrity: 'medium' };
async function mutated(file, before, after) {
  const url = new URL(file, root), source = readFileSync(url, 'utf8');
  assert.ok(source.includes(before), 'mutation anchor: ' + before);
  const changed = source.replace(before, after).replace(/from '(\.\.?\/[^']+)'/g,
    (_all, path) => `from '${new URL(path, url).href}'`).replaceAll('import.meta.url', JSON.stringify(url.href));
  return import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'));
}
function bankFor(t) {
  const parent = registerTemp(t, mkdtempSync(join(tmpdir(), 'wh1j-'))), bank = join(parent, 'uc3f-' + 'a'.repeat(16));
  mkdirSync(bank); mkdirSync(join(bank, 'raw')); return bank;
}
function makeBackend(t, api = collector, options = {}) {
  const bank = bankFor(t), rowId = options.rowId ?? 'cancel-frame';
  const state = { clock: 100, reads: 0, inputs: 0, cancellations: 0, sleeps: [] };
  const receiver = snapshot => writeFileSync(join(bank, 'receiver.json'), JSON.stringify(snapshot));
  receiver({ tickMs: 100, events: [] });
  const pending = new Map();
  const backend = api.createGuestBackend({ bank, rows: [rowId], revision, ownerAway: true, rowToken: token, transportInvocation: '1' }, {
    platform: 'win32', validateBank() {}, now: () => state.clock, tick: () => state.clock,
    sleep: async ms => {
      state.sleeps.push(ms); state.clock += ms;
      receiver({ tickMs: state.clock, keyUpsDelivered: true, events: state.clock >= state.inputAt ? [
        { tickMs: state.inputAt, message: 0x102 }, ...(state.cancellations ? [{ tickMs: state.inputAt, message: 0x101 }] : [])] : [] });
    },
    execute: options.execute ?? (async () => assert.fail('no native child')),
    guestCall: options.guestCall ?? (async () => assert.fail('unexpected guest operation')),
    makeInspector: () => ({ inspect: async f => f }),
    prepare: async ({ run }) => ({ status: 'ready', spawn: opts => run('fake-driver', ['--driver'], { ...opts, env: {} }) }),
    directSpawn: () => {
      const child = new EventEmitter(); child.pid = 701; child.stdout = new PassThrough(); child.stderr = new PassThrough();
      const reply = (r, result, error) => child.stdout.write(JSON.stringify({ protocol: r.protocol, nonce: r.nonce, id: r.id,
        ok: !error, ...error ? { error: { message: 'refused', unhealthy: false, ...error } } : { result } }) + '\n');
      child.stdin = new Writable({ write(bytes, _encoding, done) {
        const r = JSON.parse(bytes); done();
        queueMicrotask(() => {
          if (r.method === 'typeText') {
            state.inputs++; state.inputAt = state.clock + 20;
            if (options.earlyFailure) reply(r, null, { code: 'PERSON_TOOK_OVER', typed: 0 });
            else pending.set(r.id, r);
          } else if (r.method === 'cancel') {
            state.cancellations++;
            reply(r, { cancelled: r.params.id, inFlight: pending.has(r.params.id), code: 'CANCEL_ACK' });
            const job = pending.get(r.params.id);
            if (job) { pending.delete(r.params.id); reply(job, null, { code: 'USER_STOPPED', typed: 1 }); }
          } else if (['turn-start', 'turn-end'].includes(r.method)) reply(r, { turn: r.params.turn, active: r.method === 'turn-start' });
          else { state.reads++; reply(r, { window: fixture, readId: 1, text: '0 window fixture\n1 text area Editor' }); }
        });
      } });
      child.kill = () => assert.fail('no process signals'); return child;
    },
  });
  const context = { rowId, caseId: rowId === 'cancel-frame' ? 'cancel-first' : 'scheduled-key', trial: 0, fixtures: [fixture],
    check: async () => {}, request: async (c, method, target, params = {}) => {
      const tickMs = state.clock;
      const reply = await c.request(method, { ...params, windowId: target.windowId, processStart: target.processStart, bindingId: target.bindingId });
      return { method, tickMs, replyTickMs: state.clock, reply, raw: collector.projectReply(reply) };
    } };
  return { bank, backend, context, state };
}

async function observerWitness(t, api = collector, result = { status: 1, stderr: 'SLEIGHT_UC3F_OBSERVER_READY' }) {
  let bank;
  const observations = syntheticObserver({ startTickMs: 100, durationMs: 1000,
    lease: { row: 'cancel-frame', token, expiresUtc: '2026-11-05T08:00:00.000Z' } });
  const h = makeBackend(t, api, { execute: async (_command, _args, settings) => {
    writeFileSync(join(bank, '1.cancel-frame.observer-1.jsonl'), observations.map(JSON.stringify).join('\n') + '\n');
    settings.onStderr('SLEIGHT_UC3F_OBSERVER_READY'); return result;
  } }); bank = h.bank;
  const expected = { schema: 'sleight.uc3f-vm-record/1', hostName: '192.168.64.8', vmId: 'fixture', manufacturer: 'QEMU',
    model: 'Virtual Machine', build: 26300, hostnameSha256: 'd'.repeat(64), machineGuidSha256: 'e'.repeat(64),
    provenance: { hostname: 'Win32_ComputerSystem.Name', machineGuid: 'HKLM\\SOFTWARE\\Microsoft\\Cryptography\\MachineGuid', encoding: 'sha256:utf8:trim:lowercase' } };
  writeFileSync(join(bank, '1.request.json'), JSON.stringify({ protocol: 'sleight.uc3f-transport/1', operation: 'row',
    invocation: '1', token: 'a'.repeat(16), presence: 'away', vmId: 'fixture', expected,
    payload: { row: { id: 'cancel-frame', presence: 'away' } } }));
  const handle = await h.backend.startObserver({ id: 'cancel-frame' }, { check: async () => {} });
  assert.equal(handle.ready, true);
  await assert.rejects(handle.finish(), error => {
    assert.equal(error.code, result.error?.code ?? 'OBSERVER_PROCESS_FAILED');
    assert.equal(typeof error.observerText, 'string');
    assert.equal(collector.parseGuestLines(error.observerText, 'observer').length, observations.length);
    assert.equal(diagnostics.observerRemoval(observations, { row: 'cancel-frame', token }, '1'), true);
    return true;
  });
  assert.equal(existsSync(join(bank, '1.observer-1.stop.request.json')), true);
}
test('real startObserver.finish reads published proof on exit 1 and ignores only the ready marker', t => observerWitness(t));
test('real observer finish preserves a process error code', t => observerWitness(t, collector,
  { status: 1, stderr: 'SLEIGHT_UC3F_OBSERVER_READY', error: fault('EPIPE') }));
test('broken finish that classifies before reading records fails the observer witness', async t => {
  const broken = await mutated('uc3f-collect.mjs', 'return observerResult(r, text, stopError);', 'return observerResult(r, undefined, stopError);');
  await assert.rejects(observerWitness(t, broken), assert.AssertionError);
});
async function codesWitness(api = diagnostics) {
  const r = { status: 1, stderr: 'SLEIGHT_UC3F_OBSERVER_READY\nACCESS_DENIED\nSLEIGHT_UC3F_OBSERVER_READY', error: fault('EPIPE') };
  assert.throws(() => api.observerResult(r, 'records', fault('EBUSY')), {
    code: 'ACCESS_DENIED', observerText: 'records', detail: { stderr: ['ACCESS_DENIED'], process: 'EPIPE', stop: 'EBUSY' } });
  assert.throws(() => api.observerResult({ status: 0 }, 'records', fault('EACCES')), { code: 'EACCES' });
}
test('observer stderr, process and stop codes remain available together', () => codesWitness());
test('broken observer code filtering fails the diagnostic witness', async () => {
  await assert.rejects(codesWitness(await mutated('uc3f-diagnostics.mjs', 'const detail = { stderr, process:', 'const detail = { stderr: [], process:')), assert.AssertionError);
});

async function cancelWitness(t, api = collector, earlyFailure = false) {
  const h = makeBackend(t, api, { earlyFailure });
  if (earlyFailure) {
    await assert.rejects(h.backend.measure(h.context), { code: 'CANCEL_JOB_ALREADY_FINISHED',
      detail: { job: 'PERSON_TOOK_OVER', cancel: 'CANCEL_ACK', typed: 0 } });
  } else {
    const result = await h.backend.measure(h.context);
    const order = JSON.parse(readFileSync(join(h.bank, 'raw/1.cancel-frame.cancel-order-cancel-first-0.json')));
    assert.equal(order.inputLeadMs, 20);
    assert.match(order.tickClockAssumption, /comparable; unmeasured/);
    assert.equal(result.fixture.postsAfterStop, 2, 'same-tick key delivery is counted conservatively');
    assert.equal(result.driver.at(-2).raw.code, 'USER_STOPPED');
  }
  assert.equal(h.state.cancellations, 1); assert.equal(h.state.inputs, 1);
  return h;
}
test('real cancel measure waits for receiver input and then a fresh stopped snapshot', t => cancelWitness(t));
test('real cancel wait failure still awaits both product replies and records their codes', t => cancelWitness(t, collector, true));
test('broken cancel-wait argument, dropped detail and bypassed stopped snapshot fail behavior', async t => {
  for (const [before, after, early] of [
    ['waitForInput: ({ sent, finished }) =>', 'unused: ({ sent, finished }) =>', false],
    ['leadFailure.detail = { ...leadFailure.detail, job: jobRaw.code, cancel: cancelRaw.code, typed: jobRaw.typed };', '', true],
    ['await stoppedFixture(facts, {', 'await stoppedFixture({ driver: [] }, {', false],
  ]) await assert.rejects(cancelWitness(t, await mutated('uc3f-collect.mjs', before, after), early), assert.AssertionError);
});
async function busyWitness(t, api = collector, diagnosticApi = diagnostics) {
  let clock = 0, reads = 0; const records = [];
  const recorder = diagnosticApi.fileFailureRecorder((name, value) => records.push({ name, ...value }));
  await assert.rejects(diagnosticApi.waitFixtureInput({ sent: { tickMs: 100 }, finished: () => false,
    check: async () => {}, now: () => clock, sleep: async ms => { clock += ms; },
    read: () => api.readPublishedFile('receiver.json', { retries: 0, check: async () => {},
      read: () => { reads++; throw fault('EBUSY'); }, sleep: async () => assert.fail('no nested retries'), audit: recorder.record }) }),
  { code: 'CANCEL_INPUT_NOT_OBSERVED' });
  assert.equal(clock, 2000); assert.equal(reads, 101); assert.equal(records.length, 0);
  recorder.flush(); assert.equal(records.length, 1); assert.equal(records[0].count, 101);
  recorder.record({ path: 'receiver.json', operation: 'read', code: 'EACCES' }); recorder.flush();
  assert.equal(records.length, 2); assert.equal(records[1].code, 'EACCES');
}
test('busy receiver polling stays within 2 seconds and publishes one record for 101 failures', t => busyWitness(t));
test('broken retries and per-poll audit publication fail the bounded polling witness', async t => {
  await assert.rejects(busyWitness(t, await mutated('uc3f-collect.mjs', 'attempt >= retries', 'attempt >= 20')), assert.AssertionError);
  await assert.rejects(busyWitness(t, collector, await mutated('uc3f-diagnostics.mjs', 'if (!diagnostic) return;',
    "if (!diagnostic) return; write('per-poll.json', diagnostic);")), assert.AssertionError);
});
async function auditWitness(t, api = collector) {
  const h = makeBackend(t, api);
  for (let n = 0; n < 1000; n++) h.backend.recordFileFailure({ path: 'receiver.json', operation: 'read', code: 'EBUSY' });
  assert.deepEqual(readdirSync(join(h.bank, 'raw')), []);
  await h.backend.writeRaw('cancel-frame', []);
  const files = readdirSync(join(h.bank, 'raw')).filter(n => n.includes('file-io'));
  assert.equal(files.length, 1); assert.equal(JSON.parse(readFileSync(join(h.bank, 'raw', files[0]))).count, 1000);
}
test('real backend writes one counted evidence file per distinct file failure at the row boundary', t => auditWitness(t));
test('broken row-boundary flush fails the real audit witness', async t => {
  await assert.rejects(auditWitness(t, await mutated('uc3f-collect.mjs', 'fileFailures.flush();', '')), assert.AssertionError);
});

async function foregroundWitness(t, api = collector) {
  const foreign = { ...fixture, pid: 99, process: 'WWAHost', className: 'ApplicationFrameWindow', title: 'Guest setup', isDefault: true };
  const h = makeBackend(t, api, { rowId: 'person-key-before', guestCall: async operation => {
    if (operation === 'register-injector') return {};
    assert.equal(operation, 'foreground'); return foreign;
  } });
  await assert.rejects(h.backend.measure(h.context), { code: 'FOREGROUND_NOT_FIXTURE', detail: { foreground: foreign } });
  assert.deepEqual(JSON.parse(readFileSync(join(h.bank, 'raw/1.person-key-before.foreground-1.json'))), foreign);
  assert.equal(existsSync(join(h.bank, '1.person-key-before.go-1')), false); assert.equal(h.state.inputs, 0);
}
test('real injector go refuses foreign foreground with process, class and title before publishing go', t => foregroundWitness(t));
test('broken go that omits foreground admission fails the behavior witness', async t => {
  const broken = await mutated('uc3f-collect.mjs', 'await requireFixtureForeground(() =>', 'await (() => {}) (() =>');
  await assert.rejects(foregroundWitness(t, broken), assert.AssertionError);
});
async function foregroundTable(api = diagnostics) {
  const own = { ...fixture, process: 'receiver', isDefault: true };
  const records = [];
  await api.requireFixtureForeground(async () => own, r => records.push(r), fixture);
  for (const change of [{ pid: 99 }, { windowId: '102' }, { processStart: '999' }, { className: 'Other' }, { image: 'foreign.exe' }, { isDefault: false }])
    await assert.rejects(api.requireFixtureForeground(async () => ({ ...own, ...change }), r => records.push(r), fixture), { code: 'FOREGROUND_NOT_FIXTURE' });
  assert.equal(records.length, 7);
}
test('foreground admission requires the fixture window, process birth, image, class and Default desktop', () => foregroundTable());
test('broken foreground PID comparison fails the admission table', async () => {
  await assert.rejects(foregroundTable(await mutated('uc3f-diagnostics.mjs', 'foreground.pid !== fixture.pid', 'false')), assert.AssertionError);
});
async function setupWitness(api = diagnostics) {
  const original = fault('WINDOW_NOT_FOUND');
  await assert.rejects(api.recordSetup(async () => { throw original; }, () => { throw fault('EEXIST'); }, 'setup.json', collector.projectReply),
    error => error === original);
}
test('a setup receipt collision preserves the original setup failure', () => setupWitness());
test('broken setup catch masks the original failure and fails its witness', async () => {
  const broken = await mutated('uc3f-diagnostics.mjs',
    'try { write(name, project(error, true)); } catch { /* retain the setup cause if its receipt cannot be written */ }', 'write(name, project(error, true));');
  await assert.rejects(setupWitness(broken), assert.AssertionError);
});
async function windowWitness(api = diagnostics) {
  for (const [window, match] of [[undefined, null], [{ ...fixture, pid: 99 }, false], [fixture, true]]) {
    const raw = api.directReply({ ok: true, window }, fixture, collector.projectReply);
    assert.equal(raw.windowMatched, match); assert.equal(collector.projectReply(raw).windowMatched, match);
    assert.equal(api.readTelemetryFailure([{ method: 'getAXState', raw }]),
      match === null ? 'DRIVER_TELEMETRY_INCOMPLETE' : match === false ? 'FIXTURE_WINDOW_MISMATCH' : undefined);
  }
  assert.deepEqual(api.discoveryWindows([{ ...fixture, text: 'secret', hostedSelectorHashes: ['secret'], screenshot: 'secret' }]),
    [Object.fromEntries(['windowId', 'pid', 'processStart', 'image', 'className', 'title'].map(k => [k, fixture[k]]))]);
}
test('missing, wrong and matched windows have distinct evidence and discovery excludes extra fields', () => windowWitness());
test('broken missing-window value fails the window witness', async () => {
  await assert.rejects(windowWitness(await mutated('uc3f-diagnostics.mjs', '!window ? null', '!window ? false')), assert.AssertionError);
});
async function boundaryWitness(api = diagnostics) {
  const result = await api.stoppedFixture({ driver: [{ method: 'typeText', raw: { ok: false, code: 'USER_STOPPED' }, replyTickMs: 200 }] }, {
    read: async () => ({ tickMs: 300, events: [{ tickMs: 199, message: 0x102 }, { tickMs: 200, message: 0x102 }, { tickMs: 201, message: 0x102 }] }),
    check: async () => {}, sleep: async () => {}, now: () => 0,
  });
  assert.equal(result.postsAfterStop, 2);
}
test('the coarse reply tick counts equal-tick and later delivery', () => boundaryWitness());
test('broken strict tick comparison fails the conservative boundary witness', async () => {
  await assert.rejects(boundaryWitness(await mutated('uc3f-diagnostics.mjs', 'filter(e => e.tickMs >= job.replyTickMs)', 'filter(e => e.tickMs > job.replyTickMs)')), assert.AssertionError);
});

// Execute the native decision's actual shared boolean/string subset. This does
// not parse PowerShell or compile C#, and never loads a native input API.
function injectDecision(source, desktop, foregroundPid) {
  const body = /public static string Decide\([^]*?\) \{([^]*?)\n    \}/.exec(source)?.[1]; assert.ok(body);
  return runInNewContext(`(function(desktop, foregroundPid, fixturePid, identityMatches) {${body}})(desktop, foregroundPid, 42, true)`,
    { desktop, foregroundPid }, { timeout: 100 });
}
function injectorWitness(source) {
  const known = /\$known = @\(([^\n]+)\)/.exec(source)?.[1]; assert.ok(known);
  const allowed = [...known.matchAll(/'([A-Z_]+)'/g)].map(m => m[1]);
  // Evaluate the catch's actual membership expression for direct and wrapped
  // exception messages, with the same bounded inner-exception walk.
  const predicate = /if \((\$innerCode -cin \$known)\)/.exec(source)?.[1]; assert.ok(predicate);
  for (const [desktop, pid, wanted] of [['Default', 99, 'FOREGROUND_NOT_FIXTURE'], ['Winlogon', 42, 'SECURE_DESKTOP_NO_INJECT']]) {
    const native = injectDecision(source, desktop, pid); assert.equal(native, wanted);
    for (const messages of [[native], ['wrapper', native]]) {
      let code = 'GUEST_EXCEPTION_UNCLASSIFIED';
      for (const message of messages.slice(0, 4)) if (runInNewContext(predicate.replace('$innerCode -cin $known', 'known.includes(message)'),
        { known: allowed, message }, { timeout: 100 })) { code = message; break; }
      assert.equal(code, wanted);
    }
  }
}
test('injector native refusal decisions survive direct and wrapped catch classification', () => {
  const source = readFileSync(new URL('uc3f-inject.ps1', root), 'utf8'); injectorWitness(source);
  for (const code of ['FOREGROUND_NOT_FIXTURE', 'SECURE_DESKTOP_NO_INJECT'])
    assert.throws(() => injectorWitness(source.replace(`'${code}',`, '')), assert.AssertionError);
});

// Evaluate stage assignments preceding an injected guest exception and the
// handler's fallback return. The executor does not hard-code a reply code.
async function launchWitness(api = collector) {
  for (const [stage, wanted] of [['Add-Type -TypeDefinition', 'GUEST_EXCEPTION_UNCLASSIFIED'],
    ["$launchFailure = 'FIXTURE_START_FAILED'", 'FIXTURE_RESOLVE_FAILED'],
    ["$launchFailure = 'FIXTURE_WINDOW_NOT_SEEN'", 'FIXTURE_START_FAILED']]) {
    const call = api.powershellCall({ bank: 'C:\\sleight-setup\\uc3f-0123456789abcdef', ownerAway: true }, {
      validateBank() {}, execute: async (_command, _args, { input }) => {
        const untilFailure = input.slice(input.indexOf('try {\n$r ='), input.indexOf(stage));
        const assignments = [...untilFailure.matchAll(/\$launchFailure = '([A-Z_]+)'/g)];
        const fallback = assignments.at(-1)?.[1];
        assert.ok(fallback); assert.ok(input.includes('GuestFailure $_ $launchFailure'));
        const handlerReturn = /return (\$fallback|'[A-Z_]+')\s*\n\}/.exec(input)?.[1]; assert.ok(handlerReturn);
        const code = runInNewContext(handlerReturn.replace('$fallback', 'fallback'), { fallback }, { timeout: 100 });
        return { status: 1, stderr: code };
      },
    });
    await assert.rejects(call('launch', { target: 'edge', args: [] }), { code: wanted });
  }
}
test('launch preamble and launch stages produce their actual fallback codes', () => launchWitness());
test('broken launch default fails the stage witness', async () => {
  const broken = await mutated('uc3f-fixtures.mjs', "$launchFailure = 'GUEST_EXCEPTION_UNCLASSIFIED'", "$launchFailure = 'FIXTURE_RESOLVE_FAILED'");
  await assert.rejects(launchWitness(broken), assert.AssertionError);
});
test('baseline requires an explicit flag before any guest or settings operation and supplies no input', () => {
  const source = readFileSync(new URL('uc3f-guest-baseline.ps1', root), 'utf8');
  const witness = text => {
    const guard = text.indexOf("if (-not $PrepareTestGuest) { throw 'EXPLICIT_BASELINE_FLAG_REQUIRED' }");
    assert.ok(guard > 0 && guard < text.indexOf('Get-CimInstance'));
    assert.ok(text.includes("$env:USERNAME -cne 'sleight-test'"));
    assert.ok(text.includes('if ($SetDefaultForegroundLockTimeout) {'));
    assert.ok(text.includes('-Value 200000'));
    assert.doesNotMatch(text, /SendInput|SendKeys|SetForegroundWindow|Stop-Process|taskkill|\.Kill\(/);
  };
  witness(source);
  assert.throws(() => witness(source.replace("if (-not $PrepareTestGuest) { throw 'EXPLICIT_BASELINE_FLAG_REQUIRED' }", '')), assert.AssertionError);
});
