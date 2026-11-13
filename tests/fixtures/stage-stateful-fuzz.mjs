// Stateful geometry oracle adapted from the ST4 review. This helper launches only the headless stage dump.
import { spawnSync } from 'node:child_process';

export function runStageFuzz(host, { seed0 = 1, cases = 100, maxSteps = 14, stepBudget = 2400, aimRadius = 48 } = {}) {
const nonce = 'b'.repeat(64);
function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const EPS = 1e-6;
const ov = (a, b) => a[0] < b[0] + b[2] - EPS && a[0] + a[2] > b[0] + EPS && a[1] < b[1] + b[3] - EPS && a[1] + a[3] > b[1] + EPS;
const exp = (a, n) => [a[0] - n, a[1] - n, a[2] + 2 * n, a[3] + 2 * n];
const inside = (o, i) => i[0] >= o[0] - 1e-6 && i[1] >= o[1] - 1e-6 && i[0] + i[2] <= o[0] + o[2] + 1e-6 && i[1] + i[3] <= o[1] + o[3] + 1e-6;
const dist = (p, r) => Math.hypot(Math.max(r[0] - p[0], 0, p[0] - (r[0] + r[2])), Math.max(r[1] - p[1], 0, p[1] - (r[1] + r[3])));
const union = (a, b) => { const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]); return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y]; };

const topologies = [
  [{ f: [0, 0, 1512, 982], top: 37, bottom: 70 }],
  [{ f: [0, 0, 1728, 1117], top: 37, bottom: 80 }, { f: [1728, -100, 2560, 1440], top: 25, bottom: 0 }],
  [{ f: [0, 0, 1512, 982], top: 37, bottom: 70 }, { f: [-1920, 100, 1920, 1080], top: 25, bottom: 0 }],
  [{ f: [0, 0, 1440, 900], top: 25, bottom: 0 }, { f: [-200, -1080, 1920, 1080], top: 25, bottom: 0 }],
  [{ f: [0, 0, 1512, 982], top: 37, bottom: 70 }, { f: [-1366, 200, 1366, 768], top: 25, bottom: 0 }, { f: [1512, -300, 1920, 1200], top: 25, bottom: 50 }],
];
const displayRects = d => ({ frame: d.f, visible: [d.f[0], d.f[1] + d.top, d.f[2], d.f[3] - d.top - d.bottom] });

function run(lines, frame) {
  const input = [frame, ...lines].map(x => JSON.stringify(x)).join('\n') + '\n';
  const r = spawnSync(host, ['--stage-dump', ...(globalThis.__REDUCED ? ['--reduce-motion'] : [])], { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 60000, killSignal: 'SIGKILL' });
  if (r.status !== 0) return { error: `exit ${r.error?.code ?? r.signal ?? r.status} ${r.stderr.slice(0, 200)}`, rows: [] };
  return { rows: r.stdout.trim().split('\n').filter(Boolean).map(JSON.parse).filter(x => x.effect !== 'end') };
}

const stats = { cases: 0, steps: 0, aims: 0, draws: 0, hides: 0, segments: 0, tiny: 0, full: 0, multi: 0, negative: 0, moves: 0, locks: 0, near: 0, edges: 0, rungs: {}, kinds: {}, reasons: {}, pointerFaded: 0, motion: 0, far: 0, frontSit: 0, paused: 0 };
const violations = {};
const samples = {};
function violate(kind, detail) { violations[kind] = (violations[kind] || 0) + 1; if (!samples[kind]) samples[kind] = detail; }

