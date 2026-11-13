#!/usr/bin/env node
// Plan inspection only until the compound transport and contracts qualify.
// No live adapter, application inventory, lock, witness or driver is imported.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function compoundProbePlan() {
  const { compoundCells } = JSON.parse(readFileSync(new URL('./runtime-probe-plan.json', import.meta.url), 'utf8'));
  return { schema: 'sleight.runtime-compound-probe/1', dryRun: true, executable: false,
    reason: 'COMPOUND_TRANSPORT_UNREGISTERED', cells: compoundCells,
    totalTrials: compoundCells.reduce((n, c) => n + c.trials, 0),
    qualification: { calculatorMaxTurns: 7, liveTrialsRun: 0, passed: false } };
}
export function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || args[0] !== '--dry-run') throw Error('COMPOUND_TRANSPORT_UNREGISTERED: use --dry-run');
  console.log(JSON.stringify(compoundProbePlan(), null, 2));
  return 0;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
