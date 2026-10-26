import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { macCommandSkip } from './requirements.mjs';

// The ring through --ring-plan-dump: the host's own planner and scheduling runtime on a simulated clock, with no panel and
// no layer. Each output line is an effect (draw, drop, hide, park, fade, release) and the last is "end".
const sourcePath = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url).pathname;
const nonce = 'a'.repeat(64);
const target = { nonce, seq: 1, pid: 2147483647, windowId: 4294967295 };
const act = (kind = 'click', extra = {}) => ({ hand: 'act', ...target, kind, at: [100, 100], path: [[100, 100]], delayMs: 0, beats: 1, ...extra });
const aim = extra => ({ hand: 'aim', ...target, kind: 'click', at: [100, 100], holdMs: 0, ...extra });
const status = (state, extra = {}) => ({ hand: 'status', ...target, state, ...extra });
const clock = seconds => ({ dumpClock: seconds });
let binary;
function build(t) {
  if (binary) return binary;
  const dir = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-ring-'))));
  const output = join(dir, 'consent-host');
  const started = performance.now();
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), sourcePath, '-o', output], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  binary = output;
  t.diagnostic(`compileMs=${Math.round(performance.now() - started)} binaryBytes=${statSync(binary).size}`);
  return binary;
}
function run(t, frames, flags = ['--cursor-style=ring']) {
  return spawnSync(build(t), ['--ring-plan-dump', ...flags], {
    input: frames.map(f => JSON.stringify(f) + '\n').join(''), encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 28,
    env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
  });
}
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
// Every drawn plan: monotonic keyTimes from 0 to 1, a value per time, every track inside the plan, and D2's budget.
function check(p) {
  for (const a of p.animations) {
    assert.equal(a.values.length, a.times.length, `${a.layer}/${a.keyPath}`);
    for (let i = 1; i < a.times.length; i++) assert.ok(a.times[i] >= a.times[i - 1], `${a.layer}/${a.keyPath} keyTimes decrease`);
    if (a.duration > 0) { near(a.times[0], 0); near(a.times.at(-1), 1); }
    assert.ok(a.beginTime >= 0 && a.beginTime + a.duration <= p.total + 1e-9, `${a.layer}/${a.keyPath} outside the plan`);
    assert.ok(p.layers.some(l => l.name === a.layer) || ['oldChip', 'oldTether'].includes(a.layer), a.layer);
  }
  assert.ok(p.budget.layers <= 30, `layers ${p.budget.layers}`);
  assert.ok(p.budget.visible <= 14, `visible ${p.budget.visible} in ${p.state}`);
  assert.ok(p.budget.clickAnimated <= 9, `click animations ${p.budget.clickAnimated}`);
}
// The dump's clock moves only on dumpClock lines. A frame list without any is spaced 1 s apart here, so each plan's motion
// has ended (and nothing has faded yet) when the next frame lands. Tests of overlaps give their own clock lines.
const spaced = frames => frames.some(f => 'dumpClock' in f) ? frames : frames.flatMap((f, i) => [clock(i), f]);
function effects(t, frames, flags) {
  const result = run(t, spaced(frames), flags);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n').map(JSON.parse);
  for (const line of lines) if (line.effect === 'draw') check(line);
  return lines;
}
const plans = (t, frames, flags) => effects(t, frames, flags).filter(e => e.effect === 'draw' || e.effect === 'drop');
const track = (p, layer, keyPath) => p.animations.find(a => a.layer === layer && a.keyPath === keyPath);
const span = (p, name) => p.phases[name]?.[1];
const options = { skip: macCommandSkip('xcrun') };
// A second frame after the first one, at the same point, so no entrance or glide runs.
const after = (frame, seq = 2) => [act(), { ...frame, seq }];

test('Split Seam+ timings follow D2 for every act state', options, t => {
  for (const [frame, phase, seconds] of [[act('click', { seq: 2 }), 'click', .21], [act('double', { seq: 2 }), 'double', .25],
    [act('right', { seq: 2 }), 'right', .22], [act('key', { seq: 2 }), 'keys', .06], [act('type', { seq: 2, beats: 3 }), 'keys', .18],
    [act('type', { seq: 2, rect: [60, 90, 200, 24] }), 'enter', .14], [act('type', { seq: 2 }), 'enter', .12],
    [act('scroll', { seq: 2, beats: 9, rect: [60, 40, 100, 160] }), 'ticks', .48], [act('scroll', { seq: 2 }), 'enter', .14],
    [act('drag', { seq: 2, rect: [80, 90, 60, 24], path: [[200, 100]] }), 'grab', .12], [act('drag', { seq: 2, path: [[200, 100]] }), 'grab', .09],
    [act('drag', { seq: 2, path: [[200, 100]] }), 'carry', .42], [act('drag', { seq: 2, path: [[200, 100]] }), 'drop', .2],
    [aim({ seq: 2, rect: [60, 90, 80, 24] }), 'wrap', .14], [aim({ seq: 2 }), 'open', .12]]) {
    const [, p] = plans(t, [act(), frame]);
    near(span(p, phase), seconds);
  }
  const [, scroll] = plans(t, after(act('scroll', { beats: 2 })));
  near(span(scroll, 'exit'), .12);
});

