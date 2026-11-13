import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { DRIVER_CODES, DRIVER_CORE_METHODS, DRIVER_ACTION_METHODS } from '../plugins/sleight/lib/mac-driver/protocol.mjs';
import { performance } from 'node:perf_hooks';
import { createMacDriverClient, DRIVER_PROTOCOL, DRIVER_LINE_LIMIT } from '../plugins/sleight/lib/mac-driver/client.mjs';
import { clipboardClientReply } from './fixtures/mac-driver-clipboard-client.mjs';

const reply = (request, result = {}, extra = {}) => ({ protocol: DRIVER_PROTOCOL, platform: 'darwin', nonce: request.nonce,
  id: request.id, ok: true,
  result: { ...(['ping', 'health'].includes(request.method) ? { protocol: DRIVER_PROTOCOL, apiVersion: 2, build: 'b'.repeat(64), methods: [...DRIVER_CORE_METHODS, ...DRIVER_ACTION_METHODS, 'echo', 'refuse', 'settle', 'personState'] } : {}), ...result },
  ...extra,
  ...extra.error ? { error: { ...extra.error, next: DRIVER_CODES[extra.error.code]?.next }, ...request.context ? { context: request.context } : {} } : {},
});

  function fixture(t, behavior = (request, child) => child.send(reply(request)), options = {}) {
    const children = [], requests = [], handshakes = [];
    let prepares = 0;
    const prepare = async () => {
      prepares++;
      return { status: 'ready', build: 'b'.repeat(64), spawn: ({ nonce }) => {
        const child = new EventEmitter(); child.nonce = nonce; child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.signals = []; child.send = data => child.stdout.write(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data) + '\n');
        child.stdin = new Writable({ write(bytes, encoding, done) {
          const request = JSON.parse(bytes.toString()); done();
          if (!child.handshaken) {
            child.handshaken = true; handshakes.push(request);
            queueMicrotask(() => child.send(reply(request))); return;
          }
          requests.push(request);
          queueMicrotask(() => behavior(request, child));
        } });
        child.kill = (signal = 'SIGTERM') => {
          child.signals.push(signal);
          if (!child.closed) { child.closed = true; queueMicrotask(() => child.emit('close', null, signal)); }
          return true;
        };
        children.push(child); return child;
      } };
    };
    const client = createMacDriverClient({ platform: 'darwin', prepare, ...options });
    t.after(() => client.close());
    return { client, prepare, children, requests, handshakes, get prepares() { return prepares; } };
  }


