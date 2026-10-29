import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { wrongFieldEffects, fieldWrites } from '../plugins/sleight/lib/write-effect.mjs';
import { createReadCompactor } from '../plugins/sleight/lib/compact-reads.mjs';
import { recordings, replay } from '../bench/replay/safari-wrong-field.mjs';

const head = 'Window: "Form", App: Fixture.\n0 standard window Form\n\t1 container Shipping\n';
const before = head + '\t\t26 combo box (settable, collapsed) Address\n\t\t53 text field (settable) Promo\n';
const wrong = before.replace('Promo\n', 'Promo, Value: street\n');
const code = 'await app.setValue(26, "street");';

for (const recording of recordings) test(`${recording.id}: effect detection flags the SB1 replay and accepts faithful delivery`, async () => {
  const bad = await replay(recording), good = await replay(recording, { recordedEffect: false });
  assert.equal(bad.effects.length, 1);
  assert.deepEqual([bad.effects[0].requested, bad.effects[0].received], [26, 53]);
  assert.equal(good.effects.length, 0);
  assert.match(bad.result[0].text, /Action not done/);
  assert.doesNotMatch(bad.result.map(c => c.text).join('\n'), /UI changed \(value\)/);
});

test('setValue and click/typeText notice names the destination and target without the typed value', () => {
  for (const source of [code, 'await app.click(26); await app.typeText("street");']) {
    const effects = wrongFieldEffects(source, before, wrong);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].notice, 'sleight: The text went into 53 (Promo text field), not 26 (Address combo box). Action not done; sleight made no repair.');
    assert.doesNotMatch(effects[0].notice, /street/);
  }
});

test('payment and credential recipients lead the notice', () => {
  for (const [label, role, expected] of [['Card number', 'text field', 'Payment'], ['Password', 'secure text field', 'Credential']]) {
    const a = before.replace('text field (settable) Promo', `${role} (settable) ${label}`);
    const b = a.replace(`${label}\n`, `${label}, Value: street\n`);
    assert.match(wrongFieldEffects(code, a, b)[0].notice, new RegExp(`^sleight: ${expected} field received the text\\.`));
  }
});

test('Description and ID metadata at the start of a field body retain their labels and risk', () => {
  const a = before.replace('Address\n', 'Description: Address\n').replace('Promo\n', 'Description: Password, ID: login-secret\n');
  const b = a.replace('ID: login-secret', 'ID: login-secret, Value: street');
  const effect = wrongFieldEffects(code, a, b)[0];
  assert.match(effect.notice, /^sleight: Credential field received the text/);
  assert.match(effect.notice, /53 \(Password text field\), not 26 \(Address combo box\)/);
});

test('unchanged, correct, ambiguous, intentional, incomplete and unrelated writes stay silent', () => {
  for (const [source, a, b] of [
    [code, before, before], [code, before, before.replace('Address\n', 'Address, Value: street\n')],
    [code, before, wrong.replace('Value: street', 'Value: STREET')],
    [code, wrong, wrong], [code, before, wrong.replace('App: Fixture', 'App: Other')],
    [code, before, wrong + '\t\t54 text field (settable) Promo, Value: street\n'],
    [code + 'await app.setValue(53, "street");', before, wrong],
    [code + 'await app.setValue(26, "other");', before, wrong],
    ['await app.click([3,4]); await app.typeText("street");', before, wrong],
    ['await other.click(26); await app.typeText("street");', before, wrong],
    ['await app.click(26); await app.pressKey("Tab"); await app.typeText("street");', before, wrong],
    [code, before, wrong.replace('0 standard window Form', 'sleight: lines changed since the last full tree')],
    [code, before, wrong.replace('53 text field', '54 text field').replace('Promo', 'Different')],
  ]) assert.deepEqual(wrongFieldEffects(source, a, b), [], source);
});

test('renumbering preserves unique field identity and escaped literals are decoded', () => {
  const source = 'await app.setValue({label: "Address"}, "str\\u0065et");';
  assert.equal(fieldWrites(source, before)[0].value, 'street');
  assert.equal(wrongFieldEffects(source, before, wrong.replace('53 text field', '63 text field'))[0].received, 63);
});

test('selection before typing keeps its explicit field target and multiline values match exactly', () => {
  assert.equal(wrongFieldEffects('await app.click(26); await app.pressKey("super+a"); await app.typeText("street");', before, wrong).length, 1);
  const multiline = wrong.replace('Value: street\n', 'Value: first\nsecond\n');
  assert.equal(wrongFieldEffects('await app.setValue(26, "first\\nsecond");', before, multiline).length, 1);
});

test('an earlier different write to the receiving field does not hide the later misdelivery', () => {
  assert.equal(wrongFieldEffects('await app.setValue(53, "promo");' + code, before, wrong).length, 1);
});

test('only the misdirected outcome is marked failed, including a remapped target number', () => {
  // A wrong write to a field also explicitly targeted in the batch is ambiguous, so use a third field.
  const initial = before + '\t\t54 text field (settable) Email\n';
  const compactor = createReadCompactor({ outcomes: true }); compactor.process([{ type: 'text', text: initial }]);
  const batch = compactor.beginAction('await app.setValue(54, "email"); await app.setValue(26, "street");');
  const final = initial.replace('54 text field (settable) Email', '54 text field (settable) Email, Value: email').replace('Promo\n', 'Promo, Value: street\n');
  compactor.process([{ type: 'text', text: final + '\n[receipt]' + JSON.stringify({ outcomes: [
    { a: 'setValue', n: 54, f: [{ o: 'value', m: true }] }, { a: 'setValue', n: 126, f: [{ o: 'value', m: true }] },
  ] }) }], { action: batch, filterMark: '[receipt]' });
  const record = compactor.takeOutcomes();
  assert.equal(record.outcomes[0].x, undefined);
  assert.equal(record.outcomes[1].x, 'failed');
  assert.deepEqual(record.outcomes[1].f, []);
});

test('overlap and degraded before observations do not attribute a write', () => {
  for (const options of [{ overlap: true }, { degraded: true }, { incomplete: true }]) {
    const c = createReadCompactor(); c.process([{ type: 'text', text: before }]);
    const action = c.beginAction(code);
    if (options.overlap) action.overlap = true;
    else Object.assign(action.before, options);
    c.process([{ type: 'text', text: wrong }], { action });
    assert.deepEqual(action.writeEffects, []);
  }
});

test('relay marks the tool result as failed and sends no repair or additional request', t => {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const requests = [], replies = [], traces = [];
  serverIn.on('data', b => requests.push(...b.toString().trim().split('\n').map(JSON.parse)));
  clientOut.on('data', b => replies.push(...b.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, trace: (direction, msg) => traces.push({ direction, msg }) });
  t.after(() => { relay.dispose(); for (const s of [clientIn, clientOut, serverIn, serverOut]) s.destroy(); });
  const call = (id, source) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code: source } } }) + '\n');
  const reply = (id, text) => serverOut.write(JSON.stringify({ id, result: { content: [{ type: 'text', text }] } }) + '\n');
  call(1, 'let app = await cua.getApp("Fixture")'); reply(1, before);
  call(2, code); const count = requests.length; reply(2, wrong);
  assert.equal(replies.at(-1).result.isError, true);
  assert.match(replies.at(-1).result.content[0].text, /Action not done/);
  assert.equal(requests.length, count);
  assert.equal(traces.filter(r => r.direction === 'wrong-field-effect').length, 1);
});
