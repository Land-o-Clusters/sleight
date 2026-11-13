// Critter API: renderCritter(design, pose, { width }) -> 192x208 (or 320x208 for lying) SVG; critterPose(design, clip, frame) -> pose.
// Arms drive forelegs, legs drive hind legs. The duck uses a body ellipse, head circle and beak.
// Motion preferences are build data only. The stage runtime must honor travel:'pop' for Rudy and Mo.
//
// Postures (ST6 taste pass, 2026-10-27): one seated body used to serve every state, so lie, hang, climb, leap and
// sit read the same at a glance. Each posture now has its own layout: where the body, head, four paws and tail go.
//   sit    upright, the sprite default; stage-sit dangles the hind legs over the edge
//   quad   four on the floor, body horizontal, head at the front (stand, run, carry)
//   lie    full stretch along the edge in a 320 px wide cell (cat, dog); the belly line is the edge
//   hang   paws on the edge, body dangling straight down, hind legs and tail hanging
//   climb  spread against the side, limbs staggered, head up
//   leap   five keys: crouch, launch, air, land, settle
//   sloth  Mo hangs under the edge by all four hooks with his head upside down; climbs and crawls when he must
import { path, g, ellD, rrD, capsuleD, f, RAD, clamp } from '../lib/svg.mjs';
import { CLIPS, PERCH_CLIPS, neutral, merge, recordAnchors } from '../lib/poses.mjs';
import { toonPart, toonStroke, toonDocument } from '../styles/toon.mjs';

export const STAGE_SCALE = 2;
export const EVERYDAY_CRITTERS = Object.freeze(['mabel', 'biscuit', 'rudy', 'mo']);
// ST1's table contains 20 states although its prose says 19. ST3's loader added stage-think (the front-sit seat), so 21.
const STAGE = [
  ['lie', 6, [400,120,200,200,500,400], true, 'perch'],
  ['lie-reach', 4, [90,120,90,200], false, 'perch-point-right'],
  ['lie-peek', 2, [1400,400], true, 'perch-peek'],
  ['sleep', 2, [1500,1500], true, 'sleep'],
  ['sit', 4, [400,300,300,400], true, 'perch'],
  ['sit-notes', 6, 160, true, 'type'],
  ['think', 4, [600,400,600,400], true, 'thinking'],
  ['wait', 4, [900,500,900,500], true, 'perch-wait'],
  ['cheer', 3, [90,420,200], false, 'high-five'],
  ['hang', 4, [400,300,300,400], true, 'perch'],
  ['hang-peek', 2, [1400,400], true, 'perch-peek'],
  ['climb', 6, 110, true, 'running-right'],
  ['stand', 6, [280,110,110,140,140,320], true, 'idle'],
  ['point', 3, [70,90,320], false, 'aim'],
  ['carry', 4, 110, true, 'drag-carry'],
  ['wince', 4, [60,80,120,300], false, 'error'],
  ['handoff', 4, [120,140,160,400], false, 'handoff'],
  ['paused', 5, [90,90,90,1200,1200], true, 'paused'],
  ['leap', 5, [70,120,110,120,160], false, 'jumping'],
  ['run', 8, 110, true, 'running-right'],
  ['startle', 2, [70,110], false, 'startle'],
];
export function stageClips() {
  return STAGE.map(([name, frames, ms, loop, source]) => {
    const base = [...CLIPS, ...PERCH_CLIPS].find(c => c.name === source);
    return { name: `stage-${name}`, frames, ms, loop, source,
      pose: (i, ctx) => base ? base.pose(i % base.frames, ctx) : merge(neutral(), { face:{eyes:'half'}, head:{tilt:4} }) };
  });
}
/** Lying cells are wide for the cat and dog: a full stretch needs 1.6 cells. The sloth hangs and the duck sits. */
export function stageWidth(D, clipName) {
  return /^stage-(lie|lie-reach|lie-peek|sleep)$/.test(clipName) && (D.species === 'cat' || D.species === 'dog') ? 320 : 192;
}
export function durationFor(D, ms) {
  const scale = n => Math.min(2000, Math.round(n * (D.motion?.tempo ?? 1)));
  if (!Array.isArray(ms)) return scale(ms);
  const values = ms.map(scale), sum = values.reduce((a,b) => a+b,0);
  return sum <= 4000 ? values : values.map(n => Math.floor(n * 4000 / sum));
}
export function clipTiming(D,c) {
  if(D.species==='duck' && /^(error|stage-wince)$/.test(c.name)) return Array(c.frames).fill(800/c.frames);
  if(D.species==='sloth' && /^(idle|stage-stand)$/.test(c.name)) return [300,300,1500,300,300,300];
  return durationFor(D,c.ms);
}
export function critterPose(D, c, i) {
  const p = c.pose(i, { E: D.E ?? 1 });
  p.clip = c.name; p.frame = i; p.frames = c.frames;
  p.seated = /perch|sleep|stage-(sit|think|wait|cheer|paused)/.test(c.name);
  p.lying = /stage-lie|stage-sleep/.test(c.name);
  p.hanging = /stage-hang|stage-climb/.test(c.name) || D.species === 'sloth';
  if (D.species === 'duck') {
    p.x = 0; p.y = /idle|perch$|stage-(lie|sit|stand)$/.test(c.name) ? Math.sin(i / c.frames * Math.PI * 2) : 0;
    p.lean = 0; p.sx = 1; p.sy = 1;
    p.head.tilt = /aim|point|peek/.test(c.name) ? 8 : 0;
    p.face.eyes = /sleep/.test(c.name) || /success|cheer|high-five/.test(c.name) && i === 1 ? 'closed' : 'open';
    p.props = []; p.fx = [];
  }
  return p;
}

