import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { sourceURL, replaceSite } from './fixtures/browser-geometry.mjs';
const variant = process.env.INT23D_TURN_VARIANT;
const { createRelay } = await import(variant ? sourceURL('relay.mjs', source => {
  if (variant === 'rotate-unused-end') source = replaceSite(source,
    '    if (turnUsed) {\n      finishReceipt(); journal?.put(carried);', '    if (true) {\n      finishReceipt(); journal?.put(carried);');
  if (variant === 'rotate-unused-hook') source = replaceSite(source, 'releaseLeases(); releaseCursorTurn();', 'rotateTurn();');
  if (variant === 'idle-releases-targets') source = replaceSite(source,
    'rotateTurn(carryId, { release: !preserveTargets })', 'rotateTurn(carryId, { release: true })');
  if (variant === 'forged-release-before-attribution') source = replaceSite(source,
    'if (privateFrame && (!modAttributed(msg) || disposed || msg.id === undefined)) {',
    'if (privateFrame && (!modAttributed(msg) || disposed || msg.id === undefined)) { releaseCursorTurn(true);');

  return source;
}) : new URL('../plugins/sleight/lib/relay.mjs', import.meta.url).href);
import { createCursorEvents } from '../plugins/sleight/lib/hand/events.mjs';
import { createHandClient } from '../plugins/sleight/lib/hand/client.mjs';
import { setHandPid } from '../plugins/sleight/lib/hand/pid.mjs';
import { modCall } from './fixtures/mod-attribution.mjs';
import { createV3Bridge, createV3Frontend, serveV3Worker } from '../plugins/sleight/lib/direct-browser/worker.mjs';

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };

// The real relay, projection and client write to a fake pipe. No native host, app or window is launched.
test('CR2A generic relay replies complete calls and only turn rotation ends the turn', async t => {
  const lines = [], records = [], setting = () => ({ enabled: true, style: 'ring', stream: false });
  const child = new EventEmitter(); child.pid = 4242;
  child.stdin = Object.assign(new EventEmitter(), { writableLength: 0,
    write(text) { lines.push(...text.trim().split('\n').map(JSON.parse)); return true; }, end() {} });
  child.stdout = new EventEmitter(); child.kill = () => {};
  child.stdio = [child.stdin, child.stdout, null, new PassThrough(), new PassThrough()];
  const client = createHandClient({ setting, onPause: value => cursor.setPaused(value), watch: () => undefined, permissions: null, usage: null, built: () => true,
    prepare: async () => ({ status: 'ready', spawn: () => child }) });
  const cursor = createCursorEvents({ setting, onEvent: event => records.push(event), sink: { write() {}, close() {} } });
  cursor.connectHost(client);
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough(), forwarded = [];
  serverIn.on('data', bytes => forwarded.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, cursor, sessionId: 'fixture', changeReview: false });
  t.after(() => { relay.dispose(); client.close(); cursor.close(); setHandPid(0); });
  const request = message => clientIn.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  client.send({ hand: 'aim', kind: 'click', pid: 42, windowId: 7, at: [650, 700],
    rect: [200, 500, 900, 350], windowRect: [200, 500, 900, 350] });
  await settle();
  request({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: '1 + 1' } } });
  await settle();
  assert.ok(forwarded.some(message => message.id === 1));
  serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '2' }] } }) + '\n');
  await settle();
  const call = lines.filter(line => line.hand === 'status' && line.state === 'done');
  assert.equal(call.length, 1); assert.equal(call[0].ok, true, 'a tool reply must not clear whole-turn protection');
  assert.match(records.find(event => event.state === 'done').call, /^[a-f0-9]{32}$/);
  request({ id: 2, method: 'tools/call', params: { name: 'turn_ended', arguments: {} } });
  await settle();
  const done = lines.filter(line => line.hand === 'status' && line.state === 'done');
  assert.equal(done.length, 2); assert.equal(Object.hasOwn(done[1], 'ok'), false);
  assert.ok(done[1].seq > done[0].seq);
  assert.deepEqual(done.map(line => line.windowRect), [[200, 500, 900, 350], [200, 500, 900, 350]]);
  request({ id: 3, method: 'tools/call', params: { name: 'js', arguments: { code: '2 + 2' } } });
  await settle();
  serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [] } }) + '\n');
  await settle();
  const nonce = lines.find(line => line.hand === 'aim').nonce;
  for (const phase of ['request', 'commit', 'confirm']) child.stdout.emit('data', JSON.stringify({ hand: 'pause', nonce,
    token: 'b'.repeat(32), paused: true, phase }) + '\n');
  const before = lines.length;
  cursor.status('thinking'); cursor.status('done', { call: 'c'.repeat(32) });
  assert.equal(lines.length, before, 'ordinary statuses remain suppressed while paused');
  request({ id: 4, method: 'tools/call', params: { name: 'turn_ended', arguments: {} } });
  await settle();
  const pausedEnd = lines.slice(before);
  assert.equal(pausedEnd.length, 1, 'turn cleanup crosses the paused producer and client gates');
  assert.equal(pausedEnd[0].hand, 'status'); assert.equal(pausedEnd[0].state, 'done'); assert.equal(pausedEnd[0].ok, undefined);
  const count = lines.length;
  client.send({ hand: 'aim', kind: 'click', pid: 42, windowId: 7, at: [650, 700] });
  assert.equal(lines.length, count + 1, 'paused targets still reach host protection');
  assert.equal(lines.at(-1).hand, 'aim');
  const off = createCursorEvents({ setting: () => ({ enabled: false, stream: false }), sink: { write() {}, close() {} } });
  try { off.status('done', { get call() { assert.fail('disabled cursor must not inspect status metadata'); } }); }
  finally { off.close(); }
});

