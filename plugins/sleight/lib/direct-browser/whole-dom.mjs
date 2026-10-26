import { snapshotRefBinding } from './snapshot.mjs';
import { resolveClosedHandle } from './closed-handle.mjs';
import { backgroundClick } from './page.mjs';

// This closure lives only in the pristine utility world, with held DOM identities.
function wholeDOM(ref) {
  const ids=new WeakMap();let serial=0,box,root,region,lastChange=performance.now();
  const id=node=>{if(!ids.has(node))ids.set(node,++serial);return ids.get(node);};
  const attr=(node,key)=>node?.getAttribute?.(key);
  const role=node=>attr(node,'role')??'';
  const parent=node=>node?.parentElement??node?.getRootNode?.().host;
  const text=node=>String(node?.innerText??node?.textContent??'').trim().slice(0,65536);
  const all=from=>{const out=[];const walk=(n,depth)=>{if(depth>128||out.length>50000)throw Error(out.length>50000?'whole DOM exceeds 50,000 elements':'whole DOM nesting exceeds 128 levels');
    for(const el of n.children??[]){out.push(el);walk(el,depth+1);if(el.shadowRoot)walk(el.shadowRoot,depth+1);}};walk(from,0);return out;};
  const visible=node=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;};
  const scrollable=node=>node===document.scrollingElement||/(auto|scroll)/.test(getComputedStyle(node).overflowY)&&node.scrollHeight>node.clientHeight;
  const nodes=all(document);
  if(ref){for(let n=ref;n;n=parent(n))if(scrollable(n)){box=n;break;}}
  if(!box){const candidates=nodes.filter(n=>{const r=n.getBoundingClientRect();return n!==document.scrollingElement&&visible(n)&&r.width>=200&&r.height>=150&&scrollable(n);});
    candidates.sort((a,b)=>(/^(log|feed|list|grid|main)$/.test(role(b))-/^(log|feed|list|grid|main)$/.test(role(a)))||text(b).length-text(a).length);
    box=candidates[0];
    if(box){const r=box.getBoundingClientRect();if(r.width*r.height<innerWidth*innerHeight/2)box=null;}}
  box??=document.scrollingElement;
  if(!box)throw Error('whole DOM no scroller');
  const observer=new MutationObserver(()=>{lastChange=performance.now();});
  let observedRoot;let observedShadows=new WeakSet();
  const observeItems=()=>{
    if(root!==observedRoot){observer.disconnect();observedRoot=root;observedShadows=new WeakSet();lastChange=performance.now();observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true});}
    for(const n of all(root))if(n.shadowRoot&&!observedShadows.has(n.shadowRoot)){observer.observe(n.shadowRoot,{subtree:true,childList:true,characterData:true,attributes:true});observedShadows.add(n.shadowRoot);}
  };
  const allow=/^(?:(?:load|show|view|see|read)\s+(?:\d+\s+)?(?:more|older|earlier|previous|newer|hidden|remaining|all)(?:\s+(?:messages?|items?|posts?|replies|comments?|content|rows?|thread))?|(?:show|view)\s+(?:\d+\s+)?(?:repl(?:y|ies)|comments?|thread)|\d+\s+(?:older|earlier|previous|newer)\s+messages?|show\s+(?:trimmed|quoted)\s+content|(?:expand (?:all|thread)|older|earlier|previous messages|see replies)|more)$/i;
  // Exact localized loader names, never arbitrary collapsed controls.
  const localized=/^(?:mostrar (?:m[aá]s|mensajes anteriores|respuestas)|cargar m[aá]s|ver (?:m[aá]s|respuestas)|afficher (?:plus|les messages pr[eé]c[eé]dents|les r[eé]ponses)|voir les r[eé]ponses|charger plus|mehr (?:anzeigen|laden)|[aä]ltere nachrichten|vorherige nachrichten|antworten anzeigen|mostrar mais|carregar mais|ver respostas|mostra (?:altro|di pi[uù]|risposte)|carica altri|messaggi precedenti|もっと見る|以前のメッセージ|返信を表示|显示更多|顯示更多|加载更多|載入更多|较早的消息|較早的訊息|查看回复|查看回覆|더 보기|이전 메시지|답글 보기)$/iu;
  const deny=/\b(send|like|delete|archive|report|block|follow|buy|pay|mark|share|vote|accept|edit|save|sign in|settings)\b/i;
  const keyOf=node=>{for(const {name,value}of node.attributes??[])if(/^(?:data-key|data-(?:message|row|post|comment)-?id)$/.test(name)&&value)return name+':'+value;return undefined;};
  const controls=()=>all(region).filter(n=>n.matches('button,a,[role],[aria-expanded]')).flatMap(n=>{
    const name=(attr(n,'aria-label')??text(n)).normalize('NFKC').replace(/\s+/g,' ').trim().slice(0,60);
    let item=n,depth=0;while(item&&depth++<4&&!item.matches('li,[role=listitem],[role=row],[role=article]'))item=parent(item);
    const collapsed=attr(n,'aria-expanded')==='false'&&item&&depth<=4;
    const named=allow.test(name)||localized.test(name);
    if(!named&&!collapsed)return [];
    let reason;
    if(!named)reason='name not allowlisted';
    else if(deny.test(name)||/^(reply|post)$/i.test(name))reason='action name';
    else if(n.localName!=='button'||role(n)&&role(n)!=='button')reason=n.matches('a,[href]')?'link':'non-button role';
    else if(n.type==='submit'||n.form||n.closest('form'))reason='form or submit';
    else if(n.hasAttribute('aria-haspopup')||n.hasAttribute('popovertarget'))reason='popup or menu';
    else if(n.disabled||attr(n,'aria-disabled')==='true')reason='disabled';
    return [{id:id(n),name,allowed:!reason,reason,node:n,visible:visible(n)}];
  });
  const repick=()=>{
    if(box===document.scrollingElement&&root)for(let n=parent(root);n&&n!==document.scrollingElement;n=parent(n))if(scrollable(n)){box=n;break;}
    if(!box.isConnected)throw Error('whole DOM scroller removed');
    const descendants=all(box);
    const lists=descendants.filter(n=>{
      if(!(/^(feed|list|grid)$/.test(role(n))||n.matches('ul,ol,tbody')))return false;
      const r=n.getBoundingClientRect();if(r.width<=0||r.height<=0||getComputedStyle(n).visibility==='hidden')return false;
      const outsideControls=descendants.filter(c=>!n.contains(c)&&(c.matches('button,a,[role=button],[role=status],[role=progressbar]')||c.children.length===0&&/^(beginning of (?:chat|thread)|start of (?:feed|thread|chat)|you['’]re all caught up|end of (?:chat|thread|feed)|\d+\s+(?:messages|posts|items))$/i.test(text(c)))).reduce((sum,c)=>sum+text(c).length,0);
      return text(n).replace(/\s+/g,' ').length>=Math.max(0,text(box).replace(/\s+/g,' ').length-outsideControls)*.5;
    });
    // A feed can wrap a separate list plus markers and loaders. Prefer the
    // container with actual row children over treating its list as one item.
    const rowSelector='li,article,tr,[role=listitem],[role=row],[role=article]';
    root=lists.find(n=>[...n.children].some(c=>c.matches(rowSelector)))??lists[0]??box;
    // A layout wrapper around the row children is not itself one transcript item.
    for(let depth=0;depth<4&&root.children.length===1&&!root.firstElementChild.matches('li,article,tr,[role=listitem],[role=row],[role=article],button');depth++)root=root.firstElementChild;
    // Sibling loaders belong to the closest semantic thread or its scroller.
    // Document-wide scrolling must not activate another feed's buttons.
    region=root;
    if(root!==box)for(let n=parent(root);n&&n!==document.scrollingElement;n=parent(n)){
      if(n===box){region=box;break;}
      if(/^(log|feed|list|grid|main)$/.test(role(n))||n.localName==='main'){region=n;break;}
    }
    observeItems();
  };
  const view=()=>{
    repick();const rect=box===document.scrollingElement?{top:0,bottom:innerHeight,left:0,right:innerWidth}:box.getBoundingClientRect();
    const client=box.clientHeight,height=box.scrollHeight;
    const reverse=getComputedStyle(box).flexDirection==='column-reverse'||box.scrollTop<0;
    const top=box.scrollTop+(reverse?Math.max(0,height-client):0);
    const cs=controls();
    const children=[...root.children].filter(n=>!n.matches('button,[role=progressbar],[role=status]')&&
      (!/^(?:loading(?:\.{3}|…)?|load more|show more)$/i.test(text(n))||n.matches('li,tr,article,[role=listitem],[role=row],[role=article]')));
    const rowNodes=children.filter(n=>{const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&r.bottom>=rect.top-2*client&&r.top<=rect.bottom+2*client&&text(n)&&getComputedStyle(n).display!=='none'&&getComputedStyle(n).visibility!=='hidden'&&!n.matches('[aria-hidden=true]');}).sort((a,b)=>{const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return x.top-y.top||x.left-y.left;});
    let bytes=0,textCapped=false;const encoder=new TextEncoder();
    const rows=rowNodes.flatMap(n=>{const value=text(n),size=encoder.encode(value).length;if(bytes+size>8000000){textCapped=true;return [];}bytes+=size;return [({node:id(n),key:keyOf(n),text:text(n),truncated:String(n.innerText??n.textContent??'').trim().length>65536,pos:Number(attr(n,'aria-posinset')??attr(n,'aria-rowindex'))||undefined})];});
    const itemNodes=new Set(children);
    const itemContains=n=>{for(let p=n;p;p=parent(p))if(itemNodes.has(p))return true;return false;};
    const markerNodes=all(box).filter(n=>n.children.length===0&&!n.matches('button,a,input,textarea')&&!itemContains(n)&&visible(n));
    const markers={};
    for(const n of markerNodes){const t=text(n),r=n.getBoundingClientRect();
      const nearStart=Math.abs((r.top+r.bottom)/2-(rect.top-top))<=client;
      const nearEnd=Math.abs((r.top+r.bottom)/2-(rect.top-top+height))<=client;
      if(nearStart&&/^(beginning of (?:chat|thread)|start of (?:feed|thread|chat)|no (?:more )?(?:older|earlier) messages|first message)$/i.test(t))markers.start=t;
      if(nearEnd&&/^(you['’]re all caught up|end of (?:chat|thread|feed)|no (?:more )?(?:newer )?(?:messages|posts|items))$/i.test(t))markers.end=t;}
    const counts=[box,root,...children].map(n=>Number(attr(n,'aria-setsize')??attr(n,'aria-rowcount'))).filter(n=>Number.isInteger(n)&&n>0);
    const declared=/(?:^|\s)(\d+)\s+(?:messages|posts|items)\b/i.exec(attr(box,'aria-label')??attr(root,'aria-label')??'');
    // A non-overflowing semantic container can still declare the whole thread's total.
    const surrounding=nodes.filter(n=>n.contains(root)&&/^(log|feed|list|grid)$/.test(role(n))).map(n=>/(?:^|\s)(\d+)\s+(?:messages|posts|items)\b/i.exec(attr(n,'aria-label')??'')).find(Boolean);
    if(declared)counts.push(Number(declared[1]));
    else if(surrounding)counts.push(Number(surrounding[1]));
    const summaryScope=box===document.scrollingElement?document:parent(box)??box;
    for(const n of all(summaryScope))if(!n.children.length&&visible(n)){
      const count=/^(\d+)\s+(?:messages|posts|items)$/i.exec(text(n));
      if(count&&Number.isSafeInteger(Number(count[1])))counts.push(Number(count[1]));
    }
    const total=counts.length?Math.max(...counts):undefined;
    const animated=document.getAnimations().some(a=>a.playState==='running'&&a.effect?.getTiming().iterations===Infinity&&box.contains(a.effect.target)&&visible(a.effect.target));
    const busy=animated||all(box).some(n=>visible(n)&&(attr(n,'aria-busy')==='true'||role(n)==='progressbar'||role(n)==='status'&&/loading|please wait/i.test(text(n))))||attr(box,'aria-busy')==='true';
    const itemText=children.map(text).join(' ').replace(/\s+/g,' ').length;
    const markerChars=all(box).filter(n=>n.children.length===0&&/^(beginning of (?:chat|thread)|start of (?:feed|thread|chat)|you['’]re all caught up|end of (?:chat|thread|feed)|\d+\s+(?:messages|posts|items))$/i.test(text(n))).reduce((sum,n)=>sum+text(n).length,0);
    const contentChars=Math.max(0,text(box).replace(/\s+/g,' ').length-markerChars-cs.reduce((sum,c)=>sum+c.name.length,0));
    return {rows,textCapped,top,height,client,markers,total,totalConflict:new Set(counts).size>1,busy,quiet:performance.now()-lastChange,
      fragments:!!rows.length&&itemText<contentChars*.5,
      controls:cs.filter(c=>c.visible).map(({node,...c})=>c),refused:cs.filter(c=>!c.allowed).map(c=>c.name+' ('+c.reason+')'),
      point:{x:Math.max(1,Math.min(innerWidth-1,(rect.left+rect.right)/2)),y:Math.max(1,Math.min(innerHeight-1,(rect.top+rect.bottom)/2))}};
  };
  return {view,control:wanted=>controls().find(c=>c.id===wanted&&c.allowed&&c.visible)?.node??null,
    script:dy=>{box.scrollTop+=dy;},dispose:()=>observer.disconnect()};
}

export async function createWholeDOM(page, ref) {
  const frame=page.mainFrame(),impl=frame?._connection?.toImpl?.(frame),utility=await impl?.utilityContext?.();
  if(utility?.world!=='utility')throw Error('whole DOM requires isolated world');
  let node;
  if(ref){if(!/^e\d+$/.test(ref))throw Error('whole DOM needs a main-frame ref');const handle=await snapshotRefBinding(page,ref).elementHandle({timeout:1000});
    node=handle?._connection?.toImpl?.(handle);if(!node)throw Error('whole DOM ref unavailable');}
  const state=await utility.evaluateExpressionHandle(wholeDOM.toString(),{isFunction:true},node);
  const run=(method,arg)=>utility.evaluateExpression('([s,m,a])=>s[m](a)',{isFunction:true},[state,method,arg]);
  return {
    view:()=>run('view'),script:dy=>run('script',dy),
    async wheel(dy){const v=await run('view');await page.mouse.move(v.point.x,v.point.y);await page.mouse.wheel(0,dy);},
    async click(id,entry,beforeClick){
      const held=await utility.evaluateExpressionHandle('([s,id])=>s.control(id)',{isFunction:true},[state,id]);
      try {
        const el=held.asElement();if(!el)return false;
        const session=impl._page.delegate._sessionForFrame(impl);
        const {node}=await session._client._sendMayFail('DOM.describeNode',{objectId:el._objectId});
        if(!node?.backendNodeId)return false;
        const handle=await resolveClosedHandle({frame,backendNodeId:node.backendNodeId});
        try { await backgroundClick(entry,handle,async()=>{
          const current=await run('view');if(!current.controls.some(c=>c.id===id&&c.allowed&&c.visible))throw Error('whole DOM expander changed');
          const finished=beforeClick?.();
          try{await handle.click({timeout:1000,noWaitAfter:true});}finally{finished?.();}
        },{recover:false});return true;}
        finally {await handle.dispose();}
      } finally {await held.dispose();}
    },
    async dispose(){try{await run('dispose');}finally{await state.dispose();}},
  };
}
