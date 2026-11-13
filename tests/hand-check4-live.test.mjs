import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertIdle, settleIdle, bankTasks, check4Markdown, hostCollectionConfirmed } from '../bench/hand/check4-live.mjs';
import { check4Plan } from '../bench/hand/check4.mjs';
import { observerSource } from '../bench/hand/check4-build.mjs';
import { STAGE_BUDGET } from '../bench/hand/stage-cost.mjs';
import { check4HostSpec, ownedHostCollection, check4HandPolicy } from '../bench/hand/check4-server.mjs';
import { EventEmitter } from 'node:events';

test('owner-return boundary requires known HID idle of at least 30 seconds', () => {
  for (const value of [undefined, null, NaN, 0, 29.999]) assert.throws(() => assertIdle(value), /needs 30 s/);
  assert.doesNotThrow(() => assertIdle(30));
});
function clock() { let t = 0; return { now: () => t, wait: async ms => { t += ms; } }; }
test('a one-off posted reset is waited out: idle climbs back past 30 s', async () => {
  const c = clock(), reset = 5000;
  const result = await settleIdle({ read: async () => (c.now() - reset) / 1000, ...c });
  assert.ok(result.waitedMs >= 35000 && result.waitedMs < 120000, JSON.stringify(result));
});
test('a person who keeps resetting idle stops the run at the limit', async () => {
  const c = clock();
  await assert.rejects(settleIdle({ read: async () => (c.now() % 10000) / 1000, ...c }), /owner-return guard: HID idle/);
  assert.ok(c.now() >= 120000);
});
test('an unknown idle read never passes and an abort stops the wait', async () => {
  const c = clock();
  await assert.rejects(settleIdle({ read: async () => undefined, ...c }), /unknown/);
  const controller = new AbortController(); controller.abort(Error('stop'));
  await assert.rejects(settleIdle({ read: async () => 0, signal: controller.signal, ...clock() }), /stop/);
});
test('check 4 no longer asserts idle inside a task, only at its boundaries', () => {
  const source = readFileSync(new URL('../bench/hand/check4-live.mjs', import.meta.url), 'utf8');
  const observe = source.slice(source.indexOf('const observe = async'), source.indexOf('try {', source.indexOf('const observe = async') + 40));
  assert.doesNotMatch(observe, /assertIdle|idleSeconds/);
  assert.match(source, /settleIdle\(\{ read: idleSeconds, signal: controller\.signal \}\)/);
});
test('private character policy forces stage art and refuses every settings writer', async () => {
  const policy = check4HandPolicy('stage-bench-art');
  assert.deepEqual(policy.setting(), { enabled: true, style: 'sprite', character: 'stage-bench-art', capture: 'hidden', perch: true,
    size: 'stage', stageAttention: false, lines: 'off', narration: 'off', record_runs: false });
  assert.equal(policy.cursorPicker, null); assert.equal(policy.permissions, null); assert.equal(policy.usage, null);
  await assert.rejects(policy.setHand(false), /PRIVATE_SETTINGS/);
  assert.equal(policy.setting().enabled, true);
});
test('private mabel host binds the private character root without reading installed character settings', () => {
  const spec = check4HostSpec({ binary: '/fixture/consent-host', character: '/fixture/characters/stage-bench-art',
    status: '/fixture/status.json', trace: '/fixture/trace.json' }, { capture: 'hidden', consent: true, cursorStyle: 'sprite' }, {});
  assert.equal(spec.options.env.SLEIGHT_CURSOR_TEST, '1');
  assert.equal(spec.options.env.SLEIGHT_CURSOR_CHARACTERS_ROOT, '/fixture/characters');
  assert.deepEqual(spec.args, ['--hand', '--capture=hidden', '--cursor-style=sprite', '--consent']);
});
test('server exit waits for its actual owned host close receipt', async () => {
  let receipt, exited;
  const child = new EventEmitter(); child.pid = 42; child.stdin = { end() {} }; child.kill = () => {};
  const collection = ownedHostCollection({ receipt: row => { receipt = row; }, exit: code => { exited = code; }, graceMs: 20 });
  collection.track(child);
  const done = collection.shutdown(0);
  assert.equal(receipt, undefined); assert.equal(exited, undefined);
  child.emit('close', 0, null); await done;
  assert.equal(receipt.collected, true); assert.equal(exited, 0);
});
test('an uncollected host cannot produce a successful server receipt', async () => {
  let receipt, exited; const signals = [];
  const child = new EventEmitter(); child.pid = 42; child.stdin = { end() {} }; child.kill = signal => signals.push(signal);
  const collection = ownedHostCollection({ receipt: row => { receipt = row; }, exit: code => { exited = code; }, graceMs: 2 });
  collection.track(child); await collection.shutdown(0);
  assert.equal(receipt.collected, false); assert.equal(exited, 1); assert.ok(signals.includes('SIGKILL'));
});
test('a safely cleaned setup failure before server startup can retry without a host receipt', () => {
  assert.equal(hostCollectionConfirmed(true, false, null), true);
  assert.equal(hostCollectionConfirmed(false, false, null), false);
  assert.equal(hostCollectionConfirmed(true, true, null), false);
  assert.equal(hostCollectionConfirmed(true, true, { collected: false }), false);
  assert.equal(hostCollectionConfirmed(true, true, { collected: true }), true);
});
test('missing recordings and missing cross-window drag are unmeasured with reasons', () => {
  const tasks = bankTasks({ schema: 'sleight.character-check4-recordings/1', tasks: { 'finder-move': { input: 'fake' } } }, check4Plan({ drive: 'replay' }),
    () => ({ kind: 'native', task: { id: 'finder-move' }, calls: [{ name: 'drag', arguments: { windowId: 7, toWindowId: 7 } }] }));
  assert.match(tasks[0].unavailable, /No recording/);
  assert.match(tasks[1].unavailable, /cross-window drag/);
});
test('Preview without a scroll chooses the explicit native recording fallback and discloses it', () => {
  const bank = { schema: 'sleight.character-check4-recordings/1', tasks: { 'preview-read': { input: 'preview' } }, scrollFallback: { input: 'fallback' } };
  const load = input => ({ kind: 'native', task: { id: input === 'preview' ? 'preview-read' : 'textedit-drag' }, calls: input === 'preview' ? [] : [
    { name: 'js', arguments: { code: 'await app.scroll({direction:"down"})' } },
    ...Array.from({ length: 9 }, () => ({ name: 'js', arguments: {} }))] });
  const task = bankTasks(bank, check4Plan({ drive: 'replay' }), load)[2];
  assert.match(task.note, /preview-read recording has no scroll; replaying textedit-drag/);
  assert.equal(task.recording.task.id, 'textedit-drag');
});
test('a non-native or Office fallback is never admitted', () => {
  const bank = { schema: 'sleight.character-check4-recordings/1', tasks: { 'preview-read': { input: 'preview' } }, scrollFallback: { input: 'fallback' } };
  const task = bankTasks(bank, check4Plan({ drive: 'replay' }), input => ({ kind: 'native', task: { id: input === 'preview' ? 'preview-read' : 'word-edit' },
    calls: input === 'preview' ? [] : [{ name: 'scroll', arguments: {} }] }))[2];
  assert.match(task.unavailable, /allowed native fixture/);
});
test('observer build enables the journal before frames and adds only read-only observation', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  const instrumented = observerSource(source);
  assert.equal(instrumented.replace('check4StartObserver()\n', '').replace('    hand.perch.stage.trace = check4MakeTrace()\n', ''), source);
  assert.throws(() => observerSource('changed'), /seam changed/);
  const host = readFileSync(new URL('../bench/hand/check4-host.swift', import.meta.url), 'utf8');
  assert.match(host, /let stageBenchPointerPosition: CGPoint\? = nil/);
  assert.match(host, /let stageBenchPointerObserved: \(\(\[StageEffect\], Int\?, CGRect\?, Double\) -> Void\)\? = nil/);
});
test('the 160 MiB owner ruling keeps the other published cost and pointer bars beside unmeasured tasks', () => {
  assert.equal(STAGE_BUDGET.rssMiB, 160); assert.equal(STAGE_BUDGET.hostAvgPct, 2.5);
  assert.equal(STAGE_BUDGET.wsAvgPct, 3); assert.equal(STAGE_BUDGET.wsPeakPct, 8);
  assert.equal(STAGE_BUDGET.startupMs, 400); assert.equal(STAGE_BUDGET.decodeMs, 40);
  const markdown = check4Markdown({ tasks: { one: { measured: false, visibleShare: null, verdict: 'unmeasured' } } });
  assert.match(markdown, /unmeasured/); assert.doesNotMatch(markdown, /100\.00%/);
});
test('task markdown reports rung and renderer time beside requested-size visibility', () => {
  const markdown = check4Markdown({ tasks: { one: { measured: true, visibleShare: 0, visibleMs: 0, durationMs: 100,
    requestedSize: 'stage', timeByRungMs: { stage: 0, small: 100, medium: 0, unknown: 0 },
    timeByRendererMs: { stage: 0, 'legacy-perch': 100, unknown: 0 }, verdict: 'fail' } } });
  assert.match(markdown, /Rung time ms/);
  assert.match(markdown, /"small":100/);
  assert.match(markdown, /"legacy-perch":100/);
  assert.match(markdown, /at requested stage size: 0 of 100/);
});
