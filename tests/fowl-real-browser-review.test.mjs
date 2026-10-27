import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import * as real from '../bench/fowl/real-browser.mjs';
import { gradeGateTask } from '../bench/fowl/real-gate-grade.mjs';
import { runGateAgent, runRealGate } from '../bench/fowl/real-gate.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cache = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser');
const task = { name: 'fixture', browser: 'chrome', prompt: 'Fixture in {browser}', result: 'done' };
const temporary = t => registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-br1f-')));

for (const browser of ['chrome', 'helium']) test(`${browser} owner check uses executable identity, not profile or bundle name`, async () => {
  const plan = real.realBrowserPlan({ browser, round: 'owner-check' });
  assert.equal(typeof real.checkBrowserOwner, 'function', 'owner process gate is missing');
  const processes = [{ pid: 100, executable: plan.executable },
    { pid: 101, executable: plan.executable + ' Helper' }];
  await assert.rejects(real.checkBrowserOwner(plan, { listProcesses: async () => processes }), error => {
    assert.match(error.message, /quit/i);
    assert.deepEqual(error.ownerCheck.otherPids, [100]);
    assert.equal(error.ownerCheck.ok, false);
    return true;
  });
  const check = await real.checkBrowserOwner(plan, { listProcesses: async () => processes.slice(1) });
  assert.equal(check.ok, true);
  assert.deepEqual(check.otherPids, []);
  assert.equal(check.executable, plan.executable);
  await assert.rejects(real.checkBrowserOwner(plan, { listProcesses: async () => { throw Error('census failed'); } }), /census failed/);
  await assert.rejects(real.checkBrowserOwner(plan, { listProcesses: async () => [{ pid: 'unknown', executable: plan.executable }] }), /PROCESS_LIST/);
});

test('owner census refusal happens before spawning or creating a profile', async () => {
  const plan = real.realBrowserPlan({ browser: 'chrome', round: 'test-' + randomUUID() });
  let spawned = false;
  await assert.rejects(real.launchRealBrowser(plan, {
    listProcesses: async () => [{ pid: 100, executable: plan.executable }],
    spawnBrowser: () => { spawned = true; throw Error('spawn must not happen'); },
  }), /quit/i);
  assert.equal(spawned, false);
  assert.equal(existsSync(plan.profileRoot), false);
});

test('a launch failure still carries the completed owner census for browser.json', async () => {
  const plan = real.realBrowserPlan({ browser: 'chrome', round: 'test-' + randomUUID() });
  await assert.rejects(real.launchRealBrowser(plan, { listProcesses: async () => [],
    spawnBrowser: () => { throw Error('fixture spawn failed'); },
  }), error => {
    assert.match(error.message, /spawn failed/);
    assert.equal(error.ownerCheck?.ok, true);
    return true;
  });
  assert.equal(existsSync(plan.profileRoot), false);
});

test('real browser launch disables keychain access and records the successful owner check', async t => {
  for (const browser of ['chrome', 'helium']) {
    const plan = real.realBrowserPlan({ browser, round: 'test-' + randomUUID() });
    assert.ok(plan.args.includes('--use-mock-keychain'));
    assert.ok(plan.args.includes('--password-store=basic'));
    const child = new EventEmitter(); child.pid = 1234;
    child.kill = () => { setImmediate(() => child.emit('close', 0)); };
    t.after(() => rmSync(join(plan.profileRoot, '..'), { recursive: true, force: true }));
    const launched = await real.launchRealBrowser(plan, { listProcesses: async () => [], spawnBrowser: () => {
      writeFileSync(join(plan.profileRoot, 'DevToolsActivePort'), '12345\n/devtools/browser/fixture\n'); return child;
    } });
    assert.equal(launched.ownerCheck.ok, true);
    await launched.stop();
  }
});

