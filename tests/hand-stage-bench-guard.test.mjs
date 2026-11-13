import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const host = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url);

// A stageBench token is legal only in the taken branch of #if SLEIGHT_STAGE_BENCH.
// #else and #elseif of that guard are outside, and so is every other region.
export function stageBenchOutside(source) {
  const stack = [];
  const outside = [];
  source.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#if')) {
      const bench = /\bSLEIGHT_STAGE_BENCH\b/.test(trimmed) && !trimmed.includes('!SLEIGHT_STAGE_BENCH');
      stack.push({ bench, elseBranch: false });
      return;
    }
    if (trimmed.startsWith('#elseif') || trimmed.startsWith('#else')) {
      if (stack.length) stack[stack.length - 1].elseBranch = true;
      return;
    }
    if (trimmed.startsWith('#endif')) {
      stack.pop();
      return;
    }
    const guarded = stack.some(frame => frame.bench && !frame.elseBranch);
    if (guarded) return;
    const matches = line.match(/\bstageBench[A-Za-z0-9_]*/g);
    if (matches) outside.push({ line: index + 1, matches });
  });
  return outside;
}

const pointerSite = `#if SLEIGHT_STAGE_BENCH
            stageBenchPointerObserved?(effects, pointerPanelID, pointerBox, enteredAt)
#endif`;

test('every stageBench token in consent-host sits inside SLEIGHT_STAGE_BENCH', () => {
  let source = readFileSync(host, 'utf8');
  if (process.env.CHV4O_GUARD_BROKEN === 'shipped-cause-field') {
    const field = '    var stageBenchInstallCause = "startup"';
    assert.ok(source.includes(field));
    source = source.replace(field, '#endif\n' + field + '\n#if SLEIGHT_STAGE_BENCH');
  }
  assert.deepEqual(stageBenchOutside(source), []);
  const moved = source.replace(pointerSite, `#endif
            stageBenchPointerObserved?(effects, pointerPanelID, pointerBox, enteredAt)`);
  assert.notEqual(moved, source, 'the broken variant moves one call');
  assert.equal(source.split(pointerSite).length, 2, 'one pointer observation site');
  const hits = stageBenchOutside(moved);
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].matches, ['stageBenchPointerObserved']);
  assert.throws(() => assert.deepEqual(stageBenchOutside(moved), []), assert.AssertionError);
});
