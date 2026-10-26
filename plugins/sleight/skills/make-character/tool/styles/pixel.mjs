// Pixel-art style: a 32-pixel-wide logical grid drawn at 6x into the 192x208 cell (feet on y = 196).
// Shapes are rasterized per pixel with a material id; one pass shades each material (base, one shade on the
// lower-right edge, one highlight on the upper-left edge), a second pass adds a 1-pixel ink outline.
// Effects go on their own grid with their own outline so they never merge into the body.
import { Doc, f, g } from '../lib/svg.mjs';
import { FX } from '../lib/fx.mjs';
import { recordAnchors } from '../lib/poses.mjs';

const PX = 6, GW = 32, GH = 35, OY = -2; // row 32 (the outline under the feet) ends on y = 196
const toG = ([x, y]) => [x / PX, (y - OY) / PX];
const toC = ([x, y]) => [x * PX, y * PX + OY];

class Grid {
  constructor() { this.c = new Map(); }
  key(x, y) { return y * 64 + x; }
  set(x, y, mat) { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= GW || y >= GH) return; this.c.set(this.key(x, y), { x, y, mat }); }
  get(x, y) { return this.c.get(this.key(x, y)); }
  ellipse(cx, cy, rx, ry, mat, test) {
    for (let y = Math.floor(cy - ry - 1); y <= cy + ry + 1; y++) for (let x = Math.floor(cx - rx - 1); x <= cx + rx + 1; x++) {
      const u = (x + 0.5 - cx) / rx, v = (y + 0.5 - cy) / ry;
      if (u * u + v * v <= 1 && (!test || test(x, y))) this.set(x, y, mat);
    }
  }
  rect(x, y, w, h, mat) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, mat); }
  line(x0, y0, x1, y1, mat) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1; let e = dx + dy;
    for (;;) { this.set(x0, y0, mat); if (x0 === x1 && y0 === y1) break; const e2 = 2 * e; if (e2 >= dy) { e += dy; x0 += sx; } if (e2 <= dx) { e += dx; y0 += sy; } }
  }
  glyph(x, y, rows, mat) { rows.forEach((r, j) => [...r].forEach((ch, i) => { if (ch !== '.') this.set(x + i, y + j, typeof mat === 'object' ? mat[ch] : mat); })); }
  /** Shade pass then outline pass. pal maps a material to { base, shade?, light? } or a color string. */
  paint(pal, ink, { outline = true } = {}) {
    const px = [];
    for (const p of this.c.values()) {
      const m = pal[p.mat] ?? p.mat; let col = typeof m === 'string' ? m : m.base;
      if (typeof m === 'object' && m.shade) {
        const same = (dx, dy) => this.get(p.x + dx, p.y + dy)?.mat === p.mat || (m.group && pal[this.get(p.x + dx, p.y + dy)?.mat]?.group === m.group);
        if (!same(1, 0) || !same(0, 1) || !same(1, 1)) col = m.shade;
        else if (m.light && (!same(-1, 0) || !same(0, -1))) col = m.light;
      }
      px.push([p.x, p.y, col]);
    }
    const seen = new Set();
    if (outline) for (const p of [...this.c.values()]) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = p.x + dx, y = p.y + dy, k = this.key(x, y);
      if (x >= 0 && y >= 0 && x < GW && y < GH && !this.get(x, y) && !seen.has(k)) { seen.add(k); px.push([x, y, ink]); }
    }
    return px;
  }
}

function toSvg(px, opacity) {
  // Merge horizontal runs of one color into one rect.
  const rows = new Map();
  for (const [x, y, c] of px) { if (!rows.has(y)) rows.set(y, []); rows.get(y).push([x, c]); }
  let s = '';
  for (const [y, list] of rows) {
    list.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < list.length;) {
      let j = i; while (j + 1 < list.length && list[j + 1][0] === list[j][0] + 1 && list[j + 1][1] === list[i][1]) j++;
      const [cx, cy] = toC([list[i][0], y]);
      s += `<rect x="${cx}" y="${cy}" width="${(j - i + 1) * PX}" height="${PX}" fill="${list[i][1]}"/>`; i = j + 1;
    }
  }
  return g(s, { 'shape-rendering': 'crispEdges', opacity });
}

