import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeGuardFixture } from '../bench/guard-reads-cleanup.mjs';

const reply = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });
const fixture = reply('Window: "guard-1.txt", App: TextEdit.\nURL: file:///private/tmp/sleight-guard-reads-test/guard-1.txt');
const other = reply('Window: "other.txt", App: TextEdit.\nURL: file:///private/tmp/other.txt');
const path = '/private/tmp/sleight-guard-reads-test/guard-1.txt';
function client(responses) {
  const calls = [];
  return { calls, call: async code => { calls.push(code); return responses.shift(); } };
}
test('cleanup never closes a different document or treats a refused close as success', async () => {
  const switched = client([other]);
  await assert.rejects(closeGuardFixture(switched.call, path), /owned document/);
  assert.equal(switched.calls.length, 1);
  const refused = client([fixture, reply('Input lease stopped: window changed', true), other]);
  await assert.rejects(closeGuardFixture(refused.call, path), /unconfirmed/);
  assert.equal(refused.calls.filter(code => code.includes('super+w')).length, 1);
});
test('cleanup accepts no windows after a capture error without repeating the close', async () => {
  const c = client([fixture, reply('screen capture size is invalid', true), reply('noWindowsAvailable', true)]);
  assert.equal((await closeGuardFixture(c.call, path)).cleanup, 'no TextEdit windows remain');
  assert.equal(c.calls.filter(code => code.includes('super+w')).length, 1);
});
test('cleanup accepts the relay no-windows receipt only after closing the exact fixture', async () => {
  const closed = reply('sleight: the app has no windows left, so the window this call closed was its last. Nothing more to read.');
  const c = client([fixture, closed]);
  assert.equal((await closeGuardFixture(c.call, path)).cleanup, 'no TextEdit windows remain');
  assert.equal(c.calls.length, 2);
  const refused = client([fixture, { ...closed, isError: true }, other]);
  await assert.rejects(closeGuardFixture(refused.call, path), /unconfirmed/);
});