function lifecycle(t, extra = {}) {
  const lines = [], records = [], forwarded = [], replies = [];
  const setting = () => ({ enabled: true, style: 'ring', stream: false });
  const child = new EventEmitter(); child.pid = 4242;
  child.stdin = Object.assign(new EventEmitter(), { writableLength: 0,
    write(text) { lines.push(...text.trim().split('\n').map(JSON.parse)); return true; }, end() {} });
  child.stdout = new EventEmitter(); child.kill = () => {};
  child.stdio = [child.stdin, child.stdout, null, new PassThrough(), new PassThrough()];
  const client = createHandClient({ setting, watch: () => undefined, permissions: null, usage: null, built: () => true,
    prepare: async () => ({ status: 'ready', spawn: () => child }) });
  const cursor = createCursorEvents({ setting, onEvent: row => records.push(row), sink: { write() {}, close() {} } });
  cursor.connectHost(client);
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const answer = (stream, msg) => stream.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [] } }) + '\n');
  const autoReply = stream => stream.on('data', bytes => {
    for (const msg of bytes.toString().trim().split('\n').map(JSON.parse)) {
      forwarded.push(msg);
      if (msg.id !== undefined && !extra.holdCalls?.includes(msg.id)) setImmediate(() => answer(stream === serverIn ? serverOut : replacementOut, msg));
    }
  });
  const replacementIn = new PassThrough(), replacementOut = new PassThrough();
  autoReply(serverIn); autoReply(replacementIn);
  let changed = false, restarts = 0;
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, cursor, changeReview: false, stopGraceMs: 20, modHost: () => false,
    ...extra, ...(extra.reconnect || extra.resume ? { engineChanged: () => changed, prepareEngine: async () => ({}),
      stopEngine: async () => ({ collected: true }), restartEngine: async () => {
        restarts++; changed = false; return { serverIn: replacementIn, serverOut: replacementOut };
      } } : {}) });
  t.after(() => { relay.dispose(); client.close(); cursor.close(); setHandPid(0); });
  const request = message => clientIn.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const target = async () => {
    client.send({ hand: 'aim', kind: 'click', pid: 42, windowId: 7, at: [650, 700], rect: [600, 650, 100, 100] });
    await settle();
  };
  return { relay, lines, records, forwarded, replies, request, target, reply: id => answer(serverOut, { id }), update() { changed = true; }, get restarts() { return restarts; },
    ends: () => lines.filter(row => row.hand === 'status' && row.state === 'done' && row.ok !== true) };
}