test('Split Seam+ statuses: thinking and waiting enter, cycle and park after 4.8 s; error, done and burst durations', options, t => {
  const [, thinking] = plans(t, after(status('thinking')));
  near(span(thinking, 'enter'), .14); near(span(thinking, 'cycles'), 4.8); near(span(thinking, 'settle'), .16);
  const [, waiting] = plans(t, after(status('waiting')));
  near(span(waiting, 'enter'), .16); near(span(waiting, 'steps'), 4.8);
  for (const p of [thinking, waiting]) {
    assert.ok(p.total <= .16 + 4.8 + .16 + 1e-9, `${p.state} parks by ${p.total}`);
    assert.ok(p.animations.every(a => a.beginTime + a.duration <= p.total + 1e-9));
  }
  // Waiting: 12 pixels on four layers (warm, cool and their dim twins), stepping 6 times.
  assert.deepEqual(waiting.layers.filter(l => l.name.startsWith('px')).map(l => l.name), ['px0', 'px1', 'px2', 'px3']);
  // Thinking: 6 orbiting pixels on two layers.
  assert.deepEqual(thinking.layers.filter(l => l.name.startsWith('px')).map(l => l.name), ['px0', 'px1']);
  const [, , approved] = plans(t, [act(), status('waiting', { seq: 2 }), act('click', { seq: 3 })]);
  near(span(approved, 'exit'), .14);
  const [, , afterThinking] = plans(t, [act(), status('thinking', { seq: 2 }), act('click', { seq: 3 })]);
  near(span(afterThinking, 'exit'), .12);
  const [, error, cleared] = plans(t, [act(), status('error', { seq: 2 }), act('click', { seq: 3 })]);
  near(span(error, 'error'), .24); near(span(cleared, 'exit'), .16);
  assert.ok(error.layers.some(l => l.name === 'cross' && l.keyline));
  assert.ok(track(error, 'cursor', 'transform.translation.x'), 'it shakes once');
  const [, done] = plans(t, after(status('done')));
  near(span(done, 'dissolve'), .38); assert.equal(span(done, 'burst'), undefined);
  const [, ok] = plans(t, after(status('done', { ok: true })));
  near(span(ok, 'burst'), .22); near(span(ok, 'dissolve'), .38);
  const [, back] = plans(t, after(status('handback')));
  near(span(back, 'dissolve'), .38); assert.equal(span(back, 'burst'), undefined);
});

test('Split Seam+ entrances are seeded: clasp 180, assemble 220, pop 200, the same for the same seed and seq', options, t => {
  const seen = new Map();
  for (let seq = 1; seq <= 40; seq++) {
    const [p] = plans(t, [act('click', { seq })], ['--cursor-style=ring', '--seed=7']);
    seen.set(p.entrance, span(p, 'entrance'));
    const [again] = plans(t, [act('click', { seq })], ['--cursor-style=ring', '--seed=7']);
    assert.equal(again.entrance, p.entrance); assert.deepEqual(again.animations, p.animations);
    if (seen.size === 3) break;
  }
  assert.deepEqual(Object.fromEntries(seen), { clasp: .18, assemble: .22, pop: .2 });
});

test('Split Seam+ click variation is seeded per session and seq, never random per frame', options, t => {
  const variation = (seed, seq) => plans(t, [act(), act('click', { seq })], ['--cursor-style=ring', '--seed=' + seed])[1].variation;
  assert.equal(variation(3, 2), variation(3, 2));
  assert.notEqual(variation(3, 2), variation(3, 3));
  assert.notEqual(variation(3, 2), variation(4, 2));
  const [, a] = plans(t, [act(), act('click', { seq: 2 })], ['--cursor-style=ring', '--seed=3']);
  const [, b] = plans(t, [act(), act('click', { seq: 2 })], ['--cursor-style=ring', '--seed=3']);
  assert.deepEqual(a.animations, b.animations);
});

