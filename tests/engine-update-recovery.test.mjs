// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { createContext, runInContext } from 'node:vm';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { PreapprovedApps } from '../plugins/sleight/lib/preapproved.mjs';
import { createStartupCache } from '../plugins/sleight/lib/startup-cache.mjs';
import { EventEmitter } from 'node:events';
import { createV3Bridge, createV3Frontend, serveV3Worker } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const tree = 'Window: "Untitled", App: Example.\n0 standard window Untitled\n\t7 button Keep, ID: keep';
const pipeError = { isError: true, content: [{ type: 'text', text: 'Sky Computer Use native pipe startup failed' }] };
const approval = (app = 'Example') => ({ id: 'permission', method: 'elicitation/create', params: { message: `Allow ${app}?`,
  _meta: { connector_id: 'computer-use', persist: ['session'], tool_params: { app }, riskLevel: 'low' } } });
const flush = async () => { for (let n = 0; n < 10; n++) await setImmediate(); };
const until = async condition => { for (let n = 0; n < 200 && !condition(); n++) await setImmediate(); };

// A turbo v3 frontend over an in-process worker channel. `ends` counts the end frames the worker received.
async function v3Frontend(t, call = async () => ({ text: 'plain result', isError: false })) {
  const child = new EventEmitter(), endpoint = new EventEmitter(), counts = { ends: 0 };
  child.connected = endpoint.connected = true;
  child.send = value => { queueMicrotask(() => endpoint.emit('message', structuredClone(value))); };
  endpoint.send = value => { queueMicrotask(() => child.emit('message', structuredClone(value))); };
  child.disconnect = () => { child.connected = endpoint.connected = false; endpoint.emit('disconnect'); child.emit('disconnect'); };
  child.unref = () => {};
  endpoint.on('message', frame => { if (frame.method === 'end') counts.ends++; });
  const session = serveV3Worker({ channel: endpoint, browser: 'bfixture', async begin() {
    return { call, delivered: () => true, async end() { return { revoked: true, cleanup: [] }; } };
  } });
  const bridge = await createV3Bridge({}, { readConfig: () => ({}), acceptPackage: () => ({ current: () => true }),
    forkWorker() { queueMicrotask(() => session.ready()); return child; } });
  t.after(() => bridge.detach());
  assert.equal(await bridge.bind({ ...bridge.bootstrapEnvelope(), event: 'begin', turn: 'turn1', text: 'read the page' }), true);
  return { directBrowser: createV3Frontend(bridge), counts };
}

