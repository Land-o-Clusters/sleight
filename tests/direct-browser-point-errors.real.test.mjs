import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, skip } from './fixtures/cr4-real.mjs';
import { snapshot, acknowledgeSnapshot } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';

process.env.SLEIGHT_POINT_INPUT = '1';
test('point action errors omit a downstream script stack', { skip, timeout: 60000 }, async t => {
  const f = await fixture(t, '<canvas width="400" height="200"></canvas>');
  const page = f.entry.page, read = await snapshot(page);
  assert.equal(acknowledgeSnapshot(page, read.number), true);
  const run = createActionRunner({ snapshot, check: () => ({ verdict: 'allow' }),
    backgroundClick: async () => { throw Error('Fixture refused input.\n    at STACK_MARKER (<anonymous>:1:1)'); } });
  const result = await run(f.entry, [{ do: 'click', x: 70, y: 50, view: read.viewSignature }], {}, { observe: 'none' });
  assert.match(result.lines[0], /not run: Fixture refused input\./);
  assert.doesNotMatch(result.lines[0], /STACK_MARKER|<anonymous>/);
});
