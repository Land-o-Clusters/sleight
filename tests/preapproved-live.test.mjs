import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgePreapproval } from '../bench/preapproved-result.mjs';

const event = (direction, msg) => ({ direction, msg });
const initialized = event('to-client', { id: 1, result: { protocolVersion: '2025-06-18' } });
const grant = event('preapproved-app', { app: 'com.apple.calculator', riskLevel: 'low', tool: 'engine' });
const displayed = value => event('to-client', { id: 3, result: { content: [{ type: 'text', text:
  `Window: "Calculator", App: Calculator\n1 text entry area Value: ${value}\n2 button 1` },
  { type: 'text', text: "com.apple.calculator was pre-approved by the user's list." }] } });
const transcript = [
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'clicks', name: 'mcp__sleight__js', input: { code: 'await app.click(1); await app.click(2)' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'clicks', content: 'buttons clicked' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'final', name: 'mcp__sleight__js', input: { code: 'await app.getAXState({disableDiffing:true})' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'final', content: 'final state' }] } },
];
test('live verdict handles content-free initialization replies and the displayed result', () => {
  const result = judgePreapproval('listed', { code: 0 }, [initialized, grant, displayed('144')], false, transcript);
  assert.equal(result.passed, true); assert.equal(result.reported, true);
});
test('initial 144 cannot pass without successful clicks followed by a full final read', () => {
  for (const messages of [[], transcript.slice(2), transcript.slice(0, 2), [
    transcript[0], { ...transcript[1], message: { content: [{ type: 'tool_result', tool_use_id: 'clicks', is_error: true }] } }, ...transcript.slice(2),
  ]]) {
    assert.equal(judgePreapproval('listed', { code: 0 }, [grant, displayed('144')], false, messages).passed, false);
  }
});
test('an unrelated 144, stale answer, error or timeout cannot pass the listed trial', () => {
  const coordinate = event('to-client', { id: 2, result: { content: [{ type: 'text', text: 'Coordinate: 144,10' }] } });
  const diff = event('to-client', { id: 4, result: { content: [{ type: 'text', text: '1 text entry area Value: 0' }] } });
  for (const events of [[initialized, grant, coordinate], [grant, displayed('144'), displayed('0')],
    [grant, displayed('144'), diff],
    [grant, { ...displayed('144'), msg: { ...displayed('144').msg, result: { ...displayed('144').msg.result, isError: true } } }]]) {
    assert.equal(judgePreapproval('listed', { code: 0 }, events, false, transcript).passed, false);
  }
  assert.equal(judgePreapproval('listed', { code: 1 }, [grant, displayed('144')]).passed, false);
  assert.equal(judgePreapproval('listed', { code: 0 }, [grant, displayed('144')], true).passed, false);
});
test('unlisted trial needs an actual declined engine approval without any grant', () => {
  const prompt = event('to-client', { id: 2, method: 'elicitation/create', params: { _meta: {
    connector_id: 'computer-use', tool_params: { app: 'com.apple.calculator' },
  } } });
  const refusal = event('to-client', { id: 3, result: { content: [{ type: 'text', text: 'Computer Use was not approved to use Calculator' }] } });
  const declined = event('to-server', { id: 2, result: { action: 'decline' } });
  const cancelled = event('to-server', { id: 2, result: { action: 'cancel' } });
  for (const answer of [declined, cancelled]) {
    assert.equal(judgePreapproval('unlisted', { code: 0 }, [initialized, prompt, answer, refusal]).passed, true);
  }
  for (const events of [[initialized], [grant, prompt, declined, refusal], [declined, refusal], [prompt, cancelled]]) {
    assert.equal(judgePreapproval('unlisted', { code: 0 }, events).passed, false);
  }
});
