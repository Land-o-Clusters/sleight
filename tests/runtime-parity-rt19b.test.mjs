import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { createMacDriverClient } from '../plugins/sleight/lib/mac-driver/client.mjs';
import { createOwnRuntime } from '../plugins/sleight/lib/runtime-select.mjs';
import { createRelay, screenshotFrame } from '../plugins/sleight/lib/relay.mjs';
import { InputLease, leaseKey } from '../plugins/sleight/lib/input-lease.mjs';
import { macLeaseTarget } from '../plugins/sleight/lib/mac-safety.mjs';
import { REPL_NODE_UNSUPPORTED } from '../plugins/sleight/lib/repl/client.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { PassThrough } from 'node:stream';

const text = result => result.content.filter(row => row.type === 'text').map(row => row.text).join('\n');
const binding = { windowId: '101', processStart: '100.25' };
const bounds = { x: -1440, y: -200, width: 120, height: 80 };
const windowFor = index => ({ ...binding, windowId: String(101 + index), pid: 321,
  bundleId: 'com.example.Editor', app: 'Editor', title: `Draft ${101 + index}`, bounds,
  onScreen: true, layer: 0, hidden: false });
const permissions = { app() {}, page() {}, sitesLimited: () => false };

async function build(t, root) {
  const source = macDriverSource(), entry = source.indexOf('// Source: DriverMain.swift\n');
  assert.ok(entry > 0, 'exclude the production entry point before compiling');
  const harness = await readFile(new URL('./fixtures/runtime-parity-driver.swift', import.meta.url), 'utf8');
  const path = join(root, 'parity.swift'), binary = join(root, 'parity-driver');
  await writeFile(path, source.slice(0, entry) + harness);
  const child = spawn('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc',
    '-module-cache-path', join(root, 'modules'), path, '-o', binary], { timeout: 240000, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  child.stdout.on('data', bytes => { diagnostics += bytes; });
  child.stderr.on('data', bytes => { diagnostics += bytes; });
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null, diagnostics); assert.equal(code, 0, diagnostics);
  t.diagnostic(`swiftc exit=${code}; fake-only binaryBytes=${(await stat(binary)).size}`);
  const inventory = join(root, 'inventory.json');
  await writeFile(inventory, JSON.stringify({
    apps: [{ id: 'com.example.Editor', name: 'Editor', pid: 321, processStart: binding.processStart }],
    windows: Array.from({ length: 4 }, (_, i) => windowFor(i)),
    trees: Object.fromEntries(Array.from({ length: 4 }, (_, i) => [String(101 + i), {
      AXRole: 'AXWindow', AXSubrole: 'AXStandardWindow', AXTitle: `Draft ${101 + i}`, pid: 321, frame: bounds,
      AXMinimized: false, AXFullScreen: false,
      children: [{ AXRole: 'AXButton', AXTitle: 'Save', frame: bounds }],
    }])),
  }));
  return { binary, inventory };
}

