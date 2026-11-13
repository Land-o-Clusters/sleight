import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { planBrowserFrame, createBrowserHand, pageMetrics, workerHandTrace } from '../plugins/sleight/lib/hand/browser-hand.mjs';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { utilityLocator } from './direct-browser-utility-fixture.mjs';
import { assessLatencyCycles, collectLatencyCycles } from './fixtures/hand-act-latency.mjs';

// A 1200×900-point browser window at (100, 50) with 100 points of tabs and toolbar, on a 2× display, page zoom 100%.
const OUTER = { X: 100, Y: 50, Width: 1200, Height: 900 };
const METRICS = { screenX: 100, screenY: 50, outerWidth: 1200, outerHeight: 900, innerWidth: 1200, innerHeight: 800, dpr: 2,
  visible: true, focusOnBody: false, vv: { offsetLeft: 0, offsetTop: 0, scale: 1 } };
const GEOMETRY = { ok: true, window: { pid: 77, windowId: 5, bounds: OUTER },
  windows: [{ id: 5, pid: 77, layer: 0, owner: 'Browser', bounds: OUTER }], displays: [{ X: 0, Y: 0, Width: 1512, Height: 982 }] };
// CDP boxes are CSS pixels relative to the main frame's viewport, as Playwright's boundingBox returns them.
const BOX = { x: 200, y: 100, width: 100, height: 40 };

test('a CDP box becomes global points through the content origin, page zoom and device pixel ratio', () => {
  assert.deepEqual(planBrowserFrame({ op: 'click', box: BOX, metrics: METRICS, geometry: GEOMETRY }),
    { frame: { kind: 'click', pid: 77, windowId: 5, at: [350, 270], path: [[350, 270]], delayMs: 0, beats: 1 } });
  // Zoomed to 125%: the viewport is 960×640 CSS pixels and devicePixelRatio 2.5 (2× display times 1.25).
  const zoomed = { ...METRICS, innerWidth: 960, innerHeight: 640, dpr: 2.5 };
  assert.deepEqual(planBrowserFrame({ op: 'click', box: BOX, metrics: zoomed, geometry: GEOMETRY }).frame.at, [412.5, 300]);
  // innerWidth is a rounded integer: 1201/961 alone gives 1.2497, and the device pixel ratio puts it back at 1.25.
  const rounded = { ...zoomed, outerWidth: 1201, innerWidth: 961 };
  assert.deepEqual(planBrowserFrame({ op: 'click', box: BOX, metrics: rounded, geometry: { ...GEOMETRY, window: { ...GEOMETRY.window, bounds: { ...OUTER, Width: 1201 } },
    windows: [{ ...GEOMETRY.windows[0], bounds: { ...OUTER, Width: 1201 } }] } }).frame.at, [412.5, 300]);
  // Pinch zoom: the visual viewport is scrolled by (100, 50) at scale 2.
  const pinched = { ...METRICS, vv: { offsetLeft: 100, offsetTop: 50, scale: 2 } };
  assert.deepEqual(planBrowserFrame({ op: 'click', box: BOX, metrics: pinched, geometry: GEOMETRY }).frame.at, [400, 290]);
});

test('each turbo operation has its kind, a drag its path, typing its pecks, and the rest no hand', () => {
  const plan = (op, extra = {}) => planBrowserFrame({ op, box: BOX, metrics: METRICS, geometry: GEOMETRY, ...extra });
  for (const op of ['click', 'check', 'uncheck', 'select', 'navigate']) assert.equal(plan(op).frame.kind, 'click');
  assert.deepEqual([plan('type', { text: 'hello' }).frame.kind, plan('type', { text: 'hello' }).frame.beats], ['type', 5]);
  assert.equal(plan('type', { text: 'a much longer text' }).frame.beats, 8);
  assert.equal(plan('press').frame.kind, 'key');
  assert.deepEqual(plan('drag', { toBox: { x: 600, y: 300, width: 20, height: 20 } }).frame.path, [[350, 270], [710, 460]]);
  // A scroll without a ref scrolls the viewport: the hand goes to its middle.
  assert.deepEqual(plan('scroll', { box: undefined }).frame.at, [700, 550]);
  for (const op of ['hover', 'wait', 'back', 'forward', 'reload', 'viewport', 'dialog', 'upload']) assert.equal(plan(op), undefined);
});

