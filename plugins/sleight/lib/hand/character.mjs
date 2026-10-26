// Character packs are data. This module reads container headers, never decoded pixels.
import * as fs from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

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
  ['drag-drop', 'Drag drop', ['click', 'idle']], ['waiting-approval', 'Waiting for your OK', ['idle']],
  ['error', 'Error', ['idle']], ['success', 'Success', ['wave', 'idle']],
  ['thinking', 'Thinking', ['working', 'idle']], ['handoff', 'Hand back', ['success', 'idle']],
  ['working', 'Working', ['thinking', 'idle']],
].map(([state, label, fallback]) => Object.freeze({ state, label, fallback: Object.freeze(fallback) })));
const helpers = ['running-right', 'running-left', 'look', 'poke', 'wave'];
// Perch mode (A2): optional states with fallbacks to art every pack has. jumping is Codex's row 4, used by the leap.
export const PERCH_STATES = Object.freeze(['perch', 'perch-peek', 'perch-hop', 'perch-point-left', 'perch-point-right', 'sleep', 'high-five',
  'perch-wait', 'startle', 'jumping', 'paused']);
const names = [...CHARACTER_STATES.map(s => s.state), ...helpers, ...PERCH_STATES];
const required = ['move', 'aim', 'click', 'type', 'waiting-approval', 'error'];
const characterFailure = (message, field = 'manifest', file = 'character.json') => { throw Error(`Character: ${JSON.stringify(file)} ${field}: ${message}`); };
const fail = characterFailure;
function fileOperation(file, field, operation) {
  try { return operation(); }
  catch (error) {
    if (error.message.startsWith('Character:')) throw error;
    const wrapped = Error(`Character: ${JSON.stringify(file)} ${field}: ${error.code ?? error.message}`);
    wrapped.code = error.code; throw wrapped;
  }
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
const number = (value, low, high) => Number.isFinite(value) && value >= low && value <= high;
function idCheck(id, file = 'character.json') { if (typeof id !== 'string' || !/^[a-z0-9-]{1,48}$/.test(id)) fail('invalid character id; use 1 to 48 lowercase letters, digits or hyphens', 'id', file); }
function text(value, label, min, max, file = 'character.json') {
  if (typeof value !== 'string' || value.length < min || value.length > max || /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)) fail(`invalid ${label} text`, label, file);
}
function filename(value, field = 'sheet', file = 'character.json') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(value) || value.includes('..')) fail('invalid sheet filename', field, file);
  return value;
}
function unknownKeys(value, keys, label, warnings) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) warnings.push(`Unknown ${label} key ignored.`);
}
function plainData(value, field = '', file = 'character.json') {
  if (typeof value === 'string') text(value, field || 'manifest', 0, 200, file);
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    text(key, 'manifest key', 0, 80, file); plainData(child, field ? `${field}.${key}` : key, file);
  }
}

// JSON.parse alone accepts duplicate keys. Scan JSON tokens first, including escaped key spellings.
export function parseCharacterJSON(bytes, file = 'character.json') {
  const fail = message => { throw Error(`Character: ${JSON.stringify(file)} JSON: ${message}`); };
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
export function imageDimensions(bytes, extension, file = `sheet${extension}`) {
  const refuse = message => fail(message, 'image', file);
  let width, height;
  if (extension === '.png') {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') refuse('invalid PNG sheet header');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    let data = false, ended = false, at = 8;
    while (at < bytes.length) {
      if (at + 12 > bytes.length) refuse('truncated PNG sheet chunk');
      const size = bytes.readUInt32BE(at), kind = bytes.toString('ascii', at + 4, at + 8);
      if (at + 12 + size > bytes.length) refuse('truncated PNG sheet chunk');
      if (kind === 'acTL' || kind === 'fcTL' || kind === 'fdAT') refuse('animated PNG sheet is refused');
      if (kind === 'IHDR' && at !== 8) refuse('duplicate PNG IHDR');
      if (kind === 'IDAT') data = true;
      at += 12 + size;
      if (kind === 'IEND') {
        if (size !== 0) refuse('invalid PNG IEND length');
        ended = true; break;
      }
    }
    if (!data || !ended) refuse('PNG requires IDAT before IEND');
    if (at !== bytes.length) refuse('trailing data after PNG IEND');
  } else if (extension === '.webp') {
    if (bytes.length < 25 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) refuse('invalid WebP sheet header');
    const end = bytes.readUInt32LE(4) + 8;
    let canvas, images = 0, at = 12;
    while (at < end) {
      if (at + 8 > end) refuse('truncated WebP sheet chunk');
      const size = bytes.readUInt32LE(at + 4), kind = bytes.toString('ascii', at, at + 4), start = at + 8;
      if (start + size + (size & 1) > end) refuse('truncated WebP sheet chunk');
      if (at === 12 && !['VP8X', 'VP8 ', 'VP8L'].includes(kind)) refuse('WebP first chunk must be VP8, VP8L or VP8X');
      if (kind === 'ANIM' || kind === 'ANMF' || kind === 'VP8X' && (bytes[start] & 2)) refuse('animated WebP sheet is refused');
      if (kind === 'VP8X') {
        if (at !== 12 || canvas) refuse('WebP VP8X must be first and unique');
        if (size !== 10) refuse('invalid WebP VP8X header');
        canvas = { width: bytes.readUIntLE(start + 4, 3) + 1, height: bytes.readUIntLE(start + 7, 3) + 1 };
      } else if (kind === 'VP8L' || kind === 'VP8 ') {
        if (++images !== 1) refuse('WebP requires exactly one image chunk');
        if (kind === 'VP8L' && size >= 5 && bytes[start] === 0x2f) {
          const bits = bytes.readUInt32LE(start + 1); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
        } else if (kind === 'VP8 ' && size >= 10 && bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 1, 0x2a]))) {
          width = bytes.readUInt16LE(start + 6) & 0x3fff; height = bytes.readUInt16LE(start + 8) & 0x3fff;
        } else refuse('invalid WebP image bitstream header');
      }
      at = start + size + (size & 1);
    }
    if (images !== 1) refuse('WebP requires exactly one image chunk');
    if (canvas && (canvas.width !== width || canvas.height !== height)) refuse('WebP canvas must equal image dimensions');
  } else refuse('sheet must be PNG or WebP');
  if (!integer(width, 1, 4096) || !integer(height, 1, 4096) || width * height > CHARACTER_LIMITS.filePixels) refuse('sheet pixel budget exceeded or dimensions missing');
  return { width, height };
}

