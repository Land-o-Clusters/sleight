// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveV3Worker } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { withMT } from './fixtures/mt-env.mjs';

for (const mode of [undefined, '0', '1']) test(`MTb benchmark forwards the model-time switch, switch=${mode}`, async () => withMT(mode, async () => {
  const { turboSetup } = await import('../bench/turbo/setup.mjs');
  const { realAgentSetup } = await import('../bench/fowl/real-gate-setup.mjs');
  const { createSession } = await load();
  const task = { prompt: 'Read ' + origin, result: 'Read' }, dir = `${MAC_TMP}/fixture-task`;
  const direct = turboSetup({ task, repo: '/fixture/repo', dir, prompt: task.prompt, env: process.env });
  assert.equal(direct.mcpServers['sleight-turbo'].env.SLEIGHT_MT, mode);
  const gate = realAgentSetup({ task, surface: 'sleight-turbo', dir,
    realBrowser: { browser: 'chrome', profileRoot: `${MAC_TMP}/profile`, marker: 'Sleight Gate fixture' } });
  assert.equal(gate.mcpConfig.mcpServers['sleight-turbo'].env.SLEIGHT_MT, mode);
  const fork = fakeFork(async () => ({ call: async () => ({ text: 'ok', isError: false }), end: async () => ({ revoked: true, cleanup: [] }) }));
  const session = await createSession({ origins: [origin], taskMessage: 'Read fixture', forkWorker: (path, args, options) => {
    assert.equal(options.env.SLEIGHT_MT, mode);
    return fork(path, args, options);
  } });
  await session.close();
}));
test('MTb isolated rounds command forwards the model-time switch and strips unrelated values', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../bench/fowl/rounds.sh', import.meta.url), 'utf8');
  // Execute only the real gate's env-isolation command, replacing its benchmark payload with an environment reader.
  // The rest of rounds.sh owns profiles, Git state and a live lock and must never run in this offline test.
  const command = source.match(/  (?:exec )?env -i[\s\S]*?node tools\/rounds\.mjs "\$@" --model "\$MODEL"/)[0]
    .replace('node tools/rounds.mjs "$@" --model "$MODEL"', '"$1" -e \'process.stdout.write(JSON.stringify({mt:process.env.SLEIGHT_MT,lb12:process.env.SLEIGHT_LB12,unrelated:process.env.MTB_UNRELATED}))\'');
  for (const mode of [undefined, '0', '1']) {
    const env = { ...process.env, SLEIGHT_LB12: '0', MTB_UNRELATED: 'must not cross' };
    if (mode === undefined) delete env.SLEIGHT_MT; else env.SLEIGHT_MT = mode;
    const result = JSON.parse(execFileSync('/bin/sh', ['-c', 'REPO=/fixture; MODEL=fixture;\n' + command, 'mtb-env', process.execPath], { env, encoding: 'utf8' }));
    assert.deepEqual(result, { ...(mode === undefined ? {} : { mt: mode }), lb12: '0' });
  }
});

const load = () => import('../bench/turbo/v3-session.mjs');
const origin = 'http://127.0.0.1:5431';

export function fakeFork(begin, close = async () => ({ revoked: true, cleanup: [] })) {
  return (_path, _args, options) => {
    assert.deepEqual(options.execArgv, []); assert.ok(options.stdio.includes('ipc'));
    const child = new EventEmitter(), endpoint = new EventEmitter();
    child.connected = endpoint.connected = true;
    child.send = frame => queueMicrotask(() => endpoint.emit('message', structuredClone(frame)));
    endpoint.send = frame => queueMicrotask(() => child.emit('message', structuredClone(frame)));
    child.disconnect = () => { child.connected = endpoint.connected = false; endpoint.emit('disconnect'); child.emit('disconnect'); };
    child.unref = () => {};
    const worker = serveV3Worker({ channel: endpoint, browser: 'bbench', begin, close });
    queueMicrotask(() => worker.ready()); return child;
  };
}

