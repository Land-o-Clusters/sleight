import { test } from 'node:test';
import { pageSiteCases } from './fixtures/page-site-cases.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const url = new URL('../plugins/sleight/lib/permissions.mjs', import.meta.url);
const source = readFileSync(url, 'utf8');
const variants = {
  first: s => s.replace('HTML content\\b(.*)$/gm)];', 'HTML content\\b(.*)$/gm)].slice(0, 1);'),
  last: s => s.replace('HTML content\\b(.*)$/gm)];', 'HTML content\\b(.*)$/gm)].slice(-1);'),
  shallowest: s => s.replace('const sites = areas.map', 'const sites = areas.filter(area => area[1].length === Math.min(...areas.map(row => row[1].length))).map'),
  'exactly-one': s => s.replace('const sites = areas.map', 'if (!fromWindow && areas.length !== 1) return { unproven: true };\n  const sites = areas.map'),
  'window-root-zero': s => s.replace('if (!/^0 /m.test(source))', 'if (!/^0 standard window/m.test(source))'),
  'last-root': s => s.replace('const areas = [...source.matchAll', "const areas = [...source.slice([...source.matchAll(/^0 .*$/gm)].at(-1).index).matchAll"),
  'no-area': s => s.replace('const sites = areas.map', 'if (areas.length) return { unproven: true };\n  const sites = areas.map'),
  block: s => s.replace('const areas = [...source.matchAll', "const areas = [...source.slice(source.indexOf('0 ')).split('\\n').slice(1).filter((line, i, lines) => lines.slice(0, i + 1).every(row => row.startsWith('\\t'))).join('\\n').matchAll"),
  'skip-parse': s => s.replace('tokens(area[2]) === 1 ? webSite(/URL: ([^\\s,]+)/.exec(area[2])?.[1]) : undefined', "({ host: 'evil.example' })"),
  'skip-tokens': s => s.replace('tokens(area[2]) === 1 ?', 'true ?'),
  'skip-cross-check': s => s.replace(/if \(sites\.some[^\n]+/, 'if (false) return { unproven: true };').replace('if (fromWindow && (fromWindow.unproven || key(fromWindow) !== key(sites[0])))', 'if (false)'),
};

// Import disposable module bytes with the real dependencies, without editing the worktree or starting a child.
async function load(text) {
  const absolute = text.replace(/from '([.][.]?\/[^']+)'/g, (_, path) => `from '${new URL(path, url).href}'`);
  return import(`data:text/javascript;base64,${Buffer.from(absolute).toString('base64')}`);
}

const depthVariants = pageSiteCases.filter(entry => /^depth 4, page value forgery depth [123]$/.test(entry.name))
  .map(entry => ({ ...entry, broken: 'shallowest' }));
for (const entry of [...pageSiteCases, ...depthVariants]) {
  test(`G9 broken variant: ${entry.name} (${entry.broken})`, async t => {
    const check = site => assert.deepEqual(site(entry.text, entry.window), entry.expected);
    const module = await load(source);
    check((text, window) => module.pageSiteRefusal(text, window, page => page));
    const changed = variants[entry.broken](source);
    assert.notEqual(changed, source, 'the mutation must change the implementation');
    const changedModule = await load(changed);
    const broken = (text, window) => changedModule.pageSiteRefusal(text, window, page => page);
    assert.throws(() => check(broken), assert.AssertionError, 'the same invariant must reject the broken implementation');
    t.diagnostic(`unchanged invariant passes; broken variant fails: ${JSON.stringify(broken(entry.text, entry.window))}`);
  });
}

for (const entry of pageSiteCases.filter(entry => entry.expected?.host && !entry.window?.url)) {
  test(`SA2R broken variant: ${entry.name} cannot prove a site without a window URL`, async () => {
    const check = site => assert.deepEqual(site(entry.text, entry.window), { unproven: true });
    check((await load(source)).pageSite);
    const changed = source.replace('return candidateSite(text, window, true);', 'return candidateSite(text, window);');
    assert.notEqual(changed, source);
    const broken = (await load(changed)).pageSite;
    assert.throws(() => check(broken), assert.AssertionError);
  });
}