test('each reset creates a fresh marker before closing every previous page in the owned connection', async () => {
  assert.equal(typeof real.resetRealBrowser, 'function', 'per-task reset is missing');
  const browser = real.realBrowserPlan({ browser: 'chrome', round: 'reset' });
  let serial = 0, pages = [{ targetId: 'old-a', type: 'page', url: 'https://example.test' },
    { targetId: 'old-b', type: 'page', url: 'about:blank' }, { targetId: 'worker', type: 'service_worker' }];
  const events = [];
  const connect = async owned => {
    assert.equal(owned, browser);
    return { close: async () => { events.push('disconnect'); }, send: async (method, params) => {
      events.push(method);
      if (method === 'Target.getTargets') return { targetInfos: pages };
      if (method === 'Target.createTarget') {
        assert.equal(params.url, browser.args.at(-1));
        const targetId = 'marker-' + ++serial;
        pages = [...pages, { targetId, type: 'page', title: browser.marker, url: params.url }];
        return { targetId };
      }
      if (method === 'Target.closeTarget') {
        assert.notEqual(params.targetId, 'worker');
        assert.ok(pages.some(page => page.targetId === 'marker-' + serial));
        pages = pages.filter(page => page.targetId !== params.targetId); return { success: true };
      }
      if (method === 'Target.activateTarget') { assert.equal(params.targetId, 'marker-' + serial); return {}; }
      assert.fail(method);
    } };
  };
  for (let i = 1; i <= 2; i++) {
    const start = await real.resetRealBrowser(browser, { connect });
    assert.deepEqual(Object.keys(start), ['chrome:marker-' + i]);
    assert.equal(start['chrome:marker-' + i].title, browser.marker);
  }
  assert.equal(events.filter(event => event === 'disconnect').length, 2);
});

test('reset refuses an unclosed previous tab and disconnects on errors', async () => {
  assert.equal(typeof real.resetRealBrowser, 'function');
  let closed = false;
  const browser = real.realBrowserPlan({ browser: 'helium', round: 'reset-fail' });
  await assert.rejects(real.resetRealBrowser(browser, { connect: async () => ({
    close: async () => { closed = true; }, send: async method => {
      if (method === 'Target.createTarget') return { targetId: 'new' };
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'old', type: 'page' }] };
      if (method === 'Target.closeTarget') return { success: false };
      assert.fail(method);
    },
  }) }), /RESET/);
  assert.equal(closed, true);
});

test('reset refuses a missing fresh target before closing any old page', async () => {
  const browser = real.realBrowserPlan({ browser: 'chrome', round: 'reset-no-target' });
  let closed = false;
  await assert.rejects(real.resetRealBrowser(browser, { connect: async () => ({
    close: async () => { closed = true; }, send: async method => {
      if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'old', type: 'page' }] };
      if (method === 'Target.createTarget') return {};
      assert.fail('must not close an old tab without a fresh target');
    },
  }) }), /RESET/);
  assert.equal(closed, true);
});

test('debugging commands use only the exact profile endpoint, correlate replies and disconnect', async t => {
  assert.equal(typeof real.realBrowserCommands, 'function');
  const dir = temporary(t), browser = { profileRoot: dir };
  writeFileSync(join(dir, 'DevToolsActivePort'), '12345\n/devtools/browser/owned\n');
  const calls = [];
  class Socket extends EventTarget {
    readyState = 0;
    constructor(endpoint) {
      super(); calls.push(endpoint);
      queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
    }
    send(text) {
      const frame = JSON.parse(text); calls.push(frame);
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: frame.id,
        ...(frame.method === 'Fail' ? { error: { message: 'protocol refused' } } : { result: { targetInfos: [] } }) }) })));
    }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const connection = await real.realBrowserCommands(browser, { Socket, validate: value => assert.equal(value, browser) });
  assert.deepEqual(await connection.send('Target.getTargets'), { targetInfos: [] });
  await assert.rejects(connection.send('Fail'), /protocol refused/);
  await connection.close();
  await assert.rejects(connection.send('Target.getTargets'), /CLOSED/);
  assert.equal(calls[0], 'ws://127.0.0.1:12345/devtools/browser/owned');
  assert.deepEqual(calls.slice(1).map(frame => frame.id), [1, 2]);
  await assert.rejects(real.realBrowserCommands(browser, { Socket, validate: () => { throw Error('wrong owner'); } }), /wrong owner/);
  writeFileSync(join(dir, 'DevToolsActivePort'), '0\nws://remote.example\n');
  await assert.rejects(real.realBrowserCommands(browser, { Socket, validate() {} }), /ENDPOINT_INVALID/);
});

