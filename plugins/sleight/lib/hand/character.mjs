// Character packs are data. This module reads container headers, never decoded pixels.
import * as fs from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

const MiB = 1024 ** 2;
export const CHARACTER_LIMITS = Object.freeze({ json: 16384, sheet: 8 * MiB, extra: 8 * MiB, preview: MiB, license: 65536, total: 16 * MiB, pixels: 16_000_000, filePixels: 4096 ** 2 });
// Optional named rows are useful to artists and keep imported travel art separate from event states.
export const CHARACTER_STATES = Object.freeze([
  ['idle', 'Idle', []], ['move', 'Move', ['running-right', 'running-left', 'look', 'idle']],
  ['aim', 'Aim', ['look', 'idle']], ['click', 'Click', ['poke', 'wave', 'idle']],
  ['double-click', 'Double-click', ['click', 'idle']], ['right-click', 'Right-click', ['click', 'idle']],
  ['type', 'Type', ['key', 'working', 'idle']], ['key', 'Key press', ['type', 'click', 'idle']],
  ['scroll-up', 'Scroll up', ['working', 'idle']], ['scroll-down', 'Scroll down', ['working', 'idle']],
  ['drag-grab', 'Drag grab', ['click', 'idle']], ['drag-carry', 'Drag carry', ['move', 'idle']],
  ['drag-drop', 'Drag drop', ['click', 'idle']], ['waiting-approval', 'Waiting for approval', ['idle']],
  ['error', 'Error', ['idle']], ['success', 'Success', ['wave', 'idle']],
  ['thinking', 'Thinking', ['working', 'idle']], ['handoff', 'Hand back', ['success', 'idle']],
  ['working', 'Working', ['thinking', 'idle']],
].map(([state, label, fallback]) => Object.freeze({ state, label, fallback: Object.freeze(fallback) })));
const helpers = ['running-right', 'running-left', 'look', 'poke', 'wave'];
const names = [...CHARACTER_STATES.map(s => s.state), ...helpers];
const required = ['move', 'aim', 'click', 'type', 'waiting-approval', 'error'];
const fail = message => { throw Error(`Character: ${message}`); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
const number = (value, low, high) => Number.isFinite(value) && value >= low && value <= high;
function idCheck(id) { if (typeof id !== 'string' || !/^[a-z0-9-]{1,48}$/.test(id)) fail('invalid character id'); }
function text(value, label, min, max) {
  if (typeof value !== 'string' || value.length < min || value.length > max || /[<>/\\\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)) fail(`invalid ${label} text`);
}
function filename(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(value) || value.includes('..')) fail('invalid sheet filename');
  return value;
}
function unknownKeys(value, keys, label, warnings) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) warnings.push(`Unknown ${label} key ignored.`);
}
function plainData(value) {
  if (typeof value === 'string') text(value, 'manifest', 0, 200);
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    text(key, 'manifest key', 0, 80); plainData(child);
  }
}

// JSON.parse alone accepts duplicate keys. Scan JSON tokens first, including escaped key spellings.
export function parseCharacterJSON(bytes) {
  if (bytes.length >= CHARACTER_LIMITS.json) fail('JSON must be under 16 KiB');
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('JSON is not UTF-8'); }
  let i = 0;
  const space = () => { while (/[\t\r\n ]/.test(source[i] ?? '\0')) i++; };
  const string = () => {
    const start = i++;
    while (i < source.length) { if (source[i++] === '"') return JSON.parse(source.slice(start, i)); if (source[i - 1] === '\\') i++; }
    fail('unterminated JSON string');
  };
  const value = depth => {
    if (depth > 32) fail('JSON nesting too deep'); space();
    if (source[i] === '"') { string(); return; }
    if (source[i] === '{') {
      i++; space(); const keys = new Set(); if (source[i] === '}') { i++; return; }
      while (i < source.length) {
        space(); if (source[i] !== '"') fail('invalid JSON key'); const key = string();
        if (keys.has(key)) fail('duplicate JSON key'); keys.add(key); space(); if (source[i++] !== ':') fail('invalid JSON colon');
        value(depth + 1); space(); const end = source[i++]; if (end === '}') return; if (end !== ',') fail('invalid JSON object');
      }
    } else if (source[i] === '[') {
      i++; space(); if (source[i] === ']') { i++; return; }
      while (i < source.length) { value(depth + 1); space(); const end = source[i++]; if (end === ']') return; if (end !== ',') fail('invalid JSON array'); }
    } else {
      const token = source.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
      if (token) { i += token[0].length; return; }
    }
    fail('invalid JSON value');
  };
  try { value(0); space(); if (i !== source.length) fail('trailing JSON data'); return JSON.parse(source); }
  catch (error) { if (error.message.startsWith('Character:')) throw error; fail('invalid JSON'); }
}

