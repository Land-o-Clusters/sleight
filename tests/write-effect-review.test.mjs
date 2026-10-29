import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { wrongFieldEffects } from '../plugins/sleight/lib/write-effect.mjs';
import { createReadCompactor } from '../plugins/sleight/lib/compact-reads.mjs';
import { createRelay, promptNotice } from '../plugins/sleight/lib/relay.mjs';
import { hasWrite, writeCodeTrace } from '../plugins/sleight/lib/write-trace.mjs';

const head = 'Window: "Form", App: Fixture.\n0 standard window Form\n';
const code = 'await app.setValue(26, "street");';
const tree = (value = '', promo = '') => head + '\t26 combo box (settable) Address' + value + '\n\t53 text field (settable) Promo' + promo + '\n';

for (const attributes of ['', ' (settable)']) for (const meta of ['Value: 4111111111111111', 'Selected text: 4111111111111111', 'Placeholder: 4111111111111111', 'Help: 4111111111111111']) {
  test(`unlabeled card metadata stays out of notice${attributes}: ${meta.split(':')[0]}`, () => {
    const a = head + '\t26 combo box Address, Value: old\n\t53 text field' + attributes + ' ' + meta + ', ID: card-number\n';
    const b = meta.startsWith('Value:') ? a.replace(meta, 'Value: street') : a.replace('53 text field' + attributes + ' ' + meta, '53 text field' + attributes + ' ' + meta + ', Value: street');
    const effect = wrongFieldEffects(code, a, b)[0];
    assert.ok(effect);
    assert.match(effect.notice, /53 \(unlabeled text field\)/);
    assert.doesNotMatch(effect.notice, /411111|street|Value:|Selected text:|Placeholder:|Help:/);
  });
}

test('only an exposed unchanged value makes the write not done', () => {
  const [effect] = wrongFieldEffects(code, tree(', Value: old'), tree(', Value: old', ', Value: street'));
  assert.equal(effect.isError, true);
  assert.match(effect.notice, /Requested write not done/);
  assert.match(effect.notice, /text is now in 53/);
  assert.match(effect.notice, /clear it before continuing/);
  assert.match(effect.notice, /Other actions in this call ran/);
});

for (const label of ['Address', 'Same as shipping', 'Confirm email']) test(`unexposed ${label} mirror gets a plain notice`, () => {
  const a = tree().replace('Address', label), b = tree('', ', Value: street').replace('Address', label);
  const [effect] = wrongFieldEffects(code, a, b);
  assert.equal(effect.isError, false);
  assert.match(effect.notice, /shows no value; check both before continuing/);
  assert.doesNotMatch(effect.notice, /not done/);
});

test('repeat misdelivery still flags an explicit requested write with exposed unchanged value', () => {
  const a = tree(', Value: old', ', Value: street');
  const [effect] = wrongFieldEffects(code, a, a);
  assert.equal(effect.isError, true);
  assert.equal(effect.received, 53);
  assert.deepEqual(wrongFieldEffects('await app.setValue(53, "street");', a, a), []);
});

test('outcomes match action identity across filtering and remapping', () => {
  const c = createReadCompactor({ outcomes: true });
  const a = tree(', Value: old') + '\t54 text field Email\n';
  c.process([{ type: 'text', text: a }]);
  const action = c.beginAction('await app.click(54); await app.setValue(26, "street"); await app.setValue(54, "mail");');
  c.process([{ type: 'text', text: a.replace('Promo\n', 'Promo, Value: street\n') + '\n[rec]' + JSON.stringify({ outcomes: [
    null, { i: 1, a: 'setValue', n: 126, f: [{ o: 'value', m: true }] }, { i: 2, a: 'setValue', n: 54, f: [{ o: 'value', m: true }] },
  ] }) }], { action, filterMark: '[rec]' });
  const outcomes = c.takeOutcomes().outcomes;
  assert.equal(outcomes[0].x, 'failed');
  assert.equal(outcomes[1].x, undefined);
});

for (const source of [
  'const secret = 4111111111111111; app.paste(secret)',
  'const secret = "sensitive"; app["setValue"](26, secret)',
  'const secret = "sensitive"; app.typeText.call(app, secret)',
  'const secret = "sensitive"; app.pressKey.apply(app, [secret])',
  'const secret = "sensitive"; app.paste?.(secret)',
  'const secret = String.fromCharCode(52,49,49); app.typeText(secret)',
  'const secret = Buffer.from(cardCodes).toString(); app.paste(secret)',
  'const secret = 0x414243n; const other = 1.234e10; app.click(26)',
]) test(`input code masks all literals and encoded arguments: ${source.split(';').at(-1)}`, () => {
  assert.equal(hasWrite(source), true);
  const trace = writeCodeTrace(source);
  assert.doesNotMatch(trace.code, /411111|sensitive|52|49|cardCodes|414243|234|26/);
});

for (const traceCode of [false, true]) test(`relay plain notice, prompt variant and trace opt-in: ${traceCode}`, t => {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const replies = [], traces = [];
  clientOut.on('data', b => replies.push(...b.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, prompt: 'lean', traceCode,
    trace: (direction, msg) => traces.push({ direction, msg }) });
  t.after(() => { relay.dispose(); for (const s of [clientIn, clientOut, serverIn, serverOut]) s.destroy(); });
  const call = (id, source) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code: source } } }) + '\n');
  const reply = (id, text) => serverOut.write(JSON.stringify({ id, result: { content: [{ type: 'text', text }] } }) + '\n');
  call(1, 'let app = await cua.getApp("Fixture")'); reply(1, tree());
  call(2, code); reply(2, tree('', ', Value: street'));
  assert.notEqual(replies.at(-1).result.isError, true);
  const effect = wrongFieldEffects(code, tree(), tree('', ', Value: street'))[0];
  assert.equal(replies.at(-1).result.content[0].text, promptNotice(effect.notice, 'lean'));
  assert.equal(traces.filter(r => r.direction === 'write-code').length, traceCode ? 1 : 0);
});

test('code key redaction uses the full cell when input is past the trace prefix', t => {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const traces = [];
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, traceCode: true,
    trace: (direction, msg) => traces.push({ direction, msg }) });
  t.after(() => { relay.dispose(); for (const s of [clientIn, clientOut, serverIn, serverOut]) s.destroy(); });
  const source = 'const card = "sensitive"; ' + 'void 0; '.repeat(600) + 'app.paste(card);';
  clientIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: source } } }) + '\n');
  assert.doesNotMatch(JSON.stringify(traces), /sensitive/);
});

// A read-only cell must return before inspecting any supplied tree.
test('cells with no literal field write never parse the trees', () => {
  const tree = { toString() { throw Error('tree parsed'); } };
  for (const source of ['await app.getAXState()', 'await app.click(26)', 'const label = "app.setValue(26)";']) {
    assert.deepEqual(wrongFieldEffects(source, tree, tree), []);
  }
});
