import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { recoverPage, probePage, ensurePageResponsive } from '../plugins/sleight/lib/direct-browser/page-health.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';

function recovery(hops = [], disable = async () => {}) {
  const calls = [], cdp = new EventEmitter();
  cdp.send = async (method, params) => {
    calls.push([method, params]);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
    if (method === 'Fetch.disable') return disable();
    return {};
  };
  let current = 'https://start.invalid/page';
  const tab = { state: { stuck: true }, cdp, page: { url: () => current, goto: async url => {
    for (const [index, destination] of [url.split('#')[0], ...hops].entries()) {
      cdp.emit('Fetch.requestPaused', { frameId: 'main', requestId: String(index), request: { url: destination } });
      await new Promise(resolve => setImmediate(resolve));
      if (!calls.some(([method, params]) => method === 'Fetch.continueRequest' && params.requestId === String(index))) throw Error('blocked hop');
      current = destination;
    }
  } } };
  return { tab, calls, cdp };
}
test('FD3D named recovery ignores fragments and allows paths on the named origin and its web variants', async () => {
  for (const [named, hops] of [
    ['https://named.invalid/start#section', []],
    ['https://named.invalid/start', ['https://named.invalid/landed#end']],
    ['http://example.co.uk/start', ['https://www.example.co.uk/landed']],
    ['https://www.example.co.uk/start', ['https://example.co.uk/landed']],
  ]) {
    const f = recovery(hops);
    await recoverPage(f.tab, named, { allowCrossOrigin: true });
    assert.equal(f.tab.state.stuck, false, named);
  }
});
test('FD3D named recovery still refuses unrelated hosts, ports, credentials, schemes, downgrades and blocked sites', async () => {
  for (const hop of ['https://other.invalid/', 'https://named.invalid.evil.invalid/', 'https://sub.named.invalid/',
    'https://named.invalid:8443/', 'http://named.invalid/', 'https://u:p@named.invalid/', 'mailto:fixture@example.invalid',
    'https://named.invalid/blocked']) {
    const f = recovery([hop]);
    await assert.rejects(recoverPage(f.tab, 'https://named.invalid/start#section', { allowCrossOrigin: true,
      siteCheck: url => url.endsWith('/blocked') ? 'Blocked by user' : undefined }));
    assert.equal(f.tab.state.stuck, true, hop);
    assert.ok(f.calls.some(([method, params]) => method === 'Fetch.failRequest' && params.requestId === '1'), hop);
  }
});
test('FD3D dispatcher accepts only the exact user-named recovery URL apart from fragments', async () => {
  for (const destination of ['https://named.invalid/start#other', 'https://named.invalid/other', 'https://named.invalid/start?q=1']) {
    const f = recovery(), ctx = { session: 's', turn: 't', userMessage: { source: 'user', session: 's', turn: 't', id: 'm',
      text: 'Go to https://named.invalid/start#section' } };
    const d = createToolDispatcher({ pages: { enqueue: async (_, run) => run(f.tab) }, ctx,
      snapshot: async () => ({ text: 'ready', number: 1 }), runSteps: () => assert.fail('no input'), fillFields: () => assert.fail('no fill') });
    const result = await d.call({ name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'navigate', url: destination }] } });
    if (destination.endsWith('#other')) assert.match(result.text, /Recovery navigation completed|navigated in the same tab/);
    else { assert.equal(result.isError, true); assert.match(result.text, /origin unless the user message named/); }
    assert.equal(f.calls.some(([method]) => method === 'Runtime.terminateExecution'), destination.endsWith('#other'));
  }
});
test('FD3D timed-out Fetch cleanup retains the guard and retries on a paused request until success or session close', { timeout: 5000 }, async () => {
  let disables = 0, succeed = false;
  const f = recovery([], () => { disables++; return succeed ? Promise.resolve() : new Promise(() => {}); });
  await recoverPage(f.tab, 'https://start.invalid/recover');
  assert.equal(f.tab.state.recoveryFetchDisablePending, true);
  f.cdp.emit('Fetch.requestPaused', { frameId: 'main', requestId: 'blocked', request: { url: 'https://other.invalid/' } });
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.ok(f.calls.some(([method, params]) => method === 'Fetch.failRequest' && params.requestId === 'blocked'));
  assert.equal(disables, 2);
  succeed = true;
  f.cdp.emit('Fetch.requestPaused', { frameId: 'main', requestId: 'safe', request: { url: 'https://start.invalid/next' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disables, 3);
  assert.equal(f.tab.state.recoveryFetchDisablePending, false);
  assert.equal(f.cdp.listenerCount('Fetch.requestPaused'), 0);
  assert.equal(f.cdp.listenerCount('close'), 0);
  const closed = recovery([], () => Promise.reject(Error('still live')));
  await recoverPage(closed.tab, 'https://start.invalid/recover');
  assert.equal(closed.cdp.listenerCount('Fetch.requestPaused'), 1);
  closed.tab.cdp = null; // The registry clears a detached handle before our close listener runs.
  closed.cdp.emit('close');
  assert.equal(closed.cdp.listenerCount('Fetch.requestPaused'), 0);
  assert.equal(closed.tab.state.recoveryFetchDisablePending, false);
});
test('FD3D a live cleanup rejection cannot remove its navigation guard', async () => {
  const f = recovery([], async () => { throw Error('session still live'); });
  await recoverPage(f.tab, 'https://start.invalid/recover');
  f.cdp.emit('Fetch.requestPaused', { frameId: 'main', requestId: 'native', request: { url: 'custom:fixture' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.cdp.listenerCount('Fetch.requestPaused'), 1);
  assert.equal(f.tab.state.recoveryFetchDisablePending, true);
  assert.ok(f.calls.some(([method, params]) => method === 'Fetch.failRequest' && params.requestId === 'native'));
  f.tab.state.stuck = true;
  await assert.rejects(recoverPage(f.tab, 'https://named.invalid/new', { allowCrossOrigin: true }), /cleanup pending/);
  assert.equal(f.calls.filter(([method]) => method === 'Runtime.terminateExecution').length, 1, 'a new recovery cannot replace the pending guard');
  f.cdp.emit('close');
});
test('FD3D closed pages and pages closing during a probe never clear a stuck mark', async () => {
  for (const when of ['before', 'during', 'timeout']) {
    let closed = when === 'before', reads = 0;
    const frame = { isDetached: () => closed, evaluate: async () => { reads++; closed = true;
      if (when === 'timeout') return new Promise(() => {});
      throw Error('page closed'); } };
    const tab = { state: { stuck: true }, page: { isClosed: () => closed, evaluate: frame.evaluate, frames: () => [frame] } };
    assert.equal(await probePage(tab, 10), false);
    await assert.rejects(ensurePageResponsive(tab), /Script seems stuck/);
    assert.equal(tab.state.stuck, true);
    if (when === 'before') assert.equal(reads, 0);
  }
});
