import { replWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, registrar, runFixtureRuntime, productModule } from './fixtures/runtime-helper-inspection.mjs';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

test('safe helper step is inspected and dispatched on distinct fresh parent reads', async t => {
  const h = await fixture(t);
  await h.step();
  assert.equal(h.actions().length, 1);
  const methods = h.requests.map(row => row.method);
  assert.deepEqual(methods.slice(-7), ['verifyWindowIdentity','getAXState','personState','verifyWindowIdentity','getAXState','personState','click']);
});

test('without an ID1 capability helper and direct input refuse before the driver', async t => {
  const h = await fixture(t, { noRegistrar: true });
  const before = h.requests.length;
  await assert.rejects(h.step(), { code: 'METHOD_NOT_FOUND' });
  await assert.rejects(h.safety.request('click', h.params(), h.context()), { code: 'METHOD_NOT_FOUND' });
  assert.equal(h.requests.length, before);
  assert.deepEqual(h.actions(), []);
});

import { helperInspection, validateHelperInspection } from '../plugins/sleight/lib/repl/helpers.mjs';
import { createSessionPause, PAUSED_NOTE } from '../plugins/sleight/lib/session-pause.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { createWindowsSafety } from '../plugins/sleight/lib/windows-driver/safety.mjs';
import { fakeWindows } from './fixtures/windows-driver-fake.mjs';
import { FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { createMacReplClient } from '../plugins/sleight/lib/repl/client.mjs';
import { formFixture } from './fixtures/runtime-helpers.mjs';
import { initial, tree, resultText } from './fixtures/runtime-helper-inspection.mjs';

const actions = h => h.actions().map(row => [row.method, ...row.params.args]);
const denied = async (h, operation, code, expected = []) => {
  await assert.rejects(operation, error => { assert.equal(error.code, code); return true; });
  assert.deepEqual(actions(h), expected);
};
const paymentTree = () => tree('\n\t4 HTML content Checkout, URL: https://shop.test/checkout\n\t\t5 text field Card number\n\t\t6 button Pay now\n\t\t7 text Total $25.00').replace('The focused UI element is 1 text field Name','The focused UI element is 5 text field Card number');
const unseenTree = (body = 'text (selectable) Port Omega') => tree('\n' + Array.from({length:409},(_,i)=>`\t${i+4} ${i===408?body:'text Spacer '+i}`).join('\n'));
async function worker(t, inspectHelperCall, dispatch) {
  let readId = 0;
  const sent = [];
  const driver = { async request(method, params) {
    sent.push({ method, params: structuredClone(params) });
    if (dispatch) { const reply = await dispatch(method, params); if (reply) return reply; }
    return { window: initial, text: tree(), readId: ++readId, delivery: 'sent-unverified' };
  }, async restart() {}, async close() {} };
  const repl = createMacReplClient({ platform: 'darwin', driver, admit: () => true, inspectHelperCall,
    environment: () => ({ LANE_FIXTURE: '1' }) });
  t.after(() => repl.close());
  const js = code => repl.execute({ code });
  assert.equal((await js(`var app = await cua.getApp('TextEdit', {emit:false}); var h = (${formFixture.toString()})({Name:{},Email:{},Later:{}}, app); void 0;`)).isError, false);
  return { repl, js, sent, actions: () => sent.filter(row => row.method !== 'getApp') };
}

const cases = [
  ['payment after page change and once bound to one read', async (t, variant) => {
    const h = await fixture(t, { request(method, params, { text }) {
      if (method === 'setValue') {
        const [number, value] = params.args;
        h.setText(text.replace(new RegExp(`(\\t${number} text field \\(settable\\) Description: [^,\\n]+, Value:)[^\\n]*`),
          (_line, label) => `${label} ${value}`));
      }
    } });
    // E2 requires the fresh field to show the helper's exact write. The old
    // fake left Name unchanged, so the second setValue correctly went stale.
    h.setText(tree().replaceAll('text field Name', 'text field (settable) Description: Name, Value:')
      .replace('text field Email', 'text field (settable) Description: Email, Value:'));
    await h.acquire();
    await h.step('setValue', [1, 'Ada']); await h.step('setValue', [2, 'a@example.test']);
    const deliverPaymentRead = async target => {
      target.setText(paymentTree());
      const reply = await target.acquire();
      await target.deliverAcquisition(reply);
      return reply.readId;
    };
    h.nextCell();
    await deliverPaymentRead(h);
    h.nextCell();
    mutate(h, variant);
    await denied(h, h.inspect(helperInspection('fillForm','pressKey',h.params(['Return']))), 'PAYMENT_REQUIRED', [['setValue',1,'Ada'],['setValue',2,'a@example.test']]);
    assert.equal(h.cards.length, 1);
    const once = await fixture(t, { paymentChoice: 'once' });
    once.nextCell();
    const firstRead = await deliverPaymentRead(once);
    once.nextCell();
    mutate(once, variant);
    const proposal = helperInspection('fillForm','pressKey',once.params(['Return']));
    assert.equal(proposal.params.readId, firstRead);
    assert.equal(await once.inspect(proposal), true);
    assert.equal(await once.inspect(proposal), true);
    assert.equal(once.cards.length, 1, 'rechecking the same worker read reuses its once card');
    // Retain helper state here to prove read binding independently of cell
    // cleanup. A cached read id must not reuse the first read's allowance.
    const nextRead = await deliverPaymentRead(once);
    assert.notEqual(nextRead, firstRead);
    assert.equal(await once.inspect(helperInspection('fillForm','pressKey',once.params(['Return']))), true);
    assert.equal(once.cards.length, 2, 'a new delivered read requires its own card');
    assert.deepEqual(actions(once), []);
  }],
  ['later step names a second acquired window', async (t, variant) => {
    const h = await fixture(t); await h.step();
    h.patch({windowId:'102'}); h.setText(tree()); await h.acquire();
    mutate(h, variant);
    await denied(h,h.inspect(helperInspection('fillForm','click',h.params())), 'IDENTITY_CHANGED',[['click',3]]);
    await denied(h, h.step(), 'IDENTITY_CHANGED', [['click',3]]);
  }],
  ['retitle URL and replaced identity refuse', async (t, variant) => {
    for (const patch of [{title:'Unseen title'}, {url:'https://other.test'}, {pid:121}]) {
      const h = await fixture(t); await h.step('pressKey',['Home']);
      h.patch(patch); if (patch.title) h.setText(tree('',{...initial,...patch}));
      if (patch.url) h.setText(tree().replace('\n\t1 ', ', URL: https://other.test\n\t1 '));
      mutate(h, variant);
      await denied(h,h.inspect(helperInspection('fillForm','pressKey',h.params(['Home']))),'IDENTITY_CHANGED',[['pressKey','Home']]);
      await denied(h,h.step('pressKey',['Home']),'IDENTITY_CHANGED',[['pressKey','Home']]);
    }
  }],
  ['unseen numbered row stays stale after internal read', async (t, variant) => {
    const h = await fixture(t); await h.step('pressKey',['Page_Down']);
    h.setText(unseenTree());
    await h.safety.request('getAXState', {windowId:initial.windowId,processStart:initial.processStart}, h.context()).then(h.context().observe);
    mutate(h,variant);
    await denied(h,h.inspect(helperInspection('fillForm','click',h.params([412]))),'STALE_READ',[['pressKey','Page_Down']]);
    await denied(h,h.step('click',[412]),'STALE_READ',[['pressKey','Page_Down']]);
  }],
  ['old worker read id cannot address earlier numbers', async t => {
    const h = await fixture(t), old = h.params().readId;
    await h.step();
    await denied(h,h.step('click',[3],{readId:old}),'STALE_READ',[['click',3]]);
  }],
  ['new menu sheet dialog or alert stops next step', async t => {
    for (const role of ['menu','sheet','dialog','alert']) {
      const h = await fixture(t); await h.step('pressKey',['Home']);
      h.setText(tree(`\n\t4 ${role} Unseen surface`));
      await denied(h,h.step('pressKey',['Home']),'IDENTITY_CHANGED',[['pressKey','Home']]);
    }
    const h = await fixture(t); h.setText(tree('\n\t4 menu Places')); await h.acquire();
    await h.step('pressKey',['Page_Down']); await h.step('pressKey',['Page_Up']);
    assert.deepEqual(actions(h),[['pressKey','Page_Down'],['pressKey','Page_Up']]);
  }],
  ['thrown inspector is terminal and suppresses fill fallback', async t => {
    const h = await worker(t, () => { throw Error('unseen private value'); });
    const result = await h.js('await sleight.fillForm(h.tab,[{label:"Name",value:"Ada"},{label:"Email",value:"later"}]);');
    assert.equal(result.isError,true); assert.match(resultText(result),/MAC_SAFETY_UNAVAILABLE/);
    assert.doesNotMatch(resultText(result),/unseen private value/); assert.deepEqual(h.actions(),[]);
  }],
  ['every truthy non-true inspector result refuses', async t => {
    for (const answer of [1,'true',{}, {then:undefined},undefined]) {
      const h = await worker(t,()=>answer);
      const result = await h.js('await sleight.fillForm(h.tab,[{label:"Name",value:"Ada"}]);');
      assert.equal(result.isError,true); assert.match(resultText(result),/active safety policy/); assert.deepEqual(h.actions(),[]);
    }
  }],
  ['cached helper inspection cannot authorize changed parent state', async (t,variant) => {
    const h = await fixture(t); await h.step('pressKey',['Home']);
    h.patch({title:'Other'}); h.setText(tree('',{...initial,title:'Other'}));
    mutate(h,variant);
    await denied(h,h.inspect(helperInspection('fillForm','pressKey',h.params(['Home']))),'IDENTITY_CHANGED',[['pressKey','Home']]);
    await denied(h,h.step('pressKey',['Home']),'IDENTITY_CHANGED',[['pressKey','Home']]);
  }],
  ['revoke and once decline between steps prevent dispatch', async t => {
    const h = await fixture(t); await h.step(); await h.safety.revoke([initial.bundleId]);
    await denied(h,h.step(),'APP_NOT_ACQUIRED',[['click',3]]);
    let approvals = 0;
    const once = await fixture(t,{approvalScope:'once',approve:()=>++approvals<4});
    await once.step();
    await denied(once,once.step(),'APP_DECLINED',[['click',3]]);
    assert.equal(approvals,4);
  }],
  ['protected host and settings window refuse before lease input', async (t,variant) => {
    let protectedPid = false;
    const h = await fixture(t,{ownHostPid:()=>protectedPid}); protectedPid = true;
    mutate(h,variant);
    await denied(h,h.inspect(helperInspection('fillForm','click',h.params())),'OWN_HOST_REFUSED');
    await denied(h,h.step(),'OWN_HOST_REFUSED');
    const settingsCalls = [];
    await assert.rejects(fixture(t, { window: { title: 'Settings', bundleId: 'com.openai.chat' },
      request(method) { settingsCalls.push(method); } }), { code: 'FORBIDDEN_SETTINGS' });
    assert.deepEqual(settingsCalls, ['resolveApp']);
  }],
  ['clipboard steps refuse with no write request', async (t,variant) => {
    for (const [method,args] of [['paste',['private']],['pressKey',['cmd+c']],['pressKey',['cmd+x']],
      ['pressKey',['cmd+v']],['pressKey',['shift+Insert']],['performSecondaryAction',[3,'Copy']],['performSecondaryAction',[3,'Cut']]]) {
      const h = await fixture(t); mutate(h,variant);
      // CB1H rejects Copy/Cut secondary actions at retained-number admission,
      // before the relay policy. The other forms reach HL1's clipboard rule.
      const code = method === 'performSecondaryAction' ? 'ACTION_UNSUPPORTED' : 'CLIPBOARD_CHANGED';
      const before = h.requests.length;
      const refuse = async operation => {
        await assert.rejects(operation, { code, delivery: 'not-sent', retry: 'safe',
          ...method === 'performSecondaryAction' ? { clipboard: 'untouched' } : {} });
        assert.deepEqual(actions(h), []);
        if (method === 'performSecondaryAction') assert.equal(h.requests.length, before);
      };
      await refuse(h.inspect(helperInspection('fillForm',method,h.params(args))));
      await refuse(h.step(method,args));
      // Dispatch must refuse too, even without a helper inspection or tag.
      await refuse(h.safety.request(method,h.params(args),h.context()));
    }
  }],
  ['helper keeps first person token across keys and later steps', async (t,variant) => {
    let human = false, firstToken;
    const h = await fixture(t,{ request(method,params) {
      if (method === 'personState') { const token = human ? 'new-person' : 'start-person'; firstToken ??= token;
        return {window:initial,token,personTookOver:false}; }
      if (method === 'pressKey' && human && params.personToken === firstToken)
        throw Object.assign(Error('PERSON_TOOK_OVER'),{code:'PERSON_TOOK_OVER',delivery:'not-sent'});
    }});
    await h.step('pressKey',['Home']); human = true; mutate(h,variant);
    await denied(h,h.step('pressKey',['End']),'PERSON_TOOK_OVER',[['pressKey','Home'],['pressKey','End']]);
    // The request log records the refused native boundary too. It has no delivered input.
    assert.equal(h.actions().at(-1).params.personToken,'start-person');
  }],
  ['second helper name in one cell refuses', async (t,variant) => {
    const h = await fixture(t); await h.step('pressKey',['Home'],{},'fillForm'); mutate(h,variant);
    await denied(h,h.step('pressKey',['End'],{},'pickFromList'),'HELPER_CONFLICT',[['pressKey','Home']]);
  }],
  ['second cell refuses while first cell is pending', async t => {
    let enter,release;
    const entered = new Promise(resolve=>{enter=resolve;});
    const h = await worker(t,()=>{enter();return new Promise(resolve=>{release=resolve;});});
    const first = h.js('await sleight.fillForm(h.tab,[{label:"Name",value:"Ada"}]);');
    await entered;
    const result = await h.js('await app.click(3);');
    assert.equal(result.isError,true); assert.match(resultText(result),/REPL_BUSY/);
    assert.deepEqual(h.actions(),[]); release(true); assert.equal((await first).isError,false);
    assert.deepEqual(h.actions().map(row=>row.method),['setValue']);
    const parent = await fixture(t), forwarded = [];
    parent.streams[2].on('data', bytes => forwarded.push(JSON.parse(bytes)));
    const request = id => parent.streams[0].write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',
      params:{name:'js',arguments:{code:'await app.pressKey("Home");'}}})+'\n');
    request(100);
    const refused = new Promise(resolve=>parent.streams[1].once('data',bytes=>resolve(JSON.parse(bytes))));
    request(101);
    // Give either the relay refusal or the broken forwarding path one event turn.
    const reply = await Promise.race([refused,new Promise(resolve=>setImmediate(()=>resolve(undefined)))]);
    assert.equal(forwarded.length,1,'second cell must not reach the runtime server');
    assert.equal(reply?.id,101); assert.equal(reply.result.isError,true);
    assert.match(resultText(reply.result),/another call in this session is pending\./);
    assert.deepEqual(actions(parent),[]);
  }],
  ['untagged actions get payment stale host and clipboard checks', async (t,variant) => {
    for (const [method,args,code,setup] of [
      ['pressKey',['Return'],'PAYMENT_REQUIRED',h=>h.setText(paymentTree())],
      ['click',[412],'STALE_READ',()=>{}],
      ['pressKey',['cmd+c'],'CLIPBOARD_CHANGED',()=>{}],
    ]) {
      const h = await fixture(t); setup(h); mutate(h,variant);
      await denied(h,h.safety.request(method,h.params(args),h.context()),code);
    }
    let protectedPid=false;
    const h = await fixture(t,{ownHostPid:()=>protectedPid}); protectedPid=true; mutate(h,variant);
    await denied(h,h.safety.request('click',h.params(),h.context()),'OWN_HOST_REFUSED');
  }],
  ['forged valid tag only adds the helper restrictions', async t => {
    const h = await fixture(t); await h.step();
    h.setText(paymentTree());
    await denied(h,h.step('pressKey',['Return'],{},'fillForm'),'PAYMENT_REQUIRED',[['click',3]]);
    assert.equal(h.cards.length,1);
  }],
  ['unknown helper and non-array args refuse before inspection', async t => {
    const h = await fixture(t);
    for (const proposal of [helperInspection('reorder','click',h.params()),
      {helper:'fillForm',method:'click',params:Object.freeze({...h.params(),args:{target:3}}),code:'await app.click(3);'}])
      await denied(h,h.inspect(proposal),'INVALID_PARAMS');
  }],
  ['canonical check refuses selectors string numbers prototypes and getters', async t => {
    const h = await fixture(t);
    for (const target of [{id:'x'},{label:'Pay'},'3']) {
      // The code agrees with the literal proposal. Only its target is invalid.
      const proposal = helperInspection('fillForm','click',h.params([target]));
      assert.throws(() => validateHelperInspection(proposal), {code:'INVALID_PARAMS'});
      await denied(h,h.inspect(proposal),'INVALID_PARAMS');
    }
    for (const target of [Object.create({id:'x'}),{get id(){throw Error('getter ran');}}]) {
      const params = Object.freeze({...h.params(),args:Object.freeze([target])});
      const proposal = Object.freeze({helper:'fillForm',method:'click',params,code:'await app.click(3);'});
      await denied(h,h.inspect(proposal),'INVALID_PARAMS');
    }
  }],
  ['split typing is analyzed as accumulated text', async (t,variant) => {
    const rules = new FlowRules({version:1,rules:[{id:'secret',kind:'pattern',pattern:'private',destinations:['*']}]});
    const h = await fixture(t,{relayOptions:{flowRules:rules}}); await h.step('click',[1]);
    for (const part of ['p','r','i','v','a','t']) await h.step('typeText',[part]);
    mutate(h,variant,rules);
    await denied(h,h.step('typeText',['e']),'FLOW_RULE_REFUSED', [['click',1],...['p','r','i','v','a','t'].map(p=>['typeText',p])]);
  }],
  ['worker supplied clean tree cannot hide parent payment', async (t,variant) => {
    const h = await fixture(t); h.setText(paymentTree()); mutate(h,variant);
    const proposal = {...helperInspection('fillForm','pressKey',h.params(['Return'])),text:tree(),latestText:tree()};
    await denied(h,h.inspect(Object.freeze(proposal)),'PAYMENT_REQUIRED'); assert.equal(h.cards.length,1);
  }],
  ['reset or turn end while inspector awaits prevents old dispatch', async (t,variant) => {
    for (const end of ['reset','endTurn']) {
      let release,enter; const entered=new Promise(resolve=>{enter=resolve;});
      const h = await fixture(t,{paymentChoice:'once'}); h.setText(paymentTree());
      h.runtimePolicy.inspectHelperStep = new Proxy(h.runtimePolicy.inspectHelperStep,{async apply(fn,self,args){
        enter(); await new Promise(resolve=>{release=resolve;}); return Reflect.apply(fn,self,args);
      }});
      mutate(h,variant);
      const operation=h.step('pressKey',['Return']); const caught=operation.catch(error=>error);
      await entered; await h.safety[end](); release();
      assert.equal((await caught).code,'REPL_CELL_ENDED'); assert.deepEqual(actions(h),[]);
    }
  }],
  ['caught helper refusal permits a separately checked direct action', async t => {
    const h = await worker(t,()=>false);
    const result = await h.js('try { await sleight.fillForm(h.tab,[{label:"Name",value:"Ada"}]); } catch {} await app.click(3);');
    assert.match(resultText(result),/1 fillForm\(1,"Ada"\) stopped MAC_SAFETY_UNAVAILABLE/);
    assert.match(resultText(result),/2 click\(3\) sent-unverified/);
    assert.match(resultText(result),/next=read-again: effects may have occurred/);
    assert.deepEqual(h.actions().map(row=>[row.method,...row.params.args]),[['click',3]]);
  }],
  ['an inspection cannot authorize different args for the same request', async t => {
    const h = await fixture(t), params=h.params([3]), context={...h.context(),cell:1,messageId:70,helper:'fillForm'};
    assert.equal(await h.safety.inspectHelperCall(helperInspection('fillForm','click',params),context),true);
    await denied(h,h.safety.request('click',{...params,args:[1]},context),'INVALID_PARAMS');
    await denied(h,h.runtimePolicy.inspectHelperStep(helperInspection('fillForm','click',{...params,windowId:'102'}),
      {window:initial,text:tree(),before:tree(),readId:params.readId,cell:1,personToken:'fake',isActive:()=>true}),'IDENTITY_CHANGED');
  }],
  ['pause between helper steps refuses the next input on Mac and Windows', async t => {
    for (const platform of ['Mac','Windows']) for (const resume of [false,true]) {
      await t.test(`${platform}, resume=${resume}`, async t => {
        const pause=createSessionPause();
        const h=platform==='Mac' ? await fixture(t,{relayOptions:{pause}}) : await windowsPauseFixture(t,pause);
        await h.step('pressKey',['Home']);
        pause.set(true); if (resume) pause.set(false);
        await assert.rejects(h.step('pressKey',['End']),{code:'PAUSED',message:PAUSED_NOTE,delivery:'not-sent'});
        assert.deepEqual(actions(h),[['pressKey','Home']]);
      });
    }
  }],
];