/** Which skeleton a clip uses. Exported so tests can assert the postures differ. */
export function postureFor(D, clip) {
  if (D.species === 'duck') return 'duck';
  if (D.species === 'sloth') return /stage-climb/.test(clip) ? 'climb' : /stage-(stand|run|carry)|running-/.test(clip) ? 'crawl' : 'slothhang';
  if (/stage-(lie|sleep)/.test(clip)) return 'lie';
  if (/stage-hang/.test(clip)) return 'hang';
  if (/stage-climb/.test(clip)) return 'climb';
  if (/stage-leap/.test(clip)) return 'leap';
  if (/stage-(stand|run|carry)|running-/.test(clip)) return 'quad';
  return 'sit';
}

const S = (i, n) => Math.sin(i / n * 2 * Math.PI);
const mirrorX = (pt, w) => [w - pt[0], pt[1]];

// Layout: body {x,y,rx,ry,rot}, head {x,y,rot}, limbs as [from,to] pairs, tail {x,y,rot,wag}, and prop spots.
function layout(D, p, width) {
  const clip = p.clip ?? '', i = p.frame ?? 0, n = p.frames ?? 1, posture = postureFor(D, clip), cx = width / 2;
  const sloth = D.species === 'sloth', E = D.E ?? 1;
  const L = { posture, cx, hind: {}, fore: {}, far: [], lookAt: null, sway: 0, swayAt: null, extra: '' };
  const setLimbs = (hl, hr, fl, fr) => { L.hind.l = hl; L.hind.r = hr; L.fore.l = fl; L.fore.r = fr; };
  if (posture === 'sit') {
    const seated = p.seated || p.hanging, bodyY = seated ? 145 : 148, dangle = /^stage-(sit|think)/.test(clip);
    L.body = { x: 86, y: bodyY, rx: 39, ry: 32, rot: 0 };
    L.head = { x: 104 + p.head.turn * 8, y: seated ? 99 : 106, rot: clamp(p.head.tilt, -12, 12) };
    L.tail = { x: 51, y: 145, rot: 0, wag: D.species === 'dog' ? Math.sin(i * 1.8) * 13 : Math.sin(i * 0.9) * 6 };
    L.bib = { x: 99, y: bodyY + 7, rx: 24, ry: 23 };
    for (const [s, sign] of [['l', -1], ['r', 1]]) {
      const Lg = p.legs[s], A = p.arms[s];
      const hip = [69 + sign * 13, bodyY + 13];
      let foot;
      let knee = null;
      if (dangle) {
        // Knees out over the edge, shins swinging below it: a cat sitting like a person.
        const swing = Math.sin(clamp(Lg.a, -45, 45) * RAD) * 9;
        knee = [hip[0] + sign * 9, hip[1] + 14]; foot = [knee[0] - sign * 2 + swing, knee[1] + 24];
      } else { const len = seated ? 21 : 29, a = clamp(Lg.a, -45, 45) * RAD; foot = [hip[0] + Math.sin(a) * len, hip[1] + Math.cos(a) * len - (Lg.lift ?? 0) * 12]; }
      const sh = [120 + sign * 10, bodyY - 5], a1 = A.a * RAD, a2 = (A.a + A.b) * RAD;
      const reach = A.hand === 'point' || /aim|point|reach/.test(clip);
      const paw = reach ? [sh[0] + sign * 17 + Math.sin(a2) * 20, sh[1] - 18 - Math.sin(a1) * 16]
        : [sh[0] + sign * Math.sin(a1) * 18, sh[1] + Math.cos(a1) * 22 + Math.cos(a2) * 10];
      L.hind[s] = knee ? [hip, knee, foot] : [hip, foot]; L.fore[s] = [sh, paw];
    }
    L.dangle = dangle;
    L.propAt = [128, 151];
  } else if (posture === 'quad' || (posture === 'leap' && i === 4)) {
    const dir = p.head.turn < 0 ? -1 : 1, run = /run/.test(clip) && !/stage-stand/.test(clip);
    const s = run ? S(i, n) * E : 0, lift = run ? Math.max(0, s) * 10 : 0, lift2 = run ? Math.max(0, -s) * 10 : 0;
    const bob = run ? Math.abs(Math.cos(i / n * 2 * Math.PI)) * 4 * E : 0;
    L.body = { x: 96, y: 152 - bob, rx: 44, ry: 23, rot: 0 };
    L.head = { x: 134, y: 116 - bob, rot: clamp(p.head.tilt, -12, 12) };
    L.tail = { x: 56, y: 138 - bob, rot: -25, wag: D.species === 'dog' ? Math.sin(i * 1.8) * 14 : Math.sin(i * 0.9) * 5 };
    L.bib = { x: 118, y: 160 - bob, rx: 20, ry: 14 };
    const sh = [124, 162 - bob], hip = [66, 160 - bob];
    setLimbs([hip, [58 - 22 * s, 190 - lift2]], [hip, [74 + 22 * s, 190 - lift]], [sh, [118 - 22 * s, 190 - lift]], [sh, [132 + 22 * s, 190 - lift2]]);
    L.far = ['hind.l', 'fore.l'];
    L.propAt = [162, 128 - bob];
    L.mouthProp = /carry/.test(clip);
    L.dir = dir;
    if (dir < 0) {
      const m = pt => mirrorX(pt, 192);
      L.body.x = 192 - L.body.x; L.head.x = 192 - L.head.x; L.tail = { ...L.tail, x: 192 - L.tail.x, rot: -L.tail.rot, flip: true }; L.bib.x = 192 - L.bib.x; L.propAt = m(L.propAt);
      for (const k of ['l', 'r']) { L.hind[k] = L.hind[k].map(m); L.fore[k] = L.fore[k].map(m); }
    }
  } else if (posture === 'lie') {
    const reach = /reach/.test(clip), peek = /peek/.test(clip), sleep = /sleep/.test(clip);
    const kick = [0, 0, -12, 8, 0, 0][i % 6];
    L.body = { x: cx - 10, y: 122, rx: 58, ry: 19, rot: 0 };
    L.head = sleep ? { x: cx + 60, y: 118, rot: 18 } : peek ? { x: cx + 66, y: 116, rot: 6 } : { x: cx + 62, y: 104, rot: clamp(p.head.tilt, -8, 8) };
    L.tail = { x: cx - 66, y: 118, rot: -62, wag: sleep ? 0 : D.species === 'dog' ? Math.sin(i * 1.8) * 12 : Math.sin(i * 1.3) * 7 };
    L.bib = { x: cx + 38, y: 130, rx: 16, ry: 10 };
    const sh = [cx + 36, 128], hip = [cx - 56, 128];
    const pawR = reach ? [cx + 98, 168 + (i % 2) * 10] : [cx + 86, 137];
    setLimbs([hip, [cx - 100 + kick, 137 - Math.max(0, -kick) * 0.5]], [hip, [cx - 90 - kick * 0.5, 133]], [sh, [cx + 76, 140]], [sh, pawR]);
    L.far = ['hind.r', 'fore.l'];
    L.reach = reach;
    L.lookAt = reach ? [0.5, 1] : peek ? [0.2, 1] : null;
    L.propAt = [cx + 90, 150];
  } else if (posture === 'hang') {
    const peek = /peek/.test(clip), sway = (i % 2 ? 1 : -1) * 3;
    L.body = { x: 96, y: 150, rx: 26, ry: 34, rot: 0 };
    L.head = peek ? { x: 96, y: 80, rot: 0 } : { x: 96, y: 100, rot: clamp(p.head.tilt, -8, 8) };
    L.tail = { x: 80, y: 166, rot: -112, wag: sway * 2 };
    L.bib = { x: 96, y: 150, rx: 16, ry: 24 };
    const w = peek ? 32 : 30;
    setLimbs([[85, 172], [83 + sway, 193]], [[107, 172], [109 + sway, 193]], [[76, 110], [96 - w, 62]], [[116, 110], [96 + w, 62]]);
    L.grip = true;
    L.lookAt = peek ? [0, 1] : [0, -0.7];
    L.sway = sway * 0.7; L.swayAt = [96, 62];
    L.propAt = [140, 120];
  } else if (posture === 'climb') {
    const st = S(i, n) * 10, slow = sloth;
    L.body = slow ? { x: 96, y: 124, rx: 28, ry: 44, rot: 0 } : { x: 96, y: 128, rx: 30, ry: 38, rot: 0 };
    L.head = { x: 96, y: slow ? 64 : 70, rot: 0 };
    L.tail = { x: 112, y: 160, rot: 130, wag: 0 };
    L.bib = { x: 96, y: 130, rx: 18, ry: 28 };
    setLimbs([[82, 158], [54, 184 - st]], [[110, 158], [138, 174 + st]], [[76, 104], [58, 50 + st]], [[116, 104], [134, 62 - st]]);
    L.grip = true;
    L.lookAt = [0, -1];
    L.propAt = [140, 120];
  } else if (posture === 'leap') {
    const K = [
      { body: { x: 96, y: 162, rx: 46, ry: 18, rot: 0 }, head: [128, 134], sh: [120, 170], hip: [68, 168], fl: [114, 190], fr: [126, 190], hl: [60, 190], hr: [74, 190], tail: [52, 150, -10] },
      { body: { x: 100, y: 140, rx: 46, ry: 22, rot: -28 }, head: [140, 100], sh: [132, 118], hip: [62, 160], fl: [160, 104], fr: [168, 92], hl: [36, 190], hr: [48, 186], tail: [52, 172, -40] },
      { body: { x: 96, y: 118, rx: 50, ry: 20, rot: -8 }, head: [140, 92], sh: [134, 110], hip: [58, 124], fl: [168, 106], fr: [176, 96], hl: [18, 118], hr: [24, 130], tail: [48, 112, -70] },
      { body: { x: 96, y: 150, rx: 46, ry: 22, rot: 22 }, head: [134, 136], sh: [126, 160], hip: [66, 138], fl: [136, 190], fr: [148, 190], hl: [40, 118], hr: [52, 126], tail: [50, 128, -30] },
    ][i] ?? null;
    L.body = K.body; L.head = { x: K.head[0], y: K.head[1], rot: i === 1 ? -14 : i === 3 ? 10 : 0 };
    L.tail = { x: K.tail[0], y: K.tail[1], rot: K.tail[2], wag: 0 };
    L.bib = { x: K.body.x + 22, y: K.body.y + 6, rx: 18, ry: 12 };
    setLimbs([K.hip, K.hl], [K.hip, K.hr], [K.sh, K.fl], [K.sh, K.fr]);
    L.far = ['hind.l', 'fore.l'];
    L.propAt = [160, 120];
    L.earsBack = i === 1 || i === 2;
  } else if (posture === 'slothhang') {
    const peek = /peek/.test(clip), leap = /leap/.test(clip);
    L.body = { x: 98, y: 102, rx: 48, ry: 24, rot: 0 };
    L.head = { x: 146, y: 136, rot: peek ? 140 : 180 };
    L.bib = { x: 98, y: 96, rx: 30, ry: 14 };
    setLimbs([[66, 96], [56, 52]], [[84, 92], [80, 52]], [[118, 92], [114, 52]], [[138, 96], [140, 52]]);
    L.far = ['hind.r', 'fore.l'];
    L.grip = true;
    L.lookAt = peek ? [0, 1] : null;
    L.propAt = [150, 76];
    L.wide = leap;
  } else if (posture === 'crawl') {
    const run = /run/.test(clip), s = run ? S(i, n) * 0.6 : 0;
    L.body = { x: 92, y: 168, rx: 50, ry: 19, rot: 0 };
    L.head = { x: 138, y: 148, rot: -6 };
    L.bib = { x: 100, y: 160, rx: 28, ry: 10 };
    setLimbs([[56, 170], [24 - 8 * s, 188]], [[64, 172], [36 + 8 * s, 190]], [[124, 170], [164 + 8 * s, 190]], [[132, 172], [174 - 8 * s, 188]]);
    L.far = ['hind.r', 'fore.r'];
    L.propAt = [92, 141];
    L.backProp = /carry/.test(clip);
  }
  return L;
}

