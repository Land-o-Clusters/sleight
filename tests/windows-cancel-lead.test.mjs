import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as collector from '../bench/windows/uc3f-collect.mjs';

async function contract(api = collector, stop = false) {
  let clock = 0, settleJob, pending = false, cancelled = 0, checks = 0;
  const frames = [], target = { windowId: '101', processStart: '134000000000000000' };
  const client = { frames: () => frames, request(method) {
    if (method === 'typeText') {
      pending = true; frames.push({ kind: 'sent', method, id: 4, tickMs: clock });
      return new Promise(resolve => { settleJob = resolve; });
    }
    assert.equal(method, 'cancel'); cancelled++;
    frames.push({ kind: 'sent', method, id: 5, tickMs: clock }, { kind: 'reply', method, id: 5, tickMs: clock + 1 },
      { kind: 'reply', method: 'typeText', id: 4, tickMs: clock + 2 });
    pending = false;
    settleJob({ typed: clock >= 100 ? 1 : 0, counters: { postedMessages: clock >= 100 ? 1 : 0 } });
    return Promise.resolve({ cancelled: 4, inFlight: true });
  } };
  const run = api.runCancelTrial({ client, target, readId: 1, order: 'cancel-first', tick: () => clock, now: () => clock,
    sleep: async ms => { clock += ms; }, check: async () => {
      checks++; if (stop && checks > 1) throw Object.assign(Error('LEASE_EXPIRED'), { code: 'LEASE_EXPIRED' });
    } });
  if (stop) await assert.rejects(run, { code: 'LEASE_EXPIRED' });
  else {
    const result = await run;
    assert.equal(result.driver[0].raw.typed, 1); assert.equal(result.driver[0].raw.counters.postedMessages, 1);
    assert.equal(result.driver[1].tickMs, 100); assert.equal(result.parent.flagMs, 1);
    assert.equal(result.orderEvidence.inputLeadMs, 100);
  }
  assert.equal(cancelled, 1); assert.equal(pending, false);
}
test('the fallback measures frame-send to cancel-send time separately from cancel acknowledgment', () => contract());
test('a stop during the lead still cancels and reaps the exact outstanding job', () => contract(collector, true));
test('removing the input lead fails the behavior witness', async () => {
  const url = new URL('../bench/windows/uc3f-collect.mjs', import.meta.url), original = readFileSync(url, 'utf8');
  const before = 'await sleep(100); await check();'; assert.ok(original.includes(before));
  const source = original.replace(before, 'await check();').replace(/from '(\.\.?\/[^']+)'/g, (_m, path) => `from '${new URL(path, url).href}'`)
    .replaceAll('import.meta.url', JSON.stringify(url.href));
  const broken = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  await assert.rejects(contract(broken), assert.AssertionError);
});
