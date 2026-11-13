import { replWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createMacReplClient } from '../plugins/sleight/lib/repl/client.mjs';
import { createEvaluator } from '../plugins/sleight/lib/repl/worker.mjs';
import { runtimeHelperSource } from '../plugins/sleight/lib/repl/helpers.mjs';
import { fillForm } from '../plugins/sleight/lib/fill-form.mjs';
import { dragTo } from '../plugins/sleight/lib/drag-to.mjs';
import { pickFromList } from '../plugins/sleight/lib/pick-from-list.mjs';
import { listPicker } from '../plugins/sleight/lib/native-list-pick.mjs';
import { sameElement, windowFromText } from '../plugins/sleight/lib/document-scope.mjs';
import { FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { normalizeRuntimeCell } from '../plugins/sleight/lib/runtime-api.mjs';
import { runOwnRuntime } from '../plugins/sleight/lib/runtime-select.mjs';
import { formFixture, dragFixture, browserListFixture } from './fixtures/runtime-helpers.mjs';

const window = { windowId: '101', pid: 120, processStart: '1700000000:123456', bundleId: 'com.example.Editor',
  app: 'TextEdit', title: 'Draft', identityVerified: true, bounds: { x: 0, y: 0, width: 1000, height: 1000 } };
const tree = 'Window: "Draft", App: TextEdit.\n0 standard window Draft\n\t1 text field Name\n\t2 text field Email\n\t3 button Send';
const text = result => result.content.filter(row => row.type === 'text').map(row => row.text).join('\n');
const value = result => JSON.parse(result.content.findLast(row => row.type === 'text').text);
function session(t, { inspect = () => true, dispatch, state = () => tree } = {}) {
  let readId = 0;
  const sent = [], inspected = [];
  const driver = { async request(method, params) {
    sent.push({ method, params: structuredClone(params) });
    if (dispatch) return dispatch(method, params);
    return { window, text: state(), readId: ++readId, delivery: 'sent-unverified' };
  }, async restart() {}, async close() {} };
  const repl = createMacReplClient({ platform: 'darwin', driver, admit: async () => true,
    inspectHelperCall: inspect && (async proposal => { inspected.push(proposal); return inspect(proposal); }),
    environment: () => ({ LANE_FIXTURE: '1' }) });
  t.after(() => repl.close());
  const js = code => repl.execute({ code });
  const setup = async (fixture, args) => {
    const result = await js(`var app = await cua.getApp('TextEdit', {emit:false});
      var h = (${fixture.toString()})(${args}, app); void 0;`);
    assert.equal(result.isError, false, text(result));
  };
  return { js, setup, repl, sent, inspected };
}

test('Mac session installs all helpers, preserves them between cells and after reset', { skip: replWorkerSkip }, async t => {
  const h = session(t);
  const code = 'nodeRepl.write([typeof sleight.fillForm, typeof sleight.dragTo, typeof sleight.pickFromList]);';
  for (let i = 0; i < 2; i++) assert.deepEqual(value(await h.js(code)), ['function', 'function', 'function']);
  await h.repl.reset();
  assert.deepEqual(value(await h.js(code)), ['function', 'function', 'function']);
  assert.equal(h.sent.length, 0);
});

test('fillForm matches the engine helper on text, checkbox, radio, select, slider and switch', { skip: replWorkerSkip }, async t => {
  const specs = { Name: {}, Terms: { type: 'checkbox' }, Choice: { type: 'radio' }, Country: { tagName: 'SELECT' },
    Amount: { type: 'range', min: '0', max: '10', step: '2' }, Alerts: { role: 'switch', 'aria-checked': 'false' } };
  const fields = [{ label: 'Name', value: 'Ada' }, { label: 'Terms', value: true }, { label: 'Choice', value: true },
    { label: 'Country', value: 'UK' }, { label: 'Amount', value: 4 }, { label: 'Alerts', value: false }];
  const engine = formFixture(specs), expected = await fillForm(engine.tab, fields);
  const h = session(t); await h.setup(formFixture, JSON.stringify(specs));
  const result = await h.js(`var answer = await sleight.fillForm(h.tab, ${JSON.stringify(fields)}); nodeRepl.write({answer,calls:h.calls});`);
  assert.equal(result.isError, false, text(result));
  assert.deepEqual(value(result), { answer: expected, calls: engine.calls });
  assert.equal(h.inspected.length, 8);
  assert.equal(h.sent.filter(row => ['setValue', 'pressKey'].includes(row.method)).length, 8);
});

test('fillForm stops at a refused field without fallback input or filling later fields', { skip: replWorkerSkip }, async t => {
  const h = session(t, { inspect: proposal => proposal.params.args[0] !== 2 });
  await h.setup(formFixture, JSON.stringify({ Name: {}, Email: {}, Later: {} }));
  const result = await h.js('await sleight.fillForm(h.tab, [{label:"Name",value:"Ada"},{label:"Email",value:"private"},{label:"Later",value:"no"}]);');
  assert.equal(result.isError, true); assert.match(text(result), /1 fillForm.*stopped MAC_SAFETY_UNAVAILABLE[\s\S]*2 requests arrived[\s\S]*next=read-again/);
  assert.deepEqual(h.sent.filter(row => row.method === 'setValue').map(row => row.params.args), [[1, 'Ada']]);
  assert.equal(h.inspected.length, 2);
  assert.deepEqual(value(await h.js('nodeRepl.write(h.calls);')), [['Name', 'fill', 'Ada']]);
});

test('facade validation refusal is terminal even before a helper request reaches the parent', { skip: replWorkerSkip }, async t => {
  const h = session(t); await h.setup(formFixture, '{Name:{},Email:{}}');
  const result = await h.js('h.tab.playwright.getByLabel = name => ({count:async()=>1,evaluate:async()=>({tag:"input"}),fill:async()=>app.setValue(1, {})});' +
    'await sleight.fillForm(h.tab,[{label:"Name",value:"Ada"},{label:"Email",value:"later"}]);');
  assert.equal(result.isError, true); assert.match(text(result), /Use app.setValue/);
  assert.equal(h.inspected.length, 0); assert.deepEqual(h.sent.map(row => row.method), ['getApp']);
});

for (const [x, y] of [[320, 420], [320, 20], [600, 220], [20, 220], [600, 420], [20, 20]]) {
  test(`dragTo matches engine geometry and result from ${x},${y}`, { skip: replWorkerSkip }, async t => {
    const source = { x, y, width: 100, height: 40 }, target = { x: 320, y: 220, width: 100, height: 40 };
    const engine = dragFixture(source, target), expected = await dragTo(engine.tab, '#source', '#target');
    const h = session(t); await h.setup(dragFixture, `${JSON.stringify(source)},${JSON.stringify(target)}`);
    const result = await h.js('var answer = await sleight.dragTo(h.tab,"#source","#target"); nodeRepl.write({answer,calls:h.calls});');
    assert.equal(result.isError, false, text(result));
    assert.deepEqual(value(result), { answer: expected, calls: engine.calls });
    assert.equal(h.inspected.length, 1);
    assert.deepEqual(h.inspected[0].params.args, engine.calls[0]);
  });
}

test('dragTo stops at refused drag after its endpoint reads, with no readback or later input', { skip: replWorkerSkip }, async t => {
  const h = session(t, { inspect: () => false });
  await h.setup(dragFixture, '{x:20,y:400,width:100,height:40},{x:20,y:200,width:100,height:40}');
  const result = await h.js('await sleight.dragTo(h.tab,"#source","#target"); await app.click(3);');
  assert.equal(result.isError, true); assert.match(text(result), /1 dragTo.*stopped MAC_SAFETY_UNAVAILABLE[\s\S]*next=retry-safe/);
  assert.equal(h.inspected.length, 1); assert.deepEqual(h.sent.map(row => row.method), ['getApp']);
  assert.deepEqual(value(await h.js('nodeRepl.write(h.calls);')), []);
});

test('browser pickFromList matches engine selection and result', { skip: replWorkerSkip }, async t => {
  const names = ['London', 'Paris', 'Portland'];
  const engine = browserListFixture(names), expected = await pickFromList(engine.tab, '#list', 'Portland');
  const h = session(t); await h.setup(browserListFixture, JSON.stringify(names));
  const result = await h.js('var answer = await sleight.pickFromList(h.tab,"#list","Portland"); nodeRepl.write({answer,calls:h.calls});');
  assert.equal(result.isError, false, text(result));
  assert.deepEqual(value(result), { answer: expected, calls: engine.calls });
  assert.equal(h.inspected.length, 1);
});

test('browser picker cannot turn a refused canonical click into an unverified selection result', { skip: replWorkerSkip }, async t => {
  const h = session(t, { inspect: () => false });
  await h.setup(browserListFixture, '["London","Paris","Portland"]');
  const result = await h.js('await sleight.pickFromList(h.tab,"#list","Portland"); await app.click(1);');
  assert.equal(result.isError, true); assert.match(text(result), /1 pickFromList.*stopped MAC_SAFETY_UNAVAILABLE[\s\S]*next=retry-safe/);
  assert.equal(h.inspected.length, 1); assert.deepEqual(h.sent.map(row => row.method), ['getApp']);
});

function nativeModel() {
  const names = ['Port Alpha', 'Port Beta', 'Port Delta', 'Port Epsilon', 'Port Gamma', 'Port Zeta'];
  let selected, position = 0, readId = 0;
  const state = () => 'Window: "Draft", App: TextEdit.\n0 standard window Draft\n\t1 list Places\n' +
    names.slice(position, position + 3).map((name, i) => `\t\t${i + 2} text (${selected === name ? 'selected' : 'selectable'}) ${name}`).join('\n') +
    '\nThe focused UI element is 1 list Places';
  const actions = [];
  const request = async (method, params = {}) => {
    if (method === 'pressKey') { position = params.args[0] === 'Page_Down' ? 3 : 0; actions.push([method, ...params.args]); }
    if (method === 'click') { selected = names[position + params.args[0] - 2]; actions.push([method, ...params.args]); }
    return { window, text: state(), readId: ++readId, delivery: 'sent-unverified' };
  };
  return { state, request, actions };
}

test('native pickFromList matches engine picker inputs and results through the real session', { skip: replWorkerSkip }, async t => {
  const engine = nativeModel();
  const pick = listPicker({ read: async () => engine.state(), observe() {}, parse: windowFromText, sameElement,
    press: key => engine.request('pressKey', {args:[key]}),
    click: line => engine.request('click', {args:[Number([...engine.state().matchAll(/^\t*(\d+) (.*)$/gm)].find(row => row[2] === line)[1])]}),
  });
  const expected = await pick('Port Gamma');
  const native = nativeModel(), h = session(t, { dispatch: native.request });
  const acquired = await h.js('var app = await cua.getApp("TextEdit",{emit:false});');
  assert.equal(acquired.isError, false, text(acquired));
  const result = await h.js('nodeRepl.write(await app.pickFromList("Port Gamma"));');
  assert.equal(result.isError, false, text(result));
  assert.deepEqual(value(result), expected); assert.deepEqual(native.actions, engine.actions);
  assert.deepEqual(h.inspected.map(row => row.method), ['pressKey', 'click']);
  assert.ok(h.inspected.every(row => Number.isSafeInteger(row.params.readId)));
});

test('native picker stops after one admitted key when its final click is refused', { skip: replWorkerSkip }, async t => {
  const native = nativeModel(), h = session(t, { dispatch: native.request, inspect: proposal => proposal.method !== 'click' });
  await h.js('var app = await cua.getApp("TextEdit",{emit:false});');
  const result = await h.js('await app.pickFromList(1,"Port Gamma"); await app.pressKey("Return");');
  assert.equal(result.isError, true); assert.match(text(result), /1 pickFromList.*stopped MAC_SAFETY_UNAVAILABLE \[3 reads, 1 keys\][\s\S]*next=read-again/);
  assert.deepEqual(native.actions, [['pressKey', 'Page_Down']]);
  assert.equal(h.inspected.length, 2);
});

test('missing inspection refuses helper input, without weakening ordinary calls', { skip: replWorkerSkip }, async t => {
  const native = nativeModel(), h = session(t, { dispatch: native.request, inspect: null });
  await h.js('var app = await cua.getApp("TextEdit",{emit:false});');
  const refused = await h.js('await app.pickFromList("Port Gamma");');
  assert.equal(refused.isError, true); assert.match(text(refused), /Mac native access requires an active safety policy/);
  assert.equal(native.actions.length, 0);
  assert.equal((await h.js('await app.pressKey("Page_Down");')).isError, false);
  assert.equal(native.actions.length, 1);
});

test('every native paging key is separately inspected with its current read, and a refusal ends the burst', { skip: replWorkerSkip }, async t => {
  let position = 0, readId = 0, keys = 0, inspections = 0;
  const state = () => 'Window: "Draft", App: TextEdit.\n0 standard window Draft\n\t1 list Places\n' +
    Array.from({length:12}, (_, i) => `\t\t${i + 2} text (selectable) Port ${String(position + i).padStart(3,'0')}`).join('\n') +
    '\nThe focused UI element is 1 list Places';
  const h = session(t, { dispatch: async (method, params) => {
    if (method === 'pressKey') { assert.equal(params.readId, readId); keys++; position += 6; }
    return {window,text:state(),readId:++readId,delivery:'sent-unverified'};
  }, inspect: proposal => { inspections++; return inspections < 3; } });
  await h.js('var app = await cua.getApp("TextEdit",{emit:false});');
  const result = await h.js('await app.pickFromList("Port 100");');
  assert.equal(result.isError, true); assert.equal(keys, 2); assert.equal(inspections, 3);
  assert.deepEqual(h.inspected.map(row => row.method), ['pressKey','pressKey','pressKey']);
  for (let i = 1; i < h.inspected.length; i++) assert.ok(h.inspected[i].params.readId > h.inspected[i - 1].params.readId);
});

test('inspected canonical calls have exactly the arguments dispatched to the driver', { skip: replWorkerSkip }, async t => {
  const h = session(t);
  await h.setup(formFixture, '{Name:{},Email:{}}');
  const result = await h.js('await sleight.fillForm(h.tab,[{label:"Name",value:"Ada"},{label:"Email",value:"ada@example.com"}]);');
  assert.equal(result.isError, false, text(result));
  const actions = h.sent.filter(row => row.method === 'setValue');
  assert.equal(actions.length, 2);
  for (const [i, action] of actions.entries()) {
    const proposal = h.inspected[i];
    assert.equal(proposal.code, `await app.${action.method}(${action.params.args.map(JSON.stringify).join(', ')});`);
    assert.equal(normalizeRuntimeCell(proposal.code).code, proposal.code);
    assert.deepEqual(action.params, proposal.params);
    assert.throws(() => { proposal.params.args[1] = 'changed after inspection'; }, TypeError);
  }
});

test('reset during helper inspection prevents dispatch of the old action', { skip: replWorkerSkip }, async t => {
  let release;
  const native = nativeModel(), h = session(t, { dispatch:native.request,
    inspect:() => new Promise(resolve => { release = resolve; }) });
  await h.js('var app = await cua.getApp("TextEdit",{emit:false});');
  const pending = h.js('await app.pickFromList("Port Gamma");');
  for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve,5));
  assert.equal(typeof release, 'function');
  await h.repl.reset(); release(true);
  assert.match(text(await pending), /REPL_RESET/);
  const result = await h.js('nodeRepl.write(typeof app);');
  assert.equal(text(result), 'undefined'); assert.equal(native.actions.length, 0);
});

