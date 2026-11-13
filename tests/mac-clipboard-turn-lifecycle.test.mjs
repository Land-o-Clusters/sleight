import { replWorkerSkip } from './fixtures/repl-requirement.mjs';
import { MOD_META, MOD_ID, MODEL_ID } from './fixtures/mod-attribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { registerHooks } from 'node:module';
// The explicit broken variant models CB1S before either end attribution check.
let mutation;
if (process.env.MB1B_MUTANT === 'end-label-bypass') {
  const relayUrl = new URL('../plugins/sleight/lib/relay.mjs', import.meta.url).href;
  mutation = registerHooks({ load(url, context, next) {
    const loaded = next(url, context);
    if (url !== relayUrl) return loaded;
    let source = loaded.source.toString();
    for (const [before, after] of [
      ['privateFrame && (!modAttributed(msg)', "privateFrame && args.sleight_turbo?.event !== 'end' && (!modAttributed(msg)"],
      ['const modEnd = attributed && modEndFrame(args);', 'const modEnd = modEndFrame(args);'],
    ]) { assert.ok(source.includes(before)); source = source.replace(before, after); }
    return { ...loaded, source };
  } });
}
const { runOwnRuntime } = await import('../plugins/sleight/lib/runtime-select.mjs');
mutation?.deregister();
import { createDriverSafety } from '../plugins/sleight/lib/driver-safety.mjs';
import { prepareMacInputRegistrar } from '../plugins/sleight/lib/mac-driver/input-registrar.mjs';
import { MAC_DRIVER_SENTENCES } from '../plugins/sleight/lib/mac-driver/errors.mjs';
import { driverFixture } from './fixtures/driver-fake.mjs';

const changed = () => Object.assign(Error(MAC_DRIVER_SENTENCES.CLIPBOARD_CHANGED), {
  code: 'CLIPBOARD_CHANGED', clipboardChanged: true, delivery: 'sent-unverified', retry: 'read-first', next: 'stop-tell-user',
});
const text = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');