/** Header and chunk checks only. A valid header is not proof the image decodes. */
export function imageDimensions(bytes, extension) {
  let width, height;
  if (extension === '.png') {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') fail('invalid PNG sheet header');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    for (let at = 8; at + 12 <= bytes.length;) {
      const size = bytes.readUInt32BE(at), kind = bytes.toString('ascii', at + 4, at + 8);
      if (kind === 'acTL' || kind === 'fcTL' || kind === 'fdAT') fail('animated PNG sheet is refused');
      if (at + 12 + size > bytes.length) fail('truncated PNG sheet chunk');
      at += 12 + size; if (kind === 'IEND') break;
    }
  } else if (extension === '.webp') {
    if (bytes.length < 25 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 > bytes.length) fail('invalid WebP sheet header');
    const end = bytes.readUInt32LE(4) + 8;
    for (let at = 12; at + 8 <= end;) {
      const size = bytes.readUInt32LE(at + 4), kind = bytes.toString('ascii', at, at + 4), start = at + 8;
      if (start + size > end) fail('truncated WebP sheet chunk');
      if (kind === 'ANIM' || kind === 'ANMF' || kind === 'VP8X' && (bytes[start] & 2)) fail('animated WebP sheet is refused');
      if (kind === 'VP8X' && size >= 10) { width = bytes.readUIntLE(start + 4, 3) + 1; height = bytes.readUIntLE(start + 7, 3) + 1; }
      else if (width === undefined && kind === 'VP8L' && size >= 5 && bytes[start] === 0x2f) { const bits = bytes.readUInt32LE(start + 1); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
      else if (width === undefined && kind === 'VP8 ' && size >= 10 && bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 1, 0x2a]))) { width = bytes.readUInt16LE(start + 6) & 0x3fff; height = bytes.readUInt16LE(start + 8) & 0x3fff; }
      at = start + size + (size & 1);
    }
  } else fail('sheet must be PNG or WebP');
  if (!integer(width, 1, 4096) || !integer(height, 1, 4096) || width * height > CHARACTER_LIMITS.filePixels) fail('sheet pixel budget exceeded or dimensions missing');
  return { width, height };
}