test('parent inspection sees exact typed values through the usual flow analyzer', { skip: replWorkerSkip }, async t => {
  const rules = new FlowRules({version:1,rules:[{id:'secret',kind:'pattern',pattern:'private value',destinations:['*']}]});
  // Use the same literal call analyzer as the relay, with a known source read.
  const h = session(t, { inspect: proposal => {
    const analyzed = rules.analyze('js', {code:proposal.code}, {app:'TextEdit',title:'Draft'});
    assert.equal(proposal.code, 'await app.setValue(1, "private value");');
    assert.ok(Object.isFrozen(proposal.params.args));
    assert.equal(analyzed.violations.length, 1); return analyzed.violations.length === 0;
  } });
  await h.setup(formFixture, '{Name:{}}');
  const result = await h.js('await sleight.fillForm(h.tab,[{label:"Name",value:"private value"}]);');
  assert.equal(result.isError, true); assert.equal(h.inspected.length, 1);
  assert.equal(h.sent.length, 1);
});

test('helper inspection does not replace direct admission, read ids or driver refusals', { skip: replWorkerSkip }, async t => {
  const sent = [];
  const h = session(t, { dispatch: async (method, params) => {
    sent.push(method);
    if (method === 'getApp') return {window,text:tree,readId:17};
    assert.equal(params.readId, 17);
    throw Object.assign(Error('LEASE_REFUSED'), {code:'LEASE_REFUSED',delivery:'not-sent',parentSafety:true});
  } });
  await h.setup(formFixture, '{Name:{},Email:{}}');
  const result = await h.js('await sleight.fillForm(h.tab,[{label:"Name",value:"Ada"},{label:"Email",value:"later"}]);');
  assert.equal(result.isError, true); assert.match(text(result), /lease|LEASE_REFUSED/i);
  assert.deepEqual(sent, ['getApp','setValue']); assert.equal(h.inspected.length, 1);
});

