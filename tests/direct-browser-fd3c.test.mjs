import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { recoverPage, probePage, ensurePageResponsive } from '../plugins/sleight/lib/direct-browser/page-health.mjs';
import { inspectElement } from '../plugins/sleight/lib/direct-browser/rules.mjs';
import { inspectTarget } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { classify, fixture, rules } from './direct-browser-rules-fixture.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';

function recovery({ hops = [], disable = async () => {}, fail = false } = {}) {
  const calls = [], cdp = new EventEmitter();
  cdp.send = async (method, params) => {
    calls.push([method, params]);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
    if (method === 'Fetch.disable') return disable();
    return {};
  };
  let current = 'https://start.invalid/page';
  const tab = { state: { stuck: true }, cdp, page: { url: () => current, goto: async url => {
    for (const [index, destination] of [url, ...hops].entries()) {
      cdp.emit('Fetch.requestPaused', { frameId: 'main', requestId: String(index), request: { url: destination } });
      await new Promise(resolve => setImmediate(resolve));
      assert.ok(calls.some(([method, params]) => method === 'Fetch.continueRequest' && params.requestId === String(index)), 'hop must pass interception: ' + destination);
      current = destination;
    }
    if (fail) throw Error('navigation failed');
  } } };
  return { tab, calls };
}
test('FD3C user-named recovery still intercepts its initial URL and every redirect', async () => {
  const f = recovery({ hops: ['https://start.invalid/landed'] });
  await recoverPage(f.tab, 'https://named.invalid/start', { allowCrossOrigin: true });
  assert.ok(f.calls.some(([method]) => method === 'Fetch.enable'));
  assert.equal(f.tab.state.stuck, false);
});
test('FD3C named recovery redirects obey site, origin and scheme rules', async () => {
  for (const hop of ['https://other.invalid/', 'https://start.invalid/blocked', 'mailto:fixture@example.invalid', 'custom:fixture', 'data:text/plain,x']) {
    const f = recovery({ hops: [hop] });
    await assert.rejects(recoverPage(f.tab, 'https://named.invalid/start', { allowCrossOrigin: true,
      siteCheck: url => url.endsWith('/blocked') ? 'Blocked by user' : undefined }));
    assert.ok(f.calls.some(([method, params]) => method === 'Fetch.failRequest' && params.requestId === '1'), hop);
    assert.equal(f.tab.state.stuck, true);
  }
});
test('FD3C Fetch cleanup rejection or timeout never masks success or the original navigation error', { timeout: 10000 }, async () => {
  for (const disable of [async () => { throw Error('disable failed'); }, () => new Promise(() => {})]) for (const fail of [false, true]) {
    const f = recovery({ disable, fail }), start = Date.now();
    const result = recoverPage(f.tab, 'https://start.invalid/recover');
    if (fail) await assert.rejects(result, /navigation failed/); else await result;
    assert.ok(Date.now() - start < 1500, 'cleanup gets a short independent deadline');
    assert.equal(f.tab.state.recoveryFetchDisablePending, true);
    assert.equal(f.tab.state.stuck, fail);
    assert.equal(f.tab.cdp.listenerCount('Fetch.requestPaused'), 1, 'guard stays while Fetch cleanup is pending');
    f.tab.cdp.emit('close');
    assert.equal(f.tab.cdp.listenerCount('Fetch.requestPaused'), 0);
  }
});
test('FD3C a session lost during navigation cannot make cleanup mask the navigation error', async () => {
  const f = recovery();
  f.tab.page.goto = async () => { f.tab.cdp = null; throw Error('navigation session lost'); };
  await assert.rejects(recoverPage(f.tab, 'https://start.invalid/recover'), /navigation session lost/);
  assert.equal(f.tab.state.stuck, true);
});
test('FD3C detached child frames do not prevent a healthy main frame from clearing a stuck mark', async () => {
  for (const before of [false, true]) {
    let detached = before;
    const main = { evaluate: async () => 0, isDetached: () => false };
    const child = { isDetached: () => detached, evaluate: async () => { detached = true; throw Error('Frame was detached'); } };
    const tab = { state: { stuck: true, stuckOrigin: 'https://start.invalid' }, page: { evaluate: main.evaluate, frames: () => [main, child] } };
    assert.equal(await probePage(tab, 10), true);
    await ensurePageResponsive(tab);
    assert.equal(tab.state.stuck, false);
  }
  const attached = { evaluate: async () => { throw Error('context destroyed'); }, isDetached: () => false };
  assert.equal(await probePage({ state: {}, page: { frames: () => [attached] } }, 10), false);
});
test('FD3C unrelated controls in native forms remain usable; only submitters and implicit Enter refuse', () => {
  for (const inspector of [inspectElement, inspectTarget]) for (const tag of ['checkbox', 'radio', 'range', 'textarea', 'a', 'div', 'button', 'text', 'submit', 'image']) {
    const element = classify(({ Element, HTMLButtonElement, HTMLInputElement }) => {
      const form = new Element('form', { action: 'mailto:fixture@example.invalid' });
      new HTMLButtonElement('button', {}, 'Open', form);
      return ['text', 'checkbox', 'radio', 'range', 'submit', 'image'].includes(tag) ? new HTMLInputElement('input', { type: tag }, '', form)
        : tag === 'button' ? new HTMLButtonElement('button', { type: 'button' }, 'Other', form)
          : new Element(tag, tag === 'a' ? { href: '/safe' } : {}, 'Other', form);
    }, inspector);
    assert.equal(element.appLink, ['submit', 'image'].includes(tag), inspector.name + ':' + tag);
    const f = fixture(), verdict = rules.check(f.ctx, 'press', f.target({ element, key: 'Enter' }));
    assert.equal(/native app/.test(verdict.message ?? ''), ['text', 'checkbox', 'radio', 'range', 'submit', 'image'].includes(tag), inspector.name + ':' + tag);
  }
});
test('FD3C native navigation and detach notices describe only events that happened', async () => {
  for (const detached of [false, true]) {
    const entry = { state: { nativeNavigationNo: 1, ...(detached ? { nativeDetachNo: 1 } : {}) }, page: {} };
    const d = createToolDispatcher({ pages: { enqueue: async (_, run) => run(entry) }, snapshot: async () => ({ text: 'ready', number: 1 }),
      runSteps: async () => {}, fillFields: async () => {} });
    const result = await d.call({ name: 'browser_read', arguments: { tab: 't1' } });
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, detached ? /debugger detach attempted/i : /native navigation attempted/i);
    if (!detached) assert.doesNotMatch(result.text, /detach attempted/);
  }
});
