import { fakeReplNode } from './fixtures/repl-node-fake.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createMacDriverClient } from '../plugins/sleight/lib/driver-client.mjs';
import { DRIVER_API_VERSION, DRIVER_CORE_METHODS, DRIVER_ACTION_METHODS, DRIVER_CODES } from '../plugins/sleight/lib/mac-driver/protocol.mjs';
import { prepareMacInputRegistrar } from '../plugins/sleight/lib/mac-driver/input-registrar.mjs';
import { createOwnRuntime } from '../plugins/sleight/lib/runtime-select.mjs';

const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function fixture(t, { release = () => {}, factory = createOwnRuntime } = {}) {
  const events = [], evaluations = [], armed = [], answers = new Map(); let next = 0;
  const runtime = factory({
    driver: { beginTurn() { events.push('begin'); }, async endTurn({ after } = {}) { armed.push(Date.now()); try { await after; events.push('end'); } catch {} },
      async request() { assert.fail('no native calls in lifecycle fixture'); }, async restart() {}, async close() {} },
    lease: { release, close() {} },
    replOptions: { selectNode: fakeReplNode, environment: () => ({}), spawn() {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.connected = true;
      child.kill = () => { child.connected = false; queueMicrotask(() => child.emit('close')); };
      child.send = message => { if (message.type === 'evaluate') evaluations.push(() => child.emit('message',
        { type: 'result', id: message.id, result: { content: [{ type: 'text', text: 'cell finished' }] } })); };
      return child;
    } },
  });
  t.after(() => runtime.close());
  runtime.serverOut.on('data', bytes => { const message = JSON.parse(bytes); answers.get(message.id)?.(message.result); answers.delete(message.id); });
  return { runtime, events, evaluations, armed, call(name) { return new Promise(resolve => {
    const id = ++next; answers.set(id, resolve); runtime.serverIn.write(JSON.stringify({ id, method: 'tools/call',
      params: { name, arguments: name === 'js' ? { code: 'console.log(1)' } : {} } }) + '\n');
  }); } };
}
test('both model and relay turn boundaries arm helper retirement after lease cleanup', async t => {
  const f = fixture(t); await f.call('turn_ended'); await tick(); assert.deepEqual(f.events, ['end']);
  await f.runtime.safety.endTurn(); await tick(); assert.deepEqual(f.events, ['end', 'end']);
});
test('turn_ended returns while a running cell finishes, then arms retirement', async t => {
  const f = fixture(t), cell = f.call('js'); await tick(); assert.equal(f.evaluations.length, 1);
  await f.call('turn_ended'); await tick(); assert.deepEqual(f.events, ['begin']);
  f.evaluations.shift()(); const result = await cell; await tick();
  assert.equal(result.isError, false); assert.deepEqual(f.events, ['begin', 'end']);
});
test('a new cell cancels an earlier turn boundary still waiting on cleanup', async t => {
  let finishCleanup; const f = fixture(t, { release: () => new Promise(resolve => { finishCleanup = resolve; }) });
  const ending = f.call('turn_ended'); await tick();
  const cell = f.call('js'); await tick(); finishCleanup(); await ending; await tick();
  assert.deepEqual(f.events, ['begin']);
  f.evaluations.shift()(); await cell; await tick(); assert.deepEqual(f.events, ['begin']);
});
test('failed turn cleanup does not arm helper retirement', async t => {
  const f = fixture(t, { release() { throw Error('CLEANUP_FAILED'); } });
  const result = await f.call('turn_ended'); await tick();
  assert.equal(result.isError, true); assert.deepEqual(f.events, []);
});