if (process.argv.includes('--fake-helper')) {
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify(reply(request, request.params)) + '\n');
  }
} else {
  test('native phase timings survive input refusals and clipboard conversion', async t => {
    const timing = { sendMs: 7, settleMs: 31, postReadMs: 11 };
    for (const changed of [false, true]) {
      const f = fixture(t, (request, child) => child.send(changed
        ? reply(request, { delivery: 'sent-unverified', retry: 'read-first', clipboardChanged: true, timing })
        : reply(request, undefined, { ok: false, result: undefined, error: { code: 'STALE_ELEMENT',
          message: 'STALE_ELEMENT', unhealthy: false, delivery: 'not-sent', retry: 'safe', timing } })));
      await assert.rejects(f.client.request('click', { windowId: '7', processStart: '1.2', readId: 1, args: [1] }), error => {
        assert.equal(error.code, changed ? 'CLIPBOARD_CHANGED' : 'STALE_ELEMENT');
        assert.deepEqual(error.timing, timing);
        assert.equal(error.delivery, changed ? 'sent-unverified' : 'not-sent');
        return true;
      });
    }
  });
  test('focus belief diagnostics survive split stderr and strip every unapproved field', async t => {
    const diagnostics = [];
    const { client, children } = fixture(t, undefined, { diagnostics: line => diagnostics.push(line) });
    await client.request('health');
    const record = { event: 'keyboard-belief', fakeActiveMs: 401, beliefCleared: false,
      elapsedMs: 450, guardMs: 300, snapshotMs: 50, beliefMs: 20, restoreMs: 30,
      checkMs: 200, identityMs: 99, preflightMs: 1, guardCount: 9, cleanupMs: 20,
      estimatedKeyMs: 164, projectedMs: 289.7, cleanupReserveMs: 20, finalGuardMs: 40, strokePosts: 4, yielded: true,
      fault: 'KEY_FOCUS_UNAVAILABLE step=active-interval' };
    const secret = { ...record, title: 'PRIVATE WINDOW', text: 'PRIVATE TYPING', arbitrary: 'PRIVATE' };
    const line = JSON.stringify(secret) + '\n';
    children[0].stderr.write(line.slice(0, 19));
    assert.deepEqual(diagnostics, []);
    children[0].stderr.write(line.slice(19));
    assert.equal(diagnostics.length, 1);
    assert.deepEqual(JSON.parse(diagnostics[0].slice('sleight: focus belief: '.length)), record);
    assert.doesNotMatch(diagnostics.join(''), /PRIVATE/);
    children[0].stderr.write(JSON.stringify({ ...record, fault: 'KEY_FOCUS_UNAVAILABLE step=text-role' }) + '\n');
    assert.equal(diagnostics.length, 2);
    assert.equal(JSON.parse(diagnostics[1].slice('sleight: focus belief: '.length)).fault,
      'KEY_FOCUS_UNAVAILABLE step=text-role');
    for (const bad of [
      { ...record, fault: 'KEY_FOCUS_UNAVAILABLE step=PRIVATE' },
      { ...record, fault: 'KEY_FOCUS_UNAVAILABLE step=belief\nPRIVATE' },
      { ...record, event: 'PRIVATE' }, { ...record, beliefCleared: 1 },
      { ...record, yielded: 1 }, { ...record, guardCount: 1.5 }, { ...record, strokePosts: 1.5 },
      ...['fakeActiveMs', 'elapsedMs', 'guardMs', 'snapshotMs', 'beliefMs', 'restoreMs',
        'checkMs', 'identityMs', 'preflightMs', 'guardCount', 'cleanupMs', 'estimatedKeyMs', 'projectedMs',
        'cleanupReserveMs', 'finalGuardMs', 'strokePosts'].flatMap(key =>
        [-1, 600001, null, 'PRIVATE'].map(value => ({ ...record, [key]: value }))),
    ]) children[0].stderr.write(JSON.stringify(bad) + '\n');
    children[0].stderr.write('PRIVATE\n' + 'x'.repeat(65537) + '\n');
    assert.equal(diagnostics.length, 2);
    for (let i = 0; i < 70; i++) children[0].stderr.write(JSON.stringify(record) + '\n');
    assert.equal(diagnostics.length, 64);
    assert.equal((await client.request('health')).protocol, DRIVER_PROTOCOL);
  });
  test('late clipboard changes alone admit not-sent/read-first; every other code keeps its validator rule', async () => {
    for (const [code, row] of Object.entries(DRIVER_CODES)) {
      const result = await clipboardClientReply({ ok: false, error: {
        code, message: code, next: row.next, unhealthy: row.unhealthy,
        delivery: 'not-sent', retry: 'read-first',
      } });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, code === 'CLIPBOARD_CHANGED' ? code : 'DRIVER_PROTOCOL', code);
      if (code === 'CLIPBOARD_CHANGED') assert.equal(result.error.next, 'stop-tell-user');
    }
  });
  test('successful changed-count receipts reject with delivery, context and fallback count preserved', async () => {
    for (const delivery of ['sent-unverified', 'sent-verified', 'unknown', 'not-sent']) {
      const context = { turn: 'turn', call: 'call' };
      const result = await clipboardClientReply({ ok: true, result: {
        delivery, retry: delivery === 'not-sent' ? 'safe' : 'read-first', clipboardChanged: true, menuFallbackCount: 1,
      } }, { context });
      assert.equal(result.ok, false); assert.equal(result.error.code, 'CLIPBOARD_CHANGED');
      assert.equal(result.error.delivery, delivery); assert.equal(result.error.retry, 'read-first');
      assert.equal(result.error.next, 'stop-tell-user'); assert.equal(result.error.menuFallbackCount, 1);
      assert.deepEqual(result.error.context, context);
    }
  });
  test('clipboard change result metadata fails closed before mapping when malformed', async () => {
    for (const result of [
      { clipboardChanged: 'true' }, { clipboardChanged: null }, { clipboardChanged: 1 },
      { clipboardChanged: true }, { clipboardChanged: true, delivery: 'sent-unverified', retry: 'safe' },
      { clipboardChanged: true, delivery: 'not-sent', retry: 'read-first' },
    ]) assert.equal((await clipboardClientReply({ ok: true, result })).error.code, 'DRIVER_PROTOCOL');
    assert.equal((await clipboardClientReply({ ok: true, result: { clipboardChanged: false } })).ok, true);
  });
  test('changed-count evidence on an error stops the turn and retains retirement', async () => {
    const result = await clipboardClientReply({ ok: false, error: {
      code: 'PERSON_TOOK_OVER', next: DRIVER_CODES.PERSON_TOOK_OVER.next, message: 'provider text', unhealthy: true,
      delivery: 'unknown', retry: 'read-first', clipboardChanged: true,
    } });
    assert.equal(result.error.code, 'CLIPBOARD_CHANGED'); assert.equal(result.error.next, 'stop-tell-user');
    assert.equal(result.error.unhealthy, true); assert.equal(result.error.delivery, 'unknown');
  });
  test('construction is inert and other platforms refuse before build', async () => {
    let builds = 0;
    const client = createMacDriverClient({ platform: 'linux', prepare() { builds++; } });
    assert.equal(builds, 0); await assert.rejects(client.health(), { code: 'PLATFORM' }); assert.equal(builds, 0); await client.close();
  });
  test('one lazy child serves concurrent calls with nonce and absolute deadlines', async t => {
    const f = fixture(t, (request, child) => child.send(reply(request, { method: request.method })));
    assert.equal(f.prepares, 0);
    const before = Date.now(), results = await Promise.all([f.client.ping(), f.client.getState(), f.client.listApps()]);
    assert.equal(f.children.length, 1); assert.equal(f.prepares, 1);
    assert.deepEqual(results.map(r => r.method), ['ping', 'getState', 'listApps']);
    assert.deepEqual(f.requests.map(r => r.id), [2, 3, 4]);
    for (const request of f.requests) {
      assert.equal(request.platform, 'darwin'); assert.match(request.nonce, /^[a-f0-9]{64}$/);
      assert.ok(request.deadline >= before + 5000 && request.deadline <= Date.now() + 5000);
    }
  });
  test('out-of-order replies match their request ids', async t => {
    const held = [];
    const f = fixture(t, (request, child) => { held.push(request); if (held.length === 2) for (const row of held.reverse()) child.send(reply(row, { method: row.method })); });
    const result = await Promise.all([f.client.ping(), f.client.health()]);
    assert.deepEqual(result.map(r => r.method), ['ping', 'health']);
  });
  test('RT26 settle options reach the helper without caller lock overrides', async t => {
    const f = fixture(t, (request, child) => child.send(reply(request, request.params)));
    const params = { windowId: '7', processStart: 'start', afterReadId: 3,
      includeScroll: true, waitForWindow: true, quietMs: 120, capMs: 1500, busyCapMs: 5000, extendForBusy: true };
    assert.deepEqual(await f.client.request('settle', params), params);
    await assert.rejects(f.client.request('settle', { ...params, allowLocked: true }), { code: 'INVALID_PARAMS' });
  });
  test('UTF-8 and lines may arrive in arbitrary chunks', async t => {
    const f = fixture(t, (request, child) => {
      const bytes = Buffer.from(JSON.stringify(reply(request, { text: '漢🙂' })) + '\n');
      for (const byte of bytes) child.send(Buffer.from([byte]));
    });
    assert.equal((await f.client.ping()).text, '漢🙂');
  });
  test('normal refusal preserves the child and action disposition', async t => {
    const f = fixture(t, (request, child) => request.id === 2 ? child.send(reply(request, undefined, { ok: false, result: undefined,
      error: { code: 'STALE_READ', message: 'read again', unhealthy: false, delivery: 'not-sent', retry: 'safe' } })) : child.send(reply(request)));
    await assert.rejects(f.client.ping(), error => error.code === 'STALE_READ' && error.delivery === 'not-sent' && error.retry === 'safe');
    await f.client.health(); assert.equal(f.children.length, 1);
  });
  test('unhealthy error retires the child and the next call gets a fresh nonce', async t => {
    let unhealthy = true;
    const f = fixture(t, (request, child) => {
      if (unhealthy) { unhealthy = false; child.send(reply(request, undefined, { ok: false, result: undefined,
        error: { code: 'AX_TIMEOUT', message: 'timed out', unhealthy: true } })); }
      else child.send(reply(request));
    });
    await assert.rejects(f.client.health(), { code: 'AX_TIMEOUT', unhealthy: true });
    await f.client.ping(); assert.equal(f.children.length, 2);
    assert.notEqual(f.children[0].nonce, f.children[1].nonce); assert.deepEqual(f.requests.map(r => r.id), [2, 2]);
  });
  test('belief duration survives success and error metadata without changing notice text', async t => {
    const f = fixture(t, (request, child) => request.id === 2
      ? child.send(reply(request, { fakeActiveMs: 9 }))
      : child.send(reply(request, undefined, { ok: false, result: undefined,
        error: { code: 'KEY_FOCUS_UNAVAILABLE', message: 'focus unavailable', unhealthy: false,
          delivery: 'sent-unverified', retry: 'read-first', fakeActiveMs: 401 } })));
    assert.equal((await f.client.pressKey({ windowId: '7', processStart: 'start', readId: 1 }, ['cmd+s'])).fakeActiveMs, 9);
    await assert.rejects(f.client.pressKey({ windowId: '7', processStart: 'start', readId: 1 }, ['cmd+s']),
      error => error.code === 'KEY_FOCUS_UNAVAILABLE' && error.fakeActiveMs === 401 && error.message === 'focus unavailable');
  });
  test('partial typing preserves the delivered character count', async t => {
    const f = fixture(t, (request, child) => child.send(reply(request, undefined, { ok: false, result: undefined,
      error: { code: 'KEY_FOCUS_UNAVAILABLE', message: 'focus unavailable', unhealthy: false,
        delivery: 'sent-unverified', retry: 'read-first', charactersDelivered: 71 } })));
    await assert.rejects(f.client.typeText({ windowId: '7', processStart: 'start', readId: 1 }, ['s'.repeat(500)]),
      error => error.code === 'KEY_FOCUS_UNAVAILABLE' && error.charactersDelivered === 71);
  });
  for (const charactersDelivered of [-1, 1.5, '71', null]) test(`invalid delivered count ${JSON.stringify(charactersDelivered)} retires the helper`, async t => {
    const f = fixture(t, (request, child) => child.send(reply(request, undefined, { ok: false, result: undefined,
      error: { code: 'KEY_FOCUS_UNAVAILABLE', message: 'focus unavailable', unhealthy: false,
        delivery: 'sent-unverified', retry: 'read-first', charactersDelivered } })));
    await assert.rejects(f.client.request('typeText', { args: ['text'] }), { code: 'DRIVER_PROTOCOL', unhealthy: true });
    assert.deepEqual(f.children[0].signals, ['SIGTERM']);
  });
  for (const fakeActiveMs of [-1, '401', null]) test(`invalid belief duration ${JSON.stringify(fakeActiveMs)} retires the helper`, async t => {
    const f = fixture(t, (request, child) => child.send(reply(request, undefined, { ok: false, result: undefined,
      error: { code: 'KEY_FOCUS_UNAVAILABLE', message: 'focus unavailable', unhealthy: false,
        delivery: 'not-sent', retry: 'safe', fakeActiveMs } })));
    await assert.rejects(f.client.request('pressKey', { args: ['cmd+s'] }), { code: 'DRIVER_PROTOCOL', unhealthy: true });
    assert.deepEqual(f.children[0].signals, ['SIGTERM']);
  });
  test('unhealthy success also retires its incarnation', async t => {
    const f = fixture(t, (request, child) => child.send(reply(request, { unhealthy: true })));
    assert.equal((await f.client.health()).unhealthy, true); await f.client.ping(); assert.equal(f.children.length, 2);
  });
  for (const [name, transform] of [
    ['wrong nonce', (r, c) => c.send(reply(r, {}, { nonce: 'f'.repeat(64) }))],
    ['unknown id', (r, c) => c.send(reply(r, {}, { id: 500 }))],
    ['wrong platform', (r, c) => c.send(reply(r, {}, { platform: 'win32' }))],
    ['wrong protocol', (r, c) => c.send(reply(r, {}, { protocol: 'other/1' }))],
    ['unknown envelope field', (r, c) => c.send(reply(r, {}, { extra: true }))],
    ['nonobject result', (r, c) => c.send(reply(r, {}, { result: null }))],
    ['malformed error', (r, c) => c.send(reply(r, undefined, { ok: false, result: undefined, error: { code: 'FAIL' } }))],
    ['unknown error code', (r, c) => c.send(reply(r, undefined, { ok: false, result: undefined,
      error: { code: 'UNDECLARED', message: 'bad', unhealthy: false } }))],
    ['wrong recovery directive', (r, c) => {
      const value = reply(r, undefined, { ok: false, result: undefined, error: { code: 'STALE_READ', message: 'bad', unhealthy: false } });
      value.error.next = 'none'; c.send(value);
    }],
    ['unsafe disposition', (r, c) => c.send(reply(r, undefined, { ok: false, result: undefined,
      error: { code: 'STALE_READ', message: 'bad', unhealthy: false, delivery: 'sent-unverified', retry: 'safe' } }))],
    ['missing mandatory retirement', (r, c) => c.send(reply(r, undefined, { ok: false, result: undefined,
      error: { code: 'AX_TIMEOUT', message: 'bad', unhealthy: false } }))],
    ['invalid UTF8', (r, c) => c.send(Buffer.from([255, 10]))],
    ['invalid JSON', (r, c) => c.send('{\n')],
    ['duplicate escaped key', (r, c) => c.send(JSON.stringify(reply(r)).replace('"ok":true', '"ok":true,"o\\u006b":true') + '\n')],
    ['partial EOF', (r, c) => { c.send('{'); c.stdout.end(); }],
  ]) test(`protocol fault retires on ${name}`, async t => {
    const f = fixture(t, transform);
    await assert.rejects(f.client.ping(), { code: 'DRIVER_PROTOCOL', unhealthy: true });
    assert.deepEqual(f.children[0].signals, ['SIGTERM']);
  });
  test('oversized incoming line fails before JSON decode', async t => {
    const f = fixture(t, (r, c) => c.send('x'.repeat(1025)));
    const client = createMacDriverClient({ platform: 'darwin', prepare: f.prepare, lineLimit: 1024 }); t.after(() => client.close());
    await assert.rejects(client.ping(), { code: 'DRIVER_LINE_LIMIT' });
  });
  test('timeout rejects all pending calls and never repeats an action', async t => {
    const f = fixture(t, () => {});
    const action = f.client.request('click', { args: [1] }, { timeoutMs: 30 });
    const read = f.client.health();
    const results = await Promise.allSettled([action, read]);
    assert.ok(results.every(r => r.status === 'rejected' && r.reason.code === 'DEADLINE_EXCEEDED'));
    assert.match(results[0].reason.message, /Read again before repeating/);
    assert.equal(f.requests.filter(r => r.method === 'click').length, 1);
  });
  for (const end of ['eof', 'close']) test(`clean helper ${end} emits DRIVER_EXIT with unknown input delivery`, async t => {
    const f = fixture(t, (_request, child) => {
      if (end === 'eof') child.stdout.end();
      else { child.closed = true; child.emit('close', 0); }
    });
    await assert.rejects(f.client.request('click', { args: [1] }), {
      code: 'DRIVER_EXIT', unhealthy: true, delivery: 'unknown', retry: 'read-first',
    });
    assert.equal(f.requests.filter(r => r.method === 'click').length, 1);
  });
  test('restart discards the active child and close forbids later calls', async t => {
    const f = fixture(t);
    await f.client.ping(); await f.client.restart(); await f.client.ping();
    assert.equal(f.children.length, 2); await f.client.close(); await assert.rejects(f.client.ping(), { code: 'DRIVER_CLOSED' });
  });
  test('32 pending calls are bounded before another write', async t => {
    const f = fixture(t, () => {}), pending = [];
    // Attach rejection observers before explicit restart rejects all calls.
    for (let i = 0; i < 32; i++) pending.push(f.client.ping().catch(e => e));
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(f.client.ping(), { code: 'DRIVER_BUSY' }); assert.equal(f.requests.length, 32);
    await f.client.restart(); assert.ok((await Promise.all(pending)).every(e => e.code === 'DRIVER_RESTARTED'));
  });
  test('invalid budgets, parameters and oversized writes refuse', async t => {
    assert.throws(() => createMacDriverClient({ timeoutMs: 30001 }), { code: 'INVALID_PARAMS' });
    assert.throws(() => createMacDriverClient({ lineLimit: DRIVER_LINE_LIMIT + 1 }), { code: 'INVALID_PARAMS' });
    const f = fixture(t);
    await assert.rejects(f.client.request('ping', {}, { timeoutMs: 0 }), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.client.request('', {}), { code: 'INVALID_PARAMS' });
    const client = createMacDriverClient({ platform: 'darwin', prepare: f.prepare, lineLimit: 1024 }); t.after(() => client.close());
    await assert.rejects(client.request('ping', { text: 'a'.repeat(1024) }), { code: 'DRIVER_LINE_LIMIT' });
    assert.equal(f.requests.length, 0);
  });
  test('read conveniences pass depth and budget separately from transport timeout', async t => {
    const f = fixture(t, (r, c) => c.send(reply(r, { params: r.params })));
    const result = await f.client.getAXState('7', { processStart: '1.2', depth: 3, budgetMs: 400, timeoutMs: 500 });
    assert.deepEqual(result.params, { windowId: '7', processStart: '1.2', depth: 3, budgetMs: 400 });
  });

  test('read reuse is allowed only on the two AX read methods', async t => {
    const f = fixture(t, (request, child) => child.send(reply(request, { params: request.params })));
    const params = { windowId: '7', processStart: '1.2', reuseIfUnchanged: 1 };
    for (const method of ['getAXState', 'getAXStateAndScreenshot'])
      assert.deepEqual((await f.client.request(method, params)).params, params);
    for (const method of ['getScreenshot', 'verifyWindowIdentity', 'click'])
      await assert.rejects(f.client.request(method, params), { code: 'INVALID_PARAMS' });
  });
  for (const method of ['getScreenshot', 'getAXStateAndScreenshot']) {
    test(`${method} sends capture options as parameters, keeping timeout and context on the envelope`, async t => {
      const f = fixture(t, (r, c) => c.send(reply(r, { params: r.params })));
      const result = await f.client[method]('7', { processStart: '1.2', format: 'jpeg', scale: 'point',
        timeoutMs: 500, context: { call: 'capture' } });
      assert.deepEqual(result.params, { windowId: '7', processStart: '1.2', format: 'jpeg', scale: 'point' });
      assert.deepEqual(f.requests.at(-1).context, { call: 'capture' });
      const defaults = await f.client[method]('7', { processStart: '1.2' });
      assert.deepEqual(defaults.params, { windowId: '7', processStart: '1.2' });
    });
  }
  test('capture options cannot expand a non-capture request allowlist', async t => {
    const f = fixture(t);
    await assert.rejects(f.client.getAXState('7', { processStart: '1.2', format: 'jpeg' }), { code: 'INVALID_PARAMS' });
    await assert.rejects(f.client.request('verifyWindowIdentity', { windowId: '7', processStart: '1.2', scale: 'point' }), { code: 'INVALID_PARAMS' });
    assert.equal(f.prepares, 0);
  });
  test('real stdio with a fake helper returns 20 ten-KB replies', async t => {
    const client = createMacDriverClient({ platform: 'darwin', prepare: async () => ({ status: 'ready', spawn: () =>
      spawn(process.execPath, [fileURLToPath(import.meta.url), '--fake-helper'], { stdio: ['pipe', 'pipe', 'pipe'] }) }) });
    t.after(() => client.close());
    await client.ping();
    const times = [], text = 'x'.repeat(10 * 1024);
    for (let i = 0; i < 20; i++) {
      const began = performance.now(); const result = await client.request('echo', { args: [text] }); times.push(performance.now() - began);
      assert.equal(result.args[0].length, 10240);
    }
    times.sort((a, b) => a - b);
    t.diagnostic(`fake stdio 20/20, 10240 text bytes, p50=${times[9].toFixed(3)}ms p90=${times[17].toFixed(3)}ms`);
  });
}

