// The relay owns one consent-capable ghost hand host per session. Turbo workers inherit its consent pipes, and browser
// artwork comes back over worker IPC to this same client. The parent's copies keep the host alive between workers. send and hide
// are fire-and-forget pipe writes that never throw or wait. A failed host traces; a paused session gets one replacement
// control with the same pause, and a running session goes on without a hand. A cold build runs off the caller's path and starts the hand in this session when ready.
//
// Caller frames: { kind, pid, windowId, at: [x, y], path: [[x, y], ...], delayMs, beats } in global top-left screen points
// (kCGWindowBounds and AX frames). kind is click, double, right, key, type, drag or scroll. The hand glides along path into at
// and flourishes there beats times; a drag grabs at at and carries along path. path defaults to [at], delayMs to 0 and beats to 1.
import { createEdgeChips } from './edge-chips.mjs';
import { narrationLine } from '../../hooks/narration.mjs';
import { randomBytes } from 'node:crypto';
import { MAC_DRIVER_LOCAL_ERRORS } from '../mac-driver/errors.mjs';
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync, watch as fsWatch } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { CURSOR_STYLES as handCursorStyles } from './settings.mjs';
import { getPlatform } from '../platform/index.mjs';
import { characterIdValid, characterSizeValid, CHARACTER_SIZES, DEFAULT_CHARACTER_SIZE, handConfigPath, handSetting } from './settings.mjs';
import { characterFrame } from './character-frame.mjs';
import { createCharacterStageCache } from './character-stage.mjs';
import { setHandPid } from './pid.mjs';
import { currentApp as noted } from '../permissions.mjs';
import { actionLogPath } from '../action-outcomes.mjs';

const kinds = new Set(['click', 'double', 'right', 'key', 'type', 'drag', 'scroll']);
const round = value => Math.round(value * 100) / 100;
const point = value => Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100000)
  ? [round(value[0]), round(value[1])] : undefined;
const id = (value, max) => Number.isSafeInteger(value) && value >= 1 && value <= max ? value : undefined;
// A longer path keeps its ends and 62 evenly spaced points between them.
const thin = path => path.length <= 64 ? path : Array.from({ length: 64 }, (_, i) => path[Math.round(i * (path.length - 1) / 63)]);
// The version the hand's menu block shows.
const version = (() => {
  try {
    const { version } = JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
    return /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version) ? version : '0.0.0';
  } catch { return '0.0.0'; }
})();

/** The host's frame for a caller frame, without nonce or seq, or a reason string when it can't be drawn. */
export function handWireFrame(frame) {
  if (frame?.hand === 'wide') {
    const pid = id(frame.pid, 2147483647), windowId = id(frame.windowId, 4294967295);
    const app = typeof frame.app === 'string' && frame.app.length > 0 && frame.app.length <= 160 &&
      !/[\p{C}\p{Zl}\p{Zp}]/u.test(frame.app) ? frame.app : undefined;
    if ((!pid && !app) || frame.pid !== undefined && !pid || frame.windowId !== undefined && (!pid || !windowId) ||
        !Number.isSafeInteger(frame.epoch) || frame.epoch < 0 || !['read', 'unlocated', 'scroll', 'drag', 'acquisition'].includes(frame.reason) ||
        ['at', 'path', 'rect', 'windowRect'].some(k => frame[k] !== undefined)) return 'wide';
    return { hand: 'wide', ...pid ? { pid } : { app }, ...windowId ? { windowId } : {}, reason: frame.reason, epoch: frame.epoch };
  }
  if (!frame || typeof frame !== 'object' || frame.hand !== undefined && !['act', 'aim', 'status'].includes(frame.hand)) return 'kind';
  const extra = frame.hand === 'aim' || frame.hand === 'status';
  if (!extra && !kinds.has(frame.kind)) return 'kind';
  const area = frame.hand === 'status' && ['window', 'app'].includes(frame.area) ? frame.area : undefined;
  if (frame.area !== undefined && (!area || frame.at !== undefined)) return 'area';
  const pid = id(frame.pid, 2147483647), windowId = area === 'app' && frame.windowId === 0 ? 0 : id(frame.windowId, 4294967295), at = point(frame.at);
  if (!pid || windowId === undefined || (!at && frame.hand !== 'status')) return 'target';
  const windowRect = frame.windowRect;
  const validWindow = Array.isArray(windowRect) && windowRect.length === 4 &&
    windowRect.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100000) && windowRect[2] > 0 && windowRect[3] > 0;
  const measured = validWindow ? { windowRect: windowRect.map(round) } : {};
  const say = narrationLine(frame.say);
  const spoken = say ? { say } : {};
  const marks = { ...typeof frame.retry === 'boolean' ? { retry: frame.retry } : {}, ...frame.kind === 'key' && ['take', 'give'].includes(frame.transfer) ? { transfer: frame.transfer } : {} };
  const detail = ['approval', 'payment', 'page', 'handoff', 'person'].includes(frame.detail) ? { detail: frame.detail } : {};
  const label = typeof frame.label === 'string' && !/[\x00-\x1f\x7f]/.test(frame.label) ? [...frame.label].slice(0, 40).join('') : undefined;
  if (frame.hand === 'status') return ['waiting', 'error', 'done', 'handback', 'thinking', 'paused'].includes(frame.state)
    ? { hand: 'status', ...measured, state: frame.state, ...area ? { area } : {}, ...detail, pid, windowId, ...spoken, ...at ? { at } : {}, ...frame.state === 'done' && typeof frame.ok === 'boolean' ? { ok: frame.ok } : {} } : 'state';
  const rect = Array.isArray(frame.rect) && frame.rect.length === 4 && frame.rect.every(v => Number.isFinite(v) && Math.abs(v) <= 100000) && frame.rect[2] > 0 && frame.rect[3] > 0 ? frame.rect.map(round) : undefined;
  if (frame.hand === 'aim') {
    // The host's aim draws the same for every kind and its kind list has no move, so a move aim goes as click.
    if (frame.kind !== 'move' && !kinds.has(frame.kind)) return 'kind';
    return { hand: 'aim', ...measured, ...marks, ...spoken, kind: frame.kind === 'move' ? 'click' : frame.kind, pid, windowId, at, holdMs: 0, ...rect ? { rect } : {}, ...label ? { label } : {} };
  }
  const raw = frame.path === undefined || Array.isArray(frame.path) && !frame.path.length ? [frame.at] : frame.path;
  if (!Array.isArray(raw)) return 'path';
  const path = thin(raw).map(point);
  if (path.some(p => !p)) return 'path';
  const delayMs = Math.min(10000, Math.max(0, Math.round(Number.isFinite(frame.delayMs) ? frame.delayMs : 0)));
  const beats = Math.min(20, Math.max(1, Math.round(Number.isFinite(frame.beats) ? frame.beats : 1)));
  // caretX: the type or key caret's x in global points, which the ring's bottom gap rides.
  const caretX = ['type', 'key'].includes(frame.kind) && Number.isFinite(frame.caretX) && Math.abs(frame.caretX) <= 100000 ? round(frame.caretX) : undefined;
  return { kind: frame.kind, ...measured, ...marks, pid, windowId, at, ...spoken, path, delayMs, beats, ...label ? { label } : {}, ...rect ? { rect } : {}, ...caretX !== undefined ? { caretX } : {} };
}

// The process's latest open client: turbo's bridge shares its host.
let current;
const sharing = new WeakMap();
// Parent-owned capability. It is deliberately absent from client.send, cursor events and worker IPC.
const geometryChannels = new WeakMap();
export function privateHandGeometry(client) { return geometryChannels.get(client); }
const geometryToken = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const geometryInteger = value => Number.isSafeInteger(value) && value >= 0;
const geometryPrefix = value => value && Object.keys(value).sort().join() === 'action,attempt,call,ordinal' &&
  geometryToken(value.call) && ['action', 'attempt', 'ordinal'].every(k => geometryInteger(value[k]) && value[k] > 0);
const geometryRect = r => Array.isArray(r) && r.length === 4 && r.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100000) && r[2] > 0 && r[3] > 0;
// The line cap includes the newline. Outward unions never make a protected fragment smaller.
function packGeometry(frame) {
  let line = JSON.stringify(frame) + '\n';
  if (Buffer.byteLength(line) <= 65536) return line;
  const references = frame.geometry.references.map(ref => {
    if (ref.departed) return ref;
    const x = Math.floor(Math.min(...ref.rects.map(r => r[0]))), y = Math.floor(Math.min(...ref.rects.map(r => r[1])));
    const right = Math.ceil(Math.max(...ref.rects.map(r => r[0] + r[2]))), bottom = Math.ceil(Math.max(...ref.rects.map(r => r[1] + r[3])));
    return { ...ref, rects: [[x, y, right - x, bottom - y]] };
  });
  if (references.some(ref => ref.rects.some(r => !geometryRect(r)))) return undefined;
  line = JSON.stringify({ ...frame, geometry: { ...frame.geometry, references } }) + '\n';
  return Buffer.byteLength(line) <= 65536 ? line : undefined;
}
/** Private, collection-only producer transport. A capture is an opaque acquisition ticket, never wire JSON.
 * @typedef {{call: string, action: number, attempt: number, ordinal: number}} GeometryPrefix
 * @typedef {{seq: number, rects: number[][], departed: boolean}} GeometryReference
 * @typedef {{pid: number, windowId: number, incarnation: string, contentGeneration: number,
 *   mode: 'baseline'|'move'|'scroll'|'layout', bounds: number[], references: GeometryReference[]}} GeometryCertificate
 * @typedef {'layout'|'resize'|'typing'|'navigation'|'ambient'|'scroll'} GeometryInvalidation
 */
