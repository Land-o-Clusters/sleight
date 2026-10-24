import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, skip } from './fixtures/cr4-real.mjs';
import { snapshot, acknowledgeSnapshot } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { inspectElement, check, deliverSnapshot } from '../plugins/sleight/lib/direct-browser/rules.mjs';
import { trustedLocatorRead } from '../plugins/sleight/lib/direct-browser/trusted-dom.mjs';
import { waitForPage, waitForThinPage } from '../plugins/sleight/lib/direct-browser/waits.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const content = '<h1>Fixture page with enough visible content to avoid the initial thin-page wait</h1>';
function dispatcher(f) {
  const runSteps = createActionRunner({ check, snapshot });
  return createToolDispatcher({ pages: f.registry, snapshot, runSteps, fillFields: () => assert.fail('unused'),
    deliverSnapshot: (state, capture) => { deliverSnapshot(state, capture); return acknowledgeSnapshot(capture.page, capture.number); } });
}

test('FD3 real native UI APIs are blocked before page scripts and restored on keep, including a held method', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content + '<input id="color" type="color"><select id="choice"><option>One</option></select>' +
    '<script>window.earlyPrint=window.print;try{window.print();window.early="allowed"}catch(e){window.early=e.name}</script>');
  const page = f.entry.page;
  assert.equal(await page.evaluate(() => window.early), 'NotAllowedError');
  const results = await page.evaluate(async () => {
    const candidates = [
      ['print', () => window.print()], ['fullscreen', () => document.documentElement.requestFullscreen()],
      ['pointer lock', () => document.body.requestPointerLock()], ['color picker', () => document.querySelector('#color').showPicker()],
      ['select picker', () => document.querySelector('#choice').showPicker()],
      ...['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker'].filter(key => typeof window[key] === 'function').map(key => [key, () => window[key]()]),
      ...(typeof EyeDropper === 'function' ? [['eyedropper', () => new EyeDropper().open()]] : []),
      ...(navigator.share ? [['share', () => navigator.share({ text: 'fixture' })]] : []),
      ...(navigator.credentials ? [['passkey get', () => navigator.credentials.get({ publicKey: {} })], ['passkey create', () => navigator.credentials.create({ publicKey: {} })]] : []),
      ...(navigator.mediaDevices ? [['camera', () => navigator.mediaDevices.getUserMedia({ video: true })], ['display', () => navigator.mediaDevices.getDisplayMedia({ video: true })]] : []),
      ...(document.createElement('video').requestPictureInPicture ? [['picture in picture', () => document.createElement('video').requestPictureInPicture()]] : []),
    ];
    const results = [];
    for (const [name, invoke] of candidates) {
      try { await invoke(); results.push([name, 'ALLOWED']); } catch (error) { results.push([name, error.name, error.message]); }
    }
    return results;
  });
  assert.ok(results.length >= 10, JSON.stringify(results));
  for (const [name, kind, message] of results) { assert.equal(kind, 'NotAllowedError', name); assert.match(message, /Native UI is blocked/, name); }
  t.diagnostic('blocked APIs: ' + results.map(row => row[0]).join(', '));
  const before = await page.evaluate(() => Function.prototype.toString.call(window.print));
  assert.match(before, /native code/);
  await f.registry.keep(f.entry.tab);
  // Headless print itself is a no-op. This also proves a page-held wrapper is released.
  assert.equal(await page.evaluate(() => { try { window.earlyPrint(); return 'released'; } catch (error) { return error.name; } }), 'released');
  assert.equal(f.context.pages().includes(page), true);
});

test('FD3 real app-link descendants and SVG links refuse before input; web links remain available', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content + '<a href="mailto:fixture@example.invalid"><span id="mail">Mail</span></a>' +
    '<svg><a xlink:href="zoommtg://fixture.invalid" xmlns:xlink="http://www.w3.org/1999/xlink"><text id="svg">Meeting</text></a></svg>' +
    '<a id="web" href="/landed">Web</a>');
  for (const selector of ['#mail', 'svg a', '#svg']) {
    const element = await trustedLocatorRead(f.entry.page.locator(selector), inspectElement);
    assert.equal(element.appLink, true);
    const verdict = check({}, 'click', { element, state: f.entry.state });
    assert.equal(verdict.verdict, 'refuse'); assert.match(verdict.message, /native app/);
  }
  assert.equal((await trustedLocatorRead(f.entry.page.locator('#web'), inspectElement)).appLink, false);
  assert.match(f.entry.page.url(), /\/start$/);
});

