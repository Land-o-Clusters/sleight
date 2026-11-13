// Offline only. Read saved transcripts and spill files; import no relay or runner.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createResultBudget, RESULT_LIMIT } from '../plugins/sleight/lib/result-budget.mjs';
import { createReadCompactor } from '../plugins/sleight/lib/compact-reads.mjs';
import { waitForBenchGate } from '../bench/runtime-options.mjs';

const { values, positionals } = parseArgs({ options: { 'numbers-baseline': { type: 'string' } }, allowPositionals: true });
const [manifest, baselineModule, ...banks] = positionals;
if (!manifest || !baselineModule || !banks.length) throw Error('Expected SF1 replay manifest, baseline module, and saved bank directories.');
await waitForBenchGate();
const baseline = (await import(pathToFileURL(baselineModule))).createResultBudget;
const trust = { mark: c => c, trusted: () => false };
const budget = (factory, onTreeTrim) => factory({ platform: 'darwin', fullDocs: true, validateDocumentation: false,
  documentationTrust: trust, onTreeTrim });
const scrub = path => path.replaceAll(homedir(), '~');
const sources = {};
function read(path) {
  const bytes = readFileSync(path);
  sources[scrub(path)] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  return bytes.toString('utf8');
}
read(baselineModule);
read(join(dirname(baselineModule), 'browser-read-cap.mjs'));
read(fileURLToPath(new URL('../plugins/sleight/lib/result-budget.mjs', import.meta.url)));
read(fileURLToPath(new URL('../plugins/sleight/lib/browser-read-cap.mjs', import.meta.url)));
read(fileURLToPath(import.meta.url));
const numbersBaselineModule = values['numbers-baseline'];
let baselineCompactor, numbersBaselineBudget;
if (numbersBaselineModule) {
  read(numbersBaselineModule);
  read(fileURLToPath(new URL('../plugins/sleight/lib/compact-reads.mjs', import.meta.url)));
  const formatter = join(dirname(numbersBaselineModule), 'result-budget.mjs');
  read(formatter);
  baselineCompactor = (await import(pathToFileURL(numbersBaselineModule))).createReadCompactor;
  numbersBaselineBudget = (await import(pathToFileURL(formatter))).createResultBudget;
}
const numberReplay = () => baselineCompactor && [baselineCompactor, createReadCompactor].map(factory => factory({
  callTrees: false, resultTrim: false, screenshotReads: false, compactAcquisition: false,
  compactReacquire: false, compactToolbars: false, routeSteering: false, undoReceipts: false
}));
// Reconstruct each saved visible baseline in transcript order, then apply its
// delivery cap. This compares number guards without replaying input or actions.
function compareNumbers(content, compactors) {
  if (!compactors) return;
  const states = compactors.map((compactor, i) => {
    const shown = compactor.process(content, { forceFull: true });
    budget(i === 0 ? numbersBaselineBudget : createResultBudget, (...args) => compactor.hideNumbers(...args)).apply(shown);
    return [...compactor.trees()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([key, lines]) => {
      const window = JSON.parse(key);
      const numbers = new Set(lines.flatMap(line => /^\t*(\d+) /.exec(line)?.slice(1).map(Number) ?? []));
      return [...numbers].sort((a, b) => a - b).filter(n => !compactor.staleIndex(window, `app.click(${n})`))
        .map(n => `${key}:${n}`);
    });
  });
  const [before, after] = states.map(state => new Set(state));
  const added = states[1].filter(key => !before.has(key)).length;
  const removed = states[0].filter(key => !after.has(key)).length;
  return { changed: added + removed > 0, before: before.size, after: after.size, added, removed };
}
const textChars = c => c.reduce((n, item) => n + (item.type === 'text' ? item.text.length : 0), 0);
const sizes = c => ({ text_chars: textChars(c), joined_text_chars: textChars(c) + Math.max(0, c.length - 1),
  serialized_bytes: Buffer.byteLength(JSON.stringify(c)) });
const fits = c => sizes(c).joined_text_chars <= RESULT_LIMIT && sizes(c).serialized_bytes <= 48000;
const identity = c => c.filter(item => item.type === 'text').flatMap(item =>
  [...item.text.matchAll(/^Window: [^\n]+\n(?:[+~-] )?\d+ [^\n]*/gm)].map(m => m[0]));
