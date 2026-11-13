// Anime cel-shaded chibi style. One design (palette + part choices) and one pose make one 192x208 SVG cell.
// Shading rules: flat base, one hard-edged shade (the part minus a copy shifted toward the upper-left light),
// one highlight tone used only for named shapes (hair shine, iris light, rims). Inner lines 1.1 to 1.4 px; the
// outline filter adds a 1.5 px rim around the whole silhouette, so outer lines read about twice as heavy.
import { Doc, f, path, g, ellD, rrD, starD, capsuleD, smoothD, lockD, leafD, leafSidesD, cel, outlineUnderlay, rot, RAD, clamp, lerp } from '../lib/svg.mjs';
import { recordAnchors } from '../lib/poses.mjs';
import { drawFx, sweatDrop, FX } from '../lib/fx.mjs';

// CoreSVG (sips) drops these multi-path clip groups. Luminance masks preserve the
// union of the hair shapes and keep the shine inside the fringe on every pose.
function hairShine(doc, hair, shine, color) {
  const id = doc.id('shine');
  doc.def(`<mask id="${id}" maskUnits="userSpaceOnUse" x="-100" y="-100" width="200" height="240">${hair.map(d => path(d, { fill: '#ffffff' })).join('')}</mask>`);
  const painted = g(shine.map(d => path(d, { fill: color })).join(''), { mask: `url(#${id})` });
  doc.hairProof?.push({ hair: hair.map(d => path(d, { fill: '#ffffff' })).join(''), shine: painted });
  return painted;
}
const CX = 96;
// Skeleton per design. The default is the 2.3-head chibi; `build` in a design overrides any of these.
const CHIBI = { hipY: 150, shY: 113, headY: 70, leg: 37, upper: 15, fore: 13, head: 1, shoulder: 18, hipW: 9, limb: 1, neck: [94, 108] };
const buildOf = D => ({ ...CHIBI, ...D.build });
const sideSign = s => (s === 'l' ? -1 : 1);

export function renderAnime(D, pose, { proof } = {}) {
  const doc = new Doc(192, 208);
  if (proof) doc.hairProof = [];
  const p = temper(D, pose);
  const ink = D.ink, t = clamp(p.head.turn, -1, 1), bt = t * 0.45;
  const L = [-2.6, -2.6], B = buildOf(D);
  const SH_Y = B.shY, HIP_Y = B.hipY;

  // ---------- skeleton (body space) ----------
  const shoulder = s => [CX + sideSign(s) * B.shoulder * (1 - 0.16 * Math.abs(t)) + 4 * t, SH_Y];
  const hip = s => [CX + sideSign(s) * B.hipW + 3 * t, HIP_Y];
  const arms = {};
  for (const s of ['l', 'r']) {
    const A = p.arms[s], sg = sideSign(s), sh = shoulder(s);
    const d1 = [sg * Math.sin(A.a * RAD), Math.cos(A.a * RAD)], d2 = [sg * Math.sin((A.a + A.b) * RAD), Math.cos((A.a + A.b) * RAD)];
    const el = [sh[0] + B.upper * d1[0], sh[1] + B.upper * d1[1]], wr = [el[0] + B.fore * d2[0], el[1] + B.fore * d2[1]];
    const hc = [wr[0] + 5.2 * d2[0], wr[1] + 5.2 * d2[1]];
    const hand = A.hand ?? 'mitten';
    const tipLen = hand === 'point' ? 13.5 : hand === 'thumb' ? 0 : 7;
    const tip = hand === 'thumb' ? [hc[0], hc[1] - 11] : [hc[0] + tipLen * d2[0], hc[1] + tipLen * d2[1]];
    const front = A.front ?? hc[1] < SH_Y - 12;
    arms[s] = { ...A, s, sg, sh, el, wr, hc, d1, d2, hand, tip, front, behind: A.behind && !front, limb: B.limb };
  }
  const headX = CX + p.head.dx + 2 * t, headY = B.headY + p.head.dy + 2.5 * p.head.pitch;
  const anchor = at => {
    if (at === 'head') return [headX, headY];
    const [kind, s] = at.split('.');
    if (kind === 'hand') return arms[s].hc;
    if (kind === 'tip') return arms[s].tip;
    if (at === 'hands') return [(arms.l.hc[0] + arms.r.hc[0]) / 2, (arms.l.hc[1] + arms.r.hc[1]) / 2];
    if (at === 'chest') return [CX + 3 * t, SH_Y + (HIP_Y - SH_Y) * 0.45];
    if (at === 'overhead') return [headX, headY - 47 * B.head + 2];
    return [CX, 120];
  };
  // Props may anchor to the body ("hands", "chest", "hand.l") so they fit any build and style.
  const props = (p.props ?? []).map(x => x.at ? { ...x, x: anchor(x.at)[0] + (x.dx ?? 0), y: anchor(x.at)[1] + (x.dy ?? 0) } : x);

  // ---------- layers ----------
  const headT = `translate(${f(headX)},${f(headY)}) rotate(${f(p.head.tilt)} 0 ${f(30 * B.head)}) scale(${f(B.head)})`;
  const hl = rot(L, -p.head.tilt - p.lean); // light shift in head space
  const H = { doc, D, t, pitch: p.head.pitch, ink, hl, face: p.face, sweat: p.fx.filter(x => x.type === 'sweat') };
  const hair = HAIR[D.hair.style](H);
  // Headless generator evidence: isolate actual masked shine and its hair support,
  // with the same pose transforms, without outlines or effects widening the alpha.
  const rootTransform = `translate(${f(p.x)},${f(p.y)}) translate(96,196) rotate(${f(p.lean)}) scale(${f(p.sx)},${f(p.sy)}) translate(-96,-196)`;
  if (proof) return doc.wrap(g(g(doc.hairProof.map(s => s[proof]).join(''), { transform: headT }), { transform: rootTransform }));

  let back = g(hair.back, { transform: headT });
  let body = '';
  body += ['l', 'r'].filter(s => arms[s].behind).map(s => drawArm(doc, D, arms[s], L)).join('');
  if (D.tail) body += drawTail(doc, D, p, B, t, L);
  body += ['l', 'r'].map(s => drawLeg(doc, D, hip(s), p.legs[s], t, L, B)).join('');
  body += path(capsuleD(CX + 2 * t, B.neck[0], CX + 2 * t, B.neck[1], 6.2 * B.limb, 6.6 * B.limb), { fill: (D.neck ?? D.skin).shade, stroke: (D.neck ?? D.skin).line, 'stroke-width': 1.1 });
  body += OUTFIT[D.outfit.style](doc, D, { t, bt, headX, L, B });
  body += props.filter(x => x.type !== 'card').map(x => drawProp(doc, D, x)).join('');
  body += ['l', 'r'].filter(s => !arms[s].behind && !arms[s].front).map(s => drawArm(doc, D, arms[s], L)).join('');
  body += g(drawHead(H, hair), { transform: headT });
  body += props.filter(x => x.type === 'card').map(x => drawProp(doc, D, x)).join('');
  body += ['l', 'r'].filter(s => arms[s].front).map(s => drawArm(doc, D, arms[s], L)).join('');

  const character = outlineUnderlay(back + body, { ink, rim: D.rim ?? 1.5, sticker: D.sticker ?? 0, stickerColor: D.stickerColor ?? '#ffffff' }) + back + body;
  const fxs = p.fx.map(x => x.at === 'head' && B.head !== 1 ? { ...x, dx: (x.dx ?? 0) * B.head, dy: (x.dy ?? 0) * B.head } : x);
  const fxBack = drawFx(fxs, anchor, ink, 'back'), fxFront = drawFx(fxs, anchor, ink, 'front');
  recordAnchors(anchor, p);
  const root = rootTransform;
  return doc.wrap(g(fxBack + character + fxFront, { transform: root }));
}

