import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const api = await import('../bench/turn-study.mjs').catch(e => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  return {};
});
const at = ms => new Date(Date.UTC(2026, 9, 10) + ms).toISOString();
const user = (ms = 0, content = 'task') => ({ type: 'user', timestamp: at(ms), message: { content } });
const call = (id, ms, code, name = 'mcp__plugin_sleight_computer__js') => ({ type: 'assistant', timestamp: at(ms),
  message: { content: [{ type: 'tool_use', id, name, input: { code } }] } });
const result = (id, ms, text, is_error = false) => ({ type: 'user', timestamp: at(ms),
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error }] } });
const analyze = (rows, options) => { assert.equal(typeof api.analyzeTranscript, 'function'); return api.analyzeTranscript(rows, options); };
const pair = (code, text = 'ok', error = false) => [user(), call('a', 2000, code), result('a', 3000, text, error)];

test('pairs results by ID and measures gap, wall time and UTF-8 bytes without publishing text', () => {
  const r = analyze(pair('await app.getAXState()', 'é private title'));
  assert.equal(r.calls[0].wallMs, 1000);
  assert.equal(r.calls[0].modelGapMs, 2000);
  assert.equal(r.calls[0].attributableMs, 3000);
  assert.equal(r.calls[0].resultTextBytes, Buffer.byteLength('é private title'));
  assert.equal(JSON.stringify(r).includes('private title'), false);
});
test('charges a shared parallel model gap once and deduplicates repeated tool IDs', () => {
  const a = call('a', 1000, 'await app.getAXState()');
  const r = analyze([user(), a, a, call('b', 1000, 'await app.getScreenshot()'), result('b', 2000, 'b'), result('a', 3000, 'a')]);
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls.reduce((s, c) => s + c.modelGapMs, 0), 1000);
  assert.equal(r.calls[0].wallMs, 2000);
  assert.equal(r.calls[1].modelGapMs, 0);
  assert.equal(r.calls[1].attributableMs, 1000);
});
test('missing or reversed timestamps remain unknown rather than becoming zero duration', () => {
  const r = analyze([user(), call('a', 2000, 'app'), result('a', 1000, 'x'), { ...call('b', 3000, 'app'), timestamp: undefined }]);
  assert.equal(r.calls[0].wallMs, null);
  assert.equal(r.calls[1].wallMs, null);
  assert.equal(r.calls[1].attributableMs, null);
});
test('resolves spilled files only beneath the owning session tool-results directory', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-study-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'session/tool-results'), { recursive: true });
  writeFileSync(join(dir, 'session/tool-results/a.json'), JSON.stringify([{ type: 'text', text: 'x'.repeat(60000) }]));
  const wrapper = `<persisted-output>Full output saved to: ${dir}/session/tool-results/a.json\nPreview: x</persisted-output>`;
  const r = analyze(pair('await app.getAXState()', wrapper), { transcriptPath: join(dir, 'session.jsonl') });
  assert.equal(r.calls[0].resultTextBytes, 60000);
  assert.equal(r.calls[0].spillStatus, 'read');
  assert.ok(r.calls[0].classes.includes('spilled-result'));
  const bad = analyze(pair('app', wrapper.replace('/session/tool-results/', '/other/tool-results/')), { transcriptPath: join(dir, 'session.jsonl') });
  assert.equal(bad.calls[0].spillStatus, 'unavailable');
});
test('marks consecutive filtering reads after a spill, stopping at input', () => {
  const r = analyze([...pair('await app.pressKey({key:"super+s"})', '<persisted-output>Full output saved to: /missing/tool-results/a.json</persisted-output>'),
    call('b', 4000, 'nodeRepl.write((await app.getAXState()).split("\\n").filter(x=>x.includes("Save")).join("\\n"))'), result('b', 5000, 'ok'),
    call('c', 6000, 'await app.click({id:2})'), result('c', 7000, 'ok')]);
  assert.ok(r.calls[1].classes.includes('spill-filter-followup'));
  assert.equal(r.calls[2].classes.includes('spill-filter-followup'), false);
});
test('classifies an observed nonexistent method error, not method names inside successful output', () => {
  assert.ok(analyze(pair('await cua.getAXState()', 'cua.getAXState is not a function', true)).calls[0].classes.includes('nonexistent-method'));
  assert.equal(analyze(pair('await app.getAXState()', 'docs: cua.getAXState is not a function')).calls[0].classes.includes('nonexistent-method'), false);
});
test('classifies disabled Bash Read and Grep calls', () => {
  for (const name of ['Bash', 'Read', 'Grep']) {
    const r = analyze([user(), call('a', 1000, '', name), result('a', 2000, `No such tool available: ${name}. ${name} is disabled for this session.`, true)]);
    assert.ok(r.calls[0].classes.includes('refused-tool'));
  }
});
test('recognizes waitFor in the save call and in the next call', () => {
  assert.ok(analyze(pair('await app.pressKey({key:"super+s"}); await app.waitFor({title:"Save"})')).calls[0].classes.includes('wait-after-save'));
  const r = analyze([...pair('await app.pressKey({key:"super+s"})'), call('b', 5000, 'await app.waitFor({title:"Save"})'), result('b', 9000, 'ok')]);
  assert.ok(r.calls[1].classes.includes('wait-after-save'));
  assert.equal(analyze(pair('await app.waitFor({title:"Open"})')).calls[0].classes.includes('wait-after-save'), false);
});
test('recognizes separate menu open and item clicks using observed menu lines', () => {
  const r = analyze([...pair('await app.getAXState()', '1 menu bar\n 2 Format'),
    call('b', 4000, 'await app.click({id:2})'), result('b', 5000, '5 menu Format\n 6 Make Plain Text'),
    call('c', 6000, 'await app.click({id:6})'), result('c', 7000, 'ok')]);
  assert.ok(r.calls[2].classes.includes('split-menu-click'));
  assert.equal(r.calls[1].classes.includes('split-menu-click'), false);
});
test('marks a read after saved not confirmed and consecutive reads, but not unknown or acting code', () => {
  const r = analyze([...pair('await app.getAXState()', 'saved: not confirmed'), call('b', 4000, 'await app.getScreenshot()'), result('b', 5000, 'ok'),
    call('c', 6000, 'await app.customThing()'), result('c', 7000, 'ok')]);
  assert.ok(r.calls[1].classes.includes('saved-unconfirmed-read'));
  assert.ok(r.calls[1].classes.includes('consecutive-read'));
  assert.equal(r.calls[2].readOnly, false);
});
test('marks lease and guard refusals even when embedded after a window result', () => {
  for (const s of ['Window: x\nnothing from this call ran', 'sleight stopped before click', 'Input lease stopped this action']) {
    assert.ok(analyze(pair('await app.click({id:1})', s, true)).calls[0].classes.includes('lease-or-guard-refusal'));
  }
});
test('adds explicit delays and inventory followed by acquisition as separate classes', () => {
  const r = analyze([...pair('await cua.getState()'), call('b', 4000, 'let app = await cua.getApp("Calculator"); app'), result('b', 5000, 'ok'),
    call('c', 6000, 'await new Promise(r=>setTimeout(r,8000)); await app.getScreenshot()'), result('c', 15000, 'ok')]);
  assert.ok(r.calls[0].classes.includes('preliminary-inventory'));
  assert.ok(r.calls[2].classes.includes('explicit-delay'));
});
test('summary ranks task and class totals and counts overlapping calls once in the union', () => {
  assert.equal(typeof api.summarize, 'function');
  const run = { task: 'textedit-save', calls: [{ classes: ['a', 'b'], wallMs: 1000, modelGapMs: 2000, attributableMs: 3000 }] };
  const summary = api.summarize([run, run]);
  assert.equal(summary.classes[0].calls, 2);
  assert.equal(summary.classes[0].runsAffected, 2);
  assert.equal(summary.unique.attributableSeconds, 6);
});
test('matches exact prompt run coordinates and refuses ambiguous traces', () => {
  assert.equal(typeof api.matchRun, 'function');
  const rows = [user(0, '/tmp/sleight-bench/2026-10-10T00-00-00-000Z/sleight-textedit-save-2/a.txt'), call('a', 1000, 'app')];
  const run = { stamp: '2026-10-10T00-00-00-000Z', arm: 'sleight', task: 'textedit-save', run: 2 };
  assert.equal(api.matchRun(rows, [run]).status, 'prompt');
  const candidates = [{ ...run, firstCode: 'app', firstCallAt: at(1100) }, { ...run, run: 3, firstCode: 'app', firstCallAt: at(1200) }];
  assert.equal(api.matchRun([user(), call('a', 1000, 'app')], candidates).status, 'ambiguous');
  assert.equal(api.matchRun([user(), call('a', 1000, 'app')], candidates.slice(0, 1)).status, 'trace');
});
test('CLI selects a result file, writes JSON and a ranked table, omitting transcript content', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-study-cli-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'projects/p'), { recursive: true });
  const stamp = '2026-10-10T00-00-00-000Z';
  writeFileSync(join(dir, 'projects/p/session.jsonl'), [...pair('app', 'private owner'), user(4000, `/tmp/sleight-bench/${stamp}/sleight-textedit-save-1/a.txt`)].map(JSON.stringify).join('\n'));
  writeFileSync(join(dir, 'results.json'), JSON.stringify({ stamp, results: [{ arm: 'sleight', task: 'textedit-save', run: 1, timing: { totalMs: 5000 } }] }));
  const out = spawnSync(process.execPath, ['bench/turn-study.mjs', '--results', join(dir, 'results.json'), '--projects', join(dir, 'projects'), '--json', join(dir, 'out.json'), '--table', join(dir, 'out.md')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout.includes('private owner'), false);
  assert.equal(out.stdout.includes('1 transcripts'), true);
});

