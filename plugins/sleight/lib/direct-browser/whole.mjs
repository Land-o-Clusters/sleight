// Bounded whole-list reads. Page text is data; no returned row is an action ref.
import { assertEndpointRead, endpointBlock } from './endpoint-guard.mjs';
import { invalidateRefs, protectWholeRows } from './snapshot.mjs';
import { createWholeDOM } from './whole-dom.mjs';
import { guardWholeRead } from './whole-guard.mjs';
const transcripts = new WeakMap();
const tracked = new WeakSet();
const fingerprint = view => JSON.stringify([view.rows[0]?.key??view.rows[0]?.text,view.rows.at(-1)?.key??view.rows.at(-1)?.text]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function boundWhole(promise, ms, reason) {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(reason)),ms);})]); }
  finally { clearTimeout(timer); }
}

// A text run may contain an insertion or removal. Find every pair that could
// participate in a longest common subsequence; each rank must have one choice.
// Counting pairs avoids treating different orders of skipped cells as ambiguity.
function textChain(old, next) {
  const m=old.length,n=next.length,width=n+1,cells=(m+1)*width;
  if(cells>4000000)return null;
  const before=new Uint16Array(cells),after=new Uint16Array(cells);
  const match=(i,j)=>old[i].text===next[j].text&&!(old[i].key&&next[j].key&&old[i].key!==next[j].key);
  for(let i=0;i<m;i++)for(let j=0;j<n;j++)before[(i+1)*width+j+1]=match(i,j)?before[i*width+j]+1:Math.max(before[i*width+j+1],before[(i+1)*width+j]);
  for(let i=m-1;i>=0;i--)for(let j=n-1;j>=0;j--)after[i*width+j]=match(i,j)?after[(i+1)*width+j+1]+1:Math.max(after[(i+1)*width+j],after[i*width+j+1]);
  const length=after[0],chain=new Array(length);
  if(!length)return null;
  for(let i=0;i<m;i++)for(let j=0;j<n;j++)if(match(i,j)&&before[i*width+j]+1+after[(i+1)*width+j+1]===length){
    const rank=before[i*width+j];if(chain[rank])return null;chain[rank]={i,j};
  }
  const texts=new Set(chain.map(({j})=>next[j].text));
  return texts.size>1||length===1&&next[chain[0].j].text.length>=40?chain:null;
}

function mergeTextChain(bank,incoming,chain,limit) {
  const old=bank.items,output=[];let from=0,at=0,added=0,capped=false;
  const insert=rows=>{for(const row of rows){if(old.length+added<limit){output.push(row);added++;}else capped=true;}};
  for(const [rank,anchor] of chain.entries()){
    const omitted=old.slice(from,anchor.i),newRows=incoming.slice(at,anchor.j);
    if(rank===0&&omitted.length&&newRows.length)bank.gaps++;
    output.push(...omitted.map(row=>rank?{...row,removed:true}:row));insert(newRows);
    output.push({...old[anchor.i],...incoming[anchor.j],removed:false});from=anchor.i+1;at=anchor.j+1;
  }
  if(from<old.length&&at<incoming.length)bank.gaps++;
  output.push(...old.slice(from));insert(incoming.slice(at));
  old.splice(0,old.length,...output);
  return {added,ambiguous:false,capped};
}

