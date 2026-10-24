import test from 'node:test';
import assert from 'node:assert/strict';
import { browserTools, validateToolCall } from '../plugins/sleight/lib/direct-browser/tools.mjs';

const call = whole => validateToolCall({name:'browser_read',arguments:{tab:'t1',whole}});
test('whole is an option on the existing five tools, with bounded budgets', () => {
  assert.equal(browserTools().length, 5);
  assert.doesNotThrow(() => call({}));
  assert.doesNotThrow(() => call({direction:'both',max_items:5000,max_seconds:120,from:1,find:'invoice'}));
  for (const whole of [{max_items:5001},{max_items:0},{max_seconds:121},{max_seconds:0},{direction:'left'},{from:0},{expand:false}])
    assert.throws(() => call(whole));
});

const whole = await import('../plugins/sleight/lib/direct-browser/whole.mjs').catch(() => ({}));
test('merging keeps six repeated rows and extends both sides without recycled-node aliases', () => {
  const rows = Array.from({length:120},(_,i)=>({node:i%12,text:i>=50&&i<56?'ok':`m-${String(i+1).padStart(3,'0')}`}));
  const bank={items:[],gaps:0};
  for(let i=108;i>=0;i-=4) assert.equal(whole.mergeWhole(bank,rows.slice(i,i+12),-1,1000).ambiguous,false);
  assert.deepEqual(bank.items.map(x=>x.text),rows.map(x=>x.text));
});
test('ambiguous short identical views do not silently collapse duplicates', () => {
  const bank={items:[{text:'ok'},{text:'ok'},{text:'ok'}],gaps:0};
  assert.equal(whole.mergeWhole(bank,[{text:'ok'},{text:'ok'}],1,1000).ambiguous,true);
});
test('whole output caps text, fences page strings, pages and finds with neighbours', () => {
  const bank={items:Array.from({length:1000},(_,i)=>({text:i===500?'needle':'row '+i+' '+ 'x'.repeat(60)})),ends:{start:{state:'reached',evidence:'Beginning'},end:{state:'reached',evidence:'End'}},reasons:[],refused:[],clicks:0,seconds:1};
  assert.ok(whole.renderWhole(bank,{}).length<=8000);
  const text=whole.renderWhole(bank,{find:'needle'});
  assert.match(text,/item 500 of 1000/);assert.match(text,/item 501 of 1000/);assert.match(text,/item 502 of 1000/);
  assert.match(text,/item 1 of 1000/);assert.match(text,/item 1000 of 1000/);
  assert.match(text,/untrusted page content/);
  assert.match(whole.renderWhole(bank,{from:700}),/item 700 of 1000/);
});