function safeDirectory(path, uid, { privateMode = false, io = fs } = {}) {
  return fileOperation(path, 'directory', () => {
    const refuse = message => fail(message, 'directory', path);
    const full = resolve(path), stat = io.lstatSync(full);
    if (!stat.isDirectory() || stat.isSymbolicLink() || io.realpathSync(full) !== full) refuse('symlink character directory refused');
    if (stat.uid !== uid) refuse('directory owner must be current user');
    if (stat.mode & 0o7022 || privateMode && (stat.mode & 0o777) !== 0o700) refuse(`unsafe character directory mode; run chmod 700 '${full.replaceAll("'", "'\\''")}'`);
    return full;
  });
}
function readSafe(path, cap, uid, installed, io = fs, builtin = false) {
  return fileOperation(path, 'file', () => {
    const refuse = message => fail(message, 'file', path);
    const before = io.lstatSync(path);
    const check = stat => {
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) refuse('sheet files must be regular, without symlinks or hardlinks');
      if (stat.uid !== uid) refuse('file owner must be current user');
      if (builtin ? ![0o600, 0o644].includes(stat.mode & 0o7777) : stat.mode & 0o7133 || installed && (stat.mode & 0o777) !== 0o600) refuse('unsafe character file mode or executable bits');
      if (stat.size > cap) refuse('character file size cap exceeded');
    };
    check(before); const fd = io.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const opened = io.fstatSync(fd); check(opened);
      if (opened.dev !== before.dev || opened.ino !== before.ino) refuse('character file changed while opening');
      // Read a bounded amount even if a file grows between stat and read.
      const bytes = Buffer.alloc(opened.size + 1); let count = 0, read;
      do { read = io.readSync(fd, bytes, count, bytes.length - count, count); count += read; } while (read && count < bytes.length);
      const after = io.fstatSync(fd);
      if (count !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) refuse('character file changed while reading');
      return bytes.subarray(0, count);
    } finally { io.closeSync(fd); }
  });
}
function snapshot(folder, uid, installed = false, io = fs, builtin = false) {
  folder = safeDirectory(folder, uid, { privateMode: installed, io });
  const entries = fileOperation(folder, 'entries', () => io.readdirSync(folder)).filter(name => {
    if (name !== '.DS_Store') return true;
    const stat = fileOperation(join(folder, name), 'entry', () => io.lstatSync(join(folder, name)));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('ignored metadata must be regular, without symlinks or hardlinks', 'entry', name);
    return false;
  });
  if (entries.length > 8) fail('too many character files', 'entries', folder);
  const files = new Map(); let total = 0;
  for (const name of entries) {
    let cap;
    if (['character.json', 'pet.json'].includes(name)) cap = CHARACTER_LIMITS.json - 1;
    else if (name === 'LICENSE.txt') cap = CHARACTER_LIMITS.license;
    else if (name === 'preview.png') cap = CHARACTER_LIMITS.preview;
    else if (/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}\.(png|webp)$/.test(name)) cap = CHARACTER_LIMITS.sheet;
    else fail('extra character file refused', 'entry', name);
    const bytes = readSafe(join(folder, name), cap, uid, installed, io, builtin); total += bytes.length;
    if (total > CHARACTER_LIMITS.total) fail('total character size exceeds 16 MiB', 'entries', folder); files.set(name, bytes);
  }
  return { folder, files, total };
}