const EYES = {
  open: ['ba', 'aa', 'aa'], calm: ['..', 'ba', 'aa'], soft: ['ba', 'aa', 'aa'], half: ['..', 'aa', 'aa'], focus: ['..', 'aa', 'aa'],
  sad: ['a.', 'ab', 'aa'], closed: ['..', '..', 'aa'], wide: ['aaa', 'aba', 'aaa'],
};

export function renderPixel(D, pose) {
  const doc = new Doc(192, 208), P = D.pal, ink = D.ink;
  const p = pose, t = Math.max(-1, Math.min(1, p.head.turn));
  const G = new Grid();
  const jump = Math.round(-p.y / 5), shiftX = Math.round(p.x / 5 + p.lean / 9);
  const rx = 8.6 * (p.sx ?? 1), ry = 10 * (p.sy ?? 1);
  const cx = 15.5 + shiftX, cy = 29.5 - ry - jump, top = cy - ry, ft = Math.round(t * 1.6);
  const lean = Math.round(p.lean / 8);

  // tail (cable) behind the body, ending in a plug
  const tailWag = Math.round(Math.sin((p.lean + p.x) / 6));
  const tail = [[rx - 2, ry - 2], [rx + 0.5, ry - 1], [rx + 2.5, ry - 2], [rx + 3, ry - 4], [rx + 3 + tailWag, ry - 7]];
  for (let i = 1; i < tail.length; i++) G.line(cx + tail[i - 1][0], cy + tail[i - 1][1], cx + tail[i][0], cy + tail[i][1], 'cable');
  const plx = Math.min(27, Math.round(cx + rx + 2 + tailWag)); G.rect(plx, Math.round(cy + ry - 10), 3, 2, 'plug');
  G.set(plx, Math.round(cy + ry - 11), 'plug'); G.set(plx + 2, Math.round(cy + ry - 11), 'plug');
  // feet
  for (const s of [-1, 1]) {
    const L = p.legs[s < 0 ? 'l' : 'r'], fx = cx + s * 4 + Math.round((L.a ?? 0) / 14), fy = 30.5 - Math.round((L.lift ?? 0) * 2) - jump;
    G.ellipse(fx, fy, 2.2, 1.3, 'foot');
  }
  // ears behind the shell
  for (const s of [-1, 1]) {
    const ex = cx + s * 6.6 - ft * 0.5 + lean, ey = top + 1.2;
    G.ellipse(ex, ey, 3.1, 3.1, 'shell');
    G.ellipse(ex, ey + 0.3, 1.5, 1.5, s < 0 ? 'earW' : 'earC');
  }
  // body shell, then the two buttons on top split by the seam
  const seam = Math.round(cx - 0.5 + ft * 0.4 + lean * 0.5);
  G.ellipse(cx, cy, rx, ry, 'shell');
  // the button line curves like a real mouse: lower in the middle, higher at the sides
  const by = x => Math.round(top + 5.6 - 2.2 * ((x + 0.5 - cx) / rx) ** 2);
  G.ellipse(cx, cy, rx, ry, 'btnW', (x, y) => y < by(x) && x < seam);
  G.ellipse(cx, cy, rx, ry, 'btnC', (x, y) => y < by(x) && x > seam);
  G.ellipse(cx, cy, rx, ry, 'seam', (x, y) => y < by(x) && x === seam);
  G.ellipse(cx, cy, rx, ry, 'rim', (x, y) => y === by(x));
  // scroll wheel on the seam
  const wheelTop = Math.round(top + 1);
  for (let j = 0; j < 3; j++) G.set(seam, wheelTop + j, (j + (p.wheel ?? 0)) % 2 ? 'wheelB' : 'wheel');
  // paws on short arms
  const paws = {};
  for (const sd of ['l', 'r']) {
    const s = sd === 'l' ? -1 : 1, A = p.arms[sd], ang = Math.max(20, A.a + 0.45 * A.b) * Math.PI / 180; // inward reaches would cover the face
    const sh = [cx + s * (rx - 1.5), cy + 2];
    const d = [s * Math.sin(ang), Math.cos(ang)], len = 4.2;
    const paw = [sh[0] + d[0] * len, sh[1] + d[1] * len];
    G.line(sh[0], sh[1], paw[0], paw[1], 'shell');
    G.rect(Math.round(paw[0] - 0.5), Math.round(paw[1] - 0.5), 2, 2, 'shell');
    if (A.hand === 'point') G.set(paw[0] + d[0] * 1.6, paw[1] + d[1] * 1.6, 'shell');
    if (A.hand === 'thumb') G.set(paw[0], paw[1] - 1.5, 'shell');
    paws[sd] = toC([paw[0] + 0.5, paw[1] + 0.5]);
    paws['tip.' + sd] = toC([paw[0] + 0.5 + d[0] * 2, paw[1] + 0.5 + d[1] * 2]);
  }
  // face on the shell
  const fy = Math.round(cy + 1.5 + (p.head.pitch ?? 0) * 1.4), lx = Math.round((p.face.look?.[0] ?? 0) * 0.8), ly = Math.round((p.face.look?.[1] ?? 0) * 0.8);
  const eyes = typeof p.face.eyes === 'object' ? p.face.eyes : { l: p.face.eyes, r: p.face.eyes };
  for (const sd of ['l', 'r']) {
    const s = sd === 'l' ? -1 : 1, ex = Math.round(cx + s * 3.6 - 1 + ft + lx * 0.5), ey = fy - 1, e = eyes[sd];
    if (e === 'happy') G.glyph(ex - 1, ey + 1, ['.a.', 'a.a'], 'eye');
    else if (e === 'x') G.glyph(ex - 1, ey, ['a.a', '.a.', 'a.a'], 'eye');
    else if (e === 'squeeze') G.glyph(ex - (s < 0 ? 0 : 1), ey, s < 0 ? ['a..', '.aa', 'a..'] : ['..a', 'aa.', '..a'], 'eye');
    else { const gl = EYES[e] ?? EYES.open; G.glyph(ex + (gl[0].length === 3 ? -1 : 0) + Math.max(-1, Math.min(0, lx)), ey + Math.max(-1, Math.min(0, ly)), gl, { a: 'eye', b: 'eyeHi' }); }
    if (p.face.blush) G.rect(ex + (s < 0 ? -2 : 2), fy + 2, 2, 1, 'blush');
  }
  const mx = Math.round(cx - 1 + ft), my = fy + 3;
  const M = { smile: ['a..a', '.aa.'], grin: ['aaaa', 'amma', '.tt.'], smile2: ['aaaa', '.mm.'], open: ['.aa.', 'amma', '.aa.'], o: ['aa', 'aa'], flat: ['.aa.'], cat: ['a.a.a', '.a.a.'], frown: ['.aa.', 'a..a'],
    wobble: ['.a.a', 'a.a.'], tongue: ['a..a', '.at.'], teeth: ['aaaa', 'awwa', 'aaaa'], shout: ['aaaa', 'amma', 'amma', '.aa.'] }[p.face.mouth] ?? ['a..a', '.aa.'];
  G.glyph(mx - (M[0].length > 4 ? 1 : M[0].length < 4 ? -1 : 0), my, M, { a: 'mouth', m: 'mouthIn', t: 'tongue', w: 'teeth' });
  // props
  const propAt = pr => {
    if (!pr.at) return [pr.x, pr.y];
    const base = pr.at === 'overhead' ? toC([cx, top - 3]) : pr.at === 'hands' ? toC([cx, cy + 4]) : pr.at === 'chest' ? toC([cx, cy + 3]) : paws[pr.at.replace('hand.', '')] ?? paws[pr.at] ?? toC([cx, cy]);
    return [base[0] + (pr.dx ?? 0) * 0.85, base[1] + (pr.at === 'overhead' ? 0 : (pr.dy ?? 0) * 0.85)];
  };
  for (const pr of p.props ?? []) {
    let [gx, gy] = toG(propAt(pr)); gx = Math.max(7, Math.min(25, gx)); gy = Math.max(3, gy);
    if (pr.type === 'keyboard') { const ky = Math.round(cy + ry - 2), gy2 = ky; G.rect(Math.round(gx - 7), ky - 1, 14, 3, 'kb'); for (let k = 0; k < 6; k++) G.set(Math.round(gx - 6 + k * 2.3), gy2, (pr.press === 'l' && k === 1) ? 'btnW' : (pr.press === 'r' && k === 4) ? 'btnC' : 'key'); }
    if (pr.type === 'card') { G.rect(Math.round(gx - 4), Math.round(gy - 2), 8, 5, 'card'); G.rect(Math.round(gx - 3), Math.round(gy - 1), 1, 3, 'stripe'); G.rect(Math.round(gx - 1), Math.round(gy - 1), 4, 1, 'cardLine'); G.rect(Math.round(gx - 1), Math.round(gy + 1), 3, 1, 'cardLine'); }
    if (pr.type === 'clipboard') { const b = Math.round(cy + ry - 5); G.rect(Math.round(gx - 4), b, 8, 6, 'board'); G.rect(Math.round(gx - 3), b + 1, 6, 4, 'card'); G.rect(Math.round(gx - 2), b + 2, 4, 1, 'cardLine'); G.rect(Math.round(gx - 1), b - 1, 3, 1, 'plug'); }
  }
  const body = toSvg(G.paint(P, ink));

  // effects grid
  const F = new Grid();
  const anchor = at => at === 'head' ? toC([cx, top + 2]) : paws[at.replace('hand.', '')] ?? paws[at] ?? [96, 120];
  for (const e of p.fx) {
    const F0 = F, F1 = new Grid();
    { const F = F1;
    const [ax, ay] = e.at ? anchor(e.at) : [e.x ?? 96, e.y ?? 100];
    let [x, y] = toG([ax + (e.dx ?? 0) * 0.85, ay + (e.dy ?? 0) * 0.85]); x = Math.round(x); y = Math.round(y);
    switch (e.type) {
      case 'spark': { const L = Math.max(1, Math.round((e.s ?? 6) / 3.4)); F.set(x, y, 'white'); for (let k = 1; k <= L; k++) { F.set(x + k, y, 'white'); F.set(x - k, y, 'white'); F.set(x, y + k, 'white'); F.set(x, y - k, 'white'); } break; }
      case 'twinkle': F.glyph(x - 1, y - 1, ['.a.', 'aaa', '.a.'], 'twinkle'); break;
      case 'burst': { const R = (e.big ? 5 : 2) + (e.big ? 7 : 4) * (e.t ?? 0.5); [0, 1, 2, 3, 4, 5].forEach(k => { const a = (k * 60 + 15) * Math.PI / 180; F.set(x + Math.cos(a) * R, y + Math.sin(a) * R * 0.85, ['warm', 'cool', 'white'][k % 3]); }); break; }
      case 'orbit': [0, 0.035, 0.07, 0.5, 0.535, 0.57].forEach((h, k) => { const a = 2 * Math.PI * (h + (e.t ?? 0) * [1, 2, -1, 1, -2, 1][k]) + 0.3; F.set(x + 9 * Math.cos(a), y - 1 + 2.6 * Math.sin(a), k < 3 ? 'warm' : 'cool'); }); break;
      case 'ask': F.ellipse(x + 0.5, y + 0.5, 4.6, 4.3, 'white'); F.glyph(x - 4, y + 4, ['a.', '.a'], 'white'); F.glyph(x - 1, y - 2, ['aaa', '..a', '.aa', '...', '.a.'], 'ink'); break;
      case 'bang': F.glyph(x, y - 3, ['a', 'a', 'a', '.', 'a'], 'err'); break;
      case 'cross': F.glyph(x - 1, y - 1, ['a.a', '.a.', 'a.a'], 'err'); break;
      case 'chev': for (let k = 0; k < 2; k++) { const yy = y + (e.dir ?? -1) * Math.round(k * 3 + (e.t ?? 0) * 3); F.glyph(x - 2, yy, (e.dir ?? -1) < 0 ? ['..a..', '.a.a.', 'a...a'] : ['a...a', '.a.a.', '..a..'], 'cool'); } break;
      case 'menu': F.rect(x, y - 4, 5, 4, 'white'); F.rect(x + 1, y - 3, 3, 1, 'cool'); F.rect(x + 1, y - 1, 3, 1, 'gray'); break;
      case 'dots': for (let k = 0; k < (e.n ?? 3); k++) F.set(x - 2 + k * 2, y, 'ink'); break;
      case 'tap': F.glyph(x - 1, y - 2, ['a.a', '...', '.a.'], 'ink'); break;
      case 'speed': for (const [dy, len] of [[-1, 2], [0, 3], [1, 2]]) F.rect(x - len - (e.flip ? -len - 2 : 0), y + dy * 2, len, 1, 'gray'); break;
      case 'motion': F.glyph(x, y - 1, e.flip ? ['a.', '.a', 'a.'] : ['.a', 'a.', '.a'], 'ink'); break;
      case 'cloud': F.ellipse(x, y, 3.4, 1.6, 'cloud'); F.ellipse(x - 1, y - 1, 2, 1.4, 'cloud'); F.set(x - 1, y + 3, 'cool'); F.set(x + 1, y + 3, 'cool'); break;
      case 'check': F.ellipse(x + 0.5, y + 0.5, 2.6, 2.6, 'ok'); F.glyph(x - 1, y - 1, ['...a', 'a.a.', '.a..'], 'white'); break;
      case 'trail': for (let k = 0; k < (e.n ?? 3); k++) F.set(x + k, y + k, k % 2 ? 'cool' : 'warm'); break;
      case 'shake': { const sx = e.side === 'l' ? 5 : 26; F.rect(sx, 17, 1, 3, 'gray'); break; }
      case 'sweat': { const sx = Math.round(cx + (e.side === 'l' ? -8 : 7)), sy = Math.round(top + 4); F.glyph(sx, sy, ['.a', 'aa', 'aa'], 'sweat'); break; }
    }
    }
    // shift this effect so it and its outline stay inside the cell
    const cs = [...F1.c.values()]; if (!cs.length) continue;
    const minx = Math.min(...cs.map(c => c.x)), maxx = Math.max(...cs.map(c => c.x)), miny = Math.min(...cs.map(c => c.y)), maxy = Math.max(...cs.map(c => c.y));
    const sx = minx < 2 ? 2 - minx : maxx > GW - 3 ? GW - 3 - maxx : 0, sy = miny < 2 ? 2 - miny : maxy > 31 ? 31 - maxy : 0;
    for (const c of cs) F0.set(c.x + sx, c.y + sy, c.mat);
  }
  recordAnchors(at => anchor(at), { ...p, lean: 0, x: 0, y: 0, sx: 1, sy: 1 });
  const fxPal = { white: '#ffffff', warm: FX.warm, cool: FX.cool, err: FX.err, ok: FX.ok, ink, gray: '#8b90a3', twinkle: FX.twinkle, cloud: FX.cloud, sweat: FX.sweat };
  const fx = toSvg(F.paint(fxPal, ink));
  return doc.wrap(body + fx);
}