function safeDirectory(path, uid, { privateMode = false, io = fs } = {}) {
  const full = resolve(path), stat = io.lstatSync(full);
  if (!stat.isDirectory() || stat.isSymbolicLink() || io.realpathSync(full) !== full) fail('symlink character directory refused');
  if (stat.uid !== uid) fail('directory owner must be current user');
  if (stat.mode & 0o7022 || privateMode && (stat.mode & 0o777) !== 0o700) fail('unsafe character directory mode');
  return full;
}
function readSafe(path, cap, uid, installed) {
  const before = fs.lstatSync(path);
  const check = stat => {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('sheet files must be regular, without symlinks or hardlinks');
    if (stat.uid !== uid) fail('file owner must be current user');
    if (stat.mode & 0o7133 || installed && (stat.mode & 0o777) !== 0o600) fail('unsafe character file mode or executable bits');
    if (stat.size > cap) fail('character file size cap exceeded');
  };
  check(before); const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd); check(opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino) fail('character file changed while opening');
    // Read a bounded amount even if a file grows between stat and read.
    const bytes = Buffer.alloc(opened.size + 1); let count = 0, read;
    do { read = fs.readSync(fd, bytes, count, bytes.length - count, count); count += read; } while (read && count < bytes.length);
    const after = fs.fstatSync(fd);
    if (count !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail('character file changed while reading');
    return bytes.subarray(0, count);
  } finally { fs.closeSync(fd); }
}
function snapshot(folder, uid, installed = false) {
  folder = safeDirectory(folder, uid, { privateMode: installed });
  const entries = fs.readdirSync(folder); if (entries.length > 8) fail('too many character files');
  const files = new Map(); let total = 0;
  for (const name of entries) {
    let cap;
    if (['character.json', 'pet.json'].includes(name)) cap = CHARACTER_LIMITS.json - 1;
    else if (name === 'LICENSE.txt') cap = CHARACTER_LIMITS.license;
    else if (name === 'preview.png') cap = CHARACTER_LIMITS.preview;
    else if (/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}\.(png|webp)$/.test(name)) cap = CHARACTER_LIMITS.sheet;
    else fail('extra character file refused');
    const bytes = readSafe(join(folder, name), cap, uid, installed); total += bytes.length;
    if (total > CHARACTER_LIMITS.total) fail('total character size exceeds 16 MiB'); files.set(name, bytes);
  }
  return { folder, files, total };
}

