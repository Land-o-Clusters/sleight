import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { createDriverClient } from '../plugins/sleight/lib/driver-client.mjs';
import { createMacSafety } from '../plugins/sleight/lib/mac-safety.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { prepareMacInputRegistrar } from '../plugins/sleight/lib/mac-driver/input-registrar.mjs';

// Mutations are loaded from memory. No repository source is modified.
async function changedModule(path, from, to) {
  const url = new URL(path, import.meta.url);
  let source = await readFile(url, 'utf8');
  assert.ok(source.includes(from), `missing mutation anchor: ${from}`);
  source = source.replace(from, to).replace(/from (['"])(\.\.?\/[^'"]+)\1/g,
    (_all, quote, specifier) => `from ${quote}${new URL(specifier, url).href}${quote}`);
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
const window = { windowId: '42', processStart: '100.25', pid: 321, bundleId: 'test.wait', app: 'Wait',
  title: 'Fixture', bounds: { x: 0, y: 0, width: 100, height: 100 }, identityVerified: true, onScreen: true, minimized: false };
const binding = { windowId: window.windowId, processStart: window.processStart };
const refusal = code => Object.assign(Error(code), { code, parentSafety: true, delivery: 'not-sent', retry: 'safe' });

async function parentCase(t, kind, makeSafety = createMacSafety) {
  let paused = false, blocked = false, posts = 0, renewed = 0, cancelled = 0, waiting;
  const waitingForInput = new Promise(resolve => { waiting = resolve; });
  const driver = { ping: async () => ({ build: 'b'.repeat(64) }), cancelPending() { cancelled++; },
    async request(method, params, options) {
      if (method === 'inputGateState') return { enabled: true };
      if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app, pid: window.pid, processStart: window.processStart }, windows: [window] };
      if (method === 'verifyWindowIdentity') return { window };
      if (method === 'personState') return { token: 'token', personTookOver: kind === 'takeover', reason: kind === 'takeover' ? 'person-took-over' : 'quiet' };
      if (method === 'click') {
        waiting();
        if (kind === 'pause') paused = true;
        if (kind === 'approval') blocked = true;
        if (kind === 'revoke') parent.revoke([window.bundleId]);
        if (kind === 'lease') renewed = -100;
        await options?.beforeInput?.();
        posts++;
        return { window, delivery: 'sent-unverified', waitedForPersonMs: 1200, personWaitCapMs: 4849 };
      }
      return { window, text: 'Window: Fixture\n0 standard window\n\t1 button Press', readId: 1 };
    } };
  const parent = makeSafety({ driver, inputRegistrar: await prepareMacInputRegistrar(driver, 'b'.repeat(64)),
    lease: { acquire: () => 'lease', renew() { if (renewed < 0) throw Error('expired'); renewed++; }, release() {}, close() {} },
    approve: async () => true, policy: () => ({ allow: true }), targetParents: () => [1], ancestry: () => [{ pid: 900, path: '/usr/bin/node' }],
    permissions: { app: () => blocked ? 'revoked' : undefined, page() {}, sitesLimited: () => false } });
  parent.setPolicy({ checkPause() { if (paused) throw refusal('PAUSED'); },
    beforeAction: async ({ args, personToken }) => ({ args, personToken }) });
  t.after(() => parent.close());
  await parent.request('getApp', { selector: 'Wait' });
  const result = await parent.request('click', { ...binding, readId: 1, args: [1] }).then(value => ({ value }), error => ({ error: { code: error.code, delivery: error.delivery } }));
  if (kind !== 'takeover') await waitingForInput;
  return { ...result, posts, renewed, cancelled };
}
for (const [kind, code] of [['pause', 'PAUSED'], ['approval', 'APP_BLOCKED'], ['revoke', 'REPL_CELL_ENDED'], ['lease', 'LEASE_REFUSED']])
  test(`UC2B2 parent rechecks ${kind} after quiet and before input`, async t => {
    const r = await parentCase(t, kind);
    assert.equal(r.error?.code, code);
    assert.equal(r.posts, 0);
    if (kind === 'revoke') assert.equal(r.cancelled, 1);
  });
test('UC2B2 unchanged parent grant renews the lease and admits once', async t => {
  const r = await parentCase(t, 'quiet');
  assert.equal(r.error, undefined); assert.equal(r.posts, 1); assert.ok(r.renewed >= 4);
});
test('broken variant detected: parent skips the post-wait Pause and approval checkpoint', async t => {
  const broken = await changedModule('../plugins/sleight/lib/mac-safety.mjs', 'beforeInput: async () => {', 'unused: async () => {');
  for (const kind of ['pause', 'approval']) {
    const r = await parentCase(t, kind, broken.createMacSafety);
    assert.equal(r.posts, 1); if (kind === 'pause') assert.equal(r.error, undefined);
  }
});

async function clientCase(t, { allow = true, cancel = false, missingGuard = false, malformed = false, repeat = false } = {}) {
  let posts = 0, checkpoints = 0, children = 0;
  let release;
  const reached = new Promise(resolve => { release = resolve; });
  const client = createDriverClient({ driverPlatform: 'darwin', platform: 'darwin', requiredMethods: ['ping', 'click'],
    prepare: async () => ({ status: 'ready', spawn({ nonce }) {
      children++;
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      const reply = (r, fields) => child.stdout.write(JSON.stringify({ protocol: r.protocol, platform: 'darwin', nonce, id: r.id, ...fields }) + '\n');
      child.stdin = new Writable({ write(bytes, _encoding, done) {
        const r = JSON.parse(bytes); done();
        if (r.control) {
          if (r.control === 'allow') { posts++; reply(r, { ok: true, result: { delivery: 'sent-unverified', personWaitCapMs: 4849 } }); }
          else reply(r, { ok: false, error: { code: 'PERSON_TOOK_OVER', message: 'cancel', unhealthy: false,
            next: 'stop-tell-user', delivery: 'not-sent', retry: 'safe', waitedForPersonMs: 1000, personWaitCapMs: 4849 } });
          return;
        }
        if (r.method === 'ping') return queueMicrotask(() => reply(r, { ok: true, result: {
          protocol: r.protocol, apiVersion: 2, build: 'b'.repeat(64), methods: ['ping', 'click'] } }));
        queueMicrotask(() => {
          reply(r, { checkpoint: malformed ? 'forged' : 'person-wait' });
          if (repeat) reply(r, { checkpoint: 'person-wait' });
          release();
        });
      } });
      child.kill = () => { queueMicrotask(() => child.emit('close')); return true; };
      return child;
    } }) });
  t.after(() => client.close());
  const action = client.request('click', { args: [1] }, missingGuard ? {} : { beforeInput: async () => {
    checkpoints++;
    if (cancel) client.cancelPending();
    if (!allow) throw refusal('PAUSED');
  } }).then(value => ({ value }), error => ({ error }));
  await Promise.race([reached, action.then(() => { throw Error('Client finished before the person-wait checkpoint'); })]);
  const result = await action;
  if (!malformed && !repeat) await client.ping();
  return { ...result, posts, checkpoints, children };
}
test('UC2B2 client authorizes one authenticated native checkpoint without exposing a tool method', async t => {
  const r = await clientCase(t); assert.equal(r.error, undefined); assert.equal(r.posts, 1); assert.equal(r.checkpoints, 1); assert.equal(r.children, 1);
});
test('UC2B2 denied checkpoint keeps the parent Pause code and native non-delivery receipt', async t => {
  const r = await clientCase(t, { allow: false });
  assert.equal(r.posts, 0); assert.equal(r.error.code, 'PAUSED'); assert.equal(r.error.delivery, 'not-sent');
  assert.equal(r.error.waitedForPersonMs, 1000); assert.equal(r.error.personWaitCapMs, 4849); assert.equal(r.children, 1);
});
test('UC2B2 Stop cancellation cannot be reopened by an in-flight allow callback', async t => {
  const r = await clientCase(t, { cancel: true }); assert.equal(r.posts, 0); assert.equal(r.error.code, 'PERSON_TOOK_OVER'); assert.equal(r.children, 1);
});
test('UC2B2 missing parent guard refuses a native wait checkpoint', async t => {
  const r = await clientCase(t, { missingGuard: true }); assert.equal(r.posts, 0); assert.equal(r.error.code, 'PERSON_TOOK_OVER');
});
for (const options of [{ malformed: true }, { repeat: true }]) test(`UC2B2 invalid checkpoint retires the helper: ${JSON.stringify(options)}`, async t => {
  const r = await clientCase(t, options); assert.equal(r.posts, 0); assert.equal(r.error.code, 'DRIVER_PROTOCOL');
});

async function relayStop(t, factory = createRelay) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const events = [];
  const relay = factory({ clientIn, clientOut, serverIn, serverOut, nativeRuntime: true, nativeMac: true, modHost: () => true, changeReview: false,
    nativeSession: { setPolicy() {}, cancelPending() { events.push('cancel-native'); }, endTurn() {} },
    beginStop() { events.push('begin-stop'); }, stopEngine: async () => ({ collected: true }), inspectInput: async () => ({ ok: true }),
    stopGraceMs: 1, inputLease: { close() {}, release() {} } });
  t.after(() => relay.dispose());
  clientIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'turn_ended', _meta: { 'claudecode/toolUseId': 'toolu_plugin_' + 'a'.repeat(32) }, arguments: { sleight_stop: true } } }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  return events;
}
test('UC2B2 relay interruptTurn cancels native waits before draining running calls', async t => {
  assert.deepEqual((await relayStop(t)).slice(0, 2), ['cancel-native', 'begin-stop']);
});
test('broken variant detected: relay Stop omits native wait cancellation', async t => {
  const broken = await changedModule('../plugins/sleight/lib/relay.mjs', 'nativeSession?.cancelPending?.();', '');
  assert.equal((await relayStop(t, broken.createRelay)).includes('cancel-native'), false);
});

