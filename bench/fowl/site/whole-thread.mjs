// Clean-room local list fixtures, derived only from ledger/p142/lanes/lr1-spec.md.
export const wholeKinds=['a','b','c','d','e','f','g','dm-first-message','mail-first-invoice','finite-feed','endless-feed'];
export function createWholeFixture(kind,{seed=1,nonce='lr1'}={}){
  if(!wholeKinds.includes(kind)||!Number.isSafeInteger(seed)||!/^[-\w]{1,80}$/.test(nonce))throw Error('invalid whole fixture');
  const count=kind==='dm-first-message'?150:kind==='mail-first-invoice'?14:kind==='finite-feed'?60:120;
  const expected=Array.from({length:count},(_,i)=>kind==='d'&&i>=50&&i<56?'ok':`m-${String(i+1).padStart(3,'0')}`);
  const words=`Please bring the amber folder ${seed}.`,date='2026-01-03',invoice=`LR-${String(seed).padStart(4,'0')}-803`;
  if(kind==='dm-first-message')expected[0]=`m-001 Dana ${date}: ${words}`;
  if(kind==='mail-first-invoice')expected[2]=`m-003 2026-02-03 Invoice ${invoice}`;
  return {kind,seed,nonce,count,expected,words,date,invoice,events:[],views:0,posts:0,dangers:[]};
}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function wholePage(f){
 const {kind,count,seed,nonce}=f,base='/whole/'+nonce+'/';
 const virtual=kind==='d'||kind==='dm-first-message',endless=['e','endless-feed'].includes(kind),chat=['a','dm-first-message'].includes(kind),buttons=['c','mail-first-invoice'].includes(kind);
 return `<!doctype html><html><meta charset="utf-8"><title>Whole thread ${esc(nonce)}</title>
 <style>body{font:16px system-ui;margin:12px}#box{width:calc(100vw - 24px);height:520px;overflow:auto;position:relative;border:1px solid #888;overflow-anchor:none}#rows{position:relative}article{height:36px;box-sizing:border-box;padding:5px 8px;white-space:pre-line}button,a,[role=button]{padding:6px;margin:4px}#top,#bottom{height:24px}#loading:empty{display:none}</style>
 <h1>Thread</h1><div id="box" role="log" aria-label="${endless?'Unbounded feed':count+' messages'}"><p id="top"></p><button id="older" type="button" hidden>Show 20 older messages</button><div id="rows" role="list"></div><button id="newer" type="button" hidden>Load more</button><p id="loading" role="status"></p><p id="bottom"></p><div id="sentinel" style="height:4px"></div>
 ${kind==='f'?`<a href="${base}danger">Load more</a><form action="${base}danger" method="POST"><button>Load more</button></form><button type="button" aria-haspopup="menu">Show more</button><div role="button" tabindex="0" id="fake">Load more</div>`:''}
 ${buttons?'<button type="button" class="danger">Reply</button><button type="button" class="danger">Like</button><button type="button" class="danger">Delete</button><button type="button" class="danger">Archive</button>':''}
 ${kind==='mail-first-invoice'?`<button type="button" class="danger">Mark as unread</button><button type="button" class="danger">Reply all</button><a href="${base}danger">Show more</a>`:''}
 </div><script>
 const kind=${JSON.stringify(kind)},total=${count},seed=${seed},base=${JSON.stringify(base)},texts=${JSON.stringify(f.expected)},virtual=${virtual},endless=${endless},chat=${chat},buttons=${buttons};
 const $=id=>document.getElementById(id),box=$('box'),rows=$('rows');window.danger=[];let lo=kind==='dm-first-message'?total-24:chat?total-19:kind==='c'?41:1,hi=chat?total:kind==='c'?60:kind==='mail-first-invoice'?14:virtual?total:15,busy=false;
 if(kind==='mail-first-invoice')lo=12;
 const event=(type,name='')=>fetch(base+'event?type='+type+'&name='+encodeURIComponent(name));
 if(kind==='dm-first-message')document.addEventListener('click',e=>event('click',e.target.textContent.slice(0,60)),true);
 for(const b of document.querySelectorAll('.danger'))b.onclick=()=>{danger.push(b.textContent);event('danger',b.textContent);};
 if($('fake'))$('fake').onclick=()=>{danger.push('location');location.href=base+'danger';};
 function markers(){
  $('top').textContent=lo===1?'Beginning of chat':'';
  $('bottom').textContent=!endless&&hi>=total?"You're all caught up":'';
  if(buttons){$('older').hidden=lo===1;$('older').textContent=kind==='mail-first-invoice'?(lo-1)+' older messages':'Show 20 older messages';$('newer').hidden=hi>=total;}
 }
 const recycled=virtual?Array.from({length:12},()=>{const n=document.createElement('article');n.setAttribute('role','listitem');rows.append(n);return n;}):null;
 function render(){markers();
  if(virtual){rows.style.height=((total-lo+1)*36)+'px';const first=box.scrollTop+box.clientHeight>=box.scrollHeight-2?total-12:Math.min(total-12,Math.max(lo-1,lo-1+Math.floor(Math.max(0,box.scrollTop-$('top').offsetHeight)/36)-2));
   recycled.forEach((n,j)=>{const i=first+j;n.style.cssText='position:absolute;left:0;right:0;height:36px;top:'+((i-lo+1)*36)+'px';n.textContent=texts[i];});return;}
  rows.replaceChildren();for(let i=lo;i<=hi;i++){const n=document.createElement('article');n.setAttribute('role','listitem');n.setAttribute('data-message-id','m-'+i);
   n.textContent=texts[i-1]??(kind==='endless-feed'&&i===400?'m-400 mentions X':'m-'+String(i).padStart(3,'0'));
   if(kind==='mail-first-invoice'&&i===3){n.textContent='m-003 2026-02-03';const b=document.createElement('button');b.type='button';b.textContent='Show trimmed content';b.onclick=()=>{event('click',b.textContent);n.textContent=texts[2];};n.style.height='auto';n.append(b);}
   if(kind==='mail-first-invoice'&&i<=11){const content=document.createElement('div');while(n.firstChild)content.append(n.firstChild);content.hidden=true;
    const expand=document.createElement('button');expand.type='button';expand.textContent='Show more';expand.setAttribute('aria-expanded','false');
    expand.onclick=()=>{event('click','Message '+i);content.hidden=false;expand.hidden=true;expand.setAttribute('aria-expanded','true');};n.append(expand,content);n.style.height='auto';}
   rows.append(n);}
 }
 async function load(dir){if(busy)return;busy=true;$('loading').textContent='Loading';box.setAttribute('aria-busy','true');
  const old=box.scrollHeight,top=box.scrollTop;await (await fetch(base+(kind==='f'?'never':'load')+'?n='+hi+'&dir='+dir)).json();
  if(dir<0)lo=Math.max(1,lo-(kind==='dm-first-message'?25:20));else hi=endless?hi+15:Math.min(total,hi+15);
  render();if(dir<0)box.scrollTop=top+box.scrollHeight-old;
  $('loading').textContent='';box.setAttribute('aria-busy','false');busy=false;
 }
 $('older').onclick=()=>{event('click',$('older').textContent);load(-1);};$('newer').onclick=()=>{event('click','Load more');load(1);};
 let wheeling=false,virtualTimer,lastWheelTop=0;box.addEventListener('wheel',()=>{wheeling=true;setTimeout(()=>{wheeling=false},200)}, {passive:true});
 if(kind==='g'){const d=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop');Object.defineProperty(box,'scrollTop',{get(){return d.get.call(this)},set(value){d.set.call(this,value);if(!wheeling)requestAnimationFrame(()=>d.set.call(this,0));}});}
 box.addEventListener('scroll',()=>{
  if(kind==='g'){if(!wheeling){box.scrollTop=lastWheelTop;return;}lastWheelTop=box.scrollTop;}
  if(virtual){clearTimeout(virtualTimer);box.setAttribute('aria-busy','true');virtualTimer=setTimeout(()=>{render();if(!busy)box.setAttribute('aria-busy','false');},200+((seed*73+Math.floor(box.scrollTop)*19)%401));}
  if(chat&&box.scrollTop<2&&lo>1)load(-1);
 });
 if(virtual)box.addEventListener('wheel',e=>{if(kind==='dm-first-message'&&e.deltaY<0)event('wheel','older');},{passive:true});
 render();
 if(chat)box.scrollTop=box.scrollHeight;
 if(!chat&&!buttons&&!virtual){new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)&&(endless||hi<total))load(1);},{root:box}).observe($('sentinel'));}
 if(kind==='f')load(1);
 </script></html>`;
}
export async function wholeHandler(f,req,res){
 const url=new URL(req.url,'http://127.0.0.1'),base='/whole/'+f.nonce+'/',path=url.pathname.slice(base.length);
 const send=(status,type,body='')=>res.writeHead(status,{'content-type':type,'cache-control':'no-store'}).end(body);
 if(!url.pathname.startsWith(base))return send(404,'text/plain');
 if(req.method!=='GET'){f.posts++;f.dangers.push('non-GET');return send(405,'text/plain');}
 if(path==='never')return;
 if(path==='load'){await new Promise(r=>setTimeout(r,200+((f.seed*73+Number(url.searchParams.get('n'))*19)%401)));f.events.push({type:'load'});return send(200,'application/json','[]');}
 if(path==='event'){const type=url.searchParams.get('type'),name=url.searchParams.get('name');f.events.push({type,name});if(type==='danger')f.dangers.push(name);return send(204,'text/plain');}
 if(path==='api/log')return send(200,'application/json',JSON.stringify({events:f.events,views:f.views,posts:f.posts,dangers:f.dangers,lines:f.events.map(e=>e.type+' '+(e.name??''))}));
 if(path==='danger'){f.dangers.push('navigation');return send(200,'text/html','Danger page');}
 if(path==='front')return send(200,'text/html','<title>Foreground fixture</title><input autofocus value="front">');
 if(path===''){f.views++;return send(200,'text/html',wholePage(f));}
 return send(404,'text/plain');
}