/** Per-design calm-down: expression swaps and default eyes. Motion energy is applied by the poses via ctx.E. */
function temper(D, pose) {
  const p = structuredClone(pose), map = D.expr ?? {};
  const sw = v => (typeof v === 'string' ? map[v] ?? v : v);
  const e = p.face.eyes;
  p.face.eyes = typeof e === 'object' ? { l: sw(e.l), r: sw(e.r) } : sw(e);
  p.face.mouth = sw(p.face.mouth); p.face.brows = sw(p.face.brows);
  return p;
}

// ---------- limbs ----------
function drawArm(doc, D, A, L) {
  const sl = D.outfit.sleeve;
  const k = A.limb ?? 1;
  let s = cel(doc, capsuleD(...A.sh, ...A.el, 6.5 * k, 5.9 * k), sl, { shift: L });
  s += cel(doc, capsuleD(...A.el, ...A.wr, 5.9 * k, 5.2 * k), sl, { shift: L });
  const n = [-A.d2[1], A.d2[0]];
  if (D.outfit.cuffs === 'pixels') {
    const col = A.s === 'l' ? FX.warm : FX.cool, w = A.wr, d = A.d2;
    const sq = (x, y, sz, op = 1) => path(rrD(x - sz / 2, y - sz / 2, sz, sz, 0.3), { fill: col, opacity: op < 1 ? op : undefined });
    for (const k of [-3.5, 0, 3.5]) s += sq(w[0] - d[0] * 1.8 + n[0] * k, w[1] - d[1] * 1.8 + n[1] * k, 3.4);
    for (const [k, j, sz] of [[-1.7, -5.6, 3], [1.9, -9.2, 2.4]]) s += sq(w[0] + d[0] * j + n[0] * k, w[1] + d[1] * j + n[1] * k, sz);
    const out = A.sg; s += sq(w[0] + d[0] * -4 + out * 9.5, w[1] + d[1] * -4 - 1, 2.8) + sq(w[0] + d[0] * -8 + out * 11.5, w[1] + d[1] * -8 - 3, 2.1);
  } else if (D.outfit.cuffs === 'band') {
    s += cel(doc, capsuleD(A.wr[0] - A.d2[0] * 3.5, A.wr[1] - A.d2[1] * 3.5, A.wr[0], A.wr[1], 5.9, 5.6), D.outfit.cuff, { shift: L, lw: 1.1 });
  }
  return s + drawHand(doc, D, A, n, L);
}

function drawHand(doc, D, A, n, L) {
  const sk = D.hands ?? D.skin, [x, y] = A.hc, d = A.d2, phi = Math.atan2(d[1], d[0]) / RAD;
  const inward = n[0] * -A.sg + n[1] * 0.3 > 0 ? n : [-n[0], -n[1]];
  const o = { shift: L, lw: 1.2, line: sk.line };
  switch (A.hand) {
    case 'fist': return cel(doc, ellD(x, y, 5.6, 5.4, phi), sk, o) + path(`M${f(x + inward[0] * 1.5 - d[0] * 1)},${f(y + inward[1] * 1.5 - d[1] * 1)}l${f(d[0] * 3)},${f(d[1] * 3)}`, { stroke: sk.line, 'stroke-width': 1, 'stroke-linecap': 'round' });
    case 'point': return cel(doc, capsuleD(x + d[0] * 2, y + d[1] * 2, x + d[0] * 11.5, y + d[1] * 11.5, 2.5, 2.1), sk, o) + cel(doc, ellD(x, y, 5.3, 5.1, phi), sk, o);
    case 'thumb': return cel(doc, ellD(x, y, 5.8, 5.6, phi), sk, o) + cel(doc, capsuleD(x + inward[0] * 1.2, y - 2.5, x + inward[0] * 1.2, y - 10.5, 2.7, 2.3), sk, o);
    case 'palm': { // open hand, fingers fanned toward d
      let s = '';
      for (const [ang, len] of [[-34, 4.6], [-12, 5.6], [10, 5.6], [31, 4.8]]) {
        const r = rot(d, ang * A.sg), b = [x + r[0] * 3.6, y + r[1] * 3.6], e = [x + r[0] * (3.6 + len), y + r[1] * (3.6 + len)];
        s += cel(doc, capsuleD(...b, ...e, 2.1, 1.9), sk, { ...o, lw: 1.1 });
      }
      const tr = rot(d, -78 * A.sg * (inward === n ? 1 : -1));
      s += cel(doc, capsuleD(x, y, x + tr[0] * 7.6, y + tr[1] * 7.6, 2.4, 2.1), sk, { ...o, lw: 1.1 });
      s += cel(doc, ellD(x, y, 5.6, 5.4, phi), sk, o);
      return s;
    }
    default: { // mitten
      const th = [x + inward[0] * 4.6, y + inward[1] * 4.6];
      return cel(doc, ellD(x, y, 6.4, 5.4, phi), sk, o) + cel(doc, ellD(th[0], th[1], 2.9, 2.1, phi - 30 * A.sg), sk, { ...o, noShade: true });
    }
  }
}

function drawLeg(doc, D, [hx, hy], Lg, t, L, B) {
  const len = B.leg * (1 - 0.32 * (Lg.lift ?? 0)), a = (Lg.a ?? 0) * RAD;
  const ax = hx + Math.sin(a) * len, ay = hy + Math.cos(a) * len;
  let s = cel(doc, capsuleD(hx, hy, ax, ay, 7.6 * B.limb, 5.6 * B.limb), D.legs.pants, { shift: L });
  const fx = ax + 2.5 * t + (hx < CX + 3 * t ? -1.2 : 1.2), fy = ay + 3.6, rr = (Lg.a ?? 0) * 0.5 - (Lg.lift ?? 0) * 12 * Math.sign(t || 1);
  const shoe = ellD(fx, fy, 8.2, 5, rr);
  const sole = rot([0, 3.2], rr);
  s += cel(doc, shoe, D.legs.shoes, { shift: L, shade: [ellD(fx + sole[0], fy + sole[1] + 1.8, 9, 3.2, rr)], light: [ellD(fx - 2.6, fy - 1.8, 2.6, 1.4, rr)] });
  return s;
}

