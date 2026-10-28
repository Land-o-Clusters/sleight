import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';

const signature = 'pressKey(key: string, options?: PressKeyOptions)';
const tree = 'Window: "Draft", App: Fixture Editor.\n0 standard window Draft\n\t1 text field (settable) Body';
const window = { title: 'Draft', app: 'Fixture Editor', url: null };
function fixture(t, options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough();
  const serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [];
  serverIn.on('data', chunk => sent.push(JSON.parse(chunk.toString())));
  clientOut.on('data', chunk => received.push(JSON.parse(chunk.toString())));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, ...options });
  t.after(() => relay.close());
  return { sent, received, call(code, id = 1) {
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  }, reply(id) {
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: tree }],
      _meta: { 'codex/toolSurface': { kind: 'computerUse', app: { appId: 'org.test.editor' } } } } }) + '\n');
  }, engineReply(reply) { serverOut.write(JSON.stringify({ jsonrpc: '2.0', ...reply }) + '\n'); } };
}

for (const args of ['2, "super+Down"', 'null, "Return"', '{}', '""', '"Return", "extra"', '"Return", { durationMs: "long" }', '']) {
  test(`relay refuses malformed native pressKey(${args}) before forwarding`, t => {
    const f = fixture(t);
    f.call(`await app.pressKey(${args}); await app.pressKey("Return");`);
    assert.equal(f.sent.length, 0);
    const result = f.received.at(-1).result;
    assert.equal(result.isError, true);
    assert.equal(result.content.length, 1);
    const note = result.content[0].text;
    assert.ok(note.includes(signature), note);
    assert.match(note, /nothing was sent/);
    assert.doesNotMatch(note, /\n|TypeError|outcome unconfirmed|partial input possible/);
  });
}

test('malformed literal stops the whole batch before acquisition or an earlier valid action', t => {
  const f = fixture(t);
  f.call('let tgt = await cua.getApp("Fixture Editor"); await tgt.typeText("hello"); await tgt.pressKey(2, "super+Down");');
  assert.equal(f.sent.length, 0);
  assert.match(f.received.at(-1).result.content[0].text, /nothing was sent/);
});

for (const options of ['{ button: "right" }', '{ "button": "right" }', '{ button: side }',
  '{ button: "left", mouseButton: "right" }']) {
  test(`native click rejects the ignored button option before the whole batch: ${options}`, t => {
    const f = fixture(t);
    f.call(`let editor = await cua.getApp("Fixture Editor"); await editor.pressKey("Return"); await editor.click([40, 20], ${options});`);
    assert.equal(f.sent.length, 0);
    const reply = f.received.at(-1).result;
    assert.equal(reply.isError, true);
    assert.equal(reply.content[0].text, 'sleight: click(target,{mouseButton:"right"}); nothing sent.');
  });
}