async function windowsPauseFixture(t,pause,createSafety=createWindowsSafety) {
  const window=structuredClone(fakeWindows[0]), requests=[];
  let readId=0, runtimePolicy, cell=1;
  const text=`Window: "${window.title}", App: ${window.app}.\n0 standard window ${window.title}\n\t1 text field Name`;
  const driver={async request(method,params){
    requests.push({method,params:structuredClone(params)});
    if(method==='getState') return {windows:[window]};
    if(method==='verifyWindowIdentity') return {window};
    return {window,text,readId:++readId,delivery:'sent-unverified'};
  }};
  const streams=Array.from({length:4},()=>new PassThrough()); streams.forEach(s=>s.resume());
  const relay=createRelay({clientIn:streams[0],clientOut:streams[1],serverIn:streams[2],serverOut:streams[3],
    nativeWindows:true,nativeSession:{setPolicy(value){runtimePolicy=value;}},pause,idleTurnEndMs:0,changeReview:false});
  const safety=createSafety({driver,approve:()=>true,lease:{acquire:()=> 'lease',renew(){},release(){},close(){}}});
  safety.setPolicy(runtimePolicy);
  t.after(async()=>{safety.close();await relay.close();streams.forEach(s=>s.destroy());});
  await safety.request('getApp',{selector:window.app},{cell});
  return {safety,runtimePolicy,requests,actions:()=>requests.filter(r=>r.method==='pressKey'),
    nextCell(){safety.finishCell(cell);cell++;},
    step(method,args){return safety.request(method,{windowId:window.windowId,processStart:window.processStart,readId,args},{cell});}};
}