async function brokenRuntime(from, to) {
  const url = new URL('../plugins/sleight/lib/runtime-select.mjs', import.meta.url);
  const source = readFileSync(url, 'utf8'); assert.equal(source.split(from).length, 2);
  const changed = source.replace(from, to).replace(/from '(\.\.?\/[^']+)'/g, (_, path) => `from '${new URL(path, url).href}'`);
  return (await import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'))).createOwnRuntime;
}
test('broken cell-finish wait is detected while turn_ended leaves the cell running', async t => {
  const factory = await brokenRuntime('Promise.all([ending, ...activeCells])', 'Promise.all([ending])');
  const f = fixture(t, { factory }), cell = f.call('js'); await tick(); await f.call('turn_ended'); await tick();
  assert.throws(() => assert.deepEqual(f.events, ['begin']), assert.AssertionError);
  f.evaluations.shift()(); await cell;
});
test('broken boundary cancellation is detected when a newer cell starts during cleanup', async t => {
  const factory = await brokenRuntime('!closed && turn === helperTurn', '!closed');
  let finishCleanup; const f = fixture(t, { factory, release: () => new Promise(resolve => { finishCleanup = resolve; }) });
  const ending = f.call('turn_ended'); await tick(); const cell = f.call('js'); await tick();
  finishCleanup(); await ending; await tick();
  assert.throws(() => assert.deepEqual(f.events, ['begin']), assert.AssertionError);
  f.evaluations.shift()(); await cell;
});

const readWindow = { windowId: '7', pid: 123, processStart: '1.2', bundleId: 'com.example.Fixture',
  app: 'Fixture', title: 'Fixture', identityVerified: true, bounds: { x: 0, y: 0, width: 800, height: 600 }, onScreen: true, minimized: false };
