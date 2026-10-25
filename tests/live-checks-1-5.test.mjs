import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, plan, runLiveChecks, OwnedTools, publishReport, CHECKS, waitForHold } from '../bench/live-checks-1-5.mjs';
import { runCheck, parseMetrics, wholeMetrics, gifInfo } from '../bench/live-checks-1-5-checks.mjs';
import { gifHeader, gifFrame } from '../plugins/sleight/lib/turn-recording.mjs';

test('arguments require a browser and reject ambiguous or unknown selections', () => {
  assert.deepEqual(parseArgs(['--browser', 'helium', '--checks', 'paste,points', '--dry-run']),
    { browser: 'helium', checks: ['paste', 'points'], dryRun: true, ownerAway: false });
  for (const args of [[], ['--browser', 'safari'], ['--browser', 'chrome', '--checks', 'typo'],
    ['--browser', 'chrome', '--checks', 'paste,paste'], ['--browser', 'chrome', '--checks', ''],
    ['--browser', 'chrome', '--browser', 'helium'], ['--browser', 'chrome', '--surprise']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('dry run lists all fourteen caps and has no runtime, hold, lock or publication effects', async () => {
  const options = parseArgs(['--browser', 'chrome', '--dry-run']);
  const forbidden = () => { throw Error('dry run side effect'); };
  const result = await runLiveChecks(options, { acquireLock: forbidden, waitHold: forbidden, createRuntime: forbidden, publish: forbidden });
  assert.equal(result.dryRun, true);
  assert.equal(result.checks.length, 14);
  assert.equal(result.checks.find(c => c.id === 'pdf').capMs, 300000);
  assert.ok(result.checks.every(c => c.capMs > 0 && c.expectedSeconds > 0));
  assert.equal(plan(options).profile, 'private copy of sleight benchmark');
  assert.equal(plan({ ...options, browser: 'helium' }).profile, 'fresh private Helium profile');
});

test('actual CLI dry plan runs with writes, lock/hold access, children and sockets forbidden', () => {
  for (const browser of ['chrome', 'helium']) {
    const child = spawnSync(process.execPath, ['--import', fileURLToPath(new URL('./fixtures/lc1-dry-guard.mjs', import.meta.url)),
      fileURLToPath(new URL('../bench/live-checks-1-5.mjs', import.meta.url)), '--browser', browser, '--dry-run'], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(child.stdout);
    assert.equal(report.browser, browser); assert.equal(report.checks.length, 14); assert.equal(report.lock, false);
  }
});

function harness(overrides = {}) {
  const events = [], published = [];
  return { events, published, deps: {
    acquireLock: async () => { events.push('lock'); return async () => events.push('unlock'); },
    waitHold: async () => { events.push('hold'); },
    versions: async () => ({ browserVersion: '145.0', engineVersion: { version: '26.10' } }),
    createRuntime: async ({ check, signal }) => {
      events.push('start:' + check.id);
      return { signal, close: async () => { events.push('close:' + check.id); return { cleanedUp: true }; } };
    },
    publish: async report => { published.push(structuredClone(report)); return '/result.json'; },
    ...overrides,
  } };
}
const live = { browser: 'helium', checks: ['one', 'two'], ownerAway: true, dryRun: false };
const definitions = [
  { id: 'one', capMs: 1000, run: async () => { throw Error('first check failed'); } },
  { id: 'two', capMs: 1000, run: async () => ({ count: 2 }) },
];

test('owner-away refusal precedes all effects', async () => {
  const h = harness();
  await assert.rejects(runLiveChecks({ ...live, ownerAway: false }, { ...h.deps, definitions }), /owner-away/);
  assert.deepEqual(h.events, []);
});

test('holds bracket lock and every check; failure is isolated and both runtimes clean before unlock', async () => {
  const h = harness();
  const result = await runLiveChecks(live, { ...h.deps, definitions });
  assert.deepEqual(result.checks.map(c => c.status), ['fail', 'pass']);
  assert.equal(result.checks[1].measured.count, 2);
  assert.deepEqual(h.events, ['hold', 'lock', 'hold', 'hold', 'start:one', 'close:one', 'hold', 'start:two', 'close:two', 'unlock']);
  assert.equal(result.browserVersion, '145.0');
  assert.equal(result.engineVersion.version, '26.10');
  assert.equal(result.lockReleased, true);
  assert.equal(h.published.at(-1).checks.length, 2);
  assert.ok(result.checks.every(c => typeof c.ms === 'number' && c.cleanup.cleanedUp));
});

test('timeout aborts the check and awaits cleanup before next check', async () => {
  const h = harness();
  const timeoutDefs = [
    { id: 'one', capMs: 10, run: runtime => new Promise(resolve => {
      runtime.signal.addEventListener('abort', () => { h.events.push('aborted'); resolve({ late: true }); });
    }) }, definitions[1],
  ];
  const result = await runLiveChecks(live, { ...h.deps, definitions: timeoutDefs });
  assert.equal(result.checks[0].status, 'fail');
  assert.match(result.checks[0].reason, /TIME_CAP/);
  assert.equal(result.checks[1].status, 'pass');
  assert.ok(h.events.indexOf('aborted') < h.events.indexOf('close:one'));
  assert.ok(h.events.indexOf('close:one') < h.events.indexOf('start:two'));
});

test('uncertain cleanup retains lock and marks remaining checks skipped', async () => {
  const h = harness({ createRuntime: async () => ({ close: async () => ({ cleanedUp: false }) }) });
  const result = await runLiveChecks(live, { ...h.deps, definitions });
  assert.equal(result.lockRetained, true);
  assert.equal(result.checks[1].status, 'skip');
  assert.match(result.checks[1].reason, /cleanup/i);
  assert.equal(h.events.includes('unlock'), false);
});

test('lock contention publishes a result for every selected check without connecting', async () => {
  const h = harness({ acquireLock: async () => { throw Error('Another live run'); } });
  const result = await runLiveChecks(live, { ...h.deps, definitions });
  assert.equal(result.checks.length, 2);
  assert.ok(result.checks.every(c => c.status === 'skip'));
  assert.equal(h.events.some(e => e.startsWith('start:')), false);
  assert.match(result.error, /Another live run/);
});

test('Helium inventory never grants ownership, even when owner tabs have matching fixture URLs', async () => {
  const calls = [];
  const raw = { async call(request) {
    calls.push(request);
    if (request.name === 'browser_open') return { text: 'tours http://127.0.0.1:5431/start\n', isError: false };
    if (request.arguments.do === 'list') return { text: 'towner http://127.0.0.1:5431/start\ntours owned', isError: false };
    return { text: 'closed', isError: false };
  }, delivered() { return true; } };
  const owned = new OwnedTools(raw, 'http://127.0.0.1:5431');
  await owned.call('browser_tabs', { do: 'list' });
  for (const name of ['browser_read', 'browser_act', 'browser_fill', 'browser_tabs']) {
    await assert.rejects(owned.call(name, { tab: 'towner', do: 'close', steps: [], fields: [] }), /not opened/);
  }
  await assert.rejects(owned.call('browser_open', { url: 'https://example.test' }), /fixture/);
  await assert.rejects(owned.call('browser_open', { url: 'http://127.0.0.1:5432/start' }), /fixture/);
  await owned.call('browser_open', { url: 'http://127.0.0.1:5431/start' });
  await owned.closeTabs();
  assert.deepEqual(calls.filter(c => c.arguments.tab).map(c => c.arguments.tab), ['tours']);
});

test('report publication preserves measured values, skips and failures and scrubs paths', async t => {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-lc1-report-')));
  const report = { schema: 1, browser: 'chrome', started: '2026-10-25T12:00:00.000Z',
    browserVersion: '145', engineVersion: { version: '26.10' }, checks: [
      { id: 'screenshot', status: 'pass', ms: 2, measured: { pixels: [1000, 750] } },
      { id: 'turn-stats', status: 'skip', reason: 'Claude Code mod required', measured: {} },
    ] };
  const path = await publishReport(report, { root, stamp: 'fixture' });
  assert.match(path, /2026-10-25-live-checks-1-5-chrome-fixture\.json$/);
  assert.deepEqual(JSON.parse(readFileSync(path)), report);
  await assert.rejects(publishReport(report, { root, stamp: 'fixture' }), /EEXIST/);
  assert.equal(CHECKS.length, 14);
});

test('fixture metrics and whole-thread grading reject missing data and incomplete reads', () => {
  assert.deepEqual(parseMetrics('text "Metrics width=800 height=600 dpr=2 dark=true reduced=false touch=1"'),
    { width: 800, height: 600, dpr: 2, dark: true, reduced: false, touch: 1 });
  assert.throws(() => parseMetrics('Metrics unavailable'));
  assert.deepEqual(wholeMetrics('Items read: 150 (top first). Seconds: 8.25. Clicks: 0.\nComplete: yes.'),
    { items: 150, seconds: 8.25, clicks: 0, complete: true });
  assert.equal(wholeMetrics('Items read: 12 (top first). Seconds: 1.00. Clicks: 2.\nComplete: NO. partial').complete, false);
});

test('GIF grader parses actual image blocks, dimensions and truncation', () => {
  const image = { width: 2, height: 2, data: Buffer.alloc(16, 255) };
  const limits = { width: 2, height: 2 };
  const bytes = Buffer.concat([gifHeader(2, 2), gifFrame(image, limits), gifFrame(image, limits), Buffer.from([0x3b])]);
  assert.deepEqual(gifInfo(bytes), { width: 2, height: 2, frames: 2, bytes: bytes.length });
  assert.throws(() => gifInfo(bytes.subarray(0, -2)), /GIF/);
  assert.throws(() => gifInfo(Buffer.from('not a gif')), /GIF/);
});

test('unsupported lifecycle checks return explicit skips without touching a runtime', async () => {
  const runtime = new Proxy({}, { get() { throw Error('must not touch runtime'); } });
  assert.match((await runCheck('turn-stats', runtime)).skipReason, /mod/);
  assert.match((await runCheck('watch-tick', runtime)).skipReason, /one-tick/);
});

test('developer check fails when logs are empty, even if the tool returned successfully', async () => {
  const runtime = { origin: 'http://127.0.0.1:5431', async call(name) {
    if (name === 'browser_open') return { text: 'tdev\nbutton "Log fixture" [ref=e1]' };
    if (name === 'browser_read') return { text: 'Console: 0 retained\nNetwork: 0 retained\nPerformance: milliseconds\nmetrics enabled: unavailable' };
    return { text: 'Clicked' };
  } };
  await assert.rejects(runCheck('developer-reads', runtime), /console|network|performance/i);
});

test('hold waits until removed and cancellation stops the wait without removing the marker', async () => {
  let reads = 0, sleeps = 0;
  await waitForHold({ exists: () => ++reads < 4, pause: async () => { sleeps++; } });
  assert.equal(sleeps, 3);
  const controller = new AbortController();
  await assert.rejects(waitForHold({ signal: controller.signal, exists: () => true,
    pause: async () => { controller.abort(Error('operator stop')); } }), /operator stop/);
});

test('known skips never construct a runtime or open a browser', async () => {
  const h = harness({ createRuntime: () => { throw Error('unnecessary browser setup'); } });
  const result = await runLiveChecks({ ...live, checks: ['watch-tick', 'turn-stats'] }, h.deps);
  assert.deepEqual(result.checks.map(c => c.status), ['skip', 'skip']);
  assert.ok(result.checks.every(c => c.reason.length > 20));
});

test('non-snapshot delivery acknowledgment is advisory and owned tabs still close', async () => {
  const calls = [];
  const client = { async call({ name, arguments: args }) { calls.push([name, args]);
    return { text: name === 'browser_open' ? 'tfixture opened' : 'done', isError: false }; }, delivered: () => false };
  const owned = new OwnedTools(client, 'http://127.0.0.1:5431');
  await owned.call('browser_open', { url: 'http://127.0.0.1:5431/start' });
  await owned.call('browser_read', { tab: 'tfixture', console: true });
  await owned.closeTabs();
  assert.equal(owned.tabs.size, 0);
  assert.equal(calls.at(-1)[1].tab, 'tfixture');
});

test('mailto check records the notification and refuses an unobserved or changed frontmost app', async () => {
  const app = { bundleId: 'test.editor', pid: 42 };
  let calls = 0;
  const make = after => ({ origin: 'http://127.0.0.1:5431', frontmost: async () => ++calls === 1 ? app : after,
    call: async name => ({ text: name === 'browser_open' ? 'tmail\nlink "Open fixture mail link" [ref=e1]'
      : 'Native navigation attempted; cancellation requested. Native UI outcome unconfirmed;' }) });
  const measured = await runCheck('mailto-detach', make(app));
  assert.equal(measured.noMailAppObserved, true);
  assert.match(measured.limitation, /background launch/);
  calls = 0;
  await assert.rejects(runCheck('mailto-detach', make({ bundleId: 'test.mail', pid: 43 })), /Frontmost application changed/);
  let acted = false;
  const skip = await runCheck('mailto-detach', { frontmost: async () => ({ pid: null }), call: async () => { acted = true; } });
  assert.match(skip.skipReason, /no mailto action/); assert.equal(acted, false);
});

test('paste grade compares clipboard bytes after verifying textarea and TSV effects', async () => {
  for (const restored of [true, false]) {
    const state = {}; let reads = 0;
    const runtime = { origin: 'http://127.0.0.1:5431', fixtures: { state: () => state },
      clipboard: async () => Buffer.from(++reads === 1 || restored ? 'original' : 'changed'),
      call: async (name, args) => {
        if (name === 'browser_act') {
          if (args.steps[0].text === 'LC1 note') state.note = 'LC1 note'; else state.grid = [['Oak', '1'], ['Pine', '2']];
          return { text: 'paste sent: clipboard restored' };
        }
        return { text: 'tpaste\ntextbox "Note" [ref=e1]\ngridcell "Paste grid" [ref=e2]' };
      } };
    if (restored) assert.equal((await runCheck('paste', runtime)).clipboardRestored, true);
    else await assert.rejects(runCheck('paste', runtime), /Clipboard text was not restored/);
  }
});

test('a turn that ran two actions but has no saved GIF fails instead of claiming recording', async () => {
  const calls = [];
  const runtime = { origin: 'http://127.0.0.1:5431', finishTurn: async () => ({ recording: 'Recording: no frames saved.' }),
    call: async (name, args) => { calls.push({ name, args });
      return { text: 'trecord\ntextbox "Name" [ref=e1]\nbutton "First action" [ref=e2]\nbutton "Second action" [ref=e3]' }; } };
  await assert.rejects(runCheck('turn-gif', runtime), /no GIF path or frames/);
  assert.equal(calls.filter(c => c.name === 'browser_act').length, 2);
  assert.equal(calls.find(c => c.name === 'browser_fill').args.fields[0].value, 'LC1');
});

test('PDF and download checks reject successful tool replies without extraction or a completed receipt', async () => {
  const runtime = { origin: 'http://127.0.0.1:5431', call: async () => ({ text: 'tfile\nlink "Download fixture PDF" [ref=e1]' }) };
  await assert.rejects(runCheck('pdf', runtime), /did not extract/);
  await assert.rejects(runCheck('download', runtime), /No completed download receipt/);
});

test('page text naming cookies alone never counts as an Accept refusal', async () => {
  const runtime = { origin: 'http://127.0.0.1:5431', call: async () => ({ text: 'tcookie\nbutton "Accept all cookies" [ref=e1]\nbutton "Reject all" [ref=e2]' }) };
  await assert.rejects(runCheck('cookie-wall', runtime), /Expected a named safety refusal/);
});

for (const id of ['screenshot', 'motion-frames', 'points', 'viewport', 'developer-reads', 'whole-thread', 'cookie-wall']) {
  test('runner grades production turbo calls against headless fixture: ' + id,
    { skip: process.env.SLEIGHT_LIVE_DOM_TEST !== '1' && 'opt-in headless fixture check', timeout: 90000 }, async t => {
      const { fixture, skip } = await import('./fixtures/fd1-filtered-real.mjs');
      if (skip) { t.skip(skip); return; }
      const { serveFixtures } = await import('../bench/live-checks-1-5-fixtures.mjs');
      const { createV3TurnBinding } = await import('../plugins/sleight/lib/direct-browser/v3-context.mjs');
      const { createV3TurnRuntime } = await import('../plugins/sleight/lib/direct-browser/worker.mjs');
      const { snapshot, acknowledgeSnapshot } = await import('../plugins/sleight/lib/direct-browser/snapshot.mjs');
      const { benchUi } = await import('../bench/turbo/v3-worker.mjs');
      const f = await fixture(t, '<p>Unrelated headless sentinel</p>');
      const server = await serveFixtures(); t.after(() => server.close());
      const previous = process.env.SLEIGHT_POINT_INPUT;
      if (id === 'points') process.env.SLEIGHT_POINT_INPUT = '1';
      t.after(() => { if (previous === undefined) delete process.env.SLEIGHT_POINT_INPUT; else process.env.SLEIGHT_POINT_INPUT = previous; });
      const binding = createV3TurnBinding({ source: 'user', session: 'lc1-test', turn: id, id: 'user',
        text: id === 'motion-frames' ? 'Inspect animation on the hover fixture.' : 'Test viewport, media and touch on the public local fixture.' }, () => true);
      const raw = await createV3TurnRuntime({ binding, browser: 'bfixture', pages: f.registry, snapshot, ui: benchUi,
        dependencies: { acknowledgeSnapshot } });
      t.after(() => raw.end());
      const tools = new OwnedTools(raw, server.origin);
      const measured = await runCheck(id, { origin: server.origin, fixtures: server, pointInput: id === 'points',
        call: (...args) => tools.call(...args) });
      assert.equal(measured.skipReason, undefined);
      if (id === 'screenshot') { assert.equal(measured.protectedPixels, 0); assert.ok(measured.pixels.width > 0); }
      if (id === 'motion-frames') assert.equal(measured.frames, 3);
      if (id === 'points') assert.deepEqual([measured.plainClicks, measured.payClicks], [1, 0]);
      if (id === 'viewport') assert.deepEqual(measured.after, measured.before);
      if (id === 'developer-reads') assert.ok(measured.consoleEvents > 0 && measured.networkRequests > 0);
      if (id === 'whole-thread') assert.deepEqual([measured.items, measured.complete], [120, true]);
      if (id === 'cookie-wall') assert.deepEqual([measured.acceptRefused, measured.rejected], [true, true]);
      await tools.closeTabs();
      assert.equal((await raw.end()).cleanup.length, 0);
    });
}
