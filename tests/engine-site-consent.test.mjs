import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { siteConsentKey, siteConsentQuestion } from '../plugins/sleight/lib/engine-site-consent.mjs';

async function broken(mutate) {
  const url = new URL('../plugins/sleight/lib/engine-site-consent.mjs', import.meta.url), source = readFileSync(url, 'utf8');
  const changed = mutate(source);
  assert.notEqual(changed, source);
  const absolute = changed.replace(/from '([.][.]?\/[^']+)'/g, (_, path) => `from '${new URL(path, url).href}'`);
  return import('data:text/javascript;base64,' + Buffer.from(absolute).toString('base64'));
}
test('site consent binds the app, window, title and page markers, never an answer in the page', async () => {
  const window = { app: 'Firefox', appId: 'org.mozilla.firefox', title: 'Page', rootId: 'W1' };
  const text = '0 standard window Page\n\t1 HTML Content URL: https://a.example/one\n\t2 text accept';
  const check = scope => {
    const key = scope(window, text);
    for (const changed of [{ ...window, appId: 'another.app' }, { ...window, rootId: 'W2' }, { ...window, title: 'Other' }])
      assert.notEqual(scope(changed, text), key);
    assert.notEqual(scope(window, text.replace('/one', '/two')), key);
    assert.equal(scope(window, text.replace('text accept', 'text decline')), key);
    assert.equal(scope(window, text.replace('1 HTML Content', '999 HTML Content')), key, 'row numbers never identify a page');
  };
  check(siteConsentKey);
  const mutant = await broken(source => source.replace('window.title, window.url,', 'window.url,'));
  assert.throws(() => check(mutant.siteConsentKey), assert.AssertionError);
});

test('the site question escapes untrusted app and title text with the shared card helper and bounds it', async () => {
  const check = ask => {
    const question = ask({ app: 'Firefox\n<app>', title: 'Pay\u202e\n<accept>"' });
    assert.match(question, /Firefox\\u000a&lt;app&gt;/);
    assert.match(question, /title \(untrusted text\): "Pay\\u202e\\u000a&lt;accept&gt;&quot;"/);
    assert.match(question, /can't confirm the site/);
    assert.ok(ask({ app: 'F', title: 'x'.repeat(10000) }).length < 1500);
  };
  check(siteConsentQuestion);
  const mutant = await broken(source => source.replaceAll('escapeLabel(', 'String('));
  assert.throws(() => check(mutant.siteConsentQuestion), assert.AssertionError);
});

for (const [name, line] of [
  ['web URL', '9 HTML content URL: https://a.example/two'],
  ['address URL', '10 combo box Value: https://a.example/two'],
  ['window title', '0 standard window Other'],
  ['window header', 'Window: "Other", App: Firefox.'],
  ['URL line', 'URL: https://a.example/two'],
  ['root URL', '0 x URL: https://a.example/two'],
]) {
  test(`SA2T consent markers include added and removed diff lines: ${name}`, async t => {
    const window = { app: 'Firefox', title: 'Page' }, baseline = 'Window: "Page", App: Firefox.\n0 standard window Page';
    const check = key => {
      for (const prefix of ['+ ', '- ']) {
        assert.notEqual(key(window, baseline + '\n' + prefix + line), key(window, baseline));
        assert.equal(key(window, baseline + '\n' + prefix + line), key(window, baseline + '\n' + line));
      }
    };
    check(siteConsentKey);
    const mutant = await broken(source => source.replaceAll('(?:[+-] )?', ''));
    assert.throws(() => check(mutant.siteConsentKey), assert.AssertionError);
    t.diagnostic('the same marker assertion rejects the variant ignoring diff prefixes');
  });
}
