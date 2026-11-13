import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { createSessionPause, PAUSED_NOTE, NATIVE_PAUSE_CUT_NOTE } from '../plugins/sleight/lib/session-pause.mjs';
import { createCursorEvents } from '../plugins/sleight/lib/hand/events.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(t, extra = {}) {
  const pause = extra.pause ?? createSessionPause(), clientIn = new PassThrough(), clientOut = new PassThrough();
  const serverIn = new PassThrough(), serverOut = new PassThrough(), sent = [], replies = [];
  serverIn.on('data', data => sent.push(...String(data).trim().split('\n').map(JSON.parse)));
  clientOut.on('data', data => replies.push(...String(data).trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, pause, ...extra });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  return { pause, sent, replies, send(msg) { clientIn.write(JSON.stringify(msg) + '\n'); }, call(id, name = 'js', args = { code: 'await cua.getState()' }) {
    clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  }, engine(msg) { serverOut.write(JSON.stringify(msg) + '\n'); } };
}

test('pause epochs stop the rest of an old call even after a resume', () => {
  const pause = createSessionPause(), checkpoint = pause.checkpoint();
  checkpoint(); pause.set(true); assert.throws(checkpoint, { message: PAUSED_NOTE });
  pause.set(false); assert.throws(checkpoint, { message: PAUSED_NOTE });
  pause.checkpoint()();
});

test('a paused relay refuses every engine, turbo, Electron and local tool before dispatch', async t => {
  let local = 0;
  const h = harness(t, { turboUnavailable: 'off', localTools: { tools: [{ name: 'menu_bar' }], call() { local++; } } });
  h.pause.set(true);
  const names = ['js', 'js_reset', 'browser_open', 'browser_read', 'browser_act', 'browser_fill', 'browser_tabs', 'menu_bar', 'replay', 'open_file'];
  names.forEach((name, i) => h.call(i + 1, name, {}));
  await tick();
  assert.equal(h.sent.length, 0); assert.equal(local, 0); assert.equal(h.replies.length, names.length);
  for (const reply of h.replies) { assert.equal(reply.result.isError, true); assert.equal(reply.result.content[0].text, PAUSED_NOTE); }
});

test('sessions are independent and a human resume admits fresh calls', t => {
  const a = harness(t), b = harness(t);
  a.pause.set(true); a.call(1); b.call(2);
  assert.equal(a.sent.length, 0); assert.equal(b.sent.length, 1);
  a.pause.set(false); a.call(3); assert.equal(a.sent.length, 1);
});

test('pause emits a sticky public status and sends it to the host', t => {
  const records = [], host = [], cursor = createCursorEvents({ setting: () => ({ enabled: true, style: 'ring', stream: true }), sink: { write() {}, close() {} }, onEvent: e => records.push(e) });
  cursor.connectHost({ cursor: e => host.push(e) });
  const h = harness(t, { cursor });
  h.pause.set(true); cursor.status('done'); cursor.status('thinking');
  assert.equal(records.at(-1).state, 'paused'); assert.equal(host.at(-1).state, 'paused');
  h.pause.set(false); assert.equal(records.at(-1).state, 'idle');
});

test('a pause clicked during startup is published when the relay subscribes', t => {
  const pause = createSessionPause(), records = [];
  pause.set(true);
  const cursor = createCursorEvents({ setting: () => ({ stream: true }), sink: { write() {}, close() {} }, onEvent: e => records.push(e) });
  const h = harness(t, { pause, cursor }); h.call(1);
  assert.equal(h.sent.length, 0); assert.equal(records.at(-1)?.state, 'paused');
});
test('enabling the stream during a pause starts with paused rather than idle', () => {
  let stream = false, now = 0;
  const records = [], cursor = createCursorEvents({ now: () => now, setting: () => ({ stream }),
    sink: { write() {}, close() {} }, onEvent: e => records.push(e) });
  cursor.setPaused(true); stream = true; now = 1000;
  cursor.action({ call: 'a'.repeat(32), index: 0, kind: 'click', phase: 'done', source: 'native', timing: 'confirmed' });
  assert.equal(records.find(e => e.type === 'status')?.state, 'paused'); cursor.close();
});

test('turn and resume-shaped tool calls cannot clear a human pause', t => {
  const h = harness(t); h.pause.set(true);
  h.call(1, 'resume', {}); h.call(2, 'pause', { paused: false });
  h.call(3, 'turn_ended', { event: 'resume' }); h.call(4);
  assert.equal(h.pause.paused, true);
  assert.equal(h.sent.some(m => m.params?.name === 'js'), false);
  assert.equal(h.replies.find(m => m.id === 4).result.content[0].text, PAUSED_NOTE);
});

test('an in-flight native action may finish but its next approval is declined, even after resume', async t => {
  const h = harness(t);
  h.call(1, 'js', { code: 'await cua.getApp("Editor")' });
  assert.equal(h.sent.length, 1);
  h.pause.set(true); h.pause.set(false);
  h.engine({ id: 'approval-1', method: 'elicitation/create', params: { message: 'Allow?', _meta: { tool_name: 'click', tool_params: { app: 'Editor' } } } });
  await tick();
  assert.equal(h.sent.at(-1).result.action, 'decline');
  h.engine({ id: 1, result: { isError: true, content: [{ type: 'text', text: 'Declined' }] } });
  assert.ok(h.replies.at(-1).result.content.some(c => c.text === NATIVE_PAUSE_CUT_NOTE));
});

