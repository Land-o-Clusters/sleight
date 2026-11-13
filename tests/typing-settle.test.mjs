import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { PassThrough } from 'node:stream';
import { guardedCode, windowFromText, readCode } from '../plugins/sleight/lib/document-scope.mjs';
import { settleTyping } from '../plugins/sleight/lib/typing-settle.mjs';
import { createReadCompactor } from '../plugins/sleight/lib/compact-reads.mjs';
import { typedTextReceipt } from '../plugins/sleight/lib/typed-text-receipt.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

const recordings = JSON.parse(readFileSync(new URL('./fixtures/cursor-typing-settle.json', import.meta.url)));
const native = value => `Window: "Untitled", App: TextEdit.\n0 standard window Untitled\n\t1 text entry area (settable) Body, Value: ${value}\nThe focused UI element is 1 text entry area Body`;

function fixture(before, states, { readMs = 0, fail = false, guardOptions = {}, replyAtMs = [] } = {}) {
  let acted = false, now = 0, reads = 0;
  const output = [], delays = [], inputs = [], calls = [];
  const raw = {
    getAXState: async () => {
      calls.push('read');
      now += readMs;
      if (!acted) return before;
      now = Math.max(now, replyAtMs[reads] ?? 0);
      const next = states[Math.min(reads++, states.length - 1)];
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(now) : next;
    },
    typeText: async text => { calls.push('typeText'); inputs.push(text); acted = true; if (fail) throw Error('typing failed'); },
    paste: async text => { calls.push('paste'); inputs.push(text); acted = true; },
    pressKey: async () => { calls.push('pressKey'); },
    click: async () => { calls.push('click'); },
  };
  const context = { app: raw, cua: { getApp: async () => raw }, nodeRepl: { write: text => output.push(text) },
    performance: { now: () => now }, setTimeout: (fn, ms) => setImmediate(() => { delays.push(ms); now += ms; fn(); }),
    clearTimeout: clearImmediate };
  return { output, delays, inputs, calls, context, get reads() { return reads; }, get now() { return now; },
    run: code => runInNewContext(`(async () => { ${guardedCode(code, windowFromText(before), undefined, undefined, guardOptions)} })()`, context) };
}

for (const record of recordings) for (const explicit of [false, true]) {
  test(`Cursor attempt ${record.attempt}, ${explicit ? 'explicit' : 'tail'} read with effect available at 700 ms`, async () => {
    // Recorded AX snapshots, with a synthetic 700 ms availability time for the final effect.
    // Receipt timestamps and intervening calls remain in the fixture; they do not measure AX readiness.
    const before = record.first.tree, after = record.subsequent.at(-1).tree;
    const f = fixture(before, [before, after]);
    const code = 'await app.typeText("@computer use");' + (explicit ? ' await app.getAXState();' : '');
    await f.run(code);
    assert.equal(f.reads, 2);
    assert.deepEqual(f.delays, [700]);
    assert.equal(f.inputs.length, 1, 'retry the read, never the input');
    assert.match(f.output.join(''), /Value: @computer use/);
    assert.doesNotMatch(f.output.join(''), /Placeholder: Plan/);
    const compactor = createReadCompactor();
    compactor.process([{ type: 'text', text: before }]);
    const action = compactor.beginAction(code);
    const content = [{ type: 'text', text: f.output.join('') }];
    const compacted = compactor.process(content, { action, code });
    assert.doesNotMatch(JSON.stringify(compacted), /typing reached nothing/);
    assert.equal(typedTextReceipt({ action, content: [...content, { type: 'text', text: 'mark{"typedCharacters":13}\n' }], mark: 'mark' }), undefined);
  });
}

