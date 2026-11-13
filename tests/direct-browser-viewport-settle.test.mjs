import test from 'node:test';
import assert from 'node:assert/strict';
import { setViewport, restoreViewport } from '../plugins/sleight/lib/direct-browser/viewport.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture({ settleAt = Infinity, native = { width: 1280, height: 720 }, failAfter, hangAfter,
  error = 'metrics unavailable', measureOverride = true, measureBaseline = true, changing = false,
  preClearFails = false, preClearSize } = {}) {
  let size = native, resized = false, overrideMeasured = false, clearedAt, reads = 0, detached = 0;
  const methods = [];
  const session = {
    async send(method) {
      methods.push(method);
      if (method === 'Emulation.clearDeviceMetricsOverride') { clearedAt = Date.now(); return {}; }
      assert.equal(method, 'Page.getLayoutMetrics');
      if (clearedAt !== undefined) {
        reads++;
        if (reads >= hangAfter) return new Promise(() => {});
        if (reads >= failAfter) throw Error(error);
        if (Date.now() - clearedAt >= settleAt) size = native;
        if (changing) size = { width: 390 + reads, height: 844 };
      }
      else if (resized && overrideMeasured) {
        if (preClearFails) throw Error('pre-clear metrics unavailable');
        if (preClearSize) size = preClearSize;
      }
      else if (resized) { overrideMeasured = true; if (!measureOverride) return {}; }
      else if (!measureBaseline) return {};
      return { cssLayoutViewport: { clientWidth: size.width, clientHeight: size.height } };
    },
    async detach() { detached++; },
  };
  const page = { context: () => ({ newCDPSession: async () => session }),
    setViewportSize: async next => { resized = true; overrideMeasured = false; size = next; } };
  return { page, methods, reads: () => reads, detached: () => detached };
}

test('G10D reset waits for a measured layout change, including height alone', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture({ settleAt: 40, native: { width: 390, height: 720 } });
  await setViewport(f.page, { width: 390, height: 844 });
  let done = false;
  const reset = setViewport(f.page, {}).then(value => { done = true; return value; });
  await flush();
  t.mock.timers.tick(20); await flush(); assert.equal(done, false);
  t.mock.timers.tick(20); await flush();
  assert.equal(await reset, 'viewport restored to 390x720');
  assert.equal(f.reads(), 3);
});

for (const options of [{}, { failAfter: 2 }, { hangAfter: 2 }])
  test(`G10D reset expires at 1000 ms with the last measured size ${JSON.stringify(options)}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const f = fixture(options);
    await setViewport(f.page, { width: 390, height: 844 });
    let done = false;
    const reset = setViewport(f.page, {}).then(value => { done = true; return value; });
    await flush();
    for (let i = 0; i < 49; i++) { t.mock.timers.tick(20); await flush(); }
    t.mock.timers.tick(19); await flush(); assert.equal(done, false);
    t.mock.timers.tick(1); await flush();
    assert.equal(await reset, 'viewport restored to 390x844; layout had not settled');
    const reads = f.reads();
    t.mock.timers.tick(2000); await flush(); assert.equal(f.reads(), reads, 'no polling after the deadline');
    assert.equal(await setViewport(f.page, {}), 'viewport unchanged: no size was set on this tab');
  });

test('G10D a reset with no successful metrics never invents dimensions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture({ failAfter: 1 });
  await setViewport(f.page, { width: 390, height: 844 });
  const reset = setViewport(f.page, {}); await flush();
  t.mock.timers.tick(1000); await flush();
  assert.equal(await reset, 'viewport restored; layout had not settled');
});

test('G10D release clears overrides without waiting for a result size', async () => {
  const f = fixture();
  await setViewport(f.page, { width: 390, height: 844 });
  assert.equal(await restoreViewport(f.page, { release: true }), 'viewport overrides cleared');
  assert.equal(f.reads(), 0);
  assert.equal(f.detached(), 3);
});

test('G10D reset compares with the latest measured override after multiple resizes', async () => {
  const f = fixture({ settleAt: 0, native: { width: 390, height: 844 } });
  await setViewport(f.page, { width: 390, height: 844 });
  await setViewport(f.page, { width: 768, height: 1024 });
  assert.equal(await setViewport(f.page, {}), 'viewport restored to 390x844');
  assert.equal(f.reads(), 1);
});

test('G10E stable native reads finish in 40 ms when the pre-clear size equals the native baseline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture({ native: { width: 390, height: 844 } });
  await setViewport(f.page, { width: 390, height: 844 });
  let done = false;
  const reset = setViewport(f.page, {}).then(value => { done = true; return value; });
  await flush();
  t.mock.timers.tick(39); await flush(); assert.equal(done, false);
  t.mock.timers.tick(1); await flush();
  assert.equal(done, true);
  assert.equal(Date.now(), 40);
  assert.equal(await reset, 'viewport restored to 390x844');
  assert.equal(f.reads(), 2);
  t.mock.timers.tick(2000); await flush(); assert.equal(f.reads(), 2);
});

test('G10E a failed size override also accepts stable measured native layout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture();
  f.page.setViewportSize = async () => { throw Error('size refused'); };
  await assert.rejects(setViewport(f.page, { width: 390, height: 844 }), /size refused/);
  const reset = setViewport(f.page, {}); await flush();
  t.mock.timers.tick(40); await flush();
  assert.equal(await reset, 'viewport restored to 1280x720');
  assert.equal(f.reads(), 2);
});

for (const error of ['Target closed', 'Target page, context or browser has been closed',
  'Session closed. Most likely the page has been closed.', 'Session has been detached'])
  for (const failAfter of [1, 2]) test(`G10E stops on ${error} at read ${failAfter} without dimensions`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const f = fixture({ error, failAfter });
    await setViewport(f.page, { width: 390, height: 844 });
    let done = false;
    const reset = setViewport(f.page, {}).then(value => { done = true; return value; });
    await flush();
    if (failAfter === 2) { assert.equal(done, false); t.mock.timers.tick(20); await flush(); }
    assert.equal(done, true);
    assert.equal(Date.now(), (failAfter - 1) * 20);
    assert.equal(await reset, 'viewport restored; layout had not settled');
    t.mock.timers.tick(2000); await flush(); assert.equal(f.reads(), failAfter);
  });

test('G10E changing unmeasured layout keeps the note at the 1000 ms deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture({ measureOverride: false, preClearFails: true, changing: true });
  await setViewport(f.page, { width: 390, height: 844 });
  let done = false;
  const reset = setViewport(f.page, {}).then(value => { done = true; return value; });
  await flush();
  for (let i = 0; i < 49; i++) { t.mock.timers.tick(20); await flush(); }
  t.mock.timers.tick(19); await flush(); assert.equal(done, false);
  t.mock.timers.tick(1); await flush();
  assert.equal(await reset, 'viewport restored to 440x844; layout had not settled');
  assert.equal(Date.now(), 1000);
  assert.equal(f.reads(), 50);
  t.mock.timers.tick(2000); await flush(); assert.equal(f.reads(), 50);
});

for (const measureBaseline of [true, false])
  test(`G10F an unmeasured saved override uses the pre-clear size, baseline=${measureBaseline}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const f = fixture({ measureOverride: false, measureBaseline, settleAt: 80 });
    await setViewport(f.page, { width: 390, height: 844 });
    const before = f.methods.length;
    let done = false;
    const reset = setViewport(f.page, {}).then(value => { done = true; return value; });
    await flush();
    assert.deepEqual(f.methods.slice(before), ['Page.getLayoutMetrics', 'Emulation.clearDeviceMetricsOverride', 'Page.getLayoutMetrics']);
    for (let i = 0; i < 3; i++) { t.mock.timers.tick(20); await flush(); assert.equal(done, false); }
    t.mock.timers.tick(20); await flush();
    assert.equal(await reset, 'viewport restored to 1280x720' + (measureBaseline ? '' : '; previous size unknown'));
    assert.equal(f.reads(), 5);
  });

