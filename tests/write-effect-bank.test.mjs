import { test } from 'node:test';
import assert from 'node:assert/strict';
import { materialize, auditTranscript } from '../bench/replay/write-effect-bank.mjs';
import { runSequence, passRules } from '../bench/replay/safari-address-repro.mjs';
import { recordings } from '../bench/replay/safari-wrong-field.mjs';
import { wrongFieldEffects } from '../plugins/sleight/lib/write-effect.mjs';
import { createReadCompactor } from '../plugins/sleight/lib/compact-reads.mjs';

const before = 'Window: "Form", App: Fixture.\n0 standard window Form\n\t26 combo box (settable) Address\n\t53 text field (settable) Promo, Value: old';
const after = before.replace('Value: old', 'Value: street');
const code = 'await app.setValue(26, "street");';
const diff = 'Window: "Form", App: Fixture.\n0 standard window Form\nsleight: lines changed since the last full tree you saw for this window:\n- \ttext field (settable) Promo, Value: old\n+ \t53 text field (settable) Promo, Value: street\n- The focused UI element is 26 text field Address\n+ The focused UI element is 53 text field Promo';
test('bank replay applies explicit row changes and ignores focus summaries and repeated display slices', () => {
  const initial = materialize(before);
  assert.equal(materialize(diff, initial).text, after);
  assert.equal(materialize('Window: "Form", App: Fixture.\n0 standard window Form\nsleight: no change since the last full tree you saw for this window.', initial).text, before);
  assert.equal(materialize(before + '\n\t53 text field (settable) Promo, Value: old').text, before);
  assert.equal(materialize(before + '\n\t53 text field (settable) Different'), undefined);
  assert.equal(materialize(diff.replace('Value: old', 'Value: absent'), initial), undefined);
});

test('bank replay counts correct writes and detects a wrong destination after a guarded failure', () => {
  const use = (id, source) => ({ message: { content: [{ type: 'tool_use', id, name: 'mcp__plugin_sleight_computer__js', input: { code: source } }] } });
  const result = (id, text, is_error = false) => ({ message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error }] } });
  const source = [use('a', 'var app = await cua.getApp("Fixture")'), result('a', before, true),
    use('b', code), result('b', diff), use('c', 'await app.setValue(53, "street");'), result('c', after)].map(JSON.stringify).join('\n');
  const report = auditTranscript(source);
  assert.equal(report.correctWrites, 1);
  assert.equal(report.correctFlags, 0);
  assert.deepEqual(report.flags, [{ call: 2, isError: false, method: 'setValue', requested: 26, received: 53 }]);
});

test('the compactor retains a full error observation for the next effect comparison, then clears on reset', () => {
  const compactor = createReadCompactor();
  compactor.process([{ type: 'text', text: before }], { failed: true });
  const action = compactor.beginAction(code);
  assert.equal(action.before, undefined);
  compactor.process([{ type: 'text', text: after }], { action });
  assert.equal(action.writeEffects.length, 1);
  compactor.reset();
  assert.equal(compactor.beginAction(code).effectBefore, undefined);
});

for (const state of ['correct', 'detected', 'unflagged']) test(`prepared six-call repro with a fake transport: ${state}`, async () => {
  const recording = recordings[0], calls = Array.from({ length: 6 }, (_, i) => ({ server: 'plugin:sleight:computer', name: 'js',
    arguments: { code: i === 5 ? recording.code : 'await app.getAXState();' },
    result: { content: [{ type: 'text', text: recording.before }], isError: [3, 4].includes(i) } }));
  const sent = [];
  const report = await runSequence(calls, { mapper: { arguments: args => args, observe() {} }, call: async (server, name, args) => {
    const i = sent.length; sent.push({ server, name, args });
    return { isError: [3, 4].includes(i), content: [{ type: 'text',
      text: i !== 5 ? recording.before : state === 'correct' ? recording.before.replace('Address, Placeholder:', 'Address, Value: 47 Juniper Court, Asheville, NC 28801, Placeholder:') :
        recording.after + (state === 'detected' ? '\n' + wrongFieldEffects(recording.code, recording.before, recording.after)[0].notice : '') }] };
  } });
  assert.equal(sent.length, 6);
  assert.equal(report.verdict, state === 'unflagged' ? 'inconclusive' : 'pass');
  assert.equal(passRules.length, 6);
});

test('prepared repro stops before another call on an early mismatch or ambiguous mapping', async () => {
  let sent = 0;
  const calls = [{ server: 'plugin:sleight:computer', name: 'js', arguments: { code }, result: { isError: false, content: [] } }];
  const mapper = { arguments: args => args, observe() {} };
  const report = await runSequence(calls, { mapper, call: async () => { sent++; return { isError: true, content: [] }; } });
  assert.equal(report.verdict, 'inconclusive'); assert.equal(sent, 1);
  await assert.rejects(runSequence(calls, { mapper: { arguments() { throw Error('ambiguous'); } }, call: async () => { sent++; } }), /ambiguous/);
  assert.equal(sent, 1);
});
