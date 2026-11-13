// Browser-free stage renderer. Only trusted built-in designs are accepted.
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { CLIPS, PERCH_CLIPS, STAGE_CLIPS, lastAnchors } from './lib/poses.mjs';
import { STAGE_TOON_CLIPS, TOON_STAGE_SCALE } from './lib/toon-stage.mjs';
import { renderAnime } from './styles/anime.mjs';
import { renderPixel } from './styles/pixel.mjs';
import { renderPaper } from './styles/paper.mjs';
import { renderToon } from './styles/toon.mjs';
import { renderCritter, critterPose, durationFor, clipTiming, stageClips, stageWidth } from './rigs/critter.mjs';
import { decodePNG } from './lib/png.mjs';
import { encodeWebPLossless } from './lib/webp.mjs';
import { writePrivateFileAtomic } from './lib/atomic-private-file.mjs';
export const GENERATOR_VERSION = 1;
export const ORIGINAL_CAST = Object.freeze(['tsugi', 'shizu', 'bit', 'kit', 'yori', 'tab']);
export const EVERYDAY_CAST = Object.freeze(['mabel', 'biscuit', 'rudy', 'mo', 'dennis', 'nana', 'hal']);
export const CAST = Object.freeze([...ORIGINAL_CAST, ...EVERYDAY_CAST]);
export const styles = { anime: renderAnime, pixel: renderPixel, paper: renderPaper, toon: renderToon };
export const isCritter = D => D.style === 'toon' && Boolean(D.species);
export const renderPose = (D, clip, i, width = 192) => isCritter(D)
  ? renderCritter(D, critterPose(D, clip, i), { width })
  : styles[D.style](D, { ...clip.pose(i, { E: D.E ?? 1 }), clip: clip.name, frame: i }, { width });

export function critterStageBlock(D) {
  return { cell: { w: 384, h: 416 }, filter: 'linear', anchor: { x: 192, y: D.species === 'sloth' ? 128 : 372 },
    lie: stageWidth(D, 'stage-lie') === 320 ? { cell: { w: 640, h: 416 }, anchor: { x: 320, y: 282 } }
      : { anchor: { x: 192, y: D.species === 'sloth' ? 128 : 282 } },
    states: Object.fromEntries(stageClips().map(c => [c.name, {
      file: `stage/${c.name.slice(6)}.webp`, frames: c.frames, ms: clipTiming(D, c), loop: c.loop,
      ...D.species !== 'duck' && /stage-(hang|climb)/.test(c.name) ? { anchor: { x: 192, y: D.species === 'sloth' ? 128 : 146 } } : {},
    }])) };
}
export function stageBlock(D) {
  return isCritter(D) ? critterStageBlock(D) : D.style === 'toon' ? humanStageBlock(D) : stageManifest(D);
}

