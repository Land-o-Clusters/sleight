import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { calls, FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { nativeArgumentsProblem } from '../plugins/sleight/lib/native-arguments.mjs';
import { literalElements } from '../plugins/sleight/lib/literal-elements.mjs';
import { clipboardActions } from '../plugins/sleight/lib/clipboard.mjs';

const rules = () => new FlowRules({ version: 1, rules: [
  { id: 'pattern', kind: 'pattern', pattern: 'SECRET', destinations: ['Mail'] },
  { id: 'source', kind: 'source', sources: ['Notes'], destinations: ['Mail'] },
] });
for (const code of [
  'locator("#f").pressSequentially(flag ? "SECRET" : "", { delay: 20 })',
  'app.typeText(flag ? "SECRET" : "", { delay: 20 })',
  'app.setValue(7, { value: flag ? "SECRET" : "" })',
  'app.typeText(42, { value: flag ? "SECRET" : "" })',
]) test('non-string values preserve every argument fragment: ' + code, () => {
  const found = calls(code, new Map(), { app: 'Mail' });
  assert.ok(found.inputs.some(input => input.value.includes('SECRET')));
  assert.ok(rules().analyze('js', { code }, { app: 'Mail' }).violations.some(v => v.rule === 'pattern'));
});

const refused = [
  'const [a] = [app]; await a.typeText.call(a, "SECRET")',
  '(await cua.getApp("Mail")).typeText.call(null, "SECRET")',
  'Reflect.apply(Object.values(app)[3], app, ["S"])',
  'Reflect.get(other, "typeText")("SECRET")',
  'Reflect.apply(other.typeText, null, ["SECRET"])',
  ...['typeText', 'setValue', 'pressKey', 'click', 'paste', 'doubleClick', 'rightClick', 'selectText',
    'scroll', 'drag', 'performAction', 'performSecondaryAction', 'fill', 'type', 'pressSequentially', 'press', 'goto']
    .flatMap(method => ['call', 'apply', 'bind'].map(op => `other["${method}"].${op}(null, "SECRET")`)),
  'helper(app)', 'Object.values(app)', 'String(app)', 'consume(await app)', 'consume({ app })',
  'other.typeText.call.call(null)', 'other[method].call(null)', 'consume(globalThis.app)',
  'const x = String(app.typeText); eval(x)("SECRET")',
  'String(app.typeText).constructor("SECRET")()',
  'const String = x => x; String(app.typeText)("SECRET")',
  'try {} catch(String) { String(app.typeText) }',
  'globalThis.String = other; String(app.typeText)',
  'new Sink(app)',
  'const [a] = [app]; helper(a)',
  'let a; [a] = [app]; helper(a)',
  'helper(await cua.getApp("Mail"))',
  'const Object = { keys: x => x }; Object.keys(app).typeText("SECRET")',
  '(app.typeText === undefined ? other : app.typeText)("SECRET")',
  'app.typeText.toString.call(app.typeText)',
];
for (const code of refused) test('unsafe constructs refuse all consumers: ' + code, () => {
  const reason = nativeArgumentsProblem(code);
  assert.match(reason, /cannot inspect JavaScript/);
  assert.match(reason, /Use direct .*\(/);
  assert.throws(() => literalElements(code), /cannot inspect JavaScript/);
  assert.throws(() => clipboardActions(code), /cannot inspect JavaScript/);
  assert.equal(rules().analyze('js', { code }, { app: 'Notes' }).violations.length, 2);
});

test('the unsafe refusal names the construct and the guarded direct call', () => {
  assert.match(nativeArgumentsProblem('other.typeText.call(null, "SECRET")'), /typeText\.call.*Use direct handle\.typeText\(/);
});

for (const code of [
  'String(app.typeText)', 'typeof app.setValue', 'Object.keys(app)', 'app.typeText === undefined',
  'app.typeText.toString()', 'String(app.typeText).slice(0, 20)',
  'nodeRepl.write(typeof app.typeText)', 'nodeRepl.write(Object.keys(app).join(","))',
]) test('read-only introspection stays inspectable: ' + code, () => {
  assert.equal(nativeArgumentsProblem(code), undefined);
  assert.deepEqual(literalElements(code), []);
  assert.deepEqual(clipboardActions(code), []);
  assert.equal(calls(code, new Map()).unknown, false);
});

const trusted = 'function chromeSwipe(h, size) { return h.scroll([0,0], "down"); }';
const options = { trustedFunctions: new Set([trusted]) };
test('only the exact immediately invoked trusted bind is exempt', () => {
  assert.equal(calls(`(${trusted}).bind(null, app, [1,2])("down")`, new Map(), undefined, undefined, options).unknown, false);
});
for (const expression of [
  `(${trusted}, eval)("SECRET")`,
  `(${trusted}).call(null, app, [1,2])`,
  `(${trusted}).bind(null, app, size)("SECRET")`,
  `(${trusted}).bind(null, app, [1,...rest])("SECRET")`,
  `(${trusted}).bind(null, app, [1,2])`,
  `(${trusted}).bind(null, other.app, [1,2])("SECRET")`,
  `(${trusted}).bind({}, app, [1,2])("SECRET")`,
  `(${trusted}).bind(null, app, [1,2], extra)("SECRET")`,
]) test('trusted source cannot hide a different invocation: ' + expression, () => {
  assert.equal(calls(expression, new Map(), undefined, undefined, options).unknown, true);
});
for (const code of ['globalThis.eval("SECRET")', 'window.eval("SECRET")', 'x.constructor.constructor("SECRET")()',
  'Function.prototype.constructor("SECRET")()', '[].constructor.constructor("SECRET")', 'globalThis["eval"]("SECRET")'])
  test('member-form dynamic code is indirect: ' + code, () => {
    assert.equal(calls(code, new Map()).unknown, true);
    assert.equal(rules().analyze('js', { code }).violations.length, 2);
  });

const corpus = JSON.parse(readFileSync(new URL('fixtures/ca2r2-introspection.json', import.meta.url)));
assert.equal(corpus.length, 10);
for (const record of corpus) test('previously refused Claude cell passes: ' + record.sha256, () => {
  assert.equal(createHash('sha256').update(record.code).digest('hex'), record.sha256);
  assert.equal(nativeArgumentsProblem(record.code), undefined);
  assert.deepEqual(literalElements(record.code), []);
  assert.deepEqual(clipboardActions(record.code), []);
  assert.equal(calls(record.code, new Map()).unknown, false);
});
