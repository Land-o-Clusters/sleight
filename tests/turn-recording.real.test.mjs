import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, skip } from './fixtures/cr4-real.mjs';
import { captureRecordingFrame } from '../plugins/sleight/lib/direct-browser/recording.mjs';
import { createV3TurnBinding } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { createV3TurnRuntime } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { snapshot, acknowledgeSnapshot } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';

const html = `<!doctype html><style>body{margin:0;background:white}h1{margin:0;height:80px;background:#00ff00}input,textarea,select,[contenteditable],[role=textbox],iframe,canvas{display:block;width:240px;height:40px;box-sizing:border-box;border:0;margin:0;background:#ff0000;color:red}</style>
<h1>Recording fixture</h1><input type=password value=secret-password><input autocomplete=cc-number value=4242424242424242>
<textarea>private value</textarea><div contenteditable>private text</div><div role=textbox>private card</div>
<iframe srcdoc="<body style='background:red'>private card</body>"></iframe><canvas></canvas><input type=text value=public-name><div style="height:3000px">Below viewport</div>`;
const pixel = (image, x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];

test('owned viewport capture masks fields and opaque frames and restores page scripts', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, html);
  const frame = await captureRecordingFrame(f.entry, { pages: f.registry, current: () => true });
  assert.ok(frame.height < 3000, 'viewport only');
  assert.deepEqual(pixel(frame, 10, 10), [0, 255, 0]);
  for (let i = 0; i < 8; i++) assert.deepEqual(pixel(frame, 10, 90 + i * 40), [0, 0, 0], 'masked field ' + i);
  await f.entry.page.evaluate(() => { window.afterRecording = 7; });
  assert.equal(await f.entry.page.evaluate(() => window.afterRecording), 7);
  assert.equal(await f.sentinel.evaluate(() => document.visibilityState), f.before);
});

test('shadow roots, motion and revoked ownership fail closed without saving pixels', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<div id=host></div>');
  await f.entry.page.evaluate(() => document.querySelector('#host').attachShadow({ mode: 'closed' }).innerHTML = '<input value=secret>');
  await assert.rejects(captureRecordingFrame(f.entry, { pages: f.registry, current: () => true }), /OPAQUE_TREE/);
  await f.entry.page.evaluate(() => { window.restored = true; });
  assert.equal(await f.entry.page.evaluate(() => window.restored), true);
  await assert.rejects(captureRecordingFrame(f.entry, { pages: f.registry, current: () => false }), /TARGET_UNAVAILABLE/);
  await f.entry.page.goto(f.entry.page.url() + '?fresh');
  await f.entry.page.evaluate(() => document.querySelector('#host').animate([{ transform: 'translateX(0)' }, { transform: 'translateX(100px)' }], { duration: 10000, iterations: Infinity }));
  await assert.rejects(captureRecordingFrame(f.entry, { pages: f.registry, current: () => true }), /MOTION_UNAVAILABLE/);
});

test('top-layer payment fields remain masked', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<dialog><input autocomplete=cc-number value=4242424242424242 style="width:240px;height:40px;background:red;border:0"></dialog>');
  await f.entry.page.evaluate(() => document.querySelector('dialog').showModal());
  const box = await f.entry.page.locator('input').boundingBox();
  const frame = await captureRecordingFrame(f.entry, { pages: f.registry, current: () => true });
  assert.deepEqual(pixel(frame, Math.round(box.x + 10), Math.round(box.y + 10)), [0, 0, 0]);
});

test('production turn records opening, fields and actions and revokes at end', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<label>Name<input id=name></label><label>City<input id=city></label><button type=button>Next</button>');
  const dir = mkdtempSync(join(tmpdir(), 'sleight-g13-real-')), path = join(dir, 'actions.gif');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let current = true;
  const binding = createV3TurnBinding({ source: 'user', session: 'g13', turn: 'one', id: 'user', text: 'Record this turn.\nFill Name and City, then click Next.' }, () => current);
  const runtime = await createV3TurnRuntime({ binding, browser: 'bfixture', pages: f.registry, snapshot,
    dependencies: { acknowledgeSnapshot, recording: { createFile: () => ({ path, fd: openSync(path, 'wx', 0o600) }) } } });
  t.after(() => runtime.end());
  const opened = await runtime.call({ name: 'browser_open', arguments: { url: f.entry.page.url() + '?recorded' } });
  assert.equal(opened.isError, false, opened.text); assert.match(opened.text, /1 frames/);
  assert.equal(runtime.delivered(opened), true);
  const tab = /^(t[A-Za-z0-9_-]+)/.exec(opened.text)?.[1]; assert.ok(tab, opened.text);
  const read = await runtime.call({ name: 'browser_read', arguments: { tab } });
  assert.equal(runtime.delivered(read), true);
  const refs = ['Name', 'City', 'Next'].map(name => /\[ref=(e\d+)\]/.exec(read.text.split('\n').find(line => line.includes('"' + name + '"') && line.includes('[ref=')) ?? '')?.[1]);
  assert.ok(refs.every(Boolean), read.text);
  const result = await runtime.call({ name: 'browser_fill', arguments: { tab, fields: [{ ref: refs[0], value: 'Ada' }, { ref: refs[1], value: 'Paris' }] } });
  assert.equal(result.isError, false, result.text); assert.match(result.text, /3 frames/); assert.equal(runtime.delivered(result), true);
  const acted = await runtime.call({ name: 'browser_act', arguments: { tab, steps: [{ do: 'click', ref: refs[2] }] } });
  assert.match(acted.text, /4 frames/);
  assert.equal(await f.entry.page.locator('#name').inputValue(), '', 'unrelated owned tab unchanged');
  assert.equal(readFileSync(path).subarray(0, 6).toString(), 'GIF89a');
  current = false; await runtime.end();
});

for (const tool of ['browser_fill', 'browser_act']) test(`script restoration failure fences the rest of ${tool} and later input`, { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<label>Name<input id=name></label><label>City<input id=city></label>');
  const binding = createV3TurnBinding({ source: 'user', session: 'g13', turn: 'failure', id: 'user', text: 'Record this turn.\nFill Name and City.' }, () => true);
  const runtime = await createV3TurnRuntime({ binding, browser: 'bfixture', pages: f.registry, snapshot,
    dependencies: { acknowledgeSnapshot, recording: { capture: async () => { throw Error('RECORDING_RESUME_UNCONFIRMED'); } } } });
  t.after(() => runtime.end());
  const read = await runtime.call({ name: 'browser_read', arguments: { tab: f.entry.tab } }); runtime.delivered(read);
  const refs = ['Name', 'City'].map(name => /\[ref=(e\d+)\]/.exec(read.text.split('\n').find(line => line.includes('"' + name + '"') && line.includes('[ref=')) ?? '')?.[1]);
  const args = tool === 'browser_fill' ? { fields: [{ ref: refs[0], value: 'Ada' }, { ref: refs[1], value: 'Paris' }] }
    : { steps: [{ do: 'type', ref: refs[0], text: 'Ada' }, { do: 'type', ref: refs[1], text: 'Paris' }] };
  const result = await runtime.call({ name: tool, arguments: { tab: f.entry.tab, ...args } });
  assert.match(result.text, /not reached/); assert.match(result.text, /script resumption is unconfirmed/);
  assert.equal(await f.entry.page.locator('#name').inputValue(), 'Ada');
  assert.equal(await f.entry.page.locator('#city').inputValue(), '');
  const next = await runtime.call({ name: tool, arguments: { tab: f.entry.tab, ...args } });
  assert.equal(next.isError, true); assert.match(next.text, /Nothing was sent/);
});
