import test from 'node:test';
import assert from 'node:assert/strict';
import { rules, fixture, terms, classify } from './direct-browser-rules-fixture.mjs';

// A "checkout" link with a real href, no script and no listeners is navigation. Everything else with payment words keeps the payment rule.
// link() is what inspectElement reports (a candidate); released() adds the CDP evidence that no script listens on it.
const link = (attrs, text, wrap) => classify(({ Element }) => new Element('a', attrs, text, wrap?.(Element)));
const released = (element, listeners = false) => { rules.releaseNavigation(element, listeners); return element; };
const verdict = (element, kind = 'click') => { const f = fixture(); return rules.check(f.ctx, kind, f.target({ element, key: 'Enter' })).verdict; };
const navigates = element => { assert.equal(element.navigation, true); const r = released(element); assert.equal(r.payment, false); assert.equal(r.submit, false); return verdict(r) === 'allow' && verdict(r, 'press') === 'allow'; };
const asks = (element, label) => { released(element); assert.equal(element.payment, true, label); assert.equal(verdict(element), 'confirm', label); };

test('a Go to checkout / Checkout link with a real href and no handlers is navigation: allowed without consent', () => {
  for (const href of ['/shop/checkout/address', 'https://shop.invalid/checkout', '//shop.invalid/checkout', '?step=checkout', 'checkout/address'])
    for (const text of ['Go to checkout', 'Checkout', 'Proceed to Checkout'])
      assert.equal(navigates(link({ href }, text)), true, href + ' ' + text);
});

test('without the listener evidence the link still asks: unreleased, listeners found, enumeration failed', () => {
  const plain = link({ href: '/shop/checkout/address' }, 'Go to checkout');
  assert.equal(plain.payment, true); assert.equal(verdict(plain), 'confirm');
  for (const listeners of [true, undefined, null, 'no']) {
    const element = link({ href: '/shop/checkout/address' }, 'Go to checkout');
    rules.releaseNavigation(element, listeners); assert.equal(element.payment, true, String(listeners)); assert.equal(verdict(element), 'confirm', String(listeners));
  }
  // Release works only for a candidate.
  const button = classify(({ HTMLButtonElement, Element }) => new HTMLButtonElement('button', {}, 'Checkout', new Element('main')));
  assert.equal(rules.releaseNavigation(button, false), false); assert.equal(button.payment, true);
});

test('only checkout is exempt: buy, pay, purchase, place order, subscribe, upgrade, donate, charge and mixed words still ask', () => {
  for (const text of ['Buy now', 'Pay invoice', 'Purchase', 'Place order', 'Subscribe', 'Upgrade', 'Donate', 'Charge my card', 'Order now', 'Complete order',
    'Book now', 'Send money', 'Payment', 'Pay and checkout', 'Checkout and buy', 'Checkout to pay'])
    asks(link({ href: '/next' }, text), text);
});

test('following the link does not spend the request payment budget: the priced Place order after it still proceeds, once', () => {
  const nav = released(link({ href: '/shop/checkout/address' }, 'Go to checkout'));
  const place = classify(({ Element, HTMLButtonElement }) => new HTMLButtonElement('button', {}, 'Place order', new Element('main')));
  assert.equal(place.payment, true);
  const f = fixture(terms);
  assert.equal(rules.check(f.ctx, 'click', f.target({ element: nav })).verdict, 'allow');
  assert.equal(rules.check(f.ctx, 'click', f.target({ element: place })).verdict, 'allow', 'the payment the message priced');
  assert.equal(rules.check(f.ctx, 'click', f.target({ element: place })).verdict, 'confirm', 'one activation per request');
});

test('an unpriced Place order button still asks, as does a Checkout button outside any form', () => {
  const place = classify(({ Element, HTMLButtonElement }) => new HTMLButtonElement('button', {}, 'Place order', new Element('main')));
  const checkout = classify(({ Element }) => new Element('button', {}, 'Checkout', new Element('main')));
  const bare = classify(({ HTMLButtonElement }) => new HTMLButtonElement('button', {}, 'Checkout'));
  for (const element of [place, checkout, bare]) { assert.equal(element.payment, true); assert.equal(verdict(element), 'confirm'); }
});

