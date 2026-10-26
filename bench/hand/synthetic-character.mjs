// A synthetic character for the agent cursor's live checks (VC7): one PNG sheet of 8 cells in one row, drawn here, so the
// sprite style runs without any pet or vendor art. It installs into a temporary characters root under the host's test
// override (SLEIGHT_CURSOR_TEST=1 with SLEIGHT_CURSOR_CHARACTERS_ROOT under /private/tmp/, consent-host.swift
// SpriteCharacter.root), never into ~/Library/Application Support/sleight/characters.
//
// The host's checks (VC4R, SpriteCharacter.decode): the root and the character folder are directories owned by this user
// without group or other write; the sheet is a regular file, mode 0600, one link, at most 8 MiB, named sheet.png; its width
// is 8 cells and its height a whole number of cells; every used cell has at least 50 visible pixels and under 95% opaque
// ones, and no green-dominant pixel (that warns as a chroma fringe). The paint is magenta and orange, saturated so
// pixels.mjs's cursorColoured rule sees it.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

export const SYNTHETIC_ID = 'vc7-synthetic';
export const CELL = Object.freeze({ width: 128, height: 128 });
const MAGENTA = [214, 38, 196], ORANGE = [255, 122, 61];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
/** A non-interlaced 8-bit RGBA PNG (colour type 6) of straight-alpha pixels. */
export function encodePng(width, height, rgba) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || rgba.length !== width * height * 4) {
    throw new Error('encodePng needs width * height * 4 bytes');
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** The sheet's pixels: in cell i, a magenta ring (radius 40, 10 px wide) with an orange dot orbiting it by i/8 of a turn. */
export function syntheticSheet({ cell = CELL, frames = 8 } = {}) {
  const width = cell.width * 8, height = cell.height, data = new Uint8Array(width * height * 4);
  const paint = (x, y, [r, g, b], a = 255) => data.set([r, g, b, a], (y * width + x) * 4);
  for (let i = 0; i < frames; i++) {
    const cx = i * cell.width + cell.width / 2, cy = cell.height / 2;
    const angle = (i / frames) * 2 * Math.PI, dx = cx + Math.cos(angle) * 40, dy = cy + Math.sin(angle) * 40;
    for (let y = 0; y < cell.height; y++) {
      for (let x = i * cell.width; x < (i + 1) * cell.width; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (Math.hypot(x + 0.5 - dx, y + 0.5 - dy) <= 12) paint(x, y, ORANGE);
        else if (d >= 35 && d <= 45) paint(x, y, MAGENTA);
      }
    }
  }
  return { width, height, data };
}

/** Each cell's visible and opaque pixel counts and its green-dominant count, the host's ink check. */
export function cellInk(sheet, cell = CELL) {
  const cells = [];
  for (let col = 0; col < sheet.width / cell.width; col++) {
    let visible = 0, opaque = 0, green = 0;
    for (let y = 0; y < cell.height; y++) {
      for (let x = col * cell.width; x < (col + 1) * cell.width; x++) {
        const p = (y * sheet.width + x) * 4, a = sheet.data[p + 3];
        if (a > 0) visible++;
        if (a === 255) opaque++;
        if (a > 0 && sheet.data[p + 1] > 100 && sheet.data[p + 1] > sheet.data[p] * 2 && sheet.data[p + 1] > sheet.data[p + 2] * 2) green++;
      }
    }
    cells.push({ visible, opaque, green, total: cell.width * cell.height });
  }
  return cells;
}

/** Writes the root (0700), the character folder (0700) and sheet.png (0600). root is a new folder under /private/tmp. */
// VC7_CHARACTERS_BASE: the night runner's own folder under /private/tmp, which its sweep removes.
export function installSyntheticCharacter({ base = process.env.VC7_CHARACTERS_BASE || '/private/tmp', id = SYNTHETIC_ID } = {}) {
  if (base !== '/private/tmp' && !base.startsWith('/private/tmp/')) throw new Error('the characters base must be under /private/tmp');
  const root = realpathSync(mkdtempSync(join(base, 'sleight-vc7-characters-')));
  if (!root.startsWith('/private/tmp/')) throw new Error('the characters root must be under /private/tmp (the host\'s test override)');
  chmodSync(root, 0o700);
  const folder = join(root, id);
  mkdirSync(folder, { mode: 0o700 });
  chmodSync(folder, 0o700);
  const sheet = syntheticSheet();
  const path = join(folder, 'sheet.png');
  writeFileSync(path, encodePng(sheet.width, sheet.height, sheet.data), { mode: 0o600 });
  chmodSync(path, 0o600);
  return { root, folder, id, sheet: path, cell: CELL };
}

/** The host's character frame (VC4 spriteFrame: exact keys). The idle row loops all 8 cells; other states fall back to it. */
export function characterWire({ id = SYNTHETIC_ID, sheet, cell = CELL }, { nonce, seq }) {
  if (!/^[0-9a-f]{64}$/.test(nonce) || !Number.isSafeInteger(seq) || seq < 0) throw new Error('bad nonce or seq');
  if (typeof sheet !== 'string' || !sheet.startsWith('/')) throw new Error('the sheet path must be absolute');
  return { hand: 'character', nonce, seq, id, sheet, extra: null, cell: [cell.width, cell.height],
    table: { idle: { sheet: 'sheet', row: 0, frames: 8, ms: 120, loop: true, flip: false, hotspot: [cell.width / 2, cell.height / 2], scale: 0.5 } } };
}

/** The environment the host reads the temporary root from. */
export const characterEnv = root => ({ SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: root });
