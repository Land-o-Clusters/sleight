import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
const header = 'Window: "a.txt", App: TextEdit\nURL: file:///tmp/a.txt';
const rpc = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const result = (id, text = header) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }],
  _meta: { 'codex/toolSurface': { app: { appId: 'com.apple.TextEdit' } } } } });
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sleight-relay-lease-'));
  const path = join(directory, 'a.txt');
  writeFileSync(path, 'before\n');
  const relays = [];
  t.after(() => { for (const r of relays) r.close(); rmSync(directory, { recursive: true, force: true }); });
  const harness = (holder, options = {}) => {
    const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
    const forwarded = [], received = [];
    for (const [stream, output] of [[serverIn, forwarded], [clientOut, received]]) {
      stream.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(line => output.push(JSON.parse(line))));
    }
    const inputLease = new InputLease({ directory, holder });
    const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease, ...options });
    relays.push(relay);
    const send = msg => clientIn.write(JSON.stringify(msg) + '\n');
    const reply = msg => serverOut.write(JSON.stringify(msg).replaceAll('file:///tmp/a.txt', pathToFileURL(path).href) + '\n');
    send(rpc('read', 'js', { code: 'let app = await cua.getApp("TextEdit")' })); reply(result('read'));
    forwarded.length = received.length = 0;
    return { send, reply, forwarded, received, relay, inputLease, serverIn, clientOut };
  };
  return { a: harness('A'), b: harness('B'), directory, path, harness };
}
test('lease refusal occurs before forwarding; standalone reads still pass', t => {
  const { a, b } = setup(t);
  a.send(rpc(1, 'js', { code: 'await app.typeText("x")' }));
  b.send(rpc(2, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(a.forwarded.length, 1);
  assert.equal(b.forwarded.length, 0);
  assert.equal(b.relay.snapshotDirectory, undefined, 'a refused contender captures no snapshot');
  assert.match(b.received[0].result.content[0].text, /Input lease.*A.*30 s/);
  b.send(rpc(3, 'js', { code: 'await app.getAXState({ disableDiffing: true })' }));
  assert.equal(b.forwarded.length, 1);
  a.reply(result(1)); b.reply(result(3));
});

test('actions carry both guards and retain the original saved snapshot across turns', t => {
  const { a, path } = setup(t);
  assert.equal(a.relay.snapshotDirectory, undefined, 'discovery remains a read');
  a.send(rpc(1, 'js', { code: 'await app.typeText("first")' }));
  const bank = a.relay.snapshotDirectory;
  assert.ok(existsSync(bank), 'snapshot exists before forwarding');
  const code = a.forwarded[0].params.arguments.code;
  assert.match(code, /record.token !== state.lease.token/);
  assert.match(code, /observed\[key\] !== state.expected\[key\]/);
  writeFileSync(path, 'first\n'); a.reply(result(1));
  a.send(rpc(2, 'turn_ended'));
  assert.ok(existsSync(bank), 'turn end retains review snapshots');
  a.send(rpc(3, 'js', { code: 'await app.typeText("second")' }));
  writeFileSync(path, 'second\n'); a.reply(result(3));
  a.send(rpc(4, 'review_changes', { op: 'list' }));
  assert.match(a.received.at(-1).result.content[0].text, /-before\n\+second/);
  a.relay.close(); assert.equal(existsSync(bank), false);
  assert.equal(a.inputLease.owned.size, 0);
});

test('a failed snapshot prevents the leased action from reaching the engine', t => {
  const { a, path } = setup(t);
  rmSync(path);
  a.send(rpc(1, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(a.forwarded.length, 0);
  assert.match(a.received[0].result.content[0].text, /Change review.*cannot snapshot/);
  a.send(rpc(2, 'turn_ended'));
  assert.equal(a.inputLease.owned.size, 0);
});

test('a screenshot read cannot bypass the next action snapshot conflict check', t => {
  const { a, path } = setup(t);
  a.send(rpc(1, 'js', { code: 'await app.typeText("edit")' }));
  writeFileSync(path, 'edit\n'); a.reply(result(1));
  a.send(rpc(2, 'js', { code: 'await app.getScreenshot()' })); a.reply(result(2, 'image only'));
  writeFileSync(path, 'outside edit\n');
  a.send(rpc(3, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(a.forwarded.length, 2);
  assert.match(a.received.at(-1).result.content[0].text, /Change review.*cannot snapshot/);
  assert.equal(readFileSync(path, 'utf8'), 'outside edit\n');
});

test('review renews its reservation while the user decides and only the user can undo', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const { a, b, path } = setup(t);
  a.send(rpc(1, 'js', { code: 'await app.typeText("edit")' }));
  writeFileSync(path, 'edit\n'); a.reply(result(1));
  a.send(rpc(2, 'turn_ended'));
  a.send(rpc(3, 'review_changes', { op: 'review', decision: 'undo' }));
  assert.equal(a.received.at(-1).result.isError, true);
  assert.equal(readFileSync(path, 'utf8'), 'edit\n');
  a.send(rpc(4, 'review_changes', { op: 'review' }));
  await new Promise(resolve => setImmediate(resolve));
  const prompt = a.received.find(m => m.method === 'elicitation/create');
  assert.deepEqual(prompt.params.requestedSchema.properties.decision.enum, ['keep', 'undo', 'later']);
  for (let i = 0; i < 8; i++) t.mock.timers.tick(5000);
  b.send(rpc(5, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(b.forwarded.length, 0);
  assert.match(b.received.at(-1).result.content[0].text, /Input lease.*A/);
  b.send(rpc(6, 'js', { code: 'await app.getAXState()' })); b.reply(result(6));
  a.send({ jsonrpc: '2.0', id: prompt.id, result: { action: 'accept', content: { decision: 'undo' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readFileSync(path, 'utf8'), 'before\n');
  assert.match(a.received.find(m => m.id === 4).result.content[0].text, /undone/);
  assert.equal(a.inputLease.owned.size, 0, 'review releases its broad reservation after the decision');
  b.send(rpc(7, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(b.forwarded.length, 2); b.reply(result(7));
});

test('review refuses another holder before prompting, while review listing remains a read', async t => {
  const { a, b, path } = setup(t);
  a.send(rpc(1, 'js', { code: 'await app.typeText("edit")' }));
  writeFileSync(path, 'edit\n'); a.reply(result(1)); a.send(rpc(2, 'turn_ended'));
  b.send(rpc(3, 'js', { code: 'await app.typeText("x")' })); b.reply(result(3));
  a.send(rpc(4, 'review_changes', { op: 'list' }));
  assert.match(a.received.at(-1).result.content[0].text, /-before\n\+edit/);
  a.send(rpc(5, 'review_changes', { op: 'review' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(a.received.at(-1).result.content[0].text, /Input lease.*B/);
  assert.equal(a.received.some(m => m.method === 'elicitation/create'), false);
});

test('a user Undo still refuses if review ownership expired before the decision', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { a, b, path } = setup(t);
  a.send(rpc(1, 'js', { code: 'await app.typeText("edit")' }));
  writeFileSync(path, 'edit\n'); a.reply(result(1)); a.send(rpc(2, 'turn_ended'));
  a.send(rpc(3, 'review_changes', { op: 'review' }));
  await new Promise(resolve => setImmediate(resolve));
  const prompt = a.received.find(m => m.method === 'elicitation/create');
  t.mock.timers.tick(31000);
  b.send(rpc(4, 'js', { code: 'await app.typeText("x")' })); b.reply(result(4));
  a.send({ jsonrpc: '2.0', id: prompt.id, result: { action: 'accept', content: { decision: 'undo' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readFileSync(path, 'utf8'), 'edit\n');
  assert.equal(a.received.find(m => m.id === 3).result.isError, true);
  assert.match(a.received.find(m => m.id === 3).result.content[0].text, /Input lease.*expired/);
  assert.doesNotThrow(() => b.inputLease.renew(), 'the expired reviewer cannot remove its successor');
});
test('turn end releases; pending action cannot release early', t => {
  const { a, b, directory } = setup(t);
  a.send(rpc(1, 'js', { code: 'await app.typeText("x")' }));
  a.send(rpc(2, 'turn_ended'));
  assert.ok(a.received[0].result.isError);
  b.send(rpc(3, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(b.forwarded.length, 0);
  a.reply(result(1)); a.send(rpc(4, 'turn_ended'));
  assert.equal(readdirSync(directory).filter(f => f.endsWith('.json')).length, 0);
  b.send(rpc(5, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(b.forwarded.length, 1); b.reply(result(5));
});
test('missing or ambiguous observation refuses actions and reset clears the target', t => {
  const { a } = setup(t);
  a.send(rpc(1, 'js_reset')); a.reply(result(1, 'reset'));
  a.send(rpc(2, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(a.forwarded.length, 1);
  assert.match(a.received.at(-1).result.content[0].text, /read/i);
  a.send(rpc(3, 'js', { code: 'await cua.getState()' })); a.reply(result(3, header + '\nWindow: "b.txt", App: TextEdit'));
  a.send(rpc(4, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(a.forwarded.length, 2);
});
test('active calls renew every 5 s; completed calls stop renewing and close removes leases', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { a } = setup(t);
  a.send(rpc(1, 'js', { code: 'await app.typeText("x")' }));
  for (let i = 0; i < 8; i++) t.mock.timers.tick(5000);
  const values = [...a.inputLease.owned.keys()];
  assert.ok(values.length);
  assert.doesNotThrow(() => a.inputLease.renew());
  a.reply(result(1));
  t.mock.timers.tick(30000);
  assert.throws(() => a.inputLease.renew(), /expired/);
  a.relay.close(); assert.equal(a.inputLease.owned.size, 0);
});

test('shutdown drains the running action before releasing and rejects new work', async t => {
  const { a, b } = setup(t);
  a.send(rpc(1, 'js', { code: 'await app.typeText("x")' }));
  const done = a.relay.shutdown();
  a.send(rpc(2, 'js', { code: 'await app.typeText("x")' }));
  assert.match(a.received[0].result.content[0].text, /closing/);
  b.send(rpc(3, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(b.forwarded.length, 0);
  a.reply(result(1)); await new Promise(resolve => setImmediate(resolve));
  const end = a.forwarded.at(-1); assert.equal(end.params.name, 'turn_ended');
  a.reply(result(end.id, 'ended')); await done;
  b.send(rpc(4, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(b.forwarded.length, 1); b.reply(result(4));
});

test('document grants remain necessary and do not bypass another session lease', async t => {
  const { a, harness } = setup(t);
  const document = harness('document session', { approvalScope: 'document', ask: async () => 'accept' });
  document.send(rpc(1, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(document.forwarded.length, 0);
  assert.equal(document.inputLease.owned.size, 0);
  document.send(rpc(2, 'document_scope')); await new Promise(resolve => setImmediate(resolve));
  a.send(rpc(3, 'js', { code: 'await app.typeText("x")' }));
  document.send(rpc(4, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(document.forwarded.length, 0);
  assert.match(document.received.at(-1).result.content[0].text, /Input lease.*A/);
  a.reply(result(3));
});

test('approved document screenshot reads preserve identity without snapshots or leases', async t => {
  const { harness } = setup(t);
  const h = harness('document screenshot', { approvalScope: 'document', ask: async () => 'accept' });
  h.send(rpc(1, 'document_scope')); await new Promise(resolve => setImmediate(resolve));
  h.send(rpc(2, 'js', { code: 'await app.getScreenshot()' }));
  h.reply({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'image', data: '', mimeType: 'image/png' }] } });
  assert.equal(h.received.find(m => m.id === 2).result.isError, undefined);
  assert.equal(h.relay.snapshotDirectory, undefined);
  assert.equal(h.inputLease.owned.size, 0);
  h.send(rpc(3, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(h.forwarded.length, 2, 'the approved document remains usable'); h.reply(result(3));
});

test('local actions take an app lease; inventory reads stay available', async t => {
  const { harness, b } = setup(t);
  const h = harness('local', { localTools: { tools: [{ name: 'drag' }, { name: 'menu_bar' }],
    call: async () => ({ content: [] }) } });
  h.send(rpc(1, 'drag', { app: 'TextEdit', from: [0, 0], to: [1, 1] }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.received[0].result.isError, undefined);
  assert.equal(h.inputLease.owned.size, 1);
  b.send(rpc(3, 'js', { code: 'await app.typeText("x")' }));
  assert.match(b.received[0].result.content[0].text, /Input lease.*local/);
  h.send(rpc(2, 'menu_bar', { op: 'apps' })); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.received.at(-1).result.isError, undefined);
});

test('a delayed local approval cannot act after expiry and another session takeover', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { harness, b } = setup(t);
  let answer, actions = 0;
  const h = harness('local approval', { ask: () => new Promise(resolve => { answer = resolve; }),
    localTools: { tools: [{ name: 'drag' }], call: async (_name, _args, approve) => {
      if (await approve(['drag', 'TextEdit'], 'Allow drag?')) actions++;
      return { content: [] };
    } } });
  h.send(rpc(1, 'drag', { app: 'TextEdit' }));
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(31000);
  b.send(rpc(2, 'js', { code: 'await app.typeText("x")' })); b.reply(result(2));
  answer('accept'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(actions, 0);
  assert.match(h.received.find(m => m.id === 1).result.content[0].text, /Input lease.*expired/);
  assert.doesNotThrow(() => b.inputLease.renew());
});

test('a delayed local approval is cancelled while the session drains on shutdown', async t => {
  const { harness } = setup(t);
  let answer, actions = 0;
  const h = harness('local shutdown', { ask: () => new Promise(resolve => { answer = resolve; }),
    localTools: { tools: [{ name: 'drag' }], call: async (_name, _args, approve) => {
      if (await approve(['drag', 'TextEdit'], 'Allow drag?')) actions++;
      return { content: [] };
    } } });
  h.send(rpc(1, 'drag', { app: 'TextEdit' }));
  await new Promise(resolve => setImmediate(resolve));
  const done = h.relay.shutdown();
  answer('accept'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(actions, 0);
  assert.match(h.received.find(m => m.id === 1).result.content[0].text, /closing/);
  const end = h.forwarded.at(-1); h.reply(result(end.id, 'ended')); await done;
});

test('transient heartbeat contention retries; repeated contention stops the owned engine', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { harness, directory } = setup(t);
  const faults = [];
  const h = harness('heartbeat', { onLeaseFault: err => faults.push(err) });
  h.send(rpc(1, 'js', { code: 'await app.typeText("x")' }));
  const db = new DatabaseSync(join(directory, '.coordinator.sqlite'));
  db.exec('BEGIN IMMEDIATE'); t.mock.timers.tick(5000);
  db.exec('ROLLBACK'); t.mock.timers.tick(5000);
  assert.equal(faults.length, 0);
  assert.doesNotThrow(() => h.inputLease.renew());
  db.exec('BEGIN IMMEDIATE');
  for (let i = 0; i < 3; i++) t.mock.timers.tick(5000);
  assert.equal(faults.length, 1);
  h.send(rpc(2, 'js', { code: 'await app.typeText("x")' }));
  assert.match(h.received[0].result.content[0].text, /closing/);
  db.exec('ROLLBACK'); db.close(); h.reply(result(1));
});

test('release failure is traced without crashing; persistent renewal errors stop the engine', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { harness, directory } = setup(t);
  const traces = [], faults = [];
  const h = harness('failure', { trace: (direction, msg) => traces.push({ direction, msg }), onLeaseFault: err => faults.push(err) });
  h.send(rpc(1, 'js', { code: 'await app.typeText("x")' }));
  const path = join(directory, [...h.inputLease.owned.keys()][0] + '.json');
  const original = readFileSync(path); writeFileSync(path, '{}');
  t.mock.timers.tick(5000);
  assert.equal(faults.length, 1);
  assert.doesNotThrow(() => h.relay.close());
  assert.ok(traces.some(t => t.direction === 'input-lease-release-error'));
  writeFileSync(path, original);
});

test('read polling during an active call cannot reset the heartbeat deadline', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { a } = setup(t);
  a.send(rpc(1, 'js', { code: 'await app.typeText("x")' }));
  for (let id = 2; id < 42; id++) {
    a.send(rpc(id, 'js', { code: 'await app.getScreenshot()' }));
    a.reply(result(id)); t.mock.timers.tick(1000);
  }
  assert.doesNotThrow(() => a.inputLease.renew()); a.reply(result(1));
});

test('late approval after server input ends is suppressed; stream faults trigger teardown', async t => {
  const { harness } = setup(t);
  let answer;
  const traces = [], faults = [];
  const h = harness('late approval', { ask: () => new Promise(resolve => { answer = resolve; }),
    trace: (direction, msg) => traces.push({ direction, msg }), onLeaseFault: err => faults.push(err) });
  h.reply({ jsonrpc: '2.0', id: 'approval', method: 'elicitation/create', params: { message: 'Allow Computer Use?',
    _meta: { connector_id: 'computer-use', persist: ['session'], tool_params: { app: 'com.apple.TextEdit' } } } });
  await new Promise(resolve => setImmediate(resolve));
  h.serverIn.end(); answer('accept'); await new Promise(resolve => setImmediate(resolve));
  assert.ok(traces.some(t => t.direction === 'server-input-closed'));
  assert.equal(faults.length, 0);
  h.clientOut.emit('error', new Error('EPIPE'));
  assert.equal(faults.length, 1);
});