for (const measureOverride of [true, false])
  test(`G10F a failed pre-clear read keeps polling, saved override=${measureOverride}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const f = fixture({ measureOverride, preClearFails: true });
    await setViewport(f.page, { width: 390, height: 844 });
    let done = false;
    const reset = setViewport(f.page, {}).then(value => { done = true; return value; });
    await flush();
    for (let i = 0; i < 49; i++) { t.mock.timers.tick(20); await flush(); }
    t.mock.timers.tick(19); await flush(); assert.equal(done, false);
    t.mock.timers.tick(1); await flush();
    assert.equal(await reset, 'viewport restored to 390x844; layout had not settled');
    assert.equal(f.reads(), 50);
    t.mock.timers.tick(2000); await flush(); assert.equal(f.reads(), 50);
  });

test('G10F the pre-clear size replaces a saved override equal to the native baseline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture({ native: { width: 390, height: 844 }, preClearSize: { width: 400, height: 900 }, settleAt: 80 });
  await setViewport(f.page, { width: 390, height: 844 });
  let done = false;
  const reset = setViewport(f.page, {}).then(value => { done = true; return value; });
  await flush();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(20); await flush(); assert.equal(done, false); }
  t.mock.timers.tick(20); await flush();
  assert.equal(await reset, 'viewport restored to 390x844');
});

test('G10F a failed pre-clear read falls back to the saved override when native layout differs', async () => {
  const f = fixture({ preClearFails: true, settleAt: 0 });
  await setViewport(f.page, { width: 390, height: 844 });
  assert.equal(await setViewport(f.page, {}), 'viewport restored to 1280x720');
  assert.equal(f.reads(), 1);
});

test('G10F a failed pre-clear read cannot enable the native-equals-override stable rule', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const f = fixture({ preClearFails: true, native: { width: 390, height: 844 } });
  await setViewport(f.page, { width: 390, height: 844 });
  let done = false;
  const reset = setViewport(f.page, {}).then(value => { done = true; return value; });
  await flush();
  for (let i = 0; i < 49; i++) { t.mock.timers.tick(20); await flush(); }
  assert.equal(done, false);
  t.mock.timers.tick(20); await flush();
  assert.equal(await reset, 'viewport restored to 390x844; layout had not settled');
  assert.equal(f.reads(), 50);
});

for (const thrown of [Error('Inspected target navigated or closed'), null, 'Inspected target navigated or closed'])
  test(`G10F retries a transient or non-Error read failure: ${String(thrown)}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    const f = fixture({ settleAt: 40 });
    await setViewport(f.page, { width: 390, height: 844 });
    const context = f.page.context(), session = await context.newCDPSession(f.page), send = session.send.bind(session);
    let failed = false;
    session.send = async method => {
      if (!failed && method === 'Page.getLayoutMetrics' && f.methods.at(-1) === 'Emulation.clearDeviceMetricsOverride') {
        failed = true; throw thrown;
      }
      return send(method);
    };
    let done = false;
    const reset = setViewport(f.page, {}).then(value => { done = true; return value; });
    await flush(); assert.equal(done, false); assert.equal(failed, true);
    t.mock.timers.tick(20); await flush(); assert.equal(done, false);
    t.mock.timers.tick(20); await flush();
    assert.equal(await reset, 'viewport restored to 1280x720');
    assert.equal(f.reads(), 2);
  });
