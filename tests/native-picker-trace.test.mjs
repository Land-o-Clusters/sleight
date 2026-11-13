import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { listPicker } from '../plugins/sleight/lib/native-list-pick.mjs';
import { stripPickerTrace, documentationCounts } from '../plugins/sleight/lib/native-picker-trace.mjs';
import { guardedCode } from '../plugins/sleight/lib/document-scope.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { fixtureWindow, replay, virtualList } from './fixtures/native-picker-replay.mjs';

test('NF2 fake-clock picker phases contain only fixed codes and numeric work counts', async () => {
  const events = [];
  const { model, result } = await replay(listPicker, { delayedFrame: true, focusRecovery: true }, { trace: event => events.push(event) });
  assert.equal(result.clicked, true);
  const phases = events.map(event => event.phase);
  for (const phase of ['start', 'focus-wait', 'focus-repeat', 'frame-retry', 'frame-wait', 'end']) assert.ok(phases.includes(phase), phase);
  assert.equal(events.at(-1).outcome, 'selected');
  assert.equal(events.at(-1).ms, model.time);
  assert.equal(events.at(-1).at, model.time);
  assert.equal(events.at(-1).reads, model.reads);
  assert.ok(events.length <= 16);
  assert.ok(!JSON.stringify(events).includes(model.target));
  for (const event of events) assert.deepEqual(Object.keys(event).sort(), ['at', 'keys', 'ms', 'outcome', 'phase', 'reads', 'ticks']);
});

test('NF2 diagnostic failures do not alter picker input or results', async () => {
  const plain = await replay(listPicker, {});
  const failing = await replay(listPicker, {}, { trace() { throw new Error('trace disk full'); } });
  assert.deepEqual(failing.result, plain.result);
  assert.deepEqual(failing.model.chosen, plain.model.chosen);
  assert.equal(failing.error, undefined);
});

test('NF2 strips malformed diagnostics and caps accepted records without leaking extra fields', () => {
  const mark = '[sleight:picker-phase]';
  const metric = { search: 1, phase: 'end', outcome: 'selected', at: 121, ms: 21, reads: 8, keys: 4, ticks: 0 };
  const records = [];
  const content = [{ type: 'text', text: 'before' + mark + JSON.stringify({ ...metric, label: 'PRIVATE DOCUMENT' }) + '\nafter' },
    { type: 'text', text: mark + '{bad\n' + mark + JSON.stringify({ ...metric, phase: 'PRIVATE DOCUMENT' }) + '\n' +
      mark + JSON.stringify({ ...metric, ms: -1 }) + '\n' }, { type: 'image', data: 'unchanged' }];
  assert.deepEqual(stripPickerTrace(content, event => records.push(event)),
    [{ type: 'text', text: 'beforeafter' }, { type: 'image', data: 'unchanged' }]);
  assert.deepEqual(records, [metric]);
  const repeated = [{ type: 'text', text: (mark + JSON.stringify(metric) + '\n').repeat(300) }];
  const capped = [];
  assert.deepEqual(stripPickerTrace(repeated, event => capped.push(event)), []);
  assert.equal(capped.length, 256);
});

test('NF2 serialized picker emits phases only with timing enabled and keeps the result clean', async () => {
  for (const timing of [false, true]) {
    const model = virtualList({ delayedFrame: true });
    const output = [];
    const raw = { getAXState: model.tree, pressKey: model.press,
      scroll: async (_number, direction, ticks) => model.scroll('list Catalog', direction, ticks),
      click: async number => model.click(`text (selectable) ${model.rendered[number - 10]}`) };
    class Clock extends Date { static now() { return model.time; } }
    const code = guardedCode(`const picked = await app.pickFromList(${JSON.stringify(model.target)});`, fixtureWindow, undefined, undefined, { timing }) + '\nreturn picked;';
    const result = await runInNewContext(`(async () => { ${code} })()`, { app: raw, cua: { getApp: async () => raw },
      Date: Clock, setTimeout: (done, ms) => { model.time += ms; done(); }, nodeRepl: { write: text => output.push(text) } });
    assert.equal(result.clicked, true);
    const events = [];
    const cleaned = stripPickerTrace([{ type: 'text', text: output.join('') }], event => events.push(event));
    assert.equal(events.length > 0, timing);
    assert.ok(cleaned.every(block => !block.text?.includes('[sleight:picker-phase]')));
    if (timing) assert.equal(events.at(-1).outcome, 'selected');
  }
});

