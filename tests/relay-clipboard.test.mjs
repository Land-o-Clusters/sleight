import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

function fixture({ mode = 'preserve', readFailure } = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  let board = { count: 10, items: [[{ type: 'old', data: 'b2xk' }]] }, held = false;
  const messages = [], replies = [];
  serverIn.on('data', data => messages.push(JSON.parse(data)));
  clientOut.on('data', data => replies.push(JSON.parse(data)));
  const clipboardIO = async request => {
    if (request.op === 'acquire') { assert.equal(held, false); held = true; return; }
    if (request.op === 'release') { held = false; return; }
    if (request.op === 'read') { if (readFailure) throw new Error(readFailure); return structuredClone(board); }
    assert.equal(board.count, request.expectedCount);
    board = { count: board.count + 1, items: structuredClone(request.items) }; return structuredClone(board);
  };
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, clipboardIO, clipboardMode: mode === 'native' ? undefined : mode });
  return { relay, messages, replies, held: () => held, board: () => board,
    copy: () => { board = { count: board.count + 1, items: [[{ type: 'copy', data: 'Y29weQ==' }]] }; },
    reset: id => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js_reset', arguments: {} } }) + '\n'),
    send: (id, code) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n'),
    reply: (id, isError = false, text = 'engine result') => serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, result: { isError, content: [{ type: 'text', text }] } }) + '\n'),
  };
}
test('relay snapshots before Copy and restores before publishing its result; private Paste restores on engine failure', async () => {
  const h = fixture();
  try {
    h.send(1, 'await app.pressKey("super+c")'); await setImmediate();
    assert.equal(h.messages.length, 1); assert.equal(h.held(), true);
    assert.match(h.messages[0].params.arguments.code, /installClipboardPermit/);
    h.copy(); h.reply(1); await setImmediate();
    assert.equal(h.replies.length, 1); assert.equal(h.board().items[0][0].type, 'old'); assert.equal(h.held(), false);
    h.send(2, 'await app.pressKey("super+v")'); await setImmediate();
    assert.equal(h.board().items[0][0].type, 'copy');
    h.reply(2, true); await setImmediate();
    assert.equal(h.board().items[0][0].type, 'old'); assert.equal(h.replies.at(-1).result.isError, true); assert.equal(h.held(), false);
  } finally { h.relay.close(); }
});
test('helper recovery waits for preserved Copy and keeps its reply behind clipboard restoration', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const h = fixture();
  try {
    h.send(1, 'let te = await cua.getApp("TextEdit")'); h.reply(1);
    for (const id of [2, 3]) { h.send(id, 'let calc = await cua.getApp("Calculator")'); h.reply(id, true, '-10005 timeoutReached'); }
    h.send(4, 'await te.pressKey("super+c")'); await setImmediate();
    assert.equal(h.messages.at(-1).id, 4); assert.equal(h.held(), true);
    t.mock.timers.tick(20000);
    assert.equal(h.messages.at(-1).id, 4, 'the helper read waits for the Copy result');
    h.copy(); h.reply(4); await setImmediate();
    assert.equal(h.replies.at(-1).id, 4);
    assert.equal(h.board().items[0][0].type, 'old'); assert.equal(h.held(), false);
    t.mock.timers.tick(1000);
    const probe = h.messages.at(-1);
    assert.match(String(probe.id), /^sleight-helper-/);
    h.reply(probe.id);
    assert.equal(h.replies.at(-1).id, 4, 'the automatic reply stays internal');
  } finally { await h.relay.close(); }
});

test('compound clipboard actions stop before forwarding; ordinary JS gets runtime enforcement', async () => {
  const h = fixture();
  try {
    h.send(1, 'app.pressKey("super+x"); app.pressKey("super+v")'); await setImmediate();
    assert.equal(h.messages.length, 0); assert.match(h.replies[0].result.content[0].text, /split.*retry/i);
    assert.doesNotMatch(h.replies[0].result.content[0].text, /Change review|Stop and tell/);
    h.send(2, 'const app = await cua.getApp("TextEdit")');
    assert.equal(h.messages.length, 1); assert.ok(h.messages[0].params.arguments.code.endsWith('const app = await cua.getApp("TextEdit")'));
  } finally { h.relay.close(); }
});
test('closing the relay cancels a pending private Paste and restores the owned clipboard', async () => {
  const h = fixture();
  h.send(1, 'app.pressKey("super+c")'); await setImmediate(); h.copy(); h.reply(1); await setImmediate();
  h.send(2, 'app.pressKey("super+v")'); await setImmediate();
  h.relay.close(); await setImmediate();
  assert.equal(h.board().items[0][0].type, 'old'); assert.equal(h.held(), false);
});

test('successful engine reset clears the session copy', async () => {
  const h = fixture();
  try {
    h.send(1, 'app.pressKey("super+c")'); await setImmediate(); h.copy(); h.reply(1); await setImmediate();
    // Simulate a successful reset response through the same server stream.
    h.reset(2); h.reply(2); await setImmediate();
    h.send(3, 'app.pressKey("super+v")'); await setImmediate();
    assert.equal(h.board().items[0][0].type, 'old'); h.reply(3); await setImmediate();
  } finally { await h.relay.close(); }
});

