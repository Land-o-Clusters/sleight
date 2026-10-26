// Small SVG toolkit shared by every style: numbers, paths, shapes and the cel-shaded part helper.
export const f = n => (Math.round(n * 100) / 100).toString();
export const RAD = Math.PI / 180;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** One SVG document. ids are unique inside it. */
export class Doc {
  constructor(w = 192, h = 208) { this.w = w; this.h = h; this.n = 0; this.defs = []; }
  id(p = 'i') { return `${p}${this.n++}`; }
  def(s) { this.defs.push(s); }
  wrap(body) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.w}" height="${this.h}" viewBox="0 0 ${this.w} ${this.h}"><defs>${this.defs.join('')}</defs>${body}</svg>`;
  }
}

export const attrs = a => Object.entries(a).filter(([, v]) => v !== undefined && v !== null && v !== false).map(([k, v]) => ` ${k}="${typeof v === 'number' ? f(v) : esc(v)}"`).join('');
export const path = (d, a = {}) => `<path d="${d}"${attrs(a)}/>`;
export const g = (body, a = {}) => `<g${attrs(a)}>${body}</g>`;

export function ellD(cx, cy, rx, ry = rx, rot = 0) {
  if (!rot) return `M${f(cx - rx)},${f(cy)}A${f(rx)},${f(ry)} 0 1 0 ${f(cx + rx)},${f(cy)}A${f(rx)},${f(ry)} 0 1 0 ${f(cx - rx)},${f(cy)}Z`;
  const c = Math.cos(rot * RAD), s = Math.sin(rot * RAD);
  return `M${f(cx - rx * c)},${f(cy - rx * s)}A${f(rx)},${f(ry)} ${f(rot)} 1 0 ${f(cx + rx * c)},${f(cy + rx * s)}A${f(rx)},${f(ry)} ${f(rot)} 1 0 ${f(cx - rx * c)},${f(cy - rx * s)}Z`;
}
export function rrD(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  return `M${f(x + r)},${f(y)}H${f(x + w - r)}A${f(r)},${f(r)} 0 0 1 ${f(x + w)},${f(y + r)}V${f(y + h - r)}A${f(r)},${f(r)} 0 0 1 ${f(x + w - r)},${f(y + h)}H${f(x + r)}A${f(r)},${f(r)} 0 0 1 ${f(x)},${f(y + h - r)}V${f(y + r)}A${f(r)},${f(r)} 0 0 1 ${f(x + r)},${f(y)}Z`;
}
/** Four-point star, the ring's spark. */
export function starD(cx, cy, s, rot = 0, k = 0.3) {
  const pts = [[0, -s], [k * s, -k * s], [s, 0], [k * s, k * s], [0, s], [-k * s, k * s], [-s, 0], [-k * s, -k * s]];
  const c = Math.cos(rot * RAD), si = Math.sin(rot * RAD);
  return 'M' + pts.map(([x, y]) => `${f(cx + x * c - y * si)},${f(cy + x * si + y * c)}`).join('L') + 'Z';
}
/** Tapered capsule from a (radius ra) to b (radius rb). */
export function capsuleD(ax, ay, bx, by, ra, rb = ra) {
  const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy) || 0.001;
  const th = Math.atan2(dy, dx), be = Math.PI / 2 - Math.asin(clamp((ra - rb) / d, -0.99, 0.99));
  const p = (cx, cy, r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x1, y1] = p(ax, ay, ra, th + be), [x2, y2] = p(bx, by, rb, th + be), [x3, y3] = p(bx, by, rb, th - be), [x4, y4] = p(ax, ay, ra, th - be);
  const bigB = 2 * be > Math.PI ? 1 : 0, bigA = 2 * Math.PI - 2 * be > Math.PI ? 1 : 0;
  return `M${f(x1)},${f(y1)}L${f(x2)},${f(y2)}A${f(rb)},${f(rb)} 0 ${bigB} 0 ${f(x3)},${f(y3)}L${f(x4)},${f(y4)}A${f(ra)},${f(ra)} 0 ${bigA} 0 ${f(x1)},${f(y1)}Z`;
}
/** Smooth closed (or open) Catmull-Rom curve through points. */
export function smoothD(pts, closed = true, t = 1) {
  const n = pts.length, P = i => closed ? pts[(i + n) % n] : pts[clamp(i, 0, n - 1)];
  let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6 * t, p1[1] + (p2[1] - p0[1]) / 6 * t], c2 = [p2[0] - (p3[0] - p1[0]) / 6 * t, p2[1] - (p3[1] - p1[1]) / 6 * t];
    d += `C${f(c1[0])},${f(c1[1])} ${f(c2[0])},${f(c2[1])} ${f(p2[0])},${f(p2[1])}`;
  }
  return closed ? d + 'Z' : d;
}
/** A pointed hair lock: two root points, a tip, and a bend that bows both sides. */
export function lockD([ax, ay], [bx, by], [tx, ty], bend = 0) {
  const mx = (ax + tx) / 2 + bend, my = (ay + ty) / 2, nx = (bx + tx) / 2 + bend, ny = (by + ty) / 2;
  return `M${f(ax)},${f(ay)}Q${f(mx)},${f(my)} ${f(tx)},${f(ty)}Q${f(nx)},${f(ny)} ${f(bx)},${f(by)}Z`;
}
/** A curved hair lock: root centered at (x, ry) with half-width w, a belly, and a tip that sweeps by curl. */
export function leafD(x, ry, w, [tx, ty], curl = 0, belly = 0.35) {
  const h = ty - ry;
  return `M${f(x - w)},${f(ry)}C${f(x - w * (1 + belly) + curl * 0.2)},${f(ry + h * 0.45)} ${f(tx - w * 0.3 + curl * 0.7)},${f(ty - h * 0.3)} ${f(tx)},${f(ty)}` +
    `C${f(tx + w * 0.5 + curl * 0.5)},${f(ty - h * 0.42)} ${f(x + w * (1 + belly * 0.6) + curl * 0.2)},${f(ry + h * 0.4)} ${f(x + w)},${f(ry)}Z`;
}
/** The two curved sides of leafD without the root edge, for strokes. */
export const leafSidesD = (...a) => leafD(...a).slice(0, -1);
export const rot = ([x, y], deg) => { const c = Math.cos(deg * RAD), s = Math.sin(deg * RAD); return [x * c - y * s, x * s + y * c]; };

