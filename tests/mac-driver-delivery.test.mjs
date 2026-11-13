import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMacDeliveryTransport } from '../plugins/sleight/lib/mac-driver/delivery.mjs';
import { createMacDeliveryTransport as createBefore } from './fixtures/mac-driver-delivery-before.mjs';

function fixture(t, transform) {
  const output = new EventEmitter(), events = [], callbacks = [];
  const result = { content: [{ type: 'text', text: 'parent tree' }] };
  output.write = (bytes, callback) => { events.push(JSON.parse(bytes)); callbacks.push(callback); return true; };
  const bridge = createMacDeliveryTransport({ output, transform,
    session: { displayResult: () => result, recordDelivery: (...args) => events.push(args) },
  });
  t.after(() => bridge.close());
  return { bridge, result, events, callbacks, output };
}

test('delivery preserves exact parent identity after the destination and relay callbacks', t => {
  const f = fixture(t), displayed = f.bridge.nativeSession.displayResult(1, {});
  f.bridge.clientOut.write(JSON.stringify({ id: 1, result: displayed }), () => f.events.push('relay callback'));
  assert.equal(f.events.length, 1, 'serialized bytes alone grant nothing');
  f.callbacks[0]();
  assert.equal(f.events[1], 'relay callback'); assert.strictEqual(f.events[2][0], f.result);
  assert.equal(f.events[2][1], undefined);
  f.callbacks[0](); assert.equal(f.events.length, 3, 'a repeated completion cannot grant twice');
});

test('shell envelope removal still waits for the final destination callback', t => {
  const f = fixture(t, message => { delete message.privateEnvelope; return message; });
  const result = f.bridge.nativeSession.displayResult('shell', {});
  f.bridge.clientOut.write(JSON.stringify({ id: 'shell', privateEnvelope: true, result }));
  assert.equal(f.events.length, 1); assert.equal(f.events[0].privateEnvelope, undefined);
  const error = Error('destination failed'); f.callbacks[0](error);
  assert.strictEqual(f.events[1][0], result); assert.strictEqual(f.events[1][1], error);
});

test('changed output and a closed transport cannot grant a staged delivery', t => {
  for (const change of ['before serialization', 'transform', 'close']) {
    const f = fixture(t, change === 'transform' ? message => ({ ...message, result: { content: [] } }) : undefined);
    const result = f.bridge.nativeSession.displayResult(1, {});
    f.bridge.clientOut.write(JSON.stringify({ id: 1, result: change === 'before serialization' ? { content: [] } : result }));
    if (change === 'close') f.bridge.close();
    f.callbacks[0](); assert.equal(f.events.length, 1, change);
  }
});

test('synchronous output failure reaches the relay and invalidates exact staged delivery once', t => {
  const f = fixture(t), error = Error('write threw');
  f.output.write = () => { throw error; };
  const result = f.bridge.nativeSession.displayResult(1, {});
  assert.equal(f.bridge.clientOut.write(JSON.stringify({ id: 1, result }), value => f.events.push(value)), false);
  assert.strictEqual(f.events[0], error); assert.strictEqual(f.events[1][0], result); assert.strictEqual(f.events[1][1], error);
});

test('delivery snapshots nested evidence before serialization and checks in-place transforms', t => {
  for (const change of ['staged object', 'transform']) {
    const f = fixture(t, change === 'transform' ? message => {
      message.result.content[0].text = 'changed'; return message;
    } : undefined);
    const result = f.bridge.nativeSession.displayResult(1, {});
    if (change === 'staged object') result.content[0].text = 'changed';
    f.bridge.clientOut.write(JSON.stringify({ id: 1, result }));
    f.callbacks[0](); assert.equal(f.events.length, 1, change);
  }
});

test('optional JSON fields do not prevent an unchanged reply from being delivered', t => {
  const f = fixture(t);
  f.result.isError = undefined;
  f.result._meta = { optional: undefined, values: [undefined, null, Number.NaN, -0] };
  const result = f.bridge.nativeSession.displayResult(1, {});
  f.bridge.clientOut.write(JSON.stringify({ id: 1, result }));
  f.callbacks[0](); assert.strictEqual(f.events[1][0], result);
});

test('a screenshot reply is parsed and stringified once by the delivery transport', t => {
  const output = new EventEmitter(), records = [];
  const result = { content: [{ type: 'image', data: 'a'.repeat(2_000_000), mimeType: 'image/png' }] };
  output.write = (_bytes, callback) => { callback(); return true; };
  const bridge = createMacDeliveryTransport({ output,
    session: { displayResult: () => result, recordDelivery: (...args) => records.push(args) } });
  t.after(() => bridge.close());
  const parse = JSON.parse, stringify = JSON.stringify;
  const parsed = t.mock.method(JSON, 'parse', parse), serialized = t.mock.method(JSON, 'stringify', stringify);
  const displayed = bridge.nativeSession.displayResult(1, {});
  // The relay's serialization is outside the delivery transport's budget.
  const wire = stringify({ id: 1, result: displayed });
  bridge.clientOut.write(wire);
  assert.equal(parsed.mock.callCount(), 1);
  assert.equal(serialized.mock.callCount(), 1);
  assert.strictEqual(records[0][0], result);
});

test('delivery cost per fake 2 MB screenshot reply', t => {
  const screenshot = Buffer.alloc(2_000_000, 0x61).toString('base64');
  const result = { content: [{ type: 'text', text: 'parent tree' },
    { type: 'image', data: screenshot, mimeType: 'image/png' }] };
  const wire = JSON.stringify({ id: 1, result }) + '\n';
  const rows = [createBefore, createMacDeliveryTransport].map(create => {
    const output = new EventEmitter(), row = { delivered: 0, bytes: 0, elapsed: 0 };
    output.write = (bytes, callback) => { row.bytes += Buffer.byteLength(bytes); callback(); return true; };
    const bridge = create({ output, session: {
      displayResult: () => result, recordDelivery: () => { row.delivered++; } } });
    t.after(() => bridge.close());
    row.reply = () => { bridge.nativeSession.displayResult(1, {}); bridge.clientOut.write(wire); };
    return row;
  });
  for (let i = 0; i < 5; i++) for (const row of rows) row.reply();
  const count = 40;
  for (let i = 0; i < count; i++) for (const row of i % 2 ? [...rows].reverse() : rows) {
    const start = performance.now(); row.reply(); row.elapsed += performance.now() - start;
  }
  for (const row of rows) {
    assert.equal(row.delivered, count + 5); assert.equal(row.bytes, Buffer.byteLength(wire) * (count + 5));
  }
  t.diagnostic(`${count} measured replies per arm after 5 warmups, alternating order; 2000000 raw bytes, ${screenshot.length} base64 characters; before ${(rows[0].elapsed / count).toFixed(3)} ms/reply, after ${(rows[1].elapsed / count).toFixed(3)} ms/reply`);
});
