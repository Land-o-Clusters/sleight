import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { createRelayHand } from '../plugins/sleight/lib/hand/relay-hand.mjs';

const TREE = 'Window: "Calculator", App: Calculator.\n0 standard window Calculator\n\t1 button Description: 7, ID: Seven\n\t2 button Description: 8, ID: Eight';
// A PNG header for a 464×640-pixel screenshot of a 232×320-point window.
const png = (width, height) => {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8); b.write('IHDR', 12);
  b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return b.toString('base64');
};
const BOUNDS = { X: 600, Y: 100, Width: 232, Height: 320 };
const GEOMETRY = { ok: true, pid: 900, window: { pid: 900, windowId: 31, bounds: BOUNDS },
  windows: [{ id: 31, pid: 900, layer: 0, owner: 'Calculator', bounds: BOUNDS }], displays: [{ X: 0, Y: 0, Width: 1512, Height: 982 }],
  elements: { 1: { X: 610, Y: 300, Width: 40, Height: 40 } } };

const relays = [];
after(() => { for (const relay of relays) relay.dispose(); });

function harness(options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const toServer = [], toClient = [], traces = [];
  const serverWaiters = [];
  serverIn.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => {
    const msg = JSON.parse(l); msg.receivedAt = performance.now(); toServer.push(msg);
    serverWaiters.splice(0).forEach(resolve => resolve(msg));
  }));
  clientOut.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toClient.push(JSON.parse(l))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 'session-1', changeReview: false,
    trace: (direction, msg) => traces.push([direction, msg]), ...options });
  relays.push(relay);
  return { relay, toServer, toClient, traces,
    nextServer: () => new Promise(resolve => serverWaiters.push(resolve)),
    fromClient: msg => clientIn.write(JSON.stringify(msg) + '\n'),
    fromServer: msg => serverOut.write(JSON.stringify(msg) + '\n') };
}
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
const js = (h, id, code) => h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } });
const read = async h => {
  js(h, 1, 'let app = await cua.getApp("Calculator")');
  await settle();
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: TREE }, { type: 'image', data: png(464, 640), mimeType: 'image/png' }] } });
  await settle();
};

test('run recording receives existing native and local screenshot pixels without another engine request', async () => {
  const captures = [], cursor = { status() {}, close() {}, screenshot: (content, detail) => { if (content?.some(i => i.type === 'image')) captures.push({ content, detail }); } };
  const localImage = { type: 'image', mimeType: 'image/png', data: png(100, 50) };
  const h = harness({ cursor, localTools: { tools: [{ name: 'hover', inputSchema: { type: 'object' } }],
    call: async () => ({ content: [localImage] }) } });
  await read(h);
  assert.equal(captures.length, 1); assert.equal(captures[0].detail.source, 'native');
  assert.equal(captures[0].content.find(i => i.type === 'image').data, png(464, 640));
  const before = h.toServer.length;
  h.fromClient({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'hover', arguments: { app: 'Calculator' } } });
  await settle();
  assert.equal(captures.length, 2); assert.equal(captures[1].detail.source, 'local'); assert.deepEqual(captures[1].content, [localImage]);
  assert.equal(h.toServer.length, before); h.relay.close();
});

test('a broken optional screenshot recorder cannot lose the native reply', async () => {
  const h = harness({ cursor: { status() {}, close() {}, screenshot() { throw Error('fixture disk fault'); } } });
  await read(h);
  assert.equal(h.toClient.at(-1).id, 1); assert.equal(h.toClient.at(-1).result.content.some(i => i.type === 'image'), true);
  h.relay.close();
});

function recorder() {
  const events = [];
  return { events, admit: (id, input) => events.push(['admit', id, input]), approval: (id, meta) => events.push(['approval', id, meta?.tool_name]),
    answered: (id, action) => events.push(['answered', id, action]), result: (id, failed) => events.push(['result', id, failed]),
    hide: () => events.push(['hide']), close: () => events.push(['close']) };
}

