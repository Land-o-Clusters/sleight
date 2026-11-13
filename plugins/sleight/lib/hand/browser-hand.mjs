// The ghost hand for turbo (H8): the same frames as the relay's planner, from the worker's act runner. act.mjs calls
// step() when a step's input starts, after its rules allowed it. step() only queues work: the page metrics, the
// element's CDP box (Playwright's boundingBox) and the browser window's geometry are read on later ticks, and the
// act path never waits on them or reads anything back. Without a client (settings off, no client module) there is
// no hand and no reads.
//
// Points: a box is CSS pixels relative to the main frame's viewport. The page's content area sits at the bottom of
// the browser window (window.screenX/screenY/outerWidth/outerHeight, in screen points), and page zoom is the ratio of
// the window's width to the viewport's CSS width, refined by devicePixelRatio (display scale times zoom). Pinch zoom
// goes through the visual viewport. Turbo moves no real pointer, so it has nothing to hide the hand before.
import { createAppHealthHelper } from '../read-failure.mjs';
import { createHandSettingReader, handSettingReader, cursorDrawing } from './settings.mjs';
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exposure, createRetryMarks, transferMark } from './planner.mjs';
import { trustedLocatorRead } from '../direct-browser/trusted-dom.mjs';
import { cursorRecord, cursorReason, cursorStep } from './events.mjs';
import { randomBytes } from 'node:crypto';
import { retainTrustedNode } from '../direct-browser/trusted-dom.mjs';
import { latestBrowserLayout, watchBrowserLayout, retainLayoutNode, mapBrowserLayout, withBrowserLayoutRequest, browserLayoutRequest } from '../direct-browser/geometry-observation.mjs';

