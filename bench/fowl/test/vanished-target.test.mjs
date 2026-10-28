import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { registerTemp, trackTemp } from '../../../scripts/temp-leftovers.mjs';
import { realBrowserCommands, resetRealBrowser } from '../real-browser.mjs';
import { runRealGate } from '../real-gate.mjs';

// The transport alone is fake. Pending-call dispatch, reset, round persistence and grading are real.
function transport(t, { late = false, message = 'No target with given id found', stays = false, activationMissing = false } = {}) {
  const dir = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-br1-target-'))));
  writeFileSync(join(dir, 'DevToolsActivePort'), '12345\n/devtools/browser/fixture\n');
  let pages = [], marker = 0, rejected = 0;
  class Socket extends EventTarget {
    readyState = 1;
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(text) {
      const { id, method, params } = JSON.parse(text);
      let result = {}, error;
      if (method === 'Target.getTargets') result = { targetInfos: [...pages] };
      else if (method === 'Target.createTarget') {
        const targetId = 'marker-' + ++marker;
        pages.push({ targetId, type: 'page', title: 'Sleight Gate fixture', url: params.url });
        if (late) pages.push({ targetId: 'vanished', type: 'page', title: 'old', url: 'https://example.test' });
        result = { targetId };
      } else if (method === 'Target.closeTarget') {
        if (params.targetId === 'vanished') {
          rejected++;
          error = { code: -32602, message };
        }
        if (!stays || params.targetId !== 'vanished') pages = pages.filter(page => page.targetId !== params.targetId);
        result = { success: true };
      } else {
        assert.equal(method, 'Target.activateTarget');
        if (activationMissing) error = { code: -32602, message: 'No target with given id found' };
      }
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, ...(error ? { error } : { result }) }) })));
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  return { dir, connect: browser => realBrowserCommands({ ...browser, profileRoot: dir }, { Socket, validate() {} }),
    agentPage() { pages = [{ targetId: 'vanished', type: 'page', title: 'task', url: 'https://example.test' }]; },
    rejected: () => rejected };
}

for (const late of [false, true]) test(`vanished ${late ? 'late' : 'snapshot'} target reply preserves pass and failure grades through a whole round`, async t => {
  const priorExitCode = process.exitCode;
  t.after(() => { process.exitCode = priorExitCode; });
  const wire = transport(t, { late }), out = join(wire.dir, 'out'), lockPath = join(wire.dir, 'lock');
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));
  const tasks = ['product-failure', 'product-pass', 'next-task'].map(name => ({ name, browser: 'chrome', prompt: 'Fixture in {browser}', result: 'done' }));
  let stopped = 0;
  const rows = await runRealGate({ args: { surface: 'sleight-turbo', 'real-browser': 'chrome', out }, tasks,
    runner: { gradeOutcome: () => ({ problems: [] }), gradeSite: () => ({ problems: [] }) },
    runtime: {
      lockPath, admit: async () => {}, commits: () => ({}), readEngine: () => ({}),
      checkOwner: async () => ({ ok: true }), startSites: async () => ({ close: async () => {} }),
      launchBrowser: async plan => ({ ...plan, marker: 'Sleight Gate fixture', pid: 1234,
        stop: async () => { stopped++; return { browserClosed: true, profileDeleted: true }; } }),
      startMonitor: async () => ({ log: [], stop: async () => {} }), startAllow: async () => null,
      watchBrowser: async () => ({ urls: () => [], close: async () => {} }),
      resetBrowser: browser => resetRealBrowser(browser, { connect: wire.connect }),
      observeBrowser: async () => ({ 'chrome:vanished': { title: 'task', url: 'https://example.test' } }),
      runAgent: async arm => {
        mkdirSync(arm.dir); wire.agentPage();
        return { groupClean: true, exitCode: 0, started: 1, finished: 2,
          result: { result: 'RESULT: done', is_error: arm.task.name === 'product-failure' } };
      },
    },
  });
  await nextTurn();
  assert.deepEqual(unhandled, []);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.outcome), [
    { ok: false, cell: 'FAIL: agent did not finish successfully', problems: ['agent did not finish successfully'] },
    { ok: true, cell: 'ok', problems: [] }, { ok: true, cell: 'ok', problems: [] },
  ]);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'results.json'))).map(row => row.outcome.ok), [false, true, true]);
  assert.ok(wire.rejected() >= 2);
  assert.equal(stopped, 1);
  assert.equal(existsSync(lockPath), false);
  assert.equal(existsSync(join(out, 'harness-failure.json')), false);
  assert.equal(process.exitCode, 1, 'the product failure still fails the round');
});

test('reset propagates unrelated CDP failures', async t => {
  const wire = transport(t, { message: 'Not allowed' }); wire.agentPage();
  await assert.rejects(resetRealBrowser({ browser: 'chrome', marker: 'Sleight Gate fixture', args: ['about:blank'] },
    { connect: wire.connect }), /Not allowed/);
});

test('reset refuses a vanished fresh marker instead of treating activation as a successful close', async t => {
  const wire = transport(t, { activationMissing: true });
  await assert.rejects(resetRealBrowser({ browser: 'chrome', marker: 'Sleight Gate fixture', args: ['about:blank'] },
    { connect: wire.connect }), /No target with given id found/);
});

test('a missing-target reply cannot certify reset while the old page remains listed', async t => {
  const wire = transport(t, { stays: true }); wire.agentPage();
  await assert.rejects(resetRealBrowser({ browser: 'chrome', marker: 'Sleight Gate fixture', args: ['about:blank'] },
    { connect: wire.connect, timeoutMs: 30 }), /BENCH_BROWSER_RESET_FAILED/);
});
