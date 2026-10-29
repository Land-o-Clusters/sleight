// Test-only loader: compare the existing WM1 assertion against M160's write effects.
import { registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';

const target = new URL('../../plugins/sleight/lib/write-effect.mjs', import.meta.url).href;
const scanner = new URL('../../tests/fixtures/cell-tokenizer-legacy.mjs', import.meta.url).href;
const source = execFileSync('/usr/bin/git', ['show', '75f105a25177e245be8394836e971931293b3aa6:plugins/sleight/lib/write-effect.mjs'],
  { encoding: 'utf8' }).replace("'./flow-rules.mjs'", JSON.stringify(scanner));
registerHooks({ load(url, context, nextLoad) {
  return url === target ? { format: 'module', source, shortCircuit: true } : nextLoad(url, context);
} });
