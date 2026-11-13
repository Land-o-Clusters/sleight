import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createStartupCache, startupIdentity } from '../plugins/sleight/lib/startup-cache.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { INVENTORY_NOTE, INVENTORY_SENTENCE } from '../plugins/sleight/lib/engine-app-docs.mjs';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';

const init = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
const tools = { tools: [{ name: 'js', description: 'fixture', inputSchema: { type: 'object' } },
  { name: 'js_add_node_module_dir', inputSchema: { type: 'object' } }] };
const initialization = id => ({ jsonrpc: '2.0', id, method: 'initialize', params: {
  protocolVersion: '2025-06-18', clientInfo: { name: 'fixture', version: '1' }, capabilities: {} } });
function fixture(t, identity = { engine: '1', sleight: '1' }) {
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-startup-')));
  t.after(() => removeTemp(directory));
  const connect = (options = {}, key = identity) => {
    const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
    const client = [], server = [];
    for (const [stream, messages] of [[clientOut, client], [serverIn, server]]) {
      stream.setEncoding('utf8').on('data', data => data.trim().split('\n').filter(Boolean).forEach(line => messages.push(JSON.parse(line))));
    }
    const relay = createRelay({ clientIn, clientOut, serverIn, serverOut,
      startupCache: createStartupCache({ identity: key, directory }), ...options });
    t.after(() => relay.dispose());
    return { client, server, close: () => relay.dispose(), send: msg => clientIn.write(JSON.stringify(msg) + '\n'),
      reply: msg => serverOut.write(JSON.stringify(msg) + '\n') };
  };
  return { directory, connect };
}
function warm(h, list = tools, result = init) {
  h.send(initialization(1));
  h.reply({ jsonrpc: '2.0', id: 1, result: structuredClone(result) });
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  h.reply({ jsonrpc: '2.0', id: 2, result: structuredClone(list) });
  return structuredClone(h.client);
}
const listChanged = msg => msg.method === 'notifications/tools/list_changed';
test('warm replies equal fresh rewritten replies, use current IDs and do not wait for the engine', t => {
  const { connect } = fixture(t);
  const fresh = warm(connect({ firstCallBatch: true }));
  const h = connect({ firstCallBatch: true });
  h.send(initialization('init'));
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.send({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
  assert.deepEqual(h.client, fresh.map((msg, i) => ({ ...msg, id: i ? 'list' : 'init' })));
  assert.deepEqual(h.server.map(msg => msg.method), ['initialize']);
  h.reply({ jsonrpc: '2.0', id: 'init', result: structuredClone(init) });
  assert.deepEqual(h.server.map(msg => msg.method), ['initialize', 'notifications/initialized', 'tools/list']);
  h.reply({ jsonrpc: '2.0', id: 'list', result: structuredClone(tools) });
  assert.equal(h.client.length, 2, 'fresh replies do not duplicate cached ones');
});
test('tool calls wait for the live handshake and tool-list verification', t => {
  const { connect } = fixture(t); warm(connect());
  const h = connect(); h.send(initialization(10));
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.send({ jsonrpc: '2.0', id: 11, method: 'tools/list' });
  h.send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'js', arguments: { code: '1' } } });
  assert.equal(h.server.length, 1);
  h.reply({ jsonrpc: '2.0', id: 10, result: structuredClone(init) });
  assert.equal(h.server.filter(msg => msg.method === 'tools/call').length, 0);
  h.reply({ jsonrpc: '2.0', id: 11, result: structuredClone(tools) });
  assert.equal(h.server.at(-1).id, 12);
});
for (const initial of [false, true]) test(`changing lean calls from ${initial} uses the live description and admits queued calls`, t => {
  const { connect } = fixture(t);
  const previous = warm(connect({ leanCalls: initial }));
  const h = connect({ leanCalls: !initial });
  h.send(initialization(10));
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.send({ jsonrpc: '2.0', id: 11, method: 'tools/list' });
  h.send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'js', arguments: { code: '1' } } });
  h.reply({ jsonrpc: '2.0', id: 10, result: structuredClone(init) });
  h.reply({ jsonrpc: '2.0', id: 11, result: structuredClone(tools) });
  assert.equal(h.client.some(msg => msg.id === 12 && msg.error), false,
    JSON.stringify(h.client.find(msg => msg.id === 12)));
  assert.ok(h.server.some(msg => msg.id === 12), 'the live tool list admits the queued call');
  const description = h.client.find(msg => msg.id === 11).result.tools.find(tool => tool.name === 'js').description;
  assert.equal(description.includes('Native calls: keep the app handle across calls.'), !initial);
  assert.notEqual(description, previous.find(msg => msg.id === 2).result.tools.find(tool => tool.name === 'js').description);
});
for (const leanCalls of [false, true]) test(`lean calls ${leanCalls} reuses its selected cached description before the engine replies`, t => {
  const { connect } = fixture(t);
  const fresh = warm(connect({ leanCalls }));
  const h = connect({ leanCalls });
  h.send(initialization(10));
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.send({ jsonrpc: '2.0', id: 11, method: 'tools/list' });
  assert.deepEqual(h.client, fresh.map((msg, index) => ({ ...msg, id: index ? 11 : 10 })));
  const description = h.client.find(msg => msg.id === 11).result.tools.find(tool => tool.name === 'js').description;
  assert.equal(description.includes('Native calls: keep the app handle across calls.'), leanCalls);
  h.send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'js', arguments: { code: '1' } } });
  assert.equal(h.server.some(msg => msg.id === 12), false, 'cached replies still wait for live verification');
  h.reply({ jsonrpc: '2.0', id: 10, result: structuredClone(init) });
  h.reply({ jsonrpc: '2.0', id: 11, result: structuredClone(tools) });
  assert.ok(h.server.some(msg => msg.id === 12));
  assert.equal(h.client.some(msg => msg.id === 12 && msg.error), false);
});
for (const [label, identity, params] of [
  ['engine version', { engine: '2', sleight: '1' }],
  ['sleight version', { engine: '1', sleight: '2' }],
  ['surface environment', { engine: '1', sleight: '1', env: { SURFACES: 'browser' } }],
  ['client protocol', undefined, { protocolVersion: 'different' }],
  ['client capabilities', undefined, { capabilities: { sampling: {} } }],
]) test(`${label} change misses the cache`, t => {
  const { connect } = fixture(t); warm(connect());
  const h = connect({}, identity); const msg = initialization(3);
  Object.assign(msg.params, params); h.send(msg);
  assert.equal(h.client.length, 0);
  h.reply({ jsonrpc: '2.0', id: 3, result: structuredClone(init) });
  assert.equal(h.client.length, 1);
});
// The cache holds the engine's own replies, and the relay rewrites them for each session, so a relay setting changed
// between sessions answers as a cold session with that setting would (SLEIGHT_FS race, 2026-10-19).
for (const [label, options] of [
  ['document scope', { approvalScope: 'document' }],
  ['batch description', { firstCallBatch: true }],
  ['prompt variant', { prompt: 'lean' }],
  ['local tool schema', { localTools: { tools: [{ name: 'local', inputSchema: { type: 'object' } }] } }],
  ['change review', { changeReview: false }],
  ['first-call steering (SLEIGHT_FS)', { firstCallSteering: true }],
  ['first-call windows (SLEIGHT_TS3)', { firstCallWindows: true }],
]) test(`${label} change reuses the cached engine handshake and answers as a cold session`, t => {
  const steering = { tools: [{ ...tools.tools[0], description: `Run code. ${INVENTORY_SENTENCE} Then act.` }, tools.tools[1]] };
  const cold = warm(fixture(t).connect(options), steering);
  const { connect } = fixture(t); warm(connect(), steering);
  const h = connect(options);
  h.send(initialization(1));
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(h.client, cold, 'answered from the cache before the engine replies');
  h.reply({ jsonrpc: '2.0', id: 1, result: structuredClone(init) });
  h.reply({ jsonrpc: '2.0', id: 2, result: structuredClone(steering) });
  assert.deepEqual(h.client, cold, 'the live replies verify without an error or a second answer');
});
test('SLEIGHT_FS flipped on between sessions keeps every call working (race 2026-10-19)', t => {
  const steering = { tools: [{ ...tools.tools[0], description: `Run code. ${INVENTORY_SENTENCE} Then act.` }] };
  const { connect } = fixture(t); warm(connect({ firstCallSteering: false }), steering);
  const h = connect({ firstCallSteering: true });
  h.send(initialization(10));
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.send({ jsonrpc: '2.0', id: 11, method: 'tools/list' });
  h.send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'js', arguments: { code: '1' } } });
  assert.match(h.client.find(msg => msg.id === 11).result.tools[0].description, new RegExp(INVENTORY_NOTE.slice(0, 20)));
  h.reply({ jsonrpc: '2.0', id: 10, result: structuredClone(init) });
  h.reply({ jsonrpc: '2.0', id: 11, result: structuredClone(steering) });
  assert.ok(h.server.some(msg => msg.id === 12));
  assert.equal(h.client.some(msg => msg.error), false, JSON.stringify(h.client));
});
for (const advertised of [true, false]) test(`stale cached tools (${advertised ? 'listChanged advertised' : 'no listChanged'}): the session continues on the live list and the cache is rewritten`, t => {
  const result = advertised ? { ...init, capabilities: { tools: { listChanged: true } } } : init;
  const { connect } = fixture(t); warm(connect(), tools, result);
  const h = connect(); h.send(initialization(10));
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.send({ jsonrpc: '2.0', id: 11, method: 'tools/list' });
  h.send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'js', arguments: { code: '1' } } });
  h.reply({ jsonrpc: '2.0', id: 10, result: structuredClone(result) });
  const live = { tools: [...tools.tools, { name: 'new_tool', inputSchema: { type: 'object' } }] };
  h.reply({ jsonrpc: '2.0', id: 11, result: structuredClone(live) });
  assert.ok(h.server.some(msg => msg.id === 12), 'the queued call runs on the live engine');
  assert.equal(h.client.some(msg => msg.error), false, JSON.stringify(h.client));
  assert.equal(h.client.filter(msg => msg.id === 11).length, 1);
  assert.equal(h.client.filter(listChanged).length, advertised ? 1 : 0, 'only a client told the list can change hears that it did');
  h.send({ jsonrpc: '2.0', id: 13, method: 'tools/list' });
  assert.equal(h.client.some(msg => msg.id === 13), false, 'the refetch goes to the engine');
  h.reply({ jsonrpc: '2.0', id: 13, result: structuredClone(live) });
  assert.ok(h.client.find(msg => msg.id === 13).result.tools.some(tool => tool.name === 'new_tool'));
  h.reply({ jsonrpc: '2.0', id: 12, result: { content: [{ type: 'text', text: 'done' }] } });
  h.send({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'js', arguments: { code: '2' } } });
  assert.ok(h.server.some(msg => msg.id === 14));
  const next = connect(); next.send(initialization(20));
  next.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  next.send({ jsonrpc: '2.0', id: 21, method: 'tools/list' });
  assert.ok(next.client.find(msg => msg.id === 21).result.tools.some(tool => tool.name === 'new_tool'), 'the cache holds the live list');
});
test('a stale cached initialize answer keeps calls working and the next session gets the live answer', t => {
  const { connect } = fixture(t); warm(connect());
  const h = connect(); h.send(initialization(10));
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.send({ jsonrpc: '2.0', id: 11, method: 'tools/list' });
  h.send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'js', arguments: { code: '1' } } });
  const live = { ...init, serverInfo: { name: 'fixture', version: '2' }, instructions: 'changed' };
  h.reply({ jsonrpc: '2.0', id: 10, result: structuredClone(live) });
  h.reply({ jsonrpc: '2.0', id: 11, result: structuredClone(tools) });
  assert.equal(h.client.filter(msg => msg.id === 10).length, 1, 'one initialize answer');
  assert.ok(h.server.some(msg => msg.id === 12));
  assert.equal(h.client.some(msg => msg.error), false, JSON.stringify(h.client));
  const next = connect(); next.send(initialization(20));
  assert.equal(next.client.find(msg => msg.id === 20).result.serverInfo.version, '2');
});
test('a changed protocol version fails only the calls queued during startup, with a retry message', t => {
  const { connect } = fixture(t); warm(connect());
  const h = connect(); h.send(initialization(10));
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.send({ jsonrpc: '2.0', id: 11, method: 'tools/list' });
  h.send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'js', arguments: { code: '1' } } });
  h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 12 } });
  h.reply({ jsonrpc: '2.0', id: 10, result: { ...structuredClone(init), protocolVersion: '2025-11-25' } });
  assert.equal(h.server.some(msg => msg.method === 'notifications/cancelled'), false, 'a refused call\'s cancellation stays here');
  h.send({ jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'js', arguments: { code: '1' } } });
  h.reply({ jsonrpc: '2.0', id: 11, result: structuredClone(tools) });
  assert.match(h.client.find(msg => msg.id === 12).error.message, /again/i);
  assert.equal(h.server.some(msg => msg.id === 12), false);
  assert.match(h.client.find(msg => msg.id === 15).error.message, /again/i, 'a call sent while the cached list waited');
  assert.equal(h.server.some(msg => msg.id === 15), false);
  h.send({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'js', arguments: { code: '1' } } });
  assert.ok(h.server.some(msg => msg.id === 13), 'the retry runs');
  const next = connect(); next.send(initialization(20));
  assert.equal(next.client.find(msg => msg.id === 20).result.protocolVersion, '2025-11-25');
});
test('a cached list the session cannot rewrite is answered live', t => {
  const { directory } = fixture(t);
  const cache = createStartupCache({ identity: { engine: '1', sleight: '1' }, directory });
  const cold = cache.bind({ send() {}, forward() {} });
  cold.initialize(initialization(1)); cold.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  cold.reply({ jsonrpc: '2.0', id: 1, result: structuredClone(init) }); cold.reply({ jsonrpc: '2.0', id: 2, result: structuredClone(tools) });
  const sent = [], forwarded = [];
  const startup = cache.bind({
    send: msg => sent.push(msg), forward: msg => forwarded.push(msg), present: { tools: () => { throw new Error('fixture'); } } });
  startup.initialize(initialization(10));
  assert.equal(sent.length, 1, 'the initialize answer comes from the cache');
  startup.request({ jsonrpc: '2.0', method: 'notifications/initialized' });
  startup.request({ jsonrpc: '2.0', id: 11, method: 'tools/list' });
  assert.equal(sent.length, 1, 'no cached list');
  assert.equal(startup.reply({ jsonrpc: '2.0', id: 10, result: structuredClone(init) }), true);
  assert.equal(startup.reply({ jsonrpc: '2.0', id: 11, result: structuredClone(tools) }), false, 'the live list goes to the client');
  assert.deepEqual(forwarded.map(msg => msg.method), ['notifications/initialized', 'tools/list']);
});
test('initialization failure fails pending calls without forwarding them', t => {
  const { connect } = fixture(t); warm(connect()); const h = connect();
  h.send(initialization(10));
  h.send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'js', arguments: { code: '1' } } });
  h.reply({ jsonrpc: '2.0', id: 10, error: { code: -1, message: 'fixture failed' } });
  assert.equal(h.server.length, 1);
  assert.ok(h.client.find(msg => msg.id === 12).error);
});
test('unsafe and corrupt entries miss without breaking startup', t => {
  const { connect, directory } = fixture(t); warm(connect());
  const file = join(directory, readdirSync(directory)[0]);
  chmodSync(file, 0o666); const h = connect(); h.send(initialization(4)); assert.equal(h.client.length, 0);
  chmodSync(file, 0o600); writeFileSync(file, '{');
  const next = connect(); next.send(initialization(5)); assert.equal(next.client.length, 0);
});
test('a symlink or oversized cache entry cannot supply a handshake', t => {
  const { connect, directory } = fixture(t); warm(connect());
  const file = join(directory, readdirSync(directory)[0]);
  const target = join(directory, 'target'); writeFileSync(target, '{}');
  rmSync(file); symlinkSync(target, file);
  const h = connect(); h.send(initialization(4)); assert.equal(h.client.length, 0);
  rmSync(file); writeFileSync(file, ' '.repeat(1024 * 1024 + 1));
  const next = connect(); next.send(initialization(5)); assert.equal(next.client.length, 0);
});
test('a writable cache directory cannot supply or publish a handshake', t => {
  const { connect, directory } = fixture(t); warm(connect()); chmodSync(directory, 0o777);
  const h = connect(); h.send(initialization(3)); assert.equal(h.client.length, 0);
  warm(connect());
});
test('the identity covers inherited settings and fails back when the build cannot be read', t => {
  const root = new URL('../plugins/sleight/', import.meta.url).pathname;
  const server = { version: '1', command: '/fixture', args: [], env: { SURFACES: 'computer' } };
  const a = startupIdentity(server, root, { CUA_REPL_ENABLED_SURFACES: 'a' });
  const b = startupIdentity(server, root, { CUA_REPL_ENABLED_SURFACES: 'b' });
  assert.notDeepEqual(a, b);
  assert.match(a.sleight[1], /^[a-f0-9]{64}$/);
  assert.equal(a.env.SURFACES, 'computer');
  assert.equal(startupIdentity({}, root), undefined);
  assert.equal(startupIdentity(server, '/missing-fixture-root'), undefined);
});
test('source changes sharing a plugin version change the cache identity', t => {
  const { directory } = fixture(t);
  mkdirSync(join(directory, 'lib')); mkdirSync(join(directory, '.claude-plugin'));
  writeFileSync(join(directory, '.claude-plugin/plugin.json'), JSON.stringify({ version: '1' }));
  const source = join(directory, 'lib/example.mjs'); writeFileSync(source, 'export const value = 1;');
  const server = { version: '1', command: '/fixture', args: [] };
  const before = startupIdentity(server, directory, {});
  writeFileSync(source, 'export const value = 2;');
  assert.notDeepEqual(startupIdentity(server, directory, {}), before);
});
test('paginated tools are not cached', t => {
  const { connect } = fixture(t); const h = connect();
  h.send(initialization(1)); h.reply({ jsonrpc: '2.0', id: 1, result: structuredClone(init) });
  h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  h.reply({ jsonrpc: '2.0', id: 2, result: { ...tools, nextCursor: 'next' } });
  const next = connect(); next.send(initialization(3)); assert.equal(next.client.length, 0);
});
test('a call queued before the initialized notification is forwarded after it', t => {
  const { connect } = fixture(t); warm(connect()); const h = connect();
  h.send(initialization(10));
  h.send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'js', arguments: { command: '1' } } });
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.reply({ jsonrpc: '2.0', id: 10, result: structuredClone(init) });
  assert.deepEqual(h.server.map(msg => msg.method), ['initialize', 'notifications/initialized', 'tools/call']);
  assert.equal(h.server.at(-1).params.arguments.command, undefined, 'queued calls retain client preprocessing');
  assert.match(h.server.at(-1).params.arguments.code, /\n1(?:\n|$)/);
});
test('close rejects queued calls and preserves a completed cache', t => {
  const { connect } = fixture(t); warm(connect()); const h = connect();
  h.send(initialization(10));
  h.send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'js', arguments: { code: '1' } } });
  // Closing through the relay must not leave a queued caller waiting forever.
  h.close();
  assert.ok(h.client.find(msg => msg.id === 12).error);
  const next = connect(); next.send(initialization(20)); assert.equal(next.client.length, 1);
});
test('stop can collect the owned engine while initialization is pending', async t => {
  const { connect } = fixture(t); warm(connect()); let collected = 0, collectedResolve;
  const collection = new Promise(resolve => { collectedResolve = resolve; });
  const h = connect({ stopGraceMs: 1, stopEngine: async () => { collected++; collectedResolve(); return { collected: true }; } });
  h.send(initialization(10));
  h.send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'js', arguments: { code: '1' } } });
  h.send({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_stop: true } } });
  await collection;
  assert.equal(collected, 1);
  assert.ok(h.client.find(msg => msg.id === 12).error);
  assert.equal(h.server.filter(msg => msg.id === 12).length, 0);
});
test('spawn to tools/list with a delayed fixture, alone and thirteen at once', async t => {
  const { directory } = fixture(t);
  function run(index) {
    return new Promise((resolve, reject) => {
      const start = performance.now();
      const child = spawn(process.execPath, ['tests/fixtures/startup-relay.mjs', join(directory, String(index))], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let buffer = '', errors = '', elapsed;
      child.stderr.setEncoding('utf8').on('data', data => { errors += data; });
      child.stdout.setEncoding('utf8').on('data', data => {
        buffer += data; let at;
        while ((at = buffer.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
          if (msg.id === 1) {
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
          } else if (msg.id === 2) { elapsed = performance.now() - start; child.stdin.end(); }
        }
      });
      child.once('error', reject);
      child.once('close', code => code === 0 && Number.isFinite(elapsed) ? resolve(elapsed) : reject(new Error(errors || `fixture exit ${code}`)));
      child.stdin.write(JSON.stringify(initialization(1)) + '\n');
    });
  }
  const singleCold = await run(0), singleWarm = await run(0);
  const cold = await Promise.all(Array.from({ length: 13 }, (_, i) => run(i + 1)));
  const warm = await Promise.all(Array.from({ length: 13 }, (_, i) => run(i + 1)));
  t.diagnostic(JSON.stringify({ singleCold, singleWarm, thirteenCold: cold, thirteenWarm: warm }));
  assert.ok(singleCold >= 100);
  assert.ok(cold.every(ms => ms >= 100));
});

test('session-specific inherited settings reuse the same production cache identity', t => {
  const root = new URL('../plugins/sleight/', import.meta.url).pathname;
  const server = { version: '1', command: '/fixture', args: [], env: { FIXED_ENGINE_SETTING: 'yes' } };
  const a = startupIdentity(server, root, { CLAUDE_CODE_SESSION_ID: 'one', MESSAGING_TOKEN: 'one', SOCKET: '/one', CUA_SURFACE: 'browser',
    CODEX_SESSION_ID: 'one', CODEX_THREAD_ID: 'one', CODEX_APP_TOOLS_PIPE_PATH: '/one', BROWSER_USE_ACCESS_VERIFYING_IDENTITY: 'one' });
  const b = startupIdentity(server, root, { CLAUDE_CODE_SESSION_ID: 'two', MESSAGING_TOKEN: 'two', SOCKET: '/two', CUA_SURFACE: 'browser',
    CODEX_SESSION_ID: 'two', CODEX_THREAD_ID: 'two', CODEX_APP_TOOLS_PIPE_PATH: '/two', BROWSER_USE_ACCESS_VERIFYING_IDENTITY: 'two' });
  const { connect } = fixture(t, a);
  warm(connect());
  const h = connect({}, b);
  h.send(initialization(10));
  assert.deepEqual(h.client[0]?.result, init);
  assert.equal(b.env.FIXED_ENGINE_SETTING, 'yes');
  for (const name of ['CUA_SURFACE', 'NODE_REPL_NODE_PATH', 'SKY_CUA_SERVICE_PATH', 'BROWSER_USE_AVAILABLE_BACKENDS']) {
    const key = startupIdentity(server, root, { [name]: 'changed' });
    assert.notDeepEqual(key, a, name);
  }
});

test('publishing handshake entries retains at most eight cache files', t => {
  const { connect, directory } = fixture(t);
  for (let n = 0; n < 12; n++) warm(connect({}, { engine: String(n), sleight: '1' }));
  assert.equal(readdirSync(directory).filter(name => name.endsWith('.json')).length, 8);
  const newest = connect({}, { engine: '11', sleight: '1' });
  newest.send(initialization(10));
  assert.equal(newest.client.length, 1);
});

test('later tools/list requests use live updates without killing the session', t => {
  const { connect } = fixture(t); warm(connect());
  const h = connect(); warm(h);
  h.reply({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  h.send({ jsonrpc: '2.0', id: 20, method: 'tools/list' });
  assert.equal(h.client.filter(msg => msg.id === 20).length, 0);
  const changed = { tools: [...tools.tools, { name: 'new_tool', inputSchema: { type: 'object' } }] };
  h.reply({ jsonrpc: '2.0', id: 20, result: changed });
  assert.ok(h.client.find(msg => msg.id === 20).result.tools.some(tool => tool.name === 'new_tool'));
  h.send({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'js', arguments: { code: '1' } } });
  assert.equal(h.server.at(-1).id, 21);
  assert.equal(h.client.some(msg => msg.id === 21 && msg.error), false);
});

test('Stop forwards a queued initialized notification during a warm handshake', t => {
  const { connect } = fixture(t); warm(connect());
  const h = connect({ stopGraceMs: 1, stopEngine: async () => ({ collected: true }) });
  h.send(initialization(10));
  assert.equal(h.client.length, 1);
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.send({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'turn_ended', arguments: { sleight_stop: true } } });
  assert.equal(h.server.filter(msg => msg.method === 'notifications/initialized').length, 1);
});

for (const cached of [false, true]) test(`a failed ${cached ? 'warm' : 'cold'} handshake keeps the engine error`, t => {
  const { connect } = fixture(t);
  if (cached) warm(connect());
  const h = connect(); h.send(initialization(10));
  h.send({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'js', arguments: { code: '1' } } });
  h.reply({ jsonrpc: '2.0', id: 10, error: { code: -32001, message: 'Fixture engine initialization refused' } });
  assert.match(h.client.find(msg => msg.id === 11).error.message, /Fixture engine initialization refused/);
  h.send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'js', arguments: { code: '1' } } });
  assert.match(h.client.find(msg => msg.id === 12).error.message, /Fixture engine initialization refused/);
});

