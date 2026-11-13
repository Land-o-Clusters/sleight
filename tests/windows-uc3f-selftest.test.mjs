import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { parseArgs, vmPlan } from '../bench/windows/uc3f-sitting.mjs';
import * as production from '../bench/windows/uc3f-selftest.mjs';
import { VM_RECORD_PROVENANCE, UC3F_BLOCK_SECONDS } from '../bench/windows/uc3f-rows.mjs';
import { fixtureTargets, collectorPlan, GUEST_OPERATIONS, validateTransportRequest, runTransportRequest } from '../bench/windows/uc3f-collect.mjs';

const url = new URL('../bench/windows/uc3f-selftest.mjs', import.meta.url);
const variants = {
  'drop-calculator': ["'terminal', 'calculator-refused'", "'terminal'"],
  'stop-first': ['return undefined;', 'throw error;'],
  'skip-identity': ['assertFixture(await backend.inspect(fixture), fixtures);', ''],
  'skip-guard': ['await backend.guard();', ''],
  'skip-hook-proof': ["if (!hookRemoved) throw Error('HOOK_REMOVAL_UNCONFIRMED');", ''],
  'skip-end': ["await record('end-record', () => backend.writeRaw(job.rowId, [end]), { cleanup: true });", ''],
};
const variant = process.env.UC3ST1_BROKEN;
let module = production;
if (variant) {
  const [before, after] = variants[variant];
  const source = readFileSync(url, 'utf8');
  assert.ok(source.includes(before));
  module = await import('data:text/javascript;base64,' + Buffer.from(source.replace(before, after)
    .replace(/from '(\.\.?\/[^']+)'/g, (_s, path) => `from '${new URL(path, url).href}'`)).toString('base64'));
}
const { guestSelftestPlan, runGuestSelftest, selftestTable, validateSelftestJob } = module;
const fixture = target => ({ target, pid: 4, processStart: '134381325118728105', image: 'C:\\receiver.exe', windowId: '44',
  title: 'Sleight WDR7 WPF', className: 'HwndWrapper', integrity: 'medium', sessionId: 1, desktop: 'Default' });
function fake(failures = {}) {
  const calls = [], records = [];
  const lease = { row: 'person-idle', presence: 'away', token: 'a'.repeat(32), expiresUtc: new Date(800000).toISOString() };
  const work = (name, result) => async () => { calls.push(name); if (failures[name]) throw Object.assign(Error(failures[name]), { code: failures[name] }); return result; };
  const backend = {
    now: () => 1000, guard: work('guard'), lease: async () => lease,
    preflight: work('preflight'), readiness: work('readiness', { unlocked: true, connected: true }), desktop: work('desktop', { isDefault: true }),
    available: work('available', { installed: !failures.missingFirefox }),
    async setup(row, { register }) { calls.push('setup'); register(fixture('notepad')); register({ ...fixture('wpf'), pid: 5, windowId: '45' }); if (failures.setup) throw Error(failures.setup); },
    async inspect(f) { calls.push('inspect'); if (failures.inspect) throw Error(failures.inspect); return f; },
    startObserver: work('observer-start', { ready: true, invocation: '1', finish: work('observer-stop', JSON.stringify({
      schema: 'sleight.windows-uc3f-observer/2', kind: 'end', tickMs: 1000, seq: 1, keyboardHookInstalled: true, mouseHookInstalled: true,
      keyboardHookRemoved: !failures.hook, mouseHookRemoved: true, hookRemoved: !failures.hook, keyboardHookError: 0, mouseHookError: 0,
      truncated: false, callbackError: false, pollError: false, diskError: false, stopReason: 'completed', records: 2, pollCount: 1,
    })) }),
    selftestInjector: work('injector', { code: 'GO_TIMEOUT', sentInputs: 0 }), removeTasks: work('tasks'),
    async closeFixture(f) { calls.push('close-' + f.target); if (failures['close-' + f.target]) throw Error(failures['close-' + f.target]); },
    stopLaunched: work('stop-launched'), removeRenamedCopy: work('files'), closeClients: work('clients'), cleanupCheck: work('verify', {
      fixturePids: [], tasks: [], bankFiles: [], renamedCopies: [], hookRemoved: !failures.hook, sessionRestored: true,
    }),
    async writeRaw(id, rows) { calls.push('write'); records.push(...rows); },
    measure() { assert.fail('self-test must not drive a trial'); }, readGo() { assert.fail('self-test must not create a go file'); },
  };
  return { backend, calls, records, o: { revision: 'b'.repeat(40), ownerAway: true, lease }, job: guestSelftestPlan()[0] };
}

test('plan covers seven fixtures and every row setup including the split present setup', () => {
  const plan = guestSelftestPlan();
  assert.equal(plan.length, 27);
  assert.deepEqual(plan.filter(j => j.target).map(j => j.target), ['notepad', 'wpf', 'cover', 'edge', 'firefox', 'terminal', 'calculator-refused']);
  assert.deepEqual(plan.filter(j => !j.target && !j.presentCases).map(j => j.rowId), collectorPlan().map(r => r.id));
  assert.equal(plan.at(-1).presentCases, true);
  assert.deepEqual(fixtureTargets(collectorPlan(['direct-launch-override'])[0]), ['terminal']);
});
test('CLI requires away and refuses row selection or guard-only in diagnostic mode', () => {
  const options = parseArgs(['--guest-selftest', '--owner-away', '--dry-run']);
  assert.equal(vmPlan(options).trials, 0);
  assert.equal(vmPlan(options).blockSeconds, UC3F_BLOCK_SECONDS.away);
  assert.equal(vmPlan(options).sendsInput, false);
  for (const args of [['--owner-present'], ['--owner-away', '--rows', 'person-idle'], ['--owner-away', '--guard-only']])
    assert.throws(() => parseArgs(['--guest-selftest', ...args]));
});
test('single-job diagnostics preserve the away guard and explicitly report incomplete suite coverage', () => {
  const options = parseArgs(['--guest-selftest', '--owner-away', '--guest-selftest-job', 'setup-browser-refused-renamed']);
  const audit = makePlan => {
    const plan = makePlan(options);
    assert.equal(plan.jobs.length, 1);
    assert.equal(plan.jobs[0].id, 'setup-browser-refused-renamed');
    assert.equal(plan.diagnosticOnly, true);
    assert.equal(plan.fullJobCount, 27);
    assert.equal(plan.sendsInput, false); assert.equal(plan.trials, 0);
  };
  audit(vmPlan);
  assert.equal(vmPlan({ ownerAway: true, guestSelftest: true }).jobs.length, 27);
  for (const change of [{ ownerAway: false, ownerPresent: true }, { guestSelftest: false },
    { selftestJob: 'invalid' }, { rows: ['person-idle'] }, { guardOnly: true }])
    assert.throws(() => vmPlan({ ...options, ...change }));
  const body = vmPlan.toString(), before = 'fullJobs.filter(job => job.id === options.selftestJob)';
  assert.ok(body.includes(before));
  const broken = Function('guestSelftestPlan', 'UC3F_BLOCK_SECONDS', 'SELFTEST_SCHEMA',
    `return (${body.replace(before, 'fullJobs')})`)(guestSelftestPlan, UC3F_BLOCK_SECONDS, production.SELFTEST_SCHEMA);
  assert.throws(() => audit(broken), assert.AssertionError);
});
test('lifecycle emits no trials, checks identities, leaves fixtures for snapshot restore, and writes an end record', async () => {
  const f = fake(), result = await runGuestSelftest(f.o, f.job, f.backend);
  assert.equal(result.operations.filter(r => r.status === 'fail').length, 0);
  assert.equal(result.hookRemoved, true);
  assert.equal(result.trials, 0);
  assert.deepEqual(f.calls.filter(c => c.startsWith('close-')), []);
  assert.equal(f.calls.filter(c => c === 'inspect').length, 2);
  assert.ok(f.calls.filter(c => c === 'guard').length >= 6);
  assert.ok(!f.calls.includes('stop-launched'));
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].trials, 0);
  assert.equal(f.records[0].sentInputs, 0);
});
test('partial setup failures retain later observer and client results', async () => {
  const f = fake({ setup: 'FIXTURE_ALREADY_RUNNING', 'close-notepad': 'FIXTURE_CLOSE_TIMEOUT' });
  const result = await runGuestSelftest(f.o, f.job, f.backend);
  assert.equal(result.operations.filter(r => r.status === 'fail').length, 1);
  for (const call of ['readiness', 'desktop', 'observer-start', 'injector', 'observer-stop', 'clients', 'write']) assert.ok(f.calls.includes(call), call);
});