function genCase(seed) {
  const R = rng(seed), rnd = (a, b) => a + R() * (b - a), pick = a => a[Math.floor(R() * a.length)], chance = p => R() < p;
  const topo = topologies[(seed - seed0) % topologies.length]; const ds = topo.map(displayRects);
  if (ds.length > 1) stats.multi++;
  if (ds.some(d => d.frame[0] < 0 || d.frame[1] < 0)) stats.negative++;
  const optionPool = [
    { size: 'stage', art: true }, { size: 'stage', art: true, stageFrontSit: true }, { size: 'stage', art: true, stageFrontSit: true }, { size: 'stage', art: false }, { size: 'medium', art: false },
    { size: 'small', art: false }, { size: 'stage', art: true, stageAttention: false }, { size: 'stage', art: true, stageFrontSit: true, stageAttention: false },
    { size: 330, art: true }, { size: 130, art: true }, { size: 'stage', art: true, __reduced: true },
  ];
  const opt = pick(optionPool);
  const frame = {
    hand: 'character', nonce, seq: 1, id: 'fixture', sheet: '/tmp/x/sheet.png', extra: null, cell: [192, 208],
    table: { idle: { sheet: 'sheet', row: 0, frames: [0, 1], ms: [200, 200], loop: true, flip: false, hotspot: [96, 104], size: [1536, 208], scale: 0.5 } },
    perch: { anchor: [96, seed % 3 === 0 ? 208 : 150], table: Object.fromEntries(['perch', 'perch-peek', 'perch-hop', 'perch-point-left', 'perch-point-right', 'sleep', 'high-five', 'perch-wait', 'startle', 'jumping', 'running-right', 'running-left', 'error', 'handoff', 'paused']
      .map(k => [k, { sheet: 'sheet', row: 0, frames: [0, 1], ms: [200, 200], loop: true, flip: false, hotspot: [96, 104], size: [1536, 208], scale: 0.5 }])) },
    size: opt.size, ...(opt.stageFrontSit ? { stageFrontSit: true } : {}), ...(opt.stageAttention === false ? { stageAttention: false } : {}),
  };
  const art = opt.art;
  const reduced = !!opt.__reduced;
  const dispOf = () => pick(ds);
  function genWindow(id, pid) {
    const d = dispOf(), df = d.frame; const roll = R();
    let w, h, x, y, full = false;
    if (roll < 0.2) { w = rnd(20, 260); stats.tiny++; h = rnd(30, 400); }
    else if (roll < 0.7) { w = rnd(300, 1200); h = rnd(150, 700); }
    else if (roll < 0.9) { w = rnd(1200, df[2]); h = rnd(300, df[3]); }
    else if (roll < 0.95) { w = df[2]; h = df[3]; full = true; stats.full++; }
    else { w = rnd(300, 1000); h = rnd(200, 600); }
    x = full ? df[0] : rnd(df[0] - w * 0.3, df[0] + df[2] - w * 0.7);
    y = full ? df[1] : (chance(0.2) ? d.visible[1] : chance(0.2) ? d.visible[1] + rnd(0, 60) : rnd(df[1], df[1] + df[3] - 50));
    return { id, pid, frame: [x, y, w, h], ...(full ? { fullScreen: true } : {}) };
  }
  let T = genWindow(7, 42), T2 = genWindow(9, 42);
  const model = {
    T, T2, above: [], person: null, pointer: [0, 0], inputAge: 20, pointerAway: 10, cards: [], ds,
    locked: false, sleeping: false, call: false, paused: false, clock: 0, order: chance(0.5), hidden7: false,
  };
  const randPoint = (w) => {
    const [x, y, ww, hh] = w.frame;
    const m = R();
    if (m < 0.45) return [rnd(x, x + ww), rnd(y, y + hh)];
    if (m < 0.65) return [rnd(x, x + Math.min(ww, 120)), rnd(y, y + Math.min(hh, 60))];             // top-left corner area
    if (m < 0.8) return [rnd(x + Math.max(0, ww - 120), x + ww), rnd(y, y + Math.min(hh, 60))];     // top-right
    if (m < 0.9) return [rnd(x, x + ww), y + rnd(0, 8)];                                            // on the top edge
    return [pick([x, x + ww]), rnd(y, y + hh)];                                                    // on a side
  };
  const rects = () => {
    const out = [];
    const n = Math.floor(rnd(0, 3.6));
    for (let i = 0; i < n; i++) {
      const base = chance(0.5) ? model.T.frame : model.T2.frame;
      const d = dispOf().frame;
      out.push({ id: 20 + i, pid: 55, frame: chance(0.6) ? [base[0] + rnd(-300, base[2]), base[1] + rnd(-250, 60), rnd(60, 500), rnd(60, 400)] : [rnd(d[0], d[0] + d[2] - 100), rnd(d[1], d[1] + d[3] - 100), rnd(60, 500), rnd(60, 400)] });
    }
    return out;
  };
  const makePerson = () => { const m = R(); if (m < 0.3) return null; if (m < 0.55) return [...model.T.frame]; const d = dispOf().frame; return [rnd(d[0], d[0] + d[2] - 100), rnd(d[1], d[1] + d[3] - 100), rnd(100, 800), rnd(100, 600)]; };
  const makeCards = () => { const n = Math.floor(rnd(0, 2.5)); const out = []; const d = dispOf().frame; for (let i = 0; i < n; i++) out.push(chance(0.5) ? [model.T.frame[0] + rnd(-100, 400), model.T.frame[1] + rnd(-250, 50), rnd(150, 400), rnd(100, 250)] : [rnd(d[0], d[0] + d[2] - 200), rnd(d[1], d[1] + d[3] - 150), 180, 120]); return out; };
  model.above = rects(); model.person = makePerson(); model.cards = makeCards();
  model.pointer = [rnd(-1800, 3000), rnd(-300, 1200)];

  const steps = []; // each: { lines, tag, apply(): updates expectations, meta }
  let seq = 10;
  const worldLine = () => {
    model.sampled = model.clock;
    const list = [...model.above.map(w => ({ ...w })), ...(model.order ? [model.T, model.T2] : [model.T2, model.T]).filter(w => !w.gone).map(w => JSON.parse(JSON.stringify(w)))];
    return { dumpWorld: JSON.parse(JSON.stringify({ windows: list, displays: ds, pointer: model.pointer, inputAge: model.inputAge, pointerAway: model.pointerAway, person: model.person, cards: model.cards })) };
  };
  const snapshot = () => JSON.parse(JSON.stringify({ T: model.T, T2: model.T2, above: model.above, person: model.person, pointer: model.pointer, cards: model.cards, ds, order: model.order, locked: model.locked, sleeping: model.sleeping, call: model.call, paused: model.paused, sampled: model.sampled, inputAge: model.inputAge, pointerAway: model.pointerAway, clock: model.clock, art, reduced, opt }));
  const push = (lines, tag, meta = {}) => { steps.push({ lines, tag, meta, snap: snapshot() }); };
  if (seed === seed0) {
    opt.size = 'medium'; frame.size = 'medium'; frame.perch.anchor = [96, 208];
    model.T = { id: 7, pid: 42, frame: [100, 600, 500, 250] };
    model.T2 = { id: 9, pid: 42, frame: [900, 600, 500, 250] };
    model.above = []; model.cards = []; model.person = [1400, 700, 80, 80];
    model.pointer = [1500, 900]; model.order = true;
    push([{ dumpStageArt: art }, worldLine()], 'init');
    for (const [id, at, time] of [[7, [300, 800], 0], [9, [1100, 800], 1]]) {
      model.clock = time; push([{ dumpClock: time }], 'clock');
      const w = id === 7 ? model.T : model.T2;
      push([{ hand: 'aim', nonce, seq: ++seq, kind: 'click', pid: 42, windowId: id, at }], 'aim',
        { at, rect: null, grab: null, windowId: id, wasPaused: false, window: [...w.frame], gone: false });
      stats.aims++;
    }
    return { frame, steps, art, reduced, opt: { ...opt, size: 'medium' }, ds };
  }
  if (seed > seed0 && seed <= seed0 + 4) {
    const scenario = ['minimize/restore', 'Space away/back', 'move away/back', 'window ID reused by different PID'][seed - seed0 - 1];
    stats.adversarial ??= {}; stats.adversarial[scenario] = 1;
    opt.size = 'medium'; frame.size = 'medium'; frame.perch.anchor = [96, 208];
    model.T = { id: 7, pid: 42, frame: [100, 600, 500, 250] };
    model.T2 = { id: 9, pid: 42, frame: [900, 600, 500, 250] };
    model.above = []; model.cards = []; model.person = [1400, 700, 80, 80];
    model.pointer = [1500, 900]; model.order = true;
    const action = w => {
      const at = [w.frame[0] + 250, w.frame[1] + 200], rect = [w.frame[0], w.frame[1], 500, 30];
      push([{ hand: 'aim', nonce, seq: ++seq, kind: 'click', pid: w.pid, windowId: w.id, at, rect }], 'aim',
        { at, rect, grab: null, windowId: w.id, wasPaused: false, window: [...w.frame], gone: false }); stats.aims++;
    };
    push([{ dumpStageArt: art }, worldLine()], 'init'); action(model.T);
    const original = { ...model.T, frame: [...model.T.frame] };
    if (scenario === 'minimize/restore') model.T.minimized = true;
    else if (scenario === 'Space away/back') model.T.onScreen = false;
    else if (scenario === 'move away/back') model.T.frame = [100, 200, 500, 250];
    else model.T.gone = true;
    push([worldLine()], 'world'); action(model.T2);
    model.clock = 1; push([{ dumpClock: 1 }], 'clock');
    model.T = { ...original, ...(scenario === 'window ID reused by different PID' ? { pid: 99 } : {}) };
    push([worldLine()], 'world'); action(model.T);
    return { frame, steps, art, reduced, opt, ds };
  }
  push([{ dumpStageArt: art }, worldLine()], 'init');
  const n = 5 + Math.floor(R() * (maxSteps - 4));
  for (let i = 0; i < n; i++) {
    const m = R();
    if (m < 0.28) {
      const useT2 = chance(0.2); const w = useT2 ? model.T2 : model.T; const at = randPoint(w); const rect = chance(0.6) ? [at[0] - 12, at[1] - 8, rnd(10, 180), rnd(10, 90)] : null;
      const kind = pick(['aim', 'aim', 'click', 'type', 'scroll', 'key', 'drag', 'double', 'right']);
      const wasPaused = model.paused;
      const grab = kind === 'drag' ? [at[0] - rnd(-150, 150), at[1] - rnd(-150, 150)] : null;
      const line = kind === 'aim' ? { hand: 'aim', nonce, seq: ++seq, kind: 'click', pid: 42, windowId: w.id, at, ...(rect ? { rect } : {}) }
        : { hand: 'act', nonce, seq: ++seq, kind, pid: 42, windowId: w.id, at, path: grab ? [grab, at] : [at], delayMs: 0, beats: 1, ...(rect ? { rect } : {}) };
      push([line], 'aim', { at, rect, grab, windowId: w.id, wasPaused, window: JSON.parse(JSON.stringify(w.frame)), gone: !!w.gone });
      stats.aims++;
      if (chance(0.5)) { model.clock += rnd(0.05, 0.3); push([{ dumpClock: model.clock }], 'clock'); push([], 'ptr', { lazy: true }); model.clock += rnd(0.05, 0.25); push([{ dumpClock: model.clock }], 'clock'); }
    } else if (m < 0.42) {
      model.clock += chance(0.15) ? rnd(6, 25) : rnd(0.03, 1.2); push([{ dumpClock: model.clock }], 'clock');
    } else if (m < 0.58) {
      const k = R();
      if (k < 0.3) { // pointer, often near the last drawn box (unknown here), or near the window edge
        const w = model.T.frame; model.pointer = chance(0.5) ? [w[0] + rnd(-200, w[2] + 200), w[1] + rnd(-300, 100)] : [rnd(-1800, 3000), rnd(-300, 1200)]; stats.near++;
      } else if (k < 0.5) { model.inputAge = chance(0.5) ? rnd(0, 7.9) : rnd(8, 30); model.pointerAway = chance(0.5) ? rnd(0, 4.9) : rnd(5, 30); }
      else if (k < 0.7) model.person = makePerson();
      else if (k < 0.85) model.cards = makeCards();
      else model.above = rects();
      push([worldLine()], 'world');
    } else if (m < 0.72) {
      const k = R(); let prev = model.T.frame; stats.moves++;
      if (k < 0.5) model.T = { ...model.T, frame: [prev[0] + rnd(-40, 40), prev[1] + rnd(-40, 40), prev[2], prev[3]] };
      else if (k < 0.75) model.T = { ...model.T, frame: [prev[0], prev[1], Math.max(20, prev[2] + rnd(-200, 200)), Math.max(30, prev[3] + rnd(-100, 100))] };
      else model.T = { ...genWindow(7, 42) };
      push([worldLine()], 'move', { prev });
    } else if (m < 0.77) {
      const flag = pick(['locked', 'sleeping', 'call']); model[flag] = !model[flag]; if (model[flag]) stats.locks++;
      push([{ dumpActivity: { [flag]: model[flag] } }], 'activity', { flag });
    } else if (m < 0.81) {
      model.paused = !model.paused; if (model.paused) stats.paused++; push([{ dumpPaused: model.paused }], 'pause');
    } else if (m < 0.85) {
      const w = model.T; if (w.fullScreen) { delete w.fullScreen; } else { const d = dispOf(); model.T = { ...w, frame: [...d.frame], fullScreen: true }; stats.full++; }
      push([worldLine()], 'move', { prev: w.frame, full: true });
    } else if (m < 0.9) {
      model.T = { ...model.T, ...(model.T.onScreen === false ? { onScreen: true } : { onScreen: false }) };
      push([worldLine()], 'vanish', {});
    } else if (m < 0.935) {
      push([], 'ptr', { lazy: true });
    } else if (m < 0.96) {
      model.T2 = genWindow(9, 42); push([worldLine()], 'world');
    } else {
      model.clock += rnd(0.03, 0.4); push([{ dumpClock: model.clock }], 'clock');
    }
    // sample soon after most actions, as the host's poll would
    if (chance(0.7)) { model.clock += rnd(0.02, 0.3); push([{ dumpClock: model.clock }], 'clock'); }
  }
  return { frame, steps, art, reduced, opt, ds };
}

