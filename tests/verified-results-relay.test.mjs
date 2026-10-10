import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';

function harness(t, options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [];
  serverIn.on('data', data => data.toString().trim().split('\n').forEach(line => sent.push(JSON.parse(line))));
  clientOut.on('data', data => data.toString().trim().split('\n').forEach(line => received.push(JSON.parse(line))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 'verified-unit', inputLease: false, changeReview: false, ...options });
  t.after(() => relay.dispose());
  return { sent, received,
    call: (id, code, name = 'js') => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { code } } }) + '\n'),
    reply: (id, text, isError = false) => serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } }) + '\n'),
  };
}
const tree = value => `Window: "Calculator", App: Calculator.\n0 standard window Calculator\n\t1 text field Value: ${value}\n\t2 button Description: 1, ID: One`;
const tick = () => new Promise(resolve => setImmediate(resolve));
const note = (h, id) => h.received.find(msg => msg.id === id).result.content.at(-1).text;

test('the relay adds independent results without an extra engine call or changing action code', async t => {
  const h = harness(t);
  h.call(1, 'let app = await cua.getApp("Calculator")'); h.reply(1, tree(0)); await tick();
  h.call(2, 'await app.click(2)');
  h.reply(2, GUARD_MARK + tree(1) + GUARD_END); await tick();
  assert.match(note(h, 2), /^sleight: UI changed \(value\)\.$/);
  assert.equal(h.sent.filter(msg => msg.method === 'tools/call').length, 2);
  assert.equal(h.sent.at(-1).params.arguments.code, 'await app.click(2)');
  assert.doesNotMatch(note(h, 1), /^sleight: (?:UI|saved:|call failed)/);
});

test('a rewritten last-window close error never becomes confirmed input', async t => {
  const h = harness(t);
  h.call(1, 'let app = await cua.getApp("Calculator")'); h.reply(1, tree(0)); await tick();
  h.call(2, 'await app.pressKey("super+w")'); h.reply(2, 'noWindowsAvailable', true); await tick();
  assert.equal(h.received.find(msg => msg.id === 2).result.isError, false, 'existing close recovery stays intact');
  assert.match(note(h, 2), /call failed \(partial input possible\)/);
});

// vr-live and waits-live, 2026-10-10: the engine's docs on a session's first call made every first
// action say "no earlier read".
test("the engine's docs on the first call keep that call's read as the baseline", async t => {
  const h = harness(t);
  h.call(1, 'let app = await cua.getApp("Calculator")'); h.reply(1, '## Computer Use\n\nControl native apps.\n' + tree(0)); await tick();
  h.call(2, 'await app.click(2)');
  h.reply(2, GUARD_MARK + tree(1) + GUARD_END); await tick();
  assert.match(note(h, 2), /^sleight: UI changed \(value\)\.$/);
});

test('overlapping calls cannot attribute a changed value to either action', async t => {
  const h = harness(t);
  h.call(1, 'let app = await cua.getApp("Calculator")'); h.reply(1, tree(0)); await tick();
  h.call(2, 'await app.click(2)'); h.call(3, 'await app.pressKey("1")');
  h.reply(3, GUARD_MARK + tree(1) + GUARD_END); h.reply(2, GUARD_MARK + tree(11) + GUARD_END); await tick();
  for (const id of [2, 3]) assert.match(note(h, id), /UI unverified \(overlapping calls\)/);
});

test('reset discards the previous read and pending observations', async t => {
  const h = harness(t);
  h.call(1, 'let app = await cua.getApp("Calculator")'); h.reply(1, tree(0)); await tick();
  h.call(2, '', 'js_reset'); h.reply(2, 'reset'); await tick();
  h.call(3, 'await app.click(2)'); h.reply(3, GUARD_MARK + tree(1) + GUARD_END); await tick();
  assert.match(note(h, 3), /UI unverified \(no earlier read\)/);
});

for (const restart of ['js_reset', 'engine restart']) test(`${restart} retains the pre-reset line check for click(14)`, async t => {
  const h = harness(t, { changeReview: true });
  const before = tree(0) + '\n\t14 menu bar item Format';
  h.call(1, 'let app = await cua.getApp("Calculator")');
  h.reply(1, '## Computer Use\n' + before); await tick();
  h.call(2, restart === 'js_reset' ? '' : 'await cua.listApps()', restart === 'js_reset' ? 'js_reset' : 'js');
  h.reply(2, restart === 'js_reset' ? 'reset' : '## Computer Use\n'); await tick();
  h.call(3, 'await app.click(14)'); await tick();
  const code = h.sent.find(msg => msg.id === 3).params.arguments.code;
  assert.match(code, /"seenLines":\{"14":"menu bar item Format"\}/);
});

test('a successful reply that reports a caught action failure stays unverified', async t => {
  const h = harness(t);
  h.call(1, 'let app = await cua.getApp("Calculator")'); h.reply(1, tree(0)); await tick();
  h.call(2, 'await app.click(2)');
  h.reply(2, 'sleight: an action in this call failed, and the call went on without it: click.\n' + GUARD_MARK + tree(1) + GUARD_END); await tick();
  assert.match(note(h, 2), /call failed \(partial input possible\)/);
});
