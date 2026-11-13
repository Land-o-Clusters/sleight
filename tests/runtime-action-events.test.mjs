import { fakeReplNode } from './fixtures/repl-node-fake.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { createRuntimeActionEvents, runtimeActionGeometry, RUNTIME_ACTION_PROTOCOL } from '../plugins/sleight/lib/mac-driver/action-events.mjs';
import { createRuntimeHand } from '../plugins/sleight/lib/hand/runtime-hand.mjs';
import { createCursorEvents } from '../plugins/sleight/lib/hand/events.mjs';
import { createMacDriverClient } from '../plugins/sleight/lib/mac-driver/client.mjs';
import { DRIVER_ACTION_METHODS, DRIVER_CORE_METHODS, DRIVER_CODES } from '../plugins/sleight/lib/mac-driver/protocol.mjs';
import { createOwnRuntime } from '../plugins/sleight/lib/runtime-select.mjs';

const flush = async () => { for (let n = 0; n < 16; n++) await new Promise(resolve => setImmediate(resolve)); };
const nonce = 'a'.repeat(64);
const geometry = { point: [-180, 130], rect: [-200, 120, 40, 20], window: { id: 7, pid: 321, rect: [-220, 100, 400, 300] } };
const receipt = { delivery: 'sent-unverified', settled: true, basis: 'digest' };
function harness(t, { feedOptions, consumer, labels = 'title' } = {}) {
  const out = [], frames = [], receipts = [], records = [];
  const feed = createRuntimeActionEvents(feedOptions);
  const events = createCursorEvents({ env: {}, platform: 'darwin', setting: () => ({ stream: true, labels }),
    sink: { write: record => out.push(record), close() {} }, repeat: () => ({ unref() {} }), cancelRepeat() {}, now: () => 123 });
  feed.connect(record => records.push(record));
  feed.connect(consumer ?? createRuntimeHand({ events, client: { send: frame => frames.push(frame), hide() { frames.push('hide'); } }, onReceipt: row => receipts.push(row) }));
  t.after(() => { feed.close(); events.close(); });
  const stream = new PassThrough(), wire = feed.wire({ nonce, stream });
  const send = (id, phase, extra = {}) => stream.write(JSON.stringify({ protocol: RUNTIME_ACTION_PROTOCOL, nonce, id, phase, kind: 'click', ...geometry, ...extra }) + '\n');
  return { feed, events, out, records, frames, receipts, wire, stream, send };
}
test('UC2B waiting/person reaches the cursor feed without consuming the action receipt', async t => {
  const h = harness(t);
  h.wire.begin(2, 'click', {});
  h.send(2, 'waiting', { detail: 'person', text: 'SECRET' });
  h.send(2, 'act'); h.send(2, 'done', { outcome: receipt });
  await flush();
  assert.deepEqual(h.out.filter(row => row.type === 'status').map(row => [row.state, row.detail]), [['waiting', 'person'], ['done', undefined]]);
  assert.deepEqual(h.out.filter(row => row.type === 'action').map(row => row.phase), ['aim', 'act', 'done']);
  assert.equal(h.receipts.length, 1);
  assert.doesNotMatch(JSON.stringify(h.out), /SECRET/);
  h.send(2, 'waiting', { detail: 'person' });
  await flush();
  assert.equal(h.out.filter(row => row.type === 'status' && row.state === 'waiting').length, 1);
});