function winRect(snap, id) { const w = id === 7 ? snap.T : snap.T2; return w; }
function listWins(snap) { return [...snap.above, ...(snap.order ? [snap.T, snap.T2] : [snap.T2, snap.T])]; }
function visible(w) { return w.onScreen !== false && w.minimized !== true; }

function check(c, seed) {
  const state = { shown: false, seatWindow: null, turn: [], eventWindow: null, hasEvent: false, lastSnapWindow: null, prevRects: null, paused: false, lockedAt: null };
  let prevCount = 0, prevLines = []; const P = rng(seed ^ 0xabc123), wide = stageWideOracle();
  for (let k = 0; k < c.steps.length; k++) {
    if (c.steps[k].meta.lazy) {
      const st = c.steps[k];
      const lb = state.lastBox;
      if (!lb || !state.lastWorld) { st.lines = [{ dumpClock: st.snap.clock + 0.001 }]; st.tag = 'clock'; }
      else {
        const px = lb[0] + lb[2] * P() * 0 + (P() * (lb[2] + 100) - 50), py = lb[1] + (P() * (lb[3] + 100) - 50);
        const w = JSON.parse(JSON.stringify(state.lastWorld)); w.dumpWorld.pointer = [px, py]; w.dumpWorld.inputAge = 0; w.dumpWorld.pointerAway = 0;
        st.lines = [w]; st.tag = 'world'; st.snap.pointer = [px, py]; st.snap.inputAge = 0; st.snap.pointerAway = 0; st.snap.sampled = st.snap.clock;
        stats.ptr = (stats.ptr || 0) + 1;
        for (let j = k + 1; j < c.steps.length; j++) { if (c.steps[j].lines.some(l => l.dumpWorld)) break; const sj = c.steps[j].snap; sj.pointer = [px, py]; sj.inputAge = 0; sj.pointerAway = 0; sj.sampled = st.snap.clock; }
      }
    }
    if (c.steps[k].lines.some(l => l.dumpWorld)) state.lastWorld = c.steps[k].lines.find(l => l.dumpWorld);
    prevLines = prevLines.concat(c.steps[k].lines);
    globalThis.__REDUCED = c.reduced; const res = run(prevLines, c.frame);
    stats.steps++; if (stats.steps > stepBudget) throw Error(`fuzz exceeded ${stepBudget} steps`);
    if (res.error) { violate('dump-crash', `seed ${seed} step ${k} ${c.steps[k].tag}: ${res.error}`); return; }
    const rows = res.rows.slice(prevCount); prevCount = res.rows.length;
    const step = c.steps[k], snap = step.snap, clock = snap.clock;
    const info = `seed ${seed} step ${k} ${step.tag}`;
    if (false) console.error(info, 'T=', JSON.stringify(snap.T.frame), snap.T.onScreen, snap.T.fullScreen, 'clock', clock.toFixed(2), 'rows', rows.map(r => r.effect + ':' + (r.reason || r.seat?.kind) + (r.box ? ':' + r.box.map(Math.round) : '')).join(' '), step.tag === 'aim' ? 'AIM ' + JSON.stringify(step.meta.at) + ' win ' + step.meta.windowId : '');
    // model updates before checks
    if (step.tag === 'aim') {
      const ignoring = false;
      const win = step.meta.windowId === 7 ? snap.T : snap.T2;
      if (!ignoring) {
        state.eventWindow = step.meta.windowId; state.hasEvent = true;
        const at = step.meta.at, rect = step.meta.rect, wr = win && visible(win) && !win.gone ? win.frame : null;
        const tg = [exp([...at, 0, 0], aimRadius)];
        if (rect) tg.push(exp(rect, aimRadius));
        if (step.meta.grab) { const g = step.meta.grab; tg.push(exp([...g, 0, 0], aimRadius)); if (wr && g[1] >= wr[1] && g[1] <= wr[1] + 56) tg.push([g[0] - 72, wr[1], 144, 56]); }
        if (wr && at[1] >= wr[1] && at[1] <= wr[1] + 56) tg.push([at[0] - 72, wr[1], 144, 56]);
        state.turn.push(...tg.map(rect => ({ rect, pid: win.pid, window: step.meta.windowId })));
        state.aimAt = at; state.aimRect = rect;
      }
    }
    // world & verification context
    const wins = listWins(snap);
    const ctxFor = id => {
      const idx = id == null ? -1 : wins.findIndex(w => w.id === id && !w.gone && visible(w));
      const T = idx >= 0 ? wins[idx] : null;
      const di = T ? snap.ds.findIndex(d => { const f = d.frame; const px = T.frame[0] + T.frame[2] / 2, py = T.frame[1]; return px >= f[0] && px < f[0] + f[2] && py >= f[1] && py < f[1] + f[3]; }) : -1;
      return { idx, T, disp: di >= 0 ? snap.ds[di] : snap.ds[0] };
    };
    const observed = { windows: wins.filter(w => !w.gone) };
    wide.observe(observed);
    if (step.tag === 'aim') {
      const win = step.meta.windowId === 7 ? snap.T : snap.T2;
      wide.admit({ pid: win.pid, window: step.meta.windowId, kind: step.meta.grab ? 'drag' : 'aim', at: step.meta.at, end: step.meta.grab ? step.meta.at : null }, observed);
    }
    const tid = state.eventWindow;
    const { T, idx, disp } = ctxFor(tid);
    const stopped = snap.locked || snap.sleeping || snap.call;
    const draws = rows.filter(r => r.effect === 'stage'), hides = rows.filter(r => r.effect === 'stage-hide');
    stats.draws += draws.length; stats.hides += hides.length;
    for (const h of hides) stats.reasons[h.reason] = (stats.reasons[h.reason] || 0) + 1;
    // fail closed checks
    if (draws.length) {
      if (!state.hasEvent) violate('draw-without-event', info);
      if (!disp) violate('draw-without-world', `${info}: no display metadata`);
      if (!snap.person) stats.noPerson = (stats.noPerson ?? 0) + draws.length; // FA1: a null person still seats
      if (stopped) violate('draw-while-stopped', `${info}: locked=${snap.locked} sleeping=${snap.sleeping} call=${snap.call}`);
    }
    {
      for (const d of draws) {
      const cx = ctxFor(d.seat.window); const T = cx.T, disp = cx.disp, idx = cx.idx; if (!disp) continue;
      // Keyed on the draw's own seat window (FA1): the host keeps the pre-pause event while paused.
      if (T && T.fullScreen) violate('draw-on-fullscreen', info);
      if (T && T.frame[2] < 48) violate('draw-narrow', `${info}: width ${T.frame[2]}`);
      if (!T && !['edge-hang', 'floor-stand'].includes(d.seat.kind)) violate('windowless-non-edge-seat', info);
      const usable = disp.visible, above = (T ? wins.slice(0, idx) : wins).filter(w => !w.gone && visible(w)).map(w => w.frame);
      const wf = T?.frame ?? [0, 0, 0, 0];
      const controls = T ? [[wf[0], wf[1], Math.min(80, wf[2]), 32], [Math.max(wf[0], wf[0] + wf[2] - 80), wf[1], Math.min(80, wf[2]), 32]] : [];
      const personR = snap.person, cards = snap.cards;
        stats.rungs[d.rung] = (stats.rungs[d.rung] || 0) + 1; stats.kinds[d.seat.kind] = (stats.kinds[d.seat.kind] || 0) + 1;
        if (d.kind === 'far' || d.kind === 'crossfade') stats.far++;
        if (d.seat.kind === 'front-sit') stats.frontSit++;
        const box = d.box;
        const opacityEnd = d.opacity.at(-1)[1];
        const faded = opacityEnd === 0.35;
        const tag = `${info} kind=${d.seat.kind} rung=${d.rung} pose=${d.kind}`;
        if (!inside(usable, box)) violate('box-outside-usable', `${tag}: box ${box} usable ${usable}`);
        const f = [];
        for (const a of above) f.push(['above-window', a]);
        for (const cd of cards) f.push(['card', cd]);
        if (personR) f.push(['person', personR]);
        for (const t of state.turn) f.push(['target/ring/under-edge', t.rect]);
        for (const r of wide.rects({ windows: wins.filter(w => !w.gone) })) f.push(['wide-window', r]);
        for (const cr of controls) f.push(['controls', cr]);
        f.push(['pointer', exp([...snap.pointer, 0, 0], 40)]);
        for (const [name, r] of f) if (ov(box, r)) violate('final-box-overlaps-' + name, `${tag}: box ${box} vs ${r}`);
        // the aim point itself (not only +48 rect) must never be inside
        if (state.aimAt && ov(box, [state.aimAt[0] - 0.5, state.aimAt[1] - 0.5, 1, 1])) violate('final-box-covers-aim-point', tag);
        const pd = dist(snap.pointer, box);
        if (pd < 40 - 1e-6 && !faded) violate('pointer-within-40-not-faded', `${tag}: dist ${pd.toFixed(1)} opacity ${opacityEnd}`);
        if (faded) stats.pointerFaded++;
        // overlap with the target window only for the seats that may
        const overlapT = ov(box, wf);
        if (overlapT && !['edge-lie', 'edge-sit', 'front-sit', 'edge-hang', 'floor-stand'].includes(d.seat.kind)) violate('box-overlaps-target-window', `${tag}: box ${box} win ${wf}`);
        if (['edge-hang', 'floor-stand'].includes(d.seat.kind)) {
          if (!inside(disp.visible, box)) violate('screen-edge-outside-usable', tag);
          const edge = d.seat.kind === 'edge-hang' ? box[1] : box[1] + box[3];
          const wanted = d.seat.kind === 'edge-hang' ? disp.visible[1] + 1.01 : disp.visible[1] + disp.visible[3] - 1.01;
          if (Math.abs(edge - wanted) > EPS) violate('screen-edge-not-aligned', tag);
        }
        if (['edge-lie', 'edge-sit'].includes(d.seat.kind)) { const dip = box[1] + box[3] - wf[1]; if (dip > 0.36 * d.height + 0.01) violate('edge-seat-dip-too-deep', `${tag}: dip ${dip} h ${d.height}`); }
        {
          const away = snap.pointerAway + clock - snap.sampled;
          const lookingNow = !snap.person || (snap.person && JSON.stringify(snap.person) === JSON.stringify(wf)) || away < 5 || dist(snap.pointer, wf) <= 100;
          if ((d.seat.kind === 'front-sit' || d.seat.kind === 'edge-sit') && lookingNow) violate(d.seat.kind + '-while-person-looking', `${tag}: away ${away.toFixed(1)}`);
          if (d.seat.kind === 'front-sit' && d.height < 0.74 * 288) violate('front-sit-not-large', tag);
          if (snap.person && JSON.stringify(snap.person) === JSON.stringify(wf) && !['edge-lie', 'corner-hang', 'edge-hang', 'floor-stand'].includes(d.seat.kind)) violate('person-in-target-bad-seat', `${tag}`);
        }
        if (d.seat.kind === 'front-sit' && !snap.opt.stageFrontSit) violate('front-sit-without-opt-in', tag);
        if (d.seat.kind === 'front-sit' && snap.person && ov(snap.person, wf) && false) violate('x', tag);
        // panel bounds
        const p = d.panel;
        if (!inside(usable, p)) violate('panel-outside-usable', `${tag}: panel ${p} usable ${usable}`);
        for (const [name, r] of f) if (p[0] <= r[0] + r[2] && r[0] <= p[0] + p[2] && p[1] <= r[1] + r[3] && r[1] <= p[1] + p[3])
          violate('panel-contacts-' + name, `${tag}: panel ${p} vs ${r}`);
        // motion
        const pos = d.positions;
        if (pos.length > 1) {
          stats.motion++;
          if (pos.at(-1)[0] > 0.6 + 1e-6) violate('motion-over-600ms', `${tag}: ${pos.at(-1)[0]}`);
          if (snap.reduced && pos.length > 2) violate('reduced-motion-arc', tag);
          for (let i = 0; i + 1 < pos.length; i++) {
            stats.segments++;
            const a = [pos[i][1], pos[i][2], box[2], box[3]], b = [pos[i + 1][1], pos[i + 1][2], box[2], box[3]];
            const sw = union(a, b);
            for (const [name, r] of f) if (ov(sw, r)) violate('path-overlaps-' + name, `${tag}: seg ${i} ${sw} vs ${r}`);
            if (dist(snap.pointer, sw) < 100 - 1e-6) violate('path-within-100-of-pointer', `${tag}: seg ${i} dist ${dist(snap.pointer, sw).toFixed(1)}`);
            if (T && ov(sw, wf) && !['edge-sit', 'front-sit'].includes(d.seat.kind)) violate('path-crosses-target-window', `${tag}: seg ${i}`);
          }
          if (Math.abs(pos.at(-1)[1] - box[0]) > 0.01 || Math.abs(pos.at(-1)[2] - box[1]) > 0.01) {
            if (!state.paused) violate('path-ends-away-from-box', `${tag}: ${pos.at(-1)} box ${box}`);
          }
        } else if (pos.length === 1) {
          if (!state.paused && (Math.abs(pos[0][1] - box[0]) > 0.01 || Math.abs(pos[0][2] - box[1]) > 0.01)) violate('single-position-not-box', tag);
        }
        // sizes
        const ladder = new Set([184, 92]); ladder.add(snap.opt.size === 'stage' || typeof snap.opt.size === 'number' ? d.height : d.height);
        if (snap.opt.size === 'small' && d.height !== 92) violate('small-not-small', tag);
        if (snap.opt.size === 'medium' && d.height > 184 + 1e-6) violate('medium-too-big', tag);
        if (typeof snap.opt.size === 'number' && d.height > snap.opt.size + 1e-6) violate('numeric-size-exceeded', tag);
        if (!snap.art && d.height > 184 + 1e-6) violate('large-without-art', tag);
        if (!snap.paused && !state.paused && snap.art && snap.opt.size === 'stage' && snap.opt.stageAttention !== false && (snap.inputAge + clock - snap.sampled) < 8 && !(snap.person && JSON.stringify(snap.person) === JSON.stringify(wf)) && d.height > 184 + 1e-6) violate('attention-not-shrunk', `${tag}: inputAge ${snap.inputAge + clock - snap.sampled}`);
        if (![0, 0.35, 0.85, 1].includes(opacityEnd)) violate('odd-opacity', `${tag}: ${opacityEnd}`);
        if (d.hitAreas !== 0 || d.capture !== 'none') violate('capture-or-hit', tag);
      }
    }
    // hide expectations
    if (step.tag === 'move' && state.shown && state.eventWindow === 7 && state.seatWindow === 7) {
      // A widened window may keep an already clear seat. The independent obligation
      // oracle audits the retained panel; movement alone no longer requires hiding.
      if (hides.some(h => h.duration > 0.12 + 1e-9)) violate('hide-too-slow', `${info}`);
      // A hide caused by another obstacle adds no move-settle deadline.
    }
    if (step.tag === 'activity' && stopped && state.shown) {
      if (!hides.length) violate('no-hide-on-stop', info);
    }
    if (step.tag === 'vanish' && state.shown && state.eventWindow === 7 && snap.T.onScreen === false) {
      if (!hides.length && !draws.length && !['edge-hang', 'floor-stand'].includes(state.seatKind)) violate('no-safe-edge-response', info);
      if (hides.some(h => h.duration > 0.12 + 1e-9)) violate('hide-too-slow', info);
    }
    // update shown state in row order
    for (const r of rows) {
      if (r.effect === 'stage') { state.shown = true; state.seatWindow = r.seat.window; state.seatKind = r.seat.kind; state.lastBox = r.box; }
      else if (r.effect === 'stage-hide') { state.shown = false; state.lastBox = null; }
    }
    state.paused = snap.paused;
    if (step.tag === 'move') state.moveRect = snap.T.frame;
    // a hide via move without explicit step (move inside aim steps) cannot happen; clock catch-up
  }

}

