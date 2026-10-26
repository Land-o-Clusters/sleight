// Public cursor records are projections, never copies of tool arguments or engine replies.
// The relay owns the session, sequence and socket clients. Workers send only projected records over IPC.
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat, realpath, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { createConnection } from 'node:net';
import { handSetting } from './settings.mjs';

export const CURSOR_VERSION = 'sleight.cursor/1';
const kinds = new Set(['click', 'double', 'right', 'key', 'type', 'drag', 'scroll', 'select', 'navigate', 'move']);
const phases = new Set(['aim', 'act', 'done', 'failed', 'declined', 'skipped']);
const sources = new Set(['native', 'turbo', 'electron', 'local']);
const states = new Set(['thinking', 'waiting', 'error', 'done', 'handback', 'idle']);
const reasons = new Set(['covered', 'no-geometry', 'not-found', 'unplanned', 'other-space', 'offscreen']);
const roles = { AXButton: 'button', AXCheckBox: 'checkbox', AXRadioButton: 'radio button', AXTextField: 'text field', AXTextArea: 'text area',
  AXComboBox: 'combo box', AXPopUpButton: 'menu button', AXMenuButton: 'menu button', AXMenuItem: 'menu item', AXSlider: 'slider', AXLink: 'link',
  button: 'button', checkbox: 'checkbox', radio: 'radio button', textbox: 'text field', combobox: 'combo box', menuitem: 'menu item', link: 'link', slider: 'slider' };
const opaque = () => randomBytes(16).toString('hex');
const callId = x => typeof x === 'string' && /^[a-f0-9]{32}$/.test(x);
const text = x => typeof x === 'string' && x.length <= 160 && !/[\x00-\x1f\x7f]/.test(x) ? x : undefined;
const tuple = (x, n) => Array.isArray(x) && x.length === n && x.every(v => Number.isFinite(v) && Math.abs(v) <= 100000) ? [...x] : undefined;
const rect = x => tuple(x, 4) ?? (x && tuple([x.X ?? x.x, x.Y ?? x.y, x.Width ?? x.width, x.Height ?? x.height], 4));
const positive = x => Number.isSafeInteger(x) && x > 0 ? x : undefined;
const put = (o, k, v) => { if (v !== undefined) o[k] = v; };
const thin = x => x.length <= 64 ? x : Array.from({ length: 64 }, (_, i) => x[Math.round(i * (x.length - 1) / 63)]);
export const cursorReason = reason => reasons.has(reason) ? reason : /element-not-found|no-box/.test(reason ?? '') ? 'not-found'
  : /hidden|side-stage|minimized/.test(reason ?? '') ? 'other-space' : /focus|scale|geometry/.test(reason ?? '') ? 'no-geometry' : 'unplanned';

/** One internal record: the original host frame stays separate from public metadata. */
export function cursorRecord({ frame = {}, action = {}, geometry = {}, target = {}, labels = 'off' } = {}) {
  const out = { kind: kinds.has(action.kind) ? action.kind : kinds.has(frame.kind) ? frame.kind : 'move' };
  const secure = action.secure === true || geometry.secure === true || action.role === 'AXSecureTextField' || action.inputType === 'password';
  if (secure && out.kind === 'type') out.kind = 'key';
  put(out, 'point', tuple(frame.at ?? action.point, 2));
  if (out.kind === 'drag' && Array.isArray(frame.path)) {
    const path = thin(frame.path).map(p => tuple(p, 2)); if (path.length && path.every(Boolean)) out.path = path;
  }
  put(out, 'rect', rect(action.rect));
  const w = geometry.window ?? {}, window = {};
  put(window, 'id', positive(w.windowId ?? w.id ?? frame.windowId)); put(window, 'pid', positive(w.pid ?? frame.pid));
  const owner = geometry.windows?.find(other => other.id === window.id && other.pid === window.pid)?.owner;
  put(window, 'app', text(target.app ?? w.app ?? owner)); put(window, 'bundle', text(target.appId ?? w.bundle)); put(window, 'rect', rect(w.bounds ?? w.rect));
  if (window.id || window.rect) { window.exposure = ['covered', 'offscreen', 'other-space', 'minimized'].includes(geometry.state) ? geometry.state : 'exposed'; out.window = window; }
  const display = geometry.display;
  if (display) {
    const d = {}; put(d, 'id', positive(display.id)); if (Number.isFinite(display.scale) && display.scale > 0 && display.scale <= 8) d.scale = display.scale;
    if (Object.keys(d).length) out.display = d;
  }
  if (!secure && ['type', 'scroll'].includes(out.kind) && Number.isFinite(action.count ?? frame.beats)) out.count = Math.max(1, Math.min(out.kind === 'type' ? 8 : 100000, Math.round(action.count ?? frame.beats)));
  // Roles are a vocabulary, not page content. Unknown strings never become an outbound role or label.
  if (roles[action.role] || action.role === 'AXSecureTextField') out.role = action.role;
  if (!secure && labels !== 'off') {
    if (labels === 'role') put(out, 'label', roles[action.role]);
    else if (labels === 'title' && roles[action.role] && !['type', 'key'].includes(out.kind)) {
      const name = action.title || action.description;
      if (typeof name === 'string' && !/[\x00-\x1f\x7f]|(?:https?|file):|[/\\]|\bwww\./i.test(name)) out.label = [...name].slice(0, 40).join('');
    }
  }
  return out;
}

