// Optional operator load gate and disposable benchmark output bank.
// SLEIGHT_BENCH_GATE_FILE unset means no gate; SLEIGHT_BENCH_OUTPUT_DIR
// defaults to the ignored bench/results directory, anchored to this checkout.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export function benchGateOpen(env = process.env, exists = existsSync) {
  return !env.SLEIGHT_BENCH_GATE_FILE || exists(env.SLEIGHT_BENCH_GATE_FILE);
}

// Offline tools may run without a load gate. Live drivers must opt in before
// inspecting the host, creating output, importing live modules or driving apps.
export function requireLiveBenchGate(env = process.env) {
  if (!env.SLEIGHT_BENCH_GATE_FILE?.trim())
    throw Error('Live run refused: set SLEIGHT_BENCH_GATE_FILE to an operator-controlled gate file, and pass --owner-away. Driving starts only while that file exists.');
}

export async function waitForBenchGate({ env = process.env, exists = existsSync,
  wait = sleep, signal } = {}) {
  signal?.throwIfAborted();
  while (!benchGateOpen(env, exists)) {
    await wait(60000, undefined, { signal });
    signal?.throwIfAborted();
  }
}

export function benchOutputPath(name, env = process.env) {
  return resolve(env.SLEIGHT_BENCH_OUTPUT_DIR || fileURLToPath(new URL('results/', import.meta.url)), name);
}

export function benchEvidencePath(name = '', env = process.env) {
  return resolve(env.SLEIGHT_BENCH_EVIDENCE_DIR || benchOutputPath('evidence', env), name);
}

export function writeBenchJson(name, value, env = process.env) {
  const path = benchOutputPath(name, env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
  return path;
}