test('a hidden tab, a covered or offscreen point, another Space, no box or focus on the page body skip with the reason', () => {
  const plan = extra => planBrowserFrame({ op: 'click', box: BOX, metrics: METRICS, geometry: GEOMETRY, ...extra });
  assert.deepEqual(plan({ metrics: { ...METRICS, visible: false } }), { skip: 'hidden-tab' });
  const cover = { id: 9, pid: 9, layer: 0, owner: 'Other', bounds: { X: 300, Y: 250, Width: 100, Height: 100 } };
  assert.deepEqual(plan({ geometry: { ...GEOMETRY, windows: [cover, ...GEOMETRY.windows] } }), { skip: 'covered' });
  assert.equal(plan({ geometry: { ...GEOMETRY, windows: [{ ...cover, pid: 444 }, ...GEOMETRY.windows] }, ignorePids: [444] }).frame.kind, 'click');
  assert.deepEqual(plan({ box: { x: 1500, y: 100, width: 10, height: 10 } }), { skip: 'offscreen' });
  // Scrolled above the viewport: its centre would map onto the toolbar, inside the window, so the viewport decides.
  assert.deepEqual(plan({ box: { x: 200, y: -100, width: 100, height: 40 } }), { skip: 'offscreen' });
  assert.deepEqual(plan({ box: { x: 200, y: 790, width: 100, height: 40 } }), { skip: 'offscreen' }, 'centre at 810, below the 800-pixel viewport');
  assert.deepEqual(planBrowserFrame({ op: 'drag', box: BOX, toBox: { x: 200, y: -50, width: 10, height: 10 }, metrics: METRICS, geometry: GEOMETRY }), { skip: 'offscreen' });
  // Under pinch zoom the visible part is innerWidth/scale by innerHeight/scale CSS pixels from the visual viewport's offset.
  const pinched = { ...METRICS, vv: { offsetLeft: 100, offsetTop: 50, scale: 2 } };
  assert.deepEqual(plan({ metrics: pinched, box: { x: 750, y: 100, width: 10, height: 10 } }), { skip: 'offscreen' }, '755 is past 100 + 600');
  assert.equal(plan({ metrics: pinched, box: { x: 650, y: 100, width: 10, height: 10 } }).frame.kind, 'click');
  assert.deepEqual(plan({ geometry: { ok: true, state: 'other-space' } }), { skip: 'other-space' });
  assert.deepEqual(plan({ geometry: { ok: false } }), { skip: 'no-geometry' });
  assert.deepEqual(plan({ box: null }), { skip: 'no-box' });
  assert.deepEqual(planBrowserFrame({ op: 'press', box: BOX, metrics: { ...METRICS, focusOnBody: true }, geometry: GEOMETRY }), { skip: 'no-focus' });
  assert.deepEqual(plan({ metrics: { ...METRICS, outerWidth: 0 } }), { skip: 'no-geometry' });
});

test('pageMetrics reads the window and document through the native reader', () => {
  const doc = { visibilityState: 'visible' }, win = { screenX: 1, screenY: 2, outerWidth: 3, outerHeight: 4, innerWidth: 5, innerHeight: 6,
    devicePixelRatio: 2, visualViewport: { offsetLeft: 7, offsetTop: 8, scale: 1 } };
  const body = {}; doc.defaultView = win; doc.body = body; doc.activeElement = body;
  const el = { ownerDocument: doc };
  assert.deepEqual(pageMetrics(el, undefined, (node, key) => node?.[key]), { screenX: 1, screenY: 2, outerWidth: 3, outerHeight: 4, innerWidth: 5,
    innerHeight: 6, dpr: 2, visible: true, focusOnBody: true, vv: { offsetLeft: 7, offsetTop: 8, scale: 1 } });
});

function handFixture(options = {}) {
  const sent = [], traces = [], locates = [], reads = [], deferred = [];
  const client = { enabled: true, pid: 4242, send: frame => sent.push(frame), hidden: 0, hide() { this.hidden++; }, close() {} };
  let metrics = METRICS;
  const hand = createBrowserHand({ client, env: { SLEIGHT_HAND: '1' }, setting: () => ({ enabled: true }), defer: fn => deferred.push(fn), now: () => 0,
    readMetrics: async page => { reads.push(page); return metrics; },
    locate: async request => { locates.push(request); return GEOMETRY; },
    trace: (direction, msg) => traces.push([direction, msg]), ...options });
  const page = { id: 'page' };
  const locator = { boundingBox: async options => { assert.ok(options.timeout <= 500); return BOX; } };
  return { hand, client, sent, traces, locates, reads, deferred, page, locator, setMetrics: m => { metrics = m; },
    run: async () => { while (deferred.length) deferred.shift()(); for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); } };
}