test('awaited close drains a delayed snapshot before any engine dispatch', async () => {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  let resume, released = false; const forwarded = [];
  serverIn.on('data', data => forwarded.push(data));
  const clipboardIO = async request => {
    if (request.op === 'read') { await new Promise(resolve => { resume = resolve; }); return { count: 1, items: [] }; }
    if (request.op === 'release') released = true;
  };
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, clipboardIO, clipboardMode: 'preserve' });
  clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'js', arguments: { code: 'app.pressKey("super+c")' } } }) + '\n');
  await setImmediate();
  let completed = false; const closing = Promise.resolve(relay.close()).then(() => { completed = true; });
  await setImmediate(); assert.equal(completed, false);
  resume(); await closing;
  assert.equal(forwarded.length, 0); assert.equal(released, true);
});

test('awaited close waits for native restoration and releases the clipboard reservation', async () => {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  let board = { count: 1, items: [[{ type: 'old', data: 'b2xk' }]] }, delay = false, resume, held = false;
  const clipboardIO = async request => {
    if (request.op === 'acquire') { held = true; return; }
    if (request.op === 'release') { held = false; return; }
    if (request.op === 'read') return structuredClone(board);
    if (delay) await new Promise(resolve => { resume = resolve; });
    assert.equal(board.count, request.expectedCount); board = { count: board.count + 1, items: request.items }; return structuredClone(board);
  };
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, clipboardIO, clipboardMode: 'preserve' });
  const send = (id, code) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  send(1, 'app.pressKey("super+c")'); await setImmediate();
  board = { count: 2, items: [[{ type: 'copy', data: 'Y29weQ==' }]] };
  serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }) + '\n'); await setImmediate();
  send(2, 'app.pressKey("super+v")'); await setImmediate(); assert.equal(board.items[0][0].type, 'copy');
  delay = true;
  let completed = false; const closing = relay.close().then(() => { completed = true; });
  await setImmediate(); assert.equal(completed, false); assert.equal(held, true);
  resume(); await closing;
  assert.equal(board.items[0][0].type, 'old'); assert.equal(held, false);
});

test('native mode leaves deliberate Copy available on the user clipboard and explains the result', async () => {
  const h = fixture({ mode: 'native' });
  try {
    h.send(1, 'app.pressKey("super+c")'); await setImmediate();
    assert.equal(h.held(), false); h.copy(); h.reply(1); await setImmediate();
    assert.equal(h.board().items[0][0].type, 'copy');
    assert.doesNotMatch(h.messages[0].params.arguments.code, /installClipboardPermit/);
    assert.match(h.replies[0].result.content.map(c => c.text).join(' '), /native clipboard.*not restored/i);
  } finally { await h.relay.close(); }
});
test('failed snapshot forwards native Copy and reports skipped preservation without a tool error', async () => {
  const h = fixture({ readFailure: 'Clipboard exceeds 64 MiB' });
  try {
    h.send(1, 'app.pressKey("super+c")'); await setImmediate();
    assert.equal(h.messages.length, 1); h.copy(); h.reply(1); await setImmediate();
    assert.equal(h.board().items[0][0].type, 'copy'); assert.equal(h.replies[0].result.isError, false);
    assert.match(h.replies[0].result.content.map(c => c.text).join(' '), /not preserved/);
  } finally { await h.relay.close(); }
});
test('a reset reply racing an active clipboard call does not crash and discards the copy after draining', async () => {
  const h = fixture();
  try {
    h.reset(1); h.send(2, 'app.pressKey("super+c")'); await setImmediate();
    assert.doesNotThrow(() => h.reply(1));
    h.copy(); h.reply(2); await setImmediate(); await setImmediate();
    h.send(3, 'app.pressKey("super+v")'); await setImmediate();
    assert.equal(h.board().items[0][0].type, 'old'); h.reply(3); await setImmediate();
    assert.equal(h.replies.filter(r => r.id === 1).length, 1);
  } finally { await h.relay.close(); }
});

test('a reset completed during snapshot prevents input against the reset JavaScript realm', async () => {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const forwarded = [], replies = []; let resume;
  serverIn.on('data', data => forwarded.push(JSON.parse(data)));
  clientOut.on('data', data => replies.push(JSON.parse(data)));
  const clipboardIO = async request => {
    if (request.op === 'read') { await new Promise(resolve => { resume = resolve; }); return { count: 1, items: [] }; }
  };
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, clipboardIO, clipboardMode: 'preserve' });
  const send = (id, name, code) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { code } } }) + '\n');
  try {
    send(1, 'js_reset'); send(2, 'js', 'app.pressKey("super+c")'); await setImmediate();
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }) + '\n');
    resume(); await setImmediate(); await setImmediate();
    assert.equal(forwarded.length, 1); assert.equal(replies.find(r => r.id === 2).result.isError, true);
  } finally { await relay.close(); }
});
