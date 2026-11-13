import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
const mutations = {
  removal: ['removalDiffs: true', 'removalDiffs: false'],
  stored: ["if (previous && snapshot.readId < previous.snapshot.readId)", "if (false)"],
  valid: ["if (!selector && entry.belief?.get(target) !== beliefKey(delivered.lines[target])) stale(MAC_DELIVERED_CONTEXT_NOTICE);", ''],
  frame: ['entry.delivered = observed; entry.actions = undefined;', 'entry.delivered ??= observed; entry.actions = undefined;'],
  worker: ["if (item.type !== 'text' || candidates.get(item.text)?.size === 1 || exactCurrentRows(item)) return [];", 'if (true) return [];'],
  removed: ['if (belief.get(n) === beliefKey(removed)) belief.delete(n);', ''],
  truncated: ['snapshot.truncated', 'false'],
  deferred: ['reset() { epoch++; pendingDisplays.clear(); windows.clear(); }', 'reset() {}'],
  windows: ['const bindingKey = value => JSON.stringify([value?.windowId, value?.processStart]);', "const bindingKey = value => 'shared';"],
};
if (process.env.GLS2_MUTANT) {
  const pair = mutations[process.env.GLS2_MUTANT];assert.ok(pair);
  registerHooks({load(url,ctx,next){const loaded=next(url,ctx);if(!url.endsWith('/mac-driver/diff.mjs'))return loaded;
    assert.ok(String(loaded.source).includes(pair[0]));return {...loaded,source:process.env.GLS2_MUTANT==='truncated' ? String(loaded.source).replaceAll('snapshot.truncated','snapshot.__ignoredTruncated') : String(loaded.source).replace(pair[0],pair[1])};}});
}
const {createMacReadState,MAC_DELIVERED_CONTEXT_NOTICE,MAC_STRING_TARGET_NOTICE}=await import('../plugins/sleight/lib/mac-driver/diff.mjs');
const w={windowId:'101',pid:120,processStart:'100.25',bundleId:'com.example.Editor',app:'Editor',title:'Draft',identityVerified:true};
const txt=text=>({type:'text',text});
const tree=(rows=Array.from({length:100},(_,i)=>'\tbutton Row '+i+', ID: row-'+i))=>'Window: "Draft", App: Editor.\n'+['standard window Draft',...rows].map((r,n)=>r.replace(/^(\t*)(.*)/,(_,tabs,body)=>tabs+n+' '+body)).join('\n');
const base=tree();
const shifted=tree(['\ttext New',...Array.from({length:100},(_,i)=>i===27?null:'\tbutton Row '+i+', ID: row-'+i).filter(Boolean)]);
const obs=(s,id,text=base,window=w,extra={})=>s.read({window,readId:id,text,truncated:false,...extra});
const show=(s,rows,options={})=>{const b=s.prepareDisplay(rows.map(r=>txt(r.text)),rows,{compact:true,...options});b.commit();return b.content.map(r=>r.text).join('\n');};
const seed=()=>{const s=createMacReadState();show(s,[obs(s,1)]);return s;};
const click=(s,readId,n,window=w)=>{const p={...window,readId,args:[n]};const done=s.assertCurrent('click',p,'cell');return {p,done};};
const refuses=(fn,notice=false)=>assert.throws(fn,e=>e.code==='STALE_READ'&&(!notice||e.message.includes('End the cell and read again')));
test('E1 unchanged numbered rows remain valid after changed Value lines',()=>{const s=seed(),newTree=base.replace('button Row 8, ID: row-8','text Description: Count, Value: 7');show(s,[obs(s,2,newTree)]);assert.doesNotThrow(()=>click(s,2,22));});
test('E2 omitted renumbered rows refuse in the Ok frame',()=>{const s=seed();const result=show(s,[obs(s,2,shifted)],{actionNumbers:false});assert.match(result,/apart from numbering|other elements have new numbers/);refuses(()=>click(s,2,14),true);});
test('E2b known shifted rows print + current numbers and admit them',()=>{const s=seed();const result=show(s,[obs(s,2,shifted)]);assert.match(result,/^\+ \t15 button Row 13, ID: row-13$/m);assert.equal(click(s,2,15).p.args[0],15);assert.ok(Buffer.byteLength(result)<Buffer.byteLength(shifted)*0.6);});
test('E2c selectors resolve uniquely in Ok and fresh even with omitted numbers',()=>{const s=seed();show(s,[obs(s,2,shifted)],{actionNumbers:false});assert.doesNotThrow(()=>click(s,2,{id:'row-13'}));});
test('E3 displayed changed identity becomes usable, the unseen form refuses',()=>{const s=seed(),fresh=base.replace('Row 10, ID: row-10','Clear, ID: Clear');obs(s,2,fresh);refuses(()=>click(s,2,11));show(s,[obs(s,3,fresh)]);assert.doesNotThrow(()=>click(s,3,11));});
test('E4 removed final row refuses while unchanged One binds',()=>{const s=seed();show(s,[obs(s,2,tree(Array.from({length:99},(_,i)=>'\tbutton Row '+i+', ID: row-'+i)))]);refuses(()=>click(s,2,100));assert.doesNotThrow(()=>click(s,2,22));});
test('E5 worker-authored diff blocks an undelivered window',()=>{const s=seed();s.prepareDisplay([txt('sleight: lines changed\n+ 36 menu item Scientific')],[],{compact:true}).commit();refuses(()=>click(s,1,36));});
test('E6 emit:false cannot introduce a new number',()=>{const s=seed();obs(s,2,tree(Array.from({length:101},(_,i)=>'\tbutton Row '+i+', ID: row-'+i)));refuses(()=>click(s,2,101),true);assert.match(MAC_DELIVERED_CONTEXT_NOTICE,/emit:false/);});
test('E7 reset drops dead-cell deferred display callbacks',()=>{const s=seed();const dead=s.prepareDisplay([txt(shifted)],[obs(s,2,shifted)],{compact:true});s.reset();dead.commit();obs(s,1,shifted);refuses(()=>click(s,1,15),true);});
test('E8 greater than 60 percent prints whole, establishing every row',()=>{const s=seed(),fresh=base.replaceAll('Row ','Changed row ');const output=show(s,[obs(s,2,fresh)]);assert.equal(output,fresh);assert.doesNotThrow(()=>click(s,2,99));});
test('E9 truncated reads never establish F or Ok for admission',()=>{const s=seed();show(s,[obs(s,2,shifted,w,{truncated:true})]);refuses(()=>click(s,2,15),true);assert.equal(s.displayContext(w).Ok,base);const next=obs(s,3);assert.equal(show(s,[next]),base);});
test('E10 windows keep distinct F and Ok frames',()=>{const s=seed(),other={...w,windowId:'202'};show(s,[obs(s,1,base,other)]);const a=obs(s,2,shifted),b=obs(s,2,base,other);show(s,[a,b]);assert.doesNotThrow(()=>click(s,2,15));assert.doesNotThrow(()=>click(s,2,14,other));});
test('E11 repeated omitted renumberings never grant unseen numbers',()=>{const s=seed();show(s,[obs(s,2,shifted)],{actionNumbers:false});show(s,[obs(s,3,shifted)],{actionNumbers:false});refuses(()=>click(s,3,14),true);});
test('E12 same-cell reads remain fresh side only',()=>{const s=seed();obs(s,2,tree(Array.from({length:101},(_,i)=>'\tbutton Row '+i+', ID: row-'+i)));refuses(()=>click(s,2,101),true);});
for(const id of ['row-13','missing'])test('GLS1-10 string '+id,()=>{const s=seed();obs(s,2,shifted);if(id==='missing')assert.throws(()=>click(s,2,id),e=>e.message.includes(MAC_STRING_TARGET_NOTICE));else assert.deepEqual(click(s,2,id).p.args[0],{id});});
for(const which of ['old','new'])test('GLS1-10 duplicate ID in '+which+' read refuses',()=>{const s=createMacReadState(),duplicate=base.replace('ID: row-14','ID: row-13');show(s,[obs(s,1,which==='old'?duplicate:base)]);obs(s,2,which==='new'?duplicate:base);assert.throws(()=>click(s,2,'row-13'),e=>e.message.includes(MAC_STRING_TARGET_NOTICE));});
test('GLS1-10 unique ID still obeys GLR1 context',()=>{const s=seed();obs(s,2,base.replace('Row 2, ID: row-2','Other, ID: row-2'));refuses(()=>click(s,2,'row-13'));});
test('E property: 1000 random renumberings, targets and whole or diff displays',()=>{
  let random=3721,whole=0,diffs=0;
  const next=()=>random=(random*1664525+1013904223)>>>0;
  for(let i=0;i<1000;i++){
    const s=seed(),at=1+next()%99,count=1+next()%3;
    const rows=Array.from({length:100},(_,n)=>'\tbutton Row '+n+', ID: row-'+n);
    rows.splice(at-1,0,...Array.from({length:count},(_,n)=>'\tbutton New '+i+'-'+n+', ID: new-'+i+'-'+n));
    const current=tree(rows),snapshot=obs(s,2,current),full=i%2===0;
    const output=show(s,[snapshot],{actionNumbers:false,forceFull:full?new Set([snapshot]):new Set()});
    const n=1+next()%(100+count),added=new Set([...output.matchAll(/^\+ \t*(\d+) /gm)].map(m=>Number(m[1])));
    const same=base.split('\n')[n+1]===current.split('\n')[n+1];
    const allowed=output===current||added.has(n)||same;
    if(allowed)assert.doesNotThrow(()=>click(s,2,n));else refuses(()=>click(s,2,n));
    if(output===current)whole++;else diffs++;
  }
  assert.equal(whole,500);assert.equal(diffs,500);
});

