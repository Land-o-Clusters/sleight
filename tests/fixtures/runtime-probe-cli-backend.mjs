// Synthetic probe boundary for exercising report publication and CLI exit codes.
import { evidence, metadata, receipt, processEvidence, engineReceipt } from '../runtime-gate-fixtures.mjs';

export async function createLiveProbe() {
  const scenario = process.env.RT30_CLI_SCENARIO;
  return {
    metadata,
    inventory: async () => [],
    prepare: async cell => {
      if (scenario === 'stopped') throw Error('FAKE_FIXTURE_FAILED');
      return { id: cell.id };
    },
    waitForEngineIdle: async () => ({ outcome: 'idle', elapsedMs: 0 }),
    trial: async (cell, fixture, index, { runtime, runNonce }) => {
      if (fixture.id !== cell.id) throw Error('FAKE_FIXTURE_CHANGED');
      return { ...evidence(), correct: scenario !== 'incomplete' || index !== 19,
        elapsedMs: runtime === 'engine' ? (scenario === 'fault' ? 49 : 44) : (scenario === 'loss' ? 200 : 30),
        processEvidence: processEvidence(runtime),
        ...(runtime === 'own' ? { runtimeReceipt: receipt(runNonce) } : { engineReceipt: engineReceipt() }) };
    },
    closeFixture: async () => ({ confirmed: true }),
    close: async () => ({ confirmed: scenario !== 'cleanup' }),
  };
}
