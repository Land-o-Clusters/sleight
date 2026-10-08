import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardTrialTiming } from '../bench/guard-reads-events.mjs';

test('engine requests with a colliding ID cannot end a measured call', () => {
  const events = [
    { direction: 'to-server', id: 1, t: 0 },
    { direction: 'from-server', id: 1, method: 'elicitation/create', t: 10 },
    { direction: 'guard-read', phase: 'after-call', ms: 30, chars: 50, failed: false },
    { direction: 'from-server', id: 1, t: 100 },
  ];
  assert.equal(guardTrialTiming(events).engineMs, 100);
  assert.equal(guardTrialTiming(events).guardMs, 30);
  assert.equal(guardTrialTiming(events.slice(0, -1)).engineMs, null);
});