function createGeometryChannel({ nonce, allocate, running, write, project, rememberTarget, failed, clock = () => performance.now() }) {
  const pending = new Map(), admitted = new Map(), ended = new Map();
  let session, turn, closing, closingTimer, captures = new WeakMap(), poisoned = false, epoch = 0, serial = 0, after = -1, prefix = null, begun = false, ending = false, barrier = 0;
  const idle = () => {
    if (session && turn) ended.set(session, turn);
    if (ended.size > 512) ended.delete(ended.keys().next().value);
    for (const item of pending.values()) clearTimeout(item.timer);
    clearTimeout(closingTimer); closingTimer = undefined;
    pending.clear(); admitted.clear(); captures = new WeakMap();
    session = turn = closing = undefined; poisoned = begun = ending = false;
    epoch = serial = barrier = 0; after = -1; prefix = null;
  };
  const poison = () => {
    if (poisoned || !turn) return;
    poisoned = true;
    for (const item of pending.values()) clearTimeout(item.timer);
    pending.clear();
    if (running() && turn) write(JSON.stringify({ hand: 'stage-producer', nonce, seq: allocate(), session, turn, op: 'fault' }) + '\n', { urgent: true });
    failed();
  };
  const protectRefusedTarget = wire => {
    poison();
    if (running() && wire && typeof wire !== 'string' && wire.hand !== 'status') {
      rememberTarget(wire);
      write(JSON.stringify({ hand: 'act', ...wire, nonce, seq: allocate() }) + '\n', { urgent: true });
    }
    return false;
  };
  function send(op, body = {}) {
    const closingStatus = op === 'public' && terminal(body.frame);
    if (poisoned && op !== 'public' || !running() || !turn || pending.size >= 512 && !closingStatus) { poison(); return false; }
    if (['begin', 'admit', 'invalidate'].includes(op)) { barrier = clock(); body = { ...body, barrier }; }
    const seq = allocate(), frame = { hand: 'stage-producer', nonce, seq, session, turn, op, ...body };
    const line = op === 'certificate' ? packGeometry(frame) : JSON.stringify(frame) + '\n';
    if (!line || Buffer.byteLength(line) > 65536) { poison(); return false; }
    // The one closing receipt lives in closing, outside the bounded ordinary acknowledgement queue.
    if (!closingStatus) {
      const item = { op, body, timer: setTimeout(poison, 1000) };
      item.timer.unref?.(); pending.set(seq, item);
    } else {
      clearTimeout(closingTimer); closingTimer = setTimeout(poison, 1000); closingTimer.unref?.();
    }
    if (!write(line, { urgent: closingStatus })) { poison(); return false; }
    return seq; // Queued only. Admission is recorded exclusively in acknowledge.
  }
  function acknowledge(event) {
    if (event.nonce === nonce && ended.get(event.session) === event.turn) return;
    if (event.nonce !== nonce || event.session !== session || event.turn !== turn ||
        Object.keys(event).sort().join() !== 'accepted,hand,nonce,op,seq,session,turn' || typeof event.accepted !== 'boolean') { poison(); return; }
    const item = pending.get(event.seq);
    // A terminal may replace the end receipt. Its ack closes even if earlier receipts were lost or remain pending.
    if (ending && !item && event.seq === closing?.seq && event.op === closing.op && event.accepted) { idle(); return; }
    if (!item || pending.keys().next().value !== event.seq || item.op !== event.op || !event.accepted) { poison(); return; }
    clearTimeout(item.timer); pending.delete(event.seq);
    if (item.op === 'begin') begun = true;
    if (item.op === 'admit') admitted.set(event.seq, Object.freeze({ ...item.body.prefix, pid: item.body.frame.pid, windowId: item.body.frame.windowId }));
    if (item.op === 'end' || item.op === 'public' && terminal(item.body.frame)) idle();
  }
  const channel = Object.freeze({
    beginTurn(logicalTurn) {
      // The terminal is already ordered before this begin. Its ack may arrive after the next turn starts.
      if (ending) idle();
      if (turn || !geometryToken(logicalTurn)) { poison(); return false; }
      session = randomBytes(16).toString('hex');
      turn = logicalTurn; epoch = 0; serial = 0; after = -1; prefix = null;
      return send('begin');
    },
    /** @param {object} frame @param {GeometryPrefix} action */
    admit(frame, action) {
      const wire = project(frame);
      if (!begun || ending || typeof wire === 'string' || wire.hand === 'status' || admitted.size + [...pending.values()].filter(item => item.op === 'admit').length >= 512 || !geometryPrefix(action) || action.ordinal !== (prefix?.ordinal ?? 0) + 1) return protectRefusedTarget(wire);
      const seq = send('admit', { prefix: { ...action }, frame: wire });
      if (seq !== false) { after = seq; prefix = Object.freeze({ ...action }); rememberTarget(wire); }
      return seq === false ? protectRefusedTarget(wire) : seq;
    },
    /** @param {GeometryInvalidation} reason */
    invalidate(reason) {
      if (!begun || ending || !['layout', 'resize', 'typing', 'navigation', 'ambient', 'scroll'].includes(reason)) { poison(); return false; }
      return send('invalidate', { epoch: ++epoch, after, prefix, reason });
    },
    capture({ start, end } = {}) {
      if (!begun || ending || poisoned || pending.size || ![start, end].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) || start > end || start < barrier || end > clock()) return undefined;
      const ticket = Object.freeze({});
      captures.set(ticket, { session, turn, epoch, after, prefix, observation: ++serial, acquired: [start, end] });
      return ticket;
    },
    /** @param {object} ticket @param {GeometryCertificate} geometry */
    certify(ticket, geometry) {
      const observation = captures.get(ticket);
      if (!observation || observation.session !== session || observation.turn !== turn || poisoned || ending || pending.size || observation.epoch !== epoch || observation.after !== after || observation.prefix !== prefix) { poison(); return false; }
      captures.delete(ticket);
      const refs = geometry?.references;
      if (!geometry || Object.keys(geometry).sort().join() !== 'bounds,contentGeneration,incarnation,mode,pid,references,windowId' ||
          !id(geometry.pid, 2147483647) || !id(geometry.windowId, 4294967295) || !geometryToken(geometry.incarnation) ||
          !geometryInteger(geometry.contentGeneration) || !['baseline', 'move', 'scroll', 'layout'].includes(geometry.mode) || !geometryRect(geometry.bounds) ||
          !Array.isArray(refs) || refs.length > 512 || refs.some(ref => !ref || Object.keys(ref).sort().join() !== 'departed,rects,seq' ||
            !geometryInteger(ref.seq) || typeof ref.departed !== 'boolean' || !Array.isArray(ref.rects) || ref.rects.length > 4 ||
            (ref.departed ? ref.rects.length !== 0 : ref.rects.length === 0) || !ref.rects.every(geometryRect)) || new Set(refs.map(r => r.seq)).size !== refs.length) { poison(); return false; }
      const expected = [...admitted].filter(([, r]) => r.pid === geometry.pid && r.windowId === geometry.windowId).map(([seq]) => seq);
      if (geometry.mode === 'baseline' ? admitted.size !== 0 || after !== -1 || refs.length !== 0 :
          expected.length !== refs.length || !refs.every(r => expected.includes(r.seq))) { poison(); return false; }
      const { session: capturedSession, turn: capturedTurn, ...proof } = observation;
      return send('certificate', { ...proof, geometry });
    },
    endTurn() {
      if (ending) return false;
      if (!begun || pending.size) { poison(); return false; }
      const seq = send('end');
      if (seq !== false) { ending = true; closing = { seq, op: 'end' }; }
      return seq;
    },
    get state() { return { session, turn, active: turn !== undefined, poisoned, pending: pending.size, epoch, after, prefix, admitted: [...admitted].map(([seq, ref]) => ({ seq, ...ref })) }; },
  });
  const terminal = frame => frame.hand === 'status' && (frame.state === 'handback' || frame.state === 'done' && frame.ok !== true);
  return { channel, acknowledge, poison,
    publicFrame(wire) {
      // A refused private frame must still reach ordinary host admission on the plain wire.
      if (wire.hand !== 'status') { poison(); return false; }
      const seq = send('public', { frame: wire });
      if (seq !== false && terminal(wire)) { ending = true; closing = { seq, op: 'public' }; }
      return seq;
    },
    // A caller's private logical token is consumed here and never projected onto the public wire.
    stale(frame) { return frame?.turn !== undefined && frame.turn !== turn; },
    droppedTerminal(frame) { if (!this.stale(frame) && terminal(frame)) idle(); },
    quarantine() {
      if (turn && running()) write(JSON.stringify({ hand: 'stage-producer', nonce, seq: allocate(), session, turn, op: 'fault' }) + '\n', { urgent: true });
    }, get active() { return turn !== undefined; }, get ending() { return ending; }, get poisoned() { return poisoned; } };
}

/** Turbo's bridge, right before it forks its worker: a consent channel to the session's host as { write, read, release }. It
 *  starts the host even with the hand off. No open client or an unavailable host returns undefined for turbo's fallback. */
