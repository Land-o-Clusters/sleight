import { packageSkip } from './requirements.mjs';
const parserSkip = packageSkip('typescript');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function run(file, args) {
  const child = spawnSync(process.execPath, ['--max-old-space-size=512', '--experimental-vm-modules',
    fileURLToPath(new URL(`../bench/code-ast/${file}`, import.meta.url)), ...args.map(String)], { encoding: 'utf8', timeout: 30000 });
  assert.ok([0, 1].includes(child.status), child.stderr);
  const entries = child.stdout.trim().split('\n').map(JSON.parse);
  const counts = entries.find(entry => entry.tested !== undefined);
  assert.ok(counts);
  return { counts, differences: entries.filter(entry => entry.case !== undefined), variants: entries.find(entry => entry.generatedByVariant)?.generatedByVariant };
}
for (const [name, file, args] of [
  ['structured', 'differential.mjs', (count, offset) => [3, count, offset]],
  ['reviewer fuzz plain', 'reviewer/fuzz.mjs', (count, offset) => [1, count, 'plain', offset]],
  ['reviewer fuzz HTML', 'reviewer/fuzz.mjs', (count, offset) => [2, count, 'html', offset]],
  ['reviewer fuzz2 plain', 'reviewer/fuzz2.mjs', (count, offset) => [1, count, 'plain', offset]],
  ['reviewer fuzz2 HTML', 'reviewer/fuzz2.mjs', (count, offset) => [2, count, 'html', offset]],
  ['corpus statements', 'corpus-shaped.mjs', (count, offset) => [count, offset]],
]) test(`bounded fuzz preserves the exact seed sequence: ${name}`, { skip: parserSkip }, () => {
  const whole = run(file, args(40, 0));
  const pieces = [run(file, args(20, 0)), run(file, args(20, 20))];
  for (const [key, value] of Object.entries(whole.counts)) if (typeof value === 'number')
    assert.equal(pieces.reduce((sum, piece) => sum + piece.counts[key], 0), value, key);
  assert.deepEqual(pieces.flatMap(piece => piece.differences), whole.differences);
  if (whole.variants) assert.deepEqual(whole.variants.map((_, index) => pieces.reduce((sum, piece) => sum + piece.variants[index], 0)), whole.variants);
});
