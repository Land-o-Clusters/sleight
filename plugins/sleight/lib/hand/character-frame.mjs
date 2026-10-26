// The hand host's character frame, from VC3's installed snapshot (loadCharacter(folder, { installed: true })). It reads no
// files and decodes nothing. The caller passes VC3's resolveCharacterStates as `resolve`, so this module has no import of
// character.mjs.
import { isAbsolute, join } from 'node:path';

// The host's caps: 8 columns of at most 192 px, 11 rows of at most 208 px (13.4 MiB decoded per sheet).
export const SPRITE_LIMITS = Object.freeze({ sheet: Object.freeze({ width: 1536, height: 2288 }), cell: Object.freeze({ width: 192, height: 208 }) });
// R3 1.4: horizontal glides over 60 px play the running rows. 100 is any distance past that threshold.
const FAR = 100;

/** Build once after host spawn, using the host's nonce and shared increasing sequence counter. Throws when the host would
 * refuse the character's size, so the wizard and the doctor can say so. */
export function characterFrame(character, { nonce, seq, resolve }) {
  const { manifest: m, folder, sheets } = character;
  if (!/^[0-9a-f]{64}$/.test(nonce) || !Number.isSafeInteger(seq) || seq < 0 || !isAbsolute(folder)) throw Error('Invalid character frame identity');
  if (typeof resolve !== 'function') throw Error('characterFrame needs VC3 resolveCharacterStates as resolve');
  const { sheet: capSheet, cell: capCell } = SPRITE_LIMITS;
  if (m.frame.w > capCell.width || m.frame.h > capCell.height) throw Error(`Character cells over ${capCell.width}x${capCell.height} are too large to draw`);
  for (const s of Object.values(sheets)) {
    if (s.width > capSheet.width || s.height > capSheet.height) throw Error(`Character sheets over ${capSheet.width}x${capSheet.height} are too large to draw`);
  }
  const key = s => s.sheet === m.extra ? 'extra' : 'sheet';
  const lookSheet = m.states.look?.sheet === 'extra' ? 'extra' : 'sheet';
  const entry = s => {
    const size = [sheets[key(s)].width, sheets[key(s)].height];
    // A scroll state without its own art shows the look pose up (scroll-up) or down (scroll-down).
    if (s.look) {
      return { sheet: lookSheet, row: s.look.row, frames: [s.look.start], ms: [160], loop: false, flip: s.flip === 'h',
        hotspot: [s.hotspot.x, s.hotspot.y], size: [sheets[lookSheet].width, sheets[lookSheet].height], scale: m.scale };
    }
    return { sheet: key(s), row: s.row,
      // Explicit columns preserve imported starts and double-click repeats without copying the atlas.
      frames: Array.from({ length: s.frames * (s.repeat ?? 1) }, (_, i) => s.start + i % s.frames),
      ms: Array.from({ length: s.frames * (s.repeat ?? 1) }, (_, i) => s.ms[i % s.frames]),
      loop: s.loop, flip: s.flip === 'h', hotspot: [s.hotspot.x, s.hotspot.y], size, scale: m.scale,
      ...s.then ? { then: s.then } : {} };
  };
  const table = Object.fromEntries(character.resolved.map(s => [s.state, entry(s)]));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Only direction-sensitive entries get variants. No JS runs on each glide.
  for (let direction = 0; direction < 16; direction++) {
    const heading = direction * 22.5, near = resolve(m, { heading }), far = resolve(m, { heading, distance: FAR });
    for (const s of near) {
      if (!['move', 'aim', 'drag-carry'].includes(s.state)) continue;
      const value = entry(s);
      if (!same(value, table[s.state])) table[`${s.state}@${direction}`] = value;
      const travel = far.find(f => f.state === s.state);
      if (s.state !== 'aim' && travel && !same(entry(travel), value)) table[`${s.state}-far@${direction}`] = entry(travel);
    }
  }
  const frame = { hand: 'character', nonce, seq, id: m.id, sheet: join(folder, m.sheet), extra: m.extra ? join(folder, m.extra) : null,
    cell: [m.frame.w, m.frame.h], table };
  if (Buffer.byteLength(JSON.stringify(frame)) > 32768) throw Error('Character frame exceeds 32 KiB');
  return frame;
}