// Parent-only collection adapter. Worker IPC carries no geometry capability.
// The parent must supply capture-bound native window/transform evidence; the
// predictive planner below and its cached metrics cannot supply that evidence.
export async function createBrowserGeometryProducer({ client, channel, windowEvidence = () => undefined } = {}) {
  channel ??= (await import('./client.mjs')).privateHandGeometry(client);
  if (!channel) return;
  let turn, ending = false, closed = false, revision = 0, pendingHolds = 0, inputBarrier = 0, startedInput = false, lostInput = false;
  const watched = new Map(), references = new Map(), holders = new Set(), bindings = new WeakMap(), windows = new Map(), pendingInput = new Set();
  const acquisitions = new Map(), seen = new WeakSet();
  const clear = (keepTurn = false) => {
    revision++;
    for (const stop of watched.values()) stop();
    for (const holder of holders) { try { Promise.resolve(holder.identity.release()).catch(() => {}); } catch {} }
    watched.clear(); references.clear(); holders.clear(); windows.clear(); pendingInput.clear(); acquisitions.clear();
    if (!keepTurn) turn = undefined;
    ending = keepTurn; inputBarrier = 0; startedInput = false; lostInput = false;
  };
  const live = () => {
    if (turn && channel.state.turn !== turn) clear();
    return !closed && !ending && turn && channel.state.turn === turn && !channel.state.poisoned;
  };
  function collect(page, observation, interval) {
    if (!live() || channel.state.pending || pendingInput.size || lostInput) return false;
    let evidence;
    try { evidence = windowEvidence(observation, page); } catch { return false; }
    // Async window lookups would sample a later generation. Never await them.
    if (evidence?.then) return false;
    const ledger = channel.state.admitted, inventory = [];
    for (const ref of ledger) {
      const record = references.get(ref.seq);
      if (!record || record.page !== page || !record.held) return false;
      inventory.push({ seq: ref.seq, held: record.held });
    }
    const mapped = mapBrowserLayout(observation, inventory, evidence);
    if (!mapped || !interval || interval.start < inputBarrier) return false;
    const key = `${mapped.pid}:${mapped.windowId}`, prior = windows.get(key);
    if (ledger.some(ref => ref.pid !== mapped.pid || ref.windowId !== mapped.windowId || references.get(ref.seq)?.windowKey !== key)) return false;
    if (prior && (prior.page !== page || prior.processStart !== mapped.processStart)) return false;
    if (!prior && (ledger.length || startedInput || windows.size >= 128 || channel.state.after !== -1)) return false;
    const ticket = channel.capture(interval);
    if (!ticket) return false;
    const incarnation = prior?.incarnation ?? randomBytes(16).toString('hex');
    const contentGeneration = prior ? prior.generation + Number(prior.semantic !== mapped.semantic) : 0;
    const sent = channel.certify(ticket, { pid: mapped.pid, windowId: mapped.windowId, incarnation,
      contentGeneration, mode: prior ? 'layout' : 'baseline',
      bounds: mapped.bounds, references: mapped.references });
    if (sent !== false) windows.set(key, { incarnation, page, processStart: mapped.processStart, generation: contentGeneration, semantic: mapped.semantic });
    return sent;
  }
  return Object.freeze({
    beginTurn(logicalTurn) {
      live();
      if (closed || turn) return false;
      const queued = channel.beginTurn(logicalTurn);
      if (queued !== false) { turn = logicalTurn; ending = false; revision++; }
      return queued;
    },
    watch(page) {
      if (!live() || watched.has(page) || watched.size >= 128) return false;
      const stop = watchBrowserLayout(page, observation => {
        const request = acquisitions.get(page);
        if (request && browserLayoutRequest(observation) === request.token && !seen.has(observation)) {
          if (request.observation) request.failed = true;
          request.observation = observation;
        }
        seen.add(observation);
      });
      if (!stop) return false;
      watched.set(page, stop); return true;
    },
    // Wrap the parent's existing snapshot request, including its IPC round trip.
    // Worker performance.now() values have a different origin and are never used
    // for freshness. Reused or unsolicited observations cannot get new stamps.
    async acquire(page, request) {
      const prior = acquisitions.get(page);
      if (prior) prior.failed = true;
      const acquisition = { revision, failed: Boolean(prior), token: Object.freeze({}) };
      if (live() && watched.has(page) && !prior) acquisitions.set(page, acquisition);
      const start = performance.now();
      try {
        const result = await withBrowserLayoutRequest(page, acquisition.token, request);
        const end = performance.now();
        try {
          if (acquisitions.get(page) === acquisition && !acquisition.failed && acquisition.revision === revision && acquisition.observation)
            collect(page, acquisition.observation, { start, end });
        } catch { /* Observation failure cannot change the snapshot result. */ }
        return result;
      } finally {
        if (acquisitions.get(page) === acquisition) acquisitions.delete(page);
      }
    },
    async hold(page, handle) {
      if (!live() || !watched.has(page) || holders.size + pendingHolds >= 512) return;
      const windowKeys = [...windows].filter(([, value]) => value.page === page).map(([key]) => key);
      if (windowKeys.length !== 1) return;
      const version = revision, observed = latestBrowserLayout(page);
      pendingHolds++;
      let identity;
      try {
        identity = await retainTrustedNode(handle);
        if (!live() || revision !== version || latestBrowserLayout(page) !== observed || holders.size >= 512) { await identity.release(); return; }
        const held = retainLayoutNode(observed, identity);
        if (!held) { await identity.release(); return; }
        const token = Object.freeze({}), holder = { token, held, identity, page, revision, windowKey: windowKeys[0] };
        bindings.set(token, holder); holders.add(holder); return token;
      } catch { if (identity) await identity.release(); }
      finally { pendingHolds--; }
    },
    admit(frame, prefix, { page, held } = {}) {
      if (!live()) return false;
      const seq = channel.admit(frame, prefix);
      if (seq !== false) {
        const holder = bindings.get(held);
        references.set(seq, { page, held: frame.kind !== 'drag' && holder?.revision === revision && holder.page === page ? holder.held : undefined, windowKey: holder?.windowKey });
        pendingInput.add(seq);
      }
      return seq;
    },
    inputStarted() {
      if (!live()) return;
      startedInput = true;
      if (pendingInput.size >= 512) { lostInput = true; return; }
      const token = Object.freeze({}); pendingInput.add(token); return token;
    },
    inputFinished(seq) {
      if (!live() || !pendingInput.delete(seq)) return false;
      inputBarrier = performance.now(); return true;
    },
    invalidate(reason) { return live() ? channel.invalidate(reason) : false; },
    endTurn() {
      live();
      if (!turn || ending || channel.state.pending) return false;
      const queued = channel.endTurn();
      if (queued !== false) clear(true);
      return queued;
    },
    close() { clear(); closed = true; },
    get state() { live(); return { turn, ending, references: references.size, held: holders.size, windows: windows.size, pendingInput: pendingInput.size }; },
  });
}

