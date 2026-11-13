import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import vm from 'node:vm';
import { createGlideStopSession } from '../plugins/sleight/lib/mac-driver/stop.mjs';
import { createMacDriverClient } from '../plugins/sleight/lib/driver-client.mjs';
import { createHandClient } from '../plugins/sleight/lib/hand/client.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { createOwnRuntime, runOwnRuntime } from '../plugins/sleight/lib/runtime-select.mjs';
import { formatMacDriverError } from '../plugins/sleight/lib/mac-driver/errors.mjs';
import { DRIVER_CORE_METHODS, DRIVER_ACTION_METHODS } from '../plugins/sleight/lib/mac-driver/protocol.mjs';
import { createDragViaDriver } from '../plugins/sleight/lib/drag-via-driver.mjs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function variant(path, before, after, exported) {
  const url = new URL(path, import.meta.url), source = readFileSync(url, 'utf8');
  assert.ok(source.includes(before), `mutation anchor absent: ${before}`);
  const changed = source.replace(before, after).replace(/(from\s*|import\s*\()(['"])(\.[^'"]+)\2/g,
    (_, prefix, quote, relative) => prefix + quote + new URL(relative, url).href + quote)
    .replace(/new URL\((['"])(\.[^'"]+)\1,\s*import.meta.url\)/g,
      (_, quote, relative) => `new URL(${JSON.stringify(new URL(relative, url).href)})`);
  return (await import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64')))[exported];
}

async function relayStop(t, create = createRelay, source = 'control') {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  let click, stops = 0, interrupts = 0, collected = 0, reports = 0;
  const session = createGlideStopSession({ control: { async beginGlideStop(_, stop) { click = stop; return () => {}; } } });
  const nativeSession = { setPolicy() {}, stop: () => { stops++; return session.stop(); },
    interrupt: () => { interrupts++; return session.interrupt(); }, setStopHandler: session.setStopHandler };
  serverIn.on('data', bytes => {
    for (const line of String(bytes).trim().split('\n')) {
      const request = JSON.parse(line);
      if (request.id !== undefined) serverOut.write(JSON.stringify({ id: request.id, result: { content: [] } }) + '\n');
    }
  });
  const received = [];
  clientOut.on('data', bytes => received.push(...String(bytes).trim().split('\n').map(JSON.parse)));
  const relay = create({ clientIn, clientOut, serverIn, serverOut, nativeMac: true, nativeSession,
    modHost: () => source === 'slash', changeReview: false, stopGraceMs: 1, stderr: { write() {} },
    stopEngine: async () => { collected++; return { collected: true }; },
    inspectRelease: async () => ({ ok: true }), onStopReported: () => { reports++; } });
  try {
    const end = await session.begin({}, () => {});
    if (source === 'control') click();
    else clientIn.write(JSON.stringify({ id: 'stop', method: 'tools/call', params: { name: 'turn_ended',
      ...source === 'slash' ? { _meta: { 'claudecode/toolUseId': 'toolu_plugin_' + 'a'.repeat(32) } } : {},
      arguments: { ...source === 'slash' ? { sleight_stop: true } : {}, hook_event_name: 'Interrupt' } } }) + '\n');
    await end();
    for (let i = 0; i < 10; i++) await tick();
    assert.equal(collected, 1, 'person control must reach interruptTurn and collect the engine');
    assert.equal(stops, source === 'esc' ? 0 : 1, 'only the person control or attributed slash sets the Stop latch');
    assert.equal(interrupts, source === 'esc' ? 1 : 0);
    assert.equal(reports, 1);
    assert.ok(received.every(row => row.id !== undefined), 'no response without a request');
  } finally { relay.dispose(); streams.forEach(stream => stream.destroy()); }
}
test('person control uses relay interruptTurn and its shared latch', relayStop);
test('slash Stop uses interruptTurn and the same active input latch', t => relayStop(t, createRelay, 'slash'));
test('Escape Interrupt collects input without a session Stop latch', t => relayStop(t, createRelay, 'esc'));
test('broken relay wiring cannot pass the person control regression', async t => {
  const create = await variant('../plugins/sleight/lib/relay.mjs', 'nativeSession?.setStopHandler?.(', 'void (', 'createRelay');
  await assert.rejects(relayStop(t, create), /person control must reach/);
});

async function sharedLatch(create = createGlideStopSession) {
  let cancelled = 0;
  const session = create({ control: { async beginGlideStop() { return () => {}; } } });
  const end = await session.begin({}, () => { cancelled++; });
  session.stop();
  assert.equal(cancelled, 1, 'relay Stop cancels the active input');
  assert.throws(session.check, { code: 'USER_STOPPED' });
  assert.equal(session.userPrompt(), false);
  assert.throws(session.check, { code: 'USER_STOPPED' }, 'a draining turn stays stopped');
  await end();
  assert.throws(session.check, { code: 'USER_STOPPED' }, 'finishing the action leaves Stop latched');
  assert.equal(session.userPrompt(), true);
  assert.doesNotThrow(session.check, 'an attributed person prompt permits later input');
}
test('relay Stop survives action completion until a person prompt', () => sharedLatch());
test('broken relay cancellation and prompt reset are rejected', async () => {
  for (const [before, after] of [['for (const operation of operations)', 'for (const operation of [])'],
    ['userPrompt: reset', 'userPrompt: () => false']]) {
    const create = await variant('../plugins/sleight/lib/mac-driver/stop.mjs', before, after, 'createGlideStopSession');
    await assert.rejects(sharedLatch(create));
  }
});

async function backstop(t, create = createMacDriverClient) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let click, started, killed;
  const began = new Promise(resolve => { started = resolve; });
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(bytes, _, done) {
    const row = JSON.parse(bytes); done();
    if (row.method === 'ping') child.stdout.write(JSON.stringify({ protocol: row.protocol, platform: 'darwin', nonce: row.nonce,
      id: row.id, ok: true, result: { protocol: row.protocol, apiVersion: 2, build: 'b'.repeat(64),
        methods: [...DRIVER_CORE_METHODS, ...DRIVER_ACTION_METHODS] } }) + '\n');
    if (row.method === 'typeText') started();
  } });
  child.kill = signal => { killed = signal; queueMicrotask(() => child.emit('close', null, signal)); };
  const client = create({ platform: 'darwin', prepare: async () => ({ status: 'ready', spawn: () => child }),
    stopControl: { async begin(_, stop) { click = stop; return () => {}; } } });
  let error;
  const call = client.request('typeText', { windowId: '7', processStart: '1.2', readId: 1, args: ['text'] }).catch(e => { error = e; });
  try {
    await began; click(); t.mock.timers.tick(499); await tick();
    assert.equal(killed, undefined);
    t.mock.timers.tick(1); await tick();
    assert.equal(killed, 'SIGKILL', 'stop backstop retires the helper at 500 ms');
    await call;
    assert.equal(error.code, 'USER_STOPPED'); assert.equal(error.unhealthy, true); assert.equal(error.delivery, 'unknown');
    assert.equal(error.stopHelperRetired, true);
    assert.match(formatMacDriverError(error), /stopHelper=retired; stopRelease=unconfirmed;/);
  } finally { await client.close(); t.mock.timers.reset(); }
}
test('parent retires a helper that never confirms stop within 500 ms', backstop);
test('broken parent deadline is rejected', async t => {
  const create = await variant('../plugins/sleight/lib/driver-client.mjs', '}, 500); // Stop release backstop',
    '}, 501); // Stop release backstop', 'createMacDriverClient');
  await assert.rejects(backstop(t, create), /500 ms/);
});

async function dragBackstop(t, create = createDragViaDriver) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let click, started, killed, error;
  const began = new Promise(resolve => { started = resolve; });
  const window = { windowId: '7', pid: 42, processStart: '1.2', bundleId: 'org.sleight.Fake', title: 'fixture', identityVerified: true };
  const run = create({ current() {}, bindings: async () => ({ source: window }),
    driver: { resolveApp: async () => ({ app: { id: window.bundleId, pid: 42, processStart: '1.2', running: true } }),
      verifyWindowIdentity: async () => ({ window }) },
    beginStop: async (_, stop) => { click = stop; return () => {}; },
    runLocal: async (_, __, options) => {
      options.run('osascript', ['-l', 'JavaScript', fileURLToPath(new URL('../plugins/sleight/lib/drag.js', import.meta.url)), '{}'], {}, () => {});
      started(); return new Promise(() => {});
    } });
  const call = run('drag.js', { app: window.bundleId, windowId: 7, from: [1, 1], to: [2, 2] }, {
    run: (_, args) => {
      const stopPath = JSON.parse(args[5].match(/,("[^"]+")\);$/)[1]);
      const root = trackTemp(dirname(stopPath));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      return { kill(signal) { killed = signal; } };
    },
  }).catch(value => { error = value; });
  try {
    await Promise.race([began, call.then(() => { throw Error('fake helper failed before start: ' + error?.message); })]);
    click(); t.mock.timers.tick(499); await tick(); assert.equal(killed, 'SIGSTOP', 'freeze only the owned child before release');
    t.mock.timers.tick(1); await tick(); assert.equal(killed, 'SIGKILL', 'stepped helper stop backstop at 500 ms');
    await call;
    assert.equal(error.code, 'USER_STOPPED'); assert.equal(error.stopHelperRetired, true);
    assert.match(error.message, /stopHelper=retired/);
  } finally { t.mock.timers.reset(); }
}
test('parent retires a stepped drag helper that never confirms Stop', dragBackstop);
test('broken stepped helper backstop is rejected', async t => {
  const create = await variant('../plugins/sleight/lib/drag-via-driver.mjs', '}, 500); // Stepped Stop backstop',
    '}, 501); // Stepped Stop backstop', 'createDragViaDriver');
  await assert.rejects(dragBackstop(t, create), /500 ms/);
});

async function noFalseStop(phase, create = createHandClient) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.pid = 999999; child.kill = () => {};
  let frame, stops = 0;
  child.stdin = new Writable({ write(bytes, _, done) {
    const row = JSON.parse(bytes); done();
    if (row.phase === 'begin') { frame = row; queueMicrotask(() => child.stdout.write(JSON.stringify({ hand: row.hand,
      nonce: row.nonce, token: row.token, phase: 'ready' }) + '\n')); }
  } });
  const client = create({ setting: () => ({ enabled: false }), permissions: null, usage: null, watch: () => undefined,
    built: () => true, prepare: async () => ({ status: 'ready', spawn: () => child }) });
  try {
    const end = await client.beginGlideStop({ windowId: '7', pid: 42 }, () => { stops++; });
    if (phase === 'death') child.emit('exit', 65);
    else if (phase === 'close') client.close();
    else child.stdout.write(JSON.stringify({ hand: frame.hand, nonce: frame.nonce, token: frame.token, phase }) + '\n');
    assert.equal(stops, 0, `${phase} is not a person Stop`);
    assert.equal(end.controlUnavailable, phase === 'control-unavailable', 'result retains control availability');
    if (phase !== 'control-unavailable') assert.equal((await end.failure).code, 'HAND_HOST_UNAVAILABLE');
    end();
  } finally { client.close(); }
}
for (const phase of ['control-unavailable', 'death', 'close']) test(`${phase} never manufactures a person Stop`, () => noFalseStop(phase));
test('broken geometry attribution is rejected by the parent', async () => {
  const create = await variant('../plugins/sleight/lib/hand/client.mjs', "event.phase === 'control-unavailable'",
    "event.phase === 'ignored-placement'", 'createHandClient');
  // The missing availability frame cannot silently pass as a working control.
  await assert.rejects(noFalseStop('control-unavailable', create), /result retains control availability/);
});

test('even a parent-marked turn completion keeps the runtime latch', async () => {
  let resets = 0;
  const runtime = createOwnRuntime({ driver: { request() {}, close() {}, restart() { resets++; }, userPrompt: () => true },
    lease: { close() {}, release() {} } });
  try {
    assert.equal(runtime.safety.stop(), true);
    assert.equal(runtime.safety.stop(), false);
    runtime.serverIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'turn_ended', arguments: {} } }) + '\n');
    await tick();
    assert.equal(runtime.safety.stop(), false, 'unmarked collection cannot clear Stop');
    runtime.serverIn.write(JSON.stringify({ id: 2, method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_glide_turn_end: true } } }) + '\n');
    await tick();
    assert.equal(runtime.safety.stop(), false, 'turn completion leaves Stop latched');
    await tick();
    assert.equal(runtime.safety.userPrompt(), true);
    assert.equal((await runtime.stopEngine()).collected, true);
    assert.equal(resets, 1);
  } finally { await runtime.close(); }
});

