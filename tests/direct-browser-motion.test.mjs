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
  return { entry, options, captures, input: type => listener?.(type), removals: () => removals };
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

test('FD1 motion schemas cap frames/intervals and refuse combinations before any input', () => {
  const call = extra => ({ name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'hover', ref: 'e1' }], ...extra } });
  for (const frames of [2, 3, 4]) for (const frame_ms of [50, 100, 1000]) assert.doesNotThrow(() => validateToolCall(call({ frames, frame_ms })));
  for (const extra of [{ frames: 1 }, { frames: 5 }, { frames: 2.5 }, { frames: 2, frame_ms: 49 }, { frames: 2, frame_ms: 1001 },
    { frame_ms: 100 }, { frames: 2, observe: 'screenshot' }, { frames: 2, steps: [{ do: 'wait' }] },
    { frames: 2, steps: [{ do: 'hover', ref: 'e1' }, { do: 'hover', ref: 'e2' }] }]) assert.throws(() => validateToolCall(call(extra)));
});

for (const [op, first] of [['click', 'mousePressed'], ['hover', 'mouseMoved'], ['press', 'rawKeyDown'], ['scroll', 'mouseWheel'], ['drag', 'mousePressed']])
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