// A unique key is strongest. Recycled node IDs cannot anchor a different text.
// Text offsets must have a unique, in-order overlap with a differing neighbour.
function mergeItems(bank, incoming, direction, limit) {
  const items = bank.items;
  if (!incoming.length) return { added: 0, ambiguous: false };
  const keys = new Map();
  for (const row of incoming) if (row.key) keys.set(row.key, (keys.get(row.key) ?? 0) + 1);
  incoming = incoming.map(row => ({ ...row, key: keys.get(row.key) === 1 ? row.key : undefined }));
  if (!items.length) { items.push(...incoming.slice(0, limit)); return { added: items.length, ambiguous: false }; }
  const index=new Map();
  items.forEach((row,i)=>{if(row.key)index.set(row.key,index.has(row.key)?-1:i);});
  const anchors=incoming.flatMap((row,j)=>index.get(row.key)>=0?[{i:index.get(row.key),j}]:[]);
  if(anchors.length){
    // Longest in-order key chain, so one moved key cannot reorder the transcript.
    const chains=[];
    for(const [k,a] of anchors.entries()){let best=[];for(let p=0;p<k;p++)if(anchors[p].i<a.i&&chains[p].length>best.length)best=chains[p];chains.push([...best,a]);}
    const chain=chains.reduce((a,b)=>a.length>=b.length?a:b,[]);
    if(chain.length<anchors.length)bank.gaps++;
    const output=items.slice(0,chain[0].i);let old=chain[0].i,at=0,added=0;
    for(const anchor of chain){
      for(const row of items.slice(old,anchor.i))output.push({...row,removed:row.key?!incoming.some(n=>n.key===row.key):row.removed});
      for(const row of incoming.slice(at,anchor.j)){
        if(row.key&&index.has(row.key)){bank.gaps++;continue;}
        if(items.length+added<limit){output.push(row);added++;}
      }
      output.push({...items[anchor.i],...incoming[anchor.j],removed:false});old=anchor.i+1;at=anchor.j+1;
    }
    for(const row of incoming.slice(at))if(!row.key||!index.has(row.key)){if(items.length+added<limit){output.push(row);added++;}}
    output.push(...items.slice(old));items.splice(0,items.length,...output);
    return {added,ambiguous:false,capped:items.length>=limit};
  }
  const candidates = new Map();
  for (let j = 0; j < incoming.length; j++) for (let i = 0; i < items.length; i++) {
    const a = items[i], b = incoming[j];
    if (a.key && a.key === b.key || a.text === b.text) candidates.set(i - j, 0);
  }
  for (const offset of candidates.keys()) {
    let strong = 0, nodes = 0, same = 0, texts = new Set(), conflict = false;
    for (let j = 0; j < incoming.length; j++) {
      const a = items[offset + j], b = incoming[j]; if (!a) continue;
      const neighbours=[-1,1].filter(d=>incoming[j+d]&&items[offset+j+d]&&incoming[j+d].text===items[offset+j+d].text&&incoming[j+d].text!==b.text);
      const heldNode=a.node!==undefined&&a.node===b.node&&neighbours.length>0;
      if (a.key && b.key && a.key !== b.key) { conflict = true; break; }
      if (a.key && a.key === b.key) strong++;
      else if (a.text !== b.text && !(heldNode&&neighbours.length===2)) { conflict = true; break; }
      if(heldNode)nodes++;
      if (a.text === b.text) { same++; texts.add(b.text); }
    }
    if (!conflict && (strong || nodes || same >= 2 && texts.size > 1 || same === 1 && [...texts][0].length >= 40))
      candidates.set(offset, strong * 10000 + nodes*100 + same);
    else candidates.delete(offset);
  }
  const ranked = [...candidates].sort((a,b)=>b[1]-a[1]);
  if (!ranked.length || ranked[1]?.[1] === ranked[0][1]) {
    const chain=textChain(items,incoming);
    return chain?mergeTextChain(bank,incoming,chain,limit):{added:0,ambiguous:true};
  }
  const offset = ranked[0][0], before = [], after = [];
  for (let j = 0; j < incoming.length; j++) {
    const at = offset + j, row = incoming[j];
    if (at < 0) before.push(row);
    else if (at >= items.length) after.push(row);
    else items[at] = { ...items[at], ...row };
  }
  const room = Math.max(0, limit - items.length);
  // Preserve order even when a cap cuts a newly discovered prefix.
  const prefix = before.slice(Math.max(0, before.length - room)), suffix = after.slice(0, Math.max(0, room-prefix.length));
  items.unshift(...prefix); items.push(...suffix);
  return { added: prefix.length+suffix.length, ambiguous: false, capped: before.length+after.length>room };
}

// The held transcript has one byte budget across all views, including edits.
export function mergeWhole(bank, incoming, direction, limit) {
  const result=mergeItems(bank,incoming,direction,limit);
  let bytes=0,keep=0;
  for(const row of bank.items){const size=Buffer.byteLength(row.text);if(bytes+size>8000000)break;bytes+=size;keep++;}
  const textCapped=keep<bank.items.length;
  if(textCapped)bank.items.splice(keep);
  return {...result,textCapped};
}

