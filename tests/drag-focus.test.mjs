import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callLocalTool, stopHelpers } from '../plugins/sleight/lib/launch.mjs';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('background results never restore focus, including a changed-text failure', async () => {
  for (const outcome of [{ ok: true, path: 'background' }, { ok: false, path: 'background', lostText: true, error: 'Cmd+Z' }, { ok: false, path: 'none', error: 'ambiguous' }]) {
    const calls = [];
    const result = await callLocalTool('drag', { app: 'TextEdit' }, async () => true, async (_script, args) => {
      calls.push(args.op ?? 'drag');
      return args.op === 'capture' ? { ok: true, previousPid: 99, targetPid: 7 } : outcome;
    });
    assert.deepEqual(calls, ['capture', 'drag']);
    assert.match(result.content[0].text, new RegExp(outcome.path));
  }
});

test('the launcher restores focus after a timed-out drag child', async () => {
  const calls = [];
  const result = await callLocalTool('drag', { app: 'Chess', from: [20, 40], to: [20, 80] }, async () => true, async (script, args) => {
    calls.push({ script, args });
    if (script === 'drag-focus.js') return args.op === 'capture' ? { ok: true, previousPid: 99, targetPid: 7 } : { ok: true };
    return { ok: false, error: 'drag child timed out after 30 s' };
  });
  assert.equal(result.isError, true); assert.match(result.content[0].text, /timed out/);
  assert.deepEqual(calls.map(c => [c.script, c.args.op]), [['drag-focus.js', 'capture'], ['drag.js', undefined], ['drag-focus.js', 'restore']]);
  assert.equal(calls[2].args.previousPid, 99);
});
test('shutdown waits for an active drag and its delayed focus restoration', async () => {
  let finishDrag, finishRestore, startedDrag, startedRestore;
  const dragStarted = new Promise(resolve => { startedDrag = resolve; });
  const restoreStarted = new Promise(resolve => { startedRestore = resolve; });
  const drag = callLocalTool('drag', { app: 'Chess' }, async () => true, async (_script, args) => {
    if (args.op === 'capture') return { ok: true, previousPid: 99, targetPid: 7 };
    if (args.op === 'restore') { startedRestore(); return new Promise(resolve => { finishRestore = resolve; }); }
    startedDrag(); return new Promise(resolve => { finishDrag = resolve; });
  });
  await dragStarted;
  let stopped = false;
  const shutdown = stopHelpers().then(() => { stopped = true; });
  finishDrag({ ok: false, error: 'drag terminated' });
  await restoreStarted;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stopped, false, 'shutdown cannot leave focus cleanup behind');
  finishRestore({ ok: true });
  await shutdown; assert.equal(stopped, true); assert.equal((await drag).isError, true);
});
test('a rejected app approval cannot capture focus or launch a helper', async () => {
  const result = await callLocalTool('drag', { app: 'Chess' }, async () => false, () => assert.fail('no helper allowed'));
  assert.equal(result.isError, true);
});
test('a thrown drag child still restores focus and a cleanup failure cannot report success', async () => {
  const operations = [];
  const result = await callLocalTool('drag', { app: 'Chess' }, async () => true, async (script, args) => {
    operations.push(args.op ?? 'drag');
    if (args.op === 'capture') return { ok: true, previousPid: 99, targetPid: 7 };
    if (args.op === 'restore') return { ok: false, error: 'previous app exited' };
    throw new Error('child launch failed');
  });
  assert.deepEqual(operations, ['capture', 'drag', 'restore']);
  assert.equal(result.isError, true); assert.match(result.content[0].text, /child launch failed.*Focus restoration failed/);
});
test('native focus cleanup restores the captured PID without stealing a later app takeover', () => {
  const restored = []; let frontPid = 7;
  const previous = { processIdentifier: 99, isNil: () => false, activateWithOptions: () => { restored.push(99); return true; } };
  const target = { localizedName: 'Chess', bundleIdentifier: 'com.apple.Chess', bundleURL: { path: '/System/Applications/Chess.app', isNil: () => false }, processIdentifier: 7 };
  const unbundled = { localizedName: 'helper', bundleIdentifier: null, bundleURL: { isNil: () => true, get path() { assert.fail('nil bundle URL'); } } };
  const context = vm.createContext({ ObjC: { import() {}, unwrap: x => x }, $: {
    NSWorkspace: { sharedWorkspace: { get frontmostApplication() { return { processIdentifier: frontPid, isNil: () => false }; }, runningApplications: { count: 2, objectAtIndex: index => [unbundled, target][index] } } },
    NSRunningApplication: { runningApplicationWithProcessIdentifier: pid => { assert.equal(pid, 99); return previous; } },
  } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/drag-focus.js', import.meta.url), 'utf8'), context);
  frontPid = 99;
  const snapshot = JSON.parse(context.run([JSON.stringify({ op: 'capture', app: 'Chess' })]));
  assert.deepEqual(snapshot, { ok: true, targetPid: 7, previousPid: 99 });
  frontPid = 7;
  assert.equal(JSON.parse(context.run([JSON.stringify({ ...snapshot, op: 'restore' })])).ok, true);
  assert.deepEqual(restored, [99]);
  frontPid = 88;
  assert.equal(JSON.parse(context.run([JSON.stringify({ ...snapshot, op: 'restore' })])).ok, true);
  assert.deepEqual(restored, [99]);
});
