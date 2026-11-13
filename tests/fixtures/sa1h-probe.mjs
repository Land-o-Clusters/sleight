// Offline fault injection and deliberately broken implementations. Copies live
// only under the caller's temporary directory; production files never change.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, linkSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { trackTemp } from '../../scripts/temp-leftovers.mjs';
import { parenthesizedReads, stateReads } from './sa1r-filtered-reads.mjs';
import { assertRecordedReads } from './sa1r-recorded-reads.mjs';

const lib = new URL('../../plugins/sleight/lib/', import.meta.url);
const replace = (source, from, to) => {
  assert.ok(source.includes(from), `mutation site: ${from}`);
  return source.replace(from, to);
};
async function load(root, name, transform = s => s) {
  const url = new URL(name, lib);
  const source = transform(readFileSync(url, 'utf8')).replace(/from '([.][.]?\/[^']+)'/g,
    (_, specifier) => `from '${new URL(specifier, url).href}'`);
  const file = join(root, name.replaceAll('/', '-'));
  writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}
const mutations = {
  'await-any-method': s => replace(s, '!READ_METHODS.includes(callee.property.name) || !options(call.arguments)', 'false || !options(call.arguments)'),
  'unchecked-sequence': s => replace(s, "case 'Literal': return true;", "case 'SequenceExpression': return true; case 'Literal': return true;"),
  'parenthesized-callee': s => replace(s, 'const call = node.argument, callee = call.callee;', 'const call = node.argument, callee = call.callee?.expression ?? call.callee;'),
  'shadowed-handle': s => replace(s, "if (!handles.size || locals.has('nodeRepl') || [...handles].some(name => locals.has(name))) return false;", "if (!handles.size || locals.has('nodeRepl')) return false;"),
  'unchecked-source': s => replace(s, '        snapshotState(entry.snapshot, entry.beforeState);', '        // Missing source check.'),
  'unchecked-preview': s => {
    assert.equal(s.split('      snapshotState(entry.snapshot, entry.beforeState);').length - 1, 3);
    // Preserve the deeper decide check, and remove the two preview checks.
    return s.replaceAll('\n      snapshotState(entry.snapshot, entry.beforeState);', '\n      // Missing preview check.');
  },
  'unchecked-stage': s => replace(s, '        snapshotState(restored, entry.beforeState);', '        // Missing staging check.'),
  'unchecked-installed': s => replace(s, 'restoredState = snapshotState(entry.path, entry.beforeState)', 'restoredState = state(entry.path)'),
  'delete-changed-parked': s => replace(s, 'unchanged = state(parked).key === parkedState.key', 'unchanged = true'),
  'collapsed-discard': s => replace(s, "return change('permissions-repair-discard');", "return change('permissions-repair');"),
  'collapsed-sites': s => replace(s, "return change('permissions-sites-all');", "return change('permissions-sites');"),
  'raw-site-count': s => replace(s, "String(sites.filter((site, at) =>\n        sites.findIndex(other => sameListed(other, site)) === at).length)", 'String(sites.length)'),
  'truncated-notice': s => replace(s, "['repair', 'sites', 'unblock'].includes(rest[0])", "false"),
  'missing-swift-key': s => replace(s, '    "permissions-repair-discard": ("erase every sleight block and site limit", nil),', ''),
  'missing-csharp-key': s => replace(s, '        { "permissions-repair-discard", new[] { "erase every sleight block and site limit" } },', ''),
  'recorded-read-regression': s => replace(s, "case 'ParenthesizedExpression': return expression(node.expression);", "case 'ParenthesizedExpression': return false;"),
  'uncapped-origins': s => replace(s, '++origins > 8', '++origins > 256'),
  'dropped-flags': s => replace(s, 'if (/^https?:\\/\\//i.test(text.trim())', "if (text.startsWith('--')) return undefined;\n      if (/^https?:\\/\\//i.test(text.trim())"),
  'overstated-swift-sites': s => replace(s, 'lift the limit to chosen sites; blocked sites stay blocked', 'allow every site again'),
  'overstated-csharp-sites': s => replace(s, 'lift the limit to chosen sites; blocked sites stay blocked', 'allow every site again'),
  'obsolete-swift-sites': s => replace(s, 'let personConfirmReasons: [String: (plain: String, subject: String?)] = [',
    'let personConfirmReasons: [String: (plain: String, subject: String?)] = [\n    "permissions-sites": ("change the sites sleight may act on", nil),'),
  'obsolete-csharp-sites': s => replace(s, 'Reasons = new Dictionary<string, string[]> {',
    'Reasons = new Dictionary<string, string[]> {\n        { "permissions-sites", new[] { "change the sites sleight may act on" } },'),
};
for (const [name] of parenthesizedReads) mutations['lost-' + name] = s => replace(s,
  "case 'ParenthesizedExpression': return expression(node.expression);", "case 'ParenthesizedExpression': return false;");
