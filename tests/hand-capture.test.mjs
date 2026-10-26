// H5, the ghost hand capture test: the pixel rules, the verdicts and the whole run against a fake Mac.
import test from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { compareFrames, classify, handColoured, modeVerdict, decision, SOURCES } from '../bench/hand/pixels.mjs';
import { underLiveLock, runCaptureTest, pickRegion, covering, panelUp, handWire, captureCommand, engineImage, parseArgs, readFrame, summary,
  ENGINE_ACQUIRE, DOCUMENT_LAUNCH } from '../bench/hand/h5-capture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const over = (rgb, alpha, page = [255, 255, 255]) => rgb.map((c, i) => Math.round(c * alpha + page[i] * (1 - alpha)));
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

// A white page with one black text line, as TextEdit draws a plain-text window.
function page(width = 60, height = 40) {
  const data = new Uint8Array(width * height * 4).fill(255);
  for (let x = 4; x < 50; x++) for (const y of [8, 9]) data.set([20, 20, 20, 255], (y * width + x) * 4);
  return { width, height, data };
}
// The same page with a glove-sized patch: ivory at the hand's acting opacity and a few dab pixels.
function withHand(frame, { ivory = 100, dabs = 9, alpha = 0.85 } = {}) {
  const data = Uint8Array.from(frame.data), w = frame.width;
  for (let i = 0; i < ivory; i++) data.set([...over(hex('#EFE9DC'), alpha), 255], ((20 + Math.floor(i / 10)) * w + 30 + (i % 10)) * 4);
  for (let i = 0; i < dabs; i++) data.set([...over(hex('#4E79D9'), alpha * 0.92), 255], (32 * w + 10 + i) * 4);
  return { ...frame, data };
}

test('the hand\'s paint over a white page counts as hand-coloured at every opacity it rests at; text and grey do not', () => {
  for (const colour of ['#EFE9DC', '#B9BFC9', '#A3ABB7', '#A9C4F5', '#7299EA', '#4E79D9']) {
    for (const alpha of [0.85, 0.6, 0.6 * 0.92]) assert.ok(handColoured(...over(hex(colour), alpha)), `${colour} at ${alpha}`);
  }
  for (const neutral of [[255, 255, 255], [20, 20, 20], [128, 128, 128], [200, 201, 203], [0, 0, 0]]) assert.equal(handColoured(...neutral), false, String(neutral));
});

test('compareFrames counts pixels moved past the tolerance and the hand-coloured ones among them', () => {
  const base = page();
  assert.deepEqual(compareFrames(base, page()), { differing: 0, handLike: 0 });
  const shot = withHand(base);
  const c = compareFrames(base, shot);
  assert.equal(c.differing, 109); assert.equal(c.handLike, 109);
  assert.deepEqual(c.box, [10, 20, 30, 13]);
  // A change within the tolerance is no change; text moving is a change that isn't the hand.
  const nudged = { ...base, data: Uint8Array.from(base.data).fill(250) };
  assert.equal(compareFrames(base, nudged).differing, 92, 'only the text moved past 8');
  const moved = { ...base, data: Uint8Array.from(base.data) };
  moved.data.set([20, 20, 20, 255], (12 * 60 + 5) * 4);
  assert.deepEqual([compareFrames(base, moved).differing, compareFrames(base, moved).handLike], [1, 0]);
  assert.equal(compareFrames(base, page(61, 40)).sizeMismatch, true);
});

test('classify: 0 differing pixels leaves the hand out; a noisy path falls back to 0 hand pixels; 40 hand pixels show it', () => {
  assert.equal(classify({ differing: 0, handLike: 0 }), 'excluded');
  assert.equal(classify({ differing: 3, handLike: 0 }), 'trace');
  assert.equal(classify({ differing: 3, handLike: 0 }, { noise: 5 }), 'excluded');
  assert.equal(classify({ differing: 30, handLike: 12 }, { noise: 5 }), 'trace');
  assert.equal(classify({ differing: 300, handLike: 40 }), 'shown');
  assert.equal(classify({ sizeMismatch: true }), 'error');
});

