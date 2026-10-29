import { readCorpus } from './corpus.mjs';
import { oracle } from './oracle.mjs';
import { literalElements } from '../../plugins/sleight/lib/literal-elements.mjs';
import { clipboardActions } from '../../plugins/sleight/lib/clipboard.mjs';

const corpus = await readCorpus();
const run = oracle({ label: 'recorded corpus' });
const legacyCount = (consumer, code) => { try { return consumer(code).length; } catch { return 'refused'; } };
let differences = 0, oldAccepted = 0, oldAcceptedNewRefused = 0, oldRefusedNewAccepted = 0;
for (const [index, record] of corpus.records.entries()) {
  const result = run.check(record.code, null);
  if (!result.legacy.refused) {
    oldAccepted++;
    if (!result.meriyahAccepted) oldAcceptedNewRefused++;
  } else if (result.meriyahAccepted) oldRefusedNewAccepted++;
  if (JSON.stringify(result.legacy.calls) !== JSON.stringify(result.visible) || result.legacy.refused === result.meriyahAccepted) {
    differences++;
    // The call inventories can contain private text. Report their counts and the
    // record coordinates, so every difference can be inspected locally.
    console.log(JSON.stringify({ difference: index, arm: record.arm, file: record.file, line: record.line, sha256: record.sha256,
      oldRefused: result.legacy.refused, newRefused: !result.meriyahAccepted,
      oldCalls: result.legacy.calls.length, astCalls: result.visible.length,
      legacyLiteralElements: legacyCount(literalElements, record.code),
      legacyClipboardActions: legacyCount(clipboardActions, record.code) }));
  }
}
console.log(JSON.stringify({ corpus: corpus.counts, before: corpus.before, manifest: corpus.manifest,
  differences, oldAccepted, oldAcceptedNewRefused, oldRefusedNewAccepted }));
run.finish();
if (!corpus.records.length || corpus.counts.malformed) process.exitCode = 1;
