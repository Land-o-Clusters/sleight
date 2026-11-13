import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { sourceURL, replaceSite } from './fixtures/browser-geometry.mjs';
const spriteStates = ['idle', 'move', 'aim', 'click', 'double-click', 'right-click', 'type', 'key', 'scroll-up', 'scroll-down', 'drag-grab', 'drag-carry',
  'drag-drop', 'waiting-approval', 'error', 'success', 'thinking', 'handoff', 'working'];

const variant = process.env.INT23D_BACKLOG_VARIANT;
const api = await import(variant ? sourceURL('hand/client.mjs', source => {
  if (variant === 'unbounded-pipe') source = replaceSite(source,
    'child.stdin.writableLength + Buffer.byteLength(line) > 4 * 1024 * 1024', 'false');
  if (variant === 'replacement-draws-without-inventory') source = replaceSite(source,
    "protectionLost && JSON.parse(line).hand === 'character'", "false && JSON.parse(line).hand === 'character'");
  if (variant === 'backpressured-pause-ack') source = replaceSite(source,
    "return write(JSON.stringify({ hand: 'pause-ack', nonce, phase, token: request.token, paused: request.value }) + '\\n', { urgent: true });",
    "return write(JSON.stringify({ hand: 'pause-ack', nonce, phase, token: request.token, paused: request.value }) + '\\n');");
  if (variant === 'stale-chip-counted') source = replaceSite(source, "host !== 'dead' && !geometry.stale(event)) chips.receive", "host !== 'dead') chips.receive");
  if (variant === 'call-done-releases-inventory') source = replaceSite(source,
    'protectionLost && turnEnd && !stale', "protectionLost && frame?.hand === 'status' && !stale");
  return source;
}) : new URL('../plugins/sleight/lib/hand/client.mjs', import.meta.url).href);
const settle = async () => { for (let n = 0; n < 10; n++) await new Promise(resolve => setImmediate(resolve)); };
const target = { kind: 'click', pid: 42, windowId: 7, at: [650, 700], path: [[650, 700]], windowRect: [200, 500, 900, 350] };
function sprite() {
  const resolved = spriteStates.map(state => ({ state, sheet: 'sheet.png', row: 0, start: 0, frames: 1, ms: [100], loop: false,
    flip: false, hotspot: { x: 32, y: 32 }, repeat: 1 }));
  return { character: { manifest: { id: 'pet', sheet: 'sheet.png', frame: { w: 64, h: 64 }, scale: 0.5, states: {} },
    folder: '/fixture/pet', sheets: { sheet: { width: 512, height: 192 } }, resolved }, resolve: () => resolved };
}
function child() {
  const c = new EventEmitter(); c.pid = 4242; c.lines = []; c.ended = false;
  c.stdin = Object.assign(new EventEmitter(), { writableLength: 0, wedged: false, peak: 0,
    write(line) { c.lines.push(JSON.parse(line)); if (this.wedged) this.writableLength += Buffer.byteLength(line);
      this.peak = Math.max(this.peak, this.writableLength); return !this.wedged; }, end() { c.ended = true; } });
  c.stdout = new EventEmitter(); c.stdio = [c.stdin, c.stdout]; c.kill = () => {};
  return c;
}
test('wedged hand pipe stops at 4 MiB and its replacement hides characters until an empty turn inventory', async t => {
  const children = [], traces = [];
  const client = api.createHandClient({ setting: () => ({ enabled: true, style: 'sprite', character: 'pet' }),
    loadSprite: async () => sprite(), watch: () => undefined, built: () => true, permissions: null, usage: null,
    trace: (name, detail) => traces.push({ name, ...detail }),
    prepare: async () => ({ status: 'ready', spawn() { const next = child(); children.push(next); return next; } }) });
  t.after(() => client.close());
  client.send(target); await settle();
  assert.equal(children[0].lines.filter(row => row.hand === 'character').length, 1);
  const first = children[0]; first.stdin.wedged = true; first.stdin.writableLength = 65537;
  client.send(target);
  assert.equal(first.lines.at(-1).hand, 'act', 'target frames must still cross the 64 KiB art limit');
  first.stdin.writableLength = 4 * 1024 * 1024 - 1;
  client.send(target); await settle();
  assert.equal(first.ended, true, 'overflow must retire the wedged hand reader');
  assert.ok(first.stdin.peak <= 4 * 1024 * 1024, 'buffer must never exceed its hard limit');
  assert.equal(children.length, 2, 'a backlog fault gets one replacement');
  const replacement = children[1];
  assert.equal(replacement.lines.filter(row => row.hand === 'character').length, 0, 'replacement cannot draw without the prior inventory');
  client.send(target); client.send({ hand: 'status', state: 'done', ok: true, ...target }); await settle();
  assert.equal(replacement.lines.filter(row => row.hand === 'character').length, 0, 'call completion cannot clear the inventory gap');
  assert.ok(replacement.lines.some(row => row.hand === 'act'), 'new targets still reach the replacement');
  client.send({ hand: 'status', state: 'done', ...target }); await settle();
  assert.equal(replacement.lines.filter(row => row.hand === 'character').length, 1, 'true turn end supplies an empty inventory');
  assert.equal(traces.filter(row => row.name === 'hand-off' && row.reason === 'backlog').length, 1);
});