test('the relay tells the hand about admitted actions, approvals, results and local pointer tools, and nothing else', async () => {
  const hand = recorder();
  const h = harness({ hand, localTools: { tools: [{ name: 'drag', inputSchema: { type: 'object' } }], call: async () => ({ content: [] }) } });
  await read(h);
  assert.equal(hand.events.filter(([e]) => e === 'admit').length, 0, 'a read has no hand');
  js(h, 2, 'await app.click(1)');
  await settle();
  assert.equal(h.toServer.at(-1).id, 2, 'the call reached the engine');
  const [, id, input] = hand.events.find(([e]) => e === 'admit');
  assert.equal(id, 2);
  assert.equal(input.code, 'await app.click(1)');
  assert.deepEqual([input.target.app, input.target.title], ['Calculator', 'Calculator']);
  assert.deepEqual(input.lines(), { 0: 'standard window Calculator', 1: 'button Description: 7, ID: Seven', 2: 'button Description: 8, ID: Eight' });
  assert.deepEqual(input.screenshotSize(), [464, 640]);
  // The engine asks about the click; the user accepts through the client.
  h.fromServer({ jsonrpc: '2.0', id: 'e1', method: 'elicitation/create', params: { message: 'Allow?', requestedSchema: { type: 'object', properties: {} },
    _meta: { connector_id: 'computer-use', tool_name: 'click', tool_params: { app: 'Calculator' }, persist: ['session'] } } });
  await settle();
  h.fromClient({ jsonrpc: '2.0', id: 'e1', result: { action: 'accept', content: {} } });
  await settle();
  h.fromServer({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: TREE }] } });
  await settle();
  const sequence = hand.events.slice(hand.events.findIndex(([e]) => e === 'admit') + 1);
  // finishedCall's report after the result is ignored by the hand session.
  assert.deepEqual(sequence, [['approval', 'e1', 'click'], ['answered', 'e1', 'accept'], ['result', 2, false], ['result', 2, true]]);
  h.fromClient({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'drag', arguments: { app: 'Calculator', from: [1, 1], to: [2, 2] } } });
  await settle();
  assert.ok(hand.events.some(([e]) => e === 'hide'), 'hidden before the local drag');
  h.relay.close();
  assert.deepEqual(hand.events.at(-1), ['close']);
});

test('end to end, an admitted click(N) becomes one frame at the element, after the call reached the engine', async () => {
  const sent = [];
  const client = { enabled: true, send: frame => sent.push(frame), hide() {}, close() {} };
  const requests = [];
  const hand = createRelayHand({ client, env: { SLEIGHT_HAND: '1' }, setting: () => ({ enabled: true }), locate: async request => { requests.push(request); return GEOMETRY; } });
  const h = harness({ hand });
  await read(h);
  js(h, 2, 'await app.click(1); await app.click([116, 160]);');
  assert.deepEqual(requests, [], 'nothing is looked up inside admission');
  await settle();
  assert.deepEqual(requests.map(r => [r.app, r.title, r.identities]), [['Calculator', 'Calculator', { 1: { role: 'AXButton', id: 'Seven', description: '7', title: undefined } }]]);
  assert.deepEqual(sent.map(f => [f.kind, f.pid, f.windowId, f.at]), [['click', 900, 31, [630, 320]], ['click', 900, 31, [658, 180]]]);
});

// Admission cost: time from the client's line to the engine receiving it, hand off against on (a fake client and an
// instant locate, so the deferred planning runs on the same event loop between calls). Also the synchronous cost of admit.
test('the hand adds under 1 ms to admission', async t => {
  const N = 300;
  async function measure(hand) {
    const h = harness(hand ? { hand } : {});
    await read(h);
    const admission = [], roundTrip = [];
    for (let i = 0; i < N; i++) {
      const id = 100 + i, code = i % 2 ? 'await app.click(1); await app.typeText("7")' : 'await app.click([116, 160])';
      const received = h.nextServer();
      const start = performance.now();
      js(h, id, code);
      const msg = await received;
      admission.push(msg.receivedAt - start);
      h.fromServer({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: TREE }] } });
      await settle();
      roundTrip.push(performance.now() - start);
    }
    h.relay.close();
    const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
    const p95 = list => [...list].sort((a, b) => a - b)[Math.floor(list.length * 0.95)];
    return { median: median(admission), p95: p95(admission), roundTrip: median(roundTrip) };
  }
  const sent = [];
  const makeHand = () => createRelayHand({ client: { enabled: true, send: f => sent.push(f), hide() {}, close() {} }, env: { SLEIGHT_HAND: '1' }, setting: () => ({ enabled: true }), locate: async () => GEOMETRY });
  await measure(); await measure(makeHand()); // warm both paths
  const off = await measure();
  sent.length = 0;
  const on = await measure(makeHand());
  assert.ok(sent.length >= N, 'the hand really planned frames during the timed run');
  // admit alone, with each call finished before the next as in a session.
  const hand = makeHand();
  let admitting = 0;
  for (let i = 0; i < 10000; i++) {
    const started = performance.now();
    hand.admit(i, { code: 'await app.click([1, 1])', target: { app: 'Calculator' }, lines: () => ({}), screenshotSize: () => [1, 1] });
    admitting += performance.now() - started;
    hand.result(i, true);
  }
  const admitUs = admitting / 10000 * 1000;
  hand.close();
  t.diagnostic(`admission median off ${off.median.toFixed(3)} ms, on ${on.median.toFixed(3)} ms; p95 off ${off.p95.toFixed(3)}, on ${on.p95.toFixed(3)}; ` +
    `round trip median off ${off.roundTrip.toFixed(3)}, on ${on.roundTrip.toFixed(3)}; hand.admit ${admitUs.toFixed(2)} µs`);
  assert.ok(on.median - off.median < 1, `admission ${on.median} ms with the hand against ${off.median} ms without`);
  assert.ok(admitUs < 50, `admit took ${admitUs} µs`);
});