test('computed native button option refuses before a read or click and gives the right-click form', async () => {
  const sent = [];
  const raw = { getAXState: async () => { sent.push('read'); return tree; }, click: async () => sent.push('click') };
  const realm = { app: raw, options: { button: 'right' }, cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
  await assert.rejects(runInNewContext(`(async () => { ${guardedCode('await app.click([40, 20], options);', window)} })()`, realm),
    { message: 'sleight: click(target,{mouseButton:"right"}); nothing sent for this action.' });
  assert.deepEqual(sent, []);
});

test('WD6c alias of an acquired app gets the native signature', t => {
  const f = fixture(t);
  f.call('let opened = await cua.getApp("Fixture Editor");'); f.reply(1);
  f.sent.length = 0;
  f.call('let tgt = opened; await tgt.pressKey(2, "super+Down"); await tgt.pressKey(null, "Return");', 2);
  assert.equal(f.sent.length, 0);
  assert.ok(f.received.at(-1).result.content[0].text.includes(signature));
});

for (const [method, args] of [
  ['click', 'null'], ['click', '[1, "two"]'], ['click', '[, 2]'], ['click', '1, { key: 2 }'],
  ['selectText', '1, null'], ['selectText', '1, "hello", { prefix: 2 }'],
  ['typeText', '2, "hello"'], ['typeText', '{}'],
  ['scroll', '1, {}'], ['scroll', '[1, 2], "down", "many"'],
  ['drag', '[1, 2], null'], ['drag', '[1, 2, 3], [4, 5]'],
  ['click', ''], ['selectText', '1'], ['typeText', ''], ['scroll', '1'], ['drag', '[1, 2]'],
  ['click', '1, { mouseButton: 2 }'], ['selectText', '1, "hello", { selectionType: 2 }'],
]) test(`relay refuses malformed native ${method}(${args}) without forwarding`, t => {
  const f = fixture(t);
  f.call(`await app.${method}(${args});`);
  assert.equal(f.sent.length, 0);
  assert.match(f.received.at(-1).result.content[0].text, new RegExp(`${method}\\(.*nothing was sent`));
});

const compatibleArguments = [
  ['single key', 'pressKey', ['a']],
  ['space key', 'pressKey', [' ']],
  ['tab key', 'pressKey', ['\t']],
  ['newline key', 'pressKey', ['\n']],
  ['future key', 'pressKey', ['FutureKey']],
  ['null key options', 'pressKey', ['Return', null]],
  ['future option field', 'pressKey', ['Return', { futureOption: { mode: 'new' } }]],
  ['extra key argument', 'pressKey', ['Return', {}, { future: true }]],
  ['future text options', 'typeText', ['hello', { futureOption: true }]],
  ['undefined text options', 'typeText', ['hello', undefined]],
  ['null text options', 'typeText', ['hello', null]],
  ['future mouse button', 'click', [1, { mouseButton: 'future-button' }]],
  ['native right button', 'click', [[40, 20], { mouseButton: 'right' }]],
  ['native screenshot region', 'click', [[40, 20], { screenshotId: 'menu-region-id', mouseButton: 'right' }]],
  ['null click options', 'click', [1, null]],
  ['extra click argument', 'click', [1, {}, { future: true }]],
  ['future selection type', 'selectText', [1, 'hello', { selectionType: 'future-selection' }]],
  ['null selection options', 'selectText', [1, 'hello', null]],
  ['extra selection argument', 'selectText', [1, 'hello', {}, { future: true }]],
  ...['u', 'd', 'l', 'r', 'future-direction'].map(direction => [
    `scroll direction ${direction}`, 'scroll', [1, direction],
  ]),
  ['page scroll distance', 'scroll', [1, 'down', 2]],
  ['future scroll distance', 'scroll', [1, 'down', { pages: 2, futureUnit: 'new' }]],
  ['empty scroll distance', 'scroll', [1, 'down', {}]],
  ['opaque scroll distance fields', 'scroll', [1, 'down', { pixels: 'future-value' }]],
  ['null scroll distance', 'scroll', [1, 'down', null]],
  ['extra scroll argument', 'scroll', [1, 'down', 2, { future: true }]],
  ['extra drag argument', 'drag', [[1, 2], [3, 4], { future: true }]],
];

for (const [label, method, args] of compatibleArguments) {
  test(`relay forwards ${label}`, t => {
    const f = fixture(t);
    const source = args.map(value => value === undefined ? 'undefined' : JSON.stringify(value)).join(', ');
    f.call(`await app.${method}(${source});`);
    assert.equal(f.sent.length, 1, f.received.at(-1)?.result?.content?.[0]?.text);
  });

  test(`runtime forwards ${label} unchanged`, async () => {
    const sent = [];
    const raw = { getAXState: async () => tree, [method]: async (...received) => sent.push(received) };
    const realm = { app: raw, args, cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
    await runInNewContext(`(async () => { ${guardedCode(`await app.${method}(...args);`, window)} })()`, realm);
    assert.deepEqual(sent, [args]);
  });
}

for (const selector of ['Body', 'id:body']) test(`relay forwards string click selector ${selector}`, t => {
  const f = fixture(t);
  f.call(`await app.click(${JSON.stringify(selector)});`);
  assert.equal(f.sent.length, 1);
});

test('valid native literals, unknown expressions and method names in text still forward', t => {
  const f = fixture(t);
  for (const [id, code] of [
    'await app.pressKey("super+Down", { durationMs: 20 });',
    'await app.typeText("app.pressKey(2, null)"); // app.scroll(null)',
    'await app.click({ id: "body" }, { key: "super", clickCount: 2 });',
    'await app.selectText({ label: "Body" }, "hello", { prefix: "a", selectionType: "text" });',
    'await app.scroll([1, 2], "d", { pixels: 100 });',
    'await app.drag([1, 2], [3, 4]);',
    'await app.pressKey(computedKey, options);',
    'await app.click([x, y], { key: modifier });',
    'await app.pressKey("Return", { ...options });',
    'await app.pressKey(...keys);',
    'const pattern = /app.pressKey(2)/; await app.pressKey(`Return`);',
    'await app.typeText(`text ${value}`);',
  ].entries()) {
    f.call(code, id + 1);
    assert.equal(f.sent.at(-1)?.id, id + 1, code);
    f.reply(id + 1);
  }
});

test('tab pressKey and typeText retain the element-index-first API', t => {
  const f = fixture(t);
  f.call('let tab = await cua.getTab("1"); await tab.pressKey(null, "Return"); await tab.typeText(2, "hello");');
  assert.equal(f.sent.length, 1);
});

test('a local tab binding named app does not receive native validation', t => {
  const f = fixture(t);
  f.call('let app = await cua.getTab("1"); await app.pressKey(null, "Return");');
  assert.equal(f.sent.length, 1);
});

for (const earlier of [false, true]) test(`computed invalid key reports its input boundary after earlier input: ${earlier}`, async t => {
  const f = fixture(t, { changeReview: true });
  f.call('let app = await cua.getApp("Fixture Editor");'); f.reply(1);
  f.call((earlier ? 'await app.click(1); ' : '') + 'await app.pressKey(badKey);', 2);
  const inputs = [], output = [];
  const raw = { getAXState: async () => tree, click: async () => inputs.push('click'), pressKey: async () => inputs.push('key') };
  const realm = { app: raw, badKey: 2, cua: { getApp: async () => raw }, nodeRepl: { write: value => output.push(String(value)) } };
  try { await runInNewContext(`(async () => { ${f.sent.find(m => m.id === 2).params.arguments.code} })()`, realm); }
  catch (error) { output.push(error.message); }
  f.engineReply({ id: 2, result: { isError: true, content: [{ type: 'text', text: output.join('\n') }] } });
  assert.deepEqual(inputs, earlier ? ['click'] : []);
  const text = f.received.at(-1).result.content.map(c => c.text ?? '').join('\n');
  assert.ok(text.includes(signature), text);
  assert.match(text, /nothing was sent for this action/);
  if (earlier) assert.match(text, /earlier actions in this call may have run/);
  else assert.doesNotMatch(text, /outcome unconfirmed|partial input possible/);
});

for (const [method, args] of [
  ['pressKey', ['super+Down', { durationMs: 20 }]], ['typeText', ['hello']],
  ['click', [[1, 2], { key: 'super', clickCount: 2 }]],
  ['selectText', [1, 'hello', { prefix: 'before', suffix: 'after', selectionType: 'cursor_after' }]],
  ['scroll', [[1, 2], 'd', { pixels: 100 }]], ['drag', [[1, 2], [3, 4]]],
]) test(`valid computed ${method} arguments reach the engine unchanged`, async () => {
  const sent = [];
  const raw = { getAXState: async () => tree, [method]: async (...received) => sent.push(received) };
  const realm = { app: raw, args, cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
  await runInNewContext(`(async () => { ${guardedCode(`await app.${method}(...args);`, window)} })()`, realm);
  assert.deepEqual(sent, [args]);
});

for (const [method, args] of [
  ['pressKey', [2, 'super+Down']], ['pressKey', [null, 'Return']],
  ['pressKey', ['Return', { durationMs: 'long' }]], ['click', [[1, 'two']]], ['click', [[, 2]]],
  ['selectText', [1, {}]], ['typeText', [null]], ['scroll', [1, {}]], ['drag', [[1, 2], null]],
]) test(`runtime rejects computed malformed ${method} before any engine read or input`, async () => {
  const sent = [];
  const raw = { getAXState: async () => { sent.push('read'); return tree; }, [method]: async () => sent.push('input') };
  const realm = { app: raw, args, cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
  await assert.rejects(runInNewContext(`(async () => { ${guardedCode(`await app.${method}(...args);`, window)} })()`, realm), error => {
    assert.match(error.message, /nothing was sent/);
    assert.ok(error.message.includes(`${method}(`));
    assert.doesNotMatch(error.message, /TypeError|\n/);
    return true;
  });
  assert.deepEqual(sent, []);
});
