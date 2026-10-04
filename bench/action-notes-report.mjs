import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { actionVerdict } from './action-notes-verdict.mjs';
import { tasks } from './tasks.mjs';
import { isLeaseRead } from '../plugins/sleight/lib/input-lease.mjs';

const directory = 'docs/benchmarks';
const indexPath = `${directory}/2026-10-04-action-notes-index.json`;
let prior;
try { prior = JSON.parse(readFileSync(indexPath, 'utf8')); } catch {}
const names = readdirSync(directory).filter(n => /^2026-10-04-action-notes-\d+-.*\.json$/.test(n)).sort();
const attempts = names.map(name => {
  const run = JSON.parse(readFileSync(`${directory}/${name}`, 'utf8'));
  const task = tasks.find(t => t.id === run.task);
  const audit = actionVerdict(run.events, task, run.verdict, run);
  const uses = run.events.flatMap(e => e.type === 'assistant' ? e.message?.content ?? [] : []).filter(c => c.type === 'tool_use' && /__js$/.test(c.name));
  const replies = run.events.flatMap(e => e.type === 'user' ? e.message?.content ?? [] : []).filter(c => c.type === 'tool_result');
  const notes = replies.flatMap(r => (typeof r.content === 'string' ? [r.content] : (r.content ?? []).map(c => c.text ?? ''))).flatMap(t => t.match(/^Action result: .+$/gm) ?? []);
  return { file: name, arm: run.arm, task: run.task, repetition: run.repetition, attempt: Number(run.attempt),
    code: run.code, signal: run.signal, cancelled: run.cancelled, timeout: run.timeout,
    finished: run.finished, seconds: run.seconds, turns: run.turns, rawPassed: run.passed,
    auditedPassed: audit.passed, successfulActions: audit.successfulActions,
    displayEvidence: audit.displayEvidence, jsCalls: uses.length,
    reads: uses.filter(u => isLeaseRead(u.input?.code ?? '')).length,
    noteCount: notes.length, notes, servers: audit.servers };
});
const selected = attempts.filter(a => a.attempt === 6);
if (selected.length !== 12 || selected.some(a => !a.finished)) throw new Error('The declared twelve comparison trials have not finished');
const median = values => {
  const v = [...values].sort((a, b) => a - b), mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};
const comparison = ['calculator-click', 'calculator-menu', 'textedit-save'].map(task => ({ task,
  arms: ['off', 'on'].map(arm => {
    const runs = selected.filter(a => a.task === task && a.arm === arm);
    return { arm, passed: runs.filter(a => a.auditedPassed).length, runs: runs.length,
      turns: runs.map(a => a.turns), medianTurns: median(runs.map(a => a.turns ?? NaN)),
      medianSeconds: median(runs.map(a => a.seconds)), reads: runs.map(a => a.reads) };
  }) }));
const sourceHashes = Object.fromEntries(['plugins/sleight/lib/action-notes.mjs', 'plugins/sleight/lib/relay.mjs', 'plugins/sleight/lib/launch.mjs'].map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
writeFileSync(indexPath, JSON.stringify({
  date: '2026-10-04', base: '4409f1c', model: 'claude-sonnet-5-5', effort: 'medium',
  comparisonSourceHashes: prior?.comparisonSourceHashes ?? prior?.sourceHashes ?? sourceHashes,
  finalSourceHashes: sourceHashes,
  comparison, attempts, exclusions: {
    1: 'Engine sandbox denial. Cancelled and collected. Shared lock released.',
    2: 'Other installed servers loaded. Excluded before seeing paired outcomes.',
    3: 'Strict config disabled the plugin server as well. No computer-use tools loaded.',
    4: 'Account servers remained loaded. Engine sandbox denial.',
    5: 'Engine sandbox denial. Raw numeric-answer check falsely passed. Audit requires actions and returned display and marks it failed.',
  },
}, null, 2) + '\n');
console.log(JSON.stringify(comparison, null, 2));
