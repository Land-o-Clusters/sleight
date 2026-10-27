import { trackTemp } from '../scripts/temp-leftovers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { remoteApprovalOptions } from '../plugins/sleight/lib/launch.mjs';

const rpc = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const result = (id, title = 'Login', appId = 'com.example.Reader') => ({ jsonrpc: '2.0', id,
  result: { content: [{ type: 'text', text: `Window: "${title}", App: Reader\n0 standard window ${title}` }],
    _meta: { 'codex/toolSurface': { app: { appId } } } } });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
  const outbound = [], received = [], cards = [], dismissed = [], authenticated = new WeakSet();
  for (const [stream, rows] of [[clientOut, received], [serverIn, outbound]]) stream.on('data', bytes => rows.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-native-handoff-')));
  const inputLease = new InputLease({ directory, holder: 'handoff fixture' });
  const ui = { authenticate: event => authenticated.delete(event), dismiss: id => dismissed.push(id), close() {},
    present(id, data, choices, deliver, options) { cards.push({ id, data, choices, deliver, options }); } };
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease, changeReview: false,
    handoffUi: async () => ui, ...options });
  t.after(() => { relay.dispose(); for (const stream of [clientIn, clientOut, serverIn, serverOut]) stream.destroy(); inputLease.close(); rmSync(directory, { recursive: true, force: true }); });
  const send = message => clientIn.write(JSON.stringify(message) + '\n');
  const reply = message => serverOut.write(JSON.stringify(message) + '\n');
  send(rpc('initial', 'js', { code: 'var app = await cua.getApp("com.example.Reader")' }));
  reply(result('initial')); await tick();
  return { relay, send, reply, outbound, received, cards, dismissed, inputLease,
    answer(choice, trusted = true) { const card = cards.at(-1), event = { id: card.id, choice }; if (trusted) authenticated.add(event); card.deliver(event); } };
}

test('native handoff waits without reads, accepts a new window of the same bundle, and returns a fresh engine read', async t => {
  const f = await fixture(t);
  f.send(rpc('handoff', 'app_handoff')); await tick();
  assert.equal(f.cards.length, 1);
  assert.deepEqual(f.cards[0].data, { kind: 'handoff', session: f.cards[0].data.session, turn: f.cards[0].data.turn, app: 'com.example.Reader' });
  assert.equal(f.inputLease.owned.size, 1, 'app reservation is held while the person signs in');
  const before = f.outbound.length;
  f.send(rpc('blocked-read', 'js', { code: 'await app.getAXState()' }));
  f.send(rpc('blocked-input', 'js', { code: 'await app.typeText("secret")' }));
  assert.equal(f.outbound.length, before);
  assert.match(f.received.at(-1).result.content[0].text, /handoff.*pending/i);
  f.answer('continue', false); await tick(); assert.equal(f.outbound.length, before);
  f.answer('continue'); await tick();
  const fresh = f.outbound.at(-1);
  assert.match(fresh.params.arguments.code, /cua.getApp\("com.example.Reader"\)/);
  assert.doesNotMatch(fresh.params.arguments.code, /\.typeText\("secret"\)/);
  f.reply(result(fresh.id, 'Receipt INV-42')); await tick();
  const resumed = f.received.find(row => row.id === 'handoff');
  assert.equal(resumed.result.isError, false, JSON.stringify(resumed));
  assert.match(JSON.stringify(resumed), /Receipt INV-42/);
  assert.equal(f.inputLease.owned.size, 0);
  assert.deepEqual(f.dismissed, [f.cards[0].id]);
});

