import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTextEditCleanup, cleanupFailedTextEditLaunch } from '../bench/textedit-save-lock-cleanup-run.mjs';

const prior = { started: new Date(100000).toISOString(), finished: new Date(101000).toISOString(),
  failedOperation: { pid: 123 }, lockRetained: true, trials: [], bank: '/private/tmp/sleight-save-lock-fixture' };
function harness({ held = false, holdAfterLock = false, missingLock = false, result = { processQuit: true } } = {}) {
  const calls = [], report = {};
  const io = {
    checkHold: async () => { calls.push('hold'); if (held) { report.holdPresent = true; throw new Error('Live hold exists'); } },
    statLock: async () => { calls.push('stat'); if (missingLock) throw Object.assign(new Error('absent'), { code: 'ENOENT' }); return { isDirectory: () => true, birthtimeMs: 100000, ino: 1, dev: 1 }; },
    acquireLock: async () => { calls.push('acquire'); if (holdAfterLock) held = true; return async () => { calls.push('release'); }; },
    releaseRetained: async () => { calls.push('release'); },
    execute: async () => { calls.push('execute'); return result; },
  };
  return { report, calls, run: inspectOnly => runTextEditCleanup({ prior, report, inspectOnly }, io) };
}
for (const inspectOnly of [true, false]) test(`the cleanup runner checks hold before lock or AX work (${inspectOnly})`, async () => {
  const h = harness({ held: true });
  await assert.rejects(h.run(inspectOnly), /Live hold/);
  assert.deepEqual(h.calls, ['hold']);
});
test('cleanup reacquires an absent lock and releases only after the launch quit', async () => {
  const h = harness({ missingLock: true });
  assert.equal(await h.run(false), true);
  assert.ok(h.calls.indexOf('acquire') < h.calls.indexOf('execute'));
  assert.ok(h.calls.indexOf('execute') < h.calls.indexOf('release'));
  assert.equal(h.report.lockReacquired, true); assert.equal(h.report.lockReleased, true);
});
test('a hold arriving after acquisition blocks AX and releases the unused new lock', async () => {
  const h = harness({ missingLock: true, holdAfterLock: true });
  await assert.rejects(h.run(true), /Live hold/);
  assert.ok(!h.calls.includes('execute')); assert.ok(h.calls.includes('release'));
});
test('closed fixture inspection does not release the lock while the owned launch remains', async () => {
  const h = harness({ result: { readOnly: true, fixtureClosed: true, processQuit: false } });
  assert.equal(await h.run(true), false);
  assert.ok(!h.calls.includes('release')); assert.equal(h.report.lockHeld, true);
});
test('a different retained lock is refused before host work', async () => {
  const h = harness();
  await assert.rejects(runTextEditCleanup({ prior: { ...prior, started: new Date(200000).toISOString(), finished: new Date(201000).toISOString() }, report: {} }, {
    checkHold: async () => {}, statLock: async () => ({ isDirectory: () => true, birthtimeMs: 100000 }), execute: async () => h.calls.push('execute'),
  }), /identity/);
  assert.ok(!h.calls.includes('execute'));
});
test('failed-launch cleanup uses only the current trial PID after earlier completed edits', async () => {
  const trial = { failedOperation: { pid: 456 } }, report = { ...prior, trials: [{ edit: true }, trial] };
  let captured;
  assert.equal(await cleanupFailedTextEditLaunch({ report, trial, bank: prior.bank }, async args => { captured = args; return true; }), true);
  assert.equal(captured.prior.failedOperation.pid, 456);
  assert.deepEqual(captured.prior.trials, [trial]);
});
test('a stale PID from an earlier trial cannot establish cleanup for a later launch', async () => {
  let called = false;
  assert.equal(await cleanupFailedTextEditLaunch({ report: { ...prior }, trial: {}, bank: prior.bank }, async () => { called = true; }), false);
  assert.equal(called, false);
});
test('an edited trial never uses unchanged-seed cleanup', async () => {
  let called = false;
  assert.equal(await cleanupFailedTextEditLaunch({ report: {}, trial: { edit: true, failedOperation: { pid: 456 } }, bank: prior.bank }, async () => { called = true; }), false);
  assert.equal(called, false);
});
test('failed owned-launch cleanup records the refusal instead of claiming completion', async () => {
  const report = {};
  assert.equal(await cleanupFailedTextEditLaunch({ report, trial: { failedOperation: { pid: 456 } }, bank: prior.bank }, async () => { throw new Error('Live hold exists'); }), false);
  assert.equal(report.failedLaunchCleanup.error, 'Live hold exists');
});
