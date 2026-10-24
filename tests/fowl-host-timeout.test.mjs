import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function runner(t) {
  const cache = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser');
  if (!existsSync(join(cache, '.git'))) { t.skip('pinned FowlBrowser cache is absent'); return; }
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-fowl-host-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = spawnSync('/usr/bin/git', ['-C', cache, 'show', '6a12d60:tools/rounds.mjs'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(original.status, 0, original.stderr);
  mkdirSync(join(dir, 'tools'));
  const file = join(dir, 'tools/rounds.mjs');
  writeFileSync(file, original.stdout);
  const applied = spawnSync('/usr/bin/git', ['apply', join(root, 'bench/fowl/sleight-surface.patch')], { cwd: dir, encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  return { dir, mod: await import(pathToFileURL(file)), source: readFileSync(file, 'utf8') };
}

test('a host that never answers rejects at the five-second deadline', async t => {
  const fixture = await runner(t); if (!fixture) return;
  const { hostRequest } = fixture.mod;
  assert.equal(typeof hostRequest, 'function');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const pending = hostRequest({ request: () => new Promise(() => {}) }, 'tabs.listAll');
  const checked = assert.rejects(pending, /tabs.listAll.*5000 ms/).then(() => { settled = true; });
  t.mock.timers.tick(4999); await tick(); assert.equal(settled, false);
  t.mock.timers.tick(1); await checked;
});

test('host deadlines preserve successful values and synchronous errors', async t => {
  const fixture = await runner(t); if (!fixture) return;
  const { hostRequest } = fixture.mod;
  assert.equal(typeof hostRequest, 'function');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.deepEqual(await hostRequest({ request: async () => [{ id: 1 }] }, 'tabs.listAll'), [{ id: 1 }]);
  await assert.rejects(hostRequest({ request: () => { throw Error('disconnected'); } }, 'tabs.listAll'), /disconnected/);
  t.mock.timers.tick(5000);
});

test('both browser inventories start together and one unavailable host bounds the inventory', async t => {
  const fixture = await runner(t); if (!fixture) return;
  assert.equal(typeof fixture.mod.hostRequest, 'function');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const hosts = Object.fromEntries(['one', 'two'].map(browser => [browser, { request: () => {
    calls.push(browser); return new Promise(() => {});
  } }]));
  const checked = assert.rejects(fixture.mod.inventory(hosts), /tab inventory unavailable/);
  await tick(); assert.deepEqual(calls, ['one', 'two']);
  t.mock.timers.tick(5000); await checked;
});

test('a finished agent records turn ownership before closing stdin, even when inventory fails', async t => {
  const fixture = await runner(t); if (!fixture) return;
  const { finishAgent } = fixture.mod;
  assert.equal(typeof finishAgent, 'function');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let ended = 0;
  const run = {}, hosts = { fixture: { request: () => new Promise(() => {}) } };
  const child = { stdin: { end: () => { ended++; } } };
  const pending = finishAgent(run, { child, hosts, exited: Promise.resolve(), kill: () => assert.fail('collected child was signaled') });
  assert.equal(ended, 0);
  await tick(); t.mock.timers.tick(1000); await tick();
  t.mock.timers.tick(5000); await tick();
  assert.equal(ended, 1);
  t.mock.timers.tick(2000); await tick();
  t.mock.timers.tick(5000); await pending;
  assert.deepEqual(run.atTurnEnd, {}); assert.deepEqual(run.afterExit, {});
  assert.equal(run.inventoryErrors.length, 2);
  assert.ok(run.inventoryErrors.every(error => /tab inventory unavailable/.test(error)));
  assert.ok(/\.\.\.\(run\.inventoryErrors \|\| \[\]\)/.test(fixture.source));
  t.mock.timers.tick(20000);
});

test('the turn-end inventory sees ownership before stdin changes it', async t => {
  const fixture = await runner(t); if (!fixture) return;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let owner = 'fixture';
  const hosts = { fixture: { request: async () => [{ id: 1, owner }] } };
  const run = {};
  const pending = fixture.mod.finishAgent(run, { child: { stdin: { end: () => { owner = null; } } }, hosts,
    exited: Promise.resolve(), kill: () => assert.fail('collected child was signaled') });
  await tick(); t.mock.timers.tick(1000); await tick();
  t.mock.timers.tick(2000); await pending;
  assert.equal(run.atTurnEnd['fixture:1'].owner, 'fixture');
  assert.equal(run.afterExit['fixture:1'].owner, null);
});

test('monitor setup, takeover and cleanup host calls all use the bounded request path', async t => {
  const fixture = await runner(t); if (!fixture) return;
  assert.ok(/hostRequest\(host, 'tabs.watchActivity'\)/.test(fixture.source));
  assert.ok(/hostRequest\(hosts\[tab.browser\], 'tabs.focus'/.test(fixture.source));
  assert.ok(/hostRequest\(hosts\[now\[k\].browser\], 'tabs.closeUnowned'/.test(fixture.source));
  assert.ok(/await finishAgent\(run,/.test(fixture.source));
});

test('a monitor waiting on an unavailable host stops after its request deadline', async t => {
  const fixture = await runner(t); if (!fixture) return;
  assert.equal(typeof fixture.mod.startMonitor, 'function');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const host = { on() {}, request: method => method === 'tabs.watchActivity' ? Promise.resolve() : new Promise(() => {}) };
  const monitor = await fixture.mod.startMonitor({ fixture: host }, join(fixture.dir, 'monitor.jsonl'), { readFront: async () => null });
  await tick();
  const stopped = monitor.stop();
  t.mock.timers.tick(5000); await tick(); t.mock.timers.tick(0); await stopped;
  assert.ok(monitor.log.some(entry => /tab inventory unavailable/.test(entry.message)));
});

test('socket request timeouts and disconnects settle without leaving another request blocked', async t => {
  const fixture = await runner(t); if (!fixture) return;
  assert.ok(/connect = net.connect/.test(fixture.source));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  writeFileSync(join(fixture.dir, 'token'), 'fake-token');
  const socket = new EventEmitter();
  socket.write = () => {};
  socket.end = socket.destroy = () => socket.emit('close');
  const connecting = fixture.mod.connectHost('fixture', fixture.dir, () => socket);
  await tick(); socket.emit('connect');
  const host = await connecting;
  const timedOut = assert.rejects(host.request('tabs.listAll'), /5000 ms/);
  await tick(); t.mock.timers.tick(5000); await timedOut;
  const disconnected = assert.rejects(host.request('tabs.watchActivity'), /disconnected/);
  await tick(); host.close(); await disconnected;
  t.mock.timers.tick(5000);
});
