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
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'final', content: displayed('144').msg.result.content }] } },
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
  for (const events of [[initialized, grant, coordinate],
    [grant, displayed('144'), diff],
    [grant, { ...displayed('144'), msg: { ...displayed('144').msg, result: { ...displayed('144').msg.result, isError: true } } }]]) {
    assert.equal(judgePreapproval('listed', { code: 0 }, events, false, transcript).passed, false);
  }
  const zeroTranscript = [...transcript.slice(0, 3), { type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'final', content: displayed('0').msg.result.content },
  ] } }];
  assert.equal(judgePreapproval('listed', { code: 0 }, [grant, displayed('144'), displayed('0')], false, zeroTranscript).passed, false);
  const laterCall = [...transcript,
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'later', name: 'mcp__sleight__js', input: { code: 'await app.click(1)' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'later', content: 'clicked' }] } },
  ];
  assert.equal(judgePreapproval('listed', { code: 0 }, [grant, displayed('144')], false, laterCall).passed, false);
  assert.equal(judgePreapproval('listed', { code: 1 }, [grant, displayed('144')]).passed, false);
  assert.equal(judgePreapproval('listed', { code: 0 }, [grant, displayed('144')], true).passed, false);
});
test('listed verdict uses the full final tool result when the trace truncates the Calculator tree', () => {
  const full = value => [
    { type: 'text', text: 'Window: "Calculator", App: Calculator.\n' +
      '\t4 row (selectable) Value: 12 × 12\n144\n' +
      '\t74 scroll area ID: StandardResultView\n\t\t75 text Description: Last Expression, Value: 12 × 12\n' +
      `\t76 scroll area ID: StandardInputView;value:${value}\n\t\t77 text Description: Edit field, Value: ${value}\n` },
    { type: 'text', text: "com.apple.calculator was pre-approved by the user's list." },
  ];
  const truncated = event('to-client', { id: 3, result: { content: [
    { type: 'text', text: 'Window: "Calculator", App: Calculator.\n0 standard window Calculator…(6500)' },
    { type: 'text', text: "com.apple.calculator was pre-approved by the user's list." },
  ] } });
  const messages = value => [...transcript.slice(0, 3), { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'final', content: full(value) }] } }];
  assert.equal(judgePreapproval('listed', { code: 0 }, [grant, truncated], false, messages('144')).passed, true);
  assert.equal(judgePreapproval('listed', { code: 0 }, [grant, truncated], false, messages('0')).passed, false);
  const history = messages('0');
  history.at(-1).message.content[0].content[0].text += '\t78 static text 144\n\t79 text 144\n';
  assert.equal(judgePreapproval('listed', { code: 0 }, [grant, truncated], false, history).passed, false);
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
test('audit read trial needs successful Calculator selection, a full read and a reported grant', () => {
  const messages = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'select', name: 'mcp__sleight__js', input: { code: 'let app = await cua.getApp("com.apple.calculator")' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'select', content: displayed('0').msg.result.content }] } },
    ...transcript.slice(2),
  ];
  assert.equal(judgePreapproval('listed-read', { code: 0 }, [grant, displayed('144')], false, messages).passed, true);
  for (const bad of [messages.slice(2), messages.slice(0, 2), [messages[0],
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'select', is_error: true }] } }, ...messages.slice(2)]]) {
    assert.equal(judgePreapproval('listed-read', { code: 0 }, [grant, displayed('144')], false, bad).passed, false);
  }
  assert.equal(judgePreapproval('listed-read', { code: 0 }, [displayed('144')], false, messages).passed, false);
  assert.equal(judgePreapproval('listed-read', { code: 1 }, [grant, displayed('144')], false, messages).passed, false);
});