const t0 = performance.now();
for (let i = 0; i < cases; i++) {
  const seed = seed0 + i;
  const c = genCase(seed);
  stats.cases++;
  check(c, seed);
}
return { seed0, cases, ms: performance.now() - t0, stats, violations, samples };
}

// This inventory comes from input admissions. It never uses a host generation, target list,
// eligibility predicate, completion marker or clock to decide which obligations still exist.
export function auditStageObligations(obligations, row, world, wide = null) {
  const overlap = (a, b) => a[0] < b[0] + b[2] - 1e-7 && b[0] < a[0] + a[2] - 1e-7 && a[1] < b[1] + b[3] - 1e-7 && b[1] < a[1] + a[3] - 1e-7;
  let segments = 0, pairs = 0;
  const errors = [];
  // Inspect retained provenance as an output assertion only. It never supplies obligations.
  if (!row.targetCapacity && Array.isArray(row.targetBindings)) for (const o of obligations) {
    if (o.area) continue;
    const compacted = row.compactedWindows?.some(k => k.pid === o.pid && k.id === o.window);
    if (!compacted && !row.targetBindings.some(b => b.pid === o.pid && b.window === o.window && b.contributors.some(c => c.seq === o.seq))) errors.push(`lost contributor ${o.pid}:${o.window}:${o.seq}`);
  }
  if (row.turnTargets > 64 || row.contributors > 512 || row.windowRecords > 128 || row.wideRecords?.length > 128 || row.wideWindows?.length > 128) errors.push('unbounded provenance');
  if (row.targetCapacity && row.shown) errors.push('capacity overflow drew');
  if (wide?.pending && row.shown) errors.push('pending destination drew');
  const expectedWide = wide?.rects(world) ?? [];
  const contains = (r, s) => r[0] <= s[0] + 1e-6 && r[1] <= s[1] + 1e-6 && r[0] + r[2] >= s[0] + s[2] - 1e-6 && r[1] + r[3] >= s[1] + s[3] - 1e-6;
  // Check the forbidden coverage even while hidden. Host target bindings never supply expected geometry.
  if (wide && !row.targetCapacity && Array.isArray(row.forbidden)) for (const r of [...obligations.flatMap(o => o.rects), ...row.worldAvailable === false ? [] : expectedWide]) {
    if (!row.forbidden?.some(f => contains(f, r))) errors.push(`missing protected coverage ${r}`);
  }
  const draw = row.presented;
  if (!draw) return { errors, segments, pairs, visible: 0 };
  const index = world.windows.findIndex(w => w.id === draw.seat.window);
  const active = world.windows[index]?.frame;
  const controls = active ? [[active[0], active[1], Math.min(80, active[2]), 32],
    [Math.max(active[0], active[0] + active[2] - 80), active[1], Math.min(80, active[2]), 32]] : [];
  const protectedRects = [...obligations.flatMap(o => o.rects), ...expectedWide, ...(world.person ? [world.person] : []), ...world.cards, ...controls,
    ...(world.above ?? world.windows.slice(0, Math.max(0, index)).filter(w => w.onScreen !== false && !w.minimized).map(w => w.frame)),
    [world.pointer[0] - 40, world.pointer[1] - 40, 80, 80]];
  const check = (box, panel = false) => { for (const r of protectedRects) { pairs++;
    const hit = panel ? box[0] <= r[0] + r[2] && r[0] <= box[0] + box[2] && box[1] <= r[1] + r[3] && r[1] <= box[1] + box[3] : overlap(box, r);
    if (hit) errors.push(`protected intersection ${box} with ${r}`);
  } };
  check(draw.box);
  if (!Array.isArray(draw.panel) || draw.panel.length !== 4 || !draw.panel.every(Number.isFinite) || draw.panel[2] <= 0 || draw.panel[3] <= 0)
    errors.push('missing panel rectangle');
  else check(draw.panel, true);
  const elapsed = Math.max(0, row.time - row.planBegan), positions = draw.positions;
  const interpolate = (a, b, t) => a[1] + (b[1] - a[1]) * ((t - a[0]) / (b[0] - a[0]));
  const opacity = t => {
    const keys = draw.opacity;
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 1; i < keys.length; i++) if (t <= keys[i][0]) return interpolate(keys[i - 1], keys[i], t);
    return keys.at(-1)[1];
  };
  for (let i = 1; i < positions.length; i++) {
    const a = positions[i - 1], b = positions[i], begin = Math.max(a[0], elapsed);
    if (b[0] <= begin) continue;
    if (Math.max(opacity(begin), opacity(b[0]), ...draw.opacity.filter(p => p[0] >= begin && p[0] <= b[0]).map(p => p[1])) <= 0) continue;
    const f = (begin - a[0]) / (b[0] - a[0]), x = a[1] + (b[1] - a[1]) * f, y = a[2] + (b[2] - a[2]) * f;
    segments++;
    check([Math.min(x, b[1]), Math.min(y, b[2]), Math.abs(b[1] - x) + draw.box[2], Math.abs(b[2] - y) + draw.box[3]]);
  }
  return { errors, segments, pairs, visible: 1 };
}

