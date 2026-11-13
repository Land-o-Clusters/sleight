#!/usr/bin/env node
// UC2F's two optional cells reuse RT13's fixture, witness and cleanup ownership.
// Importing this module and --dry-run both remain inert.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runProbePlan, parseProbeOptions, assertProbeSafety } from './runtime-probe.mjs';
import { createLiveProbe } from './runtime-probe-live.mjs';
import { lowerMedian } from './runtime-gate.mjs';
import { writeRuntimeReport, outputStem } from './runtime-arm.mjs';

export function textProbePlan() {
  return JSON.parse(readFileSync(new URL('./runtime-probe-plan.json', import.meta.url), 'utf8')).subsets.uc2f.cells.map(cell => {
    const { textRepeat, ...rest } = cell;
    return { ...rest, text: textRepeat ? textRepeat.value.repeat(textRepeat.count) : cell.text };
  });
}
export function scoreTextProbe(report) {
  const cells = textProbePlan().map(cell => {
    const matches = report.cells?.filter(row => row.id === cell.id) ?? [], row = matches[0];
    const trials = row?.trialsData ?? [];
    const valid = trial => trial.passed === true && trial.evidence?.observed === true && trial.evidence?.background === true &&
      trial.evidence?.posted === true && trial.evidence?.caretConfirmed === true && trial.evidence?.exactText === true &&
      trial.evidence?.textMatches === true && trial.evidence?.characters === [...cell.text].length &&
      (report.textBelief === 'always' || report.textBelief === 'fallback' &&
        trial.evidence?.delivery === 'sent-verified' && trial.evidence?.textBeliefFallback === false) &&
      Number.isFinite(trial.evidence?.elapsedMs) && trial.evidence.elapsedMs >= 0;
    const passes = trials.filter(valid).length, p50Ms = lowerMedian(trials.filter(valid).map(t => t.evidence.elapsedMs));
    return { id: cell.id, passes, trials: trials.length, p50Ms, p50LimitMs: cell.p50LimitMs ?? null,
      passed: matches.length === 1 && row.attempted === 10 && row.passes === 10 && trials.length === 10 && passes === 10 &&
        (cell.p50LimitMs === undefined || p50Ms <= cell.p50LimitMs) };
  });
  return { passed: !report.stop && report.cleanupConfirmed === true && report.cells?.length === 2 && cells.every(cell => cell.passed),
    qualifiesRuntime: false, cells };
}
export async function runTextProbe(options, deps = {}) {
  if (options.sitting) throw Error('TEXT_PROBE_ONLY');
  const plan = textProbePlan(), textBelief = process.env.SLEIGHT_DRIVER_TEXT_BELIEF === 'fallback' ? 'fallback' : 'always';
  const publish = (stem, report) => {
    report.textBelief = textBelief; report.textProbe = scoreTextProbe(report);
    const markdown = ['# UC2F text probe', '', `Text belief: ${textBelief}. Passed: ${report.textProbe.passed}. Cleanup confirmed: ${report.cleanupConfirmed}.`,
      'These two cells cannot qualify the full runtime gate.', '',
      ...report.textProbe.cells.map(cell => `- ${cell.id}: ${cell.passes}/10 exact; p50 ${cell.p50Ms ?? 'unmeasured'} ms; limit ${cell.p50LimitMs ?? 'none'} ms.`),
      ...(report.stop ? [`Stopped: ${report.stop}.`] : []), ''].join('\n');
    (deps.publish ?? writeRuntimeReport)(stem, report, markdown);
  };
  const report = await runProbePlan({ ...options, env: { SLEIGHT_RUNTIME: 'own' } }, { ...deps, plan, publish });
  return options.dryRun ? { ...report, textBelief, qualifiesRuntime: false } : report;
}
async function main() {
  const options = parseProbeOptions(process.argv.slice(2));
  if (options.sitting) throw Error('TEXT_PROBE_ONLY');
  if (options.dryRun) { console.log(JSON.stringify(await runTextProbe(options), null, 2)); return 0; }
  assertProbeSafety({ ...options, held: existsSync('/tmp/sleight-hold'), running: [] }, textProbePlan());
  outputStem(options.out);
  const controller = new AbortController(), interrupt = () => controller.abort(Error('INTERRUPTED'));
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  try {
    const { acquireLiveLock } = await import('./live-lock.mjs');
    const backend = await createLiveProbe({ runtime: 'own', signal: controller.signal });
    const report = await runTextProbe({ ...options, signal: controller.signal }, { backend,
      takeLock: () => acquireLiveLock(undefined, { signal: controller.signal }) });
    return report.textProbe?.passed === true ? 0 : 1;
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
