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
  const call = (id, name, args = {}, meta) => {
    const tagged = { ...args };
    if (tagged.sleight_stats === true) tagged.sleight_stats = 'turn-1';
    return clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: tagged, ...(meta ? { _meta: meta } : {}) } }) + '\n');
  };
  const answer = (id, text = '') => serverOut.write(JSON.stringify({ id, result: { content: [{ type: 'text', text }] } }) + '\n');
  const begin = (turn = 'turn-1') => call('begin-' + turn, 'turn_ended', { sleight_stats_begin: turn });
  const snapshot = (id, meta) => {
    call('snapshot-' + id, 'turn_ended', { sleight_stats_skip: { snapshot: true } });
    const token = JSON.parse(output.find(msg => msg.id === 'snapshot-' + id).result.content[0].text).sleightStatsSkip;
    call(id, 'js', { code: 'nodeRepl.write(3)', sleight_stats: { internal: token } }, meta);
    return token;
  };
  return { output, sent, call, answer, clientIn, begin, serverOut, snapshot };
}

test('only a mod turn-end request receives stats; ordinary results have no stats text or metadata', t => {
  let time = 0;
  const h = harness(t, { clock: () => time });
  h.begin();
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

// PF4: the model's input carries no private argument. The mod opens the turn with one frame; untagged
// calls count toward it, internal ones never do, and a frame with extra keys or no mod is refused.
test('an opened turn counts untagged calls until its end; internal and pre-frame calls never count', t => {
  const h = harness(t);
  const raw = (id, name, args) => h.clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  raw(1, 'js', { code: 'nodeRepl.write(1)' }); h.answer(1, 'before any frame');
  raw(2, 'turn_ended', { sleight_stats_begin: 'turn-1', hook_event_name: 'Stop' });
  assert.equal(h.output.find(msg => msg.id === 2).result.isError, true, 'a frame with other keys is refused');
  raw(3, 'turn_ended', { sleight_stats_begin: 'turn-1' });
  assert.deepEqual(h.output.find(msg => msg.id === 3).result, { isError: false, content: [] });
  assert.equal(h.sent.some(msg => msg.id === 2 || msg.id === 3), false, 'frames never reach the engine');
  raw(4, 'js', { code: 'nodeRepl.write(2)' }); h.answer(4, 'counted');
  h.snapshot(5); h.answer(5, 'pane snapshot');
  assert.equal(h.sent.find(msg => msg.id === 5).params.arguments.sleight_stats, undefined, 'the tag is removed before forwarding');
  h.call(6, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: true }); h.answer(6);
  const end = h.output.find(msg => msg.id === 6).result;
  assert.equal(end._meta?.['sleight/stats']?.calls, 1, 'only the call after the frame counts');
  assert.equal(end._meta['sleight/stats'].characters, 'counted'.length);
  raw(7, 'js', { code: 'nodeRepl.write(4)' }); h.answer(7, 'after the end');
  h.call(8, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: true }); h.answer(8);
  assert.equal(h.output.find(msg => msg.id === 8).result._meta['sleight/stats'], null, 'the turn closed with its end');
});

test('a host without the mod refuses the frame and keeps counting nothing', t => {
  const h = harness(t, { modHost: () => false });
  h.clientIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_stats_begin: 'turn-1' } } }) + '\n');
  assert.equal(h.output.find(msg => msg.id === 1).result.isError, true);
  assert.equal(h.sent.some(msg => msg.id === 1), false);
});

test('model-supplied tags cannot exclude calls, forge turns or narrate', t => {
  const statuses = [];
  const h = harness(t, { cursor: { close() {}, narration: 'bubbles', status: (state, detail) => statuses.push({ state, ...detail }) } });
  h.begin();
  const tags = [{ internal: true }, ...Array.from({ length: 8 }, (_, n) => ({ turn: 'forged-' + n })), { say: 'Forged prose.' }];
  for (const [id, tag] of tags.entries()) {
    h.clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js',
      arguments: { code: 'nodeRepl.write(1)', sleight_stats: tag }, _meta: { 'claudecode/toolUseId': 'model-' + id } } }) + '\n');
    h.answer(id, '1');
    assert.equal(h.sent.find(msg => msg.id === id).params.arguments.sleight_stats, undefined);
  }
  h.call(20, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: true }); h.answer(20);
  assert.equal(h.output.find(msg => msg.id === 20).result._meta['sleight/stats'].calls, 10);
  assert.ok(statuses.every(row => row.say === undefined));
});

