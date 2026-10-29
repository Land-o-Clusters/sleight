// Offline transcript audit. Imports no fixture driver, launcher, host or engine transport.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { fieldWrites, writeFields, wrongFieldEffects } from '../../plugins/sleight/lib/write-effect.mjs';
import { documentKey, windowFromText } from '../../plugins/sleight/lib/document-scope.mjs';

// Only numbered full trees and the compactor's explicit +/- lines can rebuild a baseline.
// Missing or ambiguous deletions invalidate it. Retained hidden/omitted lines are not invented.
export function materialize(text, previous) {
  const starts = [...text.matchAll(/^Window: /gm)];
  let latest;
  for (const [index, start] of starts.entries()) {
    const slice = text.slice(start.index, starts[index + 1]?.index), window = windowFromText(slice);
    if (!window) continue;
    const key = documentKey(window), lines = slice.split('\n');
    const diff = /sleight: lines changed since the last full tree/.test(slice);
    const numbered = lines.filter(line => /^\t*\d+ /.test(line));
    const byNumber = new Map(); let conflict = false;
    for (const row of numbered) {
      const number = /^\t*(\d+) /.exec(row)[1];
      if (byNumber.has(number) && byNumber.get(number) !== row) conflict = true;
      byNumber.set(number, row);
    }
    const rows = [...byNumber.values()];
    if (/sleight: no change since/.test(slice) && previous?.key === key) latest = previous;
    else if (!diff && !conflict && /^0 (?:standard window|window|sheet|dialog|floating window)\b/.test(rows[0] ?? '')) {
      latest = { key, text: [lines[0], ...rows].join('\n') };
    } else if (diff && previous?.key === key) {
      const old = previous.text.split('\n').slice(1);
      let valid = true;
      for (const line of lines) {
        if (line.startsWith('- ')) {
          const body = line.slice(2), numbered = /^\t*\d+ /.test(body);
          if (!body.trim() || /^The focused UI element is /.test(body)) continue;
          const matches = old.flatMap((row, i) => (numbered ? row === body : row.replace(/^(\t*)\d+ /, '$1') === body) ? [i] : []);
          if (matches.length !== 1) { valid = false; break; }
          old.splice(matches[0], 1);
        }
      }
      if (valid) {
        for (const line of lines) if (/^\+ \t*\d+ /.test(line)) {
          const row = line.slice(2), number = /^\t*(\d+) /.exec(row)[1];
          const at = old.findIndex(r => /^\t*(\d+) /.exec(r)?.[1] === number);
          if (at >= 0) old[at] = row; else old.push(row);
        }
        old.sort((a, b) => Number(/^\t*(\d+) /.exec(a)?.[1]) - Number(/^\t*(\d+) /.exec(b)?.[1]));
        latest = { key, text: [lines[0], ...old].join('\n') };
      }
    } else if (/sleight: no change since/.test(slice) && previous?.key === key) latest = previous;
    previous = latest;
  }
  return latest;
}

export function auditTranscript(source, { onCall = () => {} } = {}) {
  const rows = source.trim().split('\n').filter(Boolean).map(JSON.parse), pending = new Map();
  const result = { calls: 0, writeCalls: 0, comparableCalls: 0, correctCalls: 0, correctCallFlags: 0, correctWrites: 0, correctFlags: 0, flags: [], skippedWrites: 0 };
  let previous;
  const start = block => {
    for (const call of pending.values()) call.overlap = true;
    const code = block.input?.code ?? block.arguments?.code;
    pending.set(block.id, { code, before: previous, overlap: pending.size > 0 });
  };
  const finish = (id, content, failed) => {
    const call = pending.get(id); if (!call) return;
    pending.delete(id); result.calls++;
    const text = typeof content === 'string' ? content : (content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
    const after = materialize(text, previous);
    onCall({ number: result.calls, call, after, text, failed });
    const writes = fieldWrites(call.code, call.before?.text);
    if (writes.length) {
      result.writeCalls++;
      if (!call.overlap && !failed && after && call.before?.key === after.key) {
        result.comparableCalls++;
        const effects = wrongFieldEffects(call.code, call.before.text, after.text), fields = writeFields(after.text);
        const correct = writes.filter(w => {
          const matches = fields.filter(f => f.path === w.target.path);
          return matches.length === 1 && matches[0].value === w.value;
        });
        result.correctWrites += correct.length;
        if (correct.length === writes.length) { result.correctCalls++; result.correctCallFlags += effects.length; }
        result.correctFlags += correct.filter(w => effects.some(e => e.requested === w.target.number && e.method === w.method)).length;
        result.flags.push(...effects.map(({ method, requested, received, isError }) => ({ call: result.calls, method, requested, received, isError })));
      } else result.skippedWrites += writes.length;
    }
    previous = call.overlap ? undefined : after;
  };
  for (const row of rows) {
    for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
      if (block.type === 'tool_use' && /^mcp__plugin_sleight_computer__/.test(block.name)) start(block);
      if (block.type === 'tool_result') finish(block.tool_use_id, block.content, block.is_error || row.tool_use_result?.isError);
    }
    const item = row.item;
    if (item?.type === 'mcp_tool_call' && /sleight/.test(item.server ?? '')) {
      if (row.type === 'item.started') start({ ...item, arguments: typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments });
      if (row.type === 'item.completed') finish(item.id, item.result?.content, item.status === 'failed' || item.result?.isError);
    }
  }
  return result;
}

