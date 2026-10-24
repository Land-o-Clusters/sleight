import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {chromium} from '../plugins/sleight/vendor/playwright-core/index.mjs';
import {newHook,hookSource} from '../plugins/sleight/lib/direct-browser/page.mjs';
import {readWhole} from '../plugins/sleight/lib/direct-browser/whole.mjs';
import {createWholeDOM} from '../plugins/sleight/lib/direct-browser/whole-dom.mjs';
import {guardWholeRead} from '../plugins/sleight/lib/direct-browser/whole-guard.mjs';
import {protectWholeRows} from '../plugins/sleight/lib/direct-browser/snapshot.mjs';
const pin=JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json',import.meta.url))).browsers.find(b=>b.name==='chromium-headless-shell');
const executablePath=join(homedir(),'Library/Caches/ms-playwright','chromium_headless_shell-'+pin.revision,'chrome-headless-shell-mac-'+process.arch,'chrome-headless-shell');
const skip=process.env.SLEIGHT_LIVE_DOM_TEST!=='1'?'requires headless fixture opt-in':!existsSync(executablePath)?'pinned headless shell unavailable':false;
const shell=(rows,extra='',script='')=>`<!doctype html><meta charset="utf-8"><style>body{margin:0}#box{height:560px;width:850px;overflow:auto}article{min-height:36px}button{height:28px}</style><aside id="clock"></aside><div id="box" role="log"><p>Beginning of chat</p><div id="rows" role="list">${rows.replaceAll("<article",'<article role="listitem"')}</div>${extra}<p>You're all caught up</p></div><script>window.clicked=[];${script}</script>`;
async function harness(t,html,{worker}={}){
 const requests=[],cleanups=[];
 const server=createServer((req,res)=>{
  requests.push({method:req.method,path:req.url});
  res.setHeader('access-control-allow-origin','*');res.setHeader('access-control-allow-methods','GET, POST, OPTIONS');res.setHeader('access-control-allow-headers','x-fixture');
  if(req.url==='/sw.js'){res.setHeader('content-type','text/javascript');res.end(worker??'');}
  else if(req.url==='/'){res.setHeader('content-type','text/html');res.end(html);}
  else res.end('ok');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true,executablePath});t.after(async()=>{try{for(const close of cleanups.reverse())await close();}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}});
 const context=await browser.newContext({viewport:{width:900,height:700}}),hook=newHook();await context.addInitScript({content:hookSource(hook)});
 const page=await context.newPage(),base='http://127.0.0.1:'+server.address().port;await page.goto(base+'/');
 return {page,context,requests,base,cleanup:fn=>cleanups.push(fn),entry:{page,hook,state:{},popups:[]}};
}
const lines=text=>[...text.matchAll(/^item \d+ of \d+: (.+)$/gm)].map(m=>JSON.parse(m[1]));

test('review: collapsed transaction buttons never qualify as expanders',{skip,timeout:20000},async t=>{
 const names=['Confirm purchase','Approve','Subscribe','Place order','Send','Remove'];
 const h=await harness(t,shell(names.map((name,i)=>`<article data-key="${i}"><button type="button" aria-expanded="false">${name}</button></article>`).join(''),'',`document.querySelectorAll('button').forEach(b=>b.onclick=()=>{clicked.push(b.textContent);new Image().src='/danger?'+encodeURIComponent(b.textContent)});`));
 const read=await readWhole(h.entry,{max_seconds:14});
 assert.deepEqual(await h.page.evaluate(()=>clicked),[],read.text);assert.equal(h.requests.filter(r=>r.path.startsWith('/danger')).length,0);assert.match(read.text,/Clicks: 0\./);
});

test('review: explicit English and localized expander names work without collapsed authority',{skip,timeout:10000},async t=>{
 const names=['Older','Earlier','Previous messages','See replies','Expand thread','Mostrar más','Afficher plus','Mehr anzeigen','Carica altri','もっと見る','显示更多'];
 const h=await harness(t,shell('<article data-key="one">one</article>',names.map(n=>`<button type="button">${n}</button>`).join(''),`document.querySelectorAll('button').forEach(b=>b.onclick=()=>{clicked.push(b.textContent);b.remove()});`));
 const dom=await createWholeDOM(h.page);h.cleanup(()=>dom.dispose());const view=await dom.view();
 assert.deepEqual(view.controls.filter(c=>c.allowed).map(c=>c.name),names);
});