const tree = 'Window: "Fixture", App: Fixture.\n0 window Fixture\n\t1 button Seven';
async function readFixture(t, { factory = createOwnRuntime, readStart = generation => generation === 1 ? 4 : 0, realSafety = false, realInput = false, driverFactory = createMacDriverClient } = {}) {
  const children = [], native = [], replies = [], answers = new Map();
  let proposal, next = 0, holdMethod, held, cards = 0, renewals = 0, acquisitions = 0;
  const driver = driverFactory({ platform: 'darwin', turnEndIdleMs: 60,
    prepare: async () => ({ status: 'ready', build: 'b'.repeat(64), spawn({ nonce }) {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.signals = [];
      let readId = readStart(children.length + 1);
      child.stdin = new Writable({ write(bytes, _, done) {
        const request = JSON.parse(bytes); native.push(request); done();
        const result = request.method === 'ping' ? { protocol: request.protocol, apiVersion: DRIVER_API_VERSION,
          build: 'b'.repeat(64), methods: [...DRIVER_CORE_METHODS, ...DRIVER_ACTION_METHODS, 'rendererRestore', 'personState', 'inputGateState'] } :
          request.method === 'resolveApp' ? { app: { id: readWindow.bundleId, name: readWindow.app, pid: readWindow.pid,
            processStart: readWindow.processStart, path: '/Applications/Fixture.app' }, windows: [readWindow] } :
          request.method === 'verifyWindowIdentity' ? { window: readWindow } :
          request.method === 'rendererRestore' ? { restored: true, token: request.params.args[0].lease.token } :
          request.method === 'personState' ? { token: 'person', personTookOver: false } :
          request.method === 'inputGateState' ? { enabled: true } :
          request.method === 'click' ? { window: readWindow, delivery: 'sent-verified' } :
          request.method === 'getAXState' ? { text: tree, window: readWindow, readId: ++readId } : {};
        const stale = request.params.readId !== undefined && request.params.readId !== readId;
        const respond = () => child.stdout.write(JSON.stringify({ protocol: request.protocol, platform: 'darwin',
          nonce, id: request.id, ok: !stale, ...stale ? { error: { code: 'STALE_READ', message: 'Read again.',
            next: DRIVER_CODES.STALE_READ.next, unhealthy: false, delivery: 'not-sent', retry: 'safe' } } : { result } }) + '\n');
        if (request.method === holdMethod) held = respond; else queueMicrotask(respond);
      } });
      child.kill = signal => { child.signals.push(signal ?? 'SIGTERM'); queueMicrotask(() => child.emit('close')); };
      children.push(child); return child;
    } }),
  });
  const inputRegistrar = realInput ? await prepareMacInputRegistrar(driver, 'b'.repeat(64)) : undefined;
  const runtime = factory({ driver, inputRegistrar,
    approve() { cards++; return true; }, policy: () => ({ allow: true, riskLevel: 'high' }),
    targetParents: () => [1], ancestry: () => [{ pid: 500, path: '/Applications/FixtureHost.app/Contents/MacOS/Host' }],
    permissions: { app() {}, page() {}, sitesLimited: () => false },
    lease: { release() {}, close() {}, acquire() { acquisitions++; return 'fixture'; },
      renew() { renewals++; }, renewGrant() { renewals++; }, grant: () => ({ token: 'lease-token' }) },
    replOptions: { selectNode: fakeReplNode, environment: () => ({}), spawn() {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.connected = true;
      let evaluation, awaiting = 0;
      child.kill = () => { child.connected = false; queueMicrotask(() => child.emit('close')); };
      child.send = message => {
        if (message.type === 'evaluate') {
          evaluation = message.id;
          const proposals = Array.isArray(proposal) ? proposal : [proposal]; awaiting = proposals.length;
          for (const [index, item] of proposals.entries())
            queueMicrotask(() => child.emit('message', { type: 'driver', cell: evaluation, id: index + 1, ...item }));
        } else if (message.type === 'driver-result') {
          replies.push(message);
          if (--awaiting) return;
          child.emit('message', { type: 'result', id: evaluation,
            result: { content: [{ type: 'text', text: message.result?.text ?? message.error?.code ?? 'action' }], isError: !!message.error } });
        }
      };
      return child;
    } },
  });
  // Number-state fixtures replace the safety dispatcher and keep the real
  // parent reads, delivery acknowledgment, client and retirement path. Separate
  // realSafety fixtures retain approval, lease and internal-read admission.
  if (!realSafety) runtime.safety.request = (method, params, context) => {
    context.beforeRequest(); return driver.request(method, params);
  };
  runtime.serverOut.on('data', bytes => {
    const message = JSON.parse(bytes); runtime.safety.guardResult(message);
    const result = runtime.safety.displayResult(message.id, message.result);
    runtime.safety.recordDelivery(result); answers.get(message.id)(result); answers.delete(message.id);
  });
  t.after(() => runtime.close());
  return { driver, runtime, children, native, replies, get cards() { return cards; },
    get renewals() { return renewals; }, get acquisitions() { return acquisitions; }, hold(method) { holdMethod = method; },
    release() { holdMethod = undefined; held?.(); }, call(method, params) {
    proposal = Array.isArray(method) ? method : { method, params };
    return new Promise(resolve => {
      const id = ++next; answers.set(id, resolve);
      runtime.serverIn.write(JSON.stringify({ id, method: 'tools/call',
        params: { name: 'js', arguments: { code: 'console.log(1)' } } }) + '\n');
    });
  } };
}
async function assertClearedBindings(f) {
  const sent = f.native.length;
  await f.runtime.localServices.stuckEscape.check({ appId: readWindow.bundleId, title: readWindow.title, windowNumber: '7' });
  assert.equal(f.native.length, sent, 'retired window bindings cannot reach the helper');
}
async function restartReadScenario(t, factory, retire = 'idle') {
  const f = await readFixture(t, { factory });
  assert.equal((await f.call('getAXState', { windowId: '7', processStart: '1.2' })).isError, false);
  assert.equal(f.replies.at(-1).result.readId, 5);
  if (retire === 'idle') { await f.runtime.safety.endTurn(); await tick(); t.mock.timers.tick(60); await tick(); }
  else if (retire === 'restart') await f.driver.restart();
  else { f.children[0].emit('close'); await tick(); }
  assert.deepEqual(f.children[0].signals, retire === 'exit' ? [] : ['SIGTERM']);
  await assertClearedBindings(f);
  const oldAction = { windowId: '7', processStart: '1.2', readId: 5, args: [1] };
  await f.call('click', oldAction); assert.equal(f.replies.at(-1).error?.code, 'STALE_READ');
  assert.equal(f.native.filter(request => request.method === 'click').length, 0);
  const nextRead = await f.call('getAXState', { windowId: '7', processStart: '1.2' });
  assert.equal(nextRead.isError, false, JSON.stringify(nextRead));
  assert.equal(f.replies.at(-1).result.readId, 6);
  await f.call('click', oldAction); assert.equal(f.replies.at(-1).error?.code, 'STALE_READ');
  assert.equal(f.native.filter(request => request.method === 'click').length, 0);
  await f.call('click', { ...oldAction, readId: 6 });
  assert.equal(f.replies.at(-1).error, undefined);
  assert.equal(f.native.filter(request => request.method === 'click').length, 1);
}
test('parent translates native read 1 after read 5 and an idle exit, refusing the old number before native dispatch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  await restartReadScenario(t);
});

