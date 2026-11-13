import { test } from './macos-only.mjs';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { splitTextSave, prepareTextWrite, settleTextWrite } from '../plugins/sleight/lib/text-save.mjs';
import { createSessionPause } from '../plugins/sleight/lib/session-pause.mjs';
import { FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';

const header = 'Window: "a.txt", App: Editor.\n0 standard window, URL: file:///tmp/a.txt\n2 text area';
const rpc = (id, code) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } });
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, options = {}) {
  const { leaseOptions, ...relayOptions } = options;
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [], settled = [];
  for (const [stream, messages] of [[serverIn, sent], [clientOut, received]]) {
    stream.on('data', data => messages.push(...data.toString().trim().split('\n').map(JSON.parse)));
  }
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-text-save-'))));
  const inputLease = new InputLease({ directory, holder: 'save test', ...leaseOptions });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease, changeReview: false,
    settleTextWrite: async target => { settled.push(target); }, ...relayOptions });
  t.after(() => { relay.close(); for (const s of [clientIn, clientOut, serverIn, serverOut]) s.destroy(); });
  const call = (id, code) => clientIn.write(JSON.stringify(rpc(id, code)) + '\n');
  const reply = (id, text = header, isError = false) => serverOut.write(JSON.stringify({ jsonrpc: '2.0', id,
    result: { content: [{ type: 'text', text }], isError,
      _meta: { 'codex/toolSurface': { kind: 'computerUse', app: { appId: 'org.test.editor' } } } } }) + '\n');
  call(0, 'let app = await cua.getApp("Editor")'); reply(0);
  sent.length = received.length = 0;
  return { call, reply, sent, received, settled, inputLease, relay, clientIn };
}

test('the save splitter respects strings, comments, control flow and handle identity', () => {
  for (const key of ['cmd+s', 'command+s', 'super+s', 'META+S']) {
    const head = 'await editor.setValue(2, "a; b");';
    const tail = `await editor.pressKey("${key}"); await editor.getAXState();`;
    assert.deepEqual(splitTextSave(head + '\n' + tail), { handle: 'editor', head, tail });
  }
  for (const code of [
    'await app.typeText("x"); await app.pressKey("cmd+s");',
    'await app.setValue(2, "x"); await other.pressKey("cmd+s");',
    'await app.setValue(2, "x"); await app.pressKey("cmd+shift+s");',
    'await app.typeText("await app.setValue(2, x); await app.pressKey(cmd+s)");',
    '// await app.setValue(2, "x");\nawait app.pressKey("cmd+s");',
    'if (enabled) { await app.setValue(2, "x"); } await app.pressKey("cmd+s");',
    'await app.setValue(2, "x"); app = other; await app.pressKey("cmd+s");',
    'await app.setValue(2, "x").then(f); await app.pressKey("cmd+s");',
  ]) assert.equal(splitTextSave(code), undefined, code);
});

test('a return or throw before the write keeps the whole call unsplit', () => {
  for (const prefix of ['if (!ok) return "skip";', 'if (!ok) throw Error("skip");', 'throw Error("skip");']) {
    assert.equal(splitTextSave(prefix + '\nawait app.setValue(2,"x");\nawait app.pressKey("cmd+s");'), undefined);
  }
});

test('assigned awaited writes still split before the same handle save', () => {
  for (const declaration of ['const r = ', 'let r = ', 'var r = ']) {
    const head = declaration + 'await app.setValue(2, "x");';
    const tail = 'await app.pressKey("cmd+s");';
    assert.deepEqual(splitTextSave(head + '\n' + tail), { handle: 'app', head, tail });
  }
});

test('the native settle checks identity and the stop generation before starting its helper', async () => {
  const target = { appId: 'org.test.editor', title: 'a', url: null };
  const calls = [];
  const identity = async () => ({ ...target, status: 'ok', matches: 1, epoch: 'helper', window: 1, pid: 321, processStart: 42 });
  const run = async (...args) => { calls.push(args); return { ok: true }; };
  await settleTextWrite(target, () => true, { path: '/lease', token: 'owned' }, { identity, run });
  assert.equal(calls[0][0], 'settle-text-write.js'); assert.equal(calls[0][1].pid, 321);
  for (const [current, observe] of [[() => false, identity], [() => true, async () => ({ status: 'unknown' })]]) {
    await assert.rejects(settleTextWrite(target, current, {}, { identity: observe, run }));
  }
  assert.equal(calls.length, 1);
});

