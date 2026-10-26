import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { acquireForShot, assertAction, completedMarker, contactSheet, encodingPlan, failureReason, gifLadder, runShots, shotPlan, waitCap, waitClear, withHoldRetry, encode } from '../bench/demo/capture.mjs';
import * as demo from '../bench/demo/capture.mjs';

const fail = code => Object.assign(Error(code), { code });
const world = t => registerTemp(t, mkdtempSync(join(tmpdir(), 'dm1-recovery-')));
const ready = m => m?.status === 'complete';
const done = { status: 'complete' };
const quiet = () => {};

test('wake failure is logged and ignored while abort and cleanup still stop the shot', async () => {
  const logs = [], signal = new AbortController().signal;
  const children = { run: async (cmd, args, options) => {
    assert.equal(cmd, '/usr/bin/caffeinate'); assert.deepEqual(args, ['-u', '-t', '5']);
    assert.equal(options.timeoutMs, 10000); throw Error('caffeinate exit 1: wake failed');
  } };
  await demo.wakeDisplay(children, signal, line => logs.push(line));
  assert.equal(logs.length, 1); assert.match(logs[0], /DM1 wake:.*exit 1/);
  const c = new AbortController(); c.abort(fail('HOLD'));
  await assert.rejects(demo.wakeDisplay(children, c.signal, quiet), { code: 'HOLD' });
  await assert.rejects(demo.wakeDisplay({ run: async () => { throw fail('CLEANUP'); } }, signal, quiet), { code: 'CLEANUP' });
});

test('hold budget spans repeated holds but resets on another shot or non-hold failure', () => {
  let now = 0;
  const budget = new demo.ShotHoldBudget(1000, () => now);
  assert.equal(budget.remaining('01-ring'), 1000);
  budget.record('HOLD'); now = 600;
  assert.equal(budget.remaining('01-ring'), 400);
  budget.record('HOLD'); now = 1000;
  assert.throws(() => budget.remaining('01-ring'), { code: 'BUSY' });
  assert.equal(budget.remaining('02-states'), 1000);
  budget.record('HOLD'); now = 1600;
  assert.equal(budget.remaining('02-states'), 400);
  budget.record('Drawing absent'); now = 5000;
  assert.equal(budget.remaining('02-states'), 1000);
  budget.record('HOLD'); now = 5500; budget.record();
  assert.equal(budget.remaining('02-states'), 1000);
});

test('two failed takes are saved and later shots complete; resume runs untried shots before old failures', async () => {
  const state = { markers: { '01-ring': { status: 'failed' }, '02-states': done } }, called = [], saved = [];
  const count = await runShots(state, { ready, log: quiet, save: s => saved.push(structuredClone(s)), take: async (s, attempt) => {
    called.push([s.id, attempt]);
    if (s.id === '03-tsugi') throw fail('SHOT_DEADLINE');
    if (s.id === '01-ring' && attempt === 1) throw Error('GIF exceeds 2 MB');
    return done;
  } });
  assert.equal(count, 6);
  assert.deepEqual(called.map(c => c[0]), ['03-tsugi', '03-tsugi', '03-kit', '04-narration', '05-picker', '06-import', '01-ring', '01-ring']);
  assert.deepEqual(called.slice(-2).map(c => c[1]), [1, 2]);
  assert.equal(state.markers['03-tsugi'].attempts.length, 2);
  assert.equal(state.markers['03-tsugi'].reason, 'SHOT_DEADLINE');
  assert.equal(saved.length, 8);
});

test('a hold reruns the same shot without spending its failure retry', async () => {
  const state = { markers: Object.fromEntries(shotPlan().slice(1).map(s => [s.id, done])) }, calls = [];
  let n = 0;
  const count = await runShots(state, { ready, log: quiet, take: async (s, attempt) => {
    calls.push([s.id, attempt]); n++;
    if (n === 1) throw fail('HOLD');
    if (n === 2) throw Error('shot failed');
    return done;
  } });
  assert.equal(count, 7);
  assert.deepEqual(calls.map(c => c[1]), [1, 1, 2]);
  assert.equal(state.markers['01-ring'].attempts.length, 2);
});

