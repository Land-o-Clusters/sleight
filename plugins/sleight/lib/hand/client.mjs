// The relay owns one consent-capable ghost hand host per session. Turbo workers inherit its consent pipes, and browser
// artwork comes back over worker IPC to this same client. The parent's copies keep the host alive between workers. send and hide
// are fire-and-forget pipe writes that never throw or wait. A dead host or a failed spawn only traces, and the session goes on
// without a hand. A cold build runs off the caller's path and starts the hand in this session when ready.
//
// Caller frames: { kind, pid, windowId, at: [x, y], path: [[x, y], ...], delayMs, beats } in global top-left screen points
// (kCGWindowBounds and AX frames). kind is click, double, right, key, type, drag or scroll. The hand glides along path into at
// and flourishes there beats times; a drag grabs at at and carries along path. path defaults to [at], delayMs to 0 and beats to 1.
import { randomBytes } from 'node:crypto';
import { readFileSync, watch as fsWatch } from 'node:fs';
import { dirname, join } from 'node:path';
import { handCursorStyles, handHostBuilt, prepareHandHost } from '../direct-browser/host.mjs';
import { characterIdValid, handConfigPath, handSetting } from './settings.mjs';
import { characterFrame } from './character-frame.mjs';
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
  if (!frame || typeof frame !== 'object') return 'kind';
  const extra = frame.hand === 'aim' || frame.hand === 'status';
  if (!extra && !kinds.has(frame.kind)) return 'kind';
  const pid = id(frame.pid, 2147483647), windowId = id(frame.windowId, 4294967295), at = point(frame.at);
  if (!pid || !windowId || (!at && frame.hand !== 'status')) return 'target';
  const label = typeof frame.label === 'string' && !/[\x00-\x1f\x7f]/.test(frame.label) ? [...frame.label].slice(0, 40).join('') : undefined;
  if (frame.hand === 'status') return ['waiting', 'error', 'done', 'handback', 'thinking'].includes(frame.state)
    ? { hand: 'status', state: frame.state, pid, windowId, ...at ? { at } : {}, ...frame.state === 'done' && typeof frame.ok === 'boolean' ? { ok: frame.ok } : {} } : 'state';
  const rect = Array.isArray(frame.rect) && frame.rect.length === 4 && frame.rect.every(v => Number.isFinite(v) && Math.abs(v) <= 100000) && frame.rect[2] > 0 && frame.rect[3] > 0 ? frame.rect.map(round) : undefined;
  if (frame.hand === 'aim') {
    // The host's aim draws the same for every kind and its kind list has no move, so a move aim goes as click.
    if (frame.kind !== 'move' && !kinds.has(frame.kind)) return 'kind';
    return { hand: 'aim', kind: frame.kind === 'move' ? 'click' : frame.kind, pid, windowId, at, holdMs: 0, ...rect ? { rect } : {}, ...label ? { label } : {} };
  }
  const raw = frame.path === undefined || Array.isArray(frame.path) && !frame.path.length ? [frame.at] : frame.path;
  if (!Array.isArray(raw)) return 'path';
  const path = thin(raw).map(point);
  if (path.some(p => !p)) return 'path';
  const delayMs = Math.min(10000, Math.max(0, Math.round(Number.isFinite(frame.delayMs) ? frame.delayMs : 0)));
  const beats = Math.min(20, Math.max(1, Math.round(Number.isFinite(frame.beats) ? frame.beats : 1)));
  // caretX: the type or key caret's x in global points, which the ring's bottom gap rides.
  const caretX = ['type', 'key'].includes(frame.kind) && Number.isFinite(frame.caretX) && Math.abs(frame.caretX) <= 100000 ? round(frame.caretX) : undefined;
  return { kind: frame.kind, pid, windowId, at, path, delayMs, beats, ...label ? { label } : {}, ...rect ? { rect } : {}, ...caretX !== undefined ? { caretX } : {} };
}