async function session(t, bank, { index = 0, directory, inputSeam = false, relay = false, frameBounds } = {}) {
  directory ??= join(await mkdtemp(join(bank.root, 'session-')), 'leases');
  let inventory = bank.inventory;
  if (frameBounds) {
    const fixture = JSON.parse(await readFile(inventory, 'utf8'));
    for (const window of fixture.windows) window.bounds = frameBounds;
    for (const tree of Object.values(fixture.trees)) {
      tree.frame = frameBounds;
      tree.children[0].frame = frameBounds;
    }
    inventory = join(await mkdtemp(join(bank.root, 'frame-')), 'inventory.json');
    await writeFile(inventory, JSON.stringify(fixture));
  }
  const helpers = [], workers = [], pending = new Map(), errors = [], actions = [];
  const lease = new InputLease({ directory, holder: `rt19b-${index}` });
  const driver = createMacDriverClient({ platform: 'darwin', prepare: async () => ({ status: 'ready', spawn({ nonce }) {
    const child = spawn('/usr/bin/nice', ['-n', '20', bank.binary, inventory], {
      env: { SLEIGHT_DRIVER_NONCE: nonce }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    helpers.push(child); return child;
  } }) });
  const runtime = createOwnRuntime({ driver, lease, approve: () => true, policy: () => ({ allow: true }),
    permissions, targetParents: () => [1], ancestry: () => [{ pid: 500, path: '/fixture/Host' }],
    replOptions: { environment: () => ({}), spawn: (...args) => { const child = fork(...args); workers.push(child); return child; } },
  });
  const safetyRequest = runtime.safety.request.bind(runtime.safety);
  if (inputSeam) runtime.safety.request = async (method, params, context) => {
    if (method !== 'click') return safetyRequest(method, params, context);
    // The production preview refuses every input. Only this test seam admits
    // fake clicks into the real Swift guard; all reads keep real parent safety.
    context.beforeRequest();
    actions.push(structuredClone(params));
    const state = await driver.request('personState', { windowId: params.windowId, processStart: params.processStart });
    try { return await driver.request(method, { ...params, personToken: state.token, read: 'none' }); }
    catch (error) { errors.push(error); throw error; }
  };
  let clientIn = runtime.serverIn, clientOut = runtime.serverOut, bridge;
  const localCalls = [];
  if (relay) {
    clientIn = new PassThrough(); clientOut = new PassThrough();
    bridge = createRelay({ clientIn, clientOut, serverIn: runtime.serverIn, serverOut: runtime.serverOut,
      nativeMac: true, nativeSession: runtime.safety, documentationTrust: runtime.documentationTrust,
      permissions, ownHostPid: () => false, changeReview: false, warmRepl: false, warmEngine: false,
      simFocusNote: false, idleTurnEndMs: 0, inputLease: lease,
      localTools: { tools: [{ name: 'drag', inputSchema: { type: 'object' } }], target: async () => ({ app: 'Editor', appId: 'com.example.Editor', title: null }),
        call: async (_name, args) => { localCalls.push(args); return { content: [] }; } },
    });
  }
  let next = 0, buffer = '';
  clientOut.setEncoding('utf8').on('data', bytes => {
    buffer += bytes;
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (!relay) runtime.safety.guardResult(message);
      const result = relay ? message.result : runtime.safety.displayResult(message.id, message.result);
      if (!relay) runtime.safety.recordDelivery(result);
      pending.get(message.id)?.(result); pending.delete(message.id);
    }
  });
  const call = (name, args = {}) => new Promise(resolve => {
    const id = ++next; pending.set(id, resolve);
    clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  const close = async () => { await bridge?.close(); await runtime.close(); if (relay) { clientIn.destroy(); clientOut.destroy(); } };
  t.after(close);
  return { runtime, driver, lease, helpers, workers, errors, actions, localCalls, close, call,
    js: code => call('js', { code }),
    acquire: () => call('js', { code: relay ? 'var app = await cua.getApp("Editor");'
      : `var app = await cua.getApp({windowId:"${101 + index}"});` }),
    control: params => driver.request('health', params),
  };
}

test('RT19B runtime parity with fake desktop providers', {
  skip: process.platform !== 'darwin' || !process.allowedNodeEnvironmentFlags.has('--allow-net') && REPL_NODE_UNSUPPORTED,
  timeout: 300000,
}, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-rt19b-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bank = { ...await build(t, root), root };

  // Removing DriverPersonWatch's input check or splitting copied request state
  // must fail these cases. A new read is required before another numeric click.
  for (const disturbance of ['key', 'pointer', 'agent-foreground']) for (const phase of ['before', 'after-down', 'after-up']) {
    await t.test(`row 32: ${disturbance} takeover ${phase} admission stops the cell and requires reread`, async t => {
      const beforeAdmission = phase === 'before', delivered = beforeAdmission ? 0 : phase === 'after-down' ? 1 : 2;
      const f = await session(t, bank, { inputSeam: true });
      assert.equal((await f.acquire()).isError, false);
      await f.control({ disturbance, beforeAdmission, afterRelease: phase === 'after-up', targetWasFront: disturbance === 'agent-foreground' });
      const result = await f.js('await app.click(1); nodeRepl.write("UNREACHED"); await app.click(1);');
      assert.equal(result.isError, true, text(result));
      assert.match(text(result), /PERSON_TOOK_OVER/); assert.match(text(result), /Stop this call/);
      assert.doesNotMatch(text(result), /UNREACHED/);
      assert.equal(f.actions.length, 1);
      assert.equal(f.errors.length, 1);
      assert.equal(f.errors[0].personTookOver, true);
      assert.equal(f.errors[0].delivery, beforeAdmission ? 'not-sent' : 'unknown');
      assert.equal(f.errors[0].retry, beforeAdmission ? 'safe' : 'read-first');
      const stats = await f.control({ disturbance: 'none', quiet: true });
      assert.equal(stats.attempts, 1); assert.equal(stats.posts, delivered);
      assert.equal(stats.copiesSharedWatch, true);
      if (!beforeAdmission) assert.equal(stats.copiesSharedAdmission, true);
      const events = stats.pointerEvents.filter(event => !event.cleanup);
      assert.deepEqual(events.map(event => [event.pid, event.windowID, event.x, event.y, event.type]),
        [[321, 101, -1380, -160, 1], [321, 101, -1380, -160, 2]].slice(0, delivered));
      assert.equal(stats.pointerEvents.filter(event => event.cleanup).length, phase === 'after-down' ? 1 : 0);
      const stale = await f.js('await app.click(1);');
      assert.equal(stale.isError, true); assert.match(text(stale), /read/i);
      assert.equal(f.actions.length, 1, 'stale map must refuse before the fake input seam');
      // The parent must observe the completed takeover before a recovery read.
      // UC2B retains that historical refusal even after the person goes quiet.
      const quiet = await f.driver.request('personState', binding);
      assert.equal(quiet.personTookOver, disturbance === 'agent-foreground');
      assert.equal(quiet.reason, disturbance === 'agent-foreground' ? 'person-took-over' : 'quiet');
      assert.equal((await f.js('await app.getAXState();')).isError, false);
      const resumed = await f.js('await app.click(1);');
      assert.equal(resumed.isError, false, text(resumed));
      assert.equal((await f.control({})).posts, delivered + 2);
    });
  }
  for (const disturbance of ['front-only', 'unrelated']) await t.test(`row 32: ${disturbance} does not claim target takeover`, async t => {
    const f = await session(t, bank, { inputSeam: true }); await f.acquire();
    await f.control({ disturbance });
    const result = await f.js('await app.click(1);');
    assert.equal(result.isError, false, text(result)); assert.equal((await f.control({})).posts, 2);
  });

  // This is a cross-module assertion, not a hand-authored frame note: real Swift
  // encoding -> runtime evidence -> relay association -> real drag conversion.
  const largeBounds = { ...bounds, width: 1280, height: 800 };
  for (const [name, scale, option, width, height, from, to, frameBounds = bounds, resizedWidth = 0] of [
    ['non-Retina', 1, 'pixel', 120, 80, [30, 20], [90, 60]],
    ['Retina', 2, 'pixel', 240, 160, [60, 40], [180, 120]],
    ['Retina normalized to points', 2, 'point', 120, 80, [30, 20], [90, 60]],
    ['oversized Retina original', 2, 'pixel', 2560, 1600, [60, 40], [180, 120], largeBounds],
    ['Retina resized from 2560 to 2000 pixels', 2, 'pixel', 2000, 1250,
      [46.875, 31.25], [140.625, 93.75], largeBounds, 2000],
  ]) await t.test(`row 36: ${name} frame and relay drag agree on a negative-origin display`, async t => {
    const f = await session(t, bank, { relay: true, frameBounds });
    const acquired = await f.acquire();
    assert.equal(acquired.isError, false, text(acquired));
    await f.control({ scale, resizedWidth });
    const capture = await f.js(`await app.getScreenshot({scale:"${option}"});`);
    assert.equal(capture.isError, false, text(capture));
    const geometry = screenshotFrame(capture.content);
    assert.deepEqual(geometry, { windowBounds: frameBounds, pixelWidth: width, pixelHeight: height,
      scaleX: width / frameBounds.width, scaleY: height / frameBounds.height });
    const image = capture.content.find(row => row.type === 'image');
    const bytes = Buffer.from(image.data, 'base64');
    assert.equal(bytes.readUInt32BE(16), width); assert.equal(bytes.readUInt32BE(20), height);
    const dragged = await f.call('drag', { app: 'Editor', from, to });
    assert.notEqual(dragged.isError, true, text(dragged));
    assert.equal(f.localCalls.length, 1);
    const request = f.localCalls[0];
    assert.deepEqual(request.screenshotFrame, geometry);
    assert.deepEqual(request.screenshotFrames, { 'Draft 101': geometry });
    assert.deepEqual(request.screenshot, [width, height]);
    const context = { ObjC: { import() {} }, request,
      bounds: { X: frameBounds.x, Y: frameBounds.y, Width: frameBounds.width, Height: frameBounds.height }, title: 'Draft 101' };
    runInNewContext(await readFile(new URL('../plugins/sleight/lib/drag.js', import.meta.url), 'utf8'), context);
    const converted = runInNewContext(`JSON.stringify({
      from: toPoints(request.from, screenshotScale(request, bounds, title)),
      to: toPoints(request.to, screenshotScale(request, bounds, title)),
      globalFrom: at(bounds, toPoints(request.from, screenshotScale(request, bounds, title))),
      globalTo: at(bounds, toPoints(request.to, screenshotScale(request, bounds, title)))})`, context);
    assert.deepEqual(JSON.parse(converted), { from: [30, 20], to: [90, 60],
      globalFrom: { x: -1410, y: -180 }, globalTo: { x: -1350, y: -140 } });
  });

  await t.test('row 37: four sessions survive one helper crash with exclusive leases', async t => {
    const directory = join(root, 'cohort-leases'), sessions = [];
    for (let index = 0; index < 4; index++) sessions.push(await session(t, bank, { index, directory }));
    for (const result of await Promise.all(sessions.map(f => f.acquire()))) assert.equal(result.isError, false, text(result));
    const keys = sessions.map((_, i) => leaseKey(macLeaseTarget(windowFor(i))));
    const tokens = sessions.map((f, i) => f.lease.owned.get(keys[i]));
    assert.equal(new Set(sessions.map(f => f.helpers[0].pid)).size, 4);
    assert.equal(new Set(sessions.map(f => f.workers[0].pid)).size, 4);
    const round = async active => {
      const results = await Promise.all(active.map(f => f.js('await app.getAXState({disableDiffing:true});')));
      for (const [i, result] of results.entries()) {
        const f = active[i], index = sessions.indexOf(f);
        assert.equal(result.isError, false, text(result)); assert.match(text(result), new RegExp(`Draft ${101 + index}`));
        assert.deepEqual([...f.lease.owned.keys()], [keys[index]]);
        assert.equal(f.lease.owned.get(keys[index]), tokens[index]);
        const record = JSON.parse(await readFile(join(directory, keys[index] + '.json'), 'utf8'));
        assert.equal(record.holder, `rt19b-${index}`); assert.equal(record.token, tokens[index]);
        assert.equal(f.helpers.length, 1); assert.equal(f.helpers[0].exitCode, null);
        assert.equal(f.workers.length, 1); assert.equal(f.workers[0].exitCode, null);
      }
    };
    for (let i = 0; i < 30; i++) await round(sessions);
    const before = await Promise.all(keys.slice(1).map(key => readFile(join(directory, key + '.json'), 'utf8')));
    await sessions[0].control({ crashNextRead: true });
    const crashed = once(sessions[0].helpers[0], 'close');
    const result = await sessions[0].js('await app.getAXState();');
    assert.equal(result.isError, true); assert.match(text(result), /DRIVER_EXIT|DRIVER_IO/);
    assert.deepEqual(await crashed, [86, null]);
    for (let i = 1; i < 4; i++) assert.equal(await readFile(join(directory, keys[i] + '.json'), 'utf8'), before[i - 1]);
    for (let i = 0; i < 10; i++) await round(sessions.slice(1));
    for (const f of sessions.slice(1)) {
      const refused = await f.js('await cua.getApp({windowId:"101"});');
      assert.equal(refused.isError, true); assert.match(text(refused), /Input lease: held by rt19b-0/);
      assert.doesNotMatch(text(refused), /standard window Draft 101/);
    }
    await sessions[0].close();
    assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.json')).sort(), keys.slice(1).map(key => key + '.json').sort());
    await round(sessions.slice(1));
    for (const f of sessions.slice(1)) await f.close();
    assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.json')), []);
    t.diagnostic('4 acquisitions + 120 concurrent reads before crash; 33 survivor reads after crash; 3 exclusive-lease refusals');
  });

  await t.test('row 44: locked input and content reads refuse, metadata reads continue, unlock resumes', async t => {
    const f = await session(t, bank);
    assert.equal((await f.acquire()).isError, false);
    const token = (await f.driver.request('personState', binding)).token;
    await f.control({ locked: true });
    await assert.rejects(f.driver.request('click', { ...binding, readId: 1, args: [1], personToken: token }), error => {
      assert.equal(error.code, 'SCREEN_LOCKED'); assert.equal(error.delivery, 'not-sent');
      assert.equal(error.retry, 'safe'); assert.equal(error.unhealthy, false); return true;
    });
    for (const code of ['await app.getAXState();', 'await app.getScreenshot();', 'await app.getAXStateAndScreenshot();']) {
      const result = await f.js(code);
      assert.equal(result.isError, true); assert.match(text(result), /SCREEN_LOCKED/);
      assert.equal(result.content.some(row => row.type === 'image'), false);
      assert.doesNotMatch(text(result), /standard window Draft/);
    }
    const inventory = await f.js('await cua.getState();');
    assert.equal(inventory.isError, false, text(inventory)); assert.match(text(inventory), /com.example.Editor/);
    const health = await f.control({});
    assert.equal(health.sessionLocked, true); assert.equal(health.attempts, 0); assert.equal(health.posts, 0);
    assert.equal(health.reads, 1); assert.equal(health.captures, 0);
    await f.control({ locked: false });
    const resumed = await f.js('await app.getAXStateAndScreenshot();');
    assert.equal(resumed.isError, false, text(resumed)); assert.match(text(resumed), /standard window Draft 101/);
    assert.equal(resumed.content.filter(row => row.type === 'image').length, 1);
    const state = await f.driver.request('personState', binding);
    const action = await f.driver.request('click', { ...binding, readId: 2, args: [1], personToken: state.token });
    assert.equal(action.delivery, 'sent-unverified'); assert.equal((await f.control({})).posts, 2);
    assert.equal(f.helpers.length, 1, 'unlock must reuse the healthy helper');
  });
});
