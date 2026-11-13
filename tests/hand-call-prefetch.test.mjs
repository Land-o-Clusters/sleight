import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHandClient } from '../plugins/sleight/lib/hand/client.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';

test('call prefetch never starts a host and writes each admission only to a running host', async t => {
  const child = new EventEmitter(), lines = [], traces = []; let starts = 0;
  child.pid = 424242; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stdio = [child.stdin, child.stdout];
  child.stdin.on('data', bytes => lines.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  child.kill = () => { child.emit('exit', 0); child.emit('close', 0); };
  const client = createHandClient({ setting: () => ({ enabled: true, style: 'ring' }), watch: () => undefined,
    permissions: null, usage: null, built: () => true, trace: (direction, msg) => traces.push({ direction, msg }),
    prepare: async () => ({ status: 'ready', spawn: () => { starts++; return child; } }) });
  t.after(() => client.close());
  client.primeCall(); assert.equal(starts, 0); assert.equal(lines.length, 0);
  client.activity();
  for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1);
  assert.deepEqual(traces.find(t => t.direction === 'hand-start-request')?.msg, { source: 'activity' });
  for (let i = 0; i < 20; i++) client.primeCall();
  assert.equal(lines.filter(l => l.hand === 'call').length, 20, 'the menu activity throttle must not suppress call prefetch');
  assert.ok(lines.filter(l => l.hand === 'call').every(l => Object.keys(l).sort().join() === 'hand,nonce'));
  const costs = traces.filter(t => t.direction === 'hand-call-prefetch').map(t => t.msg.addedMs);
  assert.equal(costs.length, 21); assert.ok(costs.every(ms => ms < 5));
  t.diagnostic(JSON.stringify({ calls: 21, addedMaxMs: Math.max(...costs), starts }));
});

test('relay primes a local call before the target promise without awaiting host work', async t => {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const events = []; let resolveTarget;
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false,
    pauseHost: { primeCall: () => events.push('prime'), activity() {} },
    localTools: { tools: [{ name: 'open_file', inputSchema: { type: 'object' } }], target: () => { events.push('target'); return new Promise(resolve => { resolveTarget = resolve; }); },
      call: async () => ({ content: [] }) } });
  t.after(() => { resolveTarget?.({ app: 'Fixture', appId: 'org.fixture.Editor', pid: 42 }); relay.dispose(); });
  clientIn.write(JSON.stringify({ id: 9, method: 'tools/call', params: { name: 'open_file', arguments: { app: 'Fixture' } } }) + '\n');
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.slice(0, 2), ['prime', 'target']);
});
