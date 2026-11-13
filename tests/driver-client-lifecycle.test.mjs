import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { createMacDriverClient, createWindowsDriverClient } from '../plugins/sleight/lib/driver-client.mjs';
import { createMacReadState } from '../plugins/sleight/lib/mac-driver/diff.mjs';
import { DRIVER_API_VERSION, DRIVER_CORE_METHODS, DRIVER_ACTION_METHODS, DRIVER_CODES } from '../plugins/sleight/lib/mac-driver/protocol.mjs';

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture(t, { factory = createMacDriverClient, platform = 'darwin', tree = () => 'Window: "Fixture", App: Fixture.\n0 window Fixture\n\t1 button Seven', readStart = generation => generation === 1 ? 4 : 0, reply, ...options } = {}) {
  const children = [], requests = [];
  let failure, prepares = 0, hold, held;
  const client = factory({ platform, turnEndIdleMs: 60, ...options,
    prepare: async () => {
      prepares++; if (failure) return { status: 'unavailable', code: failure };
      return { status: 'ready', build: 'b'.repeat(64), spawn({ nonce }) {
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.signals = [];
        const retained = new Set(); let nextRead = readStart(children.length + 1);
        const respond = request => {
          const stale = ['readId', 'afterReadId'].some(key => request.params[key] !== undefined && !retained.has(request.params[key]));
          if (request.method === 'getAXState') { retained.clear(); retained.add(++nextRead); }
          child.stdout.write(JSON.stringify({ protocol: request.protocol,
          ...platform === 'darwin' ? { platform: 'darwin' } : {}, nonce, id: request.id, ok: !stale,
          ...stale ? { error: { code: 'STALE_READ', message: 'Read again.', next: DRIVER_CODES.STALE_READ.next,
            unhealthy: false, delivery: 'not-sent', retry: 'safe' } } : {
          result: request.method === 'ping' ? { protocol: request.protocol, apiVersion: DRIVER_API_VERSION,
            build: 'b'.repeat(64), methods: [...DRIVER_CORE_METHODS, ...DRIVER_ACTION_METHODS, 'settle'] } :
            { generation: children.length, ...request.method === 'getAXState' ? { text: tree(), readId: nextRead } : {}, ...reply?.(request, nextRead) } },
        }) + '\n'); };
        child.stdin = new Writable({ write(bytes, _, done) {
          const request = JSON.parse(bytes); requests.push(request); done();
          if (hold === request.method) { held = () => respond(request); return; }
          queueMicrotask(() => respond(request));
        } });
        child.kill = (signal = 'SIGTERM') => { child.signals.push(signal); queueMicrotask(() => child.emit('close')); return true; };
        children.push(child); return child;
      } };
    },
  });
  t.after(() => client.close());
  return { client, children, requests, fail: value => { failure = value; }, hold: value => { hold = value; },
    release() { held(); hold = undefined; }, get prepares() { return prepares; } };
}
function clock(t) { t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 }); }