async function ownLauncherStop(run = runOwnRuntime) {
  const input = new PassThrough(), output = new PassThrough(), signals = new EventEmitter();
  const replies = []; let restarts = 0;
  output.on('data', bytes => replies.push(...String(bytes).trim().split('\n').map(JSON.parse)));
  const owner = await run({ input, output, signals,
    driver: { close() {}, restart() { restarts++; }, userPrompt: () => true },
    lease: { close() {}, release() {} }, policy: () => ({ allow: true }),
    permissions: { app() {}, page() {}, sitesLimited: () => false }, allowForbidden: () => false, ownHostPid: () => false,
    approvalStorage: { load: () => ({}), live: () => ({ list: () => [], allows: () => false }) }, grantAudit() {},
    relayOptions: { idleTurnEndMs: 0, runtimeHandClient: { close() {} } } });
  try {
    input.write(JSON.stringify({ id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'claude-code', title: 'Claude Code', version: '2.1.309' } } }) + '\n');
    for (let i = 0; i < 20 && !replies.some(row => row.id === 'init'); i++) await tick();
    input.write(JSON.stringify({ id: 'stop', method: 'tools/call', params: { name: 'turn_ended', _meta: { 'claudecode/toolUseId': 'toolu_plugin_' + 'a'.repeat(32) }, arguments: { sleight_stop: true } } }) + '\n');
    for (let i = 0; i < 20 && !replies.some(row => row.id === 'stop'); i++) await tick();
    assert.equal(restarts, 1, 'Stop must collect the owned driver before reporting');
    const reply = replies.find(row => row.id === 'stop');
    assert.equal(reply?.result?._meta?.['sleight/stop']?.engine, 'exited and collected');
    input.write(JSON.stringify({ id: 'later-turn', method: 'tools/call', params: { name: 'js_reset', arguments: {} } }) + '\n');
    for (let i = 0; i < 20 && !replies.some(row => row.id === 'later-turn'); i++) await tick();
    assert.equal(replies.find(row => row.id === 'later-turn')?.result?.isError, true,
      'collection cannot let the model immediately start another engine');
    input.write(JSON.stringify({ id: 'host-end', method: 'tools/call', params: { name: 'turn_ended', arguments: { hook_event_name: 'Stop' } } }) + '\n');
    for (let i = 0; i < 20 && !replies.some(row => row.id === 'host-end'); i++) await tick();
    input.write(JSON.stringify({ id: 'next-turn', method: 'tools/call', params: { name: 'js_reset', arguments: {} } }) + '\n');
    for (let i = 0; i < 20 && !replies.some(row => row.id === 'next-turn'); i++) await tick();
    assert.equal(replies.find(row => row.id === 'next-turn')?.result?.isError, true, 'an unattributed hook cannot end a person Stop');
    assert.match(replies.find(row => row.id === 'next-turn').result.content[0].text, /start a new session to continue/);
  } finally { await owner.close(); input.destroy(); output.destroy(); }
}
test('own launcher supplies collection and restart to the existing relay Stop path', () => ownLauncherStop());
test('broken own-launcher collection wiring is rejected', async () => {
  const run = await variant('../plugins/sleight/lib/runtime-select.mjs', 'stopEngine: () => runtime.stopEngine(),', '', 'runOwnRuntime');
  await assert.rejects(ownLauncherStop(run), /Stop must collect/);
});

