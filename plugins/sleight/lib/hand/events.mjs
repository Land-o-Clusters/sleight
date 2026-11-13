// Public cursor records are projections, never copies of tool arguments or engine replies.
// The relay owns the session, sequence and socket clients. Workers send only projected records over IPC.
import { createRunRecorder } from '../runs/store.mjs';
import { createNarrationSink } from './narration-sink.mjs';
import { narrationLine } from '../../hooks/narration.mjs';
import { getPlatform } from '../platform/index.mjs';
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { cachedHandSetting, createHandSettingReader, handSettingReader, cursorDrawing } from './settings.mjs';

export const CURSOR_VERSION = 'sleight.cursor/1';
const kinds = new Set(['click', 'double', 'right', 'key', 'type', 'drag', 'scroll', 'select', 'navigate', 'move']);
const phases = new Set(['aim', 'act', 'done', 'failed', 'declined', 'skipped']);
const sources = new Set(['native', 'turbo', 'electron', 'local']);
const details = new Set(['approval', 'payment', 'page', 'handoff', 'person']);
const transfers = new Set(['take', 'give']);
const states = new Set(['thinking', 'waiting', 'error', 'done', 'handback', 'idle', 'paused']);
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
const withoutSay = event => { const { say: _say, ...record } = event; return record; };
const put = (o, k, v) => { if (v !== undefined) o[k] = v; };
const thin = x => x.length <= 64 ? x : Array.from({ length: 64 }, (_, i) => x[Math.round(i * (x.length - 1) / 63)]);
export const cursorReason = reason => reasons.has(reason) ? reason : /element-not-found|no-box/.test(reason ?? '') ? 'not-found'
  : /hidden|side-stage|minimized/.test(reason ?? '') ? 'other-space' : /focus|scale|geometry/.test(reason ?? '') ? 'no-geometry' : 'unplanned';

