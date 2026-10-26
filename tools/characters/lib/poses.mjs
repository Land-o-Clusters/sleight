// Skeletal poses for every state, shared by all styles. A style turns one pose into one SVG cell.
//
// Coordinates are cell pixels (192 x 208), feet on y = 196 at x = 96 (the manifest anchor).
// Sides: "l" is the viewer's left (the warm side, like the icon's lower-left hand), "r" the viewer's right (cool).
// Arm angles: a = shoulder angle from hanging straight down, positive swings outward and up (90 = sideways, 180 = up,
// negative crosses the body). b = elbow bend added to a for the forearm. Legs: a = absolute angle, positive toward the
// viewer's right; lift 0..1 raises the foot.
// Head: tilt in degrees, turn -1..1 (positive faces the viewer's right), pitch -1..1 (negative looks up).
// ctx.E scales motion (energy): 1 for a bouncy character, about 0.6 for a calm one.

export const CELL = { w: 192, h: 208 };

export function neutral() {
  return {
    x: 0, y: 0, sx: 1, sy: 1, lean: 0,
    head: { tilt: 0, turn: 0, pitch: 0, dx: 0, dy: 0 },
    arms: { l: { a: 14, b: 10, hand: 'mitten' }, r: { a: 14, b: 10, hand: 'mitten' } },
    legs: { l: { a: -3, lift: 0 }, r: { a: 3, lift: 0 } },
    face: { eyes: 'open', look: [0, 0], brows: 'neutral', mouth: 'smile', blush: 1 },
    props: [], fx: [],
  };
}
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
export function merge(a, b) {
  const o = structuredClone(a);
  for (const [k, v] of Object.entries(b ?? {})) o[k] = isObj(v) && isObj(o[k]) ? merge(o[k], v) : structuredClone(v);
  return o;
}
const P = over => merge(neutral(), over);
const S = (i, n) => Math.sin(i / n * 2 * Math.PI), C = (i, n) => Math.cos(i / n * 2 * Math.PI);

/** Mirror a pose left-right without mirroring the art: the warm side stays on the viewer's left. */
export function mirror(p) {
  const m = structuredClone(p);
  m.x = -p.x; m.lean = -p.lean; m.head.tilt = -p.head.tilt; m.head.turn = -p.head.turn; m.head.dx = -p.head.dx;
  m.arms = { l: p.arms.r, r: p.arms.l };
  m.legs = { l: { ...p.legs.r, a: -p.legs.r.a }, r: { ...p.legs.l, a: -p.legs.l.a } };
  const e = p.face.eyes; m.face.eyes = typeof e === 'object' ? { l: e.r, r: e.l } : e;
  m.face.look = [-p.face.look[0], p.face.look[1]];
  const flipAt = at => at?.replace(/\.(l|r)$/, (_, s) => s === 'l' ? '.r' : '.l');
  m.fx = p.fx.map(x => ({ ...x, at: flipAt(x.at), x: x.x !== undefined ? 192 - x.x : undefined, dx: x.dx !== undefined ? -x.dx : undefined, rot: x.rot !== undefined ? -x.rot : undefined, flip: !x.flip }));
  m.props = p.props.map(x => ({ ...x, x: x.x !== undefined ? 192 - x.x : undefined, rot: x.rot !== undefined ? -x.rot : undefined }));
  return m;
}

// ---------- clips: one row slice each ----------
// sheet: "sheet" (Codex v2 compatible main atlas) or "extra". states: the manifest state names that use the clip.

const run = (i, ctx, dir = 1) => {
  const n = 8, s = S(i, n), e = ctx.E, up = Math.abs(C(i, n));
  const p = P({
    y: -3.5 * e * up, sy: 1 + 0.025 * e * up, lean: 7 * e,
    head: { turn: 0.7, tilt: -2, pitch: 0.05 },
    arms: { l: { a: 22 + 38 * e * s, b: 70, hand: 'fist' }, r: { a: 22 + 38 * e * s, b: 70, hand: 'fist', behind: s < 0 } },
    legs: { l: { a: 30 * e * s, lift: Math.max(0, -s) * 0.6 }, r: { a: -30 * e * s, lift: Math.max(0, s) * 0.6 } },
    face: { eyes: 'open', look: [0.8, 0], brows: 'up', mouth: up > 0.7 ? 'grin' : 'smile' },
    fx: [{ type: 'speed', x: 50, y: 120 + 6 * s, n: 3 }],
  });
  return dir > 0 ? p : mirror(p);
};

// The 16 look/move poses. heading is clockwise from up.
export function lookPose(heading, ctx) {
  const t = heading * Math.PI / 180, vx = Math.sin(t), vy = -Math.cos(t), e = ctx.E;
  const p = P({
    y: -2 * e, lean: 6 * e * vx,
    head: { turn: 0.72 * vx, pitch: 0.55 * vy, tilt: -4 * vx * Math.max(0, -vy) },
    arms: { l: { a: 26 - 18 * vx * e, b: 26 }, r: { a: 26 + 18 * vx * e, b: 26 } },
    legs: { l: { a: -4 + 9 * vx, lift: vx > 0.3 ? 0.35 : 0 }, r: { a: 4 + 9 * vx, lift: vx < -0.3 ? 0.35 : (Math.abs(vx) <= 0.3 ? 0.3 : 0) } },
    face: { eyes: 'open', look: [vx, vy], brows: vy < -0.5 ? 'up' : 'neutral', mouth: vy > 0.6 ? 'o' : 'smile' },
  });
  return p;
}