test('default lifecycle never exits after turn end', async t => {
  clock(t); const f = fixture(t, { turnEndIdleMs: undefined });
  await f.client.ping(); f.client.endTurn(); t.mock.timers.tick(120000); await tick();
  assert.deepEqual(f.children[0].signals, []);
});
test('opt-in helper exits only 60 seconds after turn end and restarts lazily', async t => {
  clock(t); const f = fixture(t, { turnEndIdleMs: 60000 });
  f.client.endTurn(); assert.equal(f.prepares, 0);
  await f.client.ping(); t.mock.timers.tick(120000); await tick();
  assert.equal(f.children.length, 1); assert.deepEqual(f.children[0].signals, []);
  f.client.endTurn(); t.mock.timers.tick(59999); assert.deepEqual(f.children[0].signals, []);
  t.mock.timers.tick(1); await tick(); assert.deepEqual(f.children[0].signals, ['SIGTERM']);
  assert.equal(f.children.length, 1); await f.client.ping(); assert.equal(f.children.length, 2);
  assert.notEqual(f.requests[0].nonce, f.requests.at(-1).nonce);
});
test('a request in the exit window cancels retirement for the whole next turn', async t => {
  clock(t); const f = fixture(t); await f.client.ping(); f.client.endTurn();
  t.mock.timers.tick(59); const read = await f.client.getAXState('7', { processStart: '1.2' });
  t.mock.timers.tick(120000); await tick();
  const action = await f.client.click({ windowId: '7', processStart: '1.2', readId: read.readId }, [1]);
  assert.equal(action.generation, read.generation); assert.deepEqual(f.children[0].signals, []);
});
test('beginTurn cancels retirement before a cell reaches its first driver request', async t => {
  clock(t); const f = fixture(t); await f.client.ping(); f.client.endTurn();
  f.client.beginTurn(); t.mock.timers.tick(120000); await tick();
  assert.deepEqual(f.children[0].signals, []);
});
test('turn end during a request waits for its reply even past the exit deadline', async t => {
  clock(t); const f = fixture(t); await f.client.ping(); f.hold('getState');
  const request = f.client.getState(); await tick(); f.client.endTurn();
  t.mock.timers.tick(61); await tick(); assert.deepEqual(f.children[0].signals, []);
  f.release(); assert.equal((await request).generation, 1); await tick();
  t.mock.timers.tick(0); await tick(); assert.deepEqual(f.children[0].signals, ['SIGTERM']);
});
test('a new request cancels an end scheduled behind an older in-flight request', async t => {
  clock(t); const f = fixture(t); await f.client.ping(); f.hold('getState');
  const old = f.client.getState(); await tick(); f.client.endTurn();
  await f.client.ping(); f.release(); await old;
  t.mock.timers.tick(120000); await tick(); assert.deepEqual(f.children[0].signals, []);
});
test('a compile failure after idle exit retains the existing memo until explicit restart', async t => {
  clock(t); const f = fixture(t); await f.client.ping(); f.client.endTurn(); t.mock.timers.tick(60); await tick();
  f.fail('HOST_BUILD_FAILED'); await assert.rejects(f.client.ping(), { code: 'DRIVER_UNAVAILABLE' });
  await assert.rejects(f.client.ping(), { code: 'DRIVER_UNAVAILABLE' }); assert.equal(f.prepares, 2);
  f.fail(undefined); await f.client.restart(); await f.client.ping(); assert.equal(f.prepares, 3);
});
test('turn-end retirement belongs to one client, even when two servers share a host', async t => {
  clock(t); const a = fixture(t), b = fixture(t); await a.client.ping(); await b.client.ping();
  a.client.endTurn(); t.mock.timers.tick(60); await tick();
  assert.deepEqual(a.children[0].signals, ['SIGTERM']); assert.deepEqual(b.children[0].signals, []);
});
test('activity on one server cannot cancel another server\'s idle exit', async t => {
  clock(t); const a = fixture(t), b = fixture(t); await a.client.ping(); await b.client.ping();
  a.client.endTurn(); await b.client.ping(); t.mock.timers.tick(60); await tick();
  assert.deepEqual(a.children[0].signals, ['SIGTERM']); assert.deepEqual(b.children[0].signals, []);
});
test('close cancels the pending idle exit and cannot resurrect a helper', async t => {
  clock(t); const f = fixture(t); await f.client.ping(); f.client.endTurn(); await f.client.close();
  t.mock.timers.tick(120000); await tick(); assert.deepEqual(f.children[0].signals, ['SIGTERM']);
  await assert.rejects(f.client.ping(), { code: 'DRIVER_CLOSED' }); assert.equal(f.children.length, 1);
});
test('invalid lifecycle budgets refuse construction', () => {
  for (const turnEndIdleMs of [-1, 0.1, NaN, Infinity, '60', 3600001])
    assert.throws(() => createMacDriverClient({ turnEndIdleMs }), { code: 'INVALID_PARAMS' });
});

