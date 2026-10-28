import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statementSpans, splitTextSave } from '../plugins/sleight/lib/text-save.mjs';
import { splitMenuActions, stopNote } from '../plugins/sleight/lib/menu-continuation.mjs';
import { nativeTabPlan } from '../plugins/sleight/lib/tab-probe.mjs';

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