for (const [method, kind] of [['click', 'click'], ['typeText', 'key'], ['pressKey', 'key'], ['drag', 'drag']]) {
  test(`${method} projects an ordered per-action aim, act and outcome using cursor/1`, async t => {
    const h = harness(t), path = [[-180, 130], [-160, 140], [-120, 180]];
    await h.feed.run(method, { args: ['SECURE-VALUE'] }, { cell: 'PRIVATE-REQUEST-ID' }, async () => {
      h.wire.begin(2, method, {});
      h.send(2, 'act', { kind, ...method === 'drag' ? { path } : {} });
      h.send(2, 'done', { kind, outcome: receipt, ...method === 'drag' ? { path } : {} });
      return { ...receipt, text: 'PRIVATE-DOCUMENT' };
    });
    await flush();
    const actions = h.out.filter(row => row.type === 'action');
    assert.deepEqual(actions.map(row => row.phase), ['aim', 'act', 'done']);
    assert.deepEqual(actions.map(row => row.kind), [kind, kind, kind]);
    assert.ok(actions.every(row => row.v === 'sleight.cursor/1' && row.timing === 'confirmed' && row.source === 'native'));
    assert.ok(actions.every(row => row.call === actions[0].call && row.index === 0));
    assert.match(actions[0].call, /^[a-f0-9]{32}$/);
    assert.deepEqual(actions[0].rect, geometry.rect); assert.deepEqual(actions[0].point, geometry.point);
    assert.deepEqual(h.receipts, [{ call: actions[0].call, index: 0, ...receipt }]);
    assert.ok(actions.every(row => !('outcome' in row) && !('basis' in row)));
    if (method === 'drag') { assert.deepEqual(actions[1].path, path); assert.deepEqual(h.frames[0].path, path); }
    assert.doesNotMatch(JSON.stringify(h.out), /SECURE-VALUE|PRIVATE-/);
  });
}

test('same-cell indices increment and concurrent cells have independent opaque calls', async t => {
  const h = harness(t);
  for (const cell of ['one', 'one', 'two']) await h.feed.run('click', {}, { cell }, async () => ({ delivery: 'not-sent' }));
  await flush();
  const terminal = h.out.filter(row => row.type === 'action');
  assert.deepEqual(terminal.map(row => row.index), [0, 1, 0]);
  assert.equal(terminal[0].call, terminal[1].call); assert.notEqual(terminal[0].call, terminal[2].call);
  h.feed.reset(); await h.feed.run('click', {}, { cell: 'one' }, async () => ({})); await flush();
  assert.notEqual(h.out.filter(row => row.type === 'action').at(-1).call, terminal[0].call);
});

test('native pre-input refusal has one failed outcome and no act', async t => {
  const h = harness(t);
  h.wire.begin(2, 'click', {});
  h.send(2, 'failed', { outcome: { delivery: 'not-sent', settled: false, basis: 'none' } });
  await flush();
  assert.deepEqual(h.out.filter(row => row.type === 'action').map(row => row.phase), ['failed']);
  assert.equal(h.frames.filter(row => row !== 'hide').length, 0);
});

test('clipboard count changes survive the internal receipt without entering cursor records', async t => {
  const h = harness(t);
  h.wire.begin(2, 'click', {});
  h.send(2, 'done', { outcome: { ...receipt, clipboardChanged: true } });
  await flush();
  assert.equal(h.records.at(-1).outcome.clipboardChanged, true);
  assert.equal(h.receipts.at(-1).clipboardChanged, true);
  assert.ok(h.out.every(record => !('clipboardChanged' in record)));
});

test('reads and metadata without an approval callback emit no records', async t => {
  const h = harness(t);
  for (const method of DRIVER_CORE_METHODS) await h.feed.run(method, {}, {}, async () => {
    h.wire.begin(2, method, {}); h.send(2, 'act'); return {};
  });
  await flush(); assert.equal(h.out.length, 0); assert.equal(h.records.length, 0);
});

test('privacy projection strips secure values, document text, names, titles, labels and keys', async t => {
  const h = harness(t);
  h.wire.begin(2, 'typeText', { args: ['VALUE-SECRET'] });
  for (const phase of ['act', 'done']) h.send(2, phase, { kind: 'key',
    text: 'VALUE-SECRET', title: 'TITLE-SECRET', role: 'AXSecureTextField', label: 'LABEL-SECRET', count: 123,
    say: 'DOCUMENT-SECRET', key: 'KEY-SECRET', path: [['PATH-SECRET', 1]],
    window: { ...geometry.window, app: 'APP-SECRET', title: 'WINDOW-SECRET', bundle: 'BUNDLE-SECRET' },
    outcome: { ...receipt, basis: 'BASIS-SECRET', title: 'OUTCOME-SECRET' } });
  await flush();
  assert.doesNotMatch(JSON.stringify([h.records, h.out, h.frames, h.receipts]), /SECRET/);
  for (const row of h.out.filter(row => row.type === 'action')) {
    assert.equal(row.kind, 'key'); for (const key of ['label', 'role', 'say', 'count', 'path']) assert.equal(row[key], undefined);
  }
  assert.equal(h.receipts[0].basis, 'none');
});

