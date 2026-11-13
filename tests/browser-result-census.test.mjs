import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { removeTemp } from '../scripts/temp-leftovers.mjs';
import { classifyBrowserText, resultCensus, roundResultCensus } from '../bench/fowl/browser-result-census.mjs';

const utf8 = text => Buffer.byteLength(text);
const total = result => Object.values(result).reduce((a, b) => a + b, 0);
const call = (id, name, t) => ({ type: 'assistant', t, message: { id: `message-${id}`, content: [{ type: 'tool_use', id, name, input: {} }] } });
const reply = (id, text, t) => ({ type: 'user', t, message: { content: [{ type: 'tool_result', tool_use_id: id, content: typeof text === 'string' ? text : text }] } });

test('Playwright implicit files and code echoes do not become inline snapshots or deltas', () => {
  const text = '### Ran Playwright code\n```js\nawait page.click();\n```\n### Snapshot\n- [Snapshot](missing-artifact.yml)';
  const r = classifyBrowserText('playwright', text);
  assert.ok(r.codeEcho > 0); assert.ok(r.artifactLink > 0);
  assert.equal(r.fullTree, 0); assert.equal(r.delta, 0); assert.equal(total(r), utf8(text));
});

test('fenced snapshots retain heading-like page text and JSON delivery is explicit', () => {
  const text = '### Snapshot\n```yaml\n- document:\n  - text: |\n      # API Reference\n      ### Ran Playwright code\n```';
  const r = classifyBrowserText('playwright', text);
  assert.equal(r.fullTree, utf8(text)); assert.equal(r.docs, 0); assert.equal(r.codeEcho, 0);
  for (const [text, kind] of [['{"snapshot":{"role":"document","children":[]}}', 'fullTree'],
    ['{"snapshot":{"file":"missing.yml"}}', 'artifactLink'], ['{"snapshot":{"role":"document"},"result":"arbitrary"}', 'unknown']])
    assert.equal(classifyBrowserText('playwright', text)[kind], utf8(text));
});

test('FowlBrowser explicit diff headers differ from full snapshots with stable refs', () => {
  const header = 'Browser: Fixture · Tab: 1 · Fixture · https://example.test\n';
  const diff = header + 'Changes since snapshot 1 of this tab; this is snapshot 2 (call snapshot for the whole page).\n+ - button "Apply" [ref=e12]';
  assert.ok(classifyBrowserText('fowlbrowser', diff).delta > 0);
  const full = header + 'Snapshot 2 of this tab:\n```yaml\n- button "Apply" [ref=e12]\n```';
  const r = classifyBrowserText('fowlbrowser', full);
  assert.ok(r.fullTree > 0); assert.equal(r.delta, 0); assert.equal(total(r), utf8(full));
  assert.equal(classifyBrowserText('unknown', diff).unknown, utf8(diff));
});

test('DevTools UID snapshots and omitted snapshots are not deltas', () => {
  for (const text of ['## Latest page snapshot\nuid=1_0 RootWebArea "Fixture"\n  uid=1_1 button "Apply"\n',
    'uid=1_0 RootWebArea "Fixture"\n', '{"role":"RootWebArea","children":[]}']) {
    const r = classifyBrowserText('devtools', text);
    assert.equal(r.fullTree, utf8(text)); assert.equal(r.delta, 0);
  }
  const notice = 'Successfully clicked on the element.';
  assert.equal(classifyBrowserText('devtools', notice).actionNotice, utf8(notice));
  assert.equal(classifyBrowserText('unknown', 'uid=1_0 button "Apply"').fullTree, 0);
});

test('engine browser framing keeps page headings separate from docs and native windows', () => {
  const header = 'Browser tab: 1, Title: "Fixture", URL: "https://example.test".\n';
  const text = header + '1 document Fixture\n## Computer Use\nBrowser tab: summary\n2 button Apply';
  const r = classifyBrowserText('sleight', text);
  assert.equal(r.fullTree, utf8(text)); assert.equal(r.docs, 0);
  const docs = '## Computer Use\nEngine instructions\n' + header + '1 button Apply';
  assert.ok(classifyBrowserText('sleight', docs).docs > 0);
  const native = 'Window: Fixture\n1 button Apply';
  assert.equal(classifyBrowserText('sleight', native).unknown, utf8(native));
});

