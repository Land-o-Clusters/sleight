import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const recipes = JSON.parse(readFileSync(new URL('./fixtures/compound-mutations.json', import.meta.url), 'utf8'));
test('all 72 named cases have specific, current guard edits', t => {
  const cases = recipes.filter(r => r.name.startsWith('case-'));
  assert.deepEqual(cases.map(r => r.name).sort(), Array.from({ length: 72 }, (_, i) => `case-A${String(i + 1).padStart(2, '0')}`).sort());
  const distinct = new Set(cases.map(r => JSON.stringify(r.edits)));
  assert.equal(distinct.size, 57);
  for (const recipe of recipes) for (const edit of recipe.edits) {
    assert.doesNotMatch(edit.old, /export function requireCompound/);
    assert.doesNotMatch(edit.new, /if \(code ===/);
    const source = readFileSync(new URL('../' + edit.file, import.meta.url), 'utf8');
    assert.equal(source.split(edit.old).length - 1, 1, recipe.name);
  }
  t.diagnostic(`case recipes=${cases.length}; distinct case guard variants=${distinct.size}; all recipes=${recipes.length}`);
});
test('explorer recipes name all three additional oracle events', () => {
  assert.deepEqual(recipes.filter(r => ['explorer-reservation', 'explorer-recipient', 'explorer-dispatch'].includes(r.name))
    .map(r => r.oracle).sort(), ['dispatch-without-app-reservation', 'dispatch-after-observed-recipient-change', 'dispatch-after-physical-input'].sort());
});