// The caller owns a private temporary directory. This renderer never writes into the plugin or user bank.
export async function renderStage(id, output) {
  if (!CAST.includes(id)) throw Error('Unknown built-in character');
  const D = (await import(`./cast/${id}.mjs`)).default, block = stageBlock(D);
  const clips = isCritter(D) ? stageClips() : D.style === 'toon' ? STAGE_TOON_CLIPS : STAGE_CLIPS;
  fs.mkdirSync(join(output, 'stage'), { mode: 0o700 });
  const nest = (svg, x, w, key) => svg.replace(/id="([^"]+)"/g, `id="${key}_$1"`).replace(/url\(#([^)]+)\)/g, `url(#${key}_$1)`)
    .replace(/^<svg[^>]*>/, `<svg x="${x}" y="0" width="${w}" height="416" viewBox="0 0 ${w / 2} 208">`);
  for (const c of clips) {
    const state = block.states[c.name], lie = /^stage-(lie|lie-reach|lie-peek|sleep)$/.test(c.name);
    const cell = state.cell ?? (lie ? block.lie?.cell : undefined) ?? block.cell;
    const width = cell.w / 2;
    const body = Array.from({ length: c.frames }, (_, i) => nest(renderPose(D, c, i, width), i * cell.w, cell.w, `c${i}`)).join('');
    const svg = join(output, 'render.svg'), png = join(output, 'render.png');
    fs.writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg" width="${cell.w * c.frames}" height="${cell.h}">${body}</svg>`, { mode: 0o600 });
    execFileSync('/usr/bin/sips', ['-s', 'format', 'png', svg, '--out', png], { stdio: 'pipe', timeout: 10000, maxBuffer: 65536, killSignal: 'SIGKILL' });
    fs.chmodSync(png, 0o600);
    const image = decodePNG(fs.readFileSync(png)), checked = checkStagePixels(image, c.frames, cell.w, cell.h);
    if (checked.problems.length || checked.warnings.length) throw Error(`Stage pixels refused: ${c.name}`);
    if (D.style !== 'toon' && (c.name === 'stage-point' || c.name === 'stage-cheer')) {
      renderPose(D, c, c.name === 'stage-cheer' ? 1 : c.frames - 1, width);
      const a = lastAnchors[c.name === 'stage-point' ? 'tip.r' : 'hand.r'];
      state.hotspot = { x: Math.round(a[0] * 2), y: Math.round(a[1] * 2) };
    }
    const bytes = encodeWebPLossless(image);
    if (bytes.length > 4 * 1024 ** 2) throw Error('Stage strip size exceeded');
    writePrivateFileAtomic(join(output, state.file), bytes);
  }
  fs.unlinkSync(join(output, 'render.svg')); fs.unlinkSync(join(output, 'render.png'));
  writePrivateFileAtomic(join(output, 'stage.json'), JSON.stringify(block));
  return block;
}
export function stageManifest(D) {
  const states={};
  for(const c of STAGE_CLIPS) {
    const state={file:`stage/${c.name.slice(6)}.webp`,frames:c.frames,ms:[...c.ms],loop:c.loop};
    // Sit and hang anchor at the surface they touch, rather than at the standing feet.
    if(c.pose(0).stage.posture==='sit') state.anchor={x:192,y:284};
    if(c.pose(0).stage.posture==='hang') state.anchor={x:192,y:D.style==='pixel'?44:40};
    states[c.name]=state;
  }
  return {cell:{w:384,h:416},filter:D.style==='pixel'?'nearest':'linear',anchor:{x:192,y:392},
    lie:{cell:{w:640,h:416},anchor:{x:320,y:300}},states};
}
export function checkStagePixels(img,frames,w,h) {
  const problems=[],warnings=[],bounds=[];
  if(img.width!==frames*w||img.height!==h) return {problems:['wrong strip geometry'],warnings,bounds};
  for(let f=0;f<frames;f++) {
    let visible=0,opaque=0,edge=0,minX=w,minY=h,maxX=-1,maxY=-1;
    for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
      const a=img.data[(y*img.width+f*w+x)*4+3];
      if(a) visible++; if(a===255) opaque++;
      if(a>8) {minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);if(x===0||y===0||x===w-1||y===h-1) edge++;}
    }
    if(visible<50) problems.push(`f${f}: ${visible} visible pixels`);
    if(opaque/(w*h)>=0.95) problems.push(`f${f}: 95% opaque`);
    if(edge) warnings.push(`f${f}: ${edge} edge pixels`);
    bounds.push({frame:f,minX,minY,maxX,maxY,visible});
  }
  return {problems,warnings,bounds};
}
export function humanStageBlock(D) {
  const z = TOON_STAGE_SCALE;
  return { cell: { w: 192 * z, h: 208 * z }, filter: 'linear', anchor: { x: 96 * z, y: 196 * z }, states: Object.fromEntries(STAGE_TOON_CLIPS.map(c => {
    const wide = c.wide && D.kind !== 'nana';
    let hotspot;
    if (c.name === 'stage-point' || c.name === 'stage-cheer') {
      renderToon(D, { ...c.pose(c.frames - 1, { E: D.E }), clip: c.name, frame: c.frames - 1 });
      const hand = c.name === 'stage-cheer' ? lastAnchors['hand.r'] : ['hand.l', 'hand.r'].map(n => lastAnchors[n]).sort((a, b) => Math.abs(b[0] - 96) - Math.abs(a[0] - 96))[0];
      hotspot = { x: Math.round(hand[0] * z), y: Math.round(hand[1] * z) };
    }
    return [c.name, { file: `stage/${c.name.slice(6)}.webp`, frames: c.frames, ms: c.ms, loop: c.loop, ...hotspot ? { hotspot } : {},
      ...wide ? { cell: { w: 320 * z, h: 208 * z }, anchor: { x: 160 * z, y: 143 * z } } : /lie|sleep|sit|think|wait|cheer|paused/.test(c.name) ? { anchor: { x: 96 * z, y: D.seat * z } } : {} }];
  })) };
}
export function manifestForCritter(D) {
  const states = {};
  for (const c of [...CLIPS, ...PERCH_CLIPS]) for (const name of c.states) states[name] = {
    ...c.sheet === 'sheet' ? {} : {sheet:c.sheet}, row:c.row, start:c.start??0, frames:c.frames,
    ms:clipTiming(D,c), loop:c.loop,
  };
  states.move = {dir16:{rowA:9,rowB:10}}; states.look = {dir16:{rowA:9,rowB:10}};
  states.jumping = {row:4,frames:5,ms:durationFor(D,[140,140,140,140,280]),loop:false};
  // The paused state reuses the seated sleep cells; stage has its own mug strip.
  states.paused = {...states.sleep};
  return {format:'sleight-character',version:1,id:D.id,name:D.name,description:D.description,author:D.author,license:D.license,
    sheet:'sheet.png',extra:'extra.webp',frame:{w:192,h:208},grid:{cols:8,rows:11},scale:0.5,
    anchor:{x:96,y:D.species==='sloth'?64:186},hotspot:{x:96,y:104},perch:{anchor:{x:96,y:D.seat},sheet:'perch.webp'},states};
}
export function checkCells(img, cells, w=192, h=208, cols=img.width/w) {
  const problems=[], warnings=[], used=new Set(cells.map(c=>(c.row??0)*cols+(c.col??0)));
  for (let row=0;row<img.height/h;row++) for(let col=0;col<cols;col++) {
    let visible=0,opaque=0,edge=0;
    for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
      const a=img.data[((row*h+y)*img.width+col*w+x)*4+3];
      if(a>0) visible++; if(a===255) opaque++;
      if(a>8 && (x===0||y===0||x===w-1||y===h-1)) edge++;
    }
    const at=`r${row}c${col}`;
    if(used.has(row*cols+col)) {
      if(visible<50) problems.push(`${at}: ${visible} visible pixels`);
      if(opaque/(w*h)>=0.95) problems.push(`${at}: 95% opaque`);
      if(edge) warnings.push(`${at}: ${edge} edge pixels`);
    } else if(visible) problems.push(`${at}: unused cell has ink`);
  }
  return {problems,warnings,cells:cells.length};
}