export function stageObligationCase(index, seed0 = 0xc4e72000, wide = false) {
  const seed = (seed0 + index) >>> 0;
  return { seed, mode: index % (wide ? 18 : 8), jitter: wide ? Math.floor(index / 18) : seed % 31 };
}

// A second state machine driven only by input admissions and window snapshots. It does not read
// the host's wide set, generations, binding inventory or chosen seat to infer an uncertainty trigger.
export function stageWideOracle() {
  const key = w => `${w.pid}:${w.id ?? w.window}`, seen = new Map(), prior = new Map(), wide = new Set(), apps = new Set(), history = [], pending = [];
  const expand = r => [r[0] - 48, r[1] - 48, r[2] + 96, r[3] + 96];
  const same = (a, b) => a && b && a.every((v, i) => v === b[i]);
  const mark = w => wide.add(typeof w === 'string' ? w : key(w));
  const destination = (p, world) => {
    const dest = world.windows.find(w => w.onScreen !== false && !w.minimized && (w.layer ?? 0) === 0 &&
      p[0] >= w.frame[0] && p[0] < w.frame[0] + w.frame[2] && p[1] >= w.frame[1] && p[1] < w.frame[1] + w.frame[3]);
    if (dest) { mark(dest); history.push(expand(dest.frame)); }
  };
  return {
    get pending() { return pending.length; },
    scrolled: false,
    observe(world) {
      if (!world) return;
      if (world.windows.some(w => w.onScreen !== false && !w.minimized && (w.layer ?? 0) === 0)) {
        for (const p of pending.splice(0)) destination(p, world);
      }
      const current = new Map(world.windows.filter(w => w.onScreen !== false && !w.minimized).map(w => [key(w), w.frame]));
      for (const w of world.windows) if (apps.has(w.pid) && w.onScreen !== false && !w.minimized) mark(w);
      for (const k of seen.keys()) if (!same(prior.get(k), current.get(k))) mark(k);
      for (const [k, r] of prior) if (wide.has(k) && !same(r, current.get(k))) history.push(expand(r));
      for (const w of world.windows) if ([...wide].some(k => k.split(':')[1] === String(w.id))) mark(w);
      prior.clear(); for (const [k, r] of current) prior.set(k, [...r]);
    },
    admit(o, world) {
      if (o.area) {
        if (o.area === 'app') apps.add(o.pid);
        if (o.window > 0) mark(o);
        for (const w of world?.windows ?? []) if (apps.has(w.pid) && w.onScreen !== false && !w.minimized) mark(w);
        return;
      }
      const k = key(o), w = world?.windows.find(w => key(w) === k && w.onScreen !== false && !w.minimized);
      if (o.kind === 'scroll') { this.scrolled = true; if (seen.has(k)) mark(k); }
      if (o.kind === 'drag') {
        mark(k);
        const p = o.end ?? o.at;
        if (p) {
          if (world && world.windows.some(w => w.onScreen !== false && !w.minimized && (w.layer ?? 0) === 0)) destination(p, world);
          else pending.push(p);
        }
      }
      if (w && o.windowRect && o.windowRect.some((v, i) => Math.abs(v - w.frame[i]) > 0.01)) { mark(k); history.push(expand(o.windowRect)); }
      seen.set(k, (seen.get(k) ?? 0) + 1);
      // 513 distinct admissions in one window cannot retain per-reference provenance under the 512 bound.
      if (seen.get(k) > 512) mark(k);
    },
    rects(world) {
      const windows = world.windows.filter(w => w.onScreen !== false && !w.minimized);
      // The 65-window fixture deliberately gives every candidate the same frame, so any busiest-window
      // choice must protect this envelope. The model does not need the host's compaction choice.
      const capacity = seen.size > 64 && windows.length && windows.every(w => same(w.frame, windows[0].frame)) ? [expand(windows[0].frame)] : [];
      return [...history, ...capacity, ...windows.filter(w => wide.has(key(w))).map(w => expand(w.frame))];
    },
  };
}

