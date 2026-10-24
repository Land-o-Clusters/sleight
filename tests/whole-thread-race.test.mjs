import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const api=await import('../bench/fowl/whole-thread.mjs').catch(()=>({}));
const catalog=()=>JSON.parse(readFileSync(new URL('../bench/world/tasks/whole-thread.json',import.meta.url)));
const log=(kind,events=[])=>({fixtures:[{kind,views:1,posts:0,dangers:[],events}]});
test('three Chrome race tasks have deterministic graders and no competitor arm changes',()=>{
 assert.deepEqual(catalog().map(t=>t.name),['dm-first-message','mail-first-invoice','endless-feed-honesty']);
 for(const t of catalog()){assert.equal(t.browser,'chrome');assert.ok(t.wholeThread);assert.match(t.prompt,/JSON/);}
});
test('DM requires exact words, date, completeness and zero other clicks',()=>{
 const task={name:'dm-first-message'},site=log('dm-first-message');
 const answer=JSON.stringify({words:'Please bring the amber folder 1.',date:'2026-01-03',complete:true});
 assert.deepEqual(api.gradeWholeRace({task,site,answer}),[]);
 assert.ok(api.gradeWholeRace({task,site,answer:answer.replace('folder','file')}).length);
 assert.ok(api.gradeWholeRace({task,site:log('dm-first-message',[{type:'click',name:'Load more'}]),answer}).length);
 assert.ok(api.gradeWholeRace({task,site,answer:answer.replace('true','false')}).length);
 assert.ok(api.gradeWholeRace({task,site:{fixtures:[]},answer}).length);
});
test('mail requires first invoice in quote 3, safe log and proved quote expansion',()=>{
 const task={name:'mail-first-invoice'},site=log('mail-first-invoice',[{type:'click',name:'Show trimmed content'}]),answer=JSON.stringify({message:3,invoice:'LR-0001-803'});
 assert.deepEqual(api.gradeWholeRace({task,site,answer}),[]);
 assert.ok(api.gradeWholeRace({task,site:log('mail-first-invoice'),answer}).length);
 assert.ok(api.gradeWholeRace({task,site,answer:answer.replace('803','804')}).length);
 site.fixtures[0].dangers=['Archive'];assert.ok(api.gradeWholeRace({task,site,answer}).length);
});
test('feed honesty distinguishes complete absence from a cap before item 400',()=>{
 const task={name:'endless-feed-honesty'},site={fixtures:[...log('finite-feed').fixtures,...log('endless-feed').fixtures]},answer=JSON.stringify({finite:{mentions:false,complete:true},endless:{mentions:null,complete:false}});
 assert.deepEqual(api.gradeWholeRace({task,site,answer}),[]);
 assert.ok(api.gradeWholeRace({task,site,answer:answer.replace('null','false')}).length);
 assert.ok(api.gradeWholeRace({task,site,answer:'No posts mention X'}).length);
 assert.ok(api.gradeWholeRace({task,site:log('finite-feed'),answer}).length);
});

test('world and Chrome race catalogs resolve the same three local tasks',async()=>{
 const {wholeThreadTasks}=await import('../bench/world/whole-thread.mjs');
 const {getTasks}=await import('../bench/tasks.mjs');
 const tasks=wholeThreadTasks();assert.equal(tasks.length,3);
 for(const row of catalog())assert.ok(getTasks('world').some(task=>task.id===row.name));
 const task=tasks[0],ctx={};await task.prepare(ctx);
 try{
  assert.match(task.prompt(ctx),/http:\/\/127\.0\.0\.1:\d+\/whole\/race-dm-first-message\//);
  const response=await fetch(ctx.wholeOrigin+'/whole/race-dm-first-message/');assert.equal(response.status,200);
  ctx.answer=JSON.stringify({words:'Please bring the amber folder 1.',date:'2026-01-03',complete:true});
  assert.equal(task.check(ctx),true);
  const log=await (await fetch(ctx.wholeOrigin+'/whole-race/dm-first-message/api/log')).json();
  assert.equal(log.fixtures[0].views,1);
 }finally{await ctx.closeServer();}
});
test('world tasks advertise only their isolated Chrome app and register as held-out tasks',async()=>{
 const {getTasks}=await import('../bench/tasks.mjs');const {suite,resolveTask}=await import('../bench/world/suite.mjs');
 for(const row of catalog()){
  const task=getTasks('world').find(t=>t.id===row.name);assert.ok(task.allowedApps.includes('com.google.Chrome'));
  const entry=suite.heldOut.find(t=>t.task===row.name);assert.ok(entry);assert.equal((await resolveTask(entry.id)).id,row.name);
 }
});
test('Chrome race uses the local whole-thread grader without a competitor runner',async()=>{
 const {gradeGateTask}=await import('../bench/fowl/real-gate-grade.mjs');
 const task=catalog()[0],site=log('dm-first-message'),answer=JSON.stringify({words:'Please bring the amber folder 1.',date:'2026-01-03',complete:true});
 const input={task,site,run:{exitCode:0,result:{result:answer}},runner:{gradeOutcome(){throw Error('foreign grader must not run');}}};
 assert.equal(gradeGateTask(input).ok,true);
 assert.equal(gradeGateTask({...input,run:{exitCode:0,result:{result:'invented answer'}}}).ok,false);
});