test('the environment switch accepts only 1, snapshots at construction, and leaves Windows unchanged', async t => {
  clock(t); const original = process.env.SLEIGHT_HELPER_TURN_END_EXIT;
  t.after(() => { if (original === undefined) delete process.env.SLEIGHT_HELPER_TURN_END_EXIT; else process.env.SLEIGHT_HELPER_TURN_END_EXIT = original; });
  for (const value of [undefined, '0', 'true', ' 1', '1']) {
    if (value === undefined) delete process.env.SLEIGHT_HELPER_TURN_END_EXIT; else process.env.SLEIGHT_HELPER_TURN_END_EXIT = value;
    const f = fixture(t, { turnEndIdleMs: undefined });
    process.env.SLEIGHT_HELPER_TURN_END_EXIT = value === '1' ? '0' : '1';
    await f.client.ping(); f.client.endTurn(); t.mock.timers.tick(60000); await tick();
    assert.deepEqual(f.children[0].signals, value === '1' ? ['SIGTERM'] : [], String(value));
  }
  process.env.SLEIGHT_HELPER_TURN_END_EXIT = '1';
  const win = fixture(t, { factory: createWindowsDriverClient, platform: 'win32' }); await win.client.ping();
  assert.equal(win.client.endTurn, undefined); t.mock.timers.tick(120000); await tick(); assert.deepEqual(win.children[0].signals, []);
});

const window = { windowId: '7', pid: 123, processStart: '1.2', bundleId: 'com.example.Fixture',
  app: 'Fixture', title: 'Fixture', identityVerified: true, bounds: { x: 0, y: 0, width: 800, height: 600 } };

async function collidingHandle(t, factory) {
  let tree = 'Window: "Fixture", App: Fixture.\n0 window Fixture\n\t1 button Delete';
  const f = fixture(t, { factory, readStart: () => 0, tree: () => tree });
  const reads = createMacReadState();
  f.client.onRetire(() => reads.reset());
  const read = async () => {
    const result = await f.client.getAXState('7', { processStart: '1.2' });
    const snapshot = reads.read({ ...result, window });
    reads.endCell([{ type: 'text', text: snapshot.text }], [snapshot]);
    return snapshot;
  };
  const old = await read();
  reads.endTurn(); f.client.endTurn(); t.mock.timers.tick(60); await tick();
  tree = tree.replace('Delete', 'Save');
  const fresh = await read();
  const params = { windowId: '7', processStart: '1.2', readId: old.readId, args: [1] };
  // The new tree has already been delivered. Turn cleanup cannot explain this refusal.
  const sent = f.requests.length;
  await assert.rejects(f.client.click(params, params.args), { code: 'STALE_READ', delivery: 'not-sent', retry: 'safe' });
  assert.equal(f.requests.length, sent, 'the driver generation check refuses before native dispatch');
  assert.throws(() => reads.assertCurrent('click', params, 'new-turn'), { code: 'STALE_READ' });
  const current = { ...params, readId: fresh.readId };
  const complete = reads.assertCurrent('click', current, 'new-turn');
  await f.client.click(current, current.args); complete();
  assert.equal(f.requests.at(-1).params.readId, 1, 'native IDs collide across helpers');
  assert.equal(f.children.length, 2);
}
test('colliding id-1 handles cannot click a new helper\'s delivered tree', async t => {
  clock(t); await collidingHandle(t);
});

