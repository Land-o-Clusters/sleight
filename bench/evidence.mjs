// Native evidence survives temp sweeps. Readers retain both spellings of the old temp root.
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export function tempRoots() {
  const temp = tmpdir();
  let real = temp;
  try { real = realpathSync(temp); } catch {}
  return [...new Set([temp, real])];
}

export function evidenceRoots({ armHome = process.env.BENCH_ARM_HOME || join(homedir(), 'Library', 'Caches', 'sleight-bench'),
  temps = tempRoots() } = {}) {
  return [join(armHome, 'evidence'), ...temps.map(base => join(base, 'sleight-real-evidence'))];
}
