// Headless import timing only. No relay, native helper, app or renderer is started.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const baseline = process.argv[2] ?? 'cef5c4a2';
const samples = Number(process.argv[3] ?? 24);
if (!/^[a-f0-9]{8,40}$/.test(baseline) || !Number.isInteger(samples) || samples < 12 || samples > 48) {
  throw Error('Usage: node scripts/measure-cursor-import.mjs BASE_SHA [12..48]');
}
const root = mkdtempSync(join(tmpdir(), 'cursor-import-'));
try {
  const base = join(root, 'base'), candidate = join(root, 'candidate');
  for (const path of [base, candidate]) mkdirSync(path);
  const archive = execFileSync('/usr/bin/git', ['archive', baseline, 'plugins/sleight', 'package.json'], { maxBuffer: 32 * 1024 * 1024 });
  execFileSync('/usr/bin/tar', ['-x', '-C', base], { input: archive });
  mkdirSync(join(candidate, 'plugins'));
  cpSync('plugins/sleight', join(candidate, 'plugins/sleight'), { recursive: true });
  for (const path of [base, candidate]) symlinkSync(resolve('node_modules'), join(path, 'node_modules'));
  const runs = { base: [], candidate: [] };
  function measure(path) {
    const url = pathToFileURL(join(path, 'plugins/sleight/lib/hand/events.mjs')).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const start = performance.now();
      await import(${JSON.stringify(url)});
      console.log(performance.now() - start);
    `], { encoding: 'utf8', timeout: 10000 });
    if (child.status !== 0) throw Error(child.stderr || `Import child exited ${child.status}`);
    return Number(child.stdout.trim());
  }
  // Alternate order to reduce drift from concurrent host activity. Warm each snapshot once.
  measure(base); measure(candidate);
  for (let i = 0; i < samples; i++) {
    for (const key of i % 2 ? ['candidate', 'base'] : ['base', 'candidate']) runs[key].push(measure(key === 'base' ? base : candidate));
  }
  const stats = values => {
    const sorted = values.toSorted((a, b) => a - b), n = sorted.length;
    return { samples: n, medianMs: n % 2 ? sorted[Math.floor(n / 2)] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2, minMs: sorted[0], maxMs: sorted.at(-1) };
  };
  const result = { baseline, platform: process.platform, node: process.version, base: stats(runs.base), candidate: stats(runs.candidate) };
  result.deltaMs = result.candidate.medianMs - result.base.medianMs;
  console.log(JSON.stringify(result));
} finally { rmSync(root, { recursive: true, force: true }); }