function validateManifest(manifest, files, { expectedId, shared = false, sourceFile = 'character.json' } = {}) {
  const fail = (message, field = 'manifest', file = sourceFile) => characterFailure(message, field, file);
  const m = structuredClone(manifest), warnings = [];
  if (!object(m) || m.format !== 'sleight-character' || m.version !== 1) fail('unsupported character format or version', 'format/version');
  // A bad lines block never refuses the pack (A2): it is checked by its own rules and dropped with one warning.
  const rawLines = m.lines; delete m.lines;
  plainData(m, '', sourceFile);
  unknownKeys(m, ['format', 'version', 'id', 'name', 'description', 'author', 'license', 'sheet', 'extra', 'frame', 'grid', 'scale', 'anchor', 'hotspot', 'states', 'codex', 'perch'], 'manifest', warnings);
  const lines = characterLines(rawLines, warnings); if (lines) m.lines = lines;
  if (m.perch !== undefined) {
    if (!object(m.perch)) fail('invalid perch block', 'perch');
    unknownKeys(m.perch, ['anchor', 'sheet'], 'perch', warnings);
    if (m.perch.sheet !== undefined && !/^perch\.(png|webp)$/.test(m.perch.sheet)) fail('perch sheet filename must be perch.png or perch.webp', 'perch.sheet');
  }
  idCheck(m.id, sourceFile); if (expectedId !== undefined && m.id !== expectedId) fail('character id must equal folder name', 'id');
  text(m.name, 'name', 1, 60, sourceFile); text(m.description, 'description', 0, 200, sourceFile); text(m.author, 'author', 1, 80, sourceFile); text(m.license, 'license', 1, 120, sourceFile);
  if (shared && m.license === 'unknown') fail('shared character license must be stated', 'license');
  // This closed set covers common art licenses. Other strings need the accompanying terms.
  const spdx = /^(?:CC0-1\.0|CC-BY(?:-SA|-NC|-NC-SA|-ND|-NC-ND)?-(?:1\.0|2\.0|2\.5|3\.0|4\.0)|MIT|Apache-2\.0|BSD-[23]-Clause|ISC|Unlicense|GPL-[23]\.0-(?:only|or-later)|OFL-1\.1)$/;
  if (!spdx.test(m.license) && !['unknown', 'proprietary-personal'].includes(m.license) && !files.has('LICENSE.txt')) fail('custom license requires LICENSE.txt', 'license');
  filename(m.sheet, 'sheet', sourceFile); if (!/^sheet\.(png|webp)$/.test(m.sheet)) fail('sheet filename must be sheet.png or sheet.webp', 'sheet');
  if (m.extra !== undefined && m.extra !== 'extra.webp') fail('extra sheet filename must be extra.webp', 'extra');
  const allowed = ['character.json', m.sheet, m.extra, m.perch?.sheet, 'preview.png', 'LICENSE.txt'];
  if (!files.has(m.sheet)) fail('sheet file missing', 'sheet', m.sheet);
  if (m.extra && !files.has(m.extra)) fail('sheet file missing', 'extra', m.extra);
  if (m.perch?.sheet && !files.has(m.perch.sheet)) fail('sheet file missing', 'perch.sheet', m.perch.sheet);
  for (const name of files.keys()) if (!allowed.includes(name)) fail('extra character file refused', 'entry', name);
  m.frame ??= { w: 192, h: 208 }; m.scale ??= 1;
  // The hand host draws cells of at most 192x208 on sheets of at most 1536x2288 (8 columns, 11 rows of the largest cell).
  if (!object(m.frame) || !integer(m.frame.w, 64, 192) || !integer(m.frame.h, 64, 208)) fail('invalid frame dimensions (cells are at most 192x208)', 'frame');
  if (!object(m.grid) || m.grid.cols !== 8 || !integer(m.grid.rows, 1, 64)) fail('invalid grid dimensions', 'grid');
  if (!number(m.scale, 0.25, 2)) fail('invalid scale', 'scale');
  const point = (p, label) => {
    if (!object(p) || !number(p.x, -m.frame.w, 2 * m.frame.w) || !number(p.y, -m.frame.h, 2 * m.frame.h)) fail(`invalid ${label}`, label);
    unknownKeys(p, ['x', 'y'], label, warnings);
    if (p.x < 0 || p.y < 0 || p.x > m.frame.w || p.y > m.frame.h) warnings.push(`${label} is outside the cell.`);
  };
  point(m.anchor, 'anchor'); point(m.hotspot, 'hotspot');
  if (m.perch?.anchor !== undefined) point(m.perch.anchor, 'perch.anchor');
  const sheets = Object.create(null); let pixels = 0;
  for (const name of [m.sheet, m.extra, m.perch?.sheet, ...files.has('preview.png') ? ['preview.png'] : []].filter(Boolean)) {
    const dims = imageDimensions(files.get(name), extname(name), name); pixels += dims.width * dims.height;
    if (name === 'preview.png') { if (dims.width > 256 || dims.height > 256) fail('preview dimensions exceed 256', 'dimensions', name); }
    else {
      if (dims.width !== m.grid.cols * m.frame.w || dims.height % m.frame.h || name === m.sheet && dims.height !== m.grid.rows * m.frame.h) fail('sheet dimensions do not match frame and grid', 'frame/grid', name);
      if (dims.width > 1536 || dims.height > 2288) fail('sheet too large to draw (at most 1536x2288)', 'frame/grid', name);
      sheets[name === m.sheet ? 'sheet' : name === m.extra ? 'extra' : 'perch'] = { name, rows: dims.height / m.frame.h, ...dims };
    }
  }
  if (pixels > CHARACTER_LIMITS.pixels) fail('total character pixel budget exceeded', 'sheet/extra/preview');
  if (m.codex !== undefined) {
    if (!object(m.codex) || ![1, 2].includes(m.codex.spriteVersionNumber)) fail('Codex spriteVersionNumber must be 1 or 2', 'codex.spriteVersionNumber');
    const height = m.codex.spriteVersionNumber === 1 ? 1872 : 2288;
    if (sheets.sheet.width !== 1536 || sheets.sheet.height !== height || m.frame.w !== 192 || m.frame.h !== 208) fail(`Codex v${m.codex.spriteVersionNumber} sheet dimensions must be 1536x${height}`, 'codex/frame/grid');
    text(m.codex.importedFrom, 'codex.importedFrom', 1, 48);
    unknownKeys(m.codex, ['spriteVersionNumber', 'importedFrom'], 'Codex', warnings);
  }
  if (!object(m.states) || !object(m.states.idle) || m.states.idle.row === undefined) fail('idle animation is required', 'states.idle');
  for (const [name, s] of Object.entries(m.states)) {
    if (!names.includes(name)) { warnings.push('Unknown state ignored.'); delete m.states[name]; continue; }
    if (!object(s)) fail('invalid state', `states.${name}`);
    unknownKeys(s, ['sheet', 'row', 'frames', 'ms', 'loop', 'fallback', 'hotspot', 'flip', 'dir16', 'start'], 'state', warnings);
    if (s.fallback !== undefined && !names.includes(s.fallback)) fail('unknown fallback state', `states.${name}.fallback`);
    if (s.flip !== undefined && s.flip !== 'h') fail('state flip must be h', `states.${name}.flip`);
    if (s.hotspot !== undefined) point(s.hotspot, `states.${name}.hotspot`);
    if (s.sheet !== undefined && s.sheet !== 'sheet' && s.sheet !== 'extra' && s.sheet !== 'perch') fail('must be sheet or extra', `states.${name}.sheet`);
    const sheet = sheets[s.sheet ?? 'sheet']; if (!sheet) fail('state sheet missing', `states.${name}.sheet`);
    if (s.dir16 !== undefined) {
      if (!['move', 'drag-carry', 'look'].includes(name) || !object(s.dir16) || s.row !== undefined || s.frames !== undefined || s.ms !== undefined || s.loop !== undefined || s.start !== undefined) fail('invalid dir16 state', `states.${name}.dir16`);
      if (!integer(s.dir16.rowA, 0, sheet.rows - 1) || !integer(s.dir16.rowB, 0, sheet.rows - 1)) fail('invalid dir16 rows', `states.${name}.dir16`);
      unknownKeys(s.dir16, ['rowA', 'rowB'], 'dir16', warnings);
    } else if (s.row !== undefined) {
      if (!integer(s.row, 0, sheet.rows - 1) || !integer(s.frames, 1, 8) || !integer(s.start ?? 0, 0, 8 - s.frames)) fail('invalid state row or frames', `states.${name}.row/frames/start`);
      const ms = Array.isArray(s.ms) ? s.ms : Array(s.frames).fill(s.ms);
      if (ms.length !== s.frames || ms.some(n => !number(n, 20, 2000)) || ms.reduce((a, b) => a + b, 0) > 4000) fail('invalid state duration', `states.${name}.ms`);
      if (typeof s.loop !== 'boolean') fail('invalid state loop', `states.${name}.loop`);
      if (s.loop && ms.some(n => n < 40)) fail('looping state duration must be at least 40 ms', `states.${name}.ms`);
      if (ms.some(n => n < 40)) warnings.push('State duration is below 40 ms.');
    } else if (s.fallback === undefined || ['frames', 'ms', 'loop', 'start'].some(k => s[k] !== undefined)) fail('state requires animation or fallback', `states.${name}`);
  }
  // Explicit fallback edges must be acyclic even when a node has its own art.
  for (const name of Object.keys(m.states)) {
    const seen = new Set(); let current = name;
    while (m.states[current]?.fallback !== undefined) { if (seen.has(current)) fail('fallback cycle', `states.${name}.fallback`); seen.add(current); current = m.states[current].fallback; }
  }
  for (const key of ['frame', 'grid']) unknownKeys(m[key], key === 'frame' ? ['w', 'h'] : ['cols', 'rows'], key, warnings);
  const resolved = resolveCharacterStates(m);
  if (required.some(name => !resolved.find(s => s.state === name).own)) warnings.push('Partial character: some required states use fallback art.');
  return { manifest: m, resolved, warnings, sheets, perch: resolvePerchStates(m) };
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
  const sheetNames = Object.assign(Object.create(null), { sheet: m.sheet, extra: m.extra, perch: m.perch?.sheet });
  return CHARACTER_STATES.map(({ state, label }) => {
    let found = find(state); if (!found) fail('unresolved character state', `states.${state}`);
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
    return { state, label, own, source: found.source, shows, sheet: sheetNames[a.sheet ?? 'sheet'], row, start, frames, ms, loop, flip: a.flip ?? false,
      hotspot: a.hotspot ?? m.hotspot, repeat: !own && state === 'double-click' ? 2 : 1,
      then: !own && state === 'handoff' ? 'idle' : undefined,
      holdLast: !own && state === 'drag-grab',
      look: !own && ['scroll-up', 'scroll-down'].includes(state) && m.states.look?.dir16 ? { row: m.states.look.dir16[state === 'scroll-up' ? 'rowA' : 'rowB'], start: 0 } : undefined,
      effect: !own && ['click', 'waiting-approval', 'error'].includes(state) && found.source === 'idle' ? state === 'error' ? 'red-pulse' : 'pulse' : undefined };
  });
}