test('benchmark session binds the original task privately through V7 and never accepts tool authority', async () => {
  const { createSession } = await load();
  const events = []; let closes = 0;
  const original = 'Read the fixture; do not buy anything.';
  const session = await createSession({ origins: [origin], taskMessage: original,
    forkWorker: fakeFork(async event => {
      events.push(event);
      return { call: async input => { events.push(input); return { text: 'Untrusted page', isError: false }; },
        delivered: result => { events.push(result); return true; }, end: async () => ({ revoked: true, cleanup: [] }) };
    }, async () => { closes++; return { revoked: true, cleanup: [] }; }) });
  assert.equal(events[0].source, 'user'); assert.equal(events[0].text, original);
  assert.ok(events[0].session); assert.ok(events[0].turn);
  const result = await session.call({ name: 'browser_read', arguments: { tab: 't1' } });
  assert.equal(result.text, 'Untrusted page'); assert.equal(session.delivered({ ...result }), false);
  assert.equal(session.delivered(result), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.at(-1).text, 'Untrusted page');
  const bad = await session.call({ name: 'browser_read', arguments: { tab: 't1', consent: true } });
  assert.equal(bad.isError, true); assert.equal(events.filter(e => e.name).length, 1);
  assert.deepEqual(await session.close(), { revoked: true, cleanup: [] }); await session.close(); assert.equal(closes, 1);
});

