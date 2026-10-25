import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { backgroundClick, changedMidClick } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { createV3Context, createV3TurnBinding } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { sealDigest } from '../plugins/sleight/lib/direct-browser/seal-digest.mjs';
import { mc1Fixture } from './fixtures/direct-browser-mc1-fixture.mjs';

const terms = { item: 'Fixture item', amount: '18.00', payee: 'Fixture shop', currency: 'USD' };

// Only the DOM/Playwright transport is simulated. The runner, ctx.check (prepare, seal verification,
// rules and payment policy), backgroundClick and signed capture hook are the production implementations.
function fixture(t, { classification = () => ({}), text = 'Select overnight delivery', veto = 'event' } = {}) {
  const f = mc1Fixture(), document = { dispose: async () => {} }, received = [], inspections = [];
  let prepares = 0, clicks = 0, time = 0, number = 1;
  f.run(`
    class HTMLTextAreaElement extends Element { get form() { return null; } get type() { return 'textarea'; } }
    globalThis.HTMLTextAreaElement = HTMLTextAreaElement;
    globalThis.getComputedStyle = window.getComputedStyle;
  `);
  const evaluate = f.locator.evaluate;
  f.locator.dispose = async () => {};
  const read = (fn, arg) => {
    if (fn.name === 'samePageDocument') return arg === document;
    if (fn.name === 'readPaymentPage') { prepares++; return { origin: 'https://fixture.invalid', page: terms, name: 'Delivery' }; }
    if (fn.name === 'forwardInfo') return { label: false, areas: [] };
    if (fn.name === 'inspectElement') {
      if (veto === 'expect' && prepares === 2) {
        f.radio.attrs.value = 'rendering'; f.mutate();
        setTimeout(() => { f.radio.attrs.value = 'overnight'; f.mutate(); }, 10);
      }
      const element = f.run(`(${fn})(fixture.radio, undefined, (node, key) => {
        const value = node?.[key]; return typeof value === 'function' ? value.bind(node) : value;
      }, (${sealDigest}))`);
      // Model a later trusted risk read without changing the node or its seal. Pre-click inspectTarget
      // stays ordinary, as in M-1. Counts include prepareTarget, followed by one prepare per ctx.check.
      const result = { ...element, ...classification(prepares) };
      inspections.push(result); return result;
    }
    // G11F: the cookie-wall read finds no consent container on this fixture.
    if (fn.name === 'inspectConsent') return undefined;
    if (fn.name === 'inspectTarget') {
      const info = f.run(`(${fn})(fixture.radio)`);
      assert.equal(info.submit, false); assert.equal(info.payment, false);
      return info;
    }
    return evaluate(fn, arg);
  };
  f.locator._connection = { toImpl: handle => {
    assert.equal(handle, f.locator);
    return { _frame: { utilityContext: async () => ({ world: 'utility',
      evaluateExpression: async (source, options, args) => {
        assert.equal(options.isFunction, true);
        const match = /^\(\[el, arg\]\) => (?:\{ return )?\(([\s\S]*?)\)\(el, arg, \(function nativeReader\(/.exec(source);
        assert.ok(match, 'only the trusted reader template is supported');
        return read(f.run('(' + match[1] + ')'), args[1]);
      },
      evaluateExpressionHandle: async source => { assert.match(source, /function ownDocument/); return document; },
    }) } };
  } };
  const events = new EventEmitter();
  f.page.on = events.on.bind(events); f.page.off = events.off.bind(events);
  f.page.url = () => 'https://fixture.invalid/checkout'; f.page.mainFrame = () => f.page;
  f.page.getByRef = ref => { assert.equal(ref, 'e44'); return f.locator; };
  f.locator.click = async () => {
    clicks++;
    if (veto === 'event' && clicks === 1) { f.radio.attrs.value = 'rendering'; f.mutate(); }
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
      if (!f.send(type, f.radio).prevented) received.push(type);
    if (veto === 'event' && clicks === 1) setTimeout(() => { f.radio.attrs.value = 'overnight'; f.mutate(); }, 10);
  };
  const binding = createV3TurnBinding({ source: 'user', session: 'fixture', turn: 'turn', id: 'request', text }, () => true);
  const ctx = createV3Context({ binding, browser: 'bfixture', confirmPayments: 'requested' });
  t.after(() => ctx.dispose());
  const tab = { ...f.entry, state: { snapshotNo: 1, submitUnconfirmed: false } };
  const run = createActionRunner({ backgroundClick, check: () => assert.fail('trusted context must check'),
    now: () => time, sleep: async ms => { time += ms; },
    snapshot: async () => ({ text: 'No visible changes.', number: ++number }) });
  return { run: () => run(tab, [{ do: 'click', ref: 'e44' }], ctx), received, inspections,
    counts: () => ({ prepares, checks: prepares - 1, clicks }) };
}

test('MC1 real action callback re-enters ctx.check and prepare after a signed veto', async t => {
  const f = fixture(t), result = await f.run();
  assert.equal(result.stoppedAt, null, result.lines.join('\n'));
  assert.deepEqual(f.counts(), { prepares: 3, checks: 2, clicks: 2 });
  assert.equal(f.received.length, 5, 'only the second click reached the page');
  assert.match(result.lines[0], /waited for the page to settle and retried the click once/);
});

test('MC1 real action callback retries a veto from trusted seal verification before any click', async t => {
  const f = fixture(t, { veto: 'expect' }), result = await f.run();
  assert.equal(result.stoppedAt, null, result.lines.join('\n'));
  assert.deepEqual(f.counts(), { prepares: 3, checks: 2, clicks: 1 });
  assert.equal(f.received.length, 5);
  assert.match(result.lines[0], /retried the click once/);
});

test('MC1 real action callback stops when the second ctx.check asks about payment', async t => {
  const f = fixture(t, { classification: read => read >= 3 ? { submit: true, payment: true, kind: 'button' } : {} });
  const result = await f.run();
  assert.equal(result.stoppedAt, 1);
  assert.match(result.lines[0], /confirmation required through the trusted consent UI/);
  assert.equal(result.confirmation.step, 1);
  assert.equal(result.confirmation.terms.amount, terms.amount);
  assert.deepEqual(f.counts(), { prepares: 3, checks: 2, clicks: 1 });
  assert.deepEqual(f.received, [], 'the first click was vetoed and payment ask sent no second click');
});

for (const payment of [false, true]) test('MC1 trusted ' + (payment ? 'payment' : 'submit') + ' disables retry after an ordinary pre-click read', async t => {
  const f = fixture(t, { classification: () => ({ submit: true, payment, kind: 'button' }),
    text: 'Pay ' + JSON.stringify({ ...terms, method: 'Fixture card' }) });
  const result = await f.run();
  assert.equal(result.stoppedAt, 1);
  assert.ok(result.lines[0].includes(changedMidClick), result.lines[0]);
  assert.deepEqual(f.counts(), { prepares: 2, checks: 1, clicks: 1 });
  assert.deepEqual(f.received, []);
  assert.doesNotMatch(result.lines[0], /retried/);
  assert.equal(result.confirmation, undefined, 'the first gate allowed input before the signed veto');
});