for (const record of recordings) test(`Cursor attempt ${record.attempt} preserves all recorded replies and receipt gaps`, async () => {
  const snapshots = [record.first, ...record.subsequent];
  const replyAtMs = snapshots.map(snapshot => Date.parse(snapshot.at) - Date.parse(record.first.at));
  const before = record.first.tree, f = fixture(before, snapshots.map(snapshot => snapshot.tree), { replyAtMs });
  // Receipt gaps include model time and intervening clicks. Replay those observed
  // replies in order, including the still-empty acquisition in attempts 6, 9, 10.
  // They cannot establish that a single 700 ms retry suffices on the real app.
  const code = 'await app.typeText("@computer use");' +
    ' await app.getAXState();'.repeat(snapshots.length - 1);
  await f.run(code);
  assert.equal(f.reads, snapshots.length);
  assert.equal(f.now, replyAtMs.at(-1));
  assert.deepEqual(f.delays, [700]);
  assert.equal(f.inputs.length, 1);
  const compactor = createReadCompactor();
  compactor.process([{ type: 'text', text: before }]);
  const action = compactor.beginAction(code), content = f.output.map(text => ({ type: 'text', text }));
  const result = JSON.stringify(compactor.process(content, { action, code }));
  assert.match(result, /Value: @computer use/);
  assert.doesNotMatch(result, /typing reached nothing|typing lost/);
});

test('TextEdit shows the text on its first read with zero extra delay or read', async () => {
  const f = fixture(native('existing'), [native('existing hello')], { readMs: 40 });
  await f.run('await app.typeText("hello");');
  assert.deepEqual(f.delays, []);
  assert.equal(f.reads, 1);
  assert.equal(f.now, 80);
});

for (const action of ['pressKey("Return")', 'click(1)']) test(`an unchanged guard read before ${action} never settles typing`, async () => {
  const before = native('existing'), f = fixture(before, [before], { guardOptions: { careful: true } });
  await f.run(`await app.typeText("hello"); await app.${action};`);
  assert.deepEqual(f.delays, []);
  assert.deepEqual(f.calls, ['read', 'typeText', 'read', action.split('(')[0], 'read']);
  assert.deepEqual(f.inputs, ['hello']);
});

test('a focus-only change on the first observation is preserved without a retry', async () => {
  const before = native('existing'), after = before.replace('The focused UI element is 1 text entry area Body', 'The focused UI element is 2 button Other');
  const f = fixture(before, [after, before]);
  await f.run('await app.typeText("hello"); await app.getAXState();');
  assert.deepEqual(f.delays, []);
  assert.equal(f.reads, 1);
  assert.match(f.output.join(''), /The focused UI element is 2 button Other/);
});

for (const [kind, after] of [
  ['window', native('existing').replaceAll('Untitled', 'Other')],
  ['sheet', 'Window: "Confirm removal", App: TextEdit.\n0 sheet\n\t1 button Delete Group'],
]) for (const retry of [false, true]) test(`a ${kind} on the ${retry ? 'retry' : 'first'} observation still stops the next click`, async () => {
  const before = native('existing'), f = fixture(before, retry ? [before, after] : [after, before]);
  await assert.rejects(f.run('await app.typeText("hello"); await app.getAXState(); await app.click(1);'), /Document scope stopped/);
  assert.deepEqual(f.delays, retry ? [700] : []);
  assert.ok(!f.calls.includes('click'));
});

test('a focus change on the retry reaches the caller and the guard cache', async () => {
  const before = native('existing'), after = before.replace('The focused UI element is 1 text entry area Body', 'The focused UI element is 2 button Other');
  const f = fixture(before, [before, after]);
  await f.run('await app.typeText("hello"); await app.getAXState();');
  assert.deepEqual(f.delays, [700]);
  assert.match(f.output.join(''), /The focused UI element is 2 button Other/);
  const state = f.context.__sleightDocumentGuard;
  assert.equal(state.reads.get(f.context.app).text, after);
});

test('a true miss keeps the notice after exactly one extra read', async () => {
  const before = native('existing'), f = fixture(before, [before]);
  await f.run('await app.typeText("hello"); await app.getAXState(); await app.getAXState();');
  assert.deepEqual(f.delays, [700]);
  assert.equal(f.reads, 3, 'two requested reads and one settling read');
  const compactor = createReadCompactor();
  compactor.process([{ type: 'text', text: before }]);
  const code = 'await app.typeText("hello")', action = compactor.beginAction(code);
  assert.match(JSON.stringify(compactor.process([{ type: 'text', text: f.output.at(-1) }], { action, code })), /typing reached nothing/);
});

test('the no-change path adds 700 ms plus one engine read', async () => {
  const before = native('existing'), f = fixture(before, [before, native('hello')], { readMs: 40 });
  await f.run('await app.paste("hello");');
  assert.equal(f.now, 820, '80 ms ordinary reads plus 700 ms wait plus 40 ms extra read');
  assert.equal(f.reads, 2);
});