test('UC2B2 parent refuses a previous-call takeover instead of forwarding an unvalidated token', async t => {
  const r = await parentCase(t, 'takeover'); assert.equal(r.error.code, 'PERSON_TOOK_OVER'); assert.equal(r.posts, 0);
});
test('broken variant detected: parent admits a quiet previous-call takeover', async t => {
  const broken = await changedModule('../plugins/sleight/lib/mac-safety.mjs', "person.reason === 'person-active'", "['person-active', 'person-took-over'].includes(person.reason)");
  const r = await parentCase(t, 'takeover', broken.createMacSafety); assert.equal(r.posts, 1);
});
test('UC2B2 client rechecks parent activity after asynchronous helper startup', async t => {
  let active = true, actionWrites = 0, released;
  const blocked = new Promise(resolve => { released = resolve; });
  const client = createDriverClient({ driverPlatform: 'darwin', platform: 'darwin', requiredMethods: ['ping', 'click'],
    prepare: async () => {
      await blocked;
      return { status: 'ready', spawn({ nonce }) {
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.stdin = new Writable({ write(bytes, _encoding, done) {
          const r = JSON.parse(bytes); done();
          if (r.method !== 'ping') { actionWrites++; return; }
          queueMicrotask(() => child.stdout.write(JSON.stringify({ protocol: r.protocol, platform: 'darwin', nonce, id: r.id,
            ok: true, result: { protocol: r.protocol, apiVersion: 2, build: 'a'.repeat(64), methods: ['ping', 'click'] } }) + '\n'));
        } });
        child.kill = () => { queueMicrotask(() => child.emit('close')); return true; }; return child;
      } };
    } });
  t.after(() => client.close());
  const action = client.request('click', { args: [1] }, { checkActive() { if (!active) throw refusal('REPL_CELL_ENDED'); } });
  active = false; client.cancelPending(); released();
  await assert.rejects(action, { code: 'REPL_CELL_ENDED', delivery: 'not-sent' }); assert.equal(actionWrites, 0);
});