async function crossTurnReplay(t, { factory, count = 90 } = {}) {
  const bank = JSON.parse(readFileSync(new URL('./fixtures/rt11f-replay.json', import.meta.url), 'utf8'));
  const reads = createMacReadState();
  let delivered, actions = 0, stale = 0, old;
  const f = fixture(t, { factory, tree: () => delivered, readStart: () => 0 });
  f.client.onRetire(() => reads.reset());
  const read = async () => reads.read({ ...await f.client.getAXState('7', { processStart: '1.2' }), window });
  for (const row of bank.actions.slice(0, count)) {
    delivered = 'Window: "Fixture", App: Fixture.\n' + bank.pairs[row.pair].delivered.replace(/^0 [^\n]+/, '0 window Fixture');
    old ??= await read();
    reads.endCell([{ type: 'text', text: old.text }], [old]);
    reads.endTurn(); f.client.endTurn(); t.mock.timers.tick(60); await tick();
    const fresh = await read();
    reads.endCell([{ type: 'text', text: fresh.text }], [fresh]);
    const params = { windowId: '7', processStart: '1.2', readId: old.readId, args: [row.n] };
    // First refusal is at the driver boundary AFTER the replacement read is
    // delivered. It cannot pass just because endTurn cleared delivered state.
    const sent = f.requests.length;
    await assert.rejects(f.client.click(params, params.args), { code: 'STALE_READ', delivery: 'not-sent', retry: 'safe' });
    assert.equal(f.requests.length, sent, 'generation refusal must precede native dispatch');
    stale++;
    assert.throws(() => reads.assertCurrent('click', params, 'next-turn'), { code: 'STALE_READ' });
    // Retired delivery callbacks cannot replace the fresh baseline.
    reads.endCell([{ type: 'text', text: old.text }], [old]);
    const current = { ...params, readId: fresh.readId };
    const complete = reads.assertCurrent('click', current, 'next-turn');
    const action = await f.client.click(current, current.args); complete();
    assert.equal(action.generation, f.children.length, row.task);
    assert.equal(f.requests.at(-1).params.readId, 1); actions++;
    old = fresh;
  }
  assert.ok(f.requests.filter(request => request.method === 'getAXState').every(request => !('readId' in request.params)));
  return { actions, stale, helpers: f.children.length, exits: f.children.filter(c => c.signals.length).length };
}
test('recorded bank crosses 90 turn-end exits with colliding native IDs and generation refusals', async t => {
  clock(t);
  assert.deepEqual(await crossTurnReplay(t), { actions: 90, stale: 90, helpers: 91, exits: 90 });
  t.diagnostic('Cross-turn replay: 90 generation refusals before native dispatch after fresh delivery, 90 successful actions, 91 helpers, 90 exits; native read ID 1 in every helper. No native input or tree remapping.');
});
test('retirement notifies once on idle exit, explicit restart and unexpected helper exit', async t => {
  clock(t); const f = fixture(t), reasons = [];
  f.client.onRetire(error => reasons.push(error.code));
  await f.client.ping(); f.client.endTurn(); t.mock.timers.tick(60); await tick();
  await f.client.ping(); await f.client.restart();
  await f.client.ping(); f.children.at(-1).emit('close'); await tick();
  assert.deepEqual(reasons, ['DRIVER_RESTARTED', 'DRIVER_RESTARTED', 'DRIVER_EXIT']);
});
test('turn-end deadline includes the time spent waiting for cell and lease cleanup', async t => {
  clock(t); const f = fixture(t); await f.client.ping();
  let finish; const after = new Promise(resolve => { finish = resolve; });
  f.client.endTurn({ after }); t.mock.timers.tick(59); await tick();
  assert.deepEqual(f.children[0].signals, []); finish(); await tick();
  t.mock.timers.tick(1); await tick(); assert.deepEqual(f.children[0].signals, ['SIGTERM']);
});
test('failed or overtaken turn cleanup cannot retire the helper', async t => {
  clock(t); const f = fixture(t); await f.client.ping();
  let finish; const after = new Promise(resolve => { finish = resolve; });
  f.client.endTurn({ after }); f.client.beginTurn(); finish(); await tick();
  t.mock.timers.tick(120000); await tick(); assert.deepEqual(f.children[0].signals, []);
  f.client.endTurn({ after: Promise.reject(Error('CLEANUP_FAILED')) }); await tick();
  t.mock.timers.tick(120000); await tick(); assert.deepEqual(f.children[0].signals, []);
});

