import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ownerAwayPlan, runOwnerAway, sessionApproval, OBSERVED_KINDS } from '../bench/runtime-owner-away.mjs';
import { vmPlan, runVMSitting, verifyGuest } from '../bench/windows/rt31-sitting.mjs';

test('owner-away value order excludes and explains the lock probe', () => {
  const plan = ownerAwayPlan();
  assert.deepEqual(plan.probes.map(p => p.id), [1, 6, 2, 3, 4, 5, 8, 9, 10]);
  assert.deepEqual(plan.skipped.map(p => p.id), [7]);
  assert.match(plan.skipped[0].reason, /owner.*unlock/i);
  assert.equal(plan.expectedMinutes, 30);
});
test('owner-away CLI dry run loads no host backend and prints all nine probes', () => {
  const r = spawnSync(process.execPath, ['--import', './tests/fixtures/runtime-probe-cli-guard.mjs', 'bench/runtime-probe-live.mjs', '--owner-away', '--sitting', '--dry-run'], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).probes.map(p => p.id), [1, 6, 2, 3, 4, 5, 8, 9, 10]);
});
test('observation CLI dry run prints every measured kind without loading a backend', () => {
  const r = spawnSync(process.execPath, ['--import', './tests/fixtures/runtime-probe-cli-guard.mjs', 'bench/runtime-probe-live.mjs', '--owner-away', '--sitting', '--observe-only', '--dry-run'], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.seconds, 60); assert.deepEqual(plan.callKinds, OBSERVED_KINDS);
  assert.equal(plan.rounds, 3); assert.equal(plan.engineCalls, 30); assert.equal(plan.launches, 3);
  assert.match(plan.command, /--observe-only/); assert.doesNotMatch(plan.command, /--dry-run/);
});
test('VM fixture-only dry run advertises zero posts and no rows', () => {
  const r = spawnSync(process.execPath, ['bench/windows/rt31-sitting.mjs', '--owner-away', '--fixture-check-only', '--dry-run'], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.deepEqual(plan.rows, []); assert.deepEqual(plan.counts, { posts: 0 });
});

function runtimeFake(stop) {
  const calls = [];
  let n = 0;
  return { calls, async start() {}, async check() { if (++n === 3 && stop) throw Error(stop); },
    async probe(p) { calls.push(p.id); return { recorded: true }; }, async close() { return { confirmed: true }; } };
}
test('offline runtime fake executes all nine probes and cleans up', async () => {
  const backend = runtimeFake();
  const r = await runOwnerAway({ backend });
  assert.deepEqual(backend.calls, [1, 6, 2, 3, 4, 5, 8, 9, 10]);
  assert.equal(r.completed, true); assert.equal(r.cleanupConfirmed, true);
  assert.equal(r.qualification, false); assert.equal(r.skipped[0].id, 7);
});
for (const reason of ['PERMISSION_PROMPT', 'FRONTMOST_CHANGED', 'FOREIGN_WINDOW', 'PERSON_ACTIVE', 'TIMED_WINDOW_HOLD', 'WINDOW_BLOCKED', 'GUARD_STALE']) {
  test(`runtime sitting stops without replay on ${reason}`, async () => {
    const backend = runtimeFake(reason), r = await runOwnerAway({ backend });
    assert.equal(r.stop, reason); assert.equal(r.completed, false);
    assert.ok(backend.calls.length < 2); assert.equal(r.cleanupConfirmed, true);
  });
}
test('failed cleanup prevents a completed sitting', async () => {
  const backend = runtimeFake(); backend.close = async () => ({ confirmed: false });
  const r = await runOwnerAway({ backend });
  assert.equal(r.completed, false); assert.equal(r.stop, 'CLEANUP_UNCONFIRMED');
});
test('witness approval is session only and uses the benchmark allowlist', async () => {
  const { WITNESS } = await import('../bench/runtime-owner-away.mjs');
  for (const app of [WITNESS.name, WITNESS.bundle]) {
    const p = { message: `Allow Computer Use to use "${app}"?`, requestedSchema: { properties: { choice: { enum: ['session', 'always', 'decline'] } } } };
    assert.deepEqual(sessionApproval(p), { action: 'accept', content: { choice: 'session' } });
    assert.throws(() => sessionApproval({ ...p, requestedSchema: { properties: { choice: { enum: ['always'] } } } }), /APPROVAL_REFUSED/);
  }
  assert.throws(() => sessionApproval({ message: 'Allow Computer Use to use "Mail"?' }), /APPROVAL_REFUSED/);
});

test('current remember approvals choose This session and refuse every unsupported form', () => {
  const p = { message: 'Allow Computer Use to use "Calculator"?', mode: 'form', requestedSchema: {
    type: 'object', properties: { remember: { type: 'string', enum: ['This session', 'Always'] } }, required: ['remember'],
  } };
  assert.deepEqual(sessionApproval(p), { action: 'accept', content: { remember: 'This session' } });
  for (const patch of [
    { mode: 'url' }, { message: 'Confirm purchase' }, { message: 'Allow Computer Use to use "Mail"?' },
    { requestedSchema: { properties: { remember: { enum: ['Always'] } } } },
    { requestedSchema: { properties: { remember: { enum: ['This session'] }, choice: { enum: ['session'] } } } },
    { requestedSchema: { properties: { remember: { enum: ['This session'] }, extra: {} } } },
    { requestedSchema: { properties: { remember: { enum: ['This session'] } }, required: ['password'] } },
    { requestedSchema: { properties: { remember: { enum: 'This session' } } } },
  ]) assert.throws(() => sessionApproval({ ...p, ...patch }), /APPROVAL_REFUSED/);
});

const guest = { fixture: true, text: '0123456789', caret: 0, selectionLength: 0, processStart: 'fixed', windowId: '42',
  captureOff: true, layout: '00000409' };
function vmFake(stopAt, reason) {
  const calls = []; let checks = 0;
  return { calls, async start() { return guest; }, async check() { if (++checks === stopAt) throw Error(reason); },
    async read() { return guest; }, async row(row) { calls.push(row.id); return { code: 0, records: [{ ok: true, pending: 0, beliefCleared: true, maxCriticalSectionMs: 50 }] }; },
    async restore() { calls.push('restore'); return { confirmed: true, ...guest }; }, async close() { return { confirmed: true }; } };
}
test('VM plan contains only two moves, two clicks and two mapped-key groups', () => {
  const plan = vmPlan();
  assert.deepEqual(plan.rows.map(r => r.row), ['move', 'move', 'click', 'click', 'mapped-keys', 'belief-keys']);
  assert.deepEqual(plan.counts, { moves: 2, clicks: 2, mappedKeyPairs: 6, beliefIntervals: 1, unicodePairs: 0 });
  assert.equal(plan.expectedMinutes, 9);
});
test('VM fixture checks require exact text, caret, US layout and capture off', () => {
  assert.doesNotThrow(() => verifyGuest(guest, guest, true));
  for (const patch of [{ text: 'private' }, { caret: null }, { selectionLength: 1 }, { layout: '00000809' }, { captureOff: false }, { processStart: 'other' }, { windowId: '43' }, { fixture: false }]) {
    assert.throws(() => verifyGuest({ ...guest, ...patch }, guest, true));
  }
});
test('VM fake records each guest effect and restores', async () => {
  const backend = vmFake(), r = await runVMSitting({ backend });
  assert.equal(r.completed, true); assert.equal(r.rows.length, 6);
  assert.equal(r.rows[0].guestAfter.text, guest.text);
  assert.equal(r.restore.confirmed, true); assert.equal(backend.calls.at(-1), 'restore');
});
for (const reason of ['UTM_NOT_UNCOVERED', 'CAPTURE_ON', 'NOTEPAD_NOT_FIXTURE', 'PERSON_ACTIVE', 'FRONTMOST_CHANGED', 'WINDOW_BLOCKED', 'TIMED_WINDOW_HOLD']) {
  test(`VM refuses before input on ${reason}`, async () => {
    const backend = vmFake(1, reason), r = await runVMSitting({ backend });
    assert.equal(r.stop, reason); assert.equal(backend.calls.filter(c => c !== 'restore').length, 0);
    assert.equal(r.completed, false);
  });
}
test('VM release uncertainty stops all later rows and is retained', async () => {
  const backend = vmFake(); backend.row = async () => ({ code: 1, records: [{ ok: false, pending: 1, beliefCleared: false, reason: 'CLEANUP_UNCONFIRMED' }] });
  const r = await runVMSitting({ backend });
  assert.equal(r.rows.length, 1); assert.equal(r.stop, 'CLEANUP_UNCONFIRMED');
});
test('new repository files have no lane gate, home or ledger dependency', () => {
  for (const file of ['bench/runtime-owner-away.mjs', 'bench/windows/rt31-sitting.mjs', 'bench/windows/rt31-guest.ps1', 'bench/windows/rt31-guest-read.mjs']) {
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, new RegExp(/\/Users\/|ledger\/|bench\/run\.mjs/.source + '|' + ['lanes', 'may', 'test'].join('-')));
  }
});

