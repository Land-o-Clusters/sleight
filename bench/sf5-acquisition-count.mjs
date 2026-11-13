// Offline transcript accounting only. No benchmark, app or engine imports.
// Counts source-bearing calls, not executions. Branches/fallbacks are not evaluated.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const digest = text => createHash('sha256').update(text).digest('hex');
const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n') : '';
const legacyGetApp = code => /\bcua\s*\.\s*getApp\s*\(/.test(code);

function sourceFacts(code) {
  const ts = require('typescript');
  const source = ts.createSourceFile('transcript.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const targets = [], methods = new Set();
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const e = node.expression;
      const method = ts.isPropertyAccessExpression(e) ? e.name.text :
        ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression) ? e.argumentExpression.text : '';
      if (method) methods.add(method);
      if (method === 'getApp' && ts.isIdentifier(e.expression) && e.expression.text === 'cua') {
        const arg = node.arguments[0];
        targets.push(arg && ts.isStringLiteralLike(arg) ? arg.text.toLowerCase().trim() : null);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { targets, methods, parseErrors: source.parseDiagnostics.length };
}

function recoveryReason(body) {
  // Fixed relay/engine error forms, never an assistant's explanation of its intent.
  if (/^sleight: the engine's JavaScript session restarted before this call\b/im.test(body)) return 'reset';
  if (/^(?:ReferenceError:.*(?:is not defined|Cannot access)|(?:Error: )?(?:app|handle) (?:is |has become )?(?:undefined|invalid|dead))[.!]?$/im.test(body)) return 'dead-handle';
  if (/^(?:\(?empty (?:acquisition |accessibility |AX )?tree\)?[.!]?|no (?:accessibility|AX) elements[.!]?|sleight: acquisition returned an empty tree[.!]?)$/im.test(body)) return 'empty-tree';
  return null;
}

export function countTranscript(events) {
  const totals = { toolCalls: 0, laterJsCalls: 0, getAppCalls: 0, initial: 0, initialAfterInventory: 0,
    repeated: 0, legitimateReacquisition: 0, unclassified: 0, legacyRepeatCalls: 0,
    legacyLaterGetAppCalls: 0, ambiguousOrdering: 0, parseErrors: 0, acquisitions: [] };
  const calls = new Map(), pending = new Set();
  let legacySeen = false, seen = false, inventory = false, activeTarget, control;
  for (const [offset, event] of events.entries()) {
    const line = offset + 1;
    const blocks = event.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        if (calls.has(block.id)) {
          if (JSON.stringify(calls.get(block.id).input) !== JSON.stringify(block.input)) throw Error('conflicting tool use');
          continue;
        }
        const name = block.name.split('__').at(-1), code = block.input?.code ?? '';
        const ordinal = ++totals.toolCalls;
        const facts = sourceFacts(code);
        totals.parseErrors += facts.parseErrors;
        if (name === 'js' && ordinal > 1) totals.laterJsCalls++;
        if (legacyGetApp(code)) {
          if (legacySeen) totals.legacyRepeatCalls++;
          if (ordinal > 1) totals.legacyLaterGetAppCalls++;
          legacySeen = true;
        }
        const call = { input: block.input, facts, name };
        calls.set(block.id, call);
        if (pending.size) totals.ambiguousOrdering++;
        pending.add(block.id);
        if (facts.methods.has('getState')) inventory = true;
        if (name === 'js' && facts.targets.length) {
          const distinct = new Set(facts.targets);
          const target = facts.targets[0];
          let kind, reason;
          if (facts.parseErrors || target === null || distinct.size !== 1) {
            kind = 'unclassified'; reason = facts.parseErrors ? 'parse-error' : target === null ? 'dynamic-target' : 'multiple-targets';
            totals.unclassified++;
          } else if (!seen) {
            kind = 'initial'; reason = inventory ? 'after-inventory' : 'first-acquisition';
            totals.initial++;
            if (inventory) totals.initialAfterInventory++;
          } else if (control || (activeTarget !== undefined && target !== activeTarget)) {
            kind = 'legitimate'; reason = control?.reason ?? 'app-switch';
            totals.legitimateReacquisition++;
          } else if (activeTarget === undefined) {
            kind = 'unclassified'; reason = 'unknown-previous-target'; totals.unclassified++;
          } else {
            kind = 'repeat'; reason = 'same-app-without-recovery'; totals.repeated++;
          }
          call.acquisition = { ordinal, line, resultLine: null, kind, reason, evidenceLine: control?.line ?? null,
            expressions: facts.targets.length, outcome: 'missing-result' };
          call.previousTarget = activeTarget;
          totals.acquisitions.push(call.acquisition);
          totals.getAppCalls++;
          activeTarget = distinct.size === 1 && target !== null ? target : undefined;
          seen = true;
          control = undefined;
        }
      } else if (block.type === 'tool_result') {
        const call = calls.get(block.tool_use_id);
        if (!call) throw Error(`unmatched tool result at line ${line}`);
        if (!pending.delete(block.tool_use_id)) continue;
        const body = textOf(block.content);
        if (call.acquisition) {
          call.acquisition.resultLine = line;
          call.acquisition.outcome = block.is_error ? 'error' : 'returned';
          if (block.is_error && call.acquisition.reason === 'app-switch') {
            call.acquisition.kind = 'unclassified';
            call.acquisition.reason = 'failed-app-switch';
            totals.legitimateReacquisition--;
            totals.unclassified++;
            if (totals.acquisitions.at(-1) === call.acquisition) activeTarget = call.previousTarget;
          }
        }
        const headerOnly = !block.is_error && (call.acquisition || call.facts.methods.has('getAXState')) &&
          /(?:^|\n)Window: [^\n]+\n?\s*$/.test(body);
        const reason = recoveryReason(body) ?? (headerOnly ? 'empty-tree' : null);
        if (reason) control = { reason, line };
        else if (call.name === 'js_reset' && !block.is_error) control = { reason: 'reset', line };
        else if (call.name === 'select_window' && !block.is_error) control = { reason: 'window-select', line };
        else if (control?.reason === 'empty-tree' && !block.is_error && call.facts.methods.has('getAXState') &&
          /^\s*\d+\s+(?:standard window|window|group|button|text)\b/m.test(body)) control = undefined;
        else if (control?.reason === 'window-select' && call.name === 'js' && !block.is_error) control = undefined;
      }
    }
  }
  return totals;
}

export function summarizeRuns(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = JSON.stringify([run.bank, run.group, run.side, run.comparable]);
    if (!groups.has(key)) groups.set(key, { bank: run.bank, group: run.group, side: run.side,
      comparable: run.comparable, runs: 0, runsRepeating: 0, legacyRunsRepeating: 0,
      initial: 0, initialAfterInventory: 0, repeated: 0, legitimateReacquisition: 0, unclassified: 0,
      getAppCalls: 0, legacyRepeatCalls: 0, legacyLaterGetAppCalls: 0, laterJsCalls: 0,
      ambiguousOrdering: 0, parseErrors: 0 });
    const group = groups.get(key);
    group.runs++;
    group.runsRepeating += run.repeated > 0 ? 1 : 0;
    group.legacyRunsRepeating += run.legacyRepeatCalls > 0 ? 1 : 0;
    for (const field of ['initial', 'initialAfterInventory', 'repeated', 'legitimateReacquisition', 'unclassified',
      'getAppCalls', 'legacyRepeatCalls', 'legacyLaterGetAppCalls', 'laterJsCalls', 'ambiguousOrdering', 'parseErrors']) group[field] += run[field];
  }
  return [...groups.values()];
}

