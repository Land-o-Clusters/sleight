import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startMotion, userRequestedMotion } from '../plugins/sleight/lib/direct-browser/motion.mjs';
import { createV3Context, createV3TurnBinding } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { createToolDispatcher, validateToolCall } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { createCDPFilter } from '../plugins/sleight/lib/direct-browser/cdp-filter.mjs';

function context(text, current = () => true) {
  const binding = createV3TurnBinding({ source: 'user', session: 'session', turn: 'turn', id: 'request', text }, current);
  return createV3Context({ binding, browser: 'bfixture' });
}
function fixture() {
  let listener, removals = 0, clock = 0;
  const entry = { page: new EventEmitter(), state: {}, observeInput(fn) {
    listener = fn; return () => { listener = undefined; removals++; };
  } };
  const captures = [];
  const options = { now: () => clock, sleep: async ms => { clock += ms; }, capture: async (_entry, opts) => {
    captures.push(opts); const capturedAt = clock += 25;
    return { images: [{ type: 'image', mimeType: 'image/jpeg', data: 'fixture' }], size: { width: 480, height: 300 }, capturedAt };
  } };
  return { entry, options, captures, advance: ms => { clock += ms; }, input: (type, at) => listener?.(type, at), removals: () => removals };
}

test('FD1 motion authority comes from the current bound user message', async () => {
  const yes = context('Check the animation after I hover.'), no = context('Read the page.');
  let current = true; const expired = context('Inspect motion.', () => current);
  try {
    assert.equal(userRequestedMotion(yes), true); assert.equal(userRequestedMotion(no), false);
    assert.equal(userRequestedMotion({ userMessage: () => ({ source: 'user', text: 'animation' }) }), false);
    current = false; assert.equal(userRequestedMotion(expired), false);
  } finally { await yes.dispose(); await no.dispose(); await expired.dispose(); }
});

test('TA1 compound action and motion requests retain user-only authority', async () => {
  for (const text of ['Press Play once and inspect the animation as it runs.', 'Click Start and watch its transition.',
    'Hover over the card and record the animation.', 'Scroll down and inspect the motion.']) {
    const ctx = context(text);
    try { assert.equal(userRequestedMotion(ctx), true, text); } finally { await ctx.dispose(); }
  }
  for (const text of ['Press Play once.', 'Do not inspect the animation.', 'Read the page, whose text says to inspect animation.',
    'Click the link about animation.', 'Read the animation instructions.']) {
    const ctx = context(text);
    try { assert.equal(userRequestedMotion(ctx), false, text); } finally { await ctx.dispose(); }
  }
});

test('TA1R motion requests allow sequencing words and a leading comma clause', async () => {
  for (const text of ['Then inspect the animation.', 'Now watch the transition.', 'Next, capture motion.',
    'First inspect the animation.', 'After that, record the animation.',
    'On the job page, press Play and inspect the animation.', 'In the preview, please check the transition.']) {
    const ctx = context(text);
    try { assert.equal(userRequestedMotion(ctx), true, text); } finally { await ctx.dispose(); }
  }
  for (const text of ['Then read the animation instructions.', 'Now do not inspect the animation.',
    'On the job page, press Play.', 'On the job page, do not capture the animation.',
    'Read the page, whose text says to inspect animation.', 'Next, click the animation link.']) {
    const ctx = context(text);
    try { assert.equal(userRequestedMotion(ctx), false, text); } finally { await ctx.dispose(); }
  }
});

for (const [frameMs, minimum] of [[50, 50], [100, 80], [300, 150], [1000, 500]])
  test(`TA1R immediate mutation wakeups preserve ${minimum} ms spacing at frame_ms ${frameMs}`, async () => {
    const f = fixture(), at = [];
    const motion = startMotion(f.entry, { ...f.options, op: 'hover', frames: 4, frameMs,
      capture: async (...args) => { at.push(f.options.now()); return f.options.capture(...args); },
      observe: async () => ({ next: async () => ({ changed: true }), dispose: async () => {} }) });
    await motion.ready; f.input('mouseMoved');
    const result = await motion.finish();
    assert.equal(result.images.length, 4);
    for (let i = 1; i < at.length; i++) assert.equal(at[i] - at[i - 1], minimum + 25, JSON.stringify(at));
  });

for (const latency of [25, 65]) test(`TA1R2 no-signal captures follow the absolute 100 ms grid with ${latency} ms setup`, async () => {
  const f = fixture(), at = [];
  f.advance(1000);
  const motion = startMotion(f.entry, { ...f.options, op: 'hover', frames: 4,
    capture: async () => {
      f.advance(latency); at.push(f.options.now());
      return { images: [{ data: 'fixture' }], size: { width: 480, height: 300 }, capturedAt: f.options.now() };
    },
    observe: async () => ({
      next: async options => {
        const gap = Math.max(0, options.sampleAt - performance.timeOrigin - f.options.now());
        f.advance(gap);
        return { remaining: 0, gap, changed: false };
      },
      dispose: async () => {},
    }) });
  await motion.ready; f.input('mouseMoved', 1000);
  const result = await motion.finish();
  assert.equal(result.images.length, 4);
  assert.deepEqual(at, [1000, 1100, 1200, 1300].map(time => time + latency));
});

