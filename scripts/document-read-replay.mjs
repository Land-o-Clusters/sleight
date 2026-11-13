// Offline VF1 replay. Reads recorded JSONL only, never imports the benchmark
// runner, loads an app, decodes a screenshot or writes recorded document text.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const screenshot = /\.(?:getScreenshot|getAXStateAndScreenshot)\s*\(/;
const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(item => item.type === 'text').map(item => item.text).join('\n') : '';

// Regex upper bound on recorded engine trees, without AX attributed strings.
// This never invokes the production document parser. Latest-tree carry-over
// can predate edits, and a screenshot may ask for structure the tree omits.
// Only the live check can measure the real share answered by structured reads.
export function classifyDocumentScreenshot({ code, tree = '', task = '', isError = false }) {
  const header = [...tree.matchAll(/^Window: .*?, App: (.*?)\.\s*$/gm)].at(-1);
  const app = header?.[1] ?? 'unrecorded';
  tree = header ? tree.slice(header.index) : '';
  if (isError) return { app, answered: false, reason: 'recorded-refusal-or-error' };
  if (/\.\s*(?:drag|dragTo|hover)\s*\(|\b(?:from|to|at)\s*:\s*\[|\.click\s*\(\s*\[/.test(code) ||
      /(?:chess|paint|image|screenshot|mirroring|simulator|window-drag|window-move|resize)/i.test(task))
    return { app, answered: false, reason: 'spatial-or-image-request' };
  // Plain control labels alone do not answer a document question. Exclude secure
  // trees and textless panes. Never assume every TextEdit/Word call is answered.
  const rows = tree.split('\n'), documentAt = rows.findIndex(line => /^\t*\d+ (?:text entry area|layout area|web area)\b/.test(line));
  if (documentAt < 0) return { app, answered: false, reason: 'no-recorded-document' };
  const depth = /^\t*/.exec(rows[documentAt])[0].length;
  const region = [rows[documentAt]];
  for (const line of rows.slice(documentAt + 1)) {
    const match = /^(\t*)\d+ /.exec(line);
    if (match && match[1].length <= depth) break;
    if (match) region.push(line);
  }
  if (region.some(line => /<redacted>|secure text field/.test(line))) return { app, answered: false, reason: 'protected-document' };
  if (region.join('\n').length > 4000) return { app, answered: false, reason: 'document-over-cap' };
  const readable = region.some(line => /\bValue: \S/.test(line) || /^\t*\d+ (?:text|heading) (?!entry area|field|<redacted>)[^\s,]/.test(line));
  return { app, answered: readable, reason: readable ? 'recorded-document-content' : 'empty-recorded-document' };
}

export function recordedCalls(transcript) {
  const calls = [], byID = new Map();
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue;
    let message; try { message = JSON.parse(line); } catch { continue; }
    const content = message.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (message.type === 'assistant' && block.type === 'tool_use') {
        const call = { tool: block.name.replace(/^mcp__plugin_sleight_computer__/, ''),
          at: message.timestamp ? Date.parse(message.timestamp) : null,
          isError: true,
          code: typeof block.input?.code === 'string' ? block.input.code : JSON.stringify(block.input ?? {}) };
        calls.push(call); byID.set(block.id, call);
      }
      if (message.type === 'user' && block.type === 'tool_result') {
        const call = byID.get(block.tool_use_id);
        if (call) { call.text = textOf(block.content); call.isError = block.is_error === true; }
      }
    }
  }
  return calls;
}

export function frozenRecordedCalls(calls, declared) {
  const key = call => JSON.stringify([call.tool.replace(/^sleight:/, '').replace(/^mcp__/, ''),
    call.at, call.codeChars ?? call.code.length, call.code.slice(0, 400)]);
  const remaining = new Map();
  for (const call of declared) remaining.set(key(call), (remaining.get(key(call)) ?? 0) + 1);
  return calls.filter(call => {
    const id = key(call), count = remaining.get(id) ?? 0;
    if (!count) return false;
    remaining.set(id, count - 1); return true;
  });
}

export async function replayDocumentReads(manifest) {
  // Match VF1's waste pass exactly. The survey manifest defaults unrecognized
  // arms to sleight too; only sleight-* evidence directories belong to its 396.
  const sessions = JSON.parse(await readFile(manifest, 'utf8')).filter(session =>
    session.arm === 'sleight' && /^sleight-/.test(basename(dirname(session.file))));
  const rows = [], byApp = {}, reasons = {};
  let jsCalls = 0, rawJsCalls = 0;
  for (const session of sessions) {
    const raw = recordedCalls(await readFile(session.file, 'utf8'));
    rawJsCalls += raw.filter(call => call.tool === 'js').length;
    const calls = frozenRecordedCalls(raw, session.calls);
    let lastTree = '';
    for (const [index, call] of calls.entries()) {
      if (call.tool === 'js') jsCalls++;
      if (call.tool === 'js' && screenshot.test(call.code)) {
        const current = /^Window: /m.test(call.text ?? '') && /^\t*\d+ (?:text entry area|layout area|web area)\b/m.test(call.text ?? '')
          ? call.text : lastTree;
        const verdict = classifyDocumentScreenshot({ code: call.code, tree: current, task: session.task, isError: call.isError });
        const id = createHash('sha256').update(session.file.split('/').slice(-3).join('/') + ':' + index).digest('hex').slice(0, 16);
        rows.push({ id, ...verdict });
        const app = byApp[verdict.app] ??= { answered: 0, pixels: 0 };
        app[verdict.answered ? 'answered' : 'pixels']++;
        reasons[verdict.reason] = (reasons[verdict.reason] ?? 0) + 1;
      }
      // Keep the most recent recorded full document context. A diff alone does
      // not establish missing content or styles; the classification is an upper
      // bound when intervening actions changed content without a full tree.
      if (/^Window: /m.test(call.text ?? '') && !/lines changed since|no change since/.test(call.text ?? '')) lastTree = call.text;
    }
  }
  const answered = rows.filter(row => row.answered).length;
  const manifestScreenshots = sessions.reduce((sum, session) => sum + session.calls.filter(call =>
    call.tool === 'sleight:js' && call.reads?.some(method => ['getScreenshot', 'getAXStateAndScreenshot'].includes(method))).length, 0);
  if (rows.length !== manifestScreenshots) throw Error('RECORDED_SCREENSHOT_SET_CHANGED');
  return { schema: 1, method: 'counterfactual-recorded-document-coverage', sessions: sessions.length, jsCalls, rawJsCalls,
    screenshots: rows.length, manifestScreenshots, answered, pixels: rows.length - answered, percent: Math.round(answered / rows.length * 10000) / 100,
    attributedAvailabilityVerified: false, productionParserRun: false, classification: 'regex-upper-bound', byApp, reasons, rows };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--manifest' || args[2] !== '--output') throw Error('Use --manifest FILE --output FILE');
  const result = await replayDocumentReads(args[1]);
  await writeFile(args[3], JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const { rows, ...summary } = result;
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}