export function runStageObligationFuzz(host, { frame, seed0 = 0xc4e72000, cases = 248, wide = false, area = false } = {}) {
  const nonce = frame.nonce, stats = { cases: 0, steps: 0, segments: 0, pairs: 0, visible: 0, visibleAfterScroll: 0, visibleByMode: {}, terminalReleases: 0, intersections: 0 };
  const violations = [], scenarios = {}, distinct = new Set();
  const expand = r => [r[0] - 48, r[1] - 48, r[2] + 96, r[3] + 96];
  for (let index = 0; index < cases; index++) {
    const { seed, mode, jitter } = area ? { seed: seed0 + index, mode: index % 22, jitter: Math.floor(index / 22) } : stageObligationCase(index, seed0, wide);
    scenarios[mode] = (scenarios[mode] ?? 0) + 1; distinct.add(`${mode}:${jitter}`);
    let seq = 10, time = 0;
    let windows = [{ id: 7, pid: 42, frame: [100, 600, 500, 250] }, { id: 9, pid: 42, frame: [900, 600, 500, 250] }];
    let unavailable = false;
    const scene = () => ({ windows: structuredClone(windows), displays: [{ frame: [0, 0, 1800, 1200], visible: [0, 30, 1800, 1140] }],
      person: [1650, 1050, 100, 100], pointer: [1790, 1190], inputAge: 20, pointerAway: 10, cards: [], ...unavailable ? { missing: true } : {} });
    const steps = [], push = (line, admission = null, terminal = false) => steps.push({ line, admission, terminal, world: scene(), time });
    const clock = t => { time = t; push({ dumpClock: time }); };
    const action = (w, kind = 'click', broad = false, status = false, extra = {}) => {
      const at = extra.path?.at(-1) ?? [w.frame[0] + 250 + jitter, w.frame[1] + 200], rect = extra.rect ?? (broad ? [...w.frame] : [at[0] - 10, at[1] - 8, 20, 16]);
      const hand = { hand: status ? 'status' : 'act', nonce, seq: ++seq, pid: w.pid, windowId: w.id, at,
        ...(status ? { state: kind, ...(kind === 'done' ? { ok: true } : {}) } : { kind, path: kind === 'drag' ? [[w.frame[0] + 100, w.frame[1] + 20], at] : [at], delayMs: 0, beats: 1, rect }), ...extra };
      const rects = [expand([...at, 0, 0]), ...status ? [] : [expand(rect)]];
      if (kind === 'drag') {
        rects.push(...hand.path.map(p => expand([...p, 0, 0])));
        for (const p of hand.path) if (p[1] >= w.frame[1] && p[1] <= w.frame[1] + 56) rects.push([p[0] - 72, w.frame[1], 144, 56]);
      }
      push(hand, { seq, pid: w.pid, window: w.id, kind, rects, end: kind === 'drag' ? at : null, at, windowRect: hand.windowRect });
    };
    push({ dumpWorld: scene() });
    action(windows[0]); clock(1); action(windows[1]); clock(2);
    // Completion with missing consumption, a delayed old call completion and long human/typing holds.
    action(windows[0], 'done', false, true); clock(32); action(windows[1], 'waiting', false, true); clock(632);
    action(windows[0], 'type');
    if (mode === 0) { action(windows[0], 'scroll'); action(windows[0], 'click', true); }
    if (mode === 1) { windows[0].frame[1] -= 300; push({ dumpWorld: scene() }); windows[0].frame[1] += 300; push({ dumpWorld: scene() }); action(windows[0]); }
    if (mode === 2) { windows[0].onScreen = false; push({ dumpWorld: scene() }); delete windows[0].onScreen; push({ dumpWorld: scene() }); action(windows[0]); }
    if (mode === 3) { windows[0].pid = 99; push({ dumpWorld: scene() }); action(windows[0]); }
    if (mode === 4) { windows[1].frame = [...windows[0].frame]; push({ dumpWorld: scene() }); action(windows[1], 'done', false, true); }
    if (mode === 5) { push({ dumpPaused: true }); action(windows[0], 'drag'); action(windows[1], 'type'); push({ dumpPaused: false }); }
    if (mode === 6) {
      windows = Array.from({ length: 65 }, (_, i) => ({ id: i + 1, pid: 42, frame: [100, 600, 500, 250] }));
      push({ dumpWorld: scene() }); for (const w of windows) action(w);
    }
    if (mode === 7) {
      for (let i = 0; i < 65; i++) { windows[0].frame[0] = 100 + i; push({ dumpWorld: scene() }); action(windows[0]); }
    }
    if (mode === 8) { action(windows[0], 'scroll'); action(windows[1]); }
    if (mode === 9) {
      for (const dx of [0.5 + jitter / 1000, 300 + jitter, 0]) action(windows[0], 'click', false, false, { windowRect: [100 + dx, 600, 500, 250] });
      push({ dumpPaused: true });
      action(windows[0], 'click', false, false, { windowRect: [100, 600, 700 + jitter, 400] });
      action(windows[1]); push({ dumpPaused: false });
      action(windows[1]);
    }
    if (mode === 10) { action(windows[0], 'drag', false, false, { path: [[350, 800], [1100 + jitter, 800]] }); action(windows[1]); }
    if (mode === 11) { action(windows[0], 'drag', false, false, { path: [[350, 800], [1600, 950]] }); action(windows[1]); }
    if (mode === 12) {
      windows.unshift({ id: 11, pid: 55, frame: [950, 600, 500, 250] }); push({ dumpWorld: scene() });
      action(windows[1], 'drag', false, false, { path: [[350, 800], [1100, 800]] }); action(windows[2]);
    }
    if (mode === 13) {
      action(windows[0], 'scroll'); action(windows[1]);
      for (let i = 0; i < 5; i++) { windows[0].frame[1] += 17 + jitter / 100; push({ dumpWorld: scene() }); }
      windows[0].onScreen = false; push({ dumpWorld: scene() });
      delete windows[0].onScreen; push({ dumpWorld: scene() });
    }
    if (mode === 14) { action(windows[0], 'click', false, false, { rect: [-200, 360 + jitter, 20, 20] }); for (let i = 0; i < 513; i++) action(windows[0]); action(windows[1]); }
    if (mode === 15) { action(windows[0], 'scroll'); action(windows[1], 'scroll'); }
    if (mode === 16 || mode === 17) {
      unavailable = true; push({ dumpWorld: scene() });
      if (mode === 17) push({ dumpPaused: true });
      action(windows[0], 'drag', false, false, { path: [[350, 800], [1100 + jitter, 800]] });
      action(windows[1]);
      unavailable = false; push({ dumpWorld: scene() });
      if (mode === 17) push({ dumpPaused: false });
      action(windows[1]);
    }
    if (mode >= 18) {
      const app = mode >= 19, w = windows[0];
      if (mode === 21) push({ dumpPaused: true });
      push({ hand: 'status', nonce, seq: ++seq, state: 'thinking', area: app ? 'app' : 'window', pid: w.pid, windowId: app ? 0 : w.id },
        { seq, area: app ? 'app' : 'window', pid: w.pid, window: app ? 0 : w.id, rects: [] });
      if (mode >= 20) {
        windows.push({ id: 11, pid: w.pid, frame: [100 + jitter, 300, 500, 220] });
        push({ dumpWorld: scene() });
        windows[0].onScreen = false; push({ dumpWorld: scene() });
        delete windows[0].onScreen; push({ dumpWorld: scene() });
      }
      if (mode === 21) push({ dumpPaused: false });
      clock(632.5); action(windows[1]);
    }
    clock(633); action(windows.at(-1), 'done', false, true); clock(635);
    push({ hand: 'status', nonce, seq: ++seq, pid: windows[0].pid, windowId: windows[0].id, at: [350, 800], state: 'done' }, null, true);
    const lines = [frame, { dumpStageArt: true }, ...steps.flatMap(s => [s.line, { dumpStats: true }])];
    const r = spawnSync(host, ['--stage-dump'], { input: lines.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000, killSignal: 'SIGKILL' });
    if (r.status !== 0) { violations.push({ seed, error: `host exit ${r.status}: ${r.stderr}` }); break; }
    const rows = r.stdout.trim().split('\n').map(JSON.parse).filter(r => r.effect === 'stage-stats');
    if (rows.length !== steps.length) { violations.push({ seed, error: 'missing snapshots' }); break; }
    let obligations = [], model = wide ? stageWideOracle() : null;
    for (const [i, step] of steps.entries()) {
      const observed = step.world.missing ? null : step.world;
      model?.observe(observed);
      if (step.admission) { model?.admit(step.admission, observed); obligations.push(step.admission); }
      if (step.terminal) { obligations = []; model = wide ? stageWideOracle() : null; stats.terminalReleases++; if (rows[i].turnTargets !== 0) violations.push({ seed, step: i, error: 'terminal did not release' }); }
      const audit = auditStageObligations(obligations, rows[i], step.world, model);
      stats.steps++; stats.segments += audit.segments; stats.pairs += audit.pairs; stats.visible += audit.visible;
      stats.intersections += audit.errors.filter(e => e.startsWith('protected intersection')).length;
      stats.visibleByMode[mode] = (stats.visibleByMode[mode] ?? 0) + audit.visible;
      if (model?.scrolled) stats.visibleAfterScroll += audit.visible;
      if (audit.errors.length) { violations.push({ seed, step: i, errors: audit.errors.slice(0, 4) }); break; }
    }
    stats.cases++;
    if (violations.length) break;
  }
  return { seed0, seedEnd: seed0 + cases - 1, distinctSequences: distinct.size, scripts: area ? 22 : wide ? 18 : 8, offsets: wide ? Math.ceil(cases / (area ? 22 : 18)) : 31, stats, scenarios, violations };
}


