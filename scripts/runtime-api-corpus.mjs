// Extract only model-authored cells from VF1's recorded-session index. No driver imports.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseCell, walk, memberCall, literalValue } from '../plugins/sleight/lib/code-ast.mjs';

const [indexPath, outputPath] = process.argv.slice(2);
if (!indexPath || !outputPath) throw Error('Usage: runtime-api-corpus.mjs SESSION_INDEX OUTPUT');
const sessions = JSON.parse(readFileSync(indexPath, 'utf8')).filter(session =>
  path.basename(session.file) === 'transcript.jsonl' && /^sleight-/.test(path.basename(path.dirname(session.file))));
const records = [];
const spellings = Object.fromEntries(['rightClick', 'doubleClick', 'press', 'type', 'button', 'numericString',
  'objectPoint', 'pressKeyAfterClick'].map(name => [name, 0]));
for (const session of sessions) {
  const raw = readFileSync(session.file, 'utf8');
  const calls = [], byId = new Map();
  for (const line of raw.trim().split('\n')) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    const content = row.message?.content;
    if (!Array.isArray(content)) continue;
    if (row.type === 'assistant') for (const block of content) if (block.type === 'tool_use') {
      const call = { tool: block.name, code: block.input?.code };
      calls.push(call); byId.set(block.id, call);
    }
    if (row.type === 'user') for (const block of content) if (block.type === 'tool_result') {
      const call = byId.get(block.tool_use_id); if (!call) continue;
      call.text = typeof block.content === 'string' ? block.content : (block.content ?? [])
        .filter(item => item.type === 'text').map(item => item.text).join('\n');
      call.error = !!block.is_error;
    }
  }
  for (const call of calls) {
    const parsed = parseCell(call.code);
    if (parsed.error) continue;
    const methods = [...walk(parsed.ast)].filter(node => node.type === 'CallExpression')
      .sort((a, b) => a.range[0] - b.range[0]).map(memberCall).filter(Boolean);
    let previous;
    for (const method of methods) {
      if (['rightClick','doubleClick','press','type'].includes(method.method)) spellings[method.method]++;
      if (['click','rightClick','doubleClick','setValue','scroll','drag'].includes(method.method)) {
        const target = literalValue(method.args[0]);
        if (typeof target === 'string' && /^\d+$/.test(target)) spellings.numericString++;
        if (target && typeof target === 'object' && Object.hasOwn(target,'x') && Object.hasOwn(target,'y')) spellings.objectPoint++;
      }
      if (method.method === 'click') {
        const options = literalValue(method.args[1]);
        if (options && typeof options === 'object' && Object.hasOwn(options,'button')) spellings.button++;
      }
      if (method.method === 'pressKey' && method.args.length === 1 && previous?.method === 'click' &&
          previous.receiver?.type === 'Identifier' && method.receiver?.type === 'Identifier' &&
          previous.receiver?.name === method.receiver?.name) spellings.pressKeyAfterClick++;
      previous = method;
    }
  }
  for (const [i, call] of calls.entries()) {
    const text = call.text ?? '';
    if (!i || /this call ran \d+ action|not sent:|nothing from this call ran|stopped before/.test(text) ||
        /Input lease stopped|another session holds|lease (?:is )?held|-10005/.test(text)) continue;
    const misuse = /is not a function|is not defined|ReferenceError|TypeError|Cannot read|SyntaxError/.test(text);
    const invalid = /invalid native arguments/.test(text) &&
      (call.error || /^Error:|\bTypeError\b|\bReferenceError\b|is not a function|is not defined|SyntaxError|INVALID_PARAMS|-10005|Cannot read properties/m.test(text));
    if (!misuse && !invalid) continue;
    records.push({ category: misuse ? 'api-misuse' : 'invalid-arguments',
      cohort: misuse || /invalid native arguments[^\n]*App\.(?:pressKey|typeText)/.test(text) ? 'vf1-67' : 'supplemental-click',
      source: path.basename(path.dirname(path.dirname(session.file))) + '/' + path.basename(path.dirname(session.file)),
      sourceSha256: createHash('sha256').update(raw).digest('hex'), call: i,
      code: String(call.code).replaceAll(/\/Users\/[^/\s"']+/g, '~') });
  }
}
const corpus = { sessions: sessions.length, spellings, records };
writeFileSync(outputPath, JSON.stringify(corpus, null, 2) + '\n');
console.log(JSON.stringify({ sessions: sessions.length, records: records.length,
  primaryRecords: records.filter(row => row.cohort === 'vf1-67').length,
  apiMisuse: records.filter(row => row.category === 'api-misuse').length,
  invalidArguments: records.filter(row => row.category === 'invalid-arguments').length, spellings }));
