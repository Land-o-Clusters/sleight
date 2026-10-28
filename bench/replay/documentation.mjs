import { createDocumentationTrust } from '../../plugins/sleight/lib/canonical-documentation.mjs';

// Use the product's exact bundle recognizer, including joined docs + window items.
// A heading alone never exempts task text from refusal or result checks.
export function replayDocumentation() {
  return createDocumentationTrust();
}

export function resultItems(result, documentation) {
  return (result?.content ?? []).flatMap(item => documentation ? documentation.split(item) : [item]);
}

export function taskResult(result, documentation) {
  return { ...result, content: resultItems(result, documentation).filter(item => !documentation?.trusted(item)) };
}
