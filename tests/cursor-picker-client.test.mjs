import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHandClient } from '../plugins/sleight/lib/hand/client.mjs';
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
function harness(t, apply = async () => ({ ok: true, style: 'ring' }), more = {}) {
  const lines = [], calls = [], catalogs = [], child = new EventEmitter();
  child.pid = 4242; child.stdout = new EventEmitter(); child.stdin = Object.assign(new EventEmitter(), { writableLength: 0,
    write: s => { lines.push(JSON.parse(s)); return true; }, end() { child.emit('exit', 0); } });
  child.stdio = [child.stdin, child.stdout];
  const picker = { catalog: async options => { catalogs.push(options); return { rows: [{ title: 'Ring (Split Seam+)', op: 'select', style: 'ring', selected: true }], thumbnails: [] }; },
    apply: async e => { calls.push(e); return apply(e); } };
  const client = createHandClient({ setting: () => ({ enabled: true, style: 'glove' }), permissions: null, usage: null, watch: () => undefined,
    built: () => true, prepare: async () => ({ status: 'ready', spawn: () => child }), cursorPicker: picker, ...more });
  t.after(() => client.close());
  client.send({ kind: 'click', pid: 1, windowId: 1, at: [1, 1] });
  const event = raw => child.stdout.emit('data', JSON.stringify({ hand: 'picker', nonce: lines[0].nonce, ...raw }) + '\n');
  return { lines, calls, catalogs, event, client, picker };
}

