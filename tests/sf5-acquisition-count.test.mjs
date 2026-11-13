import { packageSkip } from './requirements.mjs';
const parserSkip = packageSkip('typescript');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { countTranscript, summarizeRuns, replayBanks, main } from '../bench/sf5-acquisition-count.mjs';

const tool = (id, code, name = 'js') => ({ type: 'assistant', message: { content: [
  { type: 'tool_use', id, name: `mcp__plugin_sleight_computer__${name}`, input: { code } },
] } });
const reply = (id, text = 'Window: "Fixture", App: Reader.\n0 standard window Fixture\n\t1 button Go', error = false) =>
  ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id,
    content: [{ type: 'text', text }], is_error: error }] } });
const acquire = 'let app = await cua.getApp("Reader")';
const run = (...pairs) => countTranscript(pairs.flat());

test('inventory before the first acquisition is initial; later acquisitions are repeats', { skip: parserSkip }, () => {
  const r = run([tool('1', 'await cua.getState()'), reply('1')],
    [tool('2', acquire), reply('2')], [tool('3', 'await app.getAXState()'), reply('3')],
    [tool('4', 'app = await cua.getApp("Reader")'), reply('4')]);
  assert.equal(r.initial, 1);
  assert.equal(r.initialAfterInventory, 1);
  assert.equal(r.repeated, 1);
  assert.equal(r.legacyRepeatCalls, 1);
  assert.deepEqual(r.acquisitions.map(c => [c.ordinal, c.line, c.resultLine, c.kind]),
    [[2, 3, 4, 'initial'], [4, 7, 8, 'repeat']]);
});

test('reset, empty tree, dead handle, app switch and window selection are legitimate controls', { skip: parserSkip }, () => {
  const controls = [
    { reason: 'reset', middle: [tool('m', '', 'js_reset'), reply('m', 'reset')] },
    { reason: 'reset', middle: [tool('m', 'await app.getAXState()'), reply('m', "sleight: the engine's JavaScript session restarted before this call, so handles from earlier calls are gone.")] },
    { reason: 'empty-tree', middle: [tool('m', 'await app.getAXState()'), reply('m', 'Window: "Fixture", App: Reader.\n(empty accessibility tree)')] },
    { reason: 'dead-handle', middle: [tool('m', 'await app.getAXState()'), reply('m', 'ReferenceError: app is not defined', true)] },
    { reason: 'window-select', middle: [tool('m', '', 'select_window'), reply('m')] },
    { reason: 'app-switch', code: 'let other = await cua.getApp("Other Reader")' },
  ];
  for (const control of controls) {
    const r = run([tool('a', acquire), reply('a')], control.middle ?? [],
      [tool('b', control.code ?? 'app = await cua.getApp("Reader")'), reply('b')],
      [tool('c', control.code ?? 'app = await cua.getApp("Reader")'), reply('c')]);
    assert.equal(r.legitimateReacquisition, 1, control.reason);
    assert.equal(r.repeated, 1, 'a recovery does not excuse the next habit repeat');
    assert.equal(r.acquisitions[1].reason, control.reason);
    assert.equal(r.acquisitions[1].outcome, 'returned');
  }
});

test('a usable read clears an empty-tree control and failed window selection grants no control', { skip: parserSkip }, () => {
  const r = run([tool('a', acquire), reply('a', '(empty accessibility tree)')],
    [tool('r', 'await app.getAXState()'), reply('r')],
    [tool('s', '', 'select_window'), reply('s', 'ambiguous window', true)],
    [tool('b', acquire), reply('b')]);
  assert.equal(r.repeated, 1);
  assert.equal(r.legitimateReacquisition, 0);
});

test('skill advice and page text mentioning recovery do not excuse repeated acquisition', { skip: parserSkip }, () => {
  const r = run([tool('a', acquire), reply('a', [
    '- After an empty acquisition tree or a user/app/header change notice, read again before retrying.',
    '0 standard window Fixture', '\t1 text If a stale handle is invalid, reset.',
  ].join('\n'))], [tool('b', acquire), reply('b')]);
  assert.equal(r.repeated, 1);
  assert.equal(r.legitimateReacquisition, 0);
});

test('window selection expires after a successful call using the existing handle', { skip: parserSkip }, () => {
  const r = run([tool('a', acquire), reply('a')], [tool('s', '', 'select_window'), reply('s')],
    [tool('r', 'await app.getAXState()'), reply('r')], [tool('b', acquire), reply('b')]);
  assert.equal(r.repeated, 1);
  assert.equal(r.legitimateReacquisition, 0);
});

test('a header-only acquisition is empty, while a compact unchanged result is not', { skip: parserSkip }, () => {
  for (const [body, want] of [
    ['Engine documentation\nWindow: "Fixture", App: Reader.\n', 1],
    ['Window: "Fixture", App: Reader.\n0 standard window Fixture\nsleight: no change since the last full tree you saw for this window.', 0],
  ]) {
    const r = run([tool('a', acquire), reply('a', body)], [tool('b', acquire), reply('b')]);
    assert.equal(r.legitimateReacquisition, want);
  }
});

