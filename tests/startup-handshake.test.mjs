import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

test('a piped handshake followed immediately by EOF collects the launcher and engine', { timeout: 15000 }, async t => {
  const bank = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-handshake-eof-')));
  const codexHome = join(bank, 'codex');
  const config = join(codexHome, 'plugins/cache/openai-bundled/unified-computer-use/1.0');
  await mkdir(config, { recursive: true });
  const fixture = fileURLToPath(new URL('fixtures/handshake-engine.mjs', import.meta.url));
  await writeFile(join(config, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: {
    command: process.execPath, args: [fixture],
  } } }));
  const traces = join(bank, 'traces');
  const launcher = fileURLToPath(new URL('../plugins/sleight/bin/sleight-mcp', import.meta.url));
  const child = spawn(launcher, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
    CODEX_HOME: codexHome, SLEIGHT_TRACE: traces, SLEIGHT_SURFACES: 'computer', SLEIGHT_TURBO: '0',
    SLEIGHT_HAND: '0', SLEIGHT_WARM_REPL: '0', SLEIGHT_WARM_ENGINE: '0',
  } });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await closed;
    await rm(bank, { recursive: true, force: true });
  });
  let stderr = '';
  child.stderr.on('data', data => stderr += data);
  child.stdout.resume();
  child.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18',
      capabilities: {}, clientInfo: { name: 'eof-test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ].map(message => JSON.stringify(message) + '\n').join(''));
  let deadline;
  try {
    const exit = await Promise.race([closed, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('launcher stayed alive after immediate EOF')), 2500);
    })]);
    assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  } finally { clearTimeout(deadline); }
  const events = (await readFile(join(traces, `trace-${child.pid}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse);
  const started = events.filter(event => event.direction === 'engine-started');
  const collected = events.filter(event => event.direction === 'engine-closed');
  assert.equal(started.length, 1, 'the fixture engine started');
  assert.equal(collected.length, started.length, 'every started engine was collected');
  assert.equal(collected[0].msg.code, 0, 'engine closed cleanly');
  assert.ok(events.findIndex(event => event.direction === 'engine-closed') <
    events.findIndex(event => event.direction === 'process-exit'), 'engine collected before launcher exit');
});