test('per-action control round trip on a fake host sink', async t => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.pid = 999999; child.kill = () => {};
  let frames = 0;
  child.stdin = new Writable({ write(bytes, _, done) {
    const row = JSON.parse(bytes); frames++; done();
    if (row.phase === 'begin') queueMicrotask(() => child.stdout.write(JSON.stringify({ hand: row.hand,
      nonce: row.nonce, token: row.token, phase: 'ready' }) + '\n'));
  } });
  const client = createHandClient({ setting: () => ({ enabled: false }), permissions: null, usage: null, watch: () => undefined,
    built: () => true, prepare: async () => ({ status: 'ready', spawn: () => child }) });
  const session = createGlideStopSession({ control: client });
  const samples = [];
  try {
    for (let i = 0; i < 600; i++) {
      const start = performance.now();
      const end = await session.begin({ windowId: '7', pid: 42 }, () => {});
      await end();
      if (i >= 100) samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    assert.equal(samples.length, 500);
    t.diagnostic(JSON.stringify({ fakeHostRoundTrip: { samples: 500, warmup: 100, frames,
      medianMs: samples[249], p90Ms: samples[449], maxMs: samples[499], meanMs: samples.reduce((a, b) => a + b) / samples.length } }));
  } finally { client.close(); }
});