async function fixture(t, host, idleTurnEndMs = 30000) {
  const window = { windowId: '7', processStart: 'start', pid: 42, bundleId: 'test.fake',
    app: 'Fixture', title: 'Draft', identityVerified: true, onScreen: true, minimized: false,
    bounds: { x: 0, y: 0, width: 500, height: 500 } };
  const tree = 'Window: "Draft", App: Fixture.\n0 standard window Draft\n\t1 button Done';
  const inputs = [], releases = [], traces = [], pending = new Map();
  let readId = 0, id = 0, buffer = '', changeNext = false, failRelease = false;
  const driver = { async restart() {}, async close() {},
    async ping() { return { build: 'b'.repeat(64) }; },
    async request(method, params) {
      if (method === 'inputGateState') return { enabled: true };
      if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app, pid: window.pid,
        processStart: window.processStart }, windows: [window] };
      if (method === 'verifyWindowIdentity') return { window };
      if (method === 'rendererRestore') return { restored: true, token: params.args[0].lease.token };
      if (method === 'personState') return { window, token: 'fixture', personTookOver: false };
      if (method === 'getAXState') return { window, text: tree, readId: ++readId, truncated: false };
      assert.ok(['pressKey', 'click'].includes(method), method);
      inputs.push([method, params.args]);
      if (inputs.length === 1 || changeNext) { changeNext = false; throw changed(); }
      return { window, text: tree, readId: ++readId, delivery: 'sent-unverified', retry: 'read-first' };
    } };
  const input = new PassThrough(), output = new PassThrough();
  output.setEncoding('utf8').on('data', bytes => {
    buffer += bytes;
    for (let at; (at = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      const resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    }
  });
  const runtime = await runOwnRuntime({ input, output, signals: new EventEmitter(), driver,
    inputRegistrar: await prepareMacInputRegistrar(driver, 'b'.repeat(64)),
    lease: { acquire: () => 'fixture', grant: () => ({ token: 'fixture-token' }), renewGrant() {}, renew() {},
      release() {
        releases.push('release');
        if (failRelease) { failRelease = false; throw Error('fixture cleanup failed'); }
      }, close() {} },
    policy: () => ({ allow: true }), ownHostPid: () => false, targetParents: () => [1], ancestry: () => [{ pid: 500, path: '/fixture/Host' }], allowForbidden: () => false,
    permissions: { app() {}, page() {}, sitesLimited: () => false }, ask: () => 'accept', grantAudit() {},
    approvalStorage: { load: () => ({}), live: () => ({ allows: () => false, list: () => [] }) },
    replOptions: { environment: () => ({ CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }) },
    relayOptions: { ...idleTurnEndMs === null ? {} : { idleTurnEndMs }, trace: event => traces.push(event) },
  });
  t.after(async () => { await runtime.close(); input.destroy(); output.destroy(); });
  const request = (method, params) => new Promise(resolve => {
    pending.set(++id, resolve);
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await request('initialize', { clientInfo: { name: host, version: '1' }, capabilities: {} });
  const tool = async (name, args = {}, meta = MOD_META) => (await request('tools/call', { name, arguments: args, ...(name === 'turn_ended' ? { _meta: meta } : {}) })).result;
  const bootstrap = async () => {
    const result = await tool('turn_ended', { sleight_turbo: { event: 'bootstrap' } });
    assert.equal(result.isError, false, text(result));
    return JSON.parse(text(result)).sleightTurbo;
  };
  return { runtime, inputs, releases, traces, tool, bootstrap,
    changeNext() { changeNext = true; }, failNextRelease() { failRelease = true; },
    call: code => tool('js', { code }), binding: { windowId: window.windowId, processStart: window.processStart } };
}

for (const event of ['Stop', 'Interrupt']) test(`CB1R mod host keeps its clipboard stop past idle cleanup until ${event}`, { skip: replWorkerSkip }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await fixture(t, 'claude-code');
  const envelope = await h.bootstrap();
  const initial = await h.call('var app = await cua.getApp("Fixture"); try { await app.pressKey("ctrl+c"); } catch {}');
  assert.equal(initial.isError, true); assert.match(text(initial), /CLIPBOARD_CHANGED/);
  assert.deepEqual(h.inputs, [['pressKey', ['ctrl+c']]]);
  const before = h.releases.length;
  t.mock.timers.tick(30001); await tick();
  assert.equal(h.traces.filter(event => event === 'idle-turn-end').length, 1);
  assert.ok(h.releases.length > before, 'idle cleanup still releases leases');
  await assert.rejects(h.runtime.runtime.safety.request('getAXState', h.binding), { code: 'APP_NOT_ACQUIRED' });
  const retry = await h.call('var app = await cua.getApp("Fixture"); await app.pressKey("s");');
  assert.equal(h.inputs.length, 1, '0 more inputs after the idle end');
  assert.equal(retry.isError, true); assert.match(text(retry), /CLIPBOARD_CHANGED/);
  assert.match(text(retry), /delivery=not-sent/); assert.match(text(retry), /next=stop-tell-user/);
  assert.equal((await h.call('await app.getAXState();')).isError, false, 'reads remain available');
  // A hookless tool call cannot turn the relay's default Stop wording into a real end.
  await h.tool('turn_ended', { sleight_clipboard_turn_end: true });
  const hookless = await h.call('var app = await cua.getApp("Fixture"); await app.pressKey("s");');
  assert.equal(hookless.isError, true); assert.match(text(hookless), /CLIPBOARD_CHANGED/);
  assert.equal(h.inputs.length, 1);
  for (const args of [
    { hook_event_name: event, sleight_clipboard_turn_end: true },
    { hook_event_name: event, sleight_turbo: { ...envelope, nonce: '0'.repeat(64), event: 'end' } },
    { hook_event_name: event, sleight_turbo: { ...envelope, session: 'other-session', event: 'end' } },
    { hook_event_name: event, sleight_turbo: { ...envelope, version: 2, event: 'end' } },
    { hook_event_name: event, sleight_turbo: { ...envelope, event: 'end', extra: true } },
  ]) {
    await h.tool('turn_ended', args);
    const forged = await h.call('var app = await cua.getApp("Fixture"); await app.pressKey("s");');
    assert.equal(forged.isError, true); assert.match(text(forged), /CLIPBOARD_CHANGED/);
    assert.equal(h.inputs.length, 1, 'model turn_ended cannot reopen input');
  }
  await h.tool('turn_ended', { hook_event_name: event, sleight_clipboard_turn_end: false,
    sleight_turbo: { ...envelope, event: 'end' } });
  const next = await h.call('var app = await cua.getApp("Fixture"); await app.pressKey("s");');
  assert.equal(next.isError, false, text(next));
  assert.deepEqual(h.inputs, [['pressKey', ['ctrl+c']], ['pressKey', ['s']]]);
});

for (const host of ['cursor', 'claude-code', 'codex-mcp-client']) test(`CB1S ${host} without mod bootstrap clears its clipboard stop on idle cleanup`, { skip: replWorkerSkip }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await fixture(t, host);
  const initial = await h.call('var app = await cua.getApp("Fixture"); await app.pressKey("ctrl+c");');
  assert.equal(initial.isError, true); assert.match(text(initial), /CLIPBOARD_CHANGED/);
  const stopped = await h.call('await app.click(1);');
  assert.equal(stopped.isError, true); assert.match(text(stopped), /CLIPBOARD_CHANGED/);
  assert.equal(h.inputs.length, 1);
  t.mock.timers.tick(30001); await tick();
  assert.equal(h.traces.filter(event => event === 'idle-turn-end').length, 1);
  const next = await h.call('var app = await cua.getApp("Fixture"); await app.pressKey("s");');
  assert.equal(next.isError, false, text(next));
  assert.deepEqual(h.inputs, [['pressKey', ['ctrl+c']], ['pressKey', ['s']]]);
});

