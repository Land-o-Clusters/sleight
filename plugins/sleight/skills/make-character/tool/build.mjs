#!/usr/bin/env node
// Original MIT cast from ledger/vc/characters/gen. No browser or window is launched.
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { CLIPS, PERCH_CLIPS, lastAnchors, usedCells } from './lib/poses.mjs';
import { decodePNG, encodePNG } from './lib/png.mjs';
import { renderAnime } from './styles/anime.mjs';
import { renderPixel } from './styles/pixel.mjs';
import { renderPaper } from './styles/paper.mjs';
import { loadCharacter } from '../../../lib/hand/character.mjs';
import { contactSheet } from './lib/contact.mjs';

export const CAST = Object.freeze(['tsugi', 'shizu', 'bit', 'kit', 'yori', 'tab']);
const here = fileURLToPath(new URL('.', import.meta.url));
const lines = JSON.parse(fs.readFileSync(join(here, 'lines.json')));
const styles = { anime: renderAnime, pixel: renderPixel, paper: renderPaper };
const hash = b => createHash('sha256').update(b).digest('hex');
const nest = (svg, x, y, k) => svg.replace(/id="([^"]+)"/g, `id="k${k}_$1"`).replace(/url\(#([^)]+)\)/g, `url(#k${k}_$1)`)
  .replace(/^<svg[^>]*>/, `<svg x="${x}" y="${y}" width="192" height="208" viewBox="0 0 192 208">`);
