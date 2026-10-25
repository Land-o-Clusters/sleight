import {readFileSync} from 'node:fs';
import {startServer} from '../fowl/site/server.mjs';
import {wholeRaceFixtures,wholeRaceLog,gradeWholeRace,wholeRaceKinds} from '../fowl/whole-thread.mjs';
import {realBrowserPlan,launchRealBrowser} from '../fowl/real-browser.mjs';
import {acquireFixture} from '../real-run.mjs';
export const wholeThreadCatalog=JSON.parse(readFileSync(new URL('./tasks/whole-thread.json',import.meta.url)));
export const wholeThreadTasks=({launchBrowser=launchRealBrowser}={})=>wholeThreadCatalog.map(row=>({
 id:row.name,app:'Google Chrome',half:'browser',heldOut:true,requiredProfile:'fresh',
 async prepare(ctx){
  ctx.wholeFixtures=wholeRaceFixtures();
  const server=await startServer({port:0,wholeFixtures:ctx.wholeFixtures});ctx.closeServer=server.close;
  ctx.wholeOrigin=`http://127.0.0.1:${server.port}`;
 },
 async setup(ctx){
  if(ctx.realProfile!=='fresh'||ctx.ownerAway!==true)throw Error('WHOLE_ISOLATED_BROWSER_REQUIRED');
  ctx.signal?.throwIfAborted();await this.prepare(ctx);
  const plan=realBrowserPlan({browser:'chrome',round:'lr1-'+ctx.nonce,profile:'fresh'});
  await acquireFixture(ctx,'browser',()=>launchBrowser(plan,{initialPage:{url:ctx.wholeOrigin+'/whole/race-'+wholeRaceKinds[row.name][0]+'/',title:'Whole thread race-'+wholeRaceKinds[row.name][0]}}));
 },
 prompt:ctx=>row.prompt.replaceAll('http://127.0.0.1:5431',ctx.wholeOrigin).replaceAll('{browser}','Google Chrome'),
 check:ctx=>{const problems=gradeWholeRace({task:row,site:wholeRaceLog(ctx.wholeFixtures,row.name),answer:ctx.answer});return problems.length?problems.join('; '):true;},
 async cleanup(ctx){if(!ctx.browser)return;await ctx.beforeFixtureCleanup?.();const receipt=await ctx.browser.stop();if(receipt?.browserClosed!==true)throw Error('BENCH_BROWSER_CLEANUP_UNPROVED');},
}));
