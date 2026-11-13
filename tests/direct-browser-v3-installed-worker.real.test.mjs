import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { createV3Bridge } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { prepareInstalledStartup } from '../plugins/sleight/lib/launch.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { PassThrough } from 'node:stream';

const skip=process.env.SLEIGHT_LIVE_DOM_TEST!=='1'&&'installed real pages require the host runner';
for (const loss of ['close','parent','ui']) test('installed v3 real local tools and '+loss+' cleanup use the production worker path', {skip,timeout:90000},async t=>{
  const {chromium}=await import('../plugins/sleight/vendor/playwright-core/index.mjs');
  const spec=JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json',import.meta.url))).browsers.find(b=>b.name==='chromium-headless-shell');
  const executable=join(homedir(),'Library/Caches/ms-playwright','chromium_headless_shell-'+spec.revision,'chrome-headless-shell-'+(process.platform==='darwin'?'mac-'+process.arch:'linux64'),'chrome-headless-shell');
  assert.ok(existsSync(executable),'pinned headless browser must exist');
  const root=trackTemp(realpathSync(mkdtempSync(join(tmpdir(),'sleight-v7b-installed-')))),receiptPath=join(root,'receipt.json');
  const posts=[];
  const server=createServer((req,res)=>{
    if(req.url==='/submit'){let body='';req.on('data',c=>body+=c);req.on('end',()=>{posts.push(body);res.end('<title>Saved fixture</title><p>Saved '+new URLSearchParams(body).get('name')+'</p>');});return;}
    res.end('<!doctype html><title>Installed local form</title><form method="post" action="/submit"><label>Name<input name="name"></label><button>Save record</button></form><button type="button" onclick="this.textContent=\'Changed\'">Change label</button>');
  });
  let context,bridge,relay,child,exited;
  t.after(async()=>{
    try {relay?.dispose();await bridge?.close();if(child?.connected)child.disconnect();if(exited){const result=await exited;assert.deepEqual(result,{code:0,signal:null});}}
    finally {await context?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});assert.equal(existsSync(root),false);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  context=await chromium.launchPersistentContext(root,{headless:true,executablePath:executable,args:['--remote-debugging-port=0'],viewport:null});
  const foreign=context.pages()[0];await foreign.setContent('<title>Foreign untouched</title><p>Private fixture</p>');
  const port=readFileSync(join(root,'DevToolsActivePort'),'utf8').trim().split('\n');
  bridge=await createV3Bridge({startupTimeoutMs:15000,timeoutMs:15000},{readConfig:()=>({}),acceptPackage:()=>({current:()=>true}),
    forkWorker(_path,_args,options){child=fork(new URL('./fixtures/v3-installed-worker.mjs',import.meta.url),['ws://127.0.0.1:'+port[0]+port[1],receiptPath],{...options,stdio:['ignore','ignore','inherit','ipc','pipe']});exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));return child;}});
  child.stdio[4].on('data',()=>{});
  const prepared=await prepareInstalledStartup(()=>bridge);
  const clientIn=new PassThrough(),clientOut=new PassThrough(),serverIn=new PassThrough(),serverOut=new PassThrough(),replies=new Map();
  clientOut.on('data',bytes=>{for(const line of bytes.toString().trim().split('\n')){const msg=JSON.parse(line);replies.set(msg.id,msg);}});
  relay=createRelay({clientIn,clientOut,serverIn,serverOut,...prepared,changeReview:false});let serial=0;
  const request=async(method,params)=>{const id=++serial;clientIn.write(JSON.stringify({id,method,params})+'\n');const until=Date.now()+20000;while(!replies.has(id)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(replies.has(id),'relay result '+id);return replies.get(id).result;};
  const listing=request('tools/list',{});serverOut.write(JSON.stringify({id:serial,result:{tools:[{name:'js',description:'engine',inputSchema:{type:'object'}}]}})+'\n');
  assert.ok((await listing).tools.some(x=>x.name==='js'));
  for(const name of ['browser_open','browser_read','browser_act','browser_fill','browser_tabs'])assert.ok(replies.get(serial).result.tools.some(x=>x.name===name));
  const boot=await request('tools/call',{name:'turn_ended',arguments:{sleight_turbo:{event:'bootstrap'}}});
  const envelope=JSON.parse(boot.content[0].text).sleightTurbo;
  assert.equal((await request('tools/call',{name:'turn_ended',arguments:{sleight_turbo:{...envelope,event:'begin',turn:'real-one',text:'Fill Name with Ada and save the record.'}}})).isError,false);
  const call=async(name,args)=>{const result=await request('tools/call',{name,arguments:args});assert.equal(result.isError,false,JSON.stringify(result));return result.content.map(x=>x.text??'').join('\n');};
  for(const url of ['http://127.0.0.1:'+port[0]+'/json/activate/foreign','http://localhost:'+port[0]+'/json/close/foreign','http://127.0.0.1:'+port[0]+'/json/list']){
    const refused=await request('tools/call',{name:'browser_open',arguments:{url}});assert.equal(refused.isError,true);assert.match(refused.content[0].text,/DevTools/);
  }
  assert.equal(context.pages().length,1);assert.equal(await foreign.title(),'Foreign untouched');
  const opened=await call('browser_open',{url:'http://127.0.0.1:'+server.address().port});
  const tab=/^t\w+/.exec(opened)?.[0];assert.ok(tab,opened);
  const ref=(text,label)=>{const row=text.split('\n').find(line=>line.includes('[ref=')&&line.includes('"'+label+'"'));assert.ok(row,text);const found=/\[ref=(e\d+)\]/.exec(row);assert.ok(found,row);return found[1];};
  const field=ref(opened,'Name');
  const read=await call('browser_read',{tab});assert.match(read,/untrusted/);
  assert.match(await call('browser_act',{tab,steps:[{do:'click',ref:ref(read,'Change label')}]}),/Changed/);
  const fields=await call('browser_read',{tab});
  assert.match(await call('browser_fill',{tab,fields:[{ref:field,value:'Ada'}],submit:ref(fields,'Save record')}),/set/);
  const until=Date.now()+5000;while(!posts.length&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(posts,['name=Ada']);
  assert.match(await call('browser_read',{tab}),/Saved Ada/);
  assert.match(await call('browser_tabs',{do:'list'}),new RegExp(tab));
  await call('browser_tabs',{do:'close',tab});assert.equal(await foreign.title(),'Foreign untouched');
  assert.equal(await call('browser_tabs',{do:'list'}),'No owned tabs.');
  // Leave a page for the production loss handler to collect.
  await call('browser_open',{url:'http://127.0.0.1:'+server.address().port});
  relay.dispose();relay=undefined;
  if(loss==='close') assert.deepEqual(await bridge.close(),{revoked:true,cleanup:[]});
  else if(loss==='parent') child.disconnect();
  else child.stdio[4].end();
  assert.deepEqual(await exited,{code:0,signal:null});
  const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));assert.equal(receipt.disconnected,true);assert.equal(receipt.uiClosed,true);
  assert.equal(context.pages().length,1);assert.equal(await foreign.title(),'Foreign untouched');assert.deepEqual(receipt.result.cleanup,[]);
  assert.ok(receipt.wire.filter(x=>x.method==='Target.createTarget').every(x=>x.params.background===true));
  assert.ok(!receipt.wire.some(x=>['Page.bringToFront','Target.activateTarget','Browser.setWindowBounds'].includes(x.method)));
  t.diagnostic('Cleanup: installedWorkerExited=true rawSocketClosed=true ownedTabsClosed=true foreignTabUntouched=true profileDeleted=true. Native UI/package/process proof uses synthetic providers; five-tool fork/filter/page/snapshot/action/fill/private-context route is real.');
});