function validateManifest(manifest, files, { expectedId, shared = false } = {}) {
  const m = structuredClone(manifest), warnings = [];
  if (!object(m) || m.format !== 'sleight-character' || m.version !== 1) fail('unsupported character format or version');
  plainData(m);
  unknownKeys(m, ['format', 'version', 'id', 'name', 'description', 'author', 'license', 'sheet', 'extra', 'frame', 'grid', 'scale', 'anchor', 'hotspot', 'states', 'codex'], 'manifest', warnings);
  idCheck(m.id); if (expectedId !== undefined && m.id !== expectedId) fail('character id must equal folder name');
  text(m.name, 'name', 1, 60); text(m.description, 'description', 0, 200); text(m.author, 'author', 1, 80); text(m.license, 'license', 1, 120);
  if (shared && m.license === 'unknown') fail('shared character license must be stated');
  // This closed set covers common art licenses. Other strings need the accompanying terms.
  const spdx = /^(?:CC0-1\.0|CC-BY(?:-SA|-NC|-NC-SA|-ND|-NC-ND)?-(?:1\.0|2\.0|2\.5|3\.0|4\.0)|MIT|Apache-2\.0|BSD-[23]-Clause|ISC|Unlicense|GPL-[23]\.0-(?:only|or-later)|OFL-1\.1)$/;
  if (!spdx.test(m.license) && !['unknown', 'proprietary-personal'].includes(m.license) && !files.has('LICENSE.txt')) fail('custom license requires LICENSE.txt');
  filename(m.sheet); if (!/^sheet\.(png|webp)$/.test(m.sheet)) fail('sheet filename must be sheet.png or sheet.webp');
  if (m.extra !== undefined && m.extra !== 'extra.webp') fail('extra sheet filename must be extra.webp');
  const allowed = ['character.json', m.sheet, m.extra, 'preview.png', 'LICENSE.txt'];
  for (const name of files.keys()) if (!allowed.includes(name)) fail('extra character file refused');
  if (!files.has(m.sheet) || m.extra && !files.has(m.extra)) fail('sheet file missing');
  m.frame ??= { w: 192, h: 208 }; m.scale ??= 1;
  if (!object(m.frame) || !integer(m.frame.w, 64, 512) || !integer(m.frame.h, 64, 512)) fail('invalid frame dimensions');
  if (!object(m.grid) || m.grid.cols !== 8 || !integer(m.grid.rows, 1, 64)) fail('invalid grid dimensions');
  if (!number(m.scale, 0.25, 2)) fail('invalid scale');
  const point = (p, label) => {
    if (!object(p) || !number(p.x, -m.frame.w, 2 * m.frame.w) || !number(p.y, -m.frame.h, 2 * m.frame.h)) fail(`invalid ${label}`);
    unknownKeys(p, ['x', 'y'], label, warnings);
    if (p.x < 0 || p.y < 0 || p.x > m.frame.w || p.y > m.frame.h) warnings.push(`${label} is outside the cell.`);
  };
  point(m.anchor, 'anchor'); point(m.hotspot, 'hotspot');
  const sheets = {}; let pixels = 0;
  for (const name of [m.sheet, m.extra, ...files.has('preview.png') ? ['preview.png'] : []].filter(Boolean)) {
    const dims = imageDimensions(files.get(name), extname(name)); pixels += dims.width * dims.height;
    if (name === 'preview.png') { if (dims.width > 256 || dims.height > 256) fail('preview dimensions exceed 256'); }
    else {
      if (dims.width !== m.grid.cols * m.frame.w || dims.height % m.frame.h || name === m.sheet && dims.height !== m.grid.rows * m.frame.h) fail('sheet dimensions do not match frame and grid');
      sheets[name === m.sheet ? 'sheet' : 'extra'] = { name, rows: dims.height / m.frame.h, ...dims };
    }
  }
  if (pixels > CHARACTER_LIMITS.pixels) fail('total character pixel budget exceeded');
  if (m.codex !== undefined) {
    if (!object(m.codex) || m.codex.spriteVersionNumber !== 2 || sheets.sheet.width !== 1536 || sheets.sheet.height !== 2288 || m.frame.w !== 192 || m.frame.h !== 208) fail('Codex v2 sheet dimensions must be 1536x2288');
    text(m.codex.importedFrom, 'Codex id', 1, 48);
    unknownKeys(m.codex, ['spriteVersionNumber', 'importedFrom'], 'Codex', warnings);
  }
  if (!object(m.states) || !object(m.states.idle) || m.states.idle.row === undefined) fail('idle animation is required');
  for (const [name, s] of Object.entries(m.states)) {
    if (!names.includes(name)) { warnings.push('Unknown state ignored.'); delete m.states[name]; continue; }
    if (!object(s)) fail('invalid state');
    unknownKeys(s, ['sheet', 'row', 'frames', 'ms', 'loop', 'fallback', 'hotspot', 'flip', 'dir16', 'start'], 'state', warnings);
    if (s.fallback !== undefined && !names.includes(s.fallback)) fail('unknown fallback state');
    if (s.flip !== undefined && s.flip !== 'h') fail('state flip must be h');
    if (s.hotspot !== undefined) point(s.hotspot, 'state hotspot');
    const sheet = sheets[s.sheet ?? 'sheet']; if (!sheet) fail('state sheet missing');
    if (s.dir16 !== undefined) {
      if (!['move', 'drag-carry', 'look'].includes(name) || !object(s.dir16) || s.row !== undefined || s.frames !== undefined || s.ms !== undefined || s.loop !== undefined || s.start !== undefined) fail('invalid dir16 state');
      if (!integer(s.dir16.rowA, 0, sheet.rows - 1) || !integer(s.dir16.rowB, 0, sheet.rows - 1)) fail('invalid dir16 rows');
      unknownKeys(s.dir16, ['rowA', 'rowB'], 'dir16', warnings);
    } else if (s.row !== undefined) {
      if (!integer(s.row, 0, sheet.rows - 1) || !integer(s.frames, 1, 8) || !integer(s.start ?? 0, 0, 8 - s.frames)) fail('invalid state row or frames');
      const ms = Array.isArray(s.ms) ? s.ms : Array(s.frames).fill(s.ms);
      if (ms.length !== s.frames || ms.some(n => !number(n, 20, 2000)) || ms.reduce((a, b) => a + b, 0) > 4000) fail('invalid state duration');
      if (typeof s.loop !== 'boolean') fail('invalid state loop');
      if (s.loop && ms.some(n => n < 40)) fail('looping state duration must be at least 40 ms');
      if (ms.some(n => n < 40)) warnings.push('State duration is below 40 ms.');
    } else if (s.fallback === undefined || ['frames', 'ms', 'loop', 'start'].some(k => s[k] !== undefined)) fail('state requires animation or fallback');
  }
  // Explicit fallback edges must be acyclic even when a node has its own art.
  for (const name of Object.keys(m.states)) {
    const seen = new Set(); let current = name;
    while (m.states[current]?.fallback !== undefined) { if (seen.has(current)) fail('fallback cycle'); seen.add(current); current = m.states[current].fallback; }
  }
  for (const key of ['frame', 'grid']) unknownKeys(m[key], key === 'frame' ? ['w', 'h'] : ['cols', 'rows'], key, warnings);
  const resolved = resolveCharacterStates(m);
  if (required.some(name => !resolved.find(s => s.state === name).own)) warnings.push('Partial character: some required states use fallback art.');
  return { manifest: m, resolved, warnings, sheets };
}

