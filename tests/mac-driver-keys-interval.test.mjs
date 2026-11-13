import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';

test('typing rolls intervals with fake time and retains per-key safety checks', {
  skip: process.platform !== 'darwin', timeout: 300000,
}, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-keyboard-interval-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'interval.swift'), binary = join(root, 'interval');
  let composed = await macDriverSource();
  // Compile the real code once. Each mutation changes one production decision
  // and is selected only by this fixture binary's command-line argument.
  for (const [from, to] of [
    ['if yieldInterval {', 'if gl5Mutation != "no-rollover", yieldInterval {'],
    ['Double(postCount) * (largestGuardMs + largestPostMs)', 'Double(postCount) * ((gl5Mutation == "double-guards" ? 2 : 1) * largestGuardMs + largestPostMs)'],
    ['largestCleanupMs = 20.0', 'largestCleanupMs = gl5Mutation == "deadline-reserve" ? 150.0 : 20.0'],
    ['guard emptyRetries < 1 else', 'guard emptyRetries < (gl5Mutation == "no-retry" ? 0 : gl5Mutation == "extra-retry" ? 2 : 1) else'],
    ['if activeStarted != nil { guardCost', 'if gl5Mutation == "admission-cost" || activeStarted != nil { guardCost'],
    ['if elapsed() > 0.4 {', 'if gl5Mutation != "no-cap", elapsed() > 0.4 {'],
    ['if changed || self.providers.personInputSince(started) {', 'if changed || gl5Mutation != "no-person" && self.providers.personInputSince(started) {'],
    ['if providers.secureInput() {', 'if gl5Mutation != "no-secure" && providers.secureInput() {'],
    ['try stopCheck?()', 'if gl5Mutation != "no-stop" { try stopCheck?() }'],
    ['roots.filter({ $0.same(bound.root) }).count == 1', '(gl5Mutation == "no-root" || roots.filter({ $0.same(bound.root) }).count == 1)'],
    ['reason = try watch.check(quietSeconds: request.isAction ? 1.0 : 0.5, beginInput: waitBeforeAdmission)',
      'reason = try (gl5Mutation == "no-watch" ? nil : watch.check(quietSeconds: request.isAction ? 1.0 : 0.5, beginInput: waitBeforeAdmission))'],
  ]) {
    assert.equal(composed.split(from).length, 2, `one mutation seam: ${from}`);
    composed = composed.replace(from, to);
  }
  const at = composed.lastIndexOf('\ndriverMain()');
  assert.notEqual(at, -1);
  await writeFile(source, 'let gl5Mutation = CommandLine.arguments.dropFirst().first ?? "none"\n' + composed.slice(0, at) + '\n' + await readFile(new URL('./fixtures/mac-driver-keyboard-interval.swift', import.meta.url), 'utf8'));
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), source, '-o', binary], {
    killSignal: 'SIGKILL', encoding: 'utf8', timeout: 240000, maxBuffer: 65536,
  });
  assert.equal(compile.status, 0, compile.stderr);
  t.diagnostic(`intervalBinaryBytes=${(await stat(binary)).size}`);
  const run = (control, mutation = 'none') => {
    const child = spawnSync(binary, [mutation], { input: JSON.stringify(control) + '\n',
      killSignal: 'SIGKILL', encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  const complete = r => {
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.charactersDelivered, 24);
    assert.equal(r.downs, 24); assert.equal(r.ups, 24);
    for (const trace of r.traces) {
      assert.equal(trace.beliefCleared, true);
      assert.ok(trace.fakeActiveMs < 400, JSON.stringify(trace));
    }
  };
  await t.test('the live 65.7 ms admission admits the first capital stroke', () => {
    const r = run({ text: 'S', guardMs: 40, admissionGuardMs: 1.7, activationMs: 25.7, keyMs: 4 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.charactersDelivered, 1);
    assert.equal(r.downs, 1); assert.equal(r.ups, 1);
    assert.equal(r.traces.length, 1);
    assert.ok(r.traces[0].fakeActiveMs < 400);
    t.diagnostic(JSON.stringify({ live: r.traces[0] }));
  });
  await t.test('the estimate includes the full guarded call and post admission', () => {
    const r = run({ guardMs: 40, requestCheckMs: 5, keyMs: 4 });
    complete(r);
    assert.ok(r.traces.length > 1);
    for (const trace of r.traces.slice(1)) {
      assert.ok(Math.abs(trace.finalGuardMs - 55) < 0.001, JSON.stringify(trace));
      assert.ok(Math.abs(trace.estimatedKeyMs - 124) < 0.001, JSON.stringify(trace));
    }
  });
  await t.test('slow pre-activation admission does not feed the per-post estimate', () => {
    const r = run({ text: 'S', guardMs: 40, admissionGuardMs: 200, keyMs: 4 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(Math.abs(r.traces[0].estimatedKeyMs - 164) < 0.001);
    assert.equal(r.traces[0].guardCount, 7); // outside bind, belief, four posts, final
  });
  await t.test('cleanup reserve records deactivation, actual clear poll and restore time', () => {
    const r = run({ text: 'sS'.repeat(12), guardMs: 40, keyMs: 4, clearMs: 25, deactivateMs: 2, restoreMs: 3 });
    complete(r);
    for (const trace of r.traces) assert.ok(Math.abs(trace.cleanupMs - 30) < 0.001);
    assert.ok(r.traces.slice(1).every(trace => trace.cleanupReserveMs >= 29.999));
  });
  await t.test('24 characters at 40 ms per guard complete below 400 ms', () => {
    const r = run({ text: 'sS'.repeat(12), guardMs: 40, keyMs: 4, clearMs: 25 });
    complete(r);
    assert.ok(r.traces.length > 1);
    t.diagnostic(JSON.stringify({ fortyMsIntervals: r.traces.length, maxFakeActiveMs: r.result.fakeActiveMs }));
  });
  await t.test('one slow first admission retries the same stroke in a fresh interval', () => {
    const r = run({ text: 'S', guardMs: 40, keyMs: 4, firstActivationMs: 145 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.downs, 1); assert.equal(r.traces.length, 2);
    assert.ok(r.traces.every(trace => trace.beliefCleared && trace.fakeActiveMs < 400));
  });
  await t.test('two insufficient first admissions fail without a post or third interval', () => {
    const r = run({ text: 'S', guardMs: 40, keyMs: 4, activationMs: 145 });
    assert.equal(r.ok, false);
    assert.equal(r.error.message, 'KEY_FOCUS_UNAVAILABLE step=active-interval');
    assert.equal(r.downs, 0); assert.equal(r.traces.length, 2);
    assert.ok(r.traces.every(trace => trace.beliefCleared));
  });
  for (const [control, code] of [['personBetween', 'PERSON_TOOK_OVER'], ['stopBetween', 'USER_STOPPED']]) {
    await t.test(`${control} between empty intervals stops the fresh retry`, () => {
      const r = run({ text: 'S', guardMs: 40, keyMs: 4, firstActivationMs: 145, [control]: true });
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.error.code, code); assert.equal(r.downs, 0);
      assert.equal(r.traces.length, 1);
    });
  }
  await t.test('a 300 ms stall inside a capital stroke fails active-interval', () => {
    const r = run({ text: 'S', guardMs: 40, keyMs: 4, stallAt: 1, stallMs: 300 });
    assert.equal(r.ok, false);
    assert.equal(r.error.message, 'KEY_FOCUS_UNAVAILABLE step=active-interval');
    assert.equal(r.error.charactersDelivered, 1); assert.equal(r.ups, 1);
  });
  const paced = { guardMs: 50, keyMs: 50, clearMs: 100 };
  await t.test('24 characters at 150 ms per key finish with every interval below 400 ms', () => {
    const r = run(paced);
    complete(r);
    assert.ok(r.traces.length > 1);
    for (const trace of r.traces) {
      assert.equal(trace.beliefCleared, true);
      assert.ok(trace.fakeActiveMs < 400, JSON.stringify(trace));
    }
    t.diagnostic(JSON.stringify({ intervals: r.traces.length, maxFakeActiveMs: r.result.fakeActiveMs, guards: r.guards }));
  });
  await t.test('a stall inside a key still fails active-interval and reports the partial count', () => {
    const r = run({ ...paced, stallAt: 3 });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'KEY_FOCUS_UNAVAILABLE');
    assert.equal(r.error.message, 'KEY_FOCUS_UNAVAILABLE step=active-interval');
    assert.equal(r.error.charactersDelivered, 3); assert.equal(r.downs, 3);
    assert.equal(r.ups, 3); assert.equal(r.posts.at(-1), 'deactivate');
  });
  await t.test('150 ms per key spent entirely in guards also completes', () => {
    const r = run({ guardMs: 75 });
    complete(r);
    assert.ok(r.traces.length > 1);
    t.diagnostic(JSON.stringify({ guardOnlyIntervals: r.traces.length, maxFakeActiveMs: r.result.fakeActiveMs }));
  });
  for (const [control, code] of [['personAt', 'PERSON_TOOK_OVER'], ['stopAt', 'USER_STOPPED'],
    ['secureAt', 'SECURE_INPUT_ACTIVE'], ['modifierAt', 'PERSON_HOLDS_MODIFIER']]) {
    await t.test(`${control} at character 7 stops before character 8 and releases the key`, () => {
      const r = run({ ...paced, [control]: 7 });
      assert.equal(r.ok, false);
      assert.equal(r.error.code, code);
      if (code === 'IDENTITY_CHANGED') assert.match(r.error.message, /IDENTITY_CHANGED step=(?:pid|process-start|bounds|keyboard-pid)/);
      assert.equal(r.error.charactersDelivered, 7); assert.equal(r.downs, 7);
      assert.equal(r.ups, 7); assert.equal(r.posts.at(-1), 'deactivate');
      if (control === 'stopAt') {
        assert.ok(r.stopDelayMs <= 100, JSON.stringify(r));
        t.diagnostic(JSON.stringify({ stopDelayMs: r.stopDelayMs }));
      }
    });
  }
  await t.test('the interval guard avoids a fourth full inventory query while typing 24 keys', () => {
    // Read, initial binding and interval binding each census once. A fourth
    // full census loses the window. Target rechecks still see it.
    const r = run({ fastGuard: true, censusTrap: true });
    complete(r);
    assert.equal(r.traces.length, 1);
  });
  await t.test('the interval guard retains the real person watch at every key', () => {
    const r = run({ fastGuard: true, watchAt: 7 });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'PERSON_TOOK_OVER');
    assert.equal(r.error.charactersDelivered, 7); assert.equal(r.downs, 7); assert.equal(r.ups, 7);
  });
  for (const [control, code] of [['rootAt', 'STALE_ELEMENT'], ['pidAt', 'IDENTITY_CHANGED'],
    ['startAt', 'IDENTITY_CHANGED'], ['hiddenAt', 'NO_WINDOWS_AVAILABLE'],
    ['offSpaceAt', 'NO_WINDOWS_AVAILABLE'], ['moveAt', 'IDENTITY_CHANGED']]) {
    await t.test(`the interval guard refuses ${control} without posting another character`, () => {
      const r = run({ fastGuard: true, [control]: 7 });
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.error.code, code);
      assert.equal(r.error.charactersDelivered, 7); assert.equal(r.downs, 7);
    });
  }
  for (const [mutation, control, expected] of [
    ['double-guards', { text: 'S', guardMs: 40, admissionGuardMs: 1.7, activationMs: 25.7, keyMs: 4 }, r => assert.equal(r.ok, true)],
    ['deadline-reserve', { text: 'S', guardMs: 40, admissionGuardMs: 1.7, activationMs: 25.7, keyMs: 4 }, r => assert.equal(r.ok, true)],
    ['admission-cost', { text: 'S', guardMs: 40, admissionGuardMs: 200, keyMs: 4 }, r => assert.equal(r.ok, true)],
    ['no-retry', { text: 'S', guardMs: 40, keyMs: 4, firstActivationMs: 145 }, r => assert.equal(r.ok, true)],
    ['extra-retry', { text: 'S', guardMs: 40, keyMs: 4, activationMs: 145 }, r => assert.equal(r.traces.length, 2)],
    ['no-rollover', { text: 'sS'.repeat(12), guardMs: 40, keyMs: 4, clearMs: 25 }, complete],
    ['no-cap', { ...paced, stallAt: 3 }, r => assert.equal(r.traces[0].fault, 'KEY_FOCUS_UNAVAILABLE step=active-interval')],
    ['no-person', { keyMs: 4, personAt: 7 }, r => assert.equal(r.error?.charactersDelivered, 7)],
    ['no-secure', { ...paced, secureAt: 7 }, r => assert.equal(r.error?.code, 'SECURE_INPUT_ACTIVE')],
    ['no-stop', { ...paced, stopAt: 7 }, r => assert.equal(r.error?.code, 'USER_STOPPED')],
    ['no-root', { fastGuard: true, rootAt: 7 }, r => assert.equal(r.error?.code, 'STALE_ELEMENT')],
    ['no-watch', { fastGuard: true, watchAt: 7 }, r => assert.equal(r.error?.code, 'PERSON_TOOK_OVER')],
  ]) await t.test(`broken variant ${mutation} fails the behavioral oracle`, () => {
    assert.throws(() => expected(run(control, mutation)), assert.AssertionError);
  });
});
