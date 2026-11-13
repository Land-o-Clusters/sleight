import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { nativeArgumentError, nativeArgumentsProblem } from '../plugins/sleight/lib/native-arguments.mjs';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';
import { QUIT_KEY_REFUSAL } from '../plugins/sleight/lib/quit-key.mjs';

const signatures = { pressKey: 'pressKey(key: string, options?: PressKeyOptions)', typeText: 'typeText(text: string)' };
const signature = signatures.pressKey;
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

const scrollRefusal = 'sleight: invalid native arguments. Engine App.scroll(<observed element number or [x, y]>, direction, pages?: number) e.g. scroll(23, "down", 1); nothing was sent';
for (const blocked of [true, false]) {
  const expected = blocked ? QUIT_KEY_REFUSAL : scrollRefusal + '.';
  test(`SCR1C literal scroll with ${blocked ? 'blocked' : 'unblocked'} hold chooses the specific refusal before send`, t => {
    for (const field of ['key', 'modifier', 'modifiers']) {
      const hold = { [field]: field === 'modifiers' ? (blocked ? ['cmd', 'q'] : ['shift']) : blocked ? 'cmd+q' : 'shift' };
      for (const receiver of ['app', '(await cua.getApp("Fixture Editor"))', 'alias']) {
        const code = `${receiver === 'alias' ? 'const alias = await cua.getApp("Fixture Editor"); ' : ''}await ${receiver}.scroll(1, "down", ${JSON.stringify(hold)});`;
        assert.equal(nativeArgumentsProblem(code), expected, code);
        const f = fixture(t);
        f.call(code);
        assert.deepEqual(f.sent, [], code);
        assert.equal(f.received.at(-1).result.isError, true);
        assert.equal(f.received.at(-1).result.content[0].text, expected, code);
      }
    }
  });

  test(`SCR1C computed scroll with ${blocked ? 'blocked' : 'unblocked'} hold chooses the specific runtime refusal`, async () => {
    for (const field of ['key', 'modifier', 'modifiers']) {
      const sent = [];
      const raw = { getAXState: async () => { sent.push('read'); return tree; }, scroll: async () => sent.push('scroll') };
      const hold = { [field]: field === 'modifiers' ? (blocked ? ['cmd', 'q'] : ['shift']) : blocked ? 'cmd+q' : 'shift' };
      const realm = { app: raw, hold, cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
      await assert.rejects(runInNewContext(`(async () => { ${guardedCode('await app.scroll(1, "down", hold);', window)} })()`, realm),
        { message: blocked ? QUIT_KEY_REFUSAL : scrollRefusal + ' for this action.' });
      assert.deepEqual(sent, []);
    }
  });
}

test('SCR1C malformed pointer arguments retain the blocked-hold refusal', async t => {
  for (const [method, args] of [
    ['click', [{ ref: 1 }, { key: 'cmd+q', button: 'left' }]],
    ['doubleClick', [{ ref: 1 }, { modifier: 'cmd+q' }]],
    ['rightClick', [{ ref: 1 }, { modifiers: ['cmd', 'q'] }]],
    ['drag', [[1, 2, 3], [4, 5], { modifiers: ['cmd', 'q'] }]],
  ]) {
    const code = `await app.${method}(...args);`;
    const sent = [];
    const raw = { getAXState: async () => { sent.push('read'); return tree; }, [method]: async () => sent.push(method) };
    const realm = { app: raw, args, cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
    await assert.rejects(runInNewContext(`(async () => { ${guardedCode(code, window)} })()`, realm), { message: QUIT_KEY_REFUSAL });
    assert.deepEqual(sent, []);
    const f = fixture(t);
    f.call(`await app.${method}(${args.map(arg => JSON.stringify(arg)).join(', ')});`);
    assert.deepEqual(f.sent, []);
    assert.equal(f.received.at(-1).result.content[0].text, QUIT_KEY_REFUSAL);
  }
});

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

const buttonMistakes = [
  ...['left', 'right', 'middle', 'l', 'r', 'm'].map(button => [
    { button }, `sleight: use {mouseButton:"${button}"}, not button; nothing sent`,
  ]),
  [{ button: 'unknown-button' }, 'sleight: use mouseButton, not button; nothing sent'],
  [{ button: 'right"}; injected()' }, 'sleight: use mouseButton, not button; nothing sent'],
  [{ button: 1 }, 'sleight: use mouseButton, not button; nothing sent'],
  [{ button: null }, 'sleight: use mouseButton, not button; nothing sent'],
  [{ button: ['left'] }, 'sleight: use mouseButton, not button; nothing sent'],
  [{ button: { toString: 'left' } }, 'sleight: use mouseButton, not button; nothing sent'],
  [{ button: 'left', mouseButton: 'right' }, 'sleight: use {mouseButton:"left"}, not button; nothing sent'],
];

for (const [options, expected] of buttonMistakes) {
  test(`native click rejects the ignored button option before the whole batch: ${JSON.stringify(options)}`, t => {
    const f = fixture(t);
    f.call(`let editor = await cua.getApp("Fixture Editor"); await editor.pressKey("Return"); await editor.click([40, 20], ${JSON.stringify(options)});`);
    assert.equal(f.sent.length, 0);
    const reply = f.received.at(-1).result;
    assert.equal(reply.isError, true);
    assert.equal(reply.content[0].text, expected + '.');
  });

  test(`computed native button option ${JSON.stringify(options)} refuses before a lease, read or click`, async () => {
    const sent = [];
    const raw = { getAXState: async () => { sent.push('read'); return tree; }, click: async () => sent.push('click') };
    const realm = { app: raw, options, cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
    const lease = { path: 'unused-lease', token: 'fixture' };
    await assert.rejects(runInNewContext(`(async () => { ${guardedCode('await app.click([40, 20], options);', window, undefined, lease)} })()`, realm,
      { importModuleDynamically() { sent.push('lease'); throw new Error('unexpected lease access'); } }),
    { message: expected + ' for this action.' });
    assert.deepEqual(sent, []);
  });
}

test('unknown native button expression gets a value-free rename before acquisition', t => {
  const f = fixture(t);
  f.call('let editor = await cua.getApp("Fixture Editor"); await editor.click([40, 20], { button: side });');
  assert.equal(f.sent.length, 0);
  assert.equal(f.received.at(-1).result.content[0].text, 'sleight: use mouseButton, not button; nothing sent.');
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
  ['empty text', 'typeText', ['']],
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
    'await app.scroll([1, 2], "d", 1);',
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

for (const args of [[1, 2], [{ id: 'source' }, { id: 'target' }], [{ label: 'source' }, [3, 4]]]) {
  test(`ChatGPT drag refuses element endpoints before acquisition and computed input: ${JSON.stringify(args)}`, async t => {
    const f = fixture(t);
    f.call(`let app = await cua.getApp("Fixture Editor"); await app.drag(...${JSON.stringify(args)});`);
    // Spread arity is checked inside the runtime proxy, before any read/input.
    const sent = [];
    const raw = { getAXState: async () => { sent.push('read'); return tree; }, drag: async () => sent.push('drag') };
    const realm = { app: raw, args, cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
    await assert.rejects(runInNewContext(`(async () => { ${guardedCode('await app.drag(...args);', window)} })()`, realm),
      /invalid native arguments.*drag\(from: Vec2, to: Vec2\).*nothing was sent/);
    assert.deepEqual(sent, []);
    const literal = fixture(t);
    literal.call(`let app = await cua.getApp("Fixture Editor"); await app.drag(${args.map(arg => JSON.stringify(arg)).join(',')});`);
    assert.equal(literal.sent.length, 0);
  });
}

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
  ['scroll', [[1, 2], 'd', 1]], ['drag', [[1, 2], [3, 4]]],
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
  ['selectText', [1, {}]], ['typeText', [null]], ['scroll', [1, {}]],
  ['scroll', [23, 'down', { pixels: 600 }]], ['scroll', [[1, 2], 'd', { pixels: 100 }]],
  ['scroll', [1, 'down', { pixels: 'future-value' }]], ['drag', [[1, 2], null]],
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


// SF6 shapes recorded in the rel2/rel3 Safari and Firefox banks. Values are fixture data.
const recordedShapes = [
  ['pressKey', [null, 'Return']], ['pressKey', [74, 'Return']],
  ['pressKey', [{ id: 'WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD' }, 'Return']],
  ['typeText', [null, 'fixture text']], ['typeText', [52, 'fixture text']],
];
for (const [method, args] of recordedShapes) {
  test(`SF6 ${method} refusal explains the omitted target without converting input: ${JSON.stringify(args[0])}`, async t => {
    const code = `await app.${method}(${args.map(JSON.stringify).join(', ')});`;
    const before = 'sleight: invalid native arguments. Engine App.' +
      signatures[method] + '; nothing was sent';
    const note = nativeArgumentError(method, args);
    const hint = Number.isInteger(args[0]);
    assert.equal(note, 'sleight: invalid native arguments. Engine App.' + signatures[method] +
      (hint ? '; no target; click field first if focus wrong' : '') + '; nothing was sent');
    assert.equal(Buffer.byteLength(note) - Buffer.byteLength(before), hint ? 45 : 0);
    assert.equal(nativeArgumentsProblem(code), note + '.');
    const f = fixture(t);
    f.call('await app.typeText("earlier valid input"); ' + code);
    assert.equal(f.sent.length, 0);
    assert.equal(f.received.at(-1).result.content[0].text, note + '.');
    const sent = [];
    const raw = { getAXState: async () => { sent.push('read'); return tree; },
      click: async () => sent.push('click'), [method]: async () => sent.push('input') };
    const realm = { app: raw, args, cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
    await assert.rejects(runInNewContext(`(async () => { ${guardedCode(`await app.${method}(...args);`, window)} })()`, realm),
      { message: note + ' for this action.' });
    assert.deepEqual(sent, []);
  });
}
for (const [method, args] of [['pressKey', ['Return']], ['typeText', ['fixture text']]]) {
  test(`SF6 correctly focused ${method} reaches input without a preparatory click`, async () => {
    const sent = [];
    const raw = { getAXState: async () => tree, click: async () => sent.push('click'),
      [method]: async (...values) => sent.push({ method, values }) };
    const realm = { app: raw, args, cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
    await runInNewContext(`(async () => { ${guardedCode(`await app.${method}(...args);`, window)} })()`, realm);
    assert.deepEqual(sent, [{ method, values: args }]);
  });
}

const keyboardRefusals = [
  ...['pressKey', 'typeText'].flatMap(method => [
    ['null', [null]], ['number', [52, 'fixture']], ['id selector', [{ id: 'field' }, 'fixture']],
    ['label selector', [{ label: 'Body' }]], ['line selector', [{ line: 'Body' }]],
    ['empty object', [{}]], ['array', [[1, 2]]], ['boolean', [false]],
    ['explicit undefined', [undefined]],
    ['number without input', [52]], ['negative number', [-1, 'fixture']],
    ['fractional number', [1.5, 'fixture']], ['nonfinite number', [Infinity, 'fixture']],
    ['number with non-string input', [52, null]], ['number with empty input', [52, '']],
    ['zero element', [0, 'fixture']],
  ].map(([label, args]) => ({ method, label, args,
    hint: ['number', 'zero element'].includes(label) }))),
  { method: 'pressKey', label: 'empty key', args: [''], hint: false },
  { method: 'pressKey', label: 'missing key', args: [], hint: false },
  { method: 'pressKey', label: 'string options', args: ['Return', 'bad'], hint: false },
  { method: 'pressKey', label: 'number options', args: ['Return', 7], hint: false },
  { method: 'pressKey', label: 'array options', args: ['Return', []], hint: false },
  { method: 'pressKey', label: 'bad duration', args: ['Return', { durationMs: 'long' }], hint: false },
  { method: 'typeText', label: 'missing text', args: [], hint: false },
];

for (const { method, label, args, hint } of keyboardRefusals) {
  test(`SF6R ${method} ${label} has ${hint ? 'target recovery' : 'only the signature'}${label === 'explicit undefined' ? ' at runtime after static deferral' : ' in static, relay and runtime refusals'}`, async t => {
    const bare = 'sleight: invalid native arguments. Engine App.' + signatures[method] + '; nothing was sent';
    const expected = 'sleight: invalid native arguments. Engine App.' + signatures[method] +
      (hint ? '; no target; click field first if focus wrong' : '') + '; nothing was sent';
    assert.equal(nativeArgumentError(method, args), expected);
    assert.equal(Buffer.byteLength(expected) - Buffer.byteLength(bare), hint ? 45 : 0);
    const code = `await app.${method}(${args.map(value => value === undefined ? 'undefined' : JSON.stringify(value)).join(', ')});`;
    const f = fixture(t);
    if (label === 'explicit undefined') {
      // p171's AST inspector never treats a shadowable identifier as a literal.
      assert.equal(nativeArgumentsProblem(code), undefined);
      f.call(code);
      assert.equal(f.sent.length, 1);
      assert.equal(f.sent[0].params.arguments.code, code);
    } else {
      assert.equal(nativeArgumentsProblem(code), expected + '.');
      f.call('await app.typeText("earlier valid input"); ' + code);
      assert.equal(f.sent.length, 0);
      assert.equal(f.received.at(-1).result.content[0].text, expected + '.');
    }
    const effects = [];
    const raw = { getAXState: async () => { effects.push('read'); return tree; },
      click: async () => effects.push('click'), [method]: async () => effects.push('input') };
    const realm = { app: raw, args, cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
    await assert.rejects(runInNewContext(`(async () => { ${guardedCode(`await app.${method}(...args);`, window)} })()`, realm),
      { message: expected + ' for this action.' });
    assert.deepEqual(effects, []);
  });
}

test('SF6R an unknown first argument with known bad options gets only the signature until runtime', () => {
  assert.equal(nativeArgumentsProblem('await app.pressKey(computedKey, { durationMs: "long" });'),
    'sleight: invalid native arguments. Engine App.' + signatures.pressKey + '; nothing was sent.');
  assert.equal(nativeArgumentsProblem('await app.pressKey(computedKey);'), undefined);
  assert.equal(nativeArgumentsProblem('await app.typeText(computedText);'), undefined);
});

for (const method of ['pressKey', 'typeText']) {
  for (const expression of ['text', 'text + suffix', '`' + '${text}' + '`']) {
    test(`INT13B ${method}(32, ${expression}) keeps the hint for unknown text before forwarding`, t => {
      const code = `await app.${method}(32, ${expression});`;
      const expected = 'sleight: invalid native arguments. Engine App.' + signatures[method] +
        '; no target; click field first if focus wrong; nothing was sent.';
      assert.equal(nativeArgumentsProblem(code), expected);
      const f = fixture(t);
      f.call('await app.typeText("earlier valid input"); ' + code);
      assert.equal(f.sent.length, 0);
      assert.equal(f.received.at(-1).result.content[0].text, expected);
    });
  }
  for (const text of ['fixture', '', null]) {
    test(`INT13B runtime ${method}(32, text) hints only for nonempty strings: ${JSON.stringify(text)}`, async () => {
      const expected = 'sleight: invalid native arguments. Engine App.' + signatures[method] +
        (text === 'fixture' ? '; no target; click field first if focus wrong' : '') + '; nothing was sent';
      const effects = [];
      const raw = { getAXState: async () => { effects.push('read'); return tree; },
        [method]: async () => effects.push('input') };
      const realm = { app: raw, text, cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
      await assert.rejects(runInNewContext(`(async () => { ${guardedCode(`await app.${method}(32, text);`, window)} })()`, realm),
        { message: expected + ' for this action.' });
      assert.deepEqual(effects, []);
    });
  }
}

test('SF6R focus can move after a numeric typeText refusal, then a deliberate click repairs it', async () => {
  const effects = [], values = { Body: '', Decoy: 'keep' };
  let focused = 'Body';
  const raw = {
    getAXState: async () => tree + '\n\t2 text field (settable) Decoy',
    click: async target => { effects.push(['click', target]); focused = 'Body'; },
    typeText: async text => { effects.push(['type', focused]); values[focused] += text; },
  };
  const run = code => runInNewContext(`(async () => { ${guardedCode(code, window)} })()`,
    { app: raw, badTarget: 1, cua: { getApp: async () => raw }, nodeRepl: { write() {} } });
  await assert.rejects(run('await app.typeText(badTarget, "SF6R token");'), /click field first if focus wrong/);
  assert.deepEqual(effects, []);
  // External focus change after the refusal, before the model's next call.
  focused = 'Decoy';
  await run('await app.click(1); await app.typeText("SF6R token");');
  assert.deepEqual(effects, [['click', 1], ['type', 'Body']]);
  assert.deepEqual(values, { Body: 'SF6R token', Decoy: 'keep' });
});

test('SF6R prepared browser fixture moves focus only when its driver clicks and keeps an event record', () => {
  const html = readFileSync(new URL('./fixtures/sf6-focus-probe.html', import.meta.url), 'utf8');
  const listeners = new Map(), buttonListeners = new Map(), timers = [];
  const document = { activeElement: null, addEventListener: (type, listener) => listeners.set(type, listener) };
  const field = (id, value = '') => ({ id, value, focus() {
    document.activeElement = this;
    listeners.get('focusin')({ target: this });
  } });
  const elements = { memo: field('memo'), reference: field('reference', 'reference stays'), evidence: { textContent: '',
    replaceChildren(...children) { this.textContent = children.map(child => child.textContent).join('\n'); } },
    move: { addEventListener: (type, listener) => buttonListeners.set(type, listener) } };
  document.getElementById = id => elements[id];
  document.createElement = () => ({ textContent: '' });
  const realm = { document, window: {}, crypto: { randomUUID: () => 'sf6-native-unit' },
    setInterval: (fn, ms) => { assert.equal(ms, 100); timers.push(fn); } };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], realm);
  const snapshot = () => JSON.parse(JSON.stringify(realm.window.sf6Probe.snapshot()));
  assert.equal(snapshot().focus, 'memo');
  assert.equal(snapshot().phase, 'before-refusal');
  buttonListeners.get('click')();
  assert.equal(snapshot().focus, 'reference');
  assert.equal(snapshot().phase, 'after-refusal');
  assert.equal(snapshot().memo, '');
  assert.equal(snapshot().reference, 'reference stays');
  assert.deepEqual(snapshot().events.map(event => [event.phase, event.type, event.field]),
    [['before-refusal', 'focus-observed', 'memo'], ['after-refusal', 'focus-observed', 'reference']]);
  const published = () => JSON.parse(decodeURIComponent(elements.evidence.textContent.split('\n').map(block => {
    assert.match(block, /^SF6\/1:sf6-native-unit:\d+:\d+:\d+:/);
    assert.ok(block.length < 512);
    return block.split(':').slice(5).join(':');
  }).join('')));
  assert.equal(published().focus, 'reference');
  document.activeElement = elements.memo;
  assert.equal(published().focus, 'reference', 'silent changes wait for the sampler');
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(published().focus, 'memo');
  assert.equal(published().phase, 'after-refusal');
});

const macScrollRefusal = 'sleight: invalid native arguments. Engine App.scroll(<observed element number or [x, y]>, direction, pages?: number) e.g. scroll(23, "down", 1); nothing was sent.';

for (const [label, distance] of [
  ['an empty object', '{}'],
  ['a pages object', '{ pages: 2 }'],
  ['a future field', '{ pages: 2, futureUnit: "new" }'],
  ['an unrelated key', '{ distance: 600 }'],
  ['a pixels object', '{ pixels: 600 }'],
  ['a quoted pixels key', '{ "pixels": 600 }'],
]) test(`macOS scroll refuses ${label} distance before send`, t => {
  const f = fixture(t);
  f.call(`await app.scroll(23, "down", ${distance});`);
  assert.equal(f.sent.length, 0);
  const result = f.received.at(-1).result;
  assert.equal(result.isError, true);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].text, macScrollRefusal);
  assert.equal(result.content[0].text.length, 162);
  assert.doesNotMatch(result.content[0].text, /partial input possible|\{ ?pixels/);
});

for (const [label, args] of [
  ['an empty object', [1, 'down', {}]],
  ['a pages object', [1, 'down', { pages: 2 }]],
  ['a future field', [1, 'down', { pages: 2, futureUnit: 'new' }]],
  ['an unrelated key', [1, 'down', { distance: 600 }]],
  ['a null prototype', [1, 'down', Object.create(null)]],
]) test(`runtime refuses ${label} scroll distance before the engine method`, async () => {
  const sent = [];
  const raw = { getAXState: async () => { sent.push('read'); return tree; }, scroll: async () => sent.push('input') };
  const realm = { app: raw, args, cua: { getApp: async () => raw }, nodeRepl: { write() {} } };
  await assert.rejects(runInNewContext(`(async () => { ${guardedCode('await app.scroll(...args);', window)} })()`, realm), error => {
    assert.equal(error.message, macScrollRefusal.slice(0, -1) + ' for this action.');
    assert.doesNotMatch(error.message, /TypeError|\n|partial input possible/);
    return true;
  });
  assert.deepEqual(sent, []);
});

test('a pixels object is a chrome swipe length and every other object distance is refused', () => {
  const refusal = macScrollRefusal.slice(0, -1);
  assert.equal(nativeArgumentError('scroll', [1, 'down', { pixels: 100 }], Symbol(), { allowScrollPixels: true }), undefined);
  assert.equal(nativeArgumentError('scroll', [1, 'down', { pixels: 100 }]), refusal);
  for (const distance of [{}, { pages: 2 }, { distance: 600 }, Object.create(null)]) {
    assert.equal(nativeArgumentError('scroll', [1, 'down', distance], Symbol(), { allowScrollPixels: true }), refusal);
    assert.equal(nativeArgumentError('scroll', [1, 'down', distance]), refusal);
  }
});

test('app.scroll(23, "down", 1) passes through unchanged', t => {
  const f = fixture(t);
  const code = 'await app.scroll(23, "down", 1);';
  f.call(code);
  assert.equal(f.sent.length, 1, f.received.at(-1)?.result?.content?.[0]?.text);
  assert.equal(f.sent[0].params.arguments.code, code);
});