test('measurement-only sitting runs three OS2 probes and lists attended setup', async () => {
  const plan = ownerAwayPlan({ measurementsOnly: true });
  assert.equal(plan.expectedMinutes, 4); assert.equal(plan.maximumMinutes, 10);
  assert.deepEqual(plan.probes.map(p => p.id), [8, 9, 10]);
  assert.equal(plan.attended.length, 2);
  const backend = runtimeFake();
  const report = await runOwnerAway({ backend, measurementsOnly: true });
  assert.deepEqual(backend.calls, [8, 9, 10]); assert.equal(report.completed, true);
  assert.equal(report.measurementsOnly, true);
});
test('measurement-only CLI dry run is guarded and rejects observe-only combination', () => {
  const args = ['--import', './tests/fixtures/runtime-probe-cli-guard.mjs', 'bench/runtime-probe-live.mjs', '--owner-away', '--sitting', '--measurements-only', '--dry-run'];
  const r = spawnSync(process.execPath, args, { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.deepEqual(plan.probes.map(p => p.id), [8, 9, 10]);
  assert.equal(plan.measurementsOnly, true); assert.equal(plan.observationRequired, true);
  assert.equal(plan.includeChrome, false);
  const opted = spawnSync(process.execPath, [...args, '--include-chrome'], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 10000 });
  assert.equal(opted.status, 0, opted.stderr); assert.equal(JSON.parse(opted.stdout).includeChrome, true);
  const invalid = spawnSync(process.execPath, [...args, '--observe-only'], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 10000 });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /INVALID_OPTION_COMBINATION/);
});

test('observation rejects include-chrome before loading the host backend', () => {
  const r = spawnSync(process.execPath, ['--import', './tests/fixtures/runtime-probe-cli-guard.mjs',
    'bench/runtime-probe-live.mjs', '--owner-away', '--sitting', '--observe-only', '--include-chrome', '--dry-run'],
  { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--include-chrome cannot be used with --observe-only/);
  assert.equal(r.stdout, '');
});

for (const failed of [false, true]) test(`top-level delivery evidence survives probe 9 failure ${failed}`, async () => {
  const backend = runtimeFake();
  const evidence = { deliveryMeasured: !failed, unmeasured: failed ? ['off-space', 'split-view'] : ['split-view'] };
  backend.probe = async p => {
    if (p.id !== 9) return {};
    if (failed) throw Error('DELIVERY_STATE_CHANGED');
    return evidence;
  };
  backend.snapshot = () => evidence;
  const report = await runOwnerAway({ backend, measurementsOnly: true });
  assert.equal(report.deliveryMeasured, !failed);
  assert.deepEqual(report.unmeasured, evidence.unmeasured);
  assert.equal(report.completed, !failed);
});
