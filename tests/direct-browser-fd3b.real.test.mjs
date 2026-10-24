import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, skip } from './fixtures/cr4-real.mjs';
import { inspectElement, check, deliverSnapshot } from '../plugins/sleight/lib/direct-browser/rules.mjs';
import { trustedLocatorRead } from '../plugins/sleight/lib/direct-browser/trusted-dom.mjs';
import { inspectTarget, createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { snapshot, acknowledgeSnapshot } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { waitForThinPage } from '../plugins/sleight/lib/direct-browser/waits.mjs';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const content = '<h1>Fixture with enough visible text to bypass the thin document delay</h1>';
function dispatcher(f) {
  return createToolDispatcher({ pages: f.registry, snapshot, runSteps: createActionRunner({ check, snapshot }), fillFields: () => assert.fail('unused'),
    deliverSnapshot: (state, capture) => { deliverSnapshot(state, capture); return acknowledgeSnapshot(capture.page, capture.number); } });
}
test('FD3B real native form actions and overrides refuse clicks, Enter, script submit and image controls', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content + '<form id="mail" action="mailto:fixture@example.invalid"><input id="text"><button id="button">Open</button></form>' +
    '<form id="zoom" action="/web"><input id="image" type="image" formaction="zoommtg://fixture.invalid" alt="Open"></form>' +
    '<form id="outside" action="/web"></form><input id="externaltext" form="outside"><button id="externalbutton" form="outside" formaction="zoommtg://fixture.invalid">Open</button>');
  for (const inspector of [inspectElement, inspectTarget]) for (const selector of ['#text', '#button', '#image', '#externaltext', '#externalbutton']) {
    const inspected = await trustedLocatorRead(f.entry.page.locator(selector), inspector);
    assert.equal(inspected.appLink, !['#text', '#externaltext'].includes(selector), inspector.name + selector);
    assert.equal(inspected.nativeFormEnter, true, inspector.name + selector);
  }
  const results = await f.entry.page.evaluate(() => {
    const results = [];
    for (const invoke of [() => document.querySelector('#mail').submit(), () => document.querySelector('#mail').requestSubmit(),
      () => document.querySelector('#zoom').requestSubmit(document.querySelector('#image')), () => document.querySelector('#image').click()]) {
      try { invoke(); results.push('ALLOWED'); } catch (error) { results.push(error.name); }
    }
    return results;
  });
  assert.deepEqual(results, Array(4).fill('NotAllowedError'));
  const d = dispatcher(f), tab = f.entry.tab, read = await d.call({ name: 'browser_read', arguments: { tab } }); d.delivered(read);
  const ref = /textbox[^\n]*\[ref=(\w+)\]/.exec(read.text)?.[1]; assert.ok(ref, read.text);
  const result = await d.call({ name: 'browser_act', arguments: { tab, steps: [{ do: 'press', ref, key: 'Enter' }] } });
  assert.match(result.text, /native app/); assert.match(f.entry.page.url(), /\/start$/);
});
test('FD3B real registerProtocolHandler is guarded before scripts and restored on release', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content + '<script>window.savedHandler=navigator.registerProtocolHandler;try{navigator.registerProtocolHandler("web+fixture","/handler?u=%s");window.result="ALLOWED"}catch(e){window.result=e.name}</script>');
  assert.equal(await f.entry.page.evaluate(() => window.result), 'NotAllowedError');
  await f.registry.keep(f.entry.tab);
  assert.equal(await f.entry.page.evaluate(() => { try { window.savedHandler.call(navigator, 'web+fixture', '/handler?u=%s'); return 'restored'; } catch (e) { return e.name; } }), 'restored');
});
test('FD3B real listbox select keys reach page listeners without native-panel cancellation', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content + '<select size="3" id="list"><option>One</option><option>Two</option><option>Three</option></select>');
  const result = await f.entry.page.evaluate(() => {
    const el = document.querySelector('#list'), seen = [];
    el.addEventListener('keydown', event => seen.push(event.key));
    const allowed = ['Enter', ' ', 'ArrowDown'].map(key => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
    return { seen, allowed };
  });
  assert.deepEqual(result, { seen: ['Enter', ' ', 'ArrowDown'], allowed: [true, true, true] });
});
test('FD3B real page-initiated native navigation is stopped or reported for location, meta refresh and iframe', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content), d = dispatcher(f), page = f.entry.page, tab = f.entry.tab, target = f.entry.targetId;
  for (const kind of ['location', 'meta', 'iframe']) {
    await page.evaluate(kind => {
      if (kind === 'location') location.href = 'mailto:fixture@example.invalid';
      else if (kind === 'meta') { const meta = document.createElement('meta'); meta.httpEquiv = 'refresh'; meta.content = '0;url=zoommtg://fixture.invalid'; document.head.append(meta); }
      else { const frame = document.createElement('iframe'); frame.src = 'zoommtg://fixture.invalid'; document.body.append(frame); }
    }, kind);
    await pause(200);
    const result = await d.call({ name: 'browser_read', arguments: { tab } });
    assert.match(result.text, /native app navigation.*(?:blocked|attempted)|native navigation.*(?:blocked|attempted)/i, kind + ': ' + result.text);
    assert.equal(f.entry.targetId, target); assert.equal(f.entry.tab, tab);
  }
});
test('FD3B real static thin document wait is bounded by ready quiet, with measured latency', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, '<p>Thin</p>'), start = Date.now();
  await waitForThinPage(f.entry.page);
  const elapsed = Date.now() - start;
  t.diagnostic('static thin page wait: ' + elapsed + ' ms');
  assert.ok(elapsed >= 280 && elapsed < 1800, String(elapsed));
});
test('FD3B real thin-page early exit still waits for requests followed by 300 ms of quiet', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, '<p>Thin</p>'), page = f.entry.page;
  await page.route('**/pending-thin-fixture', async route => { await pause(450); await route.fulfill({ body: 'fixture' }); });
  const request = page.waitForEvent('request', request => request.url().endsWith('/pending-thin-fixture'));
  await page.evaluate(() => { fetch('/pending-thin-fixture'); }); await request;
  const start = Date.now(); await waitForThinPage(page); const elapsed = Date.now() - start;
  assert.ok(elapsed >= 700 && elapsed < 2000, String(elapsed));
  t.diagnostic('thin page with 450 ms request: ' + elapsed + ' ms');
});
test('FD3B real busy loop during wait is marked stuck, subsequent reads give recovery advice', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content), d = dispatcher(f), tab = f.entry.tab;
  await f.entry.page.evaluate(() => { setTimeout(() => { while (true) {} }, 100); });
  const start = Date.now(), waited = await d.call({ name: 'browser_act', arguments: { tab, steps: [{ do: 'wait', until: 'never appears', ms: 4000 }] } });
  assert.equal(waited.isError, true, waited.text); assert.match(waited.text, /Script seems stuck.*navigate/);
  const retry = await d.call({ name: 'browser_read', arguments: { tab } });
  assert.equal(retry.isError, true); assert.match(retry.text, /Script seems stuck.*navigate/);
  assert.equal(f.entry.state.stuck, true);
  t.diagnostic('wait busy-loop detection: ' + (Date.now() - start) + ' ms including re-probe');
});
test('FD3B real a self-recovering page clears its stuck mark on the next read', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content), d = dispatcher(f), tab = f.entry.tab;
  await f.entry.page.evaluate(() => { setTimeout(() => { const until = Date.now() + 1700; while (Date.now() < until) {} }, 0); });
  await pause(50);
  f.entry.state.stuck = true;
  const start = Date.now(), held = await d.call({ name: 'browser_read', arguments: { tab } });
  assert.equal(held.isError, true); assert.match(held.text, /Script seems stuck/);
  assert.ok(Date.now() - start < 1500, 'marked re-probe has a one second cap');
  await pause(800);
  const read = await d.call({ name: 'browser_read', arguments: { tab } });
  assert.equal(read.isError, false, read.text); assert.equal(f.entry.state.stuck, false);
});
test('FD3B real auxiliary debugger detach reattaches the same owned target and restores native guards', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content), tab = f.entry.tab, target = f.entry.targetId, old = f.entry.cdp;
  await old.detach(); await f.registry.idle();
  assert.notEqual(f.entry.cdp, old); assert.equal(f.entry.targetId, target); assert.equal(f.entry.tab, tab);
  assert.equal(f.entry.state.nativeAttachmentLost, false);
  assert.equal(await f.entry.page.evaluate(() => { try { navigator.registerProtocolHandler('web+fixture', '/h?u=%s'); return 'ALLOWED'; } catch (e) { return e.name; } }), 'NotAllowedError');
  const result = await dispatcher(f).call({ name: 'browser_read', arguments: { tab } });
  assert.equal(result.isError, false, result.text); assert.match(result.text, /debugger detach attempted/);
  assert.equal(f.context.pages().length, 2);
  t.diagnostic('headless auxiliary session detach only; native-protocol detach behavior remains unqualified');
});
test('FD3B real recovery cannot redirect outside the stuck origin without a user-named URL', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content), page = f.entry.page, start = page.url(), destination = start.replace('/start', '/recover-redirect');
  const redirected = start.replace('127.0.0.1', 'localhost').replace('/start', '/landed');
  await page.route('**/recover-redirect', route => route.fulfill({ status: 302, headers: { location: redirected } }));
  f.entry.state.stuck = true;
  const result = await dispatcher(f).call({ name: 'browser_act', arguments: { tab: f.entry.tab, steps: [{ do: 'navigate', url: destination }] } });
  assert.equal(result.isError, true, result.text); assert.match(result.text, /scripts terminated/);
  assert.equal(f.requests.some(row => row.url === '/landed'), false, 'cross-origin redirect must not reach its destination');
});