test('CB1R retrying an older real turn cleanup cannot clear the new turn clipboard stop', { skip: replWorkerSkip }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await fixture(t, 'claude-code');
  const envelope = await h.bootstrap();
  await h.call('var app = await cua.getApp("Fixture"); await app.pressKey("ctrl+c");');
  h.failNextRelease();
  const failed = await h.tool('turn_ended', { hook_event_name: 'Stop', sleight_turbo: { ...envelope, event: 'end' } });
  assert.equal(failed.isError, true); assert.match(text(failed), /fixture cleanup failed/);
  h.changeNext();
  const newStop = await h.call('var app = await cua.getApp("Fixture"); await app.pressKey("ctrl+c");');
  assert.equal(newStop.isError, true); assert.match(text(newStop), /CLIPBOARD_CHANGED/);
  assert.equal(h.inputs.length, 2);
  t.mock.timers.tick(30001); await tick();
  assert.equal(h.traces.filter(event => event === 'idle-turn-end').length, 1);
  const retry = await h.call('var app = await cua.getApp("Fixture"); await app.pressKey("s");');
  assert.equal(h.inputs.length, 2, '0 more inputs after the old cleanup retry');
  assert.equal(retry.isError, true); assert.match(text(retry), /CLIPBOARD_CHANGED/);
  await h.tool('turn_ended', { hook_event_name: 'Interrupt', sleight_turbo: { ...envelope, event: 'end' } });
  assert.equal((await h.call('var app = await cua.getApp("Fixture"); await app.pressKey("s");')).isError, false);
  assert.equal(h.inputs.length, 3);
});

for (const host of ['cursor', 'claude-code']) test(`CB1S ${host} without mod bootstrap permits model turn_ended to clear the stop`, { skip: replWorkerSkip }, async t => {
  const h = await fixture(t, host, 0);
  await h.call('var app = await cua.getApp("Fixture"); await app.pressKey("ctrl+c");');
  await h.tool('turn_ended', { hook_event_name: 'Stop' });
  const next = await h.call('var app = await cua.getApp("Fixture"); await app.pressKey("s");');
  assert.equal(next.isError, false, text(next));
  assert.equal(h.inputs.length, 2);
});

test('CB1R without mod signals or an idle timer the clipboard stop lasts through later cells', { skip: replWorkerSkip }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await fixture(t, 'cursor', 0);
  await h.call('var app = await cua.getApp("Fixture"); await app.pressKey("ctrl+c");');
  t.mock.timers.tick(300000); await tick();
  assert.equal(h.traces.filter(event => event === 'idle-turn-end').length, 0);
  const retry = await h.call('await app.click(1);');
  assert.equal(retry.isError, true); assert.match(text(retry), /CLIPBOARD_CHANGED/);
  assert.deepEqual(h.inputs, [['pressKey', ['ctrl+c']]]);
});