test('setValue then save runs as write, leased Shift settle, then save with one client reply', async t => {
  let finish;
  const h = fixture(t, { settleTextWrite: (target, current, grant) => {
    h.settled.push(target); assert.equal(current(), true); assert.ok(grant.token);
    return new Promise(resolve => { finish = resolve; });
  } });
  h.call(1, 'await app.setValue(2, "updated"); await app.pressKey("cmd+s");');
  const first = h.sent.at(-1);
  assert.notEqual(first.id, 1);
  assert.doesNotMatch(first.params.arguments.code, /pressKey\("cmd\+s"\)/);
  h.reply(first.id, 'write completed\n' + header); await tick();
  assert.equal(h.settled.length, 1); assert.equal(h.settled[0].appId, 'org.test.editor');
  assert.equal(h.sent.length, 1); assert.equal(h.received.length, 0);
  h.call(2, 'await app.typeText("concurrent")');
  assert.match(h.received.at(-1).result.content[0].text, /pending/);
  finish(); await tick();
  assert.equal(h.sent.at(-1).id, 1);
  assert.match(h.sent.at(-1).params.arguments.code, /pressKey\("cmd\+s"\)/);
  assert.doesNotMatch(h.sent.at(-1).params.arguments.code, /setValue\(2, "updated"\)/);
  h.reply(1, 'save completed\n' + header);
  const replies = h.received.filter(m => m.id === 1);
  assert.equal(replies.length, 1); assert.notEqual(replies[0].result.isError, true);
  assert.match(JSON.stringify(replies[0]), /write completed/); assert.match(JSON.stringify(replies[0]), /save completed/);
});

test('a failed write never posts Shift or sends the save', async t => {
  const h = fixture(t);
  h.call(1, 'await app.setValue(2, "updated"); await app.pressKey("super+s");');
  const first = h.sent.at(-1); assert.notEqual(first.id, 1);
  h.reply(first.id, 'write failed', true); await tick();
  assert.equal(h.sent.length, 1); assert.equal(h.settled.length, 0);
  assert.equal(h.received.at(-1).id, 1); assert.equal(h.received.at(-1).result.isError, true);
});

test('a save-tail guard stop still reports possible input from the completed write prefix', async t => {
  const h = fixture(t);
  h.call(1, 'await app.setValue(2, "updated"); await app.pressKey("super+s");');
  h.reply(h.sent.at(-1).id); await tick();
  const tail = h.sent.at(-1);
  assert.equal(tail.id, 1);
  const update = JSON.parse(/__sleightDocumentGuardSetup\((\{[^\n]*\})\);/.exec(tail.params.arguments.code)[1]);
  const cause = 'Input lease stopped this action: the window changed.';
  h.reply(1, update.guardStopMark + JSON.stringify({ index: 0, attempts: 1, error: cause, windowStop: false }) + '\n' + cause, true);
  const output = JSON.stringify(h.received.at(-1));
  assert.match(output, /call failed \(partial input possible\)/);
  assert.doesNotMatch(output, /no input was sent|sleight:guard-stop:/);
  assert.match(output, /window changed/);
});

test('a changed window after the write stops before Shift and save', async t => {
  const h = fixture(t);
  h.call(1, 'await app.setValue(2, "updated"); await app.pressKey("super+s");');
  const first = h.sent.at(-1); assert.notEqual(first.id, 1);
  h.reply(first.id, header.replaceAll('a.txt', 'b.txt')); await tick();
  assert.equal(h.sent.length, 1); assert.equal(h.settled.length, 0);
  assert.equal(h.received.at(-1).result.isError, true);
});

test('settle failure preserves the completed write and sends only the save tail', async t => {
  const h = fixture(t, { settleTextWrite: async () => { throw new Error('identity lookup failed'); } });
  h.call(1, 'await app.setValue(2, "updated"); await app.pressKey("command+s");');
  const first = h.sent.at(-1); assert.notEqual(first.id, 1);
  h.reply(first.id); await tick();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent.at(-1).id, 1);
  assert.doesNotMatch(h.sent.at(-1).params.arguments.code, /await app\.setValue\(2, "updated"\)/);
  h.reply(1, 'saved\n' + header);
  assert.notEqual(h.received.at(-1).result.isError, true);
  assert.match(JSON.stringify(h.received.at(-1)), /settle.*skipped/i);
  assert.match(JSON.stringify(h.received.at(-1)), /identity lookup failed/);
});

test('a missing helper forwards the original call once with a skip note', t => {
  const h = fixture(t, { settleTextWrite: undefined });
  h.call(1, 'await app.setValue(2, "updated"); await app.pressKey("cmd+s");');
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].id, 1);
  assert.match(h.sent[0].params.arguments.code, /setValue\(/);
  assert.match(h.sent[0].params.arguments.code, /pressKey\("cmd\+s"\)/);
  h.reply(1);
  assert.match(JSON.stringify(h.received.at(-1)), /settle.*skipped/i);
});

