import assert from 'node:assert/strict';
import { createCompoundRecovery } from '../../plugins/sleight/lib/mac-driver/compound/recovery.mjs';
import { stuckEscapeOption } from '../../plugins/sleight/lib/stuck-escape.mjs';
const appId = 'test.compound.App';
const target = { appId, app: 'Fixture', title: 'Draft', nativeIdentity: { epoch: 'e', window: 42, pid: 123, processStart: 7 } };
export function recoveryFixture(options = {}) {
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
