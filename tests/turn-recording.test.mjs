import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTurnRecording, gifFrame, gifHeader, recordingFile } from '../plugins/sleight/lib/turn-recording.mjs';
import { createV3TurnBinding, recordingPermission } from '../plugins/sleight/lib/direct-browser/v3-context.mjs';
import { createV3TurnRuntime } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { captureRecordingFrame, maskRecordingPixels } from '../plugins/sleight/lib/direct-browser/recording.mjs';

const image = (r = 255, g = 0, b = 0) => ({ width: 2, height: 2, data: Buffer.from(Array.from({ length: 4 }, () => [r, g, b, 255]).flat()) });
const limits = { width: 4, height: 4, frames: 3, bytes: 4096 };
function bank(t) {
  const folder = mkdtempSync(join(tmpdir(), 'sleight-g13-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'actions.gif'); let allocations = 0;
  return { path, get allocations() { return allocations; }, createFile() { allocations++; return { path, fd: openSync(path, 'wx', 0o600) }; } };
}
const entry = () => ({ state: {}, page: { isClosed: () => false } });
const rootAccess = getRoot => ({ _connection: { toImpl: () => ({ mainFrame: () => ({ utilityContext: async () => ({ world: 'utility', evaluateExpressionHandle: getRoot }) }) }) } });
const binding = (text, current = () => true) => createV3TurnBinding({ source: 'user', session: 'fixture', turn: 'turn', id: 'user', text }, current);

test('only a leading literal directive in this authenticated, current turn permits recording', () => {
  for (const text of ['Record this turn.', 'Record this turn.\nFill the form.', 'Record this turn.\r\nClick Next.', 'Record this turn. Fill the form.']) assert.equal(recordingPermission(binding(text))(), true);
  for (const text of ['', 'Do not Record this turn.', '"Record this turn."', 'Page says: Record this turn.',
    'Task\nRecord this turn.', 'Record this turn.Also pay.', 'record this turn.', ' Record this turn.']) assert.equal(recordingPermission(binding(text))(), false, text);
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

test('capture failures skip and destination failures stop without leaking their messages or costing an action', async t => {
  const files = bank(t); let calls = 0;
  const recorder = createTurnRecording({ current: () => true, capture: async () => { calls++; throw Error('private page value'); }, createFile: files.createFile, limits });
  await recorder.capture(entry()); await recorder.capture(entry());
  assert.equal(calls, 2); assert.equal(files.allocations, 0); assert.match(recorder.note(), /2 skipped/); assert.doesNotMatch(recorder.note(), /private page value/);
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
      if (name === 'Page.getLayoutMetrics') return { cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
      if (name === 'Runtime.evaluate') return restoreFails ? {} : { result: { value: 1 } };
      if (restoreFails && name === 'Emulation.setScriptExecutionDisabled' && args.value === false) throw Error('private failure');
    }, async detach() { calls.push(['detach']); },
  }) }), ...rootAccess(async () => { throw Error('RECORDING_TREE_LIMIT'); }) };
  owned = { tab: 't1', state: {}, page };
  const options = { pages: { tab: () => owned }, current: () => true };
  await assert.rejects(captureRecordingFrame({ ...owned }, options), /TARGET_UNAVAILABLE/);
  await assert.rejects(captureRecordingFrame(owned, { ...options, sites: () => 'blocked' }), /TARGET_UNAVAILABLE/);
  assert.deepEqual(calls, []);
  await assert.rejects(captureRecordingFrame(owned, options), /TREE_LIMIT/);
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
  assert.match(recorder.note(), /Page script resumption is unconfirmed; further recording frames are blocked for this turn\. Browser actions remain available\./);
  await recorder.end();
});

test('transient frame failures skip without ending the turn and never echo their contents', async t => {
  const files = bank(t); let calls = 0;
  const recorder = createTurnRecording({ current: () => true, createFile: files.createFile, limits,
    capture: async () => { if (++calls < 3) throw Error('RECORDING_MOTION_UNAVAILABLE: private text'); return image(); } });
  await recorder.capture(entry()); await recorder.capture(entry()); await recorder.capture(entry());
  assert.equal(calls, 3);
  assert.match(recorder.note(), /1 frames, 2 skipped/);
  assert.doesNotMatch(recorder.note(), /private text/);
  await recorder.end();
});

