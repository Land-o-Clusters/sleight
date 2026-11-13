import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import playwright from '../plugins/sleight/vendor/playwright-core/index.mjs';
import { motionClock } from '../plugins/sleight/lib/direct-browser/motion-clock.mjs';

test('TA1R2 bundled Playwright exposes the private motionClock API shape without a browser', () => {
  const connection = playwright._connection;
  assert.equal(typeof connection.toImpl, 'function');
  assert.equal(connection.toImpl(playwright.chromium).attribution.playwright.options.isClientCollocatedWithServer, true);
  const bundle = readFileSync(new URL('../plugins/sleight/vendor/playwright-core/lib/coreBundle.js', import.meta.url), 'utf8');
  const section = path => {
    const start = bundle.indexOf('// packages/playwright-core/src/' + path + '\n');
    assert.ok(start >= 0, `vendored module missing: ${path}`);
    return bundle.slice(start, bundle.indexOf('\n// packages/', start + 1));
  };
  assert.match(section('server/frames.ts'), /utilityContext\(\)\s*\{\s*return this\.context\("utility"\)/);
  const dom = section('server/dom.ts');
  assert.match(dom, /FrameExecutionContext = class extends ExecutionContext/);
  assert.match(dom, /this\.world = world/);
  for (const method of ['evaluateExpression', 'evaluateExpressionHandle'])
    assert.match(dom, new RegExp(`async ${method}\\(expression\\w*, options, arg\\w*\\)`));
  assert.match(section('server/javascript.ts'), /\n      dispose\(\)/);
});

function fixture({ animations = [], world = 'utility', delay = 0, pageTimerFloor = 0 } = {}) {
  let changed, observed, disconnected = 0, released = 0, acquired = 0;
  const utility = { world,
    async evaluateExpressionHandle(source) {
      acquired++;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return runInNewContext('(' + source + ')()', { performance,
        setTimeout: (fn, ms) => setTimeout(fn, Math.max(pageTimerFloor, ms)), clearTimeout,
        document: { getAnimations: () => animations }, MutationObserver: class {
          constructor(fn) { changed = fn; }
          observe(_target, options) { observed = options; }
          disconnect() { disconnected++; }
        } });
    },
    async evaluateExpression(_source, _options, [state, method, arg]) { return state[method](arg); },
  };
  const handle = utility.evaluateExpressionHandle;
  utility.evaluateExpressionHandle = async (...args) => {
    const state = await handle(...args); state.disposeHandle = () => { released++; };
    // Keep the protocol handle's release distinct from the in-world disposer.
    return { state, dispose: state.disposeHandle };
  };
  utility.evaluateExpression = async (_source, _options, [handle, method, arg]) => handle.state[method](arg);
  const frame = { _connection: { toImpl: () => ({ utilityContext: async () => utility }) } };
  return { entry: { page: { mainFrame: () => frame } }, change: () => changed?.(),
    observed: () => observed, counts: () => ({ disconnected, released, acquired }) };
}

test('TA1 finite native animation timing subtracts capture lead and ignores infinite and paused tracks', async () => {
  const f = fixture({ animations: [
    { playState: 'running', playbackRate: 2, currentTime: 100, effect: { getComputedTiming: () => ({ endTime: 1000 }) } },
    { playState: 'running', playbackRate: 1, currentTime: 0, effect: { getComputedTiming: () => ({ endTime: Infinity }) } },
    { playState: 'paused', playbackRate: 1, currentTime: 0, effect: { getComputedTiming: () => ({ endTime: 9999 }) } },
  ] });
  const clock = await motionClock(f.entry);
  try {
    f.change();
    const result = await clock.next({ after: 0, left: 3, fallback: 100, lead: 25 });
    assert.equal(result.remaining, 450); assert.equal(result.gap, 125);
  } finally { await clock.dispose(); }
  assert.deepEqual(f.counts(), { disconnected: 1, released: 1, acquired: 1 });
});

test('TA1 visual mutations wake the native clock without returning any page data', async () => {
  const f = fixture(), clock = await motionClock(f.entry);
  try {
    const next = clock.next({ after: performance.timeOrigin + performance.now(), left: 3, fallback: 100 });
    f.change();
    const result = await next;
    assert.deepEqual(Object.keys(result).sort(), ['active', 'changed', 'gap', 'remaining']);
    assert.equal(result.changed, true);
    assert.equal(result.gap, 100);
  } finally { await clock.dispose(); }
});

test('TA1R a no-signal page retains the 100 ms fallback with a 50 ms floor', async () => {
  const f = fixture(), clock = await motionClock(f.entry);
  try {
    for (const [fallback, gap] of [[100, 100], [10, 50]]) {
      const start = performance.now();
      const result = await clock.next({ after: performance.timeOrigin + start, left: 3, fallback, lead: 25 });
      assert.equal(result.remaining, 0); assert.equal(result.gap, gap);
      assert.ok(performance.now() - start < 400, 'no-signal sampling must not wait 500 ms');
    }
    const options = f.observed();
    assert.equal(options.attributes, true); assert.equal(options.characterData, true);
    assert.equal(options.attributeFilter, undefined);
  } finally { await clock.dispose(); }
});

test('TA1R throttled renderer timers cannot stretch a native motion wait to one second', async () => {
  const f = fixture({ pageTimerFloor: 1000 }), clock = await motionClock(f.entry);
  try {
    const start = performance.now();
    await clock.next({ after: performance.timeOrigin + start, left: 3, fallback: 100 });
    assert.ok(performance.now() - start < 400, 'Node must bound a throttled renderer wait');
  } finally { await clock.dispose(); }
});

test('TA1R3 mutations before the first capture keep later samples off the no-signal grid', async () => {
  const f = fixture(), clock = await motionClock(f.entry);
  try {
    const since = performance.timeOrigin + performance.now() - 1;
    f.change();
    const after = performance.timeOrigin + performance.now() + 1;
    const result = await clock.next({ since, after, left: 3, fallback: 100, sampleAt: after - 1 });
    assert.equal(result.active, true);
    assert.equal(result.changed, false, 'the earlier mutation must not cause an immediate wakeup');
    assert.ok(result.gap >= 500, 'allow the next mutation to arrive instead of spending samples on an expired grid');
  } finally { await clock.dispose(); }
});

test('TA1R3 mutations before input do not stretch a no-signal request', async () => {
  const f = fixture(), clock = await motionClock(f.entry);
  try {
    f.change();
    const since = performance.timeOrigin + performance.now() + 1;
    const result = await clock.next({ since, after: since, left: 3, fallback: 100, sampleAt: since + 75 });
    assert.equal(result.active, false);
    assert.ok(result.gap > 0 && result.gap <= 76);
  } finally { await clock.dispose(); }
});

test('TA1R3 a static sibling frame cannot shorten an active animation wait', async () => {
  const quiet = fixture(), animated = fixture({ animations: [
    { playState: 'running', playbackRate: 1, currentTime: 0, effect: { getComputedTiming: () => ({ endTime: 600 }) } },
  ] });
  quiet.entry.page.frames = () => [quiet.entry.page.mainFrame(), animated.entry.page.mainFrame()];
  const clock = await motionClock(quiet.entry);
  try {
    const start = performance.timeOrigin + performance.now();
    const result = await clock.next({ since: start, after: start, left: 3, fallback: 100, sampleAt: start - 1 });
    assert.equal(result.remaining, 600);
    assert.equal(result.gap, 200);
    assert.ok(performance.timeOrigin + performance.now() - start >= 180);
  } finally { await clock.dispose(); }
});

for (const pageTimerFloor of [0, 1000]) test(`TA1R2 no-signal clock uses an absolute sample time with timer floor ${pageTimerFloor}`, async () => {
  const f = fixture({ pageTimerFloor }), clock = await motionClock(f.entry);
  try {
    const start = performance.timeOrigin + performance.now();
    const result = await clock.next({ after: start, left: 3, fallback: 1000, lead: 65, sampleAt: start + 75 });
    assert.equal(result.remaining, 0); assert.equal(result.changed, false);
    assert.ok(result.gap > 0 && result.gap <= 75);
    assert.ok(performance.timeOrigin + performance.now() - start < 400);
    const late = await clock.next({ after: start, left: 2, fallback: 1000, sampleAt: start - 1 });
    assert.equal(late.gap, 0);
  } finally { await clock.dispose(); }
});

test('TA1 timing never falls back to a MAIN world', async () => {
  const f = fixture({ world: 'main' });
  assert.equal(await motionClock(f.entry), undefined);
  assert.equal(f.counts().acquired, 0);
});

test('TA1 excessive frame counts use interval sampling without creating observers', async () => {
  const f = fixture(); f.entry.page.frames = () => Array.from({ length: 33 }, () => ({}));
  assert.equal(await motionClock(f.entry), undefined);
  assert.equal(f.counts().acquired, 0);
});

test('TA1 timed-out acquisition collects a late utility observer and its handle', async () => {
  const f = fixture({ delay: 550 });
  assert.equal(await motionClock(f.entry), undefined);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(f.counts(), { disconnected: 1, released: 1, acquired: 1 });
});