const sourceURL = new URL('../plugins/sleight/lib/driver-client.mjs', import.meta.url);
async function brokenClient(from, to, prefix = '') {
  let source = readFileSync(sourceURL, 'utf8');
  for (const [before, after] of typeof from === 'string' ? [[from, to]] : from) {
    assert.equal(source.split(before).length, 2, 'mutation matches exactly once'); source = source.replace(before, after);
  }
  const changed = (prefix + source).replace(/from '(\.\.?\/[^']+)'/g,
    (_, path) => `from '${new URL(path, sourceURL).href}'`);
  return (await import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'))).createMacDriverClient;
}
test('broken request cancellation is detected by the same-turn identity assertion', async t => {
  clock(t); const factory = await brokenClient('if (idleBoundary?.ready !== false) cancelIdleExit();', 'void idleBoundary;');
  const f = fixture(t, { factory }); await f.client.ping(); f.client.endTurn();
  await f.client.getAXState('7', { processStart: '1.2' }); t.mock.timers.tick(60); await tick();
  assert.throws(() => assert.deepEqual(f.children[0].signals, []), assert.AssertionError);
});
test('broken in-flight protection is detected before a reply can be lost', async t => {
  clock(t);
  const factory = await brokenClient([
    ['idleDeadline === undefined || idleBoundary?.ready === false || activeRequests || starting || disposed', 'idleDeadline === undefined || disposed'],
    ['if (idleBoundary?.ready === false || activeRequests || starting || generation !== g', 'if (generation !== g'],
  ]);
  const f = fixture(t, { factory }); await f.client.ping(); f.hold('getState');
  const pending = f.client.getState().catch(error => error); await tick(); f.client.endTurn();
  t.mock.timers.tick(60); await tick();
  assert.throws(() => assert.deepEqual(f.children[0].signals, []), assert.AssertionError);
  assert.equal((await pending).code, 'DRIVER_RESTARTED');
});
test('broken failure memoization is detected after a turn-end exit', async t => {
  clock(t); const factory = await brokenClient('if (mac && unavailable && Date.now() < unavailable.until)', 'if (false)');
  const f = fixture(t, { factory }); await f.client.ping(); f.client.endTurn(); t.mock.timers.tick(60); await tick(); f.fail('HOST_BUILD_FAILED');
  await assert.rejects(f.client.ping()); await assert.rejects(f.client.ping());
  assert.throws(() => assert.equal(f.prepares, 2), assert.AssertionError);
});
test('broken global timer ownership is detected across two servers', async t => {
  clock(t); const factory = await brokenClient('  let idleTimer, idleDeadline, idleBoundary, activeRequests = 0;\n', '', 'let idleTimer, idleDeadline, idleBoundary, activeRequests = 0;\n');
  const a = fixture(t, { factory }), b = fixture(t, { factory }); await a.client.ping(); await b.client.ping();
  a.client.endTurn(); await b.client.ping(); t.mock.timers.tick(60); await tick();
  assert.throws(() => assert.deepEqual(a.children[0].signals, ['SIGTERM']), assert.AssertionError);
});
test('broken idle exits inside a turn are detected without a turn-end boundary', async t => {
  clock(t); const factory = await brokenClient('activeRequests--; scheduleIdleExit();',
    'activeRequests--; idleDeadline ??= Date.now() + turnEndIdleMs; scheduleIdleExit();');
  const f = fixture(t, { factory }); await f.client.ping(); t.mock.timers.tick(60); await tick();
  assert.throws(() => assert.deepEqual(f.children[0].signals, []), assert.AssertionError);
});

test('broken retirement notification silences the subscribed parent observer', async t => {
  clock(t); const factory = await brokenClient('listener(error);', 'void error;');
  const f = fixture(t, { factory }); let calls = 0;
  f.client.onRetire(() => { calls++; }); await f.client.ping(); await f.client.restart();
  assert.throws(() => assert.equal(calls, 1), assert.AssertionError);
});
test('cleanup requests preserve the deadline while the turn-end barrier is pending', async t => {
  clock(t); const f = fixture(t); await f.client.ping();
  let finish; const after = new Promise(resolve => { finish = resolve; });
  f.client.endTurn({ after }); await f.client.ping(); t.mock.timers.tick(61); await tick();
  assert.deepEqual(f.children[0].signals, []); finish(); await tick();
  t.mock.timers.tick(0); await tick(); assert.deepEqual(f.children[0].signals, ['SIGTERM']);
});

test('broken cleanup activity cancellation is detected after the turn deadline', async t => {
  clock(t); const factory = await brokenClient('if (idleBoundary?.ready !== false) cancelIdleExit();', 'cancelIdleExit();');
  const f = fixture(t, { factory }); await f.client.ping();
  let finish; const after = new Promise(resolve => { finish = resolve; });
  f.client.endTurn({ after }); await f.client.ping(); t.mock.timers.tick(61); finish(); await tick();
  t.mock.timers.tick(0); await tick();
  assert.throws(() => assert.deepEqual(f.children[0].signals, ['SIGTERM']), assert.AssertionError);
});