test('driver generation checks also protect idle exits when the parent reset is omitted', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const factory = await brokenRuntime('const detachRetirement = driver.onRetire?.(() => {', 'const detachRetirement = (() => {');
  await restartReadScenario(t, factory);
});

for (const retire of ['restart', 'exit']) test(`parent drops delivered numbers on helper ${retire} within a turn`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  await restartReadScenario(t, undefined, retire);
});
async function boundaryTimestamp(t, factory) {
  let finish;
  const f = fixture(t, { factory, release: () => new Promise(resolve => { finish = resolve; }) });
  const ending = f.runtime.safety.endTurn(); await tick();
  assert.deepEqual(f.armed, [100000]);
  t.mock.timers.tick(61); assert.deepEqual(f.events, []);
  finish(); await ending; await tick(); assert.deepEqual(f.events, ['end']);
}
test('parent starts the exit deadline at turn end before lease cleanup completes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  await boundaryTimestamp(t);
});
test('broken delayed arming is detected at the turn boundary', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const factory = await brokenRuntime('driver.endTurn?.({ after });', 'after.then(() => driver.endTurn?.()).catch(() => {});');
  await assert.rejects(boundaryTimestamp(t, factory), assert.AssertionError);
});

test('broken parent reset leaves stale window bindings after explicit restart', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const factory = await brokenRuntime('const detachRetirement = driver.onRetire?.(() => {', 'const detachRetirement = (() => {');
  await assert.rejects(restartReadScenario(t, factory, 'restart'), assert.AssertionError);
});

