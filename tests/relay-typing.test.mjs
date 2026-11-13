import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

// Execute the relay's real app wrapper against an in-memory engine. No host or UI runs.
async function fixture(t, { field = 'text entry area Body', focus = true, type, key } = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough();
  const serverIn = new PassThrough(), serverOut = new PassThrough();
  const forwarded = [], received = [], typed = [], pasted = [], clicked = [], reads = [];
  serverIn.on('data', data => forwarded.push(...data.toString().trim().split('\n').map(JSON.parse)));
  clientOut.on('data', data => received.push(...data.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false });
  t.after(() => relay.dispose());
  let tree = 'Window: "Draft", App: Fixture Editor.\n0 standard window Draft\n\t1 ' + field + ', Value: existing' +
    (focus ? '\nThe focused UI element is 1 ' + field : '');
  const raw = { getAXState: async () => { reads.push(tree); return tree; }, click: async target => { clicked.push(target); },
    typeText: async text => { await type?.(text); typed.push(text); }, paste: async text => { pasted.push(text); },
    pressKey: async text => { key?.(text); } };
  let emitted = [], id = 0;
  const realm = { cua: { getApp: async () => ({ ...raw }) }, nodeRepl: { write: text => emitted.push({ type: 'text', text }) } };
  async function submit(code) {
    const callId = ++id;
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: callId, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
    await new Promise(resolve => setImmediate(resolve));
    const request = forwarded.find(msg => msg.id === callId);
    assert.ok(request, 'the cell reaches the fake engine for runtime validation');
    assert.ok(request.params.arguments.code.includes(code), 'the submitted cell stays intact');
    emitted = [];
    let error;
    try { await runInNewContext(`(async () => { ${request.params.arguments.code} })()`, realm); }
    catch (caught) { error = caught; emitted.push({ type: 'text', text: caught.message }); }
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: callId,
      result: { ...(error ? { isError: true } : {}), content: emitted.length ? emitted : [{ type: 'text', text: tree }] } }) + '\n');
    await new Promise(resolve => setImmediate(resolve));
    const result = received.find(msg => msg.id === callId)?.result;
    assert.ok(result, 'the relay returns the engine result');
    return { ...result, text: result.content.map(item => item.text ?? '').join('\n') };
  }
  await submit('app = await cua.getApp("Fixture Editor")');
  return { submit, typed, pasted, clicked, reads, realm, setTree: text => { tree = text; } };
}

const unknownRecovery = 'Read the window again; use app.paste(<same text>) if focus is not a password field; otherwise ask the user to type it.';

test('non-ASCII typing sends nothing and gives short paste guidance without echoing text', async t => {
  const h = await fixture(t);
  const text = 'café 日本 🙂 "quoted"\nnext\tline\\end';
  h.realm.text = text;
  const result = await h.submit('await app.getAXState(); await app.typeText(text)');
  assert.deepEqual(h.typed, []);
  assert.deepEqual(h.pasted, []);
  assert.equal(result.isError, true);
  const notice = 'sleight: typeText garbles non-ASCII on this engine; nothing typed. Use app.paste(<same text>).';
  assert.ok(result.text.includes(notice));
  assert.equal(notice.length, 94);
  assert.ok(!result.text.includes(text));
  assert.deepEqual(Array.from(h.realm.__sleightDocumentGuard.typed), []);
});

test('printable ASCII with tab, newline and carriage return passes through once', async t => {
  const h = await fixture(t);
  const text = 'Hello, ASCII!\t42\nnext line\r\nlast';
  const result = await h.submit(`await app.typeText(${JSON.stringify(text)})`);
  assert.deepEqual(h.typed, [text]);
  assert.deepEqual(h.pasted, []);
  assert.equal(result.isError, undefined);
  assert.doesNotMatch(result.text, /garbles|Nothing was typed/);
});