test('Split Seam+ glide: distance timing, glance and reach in the first 70 ms, overshoot and settle, ribbon', options, t => {
  const [, p] = plans(t, [act(), act('click', { seq: 2, at: [300, 100], path: [[300, 100]] })]);
  near(p.glide, .25); near(span(p, 'click'), .21); near(p.phases.click[0], .25);
  for (const name of ['reach', 'reachInk', 'ribbonW', 'ribbonC']) assert.ok(p.layers.some(l => l.name === name && l.global), name);
  const reach = track(p, 'reach', 'strokeEnd');
  near(reach.beginTime, 0, .03); assert.ok(reach.times.some((time, i) => time * reach.duration <= .07 && reach.values[i] === 1), 'reach is out by 70 ms');
  const spark = track(p, 'spark', 'opacity');
  assert.ok(spark.values.some((v, i) => spark.times[i] * spark.duration + spark.beginTime <= .075 && v >= .69), 'the spark glances in 70 ms');
  // Stretch and lean from the glide's own velocity; the settle squashes after it.
  assert.ok(track(p, 'halves', 'transform').values.some(m => m[0] > 1.2), 'it stretches along travel');
  assert.ok(track(p, 'kC', 'transform.translation'), 'the halves lean');
  const position = track(p, 'cursor', 'position');
  assert.ok(position.values.some(xy => xy[0] > 300 && xy[0] <= 304.0001), 'overshoot up to 4 pt');
  let most = 0, least = Infinity;
  for (let seed = 1; seed <= 60; seed++) {
    const [, q] = plans(t, [act(), act('click', { seq: 2, at: [500, 100], path: [[500, 100]] })], ['--cursor-style=ring', '--seed=' + seed]);
    const over = Math.max(...track(q, 'cursor', 'position').values.map(xy => xy[0])) - 500;
    most = Math.max(most, over); least = Math.min(least, over);
  }
  assert.ok(most <= 4 + 1e-6 && least > 0, `overshoot ${least} to ${most} pt over 60 seeds`);
  t.diagnostic(`overshoot ${least.toFixed(2)} to ${most.toFixed(2)} pt over 60 seeds`);
  assert.deepEqual(position.values.at(-1), [300, 100]);
  const [far] = plans(t, [act('click', { path: [[-1000, 100], [100, 100]] })]).map(x => x);
  near(far.glide, .32);
  const [, short] = plans(t, [act(), act('click', { seq: 2, at: [120, 100], path: [[120, 100]] })]);
  assert.ok(!short.layers.some(l => l.name === 'reach'), 'no reach line under 30 pt');
  near(short.glide, .16);
});

test('Split Seam+ early action: an act landing mid-glide finishes the glide in 60 ms from where the ring is', options, t => {
  const [, glide, early] = plans(t, [act(), clock(1), aim({ seq: 2, at: [400, 300] }), clock(1.1), act('click', { seq: 3, at: [400, 300], path: [[400, 300]] })]);
  assert.ok(glide.glide > .2);
  near(span(early, 'snap'), .06); near(early.glide, .06);
  const start = track(early, 'cursor', 'position').values[0];
  assert.ok(start[0] > 100 && start[0] < 400, `starts mid-glide at ${start}`);
  assert.ok(!early.layers.some(l => l.name === 'reach'));
  const [, , late] = plans(t, [act(), aim({ seq: 2, at: [400, 300] }), act('click', { seq: 3, at: [400, 300], path: [[400, 300]] })]);
  assert.equal(late.phases.snap, undefined); near(late.glide, 0);
});

test('Split Seam+ wrap: aim, click tint, type, scroll and drag wrap the rect on a path with the circle segment count', options, t => {
  const rect = [60, 90, 100, 24];
  const [, wrapped] = plans(t, [act(), aim({ seq: 2, rect, label: 'Send' })]);
  assert.deepEqual(wrapped.rect, rect); near(wrapped.shape.w, 108); near(wrapped.shape.h, 32);
  const path = track(wrapped, 'aC', 'path');
  assert.equal(new Set(path.values.map(v => v.length)).size, 1, 'the morph keeps one segment count');
  assert.equal(path.values[0].length, 1 + 27);
  const [, , clicked] = plans(t, [act(), aim({ seq: 2, rect }), act('click', { seq: 3 })]);
  assert.ok(clicked.layers.some(l => l.name === 'tint' && l.kind === 'gradient'), 'a wrapped click flashes the tint');
  for (const frame of [act('type', { seq: 2, rect }), act('scroll', { seq: 2, rect }), act('drag', { seq: 2, rect, path: [[100, 100]] })]) {
    const [, p] = plans(t, [act(), frame]);
    assert.ok(p.shape.w > 29, frame.kind);
  }
  // A remembered aim rect serves the act that lands inside it.
  const [, , typed] = plans(t, [act(), aim({ seq: 2, rect }), act('type', { seq: 3 })]);
  assert.ok(typed.shape.w > 29);
});

