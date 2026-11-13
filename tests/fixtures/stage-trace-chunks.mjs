import assert from 'node:assert/strict';

// Keep each native journal under its unchanged bound while retaining every transaction in the audit.
export function stageTraceLines(lines, count = 128) {
  const out = [{ dumpTrace: true }];
  for (const [i, line] of lines.entries()) {
    out.push(line);
    if ((i + 1) % count === 0) out.push({ dumpTraceRead: true }, { dumpTrace: true });
  }
  return [...out, { dumpTraceRead: true }];
}
export function collectStageTrace(rows) {
  const chunks = rows.filter(r => r.effect === 'stage-trace');
  assert.ok(chunks.length, 'missing trace chunks');
  assert.ok(chunks.every(c => c.complete === true), 'every bounded trace chunk must be complete');
  const records = chunks.flatMap(c => c.records).map((r, order) => ({ ...r, order }));
  return { schema: 'sleight.stage-trace/1', complete: true, chunks: chunks.length,
    bytes: chunks.reduce((n, c) => n + c.bytes, 0), records };
}