test('slow, throwing and backpressured consumers are dropped without delaying actions', async t => {
  const h = harness(t), slow = [];
  h.feed.connect(record => { slow.push(record); return new Promise(() => {}); });
  h.feed.connect(() => { throw Error('consumer'); }); h.feed.connect(() => false);
  await h.feed.run('click', {}, {}, async () => ({})); await flush();
  let ran = 0;
  for (let n = 0; n < 10; n++) await h.feed.run('click', {}, {}, async () => { ran++; return {}; });
  await flush();
  assert.equal(ran, 10); assert.equal(slow.length, 1); assert.equal(h.feed.droppedConsumers, 3);
  assert.equal(h.records.length, 11);
});

test('a stalled event loop bounds the queue and disabled feeds do no projection', async t => {
  const deferred = [], h = harness(t, { feedOptions: { defer: fn => deferred.push(fn), limit: 2 } });
  for (let n = 0; n < 4; n++) await h.feed.run('click', {}, {}, async () => ({}));
  assert.equal(h.feed.enabled, false); assert.equal(h.feed.droppedConsumers, 2);
  await h.feed.run('click', { get args() { throw Error('disabled projection'); } }, {}, () => 42);
  for (const fn of deferred) fn(); assert.equal(h.records.length, 0);
});

test('bad, missing and oversized side-channel frames never affect the action result', async t => {
  for (const bad of ['{\n', 'x'.repeat(8193), 'x'.repeat(65537)]) {
    const h = harness(t); h.wire.begin(2, 'click', {}); h.stream.write(bad);
    assert.equal(await h.feed.run('click', {}, {}, async () => 42), 42);
    await flush(); assert.equal(h.out.filter(row => row.phase === 'act').length, 0);
  }
});

test('the nonce, request id and terminal boundary reject stray or late events', async t => {
  const h = harness(t); h.wire.begin(2, 'click', {});
  h.send(2, 'act', { nonce: 'b'.repeat(64) }); h.send(3, 'act');
  h.send(2, 'done', { outcome: receipt }); h.send(2, 'act'); h.send(2, 'done', { outcome: receipt });
  await flush(); assert.deepEqual(h.records.map(row => row.phase), ['done']);
});

test('geometry accepts only bounded finite numeric tuples and thinned paths', () => {
  assert.deepEqual(runtimeActionGeometry({ point: [1, 'secret'], rect: [1, 2, Infinity, 3], path: Array.from({ length: 65 }, () => [1, 2]),
    window: { id: '7', pid: 321, title: 'secret' } }), {});
});

test('ordinary engine-native records keep scheduled timing without an explicit runtime stamp', async t => {
  const h = harness(t);
  const action = { call: 'b'.repeat(32), index: 0, phase: 'act', kind: 'click', source: 'native', ...geometry };
  h.events.action(action); h.events.action({ ...action, timing: 'confirmed' });
  await flush();
  assert.deepEqual(h.out.filter(row => row.type === 'action').map(row => row.timing), ['scheduled', 'confirmed']);
});

