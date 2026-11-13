import test from 'node:test';
import assert from 'node:assert/strict';
import { stageVerdict, reportMarkdown, STAGE_BUDGET } from '../bench/hand/stage-cost.mjs';

const observation = () => ({ panel: [110, 220, 90, 100], seat: [80, 180, 160, 180], move: [60, 160, 200, 220],
  drawing: { inkUnion: [111, 221, 88, 98], filterUnion: [110, 220, 90, 100],
    clip: [36, 116, 248, 308], required: [110, 220, 90, 100], positions: 3, geometries: 2, hasExtras: false } });
const result = panels => stageVerdict({ runs: [{ round: 1, sizes: { stage: { dump: { panels } } } }] });
const bar = panels => result(panels).runs[0].sizes.stage.checks.find(c => c.name === 'panel size');

test('CHV9 panel bar accepts an ink-enclosing crop and retains the old seat figure as diagnostic', () => {
  const p = observation(), check = bar([p]);
  assert.equal(check.verdict, 'pass');
  assert.equal(check.legacyPanelFits, false);
  assert.match(reportMarkdown(result([p])), /legacy seat plus move plus 48 pt: 0\/1/);
  assert.equal(STAGE_BUDGET.panelPaddingPt, 48);
});
for (const side of ['left', 'top', 'right', 'bottom']) {
  test('CHV9 panel one point short on ' + side + ' fails the ink and filter enclosure', () => {
    const p = observation();
    if (side === 'left') { p.panel[0] += 1; p.panel[2] -= 1; }
    if (side === 'top') { p.panel[1] += 1; p.panel[3] -= 1; }
    if (side === 'right') p.panel[2] -= 1;
    if (side === 'bottom') p.panel[3] -= 1;
    assert.equal(bar([p]).verdict, 'fail');
  });
}
test('CHV9 filter support and every motion endpoint remain required', () => {
  const p = observation();
  p.panel = [...p.drawing.inkUnion];
  assert.equal(bar([p]).verdict, 'fail');
  p.panel = [110, 220, 89.5, 100];
  assert.equal(bar([p]).verdict, 'fail');
  const missing = observation(); delete missing.drawing;
  assert.equal(bar([p, missing]).verdict, 'fail', 'missing evidence cannot erase a measured clip');
});
test('CHV9 extras retain their full drawing envelope', () => {
  const p = observation(); p.drawing.hasExtras = true; p.drawing.required = [...p.drawing.clip];
  p.panel = [...p.drawing.clip]; assert.equal(bar([p]).verdict, 'pass');
  p.panel[2] -= 1; assert.equal(bar([p]).verdict, 'fail');
});
test('CHV9 old banks have no crop proof and malformed live geometry fails', () => {
  const p = observation(); delete p.drawing;
  assert.equal(bar([p]).verdict, 'not-measured');
  assert.match(reportMarkdown(result([p])), /drawing bounds: not measured/);
  for (const change of [p => { p.drawing.required[2] -= 1; }, p => { p.drawing.positions = 0; },
    p => { p.drawing.filterUnion[0] = NaN; }, p => { p.drawing.clip = null; }]) {
    const bad = observation(); change(bad);
    assert.equal(bar([bad]).verdict, 'fail');
  }
});