test('a step only queues work; the frame follows from the page metrics, the CDP box and the window geometry', async () => {
  const f = handFixture();
  f.hand.step({ op: 'click', page: f.page, locator: f.locator, ref: 'e1' });
  assert.deepEqual([f.reads.length, f.locates.length], [0, 0], 'nothing runs inside the act path');
  await f.run();
  assert.deepEqual(f.locates, [{ bounds: OUTER }]);
  assert.deepEqual(f.sent, [{ kind: 'click', pid: 77, windowId: 5, at: [350, 270], path: [[350, 270]], delayMs: 0, beats: 1 }]);
  // The window's geometry is reused for a burst of steps.
  f.hand.step({ op: 'type', page: f.page, locator: f.locator, ref: 'e1', text: 'hi' }); await f.run();
  assert.equal(f.locates.length, 1);
  assert.equal(f.sent.length, 2);
  // A hidden tab needs no box or geometry.
  f.setMetrics({ ...METRICS, visible: false });
  f.hand.step({ op: 'click', page: f.page, locator: { boundingBox: () => { throw Error('read'); } }, ref: 'e1' }); await f.run();
  assert.deepEqual(f.traces.at(-1), ['hand-skipped', { op: 'click', reason: 'hidden-tab' }]);
  // A failing page read or box is a skip, never an error.
  f.setMetrics(METRICS);
  f.hand.step({ op: 'click', page: f.page, locator: { boundingBox: async () => { throw Error('detached'); } }, ref: 'e1' }); await f.run();
  assert.deepEqual(f.traces.at(-1), ['hand-skipped', { op: 'click', reason: 'no-box' }]);
  f.hand.step({ op: 'hover', page: f.page, locator: f.locator, ref: 'e1' }); await f.run();
  assert.equal(f.reads.length, 4, 'an operation with no hand reads nothing');
});

test('SLEIGHT_HAND=0, a missing client or a disabled client means no hand and no reads', async () => {
  assert.equal(createBrowserHand({ env: { SLEIGHT_HAND: '0' }, locate: async () => GEOMETRY }), undefined);
  for (const options of [{ client: undefined, loadClient: () => import('./no-such-hand-client.mjs') }, { client: { enabled: false, send() {}, hide() {}, close() {} } }]) {
    const f = handFixture(options);
    f.hand.step({ op: 'click', page: f.page, locator: f.locator, ref: 'e1' }); await f.run();
    assert.deepEqual([f.reads.length, f.locates.length], [0, 0]);
    f.hand.close();
  }
});

// The act runner's boundary, as in direct-browser-v3-act.test.mjs.
function actFixture(hand, verdict = { kind: 'allow' }) {
  const page = new EventEmitter(), actions = [];
  const loc = ref => utilityLocator({ ref,
    async boundingBox() { return BOX; },
    async evaluate(fn) {
      if (fn.name === 'inspectTarget') return { name: 'Continue', submit: false, payment: false, form: false, formSignature: 'x' };
      if (fn.name === 'overlaySignature') return { count: 0, hash: 1 };
      if (fn.name === 'placeClear') return 'clear';
      throw Error('unexpected evaluate ' + fn.name);
    },
    async count() { return 1; },
    async click() { actions.push(['click', ref]); }, async fill(text) { actions.push(['fill', ref, text]); },
    async dragTo(to) { actions.push(['dragTo', ref, to.ref]); }, async hover() { actions.push(['hover', ref]); },
  });
  page.getByRef = loc; page.url = () => 'https://example.invalid/'; page.mainFrame = () => page;
  page.locator = () => loc('focus');
  let time = 0;
  const run = createActionRunner({ check: async () => verdict, now: () => time, sleep: async ms => { time += ms; }, hand,
    snapshot: async () => ({ text: 'No visible changes.', number: 2 }) });
  return { page, tab: { page, state: { snapshotNo: 1, submitUnconfirmed: false } }, run, actions };
}

test('the act runner tells the hand about each step it starts, after its rules allowed it, and never waits on it', async () => {
  const steps = [];
  const hand = { step: input => steps.push(input) };
  const f = actFixture(hand);
  await f.run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'type', ref: 'e2', text: 'hello' }, { do: 'drag', ref: 'e3', to: 'e4' }, { do: 'hover', ref: 'e5' }], {});
  assert.deepEqual(steps.map(s => [s.op, s.ref, s.locator.ref, s.to?.ref, s.text, s.page === f.page]), [
    ['click', 'e1', 'e1', undefined, undefined, true], ['type', 'e2', 'e2', undefined, 'hello', true],
    ['drag', 'e3', 'e3', 'e4', undefined, true], ['hover', 'e5', 'e5', undefined, undefined, true]]);
  // A refused step starts no input and shows no hand.
  steps.length = 0;
  const refused = actFixture(hand, { kind: 'refuse', message: 'no' });
  await refused.run(refused.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.deepEqual(steps, []);
  // A hand that throws changes nothing about the step.
  const broken = actFixture({ step() { throw Error('hand'); } });
  const result = await broken.run(broken.tab, [{ do: 'click', ref: 'e1' }], {});
  assert.deepEqual(broken.actions, [['click', 'e1']]);
  assert.match(result.lines[0], /^1 click e1: /);
  assert.doesNotMatch(result.lines[0], /unconfirmed|not run/);
});

