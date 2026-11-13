const nonce = 'a'.repeat(64), target = { nonce, seq: 1, pid: 2147483647, windowId: 4294967295 };
const act = (kind = 'click', extra = {}) => ({ hand: 'act', ...target, kind, at: [100, 100], path: [[100, 100]], delayMs: 0, beats: 1, ...extra });
const aim = extra => ({ hand: 'aim', ...target, kind: 'click', at: [100, 100], ...extra });
const status = (state, extra = {}) => ({ hand: 'status', ...target, state, ...extra });
const clock = dumpClock => ({ dumpClock });
export const ringCases = [];
function add(name, frames, flags = []) { ringCases.push({ name, frames, flags: [...flags.some(flag => flag.startsWith('--cursor-style=')) ? [] : ['--cursor-style=ring'], '--seed=7', ...flags] }); }
for (const kind of ['click', 'double', 'right', 'type', 'key', 'scroll', 'drag']) {
  add(kind, [act(), clock(1), act(kind, { seq: 2, beats: 3, rect: [60, 90, 200, 24],
    ...['key', 'type'].includes(kind) ? { caretX: 82 } : {},
    ...kind === 'drag' ? { path: [[100, 100], [200, 150], [300, 100]] } : {} })]);
}
for (const state of ['thinking', 'waiting', 'error', 'done', 'handback']) add(state, [act(), clock(1), status(state, { seq: 2, ...state === 'done' ? { ok: true } : {} })]);
add('label-unicode', [aim({ label: 'Café 漢字 e\u0301', rect: [60,90,200,24] })]);
add('label-41-graphemes', [aim({ label: 'x'.repeat(41), rect: [60,90,200,24] })]);
add('label-over-80-scalars', [aim({ label: ('e' + '\u0301'.repeat(3)).repeat(30), rect: [60,90,200,24] })]);
add('menu', [{ hand: 'menu', nonce, enabled: true, capture: 'hidden', version: '1.6.0',
  permissions: {grants: [], blocked: []}, usage: {saved: 1, native: .5} }]);
add('wrap-label', [aim({ rect: [60, 90, 100, 24], label: 'Send', holdMs: 300 }), clock(.3), act('click', { seq: 2, label: 'Next' })]);
add('mid-glide', [act(), clock(1), aim({ seq: 2, at: [400, 300] }), clock(1.1), act('click', { seq: 3, at: [400, 300], path: [[400, 300]] })]);
add('glide-path', [act('click', { at: [500, 500], path: [[-30, -40], [200, 70], [500, 500]], label: 'Target' })]);
add('queue-cancel', [act('type', { delayMs: 1000 }), aim({ seq: 2, at: [300, 200] }), status('thinking', { seq: 3 }), clock(.5), status('error', { seq: 4, at: [100, 100] }), clock(2)]);
add('queue-release', [act('double', { delayMs: 250 }), aim({ seq: 2, holdMs: 600 }), clock(.25), clock(2), { hand: 'hide', nonce }]);
add('point-free-window', [status('thinking'), act('click', { seq: 2 }), status('waiting', { seq: 3, windowId: 42 }), clock(5)]);
add('gone', [act()], ['--gone=4294967295']);
add('clipped', [act('click', { at: [-10, -10], path: [[-30, -30], [-10, -10]] })], ['--clip=-50,-50,100,100']);
add('secure', [act('type', { label: 'Secret', beats: 5, caretX: 123 }), clock(1), act('key', { seq: 2, label: 'Hidden' })], ['--secure-input']);
add('reduced', [act(), clock(1), aim({ seq: 2, at: [300, 200], rect: [200, 190, 150, 30], holdMs: 600 }), clock(1.2), act('drag', { seq: 3, at: [300, 200], path: [[400, 300]] }), clock(2), status('waiting', { seq: 4 })], ['--reduce-motion']);
add('plain-seam', [act(), clock(1), status('thinking', { seq: 2 }), clock(2), status('waiting', { seq: 3 }), clock(3), status('handback', { seq: 4 })], ['--cursor-style=seam']);
add('waiting-exit', [act(), clock(1), status('waiting', { seq: 2 }), clock(2), act('click', { seq: 3 })]);
add('thinking-exit', [act(), clock(1), status('thinking', { seq: 2 }), clock(2), act('right', { seq: 3 })]);
add('error-exit', [act(), clock(1), status('error', { seq: 2 }), clock(2), act('double', { seq: 3 })]);
for (let seq = 1; seq <= 6; seq++) add('entrance-' + seq, [act('click', { seq })]);

export const invalidFrames = {
  json: ['{'], 'card': [{ id: 'payment', nonce, choices: ['once'], data: {} }],
  nonce: [act('click', { nonce: 'A'.repeat(64) })], binding: [act(), { hand: 'hide', nonce: 'b'.repeat(64) }],
  replay: [act(), act()], unknown: [act('click', { text: 'private' })],
  kind: [act('hover')], pid: [act('click', { pid: true })], window: [act('click', { windowId: 4294967296 })],
  point: [act('click', { at: [100001, 0] })], path: [act('drag', { path: [] })],
  delay: [act('click', { delayMs: 10001 })], beats: [act('type', { beats: 0 })],
  rect: [aim({ rect: [0, 0, 0, 10] })], hold: [aim({ holdMs: 601 })],
  caret: [act('click', { caretX: 3 })], ok: [status('error', { ok: false })],
  hide: [{ hand: 'hide', nonce, seq: 2 }], large: [act('type', { label: 'a'.repeat(8192) })],
};
