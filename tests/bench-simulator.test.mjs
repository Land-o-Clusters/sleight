import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveForm, tasks } from '../bench/tasks.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const task = tasks.find(t => t.id === 'simulator-form');
const submit = (url, message) => fetch(url, { method: 'POST', body: new URLSearchParams({ message }) });

test('real Simulator cleanup shuts down an owned boot after window failure and preserves an existing boot', async () => {
  const source = readFileSync(new URL('../bench/tasks-real.mjs', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  for (const bootedByTask of [true, false]) {
    const calls = [];
    const cleanup = runInNewContext(`${source}\nrealTasks.find(task => task.id === 'simulator-flow').cleanup`, {
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