function* transcripts(root) {
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* transcripts(path);
    else if (entry.isFile() && ['events.jsonl', 'transcript.jsonl'].includes(entry.name)) yield path;
  }
}

export function auditBank(root) {
  const totals = { transcripts: 0, calls: 0, writeCalls: 0, comparableCalls: 0, correctCalls: 0, correctCallFlags: 0, correctWrites: 0, correctFlags: 0, skippedWrites: 0, flags: [], digest: '' };
  const hash = createHash('sha256');
  for (const path of transcripts(root)) {
    const source = readFileSync(path, 'utf8'), report = auditTranscript(source), relative = path.slice(root.length + 1);
    hash.update(relative).update('\0').update(createHash('sha256').update(source).digest()); totals.transcripts++;
    for (const key of ['calls', 'writeCalls', 'comparableCalls', 'correctCalls', 'correctCallFlags', 'correctWrites', 'correctFlags', 'skippedWrites']) totals[key] += report[key];
    totals.flags.push(...report.flags.map(flag => ({ transcript: relative, ...flag })));
  }
  totals.digest = hash.digest('hex');
  return totals;
}

export function verifyBankReports(reports) {
  if (reports.length !== 2 || reports.some(r => !r.correctWrites || r.correctFlags !== 0 || r.correctCallFlags !== 0)) throw Error('Correct-write control audit failed');
  const cases = [
    ['validation-150f-rel2', 'race-safari-A-r3/form-checkout/events.jsonl', 7],
    ['validation-150f-rel3', 'race-safari-A-r2/form-checkout/events.jsonl', 6],
    ['validation-150f-rel3', 'race-safari-B-r1/form-checkout/events.jsonl', 6],
    ['validation-150f-rel3', 'race-safari-B-r3/form-checkout/events.jsonl', 9],
    ['validation-150f-rel3', 'race-safari-B-r3/form-checkout/events.jsonl', 11],
  ];
  for (const [bank, transcript, call] of cases) {
    const flag = reports.find(r => r.bank === bank)?.flags.find(f => f.transcript === transcript && f.call === call);
    if (!flag || flag.requested !== 26 || flag.received !== 53 || flag.isError !== false)
      throw Error('A recorded wrong-field case did not receive the plain notice');
  }
  if (reports.reduce((sum, report) => sum + report.flags.length, 0) !== cases.length)
    throw Error('Recorded-bank flag count changed');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), outAt = args.indexOf('--out');
  const out = outAt < 0 ? undefined : args.splice(outAt, 2)[1];
  const assertAt = args.indexOf('--assert-recordings'), verify = assertAt >= 0;
  if (verify) args.splice(assertAt, 1);
  const reports = args.map(root => ({ bank: basename(resolve(root)), ...auditBank(resolve(root)) }));
  if (verify) verifyBankReports(reports);
  if (out) writeFileSync(out, JSON.stringify({ offline: true, reports }, null, 2) + '\n');
  for (const report of reports) console.log(JSON.stringify(report));
}
