import { windowsWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { runWindows, windowsCommand, windowsReplayServer } from '../plugins/sleight/lib/windows-launch.mjs';
import { windowsReplFixture } from './fixtures/windows-repl-client.mjs';
import { WINDOWS_REPL_DOCS } from '../plugins/sleight/lib/windows-repl/docs.mjs';

const text = result => result?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
async function fixture(t, options = {}) {
  const worker = windowsReplFixture(t, options);
  const input = new PassThrough(), output = new PassThrough(), pending = new Map();
  let next = 0, deliver;
  const runtime = await runWindows({ input, output, signals: new EventEmitter(), repl: worker.repl,
    setting: () => ({ enabled: false, stream: false }), discovery: { browsers: async () => [] }, paths: { cache: 'C:\\Fixture\\sleight' } });
  output.on('data', bytes => {
    for (const line of bytes.toString().trim().split('\n')) {
      const message = JSON.parse(line);
      if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
      deliver?.(message);
    }
  });
  t.after(() => runtime.close());
  const send = message => input.write(JSON.stringify(message) + '\n');
  const request = (method, params) => new Promise(resolve => { const id = ++next; pending.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
  const call = async (code, extra) => (await request('tools/call', { name: 'js', arguments: { code, ...extra } })).result;
  return { ...worker, runtime, input, output, request, call, server: {
    send, onMessage: handler => { deliver = handler; }, onClose() {}, close: () => runtime.close(),
  } };
}

test('Windows launcher uses the relay first-call path, persistent handles, docs and js_reset', { skip: windowsWorkerSkip }, async t => {
  const { request, call, requests } = await fixture(t);
  const initialized = await request('initialize', { clientInfo: { name: 'sleight-test', version: '1' } });
  assert.equal(initialized.result.serverInfo.name, 'sleight');
  const tools = (await request('tools/list')).result.tools;
  assert.ok(tools.find(tool => tool.name === 'js')); assert.ok(tools.find(tool => tool.name === 'js_reset'));
  assert.equal(tools.some(tool => tool.name === 'app_handoff'), false);
  const first = await call('const app = await cua.getApp("Notepad");');
  assert.equal(first.isError, false, text(first)); assert.match(text(first), /## Computer Use/);
  assert.ok(text(first).includes(WINDOWS_REPL_DOCS));
  assert.match(text(first), /# Driving Windows apps with sleight/);
  assert.doesNotMatch(text(first), /# Driving Mac apps|super\+shift\+g|Multiply tap coordinates|app_handoff/);
  assert.ok(first.content.every(item => item.type !== 'text' || item.text.trim().length > 0));
  assert.match(text(first), /Window: "Untitled - Notepad", App: Notepad\./);
  const second = await call('await app.getAXState();');
  assert.equal(second.isError, false, text(second)); assert.doesNotMatch(text(second), /## Computer Use/);
  assert.doesNotMatch(text(second), /# Driving Windows apps/);
  assert.ok(requests.some(row => row.method === 'getAXState'));
  await request('tools/call', { name: 'js_reset', arguments: {} });
  const reset = await call('let app = await cua.getApp("Calculator");');
  assert.equal(reset.isError, false, text(reset)); assert.match(text(reset), /## Computer Use/); assert.match(text(reset), /App: Calculator\./);
  assert.doesNotMatch(text(reset), /# Driving Windows apps/, 'skill is delivered once per relay session');
});

test('Windows inventory reaches the model without the Mac no-windows notice', { skip: windowsWorkerSkip }, async t => {
  const { call } = await fixture(t);
  const result = await call('await cua.getState();');
  assert.equal(result.isError, false, text(result));
  assert.doesNotMatch(text(result), /there is no listWindows|lists no windows/);
  assert.match(text(result), /"windows"/);
});

test('sleight-mcp Windows replay dispatch runs 4 fixture steps through the relay and fake driver', { skip: windowsWorkerSkip }, async t => {
  const { server, requests, workers, children } = await fixture(t);
  const lines = [];
  const code = await windowsCommand(['replay', fileURLToPath(new URL('./fixtures/windows-repl-replay.json', import.meta.url)), '--wait-ms', '0'],
    { replayServer: server, error: line => lines.push(line) });
  assert.equal(code, 0, lines.join('\n'));
  assert.equal(lines.filter(line => /^step \d\/4 js.*: ok/.test(line)).length, 4);
  assert.deepEqual(requests.filter(row => row.method === 'getApp').map(row => row.params.selector), ['Notepad', 'Calculator']);
  assert.equal(workers.length, 1); assert.equal(children.length, 1);
  assert.notEqual(workers[0].exitCode ?? workers[0].signalCode, null);
  assert.notEqual(children[0].exitCode ?? children[0].signalCode, null);
});

test('launcher timeout is an error result and the next cell receives fresh API docs', { skip: windowsWorkerSkip }, async t => {
  const { call } = await fixture(t);
  await call('let stale = 1;');
  const result = await call('await new Promise(() => {});', { timeout_ms: 300 });
  assert.equal(result.isError, true); assert.match(text(result), /REPL_TIMEOUT/);
  const next = await call('nodeRepl.write("binding: " + typeof stale);');
  assert.match(text(next), /## Computer Use/); assert.match(text(next), /undefined/);
});

test('production launcher admission blocks fake-driver reads unless explicitly injected', { skip: windowsWorkerSkip }, async t => {
  const { call, requests, children } = await fixture(t, { admit: undefined });
  const result = await call('let app = await cua.getApp("Notepad");');
  assert.equal(result.isError, true); assert.match(text(result), /WINDOWS_SAFETY_UNAVAILABLE/);
  assert.equal(requests.length, 0); assert.equal(children.length, 0);
});

test('Windows replay process uses absolute Node and launcher paths and collects EOF', async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let vector;
  child.stdin.once('finish', () => child.emit('close', 0));
  const server = windowsReplayServer({ spawnChild: (...args) => { vector = args; return child; } });
  const received = [];
  server.onMessage(message => received.push(message));
  child.stdout.write('{"id":1,"result":{}}\n');
  server.send({ id: 2, method: 'ping' });
  await server.close();
  assert.equal(vector[0], process.execPath); assert.match(vector[1][0], /lib[/\\]launch\.mjs$/);
  assert.equal(vector[2].windowsHide, true); assert.deepEqual(received, [{ id: 1, result: {} }]);
});
