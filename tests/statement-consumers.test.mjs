import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statementSpans, splitTextSave } from '../plugins/sleight/lib/text-save.mjs';
import { splitMenuActions, stopNote } from '../plugins/sleight/lib/menu-continuation.mjs';
import { nativeTabPlan } from '../plugins/sleight/lib/tab-probe.mjs';
import { parseCell } from '../plugins/sleight/lib/code-ast.mjs';

// Each assertion checks real split boundaries or allow/refuse behavior. No caller source runs.
test('statement ranges follow module ASI instead of semicolons inside regex literals', () => {
  const code = 'const re = /[;}]/;\nawait app.setValue(2, "x")\nawait app.pressKey("cmd+s")';
  const split = statementSpans(code);
  assert.ok(split);
  assert.equal(split.spans.length, 3);
  assert.equal(splitTextSave(code)?.tail, 'await app.pressKey("cmd+s")');
});

test('all engine line terminators keep the same write and save boundary', () => {
  for (const end of ['\r', '\u2028', '\u2029', '\r\n']) {
    const code = `await app.setValue(2, "x"); // comment${end}await app.pressKey("cmd+s");`;
    assert.equal(splitTextSave(code)?.tail, 'await app.pressKey("cmd+s");');
  }
});

test('invalid module syntax cannot produce text-save or menu splits', () => {
  for (const code of [
    'await app.setValue(2, "x"); await app.pressKey("cmd+s"); const x = ;',
    'await app.click("File"); await app.click("Save"); nodeRepl.write(1 2)',
    'await app.click("File"); await app.click({ key: 1 2 });',
    'await app.click("File"); await app.click("Save"); nodeRepl.write(app.getAXState(,));',
  ]) {
    assert.equal(statementSpans(code), undefined, code);
    assert.equal(splitTextSave(code), undefined, code);
    assert.equal(splitMenuActions(code), undefined, code);
  }
});

test('AST regex callbacks accept parenthesized parameters and comments without hiding actions', () => {
  const head = 'await app.click("File"); await app.click("Save"); const s = await app.getAXState(); ';
  for (const callback of ['(l) => /[;}]/.test(l)', 'l /* before */ => /x/.test(/* arg */ l)']) {
    assert.equal(splitMenuActions(head + `nodeRepl.write(s.split("\\n").filter(${callback}).join("\\n"));`)?.actions.length, 2);
  }
  for (const callback of ['l => /x/.test(l, app.click(3))', 'l => /x/.test(l) && app.click(3)',
    'async l => /x/.test(l)', '(l, m) => /x/.test(l)', 'l => /x/.test(m)', 'l => { return /x/.test(l); }']) {
    assert.equal(splitMenuActions(head + `nodeRepl.write(s.split("\\n").filter(${callback}));`), undefined, callback);
  }
});

test('write allowlist rejects getters, spread, calls, optional chains and computed members', () => {
  const head = 'await app.click("File"); await app.click("Save"); const s = await app.getAXState(); ';
  for (const argument of ['app.getAXState({ get value() { return app.click(3); } })',
    'app.getAXState({ ...x })', 'app.getAXState({ x: app.click(3) })', 'app.getAXState({ [x]: 1 })',
    's?.trim()', 's["trim"]()', 's.trim(app.click(3))', 's.constructor', 's.split`x`',
    '`${app.click(3)}`', 's.filter(l => /x/.test(l)).map(l => l)']) {
    assert.equal(splitMenuActions(head + `nodeRepl.write(${argument});`), undefined, argument);
  }
});

test('AST action names and URL qualification follow complete awaited call nodes', () => {
  const code = 'await app.\\u0070ressKey("super+t"); await app.typeText("https://example.test"); await app.pressKey("Return");';
  const plan = splitMenuActions(code);
  assert.equal(nativeTabPlan(plan), true);
  assert.match(stopNote({ windowStop: true, index: 1 }, plan), /pressKey "super\+t"/);
  for (const change of ['await other.typeText("https://example.test")', 'await app["typeText"]("https://example.test")',
    'await app.typeText?.("https://example.test")', 'await app.typeText("https://example.test", "extra")']) {
    const other = code.replace('await app.typeText("https://example.test")', change);
    assert.equal(nativeTabPlan(splitMenuActions(other)), false, change);
  }
});

// Eight corpus calls used awaited screenshot output, the same observation with an outer await.
test('awaited output tails keep action indexing and still exclude executable output arguments', () => {
  const head = 'await app.click("File"); await app.click("Save"); ';
  for (const tail of ['await nodeRepl.emitImage(await app.getScreenshot());', 'await nodeRepl.write(app.getAXState());']) {
    assert.equal(splitMenuActions(head + tail)?.actions.length, 2, tail);
  }
  for (const tail of ['await nodeRepl.emitImage(await app.click(3));', 'await nodeRepl.write(await app.click(3));',
    'await nodeRepl.emitImage(await other.getScreenshot());']) assert.equal(splitMenuActions(head + tail), undefined, tail);
});