function actionRecord(input, labels) {
  if (!callId(input?.call) || !Number.isSafeInteger(input.index) || input.index < 0 || !phases.has(input.phase) || !sources.has(input.source) || !kinds.has(input.kind)) return;
  const out = { call: input.call, index: input.index, phase: input.phase, kind: input.kind, source: input.source,
    timing: input.source !== 'native' || ['done', 'failed'].includes(input.phase) ? 'confirmed' : 'scheduled' };
  // Reproject IPC records, including nested fields, before they reach any public socket.
  const projected = cursorRecord({ frame: { kind: input.kind, at: input.point, path: input.path, beats: input.count },
    action: { kind: input.kind, role: input.role, title: input.label, rect: input.rect }, labels,
    geometry: { window: input.window, display: input.display, state: input.window?.exposure } });
  for (const key of ['kind', 'point', 'path', 'rect', 'window', 'display', 'count', 'role', 'label']) put(out, key, projected[key]);
  if (input.phase === 'skipped') out.reason = cursorReason(input.reason);
  return out;
}

/** No I/O is awaited by write(). Discovery and connection run beside the action, at most once per 2 seconds. */
export function createRendererSink({ dir = process.env.SLEIGHT_CURSOR_STREAM_DIR ?? join(userInfo().homedir, 'Library/Application Support/sleight/cursor/renderers'),
  uid = process.getuid(), now = Date.now, connect = path => createConnection(path), defer = setImmediate, inspect = lstat } = {}) {
  const peers = new Map(); let closed = false, scanning = false, checked = -Infinity, dropped = 0, sessionStart;
  const directoryOK = async () => {
    try { const s = await inspect(dir); return isAbsolute(dir) && normalize(dir) === dir && s.isDirectory() && !s.isSymbolicLink() && s.uid === uid && (s.mode & 0o777) === 0o700 && await realpath(dir) === dir; } catch { return false; }
  };
  const remove = peer => { if (peers.get(peer.path) === peer) peers.delete(peer.path); dropped += peer.queue.length + peer.inFlight; peer.queue.length = 0; peer.inFlight = 0; peer.socket.destroy(); };
  const pump = peer => {
    if (!peer.ready || peer.blocked || closed || peers.get(peer.path) !== peer) return;
    while (peer.queue.length && peer.inFlight < 256) {
      const line = peer.queue.shift();
      peer.inFlight++;
      try {
        if (!peer.socket.write(line, error => {
          peer.inFlight = Math.max(0, peer.inFlight - 1);
          if (error) remove(peer); else pump(peer);
        })) { peer.blocked = true; return; }
      } catch { remove(peer); return; }
    }
  };
  async function discover() {
    try {
      if (!await directoryOK()) { for (const p of peers.values()) remove(p); return; }
      const valid = new Set();
      for (const name of await readdir(dir)) {
        if (closed) return;
        if (!name.endsWith('.sock')) continue;
        const path = join(dir, name); let stat;
        try { stat = await inspect(path); if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== uid || await realpath(path) !== path) continue; } catch { continue; }
        valid.add(path);
        const previous = peers.get(path);
        if (previous && previous.ino === stat.ino && previous.dev === stat.dev) continue;
        if (previous) remove(previous);
        if (!await directoryOK() || closed) return;
        const socket = connect(path), peer = { path, ino: stat.ino, dev: stat.dev, socket, ready: false, blocked: false, inFlight: 0, queue: [] };
        peers.set(path, peer); socket.unref?.();
        socket.on('error', () => remove(peer)); socket.on('close', () => { if (peers.get(path) === peer) remove(peer); });
        socket.on('drain', () => { peer.blocked = false; pump(peer); });
        // No command channel. Discard all incoming bytes without interpreting them.
        socket.resume();
        socket.on('connect', async () => {
          try {
            const current = await inspect(path);
            if (closed || peers.get(path) !== peer || current.ino !== peer.ino || current.dev !== peer.dev || current.uid !== uid || !current.isSocket() || !await directoryOK()) return remove(peer);
            if (sessionStart && !peer.queue.includes(sessionStart)) {
              if (peer.queue.length >= 256) { peer.queue.pop(); dropped++; }
              peer.queue.unshift(sessionStart);
            }
            peer.ready = true; pump(peer);
          } catch { remove(peer); }
        });
      }
      for (const p of peers.values()) if (!valid.has(p.path)) remove(p);
    } catch { /* No renderer can fail a tool call. */ } finally { scanning = false; }
  }
  function refresh(force = true) {
    if (closed || scanning || !force && now() - checked < 2000) return;
    checked = now(); scanning = true; defer(() => { discover().catch(() => { scanning = false; }); });
  }
  return { refresh,
    write(event) {
      if (closed) return;
      refresh(false);
      let line; try { line = JSON.stringify(event) + '\n'; } catch { return; }
      if (event?.type === 'session' && event.state === 'start') sessionStart = line;
      for (const p of peers.values()) {
        if (p.queue.length + p.inFlight >= 256) { dropped++; continue; }
        p.queue.push(line); pump(p);
      }
    },
    stats: () => ({ connected: [...peers.values()].filter(p => p.ready).length, queued: [...peers.values()].reduce((n, p) => n + p.queue.length + p.inFlight, 0), dropped }),
    close() {
      if (closed) return;
      closed = true;
      for (const p of peers.values()) {
        if (p.ready && !p.blocked && !p.queue.length && typeof p.socket.end === 'function') {
          peers.delete(p.path); p.socket.end();
          const timer = setTimeout(() => p.socket.destroy(), 250); timer.unref?.();
        } else remove(p);
      }
    },
  };
}

