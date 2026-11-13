import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';
import { LIGHT_TIMING, createLightReturn, lightReturnCode, lightReturnEnabled } from '../plugins/sleight/lib/light-return.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { removeTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-light-return-')));
after(() => removeTemp(dir));

const expected = { title: 'Book1', app: 'Microsoft Excel', url: 'file:///tmp/Book1.xlsx' };
const window = { ...expected, appId: 'com.microsoft.Excel' };
const tree = (rows = '\t1 layout area Content Area') =>
  `Window: ${JSON.stringify(expected.title)}, App: ${expected.app}.\n0 standard window, URL: ${expected.url}\n${rows}`;
const sheetTree = () => `Window: "", App: ${expected.app}.\n0 sheet Save changes?\n\t1 button Cancel\n\t2 button Don't Save`;
const timing = { waitMs: 15, gapMs: 5, freshMs: 150, windowMs: 650, deadlineMs: 600, pollMs: 2 };
const ok = { status: 'ok', matches: 1, window: 1, title: expected.title, url: expected.url, focus: { sheets: 0, role: 'AXLayoutArea', subrole: null, inWindow: true } };

// The engine's handle with an observer standing in for the relay: each pressKey arms it, as the
// engine's press_key approval does, and each observation reports the window as `native(ms since the
// key)` says. `realistic` uses the shipped timing and the relay's observer defaults (80 ms delay, an
// observation every 25 ms for 700 ms). `virtualClock` gives the observer a clock that starts at the key
// and moves one tick per reading, so how many observations a burst holds, and when each began relative
// to the key, doesn't depend on how long the scheduler takes to run its timers.
function fixture({ native = () => ok, current = () => tree(), onKey = () => {}, arm = true, burstMs = 400, realistic = false, virtualClock = false } = {}) {
  const calls = [], output = [], observed = [];
  let keyAt = 0;
  const since = () => Date.now() - keyAt;
  let ticks = 0;
  const light = createLightReturn({ directory: dir, ...(virtualClock ? { now: () => keyAt + ++ticks } : {}),
    ...(realistic ? {} : { delayMs: 0, intervalMs: 4, burstMs, timing }),
    observe: async request => { observed.push(request); return native(since()); } });
  const raw = { async getAXState(options) { calls.push(['read', options]); return current(since()); },
    async getScreenshot() { calls.push(['screenshot']); return {}; } };
  for (const name of ['click', 'pressKey', 'typeText', 'paste', 'setValue']) raw[name] = async (...args) => {
    if (name === 'pressKey') keyAt = Date.now();
    if (name === 'pressKey' && arm) light.keyPressed(window.appId);
    calls.push([name, ...args]);
    if (name === 'pressKey') onKey(args[0]);
  };
  const run = async (code, options = {}) => {
    const info = light.begin(1, window);
    try {
      return await new AsyncFunction('app', 'cua', 'nodeRepl', guardedCode(code, expected, 'changed window', undefined,
        { focused: true, timing: true, ...(options.flagOff ? {} : { lightReturn: info }), ...options }))(raw, { getApp: async () => raw }, { write: v => output.push(v), emitImage: async () => {} });
    } finally {
      light.end(1);
      delete globalThis.__sleightDocumentGuard; delete globalThis.__sleightDocumentGuardSetup;
    }
  };
  const phases = () => output.filter(line => line.startsWith('[sleight:guard-timing]')).map(line => JSON.parse(line.slice(22)).phase);
  return { run, calls, output, observed, phases, reads: () => calls.filter(c => c[0] === 'read').length };
}

const entry = 'await app.typeText("A2"); await app.pressKey("Return"); await app.typeText("Apples"); await app.pressKey("Tab"); await app.typeText("8");';

test('a normal Return-then-type sequence takes one light check per key, not a full read', async () => {
  const f = fixture();
  await f.run(entry);
  // The first action's read and the after-call read; none before either typeText that followed a key.
  assert.equal(f.reads(), 2);
  assert.deepEqual(f.phases(), ['before-action', 'skipped', 'light', 'skipped', 'light', 'after-call']);
  assert.deepEqual(f.calls.filter(c => c[0] === 'typeText').map(c => c[1]), ['A2', 'Apples', '8']);
  assert.ok(f.observed.every(request => request.focus === true && request.appId === window.appId && request.title === expected.title));
});

test('with the flag off (no observer passed) every typeText after Return or Tab reads the whole tree', async () => {
  const f = fixture();
  await f.run(entry, { flagOff: true });
  assert.equal(f.reads(), 4);
  assert.ok(!f.phases().some(phase => phase.startsWith('light')));
});

test('a Return that opens a sheet still stops typeText', async () => {
  let opened = false;
  const f = fixture({ onKey: key => { if (key === 'Return') opened = true; },
    native: () => opened ? { ...ok, focus: { ...ok.focus, sheets: 1 } } : ok, current: () => opened ? sheetTree() : tree() });
  await assert.rejects(f.run('await app.pressKey("Return"); await app.typeText("secret");'), /changed window/);
  assert.deepEqual(f.calls.map(c => c[0]), ['read', 'pressKey', 'read']);
  assert.deepEqual(f.phases(), ['before-action', 'light-refused', 'before-action']);
});

