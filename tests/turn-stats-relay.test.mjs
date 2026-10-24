import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { validateToolCall } from '../plugins/sleight/lib/direct-browser/tools.mjs';

function harness(t, options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const output = [], sent = [];
  clientOut.on('data', data => output.push(...data.toString().trim().split('\n').map(JSON.parse)));
  serverIn.on('data', data => sent.push(...data.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, ...options });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  const call = (id, name, args = {}) => {
    const tagged = { ...args };
    if (['js', 'replay', 'browser_open', 'browser_read', 'browser_act', 'browser_fill'].includes(name) && !Object.hasOwn(tagged, 'sleight_stats')) tagged.sleight_stats = { turn: 'turn-1' };
    if (tagged.sleight_stats === true) tagged.sleight_stats = 'turn-1';
    return clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: tagged } }) + '\n');
  };
  const answer = (id, text = '') => serverOut.write(JSON.stringify({ id, result: { content: [{ type: 'text', text }] } }) + '\n');
  return { output, sent, call, answer };
}

test('only a mod turn-end request receives stats; ordinary results have no stats text or metadata', t => {
  let time = 0;
  const h = harness(t, { clock: () => time });
  h.call(1, 'js', { code: 'nodeRepl.write("private input")' });
  time = 100; h.answer(1, 'private page');
  const ordinary = h.output.find(msg => msg.id === 1).result;
  assert.doesNotMatch(JSON.stringify(ordinary), /sleight-turn-stats|sleight\/stats/);
  const chars = ordinary.content.filter(block => block.type === 'text').reduce((sum, block) => sum + block.text.length, 0);
  h.call(2, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: true }); h.answer(2);
  const end = h.output.find(msg => msg.id === 2).result;
  assert.equal(end._meta?.['sleight/stats']?.calls, 1);
  assert.equal(end._meta['sleight/stats'].characters, chars);
  assert.equal(end._meta['sleight/stats'].toolMs, 100);
  const block = end.content.find(block => block.text?.startsWith('sleight-turn-stats: '));
  assert.deepEqual(JSON.parse(block.text.slice('sleight-turn-stats: '.length)), end._meta['sleight/stats']);
  assert.doesNotMatch(block.text, /private/);
  assert.equal(h.sent.find(msg => msg.id === 2).params.arguments.sleight_stats, undefined, 'the engine sees only its normal turn-end arguments');
  h.call(3, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: true }); h.answer(3);
  assert.equal(h.output.find(msg => msg.id === 3).result._meta['sleight/stats'], null);
});

test('hosts without the protected mod and normal turn ends receive no stats payload', t => {
  for (const mod of [true, false]) {
    const h = harness(t, { modHost: () => mod });
    h.call(1, 'js', { code: 'nodeRepl.write(1)' }); h.answer(1, '1');
    h.call(2, 'turn_ended', { hook_event_name: 'Stop', ...(mod ? {} : { sleight_stats: true }) }); h.answer(2);
    assert.doesNotMatch(JSON.stringify(h.output.find(msg => msg.id === 2)), /sleight-turn-stats|sleight\/stats/);
  }
});

test('synchronous engine turn-end replies still carry the completed counters', t => {
  const h = harness(t);
  h.call(1, 'js', { code: 'await app.getAXState()' }); h.answer(1, 'tree');
  // Wire the response before sending the end, as an in-process engine can answer during toServer.
  // The existing stream listener collected the request first; this one supplies its reply immediately.
  const endId = 10;
  h.sent.push = function (...messages) {
    const n = Array.prototype.push.apply(this, messages);
    for (const msg of messages) if (msg.id === endId) h.answer(endId);
    return n;
  };
  h.call(endId, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: true });
  assert.equal(h.output.find(msg => msg.id === endId).result._meta?.['sleight/stats']?.reads, 1);
});

test('stats follow the host identity learned at initialization, not the unknown startup identity', t => {
  let mod = false;
  const h = harness(t, { modHost: () => mod });
  mod = true;
  h.call(1, 'js', { code: 'await app.getAXState()' }); h.answer(1, 'tree');
  h.call(2, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: true }); h.answer(2);
  assert.equal(h.output.find(msg => msg.id === 2).result._meta?.['sleight/stats']?.reads, 1);
});

