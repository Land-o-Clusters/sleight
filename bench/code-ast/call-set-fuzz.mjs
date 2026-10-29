// Supplemental adversarial cases beside the full CA1 FR3/reviewer generators.
// Nothing generated here executes.
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseCell } from '../../plugins/sleight/lib/code-ast.mjs';
import { FlowRules } from '../../plugins/sleight/lib/flow-rules.mjs';
import { nativeArgumentsProblem } from '../../plugins/sleight/lib/native-arguments.mjs';
import { literalElements } from '../../plugins/sleight/lib/literal-elements.mjs';
import { clipboardActions } from '../../plugins/sleight/lib/clipboard.mjs';
import { dispatchInspection } from '../../plugins/sleight/lib/dispatched-calls.mjs';
const cases = [
  ['direct', 'await app.typeText("PAYLOAD"); await app.click(7); await app.pressKey("super+c")', false, [7], ['c']],
  ['computed', 'await app["typeText"]("PAYLOAD"); await app["click"](7)', false, [7], []],
  ['assigned alias', 'let h; h=app; const o={}; o.t=h.typeText; o.t("PAYLOAD")', true],
  ['conditional handle', 'const h=ok?app:other; const o={t:h.typeText}; o.t("PAYLOAD")', true],
  ['alias', 'const t = app.typeText; t("PAYLOAD")', true],
  ['destructure', 'const {typeText:t} = app; t("PAYLOAD")', true],
  ['call', 'app.typeText.call(app,"PAYLOAD")', true],
  ['apply', 'app.typeText.apply(app,["PAYLOAD"])', true],
  ['indirect', '(0,app.typeText)("PAYLOAD")', true],
  ['tag', 'app.typeText`PAYLOAD`', true],
  ['constructor', 'new app.typeText("PAYLOAD")', true],
  ['getter', 'const o = {get value(){return app.typeText}}; o.value("PAYLOAD")', true],
  ['shadow', 'const f = (app) => app.typeText("PAYLOAD");', false, [], []],
  ['catch', 'try {} catch(app) { app.typeText("PAYLOAD") }', false, [], []],
  ['ternary', 'app.typeText(ok?"PAYLOAD":"")', false, [], []],
  ['await', 'app.typeText(await f("PAYLOAD"))', false, [], []],
  ['String', 'app.typeText(String("PAYLOAD"))', false, [], []],
  ['join', 'app.typeText(["PAY","LOAD"].join(""))', false, [], []],
];
const gates = ['lanes-may-test','fuzz-may-run'].map(name => join(homedir(),'Projects/sleight-wt/ledger/vc/night',name));
const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
const summary = { generated:100000, accepted:0, explicitRefusals:0, consumerChecks:0, dispatchChecks:0, failures:0, families:Object.create(null) };
const manifest = createHash('sha256');
for (let i=0; i<summary.generated; i++) {
  if (i % 1000 === 0) while (gates.some(path => !existsSync(path))) await wait(60000);
  const [family, body, refused, numbers=[], clipboard=[]] = cases[i % cases.length];
  const source = `const fixture${i} = ${i};\n` + body + ';';
  manifest.update(source).update('\n');
  assert.equal(parseCell(source).error,null);
  summary.accepted++; summary.families[family]=(summary.families[family]??0)+1;
  const rules = new FlowRules({version:1,rules:[{id:'payload',kind:'pattern',pattern:'PAYLOAD',destinations:['Mail'],except:['Notes']}]});
  assert.ok(rules.analyze('js',{code:source}).violations.some(v=>v.rule==='payload'),family);
  if (refused) {
    assert.match(nativeArgumentsProblem(source),/cannot inspect JavaScript: .+\. Use direct handle\./,family);
    for (const consumer of [literalElements,clipboardActions]) assert.throws(()=>consumer(source),/cannot inspect JavaScript: .+\. Use direct handle\./,family);
    summary.explicitRefusals++;
  } else {
    assert.equal(nativeArgumentsProblem(source),undefined,family);
    assert.deepEqual(literalElements(source),numbers,family);
    assert.deepEqual(clipboardActions(source),clipboard,family);
  }
  const dispatch=dispatchInspection(source), marked=dispatch.mark(source);
  assert.equal(dispatch.verify(marked),true,family);
  assert.equal(dispatch.verify(marked+'\napp.click(999)'),false,family);
  summary.consumerChecks+=4; summary.dispatchChecks+=2;
  if ((i+1)%10000===0) console.log(JSON.stringify({completed:i+1,failures:0}));
}
summary.manifest=manifest.digest('hex');
writeFileSync(new URL('call-set-fuzz-results.json',import.meta.url),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary));