for (const used of [false, true]) test(`CR2B Interrupt releases once with turnUsed=${used}`, async t => {
  const h = lifecycle(t, { stopEngine: async () => ({ collected: true }), inspectInput: async () => ({ ok: true }) });
  if (used) { h.request({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: '1 + 1' } } }); await settle(); }
  await h.target();
  const before = h.relay.turnId;
  h.request({ id: 2, method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_stop: true, hook_event_name: 'Interrupt' } } });
  await settle();
  assert.equal(h.ends().length, 1);
  assert.notEqual(h.relay.turnId, before);
});

test('CR2B unused turn end releases targets without requiring a js call', async t => {
  const h = lifecycle(t); await h.target();
  h.request({ id: 1, method: 'tools/call', params: { name: 'turn_ended', arguments: { hook_event_name: 'Interrupt' } } });
  await settle(); assert.equal(h.ends().length, 1);
});

test('CR2B relay disposal releases targets before closing its cursor', async t => {
  const h = lifecycle(t); await h.target();
  await h.relay.dispose(); await settle();
  assert.equal(h.ends().length, 1);
  await h.relay.dispose(); assert.equal(h.ends().length, 1, 'idempotent dispose');
});

test('CR2C ChatGPT engine reconnect rotates resources while retaining stage targets', async t => {
  const receipts = [], releases = [];
  const h = lifecycle(t, { reconnect: true, receipts: true, receiptWriter: row => { receipts.push(row); return 'fixture.json'; },
    nativeSession: { endTurn: flags => releases.push(flags) }, inputLease: { close: () => releases.push('lease'), renew() {} } });
  h.request({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: '1 + 1' } } }); await settle();
  await h.target(); const before = h.relay.turnId;
  h.update();
  h.request({ id: 2, method: 'tools/call', params: { name: 'js', arguments: { code: '2 + 2' } } });
  for (let n = 0; n < 100 && !h.restarts; n++) await settle();
  await settle();
  assert.equal(h.restarts, 1);
  assert.notEqual(h.relay.turnId, before);
  assert.equal(releases.filter(value => value === 'lease').length, 1);
  assert.equal(releases.filter(value => value?.clipboardTurnEnded === false).length, 1);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].calls.length, 1);
  assert.equal(h.ends().length, 0, 'reconnect is not a user turn end');
  assert.equal(h.records.filter(row => row.state === 'idle').length, 0, 'idle must not rebind the retained point');
  h.request({ id: 3, method: 'tools/call', params: { name: 'turn_ended', arguments: {} } });
  await settle(); assert.equal(h.ends().length, 1);
  assert.equal(receipts.length, 2);
  assert.equal(receipts[1].calls.length, 1);
});

test('CR2C hook-only Esc releases a used turn with no running call', async t => {
  const h = lifecycle(t);
  h.request({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: '1 + 1' } } }); await settle();
  await h.target(); const before = h.relay.turnId;
  h.request({ id: 2, method: 'tools/call', params: { name: 'turn_ended', arguments: { hook_event_name: 'Interrupt' } } });
  await settle();
  assert.equal(h.ends().length, 1); assert.notEqual(h.relay.turnId, before);
});

