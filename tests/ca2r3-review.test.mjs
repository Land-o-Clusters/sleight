import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calls, FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { nativeArgumentsProblem } from '../plugins/sleight/lib/native-arguments.mjs';
import { literalElements } from '../plugins/sleight/lib/literal-elements.mjs';
import { clipboardActions } from '../plugins/sleight/lib/clipboard.mjs';
import { parseCell } from '../plugins/sleight/lib/code-ast.mjs';

const rules = () => new FlowRules({ version: 1, rules: [
  { id: 'pattern', kind: 'pattern', pattern: 'unrelated', destinations: ['Mail'], except: ['Notes'] },
  { id: 'source', kind: 'source', sources: ['Notes'], destinations: ['Mail'], except: ['Notes'] },
] });
const trusted = 'function chromeSwipe(h, size) { return h.scroll([0,0], "down"); }';
const options = { trustedFunctions: new Set([trusted]) };
const wrapper = handle => `(${trusted}).bind(null, ${handle}, [1,2])("down")`;

const refused = [
  // The review's four built-in redefinitions. None of these cells is executed.
  'Object.assign(globalThis, { String: f => f("SECRET") }); String(app.typeText)',
  'Object.defineProperty(globalThis, "String", { value: f => f("SECRET") }); String(app.typeText)',
  'globalThis["Str" + "ing"] = f => f("SECRET"); String(app.typeText)',
  'Object.defineProperty(Object, "keys", { value: h => h.typeText("SECRET") }); Object.keys(app)',
  // The three bare-eval launders from the review, plus Function equivalents.
  String.raw`({run: eval}).run("app.typeText(\"SECRET\")")`,
  String.raw`["app.typeText(\"SECRET\")"].map(eval)`,
  String.raw`Promise.resolve("app.typeText(\"SECRET\")").then(eval)`,
  String.raw`({run: Function}).run("app.typeText(\"SECRET\")")`,
  String.raw`["app.typeText(\"SECRET\")"].map(Function)`,
  String.raw`Promise.resolve("app.typeText(\"SECRET\")").then(Function)`,
  wrapper('notAHandle'),
  'const app = {}; ' + wrapper('app'),
  'Object.getOwnPropertyNames(app)',
  'String(app)',
  'nodeRepl.write(String(app))',
  'JSON.stringify(app)',
  'nodeRepl.write(JSON.stringify(app))',
  'const JSON = { stringify: x => x }; JSON.stringify(Object.keys(app))',
  'Object.freeze(Object); String(app.typeText)',
  ...['globalThis', 'window', 'self', 'Reflect', 'Function', 'Symbol', 'prototype', '__proto__', 'defineProperty', 'assign']
    .flatMap(name => [`${name}; String(app.typeText)`, `${name}; Object.keys(app)`, `${name}; typeof app.typeText`,
      `${name}; app.typeText === undefined`, `${name}; app.typeText.toString()`, `${name}; app.typeText`]),
  ...['other.x = 1', 'other.x++', 'delete other.x', '[other.x] = [1]', '({ x: other.x } = { x: 1 })',
    'for (other.x of [1]) {}', 'for (other.x in { x: 1 }) {}'].flatMap(write => [
    `${write}; String(app.typeText)`, `${write}; Object.keys(app)`, `${write}; typeof app.typeText`,
  ]),
  ...['eval', 'Function', 'constructor'].flatMap(name => [
    `other.${name}`, `other["${name}"]`, `other.${name}("SECRET")`, `other.${name}; app.typeText("safe")`,
  ]),
  'const run = eval', 'const run = Function', '({ eval })', 'function f(Function) {}',
];
for (const code of refused) test('CA2R3 refuses every consumer: ' + code, () => {
  assert.equal(parseCell(code).error, null, 'the regression cell must be valid JavaScript');
  assert.match(nativeArgumentsProblem(code, undefined, undefined, options), /cannot inspect JavaScript/);
  assert.throws(() => literalElements(code, options), /cannot inspect JavaScript/);
  assert.throws(() => clipboardActions(code, options), /cannot inspect JavaScript/);
  assert.equal(calls(code, new Map(), undefined, undefined, options).unknown, true);
  assert.deepEqual(rules().analyze('js', { code }, { app: 'Notes' }, options).violations.map(v => v.rule), ['pattern', 'source']);
});

for (const code of [
  'JSON.stringify(Object.keys(app))', 'nodeRepl.write(JSON.stringify(Object.keys(app)))',
  'console.log(JSON.stringify(Object.keys(app)))', 'JSON.stringify(Object.keys(app).slice(0, 2))',
  'String(app.typeText)', 'typeof app.setValue', 'Object.keys(app)', 'app.typeText === undefined',
  'app.typeText.toString()', 'const local = {}; local.x = 1; String(app.typeText)',
  wrapper('app'), wrapper('__sleightOpenedApp123'),
  'const editor = await cua.getApp("Mail"); ' + wrapper('editor'),
]) test('CA2R3 preserves proven reads and wrappers: ' + code, () => {
  assert.equal(nativeArgumentsProblem(code, undefined, undefined, options), undefined);
  assert.doesNotThrow(() => literalElements(code, options));
  assert.doesNotThrow(() => clipboardActions(code, options));
  assert.equal(calls(code, new Map(), undefined, undefined, options).unknown, false);
});

test('a prior proven swipe handle stays trusted', () => {
  assert.equal(calls(wrapper('editor'), new Map([['editor', { app: 'Mail' }]]), undefined, undefined, options).unknown, false);
  assert.equal(nativeArgumentsProblem(wrapper('editor'), new Set(['editor']), undefined, options), undefined);
});

test('String(handle) refusal names the read-only keys alternative', () => {
  assert.equal(nativeArgumentsProblem('String(app)'),
    'sleight: cannot inspect JavaScript. Use direct calls with literal arguments. (String(handle); read-only: Object.keys(handle))');
});
