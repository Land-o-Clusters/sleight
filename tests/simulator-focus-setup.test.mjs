import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchSimulatorFocus, shutdownSimulatorFocus } from '../bench/simulator-focus-setup.mjs';

function fixture(failAt) {
  const ctx = {}, calls = [];
  const options = {
    viewer: { app: 'DeviceHub', running: false },
    record(sim) { ctx.persistedOwnership = structuredClone(sim); },
    check() { calls.push('check'); if (failAt === 'hold') throw new Error('hold'); },
    simctl(action, udid) {
      calls.push(action);
      if (action === 'list') return JSON.stringify({ devices: { runtime: [{ name: 'iPhone fixture', udid: 'owned-udid', state: 'Shutdown' }] } });
      assert.equal(udid, 'owned-udid');
      if (action !== 'shutdown') {
        assert.equal(ctx.sim?.udid, 'owned-udid', 'ownership is captured before any boot mutation can fail');
        assert.equal(ctx.sim?.bootAttempted, true);
      }
      if (action === failAt) throw new Error(action + ' failed');
    },
    beginLaunch() { calls.push('begin'); if (failAt === 'begin') throw new Error('begin failed'); },
    openViewer() { calls.push('open'); if (failAt === 'open') throw new Error('open failed'); },
  };
  return { ctx, calls, options };
}

test('a running or unconfirmed viewer refuses before any boot attempt', () => {
  for (const running of [true, undefined]) {
    const { ctx, calls, options } = fixture(); options.viewer.running = running;
    assert.throws(() => launchSimulatorFocus(ctx, options), /viewer.*running|ownership.*unconfirmed/i);
    assert.equal(ctx.sim, undefined);
    assert.deepEqual(calls, []);
  }
});

test('boot, bootstatus, launch-callback and open failures retain the exact boot for cleanup', () => {
  for (const failAt of ['boot', 'bootstatus', 'begin', 'open']) {
    const { ctx, calls, options } = fixture(failAt);
    assert.throws(() => launchSimulatorFocus(ctx, options), /failed/);
    assert.equal(ctx.sim.udid, 'owned-udid');
    assert.equal(ctx.sim.bootAttempted, true);
    assert.equal(ctx.persistedOwnership?.udid, 'owned-udid');
    assert.equal(ctx.persistedOwnership?.bootAttempted, true);
    shutdownSimulatorFocus(ctx, options);
    assert.equal(calls.at(-1), 'shutdown');
    assert.equal(ctx.sim.bootShutdownConfirmed, true);
    shutdownSimulatorFocus(ctx, options);
    assert.equal(calls.filter(action => action === 'shutdown').length, 1);
  }
});

test('a hold before boot performs no mutation, and a hold during cleanup preserves ownership', () => {
  const before = fixture('hold');
  assert.throws(() => launchSimulatorFocus(before.ctx, before.options), /hold/);
  assert.equal(before.calls.includes('boot'), false);
  const after = fixture();
  launchSimulatorFocus(after.ctx, after.options);
  after.options.check = () => { throw new Error('hold'); };
  assert.throws(() => shutdownSimulatorFocus(after.ctx, after.options), /hold/);
  assert.equal(after.ctx.sim.bootAttempted, true);
  assert.equal(after.ctx.sim.bootShutdownConfirmed, undefined);
  assert.equal(after.calls.includes('shutdown'), false);
});

test('hold checks precede boot, bootstatus, launch notification, viewer opening and shutdown', () => {
  const { ctx, calls, options } = fixture();
  launchSimulatorFocus(ctx, options); shutdownSimulatorFocus(ctx, options);
  for (const operation of ['boot', 'bootstatus', 'begin', 'open', 'shutdown']) {
    assert.equal(calls[calls.indexOf(operation) - 1], 'check', operation);
  }
});