const fakeLease = () => ({ close() {}, renew() {}, acquire: () => 'fixture', grant() {}, releaseChecked() {} });
async function legacyTurbo(t) {
  const child = new EventEmitter(), endpoint = new EventEmitter();
  child.connected = endpoint.connected = true;
  child.send = value => queueMicrotask(() => endpoint.emit('message', structuredClone(value)));
  endpoint.send = value => queueMicrotask(() => child.emit('message', structuredClone(value)));
  child.disconnect = () => { child.connected = endpoint.connected = false; endpoint.emit('disconnect'); child.emit('disconnect'); };
  child.unref = () => {};
  const worker = serveV3Worker({ channel: endpoint, browser: 'bfixture', async begin() {
    return { call: async () => ({ text: 'fixture', isError: false }), delivered: () => true,
      end: async () => ({ revoked: true, cleanup: [] }) };
  } });
  const bridge = await createV3Bridge({}, { readConfig: () => ({}), acceptPackage: () => ({ current: () => true }),
    forkWorker() { queueMicrotask(() => worker.ready()); return child; } });
  t.after(() => bridge.detach());
  return { directHost: bridge, directBrowser: createV3Frontend(bridge) };
}
test('CR2C drain timeout retains targets until the next real end', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = lifecycle(t, { inputLease: fakeLease(), holdCalls: [1] });
  h.request({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: '1 + 1' } } }); await settle();
  await h.target(); const before = h.relay.turnId;
  const ending = h.relay.endOpenTurn();
  t.mock.timers.tick(20); assert.equal(await ending, false);
  assert.equal(h.ends().length, 0); assert.equal(h.relay.turnId, before);
  h.reply(1); await settle();
  await h.relay.endOpenTurn(); await settle();
  assert.equal(h.ends().length, 1); assert.notEqual(h.relay.turnId, before);
});

test('CR2C hook-only Esc retries after a drain timeout without waiting for idle', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = lifecycle(t, { inputLease: fakeLease(), holdCalls: [1] });
  h.request({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: '1 + 1' } } }); await settle();
  await h.target();
  h.request({ id: 2, method: 'tools/call', params: { name: 'turn_ended', arguments: { hook_event_name: 'Interrupt' } } });
  await settle(); assert.ok(h.replies.some(row => row.id === 2), 'Esc hook is answered before drain');
  t.mock.timers.tick(20); await settle(); assert.equal(h.ends().length, 0);
  h.reply(1); await settle();
  assert.equal(h.ends().length, 1);
  assert.equal(h.forwarded.filter(row => row.params?.name === 'turn_ended').length, 1);
});

test('CR2C a checked Stop supersedes a deferred Esc without a second release', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = lifecycle(t, { inputLease: fakeLease(), holdCalls: [1],
    stopEngine: async () => ({ collected: true }), inspectInput: async () => ({ ok: true }) });
  h.request({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: '1 + 1' } } }); await settle();
  await h.target();
  h.request({ id: 2, method: 'tools/call', params: { name: 'turn_ended', arguments: { hook_event_name: 'Interrupt' } } });
  t.mock.timers.tick(20); await settle();
  h.request({ id: 3, method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_stop: true } } });
  t.mock.timers.tick(20);
  await settle(); assert.equal(h.ends().length, 1);
  await h.target(); const current = h.relay.turnId;
  h.reply(1); await settle();
  assert.equal(h.ends().length, 1, 'the old call draining is not a new user boundary');
  assert.equal(h.relay.turnId, current);
});

