import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { macCommandSkip } from './requirements.mjs';

const nonce = 'a'.repeat(64);
const target = { nonce, seq: 1, pid: 2147483647, windowId: 4294967295 };
const act = (kind = 'click', extra = {}) => ({ hand: 'act', ...target, kind, at: [100, 100], path: [[100, 100]], delayMs: 0, beats: 1, ...extra });
const aim = extra => ({ hand: 'aim', ...target, kind: 'click', at: [100, 100], holdMs: 0, ...extra });
const status = (state, extra = {}) => ({ hand: 'status', ...target, state, ...extra });
let binary;
function build(t) {
  if (binary) return binary;
  const dir = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-ring-'))));
  const output = join(dir, 'consent-host');
  const started = performance.now();
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(),
    new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url).pathname, '-o', output], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  binary = output;
  t.diagnostic(`compileMs=${Math.round(performance.now() - started)} binaryBytes=${statSync(binary).size}`);
  return binary;
}
function run(t, frames, flags = []) {
  return spawnSync(build(t), ['--ring-plan-dump', ...(flags.includes('--cursor-style=glove') ? [] : ['--cursor-style=ring']), ...flags], {
    input: frames.map(f => JSON.stringify(f) + '\n').join(''), encoding: 'utf8', timeout: 10000,
    env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
  });
}
function plans(t, frames, flags) {
  const result = run(t, frames, flags);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const options = { skip: macCommandSkip('xcrun') };

test('ring plans: all act states use the specified timings and bounded layers', options, t => {
  for (const [kind, seconds] of [['click', .21], ['double', .25], ['right', .22], ['key', .06], ['type', .3], ['scroll', .36], ['drag', .29]]) {
    const [p] = plans(t, [act(kind, { beats: kind === 'type' ? 3 : 1 })]);
    assert.equal(p.state, kind); near(p.total, seconds);
    assert.ok(p.layers.length <= 10);
    for (const a of p.animations) {
      for (const key of ['layer', 'keyPath', 'from', 'to', 'beginTime', 'duration']) assert.ok(key in a, key);
      assert.ok(a.duration > 0 && a.beginTime >= 0);
    }
  }
});

test('ring plans: distance glide uses a quadratic bow and a two-color seam ribbon', options, t => {
  const [first, p] = plans(t, [act(), act('click', { seq: 2, at: [300, 100], path: [[300, 100]] })]);
  near(first.glide, 0); near(p.glide, .25); near(p.total, .46);
  assert.ok(p.animations.some(a => a.layer === 'cursor' && a.keyPath === 'position' && a.path?.some(c => c[0] === 2)));
  for (const name of ['warmTrail', 'coolTrail']) assert.ok(p.animations.some(a => a.layer === name && a.keyPath === 'strokeEnd'));
  const [far] = plans(t, [act('click', { path: [[-1000, 100], [100, 100]] })]);
  near(far.glide, .32);
});

test('ring plans: aim rect is a single rounded frame, hold never extends host time', options, t => {
  const [a] = plans(t, [aim({ rect: [20, 30, 200, 40], holdMs: 600, label: 'Send' })]);
  assert.equal(a.state, 'aim'); near(a.total, .14);
  assert.deepEqual(a.rect, [20, 30, 200, 40]);
  assert.equal(a.layers.filter(l => l.name === 'lock').length, 1);
  assert.equal(a.label, 'Send');
  const [point] = plans(t, [aim({ holdMs: 0 })]); near(point.total, .12);
});

test('ring plans: waiting holds one breath until the next frame; thinking is static and dim', options, t => {
  const ps = plans(t, [status('waiting', { at: [70, 80] }), status('thinking', { seq: 2 })]);
  assert.equal(ps[0].hold, true);
  const breath = ps[0].animations.filter(a => a.repeat === true);
  assert.equal(breath.length, 1); near(breath[0].duration, 1.6);
  assert.equal(ps[1].state, 'thinking'); assert.deepEqual(ps[1].at, [70, 80]);
  assert.equal(ps[1].animations.length, 0); near(ps[1].opacity, .35);
});

test('ring plans: error shakes once for 240ms, done and handback dissolve diagonally', options, t => {
  const [error, done, back] = plans(t, [status('error', { at: [70, 80] }), status('done', { seq: 2 }), status('handback', { seq: 3 })]);
  near(error.total, .24);
  assert.ok(error.animations.some(a => a.keyPath === 'transform.translation.x' && a.duration === .24));
  assert.ok(error.layers.some(l => l.name === 'cross'));
  for (const p of [done, back]) {
    near(p.total, .38);
    const pixels = p.layers.filter(l => l.name.startsWith('pixel'));
    assert.equal(pixels.length, 12);
    assert.equal(new Set(pixels.map(l => JSON.stringify(l.color))).size, 2);
    const moves = p.animations.filter(a => a.layer.startsWith('pixel') && a.keyPath === 'position');
    assert.equal(moves.length, 12);
    assert.ok(moves.every(a => (a.to[0] - a.from[0]) * (a.to[1] - a.from[1]) < 0));
  }
});

test('ring plans: reduced motion fades glides and removes shakes, breaths, pixels and pulses', options, t => {
  const ps = plans(t, [act(), act('right', { seq: 2, at: [200, 100] }), status('waiting', { seq: 3 }),
    status('error', { seq: 4 }), status('done', { seq: 5 })], ['--reduce-motion']);
  near(ps[1].glide, .07);
  assert.ok(ps[1].animations.some(a => a.layer === 'cursor' && a.keyPath === 'opacity' && a.duration === .07));
  for (const p of ps) {
    assert.ok(p.animations.every(a => !a.repeat && !a.keyPath.startsWith('transform')));
    assert.ok(p.layers.every(l => !l.name.startsWith('pixel')));
  }
});

test('ring plans: labels truncate by character and secure input suppresses labels and type taps', options, t => {
  const [p] = plans(t, [act('type', { label: '😀'.repeat(45), beats: 4 })]);
  assert.equal([...p.label].length, 40);
  const [secure] = plans(t, [act('type', { label: 'Private', beats: 4 })], ['--secure-input']);
  assert.equal(secure.label, null); near(secure.total, .12);
  assert.ok(secure.animations.every(a => !a.layer.endsWith('Tap')));
});

test('ring plans: glove accepts and drops aim, status and labels', options, t => {
  const ps = plans(t, [aim({ label: 'Ignored' }), status('waiting', { seq: 2 }), act('click', { seq: 3, label: 'Ignored' })], ['--cursor-style=glove']);
  for (const p of ps) { assert.equal(p.dropped, true); assert.equal(p.animations.length, 0); }
});

test('ring plans: new frames enforce exact keys, nonce, sequence, numeric bounds and types', options, t => {
  for (const frame of [aim({ holdMs: 601 }), aim({ holdMs: -1 }), aim({ holdMs: true }), aim({ rect: [0, 0, -1, 2] }),
    aim({ rect: [0, 0, 1] }), aim({ rect: [0, 0, 1, true] }), aim({ kind: 'unknown' }), aim({ label: 1 }), aim({ surprise: 1 }),
    status('unknown'), status('thinking', { at: [1] }), status('done', { label: 'extra' }), status('error', { pid: true }),
    act('click', { label: {} }), status('waiting', { nonce: 'x' })]) {
    assert.equal(run(t, [frame]).status, 65, JSON.stringify(frame));
  }
  for (const tail of [status('done', { nonce: 'b'.repeat(64), seq: 2 }), status('done'), aim()]) {
    assert.equal(run(t, [act(), tail]).status, 65);
  }
  const [hidden, fresh] = plans(t, [act(), { hand: 'hide', nonce }, status('thinking', { seq: 2 })]).slice(1);
  assert.equal(hidden.state, 'hidden'); assert.equal(fresh.dropped, true);
});

test('ring plans: chips flip inside the target clip and crossfade without retaining secure labels', options, t => {
  const ps = plans(t, [act('click', { at: [390, 12], label: 'Send' }), act('click', { seq: 2, at: [12, 190], label: 'Save' }),
    status('thinking', { seq: 3 })], ['--clip=0,0,400,200']);
  assert.ok(ps[0].chip.frame[0] < 390 && ps[0].chip.frame[1] > 12);
  assert.ok(ps[1].chip.frame[0] > 12 && ps[1].chip.frame[1] < 190);
  assert.ok(ps[1].animations.some(a => a.layer === 'oldChip' && a.keyPath === 'opacity' && a.duration === .06));
  assert.ok(ps[1].animations.some(a => a.layer === 'chip' && a.keyPath === 'opacity' && a.duration === .09 && a.beginTime === .06));
  assert.equal(ps[2].animations.length, 0, 'thinking draws a static dim only');
  const [s] = plans(t, [aim({ label: 'Secret' })], ['--secure-input']);
  assert.equal(s.chip, null);
});

test('ring plans: path extrema, drag carry, alternating taps and palette match Split Seam', options, t => {
  const [drag] = plans(t, [act('drag', { at: [10, 20], path: [[100, 20], [100, 110]] })]);
  assert.deepEqual(drag.at, [100, 110]); near(drag.total, .29 + 2 * .1895);
  const [typing] = plans(t, [act('type', { beats: 3 })]);
  assert.deepEqual(typing.animations.filter(a => a.keyPath === 'transform.translation.y').map(a => a.layer), ['warm','warm','cool','cool','warm','warm']);
  assert.deepEqual(typing.layers.find(l => l.name === 'warm').color, [1,122/255,61/255,1]);
  assert.deepEqual(typing.layers.find(l => l.name === 'cool').color, [91/255,141/255,1,1]);
  assert.deepEqual(typing.layers.find(l => l.name === 'ink').color, [11/255,13/255,20/255,.55]);
  const [error] = plans(t, [status('error', { at: [1, 1] })]);
  assert.ok(error.animations.some(a => a.keyPath === 'path' && a.duration === .09), 'the red halves recoil');
});

test('ring mode: launch styles are strict and the live reader accepts or rejects new frames without drawing', options, t => {
  for (const style of ['glove', 'ring']) {
    const frames = [aim({ label: 'Accepted' }), status('thinking', { seq: 2 }), act('type', { seq: 3, label: 'Accepted' })];
    const result = spawnSync(build(t), ['--hand', '--cursor-style=' + style], {
      input: frames.map(f => JSON.stringify(f) + '\n').join(''), encoding: 'utf8', timeout: 10000,
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
    });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '');
    const bad = spawnSync(build(t), ['--hand', '--cursor-style=' + style], {
      input: JSON.stringify(aim({ holdMs: 601 })) + '\n', encoding: 'utf8', timeout: 10000,
    });
    assert.equal(bad.status, 65); assert.equal(bad.stdout, '');
  }
  for (const flags of [['--cursor-style=other'], ['--cursor-style=ring','--cursor-style=glove'], ['--reduce-motion','--reduce-motion'], ['--clip=0,0,-1,2']]) {
    const result = run(t, [], flags); assert.equal(result.status, 64);
  }
});