for (const cached of [false, true]) test(`ping and cancellation wait for ${cached ? 'warm' : 'cold'} engine initialization`, t => {
  const { connect } = fixture(t);
  if (cached) warm(connect());
  const h = connect(); h.send(initialization(10));
  h.send({ jsonrpc: '2.0', id: 11, method: 'ping' });
  h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } });
  assert.deepEqual(h.server.map(msg => msg.method), ['initialize']);
  h.reply({ jsonrpc: '2.0', id: 10, result: structuredClone(init) });
  assert.deepEqual(h.server.map(msg => msg.method), ['initialize', 'ping', 'notifications/cancelled']);
  h.reply({ jsonrpc: '2.0', id: 11, result: {} });
  assert.deepEqual(h.client.find(msg => msg.id === 11).result, {});
});

test('a failed warm first tool-list verification preserves the engine error for queued calls', t => {
  const { connect } = fixture(t); warm(connect());
  const h = connect(); h.send(initialization(10));
  h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  h.send({ jsonrpc: '2.0', id: 11, method: 'tools/list' });
  h.send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'js', arguments: { code: '1' } } });
  h.reply({ jsonrpc: '2.0', id: 10, result: structuredClone(init) });
  h.reply({ jsonrpc: '2.0', id: 11, error: { code: -32000, message: 'Fixture tool registration failed' } });
  assert.match(h.client.find(msg => msg.id === 12).error.message, /Fixture tool registration failed/);
  h.send({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'js', arguments: { code: '1' } } });
  assert.ok(h.server.some(msg => msg.id === 13), 'later calls reach the engine');
  const next = connect(); next.send(initialization(20)); assert.equal(next.client.length, 0, 'the entry is dropped');
});