for (const platform of ['Mac', 'Windows']) test(`${platform} dispatcher refuses a policy without a callable pause check`, async t => {
  const h = platform === 'Mac' ? await fixture(t) : await windowsPauseFixture(t, createSessionPause());
  for (const checkPause of [undefined, null, true]) await t.test(String(checkPause), async () => {
    h.safety.setPolicy({ ...h.runtimePolicy, checkPause });
    const before = h.requests.length;
    await assert.rejects(h.step('pressKey', ['Home']), {
      code: platform === 'Mac' ? 'MAC_SAFETY_UNAVAILABLE' : 'WINDOWS_SAFETY_UNAVAILABLE',
    });
    assert.equal(h.requests.length, before, 'a missing pause check must refuse before driver access');
    assert.deepEqual(actions(h), []);
  });
});

async function bindingCase(t,kind,options={}) {
  const h=await fixture(t,{...options,request(method,params){
    if(params.windowId===initial.windowId){
      if(method==='verifyWindowIdentity') return {window:initial};
      if(method==='getAXState') return {window:initial,text:tree(),readId:500};
      if(method==='pressKey') return {window:initial,text:tree(),readId:501,delivery:'sent-unverified'};
    }
  }});
  if(kind==='never-acquired') {
    // Use a key step, so retained element checks cannot hide a wrong binding.
    await denied(h,h.step('pressKey',['Home'],{windowId:'999',readId:500},'fillForm',
      {beforeRequest:undefined}),'APP_NOT_ACQUIRED');
    return;
  }
  h.patch({windowId:'102',title:'Other'});h.setText(tree('',{...initial,title:'Other'}));
  await h.deliverAcquisition(await h.acquire());
  const p={windowId:initial.windowId,processStart:initial.processStart,readId:500};
  await h.step('pressKey',['Home'],p,'fillForm',{beforeRequest:undefined});
  assert.deepEqual(h.actions().map(r=>r.params.windowId),['101']);
  assert.deepEqual(h.requests.filter(r=>['verifyWindowIdentity','getAXState'].includes(r.method)).slice(-4)
    .map(r=>r.params.windowId),['101','101','101','101']);
}
for(const kind of ['never-acquired','acquired-with-other-leaseWindow'])
  test(`product binding: ${kind}`,t=>bindingCase(t,kind));