const up = (source, result, extra = {}) => ({ source, handUp: true, result, ...extra });
const full = (mode, overrides = {}) => Object.keys(SOURCES).flatMap(source => Array.from({ length: 5 }, () =>
  up(source, overrides[source] ?? (mode === 'visible' && SOURCES[source] === 'user' ? 'shown' : 'excluded'), { hitPid: 500, frontPid: 1 })));

test('modeVerdict: what each mode expects of sleight\'s own, the user\'s and one-window captures', () => {
  assert.equal(modeVerdict('hidden', full('hidden'), { hostPid: 9 }).verdict, 'pass');
  assert.equal(modeVerdict('visible', full('visible'), { hostPid: 9 }).verdict, 'pass');
  const engine = modeVerdict('hidden', full('hidden', { engine: 'shown' }), { hostPid: 9 });
  assert.equal(engine.verdict, 'fail'); assert.match(engine.reasons[0], /engine: hand pixels in 5 of 5 captures \(sleight's own screenshot\)/);
  assert.equal(modeVerdict('hidden', full('hidden', { composite: 'trace' }), { hostPid: 9 }).verdict, 'fail');
  assert.equal(modeVerdict('visible', full('visible', { hover: 'shown' }), { hostPid: 9 }).verdict, 'fail');
  // A visible hand that never shows where it should means the zeros prove nothing.
  const blind = modeVerdict('visible', full('visible', { region: 'excluded' }), { hostPid: 9 });
  assert.equal(blind.verdict, 'inconclusive'); assert.match(blind.reasons[0], /so a zero elsewhere proves nothing/);
  // One-window captures showing the hand are reported, not failed.
  const single = modeVerdict('visible', full('visible', { 'window-l': 'shown' }), { hostPid: 9 });
  assert.equal(single.verdict, 'pass'); assert.match(single.notes[0], /window-l showed hand pixels in 5 of 5/);
  // The panel has to be on screen for a capture to count.
  const down = full('hidden').map((s, i) => s.source === 'engine' && i % 5 < 2 ? { ...s, handUp: false } : s);
  assert.equal(modeVerdict('hidden', down, { hostPid: 9 }).verdict, 'inconclusive');
  assert.equal(modeVerdict('hidden', full('hidden').map(s => ({ ...s, hitPid: 9 })), { hostPid: 9 }).verdict, 'fail');
  assert.equal(modeVerdict('hidden', full('hidden').map(s => ({ ...s, frontPid: 9 })), { hostPid: 9 }).verdict, 'fail');
  assert.match(modeVerdict('hidden', full('hidden').map(({ hitPid, ...s }) => s), { hostPid: 9 }).notes.at(-1), /no AX hit test/);
});

test('decision: visible may be offered only when both modes pass', () => {
  assert.equal(decision({ verdict: 'pass' }, { verdict: 'pass' }).capture, 'visible-allowed');
  assert.equal(decision({ verdict: 'pass' }, { verdict: 'fail' }).capture, 'hidden-only');
  assert.equal(decision({ verdict: 'inconclusive' }, { verdict: 'pass' }).capture, 'not-proven');
});

const TARGET = { pid: 500, id: 77, bounds: { x: 100, y: 100, width: 800, height: 600 } };
const win = (id, pid, layer, bounds, alpha = 1) => ({ id, pid, layer, alpha, bounds });

test('the region is the window\'s body, or the first quarter nobody covers; covered windows skip region captures', () => {
  const alone = [win(77, 500, 0, TARGET.bounds)];
  assert.deepEqual(pickRegion(TARGET, alone).rect, { x: 124, y: 160, width: 752, height: 516 });
  // A Terminal window over the left half: the region moves to the right top quarter.
  const terminal = win(5, 42, 0, { x: 0, y: 0, width: 480, height: 900 });
  assert.deepEqual(pickRegion(TARGET, [terminal, ...alone]).rect, { x: 500, y: 160, width: 376, height: 258 });
  assert.match(pickRegion(TARGET, [win(5, 42, 0, { x: 0, y: 0, width: 2000, height: 2000 }), ...alone]).covered, /cover every part/);
  // Behind the target, the menu bar, an invisible window and the hand itself don't cover it.
  const harmless = [win(9, 900, 3, { x: 200, y: 200, width: 100, height: 100 }), win(1, 30, 24, { x: 0, y: 0, width: 2000, height: 24 }),
    win(2, 31, 0, { x: 0, y: 0, width: 2000, height: 2000 }, 0), ...alone, win(3, 32, 0, { x: 0, y: 0, width: 2000, height: 2000 })];
  assert.deepEqual(covering({ x: 124, y: 160, width: 752, height: 516 }, TARGET, harmless, [900]), []);
  // Any other window over the region covers it, whatever its layer: the Dock, a floating panel, an overlay.
  for (const layer of [3, 20, 25, 1000]) {
    assert.equal(covering({ x: 124, y: 160, width: 752, height: 516 }, TARGET, [win(8, 33, layer, { x: 100, y: 600, width: 900, height: 80 }), ...alone]).length, 1, `layer ${layer}`);
  }
  assert.equal(panelUp(harmless, 900, TARGET), true);
  assert.equal(panelUp(harmless, 901, TARGET), false);
});

test('hand wire frames have exactly the host\'s keys, one nonce and rising seq', () => {
  const wire = handWire();
  assert.match(wire.nonce, /^[0-9a-f]{64}$/);
  const a = JSON.parse(wire.act({ pid: 500, windowId: 77, at: [300, 300], from: [250, 280] }));
  const b = JSON.parse(wire.act({ pid: 500, windowId: 77, at: [250, 280] }));
  assert.deepEqual(Object.keys(a).sort(), ['at', 'beats', 'delayMs', 'hand', 'kind', 'nonce', 'path', 'pid', 'seq', 'windowId']);
  assert.deepEqual([a.seq, b.seq, a.path, b.path, a.kind, a.nonce === b.nonce], [0, 1, [[250, 280], [300, 300]], [[250, 280]], 'click', true]);
  assert.deepEqual(JSON.parse(wire.hide()), { hand: 'hide', nonce: wire.nonce });
  // The host's own parser (consent-host.swift) asks for exactly these keys, plus the ring's optional label, rect and caretX,
  // and narration's optional say.
  const swift = readFileSync(join(root, 'plugins/sleight/lib/direct-browser/native/consent-host.swift'), 'utf8');
  assert.match(swift, /let actKeys: Set<String> = \["hand", "nonce", "seq", "kind", "pid", "windowId", "at", "path", "delayMs", "beats"\]/);
  assert.match(swift, /Set\(data\.keys\)\.subtracting\(actKeys\)\.isSubset\(of: \["label", "rect", "caretX", "say"\]\)/);
});

test('capture commands: hover\'s region call, a one-window -l without shadow, and the helper\'s ScreenCaptureKit paths', () => {
  const ctx = { target: TARGET, rect: { x: 124.4, y: 160, width: 752, height: 516.6 }, hostPid: 900, png: '/w/a.png', raw: '/w/a.rgba' };
  assert.deepEqual(captureCommand('region', ctx), { tool: 'screencapture', args: ['-x', '-R124,160,752,517', '/w/a.png'], decode: true });
  // hover.js builds the same argument from the app's rectangle.
  assert.match(readFileSync(join(root, 'plugins/sleight/lib/hover.js'), 'utf8'), /\['-x', '-R' \+ \[b\.X, b\.Y, b\.Width, b\.Height\]\.map\(Math\.round\)\.join\(','\), path\]/);
  assert.deepEqual(captureCommand('window-l', ctx).args, ['-x', '-o', '-l77', '/w/a.png']);
  assert.deepEqual(captureCommand('sck-window', ctx).args, ['sck-window', '77', '/w/a.rgba']);
  assert.deepEqual(captureCommand('composite', ctx).args, ['sck-composite', '77', '900', '/w/a.rgba']);
  assert.deepEqual(captureCommand('engine', ctx), { tool: 'engine', decode: true });
  assert.throws(() => captureCommand('display', ctx), /unknown capture/);
  assert.equal(ENGINE_ACQUIRE, 'var app = await cua.getApp("com.apple.TextEdit")');
  assert.deepEqual(DOCUMENT_LAUNCH.slice(0, 3), ['--args', '-ApplePersistenceIgnoreState', 'YES']);
});

test('engineImage takes the last image block; readFrame checks the raw size; arguments are bounded', () => {
  const png = Buffer.from('png-bytes');
  assert.deepEqual(engineImage({ content: [{ type: 'text', text: 'x' }, { type: 'image', data: 'AA==', mimeType: 'image/jpeg' },
    { type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] }), { bytes: png, extension: 'png' });
  assert.throws(() => engineImage({ content: [{ type: 'text', text: 'no image' }] }), /no screenshot/);
  const dir = mkdtempSync(join(tmpdir(), 'h5-raw-'));
  try {
    writeFileSync(join(dir, 'f.rgba'), Buffer.alloc(2 * 3 * 4));
    assert.deepEqual(readFrame(join(dir, 'f.rgba'), { width: 2, height: 3 }).data.length, 24);
    assert.throws(() => readFrame(join(dir, 'f.rgba'), { width: 3, height: 3 }), /has 24 bytes/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(parseArgs(['--owner-away']), { ownerAway: true, samples: 5, keepImages: false, out: undefined, host: undefined,
    helper: undefined, receipt: undefined, style: 'glove', dryRun: false });
  assert.equal(parseArgs(['--cursor-style', 'sprite', '--dry-run']).style, 'sprite');
  assert.throws(() => parseArgs(['--cursor-style', 'pet']), /--cursor-style must be one of glove, ring, seam, sprite/);
  assert.throws(() => parseArgs(['--samples', '2']), /from 3 to 20/);
});

// A fake Mac: the hand host's panel is up between its first act frame and a hide or close; policy decides which capture
// paths show it.
function fakeMac({ shows = (mode, source) => mode === 'visible' && ['region', 'composite'].includes(source), draws = true,
  fadeKeeps = false, hitHost = false, cover, coverAfter = Infinity } = {}) {
  let listings = 0;
  let host, hosts = 0, fading = false;
  const calls = [];
  const deps = {
    windows: async () => ({ front: 1, windows: [
      ...(cover && ++listings > coverAfter ? [cover] : cover && coverAfter === Infinity ? [cover] : []),
      ...(host?.up && draws ? [win(900 + hosts, host.pid, 3, { x: 300, y: 300, width: 200, height: 200 })] : []),
      win(77, 500, 0, TARGET.bounds)] }),
    capture: async (source, { hostPid, label }) => {
      calls.push(label);
      const visibleHand = hostPid && host?.up && draws && shows(host.mode, label.includes('hover') ? 'hover' : source);
      const frame = visibleHand ? withHand(page()) : page();
      // ScreenCaptureKit lists a visible (.readOnly) panel as shareable and leaves a hidden (.none) one out.
      if (source === 'composite') frame.handWindows = hostPid && host?.up && draws && host.mode === 'visible' ? [900] : [];
      return frame;
    },
    hit: async () => (hitHost ? host.pid : 500),
    startHost: async mode => {
      hosts++;
      host = { mode, pid: 4000 + hosts, up: false, lines: [] };
      const mine = host;
      return { pid: mine.pid, write: line => { mine.lines.push(JSON.parse(line)); const f = mine.lines.at(-1);
        if (f.hand === 'act') mine.up = true; if (f.hand === 'hide') { fading = fadeKeeps; mine.up = fadeKeeps; } },
      close: async () => { mine.up = false; } };
    },
    sleep: async () => { if (fading) { fading = false; } },
  };
  return { deps, calls, host: () => host };
}

test('a clean Mac: hidden keeps every capture clean, visible shows only the user\'s captures, and visible may be offered', async () => {
  const mac = fakeMac();
  const report = await runCaptureTest(mac.deps, { target: TARGET, samples: 3 });
  assert.equal(report.ok, true, summary(report));
  assert.equal(report.decision.capture, 'visible-allowed');
  assert.deepEqual(report.modes.hidden.sources.engine, { taken: 3, counted: 3, excluded: 3, shown: 0, trace: 0, error: 0, skipped: 0 });
  assert.equal(report.modes.visible.sources.composite.shown, 3);
  assert.equal(report.modes.visible.sources.hover.excluded, 3);
  assert.deepEqual([report.modes.hidden.panelShareable, report.modes.visible.panelShareable], ['0 of 3', '3 of 3']);
  assert.equal(report.modes.visible.samples.find(s => s.source === 'composite').shareableHandWindows, 1);
  assert.deepEqual(report.noise, { engine: 0, region: 0, 'window-l': 0, 'sck-window': 0, composite: 0, hover: 0 });
  assert.deepEqual(Object.values(report.drift), [0, 0, 0, 0, 0]);
  // Two baselines per path, five paths and a hover per sample in each mode, then a third baseline.
  assert.equal(mac.calls.length, 5 * 2 + 2 * 3 * 6 + 5);
  // Every frame the host got is bound to one nonce with rising seq, and hover's probe ends in a hide.
  const lines = mac.host().lines;
  assert.ok(lines.every(f => f.nonce === lines[0].nonce));
  assert.ok(lines.filter(f => f.hand === 'act').every((f, i, all) => i === 0 || f.seq > all[i - 1].seq));
  assert.equal(lines.filter(f => f.hand === 'hide').length, 3);
  assert.match(summary(report), /PASS \(visible-allowed\)/);
});

test('an engine screenshot with the hand in it fails hidden, and the default cannot rest on sharingType none', async () => {
  const report = await runCaptureTest(fakeMac({ shows: (mode, source) => source === 'engine' || (mode === 'visible' && ['region', 'composite'].includes(source)) }).deps,
    { target: TARGET, samples: 3 });
  assert.equal(report.modes.hidden.verdict, 'fail');
  assert.equal(report.decision.capture, 'not-proven');
});

test('a fading hand in hover\'s capture 100 ms after the hide fails visible: keep hidden', async () => {
  const report = await runCaptureTest(fakeMac({ fadeKeeps: true,
    shows: (mode, source) => mode === 'visible' && ['region', 'composite', 'hover'].includes(source) }).deps, { target: TARGET, samples: 3 });
  assert.equal(report.modes.hidden.verdict, 'pass');
  assert.equal(report.modes.visible.verdict, 'fail');
  assert.match(report.modes.visible.reasons.join('\n'), /hover: hand pixels in 3 of 3 captures \(sleight's own screenshot\)/);
  assert.equal(report.decision.capture, 'hidden-only');
});

test('a host that never draws, an AX hit on the panel and a covered window are inconclusive or failed, never passed', async () => {
  const blind = await runCaptureTest(fakeMac({ draws: false }).deps, { target: TARGET, samples: 3 });
  assert.deepEqual([blind.modes.hidden.verdict, blind.modes.visible.verdict, blind.ok], ['inconclusive', 'inconclusive', false]);
  const hit = await runCaptureTest(fakeMac({ hitHost: true }).deps, { target: TARGET, samples: 3 });
  assert.equal(hit.modes.hidden.verdict, 'fail');
  const covered = await runCaptureTest(fakeMac({ cover: win(5, 42, 0, { x: 0, y: 0, width: 2000, height: 2000 }) }).deps, { target: TARGET, samples: 3 });
  assert.match(covered.notes[0], /region and hover captures skipped/);
  assert.equal(covered.modes.hidden.verdict, 'inconclusive');
  assert.equal(covered.modes.hidden.sources.region.taken, 0);
});

test('the capture helper builds, decodes and encodes raw sRGB frames without touching the screen', { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/xcrun') }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'h5-helper-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'capture-helper');
  execFileSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), join(root, 'bench/hand/capture.swift'), '-o', bin], { timeout: 300000 });
  const frame = withHand(page());
  writeFileSync(join(dir, 'in.rgba'), frame.data);
  const run = args => JSON.parse(spawnSync(bin, args, { encoding: 'utf8' }).stdout.trim());
  assert.deepEqual(run(['encode', join(dir, 'in.rgba'), '60', '40', join(dir, 'out.png')]), { ok: true });
  assert.deepEqual(run(['decode', join(dir, 'out.png'), join(dir, 'back.rgba')]), { ok: true, width: 60, height: 40 });
  assert.deepEqual(compareFrames(frame, readFrame(join(dir, 'back.rgba'), { width: 60, height: 40 })), { differing: 0, handLike: 0 });
  assert.deepEqual(run(['sck-window', 'x', join(dir, 'x')]), { ok: false, error: 'usage' });
  assert.deepEqual(run(['display', '1']), { ok: false, error: 'usage' });
});

test('a window that comes over the region mid-run stops region captures there, and the run is not passed', async () => {
  // The Dock-sized window appears after the region was picked: each region and hover capture checks again and skips.
  const report = await runCaptureTest(fakeMac({ cover: win(8, 33, 20, { x: 0, y: 150, width: 2000, height: 700 }), coverAfter: 1 }).deps, { target: TARGET, samples: 3 });
  assert.deepEqual([report.modes.hidden.sources.region.skipped, report.modes.hidden.sources.region.taken], [3, 0]);
  assert.equal(report.modes.hidden.sources.hover.skipped, 3);
  assert.ok(report.modes.hidden.samples.filter(s => s.source === 'region').every(s => s.reason === 'covered'));
  assert.equal(report.ok, false);
});

function lockFixture() {
  const signals = new EventEmitter(), events = [], exits = [];
  return { signals, events, exits, deps: { signals, exit: code => exits.push(code), log: line => events.push(['log', line]),
    acquire: async () => { events.push('lock'); return async () => events.push('unlock'); } } };
}

test('underLiveLock: setup that throws after the lock still cleans up, last first, and releases the lock', async () => {
  const f = lockFixture();
  const code = await underLiveLock(f.deps, async ({ cleanups }) => {
    cleanups.push(() => f.events.push('rm work'));
    cleanups.push(() => { f.events.push('quit TextEdit'); throw new Error('quit refused'); });
    throw new Error('mkdtemp failed');
  });
  assert.equal(code, 1);
  assert.deepEqual(f.events, ['lock', ['log', 'H5 stopped: mkdtemp failed'], 'quit TextEdit', ['log', 'cleanup: quit refused'], 'rm work', 'unlock']);
  assert.deepEqual([f.signals.listenerCount('SIGINT'), f.signals.listenerCount('SIGTERM')], [0, 0]);
  const busy = lockFixture();
  assert.equal(await underLiveLock({ ...busy.deps, acquire: async () => { throw new Error('Another live run holds the lock'); } }, async () => 0), 3);
  const ok = lockFixture();
  assert.equal(await underLiveLock(ok.deps, async ({ cleanups }) => { cleanups.push(() => ok.events.push('rm')); return 0; }), 0);
  assert.deepEqual(ok.events, ['lock', 'rm', 'unlock']);
});

test('underLiveLock: SIGINT or SIGTERM mid-run cleans up, releases the lock and exits; a second signal exits at once', async () => {
  for (const [name, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const f = lockFixture();
    let started;
    const running = new Promise(resolve => { started = resolve; });
    void underLiveLock(f.deps, async ({ cleanups }) => {
      cleanups.push(() => f.events.push('kill hosts'));
      started();
      return new Promise(() => {}); // the capture loop, still running
    });
    await running;
    f.signals.emit(name);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.events.filter(e => typeof e === 'string'), ['lock', 'kill hosts', 'unlock'], name);
    assert.deepEqual(f.exits, [code], name);
    f.signals.emit(name);
    assert.deepEqual(f.exits, [code, code], name);
  }
});