const KINDS = { click: 'click', check: 'click', uncheck: 'click', select: 'click', navigate: 'click', type: 'type', press: 'key', drag: 'drag', scroll: 'scroll' };
const EVENT_KINDS = { ...KINDS, select: 'select', navigate: 'navigate', paste: 'type', hover: 'move', move: 'move', back: 'navigate', forward: 'navigate', reload: 'navigate', upload: 'select' };
const MAX_TYPE_BEATS = 8, BOX_TIMEOUT_MS = 300, LOCATE_TIMEOUT_MS = 2000, GEOMETRY_MS = 1500;

// Runs in the page's trusted utility world through trustedLocatorRead (closure-free, like act.mjs's readers).
export function pageMetrics(el, unused, read) {
  const doc = read(el, 'ownerDocument'), win = read(doc, 'defaultView'), vv = read(win, 'visualViewport');
  return { screenX: read(win, 'screenX'), screenY: read(win, 'screenY'), outerWidth: read(win, 'outerWidth'), outerHeight: read(win, 'outerHeight'),
    innerWidth: read(win, 'innerWidth'), innerHeight: read(win, 'innerHeight'), dpr: read(win, 'devicePixelRatio'),
    visible: read(doc, 'visibilityState') === 'visible', focusOnBody: !read(doc, 'activeElement') || read(doc, 'activeElement') === read(doc, 'body'),
    vv: vv ? { offsetLeft: vv.offsetLeft, offsetTop: vv.offsetTop, scale: vv.scale } : null };
}

const finite = (...values) => values.every(Number.isFinite);
// The page's zoom: window points per CSS pixel. innerWidth is a whole number, so a devicePixelRatio that is a whole
// display scale (1, 2 or 3) times the measured zoom gives the exact one.
function zoomOf(m) {
  const measured = m.outerWidth / m.innerWidth;
  const scale = Math.round(m.dpr / measured);
  return Number.isFinite(m.dpr) && [1, 2, 3].includes(scale) && Math.abs(m.dpr / scale - measured) < 0.01 ? m.dpr / scale : measured;
}

// One frame for an operation, { skip } with the reason, or undefined for an operation the hand doesn't show.
// geometry is locate.js's answer for the browser window's bounds ({ window, windows, displays, state }).
// Why the page alone rules the hand out, before any box or window is read.
function pageSkip(kind, m) {
  if (!m || !finite(m.screenX, m.screenY, m.outerWidth, m.outerHeight, m.innerWidth, m.innerHeight) || m.outerWidth <= 0 || m.innerWidth <= 0) return 'no-geometry';
  if (!m.visible) return 'hidden-tab';
  if (kind === 'key' && m.focusOnBody) return 'no-focus';
  return undefined;
}

export function planBrowserFrame({ op, text, box, toBox, metrics: m, geometry, ignorePids = [] } = {}) {
  const kind = KINDS[op];
  if (!kind) return undefined;
  const page = pageSkip(kind, m);
  if (page) return { skip: page };
  if (geometry?.state) return { skip: geometry.state };
  if (!geometry?.ok || !geometry.window?.bounds) return { skip: 'no-geometry' };
  const zoom = zoomOf(m), originY = m.screenY + m.outerHeight - m.innerHeight * zoom;
  const vv = m.vv && finite(m.vv.offsetLeft, m.vv.offsetTop, m.vv.scale) && m.vv.scale > 0 ? m.vv : { offsetLeft: 0, offsetTop: 0, scale: 1 };
  const toScreen = (x, y) => [m.screenX + (x - vv.offsetLeft) * vv.scale * zoom, originY + (y - vv.offsetTop) * vv.scale * zoom].map(n => Math.round(n * 100) / 100);
  const centre = b => b && finite(b.x, b.y, b.width, b.height) ? [b.x + b.width / 2, b.y + b.height / 2] : undefined;
  // A box scrolled out of the viewport, or read before the click scrolled it in, would map onto the toolbar or address
  // bar, which is still inside the window: only a centre in the visible viewport gets a hand.
  const visible = ([x, y]) => x - vv.offsetLeft >= 0 && x - vv.offsetLeft < m.innerWidth / vv.scale && y - vv.offsetTop >= 0 && y - vv.offsetTop < m.innerHeight / vv.scale;
  // A scroll with no ref scrolls the viewport, so the hand goes to its middle.
  const from = kind === 'scroll' && box === undefined ? [vv.offsetLeft + m.innerWidth / vv.scale / 2, vv.offsetTop + m.innerHeight / vv.scale / 2] : centre(box);
  const end = kind === 'drag' ? centre(toBox) : undefined;
  if (!from || (kind === 'drag' && !end)) return { skip: 'no-box' };
  if (!visible(from) || (end && !visible(end))) return { skip: 'offscreen' };
  const at = toScreen(...from), to = end && toScreen(...end);
  const reason = exposure(at, geometry.window, geometry.windows, geometry.displays, ignorePids) ??
    (to ? exposure(to, geometry.window, geometry.windows, geometry.displays, ignorePids) : undefined);
  if (reason) return { skip: reason };
  const beats = kind === 'type' ? Math.max(1, Math.min(MAX_TYPE_BEATS, typeof text === 'string' ? text.length : 3)) : 1;
  return { frame: { kind, pid: geometry.window.pid, windowId: geometry.window.windowId, at,
    windowRect: [geometry.window.bounds.X, geometry.window.bounds.Y, geometry.window.bounds.Width, geometry.window.bounds.Height], path: to ? [at, to] : [at], delayMs: 0, beats } };
}

