import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext, Script } from 'node:vm';
import { PassThrough } from 'node:stream';
import { tokens, invalidTokens, FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { clipboardActions } from '../plugins/sleight/lib/clipboard.mjs';
import { literalElements } from '../plugins/sleight/lib/literal-elements.mjs';
import { nativeArgumentsProblem } from '../plugins/sleight/lib/native-arguments.mjs';
import { nativeTabPlan } from '../plugins/sleight/lib/tab-probe.mjs';
import { splitMenuActions } from '../plugins/sleight/lib/menu-continuation.mjs';
import { splitTextSave } from '../plugins/sleight/lib/text-save.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const repro = 'if (a) {}\n/[/*]/.test(s); await app.typeText("SECRET"); /[*/]/.test(s)';
const flow = () => new FlowRules({ version: 1, rules: [
  { id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] },
  { id: 'other', kind: 'pattern', pattern: 'OTHER', destinations: ['Fixture'] },
] });

test('the LF-only phantom-comment repro executes a call and inspection refuses it', async () => {
  const typed = [];
  await runInNewContext('(async () => {' + repro + '})()', {
    a: true, s: '/', app: { typeText: async value => typed.push(value) },
  });
  assert.deepEqual(typed, ['SECRET']);
  assert.equal(invalidTokens(tokens(repro)), true);
  assert.equal(flow().analyze('js', { code: repro }, { app: 'Fixture' }).violations.length, 2);
});

for (const boundary of ['if (a) {}\n', 'if (a) {} ', 'if (a) {} /* gap */ ',
  'const value = {}\n', 'function read() {}\n', 'class Value {}\n']) {
  test(`ambiguous brace slash preserves the prefix and all six consumers refuse: ${boundary.trim()}`, () => {
    const prefix = 'await app.click(7); ', suffix = boundary + '/[/*]/.test(s); await app.paste(); /[*/]/.test(s)';
    const code = prefix + suffix, ts = tokens(code);
    assert.deepEqual(ts.slice(0, 8).map(t => t.v), ['await', 'app', '.', 'click', '(', '7', ')', ';']);
    assert.equal(ts.at(-1).v, '<invalid>');
    assert.equal(flow().analyze('js', { code }, { app: 'Fixture' }).violations.length, 2);
    assert.throws(() => clipboardActions(code), /cannot inspect JavaScript/);
    assert.throws(() => literalElements(code), /cannot inspect JavaScript/);
    assert.match(nativeArgumentsProblem(code), /cannot inspect JavaScript/);
    assert.equal(splitMenuActions('await app.click(1); await app.click(2); ' + suffix), undefined);
    assert.equal(splitTextSave(suffix + '; await app.setValue(1, "safe"); await app.pressKey("super+s")'), undefined);
    assert.equal(nativeTabPlan({ code, actions: [
      { selector: { kind: 'key', value: 'super+t' } }, { start: 0, end: code.length },
      { selector: { kind: 'key', value: 'Return' } },
    ] }), false);
  });
}

const keywordCases = [
  ['typeof', 'typeof /[/*]/.test(s)'], ['void', 'void /[/*]/.test(s)'],
  ['in', '"key" in /[/*]/'], ['new', 'new /[/*]/.constructor(s)'],
  ['delete', 'delete /[/*]/.key'], ['instanceof', 's instanceof /[/*]/.constructor'],
  ['return', 'function read() { return /[/*]/.test(s); } read()'],
  ['throw', 'try { throw /[/*]/; } catch (e) {}'],
  ['case', 'switch (s) { case /[/*]/: break; }'],
  ['yield', 'function* read() { yield /[/*]/; } read().next()'],
  ['await', 'await /[/*]/.test(s)'], ['else', 'if (false) {} else /[/*]/.test(s)'],
  ['do', 'do /[/*]/.test(s); while (false)'],
  ['extends', 'class Value extends /[/*]/.constructor {}'],
  ['default', 'switch (s) { default: /[/*]/.test(s); }'],
];
for (const [keyword, expression] of keywordCases) {
  test(`regex after ${keyword} cannot hide subsequent actions`, async () => {
    const code = expression + '; await app.typeText("SECRET"); await app.paste(); await app.click(7); /[*/]/.test(s)';
    const typed = [];
    await runInNewContext('(async () => {' + code + '})()', { s: '/', app: {
      typeText: async value => typed.push(value), paste() {}, click() {},
    } });
    assert.deepEqual(typed, ['SECRET']);
    assert.equal(invalidTokens(tokens(code)), false);
    assert.equal(flow().analyze('js', { code }, { app: 'Fixture' }).violations.length, 1);
    assert.deepEqual(clipboardActions(code), ['paste']);
    assert.deepEqual(literalElements(code), [7]);
  });
}