test('Split Seam+ fallbacks: no rect stays a circle, no caret taps only, no ok no burst, no status nothing', options, t => {
  for (const frame of [aim({ seq: 2 }), act('type', { seq: 2 }), act('scroll', { seq: 2 }), act('drag', { seq: 2, path: [[100, 100]] }), act('click', { seq: 2 })]) {
    const [, p] = plans(t, [act(), frame]);
    near(p.shape.w, 28, 1e-6); assert.equal(p.rect, null, frame.kind);
    assert.ok(!p.layers.some(l => l.name === 'tint'));
  }
  // Without a caret the seams tap and the rotation stays put; with one the bottom seam rides it.
  const rect = [60, 90, 200, 24];
  const [, plain] = plans(t, [act(), act('type', { seq: 2, rect, beats: 3 })]);
  near(plain.shape.rot, 0); near(plain.shape.sp, 0);
  assert.ok(track(plain, 'aW', 'transform.translation') && track(plain, 'aC', 'transform.translation'), 'the halves tap in turn');
  const [, riding] = plans(t, [act(), act('type', { seq: 2, rect, beats: 3, caretX: 90 })]);
  assert.notEqual(riding.shape.rot, 0); assert.ok(riding.shape.sp > .9); near(riding.shape.sy, riding.shape.oy + riding.shape.h / 2);
  // Done without ok, done under reduced motion and handback never burst.
  for (const [frame, flags] of [[status('done'), undefined], [status('done', { ok: true }), ['--cursor-style=ring', '--reduce-motion']], [status('handback'), undefined]]) {
    const [, p] = plans(t, after(frame), flags);
    assert.equal(p.phases.burst, undefined);
  }
  // With no thinking status the ring just fades 1.2 s after the act.
  const lines = effects(t, [act()]);
  const draw = lines.find(l => l.effect === 'draw');
  assert.deepEqual(draw.timers, [[draw.total, 'park'], [draw.total + 1.2, 'fade'], [draw.total + 1.42, 'release']]);
});

test('Split Seam+ reduced motion: crossfades, no momentum, no orbit, no steps, no shake, no burst', options, t => {
  const flags = ['--cursor-style=ring', '--reduce-motion'];
  const ps = plans(t, [act(), act('click', { seq: 2, at: [300, 100], path: [[300, 100]] }), aim({ seq: 3, rect: [250, 80, 100, 40] }),
    status('thinking', { seq: 4 }), status('waiting', { seq: 5 }), status('error', { seq: 6 }), status('done', { seq: 7, ok: true })], flags);
  const [first, glide, wrap, thinking, waiting, error, done] = ps;
  assert.equal(first.entrance, 'fade');
  near(glide.glide, .14);
  assert.ok(track(glide, 'cursor', 'opacity').values.includes(0), 'the glide fades out and in');
  assert.ok(track(wrap, 'cursor', 'opacity').values.includes(0), 'the wrap crossfades');
  for (const p of ps) {
    assert.ok(!track(p, 'halves', 'transform'), `no stretch in ${p.state}`);
    assert.ok(!p.layers.some(l => ['reach', 'ribbonW'].includes(l.name)));
    assert.ok(!track(p, 'cursor', 'transform.translation.x'), 'no shake');
  }
  assert.equal(thinking.phases.cycles, undefined); assert.equal(waiting.phases.steps, undefined);
  assert.ok(error.layers.some(l => l.name === 'cross'));
  assert.equal(done.phases.burst, undefined); near(span(done, 'dissolve'), .38);
});

