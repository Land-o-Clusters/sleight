import { replWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

test('traced smoke needs explicit Calculator approval before constructing a client', async () => {
  const { runTracedSmoke } = await import('../plugins/sleight/lib/repl/smoke.mjs');
  let made = 0;
  await assert.rejects(() => runTracedSmoke({ approvedCalculator: false, createClient: () => { made++; } }), /CALCULATOR_APPROVAL_REQUIRED/);
  assert.equal(made, 0);
});

test('traced smoke runs the fixed acquisition through the real worker and closes its client', { skip: replWorkerSkip }, async () => {
  const { runTracedSmoke } = await import('../plugins/sleight/lib/repl/smoke.mjs');
  const requests = [], traces = [];
  let closes = 0;
  const window = { windowId: '101', processStart: 'opaque:start', pid: 120, bundleId: 'com.apple.calculator',
    app: 'Calculator', title: 'Calculator', identityVerified: true };
  const driver = { async request(method, params) {
    requests.push({ method, params });
    return { window, readId: 1, text: 'Window: "Calculator", App: Calculator.\n0 standard window Calculator', truncated: false };
  }, async restart() {}, async close() { closes++; } };
  const result = await runTracedSmoke({ approvedCalculator: true, driver, trace: event => traces.push(event) });
  assert.equal(result.isError, false);
  assert.ok(result.content.some(item => item.type === 'text' && /^Window: "Calculator", App: Calculator\./.test(item.text)),
    'the acquisition tree remains present beside runtime notices');
  // API1B's first result ends with the handle line; the tree item still carries the header guards search for.
  assert.ok(result.content.some(item => /^Window: "Calculator", App: Calculator\./m.test(item.text ?? '')));
  assert.match(result.content.at(-1).text, /^Handle: /);
  assert.deepEqual(requests, [{ method: 'getApp', params: { selector: 'Calculator' } }]);
  assert.equal(closes, 1);
  assert.deepEqual(traces.map(row => row.event), ['start', 'driver-request', 'driver-result', 'result', 'closed']);
  assert.ok(traces.every(row => Number.isFinite(row.elapsedMs)));
  assert.doesNotMatch(JSON.stringify(traces), /Window:|standard window|opaque:start/);
});

test('traced smoke refuses a different app identity and still closes', { skip: replWorkerSkip }, async () => {
  const { runTracedSmoke } = await import('../plugins/sleight/lib/repl/smoke.mjs');
  let closes = 0;
  const driver = { request: async () => ({ window: { bundleId: 'com.example.Other' }, text: 'private fixture', readId: 1 }),
    async restart() {}, async close() { closes++; } };
  const result = await runTracedSmoke({ approvedCalculator: true, driver, trace() {} });
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), /private fixture/);
  assert.match(JSON.stringify(result), /IDENTITY_CHANGED/);
  assert.equal(closes, 1);
});