test('retirement observers can detach without affecting collection', async t => {
  clock(t); const f = fixture(t); let calls = 0;
  const detach = f.client.onRetire(() => { calls++; });
  await f.client.ping(); detach(); await f.client.restart();
  assert.equal(calls, 0); assert.deepEqual(f.children[0].signals, ['SIGTERM']);
});

const generationCheck = 'if (!Number.isSafeInteger(publicRead) || nativeRead < 1)';
for (const scenario of [collidingHandle, crossTurnReplay]) test(`broken generation check fails ${scenario.name}`, async t => {
  clock(t); const factory = await brokenClient(generationCheck, 'if (false)');
  await assert.rejects(scenario === collidingHandle ? scenario(t, factory) : scenario(t, { factory }), error =>
    error instanceof assert.AssertionError && /generation check|generation refusal/.test(error.message));
});

async function actionRetirement(t, mode, factory) {
  const f = fixture(t, { factory, readStart: () => 0, turnEndIdleMs: 0 });
  const reads = createMacReadState(); f.client.onRetire(() => reads.reset());
  const read = async () => reads.read({ ...await f.client.getAXState('7', { processStart: '1.2' }), window });
  const old = await read(); reads.endCell([{ type: 'text', text: old.text }], [old]);
  const params = { windowId: '7', processStart: '1.2', readId: old.readId, args: [1] };
  f.hold('click'); const pending = f.client.click(params, params.args).catch(error => error); await tick();
  assert.equal(f.requests.filter(row => row.method === 'click').length, 1);
  if (mode === 'restart') await f.client.restart();
  else { f.children[0].emit('close'); await tick(); }
  assert.equal(reads.fullTree(params), undefined, 'parent read state is empty after retirement');
  const error = await pending;
  assert.equal(error.code, mode === 'restart' ? 'DRIVER_RESTARTED' : 'DRIVER_EXIT');
  assert.equal(error.delivery, 'unknown', 'a lost action reply cannot prove non-delivery');
  assert.equal(error.retry, 'read-first');
  f.release(); await tick(); // A retired reply must never rehydrate parent state.
  assert.equal(reads.fullTree(params), undefined);
  const fresh = await read(); reads.endCell([{ type: 'text', text: fresh.text }], [fresh]);
  const sent = f.requests.length;
  await assert.rejects(f.client.click(params, params.args), { code: 'STALE_READ', delivery: 'not-sent' });
  assert.equal(f.requests.length, sent, 'old action is never dispatched to the replacement');
  assert.throws(() => reads.assertCurrent('click', params, 'next'), { code: 'STALE_READ' });
  const current = { ...params, readId: fresh.readId };
  const complete = reads.assertCurrent('click', current, 'next');
  await f.client.click(current, current.args); complete();
  assert.equal(f.requests.at(-1).params.readId, 1);
  assert.equal(f.children.length, 2);
}
for (const mode of ['restart', 'crash']) {
  test(`${mode} with an action in flight loses its reply, clears parent state and refuses colliding IDs`, async t => {
    clock(t); await actionRetirement(t, mode);
  });
  test(`broken action delivery disposition fails the ${mode} race`, async t => {
    clock(t); const factory = await brokenClient("error, { delivery: 'unknown', retry: 'read-first' }) : error", "error, { delivery: 'not-sent', retry: 'safe' }) : error");
    await assert.rejects(actionRetirement(t, mode, factory), error =>
      error instanceof assert.AssertionError && /lost action reply/.test(error.message));
  });
  test(`broken parent reset fails the ${mode} race`, async t => {
    clock(t); const factory = await brokenClient('listener(error);', 'void error;');
    await assert.rejects(actionRetirement(t, mode, factory), error =>
      error instanceof assert.AssertionError && /parent read state/.test(error.message));
  });
}