test('a failed first write removes the empty recording', async t => {
  const files = bank(t);
  const recorder = createTurnRecording({ current: () => true, capture: async () => image(), limits,
    createFile() { const file = files.createFile(); closeSync(file.fd); return file; } });
  await recorder.capture(entry()); await recorder.end();
  assert.equal(existsSync(files.path), false);
  assert.equal(existsSync(join(files.path, '..')), false);
});

test('a recording inside the system home reports a tilde path and per-frame processing times', async t => {
  const home = userInfo().homedir;
  if (!process.cwd().startsWith(home + '/')) return t.skip('checkout is outside the system home');
  const folder = mkdtempSync(join(process.cwd(), '.g13-note-')), path = join(folder, 'actions.gif');
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const recorder = createTurnRecording({ current: () => true, capture: async () => ({ ...image(), decodeMaskMs: 1.25 }), limits,
    createFile: () => ({ path, fd: openSync(path, 'wx', 0o600) }) });
  await recorder.capture(entry()); await recorder.end();
  assert.ok(recorder.note().startsWith('Recording: ~/' + path.slice(home.length + 1)));
  assert.equal(recorder.note().includes(home), false);
  assert.match(recorder.note(), /Pixel processing per frame.*1\.3\+/);
});

test('an attach that resolves after its deadline is detached without freezing scripts', { timeout: 6000 }, async () => {
  let release, detached = false;
  const page = { url: () => 'https://fixture.invalid', isClosed: () => false,
    context: () => ({ newCDPSession: () => new Promise(resolve => { release = resolve; }) }) };
  const owned = { tab: 't1', state: {}, page };
  await assert.rejects(captureRecordingFrame(owned, { pages: { tab: () => owned }, current: () => true }), /RECORDING_TIMEOUT/);
  release({ send: () => assert.fail('late session must never freeze scripts'), detach: async () => { detached = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(detached, true);
});

test('pruning starts asynchronously after the first frame and keeps fresh or linked banks', async t => {
  const home = mkdtempSync(join(process.cwd(), '.g13-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const old = recordingFile({ home }), fresh = recordingFile({ home });
  closeSync(old.fd); closeSync(fresh.fd);
  const past = new Date(Date.now() - 31 * 86400000);
  utimesSync(old.path, past, past); utimesSync(join(old.path, '..'), past, past);
  const root = join(old.path, '../..');
  const outside = join(home, 'outside'); mkdirSync(outside);
  writeFileSync(join(outside, 'actions.gif'), 'keep');
  symlinkSync(outside, join(root, 'turn-link'));
  const recorder = createTurnRecording({ current: () => true, capture: async () => image(), limits, createFile: () => recordingFile({ home }) });
  assert.equal(existsSync(old.path), true, 'arming does not prune');
  await recorder.capture(entry()); await recorder.end();
  assert.equal(existsSync(old.path), false);
  assert.equal(existsSync(fresh.path), true);
  assert.equal(readFileSync(join(outside, 'actions.gif'), 'utf8'), 'keep');
});

for (const stuck of ['attach', 'disable', 'Page.getLayoutMetrics', 'utility read', 'resume', 'detach']) {
  test(`recording bounds a stalled ${stuck} and completes cleanup`, { timeout: 6000 }, async () => {
    const sent = [], forever = new Promise(() => {});
    const cdp = { async send(name, args) {
      const step = name === 'Emulation.setScriptExecutionDisabled' ? args.value ? 'disable' : 'resume' : name;
      sent.push(step);
      if (step === stuck) return forever;
      if (step === 'Page.getLayoutMetrics') return { cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
      if (step === 'Runtime.evaluate') return stuck === 'resume' ? forever : { result: { value: 1 } };
    }, async detach() { sent.push('detach'); if (stuck === 'detach') return forever; } };
    const page = { url: () => 'https://fixture.invalid', isClosed: () => false,
      context: () => ({ newCDPSession: () => stuck === 'attach' ? forever : Promise.resolve(cdp) }),
      ...rootAccess(() => stuck === 'utility read' ? forever : Promise.reject(Error('RECORDING_TREE_LIMIT'))) };
    const owned = { tab: 't1', state: {}, page };
    const start = performance.now();
    await assert.rejects(captureRecordingFrame(owned, { pages: { tab: () => owned }, current: () => true }),
      stuck === 'resume' ? /RESUME_UNCONFIRMED/ : /RECORDING_/);
    assert.ok(performance.now() - start < 4000, 'recording returned within its bounded cleanup budget');
    if (stuck !== 'attach') {
      assert.ok(sent.includes('resume'), 'even a timed-out disable is followed by a resume attempt');
      assert.equal(sent.at(-1), 'detach');
    }
  });
}

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
    else if (!supported) { assert.doesNotMatch(acted.text, /Recording/); assert.equal(captures, 0); }
    else { assert.doesNotMatch(acted.text, /actions.gif|Recording/); assert.equal(captures, 2); }
    const ended = await runtime.end();
    assert.equal(ended.cleanup.length, 0);
    if (supported && text !== 'Fill.') assert.match(ended.recording, /actions.gif \(2 frames\)/);
    assert.equal((await runtime.end()).recording, undefined, 'the saved path appears only on the first end receipt');
    const after = captures; await runtime.call({ name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'click', ref: 'e1' }] } }); assert.equal(captures, after);
  }
});