function fakeDriver(t, feed, { drop, replyFirst = false } = {}) {
  let requests = 0;
  const spawns = [];
  const client = createMacDriverClient({ platform: 'darwin', timeoutMs: 1000, actionEvents: feed, prepare: async () => ({ status: 'ready', spawn({ nonce, actionEvents }) {
    spawns.push(actionEvents === true);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdio = [null, child.stdout, child.stderr, ...actionEvents ? [new PassThrough()] : []];
    let channelClosed = false;
    const send = row => child.stdout.write(JSON.stringify(row) + '\n');
    child.stdin = new Writable({ write(bytes, encoding, done) {
      const request = JSON.parse(bytes.toString()); done(); requests++;
      queueMicrotask(() => {
        const base = { protocol: 'sleight.driver/1', platform: 'darwin', nonce, id: request.id };
        if (request.method === 'ping') return send({ ...base, ok: true, result: { protocol: 'sleight.driver/1', apiVersion: 2,
          build: 'b'.repeat(64), methods: [...DRIVER_CORE_METHODS, ...DRIVER_ACTION_METHODS] } });
        const refused = request.params.readId === 999;
        const reply = () => send(refused ? { ...base, ok: false, error: { code: 'ELEMENT_DISABLED', next: DRIVER_CODES.ELEMENT_DISABLED.next, message: 'SECRET',
          unhealthy: false, delivery: 'not-sent', retry: 'safe' } } : { ...base, ok: true, result: { delivery: 'sent-unverified' } });
        if (actionEvents) {
          const event = { protocol: RUNTIME_ACTION_PROTOCOL, nonce, id: request.id, kind: 'click', ...geometry };
          if (drop === 'no-events' || channelClosed) { reply(); return; }
          if (!refused) child.stdio[3].write(JSON.stringify({ ...event, phase: 'act' }) + '\n');
          if (drop === 'timeout') return;
          if (drop === 'crash') { child.stdout.end(); return; }
          if (drop === 'full-pipe') { channelClosed = true; child.stdio[3].end(); }
          else {
            const terminal = () => child.stdio[3].write(JSON.stringify({ ...event, phase: refused ? 'failed' : 'done', outcome: { ...receipt, delivery: refused ? 'not-sent' : receipt.delivery } }) + '\n');
            if (replyFirst) { reply(); setImmediate(terminal); return; }
            terminal();
          }
        }
        reply();
      });
    } });
    child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; }; return child;
  } }) });
  t.after(() => client.close());
  return { client, spawns, get requests() { return requests; } };
}

test('a reply before the in-flight helper terminal preserves the helper receipt', async t => {
  const h = harness(t), f = fakeDriver(t, h.feed, { replyFirst: true });
  const result = await h.feed.run('click', { args: [1] }, {}, () =>
    f.client.click({ windowId: '7', processStart: 'start', readId: 1 }, [1]));
  assert.equal(result.delivery, 'sent-unverified');
  await flush();
  assert.deepEqual(h.records.map(row => row.phase), ['act', 'done']);
  assert.deepEqual(h.records[1].outcome, receipt);
  assert.equal(h.out.filter(row => row.type === 'status').at(-1).state, 'done');
});

for (const [drop, code] of [['timeout', 'DEADLINE_EXCEEDED'], ['crash', 'DRIVER_EXIT'], ['full-pipe', undefined]]) {
  test(`a helper ${drop} after act ends according to its reply and hides the hand`, async t => {
    const h = harness(t), f = fakeDriver(t, h.feed, { drop });
    const call = h.feed.run('click', { args: [1] }, { cell: 'PRIVATE-CELL' }, () =>
      f.client.click({ windowId: '7', processStart: 'start', readId: 1 }, [1]));
    if (code) await assert.rejects(call, { code });
    else assert.equal((await call).delivery, 'sent-unverified');
    await flush();
    assert.deepEqual(h.records.map(row => row.phase), ['act', code ? 'failed' : 'done']);
    assert.equal(h.frames.at(-1), 'hide');
    assert.deepEqual(h.records[1].outcome, {
      delivery: drop === 'full-pipe' ? 'sent-unverified' : 'unknown', settled: false, basis: 'none',
      eventRecord: 'missing',
    });
    assert.equal(h.out.filter(row => row.type === 'status').at(-1).state, code ? 'error' : 'done');
    assert.ok(h.out.every(row => !('eventRecord' in row) && !('outcome' in row)));
    assert.doesNotMatch(JSON.stringify([h.records, h.out, h.frames, h.receipts]), /PRIVATE-|SECRET|timed out|Driver/);
  });
}

