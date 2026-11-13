import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOwnerAwayBackend, runOwnerAway, main, WITNESS, OBSERVED_KINDS, pulseModel, observationCounts, observationSummary, engineCallKind, sittingScreenshotSize } from '../bench/runtime-owner-away.mjs';
import { startGuard, jsonChild } from '../bench/sitting-process.mjs';
import { sampleCoordinateParents, measureEngineDelivery, engineProbeAdapter } from '../bench/runtime-probe-live.mjs';

const readiness = () => ({ schema: 'sleight.input-readiness/1', drawing: false, qualification: false,
  ready: true, error: null, grants: { quartzListen: 'granted', hidListen: 'granted' },
  idleMs: { quartzHID: 10000, quartzSession: 10000, ioHIDSystem: 10000 },
  permissionRequests: 0, tapOpens: 0, deviceOpens: 0, actionCalls: 0 });

test('observation dry run records its blocked recipe with zero admissions', async () => {
  let printed;
  const log = console.log;
  try {
    console.log = value => { printed = JSON.parse(value); };
    assert.equal(await main(['--owner-away', '--sitting', '--observe-only', '--dry-run']), 0);
  } finally { console.log = log; }
  assert.equal(printed.blocked, 'HID_SOURCE_UNCONFIRMED');
  assert.equal(printed.independentHardwareProtectionRequired, true);
  assert.equal(printed.admittedEngineCalls, 0); assert.equal(printed.admittedLaunches, 0);
  assert.equal(printed.engineCalls, 30); assert.equal(printed.launches, 3);
});

const dragGeometry = { windowSize: [640, 582], from: [110, 487], to: [470, 487] };
const dragPixels = [1280, 1164];
const dragDetails = geometry => geometry ? { dragWidth: geometry.windowSize[0], dragHeight: geometry.windowSize[1],
  dragFromX: geometry.from[0], dragFromY: geometry.from[1], dragToX: geometry.to[0], dragToY: geometry.to[1] } : {};

test('drag screenshot dimensions read PNG and JPEG bytes and refuse malformed or oversized images', () => {
  const png = new Uint8Array(32), p = new DataView(png.buffer);
  p.setUint32(0, 0x89504e47); p.setUint32(4, 0x0d0a1a0a); p.setUint32(16, 1280); p.setUint32(20, 1164);
  assert.deepEqual(sittingScreenshotSize(png), dragPixels);
  assert.deepEqual(sittingScreenshotSize(new Uint8Array(png.buffer, 0, 24)), dragPixels);
  const jpeg = new Uint8Array(32), j = new DataView(jpeg.buffer);
  j.setUint16(0, 0xffd8); j.setUint16(2, 0xffc0); j.setUint16(4, 17); j.setUint16(7, 582); j.setUint16(9, 640);
  assert.deepEqual(sittingScreenshotSize(jpeg), [640, 582]);
  for (const value of [undefined, {}, [], new Uint8Array(32), png.slice(0, 23)])
    assert.throws(() => sittingScreenshotSize(value), /DRAG_SCREENSHOT_UNAVAILABLE/);
  p.setUint32(16, 20000); assert.throws(() => sittingScreenshotSize(png), /DRAG_SCREENSHOT_UNAVAILABLE/);
  j.setUint16(4, 0); assert.throws(() => sittingScreenshotSize(jpeg), /DRAG_SCREENSHOT_UNAVAILABLE/);
});

function calibration() {
  const operations = Array.from({ length: 3 }, (_, round) => OBSERVED_KINDS.map(kind => ({ kind, label: `${kind}-${round}` }))).flat();
  const resets = [];
  return { schema: 'sleight.owner-away-sitting/1', observeOnly: true, completed: true, cleanupConfirmed: true,
    finishedAt: new Date().toISOString(), metadata: { fake: true }, results: [{ evidence: { operations, resets, ...pulseModel(operations, resets) } }] };
}

