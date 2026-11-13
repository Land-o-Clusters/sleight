// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
// SLEIGHT_BENCH_HAND: arms keep the ghost hand off unless the runner asks for it (H6 cost pass, H8 hidden-tab check), and
// turbo's worker now gets the arm's setting and trace folder. Also H8's trace reader.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchHand } from '../bench/hand/bench-hand.mjs';
import { realAgentSetup } from '../bench/fowl/real-gate-setup.mjs';
import { worldAgentSetup } from '../bench/world/arms/browser.mjs';
import { serveV3Worker } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { readHandEvents, hiddenTabVerdict, roundCommand } from '../bench/hand/h8-hidden-tab.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const chrome = { browser: 'chrome', profileRoot: '/tmp/profile', executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', marker: 'Sleight Gate fixture0002', pid: 2, connectionMode: 'product-remote-debugging' };
const task = { name: 'fixture', browser: 'chrome', prompt: 'Visit http://127.0.0.1:5420/x in {browser}.', result: 'the answer' };

function withEnv(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test('benchHand: off by default and for 0, on only for 1, anything else stops the pass', () => {
  assert.deepEqual([benchHand({}), benchHand({ SLEIGHT_BENCH_HAND: '' }), benchHand({ SLEIGHT_BENCH_HAND: '0' }), benchHand({ SLEIGHT_BENCH_HAND: '1' })], ['0', '0', '0', '1']);
  for (const bad of ['true', 'on', '2']) assert.throws(() => benchHand({ SLEIGHT_BENCH_HAND: bad }), /must be 0 or 1/);
  // The product's own SLEIGHT_HAND=1 is not the switch: a host session's env never turns an arm's hand on.
  assert.equal(benchHand({ SLEIGHT_HAND: '1' }), '0');
});

test('the turbo arm: both servers follow the switch, and the turbo server carries SLEIGHT_TRACE for the worker', t => {
  withEnv(t, { SLEIGHT_TRACE: '/tmp/round.trace' });
  delete process.env.SLEIGHT_BENCH_HAND;
  const setup = () => realAgentSetup({ task, surface: 'sleight-turbo', dir: `${MAC_TMP}/gate-task`, realBrowser: chrome, dryRun: true });
  const off = setup().mcpConfig.mcpServers;
  assert.equal(off['plugin:sleight:computer'].env.SLEIGHT_HAND, '0');
  assert.equal(off['sleight-turbo'].env.SLEIGHT_HAND, '0');
  assert.equal(off['sleight-turbo'].env.SLEIGHT_TRACE, '/tmp/round.trace');
  process.env.SLEIGHT_BENCH_HAND = '1';
  const on = setup();
  assert.equal(on.mcpConfig.mcpServers['plugin:sleight:computer'].env.SLEIGHT_HAND, '1');
  assert.equal(on.mcpConfig.mcpServers['sleight-turbo'].env.SLEIGHT_HAND, '1');
  assert.equal(on.env.SLEIGHT_HAND, '1');
  const dir = mkdtempSync(join(tmpdir(), 'hand-switch-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(worldAgentSetup({ surface: 'sleight', dir: join(dir, 'run'), armRoot: join(dir, 'arms'), hostEnv: {} }).env.SLEIGHT_HAND, '1');
  delete process.env.SLEIGHT_TRACE;
  assert.equal(setup().mcpConfig.mcpServers['sleight-turbo'].env.SLEIGHT_TRACE, undefined);
});

test('the benchmark turbo worker gets the arm\'s SLEIGHT_HAND and SLEIGHT_TRACE, and nothing else from the server', async t => {
  withEnv(t, { SLEIGHT_HAND: '0', SLEIGHT_TRACE: '/tmp/round.trace', SLEIGHT_SECRET_FIXTURE: 'x' });
  const { createSession } = await import('../bench/turbo/v3-session.mjs');
  let env;
  const session = await createSession({ origins: ['http://127.0.0.1:5431'], taskMessage: 'Read the fixture',
    forkWorker: (_path, _args, options) => {
      env = options.env;
      const child = new EventEmitter(), endpoint = new EventEmitter();
      child.connected = endpoint.connected = true;
      child.send = frame => queueMicrotask(() => endpoint.emit('message', structuredClone(frame)));
      endpoint.send = frame => queueMicrotask(() => child.emit('message', structuredClone(frame)));
      child.disconnect = () => { child.connected = endpoint.connected = false; endpoint.emit('disconnect'); child.emit('disconnect'); };
      child.unref = () => {};
      const worker = serveV3Worker({ channel: endpoint, browser: 'bbench', begin: async () => ({ call: async () => ({ text: '', isError: false }),
        delivered: () => true, end: async () => ({ revoked: true, cleanup: [] }) }), close: async () => ({ revoked: true, cleanup: [] }) });
      queueMicrotask(() => worker.ready()); return child;
    } });
  await session.close();
  assert.equal(env.SLEIGHT_HAND, '0');
  assert.equal(env.SLEIGHT_TRACE, '/tmp/round.trace');
  assert.equal(env.SLEIGHT_SECRET_FIXTURE, undefined);
});

test('rounds.sh carries SLEIGHT_BENCH_HAND through its real-browser env -i branch', () => {
  const script = readFileSync(join(root, 'bench/fowl/rounds.sh'), 'utf8');
  const branch = script.slice(script.indexOf('if [ -n "$REAL" ]; then'), script.indexOf('fi\n', script.indexOf('if [ -n "$REAL" ]; then')));
  assert.match(branch, /env -i[\s\S]*\$\{SLEIGHT_BENCH_HAND:\+SLEIGHT_BENCH_HAND="\$SLEIGHT_BENCH_HAND"\}[\s\S]*node tools\/rounds\.mjs/);
});

const line = (direction, msg) => JSON.stringify({ t: '2026-10-19T12:00:00.000Z', direction, msg });

test('H8: hidden-tab skips and no draws pass; a draw fails; no hand events say why they can\'t tell', () => {
  const pass = readHandEvents([line('turbo-phase', { phase: 'worker-ready' }), line('hand-skipped', { op: 'click', reason: 'hidden-tab' }),
    line('hand-skipped', { op: 'type', reason: 'hidden-tab' }), line('hand-skipped', { op: 'scroll', reason: 'no-geometry' }), 'junk']);
  assert.deepEqual(pass, { phases: 1, skipped: { 'hidden-tab': 2, 'no-geometry': 1 }, shown: {}, skips: 3, draws: 0 });
  assert.equal(hiddenTabVerdict(pass).verdict, 'pass');
  assert.match(hiddenTabVerdict(pass).words, /2 of 3 step\(s\) skipped as hidden-tab/);
  const drew = readHandEvents([line('hand-skipped', { op: 'click', reason: 'hidden-tab' }), line('hand-shown', { op: 'click', kind: 'click' })]);
  assert.equal(hiddenTabVerdict(drew).verdict, 'fail');
  assert.match(hiddenTabVerdict(readHandEvents([line('turbo-phase', {})])).words, /its hand never ran/);
  assert.match(hiddenTabVerdict(readHandEvents([])).words, /no turbo trace at all/);
  assert.equal(hiddenTabVerdict(readHandEvents([line('hand-skipped', { op: 'click', reason: 'covered' })])).verdict, 'inconclusive');
  const plan = roundCommand({ out: '/o/r1' });
  assert.deepEqual(plan.args, ['--world', '--real-browser', 'chrome', '--surface', 'sleight-turbo', '--model', 'haiku', '--effort', 'high', '--only', 'demoid', '--out', '/o/r1']);
  assert.deepEqual(plan.env, { DISABLE_AUTOUPDATER: '1', SLEIGHT_NO_HUB: '1', SLEIGHT_BENCH_HAND: '1', SLEIGHT_TRACE: '/o/r1.trace' });
});

test('H8: --run refuses without --owner-away before it checks or starts anything; reading a trace needs no flag', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = join(root, 'bench/hand/h8-hidden-tab.mjs');
  const run = spawnSync(process.execPath, [script, '--run', '--out', '/nonexistent/h8'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /pass --owner-away/);
  const dir = mkdtempSync(join(tmpdir(), 'h8-read-'));
  try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'trace-7.jsonl'), line('hand-skipped', { op: 'click', reason: 'hidden-tab' }) + '\n');
    const read = spawnSync(process.execPath, [script, dir], { encoding: 'utf8', timeout: 20000 });
    assert.equal(read.status, 0, read.stderr);
    assert.equal(JSON.parse(read.stdout).verdict, 'pass');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
