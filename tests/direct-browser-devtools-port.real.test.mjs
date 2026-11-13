import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCDPFilter } from '../plugins/sleight/lib/direct-browser/cdp-filter.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
const skip=process.env.SLEIGHT_LIVE_DOM_TEST!=='1'&&'DevTools port real-page proof requires the host runner';
test('owned real pages cannot reach the selected DevTools listener through navigation or subresources',{skip,timeout:90000},async t=>{
  const {chromium}=await import('../plugins/sleight/vendor/playwright-core/index.mjs');
  const spec=JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json',import.meta.url))).browsers.find(b=>b.name==='chromium-headless-shell');
  const executablePath=join(homedir(),'Library/Caches/ms-playwright','chromium_headless_shell-'+spec.revision,'chrome-headless-shell-'+(process.platform==='darwin'?'mac-'+process.arch:'linux64'),'chrome-headless-shell');
  assert.ok(existsSync(executablePath),'pinned headless browser required');
  const root=trackTemp(realpathSync(mkdtempSync(join(tmpdir(),'sleight-port-'))));
  let context,browser,filter,socket,port;
  const calls=[],pending=new Map(),listeners=new Set();let serial=0;
  const upstream={sessionId:'root',on(name,fn){assert.equal(name,'event');listeners.add(fn);},off(name,fn){assert.equal(name,'event');listeners.delete(fn);},
    send(method,params={},route='root'){
      calls.push({method,params,route});const id=++serial;
      return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,...route==='root'?{}:{sessionId:route}}));});
    }};
  const server=createServer((req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{location:'http://127.0.0.1:'+port+'/json/list'});res.end();return;}
    res.setHeader('content-type','text/html');
    const url='http://127.0.0.1:'+port+'/json/list';
    res.end(`<title>Owned port fixture</title><a href="${url}">Link</a><form action="${url}"><button>Submit</button></form><script>window.probe=()=>fetch('${url}',{mode:'no-cors'}).then(()=>'loaded',()=>'blocked');</script>`);
  });
  t.after(async()=>{
    try{await filter?.dispose();await browser?.close();if(socket&&socket.readyState!==3)await new Promise(resolve=>{socket.addEventListener('close',resolve,{once:true});socket.close();});}
    finally{await context?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});assert.equal(existsSync(root),false);}
    t.diagnostic('Cleanup: owned pages and browser closed, filter listener and raw socket closed, foreign fixture untouched, HTTP server and profile collected.');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  context=await chromium.launchPersistentContext(root,{headless:true,executablePath,args:['--remote-debugging-port=0'],viewport:null});
  const foreign=context.pages()[0];await foreign.setContent('<title>Foreign untouched</title><p>Private synthetic fixture</p>');
  const active=readFileSync(join(root,'DevToolsActivePort'),'utf8').trim().split('\n');port=Number(active[0]);
  socket=new WebSocket('ws://127.0.0.1:'+port+active[1]);
  socket.addEventListener('message',event=>{const frame=JSON.parse(event.data);if(frame.id){const p=pending.get(frame.id);pending.delete(frame.id);if(frame.error)p.reject(Error(frame.error.message));else p.resolve(frame.result);}else for(const fn of listeners)fn(frame);});
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  filter=createCDPFilter({session:upstream,protectedPort:port});const listener=await filter.listen();
  browser=await chromium.connectOverCDP(listener.endpoint,{noDefaults:true,timeout:10000});
  const origin='http://127.0.0.1:'+server.address().port;
  for(const kind of ['redirect','link','form','fetch','script'])await t.test(kind,async()=>{
    const page=await browser.contexts()[0].newPage();
    try{
      if(kind==='redirect')await assert.rejects(page.goto(origin+'/redirect'),/ERR_BLOCKED_BY_CLIENT|ERR_FAILED/);
      else{
        await page.goto(origin);
        if(kind==='fetch')assert.equal(await page.evaluate(()=>window.probe()),'blocked');
        else{
          const failed=page.waitForEvent('requestfailed',{predicate:request=>request.url().includes(':'+port+'/'),timeout:5000});
          if(kind==='script')await page.evaluate(url=>{const script=document.createElement('script');script.src=url;document.head.append(script);},'http://127.0.0.1:'+port+'/json/list');
          else await page.locator(kind==='link'?'a':'button').click({noWaitAfter:true});
          await failed;
        }
      }
      assert.equal(await foreign.title(),'Foreign untouched');assert.equal(foreign.isClosed(),false);
    }finally{await page.close();}
  });
  assert.ok(calls.filter(row=>row.method==='Fetch.failRequest'&&row.params.errorReason==='BlockedByClient').length>=5);
  assert.ok(!calls.some(row=>['Page.bringToFront','Target.activateTarget','Browser.setWindowBounds'].includes(row.method)));
});
