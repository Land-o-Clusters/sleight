import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompoundRecovery } from '../plugins/sleight/lib/mac-driver/compound/recovery.mjs';
import { stuckEscapeOption } from '../plugins/sleight/lib/stuck-escape.mjs';
import { compoundFixture } from './fixtures/compound-runtime.mjs';

const appId = 'test.compound.App';
const target = { appId, app: 'Fixture', title: 'Draft', nativeIdentity: { epoch: 'e', window: 42, pid: 123, processStart: 7 } };
function recoveryFixture(options = {}) {
  const h = { runs: 0, authorized: true, idle: 10, pid: 123, start: 7 };
  const option = stuckEscapeOption(options.disabled ? { SLEIGHT_STUCK_ESCAPE: '0' } : {}, {
    identity: async () => ({ status: 'ok', matches: 1, headerMatches: 1, appId, title: 'Draft', epoch: 'e', window: 42,
      pid: h.pid, processStart: h.start, hidIdleSeconds: h.idle }),
    run: async (name, params) => { assert.equal(name, 'stuck-escape.js'); assert.equal(params.pid, 123); h.runs++;
      return { ok: true, posted: true, selected: false }; },
  });
  h.recovery = createCompoundRecovery({ option, authorize: async () => h.authorized });
  h.request = { receipt: { state: 'stopped', stop: { reason: 'EFFECT_UNVERIFIED' } }, target,
    grant: { path: '/fixture-only/lease', token: 'owned' }, since: 0, clock: () => 1000,
    personQuiet: true, modalAbsent: true, originalBinding: true };
  h.arm = () => { h.recovery.observeExternal('external-1', appId, { stuck: true }); h.recovery.observeExternal('external-2', appId, { stuck: true }); };
  return h;
}
test('internal compound reads cannot advance the actual two-external-call Escape coordinator', async () => {
  const h = recoveryFixture(), compound = compoundFixture(); compound.suppressEffect = true;
  h.request.receipt = await compound.run(); assert.equal(compound.mutations.length, 1);
  assert.equal((await h.recovery.recover(h.request)).attempted, false); assert.equal(h.runs, 0);
  h.recovery.observeExternal('same-external', appId, { stuck: true });
  h.recovery.observeExternal('same-external', appId, { stuck: true });
  assert.equal((await h.recovery.recover(h.request)).attempted, false);
  h.recovery.observeExternal('second-external', appId, { stuck: true });
  const result = await h.recovery.recover(h.request); assert.equal(result.posted, true); assert.equal(result.continuation, false);
  assert.equal(h.runs, 1); assert.equal((await h.recovery.recover(h.request)).attempted, false);
  assert.equal(compound.mutations.length, 1);
});
for (const [name, configure] of [
  ['disable flag', h => { h.disabled = true; }], ['revoked approval', h => { h.authorized = false; }],
  ['new sheet', h => { h.request.modalAbsent = false; }], ['wrong binding', h => { h.request.originalBinding = false; }],
  ['global HID activity', h => { h.request.personQuiet = false; }], ['wrong PID', h => { h.pid = 999; }],
  ['recycled process start', h => { h.start = 8; }], ['late HID input at real coordinator', h => { h.idle = 0.1; }],
  ['latched takeover', h => { h.request.receipt.stop.reason = 'PERSON_TOOK_OVER'; }],
]) test(`separate recovery refuses ${name} without a continuation`, async () => {
  const h = recoveryFixture({ disabled: name === 'disable flag' }); configure(h); h.arm();
  const r = await h.recovery.recover(h.request); assert.equal(r.posted, false); assert.equal(h.runs, 0);
});
test('a prior Escape cannot be rearmed by repeated external results in the same episode', async () => {
  const h = recoveryFixture(); h.arm(); assert.equal((await h.recovery.recover(h.request)).posted, true);
  h.recovery.observeExternal('third', appId, { stuck: true }); h.recovery.observeExternal('fourth', appId, { stuck: true });
  assert.equal((await h.recovery.recover(h.request)).attempted, false); assert.equal(h.runs, 1);
});