async function runtimeActionRace(t, mode, factory) {
  const f = await readFixture(t, { factory, readStart: () => 0 });
  await f.call('getAXState', { windowId: '7', processStart: '1.2' });
  const old = f.replies.at(-1).result.readId;
  const params = { windowId: '7', processStart: '1.2', readId: old, args: [1] };
  f.hold('click');
  const cell = f.call([{ method: 'click', params }, { method: 'click', params }]); await tick();
  assert.equal(f.native.filter(row => row.method === 'click').length, 1);
  if (mode === 'restart') await f.driver.restart();
  else { f.children[0].emit('close'); await tick(); }
  await cell;
  const [lost, queued] = f.replies.slice(-2);
  assert.equal(lost.error?.code, mode === 'restart' ? 'DRIVER_RESTARTED' : 'DRIVER_EXIT');
  assert.equal(lost.error?.delivery, 'unknown'); assert.equal(lost.error?.retry, 'read-first');
  assert.equal(queued.error?.code, 'REPL_CELL_ENDED', 'queued work must fail on the parent generation check');
  assert.equal(queued.error?.delivery, 'not-sent');
  f.release(); await tick(); await assertClearedBindings(f);
  await f.call('getAXState', { windowId: '7', processStart: '1.2' });
  const fresh = f.replies.at(-1).result.readId;
  assert.equal(fresh, 2);
  const sent = f.native.length;
  await f.call('click', params);
  assert.equal(f.replies.at(-1).error?.code, 'STALE_READ');
  assert.equal(f.native.length, sent, 'the stale action cannot dispatch after replacement delivery');
  await f.call('click', { ...params, readId: fresh });
  assert.equal(f.replies.at(-1).error, undefined);
  assert.deepEqual(f.native.filter(row => row.method === 'click').map(row => row.params.readId), [1, 1]);
  assert.equal(f.children.length, 2);
}
for (const mode of ['restart', 'crash']) {
  test(`runtime ${mode} during input refuses queued work and colliding old handles before dispatch`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 }); await runtimeActionRace(t, mode);
  });
  test(`broken parent generation check fails the runtime ${mode} race`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
    const factory = await brokenRuntime('endReadEpoch(); reads.reset(); documents.clear(); cells.clear(); documentReads.clear(); numberNotices.clear();\n    windows.clear(); mobileScroll.clear();',
      'reads.reset(); documents.clear(); cells.clear(); documentReads.clear(); numberNotices.clear();\n    windows.clear(); mobileScroll.clear();');
    await assert.rejects(runtimeActionRace(t, mode, factory), error =>
      error instanceof assert.AssertionError && /parent generation check/.test(error.message));
  });
}

function requireRetirementNotifications(t, factory = createOwnRuntime) {
  assert.throws(() => {
    const runtime = factory({ driver: { request() {}, async close() {} }, driverOptions: { turnEndIdleMs: 60 },
      lease: { release() {}, close() {} } });
    t.after(() => runtime.close());
  },
    /requires retirement notifications/);
}
test('an opted-in runtime refuses a driver without retirement notifications', t => {
  requireRetirementNotifications(t);
});
test('broken missing-notification assertion accepts an opted-in unsafe driver', async t => {
  const factory = await brokenRuntime("throw new TypeError('Helper turn-end exit requires retirement notifications');", 'void driver;');
  assert.throws(() => requireRetirementNotifications(t, factory), assert.AssertionError);
});
async function detachOnClose(t, factory = createOwnRuntime) {
  let observers = 0;
  const runtime = factory({ driver: {
    onRetire() { observers++; return () => { observers--; }; },
    async request() { assert.fail('no native calls'); }, async restart() {}, async close() {},
  }, lease: { release() {}, close() {} } });
  t.after(() => runtime.close());
  assert.equal(observers, 1); await runtime.close(); assert.equal(observers, 0);
}
test('runtime close detaches its retirement observer', async t => { await detachOnClose(t); });
test('broken observer detachment retains a closed runtime', async t => {
  const factory = await brokenRuntime('detachRetirement?.();\n          clearTimeout(timer);', 'clearTimeout(timer);');
  await assert.rejects(detachOnClose(t, factory), assert.AssertionError);
});

async function runtimeDoubleRestart(t, factory) {
  const f = await readFixture(t, { factory, readStart: () => 0 }), old = [];
  for (let i = 0; i < 2; i++) {
    await f.call('getAXState', { windowId: '7', processStart: '1.2' });
    old.push(f.replies.at(-1).result.readId);
    await f.driver.restart(); await assertClearedBindings(f);
  }
  await f.call('getAXState', { windowId: '7', processStart: '1.2' });
  assert.equal(f.replies.at(-1).result.readId, 3);
  const sent = f.native.length;
  for (const readId of old) {
    await f.call('click', { windowId: '7', processStart: '1.2', readId, args: [1] });
    assert.equal(f.replies.at(-1).error?.code, 'STALE_READ');
    assert.equal(f.native.length, sent);
  }
  await f.call('click', { windowId: '7', processStart: '1.2', readId: 3, args: [1] });
  assert.equal(f.replies.at(-1).error, undefined);
  assert.deepEqual(f.native.filter(row => row.method === 'click').map(row => row.params.readId), [1]);
}
test('runtime clears all bindings through two consecutive restarts with native read ID 1', async t => {
  await runtimeDoubleRestart(t);
});
test('broken parent reset fails two consecutive runtime restarts', async t => {
  const factory = await brokenRuntime('const detachRetirement = driver.onRetire?.(() => {', 'const detachRetirement = (() => {');
  await assert.rejects(runtimeDoubleRestart(t, factory), error =>
    error instanceof assert.AssertionError && /retired window bindings/.test(error.message));
});