test('oversized catalogs drop skipped rows before refusing selectable characters', async t => {
  const h = harness(t); await settle(); const start = h.lines.length;
  const selected = { title: 'Mouse', op: 'import', key: 'b'.repeat(64) };
  const rows = [{ title: 'Plugin', children: [selected, ...Array.from({ length: 100 }, () =>
    ({ title: 'Broken (skipped)', op: 'skipped', reason: 'x'.repeat(1000) }))] },
    { title: 'Broken plugin', children: [{ title: 'Broken', op: 'skipped', reason: 'bad' }] }];
  h.picker.catalog = async () => ({ rows, thumbnails: [] });
  h.event({ op: 'refresh' }); await settle();
  const frame = h.lines.slice(start).find(f => f.op === 'catalog'); assert.ok(frame);
  assert.deepEqual(frame.rows, [{ title: 'Plugin', children: [selected] }]);
  assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= 64000);
  assert.equal(rows[0].children.length, 101); assert.equal(h.lines.some(f => f.op === 'notice'), false);
});
test('nonce-bound picker click applies once, switches the running host and refreshes the menu', async t => {
  const h = harness(t); await settle();
  h.event({ op: 'select', style: 'ring', nonce: 'f'.repeat(64) });
  h.event({ op: 'select', style: 'ring', extra: true }); await settle(); assert.equal(h.calls.length, 0);
  h.event({ op: 'select', style: 'ring' }); await settle();
  assert.deepEqual(h.calls, [{ op: 'select', style: 'ring' }]);
  assert.ok(h.lines.some(f => f.hand === 'picker' && f.op === 'style' && f.style === 'ring'));
  assert.ok(h.lines.some(f => f.hand === 'picker' && f.op === 'catalog'));
  h.client.cursor({ type: 'action', phase: 'aim', kind: 'click', point: [1, 1], window: { pid: 1, id: 1 } });
  assert.equal(h.lines.at(-1).hand, 'aim');
});
test('import refusal reaches a nonmodal host notice without a style change', async t => {
  const h = harness(t, async () => ({ ok: false, text: 'Character: "pet.json" spriteVersionNumber: needs version 2' })); await settle();
  h.event({ op: 'import', key: 'b'.repeat(64) }); await settle();
  assert.equal(h.lines.find(f => f.op === 'notice').text, 'Character: "pet.json" spriteVersionNumber: needs version 2');
  assert.equal(h.lines.filter(f => f.op === 'style').length, 0);
});
test('refresh is read-only, and wizard callout follows a successful import', async t => {
  const h = harness(t, async () => ({ ok: true, style: 'ring', text: 'This pet needs 11 more animations:\nClick: uses its wave animation' })); await settle();
  h.event({ op: 'refresh' }); await settle(); assert.equal(h.calls.length, 0);
  assert.equal(h.catalogs.at(-1).open, true);
  h.event({ op: 'import', key: 'b'.repeat(64) }); await settle();
  assert.match(h.lines.find(f => f.op === 'notice').text, /11 more animations/);
  assert.equal(h.catalogs.at(-1).open, false);
});
test('sprite selection sends the style before its validated character, on the shared sequence', async t => {
  const sprite = { manifest: { id: 'cat', frame: { w: 64, h: 64 }, sheet: 'sheet.png', states: {}, scale: 1 }, folder: '/fixture/cat',
    sheets: { sheet: { width: 512, height: 64 } }, resolved: [{ state: 'idle', sheet: 'sheet.png', row: 0, start: 0, frames: 1, ms: [100], loop: false, hotspot: { x: 32, y: 32 } }] };
  const h = harness(t, async () => ({ ok: true, style: 'sprite', character: 'cat' }), { loadSprite: async () => ({ character: sprite, resolve: () => [] }) });
  await settle(); h.event({ op: 'select', style: 'sprite', character: 'cat' }); await settle();
  const style = h.lines.findIndex(f => f.op === 'style'), character = h.lines.findIndex(f => f.hand === 'character');
  assert.ok(style >= 0 && character > style); assert.equal(h.lines[character].id, 'cat'); assert.equal(h.lines[character].seq, 2);
});
test('notice text removes format characters and bounds Unicode bytes to the host limit', async t => {
  const h = harness(t, async () => ({ ok: false, text: '\u202e' + '猫'.repeat(10000) })); await settle();
  h.event({ op: 'import', key: 'b'.repeat(64) }); await settle();
  const text = h.lines.find(f => f.op === 'notice').text;
  assert.ok(Buffer.byteLength(text) <= 12000); assert.ok(!text.includes('\u202e'));
});
test('a physical selection in the refresh stdout chunk is queued and applied', async t => {
  const h = harness(t); await settle();
  h.event({ op: 'refresh' }); h.event({ op: 'select', style: 'ring' }); await settle();
  assert.deepEqual(h.calls, [{ op: 'select', style: 'ring' }]);
});
test('native refusal of a picker-originated sprite reaches the notice, while startup refusals only trace', async t => {
  const sprite = { manifest: { id: 'cat', frame: { w: 64, h: 64 }, sheet: 'sheet.png', states: {}, scale: 1 }, folder: '/fixture/cat',
    sheets: { sheet: { width: 512, height: 64 } }, resolved: [{ state: 'idle', sheet: 'sheet.png', row: 0, start: 0, frames: 1, ms: [100], loop: false, hotspot: { x: 32, y: 32 } }] };
  const h = harness(t, async () => ({ ok: true, style: 'sprite', character: 'cat' }), { loadSprite: async () => ({ character: sprite, resolve: () => [] }) });
  await settle();
  const refusal = { hand: 'character', id: 'cat', loaded: false, reason: 'pixels', warnings: [] };
  h.event(refusal); await settle(); assert.equal(h.lines.some(f => f.op === 'notice'), false);
  h.event({ op: 'select', style: 'sprite', character: 'cat' }); await settle();
  h.event(refusal); await settle(); assert.match(h.lines.find(f => f.op === 'notice').text, /cat.*pixels.*ring/);
  assert.deepEqual(h.calls.at(-1), { op: 'select', style: 'ring' });
  assert.deepEqual(h.lines.filter(f => f.op === 'style').at(-1).style, 'ring');
});
test('a sprite loader failure persists the ring fallback through the picker writer', async t => {
  const h = harness(t, async e => ({ ok: true, ...e }), { loadSprite: async () => { throw Error('missing sheet'); } });
  await settle(); h.event({ op: 'select', style: 'sprite', character: 'cat' }); await settle();
  assert.deepEqual(h.calls, [{ op: 'select', style: 'sprite', character: 'cat' }, { op: 'select', style: 'ring' }]);
  assert.equal(h.lines.filter(f => f.op === 'style').at(-1).style, 'ring');
});
test('a host cannot request an internal fallback operation', async t => {
  const h = harness(t); await settle(); h.event({ op: 'fallback', character: 'cat' }); await settle();
  assert.deepEqual(h.calls, []);
});
test('a queued sprite refusal cannot replace a newer cursor choice', async t => {
  const sprite = { manifest: { id: 'cat', frame: { w: 64, h: 64 }, sheet: 'sheet.png', states: {}, scale: 1 }, folder: '/fixture/cat',
    sheets: { sheet: { width: 512, height: 64 } }, resolved: [{ state: 'idle', sheet: 'sheet.png', row: 0, start: 0, frames: 1, ms: [100], loop: false, hotspot: { x: 32, y: 32 } }] };
  let release;
  const h = harness(t, e => e.style === 'glove' ? new Promise(resolve => { release = () => resolve({ ok: true, style: 'glove' }); }) : { ok: true, ...e },
    { loadSprite: async () => ({ character: sprite, resolve: () => [] }) });
  await settle(); h.event({ op: 'select', style: 'sprite', character: 'cat' }); await settle();
  h.event({ op: 'select', style: 'glove' }); await settle();
  h.event({ hand: 'character', id: 'cat', loaded: false, reason: 'pixels', warnings: [] }); release(); await settle();
  assert.deepEqual(h.calls, [{ op: 'select', style: 'sprite', character: 'cat' }, { op: 'select', style: 'glove' }]);
  assert.equal(h.lines.filter(f => f.op === 'style').at(-1).style, 'glove');
});
