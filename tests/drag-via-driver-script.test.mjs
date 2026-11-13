import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScript } from '../plugins/sleight/lib/launch.mjs';
import { createDragViaDriver } from '../plugins/sleight/lib/drag-via-driver.mjs';
import { dragScriptFixture } from './fixtures/drag-script.mjs';
import { crossWindowDragFixture } from './fixtures/drag-cross-window.mjs';
import { fakeDragExecutor, runFakeDragLocal } from './fixtures/drag-via-driver-exec.mjs';

const app = 'com.apple.TextEdit';
const singleRequest = { app, windowId: 11, from: [26.6, 38.5], to: [150, 38.5], dp2: false };
const crossRequest = { app: 'Editor', windowId: 11, toWindowId: 12, from: 'the current text selection',
  to: 'end of line 1', holdMs: 0, settleMs: 0, steps: 2, dp2: false, dp7: false };
const window = (id, name = app) => ({ windowId: String(id), pid: 7, processStart: '7:100',
  bundleId: app, app: name, title: `${id}.txt`, identityVerified: true });
// VM-created points have different Object prototypes in the two fixtures.
// Compare their complete wire data rather than their realm identities.
const plain = value => JSON.parse(JSON.stringify(value));

function runner(fixture, source = window(11), destination) {
  const calls = [];
  const run = createDragViaDriver({
    current: () => {},
    driver: { resolveApp: async () => ({ app: { id: source.bundleId, pid: source.pid, processStart: source.processStart, running: true } }),
      verifyWindowIdentity: async id => { calls.push(['verify', id]); return { window: id === source.windowId ? source : destination }; } },
    bindings: () => ({ source, ...destination ? { destination } : {} }),
    runLocal: (script, request, options) => {
      calls.push(['run', script]);
      return typeof fixture === 'function' ? fixture(request) : runFakeDragLocal(script, request, options);
    },
  });
  return { calls, run: (script, request) => run(script, request,
    typeof fixture === 'function' ? undefined : { run: fakeDragExecutor(fixture) }) };
}

