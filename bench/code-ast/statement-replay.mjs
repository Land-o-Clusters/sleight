// Offline PS3 replay. Import consumers only; never import bench/run.mjs or evaluate caller code.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { readCorpus } from './corpus.mjs';
import * as text from '../../plugins/sleight/lib/text-save.mjs';
import * as menu from '../../plugins/sleight/lib/menu-continuation.mjs';
import * as tab from '../../plugins/sleight/lib/tab-probe.mjs';
import { parseCell, memberCall } from '../../plugins/sleight/lib/code-ast.mjs';

export const BASE = 'c4175f7917fadb10bce86d02d7672df416105aa8';
const root = new URL('../../', import.meta.url);
const lib = new URL('plugins/sleight/lib/', root);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

// Load the immutable old consumers with their old dependencies. No mutable worktree
// checkout or copied production tokenizer is needed, and no recorded source is run.
export async function legacyConsumers() {
  const urls = new Map(), sources = {};
  async function load(name) {
    const path = 'plugins/sleight/lib/' + name;
    let source = execFileSync('/usr/bin/git', ['show', BASE + ':' + path], { cwd: fileURLToPath(root), encoding: 'utf8', maxBuffer: 1024 * 1024 });
    sources[path] = hash(source);
    const imports = [...source.matchAll(/from '(\.\/[^']+)'/g)];
    for (const match of imports) {
      const dependency = match[1].slice(2);
      const url = ['text-save.mjs', 'menu-continuation.mjs', 'flow-rules.mjs', 'code-line-terminators.mjs'].includes(dependency)
        ? urls.get(dependency) ?? await load(dependency) : new URL(dependency, lib).href;
      source = source.replaceAll("from '" + match[1] + "'", "from '" + url + "'");
    }
    const url = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
    urls.set(name, url);
    return url;
  }
  const text = await import(await load('text-save.mjs'));
  const menu = await import(await load('menu-continuation.mjs'));
  const tab = await import(await load('tab-probe.mjs'));
  return { text, menu, tab, sources };
}

function menuResult(consumer, code) {
  const plan = consumer.splitMenuActions(code);
  if (!plan) return null;
  return {
    actions: plan.actions.map(({ start, end, handle, selector }) => ({ start, end, handle, selector })),
    remainders: plan.actions.slice(1).map(action => code.slice(action.start).trim()),
    notes: plan.actions.map((_, index) => consumer.stopNote({ windowStop: true, index }, plan)),
  };
}
const semanticMenu = result => result && { ...result, actions: result.actions.map(({ handle, selector }) => ({ handle, selector })) };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const safe = result => result == null ? null : { sha256: hash(result), bytes: Buffer.byteLength(JSON.stringify(result)) };

export function compareRecord(code, old) {
  const before = { statements: old.text.statementSpans(code)?.spans ?? null, textSave: old.text.splitTextSave(code) ?? null,
    menu: menuResult(old.menu, code), tab: old.tab.nativeTabPlan(old.menu.splitMenuActions(code)) };
  const after = { statements: text.statementSpans(code)?.spans ?? null, textSave: text.splitTextSave(code) ?? null,
    menu: menuResult(menu, code), tab: tab.nativeTabPlan(menu.splitMenuActions(code)) };
  const differences = [];
  for (const consumer of Object.keys(before)) {
    if (same(before[consumer], after[consumer])) continue;
    let reason = 'unclassified';
    if (consumer === 'statements') reason = 'engine-statement-ranges';
    if (consumer === 'menu' && same(semanticMenu(before.menu), semanticMenu(after.menu))) reason = 'engine-action-ranges';
    if (consumer === 'menu' && !before.menu && after.menu) {
      // Prove the old refusal is solely its missing awaited-observation shape:
      // removing only those outer awaits must make the original consumer accept.
      let equivalent = code, removed = 0;
      for (const statement of [...parseCell(code).ast.body].reverse()) {
        const expression = statement.type === 'ExpressionStatement' && statement.expression;
        const call = expression?.type === 'AwaitExpression' && memberCall(expression.argument);
        if (call && !call.computed && !call.optional && call.receiver.type === 'Identifier' && call.receiver.name === 'nodeRepl' &&
            ['write', 'emitImage'].includes(call.method)) {
          equivalent = equivalent.slice(0, expression.range[0]) + equivalent.slice(expression.range[0] + 5);
          removed++;
        }
      }
      if (removed && old.menu.splitMenuActions(equivalent)) reason = 'awaited-observation-tail';
    }
    differences.push({ consumer, reason, old: safe(before[consumer]), new: safe(after[consumer]),
      oldAccepted: before[consumer] !== null && before[consumer] !== false,
      newAccepted: after[consumer] !== null && after[consumer] !== false });
  }
  return { differences, before, after };
}

async function main() {
  const corpus = await readCorpus(), old = await legacyConsumers();
  const rows = [], counts = {}, accepted = {};
  for (const [index, record] of corpus.records.entries()) {
    if (parseCell(record.code).error) throw Error('corpus contains engine-refused source at record ' + index);
    const result = compareRecord(record.code, old);
    for (const consumer of Object.keys(result.before)) {
      const count = accepted[consumer] ??= { old: 0, new: 0, changed: 0, lost: 0 };
      if (result.before[consumer] !== null && result.before[consumer] !== false) count.old++;
      if (result.after[consumer] !== null && result.after[consumer] !== false) count.new++;
      else if (result.before[consumer] !== null && result.before[consumer] !== false) count.lost++;
    }
    for (const difference of result.differences) {
      counts[difference.consumer + ':' + difference.reason] = (counts[difference.consumer + ':' + difference.reason] ?? 0) + 1;
      accepted[difference.consumer].changed++;
      const ranges = consumer => consumer === 'statements' ? [result.before.statements, result.after.statements] : consumer === 'menu'
        ? [result.before.menu, result.after.menu].map(plan => plan?.actions.map(({ start, end }) => [start, end]) ?? null) : undefined;
      rows.push({ index, arm: record.arm, file: record.file, line: record.line, sha256: record.sha256, ...difference,
        ranges: ranges(difference.consumer) });
    }
  }
  const outputs = rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
  const archive = gzipSync(outputs);
  writeFileSync(new URL('statement-differences.jsonl.gz', import.meta.url), archive);
  const sources = { ...old.sources };
  for (const path of ['plugins/sleight/lib/text-save.mjs', 'plugins/sleight/lib/menu-continuation.mjs', 'plugins/sleight/lib/tab-probe.mjs',
    'plugins/sleight/lib/code-ast.mjs', 'bench/code-ast/statement-replay.mjs', 'bench/code-ast/corpus.mjs'])
    sources['new:' + path] = hash(readFileSync(new URL(path, root), 'utf8'));
  const summary = { base: BASE, corpus: corpus.counts, before: corpus.before, manifest: corpus.manifest,
    accepted, differences: rows.length, reasons: counts, regressions: Object.values(accepted).reduce((sum, entry) => sum + entry.lost, 0), unclassified: rows.filter(row => row.reason === 'unclassified').length,
    differencesSha256: hash(outputs), archiveSha256: createHash('sha256').update(archive).digest('hex'),
    archiveBytes: archive.length, uncompressedBytes: Buffer.byteLength(outputs), sources };
  writeFileSync(new URL('statement-results.json', import.meta.url), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  if (!corpus.records.length || corpus.counts.malformed || summary.unclassified || summary.regressions) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], 'file://'))) await main();