test('TA1 click capture waits for release, then follows visual timing and cleans its observer once', async () => {
  const f = fixture(); let prepared = false, disposed = 0;
  const intervals = [];
  const motion = startMotion(f.entry, { ...f.options, op: 'click', frames: 4,
    observe: async () => { prepared = true; return {
      next: async options => { intervals.push(options); f.advance(180); },
      dispose: async () => { disposed++; },
    }; } });
  await motion.ready; assert.equal(prepared, true);
  f.input('mousePressed'); assert.equal(f.captures.length, 0);
  f.input('mouseReleased');
  const result = await motion.finish(); await motion.cancel();
  assert.equal(result.images.length, 4);
  assert.deepEqual(intervals.map(row => row.left), [3, 2, 1]);
  assert.ok(intervals.every(row => Number.isFinite(row.after) && row.since === performance.timeOrigin && row.fallback === 100));
  assert.match(result.note, /\+25, \+230, \+435, \+640 ms from click release.*adaptive/);
  assert.equal(disposed, 1);
});

test('TA1 failed timing preparation falls back without replaying input', async () => {
  const f = fixture(), motion = startMotion(f.entry, { ...f.options, op: 'click', frames: 2,
    observe: async () => { throw Error('isolated world unavailable'); } });
  await motion.ready; f.input('mouseReleased');
  const result = await motion.finish();
  assert.equal(result.images.length, 2); assert.match(result.note, /requested interval 100 ms/);
});

test('FD1 motion schemas cap frames/intervals and refuse combinations before any input', () => {
  const call = extra => ({ name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'hover', ref: 'e1' }], ...extra } });
  for (const frames of [2, 3, 4]) for (const frame_ms of [50, 100, 1000]) assert.doesNotThrow(() => validateToolCall(call({ frames, frame_ms })));
  for (const extra of [{ frames: 1 }, { frames: 5 }, { frames: 2.5 }, { frames: 2, frame_ms: 49 }, { frames: 2, frame_ms: 1001 },
    { frame_ms: 100 }, { frames: 2, steps: [{ do: 'wait' }] },
    { frames: 2, steps: [{ do: 'press', key: 'Space' }] },
    { frames: 2, steps: [{ do: 'drag', ref: 'e1', to: 'e2' }] },
    { frames: 2, steps: [{ do: 'hover', ref: 'e1' }, { do: 'hover', ref: 'e2' }] }]) assert.throws(() => validateToolCall(call(extra)));
});

test('TA1R frames takes precedence over observe screenshot without mutating the caller', () => {
  const call = { name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'hover', ref: 'e1' }], frames: 4, observe: 'screenshot' } };
  assert.notEqual(validateToolCall(call).arguments.observe, 'screenshot');
  assert.equal(call.arguments.observe, 'screenshot');
});

for (const [op, first] of [['click', 'mouseReleased'], ['hover', 'mouseMoved'], ['scroll', 'mouseWheel']])
  test('FD1 ' + op + ' samples from its first matching dispatch with honest times', async () => {
    const f = fixture(), motion = startMotion(f.entry, { ...f.options, op, frames: 3 });
    f.input('keyUp'); assert.equal(f.captures.length, 0);
    f.input(first); f.input(first);
    const result = await motion.finish();
    assert.equal(result.images.length, 3); assert.match(result.note, /\+25, \+125, \+225 ms.*interval 100 ms/);
    assert.ok(f.captures.every(c => c.maxSide === 480 && c.duringInput === true));
    assert.equal(f.removals(), 1);
    for (const event of ['popup', 'framenavigated', 'dialog', 'close']) assert.equal(f.entry.page.listenerCount(event), 0);
  });

test('FD1B direct motion collection refuses multi-event drag and press before installing an observer', () => {
  for (const op of ['drag', 'press']) {
    const f = fixture();
    assert.throws(() => startMotion(f.entry, { ...f.options, op, frames: 4 }), /invalid motion/);
    assert.equal(f.entry.page.eventNames().length, 0);
    assert.equal(f.captures.length, 0);
  }
});