test('ring runtime: every state parks with 0 running animations, then fades and releases with 0 timers left', options, t => {
  for (const frame of [status('thinking'), act('click'), aim({ rect: [60, 90, 100, 24] }), status('error')]) {
    const lines = effects(t, [act(), { ...frame, seq: 2 }]);
    const draws = lines.filter(l => l.effect === 'draw'), last = draws.at(-1);
    const after = lines.slice(lines.indexOf(last) + 1);
    assert.deepEqual(after.map(l => l.effect), ['park', 'fade', 'release', 'end'], frame.state ?? frame.kind);
    const park = after[0].time;
    near(park, last.time + last.total);
    assert.equal(last.animations.filter(a => last.time + a.beginTime + a.duration > park + 1e-9).length, 0, 'running after the park');
    near(after[1].time, park + 1.2); near(after[2].time, park + 1.42);
    assert.deepEqual(after.at(-1), { effect: 'end', idle: true, pending: 0, timers: 0 });
  }
  // Waiting parks still and stays up until the next frame, up to the 120 s cap.
  const waiting = effects(t, after(status('waiting')));
  const last = waiting.filter(l => l.effect === 'draw').at(-1), rest = waiting.slice(waiting.indexOf(last) + 1);
  assert.deepEqual(rest.map(l => l.effect), ['park', 'fade', 'release', 'end']);
  near(rest[0].time, last.time + last.total); near(rest[1].time, last.time + 120); near(rest[2].time, last.time + 120.22);
  const answered = effects(t, [act(), clock(1), status('waiting', { seq: 2 }), clock(60), act('click', { seq: 3 })]);
  assert.deepEqual(answered.filter(l => l.effect === 'draw').map(l => l.state), ['click', 'waiting', 'click']);
  assert.ok(!answered.some(l => l.effect === 'fade' && l.time < 60), 'waiting is still up a minute later');
  // Done and handback release when the dissolve ends.
  const done = effects(t, after(status('done')));
  assert.deepEqual(done.slice(-3).map(l => l.effect), ['park', 'release', 'end']);
  assert.equal(done.at(-1).idle, true);
});

test('ring runtime: aim and statuses queue behind a delayed act, and a terminal status or hide cancels it', options, t => {
  const lines = effects(t, [act('click', { delayMs: 300, at: [200, 100], path: [[200, 100]] }), clock(.1), aim({ seq: 2, at: [150, 100] }),
    clock(.15), status('thinking', { seq: 3 }), clock(.2), status('waiting', { seq: 4 })]);
  const draws = lines.filter(l => l.effect === 'draw');
  assert.deepEqual(draws.map(d => d.state), ['click', 'aim', 'thinking', 'waiting']);
  for (const d of draws) near(d.time, .3);
  // The reviewer's case: a thinking status that lands while the click waits out its delay plays after it and stays.
  const review = effects(t, [act(), clock(1), act('click', { seq: 2, delayMs: 470, at: [300, 100], path: [[300, 100]] }), clock(1.001), status('thinking', { seq: 3 })]);
  const order = review.filter(l => l.effect === 'draw');
  assert.deepEqual(order.map(d => d.state), ['click', 'click', 'thinking']);
  near(order[1].time, 1.47); near(order[2].time, 1.47);
  assert.deepEqual(order[2].at, [300, 100], 'thinking plays at the click');
  assert.equal(review.filter(l => l.effect === 'park').at(-1).time > 1.47 + 4.8, true, 'thinking parks after its cycles');
  for (const terminal of [status('done', { seq: 2, at: [10, 10] }), status('error', { seq: 2, at: [10, 10] }), status('handback', { seq: 2, at: [10, 10] }), { hand: 'hide', nonce }]) {
    const states = effects(t, [act('click', { delayMs: 300 }), clock(.1), terminal]).filter(l => l.effect === 'draw').map(d => d.state);
    assert.ok(!states.includes('click'), JSON.stringify(terminal));
  }
});

test('ring runtime: a missing window hides the ring, including a delayed act after waiting', options, t => {
  const lines = effects(t, [status('waiting', { at: [50, 50] }), act('click', { seq: 2, windowId: 7, delayMs: 100 })], ['--cursor-style=ring', '--gone=7']);
  assert.deepEqual(lines.map(l => l.effect).filter(e => e !== 'park'), ['draw', 'hide', 'end']);
  assert.equal(lines.at(-1).idle, true);
  const gone = effects(t, [status('waiting', { at: [50, 50], windowId: 7 })], ['--cursor-style=ring', '--gone=7']);
  assert.deepEqual(gone.map(l => l.effect), ['hide', 'end']);
});

test('ring plans: aim glides from the last point and the hold breathes without extending host time', options, t => {
  const [, p] = plans(t, [act(), aim({ seq: 2, at: [400, 300], holdMs: 450 })]);
  assert.ok(p.glide > .2); near(span(p, 'hold'), .45);
  assert.ok(track(p, 'aC', 'path'), 'the circle breathes');
  const [, still] = plans(t, [act(), aim({ seq: 2, at: [400, 300], holdMs: 450 })], ['--cursor-style=ring', '--reduce-motion']);
  assert.equal(still.phases.hold, undefined);
});

