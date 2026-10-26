#!/usr/bin/env node
// Offline pixel evidence against approved source art. No browser, app or window.
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { CAST } from './build.mjs';
import { CLIPS, PERCH_CLIPS } from './lib/poses.mjs';
import { renderAnime } from './styles/anime.mjs';
import { renderPixel } from './styles/pixel.mjs';
import { renderPaper } from './styles/paper.mjs';
import { decodePNG } from './lib/png.mjs';

const args = process.argv.slice(2), measureExisting = args.at(-1) === '--measure-existing';
if (measureExisting) args.pop();
if (args.length !== 2) throw Error('Usage: node tools/characters/proof.mjs APPROVED_SOURCE NEW_OUTPUT [--measure-existing]');
const [approved, output] = args.map(p => resolve(p));
if (!measureExisting && fs.existsSync(output)) throw Error('Output must be absent');
fs.mkdirSync(output, { recursive: true });
const styles = { anime: renderAnime, pixel: renderPixel, paper: renderPaper };
const nest = (svg, x, y, k) => svg.replace(/id="([^"]+)"/g, `id="k${k}_$1"`).replace(/url\(#([^)]+)\)/g, `url(#k${k}_$1)`)
  .replace(/^<svg[^>]*>/, `<svg x="${x}" y="${y}" width="192" height="208" viewBox="0 0 192 208">`);
function raster(svg, stem) {
  const file = join(output, stem);
  if (measureExisting) return decodePNG(fs.readFileSync(file + '.png'));
  fs.writeFileSync(file + '.svg', svg);
  execFileSync('/usr/bin/sips', ['-s', 'format', 'png', file + '.svg', '--out', file + '.png'], { stdio: 'ignore' });
  return decodePNG(fs.readFileSync(file + '.png'));
}
function decode(path, stem) {
  if (path.endsWith('.png')) return decodePNG(fs.readFileSync(path));
  const dest = join(output, stem + '.png');
  execFileSync('dwebp', [path, '-o', dest], { stdio: 'ignore' });
  return decodePNG(fs.readFileSync(dest));
}
function difference(old, fresh) {
  let sum = 0, max = 0, alpha = 0, oldLighter = 0, newLighter = 0;
  // Pillow's integer RGB-to-L conversion, matching the review's >25 luma counts.
  const luma = (b, i) => (b[i] * 19595 + b[i + 1] * 38470 + b[i + 2] * 7471 + 32768) >> 16;
  for (let i = 0; i < old.data.length; i += 4) {
    const oa = old.data[i + 3], na = fresh.data[i + 3];
    alpha += Math.abs(oa - na);
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(Math.round((old.data[i + c] * oa + 255 * (255 - oa)) / 255) - Math.round((fresh.data[i + c] * na + 255 * (255 - na)) / 255));
      sum += d; max = Math.max(max, d);
    }
    if (oa === 255 && na === 255) {
      const d = luma(old.data, i) - luma(fresh.data, i);
      if (d > 25) oldLighter++; if (d < -25) newLighter++;
    }
  }
  return { meanRGB: sum / (old.width * old.height * 3), maxRGB: max, meanAlpha: alpha / (old.width * old.height), oldLighter, newLighter };
}
const report = {};
for (const id of CAST) {
  const D = (await import(new URL(`./cast/${id}.mjs`, import.meta.url))).default, ctx = { E: D.E ?? 1 }, render = styles[D.style];
  report[id] = { frames: 0, shinePixels: 0, spillPixels: 0, maxAlphaExcess: 0, sheets: {} };
  for (const [sheet, clips, rows] of [['sheet', CLIPS.filter(c => c.sheet === 'sheet'), 11], ['extra', CLIPS.filter(c => c.sheet === 'extra'), 11], ['perch', PERCH_CLIPS, 3]]) {
    const bodies = { full: '', hair: '', shine: '' }; let k = 0;
    for (const clip of clips) for (let f = 0; f < clip.frames; f++) {
      const p = clip.pose(f, ctx), x = ((clip.start ?? 0) + f) * 192, y = clip.row * 208;
      bodies.full += nest(render(D, p), x, y, k);
      for (const proof of ['hair', 'shine']) {
        const cell = D.style === 'anime' ? renderAnime(D, p, { proof }) : '<svg xmlns="http://www.w3.org/2000/svg" width="192" height="208"></svg>';
        bodies[proof] += nest(cell, x, y, k);
      }
      k++;
    }
    const images = Object.fromEntries(Object.entries(bodies).map(([kind, body]) => [kind,
      raster(`<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="${rows * 208}" viewBox="0 0 1536 ${rows * 208}">${body}</svg>`, `${id}-${sheet}-${kind}`)]));
    const old = decode(join(approved, id, sheet === 'sheet' ? 'sheet.png' : `${sheet}.webp`), `${id}-${sheet}-approved`);
    const priorWebp = execFileSync('/usr/bin/git', ['show', `d004cb63:plugins/sleight/characters/${id}/${sheet}.webp`], { maxBuffer: 8 * 1024 * 1024 });
    fs.writeFileSync(join(output, 'prior.webp'), priorWebp);
    const prior = decode(join(output, 'prior.webp'), `${id}-${sheet}-prior`);
    const metrics = { frames: k, fixed: difference(old, images.full), prior: difference(old, prior), shinePixels: 0, spillPixels: 0, maxAlphaExcess: 0 };
    for (let i = 3; i < images.shine.data.length; i += 4) {
      const s = images.shine.data[i], h = images.hair.data[i];
      if (s > 0) metrics.shinePixels++;
      if (s > 0 && h === 0) metrics.spillPixels++;
      metrics.maxAlphaExcess = Math.max(metrics.maxAlphaExcess, s - h);
    }
    // Every pixel of every rendered cell is included, including the directional and perch rows.
    if (metrics.spillPixels || metrics.maxAlphaExcess > 1) throw Error(`${id}/${sheet}: shine outside hair support`);
    report[id].sheets[sheet] = metrics;
    for (const key of ['frames', 'shinePixels', 'spillPixels']) report[id][key] += metrics[key];
    report[id].maxAlphaExcess = Math.max(report[id].maxAlphaExcess, metrics.maxAlphaExcess);
  }
  console.log(JSON.stringify({ id, ...report[id] }));
}
fs.writeFileSync(join(output, 'metrics.json'), JSON.stringify(report, null, 2) + '\n');
