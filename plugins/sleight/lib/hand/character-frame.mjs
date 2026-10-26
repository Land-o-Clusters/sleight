// VC3 supplies the validated installed snapshot. This adapter does no file reads or image decoding.
import { resolveCharacterStates } from './character.mjs';
import { isAbsolute, join } from 'node:path';

/** Build once after host spawn, using the host's nonce and shared increasing sequence counter. */
export function characterFrame(character, { nonce, seq }) {
  const { manifest: m, folder, sheets } = character;
  if (!/^[0-9a-f]{64}$/.test(nonce) || !Number.isSafeInteger(seq) || seq < 0 || !isAbsolute(folder)) throw Error('Invalid character frame identity');
  const entry = s => ({
    sheet: s.sheet === m.extra ? 'extra' : 'sheet', row: s.row,
    // Explicit columns preserve imported starts and double-click repeats without copying the atlas.
    frames: Array.from({ length: s.frames * (s.repeat ?? 1) }, (_, i) => s.start + i % s.frames),
    ms: Array.from({ length: s.frames * (s.repeat ?? 1) }, (_, i) => s.ms[i % s.frames]),
    loop: s.loop, flip: s.flip === 'h', hotspot: [s.hotspot.x, s.hotspot.y],
    size: [sheets[s.sheet === m.extra ? 'extra' : 'sheet'].width, sheets[s.sheet === m.extra ? 'extra' : 'sheet'].height],
    scale: m.scale,
  });
  const table = Object.fromEntries(character.resolved.map(s => [s.state, entry(s)]));
  // Only direction-sensitive entries get variants. No JS runs on each glide.
  for (let direction = 0; direction < 16; direction++) {
    for (const s of resolveCharacterStates(m, { heading: direction * 22.5 })) {
      if (!['move', 'aim', 'drag-carry'].includes(s.state)) continue;
      const value = entry(s);
      if (JSON.stringify(value) !== JSON.stringify(table[s.state])) table[`${s.state}@${direction}`] = value;
    }
  }
  const frame = { hand: 'character', nonce, seq, id: m.id, sheet: join(folder, m.sheet), extra: m.extra ? join(folder, m.extra) : null,
    cell: [m.frame.w, m.frame.h], table };
  if (Buffer.byteLength(JSON.stringify(frame)) > 32768) throw Error('Character frame exceeds 32 KiB');
  return frame;
}
