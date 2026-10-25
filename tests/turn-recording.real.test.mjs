import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixture, skip } from './fixtures/cr4-real.mjs';
import { captureRecordingFrame } from '../plugins/sleight/lib/direct-browser/recording.mjs';
import { createV3TurnBinding } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { createV3TurnRuntime } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { snapshot, acknowledgeSnapshot } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
import { createTurnRecording } from '../plugins/sleight/lib/turn-recording.mjs';

const html = `<!doctype html><style>body{margin:0;background:white}h1{margin:0;height:80px;background:#00ff00}input,textarea,select,[contenteditable],[role=textbox],iframe,canvas{display:block;width:240px;height:40px;box-sizing:border-box;border:0;margin:0;background:#ff0000;color:red}</style>
<h1>Recording fixture</h1><input type=password value=secret-password><input autocomplete=cc-number value=4242424242424242>
<textarea>private value</textarea><div contenteditable>private text</div><div role=textbox>private card</div>
<iframe srcdoc="<body style='background:red'>private card</body>"></iframe><canvas></canvas><input type=text value=public-name><div style="height:3000px">Below viewport</div>`;
const pixel = (image, x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];

function gradeGif(path, frames, noRed = false) {
  const decoded = spawnSync('python3', ['-c', `from PIL import Image
import json,sys
im=Image.open(sys.argv[1]); frames=json.loads(sys.argv[2]); assert im.n_frames==len(frames),(im.n_frames,len(frames))
for i,checks in enumerate(frames):
 im.seek(i); p=im.convert('RGB')
 if sys.argv[3]=='1': assert not any(r>200 and g<30 and b<30 for r,g,b in p.getdata()),('unmasked red field or media pixels',i)
 for x,y,rgb in checks:
  assert p.getpixel((x,y))==tuple(rgb),(i,x,y,p.getpixel((x,y)),rgb)
`, path, JSON.stringify(frames), noRed ? '1' : '0'], { encoding: 'utf8' });
  assert.equal(decoded.status, 0, decoded.stderr);
}

function gifChecks(box, width = 1280, height = 720) {
  const scale = Math.min(1, 640 / width, 480 / height);
  const left = Math.floor((640 - Math.floor(width * scale)) / 2), top = Math.floor((480 - Math.floor(height * scale)) / 2);
  return [0.15, 0.5, 0.85].flatMap(x => [0.15, 0.5, 0.85].map(y =>
    [Math.floor(left + (box.x + box.width * x) * scale), Math.floor(top + (box.y + box.height * y) * scale), [0, 0, 0]]));
}

test('compositor scrolling skips safely and a settled action records masked fields', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, `<style>body{margin:0}#scroller{height:600px;width:600px;overflow:auto;scroll-behavior:smooth}#content{position:relative;height:3000px}input{position:absolute;left:20px;top:650px;width:240px;height:50px;background:red;border:0}</style><div id=scroller role=region aria-label="Scroll area"><div id=content><input type=password value=secret><p>Scroll fixture</p></div></div>`, {}, { smoothScrolling: true });
  const dir = mkdtempSync(join(tmpdir(), 'sleight-g13-scroll-')), path = join(dir, 'actions.gif');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = await createV3TurnRuntime({ binding: createV3TurnBinding({ source: 'user', session: 'g13', turn: 'scroll', id: 'user', text: 'Record this turn.\nScroll down.' }, () => true),
    browser: 'bfixture', pages: f.registry, snapshot, dependencies: { acknowledgeSnapshot,
      recording: { createFile: () => ({ path, fd: openSync(path, 'wx', 0o600) }) } } });
  t.after(() => runtime.end());
  const read = await runtime.call({ name: 'browser_read', arguments: { tab: f.entry.tab } });
  assert.equal(runtime.delivered(read), true, read.text);
  const ref = /\[ref=(e\d+)\]/.exec(read.text.split('\n').find(line => line.includes('"Scroll area"')) ?? '')?.[1];
  assert.ok(ref, read.text);
  // Start the compositor scroll in this owned headless fixture before the production scroll step.
  await f.entry.page.evaluate(() => document.querySelector('#scroller').scrollTo({ top: 400, behavior: 'smooth' }));
  const acted = await runtime.call({ name: 'browser_act', arguments: { tab: f.entry.tab, steps: [{ do: 'scroll', ref, dy: 100 }], observe: 'none' } });
  assert.equal(acted.isError, false, acted.text);
  if (!existsSync(path)) {
    await new Promise(resolve => setTimeout(resolve, 300));
    const settled = await runtime.call({ name: 'browser_act', arguments: { tab: f.entry.tab, steps: [{ do: 'wait', ref, ms: 100 }], observe: 'none' } });
    assert.equal(settled.isError, false, settled.text);
  }
  const box = await f.entry.page.locator('input').boundingBox();
  assert.ok(box.y >= 0 && box.y + box.height < 720, JSON.stringify(box));
  const ended = await runtime.end();
  assert.match(ended.recording, /1 frames/, acted.text + '\n' + ended.recording);
  gradeGif(path, [[]], true);
});