for (const presence of [{ locked: true, idleSeconds: 0 }, { locked: false, idleSeconds: 120 }])
test(`away native handoff returns before Continue and keeps the card (locked=${presence.locked})`, async t => {
  const f = await fixture(t, { remoteApprovals: { presence: async () => presence } });
  f.send(rpc('handoff', 'app_handoff')); await tick();
  const pending = f.received.find(row => row.id === 'handoff');
  assert.ok(pending, 'away handoff must return without waiting for the person');
  assert.equal(pending.result.isError, false);
  assert.match(JSON.stringify(pending), /app kept for the user/i);
  assert.match(JSON.stringify(pending), /card.*turn ends/i);
  assert.match(JSON.stringify(pending), /end.*turn/i);
  assert.match(JSON.stringify(pending), /reply/i);
  assert.doesNotMatch(JSON.stringify(pending), /click Continue/i);
  assert.equal(f.cards.length, 1);
  assert.equal(f.dismissed.length, 0);
  const before = f.outbound.length;
  f.send(rpc('blocked', 'js', { code: 'await app.getAXState()' }));
  assert.equal(f.outbound.length, before);
  f.answer('continue', false); await tick();
  assert.equal(f.dismissed.length, 0);
  f.answer('continue'); await tick();
  assert.equal(f.outbound.length, before, 'a late Continue must not read without a new call');
  assert.equal(f.received.filter(row => row.id === 'handoff').length, 1);
  assert.equal(f.inputLease.owned.size, 0);
  f.send(rpc('fresh', 'js', { code: 'var fresh = await cua.getApp("com.example.Reader")' }));
  assert.equal(f.outbound.at(-1).id, 'fresh');
});

for (const host of ['missing', 'throws', 'open-throws']) test(`away native handoff with ${host} host reports nothing waiting`, async t => {
  const f = await fixture(t, { remoteApprovals: { presence: async () => ({ locked: true, idleSeconds: 0 }) },
    handoffUi: async () => { if (host === 'open-throws') throw Error('private host detail');
      return host === 'missing' ? undefined : { authenticate: () => true, present() { throw Error('private host detail'); } }; } });
  f.send(rpc('handoff', 'app_handoff')); await tick();
  const text = JSON.stringify(f.received.find(row => row.id === 'handoff'));
  assert.match(text, /not resumed/i);
  assert.match(text, /nothing is waiting/i);
  assert.match(text, /sign-in.*Mac/i);
  assert.doesNotMatch(text, /Continue|card|private host detail/);
  assert.equal(f.inputLease.owned.size, 0);
  f.send(rpc('fresh', 'js', { code: 'var fresh = await cua.getApp("com.example.Reader")' }));
  assert.equal(f.outbound.at(-1).id, 'fresh');
});

test('native handoff refuses id-less tool calls while the card is pending', async t => {
  const f = await fixture(t, { remoteApprovals: { presence: async () => ({ locked: true, idleSeconds: 0 }) } });
  f.send(rpc('handoff', 'app_handoff')); await tick();
  const before = f.outbound.length;
  f.send(rpc(undefined, 'js', { code: 'await cua.getApp("com.example.Reader")' }));
  await tick();
  assert.equal(f.outbound.length, before);
});

test('present native handoff still waits for Continue with a fake presence signal', async t => {
  const f = await fixture(t, { remoteApprovals: { presence: async () => ({ locked: false, idleSeconds: 119 }) } });
  f.send(rpc('handoff', 'app_handoff')); await tick();
  assert.equal(f.cards.length, 1);
  assert.equal(f.received.some(row => row.id === 'handoff'), false);
  f.answer('continue'); await tick();
  const fresh = f.outbound.at(-1);
  assert.match(fresh.params.arguments.code, /cua.getApp/);
  f.reply(result(fresh.id, 'Receipt INV-42')); await tick();
  assert.equal(f.received.find(row => row.id === 'handoff').result.isError, false);
});

