// Paper-cutout style: flat paper pieces with hand-cut edges (jitter seeded per piece, so frames don't shimmer),
// one fold shade per piece, a soft shadow under each piece, and a white cut edge around the whole figure.
// No ink lines on the body; the screen face carries the expression. Same pose schema as every style.
import { Doc, f, path, g, ellD, rrD, starD, capsuleD, outlineUnderlay, rot, RAD, clamp } from '../lib/svg.mjs';
import { recordAnchors } from '../lib/poses.mjs';
import { drawFx } from '../lib/fx.mjs';

const CX = 96;
const side = s => (s === 'l' ? -1 : 1);
const rnd = seed => { let h = 2166136261; for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return () => ((h = Math.imul(h ^ (h >>> 13), 1274126177)) >>> 0) / 4294967296; };

/** Rounded rectangle traced as a jittered polygon: reads as cut by hand. */
function cutRect(x, y, w, h, r, seed, j = 0.55) {
  const R = rnd(seed), pts = [];
  const corner = (cx, cy, a0) => { for (let k = 0; k <= 3; k++) { const a = (a0 + k * 30) * RAD; pts.push([cx + r * Math.cos(a) + (R() - 0.5) * 2 * j, cy + r * Math.sin(a) + (R() - 0.5) * 2 * j]); } };
  corner(x + w - r, y + r, -90); corner(x + w - r, y + h - r, 0); corner(x + r, y + h - r, 90); corner(x + r, y + r, 180);
  return 'M' + pts.map(([a, b]) => `${f(a)},${f(b)}`).join('L') + 'Z';
}
/** A paper piece: shadow underneath, flat base, one fold shade (the half beyond a diagonal crease). */
function piece(doc, d, pal, { fold = null, shadow = true } = {}) {
  let s = shadow ? path(d, { fill: 'rgba(40,30,60,0.22)', transform: 'translate(1.3,1.9)' }) : '';
  s += path(d, { fill: pal.base });
  if (fold) { const id = doc.id('pf'); doc.def(`<clipPath id="${id}"><path d="${d}"/></clipPath>`); s += g(path(fold, { fill: pal.shade }), { 'clip-path': `url(#${id})` }); }
  return s;
}