test('product binding changed to leaseWindow fails both binding cases',async t=>{
  // The bad dispatcher reads the actual relay closure's leaseWindow. Its
  // public title/app shape has no native id, so the bad lookup chooses the
  // acquired entry by that title instead of the proposal's windowId.
  const {createRelay}=await productModule('relay.mjs',s=>s.replace('    async inspectHelperStep(proposal, context) {',
    '    bindingWindow() { return leaseWindow; },\n    async inspectHelperStep(proposal, context) {'));
  const {createMacSafety}=await productModule('mac-safety.mjs',s=>s.replace('entry = acquired.get(params.windowId);',
    'entry = [...acquired.values()].find(candidate => candidate.window.title === runtimePolicy.bindingWindow()?.title);'));
  for(const kind of ['never-acquired','acquired-with-other-leaseWindow']) await t.test(kind,async t=>{
    await assert.rejects(()=>bindingCase(t,kind,{createSafety:createMacSafety,createRelay}),error=>{
      assert.equal(error.code,kind==='never-acquired'?'ERR_ASSERTION':'IDENTITY_CHANGED');
      t.diagnostic(`product acquired binding from relay leaseWindow: ${kind}: ${error.code}, ${error.message.split('\n')[0]}`);
      return true;
    });
  });
});

async function dispatchCase(t,kind,options={}) {
  let takeover=false;
  const rules=new FlowRules({version:1,rules:[{id:'secret',kind:'pattern',pattern:'private',destinations:['*']}]});
  const h=await fixture(t,{...options,relayOptions:{flowRules:rules},request(method){
    if(method==='personState' && takeover) return {window:initial,token:'person-takeover',personTookOver:true};
  }});
  h.safety.inspectHelperCall=async()=>true;
  await h.step('pressKey',['Home']);
  let method='pressKey',args=['End'],helper='fillForm',code;
  if(kind==='identity'){h.patch({title:'Other'});h.setText(tree('',{...initial,title:'Other'}));code='IDENTITY_CHANGED';}
  if(kind==='flow'){method='typeText';args=['private'];code='FLOW_RULE_REFUSED';}
  if(kind==='helper-conflict'){helper='pickFromList';code='HELPER_CONFLICT';}
  if(kind==='person'){takeover=true;code='PERSON_TOOK_OVER';}
  await denied(h,h.step(method,args,{},helper),code,[['pressKey','Home']]);
}
for(const kind of ['identity','flow','helper-conflict','person'])
  test(`dispatch alone refuses ${kind} with inspection true`,t=>dispatchCase(t,kind));

