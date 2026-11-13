import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { ElectronBroker, PipeTransport } from '../plugins/sleight/lib/direct-browser/electron/broker.mjs';

function harness(options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = [];
  input.on('data', data => {
    const request = JSON.parse(data.toString().slice(0, -1));
    frames.push(request);
    queueMicrotask(() => output.write(JSON.stringify({ id: request.id, result: { ok: true } }) + '\0'));
  });
  const events = new EventEmitter();
  const owned = { pid: 100, birth: 'one' };
  const calls = [];
  let alive = true;
  const ownership = {
    reserve: async () => { calls.push('reserve'); return { profile: '/fixture', owner: 'nonce' }; },
    record: async (_, identity) => calls.push(['record', identity]),
    remove: async () => calls.push('remove'),
  };
  const child = { identity: owned, input, output, events,
    inspect: async () => ({ parent: alive ? owned : null, descendants: [], complete: true }),
    requestQuit: async () => { calls.push('quit'); alive = false; events.emit('exit', 0); },
  };
  const broker = new ElectronBroker({
    ownership, launch: async () => { calls.push('spawn'); return child; },
    authorizeLaunch: async () => true,
    authorize: async operation => ({ grantId: operation.grant, method: 'Runtime.test', params: { value: operation.value } }),
    ...options,
  });
  return { broker, child, calls, frames, output, input, setAlive: value => { alive = value; } };
}

test('ownership precedes spawn; handshake and authenticated reconnect retain one writer', async () => {
  const h = harness();
  await h.broker.start({});
  assert.deepEqual(h.calls.slice(0, 2), ['reserve', 'spawn']);
  assert.equal(h.frames[0].method, 'Browser.getVersion');
  const client = h.broker.connect('session');
  await h.broker.dispatch(client, { grant: 'a', value: 1 });
  h.broker.detach(client);
  assert.equal(h.input.destroyed, false);
  const next = h.broker.connect('session');
  await assert.rejects(h.broker.dispatch(client, { grant: 'b' }), /client/);
  await h.broker.dispatch(next, { grant: 'c' });
  assert.equal(h.calls.filter(x => x === 'spawn').length, 1);
});

test('forged clients and replayed grants never dispatch; policy defaults to denial', async () => {
  const h = harness(); await h.broker.start({});
  const client = h.broker.connect('a');
  await assert.rejects(h.broker.dispatch({ ...client }, { grant: 'x' }), /client/);
  await h.broker.dispatch(client, { grant: 'x' });
  await assert.rejects(h.broker.dispatch(client, { grant: 'x' }), /replayed/);
  const denied = harness({ authorize: undefined }); await denied.broker.start({});
  await assert.rejects(denied.broker.dispatch(denied.broker.connect('b'), {}), /authority/);
  const launchDenied = harness({ authorizeLaunch: undefined });
  await assert.rejects(launchDenied.broker.start({}), /authority/);
  assert.deepEqual(launchDenied.calls, []);
});

test('revocation during authorization parks without closing the pipe or dispatching', async () => {
  let release;
  const h = harness({ authorize: () => new Promise(resolve => { release = resolve; }) });
  await h.broker.start({});
  const call = h.broker.dispatch(h.broker.connect('s'), {});
  await new Promise(resolve => setImmediate(resolve));
  h.broker.park('revoked');
  release({ grantId: 'late', method: 'Runtime.test', params: {} });
  await assert.rejects(call, /parked/);
  assert.equal(h.frames.length, 1);
  assert.equal(h.input.destroyed, false);
  await assert.rejects(h.broker.start({}), /ownership/);
});