export async function shareConsent() {
  const share = current && sharing.get(current);
  return share ? share() : undefined;
}
/** The ghost hand's integration point: the session's one client for the relay and its hooks, created on the first call and
 *  the same one after (while open), and none while the settings keep it off. The launcher creates it at startup, so turbo's first fork
 *  can share its host. */
export function sessionHandClient(options = {}) {
  try {
    const env = options.env ?? process.env;
    const setting = (options.setting ?? (() => handSetting({ env })))();
    if (env.SLEIGHT_HAND === '0' || !setting.enabled) return undefined;
    if (current) return current;
    const cursorStyle = options.cursorStyle ?? setting.style, character = options.character ?? setting.character;
    try { return createHandClient({ ...options, cursorStyle, ...character !== undefined ? { character } : {} }); }
    catch (error) {
      // A style the host can't draw never stops the session: it traces and shows the glove.
      try { options.trace?.('hand-style-invalid', { code: error?.message === 'HAND_CURSOR_STYLE_INVALID' ? error.message : 'HAND_CLIENT_FAILED' }); } catch {}
      return createHandClient({ ...options, cursorStyle: 'glove' });
    }
  } catch { return undefined; }
}
// The sprite style's installed character, as VC3 validates it, and VC3's resolver for characterFrame. Loaded on launch only.
const installedSprite = async id => {
  const { checkCharacter, resolveCharacterStates } = await import('./character.mjs');
  return { character: checkCharacter(id), resolve: resolveCharacterStates };
};

// Owner decision 7. ST10 owns the saved cast setting; an absent or empty cast keeps the selected character.
export const SESSION_CAST_ROTATION = true;
const sessionAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; return true; }
};
const sessionSafe = (s, directory = false) => s.uid === process.getuid() && (s.mode & 0o7777) === (directory ? 0o700 : 0o600) &&
  (directory ? s.isDirectory() : s.isFile() && s.nlink === 1);