test('a local action waiting for its target stops before input when paused', async t => {
  let targetReady, actions = 0;
  const h = harness(t, { localTools: { tools: [{ name: 'hover' }], target: () => new Promise(resolve => { targetReady = resolve; }),
    async call() { actions++; return { content: [] }; } } });
  h.call(1, 'hover', { app: 'Editor' }); await tick();
  assert.equal(typeof targetReady, 'function');
  h.pause.set(true); h.pause.set(false); targetReady({ app: 'Editor', appId: 'org.test.editor' }); await tick();
  assert.equal(actions, 0); assert.match(JSON.stringify(h.replies), /Paused by the user/);
});

test('a completed local pause does not decline later native approvals after resume', async t => {
  let ready;
  const h = harness(t, { localTools: { tools: [{ name: 'hover' }],
    target: () => new Promise(resolve => { ready = resolve; }), async call() { return { content: [] }; } } });
  h.call(1, 'hover', { app: 'Editor' }); await tick();
  h.pause.set(true); h.pause.set(false); ready({ app: 'Editor', appId: 'org.test.editor' }); await tick();
  h.call(2);
  h.engine({ id: 'next-approval', method: 'elicitation/create', params: { message: 'Allow?', _meta: { tool_name: 'click', tool_params: { app: 'Editor' } } } });
  await tick(); await tick();
  assert.equal(h.replies.find(m => m.id === 'next-approval').method, 'elicitation/create');
  assert.equal(h.sent.some(m => m.id === 'next-approval'), false);
});
test('resumed native calls wait at admission while an old paused native call drains', async t => {
  const h = harness(t); h.call(1);
  h.pause.set(true); h.pause.set(false); h.call(2);
  assert.equal(h.sent.length, 1);
  assert.match(h.replies.find(m => m.id === 2).result.content[0].text, /finishing/);
  h.engine({ id: 1, result: { content: [] } }); h.call(3);
  assert.equal(h.sent.at(-1).id, 3);
});


test('a completed native call during pause has no cut-short note', t => {
  const h = harness(t); h.call(1); h.pause.set(true);
  h.engine({ id: 1, result: { content: [{ type: 'text', text: 'All actions finished' }] } });
  assert.equal(h.replies.at(-1).result.content.some(c => /Paused by the user/.test(c.text)), false);
});
test('a lost pause control names both recovery paths', t => {
  const h = harness(t, { pauseHost: { controlLost: true } }); h.pause.set(true); h.call(1);
  assert.match(h.replies.at(-1).result.content[0].text, /Resume from the sleight menu bar, or start a new session/);
});
test('foreground drag cannot dispatch until the host clears its panel', async t => {
  let release, actions = 0;
  const h = harness(t, { pauseHost: { activity() {}, clearForAction: () => new Promise(resolve => { release = resolve; }) },
    localTools: { tools: [{ name: 'drag' }], target: async () => ({ app: 'Editor', appId: 'org.test.editor' }),
      async call() { actions++; return { content: [] }; } } });
  h.call(1, 'drag', { app: 'Editor', windowId: 77 }); await tick();
  assert.equal(actions, 0); assert.equal(typeof release, 'function'); release(true); await tick(); assert.equal(actions, 1);
});
test('a drag clears again after its waiting approval before dispatching pointer input', async t => {
  const order = [], releases = [], records = [];
  const cursor = createCursorEvents({ setting: () => ({ stream: true }), sink: { write() {}, close() {} }, onEvent: event => records.push(event) });
  const h = harness(t, { cursor, ask: async () => { order.push('approved'); return 'accept'; },
    pauseHost: { activity() {}, clearForAction: () => new Promise(resolve => { order.push('clear'); releases.push(resolve); }) },
    localTools: { tools: [{ name: 'drag' }], target: async () => ({ app: 'Editor', appId: 'org.test.editor' }),
      async call(_name, _args, approve) {
        if (await approve(['drag', 'Editor'], 'Allow drag?')) order.push('pointer-input');
        return { content: [] };
      } } });
  h.call(1, 'drag', { app: 'Editor', windowId: 77 }); await tick();
  assert.deepEqual(order, ['clear']); releases[0](true); await tick(); await tick();
  assert.ok(records.some(e => e.type === 'status' && e.state === 'waiting'));
  assert.deepEqual(order, ['clear', 'approved', 'clear']);
  releases[1](true); await tick();
  assert.deepEqual(order, ['clear', 'approved', 'clear', 'pointer-input']);
});

test('a paused private warmup settles once and a resumed user call uses ordinary setup', async t => {
  const h = harness(t, { warmRepl: true, warmEngine: true });
  h.pause.set(true);
  h.send({ id: 'init', method: 'initialize', params: {} }); h.engine({ id: 'init', result: {} });
  h.send({ method: 'notifications/initialized' }); await tick(); await tick();
  assert.equal(h.sent.some(m => String(m.id).startsWith('sleight-warm-')), false);
  assert.equal(h.sent.some(m => String(m.id).startsWith('sleight-native-warm-')), false);
  assert.equal(h.replies.some(m => String(m.id).startsWith('sleight-warm-')), false);
  h.pause.set(false); h.call(2); await tick();
  assert.equal(h.sent.at(-1).id, 2);
});