test('a later non-ASCII refusal keeps and reports the earlier completed typing', async t => {
  const h = await fixture(t);
  const result = await h.submit('await app.typeText("first"); await app.typeText("日本"); await app.typeText("last");');
  assert.deepEqual(h.typed, ['first']);
  assert.equal(result.isError, true);
  assert.match(result.text, /Already ran: typeText\(<5 characters>\)/);
  assert.match(result.text, /nothing typed/);
  assert.ok(result.text.includes(unknownRecovery));
  assert.ok(!result.text.includes('日本'));
  assert.deepEqual(Array.from(h.realm.__sleightDocumentGuard.typed), ['first']);
  assert.doesNotMatch(result.text, /sent \d+ characters to text entry area/);
});

test('computed loop text lists only the calls that completed before the refusal', async t => {
  const h = await fixture(t);
  const result = await h.submit('for (const text of ["one", "four", "🙂", "last"]) await app.typeText(text);');
  assert.deepEqual(h.typed, ['one', 'four']);
  assert.equal(result.isError, true);
  assert.match(result.text, /Already ran: typeText\(<3 characters>\), typeText\(<4 characters>\)/);
  assert.ok(!result.text.includes('🙂'));
});

test('ASCII controls other than tab, newline and carriage return send no typing', async t => {
  const h = await fixture(t);
  const result = await h.submit('await app.typeText("before\\u0000after")');
  assert.deepEqual(h.typed, []);
  assert.equal(result.isError, true);
  assert.match(result.text, /nothing typed/);
});

test('Unicode paste still reaches the engine unchanged', async t => {
  const h = await fixture(t);
  const result = await h.submit('await app.paste("café 日本 🙂")');
  assert.deepEqual(h.typed, []);
  assert.deepEqual(h.pasted, ['café 日本 🙂']);
  assert.equal(result.isError, undefined);
});

for (const alias of [false, true]) test(`overlapping input is reported as possibly running, alias=${alias}`, async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const h = await fixture(t, { type: () => blocked });
  try {
    const setup = alias ? 'const alias = await cua.getApp("Fixture Editor");' : '';
    const result = await h.submit(setup + `await Promise.all([app.typeText("abc"), ${alias ? 'alias' : 'app'}.typeText("é")]);`);
    assert.equal(result.isError, true);
    assert.deepEqual(h.typed, [], 'ASCII input has not completed when the refusal returns');
    assert.match(result.text, /Other input in this cell may have run or still be running/);
    assert.doesNotMatch(result.text, /completed.*none|Already ran:/);
    assert.ok(result.text.includes(unknownRecovery));
  } finally {
    release();
    await h.realm.__sleightDocumentGuard.settle();
  }
  assert.deepEqual(h.typed, ['abc'], 'the original ASCII input can finish after the refusal');
});

test('input with a lost completion is reported as unknown after its promise settles', async t => {
  const h = await fixture(t, { type: () => { throw Error('completion lost'); } });
  const result = await h.submit('try { await app.typeText("abc"); } catch {} await app.typeText("é");');
  assert.equal(result.isError, true);
  assert.match(result.text, /Other input in this cell may have run or still be running/);
  assert.doesNotMatch(result.text, /completed.*none|Already ran:/);
  assert.ok(result.text.includes(unknownRecovery));
  assert.equal(h.realm.__sleightDocumentGuard.unknown.length, 1);
});

test('completed and pending input are reported separately', async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const h = await fixture(t, { type: text => text === 'abc' ? blocked : undefined });
  try {
    const result = await h.submit('await app.typeText("done"); await Promise.all([app.typeText("abc"), app.typeText("é")]);');
    assert.deepEqual(h.typed, ['done']);
    assert.match(result.text, /Already ran: typeText\(<4 characters>\)/);
    assert.match(result.text, /Other input in this cell may have run or still be running/);
    assert.doesNotMatch(result.text, /typeText\(<3 characters>\)/);
  } finally {
    release();
    await h.realm.__sleightDocumentGuard.settle();
  }
  assert.deepEqual(h.typed, ['done', 'abc']);
});

