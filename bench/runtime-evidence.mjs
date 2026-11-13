// Harness-owned evidence. Importing this module performs no process inspection.
import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export function hashHelper(path) {
  let fd;
  try {
    if (typeof path !== 'string' || !isAbsolute(path) || realpathSync(path) !== path) throw Error('HELPER_BINARY_INVALID');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > 128 * 1024 * 1024) throw Error('HELPER_BINARY_INVALID');
    const sha256 = createHash('sha256').update(readFileSync(fd)).digest('hex'), after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('HELPER_BINARY_CHANGED');
    return sha256;
  } catch (error) { if (error.message === 'HELPER_BINARY_CHANGED') throw error; throw Error('HELPER_BINARY_INVALID'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
const processKey = p => `${p.pid}:${p.started}:${p.path}`;
const validProcess = p => Number.isSafeInteger(p?.pid) && p.pid > 0 && typeof p.started === 'string' && !!p.started &&
  typeof p.path === 'string' && isAbsolute(p.path);
export function validProcessEvidence(evidence) {
  const samples = evidence?.samples;
  return evidence?.schema === 'sleight.runtime-process-evidence/1' && Array.isArray(samples) && samples.length >= 3 &&
    samples[0]?.phase === 'before' && samples.at(-1)?.phase === 'after' && samples.slice(1, -1).every(s => s?.phase === 'during') &&
    samples.every((s, i) => Number.isFinite(s?.at) && (!i || s.at >= samples[i - 1].at) &&
      Array.isArray(s.helpers) && Array.isArray(s.drivers) && [...s.helpers, ...s.drivers].every(validProcess)) &&
    evidence.engineHelperStarts === new Set(samples.slice(1).flatMap(s => s.helpers).map(processKey)
      .filter(key => !new Set(samples[0].helpers.map(processKey)).has(key))).size;
}
export function validOwnExecution(receipt, evidence) {
  if (!validProcessEvidence(evidence) || evidence.samples.some(s => s.helpers.length) ||
      receipt?.engineHelperStarts !== evidence.engineHelperStarts || !Number.isSafeInteger(receipt?.driverPid)) return false;
  const binary = evidence.binary;
  return !!binary && binary.pid === receipt.driverPid && binary.path === receipt.driverPath &&
    binary.sha256 === receipt.driverBuild && binary.sha256After === binary.sha256 &&
    evidence.samples.slice(1, -1).some(s => s.drivers.some(p => processKey(p) === processKey(binary)));
}
export function validEngineExecution(engineReceipt, evidence, engine, ownReceipt) {
  if (ownReceipt != null || !validProcessEvidence(evidence) || evidence.samples.some(s => s.drivers.length) ||
      typeof engine?.version !== 'string' || !engine.version || typeof engine.build !== 'string' || !engine.build ||
      engineReceipt?.schema !== 'sleight.engine-receipt/1' || engineReceipt.engineVersion !== engine?.version ||
      engineReceipt.engineBuild !== engine?.build || typeof engineReceipt.helperPath !== 'string') return false;
  return evidence.samples.slice(1, -1).some(s => s.helpers.some(p => p.path === engineReceipt.helperPath));
}

// The scanner is a separate native process, never the claim child or driver.
// Polling is serialized; failed or missing samples invalidate the attempt.
export async function observeRuntimeAttempt(operation, { inventory, hash = hashHelper, intervalMs = 50, now = Date.now } = {}) {
  if (typeof inventory !== 'function') throw Error('PROCESS_INVENTORY_REQUIRED');
  const evidence = { schema: 'sleight.runtime-process-evidence/1', samples: [] }, binaries = new Map();
  const sample = async phase => {
    const value = await inventory();
    if (!Array.isArray(value?.helpers) || !Array.isArray(value?.drivers) ||
        ![...value.helpers, ...value.drivers].every(validProcess)) throw Error('PROCESS_INVENTORY_INVALID');
    evidence.samples.push({ phase, at: now(), helpers: value.helpers, drivers: value.drivers });
    for (const driver of value.drivers) {
      if (!validProcess(driver)) throw Error('PROCESS_INVENTORY_INVALID');
      if (!binaries.has(processKey(driver))) binaries.set(processKey(driver), { ...driver, sha256: hash(driver.path) });
    }
  };
  await sample('before');
  let finished = false, timer, fault, inFlight;
  const poll = async () => {
    try { await sample('during'); } catch (error) { fault = error; }
    if (!finished && !fault) timer = setTimeout(() => { inFlight = poll(); }, intervalMs);
  };
  const pending = Promise.resolve().then(operation);
  // Attach rejection handling before awaiting the independent observer.
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  inFlight = poll(); await inFlight;
  const result = await outcome;
  finished = true; clearTimeout(timer);
  // A scheduled poll can still be awaiting inventory. The native client serializes
  // requests, and this barrier keeps after last even with a slow scanner.
  await inFlight;
  try { await sample('after'); } catch (error) { fault ??= error; }
  evidence.engineHelperStarts = new Set(evidence.samples.slice(1).flatMap(s => s.helpers).map(processKey)
    .filter(key => !new Set(evidence.samples[0].helpers.map(processKey)).has(key))).size;
  try { evidence.binaries = [...binaries.values()].map(binary => ({ ...binary, sha256After: hash(binary.path) })); }
  catch (error) { fault ??= error; }
  if (fault || result.error) throw Object.assign(fault ?? result.error, { processEvidence: evidence });
  return { value: result.value, processEvidence: evidence };
}

export function bindOwnBinary(receipt, processEvidence) {
  const matches = processEvidence?.binaries?.filter(binary => binary.pid === receipt?.driverPid && binary.path === receipt?.driverPath) ?? [];
  return { ...processEvidence, ...(matches.length === 1 && { binary: matches[0] }) };
}

// The shared engine helper may idle briefly after its client closes. Do not
// signal it, or attribute a preexisting shared helper to an own-runtime attempt.
export async function awaitEngineIdle(inventory, { signal, boundary = () => {}, timeoutMs = 30000,
  pollMs = 100, now = Date.now, wait = sleep } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000 ||
      !Number.isFinite(pollMs) || pollMs <= 0 || pollMs > 1000) throw Error('PROCESS_IDLE_WAIT_INVALID');
  const startedAt = now(), deadline = startedAt + timeoutMs;
  const idleWait = { schema: 'sleight.runtime-idle-wait/1', startedAt, timeoutMs, pollMs, samples: [] };
  const finish = outcome => Object.assign(idleWait, { outcome, finishedAt: now(), elapsedMs: now() - startedAt });
  try {
    for (;;) {
      boundary(); signal?.throwIfAborted();
      const value = await inventory();
      if (!Array.isArray(value?.helpers) || !value.helpers.every(validProcess)) throw Error('PROCESS_INVENTORY_INVALID');
      idleWait.samples.push({ at: now(), helpers: value.helpers });
      if (!value.helpers.length) return finish('idle');
      if (now() >= deadline) throw Error('ENGINE_HELPER_PRESENT');
      await wait(Math.min(pollMs, deadline - now()), undefined, { signal });
    }
  } catch (error) {
    finish(error.message === 'ENGINE_HELPER_PRESENT' ? 'timeout' : 'stopped');
    throw Object.assign(error, { idleWait });
  }
}
