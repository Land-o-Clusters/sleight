// The ghost hand capture test's pixel rules (H5). Frames are raw 8-bit sRGB RGBA, { width, height, data }, as
// bench/hand/capture.swift writes them, so every capture path is compared in one colour space.
//
// The test: a capture taken while the hand's panel is on screen is compared with a capture of the same window by the same
// path with no hand anywhere (the baseline). A pixel differs when any of R, G or B moved by more than `tol` (default 8 of 255).
// A differing pixel is hand-coloured when it leans the way the hand's paint leans over a white page
// (ledger/p130/hand-art/spec.md): blue (B - R >= 6 and B >= G: the dabs #A9C4F5, #7299EA, #4E79D9, the shadow side #B9BFC9,
// the fold #A3ABB7 and the navy halo #141A26) or warm (R - B >= 8 and R >= 150: the ivory #EFE9DC). TextEdit's black text and
// grey antialiasing sit within 4 of neutral and count as neither. At the hand's lowest resting opacity, 0.60 lifted, ivory over
// white is (245, 242, 234): 21 off white in blue and 11 warm, and the dab #4E79D9 at 0.55 is (158, 181, 234).
//
// A capture leaves the hand out when 0 pixels differ (the Fable plan's done criterion, fable-1018-ghost-hand.md item 5). A
// path whose two baselines already differ (noise above 0) falls back to 0 hand-coloured differing pixels, and says so. A
// capture shows the hand when at least `minHand` (default 40) differing pixels are hand-coloured; the glove at 1x covers
// about 120 to 165 ivory pixels and 34 dab pixels (gh-a-REPORT, 469 to 660 and 137 at 2x). Between the two is a trace.
export const TOLERANCE = 8;
export const MIN_HAND = 40;

export function handColoured(r, g, b) {
  return (b - r >= 6 && b >= g) || (r - b >= 8 && r >= 150);
}

// The agent cursor's styles (VC7). The ring's paint is saturated: warm #FF7A3D and cool #5B8DFF (consent-host.swift RingTheme),
// and the synthetic sprite (synthetic-character.mjs) is magenta and green. At 0.3 opacity over white the cool seam is
// (206, 221, 255) and the warm one (255, 215, 197): 49 and 58 apart between their highest and lowest channel. TextEdit's
// text and its grey antialiasing are within 4, and the ring's ink (#0B0D14 at 0.55) within 9, so a spread of 24 counts only
// cursor paint.
export function cursorColoured(r, g, b) {
  return Math.max(r, g, b) - Math.min(r, g, b) >= 24;
}
export const CURSOR_STYLES = Object.freeze(['glove', 'ring', 'seam', 'sprite']);
/** The pixel rule for a cursor style: the glove's paint, or saturated cursor paint for the ring, seam and sprite. */
export function colourRule(style = 'glove') {
  if (!CURSOR_STYLES.includes(style)) throw new Error(`unknown cursor style ${style}`);
  return style === 'glove' ? handColoured : cursorColoured;
}

/** { differing, handLike, box } or { sizeMismatch } for two frames of one capture path. box is the differing pixels' bounds. */
export function compareFrames(base, sample, { tol = TOLERANCE, coloured = handColoured } = {}) {
  if (!base || !sample || base.width !== sample.width || base.height !== sample.height || base.data.length !== sample.data.length) {
    return { sizeMismatch: true, base: base && [base.width, base.height], sample: sample && [sample.width, sample.height] };
  }
  const { width, data: a } = base, b = sample.data;
  let differing = 0, handLike = 0, left = Infinity, top = Infinity, right = -1, bottom = -1;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) <= tol && Math.abs(a[i + 1] - b[i + 1]) <= tol && Math.abs(a[i + 2] - b[i + 2]) <= tol) continue;
    differing++;
    if (coloured(b[i], b[i + 1], b[i + 2])) handLike++;
    const p = i / 4, x = p % width, y = (p - x) / width;
    if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y;
  }
  return { differing, handLike, ...(differing ? { box: [left, top, right - left + 1, bottom - top + 1] } : {}) };
}

/** excluded, shown, trace or error, for one comparison; noise is the path's baseline-against-baseline differing count. */
export function classify(comparison, { noise = 0, minHand = MIN_HAND } = {}) {
  if (!comparison || comparison.sizeMismatch) return 'error';
  if (comparison.handLike >= minHand) return 'shown';
  if (noise === 0 ? comparison.differing === 0 : comparison.handLike === 0) return 'excluded';
  return 'trace';
}

