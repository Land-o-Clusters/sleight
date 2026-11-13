import { Bits, writeCode, encodeWebPLossless } from './windows-webp-encoder.mjs';

const pack = (r, g, b, a = 255) => ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
const channel = (p, shift) => p >>> shift & 255;
const add = (a, b, sign = 1) => [0,8,16,24].reduce((v, s) => (v | ((channel(a,s) + sign * channel(b,s)) & 255) << s) >>> 0, 0);
const bgra = pixels => Buffer.from(pixels.flatMap(p => { const a = p >>> 24; return [channel(p,0)*a/255, channel(p,8)*a/255, channel(p,16)*a/255, a]; }));
const rgba = pixels => Buffer.from(pixels.flatMap(p => [channel(p,16), channel(p,8), channel(p,0), p >>> 24]));
function container(bw) {
  const body = bw.bytes(), header = Buffer.alloc(20);
  header.write('RIFF'); header.writeUInt32LE(12 + body.length + (body.length & 1),4); header.write('WEBPVP8L',8); header.writeUInt32LE(body.length,16);
  return Buffer.concat([header,body,Buffer.alloc(body.length & 1)]);
}
function start(w,h) { const b = new Bits(); b.put(0x2f,8); b.put(w-1,14); b.put(h-1,14); b.put(1,1); b.put(0,3); return b; }
// Literal-only entropy image. This also covers normal Huffman tables independently
// of the encoder's LZ77 match selection.
function image(b, pixels, {main = false, cache = false, meta = false} = {}) {
  b.put(cache ? 1 : 0,1); if (cache) b.put(1,4);
  if (main) {
    b.put(meta ? 1 : 0,1);
    if (meta) { b.put(0,3); image(b,[pack(0,0,0),pack(0,1,0)]); }
  }
  const cacheHash = p => Math.imul(0x1e35a7bd,p) >>> 31;
  const tokens = pixels.map((p,i) => cache && i > 0 && p === pixels[i-1] ? [280+cacheHash(p)] : [channel(p,8),channel(p,16),channel(p,0),channel(p,24)]);
  const alphabets = [cache ? 282 : 280,256,256,256,40];
  const groups = Array.from({length: meta ? 2 : 1}, () => alphabets.map((n,c) => {
    const freq = Array(n).fill(0);
    for (const t of tokens) if (t[c] !== undefined) freq[t[c]]++;
    return writeCode(b,freq);
  }));
  for (const t of tokens) for (let c=0;c<t.length;c++) { const code = groups[0][c]; b.put(code.code[t[c]],code.len[t[c]]); }
}
const avg = (a,b) => [0,8,16,24].reduce((v,s) => (v | Math.floor((channel(a,s)+channel(b,s))/2) << s) >>> 0,0);
function predictor(mode,l,t,tl,tr) {
  if (mode < 5) return [0xff000000,l,t,tr,tl][mode];
  if (mode < 11) return [avg(avg(l,tr),t),avg(l,tl),avg(l,t),avg(tl,t),avg(t,tr),avg(avg(l,tl),avg(t,tr))][mode-5];
  if (mode === 11) {
    const diff = (a,b) => [0,8,16,24].reduce((n,s) => n+Math.abs(channel(a,s)-channel(b,s)),0);
    return diff(t,tl) < diff(l,tl) ? l : t;
  }
  return [0,8,16,24].reduce((v,s) => {
    const a=channel(l,s),b=channel(t,s),c=channel(tl,s), m=Math.floor((a+b)/2);
    return (v | Math.max(0,Math.min(255,mode === 12 ? a+b-c : m+Math.trunc((m-c)/2))) << s) >>> 0;
  },0);
}
export function webpCases() {
  const cases = [], addCase = (name,w,h,pixels,bytes) => cases.push({name,width:w,height:h,expected:bgra(pixels),bytes});
  const pixels = Array.from({length:36},(_,i) => pack(i*13&255,i*19&255,i*29&255,i*7&255));
  addCase('literal-alpha',6,6,pixels,encodeWebPLossless({width:6,height:6,data:rgba(pixels)}));
  for (const [w,h] of [[1,1],[17,19],[512,192]]) {
    const p = Array.from({length:w*h},(_,i) => i%w < 10 && Math.floor(i/w)%64 < 8 ? pack(160,80,240) : 0);
    addCase('lz77-'+w+'x'+h,w,h,p,encodeWebPLossless({width:w,height:h,data:rgba(p)}));
  }
  const all = Array.from({length:256},(_,i)=>pack(i*17&255,i,255-i));
  addCase('all-symbols',256,1,all,encodeWebPLossless({width:256,height:1,data:rgba(all)}));
  for (let mode=0;mode<14;mode++) {
    const w=6,h=6,b=start(w,h); b.put(1,1); b.put(0,2); b.put(0,3);
    image(b,Array(4).fill(pack(0,mode,0)));
    b.put(0,1);
    const residual = pixels.map((p,i) => {
      const x=i%w,y=Math.floor(i/w);
      const prediction = i===0 ? 0xff000000 : y===0 ? pixels[i-1] : x===0 ? pixels[i-w] : predictor(mode,pixels[i-1],pixels[i-w],pixels[i-w-1],pixels[x===w-1 ? y*w : i-w+1]);
      return add(p,prediction,-1);
    });
    image(b,residual,{main:true}); addCase('predictor-'+mode,w,h,pixels,container(b));
  }
  {
    const b=start(6,6); b.put(1,1); b.put(2,2); b.put(0,1);
    image(b,pixels.map(p=>pack((channel(p,16)-channel(p,8))&255,channel(p,8),(channel(p,0)-channel(p,8))&255,p>>>24)),{main:true});
    addCase('subtract-green',6,6,pixels,container(b));
  }
  {
    const b=start(6,6), signed=n=>n>=128?n-256:n;
    b.put(1,1);b.put(1,2);b.put(0,3); image(b,Array(4).fill(pack(224,16,240))); b.put(0,1);
    image(b,pixels.map(p=> {
      const g=channel(p,8),r=channel(p,16),blue=channel(p,0);
      return pack((r-((signed(240)*signed(g))>>5))&255,g,(blue-((16*signed(g))>>5)-((signed(224)*signed(r))>>5))&255,p>>>24);
    }),{main:true}); addCase('color-transform',6,6,pixels,container(b));
  }
  for (const count of [2,4,16,32]) {
    const w=9,h=3,colors=Array.from({length:count},(_,i)=>pack(i*41&255,i*23&255,i*7&255,i*17&255));
    const wb=count<=2?3:count<=4?2:count<=16?1:0, bits=8>>wb, width=Math.ceil(w/2**wb), packed=[];
    const p=Array.from({length:w*h},(_,i)=>colors[i%count]);
    for(let y=0;y<h;y++) for(let x=0;x<width;x++) {
      let v=0;for(let k=0;k<2**wb;k++) if(x*2**wb+k<w) v|=((y*w+x*2**wb+k)%count) << k*bits;
      packed.push(pack(0,v,0));
    }
    const b=start(w,h);b.put(1,1);b.put(3,2);b.put(count-1,8);
    image(b,colors.map((p,i)=>i ? add(p,colors[i-1],-1) : p));b.put(0,1);image(b,packed,{main:true});
    addCase('palette-'+count,w,h,p,container(b));
  }
  {
    const p=Array(16).fill(pack(17,33,65,120)),b=start(8,2);b.put(0,1);image(b,p,{main:true,cache:true});
    addCase('color-cache',8,2,p,container(b));
  }
  {
    const p=Array.from({length:8},(_,i)=>pack(i*31,i*17,50)),b=start(8,1);b.put(0,1);image(b,p,{main:true,meta:true});
    addCase('meta-groups',8,1,p,container(b));
  }
  return cases;
}
export function fixtureWebP() { return webpCases().find(c=>c.name==='lz77-512x192').bytes; }