for (const latencyCleanup of [true, false]) test(`real owner-away recipes with latency cleanup ${latencyCleanup}`, async () => {
  const tools = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-sit1-recipe-test-')));
  mkdirSync(join(tools, WITNESS.name + '.app/Contents/MacOS'), { recursive: true });
  writeFileSync(join(tools, 'guard'), 'never executed');
  writeFileSync(join(tools, WITNESS.name + '.app/Contents/MacOS/witness'), 'never executed');
  const calls = [], documents = [], witnesses = [];
  let contextMenuOpen = false;
  let currentWitness, selected, bank, liveEngine = 0, lockReleased = false;
  const guard = { async readiness() { return readiness(); }, records: [{ record: 'guard', stop: null }], async start() {}, async check() {}, async close() {},
    async engineWindow(fn, label) { calls.push(`window:${label}`); return fn(); },
    async quitFixtures(bundles) { calls.push('close-docs'); calls.push(...bundles.map(b => `quit:${b}`)); return { pending: [], pointerUnchanged: true, frontmostUnchanged: true }; }, async call(r) {
    calls.push(r.op === 'check' ? 'pointer-confirmed' : r.op); return { reply: r.op, pointerUnchanged: true, values: [0, 0], size: [640, 560],
      sample: { refused: false, nodes: 2, roles: r.op === 'context-menu-parent' ? ['AXMenu', 'AXApplication'] : ['AXButton', 'AXWindow'], terminal: r.op === 'context-menu-parent' ? 'AXApplication' : 'AXWindow' } };
  } };
  try {
    const backend = await createOwnerAwayBackend({ tools, out: join(tools, 'results') }, {
      platform: 'darwin', env: { CLAUDE_CONFIG_DIR: '/fixture/config' },
      temporaryRoot: tmpdir(),
      metadata: async () => ({ fake: true }), readObservation: async () => calibration(),
      startGuard: () => guard,
      acquireLiveLock: async () => async () => { lockReleased = true; },
      jsonChild: () => {
        const w = { child: { pid: 777 }, records: [],
          async wait(predicate, _timeout, from = 0) {
            if (contextMenuOpen && !this.records.slice(from).some(r => r.name === 'contextMenuClosed') && predicate({ record: 'callback', name: 'contextMenuClosed' })) { this.records.push({ record: 'callback', name: 'contextMenuClosed' }); contextMenuOpen = false; }
            const r = this.records.slice(from).find(predicate); if (!r) throw Error('FAKE_CALLBACK_MISSING'); return r; },
          send(r) {
            if (r.op === 'delivery-state') this.records.push({ record: 'callback', name: 'deliveryState', details: { onActiveSpace: true, visible: true, miniaturized: false, windowNumber: 1, ...dragDetails(dragGeometry) } });
            if (r.op === 'context-menu-open') { this.records.push({ record: 'callback', name: 'contextMenuReady' }); contextMenuOpen = true; }
            if (r.op === 'start' || r.op.startsWith('secure-')) this.records.push({ record: 'state', secureInput: r.op === 'secure-on', secureFieldFocused: r.op === 'secure-on', secureInputPID: 777 });
          }, async close() { this.records.push({ record: 'summary', status: 0 }); calls.push('witness-close'); },
        };
        w.records.push({ record: 'callback', name: 'fixtureReady' }); currentWitness = w; witnesses.push(w); return w;
      },
      openFixture: async (ctx, request) => { bank = ctx.fixtureRoot; documents.push(request); calls.push('open-document'); return { pid: 444 }; },
      closeFixtures: async () => { calls.push('close-docs'); },
      createLiveProbe: async () => ({ async close() { return { confirmed: true }; } }),
      runProbePlan: async o => { calls.push('latency-block'); assert.equal(o.sitting, true); assert.equal(liveEngine, 0); return { cleanupConfirmed: latencyCleanup, sitting: true }; },
      imageSize: () => ({ width: 1280, height: 1120 }),
      probeClient: async () => {
        liveEngine++; calls.push('engine-start');
        return { async call(_method, { code }) {
          calls.push(code);
          const app = /cua\.getApp\(("[^"]+")\)/.exec(code); if (app) selected = JSON.parse(app[1]);
          if (code.includes('["pressKey"]') && selected === WITNESS.bundle) currentWitness.records.push({ record: 'callback', name: 'save', details: {} });
          if (code.includes('["drag"]')) currentWitness.records.push({ record: 'callback', name: 'drop', details: { accepted: true } });
          const value = code.includes('getScreenshot()') ? { data: 'c3ludGhldGlj', mimeType: 'image/png' } : { text: 'Window: "SIT1-twin.txt"\n1 text entry area SIT1-twin-a', pixels: dragPixels };
          return { content: [{ type: 'text', text: 'SIT1JSON:' + JSON.stringify(value) }] };
        }, async close() { liveEngine--; calls.push('engine-close'); } };
      },
    });
    const r = await runOwnerAway({ backend });
    if (!latencyCleanup) {
      assert.equal(r.completed, false); assert.equal(r.cleanupConfirmed, false); assert.equal(lockReleased, true);
      assert.deepEqual(r.results.map(p => p.id), [1, 6]); return;
    }
    assert.equal(r.completed, true, JSON.stringify(r));
    assert.equal(r.cleanupConfirmed, true); assert.equal(lockReleased, true);
    assert.deepEqual(r.results.map(p => p.id), [1, 6, 2, 3, 4, 5, 8, 9, 10]);
    assert.equal(calls.filter(c => c.includes?.('["drag"]')).length, 3);
    for (const call of calls.filter(c => c.includes?.('["drag"]'))) assert.match(call, /\[\[220,974\],\[940,974\]\]/);
    assert.equal(calls.filter(c => c.includes?.('["scroll"]')).length, 3);
    assertCoveredInputs(calls);
    assert.equal(calls.filter(c => c.includes?.('["typeText"]')).length, 6);
    assert.equal(calls.filter(c => c.includes?.('["pressKey"]')).length, 5);
    assert.equal(calls.filter(c => c.includes?.('getScreenshot()')).length, 2);
    assert.equal(documents.filter(d => d.target.endsWith('SIT1-twin.txt')).length, 2);
    assert.equal(r.results[0].evidence.counts.saves, 3);
    assert.equal(r.results[0].evidence.counts.drops, 3);
    assert.equal(r.results[3].evidence.covers.length, 3);
    assert.equal(r.results[6].evidence.apps.length, 3);
    assert.ok(r.results[6].evidence.apps.every(app => app.sampled === 25 && app.refusals === 0));
    assert.equal(r.results[7].evidence.engineCalls, 0);
    assert.deepEqual(r.results[7].evidence.unmeasured, ['off-space', 'split-view']);
    assert.equal(r.results[7].evidence.deliveryMeasured, false);
    assert.equal(r.deliveryMeasured, false);
    assert.deepEqual(r.unmeasured, ['off-space', 'split-view']);
    assert.equal(r.results[8].evidence.menuToApplication, 3);
    assert.equal(witnesses.length, 2); assert.equal(liveEngine, 0);
  } finally { rmSync(tools, { recursive: true, force: true }); if (bank) rmSync(bank, { recursive: true, force: true }); }
});

function ownedHarness(tools, { reason, closeFails = false, pulses = 1, stopOnType = false, pointerUnchanged = true, source, observation, failMeasurement, parentSample, menuReady = true, optionalChrome, chromeReady = true, bindReplies, inputFailure, approvalParams, benchmarkAnswer, geometry = dragGeometry, pixels = dragPixels, deliveryState = {}, captureGuard } = {}) {
  const calls = [], records = [], contexts = [];
  let stopGuard, now = 0, binds = 0, witnessRows, selected;
  const dependencies = {
    platform: 'darwin', env: { CLAUDE_CONFIG_DIR: '/fixture/config' }, temporaryRoot: tools,
    now: () => now, sleep: async ms => { now += ms; }, metadata: async () => source ? { source } : { fake: true },
    printSource: value => calls.push({ source: value }), readObservation: async () => observation ?? calibration(),
    acquireLiveLock: async () => async () => { calls.push('unlock'); },
    promptHandsOff: async () => true, confirmHandsOff: async () => true,
    startGuard: (_path, options) => {
      captureGuard?.(options);
      stopGuard = options.onStop;
      if (inputFailure) {
        const result = readiness(); inputFailure(result);
        result.ready = false; result.error = result.grants.hidListen === 'denied' ? 'INPUT_GRANTS_DENIED' : 'INPUT_GRANTS_UNKNOWN';
        const source = `import { createInterface } from 'node:readline';
          const result = ${JSON.stringify(result)};
          createInterface({ input: process.stdin }).on('line', line => {
            const row = JSON.parse(line);
            console.log(JSON.stringify({ ...result, reply: row.op }));
          });`;
        return startGuard('inert', { ...options, childFactory: (_tool, _args, hooks) =>
          jsonChild(process.execPath, ['--input-type=module', '-e', source], hooks) });
      }
      return { records, async readiness() { calls.push('input-readiness'); return readiness(); }, async start() { calls.push('arm'); }, async check() { calls.push('check'); }, async close() { calls.push('guard-close'); },
        async engineWindow(operation, label) {
          calls.push(`open:${label}`);
          try { return await operation(); } finally {
            const count = typeof pulses === 'function' ? pulses(label) : pulses;
            for (let i = 0; i < count; i++) records.push({ record: 'hid-reset', label, accepted: i === 0 });
            calls.push(`close:${label}`);
          }
        },
        async call(r) {
          calls.push(r.op === 'check' ? 'pointer-confirmed' : r.op);
          if (r.op === 'bind-document' && bindReplies) {
            const reply = bindReplies[Math.min(binds++, bindReplies.length - 1)];
            if (reply.error) throw Object.assign(Error(reply.error), { reply });
            return reply;
          }
          if (r.op === 'chrome-fixture-ready') return { ready: typeof chromeReady === 'function' ? chromeReady() : chromeReady };
          if (r.op === 'optional-chrome') return optionalChrome ?? { available: false, reason: 'APP_NOT_INSTALLED' };
          if (['coordinate-parent', 'expect-context-menu'].includes(r.op) && failMeasurement) { stopGuard(failMeasurement); throw Error(failMeasurement); }
          if (['coordinate-parent', 'context-menu-parent'].includes(r.op)) return { sample: parentSample ?? { refused: false, nodes: 2, roles: ['AXMenu', 'AXApplication'], terminal: 'AXApplication' } };
          return r.op === 'fixture-frame' ? { size: [640, 560] } : { pointerUnchanged };
        },
        async quitFixtures(bundles) {
          calls.push({ quit: bundles });
          if (closeFails) throw Error('CLEANUP_SHEET_REFUSED');
          return { pending: [], pointerUnchanged: true, frontmostUnchanged: true };
        },
      };
    },
    open: async (command, args) => { assert.equal(command, '/usr/bin/open'); assert.ok(args.includes('-g')); calls.push('open-g'); },
    openFixture: async (ctx, request, options) => {
      assert.equal(ctx.ownerAway, false); assert.equal(ctx.cleanupSignal, undefined);
      contexts.push(ctx); (ctx.windowLeases ??= []).push({ async dispose() { calls.push('dispose'); return true; } });
      await options.open('/usr/bin/open', ['-g', '-a', request.app], {});
      calls.push('open-document');
      return { pid: 444 };
    },
    jsonChild: () => {
      const rows = [{ record: 'callback', name: 'fixtureReady' }]; witnessRows = rows;
      return { child: { pid: 777 }, records: rows,
        send(r) { calls.push(r.op);
          if (r.op === 'delivery-state') rows.push({ record: 'callback', name: 'deliveryState', details: { onActiveSpace: true, visible: true, miniaturized: false, windowNumber: 1, ...dragDetails(typeof geometry === 'function' ? geometry() : geometry), ...deliveryState } });
          if (r.op === 'context-menu-open') {
            if (menuReady) rows.push({ record: 'callback', name: 'contextMenuReady' });
            rows.push({ record: 'callback', name: 'contextMenuClosed' });
          }
          rows.push({ record: 'state', secureInput: r.op === 'secure-on', secureFieldFocused: r.op === 'secure-on', secureInputPID: 777 }); },
        async wait(predicate, _timeout, from = 0) { return rows.slice(from).find(predicate); },
        async close() { calls.push('witness-close'); rows.push({ record: 'summary' }); },
      };
    },
    imageSize: () => ({ width: 1280, height: 1120 }),
    ...(benchmarkAnswer ? { benchmarkDecision: () => benchmarkAnswer } : {}),
    probeClient: async (_launch, options) => {
      if (approvalParams) calls.push({ approval: options.approve(approvalParams) });
      return {
      async call(_method, { code }) {
        calls.push('engine-call'); calls.push(code);
        const app = /cua\.getApp\(("[^"]+")\)/.exec(code); if (app) selected = JSON.parse(app[1]);
        if (selected === WITNESS.bundle && code.includes('["pressKey"]')) witnessRows?.push({ record: 'callback', name: 'save', details: {} });
        if (selected === WITNESS.bundle && code.includes('["drag"]')) witnessRows?.push({ record: 'callback', name: 'drop', details: { accepted: true } });
        if (stopOnType && code.includes('["typeText"]')) { stopGuard(reason); throw Error('ENGINE_REPLY_LOST'); }
        if (reason && code.includes('cua.getApp("com.apple.calculator")')) stopGuard(reason);
        return { content: [{ type: 'text', text: 'SIT1JSON:' + JSON.stringify(code.includes('getScreenshot()') ? { data: 'eA==', mimeType: 'image/png' } : { pixels }) }] };
      }, async close() { calls.push('engine-close'); },
    }; },
  };
  return { calls, contexts, dependencies };
}
async function withHarness(options, operation) {
  const tools = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-sit1-stop-test-')));
  try {
    mkdirSync(join(tools, WITNESS.name + '.app/Contents/MacOS'), { recursive: true });
    writeFileSync(join(tools, 'guard'), 'not executable');
    writeFileSync(join(tools, WITNESS.name + '.app/Contents/MacOS/witness'), 'not executable');
    const harness = ownedHarness(tools, options);
    const backend = await createOwnerAwayBackend({ tools, observeOnly: options.observeOnly === true,
      includeChrome: options.includeChrome, ownerPresentHandsOff: options.ownerPresentHandsOff === true }, harness.dependencies);
    await operation(backend, harness);
  } finally { rmSync(tools, { recursive: true, force: true }); }
}
for (const ownerPresentHandsOff of [false, true]) test(`runtime guard explicitly opts into banners with hands-off ${ownerPresentHandsOff}`, async () => {
  let captured;
  await withHarness({ ownerPresentHandsOff, captureGuard: options => { captured = options; throw Error('GUARD_CAPTURED'); } }, async backend => {
    try {
      await assert.rejects(backend.start(), /GUARD_CAPTURED/);
      assert.equal(captured.kind, 'runtime');
      assert.equal(captured.exemptSystemOverlay, true, 'the runtime arm explicitly permits classified system banners');
      assert.equal(captured.ownerPresentHandsOff, ownerPresentHandsOff);
      assert.equal(captured.ownerConfirmed, ownerPresentHandsOff);
    } finally { await backend.close(); }
  });
});
for (const grant of ['denied', 'unknown']) test(`owner-away reports ${grant} readiness before lock, arm or ChatGPT engine startup`, async () => {
  await withHarness({ inputFailure: row => { row.grants.hidListen = grant; } }, async (backend, h) => {
    const report = await runOwnerAway({ backend });
    assert.equal(report.stop, grant === 'denied' ? 'INPUT_GRANTS_DENIED' : 'INPUT_GRANTS_UNKNOWN');
    assert.equal(report.inputReadiness.grants.hidListen, grant);
    assert.equal(report.inputReadiness.qualification, false);
    assert.equal(report.cleanupConfirmed, true); assert.equal(report.results.length, 0);
    for (const op of ['arm', 'unlock', 'engine-call', 'engine-start', 'open-g']) assert.ok(!h.calls.includes(op));
    for (const key of ['permissionRequests', 'tapOpens', 'deviceOpens', 'actionCalls']) assert.equal(report.inputReadiness[key], 0);
    await assert.rejects(() => backend.check(), new RegExp(report.stop));
  });
});
for (const reason of ['TIMED_WINDOW_HOLD', 'PERMISSION_PROMPT', 'PERSON_ACTIVE']) {
  test(`${reason} collects helpers, quits all three owned apps and releases the lock`, async () => {
    await withHarness({ reason }, async (backend, h) => {
      const report = await runOwnerAway({ backend: { ...backend, probe: () => backend.probe({ id: 5 }) } });
      assert.equal(report.stop, reason); assert.equal(report.completed, false); assert.equal(report.cleanupConfirmed, true);
      const lastEngine = h.calls.lastIndexOf('engine-call'), cleanup = h.calls.slice(lastEngine + 1);
      assert.ok(cleanup.includes('dispose')); assert.equal(h.calls.filter(c => c === 'engine-close').length, 1);
      const quit = cleanup.filter(c => c?.quit).flatMap(c => c.quit);
      for (const bundle of ['com.apple.TextEdit', 'com.apple.calculator', WITNESS.bundle]) assert.ok(quit.includes(bundle));
      assert.equal(h.calls.at(-1), 'unlock');
      assert.equal(report.cleanup.desktop.pointerUnchanged, true); assert.equal(report.cleanup.desktop.frontmostUnchanged, true);
      for (let i = 0; i < h.calls.length; i++) if (h.calls[i] === 'open-g') {
        assert.match(h.calls[i - 1], /^open:open-g-/); assert.match(h.calls[i + 1], /^close:open-g-/);
      }
    });
  });
}
test('stop plus an unconfirmed native quit releases its lock after collecting children', async () => {
  await withHarness({ reason: 'PERSON_ACTIVE', closeFails: true }, async (backend, h) => {
    const report = await runOwnerAway({ backend: { ...backend, probe: () => backend.probe({ id: 5 }) } });
    assert.equal(report.cleanupConfirmed, false); assert.ok(h.calls.includes('unlock'));
    assert.ok(h.calls.includes('witness-close')); assert.ok(h.calls.includes('guard-close'));
  });
});
function assertCoveredInputs(calls) {
  let documentOpen = false, covered = false, reacquired = false, pointer = false, checked = 0;
  for (const call of calls) {
    if (call === 'expect-document' || call === 'close-docs' || call?.quit) { documentOpen = false; covered = false; reacquired = false; pointer = false; }
    if (call === 'open-document') documentOpen = true;
    if (call === 'place-cover') { assert.equal(documentOpen, true); covered = true; reacquired = false; pointer = false; }
    if (typeof call === 'string' && call.includes(`cua.getApp("${WITNESS.bundle}")`) && covered) reacquired = true;
    if (call === 'pointer-confirmed' && reacquired) pointer = true;
    if (typeof call === 'string' && /\["(?:scroll|drag)"\]/.test(call)) {
      assert.equal(covered && reacquired && pointer, true, call); checked++;
    }
  }
  assert.equal(checked, 6);
}
for (const [field, choice] of [['remember', 'This session'], ['choice', 'session']]) test(`backend accepts only the benchmark session answer for ${field}`, async () => {
  const approvalParams = { message: 'Allow Computer Use to use "Calculator"?', mode: 'form', requestedSchema: {
    properties: { [field]: { enum: [choice, 'Always'] } }, required: [field],
  } };
  await withHarness({ approvalParams }, async (backend, h) => {
    await backend.start(); await backend.probe({ id: 5 }); await backend.close();
    assert.deepEqual(h.calls.find(c => c?.approval)?.approval, { action: 'accept', content: { [field]: choice } });
  });
  for (const action of ['decline', 'accept']) await withHarness({ approvalParams,
    benchmarkAnswer: { hookSpecificOutput: { action, content: { [field]: action === 'accept' ? 'Always' : choice } } },
  }, async backend => {
    try { await assert.rejects(backend.start(), /APPROVAL_REFUSED/); } finally { await backend.close(); }
  });
});

test('zero-reset sitting sends screenshot-scaled drag points', async () => {
  await withHarness({}, async (backend, h) => {
    await backend.start();
    try {
      const evidence = await backend.probe({ id: 1 });
      assert.deepEqual(evidence.counts, { singleClicks: 3, doubleClicks: 3, chords: 3, textCalls: 3, drags: 3, fieldSetupClicks: 1, saves: 3, drops: 3 });
    } finally { await backend.close(); }
    assert.equal(h.calls.filter(c => typeof c === 'string' && c.includes('var sitDragShot')).length, 3);
    const drags = h.calls.filter(c => typeof c === 'string' && c.includes('["drag"]'));
    assert.equal(drags.length, 3);
    for (const call of drags) assert.match(call, /\[\[220,974\],\[940,974\]\]/);
  });
});

for (const geometry of [undefined, { ...dragGeometry, from: [-1, 487] }, { ...dragGeometry, windowSize: [0, 582] }]) {
  test(`missing or invalid drag geometry stops before drag: ${JSON.stringify(geometry)}`, async () => {
    await withHarness({ geometry: geometry ?? null }, async (backend, h) => {
      await backend.start();
      try { await assert.rejects(backend.probe({ id: 1 }), /DRAG_GEOMETRY/); }
      finally { await backend.close(); }
      assert.equal(h.calls.filter(c => typeof c === 'string' && c.includes('["drag"]')).length, 0);
    });
  });
}
for (const [name, options, error] of [
  ['changed geometry', () => {
    let reads = 0;
    return { geometry: () => ({ ...dragGeometry, to: [470 + reads++, 487] }) };
  }, 'DRAG_GEOMETRY_CHANGED'],
  ['mismatched screenshot aspect', () => ({ pixels: [1280, 900] }), 'DRAG_GEOMETRY_SCALE'],
  ...[80, 2000].map(size => [`scale outside range: ${size}/400`, () => ({
    geometry: { windowSize: [400, 400], from: [100, 100], to: [300, 300] }, pixels: [size, size],
  }), 'DRAG_GEOMETRY_SCALE']),
  ...['from', 'to'].flatMap(endpoint => [0, 1].flatMap(axis => [0, 1].map(past => [
    `${endpoint} axis ${axis} ${past ? 'past' : 'at'} window edge`,
    () => ({ geometry: { ...dragGeometry, [endpoint]: dragGeometry[endpoint].map((n, i) => i === axis ? dragGeometry.windowSize[i] + past : n) } }),
    'DRAG_GEOMETRY_UNAVAILABLE',
  ]))),
  ...[ ['invisible', { visible: false }], ['minimized', { miniaturized: true }], ['missing window identity', { windowNumber: 0 }] ].map(([name, deliveryState]) => [name, () => ({ deliveryState }), 'DRAG_GEOMETRY_UNAVAILABLE']),
  ...['from', 'to'].flatMap(endpoint => [0, 1].map(axis => [
    `${endpoint} axis ${axis} at zero`, () => ({ geometry: { ...dragGeometry, [endpoint]: dragGeometry[endpoint].map((n, i) => i === axis ? 0 : n) } }), 'DRAG_GEOMETRY_UNAVAILABLE',
  ])),
  ['other Space', () => ({ deliveryState: { onActiveSpace: false } }), 'DRAG_GEOMETRY_UNAVAILABLE'],
  ...[null, {}, [1280], [1280, 1164, 1], [1280.5, 1164], [0, 0], [20000, 18188]].map(pixels => [
    `invalid screenshot dimensions: ${JSON.stringify(pixels)}`, () => ({ pixels }), 'DRAG_GEOMETRY_CHANGED',
  ]),
]) test(`${name} refuses before sending drag input`, async () => {
  await withHarness(options(), async (backend, h) => {
    await backend.start();
    try { await assert.rejects(backend.probe({ id: 1 }), { message: error }); }
    finally { await backend.close(); }
    assert.equal(h.calls.filter(c => typeof c === 'string' && c.includes('["drag"]')).length, 0);
    assert.equal(h.calls.filter(c => c === 'engine-close').length, 1);
  });
});

for (const pulses of [1, 2]) test(`unattended observation with ${pulses} expected pulses refuses without independent hardware protection`, async () => {
  await withHarness({ pulses, observeOnly: true }, async (backend, h) => {
    const report = await runOwnerAway({ backend, observeOnly: true });
    assert.equal(report.stop, 'HID_SOURCE_UNCONFIRMED'); assert.equal(report.completed, false);
    assert.equal(report.inputReadiness.ready, true); assert.equal(report.inputReadiness.qualification, false);
    assert.equal(h.calls.filter(c => c === 'engine-call').length, 0);
    assert.ok(!h.calls.includes('arm')); assert.ok(!h.calls.includes('unlock'));
    assert.equal(report.cleanupConfirmed, true);
  });
});
test('sitting refuses scroll and drag if the pointer changed after cover acquisition', async () => {
  await withHarness({ pointerUnchanged: false }, async (backend, h) => {
    const report = await runOwnerAway({ backend });
    assert.equal(report.stop, 'POINTER_CHANGED');
    assert.ok(!h.calls.some(c => typeof c === 'string' && /\["(?:scroll|drag)"\]/.test(c)));
    assert.equal(report.cleanupConfirmed, true);
  });
});
test('dirty observation prints its source and refuses before engine or guard startup', async () => {
  const source = { sleightCommit: 'test-sha', sleightDirty: true };
  await withHarness({ source }, async (backend, h) => {
    const report = await runOwnerAway({ backend, observeOnly: true });
    assert.equal(report.stop, 'CLEAN_SOURCE_REQUIRED');
    assert.deepEqual(h.calls.find(c => c?.source), { source });
    assert.ok(!h.calls.includes('arm')); assert.ok(!h.calls.includes('engine-call'));
  });
});
// A stable zero is a valid measurement (reads and background clicks leave HID idle alone). The guard then accepts no
// reset for that kind, so person input during it stops the sitting (sleight-arch, 2026-11-01, replacing the zero refusal).
for (const kind of OBSERVED_KINDS) test(`sitting accepts a stable zero reset count for ${kind}`, () => {
  const observation = calibration(), evidence = observation.results[0].evidence;
  evidence.resets = evidence.resets.filter(r => !r.label.startsWith(kind + '-'));
  Object.assign(evidence, pulseModel(evidence.operations, evidence.resets));
  assert.equal(observationSummary(observation).sittingReady, true);
  assert.equal(observationSummary(observation).resetCounts[kind], 0);
  assert.equal(observationCounts(observation, observation.metadata)[kind], 0);
});
test('observation summary prints all measured arrays and the sitting-consumed counts', () => {
  const report = calibration(), printed = JSON.parse(JSON.stringify(observationSummary(report)));
  assert.equal(printed.sittingReady, true);
  assert.deepEqual(printed.resetCounts, observationCounts(report, report.metadata));
  for (const kind of OBSERVED_KINDS) assert.deepEqual(printed.perKind[kind], { counts: [0, 0, 0], stable: true });
});
test('sitting recomputes unstable observation counts before guard startup', async () => {
  const observation = calibration();
  // Leave the reported stable flag and accepted counts intact, but break one
  // round's underlying evidence. Startup must use the measured reset records.
  observation.results[0].evidence.resets.push({ label: 'click-0' });
  await withHarness({ observation }, async (backend, h) => {
    const report = await runOwnerAway({ backend });
    assert.equal(report.stop, 'HID_PULSE_MODEL_UNCONFIRMED');
    assert.ok(!h.calls.includes('arm')); assert.ok(!h.calls.includes('engine-call'));
  });
});
test('guard call windows include the reply tail on success and failure', async () => {
  const calls = [];
  const guard = startGuard('unused', { kind: 'runtime', resetCounts: { engine: 0 }, childFactory: (_tool, _args, options) => ({
    async call(row) {
      calls.push(row);
      if (row.op === 'input-readiness') return readiness();
      if (['arm', 'check'].includes(row.op)) options.onRecord({ record: 'guard', stop: null });
      return { tailMs: 150 };
    }, async close() {},
  }) });
  try {
    await guard.start();
    for (const failed of [false, true]) {
      const began = performance.now();
      const result = guard.engineWindow(async () => { calls.push('engine'); if (failed) throw Error('ENGINE_FAILED'); return 42; });
      if (failed) await assert.rejects(result, /ENGINE_FAILED/); else assert.equal(await result, 42);
      assert.ok(performance.now() - began >= 145);
    }
    assert.deepEqual(calls.filter(c => c === 'engine' || c.op === 'engine-window').map(c => c === 'engine' ? c : c.open), [true, 'engine', false, true, 'engine', false]);
  } finally { await guard.close(); }
});
test('latency engine acquisition and reads use the sitting window hook', async () => {
  const labels = [];
  const driver = engineProbeAdapter({ async call() { return { content: [{ type: 'text', text: 'RT13JSON:{"text":"fixture"}' }] }; } }, {
    splitAcquisition: true,
    engineWindow: async (operation, label, kind) => { labels.push([label, kind]); return operation(); },
  });
  await driver.acquire('com.apple.TextEdit'); await driver.read(false); await driver.read(true);
  assert.deepEqual(labels, ['getApp', 'read', 'read', 'combined-read'].map(kind => ['latency-engine', kind]));
});
test('observations reject unstable counts, outside resets and incomplete kind coverage', () => {
  const good = calibration(), evidence = good.results[0].evidence;
  assert.deepEqual(observationCounts(good, { fake: true }), evidence.resetCounts);
  for (const mutate of [
    r => { r.results[0].evidence.resets.push({ label: 'click-0' }); },
    r => { r.results[0].evidence.resets.push({ label: 'outside' }); },
    r => { r.results[0].evidence.operations.pop(); },
    r => { r.cleanupConfirmed = false; },
    r => { r.metadata = { fake: false }; },
    r => { r.finishedAt = '2000-01-01'; },
    r => { r.results[0].evidence.resetCounts.click = 20; },
  ]) {
    const bad = structuredClone(good); mutate(bad);
    assert.throws(() => observationCounts(bad, { fake: true }), /HID_OBSERVATION_REQUIRED|HID_PULSE_MODEL_UNCONFIRMED/);
  }
  const dirty = structuredClone(good); dirty.metadata.source = { sleightCommit: 'fixed', sleightDirty: true };
  assert.throws(() => observationCounts(dirty, dirty.metadata), /HID_OBSERVATION_REQUIRED/);
});
test('pulse counts allow zero and multiple resets only when each kind is stable', () => {
  const { operations } = calibration().results[0].evidence;
  const resets = operations.flatMap(op => Array.from({ length: op.kind === 'read' ? 0 : op.kind === 'drag' ? 3 : 1 }, () => ({ label: op.label })));
  const model = pulseModel(operations, resets);
  assert.equal(model.stable, true); assert.equal(model.resetCounts.read, 0); assert.equal(model.resetCounts.drag, 3);
  resets.push({ label: operations.find(op => op.kind === 'drag').label });
  assert.equal(pulseModel(operations, resets).stable, false);
});
test('double clicks have a separate kind from single clicks', () => {
  assert.equal(engineCallKind('await sitApp["click"](...[{"id":"x"},{"clickCount":2}])'), 'double-click');
  assert.equal(engineCallKind('await sitApp["click"](...[{"id":"x"}])'), 'click');
  assert.throws(() => engineCallKind('await sitApp["newMethod"]()'), /HID_KIND_UNMEASURED/);
});
test('the guard forwards zero allowance and refuses an unmeasured kind before dispatch', async () => {
  const calls = [];
  const guard = startGuard('unused', { kind: 'runtime', resetCounts: { drag: 0 }, childFactory: (_tool, _args, options) => ({
    async call(row) { calls.push(row); if (row.op === 'input-readiness') return readiness(); if (['arm', 'check'].includes(row.op)) options.onRecord({ record: 'guard', stop: null }); return { tailMs: 0 }; }, async close() {},
  }) });
  try {
    await guard.start(); await guard.engineWindow(async () => {}, 'drag-1', 'drag');
    assert.equal(calls.find(r => r.op === 'engine-window' && r.open).allowance, 0);
    let dispatched = false;
    await assert.rejects(guard.engineWindow(async () => { dispatched = true; }, 'key-1', 'key'), /HID_KIND_UNMEASURED/);
    assert.equal(dispatched, false);
  } finally { await guard.close(); }
});
test('unattended observation refuses before collecting an unstable count', async () => {
  let seen = 0;
  await withHarness({ observeOnly: true, pulses: () => ++seen }, async backend => {
    const report = await runOwnerAway({ backend, observeOnly: true });
    assert.equal(report.completed, false); assert.equal(report.stop, 'HID_SOURCE_UNCONFIRMED');
    assert.equal(seen, 0); assert.equal(report.results.length, 0);
  });
});
test('TextEdit edit intent precedes dispatch and stop releases secure input before engine shutdown', async () => {
  await withHarness({ reason: 'PERSON_ACTIVE', stopOnType: true }, async (backend, h) => {
    const report = await runOwnerAway({ backend: { ...backend, probe: () => backend.probe({ id: 2 }) } });
    assert.equal(report.stop, 'PERSON_ACTIVE');
    const intent = h.calls.indexOf('fixture-write'), dispatched = h.calls.indexOf('engine-call', intent);
    assert.ok(intent >= 0 && dispatched > intent);
    const off = h.calls.indexOf('secure-off');
    assert.ok(off > dispatched && off < h.calls.indexOf('engine-close'));
  });
});


// OS2 uses the real recipe with fake host, engine and guard transports.
test('coordinate probe reports 75 samples and four explicit optional-app skips', async () => {
  await withHarness({}, async (backend, h) => {
    await backend.start();
    try {
      const value = await backend.probe({ id: 8 });
      assert.deepEqual(value.apps.map(app => [app.sampled, app.refusals, app.refusalRate, app.inputCalls]), [[25, 0, 0, 0], [25, 0, 0, 0], [25, 0, 0, 0]]);
      assert.equal(value.skipped.length, 4);
      assert.ok(value.skipped.every(app => app.sampled === 0 && app.refusalRate === null));
      assert.equal(h.calls.filter(c => c === 'coordinate-parent').length, 75);
      assert.ok(!h.calls.some(c => typeof c === 'string' && /\["(?:click|typeText)"\]/.test(c)));
    } finally { await backend.close(); }
  });
});
for (const reason of ['HIT_UNAVAILABLE', 'PARENT_UNAVAILABLE', 'PARENT_CYCLE', 'FOREIGN_PID', 'ROLE_UNAVAILABLE', 'PARENT_LIMIT', 'AX_TIMEOUT']) {
  test(`coordinate refusal ${reason} has a measured denominator`, async () => {
    let count = 0;
    const value = await sampleCoordinateParents({ bundle: WITNESS.bundle, check: async () => {}, sample: async () => ({ sample: {
      refused: count++ % 5 === 0, nodes: 1, roles: ['AXButton'], reason,
    } }) });
    assert.equal(value.sampled, 25); assert.equal(value.refusals, 5); assert.equal(value.refusalRate, 0.2);
  });
}
test('malformed coordinate sample stops instead of manufacturing a zero refusal rate', async () => {
  await assert.rejects(sampleCoordinateParents({ bundle: WITNESS.bundle, check: async () => {}, sample: async () => ({ sample: { refused: false, nodes: 67, roles: [] } }) }), /PARENT_SAMPLE_INVALID/);
});
for (const id of [8, 10]) for (const reason of ['TIMED_WINDOW_HOLD', 'PERSON_ACTIVE', 'FOREIGN_WINDOW', 'PERMISSION_PROMPT']) {
  test(`probe ${id} stops on ${reason} before later samples or menu opening`, async () => {
    await withHarness({ failMeasurement: reason }, async (backend, h) => {
      await backend.start();
      try {
        await assert.rejects(backend.probe({ id }), new RegExp(reason));
        assert.equal(h.calls.includes('context-menu-open'), false);
        assert.ok(h.calls.filter(c => c === 'coordinate-parent').length <= 1);
      } finally { await backend.close(); }
    });
  });
}
for (const parentSample of [
  { refused: false, nodes: 2, roles: ['AXMenu', 'AXApplication'], terminal: 'AXApplication' },
  { refused: true, nodes: 1, roles: ['AXMenu'], reason: 'PARENT_UNAVAILABLE' },
  { refused: true, nodes: 0, roles: [], reason: 'MENU_UNAVAILABLE' },
]) test(`context-menu probe records application reachability: ${parentSample.terminal ?? parentSample.reason}`, async () => {
  await withHarness({ parentSample }, async (backend, h) => {
    await backend.start();
    try {
      const value = await backend.probe({ id: 10 });
      const reached = parentSample.terminal === 'AXApplication';
      assert.equal(value.sampled, 3); assert.equal(value.inputCalls, 0);
      assert.equal(value.menuToApplication, reached ? 3 : 0); assert.equal(value.refusalRate, reached ? 0 : 1);
      assert.ok(h.calls.indexOf('expect-context-menu') < h.calls.indexOf('context-menu-open'));
      assert.ok(!h.calls.some(c => typeof c === 'string' && /\["(?:click|pressKey)"\]/.test(c)));
    } finally { await backend.close(); }
  });
});
test('menu that cannot open in the background reports zero samples and a null rate', async () => {
  await withHarness({ menuReady: false }, async (backend) => {
    await backend.start();
    try {
      const value = await backend.probe({ id: 10 });
      assert.equal(value.sampled, 0); assert.equal(value.refusalRate, null); assert.equal(value.reason, 'BACKGROUND_MENU_UNAVAILABLE');
    } finally { await backend.close(); }
  });
});
function deliveryFake({ active = false, received = true, stop, change = false } = {}) {
  const rows = [], actions = []; let checks = 0, states = 0, length = 0;
  return { actions, options: { engineOnly: true, records: () => rows,
    check: async () => { if (stop && ++checks === 3) throw Error(stop); },
    state: async () => ({ onActiveSpace: change && ++states > 2 ? true : active, visible: true, miniaturized: false, windowNumber: 10 }),
    action: async (method, value) => {
      actions.push(method);
      if (received && method === 'click' && value.id === 'probe-button') rows.push({ record: 'callback', name: 'button', target: 'probe-button' });
      if (received && method === 'typeText') { length += value.length; rows.push({ record: 'callback', name: 'textChange', target: 'plain', details: { length } }); }
    },
  } };
}
for (const received of [true, false]) test(`engine-only off-Space delivery reports arrivals ${received}`, async () => {
  const fake = deliveryFake({ received }), value = await measureEngineDelivery(fake.options);
  assert.equal(value.engineCalls, 9); assert.equal(value.trials.length, 3);
  assert.deepEqual(value.states.map(s => s.attempts), [3, 0]);
  assert.deepEqual(value.unmeasured, ['split-view']); assert.equal(value.deliveryMeasured, true);
  assert.equal(value.states[0].clicksReceived, received ? 3 : 0); assert.equal(value.states[0].typesReceived, received ? 3 : 0);
  assert.deepEqual(fake.actions, Array(3).fill(['click', 'click', 'typeText']).flat());
});
test('active Space and Split View list attended steps with zero engine inputs', async () => {
  const fake = deliveryFake({ active: true }), value = await measureEngineDelivery(fake.options);
  assert.equal(value.engineCalls, 0); assert.equal(fake.actions.length, 0);
  assert.ok(value.states.every(s => s.status === 'attended' && s.attempts === 0));
  assert.deepEqual(value.unmeasured, ['off-space', 'split-view']);
  assert.equal(value.deliveryMeasured, false);
});
test('delivery refuses runtime input and unknown state before dispatch', async () => {
  const fake = deliveryFake();
  await assert.rejects(measureEngineDelivery({ ...fake.options, engineOnly: false }), /ENGINE_ONLY_REQUIRED/);
  await assert.rejects(measureEngineDelivery({ ...fake.options, state: async () => ({}) }), /DELIVERY_STATE_UNAVAILABLE/);
  assert.equal(fake.actions.length, 0);
});
for (const stop of ['TIMED_WINDOW_HOLD', 'PERSON_ACTIVE', 'FOREIGN_WINDOW', 'PERMISSION_PROMPT']) {
  test(`delivery stops on ${stop} without replay`, async () => {
    const fake = deliveryFake({ stop });
    await assert.rejects(measureEngineDelivery(fake.options), new RegExp(stop));
    assert.ok(fake.actions.length <= 1);
  });
}
test('Space change during delivery stops before typing and retains the attempted click', async () => {
  const fake = deliveryFake({ change: true }), evidence = { trials: [] };
  await assert.rejects(measureEngineDelivery({ ...fake.options, evidence }), /DELIVERY_STATE_CHANGED/);
  assert.deepEqual(fake.actions, ['click']); assert.equal(evidence.trials[0].engineCalls, 1);
});

for (const reason of ['APP_ALREADY_RUNNING', 'APP_NOT_INSTALLED']) test(`optional Chrome skips ${reason} without acquisition or quit`, async () => {
  await withHarness({ includeChrome: true, optionalChrome: { available: false, reason } }, async (backend, h) => {
    await backend.start();
    const value = await backend.probe({ id: 8 });
    assert.equal(value.apps.length, 3);
    assert.equal(value.skipped.find(app => app.bundle === 'com.google.Chrome').reason, reason);
    await backend.close();
    assert.ok(!h.calls.some(c => typeof c === 'string' && c.includes('cua.getApp("com.google.Chrome")')));
    assert.ok(!h.calls.some(c => c?.quit?.includes('com.google.Chrome')));
  });
});
test('optional Chrome uses a fresh profile, 25 read-only samples and owned cleanup', async () => {
  await withHarness({ includeChrome: true, optionalChrome: { available: true } }, async (backend, h) => {
    const launched = [];
    // The harness's open fake asserts -g and never starts an application.
    const originalOpen = h.dependencies.open;
    h.dependencies.open = async (command, args, options) => { launched.push(args); return originalOpen(command, args, options); };
    await backend.start();
    const value = await backend.probe({ id: 8 });
    assert.equal(value.apps.length, 4); assert.equal(value.apps[3].bundle, 'com.google.Chrome');
    assert.equal(value.apps[3].sampled, 25); assert.equal(value.skipped.length, 3);
    const args = launched.find(args => args.includes('com.google.Chrome'));
    assert.ok(args.includes('-n')); assert.ok(args.some(arg => arg.startsWith('--user-data-dir=')));
    for (const flag of ['--use-mock-keychain', '--password-store=basic', '--disable-sync', '--disable-background-networking',
      '--no-first-run', '--no-default-browser-check']) assert.ok(args.includes(flag), flag);
    assert.ok(args.at(-1).endsWith('SIT1-chrome.html'));
    assert.ok(h.calls.some(c => c?.quit?.join() === 'com.google.Chrome'));
    assert.equal(h.calls.filter(c => c === 'coordinate-parent').length, 100);
    await backend.close();
  });
});

test('default sitting skips even an available Chrome before checking or launching it', async () => {
  await withHarness({ optionalChrome: { available: true } }, async (backend, h) => {
    await backend.start();
    const value = await backend.probe({ id: 8 });
    assert.equal(value.apps.length, 3);
    assert.equal(value.skipped.find(app => app.bundle === 'com.google.Chrome').reason, 'PROMPT_FREE_LAUNCH_UNVERIFIED');
    assert.ok(!h.calls.includes('optional-chrome'));
    await backend.close();
    assert.ok(!h.calls.some(c => c?.quit?.includes('com.google.Chrome')));
  });
});

test('optional Chrome refuses acquisition when its new owned window never becomes ready', async () => {
  await withHarness({ includeChrome: true, optionalChrome: { available: true }, chromeReady: false }, async (backend, h) => {
    await backend.start();
    await assert.rejects(backend.probe({ id: 8 }), /FIXTURE_IDENTITY/);
    assert.equal(h.calls.filter(c => c === 'chrome-fixture-ready').length, 100);
    assert.ok(!h.calls.some(c => typeof c === 'string' && c.includes('cua.getApp("com.google.Chrome")')));
    await backend.close();
    assert.ok(h.calls.some(c => c?.quit?.includes('com.google.Chrome')));
  });
});

test('lost engine reply retains one attempted call and prevents replay', async () => {
  const fake = deliveryFake(), evidence = { trials: [] };
  await assert.rejects(measureEngineDelivery({ ...fake.options, evidence, action: async () => { throw Error('ENGINE_CALL_FAILED'); } }), /ENGINE_CALL_FAILED/);
  assert.equal(evidence.engineCallsAttempted, 1); assert.equal(evidence.engineCalls, 0);
  assert.equal(evidence.trials[0].engineCallsAttempted, 1);
});

for (const succeeds of [true, false]) test(`owned document binding retries, success ${succeeds}`, async () => {
  const failure = { error: 'FIXTURE_BINDING_REQUIRED', bindCode: 'FRAME_MISMATCH', pendingDocument: true };
  const bindReplies = succeeds ? [failure, failure, { ok: true, bindCode: 'BOUND', pendingDocument: false }] : [failure];
  await withHarness({ bindReplies }, async (backend, h) => {
    await backend.start();
    try {
      if (succeeds) {
        await backend.probe({ id: 8 });
        assert.deepEqual(backend.snapshot().bindingAttempts.slice(0, 3).map(a => a.code), ['FRAME_MISMATCH', 'FRAME_MISMATCH', 'BOUND']);
      } else {
        await assert.rejects(backend.probe({ id: 8 }), e => e.message === 'FIXTURE_BINDING_REQUIRED' && e.bindCode === 'FRAME_MISMATCH');
        assert.equal(backend.snapshot().bindingAttempts.length, 30);
        assert.equal(h.calls.filter(c => c === 'bind-document').length, 30);
        assert.equal(backend.snapshot().bindingAttempts.at(-1).elapsedMs, 2900);
      }
    } finally {
      const cleanup = await backend.close();
      assert.equal(cleanup.bindingAttempts.at(-1).code, succeeds ? 'BOUND' : 'FRAME_MISMATCH');
    }
  });
});
