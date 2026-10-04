import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionVerdict } from '../bench/action-notes-verdict.mjs';

const task = { id: 'calculator-click', app: 'Calculator' };
const init = { type: 'system', subtype: 'init', mcp_servers: [{ name: 'plugin:sleight:computer', status: 'connected' }] };
const use = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'click', input: { code: 'await app.click(10)' } }] } };
const result = { type: 'result', is_error: false, result: '391' };
const reply = (text, is_error = false) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'click', is_error, content: [{ type: 'text', text }] }] } });

test('a calculated answer after engine failure cannot pass a live Calculator task', () => {
  const verdict = actionVerdict([init, use, reply('sandbox_apply: Operation not permitted', true), result], task, true, { code: 0 });
  assert.equal(verdict.passed, false);
});

test('a successful click and returned display verify Calculator independently of the answer', () => {
  const events = [init, use, reply('Window: "Calculator", App: Calculator.\n0 standard window Calculator\n2 text Description: Edit field, Value: 391'), result];
  assert.equal(actionVerdict(events, task, true, { code: 0 }).passed, true);
  assert.equal(actionVerdict(events, task, true, { code: 0, cancelled: true }).passed, false);
  assert.equal(actionVerdict(events, task, false, { code: 0 }).passed, false);
  assert.equal(actionVerdict(events, task, true, { code: 1 }).passed, false);
});

test('other servers, failed snapshots and missing action evidence invalidate a trial', () => {
  const display = '2 text Description: Edit field, Value: 391';
  const leaked = { ...init, mcp_servers: [...init.mcp_servers, { name: 'other', status: 'connected' }] };
  assert.equal(actionVerdict([leaked, use, reply(display), result], task, true, { code: 0 }).passed, false);
  assert.equal(actionVerdict([init, use, reply(display, true), result], task, true, { code: 0 }).passed, false);
  assert.equal(actionVerdict([init, reply(display), result], task, true, { code: 0 }).passed, false);
});
