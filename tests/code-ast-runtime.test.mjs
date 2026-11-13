import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { parseCell, parserDoctorLine, callInventory, memberCall, handleBindings, literalValue } from '../plugins/sleight/lib/code-ast.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const astOf = code => {
  const result = parseCell(code);
  assert.equal(result.error, null, JSON.stringify(result.error));
  return result.ast;
};
const nested = '('.repeat(20_000) + '1' + ')'.repeat(20_000);

test('all parser exceptions fail closed, including stack overflow and invalid input', () => {
  for (const code of [nested, null, {}, 12]) {
    assert.deepEqual(parseCell(code), { ast: null, error: { line: 0, column: 0, reason: 'cannot parse this cell' } });
  }
});

test('relay survives deep nesting through both aliases and accepts a later request', t => {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const sent = [], replies = [];
  serverIn.on('data', data => sent.push(JSON.parse(data)));
  clientOut.on('data', data => replies.push(JSON.parse(data)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => { relay.dispose(); streams.forEach(stream => stream.destroy()); });
  for (const [id, key] of [[1, 'code'], [2, 'command']]) {
    assert.doesNotThrow(() => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { [key]: nested } } }) + '\n'));
  }
  assert.equal(sent.length, 0);
  assert.equal(replies.length, 2);
  for (const reply of replies) {
    assert.equal(reply.result.isError, true);
    assert.equal(reply.result.content[0].text, 'JS [0:0]: cannot parse this cell');
  }
  clientIn.write(JSON.stringify({ id: 3, method: 'tools/call', params: { name: 'js', arguments: { code: 'nodeRepl.write(1)' } } }) + '\n');
  assert.ok(sent.some(message => message.id === 3));
});

for (const [name, failure] of [
  ['missing vendor', "Object.assign(new Error('PRIVATE vendor path'), {code:'MODULE_NOT_FOUND'})"],
  ['unsupported synchronous ESM', "Object.assign(new Error('PRIVATE loader error'), {code:'ERR_REQUIRE_ESM'})"],
]) test(`${name} refuses admission and supplies a Node doctor line`, () => {
  const facade = new URL('../plugins/sleight/lib/code-ast.mjs', import.meta.url).href;
  const relayUrl = new URL('../plugins/sleight/lib/relay.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import Module from 'node:module';
    import { PassThrough } from 'node:stream';
    const {parseCell, parserDoctorLine} = await import(${JSON.stringify(facade)});
    const {createRelay} = await import(${JSON.stringify(relayUrl)});
    const original = Module._load;
    Module._load = function(path, ...args) {
      if (path.includes('vendor/meriyah/')) throw ${failure};
      return original.call(this, path, ...args);
    };
    const result = parseCell('app.click(3)');
    assert.equal(result.ast, null);
    assert.equal(result.error.line, 0);
    assert.ok(result.error.reason.includes('cannot parse this cell: parser unavailable on Node ' + process.version));
    assert.ok(result.error.reason.includes('Node 22.12+'));
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
    assert.equal(parserDoctorLine(), 'PROBLEM cell parser: unavailable; Node ' + process.version + '. Use Node 22.12+ with synchronous ESM loading.');
    const streams = Array.from({length:4}, () => new PassThrough());
    const [clientIn, clientOut, serverIn, serverOut] = streams, sent = [], replies = [];
    serverIn.on('data', data => sent.push(JSON.parse(data)));
    clientOut.on('data', data => replies.push(JSON.parse(data)));
    const relay = createRelay({clientIn, clientOut, serverIn, serverOut, changeReview:false});
    for (const key of ['code','command']) clientIn.write(JSON.stringify({id:key, method:'tools/call', params:{name:'js',arguments:{[key]:'app.click(3)'}}}) + '\\n');
    assert.equal(sent.length, 0);
    assert.equal(replies.length, 2);
    assert.ok(replies.every(reply => reply.result.isError && reply.result.content[0].text.includes('parser unavailable')));
    relay.dispose(); streams.forEach(stream => stream.destroy());
    Module._load = original;
    assert.equal(parseCell('1').error, null);
  `], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
});

test('doctor line names the actual Node runtime and loaded parser', () => {
  assert.equal(parserDoctorLine(), `cell parser: loaded Meriyah 7.0.0; Node ${process.version}`);
});

test('duplicate-binding diagnostics are capped at 200 characters and strip controls', () => {
  const facade = new URL('../plugins/sleight/lib/code-ast.mjs', import.meta.url).href;
  const vendor = new URL('../plugins/sleight/vendor/meriyah/dist/meriyah.min.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import Module from 'node:module';
    const actual = await import(${JSON.stringify(vendor)});
    const {parseCell} = await import(${JSON.stringify(facade)});
    const original = Module._load;
    // The pinned engine options omit lexical checking. Exercise the real vendor's
    // duplicate-binding diagnostic with lexical enabled only in this test loader.
    Module._load = function(path, ...args) {
      if (path.includes('vendor/meriyah/')) return {
        parseModule(code, options) {
          if (code === 'CONTROL') throw Object.assign(new SyntaxError(), {
            description:'Duplicate binding \\u0000\\r\\n\\t\\u007f\\u0085\\u2028\\u2029end'
          });
          return actual.parseModule(code, {...options, lexical:true});
        }
      };
      return original.call(this, path, ...args);
    };
    for (const name of ['identifier'.repeat(1000), 'a\\u200cb']) {
      const {ast, error} = parseCell('let ' + name + '; let ' + name + ';');
      assert.equal(ast, null);
      assert.ok(error.reason.startsWith('Duplicate binding'));
      assert.equal(error.reason.length, name.length > 200 ? 200 : 22);
      assert.ok(!/[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]/u.test(error.reason));
    }
    assert.deepEqual(parseCell('CONTROL').error, {line:0, column:0, reason:'Duplicate binding end'});
  `], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
});

