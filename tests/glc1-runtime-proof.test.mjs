import test from 'node:test';
import assert from 'node:assert/strict';
import * as proof from '../scripts/glc1-runtime-proof.mjs';
const { proofPlan, proofPreflight, runProof } = proof;
import { armCommand } from '../bench/runtime-arm.mjs';
const prepared = { status: 'ready', origin: 'source', compileMs: 42, elapsedMs: 45 };
const prepare = async () => prepared;

test('information sitting has 3 interleaved attempts per side on exactly the 2 Calculator tasks', () => {
  const plan = proofPlan(); assert.equal(plan.length, 12);
  for (const run of [1, 2, 3]) for (const task of ['calculator-click', 'calculator-menu'])
    assert.deepEqual(plan.filter(row => row.run === run && row.task === task).map(row => row.runtime), run === 2 ? ['own', 'engine'] : ['engine', 'own']);
  for (const row of plan) {
    const cmd = armCommand(row);
    assert.deepEqual(cmd.args.slice(1), ['--suite','world','--arm','sleight','--tasks',row.task,'--runs','1','--model','claude-haiku-5-5','--effort','high','--auth','login','--clean-arms','--owner-away','--no-hub']);
    assert.equal(cmd.env.SLEIGHT_RUNTIME, row.runtime); assert.equal(cmd.env.SLEIGHT_HAND, '0');
  }
});
for (const [paths, message] of [[[], 'OWNER_AWAY_REQUIRED'], [['away', '/tmp/sleight-hold'], 'LIVE_HOLD'],
  [['away', '/tmp/sleight-live.lock'], 'LIVE_LOCK_RETAINED']]) test('live preflight refuses ' + message, async () => {
  let observations = 0;
  await assert.rejects(proofPreflight('away', { exists: p => paths.includes(p), observe: () => { observations++; } }), new RegExp(message));
  assert.equal(observations, 0);
});
test('an on-screen system dialog stops before an attempt and is never answered', async () => {
  let attempts = 0;
  const preflight = marker => proofPreflight(marker, { exists: p => p === 'away', observe: () => ({ process: 'UserNotificationCenter', title: '(untitled)' }) });
  const result = await runProof({ ownerAwayFile: 'away' }, { preflight, prepare, execute: () => { attempts++; } });
  assert.equal(attempts, 0); assert.equal(result.results.length, 0); assert.match(result.stopped, /SYSTEM_DIALOG/);
});
test('a failed task with clean cleanup continues through all 12 attempts', async () => {
  let count = 0;
  const result = await runProof({}, { preflight: () => {}, prepare, execute: () => ({ code: ++count === 1 ? 0 : 1,
    result: { auth: 'login', results: [{ passed: false, groupClean: true }] } }) });
  assert.equal(result.results.length, 12); assert.equal(result.stopped, undefined);
  assert.equal(result.results.filter(r => r.code === 1).length, 11);
  assert.equal(proof.proofExitCode(result), 1, 'a completed sitting still reports task failures');
});
for (const [extra, row, cause] of [
  [{ cancelled: true }, {}, 'CANCELLED'],
  [{ signal: 'SIGINT' }, {}, 'CANCELLED'],
  [{}, { cancelled: true }, 'CANCELLED'],
  [{}, { permissionPrompt: true }, 'PERMISSION_PROMPT'],
  [{}, { cleanupError: 'fixture cleanup failed' }, 'CLEANUP_ERROR'],
  [{}, { groupClean: false }, 'GROUP_UNCLEAN'],
  [{ groupClean: false }, {}, 'GROUP_UNCLEAN'],
]) test('stop cause is labeled ' + cause, async () => {
  const result = await runProof({}, { preflight: () => {}, prepare,
    execute: () => ({ code: 1, ...extra, result: { auth: 'login', results: [row] } }) });
  assert.equal(result.results.length, 1); assert.equal(result.stopped, cause);
});
test('a pass-level cleanup error stops even when the task row itself is clean', async () => {
  for (const cleanup of [{ passCleanupErrors: ['tail cleanup failed'] }, { cleanupDeferred: { receipt: 'retained' } }, { leftWindows: [{ pid: 42, reason: 'still running after Quit' }] }, { leftWindows: [{ pid: 43, dialog: true }] }]) {
    const result = await runProof({}, { preflight: () => {}, prepare,
      execute: () => ({ code: 1, result: { auth: 'login', results: [{ groupClean: true }], ...cleanup } }) });
    assert.equal(result.results.length, 1); assert.equal(result.stopped, 'CLEANUP_ERROR');
  }
});
test('compile-only preparation completes once before any timed attempt and is recorded separately', async () => {
  const events = [];
  const result = await runProof({}, { preflight: () => {}, prepare: async () => { events.push('prepare'); return prepared; },
    execute: () => { events.push('attempt'); return { code: 0, result: { auth: 'login', results: [{}] } }; } });
  assert.deepEqual(events, ['prepare', ...Array(12).fill('attempt')]);
  assert.deepEqual(result.glidePreparation, prepared);
  assert.ok(result.results.every(r => !r.glidePreparation));
});
test('an unavailable compile is recorded and starts no attempts', async () => {
  const result = await runProof({}, { preflight: () => {}, prepare: () => ({ status: 'unavailable', code: 'APPLE_TOOLS_MISSING' }),
    execute: () => assert.fail('no attempt before preparation') });
  assert.equal(result.results.length, 0); assert.match(result.stopped, /GLIDE_PREPARATION_UNAVAILABLE/);
  assert.equal(result.glidePreparation.code, 'APPLE_TOOLS_MISSING');
});
test('a gate that closes during preparation is refreshed before attempt 1', async () => {
  let calls = 0;
  const result = await runProof({}, { preflight: () => { if (++calls > 1) throw Error('OWNER_AWAY_REQUIRED'); }, prepare,
    execute: () => assert.fail('owner returned before attempt') });
  assert.equal(result.results.length, 0); assert.equal(result.stopped, 'OWNER_AWAY_REQUIRED');
  assert.deepEqual(result.glidePreparation, prepared);
});
test('compile failure evidence is retained without a task row', async () => {
  const result = await runProof({}, { preflight: () => {}, prepare: () => { throw Object.assign(Error('compiler failed'), {
    preparation: { status: 'unavailable', compileMs: 123, elapsedMs: 125 },
  }); }, execute: () => assert.fail() });
  assert.equal(result.results.length, 0); assert.equal(result.glidePreparation.compileMs, 123);
  assert.equal(result.stopped, 'compiler failed');
});
test('a missing account-login receipt stops the sitting', async () => {
  const result = await runProof({}, { preflight: () => {}, prepare, execute: () => ({ code: 0 }) });
  assert.equal(result.results.length, 1); assert.match(result.stopped, /receipt unverified/);
});
test('popup smoke plans exactly one own-runtime Calculator menu attempt', async () => {
  const plan = proofPlan({ popupSmoke: true });
  assert.equal(plan.length, 1); assert.equal(plan[0].runtime, 'own'); assert.equal(plan[0].task, 'calculator-popup-smoke');
  const cmd = proof.proofCommand(plan[0], { env: {} });
  assert.equal(cmd.env.SLEIGHT_RUNTIME, 'own'); assert.equal(cmd.env.SLEIGHT_CALCULATOR_POPUP_SMOKE, '1');
  assert.equal(cmd.args[cmd.args.indexOf('--runs') + 1], '1');
  const result = await runProof({ popupSmoke: true }, { preflight: () => {}, prepare,
    execute: () => ({ code: 0, result: { auth: 'login', results: [{}] } }) });
  assert.equal(result.results.length, 1); assert.equal(result.stopped, undefined);
  assert.equal(proof.proofExitCode(result), 0);
});
test('a person app window that appeared mid-pass is kept and does not stop the sitting', async () => {
  const person = { bundle: 'net.imput.helium', pid: 21323, id: 734234, title: 'Window', onScreen: true };
  const result = await runProof({}, { preflight: () => {}, prepare,
    execute: () => ({ code: 0, result: { auth: 'login', results: [{ groupClean: true, fixtureDiagnostics: [{ bundle: 'com.apple.calculator' }] }], leftWindows: [person] } }) });
  assert.equal(result.stopped, undefined); assert.equal(result.results.length, 12);
});
test('a left window of the attempt fixture app still stops as a cleanup error', async () => {
  const result = await runProof({}, { preflight: () => {}, prepare,
    execute: () => ({ code: 0, result: { auth: 'login', results: [{ groupClean: true, fixtureDiagnostics: [{ bundle: 'com.apple.calculator' }] }], leftWindows: [{ bundle: 'com.apple.calculator', pid: 1, id: 2 }] } }) });
  assert.equal(result.stopped, 'CLEANUP_ERROR');
});