test('successful replies without any helper events stay done across 40 direct requests', async t => {
  const h = harness(t), f = fakeDriver(t, h.feed, { drop: 'no-events' });
  for (let n = 0; n < 40; n++) {
    assert.equal((await f.client.request('click', { windowId: '7', processStart: 'start', readId: 1, args: [1] })).delivery,
      'sent-unverified');
    await flush();
  }
  assert.deepEqual(h.records.map(row => row.phase), Array(40).fill('done'));
  assert.ok(h.records.every(row => row.outcome.eventRecord === 'missing'));
  assert.equal(h.out.filter(row => row.type === 'status' && row.state === 'done').length, 40);
  assert.equal(h.frames.filter(row => row === 'hide').length, 40);
  assert.equal(h.frames.filter(row => row !== 'hide').length, 0);
  assert.equal(f.requests, 41);
});

test('later replies on a closed helper event channel still hide with a missing-record done', async t => {
  const h = harness(t), f = fakeDriver(t, h.feed, { drop: 'full-pipe' });
  for (let n = 0; n < 3; n++) {
    await f.client.request('click', { windowId: '7', processStart: 'start', readId: 1, args: [1] });
    await flush();
  }
  assert.deepEqual(h.records.map(row => row.phase), ['act', 'done', 'done', 'done']);
  assert.ok(h.records.filter(row => row.phase === 'done').every(row => row.outcome.eventRecord === 'missing'));
  assert.equal(h.frames.filter(row => row === 'hide').length, 3);
});

test('parent terminal dedupes late helper records and releases pending slots after lost records', async t => {
  const h = harness(t);
  for (let id = 1; id <= 40; id++) {
    await h.feed.run('click', {}, {}, async () => {
      h.wire.begin(id, 'click', {}); h.send(id, 'act');
      return { delivery: 'sent-unverified' };
    });
    await flush();
    h.send(id, 'act');
    h.send(id, 'done', { outcome: receipt });
    await flush();
  }
  assert.deepEqual(h.records.map(row => row.phase), Array.from({ length: 40 }, () => ['act', 'done']).flat());
  assert.ok(h.records.filter(row => row.phase === 'done').every(row => row.outcome.eventRecord === 'missing'));
  assert.equal(h.frames.filter(row => row === 'hide').length, 40);
});

for (const drop of ['full-pipe', 'crash', 'timeout']) {
  test(`direct local-service driver requests get a fallback after ${drop}`, async t => {
    const h = harness(t), f = fakeDriver(t, h.feed, { drop });
    const result = f.client.request('click', { windowId: '7', processStart: 'start', readId: 1, args: [1] });
    if (drop === 'full-pipe') assert.equal((await result).delivery, 'sent-unverified');
    else await assert.rejects(result, { code: drop === 'crash' ? 'DRIVER_EXIT' : 'DEADLINE_EXCEEDED' });
    await flush();
    assert.deepEqual(h.records.map(row => row.phase), ['act', drop === 'full-pipe' ? 'done' : 'failed']);
    assert.equal(h.records[0].call, h.records[1].call);
    assert.equal(h.records[1].outcome.eventRecord, 'missing');
    assert.equal(h.frames.at(-1), 'hide');
  });
}

test('detaching mid-call ends every observed action and hides only that consumer', async t => {
  const h = harness(t), detached = [], frames = [];
  const hand = createRuntimeHand({ client: { send: row => frames.push(row), hide: () => frames.push('hide') } });
  const disconnect = h.feed.connect(row => { detached.push(row); hand(row); });
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  t.after(() => finish());
  const calls = [21, 22].map(id => h.feed.run('click', {}, { cell: 'shared' }, async () => {
    h.wire.begin(id, 'click', {}); h.send(id, 'act'); await pending;
    h.send(id, 'done', { outcome: receipt }); return receipt;
  }));
  await flush();
  assert.equal(frames.length, 2);
  disconnect(); disconnect();
  assert.deepEqual(detached.map(row => row.phase), ['act', 'act', 'skipped', 'skipped']);
  assert.deepEqual(detached.map(row => row.index), [0, 1, 0, 1]);
  assert.equal(frames.filter(row => row === 'hide').length, 2);
  finish(); await Promise.all(calls); await flush();
  assert.equal(detached.length, 4);
  assert.deepEqual(h.records.map(row => row.phase), ['act', 'act', 'done', 'done']);
});

