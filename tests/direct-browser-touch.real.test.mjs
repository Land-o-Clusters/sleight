import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, skip } from './fixtures/cr4-real.mjs';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { setTouch, restoreTouch } from '../plugins/sleight/lib/direct-browser/touch.mjs';
import { setViewport } from '../plugins/sleight/lib/direct-browser/viewport.mjs';

const html = `<!doctype html><meta name="viewport" content="width=device-width">
<style>#touch { display:none } @media (pointer:coarse) { #touch { display:block } }</style>
<p id="touch">Touch layout</p><p>Read the layout without submitting or navigating.</p>`;
const capabilities = page => page.evaluate(() => ({ points: navigator.maxTouchPoints,
  coarse: matchMedia('(pointer: coarse)').matches, hover: matchMedia('(hover: hover)').matches,
  touchLayout: getComputedStyle(document.querySelector('#touch')).display,
}));

async function dispatcher(f) {
  let number = 0;
  const snapshot = async () => ({ text: 'Untrusted fixture layout', number: ++number });
  const runSteps = createActionRunner({ check: async () => ({ kind: 'allow' }), snapshot });
  const tools = createToolDispatcher({ browser: 'bfixture', pages: f.registry, snapshot, runSteps, fillFields: async () => ({ rows: [] }) });
  const call = async steps => {
    const result = await tools.call({ name: 'browser_act', arguments: { tab: f.entry.tab, steps } });
    assert.equal(result.isError, false, result.text); return result.text;
  };
  return { tools, call };
}

test('G10 touch toggles real capabilities and CSS on only the owned tab, with explicit reset', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, html, {}, { observeTabs: true }), page = f.entry.page, { tools, call } = await dispatcher(f);
  const before = await capabilities(page), sentinel = await f.sentinel.evaluate(() => navigator.maxTouchPoints);
  const tabsBefore = await f.tabState();
  const url = page.url(), requests = f.requests.length;
  assert.equal(before.points, 0); assert.equal(before.coarse, false);
  const result = await call([{ do: 'viewport', width: 390, height: 844, touch: true }]);
  assert.match(result, /touch on/);
  assert.equal(await page.evaluate(() => innerWidth), 390);
  assert.deepEqual(await capabilities(page), { points: 1, coarse: true, hover: false, touchLayout: 'block' });
  assert.equal(await f.sentinel.evaluate(() => navigator.maxTouchPoints), sentinel);
  await call([{ do: 'viewport', width: 768, height: 1024 }]);
  assert.equal((await capabilities(page)).points, 1, 'size-only step preserves touch');
  await call([{ do: 'viewport', touch: false }]); assert.deepEqual(await capabilities(page), before);
  assert.equal(await page.evaluate(() => innerWidth), 768, 'touch-only step leaves size alone');
  await call([{ do: 'viewport', touch: true }]);
  assert.match(await call([{ do: 'viewport' }]), /touch restored/);
  assert.deepEqual(await capabilities(page), before);
  assert.equal(await page.evaluate(() => innerWidth), 1280);
  assert.equal(page.url(), url); assert.equal(f.requests.length, requests);
  assert.deepEqual(await f.tabState(), tabsBefore, 'active tab and target inventory stay unchanged');
  const foreign = await tools.call({ name: 'browser_act', arguments: { tab: 'tforeign', steps: [{ do: 'viewport', touch: true }] } });
  assert.equal(foreign.isError, true); assert.match(foreign.text, /owned tab/);
});

for (const kind of ['keep', 'handoff']) test(`G10 ${kind} restores touch before releasing the tab and ending the turn`, { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, html), page = f.entry.page, before = await capabilities(page), { tools, call } = await dispatcher(f);
  await call([{ do: 'viewport', touch: true }]); assert.equal((await capabilities(page)).points, 1);
  const released = await tools.call({ name: 'browser_tabs', arguments: { do: kind, tab: f.entry.tab } });
  assert.equal(released.isError, false, released.text);
  assert.deepEqual(await capabilities(page), before);
  assert.equal(page.isClosed(), false);
  const ended = await tools.end(); assert.equal(ended.revoked, true);
  assert.equal(page.isClosed(), false); assert.deepEqual(await capabilities(page), before);
});