test('a foreign window blocks later setup work and workers while every cleanup stage still runs', async () => {
  const f = fake({ setup: 'FOREIGN_WINDOW' });
  const result = await runGuestSelftest(f.o, f.job, f.backend);
  assert.ok(!f.calls.includes('observer-start'));
  assert.ok(!f.calls.includes('injector'));
  assert.ok(!f.calls.includes('close-notepad'));
  assert.ok(!f.calls.includes('stop-launched'));
  assert.ok(result.operations.some(r => r.code === 'FOREIGN_WINDOW'));

});
test('a failed preflight blocks launches and workers while retaining diagnostic and cleanup results', async () => {
  const f = fake({ preflight: 'KIT_HASH_MISMATCH' }), result = await runGuestSelftest(f.o, f.job, f.backend);
  assert.ok(!f.calls.includes('setup'));
  assert.ok(!f.calls.includes('observer-start'));
  assert.ok(!f.calls.includes('injector'));
  assert.ok(f.calls.includes('readiness'));
  assert.ok(f.calls.includes('write'));
  assert.ok(result.operations.some(r => r.code === 'KIT_HASH_MISMATCH'));
});
test('missing Firefox is named without setup and still exercises the observer and cleanup', async () => {
  const f = fake({ missingFirefox: true }); f.job = guestSelftestPlan().find(j => j.target === 'firefox');
  const result = await runGuestSelftest(f.o, f.job, f.backend);
  assert.ok(result.operations.some(r => r.code === 'FIREFOX_NOT_INSTALLED'));
  assert.ok(!f.calls.includes('setup'));
  assert.ok(f.calls.includes('observer-start'));
});
test('every optional fixture and row setup records a skip and completes cleanup when absent', async () => {
  for (const job of guestSelftestPlan().filter(j => j.target === 'firefox' || j.rowId === 'browser-refused-firefox' || j.target === 'terminal')) {
    const f = fake(); f.job = job; f.backend.available = async () => ({ installed: false });
    const result = await runGuestSelftest(f.o, f.job, f.backend);
    assert.equal(result.operations.some(r => r.status === 'fail'), false);
    assert.equal(result.hookRemoved, true);
    assert.equal(production.selftestOutcome(result), 'skip');
    assert.ok(!f.calls.includes('setup'));
  }
  const f = fake(), result = await runGuestSelftest(f.o, f.job, f.backend);
  assert.equal(production.selftestOutcome(result), 'pass');
  result.operations.push({ operation: 'setup', status: 'skip', code: 'FIREFOX_NOT_INSTALLED' });
  result.operations.push({ operation: 'cleanup', status: 'fail', code: 'CLEANUP_UNPROVED' });
  assert.equal(production.selftestOutcome(result), 'fail');
  const text = readFileSync(url, 'utf8');
  for (const [before, after] of [["['edge', 'firefox', 'terminal', 'calculator-refused'].includes(t)", "false"],
    ["? 'skip' : 'pass'", "? 'pass' : 'pass'"]]) {
    assert.ok(text.includes(before));
    const mod = await import('data:text/javascript;base64,' + Buffer.from(text.replace(before, after)
      .replace(/from '(\.\.?\/[^']+)'/g, (_s, path) => `from '${new URL(path, url).href}'`)).toString('base64'));
    const f = fake({ missingFirefox: true }); f.job = guestSelftestPlan().find(j => j.target === 'firefox');
    const result = await mod.runGuestSelftest(f.o, f.job, f.backend);
    assert.notEqual(mod.selftestOutcome(result), 'skip');
  }
});
test('hook removal failure remains visible in worker and cleanup records', async () => {
  const f = fake({ hook: true });
  const result = await runGuestSelftest(f.o, f.job, f.backend);
  assert.equal(result.hookRemoved, false);
  assert.ok(result.operations.some(r => r.operation === 'observer-stop' && r.status === 'fail'));
});
test('empty, malformed or incomplete guest tables cannot pass', async () => {
  const f = fake(), value = await runGuestSelftest(f.o, f.job, f.backend);
  assert.equal(validateSelftestJob(value, f.job), value);
  for (const patch of [{ operations: [] }, { trials: 1 }, { hookRemoved: undefined }, { job: 'wrong' }])
    assert.throws(() => validateSelftestJob({ ...value, ...patch }, f.job), /SELFTEST_REPLY_INVALID/);
});
test('multi-fixture diagnostics retain more than 64 operations with a 128-operation ceiling', async () => {
  const f = fake(), value = await runGuestSelftest(f.o, f.job, f.backend);
  const audit = validate => {
    const table = { ...value, operations: [...value.operations] };
    while (table.operations.length < 73) table.operations.push({ operation: 'guest-stop-launched', status: 'pass', code: 'OK' });
    assert.equal(validate(table, f.job), table);
    while (table.operations.length < 128) table.operations.push({ operation: 'guest-stop-launched', status: 'pass', code: 'OK' });
    assert.equal(validate(table, f.job), table);
    table.operations.push({ operation: 'guest-stop-launched', status: 'pass', code: 'OK' });
    assert.throws(() => validate(table, f.job), /SELFTEST_REPLY_INVALID/);
  };
  audit(validateSelftestJob);
  const body = production.validateSelftestJob.toString();
  for (const replacement of ['value.operations.length > 64', 'false']) {
    assert.ok(body.includes('value.operations.length > 128'));
    const broken = Function('SELFTEST_SCHEMA', `return (${body.replace('value.operations.length > 128', replacement)})`)(production.SELFTEST_SCHEMA);
    assert.throws(() => audit(broken));
  }
});

test('one printable table preserves every fixed operation code', () => {
  assert.match(selftestTable({ selftest: [{ id: 'fixture-wpf', operations: [{ operation: 'setup', status: 'fail', code: 'FIXTURE_MISSING' }] }] }), /fixture-wpf \| setup \| fail \| FIXTURE_MISSING/);
});
test('injector self-test starts the production scheduled worker with no go write or input call', () => {
  const source = readFileSync(new URL('../bench/windows/uc3f-collect.mjs', import.meta.url), 'utf8');
  const body = source.split('async selftestInjector')[1].split('async preflight')[0];
  assert.match(body, /psCall\('register-injector'/);
  assert.match(body, /'-WaitMs', '100'/);
  assert.match(body, /code !== 'GO_TIMEOUT'/);
  assert.match(body, /sentInputs !== 0/);
  assert.doesNotMatch(body, /writeFileSync|typeText|SendInput|\.go\(/);
  assert.match(GUEST_OPERATIONS, /'available'/);
});
if (!variant) test('each broken runner variant fails its regression assertions', () => {
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'uc3st1-mutations-')));
  try {
    const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
    for (const name of Object.keys(variants)) {
      const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=900000', new URL(import.meta.url).pathname], {
        env: { ...childEnv, UC3ST1_BROKEN: name }, timeout: 60000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
      });
      assert.equal(r.status, 1, `${name}: ${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /not ok/);
      console.log(`${name}: exit=${r.status} tests=${/^# tests (\d+)/m.exec(r.stdout)?.[1]} pass=${/^# pass (\d+)/m.exec(r.stdout)?.[1]} fail=${/^# fail (\d+)/m.exec(r.stdout)?.[1]}`);
    }
  } finally { removeTemp(directory); }
});


