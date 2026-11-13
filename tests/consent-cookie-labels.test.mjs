import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { declinesCookies, acceptsCookies, engineConsent } from '../plugins/sleight/lib/consent-wall.mjs';
import { checkConsent, inspectConsent } from '../plugins/sleight/lib/direct-browser/consent-wall.mjs';

const cases = [
  ['Reject all', true],
  ['Accept only necessary', true],
  ['Only necessary', true],
  ['Use necessary cookies only', true],
  ['Necessary only', true],
  ['Nur notwendige Cookies', true],
  ['Refuser tout', true],
  ['Rechazar todo', true],
  ['Only accept all', false],
  ['Accept all', false],
  ['Allow selection', false],
  ['Accept selected', false],
  ['Allow all cookies', false],
  ['OK', false],
  ['Got it', false],
  ['Agree', false],
];

// Use the browser module's serialized helpers, as trusted-dom.mjs does in the
// isolated utility realm. No browser or native host is started.
const browser = runInNewContext(`(() => {
  ${inspectConsent.helpers.map(helper => helper.toString()).join('\n')}
  return { declinesCookies, acceptsCookies, inspect: ${inspectConsent.toString()} };
})()`);

function cookieButton(label, accessible) {
  const view = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', position: 'static' }) };
  const doc = { defaultView: view };
  const make = (tag, attrs, text, parentElement) => ({
    localName: tag, nodeType: 1, namespaceURI: 'http://www.w3.org/1999/xhtml',
    isConnected: true, ownerDocument: doc, parentElement, innerText: text, textContent: text,
    getAttribute: key => attrs[key] ?? null,
    getBoundingClientRect: () => ({ width: 100, height: 30 }),
    querySelectorAll: () => [],
    childNodes: [{ nodeType: 3, textContent: text }],
  });
  const wall = make('div', { id: 'onetrust-banner-sdk' }, 'We use cookies');
  return make('button', accessible ? { 'aria-label': label } : {}, accessible ? '' : label, wall);
}
const read = (node, key) => {
  const value = node?.[key];
  return typeof value === 'function' ? value.bind(node) : value;
};

for (const [label, decline] of cases) {
  test(`shared cookie classifiers: ${label}`, () => {
    assert.equal(declinesCookies(label), decline);
    assert.equal(acceptsCookies(label), !decline);
    const tree = `0 standard window Fixture\n\t1 HTML content Fixture\n\t\t2 dialog\n\t\t\t3 text We use cookies\n\t\t\t4 button ${label}`;
    const decision = engineConsent('click', [4], tree);
    assert.equal(!!decision?.decline, decline);
    assert.equal(!!decision?.blocked, !decline);
  });

  test(`browser cookie classifiers and accessible names: ${label}`, () => {
    assert.equal(browser.declinesCookies(label), decline);
    assert.equal(browser.acceptsCookies(label), !decline);
    for (const accessible of [false, true]) {
      const decision = browser.inspect(cookieButton(label, accessible), {}, read);
      assert.equal(decision.decline, decline);
      assert.equal(decision.blocked, !decline);
    }
  });
}

test('browser click check rereads the held element accessible name', async () => {
  const button = cookieButton('Reject all', false);
  let accessibleName = 'Reject all', reads = 0;
  button.getAttribute = key => key === 'aria-label' ? accessibleName : null;
  // Simulate only the utility-world transport. Execute the browser module's
  // serialized inspector and classifiers on the same held element each time.
  const node = { _frame: { utilityContext: async () => ({ world: 'utility',
    evaluateExpression: async (source, options, args) => {
      assert.ok(source.includes(inspectConsent.toString()));
      assert.equal(options.isFunction, true);
      assert.equal(args[0], node);
      reads++;
      return browser.inspect(button, args[1], read);
    },
  }) } };
  const locator = { _connection: { toImpl: () => node } }, state = {};
  assert.equal(await checkConsent(locator, 'fill', state), false);
  accessibleName = 'Accept all';
  await assert.rejects(checkConsent(locator, 'click', state), /Cookie acceptance blocked/);
  assert.equal(reads, 2);
  assert.equal(state.consentObservation, undefined);
});