test('benchmark worker without the pinned headless browser reports unavailable before launching and its fork exits', { timeout: 15000 }, async () => {
  const { createSession } = await load();
  const { mkdtempSync, rmSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'sleight-v3-nobrowser-'));
  let exited;
  try {
    await assert.rejects(createSession({ origins: [origin], taskMessage: 'Read fixture',
      forkWorker(path, args, options) {
        assert.match(String(path), /bench\/turbo\/v3-worker.mjs$/);
        const child = fork(path, args, { ...options, env: { ...options.env, HOME: home } });
        exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
        return child;
      } }), /V3_RUNTIME_UNAVAILABLE|BENCH_BROWSER_MISSING/);
    assert.deepEqual(await exited, { code: 0, signal: null });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('invalid fixture/task input never forks and missing cleanup evidence stays unavailable', async () => {
  const { createSession, cleanupMetric } = await load();
  let forks = 0;
  for (const args of [{ origins: ['https://example.com'], taskMessage: 'read' }, { origins: [origin], taskMessage: null }])
    await assert.rejects(createSession({ ...args, forkWorker: () => forks++ }));
  assert.equal(forks, 0);
  assert.deepEqual(cleanupMetric({ revoked: true, cleanup: [] }), { version: 3, phase: 'cleanup', turboTabsLeft: null,
    tabsAfterBrowserClose: null, browserClosed: false, profileDeleted: false, socketsClosed: false });
  const proof = { turboTabsLeft: 0, tabsAfterBrowserClose: 0, browserClosed: true, profileDeleted: true, socketsClosed: true };
  assert.deepEqual(cleanupMetric(proof), { version: 3, phase: 'cleanup', ...proof });
});

test('a public-web task names no fixture origin and the session still starts; named origins must still be runner fixtures', async () => {
  const { createSession } = await load();
  const events = [];
  const session = await createSession({ origins: [], taskMessage: 'Look up the height of Mount Kilimanjaro on Wikipedia.',
    forkWorker: fakeFork(async event => { events.push(event); return { call: async () => ({ text: 'ok', isError: false }),
      delivered: () => true, end: async () => ({ revoked: true, cleanup: [] }) }; }) });
  assert.equal(events[0].text, 'Look up the height of Mount Kilimanjaro on Wikipedia.');
  assert.equal((await session.call({ name: 'browser_read', arguments: { tab: 't1' } })).text, 'ok');
  await session.close();
  let forks = 0;
  for (const origins of [undefined, 'http://127.0.0.1:5431', ['http://localhost:5431'], ['https://en.wikipedia.org']])
    await assert.rejects(createSession({ origins, taskMessage: 'read', forkWorker: () => forks++ }));
  assert.equal(forks, 0);
});

test('the bench browser is its own headless Chromium with a temporary profile and no host restriction', async () => {
  const { BENCH_BROWSER_ARGS, launchOwnedBrowser } = await import('../bench/turbo/v3-worker.mjs');
  assert.ok(BENCH_BROWSER_ARGS.includes('--headless'));
  assert.ok(BENCH_BROWSER_ARGS.includes('--remote-debugging-port=0'));
  assert.equal(BENCH_BROWSER_ARGS.filter(arg => /host-resolver|proxy|disable-web-security|no-sandbox|remote-allow-origins/.test(arg)).length, 0);
  const spawned = [];
  await assert.rejects(launchOwnedBrowser({ timeoutMs: 200, spawnBrowser: (command, args) => {
    spawned.push({ command, args }); const child = new EventEmitter(); child.exitCode = 1; child.signalCode = null; child.kill = () => {}; return child;
  } }), /BENCH_BROWSER_START_FAILED|BENCH_BROWSER_MISSING/);
  for (const { args } of spawned) {
    assert.ok(args.some(arg => /^--user-data-dir=.*sleight-bench-v3-/.test(arg)), 'a temporary profile, never a real browser profile');
    assert.ok(!args.some(arg => /Application Support|Google\/Chrome|Helium/.test(arg)));
  }
});

test('runner setup selects all five v3 tools, private task, metrics and v3 guidance beside the companion', async () => {
  const { turboSetup } = await import('../bench/turbo/setup.mjs');
  const { browserTools } = await import('../plugins/sleight/lib/direct-browser/tools.mjs');
  const task = { prompt: 'Read ' + origin + '/form' };
  const setup = turboSetup({ task, repo: '/fixture/repo', dir: `${MAC_TMP}/fixture-task`, prompt: task.prompt });
  assert.deepEqual(setup.mcpServers['sleight-turbo'].args, ['/fixture/repo/bench/turbo/v3-server.mjs']);
  assert.deepEqual(setup.allowed.split(',').filter(name => name.startsWith('mcp__sleight-turbo__')),
    browserTools('bbench').map(tool => 'mcp__sleight-turbo__' + tool.name));
  assert.equal(setup.mcpServers['sleight-turbo'].env.SLEIGHT_TURBO_TASK, task.prompt);
  assert.equal(setup.mcpServers['sleight-turbo'].env.SLEIGHT_TURBO_METRICS, `${MAC_TMP}/fixture-task/turbo-metrics.jsonl`);
  assert.equal(setup.mcpServers['plugin:sleight:computer'].env.SLEIGHT_SURFACES, 'browser,computer');
  assert.match(setup.promptPrefix, /A batch stops at a boundary or failed step/);
  assert.match(setup.promptPrefix, /Never translate refs or handles between paths/);
  assert.equal(setup.metadata.turboVersion, 3);
});

test('the turbo A/B switch and trace destination reach the benchmark worker', async t => {
  const { realAgentSetup } = await import('../bench/fowl/real-gate-setup.mjs');
  const { createSession } = await load();
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const trace = realpathSync(registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-x6-route-'))));
  const oldFlag = process.env.SLEIGHT_LB12, oldTrace = process.env.SLEIGHT_TRACE;
  process.env.SLEIGHT_LB12 = '0'; process.env.SLEIGHT_TRACE = trace;
  t.after(() => {
    if (oldFlag === undefined) delete process.env.SLEIGHT_LB12; else process.env.SLEIGHT_LB12 = oldFlag;
    if (oldTrace === undefined) delete process.env.SLEIGHT_TRACE; else process.env.SLEIGHT_TRACE = oldTrace;
  });
  const setup = realAgentSetup({ task: { prompt: 'Read ' + origin, result: 'Read' }, surface: 'sleight-turbo', dir: `${MAC_TMP}/fixture-task`,
    realBrowser: { browser: 'chrome', profileRoot: `${MAC_TMP}/profile`, marker: 'Sleight Gate fixture' } });
  const env = setup.mcpConfig.mcpServers['sleight-turbo'].env;
  assert.equal(env.SLEIGHT_LB12, '0');
  assert.equal(env.SLEIGHT_TRACE, trace);
  const fork = fakeFork(async () => ({ call: async () => ({ text: 'ok', isError: false }), end: async () => ({ revoked: true, cleanup: [] }) }));
  const session = await createSession({ origins: [origin], taskMessage: 'Read fixture', forkWorker: (path, args, options) => {
    assert.equal(options.env.SLEIGHT_LB12, '0');
    assert.equal(options.env.SLEIGHT_TRACE, trace);
    return fork(path, args, options);
  } });
  await session.close();
});

test('cleanup metrics are append-only and never manufacture zero tabs or follow symlinks', async t => {
  const { recordCleanup } = await import('../bench/turbo/v3-server.mjs');
  const { mkdtempSync, readFileSync, symlinkSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join, resolve } = await import('node:path');
  const parent = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-v3-metrics-')));
  const file = join(realpathSync(parent), 'turbo-metrics.jsonl');
  recordCleanup(file, { revoked: true, cleanup: [] });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).turboTabsLeft, null);
  recordCleanup(file, { turboTabsLeft: 0, tabsAfterBrowserClose: 0, browserClosed: true, profileDeleted: true, socketsClosed: true });
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
  assert.throws(() => recordCleanup(join(parent, 'elsewhere.jsonl'), {}), /Invalid metrics destination/);
  const link = join(parent, 'linked'); symlinkSync(parent, link);
  assert.throws(() => recordCleanup(join(link, 'turbo-metrics.jsonl'), {}), /Invalid metrics destination/);
});
