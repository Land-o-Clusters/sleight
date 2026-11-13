// Synthetic evidence only. No host capabilities or subprocesses.
import { canonicalProbePlan } from '../bench/runtime-gate.mjs';
export const OWN_BUILD = { kind: 'own', sourceSha256: '1'.repeat(64) };
export const ENGINE = { version: '1.2.3', build: 'engine-build-1' };
export const SOURCE = { sleightCommit: 'same-sha', sleightDirty: false };
export const DRIVER = { version: '1', build: '2'.repeat(64) };
export const build = (_, kind) => kind === 'own' ? OWN_BUILD : { kind: 'engine', version: ENGINE.version };
export const metadata = (runtime = 'own') => ({ runtime, runtimeBuild: build(null, runtime),
  engineVersion: ENGINE.version, engineBuild: ENGINE.build, ...SOURCE });
export const receipt = (runNonce, runtimeBuild = OWN_BUILD) => ({ schema: 'sleight.runtime-receipt/1', runtime: 'own',
  runNonce, runtimeBuild, driverVersion: '1', driverBuild: '2'.repeat(64), driverSourceBuild: '2'.repeat(64), driverRequests: 3, engineHelperStarts: 0,
  driverPid: 123, driverPath: '/synthetic/mac-driver/build/glide-engine',
  ping: { runNonce, apiVersion: 1, build: '2'.repeat(64) } });
export const engineReceipt = () => ({ schema: 'sleight.engine-receipt/1', engineVersion: ENGINE.version,
  engineBuild: ENGINE.build, helperPath: '/synthetic/engine/SkyComputerUseService' });
export const processEvidence = (runtime = 'own') => {
  const driver = { pid: 123, path: receipt('').driverPath, started: '1.1' };
  const helper = { pid: 456, path: engineReceipt().helperPath, started: '1.2' };
  return { schema: 'sleight.runtime-process-evidence/1', engineHelperStarts: runtime === 'engine' ? 1 : 0,
    samples: ['before', 'during', 'after'].map((phase, i) => ({ phase, at: i,
      helpers: runtime === 'engine' && i === 1 ? [helper] : [], drivers: runtime === 'own' && i === 1 ? [driver] : [] })),
    ...(runtime === 'own' && { binary: { ...driver, sha256: '2'.repeat(64), sha256After: '2'.repeat(64) },
      binaries: [{ ...driver, sha256: '2'.repeat(64), sha256After: '2'.repeat(64) }] }) };
};
export const evidence = () => ({ observed: true, background: true, posted: true, covered: true, windowClosed: true,
  fileMatches: true, saveSheetBefore: true, goToFolderAfter: true, caretConfirmed: true, textMatches: true,
  singleReply: true, treePresent: true, imagePresent: true, imageMatchesWindow: true,
  hid: Object.fromEntries(['click', 'key', 'type'].map(k => [k, { beforeMs: 1000, afterMs: 1100, elapsedMs: 100 }])),
  sheetBefore: true, sheetGoneInNextRead: true, menuAbsentBefore: true, menuInNextRead: true, elapsedMs: 10, correct: true });
export function step1Report() {
  const plan = canonicalProbePlan();
  const trial = (cell, i, runtime) => {
    const runNonce = cell.id + '-synthetic-' + runtime + i;
    return { trial: i + 1, runtime, sessionId: 'synthetic-session', passed: true, runNonce, evidence: evidence(),
      buildStart: metadata(runtime), buildEnd: metadata(runtime),
      processEvidence: processEvidence(runtime),
      ...(runtime === 'own' ? { runtimeReceipt: receipt(runNonce) } : { engineReceipt: engineReceipt() }) };
  };
  return { schema: 'sleight.runtime-probe/2', runtime: 'own', sessionId: 'synthetic-session', plan, build: metadata(),
    driverIdentity: { version: '1', build: '2'.repeat(64) },
    cleanupConfirmed: true, verdict: { passed: true, complete: true, verdict: 'step1: mechanisms-pass' },
    cells: plan.map(cell => ({ ...cell, attempted: cell.trials, passes: cell.trials, passed: true,
      p50Ms: cell.group === 6 ? 10 : undefined, engineP50Ms: cell.group === 6 ? 10 : undefined,
      order: cell.group === 6 ? Array.from({ length: cell.trials }, (_, i) => i % 2 ? ['own', 'engine'] : ['engine', 'own']).flat() : [],
      trialsData: Array.from({ length: cell.trials }, (_, i) => trial(cell, i, 'own')),
      baselineData: cell.group === 6 ? Array.from({ length: cell.trials }, (_, i) => trial(cell, i, 'engine')) : [] })) };
}