test('plain scrolling log and indexed rows point to whole without an eager sixth tool', async()=>{
 const {wholeReadHint}=await import('../plugins/sleight/lib/direct-browser/snapshot.mjs');
 assert.match(wholeReadHint([{role:'log',children:[]}]),/whole:\{\}/);
 assert.match(wholeReadHint([{role:'group',children:[{role:'row',rowindex:3}]}]),/whole:\{\}/);
 assert.equal(wholeReadHint([{role:'button',name:'Show more'}]),'');
});
test('short-overlap virtual views back off into a unique neighbour before six equal rows',()=>{
 const rows=Array.from({length:120},(_,i)=>({node:i%12,text:i>=50&&i<56?'ok':`m-${String(i+1).padStart(3,'0')}`}));
 const bank={items:[],gaps:0};for(const start of [0,8,16,24,32,40])assert.equal(whole.mergeWhole(bank,rows.slice(start,start+12),1,1000).ambiguous,false);
 assert.equal(whole.mergeWhole(bank,rows.slice(50,62),1,1000).ambiguous,true);
 assert.equal(whole.mergeWhole(bank,rows.slice(45,57),1,1000).ambiguous,false);
 assert.equal(bank.items.length,57);
});
test('stable item keys update changed text and preserve a removed item as evidence',()=>{
 const bank={items:[{key:'a',text:'before'},{key:'b',text:'removed'},{key:'c',text:'last'}],gaps:0};
 const result=whole.mergeWhole(bank,[{key:'a',text:'edited'},{key:'d',text:'inserted'},{key:'c',text:'last'}],1,1000);
 assert.equal(result.ambiguous,false);assert.equal(bank.items.find(x=>x.key==='a').text,'edited');
 assert.equal(bank.items.find(x=>x.key==='b').removed,true);
 assert.equal(bank.items.find(x=>x.key==='d').text,'inserted');
});
test('duplicate item keys within a view cannot merge two distinct identical messages',()=>{
 const bank={items:[],gaps:0};whole.mergeWhole(bank,[{key:'duplicate',text:'ok'},{key:'duplicate',text:'ok'}],1,1000);
 assert.equal(bank.items.length,2);assert.ok(bank.items.every(row=>row.key===undefined));
});
test('item cap does not overrun when discovering a new prefix or suffix',()=>{
 const bank={items:[{key:'b',text:'b'}],gaps:0};whole.mergeWhole(bank,[{key:'a',text:'a'},{key:'b',text:'b'},{key:'c',text:'c'}],1,2);
 assert.equal(bank.items.length,2);
});
test('held nodes distinguish identical repeated text runs only with a differing neighbour',()=>{
 const bank={items:[{node:1,text:'left'},{node:2,text:'ok'},{node:3,text:'right'},{node:4,text:'left'},{node:5,text:'ok'},{node:6,text:'right'}],gaps:0};
 assert.equal(whole.mergeWhole(bank,[{node:4,text:'left'},{node:5,text:'ok'},{node:6,text:'right'}],1,1000).ambiguous,false);
 assert.equal(bank.items.length,6);
});
test('a changed-in-place node updates when both ordered neighbours remain the same',()=>{
 const bank={items:[{node:1,text:'left'},{node:2,text:'before'},{node:3,text:'right'}],gaps:0};
 assert.equal(whole.mergeWhole(bank,[{node:1,text:'left'},{node:2,text:'after'},{node:3,text:'right'}],1,1000).ambiguous,false);
 assert.equal(bank.items[1].text,'after');
});
test('whole bounds a stalled operation without claiming its promise was cancelled',async()=>{
 let finish;const pending=new Promise(resolve=>{finish=resolve;});
 await assert.rejects(whole.boundWhole(pending,10,'time cap'),/time cap/);
 finish('settled');assert.equal(await pending,'settled');
});
test('ordered text runs merge an inserted unkeyed row without duplicating its neighbours',()=>{
 const bank={items:[{text:'first'},{text:'middle'},{text:'last'}],gaps:0};
 const result=whole.mergeWhole(bank,[{text:'first'},{text:'inserted'},{text:'middle'},{text:'last'}],1,1000);
 assert.equal(result.ambiguous,false);assert.deepEqual(bank.items.map(x=>x.text),['first','inserted','middle','last']);
});
test('ordered text runs preserve an unkeyed item removed between agreeing anchors',()=>{
 const bank={items:[{text:'first'},{text:'removed'},{text:'last'}],gaps:0};
 assert.equal(whole.mergeWhole(bank,[{text:'first'},{text:'last'}],1,1000).ambiguous,false);
 assert.equal(bank.items.find(x=>x.text==='removed').removed,true);
});
test('find and from compose while preserving first and last items',()=>{
 const bank={items:Array.from({length:1000},(_,i)=>({text:'needle '+i})),ends:{start:{state:'reached'},end:{state:'reached'}},reasons:[],refused:[],clicks:0,seconds:1};
 const text=whole.renderWhole(bank,{find:'needle',from:700});
 assert.match(text,/item 700 of 1000/);assert.match(text,/item 699 of 1000/);assert.doesNotMatch(text,/item 2 of 1000/);assert.match(text,/item 1 of 1000/);assert.match(text,/item 1000 of 1000/);
});
test('find exposes a match deep in a long item within the character cap',()=>{
 const bank={items:[{text:'x'.repeat(5000)+' needle '+'x'.repeat(5000)},{text:'tail'}],ends:{start:{state:'reached'},end:{state:'reached'}},reasons:[],refused:[],clicks:0,seconds:1};
 const text=whole.renderWhole(bank,{find:'needle'});assert.ok(text.includes('needle'),'the matching text must be visible');assert.ok(text.includes('item text shortened'));assert.ok(!text.includes('No matching held items'),'a found match must not be labelled absent');assert.ok(text.length<=8000);
});

test('held text stops at 8 MB of UTF-8 across merges, including edited rows',()=>{
 const bank={items:[],gaps:0};
 const first=whole.mergeWhole(bank,Array.from({length:120},(_,i)=>({key:'m'+i,text:'a'.repeat(65536)})),1,5000);
 assert.equal(first.ambiguous,false);
 const next=whole.mergeWhole(bank,[{key:'m119',text:'a'.repeat(65536)},...Array.from({length:20},(_,i)=>({key:'n'+i,text:'界'.repeat(21000)}))],1,5000);
 assert.ok(bank.items.reduce((n,r)=>n+Buffer.byteLength(r.text),0)<=8000000);assert.equal(next.textCapped,true);
 const edit={items:[],gaps:0};
 whole.mergeWhole(edit,Array.from({length:120},(_,i)=>({key:'m'+i,text:'a'.repeat(65536)})),1,5000);
 const growth=whole.mergeWhole(edit,edit.items.map((row,i)=>({...row,text:i<2?'界'.repeat(65536):row.text})),1,5000);
 assert.ok(edit.items.reduce((n,r)=>n+Buffer.byteLength(r.text),0)<=8000000);assert.equal(growth.textCapped,true);
});

test('whole reads reject competing p143 read modes instead of silently choosing one',()=>{
 for(const extra of [{file:'/tmp/fixture.pdf'},{export:'e1'},{links:true},{screenshot:true},{find:'needle'},{text:true},{max_chars:1000}])
  assert.throws(()=>validateToolCall({name:'browser_read',arguments:{...(extra.file?{}:{tab:'t1'}),...extra,whole:{}}}),/whole/);
 assert.doesNotThrow(()=>validateToolCall({name:'browser_read',arguments:{tab:'t1',ref:'e1',whole:{find:'needle'}}}));
});
