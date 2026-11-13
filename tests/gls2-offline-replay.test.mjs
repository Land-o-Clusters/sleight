import test from 'node:test';
import assert from 'node:assert/strict';
import { splitRecordedTrees, replayDisplays, replayCallSevenAccounting } from '../scripts/gls2-offline-replay.mjs';
const text=text=>({type:'text',text});
const tree=value=>'Window: "Calculator", App: Calculator.\n0 standard window Calculator\n\t1 text Description: Count, Value: '+value+'\n'+Array.from({length:50},(_,i)=>'\t'+(i+2)+' button Row '+i+', ID: row-'+i).join('\n')+'\nThe focused UI element is 1.';
test('replay recognizes complete and capped recorded trees without granting capped output',()=>{const t=tree(0);const parts=splitRecordedTrees('policy\n'+t+'\n'+t.slice(0,90));assert.equal(parts.trees.length,2);assert.equal(parts.trees[0].complete,true);assert.equal(parts.trees[1].complete,false);});
test('GLS1 timeout retry drops its abandoned tree and coalesces duplicate reads',()=>{const rows=replayDisplays([{name:'js',content:[text('REPL_TIMEOUT')],timeout:true,error:true},{name:'js',content:[text(tree(1)),text(tree(0)),text(tree(0))]}]);assert.equal(rows[1].droppedDeferredTrees,1);assert.equal(rows[1].completeTrees,1);});
test('recorded action displays compact below 2 KB and never need a native driver',()=>{const rows=replayDisplays([{name:'js',content:[text(tree(0))]},{name:'js',content:[text(tree(3))]}]);assert.equal(rows[1].diffs,1);assert.ok(rows[1].after<2000);assert.ok(rows[1].after<rows[1].before/3);});

test('GLS1 call 7 accounting says Three sent and Six refused, with a derived read-again next',()=>{const r=replayCallSevenAccounting();assert.match(r.text,/click\(\{"id":"Three"\}\).*sent-unverified/);assert.match(r.text,/click\(\{"id":"Six"\}\).*refused STALE_READ/);assert.match(r.text,/2 requests arrived/);assert.match(r.text,/next=read-again/);assert.doesNotMatch(r.text,/delivery=not-sent|retry=safe/);});