// Personality lines (A2 part 2). Data only: the host draws them and nothing else reads them. Lines never reach the model,
// a tool result or the cursor stream.
export const LINE_MOMENTS = Object.freeze(['start', 'first-click', 'typing', 'long-wait', 'approval', 'error', 'done', 'handback', 'wake']);
/** One line: 1 to 60 characters after trimming, one plain-text line, no markup, URL, path or model-facing word. Emoji (with
 *  ZWJ joins) are allowed. The host applies the same rule to the trimmed text. */
export function characterLineValid(line) {
  if (typeof line !== 'string') return false;
  const t = line.trim(), count = [...t].length;
  if (count < 1 || count > 60) return false;
  if (/[\p{Cc}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u.test(t) || /(?!\u200d)\p{Cf}/u.test(t) || /[<>{}`*_[\]|]/.test(t)) return false;
  if (/:\/\/|www\.|~\//i.test(t) || /\/\p{L}/u.test(t)) return false;
  return !/\b(?:system|assistant|ignore|tool)\b/i.test(t);
}
/** The normalized lines block, or undefined (absent, or dropped with one warning). Unknown keys warn and are ignored. */
export function characterLines(raw, warnings = []) {
  if (raw === undefined) return undefined;
  const drop = () => { warnings.push('Character lines dropped: they break the lines rules.'); return undefined; };
  if (!object(raw)) return drop();
  let size; try { size = Buffer.byteLength(JSON.stringify(raw)); } catch { return drop(); }
  if (size > 4096) return drop();
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'lang') {
      if (typeof value !== 'string' || value.length > 16 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value)) return drop();
      out.lang = value; continue;
    }
    if (!LINE_MOMENTS.includes(key)) { warnings.push('Unknown lines key ignored.'); continue; }
    if (!Array.isArray(value) || value.length < 1 || value.length > 16 || !value.every(characterLineValid)) return drop();
    out[key] = value.map(line => line.trim());
  }
  return out;
}

/** Perch mode's cells (A2): each perch state with A2's fallbacks to art every pack has, plus the leap's jumping, the runs,
 *  and the error and hand-back states it shows, so the host's perch table is complete for every pack. */
export function resolvePerchStates(m) {
  const base = Object.fromEntries(resolveCharacterStates(m).map(s => [s.state, s]));
  const names = Object.assign(Object.create(null), { sheet: m.sheet, extra: m.extra, perch: m.perch?.sheet });
  const pick = (state, source, a, more = {}) => {
    const columns = more.columns ?? Array.from({ length: a.frames }, (_, i) => (a.start ?? 0) + i);
    const ms = more.ms ?? (Array.isArray(a.ms) ? [...a.ms] : Array(a.frames).fill(a.ms));
    return { state, own: source === state, source, sheet: names[a.sheet ?? 'sheet'], row: more.row ?? a.row, columns, ms: ms.slice(0, columns.length),
      loop: more.loop ?? a.loop, flip: a.flip ?? m.states[state]?.flip ?? false, hotspot: m.states[state]?.hotspot ?? a.hotspot ?? m.hotspot };
  };
  // A resolved 19-state entry as a perch entry.
  const from = (state, s, more = {}) => ({ state, own: false, source: s.source, sheet: s.sheet, row: more.row ?? s.row,
    columns: more.columns ?? Array.from({ length: s.frames }, (_, i) => s.start + i), ms: more.ms ?? [...s.ms], loop: more.loop ?? s.loop,
    flip: s.flip, hotspot: m.states[state]?.hotspot ?? s.hotspot });
  const timed = name => m.states[name]?.row !== undefined ? m.states[name] : undefined;
  const still = (state, ms) => from(state, base.idle, { columns: [base.idle.start], ms: [ms], loop: false });
  // The look pose at one heading (degrees clockwise from up): a dir16 look picks the pose, a timed look plays as it is.
  const look = (state, heading, ms) => {
    const a = m.states.look;
    if (a?.dir16) { const i = Math.round(heading / 22.5) % 16; return { ...pick(state, 'look', { ...a, row: a.dir16[i < 8 ? 'rowA' : 'rowB'], frames: 1 }, { columns: [i % 8], ms: [ms], loop: false }) }; }
    return a?.row !== undefined ? { ...pick(state, 'look', a), own: false } : undefined;
  };
  const codexJump = m.codex ? { row: 4, frames: 5, ms: [140, 140, 140, 140, 280], loop: false } : undefined;
  const out = {};
  const own = name => timed(name) && pick(name, name, timed(name));
  out.jumping = own('jumping') || (codexJump && { ...pick('jumping', 'jumping', codexJump), own: false })
    || (timed('perch-hop') && { ...pick('jumping', 'perch-hop', timed('perch-hop')), own: false }) || still('jumping', 140);
  out.perch = own('perch') || from('perch', base.idle);
  out['perch-peek'] = own('perch-peek') || look('perch-peek', 180, 400) || still('perch-peek', 400);
  const jump = own('jumping') ? timed('jumping') : codexJump;
  out['perch-hop'] = own('perch-hop') || (jump && jump.frames >= 5 && { ...pick('perch-hop', 'jumping', jump,
    { columns: [0, 1, 3, 4].map(c => (jump.start ?? 0) + c), ms: [70, 120, 70, 160], loop: false }), own: false }) || still('perch-hop', 160);
  // A pack's aim points up-left, which is wrong from the edge, so look wins when both exist.
  const aim = base.aim.own ? from('aim', base.aim, { loop: false }) : undefined;
  out['perch-point-left'] = own('perch-point-left') || look('perch-point-left', 225, 320) || (aim && { ...aim, state: 'perch-point-left' }) || still('perch-point-left', 320);
  out['perch-point-right'] = own('perch-point-right') || look('perch-point-right', 135, 320) || (aim && { ...aim, state: 'perch-point-right' }) || still('perch-point-right', 320);
  out.sleep = own('sleep') || still('sleep', 1500);
  const wave = timed('wave');
  out['high-five'] = own('high-five') || (wave && { ...pick('high-five', 'wave', wave, { loop: false }), own: false }) || from('high-five', base.success, { loop: false });
  out['perch-wait'] = own('perch-wait') || from('perch-wait', base['waiting-approval']);
  out.startle = own('startle') || (base.error.source === 'error' ? from('startle', base.error, { columns: Array.from({ length: Math.min(2, base.error.frames) }, (_, i) => base.error.start + i),
    ms: [70, 110].slice(0, Math.min(2, base.error.frames)), loop: false }) : still('startle', 180));
  for (const [state, heading] of [['running-right', 90], ['running-left', 270]]) {
    const run = timed(state), move = resolveCharacterStates(m, { heading, distance: 100 }).find(s => s.state === 'move');
    out[state] = run ? { ...pick(state, state, run), own: true } : from(state, move);
  }
  out.error = from('error', base.error, { loop: false }); out.handoff = from('handoff', base.handoff, { loop: false });
  // A1's paused pose (C1). Without its own art: waiting-approval once, without a pulse, holding its last cell.
  out.paused = own('paused') || (base['waiting-approval'].source !== 'idle' ? from('paused', base['waiting-approval'], { loop: false }) : still('paused', 1200));
  return { anchor: m.perch?.anchor ?? m.anchor, states: out };
}

export function loadCharacter(folder, { uid = process.getuid(), shared = false, expectedId = basename(resolve(folder)), installed = false, io = fs, builtin = false } = {}) {
  const snap = snapshot(folder, uid, installed, io, builtin);
  if (!snap.files.has('character.json')) fail('character.json missing', 'manifest', join(folder, 'character.json'));
  return { ...snap, ...validateManifest(parseCharacterJSON(snap.files.get('character.json')), snap.files, { expectedId, shared }) };
}

function codexManifest(pet, sheet) {
  if (!object(pet) || pet.spriteVersionNumber !== undefined && ![1, 2].includes(pet.spriteVersionNumber)) fail('Codex pet spriteVersionNumber must be omitted, 1 or 2', 'spriteVersionNumber', 'pet.json');
  const version = pet.spriteVersionNumber === undefined ? 1 : pet.spriteVersionNumber;
  text(pet.id, 'id', 1, 48, 'pet.json');
  if (!/^[A-Za-z0-9_ -]+$/.test(pet.id)) fail('invalid Codex pet id', 'id', 'pet.json');
  const slug = pet.id.toLowerCase().replace(/[^a-z0-9-]/g, '-'); idCheck(slug, 'pet.json');
  text(pet.displayName, 'displayName', 1, 60, 'pet.json'); text(pet.description ?? '', 'description', 0, 200, 'pet.json');
  const timed = (row, frames, ms, loop = true, start = 0) => ({ row, frames, ms, loop, ...start ? { start } : {} });
  return { format: 'sleight-character', version: 1, id: slug, name: slug === pet.id ? pet.displayName : pet.id, description: pet.description ?? '', author: pet.author ?? 'Local import', license: pet.license ?? 'unknown', sheet,
    // Scale 0.5: a 192x208 Codex cell draws as 96x104 pt beside the ring (sleight-arch, 2026-10-26).
    frame: { w: 192, h: 208 }, grid: { cols: 8, rows: version === 1 ? 9 : 11 }, scale: 0.5, anchor: { x: 96, y: 196 }, hotspot: { x: 96, y: 104 },
    states: { idle: timed(0, 6, [280, 110, 110, 140, 140, 320]),
      ...version === 2 ? { move: { dir16: { rowA: 9, rowB: 10 } }, aim: timed(9, 1, 160, false, 4), look: { dir16: { rowA: 9, rowB: 10 } } } : {},
      click: timed(4, 3, 140, false, 1), type: timed(7, 6, [120, 120, 120, 120, 120, 220]),
      'waiting-approval': timed(6, 6, [150, 150, 150, 150, 150, 260]), error: timed(5, 8, [140, 140, 140, 140, 140, 140, 140, 240], false),
      thinking: timed(8, 6, [150, 150, 150, 150, 150, 280]), success: timed(3, 4, [140, 140, 140, 280], false),
      'running-right': timed(1, 8, [120, 120, 120, 120, 120, 120, 120, 220]), 'running-left': timed(2, 8, [120, 120, 120, 120, 120, 120, 120, 220]),
      wave: timed(3, 4, [140, 140, 140, 280], false),
      'right-click': { fallback: 'wave' }, working: { fallback: 'type' } },
    codex: { spriteVersionNumber: version, importedFrom: pet.id } };
}

export const BUILTIN_CHARACTER_IDS = Object.freeze(['tsugi', 'shizu', 'bit', 'kit', 'yori', 'tab']);
export const builtinCharactersDirectory = () => fileURLToPath(new URL('../../characters/', import.meta.url)).replace(/\/$/, '');
const reservedId = id => { if (BUILTIN_CHARACTER_IDS.includes(id)) fail('built-in character id is reserved; choose a different id', 'id'); };
export function checkBuiltinCharacter(id, { builtinRoot = builtinCharactersDirectory(), uid = process.getuid() } = {}) {
  if (!BUILTIN_CHARACTER_IDS.includes(id)) fail('unknown built-in character id', 'id');
  if (!isAbsolute(builtinRoot) || resolve(builtinRoot) !== builtinRoot) fail('built-in root must be an absolute canonical path', 'directory', builtinRoot);
  safeDirectory(builtinRoot, uid);
  const pins = parseCharacterJSON(readSafe(join(builtinRoot, 'manifest.json'), CHARACTER_LIMITS.json - 1, uid, false, fs, true));
  const expected = pins.version === 1 && pins.packs?.[id];
  const pack = loadCharacter(join(builtinRoot, id), { uid, shared: true, builtin: true });
  if (!object(expected) || Object.keys(expected).sort().join() !== [...pack.files.keys()].sort().join() ||
      [...pack.files].some(([name, bytes]) => createHash('sha256').update(bytes).digest('hex') !== expected[name])) fail('built-in hash mismatch; pack skipped', 'hash', id);
  return { ...pack, builtin: true };
}
export function builtinCharacterDoctorLines(options) {
  return BUILTIN_CHARACTER_IDS.flatMap(id => {
    try { checkBuiltinCharacter(id, options); return []; }
    catch (error) { return [`PROBLEM   built-in character ${id} skipped: ${error.message}`]; }
  });
}

export function prepareCharacterImport(folder, { uid = process.getuid(), shared = false } = {}) {
  if (typeof folder === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(folder.trim())) fail('sleight never fetches character URLs; download the files yourself and import their local folder', 'source');
  folder = fileOperation(folder, 'source', () => fs.realpathSync(folder));
  const snap = snapshot(folder, uid);
  if (snap.files.has('character.json')) {
    const result = { ...snap, ...validateManifest(parseCharacterJSON(snap.files.get('character.json')), snap.files, { shared: true }) };
    reservedId(result.manifest.id); return result;
  }
  if (!snap.files.has('pet.json')) fail('character.json or Codex pet.json required', 'entries', folder);
  const pet = parseCharacterJSON(snap.files.get('pet.json'), 'pet.json');
  if (!object(pet)) fail('Codex manifest must be an object', 'manifest', 'pet.json');
  plainData(pet, '', 'pet.json'); filename(pet.spritesheetPath, 'spritesheetPath', 'pet.json');
  const ext = extname(pet.spritesheetPath); if (!['.png', '.webp'].includes(ext) || !snap.files.has(pet.spritesheetPath)) fail('Codex sheet missing or invalid', 'spritesheetPath', 'pet.json');
  for (const name of snap.files.keys()) if (!['pet.json', pet.spritesheetPath, 'LICENSE.txt', 'preview.png'].includes(name)) fail('extra Codex character file refused', 'entry', name);
  const sheet = `sheet${ext}`, m = codexManifest(pet, sheet); reservedId(m.id);
  const files = new Map([[sheet, snap.files.get(pet.spritesheetPath)]]);
  for (const name of ['LICENSE.txt', 'preview.png']) if (snap.files.has(name)) files.set(name, snap.files.get(name));
  files.set('character.json', Buffer.from(JSON.stringify(m, null, 2) + '\n'));
  const total = [...files.values()].reduce((n, b) => n + b.length, 0); if (total > CHARACTER_LIMITS.total) fail('total character size exceeds 16 MiB');
  return { folder: snap.folder, files, total, ...validateManifest(m, files, { shared, sourceFile: 'pet.json' }) };
}

// Renderers always use the user's storage. Only the CLI has an explicit test-root switch.
export const charactersDirectory = () => join(userInfo().homedir, 'Library/Application Support/sleight/characters');
function storage(root, uid, create = false, io = fs) {
  if (!isAbsolute(root) || resolve(root) !== root) fail('character storage path must be absolute and normalized', 'root', root);
  if (create && !io.existsSync(root)) {
    // Check the nearest existing parent before creating descendants. /tmp aliases are not accepted.
    let parent = dirname(root); while (!io.existsSync(parent)) parent = dirname(parent);
    if (fileOperation(parent, 'directory', () => io.realpathSync(parent)) !== parent) fail('symlink storage parent refused', 'directory', parent);
    fileOperation(root, 'directory', () => io.mkdirSync(root, { recursive: true, mode: 0o700 }));
  }
  return safeDirectory(root, uid, { privateMode: true, io });
}
export function installCharacter(character, { root = charactersDirectory(), uid = process.getuid(), io = fs } = {}) {
  // Revalidate the captured data, not a source folder which may have changed during confirmation.
  const files = new Map([...character.files].map(([name, bytes]) => [name, Buffer.from(bytes)]));
  const m = parseCharacterJSON(files.get('character.json')); validateManifest(m, files); reservedId(m.id);
  if ([...files.values()].reduce((n, b) => n + b.length, 0) > CHARACTER_LIMITS.total) fail('total character size exceeds 16 MiB');
  root = storage(root, uid, true, io); const target = join(root, m.id);
  if (io.existsSync(target)) fail('character already exists; remove it first', 'directory', target);
  // A crash can leave unpublished data. Sweep only old, private, owned staging folders.
  for (const entry of fileOperation(root, 'entries', () => io.readdirSync(root)).filter(name => name.startsWith('.import-'))) {
    const path = join(root, entry), stat = fileOperation(path, 'directory', () => io.lstatSync(path));
    if (stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o7777) === 0o700 && Date.now() - stat.mtimeMs > 60_000) {
      safeDirectory(path, uid, { privateMode: true, io }); fileOperation(path, 'directory', () => io.rmSync(path, { recursive: true }));
    }
  }
  const staging = fileOperation(root, 'staging', () => io.mkdtempSync(join(root, '.import-')));
  fileOperation(staging, 'directory', () => io.chmodSync(staging, 0o700));
  try {
    for (const [name, bytes] of files) { filename(name, 'entry', staging); fileOperation(join(staging, name), 'file', () => io.writeFileSync(join(staging, name), bytes, { flag: 'wx', mode: 0o600 })); }
    loadCharacter(staging, { uid, expectedId: m.id, installed: true });
    storage(root, uid, false, io);
    if (io.existsSync(target)) fail('character already exists; remove it first', 'directory', target);
    fileOperation(target, 'directory', () => io.renameSync(staging, target));
  } catch (error) { fileOperation(staging, 'directory', () => io.rmSync(staging, { recursive: true, force: true })); throw error; }
  return target;
}
export function listCharacters({ root = charactersDirectory(), uid = process.getuid(), builtins = true, builtinRoot = builtinCharactersDirectory() } = {}) {
  const bundled = builtins ? BUILTIN_CHARACTER_IDS.map(id => {
    try { return checkBuiltinCharacter(id, { builtinRoot, uid }); }
    catch (error) { return { id, builtin: true, error: error.message }; }
  }) : [];
  try { storage(root, uid); } catch (error) { if (error.code === 'ENOENT') return bundled; throw error; }
  return [...bundled, ...fileOperation(root, 'entries', () => fs.readdirSync(root)).filter(name => !name.startsWith('.import-')).sort().map(id => {
    const folder = join(root, id);
    if (BUILTIN_CHARACTER_IDS.includes(id)) return { id, skipped: true, reason: `built-in id collision; renamed needed; rename the user pack or run sleight-mcp cursor remove ${id}` };
    try {
      const stat = fileOperation(folder, 'directory', () => fs.lstatSync(folder));
      if (!stat.isSymbolicLink() && (!stat.isDirectory() || !/^[a-z0-9-]{1,48}$/.test(id))) return { id, skipped: true, reason: 'not a character folder' };
      if (stat.isSymbolicLink()) fail('symlink character directory refused; remove the link by hand (leave its target)', 'directory', folder);
      idCheck(id); return loadCharacter(folder, { uid, installed: true });
    } catch (error) { return { id, error: error.message }; }
  })];
}
export function checkCharacter(id, { root = charactersDirectory(), uid = process.getuid(), builtinRoot = builtinCharactersDirectory() } = {}) {
  idCheck(id);
  if (BUILTIN_CHARACTER_IDS.includes(id)) return checkBuiltinCharacter(id, { builtinRoot, uid });
  storage(root, uid); return loadCharacter(join(root, id), { uid, installed: true });
}
const lexists = path => { try { fs.lstatSync(path); return true; } catch { return false; } };
export function removeCharacter(id, { root = charactersDirectory(), uid = process.getuid() } = {}) {
  if (BUILTIN_CHARACTER_IDS.includes(id) && (resolve(root) === builtinCharactersDirectory() || !lexists(join(root, id)))) fail('built-in character cannot be removed', 'id');
  if (typeof id !== 'string' || !id || id === '.' || id === '..' || /[/\\\u0000-\u001f\u007f]/u.test(id)) fail('invalid character id for removal', 'id', String(id));
  storage(root, uid); const folder = join(root, id), stat = fileOperation(folder, 'directory', () => fs.lstatSync(folder));
  if (stat.isSymbolicLink() || fileOperation(folder, 'directory', () => fs.realpathSync(folder)) !== folder) fail('symlink character directory refused; remove the link by hand (leave its target)', 'directory', folder);
  if (!stat.isDirectory()) return false;
  if (stat.uid !== uid) fail('directory owner must be current user', 'directory', folder);
  // rm does not follow child symlinks. A broken manifest or mode must not trap an installed character.
  fileOperation(folder, 'directory', () => fs.rmSync(folder, { recursive: true })); return true;
}
export function characterCallout(character, { installed = false } = {}) {
  const { manifest: m, resolved, total, warnings } = character, own = resolved.filter(s => s.own).length;
  const noun = m.codex ? 'pet' : 'character';
  const labels = { idle: 'resting', move: 'moving', aim: 'aiming', click: 'clicking', 'double-click': 'double-clicking',
    'right-click': 'right-clicking', type: 'typing', key: 'key press', 'scroll-up': 'scrolling up', 'scroll-down': 'scrolling down',
    'drag-grab': 'grabbing', 'drag-carry': 'carrying', 'drag-drop': 'dropping', 'waiting-approval': 'waiting', error: 'error',
    success: 'celebrating', thinking: 'thinking', handoff: 'handing back', working: 'working',
    'running-right': 'running right', 'running-left': 'running left', look: 'looking', poke: 'poking', wave: 'waving' };
  const codexRows = { 0: 'resting', 1: 'running right', 2: 'running left', 3: 'waving', 4: 'jumping', 5: 'failed', 6: 'waiting', 7: 'running', 8: 'reviewing', 9: 'looking', 10: 'looking' };
  const missing = resolved.filter(s => !s.own).map(s => {
    const art = m.codex && s.sheet === m.sheet ? codexRows[s.row] : labels[s.source];
    const effects = [s.repeat === 2 && 'played twice', s.state === 'key' && s.frames < 4 && `first ${s.frames} frames`,
      s.state === 'drag-grab' && `first ${s.frames} frames`, m.codex && s.state === 'drag-drop' && s.row === 4 && 'landing frames',
      s.holdLast && 'holding the last frame', s.look && (s.state === 'scroll-up' ? 'looking up' : 'looking down'),
      s.then === 'idle' && 'then rests', s.effect && (s.effect === 'red-pulse' ? 'plus a red pulse' : 'plus a pulse')].filter(Boolean);
    return `${s.label}: uses its ${art} animation${effects.length ? ', ' + effects.join(', ') : ''}`;
  });
  return [own === resolved.length ? `This ${noun} has its own animation for all ${own} of sleight's moves.`
    : `This ${noun} has its own animation for ${own} of sleight's ${resolved.length} moves. To animate all of them it needs ${resolved.length - own} more:`,
    ...missing, ...m.codex?.spriteVersionNumber === 1 ? ['The original 9-row atlas has no look directions. Without extra art it uses Running left or right while moving and idle while aiming.'] : [],
    `Character: ${m.name}`, `Size: ${total} bytes`, `License: ${m.license === 'unknown' ? 'not stated' : m.license}`,
    ...warnings.map(w => `Warning: ${w}`), ...installed ? [] : ['Your source files are not changed. sleight copies them.'],
    'To add animations, draw an extra.webp sheet; see docs/design/character-format.md.'].join('\n') + '\n';
}
