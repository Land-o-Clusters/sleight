import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { narrationLine, assistantNarration } from '../plugins/sleight/hooks/narration.mjs';
import { readHandConfig, handSetting } from '../plugins/sleight/lib/hand/settings.mjs';
import { writeHandSetting } from '../plugins/sleight/lib/hand/command.mjs';
import { handWireFrame } from '../plugins/sleight/lib/hand/client.mjs';
import { createCursorEvents, createRendererSink } from '../plugins/sleight/lib/hand/events.mjs';
import { createRelayHand } from '../plugins/sleight/lib/hand/relay-hand.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { createNarrationSink } from '../plugins/sleight/lib/hand/narration-sink.mjs';
import { PassThrough } from 'node:stream';

// Authored assistant-message fixtures, not transcripts from the owner's sessions.
const fixtures = [
  ['I’ll check the menu before choosing an export format. Then I’ll save it.', 'I’ll check the menu before choosing an export format.'],
  ['**Let me check the available options.**\n\n```js\nawait app.click({id: 12})\n```', 'Let me check the available options.'],
  ['I can open [the page](https://example.test/private) to compare the options.', 'I can open the page to compare the options.'],
  ['```js\nsecret()\n```\nI’ll inspect the dialog first.', 'I’ll inspect the dialog first.'],
];
test('assistant prose becomes its first sentence with markup and code removed', () => {
  for (const [input, expected] of fixtures) assert.equal(narrationLine(input), expected);
  assert.ok([...narrationLine('A'.repeat(150))].length <= 90);
  assert.ok([...narrationLine('🐈'.repeat(150))].length <= 90);
});
test('privacy removes URLs, paths, quoted values, email and control characters before truncation', () => {
  const homeToken = ['', 'Users', 'alice', 'private.txt'].join('/');
  const line = narrationLine('Open https://example.test/secret PATHALICE ~/Downloads/a.csv ./x ../z C:\\Users\\a and www.test.com then "hunter2" and `secret` for a@b.test.'.replace('PATHALICE', homeToken));
  assert.equal(line, 'Open and then and for');
  assert.equal(narrationLine('Look\u202e here\nnext\u0000.'), 'Look here next.');
  for (const input of ['file:///secret', 'report.csv', 'plugins/sleight/a.mjs', 'https://private', '"only a value"', '```unterminated']) assert.equal(narrationLine(input), undefined);
  assert.equal(narrationLine('I will enter hunter2 now.', { code: 'await app.typeText("hunter2")' }), undefined);
  assert.equal(narrationLine('I will enter hunter2 now.', { fields: [{ value: 'hunter2' }] }), undefined);
  for (const code of ['await app.typeText /* note */ (String(123456))', 'await app["type"+"Text"](String(123456))',
    'await app[method](value)', 'await send(value)', 'await Reflect.apply(send, app, [value])']) {
    assert.equal(narrationLine('I will enter 123456.', { code }), undefined, code);
  }
  assert.equal(narrationLine('I’ll inspect the menu.', { code: 'await app.click /* note */ ({ id: 3 })' }), 'I’ll inspect the menu.');
});
test('source binds to the current tool and reads only preceding assistant text, never a result or thinking', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'text', text: 'Old narration.' }] },
    { role: 'user', content: [{ type: 'tool_result', content: 'PRIVATE RESULT' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE REASONING' }, { type: 'text', text: 'I’ll inspect the menu first.' },
      { type: 'tool_use', id: 'call-1', name: 'sleight', input: {} }, { type: 'text', text: 'Future narration.' }] },
  ];
  assert.equal(assistantNarration(messages, 'call-1'), 'I’ll inspect the menu first.');
  assert.equal(assistantNarration(messages, 'missing'), undefined);
  messages[2].content.splice(1, 1);
  assert.equal(assistantNarration(messages, 'call-1'), undefined);
  assert.equal(assistantNarration({ deny: 'no' }, 'call-1'), undefined);
  assert.equal(assistantNarration([
    { role: 'assistant', content: [{ type: 'text', text: 'I’ll inspect the menu.' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'split' }] },
  ], 'split'), 'I’ll inspect the menu.');
});
test('native narration requires a resolved acquisition and loses it after unknown persistent JS aliases', () => {
  const acquire = { type: 'tool_use', id: 'acquire', name: 'mcp__plugin_sleight_computer__js', input: { code: 'let app = await cua.getApp("Editor")' } };
  const current = { role: 'assistant', content: [{ type: 'text', text: 'I will inspect the menu.' }, { type: 'tool_use', id: 'current' }] };
  assert.equal(assistantNarration([current], 'current', { code: 'await app.click(3)' }), undefined);
  assert.equal(assistantNarration([{ role: 'assistant', content: [acquire] }, current], 'current', { code: 'await app.click(3)' }), 'I will inspect the menu.');
  const alias = { role: 'assistant', content: [{ type: 'tool_use', id: 'alias', name: 'js', input: { code: 'entry = { click: app.typeText.bind(app) }' } }] };
  assert.equal(assistantNarration([{ role: 'assistant', content: [acquire] }, alias, current], 'current', { code: 'await entry.click(secret)' }), undefined);
  assert.equal(assistantNarration([{ role: 'assistant', content: [acquire] }, alias, current], 'current', { code: 'await app.click(3)' }), undefined);
});
test('narration settings default off and survive ordinary hand writes under the same safe-file rules', t => {
  const dir = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'c2-config-'))));
  const path = join(dir, 'hand.json');
  assert.equal(handSetting({ platform: 'darwin', env: {}, path }).narration, 'off');
  for (const narration of ['off', 'bubbles', 'voice']) {
    writeFileSync(path, JSON.stringify({ version: 1, enabled: true, style: 'ring', narration, voice: { id: 'com.apple.voice.test', rate: 0.5 } }), { mode: 0o600 });
    assert.equal(readHandConfig(path).narration, narration);
    writeHandSetting({ capture: 'hidden' }, { path });
    assert.equal(readHandConfig(path).narration, narration);
    assert.deepEqual(readHandConfig(path).voice, { id: 'com.apple.voice.test', rate: 0.5 });
  }
  for (const extra of [{ narration: 'yes' }, { voice: { id: '../voice', rate: 0.5 } }, { voice: { id: 'v', rate: 2 } }, { voice: { id: 'v', rate: 0.5, url: 'no' } }]) {
    writeFileSync(path, JSON.stringify({ version: 1, enabled: true, ...extra }));
    assert.equal(readHandConfig(path).state, 'unsafe');
  }
});
test('say is opt-in on cursor action and status records and absent on session records', () => {
  for (const narration of ['off', 'bubbles', 'voice']) {
    const rows = [];
    const events = createCursorEvents({ setting: () => ({ stream: true, narration }), onEvent: row => rows.push(row), sink: { write() {}, close() {} } });
    const call = events.call();
    events.action({ call, index: 0, phase: 'aim', kind: 'click', source: 'native', say: 'I’ll inspect the menu. https://secret.test/x' });
    events.status('thinking', { call, say: 'I’ll inspect the menu.' });
    events.close();
    for (const row of rows.filter(r => r.type !== 'session' && r.state !== 'idle')) assert.equal(row.say, narration === 'off' ? undefined : 'I’ll inspect the menu.');
    for (const row of rows.filter(r => r.type === 'session')) assert.equal(row.say, undefined);
  }
});
test('host aim, act and status wire frames carry only a sanitized say', () => {
  for (const hand of ['aim', 'act', 'status']) {
    const frame = handWireFrame({ hand, kind: 'click', state: 'thinking', pid: 42, windowId: 7, at: [10, 10], say: 'I’ll inspect /private/secret the menu.' });
    assert.equal(frame.say, 'I’ll inspect the menu.');
  }
});
test('public say requires a trusted secure-input check and retains event order while the check is pending', () => {
  for (const allowed of [true, false, undefined]) {
    const sent = [], checks = [];
    const events = createCursorEvents({ setting: () => ({ enabled: true, style: 'ring', stream: true, narration: 'bubbles' }),
      sink: { write: e => sent.push(e), close() {} } });
    events.connectHost({ enabled: true, cursor() {}, checkNarration: done => checks.push(done) });
    const call = events.call();
    events.action({ call, index: 0, kind: 'click', phase: 'aim', source: 'native', say: 'I’ll inspect the menu.' });
    events.status('thinking');
    assert.equal(sent.some(e => e.type === 'action'), false);
    checks.shift()(allowed);
    assert.equal(sent.find(e => e.type === 'action').say, allowed === true ? 'I’ll inspect the menu.' : undefined);
    assert.deepEqual(sent.map(e => e.seq), [...sent.map(e => e.seq)].sort((a, b) => a - b));
    events.close();
  }
});
test('public narration timeout, overflow and close remove say and ignore late host answers', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent = [], checks = [], canceled = [];
  const sink = createNarrationSink({ write: e => sent.push(e), limit: 2, waitMs: 100,
    check: done => { checks.push(done); return () => canceled.push(true); } });
  sink.write({ seq: 1, say: 'First.' }); t.mock.timers.tick(100);
  assert.deepEqual(sent, [{ seq: 1 }]); checks[0](true); assert.equal(sent.length, 1);
  sink.write({ seq: 2, say: 'Second.' }); sink.write({ seq: 3 }); sink.write({ seq: 4, say: 'Fourth.' });
  assert.deepEqual(sent, [{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
  sink.close(); checks.at(-1)(true);
  assert.deepEqual(sent, [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }]); assert.equal(canceled.length, 3);
});
test('a newly connected renderer never replays a sentence approved before secure input could change', async t => {
  const dir = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'c2-replay-')))); chmodSync(dir, 0o700);
  const sink = createRendererSink({ dir });
  sink.write({ type: 'session', state: 'start', seq: 1 });
  sink.write({ type: 'status', state: 'thinking', seq: 2, say: 'PRIVATE OLD SENTENCE' });
  await settle();
  const received = [], peers = [];
  const server = net.createServer(peer => { peers.push(peer); peer.on('data', data => received.push(data.toString())); });
  await new Promise(resolve => server.listen(join(dir, 'renderer.sock'), resolve)); chmodSync(join(dir, 'renderer.sock'), 0o600);
  t.after(() => { sink.close(); peers.forEach(p => p.destroy()); server.close(); });
  sink.refresh();
  const deadline = Date.now() + 1000;
  while (!received.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(received.length); assert.ok(!received.join('').includes('PRIVATE OLD SENTENCE'));
});
const settle = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve)); };
test('native aim, act and waiting records retain the admitted call line independently of a later call', async t => {
  const records = [], frames = [];
  const setting = () => ({ enabled: true, style: 'ring', narration: 'bubbles', stream: true });
  const events = createCursorEvents({ setting, sink: { write() {}, close() {} }, onEvent: e => records.push(e) });
  const hand = createRelayHand({ events, setting, client: { enabled: true, send: f => frames.push(f), hide() {} },
    locate: async () => ({ ok: true, window: { pid: 42, windowId: 7, bounds: { X: 0, Y: 0, Width: 500, Height: 400 } },
      displays: [{ X: 0, Y: 0, Width: 1000, Height: 1000 }], windows: [{ id: 7, pid: 42, bounds: { X: 0, Y: 0, Width: 500, Height: 400 } }] }) });
  t.after(() => { hand.close(); events.close(); });
  hand.admit(1, { code: 'await app.click([20,20])', screenshotSize: [500, 400], say: 'First menu.' }); await settle();
  hand.approval(100, { tool_name: 'click' });
  hand.admit(2, { code: 'await app.click([30,30])', screenshotSize: [500, 400], say: 'Second menu.' }); await settle();
  assert.ok(records.some(r => r.phase === 'aim' && r.say === 'First menu.'));
  assert.ok(records.some(r => r.phase === 'act' && r.say === 'First menu.'));
  assert.equal(records.find(r => r.state === 'waiting').say, 'First menu.');
  assert.equal(frames[0].say, 'First menu.'); assert.equal(frames.at(-1).say, 'Second menu.');
});
test('relay strips the private argument before engine and logs and binds result status to the correct call', async t => {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const sent = [], statuses = [], logs = [];
  serverIn.on('data', bytes => sent.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  clientOut.resume();
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 'fixture', changeReview: false, 
    cursor: { close() {}, narration: 'bubbles', status: (state, detail) => statuses.push({ state, ...detail }) }, actionLog: { request: m => logs.push(JSON.stringify(m)) } });
  t.after(() => relay.close());
  for (const [id, say] of [[1, 'First menu.'], [2, 'Second menu.']]) {
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code: '1+1', sleight_stats: { internal: true, say } } } }) + '\n');
    await settle();
    serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'PRIVATE TOOL RESULT' }] } }) + '\n');
    await settle();
  }
  assert.equal(sent.length, 2);
  assert.ok(!JSON.stringify(sent).includes('sleight_say')); assert.ok(!logs.join('').includes('menu.'));
  assert.deepEqual(statuses.filter(s => s.state === 'done').map(s => s.say), ['First menu.', 'Second menu.']);
});