test('ring plans: monochrome marks retain the ink keyline and the click return has a spring', options, t => {
  for (const [frame, mark] of [[act('right'), 'menu'], [status('error', { at: [10, 10] }), 'cross']]) {
    const [p] = plans(t, [frame]);
    assert.equal(p.layers.find(l => l.name === mark).keyline, true);
  }
  const [p] = plans(t, [act()]);
  assert.ok(p.animations.some(a => a.layer === 'warm' && a.keyPath === 'path' && a.beginTime === .06 && a.values?.length === 3));
});

test('ring plans: target memory is window-bound, all optional fields default, and a bad frame stops the stream', options, t => {
  const [first, changed, returned] = plans(t, [act(), status('waiting', { seq: 2, windowId: 1 }), status('thinking', { seq: 3 })]);
  assert.equal(first.dropped, false); assert.equal(changed.dropped, true); assert.equal(returned.dropped, true);
  const frame = aim(); delete frame.holdMs;
  const [defaultHold] = plans(t, [frame]); near(defaultHold.total, .12);
  for (const frame of [aim({ seq: true }), aim({ seq: 9007199254740992 }), aim({ pid: 0 }), aim({ windowId: 4294967296 }),
    aim({ at: [100001, 0] }), aim({ at: [true, 0] }), status('waiting', { surprise: false }), status('waiting', { state: 1 })]) {
    assert.equal(run(t, [frame]).status, 65, JSON.stringify(frame));
  }
  const bad = run(t, [act(), aim({ seq: 2, holdMs: 601 }), act('click', { seq: 3 })]);
  assert.equal(bad.status, 65); assert.equal(bad.stdout.trim().split('\n').length, 1);
});

test('ring plans: the ink path follows each typing half tap', options, t => {
  const [p] = plans(t, [act('type', { beats: 3 })]);
  const taps = p.animations.filter(a => a.layer === 'ink' && a.keyPath === 'path' && a.beginTime >= .12);
  assert.equal(taps.length, 6);
  near(taps[0].duration, .025); near(taps[1].duration, .035);
  assert.notDeepEqual(taps[0].from, taps[0].to);
  assert.deepEqual(taps[0].from, taps[1].to);
});
