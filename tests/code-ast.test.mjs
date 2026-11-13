import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { ENGINE_PARSE_OPTIONS, UNKNOWN, parseCell, statements, memberCall, literalValue,
  handleBindings, arrowRegexTest, walk } from '../plugins/sleight/lib/code-ast.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const astOf = code => {
  const { ast, error } = parseCell(code);
  assert.equal(error, null, JSON.stringify(error));
  return ast;
};
const expression = code => astOf(code).body[0].expression;
const callsOf = code => [...walk(astOf(code))].map(memberCall).filter(Boolean);
const payloads = code => callsOf(code).filter(call => call.method === 'typeText').map(call => literalValue(call.args[0]));

// FR1, FR1R, FR2 and FR3 review shapes, parsed as modules rather than sloppy scripts.
const visible = [
  ['logical and before quote regex', 'text && /\'/.test(text); app.typeText("PAYLOAD")'],
  ['if before quote regex', 'if (c) /\'/.test(s); app.typeText("PAYLOAD")'],
  ['semicolon before quote regex', '; /"/.test(s); app.typeText("PAYLOAD")'],
  ['block before comment-looking regex', 'if (a) {}\n/[/*]/.test(s); app.typeText("PAYLOAD"); /[*/]/.test(s)'],
  ['function before regex', 'function f(){}\n/[/*]/.test(s); app.typeText("PAYLOAD"); /[*/]/.test(s)'],
  ['class before regex', 'class A extends B{}\n/[/*]/.test(s); app.typeText("PAYLOAD"); /[*/]/.test(s)'],
  ['arrow body before regex', 'const f=()=>{}\n/[/*]/.test(s); app.typeText("PAYLOAD"); /[*/]/.test(s)'],
  ['unary plus regex', 'var a=+/ // app.typeText("PAYLOAD")'],
  ['unary tilde regex', 'var a=~/ // app.typeText("PAYLOAD")'],
  ['minus before regex', 'var a=1- /x/ / app.typeText("PAYLOAD")'],
  ['multiply before regex', 'var a=2 * /\'/ / app.typeText("PAYLOAD"); var t=/\'/'],
  ['modulo before regex', 'var a=2 % /\'/ / app.typeText("PAYLOAD"); var t=/\'/'],
  ['divide by regex', 'var a=2 / /\'/ / app.typeText("PAYLOAD"); var t=/\'/'],
  ['of operand', 'for(var c of /\'/.exec("x")||[1]) app.typeText("PAYLOAD"); var q=/\'/'],
  ['for await control', 'for await(var c of [1]) /\'/.test(c); app.typeText("PAYLOAD"); /\'/.test(c)'],
  ['dot string', 's.replace(".", /\'/); app.typeText("PAYLOAD"); s.replace(".", /\'/)'],
  ['hash string', 's.replace("#", /\'/); app.typeText("PAYLOAD"); s.replace("#", /\'/)'],
  ['dot string with in', '"." in /\'/ || app.typeText("PAYLOAD"); var t=/\'/'],
  ['trailing-dot division', 'x=1. / app.typeText("PAYLOAD") / 2'],
  ['spread before typeof', '[...typeof /"/, app.typeText("PAYLOAD"), /"/]'],
  ['spread before await', '[...await /"/, app.typeText("PAYLOAD"), /"/]'],
  ['spread before yield', 'function* f(){[...yield /"/, app.typeText("PAYLOAD"), /"/]}'],
  ['nested backtick string', 'var z=`${"`"}`; app.typeText("PAYLOAD"); var w=`${"`"}`'],
  ['interpolation call', '`${app.typeText("PAYLOAD")}`'],
  ['nested interpolation call', '`${`${app.typeText("PAYLOAD")}`}`'],
  ['label and break ASI', 'x: while(ok){break x\n/[/*]/.test(s); app.typeText("PAYLOAD"); /[*/]/.test(s)}'],
  ['do while ASI', 'do{}while(ok)\n/[/*]/.test(s); app.typeText("PAYLOAD"); /[*/]/.test(s)'],
  ['keyword member division', 'a.in / 2; a?.typeof / 2; app.typeText("PAYLOAD")'],
  ['post decrement division', 'i-- / 2; app.typeText("PAYLOAD")'],
  ['non HTML decrement', 'i-->0; app.typeText("PAYLOAD")'],
  ['escaped identifiers', 'a\\u0070p.typeT\\u0065xt("PAYLOAD")'],
  ['block comment', 'app./*gap*/typeText("PAYLOAD")'],
];
for (const [name, code] of visible) test(`review: ${name}`, () => assert.deepEqual(payloads(code), ['PAYLOAD']));
for (const [name, end] of [['LF', '\n'], ['CR', '\r'], ['LS', '\u2028'], ['PS', '\u2029'], ['CRLF', '\r\n']]) {
  test(`review: ${name} line comment ends`, () => assert.deepEqual(payloads(`// c${end}app.typeText("PAYLOAD")`), ['PAYLOAD']));
}
for (const [name, code] of [
  ['HTML open', '<!-- /*\napp.typeText("PAYLOAD");\n// */'],
  ['HTML close', '--> /*\napp.typeText("PAYLOAD");\n// */'],
  ['strict yield identifier', 'var yield=4; yield / app.typeText("PAYLOAD") / 1'],
  ['raw CR string', '"a\rb"'],
  ['raw LS regex', '/a\u2028b/'],
  ['top-level return', 'return 1'],
]) test(`module refusal: ${name}`, () => assert.ok(parseCell(code).error));
for (const declaration of ['var', 'let']) test(`engine parser refusal: ASI after ${declaration}`, () => {
  const result = parseCell(`${declaration} v\n/[/*]/.test(s); app.typeText("PAYLOAD"); /[*/]/.test(s)`);
  assert.deepEqual(result.error, { line: 2, column: 0, reason: "Unexpected token: '/'" });
});
test('hashbang is accepted by the cell parser, before the engine prepends its prelude', () => {
  assert.equal(astOf('#!x\napp.click(3)').body.length, 1);
});