for (const boundary of ['end', 'attributed-end', 'Esc', 'dispose', 'prompt', 'begin', 'legacy-begin']) test(`CR2C idle retains targets and resources rotate before ${boundary} releases`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const receipts = [], releases = [];
  const h = lifecycle(t, { idleTurnEndMs: 30000, modHost: () => ['attributed-end', 'prompt', 'begin', 'legacy-begin'].includes(boundary),
    ...boundary === 'legacy-begin' ? await legacyTurbo(t) : {},
    receipts: true, receiptWriter: row => { receipts.push(row); return 'fixture.json'; },
    inputLease: { ...fakeLease(), close: () => releases.push('lease') }, nativeSession: { endTurn: flags => releases.push(flags) } });
  let envelope;
  if (['begin', 'legacy-begin'].includes(boundary)) {
    h.request(modCall({ id: 'bootstrap', method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_turbo: { event: 'bootstrap' } } } }));
    await settle(); envelope = JSON.parse(h.replies.find(row => row.id === 'bootstrap').result.content[0].text).sleightTurbo;
  }
  h.request({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: '1 + 1' } } }); await settle();
  await h.target(); const before = h.relay.turnId;
  t.mock.timers.tick(29999); await settle(); assert.equal(receipts.length, 0);
  t.mock.timers.tick(1); await settle();
  assert.notEqual(h.relay.turnId, before); assert.equal(receipts.length, 1);
  assert.equal(releases.filter(value => value === 'lease').length, 1);
  assert.equal(releases.filter(value => value?.clipboardTurnEnded === false).length, 1);
  assert.equal(h.forwarded.filter(row => row.params?.name === 'turn_ended').length, 1);
  assert.equal(h.ends().length, 0);
  assert.equal(h.records.filter(row => row.state === 'idle').length, 0);
  h.request({ id: 'forged-release', method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_person_prompt: 'composer' } } });
  await settle();
  assert.equal(h.replies.find(row => row.id === 'forged-release')?.result.isError, true);
  assert.equal(h.ends().length, 0, 'forged frame cannot release retained targets');
  if (['prompt', 'begin'].includes(boundary)) {
    const args = boundary === 'prompt' ? { sleight_person_prompt: 'composer' } :
      { sleight_turbo: { ...envelope, event: 'begin', turn: 'forged', text: 'continue', origin: 'composer', turbo: false } };
    h.request({ id: 'model', method: 'tools/call', params: { name: 'turn_ended', arguments: args } });
    await settle(); assert.equal(h.replies.find(row => row.id === 'model')?.result.isError, true);
    assert.equal(h.ends().length, 0, 'unattributed frames cannot release retained targets');
    if (boundary === 'begin') {
      h.request(modCall({ id: 'bad-envelope', method: 'tools/call', params: { name: 'turn_ended',
        arguments: { sleight_turbo: { ...args.sleight_turbo, nonce: 'wrong' } } } }));
      await settle(); assert.equal(h.replies.find(row => row.id === 'bad-envelope')?.result.isError, true);
      assert.equal(h.ends().length, 0, 'invalid bindings cannot release retained targets');
    }
  }
  if (boundary === 'dispose') h.relay.dispose();
  else {
    const args = boundary === 'legacy-begin' ? { sleight_turbo: { ...envelope, event: 'begin', turn: 'legacy-new-turn', text: 'continue' } } :
      boundary === 'prompt' ? { sleight_person_prompt: 'composer' } : boundary === 'begin' ?
      { sleight_turbo: { ...envelope, event: 'begin', turn: 'new-user-turn', text: 'continue', origin: 'composer', turbo: false } } :
      { hook_event_name: boundary === 'Esc' ? 'Interrupt' : 'Stop' };
    const message = { id: 2, method: 'tools/call', params: { name: 'turn_ended', arguments: args } };
    h.request(['end', 'Esc'].includes(boundary) ? message : modCall(message));
  }
  await settle(); assert.equal(h.ends().length, 1);
});