for (const reason of ['identity unavailable', 'two matching instances']) test(`${reason} forwards an unsplit call before writing`, async t => {
  const h = fixture(t, { prepareTextWrite: async () => { throw Error(reason); } });
  h.call(1, 'await app.setValue(2, "updated"); await app.pressKey("cmd+s");');
  await tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].id, 1);
  assert.match(h.sent[0].params.arguments.code, /setValue\(/);
  assert.match(h.sent[0].params.arguments.code, /pressKey\("cmd\+s"\)/);
  assert.equal(h.settled.length, 0);
  h.reply(1);
  assert.match(JSON.stringify(h.received.at(-1)), /settle.*skipped/i);
  assert.ok(JSON.stringify(h.received.at(-1)).includes(reason));
});

test('preflight identity validation sends no helper event', async () => {
  const target = { appId: 'org.test.editor', title: 'a', url: null };
  let events = 0;
  const options = { identity: async () => ({ ...target, status: 'ok', matches: 1,
    epoch: 'helper', window: 1, pid: 321, processStart: 42 }), run: async () => { events++; } };
  assert.equal((await prepareTextWrite(target, () => true, options)).pid, 321);
  await assert.rejects(prepareTextWrite(target, () => true, { ...options, run: undefined }), /unavailable/);
  await assert.rejects(prepareTextWrite(target, () => true, { ...options,
    identity: async () => ({ ...await options.identity(), matches: 2 }) }), /ambiguous/);
  assert.equal(events, 0);
});

test('a successful preflight reserves the call and then starts the write once', async t => {
  let ready, checked = 0;
  const h = fixture(t, { prepareTextWrite: () => { checked++; return new Promise(resolve => { ready = resolve; }); } });
  h.call(1, 'await app.setValue(2, "updated"); await app.pressKey("cmd+s");');
  await tick();
  assert.equal(h.sent.length, 0);
  h.call(2, 'await app.typeText("concurrent")');
  assert.match(JSON.stringify(h.received.at(-1)), /pending/);
  ready(); await tick();
  assert.equal(checked, 1);
  assert.equal(h.sent.length, 1);
  assert.match(String(h.sent[0].id), /sleight-text-write/);
  h.reply(h.sent[0].id); await tick();
  assert.equal(h.sent.at(-1).id, 1);
  assert.equal(h.settled.length, 1);
});

test('disposing a pending preflight prevents both write and save', async t => {
  let ready;
  const h = fixture(t, { prepareTextWrite: () => new Promise(resolve => { ready = resolve; }) });
  h.call(1, 'await app.setValue(2, "updated"); await app.pressKey("cmd+s");');
  await tick(); h.relay.dispose(); ready(); await tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.settled.length, 0);
});
test('pause and resume during text-save preflight cannot admit a new internal prefix', async t => {
  let ready;
  const pause = createSessionPause();
  const h = fixture(t, { pause, prepareTextWrite: () => new Promise(resolve => { ready = resolve; }) });
  h.call(1, 'await app.setValue(2, "updated"); await app.pressKey("cmd+s");');
  await tick(); pause.set(true); pause.set(false); ready(); await tick();
  assert.equal(h.sent.length, 0); assert.equal(h.settled.length, 0);
  assert.match(JSON.stringify(h.received), /Paused by the user/);
});

test('a confirmed native mismatch during preflight still stops before writing', async t => {
  const h = fixture(t, { prepareTextWrite: (target, current) => prepareTextWrite(target, current, {
    identity: async () => ({ status: 'mismatch', error: 'the native window changed' }), run: async () => ({ ok: true }),
  }) });
  h.call(1, 'await app.setValue(2, "updated"); await app.pressKey("cmd+s");');
  await tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.received.at(-1).result.isError, true);
});

test('incomplete identity metadata is unavailable and keeps the original guarded call', async t => {
  const h = fixture(t, { prepareTextWrite: (target, current) => prepareTextWrite(target, current, {
    identity: async () => ({ ...target, status: 'ok', matches: 1 }), run: async () => ({ ok: true }),
  }) });
  h.call(1, 'await app.setValue(2, "updated"); await app.pressKey("cmd+s");');
  await tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].id, 1);
  assert.match(h.sent[0].params.arguments.code, /await app\.setValue\(2, "updated"\)/);
});

test('a changed process reported by the native settle still prevents saving', async t => {
  const h = fixture(t, { settleTextWrite: (target, current, grant) => settleTextWrite(target, current, grant, {
    identity: async () => ({ ...target, status: 'ok', matches: 1, epoch: 'helper', window: 1, pid: 321, processStart: 42 }),
    run: async () => ({ ok: false, error: 'The target process changed' }),
  }) });
  h.call(1, 'await app.setValue(2, "updated"); await app.pressKey("cmd+s");');
  h.reply(h.sent.at(-1).id); await tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.received.at(-1).result.isError, true);
  assert.match(JSON.stringify(h.received.at(-1)), /target process changed/);
});