// A second geometry audit for recorded runtime inputs. Frame obligations survive completion
// markers and time; only the existing terminal boundary clears them.
export function auditStageTrace(trace) {
  const expand = r => [r[0] - 48, r[1] - 48, r[2] + 96, r[3] + 96];
  let obligations = [], world, wide = stageWideOracle();
  const result = { intersections: 0, segments: 0, pairs: 0, visible: 0, errors: [] };
  for (const record of trace.records) {
    const input = record.input, row = record.output;
    if (input.op === 'windows') { if (world) { world = { ...world, windows: input.windows }; wide.observe(world); } continue; }
    if (input.world) world = input.world;
    if (world) {
      const order = world.orderedWindows;
      const windows = order?.length ? order.map(k => world.windows.find(w => w.pid === k.pid && w.id === k.id)).filter(Boolean) : world.windows ?? [];
      world = { ...world, windows }; if (input.world) wide.observe(world);
    }
    const e = input.event;
    const terminal = (input.op === 'complete' || input.op === 'receive') &&
      ((e?.state ?? input.state) === 'handback' || (e?.state ?? input.state) === 'done' && !(e?.ok ?? input.ok));
    if (terminal) { obligations = []; wide = stageWideOracle(); }
    if (e && !terminal) {
      const points = e.area ? [] : [e.at, ...e.end ? [e.end] : []];
      const rects = points.map(p => expand([...p, 0, 0]));
      if (input.rect) rects.push(expand(input.rect));
      if (world) for (const p of points) if (p[1] >= world.window[1] && p[1] <= world.window[1] + 56) rects.push([p[0] - 72, world.window[1], 144, 56]);
      const o = { seq: input.seq, pid: e.pid, window: e.window, rects, kind: e.state, area: e.area, end: e.state === 'drag' ? e.at : null, windowRect: e.windowRect };
      wide.admit(o, Object.hasOwn(input, 'world') && input.world === null ? null : world);
      obligations.push(o);
    }
    if (row.shown && !world) { result.errors.push('visible without world'); continue; }
    if (!world) continue;
    const audit = auditStageObligations(obligations, { ...row, time: input.now, presented: row.draw },
      { ...world, windows: world.windows ?? [] }, wide);
    result.intersections += audit.errors.filter(e => e.startsWith('protected intersection')).length;
    result.errors.push(...audit.errors); result.segments += audit.segments; result.pairs += audit.pairs; result.visible += audit.visible;
  }
  return result;
}
