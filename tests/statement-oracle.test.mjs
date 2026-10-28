import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { justifyResult, statementOracle } from '../bench/code-ast/statement-oracle.mjs';
import { legacyConsumers, sources } from './fixtures/statement-legacy/index.mjs';
import { statementSpans, splitTextSave } from '../plugins/sleight/lib/text-save.mjs';
import { splitMenuActions } from '../plugins/sleight/lib/menu-continuation.mjs';

test('all five frozen legacy files match c4175f79 after restoring only import paths', () => {
  for (const [path, expected] of Object.entries(sources)) {
    const source = readFileSync(new URL('./fixtures/statement-legacy/' + path.split('/').at(-1), import.meta.url), 'utf8')
      .replace(/^\/\/ Frozen[^\n]*\n/, '').replaceAll("from '../../../plugins/sleight/lib/", "from './");
    assert.equal(createHash('sha256').update(source).digest('hex'), expected, path);
  }
});

test('TypeScript justifies newly accepted statement, text-save, menu and tab results', () => {
  const moduleAwait = '({...items, value: [...await/*gap*//}/, app.typeText("PAYLOAD"), /}/]});';
  assert.equal(justifyResult(moduleAwait, 'statements', statementSpans(moduleAwait)), null);
  const save = 'await app.setValue(2, "x");\u2028await app.pressKey("cmd+s");';
  const code = 'await app.pressKey("cmd+t"); await app.typeText("https://example.test"); await app.pressKey("Return"); await nodeRepl.emitImage(await app.getScreenshot());';
  assert.equal(legacyConsumers.text.splitTextSave(save), undefined);
  assert.equal(legacyConsumers.menu.splitMenuActions(code), undefined);
  assert.equal(justifyResult(save, 'statements', statementSpans(save)), null);
  assert.equal(justifyResult(save, 'textSave', splitTextSave(save)), null);
  assert.equal(justifyResult(code, 'menu', splitMenuActions(code)), null);
  assert.equal(justifyResult(code, 'tab', { plan: splitMenuActions(code) }), null);
  const output = [];
  const run = statementOracle({ reportFailure: item => output.push(item) });
  run.check(save, null); run.check(code, null);
  assert.equal(run.counts.failures, 0);
  assert.ok(run.counts.oracleChecks >= 3);
  assert.deepEqual(output, []);
});

test('TypeScript independently refuses forged boundaries, selectors, unsafe tails and tab URLs', () => {
  const code = 'await app.click({label:"File"}); await app.click(2);';
  const plan = splitMenuActions(code);
  assert.equal(justifyResult(code, 'menu', plan), null);
  plan.actions[0].end--;
  assert.equal(justifyResult(code, 'menu', plan), 'action-shape');
  plan.actions[0].end++;
  plan.actions[0].selector.value = 'Other';
  assert.equal(justifyResult(code, 'menu', plan), 'selector-object');
  plan.actions[0].selector.value = 'File';
  assert.equal(justifyResult(code + ' nodeRepl.write(app.click(3));', 'menu', plan), 'executable-tail');
  assert.equal(justifyResult(code, 'tab', { plan }), 'tab-count');
  const save = 'await app.setValue(2,"x"); await app.pressKey("cmd+s");';
  assert.equal(justifyResult(save, 'textSave', { ...splitTextSave(save), head: '' }), 'save-boundary');
  assert.equal(justifyResult('const x = ;', 'textSave', {}), 'typescript-syntax');
  assert.equal(justifyResult('let x = 1;', 'statements', { spans: [[0, 4]] }), 'statement-ranges');
});
