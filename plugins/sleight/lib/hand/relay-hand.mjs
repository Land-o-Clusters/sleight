// The relay's side of the ghost hand: after admission decides a js call, plan its frames beside the engine
// call and send them to the hand host at their beats. The relay calls admit, approval, answered, result, hide
// and close, all fire-and-forget: none returns anything, throws or holds the call, and nothing here reads or
// changes what the relay sends the engine or Claude. Without a client (settings off, no client module, a
// dead host) every call is a no-op.
//
// Beats: an accepted engine approval request (one per click, key, value or drag, except for apps on the
// engine's own Always allow list) is the exact moment of its action. Once an app's actions have come with
// approvals this session, its frames wait for them. Otherwise each frame goes out with the time left on the
// planner's schedule. The result re-anchors frames still unsent at its own time, a warm write apart.
import { createHash } from 'node:crypto';
import { createHandSettingReader, handSettingReader } from './settings.mjs';
import { planHandFrames, handTargets, WRITE_MS, GUARD_READ_MS, createRetryMarks } from './planner.mjs';
import { cursorRecord, cursorReason, createCursorEvents } from './events.mjs';

// The kinds an approval's tool_name stands for. Unknown names beat the next action of any kind.
const APPROVAL_KINDS = { click: ['click', 'double', 'right'], press_key: ['key'], set_value: ['type'], type_text: ['type'], drag: ['drag'], scroll: ['scroll'] };
const STALE_MS = 60000;
// ST1 owner decision 6: reversible default. UI pointing is advice and never changes admission or consent.
const CURSOR_HINTS_ENABLED = true;