// Each row executes the production run() with fake native boundaries, both
// directly and through the driver runner. No osascript or desktop API runs.
const sameWindowCases = [
  ['AX move', { background: true, ax: {} }],
  ['semantic AX move', { second: false, background: true, ax: {} }, { from: 'the current text selection', to: 'end of line 1' }],
  ['ambiguous window', {}, { windowId: undefined }, /ambiguous/],
  ['off Space', { offSpace: true }, {}, /off screen|Space/],
  ['no windows', { noWindows: true }, {}, /no window/],
  ['toolbar destination', {}, { to: [20, 25] }, /content/],
  ['title bar destination', {}, { to: [20, 5] }, /content/],
  ['outside destination', {}, { to: [900, 50] }, /content/],
  ['outside source', {}, { from: [-1, 50] }, /content/],
  ['split text fields', { splitAreas: true }, { to: [150, 200] }, /same visible text/],
  ['blank selection', { selection: ' ' }, {}, /non-whitespace/],
  ['empty selection', { selection: '' }, {}, /non-whitespace/],
  ['missing content', { missingContent: true }, {}, /content/],
  ['content scan limit', { extraElements: 400 }, {}, /limit/],
  ['role timeout', { background: true, nativeFailure: { name: 'AXRole', code: -25204 } }, {}, /nothing was pressed/],
  ['geometry timeout', { background: true, nativeFailure: { name: 'AXPosition', code: -25204 } }, {}, /nothing was pressed/],
  ['text readback timeout', { background: true, nativeFailure: { name: 'AXValue', code: -25204, afterPress: 1 } }, {}, /cannot verify/],
  ['selection readback timeout', { background: true, nativeFailure: { name: 'AXSelectedText', code: -25204, afterPress: 1 } }, {}, /cannot verify/],
  ['changed semantic selection', { second: false, changeOnActivate: true, ax: { failWrite: 1 } },
    { from: 'the current text selection', to: 'end of line 1' }, /changed|outside/],
  ['moved semantic window', { second: false, movedOnActivate: true, ax: { failWrite: 1 } },
    { from: 'the current text selection', to: 'end of line 1' }, /changed|outside/],
  ['changed AX baseline', { background: true, ax: { changedBeforeMove: true } }, {}, /changed before/],
  ['inside selection', { background: true, ax: {} }, { to: [26, 38.5] }, /inside the selection/],
  ['second AX write fails', { background: true, ax: { failWrite: 2 } }, {}, /Cmd\+Z/],
  ['formatting preserves posted path', { background: true, ax: { formatted: true }, backgroundAfter: 'beta gamma alpha\n' }],
  ['unreadable formatting preserves posted path', { background: true, ax: { unreadableAttributes: true } }],
  ['ignored AX writes preserve fallback', { background: true, ax: { ignored: true } }],
  ['covered text uses AX', { background: true, coveredEnd: true, coveredPid: 9, ax: {} }],
  ['covered nontext refuses', { background: true, coveredEnd: true, coveredPid: 9, selection: '', areaRole: 'AXGroup' }, {}, /covers.*no selected text/],
  ['covered same-app window', { coveredEnd: true }, {}, /covered/],
  ['failed raise', { background: true, stacked: true, raiseWorks: false }, {}, /covered/],
  ['busy owner', { busyChecks: 100 }, {}, /kept typing/],
  ['owner types before down', { typesAt: 'focused' }, {}, /user typed/],
  ['owner types during drag', { typesAt: 'dragging' }, {}, /user typed/],
  ['background move and spacing repair', { background: true }],
  ['unchanged posted text permits foreground', { background: true, backgroundAfter: 'alpha beta gamma\n' }],
  ['lost text forbids repeat', { background: true, backgroundAfter: ' beta gamma\n' }, {}, /disappeared/],
  ['partial changed text forbids repeat', { background: true, backgroundAfter: 'partial edit\n' }],
  ['unreadable text forbids repeat', { background: true, readFails: true }, {}, /AX AXValue failed \(-25205\)/],
  ['release failure forbids repeat', { background: true, releaseFails: true }, {}, /release failed/],
  ['post failure after down forbids repeat', { background: true, postFails: true }],
  ['setter failure permits guarded fallback', { background: true, setterFails: true }],
  ['both paths unchanged', { background: true, backgroundAfter: 'alpha beta gamma\n', after: 'alpha beta gamma\n' }, {}, /unchanged/],
  ['spacing repair loses text', { background: true, repairDeletesText: true }, {}, /disappeared/],
  ['press budget exhausted', { slowDelays: true }, {}, /too close|too long/],
  ['non-text posted move stays unverified', { background: true, selection: '', areaRole: 'AXGroup' }],
  ['non-text failure before down', { background: true, selection: '', areaRole: 'AXGroup', failBeforePress: true }],
  ['non-text failure after down', { background: true, selection: '', areaRole: 'AXGroup', postFails: true }],
  ['relocation refuses fully covered row', { background: true, areaRole: 'AXGroup', selection: '', rows: 4,
    coveredEnd: true, coveredPid: 9, coverBounds: { X: 100, Y: 160, Width: 600, Height: 50 } }, { from: [40, 45], to: [360, 85] }, /covered/],
  ['relocation refuses parent container', { background: true, areaRole: 'AXGroup', selection: '', rows: 4,
    rowRole: 'AXList', coveredEnd: true, coveredPid: 9,
    coverBounds: { X: 300, Y: 160, Width: 120, Height: 50 } }, { from: [40, 45], to: [260, 85] }, /single item/],
];

for (const [name, options, changes = {}, refusal] of sameWindowCases) {
  test(`driver script: ${name}`, async () => {
    const direct = dragScriptFixture({ ...options, nativeAppResolution: true }), via = dragScriptFixture({ ...options, nativeAppResolution: true });
    const args = { ...singleRequest, ...changes };
    const expected = direct.run(args), h = runner(via);
    const result = await h.run('drag.js', args);
    assert.deepEqual(result, expected);
    if (refusal) { assert.equal(result.ok, false); assert.match(result.error, refusal); }
    for (const key of ['events', 'pidEvents', 'activations', 'restored', 'axWrites', 'textWrites']) assert.deepEqual(via[key], direct[key], key);
    assert.equal(h.calls.filter(call => call[0] === 'run').length, 1);
  });
}

for (const [key, values] of Object.entries({ holdMs: [-1, 5001, 0.5], steps: [0, 101, 1.5],
  settleMs: [-1, 5001, 0.5], from: [[1], 'end of line 1', -1], to: [[1], 'the current text selection', -1] })) {
  for (const value of values) test(`driver script: invalid ${key}=${JSON.stringify(value)}`, async () => {
    const fixture = dragScriptFixture({ nativeAppResolution: true, background: true });
    const h = runner(fixture);
    const result = await h.run('drag.js', { ...singleRequest, [key]: value });
    assert.equal(result.ok, false); assert.match(result.error, /invalid drag/);
    assert.equal(fixture.events.length + fixture.pidEvents.length + fixture.axWrites.length, 0);
  });
}

