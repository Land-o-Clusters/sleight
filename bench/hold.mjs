import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

export const benchmarkHeld = () => existsSync('/tmp/sleight-hold');
const markerLine = () => { try { return readFileSync('/tmp/sleight-hold', 'utf8'); } catch { return '(marker unavailable)'; } };
const limit = (name, fallback, minimum) => {
  const value = process.env[name];
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw Error(`Invalid benchmark hold limit: ${name}`);
  return number;
};
const holdLimit = message => Object.assign(Error(`Benchmark hold ${message}`), { code: 'BENCH_HOLD_LIMIT', exitCode: 75 });
export const benchmarkStopCode = (error, signal = error?.signal) => error?.code === 'BENCH_HOLD_LIMIT' ? 75
  : signal?.aborted && (error === signal.reason || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') ? 130 : undefined;
function checkAbort(signal) {
  if (signal?.aborted) throw Object.assign(Error(signal.reason?.message ?? 'Benchmark interrupted', { cause: signal.reason }),
    { name: 'AbortError', code: 'ABORT_ERR', exitCode: 130, signal });
}

// Call only at an idle boundary. A hold never cancels a driver or its cleanup.
export async function waitForBenchmark({ held = benchmarkHeld, signal, interval = 1000,
  wait = ms => delay(ms, undefined, { signal }), log = console.error, now = () => performance.now(),
  marker = markerLine, maxWaitMs = limit('SLEIGHT_HOLD_WAIT_MAX_MS', 6 * 60 * 60 * 1000, 1) } = {}) {
  checkAbort(signal);
  const started = now();
  let waiting = false, heartbeat = 0;
  while (held()) {
    const elapsed = now() - started;
    if (elapsed >= maxWaitMs) throw holdLimit(`wait limit reached after ${Math.floor(elapsed)} ms`);
    if (!waiting || elapsed - heartbeat >= 5 * 60 * 1000) {
      log(`Benchmark hold: waiting at task boundary, ${Math.floor(elapsed)} ms so far; ${String(marker()).split(/\r?\n/, 1)[0]}`);
      heartbeat = elapsed; waiting = true;
    }
    try { await wait(Math.min(interval, maxWaitMs - elapsed)); }
    catch (error) { checkAbort(signal); throw error; }
    checkAbort(signal);
  }
  if (waiting) log('Benchmark hold cleared: resuming.');
  return waiting;
}

// Complete and collect each attempt before waiting. Keep held attempts as evidence,
// then rerun with fresh fixtures so neither their load nor the wait enters scoring.
export async function runTaskWithHold(operation, { held = benchmarkHeld, signal, interval = 100,
  boundary = waitForBenchmark, onRetry = () => {}, canRetry = () => true,
  retries = limit('SLEIGHT_HOLD_RETRIES', 5, 0), ...options } = {}) {
  for (let attempt = 1;; attempt++) {
    await boundary({ held, signal, ...options });
    let overlapped = false;
    const sample = () => { overlapped ||= held(); };
    const timer = setInterval(sample, interval);
    let result;
    try { result = await operation(attempt); }
    finally { sample(); clearInterval(timer); }
    if (!overlapped || signal?.aborted || !canRetry(result)) return result;
    await onRetry(result, attempt);
    if (attempt > retries) throw holdLimit(`retry limit reached (${retries} retries)`);
  }
}
