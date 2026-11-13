import { stageSurfaceObservation } from '../../bench/hand/stage-surface.mjs';
import { stageScriptDigest } from '../../bench/hand/stage-measurement.mjs';
import { stageSequence } from '../../bench/hand/stage-cost.mjs';
import { cursorWire } from '../../bench/hand/cursor-sequence.mjs';

export function stageSurfaceFixture({ panel = true, surface = 'changing', boundary = 'active-start' } = {}) {
  const bounds = { x: 0, y: 0, width: 1500, height: 950 }, changing = surface === 'changing';
  const snapshot = { pid: 42, fixtureIDs: [7, 8, 9],
    fixtureWindows: [7, 8, 9].map(id => ({ id, ignoresMouseEvents: changing, canBecomeKey: false, canBecomeMain: false })),
    panelID: panel ? 77 : null, panel: panel ? { x: 900, y: 400, width: 200, height: 220 } : null,
    backdrop: { id: 6, bounds, raised: changing, visible: changing, level: changing ? 1 : -1,
      ignoresMouseEvents: true, canBecomeKey: false, canBecomeMain: false } };
  const windows = [
    ...panel ? [{ id: 77, pid: 42, layer: 3, alpha: 1, bounds: snapshot.panel }] : [],
    ...snapshot.fixtureIDs.map(id => ({ id, pid: 42, layer: changing ? 2 : 0, alpha: 1,
      bounds: { x: 50 * id, y: 600, width: 500, height: 300 } })),
    ...changing ? [{ id: 6, pid: 42, layer: 1, alpha: 1, bounds }] : [],
    { id: 100, pid: 99, layer: 0, alpha: 1, bounds },
  ];
  return { ...stageSurfaceObservation(snapshot, { windows, observedAtMs: 100 },
    { surface, requiresPanel: panel, startedAtMs: 99, completedAtMs: 101 }), boundary };
}
export function stageSurfaceChecksFixture(surface, panel = true) {
  return (panel ? ['active-start', 'active-end', 'parked-start', 'parked-end'] : ['active-start', 'active-end'])
    .map(boundary => stageSurfaceFixture({ surface, panel, boundary }));
}
export const measurementWindows = [{ pid: 42, id: 7, bounds: { x: 30, y: 592, width: 666, height: 350 } },
  { pid: 42, id: 8, bounds: { x: 816, y: 592, width: 666, height: 350 } }];
export function recordedActions(windows = measurementWindows, stress = false) {
  const wire = cursorWire();
  return stageSequence(windows, { stress }).steps.map((s, order) => ({ order, scheduledMs: s.atMs, dispatchedMs: s.atMs,
    frame: JSON.parse(wire[s.type](s.args)) }));
}
export function stageScriptFixture(surface, size) {
  const actions = recordedActions(), windows = measurementWindows;
  return { surface, size, changing: surface === 'changing', actions, windows, scriptDigest: stageScriptDigest(actions, windows) };
}