test('owner, wait cap, telemetry, signals and cleanup each stop before the next shot', async () => {
  for (const code of ['OWNER', 'BUSY', 'TELEMETRY', 'SIGINT', 'SIGTERM', 'SIGHUP', 'CLEANUP', 'screen-locked', 'display-asleep', 'screen-too-small']) {
    const state = { markers: {} }; let n = 0;
    await assert.rejects(runShots(state, { ready, log: quiet, take: async () => { n++; throw fail(code); } }), { code });
    assert.equal(n, 1); assert.equal(state.markers['01-ring'].reason, code);
  }
});

test('AbortError reports the controller deadline reason and its cause', () => {
  const c = new AbortController(); c.abort(fail('SHOT_DEADLINE'));
  assert.equal(failureReason(Object.assign(Error(), { code: 'ABORT_ERR' }), c.signal), 'SHOT_DEADLINE');
  assert.equal(failureReason(Object.assign(Error(), { code: 'ABORT_ERR', cause: fail('SHOT_DEADLINE') })), 'SHOT_DEADLINE');
});

test('hold polls are 30 seconds, logged, bounded and cancellable without filesystem mutation', async () => {
  let now = 0; const logs = [], waits = [];
  await assert.rejects(waitClear({ exists: p => p.endsWith('sleight-hold'), now: () => now, capMs: 65000,
    wait: async ms => { waits.push(ms); now += ms; }, log: m => logs.push(m) }), { code: 'BUSY' });
  assert.deepEqual(waits, [30000, 30000, 5000]); assert.equal(logs.length, 3);
  assert.match(logs[1], /30 s elapsed/);
  const c = new AbortController(); c.abort(fail('SIGTERM'));
  await assert.rejects(waitClear({ signal: c.signal, exists: () => true }), { code: 'SIGTERM' });
  assert.equal(waitCap(), 1800000); assert.equal(waitCap('100'), 100);
  for (const v of ['0', '-1', 'nan', 'Infinity', '1.5']) assert.throws(() => waitCap(v));
});

test('a lock appearing between clear and take returns to wait; hold after acquisition releases before polling', async () => {
  let locked = false, held = false, now = 0, calls = 0, owned = false;
  const order = [];
  const release = await acquireForShot(async () => {
    calls++; order.push('acquire');
    if (calls === 1) { locked = true; throw Error('Another live run holds /tmp/test'); }
    owned = true;
    if (calls === 2) held = true;
    return async () => { order.push('release'); owned = false; };
  }, { exists: p => p.endsWith('sleight-hold') ? held : locked, now: () => now, log: quiet,
    wait: async ms => { assert.equal(owned, false); order.push('wait'); now += ms; held = locked = false; } });
  assert.equal(calls, 3); assert.equal(owned, true); await release();
  assert.deepEqual(order, ['acquire', 'wait', 'acquire', 'release', 'wait', 'acquire', 'release']);
});

test('persistent lock races exhaust the same cap and release errors stop cleanup', async () => {
  let now = 0;
  await assert.rejects(acquireForShot(async () => { now += 30000; throw fail('EEXIST'); },
    { exists: () => false, capMs: 60000, now: () => now }), { code: 'BUSY' });
  let held = false;
  await assert.rejects(acquireForShot(async () => { held = true; return async () => { throw fail('LIVE_LOCK_REMOVED'); }; },
    { exists: p => held && p.endsWith('sleight-hold') }), { code: 'CLEANUP' });
});

