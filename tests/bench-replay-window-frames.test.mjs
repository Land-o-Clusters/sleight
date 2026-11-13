import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { withWindowFrames, windowFrameOutput } from '../bench/replay/window-frames.mjs';
import { TargetMapper } from '../bench/replay/mapping.mjs';
import { resultText } from '../bench/replay/mapping.mjs';
import { check4Options, check4Plan } from '../bench/hand/check4.mjs';
import { options } from '../bench/replay/run.mjs';
import { getTasks } from '../bench/tasks.mjs';
import { recordingPreflight } from '../bench/hand/check4-live.mjs';

const receipt = (id, title = 'Source-1234abcd.txt') => ({ ok: true,
  target: { appId: 'com.apple.TextEdit', app: 'TextEdit', title, url: pathToFileURL(join(tmpdir(), 'sleight-bench/stamp/task', title)).href },
  identity: { pid: 42, windowNumber: id } });
const frame = { x: 16, y: 49, width: 720, height: 560 };
const selected = receipt(7);
const observations = [{ ...selected, frame }, { ...receipt(8, 'Target-1234abcd.txt'), frame: { ...frame, x: 752 } }];
const text = r => ({ content: [{ type: 'text', text: JSON.stringify(r) }] });

test('recording flag is opt-in in check 4 and replay, and survives the dry plan', () => {
  assert.equal(check4Options([]).recordWindowFrames, undefined);
  assert.equal(check4Plan(check4Options(['--record-window-frames'])).recordWindowFrames, true);
  assert.equal(options(['--record-window-frames'])['record-window-frames'], true);
});

test('recording prompt asks for a selection immediately before drag only with the private flag', () => {
  const task = getTasks('world').find(t => t.id === 'textedit-window-drag');
  const ctx = { documents: ['/fixture/Source-1234abcd.txt', '/fixture/Target-1234abcd.txt'], nonce: '1234abcd' };
  assert.equal(task.prompt(ctx).includes('Immediately before'), false);
  assert.ok(task.prompt({ ...ctx, check4RecordWindowFrames: true }).includes('Immediately before'));
  const prompt = task.prompt({ ...ctx, check4RecordWindowFrames: true });
  for (const instruction of ['title', 'keyboard', 'element', 'Never use coordinates on a JavaScript app handle', 'Never use a file URL'])
    assert.ok(prompt.includes(instruction), instruction);
});

test('recording preflight refuses running Calculator and unknown process-query failures', async () => {
  assert.deepEqual(await recordingPreflight(async () => { throw Object.assign(Error('not running'), { code: 1 }); }), { calculatorClosed: true });
  await assert.rejects(recordingPreflight(async () => ({})), /Calculator to be closed/);
  await assert.rejects(recordingPreflight(async () => { throw Object.assign(Error('timeout'), { code: 'ETIMEDOUT' }); }), /timeout/);
});

test('one selected receipt gains both fixture frames, preserving identity and original result fields', async () => {
  const result = { ...text(selected), _meta: { test: true } }, before = structuredClone(result), seen = [];
  const augmented = await withWindowFrames(result, async target => { seen.push(target); return observations; });
  assert.deepEqual(seen, [{ appId: 'com.apple.TextEdit', pid: 42 }]);
  assert.deepEqual(result, before);
  assert.deepEqual(JSON.parse(augmented.content[0].text), { ...selected, frame });
  assert.equal(augmented.content.length, 2); assert.deepEqual(augmented._meta, result._meta);
  const fresh = await withWindowFrames(text({ ...selected, identity: { pid: 42, windowNumber: 17 } }), async () => observations.map(r =>
    ({ ...r, identity: { ...r.identity, windowNumber: r.identity.windowNumber + 10 } })));
  const mapper = new TargetMapper();
  mapper.observe(resultText(augmented), resultText(fresh), {}, { server: 'plugin:sleight:computer', name: 'select_window' });
  assert.deepEqual(mapper.arguments({ app: 'com.apple.TextEdit', from: [10, 20], to: [40, 50], windowId: 7, toWindowId: 8 }),
    { app: 'com.apple.TextEdit', from: [10, 20], to: [40, 50], windowId: 17, toWindowId: 18 });
  mapper.observe('read', 'read', {}, { server: 'plugin:sleight:computer', name: 'js' });
  assert.throws(() => mapper.arguments({ app: 'com.apple.TextEdit', from: [10, 20], to: [40, 50], windowId: 7, toWindowId: 8 }), /frame/);
});