function checkPixels(img, sheet, rows) {
  const used = new Set(usedCells()[sheet].map(u => u.row * 8 + u.col));
  const referenced = new Set(usedCells()[sheet].map(u => u.row));
  for (let r = 0; r < rows; r++) for (let c = 0; c < 8; c++) {
    let visible = 0, opaque = 0;
    for (let y = 0; y < 208; y++) for (let x = 0; x < 192; x++) {
      const a = img.data[((r * 208 + y) * img.width + c * 192 + x) * 4 + 3];
      if (a) visible++; if (a === 255) opaque++;
    }
    if (used.has(r * 8 + c) ? visible < 50 || opaque >= 192 * 208 * 0.95
      : referenced.has(r) && visible > 0 && !(sheet === 'sheet' && r === 0 && c === 6)) throw Error(`${sheet} cell ${r},${c} fails pixel checks`);
  }
}
// Keep this block in consent-host.swift in sync with manifest.json after rebuilding the cast.
export function swiftPins(manifest) {
  return '// BEGIN BUILTIN CHARACTER HASHES\nlet spriteBuiltinHashes: [String: [String: String]] = [\n'
    + CAST.map(id => `    "${id}": [\n` + Object.entries(manifest.packs[id]).filter(([name]) => name.endsWith('.webp')).map(([name, hash]) => `        "${name}": "${hash}"`).join(',\n') + '\n    ]').join(',\n')
    + '\n]\n// END BUILTIN CHARACTER HASHES';
}
// Custom art has no byte-for-byte rebuild contract. PNG is a format-v1 sheet too.
export function sheetEncoding(custom, run = execFileSync) {
  let version;
  try { version = run('cwebp', ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]; }
  catch (error) {
    if (!custom) throw error;
    return 'png';
  }
  if (!custom && version !== '1.6.0') throw Error('Reproducible cast build requires cwebp 1.6.0');
  return 'webp';
}
export async function buildCast(output, { design } = {}) {
  let custom;
  if (design) {
    custom = (await import(pathToFileURL(resolve(design)))).default;
    if (!/^[a-z0-9-]{1,48}$/.test(custom?.id ?? '') || CAST.includes(custom.id)) throw Error('Custom design needs a new non-built-in id');
    if (!Object.hasOwn(styles, custom.style)) throw Error('Unknown custom design style');
    if (fs.existsSync(output)) throw Error('Custom output directory must be new');
  }
  const ids = custom ? [custom.id] : CAST;
  if (process.platform !== 'darwin') throw Error('Cast rasterization needs macOS sips');
  const extension = sheetEncoding(!!custom);
  const temp = fs.mkdtempSync(join(tmpdir(), 'sleight-character-build-'));
  fs.mkdirSync(output, { recursive: true });
  const manifest = { version: 1, packs: {} };
  try {
    for (const id of ids) {
      const D = custom ?? (await import(pathToFileURL(join(here, 'cast', `${id}.mjs`)))).default;
      const render = styles[D.style], ctx = { E: D.E ?? 1 }, folder = join(output, id);
      if (fs.existsSync(folder)) throw Error(`Output already exists: ${id}`);
      fs.mkdirSync(folder, { mode: 0o755 });
      const states = {}, files = {};
      let k = 0;
      for (const [sheet, clips, rows] of [['sheet', CLIPS.filter(c => c.sheet === 'sheet'), 11], ['extra', CLIPS.filter(c => c.sheet === 'extra'), 11], ['perch', PERCH_CLIPS, 3]]) {
        let body = '';
        for (const clip of clips) {
          for (let f = 0; f < clip.frames; f++) body += nest(render(D, clip.pose(f, ctx)), ((clip.start ?? 0) + f) * 192, clip.row * 208, k++);
          for (const st of clip.states) states[st] = { ...sheet === 'sheet' ? {} : { sheet }, row: clip.row, ...clip.start ? { start: clip.start } : {}, frames: clip.frames, ms: clip.ms, loop: clip.loop };
        }
        const svg = join(temp, 'atlas.svg'), png = join(temp, 'atlas.png'), webp = join(temp, 'atlas.webp');
        fs.writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="${rows * 208}" viewBox="0 0 1536 ${rows * 208}">${body}</svg>`);
        execFileSync('/usr/bin/sips', ['-s', 'format', 'png', svg, '--out', png], { stdio: 'ignore' });
        const img = decodePNG(fs.readFileSync(png)); checkPixels(img, sheet, rows);
        // Strip rasterizer metadata and zero hidden RGB. All visible RGBA values are kept exactly.
        for (let p = 0; p < img.data.length; p += 4) if (!img.data[p + 3]) img.data.fill(0, p, p + 3);
        fs.writeFileSync(png, encodePNG(img));
        if (extension === 'webp') execFileSync('cwebp', ['-quiet', '-lossless', '-z', '9', '-exact', '-metadata', 'none', png, '-o', webp]);
        files[`${sheet}.${extension}`] = fs.readFileSync(extension === 'webp' ? webp : png);
        if (custom) {
          const review = join(output, 'review', id); fs.mkdirSync(review, { recursive: true });
          for (const theme of ['light', 'dark']) fs.writeFileSync(join(review, `${sheet}-${theme}.png`), encodePNG(contactSheet(img, theme)));
        }
        if (sheet === 'sheet') {
          const data = Buffer.alloc(192 * 208 * 4);
          for (let y = 0; y < 208; y++) img.data.copy(data, y * 192 * 4, y * 1536 * 4, (y * 1536 + 192) * 4);
          files['preview.png'] = encodePNG({ width: 192, height: 208, data });
        }
      }
      states.move = { dir16: { rowA: 9, rowB: 10 } }; states.look = { dir16: { rowA: 9, rowB: 10 } };
      const hf = PERCH_CLIPS.find(c => c.name === 'high-five'); render(D, hf.pose(hf.frames - 1, ctx));
      states['high-five'].hotspot = { x: Math.round(lastAnchors['hand.r'][0]), y: Math.round(lastAnchors['hand.r'][1]) };
      const m = { format: 'sleight-character', version: 1, id, name: D.name, description: D.description, author: D.author, license: D.license,
        sheet: `sheet.${extension}`, extra: `extra.${extension}`, frame: { w: 192, h: 208 }, grid: { cols: 8, rows: 11 }, scale: 0.5,
        anchor: { x: 96, y: 196 }, hotspot: { x: 96, y: 104 }, states, perch: { anchor: { x: 96, y: D.seat }, sheet: `perch.${extension}` }, lines: lines[id] };
      files['character.json'] = Buffer.from(JSON.stringify(m, null, 2) + '\n');
      manifest.packs[id] = {};
      for (const name of Object.keys(files).sort()) {
        fs.writeFileSync(join(folder, name), files[name], { mode: 0o644 });
        manifest.packs[id][name] = hash(files[name]);
      }
      const loaded = loadCharacter(folder, { shared: true });
      if (loaded.warnings.length) throw Error(`${id}: ${loaded.warnings.join('; ')}`);
      console.log(`${id}: ${loaded.total} bytes, ${loaded.resolved.filter(s => s.own).length}/19 states`);
      if (custom) console.log(`${extension.toUpperCase()} sheets; 6 contact sheets at 96 by 104 pixels per cell: ${join(output, 'review', id)}`);
    }
    fs.writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644 });
    const bytes = ids.reduce((n, id) => n + fs.readdirSync(join(output, id)).reduce((n, f) => n + fs.statSync(join(output, id, f)).size, 0), 0);
    if (bytes >= 8_000_000) throw Error(`Bundled packs exceed 8 MB: ${bytes}`);
    return manifest;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 4 && args[0] === '--design' && args[2] === '--out') await buildCast(resolve(args[3]), { design: args[1] });
  else throw Error('Usage: node build.mjs --design DESIGN.mjs --out NEW_DIRECTORY');
}
