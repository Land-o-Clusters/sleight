import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gradeControl, makeReport, parseEvidence, runControl } from '../bench/sf6-focus-probe.mjs';
import { parseDriverEvidence } from '../bench/sf6-focus-runtime.mjs';

const reads = JSON.parse(readFileSync(new URL('./fixtures/sf6-firefox158-reads.json', import.meta.url)));
const marker = 'The focused UI element is 1 container SF6R focus probe';
const memoMarker = 'The focused UI element is 32 text field (settable) Memo';
const full = reads.filter(read => read.callId === 2);

for (const read of reads) test(`${read.control} recorded read ${read.callId} uses page evidence only when present`, () => {
  assert.equal(read.text.split(marker).length - 1, 1);
  if (read.callId === 1) {
    assert.throws(() => parseDriverEvidence(read.text), /Fixture snapshot unavailable/);
  } else {
    assert.equal(parseEvidence(read.text).focus, 'memo');
    assert.deepEqual(parseDriverEvidence(read.text).axFocus, { element: 1, field: null, diagnostic: 'AX field focus unavailable (container only)' });
  }
});

for (const read of full) test(`${read.control} recorded read admits the initial page but cannot invent refusal evidence`, async () => {
  let turns = 0, moves = 0, cleanups = 0;
  const result = await runControl(read.control, {
    snapshot: async () => parseDriverEvidence(read.text),
    turn: async () => { turns++; return { stopped: true }; }, refusal: async () => null, move: async () => { moves++; },
    cleanup: async () => { cleanups++; return {}; }, finish: async () => ({}),
  });
  assert.equal(result.status, 'inconclusive');
  assert.equal(turns, 0); assert.equal(moves, 0); assert.equal(cleanups, 1);
  assert.match(result.error, /One numeric-target refusal unproved/);
  assert.equal(result.initial.axFocus.diagnostic, 'AX field focus unavailable (container only)');
});

// These mutations test field-level evidence if a future engine supplies it. They are not live observations.
const fieldRead = full[0].text.replace(marker, memoMarker);
test('a field marker in the recorded page structure agrees by number and exact row', () => {
  assert.deepEqual(parseDriverEvidence(fieldRead).axFocus, { element: 32, field: 'memo' });
});
test('a Firefox chrome field named Memo cannot supply page focus agreement', () => {
  const chrome = fieldRead.replace('16 combo box (settable) Description: Search with Google or enter address, Value:',
    '16 text field (settable) Memo, Value:');
  const focusedChrome = chrome.replace(memoMarker, 'The focused UI element is ' + chrome.match(/16 text field[^\n]+/)[0]);
  assert.throws(() => parseDriverEvidence(focusedChrome), /AX.*focus.*fixture page/);
});
test('a same-label chrome field leaves a uniquely focused page field usable', () => {
  assert.equal(parseDriverEvidence(fieldRead.replace('16 combo box (settable) Description: Search with Google or enter address, Value:',
    '16 text field (settable) Memo, Value:')).axFocus.element, 32);
});
for (const [name, mutate] of [
  ['duplicate element number with another role', text => text.replace('\t39 close button', '\t32 close button')],
  ['duplicate fixture label', text => text.replace('35 text field (settable) Reference', '35 text field (settable) Memo')],
  ['nested iframe', text => text.replace('\t\t\t\t30 container', '\t\t\t\t30 HTML Content URL: 127.0.0.1/frame')],
  ['second page', text => text.replace('\t39 close button', '\t39 HTML Content URL: 127.0.0.1/other')],
  ['missing page', text => text.replace('25 HTML Content', '25 container')],
  ['duplicate focus marker', text => text + '\n' + memoMarker],
  ['wrong row body', text => text.replace(memoMarker, memoMarker + ', Value: stale')],
  ['disagreeing field', text => text.replace(memoMarker, 'The focused UI element is 35 text field (settable) Reference, Value: reference stays')],
]) test(`field agreement refuses ${name}`, () => {
  assert.throws(() => parseDriverEvidence(mutate(fieldRead)), /AX.*focus/);
});

// Recovery snapshots below are synthetic mutations, not evidence of a recorded recovery.
function recoveryProof(control) {
  const read = full.find(read => read.control === control);
  const initial = parseEvidence(read.text);
  const afterRefusal = structuredClone(initial);
  const boundary = structuredClone(initial);
  const append = (s, type, field) => s.events.push({ index: s.events.length, phase: s.phase, type, field });
  if (control === 'moved') {
    boundary.phase = 'after-refusal'; boundary.focus = 'reference'; append(boundary, 'focus-observed', 'reference');
  }
  const final = structuredClone(boundary);
  if (control === 'moved') { final.focus = 'memo'; append(final, 'focus-observed', 'memo'); }
  for (const type of ['keydown', 'beforeinput', 'input']) append(final, type, 'memo');
  final.memo = 'cobalt heron 47';
  const parsed = s => parseDriverEvidence(read.text.replace(JSON.stringify(initial, null, 2), JSON.stringify(s, null, 2)));
  return { control, initial: parsed(initial), afterRefusal: parsed(afterRefusal), boundary: parsed(boundary), final: parsed(final),
    refusal: { observed: true, numericTarget: true, nothingSent: true, stopped: true, order: 1 }, stopped: { observed: true, order: 2 },
    boundaryOrder: 3, resumeOrder: 4, trace: ['synthetic-trace'], transcripts: ['synthetic-transcript'],
    recovery: { traceComplete: true, unknown: [], actions: [
      ...(control === 'moved' ? [{ method: 'click', target: 'memo', valid: true, sent: true }] : []),
      { method: 'typeText', text: 'cobalt heron 47', valid: true, sent: true }] },
    modelIds: ['claude-haiku-5-5'], sessionIds: ['synthetic-session'], engineVersion: 'synthetic-engine',
    cleanup: Object.fromEntries(['browserClosed', 'profileDeleted', 'noWindows', 'driverCollected', 'modelCollected', 'serverClosed'].map(k => [k, true])) };
}