test('debugging command deadlines reject without launching any real socket', async t => {
  const dir = temporary(t); writeFileSync(join(dir, 'DevToolsActivePort'), '12345\n/devtools/browser/owned\n');
  class Socket extends EventTarget {
    readyState = 1;
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send() {}
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const connection = await real.realBrowserCommands({ profileRoot: dir }, { Socket, validate() {}, timeoutMs: 1 });
  await assert.rejects(connection.send('Target.getTargets'), /COMMAND_TIMEOUT/);
  await connection.close();
});

test('post-agent inventory includes the actual open pages and always disconnects', async () => {
  const browser = { browser: 'helium' };
  let closed = false;
  assert.deepEqual(await real.observeRealBrowser(browser, { connect: async value => {
    assert.equal(value, browser);
    return { close: async () => { closed = true; }, send: async method => {
      assert.equal(method, 'Target.getTargets');
      return { targetInfos: [{ targetId: 'page', type: 'page', title: 'Sign in', url: 'https://example.test/signin' },
        { targetId: 'worker', type: 'worker' }] };
    } };
  } }), { 'helium:page': { title: 'Sign in', url: 'https://example.test/signin' } });
  assert.equal(closed, true);
});

test('outcome grading gets the observed tabs, baseline and control predicate', () => {
  const after = { 'chrome:task': { url: 'https://example.test', title: 'Task' } };
  const startKeys = new Set(['chrome:marker']), journal = [];
  const controlled = () => false;
  gradeGateTask({ task, run: { exitCode: 0, result: { result: 'RESULT: done' }, tabs: new Set(Object.keys(after)), afterExit: after },
    after, startKeys, journal, controlled, runner: {
      gradeOutcome: input => {
        assert.equal(input.observed, true);
        assert.equal(input.after, after); assert.equal(input.startKeys, startKeys);
        assert.equal(input.journal, journal); assert.equal(input.controlled, controlled);
        return { problems: [] };
      }, gradeSite: () => ({ problems: [] }),
    } });
});

test('upstream handoff grader requires a page left open and no further sign-in actions for every real arm', async t => {
  if (!existsSync(join(cache, '.git'))) return t.skip('pinned FowlBrowser cache is absent');
  const dir = temporary(t); mkdirSync(join(dir, 'tools'));
  const original = spawnSync('/usr/bin/git', ['-C', cache, 'show', '6a12d60:tools/rounds.mjs'], { encoding: 'utf8' });
  assert.equal(original.status, 0, original.stderr);
  writeFileSync(join(dir, 'tools/rounds.mjs'), original.stdout);
  const applied = spawnSync('/usr/bin/git', ['apply', join(root, 'bench/fowl/sleight-surface.patch')], { cwd: dir, encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  const runner = await import(pathToFileURL(join(dir, 'tools/rounds.mjs')));
  const handoff = { ...task, name: 'handoff', expect: ['Fjord'], handoff: { url: '/checkout/signin' } };
  const after = { 'chrome:task': { url: 'http://127.0.0.1:5420/t/handoff/shop/checkout/signin' } };
  for (const surface of ['sleight-turbo', 'lcu', 'cua', 'peekaboo', 'codex']) {
    const input = { task: handoff, surface, runner, after, startKeys: new Set(), journal: [], controlled: () => false,
      run: { exitCode: 0, result: { result: 'RESULT: Fjord; left at sign-in for you.' }, tabs: new Set(Object.keys(after)) }, site: { lines: [] } };
    assert.equal(gradeGateTask(input).ok, true, surface);
    assert.equal(gradeGateTask({ ...input, after: {} }).ok, false, 'closed handoff must fail: ' + surface);
    assert.equal(gradeGateTask({ ...input, site: { lines: ['input /shop/checkout/signin email'] } }).ok, false);
    assert.equal(gradeGateTask({ ...input, run: { ...input.run, result: { result: 'RESULT: Harbor' } } }).ok, false);
  }
});

function lifecycle(t, { surface = 'codex', runAgent, launchBrowser, checkOwner } = {}) {
  const dir = temporary(t), events = [], lockPath = join(dir, 'lock');
  const marker = { 'chrome:marker': { title: 'marker', url: 'data:text/html,marker' } };
  const after = { 'chrome:task': { title: 'task', url: 'https://example.test' } };
  const promise = runRealGate({ args: { surface, 'real-browser': 'chrome', out: join(dir, 'out') }, tasks: [task, { ...task, name: 'fixture-two' }],
    runner: { gradeOutcome: input => { assert.equal(input.observed, true); assert.equal(input.after, after);
      assert.deepEqual([...input.startKeys], Object.keys(marker)); return { problems: [] }; }, gradeSite: () => ({ problems: [] }) },
    runtime: { lockPath, admit: async () => {},
      checkOwner: checkOwner || (async () => ({ ok: true })),
      startSites: async () => ({ close: async () => { events.push('sites closed'); } }),
      launchBrowser: launchBrowser || (async plan => ({ ...plan, pid: 1234, ownerCheck: { ok: true, otherPids: [] }, stop: async () => {
        events.push('browser closed'); return { browserClosed: true, profileDeleted: true };
      } })),
      startMonitor: async () => ({ log: [{ kind: 'host-ready', t: 0, app: true, space: true, window: true },
        { kind: 'host-stopped', t: 3, exitCode: 0 }], stop: async () => {} }),
      resetBrowser: async () => { events.push('reset'); return marker; },
      observeBrowser: async () => { events.push('observe'); return after; },
      runAgent: async arm => { events.push('agent'); mkdirSync(arm.dir);
        if (runAgent) return runAgent(arm);
        return { groupClean: true, exitCode: 0, started: 1, finished: 2, result: { result: 'RESULT: done' } };
      },
    } });
  return { dir, events, lockPath, promise };
}

for (const servers of [null, ['plugin:sleight:computer'], ['plugin:sleight:computer', 'sleight-turbo'],
  ['plugin:sleight:computer', 'sleight-turbo', 'foreign']]) test(`gate scores and saves init catalog ${JSON.stringify(servers)}`, async t => {
  const previousExitCode = process.exitCode;
  t.after(() => { process.exitCode = previousExitCode; });
  const fixture = lifecycle(t, { surface: 'sleight-turbo', runAgent: arm => {
    rmSync(arm.dir, { recursive: true });
    return runGateAgent(arm, {
    runClaude: async () => ({ exit: { code: 0 }, groupClean: true, stderr: '', stdout: [
      ...(servers ? [{ type: 'system', subtype: 'init', mcp_servers: servers.map(name => ({ name, status: 'connected' })) }] : []),
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'read', name: 'mcp__sleight-turbo__browser_read' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'fixture page' }] } },
      { type: 'result', result: 'RESULT: done' },
    ].map(event => JSON.stringify(event)).join('\n') }),
    });
  } });
  const rows = await fixture.promise;
  const passed = servers?.length === 2;
  for (const row of rows) {
    assert.equal(row.outcome.ok, passed);
    assert.equal(row.run.inventoryErrors.length, passed ? 0 : 1);
    if (!passed) assert.match(row.outcome.problems.join('; '), /MCP init catalog/);
  }
  const saved = JSON.parse(readFileSync(join(fixture.dir, 'out/results.json')));
  assert.equal(saved[0].outcome.ok, passed);
  assert.deepEqual(saved[0].run.inventoryErrors, rows[0].run.inventoryErrors);
  assert.equal(existsSync(fixture.lockPath), false);
  assert.ok(fixture.events.includes('browser closed'));
  if (!passed) assert.equal(process.exitCode, 1);
});

