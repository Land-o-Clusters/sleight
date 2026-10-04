import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

test('launcher bounds a hung call on EOF, collects its engine, then removes its lease', { timeout: 16000 }, async t => {
  const bank = await mkdtemp(join(tmpdir(), 'sleight-launcher-test-'));
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
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: codexHome, SLEIGHT_TEST_DOCUMENT: document, SLEIGHT_TRACE: traces } });
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
});