const boxOf = async locator => {
  try { return typeof locator?.boundingBox === 'function' ? await locator.boundingBox({ timeout: BOX_TIMEOUT_MS }) : null; } catch { return null; }
};
const withTimeout = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); timer.unref?.(); })]).finally(() => clearTimeout(timer));
};

export function createBrowserHand({ client, loadClient = () => import('./client.mjs'), clientOptions = {}, locate,
  readMetrics = page => trustedLocatorRead(page.locator('html'), pageMetrics), trace = () => {}, now = () => performance.now(),
  defer = fn => setImmediate(fn), env = process.env, setting = handSettingReader(env), events, record = cursorRecord,
  geometryProducer, geometryContext = () => undefined } = {}) {
  setting = createHandSettingReader({ setting });
  if (env.SLEIGHT_HAND === '0' || !(setting().enabled || setting().stream || setting().record_runs) || typeof locate !== 'function') return undefined;
  let closed = false, resolved = client ?? undefined, loading;
  const load = () => loading ??= (client ? Promise.resolve(client) : Promise.resolve().then(loadClient).then(m => m.createHandClient(clientOptions)))
    .then(c => (resolved = c && typeof c.send === 'function' ? c : null), () => (resolved = null));
  const stream = () => { try { return events ? events.enabled : setting().stream === true || setting().record_runs === true || cursorDrawing(setting()); } catch { return false; } };
  const live = () => !closed && (resolved && resolved.enabled !== false || stream());
  const publish = (token, phase, reason) => {
    if (!token?.cursor || closed) return;
    const record = { ...token.record, ...token.cursor, phase, ...(reason ? { reason: cursorReason(reason) } : {}) };
    try { if (events) events.action(record); else resolved?.event?.(record); } catch {}
  };
  // The window's geometry for a burst of steps: one helper run per window position every 1.5 s, shared while it runs.
  const retries = createRetryMarks({ now }), pageIds = new WeakMap(); let pageNumber = 0;
  const pageId = page => { if (!page || typeof page !== 'object') return; if (!pageIds.has(page)) pageIds.set(page, ++pageNumber); return pageIds.get(page); };
  const waiters = new Set();
  const status = (state, detail) => { try { if (events) events.status(state, { detail }); else resolved?.status?.(state, { detail }); } catch {} };
  let cached;
  function geometryFor(bounds) {
    const key = [bounds.X, bounds.Y, bounds.Width, bounds.Height].join(',');
    if (cached?.key === key && now() - cached.at < GEOMETRY_MS) return cached.promise;
    const promise = withTimeout(Promise.resolve().then(() => locate({ bounds })), LOCATE_TIMEOUT_MS).catch(() => undefined);
    cached = { key, at: now(), promise };
    return promise;
  }
  async function show({ op, page, locator, to, text, role, inputType, title, description }, token) {
    if (resolved === undefined && setting().enabled) await load();
    if (!live()) return;
    const skip = reason => { publish(token, 'skipped', reason); token.skipped = true; trace('hand-skipped', { op, reason }); };
    if (!KINDS[op]) return skip('unplanned');
    let metrics;
    try { metrics = await readMetrics(page); } catch { return skip('no-geometry'); }
    if (!live()) return;
    const blocked = pageSkip(KINDS[op], metrics);
    if (blocked) return skip(blocked);
    const bounds = { X: metrics.screenX, Y: metrics.screenY, Width: metrics.outerWidth, Height: metrics.outerHeight };
    const [box, toBox, geometry] = await Promise.all([op === 'scroll' && !locator ? undefined : boxOf(locator), op === 'drag' ? boxOf(to) : undefined, geometryFor(bounds)]);
    if (!live()) return;
    const planned = planBrowserFrame({ op, text, box, toBox, metrics, geometry, ignorePids: [resolved?.pid].filter(Number.isSafeInteger) });
    if (planned?.skip) return skip(planned.skip);
    if (geometryProducer?.state.turn !== token.geometryTurn) return skip('no-geometry');
    if (planned?.frame) {
      let label, wrap;
      if (token.cursor) try {
        const scale = zoomOf(metrics) * (metrics.vv?.scale > 0 ? metrics.vv.scale : 1);
        const rect = box && [planned.frame.at[0] - box.width * scale / 2, planned.frame.at[1] - box.height * scale / 2, box.width * scale, box.height * scale];
        token.record = record({ frame: planned.frame, action: { kind: EVENT_KINDS[op], retry: token.record?.retry, transfer: token.record?.transfer, role, inputType, title, description,
          rect, secure: EVENT_KINDS[op] === 'type' && !inputType }, geometry, labels: events?.labels ?? setting().labels ?? 'off' });
        label = token.record.label; wrap = token.record.rect;
        if (!geometryProducer?.state.turn) publish(token, 'aim');
        publish(token, 'act'); token.shown = true;
        if (token.ended) publish(token, token.failed ? 'failed' : 'done');
      } catch {}
      try {
        const frame = { ...planned.frame, ...token.record?.retry === true ? { retry: true } : {}, ...token.record?.transfer ? { transfer: token.record.transfer } : {}, ...token.cursor?.say ? { say: token.cursor.say } : {}, ...cursorDrawing(setting()) ? { ...label ? { label } : {}, ...wrap ? { rect: wrap } : {} } : {} };
        if (geometryProducer?.state.turn) {
          token.geometrySequence = geometryProducer.admit(frame, token.geometryContext?.prefix, { page, held: token.geometryContext?.held });
          if (token.ended && token.geometrySequence !== false) geometryProducer.inputFinished(token.geometrySequence);
        } else resolved?.send(frame);
        trace('hand-shown', { op, kind: planned.frame.kind });
      } catch {}
    }
  }
  return {
    // input: { op, page, locator, to, ref, text }, as act.mjs has them when the step's input starts.
    pageWait() {
      if (closed || !stream()) return () => {};
      let shown = false;
      const timer = setTimeout(() => { waiters.delete(stop); if (!closed) { shown = true; status('thinking', 'page'); } }, 2000);
      timer.unref?.();
      const stop = () => { clearTimeout(timer); waiters.delete(stop); if (shown && !closed) status('thinking'); };
      waiters.add(stop); return stop;
    },
    step(input) {
      try {
        if (closed || !input || !EVENT_KINDS[input.op]) return;
        const token = { geometryTurn: geometryProducer?.state.turn };
        if (geometryProducer?.state.turn) {
          token.geometryInput = geometryProducer.inputStarted?.();
          token.geometryContext = geometryContext(input);
        }
        if (stream()) try {
          token.cursor = cursorStep();
          token.record = record({ action: { kind: EVENT_KINDS[input.op], retry: retries.mark(EVENT_KINDS[input.op], pageId(input.page), input.ref),
            transfer: input.op === 'press' ? transferMark(input.key) : undefined, role: input.role, inputType: input.inputType, secure: EVENT_KINDS[input.op] === 'type' && !input.inputType } });
        } catch {}

        if (!setting().enabled && !setting().stream) {
          publish(token, 'aim'); publish(token, 'act'); token.shown = true; return token;
        }
        defer(() => show(input, token).catch(() => { publish(token, 'skipped', 'no-geometry'); }));
        return token;
      } catch { /* The hand never reaches the act path. */ }
    },
    finish(token, failed = false) {
      if (!token || token.ended) return;
      token.ended = true; token.failed = failed;
      if (token.geometryInput) geometryProducer?.inputFinished(token.geometryInput);
      if (token.geometrySequence !== undefined && token.geometrySequence !== false) geometryProducer?.inputFinished(token.geometrySequence);
      if (token.shown && !token.skipped) publish(token, failed ? 'failed' : 'done');
    },
    skipped(input, reason = 'unplanned') {
      if (closed || !EVENT_KINDS[input?.op] || !stream()) return;
      const token = { cursor: cursorStep(), record: cursorRecord({ action: { kind: EVENT_KINDS[input.op], secure: true } }) };
      publish(token, 'skipped', reason);
    },
    close() { closed = true; for (const stop of waiters) stop(); retries.clear(); try { resolved?.close(); } catch {} },
  };
}

