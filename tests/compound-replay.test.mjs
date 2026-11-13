import { packageSkip } from './requirements.mjs';
const parserSkip = packageSkip('typescript');
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessCompoundRecording, parseCompoundRecordedRows, resolveCompoundPrintedSelector, summarizeCompoundReplay } from '../plugins/sleight/lib/mac-driver/compound/replay.mjs';
import { compoundFixture } from './fixtures/compound-runtime.mjs';
import { compoundRecordedClicks, compoundRecordingCandidates, recordedCompoundCalls } from '../scripts/compound-replay.mjs';

const recordings = JSON.parse(readFileSync(new URL('./fixtures/compound-recordings.json', import.meta.url), 'utf8'));
const replay = JSON.parse(readFileSync(new URL('./fixtures/compound-replay-results.json', import.meta.url), 'utf8'));
const printed = '0 standard window Draft\n\t1 menu bar\n\t\t2 menu bar item Edit\n\t3 menu\n\t\t4 menu item Find\n\t\t5 menu item Find';
for (const [name, part, kind] of [
  ['Safari wrapper owner gap', 'dropdown-safari', 'choose'], ['Firefox value-label changes', 'dropdown-firefox', 'choose'],
  ['TextEdit menu-only Find and nested Format', 'notes-table', 'menu'], ['Word nested controls', 'word-memo', 'menu'],
  ['TextEdit save recording without a Save panel', 'textedit-save', 'prepareSaveAs'],
]) test(`recorded production parse retains missing provenance: ${name}`, async () => {
  const rows = recordings.filter(row => row.source.includes(part)); assert.ok(rows.length >= 2);
  const frames = rows.flatMap(row => parseCompoundRecordedRows(row.text)); assert.ok(frames.length > 0);
  assert.ok(frames.some(f => f.nodes.length > 5));
  const r = await assessCompoundRecording({ kind, texts: rows.map(row => row.text) });
  assert.equal(r.unprovable, true); assert.equal(r.mutations, 0); assert.equal(r.eligible, false);
  assert.equal(r.diagnostics.printedTreeRows, frames.reduce((n, f) => n + f.nodes.length, 0));
  assert.ok(r.missing.includes('OWNER_RELATION_MISSING'));
});
test('frozen replay excludes calculator clicks and publishes parsed candidate counts', { skip: parserSkip }, async () => {
  const calculator = '0 standard window Calculator\n\t1 button 7\n\t2 button 2';
  assert.equal(compoundRecordingCandidates([{ code: '', text: calculator },
    { code: 'app.click({label:"7"}); app.click({label:"2"})', text: '' }]).length, 0);
  assert.equal(replay.sessionsRead, 396);
  assert.equal(replay.menu.summary.candidates, 50);
  assert.equal(replay.choose.summary.candidates, 157);
  for (const group of [replay.menu, replay.choose]) {
    assert.deepEqual(summarizeCompoundReplay(group.rows), group.summary);
    assert.ok(group.rows.every(row => row.stoppedBeforeFirstInput && row.incomplete && row.unprovable && row.mutations === 0));
    assert.ok(group.rows.some(row => row.diagnostics.printedTreeRows > 0));
    assert.ok(group.rows.every(row => !row.source.includes('calculator-click')));
  }
  assert.equal(replay.savePanels.length, 0);
});
test('production scoped resolver detects true rendered ambiguity, including disabled twins', async () => {
  const intent = { operation: 'menu', segments: ['Edit', 'Find'] };
  const r = await assessCompoundRecording({ kind: 'menu', intent, texts: [printed] });
  assert.equal(r.ambiguous, true); assert.equal(r.reason, 'AMBIGUOUS_STEP');
  const [frame] = parseCompoundRecordedRows(printed.replace('5 menu item Find', '5 menu item (disabled) Find'));
  assert.equal(resolveCompoundPrintedSelector(frame, { source: 'title', label: 'Find' }, ['AXMenuItem']).status, 'ambiguous');
});
test('same labels in separate printed menus remain separate domains', async () => {
  const [frame] = parseCompoundRecordedRows(printed.replace('\t\t5 menu item Find', '\t5 menu\n\t\t6 menu item Find'));
  assert.equal(resolveCompoundPrintedSelector(frame, { source: 'title', label: 'Find' }, ['AXMenuItem'], 'printed-0-3').status, 'unique');
});
test('raw-looking recording objects are validated by the production observation guard', async () => {
  const h = compoundFixture(); const raw = structuredClone(h.snapshot); raw.readId = 2; raw.complete = false;
  const r = await assessCompoundRecording({ kind: 'menu', texts: [printed], intent: h.intent, rawObservations: [raw] });
  assert.ok(r.missing.includes('OBSERVATION_INCOMPLETE')); assert.equal(r.eligible, false);
});
test('candidate parser reads literal call syntax without executing strings comments or computed labels', { skip: parserSkip }, async () => {
  const calls = compoundRecordedClicks('/* app.click({label:"Fake"}) */ app.click({label:"Edit"}); app.click({label:"Find"}); app.click({label:x}); "app.click({label:123})";');
  assert.deepEqual(calls, [{ label: 'Edit' }, { label: 'Find' }]);
});
test('candidate filter accepts a menu path and rejects equal calculator button labels', { skip: parserSkip }, async () => {
  const code = 'app.click({label:"Edit"}); app.click({label:"Find"})';
  const uniqueMenu = printed.replace('\n\t\t5 menu item Find', '');
  assert.equal(compoundRecordingCandidates([{ code: '', text: uniqueMenu }, { code, text: '' }]).filter(x => x.kind === 'menu').length, 1);
  const buttons = uniqueMenu.replace('menu bar item Edit', 'button Edit').replace('menu item Find', 'button Find');
  assert.equal(compoundRecordingCandidates([{ code: '', text: buttons }, { code, text: '' }]).length, 0);
});
test('dropdown extraction binds numeric clicks to an actually printed popup', { skip: parserSkip }, async () => {
  const tree = '0 standard window Draft\n\t1 pop up button Region\n\t2 button 7';
  assert.equal(compoundRecordingCandidates([{ code: '', text: tree }, { code: 'app.click(1)', text: '' }])[0].kind, 'choose');
  assert.equal(compoundRecordingCandidates([{ code: '', text: tree }, { code: 'app.click(2)', text: '' }]).length, 0);
});
test('recorded calls retain JSONL coordinates and parse results as data', { skip: parserSkip }, async () => {
  const transcript = [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__plugin_sleight_computer__js',
    input: { code: 'throw new Error("never execute"); app.click({label:"Edit"}); app.click({label:"Find"})' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: printed.replace('\n\t\t5 menu item Find', '') }] }] } }]
    .map(x => JSON.stringify(x)).join('\n');
  const calls = recordedCompoundCalls(transcript); assert.equal(calls[0].line, 1); assert.equal(calls[0].resultLine, 2);
  assert.equal(compoundRecordingCandidates(calls)[0].kind, 'menu');
});

