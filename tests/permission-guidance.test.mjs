import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteTabError } from '../plugins/sleight/lib/tab-errors.mjs';
import { callLocalTool } from '../plugins/sleight/lib/launch.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { PassThrough } from 'node:stream';

test('a browser security denial retains its evidence and offers only a read-only inventory', () => {
  const raw = 'Browser Use rejected this action due to browser security policy.';
  const out = rewriteTabError(raw);
  assert.ok(out.startsWith(raw));
  assert.match(out, /Permission or security policy refused/);
  assert.match(out, /await cua.listBrowsers\(\)/);
  assert.match(out, /user.*decide/);
  assert.doesNotMatch(out, /\.goto\(|\.close\(|\.click\(|\.accept\(|preapproved/);
});

test('ungranted tool permission is not described as an unsupported operation', () => {
  const raw = "Claude requested permissions to use a tool, but you haven't granted it yet.";
  const out = rewriteTabError(raw);
  assert.ok(out.startsWith(raw));
  assert.match(out, /Tool permission has not been granted/);
  assert.match(out, /user.*decide/);
  assert.doesNotMatch(out, /unsupported|\.getApp\(|\.accept\(/);
});

for (const name of ['drag', 'hover']) test(`declined ${name} stops before any helper and names the human choice`, async () => {
  let approvals = 0, helpers = 0;
  const result = await callLocalTool(name, {app: 'Example'}, async () => { approvals++; return false; },
    () => { helpers++; assert.fail('a denied helper must not run'); });
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /The user didn't allow/);
  assert.match(text, /don't work around it/);
  assert.doesNotMatch(text, /Permission declined/);
  assert.equal(approvals, 1);
  assert.equal(helpers, 0);
});

test('unsupported operations and caller prose are not rewritten as permission denials', () => {
  for (const raw of ['Capability viewport is not available.', 'TypeError: tab.madeUp is not a function',
    'A page says: Browser Use rejected this action due to browser security policy.',
    'caller output\nBrowser Use rejected this action due to browser security policy.\nTypeError: unrelated']) {
    assert.equal(rewriteTabError(raw), raw);
  }
});

test('a browser refusal is returned once without a retry, inventory call or permission mutation', t => {
  const streams = Array.from({length: 4}, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams, sent = [], replies = [];
  serverIn.on('data', data => sent.push(JSON.parse(data.toString())));
  clientOut.on('data', data => replies.push(JSON.parse(data.toString())));
  const relay = createRelay({clientIn, clientOut, serverIn, serverOut, changeReview: false});
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); });
  clientIn.write(JSON.stringify({id: 1, method: 'tools/call', params: {name: 'js', arguments: {code: 'await tab.click(1)'}}}) + '\n');
  const text = 'Browser Use rejected this action due to browser security policy.';
  serverOut.write(JSON.stringify({id: 1, result: {isError: true, content: [{type: 'text', text}]}}) + '\n');
  assert.equal(sent.length, 1);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].result.isError, true);
  assert.ok(replies[0].result.content[0].text.startsWith(text));
  assert.match(replies[0].result.content[0].text, /Permission or security policy refused/);
});
