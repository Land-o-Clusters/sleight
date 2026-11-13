// Offline assertions shared by the live reread harness and its captured fixture.
import assert from 'node:assert/strict';
import { basename } from 'node:path';

export function assertReviewDiff(listing, before, after) {
  const lines = listing.split('\n');
  assert.ok(lines.some((line, index) => line === `  -${before}` && lines[index + 1] === `  +${after}`),
    'the complete indented before/after pair must appear in the review');
}

export function assertRereadReview(listing, path) {
  const section = listing.split(/\n\n(?= {2}[^\n]+: \/[^\n]+\nDecision: )/)
    .find(text => text.startsWith(`  ${basename(path)}: ${path}\nDecision: `));
  assert.ok(section, 'the touched document must appear in the review list');
  assert.match(section, /^Undo starts at the later copy taken after a fresh read\. Earlier changes are not captured\.$/m);
  assertReviewDiff(section, 'alpha beta gamma', 'alpha delta gamma');
  return section;
}