test('a dialog window in front, a changed title or focus outside text refuses the light check', async () => {
  for (const reply of [{ status: 'mismatch', error: 'Focused window differs' }, { ...ok, title: 'Other' }, { ...ok, url: null },
    { ...ok, matches: 2 }, { ...ok, focus: { ...ok.focus, role: 'AXButton' } }, { ...ok, focus: { ...ok.focus, inWindow: false } },
    { ...ok, focus: { ...ok.focus, role: 'AXTextField', subrole: 'AXSecureTextField' } },
    { status: 'unknown' }]) {
    let pressed = false;
    const f = fixture({ onKey: () => { pressed = true; }, native: () => pressed ? reply : ok });
    await f.run('await app.pressKey("Return"); await app.typeText("x");');
    assert.equal(f.reads(), 3, JSON.stringify(reply));
    assert.ok(f.phases().includes('light-refused'));
  }
});

test('observations that began within waitMs of the key do not count', async () => {
  // The burst ends before waitMs has passed, so every observation is too early. The observer's clock is
  // virtual: under load a real 5 ms burst can expire before its timer fires, and then nothing is observed.
  const f = fixture({ burstMs: 5, virtualClock: true });
  await f.run('await app.pressKey("Return"); await app.typeText("x");');
  assert.ok(f.observed.length >= 1);
  assert.equal(f.reads(), 3);
  assert.deepEqual(f.phases(), ['before-action', 'light-refused', 'before-action', 'after-call']);
});

test('without any observation the call reads once at the deadline, then stops trying', async () => {
  const f = fixture({ arm: false });
  const start = Date.now();
  await f.run('await app.pressKey("Return"); await app.typeText("a"); await app.pressKey("Return"); await app.typeText("b");');
  assert.equal(f.reads(), 4);
  assert.deepEqual(f.phases(), ['before-action', 'light-refused', 'before-action', 'skipped', 'before-action', 'after-call']);
  assert.ok(Date.now() - start < 3000);
});

test('after two refusals the call reads before each typeText without waiting', async () => {
  let pressed = false;
  const f = fixture({ onKey: () => { pressed = true; }, native: () => pressed ? { ...ok, focus: { ...ok.focus, role: 'AXButton' } } : ok });
  await f.run('await app.pressKey("Return"); await app.typeText("a"); await app.pressKey("Return"); await app.typeText("b"); await app.pressKey("Return"); await app.typeText("c");');
  assert.deepEqual(f.phases(), ['before-action', 'light-refused', 'before-action', 'skipped', 'light-refused', 'before-action',
    'skipped', 'before-action', 'after-call']);
});

test('with the shipped timing a Return-then-type takes the light check, about 300 ms after the key', async () => {
  const f = fixture({ realistic: true });
  const start = Date.now();
  await f.run('await app.pressKey("Return"); await app.typeText("x");');
  assert.deepEqual(f.phases(), ['before-action', 'light', 'after-call']);
  assert.ok(Date.now() - start >= LIGHT_TIMING.waitMs + LIGHT_TIMING.gapMs);
});

test('with the shipped timing a sheet or a focus change at +200 or +300 ms after the key forces the full read', async () => {
  const sheet = { ...ok, focus: { ...ok.focus, sheets: 1 } }, button = { ...ok, focus: { ...ok.focus, role: 'AXButton' } };
  for (const at of [200, 300]) {
    const opened = ms => ms >= at && ms < 5000;
    const f = fixture({ realistic: true, native: ms => opened(ms) ? sheet : ok, current: ms => opened(ms) ? sheetTree() : tree() });
    await assert.rejects(f.run('await app.pressKey("Return"); await app.typeText("secret");'), /changed window/, `sheet at +${at} ms`);
    assert.deepEqual(f.phases(), ['before-action', 'light-refused', 'before-action'], `sheet at +${at} ms`);
    assert.ok(!f.calls.some(c => c[0] === 'typeText'));
    const g = fixture({ realistic: true, native: ms => opened(ms) ? button : ok });
    await g.run('await app.pressKey("Return"); await app.typeText("x");');
    assert.deepEqual(g.phases(), ['before-action', 'light-refused', 'before-action', 'after-call'], `focus change at +${at} ms`);
  }
});

test('a wait past the observer, a stale observation or another call between the key and the typing reads the whole tree', async () => {
  // The observer covers 700 ms after the key; an alert in a longer gap would leave no observation.
  const late = fixture({ realistic: true });
  await late.run('await app.pressKey("Return"); await new Promise(r => setTimeout(r, 800)); await app.typeText("x");');
  assert.deepEqual(late.phases(), ['before-action', 'light-refused', 'before-action', 'after-call']);
  // Inside the window, but the newest observation ended more than 150 ms ago.
  const stale = fixture({ burstMs: 60 });
  await stale.run('await app.pressKey("Return"); await new Promise(r => setTimeout(r, 300)); await app.typeText("x");');
  assert.deepEqual(stale.phases(), ['before-action', 'light-refused', 'before-action', 'after-call']);
  // Another engine call on the handle between the key and the typing.
  const between = fixture();
  await between.run('await app.pressKey("Return"); await app.getScreenshot(); await app.typeText("x");');
  assert.ok(between.calls.some(c => c[0] === 'screenshot'));
  assert.deepEqual(between.phases(), ['before-action', 'light-refused', 'before-action', 'after-call']);
});