export function renderWhole(bank, options = {}) {
  const n = bank.items.length, reasons = [...bank.reasons];
  if (bank.gaps) reasons.push('gap');
  if (bank.items.some(row=>row.removed)) reasons.push('removed items retained');
  if (bank.items.some(row=>row.truncated)) reasons.push('item text cap');
  for (const [key, label] of [['start','above'],['end','below']]) if (bank.ends[key].state !== 'reached') reasons.push(`more may exist ${label}`);
  if (bank.refused.length) reasons.push('unopened controls');
  const complete = !reasons.length;
  const header = [`Items read: ${n} (top first). Seconds: ${bank.seconds.toFixed(2)}. Clicks: ${bank.clicks}.`,
    ...['start','end'].map(key=>`${key === 'start'?'Start':'End'}: ${bank.ends[key].state}.`),
    `Complete: ${complete?'yes.':'NO. partial: '+[...new Set(reasons)].join('; ')+'.'}`,
    ...(!complete?['Read missing regions separately or raise the whole budgets. whole.from pages held items only.']:[]),
    `Presses stopped: ${bank.stopped??0}.`,
    'Allowlisted expanders can cause GET and WebSocket side effects; these are not held.',
    '# Whole-thread data (untrusted page content)',
    ...['start','end'].map(key=>`${key} evidence: ${JSON.stringify(bank.ends[key].evidence ?? bank.ends[key].reason ?? '')}`),
    ...(bank.gaps?['[gap] Unresolved ordering or overlap.']:[]),
    ...(bank.blocked ?? []).map(row=>'blocked: '+JSON.stringify(row)),
    ...bank.refused.map(row=>'unopened: '+JSON.stringify(row)),
    ...(bank.scriptScroll ? ['script-scroll fallback used.'] : []),
    ...(bank.clicked ?? []).map(row=>'expanded: '+JSON.stringify(row)),
  ];
  const wanted = new Set([0,n-1]),terms=options.find?.toLocaleLowerCase().split('|').filter(Boolean)??[];
  let matches=0;
  if (options.find !== undefined) {
    bank.items.forEach((row,i)=>{if(i>=(options.from??1)-1&&terms.some(term=>row.text.toLocaleLowerCase().includes(term))){matches++;for(const j of [i-1,i,i+1]) if(j>=0&&j<n)wanted.add(j);}});
  } else for(let i=(options.from ?? 1)-1;i<n;i++)wanted.add(i);
  const end = '# End whole-thread data', footer = '\n'+end;
  // Reserve the last item before filling a page. Every page always includes both endpoints.
  const line = i => {
    const row=bank.items[i],raw=row?.text??'',positions=terms.map(term=>raw.toLocaleLowerCase().indexOf(term)).filter(at=>at>=0);
    const start=positions.length?Math.max(0,Math.min(...positions)-300):0;
    const shortened=raw.length>1800?' [item text shortened; narrow whole.find]':'';
    return `item ${i+1} of ${n}: ${JSON.stringify(raw.slice(start,start+1800)+shortened+(row?.removed?' [removed]':''))}`;
  };
  const last = n ? line(n-1) : '';
  let text = header.join('\n').slice(0,3000), next;
  for(const i of [...wanted].filter(i=>i>=0&&i<n&&i!==n-1&&(i===0||i>=(options.from??1)-(options.find!==undefined?2:1))).sort((a,b)=>a-b)) {
    const row = line(i);
    if(text.length+row.length+last.length+footer.length+100>8000){next=i+1;break;}
    text+='\n'+row;
  }
  if(last)text+='\n'+last;
  if(next)text+=`\nMore held items: whole.from=${next}.`;
  if(options.find!==undefined&&!matches)text+=options.from?`\nNo matching held items at or after item ${options.from}.`:'\nNo matching held items; completeness above governs absence.';
  return text+footer;
}