test('E4 minus lines revoke the removed number while identical rows at stable positions remain valid',()=>{
  const s=createMacReadState(),rows=Array.from({length:100},(_,i)=>'\tbutton Row '+i+', ID: row-'+i);
  rows[9]=rows[8];show(s,[obs(s,1,tree(rows))]);rows.splice(9,1);
  show(s,[obs(s,2,tree(rows))],{actionNumbers:false});
  assert.doesNotThrow(()=>click(s,2,9));
  rows.splice(8,0,'\tbutton New, ID: new');
  show(s,[obs(s,3,tree(rows))],{actionNumbers:false});
  refuses(()=>click(s,3,10));
});

test('E parent retains F while Ok and belief advance through changed lines',()=>{const s=seed();const fresh=base.replace('Row 10, ID: row-10','Clear, ID: Clear');show(s,[obs(s,2,fresh)]);assert.equal(s.displayContext(w).F,base);assert.equal(s.displayContext(w).Ok,fresh);const newest=base.replace('Row 10, ID: row-10','Pause, ID: Pause');show(s,[obs(s,3,newest)]);assert.equal(s.displayContext(w).F,base);assert.equal(s.displayContext(w).Ok,newest);});

test('E exact current worker rows add no belief and preserve the parent diff',()=>{const s=seed();const fresh=base.replace('Row 10, ID: row-10','Clear, ID: Clear'),snapshot=obs(s,2,fresh);const b=s.prepareDisplay([txt(fresh),txt('11 button Clear, ID: Clear')],[snapshot],{compact:true});assert.match(b.content[0].text,/lines changed since/);b.commit();assert.doesNotThrow(()=>click(s,2,11));});