if (!process.argv.includes('--fake-helper')) {
  test('unavailable and thrown compile failures are memoized across concurrent and later calls', async () => {
    for (const thrown of [false, true]) {
      let prepares = 0;
      const client = createMacDriverClient({ platform: 'darwin', prepare: async () => {
        prepares++;
        if (thrown) throw Object.assign(Error('compile failed'), { code: 'HOST_BUILD_FAILED' });
        return { status: 'unavailable', code: 'APPLE_TOOLS_MISSING' };
      } });
      const code = 'DRIVER_UNAVAILABLE';
      await Promise.all([assert.rejects(client.health(), { code }), assert.rejects(client.getState(), { code })]);
      await assert.rejects(client.ping(), { code }); assert.equal(prepares, 1);
      await client.restart();
      await assert.rejects(client.health(), { code }); assert.equal(prepares, 2); await client.close();
    }
  });

  for (const code of ['HOST_BUILD_BUSY', 'HOST_CACHE_UNSAFE', 'ABORT_ERR']) {
    test(`${code} is transient and preparation retries on the next call`, async t => {
      const f = fixture(t);
      let prepares = 0;
      const client = createMacDriverClient({ platform: 'darwin', prepare: async () => {
        if (++prepares === 1) return { status: 'unavailable', code };
        return f.prepare();
      } });
      t.after(() => client.close());
      await assert.rejects(client.health(), { code: 'DRIVER_UNAVAILABLE' });
      assert.equal((await client.getState()).constructor, Object);
      assert.equal(prepares, 2);
    });
  }
  test('a cancelled compiler result does not poison the next preparation', async t => {
    const f = fixture(t); let prepares = 0;
    const client = createMacDriverClient({ platform: 'darwin', prepare: async () => {
      if (++prepares === 1) return { status: 'unavailable', code: 'NATIVE_HELPERS_UNAVAILABLE', detail: { stage: 'compile', errorCode: 'ABORT_ERR' } };
      return f.prepare();
    } });
    t.after(() => client.close());
    await assert.rejects(client.ping(), { code: 'DRIVER_UNAVAILABLE' });
    await client.getState(); assert.equal(prepares, 2);
  });
  test('native compiler failures are memoized until restart clears them', async t => {
    const f = fixture(t); let prepares = 0;
    const client = createMacDriverClient({ platform: 'darwin', prepare: async () => {
      if (++prepares === 1) return { status: 'unavailable', code: 'NATIVE_HELPERS_UNAVAILABLE', detail: { stage: 'compile', exitCode: 1 } };
      return f.prepare();
    } });
    t.after(() => client.close());
    await assert.rejects(client.ping(), { code: 'DRIVER_UNAVAILABLE' });
    await assert.rejects(client.health(), { code: 'DRIVER_UNAVAILABLE' }); assert.equal(prepares, 1);
    await client.restart(); await client.getState(); assert.equal(prepares, 2);
  });
  function versionFixture(t, hello, { driveLocked = false } = {}) {
    const requests = [], children = [];
    const client = createMacDriverClient({ platform: 'darwin', driveLocked, prepare: async () => ({ status: 'ready', build: 'b'.repeat(64),
      spawn: () => {
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.kill = () => { queueMicrotask(() => child.emit('close')); return true; };
        child.stdin = new Writable({ write(bytes, encoding, done) {
          const r = JSON.parse(bytes); requests.push(r); done();
          const response = r.id === 1 ? reply(r, hello) : reply(r, {}, r.method === 'refuse' ? {
            ok: false, result: undefined, context: r.context,
            error: { code: 'STALE_READ', message: 'STALE_READ', unhealthy: false, next: 'read-again' },
          } : {});
          queueMicrotask(() => child.stdout.write(JSON.stringify(response) + '\n'));
        } });
        children.push(child); return child;
      },
    }) });
    t.after(() => client.close()); return { client, requests, children };
  }
  for (const [name, hello] of [
    ['old API', { apiVersion: 0 }], ['API before reuse', { apiVersion: 1 }], ['missing API', { apiVersion: undefined }], ['wrong protocol', { protocol: 'other/1' }],
    ['wrong source build', { build: 'c'.repeat(64) }], ['missing build', { build: undefined }],
    ['missing methods', { methods: ['ping'] }], ['invalid method list', { methods: null }],
  ]) test(`handshake refuses ${name} before the requested operation`, async t => {
    const f = versionFixture(t, hello);
    await assert.rejects(f.client.getState(), { code: 'DRIVER_VERSION_MISMATCH', unhealthy: true });
    assert.deepEqual(f.requests.map(r => r.method), ['ping']); assert.equal(f.children.length, 1);
  });
  test('an unadvertised method retires before its first application request', async t => {
    const f = versionFixture(t, { methods: DRIVER_CORE_METHODS });
    await assert.rejects(f.client.setValue({ windowId: '7', processStart: '1.2', readId: 1 }, [1, 'v']), { code: 'DRIVER_VERSION_MISMATCH', unhealthy: true });
    assert.deepEqual(f.requests.map(r => r.method), ['ping']);
  });
  test('future method names use owner lock policy and reject unrecognized model fields', async t => {
    const off = versionFixture(t, {}), on = versionFixture(t, {}, { driveLocked: true });
    for (const f of [off, on]) {
      await f.client.request('echo', { args: [] });
      assert.deepEqual(f.requests.at(-1).params, f === on ? { args: [], allowLocked: true } : { args: [] });
      await assert.rejects(f.client.request('echo', { modelField: true }), { code: 'INVALID_PARAMS' });
      await f.client.health(); assert.deepEqual(f.requests.at(-1).params, {});
    }
  });
  test('context is bounded, survives error correlation, and rejects controls before spawn', async t => {
    const f = versionFixture(t, {}), context = { session: 's', turn: 't', call: 'c' };
    await assert.rejects(f.client.request('refuse', {}, { context }), e => e.code === 'STALE_READ' && e.next === 'read-again' && e.context.call === 'c');
    assert.deepEqual(f.requests[1].context, context);
    for (const invalid of [{ call: 'x'.repeat(129) }, { call: '\n' }, { call: '\u200e' }, { unknown: 'x' }, null, { turn: 1 }]) {
      await assert.rejects(f.client.request('getState', {}, { context: invalid }), { code: 'INVALID_PARAMS' });
    }
    assert.equal(f.requests.length, 2);
  });
  test('lock override comes only from the client owner policy and an explicit parameter allowlist', async t => {
    const off = versionFixture(t, {}), on = versionFixture(t, {}, { driveLocked: true });
    const binding = { windowId: '7', processStart: '1.2', readId: 1, allowLocked: true, modelField: true };
    for (const f of [off, on]) {
      await assert.rejects(f.client.request('getAXState', binding), { code: 'INVALID_PARAMS' });
      await f.client.click(binding, [1]);
      const params = f.requests.at(-1).params;
      assert.deepEqual(Object.keys(params).sort(), ['args', 'processStart', 'read', 'readId', 'windowId', ...(f === on ? ['allowLocked'] : [])].sort());
      assert.equal(params.allowLocked, f === on ? true : undefined);
      assert.equal(params.read, 'none');
      await f.client.setValue(binding, [1, 'v'], { read: 'full' });
      assert.equal(f.requests.at(-1).params.read, 'full');
    }
    assert.throws(() => createMacDriverClient({ driveLocked: 'true' }), { code: 'INVALID_PARAMS' });
  });
}