test('the settle continuation cannot save after disposal', async t => {
  let finish, current;
  const h = fixture(t, { settleTextWrite: (_target, isCurrent) => {
    current = isCurrent; return new Promise(resolve => { finish = resolve; });
  } });
  h.call(1, 'await app.setValue(2, "updated"); await app.pressKey("super+s");');
  const first = h.sent.at(-1); assert.notEqual(first.id, 1);
  h.reply(first.id); await tick(); h.relay.dispose();
  assert.equal(current(), false); finish(); await tick();
  assert.equal(h.sent.length, 1);
});

test('an acquisition, write and save share one reply across both splits', async t => {
  const h = fixture(t);
  h.call(1, 'let app = await cua.getApp("Editor"); await app.setValue(2, "updated"); await app.pressKey("super+s");');
  const acquisition = h.sent.at(-1); assert.match(String(acquisition.id), /^sleight-acquire-/);
  h.reply(acquisition.id, 'acquired\n' + header);
  const write = h.sent.at(-1); assert.match(String(write.id), /^sleight-text-write-/);
  h.reply(write.id, 'written\n' + header); await tick();
  assert.equal(h.sent.at(-1).id, 1); assert.equal(h.settled.length, 1);
  h.reply(1, 'saved\n' + header);
  assert.equal(h.received.length, 1);
  for (const word of ['acquired', 'written', 'saved']) assert.match(JSON.stringify(h.received[0]), new RegExp(word));
});

test('lease expiry during settling prevents the save', async t => {
  let now = Date.now(), finish;
  const h = fixture(t, { leaseOptions: { now: () => now }, settleTextWrite: () => new Promise(resolve => { finish = resolve; }) });
  h.call(1, 'await app.setValue(2, "updated"); await app.pressKey("super+s");');
  h.reply(h.sent.at(-1).id); await tick();
  now += 31000; finish(); await tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.received.at(-1).result.isError, true);
  assert.match(JSON.stringify(h.received.at(-1)), /ownership lost or expired/);
});

test('stop and resume cannot revive a save waiting for its settle helper', async t => {
  let finish, current;
  const h = fixture(t, { stopGraceMs: 1, stopEngine: async () => ({ collected: false }),
    settleTextWrite: (_target, isCurrent) => { current = isCurrent; return new Promise(resolve => { finish = resolve; }); } });
  h.call(1, 'await app.setValue(2, "updated"); await app.pressKey("super+s");');
  h.reply(h.sent.at(-1).id); await tick();
  const end = (id, args) => h.clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'turn_ended', arguments: args } }) + '\n');
  end(2, { sleight_stop: true }); assert.equal(current(), false);
  await new Promise(resolve => setTimeout(resolve, 10));
  end(3, { sleight_resume: true }); finish(); await tick();
  assert.equal(h.sent.some(m => m.id === 1), false);
});

test('an unawaited action in the save tail refuses the entire call before the write', t => {
  const h = fixture(t);
  h.call(1, 'await app.setValue(2, "updated"); await app.pressKey("super+s"); app.click(3); await app.getAXState();');
  assert.equal(h.sent.length, 0);
  assert.match(JSON.stringify(h.received.at(-1)), /no await/);
});

test('a flow refusal in the save tail stops the entire call before the write', t => {
  const flowRules = new FlowRules({ version: 1, rules: [{ id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] }] });
  const h = fixture(t, { flowRules });
  h.call(1, 'await app.setValue(2, "updated"); await app.pressKey("super+s"); await app.typeText("SECRET");');
  assert.equal(h.sent.length, 0);
  assert.match(JSON.stringify(h.received.at(-1)), /secret/);
});

test('the write prefix\'s private input receipt never reaches Claude', async t => {
  const h = fixture(t);
  h.call(1, 'await app.setValue(2, "updated"); await app.pressKey("super+s");');
  const first = h.sent.at(-1);
  const mark = /"guardStopMark":"(\[sleight:guard-stop:[^\]"]+\])"/.exec(first.params.arguments.code)?.[1];
  assert.ok(mark, 'the write prefix carries its own guard mark');
  h.reply(first.id, mark + JSON.stringify({ input: true }) + '\nwrite completed\n' + header); await tick();
  h.reply(1, 'save completed\n' + header); await tick();
  const output = JSON.stringify(h.received.filter(m => m.id === 1));
  assert.match(output, /write completed/);
  assert.doesNotMatch(output, /sleight:guard-stop:/);
});