for(const compact of [false,true])test('E old stored tree after a newer observation cannot restore a numbered frame, compact='+compact,()=>{const s=createMacReadState(),a=obs(s,1),b=obs(s,2,shifted);const out=s.prepareDisplay([txt(b.text),txt(a.text)],[a,b],{compact});out.commit();refuses(()=>click(s,2,14),true);});

test('Calculator viewport removal stays compact and omitted shifted numbers stay invalid',()=>{
  const before=readFileSync(new URL('./fixtures/glc1-calculator-closed.txt',import.meta.url),'utf8');
  const after=readFileSync(new URL('./fixtures/glc2-calculator-after-seven.txt',import.meta.url),'utf8');
  const s=createMacReadState(),calc={...w,app:'Calculator',title:'Calculator'};show(s,[obs(s,1,before,calc)]);
  const result=show(s,[obs(s,2,after,calc)]);
  assert.match(result,/lines changed/);assert.match(result,/^- /m);
  assert.ok(Buffer.byteLength(result)<2000,Buffer.byteLength(result));
  const printed=new Set([...result.matchAll(/^\+ \t*(\d+) /gm)].map(m=>Number(m[1])));
  for (const line of after.split('\n')) {
    const n=Number(/^\t*(\d+) /.exec(line)?.[1]);if(!Number.isInteger(n))continue;
    const same=before.split('\n').includes(line);
    if(printed.has(n)||same)assert.doesNotThrow(()=>click(s,2,n,calc));else refuses(()=>click(s,2,n,calc),true);
  }
  assert.doesNotThrow(()=>click(s,2,{id:'One'},calc));
});
test('removing a block plus genuine churn over 60 percent still sends the whole tree',()=>{
  const s=seed(),fresh=tree(Array.from({length:99},(_,i)=>'\tbutton Changed '+i+', ID: changed-'+i));
  assert.equal(show(s,[obs(s,2,fresh)]),fresh);
});

