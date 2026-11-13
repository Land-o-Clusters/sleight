#!/usr/bin/env node
// Recorded text only. No app, driver, bench runner, capture or child process.
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMacReadState } from '../plugins/sleight/lib/mac-driver/diff.mjs';
import { createActionLedger } from '../plugins/sleight/lib/repl/action-ledger.mjs';
import { windowFromText } from '../plugins/sleight/lib/document-scope.mjs';

const text = value => ({ type: 'text', text: value });
const complete = tree => /\n(?:The focused UI element|sleight: no element in this read reports focus\.)/.test(tree);
export function splitRecordedTrees(value) {
  const output = [], trees = [];
  const pattern = /^Window: [^\n]+\n0 [^\n]+(?:\n\t*\d+ [^\n]*)*(?:\n(?:The focused UI element|sleight: no element)[^\n]*)?/gm;
  let start = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > start) output.push(text(value.slice(start, match.index)));
    output.push(text(match[0])); trees.push({ text: match[0], complete: complete(match[0]) });
    start = match.index + match[0].length;
  }
  if (start < value.length) output.push(text(value.slice(start)));
  return { content: output, trees };
}
export function replayDisplays(cells, { parentOnly = false } = {}) {
  const state = createMacReadState(), ids = new Map();
  const window = tree => { const shown = windowFromText(tree); return {
    app: shown.app, title: shown.title, windowId: '101', pid: 120,
    processStart: 'recorded-offline', bundleId: 'com.apple.calculator', identityVerified: true,
  }; };
  let timedOut = false;
  return cells.map((cell, index) => {
    const before = Buffer.byteLength(JSON.stringify(cell.content));
    const fragments = cell.content.flatMap(item => item.type === 'text' ? splitRecordedTrees(item.text).content : [item]);
    const original = parentOnly ? fragments.filter(item => item.type === 'text' && item.text.startsWith('Window:') && complete(item.text)) : fragments;
    const all = original.filter(item => item.type === 'text' && complete(item.text) && item.text.startsWith('Window:'));
    // The first retry result contains the abandoned cell's first tree, followed
    // by its own two identical reads (GLS1). Retain the retry's observations.
    const deferred = timedOut && all.length > 1 ? all[0] : undefined;
    timedOut = cell.timeout;
    if (cell.timeout || cell.reset) state.reset();
    const content = original.filter((item, i) => item !== deferred &&
      !(all.includes(item) && original.slice(i + 1).some(later => later.text === item.text)));
    const snapshots = [];
    for (const item of content) {
      if (!item.text?.startsWith('Window:') || !complete(item.text)) continue;
      const w = window(item.text), n = (ids.get(w.windowId) ?? 0) + 1; ids.set(w.windowId, n);
      snapshots.push(state.read({ window: w, readId: n, text: item.text, truncated: false }));
    }
    const batch = state.prepareDisplay(content, snapshots, { compact: true, allowDelivery: !cell.error && !cell.timeout });
    batch.commit();
    const after = Buffer.byteLength(JSON.stringify(batch.content));
    return { call: index + 1, name: cell.name, before, after: parentOnly && !snapshots.length ? null : after, completeTrees: snapshots.length,
      droppedDeferredTrees: deferred ? 1 : 0, diffs: batch.content.filter(i => /sleight: (?:lines changed|no change since)/.test(i.text ?? '')).length,
      error: cell.error === true, timeout: cell.timeout === true };
  });
}
export function loadRecordedCells(transcript, persistedRoot) {
  const uses = new Map(), cells = [];
  const root = realpathSync(persistedRoot);
  for (const line of readFileSync(transcript, 'utf8').trim().split('\n')) {
    const message = JSON.parse(line).message;
    if (!Array.isArray(message?.content)) continue;
    for (const item of message.content) {
      if (item.type === 'tool_use') uses.set(item.id, item);
      if (item.type !== 'tool_result') continue;
      const use = uses.get(item.tool_use_id); if (!use || !/__(?:js|js_reset)$/.test(use.name)) continue;
      let content = typeof item.content === 'string' ? [text(item.content)] : item.content;
      for (const part of content ?? []) {
        const saved = /Full output saved to: ([^\n]+)/.exec(part.text ?? '')?.[1];
        if (!saved) continue;
        const path = realpathSync(saved), rel = relative(root, path);
        if (rel.startsWith('..') || resolve(root, rel) !== path) throw Error('PERSISTED_ROOT_MISMATCH');
        const stored = JSON.parse(readFileSync(path, 'utf8'));
        if (!Array.isArray(stored)) throw Error('INVALID_RECORDED_CONTENT');
        content = stored;
      }
      cells.push({ name: use.name.split('__').at(-1), code: use.input?.code, content: content ?? [],
        error: item.is_error === true, timeout: content?.some(i => /REPL_TIMEOUT/.test(i.text ?? '')),
        reset: use.name.endsWith('__js_reset') });
    }
  }
  return cells;
}
export function replayAdmission(before, after, actedIds, target, { hidden = false, sameCell = false } = {}) {
  const state = createMacReadState(), parsed = windowFromText(before);
  const window = { app: parsed.app, title: parsed.title, windowId: '101', pid: 120,
    processStart: 'recorded-admission', bundleId: 'com.apple.calculator', identityVerified: true };
  const one = state.read({ window, readId: 1, text: before, truncated: false });
  if (!hidden && !sameCell) state.prepareDisplay([text(before)], [one], { compact: true }).commit();
  const rowId = id => before.split('\n').find(line => line.endsWith('ID: ' + id))?.match(/^\t*(\d+) /)?.[1];
  for (const id of actedIds) {
    const n = Number(rowId(id)); state.assertCurrent('click', { ...window, readId: 1, args: [n] }, 'cell')();
  }
  state.read({ window, readId: 2, text: after, truncated: false });
  const params = { ...window, readId: 2, args: [target] };
  try { const done = state.assertCurrent('click', params, 'cell'); return { decision: 'ALLOW', targets: done.targets }; }
  catch (error) { return { decision: 'REFUSE', code: error.code, endCellFix: error.message.includes('End the cell and read again') }; }
}
function fullTrees(cell) { return cell.content.flatMap(item => item.type === 'text' ? splitRecordedTrees(item.text).trees.filter(t => t.complete).map(t => t.text) : []); }
export function replayCallSevenAccounting() {
  const ledger = createActionLedger();
  const three = ledger.arrive({ method: 'click', params: { args: [{ id: 'Three' }] } });
  ledger.settle(three, 'click', { result: { delivery: 'sent-unverified' } }, [22]);
  const six = ledger.arrive({ method: 'click', params: { args: [{ id: 'Six' }] } });
  ledger.settle(six, 'click', { error: { code: 'STALE_READ', delivery: 'not-sent', retry: 'safe' } });
  return { source: 'GLS1 call 7 input history, reconstructed receipts; no native per-action wire record in the transcript',
    bytes: Buffer.byteLength(ledger.format(true)), text: ledger.format(true) };
}
function main(args) {
  if (args.length !== 6 || args[0] !== '--evidence-root' || args[2] !== '--persisted-root' || args[4] !== '--results-root')
    throw Error('Use --evidence-root DIRECTORY --persisted-root DIRECTORY --results-root DIRECTORY');
  const evidence = resolve(args[1]), persisted = resolve(args[3]), results = resolve(args[5]);
  const runs = [], admissions = [];
  for (const stamp of ['2026-11-07T23-36-28-303Z', '2026-11-07T23-38-43-766Z', '2026-11-07T23-39-27-741Z', '2026-11-07T23-40-26-095Z']) {
    const receipt = JSON.parse(readFileSync(join(results, stamp + '.json'), 'utf8'));
    const directory = readdirSync(join(evidence, stamp)).find(name => name.startsWith('sleight-calculator-'));
    const cells = loadRecordedCells(join(evidence, stamp, directory, 'transcript.jsonl'), persisted);
    if (stamp === '2026-11-07T23-36-28-303Z') {
      const before = fullTrees(cells[5]).at(-1), after = fullTrees(cells[8]).at(-1);
      admissions.push({ run: 'r1-click', call: 7, target: 'Six', ...replayAdmission(before, after, ['Three'], { id: 'Six' }) });
      admissions.push({ run: 'r1-click', call: 8, target: 'Three', ...replayAdmission(before, after, [], { id: 'Three' }) });
    }
    if (stamp === '2026-11-07T23-39-27-741Z') {
      const initial = fullTrees(cells[0]).at(-1);
      admissions.push({ run: 'r2-click', call: 2, target: 'AllClear', ...replayAdmission(initial, initial, [], 'AllClear') });
    }
    if (stamp === '2026-11-07T23-40-26-095Z') {
      const initial = fullTrees(cells[4]).at(-1);
      for (const call of [8, 12, 18]) admissions.push({ run: 'r2-menu', call, target: 36,
        ...replayAdmission(initial, initial, [], 36, { hidden: true }) });
    }
    const parent = replayDisplays(cells, { parentOnly: true });
    runs.push({ stamp, originalPassed: receipt.results[0].passed, cells: replayDisplays(cells).map((row, i) => ({
      ...row, parentTreeBytes: parent[i].after, parentTreeDiffs: parent[i].diffs })) });
  }
  console.log(JSON.stringify({ kind: 'offline-display-replay', units: 'UTF-8 compact JSON content bytes',
    limitations: ['Native identity and read IDs reconstructed.', 'Only complete recorded trees grant delivery.',
      'Error caps and worker partial output preserved.', 'No counterfactual input or timing claim.', 'Call 7 admission uses complete reads bracketing the capped call, not its missing native admission record.'], accountingReplay: replayCallSevenAccounting(), admissions, runs }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