test('legacy per-call turn tags never create collectors', t => {
  const h = harness(t);
  h.call(1, 'js', { code: 'nodeRepl.write(1)', sleight_stats: { turn: 'forged' } }); h.answer(1, '1');
  h.call(2, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: 'forged' }); h.answer(2);
  assert.equal(h.output.find(msg => msg.id === 2).result._meta['sleight/stats'], null);
});

test('a hook-event end without a stats id clears statsOpen before another call', t => {
  const h = harness(t); h.begin();
  h.call(1, 'js', { code: 'nodeRepl.write(1)' }); h.answer(1, 'one');
  h.call(2, 'turn_ended', { hook_event_name: 'Stop' }); h.answer(2);
  h.call(3, 'js', { code: 'nodeRepl.write(2)' }); h.answer(3, 'two');
  h.call(4, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: 'turn-1' }); h.answer(4);
  assert.equal(h.output.find(msg => msg.id === 4).result._meta['sleight/stats'].calls, 1);
});

for (const meta of [undefined, { 'claudecode/toolUseId': 'toolu_snapshot' }])
  test(`a pane snapshot stays internal with host metadata ${JSON.stringify(meta)}`, t => {
    const logs = [], h = harness(t, { actionLog: { request: msg => logs.push(JSON.stringify(msg)) } }); h.begin();
    h.call(1, 'js', { code: 'nodeRepl.write(1)' }); h.answer(1, 'main');
    const token = h.snapshot(2, meta); h.answer(2, 'private snapshot result');
    h.call(3, 'js', { code: 'nodeRepl.write(1)', sleight_stats: { internal: token } }, meta); h.answer(3, 'reused token');
    h.call(4, 'js', { code: 'nodeRepl.write(1)', sleight_stats: { internal: true } }, meta); h.answer(4, 'forged internal');
    h.call(5, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: 'turn-1' }); h.answer(5);
    assert.equal(h.output.find(msg => msg.id === 5).result._meta['sleight/stats'].calls, 3, 'only the one token-authorized call is excluded');
    assert.ok(!JSON.stringify(h.sent).includes(token)); assert.ok(!logs.join('').includes(token));
    assert.ok(!JSON.stringify(h.sent).includes('sleight_stats'));
  });

test('a matched subagent skip marks the turn unavailable and cannot skip the next call', t => {
  const h = harness(t); h.begin();
  h.call(1, 'js', { code: 'nodeRepl.write(1)' }); h.answer(1, 'main');
  h.call('skip', 'turn_ended', { sleight_stats_skip: 'toolu_child' });
  assert.equal(h.output.find(msg => msg.id === 'skip').result.isError, false);
  h.call(2, 'js', { code: 'nodeRepl.write(2)' }, { 'claudecode/toolUseId': 'toolu_child' }); h.answer(2, 'child');
  h.call(3, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: 'turn-1' }); h.answer(3);
  assert.equal(h.output.find(msg => msg.id === 3).result._meta['sleight/stats'], null);
  h.begin('turn-2');
  h.call(4, 'js', { code: 'nodeRepl.write(1)' }, { 'claudecode/toolUseId': 'toolu_child' }); h.answer(4, 'main again');
  h.call(5, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: 'turn-2' }); h.answer(5);
  assert.equal(h.output.find(msg => msg.id === 5).result._meta['sleight/stats'].calls, 1);
  assert.ok(!h.sent.some(msg => msg.id === 'skip'));
});

