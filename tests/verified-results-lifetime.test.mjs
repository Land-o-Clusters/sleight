import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../plugins/sleight/lib/compact-reads.mjs';

const text = text => ({ type: 'text', text });
const tree = rows => ['Window: "a.txt", App: TextEdit.',
  '0 standard window a.txt, URL: file:///tmp/a.txt', ...rows].join('\n');
const rows = Array.from({ length: 60 }, (_, i) => `\t${i + 2} link Story ${i}`);
const window = { title: 'a.txt', app: 'TextEdit', url: 'file:///tmp/a.txt' };

test('400 actions on a 3,000-line tree retain less than 12 MiB of extra heap', t => {
  const result = JSON.parse(execFileSync(process.execPath, ['--expose-gc',
    fileURLToPath(new URL('./fixtures/verified-results-memory.mjs', import.meta.url))], { encoding: 'utf8', timeout: 120000 }));
  t.diagnostic(JSON.stringify(result));
  assert.ok(result.retainedBytes < 12 * 1024 * 1024, `${result.retainedBytes} retained bytes over ${result.actions} actions`);
});

test('reset clears result attribution while retaining numbered element checks and remapping', () => {
  const c = createReadCompactor();
  c.process([text(tree(rows))]);
  const grown = tree(['\t2 link Breaking story', ...rows.map(line => line.replace(/\d+/, n => +n + 1))]);
  c.process([text(GUARD_MARK + grown + GUARD_END)]);
  c.reset();
  assert.deepEqual(c.seenLines(window, [14]), { 14: 'link Story 12' });
  assert.deepEqual(c.staleIndex(window, 'await app.click(14)'), { number: 14 });
  assert.deepEqual(c.remapStale(window, 'await app.click(14)').remapped, [{ number: 14, line: 'link Story 12' }]);
  const result = c.process([text(GUARD_MARK + grown + GUARD_END)], { action: c.beginAction('await app.typeText("x")') });
  assert.match(result.at(-1).text, /UI unverified \(no earlier read\)/);
});

test('unknown roots and lost URLs cannot report window or element changes, including full reads', () => {
  const before = tree(['\t14 button Fourteen', '\t15 text field Value: before']);
  for (const code of ['await app.click(14)', 'await app.pressKey("super+s")']) {
    for (const forceFull of [false, true]) {
      for (const after of [
        before.replace('standard window a.txt, URL: file:///tmp/a.txt', 'unknown'),
        before.replace('standard window a.txt, URL: file:///tmp/a.txt', 'unknown, URL: file:///tmp/a.txt'),
        before.replace(', URL: file:///tmp/a.txt', ''),
      ]) {
        const c = createReadCompactor(); c.process([text(before)]);
        const result = c.process([text(GUARD_MARK + after + GUARD_END)], { action: c.beginAction(code), forceFull });
        assert.match(result.at(-1).text, /UI unverified \(degraded read\)/);
        assert.doesNotMatch(result.at(-1).text, /UI changed|saved: observed/);
      }
    }
  }
});

test('a degraded root cannot become a trusted baseline for the next action', () => {
  const before = tree(['\t14 button Fourteen']);
  const c = createReadCompactor(); c.process([text(before)]);
  c.process([text(GUARD_MARK + before.replace('standard window a.txt', 'unknown') + GUARD_END)], { action: c.beginAction('await app.click(14)') });
  const result = c.process([text(GUARD_MARK + before + GUARD_END)], { action: c.beginAction('await app.click(14)') });
  assert.match(result.at(-1).text, /UI unverified \(no earlier read\)/);
});

test('repeated URL-less observations in one reply cannot hide the lost URL', () => {
  const before = tree(['\t14 button Fourteen']);
  const after = before.replace(', URL: file:///tmp/a.txt', '');
  for (const forceFull of [false, true]) {
    const guard = GUARD_MARK + after + GUARD_END;
    for (const content of [[text(after + '\n' + guard)], [text(after), text(guard)], [text(guard + guard)]]) {
      const c = createReadCompactor(); c.process([text(before)]);
      const result = c.process(content, { action: c.beginAction('await app.pressKey("super+s")'), forceFull });
      assert.match(result.at(-1).text, /UI unverified \(degraded read\)/);
      assert.doesNotMatch(result.at(-1).text, /UI changed|saved: observed/);
    }
  }
});

test('the abbreviated Save fixture retains its root and no sidebar rows', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/verified-results.json', import.meta.url))).save;
  assert.match(fixture.before, /0 sheet Description: save, ID: save-panel/);
  assert.doesNotMatch(fixture.before, /row \(selectable\)|outline sidebar/);
});