function fixture(t, options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), replies = [], engines = [];
  let asks = 0, stops = 0, starts = 0, changed = false;
  const fresh = () => {
    const serverIn = new PassThrough(), serverOut = new PassThrough(), sent = [], turnEnds = []; // turnEnds: collections done when each turn_ended arrived
    const reply = msg => serverOut.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
    serverIn.on('data', bytes => {
      for (const line of bytes.toString().trim().split('\n')) {
        const msg = JSON.parse(line); sent.push(msg);
        if (msg.method === 'initialize' && !options.holdInitialize) reply({ id: msg.id,
          ...(starts && (options.initializeError === true || options.initializeError === starts) ? { error: { code: -32603, message: 'fixture initialization failed' } }
            : { result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } }) });
        if (msg.params?.name === 'turn_ended') {
          turnEnds.push(stops);
          if (!options.silentTurnEnd) reply({ id: msg.id, result: { content: [] } });
        }
      }
    });
    engines.push({ serverIn, serverOut, sent, reply, turnEnds });
    return { serverIn, serverOut };
  };
  clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, ...fresh(), changeReview: false, stopGraceMs: 1,
    ask: async () => { asks++; return 'accept'; },
    engineChanged: () => changed,
    stopEngine: async () => { stops++; return { collected: options.collected !== false }; },
    restartEngine: async () => { starts++; changed = false; return fresh(); },
    inspectInput: async () => ({ ok: true }),
    ...options.relay,
  });
  t.after(() => relay.dispose());
  const send = msg => clientIn.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  send({ id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  send({ method: 'notifications/initialized' });
  return { relay, replies, engines, send, replace: () => { changed = true; },
    get starts() { return starts; }, get stops() { return stops; }, get asks() { return asks; },
    call: (id, code) => send({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }),
    reply: (id, result = { content: [{ type: 'text', text: tree }], _meta: { 'codex/toolSurface': { app: { appId: 'test.example' } } } }) =>
      engines.at(-1).reply({ id, result }),
  };
}

test('a pipe error during an update reconnects and keeps preapproved grants', async t => {
  const preapproved = new PreapprovedApps({ version: 1, apps: [{ app: 'Example', riskLevel: 'low' }] });
  const h = fixture(t, { relay: { preapproved } });
  h.call(1, 'await cua.getApp("Example")'); h.engines[0].reply(approval()); await flush(); h.reply(1);
  h.call(2, 'await cua.getApp("Example")'); h.replace(); h.reply(2, pipeError); await flush();
  assert.equal(h.starts, 1); assert.equal(h.stops, 1);
  const identity = engine => JSON.parse(Object.values(engine.sent.find(msg => msg.id === 2).params._meta)[0]);
  const ended = h.engines[0].sent.find(msg => msg.params?.name === 'turn_ended');
  assert.ok(ended, 'the replaced engine is told its turn ended before it is collected');
  assert.equal(ended.params.arguments.turn_id, identity(h.engines[0]).turn_id);
  assert.equal(identity(h.engines[1]).session_id, identity(h.engines[0]).session_id, 'reconnection keeps the client session');
  assert.notEqual(identity(h.engines[1]).turn_id, identity(h.engines[0]).turn_id, 'the replacement starts a new turn');
  h.engines[1].reply(approval()); await flush(); h.reply(2);
  assert.equal(h.asks, 0);
  assert.equal(h.engines[1].sent.find(msg => msg.result?.action)?.result.action, 'accept');
  assert.ok(!h.replies.find(msg => msg.id === 2).result.isError);
  assert.equal(h.replies.filter(msg => msg.id === 2).length, 1);
});

for (const handle of ['app', '$app']) for (const proactive of [false, true]) for (const fail of [false, true]) test(`reconnected ${handle} keeps the stale-number guard (${proactive ? 'version change' : 'pipe error'}, ${fail ? 'changed' : 'same'} row)`, async t => {
  const h = fixture(t, { relay: { inputLease: { acquire: () => 'owned', grant: () => undefined, renew() {}, close() {} } } });
  h.call(1, `let ${handle} = await cua.getApp("Example")`); h.reply(1);
  if (proactive) h.replace();
  h.call(2, `await ${handle}.click(7)`);
  if (!proactive) { h.replace(); h.reply(2, pipeError); }
  await flush();
  assert.equal(h.starts, 1);
  const request = h.engines[1].sent.find(msg => msg.id === 2);
  assert.ok(request, 'the pending action is retried after initialization');
  let clicks = 0;
  const raw = { getAXState: async () => fail ? tree.replace('Keep, ID: keep', 'Delete, ID: delete') : tree,
    click: async () => { clicks++; }, appId: 'test.example' };
  const context = createContext({ cua: { getApp: async id => { assert.equal(id, 'Example', 'a handle is reacquired with its original argument'); return raw; } }, nodeRepl: { write() {} } });
  const execute = () => runInContext(`(async () => { ${request.params.arguments.code} })()`, context);
  if (fail) { await assert.rejects(execute, /changed|stale|matches/i); assert.equal(clicks, 0); }
  else { await execute(); assert.equal(clicks, 1); }
  h.reply(2);
});

test('an initialization failure returns the original pipe error and the failed reconnect, without a retry loop', async t => {
  const h = fixture(t, { initializeError: true });
  h.call(1, 'await cua.getApp("Example")'); h.replace(); h.reply(1, pipeError); await flush();
  const reply = h.replies.find(msg => msg.id === 1);
  assert.equal(reply.result.isError, true);
  assert.match(JSON.stringify(reply), /Sky Computer Use native pipe startup failed/);
  assert.match(JSON.stringify(reply), /fixture initialization failed/);
  assert.equal(h.starts, 1);
  assert.equal(h.engines[1].sent.some(msg => msg.method === 'tools/call' && msg.params.name === 'js'), false);
});

test('failed collection never starts a replacement or hides the pending failure', async t => {
  const h = fixture(t, { collected: false });
  h.call(1, 'await cua.getApp("Example")'); h.replace(); h.reply(1, pipeError); await flush();
  assert.equal(h.starts, 0);
  assert.match(JSON.stringify(h.replies.find(msg => msg.id === 1)), /collection is unconfirmed/);
  h.call(2, 'await cua.getApp("Example")');
  assert.match(JSON.stringify(h.replies.find(msg => msg.id === 2)), /collection is unconfirmed/);
  assert.equal(h.stops, 1);
});

test('version changes and pipe failures do not collect another pending call', async t => {
  const h = fixture(t);
  h.call(1, 'await cua.getState()'); h.replace(); h.call(2, 'await cua.getState()');
  assert.match(JSON.stringify(h.replies.find(msg => msg.id === 2)), /pending/);
  assert.equal(h.stops, 0);
  // A second already-running read also prevents collection on an error.
  const other = fixture(t);
  other.call(1, 'await cua.getState()'); other.call(2, 'await cua.getState()');
  other.replace(); other.reply(1, pipeError); await flush();
  assert.equal(other.stops, 0); assert.equal(other.starts, 0);
  assert.equal(other.replies.find(msg => msg.id === 1).result.isError, true);
  other.reply(2); h.reply(1);
});

test('Stop during replacement initialization prevents the queued retry and keeps internal replies private', async t => {
  const h = fixture(t, { holdInitialize: true });
  h.engines[0].reply({ id: 'init', result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } });
  h.call(1, 'await cua.getApp("Example")'); h.replace(); h.reply(1, pipeError); await flush();
  assert.equal(h.starts, 1);
  h.send({ id: 'stop', method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_stop: true } } });
  await flush();
  assert.ok(h.replies.find(msg => msg.id === 'stop'));
  assert.equal(h.engines[1].sent.some(msg => msg.params?.name === 'js'), false);
  assert.equal(h.replies.some(msg => String(msg.id).startsWith('sleight-initialize-')), false);
});

