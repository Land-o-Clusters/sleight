import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readCorpus } from './corpus.mjs';
import * as oldFlow from './legacy-ca2/flow-rules.mjs';
import * as newFlow from '../../plugins/sleight/lib/flow-rules.mjs';
import * as oldNative from './legacy-ca2/native-arguments.mjs';
import * as newNative from '../../plugins/sleight/lib/native-arguments.mjs';
import * as oldElements from './legacy-ca2/literal-elements.mjs';
import * as newElements from '../../plugins/sleight/lib/literal-elements.mjs';
import * as oldClipboard from './legacy-ca2/clipboard.mjs';
import * as newClipboard from '../../plugins/sleight/lib/clipboard.mjs';
import { parseCell } from '../../plugins/sleight/lib/code-ast.mjs';

const pairs = {
  flow: [oldFlow.calls, newFlow.calls], native: [oldNative.nativeArgumentsProblem, newNative.nativeArgumentsProblem],
  elements: [oldElements.literalElements, newElements.literalElements], clipboard: [oldClipboard.clipboardActions, newClipboard.clipboardActions],
};
export function consumerOutput(name, consumer, code) {
  try {
    if (name !== 'flow') return consumer(code) ?? null;
    const fallback = { app: 'Fixture', host: null, web: false, observed: false }, handles = new Map();
    const result = consumer(code, handles, fallback, new Set());
    const output = { inputs: result.inputs, unknown: result.unknown ?? false, readApp: result.readApp, readTarget: result.readTarget,
      handles: [...handles].sort(([a], [b]) => a.localeCompare(b)) };
    Object.defineProperty(output, 'unknownCount', { value: result.unknownInputs?.length ?? 0 });
    return output;
  } catch (error) { return { refused: error.message }; }
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function classify(name, code, before, after) {
  if (name === 'native' && before === null && typeof after === 'string' && code.includes('__sleightOpenedApp'))
    return { verdict: 'old path wrong', reason: after.includes('mouseButton') ? 'opened-app alias hid a button option mistake'
      : after.includes('App.pressKey') ? 'opened-app alias hid invalid native pressKey arguments'
        : 'opened-app alias hid an invalid native click target' };
  if (name === 'flow') {
    const withoutHandles = ({ handles, ...result }) => result;
    if (code.includes('__sleightOpenedApp') && JSON.stringify(withoutHandles(before)) === JSON.stringify(withoutHandles(after)))
      return { verdict: 'old path wrong', reason: 'opened-app alias was absent from binding hints; current inputs and read target are identical' };
    if (/getApp\(\s*\{\s*windowId:/.test(code))
      return { verdict: 'old path wrong', reason: 'window-id acquisition has an unknown app; old path attributed it to the fallback or a prior acquisition' };
    if (code.includes('.catch('))
      return { verdict: 'old path wrong', reason: 'catch can replace the acquired handle; its result is deliberately not an app binding' };
    if (code.includes('.getScreenshot('))
      return { verdict: 'old path wrong', reason: 'screenshot result was incorrectly recorded as an app handle' };
  }
  return { verdict: 'regression', reason: 'unclassified output difference requires review' };
}

const corpus = await readCorpus(), differences = [], diagnostics = [], counts = {}, reasons = {};
let regressions = 0;
for (const [name, consumers] of Object.entries(pairs)) {
  counts[name] = { compared: 0, differences: 0 };
  for (const [index, record] of corpus.records.entries()) {
    const [before, after] = consumers.map(consumer => consumerOutput(name, consumer, record.code));
    counts[name].compared++;
    const unknown = Array.isArray(after) ? after.unknown ?? 0 : after?.unknownCount ?? 0;
    if (unknown) diagnostics.push({ index, consumer: name, arm: record.arm, file: record.file, line: record.line, source: record.sha256,
      unknown, reason: 'AST explicitly marks non-literal input; existing literal-result data is compared independently' });
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    counts[name].differences++;
    // Digests and coordinates identify every result without publishing typed
    // text. --details is local diagnostic output only, never a retained report.
    const classification = classify(name, record.code, before, after);
    reasons[classification.reason] = (reasons[classification.reason] ?? 0) + 1;
    if (classification.verdict === 'regression') regressions++;
    const difference = { index, consumer: name, arm: record.arm, file: record.file, line: record.line, source: record.sha256,
      before: digest(before), after: digest(after), engineAccepted: !parseCell(record.code).error, ...classification };
    if (process.argv.includes('--details')) console.log(JSON.stringify({ ...difference, code: record.code, old: before, new: after }));
    differences.push(difference);
  }
}
writeFileSync(new URL('consumer-differences.json', import.meta.url), JSON.stringify({ base: 'c4175f7917fadb10bce86d02d7672df416105aa8',
  manifest: corpus.manifest, corpus: corpus.counts, counts, regressions, reasons, diagnostics, differences }, null, 2) + '\n');
console.log(JSON.stringify({ manifest: corpus.manifest, corpus: corpus.counts, counts, regressions, reasons, unknownDiagnostics: diagnostics.length }));
if (!corpus.records.length || corpus.counts.malformed || regressions) process.exitCode = 1;
