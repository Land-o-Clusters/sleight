import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import * as chrome from '../bench/world/arms/chrome.mjs';
import { browserArmSetup } from '../bench/world/arms/browser.mjs';

const device = '83e6d921-8a11-4c87-a945-cbd5b5b883d6';
function fixture(t) {
  const dir = trackTemp(fs.mkdtempSync(path.join(os.tmpdir(), 'sleight-chrome-device-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = { deviceFile: path.join(dir, 'device'), localState: path.join(dir, 'Local State'),
    manifest: path.join(dir, 'manifest.json'), backupDir: path.join(dir, 'backup') };
  fs.writeFileSync(files.deviceFile, device + '\n', { mode: 0o600 });
  fs.writeFileSync(files.localState, JSON.stringify({profile:{info_cache:{Default:{name:'owner'},'Profile 7':{name:'sleight benchmark'}}}}));
  fs.writeFileSync(files.manifest, 'owner manifest\n', {mode:0o640});
  return { dir, files };
}
test('Chrome setup reads the private device pin and chooses the mapped profile', t => {
  const {dir,files}=fixture(t);
  const setup=browserArmSetup({surface:'claude-in-chrome',task:{browser:'chrome'},dir:path.join(dir,'run'),armRoot:path.join(dir,'arms'),hostEnv:{PATH:'/bin'},chromeFiles:files});
  assert.equal(setup.metadata.chrome.deviceId,device);
  assert.equal(setup.metadata.chrome.profileFolder,'Profile 7');
  assert.equal(setup.env.ENABLE_TOOL_SEARCH,'false');
  assert.match(setup.setupPrefix,/first tool call.*select_browser/);
  assert.ok(setup.setupPrefix.includes(device));
  assert.ok(!setup.setupPrefix.includes('switch_browser'));
  assert.ok(setup.chrome.launch.args.includes('--profile-directory=Profile 7'));
  fs.chmodSync(files.deviceFile,0o644);
  assert.throws(()=>chrome.chromeArmPlan(files),/0600/);
  fs.chmodSync(files.deviceFile,0o600); fs.writeFileSync(files.deviceFile,'not a device');
  assert.throws(()=>chrome.chromeArmPlan(files),/device/);
});
test('Chrome launch stays inside manifest backup and restoration on success or failure', async t => {
  const {files}=fixture(t), plan=chrome.chromeArmPlan(files), calls=[];
  const launch=(command,args)=>{calls.push([command,args]);fs.writeFileSync(files.manifest,'arm manifest');return{status:0};};
  assert.equal(await chrome.withChromeArm(plan,async()=>{assert.equal(fs.readFileSync(files.manifest,'utf8'),'arm manifest');return 7;},{launch}),7);
  assert.equal(fs.readFileSync(files.manifest,'utf8'),'owner manifest\n');
  assert.equal(fs.statSync(files.manifest).mode&0o777,0o640);
  await assert.rejects(chrome.withChromeArm(plan,async()=>{throw Error('fixture failure');},{launch}),/fixture failure/);
  assert.equal(fs.readFileSync(files.manifest,'utf8'),'owner manifest\n');
  assert.equal(calls.length,2);
  let ran=false;
  await assert.rejects(chrome.withChromeArm(plan,async()=>{ran=true;},{launch:()=>({status:9})}),/launch/);
  assert.equal(ran,false);
});
test('Chrome gate blocks task tools until the exact selected device is confirmed in use', t => {
  const {dir,files}=fixture(t), plan=chrome.chromeArmPlan(files), state=path.join(dir,'state.json');
  const gate=(event,name,input={},response)=>chrome.chromeDeviceHook({hook_event_name:event,tool_name:'mcp__claude-in-chrome__'+name,tool_input:input,tool_response:response,tool_use_id:'selection'},state,plan.deviceId);
  assert.equal(gate('PreToolUse','tabs_context_mcp').continue,false);
  fs.rmSync(state,{force:true});
  assert.equal(gate('PreToolUse','select_browser',{deviceId:device}).continue,undefined);
  assert.equal(gate('PreToolUse','computer',{action:'left_click'}).continue,false);
  fs.rmSync(state,{force:true});
  gate('PreToolUse','select_browser',{deviceId:device});
  gate('PostToolUse','select_browser',{deviceId:device},{content:[{type:'text',text:'Selected browser'}]});
  assert.equal(gate('PreToolUse','list_connected_browsers').continue,undefined);
  gate('PostToolUse','list_connected_browsers',{},[{deviceId:device,name:'Browser 2',isLocal:true,inUse:true}]);
  assert.equal(gate('PreToolUse','computer',{action:'left_click'}).continue,undefined);
  assert.equal(JSON.parse(fs.readFileSync(state)).confirmed,true);
  assert.equal(gate('PreToolUse','switch_browser').continue,false);
});
test('Chrome gate rejects another device, failed selection, ambiguous confirmation and another in-use browser', t => {
  const {dir}=fixture(t);
  for(const response of [{isError:true},[{deviceId:device,inUse:false}],[{deviceId:'other',inUse:true}],
    [{deviceId:device,inUse:true},{deviceId:'other',inUse:true}],[{deviceId:device,inUse:true},{deviceId:device,inUse:true}]]) {
    const state=path.join(dir,'gate-'+Math.random()+'.json');
    chrome.chromeDeviceHook({hook_event_name:'PreToolUse',tool_name:'mcp__claude-in-chrome__select_browser',tool_input:{deviceId:device},tool_use_id:'one'},state,device);
    const result=chrome.chromeDeviceHook({hook_event_name:'PostToolUse',tool_name:'mcp__claude-in-chrome__select_browser',tool_input:{deviceId:device},tool_use_id:'one',tool_response:response},state,device);
    assert.notEqual(JSON.parse(fs.readFileSync(state)).confirmed,true);
    if(response.isError) assert.match(result.hookSpecificOutput.additionalContext,/retry/i);
  }
  const state=path.join(dir,'wrong.json');
  assert.equal(chrome.chromeDeviceHook({hook_event_name:'PreToolUse',tool_name:'mcp__claude-in-chrome__select_browser',tool_input:{deviceId:'other'}},state,device).continue,false);
});
test('Chrome hook CLI denies malformed input and configuration adds both tool hooks', t => {
  const {dir,files}=fixture(t), state=path.join(dir,'gate.json');
  const hooks=chrome.chromeHooks(state,device);
  for(const event of ['PreToolUse','PostToolUse','PostToolUseFailure']) assert.ok(hooks[event][0].hooks[0].args[0].includes('chrome-hook.mjs'));
  const run=spawnSync(process.execPath,[new URL('../bench/world/arms/chrome-hook.mjs',import.meta.url).pathname,state,device],{input:'{bad',encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  assert.equal(JSON.parse(run.stdout).continue,false);
  const probe=chrome.chromeProbePlan({dir:path.join(dir,'probe'),armRoot:path.join(dir,'arms'),chromeFiles:files});
  assert.ok(probe.args.includes('--chrome'));
  assert.ok(probe.args.includes('--strict-mcp-config'));
  assert.equal(probe.args[probe.args.indexOf('--max-turns')+1],'1');
});

test('one-turn Chrome tool probe checks the strict inventory and restores the manifest', async t => {
  const {dir,files}=fixture(t);
  const {probeChrome}=await import('../bench/world/arms/chrome-probe.mjs');
  const plan=chrome.chromeProbePlan({dir:path.join(dir,'probe'),armRoot:path.join(dir,'arms'),chromeFiles:files});
  const calls=[];
  const run=(command,args)=>{calls.push(args);return args.includes('--version')?{status:0,stdout:'2.1.289 (Claude Code)\n'}:
    {status:0,stdout:JSON.stringify({type:'system',subtype:'init',tools:['mcp__claude-in-chrome__select_browser','mcp__claude-in-chrome__list_connected_browsers']})+'\n'};};
  const launch=()=>{fs.writeFileSync(files.manifest,'probe manifest');return{status:0};};
  const result=await probeChrome(plan,{dir:path.join(dir,'probe'),run,launch});
  assert.equal(result.tools.length,2);
  assert.equal(result.strictMcpConfig,true);
  assert.equal(calls.length,2);
  assert.equal(fs.readFileSync(files.manifest,'utf8'),'owner manifest\n');
  await assert.rejects(probeChrome(plan,{dir:path.join(dir,'probe'),launch,run:(_command,args)=>args.includes('--version')?{status:0,stdout:'2.1.289 (Claude Code)\n'}:
    {status:0,stdout:JSON.stringify({type:'system',subtype:'init',tools:[]})}}),/Chrome tools/);
  assert.equal(fs.readFileSync(files.manifest,'utf8'),'owner manifest\n');
});

test('Chrome manifest backup survives an immediate harness exit', t => {
  const {files}=fixture(t);
  const helper=new URL('../bench/world/arms/chrome.mjs',import.meta.url).href;
  const source=`import fs from 'node:fs'; import {withManifestBackup} from ${JSON.stringify(helper)};
    await withManifestBackup(process.argv[1],process.argv[2],async()=>{fs.writeFileSync(process.argv[1],'changed');process.exit(3);});`;
  const run=spawnSync(process.execPath,['--input-type=module','-e',source,files.manifest,files.backupDir],{encoding:'utf8'});
  assert.equal(run.status,3,run.stderr);
  assert.equal(fs.readFileSync(files.manifest,'utf8'),'owner manifest\n');
  assert.equal(fs.existsSync(path.join(files.backupDir,'active')),false);
});

test('six parallel confirmed hooks pass while the transition lock is held', async t => {
  const {dir}=fixture(t), state=path.join(dir,'confirmed.json');
  fs.writeFileSync(state,JSON.stringify({confirmed:true})); fs.mkdirSync(state+'.lock');
  const started=performance.now();
  const results=await Promise.all(Array.from({length:6},()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[new URL('../bench/world/arms/chrome-hook.mjs',import.meta.url).pathname,state,device]);
    let output=''; child.stdout.on('data',bytes=>output+=bytes); child.on('error',reject);
    child.on('close',code=>{try{assert.equal(code,0);resolve(JSON.parse(output));}catch(error){reject(error);}});
    child.stdin.end(JSON.stringify({hook_event_name:'PreToolUse',tool_name:'mcp__claude-in-chrome__computer',tool_input:{action:'left_click'}}));
  })));
  t.diagnostic(`Six parallel hook processes completed in ${(performance.now()-started).toFixed(1)} ms`);
  for(const result of results) assert.deepEqual(result,{});
  assert.equal(chrome.chromeDeviceHook({hook_event_name:'PreToolUse',tool_name:'mcp__claude-in-chrome__switch_browser'},state,device).continue,false);
});

test('Chrome confirmation retries for ten seconds without allowing task tools', t => {
  const {dir}=fixture(t), state=path.join(dir,'retry.json'); let time=1000;
  const gate=(event,name,response)=>chrome.chromeDeviceHook({hook_event_name:event,tool_name:'mcp__claude-in-chrome__'+name,
    tool_input:{deviceId:device},tool_use_id:'one',tool_response:response},state,device,{now:()=>time});
  gate('PreToolUse','select_browser');
  assert.equal(gate('PostToolUse','select_browser',[{deviceId:device,inUse:false}]).continue,undefined);
  time=6000; assert.equal(gate('PreToolUse','list_connected_browsers').continue,undefined);
  assert.match(gate('PostToolUse','list_connected_browsers',[]).hookSpecificOutput.additionalContext,/retry/i);
  time=10999; assert.equal(gate('PreToolUse','select_browser').continue,undefined);
  assert.equal(gate('PostToolUse','select_browser',[{deviceId:device,inUse:true}]).continue,undefined);
  assert.equal(JSON.parse(fs.readFileSync(state)).confirmed,true);
  fs.rmSync(state);
  time=1000; gate('PreToolUse','select_browser');
  gate('PostToolUseFailure','select_browser');
  time=11001;
  assert.equal(gate('PreToolUse','list_connected_browsers').continue,false);
  assert.notEqual(JSON.parse(fs.readFileSync(state)).confirmed,true);
});

test('a confirming selection result wins after ten seconds while new attempts still expire', t => {
  const {dir}=fixture(t), state=path.join(dir,'slow-confirm.json'); let time=1000;
  const input={tool_name:'mcp__claude-in-chrome__select_browser',tool_input:{deviceId:device},tool_use_id:'slow'};
  assert.deepEqual(chrome.chromeDeviceHook({...input,hook_event_name:'PreToolUse'},state,device,{now:()=>time}),{});
  time=15000;
  const result=chrome.chromeDeviceHook({...input,hook_event_name:'PostToolUse',tool_response:[{deviceId:device,inUse:true}]},state,device,{now:()=>time});
  assert.deepEqual(result,{});
  assert.equal(JSON.parse(fs.readFileSync(state)).confirmed,true);
  assert.deepEqual(chrome.chromeDeviceHook({hook_event_name:'PreToolUse',tool_name:'mcp__claude-in-chrome__computer'},state,device,{now:()=>time}),{});
  fs.rmSync(state);
  time=1000; chrome.chromeDeviceHook({...input,hook_event_name:'PreToolUse'},state,device,{now:()=>time});
  time=15000;
  assert.equal(chrome.chromeDeviceHook({...input,hook_event_name:'PostToolUse',tool_response:[{deviceId:device,inUse:false}]},state,device,{now:()=>time}).continue,undefined);
  assert.equal(chrome.chromeDeviceHook({...input,hook_event_name:'PreToolUse'},state,device,{now:()=>time}).continue,false);
});

test('stale manifest backup gives recovery instructions and preserves its bytes', async t => {
  const {files}=fixture(t), active=path.join(files.backupDir,'active'); fs.mkdirSync(active,{recursive:true});
  const original=path.join(active,'original.json'); fs.writeFileSync(original,'saved owner bytes');
  await assert.rejects(chrome.withManifestBackup(files.manifest,files.backupDir,()=>assert.fail('must refuse')),
    error=>error.message.includes(original)&&/restore|recover/i.test(error.message)&&/remove|rename/i.test(error.message));
  assert.equal(fs.readFileSync(original,'utf8'),'saved owner bytes');
  assert.equal(fs.readFileSync(files.manifest,'utf8'),'owner manifest\n');
});
