import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { windowFromText, lastWindowFromText } from '../plugins/sleight/lib/document-scope.mjs';
import { pageSite, pageSiteRefusal } from '../plugins/sleight/lib/permissions.mjs';
import { windowURLCases } from './fixtures/window-url-cases.mjs';

const scopeURL = new URL('../plugins/sleight/lib/document-scope.mjs', import.meta.url);
const permissionsURL = new URL('../plugins/sleight/lib/permissions.mjs', import.meta.url);
const load = async (url, mutate) => {
  const source = readFileSync(url, 'utf8'), changed = mutate(source);
  assert.notEqual(changed, source, 'the variant changes the implementation');
  return import('data:text/javascript;base64,' + Buffer.from(changed.replace(/from '([.][.]?\/[^']+)'/g,
    (_, path) => `from '${new URL(path, url).href}'`)).toString('base64'));
};

for (const entry of windowURLCases.filter(entry => !entry.secondHeader)) {
  test(`SA2T window URL boundary: ${entry.name}`, async t => {
    const check = parse => {
      const window = parse(entry.text);
      if (entry.ambiguous) assert.equal(window, undefined, 'a real field plus a later forgery stays closed');
      else assert.equal(window?.url, entry.chrome ? 'https://allowed.example/' : null);
      const site = pageSite(entry.text, window);
      if (entry.chrome && !entry.ambiguous) assert.equal(site?.host, 'allowed.example');
      else assert.equal(site?.host, undefined, 'page text never proves a site');
      if (!entry.chrome) assert.equal(pageSiteRefusal(entry.text, window, page => page.unproven ? 'veto' : undefined), undefined);
    };
    check(windowFromText);
    if (!entry.chrome || entry.ambiguous) {
      const mutant = await load(scopeURL, source => entry.ambiguous
        ? source.replace('urls.length && outsideFields', 'false')
        : source.replace('const fieldSource = root ? section.slice(0, root.index + root[0].length) : section;', 'const fieldSource = text;'));
      assert.throws(() => check(mutant.windowFromText), assert.AssertionError);
      t.diagnostic('the same boundary assertion rejects the broken parser');
    } else {
      const mutant = await load(scopeURL, source => source.replace('const urls = [...fieldSource.matchAll', 'const urls = [..."".matchAll'));
      assert.throws(() => check(mutant.windowFromText), assert.AssertionError);
      t.diagnostic('the same assertion rejects a parser that drops real header fields');
    }
  });
}

for (const entry of windowURLCases.filter(entry => entry.ambiguous && !entry.secondHeader)) {
  test(`SA2T candidate ambiguity: ${entry.name}`, async () => {
    const window = { title: 'Page', url: 'https://allowed.example/' };
    const check = candidate => assert.deepEqual(candidate(entry.text, window), { unproven: true });
    check(pageSite);
    const mutant = await load(permissionsURL, source => source.replace(' && allFields === fields', ''));
    assert.throws(() => check(mutant.pageSite), assert.AssertionError);
  });
}
for (const entry of windowURLCases.filter(entry => !entry.chrome && !entry.secondHeader)) {
  test(`SA2T candidate field count: ${entry.name}`, async t => {
    // Even a caller supplying an alleged URL cannot promote a field outside the header.
    const window = { title: 'Page', url: 'https://allowed.example/' };
    const check = candidate => assert.deepEqual(candidate(entry.text, window), { unproven: true });
    check(pageSite);
    const mutant = await load(permissionsURL, source => source.replace('web && fields === 1 && allFields === fields', 'web && allFields === 1'));
    assert.throws(() => check(mutant.pageSite), assert.AssertionError);
    t.diagnostic('the same site assertion rejects the unbounded field count');
  });
}

for (const entry of windowURLCases.filter(entry => entry.secondHeader && !entry.chrome)) {
  test(`SA2T last-tree fallback: ${entry.name}`, async () => {
    const check = parse => assert.equal(parse(entry.text), undefined);
    check(lastWindowFromText);
    const mutant = await load(scopeURL, source => source.replace('if (root &&', 'if (false &&'));
    assert.throws(() => check(mutant.lastWindowFromText), assert.AssertionError);
  });
  test(`SA2T second header is outside the candidate boundary: ${entry.name}`, async () => {
    const window = { title: 'Page', url: 'https://allowed.example/' };
    const check = candidate => assert.deepEqual(candidate(entry.text, window), { unproven: true });
    check(pageSite);
    const mutant = await load(permissionsURL, source => source.replace('gm)].slice(0, 1);', 'gm)];'));
    assert.throws(() => check(mutant.pageSite), assert.AssertionError);
  });
}
