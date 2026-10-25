import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTouch, restoreTouch } from '../plugins/sleight/lib/direct-browser/touch.mjs';
import { setViewport } from '../plugins/sleight/lib/direct-browser/viewport.mjs';
import { validateToolCall } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';

function fixture(points = 0) {
  const page = new EventEmitter(), calls = [];
  let current = points, fail = false, detachFails = false, sizeFails = false, detached = 0;
  let size = { width: 1280, height: 720 };
  page.setViewportSize = async next => {
    if (sizeFails) throw Error('size refused');
    size = { ...next };
  };
  page.context = () => ({ newCDPSession: async () => ({
    async send(method, params) {
      calls.push([method, params]);
      if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: size.width, clientHeight: size.height } };
      if (method === 'Emulation.clearDeviceMetricsOverride') {
        if (sizeFails) throw Error('size refused');
        size = { width: 1280, height: 720 }; return {};
      }
      if (method === 'Emulation.setEmitTouchEventsForMouse') { assert.deepEqual(params, { enabled: false }); return {}; }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'Runtime.evaluate') {
        assert.equal(params.contextId, 7);
        return { result: { value: current } };
      }
      assert.equal(method, 'Emulation.setTouchEmulationEnabled');
      if (fail) throw Error('CDP refused');
      current = params.enabled ? params.maxTouchPoints : 0;
      return {};
    },
    async detach() { detached++; if (detachFails) throw Error('detach refused'); },
  }) });
  page.isClosed = () => false;
  return { page, calls, points: () => current, size: () => size, detached: () => detached,
    fail: value => { fail = value; }, detachFails: value => { detachFails = value; }, sizeFails: value => { sizeFails = value; } };
}

test('touch changes and restores the original capability, keeping the session until restoration', async () => {
  const f = fixture();
  assert.equal(await setTouch(f.page, true), 'touch on');
  assert.equal(f.points(), 1);
  assert.equal(f.detached(), 0);
  assert.equal(await setTouch(f.page, false), 'touch off');
  assert.equal(f.points(), 0);
  await setTouch(f.page, true);
  assert.equal(await restoreTouch(f.page), 'touch restored');
  assert.equal(f.points(), 0);
  assert.equal(f.detached(), 1);
  assert.deepEqual(f.calls.slice(-2), [['Emulation.setTouchEmulationEnabled', { enabled: false }],
    ['Emulation.setEmitTouchEventsForMouse', { enabled: false }]]);
  assert.equal(await restoreTouch(f.page), undefined);
  assert.equal(f.calls.filter(([method]) => method === 'Page.createIsolatedWorld').length, 1);
});

test('restoration isolates tabs', async () => {
  const a = fixture(), b = fixture();
  await setTouch(a.page, true); await setTouch(b.page, true);
  await restoreTouch(a.page);
  assert.equal(a.points(), 0); assert.equal(b.points(), 1);
  await restoreTouch(b.page); assert.equal(b.points(), 0);
});

test('a pre-existing touch capability is refused before any emulation command', async () => {
  const f = fixture(5);
  await assert.rejects(setTouch(f.page, false), /existing touch capability/);
  assert.equal(f.points(), 5);
  assert.ok(!f.calls.some(([method]) => method === 'Emulation.setTouchEmulationEnabled'));
  assert.equal(await restoreTouch(f.page), undefined);
});

test('a bare viewport restores touch even when no size was changed', async () => {
  const f = fixture();
  assert.equal(await setViewport(f.page, { touch: true }), 'viewport touch on');
  assert.match(await setViewport(f.page, {}), /touch restored/);
  assert.equal(f.points(), 0);
});

test('a failed restore remains owed and can be retried', async () => {
  const f = fixture(); await setTouch(f.page, true); f.fail(true);
  await assert.rejects(restoreTouch(f.page), /CDP refused/);
  assert.equal(f.detached(), 0);
  f.fail(false); await restoreTouch(f.page);
  assert.equal(f.points(), 0); assert.equal(f.detached(), 1);
});

