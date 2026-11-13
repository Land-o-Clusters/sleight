import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTurns } from '../scripts/tx1-turn-study.mjs';

const call = (message, id, name, input) => ({ type: 'assistant', message: { id: message, content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, text, is_error = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error }] } });
const answer = { type: 'assistant', message: { id: 'final', content: [{ type: 'text', text: 'Done' }] } };

test('turn accounting deduplicates streamed blocks and keeps parallel useful calls', () => {
  const screenshot = call('m1', 'c1', 'browser_read', { tab: 't1', screenshot: true });
  const row = projectTurns([screenshot, screenshot, result('c1', 'Snapshot\nScreenshot 640x480 px'), call('m1', 'c2', 'browser_act', { tab: 't1', steps: [{ do: 'viewport' }] }), result('c2', 'Restored'), answer]);
  assert.equal(row.messages, 2); assert.equal(row.calls, 2);
  assert.equal(row.projectedMessages, 2); assert.equal(row.projectedCalls, 2);
  const missing = projectTurns([screenshot, result('c1', 'Snapshot\nScreenshot skipped: protected fields'), answer]);
  assert.equal(missing.projectedCalls, 1); assert.deepEqual(missing.removedCalls, []);
});

test('a successful image-only read stays in the projection because Claude receives the image', () => {
  const row = projectTurns([
    call('m1', 'image', 'browser_read', { tab: 't1', screenshot: true }),
    result('image', 'Snapshot\nScreenshot 640x480 px'), answer,
  ]);
  assert.equal(row.projectedMessages, 2); assert.equal(row.projectedCalls, 1);
  assert.deepEqual(row.removedCalls, []); assert.deepEqual(row.removedMessages, []);
});

test('projection retains every handoff, decline and screenshot-bearing viewport action', () => {
  const row = projectTurns([
    call('m1', 'cookie', 'browser_act', { tab: 't1', steps: [{ do: 'click', ref: 'e1' }] }), result('cookie', 'Decline confirmed'),
    call('m2', 'fill', 'browser_fill', { tab: 't1', fields: [{ ref: 'e2', value: 'Ada' }] }), result('fill', 'Filled'),
    call('m3', 'hand', 'browser_tabs', { tab: 't1', do: 'handoff', wait: true }), result('hand', 'Away'),
    call('m4', 'view', 'browser_act', { tab: 't1', steps: [{ do: 'viewport', width: 390, height: 844 }], observe: 'screenshot' }), result('view', 'Snapshot'), answer,
  ]);
  assert.equal(row.projectedCalls, 4); assert.equal(row.projectedMessages, 4);
  assert.equal(row.handoffAndKeepCallsRetained, 1); assert.equal(row.cookieDeclinesKept, 1); assert.equal(row.viewportScreenshotsKept, 1);
});

test('projection only removes the two named refusals with successful retries', () => {
  const row = projectTurns([
    call('m1', 'url', 'browser_act', { tab: 't1', steps: [{ do: 'navigate', url: 'https://example.invalid/' }] }), result('url', 'navigate with url is only for a stuck tab; use a link ref or browser_open'),
    call('m2', 'typo', 'browser_read', { tab: 'tt1' }), result('typo', 'unknown or releasing owned tab.', true),
    call('retry-url', 'opened', 'browser_open', { url: 'https://example.invalid/' }), result('opened', 't1 https://example.invalid\nSnapshot'),
    call('retry-handle', 'read', 'browser_read', { tab: 't1' }), result('read', 'Snapshot'),
    call('m3', 'payment', 'browser_act', { tab: 't1', steps: [{ do: 'click', ref: 'e2' }] }), result('payment', 'confirmation required', true),
    call('m4', 'subtree', 'browser_read', { tab: 't1', screenshot: true, ref: 'e1' }), result('subtree', 'Snapshot'),
    call('m5', 'failed', 'browser_read', { tab: 't1', screenshot: true }), result('failed', 'Protected fields', true), answer,
  ]);
  assert.deepEqual(row.removedCalls, ['url', 'typo']);
  assert.equal(row.projectedMessages, 6); assert.equal(row.projectedCalls, 5);
});

test('a refusal without a recorded successful retry never creates a simulated saving', () => {
  const row = projectTurns([
    call('m1', 'url', 'browser_act', { tab: 't1', steps: [{ do: 'navigate', url: 'https://example.invalid/' }] }), result('url', 'navigate with url is only for a stuck tab'),
    call('m2', 'typo', 'browser_read', { tab: 'tt1' }), result('typo', 'unknown or releasing owned tab.', true), answer,
  ]);
  assert.equal(row.candidates.urlRefusal.length, 1); assert.equal(row.candidates.handleRefusal.length, 1);
  assert.deepEqual(row.removedCalls, []); assert.equal(row.projectedMessages, 3); assert.equal(row.projectedCalls, 2);
});

test('decline never moves across another tab or into a read', () => {
  for (const [tool, tab] of [['browser_fill', 't2'], ['browser_read', 't1']]) {
    const row = projectTurns([call('m1', 'cookie', 'browser_act', { tab: 't1', steps: [] }), result('cookie', 'Decline confirmed'), call('m2', 'next', tool, { tab }), answer]);
    assert.deepEqual(row.candidates.cookieTurn, []);
    assert.equal(row.projectedMessages, 3);
  }
});
