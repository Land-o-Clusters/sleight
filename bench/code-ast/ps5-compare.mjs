import { benchEvidencePath } from '../runtime-options.mjs';
import { round2Cases, round2Controls, reviewerCells } from '../../tests/fixtures/ps5r2-cases.mjs';
// Offline decision replay. No caller code or benchmark module is executed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { evaluateWrite } from '../../plugins/sleight/lib/evaluate-write.mjs';
import { withoutPageCallbacks } from '../../plugins/sleight/lib/page-callbacks.mjs';
import { unawaitedAction } from '../../plugins/sleight/lib/relay.mjs';
import { parseCell, walk, memberCall } from '../../plugins/sleight/lib/code-ast.mjs';
import { evaluateWrite as oldWrite } from '../../tests/fixtures/ps5-evaluate-write-legacy.mjs';
import { withoutPageCallbacks as oldMask } from '../../tests/fixtures/ps5-page-callbacks-legacy.mjs';
import { unawaitedAction as oldAwait } from '../../tests/fixtures/ps5-unawaited-legacy.mjs';
import { pageCases } from '../../tests/fixtures/ps5-page-cases.mjs';
import { reviewCases, maskingCases, safeReviewCases } from '../../tests/fixtures/ps5-review-cases.mjs';
import { evaluationMethods } from '../../plugins/sleight/lib/page-code.mjs';

const digest = source => createHash('sha256').update(source).digest('hex');
const root = benchEvidencePath('race-1017');
const before = '2026-10-28T07:28:00Z';
const manifest = createHash('sha256'), outputs = createHash('sha256');
const differences = [];
let comparisons = 0, callbacks = 0, unjustifiedAccepts = 0;
const decisions = { 'allow -> allow': 0, 'allow -> refuse': 0, 'refuse -> refuse': 0, 'refuse -> allow': 0 };
const spans = (code, masked) => {
  const ranges = [];
  for (let i = 0; i < code.length; i++) if (code[i] !== masked[i]) {
    const start = i;
    while (i + 1 < code.length && code[i + 1] !== masked[i + 1]) i++;
    ranges.push([start, i + 1]);
  }
  return ranges;
};
function compare(code, coordinate, item) {
  const parsed = parseCell(code);
  if (parsed.error) {
    assert.equal(coordinate.bank, 'reviewer', 'only frozen review data may contain parse refusals');
    return 0;
  }
  const calls = [...walk(parsed.ast)].filter(node => node.type === 'CallExpression' &&
    evaluationMethods.has(memberCall(node)?.method)).length;
  callbacks += calls;
  const legacyMask = oldMask(code), currentMask = withoutPageCallbacks(code);
  const old = { write: oldWrite(code) ?? null, awaiting: oldAwait(code) ?? null, masked: legacyMask !== code, mask: digest(legacyMask) };
  const current = { write: evaluateWrite(code) ?? null, awaiting: unawaitedAction(code) ?? null, masked: currentMask !== code, mask: digest(currentMask) };
  if (item) {
    assert.equal(Boolean(current.write), item.write, item.id + ' write');
    if (Object.hasOwn(item, 'masked')) assert.equal(current.masked, item.masked, item.id + ' mask');
    if (Object.hasOwn(item, 'awaiting')) assert.equal(current.awaiting, item.awaiting, item.id + ' awaiting');
  }
  const oldRefused = Boolean(old.write || old.awaiting), currentRefused = Boolean(current.write || current.awaiting);
  decisions[`${oldRefused ? 'refuse' : 'allow'} -> ${currentRefused ? 'refuse' : 'allow'}`]++;
  if (oldRefused && !currentRefused) {
    unjustifiedAccepts++;
  }
  const changed = Object.keys(old).filter(key => old[key] !== current[key]);
  if (changed.length) {
    let justification = item?.reason;
    if (!justification && old.write === current.write && old.awaiting === current.awaiting)
      justification = 'AST ranges include the closing function delimiter and parameter defaults, retaining surrounding kernel punctuation. Write and await decisions are unchanged.';
    if (!justification && !oldRefused && currentRefused)
      justification = 'PS5R fails closed for unknown evaluation receivers and callback expressions.';
    if (!justification && oldRefused && currentRefused)
      justification = 'Both guards refuse the cell. PS5R also checks unknown receivers and preserves kernel diagnostics.';
    if (!justification) justification = 'UNCLASSIFIED';
    differences.push({ ...coordinate, changed, old, current, justification,
      oldMaskRanges: spans(code, legacyMask), currentMaskRanges: spans(code, currentMask) });
  }
  comparisons++;
  outputs.update(JSON.stringify({ ...coordinate, old, current }) + '\n');
  manifest.update(JSON.stringify({ ...coordinate, sha256: digest(code) }) + '\n');
  return calls;
}
function* files(directory, depth = 0) {
  if (depth > 8 || lstatSync(directory).isSymbolicLink()) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path, depth + 1);
    else if (entry.isFile() && ['events.jsonl', 'transcript.jsonl'].includes(entry.name)) yield path;
  }
}
const totals = () => ({ files: 0, toolCalls: 0, turboCalls: 0, cells: 0, evaluateCells: 0, evaluateCalls: 0 });
const counts = { chrome: totals(), helium: totals() };
let malformed = 0;
for (const file of files(root)) {
  const relative = file.slice(root.length + 1);
  const browser = relative.split('/').slice(0, -2).map(part => /(?:^|-)(chrome|helium)(?:-|$)/i.exec(part)?.[1]?.toLowerCase()).find(Boolean);
  if (!browser) continue;
  const seen = new Set();
  let line = 0, used = false;
  for await (const text of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    line++;
    let event;
    try { event = JSON.parse(text); } catch { malformed++; continue; }
    const timestamp = event.timestamp ?? event.t;
    if (typeof timestamp === 'string' && Date.parse(timestamp) > Date.parse(before)) continue;
    const calls = event.item?.type === 'mcp_tool_call' ? [event.item]
      : Array.isArray(event.message?.content) ? event.message.content.filter(part => part.type === 'tool_use') : [];
    for (const call of calls) {
      if (call.id && seen.has(call.id)) continue;
      if (call.id) seen.add(call.id);
      used = true;
      const count = counts[browser], tool = call.tool ?? call.name;
      count.toolCalls++;
      if (/(?:^|__)browser_(?:open|read|act|fill|tabs)$/.test(tool ?? '')) count.turboCalls++;
      if (!/(?:^|__)js$/.test(tool ?? '')) continue;
      const args = call.input ?? call.arguments, code = args?.code ?? args?.command;
      if (typeof code !== 'string') continue;
      count.cells++;
      const evaluateCalls = compare(code, { bank: browser, file: relative, line });
      if (evaluateCalls) count.evaluateCells++;
      count.evaluateCalls += evaluateCalls;
    }
  }
  if (used) counts[browser].files++;
}
const recorded = JSON.parse(readFileSync(new URL('../../tests/fixtures/h4-page-callbacks.json', import.meta.url), 'utf8'));
for (const item of recorded) compare(item.code, { bank: 'h4-recorded-fixture', id: item.id });
for (const item of pageCases) compare(item.code, { bank: 'fixed', id: item.id }, item);
for (const item of [...reviewCases, ...maskingCases, ...safeReviewCases, ...round2Cases, ...round2Controls]) compare(item.code, { bank: 'review', id: item.id }, item);
const collateral = {};
for (const item of reviewerCells) {
  const invalid = Boolean(parseCell(item.code).error);
  const oldRefused = invalid || Boolean(oldWrite(item.code) || oldAwait(item.code));
  const currentRefused = invalid || Boolean(evaluateWrite(item.code) || unawaitedAction(item.code));
  const summary = collateral[item.bank] ??= {cells:0, parseRefused:0, legacyRefused:0, currentRefused:0, newlyRefused:0};
  summary.cells++; summary.parseRefused += Number(invalid);
  summary.legacyRefused += Number(oldRefused); summary.currentRefused += Number(currentRefused);
  summary.newlyRefused += Number(!oldRefused && currentRefused);
  if (invalid) continue;
  compare(item.code, {bank:'reviewer', id:item.id});
}
const sourcePins = {};
for (const path of ['plugins/sleight/lib/evaluate-write.mjs', 'plugins/sleight/lib/page-callbacks.mjs', 'plugins/sleight/lib/page-code.mjs',
  'tests/fixtures/ps5-evaluate-write-legacy.mjs', 'tests/fixtures/ps5-page-callbacks-legacy.mjs', 'tests/fixtures/ps5-unawaited-legacy.mjs',
  'tests/fixtures/ps5r2-cases.mjs', 'tests/fixtures/ps5-page-cases.mjs', 'tests/fixtures/ps5-review-cases.mjs', 'tests/fixtures/h4-page-callbacks.json'])
  sourcePins[path] = digest(readFileSync(new URL('../../' + path, import.meta.url)));