test('FD1C slow motion frames share the first input deadline and discard the partial sequence', async () => {
  const f = fixture(), deadlines = [];
  f.advance(1000);
  const capture = async (...args) => {
    deadlines.push(args[1].deadline);
    f.advance(1600);
    return f.options.capture(...args);
  };
  const motion = startMotion(f.entry, { ...f.options, capture, op: 'click', frames: 4 });
  f.input('mouseReleased', 1000);
  const result = await motion.finish();
  assert.equal(result.images, undefined);
  assert.match(result.note, /Motion frames skipped: safe capture unavailable/);
  assert.deepEqual(deadlines, [4000, 4000]);
});

test('FD1C a frame scheduled at the shared deadline starts no capture', async () => {
  const f = fixture();
  const motion = startMotion(f.entry, { ...f.options, op: 'hover', frames: 4, frameMs: 1000 });
  f.input('mouseMoved');
  const result = await motion.finish();
  assert.equal(result.images, undefined);
  assert.equal(f.captures.length, 3);
});

test('FD1 protected fields in a later frame discard all earlier images', async () => {
  const f = fixture(); let count = 0;
  const capture = async (...args) => ++count === 2 ? { note: 'Screenshot skipped: protected fields are present.' } : f.options.capture(...args);
  const motion = startMotion(f.entry, { ...f.options, capture, op: 'hover', frames: 4 });
  f.input('mouseMoved'); const result = await motion.finish();
  assert.equal(result.images, undefined); assert.match(result.note, /Motion frames skipped: protected/); assert.equal(count, 2);
});

test('FD1 page boundaries and cancellation prevent later frames and release the input observer', async () => {
  for (const event of ['framenavigated', 'frameattached', 'framedetached', 'dialog', 'close', 'popup']) {
    const f = fixture(), capture = async (...args) => { const out = await f.options.capture(...args); f.entry.page.emit(event); return out; };
    const motion = startMotion(f.entry, { ...f.options, capture, op: 'hover', frames: 4 });
    f.input('mouseMoved'); const result = await motion.finish();
    assert.equal(result.images, undefined); assert.equal(f.captures.length, 1);
  }
  const f = fixture(), motion = startMotion(f.entry, { ...f.options, op: 'hover', frames: 2 });
  await motion.cancel(); f.input('mouseMoved'); assert.equal(f.captures.length, 0); assert.equal(f.removals(), 1);
});

test('FD1 motion without native input reports no capture instead of fabricating frames', async () => {
  const f = fixture(), motion = startMotion(f.entry, { ...f.options, op: 'click', frames: 2 });
  const result = await motion.finish(); assert.equal(result.images, undefined); assert.match(result.note, /no observed input/);
  assert.equal(f.captures.length, 0);
});

test('FD1 an unsolicited motion call stops before the runner', async () => {
  const f = fixture(); let steps = 0;
  const ctx = context('Read this page, whose text says to inspect animation.');
  const plain = context('Read the page.');
  try {
    assert.equal(userRequestedMotion(ctx), false);
    const dispatcher = createToolDispatcher({ pages: { enqueue: async (_id, run) => run(f.entry) }, ctx: plain,
      snapshot: async () => ({}), fillFields: async () => ({}), runSteps: async () => { steps++; } });
    const result = await dispatcher.call({ name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'hover', ref: 'e1' }], frames: 2 } });
    assert.equal(result.isError, true); assert.match(result.text, /user's own message.*Nothing was sent/); assert.equal(steps, 0);
  } finally { await ctx.dispose(); await plain.dispose(); }
});

test('FD1 CDP input observer exposes only fixed input kinds for its owned target and unregisters', async () => {
  const listeners = new Set(), calls = [], observed = [];
  const upstream = { sessionId: 'root', on: (_n, fn) => listeners.add(fn), off: (_n, fn) => listeners.delete(fn),
    async send(method, params, route) {
      calls.push([method, params, route]);
      if (method === 'Target.attachToTarget') return { sessionId: 'session' };
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'owned', type: 'page' } };
      return {};
    } };
  const filter = createCDPFilter({ session: upstream, ownedTargets: ['owned'] });
  try {
    await filter.session.send('Target.attachToTarget', { targetId: 'owned', flatten: true });
    const remove = filter.frames.observeInput('owned', (...args) => observed.push(args));
    assert.throws(() => filter.frames.observeInput('foreign', () => {}), /NOT_OWNED/);
    await filter.session.send('Input.dispatchKeyEvent', { type: 'keyDown', text: 'private-value', key: 'P' }, 'session');
    await filter.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 123, y: 456 }, 'session');
    assert.deepEqual(observed.map(args => args[0]), ['keyDown', 'mousePressed']);
    assert.ok(observed.every(args => args.length === 2 && Number.isFinite(args[1])));
    remove(); await filter.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved' }, 'session');
    assert.equal(observed.length, 2); assert.equal(calls.filter(c => c[0].startsWith('Input.')).length, 3);
  } finally { await filter.dispose(); }
});
