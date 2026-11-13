import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { callClass, resultKinds, runAnatomy, sumRuns } from '../bench/fowl/anatomy.mjs';

test('anatomy splits a result into doc sections, trees and the rest', () => {
  const k = resultKinds('## Computer Use\nuse js\n# API Reference\nx\nBrowser tab: 1, Title: "a"\n1 button Go\n\nRESULT ok');
  assert.ok(k.docs['Computer Use'] > 0);
  assert.ok(k.docs['API Reference'] > 0);
  assert.ok(k.tree > 0);
  assert.equal(k.other, '\nRESULT ok\n'.length);
});

test('anatomy classes calls by what their code does, and per-intent tools by name', () => {
  assert.equal(callClass('mcp__plugin_sleight_computer__js', { code: 'await tab.click(3); nodeRepl.write(await tab.getAXState())' }), 'action+read');
  assert.equal(callClass('mcp__plugin_sleight_computer__js', { code: 'await tab.click(3)' }), 'action');
  assert.equal(callClass('mcp__plugin_sleight_computer__js', { code: 'nodeRepl.write(await tab.getAXState())' }), 'read');
  assert.equal(callClass('mcp__plugin_sleight_computer__js', { code: "let b = await cua.getBrowser({ extensionInstanceId: 'x' })" }), 'setup');
  assert.equal(callClass('ToolSearch', { query: 'select:x' }), 'toolsearch');
  assert.equal(callClass('mcp__fowlbrowser__snapshot', {}), 'read');
  assert.equal(callClass('mcp__fowlbrowser__click', {}), 'action+read');
});

test('anatomy counts turns once per message and flags a read after a read and a call after an error', () => {
  const msg = (id, t, content, usage = {}) => ({ type: 'assistant', t, message: { id, content, usage } });
  const res = (t, id, text, isError = false) => ({ type: 'user', t, message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });
  const use = (id, code) => ({ type: 'tool_use', id, name: 'mcp__plugin_sleight_computer__js', input: { code } });
  const r = runAnatomy([
    { type: 'system', subtype: 'init', t: 0 },
    msg('m1', 1000, [use('a', 'await tab.click(1)')], { cache_creation_input_tokens: 10 }),
    res(1500, 'a', 'boom', true),
    msg('m2', 2500, [use('b', 'nodeRepl.write(await tab.getAXState())')]),
    res(2600, 'b', 'Browser tab: 1\n1 button'),
    msg('m3', 3000, [use('c', 'nodeRepl.write(await tab.title())')]),
    res(3100, 'c', 'ok'),
    msg('m4', 4000, [{ type: 'text', text: 'done' }]),
    { type: 'result', t: 4100, duration_ms: 4100, total_cost_usd: 0.01 },
  ]);
  assert.equal(r.turns, 4);
  assert.equal(r.calls, 3);
  assert.equal(r.errors, 1);
  assert.equal(r.avoidable.afterError, 1);
  assert.equal(r.avoidable.readAfterRead, 1);
  assert.equal(r.startMs, 1000);
  assert.equal(r.toolMs, 700);
  assert.equal(r.provisionalUsage.cacheWrite, 10);
});

test('char audit separates sleight skill and notices from the engine docs and the tree', async () => {
  const { auditKinds } = await import('../bench/char-audit.mjs');
  const k = auditKinds('## Computer Use\nengine text\n# Driving Mac apps with sleight\nskill line\nBrowser tab: 1, Title: "a"\n1 button Go\n\nsleight: a notice\nRESULT ok');
  assert.ok(k.docs > 0);
  assert.equal(k.skill, '# Driving Mac apps with sleight\nskill line'.length);
  assert.ok(k.tree > 0);
  assert.equal(k.notice, 'sleight: a notice\n'.length);
});

const assistant = (id, t, content, cacheRead = 0) => ({ type: 'assistant', t,
  message: { id, content, usage: { cache_read_input_tokens: cacheRead } } });
