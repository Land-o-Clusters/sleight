import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classify} from '../bench/code-ast/consumer-classifier.mjs';
const empty = () => ({inputs:[],unknown:false,handles:[],readApp:'Fixture',readTarget:{app:'Fixture',host:null,web:false,observed:false}});
test('binding hint metadata is additive and requires its exact target',()=>{
  const before=empty(),after=empty();after.handles=[['app',{...after.readTarget}]];
  const code='let app=__sleightOpenedApp2;';
  assert.equal(classify('flow',code,before,after).verdict,'additive');
  after.handles[0][1].app='Mail';
  assert.equal(classify('flow',code,before,after).verdict,'regression');
});
for(const decoy of ['app.getScreenshot()', 'promise.catch(()=>{})', 'cua.getApp({windowId:7})'])
  test('a spelling cannot classify an unrelated data change: '+decoy,()=>{
    const before=empty(),after=empty();before.inputs=[{method:'typeText',value:'one',target:{app:'Fixture'}}];
    after.inputs=[{method:'typeText',value:'two',target:{app:'Fixture'}}];
    assert.equal(classify('flow',decoy,before,after).verdict,'regression');
    assert.equal(classify('native',decoy,null,'made up refusal').verdict,'regression');
  });
test('unknown policy additions require a syntactic unknown invocation',()=>{
  const before=empty(),after={...empty(),unknown:true};
  assert.equal(classify('flow','f()',before,after).verdict,'additive');
  assert.equal(classify('flow','app.getAXState()',before,after).verdict,'regression');
});

test('unknown destination classification preserves element-first browser input values',()=>{
  const before=empty(),after=empty();
  before.inputs=[{method:'typeText',value:'safe',target:{app:'Fixture',host:null,web:false,observed:false}}];
  after.inputs=[{method:'typeText',value:'safe',target:{}}];
  assert.equal(classify('flow','other.typeText(55,"safe")',before,after).verdict,'safety correction');
  after.inputs[0].value='changed';
  assert.equal(classify('flow','other.typeText(55,"safe")',before,after).verdict,'regression');
});
