import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { fieldWrites, wrongFieldEffects } from '../plugins/sleight/lib/write-effect.mjs';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';
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
  assert.match(effect.notice, /check 53 and 26 before continuing/);
  assert.doesNotMatch(effect.notice, /not done/);
});

test('a pre-existing recipient value alone does not establish misdelivery', () => {
  const a = tree(', Value: old', ', Value: street');
  assert.deepEqual(wrongFieldEffects(code, a, a), []);
  assert.deepEqual(wrongFieldEffects('await app.setValue(53, "street");', a, a), []);
});

test('an earlier flagged call permits a repeat notice without an error or a clear instruction', () => {
  const flagged = new Set(), a = tree(', Value: old'), b = tree(', Value: old', ', Value: street');
  assert.equal(wrongFieldEffects(code, a, b, { flagged })[0].isError, true);
  const [effect] = wrongFieldEffects(code, b, b, { flagged });
  assert.equal(effect.isError, false);
  assert.match(effect.notice, /check 53 and 26 before continuing/);
  assert.doesNotMatch(effect.notice, /clear|not done/);
  assert.deepEqual(wrongFieldEffects('await app.getAXState();', b, b, { flagged }), []);
  assert.deepEqual(wrongFieldEffects('await app.setValue(53, "street");', b, b, { flagged }), []);
  assert.deepEqual(wrongFieldEffects(code, b.replace('old', 'different'), b.replace('old', 'different'), { flagged }), []);
  assert.doesNotMatch(JSON.stringify([...flagged]), /street|old/);
});

test('repeat state belongs to one compactor and clears on reset', () => {
  const c = createReadCompactor(), a = tree(', Value: old'), b = tree(', Value: old', ', Value: street');
  c.process([{ type: 'text', text: a }]);
  const first = c.beginAction(code); c.process([{ type: 'text', text: b }], { action: first });
  assert.equal(first.writeEffects[0].isError, true);
  const second = c.beginAction(code); c.process([{ type: 'text', text: b }], { action: second });
  assert.equal(second.writeEffects[0].isError, false);
  c.reset(); c.process([{ type: 'text', text: b }]);
  const third = c.beginAction(code); c.process([{ type: 'text', text: b }], { action: third });
  assert.deepEqual(third.writeEffects, []);
});

test('outcomes match action identity and target number across filtering', () => {
  const c = createReadCompactor({ outcomes: true });
  const a = tree(', Value: old') + '\t54 text field Email\n';
  c.process([{ type: 'text', text: a }]);
  const action = c.beginAction('await app.click(54); await app.setValue(26, "street"); await app.setValue(54, "mail");');
  c.process([{ type: 'text', text: a.replace('Promo\n', 'Promo, Value: street\n') + '\n[rec]' + JSON.stringify({ outcomes: [
    null, { i: 1, a: 'setValue', n: 26, f: [{ o: 'value', m: true }] }, { i: 2, a: 'setValue', n: 54, f: [{ o: 'value', m: true }] },
  ] }) }], { action, filterMark: '[rec]' });
  const outcomes = c.takeOutcomes().outcomes;
  assert.equal(outcomes[0].x, 'failed');
  assert.equal(outcomes[1].x, undefined);
});

test('helper input-named methods do not advance the engine guard action index', () => {
  const source = 'helper.click(); helper.scroll(); helper.press(); helper.drag(); await app.setValue(26, "street"); await app.setValue(54, "mail");';
  const a = tree(', Value: old') + '\t54 text field Email\n';
  assert.deepEqual(fieldWrites(source, a).map(w => w.index), [0, 1]);
  const c = createReadCompactor({ outcomes: true }); c.process([{ type: 'text', text: a }]);
  const action = c.beginAction(source);
  c.process([{ type: 'text', text: a.replace('Promo\n', 'Promo, Value: street\n') + '\n[rec]' + JSON.stringify({ outcomes: [
    { i: 0, a: 'setValue', n: 26, f: [{ o: 'value', m: true }] },
    { i: 1, a: 'setValue', n: 54, f: [{ o: 'value', m: true }] },
  ] }) }], { action, filterMark: '[rec]' });
  assert.equal(c.takeOutcomes().outcomes[0].x, 'failed');
});