function harness(t, { clientOut = new PassThrough(), ...options } = {}) {
  const clientIn = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const traces = [], replies = [], sent = [];
  serverIn.on('data', data => sent.push(JSON.parse(data)));
  if (clientOut instanceof PassThrough) clientOut.on('data', data => replies.push(JSON.parse(data)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: false, guardTiming: true,
    trace: (direction, msg) => traces.push({ direction, msg, at: options.clock?.() }), ...options });
  t.after(() => relay.dispose());
  return { relay, traces, replies, sent, call: (id, code = 'await app.getAXState();') => clientIn.write(JSON.stringify({ id,
    method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n'),
    reply: (id, result) => serverOut.write(JSON.stringify({ id, result }) + '\n'),
    rpcError: (id, error) => serverOut.write(JSON.stringify({ id, error }) + '\n') };
}
const metric = (search, phase) => '[sleight:picker-phase]' + JSON.stringify({ search, phase,
  outcome: phase === 'end' ? 'selected' : 'pending', at: 102, ms: 2, reads: 3, keys: 1, ticks: 0 }) + '\n';

test('NF2 overlapping tool IDs keep picker phases and documentation delivery separate', async t => {
  let time = 100;
  const h = harness(t, { clock: () => time });
  h.call('first'); h.call('second');
  assert.deepEqual(h.sent.map(row => row.id), ['first', 'second']);
  time = 120;
  h.reply('second', { content: [{ type: 'text', text: metric(1, 'end') + 'done' }] });
  time = 150;
  h.reply('first', { isError: true, content: [{ type: 'text', text: metric(2, 'frame-retry') +
    '## Computer Use\nPRIVATE REFERENCE\n# Computer Use Confirmations Policy\nPrivate policy.' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.traces.filter(event => event.direction === 'native-picker').map(event => [event.msg.id, event.msg.phase]),
    [['second', 'end'], ['first', 'frame-retry']]);
  for (const event of h.traces.filter(event => event.direction === 'native-picker')) {
    const started = h.traces.find(row => row.direction === 'call-received' && row.msg.id === event.msg.id).at;
    const finished = h.traces.find(row => row.direction === 'to-client' && row.msg.id === event.msg.id).at;
    assert.ok(event.msg.at >= started && event.msg.at <= finished,
      JSON.stringify({ id: event.msg.id, at: event.msg.at, started, finished }));
  }
  const deliveries = h.traces.filter(event => event.direction === 'native-doc-delivery');
  assert.deepEqual(deliveries.map(event => [event.msg.id, event.msg.outcome]), [['second', 'written'], ['first', 'refused']]);
  assert.equal(deliveries[1].msg.blocks, 1);
  assert.ok(!JSON.stringify(deliveries).includes('PRIVATE'));
  assert.ok(h.replies.every(reply => !JSON.stringify(reply).includes('[sleight:picker-phase]')));
  assert.equal(h.replies[1].result.isError, true);
});

test('NF2 a failed client write reports failure without claiming documentation delivery', async t => {
  const clientOut = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('write refused')); } });
  const h = harness(t, { clientOut });
  h.call(9);
  h.reply(9, { content: [{ type: 'text', text: '## Computer Use\nPRIVATE REFERENCE' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.traces.find(event => event.direction === 'native-doc-delivery')?.msg.outcome, 'write-failed');
});

test('NF2 documentation diagnostics handle empty replies and retain no reference text', () => {
  for (const content of [undefined, null, [], [null, { type: 'image', data: 'PRIVATE' }]]) {
    assert.deepEqual(documentationCounts(content), { blocks: 0, chars: 0 });
  }
  assert.deepEqual(documentationCounts([{ type: 'text', text: '## Computer Use\nPRIVATE' }]), { blocks: 1, chars: 23 });
});

test('NF2 strips phases from RPC errors before forwarding the original refusal', async t => {
  const h = harness(t);
  h.call(12);
  h.rpcError(12, { code: -10005, message: metric(1, 'end') + 'frame refused' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.traces.some(event => event.direction === 'native-picker' && event.msg.id === 12));
  assert.match(JSON.stringify(h.replies), /frame refused/);
  assert.doesNotMatch(JSON.stringify(h.replies), /sleight:picker-phase/);
});
