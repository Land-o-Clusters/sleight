import { existsSync } from 'node:fs';
import { createReadCompactor, GUARD_MARK, GUARD_END } from '../../plugins/sleight/lib/compact-reads.mjs';

if (!global.gc) throw new Error('Run with --expose-gc');
const c = createReadCompactor();
const text = text => ({ type: 'text', text });
const tree = value => ['Window: "memory.txt", App: TextEdit.',
  '0 standard window memory.txt, URL: file:///tmp/memory.txt',
  ...Array.from({ length: 2998 }, (_, i) => `\t${i + 1} text field Field ${i}, Value: ${i === 2997 ? value : 'a'}`)].join('\n');
c.process([text(tree('start'))]);
const actions = 400;
const heap = () => { global.gc(); return process.memoryUsage().heapUsed; };
const before = heap();
for (let i = 0; i < actions; i++) {
  if (existsSync('/tmp/sleight-hold')) throw new Error('sleight-hold exists; memory test stopped');
  c.process([text(GUARD_MARK + tree(String(i)) + GUARD_END)], { action: c.beginAction('await app.typeText("x")') });
}
const after = heap();
// Keep the compactor live across the final collection.
if (!c.beginAction('await app.typeText("next")')) throw new Error('Compactor is missing');
console.log(JSON.stringify({ actions, lines: 3000, before, after, retainedBytes: after - before }));