const crossCases = [
  ['AX text transaction', {}],
  ['posted transaction', { ax: false }],
  ['lost text', { ax: false, lost: true }, /not confirmed/],
  ['readback timeout', { ax: false, readbackTimeout: true }, /cannot verify/],
  ['AX readback timeout', { axReadbackTimeout: true }, /cannot verify/],
  ['failed cut rolls back insertion', { failWrite: 2 }, /Nothing moved/],
  ['ignored cut rolls back insertion', { ignoreWriteNumbers: [2] }, /Nothing moved/],
  ['unverifiable rollback', { failWrite: 2, ignoreWriteNumbers: [2] }, /Partial|Nothing moved/],
  ['unavailable posting', { ax: false, noPosting: true }],
  ['busy owner', { ax: false, noPosting: true, busy: true }, /kept typing/],
  ['owner types after activate', { ax: false, noPosting: true, typing: true }, /user typed/],
  ['covered destination', { ax: false, cover: true }, /covered|covers/],
  ['late coverage', { ax: false, lateCover: true }, /covered|covers/],
  ['release failure', { ax: false, postFail: 2 }, /release failed/],
  ['unchanged drop', { ax: false, unchanged: true }, /unchanged/],
  ['formatted text', { formatted: true }],
  ['foreign destination', { foreign: true }, /no window|matches no window|unavailable/],
  ['notification system overlay', { ax: false, overlays: true, eventPid: () => 739 }, /system window/],
  ['pass-through system windows', { ax: false, overlays: true, eventPid: () => 7 }],
  ['owner changes source during settle', { ax: false, onSettle: ({ a }) => { a.AXValue = 'owner edit\n'; } }, /changed/],
  ['owner changes destination during settle', { ax: false, onSettle: ({ b }) => { b.AXValue = 'owner edit\n'; } }, /changed/],
];

for (const [name, options, refusal] of crossCases) test(`driver cross-window: ${name}`, async () => {
  const direct = crossWindowDragFixture({ ...options, nativeAppResolution: true }),
    via = crossWindowDragFixture({ ...options, nativeAppResolution: true });
  const expected = direct.run(), h = runner(via, window(11, 'Editor'), window(12, 'Editor'));
  const result = await h.run('drag.js', crossRequest);
  assert.deepEqual(result, expected);
  if (refusal) { assert.equal(result.ok, false); assert.match(result.error, refusal); }
  for (const key of ['events', 'writes', 'activations', 'restored', 'settles']) assert.deepEqual(plain(via[key]), plain(direct[key]), key);
  assert.equal(h.calls.filter(call => call[0] === 'run').length, 1);
});

test('driver AX writes retain the real Shift down/up pair, including partial writes', async () => {
  for (const ax of [{}, { failWrite: 2 }]) {
    const fixture = dragScriptFixture({ nativeAppResolution: true, background: true, ax });
    Object.assign(fixture.native, {
      CGEventCreateKeyboardEvent: (_source, key, down) => ({ key, down }),
      CGEventSetFlags: (event, flags) => { event.flags = flags; },
      CGEventSetType: (event, type) => { event.type = type; },
      kCGEventFlagMaskShift: 0x20000, kCGEventFlagsChanged: 12,
    });
    const area = fixture.context.axTextArea;
    fixture.context.axTextArea = (...args) => ({ ...area(...args), settle: () => fixture.context.settleAfterTextWrite(7) });
    const h = runner(fixture);
    const result = await h.run('drag.js', singleRequest);
    assert.equal(result.path, 'accessibility');
    assert.deepEqual(fixture.pidEvents.map(({ key, down, flags, type }) => ({ key, down, flags, type })),
      [{ key: 56, down: true, flags: 0x20000, type: 12 }, { key: 56, down: false, flags: 0, type: 12 }]);
    assert.equal(fixture.events.length, 0); assert.equal(fixture.activations.length, 0);
  }
});

// Native refusal predicates run in the rows above. One row is enough to prove
// transport preserves an arbitrary refusal object without verification or replay.
test('driver forwards an executor refusal unchanged', async () => {
  const result = { ok: false, path: 'none', error: 'fixture refusal', deliveryVerified: false };
  const h = runner(() => result);
  assert.strictEqual(await h.run('drag.js', singleRequest), result);
  assert.equal(h.calls.filter(call => call[0] === 'run').length, 1);
  assert.equal(h.calls.filter(call => call[0] === 'verify').length, 1);
});

test('the engine runner still executes drag.js directly with its existing text move', async () => {
  const fixture = dragScriptFixture({ nativeAppResolution: true, second: false, background: true, ax: {} });
  const execute = fakeDragExecutor(fixture);
  let calls = 0;
  const result = await runScript('drag.js', singleRequest, { run: (command, args, ...rest) => {
    calls++;
    assert.notEqual(args[2], '-e');
    return execute(command, args, ...rest);
  } });
  assert.equal(calls, 1); assert.equal(result.ok, true);
  assert.equal(result.path, 'accessibility'); assert.equal(result.textChanged, true);
  assert.equal(fixture.values.get(11), 'beta gamma alpha\n');
  assert.equal(fixture.events.length + fixture.pidEvents.length + fixture.activations.length, 0);
});