test('a refused width plus touch step preserves size and media', async () => {
  const f = fixture(5);
  let media = { colorScheme: 'light' };
  f.page.emulateMedia = async next => { media = { ...media, ...next }; };
  await assert.rejects(setViewport(f.page, { width: 390, height: 844, color_scheme: 'dark', touch: true }), /existing touch capability/);
  assert.deepEqual(f.size(), { width: 1280, height: 720 });
  assert.deepEqual(media, { colorScheme: 'light' });
  assert.equal(f.points(), 5);
  assert.match(await setViewport(f.page, {}), /unchanged/);
});

test('a bare viewport restores size even if touch restoration fails', async () => {
  const f = fixture();
  await setViewport(f.page, { width: 390, height: 844, touch: true });
  f.fail(true);
  await assert.rejects(setViewport(f.page, {}), /CDP refused/);
  assert.deepEqual(f.size(), { width: 1280, height: 720 });
  assert.equal(f.points(), 1);
  f.fail(false);
  await setViewport(f.page, {});
  assert.equal(f.points(), 0);
});

test('a bare viewport restores touch even if size restoration fails', async () => {
  const f = fixture();
  await setViewport(f.page, { width: 390, height: 844, touch: true });
  f.sizeFails(true);
  await assert.rejects(setViewport(f.page, {}), /size refused/);
  assert.equal(f.points(), 0);
  assert.deepEqual(f.size(), { width: 390, height: 844 });
  f.sizeFails(false);
  await setViewport(f.page, {});
  assert.deepEqual(f.size(), { width: 1280, height: 720 });
});

test('a successful touch restore forgets its state even when detach fails', async () => {
  const f = fixture();
  await setTouch(f.page, true);
  f.detachFails(true);
  await assert.rejects(restoreTouch(f.page), /detach refused/);
  assert.equal(f.points(), 0);
  assert.equal(f.page.listenerCount('close'), 0);
  const calls = f.calls.length;
  assert.equal(await restoreTouch(f.page), undefined);
  assert.equal(f.calls.length, calls);
  f.detachFails(false);
  await setTouch(f.page, true);
  await restoreTouch(f.page);
  assert.equal(f.points(), 0);
});

test('touch sessions detach on page closure and listeners do not accumulate across resets', async () => {
  const f = fixture();
  for (let n = 0; n < 3; n++) { await setTouch(f.page, true); await restoreTouch(f.page); }
  assert.equal(f.page.listenerCount('close'), 0);
  await setTouch(f.page, true); f.page.emit('close');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.detached(), 4);
  assert.equal(await restoreTouch(f.page), undefined);
});

test('baseline failure refuses touch before mutation and permits a fresh attempt', async () => {
  const f = fixture(), context = f.page.context();
  const originalSession = context.newCDPSession;
  f.page.context = () => context;
  context.newCDPSession = async () => ({ send: async () => { throw Error('baseline failed'); }, detach: async () => {} });
  await assert.rejects(setTouch(f.page, true), /baseline failed/);
  assert.equal(f.points(), 0); assert.equal(f.page.listenerCount('close'), 0);
  context.newCDPSession = originalSession;
  await setTouch(f.page, true); await restoreTouch(f.page);
  assert.equal(f.points(), 0);
});

test('failed input does not discard the original touch capability', async () => {
  const f = fixture(); f.fail(true);
  await assert.rejects(setTouch(f.page, false), /CDP refused/);
  f.fail(false); await restoreTouch(f.page); assert.equal(f.points(), 0);
});

test('touch must be boolean and belongs only to viewport at both boundaries', async () => {
  const f = fixture(), call = step => validateToolCall({ name: 'browser_act', arguments: { tab: 'tfixture', steps: [step] } });
  call({ do: 'viewport', touch: true }); call({ do: 'viewport', touch: false });
  for (const step of [{ do: 'viewport', touch: 'true' }, { do: 'wait', touch: true }]) {
    assert.throws(() => call(step), /touch/);
    await assert.rejects(createActionRunner({ check: async () => ({ kind: 'allow' }), snapshot: async () => ({ text: '', number: 1 }) })
      ({ page: f.page, state: {} }, [step], {}), /touch/);
  }
  assert.deepEqual(f.calls, []);
});
