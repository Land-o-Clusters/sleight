import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRelay, chromeOnlyTree } from '../plugins/sleight/lib/relay.mjs';

const IPHONE = 'Window: "iPhone Mirroring", App: iPhone Mirroring.\n' +
  '0 standard window iPhone Mirroring, ID: iphone-mirroring-main, Secondary Actions: Raise\n' +
  '1 menu bar\n\t2 iPhone Mirroring\n\t3 Edit\n\t4 View\n\t5 Window\n\t6 Help';
const CALCULATOR = 'Window: "Calculator", App: Calculator.\n0 standard window\n1 button One\n2 button Two';
const image = (data) => ({ type: 'image', data, mimeType: 'image/png' });

const relays = [];
after(() => { for (const relay of relays) relay.dispose(); });

function harness(options = {}) {
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const serverIn = new PassThrough();
  const serverOut = new PassThrough();
  const toServer = [];
  const toClient = [];
  const traces = [];
  serverIn.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toServer.push(JSON.parse(l))));
  clientOut.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(l => toClient.push(JSON.parse(l))));
  let t = 0;
  const relay = createRelay({
    clientIn, clientOut, serverIn, serverOut, sessionId: 'session-1', changeReview: false,
    now: () => t, chromeSettleSleep: async ms => { t += ms; },
    trace: (direction, msg) => traces.push([direction, msg]),
    ...options,
  });
  relays.push(relay);
  return {
    toServer, toClient, traces,
    fromClient: msg => clientIn.write(JSON.stringify(msg) + '\n'),
    fromServer: msg => serverOut.write(JSON.stringify(msg) + '\n'),
  };
}

const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };

function js(h, id, code) {
  h.fromClient({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } });
}

test('a tree of only the window and menu bar is chrome-only; a real tree is not', () => {
  assert.equal(chromeOnlyTree(IPHONE), true);
  assert.equal(chromeOnlyTree('Window: "x", App: y.\n0 standard window x\n\t1 button Close\n\t2 button Minimize\n1 menu bar\n\t2 File'), true);
  assert.equal(chromeOnlyTree(CALCULATOR), false);
  assert.equal(chromeOnlyTree('Window: "a.txt", App: TextEdit.\n0 standard window a.txt\n\t1 text entry area'), false);
  assert.equal(chromeOnlyTree(''), false);
  assert.equal(chromeOnlyTree('1 button One'), false);
});

test('after an action, a chrome-only screenshot waits until two shots match and traces the wait', async () => {
  const h = harness();
  js(h, 1, 'await app.click([200, 860]); await app.getScreenshot()');
  await settle();
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: IPHONE }, image('moving')] } });
  await settle();
  assert.equal(h.toClient.length, 0, 'holds the screenshot until a later frame matches');
  const extra = h.toServer.find(m => String(m.id).startsWith('sleight-chrome-settle-'));
  assert.ok(extra, 'asks the engine for another screenshot');
  assert.match(extra.params.arguments.code, /await app\.getScreenshot\(\)/);
  h.fromServer({ jsonrpc: '2.0', id: extra.id, result: { content: [image('still')] } });
  await settle();
  assert.equal(h.toClient.length, 0);
  const extra2 = h.toServer.filter(m => String(m.id).startsWith('sleight-chrome-settle-')).at(-1);
  assert.notEqual(extra2.id, extra.id);
  h.fromServer({ jsonrpc: '2.0', id: extra2.id, result: { content: [image('still')] } });
  await settle();
  assert.equal(h.toClient.length, 1);
  const images = h.toClient[0].result.content.filter(b => b.type === 'image').map(b => b.data);
  assert.deepEqual(images, ['still']);
  const wait = h.traces.find(([d]) => d === 'chrome-settle');
  assert.ok(wait, 'records the wait in the trace');
  assert.equal(wait[1].matched, true);
  assert.ok(wait[1].waitedMs >= 0);
  assert.ok(wait[1].shots >= 3);
});

test('a real tree returns its screenshot without a settle wait', async () => {
  const h = harness();
  js(h, 1, 'await app.click(1); await app.getScreenshot()');
  await settle();
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: CALCULATOR }, image('shot')] } });
  await settle();
  assert.equal(h.toClient.length, 1);
  assert.equal(h.toServer.filter(m => String(m.id).startsWith('sleight-chrome-settle-')).length, 0);
  assert.equal(h.traces.some(([d]) => d === 'chrome-settle'), false);
});

test('a chrome-only read with no action skips the settle wait', async () => {
  const h = harness();
  js(h, 1, 'await app.getScreenshot()');
  await settle();
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: IPHONE }, image('shot')] } });
  await settle();
  assert.equal(h.toClient.length, 1);
  assert.equal(h.toServer.filter(m => String(m.id).startsWith('sleight-chrome-settle-')).length, 0);
});