for (const explicit of [false, true]) test(`a failed ${explicit ? 'explicit' : 'tail'} verification read records sent input before throwing`, async () => {
  const before = native('existing'), f = fixture(before, [before, new Error('read failed')], { guardOptions: { resultMark: 'typed-mark' } });
  await assert.rejects(f.run('await app.typeText("hello");' + (explicit ? ' await app.getAXState();' : '')), /read failed/);
  assert.deepEqual(f.delays, [700]);
  assert.match(f.output.join(''), /Input sent/);
  assert.match(f.output.join(''), /typed-mark\{"typed":\["hello"\]\}/);
  assert.deepEqual(f.inputs, ['hello']);
  assert.doesNotMatch(f.output.join(''), /typing reached nothing/);
});

test('each typing action can settle after the earlier action already settled', async () => {
  const before = native('existing'), after = native('existing hello');
  const f = fixture(before, [before, after, after, native('existing hello world')]);
  await f.run('await app.typeText("hello"); await app.getAXState(); await app.typeText("world");');
  assert.deepEqual(f.delays, [700, 700]);
  assert.deepEqual(f.inputs, ['hello', 'world']);
  assert.match(f.output.at(-1), /Value: existing hello world/);
});

test('a changed first typing read does not spend the next typing action retry', async () => {
  const before = native('existing'), after = native('existing hello');
  const f = fixture(before, [after, after, native('existing hello world')]);
  await f.run('await app.typeText("hello"); await app.getAXState(); await app.typeText("world");');
  assert.deepEqual(f.delays, [700]);
  assert.match(f.output.at(-1), /Value: existing hello world/);
});

test('concurrent reads after typing both receive the settled tree', async () => {
  const before = native('existing'), after = native('hello');
  // Both ordinary reads would be stale; one shared verification read sees the edit.
  const f = fixture(before, [now => now >= 700 ? after : before]);
  await f.run('await app.typeText("hello"); const trees = await Promise.all([app.getAXState(), app.getAXState()]); nodeRepl.write(JSON.stringify(trees));');
  const trees = JSON.parse(f.output.at(-1));
  assert.deepEqual(trees, [after, after]);
  assert.deepEqual(f.delays, [700]);
  assert.equal(f.reads, 2, 'one shared first read plus one verification read');
  assert.deepEqual(f.inputs, ['hello']);
});

test('typing settles share the existing 3000 ms call budget', async () => {
  const before = native('existing'), f = fixture(before, [before], { readMs: 40 });
  await f.run('for (let i = 0; i < 6; i++) { await app.typeText("hello"); await app.getAXState(); }');
  assert.deepEqual(f.delays, [700, 700, 700, 700]);
  assert.equal(f.inputs.length, 6);
  assert.equal(f.reads, 10);
});

for (const text of ['', '\n', '\r\n', '\n\n']) test(`empty or newline-only input ${JSON.stringify(text)} skips settling`, async () => {
  const before = native('existing'), f = fixture(before, [before], { readMs: 40 });
  await f.run(`await app.typeText(${JSON.stringify(text)});`);
  assert.deepEqual(f.delays, []);
  assert.equal(f.reads, 1);
  assert.equal(f.now, 80);
  assert.deepEqual(f.inputs, [text]);
});

for (const [name, value, method, text] of [
  ['truncated Value', 'visible prefix…', 'typeText', 'hidden suffix'],
  ['identical replacement paste', 'same text', 'paste', 'same text'],
  ['widget without AX text', '', 'typeText', 'hidden text'],
]) test(`${name} still costs one wait when successful input leaves AX unchanged`, async () => {
  const before = native(value), f = fixture(before, [before], { readMs: 40 });
  await f.run(`await app.${method}(${JSON.stringify(text)});`);
  assert.deepEqual(f.inputs, [text]);
  assert.deepEqual(f.delays, [700]);
  assert.equal(f.reads, 2);
  assert.equal(f.now, 820, '740 ms extra over the ordinary 80 ms call');
});

test('a failed input followed by a caught read never settles that input', async () => {
  const before = native('existing'), f = fixture(before, [before], { fail: true });
  await f.run('try { await app.typeText("hello"); } catch {} await app.getAXState();');
  assert.deepEqual(f.delays, []);
  assert.equal(f.reads, 1);
  assert.match(f.output.join(''), /an action in this call failed/);
});