test('act latency with the hand is within 0.1 ms of act without it', async t => {
  let sent = 0, closed = 0;
  const hand = createBrowserHand({ client: { enabled: true, send() { sent++; }, hide() {}, close() { closed++; } }, env: { SLEIGHT_HAND: '1' }, setting: () => ({ enabled: true }),
    readMetrics: async () => METRICS, locate: async () => GEOMETRY });
  const fixtures = { off: actFixture(), on: actFixture(hand) };
  const measure = async side => {
    const f = fixtures[side], before = sent, beforeActions = f.actions.length;
    const start = performance.now();
    const result = await f.run(f.tab, [{ do: 'click', ref: 'e1' }, { do: 'type', ref: 'e2', text: 'hi' }], {});
    const elapsed = performance.now() - start;
    // Default setImmediate scheduling remains active. Drain the fake async readers after stopping the clock.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.lines.length, 2);
    assert.equal(result.stoppedAt, null);
    assert.deepEqual(f.actions.slice(beforeActions), [['click', 'e1'], ['fill', 'e2', 'hi']]);
    assert.equal(sent - before, side === 'on' ? 2 : 0, 'every enabled click and type delivered its deferred frame');
    return elapsed;
  };
  try {
    await collectLatencyCycles(measure); // 300 warmup samples per side, in the same balanced order
    const measured = assessLatencyCycles(await collectLatencyCycles(measure)), { off, on } = measured;
    assert.equal(sent, 1200, 'warmup and measured on runs each delivered 600 frames');
    t.diagnostic(`act median off ${off.median.toFixed(4)} ms, on ${on.median.toFixed(4)} ms; delta ${measured.deltaMs.toFixed(4)} ms; ` +
      `whole-cycle bootstrap upper95 ${measured.upper95Ms.toFixed(4)} ms; p95 off ${off.p95.toFixed(4)}, on ${on.p95.toFixed(4)}; ` +
      `${measured.samplesPerCondition} per side, ${measured.cycles} cycles, ${measured.resamples} resamples, seed ${measured.seed}`);
    assert.ok(on.median - off.median < 0.1, `act ${on.median} ms with the hand against ${off.median} ms without`);
    assert.ok(measured.upper95Ms < 0.1, `act latency measurement inconclusive: cycle-bootstrap upper95 ${measured.upper95Ms} ms exceeds the strict 0.1 ms limit`);
  } finally { hand.close(); assert.equal(closed, 1); }
});

test('the worker\'s hand events reach the relay\'s trace file with the operation and a fixed reason or kind only', async () => {
  const writes = [];
  const trace = workerHandTrace({ setting: '/tmp/trace-dir', parentPid: 321, now: () => Date.UTC(2026, 9, 19), append: (file, text) => writes.push([file, text]) });
  trace('hand-skipped', { op: 'click', reason: 'hidden-tab', page: 'secret' });
  trace('hand-shown', { op: 'type', kind: 'type', text: 'secret' });
  trace('hand-skipped', { op: '<script>', reason: 'Not A Reason!' });
  // Prototype names are not operations, and a reason that merely looks like one is not on the list.
  trace('hand-skipped', { op: 'constructor', reason: 'user-typed-secret' });
  trace('hand-skipped', { op: 'toString', reason: 'covered', kind: 'click' });
  trace('hand-beat', { op: 'click' });
  assert.equal(writes.length, 5);
  assert.ok(writes.every(([file]) => file === '/tmp/trace-dir/trace-321.jsonl'));
  const t = '2026-10-19T00:00:00.000Z';
  assert.deepEqual(writes.map(([, text]) => JSON.parse(text)), [
    { t, direction: 'hand-skipped', msg: { op: 'click', reason: 'hidden-tab' } },
    { t, direction: 'hand-shown', msg: { op: 'type', kind: 'type' } },
    { t, direction: 'hand-skipped', msg: { op: 'other', reason: 'other' } },
    { t, direction: 'hand-skipped', msg: { op: 'other', reason: 'other' } },
    { t, direction: 'hand-skipped', msg: { op: 'other', reason: 'covered' } }]);
  assert.equal(JSON.stringify(writes).includes('secret'), false);
  assert.equal(workerHandTrace({ setting: '1', parentPid: 5, home: () => '/h', append: (file) => writes.push([file]) })('hand-shown', { op: 'click', kind: 'click' }), undefined);
  assert.equal(writes.at(-1)[0], '/h/Library/Logs/sleight/trace-5.jsonl');
  // No SLEIGHT_TRACE: no writes; a failing write never throws.
  const quiet = workerHandTrace({ setting: '', append: () => assert.fail('wrote') }); quiet('hand-shown', { op: 'click' });
  workerHandTrace({ setting: '/x', parentPid: 5, append: () => { throw Error('EACCES'); } })('hand-shown', { op: 'click', kind: 'click' });
  // A drawn step traces hand-shown after its frame goes out.
  const f = handFixture();
  f.hand.step({ op: 'click', page: f.page, locator: f.locator, ref: 'e1' }); await f.run();
  assert.deepEqual(f.traces.at(-1), ['hand-shown', { op: 'click', kind: 'click' }]);
});

