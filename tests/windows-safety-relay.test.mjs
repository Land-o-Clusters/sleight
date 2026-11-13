import { waitForReadiness } from './fixtures/wait-for-readiness.mjs';
import { windowsWorkerSkip } from './fixtures/repl-requirement.mjs';
import { MOD_META } from './fixtures/mod-attribution.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWindows, windowsApprovalMessage } from '../plugins/sleight/lib/windows-launch.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { windowsLeaseTarget } from '../plugins/sleight/lib/windows-driver/safety.mjs';
import { fakeWindows } from './fixtures/windows-driver-fake.mjs';
import { windowsReplFixture } from './fixtures/windows-repl-client.mjs';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { setImmediate as tick } from 'node:timers/promises';
import { FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';

const text = result => result?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
async function fixture(t, { allow = true, scenario, host = 'sleight-test', ...options } = {}) {
  const worker = windowsReplFixture(t, { driverScenario: scenario });
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-safety-relay-')));
  const lease = new InputLease({ directory: root, holder: 'relay fixture' });
  const input = new PassThrough(), output = new PassThrough(), pending = new Map(), cards = [], calls = [], errors = [];
  const cardEvents = new EventEmitter();
  let announceCard;
  const cardReady = new Promise(resolve => { announceCard = resolve; });
  let next = 0, buffer = '', nextWorkerCode;
  const injectWorkerCode = code => { nextWorkerCode = code; };
  const send = value => input.write(JSON.stringify(value) + '\n');
  output.on('data', bytes => {
    buffer += bytes;
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (message.error) errors.push(message.error);
      if (message.method === 'elicitation/create') {
        cards.push(message);
        // Assert at the observable relay boundary, before sending the fixture answer.
        if (cards.length === 1) assert.equal(calls.some(row => ['getApp', 'getAXState', 'getScreenshot'].includes(row.method)), false);
        announceCard(message);
        cardEvents.emit('card', message);
        if (allow !== null) queueMicrotask(() => send({ jsonrpc: '2.0', id: message.id, result: { action: allow ? 'accept' : 'decline', content: {} } }));
      } else if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    }
  });
  const runtime = await runWindows({ input, output, signals: new EventEmitter(), driver: { ...worker.driver,
    async request(method, params) { calls.push({ method, params }); const result = await worker.driver.request(method, params);
      return options.transformResult ? options.transformResult(result, method) : result; } }, lease,
    replOptions: { environment: () => ({ LANE_FIXTURE: '1' }), spawn: (...args) => {
      const child = fork(...args), send = child.send.bind(child);
      child.send = (message, ...rest) => {
        if (message.type === 'evaluate' && nextWorkerCode !== undefined) {
          message = { ...message, code: nextWorkerCode }; nextWorkerCode = undefined;
        }
        return send(message, ...rest);
      };
      return child;
    } },
    setting: () => ({ enabled: false, stream: false }), discovery: { browsers: async () => [] },
    paths: { cache: 'C:\\Fixture\\sleight' }, ...options,
    safetyOptions: { allowForbidden: false, stuckEscape: true, ...options.safetyOptions } });
  t.after(async () => { try { await runtime.close(); } catch (error) { if (!options.expectedCloseFailure) throw error; }
    finally { removeTemp(root); } });
  const request = (method, params) => new Promise(resolve => { const id = ++next; pending.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
  const call = async (code, extra) => (await request('tools/call', { name: 'js', arguments: { code, ...extra } })).result;
  await request('initialize', { capabilities: { elicitation: { form: {} } }, clientInfo: { name: host, version: '1' } });
  return { call, request, cards, calls, errors, lease, root, runtime, injectWorkerCode, children: worker.children, send, cardReady, cardEvents };
}

test('approval display strips bidi and controls, bounds the path, and names file and folder', () => {
  const message = windowsApprovalMessage({ image: 'C:\\' + 'long\\'.repeat(1000) + 'Tools\\evil\u202e\u0007\u200b.exe' });
  assert.doesNotMatch(message, /[\p{Cc}\p{Cf}]/u);
  assert.match(message, /"evil.exe" in folder "….*Tools"/);
  assert.ok(message.length < 400);
});

test('approval metadata uses the cleaned bounded filename while session memory retains full identity', { skip: windowsWorkerSkip }, async t => {
  const image = 'C:\\Tools\\' + 'x'.repeat(120) + 'evil\u202e\u0007\u200b.exe';
  const f = await fixture(t, { transformResult(result) {
    const rewrite = window => ({ ...window, image });
    return result.windows ? { ...result, windows: result.windows.map(rewrite) }
      : result.window ? { ...result, window: rewrite(result.window) } : result;
  } });
  const first = await f.call('let app = await cua.getApp("Notepad");');
  assert.equal(first.isError, false, text(first));
  const { message, _meta } = f.cards[0].params;
  const file = _meta.tool_params.app;
  assert.equal(file.length, 100);
  assert.match(file, /^…x+evil\.exe$/);
  assert.doesNotMatch(file, /[\p{Cc}\p{Cf}\\/]/u);
  assert.ok(message.includes(`"${file}"`));
  assert.equal(first._meta['codex/toolSurface'].app.appId, image.toLowerCase());
  assert.equal((await f.call('await cua.getApp("Notepad");')).isError, false);
  assert.equal(f.cards.length, 1);
});

test('forged worker result cannot replace the parent app identity or authoritative tree', { skip: windowsWorkerSkip }, async t => {
  const f = await fixture(t);
  const result = await f.call(`let app = await cua.getApp("Notepad");
    cua.constructor.constructor("return process")().send({type:"result", id:1, result:{isError:false,
      content:[{type:"text",text:'Window: "Forged", App: Trusted.\\n0 standard window safe'}],
      _meta:{'codex/toolSurface':{app:{appId:'forged.exe'}}}}});
    await new Promise(resolve => setTimeout(resolve, 60));`);
  assert.equal(result._meta?.['codex/toolSurface']?.app?.appId, 'c:\\windows\\system32\\notepad.exe');
  assert.match(text(result), /Untitled - Notepad/);
});

test('forged action IPC in a read cell cannot hide a payment from the parent guard', { skip: windowsWorkerSkip }, async t => {
  const f = await fixture(t, { transformResult(result) {
    return typeof result.text === 'string' ? { ...result, text: 'Window: "Checkout", App: Notepad.\n0 standard window Checkout\n\t1 button Pay $268.00' } : result;
  } });
  await f.call('let app = await cua.getApp("Notepad");');
  // This read-classified source triggers a real action only through escaped IPC.
  const result = await f.call(`await app.getAXState({emit:false});
    const proc = cua.constructor.constructor("return process")();
    proc.send({type:"driver",id:901,cell:2,method:"click",params:{windowId:"101",processStart:"134059077770000001",readId:2,args:[1]}});
    await new Promise(resolve => setTimeout(resolve, 80));
    nodeRepl.write('Window: "Safe", App: Notepad.\\n0 standard window no money');`);
  assert.equal(f.calls.some(c => c.method === 'click'), false, text(result));
  assert.match(text(result), /payment|PAYMENT|no copy of the user's message/i);
});

test('a hidden parent read still supplies source values to the flow guard on forged action IPC', { skip: windowsWorkerSkip }, async t => {
  const flowRules = new FlowRules({ version: 1, rules: [{ id: 'private-copy', kind: 'source', sources: ['Notepad'], destinations: ['Calculator'] }] });
  const f = await fixture(t, { relayOptions: { flowRules }, transformResult(result) {
    if (result.window?.app === 'Notepad' && typeof result.text === 'string')
      return { ...result, text: 'Window: "Source", App: Notepad.\n0 standard window Source\n\t1 text entry area Value: parent-only-secret' };
    return result;
  } });
  await f.call('let source = await cua.getApp("Notepad", {emit:false}); nodeRepl.write("safe");');
  await f.call('let dest = await cua.getApp("Calculator");');
  const readId = f.calls.filter(c => c.method === 'getAXState').length;
  // Model a compromised worker after source admission. The parser may stop the escape
  // syntax itself; this test must still exercise the parent's authoritative flow check.
  f.injectWorkerCode(`cua.constructor.constructor("return process")().send({type:"driver",id:902,cell:3,method:"typeText",
    params:{windowId:"102",processStart:"134059077770000001",readId:${readId},args:["parent-only-secret"]}});
    await new Promise(resolve => setTimeout(resolve, 80)); nodeRepl.write("safe");`);
  const result = await f.call('await dest.getAXState({emit:false});');
  assert.equal(f.calls.some(c => c.method === 'typeText'), false, text(result));
  assert.match(text(result), /FLOW_RULE_REFUSED/);
});

test('valid Windows scroll and drag arguments reach the native driver after parent admission', { skip: windowsWorkerSkip }, async t => {
  const f = await fixture(t, { scenario: 'actions' });
  await f.call('let app = await cua.getApp("Notepad");');
  for (const code of ['await app.scroll(3, {direction:"down",amount:1});', 'await app.drag(3, 2);']) {
    const result = await f.call(code);
    assert.doesNotMatch(text(result), /invalid native arguments|WINDOWS_GUARD_REFUSED|INVALID_PARAMS/);
  }
  assert.equal(f.calls.filter(c => c.method === 'scroll').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'drag').length, 1);
});

test('relay declined app approval performs zero UIA reads', { skip: windowsWorkerSkip }, async t => {
  const f = await fixture(t, { allow: false });
  const result = await f.call('let app = await cua.getApp("Notepad");');
  assert.equal(result.isError, true); assert.match(text(result), /APP_DECLINED/);
  assert.equal(f.cards.length, 1);
  assert.equal(f.cards[0].params._meta.riskLevel, 'high');
  assert.deepEqual(f.cards[0].params._meta.persist, ['session']);
  assert.ok(f.calls.length >= 1); assert.ok(f.calls.every(c => c.method === 'getState'));
});

test('relay remembers an app for the session and masks password values through the fake driver', { skip: windowsWorkerSkip }, async t => {
  const f = await fixture(t);
  const first = await f.call('let app = await cua.getApp("Notepad");');
  assert.equal(first.isError, false, text(first));
  assert.match(text(first), /<redacted>/);
  assert.doesNotMatch(text(first), /hidden fixture secret|password fixture secret|secret help/);
  const next = await f.call('await app.getAXState();');
  assert.equal(next.isError, false, text(next)); assert.equal(f.cards.length, 1);
  await f.request('tools/call', { name: 'js_reset', arguments: {} });
  assert.equal(f.lease.owned.size, 0);
  const reset = await f.call('let app = await cua.getApp("Notepad");');
  assert.equal(reset.isError, false, text(reset)); assert.equal(f.cards.length, 1);
});

for (const [scenario, code] of [['safety-forbidden', 'FORBIDDEN_TARGET'], ['safety-elevated', 'ELEVATED_TARGET'], ['safety-own-host', 'OWN_HOST']])
  test(`relay refuses ${scenario} before a card or a read`, { skip: windowsWorkerSkip }, async t => {
    const f = await fixture(t, { scenario });
    const result = await f.call('await cua.getApp({windowId:"101"});');
    assert.equal(result.isError, true); assert.match(text(result), new RegExp(code));
    assert.equal(f.cards.length, 0); assert.deepEqual(f.calls.map(c => c.method), ['getState']);
  });

test('relay refuses another session lease before the first read', { skip: windowsWorkerSkip }, async t => {
  const f = await fixture(t);
  const other = new InputLease({ directory: f.root, holder: 'another session' });
  other.acquire(windowsLeaseTarget(fakeWindows[0]));
  try {
    const result = await f.call('await cua.getApp("Notepad");');
    assert.equal(result.isError, true); assert.match(text(result), /held by another session/);
    assert.ok(f.calls.length >= 1); assert.ok(f.calls.every(c => c.method === 'getState'));
  } finally { other.close(); }
});

test('relay identity mismatch blocks a subsequent read', { skip: windowsWorkerSkip }, async t => {
  const f = await fixture(t, { scenario: 'safety-changed' });
  assert.equal((await f.call('let app = await cua.getApp("Notepad");')).isError, false);
  const result = await f.call('await app.getAXState();');
  assert.equal(result.isError, true); assert.match(text(result), /IDENTITY_CHANGED/);
  assert.equal(f.calls.filter(c => c.method === 'getAXState').length, 1);
});

test('escaped worker forged IPC cannot read an unacquired HWND or supply extra parameters', { skip: windowsWorkerSkip }, async t => {
  const f = await fixture(t);
  // The first cell and driver id are known to escaped code. This bypasses cua.mjs.
  await f.call(`cua.constructor.constructor("return process")().send({type:"driver", id:100,
    cell:1, method:"getScreenshot", params:{windowId:"101",processStart:"134059077770000001",approved:true}});
    await new Promise(resolve => setTimeout(resolve, 40));`);
  assert.deepEqual(f.calls, []); assert.equal(f.cards.length, 0);
  await f.call(`cua.constructor.constructor("return process")().send({type:"driver", id:101,
    cell:2, method:"getAXState", params:{windowId:"101",processStart:"134059077770000001"}});
    await new Promise(resolve => setTimeout(resolve, 40));`);
  assert.deepEqual(f.calls, []);
});

for (const [scenario, count, note] of [['safety-menu', 1, true], ['safety-menu-active', 1, false]])
  test(`stuck menu ${scenario} tries Escape once across distinct calls`, { skip: windowsWorkerSkip }, async t => {
    const f = await fixture(t, { scenario });
    assert.equal((await f.call('let app = await cua.getApp("Notepad");')).isError, false);
    const second = await f.call('await app.getAXState();');
    assert.equal(second.isError, false, text(second));
    assert.equal(/posted one Escape/.test(text(second)), note);
    assert.equal((await f.call('await app.getAXState();')).isError, false);
    assert.equal(f.calls.filter(c => c.method === 'stuckMenuEscape').length, count);
  });

test('stuck menu off switch suppresses Escape and a menu bar alone never triggers it', { skip: windowsWorkerSkip }, async t => {
  const f = await fixture(t, { scenario: 'safety-menu', safetyOptions: { stuckEscape: false } });
  await f.call('let app = await cua.getApp("Notepad");'); await f.call('await app.getAXState();');
  assert.equal(f.calls.some(c => c.method === 'stuckMenuEscape'), false);
  const ordinary = await fixture(t);
  await ordinary.call('let app = await cua.getApp("Notepad");'); await ordinary.call('await app.getAXState();');
  assert.equal(ordinary.calls.some(c => c.method === 'stuckMenuEscape'), false);
});

test('combined capture retains its image and protocol shape after a stuck Escape', { skip: windowsWorkerSkip }, async t => {
  const f = await fixture(t, { scenario: 'safety-menu' });
  await f.call('let app = await cua.getApp("Notepad");');
  const result = await f.call('await app.getAXStateAndScreenshot();');
  assert.equal(result.isError, false, text(result));
  assert.equal(result.content.filter(item => item.type === 'image').length, 1);
  assert.match(text(result), /posted one Escape/);
  assert.equal(f.calls.filter(c => c.method === 'stuckMenuEscape').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'getAXStateAndScreenshot').length, 2);
});

test('a deferred Escape leaves the worker handle usable for the next parent-guarded action', { skip: windowsWorkerSkip }, async t => {
  const f = await fixture(t, { scenario: 'safety-menu' });
  await f.call('let app = await cua.getApp("Notepad");');
  await f.call('await app.getAXState();');
  const result = await f.call('await app.setValue(3, "after Escape");');
  assert.equal(result.isError, false, text(result));
  assert.equal(f.calls.filter(c => c.method === 'setValue').length, 1);
});

test('an action followed by a menu read never Escapes the menu the model just opened', { skip: windowsWorkerSkip }, async t => {
  const f = await fixture(t, { scenario: 'safety-menu' });
  await f.call('let app = await cua.getApp("Notepad");');
  const result = await f.call('await app.click(2);');
  assert.equal(result.isError, false, text(result));
  assert.doesNotMatch(text(result), /posted one Escape/);
  assert.match(text(result), /"action":"click"/);
  assert.match(text(result), /"route":"Expand\/Collapse"/);
  assert.match(text(result), /"confirmation":"unconfirmed"/);
  const read = await f.call('await app.getAXState();');
  assert.doesNotMatch(text(read), /posted one Escape/);
  assert.equal(f.calls.some(c => c.method === 'stuckMenuEscape'), false);
});

test('reads after opening a menu in the same cell do not seed a stuck episode', { skip: windowsWorkerSkip }, async t => {
  const f = await fixture(t, { scenario: 'safety-menu' });
  await f.call('let app = await cua.getApp("Notepad");');
  await f.call('await app.click(2); await app.getAXState();');
  const read = await f.call('await app.getAXState();');
  assert.doesNotMatch(text(read), /posted one Escape/);
  assert.equal(f.calls.some(c => c.method === 'stuckMenuEscape'), false);
});

test('forbidden private-title guesses and missing titles have the same refusal', { skip: windowsWorkerSkip }, async t => {
  const f = await fixture(t, { scenario: 'safety-forbidden' });
  const existing = await f.call('await cua.getApp("Untitled - Notepad");');
  const missing = await f.call('await cua.getApp("Absent private title");');
  for (const result of [existing, missing]) {
    assert.equal(result.isError, true); assert.match(text(result), /WINDOW_NOT_FOUND/);
  }
  assert.equal(f.cards.length, 0);
  assert.equal(f.calls.every(c => c.method === 'getState'), true);
});

test('unsafe lease shutdown still collects the owned driver and clears streams', { skip: windowsWorkerSkip }, async t => {
  const f = await fixture(t, { expectedCloseFailure: true });
  await f.call('let app = await cua.getApp("Notepad");');
  const close = f.lease.close.bind(f.lease);
  f.lease.release = () => { throw Error('fixture unsafe lease'); };
  await assert.rejects(f.runtime.close(), /Windows session cleanup failed/);
  assert.equal(f.children.length, 1);
  assert.notEqual(f.children[0].exitCode ?? f.children[0].signalCode, null);
  // Restore only the fixture method so its temporary coordinator can be closed.
  delete f.lease.release; close();
});

test('a cancelled app card cannot seed session memory after reset', { skip: windowsWorkerSkip }, async t => {
  const f = await fixture(t, { allow: null });
  const first = f.call('await cua.getApp("Notepad");');
  const card = await waitForReadiness(f.cardReady, first, { label: 'app card' });
  await f.request('tools/call', { name: 'js_reset', arguments: {} });
  assert.equal((await first).isError, true);
  f.send({ jsonrpc: '2.0', id: card.id, result: { action: 'accept', content: {} } });
  const nextCard = new Promise(resolve => f.cardEvents.once('card', resolve));
  const next = f.call('await cua.getApp("Notepad");');
  await waitForReadiness(nextCard, next, { label: 'replacement app card' });
  assert.equal(f.calls.every(c => c.method === 'getState'), true);
  f.send({ jsonrpc: '2.0', id: f.cards[1].id, result: { action: 'decline' } });
  assert.equal((await next).isError, true); assert.equal(f.cards.length, 2);
  assert.deepEqual(f.errors, []);
});

test('a clipboard bump reaches the model with the Mac stop directive and one delivered action', { skip: windowsWorkerSkip }, async t => {
  const h = await fixture(t, { scenario: 'actions', transformResult(result, method) {
    return method === 'click' ? { ...result, clipboardChanged: true, delivery: 'sent-unverified', retry: 'read-first' } : result;
  } });
  const result = await h.call('let note = await cua.getApp("Notepad"); await note.click(2);');
  assert.equal(result.isError, true);
  assert.match(text(result), /CLIPBOARD_CHANGED/);
  assert.match(text(result), /clipboard changed during or since sleight's last action/);
  assert.match(text(result), /retry=read-first/); assert.match(text(result), /next=stop-tell-user/);
  assert.equal(h.calls.filter(row => row.method === 'click').length, 1);
});

// Exercise the relay's attribution through the production Windows receiver.
async function clipboardTurn(t, host, relayOptions = {}) {
  let changes = 1;
  const h = await fixture(t, { host, scenario: 'actions', relayOptions, transformResult(result, method) {
    return method === 'click' && changes-- > 0 ? { ...result, clipboardChanged: true, delivery: 'sent-unverified', retry: 'read-first' } : result;
  } });
  const tool = async (name, args = {}) => (await h.request('tools/call', { name, arguments: args, ...(name === 'turn_ended' ? { _meta: MOD_META } : {}) })).result;
  const initial = await h.call('var note = await cua.getApp("Notepad"); await note.click(2);');
  assert.equal(initial.isError, true); assert.match(text(initial), /CLIPBOARD_CHANGED/);
  const retry = () => h.call('var note = await cua.getApp("Notepad"); await note.click(2);');
  const stopped = await retry();
  assert.equal(stopped.isError, true); assert.match(text(stopped), /next=stop-tell-user/);
  assert.equal(h.calls.filter(c => c.method === 'click').length, 1);
  return { ...h, tool, retry, changeNext() { changes++; } };
}

for (const event of ['Stop', 'Interrupt']) test(`WCB1C Windows mod host cannot clear its latch with a model ${event}`, { skip: windowsWorkerSkip }, async t => {
  const h = await clipboardTurn(t, 'claude-code');
  const bootstrap = await h.tool('turn_ended', { sleight_turbo: { event: 'bootstrap' } });
  assert.equal(bootstrap.isError, false, text(bootstrap));
  const envelope = JSON.parse(text(bootstrap)).sleightTurbo;
  for (const args of [
    { sleight_clipboard_turn_end: true },
    { hook_event_name: event, sleight_clipboard_turn_end: true },
    { hook_event_name: event, sleight_turbo: { ...envelope, nonce: '0'.repeat(64), event: 'end' } },
    { hook_event_name: event, sleight_turbo: { ...envelope, session: 'other-session', event: 'end' } },
    { hook_event_name: event, sleight_turbo: { ...envelope, version: 2, event: 'end' } },
    { hook_event_name: event, sleight_turbo: { ...envelope, event: 'end', extra: true } },
  ]) {
    const ended = await h.tool('turn_ended', args);
    assert.equal(ended.isError, undefined, text(ended));
    assert.equal(h.lease.owned.size, 0, 'unbound turn end still releases leases');
    const old = await h.call('await note.getAXState();');
    assert.equal(old.isError, true); assert.match(text(old), /APP_NOT_ACQUIRED/);
    const stopped = await h.retry();
    assert.equal(stopped.isError, true); assert.match(text(stopped), /CLIPBOARD_CHANGED/);
    assert.equal(h.calls.filter(c => c.method === 'click').length, 1);
  }
});

for (const event of ['Stop', 'Interrupt']) test(`Windows receiver clears input after a bound mod ${event}`, { skip: windowsWorkerSkip }, async t => {
    const h = await clipboardTurn(t, 'claude-code');
    const bootstrap = await h.tool('turn_ended', { sleight_turbo: { event: 'bootstrap' } });
    const envelope = JSON.parse(text(bootstrap)).sleightTurbo;
    const ended = await h.tool('turn_ended', { hook_event_name: event, sleight_clipboard_turn_end: false,
      sleight_turbo: { ...envelope, event: 'end' } });
    assert.equal(ended.isError, undefined, text(ended));
    assert.equal(h.lease.owned.size, 0);
    const next = await h.retry();
    assert.equal(next.isError, false, text(next));
    assert.equal(h.calls.filter(c => c.method === 'click').length, 2);
  });

test('Windows mod idle end releases leases without clearing the clipboard stop', { skip: windowsWorkerSkip }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const traces = [];
  const h = await clipboardTurn(t, 'claude-code', { idleTurnEndMs: 30000, trace: event => traces.push(event) });
  await h.tool('turn_ended', { sleight_turbo: { event: 'bootstrap' } });
  t.mock.timers.tick(30001); await tick();
  assert.equal(traces.filter(event => event === 'idle-turn-end').length, 1);
  assert.equal(h.lease.owned.size, 0);
  const old = await h.call('await note.getAXState();');
  assert.equal(old.isError, true); assert.match(text(old), /APP_NOT_ACQUIRED/);
  const stopped = await h.retry();
  assert.equal(stopped.isError, true); assert.match(text(stopped), /CLIPBOARD_CHANGED/);
  assert.equal(h.calls.filter(c => c.method === 'click').length, 1);
});

for (const host of ['claude-code', 'cursor', 'codex-mcp-client'])
  test(`Windows ${host} without a mod clears the clipboard stop on turn_ended`, { skip: windowsWorkerSkip }, async t => {
    const h = await clipboardTurn(t, host);
    await h.tool('turn_ended');
    assert.equal(h.lease.owned.size, 0);
    const next = await h.retry();
    assert.equal(next.isError, false, text(next));
    assert.equal(h.calls.filter(c => c.method === 'click').length, 2);
  });

test('Windows failed turn cleanup replies with an error and its owed replay preserves a newer stop', { skip: windowsWorkerSkip }, async t => {
  const h = await clipboardTurn(t, 'claude-code');
  const bootstrap = await h.tool('turn_ended', { sleight_turbo: { event: 'bootstrap' } });
  const envelope = JSON.parse(text(bootstrap)).sleightTurbo;
  const release = h.lease.release.bind(h.lease);
  let failNext = true;
  h.lease.release = (...args) => {
    if (failNext) { failNext = false; throw Error('fixture private cleanup detail'); }
    return release(...args);
  };
  const failed = await h.tool('turn_ended', { hook_event_name: 'Stop', sleight_turbo: { ...envelope, event: 'end' } });
  assert.equal(failed.isError, true); assert.match(text(failed), /Windows turn cleanup failed/);
  assert.doesNotMatch(text(failed), /fixture private cleanup detail/);
  const fenced = await h.retry();
  assert.equal(fenced.isError, true); assert.match(text(fenced), /USER_STOPPED.*turn-end-failed/s);
  assert.equal(h.calls.filter(c => c.method === 'click').length, 1);
  // B2D fences lease-cleanup failures too. Only a successful trusted end lifts it.
  await h.tool('turn_ended', { hook_event_name: 'Interrupt', sleight_turbo: { ...envelope, event: 'end' } });
  h.changeNext();
  const newer = await h.retry();
  assert.equal(newer.isError, true); assert.match(text(newer), /CLIPBOARD_CHANGED/);
  assert.equal(h.calls.filter(c => c.method === 'click').length, 2);
  await h.runtime.relay.endOpenTurn();
  assert.equal(h.lease.owned.size, 0);
  const stopped = await h.retry();
  assert.equal(stopped.isError, true); assert.match(text(stopped), /CLIPBOARD_CHANGED/);
  assert.equal(h.calls.filter(c => c.method === 'click').length, 2);
  await h.tool('turn_ended', { hook_event_name: 'Interrupt', sleight_turbo: { ...envelope, event: 'end' } });
  assert.equal((await h.retry()).isError, false);
  assert.equal(h.calls.filter(c => c.method === 'click').length, 3);
});

test('Windows receiver clears input after a no-mod idle end', { skip: windowsWorkerSkip }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const traces = [];
    const h = await clipboardTurn(t, 'claude-code', { idleTurnEndMs: 30000, trace: event => traces.push(event) });
    t.mock.timers.tick(30001); await tick();
    assert.equal(traces.filter(event => event === 'idle-turn-end').length, 1);
    const next = await h.retry();
    assert.equal(next.isError, false, text(next));
    assert.equal(h.calls.filter(c => c.method === 'click').length, 2);
  });
