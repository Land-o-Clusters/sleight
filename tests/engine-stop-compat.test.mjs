import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const pluginMeta = { 'claudecode/toolUseId': 'toolu_plugin_' + 'a'.repeat(32) };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, collected) {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const replies = [], sent = [], events = [];
  for (const [stream, rows] of [[clientOut, replies], [serverIn, sent]])
    stream.on('data', bytes => rows.push(...String(bytes).trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    idleTurnEndMs: 0, stopGraceMs: 1,
    stopEngine: async () => { events.push('collect'); return { collected }; },
    restartEngine: async () => { events.push('restart'); return { serverIn, serverOut }; },
    inspectInput: async () => { events.push('inspect'); return { ok: true }; },
    nativeSession: { stop() { events.push('latch'); } },
  });
  t.after(() => { relay.dispose(); streams.forEach(stream => stream.destroy()); });
  const send = (id, name, args = {}, meta) => clientIn.write(JSON.stringify({ id, method: 'tools/call',
    params: { name, arguments: args, ...meta ? { _meta: meta } : {} } }) + '\n');
  const answer = id => serverOut.write(JSON.stringify({ id, result: { content: [] } }) + '\n');
  return { events, replies, sent, send, answer };
}

for (const attributed of [false, true]) for (const collected of [false, true]) {
  test(`ChatGPT engine Stop orders cleanup and awaits resume: attributed=${attributed}, collected=${collected}`, async t => {
    const h = fixture(t, collected);
    h.send('stop', 'turn_ended', { sleight_stop: true }, attributed ? pluginMeta : undefined);
    const ended = h.sent.at(-1);
    assert.match(String(ended?.id), /^sleight-stop-/, 'Stop reaches the ChatGPT engine turn cleanup');
    assert.equal(ended.params.arguments.hook_event_name, 'Interrupt');
    assert.deepEqual(h.events, [], 'collection waits for the ordered turn end');
    h.answer(ended.id);
    await tick();
    assert.equal(h.replies.filter(row => row.id === 'stop').length, 1);
    assert.equal(h.replies.find(row => row.id === 'stop').result._meta['sleight/stop'].engine,
      collected ? 'exited and collected' : 'unconfirmed');
    assert.deepEqual(h.events, collected ? ['collect', 'inspect'] : ['collect']);

    h.send('too-early', 'js', { code: '1' });
    assert.equal(h.replies.find(row => row.id === 'too-early')?.result.isError, true,
      'collection alone must not resume the ChatGPT engine');
    assert.equal(h.sent.some(row => row.id === 'too-early'), false);
    h.send('resume', 'turn_ended', { sleight_resume: true }, pluginMeta);
    h.send('next', 'js', { code: '2' });
    await tick(); await tick();
    assert.ok(h.sent.some(row => row.id === 'next'), 'explicit resume admits the next action without a person latch');
    h.answer('next'); await tick();
    assert.equal(h.replies.filter(row => row.id === 'next').length, 1);
    assert.equal(h.events.includes('latch'), false, 'a mod Stop must not latch the ChatGPT engine');
    assert.equal(h.events.filter(event => event === 'restart').length, collected ? 1 : 0);
  });
}

test('ChatGPT engine Interrupt ends the turn and keeps the owned engine', async t => {
  const h = fixture(t, true);
  h.send('running', 'js', { code: '1' });
  h.answer('running'); await tick();
  h.send('interrupt', 'turn_ended', { hook_event_name: 'Interrupt' });
  const ended = h.sent.find(row => row.params?.name === 'turn_ended');
  assert.ok(ended, 'Interrupt sends the turn end');
  assert.equal(ended.params.arguments.hook_event_name, 'Interrupt');
  h.answer(ended.id); await tick();
  assert.deepEqual(h.events, [], 'host Interrupt must not collect or latch the ChatGPT engine');
  h.send('next', 'js', { code: '2' }); await tick();
  assert.ok(h.sent.some(row => row.id === 'next'));
  h.answer('next');
});