const originalFixtures = [];
for (const path of Object.keys(JSON.parse(read(manifest)).sources).filter(path => path.endsWith('.txt'))) {
  const content = JSON.parse(read(path.replace(/^~/, homedir())));
  const old = budget(baseline).apply(content), out = budget(createResultBudget).apply(content);
  if (fits(old) || !fits(out)) throw Error(`Original fixture did not reproduce then fit: ${scrub(path)}`);
  if (JSON.stringify(identity(out)) !== JSON.stringify(identity(content)) || JSON.stringify(out.slice(1)) !== JSON.stringify(content.slice(1))) {
    throw Error(`Fixture identity or notices changed: ${scrub(path)}`);
  }
  const omitted = c => [...c[0].text.matchAll(/^sleight: (\d+) tree lines omitted\b/gm)].reduce((n, m) => n + Number(m[1]), 0);
  const previous = omitted(content), current = omitted(out);
  const notes = c => [...c[0].text.matchAll(/^sleight: \d+ tree lines omitted\b/gm)].length;
  if (current - previous !== content[0].text.split('\n').length - out[0].text.split('\n').length + notes(out) - notes(content)) throw Error('Omission line accounting changed.');
  originalFixtures.push({ step: /race-safari-[AB]-r\d/.exec(path)?.[0], original: sizes(content), baseline: sizes(old), candidate: sizes(out),
    previous_omitted_lines: previous, omitted_lines: current, identity_and_notices_unchanged: true, omission_accounting_exact: true,
    valid_numbers: compareNumbers(content, numberReplay()) });
}
if (originalFixtures.length !== 6) throw Error('Expected six SF1 original fixtures.');

