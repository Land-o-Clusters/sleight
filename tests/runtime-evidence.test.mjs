import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { hashHelper, observeRuntimeAttempt, bindOwnBinary, validOwnExecution, validEngineExecution,
  validProcessEvidence, awaitEngineIdle } from '../bench/runtime-evidence.mjs';
import { ENGINE, receipt, engineReceipt, processEvidence } from './runtime-gate-fixtures.mjs';

test('own evidence rejects fallback during the attempt even when the child claims zero starts', () => {
  const r = receipt('synthetic-run-nonce');
  assert.equal(validOwnExecution(r, processEvidence()), true);
  for (const phase of [0, 1, 2]) {
    const evidence = processEvidence(); evidence.samples[phase].helpers = processEvidence('engine').samples[1].helpers;
    assert.equal(validOwnExecution(r, evidence), false, String(phase));
  }
  assert.equal(validOwnExecution(r, undefined), false);
});
test('driver binary hash, post-run hash, PID, path and process-start identity must agree', () => {
  for (const change of [e => { e.binary.sha256 = 'a'.repeat(64); }, e => { e.binary.sha256After = 'b'.repeat(64); },
    e => { e.binary.pid++; }, e => { e.binary.path += '-other'; }, e => { e.binary.started = 'other'; },
    e => { e.samples[1].drivers = []; }]) {
    const evidence = processEvidence(); change(evidence); assert.equal(validOwnExecution(receipt('nonce'), evidence), false);
  }
});
test('engine identity requires the reported version/build and observed helper path, with no own receipt', () => {
  assert.equal(validEngineExecution(engineReceipt(), processEvidence('engine'), ENGINE), true);
  for (const r of [undefined, { ...engineReceipt(), engineVersion: 'other' }, { ...engineReceipt(), engineBuild: 'other' },
    { ...engineReceipt(), helperPath: '/other/SkyComputerUseService' }]) {
    assert.equal(validEngineExecution(r, processEvidence('engine'), ENGINE), false);
  }
  assert.equal(validEngineExecution(engineReceipt(), processEvidence('engine'), ENGINE, receipt('nonce')), false);
  assert.equal(validEngineExecution(engineReceipt(), processEvidence(), ENGINE), false);
});
test('the independent observer counts helper starts and hashes the observed serving binary', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'rt13-evidence-unit-'));
  try {
    const path = join(dir, 'helper'); writeFileSync(path, 'compiled helper fixture');
    const driver = { pid: 123, path, started: '1.1' }, helper = processEvidence('engine').samples[1].helpers[0];
    let call = 0;
    const observed = await observeRuntimeAttempt(async () => 'attempt-result', { inventory: async () => {
      const index = call++; return { helpers: index === 1 ? [helper] : [], drivers: index === 1 ? [driver] : [] };
    } });
    assert.equal(observed.value, 'attempt-result'); assert.equal(observed.processEvidence.engineHelperStarts, 1);
    assert.equal(validProcessEvidence(observed.processEvidence), true);
    const bound = bindOwnBinary({ driverPid: 123, driverPath: path }, observed.processEvidence);
    assert.equal(bound.binary.sha256, hashHelper(path)); assert.equal(bound.binary.sha256After, bound.binary.sha256);
    assert.deepEqual(observed.processEvidence.samples.map(s => s.phase), ['before', 'during', 'after']);
    symlinkSync(path, join(dir, 'alias')); assert.throws(() => hashHelper(join(dir, 'alias')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('a forged helper count or missing during sample invalidates process evidence', () => {
  const evidence = processEvidence('engine'); evidence.engineHelperStarts = 0;
  assert.equal(validProcessEvidence(evidence), false);
  evidence.engineHelperStarts = 1; evidence.samples.splice(1, 1);
  assert.equal(validProcessEvidence(evidence), false);
});
test('observer failures collect the running operation and keep before/during/after evidence', async () => {
  let completed = false, calls = 0;
  await assert.rejects(observeRuntimeAttempt(async () => { await new Promise(resolve => setTimeout(resolve, 5)); completed = true; }, {
    inventory: async () => ++calls === 2 ? {} : { helpers: [], drivers: [] },
  }), error => { assert.equal(error.message, 'PROCESS_INVENTORY_INVALID'); assert.equal(completed, true); return true; });
});
test('hashHelper hashes file bytes independently of a reported digest', () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'rt13-hash-unit-'));
  try {
    const path = join(dir, 'binary'); writeFileSync(path, 'binary-v1');
    const first = hashHelper(path); assert.equal(first, createHash('sha256').update('binary-v1').digest('hex'));
    writeFileSync(path, 'binary-v2'); assert.notEqual(hashHelper(path), first);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('a preexisting shared engine helper stops own qualification without signaling it', async () => {
  await assert.rejects(awaitEngineIdle(async () => ({ helpers: processEvidence('engine').samples[1].helpers }), { timeoutMs: 0 }), /ENGINE_HELPER_PRESENT/);
  await assert.doesNotReject(awaitEngineIdle(async () => ({ helpers: [] })));
  await assert.rejects(awaitEngineIdle(async () => ({})), /PROCESS_INVENTORY_INVALID/);
});
test('a slow helper exit records the bounded wait and permits input only after an empty sample', async () => {
  let clock = 1000, polls = 0;
  const waits = [], helper = processEvidence('engine').samples[1].helpers;
  const result = await awaitEngineIdle(async () => ({ helpers: ++polls < 4 ? helper : [] }), {
    timeoutMs: 250, pollMs: 100, now: () => clock,
    wait: async ms => { waits.push(ms); clock += ms; },
  });
  assert.deepEqual(waits, [100, 100, 50]);
  assert.equal(result.outcome, 'idle'); assert.equal(result.elapsedMs, 250);
  assert.equal(result.samples.length, 4); assert.deepEqual(result.samples.at(-1).helpers, []);
});
test('a helper that outlives the deadline records a timeout and never waits beyond the remaining budget', async () => {
  let clock = 0;
  await assert.rejects(awaitEngineIdle(async () => ({ helpers: processEvidence('engine').samples[1].helpers }), {
    timeoutMs: 150, now: () => clock, wait: async ms => { clock += ms; },
  }), error => {
    assert.equal(error.message, 'ENGINE_HELPER_PRESENT');
    assert.equal(error.idleWait.outcome, 'timeout'); assert.equal(error.idleWait.elapsedMs, 150);
    assert.deepEqual(error.idleWait.samples.map(sample => sample.at), [0, 100, 150]); return true;
  });
  for (const timeoutMs of [-1, 30001, Infinity]) {
    await assert.rejects(awaitEngineIdle(() => assert.fail('inventory before validation'), { timeoutMs }), /PROCESS_IDLE_WAIT_INVALID/);
  }
});
test('a hold during the idle wait preserves the wait record and stops without another inventory', async () => {
  let clock = 0, polls = 0;
  await assert.rejects(awaitEngineIdle(async () => { polls++; return { helpers: processEvidence('engine').samples[1].helpers }; }, {
    now: () => clock, wait: async ms => { clock += ms; }, boundary: () => { if (clock) throw Error('HOLD'); },
  }), error => { assert.equal(error.message, 'HOLD'); assert.equal(error.idleWait.outcome, 'stopped');
    assert.equal(error.idleWait.elapsedMs, 100); assert.equal(polls, 1); return true; });
});
