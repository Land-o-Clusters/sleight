// Effects drawn around a character (vector). The palette matches Split Seam+: warm, cool, white, error red.
import { f, path, g, ellD, rrD, starD, capsuleD } from './svg.mjs';

export const FX = { warm: '#ff7a3d', cool: '#5b8dff', white: '#ffffff', err: '#ff3d60', twinkle: '#fff3b8', sweat: '#a9d8ff', ok: '#35c07a', cloud: '#a3a8bb' };
const ORB_HOME = [0, 0.035, 0.07, 0.5, 0.535, 0.57], ORB_SPD = [1, 2, -1, 1, -2, 1];

const stroke = (d, ink, w, extra = {}) => path(d, { fill: 'none', stroke: ink, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...extra });
const sq = (x, y, s, fill, ink, op = 1) => path(rrD(x - s / 2, y - s / 2, s, s, 0.4), { fill, stroke: ink, 'stroke-width': 0.9, opacity: op < 1 ? op : undefined });

/** layer: "back" draws only parts that sit behind the character (orbit far side); "front" draws the rest. */
export function drawFx(list, anchor, ink, layer = 'front') {
  let out = '';
  for (const e of list) {
    if (['sweat'].includes(e.type)) continue; // drawn by the renderer in head space
    const [ax, ay] = e.at ? anchor(e.at) : [e.x ?? 96, e.y ?? 100];
    // Keep each effect inside the cell (plus its rim), whatever the build or arm length.
    const box = { menu: [6, 156, 26, 196], ask: [22, 170, 20, 180], cloud: [24, 168, 18, 180], spark: [14, 178, 14, 190], twinkle: [10, 182, 10, 190], bang: [12, 180, 18, 180], burst: [10, 182, 10, 190], trail: [8, 170, 8, 180] }[e.type] ?? [0, 192, 0, 208];
    const x = Math.max(box[0], Math.min(box[1], ax + (e.dx ?? 0))), y = Math.max(box[2], Math.min(box[3], ay + (e.dy ?? 0)));
    if (e.type === 'orbit') {
      for (let k = 0; k < 6; k++) {
        const a = 2 * Math.PI * (ORB_HOME[k] + (e.t ?? 0) * ORB_SPD[k]) + 0.3, px = x + 54 * Math.cos(a), py = y + 16 * Math.sin(a);
        const back = Math.sin(a) < 0;
        if ((layer === 'back') === back) out += sq(px, py, back ? 4.4 : 5.6, k < 3 ? FX.warm : FX.cool, ink);
      }
      continue;
    }
    if (layer === 'back') continue;
    switch (e.type) {
      case 'spark': {
        const s = e.s ?? 6;
        if (s >= 8) for (let k = 0; k < 4; k++) { const a = (45 + 90 * k + (e.rot ?? 0)) * Math.PI / 180; out += stroke(`M${f(x + Math.cos(a) * s * 0.8)},${f(y + Math.sin(a) * s * 0.8)}L${f(x + Math.cos(a) * s * 1.25)},${f(y + Math.sin(a) * s * 1.25)}`, ink, 1.6); }
        out += path(starD(x, y, s, e.rot ?? 0), { fill: e.hollow ? 'none' : FX.white, stroke: ink, 'stroke-width': s >= 7 ? 1.6 : 1.3, 'stroke-linejoin': 'round' });
        break;
      }
      case 'twinkle': out += path(starD(x, y, e.s ?? 4, 0, 0.28), { fill: FX.twinkle, stroke: ink, 'stroke-width': 1.1, 'stroke-linejoin': 'round' }); break;
      case 'burst': {
        const t = e.t ?? 0.5, R = e.big ? 24 + 30 * t : 20 * t + 8, cols = [FX.warm, FX.cool, FX.white];
        for (let k = 0; k < 6; k++) { const a = (k * 60 + 15) * Math.PI / 180; out += sq(x + Math.cos(a) * R, y + Math.sin(a) * R * 0.85, (e.big ? 6 : 5) * (1 - 0.35 * t), cols[k % 3], ink); }
        break;
      }
      case 'ask': {
        out += path(`M${f(x - 9)},${f(y + 8)}L${f(x - 15)},${f(y + 17)}L${f(x - 2)},${f(y + 11)}Z`, { fill: FX.white, stroke: ink, 'stroke-width': 1.6, 'stroke-linejoin': 'round' });
        out += path(ellD(x, y, 14, 13), { fill: FX.white, stroke: ink, 'stroke-width': 1.7 });
        out += path(`M${f(x - 8.6)},${f(y + 9.4)}L${f(x - 3)},${f(y + 11.4)}`, { stroke: FX.white, 'stroke-width': 2.4 });
        out += stroke(`M${f(x - 4.4)},${f(y - 3.6)}Q${f(x - 4.4)},${f(y - 8.6)} ${f(x)},${f(y - 8.6)}Q${f(x + 4.8)},${f(y - 8.6)} ${f(x + 4.8)},${f(y - 4.2)}Q${f(x + 4.8)},${f(y - 1.2)} ${f(x + 0.8)},${f(y + 0.6)}L${f(x + 0.2)},${f(y + 2.6)}`, ink, 3);
        out += path(ellD(x + 0.2, y + 7, 2), { fill: ink });
        break;
      }
      case 'bang': {
        const s = e.s ?? 1;
        out += path(capsuleD(x, y - 11 * s, x, y + 2 * s, 3.4 * s, 1.9 * s), { fill: FX.err, stroke: ink, 'stroke-width': 1.4 });
        out += path(ellD(x, y + 7.4 * s, 2.5 * s), { fill: FX.err, stroke: ink, 'stroke-width': 1.3 });
        break;
      }
      case 'cross': {
        const d = `M${f(x - 5)},${f(y - 5)}L${f(x + 5)},${f(y + 5)}M${f(x + 5)},${f(y - 5)}L${f(x - 5)},${f(y + 5)}`;
        out += stroke(d, ink, 5.2) + stroke(d, FX.err, 2.8);
        break;
      }
      case 'chev': {
        const dir = e.dir ?? -1, t = e.t ?? 0;
        for (let k = 0; k < 3; k++) {
          const p = k + t, cy = y + dir * p * 11, op = Math.max(0.35, 1 - Math.abs(p - 1.2) / 2.2);
          const d = `M${f(x - 7)},${f(cy - dir * 4)}L${f(x)},${f(cy + dir * 3)}L${f(x + 7)},${f(cy - dir * 4)}`;
          out += g(stroke(d, ink, 5.4) + stroke(d, FX.cool, 2.8), { opacity: f(op) });
        }
        break;
      }
      case 'menu': {
        out += path(rrD(x, y - 20, 24, 21, 3.5), { fill: FX.white, stroke: ink, 'stroke-width': 1.4 });
        out += path(rrD(x + 2.5, y - 17.6, 19, 5, 1.5), { fill: FX.cool });
        out += stroke(`M${f(x + 5)},${f(y - 8.2)}H${f(x + 19)}M${f(x + 5)},${f(y - 3.6)}H${f(x + 16)}`, '#8b90a3', 1.7);
        break;
      }
      case 'dots': for (let k = 0; k < (e.n ?? 3); k++) out += path(ellD(x - 7 + k * 7, y, 2.7), { fill: ink }); break;
      case 'tap': for (const a of [-60, -90, -120]) { const r = a * Math.PI / 180; out += stroke(`M${f(x + Math.cos(r) * 4)},${f(y + Math.sin(r) * 4)}L${f(x + Math.cos(r) * 8.5)},${f(y + Math.sin(r) * 8.5)}`, ink, 1.5); } break;
      case 'speed': for (const [dy, len] of [[-9, 14], [0, 20], [9, 11]]) out += stroke(`M${f(x - len)},${f(y + dy)}H${f(x)}`, ink, 1.8, { opacity: 0.55 }); break;
      case 'motion': { const s = e.flip ? -1 : 1; out += stroke(`M${f(x)},${f(y - 6)}Q${f(x + 4 * s)},${f(y)} ${f(x)},${f(y + 6)}M${f(x + 5 * s)},${f(y - 9)}Q${f(x + 10 * s)},${f(y)} ${f(x + 5 * s)},${f(y + 9)}`, ink, 1.5); break; }
      case 'cloud': {
        const d = `M${f(x - 13)},${f(y + 4)}Q${f(x - 17)},${f(y - 4)} ${f(x - 8)},${f(y - 5)}Q${f(x - 5)},${f(y - 12)} ${f(x + 2)},${f(y - 8)}Q${f(x + 10)},${f(y - 12)} ${f(x + 12)},${f(y - 3)}Q${f(x + 18)},${f(y + 2)} ${f(x + 12)},${f(y + 5)}Z`;
        out += path(d, { fill: FX.cloud, stroke: ink, 'stroke-width': 1.4, 'stroke-linejoin': 'round' });
        out += stroke(`M${f(x - 6)},${f(y + 9)}l-2,4M${f(x + 3)},${f(y + 9)}l-2,4`, FX.cool, 1.6);
        break;
      }
      case 'check':
        out += path(ellD(x, y, 8.5), { fill: FX.ok, stroke: ink, 'stroke-width': 1.4 });
        out += stroke(`M${f(x - 4)},${f(y + 0.2)}L${f(x - 1)},${f(y + 3.4)}L${f(x + 4.4)},${f(y - 3)}`, FX.white, 2.4);
        break;
      case 'trail': for (let k = 0; k < (e.n ?? 3); k++) out += sq(x + k * 5, y + k * 6, 4.4 - k * 0.8, k % 2 ? FX.cool : FX.warm, ink, 1 - k * 0.18); break;
      case 'shake': { const sx = e.side === 'l' ? 50 : 142; out += stroke(`M${f(sx)},${f(108)}v12M${f(sx + (e.side === 'l' ? -5 : 5))},${f(112)}v8`, ink, 1.6); break; }
    }
  }
  return out;
}

/** Sweat drop in head space at (x, y). */
export function sweatDrop(x, y, ink) {
  return path(`M${f(x)},${f(y - 6.5)}Q${f(x + 5)},${f(y + 1)} ${f(x)},${f(y + 4)}Q${f(x - 5)},${f(y + 1)} ${f(x)},${f(y - 6.5)}Z`, { fill: FX.sweat, stroke: ink, 'stroke-width': 1.2, 'stroke-linejoin': 'round' })
    + path(ellD(x - 1.4, y + 0.6, 1.1, 1.6), { fill: '#ffffff' });
}