// File IO stays outside the pure counter. Sources are never executed or copied into output.
export function replayBanks(paths) {
  const sources = {}, runs = [];
  const display = path => resolve(path).replace(homedir() + '/', '~/');
  const read = (path, jsonl = false) => {
    const data = readFileSync(path, 'utf8');
    sources[display(path)] = { bytes: Buffer.byteLength(data), sha256: digest(data) };
    return jsonl ? data.split('\n').filter(s => s.trim()).map(s => JSON.parse(s)) : JSON.parse(data);
  };
  const groups = new Set(['firefox-haiku', 'safari-haiku', 'as3-firefox', 'as3-safari']);
  for (const bankPath of paths) {
    const bank = basename(bankPath), bankRuns = [];
    for (const step of read(join(bankPath, 'schedule.json'))) {
      if (!groups.has(step.kind)) continue;
      const allowed = new Set(step.tasks.split(','));
      for (const record of read(join(bankPath, step.id, 'results.json'))) {
        const task = record.task.name;
        if (!allowed.has(task)) continue;
        const transcript = join(bankPath, step.id, task, 'events.jsonl');
        const configPath = join(bankPath, step.id, task, 'mcp.json');
        const server = existsSync(configPath) ? read(configPath).mcpServers?.['plugin:sleight:computer'] : undefined;
        const env = server?.env;
        const promptRoute = !env ? 'unknown' : env.SLEIGHT_SKILL === 'none' ? 'none' : env.SLEIGHT_PROMPT === 'lean' ? 'lean' : 'default';
        bankRuns.push({ bank, group: step.kind, side: step.side, step: step.id, task, passed: record.outcome.ok,
          promptRoute, leanCalls: env ? env.SLEIGHT_LEAN_CALLS === '1' : null,
          transcript: display(transcript), ...countTranscript(read(transcript, true)) });
      }
    }
    // SF1 compares tasks with at least one passing run on each side. Keep excluded runs too.
    for (const run of bankRuns) {
      run.comparable = ['A', 'B'].every(side => bankRuns.some(r => r.group === run.group && r.task === run.task && r.side === side && r.passed));
    }
    runs.push(...bankRuns);
  }
  return { schema: 1, units: 'source-bearing tool calls; execution and recovery success require live qualification',
    summaries: summarizeRuns(runs), runs, sources };
}

export function main(args) {
  if (args.length < 2 || args.length % 2 || args.some((arg, i) => i % 2 === 0 && arg !== '--bank')) {
    throw Error('usage: node bench/sf5-acquisition-count.mjs --bank DIRECTORY [--bank DIRECTORY]');
  }
  return replayBanks(args.filter((_, i) => i % 2 === 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(JSON.stringify(main(process.argv.slice(2)), null, 2) + '\n');
}