/** One internal record: the original host frame stays separate from public metadata. */
export function cursorRecord({ frame = {}, action = {}, geometry = {}, target = {}, labels = 'off', platform = process.platform } = {}) {
  const out = { kind: kinds.has(action.kind) ? action.kind : kinds.has(frame.kind) ? frame.kind : 'move' };
  const secure = action.secure === true || geometry.secure === true || action.role === 'AXSecureTextField' || action.inputType === 'password';
  if (secure && out.kind === 'type') out.kind = 'key';
  if (typeof action.retry === 'boolean') out.retry = action.retry;
  if (out.kind === 'key' && transfers.has(action.transfer)) out.transfer = action.transfer;
  put(out, 'point', tuple(frame.at ?? action.point, 2));
  if (out.kind === 'drag' && Array.isArray(frame.path)) {
    const path = thin(frame.path).map(p => tuple(p, 2)); if (path.length && path.every(Boolean)) out.path = path;
  }
  put(out, 'rect', rect(action.rect));
  const w = geometry.window ?? {}, window = {};
  put(window, 'id', positive(w.windowId ?? w.id ?? frame.windowId)); put(window, 'pid', positive(w.pid ?? frame.pid));
  const owner = geometry.windows?.find(other => other.id === window.id && other.pid === window.pid)?.owner;
  if (platform === 'win32') {
    const exe = text(target.exePath ?? target.app ?? w.app ?? owner);
    put(window, 'app', exe && text(win32.basename(exe)));
    const model = text(target.appUserModelId ?? w.appUserModelId);
    if (model && !/[/\\]/.test(model)) window.appUserModelId = model;
  } else {
    put(window, 'app', text(target.app ?? w.app ?? owner)); put(window, 'bundle', text(target.appId ?? w.bundle));
  }
  put(window, 'rect', rect(w.bounds ?? w.rect));
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

function actionRecord(input, labels, platform = process.platform) {
  if (!callId(input?.call) || !Number.isSafeInteger(input.index) || input.index < 0 || !phases.has(input.phase) || !sources.has(input.source) || !kinds.has(input.kind)) return;
  const out = { call: input.call, index: input.index, phase: input.phase, kind: input.kind, source: input.source,
    timing: input.timing === 'confirmed' || input.source !== 'native' || ['done', 'failed'].includes(input.phase) ? 'confirmed' : 'scheduled' };
  // Reproject IPC records, including nested fields, before they reach any public socket.
  const projected = cursorRecord({ frame: { kind: input.kind, at: input.point, path: input.path, beats: input.count },
    action: { kind: input.kind, retry: input.retry, transfer: input.transfer, role: input.role, title: input.label, rect: input.rect }, labels, platform,
    geometry: { window: input.window, display: input.display, state: input.window?.exposure } });
  for (const key of ['kind', 'point', 'path', 'rect', 'window', 'display', 'count', 'role', 'label', 'retry', 'transfer']) put(out, key, projected[key]);
  if (input.phase === 'skipped') out.reason = cursorReason(input.reason);
  return out;
}

export const createRendererSink = ({ platform = process.platform, ...options } = {}) =>
  getPlatform(platform).cursorSink.create(options);

const version = (() => { try { return JSON.parse(readFileSync(new URL('../../.claude-plugin/plugin.json', import.meta.url))).version; } catch { return '0.0.0'; } })();
export function createCursorEvents({ env = process.env, setting = handSettingReader(env), sink, recorder = createRunRecorder, onEvent = () => {}, now = Date.now, version: release = version, platform = process.platform,
  host = 'claude-code', repeat = setInterval, cancelRepeat = clearInterval } = {}) {
  setting = createHandSettingReader({ setting, now });
  const session = opaque(); let seq = 0, closed = false, started = false, output = sink, discoveryTimer, hostClient, recording, recordingClosed, sessionStart, paused = false;
  const narrationOutput = createNarrationSink({ write: event => { if (!closed && options().stream === true) (output ??= createRendererSink({ dir: env.SLEIGHT_CURSOR_STREAM_DIR, platform })).write(event); },
    check: done => hostClient?.checkNarration ? hostClient.checkNarration(done) : done(false) });
  const options = () => { try { return env.SLEIGHT_HAND === '0' ? {} : setting(); } catch { return {}; } };
  // The built-in host draws while the settings pick a drawn style and its client isn't dead (null: none could be created).
  const drawing = () => cursorDrawing(options()) && hostClient !== null && hostClient?.enabled !== false;
  const toHost = event => { try { if (drawing()) hostClient?.cursor?.(event); } catch {} };
  // held: the host gets this record later, through forward (the relay paces native aims behind the act before them).
  const emit = (fields, held = false) => {
    const event = { v: CURSOR_VERSION, seq: ++seq, ts: now(), session, ...fields };
    if (event.type === 'session' && event.state === 'start') sessionStart = event;
    try {
      if (options().record_runs === true) {
        if (!recording) { recording = recorder({ enabled: () => options().record_runs === true, now }); if (sessionStart !== event && sessionStart) recording.write(sessionStart); }
        recording.write(event);
      }
    } catch {}
    try { onEvent(event); } catch {}
    if (!held) toHost(event);
    try { if (options().stream === true) narrationOutput.write(event); } catch {}
    return event;
  };
  const start = (initialStatus = true) => {
    if (!started) { started = true; emit({ type: 'session', state: 'start', host: ['claude-code', 'codex', 'other'].includes(host) ? host : 'other', version: release });
      if (initialStatus) emit({ type: 'status', state: paused ? 'paused' : 'idle' });
    }
  };
  const allowed = () => {
    const enabled = !closed && options().stream === true;
    if (enabled && !discoveryTimer) {
      discoveryTimer = repeat(() => {
        if (!allowed()) return;
        start(); output?.refresh?.(false);
      }, 2000);
      discoveryTimer.unref?.();
    } else if (!enabled && discoveryTimer) { cancelRepeat(discoveryTimer); discoveryTimer = undefined; }
    return !closed && (enabled || options().record_runs === true || drawing());
  };
  const api = {
    call: opaque,
    connectHost(client) { if (hostClient === client) return; hostClient = client; if (sessionStart) toHost(sessionStart); },
    get narration() { return options().narration ?? 'off'; },
    setPaused(value) { if (typeof value !== 'boolean' || paused === value) return; paused = value; api.status(value ? 'paused' : 'idle'); },
    get labels() { return options().labels ?? 'off'; },
    get enabled() { return allowed(); },
    host(value) { if (!started && ['claude-code', 'codex', 'other'].includes(value)) host = value; },
    /** Emits the record and returns it. With held, the host gets it only from a later forward(record). */
    action(input, { held = false } = {}) {
      if (!allowed()) return;
      const record = actionRecord(input, api.labels, platform);
      if (record) { if (options().narration && options().narration !== 'off') put(record, 'say', narrationLine(input.say)); start(); return emit({ type: 'action', ...record }, held); }
    },
    forward(event) { if (!closed && event) toHost(event); },
    screenshot(content, detail) {
      if (closed || options().record_runs !== true) return;
      start();
      try {
        if (!recording) { recording = recorder({ enabled: () => options().record_runs === true, now }); if (sessionStart) recording.write(sessionStart); }
        recording.screenshot(content, detail);
      } catch {}
    },
    flushRecording: () => recording?.flush(),
    status(state, detail = {}) {
      if (!allowed() || !states.has(state)) return;
      detail ??= {};
      const turnEnd = state === 'handback' || state === 'done' && !detail.call;
      if (paused && state !== 'paused' && !turnEnd) return;
      start(false); const record = { type: 'status', state }; if (details.has(detail.detail)) record.detail = detail.detail; if (callId(detail.call)) record.call = detail.call; put(record, 'app', text(detail.app)); if (options().narration && options().narration !== 'off') put(record, 'say', narrationLine(detail.say)); emit(record);
    },
    close() {
      if (closed) return recordingClosed;
      if (started && allowed()) emit({ type: 'session', state: 'end', host, version: release });
      narrationOutput.close(); closed = true; cancelRepeat(discoveryTimer); discoveryTimer = undefined; output?.close();
      recordingClosed = recording?.close()?.catch?.(() => {});
      return recordingClosed;
    },
  };
  allowed();
  return api;
}

let sharedEvents;
export const sessionCursorEvents = (options) => sharedEvents ??= createCursorEvents(options);
// One asynchronous call context in a worker, shared by browser and Electron action runners.
const context = new AsyncLocalStorage();
export const cursorStreamEnabled = () => process.env.SLEIGHT_HAND !== '0' && (cachedHandSetting().stream === true || cachedHandSetting().record_runs === true || cursorDrawing(cachedHandSetting()));
export const withCursorCall = (source, fn, enabled = cursorStreamEnabled(), say) =>
  enabled ? context.run({ call: opaque(), index: 0, source, say: narrationLine(say) }, fn) : fn();
export function cursorStep() {
  const call = context.getStore();
  return call ? { call: call.call, index: call.index++, source: call.source, ...call.say ? { say: call.say } : {} } : { call: opaque(), index: 0, source: 'turbo' };
}
export function workerCursorStatus(state, detail = {}) {
  try {
    if (process.connected && cursorStreamEnabled() && states.has(state)) {
      const record = { state }; if (details.has(detail.detail)) record.detail = detail.detail;
      const call = context.getStore()?.call;
      if (callId(call)) record.call = call;
      put(record, 'app', text(detail.app));
      if (cachedHandSetting().narration !== 'off') put(record, 'say', narrationLine(context.getStore()?.say));
      process.send({ version: 3, cursorStatus: record });
    }
  } catch {}
}
export function workerCursorAction(record) {
  try {
    const setting = cachedHandSetting();
    if (process.connected && (setting.stream || setting.record_runs || cursorDrawing(setting)) && process.env.SLEIGHT_HAND !== '0') {
      const event = actionRecord(record, setting.labels ?? 'off');
      if (event && setting.narration && setting.narration !== 'off') put(event, 'say', narrationLine(record.say));
      if (event) process.send({ version: 3, cursor: event });
    }
  } catch {}
}