/** Resolves to concrete cells for a heading (degrees clockwise from up). Built-in cycles skip visited nodes. */
export function resolveCharacterStates(m, { heading = 90, distance = 0 } = {}) {
  const headingIndex = Math.round((((heading % 360) + 360) % 360) / 22.5) % 16;
  const right = headingIndex <= 8;
  const ownArt = s => s?.row !== undefined || s?.dir16 !== undefined;
  const find = (name, visited = new Set()) => {
    if (visited.has(name)) return undefined;
    const seen = new Set(visited).add(name), state = m.states[name];
    if (ownArt(state)) return { source: name, animation: state };
    const fallbacks = state?.fallback ? [state.fallback] : CHARACTER_STATES.find(s => s.state === name)?.fallback ?? ['idle'];
    const ordered = name === 'move' && !right && !state?.fallback ? ['running-left', 'running-right', 'look', 'idle'] : fallbacks;
    for (const fallback of ordered) {
      const found = find(fallback, seen);
      if (found) return { ...found, animation: { ...found.animation,
        ...state?.flip !== undefined ? { flip: state.flip } : {}, ...state?.hotspot !== undefined ? { hotspot: state.hotspot } : {} } };
    }
  };
  return CHARACTER_STATES.map(({ state, label }) => {
    let found = find(state); if (!found) fail('unresolved character state');
    const own = ownArt(m.states[state]); let a = found.animation;
    // Codex travelling rows are optional named animations; directional rows remain unchanged.
    if (a.dir16 && (state === 'move' || state === 'drag-carry') && distance > 60 && Math.abs(Math.sin(heading * Math.PI / 180)) > Math.abs(Math.cos(heading * Math.PI / 180))) {
      const travel = right ? 'running-right' : 'running-left';
      if (m.states[travel]) { found = find(travel); a = found.animation; }
    }
    const directional = a.dir16 !== undefined;
    let row = directional ? a.dir16[headingIndex < 8 ? 'rowA' : 'rowB'] : a.row;
    let start = directional ? headingIndex % 8 : a.start ?? 0;
    let frames = directional ? 1 : a.frames;
    let ms = directional ? [160] : Array.isArray(a.ms) ? [...a.ms] : Array(frames).fill(a.ms);
    let loop = directional ? false : a.loop;
    if (m.codex && state === 'aim' && a.row === 9 && a.sheet !== 'extra') { row = headingIndex < 8 ? 9 : 10; start = headingIndex % 8; }
    if (!own && state === 'key') { frames = Math.min(frames, 3); ms = ms.slice(0, frames); loop = false; }
    if (!own && state === 'drag-grab') { frames = Math.min(frames, 2); ms = ms.slice(0, frames); loop = false; }
    if (!own && state === 'right-click' && found.source === 'wave') { frames = Math.min(frames, 3); ms = ms.slice(0, frames); }
    if (!own && m.codex && a.row === 4 && a.sheet !== 'extra') {
      if (state === 'drag-grab') start = 0;
      if (state === 'drag-drop') { start = 3; frames = 2; ms = [140, 280]; }
    }
    if (!own && ['double-click', 'right-click', 'drag-drop', 'success', 'handoff'].includes(state)) loop = false;
    const shows = found.source === 'move' && directional ? 'move (look directions)' : found.source;
    return { state, label, own, source: found.source, shows, sheet: a.sheet === 'extra' ? m.extra : m.sheet, row, start, frames, ms, loop, flip: a.flip ?? false,
      hotspot: a.hotspot ?? m.hotspot, repeat: !own && state === 'double-click' ? 2 : 1,
      then: !own && state === 'handoff' ? 'idle' : undefined,
      holdLast: !own && state === 'drag-grab',
      look: !own && ['scroll-up', 'scroll-down'].includes(state) && m.states.look?.dir16 ? { row: m.states.look.dir16[state === 'scroll-up' ? 'rowA' : 'rowB'], start: 0 } : undefined,
      effect: !own && ['click', 'waiting-approval', 'error'].includes(state) && found.source === 'idle' ? state === 'error' ? 'red-pulse' : 'pulse' : undefined };
  });
}

