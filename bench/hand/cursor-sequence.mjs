// The agent cursor's scripted sequence for VC7's cost check and recording: the frames the relay sends for a task (aim, then
// the act, and a thinking status between steps), written straight to a hand host's stdin so every run draws the same thing.
// Frames follow consent-host.swift HAND FRAME exactly (unknown keys make the host exit 65), and one nonce and one increasing
// seq bind them, as the relay's client does.
import { randomBytes } from 'node:crypto';
import { characterWire } from './synthetic-character.mjs';

export const KINDS = Object.freeze(['click', 'type', 'scroll', 'double', 'drag', 'key', 'right']);
const round = n => Math.round(n);
const pt = ([x, y]) => [round(x), round(y)];

/** Frame builders bound to one nonce with one shared seq, as lib/hand/client.mjs numbers them. */
export function cursorWire(nonce = randomBytes(32).toString('hex')) {
  let seq = 0;
  const line = value => JSON.stringify(value) + '\n';
  return {
    nonce,
    act: ({ kind, pid, windowId, at, path, delayMs = 0, beats = 1, rect, caretX, windowRect }) => line({ hand: 'act', nonce, seq: seq++, kind, pid, windowId,
      at: pt(at), path: (path ?? [at]).map(pt), delayMs, beats, ...(rect ? { rect: rect.map(round) } : {}), ...(windowRect ? { windowRect: [...windowRect] } : {}),
      ...(caretX !== undefined && ['type', 'key'].includes(kind) ? { caretX: round(caretX) } : {}) }),
    aim: ({ kind, pid, windowId, at, rect, holdMs, windowRect }) => line({ hand: 'aim', nonce, seq: seq++, kind, pid, windowId, at: pt(at),
      ...(rect ? { rect: rect.map(round) } : {}), ...(windowRect ? { windowRect: [...windowRect] } : {}), ...(holdMs !== undefined ? { holdMs } : {}) }),
    status: ({ state, pid, windowId, at, ok, windowRect }) => line({ hand: 'status', nonce, seq: seq++, state, pid, windowId,
      ...(at ? { at: pt(at) } : {}), ...(windowRect ? { windowRect: [...windowRect] } : {}), ...(state === 'done' && typeof ok === 'boolean' ? { ok } : {}) }),
    character: character => line(characterWire(character, { nonce, seq: seq++ })),
    hide: () => line({ hand: 'hide', nonce }),
  };
}

/** The sequence inside rect ({ x, y, width, height }, global top-left points): count actions, one every spacingMs. Each is
 *  an aim, act and call-completion done; every sixth call has a thinking status. A final done without ok ends the turn.
 *  Broad scroll rectangles belong to stressSequence, not the ordinary element-target sequence. Returns
 *  [{ atMs, type: 'aim' | 'act' | 'status', args }] sorted by time, and its length in ms. */
export function autoSequence({ pid, windowId, rect, count = 30, spacingMs = 1300, fullWindowScroll = false }) {
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(windowId) || windowId < 1) throw new Error('autoSequence needs a pid and a window id');
  if (!rect || !(rect.width >= 120) || !(rect.height >= 120)) throw new Error('autoSequence needs a rect of at least 120 by 120 pt');
  if (!Number.isInteger(count) || count < 1 || count > 200 || !(spacingMs >= 400)) throw new Error('count 1 to 200 and spacingMs of at least 400');
  const spot = i => [rect.x + rect.width * (0.2 + 0.6 * ((i * 37) % 11) / 10), rect.y + rect.height * (0.2 + 0.6 * ((i * 53) % 7) / 6)];
  const line = [rect.x + 12, rect.y + rect.height * 0.3, rect.width - 24, 18];
  const steps = [];
  for (let i = 0; i < count; i++) {
    const kind = KINDS[i % KINDS.length], at = spot(i), t = i * spacingMs;
    const base = { pid, windowId, kind, at, windowRect: [rect.x, rect.y, rect.width, rect.height] };
    const scroll = fullWindowScroll ? [rect.x, rect.y, rect.width, rect.height] : [at[0] - 30, at[1] - 15, 60, 30];
    const target = ['type', 'key', 'scroll', 'drag'].includes(kind) ? { rect: kind === 'scroll' ? scroll : line } : {};
    steps.push({ atMs: t, type: 'aim', args: { ...base, ...target } });
    const act = { ...base, ...target, beats: kind === 'type' ? 3 : 1,
      ...(kind === 'drag' ? { path: [at, spot(i + 3)] } : {}), ...(['type', 'key'].includes(kind) ? { caretX: at[0] } : {}) };
    steps.push({ atMs: t + Math.min(250, spacingMs * 0.25), type: 'act', args: act });
    steps.push({ atMs: t + Math.min(700, spacingMs * 0.65), type: 'status', args: { state: 'done', pid, windowId, at, windowRect: base.windowRect, ok: true } });
    if (i === count - 1) steps.push({ atMs: t + Math.min(1000, spacingMs * 0.9), type: 'status', args: { state: 'done', pid, windowId, at, windowRect: base.windowRect } });
    else if (i % 6 === 5) steps.push({ atMs: t + Math.min(900, spacingMs * 0.8), type: 'status', args: { state: 'thinking', pid, windowId, at, windowRect: base.windowRect } });
  }
  for (const step of steps) {
    step.provenance = { turn: 1, action: Math.min(count - 1, Math.floor(step.atMs / spacingMs)), attempt: 0,
      witness: step.type === 'status' && step.args.state === 'done' ? step.args.ok ? 'scheduled-completion' : 'turn-end' : step.type };
  }
  return { steps, lengthMs: steps.at(-1).atMs, scenario: fullWindowScroll ? 'full-window-scroll-stress' : 'small-target-turn-lifecycle',
    scrollRectPt: fullWindowScroll ? [rect.width, rect.height] : [60, 30] };
}

export function stressSequence(options) {
  return { ...autoSequence({ ...options, fullWindowScroll: true }), scenario: 'full-window-scroll-stress',
    expected: { hides: ['no-seat'], retainedUntil: 'turn-end', parked: 'visible where geometry permits' } };
}

/** Plays steps through wire to write(line) on a clock: sleep(ms) waits, now() reads ms. Returns the lines written. */
export async function playSequence({ steps }, { wire, write, sleep, now = Date.now, stopped = () => false, record = () => {} }) {
  const start = now(), lines = [];
  for (const step of steps) {
    if (stopped()) break;
    const wait = step.atMs - (now() - start);
    if (wait > 0) await sleep(wait);
    const text = wire[step.type](step.args);
    const dispatchedMs = now() - start;
    write(text);
    record({ order: lines.length, scheduledMs: step.atMs, dispatchedMs, frame: JSON.parse(text),
      provenance: step.provenance ?? null, admissionAcknowledged: false });
    lines.push(text);
  }
  return lines;
}