const use = (id) => ({ type: 'tool_use', id, name: 'mcp__fowlbrowser__click', input: {} });
const result = (id, t) => ({ type: 'user', t,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

test('timing reconciles emitted blocks and separate duration clocks without inventing request timing', () => {
  const r = runAnatomy([
    { type: 'system', subtype: 'init', t: 100 },
    assistant('a', 1100, [{ type: 'thinking', thinking: 'hmm' }], 100),
    assistant('a', 1400, [use('one')], 100), result('one', 1600),
    { type: 'system', subtype: 'thinking_tokens', t: 1800 },
    assistant('b', 2100, [{ type: 'thinking', thinking: 'hmm' }], 200),
    assistant('b', 2400, [{ type: 'text', text: 'done' }], 200),
    { type: 'result', t: 2500, duration_ms: 2300 },
  ]);
  assert.deepEqual(r.timing, { eventWallMs: 2400, startupMs: 1000, waitingMs: 500,
    blockEmissionMs: 600, toolMs: 200, tailMs: 100, unclassifiedMs: 0,
    durationDeltaMs: -100, toolOverlapMs: 0 });
  assert.equal(r.wallMs - r.startMs - r.modelMs - r.toolMs, 600);
  assert.deepEqual(r.turnTimings.map((t) => [t.waitingMs, t.blockEmissionMs, t.cacheRead]),
    [[null, 300, 100], [500, 300, 200]]);
  assert.equal(r.turnTimings[1].firstProgressAfterResultMs, 200);
  assert.equal(r.turnTimings[1].requestOverheadMs, null);
  assert.equal(r.turnTimings[1].ttftMs, null);
  assert.equal(r.turnTimings[1].streamingMs, null);
  assert.equal(sumRuns([r, r]).timing.blockEmissionMs, 1200);
  assert.equal(sumRuns([r, r]).turnTimings, undefined);
});

test('timing unions parallel calls and assigns overlapping block emission to the tool interval', () => {
  const r = runAnatomy([
    { type: 'system', subtype: 'init', t: 0 },
    assistant('a', 100, [use('one')]), assistant('a', 200, [use('two')]),
    result('one', 500), result('two', 600),
    assistant('b', 800, [{ type: 'text', text: 'done' }]),
    { type: 'result', t: 900, duration_ms: 900 },
  ]);
  assert.equal(r.toolMs, 800);
  assert.equal(r.timing.toolMs, 500);
  assert.equal(r.timing.toolOverlapMs, 300);
  assert.equal(r.timing.blockEmissionMs, 0);
  assert.equal(r.timing.waitingMs, 200);
  assert.equal(r.turnTimings[1].waitingMs, 200);
  assert.equal(r.turnTimings[0].blockEmissionMs, 100);
  const { eventWallMs, durationDeltaMs, toolOverlapMs, ...parts } = r.timing;
  assert.equal(Object.values(parts).reduce((a, b) => a + b, 0), eventWallMs);
});

test('timing preserves consecutive model messages, ignores duplicate calls, and tolerates missing results', () => {
  const call = assistant('a', 100, [use('one')]);
  const r = runAnatomy([{ type: 'system', t: 0 }, call, call,
    result('one', 200), assistant('b', 300, [{ type: 'text', text: 'more' }]),
    assistant('c', 500, [{ type: 'text', text: 'done' }])]);
  assert.equal(r.timing.eventWallMs, 500);
  assert.equal(r.turnTimings[2].waitingMs, 200);
  assert.equal(r.turnTimings[2].afterToolResult, false);
  assert.equal(r.timing.toolMs, 100);
  assert.equal(r.timing.waitingMs, 300);
  assert.equal(runAnatomy([]).timing.eventWallMs, 0);
});

test('offline CLI prints per-turn observations and serializes null request timing', () => {
  const dir = trackTemp(fs.mkdtempSync(path.join(os.tmpdir(), 'sleight-anatomy-')));
  try {
    fs.mkdirSync(path.join(dir, 'task'));
    fs.writeFileSync(path.join(dir, 'task', 'events.jsonl'), [
      { type: 'system', t: 0 }, assistant('one', 100, [{ type: 'text', text: 'done' }], 123),
      { type: 'result', t: 200, duration_ms: 200 },
    ].map((e) => JSON.stringify(e)).join('\n'));
    const cli = new URL('../bench/fowl/anatomy.mjs', import.meta.url);
    const args = [cli.pathname, dir];
    const printed = spawnSync(process.execPath, [...args, '--turns'], { encoding: 'utf8' });
    assert.equal(printed.status, 0, printed.stderr);
    assert.match(printed.stdout, /event clock:/);
    assert.match(printed.stdout, /completed assistant-block intervals/);
    assert.match(printed.stdout, /final tokens \(0 runs with usage, 1 missing\).*output unavailable/);
    assert.match(printed.stdout, /provisional first-block tokens:.*cache read 123/);
    assert.match(printed.stdout, /task turn 1: wait initial, completed-block interval 0 ms, cache read 123/);
    assert.match(printed.stdout, /TTFT\/request overhead\/streaming unavailable/);
    const json = spawnSync(process.execPath, [...args, '--json'], { encoding: 'utf8' });
    assert.equal(json.status, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout)[path.basename(dir)].task.turnTimings[0].ttftMs, null);
  } finally { removeTemp(dir); }
});


test('final usage replaces provisional first-block counts without double-counting repeated messages', () => {
  const block = (id, t, output) => ({ type: 'assistant', t,
    message: { id, content: [], usage: { input_tokens: 2, output_tokens: output,
      cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } } });
  const r = runAnatomy([
    { type: 'system', t: 0 }, block('a', 10, 1), block('a', 20, 30),
    block('b', 30, 4), block('b', 40, 60),
    { type: 'result', t: 50, duration_ms: 50, usage: { input_tokens: 20,
      cache_creation_input_tokens: 30, cache_read_input_tokens: 40, output_tokens: 90,
      output_tokens_details: { thinking_tokens: 30 } } },
  ]);
  assert.equal(r.turns, 2);
  assert.deepEqual(r.usage, { input: 20, cacheWrite: 30, cacheRead: 40, output: 90, thinking: 30 });
  assert.deepEqual(r.provisionalUsage, { input: 4, cacheWrite: 6, cacheRead: 8, output: 5 });
  assert.deepEqual(r.usageCoverage, { finalRuns: 1, missingFinalRuns: 0 });
  assert.equal(sumRuns([r, r]).usage.output, 180);
});

test('missing final usage and missing thinking detail remain unknown in run and round totals', () => {
  const incomplete = runAnatomy([assistant('a', 10, [], 123)]);
  assert.deepEqual(incomplete.usage, { input: null, cacheWrite: null, cacheRead: null, output: null, thinking: null });
  assert.equal(incomplete.provisionalUsage.cacheRead, 123);
  assert.deepEqual(incomplete.usageCoverage, { finalRuns: 0, missingFinalRuns: 1 });
  const complete = runAnatomy([{ type: 'result', t: 10, usage: { output_tokens: 0 } }]);
  assert.equal(complete.usage.output, 0);
  assert.equal(complete.usage.thinking, null);
  for (const runs of [[complete, incomplete], [incomplete, complete]]) {
    assert.equal(sumRuns(runs).usage.output, null);
    assert.deepEqual(sumRuns(runs).usageCoverage, { finalRuns: 1, missingFinalRuns: 1 });
  }
});