test('review: a late-loading First message item is not a start marker',{skip,timeout:22000},async t=>{
 const h=await harness(t,shell('<article data-key="first">First message</article><article data-key="last">last</article>','','document.querySelector("#box>p").remove();setTimeout(()=>{const n=document.createElement("article");n.dataset.key="older";n.textContent="late older item";rows.prepend(n)},3500);'));
 const read=await readWhole(h.entry,{direction:'up',max_seconds:16});
 assert.match(read.text,/Start: unknown\./,read.text);assert.match(read.text,/late older item/);assert.match(read.text,/Complete: NO\./);
});

test('review: a start marker far from the top cannot prove that edge',{skip,timeout:10000},async t=>{
 const h=await harness(t,shell('<article>one</article><article>two</article>','<p id="decoy">Beginning of chat</p>','document.querySelector("#box>p").remove();rows.style.height="1800px";box.scrollTop=box.scrollHeight;'));
 const dom=await createWholeDOM(h.page);h.cleanup(()=>dom.dispose());assert.equal((await dom.view()).markers.start,undefined);
});

test('review: unrelated mutations do not stall item-container quiet',{skip,timeout:16000},async t=>{
 const h=await harness(t,shell('<article data-key="a">one original message long enough to select the item list</article><article data-key="b">two original message long enough to select the item list</article>','','setInterval(()=>clock.textContent=String(Date.now()),30);'));
 const read=await readWhole(h.entry,{direction:'up',max_seconds:11});assert.match(read.text,/Start: reached\./,read.text);assert.doesNotMatch(read.text,/never quiet|time cap/);
});

test('review: reverse flex and negative scrollTop are read in visual top-first order',{skip,timeout:25000},async t=>{
 const h=await harness(t,`<!doctype html><style>body{margin:0}#box{width:850px;height:560px;overflow:auto;display:flex;flex-direction:column-reverse}#rows{display:flex;flex-direction:column-reverse;flex:none}article{height:90px}</style><div id="box" role="log"><p style="flex:none">You're all caught up</p><div role="list" id="rows">${Array.from({length:10},(_,i)=>`<article data-key="${10-i}">row ${10-i}</article>`).join('')}</div><p style="flex:none">Beginning of chat</p></div>`);
 const read=await readWhole(h.entry,{max_seconds:20});assert.deepEqual(lines(read.text),Array.from({length:10},(_,i)=>'row '+(i+1)),read.text);assert.match(read.text,/Start: reached\./);assert.match(read.text,/End: reached\./);
});

test('review: same-URL endpoint keys invalidate held find and from',{skip,timeout:45000},async t=>{
 const h=await harness(t,shell('<article data-key="old-a">old first</article><article data-key="old-b">old last</article>'));
 await readWhole(h.entry,{max_seconds:14});
 await h.page.evaluate(()=>rows.innerHTML='<article data-key="new-a">new first</article><article data-key="new-b">new last</article>');
 const found=await readWhole(h.entry,{find:'new',max_seconds:14});assert.match(found.text,/new first/);assert.doesNotMatch(found.text,/old first|old last/);
 await h.page.evaluate(()=>rows.innerHTML='<article data-key="third-a">third first</article><article data-key="third-b">third last</article>');
 const from=await readWhole(h.entry,{from:2,direction:'up',max_seconds:8});assert.match(from.text,/third last/);assert.doesNotMatch(from.text,/new last/);
});