function selftestRequest() {
  return { protocol: 'sleight.uc3f-transport/1', operation: 'selftest', invocation: '1', token: '0123456789abcdef', presence: 'away', vmId: 'fixture-vm',
    expected: { schema: 'sleight.uc3f-vm-record/1', hostName: '192.168.64.8', vmId: 'fixture-vm', manufacturer: 'QEMU', model: 'Virtual Machine', build: 26200,
      hostnameSha256: 'a'.repeat(64), machineGuidSha256: 'b'.repeat(64), provenance: VM_RECORD_PROVENANCE },
    payload: { job: production.guestSelftestPlan()[0], row: { id: 'person-idle', presence: 'away' } } };
}
test('self-test request validation refuses widened targets, presence, rows and payload keys', () => {
  const valid = selftestRequest();
  assert.equal(validateTransportRequest(valid, '1', valid.token), valid);
  for (const mutate of [r => r.payload.job.target = 'calculator', r => r.presence = 'present', r => r.payload.row.id = 'uac-hint',
    r => r.payload.extra = true, r => r.payload.job.extra = true]) {
    const broken = structuredClone(valid); mutate(broken);
    assert.throws(() => validateTransportRequest(broken, '1', valid.token));
  }
});
test('file transport runs the diagnostic lifecycle and writes zero-trial results without collecting rows', async () => {
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'uc3st1-request-')));
  try {
    const bank = join(directory, 'uc3f-0123456789abcdef'), root = join(directory, 'kit');
    mkdirSync(bank); mkdirSync(root);
    const request = selftestRequest(), input = join(bank, '1.request.json'), output = join(bank, '1.value.json');
    writeFileSync(input, JSON.stringify(request));
    writeFileSync(join(root, 'guest-manifest.json'), JSON.stringify({ commit: 'b'.repeat(40) }));
    const f = fake();
    const result = await runTransportRequest(['--transport-request', input, '--transport-result', output], {
      platform: 'win32', now: () => 1000, root, validateBank() {}, createBackend(o) {
        assert.equal(o.selftestTarget, 'notepad');
        assert.equal(typeof o.beforeInput, 'function');
        const preflight = f.backend.preflight;
        f.backend.preflight = async () => { await assert.rejects(o.beforeInput(), { code: 'SELFTEST_INPUT_REFUSED' }); return preflight(); };
        return f.backend;
      },
    });
    assert.equal(result.value.job, 'fixture-notepad');
    assert.equal(result.value.trials, 0);
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).schema, 'sleight.uc3f-guest-selftest/1');
    assert.equal(f.records.length, 1);
  } finally { removeTemp(directory); }
});
test('cover launch uses an absolute kit script even when the scheduled task has another working directory', () => {
  const source = readFileSync(new URL('../bench/windows/uc3f-collect.mjs', import.meta.url), 'utf8');
  const audit = text => assert.match(text, /arg === 'bench\/windows\/fixtures\/driver-wpf\.ps1' \? win32\.join\(root, arg\)/);
  audit(source);
  assert.throws(() => audit(source.replace('win32.join(root, arg)', 'arg')), assert.AssertionError);
});