export async function readWhole(entry, options, { ref, siteCheck = () => {} } = {}) {
  const { page } = entry, url = page.url();
  if (!tracked.has(page)) {
    tracked.add(page);
    page.on('framenavigated',frame=>{if(frame===page.mainFrame())transcripts.delete(page);});
    page.on('close',()=>transcripts.delete(page));
  }
  siteCheck(); await assertEndpointRead(page);
  if (options.from !== undefined || options.find !== undefined) {
    const held = transcripts.get(page);
    if (held && held.url === url && (ref===undefined||ref===held.ref)) {
      let probe;
      try {
        probe=await boundWhole(createWholeDOM(page),2000,'whole cache probe timed out');
        const current=await boundWhole(probe.view(),2000,'whole cache probe timed out');
        if(held.fingerprint===fingerprint(current))return {text:renderWhole(held,options)};
      } finally {if(probe)await probe.dispose();}
      transcripts.delete(page);
    } else if (options.from !== undefined) throw Error('whole transcript expired; read whole:{} again');
  }
  const start = Date.now(), deadline = start + (options.max_seconds ?? 45)*1000;
  const limit = options.max_items ?? 1000, clickLimit = options.max_clicks ?? 30;
  const bank = { url,ref,items:[],gaps:0,ends:{start:{state:'not reached',reason:'not searched'},end:{state:'not reached',reason:'not searched'}},
    reasons:[],refused:[],blocked:[],clicked:[],clicks:0,seconds:0 };
  let dom, guard;
  const budget = () => { siteCheck(); if(Date.now()>=deadline)throw Error('time cap');if(page.url()!==url)throw Error('page changed');if(page.isClosed())throw Error('page closed'); };
  const bounded = promise => boundWhole(promise,Math.min(20000,Math.max(1,deadline-Date.now())),deadline-Date.now()<20000?'time cap':'page unresponsive at 20 s');
  const view = async () => {budget();await bounded(guard.poll());if(bank.blocked.length)throw Error('blocked expander effect');await bounded(assertEndpointRead(page));const v=await dom.view();
    bank.refused=[...new Set([...bank.refused,...v.refused])].slice(0,100);
    if(v.fragments&&!bank.reasons.includes('possible fragments'))bank.reasons.push('possible fragments');
    if(v.totalConflict&&!bank.reasons.includes('conflicting declared totals'))bank.reasons.push('conflicting declared totals');
    bank.total=v.total??bank.total;bank.fingerprint=fingerprint(v);return v;};
  const merge = async v => {
    const result=mergeWhole(bank,await bounded(protectWholeRows(page,v.rows)),0,limit);
    if(v.textCapped||result.textCapped)throw Error('held text cap (8 MB)');
    return result;
  };
  const signatureOf = v => JSON.stringify([v.rows,v.top,v.height,v.busy]);
  const quiet = async (floor=300, previous) => {
    const began=Date.now();let stable=previous?.stableSince??Date.now(),signature=previous?signatureOf(previous):undefined;
    for(;;){budget();const v=await view();const sig=signatureOf(v);if(sig!==signature){signature=sig;stable=Date.now();}
      if(!v.busy&&!guard.pending()&&Date.now()-stable>=floor&&v.quiet>=floor)return {...v,stableSince:stable};
      if(Date.now()-began>=6000&&!v.busy&&!guard.pending())throw Error('DOM never quiet at 6 s');
      if(Date.now()-began>=15000)throw Error(v.busy?'loading indicator stalled at 15 s':'request stalled at 15 s');
      await sleep(Math.min(80,Math.max(1,deadline-Date.now())));
    }
  };
  try {
    // Guards are installed before any wheel or click, and kept until all owned input has settled.
    const acquiringGuard=guardWholeRead(entry,deadline,bank);
    try { guard=await bounded(acquiringGuard); }
    catch(error){acquiringGuard.then(late=>late.close(),()=>{}).catch(()=>{});throw error;}
    const acquiringDOM=createWholeDOM(page,ref);let rawDOM;
    try { rawDOM=await bounded(acquiringDOM); }
    catch(error){acquiringDOM.then(late=>late.dispose(),()=>{}).catch(()=>{});throw error;}
    dom = Object.fromEntries(['view','wheel','script','click'].map(method=>[method,(...args)=>{
      budget();const pending=Promise.resolve().then(()=>rawDOM[method](...args));
      if(method!=='view'){
        entry.state.wholeReadInput=pending;entry.state.actionPending=true;
        const clear=()=>{if(entry.state.wholeReadInput===pending){delete entry.state.wholeReadInput;entry.state.actionPending=false;}};
        pending.then(clear,clear);
      }
      return bounded(pending);
    }]));
    dom.dispose=()=>rawDOM.dispose();
    invalidateRefs(page);
    let current=await quiet(); await merge(current);
    if(!current.rows.length)throw Error('no list items');
    const directions=options.direction==='down'?[1]:options.direction==='up'?[-1]:[-1,1];
    const clicks=new Map();
    for(const direction of directions){
      const end=direction<0?'start':'end';let stuck=0,snap=0;
      while(true){
        budget();if(bank.items.length>=limit)throw Error('item cap');
        current=await view();
        const candidate=current.controls.find(c=>c.allowed&&!clicks.has(c.id));
        if(candidate){
          if(bank.clicks>=clickLimit)throw Error('click cap');
          const before=bank.items.length;
          bank.clicks++;
          const result=await dom.click(candidate.id,entry,()=>guard.expanderClick());
          if(!result){bank.stopped=(bank.stopped??0)+1;bank.refused.push(candidate.name+' (changed or covered)');clicks.set(candidate.id,false);}
          else {bank.clicked.push(candidate.name);current=await quiet();const merged=await merge(current);
            if(merged.ambiguous)bank.gaps++;
            clicks.set(candidate.id,true);
            // Repeat a loader only when this activation actually extended the transcript.
            if(bank.items.length>before)clicks.delete(candidate.id);
            else if(current.controls.some(c=>c.allowed&&c.id===candidate.id))bank.refused.push(candidate.name+' (last click added no items)');
          }
          if(bank.blocked.length)throw Error('blocked expander effect');
          continue;
        }
        const old=current, oldCount=bank.items.length;
        const edgeRow=direction<0?current.rows[0]:current.rows.at(-1);
        const matches=bank.items.map((row,i)=>(edgeRow?.key?row.key===edgeRow.key:row.text===edgeRow?.text)?i:-1).filter(i=>i>=0);
        const knownAt=matches.length===1?matches[0]:-1;
        const knownAhead=direction<0?knownAt>0:knownAt>=0&&knownAt<bank.items.length-1;
        await dom.wheel(direction*current.client*(knownAhead?3:.6));
        current=await quiet();let merged=await merge(current);
        if(merged.ambiguous){
          // Back off into the previous view twice, collecting an intermediate overlap.
          for(let retry=0;retry<2&&merged.ambiguous;retry++){
            await dom.wheel(-direction*current.client*.3);current=await quiet();merged=await merge(current);
          }
          if(merged.ambiguous){bank.gaps++;throw Error('gap: no unique overlap');}
        }
        if(merged.capped)throw Error('item cap');
        const moved=Math.abs(current.top-old.top)>1, added=bank.items.length>oldCount;
        const edge=direction<0?current.top<=1:current.top+current.client>=current.height-1;
        if(!moved&&!added&&!edge){
          await dom.script(direction*current.client*.6);bank.scriptScroll=true;
          current=await quiet();await merge(current);
        }
        if(direction*(current.top-old.top)<-1&&!added)snap++;else snap=0;
        if(snap>=3)throw Error('page scrolled itself back');
        if(!moved&&!added)stuck++;else stuck=0;
        if(edge&&!added&&!moved){
          // Quiet at the edge, then nudge away and back and hold quiet again.
          current=await quiet(2500,current);const n1=await merge(current);
          if(n1.added)continue;
          await dom.wheel(-direction*current.client*.3);await quiet();
          await dom.wheel(direction*current.client*.6);current=await quiet();
          const returnedTop=current.top;
          await dom.wheel(direction*current.client*.6);current=await quiet(2500);const n2=await merge(current);
          if(n2.added)continue;
          const stillAtEdge=direction<0?current.top<=1:current.top+current.client>=current.height-1;
          if(!stillAtEdge||Math.abs(current.top-returnedTop)>1)continue;
          if(current.controls.some(c=>c.allowed&&!clicks.has(c.id)))continue;
          const proof=current.markers[end],unopened=current.controls.some(c=>!c.allowed||clicks.has(c.id));
          bank.ends[end]=unopened?{state:'not reached',reason:'unopened controls at edge'}:proof?{state:'reached',evidence:proof}:{state:'unknown',reason:'no end marker; quiet held twice'};
          break;
        }
        if(stuck>=3)throw Error('stuck after 3 wheel steps');
        if(bank.blocked.length)throw Error('blocked expander effect');
      }
    }
  } catch(error) {
    if(error.siteBlocked||error.message===endpointBlock)throw error;
    const message=error.message.includes('whole DOM exceeds 50,000 elements')?'whole DOM exceeds 50,000 elements':error.message;
    bank.reasons.push(/^(time cap|item cap|click cap|gap:|stuck |page scrolled|page unresponsive|loading indicator|request stalled|DOM never quiet|no list|page changed|page closed|blocked expander|whole guard|whole DOM|held text cap)/.test(message)?message:'whole read unavailable');
  } finally {
    if(entry.state.wholeReadInput)await boundWhole(entry.state.wholeReadInput,1200,'input release pending').catch(()=>{bank.reasons.push('input cleanup unconfirmed');});
    if(dom)await boundWhole(dom.dispose(),1000,'DOM release pending').catch(()=>{});
    if(guard)await boundWhole(guard.close(),4000,'guard release pending').catch(()=>{bank.reasons.push('guard cleanup unconfirmed');});
    invalidateRefs(page);
  }
  if(bank.total!==undefined&&bank.total!==bank.items.length)bank.reasons.push(`declared total ${bank.total} differs from ${bank.items.length}`);
  bank.seconds=(Date.now()-start)/1000;
  if(bank.blocked.length)bank.reasons.push('blocked effects');
  transcripts.set(page,bank);
  return {text:renderWhole(bank,options)};
}