async function doubleRestart(t, factory, middleRead = true) {
  const f = fixture(t, { factory, readStart: () => 0, turnEndIdleMs: 0 });
  const reads = createMacReadState(), snapshots = [];
  f.client.onRetire(() => reads.reset());
  const read = async () => {
    const snapshot = reads.read({ ...await f.client.getAXState('7', { processStart: '1.2' }), window });
    reads.endCell([{ type: 'text', text: snapshot.text }], [snapshot]); return snapshot;
  };
  snapshots.push(await read()); await f.client.restart();
  assert.equal(reads.fullTree(window), undefined);
  if (middleRead) snapshots.push(await read()); else await f.client.ping();
  await f.client.restart(); await f.client.restart();
  assert.equal(reads.fullTree(window), undefined);
  const fresh = await read();
  const sent = f.requests.length;
  for (const old of snapshots) {
    const params = { windowId: '7', processStart: '1.2', readId: old.readId, args: [1] };
    await assert.rejects(f.client.click(params, params.args), { code: 'STALE_READ', delivery: 'not-sent' });
    assert.equal(f.requests.length, sent, 'two restarts cannot dispatch an old handle');
    assert.throws(() => reads.assertCurrent('click', params, 'third'), { code: 'STALE_READ' });
    reads.endCell([{ type: 'text', text: old.text }], [old]);
  }
  const params = { windowId: '7', processStart: '1.2', readId: fresh.readId, args: [1] };
  reads.assertCurrent('click', params, 'third'); await f.client.click(params, params.args);
  assert.equal(f.requests.at(-1).params.readId, 1); assert.equal(f.children.length, 3);
}
for (const middleRead of [true, false]) test(`two consecutive restarts with middle read=${middleRead} keep old IDs retired`, async t => {
  clock(t); await doubleRestart(t, undefined, middleRead);
});
test('broken generation check fails two consecutive restarts', async t => {
  clock(t); const factory = await brokenClient(generationCheck, 'if (false)');
  await assert.rejects(doubleRestart(t, factory), error =>
    error instanceof assert.AssertionError && /two restarts/.test(error.message));
});

test('every action and retained-map request translates public read IDs only in the current helper', async t => {
  clock(t); const f = fixture(t, { readStart: () => 0,
    reply: (request, readId) => ['resolveElement', 'settle', 'click'].includes(request.method) ? { readId } : {} });
  const old = await f.client.getAXState('7', { processStart: '1.2' }); await f.client.restart();
  const fresh = await f.client.getAXState('7', { processStart: '1.2' });
  assert.equal(fresh.readId, 2);
  const binding = { windowId: '7', processStart: '1.2' };
  for (const method of [...DRIVER_ACTION_METHODS, 'resolveElement']) {
    const args = ['setValue', 'selectText'].includes(method) ? [1, 'text'] : method === 'performSecondaryAction' ? [1, 'press'] : method === 'paste' ? ['text'] : [1];
    const sent = f.requests.length;
    await assert.rejects(f.client.request(method, { ...binding, readId: old.readId, args }), { code: 'STALE_READ', delivery: 'not-sent' });
    assert.equal(f.requests.length, sent, method);
  }
  for (const [method, key] of [['click', 'readId'], ['resolveElement', 'readId'], ['settle', 'afterReadId']]) {
    const params = { ...binding, [key]: fresh.readId, ...method === 'settle' ? {} : { args: [1] } };
    const result = await f.client.request(method, params);
    assert.equal(f.requests.at(-1).params[key], 1); assert.equal(params[key], 2); assert.equal(result.readId, 2);
    const sent = f.requests.length;
    await assert.rejects(f.client.request(method, { ...params, [key]: old.readId }), { code: 'STALE_READ', delivery: 'not-sent' });
    assert.equal(f.requests.length, sent);
  }
});

async function listenerFailure(t, factory) {
  const f = fixture(t, { factory }); let resets = 0;
  f.client.onRetire(() => { throw Error('RESET_FAILED'); });
  f.client.onRetire(() => { resets++; });
  await f.client.ping(); await f.client.restart();
  assert.equal(resets, 1, 'remaining reset listeners still run');
  await assert.rejects(f.client.ping(), { code: 'DRIVER_UNHEALTHY', delivery: 'not-sent' });
  await f.client.restart();
  await assert.rejects(f.client.ping(), { code: 'DRIVER_UNHEALTHY', delivery: 'not-sent' });
  assert.equal(f.children.length, 1);
}
test('a throwing retirement listener permanently blocks new dispatch', async t => { clock(t); await listenerFailure(t); });
test('broken listener failure handling is detected before a new helper starts', async t => {
  clock(t); const factory = await brokenClient("catch { retirementFailure ??= Object.assign(fault('DRIVER_UNHEALTHY', undefined, true), { delivery: 'not-sent', retry: 'safe' }); }", 'catch {}');
  await assert.rejects(listenerFailure(t, factory), assert.AssertionError);
});

