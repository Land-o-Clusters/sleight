import { windowsWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
const mutations={
  partial:["result?.delivery === 'not-sent' && result?.charactersDelivered > 0 ? 'sent-partial' : ", ''],
  'args-cap':['MAX_ARGUMENT_BYTES = 80','MAX_ARGUMENT_BYTES = 10000'],
  'rows-cap':['MAX_PRINTED_ROWS = 20','MAX_PRINTED_ROWS = 10000'],
  misuse:["item.text.replace(/ ?Operation not sent\\./g, '')",'item.text'],
  'lost-refused':[': row.disposition}${count}', ': (row.disposition === "unknown" ? "refused DRIVER_FAILED" : row.disposition)}${count}'],
  selector:["const args = printedArguments(row.args);","const args = row.bound?.join(',') ?? '';"],
  order:['const lines = rows.slice(0, MAX_PRINTED_ROWS).map(line);',"const lines = [...rows].sort((a,b)=>a.method.localeCompare(b.method)).map(line);"],
  decides:['if (decides >= 0 &&','if (false &&'],
  worker:['const ledger = call.ledger.format(result.isError || misleading);',"const ledger = result.content?.find(item=>item.type==='text')?.text ?? '';"],
  disposition:['GLIDE_ACCOUNTING_NOTICES[safe ? 2 : 3]].join', "GLIDE_ACCOUNTING_NOTICES[safe ? 2 : 3], ...(safe ? [] : ['delivery=not-sent; retry=safe'])].join"],
  next:["const safe = rows.every(row => row.late || row.disposition.startsWith('refused'));",'const safe = true;'],
  timeout:['const ledger = call.ledger.format(result.isError || misleading);',"const ledger = call.dead ? '' : call.ledger.format(result.isError || misleading);"],
  late:["if (message?.type === 'driver' && (generation !== g || !pending || pending.id !== message.cell || pending.finishing))", "if (message?.type === 'driver' && false)"],
};
if(process.env.GLS2_MUTANT){const pair=mutations[process.env.GLS2_MUTANT];assert.ok(pair);registerHooks({load(url,ctx,next){const loaded=next(url,ctx);if(!/\/repl\/(?:client|action-ledger).mjs$/.test(url))return loaded;const source=String(loaded.source);return source.includes(pair[0])?{...loaded,source:source.replace(pair[0],pair[1]).replace(...(process.env.GLS2_MUTANT==='late' ? ["else if (message?.type === 'driver' && message.cell === pending.id)", "else if (message?.type === 'driver')"] : ['__absent__','__absent__']))}:loaded;}});}
const {createMacReplClient,createWindowsReplClient}=await import('../plugins/sleight/lib/repl/client.mjs');
const {createActionLedger}=await import('../plugins/sleight/lib/repl/action-ledger.mjs');
const text=r=>r.content.map(i=>i.text??'').join('\n');
function fixture(t,options={}){
  let runner,child,next=0;const replies=new Map(),sent=[],facts=[];
  const makeClient=options.platform==='win32'?createWindowsReplClient:createMacReplClient;
  const client=makeClient({platform:options.platform??'darwin',selectNode:()=>({flags:new Set(['--permission','--allow-net'])}),environment:()=>({}),
    driver:{async restart(){},async close(){}},dispatch:async(method,params,ctx)=>{sent.push({method,params});return options.dispatch?.(method,params,ctx)??{delivery:'sent-verified'};},
    inspectHelperCall:()=>true,
    finalize:(result,f)=>{facts.push(f);return result;},
    spawn:()=>{child=new EventEmitter();child.connected=true;child.stdout={resume(){}};child.stderr={resume(){}};
      child.kill=()=>{child.connected=false;queueMicrotask(()=>child.emit('close'));};
      child.send=(m,cb)=>{if(m.type==='driver-result'){replies.get(m.id)?.(m);replies.delete(m.id);}if(m.type==='evaluate')queueMicrotask(async()=>{const result=await runner(m.id);if(result)child.emit('message',{type:'result',id:m.id,result});});cb?.();};return child;}});
  t.after(()=>client.close());
  const request=(cell,method='click',args=[11],metadata={})=>new Promise(resolve=>{const id=++next;replies.set(id,resolve);child.emit('message',{type:'driver',id,cell,method,params:{windowId:'101',processStart:'100.25',readId:1,args},...metadata});});
  const run=fn=>{runner=fn;return client.execute({code:'void 0;',timeout_ms:options.timeout??1000});};
  const result=(isError=false,content=[])=>({isError,content});
  return {run,request,result,sent,facts,get child(){return child;}};
}
test('A1 partial cell is an error, arrival rows and derived next print first',async t=>{const f=fixture(t,{dispatch:(_m,p)=>{if(p.args[0]===3)throw Object.assign(Error('STALE_READ'),{code:'STALE_READ',delivery:'not-sent',retry:'safe',parentSafety:true});return {delivery:'sent-verified'};}});const r=await f.run(async cell=>{for(const n of [1,2,3])await f.request(cell,'click',[n]);return f.result();});assert.equal(r.isError,true);assert.match(r.content[0].text,/^sleight: action ledger\n1 click\(1\).*sent-verified\n2 click\(2\).*sent-verified\n3 click\(3\).*refused STALE_READ/);assert.match(text(r),/3 requests arrived; no later action request reached sleight/);assert.match(text(r),/next=read-again: effects may have occurred/);assert.doesNotMatch(text(r),/retry=safe/);});
test('A2 a single lease refusal prints retry-safe',async t=>{const f=fixture(t,{dispatch:()=>{throw Object.assign(Error('PAUSED'),{code:'PAUSED',delivery:'not-sent',retry:'safe',parentSafety:true});}});const r=await f.run(async cell=>{await f.request(cell);return f.result(true);});assert.match(text(r),/refused PAUSED/);assert.match(text(r),/next=retry-safe/);});
test('A3 a sent click then TypeError preserves input history',async t=>{const f=fixture(t);const r=await f.run(async cell=>{await f.request(cell);return f.result(true,[{type:'text',text:'TypeError: missing field'}]);});assert.match(r.content[0].text,/sent-verified/);assert.match(text(r),/next=read-again/);assert.match(text(r),/TypeError: missing field/);assert.doesNotMatch(text(r),/delivery=not-sent|retry=safe/);});
test('A4 partial typeText gives character count',async t=>{const f=fixture(t,{dispatch:()=>({delivery:'sent-unverified',charactersDelivered:2})});const r=await f.run(async cell=>{await f.request(cell,'typeText',['336']);return f.result(true);});assert.match(text(r),/typeText\("336"\).*sent-unverified, 2 of 3 characters/);});
test('A5 timeout preserves two sent rows and one unknown without deferred trees',async t=>{const f=fixture(t,{timeout:25,dispatch:(_m,p)=>p.args[0]===3?new Promise(()=>{}):{delivery:'sent-verified'}});const r=await f.run(async cell=>{await f.request(cell,'click',[1]);await f.request(cell,'click',[2]);await f.request(cell,'click',[3]);});assert.match(r.content[0].text,/1 click\(1\).*sent-verified\n2 click\(2\).*sent-verified\n3 click\(3\).*unknown/);assert.match(text(r),/REPL_TIMEOUT/);assert.equal(f.facts[0].dead,true);assert.doesNotMatch(text(r),/delivery=not-sent|retry=safe/);});
test('A6 a lost reply remains unknown and never claims safe retry',async t=>{const f=fixture(t,{dispatch:(_m,p)=>{if(p.args[0]===2)throw Object.assign(Error('pipe closed'),{code:'DRIVER_FAILED'});return {delivery:'sent-verified'};}});const r=await f.run(async cell=>{await f.request(cell,'click',[1]);await f.request(cell,'click',[2]);return f.result(true);});assert.match(text(r),/2 click\(2\).*unknown/);assert.doesNotMatch(text(r),/retry=safe|next=retry-safe/);});
test('A7 worker ledger lookalikes remain unchanged after the parent ledger',async t=>{const f=fixture(t),spoof='sleight: 1 click(11) refused';const r=await f.run(async cell=>{await f.request(cell);return f.result(false,[{type:'text',text:spoof}]);});assert.match(r.content[0].text,/sent-verified/);assert.equal(r.content[1].text,spoof);});
test('A8 original selector and bound number both print',async t=>{const f=fixture(t,{dispatch:(_m,_p,ctx)=>{ctx.boundTargets([19]);return {delivery:'sent-verified'};}});const r=await f.run(async cell=>{await f.request(cell,'click',[{id:'Six'}]);return f.result(true);});assert.match(text(r),/click\(\{"id":"Six"\}\) → 19 sent-verified/);});
test('A9 late arrivals refuse before dispatch and appear in the next ledger',async t=>{const f=fixture(t);let old;await f.run(async cell=>{old=cell;return f.result();});let late;const r=await f.run(async()=>{late=await Promise.race([f.request(old,'click',[5]),new Promise(resolve=>setTimeout(()=>resolve(null),30))]);return f.result();});assert.equal(late?.error?.code,'REPL_CELL_ENDED');assert.match(text(r),/late: click\(5\) refused \(cell ended\)/);assert.equal(f.sent.length,0);});
test('A10 a stopped helper is one row with its counts',()=>{const ledger=createActionLedger();let row;for(let i=0;i<2;i++){row=ledger.arrive({method:'getAXState',helper:'pickFromList',helperId:1,params:{args:[]}});ledger.settle(row,'getAXState',{result:{}});}for(let i=0;i<3;i++){row=ledger.arrive({method:'pressKey',helper:'pickFromList',helperId:1,params:{args:['down']}});ledger.settle(row,'pressKey',{result:{delivery:'sent-verified'}});}ledger.settle(row,'pressKey',{error:{code:'STALE_READ',delivery:'not-sent'}});const value=ledger.format(true);assert.equal(ledger.rows.length,1);assert.match(value,/pickFromList.*stopped STALE_READ \[2 reads, 3 keys\]/);assert.match(value,/next=read-again/);});
test('Q1 successful one-action cells omit the ledger',async t=>{const f=fixture(t);const r=await f.run(async cell=>{await f.request(cell);return f.result();});assert.doesNotMatch(text(r),/action ledger/);});
test('A order is not method grouping',async t=>{const f=fixture(t);const r=await f.run(async cell=>{await f.request(cell,'click',[1]);await f.request(cell,'typeText',['x']);await f.request(cell,'click',[2]);return f.result();});assert.match(text(r),/1 click.*\n2 typeText.*\n3 click/);});

test('arrival ledger retains 8 dispatched and 2 busy-refused requests',async t=>{const f=fixture(t,{dispatch:async()=>{await new Promise(resolve=>setTimeout(resolve,20));return {delivery:'sent-verified'};}});const r=await f.run(async cell=>{await Promise.all(Array.from({length:10},(_,n)=>f.request(cell,'click',[n])));return f.result();});assert.equal(r.isError,true);assert.equal(f.sent.length,8);assert.match(r.content[0].text,/9 click\(8\) refused DRIVER_BUSY\n10 click\(9\) refused DRIVER_BUSY/);assert.match(r.content[0].text,/10 requests arrived/);});

test('A6 pipe loss after dispatch retains an unknown row without a reply',async t=>{let f;f=fixture(t,{dispatch:(_m,p)=>{if(p.args[0]===2){queueMicrotask(()=>f.child.emit('close'));return new Promise(()=>{});}return {delivery:'sent-verified'};}});const r=await f.run(async cell=>{await f.request(cell,'click',[1]);await f.request(cell,'click',[2]);});assert.equal(f.sent.length,2);assert.match(text(r),/2 click\(2\) unknown/);assert.match(text(r),/REPL_EXIT/);assert.doesNotMatch(text(r),/retry=safe|next=retry-safe/);});

test('A5 in-flight selector keeps its parent-bound number on timeout',async t=>{const f=fixture(t,{timeout:25,dispatch:(_m,_p,ctx)=>{ctx.boundTargets([19]);return new Promise(()=>{});}});const r=await f.run(async cell=>{await f.request(cell,'click',[{id:'Six'}]);});assert.match(text(r),/click\(\{"id":"Six"\}\) → 19 unknown/);assert.match(text(r),/next=read-again/);assert.doesNotMatch(text(r),/retry=safe/);});

for (const error of [false, true]) test('positive delivery overrides not-sent, error=' + error, async t => {
  const reply = {delivery:'not-sent',code:'TYPE_INTERRUPTED',charactersDelivered:2};
  const f=fixture(t,{dispatch:()=>{if(error)throw Object.assign(Error('interrupted'),reply);return reply;}});
  const r=await f.run(async cell=>{await f.request(cell,'typeText',['336']);return f.result(error);});
  assert.match(text(r),/typeText\("336"\) sent-partial, 2 of 3 characters/);
  assert.match(text(r),/next=read-again/);assert.doesNotMatch(text(r),/next=retry-safe|refused TYPE_INTERRUPTED/);
  assert.equal(f.facts[0].inputPossible,true);
});
test('bounded arguments and rows retain complete cell accounting',()=>{
  const ledger=createActionLedger();
  for(let i=0;i<25;i++){
    const row=ledger.arrive({method:'typeText',params:{args:['a'.repeat(5000)]}});
    ledger.settle(row,'typeText',{result:i===24?{delivery:'sent-verified'}:{delivery:'not-sent',code:'PAUSED'}});
  }
  const value=ledger.format(true), rows=value.split('\n').filter(line=>/^\d+ typeText/.test(line));
  // GLS2E: 20 rows plus the omitted row 25 that decides next=read-again.
  assert.equal(rows.length,21);assert.match(rows[20],/^25 typeText.*sent-verified/);assert.ok(rows.every(row=>Buffer.byteLength(row)<300));
  assert.match(rows[0],/4922 characters omitted/);assert.match(value,/5 more rows/);
  assert.match(value,/25 requests arrived/);assert.match(value,/next=read-again/);
});
test('empty error ledger is one line without retry advice',()=>{
  const value=createActionLedger().format(true);
  assert.equal(value.split('\n').length,1);assert.match(value,/0 requests arrived/);assert.doesNotMatch(value,/next=|retry only/);
});
test('sent input followed by misuse has one delivery statement',async t=>{
  const f=fixture(t);const r=await f.run(async cell=>{
    await f.request(cell);return f.result(true,[{type:'text',text:'sleight: Use app.typeText(text). Operation not sent.'}]);
  });
  assert.match(text(r),/next=read-again/);assert.match(text(r),/Use app.typeText/);assert.doesNotMatch(text(r),/Operation not sent/);
});

test('Windows late driver requests get a not-sent reply and never dispatch',{skip:windowsWorkerSkip},async t=>{
  const f=fixture(t,{platform:'win32'});let old;
  await f.run(async cell=>{old=cell;return f.result();});
  const reply=await Promise.race([f.request(old,'click',[5]),new Promise(resolve=>setTimeout(()=>resolve(null),30))]);
  assert.equal(reply?.error?.code,'REPL_CELL_ENDED');assert.equal(reply.error.delivery,'not-sent');assert.equal(reply.error.retry,'safe');
  assert.equal(f.sent.length,0);
  const next=await f.run(async()=>f.result());assert.doesNotMatch(text(next),/action ledger/);
});
test('Windows busy requests keep delivery metadata and bounded error facts',{skip:windowsWorkerSkip},async t=>{
  const f=fixture(t,{platform:'win32',dispatch:async()=>{await new Promise(resolve=>setTimeout(resolve,20));return {delivery:'sent-verified'};}});
  let replies;
  const result=await f.run(async cell=>{replies=await Promise.all(Array.from({length:10},(_,i)=>f.request(cell,'click',[i])));return f.result();});
  assert.equal(f.sent.length,8);assert.equal(f.facts[0].errors.length,2);
  for(const reply of replies.slice(8))assert.deepEqual(reply.error,{code:'DRIVER_BUSY',delivery:'not-sent',retry:'safe',message:'DRIVER_BUSY'});
  assert.equal(result.isError,false);assert.doesNotMatch(text(result),/action ledger/);
});
test('UTF-8 arguments truncate on character boundaries with exact omission counts',()=>{
  const ledger=createActionLedger(),row=ledger.arrive({method:'typeText',params:{args:['😀'.repeat(5000)]}});
  ledger.settle(row,'typeText',{result:{delivery:'not-sent',code:'PAUSED'}});
  const printed=ledger.format(true).split('\n')[1];
  assert.ok(Buffer.byteLength(printed)<300);assert.doesNotMatch(printed,/\uFFFD/);
  assert.match(printed,/4982 characters omitted/);
});

test('a full verified type retains its verified disposition and character count',()=>{
  const ledger=createActionLedger(),row=ledger.arrive({method:'typeText',params:{args:['336']}});
  ledger.settle(row,'typeText',{result:{delivery:'sent-verified',charactersDelivered:3}});
  assert.match(ledger.format(true),/sent-verified, 3 of 3 characters/);
});
test('an omitted row that may have sent input still prints when every printed row was refused',()=>{
  const ledger=createActionLedger();
  for(let i=0;i<30;i++){const row=ledger.arrive({method:'click',params:{args:[i]}});ledger.settle(row,'click',{error:i===25?undefined:{code:'STALE_READ',delivery:'not-sent'},result:i===25?{delivery:'sent-unverified'}:undefined});}
  const out=ledger.format(true);
  assert.match(out,/10 more rows\n26 click\(25\) sent-unverified/);
  assert.match(out,/next=read-again/);
});
