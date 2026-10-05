import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requirePendingKill, killHelper, requireIdleKill, inspectHelperProcesses } from '../bench/helper-kill-protocol.mjs';

test('process inspection resolves the managed wrapper in the current user home', async () => {
  const result = await inspectHelperProcesses([123, 456], async (command, args) => {
    assert.equal(command, '/private/tmp/helper-test-home/.codex/bin/codex-macos-inspect');
    assert.deepEqual(args, ['process-status', '123', '456']);
    return { stdout: '[{"pid":123},{"pid":456}]' };
  }, '/private/tmp/helper-test-home');
  assert.deepEqual(result, [{ pid: 123 }, { pid: 456 }]);
});

test('a completed call or idle signal cannot count as an in-call kill trial', () => {
  for (const result of [{ killed: null }, { killed: { pending: [] } }]) {
    assert.throws(() => requirePendingKill(result), /pending request/);
  }
  assert.doesNotThrow(() => requirePendingKill({ killed: { pending: [3] } }));
});

test('cancelled experiments never signal the shared helper', () => {
  const signals = [];
  const signal = (...args) => signals.push(args);
  assert.throws(() => killHelper(123, true, signal), /cancelled/);
  assert.deepEqual(signals, []);
  killHelper(123, false, signal);
  assert.deepEqual(signals, [[123, 'SIGKILL']]);
});

test('a cancelled idle stage cannot pass without a kill receipt', () => {
  assert.throws(() => requireIdleKill(undefined), /kill receipt/);
  assert.doesNotThrow(() => requireIdleKill({ pid: 123 }));
});
