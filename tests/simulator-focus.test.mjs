import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulatorScreenshotNote } from '../plugins/sleight/lib/simulator-focus.mjs';
import { createRelay, imageSize, screenshotOf } from '../plugins/sleight/lib/relay.mjs';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';

const png = (width, height) => {
  const bytes = Buffer.alloc(25);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
  return { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') };
};
const target = { app: 'Device Hub', title: 'iPhone fixture' };

test('a first headerless simulator screenshot gets its dimensions from the leased target', () => {
  const content = [png(2196, 1598)];
  assert.equal(screenshotOf(content), undefined, 'the old header-based association misses a standalone screenshot');
  const note = simulatorScreenshotNote(content, target, imageSize);
  assert.match(note, /2196 × 1598/);
  assert.match(note, /iPhone fixture/);
  assert.match(note, /focus/);
  assert.match(note, /Capture Keyboard.*unchanged/);
});

test('an oversized screenshot names the engine frame, the shown size and the exact factor', () => {
  const note = simulatorScreenshotNote([png(2200, 1600)], target, imageSize);
  assert.match(note, /engine screenshot 2200 × 1600 pixels/);
  assert.match(note, /2000 × 1455/);
  assert.match(note, /multiply each x and y by 1\.1/);
  assert.match(note, /focus/);
  assert.match(note, /Capture Keyboard.*unchanged/);
});

test('a screenshot no larger than Claude Code shows unresized gets no note', () => {
  assert.equal(simulatorScreenshotNote([png(1568, 1140)], target, imageSize), undefined);
  assert.equal(simulatorScreenshotNote([png(2000, 1200)], target, imageSize), undefined);
  assert.equal(simulatorScreenshotNote([png(1200, 2000)], target, imageSize), undefined);
});

test('unowned, contradictory and ambiguous screenshots get no simulator advice', () => {
  for (const [content, context] of [
    [[png(2196, 1598)], undefined],
    [[png(2196, 1598)], { app: 'Safari', title: 'iPhone fixture' }],
    [[png(2196, 1598)], { app: 'Device Hub' }],
    [[png(2196, 1598), png(2196, 1598)], target],
    [[{ type: 'text', text: 'Window: "Other", App: Device Hub.' }, png(2196, 1598)], target],
    [[{ type: 'text', text: 'Window: "iPhone fixture", App: Safari.' }, png(2196, 1598)], target],
    [[{ type: 'text', text: 'Window: "bad\\q", App: Device Hub.' }, png(2196, 1598)], target],
    [[png(0, 1598)], target],
    [[{ type: 'image', data: 'invalid' }], target],
  ]) assert.equal(simulatorScreenshotNote(content, context, imageSize), undefined);
});

test('matching Simulator app identity permits advice without mutating pixels or targets', () => {
  const content = [{ type: 'text', text: 'Window: "iPhone fixture", App: Simulator.' }, png(2196, 1598)];
  const before = structuredClone(content);
  const context = { app: 'com.apple.iphonesimulator', title: 'iPhone fixture' };
  assert.match(simulatorScreenshotNote(content, context, imageSize), /2196 × 1598/);
  assert.deepEqual(content, before);
});

for (const enabled of [undefined, false, true]) test(`Simulator note is ${enabled === false ? 'absent' : 'present'} with simFocusNote=${enabled === undefined ? 'default' : enabled}`, async t => {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const bank = mkdtempSync('/private/tmp/sleight-simulator-note-');
  const replies = [], forwarded = [];
  clientOut.on('data', data => data.toString().trim().split('\n').forEach(line => replies.push(JSON.parse(line))));
  serverIn.on('data', data => data.toString().trim().split('\n').forEach(line => forwarded.push(JSON.parse(line))));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, simFocusNote: enabled, inputLease: new InputLease({ directory: bank, holder: 'simulator note test' }) });
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); rmSync(bank, { recursive: true, force: true }); });
  const call = (id, code) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
  const reply = (id, content, appId) => serverOut.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content,
    ...(appId && { _meta: { 'codex/toolSurface': { app: { appId } } } }) } }) + '\n');
  call(1, 'var sim = await cua.getApp("com.apple.dt.Devices")');
  reply(1, [{ type: 'text', text: 'Window: "iPhone fixture", App: Device Hub.\n0 standard window iPhone fixture' }], 'com.apple.dt.Devices');
  call(2, 'var calc = await cua.getApp("com.apple.calculator")');
  reply(2, [{ type: 'text', text: 'Window: "Calculator", App: Calculator.\n0 standard window Calculator' }], 'com.apple.calculator');
  call(3, 'await sim.getScreenshot()');
  const picture = png(2196, 1598);
  reply(3, [picture]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replies.find(message => message.id === 3).result.content[0], picture);
  if (enabled === false) assert.deepEqual(replies.find(message => message.id === 3).result.content, [picture]);
  else assert.match(replies.find(message => message.id === 3).result.content.at(-1).text, /2196 × 1598.*1\.098/);
  call(4, 'await unknown.getScreenshot()'); reply(4, [picture]);
  call(5, 'await calc.getScreenshot()'); reply(5, [picture]);
  call(6, 'await sim.getScreenshot(); await calc.getScreenshot()'); reply(6, [picture]);
  await new Promise(resolve => setImmediate(resolve));
  for (const id of [4, 5, 6]) assert.deepEqual(replies.find(message => message.id === id).result.content, [picture]);
  // Notes are output only. The engine still receives its original coordinate expression.
  call(7, 'var sim = await cua.getApp("com.apple.dt.Devices")');
  reply(7, [{ type: 'text', text: 'Window: "iPhone fixture", App: Device Hub.\n0 standard window iPhone fixture' }], 'com.apple.dt.Devices');
  call(8, 'await sim.click([1254,282])');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(forwarded.find(message => message.id === 8).params.arguments.code, /await sim\.click\(\[1254,282\]\)/);
});