test('compositor wheel motion during capture never saves drifting password pixels', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<!doctype html><style>html{scroll-behavior:smooth}body{margin:0;height:3000px}input{position:absolute;left:20px;top:650px;width:240px;height:50px;border:0;background:red;color:red}</style><input type=password value=secret>', {}, { smoothScrolling: true });
  const dir = mkdtempSync(join(tmpdir(), 'sleight-g13-document-scroll-')), path = join(dir, 'actions.gif');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Delay only the real pixel read, after Playwright would have placed any overlay masks.
  // This lets the compositor advance without changing or replacing the screenshot bytes.
  const attach = f.context.newCDPSession.bind(f.context);
  f.context.newCDPSession = async (...args) => {
    const cdp = await attach(...args), send = cdp.send.bind(cdp);
    cdp.send = async (method, ...params) => {
      if (method === 'Page.captureScreenshot') await new Promise(resolve => setTimeout(resolve, 250));
      return send(method, ...params);
    };
    return cdp;
  };
  t.after(() => { f.context.newCDPSession = attach; });
  await f.entry.page.emulateMedia({ reducedMotion: 'no-preference' });
  const recording = createTurnRecording({ current: () => true, capture: () => captureRecordingFrame(f.entry, { pages: f.registry, current: () => true }),
    createFile: () => ({ path, fd: openSync(path, 'wx', 0o600) }) });
  const cdp = await f.context.newCDPSession(f.entry.page);
  try {
    const scrolling = cdp.send('Input.synthesizeScrollGesture', { x: 300, y: 300, yDistance: -400, speed: 500, gestureSourceType: 'mouse' });
    await recording.capture(f.entry); await scrolling;
    if (!existsSync(path)) await recording.capture(f.entry);
  } finally { await cdp.detach(); await recording.end(); }
  assert.match(recording.note(), /1 frames/, recording.note());
  assert.ok(await f.entry.page.evaluate(() => scrollY > 100), 'real compositor input moved the document');
  const box = await f.entry.page.locator('input').boundingBox();
  assert.ok(box.y >= 0 && box.y + box.height < 720, JSON.stringify(box));
  gradeGif(path, [[]], true);
});

test('owned viewport capture blacks fields, pixelates other content and restores page scripts', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, html);
  const frame = await captureRecordingFrame(f.entry, { pages: f.registry, current: () => true });
  assert.ok(frame.height < 3000, 'viewport only');
  assert.deepEqual(pixel(frame, 1000, 40), [0, 255, 0]);
  for (const i of [0, 1, 2, 3, 4, 7]) assert.deepEqual(pixel(frame, 10, 90 + i * 40), [0, 0, 0], 'masked field ' + i);
  const opaque = pixel(frame, 200, 300);
  assert.ok(opaque[0] > 200 && opaque[1] > 0 && opaque[1] < 128 && opaque[2] === opaque[1], 'untargeted opaque content uses coarse pixelation');
  await f.entry.page.evaluate(() => { window.afterRecording = 7; });
  assert.equal(await f.entry.page.evaluate(() => window.afterRecording), 7);
  assert.equal(await f.sentinel.evaluate(() => document.visibilityState), f.before);
});

