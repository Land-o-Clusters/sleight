import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {chromium} from '../plugins/sleight/vendor/playwright-core/index.mjs';
import {newHook,hookSource} from '../plugins/sleight/lib/direct-browser/page.mjs';
import {readWhole} from '../plugins/sleight/lib/direct-browser/whole.mjs';
const fixtures=await import('../bench/fowl/site/whole-thread.mjs').catch(()=>({}));
const live=process.env.SLEIGHT_LIVE_DOM_TEST==='1';
const pin=JSON.parse(readFileSync(new URL('../plugins/sleight/vendor/playwright-core/browsers.json',import.meta.url))).browsers.find(b=>b.name==='chromium-headless-shell');
const executablePath=join(homedir(),'Library/Caches/ms-playwright','chromium_headless_shell-'+pin.revision,'chrome-headless-shell-mac-'+process.arch,'chrome-headless-shell');
const skip=!live?'requires headless fixture opt-in':!existsSync(executablePath)?'pinned headless shell unavailable':false;
const seeds=Number(process.env.LR1_SEEDS??1);
async function harness(t){
  const bank=new Map(),requests=[];
  const server=createServer((req,res)=>{
    const u=new URL(req.url,'http://127.0.0.1');requests.push({method:req.method,path:u.pathname});
    const f=bank.get(u.pathname.split('/')[2]);
    if(f)return fixtures.wholeHandler(f,req,res);
    res.writeHead(404).end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  const browser=await chromium.launch({headless:true,executablePath});t.after(()=>browser.close());
  return {bank,requests,browser,base:'http://127.0.0.1:'+server.address().port};
}
function items(text){return [...text.matchAll(/^item \d+ of \d+: (.+)$/gm)].map(m=>JSON.parse(m[1]));}
for(const kind of ['a','b','c','d','e','f','g','h'])test('whole real fixture '+kind,{skip,timeout:seeds*(kind==='h'?240000:80000)+10000},async t=>{
  assert.equal(typeof fixtures.createWholeFixture,'function');
  const h=await harness(t);
  for(let seed=1;seed<=(kind==='g'?1:seeds);seed++){
    const variants=kind==='h'?['a','b','c','d']:[kind];
    for(const variant of variants){
      const nonce=kind+'-'+variant+'-'+seed,f=fixtures.createWholeFixture(variant,{seed,nonce});h.bank.set(nonce,f);
      const context=await h.browser.newContext({viewport:{width:900,height:700}}),hook=newHook();await context.addInitScript({content:hookSource(hook)});
      const page=await context.newPage();await page.goto(h.base+'/whole/'+nonce+'/');
      const foreground=kind==='h'?await context.newPage():null;
      if(foreground){await foreground.goto(h.base+'/whole/'+nonce+'/front');await foreground.waitForFunction(()=>document.activeElement?.localName==='input');}
      const before=foreground?await foreground.evaluate(()=>({focus:document.hasFocus(),active:document.activeElement.localName})):null;
      const entry={page,hook,state:{},cdp:await context.newCDPSession(page),popups:[]};
      const read=await readWhole(entry,{max_seconds:variant==='e'?3:60,max_items:variant==='e'?55:1000,...(variant==='e'?{direction:'down'}:{})});
      const got=items(read.text),label=`${kind}/${variant} seed ${seed}: ${read.text.slice(0,650)}`;
      if(process.env.LR1_DEBUG)console.log({fixture:variant,requests:h.requests,events:f.events,dom:await page.evaluate(()=>({busy:document.getElementById('box').getAttribute('aria-busy'),text:document.getElementById('loading').textContent,top:document.getElementById('box').scrollTop})),text:read.text});
      if(['a','b','c','d','g'].includes(variant)){
        assert.match(read.text,/Complete: yes\./,label);assert.deepEqual(got,f.expected,label);
        if(variant==='a'){assert.match(read.text,/Clicks: 0\./);assert.ok(Number(/Seconds: (\d+\.\d{2})/.exec(read.text)[1])<25,label);}
      }else{
        assert.match(read.text,/Complete: NO\./,label);
        if(variant==='e'){assert.ok(f.events.some(e=>e.type==='load'));assert.ok(Number(/Items read: (\d+)/.exec(read.text)[1])>15);assert.match(read.text,/cap/);assert.ok(got.length<=55);assert.ok(Number(/Seconds: (\d+\.\d{2})/.exec(read.text)[1])<=8);}
        if(variant==='f'){for(const name of ['link','form or submit','popup or menu','non-button role'])assert.ok(read.text.includes(name),label);assert.match(read.text,/stalled at 15 s/);}
      }
      assert.equal(page.url(),h.base+'/whole/'+nonce+'/',label);
      assert.deepEqual(await page.evaluate(()=>window.danger),[],label);
      assert.equal(context.pages().length,foreground?2:1,label);
      assert.equal(h.requests.filter(r=>r.method==='POST').length,0,label);
      if(foreground)assert.deepEqual(await foreground.evaluate(()=>({focus:document.hasFocus(),active:document.activeElement.localName})),before,label);
      console.log(JSON.stringify({fixture:kind,variant,seed,seconds:Number(/Seconds: (\d+\.\d{2})/.exec(read.text)[1]),count:Number(/Items read: (\d+)/.exec(read.text)[1]),complete:read.text.includes('Complete: yes.'),clicks:Number(/Clicks: (\d+)/.exec(read.text)[1])}));
      await context.close();
    }
  }
});

for(const effect of ['post','navigation','popup','dialog','submit','history','hash'])test('whole blocks native expander effect '+effect,{skip,timeout:15000},async t=>{
 const h=await harness(t),f=fixtures.createWholeFixture('c',{nonce:'effect-'+effect});h.bank.set(f.nonce,f);
 const context=await h.browser.newContext({viewport:{width:900,height:700}}),hook=newHook();await context.addInitScript({content:hookSource(hook)});
 t.after(()=>context.close());const page=await context.newPage(),url=h.base+'/whole/'+f.nonce+'/';await page.goto(url);
 await page.evaluate(({effect,url})=>{
  const box=document.getElementById('box');box.scrollTop=0;
  const b=document.getElementById('older');b.hidden=false;b.textContent='Load more';
  b.onclick=()=>{
   if(effect==='post')fetch(url+'danger',{method:'POST',body:'danger'});
   if(effect==='navigation')location.href=url+'danger';
   if(effect==='popup')window.open(url+'danger');
   if(effect==='dialog')alert('unsafe dialog');
   if(effect==='hash')location.hash='danger';
   if(effect==='history')history.pushState({},'',url+'danger');
   if(effect==='submit'){const form=document.createElement('form');form.method='POST';form.action=url+'danger';document.body.append(form);form.submit();}
  };
 },{effect,url});
 const result=await readWhole({page,hook,state:{},popups:[]},{max_seconds:5});
 assert.match(result.text,/Complete: NO\./);assert.match(result.text,effect==='post'?/held after expander click: POST /:/blocked:/);
 assert.equal(page.url(),url);assert.equal(context.pages().length,1);assert.deepEqual(await page.evaluate(()=>danger),[]);
 assert.equal(h.requests.filter(r=>r.method==='POST'||r.path.endsWith('/danger')).length,0);
});

test('whole cached find/from, closed-root password echoes, no marker and declared-total mismatch',{skip,timeout:30000},async t=>{
 const h=await harness(t),f=fixtures.createWholeFixture('a',{nonce:'protected'});h.bank.set(f.nonce,f);
 const context=await h.browser.newContext({viewport:{width:900,height:700}}),hook=newHook();await context.addInitScript({content:hookSource(hook)});t.after(()=>context.close());
 const page=await context.newPage();await page.goto(h.base+'/whole/'+f.nonce+'/');
 await page.evaluate(()=>{
  const box=document.getElementById('box');box.setAttribute('aria-label','4 messages');
  box.innerHTML='<div role="list"><article data-message-id="a">one fixture-private-password</article><article data-message-id="b">needle two</article><article data-message-id="c">three</article></div>';
  const host=document.createElement('div');const shadow=host.attachShadow({mode:'closed'});shadow.innerHTML='<input type="password" value="fixture-private-password">';document.body.append(host);
  Object.defineProperty(HTMLElement.prototype,'innerText',{get(){return 'forged text';}});
 });
 const entry={page,hook,state:{},popups:[]};const first=await readWhole(entry,{max_seconds:20});
 assert.match(first.text,/Complete: NO\./);assert.match(first.text,/unknown/);assert.match(first.text,/declared total 4 differs from 3/);
 assert.doesNotMatch(first.text,/fixture-private-password|forged text/);
 assert.match(first.text,/redacted/);
 const found=await readWhole(entry,{find:'needle'});assert.match(found.text,/item 2 of 3: "needle two"/);
 const from=await readWhole(entry,{from:2});assert.match(from.text,/item 2 of 3/);
 await page.goto(h.base+'/whole/'+f.nonce+'/front');await assert.rejects(readWhole(entry,{from:2}),/expired/);
});

for(const kind of ['dm-first-message','mail-first-invoice','finite-feed','endless-feed'])test('whole race page '+kind,{skip,timeout:125000},async t=>{
 const h=await harness(t),f=fixtures.createWholeFixture(kind,{seed:7,nonce:'race-proof-'+kind});h.bank.set(f.nonce,f);
 const context=await h.browser.newContext({viewport:{width:900,height:700}}),hook=newHook();await context.addInitScript({content:hookSource(hook)});t.after(()=>context.close());
 const page=await context.newPage();await page.goto(h.base+'/whole/'+f.nonce+'/');
 const result=await readWhole({page,hook,state:{},popups:[]},{max_seconds:110,max_items:kind==='endless-feed'?180:1000});
 if(kind==='endless-feed'){assert.match(result.text,/Complete: NO\./);assert.match(result.text,/item cap/);assert.doesNotMatch(result.text,/mentions X/);}
 else{assert.deepEqual(items(result.text),f.expected,result.text.slice(0,700));
  if(kind!=='mail-first-invoice')assert.match(result.text,/Complete: yes\./);
  else assert.match(result.text,/Show more \(link\)/);
 }
 assert.equal(f.posts,0);assert.deepEqual(f.dangers,[]);assert.equal(context.pages().length,1);
 if(kind==='dm-first-message')assert.equal(f.events.filter(e=>e.type==='click').length,0);
});
test('whole propagates a site denial during acquisition and releases its guards',{skip,timeout:10000},async t=>{
 const h=await harness(t),f=fixtures.createWholeFixture('c',{nonce:'site-denial'});h.bank.set(f.nonce,f);
 const context=await h.browser.newContext({viewport:{width:900,height:700}}),hook=newHook();await context.addInitScript({content:hookSource(hook)});t.after(()=>context.close());
 const page=await context.newPage();await page.goto(h.base+'/whole/'+f.nonce+'/');let checks=0;
 const denied=Object.assign(Error('fixture site is blocked'),{siteBlocked:true});
 await assert.rejects(readWhole({page,hook,state:{},popups:[]},{max_seconds:1},{siteCheck(){if(++checks>1)throw denied;}}),error=>error===denied);
 const {guardWholeRead}=await import('../plugins/sleight/lib/direct-browser/whole-guard.mjs');
 const guard=await guardWholeRead({page,hook,state:{}},Date.now()+1000,{blocked:[]});await guard.close();
});

test('whole tool dispatch binds a delivered subtree, invalidates old refs and caps clicks/items',{skip,timeout:15000},async t=>{
 const h=await harness(t),f=fixtures.createWholeFixture('c',{nonce:'dispatch'});h.bank.set(f.nonce,f);
 const context=await h.browser.newContext({viewport:{width:900,height:700}}),hook=newHook();await context.addInitScript({content:hookSource(hook)});t.after(()=>context.close());
 const page=await context.newPage();await page.goto(h.base+'/whole/'+f.nonce+'/');
 const {snapshot,acknowledgeSnapshot}=await import('../plugins/sleight/lib/direct-browser/snapshot.mjs');
 const {createToolDispatcher}=await import('../plugins/sleight/lib/direct-browser/tools.mjs');
 const entry={page,hook,state:{snapshotNo:0},popups:[]},pages={enqueue:async(id,run)=>{assert.equal(id,'t1');return run(entry);},closedOpener:()=>undefined};
 const d=createToolDispatcher({pages,snapshot,runSteps:()=>assert.fail('no actions'),fillFields:()=>assert.fail('no fill'),deliverSnapshot(state,capture){state.snapshotNo=capture.number;return acknowledgeSnapshot(page,capture.number);}});
 const plain=await d.call({name:'browser_read',arguments:{tab:'t1'}});assert.equal(plain.isError,false);assert.match(plain.text,/whole:\{\}/);assert.equal(d.delivered(plain),true);
 const ref=/button "Show 20 older messages" \[ref=(e\d+)\]/.exec(plain.text)?.[1];assert.ok(ref,plain.text);
 const first=await d.call({name:'browser_read',arguments:{tab:'t1',ref,whole:{max_clicks:0}}});
 assert.equal(first.isError,false);assert.match(first.text,/click cap/);assert.match(first.text,/Clicks: 0\./);assert.throws(()=>page.getByRef(ref),/stale/);
 const held=await d.call({name:'browser_read',arguments:{tab:'t1',whole:{find:'m-041'}}});assert.match(held.text,/m-041/);
 const capped=await d.call({name:'browser_read',arguments:{tab:'t1',whole:{max_items:1}}});assert.match(capped.text,/Items read: 1 /);assert.match(capped.text,/item cap/);
 const timed=await d.call({name:'browser_read',arguments:{tab:'t1',whole:{max_seconds:.1}}});assert.match(timed.text,/time cap/);
 assert.deepEqual(await page.evaluate(()=>danger),[]);assert.equal(f.events.filter(e=>e.type==='click').length,0);
});
test('whole proves an end with a second stationary wheel after the away/back nudge',{skip,timeout:15000},async t=>{
 const h=await harness(t),f=fixtures.createWholeFixture('a',{nonce:'stationary-proof'});h.bank.set(f.nonce,f);
 const context=await h.browser.newContext({viewport:{width:900,height:700}}),hook=newHook();await context.addInitScript({content:hookSource(hook)});t.after(()=>context.close());
 const page=await context.newPage();await page.goto(h.base+'/whole/'+f.nonce+'/');
 await page.evaluate(()=>{window.stationary=[];const box=document.getElementById('box');box.addEventListener('wheel',e=>{stationary.push({direction:Math.sign(e.deltaY),atEnd:box.scrollTop+box.clientHeight>=box.scrollHeight-1});},{passive:true});});
 const result=await readWhole({page,hook,state:{},popups:[]},{direction:'down',max_seconds:12});
 assert.match(result.text,/End: reached\./);assert.deepEqual((await page.evaluate(()=>stationary)).slice(-3),[{direction:-1,atEnd:false},{direction:1,atEnd:true},{direction:1,atEnd:true}]);
});
test('whole ignores hidden list decoys and checks a plain visible message count',{skip,timeout:25000},async t=>{
 const h=await harness(t),f=fixtures.createWholeFixture('c',{nonce:'plain-count'});h.bank.set(f.nonce,f);
 const context=await h.browser.newContext({viewport:{width:900,height:700}}),hook=newHook();await context.addInitScript({content:hookSource(hook)});t.after(()=>context.close());
 const page=await context.newPage();await page.goto(h.base+'/whole/'+f.nonce+'/');
 await page.evaluate(()=>{document.body.innerHTML='<p>4 messages</p><div hidden><div role="list"><article>hidden-one</article><article>hidden-two</article><article>hidden-three</article></div></div><p>Beginning of chat</p><div role="list"><article>Show more photos tomorrow</article><article>visible-two</article></div><p>You\'re all caught up</p>';});
 const result=await readWhole({page,hook,state:{},popups:[]},{max_seconds:20});
 assert.deepEqual(items(result.text),['Show more photos tomorrow','visible-two']);assert.doesNotMatch(result.text,/hidden-one|hidden-two|hidden-three/);
 assert.match(result.text,/declared total 4 differs from 2/);assert.match(result.text,/Complete: NO\./);
});
test('whole leaves a persistent expander unopened after a click adds no items',{skip,timeout:25000},async t=>{
 const h=await harness(t),f=fixtures.createWholeFixture('c',{nonce:'no-progress'});h.bank.set(f.nonce,f);
 const context=await h.browser.newContext({viewport:{width:900,height:700}}),hook=newHook();await context.addInitScript({content:hookSource(hook)});t.after(()=>context.close());
 const page=await context.newPage();await page.goto(h.base+'/whole/'+f.nonce+'/');
 await page.evaluate(()=>{document.body.innerHTML='<p>2 messages</p><p>Beginning of chat</p><div role="list"><article>one</article><article>two</article></div><button type="button">Load more</button><p>You\'re all caught up</p>';});
 const result=await readWhole({page,hook,state:{},popups:[]},{max_seconds:20});
 assert.match(result.text,/Complete: NO\./);assert.deepEqual(items(result.text),['one','two']);assert.match(result.text,/Load more.*last click added no items/);assert.match(result.text,/Clicks: 1\./);assert.match(result.text,/End: not reached\./);
});
