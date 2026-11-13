import assert from 'node:assert/strict';

// Swift mangles symbol names. Scan stable protocol literals in both compiled hosts.
export const stagePointerBenchStrings = Object.freeze([
  'stage-pointer-input/1', 'pointer-input-unavailable',
]);
export function assertStagePointerStrings(text, bench) {
  for (const value of stagePointerBenchStrings)
    assert.equal(text.includes(value), bench, value + (bench ? ' must be present in the bench control' : ' must be compiled out'));
}