function* eventsFiles(path) {
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) yield* eventsFiles(child);
    else if (entry.name === 'events.jsonl') yield child;
  }
}
const groups = {}, cases = [];
for (const bank of banks) {
 const files = [...eventsFiles(bank)].map(file => ({ file,
   browser: /(?:^|[-/])(safari|firefox)(?:[-/]|$)/.exec(file.slice(bank.length))?.[1], population: 'race-as3' }));
 // Held-out CC reports retain their full transcripts in the cache evidence bank.
 // Use the report's exact stamp, task and run, rather than guessing a newer run.
 for (const name of readdirSync(bank).sort()) {
   if (!/^cc-.*(?:safari|firefox)-[AB]-r\d+\.json$/.test(name)) continue;
   const report = JSON.parse(read(join(bank, name)));
   for (const result of report.results ?? []) files.push({
     file: join(homedir(), 'Library/Caches/sleight-bench/evidence', report.stamp, `sleight-${result.task}-${result.run}`, 'transcript.jsonl'),
     browser: /(?:safari|firefox)/.exec(name)[0], population: 'cc' });
 }
 for (const { file, browser, population } of files) {
  if (!browser) continue;
  const key = `${basename(bank)}/${browser}/${population}`;
  const group = groups[key] ??= { files: 0, results: 0, changed: 0, unchanged: 0, skipped: 0, reasons: {}, newly_bounded: 0,
    candidate_over_text: 0, candidate_over_serialized: 0, over_serialized_with_images: 0, over_serialized_text_only: 0,
    text_chars_saved: 0, serialized_bytes_saved: 0,
    numeric_lines: 0, nonincreasing_numeric_continuations: 0, results_with_numeric_continuations: 0,
    nonincreasing_indented: 0, nonincreasing_unindented: 0,
    nonincreasing_shapes: {}, rating_label_lines: 0, results_with_rating_labels: 0, slash_prose_lines: 0,
    numbers_replayed: 0, valid_number_results_changed: 0, valid_numbers_added: 0, valid_numbers_removed: 0 };
  if (!existsSync(file)) { group.missing_files = (group.missing_files ?? 0) + 1; continue; }
  group.files++;
  const seen = new Set(), compactors = numberReplay();
  for (const [index, line] of read(file).trim().split('\n').entries()) {
    const event = JSON.parse(line), blocks = event.message?.content;
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block.type !== 'tool_result' || seen.has(block.tool_use_id)) continue;
      seen.add(block.tool_use_id); group.results++;
      let content = block.content, reason;
      if (typeof content === 'string') {
        const spill = /saved to (.+?)\.\n/.exec(content)?.[1];
        if (spill) {
          try { content = JSON.parse(read(spill)); } catch (e) { if (e.code === 'ENOENT') reason = 'missing spill'; else throw e; }
        } else content = [{ type: 'text', text: content }];
      }
      if (!reason && (!Array.isArray(content) || content.some(c => c.type === 'text' && typeof c.text !== 'string'))) reason = 'unsupported content';
      if (!reason && compactors) {
        const numbers = compareNumbers(content, compactors);
        group.numbers_replayed++;
        if (numbers.changed) group.valid_number_results_changed++;
        group.valid_numbers_added += numbers.added;
        group.valid_numbers_removed += numbers.removed;
      }
      // Count the reviewed prose shapes in all retained results, including
      // filtered/caller output without a native header. Never emit page text.
      if (!reason) {
        const ratings = content.filter(c => c.type === 'text').reduce((n, c) =>
          n + [...c.text.matchAll(/^\t*\d+ (?:stars\b|of \d+ stars\b|things\b)/gm)].length, 0);
        group.rating_label_lines += ratings;
        if (ratings) group.results_with_rating_labels++;
        group.slash_prose_lines += content.filter(c => c.type === 'text').reduce((n, c) =>
          n + [...c.text.matchAll(/^\t*\d+ \/ \d+\b/gm)].length, 0);
      }
      if (!reason && !content.some(c => c.type === 'text' && /^Window: [^\n]+, App: (?:Safari|Firefox)\.\n/m.test(c.text))) reason = 'no native tree header';
      if (reason) { group.skipped++; group.reasons[reason] = (group.reasons[reason] ?? 0) + 1; continue; }
      let continuations = 0;
      for (const item of content) {
        if (item.type !== 'text') continue;
        let previous = -1, inside = false;
        for (const line of item.text.split('\n')) {
          if (/^Window: /.test(line)) { previous = -1; inside = true; continue; }
          if (/^(?:The focused UI element|Computer Use\b)/.test(line)) { inside = false; continue; }
          const row = /^(?:[+~-] )?(\t*)(\d+) /.exec(line);
          if (!inside || !row) continue;
          group.numeric_lines++;
          const number = Number(row[2]);
          if (number <= previous) {
            continuations++;
            group[row[1] ? 'nonincreasing_indented' : 'nonincreasing_unindented']++;
            const shape = (line.startsWith('+ ') || line.startsWith('- ') || line.startsWith('~ ') ? 'diff:' : 'plain:') +
              (/\d+ (button|menu|text|container|link|tab|row|cell|column|outline|scroll|standard|image|splitter|combo|HTML|heading|toolbar|radio|check|close|toggle|slider|value|checkbox|pop up|list|email|telephone)\b/.exec(line)?.[1] ??
                'other');
            group.nonincreasing_shapes[shape] = (group.nonincreasing_shapes[shape] ?? 0) + 1;
          } else previous = number;
        }
      }
      group.nonincreasing_numeric_continuations += continuations;
      if (continuations) group.results_with_numeric_continuations++;
      const old = budget(baseline).apply(content), out = budget(createResultBudget).apply(content);
      const changed = JSON.stringify(old) !== JSON.stringify(out);
      group[changed ? 'changed' : 'unchanged']++;
      if (!fits(old) && fits(out)) group.newly_bounded++;
      if (sizes(out).joined_text_chars > RESULT_LIMIT) group.candidate_over_text++;
      if (sizes(out).serialized_bytes > 48000) {
        group.candidate_over_serialized++;
        group[out.some(c => c.type === 'image') ? 'over_serialized_with_images' : 'over_serialized_text_only']++;
      }
      group.text_chars_saved += textChars(old) - textChars(out);
      group.serialized_bytes_saved += sizes(old).serialized_bytes - sizes(out).serialized_bytes;
      if (changed) cases.push({ source: scrub(file), line: index + 1, tool_use_id: block.tool_use_id,
        original: sizes(content), baseline: sizes(old), candidate: sizes(out) });
    }
  }
 }
}
console.log(JSON.stringify({ text_limit: RESULT_LIMIT, serialized_ceiling: 48000, originalFixtures, groups, changedCases: cases, sources }, null, 2));