test('backpressure detach clears an observed action without waiting for the slow consumer', async t => {
  const h = harness(t), detached = [];
  h.feed.connect(row => { detached.push(row); return new Promise(() => {}); });
  await h.feed.run('click', {}, {}, async () => {
    h.wire.begin(31, 'click', {}); h.send(31, 'act'); await flush();
    h.send(31, 'done', { outcome: receipt }); return receipt;
  });
  await flush();
  assert.deepEqual(detached.map(row => row.phase), ['act', 'skipped']);
  assert.equal(h.feed.droppedConsumers, 1);
  assert.deepEqual(h.records.map(row => row.phase), ['act', 'done']);
});

test('closing the feed ends an action already delivered to its hand', async t => {
  const h = harness(t);
  h.wire.begin(41, 'click', {}); h.send(41, 'act'); await flush();
  h.feed.close(); h.feed.close();
  assert.deepEqual(h.records.map(row => row.phase), ['act', 'skipped']);
  assert.equal(h.frames.at(-1), 'hide');
});

for (const failure of ['false', 'throw', 'reject']) {
  test(`a consumer whose terminal write returns ${failure} still gets a cleanup attempt`, async t => {
    const h = harness(t), detached = [];
    h.feed.connect(row => {
      if (row.phase === 'done') {
        if (failure === 'false') return false;
        if (failure === 'throw') throw Error('consumer');
        return Promise.reject(Error('consumer'));
      }
      detached.push(row);
    });
    await h.feed.run('click', {}, {}, async () => {
      h.wire.begin(61, 'click', {}); h.send(61, 'act'); await flush();
      h.send(61, 'done', { outcome: receipt }); return receipt;
    });
    await flush();
    assert.deepEqual(detached.map(row => row.phase), ['act', 'skipped']);
    assert.deepEqual(h.records.map(row => row.phase), ['act', 'done']);
    assert.equal(h.feed.droppedConsumers, 1);
  });
}

for (const reply of [undefined, null]) {
  test(`an absent ${reply} reply stays failed even when the event pipe was opened`, async t => {
    const h = harness(t);
    await h.feed.run('click', {}, {}, async () => { h.wire.begin(51, 'click', {}); h.send(51, 'act'); return reply; });
    await flush();
    assert.deepEqual(h.records.map(row => row.phase), ['act', 'failed']);
    assert.deepEqual(h.records[1].outcome, { delivery: 'unknown', settled: false, basis: 'none', eventRecord: 'missing' });
    assert.equal(h.frames.at(-1), 'hide');
  });
}

test('no consumer means no helper event pipe or emission work', async t => {
  const feed = createRuntimeActionEvents(); t.after(() => feed.close());
  const f = fakeDriver(t, feed);
  assert.equal(await feed.run('click', { get args() { assert.fail('disabled projection'); } }, {}, () => 42), 42);
  await f.client.click({ windowId: '7', processStart: 'start', readId: 1 }, [1]);
  assert.deepEqual(f.spawns, [false]);
  const records = [], disconnect = feed.connect(row => records.push(row));
  await f.client.restart();
  await f.client.click({ windowId: '7', processStart: 'start', readId: 1 }, [1]);
  await flush(); assert.deepEqual(records.map(row => row.phase), ['act', 'done']);
  disconnect(); await f.client.restart();
  await f.client.click({ windowId: '7', processStart: 'start', readId: 1 }, [1]);
  assert.deepEqual(f.spawns, [false, true, false]);
});

test('real driver client wires a fake helper event pipe and preserves native refusals', async t => {
  const h = harness(t), f = fakeDriver(t, h.feed);
  await f.client.click({ windowId: '7', processStart: 'start', readId: 1 }, [1]);
  await assert.rejects(f.client.click({ windowId: '7', processStart: 'start', readId: 999 }, [1]), { code: 'ELEMENT_DISABLED' });
  await flush();
  assert.deepEqual(h.records.map(row => row.phase), ['act', 'done', 'failed']);
  assert.equal(f.requests, 3); assert.doesNotMatch(JSON.stringify(h.records), /SECRET/);
});

