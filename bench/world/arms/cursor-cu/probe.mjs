import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armPaths, composerPlan, guardLive, DESKTOP_BLOCKERS } from './contract.mjs';
import { setupPlan } from './setup.mjs';

export { guardLive } from './contract.mjs';

export function probePlan() {
  return { arm: 'cursor-cu', route: 'desktop', dryRun: true, liveReady: false, blockers: DESKTOP_BLOCKERS, setup: setupPlan(),
    guards: ['--owner-away', 'no sleight-hold', 'exclusive sleight-live.lock', 'pinned signed app copy'],
    runs: [
      { task: 'textedit-edit', suite: 'world', runs: 1, command: ['node', 'bench/run.mjs', '--suite', 'world', '--arm', 'cursor-cu', '--tasks', 'textedit-edit', '--runs', '1', '--owner-away'] },
      { task: 'mdn', suite: 'chrome-race', runs: 1, command: ['sh', 'bench/fowl/rounds.sh', '--surface', 'cursor-cu', '--real-browser', 'chrome', '--only', 'mdn', '--owner-away', '--no-hub'] },
    ], composer: composerPlan({ prompt: '<task prompt from shared fixture>', paths: armPaths() }) };
}

export async function runProbe(options = {}, { exists = existsSync, run } = {}) {
  const plan = probePlan();
  if (options.dryRun) return plan;
  guardLive(options, { exists });
  const { DesktopDriver } = await import('./desktop.mjs');
  await new DesktopDriver().preflight({ paths: armPaths() });
  const { nativeMain, chromeMain } = await import('./suite.mjs');
  const execute = run ?? (async row => row.suite === 'world'
    ? nativeMain(row.command.slice(2)) : chromeMain(row.command.slice(2)));
  const results = [];
  for (const row of plan.runs) {
    guardLive(options, { exists });
    const result = await execute(row); results.push(result);
    if (result?.failed || result?.groupClean === false || process.exitCode) break;
  }
  return { ...plan, dryRun: false, results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(a => !['--dry-run', '--owner-away'].includes(a))) throw Error('probe accepts --dry-run and --owner-away only');
    console.log(JSON.stringify(await runProbe({ dryRun: args.includes('--dry-run'), ownerAway: args.includes('--owner-away') }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
