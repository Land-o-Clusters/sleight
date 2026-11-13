import { stageScriptDigest } from '../../bench/hand/stage-measurement.mjs';
import { stageScriptFixture, stageSurfaceChecksFixture } from './stage-surface.mjs';

function script(size, surface) {
  const row = stageScriptFixture(surface, size); row.actions = row.actions.slice(0, 1); row.actions[0].frame.nonce = 'a'.repeat(64);
  row.scriptDigest = stageScriptDigest(row.actions, row.windows); return row;
}
export function passingPhase(size, surface) {
  return { activeS: 62, idleS: 62, hosts: 1, hostAliveThroughout: true, visibilityValid: true,
    hostAvgPct: 1, idleHostCpuS: 0.01, peakRssMiB: 20, wsAvgPct: 11, wsPeakPct: 12,
    ...script(size, surface), surfaceChecks: stageSurfaceChecksFixture(surface),
    control: { start: 0, end: 61000, pid: 42, ...script(size, surface),
      surfaceChecks: stageSurfaceChecksFixture(surface, false),
      samples: Array.from({ length: 62 }, (_, i) => ({ t: i * 1000, ws: i * 0.1, hosts: {},
        status: { pid: 42, characterHiddenControl: true, shown: false } })) } };
}
export function withPairedControls(phase) {
  const before = phase.figures.control, after = structuredClone(before);
  after.start += 191000; after.end += 191000;
  for (const sample of after.samples) sample.t += 191000;
  phase.figures.control = { layout: 'bracketed/1', before, after, phaseStart: 62000, phaseEnd: 190000 };
  return phase;
}
export function passingPacing(hz, ms, metadata) {
  const bare = { sublayerCount: 0, siblingCount: 0, opacity: 1, parentAnimationKeys: [] };
  return { ...metadata, requestedHz: hz, durationMs: ms, maximumHz: 120, started: true, ok: true,
    invalidFrames: 0, overflow: false, changedDimensions: false,
    scheduledStartHostMs: 1000, frames: Array.from({ length: hz * ms / 1000 }, (_, i) => ({ tMs: i * 1000 / hz, hash: `frame-${i}` })),
    motionTiming: { source: metadata.source, scheduledStartHostMs: 1000, installStartHostMs: 1000, caBeginHostMs: 1000,
      installEndHostMs: 1000, transactionSubmittedHostMs: 1000, numberedFrames: hz * ms / 1000, cadenceInstalled: true,
      stationary: { ...bare, animationKeys: [] }, layerState: { ...bare, animationKeys: ['contents'] } } };
}