for (const [name, read, waiting] of [
  ['locked', async () => ({ locked: true, idleSeconds: 0 }), false],
  ['idle', async () => ({ locked: false, idleSeconds: 120 }), false],
  ['present', async () => ({ locked: false, idleSeconds: 119 }), true],
  ['missing', async () => undefined, true],
  ['failed', async () => { throw Error('metadata unavailable'); }, true],
  ['stalled', () => new Promise(() => {}), true],
]) test(`native handoff with remote approvals off reads ${name} presence`, async t => {
  let reads = 0;
  const options = remoteApprovalOptions({ SLEIGHT_REMOTE_APPROVALS: '0' }, async (script, request) => {
    assert.equal(script, 'remote-approvals.js');
    assert.deepEqual(request, { operation: 'presence' });
    reads++; return read();
  });
  assert.equal(options.remoteApprovals, undefined);
  const f = await fixture(t, options);
  if (name === 'stalled') t.mock.timers.enable({ apis: ['setTimeout'] });
  f.send(rpc('handoff', 'app_handoff')); await tick();
  assert.equal(reads, 1);
  if (name === 'stalled') {
    t.mock.timers.tick(1499); await tick();
    assert.equal(f.cards.length, 0);
    t.mock.timers.tick(1); await tick();
  }
  assert.equal(f.cards.length, 1);
  assert.equal(f.received.some(row => row.id === 'handoff'), !waiting);
  if (!waiting) assert.match(JSON.stringify(f.received.find(row => row.id === 'handoff')), /App kept for the user/);
  assert.equal(f.outbound.filter(row => row.params?.name === 'js').length, 1, 'handoff never reads sign-in content');
  f.answer('cancel'); await tick();
  assert.equal(f.received.filter(row => row.id === 'handoff').length, 1);
  assert.equal(f.inputLease.owned.size, 0);
});

for (const mode of ['cancel', 'expiry', 'turn-end', 'engine-end', 'host-cancel'])
test(`away native ${mode} cancels the retained card without replying twice`, async t => {
  const f = await fixture(t, { handoffTimeoutMs: mode === 'expiry' ? 20 : 1000,
    remoteApprovals: { presence: async () => ({ locked: true, idleSeconds: 0 }) } });
  f.send(rpc('handoff', 'app_handoff')); await tick();
  assert.equal(f.received.filter(row => row.id === 'handoff').length, 1);
  if (mode === 'cancel') f.answer('cancel');
  if (mode === 'turn-end') f.send(rpc('end', 'turn_ended'));
  if (mode === 'engine-end') f.relay.engineEnded('Fixture engine exited.');
  if (mode === 'host-cancel') f.send({ method: 'notifications/cancelled', params: { requestId: 'handoff' } });
  await new Promise(resolve => setTimeout(resolve, mode === 'expiry' ? 35 : 10));
  f.answer('continue'); await tick();
  assert.equal(f.outbound.filter(row => row.params?.name === 'js').length, 1);
  assert.equal(f.inputLease.owned.size, 0);
  assert.equal(f.received.filter(row => row.id === 'handoff').length, 1);
  assert.equal(f.dismissed.length, 1);
});

test('cancelling native handoff during its presence read never presents a late card', async t => {
  let finishPresence;
  const f = await fixture(t, { remoteApprovals: { presence: () => new Promise(resolve => { finishPresence = resolve; }) } });
  f.send(rpc('handoff', 'app_handoff')); await tick();
  f.send({ method: 'notifications/cancelled', params: { requestId: 'handoff' } });
  finishPresence({ locked: true, idleSeconds: 0 }); await tick();
  assert.equal(f.cards.length, 0);
  assert.equal(f.inputLease.owned.size, 0);
  assert.equal(f.received.filter(row => row.id === 'handoff').length, 1);
});

for (const mode of ['cancel', 'expiry', 'turn-end', 'normal-turn-end', 'engine-end', 'host-cancel']) test(`native ${mode} grants no acquisition`, async t => {
  const f = await fixture(t, { handoffTimeoutMs: mode === 'expiry' ? 20 : 1000 });
  f.send(rpc('handoff', 'app_handoff')); await tick();
  assert.equal(f.cards.length, 1);
  const before = f.outbound.length;
  if (mode === 'cancel') f.answer('cancel');
  if (mode === 'turn-end') f.send(rpc('end', 'turn_ended', { hook_event_name: 'Interrupt' }));
  if (mode === 'normal-turn-end') f.send(rpc('end', 'turn_ended'));
  if (mode === 'engine-end') f.relay.engineEnded('Fixture engine exited.');
  if (mode === 'host-cancel') f.send({ method: 'notifications/cancelled', params: { requestId: 'handoff' } });
  await new Promise(resolve => setTimeout(resolve, mode === 'expiry' ? 35 : 10));
  assert.equal(f.outbound.filter(row => row.params?.name === 'js').length, 1, 'no fresh engine read');
  assert.equal(f.inputLease.owned.size, 0);
  assert.match(JSON.stringify(f.received.find(row => row.id === 'handoff')), mode === 'engine-end' ? /Fixture engine exited/ : /not resumed/i);
  assert.equal(f.received.filter(row => row.id === 'handoff').length, 1);
  f.answer('continue'); await tick();
  assert.equal(f.outbound.filter(row => row.params?.name === 'js').length, 1);
  assert.ok(f.outbound.length >= before);
});