const version = (() => { try { return JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url))).version; } catch { return '0.0.0'; } })();
export function createCursorEvents({ setting = () => handSetting(), env = process.env, sink, onEvent = () => {}, now = Date.now, version: release = version,
  host = 'claude-code' } = {}) {
  const session = opaque(); let seq = 0, closed = false, started = false, output = sink;
  const options = () => { try { return env.SLEIGHT_HAND === '0' ? {} : setting(); } catch { return {}; } };
  const emit = fields => {
    const event = { v: CURSOR_VERSION, seq: ++seq, ts: now(), session, ...fields };
    try { onEvent(event); } catch {}
    try { (output ??= createRendererSink({ dir: env.SLEIGHT_CURSOR_STREAM_DIR })).write(event); } catch {}
  };
  const start = () => {
    if (!started) { started = true; emit({ type: 'session', state: 'start', host: ['claude-code', 'codex', 'other'].includes(host) ? host : 'other', version: release }); }
  };
  const allowed = () => !closed && options().stream === true;
  const api = {
    call: opaque,
    get labels() { return options().labels ?? 'off'; },
    get enabled() { return allowed(); },
    host(value) { if (!started && ['claude-code', 'codex', 'other'].includes(value)) host = value; },
    action(input) { if (!allowed()) return; const record = actionRecord(input, api.labels); if (record) { start(); emit({ type: 'action', ...record }); } },
    status(state, detail = {}) {
      if (!allowed() || !states.has(state)) return;
      detail ??= {};
      start(); const record = { type: 'status', state }; if (callId(detail.call)) record.call = detail.call; put(record, 'app', text(detail.app)); emit(record);
    },
    close() { if (closed) return; if (started && allowed()) emit({ type: 'session', state: 'end', host, version: release }); closed = true; output?.close(); },
  };
  return api;
}

let sharedEvents;
export const sessionCursorEvents = () => sharedEvents ??= createCursorEvents();
// One asynchronous call context in a worker, shared by browser and Electron action runners.
const context = new AsyncLocalStorage();
export const withCursorCall = (source, fn) => context.run({ call: opaque(), index: 0, source }, fn);
export function cursorStep() {
  const call = context.getStore();
  return call ? { call: call.call, index: call.index++, source: call.source } : { call: opaque(), index: 0, source: 'turbo' };
}
export function workerCursorStatus(state, detail = {}) {
  try {
    if (process.connected && handSetting().stream && process.env.SLEIGHT_HAND !== '0' && states.has(state)) {
      const record = { state }, call = context.getStore()?.call;
      if (callId(call)) record.call = call;
      put(record, 'app', text(detail.app));
      process.send({ version: 3, cursorStatus: record });
    }
  } catch {}
}
export function workerCursorAction(record) {
  try {
    const setting = handSetting();
    if (process.connected && setting.stream && process.env.SLEIGHT_HAND !== '0') {
      const event = actionRecord(record, setting.labels ?? 'off');
      if (event) process.send({ version: 3, cursor: event });
    }
  } catch {}
}