test('ring plans: drag paths of 3 or more points carry in at most 0.42 s with monotonic tracks', options, t => {
  const path = Array.from({ length: 64 }, (_, i) => [100 + i * 10, 100 + (i % 2) * 40]);
  const [, drag] = plans(t, [act(), act('drag', { seq: 2, path })]);
  near(span(drag, 'carry'), .42);
  assert.deepEqual(drag.at, path.at(-1));
  const [, seam] = plans(t, [act(), act('drag', { seq: 2, path: [[100, 20], [100, 110], [180, 110]] })], ['--cursor-style=seam']);
  near(span(seam, 'carry'), .42);
});

test('ring plans: secure input hides labels and suppresses type and key taps', options, t => {
  for (const kind of ['type', 'key']) {
    const [, p] = plans(t, [act(), act(kind, { seq: 2, label: 'Private', beats: 4, caretX: 120 })], ['--cursor-style=ring', '--secure-input']);
    assert.equal(p.label, null); assert.equal(p.chip, null);
    assert.ok(p.layers.some(l => l.name === 'aW') && p.layers.some(l => l.name === 'aC'));
    for (const layer of ['kW', 'aW', 'kC', 'aC']) assert.equal(track(p, layer, 'transform.translation'), undefined, `${kind} ${layer}`);
    assert.equal(p.phases.keys, undefined);
  }
});

test('ring plans: the chip fades in only on a new label, crossfades a change, and labels are plain text', options, t => {
  const [first, same, changed] = plans(t, [aim({ label: 'Send' }), act('click', { seq: 2, label: 'Send' }), act('click', { seq: 3, label: 'Save' })]);
  assert.ok(track(first, 'chip', 'opacity'));
  assert.equal(track(same, 'chip', 'opacity'), undefined, 'an unchanged label does not blink');
  assert.equal(same.layers.find(l => l.name === 'chip').props.opacity, 1);
  assert.equal(track(changed, 'oldChip', 'opacity').duration, .06); assert.equal(track(changed, 'oldTether', 'opacity').duration, .06);
  assert.equal(track(changed, 'chip', 'opacity').beginTime, .06);
  const [clean] = plans(t, [act('click', { label: '‮Send\nnow\u0007‏' })]);
  assert.equal(clean.label, 'Sendnow');
  const [emoji] = plans(t, [act('type', { label: '😀'.repeat(45), beats: 4 })]);
  assert.equal([...emoji.label].length, 40);
  const [zalgo] = plans(t, [act('click', { label: 'a' + '́'.repeat(200) + 'b' })]);
  assert.ok([...zalgo.label].length <= 40 && zalgo.label.normalize('NFD').length <= 80);
  const ps = plans(t, [act('click', { at: [390, 12], label: 'Send' }), act('click', { seq: 2, at: [12, 190], label: 'Save' })], ['--cursor-style=ring', '--clip=0,0,400,200']);
  assert.ok(ps[0].chip.frame[0] < 390 && ps[0].chip.frame[1] > 12);
  assert.ok(ps[1].chip.frame[0] > 12 && ps[1].chip.frame[1] < 190);
});

test('plain Split Seam (seam) shares the state machine without Split Seam+ moves', options, t => {
  const flags = ['--cursor-style=seam'];
  const [first, glide, thinking, waiting] = plans(t, [act(), act('click', { seq: 2, at: [300, 100], path: [[300, 100]] }), status('thinking', { seq: 3 }), status('waiting', { seq: 4 })], flags);
  assert.equal(first.entrance, 'fade'); near(glide.glide, .25);
  assert.ok(glide.layers.some(l => l.name === 'ribbonW') && !glide.layers.some(l => l.name === 'reach'));
  assert.ok(!track(glide, 'halves', 'transform'), 'no momentum');
  assert.ok(!thinking.layers.some(l => l.name.startsWith('px'))); near(thinking.shape.o, .35);
  assert.ok(!waiting.layers.some(l => l.name.startsWith('px')));
  const [, done] = plans(t, after(status('done', { ok: true })), flags);
  assert.equal(done.phases.burst, undefined); assert.ok(done.layers.some(l => l.name === 'px0'), 'the dissolve stays');
  const [, typed] = plans(t, after(act('type', { rect: [60, 90, 200, 24], caretX: 90 })), flags);
  near(typed.shape.w, 28 - 0, 1e-6); near(typed.shape.qz, 9);
});

