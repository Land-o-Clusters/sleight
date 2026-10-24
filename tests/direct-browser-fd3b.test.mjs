import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, rules, fixture } from './direct-browser-rules-fixture.mjs';
import { inspectTarget, createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { guardPageTask, recoverPage } from '../plugins/sleight/lib/direct-browser/page-health.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { waitForPage, waitForThinPage } from '../plugins/sleight/lib/direct-browser/waits.mjs';

test('FD3B both inspectors classify native form actions and submitter overrides, including image inputs and implicit Enter', () => {
  for (const inspector of [rules.inspectElement, inspectTarget]) for (const tag of ['button', 'input', 'field']) {
    for (const override of [false, true]) {
      const element = classify(({ Element, HTMLButtonElement, HTMLInputElement }) => {
        const form = new Element('form', { action: override ? '/web' : 'mailto:fixture@example.invalid' });
        const attrs = { type: tag === 'input' ? 'image' : 'submit', ...(override ? { formaction: 'zoommtg://fixture.invalid' } : {}) };
        const button = tag === 'input' ? new HTMLInputElement('input', attrs, '', form) : new HTMLButtonElement('button', attrs, 'Open', form);
        return tag === 'field' ? new HTMLInputElement('input', { type: 'text' }, '', form) : button;
      }, inspector);
      assert.equal(element.appLink, tag !== 'field', inspector.name + ':' + tag + ':' + override);
      assert.equal(element.nativeFormEnter, true, inspector.name + ':' + tag + ':' + override);
      const f = fixture();
      assert.equal(rules.check(f.ctx, 'press', f.target({ element, key: 'Enter' })).verdict, 'refuse');
    }
  }
  assert.equal(classify(({ Element, HTMLButtonElement }) => {
    const form = new Element('form', { action: 'mailto:fixture@example.invalid' });
    return new HTMLButtonElement('button', { formaction: '/safe' }, 'Open', form);
  }).appLink, false, 'web override takes precedence');
});

test('FD3B snapshot acquisition errors probe a stuck renderer and retain recovery advice', async () => {
  const tab = { state: {}, page: { url: () => 'https://fixture.invalid/', evaluate: () => new Promise(() => {}) } };
  await assert.rejects(guardPageTask(tab, () => { throw Error('Snapshot acquisition is still pending'); }, { probeMs: 5 }), /Script seems stuck.*navigate/);
  assert.equal(tab.state.stuck, true);
});

test('FD3B a marked page is re-probed and clears its mark when it answers, including failed evaluations', async () => {
  const tab = { state: { stuck: true }, page: { evaluate: async () => 0 } };
  assert.equal(await guardPageTask(tab, async () => 'read recovered'), 'read recovered');
  assert.equal(tab.state.stuck, false);
  tab.state.stuck = true;
  tab.page.evaluate = async () => { throw Error('context destroyed'); };
  await assert.rejects(guardPageTask(tab, async () => assert.fail('cannot prove health')), /Script seems stuck/);
  assert.equal(tab.state.stuck, true);
});

function stuck() {
  const calls = [], tab = { state: { stuck: true }, page: { url: () => 'https://fixture.invalid/start',
    goto: async url => { calls.push(['goto', url]); throw Error('failed'); } },
    cdp: { send: async method => { calls.push([method]); } } };
  return { tab, calls };
}
function dispatcher(tab, ctx) {
  return createToolDispatcher({ pages: { enqueue: async (_, run) => run(tab) }, ctx,
    snapshot: async () => ({ text: '- text: "ready"', number: 1 }), runSteps: async () => assert.fail('unused'), fillFields: async () => assert.fail('unused') });
}
const navigate = url => ({ name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'navigate', url }] } });
test('FD3B recovery defaults to the stuck origin and guards uncertain submissions on the legacy path', async () => {
  const f = stuck(), d = dispatcher(f.tab);
  assert.match((await d.call(navigate('https://other.invalid/'))).text, /origin.*user.*URL/i);
  assert.deepEqual(f.calls, []);
  f.tab.state.submitUnconfirmed = { startedAt: 1 };
  const held = await d.call(navigate('https://fixture.invalid/recover'));
  assert.match(held.text, /explicit user request/); assert.deepEqual(f.calls, []);
});
test('FD3B failed recovery discloses terminated scripts without claiming a completed navigation', async () => {
  const f = stuck(), result = await dispatcher(f.tab).call(navigate('https://fixture.invalid/recover'));
  assert.equal(result.isError, true);
  assert.match(result.text, /scripts terminated/);
  assert.doesNotMatch(result.text, /left https:/);
});
test('FD3B recovery rejects another origin at the recovery boundary unless explicitly allowed', async () => {
  const f = stuck();
  await assert.rejects(recoverPage(f.tab, 'https://other.invalid/recover'), /origin/);
  assert.deepEqual(f.calls, []);
});
test('FD3B a trusted user-named URL permits a recovery destination on another origin', async () => {
  const f = stuck(), ctx = { session: 's', turn: 't', userMessage: { source: 'user', session: 's', turn: 't', id: 'm', text: 'Go to https://other.invalid/recover' } };
  await dispatcher(f.tab, ctx).call(navigate('https://other.invalid/recover'));
  assert.ok(f.calls.some(row => row[0] === 'goto'));
});
test('FD3B recovery discloses lost state even when its post-navigation observation fails', async () => {
  const f = stuck(); f.tab.page.goto = async () => {};
  const result = await dispatcher(f.tab).call(navigate('https://fixture.invalid/recover'));
  assert.match(result.text, /scripts terminated/);
  assert.match(result.text, /left https:\/\/fixture.invalid; unsaved page state discarded/);
  assert.match(result.text, /observation unavailable/);
});

test('FD3B static thin documents finish after 300 ms of ready quiet without a text mutation', async t => {
  let time = 0;
  const utility = { world: 'utility', evaluateExpression: async () => ({ revision: 0, length: 5, ready: true }) };
  const frame = { _connection: { toImpl: () => ({ utilityContext: async () => utility }) } };
  const page = { frames: () => [frame], on() {} };
  await waitForThinPage(page, { now: () => time, sleep: async ms => { time += ms; } });
  t.diagnostic('static thin document observed wait: ' + time + ' ms');
  assert.equal(time, 300);
});
test('FD3B matching text waits label page text as untrusted while URL waits remain metadata', async () => {
  const result = await waitForPage({}, { until: 'ready' }, { snapshot: async () => ({ text: '- text: "ready"' }) });
  assert.match(result, /\(page text, untrusted\)/);
  assert.doesNotMatch(await waitForPage({ url: () => '/ready' }, { url: 'ready' }), /page text/);
});