export function renderPaper(D, pose) {
  const doc = new Doc(192, 208), P = D.pal, p = pose, t = clamp(p.head.turn, -1, 1), scr = D.screen;
  const SH = 113, HIP = 148;
  // arms
  const arms = {};
  for (const s of ['l', 'r']) {
    const A = p.arms[s], sg = side(s), sh = [CX + sg * 23 + 3 * t, SH];
    const d1 = [sg * Math.sin(A.a * RAD), Math.cos(A.a * RAD)], d2 = [sg * Math.sin((A.a + A.b) * RAD), Math.cos((A.a + A.b) * RAD)];
    const el = [sh[0] + 15 * d1[0], sh[1] + 15 * d1[1]], wr = [el[0] + 13 * d2[0], el[1] + 13 * d2[1]], hc = [wr[0] + 4.5 * d2[0], wr[1] + 4.5 * d2[1]];
    const tip = A.hand === 'point' ? [hc[0] + 12 * d2[0], hc[1] + 12 * d2[1]] : A.hand === 'thumb' ? [hc[0], hc[1] - 10] : [hc[0] + 6 * d2[0], hc[1] + 6 * d2[1]];
    arms[s] = { ...A, sg, sh, el, wr, hc, d2, tip, front: A.front ?? hc[1] < SH - 12 };
  }
  const headX = CX + p.head.dx + 3 * t, headY = 64 + p.head.dy + 2.5 * p.head.pitch;
  const anchor = at => at === 'head' ? [headX, headY + 14] : at === 'hands' ? [(arms.l.hc[0] + arms.r.hc[0]) / 2, (arms.l.hc[1] + arms.r.hc[1]) / 2]
    : at === 'chest' ? [CX, 128] : at === 'overhead' ? [headX, headY - 36] : arms[at.split('.')[1]]?.[at.startsWith('tip') ? 'tip' : 'hc'] ?? [CX, 120];
  const props = (p.props ?? []).map(x => x.at ? { ...x, x: anchor(x.at)[0] + (x.dx ?? 0), y: anchor(x.at)[1] + (x.dy ?? 0) } : x);

  const arm = s => {
    const A = arms[s]; let o = piece(doc, capsuleD(...A.sh, ...A.el, 4.6, 4.2), P.limb) + piece(doc, capsuleD(...A.el, ...A.wr, 4.2, 4), P.limb);
    if (A.hand === 'point') o += piece(doc, capsuleD(A.hc[0], A.hc[1], A.tip[0], A.tip[1], 2.4, 2.2), P.hand);
    if (A.hand === 'thumb') o += piece(doc, capsuleD(A.hc[0], A.hc[1] - 2, A.hc[0], A.hc[1] - 10, 2.6, 2.4), P.hand);
    o += piece(doc, ellD(A.hc[0], A.hc[1], A.hand === 'palm' ? 6.8 : 5.8), P.hand, { fold: `M${f(A.hc[0] - 10)},${f(A.hc[1] + 2)}L${f(A.hc[0] + 10)},${f(A.hc[1] - 3)}L${f(A.hc[0] + 10)},${f(A.hc[1] + 10)}L${f(A.hc[0] - 10)},${f(A.hc[1] + 10)}Z` });
    if (A.hand === 'palm') for (const k of [-2.6, 0, 2.6]) o += path(`M${f(A.hc[0] + k)},${f(A.hc[1] - 6)}v3`, { stroke: P.hand.shade, 'stroke-width': 1.2, 'stroke-linecap': 'round' });
    return o;
  };
  const leg = s => {
    const Lg = p.legs[s], sg = side(s), hx = CX + sg * 11 + 2 * t, len = 36 * (1 - 0.3 * (Lg.lift ?? 0)), a = (Lg.a ?? 0) * RAD;
    const ax = hx + Math.sin(a) * len, ay = HIP + Math.cos(a) * len;
    return piece(doc, capsuleD(hx, HIP, ax, ay, 4.8, 4.4), P.leg) + piece(doc, cutRect(ax - 9 + sg * 1.5 + 2 * t, ay - 1, 18, 9, 4, 'foot' + s), P.foot, { fold: `M${f(ax - 12)},${f(ay + 5)}L${f(ax + 12)},${f(ay + 5)}L${f(ax + 12)},${f(ay + 12)}L${f(ax - 12)},${f(ay + 12)}Z` });
  };

  let back = '', body = '';
  body += ['l', 'r'].filter(s => arms[s].behind && !arms[s].front).map(arm).join('');
  body += leg('l') + leg('r');
  // torso: a folded box with a white label on the chest
  const tz = 5 * t;
  body += piece(doc, cutRect(CX - 25 + tz * 0.4, 102, 50, 48, 9, 'torso'), P.body, { fold: `M${f(CX + 6 + tz)},100L${f(CX + 40)},100L${f(CX + 40)},160L${f(CX + 14 + tz)},160Z` });
  body += piece(doc, cutRect(CX - 13 + tz, 116, 26, 15, 3, 'label'), P.label, { shadow: false });
  body += path(rrD(CX - 10 + tz, 119.5, 4.5, 8, 1), { fill: P.labelMark }) + path(`M${f(CX - 3 + tz)},121.5H${f(CX + 9 + tz)}M${f(CX - 3 + tz)},125.5H${f(CX + 6 + tz)}`, { stroke: P.labelLine, 'stroke-width': 1.6, 'stroke-linecap': 'round' });
  body += props.filter(x => x.type !== 'card').map(x => drawProp(doc, D, x)).join('');
  body += ['l', 'r'].filter(s => !arms[s].behind && !arms[s].front).map(arm).join('');
  body += g(drawHead(doc, D, p, t), { transform: `translate(${f(headX)},${f(headY)}) rotate(${f(p.head.tilt)} 0 28)` });
  body += props.filter(x => x.type === 'card').map(x => drawProp(doc, D, x)).join('');
  body += ['l', 'r'].filter(s => arms[s].front).map(arm).join('');

  // the cut edge: white paper rim, a faint dark halo outside it, and the cutout's own shadow on the page
  const all = back + body;
  const edge = outlineUnderlay(all, { ink: D.edge ?? '#fffdf6', rim: 2.6, sticker: 1, stickerColor: 'rgba(42,34,56,0.28)', inner: 0 });
  const lift = `<g transform="translate(2.2,3)" opacity="0.16">${outlineUnderlay(all, { ink: '#2a2238', rim: 2.6, inner: 0 })}</g>`;
  const fxs = p.fx.filter(x => x.type !== 'sweat');
  const tape = p.fx.some(x => x.type === 'sweat') ? g(path(cutRect(-13, -4, 26, 8, 1, 'tape', 0.8), { fill: 'rgba(246,226,170,0.92)' }) + path('M-9,-1.5H9M-9,1.5H9', { stroke: 'rgba(190,160,100,0.6)', 'stroke-width': 0.8 }), { transform: `translate(${f(headX + 26)},${f(headY - 22)}) rotate(38)` }) : '';
  recordAnchors(anchor, p);
  const root = `translate(${f(p.x)},${f(p.y)}) translate(96,196) rotate(${f(p.lean)}) scale(${f(p.sx)},${f(p.sy)}) translate(-96,-196)`;
  return doc.wrap(g(drawFx(fxs, anchor, D.ink, 'back') + lift + edge + all + tape + drawFx(fxs, anchor, D.ink, 'front'), { transform: root }));
}

