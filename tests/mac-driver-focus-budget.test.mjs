import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';

test('both AX adapters use the shared cap and typing passes its measured cleanup reserve', async () => {
  const focus = await readFile(new URL('../plugins/sleight/lib/mac-driver/native/DriverFocusBelief.swift', import.meta.url), 'utf8');
  for (const target of ['ax', 'app']) {
    assert.ok(focus.includes(`AXUIElementSetMessagingTimeout(${target}, Float(messagingBudget(budget)))`));
  }
  const keyboard = await readFile(new URL('../plugins/sleight/lib/mac-driver/native/DriverKeyboard.swift', import.meta.url), 'utf8');
  assert.match(keyboard, /cleanupReserve: \{ largestCleanupMs \/ 1000 \}/);
});

test('focus AX budgets and clear retries use fake time without desktop access', {
  skip: process.platform !== 'darwin', timeout: 300000,
}, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-focus-budget-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'budget.swift'), binary = join(root, 'budget');
  let composed = await macDriverSource();
  for (const [from, to] of [
    ['min(0.1, budget)', 'min(gl7Mutation == "cap-10" ? 0.01 : 0.1, budget)'],
    ['let reserve = cleaning ? 0 :', 'let reserve = cleaning || gl7Mutation == "no-reserve" ? 0 :'],
    ['min(remaining(), activeBudget, until.map', 'min(gl7Mutation == "no-call-bound" ? 30 : remaining(), activeBudget, until.map'],
    ['let activeBudget = activeStarted.map', 'let activeBudget = gl7Mutation == "no-interval-bound" ? 30 : activeStarted.map'],
    ['try observe(readBudget(until: end, cleaning: true))', 'let staleBudget = readBudget(until: end, cleaning: true); try observe(staleBudget)'],
    ['providers.belief(pid, readBudget(until: end, cleaning: true))', 'providers.belief(pid, gl7Mutation == "stale-budget" ? staleBudget : readBudget(until: end, cleaning: true))'],
    ['where fault.code == "KEY_FOCUS_UNAVAILABLE" && fault.message == "KEY_FOCUS_UNAVAILABLE step=belief-timeout"',
      'where gl7Mutation != "no-retry" && fault.code == "KEY_FOCUS_UNAVAILABLE" && fault.message == "KEY_FOCUS_UNAVAILABLE step=belief-timeout"'],
  ]) {
    assert.equal(composed.split(from).length, 2, `one mutation seam: ${from}`);
    composed = composed.replace(from, to);
  }
  const at = composed.lastIndexOf('\ndriverMain()');
  assert.notEqual(at, -1);
  await writeFile(source, 'let gl7Mutation = CommandLine.arguments.dropFirst().first ?? "none"\n' + composed.slice(0, at) + '\n' +
    await readFile(new URL('./fixtures/mac-driver-focus-budget.swift', import.meta.url), 'utf8'));
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), source, '-o', binary], {
    killSignal: 'SIGKILL', encoding: 'utf8', timeout: 240000, maxBuffer: 65536,
  });
  assert.equal(compile.status, 0, compile.stderr);
  t.diagnostic(`budgetBinaryBytes=${(await stat(binary)).size}`);
  const run = (control, mutation = 'none') => {
    const child = spawnSync(binary, [mutation], { input: JSON.stringify(control) + '\n',
      killSignal: 'SIGKILL', encoding: 'utf8', timeout: 20000, maxBuffer: 65536 });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  const passes = r => { assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.keys, 1); assert.equal(r.cleared, true); };
  const bounded = (r, limit = 400) => assert.ok(r.traces[0].fakeActiveMs <= limit + 0.000001, JSON.stringify(r));
  for (const phase of ['initialSnapshotMs', 'activeSnapshotMs', 'activeBeliefMs', 'clearSnapshotMs', 'clearBeliefMs', 'restoreSnapshotMs']) {
    await t.test(`${phase} taking 15 ms succeeds`, () => passes(run({ [phase]: 15 })));
  }
  await t.test('a 120 ms belief read fails at the 100 ms cap before input', () => {
    const r = run({ activeBeliefMs: 120 });
    assert.equal(r.ok, false); assert.equal(r.keys, 0); assert.equal(r.error.message, 'KEY_FOCUS_UNAVAILABLE step=belief-timeout');
    assert.equal(r.elapsedMs, 100); assert.equal(r.cleared, true); bounded(r);
  });
  const retry = { clearBeliefMs: 15, clearTimeouts: 1 };
  await t.test('a transient clear timeout retries and proves cleanup', () => {
    const r = run(retry); passes(r);
    assert.equal(r.reads.filter(x => x.phase === 'clear' && x.kind === 'belief').length, 2);
    assert.equal(r.elapsedMs, 40); bounded(r);
  });
  await t.test('persistent clear timeouts stop within the original 150 ms poll', () => {
    const r = run({ clearBeliefMs: 120 });
    assert.equal(r.ok, false); assert.equal(r.error.unhealthy, true); assert.equal(r.cleared, false);
    assert.ok(r.elapsedMs <= 150.000001, JSON.stringify(r));
    assert.equal(r.reads.filter(x => x.phase === 'clear' && x.kind === 'belief').length, 2); bounded(r);
  });
  const cap = { bodyMs: 280, clearSnapshotMs: 70, clearBeliefMs: 120 };
  await t.test('snapshot time is deducted before a clear belief read at the 400 ms cap', () => {
    const r = run(cap);
    assert.equal(r.ok, false); bounded(r);
    const read = r.reads.find(x => x.phase === 'clear' && x.kind === 'belief');
    assert.ok(Math.abs(read.budgetMs - 50) < 0.000001, JSON.stringify(r));
  });
  const reserve = { bodyMs: 350, bodySnapshotMs: 120, clearBeliefMs: 15 };
  const reserved = r => {
    const read = r.reads.find(x => x.phase === 'body');
    assert.ok(Math.abs(read.budgetMs - 30) < 0.000001, JSON.stringify(r));
    assert.equal(r.cleared, true); bounded(r);
  };
  await t.test('an ordinary snapshot leaves 20 ms for cleanup', () => reserved(run(reserve)));
  await t.test('an ordinary snapshot retains the measured 70 ms cleanup reserve', () => {
    const r = run({ bodyMs: 300, bodySnapshotMs: 120, reserveMs: 70 });
    assert.ok(Math.abs(r.reads.find(x => x.phase === 'body').budgetMs - 30) < 0.000001, JSON.stringify(r)); bounded(r);
  });
  const call = { callMs: 90, bodyMs: 70, clearSnapshotMs: 15, clearBeliefMs: 15 };
  const callBound = r => assert.ok(r.elapsedMs <= 90.000001, JSON.stringify(r));
  await t.test('cleanup recomputes the remaining call budget before every read', () => callBound(run(call)));
  await t.test('pointer sampling keeps layer, bounds, order and missing-hit behavior', () => {
    assert.deepEqual(run({ pointer: true }), { hit: 42, miss: null });
  });
  await t.test('offline person guard micro-measurement uses 1000 fake windows', () => {
    const r = run({ micro: true });
    assert.equal(r.matches, 6000);
    for (const times of Object.values(r.msPerGuard)) assert.ok(times.every(x => Number.isFinite(x) && x >= 0));
    t.diagnostic(JSON.stringify(r));
  });
  for (const [mutation, control, oracle] of [
    ['cap-10', { activeBeliefMs: 15 }, passes],
    ['no-retry', retry, passes],
    ['stale-budget', cap, bounded],
    ['no-interval-bound', cap, bounded],
    ['no-reserve', reserve, reserved],
    ['no-call-bound', call, callBound],
  ]) await t.test(`broken variant ${mutation} fails the behavioral oracle`, () => {
    assert.throws(() => oracle(run(control, mutation)), assert.AssertionError);
  });
});