test('in-flight revocation and cancellation report unknown and never replay', async () => {
  const h = harness(); await h.broker.start({});
  h.input.removeAllListeners('data');
  const client = h.broker.connect('s');
  const controller = new AbortController();
  const call = h.broker.dispatch(client, { grant: 'once' }, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  const receipt = await call;
  assert.equal(receipt.phase, 'unknown');
  assert.equal(receipt.dispatched, true);
  assert.equal(h.broker.state, 'parked');
  assert.equal(h.input.destroyed, false);
});

test('quit requires separate consent and retains state for missing or reused identities', async () => {
  const h = harness(); await h.broker.start({});
  await assert.rejects(h.broker.quit(), /consent/);
  h.child.inspect = async () => ({ parent: { pid: 100, birth: 'reused' }, descendants: [], complete: true });
  const receipt = await h.broker.quit(async () => true);
  assert.equal(receipt.cleanup, 'retained');
  assert.equal(h.calls.includes('quit'), false);
  assert.equal(h.calls.includes('remove'), false);
});

test('observed descendants, interrupted cleanup and partial launch retain ownership', async () => {
  const h = harness(); await h.broker.start({});
  h.child.inspect = async () => ({ parent: null, descendants: [{ pid: 101, birth: 'child' }], complete: true });
  assert.equal((await h.broker.collect()).cleanup, 'retained');
  h.child.inspect = async () => ({ parent: null, descendants: [], complete: true });
  assert.equal((await h.broker.collect()).cleanup, 'retained');
  h.child.confirmAbsent = async union => union.length === 1 && union[0].birth === 'child';
  assert.equal((await h.broker.collect()).cleanup, 'removed');
  assert.equal(h.calls.at(-1), 'remove');
  const partial = harness({ launch: async () => { throw new Error('partial spawn'); } });
  await assert.rejects(partial.broker.start({}), /partial spawn/);
  assert.equal(partial.broker.state, 'retained');
  await assert.rejects(partial.broker.start({}), /ownership/);
});

test('child refusal, EOF and crash retain evidence without silently restarting', async () => {
  const h = harness();
  h.input.removeAllListeners('data');
  h.input.on('data', data => {
    const { id } = JSON.parse(data.toString().slice(0, -1));
    h.output.write(JSON.stringify({ id, error: { message: 'unsupported' } }) + '\0');
  });
  await assert.rejects(h.broker.start({}), /unsupported/);
  assert.equal(h.broker.state, 'retained');
  assert.equal(h.input.destroyed, false);
  const crashed = harness(); await crashed.broker.start({});
  crashed.output.end();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(crashed.broker.state, 'parked');
  assert.equal(crashed.calls.includes('remove'), false);
});

test('NUL framing handles split UTF-8 and coalesced replies with bounded frames', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const transport = new PipeTransport({ input, output, maxFrameBytes: 100, timeoutMs: 50 });
  const a = transport.request('One'), b = transport.request('Two');
  const bytes = Buffer.from('{"id":1,"result":"é"}\0{"id":2,"result":2}\0');
  const split = bytes.indexOf(0xc3) + 1;
  output.write(bytes.subarray(0, split)); output.write(bytes.subarray(split));
  assert.equal(await a, 'é'); assert.equal(await b, 2);
  const c = transport.request('Three');
  output.write('x'.repeat(101));
  await assert.rejects(c, /frame/);
  assert.equal(input.destroyed, false);
});

test('backpressure bounds requests and cancellation does not close the app writer', async () => {
  const input = new Writable({ highWaterMark: 1, write(_data, _enc, _done) {} });
  const output = new PassThrough();
  const transport = new PipeTransport({ input, output, maxPending: 1, timeoutMs: 20 });
  const first = transport.request('One');
  await assert.rejects(transport.request('Two'), /queue/);
  await assert.rejects(first, /timeout/);
  assert.equal(input.destroyed, false);
});

test('a PID incarnation change before dispatch parks without sending commands', async () => {
  const h = harness(); await h.broker.start({});
  const client = h.broker.connect('s');
  h.child.inspect = async () => ({ parent: { pid: 100, birth: 'replacement' }, descendants: [], complete: true });
  await assert.rejects(h.broker.dispatch(client, { grant: 'new' }), /identity/);
  assert.equal(h.frames.length, 1);
  assert.equal(h.broker.state, 'parked');
});

test('interrupted cleanup retains ownership and exact-instance Quit can finish', async () => {
  const h = harness(); await h.broker.start({});
  h.broker.ownership.remove = async () => { throw new Error('cleanup interrupted'); };
  assert.equal((await h.broker.quit(async () => true)).cleanup, 'retained');
  assert.equal(h.calls.includes('quit'), true);
  assert.equal(h.input.destroyed, false);
  h.broker.ownership.remove = async () => h.calls.push('remove');
  assert.equal((await h.broker.collect()).cleanup, 'removed');
  assert.equal(h.input.writableEnded, true);
});