// ---------- head ----------
function drawHead(H, hair) {
  const { doc, D, t, pitch, ink, hl, face } = H, sk = D.skin;
  const F = { chin: 33, cheek: 24, jaw: 13, ...D.faceShape }, cy = F.chin, chin = 7 * t;
  const faceD = D.species === 'fox' ? foxFaceD(t)
    : `M-34,-2C-34,-24 -18,-33 0,-33C18,-33 34,-24 34,-2C34,${F.jaw} ${F.cheek},${cy - 7} ${f(chin + 6)},${f(cy - 1.5)}Q${f(chin)},${f(cy + 1)} ${f(chin - 6)},${f(cy - 1.5)}C${-F.cheek},${cy - 7} -34,${F.jaw} -34,-2Z`;
  const castShadow = hair.cast.map(d => path(d, { fill: sk.shade, transform: `translate(${f(1.5 - hl[0] * 0.2)},${f(4.6)})` })).join('');
  const fid = doc.id('fc'); doc.def(`<clipPath id="${fid}"><path d="${faceD}"/></clipPath>`);
  let s = path(faceD, { fill: sk.base });
  s += g(castShadow +
    path(`M${f(20 + 9 * t)},${f(-5)}C${f(36)},${f(-2)} ${f(33)},${f(20)} ${f(chin + 8)},${f(31)}L40,40L40,-10Z`, { fill: sk.shade, opacity: t < -0.2 ? 0 : 1 }), { 'clip-path': `url(#${fid})` });
  if (D.species === 'fox') s += foxMuzzle(doc, D, t, pitch, faceD);
  s += path(faceD, { fill: 'none', stroke: sk.line, 'stroke-width': 1.2 });

  const ey = 4 + pitch * 7;
  const eyes = typeof face.eyes === 'object' ? face.eyes : { l: face.eyes, r: face.eyes };
  const look = face.look ?? [0, 0];
  const pos = { l: -14.5 + 11 * t + 3 * Math.max(0, -t), r: 14.5 + 11 * t - 3 * Math.max(0, t) };
  const k = { l: 1 - 0.32 * Math.max(0, -t), r: 1 - 0.32 * Math.max(0, t) };
  if (face.blush) for (const sd of ['l', 'r']) s += path(ellD(pos[sd] + sideSign(sd) * 4.5 + 2 * t, ey + 11.5, 5 * k[sd], 2.5), { fill: D.blush ?? '#ff8f9a', opacity: 0.55 });
  for (const sd of ['l', 'r']) s += drawEye(doc, D, pos[sd], ey, k[sd], sideSign(sd), eyes[sd], look, D.iris[sd] ?? D.iris);
  if (D.glasses) s += drawGlasses(D, pos, ey, k);
  if (D.nose) s += path(`M${f(11 * t + 1.4)},${f(10.5 + pitch * 5)}q${f(0.9 + 1.2 * t)},2.6 ${f(-1.4)},3.4`, { fill: 'none', stroke: sk.line, 'stroke-width': 1.1, 'stroke-linecap': 'round', opacity: 0.8 });
  s += drawMouth(D, 12 * t, (D.mouthY ?? 20.5) + pitch * 5, face.mouth, ink);
  s += hair.front;
  for (const sd of ['l', 'r']) s += drawBrow(D, pos[sd], ey - 13.5, k[sd], sideSign(sd), face.brows);
  for (const sw of H.sweat) s += sweatDrop(sw.side === 'l' ? -35 : 35, -17, ink);
  return s;
}