test('CR2C Glide interrupt then continue releases once and starts a clean turn', async t => {
  const receipts = [];
  const h = lifecycle(t, { nativeMac: true, resume: true, nativeSession: { interrupt() {}, cancelPending() {}, endTurn() {}, setPolicy() {} },
    inspectInput: async () => ({ ok: true }), receipts: true, receiptWriter: row => { receipts.push(row); return 'fixture.json'; } });
  h.request({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: '1 + 1' } } }); await settle();
  await h.target(); const before = h.relay.turnId;
  h.request({ id: 2, method: 'tools/call', params: { name: 'turn_ended', arguments: { hook_event_name: 'Interrupt' } } }); await settle();
  const continuing = h.relay.turnId;
  assert.notEqual(continuing, before); assert.equal(h.ends().length, 1); assert.equal(receipts.length, 1);
  h.request({ id: 3, method: 'tools/call', params: { name: 'js', arguments: { code: '2 + 2' } } });
  for (let n = 0; n < 100 && !h.replies.some(row => row.id === 3); n++) await settle();
  assert.equal(h.restarts, 1); assert.ok(!h.replies.find(row => row.id === 3)?.result.isError);
  assert.equal(h.ends().length, 1, 'restart must not release the continuing turn again');
  const fresh = h.relay.turnId;
  assert.notEqual(fresh, before);
  await h.target();
  await h.relay.endOpenTurn(); await settle();
  assert.equal(h.ends().length, 2); assert.equal(receipts.length, 2);
  assert.equal(receipts[1].calls.length, 1); assert.equal(receipts[1].calls[0].result, 'returned');
  assert.equal(receipts[0].turn, before); assert.equal(receipts[1].turn, fresh);
});

test('CR2B endOpenTurn releases an unused turn with targets', async t => {
  const h = lifecycle(t); await h.target();
  await h.relay.endOpenTurn(); await settle();
  assert.equal(h.ends().length, 1);
});


for (const boundary of ['Stop', 'Interrupt', 'end', 'idle', 'reconnect']) test(`INT23D unused ${boundary} preserves the REPL turn scope`, async t => {
  const releases = [], receipts = [];
  const h = lifecycle(t, { reconnect: boundary === 'reconnect', receipts: true,
    receiptWriter: row => receipts.push(row), inputLease: { ...fakeLease(), close: () => releases.push('lease') } });
  const before = h.relay.turnId;
  if (boundary === 'Stop' || boundary === 'Interrupt') {
    h.request({ id: 1, method: 'tools/call', params: { name: 'turn_ended', arguments: { hook_event_name: boundary } } });
  } else if (boundary === 'reconnect') {
    h.update(); h.request({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: '1 + 1' } } });
    for (let n = 0; n < 100 && !h.restarts; n++) await settle();
    assert.equal(h.restarts, 1);
  } else await h.relay.endOpenTurn(false, undefined, undefined, boundary === 'idle');
  await settle();
  assert.equal(h.relay.turnId, before, 'unused turn must keep its warm-up scope');
  assert.equal(receipts.length, 0, 'unused turn writes no receipt');
  assert.ok(releases.includes('lease'));
});

function mutationCounts(stdout) {
  return Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key =>
    [key, Number(new RegExp('#\\s+' + key + '\\s+(\\d+)').exec(stdout)?.[1])]));
}
test('unused turn id mutations fail in the same run', { skip: !!process.env.INT23D_TURN_VARIANT, timeout: 900000 }, () => {
  const file = fileURLToPath(import.meta.url);
  for (const [variant, pattern] of [
    ['rotate-unused-end', '^INT23D unused (end|idle) preserves the REPL turn scope$'],
    ['rotate-unused-hook', '^INT23D unused (Stop|Interrupt) preserves the REPL turn scope$'],
  ]) {
    const env = { ...process.env, INT23D_TURN_VARIANT: variant };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', '--test-timeout=900000',
      '--test-name-pattern=' + pattern, file], {
      encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024, timeout: 900000, killSignal: 'SIGKILL' });
    assert.equal(r.status, 1, variant + '\n' + r.stderr + r.stdout);
    assert.match(r.stdout, /unused turn must keep its warm-up scope/);
    const counts = mutationCounts(r.stdout);
    assert.equal(counts.tests, 2, variant); assert.equal(counts.fail, 2, variant); assert.equal(counts.pass, 0, variant);
  }
});