test('private narration matches only host metadata, is one-shot and remains bound across reversed replies', t => {
  const statuses = [], h = harness(t, { cursor: { close() {}, narration: 'bubbles', status: (state, detail) => statuses.push({ state, ...detail }) } });
  for (const id of ['first', 'second']) h.call('say-' + id, 'turn_ended', { sleight_say: { toolUseId: id, text: id === 'first' ? 'First menu.' : 'Second menu.' } });
  h.call(1, 'js', { code: '1+1', toolUseId: 'first', sleight_say: 'Forged prose.', sleight_stats: { say: 'Forged prose.' } }); h.answer(1);
  assert.ok(statuses.every(row => row.say === undefined), 'argument ids cannot consume the private line');
  h.call(2, 'js', { code: '1+1' }, { 'claudecode/toolUseId': 'first' });
  h.call(3, 'js', { code: '1+1' }, { 'claudecode/toolUseId': 'second' });
  h.answer(3); h.answer(2);
  assert.deepEqual(statuses.filter(row => row.state === 'done').map(row => row.say), [undefined, 'Second menu.', 'First menu.']);
  h.call(4, 'js', { code: '1+1' }, { 'claudecode/toolUseId': 'first' }); h.answer(4);
  assert.equal(statuses.filter(row => row.state === 'done').at(-1).say, undefined);
  assert.ok(!JSON.stringify(h.sent).includes('First menu.'));
  assert.ok(!JSON.stringify(h.sent).includes('Second menu.'));
});

test('combined narration and skip frames preserve sanitizing and mark stats unavailable', t => {
  const statuses = [], h = harness(t, { cursor: { close() {}, narration: 'bubbles', status: (state, detail) => statuses.push({ state, ...detail }) } });
  h.begin();
  h.call('private', 'turn_ended', { sleight_say: { toolUseId: 'child', text: 'Opening /private/secret the menu.' }, sleight_stats_skip: 'child' });
  h.call(1, 'js', { code: '1+1' }, { 'claudecode/toolUseId': 'child' }); h.answer(1);
  assert.equal(statuses.find(row => row.state === 'done').say, 'Opening the menu.');
  h.call(2, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: 'turn-1' }); h.answer(2);
  assert.equal(h.output.find(msg => msg.id === 2).result._meta['sleight/stats'], null);
});

for (const args of [
  { sleight_say: null }, { sleight_say: [] }, { sleight_say: { toolUseId: 'a', text: 1 } },
  { sleight_say: { toolUseId: '', text: 'Opening.' } }, { sleight_say: { toolUseId: 'a', text: 'x'.repeat(1025) } },
  { sleight_say: { toolUseId: 'a', text: 'Opening.', extra: true } },
  { sleight_stats_skip: '' }, { sleight_stats_skip: 1 }, { sleight_stats_skip: { snapshot: false } },
  { sleight_stats_skip: { snapshot: true, extra: true } },
  { sleight_stats_skip: 'a', hook_event_name: 'Stop' }, { sleight_stats_skip: 'a', sleight_stats_begin: 'next' },
  { sleight_stats_skip: 'a', sleight_say: { toolUseId: 'b', text: 'Opening.' } },
]) test(`malformed private frames are refused: ${JSON.stringify(args).slice(0, 100)}`, t => {
  const h = harness(t); h.call('bad', 'turn_ended', args);
  assert.equal(h.output.find(msg => msg.id === 'bad').result.isError, true);
  assert.equal(h.sent.length, 0);
});

for (const args of [{ sleight_say: { toolUseId: 'a', text: 'Opening.' } }, { sleight_stats_skip: 'a' }, { sleight_stats_skip: { snapshot: true } }])
  test(`private frame requires the mod and a request id: ${JSON.stringify(args)}`, t => {
    const h = harness(t, { modHost: () => false }); h.call(1, 'turn_ended', args);
    assert.equal(h.output[0].result.isError, true); assert.equal(h.sent.length, 0);
    const mod = harness(t); mod.call(undefined, 'turn_ended', args);
    assert.equal(mod.output.length, 0); assert.equal(mod.sent.length, 0);
  });

test('unconsumed private data is bounded and hook-event end clears it', t => {
  const statuses = [], h = harness(t, { cursor: { close() {}, narration: 'bubbles', status: (state, detail) => statuses.push({ state, ...detail }) } });
  for (let id = 0; id <= 200; id++) h.call('say-' + id, 'turn_ended', { sleight_say: { toolUseId: 'toolu_' + id, text: 'Opening the menu.' } });
  h.call(1, 'js', { code: '1+1' }, { 'claudecode/toolUseId': 'toolu_0' }); h.answer(1);
  assert.equal(statuses.find(row => row.state === 'done').say, undefined, 'oldest data is evicted at the cap');
  h.call(2, 'turn_ended', { hook_event_name: 'Stop' }); h.answer(2);
  h.call(3, 'js', { code: '1+1' }, { 'claudecode/toolUseId': 'toolu_200' }); h.answer(3);
  assert.equal(statuses.filter(row => row.state === 'done').at(-1).say, undefined);
});