function drawEye(doc, D, ex, ey, k, s, type, look, ir) {
  const ink = D.ink, W = (D.eye?.w ?? 14) * k, Hh = D.eye?.h ?? 17.5;
  const stroke = (d, w) => path(d, { fill: 'none', stroke: ink, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  if (type === 'happy') return stroke(`M${f(ex - W * 0.55)},${f(ey + 2)}Q${f(ex)},${f(ey - Hh * 0.62)} ${f(ex + W * 0.55)},${f(ey + 2)}`, 2.7);
  if (type === 'closed') return stroke(`M${f(ex - W * 0.55)},${f(ey)}Q${f(ex)},${f(ey + Hh * 0.34)} ${f(ex + W * 0.55)},${f(ey)}`, 2.4) + stroke(`M${f(ex + s * W * 0.55)},${f(ey)}l${f(s * 2.6)},${f(-1.8)}`, 1.8);
  if (type === 'x') { const r = W * 0.36; return stroke(`M${f(ex - r)},${f(ey - r)}L${f(ex + r)},${f(ey + r)}M${f(ex + r)},${f(ey - r)}L${f(ex - r)},${f(ey + r)}`, 2.5); }
  if (type === 'squeeze') { const r = W * 0.4, q = -s; return stroke(`M${f(ex - q * r)},${f(ey - Hh * 0.28)}L${f(ex + q * r)},${f(ey + 0.5)}L${f(ex - q * r)},${f(ey + Hh * 0.3)}`, 2.6); }

  const lidOf = { open: 0, calm: 0.2, half: 0.52, focus: 0.3, sad: 0.24, wide: 0, soft: 0.12 };
  const lid = lidOf[type] ?? 0, wide = type === 'wide';
  const w = wide ? W * 1.1 : W, h = wide ? Hh * 1.08 : Hh;
  const top = ey - h * 0.47, bot = ey + h * 0.45, corner = ey - 1;
  const scl = `M${f(ex - w / 2)},${f(corner)}C${f(ex - w / 2)},${f(ey - h * 0.62)} ${f(ex + w / 2)},${f(ey - h * 0.62)} ${f(ex + w / 2)},${f(corner)}C${f(ex + w / 2)},${f(ey + h * 0.6)} ${f(ex - w / 2)},${f(ey + h * 0.6)} ${f(ex - w / 2)},${f(corner)}Z`;
  const peak = lerp(top, ey + 1.5, lid), tilt = type === 'sad' ? 2.2 : type === 'focus' ? -0.8 : 0;
  const ci = corner + (lid ? -tilt * 0.5 : 0) - (lid ? 0.5 : 0), co = corner + tilt - (lid ? 0.5 : 0);
  const xi = ex - s * w * 0.56, xo = ex + s * w * 0.58;
  const ctrl = 2 * peak - (ci + co) / 2;
  const lidClip = `M${f(ex - s * w)},${f(ci)}L${f(xi)},${f(ci)}Q${f(ex)},${f(ctrl)} ${f(xo)},${f(co)}L${f(ex + s * w)},${f(co)}L${f(ex + s * w)},${f(bot + 6)}L${f(ex - s * w)},${f(bot + 6)}Z`;
  const cid = doc.id('ey'), lidId = doc.id('ld');
  doc.def(`<clipPath id="${cid}"><path d="${scl}"/></clipPath><clipPath id="${lidId}"><path d="${lidClip}"/></clipPath>`);

  const is = (wide ? 0.6 : 1) * (D.irisScale ?? 1), irx = w * 0.41 * is, iry = h * 0.41 * is;
  const icx = ex + look[0] * w * 0.17, icy = ey + 1.4 + look[1] * h * 0.12;
  let iris = path(ellD(icx, icy, irx, iry), { fill: ir.base });
  iris += path(ellD(icx, icy - iry * 1.08, irx * 1.35, iry * 0.98), { fill: ir.shade });
  iris += path(ellD(icx, icy + iry * 0.92, irx * 0.74, iry * 0.4), { fill: ir.light });
  iris += path(ellD(icx, icy + 0.3, irx * 0.44, iry * 0.5), { fill: ir.pupil });
  iris += path(ellD(icx, icy, irx, iry), { fill: 'none', stroke: ir.pupil, 'stroke-width': 0.9 });
  iris += path(ellD(icx - irx * 0.34, icy - iry * 0.36, w * 0.15, w * 0.17), { fill: '#ffffff' });
  iris += path(ellD(icx + irx * 0.4, icy + iry * 0.44, w * 0.075), { fill: '#ffffff' });
  let eye = path(scl, { fill: '#ffffff' });
  eye += g(path(ellD(ex, top - 0.6, w * 0.7, h * 0.2), { fill: D.sclera ?? '#d9d7ee' }) + iris, { 'clip-path': `url(#${cid})` });
  eye += path(scl, { fill: 'none', stroke: ink, 'stroke-width': 0.8, opacity: 0.45 });
  let out = g(eye, { 'clip-path': `url(#${lidId})` });
  // upper lash along the lid line, with a small outer flick
  const th = wide ? 1.5 : (D.lash ?? 2.8) * (lid > 0.4 ? 0.9 : 1);
  const fx = xo + s * 2.6, fy = co - (wide ? 1 : 2.8);
  out += path(`M${f(xi)},${f(ci + 0.6)}Q${f(ex)},${f(ctrl - th * 1.25)} ${f(fx)},${f(fy)}L${f(xo)},${f(co + 1.4)}Q${f(ex)},${f(ctrl + 0.2)} ${f(xi + s * 1.2)},${f(ci + 1.4)}Z`, { fill: ink, stroke: ink, 'stroke-width': 0.6, 'stroke-linejoin': 'round' });
  out += path(`M${f(ex + s * w * 0.1)},${f(bot + 0.2)}Q${f(ex + s * w * 0.34)},${f(bot)} ${f(ex + s * w * 0.46)},${f(bot - 2.6)}`, { fill: 'none', stroke: ink, 'stroke-width': 1.1, 'stroke-linecap': 'round', opacity: 0.85 });
  return out;
}

function drawBrow(D, ex, by, k, s, type = 'neutral') {
  const T = { neutral: [0, 0.6, 1.6], up: [-3.2, -2.4, 2], worried: [-3.6, 0.8, 0.6], determined: [2.4, -1.4, 0.4], calm: [0.4, 0.6, 0.6] }[type] ?? [0, 0.6, 1.6];
  const xi = ex - s * 5 * k, xo = ex + s * 6.5 * k, yi = by + T[0], yo = by + T[1];
  return path(`M${f(xi)},${f(yi)}Q${f(ex + s * 1.5 * k)},${f((yi + yo) / 2 - T[2])} ${f(xo)},${f(yo)}`, { fill: 'none', stroke: D.brow ?? D.ink, 'stroke-width': 2.1, 'stroke-linecap': 'round' });
}

function drawMouth(D, mx, my, type = 'smile', ink) {
  const dark = D.mouth ?? '#6e2a3c', tongue = '#ff8d8d';
  const st = (d, w = 1.6) => path(d, { fill: 'none', stroke: ink, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  switch (type) {
    case 'grin': {
      const d = `M${f(mx - 6.2)},${f(my - 1.6)}L${f(mx + 6.2)},${f(my - 1.6)}Q${f(mx + 6)},${f(my + 7.4)} ${f(mx)},${f(my + 7.6)}Q${f(mx - 6)},${f(my + 7.4)} ${f(mx - 6.2)},${f(my - 1.6)}Z`;
      return path(d, { fill: dark }) + path(`M${f(mx - 3.6)},${f(my + 5.6)}Q${f(mx + 0.6)},${f(my + 1.8)} ${f(mx + 4.2)},${f(my + 5.2)}Q${f(mx)},${f(my + 8)} ${f(mx - 3.6)},${f(my + 5.6)}Z`, { fill: tongue }) + path(d, { fill: 'none', stroke: ink, 'stroke-width': 1.4, 'stroke-linejoin': 'round' });
    }
    case 'smile2': {
      const d = `M${f(mx - 4.4)},${f(my - 0.8)}Q${f(mx)},${f(my + 0.4)} ${f(mx + 4.4)},${f(my - 0.8)}Q${f(mx + 3.6)},${f(my + 4.6)} ${f(mx)},${f(my + 4.8)}Q${f(mx - 3.6)},${f(my + 4.6)} ${f(mx - 4.4)},${f(my - 0.8)}Z`;
      return path(d, { fill: dark, stroke: ink, 'stroke-width': 1.3, 'stroke-linejoin': 'round' });
    }
    case 'shout': {
      const d = `M${f(mx - 5)},${f(my - 2.4)}L${f(mx + 5)},${f(my - 2.4)}L${f(mx + 7)},${f(my + 7)}Q${f(mx)},${f(my + 9.5)} ${f(mx - 7)},${f(my + 7)}Z`;
      return path(d, { fill: dark, stroke: ink, 'stroke-width': 1.4, 'stroke-linejoin': 'round' }) + path(ellD(mx, my + 6, 3.6, 1.8), { fill: tongue });
    }
    case 'open': return path(ellD(mx, my + 2, 3.6, 4.4), { fill: dark, stroke: ink, 'stroke-width': 1.4 }) + path(ellD(mx, my + 4.2, 2.2, 1.4), { fill: tongue });
    case 'o': return path(ellD(mx, my + 1.4, 2.4, 2.8), { fill: dark, stroke: ink, 'stroke-width': 1.3 });
    case 'flat': return st(`M${f(mx - 3.6)},${f(my + 0.6)}L${f(mx + 3.6)},${f(my + 0.6)}`);
    case 'cat': return st(`M${f(mx - 5)},${f(my - 0.6)}Q${f(mx - 2.5)},${f(my + 2.8)} ${f(mx)},${f(my + 0.2)}Q${f(mx + 2.5)},${f(my + 2.8)} ${f(mx + 5)},${f(my - 0.6)}`, 1.5);
    case 'frown': return st(`M${f(mx - 4)},${f(my + 2.2)}Q${f(mx)},${f(my - 1.8)} ${f(mx + 4)},${f(my + 2.2)}`);
    case 'wobble': return st(`M${f(mx - 5.4)},${f(my + 1.2)}q1.35,-2 2.7,0t2.7,0t2.7,0t2.7,0`, 1.5);
    case 'tongue': return path(`M${f(mx + 0.8)},${f(my + 0.9)}q1.6,3.4 3.4,0Z`, { fill: tongue, stroke: ink, 'stroke-width': 1.1, 'stroke-linejoin': 'round' }) + st(`M${f(mx - 4)},${f(my - 0.2)}Q${f(mx)},${f(my + 2.2)} ${f(mx + 4.4)},${f(my - 0.4)}`, 1.5);
    case 'smirk': return st(`M${f(mx - 4.4)},${f(my + 0.8)}Q${f(mx + 0.6)},${f(my + 2.8)} ${f(mx + 4.6)},${f(my - 1.2)}`) + st(`M${f(mx + 4.4)},${f(my - 2.4)}l${f(1.2)},${f(1.6)}`, 1.1);
    case 'teeth': {
      const d = rrD(mx - 5.6, my - 1.4, 11.2, 6, 2.6);
      return path(d, { fill: '#ffffff' }) + st(`M${f(mx - 5)},${f(my + 1.6)}H${f(mx + 5)}`, 0.9) + path(d, { fill: 'none', stroke: ink, 'stroke-width': 1.4 });
    }
    default: return st(`M${f(mx - 4.6)},${f(my - 0.4)}Q${f(mx)},${f(my + 3.2)} ${f(mx + 4.6)},${f(my - 0.4)}`);
  }
}

function drawGlasses(D, pos, ey, k) {
  const G = D.glasses; let s = '';
  for (const sd of ['l', 'r']) {
    const x = pos[sd], rx = 9.6 * k[sd], ry = 9.2;
    s += path(ellD(x, ey + 0.8, rx, ry), { fill: G.tint, opacity: 0.22 });
    s += path(`M${f(x - rx * 0.55)},${f(ey - 4.2)}l${f(3.2 * k[sd])},${f(-3)}M${f(x - rx * 0.62)},${f(ey - 0.6)}l${f(5.2 * k[sd])},${f(-5)}`, { stroke: '#ffffff', 'stroke-width': 1.3, 'stroke-linecap': 'round', opacity: 0.9 });
    s += path(ellD(x, ey + 0.8, rx, ry), { fill: 'none', stroke: G.frame, 'stroke-width': 1.6 });
  }
  const a = pos.l + 9.6 * k.l, b = pos.r - 9.6 * k.r;
  s += path(`M${f(a)},${f(ey - 0.6)}Q${f((a + b) / 2)},${f(ey - 3.6)} ${f(b)},${f(ey - 0.6)}`, { fill: 'none', stroke: G.frame, 'stroke-width': 1.5, 'stroke-linecap': 'round' });
  return s;
}

// ---------- fox head (head space) ----------
function foxFaceD(t) {
  const c = 6 * t, R = [[20, -34], [36, -23], [37, -5], [45, 9], [36, 11], [41, 21], [28, 22], [12, 31]];
  const pt = ([x, y], sg) => [sg * x + (y > 0 ? c : 0), y];
  const right = R.map(q => pt(q, 1)), left = R.map(q => pt(q, -1)).reverse();
  return 'M0,-34' + `C${f(right[0][0])},${f(right[0][1])} ${f(right[1][0])},${f(right[1][1])} ${f(right[2][0])},${f(right[2][1])}` +
    right.slice(3, 7).map(([x, y]) => `L${f(x)},${f(y)}`).join('') + `Q${f(right[7][0])},${f(right[7][1])} ${f(c)},33` +
    `Q${f(left[0][0])},${f(left[0][1])} ${f(left[1][0])},${f(left[1][1])}` + left.slice(2, 5).map(([x, y]) => `L${f(x)},${f(y)}`).join('') +
    `L${f(left[5][0])},${f(left[5][1])}C${f(left[6][0])},${f(left[6][1])} ${f(left[7][0])},${f(left[7][1])} 0,-34Z`;
}
function foxMuzzle(doc, D, t, pitch, faceD) {
  const c = 9 * t, id = doc.id('mz'); doc.def(`<clipPath id="${id}"><path d="${faceD}"/></clipPath>`);
  const top = `M-60,19C${f(-30 + c)},11 ${f(-16 + c)},19 ${f(-6 + c)},12Q${f(c)},8 ${f(6 + c)},12C${f(16 + c)},19 ${f(30 + c)},11 60,19L60,60L-60,60Z`;
  let s = g(cel(doc, top, D.muzzle, { shift: [-2, -2.5], lw: 1.1 }), { 'clip-path': `url(#${id})` });
  const nx = 11 * t, ny = 13.5 + pitch * 5;
  s += path(`M${f(nx - 3.4)},${f(ny - 1.6)}Q${f(nx)},${f(ny - 2.8)} ${f(nx + 3.4)},${f(ny - 1.6)}Q${f(nx + 2.4)},${f(ny + 1.8)} ${f(nx)},${f(ny + 2.4)}Q${f(nx - 2.4)},${f(ny + 1.8)} ${f(nx - 3.4)},${f(ny - 1.6)}Z`, { fill: D.ink });
  s += path(ellD(nx - 1, ny - 1.2, 1, 0.6), { fill: '#ffffff' });
  return s;
}
function drawTail(doc, D, p, B, t, L) {
  const sway = -p.lean * 1.8 + p.x * 1.5 - p.y * 1.2 + (p.arms.r.a - p.arms.l.a) * 0.04;
  const base = [CX + 14 + 2 * t, B.hipY - 2], ang = 28 + sway;
  const pts = [[0, -4], [13, -12], [25, -28], [30, -45], [25, -60], [15, -60], [9, -46], [2, -28], [-5, -10], [-3, 4]];
  const tr = ([x, y]) => { const [u, v] = rot([x, y], ang); return [base[0] + u, base[1] + v]; };
  const d = smoothD(pts.map(tr));
  const id = doc.id('tl'); doc.def(`<clipPath id="${id}"><path d="${d}"/></clipPath>`);
  const tipCut = [[-20, -44], [40, -40], [40, -80], [-20, -80]].map(tr);
  let s = cel(doc, d, D.tail.pal, { shift: L });
  s += g(cel(doc, 'M' + tipCut.map(([x, y]) => `${f(x)},${f(y)}`).join('L') + 'Z', D.tail.tip, { shift: L, lw: 0 }), { 'clip-path': `url(#${id})` });
  s += path(d, { fill: 'none', stroke: D.tail.pal.line, 'stroke-width': 1.2 });
  return s;
}

// ---------- hair styles (head space: face center at 0,0, chin at y 33) ----------
const HAIR = {
  // Fox ears with cool tips and a small forehead tuft. No hair, so no cast shadow on the face.
  fox(H) {
    const { doc, D, t, hl } = H, bx = -3 * t, E = D.ears;
    let back = '';
    for (const sg of [-1, 1]) {
      const a = [sg * 33 + bx, -16], b = [sg * 11 + bx, -33], tip = [sg * 37 + bx, -52];
      const ear = `M${f(a[0])},${f(a[1])}Q${f(sg * 30 + bx)},-42 ${f(tip[0])},${f(tip[1])}Q${f(sg * 22 + bx)},-44 ${f(b[0])},${f(b[1])}Z`;
      const inner = `M${f(sg * 29 + bx)},-21Q${f(sg * 29 + bx)},-38 ${f(sg * 34 + bx)},-48Q${f(sg * 22 + bx)},-40 ${f(sg * 16 + bx)},-30Z`;
      const id = doc.id('er'); doc.def(`<clipPath id="${id}"><path d="${ear}"/></clipPath>`);
      back += cel(doc, ear, D.skin, { shift: hl }) + cel(doc, inner, E.inner, { shift: hl, lw: 0.9 });
      back += g(path(`M${sg * 20 + bx},-49L${sg * 50 + bx},-49L${sg * 50 + bx},-70L${sg * 20 + bx},-70Z`, { fill: E.tip.base }) + path(`M${sg * 30 + bx},-49L${sg * 50 + bx},-49L${sg * 50 + bx},-70Z`, { fill: E.tip.shade }), { 'clip-path': `url(#${id})` });
      back += path(ear, { fill: 'none', stroke: D.skin.line, 'stroke-width': 1.2 });
    }
    const ox = 7 * t;
    const tuft = [lockD([-9 + ox, -33], [-1 + ox, -34], [-6 + ox, -22], -1), lockD([-2 + ox, -34], [6 + ox, -33], [3 + ox, -21], 1), lockD([4 + ox, -33], [11 + ox, -31], [10 + ox, -23], 1)];
    const front = tuft.map(d => cel(doc, d, D.skin, { shift: hl, lw: 1 })).join('');
    return { back, front, cast: [] };
  },
  // Sleek adult cut: a long bang swept from a side part, hair tucked on the other side, a low side ponytail.
  sleek(H) {
    const { doc, D, t, hl } = H, pal = D.hair.pal, bx = -4 * t, ox = 7 * t;
    const X = x => f(x + ox);
    const blob = smoothD([[-40, -6], [-37, -30], [-21, -45], [0, -49], [22, -45], [37, -30], [40, -6], [38, 14], [30, 24], [-30, 24], [-38, 14]].map(([x, y]) => [x + bx, y]));
    const bang = `M${X(9)},-47C${X(-12)},-47 ${X(-31)},-37 ${X(-37)},6C${X(-30)},-10 ${X(-17)},-17 ${X(3)},-15C${X(7)},-21 ${X(9)},-32 ${X(9)},-47Z`;
    const bang2 = `M${X(9)},-47C${X(23)},-45 ${X(34)},-34 ${X(35)},-9C${X(29)},-21 ${X(21)},-25 ${X(11)},-23C${X(11)},-30 ${X(10)},-38 ${X(9)},-47Z`;
    const cap = smoothD([[-35, -12], [-33, -32], [-18, -44], [0, -47], [18, -44], [33, -32], [35, -12], [22, -22], [0, -25], [-22, -22]].map(([x, y]) => [x + ox, y]));
    const sideL = leafD(-33 + ox, -18, 5, [-35 + ox, 30], -2), sideR = leafD(31 + ox, -20, 4, [33 + ox, 22], 2);
    const tail = leafD(29 + ox, 16, 7, [36 + ox, 80], 7, 0.7);
    const strand = `M${X(-6)},-44Q${X(-22)},-30 ${X(-30)},-4M${X(2)},-46Q${X(-8)},-34 ${X(-14)},-17`;
    const shine = [-24, -14, -4, 6].map(x => { const X2 = x + ox, y = -35 + 0.007 * x * x; return `M${f(X2 - 3.4)},${f(y + 1)}Q${f(X2)},${f(y - 2.2)} ${f(X2 + 3.6)},${f(y + 0.6)}Q${f(X2)},${f(y + 2.4)} ${f(X2 - 3.4)},${f(y + 1)}Z`; });
    const back = cel(doc, blob, pal, { shift: hl, lw: 1.2 });
    let front = cel(doc, cap, pal, { shift: hl, lw: 0 }) + cel(doc, sideL, pal, { shift: hl }) + cel(doc, sideR, pal, { shift: hl });
    front += cel(doc, bang2, pal, { shift: hl, lw: 1.1 }) + cel(doc, bang, pal, { shift: hl, lw: 1.1 });
    front += hairShine(doc, [cap, bang], shine, pal.light) + path(strand, { fill: 'none', stroke: pal.line, 'stroke-width': 1, 'stroke-linecap': 'round' });
    front += cel(doc, tail, pal, { shift: hl, lw: 1.2 }) + cel(doc, rrD(24 + ox, 18, 10, 5, 2.2), D.hair.tie, { shift: hl, lw: 1 });
    return { back, front, cast: [bang, bang2, sideL, sideR] };
  },
  // Short spiky hair, optionally split warm (viewer's left) and cool (right) along the part line.
  spiky(H) {
    const { doc, D, t, hl } = H, hr = D.hair, bx = -4 * t, ox = 8 * t;
    const mv = (pts, dx) => pts.map(([x, y]) => [x + dx, y]);
    const blob = smoothD(mv([[-41, -4], [-38, -28], [-23, -43], [0, -48], [23, -43], [38, -28], [41, -4], [38, 14], [30, 22], [-30, 22], [-38, 14]], bx));
    const sideSp = [[[-41, -14], [-38, 2], [-50, 9], -2], [[-40, 2], [-33, 12], [-45, 25], -1], [[-34, 11], [-26, 18], [-34, 32], 0]];
    const spikes = [...sideSp, ...sideSp.map(([a, b, c, d]) => [[-b[0], b[1]], [-a[0], a[1]], [-c[0], c[1]], -d])].map(([a, b, c, d]) => lockD(mv([a], bx)[0], mv([b], bx)[0], mv([c], bx)[0], d));
    const ahoge = lockD([-2 + bx, -46], [6 + bx, -47], [11 + bx, -56], 6);
    const cap = smoothD(mv([[-35, -12], [-33, -32], [-18, -44], [0, -47], [18, -44], [33, -32], [35, -12], [22, -22], [0, -25], [-22, -22]], ox));
    // x, half width, tip, curl. Side locks first so the forehead locks layer over them.
    const lockList = [[-29, 8, [-38, 17], -4], [30, 8, [39, 15], 4], [-22, 10, [-25, -2], -3], [22, 10, [27, -1], 4], [-10, 10, [-12, -7], -2], [11, 10, [14, -8], 3], [0, 8, [1, -4], 1]];
    const lockArgs = lockList.map(([x, w, [tx, ty], c]) => [x + ox, -42 + 0.011 * x * x, w, [tx + ox, ty], c]);
    const locks = lockArgs.map(a => leafD(...a)), lockSides = lockArgs.map(a => leafSidesD(...a));
    const shine = [-21, -11, -1, 9, 19].map(x => { const X = x + ox, y = -33 + 0.006 * x * x; return `M${f(X - 3.4)},${f(y + 1)}Q${f(X)},${f(y - 2.2)} ${f(X + 3.6)},${f(y + 0.6)}Q${f(X)},${f(y + 2.4)} ${f(X - 3.4)},${f(y + 1)}Z`; });
    const paint = (pal, clip) => {
      const back = spikes.map(d => cel(doc, d, pal, { shift: hl })).join('') + cel(doc, blob, pal, { shift: hl, lw: 1.2 }) + (hr.ahoge ? cel(doc, ahoge, pal, { shift: hl, lw: 1.2 }) : '');
      const front = cel(doc, cap, pal, { shift: hl, lw: 0 }) + locks.map((d, i) => cel(doc, d, pal, { shift: hl, lw: 1.1, outline: lockSides[i] })).join('') + hairShine(doc, [cap, ...locks], shine, pal.light);
      return clip ? { back: g(back, { 'clip-path': `url(#${clip})` }), front: g(front, { 'clip-path': `url(#${clip})` }) } : { back, front };
    };
    let back, front;
    if (hr.split) {
      const xs = 2 + 9 * t, a = doc.id('hl'), b = doc.id('hr');
      doc.def(`<clipPath id="${a}"><rect x="-80" y="-90" width="${f(80 + xs)}" height="200"/></clipPath><clipPath id="${b}"><rect x="${f(xs)}" y="-90" width="90" height="200"/></clipPath>`);
      const L = paint(hr.palL, a), R = paint(hr.palR, b);
      back = L.back + R.back; front = L.front + R.front;
    } else ({ back, front } = paint(hr.pal));
    if (hr.clip === 'spark') front += path(starD(22 + ox, -24, 6.6, 12), { fill: '#ffffff', stroke: D.ink, 'stroke-width': 1.4, 'stroke-linejoin': 'round' });
    return { back, front, cast: [cap, ...locks] };
  },
  // Long straight hime cut: blunt fringe, straight side locks, a hair column behind the shoulders.
  hime(H) {
    const { doc, D, t, hl } = H, hr = D.hair, pal = hr.pal, bx = -4 * t, ox = 7 * t;
    const backD = `M${f(-39 + bx)},-8C${f(-41 + bx)},-34 ${f(-24 + bx)},-49 ${f(bx)},-49C${f(24 + bx)},-49 ${f(41 + bx)},-34 ${f(39 + bx)},-8L${f(41 + bx)},50L${f(35 + bx)},53L${f(30 + bx)},49.5L${f(24 + bx)},53L${f(-24 + bx)},53L${f(-30 + bx)},49.5L${f(-35 + bx)},53L${f(-41 + bx)},50Z`;
    const fb = -9.5; // fringe bottom
    const wave = `L${f(33 + ox)},${fb}Q${f(25 + ox)},${fb + 1.4} ${f(17 + ox)},${fb}Q${f(9 + ox)},${fb + 1.8} ${f(1 + ox)},${fb}Q${f(-7 + ox)},${fb + 1.6} ${f(-15 + ox)},${fb}Q${f(-25 + ox)},${fb + 1.4} ${f(-33 + ox)},${fb}`;
    const fringe = `M${f(-34 + ox)},-14C${f(-34 + ox)},-37 ${f(-19 + ox)},-46 ${f(ox)},-46C${f(19 + ox)},-46 ${f(34 + ox)},-37 ${f(34 + ox)},-14${wave}Z`;
    const fringeEdge = `M${f(34 + ox)},-22L${f(34 + ox)},-14${wave}L${f(-34 + ox)},-14L${f(-34 + ox)},-22`;
    const side = sg => { const x0 = sg * 36 + ox, x1 = sg * 26.5 + ox; return `M${f(x0)},-18L${f(x1)},-18L${f(x1 + sg * 0.6)},31L${f(x0 - sg * 0.4)},34Z`; };
    const strands = [-15, 1, 17].map(x => `M${f(x + ox)},${fb - 0.2}L${f(x + ox - 0.8)},${fb - 8}`).join('') + `M${f(ox - 2)},-45Q${f(ox - 4)},-38 ${f(ox - 9)},-33`;
    const shine = [-20, -9, 2, 13, 23].map(x => { const X = x + ox, y = -32 + 0.005 * x * x; return `M${f(X - 3.6)},${f(y + 1)}Q${f(X)},${f(y - 2.2)} ${f(X + 3.6)},${f(y + 0.6)}Q${f(X)},${f(y + 2.4)} ${f(X - 3.6)},${f(y + 1)}Z`; });
    const back = cel(doc, backD, pal, { shift: hl, lw: 1.2, shade: [`M${f(-30 + bx)},20L${f(30 + bx)},20L${f(34 + bx)},56L${f(-34 + bx)},56Z`] });
    let front = cel(doc, side(-1), pal, { shift: hl }) + cel(doc, side(1), pal, { shift: hl });
    front += cel(doc, fringe, pal, { shift: hl, lw: 1.2, outline: fringeEdge }) + hairShine(doc, [fringe], shine, pal.light);
    front += path(strands, { fill: 'none', stroke: pal.line, 'stroke-width': 1, 'stroke-linecap': 'round' });
    if (hr.clip === 'bar') front += g(path(rrD(-6, -2, 12, 4, 2), { fill: hr.clipColor, stroke: D.ink, 'stroke-width': 1.2 }), { transform: `translate(${f(24 + ox)},-20) rotate(-28)` });
    return { back, front, cast: [fringe, side(-1), side(1)] };
  },
};

// ---------- outfits (body space) ----------
const OUTFIT = {
  fur(doc, D, { t, bt, headX, L, B }) {
    const O = D.outfit, zo = 6 * bt, hy = B.hipY;
    const d = `M${CX - 13},103C${CX - 22},106 ${CX - 27},130 ${CX - 26},${hy - 4}Q${CX},${hy + 10} ${CX + 26},${hy - 4}C${CX + 27},130 ${CX + 22},106 ${CX + 13},103Z`;
    let s = cel(doc, d, O.body, { shift: L, shade: [ellD(headX, 104, 17, 6.5)] });
    s += cel(doc, ellD(CX + zo, (118 + hy) / 2 + 2, 14, (hy - 110) / 2.6), O.belly, { shift: L, lw: 1 });
    const kx = CX + 2 * t;
    s += cel(doc, `M${f(kx - 14)},101L${f(kx + 14)},101Q${f(kx + 8)},110 ${f(kx + zo * 0.5)},119Q${f(kx - 8)},110 ${f(kx - 14)},101Z`, O.scarf, { shift: L, lw: 1.1 });
    s += cel(doc, ellD(kx, 104, 4.6, 3.4), O.scarf, { shift: L, lw: 1 });
    return s;
  },
  suit(doc, D, { t, bt, headX, L, B }) {
    const O = D.outfit, zo = 6 * bt, y0 = B.shY - 9, w = B.shoulder, hy = B.hipY;
    const d = `M${CX - 9},${y0}C${CX - 3},${y0 - 1.5} ${CX + 3},${y0 - 1.5} ${CX + 9},${y0}C${CX + w + 1},${y0 + 1} ${CX + w + 4},${y0 + 5} ${CX + w + 4},${y0 + 13}L${CX + w + 1},${hy - 14}Q${CX + w + 5},${hy + 4} ${CX + w + 4},${hy + 10}Q${CX},${hy + 14} ${CX - w - 4},${hy + 10}Q${CX - w - 5},${hy + 4} ${CX - w - 1},${hy - 14}L${CX - w - 4},${y0 + 13}C${CX - w - 4},${y0 + 5} ${CX - w - 1},${y0 + 1} ${CX - 9},${y0}Z`;
    let s = cel(doc, d, O.body, { shift: L, shade: [ellD(headX, y0 + 1, 13, 5)] });
    const vx = CX + zo;
    s += cel(doc, `M${f(vx - 7.5)},${y0}L${f(vx + 7.5)},${y0}L${f(vx)},${y0 + 30}Z`, O.shirt, { shift: L, lw: 1 });
    for (const sg of [-1, 1]) s += cel(doc, `M${f(vx + sg * 8)},${y0 - 0.5}L${f(vx + sg * 1)},${y0 + 30}L${f(vx + sg * 6)},${y0 + 17}L${f(vx + sg * 13)},${y0 + 8}Z`, O.lapel, { shift: L, lw: 1 });
    s += path(`M${f(vx)},${y0 + 30}L${f(vx + zo * 0.1)},${hy + 12}`, { stroke: D.ink, 'stroke-width': 1.1 });
    s += path(ellD(vx + 2, y0 + 36, 1.8), { fill: O.lapel.shade, stroke: D.ink, 'stroke-width': 0.9 });
    s += path(`M${f(CX - w + 2)},${y0 + 15}L${f(CX - w + 9)},${y0 + 15}L${f(CX - w + 5)},${y0 + 21}Z`, { fill: FX.warm, stroke: D.ink, 'stroke-width': 0.9 });
    s += path(starD(vx + 9, y0 + 13, 3.4, 10), { fill: '#ffffff', stroke: D.ink, 'stroke-width': 1 });
    return s;
  },
  jacket(doc, D, { t, bt, headX, L }) {
    const O = D.outfit, zo = 6 * bt;
    const d = `M${CX - 13},104C${CX - 4},101.5 ${CX + 4},101.5 ${CX + 13},104C${CX + 19},105.5 ${CX + 21},109 ${CX + 21.5},116L${CX + 24.5},153Q${CX + 25},158 ${CX + 20},158.5L${CX - 20},158.5Q${CX - 25},158 ${CX - 24.5},153L${CX - 21.5},116C${CX - 21},109 ${CX - 19},105.5 ${CX - 13},104Z`;
    const hem = `M${CX - 30},150Q${CX},154.5 ${CX + 30},150L${CX + 30},166L${CX - 30},166Z`;
    let s = cel(doc, d, O.body, { shift: L, shade: [ellD(headX, 104, 17, 6.5)] });
    const cid = doc.id('jk'); doc.def(`<clipPath id="${cid}"><path d="${d}"/></clipPath>`);
    s += g(path(hem, { fill: O.accent.base }), { 'clip-path': `url(#${cid})` });
    s += path(`M${CX - 24},151.2Q${CX},155.6 ${CX + 24},151.2`, { fill: 'none', stroke: D.ink, 'stroke-width': 1.1 });
    s += path(`M${f(CX + zo)},110L${f(CX + zo)},157`, { stroke: D.ink, 'stroke-width': 1.1 });
    s += cel(doc, `M${f(CX - 11 + 2 * t)},102.5Q${f(CX + 2 * t)},99.5 ${f(CX + 11 + 2 * t)},102.5L${f(CX + 10.6 + 2 * t)},108.4Q${f(CX + 2 * t)},111.6 ${f(CX - 10.6 + 2 * t)},108.4Z`, O.accent, { shift: L, lw: 1.1 });
    if (O.badge) {
      const bx = CX - 16 + zo * 0.6, by = 117;
      s += path(rrD(bx, by, 9, 9, 2.2), { fill: O.accent.base, stroke: D.ink, 'stroke-width': 1 });
      s += path(`M${f(bx + 2.4)},${f(by + 1.8)}L${f(bx + 2.4)},${f(by + 7.4)}L${f(bx + 3.9)},${f(by + 6)}L${f(bx + 5.1)},${f(by + 7.9)}L${f(bx + 6.2)},${f(by + 7.3)}L${f(bx + 5)},${f(by + 5.4)}L${f(bx + 7)},${f(by + 5.1)}Z`, { fill: '#ffffff' });
    }
    return s;
  },
  longcoat(doc, D, { t, bt, headX, L }) {
    const O = D.outfit, zo = 6 * bt;
    const d = `M${CX - 12},103C${CX - 4},101 ${CX + 4},101 ${CX + 12},103C${CX + 18},104.5 ${CX + 20.5},108 ${CX + 21},115L${CX + 31},175Q${CX + 32},181 ${CX + 26},181L${CX - 26},181Q${CX - 32},181 ${CX - 31},175L${CX - 21},115C${CX - 20.5},108 ${CX - 18},104.5 ${CX - 12},103Z`;
    let s = cel(doc, d, O.body, { shift: L, shade: [ellD(headX, 104, 16, 6), `M${f(CX + zo)},128L${f(CX + 2 + zo)},182L${f(CX + 40)},182L${f(CX + 40)},128Z`], light: [`M${CX - 21},119L${CX - 18},119L${CX - 23},176L${CX - 28.5},176Z`] });
    s += cel(doc, `M${f(CX - 8.5 + zo)},103L${f(CX + 8.5 + zo)},103L${f(CX + zo)},129Z`, O.shirt, { shift: L, lw: 1.1 });
    s += path(`M${f(CX + zo)},129L${f(CX + 1.2 + zo)},181`, { stroke: D.ink, 'stroke-width': 1.1 });
    for (const y of [142, 158]) s += path(ellD(CX + 5.5 + zo, y, 1.7), { fill: O.accent.base, stroke: D.ink, 'stroke-width': 0.9 });
    for (const sg of [-1, 1]) s += path(`M${f(CX + sg * 13)},${163}l${f(sg * 9)},0.6`, { stroke: D.ink, 'stroke-width': 1.1, 'stroke-linecap': 'round' });
    const tx = CX + zo;
    s += cel(doc, `M${f(tx)},108L${f(tx - 6)},104.5L${f(tx - 6)},111.5Z`, O.accent, { shift: L, lw: 1 }) + cel(doc, `M${f(tx)},108L${f(tx + 6)},104.5L${f(tx + 6)},111.5Z`, O.accent, { shift: L, lw: 1 });
    s += cel(doc, `M${f(tx - 2.4)},108L${f(tx)},106L${f(tx + 2.4)},108L${f(tx + 1.2)},117L${f(tx - 1.2)},117Z`, O.accent, { shift: L, lw: 1 });
    return s;
  },
};

// ---------- props (body space) ----------
function drawProp(doc, D, x) {
  const ink = D.ink, L = [-2.5, -2.5];
  if (x.type === 'keyboard') {
    const P = D.props?.keyboard ?? { base: '#2c3352', shade: '#1e2440', light: '#434c75', line: ink };
    let s = cel(doc, rrD(x.x - 31, x.y - 7, 62, 15, 3.5), P, { shift: [0, -2.5] });
    for (let r = 0; r < 2; r++) for (let c = 0; c < 7; c++) {
      const kx = x.x - 27 + c * 8, ky = x.y - 4.6 + r * 5.6, left = kx < x.x - 4, right = kx > x.x + 4;
      const on = (x.press === 'l' && left && r === 0 && c === 1) || (x.press === 'r' && right && r === 0 && c === 5);
      s += path(rrD(kx, ky + (on ? 0.8 : 0), 6.2, 4.2, 1), { fill: on ? (left ? FX.warm : FX.cool) : '#e9ebf3' });
    }
    return s;
  }
  if (x.type === 'card') {
    const P = { base: '#fbfbfd', shade: '#dde0ea', light: '#ffffff', line: ink };
    const body = cel(doc, rrD(-22, -12, 44, 24, 4), P, { shift: L }) + path(rrD(-18, -8, 4, 16, 1.6), { fill: '#f5a524' }) +
      path('M-10,-3.5H12M-10,3H6', { stroke: '#a3a8b8', 'stroke-width': 2, 'stroke-linecap': 'round' });
    return g(body, { transform: `translate(${f(clamp(x.x, 36, 156))},${f(Math.max(18, x.y))}) rotate(${f(x.rot ?? 0)})`, opacity: x.fade });
  }
  if (x.type === 'clipboard') {
    const B = { base: '#b9825a', shade: '#93623f', light: '#d39f78', line: ink }, Pp = { base: '#ffffff', shade: '#e4e6ee', light: '#fff', line: ink };
    let s = cel(doc, rrD(x.x - 15, x.y - 19, 30, 38, 3), B, { shift: L }) + cel(doc, rrD(x.x - 12, x.y - 14, 24, 30, 1.6), Pp, { shift: L, lw: 0.9 });
    s += path(`M${f(x.x - 8)},${f(x.y - 6)}H${f(x.x + 8)}M${f(x.x - 8)},${f(x.y)}H${f(x.x + 6)}M${f(x.x - 8)},${f(x.y + 6)}H${f(x.x + 8)}`, { stroke: '#a3a8b8', 'stroke-width': 1.6, 'stroke-linecap': 'round' });
    s += cel(doc, rrD(x.x - 6, x.y - 22, 12, 6, 2), { base: '#cdd2dc', shade: '#9ea4b3', light: '#fff', line: ink }, { shift: L, lw: 1 });
    return s;
  }
  return '';
}
