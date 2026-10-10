import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveForm, tasks } from '../bench/tasks.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const task = tasks.find(t => t.id === 'simulator-form');
const submit = (url, message) => fetch(url, { method: 'POST', body: new URLSearchParams({ message }) });

function defaultSimulatorTask(bindings) {
  const source = readFileSync(new URL('../bench/tasks.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export \{.*;\n/gm, '').replace(/^export /gm, '');
  return runInNewContext(`(() => { ${source}\nreturn tasks.find(task => task.id === 'simulator-form'); })()`, {
    join, tmpdir: () => '/private/tmp', realpathSync: value => value, realTasks: [], process: { env: {} }, ...bindings,
  });
}

test('the default simulator form acquires a retained viewer lease before booting or opening its page', async () => {
  const calls = [], ctx = { nonce: 'fixture' };
  const task = defaultSimulatorTask({
    existsSync: () => true,
    acquireFixture: async (context, key, operation) => { context[key] = await operation(); },
    openFixture: async (context, request, { launch }) => {
      calls.push('lease');
      assert.equal(request.bundle, 'com.apple.dt.Devices');
      assert.equal(request.mode, 'inherit');
      await launch(owned => { assert.equal(owned, true); calls.push('launch'); });
      return { pid: 43 };
    },
    execFileSync(command, args) {
      if (command === 'xcrun' && args[1] === 'list') return JSON.stringify({ devices: { runtime: [
        { name: 'iPhone fixture', state: 'Shutdown', udid: 'fixture-device' },
      ] } });
      if (command === '/usr/bin/pgrep') throw Object.assign(new Error('not running'), { status: 1 });
      calls.push(command === 'open' ? 'open' : args[1]);
      return '';
    },
    createServer: () => ({ listen(_port, _host, ready) { ready(); }, address: () => ({ port: 1234 }),
      close: () => calls.push('server') }),
  });
  await task.setup(ctx);
  assert.deepEqual(calls, ['lease', 'boot', 'bootstatus', 'launch', 'open', 'openurl']);
  assert.equal(ctx.simViewer.pid, 43);
  assert.equal(ctx.sim.bootedByTask, true);
  assert.equal(typeof ctx.closeServer, 'function', 'permission stops need server cleanup without app cleanup');
  await ctx.closeServer();
  assert.equal(calls.at(-1), 'server');
});

test('default simulator preparation exposes local server cleanup for an interrupted lifecycle', async () => {
  let closes = 0;
  const ctx = { nonce: 'prepared' };
  const task = defaultSimulatorTask({
    createServer: () => ({ listen(_port, _host, ready) { ready(); }, address: () => ({ port: 1234 }),
      close: () => closes++ }),
  });
  await task.prepare(ctx);
  assert.equal(typeof ctx.closeServer, 'function');
  await ctx.closeServer();
  assert.equal(closes, 1);
});

for (const bootedByTask of [true, false]) test(`default simulator cleanup preserves ownership when the boot is ${bootedByTask ? 'new' : 'existing'}`, async () => {
  const calls = [], lease = { quit: async () => calls.push('quit') };
  const task = defaultSimulatorTask({
    existsSync: () => true,
    closeFixtures: async () => { calls.push('close'); throw new Error('retained close failed'); },
    execFileSync(command, args) {
      assert.equal(command, 'xcrun', 'no name-based viewer quit');
      calls.push(args[1]);
      assert.equal(args[2], 'fixture-device');
    },
  });
  await assert.rejects(async () => task.cleanup({ nonce: 'fixture', sim: { udid: 'fixture-device', bootedByTask },
    simPageOpened: true, windowLeases: [{ app: 'DeviceHub', ...lease }] }), /retained close failed/);
  assert.deepEqual(calls, bootedByTask ? ['terminate', 'close', 'shutdown', 'quit'] : ['close', 'quit']);
});

test('real Simulator cleanup shuts down an owned boot after window failure and preserves an existing boot', async () => {
  const source = readFileSync(new URL('../bench/tasks-real.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  for (const bootedByTask of [true, false]) {
    const calls = [];
    const cleanup = runInNewContext(`${source}\nrealTasks.find(task => task.id === 'simulator-flow').cleanup`, {
      webTasks: [], officeTasks: [], mailTasks: [], mimestreamTasks: [],
      closeFixtures: async () => { calls.push('close'); throw new Error('close failed'); },
      simctl: (action, udid) => { assert.equal(udid, 'owned-device'); calls.push(action); },
      quitSimApp: async () => calls.push('quit'), checkForm() {}, checkFlow() {}, checkPDF() {},
    });
    await assert.rejects(cleanup({ sim: { udid: 'owned-device', bootedByTask }, simPageOpened: true,
      closeServer: async () => calls.push('server') }), /close failed/);
    assert.deepEqual(calls, bootedByTask ? ['terminate', 'close', 'shutdown', 'quit', 'server'] : ['close', 'quit', 'server']);
  }
});

test('viewer ownership is checked after boot preparation and reported before the open call', () => {
  const source = readFileSync(new URL('../bench/tasks.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export \{.*;\n/gm, '').replace(/^export /gm, '');
  for (const probe of ['absent', 'owner', 'denied']) {
    const ownerOpensDuringBoot = probe === 'owner';
    let viewerRunning = false, reported, opens = 0;
    const boot = runInNewContext(`(() => { ${source}\nreturn bootedIPhone; })()`, {
      join, tmpdir: () => '/private/tmp', realpathSync: value => value, existsSync: () => true, realTasks: [], process: { env: {} },
      execFileSync(command, args) {
        if (command === 'xcrun') {
          if (args[1] === 'list') return JSON.stringify({ devices: { runtime: [{ name: 'iPhone fixture', state: 'Booted', udid: 'fixture' }] } });
          if (args[1] === 'bootstatus') viewerRunning = ownerOpensDuringBoot;
          return '';
        }
        if (command === '/usr/bin/pgrep') {
          if (probe === 'denied') throw Object.assign(new Error('inspection denied'), { code: 'EPERM', status: null });
          if (!viewerRunning) throw Object.assign(new Error('not running'), { status: 1 });
          return '';
        }
        assert.equal(command, 'open');
        opens++;
        assert.equal(reported, !ownerOpensDuringBoot, 'ownership callback must run immediately before opening the viewer');
        return '';
      },
    });
    const launch = () => boot({ trackOwnership: true, beforeViewerLaunch: owned => { reported = owned; } });
    if (probe === 'denied') {
      assert.throws(launch, /ownership unconfirmed/);
      assert.equal(reported, undefined);
      assert.equal(opens, 0);
      continue;
    }
    const result = launch();
    assert.equal(result.viewerLaunchedByTask, !ownerOpensDuringBoot);
  }
});

test('the simulator form passes only on the exact text, then closes its server', async () => {
  const url = await serveForm('abc123');
  const page = await (await fetch(url)).text();
  assert.match(page, /autocapitalize="off"/);
  await submit(url, 'Sleight bench abc123');
  assert.match(String(task.check({ nonce: 'abc123' })), /received \["Sleight bench abc123"\]/);
  await assert.rejects(fetch(url));

  const again = await serveForm('def456');
  await submit(again, 'sleight bench def456');
  assert.equal(task.check({ nonce: 'def456' }), true);
});