test('native replay derives completed and stopped-after-prefix outcomes through production parent and helper', async () => {
  for (const stop of [false, true]) {
    const h = compoundFixture();
    const raw = structuredClone(h.snapshot); raw.readId = 2;
    if (stop) h.on('admit', x => { x.auth.approved = false; }, 2);
    const r = await assessCompoundRecording({ kind: 'menu', intent: h.intent, texts: ['0 standard window Draft'], rawObservations: [raw] }, {
      fake: true, binding: raw.binding, admission: h.admission, provider: h.provider, contracts: h.contracts,
      reservation: h.reservation, now: () => h.time,
    });
    assert.equal(r.eligible, true); assert.equal(r.completed, !stop); assert.equal(r.stoppedAfterPrefix, stop);
    assert.equal(r.stoppedBeforeFirstInput, false); assert.equal(r.mutations, stop ? 1 : 3);
  }
});

test('candidate selection retains ambiguous paths before replay counts them', { skip: parserSkip }, async () => {
  const calls = [{ code: '', text: printed }, { code: 'app.click({label:"Edit"}); app.click({label:"Find"})', text: '' }];
  const candidates = compoundRecordingCandidates(calls);
  assert.equal(candidates.length, 1);
  const rows = await Promise.all(candidates.map(c => assessCompoundRecording({ ...c, kind: c.kind })));
  assert.equal(summarizeCompoundReplay(rows).ambiguous, 1);
  assert.equal(rows[0].diagnostics.parsedSteps, 1);
  assert.equal(rows[0].eligible, false);
});