for(const kind of ['identity','flow','helper-conflict','person'])
  test(`dispatch assertion fails when product ${kind} check is deleted`,async t=>{
    const safety=kind==='person';
    const module=await productModule(safety?'mac-safety.mjs':'relay.mjs',s=>{
      if(kind==='identity') return s.replace(/if \(!sameWindow\(expected, target\)\) stop\('IDENTITY_CHANGED',[\s\S]*?\);/,'')
        .replace('expected, undefined, undefined, { careful: true, payment,','target, undefined, undefined, { careful: true, payment,');
      if(kind==='person') return s.replace("if (typeof person?.token !== 'string' || !person.token ||\n              person.personTookOver !== false && !(person.personTookOver === true &&\n                person.reason === 'person-active')) fail('PERSON_TOOK_OVER');",'');
      if(kind==='flow') return s.replace('if (plan?.violations.length && !permitted) {','if (false) {');
      return s.replace("if (helper && prior?.helper && helper !== prior.helper) stop('HELPER_CONFLICT');",'');
    });
    await assert.rejects(()=>dispatchCase(t,kind,safety?{createSafety:module.createMacSafety}:{createRelay:module.createRelay}),error=>{
      assert.equal(error.code,'ERR_ASSERTION');
      t.diagnostic(`dispatch ${kind} product check deleted: ${error.message.split('\n')[0]}`);return true;
    });
  });

