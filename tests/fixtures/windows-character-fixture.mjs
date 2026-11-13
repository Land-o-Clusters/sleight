import { deflateSync } from 'node:zlib';
import { join } from 'node:path';

// Synthetic rectangles only. No vendor artwork or character pack is included.
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ crc >>> 1 : crc >>> 1; }
  const size = Buffer.alloc(4), end = Buffer.alloc(4); size.writeUInt32BE(data.length); end.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, body, end]);
}
export function fixturePng({ width = 512, height = 192, opaque = false } = {}) {
  const bytes = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 4 + 1) + 1 + x * 4;
    if (opaque || x % 64 < 10 && y % 64 < 8) { bytes[offset] = 160; bytes[offset + 1] = 80; bytes[offset + 2] = 240; bytes[offset + 3] = 255; }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(bytes)), chunk('IEND', Buffer.alloc(0))]);
}
export function characterFrame(root) {
  const entry = (row, frames, extra = {}) => ({ sheet: 'sheet', row, frames, ms: frames.map(() => 100), loop: true, flip: false, hotspot: [32, 32], size: [512, 192], scale: .5, ...extra });
  return { hand: 'character', nonce: 'a'.repeat(64), seq: 0, id: 'fixture', sheet: join(root, 'fixture', 'sheet.png'), extra: null, cell: [64, 64], table: {
    idle: entry(0, [0, 1]), move: entry(1, [0, 1]), 'move-far@4': entry(2, [0, 1, 2, 3], { flip: true }),
    aim: entry(1, [2]), click: entry(2, [4, 5], { loop: false }), type: entry(1, [6, 7]),
    'drag-grab': entry(2, [0]), 'drag-carry': entry(2, [1, 2]), 'drag-drop': entry(2, [3], { loop: false }),
    'waiting-approval': entry(0, [2, 3]), success: entry(1, [2, 3], { loop: false }),
    handoff: entry(2, [4, 5], { loop: false, then: 'idle' }),
  } };
}
export function spriteCases(root) {
  const f = characterFrame(root), base = { nonce: f.nonce, pid: 2147483647, windowId: 4294967295 };
  const act = (seq, kind, extra = {}) => ({ hand: 'act', ...base, seq, kind, at: [100, 100], path: [[100, 100]], delayMs: 0, beats: 3, ...extra });
  const frames = [f, { dumpAwait: 'character' }, act(1, 'click'), { dumpClock: 1 },
    { hand: 'aim', ...base, seq: 2, kind: 'click', at: [400, 100] }, { dumpClock: 2 },
    act(3, 'drag', { at: [400, 100], path: [[400, 100], [600, 300]], rect: [380, 90, 80, 30] }),
    { dumpClock: 3 }, { hand: 'status', ...base, seq: 4, state: 'waiting' },
    { dumpClock: 8 }, { hand: 'status', ...base, seq: 5, state: 'handback' }];
  return [
    ...Array.from({length: 16}, (_, i) => {
      const angle = (11.25 + 22.5 * i) * Math.PI/180;
      return { name: 'sprite-direction-' + i, flags: ['--cursor-style=sprite', '--seed=7'], frames: [f, {dumpAwait: 'character'},
        act(1,'click',{at:[500,500],path:[[500,500]]}), {dumpClock: 1},
        {hand:'aim', ...base, seq: 2, kind:'click', at:[500+200*Math.sin(angle),500-200*Math.cos(angle)]}] };
    }),
    { name: 'sprite-states', flags: ['--cursor-style=sprite', '--seed=7'], frames },
    { name: 'sprite-reduced', flags: ['--cursor-style=sprite', '--seed=7', '--reduce-motion'], frames },
  ];
}
