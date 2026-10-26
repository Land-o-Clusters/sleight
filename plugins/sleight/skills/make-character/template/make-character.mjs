#!/usr/bin/env node
// Make a sleight character pack from a design file, on macOS, with no npm packages and no browser.
//   node make-character.mjs designs/my-character.mjs [--out ./my-character] [--proof idle:0,click:1,error:2]
// Renders every cell as SVG (styles/), rasterizes with macOS sips, writes:
//   <out>/character.json, sheet.png (Codex v2 compatible 8x11), extra.webp (lib/webp.mjs), preview.png
//   <out>-contact.png  both sheets at the shipped size (96 x 104 per cell) on light and dark, to look at
//   <out>-proof.png    with --proof: chosen frames large and at the shipped size on light, dark and busy
// Then checks the hand host's pixel rules. Exit 1 on a problem. Import is the person's own step (see SKILL.md).
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLIPS, usedCells } from './lib/poses.mjs';
import { decodePNG, encodePNG } from './lib/png.mjs';
import { encodeWebPLossless } from './lib/webp.mjs';
import { renderAnime } from './styles/anime.mjs';
import { renderPixel } from './styles/pixel.mjs';
import { renderPaper } from './styles/paper.mjs';

const STYLES = { anime: renderAnime, pixel: renderPixel, paper: renderPaper };
const args = process.argv.slice(2), opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const designPath = args.find((a, i) => !a.startsWith('--') && !['--out', '--proof'].includes(args[i - 1]));
if (!designPath) { console.error('usage: node make-character.mjs <design.mjs> [--out dir] [--proof clip:frame,...]'); process.exit(2); }
const D = (await import(pathToFileURL(resolve(designPath)))).default;
if (!/^[a-z0-9-]{1,48}$/.test(D.id ?? '')) throw Error('design id must be 1 to 48 of a-z 0-9 -');
const render = STYLES[D.style]; if (!render) throw Error(`unknown style ${D.style}; have ${Object.keys(STYLES).join(', ')}`);
const out = resolve(opt('--out') ?? D.id), tmp = mkdtempSync(join(tmpdir(), 'make-character-'));
const ctx = { E: D.E ?? 1 };

// One SVG per sheet: every cell nested at its grid spot, ids prefixed so cells can't collide.
const nest = (svg, x, y, k) => svg.replace(/id="([^"]+)"/g, `id="k${k}_$1"`).replace(/url\(#([^)]+)\)/g, `url(#k${k}_$1)`)
  .replace(/^<svg[^>]*>/, `<svg x="${x}" y="${y}" width="192" height="208" viewBox="0 0 192 208">`);
const sips = (svgText, name) => { const s = join(tmp, name + '.svg'), p = join(tmp, name + '.png'); writeFileSync(s, svgText); execFileSync('sips', ['-s', 'format', 'png', s, '--out', p], { stdio: 'ignore' }); return readFileSync(p); };
const sheets = {};
let k = 0;
for (const sheet of ['sheet', 'extra']) {
  let body = '';
  for (const c of CLIPS.filter(c => c.sheet === sheet)) for (let f = 0; f < c.frames; f++) body += nest(render(D, c.pose(f, ctx)), ((c.start ?? 0) + f) * 192, c.row * 208, k++);
  const png = sips(`<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="2288" viewBox="0 0 1536 2288">${body}</svg>`, sheet);
  sheets[sheet] = { png, img: decodePNG(png) };
}

// The hand host's rules: 50+ visible pixels and under 95% opaque per used cell, empty unused cells in used rows,
// no ink on a cell's edge (it would sit over the target, or clip).
const problems = [], warnings = [];
for (const sheet of ['sheet', 'extra']) {
  const { img } = sheets[sheet], used = new Set(usedCells()[sheet].map(u => u.row * 8 + u.col)), rows = new Set(usedCells()[sheet].map(u => u.row));
  for (let r = 0; r < 11; r++) for (let c = 0; c < 8; c++) {
    let vis = 0, opq = 0, edge = 0;
    for (let y = 0; y < 208; y++) for (let x = 0; x < 192; x++) {
      const a = img.data[((r * 208 + y) * 1536 + c * 192 + x) * 4 + 3];
      if (a) vis++; if (a === 255) opq++; if (a > 8 && (x === 0 || y === 0 || x === 191 || y === 207)) edge++;
    }
    const at = `${sheet} row ${r} col ${c}`;
    if (used.has(r * 8 + c)) {
      if (vis < 50) problems.push(`${at}: ${vis} visible pixels (needs 50)`);
      if (opq / (192 * 208) >= 0.95) problems.push(`${at}: 95% or more opaque`);
      if (edge) warnings.push(`${at}: ink touches the cell edge`);
    } else if (rows.has(r) && vis && !(sheet === 'sheet' && r === 0 && c === 6)) problems.push(`${at}: unused cell has ink`);
  }
}