for(const kind of ['selector','string-number']) test(`case 19 catches deleted ${kind} validation in product`,async t=>{
  const {validateHelperInspection:broken}=await productModule('repl/helpers.mjs',s=>kind==='selector'
    ? s.replace("if (!['typeText', 'paste', 'pressKey'].includes(method) && !target(args[0]) || method === 'drag' && !target(args[1])) invalid();",'')
    : s.replace('const { method, args } = normalizeMacAction(proposal.method, proposal.params.args);',
      'const { method } = normalizeMacAction(proposal.method, proposal.params.args); const args = proposal.params.args;')
      .replace('Number.isSafeInteger(value) && value >= 0 ||',"typeof value === 'string' && /^\\d+$/.test(value) || Number.isSafeInteger(value) && value >= 0 ||"));
  const target=kind==='selector'?{id:'x'}:'3';
  const proposal=helperInspection('fillForm','click',{windowId:'101',processStart:initial.processStart,readId:1,args:[target]});
  assert.throws(()=>validateHelperInspection(proposal),{code:'INVALID_PARAMS'});
  assert.equal(broken(proposal),true,'otherwise-correct code reaches the deleted target check');
  assert.throws(()=>assert.throws(()=>broken(proposal),{code:'INVALID_PARAMS'}),{code:'ERR_ASSERTION'});
  t.diagnostic(`${kind} product validation deleted: case 19 assertion fails with Missing expected exception`);
});

test('a paused helper keeps the existing user notice through the worker and stops fallback',{ skip: replWorkerSkip }, async t=>{
  const pause=createSessionPause(), h=await fixture(t,{relayOptions:{pause}});
  const w=await worker(t,proposal=>h.inspect(proposal)); pause.set(true);
  const result=await w.js('await sleight.fillForm(h.tab,[{label:"Name",value:"Ada"},{label:"Email",value:"later"}]);');
  assert.equal(result.isError,true); assert.ok(resultText(result).includes(PAUSED_NOTE),resultText(result));
  assert.match(resultText(result),/fillForm stopped \(PAUSED\)/);
  assert.deepEqual(w.actions(),[]); assert.deepEqual(actions(h),[]);
});

test('an outer cell paused and resumed before its first helper input stays cancelled',async t=>{
  const pause=createSessionPause(),h=await fixture(t,{relayOptions:{pause}});
  const forwarded=new Promise(resolve=>h.streams[2].once('data',resolve));
  h.streams[0].write(JSON.stringify({jsonrpc:'2.0',id:'pending-native-cell',method:'tools/call',
    params:{name:'js',arguments:{code:'await app.pressKey("Home");'}}})+'\n');
  await forwarded;pause.set(true);pause.set(false);
  await denied(h,h.step('pressKey',['End']),'PAUSED');
});

async function dispatchPauseCase(t,platform,createSafety) {
  const pause=createSessionPause();
  const h=platform==='Mac'?await fixture(t,{relayOptions:{pause},createSafety}):await windowsPauseFixture(t,pause,createSafety);
  await h.step('pressKey',['Home']);
  // Return a valid policy verdict and then pause at the await boundary. Only
  // the dispatcher's final check can stop the native request in this case.
  const before=h.runtimePolicy.beforeAction;
  h.runtimePolicy.beforeAction=async function(...args){
    const answer=await before.apply(this,args); pause.set(true); pause.set(false); return answer;
  };
  if(platform==='Mac') h.safety.inspectHelperCall=async()=>true;
  await assert.rejects(h.step('pressKey',['End']),{code:'PAUSED',message:PAUSED_NOTE,delivery:'not-sent'});
  assert.deepEqual(actions(h),[['pressKey','Home']]);
}
for(const platform of ['Mac','Windows']) {
  test(`pause during ${platform} dispatch policy wait refuses native input`,t=>dispatchPauseCase(t,platform));
  test(`pause assertion fails when ${platform} product final checkpoint is deleted`,async t=>{
    const module=await productModule(platform==='Mac'?'mac-safety.mjs':'windows-driver/safety.mjs',s=>
      s.replace(platform==='Mac'?'runtimePolicy.checkPause(context.cell);':'policy.checkPause(context.cell);',''));
    await assert.rejects(()=>dispatchPauseCase(t,platform,module[platform==='Mac'?'createMacSafety':'createWindowsSafety']),error=>{
      assert.equal(error.code,'ERR_ASSERTION');
      t.diagnostic(`${platform} final product pause check deleted: ${error.message.split('\n')[0]}`);return true;
    });
  });
}

