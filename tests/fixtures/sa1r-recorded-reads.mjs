// Compare classifications only. Recorded cells never execute here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

export function assertRecordedReads(isFilteredRead) {
  const root = new URL('./', import.meta.url);
  const baseline = JSON.parse(readFileSync(new URL('sa1r-recorded-read-baseline.json', root), 'utf8'));
  const files = readdirSync(root).filter(n => /replay.*\.json$/.test(n)).map(n => new URL(n, root));
  for (const name of readdirSync(new URL('replay/', root)).filter(n => n.endsWith('.jsonl'))) files.push(new URL('replay/' + name, root));
  const codes = [];
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'code' && typeof item === 'string') codes.push(item);
      else collect(item);
    }
  }
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const value of file.pathname.endsWith('.jsonl') ? text.trim().split('\n').map(JSON.parse) : [JSON.parse(text)]) collect(value);
  }
  const cells = [...new Set(codes)].map(code => ({ code, sha256: createHash('sha256').update(code).digest('hex') }));
  // RRD1: GLS2B adds 3 redeclaration cells; all 74 original hashes and verdicts stay pinned.
  assert.equal(cells.length, 77, 'refresh the baseline explicitly if the recorded corpus changes');
  assert.deepEqual(cells.map(c => c.sha256).sort(), baseline.cells.map(c => c.sha256).sort());
  let preserved = 0, refused = 0;
  for (const { code, sha256 } of cells) {
    const previous = baseline.cells.find(c => c.sha256 === sha256);
    const actual = isFilteredRead(code);
    if (previous.filteredRead) {
      // No recorded old-true cell is an audit payload or assignment exception.
      assert.equal(actual, true, code);
      preserved++;
    } else {
      // Old-false cells stay refused, so a looser classifier can't pass this check (sa1r review).
      assert.equal(actual, false, code);
      refused++;
    }
  }
  assert.equal(preserved, 2);
  assert.equal(refused, 75);
  return { cells: cells.length, preserved, refused };
}