test('per-run trace, idle and browser access values hit the same cached handshake', t => {
  const root = new URL('../plugins/sleight/', import.meta.url).pathname;
  const server = { version: '1', command: '/fixture', args: [], env: { CUA_REPL_ENABLED_SURFACES: 'browser' } };
  const a = startupIdentity(server, root, { SLEIGHT_TRACE: '/run/one', SLEIGHT_IDLE_TURN_END_MS: '1', BROWSER_USE_ACCESS_ID: 'one', CUA_SURFACE: 'browser' });
  const b = startupIdentity(server, root, { SLEIGHT_TRACE: '/run/two', SLEIGHT_IDLE_TURN_END_MS: '2', BROWSER_USE_ACCESS_ID: 'two', CUA_SURFACE: 'browser' });
  assert.deepEqual(a, b);
  const { connect } = fixture(t, a); warm(connect());
  const h = connect({}, b); h.send(initialization(10));
  assert.deepEqual(h.client[0]?.result, init);
  for (const name of ['CUA_SURFACE', 'NODE_REPL_NODE_PATH', 'NODE_REPL_NODE_MODULE_DIRS', 'SKY_CUA_SERVICE_PATH', 'BROWSER_USE_AVAILABLE_BACKENDS']) {
    assert.notDeepEqual(a, startupIdentity(server, root, { CUA_SURFACE: 'browser', [name]: '/changed' }), name);
  }
  assert.notDeepEqual(a, startupIdentity({ ...server, env: { CUA_REPL_ENABLED_SURFACES: 'computer' } }, root, {}));
});

