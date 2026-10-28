import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayNativeDocs } from '../bench/native-docs-replay.mjs';
import { fixtureDocumentation } from './helpers/canonical-docs.mjs';

const docs='## Computer Use\n\n'+'Native reference. '.repeat(100)+'\n# Computer Use Confirmations Policy\nAsk first.';
const browser='# Other Browser APIs\n\n# Browser Safety\nKeep user tabs.';
const call=(id,code)=>({type:'assistant',message:{content:[{type:'tool_use',id,name:'mcp__plugin_sleight_computer__js',input:{code}}]}});
const reply=(id,content)=>({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content}]},tool_use_result:{_meta:{'codex/toolSurface':{kind:'browserUse'}}}});

test('offline native-doc replay reports saved characters and checks complete safety sections',()=>{
  const events=[call('one','let b = await cua.getBrowser({id:"iab"});'),reply('one',[{type:'text',text:docs},{type:'text',text:browser}])];
  // DI1: only the engine's own documents are deferred, so the synthetic bundle declares them.
  const result=replayNativeDocs(events,{documentationTrust:fixtureDocumentation(docs,browser)});
  assert.equal(result.calls,1); assert.equal(result.nativeBlocks,1); assert.ok(result.savedChars>1000);
  assert.equal(result.policyChecks,1); assert.equal(result.policyPreserved,true);
  assert.equal(result.browserSafetyChecks,1); assert.equal(result.browserSafetyPreserved,true);
  assert.equal(result.beforeChars-result.afterChars,result.savedChars);
});

test('offline replay leaves native-first runs unchanged and ignores unrelated tools',()=>{
  const events=[call('one','await cua.listApps();'),reply('one',[{type:'text',text:docs}]),
    {type:'user',message:{content:[{type:'tool_result',tool_use_id:'unrelated',content:'other tool'}]}}];
  const result=replayNativeDocs(events);
  assert.equal(result.calls,1); assert.equal(result.savedChars,0); assert.equal(result.firstBrowser,false);
});
