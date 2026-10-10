import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routineApps } from '../plugins/sleight/lib/routines.mjs';

const script = code => ({ sleightReplay: 1, steps: [{ tool: 'js', args: { code } }] });

// A script recorded from Claude's session writes `{ id: "One" }`, never `{ "id": "One" }`, so no
// recorded script could become a routine (live routine test, 2026-10-10).
test('routines accept object arguments written as JavaScript, with literal values only', () => {
  const acquire = 'let calc = await cua.getApp("com.apple.calculator");\n';
  assert.deepEqual(routineApps(script(acquire + 'await calc.click({ id: "One" });\nawait calc.getAXState({ disableDiffing: true });')), ['com.apple.calculator']);
  assert.deepEqual(routineApps(script(acquire + 'await calc.click({ label: "Multiply, x" });')), ['com.apple.calculator']);
  assert.throws(() => routineApps(script(acquire + 'await calc.click({ id: someVariable });')), /routine step 1: .*JSON/);
  assert.throws(() => routineApps(script(acquire + 'await calc.click({ id: "One", extra: "x" });')), /routine step 1: .*selector/);
});