test('a compile interrupted by a hold collects its child before waiting and reruns that source', async () => {
  let held = false, collected = false, runs = 0, now = 0; const order = [];
  const result = await withHoldRetry(async () => {
    runs++; order.push('compile'); collected = false;
    try { if (runs === 1) { held = true; throw fail('HOLD'); } return 'compiled'; }
    finally { collected = true; order.push('collect'); }
  }, { log: quiet, exists: p => held && p.endsWith('sleight-hold'), now: () => now,
    wait: async ms => { assert.equal(collected, true); order.push('wait'); held = false; now += ms; } });
  assert.equal(result, 'compiled'); assert.deepEqual(order, ['compile', 'collect', 'wait', 'compile', 'collect']);
  await assert.rejects(withHoldRetry(async () => { throw fail('CLEANUP'); }, { exists: () => false }), { code: 'CLEANUP' });
});

test('ack checks need exactly one new action and preserve the other counter', () => {
  assertAction({ clicks: 4, drags: 2 }, { clicks: 5, drags: 2 }, 'click');
  assertAction({ clicks: 4, drags: 2 }, { clicks: 4, drags: 3 }, 'drag');
  for (const after of [{ clicks: 4, drags: 2 }, { clicks: 6, drags: 2 }, { clicks: 5, drags: 3 }])
    assert.throws(() => assertAction({ clicks: 4, drags: 2 }, after, 'click'), /acknowledged/);
});

test('GIF ladder tries 20 fps first, 12 last, and import keeps 720 px on every rung', () => {
  for (const id of [undefined, '06-import']) {
    const ladder = gifLadder(id), commands = encodingPlan('take.mov', '/tmp/out', id).gifs;
    assert.equal(ladder[0][2], 20); assert.equal(ladder.at(-1)[2], 12);
    commands.forEach((args, i) => assert.match(args.join(' '), new RegExp(`fps=${ladder[i][2]},scale=${ladder[i][0]}`)));
    if (id) assert.ok(ladder.every(([w]) => w === 720));
  }
});

test('encode records the actual fallback fps and width, and refuses an oversize final rung', async t => {
  const dir = world(t); let gifs = 0;
  const children = { run: async (cmd, args) => {
    const out = args.at(-1);
    if (out.endsWith('demo.mp4')) writeFileSync(out, 'mp4');
    if (out.endsWith('demo.gif')) { gifs++; writeFileSync(out, Buffer.alloc(gifs < 3 ? 2_000_001 : 100)); }
    if (out.endsWith('poster.png')) writeFileSync(out, 'poster');
    return args.includes('-progress') ? 'frame=240\nout_time_us=8000000\n' : '';
  } };
  const result = await encode(children, dir, '06-import');
  assert.equal(gifs, 3); assert.equal(result.gifFps, 12); assert.equal(result.gifWidth, 720);
  gifs = -100;
  await assert.rejects(encode(children, dir, '06-import'), /GIF exceeds 2 MB/);
});

function marker(dir, id) {
  mkdirSync(dir);
  for (const name of ['demo.gif', 'demo.mp4', 'poster.png', 'sync.json', 'events.json', 'probes.json']) writeFileSync(join(dir, name), 'evidence');
  return completedMarker(dir, { id, caption: 'fixture', seconds: 8, fps: 30, gifFps: 20, gifBytes: 8, mp4Bytes: 8,
    encoder: 'ffmpeg', cleanup: true, probes: { passed: true } });
}
test('partial contact sheets use successful shots only and never call xstack with one input', async t => {
  const out = world(t), state = { out, head: 'test', markers: { '01-ring': marker(join(out, 'a'), '01-ring'), '02-states': { status: 'failed' } } };
  const calls = [], children = { run: async (cmd, args) => calls.push(args) };
  await contactSheet(children, state);
  assert.equal(calls.length, 0);
  const html = readFileSync(join(out, 'contact-sheet.html'), 'utf8');
  assert.match(html, /01-ring/); assert.doesNotMatch(html, /02-states/); assert.match(html, /20\/30 fps/);
  state.markers['03-kit'] = marker(join(out, 'b'), '03-kit');
  await contactSheet(children, state);
  assert.equal(calls.length, 1); assert.match(calls[0].join(' '), /xstack=inputs=2/);
});