function ownHarness(t, h, { approve = async () => true, approvalScope = 'session' } = {}) {
  const requests = [];
  let readId = 0;
  const window = { windowId: '7', pid: 321, processStart: 'start', bundleId: 'test.fixture', app: 'Fixture',
    title: 'PRIVATE-TITLE', bounds: { x: 0, y: 0, width: 400, height: 300 }, identityVerified: true };
  const driver = { async request(method, params) {
    requests.push(method);
    if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app, path: '/Applications/Fixture.app',
      pid: window.pid, processStart: window.processStart }, windows: [window] };
    if (method === 'verifyWindowIdentity') return { window };
    if (method === 'rendererRestore') return { restored: true, token: params.args[0].lease.token };
    if (method === 'getAXState') return { window, readId: ++readId, truncated: false,
      text: 'Window: "PRIVATE-TITLE", App: Fixture.\n0 standard window PRIVATE-TITLE\n\t1 button PRIVATE-LABEL' };
    assert.fail(`unexpected native request ${method}`);
  }, async close() {}, async restart() {} };
  function worker() {
    const child = new EventEmitter(); child.connected = true; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let cell;
    child.send = (message, callback) => {
      callback?.();
      if (message.type === 'evaluate') {
        cell = message.id;
        queueMicrotask(() => child.emit('message', { type: 'driver', id: cell, cell, ...JSON.parse(message.code.slice(1, -1)) }));
      } else if (message.type === 'driver-result') queueMicrotask(() => child.emit('message', {
        type: 'result', id: cell, result: { isError: !!message.error, content: [] },
      }));
    };
    child.kill = () => { child.connected = false; queueMicrotask(() => child.emit('close', 0)); return true; };
    return child;
  }
  const runtime = createOwnRuntime({ driver, actionEvents: h.feed,
    lease: { acquire: () => 'fixture-lease', grant: () => ({ token: 'fixture-token' }), renewGrant() {},
      renew() {}, release() {}, close() {} }, approve, approvalScope,
    policy: () => ({ allow: true, riskLevel: 'low' }),
    permissions: { app() {}, page() {}, sitesLimited: () => false },
    targetParents: () => [1], ancestry: () => [{ pid: 500, path: '/Applications/FixtureHost.app/Contents/MacOS/Host' }],
    replOptions: { selectNode: fakeReplNode, spawn: worker, environment: () => ({}) },
  });
  t.after(() => runtime.close());
  let id = 0;
  const replies = new Map();
  runtime.serverOut.on('data', bytes => {
    for (const line of bytes.toString().trim().split('\n')) { const message = JSON.parse(line); replies.get(message.id)?.(message.result); }
  });
  const call = (method, params) => new Promise(resolve => {
    const current = ++id; replies.set(current, resolve);
    runtime.serverIn.write(JSON.stringify({ id: current, method: 'tools/call', params: { name: 'js',
      // An object expression is valid JavaScript under the real API preflight.
      arguments: { code: '(' + JSON.stringify({ method, params }) + ')' } } }) + '\n');
  });
  return { call, requests };
}

test('own runtime parent emits preview refusals while reads stay silent and input stays disabled', async t => {
  const h = harness(t), { call, requests } = ownHarness(t, h);
  assert.equal((await call('getApp', { selector: 'Fixture' })).isError, false);
  await flush();
  assert.deepEqual(h.records.map(row => row.state), ['waiting', 'thinking']);
  h.records.length = 0;
  for (const [method, args] of [['click', [[20, 30]]], ['typeText', ['PRIVATE-VALUE']], ['pressKey', ['Return']], ['drag', [[20, 30], [40, 50]]]]) {
    assert.equal((await call(method, { windowId: '7', processStart: 'start', readId: 1, args })).isError, true);
  }
  await flush();
  assert.deepEqual(h.records.map(row => row.phase), ['failed', 'failed', 'failed', 'failed']);
  assert.ok(h.records.every(row => row.outcome.delivery === 'not-sent'));
  assert.ok(requests.every(method => !DRIVER_ACTION_METHODS.includes(method)));
  assert.doesNotMatch(JSON.stringify(h.records), /PRIVATE-/);
});

