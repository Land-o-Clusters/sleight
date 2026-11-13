// Synthetic geometry only. These frames are never sent to a drawing mode.
const nonce = 'a'.repeat(64);
const identity = { nonce, pid: 2147483647, windowId: 4294967295 };
const act = (seq, kind = 'click', extra = {}) => ({ hand: 'act', ...identity, seq, kind,
  at: [100, 100], path: [[100, 100]], delayMs: 0, beats: 1, ...extra });
const aim = (seq, extra = {}) => ({ hand: 'aim', ...identity, seq, kind: 'click', at: [100, 100], holdMs: 0, ...extra });
const status = (seq, state, extra = {}) => ({ hand: 'status', ...identity, seq, state, ...extra });
const clock = dumpClock => ({ dumpClock });
const spaced = frames => frames.flatMap((frame, i) => [clock(i * 2), frame]);
const flags = ['--cursor-style=ring', '--seed=7'];

export const SOURCE = 'plugins/sleight/lib/direct-browser/native/consent-host.swift';
export const cases = [
  { id: 'actions', flags, frames: spaced(['click', 'double', 'right', 'type', 'key', 'scroll', 'drag'].map((kind, i) =>
    act(i + 1, kind, { beats: 3, ...(kind === 'drag' ? { path: [[100, 100], [220, 120], [300, 200]] } : {}) }))) },
  { id: 'statuses', flags, frames: spaced([act(1), ...['thinking', 'waiting', 'error', 'done', 'handback'].map((state, i) => status(i + 2, state))]) },
  { id: 'aim-wrap-label', flags, frames: spaced([act(1), aim(2, { at: [300, 100], rect: [240, 80, 120, 40], label: 'Send' }),
    act(3, 'click', { at: [300, 100], rect: [240, 80, 120, 40], label: 'Send' }),
    act(4, 'type', { rect: [60, 90, 200, 24], caretX: 90, beats: 4, label: 'Save' }), status(5, 'done', { ok: true })]) },
  { id: 'overlap-and-hide', flags, frames: [act(1), clock(1), aim(2, { at: [400, 300] }), clock(1.1),
    act(3, 'click', { at: [400, 300], path: [[400, 300]] }), clock(1.12), status(4, 'thinking'),
    clock(1.2), { hand: 'hide', nonce }, status(5, 'waiting')] },
  { id: 'reduced-motion', flags: [...flags, '--reduce-motion'], frames: spaced([act(1), aim(2, { at: [400, 200] }),
    act(3, 'drag', { path: [[100, 100], [400, 200]] }), status(4, 'waiting'), status(5, 'done', { ok: true })]) },
  { id: 'secure-input', flags: [...flags, '--secure-input'], frames: spaced([act(1),
    act(2, 'type', { rect: [60, 90, 200, 24], caretX: 90, beats: 4, label: 'Private' }), act(3, 'key', { beats: 4, label: 'Private' })]) },
  { id: 'clip-and-gone', flags: [...flags, '--clip=0,0,400,200', '--gone=1'], frames: spaced([
    act(1, 'click', { at: [390, 12], label: 'Send' }), act(2, 'click', { windowId: 1 }),
    act(3, 'click', { at: [12, 190], label: 'Save' })]) },
  { id: 'plain-seam', flags: ['--cursor-style=seam', '--seed=7'], frames: spaced([act(1),
    act(2, 'click', { at: [300, 100], path: [[300, 100]] }), status(3, 'thinking'), status(4, 'waiting'), status(5, 'done', { ok: true })]) },
  { id: 'invalid-boolean-coordinate', flags, frames: [act(1, 'click', { at: [true, 0] })], exitCode: 65 },
  { id: 'invalid-nonce-change', flags, frames: [act(1), status(2, 'done', { nonce: 'b'.repeat(64) })], exitCode: 65 },
  { id: 'invalid-extra-key', flags, frames: [aim(1, { surprise: true })], exitCode: 65 },
  { id: 'invalid-sequence', flags, frames: [act(1), act(1)], exitCode: 65 },
];