// Geometry is independent of the style renderer. toon.mjs owns the shared paint API.
export function renderCritter(D, pose, { width = 192 } = {}) {
  const p = merge(neutral(), pose), ink = D.ink, clip = p.clip ?? '', frame = p.frame ?? 0;
  const shape = (d, fill = D.fur, width = 3) => width === 0 ? path(d,{fill}) : toonPart(d,fill,fill===D.fur?D.shade:undefined,ink);
  const line = (d, color = ink, width = 3) => toonStroke(d,color,width);
  const oval = (x,y,rx,ry,fill) => shape(ellD(x,y,rx,ry),fill);
  const cat = D.species === 'cat', dog = D.species === 'dog', duck = D.species === 'duck', sloth = D.species === 'sloth';
  const cx = width / 2;
  let body = '';
  const feet = {};
  const foot = (at,fill,key) => `<g data-foot="${key}">${oval(at[0],at[1],9,6,fill)}</g>`;
  const grip = (at, key) => `<g data-foot="${key}">${oval(at[0],at[1],8,7,D.fur)}${line(`M${f(at[0]-5)},${f(at[1]-6)}v-4m5,4v-5m5,5v-4`, D.ink, 2)}</g>`;
  const claws = at => sloth ? line(`M${f(at[0]-4)},${f(at[1]+3)}v6m4,-6v7m4,-7v6`,D.light,2) : '';
  let L = null;
  if (!duck) {
    L = layout(D, p, width);
    const leg = (pair, key, fill, r1 = 10, r2 = 7) => {
      const a = pair[0], b = pair.at(-1), isGrip = L.grip && key.startsWith('fore');
      feet[key] = b;
      const bone = pair.length === 3 ? shape(capsuleD(...pair[0], ...pair[1], r1, r2 + 1), fill) + shape(capsuleD(...pair[1], ...pair[2], r2 + 1, r2 - 1), fill) : shape(capsuleD(...a, ...b, r1, r2), fill);
      return bone + (isGrip ? grip(b, key) : foot(b, fill === D.shade ? D.shade : D.fur, key) + claws(b));
    };
    const limbs = { 'hind.l': ['hind.l', L.hind.l, 10, 7], 'hind.r': ['hind.r', L.hind.r, 10, 7], 'fore.l': ['fore.l', L.fore.l, 8, 7], 'fore.r': ['fore.r', L.fore.r, 8, 7] };
    const farSet = new Set(L.far ?? []);
    // Tail first, then far limbs in shade, body, near limbs, head.
    if (!sloth && L.tail) {
      const t = L.tail, wag = t.wag ?? 0;
      const tailD = cat ? `M51,145C18,147 21,111 ${34+wag},105C43,101 42,113 38,119C31,130 40,133 52,129Z`
        : `M54,145Q${25+wag},135 ${30+wag},101Q${54+wag},110 61,132Z`;
      const tr = `translate(${f(t.x-51)} ${f(t.y-145)}) rotate(${f(t.rot)} 51 145)` + (t.flip ? ' translate(102 0) scale(-1 1)' : '');
      body += g(shape(tailD, D.shade) + (cat ? line('M28,119l10,5M28,132l12,3', D.ink,4) : ''), { transform: tr });
    }
    for (const key of Object.keys(limbs)) if (farSet.has(key)) { const [k, pair, r1, r2] = limbs[key]; body += leg(pair, k, D.shade, r1 - 1, r2 - 1); }
    for (const key of ['hind.l', 'hind.r']) if (!farSet.has(key)) { const [k, pair, r1, r2] = limbs[key]; body += leg(pair, k, D.shade, r1, r2); }
    const B = L.body;
    body += shape(ellD(B.x, B.y, B.rx, B.ry, B.rot), D.fur);
    if (L.bib) body += oval(L.bib.x, L.bib.y, L.bib.rx, L.bib.ry, D.light);
    // A soft crescent of shade on the body's lower right, clipped to the body.
    const cid = `cres${frame}${B.x}${B.y}`.replace(/[^a-z0-9]/gi, '');
    body += `<defs><clipPath id="${cid}">${path(ellD(B.x, B.y, B.rx, B.ry, B.rot))}</clipPath></defs>` + g(path(ellD(B.x + 9, B.y + 8, B.rx, B.ry, B.rot), { fill: D.shade, 'fill-opacity': 0.55 }), { 'clip-path': `url(#${cid})` });
    if (sloth) body += oval(L.bib.x, L.bib.y, L.bib.rx, L.bib.ry, D.light);
    for (const key of ['fore.l', 'fore.r']) if (!farSet.has(key)) { const [k, pair, r1, r2] = limbs[key]; body += leg(pair, k, D.fur, r1, r2); }
    if (L.backProp) body += shape(rrD(L.propAt[0]-17, L.propAt[1]-12, 34, 26, 2), '#cfac7b') + line(`M${L.propAt[0]},${L.propAt[1]-12}v26`, D.shade, 2);
  } else {
    body += shape('M44,143Q29,120 45,125L61,132Q78,109 115,123Q142,133 139,151Q132,174 94,176Q54,178 44,143Z');
    body += oval(90,148,35,17,D.fur);
    body += line('M66,146Q88,132 110,148Q93,162 77,156',D.shade,3);
    feet['hand.l'] = [70, 150]; feet['hand.r'] = [120, 150];
  }
  // Face, centered at the head.
  let face = '';
  const earsBack = L?.earsBack;
  if (cat) {
    face += earsBack ? shape('M-30,-10L-40,-30L-10,-26Z')+shape('M12,-26L40,-30L31,-10Z') : shape('M-29,-15L-28,-44L-7,-27Z')+shape('M9,-27L29,-43L31,-12Z');
    if (!earsBack) face += shape('M-24,-26L-23,-36L-14,-28Z',D.warm,0)+shape('M16,-28L25,-36L26,-24Z',D.cool,0);
  }
  if (dog) face += earsBack ? shape('M-26,-20Q-56,-30 -58,-6Q-54,8 -30,6Z',D.shade)+shape('M26,-20Q56,-30 58,-6Q54,8 30,6Z',D.shade)
    : shape('M-24,-25Q-46,-26 -42,6Q-40,27 -25,19L-15,-8Z',D.shade)+shape('M24,-25Q43,-28 45,1Q48,24 33,22L19,-3Z',D.shade);
  face += oval(0,0,duck?27:cat?34:32,duck?28:cat?29:31,D.fur);
  if (sloth) face += oval(0,2,29,25,D.light)+shape('M-26,-6Q-17,-18 -4,-7L-9,10Q-20,17 -27,4Z',D.shade,0)+shape('M4,-7Q17,-18 27,-6L27,4Q20,17 9,10Z',D.shade,0);
  if (cat) face += line('M-11,-24l5,8M0,-27v10M11,-24l-5,8M-32,-6l9,4M-32,3l9,2M32,-6l-9,4M32,3l-9,2',D.shade,3);
  if (!duck) face += oval(0,13,dog?23:18,dog?17:12,D.light);
  const eyes = typeof p.face.eyes === 'object' ? p.face.eyes : {l:p.face.eyes,r:p.face.eyes};
  const look = L?.lookAt ?? p.face.look ?? [0, 0];
  const wide = L?.wide || p.face.eyes === 'wide';
  for (const [s,sign] of [['l',-1],['r',1]]) {
    const x = sign*(duck?12:14)+look[0]*2, y = look[1]*2-3;
    if (['closed','happy','squeeze','x'].includes(eyes[s])) face += line(`M${x-6},${y}Q${x},${y+(eyes[s]==='happy'?-5:4)} ${x+6},${y}`);
    else {
      face += oval(x,y,wide?8:7,eyes[s]==='half'?4:wide?10:9,'#fffdf5');
      face += oval(x+look[0]*2,y+look[1]*2.5,3.5,eyes[s]==='half'?3:5,D.iris);
      face += path(ellD(x-1,y-2,1.3),{fill:'#ffffff'});
    }
  }
  if (duck) face += shape('M15,9Q32,4 40,11Q35,22 16,19Z',D.warm)+line('M20,14h15',D.ink,1.5);
  else {
    face += shape('M-6,8Q0,5 6,8Q3,15 0,15Q-3,15 -6,8Z',cat?D.warm:D.ink,2);
    const mouth = p.face.mouth;
    face += ['o','shout','open'].includes(mouth) || L?.wide ? shape(ellD(0,21,4,5),'#6b4a4a',2) : line('M0,15v5m0,0q-6,5 -11,0m11,0q6,5 11,0',D.ink,2);
    if (dog && !/sleep/.test(clip) && !L?.mouthProp) face += shape('M-4,22h11v8q-5,7 -11,0Z','#e79391',2);
    if (cat) face += line('M-21,12l-15,-3m15,8l-15,2M21,12l15,-3m-15,8l15,2',D.ink,1.6);
  }
  const H = duck ? { x: 104 + p.head.turn * 8, y: 106, rot: clamp(p.head.tilt,-12,12) } : L.head;
  body += g(face,{transform:`translate(${f(H.x)},${f(H.y)}) rotate(${f(H.rot)})`});
  if (dog) {
    // Collar sits at the neck, under the head, whichever way the head points.
    const nx = H.x - 8 * Math.cos(H.rot * RAD) + 30 * Math.sin(H.rot * RAD), ny = H.y + 30 * Math.cos(H.rot * RAD) + 8 * Math.sin(H.rot * RAD);
    body += g(shape('M85,136Q107,148 127,136v6q-19,11 -42,0Z',D.cool,2)+oval(108,149,4,5,D.warm), { transform: `translate(${f(nx-106)} ${f(ny-139)}) rotate(${f(H.rot)} 106 139)` });
  }
  // Props, placed by the posture.
  const at = L?.propAt ?? [128, 151];
  if (/waiting|wait/.test(clip)) {
    body += shape(rrD(at[0],at[1],27,32,3),'#fff8e8')+line(`M${at[0]+9},${at[1]+9}q9,-5 10,2q0,4 -5,6v3m0,5v1`,D.ink,2);
  }
  if (/carry|drag-grab/.test(clip) && !duck && !L?.backProp) {
    const bx = L?.mouthProp ? at[0] - 14 : sloth ? at[0] - 16 : dog ? 133 : 61, by = L?.mouthProp ? at[1] - 10 : sloth ? at[1] + 24 : dog ? 125 : 137;
    body += shape(rrD(bx,by,29,25,2),'#cfac7b')+line(`M${bx+14},${by}v25`,D.shade,2);
  }
  if (/paused/.test(clip) && !duck) body += shape(rrD(at[0],at[1]+15,20,20,4),'#fff8e8')+line(`M${at[0]+20},${at[1]+19}q12,0 9,9q-2,5 -9,3`,D.ink,3);
  if (/notes|type|key/.test(clip) && !duck) body += shape(rrD(at[0]-5,at[1]+11,28,19,2),'#fff8e8')+line(`M${at[0]+2},${at[1]+14}l${7+frame%2*4},-13`,D.warm,3);
  if (/success|cheer|high-five/.test(clip) && dog) body += oval(at[0]+20,at[1]+30-frame%3*5,7,7,D.warm);
  if (/success|cheer|high-five/.test(clip) && cat) body += line(`M${at[0]+17},${at[1]+15+frame*3}l12,9`,D.warm,4);
  if (L?.reach) { const t = feet['fore.r']; body += shape(capsuleD(t[0]+2, t[1]+4, t[0]+6, t[1]+14, 3, 2.6), D.fur); }
  if (/wince|error/.test(clip) && duck) body = g(body,{transform:'rotate(180 96 135)'});
  if (duck && /peek/.test(clip)) body = g(body,{transform:'rotate(24 96 150)'});
  if (L?.sway) body = g(body,{transform:`rotate(${f(L.sway)} ${L.swayAt[0]} ${L.swayAt[1]})`});
  const anchor = name => name === 'head' ? [H.x, H.y]
    : name === 'hands' ? [((feet['fore.l']??feet['hand.l'])[0]+(feet['fore.r']??feet['hand.r'])[0])/2, ((feet['fore.l']??feet['hand.l'])[1]+(feet['fore.r']??feet['hand.r'])[1])/2]
    : feet[name] ?? feet[name?.replace(/^(hand|tip)\./, 'fore.')] ?? [cx, 130];
  recordAnchors(anchor,p);
  // Fit every pose within the same generous cell margin. No SVG filter or bitmap dependency.
  const lean = duck ? 0 : clamp(p.lean, -10, 10);
  const root = `translate(${f(p.x*0.35)},${f(p.y*0.35)}) translate(${cx},150) rotate(${f(lean)}) scale(${f(0.88*p.sx)},${f(0.88*p.sy)}) translate(-${cx},-150)`;
  return toonDocument(g(body,{'data-rig':'critter', 'data-posture': L?.posture ?? 'duck', transform:root}), width, 208);
}
