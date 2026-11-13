// Toon style API, shared by the human and critter lanes (ST6A owns this file).
// renderToon(design, pose, { width = 192, height = 208 } = {}) -> standalone SVG.
// A design can provide rig(design, pose) -> SVG to delegate a nonhuman skeleton.
// toonPart(pathData, base, shade?, ink?) -> two-tone rounded shape, 3 px ink.
// toonStroke(pathData, color?, width?) -> rounded unfilled path.
// toonDocument(body, width?, height?) -> SVG with a pale 2 px outside rim.
// Geometry helpers remain in lib/svg.mjs. No raster inputs, filters or fonts.
// All art is original code. Defaults are reversible design data, never settings writes.
import { Doc, path, g, ellD, rrD, capsuleD, f, RAD, clamp, outlineUnderlay } from '../lib/svg.mjs';
import { neutral, merge, recordAnchors } from '../lib/poses.mjs';
export const TOON_INK = '#292b35';
export function toonStroke(d, color = TOON_INK, width = 3) {
  return path(d, { fill: 'none', stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
}
export function toonPart(d, base, shade, ink = TOON_INK) {
  // Two tones without a filter: a shifted base clipped to the shade silhouette.
  if (!shade) return path(d, { fill: base, stroke: ink, 'stroke-width': 3, 'stroke-linejoin': 'round' });
  // Path-local clip IDs are deterministic hashes, namespaced by the atlas builder.
  let h = 2166136261; for (const c of d + base) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  const id = `toon${h >>> 0}`;
  return `<defs><clipPath id="${id}">${path(d)}</clipPath></defs>` + path(d, { fill: shade }) + g(path(d, { fill: base, transform: 'translate(-3 -2)' }), { 'clip-path': `url(#${id})` }) + toonStroke(d, ink);
}
export function toonDocument(body, width = 192, height = 208) {
  // A geometric rim survives sips, unlike SVG filters. Keep it outside the ink.
  return new Doc(width, height).wrap(outlineUnderlay(body, { ink: TOON_INK, rim: 0, inner: 3, sticker: 2, stickerColor: '#e8eaf0' }) + body);
}
const dot = (x, y, r, color = TOON_INK) => path(ellD(x, y, r), { fill: color });
const shape = (d, c, shade) => toonPart(d, c, shade);
const limb = (a, b, r, c, shade) => shape(capsuleD(...a, ...b, r), c, shade);
const box = (x, y, w, h, c, shade) => shape(rrD(x, y, w, h, 4), c, shade);
function mug(x, y, D, steam = true) {
  return toonStroke(`M${x + 9},${y - 7} C${x + 23},${y - 12} ${x + 22},${y + 6} ${x + 9},${y + 4}`, D.ink, 3) + box(x - 10, y - 12, 21, 24, D.prop, '#b7845b') + (steam ? toonStroke(`M${x - 5},${y - 18}q-3,-3 0,-6 M${x + 4},${y - 18}q3,-3 0,-6`, '#777d83', 2) : '');
}
function knitting(x, y, frame = 0) {
  return box(x - 18, y + 3, 36, 16 + frame % 3 * 2, '#da9a81', '#bc785d') + toonStroke(`M${x - 22},${y - 9}l43,16 M${x + 22},${y - 9}l-43,16`, '#775952', 2.5) + [0, 8, 16, 24].map(dx => toonStroke(`M${x - 13 + dx},${y + 6}v8`, '#a56556', 1.5)).join('');
}
function prop(kind, x, y, D, frame) {
  if (kind === 'mug') return mug(x, y, D);
  if (kind === 'knit') return knitting(x, y, frame);
  if (kind === 'cookies') return shape(ellD(x, y, 25, 8), '#f2e2c2', '#d6c29a') + [-12, 0, 12].map((dx, i) => shape(ellD(x + dx, y - 5 - i % 2 * 4, 7), '#c58b4e', '#a86b38') + dot(x + dx - 2, y - 6, 1.4)).join('');
  if (kind === 'cone') return shape(`M${x},${y - 30}L${x + 12},${y}H${x - 12}Z`, '#f58b49', '#db6634') + toonStroke(`M${x - 6},${y - 15}h12`, '#fff3d2', 4) + box(x - 17, y - 1, 34, 5, '#f58b49');
  if (kind === 'squeegee') return toonStroke(`M${x},${y + 21}v-38`, '#835f47', 5) + box(x - 19, y - 25, 38, 9, '#7caeb4', '#54858d');
  if (kind === 'box') return box(x - 23, y - 15, 46, 32, '#c99e72', '#a67854') + toonStroke(`M${x - 5},${y - 13}v13h10v-13`, '#eed0a0', 5);
  if (kind === 'laptop') return box(x - 27, y - 21, 54, 30, '#8b9da9', '#667b89') + shape(`M${x - 31},${y + 9}h62l-7,7h-48Z`, '#ccd5da', '#a6b5be');
  if (kind === 'receipt' || kind === 'card' || kind === 'stop') {
    let s = box(x - 17, y - 19, 34, 35, kind === 'stop' ? '#c25b46' : '#fff0cf', '#dcc79f');
    if (kind === 'stop') s += toonStroke(`M${x - 7},${y + 7}v-17q3,-3 5,0v9v-12q3,-3 5,0v12v-7q4,-2 5,2v11q-7,7 -15,0Z`, '#fff4dc', 2);
    else s += toonStroke(`M${x - 4},${y - 9}q0,-8 8,-5q7,5 -1,10v3 M${x + 2},${y + 7}v1`, '#796350', 2.5);
    return s;
  }
  if (kind === 'keyboard') return box(x - 27, y - 1, 54, 16, '#c7d3dc', '#91a7b8') + [-18, -9, 0, 9, 18].map(dx => toonStroke(`M${x + dx},${y + 4}v5`, '#57687a', 2)).join('');
  return '';
}
function face(D, p) {
  const eyes = p.face.eyes, closed = ['closed', 'squeeze', 'happy', 'x'].includes(eyes), half = ['half', 'focus'].includes(eyes);
  let s = '';
  for (const x of [-12, 12]) {
    if (closed) s += toonStroke(`M${x - 7},3q7,${eyes === 'happy' ? -7 : 4} 14,0`, D.ink, 2.7);
    else s += shape(ellD(x, 1, 8, half ? 6.5 : 11), '#fff8e9') + dot(x + (p.face.look?.[0] ?? 0) * 2.5, 2 + (p.face.look?.[1] ?? 0) * 2, 3.6, D.ink);
    const worried = p.face.brows === 'worried';
    s += toonStroke(`M${x - 7},-15l14,${worried ? (x < 0 ? -4 : 4) : 0}`, D.ink, 2.5);
  }
  s += shape(ellD(3, 14, 6, 4), D.skin, D.skinShade);
  const mouth = p.face.mouth;
  s += ['o', 'shout', 'open'].includes(mouth) ? shape(ellD(0, 25, 5, 6), '#76514c') : toonStroke(`M-9,24q9,${['flat', 'wobble', 'teeth'].includes(mouth) ? -1 : 8} 18,0`, D.ink, 2.5);
  if (D.kind === 'nana') {
    s += [-13, 13].map(x => toonStroke(ellD(x, 4, 11, 9), '#6d505b', 2)).join('') + toonStroke('M-2,3h4 M-24,6q-11,43 9,49 M24,6q11,43 -9,49', '#9b7560', 1.6);
  }
  return s;
}
function headArt(D, p) {
  let head = shape(ellD(0, 0, 29, 35), D.skin, D.skinShade);
  head = shape(ellD(-29, 7, 6, 9), D.skin, D.skinShade) + head + shape(ellD(29, 7, 6, 9), D.skin, D.skinShade);
  if (D.kind === 'dennis') head += shape('M-29,-4Q-31,-42 -7,-36Q-2,-47 11,-33Q33,-37 29,-3L20,-17Q-4,-11 -19,-19Z', '#6b5a4e', '#4f4641');
  if (D.kind === 'nana') head += shape(ellD(-3, -36, 15, 12), '#d5d3c9', '#aaaeb0') + shape('M-29,1Q-39,-35 -15,-34Q0,-46 24,-30Q38,-14 28,5L19,-12Q-4,-10 -17,-23L-23,2Z', '#deddd2', '#b0b4af');
  if (D.kind === 'hal') head += shape('M-30,-17Q-30,-43 0,-43Q30,-43 30,-17Z', '#e5bd54', '#c49539') + box(-37, -21, 74, 9, '#efca64', '#c9a046') + toonStroke('M0,-40v18', '#a67f38', 3);
  head += face(D, p);
  return head;
}
function lyingArt(D, p, width, height) {
  const i = p.frame ?? 0, reach = /reach/.test(p.clip), peek = /peek/.test(p.clip), sleep = /sleep/.test(p.clip);
  const kick = [0, 0, -12, 9, 0, 0][i % 6], xoff = (width - 320) / 2;
  // A horizontal torso, shins kicked up high behind, elbow under chin and a separate reaching arm.
  // This is a different skeleton, not a rotated standing figure.
  let b = limb([139, 140], [88, 132], 13, D.trousers, D.trouserShade);
  b += limb([88, 132], [78, 82 + kick], 9, D.trousers, D.trouserShade) + box(62, 70 + kick, 27, 11, D.shoes, '#383744');
  b += limb([143, 146], [100, 146], 11, D.trousers, D.trouserShade) + limb([100, 146], [92, 98 - kick], 8, D.trousers, D.trouserShade) + box(76, 86 - kick, 27, 10, D.shoes, '#383744');
  b += shape('M136,124Q173,113 205,122L217,145Q174,156 137,151Z', D.shirt, D.shirtShade);
  if (D.kind === 'dennis') b += shape('M200,124l-14,17l-26,0l8,7l24,-3l15,-15Z', '#9d605b', '#7b464b');
  else b += shape('M149,122l8,28h14l-7,-30Z', '#eb9e48', '#cc7839') + toonStroke('M159,124l5,24', '#f5efd7', 4);
  const right = reach ? [260 + i % 2 * 6, 184] : [230, 140];
  b += limb([202, 130], [211, 150], 9, D.shirt, D.shirtShade) + limb([211, 150], [239, 133], 6, D.skin, D.skinShade);
  b += limb([202, 139], [225, 154], 8, D.shirt, D.shirtShade) + limb([225, 154], right, 6, D.skin, D.skinShade) + shape(ellD(...right, 7, 6), D.skin, D.skinShade);
  if (reach) b += limb(right, [right[0] + 7, right[1] + 10], 2.8, D.skin);
  if (sleep) p.face.eyes = 'closed';
  const hy = peek ? 118 : sleep ? 114 : 104;
  b += g(headArt(D, p), { transform: `translate(242 ${hy}) rotate(${sleep ? 23 : 8 + p.head.tilt * 0.2})` });
  b += D.kind === 'dennis' ? mug(177, 140, D, !sleep && i % 2 === 0) : box(156, 137, 35, 21, '#a4b2b4', '#7f9399') + toonStroke('M164,136v-5h19v5', '#4f626a', 3);
  recordAnchors(at => at === 'head' ? [242, hy] : right, { x: xoff, y: 0, lean: 0, sx: 1, sy: 1 });
  return toonDocument(g(b, { 'data-posture': 'lie', transform: `translate(${xoff} 0)` }), width, height);
}
export function renderToon(D, pose, { width = 192, height = 208 } = {}) {
  if (typeof D.rig === 'function') return D.rig(D, pose);
  const p = merge(neutral(), pose), clip = p.clip ?? '', frame = p.frame ?? 0;
  const stage = clip.startsWith('stage-'), lie = stage && /lie|stage-sleep/.test(clip) && D.kind !== 'nana';
  const seated = /perch|sleep|high-five/.test(clip) || p.seated || p.seat || stage && /sit|think|wait|cheer|paused/.test(clip) || stage && D.kind === 'nana' && /lie|sleep/.test(clip);
  const hang = stage && /hang|climb/.test(clip), typing = /type|key|notes/.test(clip), wait = /wait|approval/.test(clip), success = /success|cheer|high-five/.test(clip), error = /error|wince/.test(clip), sleep = /sleep/.test(clip), paused = /paused/.test(clip), aim = /aim|point/.test(clip);
  if (lie) return lyingArt(D, p, width, height);
  if (sleep) p.face.eyes = 'closed';
  if (D.kind === 'dennis' && /idle|thinking|stage-(stand|think)/.test(clip)) p.face.eyes = frame % 3 === 2 ? 'closed' : 'half';
  const sip = D.kind === 'dennis' && /idle|thinking|stage-(stand|think)/.test(clip) && frame % 3 === 1;
  if (D.kind === 'hal' && typing) p.y += frame % 2 ? 3 : -3;
  const hipY = D.kind === 'nana' ? 143 : 144, shoulderY = D.kind === 'hal' ? 104 : 107;
  const palms = {};
  let s = '';
  // Stage skeletons (ST6 taste pass). Each is a different arrangement of the same capsules, so that lie, sit,
  // hang, climb, leap and run differ in silhouette alone. Keys are per frame where the clip is a cycle.
  const leap = stage && /leap/.test(clip), stageRun = stage && /run/.test(clip), climb = stage && /climb/.test(clip);
  const platform = climb && D.kind === 'hal';
  const spread = climb && !platform;
  const stagger = frame % 2 ? 0 : 1; // climbing alternates which limb is high
  const LEAP = [
    { dy: 14, knee: sg => [96 + sg * 28, 176], foot: sg => [96 + sg * 16, 190], elbow: sg => [96 + sg * 30, 122], hand: sg => [96 + sg * 38, 142] },
    { dy: -6, knee: sg => [96 + sg * 7, 164], foot: sg => [96 + sg * 7, 190], elbow: sg => [96 + sg * 22, 76], hand: sg => [96 + sg * 14, 44], toes: true },
    { dy: -8, lean: 10, knee: sg => sg < 0 ? [78, 152] : [118, 164], foot: sg => sg < 0 ? [66, 172] : [134, 180], elbow: sg => [96 + sg * 40, 84], hand: sg => [96 + sg * 56, 56], toes: true },
    { dy: 12, knee: sg => [96 + sg * 28, 174], foot: sg => [96 + sg * 16, 190], elbow: sg => [96 + sg * 38, 108], hand: sg => [96 + sg * 58, 114] },
    null,
  ];
  const key = leap ? LEAP[frame] : null;
  // Nana's bun sits high, so her leap lifts half as far and stays inside the cell.
  const dy = key ? key.dy * (key.dy < 0 && D.kind === 'nana' ? 0.5 : 1) : hang && !platform && !spread ? 8 : 0;
  const stride = stageRun ? 2.2 : /running/.test(clip) ? 1.5 : 1;
  const hangSway = hang && !platform ? (frame % 2 ? 3 : -3) : 0;
  // Limbs are separate capsules. Seated knees come forward and the shins dangle below the seat line.
  for (const [side, sg] of [['l', -1], ['r', 1]]) {
    const leg = p.legs[side], hip = [96 + sg * 10, hipY + dy];
    let knee, foot, toes = false;
    if (key) { knee = key.knee(sg); foot = key.foot(sg); toes = Boolean(key.toes); }
    else if (paused && D.kind === 'dennis') { knee = [96 + sg * 24, hipY + 13]; foot = [96 + sg * 37, hipY + 13]; }
    else if (seated) { const swing = Math.sin(leg.a * RAD) * 16; knee = [96 + sg * (25 + leg.lift * 4), hipY + 10]; foot = [knee[0] - sg * 4 + swing, hipY + 42]; toes = true; }
    else if (spread) { const up = (sg < 0) === Boolean(stagger); knee = up ? [96 + sg * 30, 142] : [96 + sg * 14, 168]; foot = up ? [96 + sg * 26, 162] : [96 + sg * 16, 192]; }
    else if (hang && !platform) { knee = [96 + sg * 7, 166]; foot = [96 + sg * 8 + hangSway, 186]; toes = true; }
    else { knee = [96 + sg * 10 + Math.sin(leg.a * RAD) * 16 * stride, 166 - leg.lift * 8 * stride]; foot = [knee[0] + Math.sin(leg.a * RAD) * 15 * stride, 190 - leg.lift * 21 * stride]; }
    s += limb(hip, knee, seated ? 9 : 8, D.trousers, D.trouserShade) + limb(knee, foot, 7, D.trousers, D.trouserShade);
    s += toes ? box(foot[0] - 7, foot[1] - 3, 14, 13, D.shoes, '#383744') : box(foot[0] - 10, foot[1] - 2, 23, 8, D.shoes, '#383744');
  }
  if (D.kind === 'nana') s += shape(`M74,${127 + dy}Q96,${118 + dy} 119,${127 + dy}L126,${161 + dy}Q96,${173 + dy} 67,${161 + dy}Z`, D.trousers, D.trouserShade);
  s += box(70, 98 + dy, 52, 49, D.shirt, D.shirtShade);
  const chest = (d, c, sh) => g(shape(d, c, sh), { transform: `translate(0 ${f(dy)})` });
  if (D.kind === 'dennis') s += chest('M84,99l12,10l12,-10l-5,18l-7,-7l-7,7Z', '#fff7e9') + chest(`M94,109h5l${error ? 9 : 2},22l-6,9l-5,-9Z`, '#9d605b', '#7b464b') + g(toonStroke('M112,118v12h-9', '#8d9aa2', 1.7), { transform: `translate(0 ${f(dy)})` });
  if (D.kind === 'nana') s += g(toonStroke('M94,100v43', '#e8c5ae', 3) + [113, 124, 135].map(y => dot(98, y, 2, '#f7d5a8')).join(''), { transform: `translate(0 ${f(dy)})` });
  if (D.kind === 'hal') s += chest('M73,99l13,1l10,23l11,-23h13l-9,43h-31Z', '#eb9e48', '#cc7839') + g(toonStroke('M81,108l10,31 M111,108l-10,31 M77,132h38', '#f5efd7', 4), { transform: `translate(0 ${f(dy)})` });
  for (const [side, sg] of [['l', -1], ['r', 1]]) {
    const a = p.arms[side], sh = [96 + sg * 27, shoulderY + dy];
    let elbow = [sh[0] + sg * Math.sin(a.a * RAD) * 18, sh[1] + Math.cos(a.a * RAD) * 18];
    let hand = [elbow[0] + sg * Math.sin((a.a + a.b) * RAD) * 17, elbow[1] + Math.cos((a.a + a.b) * RAD) * 17];
    if (key) { elbow = key.elbow(sg); hand = key.hand(sg); }
    if (sip && side === 'r') { elbow = [135, 121]; hand = [119, 105]; }
    if (typing) { elbow = [96 + sg * 30, 128]; hand = [96 + sg * 13, 133 + (frame % 2 === (sg < 0 ? 0 : 1) ? -4 : 2)]; }
    // Hang: arms straight up to the grip, shoulders stretched. Dennis hangs one-handed and keeps the mug.
    if (hang && !platform && !spread && (side === 'l' || D.kind !== 'dennis')) {
      const one = D.kind === 'dennis';
      elbow = one ? [60, 78] : [96 + sg * 37, 78]; hand = one ? [62, 30] : [96 + sg * 36, 30 + frame % 2 * 2];
    }
    // Climb (spread): one hand high on the edge, the other at the waist, swapping each frame.
    if (spread) { const up = (sg < 0) === Boolean(stagger); elbow = up ? [96 + sg * 40, 72] : [96 + sg * 40, 104]; hand = up ? [96 + sg * 48, 34] : [96 + sg * 50, 74]; }
    // Hal pulls the platform rope hand over hand.
    if (platform) { const up = (side === 'l') === Boolean(stagger); elbow = [58 + (side === 'l' ? -4 : 8), up ? 76 : 112]; hand = [52, up ? 46 : 96]; }
    if (success && D.kind === 'hal' && side === 'r') { elbow = [132, 83]; hand = [119, 47 + frame % 2 * 3]; }
    if (error && D.kind === 'dennis' && side === 'r') { elbow = [135, 127]; hand = [105, 119]; }
    if (error && D.kind === 'nana' && side === 'r') { elbow = [134, 110]; hand = [143 + frame % 2 * 3, 97]; }
    palms[side] = hand;
    s += limb(sh, elbow, 8, D.shirt, D.shirtShade) + limb(elbow, hand, 6, D.skin, D.skinShade);
    s += toonStroke(`M${elbow[0] - 4},${elbow[1]}h8`, side === 'l' ? '#ef8853' : '#6d96cb', 3);
    s += shape(ellD(...hand, 7, 6), D.skin, D.skinShade);
    if (a.hand === 'point' || typing || error && D.kind === 'nana' && side === 'r') s += limb(hand, [hand[0] + (typing ? 0 : sg * 6), hand[1] + (typing ? 8 : -10)], 2.8, D.skin);
    if (a.hand === 'palm') s += toonStroke(`M${hand[0] - 3},${hand[1] - 5}v-6 M${hand[0] + 2},${hand[1] - 5}v-7`, D.skin, 4);
    // Gripping fingers over an edge.
    if ((hang && !platform || spread || platform) && hand[1] < 60) s += toonStroke(`M${hand[0] - 5},${hand[1] - 4}v-5 M${hand[0]},${hand[1] - 5}v-6 M${hand[0] + 5},${hand[1] - 4}v-5`, D.skin, 3.5);
  }
  const hx = 96 + p.head.turn * 5, hy = (D.kind === 'nana' ? 65 : 62) + p.head.dy * 0.4 + dy;
  if (hang || climb) p.face.look = climb || hang && !/peek/.test(clip) ? [0, -0.8] : [0, 0.9];
  if (leap) p.face.look = frame < 3 ? [0.3, -0.5] : [0, 0.4];
  const head = headArt(D, p);
  s += g(head, { transform: `translate(${f(hx)} ${f(hy)}) rotate(${f(p.head.tilt * 0.5 + (key?.lean ?? 0) * 0.5)})` });
  let held = '';
  if (/drag/.test(clip) || /carry/.test(clip)) held = prop('box', 96, 131, D, frame);
  else if (wait) held = prop(D.kind === 'hal' ? 'stop' : 'card', D.kind === 'nana' ? 133 : 136, 116, D, frame) + (D.kind === 'nana' ? knitting(94, 142, frame) : '');
  else if (typing) held = prop(D.kind === 'nana' && /notes/.test(clip) ? 'knit' : /notes/.test(clip) ? 'laptop' : 'keyboard', 96, 143, D, frame);
  else if (success) held = prop(D.kind === 'dennis' ? 'mug' : D.kind === 'nana' ? 'cookies' : 'squeegee', D.kind === 'nana' ? 96 : 139, D.kind === 'nana' ? 132 : 113, D, frame);
  else if (D.kind === 'dennis' && !error) held = mug(sip ? 119 : hang ? 139 : 133, sip ? 100 : 132, D, frame % 2 === 0);
  else if (D.kind === 'nana') held = knitting(96, 142, frame) + box(48, 146, 24, 25, '#ba8d67', '#967052') + toonStroke('M51,146q8,-20 18,0', '#785b4b', 2.5);
  else if (D.kind === 'hal' && !error) held = prop(aim ? 'cone' : 'squeegee', aim ? 150 : 139 + (frame % 3 - 1) * 3, aim ? 169 : 139, D, frame) + (aim ? prop('cone', 49, 181, D, frame) : '');
  if (D.kind === 'hal' && error) held = g(prop('squeegee', 145, 168, D, frame), { transform: `rotate(${frame * 4} 145 168)` });
  // Hal's platform: a plank under his boots, a rope on the left he pulls hand over hand, a rail on the right.
  if (platform) s = box(40, 191, 112, 9, '#9daab1', '#76868f') + toonStroke(`M52,191v-183 M150,191v-157`, '#697982', 2.5) + toonStroke('M48,118h8m-8,-24h8m-8,-24h8', '#697982', 2) + s;
  if (paused && D.kind !== 'dennis') held += mug(140, 158, D, false);
  s += held;
  if (error) s += toonStroke('M151,57l6,-5 M156,67h7', '#bc6652', 2.5);
  // Side effects are artwork only. No prop ever writes content or claims an action succeeded.
  const leanDeg = key?.lean ?? (spread ? (stagger ? -5 : 5) : hang && !platform ? hangSway * 1.2 + (D.kind === 'dennis' ? 5 : 0) : clamp(p.lean, -14, 14) * (stageRun ? 1 : 0.3));
  const pivot = hang && !platform ? (D.kind === 'dennis' ? '62 30' : '96 30') : '96 196';
  const root = `translate(${width === 320 ? 64 : 0} 0) translate(${f(p.x * 0.35)} ${f(p.y * 0.35 * (stageRun ? 2 : 1))}) rotate(${f(leanDeg)} ${pivot})`;
  recordAnchors(at => at.startsWith('hand.') || at.startsWith('tip.') ? palms[at.at(-1)] : [hx, hy], { ...p, x: p.x * 0.35, y: p.y * 0.35, lean: leanDeg, sx: 1, sy: 1 });
  const posture = seated ? 'sit' : hang && !climb ? 'hang' : climb ? 'climb' : leap ? 'leap' : 'stand';
  return toonDocument(g(s, { transform: root, 'data-posture': posture }), width, height);
}