// Where the worker's hand events go: the relay's trace file (SLEIGHT_TRACE, see launch.mjs), named by the parent's pid as
// worker.mjs's traceLoss does. An event holds the operation and a fixed reason or kind, never page content.
const HAND_EVENTS = new Set(['hand-skipped', 'hand-shown']);
// The skip reasons planBrowserFrame, exposure and locate.js give. Anything else is written as 'other'.
const SKIP_REASONS = new Set(['hidden-tab', 'no-focus', 'no-geometry', 'no-box', 'offscreen', 'covered', 'other-space', 'side-stage', 'hidden']);
export function workerHandTrace({ setting = process.env.SLEIGHT_TRACE, parentPid = process.ppid, now = Date.now,
  append = (file, line) => appendFileSync(file, line, { mode: 0o600 }), home = homedir } = {}) {
  if (!setting || !Number.isSafeInteger(parentPid) || parentPid < 1) return () => {};
  const file = join(setting === '1' ? join(home(), 'Library', 'Logs', 'sleight') : setting, `trace-${parentPid}.jsonl`);
  return (direction, msg) => {
    if (!HAND_EVENTS.has(direction)) return;
    const fields = { op: typeof msg?.op === 'string' && Object.hasOwn(KINDS, msg.op) ? msg.op : 'other',
      ...(direction === 'hand-skipped' ? { reason: SKIP_REASONS.has(msg?.reason) ? msg.reason : 'other' } : {}),
      ...(direction === 'hand-shown' && typeof msg?.kind === 'string' && Object.values(KINDS).includes(msg.kind) ? { kind: msg.kind } : {}) };
    try { append(file, JSON.stringify({ t: new Date(now()).toISOString(), direction, msg: fields }) + '\n'); } catch {}
  };
}