test('exact engine options, strict module and top-level await ranges', () => {
  assert.deepEqual(ENGINE_PARSE_OPTIONS, { next: true, module: true, ranges: true, loc: false, disableWebCompat: true });
  const code = 'await app.click(3);\nnodeRepl.write("done")';
  const ast = astOf(code);
  assert.equal(ast.sourceType, 'module');
  assert.equal(ast.loc, undefined);
  assert.deepEqual(statements(ast).map(s => code.slice(...s.range)), ['await app.click(3);', 'nodeRepl.write("done")']);
});
test('ES2019 LS and PS in strings and template CR normalization', () => {
  assert.equal(literalValue(expression('"a\u2028\u2029b"')), 'a\u2028\u2029b');
  assert.equal(literalValue(expression('`a\r\nb`')), 'a\nb');
  assert.equal(literalValue(expression('`a\rb\\rc`')), 'a\nb\rc');
  assert.equal(literalValue(expression('"a\\\r\nb"')), 'ab');
});
test('memberCall exposes receiver nodes, literal computed names and optional flags', () => {
  for (const [code, computed, optional] of [['app.click(3)', false, false], ['app["click"](3)', true, false],
    ['app.click?.(3)', false, true], ['app?.click(3)', false, true], ['app?.["click"]?.(3)', true, true]]) {
    const call = memberCall(expression(code));
    assert.equal(call.receiver.name, 'app'); assert.equal(call.method, 'click');
    assert.equal(call.computed, computed); assert.equal(call.optional, optional);
    assert.equal(literalValue(call.args[0]), 3);
  }
  assert.equal(memberCall(expression('app[method](3)')).method, UNKNOWN);
  assert.equal(memberCall(expression('click(3)')), null);
});
test('memberCall optional chain metadata ignores optional expressions in factory arguments', () => {
  assert.equal(memberCall(expression('factory(options?.name).click(3)')).optional, false);
  assert.equal(memberCall(expression('factory?.(options.name).click(3)')).optional, true);
  assert.equal(memberCall(expression('factory(options.name)?.click(3)')).optional, true);
});
test('literalValue returns recursive data, preserving __proto__ as an own key', () => {
  const value = literalValue(expression('({a:[1,true,null,`x`], "__proto__": "data"})'));
  assert.deepEqual(value.a, [1, true, null, 'x']);
  assert.equal(Object.hasOwn(value, '__proto__'), true); assert.equal(value.__proto__, 'data');
});
test('unknown is distinct from null, false, zero and an empty string', () => {
  for (const code of ['name', 'f()', '`x${1}`', '({a:f()})', '({...x})', '[...x]', '[,]', '({get a(){return 1}})', '({[x]:1})', '/x/', '1n'])
    assert.equal(literalValue(expression(code)), UNKNOWN, code);
  for (const [code, value] of [['null', null], ['false', false], ['0', 0], ['""', ''], ['-3', -3]])
    assert.equal(literalValue(expression(code)), value);
});
test('handleBindings identifies opened apps, literal acquisitions and browser locator chains', () => {
  const bindings = handleBindings(astOf('let app=__sleightOpenedApp2; const t=await cua.getApp("TextEdit"); const b=await cua.getBrowser(); const tab=await b.tabs.get("1"); const button=tab.playwright.getByRole("button").first();'));
  assert.equal(bindings.get('app').source, '__sleightOpenedApp2');
  assert.equal(bindings.get('t').app, 'TextEdit');
  assert.equal(bindings.get('b').kind, 'browser');
  assert.equal(bindings.get('tab').kind, 'browser');
  assert.equal(bindings.get('button').kind, 'locator');
});
test('bindings are structural hints, scoped to top level and invalidated by reassignment', () => {
  const bindings = handleBindings(astOf('const b=await cua.getBrowser(); let x=b.playwright.getByText("x"); x=3; if(true){let hidden=await cua.getApp("X")} const dynamic=await cua.getApp(name);'));
  assert.equal(bindings.has('hidden'), false); assert.equal(bindings.has('x'), false); assert.equal(bindings.has('dynamic'), false);
});
test('arrowRegexTest accepts only a single parameter directly tested by a regex literal', () => {
  assert.deepEqual(arrowRegexTest(expression('l => /save|open/i.test(l)')), { parameter: 'l', pattern: 'save|open', flags: 'i' });
  for (const code of ['l=>r.test(l)', 'l=>/x/.test(other)', '(l,x)=>/x/.test(l)', 'async l=>/x/.test(l)', 'l=>{return /x/.test(l)}', 'l=>/x/.test?.(l)'])
    assert.equal(arrowRegexTest(expression(code)), null, code);
});
test('vendor files are pinned unmodified', () => {
  const require = createRequire(import.meta.url);
  const vendor = new URL('../plugins/sleight/vendor/meriyah/dist/meriyah.min.mjs', import.meta.url);
  assert.equal(createHash('sha256').update(readFileSync(vendor)).digest('hex'), 'd29a5ff8e5fbdb8cb0617a721891fb1d3fb107883dc6f4ee9bda5b32896edf50');
  assert.equal(require(vendor.pathname).version, '7.0.0');
});
test('a fresh process loads the vendor only when it first parses a cell', () => {
  const moduleUrl = new URL('../plugins/sleight/lib/code-ast.mjs', import.meta.url).href;
  const vendor = new URL('../plugins/sleight/vendor/meriyah/dist/meriyah.min.mjs', import.meta.url).pathname;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    const require=createRequire(import.meta.url);
    const {parseCell}=await import(${JSON.stringify(moduleUrl)});
    if(require.cache[${JSON.stringify(vendor)}]) throw new Error('eager parser');
    parseCell('await app.click(3)');
    if(!require.cache[${JSON.stringify(vendor)}]) throw new Error('parser not loaded');
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
});
test('parse error contains only meriyah location and reason, no source or stack', () => {
  const result = parseCell('const marker="PRIVATE-TEXT";\nconst = 1');
  assert.equal(result.ast, null); assert.equal(result.error.line, 2);
  assert.ok(Number.isInteger(result.error.column)); assert.equal(typeof result.error.reason, 'string');
  assert.ok(!JSON.stringify(result.error).includes('PRIVATE-TEXT'));
  assert.deepEqual(Object.keys(result.error), ['line', 'column', 'reason']);
});
test('relay refuses code and command parse errors before any server request', t => {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const sent = [], replies = [];
  serverIn.on('data', data => sent.push(data.toString()));
  clientOut.on('data', data => replies.push(...data.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => { relay.dispose(); streams.forEach(stream => stream.destroy()); });
  for (const [id, key] of [[1, 'code'], [2, 'command']]) clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { [key]: 'const secret="PRIVATE-TEXT";\nconst = 1' } } }) + '\n');
  assert.equal(sent.length, 0); assert.equal(replies.length, 2);
  for (const reply of replies) {
    assert.equal(reply.result.isError, true); assert.match(reply.result.content[0].text, /JS \[2:\d+\]:/);
    assert.ok(!JSON.stringify(reply).includes('PRIVATE-TEXT'));
  }
});
