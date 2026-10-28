import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { parseCell, withCellCache, UNKNOWN } from '../plugins/sleight/lib/code-ast.mjs';
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
  assert.deepEqual(result.inputs.map(input => input.value), ['SECRET']);
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
  assert.match(sent[0].params.arguments.code, /app\.typeText\("one"\)/);
  assert.match(sent[0].params.arguments.code, /getAXState/);
  assert.equal(replies.length, 0);
});

for (const change of [
  'if (x) { a = await cua.getApp("Mail") }',
  'function f(a) { a.typeText("SECRET") }',
  'const f = ({a}) => a.typeText("SECRET")',
  'try {} catch(a) { a.typeText("SECRET") }',
  'if(x) { let a = await cua.getApp("Mail"); }',
  '({a} = other)', '[a] = other',
]) test('shadowed, assigned and destructured handles cannot retain an exception: ' + change, () => {
  const rules = new FlowRules({ version: 1, rules: [{ id: 'mail', kind: 'pattern', pattern: 'SECRET', destinations: ['Mail'], except: ['Notes'] }] });
  const plan = rules.analyze('js', { code: 'let a = await cua.getApp("Notes"); ' + change + '; a.typeText("SECRET")' }, {app:'Notes'});
  assert.ok(plan.violations.some(v => v.rule === 'mail'));
  assert.equal(plan.handles.has('a'), false);
});
for (const value of ['flag ? "SECRET" : ""', 'await f("SECRET")', 'String("SECRET")', '["SE", "CRET"].join("")', '`SE${value}CRET`', '`SE${"CR"}ET`'])
  test('unknown value subtree reaches pattern rules: ' + value, () => {
    assert.equal(flow().analyze('js', {code: 'await app.typeText(' + value + ')'}, {app:'Fixture'}).violations.length, 1);
  });
for (const code of ['const t = app.typeText; t("SECRET")', 'let app=await cua.getApp("Notes"); if(x)app=await cua.getApp("Mail"); const o={t:app.typeText}; o.t("SECRET")',
  'const c=cua; const a=await c.getApp("Mail"); const o={t:a.typeText}; o.t("SECRET")', 'let h; h=app; const o={}; o.t=h.typeText; o.t("SECRET")',
  'const h=flag?app:other; const o={}; o.t=h.typeText; o.t("SECRET")',
  'const h={app}; const o={}; o.t=h.app.typeText; o.t("SECRET")', 'const o={}; o.t=app.typeText; o.t("SECRET")',
  'const o={t:flag?app.typeText:other}; o.t("SECRET")', 'const t=globalThis.app.typeText; t("SECRET")', 'const h = app; const t = h.typeText; t("SECRET")', 'const {typeText:t} = app; t("SECRET")',
  'app.typeText.call(app, "SECRET")', 'app.typeText.apply(app, ["SECRET"])', '(0,app.typeText)("SECRET")',
  'app.typeText`SECRET`', 'new app.typeText("SECRET")', 'const x = {get value(){return app.typeText}}; x.value("SECRET")'])
  test('detached or indirect guarded methods refuse before dispatch: ' + code, () => {
    assert.equal(nativeArgumentsProblem(code), 'sleight: cannot inspect JavaScript. Use direct calls with literal arguments.');
    assert.throws(() => clipboardActions(code), /cannot inspect JavaScript/);
    assert.throws(() => literalElements(code), /cannot inspect JavaScript/);
    assert.ok(flow().analyze('js', {code}, {app:'Fixture'}).violations.length);
  });
for (const code of ['(0,f)("SECRET")', 'tag`SECRET`', 'new f("SECRET")', 'import("module")'])
  test('non-member inventory feeds flow unknown policy: ' + code, () => {
    assert.ok(flow().analyze('js', {code}, {app:'Fixture'}).violations.length);
    assert.equal(calls(code, new Map(), {app:'Fixture'}).unknown, true);
  });
test('rewrites cannot derive trusted additions from caller literals', () => {
  const source = '"app.click(7)";';
  const check = dispatchInspection(source);
  let output = check.mark(source);
  output = check.rewrite(output, code => (code.includes('"app.click(7)"') ? 'app.click(7);' : '') + code);
  assert.equal(check.verify(output), false);
});

test('all consumers reuse one immutable syntax tree for a cell', () => {
  const source = 'await app.click(7);';
  const first = parseCell(source);
  calls(source, new Map()); nativeArgumentsProblem(source); literalElements(source); clipboardActions(source);
  assert.equal(parseCell(source), first);
  assert.equal(parseCell(source).ast, first.ast);
});

test('unbound destinations cannot inherit the last window app exception', () => {
  const rules=new FlowRules({version:1,rules:[{id:'mail',kind:'pattern',pattern:'SECRET',destinations:['Mail'],except:['Notes']}]});
  assert.equal(rules.analyze('js',{code:'await other.typeText("SECRET")'},{app:'Notes'}).violations.length,1);
});

test('request-scoped AST reuse covers cells larger than the cross-request cache', () => {
  const source='['+'0,'.repeat(140000)+'0]; await app.click(7);';
  withCellCache(()=>{
    const first=parseCell(source);
    assert.equal(first.error,null);
    for(let i=0;i<40;i++)parseCell('void '+i);
    assert.equal(parseCell(source),first);
    withCellCache(()=>assert.equal(parseCell(source).ast,first.ast));
  });
});

test('all four request consumers handle an array beyond the former spread limit', () => {
  const source='const pad=['+'0,'.repeat(140000)+'0]; await app.typeText("SECRET"); await app.click(7); await app.pressKey("super+c");';
  withCellCache(()=>{
    assert.equal(flow().analyze('js',{code:source},{app:'Fixture'}).violations.length,1);
    assert.equal(nativeArgumentsProblem(source),undefined);
    assert.deepEqual(literalElements(source),[7]);
    assert.deepEqual(clipboardActions(source),['c']);
    const check=dispatchInspection(source);
    assert.equal(check.verify(check.mark(source)),true);
  });
});