for (const code of ['STALE_READ', 'PAYMENT_REQUIRED', 'APP_DECLINED']) {
  test(`parent ${code} refusal stops fillForm after the same first successful field`, { skip: replWorkerSkip }, async t => {
    let actions = 0;
    const h = session(t, { dispatch: async (method, params) => {
      if (method === 'setValue' && ++actions === 2)
        throw Object.assign(Error(code), { code, parentSafety: true, delivery: 'not-sent' });
      return {window,text:tree,readId:actions + 1,delivery:'sent-unverified'};
    } });
    await h.setup(formFixture, '{Name:{},Email:{},Later:{}}');
    const result = await h.js('await sleight.fillForm(h.tab,[{label:"Name",value:"Ada"},{label:"Email",value:"stop"},{label:"Later",value:"no"}]);');
    assert.equal(result.isError, true); assert.match(text(result), new RegExp(code));
    assert.equal(actions, 2); assert.equal(h.inspected.length, 2);
    assert.deepEqual(value(await h.js('nodeRepl.write(h.calls);')), [['Name','fill','Ada']]);
  });
}

test('production relay owns helper inspection and refuses input without a registrar', { skip: replWorkerSkip }, async t => {
  const native = nativeModel(), sent = [], inspected = [];
  const driver = { async request(method, params) {
    sent.push(method);
    if (method === 'resolveApp') return {app:{id:window.bundleId,name:window.app,pid:window.pid,processStart:window.processStart},windows:[window]};
    if (method === 'verifyWindowIdentity') return {window};
    if (method === 'rendererRestore') return {restored:true,token:params.args[0].lease.token};
    assert.equal(method, 'getAXState');
    return native.request(method, params);
  }, async restart() {}, async close() {} };
  const input = new PassThrough(), output = new PassThrough(), pending = new Map();
  let next = 0, buffer = '';
  output.setEncoding('utf8').on('data', bytes => {
    buffer += bytes;
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0,end)); buffer = buffer.slice(end + 1);
      pending.get(message.id)?.(message.result); pending.delete(message.id);
    }
  });
  const runtime = await runOwnRuntime({input,output,signals:new EventEmitter(),driver,
    lease:{acquire:()=> 'fixture',renew(){},grant:()=>({token:'fixture'}),renewGrant(){},release(){},close(){}},
    policy:()=>({allow:true}),permissions:{app(){},page(){},sitesLimited:()=>false},
    targetParents: () => [1], ancestry:()=>[{pid:500,path:'/fixture/Host'}],allowForbidden:()=>false,ownHostPid:()=>false,
    ask:async()=> 'accept',approvalStorage:{load:()=>({}),live:()=>({list:()=>[],allows:()=>false})},grantAudit(){},
    replOptions:{environment:()=>({LANE_FIXTURE:'1'}),inspectHelperCall:proposal=>{inspected.push(proposal);return true;}},
    relayOptions:{idleTurnEndMs:0},
  });
  t.after(() => runtime.close());
  const js = code => new Promise(resolve => {
    const id = ++next; pending.set(id, resolve);
    input.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:'js',arguments:{code}}})+'\n');
  });
  assert.equal((await js('var app = await cua.getApp("TextEdit");')).isError, false);
  const result = await js('await app.pickFromList("Port Gamma");');
  assert.equal(result.isError, true, text(result));
  assert.match(text(result), /METHOD_NOT_FOUND|unavailable|not registered/i);
  assert.equal(inspected.length, 0); assert.equal(native.actions.length, 0);
  assert.ok(sent.every(method => !['click','pressKey','setValue','drag','scroll'].includes(method)));
});

test('helper preflight keeps canonical calls and helper source stays out of the inspected cell', t => {
  const code = 'await app.pickFromList(1,"Port Gamma"); await sleight.fillForm(tab,[]); await sleight.dragTo(tab,a,b);';
  assert.equal(normalizeRuntimeCell(code).code, code);
  assert.ok(runtimeHelperSource().length > 30000);
  t.diagnostic(`helper setup ${Buffer.byteLength(runtimeHelperSource())} UTF-8 bytes, once per Mac worker`);
});

test('Windows evaluator has no Mac helper setup', async t => {
  const evaluator = createEvaluator({platform:'win32',helperSource:runtimeHelperSource(),request:() => assert.fail('driver')});
  t.after(() => evaluator.close());
  assert.deepEqual(value(await evaluator.evaluate('nodeRepl.write(Object.keys(sleight));')), []);
});
