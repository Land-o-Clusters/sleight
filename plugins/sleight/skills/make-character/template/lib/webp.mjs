// Minimal lossless WebP (VP8L) encoder: one prefix-code group, no transforms, no color cache, LZ77 copies from the
// previous pixel, the row above and a 2-pixel hash. Small and plain; good enough for mostly transparent sprite sheets.
// encodeWebPLossless({ width, height, data }) with straight RGBA bytes returns a Buffer (RIFF/WEBP/VP8L).

class Bits {
  constructor() { this.out = []; this.acc = 0; this.n = 0; }
  put(v, nb) { this.acc += v * 2 ** this.n; this.n += nb; while (this.n >= 8) { this.out.push(this.acc % 256); this.acc = Math.floor(this.acc / 256); this.n -= 8; } }
  bytes() { if (this.n) this.out.push(this.acc % 256); return Buffer.from(this.out); }
}

function huffLengths(freq, maxLen) {
  let f = freq.slice();
  for (;;) {
    const nodes = []; f.forEach((w, s) => { if (w > 0) nodes.push({ w, s }); });
    const len = new Array(freq.length).fill(0);
    if (nodes.length < 2) { if (nodes.length) len[nodes[0].s] = 1; return len; }
    const heap = nodes.slice().sort((a, b) => a.w - b.w);
    while (heap.length > 1) { // small alphabets: a sorted insert is fast enough
      const a = heap.shift(), b = heap.shift(), n = { w: a.w + b.w, kids: [a, b] };
      let i = heap.findIndex(x => x.w > n.w); if (i < 0) i = heap.length; heap.splice(i, 0, n);
    }
    let deepest = 0;
    const walk = (n, d) => { if (n.kids) { walk(n.kids[0], d + 1); walk(n.kids[1], d + 1); } else { len[n.s] = d; deepest = Math.max(deepest, d); } };
    walk(heap[0], 0);
    if (deepest <= maxLen) return len;
    f = f.map(w => (w ? Math.max(1, w >> 1) : 0)); // flatten and retry
  }
}
function canonical(len) {
  const max = Math.max(0, ...len), count = new Array(max + 1).fill(0); len.forEach(l => { if (l) count[l]++; });
  const next = new Array(max + 2).fill(0); let code = 0;
  for (let b = 1; b <= max; b++) { code = (code + count[b - 1]) << 1; next[b] = code; }
  return len.map(l => {
    if (!l) return 0; let c = next[l]++, r = 0;
    for (let i = 0; i < l; i++) { r = (r << 1) | (c & 1); c >>= 1; } // bits go out most significant first
    return r;
  });
}
const ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/** Writes one prefix code and returns { len, code } for emitting symbols. */
function writeCode(bw, freq) {
  const used = freq.map((w, s) => (w > 0 ? s : -1)).filter(s => s >= 0);
  if (used.length <= 1) {
    const sym = used[0] ?? 0, wide = sym > 1 ? 1 : 0;
    bw.put(1, 1); bw.put(0, 1); bw.put(wide, 1); bw.put(sym, wide ? 8 : 1);
    return { len: freq.map(() => 0), code: freq.map(() => 0) };
  }
  const len = huffLengths(freq, 15), code = canonical(len);
  const toks = [];
  for (let i = 0; i < len.length;) {
    const v = len[i]; let run = 1; while (i + run < len.length && len[i + run] === v) run++;
    if (v === 0) {
      let r = run; while (r > 0) {
        if (r >= 11) { const k = Math.min(r, 138); toks.push([18, k - 11, 7]); r -= k; }
        else if (r >= 3) { toks.push([17, r - 3, 3]); r = 0; }
        else { toks.push([0]); r--; }
      }
    } else {
      toks.push([v]); let r = run - 1;
      while (r >= 3) { const k = Math.min(r, 6); toks.push([16, k - 3, 2]); r -= k; }
      while (r-- > 0) toks.push([v]);
    }
    i += run;
  }
  const cf = new Array(19).fill(0); toks.forEach(t => cf[t[0]]++);
  let cl = huffLengths(cf, 7);
  if (cl.filter(Boolean).length === 1) { const only = cl.findIndex(Boolean); cl[only === 0 ? 1 : 0] = 1; }
  const cc = canonical(cl);
  let n = 19; while (n > 4 && !cl[ORDER[n - 1]]) n--;
  bw.put(0, 1); bw.put(n - 4, 4); for (let i = 0; i < n; i++) bw.put(cl[ORDER[i]], 3);
  bw.put(0, 1); // code lengths for every symbol follow
  for (const [s, extra, nb] of toks) { bw.put(cc[s], cl[s]); if (nb) bw.put(extra, nb); }
  return { len, code };
}

