import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, skip } from './fixtures/cr4-real.mjs';
import { inspectElement } from '../plugins/sleight/lib/direct-browser/rules.mjs';
import { inspectTarget } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { trustedLocatorRead } from '../plugins/sleight/lib/direct-browser/trusted-dom.mjs';
import { recoverPage, ensurePageResponsive } from '../plugins/sleight/lib/direct-browser/page-health.mjs';
const content = '<h1>Fixture with enough visible text to avoid the thin document delay</h1>';
test('FD3C real native forms allow unrelated clicks and Enter on textareas and checkboxes', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content + '<form action="mailto:fixture@example.invalid"><input id="text"><textarea id="area"></textarea>' +
    '<input id="check" type="checkbox"><input id="radio" type="radio"><button id="ordinary" type="button">Other</button>' +
    '<a id="link" href="/landed">Web</a><div id="div">Other</div><button id="submit">Open <span id="nested">app</span></button></form>');
  for (const inspector of [inspectElement, inspectTarget]) for (const id of ['text', 'area', 'check', 'radio', 'ordinary', 'link', 'div', 'submit', 'nested']) {
    const value = await trustedLocatorRead(f.entry.page.locator('#' + id), inspector);
    assert.equal(value.appLink, ['submit', 'nested'].includes(id), inspector.name + ':' + id);
    assert.equal(value.nativeFormEnter, ['text', 'submit', 'nested'].includes(id), inspector.name + ':' + id);
  }
  const events = await f.entry.page.evaluate(() => {
    const result = {};
    for (const id of ['text', 'area', 'check', 'radio', 'ordinary', 'link', 'div', 'submit', 'nested']) {
      const el = document.getElementById(id);
      result[id] = el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    }
    return result;
  });
  assert.deepEqual(events, { text: false, area: true, check: true, radio: true, ordinary: true, link: true, div: true, submit: false, nested: false });
  const clicks = await f.entry.page.evaluate(() => {
    const seen = [];
    // No browser default is dispatched by Event; this observes the early guard and page listeners only.
    for (const id of ['text', 'area', 'check', 'radio', 'ordinary', 'link', 'div', 'submit', 'nested']) {
      const el = document.getElementById(id);
      el.addEventListener('click', event => { seen.push(id); event.preventDefault(); }, { once: true });
      try { el.dispatchEvent(new Event('click', { bubbles: true, cancelable: true })); }
      catch (error) { if (error.name !== 'NotAllowedError') throw error; }
    }
    return seen;
  });
  assert.deepEqual(clicks, ['text', 'area', 'check', 'radio', 'ordinary', 'link', 'div']);
});
test('FD3C real a child detached during probing lets a stuck mark self-clear', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content + '<iframe src="/child"></iframe>', { '/child': '<h1>Child</h1>' }), page = f.entry.page;
  const loaded = page.waitForEvent('framenavigated', frame => frame.url().includes('localhost'));
  await page.evaluate(() => { document.querySelector('iframe').src = location.origin.replace('127.0.0.1', 'localhost') + '/child'; });
  await loaded;
  const child = page.frames().find(frame => frame !== page.mainFrame()); assert.ok(child);
  const evaluate = child.evaluate.bind(child);
  child.evaluate = async (...args) => { await page.evaluate(() => document.querySelector('iframe').remove()); return evaluate(...args); };
  f.entry.state.stuck = true;
  await ensurePageResponsive(f.entry);
  assert.equal(child.isDetached(), true); assert.equal(f.entry.state.stuck, false);
});
test('FD3C real named cross-origin recovery checks redirects against site blocks and the stuck origin', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content), page = f.entry.page, origin = new URL(page.url()).origin;
  // Different loopback address gives a separate origin without leaving the fixture server.
  const named = origin.replace('127.0.0.1', 'localhost') + '/named';
  for (const blocked of [false, true]) {
    const landed = origin + '/landed' + (blocked ? '-blocked' : '');
    await page.route('**/named', route => route.fulfill({ status: 302, headers: { location: landed } }));
    f.entry.state.stuck = true; f.entry.state.stuckOrigin = origin;
    const operation = recoverPage(f.entry, named, { allowCrossOrigin: true, siteCheck: url => url.endsWith('-blocked') ? 'Blocked by user' : undefined });
    if (blocked) await assert.rejects(operation); else await operation;
    assert.equal(f.requests.some(row => row.url === '/landed-blocked'), false);
    if (!blocked) assert.equal(page.url(), landed);
    await page.unroute('**/named');
  }
});
test('FD3C real failed Fetch cleanup preserves navigation and retries on the next main-frame load', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content), entry = f.entry, cdp = entry.cdp, send = cdp.send.bind(cdp);
  let disables = 0;
  cdp.send = async (method, params) => { if (method === 'Fetch.disable' && ++disables === 1) throw Error('fixture disable failed'); return send(method, params); };
  entry.state.stuck = true;
  await recoverPage(entry, new URL('/landed', entry.page.url()).href);
  assert.equal(entry.state.stuck, false); assert.equal(entry.state.recoveryFetchDisablePending, true);
  await entry.page.reload({ waitUntil: 'domcontentloaded', timeout: 5000 });
  assert.ok(disables >= 2); assert.equal(entry.state.recoveryFetchDisablePending, false);
});
test('FD3C real failed auxiliary reattach clears dead handles and releases the same tab', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, content), entry = f.entry, target = entry.targetId, old = entry.cdp;
  const attach = f.context.newCDPSession.bind(f.context);
  f.context.newCDPSession = async () => { throw Error('fixture reattach failed'); };
  await old.detach(); await f.registry.idle();
  assert.equal(entry.cdp, null); assert.equal(entry.script, null);
  await assert.rejects(entry.checkAttachment(), /dead script and CDP handles cleared/);
  await f.registry.keep(entry.tab);
  assert.equal(entry.targetId, target); assert.equal(entry.released, true); assert.equal(entry.page.isClosed(), false);
  assert.equal(await entry.page.evaluate(() => {
    try { navigator.registerProtocolHandler('web+fixture', '/h?u=%s'); return 'restored'; } catch (error) { return error.name; }
  }), 'restored');
  f.context.newCDPSession = attach;
  t.diagnostic('headless auxiliary session only; installed-browser native protocol behavior remains unqualified');
});
