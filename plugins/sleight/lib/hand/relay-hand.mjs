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
import { planHandFrames, handTargets, WRITE_MS, GUARD_READ_MS } from './planner.mjs';
import { cursorRecord, cursorReason, createCursorEvents } from './events.mjs';

// The kinds an approval's tool_name stands for. Unknown names beat the next action of any kind.
const APPROVAL_KINDS = { click: ['click', 'double', 'right'], press_key: ['key'], set_value: ['type'], type_text: ['type'], drag: ['drag'], scroll: ['scroll'] };
const STALE_MS = 60000;

export function createRelayHand({ client, loadClient = () => import('./client.mjs'), clientOptions = {}, locate,
  trace = () => {}, now = () => performance.now(), defer = fn => setImmediate(fn), locateTimeoutMs = 2000, lateMs = 1500,
  env = process.env, setting = handSettingReader(env), events, record = cursorRecord, schedule = setTimeout, cancel = clearTimeout } = {}) {
  setting = createHandSettingReader({ setting });
  if (env.SLEIGHT_HAND === '0' || !(setting().enabled || setting().stream) || typeof locate !== 'function') return undefined;
  const ownsEvents = !events;
  events ??= createCursorEvents({ setting, env });
  try { events.connectHost?.(client); } catch {}
  let closed = false, locating = false, resolved = client ?? undefined, loading, pendingHide = false;
  const load = () => loading ??= (client ? Promise.resolve(client) : Promise.resolve().then(loadClient).then(m => m.createHandClient({ ...clientOptions, cursorStyle: setting().style })))
    .then(c => (resolved = c && typeof c.send === 'function' ? c : null), () => (resolved = null))
    .then(() => { try { events.connectHost?.(resolved); } catch {} if (pendingHide) hideClient(); });
  // Hides now, or as soon as a client still loading arrives.
  function hideClient() {
    if (resolved === undefined) { pendingHide = true; return; }
    pendingHide = false;
    try { resolved?.hide(); } catch {}
  }
  const live = () => !closed && (resolved && resolved.enabled !== false || events.enabled);
  const calls = new Map(); // call id -> call, admission order
  const approvals = new Map(); // engine request id -> { call, tool }
  const approvalApps = new Set(); // lowercased app names and bundle IDs whose actions came with approvals
  const names = target => [target?.app, target?.appId].filter(n => typeof n === 'string').map(n => n.toLowerCase());
  const held = call => names(call.target).some(n => approvalApps.has(n));
  const note = (reason, call, extra) => trace('hand-skipped', { id: call.id, ...extra, reason });
  const guarded = fn => (...args) => { try { fn(...args); } catch { /* The hand never reaches the relay. */ } };
  const cursorCalls = new Set();
  const cursorById = new Map();
  const publish = (call, entry, phase, reason) => {
    if (!call.cursor) return;
    try { events.action({ ...entry.record, call: call.cursor, index: entry.index, source: 'native', phase, ...(reason ? { reason: cursorReason(reason) } : {}) }); } catch {}
  };
  const cancelActs = call => { for (const timer of call.timers ?? []) cancel(timer); call.timers = []; };
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
    let previous;
    call.cursorEntries = actions.map((action, index) => {
      const n = planned?.actions.indexOf(index) ?? -1, frame = n >= 0 ? planned.frames[n] : undefined;
      const identity = call.targets?.identities[action.target?.number] ?? (action.target?.focus ? geometry?.focused : action.target?.previous ? previous : undefined);
      if (!['type', 'key'].includes(action.kind)) previous = identity;
      const projected = record({ frame, action: { ...identity, kind: action.kind, rect: geometry?.elements?.[action.target?.number],
        secure: identity?.role === 'AXSecureTextField' || (['type', 'key'].includes(action.kind) && !identity?.role) }, geometry,
        target: call.target, labels: events.labels });
      const entry = { index, record: projected };
      if (frame && projected.label && setting().style && setting().style !== 'glove') {
        const hostEntry = call.entries?.find(e => e.action === index);
        if (hostEntry) hostEntry.frame = { ...hostEntry.frame, label: projected.label };
      }
      const skip = reason ?? planned?.skipped.find(s => s.action === index)?.reason;
      if (!frame || skip) { entry.skipped = true; entry.ended = true; publish(call, entry, 'skipped', skip ?? 'unplanned'); }
      else {
        publish(call, entry, 'aim');
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
    let previous;
    call.cursorPreviewEntries = targets.actions.map((action, index) => {
      const identity = targets.identities[action.target?.number] ?? (action.target?.previous ? previous : undefined);
      if (['click', 'double', 'right'].includes(action.kind) || action.method === 'setValue') previous = identity;
      const projected = record({ action: { ...identity, kind: action.kind, count: action.beats,
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

  function send(entry, delayMs) {
    entry.sent = true; entry.due = now() + delayMs;
    try { if (live()) resolved?.send({ ...entry.frame, delayMs: Math.max(0, Math.round(delayMs)) }); } catch {}
  }

  function dispatch(call) {
    if (!call.entries || call.dropped) return;
    let k = 0;
    for (const entry of call.entries) {
      if (entry.sent) continue;
      if (call.done) {
        if (now() - call.doneAt > lateMs) { entry.sent = true; note('late', call, { action: entry.action }); continue; }
        send(entry, k++ * WRITE_MS);
      } else if (entry.action < call.beatIndex) send(entry, 0);
      else if (held(call)) break;
      else send(entry, entry.plannedAt - now());
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
    // The read and screenshot as the relay knows them now, before any later result changes them.
    const lines = typeof call.input.lines === 'function' ? call.input.lines() : call.input.lines;
    const screenshotSize = typeof call.input.screenshotSize === 'function' ? call.input.screenshotSize() : call.input.screenshotSize;
    const { code, target } = call.input;
    if (resolved === undefined && setting().enabled) await load();
    const targets = call.targets = handTargets({ code, lines, target });
    if (call.input.unplanned) { cursorPlan(call, undefined, undefined, 'unplanned'); forget(call); return; }
    if (!live() || call.dropped) { cursorPlan(call, undefined, undefined, 'no-geometry'); forget(call); return; }
    if (targets.skip) { cursorPlan(call, undefined, undefined, targets.skip); forget(call); note(targets.skip, call); return; }
    if (!targets.actions.length) { cursorPlan(call, undefined, undefined, 'unplanned'); forget(call); return; }
    // One helper at a time: a call admitted while the last one's frames are still looked up gets no hand.
    if (locating) { cursorPlan(call, undefined, undefined, 'unplanned'); forget(call); note('busy', call); return; }
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
    if (!geometry?.ok) { cursorPlan(call, undefined, undefined, 'no-geometry'); forget(call); note('no-geometry', call); return; }
    const { window, elements, focused, windows, displays, state } = geometry;
    const planned = planHandFrames({ code, lines, screenshotSize, target, window, elements, focused, windows, displays, state,
      ignorePids: [resolved?.pid].filter(Number.isSafeInteger), targets, bindings: call.bindings });
    for (const skip of planned.skipped) note(skip.reason, call, skip.action === undefined ? {} : { action: skip.action, method: skip.method });
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
    // input: { code, target, lines, screenshotSize }, lines and screenshotSize optionally as functions read on the next tick.
    admit: guarded((id, input) => {
      if (closed || id === undefined || typeof input?.code !== 'string') return;
      const call = { id, input, target: input.target, startedAt: now(), beatIndex: 0, beats: [], beatTimes: [] };
      try {
        if (events.enabled) {
          call.cursor = events.call(); call.timers = []; cursorCalls.add(call); cursorById.set(id, call);
          previewCursor(call);
        }
      } catch {}
      // A resent call replaces its first try, and a call whose result never came stops counting after a minute.
      for (const [other, old] of calls) if (other === id || call.startedAt - old.startedAt > STALE_MS) { old.dropped = true; finishCursor(old, 'failed'); if (cursorById.get(other) === old) cursorById.delete(other); calls.delete(other); }
      calls.set(id, call);
      defer(() => plan(call).catch(() => forget(call)));
    }),
    // An engine approval request seen while a call runs, with its _meta.
    approval: guarded((requestId, meta) => {
      const call = [...calls.values()].reverse().find(c => !c.done);
      if (!call || requestId === undefined) return;
      const app = meta?.tool_params?.app;
      if (typeof app === 'string') approvalApps.add(app.toLowerCase());
      approvals.set(requestId, { call, tool: meta?.tool_name });
      if (call.cursor) events.status('waiting', { call: call.cursor, app: call.target?.app });
    }),
    // The relay's answer to an approval request, on its way to the engine.
    answered: guarded((requestId, action) => {
      const entry = approvals.get(requestId);
      if (!entry) return;
      approvals.delete(requestId);
      const { call, tool } = entry;
      // A declined action never runs: nothing of this call may still show.
      if (action !== 'accept') { call.declined = true; call.dropped = true; finishCursor(call, 'declined'); cursorById.delete(call.id); forget(call); hideClient(); return; }
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
        if (call.entries?.some(e => e.sent && e.due > now())) hideClient();
        return;
      }
      dispatch(call);
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
      for (const call of cursorCalls) { call.cursorHidden = true; cancelActs(call); }
      cursorCalls.clear();
      cursorById.clear();
      closed = true; calls.clear(); approvals.clear();
      if (ownsEvents) events.close();
      if (resolved) try { resolved.close(); } catch {}
    }),
  };
}