test('field-write indices agree with real guard receipts beside helper calls', async () => {
  const a = tree(', Value: old') + '\t54 text field Email\n', output = [], sent = [];
  const source = 'helper.click(); helper.scroll(); helper.press(); helper.drag(); await app.click(54); await app.setValue(26, "street"); await app.setValue(54, "mail");';
  const raw = { getAXState: async () => a, click: async () => sent.push('click'), setValue: async () => sent.push('setValue') };
  const wrapped = guardedCode('var app = await cua.getApp("Fixture");' + source,
    { title: 'Form', app: 'Fixture', url: null }, undefined, undefined,
    { outcomes: true, outcomeMark: '[oracle]', literals: [26, 54], seenLines: { 26: 'combo box (settable) Address, Value: old', 54: 'text field Email' } });
  await runInNewContext(`(async () => { ${wrapped} })()`, { cua: { getApp: async () => raw },
    helper: { click() {}, scroll() {}, press() {}, drag() {} }, nodeRepl: { write: s => output.push(s) }, setTimeout, clearTimeout });
  const records = output.join('').split('\n').filter(s => s.startsWith('[oracle]')).map(s => JSON.parse(s.slice('[oracle]'.length)));
  const actual = records.findLast(r => r.outcomes)?.outcomes.filter(r => r.a === 'setValue').map(r => ({ index: r.i, number: r.n }));
  assert.deepEqual(actual, fieldWrites(source, a).map(w => ({ index: w.index, number: w.target.number })));
  assert.deepEqual(sent, ['click', 'setValue', 'setValue']);
});

for (const n of [54, 126, undefined]) test(`matching outcome index with a different target stays unfailed: ${n}`, () => {
  const c = createReadCompactor({ outcomes: true }), a = tree(', Value: old');
  c.process([{ type: 'text', text: a }]); const action = c.beginAction(code);
  c.process([{ type: 'text', text: tree(', Value: old', ', Value: street') + '\n[rec]' + JSON.stringify({ outcomes: [
    { i: 0, a: 'setValue', n, f: [{ o: 'value', m: true }] },
  ] }) }], { action, filterMark: '[rec]' });
  assert.equal(c.takeOutcomes().outcomes[0].x, undefined);
});

for (const failureMode of ['failed', 'caught']) test(`a ${failureMode} batch retains its call-failed note without saying other actions ran`, () => {
  const c = createReadCompactor(), a = tree(', Value: old');
  c.process([{ type: 'text', text: a }]); const action = c.beginAction(code + ' await app.click(54);');
  const text = tree(', Value: old', ', Value: street') + (failureMode === 'caught' ? '\nsleight: an action in this call failed, and the call went on without it: click.' : '');
  const out = c.process([{ type: 'text', text }], { action, failed: failureMode === 'failed', failure: { message: 'later click failed' } });
  assert.equal(action.writeEffects.length, 1);
  const notice = out.map(item => item.text).join('\n');
  assert.doesNotMatch(notice, /Other actions in this call ran/);
  assert.match(notice, /call failed \(partial input possible\): later click failed/);
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

for (const traceCode of [false, true]) for (const source of [
  'await app["set"+"Value"](26,"secret-value")',
  'await app[m](26,"secret-value")',
  'const readOnly = "secret-value"; void 4111111111111111; void true; void null;',
]) test(`every traced code key masks literals, traceCode=${traceCode}, ${source.slice(0, 25)}`, t => {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough(), traces = [];
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, traceCode, changeReview: false,
    trace: (direction, msg) => traces.push({ direction, msg }) });
  t.after(() => { relay.dispose(); for (const s of [clientIn, clientOut, serverIn, serverOut]) s.destroy(); });
  clientIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: source } } }) + '\n');
  assert.ok(traces.some(r => r.direction === 'to-server'));
  assert.doesNotMatch(JSON.stringify(traces), /secret-value|4111111111111111|\b26\b/);
  assert.equal(traces.filter(r => r.direction === 'write-code').length, 0);
});

// A read-only cell must return before inspecting any supplied tree.
test('cells with no literal field write never parse the trees', () => {
  const tree = { toString() { throw Error('tree parsed'); } };
  for (const source of ['await app.getAXState()', 'await app.click(26)', 'const label = "app.setValue(26)";']) {
    assert.deepEqual(wrongFieldEffects(source, tree, tree), []);
  }
});