test('ring plans: palette and layer budget across a full session', options, t => {
  const rect = [60, 90, 100, 24];
  const ps = plans(t, [act(), aim({ seq: 2, rect, label: 'Send' }), act('click', { seq: 3, label: 'Send' }), status('thinking', { seq: 4 }),
    act('type', { seq: 5, rect, beats: 6, caretX: 80 }), act('drag', { seq: 6, at: [300, 200], rect: [280, 190, 60, 24], path: [[400, 260]] }),
    act('scroll', { seq: 7, rect: [380, 100, 100, 200], beats: 3 }), status('waiting', { seq: 8 }), act('click', { seq: 9 }),
    status('error', { seq: 10 }), status('done', { seq: 11, ok: true })]);
  for (const p of ps) check(p);
  const [click] = ps.filter(p => p.state === 'click');
  assert.deepEqual(click.layers.find(l => l.name === 'aW').color, [1, 122 / 255, 61 / 255, 1]);
  assert.deepEqual(click.layers.find(l => l.name === 'aC').color, [91 / 255, 141 / 255, 1, 1]);
  assert.deepEqual(click.layers.find(l => l.name === 'kW').color, [11 / 255, 13 / 255, 20 / 255, .55]);
  t.diagnostic(`budget max ${JSON.stringify(ps.reduce((m, p) => ({ layers: Math.max(m.layers, p.budget.layers), visible: Math.max(m.visible, p.budget.visible),
    clickAnimated: Math.max(m.clickAnimated, p.budget.clickAnimated) }), { layers: 0, visible: 0, clickAnimated: 0 }))}`);
});

test('ring plans: target memory is window-bound, and a status with no point is dropped without hiding or cancelling', options, t => {
  const lines = effects(t, [act(), clock(.5), status('waiting', { seq: 2, windowId: 1 }), clock(.6), status('thinking', { seq: 3 })]);
  assert.deepEqual(lines.filter(l => ['draw', 'drop', 'hide'].includes(l.effect)).map(l => l.effect + ':' + l.state), ['draw:click', 'drop:waiting', 'draw:thinking']);
  assert.equal(lines.filter(l => l.effect === 'drop').length, 1);
  // The reviewer's case: a delayed click, then a point-free thinking before anything was placed. The click still draws.
  const pending = effects(t, [act('click', { delayMs: 300 }), clock(.05), status('thinking', { seq: 2 })]);
  assert.deepEqual(pending.filter(l => ['draw', 'drop', 'hide'].includes(l.effect)).map(l => l.effect + ':' + l.state), ['draw:click', 'draw:thinking']);
  const unplaced = effects(t, [status('thinking')]);
  assert.deepEqual(unplaced.map(l => l.effect), ['drop', 'end']);
});

test('ring runtime: a point-free status mid-glide plays at the glide destination', options, t => {
  for (const state of ['thinking', 'error', 'done']) {
    const lines = effects(t, [act(), clock(1), act('click', { seq: 2, at: [300, 100], path: [[300, 100]] }), clock(1.1), status(state, { seq: 3 })]);
    const p = lines.filter(l => l.effect === 'draw').at(-1);
    assert.deepEqual(p.at, [300, 100], state);
    near(span(p, 'snap'), .06);
    const start = track(p, 'cursor', 'position').values[0];
    assert.ok(start[0] > 100 && start[0] < 300, `${state} starts from the glide at ${start}`);
  }
});

test('ring runtime: an act during a done or handback dissolve enters again', options, t => {
  for (const state of ['done', 'handback']) {
    const lines = effects(t, [act(), clock(1), status(state, { seq: 2 }), clock(1.2), act('click', { seq: 3, at: [200, 100], path: [[200, 100]] })]);
    const p = lines.filter(l => l.effect === 'draw').at(-1);
    assert.equal(p.state, 'click'); assert.ok(p.entrance, state);
    assert.ok(span(p, 'entrance') > 0); near(p.shape.o, 1); near(p.shape.ho, 1); near(p.shape.pdis, 0);
  }
});

test('ring runtime: a repeated status inside its plan changes nothing', options, t => {
  const lines = effects(t, [act(), clock(1), status('thinking', { seq: 2 }), clock(1.5), status('thinking', { seq: 3 }), clock(7), status('thinking', { seq: 4 })]);
  assert.deepEqual(lines.filter(l => l.effect === 'draw').map(l => l.time), [0, 1, 7]);
});

