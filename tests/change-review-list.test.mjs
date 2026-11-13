import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRereadReview, assertReviewDiff } from '../bench/change-review-list.mjs';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChangeReview } from '../plugins/sleight/lib/change-review.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

function fixture(t) {
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-review-list-'))));
  const review = new ChangeReview();
  t.after(() => { review.dispose(); rmSync(root, { recursive: true, force: true }); });
  const keepPath = join(root, 'KEEP-fixture.txt'), path = join(root, 'REREAD-2-fixture.txt');
  const doc = path => ({ title: path.split('/').at(-1), app: 'TextEdit', url: pathToFileURL(path).href });
  writeFileSync(keepPath, 'before\n');
  const keep = review.before(doc(keepPath));
  writeFileSync(keepPath, 'after\n'); review.after(keep);
  writeFileSync(path, 'alpha beta gamma\n');
  review.uncaptured(doc(path));
  const reread = review.read(doc(path));
  writeFileSync(path, 'alpha delta gamma\n'); review.after(reread);
  return { listing: [keep, reread].map(entry => review.describe(entry)).join('\n\n'), path };
}

test('SA2K default review harness requires each complete indented diff pair', t => {
  const { listing } = fixture(t);
  assertReviewDiff(listing, 'before', 'after');
  assertReviewDiff(listing, 'alpha beta gamma', 'alpha delta gamma');
  for (const value of [listing.replace('  +after', '+after'), listing.replace('  -before', '-before'),
    listing.replace('  +after', '  +wrong'), listing.replace('  -before', '  -before extra')]) {
    assert.throws(() => assertReviewDiff(value, 'before', 'after'), /complete indented before\/after pair/);
  }
});

test('SA2K reread harness reads the real indented list and diff', t => {
  const { listing, path } = fixture(t);
  const section = assertRereadReview(listing, path);
  assert.ok(section.startsWith(`  REREAD-2-fixture.txt: ${path}\nDecision: pending`));
  assert.ok(!section.includes('KEEP-fixture.txt'));
});

test('SA2K reread harness requires the requested document and its complete diff', t => {
  const { listing, path } = fixture(t);
  assert.throws(() => assertRereadReview(listing, '/fixture/missing.txt'), /touched document/);
  assert.throws(() => assertRereadReview(listing, '/elsewhere/REREAD-2-fixture.txt'), /touched document/);
  for (const [from, to] of [
    ['  -alpha beta gamma\n  +alpha delta gamma', '-alpha beta gamma\n+alpha delta gamma'],
    ['  +alpha delta gamma', '  +alpha wrong gamma'],
    ['Undo starts at the later copy taken after a fresh read.', 'Undo starts at another copy.'],
  ]) assert.throws(() => assertRereadReview(listing.replace(from, to), path), { code: 'ERR_ASSERTION' });
  assert.throws(() => assertRereadReview(listing.replace('  REREAD-2-fixture.txt:', 'REREAD-2-fixture.txt:'), path), /touched document/);
});