test('engine idle cleanup does not split the host turn counters', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, { idleTurnEndMs: 10 });
  h.call(1, 'js', { code: 'await app.getAXState()' }); h.answer(1, 'one');
  t.mock.timers.tick(10);
  const idle = h.sent.find(msg => msg.params?.name === 'turn_ended');
  assert.ok(idle); h.answer(idle.id);
  h.call(2, 'js', { code: 'await app.getAXState()' }); h.answer(2, 'two');
  h.call(3, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: true }); h.answer(3);
  assert.equal(h.output.find(msg => msg.id === 3).result._meta?.['sleight/stats']?.reads, 2);
});

test('checked Stop returns stats after cleanup without counting the internal cleanup call', async t => {
  const h = harness(t, { stopEngine: async () => ({ collected: true, cutOff: false }), inspectInput: async () => ({ ok: true }) });
  h.call(1, 'js', { code: 'await app.getAXState()' }); h.answer(1, 'tree');
  h.call(2, 'turn_ended', { hook_event_name: 'Interrupt', sleight_stop: true, sleight_stats: true });
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  const cleanup = h.sent.find(msg => String(msg.id).startsWith('sleight-stop-'));
  assert.ok(cleanup); h.answer(cleanup.id);
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
  const end = h.output.find(msg => msg.id === 2);
  assert.equal(end.result._meta?.['sleight/stats']?.calls, 1);
  assert.equal(end.result._meta['sleight/stats'].reads, 1);
});

test('stats alone leave outcome instrumentation off and acquisition-only calls complete', t => {
  const h = harness(t);
  h.call(1, 'js', { code: 'let app = await cua.getApp("Example")' }); h.answer(1, 'ready');
  h.call(2, 'js', { code: 'await app.click(2)', title: 'sleight pane snapshot' }); h.answer(2, 'done');
  assert.doesNotMatch(h.sent.find(msg => msg.id === 2).params.arguments.code, /outcomeRec|outcomeMark/);
  assert.equal(h.sent.find(msg => msg.id === 2).params.arguments.sleight_stats, undefined);
  h.call(3, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: true }); h.answer(3);
  const stats = h.output.find(msg => msg.id === 3).result._meta['sleight/stats'];
  assert.equal(stats.calls, 2); assert.equal(stats.unclassified, 0);
  assert.equal(stats.paths.native.actions, 1); assert.equal(stats.paths.native.estimatedActions, 1);
  assert.equal(stats.paths.native.estimatedCalls, 1, 'only the action call is estimated, not acquisition');
  assert.equal(stats.paths.native.timedActions, 0); assert.equal(stats.paths.native.actionMs, 0);
});

test('late requests and replies stay keyed to their original turn, and internal calls do not count', t => {
  const h = harness(t);
  h.call(1, 'js', { code: 'await app.getAXState()', sleight_stats: { turn: 'turn-1' } });
  h.call(2, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: 'turn-1' }); h.answer(2);
  assert.equal(h.output.find(msg => msg.id === 2).result._meta['sleight/stats'].pending, 1);
  h.call(3, 'js', { code: 'await app.getAXState()', sleight_stats: { turn: 'turn-2' } }); h.answer(3, 'new');
  h.answer(1, 'late');
  h.call(4, 'js', { code: 'await app.click(1)', sleight_stats: { internal: true } }); h.answer(4, 'child');
  h.call(5, 'js', { code: 'await app.getAXState()', sleight_stats: { turn: 'turn-1' } }); h.answer(5, 'late child');
  h.call(6, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: 'turn-2' }); h.answer(6);
  const stats = h.output.find(msg => msg.id === 6).result._meta['sleight/stats'];
  assert.equal(stats.calls, 1); assert.equal(stats.characters, 3); assert.equal(stats.pending, 0);
});

test('browser stats transport is removed before the browser argument validator runs', t => {
  const h = harness(t);
  h.call(1, 'browser_read', { tab: 't1' });
  const request = h.sent.find(msg => msg.id === 1).params;
  assert.doesNotThrow(() => validateToolCall({ name: request.name, arguments: request.arguments }));
});

test('overflowed turn collectors remain unavailable even after capacity frees', t => {
  const h = harness(t);
  for (let i = 0; i < 9; i++) {
    h.call(i + 1, 'js', { code: 'nodeRepl.write(1)', sleight_stats: { turn: `cap-${i}` } }); h.answer(i + 1, '1');
  }
  h.call(20, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: 'cap-0' }); h.answer(20);
  h.call(21, 'js', { code: 'nodeRepl.write(2)', sleight_stats: { turn: 'cap-8' } }); h.answer(21, '2');
  h.call(22, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: 'cap-8' }); h.answer(22);
  const result = h.output.find(msg => msg.id === 22).result;
  assert.equal(result._meta['sleight/stats'], null);
  assert.match(result.content.at(-1).text, /unavailable/);
});
