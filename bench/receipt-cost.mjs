// Offline bookkeeping measurement. No app access, engine reads or receipt files.
import { performance } from 'node:perf_hooks';
import { TurnJournal } from '../plugins/sleight/lib/turn-receipts.mjs';

const count = 2000;
const text = 'Window: "Receipt fixture", App: TextEdit.\n0 window\n1 text area, Value: fixture';
const requests = Array.from({ length: count }, (_, id) => ({ id, method: 'tools/call',
  params: { name: 'js', arguments: { code: id ? 'await app.typeText("fixture")' : 'let app = await cua.getApp("TextEdit")' } } }));
const replies = requests.map(({ id }) => ({ id, result: { content: [{ type: 'text', text }] } }));
function sample() {
  const journal = new TurnJournal();
  const start = performance.now(), cpu = process.cpuUsage();
  for (let i = 0; i < count; i++) {
    journal.request(requests[i]); journal.observe(i, text); journal.reply(replies[i]);
  }
  const captureCPU = process.cpuUsage(cpu), captureMs = performance.now() - start;
  const flushStart = performance.now(), flushCPU = process.cpuUsage();
  const receipt = journal.finish({ review: true });
  const endedCPU = process.cpuUsage(flushCPU);
  return { calls: receipt.calls.length, captureMs, captureCPUus: captureCPU.user + captureCPU.system,
    captureCPUusPerCall: (captureCPU.user + captureCPU.system) / count,
    turnEndMs: performance.now() - flushStart, turnEndCPUus: endedCPU.user + endedCPU.system };
}
sample(); // Warm the same path once, separately from the reported samples.
const samples = Array.from({ length: 7 }, sample);
console.log(JSON.stringify({ kind: 'offline journal cost, no engine or model', callsPerSample: count,
  samples, medianCaptureCPUusPerCall: samples.map(s => s.captureCPUusPerCall).sort((a, b) => a - b)[3],
  extraEngineReads: 0, caveat: 'Synthetic capture references and turn-end parsing only; excludes receipt file I/O, engine work and Codex comparison.' }, null, 2));