test('pause ready and applied acknowledgements cross the art backlog in order', async t => {
  const host = child(), client = api.createHandClient({ setting: () => ({ enabled: true, style: 'ring' }), watch: () => undefined,
    built: () => true, permissions: null, usage: null, prepare: async () => ({ status: 'ready', spawn: () => host }) });
  t.after(() => client.close()); client.send(target); await settle();
  const nonce = host.lines[0].nonce; host.stdin.writableLength = 65537;
  for (const phase of ['request', 'commit']) host.stdout.emit('data', JSON.stringify({ hand: 'pause', nonce,
    token: 'a'.repeat(32), paused: true, phase }) + '\n');
  assert.deepEqual(host.lines.filter(row => row.hand === 'pause-ack').map(row => row.phase), ['ready', 'applied']);
});


test('a stale action cannot increment the current sprite chip', async t => {
  const host = child(), client = api.createHandClient({ setting: () => ({ enabled: true, style: 'sprite', character: 'pet' }),
    loadSprite: async () => sprite(), watch: () => undefined, built: () => true, permissions: null, usage: null,
    prepare: async () => ({ status: 'ready', spawn: () => host }) });
  t.after(() => client.close()); client.send(target); await settle();
  client.cursor({ type: 'session', state: 'start', session: 'e'.repeat(32), ts: 1793016000000 });
  api.privateHandGeometry(client).beginTurn('a'.repeat(32));
  const action = { type: 'action', phase: 'done', call: 'b'.repeat(32), index: 0, seq: 1, kind: 'click', window: { pid: 42, id: 7 } };
  client.cursor({ ...action, turn: 'c'.repeat(32) });
  assert.equal(host.lines.filter(row => row.hand === 'edge' && row.op === 'put').length, 0, 'stale completion must not count');
  client.cursor({ ...action, turn: 'a'.repeat(32) });
  assert.equal(host.lines.filter(row => row.hand === 'edge' && row.op === 'put').length, 1, 'current completion still counts');
});

function mutationCounts(stdout) {
  return Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key =>
    [key, Number(new RegExp('#\\s+' + key + '\\s+(\\d+)').exec(stdout)?.[1])]));
}
test('pipe bound mutation fails in the same run', { skip: !!process.env.INT23D_BACKLOG_VARIANT, timeout: 900000 }, () => {
  const env = { ...process.env, INT23D_BACKLOG_VARIANT: 'unbounded-pipe' };
  delete env.NODE_TEST_CONTEXT;
  const name = 'wedged hand pipe stops at 4 MiB and its replacement hides characters until an empty turn inventory';
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', '--test-timeout=900000',
    '--test-name-pattern=^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', fileURLToPath(import.meta.url)], {
    encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024, timeout: 900000, killSignal: 'SIGKILL' });
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stdout, /overflow must retire the wedged hand reader/);
  const counts = mutationCounts(r.stdout);
  assert.equal(counts.tests, 1); assert.equal(counts.fail, 1); assert.equal(counts.pass, 0);
});