export function loadCharacter(folder, { uid = process.getuid(), shared = false, expectedId = basename(resolve(folder)), installed = false } = {}) {
  const snap = snapshot(folder, uid, installed);
  if (!snap.files.has('character.json')) fail('character.json missing');
  return { ...snap, ...validateManifest(parseCharacterJSON(snap.files.get('character.json')), snap.files, { expectedId, shared }) };
}

function codexManifest(pet, sheet) {
  if (!object(pet) || pet.spriteVersionNumber !== 2) fail('Codex pet must have spriteVersionNumber 2');
  idCheck(pet.id); text(pet.displayName, 'name', 1, 60); text(pet.description ?? '', 'description', 0, 200);
  const timed = (row, frames, ms, loop = true, start = 0) => ({ row, frames, ms, loop, ...start ? { start } : {} });
  return { format: 'sleight-character', version: 1, id: pet.id, name: pet.displayName, description: pet.description ?? '', author: pet.author ?? 'Local import', license: pet.license ?? 'unknown', sheet,
    frame: { w: 192, h: 208 }, grid: { cols: 8, rows: 11 }, scale: 1, anchor: { x: 96, y: 196 }, hotspot: { x: 96, y: 104 },
    states: { idle: timed(0, 6, [280, 110, 110, 140, 140, 320]), move: { dir16: { rowA: 9, rowB: 10 } },
      aim: timed(9, 1, 160, false, 4), click: timed(4, 3, 140, false, 1), type: timed(7, 6, [120, 120, 120, 120, 120, 220]),
      'waiting-approval': timed(6, 6, [150, 150, 150, 150, 150, 260]), error: timed(5, 8, [140, 140, 140, 140, 140, 140, 140, 240], false),
      thinking: timed(8, 6, [150, 150, 150, 150, 150, 280]), success: timed(3, 4, [140, 140, 140, 280], false),
      'running-right': timed(1, 8, [120, 120, 120, 120, 120, 120, 120, 220]), 'running-left': timed(2, 8, [120, 120, 120, 120, 120, 120, 120, 220]),
      look: { dir16: { rowA: 9, rowB: 10 } }, wave: timed(3, 4, [140, 140, 140, 280], false),
      'right-click': { fallback: 'wave' }, working: { fallback: 'type' } },
    codex: { spriteVersionNumber: 2, importedFrom: pet.id } };
}

export function prepareCharacterImport(folder, { uid = process.getuid(), shared = false } = {}) {
  const snap = snapshot(folder, uid);
  if (snap.files.has('character.json')) return loadCharacter(folder, { uid, shared });
  if (!snap.files.has('pet.json')) fail('character.json or Codex pet.json required');
  const pet = parseCharacterJSON(snap.files.get('pet.json')); filename(pet.spritesheetPath);
  const ext = extname(pet.spritesheetPath); if (!['.png', '.webp'].includes(ext) || !snap.files.has(pet.spritesheetPath)) fail('Codex sheet missing or invalid');
  for (const name of snap.files.keys()) if (!['pet.json', pet.spritesheetPath, 'LICENSE.txt', 'preview.png'].includes(name)) fail('extra Codex character file refused');
  const sheet = `sheet${ext}`, m = codexManifest(pet, sheet), files = new Map([[sheet, snap.files.get(pet.spritesheetPath)]]);
  for (const name of ['LICENSE.txt', 'preview.png']) if (snap.files.has(name)) files.set(name, snap.files.get(name));
  files.set('character.json', Buffer.from(JSON.stringify(m, null, 2) + '\n'));
  const total = [...files.values()].reduce((n, b) => n + b.length, 0); if (total > CHARACTER_LIMITS.total) fail('total character size exceeds 16 MiB');
  return { folder: snap.folder, files, total, ...validateManifest(m, files, { shared }) };
}

