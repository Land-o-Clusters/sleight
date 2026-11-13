import test from 'node:test';
import assert from 'node:assert/strict';
import { run, prepareInstalledStartup, turboState, createInstalledBrowserBridge } from '../plugins/sleight/lib/launch.mjs';
import { createV3Frontend } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { PassThrough } from 'node:stream';

test('relay startup waits for clipboard recovery before constructing runtime resources', async () => {
  const sentinel = Error('recovery remains unconfirmed'); let recovery = 0;
  await assert.rejects(run({ recoverClipboard: async () => { recovery++; throw sentinel; },
    healthHelperFactory: () => assert.fail('runtime must wait for recovery') }), error => error === sentinel);
  assert.equal(recovery, 1);
});

test('ordinary installed startup stays off without an operator setting', async () => {
  const value = await prepareInstalledStartup(() => null);
  assert.equal(value.directBrowser, undefined);
  assert.equal(value.directHost, undefined);
});
test('installed startup refuses a project supplied frontend or bridge', async () => {
  assert.throws(() => createV3Frontend({ browser: 'bfixture', call() {} }), /TRUSTED_ROUTE_REQUIRED/);
  const value=await prepareInstalledStartup(() => ({ browser: 'bfixture' }),()=>{});
  assert.equal(value.directBrowser,undefined);assert.equal(value.turboUnavailable,'TRUSTED_ROUTE_REQUIRED');
});
test('turbo discovery exposes only operator enablement and never receipt or profile data', () => {
  assert.deepEqual(turboState(() => null), { enabled: false });
  assert.deepEqual(turboState(() => ({ receipt: 'private', profileRoot: 'private', enabled: true })), { enabled: true });
  assert.deepEqual(turboState(() => { throw Error('unsafe'); }), { enabled: false });
});
test('SLEIGHT_TURBO=0 skips setup and the bridge and reports turbo off; other values change nothing', async () => {
  let ensured = 0, built = 0;
  const off = await prepareInstalledStartup(() => { built++; return null; }, () => {}, { ensure: () => { ensured++; }, env: { SLEIGHT_TURBO: '0' } });
  assert.deepEqual(off, { directBrowser: undefined, directHost: undefined });
  assert.equal(ensured, 0); assert.equal(built, 0);
  assert.deepEqual(turboState(() => ({ enabled: true }), { SLEIGHT_TURBO: '0' }), { enabled: false });
  for (const value of ['1', 'off', 'false', '', ' 0']) {
    await prepareInstalledStartup(() => { built++; return null; }, () => {}, { ensure: () => { ensured++; }, env: { SLEIGHT_TURBO: value } });
    assert.deepEqual(turboState(() => ({ enabled: true }), { SLEIGHT_TURBO: value }), { enabled: true });
  }
  assert.equal(ensured, 5); assert.equal(built, 5);
});
test('unavailable selected connection keeps the ordinary engine route with a typed notice', async () => {
  const notices = [];
  const value = await prepareInstalledStartup(() => { throw Error('SELECTED_ENDPOINT_UNPROVED'); }, code => notices.push(code));
  assert.equal(value.directBrowser, undefined); assert.deepEqual(notices, ['SELECTED_ENDPOINT_UNPROVED']);
});
test('launcher stderr names the engine route after v3 unavailability', async t => {
  const messages = []; t.mock.method(process.stderr, 'write', text => { messages.push(text); return true; });
  for (const code of ['V3_RUNTIME_UNAVAILABLE', 'V3_WORKER_UNAVAILABLE']) {
    const result = await prepareInstalledStartup(() => createInstalledBrowserBridge({ v3: async () => { throw Error(code); } }));
    assert.equal(result.directBrowser, undefined);
    assert.match(messages.pop(), /using the engine/);
  }
});
for(const code of ['HOST_PACKAGE_MISMATCH','HOST_SOURCE_MISMATCH','HOST_CACHE_UNSAFE','INSTALLED_CONFIG_UNSAFE','UNEXPECTED_FAILURE']) test('startup disables turbo and preserves working engine tools on '+code,async t=>{
  const notices=[],value=await prepareInstalledStartup(()=>{throw Error(code);},message=>notices.push(message));
  assert.equal(value.directBrowser,undefined);assert.equal(value.turboUnavailable,code);assert.deepEqual(notices,[code]);
  await assert.rejects(createInstalledBrowserBridge({v3:async()=>{throw Error(code);}}),new RegExp(code));
  const clientIn=new PassThrough(),clientOut=new PassThrough(),serverIn=new PassThrough(),serverOut=new PassThrough(),replies=[],sent=[];
  clientOut.on('data',bytes=>replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  serverIn.on('data',bytes=>sent.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay=createRelay({...value,clientIn,clientOut,serverIn,serverOut,changeReview:false});t.after(()=>relay.dispose());
  clientIn.write(JSON.stringify({id:1,method:'tools/list'})+'\n');
  serverOut.write(JSON.stringify({id:1,result:{tools:[{name:'js',description:'engine',inputSchema:{type:'object'}}]}})+'\n');
  assert.ok(replies.find(x=>x.id===1).result.tools.some(tool=>tool.name==='js'));
  clientIn.write(JSON.stringify({id:2,method:'tools/call',params:{name:'js',arguments:{code:'nodeRepl.write("engine available")'}}})+'\n');
  assert.ok(sent.some(x=>x.id===2));serverOut.write(JSON.stringify({id:2,result:{content:[{type:'text',text:'engine available'}]}})+'\n');
  assert.match(JSON.stringify(replies.find(x=>x.id===2)),/engine available/);
  clientIn.write(JSON.stringify({id:3,method:'tools/call',params:{name:'browser_tabs',arguments:{do:'list'}}})+'\n');
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(JSON.stringify(replies.find(x=>x.id===3)),/Turbo is off.*engine browser path/);
  assert.ok(!sent.some(x=>x.id===3));
});

test('turbo startup fault reaches Claude once on the first engine browser result', async t => {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough(), replies = [];
  clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, turboUnavailable: 'HOST_SOURCE_MISMATCH', changeReview: false });
  t.after(() => relay.dispose());
  for (const [id, code] of [[1, 'nodeRepl.write("native-free computation")'], [2, 'const b = await cua.getBrowser()'], [3, 'await b.tabs.list()']]) {
    clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code } } }) + '\n');
    serverOut.write(JSON.stringify({ id, result: { content: [{ type: 'text', text: 'engine result' }],
      ...(id === 1 ? {} : { _meta: { 'codex/toolSurface': { kind: 'browserUse' } } }) } }) + '\n');
  }
  await new Promise(resolve => setImmediate(resolve));
  const notice = id => replies.find(row => row.id === id).result.content.filter(item => /Tell the user: Turbo is off/.test(item.text ?? ''));
  assert.equal(notice(1).length, 0);
  assert.equal(notice(2).length, 1);
  assert.match(notice(2)[0].text, /HOST_SOURCE_MISMATCH.*engine browser path/);
  assert.equal(notice(3).length, 0);
});

test('the first failed browser read still carries the startup notice once', async t => {
  const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough(), replies = [];
  clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, turboUnavailable: 'HOST_SOURCE_MISMATCH', changeReview: false });
  t.after(() => relay.dispose());
  for (const id of [1, 2]) {
    clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'js', arguments: { code: 'await tab.getAXState()' } } }) + '\n');
    serverOut.write(JSON.stringify({ id, result: { isError: true, content: [{ type: 'text', text: 'read unavailable' }],
      _meta: { 'codex/toolSurface': { kind: 'browserUse' } } } }) + '\n');
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies.filter(row => row.result?.content?.some(item => /Tell the user: Turbo is off/.test(item.text ?? ''))).length, 1);
});