for (const [field, focus, recovery] of [
  ['text field Name', true, 'plain'], ['text entry area Body', true, 'plain'], ['AXTextField Name', true, 'plain'],
  ['AXSecureTextField Code', true, 'secure'], ['secure text field Code', true, 'secure'],
  ['secure field Code', true, 'secure'], ['password text field Code', true, 'secure'],
  ['password field Code', true, 'secure'], ['text field Code, Subrole: AXSecureTextField', true, 'secure'],
  ['AXTextField Code, AXSubrole: AXSecureTextField', true, 'secure'],
  ['text field (protected) Code', true, 'plain'], ['text field Password', true, 'unknown'],
  ['text field secure text field', true, 'plain'], ['text field AXSecureTextField', true, 'plain'],
  ['text field Code, Description: password secure protected', true, 'unknown'],
  ['text field PIN', true, 'unknown'], ['text field Shipping', true, 'plain'],
  ['text field Code, Value: password secure protected', true, 'plain'],
  ['text field Code, Value: ••••', true, 'unknown'],
  ['text field Code, Description: Subrole: AXSecureTextField', true, 'plain'],
  ['text field (settable) Description: Code, Subrole: AXSecureTextField', true, 'plain'],
  ['text field Code, Value: text, Subrole: AXSecureTextField', true, 'plain'],
  ['button Continue', true, 'unknown'], ['mystery field Code', true, 'unknown'], ['text field Name', false, 'unknown'],
]) test(`typing recovery for ${field}, focus=${focus}`, async t => {
  const h = await fixture(t, { field, focus });
  h.realm.text = 'sécret-never-echo';
  const result = await h.submit('await app.getAXState(); await app.typeText(text);');
  assert.equal(result.isError, true);
  assert.deepEqual(h.typed, []);
  assert.deepEqual(h.pasted, []);
  assert.ok(!result.text.includes(h.realm.text));
  if (recovery === 'plain') {
    assert.match(result.text, /Use app\.paste\(<same text>\)/);
    assert.doesNotMatch(result.text, /Ask the user to type it/);
  } else if (recovery === 'secure') {
    const notice = 'sleight: typeText garbles non-ASCII on this engine; nothing typed. Ask the user to type it.';
    assert.ok(result.text.includes(notice));
    assert.equal(notice.length, 91);
    assert.doesNotMatch(result.text, /app\.paste/);
  } else {
    assert.ok(result.text.includes(unknownRecovery));
    assert.equal(('sleight: typeText garbles non-ASCII on this engine; nothing typed. ' + unknownRecovery).length, 185);
  }
});

for (const secure of [false, true]) test(`an explicit read after click restores field guidance, secure=${secure}`, async t => {
  const h = await fixture(t, { field: secure ? 'AXSecureTextField Code' : 'text field Name' });
  const result = await h.submit('await app.getAXState(); await app.click(1); await app.getAXState(); await app.typeText("café");');
  assert.equal(result.isError, true);
  assert.deepEqual(h.clicked, [1]);
  assert.deepEqual(h.typed, []);
  assert.deepEqual(h.pasted, []);
  assert.doesNotMatch(result.text, /Read the window again|café/);
  assert.match(result.text, secure ? /Ask the user to type it/ : /Use app\.paste\(<same text>\)/);
});

for (const secure of [false, true]) test(`click then Unicode typing gives conditional reread guidance, secure=${secure}`, async t => {
  const h = await fixture(t, { field: secure ? 'AXSecureTextField Code' : 'text field Name' });
  h.realm.text = 'café-never-echo';
  h.realm.readCount = () => h.reads.length;
  const result = await h.submit('await app.getAXState(); await app.click(1); readsBefore = readCount(); await app.typeText(text);');
  assert.equal(result.isError, true);
  assert.deepEqual(h.clicked, [1]);
  assert.deepEqual(h.typed, []);
  assert.deepEqual(h.pasted, []);
  assert.equal(h.reads.length, h.realm.readsBefore, 'the refusal itself requests no engine read');
  assert.ok(result.text.includes(unknownRecovery));
  assert.ok(!result.text.includes(h.realm.text));
});

test('a plain field in a password or secure window keeps direct paste guidance', async t => {
  const h = await fixture(t);
  h.setTree('Window: "Secure Password Notes", App: Fixture Editor.\n0 standard window Secure Password Notes\n\t1 text entry area Body, Value: password secure protected\nThe focused UI element is 1 text entry area Body');
  const result = await h.submit('await app.getAXState(); await app.typeText("café");');
  assert.match(result.text, /Use app\.paste\(<same text>\)/);
  assert.doesNotMatch(result.text, /Read the window|[Aa]sk the user/);
  assert.deepEqual(h.typed, []);
  assert.deepEqual(h.pasted, []);
  assert.doesNotMatch(result.text, /café/);
});