test('a replacement never serves or verifies its tools against the old engine handshake cache', async t => {
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-update-cache-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const startupCache = createStartupCache({ directory, identity: { engine: 'old' } });
  const warm = fixture(t, { relay: { startupCache } });
  warm.send({ id: 'old-list', method: 'tools/list' });
  warm.engines[0].reply({ id: 'old-list', result: { tools: [{ name: 'js', description: 'Old engine', inputSchema: { type: 'object' } }] } });
  warm.relay.dispose();
  const h = fixture(t, { relay: { startupCache } });
  h.call(1, 'await cua.getApp("Example")'); h.replace(); h.reply(1, pipeError); await flush(); h.reply(1);
  h.send({ id: 'new-list', method: 'tools/list' });
  assert.equal(h.replies.some(msg => msg.id === 'new-list'), false, 'old cached tools must not escape');
  h.engines[1].reply({ id: 'new-list', result: { tools: [{ name: 'js', description: 'New engine', inputSchema: { type: 'object' } }] } });
  assert.match(h.replies.find(msg => msg.id === 'new-list').result.tools[0].description, /New engine/);
});

test('a reconnect ends the old engine turn before collecting it, and a silent engine only costs the grace period', async t => {
  for (const silentTurnEnd of [false, true]) {
    const h = fixture(t, { silentTurnEnd });
    h.call(1, 'await cua.getApp("Example")'); h.reply(1);
    h.replace();
    h.call(2, 'await cua.getApp("Example")'); await flush(); await new Promise(resolve => setTimeout(resolve, 20)); await flush();
    assert.deepEqual(h.engines[0].turnEnds, [0], 'the turn ended while the engine was still alive');
    assert.equal(h.stops, 1);
    assert.equal(h.starts, 1, 'the reconnect went ahead');
    assert.ok(h.engines[1].sent.some(msg => msg.id === 2), 'the call reached the replacement');
    h.reply(2);
    h.call(3, 'await cua.getApp("Example")'); h.reply(3);
    assert.equal(h.stops, 1, 'no leftover turn-end request blocks or repeats a reconnect');
  }
});