test('gate resets before every task, observes afterward, and publishes the owner receipt', async t => {
  const fixture = lifecycle(t);
  const rows = await fixture.promise;
  assert.equal(rows.length, 2);
  assert.deepEqual(fixture.events, ['reset', 'agent', 'observe', 'reset', 'agent', 'observe', 'sites closed', 'browser closed']);
  assert.equal(JSON.parse(readFileSync(join(fixture.dir, 'out/browser.json'))).ownerCheck.ok, true);
  assert.deepEqual(rows[0].run.afterExit, { 'chrome:task': { title: 'task', url: 'https://example.test' } });
  assert.equal(existsSync(fixture.lockPath), false);
});

test('owner refusal is recorded in browser.json without running an agent', async t => {
  const ownerCheck = { ok: false, otherPids: [100] };
  const fixture = lifecycle(t, { launchBrowser: async () => { throw Object.assign(Error('quit the owner browser'), { ownerCheck }); } });
  await assert.rejects(fixture.promise, /quit/);
  assert.deepEqual(JSON.parse(readFileSync(join(fixture.dir, 'out/browser.json'))).ownerCheck, ownerCheck);
  assert.deepEqual(fixture.events, ['sites closed']);
  assert.equal(existsSync(fixture.lockPath), false);
});

test('a failed owner receipt write cannot release a browser whose collection is unproved', async t => {
  let fixture;
  fixture = lifecycle(t, { launchBrowser: async () => {
    mkdirSync(join(fixture.dir, 'out/browser.json'));
    throw Object.assign(Error('BENCH_BROWSER_CLEANUP_UNPROVED'), { ownerCheck: { ok: true, otherPids: [] } });
  } });
  await assert.rejects(fixture.promise, /EISDIR/);
  assert.equal(existsSync(fixture.lockPath), true);
  assert.deepEqual(fixture.events, ['sites closed']);
});

