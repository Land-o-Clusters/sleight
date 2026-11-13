import { replWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
const variants = {
  receipt: source => source.replace("typeof value?.text === 'string'", "false"),
  coalesce: source => source.replace('if (coalesceTrees(item.text) &&', 'if (false &&'),
  identity: source => source.replace('JSON.stringify([row.window.windowId, row.window.pid, row.window.processStart, row.window.bundleId])', "'shared'"),
};
if (process.env.GLS2_MUTANT) {const mutate=variants[process.env.GLS2_MUTANT];assert.ok(mutate);registerHooks({load(url,ctx,next){const loaded=next(url,ctx);if(!url.endsWith('/runtime-select.mjs'))return loaded;const source=String(loaded.source), changed=mutate(source);assert.notEqual(changed,source);return {...loaded,source:changed};}});}
const { fixture } = await import('./fixtures/gls2-runtime.mjs');
const text=r=>r.content.map(i=>i.text??'').join('\n');
const captured=readFileSync(new URL('./fixtures/glc1-calculator-closed.txt',import.meta.url),'utf8');
const seven=readFileSync(new URL('./fixtures/glc2-calculator-after-seven.txt',import.meta.url),'utf8');
const zero=seven.replace('StandardInputView;value:7','StandardInputView;value:0').replace('Edit field, Value: 7','Edit field, Value: 0').replace('Clear, ID: Clear','All Clear, ID: AllClear');
test('recorded Calculator Three then Six binds E2b, parent ledger first and default diff below 2 KB',{ skip: replWorkerSkip }, async t=>{
  const f=await fixture(t,{initial:zero,afterClick:()=>seven,sentVerified:true});
  const first=await f.js('let app=await cua.getApp("Calculator");');assert.equal(first.isError,false,text(first));
  const r=await f.js('await app.click({id:"Three"}); await app.click({id:"Six"}); void 0;');
  assert.equal(r.isError,false,text(r));assert.equal(f.calls.filter(r=>r.method==='click').length,2);
  assert.match(r.content[0].text,/^sleight: action ledger/);assert.match(text(r),/click\(\{"id":"Six"\}\) → 18 sent-verified/);
  assert.match(text(r),/lines changed since/);assert.ok(Buffer.byteLength(JSON.stringify(r.content))<2000);
  t.diagnostic('resultContentBytes='+Buffer.byteLength(JSON.stringify(r.content))+'; ledgerBytes='+Buffer.byteLength(r.content[0].text));
});
test('a refusal after sent input remains an error and scopes disposition to its row',{ skip: replWorkerSkip }, async t=>{
  const f=await fixture(t,{initial:zero,afterClick:()=>seven});await f.js('let app=await cua.getApp("Calculator");');
  const r=await f.js('await app.click({id:"Three"}); await app.click({id:"AllClear"}); void 0;');
  assert.equal(r.isError,true);assert.match(r.content[0].text,/sent-unverified\n2 click.*refused STALE_READ/);
  assert.match(r.content[0].text,/next=read-again/);assert.equal(f.calls.filter(r=>r.method==='click').length,1);
});
test('GLS1-10 bare string AllClear becomes the unique ID binding',{ skip: replWorkerSkip }, async t=>{const f=await fixture(t,{initial:zero,afterClick:()=>seven});await f.js('let app=await cua.getApp("Calculator");');const r=await f.js('await app.click("AllClear"); void 0;');assert.equal(r.isError,false,text(r));assert.deepEqual(f.calls.find(r=>r.method==='click').params.args[0],{id:'AllClear'});});
test('emit:false new numbers refuse with fixed recovery words through the relay',{ skip: replWorkerSkip }, async t=>{const f=await fixture(t,{initial:zero});await f.js('let app=await cua.getApp("Calculator",{emit:false}); void 0;');const r=await f.js('await app.getAXState({emit:false}); await app.click(18); void 0;');assert.equal(r.isError,true);assert.match(text(r),/End the cell and read again/);assert.equal(f.calls.filter(r=>r.method==='click').length,0);});
test('a timed-out read cannot leak trees into the replacement result',{ skip: replWorkerSkip }, async t=>{const f=await fixture(t,{initial:captured});await f.js('let app=await cua.getApp("Calculator");');const timeout=await f.js('await app.getAXState(); await new Promise(()=>{});',100);assert.equal(timeout.isError,true,text(timeout));assert.match(text(timeout),/REPL_TIMEOUT/);assert.doesNotMatch(text(timeout),/Window:/);const next=await f.js('let app=await cua.getApp("Calculator"); await app.getAXState(); void 0;');assert.equal(next.isError,false,text(next));assert.equal(next.content.filter(i=>i.text===captured).length,1);});
test('same text from distinct windows coalesces only within its identity',{ skip: replWorkerSkip }, async t=>{const f=await fixture(t,{twoWindows:true});const r=await f.js('let a=await cua.getApp("Calculator");let b=await cua.getApp("Other");void 0;');assert.equal(r.isError,false,text(r));assert.equal(r.content.filter(i=>i.text?.startsWith('Window:')).length,2);});

test('auto-printed native receipts coalesce their embedded tree and retain current numbers',{ skip: replWorkerSkip }, async t=>{const f=await fixture(t,{initial:zero,afterClick:()=>seven});await f.js('let app=await cua.getApp("Calculator");');const first=await f.js('await app.click({id:"Three"});');assert.equal(first.isError,false,text(first));assert.doesNotMatch(text(first),/\\n0 standard window/);assert.ok(Buffer.byteLength(JSON.stringify(first.content))<2000);const next=await f.js('await app.click(18);void 0;');assert.equal(next.isError,false,text(next));});

test('invalid preparation parameters return their fixed refusal before a worker cell starts', async t=>{const f=await fixture(t);const r=await f.js('void 0;',0);assert.equal(r.isError,true);assert.match(text(r),/INVALID_PARAMS/);assert.doesNotMatch(text(r),/ReferenceError|facts is not defined/);});

test('identical intermediate trees coalesce with a later distinct tree in the same window',{ skip: replWorkerSkip }, async t=>{const eight=seven.replace('StandardInputView;value:7','StandardInputView;value:8').replace('Edit field, Value: 7','Edit field, Value: 8');const f=await fixture(t,{compactReads:false,readSequence:[zero,seven,seven,eight]});const r=await f.js('let app=await cua.getApp("Calculator");await app.getAXState();await app.getAXState();await app.getAXState();void 0;');assert.equal(r.isError,false,text(r));assert.deepEqual(r.content.filter(i=>i.text?.startsWith('Window:')).map(i=>i.text),[zero,seven,eight]);});