for (const cached of [false, true]) test(`queued cancellation follows its ${cached ? 'warm' : 'cold'} call`, t => {
  const { connect } = fixture(t); if (cached) warm(connect());
  const h = connect(); h.send(initialization(10));
  h.send({ jsonrpc:'2.0', method:'notifications/initialized' });
  h.send({ jsonrpc:'2.0', id:11, method:'tools/list' });
  h.send({ jsonrpc:'2.0', id:12, method:'tools/call', params:{ name:'js', arguments:{code:'1'} } });
  h.send({ jsonrpc:'2.0', method:'notifications/cancelled', params:{requestId:12} });
  h.reply({ jsonrpc:'2.0', id:10, result:structuredClone(init) });
  if (cached) assert.equal(h.server.some(msg => msg.method === 'notifications/cancelled'), false);
  h.reply({ jsonrpc:'2.0', id:11, result:structuredClone(tools) });
  const call = h.server.findIndex(msg => msg.id === 12);
  const cancel = h.server.findIndex(msg => msg.method === 'notifications/cancelled');
  assert.ok(call >= 0 && cancel > call, JSON.stringify(h.server.map(msg => [msg.method,msg.id])));
});

for (const cached of [false, true]) test(`missing initialized notification has a two-second ${cached ? 'warm' : 'cold'} deadline`, t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const { connect } = fixture(t); if (cached) warm(connect());
  const h = connect(); h.send(initialization(10));
  h.send({ jsonrpc:'2.0', id:12, method:'tools/call', params:{name:'js',arguments:{code:'1'}} });
  t.mock.timers.tick(5000);
  assert.deepEqual(h.server.map(msg => msg.method), ['initialize'], 'the deadline must not bypass live initialization');
  h.reply({jsonrpc:'2.0',id:10,result:structuredClone(init)});
  t.mock.timers.tick(1999);
  assert.equal(h.server.some(msg => msg.id === 12), false);
  t.mock.timers.tick(1);
  assert.deepEqual(h.server.map(msg => msg.method), ['initialize','notifications/initialized','tools/call']);
  h.send({jsonrpc:'2.0',method:'notifications/initialized'});
  assert.equal(h.server.filter(msg => msg.method === 'notifications/initialized').length, 1);
});

test('initialized deadline cannot bypass cached tool verification and close clears its timer', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const { connect } = fixture(t); warm(connect());
  const h = connect(); h.send(initialization(10));
  h.send({jsonrpc:'2.0',id:11,method:'tools/list'});
  h.send({jsonrpc:'2.0',id:12,method:'tools/call',params:{name:'js',arguments:{code:'1'}}});
  h.reply({jsonrpc:'2.0',id:10,result:structuredClone(init)});
  t.mock.timers.tick(2000);
  assert.equal(h.server.some(msg => msg.id === 12),false);
  h.reply({jsonrpc:'2.0',id:11,result:structuredClone(tools)});
  assert.equal(h.server.at(-1).id,12);
  const closed = connect(); closed.send(initialization(20));
  closed.reply({jsonrpc:'2.0',id:20,result:structuredClone(init)});
  closed.close(); const length = closed.server.length;
  t.mock.timers.tick(2000);
  assert.equal(closed.server.length,length);
});