export function createRelayHand({ client, loadClient = () => import('./client.mjs'), clientOptions = {}, locate,
  trace = () => {}, now = () => performance.now(), defer = fn => setImmediate(fn), locateTimeoutMs = 2000, lateMs = 1500,
  env = process.env, setting = handSettingReader(env), events, record = cursorRecord, schedule = setTimeout, cancel = clearTimeout,
  hintNow = Date.now } = {}) {
  setting = createHandSettingReader({ setting });
  if (env.SLEIGHT_HAND === '0' || !(setting().enabled || setting().stream || setting().record_runs) || typeof locate !== 'function') return undefined;
  const ownsEvents = !events;
  events ??= createCursorEvents({ setting, env });
  try { events.connectHost?.(client); } catch {}
  let closed = false, locating = false, resolved = client ?? undefined, loading, pendingHide = false, protectionEpoch = 0;
  let hint, hintGeneration = 0, detachHints, hintDeliveredAt = -Infinity;
  function connectHints(c) {
    detachHints?.();
    if (!CURSOR_HINTS_ENABLED) return;
    detachHints = c?.onHint?.(value => {
      const generation = ++hintGeneration;
      hint = undefined;
      if (!value) return;
      // This lookup reads WindowServer ownership only. No AX or lease is needed to point at an app.
      Promise.resolve().then(() => locate({ hint: { pid: value.pid, windowId: value.windowId, at: value.at } })).then(owner => {
        if (closed || generation !== hintGeneration || c.enabled === false || hintNow() < value.ts || hintNow() - value.ts >= 60000 ||
            !owner?.ok || owner.pid !== value.pid || owner.windowId !== value.windowId || typeof owner.app !== 'string' ||
            !owner.app.trim() || owner.app.length > 80 || /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(owner.app)) return;
        hint = { app: owner.app, windowId: value.windowId, at: [...value.at], ts: value.ts };
      }).catch(() => {});
    });
  }
  connectHints(resolved);
  const load = () => loading ??= (client ? Promise.resolve(client) : Promise.resolve().then(loadClient).then(m => m.createHandClient({ ...clientOptions, cursorStyle: setting().style })))
    .then(c => (resolved = c && typeof c.send === 'function' ? c : null), () => (resolved = null))
    .then(() => { connectHints(resolved); try { events.connectHost?.(resolved); } catch {} if (pendingHide) hideClient(); });
  // Hides now, or as soon as a client still loading arrives.
  function hideClient() {
    if (resolved === undefined) { pendingHide = true; return; }
    pendingHide = false;
    try { resolved?.hide(); } catch {}
  }
  const live = () => !closed && (resolved && resolved.enabled !== false || events.enabled);
  const retries = createRetryMarks({ now });
  const calls = new Map(); // call id -> call, admission order
  const approvals = new Map(); // engine request id -> { call, tool }
  const approvalApps = new Set(); // lowercased app names and bundle IDs whose actions came with approvals
  const names = target => [target?.app, target?.appId].filter(n => typeof n === 'string').map(n => n.toLowerCase());
  const held = call => names(call.target).some(n => approvalApps.has(n));
  const note = (reason, call, extra) => trace('hand-skipped', { id: call.id, ...extra, reason });
  const guarded = fn => (...args) => { try { fn(...args); } catch { /* The hand never reaches the relay. */ } };
  const cursorCalls = new Set();
  const cursorById = new Map();
  const staged = () => { if (typeof resolved?.areaProtectionEnabled === 'boolean') return resolved.areaProtectionEnabled;
    const value = setting(); return value.enabled && value.style === 'sprite' &&
    (['medium', 'stage'].includes(value.size) || typeof value.size === 'number'); };
  // A failed point lookup still has a containing window or app. These private status frames
  // draw no marker and carry no content. The host observes and retains the entire area.
  function protectKnown(target, geometry, epoch = protectionEpoch) {
    if (closed || epoch !== protectionEpoch || !staged()) return false;
    const pid = geometry?.pid ?? geometry?.window?.pid ?? target?.nativeIdentity?.pid ?? target?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    const known = !geometry?.pid || geometry.pid === (target?.nativeIdentity?.pid ?? target?.pid);
    const windowId = geometry?.window?.windowId ?? (known ? target?.windowNumber ?? target?.nativeIdentity?.windowNumber : undefined);
    const b = geometry?.window?.bounds;
    resolved?.send({ hand: 'status', state: 'thinking', pid, windowId: windowId ?? 0,
      area: windowId ? 'window' : 'app', ...b ? { windowRect: [b.X, b.Y, b.Width, b.Height] } : {} });
    return true;
  }
  function protectWide(target, epoch = protectionEpoch, reason = 'unlocated') {
    if (closed || epoch !== protectionEpoch || !staged() || resolved === undefined) return false;
    const pid = target?.nativeIdentity?.pid ?? target?.pid;
    const windowId = target?.windowNumber ?? target?.nativeIdentity?.windowNumber;
    const app = target?.app ?? target?.appId;
    if (!Number.isSafeInteger(pid) && !app) { resolved?.hide('unknown-app'); return false; }
    resolved?.send({ hand: 'wide', ...Number.isSafeInteger(pid) ? { pid, ...windowId ? { windowId } : {} } : { app }, reason, epoch });
    return true;
  }
  async function protect(target, epoch = protectionEpoch, reason = 'read', valid = () => true) {
    if (closed || epoch !== protectionEpoch || !staged() || !valid()) return;
    if (resolved === undefined) await load();
    if (closed || epoch !== protectionEpoch || !valid()) return;
    protectWide(target, epoch, reason);
  }
  const publish = (call, entry, phase, reason, held = false) => {
    if (!call.cursor) return;
    try { return events.action({ ...entry.record, say: call.input.say, call: call.cursor, index: entry.index, source: 'native', phase, ...(reason ? { reason: cursorReason(reason) } : {}) }, { held }); } catch {}
  };
  const cancelActs = call => { for (const timer of call.timers ?? []) cancel(timer); call.timers = []; call.heldAims?.clear(); };
  // The host draws an action's aim once the act before it goes out, so the ring shows one target at a time. The public
  // stream already has every aim from plan time. heldAims maps the earlier planned action to the later action's aim record.
  const releaseAim = (call, action) => {
    const aim = call.heldAims?.get(action);
    if (!aim) return;
    call.heldAims.delete(action);
    try { events.forward?.(aim); } catch {}
  };
  function finishCursor(call, phase) {
    cancelActs(call);
    if (call.cursorTerminated) return;
    call.cursorTerminated = true;
    for (const entry of call.cursorEntries ?? call.cursorPreviewEntries ?? []) if (!entry.ended) { entry.ended = true; publish(call, entry, phase); }
    cursorCalls.delete(call);
  }
  const cursorPlan = guarded((call, geometry, planned, reason) => {
    if (!call.cursor || call.cursorEntries || call.cursorTerminated || call.cursorHidden) return;
    const actions = call.targets?.actions?.length ? call.targets.actions : [{ kind: 'move' }];
    let previous, before;
    call.heldAims = new Map();
    call.cursorEntries = actions.map((action, index) => {
      const n = planned?.actions.indexOf(index) ?? -1, frame = n >= 0 ? planned.frames[n] : undefined;
      const identity = call.targets?.identities[action.target?.number] ?? (action.target?.focus ? geometry?.focused : action.target?.previous ? previous : undefined);
      if (!['type', 'key'].includes(action.kind)) previous = identity;
      const projected = record({ frame, action: { ...identity, retry: action.retry, transfer: action.transfer, kind: action.kind, rect: geometry?.elements?.[action.target?.number],
        secure: identity?.role === 'AXSecureTextField' || (['type', 'key'].includes(action.kind) && !identity?.role) }, geometry,
        target: call.target, labels: events.labels });
      const entry = { index, record: projected };
      if (frame && (projected.label || projected.rect) && setting().style && setting().style !== 'glove') {
        const hostEntry = call.entries?.find(e => e.action === index);
        if (hostEntry) hostEntry.frame = { ...hostEntry.frame, ...projected.label ? { label: projected.label } : {}, ...projected.rect ? { rect: projected.rect } : {} };
      }
      const skip = reason ?? planned?.skipped.find(s => s.action === index)?.reason;
      if (!frame || skip) { entry.skipped = true; entry.ended = true; publish(call, entry, 'skipped', skip ?? 'unplanned'); }
      else {
        // The first planned aim goes to the host now, each later one when the act before it goes out.
        const pending = before !== undefined && !call.entries?.find(e => e.action === before)?.sent;
        const aim = publish(call, entry, 'aim', undefined, pending);
        if (pending && aim) call.heldAims.set(before, aim);
        before = index;
        if (!call.done && !call.dropped) {
          const act = () => { if (!call.done && !call.dropped && !call.cursorHidden && !closed) publish(call, entry, 'act'); };
          const delay = Math.max(0, call.startedAt + frame.delayMs - now());
          if (!delay) act(); else { const timer = schedule(act, delay); timer?.unref?.(); call.timers.push(timer); }
        }
      }
      return entry;
    });
    if (call.done || call.dropped) finishCursor(call, call.declined ? 'declined' : call.failed || call.dropped ? 'failed' : 'done');
  });
  function previewCursor(call) {
    if (!call.cursor) return;
    const lines = typeof call.input.lines === 'function' ? call.input.lines() : call.input.lines;
    const targets = call.input.unplanned ? { skip: 'unplanned' } : handTargets({ code: call.input.code, target: call.target, lines });
    if (targets.skip || !targets.actions.length) {
      const entry = { index: 0, record: record(), skipped: true, ended: true };
      call.cursorEntries = [entry]; publish(call, entry, 'skipped', 'unplanned'); return;
    }
    call.targets = targets;
    const window = call.target?.windowNumber ?? call.target?.nativeIdentity?.windowNumber;
    let previousTarget;
    for (const action of targets.actions) {
      const target = action.target?.point ?? targets.identities[action.target?.number] ?? (action.target?.previous ? previousTarget : undefined);
      action.retry = retries.mark(action.kind, window, target);
      if (['click', 'double', 'right'].includes(action.kind) || action.method === 'setValue') previousTarget = target;
    }
    let previous;
    call.cursorPreviewEntries = targets.actions.map((action, index) => {
      const identity = targets.identities[action.target?.number] ?? (action.target?.previous ? previous : undefined);
      if (['click', 'double', 'right'].includes(action.kind) || action.method === 'setValue') previous = identity;
      const projected = record({ action: { ...identity, retry: action.retry, transfer: action.transfer, kind: action.kind, count: action.beats,
        secure: ['type', 'key'].includes(action.kind) && !identity?.role }, labels: events.labels });
      const entry = { index, record: projected }; publish(call, entry, 'aim'); return entry;
    });
  }
  // Only this call: a resent call with the same id may have replaced it.
  const forget = call => {
    if (calls.get(call.id) === call) calls.delete(call.id);
    if ((call.cursorTerminated || call.cursorEntries?.every(e => e.ended)) && cursorById.get(call.id) === call) {
      cursorById.delete(call.id); cursorCalls.delete(call);
    }
  };

  function send(call, entry, delayMs) {
    entry.sent = true; entry.due = now() + delayMs;
    try { if (live()) resolved?.send({ ...entry.frame, ...call.input.say ? { say: call.input.say } : {}, delayMs: Math.max(0, Math.round(delayMs)) }); } catch {}
    releaseAim(call, entry.action);
  }

  function dispatch(call) {
    if (!call.entries || call.dropped) return;
    let k = 0;
    for (const entry of call.entries) {
      if (entry.sent) continue;
      if (call.done) {
        if (now() - call.doneAt > lateMs) { entry.sent = true; protectWide(call.target, call.protectionEpoch, entry.frame.kind === 'scroll' ? 'scroll' : 'unlocated'); note('late', call, { action: entry.action }); continue; }
        send(call, entry, k++ * WRITE_MS);
      } else if (entry.action < call.beatIndex) send(call, entry, 0);
      else if (held(call)) break;
      else send(call, entry, entry.plannedAt - now());
    }
    if (call.done) forget(call);
  }

  function beat(call, tool, at = now()) {
    const kinds = APPROVAL_KINDS[tool];
    let index = call.kinds.findIndex((kind, i) => i >= call.beatIndex && (!kinds || kinds.includes(kind)));
    if (index < 0) index = call.beatIndex;
    if (index >= call.kinds.length) return;
    call.beatIndex = index + 1;
    const entry = call.entries.find(e => e.action === index);
    if (entry && !entry.sent) call.beatTimes.push({ action: index, at });
    dispatch(call);
  }

  async function plan(call) {
    // Recording consumes points already known to the cursor. It never buys another engine/helper read.
    if (!setting().enabled && !setting().stream) { forget(call); return; }
    // The read and screenshot as the relay knows them now, before any later result changes them.
    const lines = typeof call.input.lines === 'function' ? call.input.lines() : call.input.lines;
    const screenshotSize = typeof call.input.screenshotSize === 'function' ? call.input.screenshotSize() : call.input.screenshotSize;
    const { code, target } = call.input;
    if (resolved === undefined && setting().enabled) await load();
    const targets = call.targets ??= handTargets({ code, lines, target });
    if (call.input.unplanned) { cursorPlan(call, undefined, undefined, 'unplanned'); forget(call); return; }
    if (call.input.areaTargets && !call.areaAdmitted) {
      call.areaAdmitted = true;
      for (const known of call.input.areaTargets.filter(Boolean)) protectWide(known, call.protectionEpoch,
        /\.scroll\s*\(/.test(code) ? 'scroll' : 'unlocated');
      if (call.input.areaTargets.some(known => !known)) protectWide(undefined, call.protectionEpoch);
    }
    if (targets.skip || !targets.actions.length) {
      const reason = /\.scroll\s*\(/.test(code) ? 'scroll' : targets.skip === 'acquisition' ? 'acquisition' : 'read';
      if (!call.input.areaTargets) protectWide(target, call.protectionEpoch, reason);
    }
    if (!live() || call.dropped) { cursorPlan(call, undefined, undefined, 'no-geometry'); forget(call); return; }
    if (targets.skip || !targets.actions.length) {
      cursorPlan(call, undefined, undefined, targets.skip ?? 'unplanned'); forget(call);
      if (targets.skip) note(targets.skip, call);
      return;
    }
    // One helper at a time: a call admitted while the last one's frames are still looked up gets no hand.
    if (locating) { protectWide(target, call.protectionEpoch, targets.actions.some(a => a.kind === 'scroll') ? 'scroll' : 'unlocated'); cursorPlan(call, undefined, undefined, 'unplanned'); forget(call); note('busy', call); return; }
    locating = true;
    let geometry, timer;
    try {
      // Only hash the requested lines, without allocating another map of the whole engine tree.
      const versions = Object.fromEntries(Object.keys(targets.identities).map(n => {
        const line = typeof lines === 'string' ? new RegExp('^\\t*' + n + ' (.+)$', 'm').exec(lines)?.[1] : lines?.[n];
        return [n, createHash('sha256').update(line ?? '').digest('hex')];
      }));
      const request = Object.fromEntries(Object.entries({ app: target?.app, appId: target?.appId, title: target?.title,
        windowNumber: target?.windowNumber ?? target?.nativeIdentity?.windowNumber, pid: target?.nativeIdentity?.pid,
        identities: targets.identities, versions, focus: targets.focus }).filter(([, v]) => v !== undefined));
      geometry = await Promise.race([Promise.resolve().then(() => locate(request)),
        new Promise(resolve => { timer = setTimeout(resolve, locateTimeoutMs); timer.unref?.(); })]);
    } catch { geometry = undefined; } finally { clearTimeout(timer); locating = false; }
    if (!live() || call.dropped) { cursorPlan(call, undefined, undefined, 'no-geometry'); forget(call); return; }
    if (!geometry?.ok) { protectKnown(target, undefined, call.protectionEpoch); protectWide(target, call.protectionEpoch, targets.actions.some(a => a.kind === 'scroll') ? 'scroll' : 'unlocated'); cursorPlan(call, undefined, undefined, 'no-geometry'); forget(call); note('no-geometry', call); return; }
    const { window, elements, focused, windows, displays, state } = geometry;
    const planned = planHandFrames({ code, lines, screenshotSize, target, window, elements, focused, windows, displays, state,
      ignorePids: [resolved?.pid].filter(Number.isSafeInteger), targets, bindings: call.bindings });
    for (const skip of planned.skipped) note(skip.reason, call, skip.action === undefined ? {} : { action: skip.action, method: skip.method });
    if (planned.skipped.length || !planned.frames.length) {
      protectKnown(target, geometry);
      protectWide(target, call.protectionEpoch, targets.actions.some(a => a.kind === 'scroll') ? 'scroll' : 'unlocated');
    }
    call.kinds = targets.actions.map(a => a.kind);
    call.entries = planned.frames.map((frame, i) => ({ frame, action: planned.actions[i], plannedAt: call.startedAt + frame.delayMs }));
    const ring = setting().style && setting().style !== 'glove';
    // Include labels and aim before an early approval can dispatch the first act.
    if (ring) cursorPlan(call, geometry, planned);
    const early = call.beats; call.beats = undefined;
    for (const { tool, at } of early) beat(call, tool, at);
    // Ring aim precedes its scheduled acts. Projection faults still cannot drop the original frames.
    dispatch(call);
    if (!ring) cursorPlan(call, geometry, planned);
    if (call.done) traceBeats(call);
  }

  function traceBeats(call) {
    for (const beat of call.beatTimes.splice(0)) {
      const entry = call.entries?.find(e => e.action === beat.action);
      if (entry) trace('hand-beat', { id: call.id, action: beat.action, driftMs: Math.round(beat.at - entry.plannedAt) });
    }
  }

  return {
    get turnEpoch() { return protectionEpoch; },
    get placementEnabled() { return !closed && staged() && typeof resolved?.clearForAction === 'function'; },
    async placeLocal(frame, epoch = protectionEpoch, deadline = Date.now() + 100) {
      if (closed || epoch !== protectionEpoch) { hideClient(); return false; }
      try { return await resolved?.clearForAction?.(frame, deadline) === true; }
      catch { hideClient(); return false; }
    },
    protect: guarded((target, valid = () => true) => {
      const epoch = protectionEpoch;
      defer(() => protect(target, epoch, 'read', valid).catch(() => {}));
    }),
    endTurn: guarded(() => {
      protectionEpoch++;
      for (const call of calls.values()) { call.dropped = true; cancelActs(call); }
      approvals.clear();
    }),
    localDrag: guarded((frame, epoch = protectionEpoch) => {
      if (!closed && epoch === protectionEpoch && staged() && (frame?.kind === 'drag' || frame?.hand === 'aim' && frame?.kind === 'move')) resolved?.send(frame);
    }),
    pointer: guarded(() => {
      for (const call of cursorCalls) { call.cursorHidden = true; cancelActs(call); }
      for (const call of calls.values()) call.dropped = true;
      calls.clear(); approvals.clear();
      if (!staged()) hideClient();
    }),
    takeHint() {
      const value = hint, time = hintNow(), age = value && time - value.ts;
      if (closed || resolved?.enabled === false || !value || age < 0 || age >= 60000) { hint = undefined; return; }
      // A correction replaces pending advice even during the delivery cooldown.
      if (time - hintDeliveredAt < 2000) return;
      hint = undefined; hintDeliveredAt = time;
      return { app: value.app, windowId: value.windowId, at: value.at, age: Math.floor(age / 1000) };
    },
    // input: { code, target, lines, screenshotSize }, lines and screenshotSize optionally as functions read on the next tick.
    admit: guarded((id, input) => {
      if (closed || id === undefined || typeof input?.code !== 'string') return;
      const call = { id, input, target: input.target, startedAt: now(), beatIndex: 0, beats: [], beatTimes: [], protectionEpoch };
      try {
        if (events.enabled) {
          call.cursor = events.call(); call.timers = []; cursorCalls.add(call); cursorById.set(id, call);
          previewCursor(call);
        }
      } catch {}
      // A resent call replaces its first try, and a call whose result never came stops counting after a minute.
      for (const [other, old] of calls) if (other === id || call.startedAt - old.startedAt > STALE_MS) { old.dropped = true; finishCursor(old, 'failed'); if (cursorById.get(other) === old) cursorById.delete(other); calls.delete(other); }
      calls.set(id, call);
      // A known leased identity is available now; failed geometry must not add the helper latency to first visibility.
      if (input.areaTargets && resolved !== undefined) {
        call.areaAdmitted = true;
        for (const known of input.areaTargets.filter(Boolean)) protectWide(known, call.protectionEpoch,
          /\.scroll\s*\(/.test(input.code) ? 'scroll' : 'unlocated');
        if (input.areaTargets.some(known => !known)) protectWide(undefined, call.protectionEpoch);
      }
      defer(() => plan(call).catch(() => forget(call)));
    }),
    // An engine approval request seen while a call runs, with its _meta.
    approval: guarded((requestId, meta) => {
      const call = [...calls.values()].reverse().find(c => !c.done && !c.dropped);
      if (!call || requestId === undefined) return;
      const app = meta?.tool_params?.app;
      if (typeof app === 'string') approvalApps.add(app.toLowerCase());
      approvals.set(requestId, { call, tool: meta?.tool_name });
      if (call.cursor) events.status('waiting', { detail: APPROVAL_KINDS[meta?.tool_name] ? 'approval' : undefined, call: call.cursor, app: call.target?.app, say: call.input.say });
    }),
    // The relay's answer to an approval request, on its way to the engine.
    answered: guarded((requestId, action) => {
      const entry = approvals.get(requestId);
      if (!entry) return;
      approvals.delete(requestId);
      const { call, tool } = entry;
      // A declined action never runs: nothing of this call may still show.
      if (action !== 'accept') {
        call.declined = true; call.dropped = true; finishCursor(call, 'declined'); cursorById.delete(call.id); forget(call);
        if (staged()) void protect(call.target, call.protectionEpoch).catch(() => {}); else hideClient();
        return;
      }
      if (call.cursor) events.status('thinking', { call: call.cursor });
      if (call.beats) call.beats.push({ tool, at: now() }); else beat(call, tool);
    }),
    // The guard reports each attempt's actual binding choice under a per-call private mark.
    // Those choices arrive with the result. Re-anchor unsent frames and measure drift against them.
    bindings: guarded((id, bindings) => {
      const call = calls.get(id);
      if (!call || call.done || !Array.isArray(bindings)) return;
      call.bindings = bindings;
      for (const entry of call.entries ?? []) {
        const reads = bindings.filter(b => b.bound === true && b.index <= entry.action && call.targets?.actions[b.index]?.element).length;
        entry.plannedAt = call.startedAt + entry.frame.delayMs - reads * GUARD_READ_MS;
      }
    }),
    result: guarded((id, failed) => {
      // The relay reports a result, then finishes the call: only the first report counts.
      const call = calls.get(id) ?? cursorById.get(id);
      if (!call || call.done) return;
      cursorById.delete(id);
      call.done = true; call.doneAt = now();
      call.failed = failed;
      finishCursor(call, failed ? 'failed' : 'done');
      traceBeats(call);
      for (const [requestId, entry] of approvals) if (entry.call === call) approvals.delete(requestId);
      if (failed) {
        call.dropped = true; calls.delete(id);
        // Frames sent ahead on the schedule may show actions the failure stopped.
        if (call.entries?.some(e => e.sent && e.due > now())) {
          if (staged()) void protect(call.target, call.protectionEpoch).catch(() => {}); else hideClient();
        }
        return;
      }
      dispatch(call);
    }),
    // Drop the planned remainder without hiding the person's resume control.
    pause: guarded(() => {
      for (const call of cursorCalls) { call.cursorHidden = true; cancelActs(call); }
      for (const call of calls.values()) call.dropped = true;
      calls.clear(); approvals.clear();
    }),
    // Before a local pointer tool (drag, hover): its cover checks and the person's view see no hand, so every
    // call still in flight is dropped too, including one whose geometry comes back during the tool.
    hide: guarded(() => {
      for (const call of cursorCalls) { call.cursorHidden = true; cancelActs(call); }
      for (const call of calls.values()) call.dropped = true;
      calls.clear(); approvals.clear();
      hideClient();
    }),
    close: guarded(() => {
      detachHints?.(); hint = undefined; hintGeneration++;
      for (const call of cursorCalls) { call.cursorHidden = true; cancelActs(call); }
      cursorCalls.clear();
      cursorById.clear();
      closed = true; calls.clear(); approvals.clear();
      if (ownsEvents) events.close();
      if (resolved) try { resolved.close(); } catch {}
    }),
  };
}