test('GLINT1 compact submenu counts and expanded popups keep delivered numbers bound', () => {
  const filler = Array.from({ length: 100 }, (_, n) => '\tbutton Filler ' + n + ', ID: filler-' + n);
  const collapsed = count => tree([...filler, '\tbutton Mode, ID: Mode',
    '\tmenu bar', '\t\tmenu bar item File', '\t\t\tmenu item Recent Items (submenu, ' + count + ' items)']);
  const expanded = tree([...filler, '\tbutton Mode, ID: Mode', '\t\tmenu (expanded)',
    '\t\t\tmenu item Basic', '\t\t\tmenu item Scientific', '\tmenu bar', '\t\tmenu bar item File',
    '\t\t\tmenu item Recent Items (submenu, 1 items)']);
  const s = createMacReadState(); show(s, [obs(s, 1, collapsed(1))]);
  const opening = show(s, [obs(s, 2, expanded)]);
  assert.match(opening, /lines changed/); assert.match(opening, /^\+ \t\t\t104 menu item Scientific$/m);
  assert.doesNotThrow(() => click(s, 2, 104));
  const closing = show(s, [obs(s, 3, collapsed(1))]);
  assert.match(closing, /lines changed/); assert.match(closing, /^- \t\t\tmenu item Scientific$/m);
  refuses(() => click(s, 3, 107));
  refuses(() => click(s, 3, { label: 'Scientific' }));
  assert.doesNotThrow(() => click(s, 3, { label: 'Recent Items' }));
  const countChange = show(s, [obs(s, 4, collapsed(2))]);
  assert.match(countChange, /lines changed/);
  assert.match(countChange, /^- .*Recent Items \(submenu, 1 items\)$/m);
  assert.match(countChange, /^\+ .*Recent Items \(submenu, 2 items\)$/m);
  assert.doesNotMatch(countChange, /private-file/);
  assert.doesNotThrow(() => click(s, 4, { label: 'Recent Items' }));
  assert.doesNotThrow(() => click(s, 4, 50));
  obs(s, 5, expanded);
  refuses(() => click(s, 5, 50));
  show(s, [obs(s, 6, expanded)]);
  obs(s, 7, expanded.replace('104 menu item Scientific', '104 menu item (disabled) Scientific'));
  refuses(() => click(s, 7, 103));
});