test('admission does not certify the configured Claude version', async t => {
  const fixture = lifecycle(t, { surface: 'sleight-turbo', runAgent: async arm => {
    assert.equal(arm.metadata.versionVerified, false);
    return { groupClean: true, exitCode: 0, started: 1, finished: 2, result: { result: 'RESULT: done' } };
  } });
  await fixture.promise;
});

for (const kind of ['ordinary', 'unclean', 'collection']) test(`${kind} agent error ${kind === 'ordinary' ? 'collects the browser and unlocks' : 'retains browser and lock'}`, async t => {
  const error = Object.assign(Error(kind + ' failure'), kind === 'unclean' ? { groupClean: false }
    : kind === 'collection' ? { collectionError: true } : {});
  const fixture = lifecycle(t, { runAgent: async () => { throw error; } });
  await assert.rejects(fixture.promise, new RegExp(kind + ' failure'));
  assert.equal(existsSync(fixture.lockPath), kind !== 'ordinary');
  assert.equal(fixture.events.includes('browser closed'), kind === 'ordinary');
});

test('an exception at the owned process boundary is marked as a collection error', async t => {
  const dir = temporary(t);
  const plan = { surface: 'sleight-turbo', dir: join(dir, 'task'), task, command: 'fake', args: [], env: {}, mcpConfig: {}, settingsOverrides: {} };
  await assert.rejects(runGateAgent(plan, { runClaude: async () => { throw Error('probe failed'); } }), error => {
    assert.equal(error.collectionError, true); return true;
  });
});

test('synchronous owned-process failures also retain collection uncertainty', async t => {
  const dir = temporary(t);
  const plan = { surface: 'codex', dir: join(dir, 'task'), task, prompt: 'fixture' };
  await assert.rejects(runGateAgent(plan, { runNativeCodex: () => { throw Error('sync collection failure'); } }), error => {
    assert.equal(error.collectionError, true); return true;
  });
});

test('patched real-gate entry supplies the upstream handoff grader', () => {
  const patch = readFileSync(join(root, 'bench/fowl/sleight-surface.patch'), 'utf8');
  assert.match(patch, /runner: \{ agentSetup, gradeOutcome, gradeSite, gradeViewport, gradeHandoff \}/);
});