for (const [name] of stateReads) mutations['lost-' + name] = s => replace(s, "['length', 'state'].includes(node.property.name)", "node.property.name === 'length'");
export const probes = Object.keys(mutations);
export async function probe(name, broken = false) {
  assert.ok(Object.hasOwn(mutations, name));
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-sa1h-probe-')));
  const mutate = broken ? mutations[name] : s => s;
  let review;
  try {
    if (name.startsWith('lost-') || name === 'recorded-read-regression') {
      const { isFilteredRead } = await load(root, 'input-lease.mjs', mutate);
      if (name === 'recorded-read-regression') assertRecordedReads(isFilteredRead);
      else assert.equal(isFilteredRead([...parenthesizedReads, ...stateReads].find(([key]) => 'lost-' + key === name)[1]), true, name);
    } else if (['uncapped-origins', 'dropped-flags'].includes(name)) {
      const { settingsCommand } = await load(root, 'person-gate.mjs', mutate);
      const origins = Array.from({ length: 256 }, (_, i) => `https://site${i}.test`);
      const actual = settingsCommand(['permissions', 'sites', 'only', '--before', ...origins, '--discard', '--after']);
      assert.equal(actual, ['permissions', 'sites', 'only', '--before', ...origins.slice(0, 8), '--discard', '--after', 'and', '248', 'more'].join(' '));
    } else if (name.startsWith('overstated-') || name.startsWith('obsolete-')) {
      const file = name.includes('swift') ? 'direct-browser/native/consent-host.swift' : 'direct-browser/native/win/PersonHello.cs';
      const source = mutate(readFileSync(new URL(file, lib), 'utf8'));
      assert.ok(source.includes('lift the limit to chosen sites; blocked sites stay blocked'));
      assert.doesNotMatch(source, /"permissions-sites"\s*[:,]/);
    } else if (['await-any-method', 'unchecked-sequence', 'parenthesized-callee', 'shadowed-handle'].includes(name)) {
      const { isFilteredRead } = await load(root, 'input-lease.mjs', mutate);
      const code = {
        'await-any-method': 'const s = await ff.getAXState(); await ff.click();',
        'unchecked-sequence': 'const s = await ff.getAXState(); /"/, await ff.click({ x: 1 }), /"/;',
        'parenthesized-callee': 'const s = await ff.getAXState(); await (ff.getAXState)();',
        'shadowed-handle': 'const ff = "x"; await ff.getAXState();',
      }[name];
      assert.equal(isFilteredRead(code), false, name);
    } else if (['unchecked-source', 'unchecked-preview', 'unchecked-stage', 'unchecked-installed', 'delete-changed-parked'].includes(name)) {
      const { ChangeReview } = await load(root, 'change-review.mjs', source => {
        source = replace(source, '        copy(entry.snapshot, restored);', '        copy(entry.snapshot, restored); this.afterCopy?.(entry, restored);');
        source = replace(source, '          renameSync(restored, entry.path); installed = true;',
          '          this.installAttempted = true; renameSync(restored, entry.path); installed = true; this.afterInstall?.(entry, parked);');
        return mutate(source);
      });
      review = new ChangeReview();
      const path = join(root, 'document'); writeFileSync(path, 'before');
      const entry = review.before({ title: 'fixture', url: pathToFileURL(path).href });
      writeFileSync(path, 'agent'); review.after(entry);
      if (name === 'unchecked-preview') {
        writeFileSync(entry.snapshot, 'swapped');
        assert.match(review.describe(entry), /^Review unavailable:\n  snapshot unavailable or changed: bytes, size or type changed\nUndo will refuse\.$/m);
        assert.equal(readFileSync(path, 'utf8'), 'agent');
        return;
      } else if (name === 'unchecked-source') {
        const other = join(root, 'link'); linkSync(entry.snapshot, other);
      } else if (name === 'unchecked-stage') review.afterCopy = (_, restored) => writeFileSync(restored, 'swapped');
      else if (name === 'unchecked-installed') review.afterInstall = () => writeFileSync(path, 'swapped');
      else review.afterInstall = (_, parked) => writeFileSync(parked, 'person');
      assert.throws(() => review.decide(entry, 'undo'), /snapshot|preserved|hard.link/i, name);
      if (name === 'delete-changed-parked') {
        const staging = readdirSync(root).find(n => n.startsWith('.document-sleight-'));
        assert.ok(staging, 'changed parked file is preserved');
        assert.equal(readFileSync(join(root, staging, 'current'), 'utf8'), 'person');
      } else {
        assert.equal(readFileSync(path, 'utf8'), 'agent');
        if (name === 'unchecked-stage') assert.notEqual(review.installAttempted, true, 'bad staged bytes never reach the document');
      }
    } else if (name === 'truncated-notice') {
      const { settingsCommand } = await load(root, 'person-gate.mjs', mutate);
      assert.match(settingsCommand(['permissions', 'repair', '--discard']), /--discard/);
      assert.match(settingsCommand(['permissions', 'sites', 'only', 'https://one.test', 'https://two.test']), /https:\/\/one.test.*https:\/\/two.test/);
    } else if (name.startsWith('missing-')) {
      const swift = readFileSync(new URL('direct-browser/native/consent-host.swift', lib), 'utf8');
      const csharp = readFileSync(new URL('direct-browser/native/win/PersonHello.cs', lib), 'utf8');
      const mac = /let personConfirmReasons[^=]*= \[([\s\S]*?)\n\]/.exec(name === 'missing-swift-key' ? mutate(swift) : swift)[1];
      const win = /Dictionary<string, string\[\]> Reasons[^=]*= new Dictionary<string, string\[\]> \{([\s\S]*?)\n    \};/.exec(name === 'missing-csharp-key' ? mutate(csharp) : csharp)[1];
      const keys = (source, pattern) => [...source.matchAll(pattern)].map(m => m[1]).sort();
      assert.deepEqual(keys(mac, /^\s*"([\w-]+)":/gm), keys(win, /\{ "([\w-]+)",/g));
    } else {
      const { highStakesChange } = await load(root, 'person-confirm.mjs', mutate);
      if (name === 'raw-site-count') {
        assert.deepEqual(highStakesChange(['permissions', 'sites', 'only', 'https://one.test', 'https://www.one.test.']),
          { key: 'permissions-sites-only', subject: '1' });
        return;
      }
      assert.deepEqual(highStakesChange(name === 'collapsed-discard' ? ['permissions', 'repair', '--discard'] : ['permissions', 'sites', 'all']),
        { key: name === 'collapsed-discard' ? 'permissions-repair-discard' : 'permissions-sites-all' });
    }
  } finally { review?.dispose(); if (existsSync(root)) rmSync(root, { recursive: true, force: true }); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await probe(process.argv[2], true);