function drawHead(doc, D, p, t) {
  const P = D.pal, S = D.screen, face = p.face, ink = S.ink;
  let s = '';
  // folder tab on top (warm), antenna (cool)
  s += piece(doc, cutRect(-30 + 4 * t, -36, 24, 12, 3.5, 'tab'), P.tab);
  s += path(`M${f(-25 + 4 * t)},-31.5H${f(-12 + 4 * t)}`, { stroke: P.tab.shade, 'stroke-width': 1.6, 'stroke-linecap': 'round' });
  s += piece(doc, capsuleD(20 - 2 * t, -26, 23 - 2 * t, -40, 1.7, 1.5), P.limb) + piece(doc, ellD(23 - 2 * t, -43, 5.2), P.bulb, { fold: 'M10,-43L36,-48L36,-30L10,-30Z' });
  // head box with a crease, then the screen
  s += piece(doc, cutRect(-35, -28, 70, 56, 11, 'head'), P.head, { fold: `M${f(9 + 8 * t)},-32L40,-32L40,32L${f(17 + 8 * t)},32Z` });
  const sx = 7 * t, sy = p.head.pitch * 3;
  const scr = cutRect(-27 + sx, -20 + sy, 54, 38, 8, 'screen', 0.3);
  const sid = doc.id('sc'); doc.def(`<clipPath id="${sid}"><path d="${scr}"/></clipPath>`);
  s += path(scr, { fill: S.base }) + g(path(`M${f(-40 + sx)},${f(-30 + sy)}L${f(-24 + sx)},${f(-30 + sy)}L${f(-46 + sx)},${f(30 + sy)}L${f(-62 + sx)},${f(30 + sy)}Z`, { fill: S.glare }), { 'clip-path': `url(#${sid})` });
  // face on the screen
  const fx = sx + 9 * t, fy = sy + p.head.pitch * 4, look = face.look ?? [0, 0];
  const eyes = typeof face.eyes === 'object' ? face.eyes : { l: face.eyes, r: face.eyes };
  for (const sd of ['l', 'r']) s += eye(side(sd) * 11.5 + fx + look[0] * 2.4, -3 + fy + look[1] * 2.2, eyes[sd], side(sd), S);
  if (face.blush) for (const sd of ['l', 'r']) s += path(rrD(side(sd) * 19 + fx - 3, 6 + fy, 6, 3, 1.5), { fill: S.blush });
  s += mouth(fx, 9 + fy, face.mouth, S);
  const B = { determined: [2, -2], worried: [-2, 1.5], up: [-2.5, -2.5] }[face.brows];
  if (B) for (const sd of ['l', 'r']) { const x = side(sd) * 11.5 + fx; s += path(`M${f(x - side(sd) * 4)},${f(-12 + fy + B[0])}L${f(x + side(sd) * 4)},${f(-12 + fy + B[1])}`, { stroke: S.face, 'stroke-width': 2, 'stroke-linecap': 'round' }); }
  return s;
}