test('FD3 real page-script clicks and dispatched clicks cannot open native controls in a closed root or through a label', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content + '<div id="host"></div><label id="label" for="color">Pick color</label><input id="color" type="color">');
  const results = await f.entry.page.evaluate(() => {
    const root = document.querySelector('#host').attachShadow({ mode: 'closed' });
    root.innerHTML = '<input type="color"><a href="mailto:fixture@example.invalid">Mail</a>';
    const nodes = [root.querySelector('input'), root.querySelector('a'), document.querySelector('#label')];
    const results = [];
    for (const node of nodes) for (const invoke of [() => node.click(), () => node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))]) {
      try { invoke(); results.push('ALLOWED'); } catch (error) { results.push(error.name); }
    }
    return results;
  });
  assert.deepEqual(results, Array(6).fill('NotAllowedError'));
  assert.match(f.entry.page.url(), /\/start$/);
});

test('FD3 real text, gone and URL waits observe delayed DOM in a child frame and same-document navigation', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content + '<p id="loading">Loading marker</p><iframe srcdoc="<p>Child waiting</p>"></iframe>');
  const page = f.entry.page;
  await page.evaluate(() => {
    setTimeout(() => { document.querySelector('iframe').contentDocument.body.innerHTML = '<p>Child ready marker</p>'; }, 300);
    setTimeout(() => document.querySelector('#loading').remove(), 600);
    setTimeout(() => history.pushState({}, '', '/ready-fixture'), 850);
  });
  const runner = createActionRunner({ check, snapshot });
  for (const step of [{ do: 'wait', until: 'Child ready marker' }, { do: 'wait', gone: 'Loading marker' }, { do: 'wait', url: '/ready-fixture' }]) {
    const result = await runner(f.entry, [step]);
    assert.match(result.lines[0], /wait condition met after \d+ ms/, result.lines.join('\n'));
    assert.doesNotMatch(result.lines[0], /input sent|not run|cap/);
  }
  const miss = await runner(f.entry, [{ do: 'wait', until: 'absent marker', ms: 120 }]);
  assert.match(miss.lines[0], /wait condition not met.*cap/);
});

test('FD3 real default wait tracks DOM mutations and rendering requests; thin navigation waits for client rendering', { skip, timeout: 60000 }, async t => {
  const html = '<div id="root"></div><script>setTimeout(()=>{document.querySelector("#root").textContent="Client ready"},650)</script>';
  const start = Date.now(), f = await fixture(t, html);
  // A ready, quiet document returns early even if a future timer will add text.
  await waitForPage(f.entry.page, { until: 'Client ready' }, { snapshot });
  assert.equal(await f.entry.page.locator('#root').innerText(), 'Client ready');
  const openMs = Date.now() - start;
  t.diagnostic('thin client page open including browser startup: ' + openMs + ' ms');
  const page = f.entry.page;
  await page.evaluate(() => {
    setTimeout(() => document.querySelector('#root').setAttribute('data-phase', 'one'), 100);
    setTimeout(() => document.querySelector('#root').setAttribute('data-phase', 'two'), 300);
  });
  const settledAt = Date.now(), result = await waitForPage(page, {});
  assert.match(result, /^settled after \d+ ms$/); assert.ok(Date.now() - settledAt >= 700, result);
  await page.route('**/slow-fixture', async route => { await pause(450); await route.fulfill({ body: 'fixture' }); });
  const request = page.waitForEvent('request', request => request.url().endsWith('/slow-fixture'));
  await page.evaluate(() => { fetch('/slow-fixture'); }); await request;
  const requestAt = Date.now(), network = await waitForPage(page, {});
  assert.match(network, /^settled after \d+ ms$/); assert.ok(Date.now() - requestAt >= 800, network);
  await page.goto(page.url().replace('/start', '/empty'));
  // This route has the same delayed client rendering. The helper also works after an explicit navigation.
  await waitForThinPage(page);
  await waitForPage(page, { until: 'Client ready' }, { snapshot });
  assert.equal(await page.locator('#root').innerText(), 'Client ready');
});