/**
 * A cel-shaded part: flat base, one hard-edged shade tone and optional highlight shapes, then a thin inner line.
 * The shade is the part minus a copy shifted toward the light, so it hugs the lower-right edge of any shape.
 * shift is in the part's own coordinates; pass a counter-rotated vector for rotated groups.
 */
export function cel(doc, d, pal, { shift = [-3, -3], shade = [], light = [], lw = 1.3, line = pal.line, noShade = false, opacity, outline } = {}) {
  const id = doc.id('c');
  doc.def(`<clipPath id="${id}"><path d="${d}"/></clipPath>`);
  let s = noShade ? path(d, { fill: pal.base }) : path(d, { fill: pal.shade });
  let inner = noShade ? '' : path(d, { fill: pal.base, transform: `translate(${f(shift[0])},${f(shift[1])})` });
  inner += shade.map(x => path(x, { fill: pal.shade })).join('') + light.map(x => path(x, { fill: pal.light })).join('');
  if (inner) s += g(inner, { 'clip-path': `url(#${id})` });
  if (lw) s += path(outline ?? d, { fill: 'none', stroke: line, 'stroke-width': lw, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
  return opacity !== undefined ? g(s, { opacity }) : s;
}

/**
 * Geometric outline: the same shapes again behind the art, every fill and stroke replaced by one color and a wide
 * stroke, so the union of all parts gets a rim. Works in any SVG renderer (macOS sips ignores filters).
 * Returns the underlay strings to put before the art: sticker rim (optional) then ink rim.
 */
export function outlineUnderlay(body, { ink, rim = 1.5, sticker = 0, stickerColor = '#ffffff', inner = 1.3 }) {
  const bare = body.replace(/ (fill|stroke|stroke-width|opacity|fill-opacity|stroke-opacity|stroke-linecap|stroke-linejoin)="[^"]*"/g, '');
  const layer = (w, color) => `<g fill="${color}" stroke="${color}" stroke-width="${f(w)}" stroke-linejoin="round" stroke-linecap="round">${bare}</g>`;
  return (sticker ? layer(inner + 2 * (rim + sticker), stickerColor) : '') + layer(inner + 2 * rim, ink);
}

/**
 * Outline filter (Chromium only; superseded by outlineUnderlay): a rounded ink rim around the whole silhouette (heavier than inner lines),
 * plus an optional light "sticker" rim outside it for busy backgrounds.
 */
export function outlineFilter(doc, { ink, rim = 1.5, sticker = 0, stickerColor = '#ffffff' }) {
  const id = doc.id('ol');
  const ring = (src, r, color, out) => {
    const sd = r * 0.85, thr = 0.14, slope = 9;
    return `<feGaussianBlur in="${src}" stdDeviation="${f(sd)}" result="${out}b"/>` +
      `<feComponentTransfer in="${out}b" result="${out}a"><feFuncA type="linear" slope="${slope}" intercept="${f(0.5 - thr * slope)}"/></feComponentTransfer>` +
      `<feFlood flood-color="${color}"/><feComposite in2="${out}a" operator="in" result="${out}"/>`;
  };
  let body = ring('SourceAlpha', rim, ink, 'ink');
  let merge = '<feMergeNode in="ink"/><feMergeNode in="SourceGraphic"/>';
  if (sticker) { body += ring('ink', sticker, stickerColor, 'stk'); merge = '<feMergeNode in="stk"/>' + merge; }
  doc.def(`<filter id="${id}" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">${body}<feMerge>${merge}</feMerge></filter>`);
  return `url(#${id})`;
}
