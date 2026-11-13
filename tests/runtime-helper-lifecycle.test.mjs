import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as probe from '../bench/runtime-probe-live.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

test('helper lifecycle dry run lists 20 cold pings, 20 cold clicks and one RSS read without host access', () => {
  const result = spawnSync(process.execPath, ['--import', './tests/fixtures/runtime-probe-cli-guard.mjs',
    'bench/runtime-probe-live.mjs', '--helper-lifecycle', '--dry-run'], {
    encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL',
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.plan.map(cell => [cell.metric, cell.trials]),
    [['spawnToPing', 20], ['readToFirstClick', 20], ['idleRss', 1]]);
  assert.equal(report.totalTrials, 41);
  assert.equal(report.plan[1].p50BarMs, undefined);
  assert.deepEqual(report.plan[1].reference, { metric: 'spawnToFirstClickWithInProcessRead', p50Ms: 111 });
});

function measurement(metric, fail, verificationMs = 0) {
  let clock = 0, closes = 0, checks = 0;
  const calls = [];
  const host = { status: 'ready', build: 'b'.repeat(64), binary: '/fixture/helper', spawn() {
    calls.push('spawn'); clock += 7; return { pid: 123, stdout: new EventEmitter() };
  } };
  return { calls, get closes() { return closes; }, get checks() { return checks; },
    run: () => probe.measureHelperLifecycleCell({ metric }, {
      now: () => clock, check() { checks++; },
      async prepare() { calls.push('prepare'); clock += 10000; return host; },
      createClient({ prepare }) {
        const start = async () => {
          const child = (await prepare()).spawn(); clock += 23; calls.push('ping'); child.stdout.emit('data', Buffer.from('{}\n'));
        };
        return {
        async ping() { await start(); clock += 5; return { build: host.build }; },
        getApp: start,
        async close() { closes++; },
      }; },
      async readFixture(client) { await client.getApp(); calls.push('read'); clock += 50; if (fail) throw Error('READ_FAILED'); },
      async clickFixture() { calls.push('click'); clock += 31; if (fail) throw Error('CLICK_FAILED'); const clickedAt = clock; clock += verificationMs; return { clickedAt, correct: true }; },
      async rss(pid) { assert.equal(pid, 123); calls.push('rss'); return { rssBytes: 32 * 1024 * 1024, pid, started: '1.2', path: host.binary }; },
    }) };
}
test('spawn-to-ping excludes 10 seconds of preparation and includes spawn plus handshake', async () => {
  const f = measurement('spawnToPing');
  const result = await f.run();
  assert.equal(result.prepareMs, 10000); assert.equal(result.elapsedMs, 30);
  assert.deepEqual(f.calls, ['prepare', 'spawn', 'ping']); assert.equal(f.closes, 1);
});
test('first-click timing separates the acquisition read from the click reply', async () => {
  const f = measurement('readToFirstClick');
  const result = await f.run();
  assert.equal(result.elapsedMs, 31); assert.equal(result.acquireReadMs, 80); assert.equal(result.spawnToFirstClickMs, 111); assert.equal(result.correct, true);
  assert.deepEqual(f.calls, ['prepare', 'spawn', 'ping', 'read', 'click']); assert.equal(f.closes, 1);
});
test('idle RSS follows exactly one TextEdit read and carries process identity', async () => {
  const f = measurement('idleRss'); const result = await f.run();
  assert.equal(result.rssBytes, 33554432); assert.equal(result.started, '1.2');
  assert.deepEqual(f.calls, ['prepare', 'spawn', 'ping', 'read', 'rss']); assert.equal(f.closes, 1);
});
for (const metric of ['idleRss', 'readToFirstClick']) test(`${metric} failure still collects the owned helper`, async () => {
  const f = measurement(metric, true);
  await assert.rejects(f.run(), /READ_FAILED/); assert.equal(f.closes, 1);
});
test('lifecycle summary uses nearest-rank p50 and p90 and retains missing measurements', () => {
  const summary = probe.helperLifecycleSummary(Array.from({ length: 20 }, (_, i) => ({ elapsedMs: i + 1 })));
  assert.deepEqual(summary, { count: 20, p50Ms: 10, p90Ms: 18 });
  assert.deepEqual(probe.helperLifecycleSummary([]), { count: 0, p50Ms: null, p90Ms: null });
});

async function sitting(t, { failAt, cleanup = true, ownerAway = true, held = false } = {}) {
  const bank = registerTemp(t, trackTemp(mkdtempSync(join(realpathSync(tmpdir()), 'sleight-helper-cells-'))));
  const events = []; let attempt = 0;
  const report = await probe.runHelperLifecycleProbe({ ownerAway, out: join(bank, 'report') }, {
    platform: 'darwin', held: () => held,
    takeLock: async () => { events.push('lock'); return () => { events.push('unlock'); }; },
    publish: (_stem, report) => events.push(['publish', report]),
    backend: {
      async metadata() { return { runtime: 'own', sleightDirty: false }; }, async inventory() { return []; },
      async prepare(cell) { events.push(['prepare', cell.metric]); return cell; },
      async measureHelperLifecycle(cell) {
        if (++attempt === failAt) throw Error('MEASUREMENT_FAILED');
        return cell.metric === 'idleRss' ? { rssBytes: 33554432 } : { elapsedMs: attempt, correct: true };
      },
      async closeFixture(cell) { events.push(['fixture-close', cell.metric]); return { confirmed: cleanup }; },
      async close() { events.push('close'); return { confirmed: cleanup }; },
    },
  });
  return { report, events };
}
test('measurement sitting owns two app fixtures, collects 41 samples and releases its lock after cleanup', async t => {
  const { report, events } = await sitting(t);
  assert.equal(report.complete, true); assert.equal(report.cleanupConfirmed, true);
  assert.deepEqual(report.cells.map(row => row.measurements.length), [20, 20, 1]);
  assert.deepEqual(events.filter(e => Array.isArray(e) && e[0] === 'prepare').map(e => e[1]), ['readToFirstClick', 'idleRss']);
  assert.deepEqual(events.slice(-3).map(e => Array.isArray(e) ? e[0] : e), ['close', 'unlock', 'publish']);
});
test('measurement failures publish all partial samples without retrying an action', async t => {
  const { report, events } = await sitting(t, { failAt: 22 });
  assert.equal(report.complete, false); assert.equal(report.error, 'MEASUREMENT_FAILED');
  assert.deepEqual(report.cells.map(row => row.measurements.length), [20, 1]);
  assert.equal(report.cleanupConfirmed, true); assert.ok(events.includes('unlock'));
});
test('uncertain cleanup preserves the cooperative lock and reports a failed sitting', async t => {
  const { report, events } = await sitting(t, { cleanup: false });
  assert.equal(report.complete, false); assert.equal(report.cleanupConfirmed, false); assert.equal(events.includes('unlock'), false);
});
test('lifecycle live execution requires owner away and an open hold boundary', async t => {
  await assert.rejects(sitting(t, { ownerAway: false }), /OWNER_AWAY_REQUIRED/);
  await assert.rejects(sitting(t, { held: true }), /HOLD/);
});

test('first-click correctness reads Calculator\'s described display and ignores the previous expression', () => {
  const recorded = JSON.parse(readFileSync(new URL('./fixtures/rt11d-calculator-display.json', import.meta.url), 'utf8')).delivered;
  const correct = recorded.replace('Description: Edit field, Value: 3978', 'Description: Edit field, Value: 7');
  assert.equal(probe.helperLifecycleClickCorrect(correct), true);
  assert.equal(probe.helperLifecycleClickCorrect(recorded.replace('Value: 78 × 51', 'Value: 7')), false);
  for (const text of ['7 text 7', '7 text, Value: 7', '7 text field (focused, settable) Value: 7'])
    assert.equal(probe.helperLifecycleClickCorrect(text), true, text);
  for (const value of ['0', '77', '7.5', '7 ×'])
    assert.equal(probe.helperLifecycleClickCorrect(correct.replace('Edit field, Value: 7', 'Edit field, Value: ' + value)), false, value);
});

test('post-read click timing ends at the action reply before verification', async () => {
  const result = await measurement('readToFirstClick', false, 2000).run();
  assert.equal(result.elapsedMs, 31); assert.equal(result.spawnToFirstClickMs, 111);
});