test('a handle approved by name is reacquired by name after a reconnect, so the user is not asked again', async t => {
  for (const proactive of [true, false]) {
    const h = fixture(t, { relay: { inputLease: { acquire: () => 'owned', grant: () => undefined, renew() {}, close() {} } } });
    h.call(1, 'let app = await cua.getApp("Example")'); h.engines[0].reply(approval('Example')); await flush(); h.reply(1);
    assert.equal(h.asks, 1);
    if (proactive) h.replace();
    h.call(2, 'await app.click(7)');
    if (!proactive) { h.replace(); h.reply(2, pipeError); }
    await flush();
    assert.equal(h.starts, 1);
    const code = h.engines[1].sent.find(msg => msg.id === 2).params.arguments.code;
    assert.ok(code.includes('globalThis["app"] = await cua.getApp("Example");'), 'reacquired by name');
    assert.ok(!code.includes('getApp("test.example")'));
    // The replacement asks for the app by the name it was given; the remembered answer covers it.
    h.engines[1].reply(approval('Example')); await flush(); h.reply(2);
    assert.equal(h.asks, 1, 'the user is asked 0 times after the reconnect');
    assert.equal(h.engines[1].sent.find(msg => msg.result?.action)?.result.action, 'accept');
  }
});

test('Stop after a failed reconnect makes the next engine start a fresh turn', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = fixture(t, { initializeError: 1 });
  h.call(1, 'await cua.getApp("Example")'); h.reply(1);
  h.replace();
  h.call(2, 'await cua.getApp("Example")'); await flush();
  assert.equal(h.starts, 1);
  assert.equal(h.replies.find(msg => msg.id === 2).result.isError, true, 'the replacement failed to initialize');
  const failedTurn = h.relay.turnId;
  h.send({ id: 'stop', method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_stop: true } } });
  // The failed initialization leaves a running call for Stop's 1 ms drain grace.
  // Advance it explicitly: immediate-loop polling need not let wall time elapse.
  await flush();
  assert.equal(h.replies.some(msg => msg.id === 'stop'), false, 'Stop waits for the drain grace');
  t.mock.timers.tick(1);
  await until(() => h.replies.some(msg => msg.id === 'stop'));
  assert.ok(h.replies.some(msg => msg.id === 'stop'), 'Stop completed before resume');
  h.send({ id: 'resume', method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_resume: true } } });
  await until(() => h.replies.some(msg => msg.id === 'resume'));
  h.call(3, 'await cua.getApp("Example")');
  await until(() => h.engines[2]?.sent.some(msg => msg.id === 3));
  assert.equal(h.starts, 2);
  assert.notEqual(h.relay.turnId, failedTurn, 'a restart after Stop is not an update restart');
});

test('an engine that dies on its own revokes direct browser work and still recovers on the next call', async t => {
  const { directBrowser, counts } = await v3Frontend(t);
  const h = fixture(t, { relay: { directBrowser } });
  h.call(1, 'await cua.getApp("Example")'); h.reply(1);
  h.relay.engineEnded('Engine exited (25).');
  await until(() => counts.ends === 1);
  assert.equal(counts.ends, 1);
  h.call(2, 'await cua.getApp("Example")');
  await until(() => h.engines[1]?.sent.some(msg => msg.id === 2));
  assert.equal(h.starts, 1);
  await flush();
  assert.equal(counts.ends, 1, 'the recovery does not end the work twice');
  h.reply(2);
  await flush();
  assert.ok(!h.replies.find(msg => msg.id === 2).result.isError);
});