test('incomplete or caller browser headings remain unknown', () => {
  for (const text of ['Browser tab: summary\nThe project has three work tabs.\n',
    'Browser tab: 1\n1 document Fixture',
    'Browser tab: 1, Title: "Fixture"\n1 button Apply',
    'Browser tab: summary, Title: "Fixture", URL: "https://example.test".\n1 button Apply']) {
    const r = classifyBrowserText('sleight', text);
    assert.equal(r.fullTree, 0, text);
    assert.equal(r.unknown, utf8(text), text);
  }
  const text = 'Browser tab: 12, Title: "A\\"B", URL: "https://example.test".\n1 document Fixture';
  assert.equal(classifyBrowserText('sleight', text).fullTree, utf8(text));
});

test('Unicode and missing final newlines preserve exact UTF-8 totals', () => {
  for (const text of ['', 'é🦊\n東京', '### Snapshot\n```yaml\n- text: "é🦊"\n```'])
    assert.equal(total(classifyBrowserText('playwright', text)), utf8(text));
});

test('duplicate requests/results count once and overlapping tool intervals are unioned', () => {
  const a = call('a', 'mcp__playwright_mcp__browser_snapshot', 0), b = call('b', 'mcp__playwright_mcp__browser_click', 10);
  const image = reply('b', [{ type: 'image', data: 'fixture' }, { type: 'image', data: 'fixture' }], 30);
  const text = '### Snapshot\n```yaml\n- button "private-fixture"\n```';
  const first = reply('a', text, 20);
  const r = resultCensus([a, a, b, first, first, image, { type: 'result', usage: { output_tokens: 90, input_tokens: 100 } }]);
  assert.equal(r.results, 2); assert.equal(r.duplicateResults, 1); assert.equal(r.toolUnionMs, 30);
  assert.equal(r.imageBlocks, 2); assert.equal(r.resultKinds.image, 1); assert.equal(r.resultKinds.fullTree, 1);
  assert.equal(r.finalUsage.output, 90); assert.equal(r.perCallTokens, null); assert.equal(r.perCallTransportMs, null);
  assert.doesNotMatch(JSON.stringify(r), /private-fixture|data|missing-artifact/);
});

test('conflicting repeated results are ambiguous and unsupported blocks stay unknown', () => {
  const r = resultCensus([call('a', 'mcp__playwright_mcp__browser_snapshot', 0),
    reply('a', '### Snapshot\n```yaml\n- document\n```', 10), reply('a', 'different receipt', 20),
    call('b', 'mcp__unknown__read', 20), reply('b', [{ type: 'resource_link', uri: 'file:///never-read', name: 'fixture' }], 30)]);
  assert.equal(r.conflictingResults, 1); assert.equal(r.resultKinds.fullTree, 0);
  assert.ok(r.textBytes.unknown > 0); assert.equal(r.otherBlocks, 1);
  assert.equal(r.finalUsage.output, null);
});

test('round reader includes nested runs and requires an explicit shared clock for cross-run timing', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-result-census-')); t.after(() => removeTemp(dir));
  for (const [name, start, end] of [['one', 0, 20], ['two', 10, 30]]) {
    const task = join(dir, 'nested', name); mkdirSync(task, { recursive: true });
    writeFileSync(join(task, 'events.jsonl'), [call(name, 'mcp__chrome_devtools_mcp__click', start),
      reply(name, 'Successfully clicked on the element.', end)].map(JSON.stringify).join('\n') + '\n{bad\n');
  }
  const r = roundResultCensus(dir, { sharedClock: true });
  assert.equal(r.arms.devtools.toolUnionMs, 30); assert.equal(r.malformedLines, 2);
  assert.equal(roundResultCensus(dir).arms.devtools.toolUnionMs, null);
  const cli = spawnSync(process.execPath, ['bench/fowl/browser-result-census.mjs', '--json', '--shared-clock', dir], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.deepEqual(JSON.parse(cli.stdout)[0], r);
  assert.doesNotMatch(cli.stdout, /Successfully clicked|never-read/);
});

test('conflicting tool IDs do not borrow a known format or timing', () => {
  const r = resultCensus([call('a', 'mcp__playwright_mcp__browser_snapshot', 0),
    call('a', 'mcp__unknown__read', 1), reply('a', '### Snapshot\n```yaml\n- document\n```', 10)]);
  assert.equal(r.resultKinds.fullTree, 0); assert.ok(r.textBytes.unknown > 0);
  assert.equal(r.toolUnionMs, null); assert.equal(r.missingIntervals, 1);
});

test('round reader does not follow transcript symlinks', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-result-symlink-')); t.after(() => removeTemp(dir));
  const task = join(dir, 'task'); mkdirSync(task);
  writeFileSync(join(dir, 'private.txt'), 'not a transcript');
  symlinkSync(join(dir, 'private.txt'), join(task, 'events.jsonl'));
  assert.equal(roundResultCensus(dir).runs, 0);
  assert.equal(roundResultCensus(dir).malformedLines, 0);
});