// Inherited IPC sends frames to the relay's one client. The worker never starts another host.
export function workerHandClient(channel, pid, { env = process.env, setting = handSettingReader(env), now = Date.now, sharedUi = true } = {}) {
  setting = createHandSettingReader({ setting, now });
  let checked = -Infinity, enabled = false;
  // Recheck at the next use after 250 ms, including before page reads. No idle timer or extra host is needed.
  const live = () => {
    const at = now();
    if (at < checked || at - checked >= 250) {
      checked = at;
      try { const s = setting(); enabled = env.SLEIGHT_HAND !== '0' && (sharedUi && s?.enabled === true || s?.stream === true || s?.record_runs === true || cursorDrawing(s)); } catch { enabled = false; }
    }
    return enabled && channel.connected !== false;
  };
  return { get enabled() { return live() && sharedUi && setting().enabled === true; }, pid,
    send(frame) { if (sharedUi && live() && setting().enabled) try { channel.send({ version: 3, hand: frame }); } catch {} },
    status(state, detail) { if (live()) try { channel.send({ version: 3, cursorStatus: { state, ...detail } }); } catch {} },
    event(record) { if (live() && (setting().stream || setting().record_runs || cursorDrawing(setting()))) try { channel.send({ version: 3, cursor: record }); } catch {} },
    close() {} };
}

// One hand planner per worker, with a lazy persistent utility helper for Window Server geometry.
let shared;
export function sharedBrowserHand(env = process.env, { setting = handSettingReader(env) } = {}) {
  if (shared !== undefined) return shared ?? undefined;
  const helper = createAppHealthHelper();
  const sharedUi = process.argv.includes('--shared-ui') && typeof process.send === 'function';
  const pid = Number(process.argv.find(arg => arg.startsWith('--shared-hand-pid='))?.split('=')[1]);
  const client = typeof process.send === 'function' ? workerHandClient(process, Number.isSafeInteger(pid) && pid > 0 ? pid : undefined, { env, setting, sharedUi }) : undefined;
  shared = createBrowserHand({ env, setting, client, locate: request => helper.handLocate(request), trace: workerHandTrace({ setting: env.SLEIGHT_TRACE }) }) ?? null;
  if (shared) process.once('exit', () => helper.close());
  return shared ?? undefined;
}