test('missing, duplicate, changed-app, changed-pid and changed-title frames refuse the recording', async () => {
  for (const rows of [[], [observations[0], observations[0]], observations.map(r => ({ ...r, identity: { ...r.identity, pid: 99 } })),
    observations.map(r => ({ ...r, target: { ...r.target, appId: 'other.app' } })),
    observations.map(r => ({ ...r, target: { ...r.target, title: 'Changed' } })),
    observations.map(r => ({ ...r, frame: { ...r.frame, width: 0 } }))])
    await assert.rejects(withWindowFrames(text(selected), async () => rows), /missing|ambiguous|changed/);
  const error = { ...text(selected), isError: true };
  assert.equal(await withWindowFrames(error, () => assert.fail('declined selection queried metadata')), error);
  await assert.rejects(withWindowFrames(text({ ...selected, target: { ...selected.target, appId: 'other.app' } })), /no fixture identity/);
});

test('output adapter enriches only actual select_window replies, preserves wire order and chunks UTF-8', async () => {
  const input = new PassThrough(), output = new PassThrough(); let writes = '', queries = 0;
  output.on('data', chunk => { writes += chunk; });
  const adapter = windowFrameOutput(input, output, async () => { queries++; return observations; });
  input.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'js' } }) + '\n');
  input.write(JSON.stringify({ id: 2, method: 'tools/call', params: { name: 'select_window' } }) + '\n');
  const first = Buffer.from(JSON.stringify({ id: 1, result: text({ ...selected, note: 'fixturé' }) }) + '\n');
  const second = JSON.stringify({ id: 2, result: text(selected) }) + '\n';
  const split = first.indexOf(Buffer.from('é')) + 1;
  adapter.write(first.subarray(0, split)); adapter.write(Buffer.concat([first.subarray(split), Buffer.from(second.slice(0, 4))]));
  await new Promise((resolve, reject) => adapter.end(second.slice(4), error => error ? reject(error) : resolve()));
  const replies = writes.trim().split('\n').map(JSON.parse);
  assert.equal(queries, 1); assert.deepEqual(replies.map(r => r.id), [1, 2]);
  assert.equal(JSON.parse(replies[0].result.content[0].text).note, 'fixturé');
  assert.equal(JSON.parse(replies[0].result.content[0].text).frame, undefined);
  assert.deepEqual(JSON.parse(replies[1].result.content[0].text).frame, frame);
  adapter.destroy();
});

test('observation failure produces an error reply instead of frame-less success', async () => {
  const input = new PassThrough(), output = new PassThrough(); let line = '';
  output.on('data', chunk => { line += chunk; });
  const adapter = windowFrameOutput(input, output, async () => []);
  input.write(JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'select_window' } }) + '\n');
  await new Promise(resolve => adapter.end(JSON.stringify({ id: 1, result: text(selected) }) + '\n', resolve));
  assert.equal(JSON.parse(line).result.isError, true); adapter.destroy();
});

test('read-only native observer filters nonfixture windows and cross-checks AX geometry with CG identity', () => {
  const source = readFileSync(new URL('../bench/replay/window-frames.js', import.meta.url), 'utf8');
  const observe = (change = {}) => {
    const app = { isNil: () => false, terminated: false, bundleIdentifier: 'com.apple.TextEdit' };
    const windows = [
      { AXTitle: selected.target.title, AXDocument: selected.target.url, AXPosition: { x: 16, y: 49 }, AXSize: { width: 720, height: 560 } },
      { AXTitle: 'Owner document.txt' },
    ];
    const list = { count: windows.length, objectAtIndex: i => windows[i] };
    const $ = value => value;
    Object.assign($, { AXIsProcessTrusted: () => true,
      NSRunningApplication: { runningApplicationWithProcessIdentifier: () => app }, AXUIElementCreateApplication: () => ({ AXWindows: list }),
      AXUIElementSetMessagingTimeout: () => 0,
      AXUIElementCopyAttributeValue: (el, key, out) => { out[0] = el[key]; return key in el ? 0 : 1; },
      NSMutableData: { dataWithLength: () => { const data = {}; data.mutableBytes = data; data.bytes = data; return data; } },
      AXValueGetValue: (value, type, out) => { out.value = value; return true; },
      NSValue: { valueWithBytesObjCType: bytes => ({ pointValue: bytes.value, sizeValue: bytes.value }) },
      CGWindowListCopyWindowInfo: () => [{ kCGWindowOwnerPID: 42, kCGWindowNumber: 7, kCGWindowLayer: 0, kCGWindowAlpha: 1,
        kCGWindowBounds: { X: 16, Y: 49, Width: 720, Height: 560, ...change } }],
    });
    return JSON.parse(runInNewContext(source + '\nrun([JSON.stringify(request)])', { $, Ref: () => [], request: { appId: 'com.apple.TextEdit', pid: 42 },
      ObjC: { import() {}, unwrap: x => x, deepUnwrap: x => x, castRefToObject: x => x } }));
  };
  const result = observe(); assert.equal(result.ok, true); assert.equal(result.receipts.length, 1);
  assert.deepEqual(result.receipts[0].frame, frame);
  assert.equal(observe({ X: 25 }).ok, false);
});
