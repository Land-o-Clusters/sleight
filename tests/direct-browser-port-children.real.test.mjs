import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPageRegistry, hookProof } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';
import { snapshot } from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
import { createCDPFilter } from '../plugins/sleight/lib/direct-browser/cdp-filter.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
const skip=process.env.SLEIGHT_LIVE_DOM_TEST!=='1'&&'DevTools port real-page proof requires the host runner';
test('port guard continues false matches and protects related targets before their first request',{skip,timeout:90000},async t=>{
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
    if(req.url==='/worker.js'||req.url==='/shared.js'||req.url==='/service.js'){
      res.setHeader('content-type','application/javascript');
      const probe=`fetch('http://127.0.0.1:${port}/json/list'${req.url==='/worker.js'?",{mode:'no-cors'}":''}).then(r=>r.text()).then(()=>'loaded',()=>'blocked')`;
      res.end(req.url==='/shared.js'?`onconnect=e=>{${probe}.then(value=>e.ports[0].postMessage(value));};`:
        req.url==='/service.js'?`oninstall=()=>skipWaiting();onactivate=e=>e.waitUntil(clients.claim());onmessage=e=>{${probe}.then(value=>e.source.postMessage(value));};`:
        `${probe}.then(value=>postMessage(value));`);return;
    }
    if(req.url==='/early'||req.url==='/early-frame'){
      res.setHeader('content-type','text/html');
      res.end(req.url==='/early-frame'?`<script>fetch('http://127.0.0.1:${port}/json/list',{mode:'no-cors'}).then(()=>'loaded',()=>'blocked').then(value=>parent.postMessage(value,'*'));</script>`:
        `<script>window.results={};onmessage=e=>results.frame=e.data;const worker=new Worker('/worker.js');worker.onmessage=e=>{results.worker=e.data;worker.terminate();};</script><iframe src="http://frame.test:${server.address().port}/early-frame"></iframe>`);return;
    }
    if(req.url==='/redirect-start'){res.writeHead(302,{location:'/redirect'});res.end();return;}
    if(req.url==='/redirect'){res.writeHead(302,{location:'http://127.0.0.1:'+port+'/json/list'});res.end();return;}
    res.setHeader('content-type','text/html');
    const url='http://127.0.0.1:'+port+'/json/list';
    res.end(`<title>Owned port fixture</title><a target="_blank" href="${url}">Link</a><form target="endpoint-form" action="${url}"><button>Submit</button></form><script>window.probe=()=>fetch('${url}',{mode:'no-cors'}).then(()=>'loaded',()=>'blocked');</script>`);
  });
  t.after(async()=>{
    try{if(filter)assert.equal(await filter.dispose(),true,'filter and related-target watchers collected');await browser?.close();if(socket&&socket.readyState!==3)await new Promise(resolve=>{socket.addEventListener('close',resolve,{once:true});socket.close();});}
    finally{await context?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});assert.equal(existsSync(root),false);}
    t.diagnostic('Cleanup: owned pages and browser closed, filter listener and raw socket closed, foreign fixture untouched, HTTP server and profile collected.');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  context=await chromium.launchPersistentContext(root,{headless:true,executablePath,args:['--remote-debugging-port=0','--site-per-process','--host-resolver-rules=MAP frame.test 127.0.0.1','--no-proxy-server'],viewport:null});
  const foreign=context.pages()[0];await foreign.setContent('<title>Foreign untouched</title><p>Private synthetic fixture</p>');
  const active=readFileSync(join(root,'DevToolsActivePort'),'utf8').trim().split('\n');port=Number(active[0]);
  socket=new WebSocket('ws://127.0.0.1:'+port+active[1]);
  socket.addEventListener('message',event=>{const frame=JSON.parse(event.data);if(frame.id){const p=pending.get(frame.id);pending.delete(frame.id);if(frame.error)p.reject(Error(frame.error.message));else p.resolve(frame.result);}else for(const fn of listeners)fn(frame);});
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  filter=createCDPFilter({session:upstream,protectedPort:port});const listener=await filter.listen();
  browser=await chromium.connectOverCDP(listener.endpoint,{noDefaults:true,timeout:10000});
  const origin='http://127.0.0.1:'+server.address().port;
  const protectedURL='http://127.0.0.1:'+port+'/json/list';
  const ownedPage=async()=>{const page=await browser.contexts()[0].newPage();await page.goto(origin);return page;};
  await t.test('false port matches in paths and queries complete without a client Fetch handler',async()=>{
    const page=await ownedPage();
    try{
      for(const path of ['/a:'+port+'/b','/?next=http://x:'+port+'/y']){
        const response=await page.goto(origin+path,{timeout:3000});assert.equal(response.status(),200);
      }
    }finally{await page.close();}
  });
  for (const kind of ['window.open', 'link', 'form']) await t.test(kind+' endpoint popup closes before any model read',async()=>{
    const session=await browser.newBrowserCDPSession();
    const pages=createPageRegistry({browser,session,upstream,ownTarget:filter.own,releaseTarget:filter.release,endpointBlocked:filter.endpointBlocked,endpoint:protectedURL});
    let reads=0,popup;
    const dispatcher=createToolDispatcher({browser:'bfixture',pages,endpoint:protectedURL,
      snapshot:async page=>{reads++;return snapshot(page);},
      runSteps:async entry=>{await entry.settlePopups({windows:0,popups:0});return {lines:entry.popups.map(row=>row.blocked?'blocked: DevTools endpoint':'popup: '+row.tab)};},
      fillFields:async()=>assert.fail('no fill expected')});
    try{
      const {tab}=await pages.openTab({url:origin}),entry=pages.tab(tab);
      // Exercise the browser's native popup path, which scoped auto-attach does
      // not pause. This fixture removes only its own disposition hook.
      await entry.page.evaluate(({key,proof})=>window[key].off(proof),{key:entry.hook.key,proof:hookProof(entry.hook,'off')});
      const before=reads,focused=await foreign.evaluate(()=>document.hasFocus());
      const opening=context.waitForEvent('page',{timeout:5000});
      if(kind==='window.open')await entry.page.evaluate(url=>{window.open(url,'_blank');},protectedURL);
      else if(kind==='link')await entry.page.getByRole('link',{name:'Link'}).click();
      else await entry.page.getByRole('button',{name:'Submit'}).click();
      popup=await opening;
      for(let n=0;n<250&&!popup.isClosed();n++)await new Promise(resolve=>setTimeout(resolve,20));
      assert.equal(popup.isClosed(),true,'adopted endpoint popup must close before model reads');
      await pages.idle();
      const result=await dispatcher.call({name:'browser_act',arguments:{tab,steps:[{do:'wait'}],observe:'none'}});
      if(result.text!=='blocked: DevTools endpoint')t.diagnostic(JSON.stringify({kind,notices:entry.popups,windows:entry.windowOpenNo,result}));
      assert.equal(result.text,'blocked: DevTools endpoint');
      assert.equal(reads,before,'no endpoint snapshot reached the model');
      assert.doesNotMatch(JSON.stringify(await pages.list()),/json\/list|webSocketDebuggerUrl|Foreign untouched/);
      assert.equal(await foreign.evaluate(()=>document.hasFocus()),focused);
      assert.equal((await pages.list()).length,1,'blocked popup has no model-visible tab handle');
    }finally{assert.deepEqual(await dispatcher.end(),{revoked:true,cleanup:[]});await popup?.close();await session.detach();}
  });
  await t.test('a 302 chain closes its exact owned tab and leaves tab listing usable',async()=>{
    const session=await browser.newBrowserCDPSession();
    const pages=createPageRegistry({browser,session,upstream,ownTarget:filter.own,releaseTarget:filter.release,endpointBlocked:filter.endpointBlocked,endpoint:protectedURL});
    const dispatcher=createToolDispatcher({browser:'bfixture',pages,endpoint:protectedURL,snapshot,
      runSteps:async()=>assert.fail('no input'),fillFields:async()=>assert.fail('no fill')});
    try{
      const safe=await pages.openTab({url:origin});
      const result=await dispatcher.call({name:'browser_open',arguments:{url:origin+'/redirect-start'}});
      assert.deepEqual(result,{text:'blocked: DevTools endpoint',isError:true});
      const rows=await pages.list();assert.equal(rows.length,1);assert.equal(rows[0].tab,safe.tab);
      const listed=await dispatcher.call({name:'browser_tabs',arguments:{do:'list'}});
      assert.equal(listed.isError,false);assert.match(listed.text,new RegExp(safe.tab));
      assert.doesNotMatch(listed.text,/json\/list|DevTools|webSocketDebuggerUrl/);
      assert.equal(browser.contexts()[0].pages().length,1,'only the safe owned page remains');
    }finally{assert.deepEqual(await dispatcher.end(),{revoked:true,cleanup:[]});await session.detach();}
  });
  await t.test('two blank popups preserve the safe one and close only the endpoint target',async()=>{
    const session=await browser.newBrowserCDPSession();
    const pages=createPageRegistry({browser,session,upstream,ownTarget:filter.own,releaseTarget:filter.release,endpointBlocked:filter.endpointBlocked,endpoint:protectedURL});
    try{
      const {tab}=await pages.openTab({url:origin}),entry=pages.tab(tab);
      await entry.page.evaluate(({key,proof})=>window[key].off(proof),{key:entry.hook.key,proof:hookProof(entry.hook,'off')});
      await entry.page.evaluate(url=>{
        const safe=window.open('about:blank','safe-popup');safe.document.title='Safe blank popup';
        window.open(url,'blocked-popup');
      },protectedURL);
      for(let n=0;n<250;n++){
        await pages.idle();
        if(entry.popups.some(row=>row.blocked&&row.closed)&&entry.popups.some(row=>row.tab))break;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      const rows=await pages.list();assert.equal(rows.length,2);
      const safe=rows.find(row=>row.tab!==tab);assert.ok(safe);assert.equal(safe.url,'about:blank');
      assert.equal(await pages.tab(safe.tab).page.title(),'Safe blank popup');
      assert.deepEqual(entry.popups.filter(row=>row.blocked),[{opener:tab,closed:true,blocked:true}]);
    }finally{assert.equal((await pages.endTurn()).cleanedUp,true);await session.detach();}
  });
  await t.test('site-isolated iframe cannot fetch the port',async()=>{
    const page=await ownedPage(),before=calls.length;
    try{
      await page.evaluate(url=>{const frame=document.createElement('iframe');frame.src=url;document.body.append(frame);},'http://frame.test:'+server.address().port);
      await page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow!==null);
      let frame;
      for(let n=0;n<100&&!frame;n++){
        frame=page.frames().find(frame=>frame.url().startsWith('http://frame.test:'));
        if(!frame)await new Promise(resolve=>setTimeout(resolve,20));
      }
      assert.ok(frame,'cross-site frame attached');
      await frame.waitForLoadState('domcontentloaded',{timeout:5000});
      assert.equal(await frame.evaluate(()=>window.probe()),'blocked');
      assert.ok(calls.slice(before).some(row=>row.method==='Fetch.enable'&&row.route!=='root'),'child session guarded');
      const {targetInfos}=await upstream.send('Target.getTargets');assert.ok(targetInfos.some(info=>info.type==='iframe'),'fixture is an OOPIF');
    }finally{await page.close();}
  });
  await t.test('initial OOPIF and worker scripts are guarded without Playwright auto-attach',async()=>{
    const {targetId}=await upstream.send('Target.createTarget',{url:'about:blank',background:true});
    const early=createCDPFilter({session:upstream,ownedTargets:[targetId],protectedPort:port});
    try{
      const {sessionId}=await early.session.send('Target.attachToTarget',{targetId,flatten:true});
      await early.session.send('Page.navigate',{url:origin+'/early'},sessionId);
      let results={};
      for(let n=0;n<100;n++){
        const reply=await upstream.send('Runtime.evaluate',{expression:'JSON.stringify(window.results||{})',returnByValue:true},sessionId);
        results=JSON.parse(reply.result.value);if(results.frame&&results.worker)break;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      assert.deepEqual(results,{worker:'blocked',frame:'blocked'});
    }finally{await early.dispose();await upstream.send('Target.closeTarget',{targetId});}
  });
  for(const kind of ['dedicated'])await t.test(kind+' worker cannot fetch the port',async()=>{
    const page=await ownedPage(),before=calls.length;
    try{
      const result=await page.evaluate(async kind=>{
        return await new Promise(async(resolve,reject)=>{
          const timer=setTimeout(()=>reject(Error('worker result timed out')),5000);
          const done=value=>{clearTimeout(timer);resolve(value);};
          try{
            if(kind==='dedicated'){const worker=new Worker('/worker.js');worker.onmessage=e=>{worker.terminate();done(e.data);};worker.onerror=e=>reject(Error(e.message));}
            else if(kind==='shared'){const worker=new SharedWorker('/shared.js');worker.port.onmessage=e=>{worker.port.close();done(e.data);};worker.port.start();}
            else{const registration=await navigator.serviceWorker.register('/service.js');await navigator.serviceWorker.ready;navigator.serviceWorker.onmessage=async e=>{await registration.unregister();done(e.data);};registration.active.postMessage('probe');}
          }catch(error){clearTimeout(timer);reject(error);}
        });
      },kind);
      assert.equal(result,'blocked');
      assert.ok(calls.slice(before).some(row=>row.method==='Fetch.failRequest'),'worker request blocked by guard');
    }finally{await page.close();}
  });
  await t.test('shared worker cannot read endpoint responses through CORS',async()=>{
    const page=await ownedPage();
    try{
      const result=await page.evaluate(async url=>{
        const blob=new Blob([`onconnect=e=>{fetch(${JSON.stringify(url)}).then(r=>r.text()).then(value=>e.ports[0].postMessage(value),()=>e.ports[0].postMessage('cors-blocked'));};`],{type:'application/javascript'});
        const source=URL.createObjectURL(blob),worker=new SharedWorker(source);
        try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('worker timed out')),5000);worker.port.onmessage=e=>{clearTimeout(timer);resolve(e.data);};worker.port.start();});}
        finally{worker.port.close();URL.revokeObjectURL(source);}
      },protectedURL);
      assert.equal(result,'cors-blocked');
    }finally{await page.close();}
  });
  await t.test('service worker stays unattached and cannot read endpoint responses through CORS',async()=>{
    const page=await ownedPage(),before=calls.length;
    try{
      const result=await page.evaluate(async()=>{
        const registration=await navigator.serviceWorker.register('/service.js');
        await navigator.serviceWorker.ready;
        try{return await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(Error('service worker timed out')),5000);
          navigator.serviceWorker.onmessage=e=>{clearTimeout(timer);resolve(e.data);};
          registration.active.postMessage('probe');
        });}finally{await registration.unregister();}
      });
      assert.equal(result,'blocked');
      // The browser-level port guard may fail its request at the root; no session attaches to the service worker.
      assert.ok(!calls.slice(before).some(row=>row.method==='Fetch.failRequest'&&row.route!=='root'),'service worker is outside owned page routes');
    }finally{await page.close();}
  });
  assert.equal(await foreign.title(),'Foreign untouched');assert.equal(foreign.isClosed(),false);
  assert.ok(!calls.some(row=>['Page.bringToFront','Target.activateTarget','Browser.setWindowBounds'].includes(row.method)));
});
