import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

test('launcher bounds a hung call on EOF, collects its engine, then removes its lease', { timeout: 16000 }, async t => {
  const bank = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-launcher-test-')));
  t.after(() => rm(bank, { recursive: true, force: true }));
  const codexHome = join(bank, 'codex');
  const config = join(codexHome, 'plugins/cache/openai-bundled/unified-computer-use/1.0');
  await mkdir(config, { recursive: true });
  const fixture = fileURLToPath(new URL('fixtures/lease-engine.mjs', import.meta.url));
  await writeFile(join(config, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: { command: process.execPath, args: [fixture] } } }));
  const leases = join(bank, 'leases');
  const document = join(bank, 'a.txt');
  await writeFile(document, 'before\n');
  const traces = join(bank, 'traces');
  const child = spawn(process.execPath, [fileURLToPath(new URL('fixtures/lease-launcher.mjs', import.meta.url)), leases],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: codexHome, SLEIGHT_TEST_DOCUMENT: document, SLEIGHT_TRACE: traces, SLEIGHT_CHANGE_REVIEW: '1' } });
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  let stderr = ''; child.stderr.on('data', d => stderr += d);
  const received = new Map(), waiting = new Map();
  createInterface({ input: child.stdout }).on('line', line => {
    const msg = JSON.parse(line); received.set(msg.id, msg);
    if (waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  });
  const send = (id, name, code) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { code } } }) + '\n');
  send(1, 'js', 'let app = await cua.getApp("TextEdit")');
  await new Promise(resolve => received.has(1) ? resolve(received.get(1)) : waiting.set(1, resolve));
  send(2, 'js', 'await app.typeText("hang")');
  for (let n = 0; n < 100; n++) {
    try { if ((await readdir(leases)).some(f => f.endsWith('.json'))) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await readdir(leases)).filter(f => f.endsWith('.json')).length, 1);
  const started = Date.now(); child.stdin.end();
  const exit = await closed;
  assert.equal(exit.signal, null, stderr); assert.equal(exit.code, 0, stderr);
  assert.ok(Date.now() - started < 12000, 'shutdown deadline exceeded');
  assert.equal((await readdir(leases)).filter(f => f.endsWith('.json')).length, 0);
  const events = (await readFile(join(traces, `trace-${child.pid}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
  const snapshot = events.find(e => e.direction === 'snapshot-before-call');
  assert.ok(snapshot, 'hung action captured a saved file before forwarding');
  await assert.rejects(stat(snapshot.msg.directory), { code: 'ENOENT' });
  // The shutdown stamps for the harness tail, in order.
  const order = ['stop-entry', 'relay-shutdown', 'engine-closed', 'process-exit'].map(name => events.findIndex(e => e.direction === name));
  assert.ok(order.every(i => i >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});
test('launcher stays connected across stop and lazily initializes a new engine with remembered approval', { timeout: 20000 }, async t => {
  const bank = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-restart-test-')));
  const codexHome = join(bank, 'codex'), config = join(codexHome, 'plugins/cache/openai-bundled/unified-computer-use/1.0');
  await mkdir(config, { recursive: true });
  await writeFile(join(config, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: {
    command: process.execPath, args: [fileURLToPath(new URL('fixtures/restart-engine.mjs', import.meta.url))],
  } } }));
  const log = join(bank, 'engines.jsonl');
  const child = spawn(process.execPath, [fileURLToPath(new URL('fixtures/restart-launcher.mjs', import.meta.url)), join(bank, 'leases')],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: codexHome, SLEIGHT_TEST_ENGINE_LOG: log,
      SLEIGHT_SURFACES: 'computer', SLEIGHT_CHANGE_REVIEW: '0', SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_REMOTE_APPROVALS: '0' } });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(async () => { child.stdin.end(); await closed; await rm(bank, { recursive: true, force: true }); });
  let approvals = 0, stderr = '';
  child.stderr.on('data', data => stderr += data);
  const replies = new Map(), waiters = new Map();
  const send = msg => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  createInterface({ input: child.stdout }).on('line', line => {
    const msg = JSON.parse(line);
    if (msg.method === 'elicitation/create') { approvals++; send({ id: msg.id, result: { action: 'accept', content: {} } }); return; }
    replies.set(msg.id, msg); waiters.get(msg.id)?.(msg); waiters.delete(msg.id);
  });
  const receive = id => Promise.race([replies.has(id) ? Promise.resolve(replies.get(id)) : new Promise(resolve => waiters.set(id, resolve)),
    closed.then(() => { throw new Error('launcher disconnected: ' + stderr); })]);
  const call = async (id, name, args) => { send({ id, method: 'tools/call', params: { name, arguments: args } }); return receive(id); };
  send({ id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'test', version: '1' } } });
  await receive(0); send({ method: 'notifications/initialized' });
  assert.ok(!(await call(1, 'js', { code: 'let app = await cua.getApp("TextEdit")' })).result.isError);
  const stop = await call(2, 'turn_ended', { sleight_stop: true });
  assert.match(stop.result._meta['sleight/stop'].engine, /collected/);
  const events = async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal((await events()).filter(e => e.event === 'start').length, 1);
  assert.equal((await call(3, 'js', { code: 'await app.typeText("x")' })).result.isError, true);
  await call(4, 'turn_ended', { sleight_resume: true });
  assert.equal((await events()).filter(e => e.event === 'start').length, 1);
  const read = await call(5, 'js', { code: 'let app = await cua.getApp("TextEdit")' });
  assert.ok(!read.result.isError, JSON.stringify(read));
  assert.equal(approvals, 1);
  const started = (await events()).filter(e => e.event === 'start');
  assert.equal(started.length, 2); assert.notEqual(started[0].pid, started[1].pid);
  assert.equal((await events()).filter(e => e.event === 'initialize').length, 2);
  assert.equal((await events()).filter(e => e.event === 'accept').length, 2);
  assert.equal((await events()).filter(e => e.event === 'warm').length, 1, 'startup setup does not acquire an app');
  assert.ok((await events()).some(e => e.event === 'probe' && e.helper === 2), 'new engine uses the new health helper');
  assert.equal([...replies.keys()].some(id => /^sleight-(?:initialize|warm)-/.test(String(id))), false, 'internal initialization and setup stay internal');
});