// The process's latest open client: turbo's bridge shares its host.
let current;
const sharing = new WeakMap();
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
  const { loadCharacter, charactersDirectory, resolveCharacterStates } = await import('./character.mjs');
  return { character: loadCharacter(join(charactersDirectory(), id), { installed: true }), resolve: resolveCharacterStates };
};

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
export function createHandClient({ env = process.env, setting = () => handSetting({ env }), built = handHostBuilt, prepare = prepareHandHost,
  trace = () => {}, now = Date.now, defer = setImmediate, recheckMs = 60000, killAfterMs = 2000,
  setHand = async enabled => (await import('./command.mjs')).writeHandSetting({ enabled }),
  permissions = { menu: async () => (await command()).permissionsMenu(), apply: async (event, offered) => (await command()).applyMenuEvent(event, offered) },
  currentApp = noted, usage = logUsage(env), usageMs = 300000, cursorStyle, character, loadSprite = installedSprite, cursorPicker,
  watch = (folder, listener) => process.platform === 'darwin' ? fsWatch(folder, { persistent: false }, listener) : undefined } = {}) {
  if (cursorStyle !== undefined && !handCursorStyles.includes(cursorStyle)) throw Error('HAND_CURSOR_STYLE_INVALID');
  const nonce = randomBytes(32).toString('hex'), queue = [];
  // host: none, starting, running or dead (failed or closed this session; final). hand: the settings allow the hand.
  let seq = 0, child, host = 'none', starting, hand = false, capture = 'hidden', checked = now(), checking = false, events = '', target;
  let style = cursorStyle;
  let buildController, buildStarted;
  // Hosts with an attached worker are left to finish their consent channel before exiting.
  const attached = new WeakSet();
  let consentClaimed = false, resetting;
  const resetWaiters = new Map();
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
      capture = value?.capture === 'visible' ? 'visible' : 'hidden';
      return value?.enabled === true;
    } catch { return false; }
  };
  hand = read();
  const note = (direction, detail) => { try { trace(direction, detail); } catch {} };
  const write = line => {
    try {
      if (child.stdin.writableLength > 65536) { note('hand-dropped', { reason: 'backpressure' }); return; }
      child.stdin.write(line);
    } catch (error) { note('hand-dropped', { reason: error?.code ?? 'write' }); }
  };
  const act = (wire, delayMs = wire.delayMs) => JSON.stringify(wire.hand
    ? { ...wire, nonce, seq: ++seq }
    : { hand: 'act', nonce, seq: ++seq, kind: wire.kind, pid: wire.pid,
      windowId: wire.windowId, at: wire.at, path: wire.path, delayMs, beats: wire.beats,
      ...style !== 'glove' ? { ...wire.label ? { label: wire.label } : {}, ...wire.rect ? { rect: wire.rect } : {},
        ...wire.caretX !== undefined ? { caretX: wire.caretX } : {} } : {} }) + '\n';
  // perms: the last Permissions rows sent, with the targets a click may act on; permsText detects a change.
  let perms, permsText, permsApp, refreshing = false, again = false;
  // stats: the usage row last sent, and when the log was last read.
  let stats, statsText = 'null', statsAt = -Infinity;
  const menu = () => JSON.stringify({ hand: 'menu', nonce, enabled: hand, capture, version, ...perms?.payload ? { permissions: perms.payload } : {},
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
  const die = (reason, detail) => { if (host === 'dead') return; host = 'dead'; stop(); note('hand-off', { reason, ...detail }); };
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
  const pickerNotice = text => pickerFrame({ op: 'notice', text: String(text).replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ch => ch === '\n' ? '\n' : '').slice(0, 3000) });
  async function pickerCatalog(picker) {
    const catalog = await picker.catalog({ style, character });
    if (host !== 'running') return;
    const frame = { op: 'catalog', rows: catalog.rows };
    if (Buffer.byteLength(JSON.stringify(frame)) > 64000 || catalog.rows.length > 512 || catalog.rows.some(r => r.children?.length > 512)) {
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
    if (style === 'sprite') {
      try {
        const loaded = await loadSprite(character);
        sprite = characterFrame(loaded.character, { nonce, seq: 0, resolve: loaded.resolve });
      } catch (error) {
        pickerNotice(`This character could not load. Showing the ring. ${error.message}`);
        await pickerFallback(picker, character);
        return;
      }
    }
    if (host !== 'running') return;
    pickerFrame({ op: 'style', style });
    if (sprite) { pickerLoad = sprite.id; write(JSON.stringify({ ...sprite, seq: ++seq }) + '\n'); }
  }
  function pickerEvent(event, internal = false) {
    if (event.hand !== 'picker') return false;
    const keys = Object.keys(event).sort().join();
    if (cursorPicker === null || event.nonce !== nonce || !(internal && keys === 'character,hand,nonce,op' && event.op === 'fallback' && characterIdValid(event.character) ||
        keys === 'hand,nonce,op' && event.op === 'refresh' ||
        keys === 'hand,key,nonce,op' && event.op === 'import' && /^[0-9a-f]{64}$/.test(event.key) ||
        keys === 'hand,nonce,op,style' && event.op === 'select' && ['ring', 'seam', 'glove'].includes(event.style) ||
        keys === 'character,hand,nonce,op,style' && event.op === 'select' && event.style === 'sprite' && characterIdValid(event.character))) {
      note('hand-picker-refused', {}); return true;
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
        if (result.ok) await pickerStyle(result, picker);
        if (result.text) pickerNotice(result.text);
      }
      await pickerCatalog(picker);
    }).catch(error => { if (host === 'running') pickerNotice(`The Cursor menu could not update: ${error.message}`); })
      .finally(() => { pickerBusy = false; const next = pickerQueue.shift(); if (next) pickerEvent(next.event, next.internal); });
    return true;
  }
  // The Ghost Hand row's clicks: exact { hand: 'toggle', nonce, enabled } lines with this session's nonce, on the host's stdout.
  function onEvents(chunk) {
    events += chunk;
    if (events.length > 65536) { events = ''; note('hand-toggle-refused', { reason: 'size' }); return; }
    let end;
    while ((end = events.indexOf('\n')) >= 0) {
      const text = events.slice(0, end); events = events.slice(end + 1);
      let event;
      try { event = JSON.parse(text); } catch {}
      if (event?.hand === 'consent-ready' && event.nonce === nonce && Object.keys(event).sort().join() === 'hand,nonce,token') {
        resetWaiters.get(event.token)?.(); continue;
      }
      if (event && typeof event === 'object' && Object.hasOwn(event, 'permissions') && permissionEvent(event)) continue;
      if (event?.hand === 'character' && characterEvent(event)) continue;
      if (event && typeof event === 'object' && pickerEvent(event)) continue;
      if (!event || typeof event !== 'object' || Object.keys(event).sort().join() !== 'enabled,hand,nonce' || event.hand !== 'toggle' ||
          event.nonce !== nonce || typeof event.enabled !== 'boolean') { note('hand-toggle-refused', {}); continue; }
      Promise.resolve().then(() => setHand(event.enabled)).then(() => recheck(true),
        error => note('hand-toggle-failed', { code: /^[A-Z][A-Z0-9_]{0,127}$/.test(error?.message) ? error.message : 'HAND_SETUP_FAILED' }));
    }
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
      const result = await prepare({ signal: buildController.signal, onProgress: detail => note('hand-build', detail) });
      buildController = undefined;
      if (cold) note('hand-built', { status: result?.status, code: result?.code, ...result?.detail ? { detail: result.detail } : {} });
      if (host === 'dead') return undefined;
      if (result?.status !== 'ready') { die('unavailable', { code: result?.code, ...result?.detail ? { detail: result.detail } : {} }); return undefined; }
      // The first menu frame already carries the Permissions rows. The usage row follows once the log is read.
      await loadPermissions();
      if (host === 'dead') return undefined;
      // Sprite style needs a valid installed character. Without one the host draws the ring, with one trace line.
      let sprite;
      if (style === 'sprite') {
        try {
          if (!characterIdValid(character)) throw Error('CHARACTER_NOT_SET');
          const { character: loaded, resolve } = await loadSprite(character);
          // Built now, so a character the host would refuse for size falls back before the spawn; its seq is set on send.
          sprite = characterFrame(loaded, { nonce, seq: 0, resolve });
        } catch (error) {
          note('hand-sprite-fallback', { reason: /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.message) ? error.message : 'CHARACTER_INVALID' });
          style = 'ring';
        }
        if (host === 'dead') return undefined;
      }
      const started = result.spawn({ capture, consent, ...cursorStyle !== undefined || style !== 'glove' ? { cursorStyle: style } : {} });
      started.on('error', error => { if (child === started) die('spawn', { code: error?.code }); });
      started.stdin.on('error', error => note('hand-dropped', { reason: error?.code ?? 'pipe' }));
      started.stdout?.on('data', onEvents);
      for (const end of [started.stdio?.[3], started.stdio?.[4]]) end?.on('error', () => note('hand-consent-unavailable', {}));
      started.on('exit', (code, signal) => { if (child === started) { setHandPid(0); die('exit', { code, signal }); } else if (!child) setHandPid(0); });
      child = started; host = 'running';
      setHandPid(started.pid);
      note('hand-started', { pid: started.pid, consent });
      write(menu());
      // The character frame goes once, before any queued act, on the acts' sequence counter.
      if (sprite) write(JSON.stringify({ ...sprite, seq: ++seq }) + '\n');
      statsAt = -Infinity;
      refreshUsage();
      for (const { wire, at } of queue.splice(0)) {
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
  function ensure() {
    if (host === 'running') return Promise.resolve(true);
    if (host === 'dead') return Promise.resolve(false);
    if (!starting) begin(serial(true));
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
      const before = [hand, capture];
      hand = read();
      if (!hand) queue.length = 0;
      if (host === 'running' && (before[0] !== hand || before[1] !== capture)) {
        if (!hand) { write(JSON.stringify({ hand: 'hide', nonce }) + '\n'); note('hand-off', { reason: 'setting' }); }
        write(menu());
      }
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
    send(frame) {
      recheck();
      // A new app to act in changes the menu's Never Act in row.
      if (host === 'running' && currentApp()?.bundleId !== permsApp) refreshPermissions();
      if (!hand || host === 'dead') return;
      if (style === 'glove' && ['aim', 'status'].includes(frame?.hand)) return;
      const wire = handWireFrame(frame);
      if (typeof wire === 'string') { note('hand-dropped', { reason: wire }); return; }
      if (wire.hand !== 'status') target = { pid: wire.pid, windowId: wire.windowId, at: wire.at };
      if (host === 'running') { write(act(wire)); return; }
      if (queue.length < 32) queue.push({ wire, at: now() });
      ensure();
    },
    // Records already passed the cursor privacy projection. Aim and status share act's nonce and sequence.
    // An aim without a point and window (the admission preview) has nothing to draw and is no dropped frame.
    cursor(event) {
      if (style === 'glove' || !hand || host === 'dead') return;
      if (event?.type === 'action' && event.phase === 'aim') {
        if (!event.point || !event.window?.pid || !event.window?.id) return;
        client.send({ hand: 'aim', kind: ['select', 'navigate'].includes(event.kind) ? 'click' : event.kind, pid: event.window.pid, windowId: event.window.id,
          at: event.point, rect: event.rect, label: event.label });
      } else if (event?.type === 'status' && target && event.state !== 'idle') {
        // A call's done is its success; the ring bursts for it.
        client.send({ hand: 'status', state: event.state, ...target, ...event.state === 'done' && event.call ? { ok: true } : {} });
      }
    },
    hide() {
      if (host === 'running') write(JSON.stringify({ hand: 'hide', nonce }) + '\n');
      else queue.length = 0;
    },
    close() {
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
    get pid() { return child?.pid; },
    get enabled() { return hand && host !== 'dead'; },
  });
  // Keep the parent's descriptors until session close. A worker ending then cannot end the host.
  // Reattachment requires the old worker's exit and a nonce-bound reset acknowledged by the host.
  sharing.set(client, async () => {
    if (consentClaimed) throw Error('HAND_CONSENT_IN_USE');
    if (host === 'dead') return undefined;
    // Cold compilation must not hold turbo startup. It may use its own consent host meanwhile.
    let cached;
    try { cached = built(); } catch { cached = false; }
    if (host !== 'running' && !cached) { ensure(); return undefined; }
    consentClaimed = true;
    try {
      await resetting;
      if (!await ensure() || !child?.stdio?.[3] || !child.stdio[4]) throw Error('HAND_HOST_UNAVAILABLE');
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
  current = client;
  return client;
}