const sessionSame = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sessionStartValid = value => typeof value === 'string' && value.length <= 128 && Number.isFinite(Date.parse(value));
function sessionRead(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!sessionSafe(stat) || stat.size > 1024 || !sessionSame(stat, lstatSync(path))) throw Error('HAND_SESSION_UNSAFE');
    const v = JSON.parse(readFileSync(fd, 'utf8'));
    if (!v || Object.keys(v).sort().join() !== 'badge,character,pid,startTime,token,version' || v.version !== 2 || !sessionStartValid(v.startTime) ||
      !Number.isSafeInteger(v.pid) || v.pid < 1 || v.pid > 2147483647 || !characterIdValid(v.character) ||
      !/^[A-Z]$/.test(v.badge) || !/^[a-f0-9]{32}$/.test(v.token)) throw Error('HAND_SESSION_UNSAFE');
    return v;
  } catch (error) { if (error.code === 'ENOENT') throw error; throw Error('HAND_SESSION_UNSAFE'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
/** Private session receipts, serialized by a crash-released SQLite lock. The coordinator stays in place, so no
 * two allocators can lock different inodes after an owner dies. Receipts hold only identity and cast allocation. */
export async function claimHandSession({ root = join(dirname(handConfigPath()), 'cursor', 'sessions'), pid = process.pid,
  cast, alive = sessionAlive, started } = {}) {
  if (!isAbsolute(root) || normalize(root) !== root || !Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647 ||
    !Array.isArray(cast) || !cast.length || cast.length > 32 || !cast.every(characterIdValid)) throw Error('HAND_SESSION_UNSAFE');
  cast = [...new Set(cast)];
  const { processStartTime } = await import('../routine-lock.mjs');
  started ??= processStartTime;
  const startTime = started(pid);
  if (!sessionStartValid(startTime)) throw Error('HAND_SESSION_UNSAFE');
  let parent = root;
  while (true) {
    try { if (realpathSync(parent) !== parent) throw Error('HAND_SESSION_UNSAFE'); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; parent = dirname(parent); }
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root || !sessionSafe(lstatSync(root), true)) throw Error('HAND_SESSION_UNSAFE');
  const coordinator = join(root, '.allocation.sqlite');
  try { const fd = openSync(coordinator, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); closeSync(fd); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const identity = lstatSync(coordinator);
  if (!sessionSafe(identity)) throw Error('HAND_SESSION_UNSAFE');
  const { DatabaseSync } = await import('node:sqlite');
  async function locked(work) {
    const db = new DatabaseSync(coordinator);
    let acquired = false;
    try {
      if (!sessionSame(identity, lstatSync(coordinator)) || !sessionSafe(lstatSync(coordinator))) throw Error('HAND_SESSION_UNSAFE');
      db.exec('PRAGMA busy_timeout=0');
      for (let attempt = 0; attempt < 40; attempt++) {
        try { db.exec('BEGIN IMMEDIATE'); acquired = true; break; }
        catch (error) {
          if (error.errcode !== 5 && !/locked|busy/i.test(error.message)) throw error;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
      if (!acquired) throw Error('HAND_SESSION_BUSY');
      return work();
    } finally { try { if (acquired) db.exec('ROLLBACK'); } finally { db.close(); } }
  }
  const liveRecords = () => {
    const live = [];
    for (const name of readdirSync(root).filter(n => /^[1-9][0-9]{0,9}$/.test(n))) {
      const path = join(root, name);
      const stat = lstatSync(path);
      if (!sessionSafe(stat)) throw Error('HAND_SESSION_UNSAFE');
      // A crash can leave a partial receipt. A dead filename owner permits sweeping even without readable JSON.
      if (!alive(Number(name))) { unlinkSync(path); continue; }
      const currentStart = started(Number(name));
      if (!sessionStartValid(currentStart)) throw Error('HAND_SESSION_UNSAFE');
      // Legacy and partial receipts have no usable start. A process born after the write cannot own it.
      // Keep a 2-second margin for ps's whole-second timestamps; age alone never expires a live owner.
      if (Date.parse(currentStart) > stat.mtimeMs + 2000) { unlinkSync(path); continue; }
      const v = sessionRead(path);
      if (String(v.pid) !== name) throw Error('HAND_SESSION_UNSAFE');
      if (Date.parse(v.startTime) !== Date.parse(currentStart)) { unlinkSync(path); continue; }
      live.push(v);
    }
    return live;
  };
  const record = await locked(() => {
    const live = liveRecords();
    if (live.some(v => v.pid === pid)) throw Error('HAND_SESSION_IN_USE');
    const count = name => live.filter(v => v.character === name).length;
    const character = SESSION_CAST_ROTATION ? cast.reduce((best, name) => count(name) < count(best) ? name : best) : cast[0];
    const badge = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find(letter => !live.some(v => v.character === character && v.badge === letter));
    if (!badge) throw Error('HAND_SESSION_FULL');
    const v = { version: 2, pid, startTime, token: randomBytes(16).toString('hex'), character, badge };
    writeFileSync(join(root, String(pid)), JSON.stringify(v) + '\n', { mode: 0o600, flag: 'wx' });
    return v;
  });
  let closed = false;
  return { get character() { return record.character; }, get badge() { return record.badge; },
    async select(character) {
      if (!characterIdValid(character)) throw Error('HAND_SESSION_UNSAFE');
      await locked(() => {
        if (closed) throw Error('HAND_SESSION_CLOSED');
        const live = liveRecords(), own = live.find(v => v.pid === pid);
        if (own?.token !== record.token) throw Error('HAND_SESSION_IN_USE');
        if (record.character === character) return;
        const badge = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find(letter => !live.some(v => v.pid !== pid && v.character === character && v.badge === letter));
        if (!badge) throw Error('HAND_SESSION_FULL');
        const next = { ...record, character, badge }, path = join(root, String(pid)), before = lstatSync(path);
        const fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = fstatSync(fd);
          if (!sessionSafe(stat) || !sessionSame(before, stat)) throw Error('HAND_SESSION_UNSAFE');
          ftruncateSync(fd, 0); writeFileSync(fd, JSON.stringify(next) + '\n');
        } finally { closeSync(fd); }
        Object.assign(record, next);
      });
    }, async close() {
    if (closed) return; closed = true;
    await locked(() => {
      const path = join(root, String(pid));
      try { if (sessionRead(path).token === record.token) unlinkSync(path); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    });
  } };
}

// The files behind the menu's Permissions rows. A change to any of them sends the host a fresh menu frame.
const permissionFiles = new Set(['preapproved.json', 'permissions.json', 'electron-grants.json', 'turbo.json']);
const command = async () => import('../permissions-command.mjs');
// The menu's usage row: the opt-in action log's last 7 days (action-stats.mjs), only while this session writes the log.
const logUsage = env => async () => {
  const path = actionLogPath(env.SLEIGHT_ACTION_LOG);
  return path ? (await import('../action-stats.mjs')).menuUsage({ path }) : undefined;
};
const seconds = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 3600;
/** { native?, turbo?, saved } exactly, with native or turbo, or undefined: each path's median seconds per action. */
export function usageFrame(value) {
  if (!value || typeof value !== 'object' || value.native === undefined && value.turbo === undefined ||
      value.native !== undefined && !seconds(value.native) || value.turbo !== undefined && !seconds(value.turbo) ||
      !(Number.isSafeInteger(value.saved) && value.saved >= 0 && value.saved <= 1e9)) return undefined;
  return { ...value.native !== undefined ? { native: value.native } : {}, ...value.turbo !== undefined ? { turbo: value.turbo } : {}, saved: value.saved };
}

/** `enabled` is true while this session may still show the hand: the settings allow it and the host hasn't failed.
 *  permissions: the menu's Permissions rows (menu() gives { payload, offered }) and their clicks (apply), or null for none.
 *  usage: the menu's usage row ({ native?, turbo?, saved } or undefined), read at most every usageMs, or null for none. */
export function createHandClient({ env = process.env, platform = process.platform, setting = () => handSetting({ env, platform }),
  built = options => getPlatform(platform).nativeHost.built(options), prepare = options => getPlatform(platform).nativeHost.prepare(options),
  openReplay = async (run, first) => (await import('../runs/command.mjs')).runsCommand(['open', run], { atSeq: first, out: () => {} }),
  menuOnly = false, onMenuReady = () => {}, trace = () => {}, onPause = () => {}, now = Date.now, defer = setImmediate, recheckMs = 60000, killAfterMs = 2000,
  setHand = async enabled => (await import('./command.mjs')).writeHandSetting({ enabled }),
  permissions = { menu: async () => (await command()).permissionsMenu(), apply: async (event, offered) => (await command()).applyMenuEvent(event, offered) },
  currentApp = noted, usage = logUsage(env), usageMs = 300000, cursorStyle, character, loadSprite = installedSprite, cursorPicker, stageCache,
  sessionRoot, sessionAlive: alive = sessionAlive, sessionStarted,
  watch = (folder, listener) => getPlatform(platform).hand.supported ? fsWatch(folder, { persistent: false }, listener) : undefined } = {}) {
  if (cursorStyle !== undefined && !handCursorStyles.includes(cursorStyle)) throw Error('HAND_CURSOR_STYLE_INVALID');
  const nonce = randomBytes(32).toString('hex'), queue = [];
  // host: none, starting, running or dead (failed or closed this session; final). hand: the settings allow the hand.
  const recording = () => { try { return setting()?.record_runs === true; } catch { return false; } };
  const chips = createEdgeChips({ now, send: data => { if (host === 'running') write(JSON.stringify({ hand: 'edge', nonce, ...data }) + '\n'); } });
  let seq = 0, child, host = 'none', starting, hand = false, capture = 'hidden', checked = now(), checking = false, events = '', target, wideTarget;
  let style = cursorStyle, narration = 'off', voice;
  let paused = false, closed = false, respawned = false, pauseRequest, restoreRequest, protectionLost = false, unknownApp = false;
  const hintListeners = new Set();
  const clearWaiters = new Map();
  let activityAt = -Infinity;
  // Sprite options (A2): perch mode and the character's lines. The host gets them in one picker frame after a character.
  let perch = false, lines = true, size = DEFAULT_CHARACTER_SIZE, stageAttention = true, optionsSent;
  // The last sprite built and its placement options. Small in trail mode omits the perch keys, so a perch-only fault
  // never refuses that character. Larger sizes always use the placement runtime.
  let spriteSource, spriteOptions;
  let cast, session, sessionAttempted = false;
  let buildController, buildStarted;
  const upgradeController = new AbortController();
  // Hosts with an attached worker are left to finish their consent channel before exiting.
  const attached = new WeakSet();
  let consentClaimed = false, resetting, glideStop;
  const glideStopFailure = () => Object.assign(Error(MAC_DRIVER_LOCAL_ERRORS.HAND_HOST_UNAVAILABLE.message),
    { code: 'HAND_HOST_UNAVAILABLE', delivery: 'not-sent', retry: 'safe' });
  const stopFrame = (phase, state) => JSON.stringify({ hand: 'glide-stop', nonce, token: state.token, phase,
    ...phase === 'begin' ? { pid: state.pid, windowId: state.windowId } : {} }) + '\n';
  const endGlideStop = state => {
    if (glideStop !== state) return;
    glideStop = undefined; clearTimeout(state.timer);
    if (host === 'running') write(stopFrame('end', state), { urgent: true });
  };
  const unavailableGlideStop = state => {
    state.unavailable = true;
    endGlideStop(state);
    state.resolve(state.end);
  };
  const failedGlideStop = state => {
    const error = glideStopFailure();
    endGlideStop(state);
    state.fail(error);
    state.reject(error);
  };
  const resetWaiters = new Map(), narrationChecks = new Map();
  const resetConsent = started => {
    const token = randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { resetWaiters.delete(token); reject(Error('HAND_CONSENT_RESET_TIMEOUT')); }, 2000);
      resetWaiters.set(token, () => { clearTimeout(timer); resetWaiters.delete(token); resolve(); });
      try { started.stdio[3].write(JSON.stringify({ hand: 'consent-reset', nonce, token }) + '\n'); }
      catch (error) { clearTimeout(timer); resetWaiters.delete(token); reject(error); }
    });
  };
  let chain = Promise.resolve();
  const read = () => {
    try {
      const value = setting();
      style ??= handCursorStyles.includes(value?.style) ? value.style : 'glove';
      character ??= value?.character;
      cast ??= value?.cast;
      narration = ['bubbles', 'voice'].includes(value?.narration) ? value.narration : 'off'; voice = value?.voice;
      perch = value?.perch === true; lines = value?.lines !== 'off';
      size = characterSizeValid(value?.size) ? value.size : DEFAULT_CHARACTER_SIZE; stageAttention = value?.stageAttention !== false;
      capture = value?.capture === 'visible' ? 'visible' : 'hidden';
      return value?.enabled === true;
    } catch { return false; }
  };
  hand = read();
  const note = (direction, detail) => { try { trace(direction, detail); } catch {} };
  const write = (line, { urgent = false, onBackpressure } = {}) => {
    try {
      // A replacement has no old target inventory. Keep character frames out until a real turn end empties it.
      if (protectionLost && JSON.parse(line).hand === 'character') return false;
      if (child.stdin.writableLength + Buffer.byteLength(line) > 4 * 1024 * 1024) {
        protectionLost = true; die('backlog'); return false;
      }
      if (!urgent && child.stdin.writableLength > 65536) { note('hand-dropped', { reason: 'backpressure' }); return false; }
      // false means queued, with backpressure. It is not a failed write.
      if (child.stdin.write(line) === false) onBackpressure?.(child.stdin);
      return true;
    } catch (error) { note('hand-dropped', { reason: error?.code ?? 'write' }); die('pipe', { code: error?.code }); return false; }
  };
  const geometry = createGeometryChannel({ nonce, allocate: () => ++seq, running: () => host === 'running' && !closed && !menuOnly,
    write, project: handWireFrame,
    rememberTarget: wire => { target = { pid: wire.pid, windowId: wire.windowId, at: wire.at, ...wire.windowRect ? { windowRect: wire.windowRect } : {} }; },
    failed: () => note('hand-geometry-hidden', {}) });
  const act = (wire, delayMs = wire.delayMs) => JSON.stringify(wire.hand
    ? { ...wire, nonce, seq: ++seq }
    : { hand: 'act', nonce, seq: ++seq, kind: wire.kind, pid: wire.pid,
      windowId: wire.windowId, at: wire.at, ...wire.windowRect ? { windowRect: wire.windowRect } : {}, ...wire.say ? { say: wire.say } : {}, path: wire.path, delayMs, beats: wire.beats,
      ...style !== 'glove' ? { ...wire.retry === true ? { retry: true } : {}, ...wire.transfer ? { transfer: wire.transfer } : {}, ...wire.label ? { label: wire.label } : {}, ...wire.rect ? { rect: wire.rect } : {},
        ...wire.caretX !== undefined ? { caretX: wire.caretX } : {} } : {} }) + '\n';
  // perms: the last Permissions rows sent, with the targets a click may act on; permsText detects a change.
  let perms, permsText, permsApp, refreshing = false, again = false;
  // stats: the usage row last sent, and when the log was last read.
  let stats, statsText = 'null', statsAt = -Infinity;
  const menu = () => JSON.stringify({ hand: 'menu', nonce, enabled: hand, capture, version, ...narration !== 'off' ? { narration } : {}, ...voice ? { voice } : {}, ...perms?.payload ? { permissions: perms.payload } : {},
    ...stats ? { usage: stats } : {} }) + '\n';
  async function loadUsage() {
    if (!usage) return false;
    statsAt = now();
    let next;
    try { next = usageFrame(await usage()); } catch (error) { note('usage-unavailable', { code: error?.code ?? 'read' }); next = undefined; }
    const text = JSON.stringify(next ?? null);
    if (text === statsText) return false;
    stats = next; statsText = text;
    return true;
  }
  // Off the caller's path; statsAt is set before the read, so a slow read isn't started twice.
  function refreshUsage() {
    if (!usage || host !== 'running' || now() - statsAt < usageMs) return;
    loadUsage().then(changed => { if (changed && host === 'running') write(menu()); });
  }
  async function loadPermissions() {
    if (!permissions) return false;
    let next;
    try { next = await permissions.menu(); } catch (error) { note('permissions-unavailable', { code: error?.code ?? 'read' }); return false; }
    permsApp = currentApp()?.bundleId;
    const text = JSON.stringify(next?.payload ?? null);
    if (text === permsText) return false;
    perms = next; permsText = text;
    return true;
  }
  // Off the caller's path, one at a time; a change while one runs reads again once it ends.
  function refreshPermissions() {
    if (!permissions || host !== 'running') return;
    if (refreshing) { again = true; return; }
    refreshing = true;
    loadPermissions().then(changed => { if (changed && host === 'running') write(menu()); })
      .finally(() => { refreshing = false; if (again) { again = false; refreshPermissions(); } });
  }
  // A host exits at the end of its hand input. A hand-only one that hasn't after killAfterMs is killed; one serving turbo's
  // consent channel stays until that channel ends, so neither the hand's faults nor its close take turbo down.
  const stopChild = ending => {
    if (!attached.has(ending)) {
      const timer = setTimeout(() => { if (ending.exitCode == null && ending.signalCode == null) try { ending.kill(); } catch {} }, killAfterMs);
      timer.unref?.();
      ending.once('exit', () => clearTimeout(timer));
    }
    try { ending.stdin.end(); } catch {}
  };
  const stop = () => {
    queue.length = 0;
    if (!child) return;
    const ending = child; child = undefined;
    stopChild(ending);
  };
  const die = (reason, detail) => {
    if (host === 'dead') return;
    if (glideStop) {
      failedGlideStop(glideStop);
    }
    for (const listener of hintListeners) try { listener(undefined); } catch {}
    if (restoreRequest) { clearTimeout(restoreRequest.timer); restoreRequest = undefined; }
    // A kill is never a resume. Keep a committed pause and make exactly one replacement control.
    if (pauseRequest?.before && !paused) setPaused(true);
    const recover = (paused || reason === 'backlog') && !closed && !respawned;
    if (pauseRequest) { clearTimeout(pauseRequest.timer); pauseRequest = undefined; }
    if (reason === 'control-gone' && child?.stdio?.[3]) {
      // The faulted hand reader drops frames. Its independent consent pipe still accepts this parent-only exit.
      try { child.stdio[3].write(JSON.stringify({ hand: 'control-exit', nonce }) + '\n'); }
      catch { note('hand-control-exit-failed', {}); }
    }
    host = 'dead';
    geometry.poison();
    stop(); events = ''; consentClaimed = false;
    for (const resolve of clearWaiters.values()) resolve(false);
    clearWaiters.clear();
    note('hand-off', { reason, ...detail });
    if (recover) { respawned = true; host = 'none'; starting = undefined; ensure(); }
  };
  // The Permissions rows' clicks: { permissions: 'revoke' | 'block', nonce, target } or { permissions: 'revoke-all', nonce }, with this
  // session's nonce. apply acts only on a target the last menu offered, and only ever removes access.
  function permissionEvent(event) {
    const keys = Object.keys(event).sort().join();
    if (!permissions || event.nonce !== nonce || !(keys === 'nonce,permissions' && event.permissions === 'revoke-all' ||
        keys === 'nonce,permissions,target' && ['revoke', 'block'].includes(event.permissions) && typeof event.target === 'string' && event.target.length <= 300)) return false;
    note('permissions-click', { op: event.permissions });
    Promise.resolve().then(() => permissions.apply(event, perms?.offered)).then(() => refreshPermissions(),
      error => note('permissions-failed', { code: /^[A-Z][A-Z0-9_]{0,127}$/.test(error?.message) ? error.message : 'PERMISSIONS_FAILED' }));
    return true;
  }
  // The sprite style's load result, so a character shown as the ring alone has its reason in the trace.
  function characterEvent(event) {
    const reasons = ['path', 'permissions', 'size', 'type', 'decode', 'alpha', 'pixels', 'changed', 'timeout', 'child', 'sandbox'];
    if (event.nonce !== nonce || Object.keys(event).sort().join() !== 'hand,id,loaded,nonce,reason,warnings' || typeof event.loaded !== 'boolean' ||
      typeof event.id !== 'string' || !/^[a-z0-9-]{1,48}$/.test(event.id) || !(event.loaded ? event.reason === null : reasons.includes(event.reason)) ||
      !Array.isArray(event.warnings) || !event.warnings.every(w => ['chroma fringe', 'ink in an unused cell'].includes(w))) return false;
    note(event.loaded ? 'hand-character' : 'hand-character-refused', { id: event.id, ...event.reason ? { reason: event.reason } : {},
      ...event.warnings.length ? { warnings: event.warnings } : {} });
    if (pickerLoad === event.id) {
      pickerLoad = undefined;
      if (!event.loaded) {
        const words = { path: 'its image path is unsafe', permissions: 'its files need private permissions', size: 'its image size does not match',
          type: 'its image format is unsupported', decode: 'its image could not be decoded', alpha: 'its image needs transparency',
          pixels: 'its frames have too little visible artwork or are almost fully opaque', changed: 'its files changed during loading',
          timeout: 'its image took too long to decode', child: 'its image decoder stopped', sandbox: 'its decoder could not run safely' };
        pickerNotice(`Character ${event.id} could not draw: ${words[event.reason]} (${event.reason}). Showing the ring.`);
        pickerEvent({ hand: 'picker', nonce, op: 'fallback', character: event.id }, true);
      }
    }
    return true;
  }
  // Catalogs are lazy: opening the menu asks for one, never an action or a timer. Import clicks use VC3's importer,
  // not a CLI process, and the existing hand.json writer. The native host alone verifies the hardware input.
  let pickerReady, pickerLoad, pickerBusy = false;
  const pickerQueue = [];
  const pickerFrame = data => write(JSON.stringify({ hand: 'picker', nonce, ...data }) + '\n');
  // The Windows host draws the ring trail and admits only its base character
  // schema. Mac seating settings must not change that host's wire contract.
  const currentSpriteOptions = () => platform === 'win32' ? { perch: false } : { perch: perch || size !== 'small', size, stageAttention };
  const spriteFrame = () => {
    const options = currentSpriteOptions();
    const frame = { ...characterFrame(spriteSource.character, { nonce, seq: 0, resolve: spriteSource.resolve, ...options }),
      ...session && platform !== 'win32' ? { sessionBadge: session.badge } : {} };
    if (platform === 'win32') delete frame.lines;
    if (Buffer.byteLength(JSON.stringify(frame)) > 32768) throw Error('CHARACTER_INVALID');
    spriteOptions = JSON.stringify(options); return frame;
  };
  const wantsStage = () => currentSpriteOptions().perch && (size === 'stage' || typeof size === 'number');
  function requestStage() {
    const source = spriteSource;
    if (!wantsStage() || !source?.character.builtin || source.character.stageKey) return;
    stageCache ??= createCharacterStageCache();
    stageCache.ensure(source.character).then(ready => {
      if (!ready || host !== 'running' || style !== 'sprite' || spriteSource !== source || !wantsStage()) return;
      spriteSource = { ...source, character: ready };
      try { const sprite = spriteFrame(); pickerLoad = sprite.id; write(JSON.stringify({ ...sprite, seq: ++seq }) + '\n'); sendOptions(true); }
      catch { note('hand-stage-fallback', { reason: 'CHARACTER_INVALID' }); }
    }).catch(() => note('hand-stage-fallback', { reason: 'STAGE_RENDER_FAILED' }));
  }
  const sendOptions = (force = false) => {
    if (host !== 'running' || style !== 'sprite' || platform === 'win32') return;
    requestStage();
    // Placement changed: rebuild the character frame before sending the perch and lines options.
    if (spriteSource && spriteOptions !== JSON.stringify(currentSpriteOptions())) {
      try { const sprite = spriteFrame(); pickerLoad = sprite.id; write(JSON.stringify({ ...sprite, seq: ++seq }) + '\n'); force = true; }
      catch (error) { note('hand-sprite-fallback', { reason: 'CHARACTER_INVALID' }); }
    }
    const options = { perch: currentSpriteOptions().perch, lines }, text = JSON.stringify(options);
    if (!force && text === optionsSent) return;
    optionsSent = text; pickerFrame({ op: 'options', ...options });
  };
  const pickerNotice = text => pickerFrame({ op: 'notice', text: String(text).replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ch => ch === '\n' ? '\n' : '').slice(0, 3000) });
  async function pickerCatalog(picker, open = false) {
    const catalog = await picker.catalog({ style, character, size, lines: lines ? 'on' : 'off', open });
    if (host !== 'running') return;
    const frame = { op: 'catalog', rows: catalog.rows };
    const tooLarge = () => Buffer.byteLength(JSON.stringify({ hand: 'picker', nonce, ...frame })) > 64000 || frame.rows.length > 512 || frame.rows.some(r => r.children?.length > 512);
    if (tooLarge()) frame.rows = frame.rows.filter(r => r.op !== 'skipped').map(r => r.children
      ? { ...r, children: r.children.filter(c => c.op !== 'skipped') } : r).filter(r => !r.children || r.children.length);
    if (tooLarge()) {
      pickerNotice('There are too many characters for this menu. Open the characters folder to review them.'); return;
    }
    pickerFrame(frame);
    for (const thumbnail of catalog.thumbnails) {
      if (host !== 'running') return;
      pickerFrame({ op: 'thumbnail', key: thumbnail.key, frame: { ...thumbnail.frame, nonce } });
    }
  }
  async function pickerFallback(picker, id) {
    // Serialize recovery with choices. A late refusal must never replace a newer choice.
    if (host !== 'running' || style !== 'sprite' || character !== id) return;
    style = 'ring'; pickerLoad = undefined;
    pickerFrame({ op: 'style', style });
    const result = await picker.apply({ op: 'select', style: 'ring' });
    if (!result.ok) pickerNotice(`Showing the ring, but the saved cursor choice could not update. ${result.text ?? ''}`);
  }
  async function pickerStyle(next, picker) {
    style = next.style; if (next.character) character = next.character;
    pickerLoad = undefined;
    let sprite;
    if (!menuOnly && style === 'sprite') {
      try {
        if (session) await session.select(character);
        const loaded = await loadSprite(character);
        spriteSource = loaded; sprite = spriteFrame();
      } catch (error) {
        pickerNotice(`This character could not load. Showing the ring. ${error.message}`);
        await pickerFallback(picker, character);
        return;
      }
    }
    if (host !== 'running') return;
    pickerFrame({ op: 'style', style });
    if (sprite) { pickerLoad = sprite.id; write(JSON.stringify({ ...sprite, seq: ++seq }) + '\n'); sendOptions(true); }
  }
  function pickerEvent(event, internal = false) {
    if (event.hand !== 'picker') return false;
    const keys = Object.keys(event).sort().join();
    if (cursorPicker === null || event.nonce !== nonce || !(internal && keys === 'character,hand,nonce,op' && event.op === 'fallback' && characterIdValid(event.character) ||
        keys === 'hand,nonce,op' && event.op === 'refresh' ||
        keys === 'hand,key,nonce,op' && event.op === 'import' && /^[0-9a-f]{64}$/.test(event.key) ||
        keys === 'hand,lines,nonce,op' && event.op === 'lines' && ['on', 'off'].includes(event.lines) ||
        keys === 'hand,nonce,op,size' && event.op === 'size' && CHARACTER_SIZES.includes(event.size) ||
        keys === 'hand,nonce,op,style' && event.op === 'select' && ['ring', 'seam', 'glove'].includes(event.style) ||
        keys === 'character,hand,nonce,op,style' && event.op === 'select' && event.style === 'sprite' && characterIdValid(event.character))) {
      note('hand-picker-refused', {}); return true;
    }
    if (menuOnly && event.op === 'refresh') {
      // No actions drive rechecks in a standalone menu. Opening it reads external CLI changes too, even when the settings
      // directory did not exist when the watcher was installed.
      style = undefined; character = undefined; hand = read();
      write(menu()); refreshPermissions(); refreshUsage();
    }
    if (pickerBusy) {
      // Refreshes coalesce; a person's action must survive a refresh already in flight.
      if (event.op !== 'refresh') {
        if (pickerQueue.length < 32) pickerQueue.push({ event, internal });
        else pickerNotice('Several cursor choices are pending. Try again when they finish.');
      }
      return true;
    }
    pickerBusy = true;
    pickerReady ??= cursorPicker ? Promise.resolve(cursorPicker) : import('./cursor-picker.mjs').then(m => m.createCursorPicker({ env, trace: note }));
    pickerReady.then(async picker => {
      if (host !== 'running') return;
      if (event.op === 'fallback') {
        await pickerFallback(picker, event.character);
      } else if (event.op !== 'refresh') {
        const { hand: _, nonce: __, ...choice } = event;
        const result = await picker.apply(choice);
        if (host !== 'running') return;
        if (result.ok && result.lines) { lines = result.lines === 'on'; sendOptions(); }
        else if (result.ok && CHARACTER_SIZES.includes(result.size)) { size = result.size; sendOptions(); }
        else if (result.ok) await pickerStyle(result, picker);
        if (result.text) pickerNotice(result.text);
      }
      await pickerCatalog(picker, event.op === 'refresh');
    }).catch(error => { if (host === 'running') pickerNotice(`The Cursor menu could not update: ${error.message}`); })
      .finally(() => { pickerBusy = false; const next = pickerQueue.shift(); if (next) pickerEvent(next.event, next.internal); });
    return true;
  }
  // The Ghost Hand row's clicks: exact { hand: 'toggle', nonce, enabled } lines with this session's nonce, on the host's stdout.
  function onEvents(chunk, owner) {
    events += chunk;
    if (events.length > 65536) { events = ''; note('hand-toggle-refused', { reason: 'size' }); return; }
    let end;
    while ((end = events.indexOf('\n')) >= 0) {
      if (child !== owner) return;
      const text = events.slice(0, end); events = events.slice(end + 1);
      let event;
      try { event = JSON.parse(text); } catch {}
      if (event?.hand === 'glide-stop') {
        if (event.nonce !== nonce || Object.keys(event).sort().join() !== 'hand,nonce,phase,token' ||
            !glideStop || event.token !== glideStop.token) continue;
        const state = glideStop;
        if (event.phase === 'ready') { clearTimeout(state.timer); state.resolve(state.end); }
        else if (event.phase === 'control-unavailable') unavailableGlideStop(state);
        else if (event.phase === 'unavailable') failedGlideStop(state);
        else if (event.phase === 'stop' && !state.stopped) { state.stopped = true; state.stop(); }
        continue;
      }
      if (menuOnly && event?.hand === 'menu-ready' && event.nonce === nonce &&
          Object.keys(event).sort().join() === 'existing,hand,nonce' && typeof event.existing === 'boolean') { onMenuReady(event.existing); continue; }
      if (event?.hand === 'narration-check' && event.nonce === nonce && Object.keys(event).sort().join() === 'hand,nonce,secure,token' && typeof event.secure === 'boolean') {
        const done = narrationChecks.get(event.token); narrationChecks.delete(event.token); done?.(!event.secure); continue;
      }
      if (event?.hand === 'replay' && event.nonce === nonce && Object.keys(event).sort().join() === 'first,hand,nonce,run' &&
          recording() && Number.isSafeInteger(event.first) && chips.consume(event.run, event.first)) {
        Promise.resolve().then(() => openReplay(event.run, event.first)).catch(() => note('hand-replay-failed', {})); continue;
      }
      if (event?.hand === 'consent-ready' && event.nonce === nonce && Object.keys(event).sort().join() === 'hand,nonce,token') {
        resetWaiters.get(event.token)?.(); continue;
      }
      if (event && typeof event === 'object' && Object.hasOwn(event, 'permissions') && permissionEvent(event)) continue;
      if (event?.hand === 'character' && characterEvent(event)) continue;
      if (event?.hand === 'hint') {
        const at = point(event.at);
        if (menuOnly || event.nonce !== nonce || Object.keys(event).sort().join() !== 'at,hand,nonce,pid,ts,windowId' ||
            !id(event.pid, 2147483647) || !id(event.windowId, 4294967295) || !at ||
            typeof event.ts !== 'number' || !Number.isFinite(event.ts) || event.ts < 0) {
          die('hint-invalid', { code: 65 }); return;
        }
        const time = now();
        if (!hand || event.ts > time || time - event.ts >= 60000) continue;
        const hint = { pid: event.pid, windowId: event.windowId, at, ts: event.ts };
        for (const listener of hintListeners) try { listener(hint); } catch {}
        continue;
      }
      if (event?.hand === 'control-gone' && event.nonce === nonce && Object.keys(event).sort().join() === 'hand,nonce') {
        die('control-gone'); return;
      }
      if (event?.hand === 'stage-producer-ack') { geometry.acknowledge(event); continue; }
      if (['clear-ready', 'placed-ready'].includes(event?.hand) && event.nonce === nonce && Object.keys(event).sort().join() === 'hand,nonce,token') {
        clearWaiters.get(event.token)?.(true, event.hand); continue;
      }
      if (!menuOnly && event?.hand === 'pause' && event.nonce === nonce && Object.keys(event).sort().join() === 'hand,nonce,paused,phase,token' &&
          typeof event.paused === 'boolean' && /^[0-9a-f]{32}$/.test(event.token) && ['request', 'commit', 'confirm', 'cancel', 'restored'].includes(event.phase)) {
        if (event.phase === 'restored') {
          if (restoreRequest?.token === event.token && event.paused === true) { clearTimeout(restoreRequest.timer); restoreRequest = undefined; }
        } else if (event.phase === 'request') {
          if (!hand && !paused || pauseRequest || event.paused === paused) continue;
          const request = { token: event.token, value: event.paused, before: paused, applied: false };
          pauseRequest = request;
          request.timer = setTimeout(() => abortPause(request), 500);
          pauseAck('ready', request);
        } else {
          const request = pauseRequest;
          if (!request || event.token !== request.token || event.paused !== request.value) continue;
          if (event.phase === 'cancel') abortPause(request);
          else if (event.phase === 'commit' && !request.applied) {
            request.applied = true; setPaused(request.value); pauseAck('applied', request);
          } else if (event.phase === 'confirm' && request.applied) {
            clearTimeout(request.timer); pauseRequest = undefined;
          }
        }
        continue;
      }
      if (event && typeof event === 'object' && pickerEvent(event)) continue;
      if (!event || typeof event !== 'object' || Object.keys(event).sort().join() !== 'enabled,hand,nonce' || event.hand !== 'toggle' ||
          event.nonce !== nonce || typeof event.enabled !== 'boolean') { note('hand-toggle-refused', {}); continue; }
      Promise.resolve().then(() => setHand(event.enabled)).then(() => recheck(true),
        error => note('hand-toggle-failed', { code: /^[A-Z][A-Z0-9_]{0,127}$/.test(error?.message) ? error.message : 'HAND_SETUP_FAILED' }));
    }
  }
  function setPaused(value) {
    if (paused === value) return;
    paused = value; onPause(value); note('hand-pause', { paused });
  }
  function pauseAck(phase, request) {
    if (host !== 'running') return false;
    return write(JSON.stringify({ hand: 'pause-ack', nonce, phase, token: request.token, paused: request.value }) + '\n', { urgent: true });
  }
  function abortPause(request) {
    if (pauseRequest !== request) return;
    clearTimeout(request.timer); pauseRequest = undefined;
    // A missing ready never changed admission. A lost final ack rolls a tentative pause back.
    if (request.applied) setPaused(request.before);
    pauseAck('aborted', request);
  }
  // Spawns the session's consent-capable host once. Menu and queued frames go to this host for its lifetime.
  async function launch(consent) {
    if (host === 'dead') return undefined;
    let ready;
    try { ready = built(); } catch { ready = false; }
    const cold = !ready;
    if (cold) note('hand-building', { reason: 'cold-cache', timeoutMs: 600000 });
    try {
      buildStarted = now(); buildController = new AbortController();
      const result = await prepare({ signal: buildController.signal, upgradeSignal: upgradeController.signal, onProgress: detail => note('hand-build', detail) });
      buildController = undefined;
      if (cold) note('hand-built', { status: result?.status, code: result?.code, ...result?.detail ? { detail: result.detail } : {} });
      if (host === 'dead') return undefined;
      if (result?.status !== 'ready') { die('unavailable', { code: result?.code, ...result?.detail ? { detail: result.detail } : {} }); return undefined; }
      // The first menu frame already carries the Permissions rows. The usage row follows once the log is read.
      await loadPermissions();
      if (host === 'dead') return undefined;
      // Sprite style needs a valid installed character. Without one the host draws the ring, with one trace line.
      let sprite;
      if (!menuOnly && style === 'sprite') {
        try {
          if (Array.isArray(cast) && cast.length > 0 && !sessionAttempted) {
            sessionAttempted = true;
            session = await claimHandSession({ root: sessionRoot, cast, alive, started: sessionStarted });
            character = session.character;
            if (host === 'dead') { session.close().catch(() => {}); return undefined; }
          }
          if (!characterIdValid(character)) throw Error('CHARACTER_NOT_SET');
          const { character: loaded, resolve } = await loadSprite(character);
          // Built now, so a character the host would refuse for size falls back before the spawn; its seq is set on send.
          spriteSource = { character: loaded, resolve }; sprite = spriteFrame();
        } catch (error) {
          note('hand-sprite-fallback', { reason: /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.message) ? error.message : 'CHARACTER_INVALID' });
          style = 'ring';
        }
        if (host === 'dead') return undefined;
      }
      const started = result.spawn({ capture, consent, ...menuOnly ? { menuOnly: true } : {}, ...cursorStyle !== undefined || style !== 'glove' ? { cursorStyle: style } : {} });
      started.on('error', error => { if (child === started) die('spawn', { code: error?.code }); });
      started.stdin.on('error', error => { if (child === started) die('pipe', { code: error?.code }); });
      started.stdout?.on('data', chunk => { if (child === started) onEvents(chunk, started); });
      started.stdout?.on('end', () => { if (child === started) die('stdout'); });
      for (const end of [started.stdio?.[3], started.stdio?.[4]]) end?.on('error', () => note('hand-consent-unavailable', {}));
      started.on('exit', (code, signal) => { if (child === started) { setHandPid(0); die('exit', { code, signal }); } else if (!child) setHandPid(0); });
      child = started; host = 'running';
      setHandPid(started.pid);
      note('hand-started', { pid: started.pid, consent });
      write(menu());
      if (geometry.active) geometry.quarantine();
      if (child !== started) return undefined;
      if (paused) {
        const token = randomBytes(16).toString('hex');
        restoreRequest = { token, timer: setTimeout(() => die('pause-restore-timeout'), 500) };
        pauseAck('restore', { token, value: true });
        if (child !== started) return undefined;
        if (!geometry.active && target && style !== 'glove') write(act({ hand: 'status', state: 'paused', ...target }));
      }
      // The character frame goes once, before any queued act, on the acts' sequence counter.
      if (sprite) { write(JSON.stringify({ ...sprite, seq: ++seq }) + '\n'); sendOptions(true); }
      statsAt = -Infinity;
      refreshUsage();
      for (const { wire, at } of queue.splice(0)) {
        if (geometry.active) { geometry.poison(); continue; }
        if (cold && now() - at > (wire.delayMs ?? 0) + 1500) { note('hand-dropped', { reason: 'build-delay' }); continue; }
        write(act(wire, Math.max(0, (wire.delayMs ?? 0) - (now() - at))));
      }
      return started;
    } catch (error) { buildController = undefined; die('spawn', { code: error?.code ?? error?.message }); return undefined; }
  }
  // Launches run one at a time, off the caller's path.
  const serial = consent => {
    const next = chain.then(() => new Promise(resolve => defer(() => resolve(launch(consent)))));
    chain = next.catch(() => {});
    return next;
  };
  // While no host runs, frames queue behind the launch in flight.
  const begin = next => {
    if (host !== 'running') {
      host = 'starting';
      const pending = next.then(Boolean).finally(() => { if (starting === pending) starting = undefined; });
      starting = pending;
    }
    return next;
  };
  // Starts the session's consent-capable host once. Resolves true while a host runs.
  function ensure(source = 'other') {
    if (host === 'running') return Promise.resolve(true);
    if (host === 'dead') return Promise.resolve(false);
    if (!starting) { note('hand-start-request', { source }); begin(serial(!menuOnly)); }
    return starting;
  }
  // The settings are read again when sleight's settings folder changes (the Ghost Hand row or the hand command), and at most
  // once a minute otherwise, off the caller's path. Off hides the hand at once and keeps the shared host, which turbo may use;
  // the host's menu frame carries the new setting and capture mode.
  function recheck(force = false) {
    if (checking || !force && now() - checked < recheckMs) return;
    checking = true;
    defer(() => {
      checking = false; checked = now();
      const before = JSON.stringify([hand, capture, narration, voice]);
      hand = read();
      chips.recording(recording());
      if (!hand) queue.length = 0;
      if (host === 'running' && before !== JSON.stringify([hand, capture, narration, voice])) {
        if (!hand) { write(JSON.stringify({ hand: 'hide', nonce }) + '\n'); note('hand-off', { reason: 'setting' }); }
        write(menu());
      }
      // The CLI or another session changed perch or lines.
      sendOptions();
      // Last-use times come from other sessions' records too, so the rows are read again with the minute's recheck.
      refreshPermissions();
      refreshUsage();
    });
  }
  let watcher;
  try {
    watcher = watch(dirname(handConfigPath()), (_event, name) => {
      if (!name || String(name) === 'hand.json') recheck(true);
      if (!name || permissionFiles.has(String(name))) refreshPermissions();
    });
  }
  catch {} // no settings folder yet: the minute's recheck covers it

  const client = Object.freeze({
    async beginGlideStop(window, stop) {
      if (closed || menuOnly || !id(window?.pid, 2147483647) || !id(Number(window?.windowId), 4294967295) || typeof stop !== 'function')
        throw glideStopFailure();
      if (!await ensure() || host !== 'running' || glideStop) throw glideStopFailure();
      return new Promise((resolve, reject) => {
        const state = { token: randomBytes(16).toString('hex'), pid: window.pid, windowId: Number(window.windowId), resolve, reject, stop };
        state.end = () => endGlideStop(state);
        state.end.failure = new Promise(fail => { state.fail = fail; });
        Object.defineProperty(state.end, 'controlUnavailable', { get: () => state.unavailable === true });
        glideStop = state;
        state.timer = setTimeout(() => failedGlideStop(state), 1000);
        if (!write(stopFrame('begin', state), { urgent: true })) failedGlideStop(state);
      });
    },
    onHint(listener) {
      if (typeof listener !== 'function' || closed) return () => {};
      hintListeners.add(listener);
      return () => hintListeners.delete(listener);
    },
    startMenu() { return menuOnly ? ensure() : Promise.resolve(false); },
    // Admission only primes an existing host. Its ordinary lazy start point is unchanged.
    primeCall() {
      const began = performance.now();
      if (hand && host === 'running') write(JSON.stringify({ hand: 'call', nonce }) + '\n');
      note('hand-call-prefetch', { addedMs: performance.now() - began, running: host === 'running' });
    },
    checkNarration(done) {
      if (host !== 'running' || narrationChecks.size >= 32) { done(false); return; }
      const token = randomBytes(16).toString('hex'); narrationChecks.set(token, done);
      write(JSON.stringify({ hand: 'narration-check', nonce, token }) + '\n');
      return () => narrationChecks.delete(token);
    },
    activity() {
      if (!hand || env.SLEIGHT_HAND === '0' || host === 'dead' || now() - activityAt < 60000) return;
      activityAt = now();
      ensure('activity').then(ok => { if (ok && host === 'running') write(JSON.stringify({ hand: 'activity', nonce }) + '\n'); });
    },
    send(frame) {
      recheck();
      const stale = geometry.active && geometry.stale(frame);
      // A stale terminal cannot close the current turn. A stale action still has a target to protect.
      if (stale && frame?.hand === 'status') return;
      if (host === 'dead') { geometry.droppedTerminal(frame); return; }
      // A new app to act in changes the menu's Never Act in row.
      if (host === 'running' && currentApp()?.bundleId !== permsApp) refreshPermissions();
      const turnEnd = frame?.hand === 'status' && (frame.state === 'handback' || frame.state === 'done' && frame.ok !== true);
      if (menuOnly || !hand || host === 'dead') return;
      if (style === 'glove' && ['aim', 'status', 'wide'].includes(frame?.hand)) return;
      const wire = handWireFrame({ ...frame, say: narration === 'off' ? undefined : frame.say });
      if (typeof wire === 'string') { note('hand-dropped', { reason: wire }); return; }
      if (wire.hand !== 'status' || wire.area && !turnEnd) unknownApp = false;
      if (wire.hand === 'wide') {
        if (geometry.active) { geometry.poison(); return; }
        wideTarget = { pid: wire.pid ?? 1, windowId: wire.windowId ?? 1 };
        if (host === 'running') write(act(wire), { urgent: true });
        else { if (queue.length < 32) queue.push({ wire, at: now() }); ensure('wide-frame'); }
        return;
      }
      if (protectionLost && turnEnd && !stale) {
        // The new host's complete inventory is empty at this boundary. A call's done(ok) never reaches here.
        protectionLost = false;
        if (host === 'running' && style === 'sprite' && spriteSource) {
          try { write(JSON.stringify({ ...spriteFrame(), seq: ++seq }) + '\n'); sendOptions(true); }
          catch { note('hand-sprite-fallback', { reason: 'CHARACTER_INVALID' }); }
        }
      }
      if (stale) geometry.poison();
      if (!stale && geometry.active && (!geometry.ending || geometry.poisoned && wire.hand === 'status')) {
        if (geometry.publicFrame(wire) !== false) return;
      }
      // A closing turn's status inherits an art anchor, not a new protected target.
      if (geometry.ending && wire.hand === 'status') { delete wire.at; delete wire.windowRect; note('hand-status-anchor', { reason: 'closing-turn' }); }
      if (wire.hand !== 'status' || wire.area) target = { pid: wire.pid, windowId: wire.windowId, at: wire.at,
        ...wire.area ? { area: wire.area } : {}, ...wire.windowRect ? { windowRect: wire.windowRect } : {} };
      if (host === 'running') { write(act(wire), { urgent: wire.area !== undefined || wire.at !== undefined || wire.windowRect !== undefined }); return; }
      if (queue.length < 32) queue.push({ wire, at: now() });
      ensure('frame');
    },
    // Records already passed the cursor privacy projection. Aim and status share act's nonce and sequence.
    // An aim without a point and window (the admission preview) has nothing to draw and is no dropped frame.
    cursor(event) {
      if (geometry.active && geometry.stale(event) && event?.type !== 'action') return;
      if (host === 'dead' && event?.type === 'status') {
        geometry.droppedTerminal({ ...event, hand: 'status', ok: event.call ? true : undefined });
        return;
      }
      if (style === 'sprite' && hand && host !== 'dead' && !geometry.stale(event)) chips.receive(event, recording());
      if (style === 'glove' || !hand || host === 'dead') return;
      if (event?.type === 'action' && event.phase === 'aim') {
        if (!event.point || !event.window?.pid || !event.window?.id) return;
        client.send({ hand: 'aim', kind: ['select', 'navigate'].includes(event.kind) ? 'click' : event.kind, pid: event.window.pid, windowId: event.window.id,
          at: event.point, windowRect: event.window.rect, retry: event.retry, transfer: event.transfer, rect: event.rect, label: event.label, say: event.say, turn: event.turn });
      } else if (event?.type === 'status' && (target || wideTarget) && event.state !== 'idle') {
        const terminal = event.state === 'handback' || event.state === 'done' && !event.call;
        if (!target && !terminal) return;
        if (unknownApp && !geometry.active && (!terminal || host !== 'running')) return;
        // A call's done is its success; the ring bursts for it.
        client.send({ hand: 'status', state: event.state, ...(target ?? wideTarget), ...target?.windowId === 0 ? { area: 'app' } : {}, detail: event.detail, say: event.say, turn: event.turn, ...event.state === 'done' && event.call ? { ok: true } : {} });
      }
    },
    hide(reason) {
      if (reason === 'unknown-app') unknownApp = true;
      if (host === 'running') write(JSON.stringify({ hand: 'hide', nonce, ...reason === 'unknown-app' ? { reason } : {} }) + '\n', { urgent: reason === 'pointer-placement' });
      else queue.length = 0;
    },
    clearForAction(frame, deadline = Date.now() + 100) {
      // Local pointer helpers replace their existing clear with this placement receipt.
      // Engine and browser dispatch remain unawaited.
      if (host !== 'running') { queue.length = 0; return Promise.resolve(false); }
      const remaining = Math.min(100, deadline - Date.now());
      if (!(remaining > 0) || frame && typeof handWireFrame(frame) === 'string') {
        client.hide('pointer-placement'); return Promise.resolve(false);
      }
      if (frame) client.send(frame);
      const token = randomBytes(16).toString('hex');
      return new Promise(resolve => {
        let done = false, written = false, drained = true, acknowledged = false, pipe;
        const finish = value => {
          if (done) return;
          done = true; clearTimeout(timer); clearWaiters.delete(token); pipe?.removeListener('drain', onDrain); resolve(value);
        };
        const ready = () => { if (written && drained && acknowledged) finish(true); };
        const onDrain = () => { drained = true; ready(); };
        const timer = setTimeout(() => {
          // A slow main queue must not take down the shared consent channel or the session's pause control.
          // This one small control frame bypasses the artwork backlog cap.
          write(JSON.stringify({ hand: 'hide', nonce }) + '\n', { urgent: true });
          finish(false);
        }, remaining);
        clearWaiters.set(token, (value, kind) => { if (!value) finish(false); else if (kind === (frame ? 'placed-ready' : 'clear-ready')) { acknowledged = true; ready(); } });
        written = write(JSON.stringify({ hand: 'clear', nonce, token, ...frame ? { placed: true, placementSeq: seq } : {}, ...style === 'sprite' && currentSpriteOptions().perch && size !== 'small' ? { keepStage: true } : {} }) + '\n', {
          urgent: true,
          onBackpressure: stdin => { drained = false; pipe = stdin; pipe.once('drain', onDrain); },
        });
        if (!written) finish(false); else ready();
      });
    },
    close() {
      upgradeController.abort();
      if (glideStop) {
        failedGlideStop(glideStop);
      }
      hintListeners.clear();
      for (const done of narrationChecks.values()) done(false); narrationChecks.clear();
      geometry.poison();
      closed = true;
      if (session) session.close().catch(error => note('hand-session-cleanup', { code: error.message }));
      if (restoreRequest) { clearTimeout(restoreRequest.timer); restoreRequest = undefined; }
      if (pauseRequest) { clearTimeout(pauseRequest.timer); pauseRequest = undefined; }
      for (const resolve of clearWaiters.values()) resolve(false);
      clearWaiters.clear();
      try { watcher?.close(); } catch {}
      watcher = undefined;
      if (current === client) current = undefined;
      if (buildController) {
        note('hand-off', { reason: 'session-ended', code: 'HAND_BUILD_CANCELLED', elapsedMs: now() - buildStarted });
        buildController.abort(); buildController = undefined;
      }
      if (child) for (const end of [child.stdio?.[3], child.stdio?.[4]]) try { end?.destroy(); } catch {}
      if (host !== 'dead') { host = 'dead'; stop(); }
    },
    get controlLost() { return paused && host === 'dead'; },
    get pid() { return child?.pid; },
    get enabled() { return hand && host !== 'dead'; },
    get areaProtectionEnabled() { return hand && host !== 'dead' && style === 'sprite' && size !== 'small'; },
  });
  // Keep the parent's descriptors until session close. A worker ending then cannot end the host.
  // Reattachment requires the old worker's exit and a nonce-bound reset acknowledged by the host.
  sharing.set(client, async () => {
    if (consentClaimed) throw Error('HAND_CONSENT_IN_USE');
    if (host === 'dead') return undefined;
    // Cold compilation must not hold turbo startup. It may use its own consent host meanwhile.
    let cached;
    try { cached = built(); } catch { cached = false; }
    if (host !== 'running' && !cached) { ensure('consent-share'); return undefined; }
    consentClaimed = true;
    try {
      await resetting;
      if (!await ensure('consent-share') || !child?.stdio?.[3] || !child.stdio[4]) throw Error('HAND_HOST_UNAVAILABLE');
      const started = child, [writeEnd, readEnd] = [started.stdio[3], started.stdio[4]];
      attached.add(started);
      let detached = false;
      return Object.freeze({ write: writeEnd, read: readEnd, pid: started.pid, send: frame => client.send(frame),
        release() {}, // fork inherited its copies; the parent retains these for the next worker
        detached() {
          if (detached) return;
          detached = true;
          // Clear the old worker's card and indicator even if no replacement ever attaches.
          if (host === 'running' && child === started) resetting = resetConsent(started).catch(error => {
            for (const end of [writeEnd, readEnd]) try { end.destroy(); } catch {}
            if (child === started) die('consent-reset', { code: error?.message });
          });
          consentClaimed = false;
        } });
    } catch { consentClaimed = false; return undefined; }
  });
  geometryChannels.set(client, geometry.channel);
  current = client;
  return client;
}