test('ring frames enforce exact keys, nonce, sequence, numeric bounds and types', options, t => {
  for (const frame of [aim({ holdMs: 601 }), aim({ holdMs: -1 }), aim({ holdMs: true }), aim({ rect: [0, 0, -1, 2] }),
    aim({ rect: [0, 0, 1] }), aim({ rect: [0, 0, 1, true] }), aim({ kind: 'unknown' }), aim({ label: 1 }), aim({ surprise: 1 }),
    status('unknown'), status('thinking', { at: [1] }), status('done', { label: 'extra' }), status('error', { pid: true }),
    status('done', { ok: 1 }), status('error', { ok: true }), status('waiting', { ok: false }),
    act('click', { label: {} }), act('click', { caretX: 10 }), act('type', { caretX: true }), act('type', { caretX: 100001 }),
    act('click', { rect: [0, 0, 0, 1] }), status('waiting', { nonce: 'x' }), aim({ seq: true }), aim({ seq: 9007199254740992 }),
    aim({ pid: 0 }), aim({ windowId: 4294967296 }), aim({ at: [100001, 0] }), aim({ at: [true, 0] }), status('waiting', { surprise: false }),
    status('waiting', { state: 1 }), clock(-1), { dumpClock: true }, { dumpClock: 1, extra: 1 }]) {
    assert.equal(run(t, [frame]).status, 65, JSON.stringify(frame));
  }
  for (const tail of [status('done', { nonce: 'b'.repeat(64), seq: 2 }), status('done'), aim()]) assert.equal(run(t, [act(), tail]).status, 65);
  assert.equal(run(t, [act(), clock(1), clock(.5)]).status, 65, 'the clock never goes back');
  const bad = run(t, [act(), aim({ seq: 2, holdMs: 601 }), act('click', { seq: 3 })]);
  assert.equal(bad.status, 65); assert.equal(bad.stdout.trim().split('\n').filter(l => JSON.parse(l).effect === 'draw').length, 1);
  for (const flags of [['--cursor-style=other'], ['--cursor-style=ring', '--cursor-style=seam'], ['--reduce-motion', '--reduce-motion'],
    ['--clip=0,0,-1,2'], ['--seed=x'], ['--gone=1,x'], ['--surprise']]) assert.equal(run(t, [], flags).status, 64, flags.join(' '));
  const [hidden, fresh] = effects(t, [act(), { hand: 'hide', nonce }, status('thinking', { seq: 2 })]).filter(l => l.effect !== 'draw' && l.effect !== 'park').slice(0, 2);
  assert.equal(hidden.state, 'hidden'); assert.equal(fresh.dropped, true);
});

test('glove accepts and drops aim, status, labels, rects and carets', options, t => {
  const lines = effects(t, [aim({ label: 'Ignored' }), status('waiting', { seq: 2 }), act('type', { seq: 3, label: 'Ignored', rect: [1, 1, 2, 2], caretX: 4 })], ['--cursor-style=glove']);
  assert.deepEqual(lines.map(l => l.effect), ['drop', 'drop', 'drop', 'end']);
  const none = effects(t, [act()], []);
  assert.deepEqual(none.map(l => l.effect), ['drop', 'end'], 'glove is the dump default');
});

test('ring mode: launch styles are strict and the live reader accepts or rejects new frames without drawing', options, t => {
  for (const style of ['glove', 'ring', 'seam']) {
    const frames = [aim({ label: 'Accepted', rect: [1, 1, 20, 20] }), status('thinking', { seq: 2 }), act('type', { seq: 3, label: 'Accepted', caretX: 4 }),
      status('done', { seq: 4, ok: true })];
    const result = spawnSync(build(t), ['--hand', '--cursor-style=' + style], {
      input: frames.map(f => JSON.stringify(f) + '\n').join(''), encoding: 'utf8', timeout: 10000, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
    });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '');
    const bad = spawnSync(build(t), ['--hand', '--cursor-style=' + style], { input: JSON.stringify(aim({ holdMs: 601 })) + '\n', encoding: 'utf8', timeout: 10000 });
    assert.equal(bad.status, 65); assert.equal(bad.stdout, '');
  }
  for (const args of [['--hand', '--cursor-style=other'], ['--hand', '--cursor-style=ring', '--cursor-style=seam']]) {
    assert.equal(spawnSync(build(t), args, { input: '', encoding: 'utf8', timeout: 10000 }).status, 64);
  }
});

test('ring source: Core Animation only, no timer, display link or per-frame Swift callback', () => {
  const source = readFileSync(sourcePath, 'utf8');
  const section = name => source.match(new RegExp(`// BEGIN ${name}\\n([\\s\\S]*?)// END ${name}`))?.[1];
  const ring = section('RING PLAN') + section('RING RUNTIME');
  assert.doesNotMatch(ring, /\bTimer\b|CADisplayLink|DispatchQueue|asyncAfter|repeatCount/);
  const host = section('HAND HOST');
  assert.doesNotMatch(host, /CADisplayLink|repeatCount/);
  // The host's ring code keeps one one-shot wake-up.
  const ringHost = host.slice(host.indexOf('var ringEnvironment'), host.indexOf('func installRing'));
  assert.equal((ringHost.match(/asyncAfter/g) ?? []).length, 1);
  assert.doesNotMatch(ringHost, /Timer/);
});