for (let i = 1; i <= 7; i++) {
  const path = `tests/fixtures/ps5r2-review/cells${i}.mjs`;
  sourcePins[path] = digest(readFileSync(new URL('../../' + path, import.meta.url)));
}
const result = { base: '40cbae50', collateral, before, bank: '<private-evidence>/race-1017',
  counts, malformed, recordedFixtureCells: recorded.length, fixedCells: pageCases.length, comparisons, callbacks,
  reviewCells: reviewCases.length + maskingCases.length + safeReviewCases.length + round2Cases.length + round2Controls.length,
  decisions, differenceCount: differences.length, unjustifiedAccepts,
  unclassified: differences.filter(d => d.justification === 'UNCLASSIFIED').length,
  manifest: manifest.digest('hex'), outputDigest: outputs.digest('hex'), sourcePins, differences };
const json = JSON.stringify(result, null, 2).replace(/\[\s*(\d+),\s*(\d+)\s*\]/g, '[$1, $2]');
writeFileSync(new URL('ps5-results.json', import.meta.url), json + '\n');
console.log(JSON.stringify({ ...result, sourcePins: undefined, differences: undefined }, null, 2));
assert.equal(malformed, 0);
assert.equal(unjustifiedAccepts, 0, 'unjustified accepts');
assert.equal(result.unclassified, 0, 'every difference must be classified');
for (const count of Object.values(counts)) { assert.ok(count.cells > 0); assert.ok(count.turboCalls > 0); }