const ordinary = [
  'const half = n / 2;',
  'const ratio = n / count / 2;',
  'const percent = done/total*100;',
  'const mean = (a + b) / 2;',
  'const ratio = values[0] / values[1];',
  'const half = obj.value / 2;',
  'const half = value() / 2;',
  'const half = "12" / 2;',
  'const half = {valueOf() { return 12; }} / 2;',
  'n /= 2;',
  'const found = lines.filter(l => /Save/.test(l));',
  'const match = text.match(/(\\d+)\\/(\\d+)/);',
  'if (ok) { /Save/.test(text); }',
  'for (const line of lines) { /Save/.test(line); }',
  'try { read(); } catch (error) { /Save/.test(error.message); }',
  'const ratio = ok ? a / b : c / d;',
  'const message = `ratio ${n / 2}`;',
  'const \u03b1 = n / 2; const \u6bd4\u7387 = \u03b1 / 2;',
  'if (ok) /Save/.test(text);',
  'for (let i = 0; i < 2; i++) /Save/.test(lines[i]);',
  'while (ok) /Save/.test(text);',
  'const clean = text.replace(/\\s+/g, " ");',
];
for (const [index, snippet] of ordinary.entries()) {
  test(`ordinary snippet ${index + 1} is inspected without refusal`, () => {
    const code = snippet + ' await app.typeText("SECRET"); await app.paste(); await app.click(7);';
    new Script('(async () => {' + code + '})()');
    assert.equal(invalidTokens(tokens(code)), false, snippet);
    assert.equal(nativeArgumentsProblem(code), undefined, snippet);
    assert.equal(flow().analyze('js', { code }, { app: 'Fixture' }).violations.length, 1, snippet);
    assert.deepEqual(clipboardActions(code), ['paste'], snippet);
    assert.ok(tokens(code).some(t => t.v === 'typeText'), snippet);
  });
}

test('operator keyword members stay division operands', () => {
  for (const name of ['typeof', 'void', 'in', 'new', 'delete', 'instanceof', 'extends']) {
    for (const receiver of [`obj.${name}`, `this.#${name}`]) {
      const code = `const value = ${receiver} / app.click(7) / count;`;
      assert.equal(invalidTokens(tokens(code)), false);
      assert.deepEqual(literalElements(code), [7]);
    }
  }
});

test('brace ambiguity checks respect escapes, classes, comments and line boundaries', () => {
  for (const pattern of ['/\'/g', '/[/*]/', '/[\\/]/', '/a\\/b/']) {
    const code = 'await app.click(7); if (a) {} ' + pattern + '.test(s);';
    assert.equal(tokens(code).at(-1).v, '<invalid>', pattern);
  }
  for (const end of ['\n', '\r', '\u2028', '\u2029']) {
    const code = 'const ratio = { valueOf() { return 12; } } / 2;' + end + 'await app.click(7);';
    assert.equal(invalidTokens(tokens(code)), false);
    assert.deepEqual(literalElements(code), [7]);
  }
  for (const code of ['const ratio = {} / 2; await app.click(7);',
    'if (a) {} // /[/*]/\nawait app.click(7);',
    'if (a) {} /* /[/*]/ */ await app.click(7);',
    'const value = "}" / app.click(7) / count;']) {
    assert.equal(invalidTokens(tokens(code)), false, code);
    assert.deepEqual(literalElements(code), [7], code);
  }
  // Both lexical readings are possible even for valid object division. Grouping
  // the object makes the division unambiguous to this deliberately small scan.
  assert.equal(invalidTokens(tokens('const ratio = {} / 2 / 3;')), true);
  assert.equal(invalidTokens(tokens('const ratio = ({}) / 2 / 3;')), false);
});

test('relay refuses the ambiguous repro before dispatch through either code alias', async t => {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, sent = [], replies = [];
  serverIn.on('data', bytes => sent.push(JSON.parse(bytes)));
  clientOut.on('data', bytes => replies.push(JSON.parse(bytes)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => { relay.dispose(); streams.forEach(s => s.destroy()); });
  let id = 0;
  for (const key of ['code', 'command']) for (const code of [repro,
    'let other = await cua.getApp("Fixture"); ' + repro.replaceAll('app.', 'other.')]) {
    clientIn.write(JSON.stringify({ id: ++id, method: 'tools/call', params: { name: 'js', arguments: { [key]: code } } }) + '\n');
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 0);
  assert.equal(replies.length, 4);
  for (const reply of replies) {
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /cannot inspect JavaScript/);
    assert.doesNotMatch(reply.result.content[0].text, /SECRET/);
  }
});