test('a targeted closed shadow host is black; motion and revoked ownership skip frames', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<div id=host></div>');
  await f.entry.page.evaluate(() => { const host = document.querySelector('#host'); host.style.cssText = 'width:240px;height:80px;background:red'; host.attachShadow({ mode: 'closed' }).innerHTML = '<input value=secret>'; });
  const handle = await f.entry.page.locator('#host').elementHandle();
  try {
    const frame = await captureRecordingFrame(f.entry, { pages: f.registry, current: () => true, target: { handle } });
    assert.deepEqual(pixel(frame, 30, 30), [0, 0, 0]);
  } finally { await handle.dispose(); }
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

test('production turn grades field pixels in every saved GIF frame, including late fields and typing', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, `<style>body{margin:0}#marker{height:40px;background:#00ff00}input{position:absolute;left:40px;width:240px;height:40px;border:0;background:red;color:red}#name{top:80px}#city{top:150px}#late{top:220px}button{position:absolute;top:280px}</style><div id=marker>Public marker</div><label>Name<input id=name></label><label>City<input id=city></label><button type=button onclick="this.insertAdjacentHTML('afterend','<label>Late<input id=late></label>')">Next</button>`);
  const dir = mkdtempSync(join(tmpdir(), 'sleight-g13-real-')), path = join(dir, 'actions.gif');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let current = true;
  const binding = createV3TurnBinding({ source: 'user', session: 'g13', turn: 'one', id: 'user', text: 'Record this turn.\nFill Name and City, then click Next.' }, () => current);
  const runtime = await createV3TurnRuntime({ binding, browser: 'bfixture', pages: f.registry, snapshot,
    dependencies: { acknowledgeSnapshot, recording: { createFile: () => ({ path, fd: openSync(path, 'wx', 0o600) }) } } });
  t.after(() => runtime.end());
  const opened = await runtime.call({ name: 'browser_open', arguments: { url: f.entry.page.url() + '?recorded' } });
  assert.equal(opened.isError, false, opened.text); assert.match(opened.text, /frames are pixelated/); assert.match(opened.text, /the outline shows where the action landed/);
  assert.doesNotMatch(opened.text, /clear|25%|hit.test/); assert.match(opened.text, /5,000-element field cap and 50 ms/); assert.doesNotMatch(opened.text, /actions.gif/);
  assert.equal(runtime.delivered(opened), true);
  const tab = /^(t[A-Za-z0-9_-]+)/.exec(opened.text)?.[1]; assert.ok(tab, opened.text);
  const read = await runtime.call({ name: 'browser_read', arguments: { tab } });
  assert.equal(runtime.delivered(read), true);
  const refs = ['Name', 'City', 'Next'].map(name => /\[ref=(e\d+)\]/.exec(read.text.split('\n').find(line => line.includes('"' + name + '"') && line.includes('[ref=')) ?? '')?.[1]);
  assert.ok(refs.every(Boolean), read.text);
  const result = await runtime.call({ name: 'browser_fill', arguments: { tab, fields: [{ ref: refs[0], value: 'Ada' }, { ref: refs[1], value: 'Paris' }] } });
  assert.equal(result.isError, false, result.text); assert.doesNotMatch(result.text, /Recording|actions.gif/); assert.equal(runtime.delivered(result), true);
  const acted = await runtime.call({ name: 'browser_act', arguments: { tab, steps: [{ do: 'click', ref: refs[2] }] } });
  assert.equal(acted.isError, false, acted.text); runtime.delivered(acted);
  const laterRead = await runtime.call({ name: 'browser_read', arguments: { tab } }); runtime.delivered(laterRead);
  const lateRef = /\[ref=(e\d+)\]/.exec(laterRead.text.split('\n').find(line => line.includes('"Late"') && line.includes('[ref=')) ?? '')?.[1];
  assert.ok(lateRef, laterRead.text);
  const typed = await runtime.call({ name: 'browser_act', arguments: { tab, steps: [{ do: 'type', ref: lateRef, text: 'private late value' }] } });
  assert.equal(typed.isError, false, typed.text);
  assert.equal(await f.registry.tab(tab).page.locator('#late').inputValue(), 'private late value');
  assert.equal(await f.entry.page.locator('#name').inputValue(), '', 'unrelated owned tab unchanged');
  const ordinary = [80, 150].flatMap(y => gifChecks({ x: 40, y, width: 240, height: 40 }));
  const late = gifChecks({ x: 40, y: 220, width: 240, height: 40 });
  gradeGif(path, Array.from({ length: 5 }, (_, i) => [...ordinary, ...(i >= 3 ? late : []), [300, 70, [0, 255, 0]]]), true);
  current = false; const ended = await runtime.end();
  assert.match(ended.recording, /5 frames/); assert.match(ended.recording, /Pixel processing per frame/);
  t.diagnostic(ended.recording.replace(path, '<fixture GIF>'));
});

