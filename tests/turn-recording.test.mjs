import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTurnRecording, gifFrame, gifHeader, recordingFile } from '../plugins/sleight/lib/turn-recording.mjs';
import { createV3TurnBinding, recordingPermission } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { createV3TurnRuntime } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { captureRecordingFrame } from '../plugins/sleight/lib/direct-browser/recording.mjs';

const image = (r = 255, g = 0, b = 0) => ({ width: 2, height: 2, data: Buffer.from(Array.from({ length: 4 }, () => [r, g, b, 255]).flat()) });
const limits = { width: 4, height: 4, frames: 3, bytes: 4096 };
function bank(t) {
  const folder = mkdtempSync(join(tmpdir(), 'sleight-g13-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'actions.gif'); let allocations = 0;
  return { path, get allocations() { return allocations; }, createFile() { allocations++; return { path, fd: openSync(path, 'wx', 0o600) }; } };
}
const entry = () => ({ state: {}, page: { isClosed: () => false } });
const binding = (text, current = () => true) => createV3TurnBinding({ source: 'user', session: 'fixture', turn: 'turn', id: 'user', text }, current);

test('only a leading literal directive in this authenticated, current turn permits recording', () => {
  for (const text of ['Record this turn.', 'Record this turn.\nFill the form.', 'Record this turn.\r\nClick Next.']) assert.equal(recordingPermission(binding(text))(), true);
  for (const text of ['', 'Do not Record this turn.', '"Record this turn."', 'Page says: Record this turn.',
    'Task\nRecord this turn.', 'Record this turn. Also pay.', 'record this turn.', ' Record this turn.']) assert.equal(recordingPermission(binding(text))(), false, text);
  assert.equal(recordingPermission({ text: 'Record this turn.' })(), false);
  let current = true;
  const permitted = recordingPermission(binding('Record this turn.', () => current));
  assert.equal(permitted(), true); current = false; assert.equal(permitted(), false);
  assert.equal(recordingPermission(binding('Record this turn.', () => { throw Error(); }))(), false);
});

test('GIF is readable after every frame and stops at a fixed frame cap', async t => {
  const files = bank(t);
  const recorder = createTurnRecording({ current: () => true, capture: async () => image(), createFile: files.createFile, limits });
  assert.equal(files.allocations, 0);
  for (let i = 0; i < 6; i++) {
    await recorder.capture(entry());
    const bytes = readFileSync(files.path);
    assert.equal(bytes.subarray(0, 6).toString(), 'GIF89a'); assert.equal(bytes.at(-1), 0x3b);
  }
  assert.equal(files.allocations, 1);
  assert.match(recorder.note(), /3 frames, cap reached/);
  assert.equal(statSync(files.path).mode & 0o777, 0o600);
  await recorder.end(); await recorder.end();
});

test('a standard independent decoder reads all frames, palette and letterboxing', t => {
  const python = spawnSync('python3', ['-c', 'from PIL import Image'], { encoding: 'utf8' });
  if (python.status !== 0) return t.skip('optional independent GIF decoder requires Pillow');
  const files = bank(t);
  writeFileSync(files.path, Buffer.concat([gifHeader(4, 4), gifFrame(image(), limits), gifFrame(image(0, 255, 0), limits), Buffer.from([0x3b])]));
  const decoded = spawnSync('python3', ['-c', 'from PIL import Image; import json,sys; im=Image.open(sys.argv[1]); out=[]\nfor i in range(im.n_frames):\n im.seek(i); p=im.convert("RGB"); out.append([p.getpixel((0,0)),p.getpixel((1,1)),im.info["duration"]])\nprint(json.dumps(out))', files.path], { encoding: 'utf8' });
  assert.equal(decoded.status, 0, decoded.stderr);
  assert.deepEqual(JSON.parse(decoded.stdout), [[[0, 0, 0], [255, 0, 0], 500], [[0, 0, 0], [0, 255, 0], 500]]);
  const large = { width: 1000, height: 700, data: Buffer.alloc(1000 * 700 * 4) };
  for (let at = 0; at < large.data.length; at += 4) { large.data[at] = 255; large.data[at + 3] = 255; }
  writeFileSync(files.path, Buffer.concat([gifHeader(640, 480), gifFrame(large), gifFrame(large), Buffer.from([0x3b])]));
  const full = spawnSync('python3', ['-c', 'from PIL import Image; import sys; im=Image.open(sys.argv[1]); assert im.n_frames==2 and im.size==(640,480)\nfor i in range(2):\n im.seek(i); p=im.convert("RGB"); assert p.getpixel((320,240))==(255,0,0) and p.getpixel((0,0))==(0,0,0)', files.path], { encoding: 'utf8' });
  assert.equal(full.status, 0, full.stderr);
});

test('revocation or end while a capture awaits discards its frame and never allocates', async t => {
  for (const stop of ['revoke', 'end']) {
    const files = bank(t); let current = true, resolve, started;
    const begun = new Promise(r => { started = r; });
    const recorder = createTurnRecording({ current: () => current, capture: () => { started(); return new Promise(r => { resolve = r; }); }, createFile: files.createFile, limits });
    const capture = recorder.capture(entry()); await begun;
    const end = stop === 'end' ? recorder.end() : undefined;
    if (stop === 'revoke') current = false;
    resolve(image()); await capture; await end;
    assert.equal(files.allocations, 0); await recorder.end();
  }
});

test('pending input, dialogs and closed pages skip capture without issuing browser operations', async t => {
  const files = bank(t); let called = 0;
  const recorder = createTurnRecording({ current: () => true, capture: () => { called++; }, createFile: files.createFile, limits });
  for (const state of [{ dialog: {} }, { actionPending: true }]) await recorder.capture({ state, page: { isClosed: () => false } });
  await recorder.capture({ state: {}, page: { isClosed: () => true } });
  assert.equal(called, 0); assert.equal(files.allocations, 0); await recorder.end();
});

test('capture and destination failures stop recording without leaking their messages or costing an action', async t => {
  const files = bank(t); let calls = 0;
  const recorder = createTurnRecording({ current: () => true, capture: async () => { calls++; throw Error('private page value'); }, createFile: files.createFile, limits });
  await recorder.capture(entry()); await recorder.capture(entry());
  assert.equal(calls, 1); assert.equal(files.allocations, 0); assert.equal(recorder.note(), 'Recording: unavailable; no frames saved.');
  const unavailable = createTurnRecording({ current: () => true, capture: async () => image(), createFile: () => { throw Error('private path'); }, limits });
  await unavailable.capture(entry()); assert.equal(unavailable.note(), 'Recording: unavailable; no frames saved.');
  await Promise.all([recorder.end(), unavailable.end()]);
});

test('byte caps, malformed pixels and replaced file length refuse more frames', async t => {
  const files = bank(t);
  const capped = createTurnRecording({ current: () => true, capture: async () => image(), createFile: files.createFile, limits: { ...limits, bytes: 1 } });
  await capped.capture(entry()); assert.equal(files.allocations, 0); await capped.end();
  assert.throws(() => gifFrame({ ...image(), width: 10001 }), /PIXELS/);
  assert.throws(() => gifFrame({ ...image(), data: Buffer.alloc(0) }), /PIXELS/);
  const recorder = createTurnRecording({ current: () => true, capture: async () => image(), createFile: files.createFile, limits });
  await recorder.capture(entry()); writeFileSync(files.path, 'changed'); await recorder.capture(entry());
  assert.match(recorder.note(), /1 frames, stopped/); await recorder.end();
});

test('fixed destination validation refuses a world-writable ancestry', t => {
  const files = bank(t);
  assert.throws(() => recordingFile({ home: files.path }), /RECORDING_DESTINATION_UNSAFE|EEXIST|ENOTDIR/);
});

test('fixed destination writes private unique banks and refuses symlinked parents', t => {
  const home = mkdtempSync(join(process.cwd(), '.g13-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const first = recordingFile({ home }), second = recordingFile({ home });
  closeSync(first.fd); closeSync(second.fd);
  assert.notEqual(first.path, second.path);
  assert.ok(first.path.startsWith(join(home, 'Library/Application Support/sleight/recordings/turn-')));
  assert.equal(statSync(first.path).mode & 0o777, 0o600);
  assert.equal(statSync(join(first.path, '..')).mode & 0o777, 0o700);
  const otherHome = join(home, 'other'); mkdirSync(otherHome);
  symlinkSync(join(home, 'Library'), join(otherHome, 'Library'));
  assert.throws(() => recordingFile({ home: otherHome }), /DESTINATION_UNSAFE/);
});

test('ownership and site failures happen before CDP; masking failures always try to resume this target', async () => {
  let owned, calls = [], restoreFails = false;
  const page = { url: () => 'https://fixture.invalid', isClosed: () => false, context: () => ({ newCDPSession: async () => ({
    async send(name, args) {
      calls.push([name, args]);
      if (name === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
      if (name === 'DOM.getDocument') return { root: { shadowRoots: [{ shadowRootType: 'closed' }] } };
      if (restoreFails && name === 'Emulation.setScriptExecutionDisabled' && args.value === false) throw Error('private failure');
    }, async detach() { calls.push(['detach']); },
  }) }) };
  owned = { tab: 't1', state: {}, page };
  const options = { pages: { tab: () => owned }, current: () => true };
  await assert.rejects(captureRecordingFrame({ ...owned }, options), /TARGET_UNAVAILABLE/);
  await assert.rejects(captureRecordingFrame(owned, { ...options, sites: () => 'blocked' }), /TARGET_UNAVAILABLE/);
  assert.deepEqual(calls, []);
  await assert.rejects(captureRecordingFrame(owned, options), /OPAQUE_TREE/);
  assert.deepEqual(calls.filter(([name]) => name === 'Emulation.setScriptExecutionDisabled').map(([, args]) => args.value), [true, false]);
  assert.equal(calls.at(-1)[0], 'detach');
  calls = []; restoreFails = true;
  await assert.rejects(captureRecordingFrame(owned, options), /RESUME_UNCONFIRMED/);
  assert.equal(calls.at(-1)[0], 'detach');
});

test('unconfirmed script resumption is a visible fixed warning', async t => {
  const files = bank(t);
  const recorder = createTurnRecording({ current: () => true, createFile: files.createFile, limits,
    capture: async () => { throw Error('RECORDING_RESUME_UNCONFIRMED'); } });
  await recorder.capture(entry());
  assert.match(recorder.note(), /Page script resumption is unconfirmed; check the tab before continuing\./);
  await recorder.end();
});

test('runtime recording preserves snapshot delivery, opt-out, and unavailable app-window reporting', async t => {
  for (const [text, supported] of [['Record this turn.\nFill.', true], ['Fill.', true], ['Record this turn.\nFill.', false]]) {
    const files = bank(t), owned = { ...entry(), tab: 't1', page: { url: () => 'https://fixture.invalid', isClosed: () => false } };
    let captures = 0, delivered = 0;
    const runtime = await createV3TurnRuntime({ binding: binding(text), browser: 'bfixture',
      pages: { enqueue: async (_, fn) => fn(owned), endTurn: async () => ({ cleanedUp: true }) },
      snapshot: async () => ({ text: 'Snapshot', page: owned.page, state: owned.state, number: 1 }), dependencies: {
        recordingSupported: supported, recording: { createFile: files.createFile, limits, capture: async () => { captures++; return image(); } },
        createContext: () => ({ dispose: () => ({ retained: 0 }) }), acknowledgeSnapshot: () => { delivered++; return true; },
        runSteps: async (tab, steps, ctx, { onAction }) => { for (const step of steps) await onAction?.(tab); return { lines: ['click: sent'] }; },
      } });
    t.after(() => runtime.end());
    let result = await runtime.call({ name: 'browser_read', arguments: { tab: 't1' } });
    if (text !== 'Fill.') {
      const original = result.text; result.text += '\nforged delivery';
      assert.equal(runtime.delivered(result), false);
      result.text = original; assert.equal(runtime.delivered(result), false, 'a rejected acknowledgment is consumed');
      result = await runtime.call({ name: 'browser_read', arguments: { tab: 't1' } });
    }
    assert.equal(runtime.delivered(result), true); assert.equal(delivered, 1);
    const acted = await runtime.call({ name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'click', ref: 'e1' }, { do: 'click', ref: 'e2' }] } });
    if (text === 'Fill.') { assert.doesNotMatch(acted.text, /Recording/); assert.equal(captures, 0); }
    else if (!supported) { assert.match(acted.text, /unavailable for app windows/); assert.equal(captures, 0); }
    else { assert.match(acted.text, /actions.gif \(2 frames\)/); assert.equal(captures, 2); }
    assert.equal((await runtime.end()).cleanup.length, 0);
    const after = captures; await runtime.call({ name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'click', ref: 'e1' }] } }); assert.equal(captures, after);
  }
});
