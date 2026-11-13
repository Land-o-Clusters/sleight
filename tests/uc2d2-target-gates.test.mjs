import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { fixture, productModule } from './fixtures/runtime-helper-inspection.mjs';
import { FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { guardedCode, windowFromText } from '../plugins/sleight/lib/document-scope.mjs';

const checkout = `Window: "Draft", App: TextEdit.
0 standard window Draft
\t1 HTML content Checkout, URL: https://shop.test/checkout
\t\t2 text field Card number
\t\t3 text Total $268.00
\t\t4 button (focused) Place order, ID: pay
The focused UI element is 4 button (focused) Place order, ID: pay`;
const cookies = checkout.replace('HTML content Checkout, URL: https://shop.test/checkout', 'dialog Cookie preferences').replace('text field Card number', 'text We use cookies')
  .replace('text Total $268.00', 'button Reject all').replaceAll('Place order', 'Accept all cookies');

async function paymentScenario(t, createSafety) {
  const h = await fixture(t, {createSafety}); h.setText(checkout); await h.acquire();
  for (const target of [4, {focused:true}, {id:'pay'}, {label:'Place order'}]) {
    await assert.rejects(h.safety.request('click',h.params([target]),h.context()), {code:'PAYMENT_REQUIRED'});
    assert.equal(h.actions().length, 0);
  }
  assert.equal(h.cards.length, 4);
}
test('UC2D2 checkout focused, ID and label targets reach the same payment card as line 4', t => paymentScenario(t));

test('UC2D2 each unresolved object refuses before policy or input', async t => {
  const h = await fixture(t); h.setText(checkout.replace('(focused)', '').replace(/^The focused.*$/m,'')); await h.acquire();
  for (const target of [{focused:true}, {id:'missing'}, {label:'missing'}])
    await assert.rejects(h.safety.request('click',h.params([target]),h.context()), {code:'STALE_READ'});
  assert.equal(h.actions().length,0); assert.equal(h.cards.length,0);
});

test('UC2D2 the cookie wall refuses the focused accept button like its number', async t => {
  const h = await fixture(t); h.setText(cookies); await h.acquire();
  const seen=[], policy=h.runtimePolicy.beforeAction;
  h.runtimePolicy.beforeAction=function(action,context) { seen.push(action.args[0]); return policy.call(this,action,context); };
  for (const target of [4, {focused:true}, {id:'pay'}, {label:'Accept all cookies'}])
    await assert.rejects(h.safety.request('click',h.params([target]),h.context()),{code:'IDENTITY_CHANGED'});
  assert.deepEqual(seen,[4,4,4,4]);
  assert.equal(h.actions().length,0); assert.equal(h.cards.length,0);
});

test('UC2D2 numbered policy targets retain the native focused selector and helper focus checks', async t => {
  const h = await fixture(t); h.setText(checkout.replace('HTML content Checkout, URL: https://shop.test/checkout', 'container Controls')
    .replace('text field Card number','text Ready').replace('text Total $268.00','text Status').replaceAll('Place order','Continue'));
  await h.acquire();
  const policy = h.runtimePolicy.beforeAction, seen = [];
  h.runtimePolicy.beforeAction = function(action, context) { seen.push(action.args[0]); return policy.call(this, action, context); };
  await h.safety.request('click',h.params([{focused:true}]),h.context());
  assert.deepEqual(seen, [4]);
  assert.deepEqual(h.actions()[0].params.args, [{focused:true}]);
});

test('UC2D2 own consent and authentication hosts refuse before target admission', async t => {
  for (const bundleId of ['com.apple.LocalAuthentication.UIAgent','com.apple.SecurityAgent','consent-host']) {
    const h = await fixture(t); h.patch({bundleId});
    await assert.rejects(h.acquire(), {code:'OWN_HOST_REFUSED'});
    assert.equal(h.actions().length,0);
  }
});

async function engine(tree, target, factory = guardedCode, payment = {setting:'requested',message:null}) {
  const sent = [], app = {getAXState:async()=>tree,click:async value=>sent.push(JSON.parse(JSON.stringify(value)))};
  const source = factory(`const app=await cua.getApp("TextEdit"); await app.click(${JSON.stringify(target)});`, windowFromText(tree), undefined, undefined, {careful:true,payment});
  let error;
  try { await runInNewContext(`(async()=>{${source}})()`,{cua:{getApp:async()=>app},nodeRepl:{write(){}}}); }
  catch (caught) { error = caught; }
  return {sent,error};
}
test('UC2D2 engine focused payment and cookie checks match numbered targets', async () => {
  for (const tree of [checkout,cookies]) for (const target of [4,{focused:true}]) {
    const result=await engine(tree,target); assert.ok(result.error); assert.deepEqual(result.sent,[]);
    assert.match(result.error.message, tree === checkout ? /payment/ : /Cookie acceptance blocked/);
  }
});

test('UC2D2 tests detect the original unresolved-policy hole', async t => {
  const broken=await productModule('mac-safety.mjs',source=>source.replace('const policyArgs = resolveMacPolicyTargets(method, admitted.args, read.text);','const policyArgs = admitted.args;'));
  await assert.rejects(paymentScenario(t,broken.createMacSafety), {code:'ERR_ASSERTION'});
});

test('UC2D2 engine focus resolution detects its own disabled-check mutation', async () => {
  const broken=await productModule('document-scope.mjs',source=>source.replace("args = [number, ...args.slice(1)];",'void number;'));
  const result=await engine(checkout,{focused:true},broken.guardedCode);
  assert.deepEqual(result.sent,[{focused:true}]); assert.equal(result.error,undefined);
});

test('UC2D2 flow analysis receives the resolved focused consequential target',async t=>{
  const flow=new FlowRules({version:1,rules:[]},{browsers:[]}), analyze=flow.analyze.bind(flow), seen=[];
  flow.analyze=(name,args,...rest)=>{seen.push(args.code); return analyze(name,args,...rest);};
  const h=await fixture(t,{relayOptions:{flowRules:flow}});
  const text=checkout.replace('HTML content Checkout, URL: https://shop.test/checkout','container Controls').replace('text field Card number','text Ready').replace('text Total $268.00','text Status').replaceAll('Place order','Confirm');
  h.setText(text); await h.acquire();
  await h.safety.request('click',h.params([{focused:true}]),h.context());
  assert.ok(seen.includes('await app.click(4);')); assert.ok(!seen.some(code=>code.includes('focused')));
  assert.equal(h.actions().length,1);
});
