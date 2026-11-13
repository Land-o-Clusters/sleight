// Offline timing of partial-print detection. No apps or native helpers run.
import { performance } from 'node:perf_hooks';
import { createMacReadState } from '../plugins/sleight/lib/mac-driver/diff.mjs';

const window = { windowId: '101', pid: 120, processStart: '100.25', bundleId: 'org.test.timing',
  app: 'Editor', title: 'Draft', identityVerified: true };
const tree = 'Window: "Draft", App: Editor.\n0 standard window Draft\n' +
  Array.from({ length: 2500 }, (_, i) => `\t${i + 1} button Row ${i}, ID: row-${i}`).join('\n');
const print = ('unrelated output ' + 'x'.repeat(82) + '\n').repeat(1000);
const text = value => ({ type: 'text', text: value });
const results = [];
for (const options of [{ compact: false }, { compact: true }, { compact: false, allowDelivery: false }]) {
  const milliseconds = [];
  for (let sample = 0; sample < 6; sample++) {
    const state = createMacReadState();
    const snapshot = state.read({ window, readId: 1, text: tree, truncated: false });
    state.endCell([text(tree)], [snapshot]);
    const start = performance.now();
    const batch = state.prepareDisplay([text(print)], [snapshot], options);
    const elapsed = performance.now() - start;
    batch.commit();
    if (sample > 0) milliseconds.push(elapsed);
  }
  results.push({ ...options, allowDelivery: options.allowDelivery ?? true, milliseconds,
    medianMs: milliseconds.toSorted((a, b) => a - b)[2] });
}
process.stdout.write(JSON.stringify({ rows: 2500, treeBytes: Buffer.byteLength(tree),
  printBytes: Buffer.byteLength(print), samples: 5, warmups: 1, results }, null, 2) + '\n');