test('a typing error adds no settling read', async () => {
  const before = native('existing'), f = fixture(before, [before], { fail: true });
  await assert.rejects(f.run('await app.typeText("hello");'), /typing failed/);
  assert.deepEqual(f.delays, []);
  assert.equal(f.reads, 0);
});

test('a changed window and a secure field add no settling delay', async () => {
  const before = native('existing');
  for (const [baseline, after] of [[before, before.replace('Untitled', 'Other')],
    [before.replaceAll('text entry area (settable) Body', 'secure text field Password'), before.replaceAll('text entry area (settable) Body', 'secure text field Password')]]) {
    const f = fixture(baseline, [after]);
    await f.run('await app.typeText("hello");');
    assert.deepEqual(f.delays, []);
    assert.equal(f.reads, 1);
  }
});

test('a multiline value change adds no wait', async () => {
  const before = native('first\nold'), f = fixture(before, [native('first\nnew')]);
  await f.run('await app.typeText("new");');
  assert.deepEqual(f.delays, []);
  assert.equal(f.reads, 1);
});

test('an engine read in flight finishes after the wait, without an early timeout verdict', async () => {
  let finish, resolved = false;
  const before = native('existing');
  const pending = settleTyping(() => new Promise(resolve => { finish = resolve; }), before, before, 'hello')
    .then(value => { resolved = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 720));
  assert.equal(resolved, false);
  assert.equal(typeof finish, 'function');
  finish(native('hello'));
  assert.equal(await pending, native('hello'));
});

for (const readFails of [false, true]) test(`the relay delivers ${readFails ? 'sent input and read failure' : 'the settled tree'} without a typing miss`, async t => {
  const before = recordings[0].first.tree, after = recordings[0].subsequent.at(-1).tree;
  const f = fixture(before, [before, readFails ? new Error('verification read failed') : after]);
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [];
  serverIn.on('data', data => sent.push(...data.toString().trim().split('\n').map(JSON.parse)));
  clientOut.on('data', data => received.push(...data.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease: false, changeReview: true });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); });
  const call = (id, code) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  const reply = (id, content, isError = false) => serverOut.write(JSON.stringify({ id, result: { content, isError } }) + '\n');
  const tick = () => new Promise(resolve => setImmediate(resolve));
  call(1, 'let app = await cua.getApp("Cursor");');
  await tick();
  // The relay's acquisition installs the same persistent guard as the engine receives.
  await runInNewContext(`(async () => { ${sent.find(m => m.id === 1).params.arguments.code} })()`, f.context);
  reply(1, [{ type: 'text', text: before }]);
  await tick();
  f.output.length = 0;
  call(2, 'await app.typeText("@computer use");');
  await tick();
  const execution = runInNewContext(`(async () => { ${sent.find(m => m.id === 2).params.arguments.code} })()`, f.context);
  if (readFails) {
    await assert.rejects(execution, /verification read failed/);
    f.output.push('Error: verification read failed');
  } else await execution;
  reply(2, f.output.map(text => ({ type: 'text', text })), readFails);
  await tick();
  const text = JSON.stringify(received.find(m => m.id === 2));
  if (readFails) {
    assert.match(text, /Input sent/);
    assert.match(text, /verification read failed/);
    assert.equal(received.find(m => m.id === 2).result.isError, true);
  } else assert.match(text, /Value: @computer use/);
  assert.doesNotMatch(text, /typing reached nothing|typing lost|insertion unconfirmed|typedCharacters/);
  assert.deepEqual(f.delays, [700]);
  assert.equal(sent.length, 2, 'settling stays in the original engine call');
  assert.equal(f.inputs.length, 1);
});

test('a reused guard with an admitted prior tree still settles its first typing action', async () => {
  const before = native('existing'), f = fixture(before, [before, native('hello')], {
    guardOptions: { reuseSetup: true, firstOff: true, focused: true, prior: { text: before, windows: null } },
  });
  await runInNewContext(`(async () => { ${readCode('app = await cua.getApp("TextEdit");')} })()`, f.context);
  await f.run('await app.typeText("hello");');
  assert.deepEqual(f.delays, [700]);
  assert.equal(f.reads, 2);
  assert.match(f.output.join(''), /Value: hello/);
});