for(const platform of ['Mac','Windows']) test(`cell end discards the ${platform} pause checkpoint after resume`,async t=>{
  const pause=createSessionPause();
  const h=platform==='Mac'?await fixture(t,{relayOptions:{pause}}):await windowsPauseFixture(t,pause);
  await h.step('pressKey',['Home']);pause.set(true);pause.set(false);
  await assert.rejects(h.step('pressKey',['End']),{code:'PAUSED'});
  await h.nextCell();await h.step('pressKey',['End']);
  assert.deepEqual(actions(h),[['pressKey','Home'],['pressKey','End']]);
});

// Broken variants act only on the fake's policy, driver or delivery boundary.
// The same case assertions run unchanged; no product file is patched.
function mutate(h, variant, rules) {
  if (!variant) return;
  if (variant === 1) h.inspect=async()=>true;
  if (variant === 2) {
    const cache=new Map([['fillForm',true]]),inspect=h.inspect;
    h.inspect=async proposal=>cache.has(proposal.helper)?cache.get(proposal.helper):
      (cache.set(proposal.helper,await inspect(proposal)),cache.get(proposal.helper));
  }
  if (variant === 3) {
    const original=h.snapshots.findLast(row=>row.window.windowId==='101');
    h.inspect=proposal=>h.runtimePolicy.inspectHelperStep(helperInspection(proposal.helper,proposal.method,
      {...proposal.params,windowId:'101',readId:original.readId}),
      {window:original.window,text:original.text,before:original.text,readId:original.readId,personToken:'fake',cell:1,isActive:()=>true});
  }
  if (variant === 4) {
    const inspect=h.runtimePolicy.inspectHelperStep;
    h.runtimePolicy.inspectHelperStep=(proposal,context)=>inspect.call(h.runtimePolicy,proposal,{...context,isActive:()=>true});
    // A broken fake dispatcher also ignores its liveness callback after await.
    h.safety.reset=()=>{}; h.safety.endTurn=()=>{};
  }
  if (variant === 5) {
    const request=h.safety.request;
    h.safety.request=(method,params,context)=>context.helper===undefined
      ? h.driver.request(method,params):request.call(h.safety,method,params,context);
  }
  if (variant === 6) {
    const last=h.snapshots.at(-1); h.reads.endCell([{type:'text',text:last.text}],[last]);
  }
  if (variant === 7) {
    const before=h.runtimePolicy.beforeAction;
    h.runtimePolicy.beforeAction=(action,context)=>['paste','pressKey','performSecondaryAction'].includes(action.method)
      ? {args:action.args,personToken:action.personToken}:before.call(h.runtimePolicy,action,context);
  }
  if (variant === 8) {
    const request=h.driver.request; h.driver.request=(method,params)=>request(method,{...params,personToken:'new-person'});
  }
  if (variant === 9) { const analyze=rules.analyze; rules.analyze=function(...args){this.tails.clear();return analyze.apply(this,args);}; }
  if (variant === 10) {
    let read; const inspect=h.runtimePolicy.inspectHelperStep;
    h.runtimePolicy.inspectHelperStep=(proposal,context)=>{
      read??=proposal.params.readId;
      return inspect.call(h.runtimePolicy,helperInspection(proposal.helper,proposal.method,{...proposal.params,readId:read}),{...context,readId:read});
    };
  }
  if (variant === 11) {
    const before=h.runtimePolicy.beforeAction;
    h.runtimePolicy.beforeAction=(action,context)=>before.call(h.runtimePolicy,{...action,helper:'fillForm'},context);
  }
  if (variant === 12) {
    const inspect=h.inspect; h.inspect=async(...args)=>{try{return await inspect(...args);}catch(error){throw Object.assign(Error(error.message+' PRIVATE-MARKER'),{code:error.code});}};
  }
}

for (const [index,[name,run]] of cases.entries()) test(`case ${String(index+1).padStart(2,'0')}: ${name}`,
  { skip: [7, 8, 15, 23].includes(index + 1) && replWorkerSkip }, t=>run(t));

async function privateRefusal(t,variant) {
  const h=await fixture(t); h.setText(unseenTree('text field Value: PRIVATE-MARKER'));
  await h.safety.request('getAXState',{windowId:initial.windowId,processStart:initial.processStart},h.context()).then(h.context().observe);
  mutate(h,variant);
  await assert.rejects(h.inspect(helperInspection('fillForm','click',h.params([412]))),error=>{
    assert.equal(error.code,'STALE_READ'); assert.doesNotMatch(error.message,/PRIVATE-MARKER|Value:/); return true;
  }); assert.deepEqual(actions(h),[]);
}
test('refusal text contains only a canonical code and fixed notice',t=>privateRefusal(t));

const variants = [[1,[1,4,11,12,21]],[2,[1,3,9]],[3,[2]],[4,[22]],[5,[16]],[6,[4]],
  [7,[12]],[8,[13]],[9,[20]],[10,[1]],[11,[14]],[12,[0]]];
for (const [variant,numbers] of variants) test(`broken variant ${variant} is caught on cases ${numbers.join(',')}`,async t=>{
  for (const number of numbers) {
    const run=number===0?privateRefusal:cases[number-1][1];
    await assert.rejects(()=>run(t,variant),error=>{
      assert.equal(error.code,'ERR_ASSERTION', 'the case must fail its behavioral assertion');
      t.diagnostic(`variant ${variant}, case ${number||'private-refusal'}: caught (${error.message.split('\n')[0]})`);
      return true;
    });
  }
});


