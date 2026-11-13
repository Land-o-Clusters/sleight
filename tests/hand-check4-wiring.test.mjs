import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { check4BenchDescriptor } from '../bench/hand/check4-bench.mjs';
import { check4HandPolicy } from '../bench/hand/check4-server.mjs';
import { createHandClient } from '../plugins/sleight/lib/hand/client.mjs';
import { handSetting } from '../plugins/sleight/lib/hand/settings.mjs';
import { createCursorEvents } from '../plugins/sleight/lib/hand/events.mjs';
import { createRelayHand } from '../plugins/sleight/lib/hand/relay-hand.mjs';
import { readFileSync } from 'node:fs';

test('private MCP style reaches native aims and the turn lifecycle when installed settings are absent', async t => {
  const env = check4BenchDescriptor({ dir: '/fixture' }, '/fixture', 'node').env;
  const setting = () => handSetting({ env, platform: 'darwin', read: () => ({ state: 'absent' }) });
  const lines = [], traces = [], child = new EventEmitter();
  child.pid = 4242;
  child.stdin = Object.assign(new EventEmitter(), { writableLength: 0,
    write: text => { lines.push(...text.trim().split('\n').map(JSON.parse)); return true; }, end() {} });
  child.stdout = new EventEmitter(); child.kill = () => {};
  child.stdio = [child.stdin, child.stdout, null, new EventEmitter(), new EventEmitter()];
  const client = createHandClient({ ...check4HandPolicy('fixture'), env, built: () => true,
    loadSprite: async () => { throw Error('no decoder in this wire test'); },
    prepare: async () => ({ status: 'ready', spawn: () => child }) });
  const cursor = createCursorEvents({ env, setting });
  const bounds = { X: 200, Y: 500, Width: 900, Height: 350 };
  const hand = createRelayHand({ client, events: cursor, env, setting, trace: (...args) => traces.push(args),
    locate: async () => ({ ok: true, window: { pid: 42, windowId: 7, bounds }, elements: {},
      windows: [{ id: 7, pid: 42, layer: 0, bounds }], displays: [{ X: 0, Y: 0, Width: 1800, Height: 1200 }] }) });
  t.after(() => { hand.close(); cursor.close(); client.close(); });
  hand.protect?.({ app: 'Fixture', nativeIdentity: { pid: 42, windowNumber: 7 } });
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(lines.some(row => row.hand === 'wide' && row.pid === 42 && row.windowId === 7),
    'area admission must use the session client policy when installed settings have no size');
  hand.admit(1, { code: 'await app.click([300, 200])', target: { app: 'Fixture' }, screenshotSize: [900, 350] });
  for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
  hand.result(1, false);
  cursor.status('done');
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(lines.some(row => row.hand === 'act'), JSON.stringify({ lines, traces }));
  assert.ok(lines.some(row => row.hand === 'aim'), 'private style must reach the relay planner');
  assert.ok(lines.some(row => row.hand === 'status' && row.state === 'done' && row.ok !== true), 'turn end must reach the same host');
  assert.equal(setting().style, 'sprite');
});

test('private relay owns its retention bank and cursor settings before ordinary startup', async t => {
  const { sessionCursorEvents } = await import('../plugins/sleight/lib/hand/events.mjs?check4-private-session');
  const sent = [], settings = () => ({ enabled: true, style: 'sprite', record_runs: false, stream: false });
  const cursor = sessionCursorEvents({ setting: settings, env: { SLEIGHT_HAND: '1' }, platform: 'darwin',
    recorder: () => { throw Error('private cursor must not record'); } });
  t.after(() => cursor.close());
  cursor.connectHost({ enabled: true, cursor: event => sent.push(event) });
  cursor.status('done');
  assert.ok(sent.some(event => event.type === 'status' && event.state === 'done'));
  assert.equal(sessionCursorEvents(), cursor);
  const server = readFileSync(new URL('../bench/hand/check4-server.mjs', import.meta.url), 'utf8');
  const launch = readFileSync(new URL('../plugins/sleight/lib/launch.mjs', import.meta.url), 'utf8');
  assert.match(server, /sessionCursorEvents\(\{ setting: check4HandPolicy\(pack.manifest.id\).setting \}\)/);
  assert.match(server, /runRetentionOptions: \{ root: join\(dirname\(config.status\), 'runs'\), config: join\(dirname\(config.status\), 'hand.json'\) \}/);
  assert.match(launch, /startRunRetention\(\{\s*\.\.\.runRetentionOptions,/);
});