test('raw CR in a string retains escape guidance', () => {
  const { error } = parseCell('app.typeText("PRIVATE\rTEXT")');
  assert.match(error.reason, /Unterminated string literal/);
  assert.match(error.reason, /Escape literal CR as \\r\./);
  assert.doesNotMatch(error.reason, /PRIVATE|TEXT/);
});

for (const mutation of [
  'app = other', 'app = await cua.getApp("Other")', 'app = other = third',
  'other = app = third', 'if (ok) { app = other }', 'app++', '--app', 'app += other',
  '[app] = source', '({key: app} = source)', '({[key]: app = fallback} = source)',
  '({key: [,...app]} = source)', 'for (app of source) {}', 'for (app in source) {}',
  'for ([app] of source) {}', 'for (const {key: app} of source) {}',
  'function later() { app = other }', 'const later = () => { app++ }',
  'class Later { method() { ({key: app} = source) } }',
]) test(`binding hints drop all assignment targets: ${mutation}`, () => {
  const previous = new Map([['keep', { kind: 'app', app: 'Keep' }], ['app', { kind: 'app', app: 'Old' }]]);
  const bindings = handleBindings(astOf('let app=await cua.getApp("Fixture"); ' + mutation), previous);
  assert.equal(bindings.has('app'), false);
  assert.equal(bindings.get('keep').app, 'Keep');
  assert.equal(previous.get('app').app, 'Old');
});

test('mutated prior bindings cannot seed later locator hints', () => {
  const previous = new Map([['tab', { kind: 'browser' }]]);
  const bindings = handleBindings(astOf('const button=tab.playwright.getByText("x"); function later(){tab=other}'), previous);
  assert.equal(bindings.has('tab'), false);
  assert.equal(bindings.has('button'), false);
});

test('destructuring declarations clear prior hints without invalidating property keys', () => {
  const previous = new Map([['app', { kind: 'app' }], ['key', { kind: 'browser' }]]);
  const bindings = handleBindings(astOf('const {key: app} = source'), previous);
  assert.equal(bindings.has('app'), false);
  assert.equal(bindings.has('key'), true);
});

test('member writes do not rebind their receiver or computed property identifiers', () => {
  const bindings = handleBindings(astOf('let app=await cua.getApp("Fixture"); app[key] = other; app.count++;'));
  assert.equal(bindings.get('app').app, 'Fixture');
});

test('call inventory includes every call, constructor and tag exactly once', () => {
  const code = 'await app.click(3); app?.typeText?.("x"); (0, app.typeText)("indirect"); app[method](1); app["click"](2); new app.Widget(factory()); app.typeText`tag${helper()}`; function later(){ f(); }';
  const calls = callInventory(astOf(code));
  assert.equal(calls.length, 10);
  assert.equal(new Set(calls.map(call => call.node)).size, 10);
  assert.deepEqual(calls.map(call => call.node.type), [
    'CallExpression', 'CallExpression', 'CallExpression', 'CallExpression', 'CallExpression',
    'NewExpression', 'CallExpression', 'TaggedTemplateExpression', 'CallExpression', 'CallExpression',
  ]);
  assert.deepEqual(calls.map(call => call.kind), ['member', 'member', ...Array(8).fill('unknown')]);
  for (const call of calls.filter(call => call.kind === 'member')) {
    const { node, kind, ...shape } = call;
    assert.deepEqual(shape, memberCall(node));
  }
  assert.equal(literalValue(calls[0].args[0]), 3);
  assert.equal(calls[1].optional, true);
});

test('inventory visits nested receivers, arguments, templates and function bodies', () => {
  const calls = callInventory(astOf('factory().click(inner()); `${new Widget()}`; (() => tag`x`)();'));
  assert.equal(calls.length, 6);
  assert.equal(calls[0].kind, 'member');
  assert.equal(calls[0].method, 'click');
  assert.deepEqual(calls.slice(1).map(call => call.kind), Array(5).fill('unknown'));
});

test('literal __proto__ is an own data field with an unchanged prototype', () => {
  const value = literalValue(astOf('({__proto__: "x"})').body[0].expression);
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(value, '__proto__'), { value: 'x', writable: true, enumerable: true, configurable: true });
});

test('callInventory lists dynamic import and super calls as unknown', () => {
  const calls = callInventory(astOf('const m = await import("x"); class A extends B { constructor() { super(); super.m(1); } }'));
  const kinds = calls.map(c => `${c.node.type}:${c.kind}`);
  assert.ok(kinds.includes('ImportExpression:unknown'), kinds.join(','));
  assert.equal(calls.filter(c => c.node.type === 'CallExpression').length, 2);
  assert.ok(calls.filter(c => c.node.type === 'CallExpression').every(c => c.kind === 'unknown'), kinds.join(','));
});

test('walk handles a 200,000-element array without a RangeError', () => {
  const code = `const a = [${Array.from({ length: 200000 }, () => '0').join(',')}]; app.click(1);`;
  const calls = callInventory(astOf(code));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'member');
});