export const CLIPS = [
  // ---------------- main sheet (Codex v2 rows) ----------------
  { name: 'idle', sheet: 'sheet', row: 0, frames: 6, ms: [280, 110, 110, 140, 140, 320], loop: true, states: ['idle'],
    pose: (i, ctx) => [
      P({}),
      P({ face: { eyes: 'half' } }),
      P({ face: { eyes: 'closed' }, sy: 0.995 }),
      P({ sy: 0.99, y: 0.5 }),
      P({ head: { tilt: 4 * ctx.E }, face: { look: [0.25, 0] }, arms: { l: { a: 16 }, r: { a: 12 } } }),
      P({ head: { tilt: 2 * ctx.E } }),
    ][i] },
  { name: 'neutral', sheet: 'sheet', row: 0, start: 6, frames: 1, ms: 200, loop: false, states: [], codexOnly: true, pose: () => P({}) },
  { name: 'running-right', sheet: 'sheet', row: 1, frames: 8, ms: [120, 120, 120, 120, 120, 120, 120, 220], loop: true, states: ['running-right'], pose: (i, ctx) => run(i, ctx, 1) },
  { name: 'running-left', sheet: 'sheet', row: 2, frames: 8, ms: [120, 120, 120, 120, 120, 120, 120, 220], loop: true, states: ['running-left'], pose: (i, ctx) => run(i, ctx, -1) },
  { name: 'wave', sheet: 'sheet', row: 3, frames: 4, ms: [140, 140, 140, 280], loop: false, states: ['wave'],
    pose: (i, ctx) => {
      const b = [16, 38, -6, 32][i], e = ctx.E;
      return P({ y: i === 1 ? -2 * e : 0, head: { tilt: -6 * e, turn: 0.1 },
        arms: { r: { a: i === 0 ? 100 : 112, b, hand: 'palm', front: true }, l: { a: 12, b: 14 } },
        face: { eyes: i >= 1 ? 'happy' : 'open', mouth: 'grin', brows: 'up' },
        fx: i >= 1 ? [{ type: 'motion', at: 'hand.r', dx: 8, dy: -2 }] : [] });
    } },
  // Aim points up and to the left, where the ring sits relative to the character box.
  { name: 'aim', sheet: 'sheet', row: 3, start: 4, frames: 4, ms: [70, 70, 90, 320], loop: false, states: ['aim'],
    pose: (i, ctx) => {
      const e = ctx.E, k = [0.35, 0.8, 1, 1][i];
      return P({ lean: -4 * e * k, x: -1.5 * k, head: { turn: -0.3 * k, pitch: -0.35 * k, tilt: 3 * k },
        arms: { l: { a: 60 + 75 * k, b: 40 - 40 * k, hand: k >= 1 ? 'point' : 'fist', front: true }, r: { a: 18, b: 20 } },
        face: { eyes: i >= 2 ? 'focus' : 'open', look: [-0.75, -0.7], brows: i >= 2 ? 'determined' : 'neutral', mouth: i >= 2 ? 'flat' : 'smile' },
        fx: i === 3 ? [{ type: 'twinkle', at: 'tip.l', dx: -5, dy: -5, s: 3.5 }] : [] });
    } },
  { name: 'jumping', sheet: 'sheet', row: 4, frames: 5, ms: [140, 140, 140, 140, 280], loop: false, states: [], codexOnly: true,
    pose: (i, ctx) => {
      const e = ctx.E;
      return [
        P({ sy: 0.9, sx: 1.05, arms: { l: { a: 30, b: 30 }, r: { a: 30, b: 30 } }, face: { eyes: 'focus', mouth: 'smile' } }),
        P({ y: -4 * e, sy: 1.02, sx: 0.99, arms: { l: { a: 150, b: 10 }, r: { a: 150, b: 10 } }, legs: { l: { lift: 0.4 }, r: { lift: 0.4 } }, face: { eyes: 'happy', mouth: 'grin' } }),
        P({ y: -8 * e, arms: { l: { a: 160, b: 0 }, r: { a: 160, b: 0 } }, legs: { l: { lift: 0.6, a: -10 }, r: { lift: 0.6, a: 10 } }, face: { eyes: 'happy', mouth: 'grin', brows: 'up' } }),
        P({ y: -5 * e, arms: { l: { a: 110, b: 20 }, r: { a: 110, b: 20 } }, legs: { l: { lift: 0.2 }, r: { lift: 0.2 } }, face: { eyes: 'open', mouth: 'open' } }),
        P({ sy: 0.92, sx: 1.04, arms: { l: { a: 40, b: 20 }, r: { a: 40, b: 20 } }, face: { eyes: 'happy', mouth: 'grin' } }),
      ][i];
    } },
  { name: 'failed', sheet: 'sheet', row: 5, frames: 8, ms: [140, 140, 140, 140, 140, 140, 140, 240], loop: false, states: [], codexOnly: true,
    pose: (i, ctx) => {
      const k = Math.min(1, i / 3), e = ctx.E;
      return P({ y: 2 * k, sy: 1 - 0.03 * k, head: { pitch: 0.35 * k, tilt: -5 * k * e },
        arms: { l: { a: 6, b: 4 }, r: { a: 6, b: 4 } },
        face: { eyes: i === 0 ? 'wide' : i >= 6 ? 'closed' : 'sad', brows: 'worried', mouth: i === 0 ? 'open' : 'wobble', look: [0, 0.4] },
        fx: [...i >= 2 ? [{ type: 'cloud', at: 'head', dx: 0, dy: -62 - (i % 2), s: 1 }] : [], ...i >= 3 ? [{ type: 'sweat', side: 'r' }] : []] });
    } },
  { name: 'waiting', sheet: 'sheet', row: 6, frames: 6, ms: [150, 150, 150, 150, 150, 260], loop: true, states: [], codexOnly: true,
    pose: (i, ctx) => {
      const s = S(i, 6), e = ctx.E;
      return P({ lean: 3 * e * s, head: { tilt: -4 * e * s },
        arms: { l: { a: -16, b: -40 }, r: { a: -16, b: -40 } },
        legs: { r: { lift: i % 3 === 1 ? 0.3 : 0 } },
        face: { mouth: 'smile' }, fx: [{ type: 'dots', at: 'head', dx: 40, dy: -40, n: 1 + (i % 3) }] });
    } },
  { name: 'working', sheet: 'sheet', row: 7, frames: 6, ms: [120, 120, 120, 120, 120, 220], loop: true, states: ['working'],
    pose: (i, ctx) => {
      const up = i % 2, e = ctx.E;
      return P({ y: up ? -1 * e : 0, head: { pitch: 0.3, tilt: (up ? 2 : -2) * e },
        arms: { l: { a: -8, b: up ? -70 : -45, hand: 'fist' }, r: { a: -8, b: up ? -45 : -70, hand: 'fist' } },
        face: { eyes: 'focus', look: [0, 0.7], brows: 'determined', mouth: i % 3 === 2 ? 'tongue' : 'flat' },
        fx: [{ type: 'spark', at: up ? 'hand.l' : 'hand.r', dx: up ? -7 : 7, dy: -8, s: 4 + (i % 3), rot: i * 20 }, ...i === 3 ? [{ type: 'sweat', side: 'l' }] : []] });
    } },
  { name: 'review', sheet: 'sheet', row: 8, frames: 6, ms: [150, 150, 150, 150, 150, 280], loop: true, states: [], codexOnly: true,
    pose: (i, ctx) => {
      const lx = [-0.5, -0.1, 0.3, 0.6, 0.2, 0][i];
      return P({ head: { pitch: 0.25, turn: lx * 0.15, tilt: i === 5 ? 4 : 0 },
        arms: { l: { a: -24, b: -62, hand: 'fist' }, r: { a: -24, b: -62, hand: 'fist' } },
        props: [{ type: 'clipboard', at: 'chest', dy: 6 }],
        face: { eyes: i === 5 ? 'happy' : 'open', look: [lx, 0.65], mouth: i === 5 ? 'smile' : 'flat' },
        fx: i === 5 ? [{ type: 'check', x: 128, y: 96 }] : [] });
    } },
  { name: 'look-a', sheet: 'sheet', row: 9, frames: 8, ms: 160, loop: false, states: [], dir: 'A', pose: (i, ctx) => lookPose(i * 22.5, ctx) },
  { name: 'look-b', sheet: 'sheet', row: 10, frames: 8, ms: 160, loop: false, states: [], dir: 'B', pose: (i, ctx) => lookPose(180 + i * 22.5, ctx) },

  // ---------------- extra sheet (sleight's own states) ----------------
  { name: 'click', sheet: 'extra', row: 0, frames: 4, ms: [60, 70, 90, 160], loop: false, states: ['click'],
    pose: (i, ctx) => {
      const e = ctx.E;
      return [
        P({ lean: 3 * e, arms: { l: { a: 95, b: 60, hand: 'fist', front: true } }, head: { turn: -0.2, pitch: -0.2 }, face: { eyes: 'focus', look: [-0.7, -0.6], brows: 'determined', mouth: 'flat' } }),
        P({ lean: -7 * e, x: -3 * e, arms: { l: { a: 138, b: -4, hand: 'point', front: true } }, head: { turn: -0.35, pitch: -0.35, tilt: 4 }, face: { eyes: 'squeeze', look: [-0.7, -0.6], brows: 'determined', mouth: 'grin' }, fx: [{ type: 'spark', at: 'tip.l', s: 10, rot: 12 }] }),
        P({ lean: -3 * e, arms: { l: { a: 128, b: 8, hand: 'point', front: true } }, head: { turn: -0.25, pitch: -0.25 }, face: { eyes: 'happy', mouth: 'grin' }, fx: [{ type: 'spark', at: 'tip.l', s: 6, rot: 45 }] }),
        P({ arms: { l: { a: 60, b: 40, hand: 'mitten' } }, face: { eyes: 'open', mouth: 'smile' } }),
      ][i];
    } },
  { name: 'right-click', sheet: 'extra', row: 0, start: 4, frames: 4, ms: [70, 80, 90, 160], loop: false, states: ['right-click'],
    pose: (i, ctx) => {
      const e = ctx.E;
      return [
        P({ lean: -3 * e, arms: { r: { a: 95, b: 60, hand: 'fist', front: true } }, head: { turn: 0.25, pitch: -0.2 }, face: { eyes: 'focus', look: [0.7, -0.6], brows: 'determined', mouth: 'flat' } }),
        P({ lean: 6 * e, x: 3 * e, arms: { r: { a: 135, b: -4, hand: 'point', front: true } }, head: { turn: 0.35, pitch: -0.3, tilt: -4 }, face: { eyes: 'focus', look: [0.7, -0.6], brows: 'determined', mouth: 'o' }, fx: [{ type: 'spark', at: 'tip.r', s: 7, rot: 0 }] }),
        P({ lean: 3 * e, arms: { r: { a: 128, b: 6, hand: 'point', front: true } }, head: { turn: 0.25, pitch: -0.25 }, face: { eyes: 'open', look: [0.6, -0.4], mouth: 'smile' }, fx: [{ type: 'menu', at: 'tip.r', dx: 6, dy: -4 }] }),
        P({ arms: { r: { a: 60, b: 40 } }, face: { eyes: 'open', look: [0.6, -0.3], mouth: 'smile' }, fx: [{ type: 'menu', at: 'head', dx: 44, dy: -26 }] }),
      ][i];
    } },
  { name: 'double-click', sheet: 'extra', row: 1, frames: 5, ms: [50, 60, 50, 70, 160], loop: false, states: ['double-click'],
    pose: (i, ctx) => {
      const e = ctx.E, poke = i === 0 || i === 2;
      return P({ lean: (poke ? -7 : -3) * e, x: poke ? -3 * e : -1,
        arms: { l: { a: poke ? 138 : 122, b: poke ? -4 : 14, hand: 'point', front: true } },
        head: { turn: -0.3, pitch: -0.3, tilt: poke ? 4 : 2 },
        face: { eyes: i >= 3 ? 'happy' : 'focus', look: [-0.7, -0.6], brows: i >= 3 ? 'up' : 'determined', mouth: i >= 3 ? 'grin' : 'flat' },
        fx: i === 0 ? [{ type: 'spark', at: 'tip.l', s: 8, rot: 10 }] : i === 2 ? [{ type: 'spark', at: 'tip.l', s: 10.5, rot: 55 }] : i === 3 ? [{ type: 'spark', at: 'tip.l', s: 5, rot: 80 }, { type: 'twinkle', at: 'head', dx: -36, dy: -40, s: 4 }] : [] });
    } },
  { name: 'key', sheet: 'extra', row: 1, start: 5, frames: 3, ms: [50, 60, 110], loop: false, states: ['key'],
    pose: i => P({ head: { pitch: 0.35 },
      arms: { l: { a: -6, b: -38, hand: 'fist' }, r: { a: -6, b: i === 1 ? -14 : -36, hand: 'fist' } },
      props: [{ type: 'keyboard', at: 'hands', dy: 6, press: i === 1 ? 'r' : null }],
      face: { eyes: 'focus', look: [0.1, 0.8], mouth: i === 1 ? 'o' : 'flat' },
      fx: i === 1 ? [{ type: 'tap', at: 'hand.r', dy: -7 }] : [] }) },
  { name: 'type', sheet: 'extra', row: 2, frames: 8, ms: 80, loop: true, states: ['type'],
    pose: (i, ctx) => {
      const lt = i % 2 === 0, e = ctx.E;
      return P({ y: lt ? 0 : -0.6 * e, head: { pitch: 0.38, tilt: (lt ? -2 : 2) * e },
        arms: { l: { a: -6, b: lt ? -14 : -40, hand: 'fist' }, r: { a: -6, b: lt ? -40 : -14, hand: 'fist' } },
        props: [{ type: 'keyboard', at: 'hands', dy: 6, press: lt ? 'l' : 'r' }],
        face: { eyes: 'focus', look: [lt ? -0.25 : 0.25, 0.85], brows: 'neutral', mouth: i % 4 === 3 ? 'tongue' : 'flat' },
        fx: [{ type: 'tap', at: lt ? 'hand.l' : 'hand.r', dy: -7 }] });
    } },
  { name: 'scroll-up', sheet: 'extra', row: 3, frames: 4, ms: 120, loop: true, states: ['scroll-up'],
    pose: (i, ctx) => {
      const k = i / 3, e = ctx.E;
      return P({ wheel: i, y: -1.5 * e * k, head: { pitch: -0.45, turn: 0.15 },
        arms: { r: { a: 40 + 110 * k, b: 40 - 30 * k, hand: 'palm', front: true }, l: { a: 18, b: 20 } },
        face: { eyes: 'open', look: [0.2, -0.9], brows: 'up', mouth: 'o' },
        fx: [{ type: 'chev', x: 148, y: 74, dir: -1, t: k }] });
    } },
  { name: 'scroll-down', sheet: 'extra', row: 3, start: 4, frames: 4, ms: 120, loop: true, states: ['scroll-down'],
    pose: (i, ctx) => {
      const k = i / 3, e = ctx.E;
      return P({ wheel: 3 - i, y: 1 * e * k, head: { pitch: 0.45, turn: 0.15 },
        arms: { r: { a: 150 - 110 * k, b: 10 + 30 * k, hand: 'palm', front: true }, l: { a: 18, b: 20 } },
        face: { eyes: 'open', look: [0.2, 0.9], brows: 'neutral', mouth: 'o' },
        fx: [{ type: 'chev', x: 148, y: 150, dir: 1, t: k }] });
    } },
  { name: 'drag-grab', sheet: 'extra', row: 4, frames: 3, ms: [60, 60, 120], loop: false, states: ['drag-grab'],
    pose: (i, ctx) => {
      const e = ctx.E;
      return [
        P({ y: -2 * e, sy: 1.03, arms: { l: { a: 150, b: 0, hand: 'mitten', front: true }, r: { a: 150, b: 0, hand: 'mitten', front: true } }, head: { pitch: -0.45 }, face: { eyes: 'focus', look: [-0.3, -0.9], brows: 'determined', mouth: 'o' } }),
        P({ arms: { l: { a: 156, b: -14, hand: 'fist', front: true }, r: { a: 156, b: -14, hand: 'fist', front: true } }, props: [{ type: 'card', at: 'overhead', dy: -2, rot: -8 }], head: { pitch: -0.3 }, face: { eyes: 'focus', look: [0, -0.9], brows: 'determined', mouth: 'teeth' } }),
        P({ sy: 0.95, sx: 1.03, y: 1, arms: { l: { a: 158, b: -18, hand: 'fist', front: true }, r: { a: 158, b: -18, hand: 'fist', front: true } }, props: [{ type: 'card', at: 'overhead', dy: 2, rot: -3 }], head: { pitch: -0.15 }, face: { eyes: 'happy', mouth: 'grin' } }),
      ][i];
    } },
  { name: 'drag-drop', sheet: 'extra', row: 4, start: 3, frames: 5, ms: [60, 60, 80, 100, 220], loop: false, states: ['drag-drop'],
    pose: (i, ctx) => {
      const e = ctx.E;
      return [
        P({ arms: { l: { a: 158, b: -18, hand: 'fist', front: true }, r: { a: 158, b: -18, hand: 'fist', front: true } }, props: [{ type: 'card', at: 'overhead', dy: 2, rot: -3 }], face: { eyes: 'focus', mouth: 'flat' } }),
        P({ lean: -5 * e, arms: { l: { a: 118, b: 8, hand: 'mitten', front: true }, r: { a: 96, b: 40, hand: 'mitten', front: true } }, props: [{ type: 'card', at: 'tip.l', dx: 2, dy: -6, rot: -20 }], head: { turn: -0.3, pitch: -0.2 }, face: { eyes: 'focus', look: [-0.8, -0.4], mouth: 'o' } }),
        P({ lean: -3 * e, arms: { l: { a: 110, b: 10, hand: 'palm', front: true }, r: { a: 60, b: 40 } }, props: [{ type: 'card', at: 'tip.l', dx: -4, dy: 6, rot: -6, fade: 0.9 }], fx: [{ type: 'burst', at: 'tip.l', dx: -4, dy: 6, t: 0.3 }], head: { turn: -0.25 }, face: { eyes: 'happy', mouth: 'grin' } }),
        P({ arms: { l: { a: 70, b: 30 }, r: { a: 40, b: 30 } }, fx: [{ type: 'burst', at: 'tip.l', dx: -4, dy: 8, t: 0.75 }], face: { eyes: 'happy', mouth: 'grin', brows: 'up' } }),
        P({ face: { eyes: 'open', mouth: 'smile' } }),
      ][i];
    } },
  { name: 'drag-carry', sheet: 'extra', row: 5, frames: 6, ms: 110, loop: true, states: ['drag-carry'],
    pose: (i, ctx) => {
      const s = S(i, 6), e = ctx.E, up = Math.abs(C(i, 6));
      return P({ y: -2 * e * up, lean: 3 * e, head: { turn: 0.35, pitch: -0.1 },
        arms: { l: { a: 158, b: -18, hand: 'fist', front: true }, r: { a: 158, b: -18, hand: 'fist', front: true } },
        legs: { l: { a: 16 * e * s, lift: Math.max(0, -s) * 0.5 }, r: { a: -16 * e * s, lift: Math.max(0, s) * 0.5 } },
        props: [{ type: 'card', at: 'overhead', dy: 2, rot: -3 + 3 * s }],
        face: { eyes: 'open', look: [0.6, -0.1], brows: 'determined', mouth: i % 3 === 0 ? 'teeth' : 'grin' },
        fx: i === 2 ? [{ type: 'sweat', side: 'l' }] : [] });
    } },
  // Waiting for the person's OK: a polite raised hand and a question bubble. Patient, never pleading.
  { name: 'waiting-approval', sheet: 'extra', row: 6, frames: 6, ms: [300, 150, 150, 300, 150, 150], loop: true, states: ['waiting-approval'],
    pose: (i, ctx) => {
      const e = ctx.E, bob = [0, -1.5, -2.5, 0, -1, 0][i];
      return P({ y: bob * 0.4 * e, head: { tilt: (i >= 3 ? 7 : 2) * e, turn: 0.05 },
        arms: { l: { a: 162, b: i % 3 === 1 ? -30 : -20, hand: 'palm', front: true }, r: { a: 10, b: 14 } },
        face: { eyes: i === 4 ? 'half' : 'open', look: [0, 0.05], brows: 'up', mouth: 'smile' },
        fx: [{ type: 'ask', at: 'head', dx: 47, dy: -50 + bob * e }] });
    } },
  { name: 'error', sheet: 'extra', row: 7, frames: 8, ms: [60, 80, 80, 80, 80, 120, 160, 300], loop: false, states: ['error'],
    pose: (i, ctx) => {
      const e = ctx.E;
      return [
        P({ y: -3 * e, sy: 1.025, sx: 0.98, arms: { l: { a: 70, b: -30, hand: 'palm' }, r: { a: 70, b: -30, hand: 'palm' } }, face: { eyes: 'wide', brows: 'up', mouth: 'shout' }, fx: [{ type: 'bang', at: 'head', dx: 40, dy: -44, s: 0.8 }] }),
        P({ y: -5 * e, x: 3 * e, lean: 6 * e, arms: { l: { a: 75, b: -26, hand: 'palm' }, r: { a: 75, b: -26, hand: 'palm' } }, face: { eyes: 'wide', brows: 'up', mouth: 'shout' }, fx: [{ type: 'bang', at: 'head', dx: 40, dy: -46, s: 1 }, { type: 'cross', x: 44, y: 70 }] }),
        P({ x: 4 * e, lean: 5 * e, arms: { l: { a: 40, b: 10 }, r: { a: 40, b: 10 } }, face: { eyes: 'x', brows: 'worried', mouth: 'wobble' }, fx: [{ type: 'cross', x: 44, y: 70 }] }),
        P({ x: -2 * e, lean: -2 * e, arms: { l: { a: 30, b: 10 }, r: { a: 30, b: 10 } }, face: { eyes: 'x', brows: 'worried', mouth: 'wobble' }, fx: [{ type: 'shake', side: 'l' }] }),
        P({ x: 2 * e, lean: 2 * e, arms: { l: { a: 30, b: 10 }, r: { a: 30, b: 10 } }, face: { eyes: 'squeeze', brows: 'worried', mouth: 'wobble' }, fx: [{ type: 'shake', side: 'r' }] }),
        P({ arms: { l: { a: 20, b: 10 }, r: { a: 20, b: 10 } }, face: { eyes: 'squeeze', brows: 'worried', mouth: 'wobble' }, fx: [{ type: 'sweat', side: 'r' }] }),
        P({ head: { tilt: -5 * e }, arms: { r: { a: 150, b: 95, hand: 'mitten', front: true }, l: { a: 14, b: 10 } }, face: { eyes: 'open', brows: 'worried', mouth: 'wobble' }, fx: [{ type: 'sweat', side: 'r' }] }),
        P({ head: { tilt: -5 * e }, arms: { r: { a: 150, b: 95, hand: 'mitten', front: true }, l: { a: 14, b: 10 } }, face: { eyes: 'happy', brows: 'worried', mouth: 'smile' }, fx: [{ type: 'sweat', side: 'r' }] }),
      ][i];
    } },
  { name: 'success', sheet: 'extra', row: 8, frames: 8, ms: [70, 70, 80, 90, 100, 120, 160, 340], loop: false, states: ['success'],
    pose: (i, ctx) => {
      const e = ctx.E;
      const up = { l: { a: 160, b: -6, hand: 'fist', front: true }, r: { a: 160, b: -6, hand: 'fist', front: true } };
      return [
        P({ sy: 0.92, sx: 1.04, arms: { l: { a: 35, b: 40, hand: 'fist' }, r: { a: 35, b: 40, hand: 'fist' } }, face: { eyes: 'happy', mouth: 'grin' } }),
        P({ y: -4 * e, sy: 1.02, sx: 0.99, arms: up, legs: { l: { lift: 0.4, a: -8 }, r: { lift: 0.4, a: 8 } }, face: { eyes: 'happy', mouth: 'grin', brows: 'up' }, fx: [{ type: 'burst', at: 'head', dx: 0, dy: -10, t: 0.15, big: true }] }),
        P({ y: -7 * e, arms: up, legs: { l: { lift: 0.6, a: -10 }, r: { lift: 0.6, a: 10 } }, face: { eyes: 'happy', mouth: 'grin', brows: 'up' }, fx: [{ type: 'burst', at: 'head', dx: 0, dy: -10, t: 0.45, big: true }] }),
        P({ y: -5 * e, arms: up, legs: { l: { lift: 0.3 }, r: { lift: 0.3 } }, face: { eyes: 'happy', mouth: 'grin' }, fx: [{ type: 'burst', at: 'head', dx: 0, dy: -10, t: 0.8, big: true }] }),
        P({ sy: 0.93, sx: 1.03, arms: { l: { a: 60, b: 30, hand: 'fist' }, r: { a: 60, b: 30, hand: 'fist' } }, face: { eyes: 'happy', mouth: 'grin' } }),
        P({ arms: { r: { a: 100, b: 72, hand: 'thumb', front: true }, l: { a: 16, b: 12 } }, head: { tilt: -4 * e }, face: { eyes: { l: 'happy', r: 'open' }, mouth: 'grin', brows: 'up' }, fx: [{ type: 'twinkle', at: 'tip.r', dx: 8, dy: -6, s: 5 }] }),
        P({ arms: { r: { a: 100, b: 72, hand: 'thumb', front: true }, l: { a: 16, b: 12 } }, head: { tilt: -4 * e }, face: { eyes: { l: 'happy', r: 'open' }, mouth: 'grin', brows: 'up' }, fx: [{ type: 'twinkle', at: 'tip.r', dx: 10, dy: -9, s: 3.5 }, { type: 'twinkle', at: 'head', dx: -40, dy: -30, s: 3 }] }),
        P({ arms: { r: { a: 100, b: 72, hand: 'thumb', front: true }, l: { a: 16, b: 12 } }, head: { tilt: -3 * e }, face: { eyes: 'happy', mouth: 'smile', brows: 'neutral' } }),
      ][i];
    } },
  // Hand back: the character returns the spark (the pointer) to the person, then waves.
  { name: 'handoff', sheet: 'extra', row: 9, frames: 8, ms: [120, 120, 140, 140, 160, 160, 200, 400], loop: false, states: ['handoff'],
    pose: (i, ctx) => {
      const e = ctx.E;
      const cup = { l: { a: -26, b: -58, hand: 'mitten' }, r: { a: -26, b: -58, hand: 'mitten' } };
      const offer = { l: { a: 118, b: -8, hand: 'palm', front: true }, r: { a: 40, b: 30 } };
      return [
        P({ arms: cup, head: { pitch: 0.3 }, face: { eyes: 'open', look: [0, 0.8], mouth: 'smile' }, fx: [{ type: 'spark', at: 'hands', dy: -6, s: 8, rot: 0 }] }),
        P({ lean: -4 * e, arms: offer, head: { turn: -0.25, pitch: -0.2 }, face: { eyes: 'open', look: [-0.7, -0.5], mouth: 'smile' }, fx: [{ type: 'spark', at: 'tip.l', dx: 1, dy: -5, s: 9, rot: 10 }] }),
        P({ lean: -4 * e, arms: offer, head: { turn: -0.25, pitch: -0.3 }, face: { eyes: 'open', look: [-0.8, -0.7], mouth: 'smile' }, fx: [{ type: 'spark', at: 'tip.l', dx: -10, dy: -19, s: 9, rot: 30 }, { type: 'trail', at: 'tip.l', dx: -4, dy: -8, n: 3 }] }),
        P({ lean: -2 * e, arms: offer, head: { turn: -0.25, pitch: -0.35 }, face: { eyes: 'open', look: [-0.85, -0.85], mouth: 'grin' }, fx: [{ type: 'spark', at: 'tip.l', dx: -24, dy: -36, s: 7, rot: 50 }, { type: 'trail', at: 'tip.l', dx: -14, dy: -22, n: 4 }] }),
        P({ arms: { r: { a: 142, b: 40, hand: 'palm', front: true }, l: { a: 14, b: 12 } }, head: { tilt: -5 * e }, face: { eyes: 'happy', mouth: 'grin', brows: 'up' }, fx: [{ type: 'trail', x: 30, y: 30, n: 3 }] }),
        P({ arms: { r: { a: 142, b: 6, hand: 'palm', front: true }, l: { a: 14, b: 12 } }, head: { tilt: -5 * e }, face: { eyes: 'happy', mouth: 'grin', brows: 'up' }, fx: [{ type: 'motion', at: 'hand.r', dx: 9, dy: 0 }] }),
        P({ y: 1, head: { pitch: 0.35 }, arms: { l: { a: -14, b: -20 }, r: { a: -14, b: -20 } }, face: { eyes: 'closed', mouth: 'smile' } }),
        P({ arms: { l: { a: -12, b: -16 }, r: { a: -12, b: -16 } }, face: { eyes: 'happy', mouth: 'smile' } }),
      ][i];
    } },
  // Thinking: hand on chin while six pixels orbit, like the ring's thinking state (1.6 s per lap).
  { name: 'thinking', sheet: 'extra', row: 10, frames: 8, ms: 200, loop: true, states: ['thinking'],
    pose: (i, ctx) => P({ head: { tilt: 7 * ctx.E, turn: 0.15, pitch: -0.1 },
      arms: { r: { a: -40, b: -132, hand: 'fist', front: true }, l: { a: -30, b: -66, hand: 'mitten' } },
      face: { eyes: i === 6 ? 'half' : 'open', look: [0.55, -0.75], brows: i < 4 ? 'neutral' : 'up', mouth: 'cat' },
      fx: [{ type: 'orbit', at: 'head', dx: 0, dy: -6, t: i / 8 }] }) },
];