for (const mode of ['slow acknowledgment', 'retry', 'probe failure', 'acknowledgment failure']) test(`script resume: ${mode}`, { timeout: 6000 }, async () => {
  let resumes = 0, probes = 0;
  const cdp = { async send(name, args) {
    if (name === 'Page.getLayoutMetrics') return { cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
    if (name === 'Emulation.setScriptExecutionDisabled' && !args.value) {
      resumes++;
      if (mode === 'slow acknowledgment') await new Promise(r => setTimeout(r, 350));
      if (mode === 'acknowledgment failure' || mode === 'retry' && resumes === 1) throw Error('ack missed');
    }
    if (name === 'Runtime.evaluate') {
      probes++;
      assert.equal(args.expression, '1');
      if (mode === 'probe failure' || mode === 'retry' && probes === 1) throw Error('probe missed');
      return { result: { value: 1 } };
    }
  }, async detach() {} };
  const page = { isClosed: () => false, url: () => 'https://fixture.invalid', context: () => ({ newCDPSession: async () => cdp }),
    ...rootAccess(async () => { throw Error('RECORDING_TREE_LIMIT'); }) };
  const owned = { page, tab: 't1', state: {} };
  await assert.rejects(captureRecordingFrame(owned, { pages: { tab: () => owned }, current: () => true }),
    mode.endsWith('failure') ? /RESUME_UNCONFIRMED/ : /TREE_LIMIT/);
  assert.equal(resumes, mode === 'slow acknowledgment' ? 1 : 2);
  assert.equal(probes, resumes);
});

test('unconfirmed resume blocks only recording frames and returns no input stop signal', async t => {
  let captures = 0;
  const files = bank(t), recorder = createTurnRecording({ current: () => true, createFile: files.createFile,
    capture: async () => { captures++; throw Error('RECORDING_RESUME_UNCONFIRMED'); } });
  assert.equal(await recorder.capture(entry()), undefined);
  assert.equal(await recorder.capture(entry()), undefined);
  assert.equal(captures, 1);
  assert.equal(recorder.blocked(), true);
  assert.match(recorder.warning(), /Browser actions remain available/);
  await recorder.end();
});

test('a utility root acquired after its deadline is disposed after scripts resume', { timeout: 6000 }, async () => {
  let release, disposed = 0, resumed = 0;
  const cdp = { async send(name, args) {
    if (name === 'Page.getLayoutMetrics') return { cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
    if (name === 'Emulation.setScriptExecutionDisabled' && !args.value) resumed++;
    if (name === 'Runtime.evaluate') return { result: { value: 1 } };
  }, async detach() {} };
  const page = { isClosed: () => false, url: () => 'https://fixture.invalid', context: () => ({ newCDPSession: async () => cdp }),
    ...rootAccess(() => new Promise(resolve => { release = resolve; })) };
  const owned = { page, tab: 't1', state: {} };
  await assert.rejects(captureRecordingFrame(owned, { pages: { tab: () => owned }, current: () => true }), /RECORDING_TIMEOUT/);
  assert.equal(resumed, 1);
  release({ async dispose() { disposed++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposed, 1);
});

test('two thousand overlapping field masks use bounded pixel painting', { timeout: 6000 }, () => {
  const width = 400, height = 300, frame = { width, height, data: Buffer.alloc(width * height * 4, 255) };
  const fields = Array.from({ length: 2000 }, () => [0, 0, width, height]);
  const start = performance.now();
  maskRecordingPixels(frame, { fields, opaque: [] });
  assert.ok(performance.now() - start < 2000, 'overlap does not multiply pixel painting by field count');
  for (let at = 0; at < frame.data.length; at += 4) {
    assert.equal(frame.data[at] + frame.data[at + 1] + frame.data[at + 2], 0);
    assert.equal(frame.data[at + 3], 255);
  }
});