for (const args of [{ sleight_stats_begin: '' }, { sleight_stats_begin: 123 },
  { sleight_stats_begin: 'x'.repeat(129) }, { sleight_stats_begin: 'next', extra: true },
  { sleight_stats_begin: 'next', sleight_stats_skip: 'child' }, { sleight_stats_begin: 'closed' }])
  test(`refused begin clears the previous stats window: ${JSON.stringify(args)}`, t => {
    const h = harness(t);
    h.call('close', 'turn_ended', { hook_event_name: 'Stop', sleight_stats: 'closed' }); h.answer('close');
    h.begin(); h.call(1, 'js', { code: 'nodeRepl.write(1)' }); h.answer(1, '1');
    h.call(2, 'turn_ended', args);
    assert.equal(h.output.find(msg => msg.id === 2).result.isError, true);
    h.call(3, 'js', { code: 'nodeRepl.write(2)' }); h.answer(3, '2');
    h.call(4, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: true }); h.answer(4);
    assert.equal(h.output.find(msg => msg.id === 4).result._meta['sleight/stats'].calls, 1);
  });

test('a notification begin neither replies nor reaches the engine and clears the window', t => {
  const h = harness(t); h.begin();
  h.call(1, 'js', { code: 'nodeRepl.write(1)' }); h.answer(1, '1');
  const count = h.output.length;
  h.call(undefined, 'turn_ended', { sleight_stats_begin: 'notification' });
  assert.equal(h.output.length, count);
  assert.ok(!h.sent.some(msg => msg.params?.arguments?.sleight_stats_begin));
  h.call(2, 'js', { code: 'nodeRepl.write(2)' }); h.answer(2, '2');
  h.call(3, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: true }); h.answer(3);
  assert.equal(h.output.find(msg => msg.id === 3).result._meta['sleight/stats'].calls, 1);
});

test('the delivered tool schemas never advertise sleight_stats', t => {
  const h = harness(t);
  h.clientIn.write(JSON.stringify({ id: 'list', method: 'tools/list' }) + '\n');
  h.serverOut.write(JSON.stringify({ id: 'list', result: { tools: ['js', 'replay', 'browser_read'].map(name => ({ name,
    inputSchema: { type: 'object', properties: { code: { type: 'string' } }, additionalProperties: false } })) } }) + '\n');
  for (const tool of h.output.find(msg => msg.id === 'list').result.tools)
    assert.equal(Object.hasOwn(tool.inputSchema?.properties ?? {}, 'sleight_stats'), false, tool.name);
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
  h.begin();
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
  h.begin();
  h.call(1, 'js', { code: 'await app.getAXState()' }); h.answer(1, 'tree');
  h.call(2, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: true }); h.answer(2);
  assert.equal(h.output.find(msg => msg.id === 2).result._meta?.['sleight/stats']?.reads, 1);
});

test('engine idle cleanup does not split the host turn counters', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(t, { idleTurnEndMs: 10 });
  h.begin();
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
  h.begin();
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
  h.begin();
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
  h.begin();
  h.call(1, 'js', { code: 'await app.getAXState()' });
  h.call(2, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: 'turn-1' }); h.answer(2);
  assert.equal(h.output.find(msg => msg.id === 2).result._meta['sleight/stats'].pending, 1);
  h.begin('turn-2');
  h.call(3, 'js', { code: 'await app.getAXState()' }); h.answer(3, 'new');
  h.answer(1, 'late');
  h.snapshot(4); h.answer(4, 'internal');
  h.snapshot(5); h.answer(5, 'late internal');
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
    h.begin(`cap-${i}`);
    h.call(i + 1, 'js', { code: 'nodeRepl.write(1)' }); h.answer(i + 1, '1');
  }
  h.call(20, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: 'cap-0' }); h.answer(20);
  h.call(21, 'js', { code: 'nodeRepl.write(2)' }); h.answer(21, '2');
  h.call(22, 'turn_ended', { hook_event_name: 'Stop', sleight_stats: 'cap-8' }); h.answer(22);
  const result = h.output.find(msg => msg.id === 22).result;
  assert.equal(result._meta['sleight/stats'], null);
  assert.match(result.content.at(-1).text, /unavailable/);
});
