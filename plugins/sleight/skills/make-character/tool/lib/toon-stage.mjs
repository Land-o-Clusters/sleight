// ST1 section 2.2 has 20 rows, including startle; ST3's loader adds stage-think (front-sit), so 21. These are data for the toon art,
// not placement or permission logic. The host decides where and when they play.
// The 2x source scale is one reversible constant pending ST2's resolution review.
import { neutral, merge, CLIPS, PERCH_CLIPS } from './poses.mjs';
export const TOON_STAGE_SCALE = 2;
const from = (name, i, ctx) => {
  const c = [...CLIPS, ...PERCH_CLIPS].find(c => c.name === name);
  return c.pose(i % c.frames, ctx);
};
const p = over => merge(neutral(), over);
const clip = (name, ms, loop, source, extra = {}) => ({
  name: `stage-${name}`, frames: ms.length, ms, loop, ...extra,
  pose: (i, ctx) => ({ ...from(source, i, ctx), ...extra.pose?.(i, ctx), clip: `stage-${name}`, frame: i }),
});
export const STAGE_TOON_CLIPS = [
  clip('lie', [400, 120, 200, 200, 500, 400], true, 'perch', { wide: true }),
  clip('lie-reach', [90, 120, 90, 200], false, 'click', { wide: true }),
  clip('lie-peek', [1400, 400], true, 'perch-peek', { wide: true }),
  clip('sleep', [1500, 1500], true, 'sleep', { wide: true }),
  clip('sit', [400, 300, 300, 400], true, 'perch'),
  clip('sit-notes', [160, 160, 160, 160, 160, 160], true, 'type'),
  clip('think', [600, 400, 600, 400], true, 'thinking'),
  clip('wait', [900, 500, 900, 500], true, 'perch-wait'),
  clip('cheer', [90, 420, 200], false, 'high-five'),
  clip('hang', [400, 300, 300, 400], true, 'perch'),
  clip('hang-peek', [1400, 400], true, 'perch-peek'),
  clip('climb', [110, 110, 110, 110, 110, 110], true, 'running-right'),
  clip('stand', [280, 110, 110, 140, 140, 320], true, 'idle'),
  clip('point', [70, 90, 320], false, 'aim'),
  clip('carry', [110, 110, 110, 110], true, 'drag-carry'),
  clip('wince', [60, 80, 120, 300], false, 'error'),
  clip('handoff', [120, 140, 160, 400], false, 'handoff'),
  clip('paused', [90, 90, 90, 1200, 1200], true, 'perch', { pose: i => p({ seated: true, head: { pitch: 0.2 }, face: { eyes: i === 4 ? 'half' : 'open' } }) }),
  clip('leap', [70, 120, 160, 70, 160], false, 'jumping'),
  clip('run', [110, 110, 110, 110, 110, 110, 110, 110], true, 'running-right'),
  clip('startle', [70, 110], false, 'startle'),
];