export const charactersDirectory = (env = process.env) => env.SLEIGHT_CHARACTERS_DIR ?? join(userInfo().homedir, 'Library/Application Support/sleight/characters');
function storage(root, uid, create = false, io = fs) {
  if (!isAbsolute(root) || resolve(root) !== root) fail('character storage path must be absolute and normalized');
  if (create && !io.existsSync(root)) {
    // Check the nearest existing parent before creating descendants. /tmp aliases are not accepted.
    let parent = dirname(root); while (!io.existsSync(parent)) parent = dirname(parent);
    if (io.realpathSync(parent) !== parent) fail('symlink storage parent refused');
    io.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  return safeDirectory(root, uid, { privateMode: true, io });
}
export function installCharacter(character, { root = charactersDirectory(), uid = process.getuid(), io = fs } = {}) {
  // Revalidate the captured data, not a source folder which may have changed during confirmation.
  const files = new Map([...character.files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  const m = parseCharacterJSON(files.get('character.json')); validateManifest(m, files);
  if ([...files.values()].reduce((n, b) => n + b.length, 0) > CHARACTER_LIMITS.total) fail('total character size exceeds 16 MiB');
  root = storage(root, uid, true, io); const target = join(root, m.id);
  if (io.existsSync(target)) fail('character already exists; remove it first');
  const staging = io.mkdtempSync(join(root, '.import-')); io.chmodSync(staging, 0o700);
  try {
    for (const [name, bytes] of files) { filename(name); io.writeFileSync(join(staging, name), bytes, { flag: 'wx', mode: 0o600 }); }
    loadCharacter(staging, { uid, expectedId: m.id, installed: true });
    storage(root, uid, false, io);
    if (io.existsSync(target)) fail('character already exists; remove it first');
    io.renameSync(staging, target);
  } catch (error) { io.rmSync(staging, { recursive: true, force: true }); throw error; }
  return target;
}
export function listCharacters({ root = charactersDirectory(), uid = process.getuid() } = {}) {
  try { storage(root, uid); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return fs.readdirSync(root).filter(name => !name.startsWith('.import-')).sort().map(id => { idCheck(id); return loadCharacter(join(root, id), { uid, installed: true }); });
}
export function checkCharacter(id, { root = charactersDirectory(), uid = process.getuid() } = {}) {
  idCheck(id); storage(root, uid); return loadCharacter(join(root, id), { uid, installed: true });
}
export function removeCharacter(id, { root = charactersDirectory(), uid = process.getuid() } = {}) {
  idCheck(id); storage(root, uid); const folder = join(root, id);
  // Refuse unsafe data rather than recursively walking anything the validator would not load.
  loadCharacter(folder, { uid, installed: true }); fs.rmSync(folder, { recursive: true });
}
export function characterCallout(character) {
  const { manifest: m, resolved, total, warnings } = character, own = resolved.filter(s => s.own).length;
  return [`Character: ${m.name}`, `Size: ${total} bytes`, `License: ${m.license === 'unknown' ? 'not stated' : m.license}`,
    `${own} of ${resolved.length} sleight states have their own animation.`,
    ...resolved.filter(s => !s.own).map(s => `${s.label}: no animation of its own, shows ${s.shows}${s.repeat === 2 ? ', played twice' : ''}`),
    'To add animations, draw an extra.webp sheet and add states.<name> entries with sheet: "extra" in character.json.',
    'Format: docs/design/character-format.md', ...warnings.map(w => `Warning: ${w}`),
    'Your source files are not changed. sleight copies them.'].join('\n') + '\n';
}