test('review: service worker cannot proxy an expander POST and bypass is restored',{skip,timeout:15000},async t=>{
 const worker=`self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/proxy')e.respondWith(fetch('/danger',{method:'POST',body:'worker'}));else if(new URL(e.request.url).pathname==='/probe')e.respondWith(new Response('worker'));});`;
 const h=await harness(t,shell('<article data-key="a">one</article><article data-key="z">last</article>','<button type="button" id="more">Load more</button>',`more.onclick=()=>fetch('/proxy').catch(()=>{});`),{worker});
 await h.page.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));});
 assert.equal(await h.page.evaluate(()=>fetch('/probe').then(r=>r.text())),'worker');
 const read=await readWhole(h.entry,{max_seconds:7});assert.match(read.text,/Clicks: 1\./,read.text);assert.equal(h.requests.filter(r=>r.method==='POST').length,0,read.text);
 assert.equal(await h.page.evaluate(()=>fetch('/probe').then(r=>r.text())),'worker');
});

test('review: GET CORS preflights pass and blocked expander POST reports method and origin',{skip,timeout:15000},async t=>{
 const h=await harness(t,shell('<article data-key="a">one</article><article data-key="z">last</article>','<button type="button" id="more">Load more</button>'));
 // Another loopback origin forces a real preflight. The server remains a fixture we own.
 await h.page.evaluate(base=>{window.other=base.replace('127.0.0.1','localhost');more.onclick=async()=>{try{await fetch(other+'/history',{headers:{'x-fixture':'read'}});rows.insertAdjacentHTML('beforeend','<article data-key="b">two</article>');more.remove();}catch{}};},h.base);
 const read=await readWhole(h.entry,{direction:'up',max_seconds:8});assert.ok(h.requests.some(r=>r.method==='OPTIONS'&&r.path==='/history'),read.text);assert.ok(h.requests.some(r=>r.method==='GET'&&r.path==='/history'),read.text);assert.match(read.text,/two/);assert.doesNotMatch(read.text,/blocked expander effect/);
 await h.page.evaluate(()=>{const b=document.createElement('button');b.type='button';b.textContent='Load more';b.onclick=()=>fetch('/danger',{method:'POST'}).catch(()=>{});box.append(b);});
 const blocked=await readWhole(h.entry,{max_seconds:3});assert.match(blocked.text,new RegExp('POST '+h.base.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),blocked.text);assert.equal(h.requests.filter(r=>r.method==='POST').length,0);
});

test('review: background POST outside the click window passes without failing the read',{skip,timeout:15000},async t=>{
 const h=await harness(t,shell('<article data-key="a">one</article><article data-key="z">last</article>'));
 const read=readWhole(h.entry,{direction:'up',max_seconds:9});await new Promise(r=>setTimeout(r,1000));
 assert.equal(await h.page.evaluate(()=>fetch('/telemetry',{method:'POST'}).then(r=>r.text()).catch(()=> 'blocked')),'ok');
 const result=await read;assert.match(result.text,/Start: reached\./,result.text);assert.doesNotMatch(result.text,/blocked:/);
 const bank={blocked:[]},guard=await guardWholeRead(h.entry,Date.now()+5000,bank);h.cleanup(()=>guard.close());guard.expanderClick();await new Promise(r=>setTimeout(r,2100));
 assert.equal(await h.page.evaluate(()=>fetch('/after-window',{method:'POST'}).then(r=>r.text()).catch(()=> 'blocked')),'ok');assert.deepEqual(bank.blocked,[]);
});

test('review: DOM redaction captures each renderer once per merge batch',{skip,timeout:10000},async t=>{
 const h=await harness(t,shell('<article>secret-fixture-value</article>','<input type="password" value="secret-fixture-value"><iframe srcdoc="<p>child</p>"></iframe><iframe srcdoc="<p>child two</p>"></iframe>'));
 const context=h.context,original=context.newCDPSession.bind(context);let captures=0;
 context.newCDPSession=async target=>{const session=await original(target),send=session.send.bind(session);session.send=(method,...args)=>{if(method==='DOMSnapshot.captureSnapshot')captures++;return send(method,...args);};return session;};
 const protectedRows=await protectWholeRows(h.page,[{text:'secret-fixture-value'}]);assert.equal(protectedRows[0].text,'[redacted]');assert.equal(captures,1);
});