for (const retire of ['restart', 'crash', 'idle']) test(`real parent approval and lease admission survives helper ${retire}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const f = await readFixture(t, { realSafety: true, readStart: () => 0 });
  assert.equal((await f.call('getApp', { selector: 'Fixture' })).isError, false);
  assert.equal(f.cards, 1); assert.equal(f.acquisitions, 1); const renewals = f.renewals;
  if (retire === 'restart') await f.driver.restart();
  else if (retire === 'crash') { f.children[0].emit('close'); await tick(); }
  else { await f.runtime.safety.endTurn(); await tick(); t.mock.timers.tick(60); await tick(); }
  await assertClearedBindings(f);
  const result = await f.call(retire === 'idle' ? 'getApp' : 'getAXState',
    retire === 'idle' ? { selector: 'Fixture' } : { windowId: '7', processStart: '1.2' });
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(f.cards, 1, 'retirement preserves the existing session approval');
  assert.equal(f.acquisitions, retire === 'idle' ? 2 : 1);
  assert.ok(f.renewals > renewals, 'the replacement read still renews its lease');
  assert.equal(f.replies.at(-1).result.readId, 2);
});

async function internalReadRetirement(t, driverFactory) {
  const f = await readFixture(t, { driverFactory, realSafety: true, realInput: true, readStart: () => 0 });
  let retire = true;
  f.runtime.safety.setPolicy({ checkPause() {}, reset() {}, endCell() {}, async beforeAction(action) {
    if (retire) {
      retire = false;
      await f.driver.restart();
      // The retired internal read was A:2. Give the replacement a B:2 map.
      await f.driver.getAXState('7', { processStart: '1.2' });
      await f.driver.getAXState('7', { processStart: '1.2' });
    }
    return { args: action.args };
  } });
  assert.equal((await f.call('getApp', { selector: 'Fixture' })).isError, false);
  await f.call('click', { windowId: '7', processStart: '1.2', readId: 1, args: [1] });
  assert.equal(f.replies.at(-1).error?.code, 'STALE_READ');
  assert.equal(f.replies.at(-1).error?.delivery, 'not-sent');
  assert.equal(f.native.filter(row => row.method === 'click').length, 0, 'internal generation refusal precedes native dispatch');
  await assertClearedBindings(f);
  assert.equal((await f.call('getAXState', { windowId: '7', processStart: '1.2' })).isError, false);
  assert.equal(f.cards, 1);
}
test('retirement between the real internal action read and send refuses a colliding native ID', async t => {
  await internalReadRetirement(t);
});
test('broken driver generation check fails between the internal read and native send', async t => {
  const url = new URL('../plugins/sleight/lib/driver-client.mjs', import.meta.url);
  const source = readFileSync(url, 'utf8'), check = 'if (!Number.isSafeInteger(publicRead) || nativeRead < 1)';
  assert.equal(source.split(check).length, 2);
  const changed = source.replace(check, 'if (false)').replace(/from '(\.\.?\/[^']+)'/g,
    (_, path) => `from '${new URL(path, url).href}'`);
  const factory = (await import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'))).createMacDriverClient;
  await assert.rejects(internalReadRetirement(t, factory), error =>
    error instanceof assert.AssertionError && /internal generation refusal/.test(error.message));
});
