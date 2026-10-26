import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { macCommandSkip } from './requirements.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';

// The ghost hand's host is the consent host in hand mode. These tests build it and feed it frames, but never show the panel:
// every frame names a window that doesn't exist, so the host validates it and draws nothing.
const sourcePath = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url).pathname;
const source = readFileSync(sourcePath, 'utf8');
const section = name => source.match(new RegExp(`// BEGIN ${name}\\n([\\s\\S]*?)// END ${name}`))?.[1];
const nonce = 'a'.repeat(64), other = 'b'.repeat(64);
// pid 2^31-1 and window 2^32-1 belong to nothing, so the window lookup fails and nothing is drawn.
const act = (seq, over = {}) => ({ hand: 'act', nonce, seq, kind: 'click', pid: 2147483647, windowId: 4294967295,
  at: [100.5, 200], path: [[40, 60], [100.5, 200]], delayMs: 0, beats: 1, ...over });
const line = frame => (typeof frame === 'string' ? frame : JSON.stringify(frame)) + '\n';

test('hand source: it never posts input, moves the pointer, activates or takes key; stdout only acknowledges controls', () => {
  // The pause panel is its own section inside the host, checked below. The host's one stdout write is the clear acknowledgment.
  const pausePanel = section('CURSOR PAUSE PANEL');
  const host = section('HAND HOST')?.replace(/\/\/ BEGIN CURSOR PAUSE PANEL[\s\S]*?\/\/ END CURSOR PAUSE PANEL/, '');
  const frame = section('HAND FRAME'), art = section('HAND ART'), motion = section('HAND MOTION');
  const ring = section('RING PLAN'), runtime = section('RING RUNTIME'), tail = section('HAND FRAME TAIL'), picker = section('CURSOR PICKER');
  assert.ok(host && frame && art && motion && ring && runtime && tail && picker && pausePanel, 'hand sections absent');
  const withoutAck = host.replace(/if let bytes = try\? JSONSerialization.data\(withJSONObject: \["hand": "clear-ready", "nonce": nonce, "token": token\]\) \{\s*FileHandle.standardOutput.write\(bytes \+ Data\(\[10\]\)\)\s*\}/, '');
  assert.notEqual(withoutAck, host, 'clear acknowledgment absent');
  // The picker answers the relay on stdout, nonce-bound, through one writer (plus its dump mode); it posts no input either.
  assert.match(picker, /func writeCursorPickerEvent[\s\S]*?nonceBook\.nonce\("hand"\)/);
  assert.doesNotMatch(picker, /CGEventPost|\.post\(|postToPid|CGWarp|NSCursor|activate\(|makeMain|AXUIElement|NSLog/);
  // Narration writes stdout through one helper (its secure-input answer and dump modes), and never opens capture or a network.
  const narration = section('NARRATION');
  assert.ok(narration, 'narration section absent');
  assert.equal(narration.match(/standardOutput/g)?.length, 1);
  assert.match(narration, /func narrationJSON[^\n]*\n[^\n]*\n\s*FileHandle\.standardOutput\.write/);
  assert.doesNotMatch(narration, /CGEventPost|\.post\(|postToPid|CGWarp|NSCursor|activate\(|makeKey|makeMain|becomeKey\(|orderFront\(|AXUIElement|print\(|NSLog|AVCapture|AVAudioSession|URLSession/);
  // The pause control builds events only in its dump self-test, to check the person-input rule; it posts none.
  assert.doesNotMatch(pausePanel, /CGEventPost|\.post\(|postToPid|CGWarp|NSCursor|activate\(|makeKey|makeMain|becomeKey\(|orderFront\(|AXUIElement|print\(|NSLog/);
  // Reading a delivered event's source fields (the person-input check, and its dump self-test) is allowed; posting one is not.
  for (const text of [withoutAck, frame, tail, art, motion, ring, runtime]) {
    assert.doesNotMatch(text, /CGEventPost|\.post\(|postToPid|CGWarp|NSCursor|activate\(|makeKey|makeMain|becomeKey\(|orderFront\(|AXUIElement|standardOutput|print\(|NSLog/);
  }
  // No section of the host posts an event, anywhere in the file.
  assert.doesNotMatch(source, /CGEventPost|\.post\(tap|postToPid/);
  assert.match(host, /orderFrontRegardless\(\)/);
  assert.match(host, /IsSecureEventInputEnabled\(\)/);
  assert.match(motion, /CAKeyframeAnimation\(keyPath: keyPath\)/);
});

test('hand art: the six delivered states are embedded as vector SVG on one 48 pt canvas, with no files at runtime', () => {
  const art = section('HAND ART');
  for (const state of ['rest', 'point', 'press', 'grab', 'scroll', 'dabs']) {
    const svg = art.match(new RegExp(`\\.${state}: ##"""\\n([\\s\\S]*?)\\n"""##`))?.[1];
    assert.ok(svg, state + ' absent');
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 48 48" width="48" height="48">/, state);
    assert.match(svg, new RegExp(`state "${state}"\\. Canvas 48 pt, hotspot \\(10,10\\)`), state);
    assert.match(svg, /<\/svg>$/, state);
  }
  // The palette: ivory and its shadow side, the navy halo, and the dabs' blues.
  for (const colour of ['#EFE9DC', '#B9BFC9', '#141A26', '#A9C4F5', '#7299EA', '#4E79D9']) assert.ok(art.includes(colour), colour);
  assert.doesNotMatch(art, /contentsOfFile|Bundle\.main|URL\(fileURLWithPath/);
});

// One compile for the file, removed when the process exits.
let built;
function build() {
  if (built) return built;
  const dir = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-hand-host-'))));
  const binary = join(dir, 'consent-host');
  const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), sourcePath, '-o', binary], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return (built = binary);
}
const run = (binary, args, input) => spawnSync(binary, args, { input, encoding: 'utf8', timeout: 60000, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } });

test('hand mode: 1,000 hand frames and a hide give 0 bytes on stdout and a clean exit', { skip: macCommandSkip('xcrun') }, t => {
  const binary = build();
  const kinds = ['click', 'double', 'right', 'key', 'type', 'drag', 'scroll'];
  let input = '';
  for (let seq = 1; seq <= 1000; seq++) {
    input += line(act(seq, { kind: kinds[seq % kinds.length], beats: 1 + seq % 3, delayMs: seq % 2 ? 0 : 5,
      path: Array.from({ length: 1 + seq % 64 }, (_, i) => [i * 3.25, -i * 1.5]) }));
    if (seq % 250 === 0) input += line({ hand: 'hide', nonce });
  }
  const result = run(binary, ['--hand'], input);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Buffer.byteLength(result.stdout), 0);
});

test('hand mode: what the client writes is what the host accepts, for every kind and fitted value', { skip: macCommandSkip('xcrun') }, async () => {
  const binary = build();
  const { createHandClient } = await import('../plugins/sleight/lib/hand/client.mjs');
  const { setHandPid } = await import('../plugins/sleight/lib/hand/pid.mjs');
  let text = '';
  const { EventEmitter } = await import('node:events');
  const child = Object.assign(new EventEmitter(), { pid: 1, stdout: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { writableLength: 0, write: chunk => { text += chunk; }, end() {} }) });
  const client = createHandClient({ setting: () => ({ enabled: true }), built: () => true,
    prepare: async () => ({ status: 'ready', spawn: () => child }) });
  const kinds = ['click', 'double', 'right', 'key', 'type', 'drag', 'scroll'];
  for (let i = 0; i < 300; i++) {
    client.send({ kind: kinds[i % 7], pid: 2147483647, windowId: 4294967295, at: [i * 1.337, -i / 3],
      path: i % 5 ? Array.from({ length: i % 90 }, (_, j) => [j / 7, j * 1.1]) : undefined, delayMs: i % 3 ? i * 41 : undefined, beats: i % 30 });
    if (i % 100 === 99) client.hide();
    await new Promise(resolve => setImmediate(resolve));
  }
  setHandPid(0);
  assert.equal(text.split('\n').length - 1, 304, 'a menu frame, 300 acts and 3 hides');
  const result = run(binary, ['--hand'], text);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, '');
});

test('hand mode: each malformed, unbound or replayed frame exits 65, with stdout empty or the control-gone notice', { skip: macCommandSkip('xcrun') }, t => {
  const binary = build();
  const cases = {
    'not JSON': 'click 1 2',
    'consent frame': { id: 'x', nonce, choices: ['once', 'cancel'], deadline: Date.now() + 60000, data: {} },
    'unknown verb': { hand: 'show', nonce },
    'short nonce': act(1, { nonce: 'a'.repeat(63) }),
    'upper-case nonce': act(1, { nonce: 'A'.repeat(64) }),
    'hide with extra key': { hand: 'hide', nonce, seq: 1 },
    'extra key': act(1, { text: 'secret' }),
    'missing key': (({ beats, ...rest }) => rest)(act(1)),
    'unknown kind': act(1, { kind: 'hover' }),
    'boolean pid': act(1, { pid: true }),
    'zero pid': act(1, { pid: 0 }),
    'fractional window': act(1, { windowId: 1.5 }),
    'window past 32 bits': act(1, { windowId: 4294967296 }),
    'string point': act(1, { at: ['1', 2] }),
    'three-number point': act(1, { at: [1, 2, 3] }),
    'far point': act(1, { at: [100001, 0] }),
    'empty path': act(1, { path: [] }),
    'path of 65': act(1, { path: Array.from({ length: 65 }, () => [0, 0]) }),
    'bad point in path': act(1, { path: [[0, 0], [0, null]] }),
    'negative delay': act(1, { delayMs: -1 }),
    'long delay': act(1, { delayMs: 10001 }),
    'no beats': act(1, { beats: 0 }),
    'too many beats': act(1, { beats: 21 }),
    'negative seq': act(-1),
    'oversized line': JSON.stringify(act(1)).replace('"click"', '"click"' + ' '.repeat(9000)),
  };
  for (const [name, frame] of Object.entries(cases)) {
    const result = run(binary, ['--hand'], line(frame));
    assert.equal(result.status, 65, name + ': ' + result.stderr);
    assert.equal(result.stdout, '', name);
  }
  // The first frame binds the nonce; a later frame with another nonce, or a seq that doesn't increase, ends the host.
  // Its only output is the control-gone notice on the bound nonce, so the relay can replace the pause control.
  for (const [name, frames] of Object.entries({
    'second nonce': [act(1), act(2, { nonce: other })],
    'hide with another nonce': [act(1), { hand: 'hide', nonce: other }],
    'repeated seq': [act(1), act(1)],
    'seq going back': [act(5), act(4)],
  })) {
    const result = run(binary, ['--hand'], frames.map(line).join(''));
    assert.equal(result.status, 65, name);
    assert.deepEqual(result.stdout.split('\n').filter(Boolean).map(text => JSON.parse(text)), [{ hand: 'control-gone', nonce }], name);
  }
  // Valid frames before the bad one were drawn or skipped quietly, and still nothing reached stdout.
  const good = run(binary, ['--hand'], [act(1), act(2), { hand: 'hide', nonce }].map(line).join(''));
  assert.equal(good.status, 0, good.stderr); assert.equal(good.stdout, '');
});

test('hand mode: arguments other than its own modes exit 64 without drawing', { skip: macCommandSkip('xcrun') }, t => {
  const binary = build();
  for (const args of [['--hand', 'extra'], ['--hand-demo'], ['--hand-demo', '1,2,3'], ['--hand-demo', '0,0,0,10'], ['--hand-demo', 'a,b,c,d'], ['--unknown'],
    ['--hand', '--capture=shown'], ['--hand', '--capture='], ['--hand', '--capture=visible', '--capture=hidden'], ['--hand', '--capture', 'visible'],
    ['--hand-dump', '--capture=readOnly'], ['--hand-demo', '0,0,10,10', '--capture=none'], ['--capture=visible', '--hand']]) {
    const result = run(binary, args, '');
    assert.equal(result.status, 64, args.join(' ')); assert.equal(result.stdout, '');
  }
  // Both capture modes run hand mode the same way.
  for (const capture of ['hidden', 'visible']) {
    const result = run(binary, ['--hand', '--capture=' + capture], [act(1), act(2, { kind: 'drag' }), { hand: 'hide', nonce }].map(line).join(''));
    assert.equal(result.status, 0, capture + ': ' + result.stderr); assert.equal(result.stdout, '');
  }
});

test('hand dump: capture visible makes the panel readOnly so screenshots show it, and nothing else changes', { skip: macCommandSkip('xcrun') }, () => {
  const binary = build();
  const dumps = [[], ['--capture=hidden'], ['--capture=visible']].map(args => {
    const result = run(binary, ['--hand-dump', ...args], '');
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  });
  assert.deepEqual([dumps[0].capture, dumps[0].panel.sharingType], ['hidden', 'none']);
  assert.deepEqual(dumps[1], dumps[0]);
  assert.deepEqual([dumps[2].capture, dumps[2].panel.sharingType], ['visible', 'readOnly']);
  assert.deepEqual({ ...dumps[2], capture: 'hidden', panel: { ...dumps[2].panel, sharingType: 'none' } }, dumps[0]);
});

test('hand dump: the panel has exactly the flags of the design, never shown, with the art at 1x and 2x', { skip: macCommandSkip('xcrun') }, t => {
  const binary = build();
  const result = run(binary, ['--hand-dump'], '');
  assert.equal(result.status, 0, result.stderr);
  const dump = JSON.parse(result.stdout);
  t.diagnostic(JSON.stringify(dump.art));
  assert.deepEqual(dump.panel, {
    borderless: true, nonactivatingPanel: true, canBecomeKey: false, canBecomeMain: false, ignoresMouseEvents: true,
    hasShadow: false, opaque: false, backgroundAlpha: 0, level: 3, sharingType: 'none',
    collectionBehavior: ['fullScreenAuxiliary', 'ignoresCycle', 'stationary', 'transient'],
    accessibilityElement: false, contentAccessibilityElement: false, hidesOnDeactivate: false, visible: false,
  });
  assert.equal(dump.capture, 'hidden');
  const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) < 1e-6, `${what}: ${actual} is not ${expected}`);
  // Layers: the dabs under the glove, siblings on one 48 pt canvas anchored on the hotspot (10, 10).
  assert.deepEqual(dump.layers.map(l => [l.isDabs, l.isGlove, l.bounds]), [[true, false, [0, 0, 48, 48]], [false, true, [0, 0, 48, 48]]]);
  for (const layer of dump.layers) { near(layer.anchor[0], 10 / 48, 'anchor x'); near(layer.anchor[1], 38 / 48, 'anchor y'); }
  // The art: every state at 48 and 96 px, its paint on the hotspot and nothing 4 pt beyond it up-left, ivory glove, blue dabs.
  assert.deepEqual([dump.art.opacity, dump.art.lifted, dump.art.canvas, dump.art.hotspot, dump.art.axis], [0.85, 0.6, 48, [10, 10], [0.574, 0.819]]);
  for (const state of ['rest', 'point', 'press', 'grab', 'scroll']) {
    const art = dump.art[state];
    assert.deepEqual(art.pixels, [[48, 48], [96, 96]], state);
    assert.ok(art.hotspotAlpha > 0.5, `${state} paints the hotspot (${art.hotspotAlpha})`);
    assert.ok(art.beyondTipAlpha < 0.05, `${state} has nothing past the tip (${art.beyondTipAlpha})`);
    assert.ok(art.ivory > 300 && art.blue === 0, `${state} is the ivory glove (${art.ivory}, ${art.blue})`);
  }
  assert.ok(dump.art.dabs.blue > 40 && dump.art.dabs.ivory === 0 && dump.art.dabs.hotspotAlpha === 0, JSON.stringify(dump.art.dabs));
  // Frame to state: what the glove shows while it approaches and while it acts.
  assert.deepEqual(dump.states, { click: ['point', 'press'], double: ['point', 'press'], right: ['point', 'press'], key: ['point', 'point'],
    type: ['point', 'point'], scroll: ['scroll', 'scroll'], drag: ['point', 'grab'] });
  // The timing table of the spec.
  const { glides, ease, ...table } = dump.timing;
  assert.deepEqual(table, { entry: 0.16, glideBase: 0.22, glidePerPoint: 0.00025, glideMax: 0.42, flourish: 0.15, scroll: 0.2, grab: 0.09,
    lift: 0.22, silence: 1.5, fade: 0.3, crossfade: 0.07, trail: 0.05, entryOffset: 18, hold: 3, liftOffset: 10, fadeOffset: 14,
    scrollDrop: 5, typeStep: 1.5, pecks: 6, pressScale: 0.93, grabScale: 0.95, tilt: -0.22 });
  [0.22, 0.245, 0.32, 0.42].forEach((value, i) => near(glides[i], value, 'glide ' + i));
  near(ease[0], 0, 'ease 0'); near(ease[2], 1, 'ease 1'); assert.ok(ease[1] > 0.8, 'the out curve is past 80% at half time');
  // Each kind's plan for (100, 100) to (160, 200), entering fresh: entry, glide by distance, the flourish, the lift.
  const glide = d => Math.min(0.42, 0.22 + 0.00025 * d), length = Math.hypot(60, 100), back = (p, d) => [p[0] + 0.574 * d, p[1] + 0.819 * d];
  const expected = {
    click: [0.16 + glide(length) + 0.15 + 0.22, ['point', 'press', 'rest']], double: [0.16 + glide(length) + 0.3 + 0.22, ['point', 'press', 'rest']],
    right: [0.16 + glide(length) + 0.15 + 0.22, ['point', 'press', 'rest']], key: [0.16 + glide(length + 3) + 0.15 + 0.22, ['point', 'rest']],
    type: [0.16 + glide(length + 3) + 0.9 + 0.22, ['point', 'rest']], scroll: [0.16 + glide(length) + 0.2 + 0.22, ['scroll', 'rest']],
    drag: [0.16 + 0.09 + glide(60) + 0.09 + 0.22, ['point', 'grab', 'rest']],
  };
  for (const [kind, [total, states]] of Object.entries(expected)) {
    near(dump.plans[kind].total, total, kind + ' total'); assert.deepEqual(dump.plans[kind].states, states, kind);
  }
  // Secure input skips the pecks; the hand still arrives and lifts.
  near(dump.plans.type.secureTotal, 0.16 + glide(length + 3) + 0.22, 'secure type'); near(dump.plans.click.secureTotal, dump.plans.click.total, 'secure click');
  // The lift ends 10 pt back along the axis from where the hand acted, and the fade drifts to 14 pt.
  back([160, 200], 10).forEach((v, i) => near(dump.plans.click.rest[i], v, 'click rest'));
  back([160, 200], 14).forEach((v, i) => near(dump.plans.click.fadeTo[i], v, 'click fade'));
  back(back([160, 200], 3).map((v, i) => i ? v : v + 1.5 * 5), 10).forEach((v, i) => near(dump.plans.type.rest[i], v, 'type rest'));
  back([220, 200], 10).forEach((v, i) => near(dump.plans.drag.rest[i], v, 'drag rest'));
  // A frame during the hold has no entry: it glides on from where the hand is.
  near(dump.continuing.total, glide(length) + 0.15 + 0.22, 'continuing click');
  // A route from (100, 100) to (160, 200) gets a panel of its box plus 48 pt, clipped to a window at (60, 0) sized 200 by 200,
  // in global top-left points as [x, y, width, height].
  assert.deepEqual(dump.box, { unclipped: [52, 52, 156, 196], clipped: [60, 52, 148, 148] });
  // After the fade's release the host holds no panel and no scheduled work.
  assert.equal(dump.idle, true);
});


test('explicit hide removes the panel before capture acknowledgement, without its idle fade', () => {
  const host = source.slice(source.indexOf('final class HandHost:'));
  const hide = host.match(/func hide\(\) \{([\s\S]*?)\n    \}/)?.[1];
  assert.match(hide, /fading\?\.cancel\(\); release\(\)/);
  assert.doesNotMatch(hide, /fade\(after:/);
  assert.match(source, /DispatchQueue\.global\(qos: \.utility\)/);
  // The shared host also serves consent cards. Its frame reader alone uses utility QoS.
  assert.doesNotMatch(source, /pthread_set_qos_class_self_np\(QOS_CLASS_UTILITY, 0\)/);
});