test('animation, never-act site, screenshot timeout and tree or viewport caps skip only their frame', { skip, timeout: 30000 }, async t => {
  const f = await fixture(t, '<input type=password value=secret><div id=spinner></div>');
  const dir = mkdtempSync(join(tmpdir(), 'sleight-g13-skips-')), path = join(dir, 'actions.gif');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const recording = createTurnRecording({ current: () => true,
    capture: () => captureRecordingFrame(f.entry, { pages: f.registry, current: () => true, sites: url => url.includes('never-act') }),
    createFile: () => ({ path, fd: openSync(path, 'wx', 0o600) }) });
  t.after(() => recording.end());
  await f.entry.page.evaluate(() => document.querySelector('#spinner').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 10000, iterations: Infinity }));
  await recording.capture(f.entry);
  await f.entry.page.goto(f.entry.page.url() + '?never-act'); await recording.capture(f.entry);
  await f.entry.page.goto(f.entry.page.url().replace('?never-act', '?resumed'));
  const attach = f.context.newCDPSession.bind(f.context);
  let captureMode = 'timeout';
  f.context.newCDPSession = async (...args) => {
    const cdp = await attach(...args), send = cdp.send.bind(cdp);
    cdp.send = (method, ...params) => method !== 'Page.captureScreenshot' || captureMode === 'normal' ? send(method, ...params)
      : captureMode === 'timeout' ? new Promise(() => {}) : Promise.resolve({ data: 'A'.repeat(12 * 1024 * 1024) });
    return cdp;
  };
  t.after(() => { f.context.newCDPSession = attach; });
  await recording.capture(f.entry); captureMode = 'oversized';
  await recording.capture(f.entry); captureMode = 'normal';
  await f.entry.page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<input style="display:none">'.repeat(5001)));
  await recording.capture(f.entry);
  await f.entry.page.goto(f.entry.page.url() + '&small-tree');
  await f.entry.page.setViewportSize({ width: 10000, height: 2000 }); await recording.capture(f.entry);
  await f.entry.page.setViewportSize({ width: 1280, height: 720 }); await recording.capture(f.entry);
  assert.match(recording.note(), /1 frames, 6 skipped/);
  assert.match(recording.note(), /animation/); assert.match(recording.note(), /target unavailable/); assert.match(recording.note(), /timeout/);
  const box = await f.entry.page.locator('input').boundingBox(); gradeGif(path, [gifChecks(box)]);
});

for (const tool of ['browser_fill', 'browser_act']) test(`script restoration failure stops recording while ${tool} and later input continue`, { skip, timeout: 30000 }, async t => {
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
  assert.doesNotMatch(result.text, /not reached/); assert.match(result.text, /script resumption is unconfirmed/);
  assert.match(result.text, /Browser actions remain available/);
  assert.equal(await f.entry.page.locator('#name').inputValue(), 'Ada');
  assert.equal(await f.entry.page.locator('#city').inputValue(), 'Paris');
  const next = await runtime.call({ name: tool, arguments: { tab: f.entry.tab, ...args } });
  assert.equal(next.isError, false, next.text); assert.doesNotMatch(next.text, /Nothing was sent/);
});