for (const approvalScope of ['session', 'once']) {
  test(`real getApp approval callback emits waiting and declined for ${approvalScope} scope`, async t => {
    const h = harness(t);
    let decide, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const { call, requests } = ownHarness(t, h, { approvalScope, approve: () => {
      entered(); return new Promise(resolve => { decide = resolve; });
    } });
    const result = call('getApp', { selector: 'Fixture' });
    await Promise.race([waiting, result.then(() => assert.fail('approval callback was never reached'))]); await flush();
    assert.deepEqual(h.records.map(row => [row.type, row.state, row.detail]), [['status', 'waiting', 'approval']]);
    decide(false);
    assert.equal((await result).isError, true); await flush();
    assert.deepEqual(h.records.map(row => row.state ?? row.phase), ['waiting', 'thinking', 'declined']);
    assert.equal(h.records[2].call, h.records[0].call);
    assert.deepEqual(h.records[2].outcome, { delivery: 'not-sent', settled: false, basis: 'none' });
    assert.deepEqual(requests, ['resolveApp']);
    assert.equal(h.frames.at(-1), 'hide');
    assert.doesNotMatch(JSON.stringify([h.records, h.out, h.frames, h.receipts]), /PRIVATE-|Fixture|SECRET/);
    if (approvalScope === 'session') {
      assert.equal((await call('getApp', { selector: 'Fixture' })).isError, true); await flush();
      assert.equal(h.records.filter(row => row.state === 'waiting').length, 1, 'remembered decline does not reopen approval');
    }
  });
}

test('real session approval accepts once and later reads emit no records', async t => {
  const h = harness(t); let approvals = 0;
  const { call } = ownHarness(t, h, { approve: async () => { approvals++; return true; } });
  assert.equal((await call('getApp', { selector: 'Fixture' })).isError, false); await flush();
  assert.deepEqual(h.records.map(row => row.state), ['waiting', 'thinking']);
  h.records.length = 0;
  assert.equal((await call('getApp', { selector: 'Fixture' })).isError, false);
  assert.equal((await call('getAXState', { windowId: '7', processStart: 'start' })).isError, false);
  await flush(); assert.equal(approvals, 1); assert.deepEqual(h.records, []);
});

test('fake per-action feed cost, five interleaved rounds with 1000 actions per arm', async t => {
  const feed = createRuntimeActionEvents(); let received = 0, publicEvents = 0, frames = 0;
  feed.connect(() => { received++; });
  const cursor = createCursorEvents({ env: {}, platform: 'darwin', setting: () => ({ stream: true, labels: 'title' }),
    sink: { write() { publicEvents++; }, close() {} }, repeat: () => ({ unref() {} }), cancelRepeat() {} });
  feed.connect(createRuntimeHand({ events: cursor, client: { send() { frames++; } } }));
  t.after(() => { feed.close(); cursor.close(); });
  const on = fakeDriver(t, feed), off = fakeDriver(t), samples = [];
  let cell = 0;
  const identity = { windowId: '7', processStart: 'start', readId: 1 };
  async function run(f, count) {
    const context = { cell: ++cell };
    const began = performance.now();
    for (let n = 0; n < count; n++) {
      const dispatch = () => f.client.click(identity, [1]);
      if (f === on) await feed.run('click', { args: [1] }, context, dispatch);
      else await dispatch();
      await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    }
    await flush(); return (performance.now() - began) * 1000 / count;
  }
  await run(on, 50); await run(off, 50); received = 0; publicEvents = 0; frames = 0;
  for (let round = 0; round < 5; round++) {
    let baseline, enabled;
    if (round % 2) { enabled = await run(on, 1000); baseline = await run(off, 1000); }
    else { baseline = await run(off, 1000); enabled = await run(on, 1000); }
    samples.push({ baselineUs: baseline, enabledUs: enabled, addedUs: enabled - baseline });
  }
  assert.equal(feed.droppedConsumers, 0); assert.equal(received, 10000);
  assert.equal(publicEvents, 20000); assert.equal(frames, 5000);
  t.diagnostic(JSON.stringify({ actionsPerArm: 5000, events: received, publicEvents, frames, droppedConsumers: feed.droppedConsumers, samples }));
});
