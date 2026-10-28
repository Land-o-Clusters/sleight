// Offline only. TypeScript supplies the independent literal-call inventory.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { typescriptCalls } from './oracle.mjs';
import { parseCell } from '../../plugins/sleight/lib/code-ast.mjs';
import { calls } from '../../plugins/sleight/lib/flow-rules.mjs';
import { nativeArgumentsProblem } from '../../plugins/sleight/lib/native-arguments.mjs';
import { literalElements } from '../../plugins/sleight/lib/literal-elements.mjs';
import { clipboardActions } from '../../plugins/sleight/lib/clipboard.mjs';
import { sameGuardedCalls, dispatchInspection } from '../../plugins/sleight/lib/dispatched-calls.mjs';

let seed = 20261028;
const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor(seed / 0x100000000 * n); };
const member = (name, n) => [`.${name}`, `[${JSON.stringify(name)}]`, '[`' + name + '`]', `?.${name}`, `.${name}?.`,
  '.\\u' + name.charCodeAt(0).toString(16).padStart(4, '0') + name.slice(1)][n];
const wraps = [code => code, code => `if (flag) {${code}}`, code => `async function task() {${code}}`,
  code => `for (let i = 0; i < count; i++) {${code}}`, code => `try {${code}} catch (error) {}`,
  code => `const task = async () => {${code}}`, code => `switch (value) {case 1: {${code}}}`];
const prefixes = ['', 'if (flag) {} /[/*]/.test(text);', 'const n = 1. / x / y;',
  'const n = count / 2;', 'const obj = {...typeof /"/.test(text)};', 'const text = "app.typeText(7)";'];
const summary = { seed, generated: 10000, accepted: 0, engineRefused: 0, consumerChecks: 0, dispatchChecks: 0, regressions: 0 };
const manifest = createHash('sha256'), unique = new Set();
for (let i = 0; i < summary.generated; i++) {
  const input = `app${member('typeText', random(6))}("PAYLOAD")`;
  const click = `app${member('click', random(6))}(7)`;
  const copy = `app${member('pressKey', random(6))}("super+c")`;
  const template = random(7) === 0;
  const body = template ? '`' + '${await ' + input + '}; ${await ' + click + '}; ${await ' + copy + '}`;'
    : `await ${input}; await ${click}; await ${copy};`;
  const code = prefixes[random(prefixes.length)] + '\n' + wraps[random(wraps.length)](body);
  manifest.update(code).update('\n'); unique.add(code);
  if (parseCell(code).error) { summary.engineRefused++; continue; }
  summary.accepted++;
  const oracle = typescriptCalls(code).filter(call => call.receiver === 'app');
  const visible = calls(code, new Map(), { app: 'Fixture' }).inputs.filter(call => call.method === 'typeText');
  assert.equal(visible.length, oracle.filter(call => call.method === 'typeText').length, `flow case ${i}`);
  assert.deepEqual(visible.map(call => call.value), ['PAYLOAD'], `flow data case ${i}`);
  assert.equal(nativeArgumentsProblem(code), undefined, `native valid case ${i}`);
  assert.match(nativeArgumentsProblem(code.replace('"PAYLOAD"', '2')), /invalid native arguments/, `native invalid case ${i}`);
  assert.deepEqual(clipboardActions(code), ['c'], `clipboard case ${i}`);
  assert.deepEqual(literalElements(code), template ? [] : [7], `elements case ${i}`);
  summary.consumerChecks += 6;
  assert.equal(sameGuardedCalls(code, code.replace('"PAYLOAD"', '"MUTATED"')), false, `mutation case ${i}`);
  const dispatch = dispatchInspection(code);
  const output = dispatch.wrap(dispatch.mark(code), source => 'const helper = () => proxy.click(value);\n' + source);
  assert.equal(dispatch.verify(output), true, `dispatch case ${i}`);
  assert.equal(dispatch.verify(output + '\napp.click(9)'), false, `extra call case ${i}`);
  summary.dispatchChecks += 3;
}
summary.manifest = manifest.digest('hex');
summary.uniquePrograms = unique.size;
writeFileSync(new URL('call-set-fuzz-results.json', import.meta.url), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary));