test('default census parser refuses absolute, basename-only and relative executable matches', async t => {
  const plan = real.realBrowserPlan({ browser: 'chrome', round: 'parser' });
  let output;
  const mocked = t.mock.method(childProcess, 'execFileSync', (command, args) => {
    assert.equal(command, '/bin/ps');
    assert.deepEqual(args, ['-axww', '-o', 'pid=,ppid=,pgid=,comm=']);
    return output;
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  for (const executable of [plan.executable, 'Google Chrome', './Google Chrome', 'relative/Google Chrome']) {
    output = `  100 1 70 ${executable}\n  101 1 70 /fixture/unrelated\n`;
    await assert.rejects(real.checkBrowserOwner(plan), error => {
      assert.deepEqual(error.ownerCheck?.otherPids, [100]); return true;
    });
  }
  output = '';
  await assert.rejects(real.checkBrowserOwner(plan), /PROCESS_LIST_UNAVAILABLE/);
  output = 'not a process row\n';
  await assert.rejects(real.checkBrowserOwner(plan), /PROCESS_LIST_INVALID/);
  output = '  101 1 70 /fixture/unrelated\n';
  assert.equal((await real.checkBrowserOwner(plan)).ok, true);
});

test('per-task census allows only the owned pid and descendants, even through helper executables', async () => {
  const plan = real.realBrowserPlan({ browser: 'helium', round: 'descendants' });
  const rows = [{ pid: 100, ppid: 1, executable: plan.executable },
    { pid: 101, ppid: 100, executable: '/fixture/helper' }, { pid: 102, ppid: 101, executable: 'Helium' }];
  const check = listProcesses => real.checkBrowserOwner(plan, { ownedPid: 100, listProcesses: async () => listProcesses });
  assert.equal((await check(rows)).ok, true);
  for (const extra of [{ pid: 200, ppid: 1, executable: plan.executable },
    { pid: 200, ppid: 201, executable: './Helium' }, { pid: 201, ppid: 200, executable: 'Helium' }]) {
    await assert.rejects(check([...rows, extra]), error => {
      assert.deepEqual(error.ownerCheck.otherPids, [extra.pid]); return true;
    });
  }
  await assert.rejects(check(rows.map(({ ppid, ...row }) => row)), /PROCESS_LIST_INVALID/);
  await assert.rejects(check(rows.slice(1)), /PROCESS_LIST_INVALID/);
  await assert.rejects(check([...rows, { pid: 200, ppid: 201, executable: plan.executable },
    { pid: 201, ppid: 200, executable: '/fixture/helper' }]), error => {
    assert.deepEqual(error.ownerCheck.otherPids, [200]); return true;
  });
});

test('reset closes pages that arrive after its initial snapshot through the same owned endpoint', async () => {
  const browser = real.realBrowserPlan({ browser: 'chrome', round: 'late-page' });
  let pages = [], disconnected = false, closes = 0;
  const start = await real.resetRealBrowser(browser, { timeoutMs: 50, connect: async owned => {
    assert.equal(owned, browser);
    return { close: async () => { disconnected = true; }, send: async (method, params) => {
      if (method === 'Target.getTargets') return { targetInfos: pages };
      if (method === 'Target.createTarget') {
        pages = [{ targetId: 'marker', type: 'page', title: browser.marker },
          { targetId: 'late', type: 'page' }, { targetId: 'worker', type: 'worker' }];
        return { targetId: 'marker' };
      }
      if (method === 'Target.activateTarget') return {};
      if (method === 'Target.closeTarget') {
        assert.equal(params.targetId, 'late'); closes++;
        pages = pages.filter(page => page.targetId !== 'late'); return { success: true };
      }
      assert.fail(method);
    } };
  } });
  assert.deepEqual(Object.keys(start), ['chrome:marker']);
  assert.equal(closes, 1); assert.equal(disconnected, true);
});

test('reset remains bounded when new stray pages keep appearing', async () => {
  const browser = real.realBrowserPlan({ browser: 'helium', round: 'endless-pages' });
  let reads = 0, disconnected = false;
  await assert.rejects(real.resetRealBrowser(browser, { timeoutMs: 30, connect: async () => ({
    close: async () => { disconnected = true; }, send: async method => {
      if (method === 'Target.getTargets') return { targetInfos: ++reads === 1 ? [] :
        [{ targetId: 'marker', type: 'page', title: browser.marker }, { targetId: 'late-' + reads, type: 'page' }] };
      if (method === 'Target.createTarget') return { targetId: 'marker' };
      if (method === 'Target.activateTarget') return {};
      if (method === 'Target.closeTarget') return { success: true };
      assert.fail(method);
    },
  }) }), /RESET_FAILED/);
  assert.equal(disconnected, true);
});

for (const surface of ['codex', 'sleight-turbo']) test(`${surface} saves evidence before refusing unproved cleanup`, async t => {
  const dir = join(temporary(t), 'agent');
  const plan = { surface, dir, task, prompt: 'fixture', command: 'fake', args: [], env: {}, mcpConfig: {}, settingsOverrides: {} };
  const event = { type: 'result', result: 'partial answer' };
  await assert.rejects(runGateAgent(plan, {
    runClaude: async () => ({ groupClean: false, exit: { code: 1 }, stdout: JSON.stringify(event) + '\n', stderr: 'cleanup detail' }),
    runNativeCodex: async (_prompt, options) => {
      options.onEvent(event);
      return { groupClean: false, code: 1, out: event, stderr: 'cleanup detail', forbidden: [], toolCalls: 0 };
    },
  }), error => {
    assert.equal(error.groupClean, false);
    assert.match(error.message, /CLEANUP_UNPROVED/); return true;
  });
  assert.match(readFileSync(join(dir, 'events.jsonl'), 'utf8'), /partial answer/);
  assert.equal(readFileSync(join(dir, 'stderr.txt'), 'utf8'), 'cleanup detail');
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  assert.equal(run.groupClean, false); assert.equal(run.name, task.name);
});

for (const surface of ['codex', 'sleight-turbo']) test(`${surface} evidence-write failures still retain browser and lock after unproved cleanup`, async t => {
  const fixture = lifecycle(t, { surface, runAgent: async arm => {
    rmSync(arm.dir, { recursive: true });
    const unclean = () => {
      mkdirSync(join(arm.dir, 'run.json'));
      return { groupClean: false, exit: { code: 1 }, code: 1, out: {}, forbidden: [], stdout: '', stderr: '' };
    };
    return runGateAgent(arm, { runClaude: unclean, runNativeCodex: unclean });
  } });
  await assert.rejects(fixture.promise, error => {
    assert.match(error.message, /EISDIR/); assert.equal(error.groupClean, false); return true;
  });
  assert.equal(existsSync(fixture.lockPath), true);
  assert.equal(fixture.events.includes('browser closed'), false);
  const agentDir = join(fixture.dir, 'out', task.name);
  assert.equal(readFileSync(join(agentDir, 'events.jsonl'), 'utf8'), '');
  assert.equal(readFileSync(join(agentDir, 'stderr.txt'), 'utf8'), '');
});

for (const thrown of [null, undefined, 'collection failed', 17]) test(`non-object process throw ${String(thrown)} retains the collection flag and lock`, async t => {
  const fixture = lifecycle(t, { runAgent: async arm => {
    rmSync(arm.dir, { recursive: true });
    return runGateAgent(arm, { runNativeCodex: () => { throw thrown; } });
  } });
  await assert.rejects(fixture.promise, error => {
    assert.equal(error.collectionError, true); assert.ok(error instanceof Error); return true;
  });
  assert.equal(existsSync(fixture.lockPath), true);
  assert.equal(fixture.events.includes('browser closed'), false);
});

test('each task census refuses a newly arrived owner before reset, saves refusal, and collects only the owned browser', async t => {
  let checks = 0;
  const fixture = lifecycle(t, { checkOwner: async (browser, options) => {
    assert.equal(options.ownedPid, browser.pid);
    if (++checks === 1) return { ok: true, otherPids: [] };
    throw Object.assign(Error('Quit owner browser'), { ownerCheck: { ok: false, otherPids: [200] } });
  } });
  await assert.rejects(fixture.promise, /Quit owner/);
  assert.equal(checks, 2);
  assert.deepEqual(fixture.events, ['reset', 'agent', 'observe', 'sites closed', 'browser closed']);
  assert.deepEqual(JSON.parse(readFileSync(join(fixture.dir, 'out/browser.json'))).ownerCheck.otherPids, [200]);
  assert.equal(existsSync(fixture.lockPath), false);
});

test('captured comm census refuses parenthesized, case-varied and truncated Firefox names', async t => {
  const plan = real.realBrowserPlan({ browser: 'firefox', round: 'captured-census' });
  let output;
  const mocked = t.mock.method(childProcess, 'execFileSync', () => output);
  syncBuiltinESMExports(); t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  for (const name of ['(firefox)', '(Firefox)', 'FIREFOX', 'firefox content', '(firefox-bin)', '/Applications/Firefox.app/Contents/MacOS/Firefox']) {
    output = `  320 1 70 ${name}\n  321 1 70 /fixture/unrelated\n`;
    await assert.rejects(real.checkBrowserOwner(plan), error => { assert.deepEqual(error.ownerCheck.otherPids, [320]); return true; });
  }
});