async function cleanupStartup(t, factory) {
  const f = fixture(t, { factory }); let finish;
  const after = new Promise(resolve => { finish = resolve; });
  f.client.endTurn({ after }); await f.client.ping();
  t.mock.timers.tick(61); await tick(); assert.deepEqual(f.children[0].signals, []);
  finish(); await tick(); t.mock.timers.tick(0); await tick();
  assert.deepEqual(f.children[0].signals, ['SIGTERM'], 'a helper started by cleanup still retires');
}
test('cleanup can start a helper after an empty turn boundary without leaving it running', async t => { clock(t); await cleanupStartup(t); });
test('broken empty-helper turn boundary leaves a cleanup helper running', async t => {
  clock(t); const factory = await brokenClient('if (disposed || !turnEndIdleMs) return;', 'if (disposed || !turnEndIdleMs || !generation && !starting) return;');
  await assert.rejects(cleanupStartup(t, factory), error => error instanceof assert.AssertionError && /still retires/.test(error.message));
});

test('malformed native read IDs and public-ID overflow retire before a number can escape', async t => {
  for (const readId of [0, -1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture(t, { readStart: () => 0, reply: () => ({ readId }) });
    await assert.rejects(f.client.getAXState('7', { processStart: '1.2' }), { code: 'DRIVER_PROTOCOL' });
    assert.deepEqual(f.children[0].signals, ['SIGTERM']);
  }
  const f = fixture(t, { readStart: generation => generation === 1 ? Number.MAX_SAFE_INTEGER - 1 : 0 });
  assert.equal((await f.client.getAXState('7', { processStart: '1.2' })).readId, Number.MAX_SAFE_INTEGER);
  await f.client.restart();
  await assert.rejects(f.client.getAXState('7', { processStart: '1.2' }), { code: 'DRIVER_PROTOCOL' });
});
test('broken public reply translation admits the colliding parent handle', async t => {
  clock(t); const factory = await brokenClient('value.result.readId = publicRead;', 'value.result.readId = nativeRead;');
  await assert.rejects(collidingHandle(t, factory), assert.AssertionError);
});
test('broken request translation refuses a fresh action at the native map', async t => {
  clock(t); const factory = await brokenClient('params[key] = nativeRead;', 'void nativeRead;');
  await assert.rejects(collidingHandle(t, factory), { code: 'STALE_READ' });
});
test('broken afterReadId translation fails settle after a colliding restart', async t => {
  clock(t); const factory = await brokenClient("for (const key of ['readId', 'afterReadId'])", "for (const key of ['readId'])");
  const f = fixture(t, { factory, readStart: () => 0 });
  await f.client.getAXState('7', { processStart: '1.2' }); await f.client.restart();
  const fresh = await f.client.getAXState('7', { processStart: '1.2' });
  await assert.rejects(f.client.request('settle', { windowId: '7', processStart: '1.2', afterReadId: fresh.readId }), { code: 'STALE_READ' });
});


for (const key of ['readId', 'afterReadId']) for (const array of [false, true])
test(`INT22L nested ${key} in a ${array ? 'list' : 'map'} result retires the helper`, async t => {
  const f = fixture(t, { reply: request => request.method === 'getAXState' ? {
    compound: array ? [{ [key]: 1 }] : { [key]: 1 },
  } : {} });
  await assert.rejects(f.client.getAXState('7'), { code: 'DRIVER_PROTOCOL', unhealthy: true });
  assert.equal(f.children[0].signals.length, 1);
});
for (const key of ['readId', 'afterReadId'])
test(`INT22L nested request ${key} is refused before native dispatch`, async t => {
  const f = fixture(t); await f.client.ping();
  const before = f.requests.length;
  await assert.rejects(f.client.request('getState', { compound: [{ [key]: 1 }] }), { code: 'INVALID_PARAMS' });
  assert.equal(f.requests.length, before);
});