test('the call that triggers a reconnect lands in the new turn receipt, answered, not in the closed one as pending', async t => {
  const written = [];
  const h = fixture(t, { relay: { receipts: true, receiptWriter: receipt => { written.push(receipt); return `${MAC_TMP}/receipt.json`; } } });
  h.call(1, 'let app = await cua.getApp("Example")'); h.reply(1);
  h.replace();
  h.call(2, 'await cua.getApp("Example")');
  await until(() => h.engines[1]?.sent.some(msg => msg.id === 2));
  assert.equal(written.length, 1, 'the old turn closed with its receipt');
  assert.equal(written[0].calls.length, 1);
  assert.doesNotMatch(JSON.stringify(written[0]), /pending/);
  h.reply(2); await flush();
  await h.relay.endOpenTurn();
  assert.equal(written.length, 2);
  assert.equal(written[1].calls.length, 1, 'the replayed call is journaled once, in the new turn');
  assert.doesNotMatch(JSON.stringify(written[1]), /pending/);
});

test('a handle rebound to another app by a read is reacquired by the new app, not its old argument', async t => {
  const h = fixture(t, { relay: { inputLease: { acquire: () => 'owned', grant: () => undefined, renew() {}, close() {} } } });
  h.call(1, 'let app = await cua.getApp("Example")'); h.reply(1);
  h.call(2, 'await app.getAXState()');
  h.reply(2, { content: [{ type: 'text', text: tree.replace('App: Example', 'App: Other') }], _meta: { 'codex/toolSurface': { app: { appId: 'test.other' } } } });
  await flush();
  h.replace();
  h.call(3, 'await app.click(7)');
  await until(() => h.engines[1]?.sent.some(msg => msg.id === 3));
  const code = h.engines[1].sent.find(msg => msg.id === 3).params.arguments.code;
  assert.ok(code.includes('globalThis["app"] = await cua.getApp("test.other");'), 'reacquired by the bundle ID it is bound to now');
  assert.ok(!code.includes('globalThis["app"] = await cua.getApp("Example");'));
});

test('a direct browser call running when the engine dies is answered once', async t => {
  let finish;
  const { directBrowser } = await v3Frontend(t, () => new Promise(resolve => { finish = resolve; }));
  const h = fixture(t, { relay: { directBrowser } });
  h.send({ id: 7, method: 'tools/call', params: { name: 'browser_read', arguments: { tab: 't1' } } });
  await until(() => finish);
  h.relay.engineEnded('Engine exited (25).');
  await flush();
  assert.equal(h.replies.filter(msg => msg.id === 7).length, 1);
  assert.equal(h.replies.find(msg => msg.id === 7).result.isError, true);
  finish?.({ text: 'late result', isError: false });
  await flush();
  assert.equal(h.replies.filter(msg => msg.id === 7).length, 1, 'the late direct result is not a second reply');
});

for (const outcomes of [false, true]) for (const completeness of [false, true]) for (const action of [false, true]) for (const proactive of [false, true])
  test(`reconnect carries ${action ? 'action' : 'read'} tracking, outcomes=${outcomes}, completeness=${completeness}, proactive=${proactive}`, async t => {
    const h = fixture(t, { relay: { outcomes, completeness } });
    h.call(1, 'let app = await cua.getApp("Example")'); h.reply(1);
    // Earlier uncertainty must belong to the old turn only.
    h.call(2, 'await app.pressKey("Tab")'); h.reply(2, { content: [{ type: 'text', text: 'sent' }] });
    if (proactive) h.replace();
    h.call(3, action ? 'await app.pressKey("Return")' : 'nodeRepl.write(await app.getAXState())');
    if (!proactive) { h.replace(); h.reply(3, pipeError); }
    await until(() => h.engines[1]?.sent.some(msg => msg.id === 3));
    assert.equal(h.starts, 1);
    h.reply(3); await flush();
    const result = h.replies.find(msg => msg.id === 3);
    assert.ok(result && !result.result.isError);
    const text = result.result.content.map(row => row.text).join('\n');
    assert.equal(/# complete \(returned engine view/.test(text), completeness && !action);
    assert.equal(/sleight turn: 1 input calls unverified/.test(text), outcomes && action);
    assert.doesNotMatch(text, /2 input calls|pressKey Tab/);
  });
