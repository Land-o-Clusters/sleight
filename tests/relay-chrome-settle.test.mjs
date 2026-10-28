import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRelay, chromeOnlyTree } from '../plugins/sleight/lib/relay.mjs';
import { createContext, runInContext, runInNewContext } from 'node:vm';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';

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
  const recorded = [], h = harness({ cursor: { status() {}, close() {}, screenshot: content => recorded.push(...content.filter(c => c.type === 'image').map(c => c.data)) } });
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
  assert.deepEqual(recorded, ['still'], 'only the replacement delivered to Claude reaches the recording');
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

// CA2 requires the dispatched callee and literal data to match inspection. The
// historical scroll-to-swipe substitution changes both and must now refuse.
test('chrome-only scroll-to-swipe substitutions refuse before engine dispatch', async () => {
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(0x0d0a1a0a, 4);
  png.writeUInt32BE(400, 16); png.writeUInt32BE(1000, 20);
  const h = harness();
  js(h, 1, 'let app = await cua.getApp("Stream")'); await settle();
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [
    { type: 'text', text: IPHONE.replaceAll('iPhone Mirroring', 'Stream') }, image(png.toString('base64'))] } }); await settle();
  for (const [id, direction, distance] of [[2, 'down', '0.5'], [3, 'up', '1'],
    [4, 'left', '0.5'], [5, 'right', '{ pixels: 100 }'], [6, 'constructor', '0.5']]) {
    js(h, id, `await app.scroll([200, 500], ${JSON.stringify(direction)}, ${distance})`); await settle();
    assert.equal(h.toServer.some(message => message.id === id), false);
    const reply = h.toClient.find(message => message.id === id).result;
    assert.equal(reply.isError, true);
    assert.match(reply.content[0].text, /cannot inspect JavaScript/);
  }
});

test('normal trees, other handles and text mentioning scroll keep the original behavior', async () => {
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(0x0d0a1a0a, 4);
  png.writeUInt32BE(400, 16); png.writeUInt32BE(1000, 20);
  for (const text of [CALCULATOR, IPHONE]) {
    const h = harness();
    js(h, 1, 'let app = await cua.getApp("Stream")'); await settle();
    h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }, image(png.toString('base64'))] } }); await settle();
    const code = text === CALCULATOR ? 'await app.scroll([1, 2], "down", 0.5)' :
      'await other.scroll([1, 2], "down", 0.5); await app.typeText("app.scroll([1, 2], \'down\')")';
    js(h, 2, code); await settle();
    assert.equal(h.toServer.find(m => m.id === 2).params.arguments.code, code);
  }
});

test('a guarded swipe substitution refuses before a window read or drag', async t => {
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(0x0d0a1a0a, 4);
  png.writeUInt32BE(400, 16); png.writeUInt32BE(1000, 20);
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-chrome-swipe-')));
  t.after(() => removeTemp(directory));
  const inputLease = new InputLease({ directory, holder: 'swipe-test' });
  // Exercise the window guard in the VM without its dynamic filesystem import for lease tokens.
  inputLease.grant = () => undefined;
  const h = harness({ inputLease, guardMode: 'careful' });
  let state = IPHONE, dragged = 0;
  const raw = { getAXState: async () => state, drag: async () => { dragged++; }, scroll: async () => assert.fail('native scroll') };
  const context = createContext({ app: undefined, cua: { getApp: async () => raw, listApps: async () => [] }, nodeRepl: { write() {} } });
  const run = code => runInContext(`(async () => { ${code} })()`, context);
  js(h, 1, 'app = await cua.getApp("Stream")'); await settle();
  await run(h.toServer.find(m => m.id === 1).params.arguments.code);
  h.fromServer({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: IPHONE }, image(png.toString('base64'))],
    _meta: { 'codex/toolSurface': { app: { appId: 'com.example.stream', kind: 'appId' }, kind: 'computerUse' } } } }); await settle();
  js(h, 2, 'await app.scroll([200, 500], "down", 0.5)'); await settle();
  assert.equal(h.toServer.some(message => message.id === 2), false);
  assert.match(h.toClient.find(message => message.id === 2).result.content[0].text, /cannot inspect JavaScript/);
  assert.equal(dragged, 0);
});
