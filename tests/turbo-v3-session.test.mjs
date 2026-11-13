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
    const result = JSON.parse(execFileSync('/bin/sh', ['-c', 'REPO=/fixture; MODEL=fixture;\n' + command, 'mtb-env', process.execPath], { env, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' }));
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
  const { BENCH_BROWSER_ARGS, launchOwnedBrowser, headlessExecutable } = await import('../bench/turbo/v3-worker.mjs');
  assert.ok(BENCH_BROWSER_ARGS.includes('--headless'));
  assert.ok(BENCH_BROWSER_ARGS.includes('--remote-debugging-port=0'));
  assert.equal(BENCH_BROWSER_ARGS.filter(arg => /host-resolver|proxy|disable-web-security|no-sandbox|remote-allow-origins/.test(arg)).length, 0);
  const spawned = [];
  await assert.rejects(launchOwnedBrowser({ timeoutMs: 200, spawnBrowser: (command, args, options) => {
    spawned.push({ command, args, options }); const child = new EventEmitter(); child.exitCode = 1; child.signalCode = null; child.kill = () => {}; return child;
  } }), /BENCH_BROWSER_START_FAILED|BENCH_BROWSER_MISSING/);
  for (const { command, args, options } of spawned) {
    assert.equal(command, headlessExecutable(), 'launch Chromium directly with its own content/GPU sandbox');
    assert.deepEqual(args.slice(1), BENCH_BROWSER_ARGS, 'the original browser flags stay unchanged');
    assert.deepEqual(options, { stdio: 'ignore' });
    assert.ok(args.some(arg => /^--user-data-dir=.*sleight-bench-v3-/.test(arg)), 'a temporary profile, never a real browser profile');
    assert.ok(!args.some(arg => /Application Support|Google\/Chrome|Helium/.test(arg)));
  }
});

test('owned browser cleanup waits for its exit and removes only its exact profile', async t => {
  const { launchOwnedBrowser } = await import('../bench/turbo/v3-worker.mjs');
  const { existsSync, mkdtempSync, writeFileSync } = await import('node:fs');
  const foreign = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-bench-v3-')));
  const child = new EventEmitter();
  Object.assign(child, { pid: 12345, exitCode: null, signalCode: null });
  let profile, signals = [];
  child.kill = signal => { signals.push(signal); };
  const browser = await launchOwnedBrowser({ executable: () => '/fixture/chromium-headless-shell', spawnBrowser(_command, args) {
    profile = args.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    writeFileSync(join(profile, 'DevToolsActivePort'), '12345\n/devtools/browser/fixture\n');
    return child;
  } });
  t.after(() => browser.stop());
  assert.equal(existsSync(profile), true);
  let finished = false;
  const stopping = browser.stop();
  stopping.then(() => { finished = true; });
  assert.equal(browser.stop(), stopping, 'cleanup has one owner');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(existsSync(profile), true);
  child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM');
  assert.deepEqual(await stopping, { pid: 12345, profilePath: profile, browserExited: true, profileDeleted: true });
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(existsSync(profile), false);
  assert.equal(existsSync(foreign), true, 'another session\'s profile is untouched');
});

test('the bench close reply carries its owned receipt after cleanup, while turn replies stay unchanged', async () => {
  const { startBenchWorker } = await import('../bench/turbo/v3-worker.mjs');
  const channel = new EventEmitter(), replies = [];
  channel.connected = true; channel.send = frame => replies.push(frame);
  let installedChannel, finish, stops = 0;
  const stopped = new Promise(resolve => { finish = resolve; });
  const host = { closed: new Promise(() => {}) };
  assert.equal(await startBenchWorker({ channel, realBrowser: null, ownedBrowserEvidence: true,
    launch: async () => ({ endpoint: 'ws://fixture', stop: () => { stops++; return stopped; } }),
    startInstalled: async ({ channel: wrapped }) => { installedChannel = wrapped; return host; },
  }), host);
  const receipt = { revoked: true, cleanup: [] };
  channel.emit('message', { id: 'end1', method: 'end' });
  const end = { version: 3, id: 'end1', result: receipt };
  installedChannel.send(end);
  assert.equal(replies[0], end); assert.equal(stops, 0);
  channel.emit('message', { id: 'close1', method: 'close' });
  installedChannel.send({ version: 3, id: 'close1', result: receipt });
  assert.equal(stops, 1); assert.equal(replies.length, 1);
  const ownedBrowser = { pid: 12345, profilePath: '/fixture/profile', browserExited: true, profileDeleted: true };
  finish(ownedBrowser);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replies[1], { version: 3, id: 'close1', result: { ...receipt, ownedBrowser } });
  assert.deepEqual(receipt, { revoked: true, cleanup: [] });
});

test('owned browser evidence is opt-in and absent from ordinary benchmark forks', async () => {
  const { createSession } = await load();
  const { startBenchWorker } = await import('../bench/turbo/v3-worker.mjs');
  const channel = new EventEmitter();
  await startBenchWorker({ channel, realBrowser: null, ownedBrowserEvidence: false,
    launch: async () => ({ stop: () => assert.fail('ordinary close timing changed') }),
    startInstalled: async input => { assert.equal(input.channel, channel); return { closed: new Promise(() => {}) }; },
  });
  const old = process.env.SLEIGHT_TURBO_OWNED_BROWSER_EVIDENCE;
  process.env.SLEIGHT_TURBO_OWNED_BROWSER_EVIDENCE = '1';
  try {
    for (const ownedBrowserEvidence of [false, true]) {
      const fork = fakeFork(async () => ({ call: async () => ({ text: 'ok' }), end: async () => ({ revoked: true, cleanup: [] }) }));
      const session = await createSession({ origins: [origin], taskMessage: 'Read fixture', ownedBrowserEvidence,
        forkWorker(path, args, options) {
          assert.equal(options.env.SLEIGHT_TURBO_OWNED_BROWSER_EVIDENCE, ownedBrowserEvidence ? '1' : undefined);
          return fork(path, args, options);
        } });
      await session.close();
    }
  } finally {
    if (old === undefined) delete process.env.SLEIGHT_TURBO_OWNED_BROWSER_EVIDENCE;
    else process.env.SLEIGHT_TURBO_OWNED_BROWSER_EVIDENCE = old;
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
  assert.match(setup.promptPrefix, /Never retry a safety refusal or uncertain input through another path, or reuse refs\/handles across paths\./);
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
