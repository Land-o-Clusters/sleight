import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

test('belief lifecycle with fake AX, frontmost state, clock and event transport', {
  skip: process.platform !== 'darwin', timeout: 300000,
}, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-focus-machine-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'focus.swift'), binary = join(root, 'focus');
  await writeFile(source, await readFile(new URL('../plugins/sleight/lib/mac-driver/native/DriverFocusBelief.swift', import.meta.url), 'utf8') + '\n' +
    await readFile(new URL('./fixtures/mac-driver-focus-machine.swift', import.meta.url), 'utf8'));
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-module-cache-path', join(root, 'modules'), source, '-o', binary], {
    killSignal: 'SIGKILL', encoding: 'utf8', timeout: 240000, maxBuffer: 65536,
  });
  assert.equal(compile.status, 0, compile.stderr);
  const run = control => {
    const result = spawnSync(binary, [], { input: JSON.stringify(control) + '\n', killSignal: 'SIGKILL', encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const reply = JSON.parse(result.stdout);
    for (const trace of reply.traces ?? []) {
      for (const key of ['elapsedMs', 'guardMs', 'snapshotMs', 'beliefMs', 'restoreMs']) {
        assert.equal(typeof trace[key], 'number', key); assert.ok(trace[key] >= 0, key);
      }
    }
    return reply;
  };
  for (const [control, metric] of [['guardDelayMs', 'guardMs'], ['snapshotDelayMs', 'snapshotMs'],
    ['beliefDelayMs', 'beliefMs'], ['actualRestoreDelayMs', 'restoreMs']]) {
    await t.test(`trace attributes fake clock time to ${metric}`, () => {
      const r = run({ [control]: 5, ...metric === 'restoreMs' ? { targetAtCleanup: true } : {} });
      assert.equal(r.ok, true);
      assert.ok(r.traces[0][metric] > 0, JSON.stringify(r.traces));
      for (const other of ['guardMs', 'snapshotMs', 'beliefMs', 'restoreMs'].filter(key => key !== metric))
        assert.equal(r.traces[0][other], 0, other);
      assert.ok(r.traces[0].elapsedMs >= r.traces[0][metric]);
    });
  }
  await t.test('belief arrives within 150 ms and clears after the chord', () => {
    const r = run({});
    assert.equal(r.ok, true); assert.equal(r.keys, 3); assert.deepEqual(r.posts, ['activate', 'deactivate']);
    assert.equal(r.result.focusChanged, false); assert.equal(r.result.focusRestored, false);
    assert.equal(r.elapsedMs, 20);
    assert.equal(r.result.fakeActiveMs, 20);
    assert.deepEqual(r.traces.map(({ event, fakeActiveMs, beliefCleared }) => ({ event, fakeActiveMs, beliefCleared })), [{ event: 'keyboard-belief', fakeActiveMs: 20, beliefCleared: true }]);
  });
  for (const alreadyFront of [false, true]) await t.test(`unused frontmost failure leaves a clean call clean (alreadyFront=${alreadyFront})`, () => {
    const r = run({ frontmostThrows: true, alreadyFront });
    assert.equal(r.ok, true); assert.equal(r.keys, 3); assert.equal(r.frontmostCalls, 0);
    assert.equal(r.result.focusChanged, false); assert.equal(r.result.focusRestored, false);
    assert.equal(r.restores, 0);
  });
  await t.test('two frontmost failures still call the guarded restore once', () => {
    const r = run({ frontmostThrows: true, targetAtCleanup: true });
    assert.equal(r.ok, true); assert.equal(r.keys, 3); assert.equal(r.frontmostCalls, 2);
    assert.equal(r.elapsedMs, 40);
    assert.equal(r.restoreCalls, 1);
    assert.equal(r.result.focusChanged, true); assert.equal(r.result.focusRestored, true); assert.equal(r.restores, 1);
    assert.deepEqual(r.traces.map(({ event, fakeActiveMs, beliefCleared }) => ({ event, fakeActiveMs, beliefCleared })), [{ event: 'keyboard-belief', fakeActiveMs: 20, beliefCleared: true }]);
  });
  await t.test('one frontmost failure retries after 20 ms and restores the original app once', () => {
    const r = run({ frontmostFailures: 1, targetAtCleanup: true });
    assert.equal(r.ok, true); assert.equal(r.keys, 3); assert.equal(r.frontmostCalls, 2);
    assert.equal(r.elapsedMs, 40); assert.equal(r.restores, 1);
    assert.equal(r.result.focusChanged, true); assert.equal(r.result.focusRestored, true);
    assert.deepEqual(r.traces.map(({ event, fakeActiveMs, beliefCleared }) => ({ event, fakeActiveMs, beliefCleared })), [{ event: 'keyboard-belief', fakeActiveMs: 20, beliefCleared: true }]);
  });
  for (const failures of [1, 2]) await t.test(`cleanup snapshot failure and ${failures} frontmost failures still restore`, () => {
    const r = run({ snapshotThrowsCleanup: true, frontmostFailures: failures });
    assert.equal(r.ok, false); assert.equal(r.error.code, 'AX_UNAVAILABLE'); assert.equal(r.error.unhealthy, true);
    assert.equal(r.frontmostCalls, 2); assert.equal(r.restores, 1);
    assert.equal(r.error.focusChanged, true); assert.equal(r.error.focusRestored, true);
  });
  for (const control of ['frontDuringRetry', 'processDuringRetry', 'personDuringRetry']) {
    await t.test(`${control} prevents restoration after a successful retry`, () => {
      const r = run({ frontmostFailures: 1, targetAtCleanup: true, [control]: true });
      assert.equal(r.ok, true); assert.equal(r.frontmostCalls, 2); assert.equal(r.elapsedMs, 40);
      assert.equal(r.restores, 0); assert.equal(r.result.focusChanged, true);
      assert.equal(r.result.focusRestored, false);
    });
  }
  for (const control of ['frontDuringRetry', 'personDuringRetry']) {
    await t.test(`${control} still prevents restoration when both advisory reads fail`, () => {
      const r = run({ frontmostThrows: true, targetAtCleanup: true, [control]: true });
      assert.equal(r.ok, true); assert.equal(r.frontmostCalls, 2); assert.equal(r.restores, 0);
      assert.equal(r.restoreCalls, control === 'frontDuringRetry' ? 1 : 0);
      assert.equal(r.result.focusChanged, true); assert.equal(r.result.focusRestored, false);
    });
  }
  await t.test('whole fake-active interval accepts 400 ms and aborts at 401 ms before the next key', () => {
    const boundary = run({ bodyAtMs: 400 });
    assert.equal(boundary.ok, true); assert.equal(boundary.result.fakeActiveMs, 400);
    const late = run({ bodyAtMs: 401 });
    assert.equal(late.error.code, 'KEY_FOCUS_UNAVAILABLE'); assert.equal(late.keys, 1);
    assert.equal(late.error.message, 'KEY_FOCUS_UNAVAILABLE step=active-interval');
    assert.equal(late.traces[0].fault, late.error.message);
    assert.equal(late.error.fakeActiveMs, 401); assert.equal(late.error.unhealthy, false);
    assert.deepEqual(late.posts, ['activate', 'deactivate']);
    assert.deepEqual(late.traces.map(({ event, fakeActiveMs, beliefCleared }) => ({ event, fakeActiveMs, beliefCleared })), [{ event: 'keyboard-belief', fakeActiveMs: 401, beliefCleared: true }]);
  });
  await t.test('activation transport stall takes the restore path without sending keys', () => {
    const r = run({ activationDelayMs: 401 });
    assert.equal(r.error.code, 'KEY_FOCUS_UNAVAILABLE'); assert.equal(r.keys, 0);
    assert.equal(r.error.fakeActiveMs, 401); assert.deepEqual(r.posts, ['activate', 'deactivate']);
  });
  await t.test('a stall after the last key cannot return success', () => {
    const r = run({ afterLastKeyMs: 381 });
    assert.equal(r.error.code, 'KEY_FOCUS_UNAVAILABLE'); assert.equal(r.keys, 3);
    assert.equal(r.error.fakeActiveMs, 401); assert.deepEqual(r.posts, ['activate', 'deactivate']);
  });
  await t.test('the whole interval includes the restore belief read', () => {
    const r = run({ bodyDelayMs: 300, restoreDelayMs: 81 });
    assert.equal(r.error.code, 'KEY_FOCUS_UNAVAILABLE'); assert.equal(r.error.fakeActiveMs, 401);
    assert.equal(r.error.unhealthy, false); assert.equal(r.traces[0].beliefCleared, true);
  });
  await t.test('interval abort still restores an accidental real activation', () => {
    const r = run({ bodyAtMs: 401, targetFront: true });
    assert.equal(r.error.code, 'KEY_FOCUS_UNAVAILABLE'); assert.equal(r.keys, 1);
    assert.equal(r.error.focusRestored, true); assert.equal(r.restores, 1);
    assert.deepEqual(r.posts, ['activate', 'deactivate']);
  });
  await t.test('timeout sends no chord and still deactivates', () => {
    const r = run({ timeout: true });
    assert.equal(r.error.code, 'KEY_FOCUS_UNAVAILABLE'); assert.equal(r.keys, 0);
    assert.deepEqual(r.posts, ['activate', 'deactivate']); assert.ok(r.elapsedMs >= 150 && r.elapsedMs <= 151);
    assert.equal(r.error.message, 'KEY_FOCUS_UNAVAILABLE step=belief');
    assert.equal(r.traces[0].fault, r.error.message);
  });
  for (const control of ['frontChange', 'windowChange']) await t.test(`${control} aborts before the next key and deactivates`, () => {
    const r = run({ [control]: true });
    assert.equal(r.error.code, 'PERSON_TOOK_OVER'); assert.equal(r.error.focusChanged, true);
    assert.equal(r.keys, 1); assert.deepEqual(r.posts, ['activate', 'deactivate']); assert.equal(r.restores, 0);
  });
  await t.test('accidental target activation restores the previous front app once', () => {
    const r = run({ targetFront: true });
    assert.equal(r.error.code, 'PERSON_TOOK_OVER'); assert.equal(r.error.focusChanged, true);
    assert.equal(r.error.focusRestored, true); assert.equal(r.restores, 1); assert.equal(r.keys, 1);
  });
  await t.test('a person Cmd-Tabs to the target and keeps focus there', () => {
    const r = run({ targetFront: true, personKey: true });
    assert.equal(r.error.code, 'PERSON_TOOK_OVER'); assert.equal(r.error.focusChanged, true);
    assert.equal(r.error.focusRestored, false); assert.equal(r.restores, 0); assert.equal(r.keys, 1);
  });
  await t.test('cleanup AX snapshot failure still restores from frontmost process identity', () => {
    const r = run({ snapshotThrowsCleanup: true });
    assert.equal(r.error.unhealthy, true); assert.equal(r.error.focusRestored, true); assert.equal(r.restores, 1);
    assert.equal(r.traces[0].beliefCleared, false); assert.equal(r.traces[0].fakeActiveMs, r.error.fakeActiveMs); assert.ok(r.error.fakeActiveMs >= 20);
  });
  for (const control of ['bodyThrows', 'activationThrows']) await t.test(`${control} still deactivates`, () => {
    const r = run({ [control]: true });
    assert.equal(r.error.code, 'AX_UNAVAILABLE'); assert.deepEqual(r.posts, ['activate', 'deactivate']);
  });
  await t.test('uncleared belief retires the helper', () => {
    const r = run({ stuck: true });
    assert.equal(r.ok, false); assert.equal(r.error.code, 'KEY_FOCUS_UNAVAILABLE'); assert.equal(r.error.unhealthy, true);
    assert.deepEqual(r.posts, ['activate', 'deactivate']); assert.equal(r.keys, 3);
    assert.equal(r.traces[0].beliefCleared, false); assert.equal(r.traces[0].fakeActiveMs, r.error.fakeActiveMs); assert.ok(r.error.fakeActiveMs >= 150);
    assert.equal(r.error.message, 'KEY_FOCUS_UNAVAILABLE step=clear-belief');
  });
  await t.test('lost process identity prevents even cleanup posts to that pid', () => {
    const r = run({ identityLost: true });
    assert.equal(r.error.code, 'IDENTITY_CHANGED'); assert.equal(r.error.unhealthy, true);
    assert.deepEqual(r.posts, ['activate']); assert.equal(r.keys, 0);
    assert.equal(r.traces[0].beliefCleared, false); assert.equal(r.traces[0].fakeActiveMs, r.error.fakeActiveMs); assert.ok(r.error.fakeActiveMs >= 7);
  });
  await t.test('an already frontmost target never receives a fake deactivation', () => {
    const r = run({ alreadyFront: true, bodyDelayMs: 1000 });
    assert.equal(r.ok, true); assert.equal(r.keys, 3); assert.deepEqual(r.posts, []);
    assert.equal(r.result.fakeActiveMs, 0); assert.deepEqual(r.traces, []);
  });
  await t.test('Caps Lock alone does not claim a person holds a physical modifier', () => {
    const r = run({ held: 0x10000 }); assert.equal(r.ok, true); assert.equal(r.keys, 3);
  });
  await t.test('belief at the 150 ms boundary is accepted and 151 ms is refused', () => {
    assert.equal(run({ beliefAtMs: 150 }).ok, true);
    const late = run({ beliefAtMs: 151 });
    assert.equal(late.error.code, 'KEY_FOCUS_UNAVAILABLE'); assert.equal(late.keys, 0);
  });
  await t.test('frontmost change while awaiting belief aborts before every key', () => {
    const r = run({ frontDuringBelief: true });
    assert.equal(r.error.code, 'PERSON_TOOK_OVER'); assert.equal(r.keys, 0);
    assert.deepEqual(r.posts, ['activate', 'deactivate']);
  });
  await t.test('a focused-window change during restoration is reported', () => {
    const r = run({ windowDuringRestore: true });
    assert.equal(r.ok, true); assert.equal(r.result.focusChanged, true); assert.equal(r.keys, 3);
  });
  await t.test('deactivation transport failure retires the helper', () => {
    const r = run({ deactivationThrows: true });
    assert.equal(r.error.code, 'AX_UNAVAILABLE'); assert.equal(r.error.unhealthy, true);
    assert.deepEqual(r.posts, ['activate', 'deactivate']);
    assert.equal(r.traces[0].beliefCleared, false); assert.equal(r.traces[0].fakeActiveMs, r.error.fakeActiveMs); assert.ok(r.error.fakeActiveMs >= 20);
  });
  for (const prepareThrowsAt of [1, 2]) await t.test(`preparation failure ${prepareThrowsAt} never activates`, () => {
    const r = run({ prepareThrowsAt }); assert.equal(r.error.code, 'AX_UNAVAILABLE'); assert.deepEqual(r.posts, []);
  });
  for (const checkThrowsAt of [1, 2, 5, 7]) await t.test(`guard failure ${checkThrowsAt} restores any attempted activation`, () => {
    const r = run({ checkThrowsAt }); assert.equal(r.error.code, 'DEADLINE_EXCEEDED');
    assert.deepEqual(r.posts, checkThrowsAt === 1 ? [] : ['activate', 'deactivate']);
  });
  for (const [control, code] of [['secureMid', 'SECURE_INPUT_ACTIVE'], ['heldMid', 'PERSON_HOLDS_MODIFIER']]) {
    await t.test(`${control} aborts before the next key`, () => {
      const r = run({ [control]: true }); assert.equal(r.error.code, code); assert.equal(r.keys, 1);
      assert.deepEqual(r.posts, ['activate', 'deactivate']);
    });
  }
  for (const control of [{ secure: true }, ...[0x20000, 0x40000, 0x80000, 0x100000, 0x800000].map(held => ({ held }))]) {
    await t.test(`precheck ${JSON.stringify(control)} sends nothing`, () => {
      const r = run(control);
      assert.equal(r.error.code, control.secure ? 'SECURE_INPUT_ACTIVE' : 'PERSON_HOLDS_MODIFIER');
      assert.equal(r.keys, 0); assert.deepEqual(r.posts, []);
    });
  }
});


test('every native focus refusal names a fixed step and never formats user data', async () => {
  for (const file of ['DriverFocusBelief', 'DriverKeyboard', 'DriverTree', 'DriverSemantic']) {
    const source = await readFile(new URL(`../plugins/sleight/lib/mac-driver/native/${file}.swift`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /DriverFault\("KEY_FOCUS_UNAVAILABLE"\s*\)/);
    for (const match of source.matchAll(/"KEY_FOCUS_UNAVAILABLE step=([^"\n]+)"/g)) {
      assert.match(match[1], /^[a-z]+(?:-[a-z]+)*$/, file);
    }
  }
});
