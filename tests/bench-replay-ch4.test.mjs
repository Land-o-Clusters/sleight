import { packageSkip } from './requirements.mjs';
const parserSkip = packageSkip('typescript');
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { loadCheck, main } from '../bench/replay/run.mjs';
import { loadRecording } from '../bench/replay/recording.mjs';
import { auditRecording } from '../bench/replay/audit.mjs';
import { checkEvidence, campaignEvidence } from '../bench/replay/checks.mjs';
import { TargetMapper } from '../bench/replay/mapping.mjs';

const spec = loadCheck('CH4');
const text = value => ({ content: [{ type: 'text', text: value }] });
const call = (toolMs = 100) => ({ index: 0, name: 'drag', recordedArguments: {}, toolMs, result: text('moved'), comparisonResult: text('moved') });
const run = (variant, iteration, ms) => ({ variant, iteration, calls: [call(ms)], verdict: 'pass', cleanupConfirmed: true,
  check: { verdict: 'pass' } });
const roles = { candidate: 'B', baseline: 'A' };

test('CH4 fixes the worktree comparison and strict five-percent per-drag median bar', () => {
  assert.equal(spec.tool, 'drag'); assert.equal(spec.comparison, 'worktrees'); assert.equal(spec.toolRatioBelow, 1.05);
  assert.match(spec.assertion, /placed receipt/);
  const runs = [run('A', 1, 90), run('B', 1, 100), run('A', 2, 110), run('B', 2, 109.8)];
  assert.equal(campaignEvidence(runs, spec, roles).verdict, 'pass');
  runs[3].calls[0].toolMs = 110;
  const failed = campaignEvidence(runs, spec, roles);
  assert.equal(failed.timing[0].ratio, 1.05); assert.equal(failed.timing[0].verdict, 'fail');
  assert.equal(failed.verdict, 'check-incomplete');
});

test('CH4 requires every iteration and target, fixture success and confirmed cleanup', () => {
  const base = [run('A', 1, 100), run('B', 1, 100)];
  assert.equal(checkEvidence(spec, { calls: [call()], lifecycle: { taskPassed: true } }).verdict, 'pass');
  assert.equal(checkEvidence(spec, { calls: [call()], lifecycle: { taskPassed: false } }).verdict, 'fail');
  for (const mutate of [r => { r[1].cleanupConfirmed = false; }, r => { r[1].verdict = 'diverge'; },
    r => { r[1].calls = []; }, r => { r.push(run('B', 2, 100)); }, r => { r[1].check.verdict = 'inconclusive'; }]) {
    const runs = structuredClone(base); mutate(runs);
    assert.notEqual(campaignEvidence(runs, spec, roles).verdict, 'pass');
  }
});

test('retained chv1b text slices preserve text offsets while unsupported UI numbers still refuse', { skip: parserSkip }, () => {
  const mapper = new TargetMapper();
  for (const code of ['nodeRepl.write(JSON.stringify(await app.getAXState()).slice(0, 800));',
    'const state = await app.getAXState(); nodeRepl.write(state.slice(0, 900));',
    'const state = JSON.stringify(await app.getAXState()); nodeRepl.write(state.slice(0, 900));']) assert.equal(mapper.code(code), code);
  for (const code of ['app.slice(0, 800)', 'app.unknown(1)', 'const state = app; state.slice(0, 800)',
    'let state = await app.getAXState(); state = app; state.slice(0, 800)',
    'const state = await app.getAXState(); function f(state) { state.slice(0, 800); }',
    'const JSON = app; JSON.stringify("x").slice(0, 800)', 'nodeRepl.write("text".slice(app.element(1), 800))'])
    assert.throws(() => mapper.code(code), /numeric|unsupported|Computed/);
});

function fixture(t) {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-ch4-recording-')));
  mkdirSync(join(root, 'evidence'));
  writeFileSync(join(root, 'bench-result.json'), JSON.stringify({ schema: 'sleight.check4-bench-result/1', row: {
    task: 'textedit-drag', arm: 'sleight', run: 1, passed: true } }));
  const calls = [{ id: 'open', name: 'open_file', arguments: { app: 'com.apple.TextEdit', path: '/fixture/sleight-bench/stamp/task/1234abcd-drag.txt' }, result: text('Opened') },
    { id: 'drag', name: 'drag', arguments: { app: 'com.apple.TextEdit', from: 'the current text selection', to: 'end of line 1' }, result: text('moved') }];
  writeFileSync(join(root, 'evidence/transcript.jsonl'), calls.flatMap(c => [
    { message: { content: [{ type: 'tool_use', id: c.id, name: `mcp__plugin_sleight_computer__${c.name}`, input: c.arguments }] } },
    { message: { content: [{ type: 'tool_result', tool_use_id: c.id, content: c.result.content }] } },
  ]).map(JSON.stringify).join('\n'));
  return root;
}

test('check 4 task folders load their row envelope and nested transcript and feed back all calls', async t => {
  const root = fixture(t), recording = loadRecording(join(root, 'bench-result.json'), { task: 'textedit-drag', arm: 'sleight', run: 1 });
  assert.equal(recording.task.id, 'textedit-drag'); assert.equal(recording.calls.length, 2);
  assert.equal((await auditRecording(recording)).verdict, 'pass');
});

test('CH4 two-iteration dry plan alternates the distinct worktrees without starting a live iteration', async t => {
  const root = fixture(t), builds = [];
  const plan = await main([join(root, 'bench-result.json'), '--check', 'CH4', '--old-worktree', '/fixture/old', '--new-worktree', '/fixture/new', '--repeat', '2', '--plan'], {
    identifyBuild: (worktree, label) => { builds.push(label); return { worktree, label, commit: label }; },
    iteration: () => assert.fail('dry plan launched a live iteration'), acquireLock: () => assert.fail('dry plan took a live lock'),
  });
  assert.deepEqual(builds, ['old', 'new']); assert.equal(plan.model, false);
  assert.deepEqual(plan.schedule.map(s => [s.variant, s.iteration]), [['A', 1], ['B', 1], ['A', 2], ['B', 2]]);
  await assert.rejects(main([join(root, 'bench-result.json'), '--check', 'CH4', '--plan']), /requires --old-worktree/);
});
