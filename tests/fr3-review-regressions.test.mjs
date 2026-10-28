// The FR3 behavior cases on the engine AST path. No live app or caller code runs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCell,walk,memberCall} from '../plugins/sleight/lib/code-ast.mjs';
import {FlowRules,codeInspectionRefusal} from '../plugins/sleight/lib/flow-rules.mjs';
import {clipboardActions} from '../plugins/sleight/lib/clipboard.mjs';
import {literalElements} from '../plugins/sleight/lib/literal-elements.mjs';
import {nativeArgumentsProblem} from '../plugins/sleight/lib/native-arguments.mjs';
const rules=()=>new FlowRules({version:1,rules:[{id:'x',kind:'pattern',pattern:'X',destinations:['*']}]});
for(const number of ['1.','1.e3','1.e+3','1.e-3','.5','.5e2','1.5e-2','1_000.','0x10','2n'])
  test('FR3 numeric division exposes its input: '+number,()=>{
    const code=`${number} / app.typeText("X") / 2${number.endsWith('n')?'n':''};`;
    const parsed=parseCell(code);assert.equal(parsed.error,null);
    assert.equal([...walk(parsed.ast)].filter(node=>memberCall(node)?.method==='typeText').length,1);
    assert.deepEqual(rules().analyze('js',{code}).violations.map(v=>v.rule),['x']);
  });
for(const member of ['app.','app?.','1..','1.e3.']) test('FR3 malformed member refuses every consumer: '+member,()=>{
  const code=`app.typeText("X"); ${member} / app.typeText("hidden") / 2`;
  assert.equal(nativeArgumentsProblem(code),codeInspectionRefusal);
  assert.throws(()=>clipboardActions(code),{message:codeInspectionRefusal});
  assert.throws(()=>literalElements(code),{message:codeInspectionRefusal});
});
for(const code of ['app.typeText(...args)','app.click([1,...coords])','app.click(1,{...options})','app.typeText("...")'])
  test('FR3 native spread remains a runtime argument check: '+code,()=>assert.equal(nativeArgumentsProblem(code),undefined));
for(const code of ['`${app.typeText("X")}`','app.typeText("safe",`${app.typeText("X")}`)',
  '`decoy app.typeText("X") ${app.typeText("X")} ${app.typeText("X")}`',
  '`${`${app.typeText("X")}`}`']) test('FR3 interpolation exposes nested inputs: '+code,()=>{
    assert.equal(parseCell(code).error,null);
    assert.deepEqual(rules().analyze('js',{code}).violations.map(v=>v.rule),['x']);
  });
for(const [code,actions] of [['`${app.paste()}`',['paste']],['`${app.pressKey("super+c")}`',['c']],
  ['`${`${app.pressKey("super+x")}`}`',['x']]]) test('FR3 clipboard sees interpolations: '+code,()=>assert.deepEqual(clipboardActions(code),actions));
test('FR3 interpolated templates keep the shipped empty literal-order contract',()=>{
  for(const code of ['`${app.click(7)}`; app.click(8)','app.click(6); `${app.click(7)}`'])assert.deepEqual(literalElements(code),[]);
  assert.equal(nativeArgumentsProblem('`${app.typeText(42)}`'),'sleight: invalid native arguments. Engine App.typeText(text: string); nothing was sent.');
});
for(const expression of ['import("node:path")','tag`12`','`${Math.round(n / 2)}`','`${/}/.source}`','`${"}"}`','`${{value:12}.value}`'])
  test('FR3 value endings preserve following division input: '+expression,()=>{
    const code=expression+' / app.typeText("X") / 2;';
    if (expression === 'import("node:path")') assert.deepEqual(parseCell(code).error,{line:1,column:20,reason:"Unexpected token: '/'"});
    else assert.equal(parseCell(code).error,null);
    assert.ok(rules().analyze('js',{code}).violations.some(v=>v.rule==='x'));
  });