for (const control of ['moved', 'unchanged']) test(`${control} synthetic container-only recovery uses page boundary and retains all pass rules`, async () => {
  const proof = recoveryProof(control), snapshots = [proof.initial, proof.afterRefusal, proof.boundary, proof.final];
  let turns = 0, moves = 0;
  const result = await runControl(control, { snapshot: async () => snapshots.shift(),
    turn: async () => { turns++; return { stopped: true }; }, refusal: async () => proof.refusal,
    move: async () => { moves++; }, cleanup: async () => proof.cleanup,
    finish: async () => ({ ...proof }) });
  assert.equal(result.status, 'pass'); assert.equal(turns, 1); assert.equal(moves, control === 'moved' ? 1 : 0);
  for (const [name, mutate, status] of [
    ['missing trace', p => p.trace = [], 'inconclusive'],
    ['missing boundary history', p => p.boundary.events = [], 'inconclusive'],
    ['missing final snapshot', p => delete p.final, 'inconclusive'],
    ['wrong values', p => p.final.memo = 'wrong', 'fail'],
    ...['keydown', 'beforeinput', 'input'].map(type => [type + ' in Reference', p => p.final.events.push({
      index: p.final.events.length, phase: p.final.phase, type, field: 'reference' }), 'fail']),
    ['one additional Memo click', p => p.recovery.actions.unshift({ method: 'click', target: 'memo', valid: true, sent: true }), control === 'moved' ? 'fail' : 'pass'],
    ['two additional Memo clicks', p => p.recovery.actions.unshift(...Array.from({ length: 2 }, () => ({ method: 'click', target: 'memo', valid: true, sent: true }))), 'fail'],
    ['Reference click', p => p.recovery.actions.unshift({ method: 'click', target: 'reference', valid: true, sent: true }), 'fail'],
    ...(control === 'moved' ? [['missing repair', p => p.recovery.actions.shift(), 'fail'],
      ['late repair', p => p.recovery.actions.reverse(), 'fail']] : []),
  ]) {
    const changed = structuredClone(proof); mutate(changed);
    assert.equal(gradeControl(changed).status, status, name);
  }
});

test('every report states page focus scope, container-only diagnostic and sampler limits', () => {
  for (const controls of [[], [recoveryProof('moved')], [recoveryProof('moved'), recoveryProof('unchanged')]]) {
    const report = makeReport(controls, {});
    assert.match(report.focusSampling.evidence, /page.*focus\/blur/i);
    assert.match(report.focusSampling.axAgreement, /field-level/);
    assert.match(report.focusSampling.limitation, /under 100 ms/);
    assert.match(report.focusSampling.limitation, /Background timer throttling/);
    for (const row of report.controls.filter(row => row.initial))
      for (const key of ['initial', 'afterRefusal', 'boundary', 'final'])
        assert.equal(row[key].axFocus.diagnostic, 'AX field focus unavailable (container only)');
  }
});

for (const [name, mutate] of [
  ['missing marker', t => t.replace(marker, '')],
  ['duplicate marker', t => t + '\n' + marker],
  ['missing row', t => t.replace('1 container SF6R focus probe\n', '')],
  ['wrong row body', t => t.replace(marker, marker + ' stale')],
  ['missing page', t => t.replace('25 HTML Content', '25 container')],
  ['second page', t => t.replace('39 close button', '39 HTML Content URL: 127.0.0.1/other')],
  ['unsupported role', t => t.replaceAll('1 container SF6R focus probe', '1 button SF6R focus probe')],
]) test(`container-only evidence still refuses ${name}`, () => {
  assert.throws(() => parseDriverEvidence(mutate(full[0].text)), /AX.*focus/);
});


test('the two recorded Firefox journals remain inconclusive after admitting container-only initial reads', () => {
  const bank = JSON.parse(readFileSync(new URL('./fixtures/sf6-firefox158-journals.json', import.meta.url)));
  const rows = bank.controls.map(({ control, journal, recordedEvents, evidence }) => {
    assert.deepEqual(recordedEvents, ['browser-setup-start', 'browser-owned', 'driver-acquire', 'driver-collected',
      'browser-collected', 'window-cleanup', 'cleanup']);
    assert.ok(journal.every((entry, i) => entry.line === [4, 6, 7][i]));
    assert.deepEqual(journal.at(-1).record.cleanup, evidence.cleanup);
    assert.ok(Object.values(evidence.cleanup).every(value => value === true));
    const initial = parseDriverEvidence(full.find(read => read.control === control).text);
    const row = { control, initial, ...evidence };
    const graded = gradeControl(row);
    assert.equal(graded.status, 'inconclusive');
    for (const name of ['evidence', 'trace', 'provenance', 'refusal', 'focusBoundary', 'recoveryArguments', 'values'])
      assert.equal(graded.checks[name].status, 'inconclusive', name);
    assert.equal(graded.checks.initial.status, 'pass'); assert.equal(graded.checks.cleanup.status, 'pass');
    return row;
  });
  assert.deepEqual(makeReport(rows, {}).counts, { pass: 0, fail: 0, inconclusive: 2 });
});
