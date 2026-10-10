import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

function harness(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clientIn = new PassThrough(), clientOut = new PassThrough();
  const serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], received = [], warnings = [], traces = [];
  serverIn.setEncoding('utf8').on('data', chunk => chunk.trim().split('\n').forEach(line => sent.push(JSON.parse(line))));
  clientOut.setEncoding('utf8').on('data', chunk => chunk.trim().split('\n').forEach(line => received.push(JSON.parse(line))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 'turn-test', changeReview: false, idleTurnEndMs: 30000,
    stderr: { write: message => warnings.push(message) }, trace: (event, data) => traces.push({ event, ...data }) });
  t.after(() => relay.close());
  const call = (id, name = 'js') => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: name === 'js' ? { code: '1 + 1' } : { hook_event_name: 'Interrupt' } } }) + '\n');
  const reply = (id, result = { content: [] }) => serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  const error = id => serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'cleanup temporarily unavailable' } }) + '\n');
  return { relay, sent, received, warnings, traces, call, reply, error, ends: () => sent.filter(message => message.params?.name === 'turn_ended') };
}

for (const explicit of [true, false]) test(`permanent ${explicit ? 'explicit' : 'idle'} cleanup failure stops after three attempts and logs once`, t => {
  const h = harness(t);
  h.call(1); h.reply(1);
  if (explicit) h.call(2, 'turn_ended'); else t.mock.timers.tick(30000);
  const args = h.ends()[0].params.arguments;
  for (let attempt = 0; attempt < 3; attempt++) {
    const end = h.ends()[attempt];
    assert.ok(end, `attempt ${attempt + 1} exists`);
    assert.deepEqual(end.params.arguments, args);
    if (explicit) h.error(end.id); else h.reply(end.id, { isError: true, content: [] });
    t.mock.timers.tick(30000);
  }
  t.mock.timers.tick(300000);
  assert.equal(h.ends().length, 3, 'three includes the initial call');
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /3 attempts/);
  assert.equal(h.traces.filter(row => row.event === 'turn-end-abandoned').length, 1);
  h.call(10); h.reply(10); t.mock.timers.tick(30000);
  assert.equal(h.ends().length, 4, 'a later turn has its own cleanup budget');
  h.reply(h.ends()[3].id);
  t.mock.timers.tick(60000);
  assert.equal(h.ends().length, 4);
  assert.equal(h.warnings.length, 1);
});

test('an engine error from the mod turn end is retried with the original turn identity', t => {
  const h = harness(t);
  h.call(1); h.reply(1); h.call(2, 'turn_ended');
  const firstEnd = h.ends()[0];
  h.error(2);
  t.mock.timers.tick(30000);
  assert.equal(h.ends().length, 2, 'failed cleanup remains owed after the turn rotates');
  const retry = h.ends()[1];
  assert.deepEqual(retry.params.arguments, firstEnd.params.arguments);
  h.reply(retry.id);
  t.mock.timers.tick(60000);
  assert.equal(h.ends().length, 2, 'an acknowledged cleanup is not retried');
  assert.deepEqual(h.received.map(message => message.id), [1, 2], 'retry reply remains internal');
});

test('an idle turn end rejected by the engine is retried instead of forgotten', t => {
  const h = harness(t);
  h.call(1); h.reply(1);
  t.mock.timers.tick(30000);
  const firstEnd = h.ends()[0];
  h.reply(firstEnd.id, { isError: true, content: [{ type: 'text', text: 'cleanup temporarily unavailable' }] });
  t.mock.timers.tick(30000);
  assert.equal(h.ends().length, 2);
  const retry = h.ends()[1];
  assert.deepEqual(retry.params.arguments, firstEnd.params.arguments);
  h.reply(retry.id);
  assert.deepEqual(h.received.map(message => message.id), [1]);
});

test('retrying an older turn waits for newer work and keeps both cleanup identities separate', t => {
  const h = harness(t);
  h.call(1); h.reply(1); h.call(2, 'turn_ended'); h.error(2);
  h.call(3);
  const newerTurn = h.relay.turnId;
  t.mock.timers.tick(60000);
  assert.equal(h.ends().length, 1, 'pending work still holds cleanup');
  h.reply(3);
  t.mock.timers.tick(30000);
  const retry = h.ends()[1];
  assert.equal(retry.params.arguments.turn_id, h.ends()[0].params.arguments.turn_id);
  h.reply(retry.id);
  const newerEnd = h.ends()[2];
  assert.equal(newerEnd.params.arguments.turn_id, newerTurn, 'newer idle work still receives cleanup');
  h.reply(newerEnd.id);
});