// ---------- perch mode (A2, art/A2-spec.md): copied from art/A2-cells.mjs; sheet 'perch' is a third atlas, 8 x 3 ----------
// Seated on the window's top edge: the seat (hip line, y 150 in the cell) rests on the edge, the legs dangle in front
// of the title bar. Lifted, splayed legs read as dangling from the front.
const SEAT = { legs: { l: { a: -14, lift: 0.6 }, r: { a: 14, lift: 0.6 } }, arms: { l: { a: 18, b: 30 }, r: { a: 18, b: 30 } } };
const seated = over => merge(P(SEAT), over);

/** New clips. sheet "perch" is this atlas; row and start are its cells. */
export const PERCH_CLIPS = [
  { sheet: 'perch', name: 'perch', row: 0, start: 0, frames: 6, ms: [320, 120, 120, 260, 260, 400], loop: true, states: ['perch'],
    pose: (i, ctx) => {
      const e = ctx.E;
      return [
        seated({}),
        seated({ face: { eyes: 'half' } }),
        seated({ face: { eyes: 'closed' } }),
        seated({ legs: { l: { a: -24 * e - 4, lift: 0.78 } }, head: { tilt: -2 * e } }),
        seated({ legs: { r: { a: 24 * e + 4, lift: 0.78 } }, head: { tilt: 2 * e } }),
        seated({ head: { tilt: 4 * e, pitch: 0.25 }, face: { look: [-0.3, 0.5] } }),
      ][i];
    } },
  // Peek: the host masks the cell at the seat line, so only the head, shoulders and hands on the edge show.
  { sheet: 'perch', name: 'perch-peek', row: 0, start: 6, frames: 2, ms: [1400, 400], loop: true, states: ['perch-peek'],
    pose: i => seated({ head: { pitch: 0.5, turn: -0.3, tilt: 3 }, arms: { l: { a: -22, b: -56 }, r: { a: -22, b: -56 } },
      face: { eyes: i ? 'half' : 'open', look: [-0.6, 0.8], brows: 'up', mouth: 'smile' } }) },
  { sheet: 'perch', name: 'perch-hop', row: 1, start: 0, frames: 4, ms: [70, 120, 70, 160], loop: false, states: ['perch-hop'],
    pose: (i, ctx) => {
      const e = ctx.E;
      return [
        seated({ sy: 0.9, sx: 1.05, y: 3, arms: { l: { a: 30, b: 30 }, r: { a: 30, b: 30 } }, face: { eyes: 'focus' } }),
        P({ y: -7 * e, sy: 1.0, sx: 0.98, arms: { l: { a: 140, b: 10 }, r: { a: 140, b: 10 } }, legs: { l: { a: -10, lift: 0.8 }, r: { a: 10, lift: 0.8 } }, face: { eyes: 'happy', mouth: 'grin', brows: 'up' } }),
        seated({ sy: 0.92, sx: 1.05, y: 2, arms: { l: { a: 40, b: 20 }, r: { a: 40, b: 20 } }, face: { eyes: 'happy', mouth: 'grin' } }),
        seated({ face: { eyes: 'open', mouth: 'smile' } }),
      ][i];
    } },
  // Points down at the target from the edge. Left and right are separate cells: the art is never mirrored.
  { sheet: 'perch', name: 'perch-point-left', row: 1, start: 4, frames: 1, ms: 320, loop: false, states: ['perch-point-left'],
    pose: (i, ctx) => seated({ lean: -4 * ctx.E, arms: { l: { a: 44, b: -6, hand: 'point', front: true } }, head: { turn: -0.3, pitch: 0.4, tilt: 3 },
      face: { eyes: 'focus', look: [-0.7, 0.7], brows: 'determined', mouth: 'flat' }, fx: [{ type: 'twinkle', at: 'tip.l', dx: -4, dy: 5, s: 3.5 }] }) },
  { sheet: 'perch', name: 'perch-point-right', row: 1, start: 5, frames: 1, ms: 320, loop: false, states: ['perch-point-right'],
    pose: (i, ctx) => seated({ lean: 4 * ctx.E, arms: { r: { a: 44, b: -6, hand: 'point', front: true } }, head: { turn: 0.3, pitch: 0.4, tilt: -3 },
      face: { eyes: 'focus', look: [0.7, 0.7], brows: 'determined', mouth: 'flat' }, fx: [{ type: 'twinkle', at: 'tip.r', dx: 4, dy: 5, s: 3.5 }] }) },
  // Sleep: a slow nod. The host draws the Zs.
  { sheet: 'perch', name: 'sleep', row: 1, start: 6, frames: 2, ms: [1500, 1500], loop: true, states: ['sleep'],
    pose: i => seated({ y: i ? 1.5 : 0, head: { tilt: i ? 11 : 8, pitch: 0.35 }, arms: { l: { a: 6, b: 12 }, r: { a: 6, b: 12 } }, legs: { l: { a: -8, lift: 0.6 }, r: { a: 8, lift: 0.6 } },
      face: { eyes: 'closed', mouth: 'smile', brows: 'neutral', blush: 1 } }) },
  // High-five: the palm comes out toward the viewer. The ring's done burst plays at this cell's hotspot (the palm).
  { sheet: 'perch', name: 'high-five', row: 2, start: 0, frames: 3, ms: [90, 120, 420], loop: false, states: ['high-five'],
    pose: (i, ctx) => {
      const e = ctx.E;
      return [
        seated({ arms: { r: { a: 110, b: 40, hand: 'palm', front: true } }, face: { eyes: 'happy', mouth: 'grin', brows: 'up' } }),
        seated({ lean: 5 * e, y: -2 * e, arms: { r: { a: 152, b: -14, hand: 'palm', front: true } }, head: { tilt: -4 * e }, face: { eyes: 'happy', mouth: 'grin', brows: 'up' }, fx: [{ type: 'burst', at: 'hand.r', dx: 6, dy: -4, t: 0.35 }] }),
        seated({ lean: 3 * e, arms: { r: { a: 150, b: -12, hand: 'palm', front: true } }, head: { tilt: -3 * e }, face: { eyes: { l: 'happy', r: 'open' }, mouth: 'grin' }, fx: [{ type: 'twinkle', at: 'hand.r', dx: 10, dy: -8, s: 4 }] }),
      ][i];
    } },
  // Wait sign: a card held up with both hands and the question bubble. Patient, never pleading.
  { sheet: 'perch', name: 'perch-wait', row: 2, start: 3, frames: 2, ms: [900, 500], loop: true, states: ['perch-wait'],
    pose: i => seated({ arms: { l: { a: 156, b: -14, hand: 'fist', front: true }, r: { a: 156, b: -14, hand: 'fist', front: true } },
      props: [{ type: 'card', at: 'overhead', rot: i ? 2 : -3 }], head: { tilt: i ? 5 : 2 }, face: { eyes: 'open', brows: 'up', mouth: 'smile' },
      fx: [{ type: 'ask', at: 'head', dx: 50, dy: -46 }] }) },
  { sheet: 'perch', name: 'startle', row: 2, start: 5, frames: 2, ms: [70, 110], loop: false, states: ['startle'],
    pose: (i, ctx) => {
      const e = ctx.E;
      return [
        seated({ y: -2 * e, sy: 1.0, sx: 0.98, arms: { l: { a: 70, b: -30, hand: 'palm' }, r: { a: 70, b: -30, hand: 'palm' } }, legs: { l: { a: -18, lift: 0.75 }, r: { a: 18, lift: 0.75 } }, face: { eyes: 'wide', brows: 'up', mouth: 'shout' }, fx: [{ type: 'bang', at: 'head', dx: 44, dy: -30, s: 0.8 }] }),
        seated({ y: -2 * e, arms: { l: { a: 40, b: 10 }, r: { a: 40, b: 10 } }, face: { eyes: 'wide', brows: 'up', mouth: 'o' } }),
      ][i];
    } },
];


/** Rows used in each sheet, for cell checks. */
export function usedCells(clips = [...CLIPS, ...PERCH_CLIPS]) {
  const used = { sheet: [], extra: [], perch: [] };
  for (const c of clips) for (let k = 0; k < c.frames; k++) used[c.sheet].push({ row: c.row, col: (c.start ?? 0) + k });
  return used;
}

/** Where the last rendered cell's anchors landed in cell px, after the root transform (for per-state hotspots). */
export const lastAnchors = {};
export function recordAnchors(anchor, p, names = ['hand.l', 'hand.r', 'tip.l', 'tip.r', 'head']) {
  const a = (p.lean ?? 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  for (const n of names) { const [x, y] = anchor(n); const dx = (x - 96) * p.sx, dy = (y - 196) * p.sy; lastAnchors[n] = [96 + dx * c - dy * s + p.x, 196 + dx * s + dy * c + p.y]; }
}
