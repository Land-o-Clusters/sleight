import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { createGlideStopSession } from '../plugins/sleight/lib/mac-driver/stop.mjs';
import { createOwnRuntime } from '../plugins/sleight/lib/runtime-select.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const meta = { 'claudecode/toolUseId': 'toolu_plugin_' + 'a'.repeat(32) };
async function variant(path, before, after, name) {
  const url = new URL(path, import.meta.url), source = readFileSync(url, 'utf8');
  assert.ok(source.includes(before), 'mutation anchor missing: ' + before);
  const changed = source.replace(before, after).replace(/(from\s*|import\s*\()(['"])(\.[^'"]+)\2/g,
    (_, prefix, quote, relative) => prefix + quote + new URL(relative, url).href + quote)
    .replace(/new URL\((['"])(\.[^'"]+)\1,\s*import.meta.url\)/g,
      (_, quote, relative) => `new URL(${JSON.stringify(new URL(relative, url).href)})`);
  return (await import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64')))[name];
}
let relayCreate = createRelay, ownCreate = createOwnRuntime;
if (process.env.INT22D_MUTANT === 'b-latch') relayCreate = await variant('../plugins/sleight/lib/relay.mjs',
  'else nativeSession?.interrupt?.();', 'else nativeSession?.stop?.();', 'createRelay');
if (process.env.INT22D_MUTANT === 'b-person') relayCreate = await variant('../plugins/sleight/lib/relay.mjs',
  "const privateFrame = ['sleight_stop',", 'const privateFrame = [', 'createRelay');
if (process.env.INT22D_MUTANT === 'b-wire') ownCreate = await variant('../plugins/sleight/lib/runtime-select.mjs',
  'safety.interrupt = stopSession.interrupt;', '', 'createOwnRuntime');
if (process.env.INT22D_MUTANT === 'b-refusal') relayCreate = await variant('../plugins/sleight/lib/relay.mjs',
  'if (nativeRuntime && glideStopLatched && stopFinished)', 'if (false)', 'createRelay');

function fixture(mod = false, { inspectOk = true, releaseOk = true } = {}) {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, replies = [];
  let click, releases = 0, stops = 0, interrupts = 0, cancels = 0, reports = 0, id = 0;
  const session = createGlideStopSession({ control: { async beginGlideStop(_, stop) { click = stop; return () => {}; } },
    stopHelper: () => { releases++; }, resetHelper: () => true });
  clientOut.on('data', bytes => replies.push(...String(bytes).trim().split('\n').map(JSON.parse)));
  serverIn.on('data', bytes => {
    for (const line of String(bytes).trim().split('\n')) {
      const row = JSON.parse(line);
      if (row.id !== undefined) serverOut.write(JSON.stringify({ id: row.id, result: { content: [] } }) + '\n');
    }
  });
  const relay = relayCreate({ clientIn, clientOut, serverIn, serverOut, nativeMac: true, modHost: () => mod,
    nativeSession: { ...session, setPolicy() {},
      stop() { stops++; return session.stop(); }, interrupt() { interrupts++; return session.interrupt(); },
      cancelPending() { cancels++; } },
    ...!releaseOk ? { inputLease: { releaseChecked() { throw Error('lease release unconfirmed'); }, close() {}, release() {} } } : {},
    changeReview: false, idleTurnEndMs: 0, stopGraceMs: 1, stderr: { write() {} },
    stopEngine: async () => { await session.settled(); return { collected: true }; },
    restartEngine: async () => ({ serverIn, serverOut }), inspectInput: async () => ({ ok: inspectOk }),
    onStopReported: () => { reports++; } });
  return { session, counts: () => ({ releases, stops, interrupts, cancels, reports }),
    async call(name, args = {}, attribution) {
      const callId = ++id;
      clientIn.write(JSON.stringify({ id: callId, method: 'tools/call', params: { name, arguments: args,
        ...attribution ? { _meta: attribution } : {} } }) + '\n');
      for (let n = 0; n < 100 && !replies.some(row => row.id === callId); n++) await tick();
      const reply = replies.find(row => row.id === callId);
      assert.ok(reply, 'relay replied'); return reply;
    },
    clickControl() { click(); },
    async stop() {
      const end = await session.begin({}, () => {}); click(); await end();
      for (let n = 0; n < 100 && !reports; n++) await tick();
      assert.equal(reports, 1);
    },
    close() { relay.dispose(); streams.forEach(stream => stream.destroy()); },
  };
}

test('INT22D Interrupt cancels the current action and releases holds without latching the session', async () => {
  const f = fixture();
  try {
    let cancelled = 0;
    const end = await f.session.begin({}, () => { cancelled++; });
    const interrupt = f.call('turn_ended', { hook_event_name: 'Interrupt' });
    assert.throws(f.session.check, { code: 'USER_STOPPED' }, 'input stays blocked during release');
    await end(); await interrupt;
    assert.equal(cancelled, 1);
    assert.deepEqual(f.counts(), { releases: 1, stops: 0, interrupts: 1, cancels: 1, reports: 1 });
    assert.doesNotThrow(f.session.check, 'Interrupt must permit the next action');
    assert.notEqual((await f.call('js_reset')).result?.isError, true, 'Interrupt must not leave the relay closing');
  } finally { f.close(); }
});

test('INT22D only the person control and attributed slash Stop latch', async () => {
  for (const via of ['control', 'slash']) {
    const f = fixture(via === 'slash');
    try {
      if (via === 'control') await f.stop();
      else await f.call('turn_ended', { sleight_stop: true }, meta);
      assert.equal(f.counts().stops, 1, via);
      assert.throws(f.session.check, { code: 'USER_STOPPED' });
      for (const args of [{ hook_event_name: 'Stop' }, { hook_event_name: 'Interrupt' }, { sleight_stop: true },
        { hook_event_name: 'Stop', sleight_glide_turn_end: true }]) {
        await f.call('turn_ended', args);
        assert.throws(f.session.check, { code: 'USER_STOPPED' }, 'model calls cannot clear a person Stop');
      }
    } finally { f.close(); }
  }
});

test('INT22D a model sleight_stop cannot enter the person-only path', async () => {
  for (const mod of [false, true]) {
    const f = fixture(mod);
    try {
      const result = await f.call('turn_ended', { sleight_stop: true });
      assert.equal(result.result.isError, true, 'model Stop must be refused');
      assert.deepEqual(f.counts(), { releases: 0, stops: 0, interrupts: 0, cancels: 0, reports: 0 });
      assert.doesNotThrow(f.session.check);
    } finally { f.close(); }
  }
});

test('INT22D a person Stop during transient interruption remains latched after cleanup', async () => {
  let release;
  const session = createGlideStopSession({ control: { async beginGlideStop() { return () => {}; } },
    stopHelper: () => new Promise(resolve => { release = resolve; }) });
  const end = await session.begin({}, () => {});
  assert.equal(session.interrupt(), true); await tick();
  const first = release;
  assert.equal(session.stop(), true); await tick();
  first(); release(); await end(); await session.settled();
  assert.throws(session.check, { code: 'USER_STOPPED' });
});

test('INT22D the real runtime wires nonlatching interruption and releases its helper', async () => {
  let released = 0, resets = 0;
  const runtime = ownCreate({ driver: { request() {}, close() {}, restart() {},
    userPrompt() { resets++; return true; }, stopHeld() { released++; } }, lease: { close() {}, release() {} } });
  try {
    assert.equal(typeof runtime.safety.interrupt, 'function');
    runtime.safety.interrupt();
    await tick(); await tick();
    assert.equal(released, 1); assert.equal(resets, 1);
    assert.equal(runtime.safety.stop(), true, 'the interrupt left no persistent latch');
  } finally { await runtime.close(); }
});

test('INT22D the person control can latch while an Interrupt is collecting', async () => {
  const f = fixture();
  try {
    const end = await f.session.begin({}, () => {});
    const interrupted = f.call('turn_ended', { hook_event_name: 'Interrupt' });
    f.clickControl();
    await end(); await interrupted;
    assert.equal(f.counts().interrupts, 1);
    assert.equal(f.counts().stops, 1, 'the person Stop must survive current collection');
    assert.throws(f.session.check, { code: 'USER_STOPPED' });
    assert.equal((await f.call('js_reset')).result.isError, true);
  } finally { f.close(); }
});

test('INT22D an Interrupt with unconfirmed lease cleanup keeps the relay closed without a person latch', async () => {
  const f = fixture(false, { releaseOk: false });
  try {
    await f.call('turn_ended', { hook_event_name: 'Interrupt' });
    assert.equal(f.counts().stops, 0);
    assert.doesNotThrow(f.session.check);
    assert.equal((await f.call('js_reset')).result.isError, true, 'unconfirmed input cleanup must not resume automatically');
  } finally { f.close(); }
});


test('INT22D repeated Interrupt explains what clears a collected person Stop', async () => {
  for (const mod of [false, true]) {
    const f = fixture(mod);
    try {
      if (mod) await f.call('turn_ended', { sleight_person_prompt: 'composer' }, meta);
      await f.stop();
      const reply = await f.call('turn_ended', { hook_event_name: 'Interrupt' });
      assert.equal(reply.result.isError, true);
      assert.match(reply.result.content[0].text, mod ? /person.s next message clears Stop/ : /start a new session/,
        'a collected Stop must explain its reset rather than claim pending collection');
      assert.throws(f.session.check, { code: 'USER_STOPPED' });
      assert.equal(f.counts().interrupts, 0, 'the refused call cannot start another cleanup');
    } finally { f.close(); }
  }
});
