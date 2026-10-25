import { trackTemp } from '../scripts/temp-leftovers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';

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
