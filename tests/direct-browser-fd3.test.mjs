import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createV3Context, createV3TurnBinding } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { validateToolCall, createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { assertPageResponsive, guardPageTask, recoverPage, stuckPageMessage } from '../plugins/sleight/lib/direct-browser/page-health.mjs';
import { waitForPage } from '../plugins/sleight/lib/direct-browser/waits.mjs';
import { rules, classify, fixture as ruleFixture } from './direct-browser-rules-fixture.mjs';

const call = step => ({ name: 'browser_act', arguments: { tab: 't1', steps: [step] } });
test('FD3 wait and recovery schema reject ambiguity, native URLs, credentials and extra input', () => {
  for (const step of [{ do: 'wait', until: 'Ready' }, { do: 'wait', gone: 'Loading' }, { do: 'wait', url: '/ready', ms: 800 },
    { do: 'navigate', url: 'https://fixture.invalid/recover' }]) assert.deepEqual(validateToolCall(call(step)), call(step));
  for (const step of [{ do: 'wait', until: '' }, { do: 'wait', gone: ' ' }, { do: 'wait', until: 'x', gone: 'y' },
    { do: 'wait', until: 'x', ref: 'e1' }, { do: 'click', ref: 'e1', gone: 'x' }, { do: 'reload', url: 'https://fixture.invalid/' },
    { do: 'navigate', ref: 'e1', url: 'https://fixture.invalid/' }, { do: 'navigate', url: 'mailto:fixture@example.invalid' },
    { do: 'navigate', url: 'https://u:p@fixture.invalid/' }]) assert.throws(() => validateToolCall(call(step)));
  const batch = call({ do: 'navigate', url: 'https://fixture.invalid/' }); batch.arguments.steps.push({ do: 'click', ref: 'e1' });
  assert.throws(() => validateToolCall(batch), /one HTTP/);
});

test('FD3 offline mailto debugger-detach repro: a native navigation detaches, guarded clicks and opening keys send nothing', () => {
  const f = ruleFixture(); let attached = true, sent = 0;
  // This models the reported failure. It is deliberately not a Chrome/Helium probe.
  const navigate = scheme => { sent++; if (['mailto:', 'zoommtg:'].includes(scheme)) attached = false; };
  navigate('mailto:'); assert.equal(attached, false); attached = true; sent = 0;
  for (const href of ['mailto:fixture@example.invalid', 'MAILTO:fixture@example.invalid', ' mail\nto:fixture@example.invalid',
    'zoommtg://fixture.invalid', 'tel:5551212', 'file:///tmp/fixture', 'custom-app:fixture']) {
    const element = classify(({ Element }) => new Element('a', { href }, 'Open app'));
    assert.equal(element.appLink, true, href);
    for (const kind of ['click', 'press']) {
      const verdict = rules.check(f.ctx, kind, f.target({ element, key: 'Enter' }));
      if (verdict.verdict === 'allow') navigate(new URL(href).protocol);
      assert.equal(verdict.verdict, 'refuse'); assert.match(verdict.message, /native app.*Tell the user/);
    }
  }
  assert.equal(sent, 0); assert.equal(attached, true);
  for (const href of ['https://fixture.invalid/', '/next', 'javascript:void(0)', 'blob:https://fixture.invalid/id', 'data:text/plain,x', 'about:blank'])
    assert.equal(classify(({ Element }) => new Element('a', { href }, 'Open')).appLink, false, href);
});

test('FD3 waits for protected text and text disappearance at 100 ms intervals without exposing conditions in outcomes', async () => {
  for (const step of [{ do: 'wait', until: 'READY' }, { do: 'wait', gone: 'loading' }]) {
    let time = 0, reads = 0;
    const result = await waitForPage({}, step, { now: () => time, sleep: async ms => { assert.equal(ms, 100); time += ms; },
      snapshot: async (_page, options) => { assert.equal(options.maxChars, 40000); return { text: '- text: "' + (++reads < 4 ? 'Loading' : 'Ready') + '"' }; } });
    assert.equal(result, 'wait condition met after 300 ms (page text, untrusted)'); assert.equal(reads, 4);
    assert.doesNotMatch(result, /READY|loading/);
  }
});

test('FD3 gone never treats a truncated protected snapshot as proof of absence', async () => {
  let time = 0;
  const result = await waitForPage({}, { do: 'wait', gone: 'secret', ms: 250 }, { now: () => time, sleep: async ms => { time += ms; },
    snapshot: async () => ({ text: 'textbox: [redacted]\n# Continue with ref=more12_40' }) });
  assert.equal(result, 'wait condition not met after 250 ms (cap); page below');
  assert.match(await waitForPage({}, { gone: 'secret', ms: 0 }, {
    snapshot: async () => ({ text: '- textbox "Password": "[redacted]"' }) }), /condition not met/);
});

test('FD3 text waits do not match headers, roles, refs, masked values or link destinations', async () => {
  for (const until of ['Snapshot', 'button', 'e77', '[redacted]', '/hidden-destination']) {
    const result = await waitForPage({}, { until, ms: 0 }, { snapshot: async () => ({ text:
      '# Snapshot 7 (untrusted page content)\n- button "Continue" [ref=e77]\n- textbox "Password": "[redacted]"\n  - /url: "/hidden-destination"' }) });
    assert.match(result, /condition not met/);
  }
});

test('FD3 URL waits poll only the URL and report a bounded miss honestly', async () => {
  let time = 0;
  const page = { url: () => 'https://fixture.invalid/' + (time < 200 ? 'loading' : 'ready') };
  const deps = { now: () => time, sleep: async ms => { time += ms; }, snapshot: () => assert.fail('URL wait does not read page text') };
  assert.equal(await waitForPage(page, { url: '/ready' }, deps), 'wait condition met after 200 ms');
  assert.equal(await waitForPage(page, { url: '/never', ms: 100 }, deps), 'wait condition not met after 100 ms (cap); page below');
});

function busyFixture() {
  let release, url = 'https://fixture.invalid/start';
  const page = new EventEmitter(), order = [], state = {};
  const work = new Promise(resolve => { release = resolve; });
  page.evaluate = () => new Promise(() => {});
  page.goto = async destination => { order.push(['goto', destination]); url = destination; };
  page.url = () => url;
  const tab = { tab: 't-retained', page, state, cdp: { send: async method => { order.push([method]); release('unwound'); } } };
  return { tab, order, work, release };
}
test('FD3 a failed renderer probe marks the tab, fails later work immediately and terminates before same-tab navigation', async () => {
  const f = busyFixture();
  await assert.rejects(guardPageTask(f.tab, () => f.work, { afterMs: 5, probeMs: 5 }), { message: stuckPageMessage });
  assert.equal(f.tab.state.stuck, true);
  assert.throws(() => assertPageResponsive(f.tab), { message: stuckPageMessage });
  await assert.rejects(guardPageTask(f.tab, () => assert.fail('stuck tab cannot send input')));
  await recoverPage(f.tab, 'https://fixture.invalid/recover');
  assert.deepEqual(f.order, [['Runtime.terminateExecution'], ['goto', 'https://fixture.invalid/recover']]);
  assert.equal(f.tab.tab, 't-retained'); assert.equal(f.tab.state.stuck, false);
});

test('FD3 a responsive slow task is not labelled stuck; a later loop still triggers the watchdog', async () => {
  const page = { evaluate: async () => 0 }, tab = { page, state: {} };
  assert.equal(await guardPageTask(tab, () => new Promise(resolve => setTimeout(() => resolve('ready'), 25)), { afterMs: 5, probeMs: 5 }), 'ready');
  assert.equal(tab.state.stuck, undefined);
  setTimeout(() => { page.evaluate = () => new Promise(() => {}); }, 10);
  await assert.rejects(guardPageTask(tab, () => new Promise(() => {}), { afterMs: 5, probeMs: 5 }), /Script seems stuck/);
});

test('FD3 failed or blocked recovery keeps the tab marked and never opens another target', async () => {
  const f = busyFixture(); f.tab.state.stuck = true;
  await assert.rejects(recoverPage(f.tab, 'https://blocked.invalid/', { siteCheck: () => 'Blocked by user' }), /Blocked by user/);
  assert.deepEqual(f.order, []);
  await assert.rejects(recoverPage(f.tab, 'mailto:fixture@example.invalid'), /HTTP/);
  f.tab.page.goto = async () => { throw Error('navigation failed'); };
  await assert.rejects(recoverPage(f.tab, 'https://fixture.invalid/recover'), /navigation failed/);
  assert.equal(f.tab.state.stuck, true); assert.equal(f.tab.tab, 't-retained');
  const d = createToolDispatcher({ pages: { enqueue: async (_, run) => run(f.tab) }, snapshot: () => assert.fail('no read'),
    runSteps: () => assert.fail('no input'), fillFields: () => assert.fail('no fill') });
  const failed = await d.call(call({ do: 'navigate', url: 'https://fixture.invalid/recover' }));
  assert.equal(failed.isError, true); assert.match(failed.text, /Recovery did not finish; tab retained/);
  f.tab.state.stuck = false;
  const healthy = await d.call(call({ do: 'navigate', url: 'https://fixture.invalid/' }));
  assert.equal(healthy.isError, true); assert.match(healthy.text, /only for a stuck tab.*Nothing was sent/);
});

test('FD3 a stuck tab refuses read, fill and input while list, keep, handoff and close remain routed', async () => {
  const f = busyFixture(); f.tab.state.stuck = true;
  const pages = { tab: () => f.tab, enqueue: async (_, run) => run(f.tab), list: async () => [{ tab: f.tab.tab, url: f.tab.page.url() }] };
  for (const op of ['keep', 'handoff', 'close']) pages[op] = async id => ({ tab: id, [op]: true });
  const d = createToolDispatcher({ pages, snapshot: () => assert.fail('no read'), runSteps: () => assert.fail('no input'), fillFields: () => assert.fail('no fill') });
  for (const request of [{ name: 'browser_read', arguments: { tab: 't1' } }, call({ do: 'click', ref: 'e1' }),
    { name: 'browser_fill', arguments: { tab: 't1', fields: [{ ref: 'e1', value: 'x' }] } }]) {
    const result = await d.call(request); assert.equal(result.isError, true); assert.equal(result.text, stuckPageMessage);
  }
  for (const op of ['list', 'keep', 'handoff', 'close']) {
    const result = await d.call({ name: 'browser_tabs', arguments: { do: op, ...(op === 'list' ? {} : { tab: 't1' }) } });
    assert.equal(result.isError, false); assert.match(result.text, /t-retained|t1/);
  }
});

test('FD3 recovery preserves the trusted submit fence and refuses a blocked destination before termination', async () => {
  const f = busyFixture(); f.tab.state.stuck = true; f.tab.state.submitUnconfirmed = { startedAt: 1 };
  const binding = createV3TurnBinding({ source: 'user', session: 's', turn: 't', id: 'r', text: 'Read this page' }, () => true);
  const ctx = createV3Context({ binding, browser: 'fixture' });
  try {
    const d = createToolDispatcher({ pages: { enqueue: async (_, run) => run(f.tab) }, ctx,
      snapshot: () => assert.fail('no read'), runSteps: () => assert.fail('no input'), fillFields: () => assert.fail('no fill') });
    const result = await d.call(call({ do: 'navigate', url: 'https://fixture.invalid/recover' }));
    assert.equal(result.isError, true); assert.match(result.text, /explicit user request/);
    assert.deepEqual(f.order, []); assert.equal(f.tab.state.stuck, true);
  } finally { ctx.dispose(); }
});