test('equivalent literal spellings keep exact selectors while executable expressions refuse', () => {
  for (const [call, selector] of [
    ['click((7))', { kind: 'number', value: 7 }], ['click(7,)', { kind: 'number', value: 7 }],
    ['click(0x7)', { kind: 'number', value: 7 }], ['click(7.0)', { kind: 'number', value: 7 }],
    ['click([1,2,])', { kind: 'point', value: [1,2] }], ['click({id:"ok",})', { kind: 'id', value: 'ok' }],
  ]) {
    const plan = splitMenuActions(`await app.${call}; await app.pressKey("Return");`);
    assert.deepEqual(plan?.actions[0].selector, selector, call);
  }
  assert.equal(splitMenuActions('await app.click((1, app.click(3))); await app.pressKey("Return");'), undefined);
});

test('30,000-term subtraction chains never escape the three consumers', () => {
  const value = '1' + '-1'.repeat(29999);
  const menu = splitMenuActions(`await app.click(${value}); await app.pressKey("Return");`);
  assert.equal(menu?.actions.length, 2);
  assert.equal(menu.actions[0].selector, undefined);
  const save = `await app.setValue(2, ${value}); await app.pressKey("cmd+s");`;
  assert.equal(splitTextSave(save)?.tail, 'await app.pressKey("cmd+s");');
  const tab = splitMenuActions(`await app.pressKey("cmd+t"); await app.typeText(${value}); await app.pressKey("Return");`);
  assert.equal(tab?.actions.length, 3);
  assert.equal(nativeTabPlan(tab), false);
});

test('30,000-member receiver and read chains refuse without a stack overflow', () => {
  const receiver = 'app' + '.x'.repeat(30000);
  const code = `await ${receiver}.typeText("https://example.test");`;
  assert.equal(splitMenuActions(code + 'await app.pressKey("Return");'), undefined);
  assert.equal(splitTextSave('await app.setValue(2, "x");' + code + 'await app.pressKey("cmd+s");'), undefined);
  const plan = splitMenuActions('await app.pressKey("cmd+t"); await app.typeText("https://example.test"); await app.pressKey("Return");');
  // Meriyah may refuse before returning this deep tree. Exercise the consumer too.
  let object = { type: 'Identifier', name: 'app' };
  for (let i = 0; i < 30000; i++) object = { type: 'MemberExpression', object, property: { type: 'Identifier', name: 'x' } };
  plan.actions[1].node.argument.callee.object = object;
  assert.equal(nativeTabPlan(plan), false);
  const read = 's' + '.x'.repeat(30000);
  assert.equal(splitMenuActions(`await app.click(1); await app.click(2); const s = await app.getAXState(); nodeRepl.write(${read});`), undefined);
});

test('parser depth refusals never escape consumer entry points', () => {
  const value = '['.repeat(20000) + '1' + ']'.repeat(20000);
  assert.equal(splitMenuActions(`await app.click(${value}); await app.click(2);`), undefined);
  assert.equal(splitTextSave(`await app.setValue(2, ${value}); await app.pressKey("cmd+s");`), undefined);
  const plan = splitMenuActions('await app.pressKey("cmd+t"); await app.typeText("https://example.test"); await app.pressKey("Return");');
  // Exercise the entry point's own value walk, beyond what Meriyah can parse.
  let argument = { type: 'Literal', value: 'https://example.test' };
  for (let i = 0; i < 20000; i++) argument = { type: 'ArrayExpression', elements: [argument] };
  plan.actions[1].node.argument.arguments = [argument];
  assert.equal(nativeTabPlan(plan), undefined);
});

test('only const, let and var declarations may acquire or bind a read or write', () => {
  for (const kind of ['const', 'let', 'var', 'using', 'await using']) {
    const acquire = `${kind} app = await cua.getApp("Fixture"); await app.click(1); await app.click(2);`;
    const read = `await app.click(1); await app.click(2); ${kind} s = await app.getAXState(); nodeRepl.write(s);`;
    const write = `${kind} result = await app.setValue(2, "x"); await app.pressKey("cmd+s");`;
    if (!kind.includes('using')) assert.equal(parseCell(acquire).error, null, kind);
    assert.equal(Boolean(splitMenuActions(acquire)), !kind.includes('using'), acquire);
    assert.equal(Boolean(splitMenuActions(read)), !kind.includes('using'), read);
    assert.equal(Boolean(splitTextSave(write)), !kind.includes('using'), write);
  }
});

test('unknown computed action names format as a string in stop notes', () => {
  const plan = splitMenuActions('await app.pressKey("cmd+t"); await app.pressKey("Return");');
  plan.actions[0].node = parseCell('await app[method](1)').ast.body[0].expression;
  assert.match(stopNote({ windowStop: true, index: 1 }, plan), /unknown action "cmd\+t"/);
});
