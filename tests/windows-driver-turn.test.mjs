import { windowsWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createWindowsDriverClient } from '../plugins/sleight/lib/driver-client.mjs';
import { createWindowsDriverClient as wrappedWindowsClient } from '../plugins/sleight/lib/windows-driver/client.mjs';
import { createDriverSafety } from '../plugins/sleight/lib/driver-safety.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { runWindows, windowsTurnTelemetry } from '../plugins/sleight/lib/windows-launch.mjs';
import { windowsTurnFixture } from './fixtures/windows-driver-fake.mjs';
import { slowDriverHost } from './fixtures/windows-driver-slow-fake.mjs';
import { MOD_META } from './fixtures/mod-attribution.mjs';

const lib = new URL('../plugins/sleight/lib/', import.meta.url);
const source = name => readFileSync(new URL(name, lib), 'utf8');
async function variant(name, before, after) {
  const url = new URL(name, lib), original = source(name);
  assert.ok(original.includes(before), 'mutation anchor: ' + before);
  const changed = original.replace(before, after).replace(/from (['"])(\.[^'"]+)\1/g,
    (_, q, path) => 'from ' + q + new URL(path, url).href + q);
  return import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'));
}

test('synthetic hook: arm requires a driving turn and stale evidence stays in its own object', () => {
  const h = windowsTurnFixture();
  assert.throws(() => h.activate(), /TURN_INACTIVE/);
  h.key(); h.begin(1); const old = h.current;
  assert.equal(h.armed, false); h.activate();
  for (const flags of [0x10, 0x02, 0x12]) { h.key({ flags }); assert.equal(old.escape, false); }
  assert.equal(h.key(), 'next-hook'); assert.equal(old.escape, true);
  h.begin(1); assert.throws(() => h.activate(), /USER_STOPPED/);
  h.end(1); h.key(); h.begin(2); h.activate();
  assert.equal(old.active, false); assert.equal(old.escape, true);
  assert.equal(h.current.escape, false); assert.throws(() => h.activate(old), /TURN_INACTIVE/);
});
test('synthetic hook: idle removal at 60000 ms retains the turn stop until its end', () => {
  const h = windowsTurnFixture(); h.begin(1); h.activate();
  h.advance(59999); assert.equal(h.armed, true);
  h.advance(1); assert.equal(h.armed, false); h.key(); assert.equal(h.current.escape, false);
  h.activate(); h.key(); h.advance(60000); assert.equal(h.armed, false);
  assert.throws(() => h.activate(), /USER_STOPPED/);
  h.end(1); h.begin(2); h.activate(); assert.equal(h.current.escape, false);
});

function nativeContract(hook, driver) {
  assert.match(hook, /if \(owner == null \|\| owner != turn \|\| Volatile.Read\(ref owner.Active\) == 0\) throw Unavailable\("turn-inactive", "TURN_INACTIVE"\)/);
  assert.match(hook, /if \(owner.Escaped\) throw DriverSession.Refusal\("USER_STOPPED", "escape"\)/);
  assert.match(hook, /turn != null && turn.Id == id\) return/);
  assert.match(hook, /id <= lastTurn/);
  assert.match(hook, /turn = new DriverTurn \{ Id = id \}/);
  assert.match(hook, /Volatile.Write\(ref turn.Active, 0\);\s*turn = null; requested = false;[^]*removed.Reset\(\); removalPending = true;/);
  assert.match(hook, /var owner = armedTurn;\s*try \{\s*if \(owner != null && Volatile.Read\(ref owner.Active\) != 0/);
  assert.match(hook, /bool Remove\(\)\s*\{\s*var owner = armedTurn;\s*var timing = DriverCheckpointTimings.Start\([^]*?DriverCheckpointTimings.Kind.HookRemove\);\s*try \{\s*armedTurn = null/);
  assert.match(hook, /IdleMs = 60000;/);
  assert.match(hook, /if \(idle >= IdleMs\) \{\s*removalPending = true; remove = true; requested = false;/);
  assert.match(hook, /if \(remove\) \{\s*Remove\(\);/);
  assert.match(driver, /Request = request, Turn = hooks.CurrentTurn/);
  assert.match(driver, /actionTurn = job.Turn/);
  assert.match(driver, /inputBearing && job.Turn != null && job.Turn.Escaped/);
  assert.doesNotMatch(driver + hook, /AcknowledgeEscape/);
  assert.match(driver, /if \(request.Method == "turn-start" \|\| request.Method == "turn-end"\) \{\s*Json.Keys\(request.Params, "turn"\)/);
  assert.match(driver, /target.Turn != null && target.Turn.Id == id\)\s*target.Stop\(DriverInput.StopReason.Cancel\);\s*result = hooks.EndTurn\(id\)/);
  assert.match(driver, /actionHook.Activate\(actionTurn\)/);
}
const hook = () => source('direct-browser/native/win/DriverHook.cs');
const driver = () => source('direct-browser/native/win/Driver.cs');
test('native source enforces driving ownership, idle removal and immutable per-job Escape evidence', () => nativeContract(hook(), driver()));
for (const [name, target, before, after] of [
  ['arm outside turn', 'hook', 'owner == null || owner != turn ||', 'false ||'],
  ['re-arm stopped turn', 'hook', 'if (owner.Escaped)', 'if (false)'],
  ['start replay clears evidence', 'hook', 'turn != null && turn.Id == id) return', 'false) return'],
  ['reuse ended id', 'hook', 'id <= lastTurn', 'false'],
  ['evidence crosses boundary', 'hook', 'turn = new DriverTurn { Id = id }', 'turn = armedTurn'],
  ['end leaves hook', 'hook', 'if (wait) {\n                removed.Reset(); removalPending = true;', 'if (wait) {\n                removed.Reset();'],
  ['callback outside turn', 'hook', 'owner != null && Volatile.Read(ref owner.Active) != 0', 'owner != null'],
  ['idle leaves hook', 'hook', 'removalPending = true; remove = true; requested = false;', 'requested = false;'],
  ['end does not cancel old jobs', 'driver', 'target.Turn.Id == id)\n                                        target.Stop(DriverInput.StopReason.Cancel);', 'target.Turn.Id == id) {}'],
  ['job borrows next turn evidence', 'driver', 'job.Turn.Escaped', 'hooks.CurrentTurn.Escaped'],
  ['old job re-arms next turn', 'driver', 'actionHook.Activate(actionTurn)', 'actionHook.Activate(hooks.CurrentTurn)'],
]) test('native source rejects broken variant: ' + name, () => {
  let h = hook(), d = driver(); assert.ok((target === 'hook' ? h : d).includes(before));
  if (target === 'hook') h = h.replace(before, after); else d = d.replace(before, after);
  assert.throws(() => nativeContract(h, d), { code: 'ERR_ASSERTION' });
});

async function privateFrames(t, factory = createWindowsDriverClient) {
  const host = slowDriverHost(t), client = factory({ platform: 'win32', prepare: host.prepare });
  t.after(() => client.close());
  for (const method of ['turn-start', 'turn-end'])
    await assert.rejects(client.request(method, { turn: 1 }), { code: 'METHOD_NOT_FOUND' });
  assert.equal(host.children.length, 0);
  await client.getState(); assert.equal(host.frames.some(f => f.method === 'turn-start'), false);
  await client.request('typeText', { args: ['x'] });
  await client.request('typeText', { args: ['x'] });
  assert.equal(host.frames.filter(f => f.method === 'turn-start').length, 1);
  await client.endWindowsTurn();
  await client.request('typeText', { args: ['x'] });
  assert.deepEqual(host.frames.filter(f => ['turn-start', 'turn-end'].includes(f.method)).map(f => [f.method, f.params.turn]),
    [['turn-start', 1], ['turn-end', 1], ['turn-start', 2]]);
}
test('client lifecycle is private, lazy, once per turn and ordered before input', privateFrames);
test('client private-frame witness rejects model access', async t => {
  const broken = await variant('driver-client.mjs', "if (!mac && ['turn-start', 'turn-end'].includes(method))", 'if (false)');
  await assert.rejects(privateFrames(t, broken.createWindowsDriverClient), { code: 'ERR_ASSERTION' });
});

async function lostPeer(t, factory = createWindowsDriverClient) {
  const host = slowDriverHost(t), client = factory({ platform: 'win32', prepare: host.prepare });
  t.after(() => client.close());
  await client.request('typeText', { args: ['x'] });
  await client.restart();
  await client.getState(); // Reads continue after the peer is lost.
  await assert.rejects(client.request('typeText', { args: ['x'] }), { code: 'USER_STOPPED', reason: 'turn-unproven' });
  await client.endWindowsTurn();
  await client.request('typeText', { args: ['x'] });
  assert.equal(host.frames.filter(f => f.method === 'typeText').length, 2);
}
test('retiring a driving peer cannot discard unreported Escape evidence', lostPeer);
test('lost-peer witness rejects a reset bypass', async t => {
  const broken = await variant('driver-client.mjs', 'if (!mac && g.turn === windowsTurn) windowsTurnLost = true;', '');
  await assert.rejects(lostPeer(t, broken.createWindowsDriverClient), { code: 'ERR_ASSERTION' });
});
async function crossingEnds(factory = createDriverSafety) {
  const safety = factory({ platform: 'win32' }, { queue: { serial: Promise.resolve(), queued: 0 }, epoch: () => 0,
    fail: assert.fail, dispatch() {} });
  safety.windowsLifecycleAttributed();
  let release;
  const old = safety.endWindowsTurn(() => new Promise(resolve => { release = resolve; }));
  await safety.endWindowsTurn(() => {});
  safety.observeStop({ code: 'USER_STOPPED', reason: 'escape' });
  release(); await old;
  assert.throws(() => safety.checkUserStop('click'), { code: 'USER_STOPPED' });
}
test('an old end acknowledgment cannot clear a newer turn Escape', () => crossingEnds());
test('crossed-end witness rejects an old acknowledgment clearing new evidence', async () => {
  const broken = await variant('driver-safety.mjs', 'if (turn === inputTurn) userStopped = false;', 'userStopped = false;');
  await assert.rejects(crossingEnds(broken.createDriverSafety), { code: 'ERR_ASSERTION' });
});

async function session(t, { launch = runWindows, hostName = 'claude-code', endResult, endError, turnTelemetry } = {}) {
  const host = slowDriverHost(t, 'escape');
  const client = wrappedWindowsClient({ platform: 'win32', prepare: host.prepare });
  t.after(() => client.close());
  const input = new PassThrough(), output = new PassThrough(), pending = new Map();
  let id = 0;
  const write = value => input.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  output.on('data', bytes => {
    for (const line of bytes.toString().trim().split('\n')) {
      const msg = JSON.parse(line);
      if (msg.method === 'elicitation/create') write({ id: msg.id, result: { action: 'accept' } });
      else if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  const driver = { ...client, async endWindowsTurn() {
    const result = await client.endWindowsTurn();
    if (endError) { const error = endError; endError = undefined; throw error; }
    return endResult ?? result;
  } };
  const runtime = await launch({ input, output, signals: new EventEmitter(), driver,
    turnTelemetry,
    lease: { acquire: () => 'fixture', renew() {}, release() {}, close() {} },
    replOptions: { environment: () => ({ LANE_FIXTURE: '1' }) },
    setting: () => ({ enabled: false, stream: false }), discovery: { browsers: async () => [] }, paths: { cache: 'fixture' },
    relayOptions: { idleTurnEndMs: 0 } });
  t.after(() => runtime.close());
  // Relay injection is supplied by a mutated launcher in relay mutation tests.
  const request = (method, params) => new Promise(resolve => {
    pending.set(++id, resolve); write({ id, method, params });
  });
  await request('initialize', { clientInfo: { name: hostName, version: '1' }, capabilities: { elicitation: { form: {} } } });
  const tool = async (name, args = {}, meta) => (await request('tools/call', { name, arguments: args, ...meta ? { _meta: meta } : {} })).result;
  return { ...host, runtime, tool, input: async () => tool('js', { code: 'var app = await cua.getApp("Notepad"); await app.typeText("xxxx");' }),
    bootstrap: async () => JSON.parse((await tool('turn_ended', { sleight_turbo: { event: 'bootstrap' } }, MOD_META)).content[0].text).sleightTurbo };
}
const text = result => result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? '';
async function attributed(t, launch = runWindows, event = 'Stop') {
  const h = await session(t, { launch }), envelope = await h.bootstrap();
  assert.equal((await h.input()).isError, true);
  for (const args of [{}, { sleight_windows_turn_end: true }, { hook_event_name: 'Stop' },
    { hook_event_name: 'Stop', sleight_turbo: { ...envelope, event: 'end' } },
    { sleight_turbo: { ...envelope, event: 'begin', turn: 'forged', text: '', origin: 'composer', turbo: false } }]) {
    await h.tool('turn_ended', args);
    const stopped = await h.input(); assert.equal(stopped.isError, true, text(stopped));
    assert.equal(h.frames.filter(f => f.method === 'turn-end').length, 0);
    assert.equal(h.frames.filter(f => f.method === 'turn-start').length, 1);
  }
  await h.tool('turn_ended', { hook_event_name: event, sleight_turbo: { ...envelope, event: 'end' } }, MOD_META);
  const fresh = await h.input(); assert.equal(fresh.isError, false, text(fresh));
  assert.deepEqual(h.frames.filter(f => ['turn-start', 'turn-end'].includes(f.method)).map(f => [f.method, f.params.turn]),
    [['turn-start', 1], ['turn-end', 1], ['turn-start', 2]]);
}
test('production Windows relay and receiver: model calls cannot create or suppress trusted boundaries', { skip: windowsWorkerSkip, timeout: 30000 }, attributed);
test('production Windows relay and receiver also accept the attributed Interrupt end', { skip: windowsWorkerSkip, timeout: 30000 }, t => attributed(t, runWindows, 'Interrupt'));
async function unattributed(t, launch = runWindows) {
  const h = await session(t, { launch });
  const first = await h.input(); assert.equal(first.isError, true); assert.match(text(first), /start a new session/);
  await h.tool('turn_ended'); await h.tool('js_reset');
  assert.match(text(await h.input()), /start a new session/);
  // Late mod installation cannot convert an existing session stop into a turn stop.
  const envelope = await h.bootstrap();
  await h.tool('turn_ended', { hook_event_name: 'Stop', sleight_turbo: { ...envelope, event: 'end' } }, MOD_META);
  assert.match(text(await h.input()), /start a new session/);
  assert.equal(h.frames.filter(f => f.method === 'typeText').length, 1);
}
test('unattributed Escape stops the session, including after late mod bootstrap', { skip: windowsWorkerSkip, timeout: 30000 }, unattributed);
test('receiver witness rejects dropped trusted end', { skip: windowsWorkerSkip, timeout: 30000 }, async t => {
  const broken = await variant('windows-launch.mjs', 'windowsTurnEnded: args?.sleight_windows_turn_end === true', 'windowsTurnEnded: false');
  await assert.rejects(attributed(t, broken.runWindows), { code: 'ERR_ASSERTION' });
});

async function owedEnd(t, factory = createRelay) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const pending = new Map(), ends = [];
  let next = 0, fail = true;
  const write = (stream, value) => stream.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  clientOut.on('data', data => {
    for (const line of data.toString().trim().split('\n')) {
      const msg = JSON.parse(line); pending.get(msg.id)?.(msg); pending.delete(msg.id);
    }
  });
  serverIn.on('data', data => {
    for (const line of data.toString().trim().split('\n')) {
      const msg = JSON.parse(line); if (msg.id === undefined) continue;
      const end = msg.params?.name === 'turn_ended';
      if (end) ends.push(msg.params.arguments);
      const isError = end && fail; if (end) fail = false;
      write(serverOut, { id: msg.id, result: msg.method === 'initialize' ? { capabilities: { tools: {} } } : { content: [], isError } });
    }
  });
  const relay = factory({ clientIn, clientOut, serverIn, serverOut, nativeWindows: true, nativeMac: false,
    changeReview: false, inputLease: false, idleTurnEndMs: 0, warmRepl: false, warmEngine: false });
  t.after(async () => { await relay.close(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  const request = (method, params) => new Promise(resolve => { pending.set(++next, resolve); write(clientIn, { id: next, method, params }); });
  const tool = (name, args = {}) => request('tools/call', { name, arguments: args, _meta: MOD_META });
  await request('initialize', { clientInfo: { name: 'claude-code', version: '1' }, capabilities: {} });
  const boot = await tool('turn_ended', { sleight_turbo: { event: 'bootstrap' } });
  const envelope = JSON.parse(boot.result.content[0].text).sleightTurbo;
  await tool('js', { code: '1' });
  assert.equal((await tool('turn_ended', { hook_event_name: 'Stop', sleight_turbo: { ...envelope, event: 'end' } })).result.isError, true);
  assert.equal(ends.at(-1).sleight_windows_turn_end, true);
  await tool('js', { code: '2' });
  const before = ends.length; await relay.endOpenTurn();
  assert.ok(ends.length > before);
  assert.ok(ends.slice(before).every(args => args.sleight_windows_turn_end === false));
}
test('retrying an owed end cannot clear the next Windows turn', owedEnd);
test('owed-end witness rejects replaying a trusted old boundary', async t => {
  const broken = await variant('relay.mjs', 'if (nativeWindows) for (const args of owed) args.sleight_windows_turn_end = false;', '');
  await assert.rejects(owedEnd(t, broken.createRelay), { code: 'ERR_ASSERTION' });
});
test('session-stop witness rejects late-bootstrap clearing', { timeout: 30000 }, async t => {
  const broken = await variant('driver-safety.mjs', 'if (turn === inputTurn) userStopped = false;', 'if (turn === inputTurn) { userStopped = false; sessionStopped = false; }');
  const safety = broken.createDriverSafety({ platform: 'win32' }, { queue: { serial: Promise.resolve(), queued: 0 }, epoch: () => 0,
    fail: assert.fail, dispatch() { throw Object.assign(Error('stop'), { code: 'USER_STOPPED', reason: 'escape' }); } });
  await assert.rejects(safety.request('click', {})); safety.windowsLifecycleAttributed();
  await safety.endWindowsTurn(() => {});
  assert.throws(() => {
    try { safety.checkUserStop('click'); } catch (error) { assert.match(error.message, /start a new session/); return; }
    assert.fail('session stop cleared');
  }, { code: 'ERR_ASSERTION' });
});

for (const [name, before, after] of [
  ['forged relay end', 'sleight_windows_turn_end: modEnd === true', 'sleight_windows_turn_end: true'],
  ['missing attributed bootstrap', 'if (nativeWindows) nativeSession?.windowsLifecycleAttributed?.();', ''],
]) test('relay witness rejects broken variant: ' + name, { skip: windowsWorkerSkip, timeout: 30000 }, async t => {
  const original = source('relay.mjs'); assert.ok(original.includes(before));
  const changed = original.replace(before, after).replace(/from (['"])(\.[^'"]+)\1/g,
    (_, q, path) => 'from ' + q + new URL(path, new URL('relay.mjs', lib)).href + q);
  const url = 'data:text/javascript;base64,' + Buffer.from(changed).toString('base64');
  const broken = await variant('windows-launch.mjs', "from './relay.mjs'", "from '" + url + "'");
  await assert.rejects(attributed(t, broken.runWindows), { code: 'ERR_ASSERTION' });
});

const telemetryResult = {
  turn: 1, active: false, hookCallbacks: { scope: 'through-next-hook', capacity: 8192, callbacks: 3,
    sampled: 3, omitted: 0, saturated: false, samplesUs: [1, 2, 7], p50Us: 2, p99Us: 7, maxUs: 7 },
};
test('private callback samples match G3 intake without replacing a sample by a quantile', () => {
  const telemetry = windowsTurnTelemetry(telemetryResult);
  assert.deepEqual(telemetry.hookCallbacks, telemetryResult.hookCallbacks);
  assert.equal(Object.hasOwn(telemetry, 'callbackSamples'), false);
  assert.equal(windowsTurnTelemetry(undefined), undefined);
  assert.equal(windowsTurnTelemetry({ turn: 1, active: false }), undefined);
});
async function launchedTelemetry(t, launch = runWindows) {
  const records = [];
  const h = await session(t, { launch, endResult: telemetryResult, turnTelemetry: record => records.push(record) });
  const envelope = await h.bootstrap(); await h.input();
  const end = await h.tool('turn_ended', { hook_event_name: 'Stop', sleight_turbo: { ...envelope, event: 'end' } }, MOD_META);
  assert.equal(end.isError, undefined, text(end));
  assert.doesNotMatch(JSON.stringify(end), /hookCallbacks|p50Us|p99Us|maxUs|checkpointTimings/);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].hookCallbacks, telemetryResult.hookCallbacks);
  assert.equal((await h.input()).isError, false);
}
test('production mod end delivers callback telemetry privately and leaves MCP content empty', { skip: windowsWorkerSkip, timeout: 30000 }, launchedTelemetry);
test('launcher telemetry witness rejects discarding the turn result', { skip: windowsWorkerSkip, timeout: 30000 }, async t => {
  const broken = await variant('windows-launch.mjs', 'const telemetry = turnTelemetry && windowsTurnTelemetry(ended);', 'const telemetry = undefined;');
  await assert.rejects(launchedTelemetry(t, broken.runWindows), { code: 'ERR_ASSERTION' });
});
async function launchedFailure(t, launch = runWindows) {
  const h = await session(t, { launch, endError: Object.assign(Error('fixture'), { reason: 'hook-unhook-failed' }) });
  const envelope = await h.bootstrap(); await h.input();
  const end = await h.tool('turn_ended', { hook_event_name: 'Stop', sleight_turbo: { ...envelope, event: 'end' } }, MOD_META);
  assert.equal(end.isError, true); assert.match(text(end), /reason=hook-unhook-failed/);
  assert.match(text(end), /until a successful trusted turn end or a new session/);
  const refused = await h.input(); assert.equal(refused.isError, true);
  assert.match(text(refused), /reason=hook-unhook-failed/);
  assert.match(text(refused), /cleanup failed/); assert.doesNotMatch(text(refused), /reason=turn-ending/);
}
test('production mod failure exposes cleanup reason and keeps the next input closed', { skip: windowsWorkerSkip, timeout: 30000 }, launchedFailure);
test('launcher failure witness rejects the bare cleanup refusal', { skip: windowsWorkerSkip, timeout: 30000 }, async t => {
  const broken = await variant('windows-launch.mjs', 'failed(windowsTurnEndFailure(error?.reason))', "failed('Windows turn cleanup failed.')");
  await assert.rejects(launchedFailure(t, broken.runWindows), { code: 'ERR_ASSERTION' });
});
test('a failed telemetry sink cannot undo a successful trusted end', { skip: windowsWorkerSkip, timeout: 30000 }, async t => {
  const h = await session(t, { endResult: telemetryResult, turnTelemetry() { throw Error('sink unavailable'); } });
  const envelope = await h.bootstrap(); await h.input();
  const end = await h.tool('turn_ended', { hook_event_name: 'Stop', sleight_turbo: { ...envelope, event: 'end' } }, MOD_META);
  assert.equal(end.isError, undefined, text(end)); assert.equal((await h.input()).isError, false);
});