test('careful mode and shortcuts keep their reads', async () => {
  const careful = fixture();
  await careful.run('await app.pressKey("Return"); await app.typeText("x");', { careful: true });
  assert.ok(!careful.phases().some(phase => phase.startsWith('light')));
  const shortcut = fixture();
  await shortcut.run('await app.pressKey("cmd+s"); await app.typeText("x");');
  assert.equal(shortcut.reads(), 3);
  assert.ok(!shortcut.phases().some(phase => phase.startsWith('light')));
});

test('the observer writes beside the lease, only after a key, and removes its file at the end', async () => {
  const requests = [];
  const light = createLightReturn({ directory: dir, delayMs: 0, intervalMs: 2, burstMs: 30, observe: async r => { requests.push(r); return ok; } });
  const info = light.begin('a', window);
  assert.match(info.path, /\.obs$/);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(requests.length, 0);
  light.keyPressed('another.app');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(requests.length, 0);
  light.keyPressed(window.appId);
  await new Promise(r => setTimeout(r, 60));
  assert.ok(requests.length >= 2);
  const { observations } = JSON.parse(readFileSync(info.path, 'utf8'));
  assert.ok(observations.length >= 2 && observations.length <= 8 && observations.every(o => o.status === 'ok' && o.start <= o.end));
  const settled = requests.length;
  await new Promise(r => setTimeout(r, 30));
  assert.equal(requests.length, settled, 'the burst ends');
  light.end('a');
  assert.equal(existsSync(info.path), false);
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith('light-')), []);
});

test('flag and code detection', () => {
  // Off by default until a live measurement of how late alerts and sheets appear after Return.
  assert.equal(lightReturnEnabled({}), false);
  assert.equal(lightReturnEnabled({ SLEIGHT_GUARD_LIGHT_RETURN: '0' }), false);
  assert.equal(lightReturnEnabled({ SLEIGHT_GUARD_LIGHT_RETURN: '1' }), true);
  assert.equal(lightReturnCode('await app.pressKey("Return"); await app.typeText("a");'), true);
  assert.equal(lightReturnCode("await app.pressKey('Tab'); await app.paste('a');"), true);
  assert.equal(lightReturnCode('await app.pressKey("cmd+s"); await app.typeText("a");'), false);
  assert.equal(lightReturnCode('await app.pressKey("Return");'), false);
});

test('the relay passes the observer to guarded calls only with the flag on, and arms it on press_key approvals', async t => {
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
  for (const guardLightReturn of [true, false]) {
    const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
    const sent = [], requests = [];
    serverIn.on('data', data => sent.push(...data.toString().trim().split('\n').map(line => JSON.parse(line))));
    clientOut.resume();
    const leases = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-light-relay-')));
    const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, guardLightReturn,
      windowIdentity: async request => { requests.push(request); return request.focus ? ok : { status: 'unknown' }; },
      inputLease: new InputLease({ directory: leases, holder: 'light-test' }) });
    t.after(() => { relay.dispose(); removeTemp(leases); });
    const call = (id, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
    call(1, 'let app = await cua.getApp("Microsoft Excel")'); await settle();
    serverOut.write(JSON.stringify({ id: 1, result: { content: [{ type: 'text', text: tree() }],
      _meta: { 'codex/toolSurface': { app: { appId: window.appId } } } } }) + '\n'); await settle();
    call(2, 'await app.pressKey("Return"); await app.typeText("x");'); await settle();
    const code = sent.find(message => message.id === 2)?.params.arguments.code ?? '';
    const update = JSON.parse(/__sleightDocumentGuardSetup\((\{[^\n]*\})\);/.exec(code)?.[1] ?? '{}');
    if (!guardLightReturn) { assert.equal(update.lightReturn, undefined); continue; }
    assert.ok(update.lightReturn?.path?.startsWith(leases), JSON.stringify(update.lightReturn));
    assert.equal(update.lightReturn.app, expected.app);
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 'e1', method: 'elicitation/create', params: { message: 'Allow?', mode: 'form',
      requestedSchema: { type: 'object', properties: {} }, _meta: { connector_id: 'computer-use', tool_name: 'press_key',
        tool_params: { app: window.appId }, persist: ['session'], riskLevel: 'low' } } }) + '\n');
    await new Promise(r => setTimeout(r, 250));
    assert.ok(requests.some(request => request.focus === true && request.appId === window.appId));
    assert.ok(JSON.parse(readFileSync(update.lightReturn.path, 'utf8')).observations.length >= 1);
    serverOut.write(JSON.stringify({ id: 2, result: { content: [{ type: 'text', text: tree() }] } }) + '\n'); await settle();
    assert.equal(existsSync(update.lightReturn.path), false);
  }
});
