// Synthetic retained-read memory at 200 calls. No engine, app or disk access.
import { TurnJournal } from '../plugins/sleight/lib/turn-receipts.mjs';
import { performance } from 'node:perf_hooks';

if (!global.gc) throw new Error('Run node --expose-gc bench/receipt-memory.mjs');
const calls = 200, bytesPerRead = 64 * 1024;
function sample() {
  global.gc();
  const baseline = process.memoryUsage().heapUsed;
  const journal = new TurnJournal({ ownerNames: [] }), retained = [];
  let readBytes = 0;
  for (let id = 0; id < calls; id++) {
    const code = id ? 'await app.getAXState()' : 'let app = await cua.getApp("TextEdit")';
    journal.request({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } });
    // Flatten distinct strings so this measures retained reads, not one shared fixture string.
    const head = `Window: "Fixture", App: TextEdit.\n0 window\n1 text area, Value: ${id}:`;
    const text = Buffer.from(head + 'x'.repeat(bytesPerRead - head.length)).toString();
    readBytes += Buffer.byteLength(text);
    journal.observe(id, text);
    retained.push(journal.calls.get(id));
    journal.reply({ id, result: { content: [] } });
  }
  global.gc();
  const heldHeapBytes = process.memoryUsage().heapUsed - baseline;
  const start = performance.now();
  const receipt = journal.finish();
  const finishMs = performance.now() - start;
  global.gc();
  return { calls: receipt.calls.length, readBytes, heldHeapBytes,
    afterFinishHeapBytes: process.memoryUsage().heapUsed - baseline, finishMs,
    rawReadBytesAfterFinish: retained.reduce((n, call) => n + Buffer.byteLength(call.text ?? ''), 0) };
}
console.log(JSON.stringify({ kind: 'synthetic turn read retention', calls, bytesPerRead,
  samples: Array.from({ length: 5 }, sample),
  limits: 'Heap deltas include journal objects and GC noise, exclude engine/relay allocations and file I/O. External call references remain held to check raw-text release.' }, null, 2));
