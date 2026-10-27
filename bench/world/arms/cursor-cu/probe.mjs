import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armPaths, composerPlan, guardLive, DESKTOP_BLOCKERS } from './contract.mjs';
import { setupPlan } from './setup.mjs';

export { guardLive } from './contract.mjs';

export function probePlan({ out, ownerSaysCursorFree = false } = {}) {
  const output = out ? resolve(out) : null;
  return { arm: 'cursor-cu', route: 'desktop', dryRun: true, liveReady: false, blockers: DESKTOP_BLOCKERS, setup: setupPlan(),
    guards: ['--owner-says-cursor-free', '--owner-away', 'no sleight-hold', 'exclusive sleight-live.lock', 'installed signed Cursor and existing login'],
    runs: [
      { task: 'textedit-edit', suite: 'world', runs: 1, command: ['node', 'bench/run.mjs', '--suite', 'world', '--arm', 'cursor-cu', '--tasks', 'textedit-edit', '--runs', '1', '--owner-away', ...(ownerSaysCursorFree ? ['--owner-says-cursor-free'] : []), '--no-hub', ...(output ? ['--out', output + '.native.json'] : [])] },
      { task: 'mdn', suite: 'chrome-race', runs: 1, command: ['sh', 'bench/fowl/rounds.sh', '--surface', 'cursor-cu', '--real-browser', 'chrome', '--only', 'mdn', '--owner-away', ...(ownerSaysCursorFree ? ['--owner-says-cursor-free'] : []), '--no-hub', ...(output ? ['--out', output + '.chrome'] : [])] },
    ], ...(output ? { out: output } : {}), composer: composerPlan({ prompt: '<task prompt from shared fixture>', paths: armPaths() }) };
}

export async function runProbe(options = {}, { exists = existsSync, run, preflight } = {}) {
  const plan = probePlan(options);
  if (options.dryRun) return plan;
  if (plan.out && [plan.out, plan.out + '.native.json', plan.out + '.chrome'].some(exists)) throw Error('Cursor probe output already exists');
  guardLive(options, { exists });
  const { DesktopDriver } = await import('./desktop.mjs');
  await (preflight ?? (p => new DesktopDriver().preflight(p)))({ paths: armPaths(), ownerSaysCursorFree: options.ownerSaysCursorFree });
  const { nativeMain, chromeMain } = await import('./suite.mjs');
  const execute = run ?? (async row => row.suite === 'world'
    ? nativeMain(row.command.slice(2)) : chromeMain(row.command.slice(2)));
  const results = [];
  for (const row of plan.runs) {
    guardLive(options, { exists });
    const result = await execute(row); results.push(result);
    if (result?.failed || result?.groupClean === false || process.exitCode) break;
  }
  const report = { ...plan, dryRun: false, results,
    failed: results.length !== plan.runs.length || results.some(r => r?.failed || r?.groupClean === false) || !!process.exitCode };
  if (report.failed) process.exitCode = 1;
  if (plan.out) {
    mkdirSync(dirname(plan.out), { recursive: true, mode: 0o700 });
    writeFileSync(plan.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      if (key === '--dry-run' && !options.dryRun) options.dryRun = true;
      else if (key === '--owner-says-cursor-free' && !options.ownerSaysCursorFree) options.ownerSaysCursorFree = true;
      else if (key === '--owner-away' && !options.ownerAway) options.ownerAway = true;
      else if (key === '--out' && !options.out && args[i + 1] && !args[i + 1].startsWith('--')) options.out = args[++i];
      else throw Error('probe accepts --dry-run, --owner-says-cursor-free, --owner-away and --out FILE only');
    }
    console.log(JSON.stringify(await runProbe(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