test('default off installs no hand hooks; saved on enables hooks and env 0 still wins', () => {
  const options = { env: {}, setting: () => ({ enabled: false }), locate: () => { throw Error('must not locate'); },
    loadClient: () => { throw Error('must not load'); } };
  assert.equal(createBrowserHand(options), undefined);
  const on = { ...options, setting: () => ({ enabled: true }) };
  const hand = createBrowserHand(on);
  assert.ok(hand);
  hand.close();
  assert.equal(createBrowserHand({ ...on, env: { SLEIGHT_HAND: '0' } }), undefined);
});


test('a shared worker sends artwork to its parent client without creating a second hand host', async () => {
  const { workerHandClient } = await import('../plugins/sleight/lib/hand/browser-hand.mjs');
  const frames = [], channel = { connected: true, send: value => frames.push(value) };
  const client = workerHandClient(channel, 4242, { setting: () => ({ enabled: true }) }), frame = { kind: 'click', pid: 1, windowId: 2, at: [10, 10] };
  client.send(frame); client.close();
  assert.deepEqual(frames, [{ version: 3, hand: frame }]); assert.equal(client.pid, 4242);
  channel.connected = false; client.send(frame); assert.equal(frames.length, 1);
});

test('turning the shared worker hand off stops metrics, box and geometry reads, then on resumes them', async () => {
  const { workerHandClient } = await import('../plugins/sleight/lib/hand/browser-hand.mjs');
  let enabled = true, clock = 0, metrics = 0, boxes = 0, locates = 0;
  const frames = [], client = workerHandClient({ connected: true, send: f => frames.push(f) }, 4242,
    { setting: () => ({ enabled }), now: () => clock });
  const hand = createBrowserHand({ client, setting: () => ({ enabled: true }), now: () => clock,
    readMetrics: async () => { metrics++; return METRICS; }, locate: async () => { locates++; return GEOMETRY; } });
  const step = async () => { hand.step({ op: 'click', page: {}, locator: { boundingBox: async () => { boxes++; return BOX; } } });
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  await step();
  assert.deepEqual([metrics, boxes, locates, frames.length], [1, 1, 1, 1]);
  enabled = false; clock = 500;
  await step(); await step();
  assert.equal(client.enabled, false);
  assert.deepEqual([metrics, boxes, locates, frames.length], [1, 1, 1, 1]);
  enabled = true; clock = 2000;
  await step();
  assert.deepEqual([metrics, boxes, locates, frames.length], [2, 2, 2, 2]);
  hand.close();
});

test('off during a metrics read stops the remaining box and geometry reads', async () => {
  const { workerHandClient } = await import('../plugins/sleight/lib/hand/browser-hand.mjs');
  let enabled = true, clock = 0, boxes = 0, locates = 0, finish;
  const client = workerHandClient({ connected: true, send() { assert.fail('off cannot send artwork'); } }, 4242,
    { setting: () => ({ enabled }), now: () => clock });
  const hand = createBrowserHand({ client, setting: () => ({ enabled: true }),
    readMetrics: () => new Promise(resolve => { finish = resolve; }), locate: () => { locates++; return GEOMETRY; } });
  hand.step({ op: 'click', page: {}, locator: { boundingBox() { boxes++; return BOX; } } });
  await new Promise(resolve => setImmediate(resolve));
  enabled = false; clock = 500; finish(METRICS);
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([boxes, locates], [0, 0]);
  hand.close();
});
