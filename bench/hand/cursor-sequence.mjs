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
    act: ({ kind, pid, windowId, at, path, delayMs = 0, beats = 1, rect, caretX }) => line({ hand: 'act', nonce, seq: seq++, kind, pid, windowId,
      at: pt(at), path: (path ?? [at]).map(pt), delayMs, beats, ...(rect ? { rect: rect.map(round) } : {}),
      ...(caretX !== undefined && ['type', 'key'].includes(kind) ? { caretX: round(caretX) } : {}) }),
    aim: ({ kind, pid, windowId, at, rect, holdMs }) => line({ hand: 'aim', nonce, seq: seq++, kind, pid, windowId, at: pt(at),
      ...(rect ? { rect: rect.map(round) } : {}), ...(holdMs !== undefined ? { holdMs } : {}) }),
    status: ({ state, pid, windowId, at, ok }) => line({ hand: 'status', nonce, seq: seq++, state, pid, windowId,
      ...(at ? { at: pt(at) } : {}), ...(state === 'done' && typeof ok === 'boolean' ? { ok } : {}) }),
    character: character => line(characterWire(character, { nonce, seq: seq++ })),
    hide: () => line({ hand: 'hide', nonce }),
  };
}

/** The sequence inside rect ({ x, y, width, height }, global top-left points): count actions, one every spacingMs. Each is
 *  an aim and, 250 ms later, its act; every sixth act is followed by a thinking status, and the last by done. Returns
 *  [{ atMs, type: 'aim' | 'act' | 'status', args }] sorted by time, and its length in ms. */
export function autoSequence({ pid, windowId, rect, count = 30, spacingMs = 1300 }) {
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(windowId) || windowId < 1) throw new Error('autoSequence needs a pid and a window id');
  if (!rect || !(rect.width >= 120) || !(rect.height >= 120)) throw new Error('autoSequence needs a rect of at least 120 by 120 pt');
  if (!Number.isInteger(count) || count < 1 || count > 200 || !(spacingMs >= 400)) throw new Error('count 1 to 200 and spacingMs of at least 400');
  const spot = i => [rect.x + rect.width * (0.2 + 0.6 * ((i * 37) % 11) / 10), rect.y + rect.height * (0.2 + 0.6 * ((i * 53) % 7) / 6)];
  const line = [rect.x + 12, rect.y + rect.height * 0.3, rect.width - 24, 18];
  const steps = [];
  for (let i = 0; i < count; i++) {
    const kind = KINDS[i % KINDS.length], at = spot(i), t = i * spacingMs;
    const base = { pid, windowId, kind, at };
    const target = ['type', 'key', 'scroll', 'drag'].includes(kind) ? { rect: kind === 'scroll' ? [rect.x, rect.y, rect.width, rect.height] : line } : {};
    steps.push({ atMs: t, type: 'aim', args: { ...base, ...target } });
    const act = { ...base, ...target, beats: kind === 'type' ? 3 : 1,
      ...(kind === 'drag' ? { path: [at, spot(i + 3)] } : {}), ...(['type', 'key'].includes(kind) ? { caretX: at[0] } : {}) };
    steps.push({ atMs: t + 250, type: 'act', args: act });
    if (i === count - 1) steps.push({ atMs: t + 900, type: 'status', args: { state: 'done', pid, windowId, at, ok: true } });
    else if (i % 6 === 5) steps.push({ atMs: t + 900, type: 'status', args: { state: 'thinking', pid, windowId, at } });
  }
  return { steps, lengthMs: (count - 1) * spacingMs + 900 };
}

/** Plays steps through wire to write(line) on a clock: sleep(ms) waits, now() reads ms. Returns the lines written. */
export async function playSequence({ steps }, { wire, write, sleep, now = Date.now, stopped = () => false }) {
  const start = now(), lines = [];
  for (const step of steps) {
    if (stopped()) break;
    const wait = step.atMs - (now() - start);
    if (wait > 0) await sleep(wait);
    const text = wire[step.type](step.args);
    write(text);
    lines.push(text);
  }
  return lines;
}