test('unavailable control reports its absence and preserves guarded input admission', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const actions = [];
  child.kill = () => { queueMicrotask(() => child.emit('close', 0)); };
  child.stdin = new Writable({ write(bytes, _, done) {
    const row = JSON.parse(bytes); done();
    if (row.control) return;
    if (row.method !== 'ping') actions.push(row);
    child.stdout.write(JSON.stringify({ protocol: row.protocol, platform: 'darwin', nonce: row.nonce, id: row.id, ok: true,
      result: row.method === 'ping' ? { protocol: row.protocol, apiVersion: 2, build: 'b'.repeat(64),
        methods: [...DRIVER_CORE_METHODS, ...DRIVER_ACTION_METHODS] } : { delivery: 'sent-unverified' } }) + '\n');
  } });
  const client = createMacDriverClient({ platform: 'darwin', prepare: async () => ({ status: 'ready', spawn: () => child }),
    stopControl: { async begin() { return Object.assign(() => {}, { controlUnavailable: true }); } } });
  try {
    for (let i = 0; i < 2; i++) {
      const result = await client.request('click', { windowId: '7', processStart: '1.2', readId: 1, args: [1] });
      assert.equal(result.stopControlUnavailable, true);
    }
    assert.equal(actions.length, 2, 'no session latch from unavailable placement');
    assert.deepEqual(actions[0].params, { windowId: '7', processStart: '1.2', readId: 1, args: [1] });
  } finally { await client.close(); }
});

test('drag protects the consent window under either driver binary name', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8');
  const line = source.match(/function ownHostLine\([^]*?\n\}/)[0];
  const body = source.match(/function ownHost\(app\) \{[^]*?\n\}/)[0];
  const evaluate = text => vm.runInNewContext(text + '; ownHost', { ObjC: { unwrap: value => value }, OWN_HOST_LINE: 'consent', GLIDE_ENGINE_LINE: 'glide' });
  const ownHost = evaluate(line + '\n' + body);
  for (const name of ['consent-host', 'glide-engine']) assert.ok(ownHost({ localizedName: name }), name);
  assert.ok(!ownHost({ localizedName: 'TextEdit' }));
  const broken = evaluate(line.replace("names.includes('glideengine')", 'false') + '\n' + body);
  assert.ok(!broken({ localizedName: 'glide-engine' }), 'broken rename loses the own-window guard');
});