test('the latest read replaces earlier plain-field paste guidance', async t => {
  const h = await fixture(t);
  h.realm.switchField = () => h.setTree('Window: "Draft", App: Fixture Editor.\n0 standard window Draft\n\t1 AXSecureTextField Code\nThe focused UI element is 1 AXSecureTextField Code');
  const result = await h.submit('await app.getAXState(); switchField(); await app.getAXState(); await app.typeText("é");');
  assert.match(result.text, /Ask the user to type it/);
  assert.doesNotMatch(result.text, /app\.paste/);
  assert.deepEqual(h.typed, []);
});

test('a secure target row overrides a plain focused-element description', async t => {
  const h = await fixture(t);
  h.setTree('Window: "Draft", App: Fixture Editor.\n0 standard window Draft\n\t1 AXSecureTextField Code\nThe focused UI element is 1 text field Code');
  const result = await h.submit('await app.getAXState(); await app.typeText("é");');
  assert.match(result.text, /Ask the user to type it/);
  assert.doesNotMatch(result.text, /app\.paste/);
});

test('a plain field nested inside a secure field gets no paste guidance', async t => {
  const h = await fixture(t);
  h.setTree('Window: "Draft", App: Fixture Editor.\n0 standard window Draft\n\t1 secure text field (settable) Password\n' +
    '\t\t2 text field Value: nested\nThe focused UI element is 2 text field');
  const result = await h.submit('await app.getAXState(); await app.typeText("é");');
  assert.match(result.text, /Ask the user to type it/);
  assert.doesNotMatch(result.text, /app\.paste/);
  assert.deepEqual(h.pasted, []);
});

test('a secure word in the window title does not make a plain field secure', async t => {
  const h = await fixture(t);
  h.setTree('Window: "Secure Password Vault", App: Fixture Editor.\n0 standard window Secure Password Vault\n\t1 text field Name\n' +
    'The focused UI element is 1 text field Name');
  const result = await h.submit('await app.getAXState(); await app.typeText("é");');
  assert.match(result.text, /Use app\.paste\(<same text>\)/);
});

test('ambiguous focus gives conditional reread guidance', async t => {
  const h = await fixture(t);
  h.setTree('Window: "Draft", App: Fixture Editor.\n0 standard window Draft\n\t1 text field Name\nThe focused UI element is 1 text field Name\nThe focused UI element is 2 AXSecureTextField Code');
  const result = await h.submit('await app.getAXState(); await app.typeText("é");');
  assert.ok(result.text.includes(unknownRecovery));
});

for (const body of [
  '\t1 text field Name\n\t1 text field Other',
  '\t2 text field Name',
]) test(`an ambiguous or missing target row gives conditional guidance: ${body}`, async t => {
  const h = await fixture(t);
  h.setTree('Window: "Draft", App: Fixture Editor.\n0 standard window Draft\n' + body + '\nThe focused UI element is 1 text field Code');
  const result = await h.submit('await app.getAXState(); await app.typeText("é");');
  assert.ok(result.text.includes(unknownRecovery));
  assert.deepEqual(h.typed, []);
});

test('the progress list is capped at ten completed actions without echoing text', async t => {
  const h = await fixture(t);
  const result = await h.submit('for (let i = 0; i < 12; i++) await app.typeText("a"); await app.typeText("focus changed since é");');
  assert.deepEqual(h.typed, Array(12).fill('a'));
  const notice = result.text.split('\n').find(line => line.startsWith('sleight: typeText'));
  assert.equal((notice.match(/typeText\(<1 characters>\)/g) ?? []).length, 10);
  assert.match(notice, /and 2 more/);
  assert.doesNotMatch(result.text, /focus changed since/);
});

test('single-character Unicode pressKey remains available pending live evidence', async t => {
  const keys = [];
  const h = await fixture(t, { key: text => keys.push(text) });
  const result = await h.submit('await app.pressKey("é"); await app.pressKey("🙂");');
  assert.equal(result.isError, undefined);
  assert.deepEqual(keys, ['é', '🙂']);
});
