import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { receiptOptions } from '../plugins/sleight/lib/launch.mjs';

function harness(t, options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [], receipts = [];
  serverIn.on('data', data => data.toString().trim().split('\n').forEach(line => sent.push(JSON.parse(line))));
  clientOut.on('data', data => data.toString().trim().split('\n').forEach(line => received.push(JSON.parse(line))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, receipts: true, stateReview: true,
    receiptWriter: receipt => { receipts.push(receipt); return '/private/tmp/receipt.json'; }, ...options });
  t.after(() => relay.dispose());
  return { relay, sent, received, receipts, serverIn,
    call: (id, code, title) => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code, title } } }) + '\n'),
    reply: (id, text) => serverOut.write(JSON.stringify({ id, result: { content: [{ type: 'text', text }] } }) + '\n'),
    end: id => clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'turn_ended', arguments: {} } }) + '\n'),
  };
}
const tree = value => `Window: "Untitled", App: TextEdit.\n0 window\n1 text area, Value: ${value}\n2 menu item Undo Typing`;
function edit(h) {
  h.call(1, 'let app = await cua.getApp("TextEdit")'); h.reply(1, tree('before'));
  h.call(2, 'await app.typeText("secret content")'); h.reply(2, tree('secret content'));
}

test('turn cleanup writes one receipt without adding a call or parsing during a call', t => {
  const h = harness(t); edit(h);
  assert.equal(h.receipts.length, 0);
  assert.equal(h.sent.length, 2);
  h.end(3); h.reply(3, 'ended');
  assert.equal(h.sent.length, 3);
  assert.equal(h.receipts.length, 1);
  assert.doesNotMatch(JSON.stringify(h.receipts[0]), /secret content/);
  const result = h.received.at(-1).result;
  assert.equal(result._meta['sleight/receipt'].path, '/private/tmp/receipt.json');
  assert.match(result._meta['sleight/receipt'].review, /changed/);
});

test('receipts and unsaved review can both be disabled', t => {
  const h = harness(t, { receipts: false, stateReview: false }); edit(h); h.end(3); h.reply(3, 'ended');
  assert.equal(h.receipts.length, 0);
  assert.equal(h.received.at(-1).result._meta?.['sleight/receipt'], undefined);
});

test('review is opt-in separately from receipt output', t => {
  const h = harness(t, { stateReview: false }); edit(h); h.end(3); h.reply(3, 'ended');
  assert.equal(h.receipts.length, 1);
  assert.equal(h.receipts[0].review, undefined);
  assert.equal(h.received.at(-1).result._meta['sleight/receipt'].review, undefined);
});

test('receipt write failure is reported without breaking turn cleanup or leaking its message', t => {
  const h = harness(t, { receiptWriter: () => { throw new Error('secret content'); } }); edit(h); h.end(3); h.reply(3, 'ended');
  assert.equal(h.sent.at(-1).params.name, 'turn_ended');
  assert.match(JSON.stringify(h.received.at(-1)), /receipt.*unavailable/i);
  assert.doesNotMatch(JSON.stringify(h.received.at(-1)), /secret content/);
});

test('idle and disconnect cleanup publish the open turn once', async t => {
  const h = harness(t); edit(h);
  const done = h.relay.endOpenTurn();
  const ended = h.sent.at(-1);
  assert.equal(ended.params.name, 'turn_ended');
  h.reply(ended.id, 'ended'); await done;
  await h.relay.shutdown();
  assert.equal(h.receipts.length, 1);
});

test('mod cleanup after idle cleanup receives the latest receipt without rewriting it', async t => {
  const h = harness(t); edit(h);
  const idle = h.relay.endOpenTurn();
  h.reply(h.sent.at(-1).id, 'idle ended'); await idle;
  h.end(3); h.reply(3, 'mod ended');
  assert.equal(h.receipts.length, 1);
  assert.equal(h.received.at(-1).result._meta?.['sleight/receipt']?.path, '/private/tmp/receipt.json');
  assert.match(h.received.at(-1).result._meta['sleight/receipt'].review, /changed/);
});

test('an interrupt with a pending call records uncertainty and disposal does not lose it', t => {
  const h = harness(t); h.call(1, 'await app.typeText("secret content")');
  h.relay.dispose();
  assert.equal(h.receipts.length, 1);
  assert.equal(h.receipts[0].calls[0].result, 'pending; outcome unknown');
  assert.doesNotMatch(JSON.stringify(h.receipts[0]), /secret content/);
});

test('launcher receipts require exactly SLEIGHT_RECEIPTS=1 and titles default to hidden', () => {
  for (const value of [undefined, '0', '', 'true', '1']) {
    const options = receiptOptions({ SLEIGHT_RECEIPTS: value });
    assert.equal(options.receipts, value === '1');
    assert.equal(options.redactReceiptTitles, true);
  }
});

test('explicit cleanup reaches the engine before receipt work, including a synchronous reply', t => {
  let h;
  h = harness(t, { receiptWriter: receipt => {
    assert.equal(h.sent.at(-1).params.name, 'turn_ended');
    h.receipts.push(receipt); return '/private/tmp/receipt.json';
  } });
  edit(h);
  h.serverIn.on('data', data => {
    const msg = JSON.parse(data);
    if (msg.params?.name === 'turn_ended') h.reply(msg.id, 'ended immediately');
  });
  const turn = h.relay.turnId;
  h.end(3);
  assert.equal(h.receipts[0].turn, turn);
  assert.equal(h.received.at(-1).result._meta['sleight/receipt'].path, '/private/tmp/receipt.json');
});

test('idle cleanup reaches the engine before receipt work', async t => {
  let h;
  h = harness(t, { receiptWriter: receipt => {
    assert.equal(h.sent.at(-1).params.name, 'turn_ended');
    h.receipts.push(receipt); return '/private/tmp/receipt.json';
  } });
  edit(h);
  const done = h.relay.endOpenTurn(); h.reply(h.sent.at(-1).id, 'ended'); await done;
  assert.equal(h.receipts.length, 1);
});

test('receipt stderr contains counts and no path, title, review or owner data', t => {
  let log = '';
  const h = harness(t, { redactReceiptTitles: false, stderr: { write: text => { log += text; } } });
  h.call(1, 'let app = await cua.getApp("TextEdit")'); h.reply(1, tree('before').replace('Untitled', 'Private full name'));
  h.call(2, 'await app.click(1)'); h.reply(2, tree('after').replace('Untitled', 'Private full name'));
  h.end(3); h.reply(3, 'ended');
  assert.doesNotMatch(log, /Private|full name|\/private\/tmp|Leave|Undo/);
  assert.match(log, /2 calls.*1 windows/);
});

test('field review reaches the pane transport without receipt files or added engine calls', t => {
  const h = harness(t, { receipts: false }); edit(h); h.end(3); h.reply(3, 'ended');
  assert.equal(h.receipts.length, 0);
  assert.equal(h.sent.length, 3);
  const result = h.received.at(-1).result;
  assert.match(result._meta['sleight/receipt'].review, /text area 1, value: \[redacted 6 chars\] -> \[redacted 14 chars\]/);
  const fallback = result.content.find(c => c.text?.startsWith('sleight-receipt: '));
  assert.match(JSON.parse(fallback.text.slice('sleight-receipt: '.length)).review, /redacted 14 chars/);
  assert.doesNotMatch(JSON.stringify(result), /secret content/);
});