test('review: more than 50000 elements has a clear partial reason',{skip,timeout:12000},async t=>{
 const h=await harness(t,shell('<article>one</article>','','rows.innerHTML="<span>x</span>".repeat(50001);'));
 const read=await readWhole(h.entry,{max_seconds:5});assert.match(read.text,/50,000 elements/);assert.match(read.text,/Complete: NO\./);
});

test('review: unavailable service-worker bypass refuses the read before input',{skip,timeout:10000},async t=>{
 const worker="self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));";
 const h=await harness(t,shell('<article>one real message</article><article>second real message</article>','<button type="button" id="more">Load more</button>',"more.onclick=()=>{clicked.push('more');fetch('/danger',{method:'POST'}).catch(()=>{})}"),{worker});
 await h.page.evaluate(async()=>{await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));});
 const original=h.context.newCDPSession.bind(h.context);
 h.context.newCDPSession=async target=>{const session=await original(target),send=session.send.bind(session);session.send=(method,...args)=>method==='Network.setBypassServiceWorker'?Promise.reject(Error('fixture unsupported command')):send(method,...args);return session;};
 const result=await readWhole(h.entry,{max_seconds:3});assert.match(result.text,/service worker bypass unavailable/);assert.match(result.text,/Clicks: 0\./);assert.deepEqual(await h.page.evaluate(()=>clicked),[]);assert.equal(h.requests.filter(r=>r.method==='POST').length,0);
});

test('review: a large real-page transcript returns partial at its total held-text cap',{skip,timeout:20000},async t=>{
 const h=await harness(t,shell('<article>one</article>','','rows.innerHTML=Array.from({length:130},(_,i)=>`<article data-key="${i}">${"界".repeat(22000)}</article>`).join("");for(const row of rows.children)row.style.cssText="height:1px;min-height:0;overflow:hidden;white-space:nowrap";'));
 const result=await readWhole(h.entry,{max_seconds:10,max_items:5000});assert.match(result.text,/held text cap \(8 MB\)/,result.text.slice(0,1000));assert.match(result.text,/Complete: NO\./);assert.ok(result.text.length<=8000);
});

test('review: delayed network events keep the initiation window of an earlier expander',{skip,timeout:12000},async t=>{
 const h=await harness(t,shell('<article>first message</article><article>last message</article>'));
 const original=h.context.newCDPSession.bind(h.context),listeners=new Map();
 h.context.newCDPSession=async target=>{const session=await original(target),on=session.on.bind(session),off=session.off.bind(session);
  session.on=(name,listener)=>{if(name!=='Fetch.requestPaused')return on(name,listener);const delayed=event=>setTimeout(()=>listener(event),2500);listeners.set(listener,delayed);return on(name,delayed);};
  session.off=(name,listener)=>off(name,listeners.get(listener)??listener);return session;};
 const bank={blocked:[]},guard=await guardWholeRead(h.entry,Date.now()+8000,bank);h.cleanup(()=>guard.close());guard.expanderClick();
 const posted=h.page.evaluate(()=>fetch('/earlier-click',{method:'POST'}).then(()=> 'sent').catch(()=> 'blocked'));
 await new Promise(r=>setTimeout(r,2150));guard.expanderClick();
 assert.equal(await posted,'blocked');assert.equal(h.requests.filter(r=>r.method==='POST').length,0);assert.match(bank.blocked.join(' '),/POST http:\/\/127\.0\.0\.1:/);
});

test('review: a time cap keeps the two-second expander request guard until it expires',{skip,timeout:10000},async t=>{
 const h=await harness(t,shell('<article>first message</article><article>last message</article>','<button type="button" id="more">Load more</button>',"more.onclick=()=>{clicked.push('more');more.remove();setTimeout(()=>fetch('/late-post',{method:'POST'}).catch(()=>{}),1200)}"));
 const result=await readWhole(h.entry,{max_seconds:0.9});assert.match(result.text,/Clicks: 1\./,result.text);assert.match(result.text,/time cap/);
 await new Promise(r=>setTimeout(r,1500));assert.equal(h.requests.filter(r=>r.method==='POST').length,0,result.text);assert.match(result.text,/POST http:\/\/127\.0\.0\.1:/);
});
