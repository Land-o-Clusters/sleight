import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { parseCell, UNKNOWN } from '../plugins/sleight/lib/code-ast.mjs';
import { calls, FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { nativeArgumentsProblem } from '../plugins/sleight/lib/native-arguments.mjs';
import { literalElements } from '../plugins/sleight/lib/literal-elements.mjs';
import { clipboardActions, clipboardCode } from '../plugins/sleight/lib/clipboard.mjs';
import { argumentValue } from '../plugins/sleight/lib/call-inspection.mjs';
import { dispatchInspection, sameGuardedCalls } from '../plugins/sleight/lib/dispatched-calls.mjs';
import { guardedCode, readCode } from '../plugins/sleight/lib/document-scope.mjs';
import { createRelay, finalReturnCode, nativeGetStateCode } from '../plugins/sleight/lib/relay.mjs';

const flow = () => new FlowRules({ version: 1, rules: [{ id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] }] });
for (const member of ['.typeText', '["typeText"]', '[`typeText`]', '.typeText?.', '?.typeText', '.\\u0074ypeText']) {
  test(`flow inventory recognizes ${member}`, () => {
    const code = `await app${member}("SECRET");`;
    assert.equal(flow().analyze('js', { code }, { app: 'Fixture' }).violations.length, 1);
  });
}
for (const code of ['`${await app.typeText("SECRET")}`', 'if (a) {} /[/*]/.test(s); await app.typeText("SECRET")',
  'function f() { app.typeText("SECRET") }', 'await app.typeText(await app.typeText("SECRET"))']) {
  test(`AST finds nested or formerly ambiguous flow input: ${code}`, () => {
    assert.equal(flow().analyze('js', { code }, { app: 'Fixture' }).violations.length, 1);
  });
}
test('flow records non-literal arguments as unknown without inventing literal data', () => {
  const result = calls('app.typeText(value); app.setValue(1, `SECRET${value}`)', new Map(), { app: 'Fixture' });
  assert.equal(result.inputs.length, 0);
  assert.equal(result.unknownInputs.length, 2);
  assert.equal(calls('app[method]("SECRET")', new Map()).unknownInputs[0].method, UNKNOWN);
});
test('unknown assignments clear a flow handle hint instead of retaining an app exception', () => {
  const result = calls('let out = await cua.getApp("Mail"); out += other;', new Map());
  assert.equal(result.readApp, 'Mail');
  const handles = new Map([['out', { app: 'Mail' }]]);
  calls('out ||= other;', handles);
  assert.equal(handles.has('out'), false);
});
for (const prefix of ['let editor = __sleightOpenedApp2;', 'let editor = await cua.getApp("Fixture");',
  'let editor = await cua.getApp({windowId: 2});', 'let app = await cua.getApp("Fixture"); let editor = app;']) {
  test(`native binding checks known mistakes: ${prefix}`, () => {
    assert.match(nativeArgumentsProblem(prefix + ' editor["pressKey"]?.(2)'), /invalid native arguments/);
  });
}
test('native partial options retain a known mistake beside an unknown expression', () => {
  assert.match(nativeArgumentsProblem('app.click([x,y], {button: side})'), /mouseButton/);
  assert.match(nativeArgumentsProblem('app.click([x,"bad"])'), /invalid native/);
  assert.equal(nativeArgumentsProblem('app.click([x,y], {key:modifier})'), undefined);
  assert.equal(nativeArgumentsProblem('app.pressKey(...keys)'), undefined);
  assert.equal(argumentValue(parseCell('[value]').ast.body[0].expression)[0], UNKNOWN);
});
test('a browser binding and a reassigned native alias lose the native signature', () => {
  assert.equal(nativeArgumentsProblem('let app = await cua.getTab("1"); app.pressKey(null, "Return")'), undefined);
  assert.equal(nativeArgumentsProblem('let editor = await cua.getApp("Fixture"); editor = other; editor.pressKey(2)'), undefined);
});
test('a direct acquired receiver retains its native signature and flow destination', () => {
  assert.match(nativeArgumentsProblem('(await cua.getApp("Fixture")).pressKey(2)'), /invalid native/);
  const rules = new FlowRules({ version: 1, rules: [{ id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['Mail'] }] });
  assert.equal(rules.analyze('js', { code: '(await cua.getApp("Mail")).typeText("SECRET")' }, { app: 'Other' }).violations.length, 1);
});
for (const member of ['.click', '["click"]', '[`click`]', '.click?.', '?.click', '.\\u0063lick']) {
  test(`literal number inventory recognizes ${member}`, () => assert.deepEqual(literalElements(`app${member}(7); app${member}(7)`), [7, 7]));
}
test('interpolated templates retain the empty pending-number contract', () => {
  assert.deepEqual(literalElements('app.click(7); `${app.click(8)}`; app.click(9)'), []);
  assert.deepEqual(literalElements('app.click(index); app.click([1,2]); app.click(0x10)'), [16]);
});
for (const member of ['.pressKey', '["pressKey"]', '[`pressKey`]', '.pressKey?.', '?.pressKey', '.\\u0070ressKey']) {
  test(`clipboard inventory recognizes ${member}`, () => assert.deepEqual(clipboardActions(`app${member}("super+c", options)`), ['c']));
}
test('clipboard sees nested actions and leaves unknown keys to its runtime permit', () => {
  assert.deepEqual(clipboardActions('`${app.pressKey("cmd+x")}`; app.paste(text); app.pressKey(key)'), ['x', 'paste']);
  assert.equal(clipboardActions('app[method]()').unknown, 1);
  assert.equal(literalElements('app[method]()').unknown, 1);
});
for (const mutation of [code => code.replace('"one"', '"two"'), code => code.replace('app.', 'other.'),
  code => code.replace('typeText', 'paste'), code => code + '\napp.click(3)', code => '"' + code.replaceAll('"', '\\"') + '"',
  code => code.replace('app.typeText', 'app["typeText"]'), code => code.replace('typeText(', 'typeText?.(')]) {
  test('dispatched multiset refuses changed callee, argument, count or syntax', () => {
    assert.equal(sameGuardedCalls('app.typeText("one")', mutation('app.typeText("one")')), false);
  });
}
test('multiset retains duplicate occurrences, unknown argument shape and literal normalization', () => {
  assert.equal(sameGuardedCalls('app.click(7); app.click(7)', 'app.click(7)'), false);
  assert.equal(sameGuardedCalls('app.typeText(value)', 'app.typeText(other)'), false);
  assert.equal(sameGuardedCalls('app.click(0x10)', 'app.click(16)'), true);
  assert.equal(sameGuardedCalls('app.click(1); app.click(2)', 'app.click(2); app.click(1)'), true);
  assert.equal(sameGuardedCalls('await cua.getApp("Mail")', 'await cua.getApp("Other")'), false);
});
test('a wrapper cannot turn an inert caller expression into a guarded call', () => {
  const check = dispatchInspection('1');
  const output = check.wrap(check.mark('1'), code => 'app.click(' + code + ')');
  assert.equal(check.verify(output), false);
});
test('unknown BigInt and tagged-template arguments retain their syntax without evaluation', () => {
  assert.equal(sameGuardedCalls('app.typeText(1n)', 'app.typeText(1n)'), true);
  assert.equal(sameGuardedCalls('app.typeText(1n)', 'app.typeText(2n)'), false);
  assert.equal(sameGuardedCalls('app.typeText(tag`\\xg`)', 'app.typeText(tag`\\xh`)'), false);
});
test('final-return repair and native-getState repair retain guarded calls', () => {
  const source = 'await app.click(7); return await app.getState();';
  const repaired = finalReturnCode(source);
  assert.equal(sameGuardedCalls('async function f(){' + source + '}', repaired), true);
  assert.equal(sameGuardedCalls(repaired, nativeGetStateCode(repaired)), true);
});
test('full dispatched parse includes trusted guard and clipboard prefixes', () => {
  const source = 'await app.typeText("one"); // final comment';
  const check = dispatchInspection(source);
  let output = check.wrap(check.mark(source), code => guardedCode(code, { app: 'Fixture', title: 'Draft' }));
  output = check.rewrite(output, code => clipboardCode(code));
  assert.equal(check.verify(output), true);
  assert.equal(check.verify(output.replace('app.typeText("one")', 'app.typeText("two")')), false);
  assert.equal(check.verify(output + '\napp.click(4)'), false);
});
test('read wrapper keeps a bare app acquisition and its assignment', () => {
  const source = 'await cua.getApp("Fixture")', check = dispatchInspection(source);
  const output = check.wrap(check.mark(source), code => readCode(code));
  assert.match(output, /globalThis.app =/);
  assert.equal(check.verify(output), true);
});
test('final parse refuses a rewritten caller hidden in a string or comment', () => {
  const source = 'app.click(7)', check = dispatchInspection(source), marked = check.mark(source);
  assert.equal(check.verify('`' + marked + '`'), false);
  assert.equal(check.verify('/*' + marked + '*/'), false);
});
test('relay dispatch preserves caller input through the actual wrappers', t => {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, sent = [], replies = [];
  serverIn.on('data', bytes => sent.push(JSON.parse(bytes)));
  clientOut.on('data', bytes => replies.push(JSON.parse(bytes)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => { relay.dispose(); streams.forEach(stream => stream.destroy()); });
  clientIn.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'await app.typeText("one"); return await app.getState();' } } }) + '\n');
  assert.equal(sent.length, 1, JSON.stringify(replies));
  assert.match(sent[0].params.arguments.code, /getAXState/);
});
