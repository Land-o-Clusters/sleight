import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gradeControl, traceCalls } from '../bench/sf6-focus-probe.mjs';
import { ownedFixtureObservation, parseDriverEvidence, traceMatchesTranscript } from '../bench/sf6-focus-runtime.mjs';

// Run 6 text replies and call order, with instruction blocks and image bytes omitted.
const recorded = JSON.parse(readFileSync(new URL('./fixtures/sf6-run6.json', import.meta.url)));
const textOf = reply => reply.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
const recovery = record => {
  const audit = traceCalls(record.trace);
  const refusal = audit.refusals[0];
  return { traceComplete: audit.complete && traceMatchesTranscript(record.transcript, record.trace),
    unknown: audit.unknown, actions: audit.actions.filter(a => a.order > refusal.order) };
};

for (const [control, record] of Object.entries(recorded)) {
  test(`run 6 ${control}: final full AX read has a 512-character evidence prefix on the owned page`, () => {
    const text = textOf(record.finalRead);
    const url = text.match(/HTML Content[^\n]+URL: ([^\s]+)/)[1];
    assert.equal(record.finalRead.isError, false);
    assert.equal(ownedFixtureObservation(text, 'http://' + url), true);
    const evidence = text.slice(text.indexOf('38 text {') + '38 text '.length, text.indexOf('\n\t39 close'));
    assert.equal(evidence.length, 512);
    assert.throws(() => JSON.parse(evidence), SyntaxError);
    assert.match(text, /text field \(settable\) Memo, Value: cobalt heron 47/);
    assert.match(text, /text field \(settable\) Reference, Value: reference stays/);
    assert.throws(() => parseDriverEvidence(text), /Fixture snapshot unavailable/);
  });

  test(`run 6 ${control}: offline regrade preserves the three missing-final checks`, () => {
    const recovered = recovery(record);
    assert.equal(recovered.traceComplete, true);
    assert.deepEqual(recovered.unknown, []);
    assert.deepEqual(recovered.actions.map(a => [a.method, a.target]),
      [['click', 'memo'], [control === 'moved' ? 'typeText' : 'setValue', control === 'moved' ? undefined : 'memo']]);
    const graded = gradeControl({ ...record.row, recovery: recovered });
    assert.equal(graded.status, 'inconclusive');
    for (const [name, check] of Object.entries(graded.checks))
      assert.equal(check.status, ['evidence', 'values', 'inputTargets'].includes(name) ? 'inconclusive' : 'pass', name);
    assert.equal(Object.values(graded.checks).filter(c => c.status === 'pass').length, 9);
    if (control === 'unchanged') assert.deepEqual(graded.speedNotes, ['1 redundant Memo click']);
  });
}

function alterCode(from, to) {
  const trace = structuredClone(recorded.unchanged.trace);
  const entry = trace.find(e => e.direction === 'call-received' && e.msg.params?.code === from);
  assert.ok(entry, from); entry.msg.params.code = to;
  return trace;
}
const screenshot = 'nodeRepl.emitImage(await app.getScreenshot());';
for (const code of ['nodeRepl.emitImage(await other.getScreenshot());', 'await app.getScreenshot();',
  'nodeRepl.emitImage(await app.getScreenshot({window: 2}));', screenshot + ' app = other;',
  'nodeRepl.emitImage(await app.getScreenshot()); unknown.run();'])
  test(`screenshot read remains unknown outside its exact bound expression: ${code}`, () => {
    assert.ok(traceCalls(alterCode(screenshot, code)).unknown.length > 0);
  });

const setValue = 'await app.setValue(32, "cobalt heron 47");';
for (const target of ['32', '{label:"Memo"}', '{id:"memo"}']) test(`setValue binds its literal target ${target}`, () => {
  const audit = traceCalls(alterCode(setValue, `await app.setValue(${target}, "cobalt heron 47");`));
  assert.deepEqual(audit.unknown, []);
  assert.equal(audit.actions.at(-1).target, 'memo');
  assert.equal(audit.actions.at(-1).valid, true);
});
for (const code of ['await app.setValue(target, "cobalt heron 47");', 'await app.setValue(99, "cobalt heron 47");',
  'await other.setValue(32, "cobalt heron 47");', 'await app.setValue(32, text);'])
  test(`setValue keeps unresolved arguments or receivers unknown: ${code}`, () => {
    assert.ok(traceCalls(alterCode(setValue, code)).unknown.length > 0);
  });

test('Reference setValue fails the bound-input check even if the final evidence is missing', () => {
  const record = structuredClone(recorded.unchanged);
  record.trace = alterCode(setValue, 'await app.setValue(35, "cobalt heron 47");');
  const graded = gradeControl({ ...record.row, recovery: recovery(record) });
  assert.equal(graded.checks.boundInputTargets.status, 'fail');
});

test('a missing reply or transcript mismatch keeps recovery inconclusive', () => {
  for (const mutate of [r => {
    const call = r.trace.find(e => e.direction === 'call-received' && e.msg.params?.code === setValue);
    r.trace = r.trace.filter(e => !(e.direction === 'to-client' && e.msg.id === call.msg.id));
  }, r => r.transcript.pop()]) {
    const record = structuredClone(recorded.unchanged); mutate(record);
    assert.equal(gradeControl({ ...record.row, recovery: recovery(record) }).checks.trace.status, 'inconclusive');
  }
});