for (const mode of ['host-cancel', 'engine-end']) test(`native ${mode} during acquisition settles once and suppresses the late result`, async t => {
  const f = await fixture(t);
  f.send(rpc('handoff', 'app_handoff')); await tick(); f.answer('continue'); await tick();
  const fresh = f.outbound.at(-1);
  if (mode === 'host-cancel') f.send({ method: 'notifications/cancelled', params: { requestId: 'handoff' } });
  else f.relay.engineEnded('Fixture engine exited.');
  await tick();
  const before = f.received.length;
  assert.equal(f.received.filter(row => row.id === 'handoff').length, 1);
  f.reply(result(fresh.id, 'Late private result')); await tick();
  assert.equal(f.received.length, before);
  assert.equal(f.inputLease.owned.size, 0);
  assert.doesNotMatch(JSON.stringify(f.received), /Late private result/);
});

test('native handoff cannot start while another session holds the app', async t => {
  const f = await fixture(t);
  const other = new InputLease({ directory: f.inputLease.directory, holder: 'other fixture' });
  t.after(() => other.close());
  other.acquire({ appId: 'com.example.Reader', title: 'Login', app: 'Reader' }, 'app');
  f.send(rpc('handoff', 'app_handoff')); await tick();
  assert.equal(f.cards.length, 0);
  assert.match(JSON.stringify(f.received.find(row => row.id === 'handoff')), /held by other fixture/);
});

test('native handoff rejects tool-supplied authority and secrets', async t => {
  const f = await fixture(t);
  for (const args of [{ app: 'com.other.App' }, { password: 'secret' }, { signedIn: true }, { continue: true }]) {
    f.send(rpc('bad', 'app_handoff', args)); await tick();
    assert.equal(f.received.at(-1).result.isError, true);
  }
  assert.equal(f.cards.length, 0);
});

test('native handoff keeps app lease exclusion and normal engine approvals after Continue', async t => {
  const f = await fixture(t);
  const other = new InputLease({ directory: f.inputLease.directory, holder: 'other fixture' });
  t.after(() => other.close());
  f.send(rpc('handoff', 'app_handoff')); await tick();
  assert.throws(() => other.acquire({ appId: 'com.example.Reader', title: 'New window', app: 'Reader' }), /held by/);
  f.answer('continue'); await tick();
  const fresh = f.outbound.at(-1);
  f.reply({ jsonrpc: '2.0', id: 'approve-new', method: 'elicitation/create', params: { message: 'Allow Computer Use to use "com.example.Reader"?',
    requestedSchema: { type: 'object', properties: {} }, _meta: { connector_id: 'computer-use', persist: ['session'], tool_params: { app: 'com.example.Reader' }, riskLevel: 'low' } } });
  await tick();
  assert.ok(f.received.some(row => row.id === 'approve-new' && row.method === 'elicitation/create'));
  assert.equal(f.received.some(row => row.id === 'handoff'), false);
  f.send({ id: 'approve-new', result: { action: 'cancel' } });
  f.reply({ id: fresh.id, result: { isError: true, content: [{ type: 'text', text: 'User declined.' }] } }); await tick();
  assert.equal(f.received.find(row => row.id === 'handoff').result.isError, true);
});

test('native handoff withholds an acquisition whose bundle differs from the confirmed app', async t => {
  const f = await fixture(t);
  f.send(rpc('handoff', 'app_handoff')); await tick(); f.answer('continue'); await tick();
  f.reply(result(f.outbound.at(-1).id, 'Private other app', 'com.other.App')); await tick();
  const resumed = f.received.find(row => row.id === 'handoff');
  assert.equal(resumed.result.isError, true);
  assert.doesNotMatch(JSON.stringify(resumed), /Private other app/);
});