test('relay runtime wiring admits seen picker input and refuses a row paged into view', { skip: replWorkerSkip }, async t => {
  let readId=0, position=0, selected;
  const requests=[];
  const names=['Port Alpha','Port Beta','Port Delta','Port Epsilon','Port Gamma','Port Zeta'];
  const state=()=> 'Window: "Draft", App: TextEdit.\n0 standard window Draft\n\t1 list Places\n'+
    names.slice(position,position+3).map((name,i)=>`\t\t${i+2} text (${selected===name?'selected':'selectable'}) ${name}`).join('\n')+
    '\nThe focused UI element is 1 list Places';
  const driver={async request(method,params){
    requests.push({method,params:structuredClone(params)});
    if(method==='resolveApp') return {app:{id:initial.bundleId,name:initial.app,pid:initial.pid,processStart:initial.processStart},windows:[initial]};
    if(method==='verifyWindowIdentity') return {window:initial};
    if(method==='personState') return {window:initial,token:'start-person',personTookOver:false};
    if(method==='rendererRestore') return {restored:true,token:params.args[0].lease.token};
    if(method==='pressKey') position=params.args[0]==='Page_Down'?3:0;
    if(method==='click') selected=names[position+params.args[0]-2];
    return {window:initial,text:state(),readId:++readId,delivery:'sent-unverified'};
  },async close(){},async restart(){}};
  const input=new PassThrough(),output=new PassThrough(),pending=new Map(); let next=0,buffer='';
  output.setEncoding('utf8').on('data',bytes=>{buffer+=bytes;for(let end;(end=buffer.indexOf('\n'))>=0;){
    const message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);pending.get(message.id)?.(message.result);pending.delete(message.id);
  }});
  const runtime=await runFixtureRuntime({input,output,signals:new EventEmitter(),driver,inputRegistrar:registrar(driver),
    lease:{acquire:()=> 'fixture',renew(){},grant:()=>({token:'fixture'}),renewGrant(){},release(){},close(){}},
    policy:()=>({allow:true}),permissions:{app(){},page(){},sitesLimited:()=>false},
    targetParents: () => [1], ancestry:()=>[{pid:500,path:'/fixture/host'}],allowForbidden:()=>false,ownHostPid:()=>false,
    ask:async()=> 'accept',approvalStorage:{load:()=>({}),live:()=>({list:()=>[],allows:()=>false})},grantAudit(){},
    replOptions:{environment:()=>({LANE_FIXTURE:'1'})},relayOptions:{idleTurnEndMs:0},
  });
  t.after(()=>runtime.close());
  const js=code=>new Promise(resolve=>{const id=++next;pending.set(id,resolve);input.write(JSON.stringify({jsonrpc:'2.0',id,
    method:'tools/call',params:{name:'js',arguments:{code}}})+'\n');});
  assert.equal((await js('var app = await cua.getApp("TextEdit");')).isError,false);
  const seen=await js('nodeRepl.write(await app.pickFromList("Port Beta"));');
  assert.equal(seen.isError,false,resultText(seen));
  assert.deepEqual(requests.filter(row=>row.method==='click').map(row=>row.params.args),[[3]]);
  const unseen=await js('await app.pickFromList("Port Gamma");');
  assert.equal(unseen.isError,true,resultText(unseen));
  assert.match(resultText(unseen),/STALE_READ/);
  assert.match(resultText(unseen),/pickFromList stopped .*\[\d+ reads, \d+ keys\]/);
  assert.deepEqual(requests.filter(row=>['click','pressKey'].includes(row.method)).map(row=>[row.method,...row.params.args]),
    [['click',3],['pressKey','Page_Down']]);
});

test('a page change after successful inspection is checked again before dispatch', async t => {
  const h = await fixture(t), inspect = h.runtimePolicy.inspectHelperStep;
  h.runtimePolicy.inspectHelperStep = async function (...args) {
    const allowed = await inspect.apply(this, args);
    h.setText(paymentTree());
    return allowed;
  };
  await denied(h, h.step('pressKey', ['Return']), 'PAYMENT_REQUIRED');
  assert.equal(h.cards.length, 1);
  assert.equal(h.requests.filter(row => row.method === 'getAXState').length, 3);
});

test('a once card decision admits its inspected payment step and spends the allowance', async t => {
  const h = await fixture(t, { paymentChoice: 'once' }); h.setText(paymentTree());
  await h.step('pressKey', ['Return']);
  assert.equal(h.cards.length, 1);
  assert.deepEqual(actions(h), [['pressKey','Return']]);
  await h.step('pressKey', ['Return']);
  assert.equal(h.cards.length, 2);
  assert.deepEqual(actions(h), [['pressKey','Return'],['pressKey','Return']]);
});

test('cell end clears the helper binding and permits another helper in a later cell', async t => {
  const h = await fixture(t);
  await h.step('pressKey', ['Home'], {}, 'fillForm'); h.nextCell();
  await h.step('pressKey', ['End'], {}, 'pickFromList');
  assert.deepEqual(actions(h), [['pressKey','Home'],['pressKey','End']]);
});

test('the same card answer cannot grant a second payment step', async t => {
  const answer = Promise.resolve('once');
  const h = await fixture(t, { relayOptions: { paymentCard: { ask: () => answer } } });
  h.setText(paymentTree());
  await h.step('pressKey', ['Return']);
  await denied(h, h.step('pressKey', ['Return']), 'PAYMENT_REQUIRED', [['pressKey','Return']]);
});