// Which captures are whose, and what each mode expects of them.
//   sleight: sleight's own screenshots. engine is the engine's window screenshot (app.getScreenshot()); hover is the hover
//            tool's region capture (`screencapture -x -R` of the app's rectangle, hover.js) taken 100 ms after the relay's
//            hide, hover's shortest wait. Both must leave the hand out in both modes (LAWS: the hand shows in the user's
//            captures only if sleight's own never include it).
//   user:    the user's own captures. region is a `screencapture -R` selection over the window with the hand up; composite
//            is the launch film's recorder path (the target window plus the hand's panel through one ScreenCaptureKit filter).
//            Hidden must leave the hand out; visible must show it, which also proves the detector sees the hand.
//   single:  one-window captures, `screencapture -l` and ScreenCaptureKit's desktop-independent window filter. They hold that
//            window's pixels only, so the hand should be absent in both modes; a hand there is reported, not failed.
export const SOURCES = Object.freeze({ engine: 'sleight', hover: 'sleight', region: 'user', composite: 'user', 'window-l': 'single', 'sck-window': 'single' });
export const expected = (mode, source) => SOURCES[source] === 'user' && mode === 'visible' ? 'shown' : 'excluded';

/** One mode's verdict from its samples: [{ source, handUp, result, hitPid?, frontPid? }]. pass, fail or inconclusive, with
 *  the reasons and a per-source tally. A sample counts only when the hand's panel was on screen before and after it (for
 *  hover, when the hide was sent). */
export function modeVerdict(mode, samples, { hostPid, minSamples = 3, minControl = 0.8, minShown = 0.5 } = {}) {
  const reasons = [], notes = [], sources = {};
  let fail = false, inconclusive = false;
  for (const source of Object.keys(SOURCES)) {
    const all = samples.filter(s => s.source === source && s.result !== 'skipped');
    const counted = all.filter(s => s.handUp);
    const tally = { taken: all.length, counted: counted.length, excluded: 0, shown: 0, trace: 0, error: 0,
      skipped: samples.filter(s => s.source === source && s.result === 'skipped').length };
    for (const s of counted) tally[s.result] = (tally[s.result] ?? 0) + 1;
    sources[source] = tally;
    const role = SOURCES[source], want = expected(mode, source);
    if (tally.error) { fail = true; reasons.push(`${source}: ${tally.error} capture(s) failed or changed size`); }
    if (role === 'single') {
      if (tally.shown + tally.trace) notes.push(`${source} showed hand pixels in ${tally.shown + tally.trace} of ${tally.counted} (a one-window capture)`);
      continue;
    }
    if (counted.length < minSamples || counted.length < minControl * all.length) {
      inconclusive = true;
      reasons.push(`${source}: the panel was on screen for ${counted.length} of ${all.length} captures (needs ${minSamples} and ${Math.round(minControl * 100)}%)`);
      continue;
    }
    if (want === 'excluded' && tally.excluded !== counted.length) {
      fail = true;
      reasons.push(`${source}: hand pixels in ${counted.length - tally.excluded} of ${counted.length} captures (${role === 'sleight' ? "sleight's own screenshot" : 'must be hidden'})`);
    }
    if (want === 'shown' && tally.shown < minShown * counted.length) {
      inconclusive = true;
      reasons.push(`${source}: the visible hand showed in ${tally.shown} of ${counted.length} captures, so a zero elsewhere proves nothing`);
    }
  }
  const hits = samples.filter(s => Number.isSafeInteger(s.hitPid));
  if (hostPid && hits.some(s => s.hitPid === hostPid)) { fail = true; reasons.push(`AX hit test found the hand's panel at ${hits.filter(s => s.hitPid === hostPid).length} point(s)`); }
  if (!hits.length) notes.push('no AX hit test (Accessibility not granted to the process that started this)');
  if (hostPid && samples.some(s => s.frontPid === hostPid)) { fail = true; reasons.push('the hand host was the frontmost app'); }
  return { mode, verdict: fail ? 'fail' : inconclusive ? 'inconclusive' : 'pass', reasons, notes, sources, hitTests: hits.length };
}

/** The decision the capture default rests on (LAWS, gh-a-REPORT "Capture mode"). */
export function decision(hidden, visible) {
  if (hidden.verdict !== 'pass') return { capture: 'not-proven', words: `hidden ${hidden.verdict}: the default can't rest on sharingType none; write a known-problems entry` };
  if (visible.verdict === 'pass') return { capture: 'visible-allowed', words: "hidden keeps every capture clean, and in visible mode sleight's own screenshots still leave the hand out: the owner may offer visible" };
  return { capture: 'hidden-only', words: `visible ${visible.verdict}: keep hidden, and visible only for filming` };
}