const prefix = v => { // value >= 1 -> [prefix symbol, extra bits count, extra value]
  const d = v - 1; if (d < 4) return [d, 0, 0];
  const hb = 31 - Math.clz32(d), second = (d >> (hb - 1)) & 1, eb = hb - 1;
  return [2 * hb + second, eb, d & ((1 << eb) - 1)];
};

export function encodeWebPLossless({ width: W, height: H, data }) {
  const N = W * H, px = new Uint32Array(N);
  for (let i = 0; i < N; i++) { const a = data[i * 4 + 3]; px[i] = a ? ((a << 24) | (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2]) >>> 0 : 0; }
  // LZ77 tokens: literal pixel, or [length, distance code]
  const toks = [], hash = new Int32Array(1 << 16).fill(-1), MAX = 4096;
  const key = i => (Math.imul(px[i] ^ Math.imul(px[i + 1] ?? 0, 0x9e3779b1), 0x85ebca6b) >>> 16);
  const matchLen = (i, d) => { let n = 0; while (i + n < N && n < MAX && px[i + n] === px[i + n - d]) n++; return n; };
  for (let i = 0; i < N;) {
    let best = 0, bd = 0;
    for (const d of [1, W]) if (i - d >= 0) { const n = matchLen(i, d); if (n > best) { best = n; bd = d; } }
    if (i + 1 < N) { const h = key(i), j = hash[h]; if (j >= 0 && i - j > 0 && i - j < 1048000) { const n = matchLen(i, i - j); if (n > best + 2) { best = n; bd = i - j; } } hash[h] = i; }
    if (best >= 3) {
      toks.push([best, bd === W ? 1 : bd === 1 ? 2 : bd + 120]);
      for (let k = 1; k < best && i + k + 1 < N; k += 3) hash[key(i + k)] = i + k;
      i += best;
    } else { toks.push(px[i]); i++; }
  }
  const fg = new Array(280).fill(0), fr = new Array(256).fill(0), fb = new Array(256).fill(0), fa = new Array(256).fill(0), fd = new Array(40).fill(0);
  for (const t of toks) {
    if (typeof t === 'number') { fg[(t >>> 8) & 255]++; fr[(t >>> 16) & 255]++; fb[t & 255]++; fa[t >>> 24]++; }
    else { fg[256 + prefix(t[0])[0]]++; fd[prefix(t[1])[0]]++; }
  }
  const bw = new Bits();
  bw.put(0x2f, 8); bw.put(W - 1, 14); bw.put(H - 1, 14); bw.put(1, 1); bw.put(0, 3);
  bw.put(0, 1); // no transforms
  bw.put(0, 1); // no color cache
  bw.put(0, 1); // no meta prefix codes
  const G = writeCode(bw, fg), R = writeCode(bw, fr), B = writeCode(bw, fb), A = writeCode(bw, fa), Dd = writeCode(bw, fd);
  const sym = (c, s) => bw.put(c.code[s], c.len[s]);
  for (const t of toks) {
    if (typeof t === 'number') { sym(G, (t >>> 8) & 255); sym(R, (t >>> 16) & 255); sym(B, t & 255); sym(A, t >>> 24); }
    else {
      const [lp, le, lv] = prefix(t[0]); sym(G, 256 + lp); if (le) bw.put(lv, le);
      const [dp, de, dv] = prefix(t[1]); sym(Dd, dp); if (de) bw.put(dv, de);
    }
  }
  const vp8l = bw.bytes(), pad = vp8l.length & 1;
  const head = Buffer.alloc(20); head.write('RIFF', 0); head.writeUInt32LE(12 + vp8l.length + pad, 4); head.write('WEBP', 8); head.write('VP8L', 12); head.writeUInt32LE(vp8l.length, 16);
  return Buffer.concat([head, vp8l, Buffer.alloc(pad)]);
}