test('single-instance forwarding and a missing handshake retain partial launch state', async () => {
  const h = harness();
  h.child.inspect = async () => ({ parent: null, descendants: [], complete: true });
  await assert.rejects(h.broker.start({}), /forwarding/);
  assert.equal(h.frames.length, 0);
  const hung = harness({ transport: { timeoutMs: 10 } });
  hung.input.removeAllListeners('data');
  await assert.rejects(hung.broker.start({}), /timeout/);
  assert.equal(hung.broker.state, 'retained');
  assert.equal(hung.input.destroyed, false);
});

test('launch authority binds a snapshot even if the caller changes the spec while it waits', async () => {
  let release, launched;
  const h = harness({ authorizeLaunch: () => new Promise(resolve => { release = resolve; }),
    launch: async spec => { launched = spec; return h.child; } });
  const spec = { build: 'approved', profile: { name: 'one' } };
  const start = h.broker.start(spec);
  spec.build = 'other'; spec.profile.name = 'two';
  release(true); await start;
  assert.deepEqual(launched, { build: 'approved', profile: { name: 'one' } });
});

test('revocation during launch approval never reaches ownership reservation or spawn', async () => {
  let release;
  const h = harness({ authorizeLaunch: () => new Promise(resolve => { release = resolve; }) });
  const start = h.broker.start({});
  h.broker.park('revoked before spawn'); release(true);
  await assert.rejects(start, /interrupted/);
  assert.deepEqual(h.calls, []);
});

test('identity changes during authorization and incomplete absence proofs fail closed', async () => {
  const h = harness({ authorize: async () => {
    h.child.inspect = async () => ({ parent: { pid: 100, birth: 'replacement' }, descendants: [], complete: true });
    return { method: 'Runtime.test', params: {}, grantId: 'g' };
  } });
  await h.broker.start({});
  await assert.rejects(h.broker.dispatch(h.broker.connect('s'), {}), /identity/);
  assert.equal(h.frames.length, 1);
  h.child.inspect = async () => ({ descendants: [], complete: true });
  assert.equal((await h.broker.collect()).cleanup, 'retained');
});

test('synthetic 1/4/13 clients: separate cold, warm reconnect and dispatch distributions', async t => {
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
  for (const count of [1, 4, 13]) {
    const cold = [], warm = [], calls = [], cleanup = [];
    for (let run = 0; run < 20; run++) {
      const h = harness(); let start = performance.now();
      await h.broker.start({}); cold.push(performance.now() - start);
      start = performance.now();
      const clients = Array.from({ length: count }, (_, i) => h.broker.connect('s' + i));
      for (const client of clients) h.broker.detach(client);
      const reconnected = Array.from({ length: count }, (_, i) => h.broker.connect('s' + i));
      warm.push(performance.now() - start);
      start = performance.now();
      const results = await Promise.all(reconnected.map((client, i) => h.broker.dispatch(client, { grant: 'g' + i })));
      calls.push(performance.now() - start);
      assert.ok(results.every(result => result.phase === 'observed'));
      start = performance.now();
      assert.equal((await h.broker.quit(async () => true)).cleanup, 'removed');
      cleanup.push(performance.now() - start);
    }
    t.diagnostic(JSON.stringify({ clients: count, trials: 20, unit: 'ms', synthetic: true,
      distributions: Object.fromEntries(Object.entries({ cold, warm, calls, cleanup }).map(([key, values]) =>
        [key, { p50: percentile(values, .5), p90: percentile(values, .9) }])) }));
  }
});

const python = spawnSync('python3', ['--version'], { encoding: 'utf8' });
test('fake child validates launcher descriptors, EOF, recipe refusal and safe cleanup', {
  skip: python.status === 0 ? false : 'python3 is unavailable',
}, () => {
  const result = spawnSync('python3', [new URL('./fixtures/fake-electron.py', import.meta.url).pathname, '--self-test'], {
    encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /launcher checks passed/);
});

for (const mode of ['after-profile', 'after-owner', 'replaced-profile', 'replaced-lock',
  'replaced-lock-owner', 'missing-evidence', 'idempotent', 'census', 'partial-profile', 'descriptor', 'replaced-profile-link']) {
  test('owned Python cleanup resumes with exact evidence: ' + mode, {
    skip: python.status !== 0 ? 'python3 is unavailable' : process.platform === 'win32' ? 'POSIX launch primitive unavailable' : false,
  }, () => {
    const result = spawnSync('python3', [new URL('./fixtures/fake-electron.py', import.meta.url).pathname, '--cleanup-test', mode], {
      encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /cleanup checks passed:/);
  });
}
