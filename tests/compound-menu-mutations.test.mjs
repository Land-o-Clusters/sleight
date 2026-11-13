import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('menu mutation recipes target current parent, retry, identity, enabled and ambiguity guards', () => {
  const rows = JSON.parse(readFileSync(new URL('./fixtures/compound-menu-mutations.json', import.meta.url), 'utf8'));
  assert.deepEqual(rows.map(r => r.name), ['direct-parent', 'direct-twice', 'direct-identity',
    'direct-enabled-filter', 'direct-ambiguity', 'direct-fallback']);
  for (const row of rows) for (const edit of row.edits) {
    const source = readFileSync(new URL('../' + edit.file, import.meta.url), 'utf8');
    assert.equal(source.split(edit.old).length - 1, 1, row.name);
    assert.notEqual(edit.new, edit.old);
  }
});
