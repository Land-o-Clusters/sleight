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
  constructor(w=GW,h=GH) { this.c = new Map(); this.w=w; this.h=h; }
  key(x, y) { return y * 64 + x; }
  set(x, y, mat) { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= this.w || y >= this.h) return; this.c.set(this.key(x, y), { x, y, mat }); }
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
      if (x >= 0 && y >= 0 && x < this.w && y < this.h && !this.get(x, y) && !seen.has(k)) { seen.add(k); px.push([x, y, ink]); }
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
  if(pose.stage) return renderStagePixel(D,pose);
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

// Bit stays on the same 6 px logical lattice, including the wider lying strip. No rotated SVG or resampling.
function renderStagePixel(D,p) {
  const {name,posture,frame:i,frames:n}=p.stage, wide=posture==='lie', G=new Grid(wide?53:32), F=new Grid(wide?53:32);
  const is=s=>name===`stage-${s}`, wave=Math.sin(i/n*2*Math.PI), stride=Math.cos(i/n*2*Math.PI);
  let cx=15.5,cy=19.5,rx=8.6,ry=10, hands=[[5,24],[26,24]], elbows, feet=[[11,31],[21,31]], knees;
  let eyes=p.face.eyes,mouth='smile', look=[0,0], prop;
  if(wide) {
    cx=29;cy=is('sleep')?22:21;rx=14;ry=6;
    feet=is('sleep')?[[8,24],[11,26]]:[[11,13-Math.round(wave*2)],[13,16+Math.round(wave*2)]];
    knees=[[15,23],[17,25]]; elbows=[[38,25],[42,25]]; hands=[[40,24],[44,25]];
    if(is('lie-reach')) hands[1]=[[44,25],[46,29],[47,31],[44,25]][i];
    if(is('lie-peek')) {cx=31;hands=[[41,27],[46,27]];look=[1,1];}
    if(is('sleep')) {eyes='closed';mouth='flat';}
  } else if(posture==='sit') {
    // Three-quarter seat: both legs over the edge to the viewer's left, one paw planted on the edge behind.
    cx=16.5;cy=16.5;ry=7.5;rx=8;
    const w=Math.round(wave);
    knees=[[5,27],[10,26]];feet=[[6+w,31],[11-w,31]];
    elbows=[[8,22],[27,21]];hands=[[10,24],[26,24]];
    if(is('sit-notes')) {hands=[[7,24],[15+i%2,22]];elbows=[[7,22],[27,22]];prop='notes';look=[-1,1];}
    if(is('think')) {hands=[[10,24],[24,20]];elbows=[[7,23],[27,22]];look=[1,-1];}
    if(is('wait')) {hands=[[5,13],[28,13]];elbows=[[6,22],[27,22]];prop='card';}
    if(is('cheer')) {
      hands=i===2?[[5,16],[28,16]]:[[5,8],[28,8]];elbows=[[5,17],[28,17]];eyes='happy';mouth='grin';
      if(i===1) {knees=[[6,25],[9,24]];feet=[[4,23],[7,21]];}
    }
    if(is('paused')) {hands=[[13,22],[21,22]];prop='mug';}
    if(is('startle')) {cx=15.5;cy=15.5;hands=[[4,14],[28,14]];elbows=undefined;knees=[[8,24],[24,24]];feet=[[6,28],[26,28]];eyes='wide';mouth='o';F.glyph(28,4,['a','a','a','.','a'],'err');}
  } else if(posture==='hang') {
    cx+=Math.round(wave);cy=21;rx=7;ry=8;
    hands=[[5,4],[26,4]];elbows=[[5,12],[26,12]];
    knees=[[13,29],[19,29]];feet=[[13+Math.round(wave),32],[19+Math.round(wave),32]];
    if(is('hang-peek')) {cx+=2;cy=17;elbows=[[3,8],[28,8]];knees=[[13,25],[19,25]];feet=[[13+Math.round(wave),28],[19+Math.round(wave),28]];look=[1,1];}
  } else if(posture==='climb') {
    cy=18;rx=7;ry=8;const step=Math.round(Math.sin((i+.5)/n*2*Math.PI)*3);
    hands=[[4,7-step],[27,7+step]];elbows=[[6,15-step],[25,15+step]];
    knees=[[7,25+step],[24,25-step]];feet=[[4,28+step],[27,28-step]];look=[1,-1];
  } else if(posture==='run') {
    cx=16;cy=18;ry=8;rx=8;const s=Math.round(stride*5);
    feet=[[10-s,31-Math.max(0,-s)],[22+s,31-Math.max(0,s)]];knees=[[11-s/2,27],[21+s/2,26]];
    hands=[[8+s,24],[23-s,15]];elbows=[[6,22],[26,23]];
    if(is('carry')) {hands=[[9,25],[24,25]];prop='box';}
  } else if(posture==='leap') {
    const keys=[
      [16,22,9,7,[[5,26],[27,26]],[[5,31],[27,31]]],
      [16,17,7,9,[[4,8],[28,6]],[[4,30],[28,27]]],
      [16,17,9,6,[[4,12],[28,9]],[[4,27],[27,24]]],
      [17,22,9,7,[[4,25],[28,26]],[[4,31],[28,31]]],
      [15.5,19.5,8.6,10,[[5,24],[26,24]],[[11,31],[21,31]]],
    ];
    [cx,cy,rx,ry,hands,feet]=keys[i];knees=[[10,26],[22,25]];eyes=i===2?'happy':'focus';
  } else {
    if(is('stand')) {feet=[[8,31],[21,31]];knees=[[10,27],[21,27]];hands=[[5,23],[26,24]];if(i===1) eyes='closed';}
    if(is('point')) hands[1]=[[27,20],[28,16],[28,14]][i];
    // A flinch: shell drops a row, paws up wide of the face, feet together.
    if(is('wince')) {cy=20.5;hands=[[4,13],[28,13]];elbows=[[2,19],[29,19]];knees=[[13,28],[19,28]];feet=[[12,31],[20,31]];eyes=i<3?'squeeze':'open';mouth='wobble';F.glyph(27,9,['.a','aa','aa'],'cool');}
    if(is('handoff')) {hands[0]=[[4,21],[3,19],[2,18],[5,24]][i];eyes='happy';}
  }
  const top=cy-ry, faceX=wide?cx+7:cx, faceY=Math.round(cy+(wide?0:1));
  // Cable and plug remain an independent, stepped silhouette behind Bit's shell.
  const tail=wide?[[cx-rx+2,cy],[10,20],[7,21],[6,19],[7,17]]:posture==='hang'?[[cx+5,cy+5],[26,27],[27,29],[25,30]]:[[cx+rx-2,cy+ry-2],[28,cy+6],[29,cy+3],[28,cy+1]];
  for(let k=1;k<tail.length;k++) G.line(...tail[k-1],...tail[k],'cable');
  const plug=tail.at(-1);G.rect(plug[0]-1,plug[1]-2,3,2,'plug');G.set(plug[0]-1,plug[1]-3,'plug');G.set(plug[0]+1,plug[1]-3,'plug');
  // In the three-quarter seat the viewer-left leg is nearer, so its side is drawn last.
  for(const j of posture==='sit'&&!is('startle')?[1,0]:[0,1]) {
    const shoulder=[cx+(j?1:-1)*(rx-1),cy+1],el=elbows?.[j]??[(shoulder[0]+hands[j][0])/2,(shoulder[1]+hands[j][1])/2];
    G.line(...shoulder,...el,'shell');G.line(...el,...hands[j],'shell');G.rect(hands[j][0]-.5,hands[j][1]-.5,2,2,'shell');
    if(posture==='hang'||posture==='climb') G.line(hands[j][0]-1,hands[j][1]-1,hands[j][0]+1,hands[j][1]-1,'foot');
    const hip=[cx+(j?1:-1)*4,cy+ry-1],knee=knees?.[j]??feet[j];G.line(...hip,...knee,'foot');G.line(...knee,...feet[j],'foot');G.ellipse(...feet[j],2,1.2,'foot');
  }
  for(const s of [-1,1]) {const ex=faceX+s*5.5,ey=top+1.2;G.ellipse(ex,ey,3.1,3.1,'shell');G.ellipse(ex,ey+.3,1.5,1.5,s<0?'earW':'earC');}
  G.ellipse(cx,cy,rx,ry,'shell');
  const seam=Math.round(faceX-.5),by=x=>Math.round(top+4.6-1.6*((x+.5-cx)/rx)**2);
  G.ellipse(cx,cy,rx,ry,'btnW',(x,y)=>y<by(x)&&x<seam);
  G.ellipse(cx,cy,rx,ry,'btnC',(x,y)=>y<by(x)&&x>seam);
  G.ellipse(cx,cy,rx,ry,'seam',(x,y)=>y<by(x)&&x===seam);
  G.ellipse(cx,cy,rx,ry,'rim',(x,y)=>y===by(x));
  for(let j=0;j<3;j++) G.set(seam,Math.round(top+1)+j,(j+i)%2?'wheel':'wheelB');
  for(const s of [-1,1]) {
    const ex=Math.round(faceX+s*3.6-1+look[0]),ey=faceY-1+look[1];
    if(eyes==='happy') G.glyph(ex-1,ey+1,['.a.','a.a'],'eye');
    else if(eyes==='squeeze') G.glyph(ex,ey,s<0?['a..','.aa','a..']:['..a','aa.','..a'],'eye');
    else G.glyph(ex,ey,EYES[eyes]??EYES.open,{a:'eye',b:'eyeHi'});
  }
  const mouths={smile:['a..a','.aa.'],grin:['aaaa','amma','.tt.'],flat:['.aa.'],o:['aa','aa'],wobble:['.a.a','a.a.']};
  G.glyph(Math.round(faceX-1),faceY+3,mouths[mouth],{a:'mouth',m:'mouthIn',t:'tongue'});
  // Lap props sit over the thighs, which now hang to the viewer's left.
  if(prop==='notes') {G.rect(4,24,15,4,'board');G.rect(5,24,6,3,'card');G.rect(12,24,6,3,'card');G.line(15+i%2,24,18+i%2,20,'kb');}
  if(prop==='card') {G.rect(6,23,14,5,'card');G.rect(7,24,1,3,'stripe');G.rect(9,24,9,1,'cardLine');G.rect(9,26,6,1,'cardLine');F.glyph(25,7,['aaa','..a','.aa','...','.a.'],'ink');}
  if(prop==='box') {G.rect(10,23,13,7,'board');G.rect(15,23,2,7,'card');G.line(10,25,22,25,'cardLine');}
  if(prop==='mug') {const y=i<3?24-i:22;G.rect(12,y,7,5,'card');G.line(19,y+1,21,y+1,'card');G.line(21,y+1,21,y+3,'card');G.line(19,y+3,21,y+3,'card');G.line(14,y-3,15,y-4,'gray');}
  if(is('point')) G.line(...hands[1],hands[1][0]+1,hands[1][1]-2,'shell');
  const anchors=at=>at==='head'?toC([faceX,top+2]):at==='hands'?toC([(hands[0][0]+hands[1][0])/2,(hands[0][1]+hands[1][1])/2]):
    at==='tip.r'&&is('point')?toC([hands[1][0]+1,hands[1][1]-2]):toC(hands[at.endsWith('.l')?0:1]);
  recordAnchors(anchors,{...p,lean:0,x:0,y:0,sx:1,sy:1});
  return new Doc(wide?320:192,208).wrap(toSvg(G.paint(D.pal,D.ink))+toSvg(F.paint({ink:D.ink,err:FX.err,cool:FX.cool,gray:'#8b90a3'},D.ink)));
}