test('non-app hrefs that are not a navigation stay payments: #, javascript: in every spelling, no href, data:', () => {
  const hrefs = ['#', '#checkout', 'javascript:void(0)', 'JavaScript:buy()', '  javascript:buy()', 'java\tscript:buy()', 'java\nscript:buy()',
    '\u0001javascript:buy()', 'data:text/html,x', ''];
  for (const href of hrefs) asks(link({ href }, 'Go to checkout'), JSON.stringify(href));
  asks(link({}, 'Go to checkout'), 'no href');
});

test('a link in a payment form stays a payment; one in a form without payment fields is navigation', () => {
  asks(link({ href: '/shop/checkout/order' }, 'Go to checkout', Element => {
    const form = new Element('form'); new Element('input', { autocomplete: 'cc-number' }, '', form); return form;
  }), 'card field');
  asks(link({ href: '/next' }, 'Checkout', Element => { const form = new Element('form'); new Element('button', {}, 'Pay now', form); return form; }), 'pay button');
  assert.equal(navigates(link({ href: '/shop/checkout/address' }, 'Go to checkout', Element => new Element('form'))), true);
});

test('a declarative handler keeps the ask: on*, ping, Rails data-method, Turbo, Stimulus, htmx, Vue, Alpine, Angular', () => {
  const attrs = ['onclick', 'onmousedown', 'ONCLICK', 'ping', 'data-method', 'data-remote', 'data-confirm', 'data-action', 'data-turbo', 'data-turbo-method',
    'data-turbo-stream', 'hx-post', 'hx-get', '@click', 'x-on:click', 'v-on:click', 'ng-click', '(click)', '[href]'];
  for (const name of attrs) asks(link({ href: '/shop/checkout', [name]: 'post' }, 'Go to checkout'), name);
  // The reported case: a Rails data-method="post" Pay invoice link, and an htmx one.
  asks(link({ href: '/invoices/7/pay', 'data-method': 'post' }, 'Pay invoice'), 'Pay invoice');
  asks(link({ href: '/invoices/7/pay', 'hx-post': '/invoices/7/pay' }, 'Pay invoice'), 'hx-post');
  // Ordinary attributes do not.
  assert.equal(navigates(link({ href: '/shop/checkout', class: 'button', id: 'go', 'data-testid': 'x', target: '_blank', rel: 'noopener', 'aria-label': 'Go to checkout' }, 'Go to checkout')), true);
});

test('a button or other role, a non-anchor link, or a money figure in the words keeps the ask', () => {
  asks(link({ href: '/shop/checkout', role: 'button' }, 'Go to checkout'), 'role button');
  asks(link({ href: '/shop/checkout', role: 'menuitem' }, 'Go to checkout'), 'role menuitem');
  asks(classify(({ Element }) => new Element('div', { role: 'link', href: '/shop/checkout' }, 'Go to checkout')), 'div link');
  for (const text of ['Pay $18 now', 'Buy for 18.00', 'Subscribe, 18 USD', 'Checkout $18', 'Checkout 18.00']) asks(link({ href: '/charge' }, text), text);
});

test('an attribute list that cannot be read leaves the link guarded', () => {
  const element = classify(({ Element }) => { delete Element.prototype.getAttributeNames; return new Element('a', { href: '/shop/checkout' }, 'Go to checkout'); });
  assert.equal(element.navigation, false); asks(element, 'unreadable');
});

test('navigation leaves the submit fence and the figure check alone', () => {
  const f = fixture(terms), save = classify(({ Element, HTMLButtonElement }) => new HTMLButtonElement('button', {}, 'Save', new Element('form')));
  rules.beginSubmit(f.state, 100);
  assert.equal(rules.check(f.ctx, 'click', f.target({ element: save })).verdict, 'refuse');
  const nav = released(link({ href: '/shop/checkout/address' }, 'Go to checkout'));
  assert.equal(rules.check(f.ctx, 'click', f.target({ element: nav })).verdict, 'allow');
  // A priced payment whose page terms the figure check blanked (a larger figure on the checkout) still asks.
  const g = fixture(terms), pay = classify(({ Element, HTMLButtonElement }) => new HTMLButtonElement('button', {}, 'Place order', new Element('main')));
  assert.equal(rules.check(g.ctx, 'click', g.target({ element: pay, terms: { page: { ...terms, amount: undefined }, method: terms.method } })).verdict, 'confirm');
});