// Manifest, built from the same clip table that drew the art.
const states = {};
for (const c of CLIPS) for (const st of c.states) states[st] = { ...c.sheet === 'extra' ? { sheet: 'extra' } : {}, row: c.row, ...c.start ? { start: c.start } : {}, frames: c.frames, ms: c.ms, loop: c.loop };
states.move = { dir16: { rowA: 9, rowB: 10 } }; states.look = { dir16: { rowA: 9, rowB: 10 } };
const manifest = { format: 'sleight-character', version: 1, id: D.id, name: D.name, description: D.description ?? '', author: D.author, license: D.license,
  sheet: 'sheet.png', extra: 'extra.webp', frame: { w: 192, h: 208 }, grid: { cols: 8, rows: 11 }, scale: 0.5, anchor: { x: 96, y: 196 }, hotspot: { x: 96, y: 104 }, states };

mkdirSync(out, { recursive: true }); chmodSync(out, 0o755);
for (const n of readdirSync(out)) if (['character.json', 'sheet.png', 'extra.webp', 'preview.png'].includes(n)) rmSync(join(out, n));
const write = (n, b) => { writeFileSync(join(out, n), b); chmodSync(join(out, n), 0o644); };
write('character.json', JSON.stringify(manifest, null, 2) + '\n');
write('sheet.png', sheets.sheet.png);
write('extra.webp', encodeWebPLossless(sheets.extra.img));
write('preview.png', sips(render(D, CLIPS[0].pose(0, ctx)), 'preview'));

// Contact sheet: both atlases at half size (the shipped 96 x 104 per cell) on light and dark.
const half = (img, bg) => { const W = 768, H = 1144, o = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let r = 0, g = 0, b = 0, a = 0;
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const i = ((2 * y + dy) * 1536 + 2 * x + dx) * 4, al = img.data[i + 3] / 255; r += img.data[i] * al + bg[0] * (1 - al); g += img.data[i + 1] * al + bg[1] * (1 - al); b += img.data[i + 2] * al + bg[2] * (1 - al); }
    const j = (y * W + x) * 4; o[j] = r / 4; o[j + 1] = g / 4; o[j + 2] = b / 4; o[j + 3] = 255; }
  return { width: W, height: H, data: o }; };
const parts = [half(sheets.sheet.img, [238, 240, 244]), half(sheets.extra.img, [238, 240, 244]), half(sheets.sheet.img, [22, 23, 29]), half(sheets.extra.img, [22, 23, 29])];
const CW = 768 * 4 + 30, contact = { width: CW, height: 1144, data: Buffer.alloc(CW * 1144 * 4, 255) };
parts.forEach((p, n) => { for (let y = 0; y < 1144; y++) p.data.copy(contact.data, (y * CW + n * 778) * 4, y * 768 * 4, (y + 1) * 768 * 4); });
writeFileSync(`${out}-contact.png`, encodePNG(contact));

if (opt('--proof')) {
  const items = opt('--proof').split(',').map(spec => { const [name, fr = '0'] = spec.split(':'), c = CLIPS.find(x => x.name === name); if (!c) throw Error('no clip ' + name + '; have ' + CLIPS.map(x => x.name).join(', ')); return render(D, c.pose(+fr, ctx)); });
  let body = '';
  items.forEach((svg, n) => {
    const x = n * 300;
    body += `<rect x="${x}" y="0" width="290" height="330" fill="#eef0f4"/>` + nest(svg, x + 49, 6, 9000 + n * 4).replace('width="192" height="208"', 'width="192" height="208"');
    [['#f7f7f9'], ['#1d1e23'], ['#ff8a4c']].forEach(([bg], m) => { body += `<rect x="${x + m * 97}" y="220" width="96" height="110" fill="${bg}"/>` + nest(svg, x + m * 97, 223, 9001 + n * 4 + m).replace('width="192" height="208"', 'width="96" height="104"'); });
  });
  writeFileSync(`${out}-proof.png`, sips(`<svg xmlns="http://www.w3.org/2000/svg" width="${items.length * 300}" height="330">${body}</svg>`, 'proof'));
}
rmSync(tmp, { recursive: true, force: true });
console.log(`${basename(out)}: character.json, sheet.png, extra.webp, preview.png written to ${out}`);
console.log(`look at ${out}-contact.png${opt('--proof') ? ` and ${out}-proof.png` : ''}`);
console.log(`pixel checks: ${problems.length} problems, ${warnings.length} warnings`);
for (const x of [...problems, ...warnings].slice(0, 20)) console.log('  ' + x);
if (problems.length) process.exitCode = 1;