test('G10 a closed tab ends touch override ownership at turn end', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, html), { tools, call } = await dispatcher(f);
  await call([{ do: 'viewport', touch: true }]);
  const end = await tools.end();
  assert.equal(end.revoked, true); assert.equal(f.entry.page.isClosed(), true);
  assert.equal(await restoreTouch(f.entry.page), undefined);
});

test('G10 touch baseline ignores hostile page getters and persists across same-tab reload', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, html + `<script>Object.defineProperty(Navigator.prototype,'maxTouchPoints',{get(){throw Error('page getter')}});</script>`);
  await setTouch(f.entry.page, true);
  assert.equal(await f.entry.page.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
  await f.entry.page.reload();
  assert.equal(await f.entry.page.evaluate(() => matchMedia('(pointer: coarse)').matches), true);
  await restoreTouch(f.entry.page);
  assert.equal(await f.entry.page.evaluate(() => matchMedia('(pointer: coarse)').matches), false);
});

test('G10 a failed touch restore refuses release and remains retryable', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, html), newSession = f.context.newCDPSession.bind(f.context);
  let fail = false;
  f.context.newCDPSession = async page => {
    const session = await newSession(page), send = session.send.bind(session);
    session.send = (method, params) => method === 'Emulation.setTouchEmulationEnabled' && !params.enabled && fail
      ? Promise.reject(Error('test restore failure')) : send(method, params);
    return session;
  };
  await setTouch(f.entry.page, true); fail = true;
  await assert.rejects(f.registry.keep(f.entry.tab), /test restore failure/);
  assert.equal(f.registry.tab(f.entry.tab).page, f.entry.page);
  assert.equal((await capabilities(f.entry.page)).points, 1);
  fail = false; await f.registry.keep(f.entry.tab);
  assert.equal((await capabilities(f.entry.page)).points, 0);
});

test('G10 an existing touch capability is refused without changing it', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, html), prior = await f.context.newCDPSession(f.entry.page);
  await prior.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await assert.rejects(setTouch(f.entry.page, false), /existing touch capability/);
  assert.equal((await capabilities(f.entry.page)).points, 5);
  await prior.detach();
});

test('G10B a refused combined step leaves the real size and media unchanged', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, html), page = f.entry.page, prior = await f.context.newCDPSession(page);
  const state = () => page.evaluate(() => ({ width: innerWidth, height: innerHeight,
    dark: matchMedia('(prefers-color-scheme: dark)').matches, reduce: matchMedia('(prefers-reduced-motion: reduce)').matches }));
  const before = await state();
  await prior.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await assert.rejects(setViewport(page, { width: 390, height: 844, color_scheme: 'dark', reduced_motion: true, touch: true }), /existing touch capability/);
  assert.deepEqual(await state(), before);
  assert.equal((await capabilities(page)).points, 5);
  await prior.detach();
});

for (const failed of ['size', 'touch']) test(`G10B a real reset restores the other override when ${failed} fails`, { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, html), page = f.entry.page, newSession = f.context.newCDPSession.bind(f.context);
  const resize = page.setViewportSize.bind(page);
  let fail = false;
  page.setViewportSize = size => fail && failed === 'size' ? Promise.reject(Error('size reset refused')) : resize(size);
  f.context.newCDPSession = async target => {
    const session = await newSession(target), send = session.send.bind(session);
    session.send = (method, params) => fail && failed === 'touch' && method === 'Emulation.setTouchEmulationEnabled' && !params.enabled
      ? Promise.reject(Error('touch reset refused')) : send(method, params);
    return session;
  };
  await setViewport(page, { width: 390, height: 844, touch: true });
  fail = true;
  await assert.rejects(setViewport(page, {}), new RegExp(failed + ' reset refused'));
  assert.equal(await page.evaluate(() => innerWidth), failed === 'size' ? 390 : 1280);
  assert.equal((await capabilities(page)).points, failed === 'touch' ? 1 : 0);
  fail = false;
  await setViewport(page, {});
  assert.equal(await page.evaluate(() => innerWidth), 1280);
  assert.equal((await capabilities(page)).points, 0);
});
