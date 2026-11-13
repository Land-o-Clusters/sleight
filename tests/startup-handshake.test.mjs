import { macCommandSkip } from './requirements.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { MOD_META } from './fixtures/mod-attribution.mjs';
import { turboFirstRules } from '../plugins/sleight/lib/turbo-first-rules.mjs';

for (const [runtime, mode] of [['engine', 'pending'], ['own', 'pending'], ['engine', 'failure'], ['engine', 'compiler-eof'], ['engine', 'compiler-signal']]) test(`installed ${runtime} launcher initializes before turbo or helper work, ${mode}`, { timeout: 15000,
  skip: mode.startsWith('compiler') && macCommandSkip('xcrun') }, async t => {
  const bank = realpathSync(trackTemp(await mkdtemp(join(tmpdir(), 'sleight-deferred-startup-'))));
  const codexHome = join(bank, 'codex'), config = join(codexHome, 'plugins/cache/openai-bundled/unified-computer-use/1.0');
  await mkdir(config, { recursive: true });
  await writeFile(join(config, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: {
    command: process.execPath, args: [fileURLToPath(new URL('fixtures/handshake-engine.mjs', import.meta.url))],
  } } }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('fixtures/deferred-startup-launcher.mjs', import.meta.url)), join(bank, 'leases'), mode], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CODEX_HOME: codexHome, SLEIGHT_RUNTIME: runtime,
      SLEIGHT_SURFACES: 'computer', SLEIGHT_TURBO: '1', SLEIGHT_HAND: '0', SLEIGHT_WARM_REPL: '0', SLEIGHT_WARM_ENGINE: '0' },
  });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  let stderr = '', buffer = '', finish;
  const catalog = new Promise(resolve => { finish = resolve; });
  const replies = [];
  child.stderr.on('data', bytes => { stderr += bytes; });
  child.stdout.on('data', bytes => {
    buffer += bytes;
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const row = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); replies.push(row);
      if (row.id === 1) child.stdin.write(JSON.stringify({ id: 2, jsonrpc: '2.0', method: 'tools/list', params: {} }) + '\n');
      if (row.id === 2) finish(row);
    }
  });
  t.after(async () => {
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed; await rm(bank, { recursive: true, force: true });
  });
  child.stdin.write(JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'fixture' } } }) + '\n');
  let timer;
  try {
    const result = await Promise.race([catalog, closed.then(exit => { throw Error(JSON.stringify(exit) + stderr); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('initialize waited on turbo: ' + stderr)), 5000); })]);
    assert.ok(replies.find(row => row.id === 1).result.serverInfo);
    assert.ok(result.result.tools.some(tool => tool.name === 'js'));
    assert.ok(result.result.tools.some(tool => tool.name === 'browser_open'));
    assert.doesNotMatch(stderr, /FIXTURE_(?:TURBO_WORK|NATIVE_HELPER)_STARTED/);
    assert.doesNotMatch(stderr, /FIXTURE_ENGINE_BROWSER_PREPARED/);
    if (mode !== 'pending') {
      const send = (id, name, args, meta) => child.stdin.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: args, _meta: meta } }) + '\n');
      const wait = async id => {
        const until = Date.now() + 3000;
        while (!replies.some(row => row.id === id) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
        const reply = replies.find(row => row.id === id); assert.ok(reply, `missing reply ${id}: ${stderr}`); return reply;
      };
      send(3, 'turn_ended', { sleight_turbo: { event: 'bootstrap' } }, MOD_META);
      const envelope = JSON.parse((await wait(3)).result.content[0].text).sleightTurbo;
      send(4, 'turn_ended', { sleight_turbo: { ...envelope, event: 'begin', turn: 'fixture1', text: 'Read the browser.', origin: 'composer', turbo: true } }, MOD_META);
      assert.equal((await wait(4)).result.isError, false);
      assert.doesNotMatch(stderr, /FIXTURE_TURBO_WORK_STARTED/);
      send(5, 'browser_tabs', { do: 'list' });
      const preparing = (await wait(5)).result;
      assert.match(preparing.content[0].text, /Preparing turbo/);
      const pinned = JSON.parse(await readFile(new URL('fixtures/turbo-instructions-044e3606.json', import.meta.url)));
      const rules = preparing.content.find(item => item.text?.includes('## Browsers'))?.text;
      const selected = rules?.match(/Turbo selects `(b[a-z0-9]+)`/)?.[1];
      assert.ok(selected, 'real run frontend uses configured turbo guidance');
      assert.equal(rules, turboFirstRules(pinned.on.replaceAll('bbench', selected)));
      if (mode.startsWith('compiler')) {
        const until = Date.now() + 5000;
        while (!existsSync(join(bank, 'compiler.pid')) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
        const compiler = Number(await readFile(join(bank, 'compiler.pid'), 'utf8'));
        if (mode === 'compiler-signal') child.kill('SIGTERM');
        else child.stdin.end();
        assert.deepEqual(await closed, { code: 0, signal: null }, stderr);
        assert.throws(() => process.kill(compiler, 0), { code: 'ESRCH' }, 'server shutdown collected its compiler');
        assert.equal(existsSync(join(bank, 'cache', 'build.lock')), false);
        return;
      }
      send(6, 'browser_tabs', { do: 'list' });
      assert.match((await wait(6)).result.content[0].text, /SELECTED_PROCESS_UNPROVED/);
      send(7, 'js', { code: 'nodeRepl.write("fixture")' });
      await wait(7);
      assert.match(stderr, /FIXTURE_ENGINE_BROWSER_PREPARED/);
    }
    child.stdin.end(); assert.deepEqual(await closed, { code: 0, signal: null }, stderr);
  } finally { clearTimeout(timer); }
});

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
  const launcher = fileURLToPath(new URL('fixtures/startup-launcher.mjs', import.meta.url));
  const child = spawn(process.execPath, [launcher, join(bank, 'leases')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
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
