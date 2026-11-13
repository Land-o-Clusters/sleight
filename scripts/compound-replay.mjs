// Data-only reproduction of VF1's candidate selection. No driver, app, benchmark
// runner or screenshot imports. Results contain source coordinates and hashes,
// never recorded UI text, model code, typed values or absolute home paths.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { parseCompoundRecordedRows, resolveCompoundPrintedSelector, assessCompoundRecording, summarizeCompoundReplay } from '../plugins/sleight/lib/mac-driver/compound/replay.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ?
  content.filter(x => x.type === 'text').map(x => x.text).join('\n') : '';
export function recordedCompoundCalls(raw) {
  const calls = [], byId = new Map();
  const lines = raw.trim().split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line; try { line = JSON.parse(lines[i]); } catch { continue; }
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    if (line.type === 'assistant') for (const block of content) if (block.type === 'tool_use') {
      const call = { tool: block.name.replace(/^mcp__plugin_sleight_computer__/, ''), code: block.input?.code ?? '',
        line: i + 1, text: '', resultLine: null }; calls.push(call); byId.set(block.id, call);
    }
    if (line.type === 'user') for (const block of content) if (block.type === 'tool_result' && byId.has(block.tool_use_id)) {
      const call = byId.get(block.tool_use_id); call.text = textOf(block.content); call.resultLine = i + 1;
    }
  }
  return calls;
}
// Parse call syntax as data. No eval, benchmark import or driver invocation.
export function compoundRecordedClicks(code) {
  const ts = require('typescript');
  const clicks = [];
  const ast = ts.createSourceFile('recorded.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) return clicks;
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'click') {
      const arg = node.arguments[0];
      if (arg && ts.isNumericLiteral(arg)) clicks.push({ number: Number(arg.text) });
      if (arg && ts.isObjectLiteralExpression(arg)) {
        const label = arg.properties.find(p => ts.isPropertyAssignment(p) && p.name?.getText(ast) === 'label');
        if (label && ts.isStringLiteralLike(label.initializer)) clicks.push({ label: label.initializer.text });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast); return clicks;
}
export function compoundRecordingCandidates(calls) {
  const found = []; let before;
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i], clicks = compoundRecordedClicks(call.code), after = parseCompoundRecordedRows(call.text);
    const frames = [...(before ? [before] : []), ...after];
    const labels = clicks.filter(c => c.label !== undefined);
    // Keep ambiguous/refused printed matches for assessment and counting.
    if (labels.length >= 2 && frames.some(f => resolveCompoundPrintedSelector(f,
      { source: 'title', label: labels[0].label }, ['AXMenuBarItem']).status !== 'missing') && labels.slice(1).every(click => frames.some(f =>
      resolveCompoundPrintedSelector(f, { source: 'title', label: click.label }, ['AXMenuItem']).status !== 'missing'))) {
      found.push({ kind: 'menu', call, texts: [calls[i - 1]?.text ?? '', call.text],
        intent: { operation: 'menu', segments: labels.map(c => c.label) } });
    }
    const popup = clicks.find(c => (before?.nodes ?? []).some(n => n.role === 'AXPopUpButton' &&
      (c.number === n.number || c.label !== undefined && [n.title, n.description].includes(c.label))));
    if (popup) {
      const next = compoundRecordedClicks(calls[i + 1]?.code ?? '')[0];
      const option = after.flatMap(f => f.nodes).find(n => n.role === 'AXMenuItem' &&
        (n.number === next?.number || next?.label !== undefined && [n.title, n.description].includes(next.label)));
      found.push({ kind: 'choose', call, texts: [calls[i - 1]?.text ?? '', call.text],
        printedSelectors: option ? [{ role: 'AXMenuItem', source: option.title ? 'title' : 'description', label: option.title ?? option.description }] : [] });
    }
    if (after.length) before = after.at(-1);
  }
  return found;
}
export async function replayCompoundBank({ survey, evidenceRoot }) {
  const root = resolve(evidenceRoot), bank = JSON.parse(await readFile(survey, 'utf8'));
  if (!Array.isArray(bank)) throw Error('INVALID_SURVEY');
  const sessions = bank.filter(s => s.arm === 'sleight' && /^sleight-/.test(basename(dirname(s.file))));
  const menu = [], choose = [], savePanels = [];
  let sessionsRead = 0;
  for (const session of sessions) {
    const file = resolve(session.file), source = relative(root, file);
    if (!source || source.startsWith('..') || isAbsolute(source)) throw Error('SOURCE_OUTSIDE_EVIDENCE_ROOT');
    const raw = await readFile(file, 'utf8'), calls = recordedCompoundCalls(raw), sourceHash = digest(raw);
    sessionsRead++;
    const metadata = { source, sourceHash };
    for (const candidate of compoundRecordingCandidates(calls)) {
      const { kind, call, texts, intent, printedSelectors } = candidate;
      (kind === 'menu' ? menu : choose).push({ ...metadata, callLine: call.line, resultLine: call.resultLine,
        ...await assessCompoundRecording({ kind, texts, intent, printedSelectors }) });
    }
    for (const call of calls) if ((await assessCompoundRecording({ kind: 'prepareSaveAs', texts: [call.text] })).diagnostics.saveSheetPrinted)
      savePanels.push({ ...metadata, resultLine: call.resultLine });
  }
  return { method: 'Frozen survey; parsed literal menu paths and observed popup click cells; no invented native evidence',
    surveyHash: digest(await readFile(survey)), sessionsRead, menu: { summary: summarizeCompoundReplay(menu), rows: menu },
    choose: { summary: summarizeCompoundReplay(choose), rows: choose }, savePanels };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--survey', '--evidence-root', '--output'].includes(args[i]) || !args[i + 1]) throw Error('INVALID_ARGS');
    options[args[i].slice(2)] = args[i + 1];
  }
  if (Object.keys(options).length !== 3) throw Error('INVALID_ARGS');
  const result = await replayCompoundBank({ survey: options.survey, evidenceRoot: options['evidence-root'] });
  await writeFile(options.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ sessionsRead: result.sessionsRead, menu: result.menu.summary, choose: result.choose.summary,
    savePanelCandidates: result.savePanels.length }));
}