test('FD3 real busy-loop read fails near six seconds, retains its handle, then terminates and navigates that tab', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content + '<button>Observed button</button>'), page = f.entry.page, d = dispatcher(f);
  const tab = f.entry.tab, target = f.entry.targetId;
  const initial = await d.call({ name: 'browser_read', arguments: { tab } }); assert.equal(d.delivered(initial), true);
  await page.evaluate(() => { setTimeout(() => { while (true) {} }, 0); });
  await pause(50);
  const start = Date.now(), failed = await d.call({ name: 'browser_read', arguments: { tab } }), elapsed = Date.now() - start;
  assert.equal(failed.isError, true); assert.match(failed.text, /Script seems stuck; tab retained/);
  assert.ok(elapsed >= 2900 && elapsed < 10000, String(elapsed));
  const retryAt = Date.now(), retry = await d.call({ name: 'browser_read', arguments: { tab } });
  assert.equal(retry.isError, true); assert.ok(Date.now() - retryAt < 1800);
  assert.equal((await f.registry.list()).some(row => row.tab === tab), true);
  const result = await d.call({ name: 'browser_act', arguments: { tab, steps: [{ do: 'navigate', url: page.url().replace('/start', '/landed') }] } });
  assert.equal(result.isError, false, result.text); assert.match(result.text, /terminated stuck script; navigated in the same tab/);
  assert.match(result.text, /left http:\/\/127.0.0.1:\d+; unsaved page state discarded/);
  assert.match(result.text, /Landed/); assert.equal(f.entry.targetId, target); assert.equal(f.entry.tab, tab);
  assert.equal(f.context.pages().length, 2); assert.equal(f.entry.state.stuck, false);
  t.diagnostic('busy-loop read error: ' + elapsed + ' ms; immediate retry retained tab; same target recovered');
});

test('FD3 real busy-loop target inspection fails fast before input and does not replay after recovery', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content + '<button onclick="window.sent=(window.sent||0)+1">Observed button</button>'), page = f.entry.page, d = dispatcher(f);
  const tab = f.entry.tab, read = await d.call({ name: 'browser_read', arguments: { tab } });
  assert.equal(d.delivered(read), true);
  const ref = /button "Observed button" \[ref=(\w+)\]/.exec(read.text)?.[1]; assert.ok(ref, read.text);
  await page.evaluate(() => { setTimeout(() => { while (true) {} }, 0); }); await pause(50);
  const start = Date.now(), result = await d.call({ name: 'browser_act', arguments: { tab, steps: [{ do: 'click', ref }, { do: 'click', ref }] } });
  const elapsed = Date.now() - start;
  assert.equal(result.isError, true, result.text); assert.match(result.text, /Script seems stuck/);
  assert.ok(elapsed >= 2900 && elapsed < 11000, String(elapsed));
  const recovered = await d.call({ name: 'browser_act', arguments: { tab, steps: [{ do: 'navigate', url: page.url().replace('/start', '/landed') }] } });
  assert.equal(recovered.isError, false, recovered.text); assert.equal(await page.evaluate(() => window.sent ?? 0), 0);
  t.diagnostic('busy-loop target inspection error: ' + elapsed + ' ms; no click or replay');
});

for (const operation of ['keep', 'handoff', 'close']) test('FD3 real ' + operation + ' remains available on a stuck renderer', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content), page = f.entry.page, original = page.url();
  await page.evaluate(() => { setTimeout(() => { while (true) {} }, 0); }); await pause(50);
  f.entry.state.stuck = true;
  const result = await f.registry[operation](f.entry.tab);
  if (operation === 'close') { assert.equal(result.closed, true); assert.equal(page.isClosed(), true); }
  else { assert.equal(result.kept, true); assert.equal(page.url(), original); assert.equal(await page.evaluate(() => 6 * 7), 42); }
});

test('FD3 real a busy initial navigation returns its retained tab handle for recovery', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content, { '/busy': '<script>while(true){}</script>' }), d = dispatcher(f);
  const result = await d.call({ name: 'browser_open', arguments: { url: f.entry.page.url().replace('/start', '/busy') } });
  assert.equal(result.isError, true); assert.match(result.text, /^t[\w-]+: Script seems stuck; tab retained/);
  const handle = result.text.split(':')[0], retained = f.registry.tab(handle);
  const recovery = await d.call({ name: 'browser_act', arguments: { tab: handle,
    steps: [{ do: 'navigate', url: f.entry.page.url().replace('/start', '/landed') }] } });
  assert.equal(recovery.isError, false, recovery.text); assert.equal(f.registry.tab(handle), retained);
  t.diagnostic('busy initial navigation retained ' + handle);
});
