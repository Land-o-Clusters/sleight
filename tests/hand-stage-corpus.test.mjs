import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const url = new URL('./fixtures/stage-stateful-fuzz.mjs', import.meta.url);
let source = readFileSync(url, 'utf8');
if (process.env.CHRET4_CORPUS_VARIANT === 'count-repeated-seeds-as-distinct') {
  const changed = source.replace(': seed % 31', ': seed');
  assert.notEqual(changed, source, 'corpus mutation site'); source = changed;
}
const { stageObligationCase } = await import(process.env.CHRET4_CORPUS_VARIANT ? 'data:text/javascript;base64,' + Buffer.from(source).toString('base64') : url.href);

test('one thousand obligation seeds execute only 248 distinct scripts with 31 offsets', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => stageObligationCase(i));
  assert.equal(new Set(rows.map(r => `${r.mode}:${r.jitter}`)).size, 248, 'corpus must count distinct sequences');
  assert.equal(new Set(rows.map(r => r.mode)).size, 8);
  assert.equal(new Set(rows.map(r => r.jitter)).size, 31);
  assert.deepEqual(rows[248], { ...rows[0], seed: rows[248].seed });
});

test('area protection uses one thousand distinct scripts and offsets', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => stageObligationCase(i, undefined, true));
  assert.equal(new Set(rows.map(r => `${r.mode}:${r.jitter}`)).size, 1000);
  assert.equal(new Set(rows.map(r => r.mode)).size, 18);
  assert.equal(new Set(rows.map(r => r.jitter)).size, 56);
});