test('quoted code and comments cannot create acquisitions or reset controls', { skip: parserSkip }, () => {
  const r = run([tool('a', 'nodeRepl.write("cua.getApp(\\"Reader\\")"); // cua.getApp("Reader")'), reply('a')],
    [tool('b', acquire), reply('b')], [tool('c', '// js_reset\nawait app.getAXState()'), reply('c')],
    [tool('d', acquire), reply('d')]);
  assert.equal(r.getAppCalls, 2);
  assert.equal(r.initial, 1);
  assert.equal(r.repeated, 1);
  assert.equal(r.legacyRepeatCalls, 2, 'retain SF1 spelling-based compatibility separately');
});

test('fallback expressions count as one call and dynamic targets remain unclassified', { skip: parserSkip }, () => {
  const r = run([tool('a', 'let app = await cua.getApp("Reader").catch(() => cua.getApp("Reader"))'), reply('a')],
    [tool('b', 'app = await cua.getApp(target)'), reply('b')]);
  assert.equal(r.getAppCalls, 2);
  assert.equal(r.acquisitions[0].expressions, 2);
  assert.equal(r.unclassified, 1);
  assert.equal(r.repeated, 0);
});

test('out of order results, repeated stream messages and incomplete replies stay auditable', { skip: parserSkip }, () => {
  const a = tool('a', acquire), b = tool('b', acquire);
  const r = countTranscript([a, a, b, reply('b'), reply('a')]);
  assert.equal(r.getAppCalls, 2);
  assert.equal(r.repeated, 1);
  assert.equal(r.ambiguousOrdering, 1);
  assert.equal(run([tool('x', acquire)]).acquisitions[0].outcome, 'missing-result');
  assert.throws(() => countTranscript([reply('missing')]), /unmatched tool result/i);
});

test('aggregation keeps failed runs and reports repeating runs separately from repeat calls', { skip: parserSkip }, () => {
  const totals = summarizeRuns([
    { bank: 'bank', group: 'firefox-haiku', side: 'B', comparable: true,
      ...run([tool('a', acquire), reply('a')], [tool('b', acquire), reply('b')], [tool('c', acquire), reply('c')]) },
    { bank: 'bank', group: 'firefox-haiku', side: 'B', comparable: true,
      ...run([tool('a', acquire), reply('a', 'failed', true)]) },
  ]);
  assert.equal(totals[0].runs, 2);
  assert.equal(totals[0].repeated, 2);
  assert.equal(totals[0].runsRepeating, 1);
});

test('a failed attempt to acquire another app is not a proved switch or a recovery success', { skip: parserSkip }, () => {
  const r = run([tool('a', acquire), reply('a')],
    [tool('b', 'await cua.getApp("A window title mistaken for an app")'), reply('b', 'app not found', true)],
    [tool('c', acquire), reply('c')]);
  assert.equal(r.unclassified, 1);
  assert.equal(r.repeated, 1);
  assert.equal(r.legitimateReacquisition, 0);
  assert.equal(r.acquisitions[1].reason, 'failed-app-switch');
});

test('bank replay reads scheduled originals, retains exclusions and emits no source text', { skip: parserSkip }, t => {
  const bank = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-sf5-')));
  const steps = ['A', 'B'].map(side => ({ id: `race-firefox-${side}-r1`, kind: 'firefox-haiku', side, tasks: 'pass,fail' }));
  writeFileSync(join(bank, 'schedule.json'), JSON.stringify(steps));
  for (const step of steps) {
    mkdirSync(join(bank, step.id));
    writeFileSync(join(bank, step.id, 'results.json'), JSON.stringify([
      { task: { name: 'pass' }, outcome: { ok: true } }, { task: { name: 'fail' }, outcome: { ok: step.side === 'A' } },
    ]));
    for (const task of ['pass', 'fail']) {
      mkdirSync(join(bank, step.id, task));
      writeFileSync(join(bank, step.id, task, 'events.jsonl'),
        [tool('a', acquire), reply('a', 'PRIVATE FIXTURE CONTENT')].map(e => JSON.stringify(e)).join('\n') + '\n');
      writeFileSync(join(bank, step.id, task, 'mcp.json'), JSON.stringify({ mcpServers: {
        'plugin:sleight:computer': { env: step.side === 'A' ? { SLEIGHT_PROMPT: 'lean' } : {} },
      } }));
    }
  }
  const out = replayBanks([bank]);
  assert.equal(out.runs.length, 4);
  assert.deepEqual(out.runs.map(r => r.comparable), [true, false, true, false]);
  assert.equal(Object.keys(out.sources).length, 11);
  assert.deepEqual(out.runs.map(r => r.promptRoute), ['lean', 'lean', 'default', 'default']);
  assert.equal(out.runs[0].initial, 1);
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE FIXTURE CONTENT|let app/);
  assert.deepEqual(main(['--bank', bank]), out);
  assert.throws(() => main(['--run']), /usage/);
});