test('save waits and menu clicks accept the engine string and numeric argument forms', () => {
  assert.ok(analyze(pair('await app.pressKey("super+s"); await app.waitFor({label:"Save"})')).calls[0].classes.includes('wait-after-save'));
  const r = analyze([...pair('await app.getAXState()', '1 menu bar\n 49 Format'),
    call('b', 4000, 'await app.click(49)'), result('b', 5000, '50 menu Format\n 51 Make Plain Text'),
    call('c', 6000, 'await app.click(51)'), result('c', 7000, 'ok')]);
  assert.ok(r.calls[2].classes.includes('split-menu-click'));
});
test('matches exact numeric usage fingerprints when neither a path nor trace code survives', () => {
  assert.equal(typeof api.matchRun, 'function');
  const rows = [user(), { type: 'cost-state', modelUsage: { model: { inputTokens: 6, outputTokens: 994, cacheReadInputTokens: 80212, cacheCreationInputTokens: 47650 } } }];
  const run = { usage: { input: 6, output: 994, cacheRead: 80212, cacheWrite: 47650 } };
  assert.equal(api.matchRun(rows, [run]).status, 'usage');
  assert.equal(api.matchRun(rows, [run, { ...run }]).status, 'ambiguous');
});
test('time ranges cut off an unfinished result and retain result rows whose transcripts are absent', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-study-range-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'projects/p'), { recursive: true });
  const stamp = '2026-10-10T00-00-00-000Z';
  writeFileSync(join(dir, 'projects/p/session.jsonl'), [user(0, `/tmp/sleight-bench/${stamp}/sleight-textedit-save-1/a.txt`), call('a', 1000, 'app'), result('a', 4000, 'late')].map(JSON.stringify).join('\n'));
  writeFileSync(join(dir, 'results.json'), JSON.stringify({ stamp, results: [1, 2].map(run => ({ arm: 'sleight', task: 'textedit-save', run })) }));
  const out = spawnSync(process.execPath, ['bench/turn-study.mjs', '--since', at(0), '--until', at(3000), '--results-dir', dir, '--projects', join(dir, 'projects'), '--json', join(dir, 'out.json')], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const data = JSON.parse(readFileSync(join(dir, 'out.json')));
  assert.equal(data.runs[0].calls[0].wallMs, null);
  assert.equal(data.unmatchedResults.length, 1);
  assert.equal(data.unmatchedResults[0].run, 2);
});