function eye(x, y, type, sg, S) {
  const c = S.face, st = (d, w = 3) => path(d, { fill: 'none', stroke: c, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  const H = { open: 11, soft: 10, calm: 8, focus: 6, half: 5, sad: 8 }[type];
  if (H) return path(rrD(x - 3.6, y + (11 - H) / 2 - 5.5, 7.2, H, 3.4), { fill: c }) + (H > 7 ? path(rrD(x - 2.2, y - 4.4, 2.2, 2.4, 1), { fill: S.base }) : '');
  if (type === 'happy') return st(`M${f(x - 4.5)},${f(y + 2)}Q${f(x)},${f(y - 6)} ${f(x + 4.5)},${f(y + 2)}`);
  if (type === 'closed') return st(`M${f(x - 4.5)},${f(y - 1)}Q${f(x)},${f(y + 4)} ${f(x + 4.5)},${f(y - 1)}`);
  if (type === 'wide') return path(ellD(x, y, 5.6), { fill: 'none', stroke: c, 'stroke-width': 2.6 }) + path(ellD(x, y, 1.6), { fill: c });
  if (type === 'x') return st(`M${f(x - 4)},${f(y - 4)}L${f(x + 4)},${f(y + 4)}M${f(x + 4)},${f(y - 4)}L${f(x - 4)},${f(y + 4)}`, 2.8);
  if (type === 'squeeze') { const q = -sg; return st(`M${f(x - q * 4)},${f(y - 4)}L${f(x + q * 4)},${f(y)}L${f(x - q * 4)},${f(y + 4)}`, 2.8); }
  return path(rrD(x - 3.6, y - 5.5, 7.2, 11, 3.4), { fill: c });
}
function mouth(x, y, type, S) {
  const c = S.face, st = (d, w = 2.6) => path(d, { fill: 'none', stroke: c, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  switch (type) {
    case 'grin': case 'shout': return path(`M${f(x - 6)},${f(y - 1.5)}H${f(x + 6)}Q${f(x + 6)},${f(y + 6.5)} ${f(x)},${f(y + 6.5)}Q${f(x - 6)},${f(y + 6.5)} ${f(x - 6)},${f(y - 1.5)}Z`, { fill: c });
    case 'smile2': return path(`M${f(x - 4)},${f(y - 1)}H${f(x + 4)}Q${f(x + 3.6)},${f(y + 4)} ${f(x)},${f(y + 4)}Q${f(x - 3.6)},${f(y + 4)} ${f(x - 4)},${f(y - 1)}Z`, { fill: c });
    case 'open': case 'o': return path(ellD(x, y + 1.5, type === 'o' ? 2.4 : 3.2, type === 'o' ? 2.8 : 3.8), { fill: c });
    case 'flat': case 'teeth': return st(`M${f(x - 4)},${f(y + 1)}H${f(x + 4)}`);
    case 'cat': return st(`M${f(x - 5)},${f(y)}Q${f(x - 2.5)},${f(y + 3.4)} ${f(x)},${f(y + 0.6)}Q${f(x + 2.5)},${f(y + 3.4)} ${f(x + 5)},${f(y)}`, 2.2);
    case 'frown': return st(`M${f(x - 4)},${f(y + 3)}Q${f(x)},${f(y - 1.4)} ${f(x + 4)},${f(y + 3)}`);
    case 'wobble': return st(`M${f(x - 5.4)},${f(y + 1.4)}q1.35,-2 2.7,0t2.7,0t2.7,0t2.7,0`, 2.2);
    case 'smirk': return st(`M${f(x - 4)},${f(y + 1.2)}Q${f(x + 1)},${f(y + 3)} ${f(x + 4.6)},${f(y - 1)}`);
    default: return st(`M${f(x - 4.6)},${f(y)}Q${f(x)},${f(y + 4)} ${f(x + 4.6)},${f(y)}`);
  }
}
function drawProp(doc, D, x) {
  const P = D.pal;
  if (x.type === 'keyboard') {
    let s = piece(doc, cutRect(x.x - 30, x.y - 7, 60, 15, 3.5, 'kb'), { base: '#2c3352', shade: '#222842' });
    for (let r = 0; r < 2; r++) for (let c = 0; c < 7; c++) { const kx = x.x - 27 + c * 8, on = (x.press === 'l' && r === 0 && c === 1) || (x.press === 'r' && r === 0 && c === 5);
      s += path(rrD(kx, x.y - 4.6 + r * 5.6, 6.2, 4.2, 1), { fill: on ? (c < 3 ? '#ff7a3d' : '#5b8dff') : '#efe9dc' }); }
    return s;
  }
  if (x.type === 'card') { x = { ...x, x: clamp(x.x, 30, 162), y: Math.max(20, x.y) }; } if (x.type === 'card') return g(piece(doc, cutRect(-22, -12, 44, 24, 4, 'card'), { base: '#fffdf8', shade: '#ece6da' }, { fold: 'M6,-20L30,-20L30,20L12,20Z' }) + path(rrD(-18, -8, 4, 16, 1.6), { fill: '#f5a524' }) + path('M-10,-3.5H12M-10,3H6', { stroke: '#b4b0a6', 'stroke-width': 2, 'stroke-linecap': 'round' }), { transform: `translate(${f(x.x)},${f(x.y)}) rotate(${f(x.rot ?? 0)})`, opacity: x.fade });
  if (x.type === 'clipboard') return piece(doc, cutRect(x.x - 15, x.y - 19, 30, 38, 3, 'board'), { base: '#c08a5e', shade: '#a6714a' }) + piece(doc, cutRect(x.x - 12, x.y - 14, 24, 30, 1.5, 'sheet'), { base: '#fffdf8' }, { shadow: false }) + path(`M${f(x.x - 8)},${f(x.y - 6)}H${f(x.x + 8)}M${f(x.x - 8)},${f(x.y)}H${f(x.x + 6)}M${f(x.x - 8)},${f(x.y + 6)}H${f(x.x + 8)}`, { stroke: '#b4b0a6', 'stroke-width': 1.6, 'stroke-linecap': 'round' });
  return '';
}
