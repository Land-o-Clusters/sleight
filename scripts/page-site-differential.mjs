// Offline comparison only. Reads JSON fixtures and event logs; never starts a relay, app, engine or child process.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const values = name => args.flatMap((value, i) => value === name ? [args[i + 1]] : []);
const [baseFile] = values('--base'), [headFile] = values('--head'), [repo] = values('--repo'), [out] = values('--out');
if (!baseFile || !headFile || !repo || !out) throw new Error('Required: --base FILE --head FILE --repo ROOT --out FILE [--race ROOT ...]');
// Both snapshots use this checkout's dependencies, including when the head snapshot lives in private scratch space.
const moduleURL = pathToFileURL(join(resolve(repo), 'plugins/sleight/lib/permissions.mjs'));
const load = async file => {
  const source = readFileSync(file, 'utf8').replace(/from '([.][.]?\/[^']+)'/g, (_, path) => `from '${new URL(path, moduleURL).href}'`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
};
const [{ pageSite: base }, { pageSite: head, pageSiteRefusal: headRefusal }, { lastWindowFromText }] = await Promise.all([
  load(baseFile), load(headFile), import(pathToFileURL(join(resolve(repo), 'plugins/sleight/lib/document-scope.mjs'))),
]);
const digest = text => createHash('sha256').update(text).digest('hex');
function* files(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(entry.name)) continue;
    const path = join(root, entry.name);
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (stat.isDirectory()) yield* files(path);
    else if (stat.isFile()) yield path;
  }
}
const increment = (obj, key) => { obj[key] = (obj[key] ?? 0) + 1; };
function shape(text, areas) {
  const depth = areas.map(a => a[1].length);
  const shapes = [];
  if ((text.match(/^Window: /gm) ?? []).length > 1) shapes.push('multiple-window-headers');
  if ((text.match(/^\d+ standard window\b/gm) ?? []).length > 1) shapes.push('multiple-window-roots');
  if (new Set(depth).size > 1) shapes.push('mixed-area-depths');
  if (depth.includes(0)) shapes.push('column-zero-area');
  if (/^sleight: (?:lines changed|no change since)/m.test(text)) shapes.push('relay-diff');
  if (/tree lines omitted|…\(\d+\)|\[Image:/.test(text)) shapes.push('trimmed-or-image');
  if (/^0 (?!standard window)/m.test(text)) shapes.push('non-window-zero-row');
  return shapes.length ? shapes : ['multiple-areas-same-depth'];
}
function corpus(label, roots, select) {
  const texts = new Map(); let fileCount = 0, jsonRecords = 0, invalidLines = 0;
  const add = (text, origin) => {
    if (typeof text !== 'string') return;
    const old = texts.get(text);
    if (old) old.occurrences++;
    else texts.set(text, { origin, occurrences: 1 });
  };
  function walk(value, origin) {
    if (typeof value === 'string') {
      if (/^0 /m.test(value) || /HTML content/.test(value)) add(value, origin);
    } else if (Array.isArray(value)) {
      // Match the review's collection: whole text replies plus individual items, deduplicated by exact text.
      const parts = value.filter(c => c?.type === 'text' && typeof c.text === 'string');
      if (parts.length > 1) add(parts.map(c => c.text).join('\n'), origin + '#joined');
      for (const child of value) walk(child, origin);
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) walk(child, origin);
    }
  }
  for (const root of roots) for (const file of files(root)) {
    if (!select(file) || statSync(file).size > 60e6) continue;
    fileCount++;
    const origin = `${label}/${roots.indexOf(root)}/${relative(root, file)}`;
    if (file.endsWith('.jsonl')) {
      let lineNumber = 0;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        lineNumber++; if (!line.trim()) continue;
        try { const value = JSON.parse(line); jsonRecords++; walk(value, `${origin}:${lineNumber}`); }
        catch { invalidLines++; }
      }
    } else if (file.endsWith('.txt')) {
      const raw = readFileSync(file, 'utf8');
      if (/HTML content/.test(raw)) add(raw, origin);
    } else {
      try { const value = JSON.parse(readFileSync(file, 'utf8')); jsonRecords++; walk(value, origin); }
      catch { invalidLines++; }
    }
  }
  const counts = { files: fileCount, jsonRecords, invalidLines, distinctTexts: texts.size, withArea: 0, withWindowAndArea: 0,
    judged: 0, siteToDifferentSite: 0, unprovenToSite: 0, siteToUnproven: 0, unchanged: 0, otherChanges: 0 };
  const changed = [], classes = {}, areaCounts = {}, browserShapes = {}, windowURLApps = {};
  for (const [text, record] of texts) {
    const areas = [...text.matchAll(/^(\t*)\d+ HTML content\b(.*)$/gm)];
    if (/HTML content/.test(text)) counts.withArea++;
    const window = lastWindowFromText(text);
    if (!window) continue;
    if (/HTML content/.test(text)) counts.withWindowAndArea++;
    counts.judged++;
    const browser = /Firefox/i.test(window.app) ? 'Firefox' : /Safari/i.test(window.app) ? 'Safari' :
      /Chrome|Chromium|Helium/i.test(window.app) ? 'Chrome-like' : 'other';
    const group = browserShapes[browser] ??= { judged: 0, withArea: 0, withCapitalizedArea: 0, withWindowURL: 0, withWindowURLAndArea: 0,
      siteToUnproven: 0, siteToAsk: 0, unprovenToAsk: 0, newlyProven: 0 };
    group.judged++;
    if (areas.length) group.withArea++;
    if (/^(\t*)\d+ HTML Content\b/m.test(text)) group.withCapitalizedArea++;
    if (window.url) group.withWindowURL++;
    if (window.url && areas.length) group.withWindowURLAndArea++;
    if (window.url) increment(windowURLApps, window.app + ':' + (/^https?:\/\//i.test(window.url) ? 'http(s)' : 'other-scheme'));
    const before = base(text, window), after = head(text, window);
    const askEligible = !window.url && headRefusal && !headRefusal(text, window, page => page.unproven ? 'unproven' : undefined);
    if (!before?.host && askEligible) group.unprovenToAsk++;
    if (JSON.stringify(before) === JSON.stringify(after)) { counts.unchanged++; continue; }
    let kind;
    if (before?.host && after?.host) kind = 'siteToDifferentSite';
    else if (!before?.host && after?.host) kind = 'unprovenToSite';
    else if (before?.host && !after?.host) kind = 'siteToUnproven';
    else kind = 'otherChanges';
    counts[kind]++;
    if (kind === 'siteToUnproven') {
      group.siteToUnproven++;
      // Potential prompt transitions under a limit permitting the former site. Existing vetoes still refuse.
      // The corpus does not carry the user's actual site limits or a click answering any question.
      if (askEligible) group.siteToAsk++;
    }
    if (kind === 'siteToDifferentSite' || kind === 'unprovenToSite') group.newlyProven++;
    const shapes = shape(text, areas);
    for (const tag of shapes) increment(classes, `${kind}:${tag}`);
    increment(areaCounts, `${kind}:${areas.length}`);
    changed.push({ ...record, sha256: digest(text), kind, before, after, window, areas: areas.map(a => ({ depth: a[1].length, line: a[0] })), shapes, text });
  }
  return { label, counts, classes, areaCounts, browserShapes, windowURLApps, changed };
}
// Include the raw column-zero forgeries that recorded corpora may never contain.
const { windowURLCases } = await import(pathToFileURL(join(resolve(repo), 'tests/fixtures/window-url-cases.mjs')));
const synthetic = windowURLCases.map(entry => {
  const window = lastWindowFromText(entry.text), before = base(entry.text, window), after = head(entry.text, window);
  const veto = window && headRefusal(entry.text, window, page => page.unproven ? 'unproven' : undefined);
  const outcome = !window || veto ? 'closed' : window.url ? 'proven' : 'ask';
  const expected = entry.ambiguous ? 'closed' : entry.chrome ? 'proven' : 'ask';
  if (outcome !== expected || !!after?.host !== (expected === 'proven')) throw new Error(`Synthetic boundary failed: ${entry.name}`);
  return { name: entry.name, browser: entry.browser ?? 'Chrome-like', outcome, window, before, after };
});
const result = { baseSHA256: digest(readFileSync(baseFile)), headSHA256: digest(readFileSync(headFile)), synthetic, corpora: [
  corpus('repo', [join(repo, 'tests/fixtures'), join(repo, 'bench/replay')], file => /\.(?:jsonl?|txt)$/.test(file)),
  corpus('race', values('--race'), file => /\.(?:jsonl?|txt)$/.test(file)),
] };
writeFileSync(out, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
for (const { label, counts, classes, areaCounts, browserShapes, windowURLApps } of result.corpora)
  console.log(JSON.stringify({ label, counts, classes, areaCounts, browserShapes, windowURLApps }));
console.log(JSON.stringify({ label: 'synthetic', cases: synthetic.length, outcomes: synthetic.reduce((counts, row) => {
  increment(counts, `${row.browser}:${row.outcome}`); return counts;
}, {}) }));
if (result.corpora.some(c => c.counts.siteToDifferentSite || c.counts.unprovenToSite)) process.exitCode = 1;