test('CB1R own launcher defaults to a 30 second idle end', { skip: replWorkerSkip }, async t => {
  const original = process.env.SLEIGHT_IDLE_TURN_END_MS;
  delete process.env.SLEIGHT_IDLE_TURN_END_MS;
  t.after(() => {
    if (original === undefined) delete process.env.SLEIGHT_IDLE_TURN_END_MS;
    else process.env.SLEIGHT_IDLE_TURN_END_MS = original;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = await fixture(t, 'cursor', null);
  await h.call('var app = await cua.getApp("Fixture"); await app.pressKey("ctrl+c");');
  t.mock.timers.tick(29999); await tick();
  assert.equal(h.traces.filter(event => event === 'idle-turn-end').length, 0);
  t.mock.timers.tick(1); await tick();
  assert.equal(h.traces.filter(event => event === 'idle-turn-end').length, 1);
  const next = await h.call('var app = await cua.getApp("Fixture"); await app.pressKey("s");');
  assert.equal(next.isError, false, text(next));
  assert.deepEqual(h.inputs, [['pressKey', ['ctrl+c']], ['pressKey', ['s']]]);
});

for (const clipboardTurnEnded of [true, false]) test(clipboardTurnEnded
  ? 'CB1R a delayed old-turn clipboard failure cannot stop the new turn'
  : 'CB1R delayed clipboard failure still stops the same user turn after idle cleanup', async t => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const h = await driverFixture('darwin', createDriverSafety, { async afterInput() {
    if (h.actions.length !== 1) return;
    entered(); await held; throw changed();
  } });
  t.after(() => h.safety.close());
  const first = await h.safety.request('getApp', { selector: 'Fixture' });
  const old = assert.rejects(h.safety.request('pressKey', { ...h.binding(), readId: first.readId, args: ['ctrl+c'] }),
    { code: 'CLIPBOARD_CHANGED', delivery: 'sent-unverified' });
  await started;
  await h.safety.endTurn({ clipboardTurnEnded });
  const acquiring = h.safety.request('getApp', { selector: 'Fixture' });
  release(); await old;
  const next = await acquiring;
  const input = h.safety.request('pressKey', { ...h.binding(), readId: next.readId, args: ['Home'] });
  if (clipboardTurnEnded) {
    await input;
    assert.deepEqual(h.actions, [['pressKey', ['ctrl+c']], ['pressKey', ['Home']]]);
  } else {
    await assert.rejects(input, { code: 'CLIPBOARD_CHANGED', delivery: 'not-sent' });
    assert.deepEqual(h.actions, [['pressKey', ['ctrl+c']]]);
  }
});

for (const event of ['Stop', 'Interrupt']) test(`MB1B only an attributed bound ${event} clears the clipboard latch`, { skip: replWorkerSkip }, async t => {
  const h = await fixture(t, 'claude-code', 0), envelope = await h.bootstrap();
  await h.call('var app = await cua.getApp("Fixture"); await app.pressKey("ctrl+c");');
  for (const id of [MODEL_ID, ...['bdrk', 'vrtx', 'patch', 'serve', 'unknown'].map(prefix => `toolu_${prefix}_${'a'.repeat(32)}`),
    'toolu_plugin_' + 'A'.repeat(32), 'toolu_plugin_' + 'a'.repeat(31), 'toolu_plugin_' + 'a'.repeat(33),
    'toolu_plugin_' + MODEL_ID.slice(6), 1, {}, [MOD_ID], null, undefined, MOD_ID + '\n']) {
    const result = await h.tool('turn_ended', { hook_event_name: event, sleight_turbo: { ...envelope, event: 'end' } },
      id === undefined ? {} : { 'claudecode/toolUseId': id });
    const next = await h.call('var app = await cua.getApp("Fixture"); await app.pressKey("s");');
    assert.equal(next.isError, true); assert.match(text(next), /CLIPBOARD_CHANGED/);
    assert.equal(h.inputs.length, 1);
    assert.equal(result.isError, true);
  }
  await h.tool('turn_ended', { hook_event_name: event, sleight_turbo: { ...envelope, event: 'end' } });
  assert.equal((await h.call('var app = await cua.getApp("Fixture"); await app.pressKey("s");')).isError, false);
  assert.equal(h.inputs.length, 2);
});
