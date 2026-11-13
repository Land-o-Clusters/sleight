// Offline PS3 replay. Import consumers only; never import bench/run.mjs or evaluate caller code.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { readCorpus } from './corpus.mjs';
import { parseCell } from '../../plugins/sleight/lib/code-ast.mjs';
import { compareRecord } from './statement-compare.mjs';
import { justifyResult } from './statement-oracle.mjs';
import { sources as frozenSources } from '../../tests/fixtures/statement-legacy/index.mjs';

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

async function main() {
  const corpus = await readCorpus(), old = await legacyConsumers();
  for (const [path, expected] of Object.entries(frozenSources)) if (old.sources[path] !== expected) throw Error('legacy fixture differs: ' + path);
  const rows = [], counts = {}, accepted = {}, oracleChecks = {}, newAccepts = {};
  for (const [index, record] of corpus.records.entries()) {
    if (parseCell(record.code).error) throw Error('corpus contains engine-refused source at record ' + index);
    const result = compareRecord(record.code, old);
    for (const consumer of Object.keys(result.before)) {
      const count = accepted[consumer] ??= { old: 0, new: 0, changed: 0, lost: 0 };
      if (result.before[consumer] !== null && result.before[consumer] !== false) count.old++;
      if (result.after[consumer] !== null && result.after[consumer] !== false) {
        count.new++;
        oracleChecks[consumer] = (oracleChecks[consumer] ?? 0) + 1;
        if (result.before[consumer] === null || result.before[consumer] === false) newAccepts[consumer] = (newAccepts[consumer] ?? 0) + 1;
        const value = consumer === 'statements' ? { spans: result.after.statements } :
          consumer === 'tab' ? { plan: result.after.menu } : result.after[consumer];
        const reason = justifyResult(record.code, consumer, value);
        if (reason) throw Error(`TypeScript cannot justify corpus record ${index} ${consumer}: ${reason}`);
      }
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
  const evidenceDirectory = join(homedir(), 'Projects/sleight-wt/ledger/vc/ps3-evidence');
  const archivePath = join(evidenceDirectory, 'statement-differences.jsonl.gz');
  mkdirSync(evidenceDirectory, { recursive: true });
  if (existsSync(archivePath) && !readFileSync(archivePath).equals(archive)) throw Error('existing statement evidence differs; preserve it');
  if (!existsSync(archivePath)) writeFileSync(archivePath, archive);
  const sources = { ...old.sources };
  for (const path of ['plugins/sleight/lib/text-save.mjs', 'plugins/sleight/lib/menu-continuation.mjs', 'plugins/sleight/lib/tab-probe.mjs',
    'plugins/sleight/lib/code-ast.mjs', 'bench/code-ast/statement-replay.mjs', 'bench/code-ast/statement-compare.mjs',
    'bench/code-ast/statement-oracle.mjs', 'bench/code-ast/corpus.mjs'])
    sources['new:' + path] = hash(readFileSync(new URL(path, root), 'utf8'));
  const summary = { base: BASE, corpus: corpus.counts, before: corpus.before, manifest: corpus.manifest,
    accepted, differences: rows.length, reasons: counts, regressions: Object.values(accepted).reduce((sum, entry) => sum + entry.lost, 0), unclassified: rows.filter(row => row.reason === 'unclassified').length,
    differencesSha256: hash(outputs), archiveSha256: createHash('sha256').update(archive).digest('hex'),
    archiveBytes: archive.length, uncompressedBytes: Buffer.byteLength(outputs), oracleChecks, newAccepts, sources };
  writeFileSync(new URL('statement-results.json', import.meta.url), JSON.stringify(summary, null, 2) + '\n');
  const resultsUrl = new URL('results.json', import.meta.url);
  const results = JSON.parse(readFileSync(resultsUrl));
  results.statementDifferences = { file: '~/Projects/sleight-wt/ledger/vc/ps3-evidence/statement-differences.jsonl.gz',
    records: rows.length, bytes: archive.length, sha256: summary.archiveSha256, uncompressedSha256: hash(outputs) };
  writeFileSync(resultsUrl, JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  if (!corpus.records.length || corpus.counts.malformed || summary.unclassified || summary.regressions) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(process.argv[1], 'file://'))) await main();
