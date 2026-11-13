import { replWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture } from './fixtures/gls2-runtime.mjs';

const seven = readFileSync(new URL('./fixtures/glc2-calculator-after-seven.txt', import.meta.url), 'utf8');
const zero = seven.replace('StandardInputView;value:7', 'StandardInputView;value:0')
  .replace('Edit field, Value: 7', 'Edit field, Value: 0').replace('Clear, ID: Clear', 'All Clear, ID: AllClear');
const text = result => result.content.map(item => item.text ?? '').join('\n');

test('GLINT5 real client post read seeds only the next first admission and delivers changed lines', { skip: replWorkerSkip }, async t => {
  const f = await fixture(t, { initial: zero, afterClick: () => seven, plainAction: true, wireClient: true });
  const acquired = await f.js('let app = await cua.getApp("Calculator");');
  assert.equal(acquired.isError, false, text(acquired));
  const initial = f.calls.filter(row => row.method === 'getAXState').at(-1);
  assert.equal(initial.params.reuseIfUnchanged, 0);
  let before = f.calls.length;
  const first = await f.js('await app.click({id:"Seven"});');
  assert.equal(first.isError, false, text(first));
  assert.match(text(first), /^- .*Edit field, Value: 0$/m);
  assert.match(text(first), /^\+ .*Edit field, Value: 7$/m);
  const reads = f.calls.slice(before).filter(row => row.method === 'getAXState');
  assert.equal(reads.length, 2, 'one admission and one post read');
  assert.equal(reads[0].params.reuseIfUnchanged, 1);
  assert.equal(reads[1].params.reuseIfUnchanged, 0, 'the post read walks and seeds a new proof');
  assert.ok(first.timing.actions.at(-1).postReadMs > 0);
  before = f.calls.length;
  const next = await f.js('await app.click({id:"One"}); await app.click({id:"Equals"});');
  assert.equal(next.isError, false, text(next));
  const following = f.calls.slice(before).filter(row => row.method === 'getAXState');
  assert.equal(following.length, 3, 'two admission reads and one post read');
  assert.equal(following[0].params.reuseIfUnchanged, 3, 'the next cell uses the post read');
  assert.equal(following[1].params.reuseIfUnchanged, undefined, 'the second action cannot reuse the first proof');
  assert.equal(following[2].params.reuseIfUnchanged, 0);
  assert.doesNotMatch(text(next), /"(?:delivery|timing|retry|window)":/);
});
