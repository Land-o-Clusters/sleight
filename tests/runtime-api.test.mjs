import { replWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { MAC_JS_DESCRIPTION, normalizeRuntimeCell } from '../plugins/sleight/lib/runtime-api.mjs';
import { MAC_API_FIXES, normalizeMacAction, apiMisuse } from '../plugins/sleight/lib/repl/arguments.mjs';
import { createEvaluator } from '../plugins/sleight/lib/repl/worker.mjs';
import { createMacReplClient } from '../plugins/sleight/lib/repl/client.mjs';
import { createOwnRuntime, runOwnRuntime, normalizeRuntimeLine, OWN_RUNTIME_TOOLS, ownConfirmationPolicy } from '../plugins/sleight/lib/runtime-select.mjs';
import { MAC_REPL_DOCS } from '../plugins/sleight/lib/repl/docs.mjs';
import { FlowRules, calls } from '../plugins/sleight/lib/flow-rules.mjs';
import { createCua } from '../plugins/sleight/lib/repl/cua.mjs';
import { MAC_HANDLE_LINE } from '../plugins/sleight/lib/repl/cua.mjs';

const window = { windowId: '101', pid: 120, processStart: '1700000000:123456', bundleId: 'com.example.Editor',
  app: 'TextEdit', title: 'Draft', identityVerified: true, bounds: { x: 20, y: 30, width: 800, height: 600 } };
const tree = 'Window: "Draft", App: TextEdit.\n0 standard window Draft\n\t1 text field Name, ID: name';
const text = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');

test('UC2D focused targets are accepted only on click, setValue and selectText', () => {
  for (const [method, args] of [['click', [{ focused: true }]], ['setValue', [{ focused: true }, 'draft']],
    ['selectText', [{ focused: true }, 'draft']]]) assert.deepEqual(normalizeMacAction(method, args), { method, args });
  for (const [method, args] of [['rightClick', [{ focused: true }]], ['doubleClick', [{ focused: true }]],
    ['performSecondaryAction', [{ focused: true }, 'press']], ['drag', [{ focused: true }, 1]],
    ['click', [{ focused: 1 }]], ['click', [{ focused: true, id: 'field' }]]])
    assert.throws(() => normalizeMacAction(method, args), { code: 'SLEIGHT_API_MISUSE' });
});
function fake() {
  let readId = 0;
  const requests = [];
  return { requests, driver: {
    async request(method, params) {
      requests.push({ method, params });
      if (method === 'resolveApp') return { app: {id:window.bundleId,name:window.app,pid:window.pid,
        processStart:window.processStart,running:true}, windows:[window] };
      if (method === 'verifyWindowIdentity') return {window};
      if (method === 'rendererRestore') return { restored: true, token: params.args[0].lease.token };
      if (method === 'getState') return { apps: [], windows: [window] };
      if (method === 'getScreenshot') return { window, screenshot: { data: 'iVBORw0KGgo=', mimeType: 'image/png' } };
      return { window, text: tree, readId: ++readId, ...(method === 'getAXStateAndScreenshot' ?
        { screenshot: { data: 'iVBORw0KGgo=', mimeType: 'image/png' } } : {}) };
    }, async close() {}, async restart() {},
  } };
}

test('runtime description has nine API lines within the cut, and all runtime notices are pinned', t => {
  assert.equal(OWN_RUNTIME_TOOLS[0].description, MAC_JS_DESCRIPTION);
  assert.ok(MAC_JS_DESCRIPTION.length <= 2048);
  for (const name of ['getApp', 'read', 'click', 'setValue', 'type', 'key', 'scroll', 'drag', 'screenshot'])
    assert.equal(MAC_JS_DESCRIPTION.split('\n').filter(line => line.startsWith(name + ':')).length, 1);
  assert.doesNotMatch(MAC_JS_DESCRIPTION, /menu\(|choose\(|prepareSaveAs|saveAs\(/);
  const pins = JSON.parse(readFileSync(new URL('./fixtures/prompt-default.json', import.meta.url)));
  assert.equal(createHash('sha256').update(JSON.stringify(MAC_API_FIXES)).digest('hex'), pins.runtimeApiFixes);
  t.diagnostic(`description ${MAC_JS_DESCRIPTION.length} characters; ${Object.keys(MAC_API_FIXES).length} fix lines`);
});

const synonyms = [
  ['read()', 'getAXState', []], ['screenshot()', 'getScreenshot', []],
  ['type("draft")', 'typeText', ['draft']], ['key("super+s")', 'pressKey', ['super+s']],
  ['press("Return")', 'pressKey', ['Return']], ['rightClick(38)', 'rightClick', [38]],
  ['doubleClick(38)', 'doubleClick', [38]], ['click("38")', 'click', ['38']],
  ['click(38,{button:"right"})', 'click', [38, { mouseButton: 'right' }]],
  ['click(38,{button:"r"})', 'click', [38, { mouseButton: 'right' }]],
  ['click(38,{button:"left"})', 'click', [38, { mouseButton: 'left' }]],
  ['click(38,{button:"middle"})', 'click', [38, { mouseButton: 'middle' }]],
  ['click(38,{button:"l"})', 'click', [38, { mouseButton: 'left' }]],
  ['click(38,{button:"m"})', 'click', [38, { mouseButton: 'middle' }]],
  ['rightClick({x:100,y:200})', 'rightClick', [[100, 200]]],
];
for (const [code, method, args] of synonyms) test(`synonym app.${code} reaches canonical ${method}`, async t => {
  const f = fake(), evaluator = createEvaluator({ platform: 'darwin', request: f.driver.request });
  t.after(() => evaluator.close());
  await evaluator.evaluate('let app = await cua.getApp("TextEdit");');
  const result = await evaluator.evaluate(normalizeRuntimeCell(`await app.${code}; void 0;`).code);
  assert.equal(result.isError, false, text(result));
  assert.equal(f.requests.at(-1).method, method);
  if (args.length) assert.deepEqual(structuredClone(f.requests.at(-1).params.args), args);
  const checked = normalizeRuntimeCell(`await app.${code};`);
  assert.equal(checked.fix, undefined);
  assert.ok(checked.code.includes('.' + method + '('));
});

const misuses = [
  ['target', 'app.click({id:2})'], ['click', 'app.click(1,{button:"left",mouseButton:"right"})'],
  ['doubleClick', 'app.doubleClick(1,{at:"word"})'], ['rightClick', 'app.rightClick(1,{clickCount:2})'],
  ['setValue', 'app.setValue(1,{text:"draft"})'], ['typeText', 'app.typeText(null,"draft")'],
  ['pressKey', 'app.pressKey(1,"super+s")'], ['scroll', 'app.scroll(1,"down",0)'],
  ['drag', 'app.drag(1)'], ['selectText', 'app.selectText(1,2)'],
  ['performSecondaryAction', 'app.performSecondaryAction(1,"")'], ['paste', 'app.paste(1,"draft")'],
  ['getAXState', 'app.read({depth:65})'], ['getScreenshot', 'app.screenshot({format:"gif"})'],
  ['getApp', 'cua.getApp(42)'], ['listWindows', 'cua.listWindows({app:"TextEdit"})'],
  ['method', 'app.nonexistent(1)'],
];
for (const [kind, code] of misuses) test(`one-line ${kind} fix refuses the whole cell before dispatch`, async t => {
  const f = fake(), client = createMacReplClient({ platform: 'darwin', driver: f.driver, admit: async () => true,
    spawn() { assert.fail('misuse must not spawn a worker'); } });
  t.after(() => client.close());
  const source = kind === 'javascript' ? code : 'await app.click(1); await ' + code + ';';
  const result = await client.execute({ code: source });
  assert.equal(result.isError, true);
  assert.equal(text(result), apiMisuse(kind).message);
  assert.equal(text(result).split('\n').length, 1);
  assert.equal(f.requests.length, 0);
});

test('numeric and button normalization preserves bounds and rejects conflicting or unknown options', () => {
  for (const target of [-1, 1.5, NaN, Infinity, {label:''}, {id:2}])
    assert.throws(() => normalizeMacAction('click', [target]), /Operation not sent/);
  for (const options of [{button:'no'}, {button:2}, {clickCount:NaN}, {clickCount:1.5}, {clickCount:4},
    {mouseButton:'right',approval:true}, {button:'right',mouseButton:'left'}])
    assert.throws(() => normalizeMacAction('click', [38, options]), /Operation not sent/);
  assert.deepEqual(normalizeMacAction('click', ['38',{button:'right',mouseButton:'right'}]).args,
    ['38',{mouseButton:'right'}]);
  const unchanged = 'const data = {readValue(){}}; data.readValue(); nodeRepl.write("app.type(1)");';
  assert.equal(normalizeRuntimeCell(unchanged).code, unchanged);
});

test('synonyms keep approval, identity, stale-number and confirmation refusals', async t => {
  for (const code of ['app.rightClick("38")', 'app.doubleClick(38)', 'app.click("38",{button:"right"})',
    'app.type("draft")', 'app.press("Return")', 'app.key("super+s")']) {
    for (const refusal of ['APPROVAL_REQUIRED', 'IDENTITY_CHANGED', 'STALE_READ', 'CONFIRM_REQUIRED']) {
      const f = fake(); let admitted = 0;
      const evaluator = createEvaluator({ platform: 'darwin', request: async (method, params) => {
        if (method === 'getApp') return f.driver.request(method, params);
        admitted++; throw Object.assign(Error(refusal), { code: refusal, delivery: 'not-sent', retry: 'safe' });
      } });
      try {
        await evaluator.evaluate('let app = await cua.getApp("TextEdit");');
        const result = await evaluator.evaluate(normalizeRuntimeCell('await ' + code).code);
        assert.equal(result.isError, true); assert.match(text(result), new RegExp(refusal));
        assert.equal(admitted, 1); assert.equal(f.requests.length, 1);
      } finally { evaluator.close(); }
    }
  }
});

test('target-free pressKey after click keeps the same binding and current read', async t => {
  const f = fake(), evaluator = createEvaluator({ platform: 'darwin', request: f.driver.request });
  t.after(() => evaluator.close());
  const result = await evaluator.evaluate('let app = await cua.getApp("TextEdit"); await app.click("38"); await app.pressKey("Return");');
  assert.equal(result.isError, false, text(result));
  assert.deepEqual(f.requests.map(row => row.method), ['getApp', 'click', 'pressKey']);
  assert.deepEqual(f.requests.at(-1).params, {windowId:'101',processStart:window.processStart,readId:2,args:['Return']});
});

test('fourth session misuse appends the reference once, across worker resets', { skip: replWorkerSkip }, async t => {
  const f = fake(), client = createMacReplClient({ platform: 'darwin', driver: f.driver });
  t.after(() => client.close());
  for (let i = 1; i <= 6; i++) {
    if (i === 3) await client.reset();
    const result = await client.execute({ code: 'await app.typeText(2,"draft");' });
    assert.equal(result.content.length, i === 4 ? 2 : 1);
    assert.equal(result.content.some(row => row.text === MAC_REPL_DOCS), i === 4);
  }
  assert.equal(f.requests.length, 0);
});

test('runtime first result stays below the rti1 preview on the same fixture', { skip: replWorkerSkip }, async t => {
  const results = [], wire = [];
  for (const fullDocumentation of [false, true]) {
    const f = fake(), runtime = createOwnRuntime({ driver:f.driver, approve:async()=>true,
      policy: () => ({allow:true}), allowForbidden:()=>true, targetParents: () => [1], ancestry:()=>[{pid:500,path:'/fixture/Host'}],
      permissions:{app(){},page(){},sitesLimited:()=>false},
      lease: { acquire:()=> 'fixture', grant:()=>({token:'fixture-token'}), renewGrant(){}, renew(){}, release(){}, close(){} },
      replOptions:{ fullDocumentation } });
    t.after(() => runtime.close());
    const pending = new Map();
    runtime.serverOut.on('data', bytes => { for (const line of String(bytes).trim().split('\n')) {
      const message = JSON.parse(line); pending.get(message.id)?.(message);
    } });
    let id = 0;
    const js = async code => {
      const current = ++id, reply = new Promise(resolve=>pending.set(current,resolve));
      runtime.serverIn.write(JSON.stringify({jsonrpc:'2.0',id:current,method:'tools/call',params:{name:'js',arguments:{code}}})+'\n');
      const message = await reply; runtime.safety.guardResult(message);
      return runtime.safety.displayResult(current,message.result);
    };
    const first = await js('let app = await cua.getApp("TextEdit");');
    assert.equal(first.isError, false, text(first));
    assert.equal(first.content.filter(item=>item.text?.startsWith('# Driving Mac apps')).length, 0);
    assert.equal(first.content.filter(item=>item.text===ownConfirmationPolicy(undefined, f.driver)).length, 1);
    assert.equal(first.content.some(item=>item.text===MAC_REPL_DOCS), fullDocumentation);
    assert.ok(text(first).includes(tree)); assert.ok(text(first).includes(MAC_HANDLE_LINE));
    const second = await js('await app.getAXState();');
    assert.doesNotMatch(text(second), /# Driving Mac apps|### Inventory|# sleight confirmations policy/);
    assert.match(text(await js('await cua.rewriteDocumentation(); void 0;')), /### Inventory/);
    results.push(Buffer.byteLength(text(first)));
    wire.push(Buffer.byteLength(JSON.stringify({jsonrpc:'2.0',id:1,result:first})+'\n'));
  }
  assert.equal(results[1]-results[0], Buffer.byteLength(MAC_REPL_DOCS)+1);
  // Base rti1 b68e4009, measured with this window/tree and the production runtime.
  const base = { text: 5083, wire: 5667 };
  assert.ok(results[0] <= base.text); assert.ok(wire[0] <= base.wire);
  t.diagnostic(`rti1 preview text ${base.text}, wire ${base.wire}; candidate text ${results[0]}, wire ${wire[0]}`);
  t.diagnostic(`first result UTF-8 text bytes: full ${results[1]}, compact ${results[0]}, removed ${results[1]-results[0]}`);
  t.diagnostic(`first result JSON-RPC line bytes: full ${wire[1]}, compact ${wire[0]}, removed ${wire[1]-wire[0]}`);
});

test('recorded VF1 cells run against fake replies or return a fix before any request', async t => {
  const corpus = JSON.parse(readFileSync(new URL('./fixtures/runtime-api-replay.json',import.meta.url)));
  const counts = {'api-misuse':{runs:0,fixes:0},'invalid-arguments':{runs:0,fixes:0}};
  const primary = {'api-misuse':{runs:0,fixes:0},'invalid-arguments':{runs:0,fixes:0}};
  for (const row of corpus.records) {
    const normalized = normalizeRuntimeCell(row.code);
    if (normalized.fix) {
      assert.equal(normalized.fix.split('\n').length,1);
      assert.match(normalized.fix,/^sleight: .+Operation not sent\.$/);
      counts[row.category].fixes++;
      if (row.cohort === 'vf1-67') primary[row.category].fixes++;
      continue;
    }
    const f = fake(), evaluator = createEvaluator({platform:'darwin',request:f.driver.request});
    try {
      await evaluator.evaluate('let __sleightOpenedApp2 = await cua.getApp("TextEdit"); let __sleightOpenedApp5 = __sleightOpenedApp2;' +
        (/\b(?:let|const)\s+app\b/.test(row.code) ? '' : 'let app = __sleightOpenedApp2;'));
      const result = await evaluator.evaluate(normalized.code);
      assert.equal(result.isError,false,`${row.source} call ${row.call}: ${text(result)}`);
      counts[row.category].runs++;
      if (row.cohort === 'vf1-67') primary[row.category].runs++;
    } finally { evaluator.close(); }
  }
  assert.deepEqual(primary, {'api-misuse':{runs:22,fixes:9},'invalid-arguments':{runs:0,fixes:36}});
  assert.equal(corpus.sessions,396);
  assert.equal(corpus.records.filter(row=>row.cohort==='vf1-67').length,67);
  assert.equal(counts['api-misuse'].runs+counts['api-misuse'].fixes,31);
  assert.equal(counts['invalid-arguments'].runs+counts['invalid-arguments'].fixes,38);
  assert.equal(counts['invalid-arguments'].runs,1, 'the supplemental {x,y} click now uses the point path');
  t.diagnostic(`VF1 replay ${JSON.stringify(counts)}; invalid arguments include 36 keyboard and 2 supplemental click-target results`);
});

test('runtime adapter rejects literal misuse before the relay can split acquisition or execute an earlier click', async () => {
  const f = fake(), input = new PassThrough(), output = new PassThrough(), messages = [];
  output.on('data', bytes => messages.push(...String(bytes).trim().split('\n').map(JSON.parse)));
  const owner = await runOwnRuntime({input,output,signals:new EventEmitter(),driver:f.driver,
    lease:{close(){},release(){}},policy:()=>({allow:true}),permissions:{app(){},page(){},sitesLimited:()=>false},
    targetParents: () => [1], ancestry:()=>[],allowForbidden:()=>false,ownHostPid:()=>false,
    approvalStorage:{load:()=>({}),live:()=>({list:()=>[],allows:()=>false})},grantAudit(){},
    relayOptions:{idleTurnEndMs:0}});
  try {
    input.write(JSON.stringify({jsonrpc:'2.0',id:42,method:'tools/call',params:{name:'js',arguments:{
      code:'let app = await cua.getApp("TextEdit"); await app.click(1); await app.type(1,"bad");'}}})+'\n');
    for(let i=0;i<50&&!messages.length;i++) await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(messages.length,1); assert.equal(messages[0].id,42);
    assert.match(text(messages[0].result),/Use app.typeText\(text\)/);
    assert.equal(f.requests.length,0);
  } finally { await owner.close(); }
});

test('runtime adapter puts aliases and numbered targets through relay guards as canonical calls', { skip: replWorkerSkip }, async () => {
  const f = fake(), input = new PassThrough(), output = new PassThrough(), pending = new Map();
  output.on('data', bytes => { for (const line of String(bytes).trim().split('\n')) {
    const message=JSON.parse(line); pending.get(message.id)?.(message.result);
  } });
  const owner = await runOwnRuntime({input,output,signals:new EventEmitter(),driver:f.driver,
    lease:{close(){},release(){},renew(){},acquire:()=> 'fixture'},policy:()=>({allow:true}),
    permissions:{app(){},page(){},sitesLimited:()=>false},targetParents: () => [1], ancestry:()=>[{pid:500,path:'/fixture/Host'}],
    allowForbidden:()=>false,ownHostPid:()=>false,
    approvalStorage:{load:()=>({}),live:()=>({list:()=>[],allows:()=>false})},grantAudit(){},
    relayOptions:{idleTurnEndMs:0}});
  const methods=[];
  owner.runtime.safety.request=async(method,params,context)=>{
    context.beforeRequest(); methods.push({method,params}); return f.driver.request(method,params);
  };
  let id=0;
  const js=async code=>{
    const current=++id, result=new Promise(resolve=>pending.set(current,resolve));
    input.write(JSON.stringify({jsonrpc:'2.0',id:current,method:'tools/call',params:{name:'js',arguments:{code}}})+'\n');
    return result;
  };
  try {
    assert.equal((await js('let app = await cua.getApp("TextEdit");')).isError,false);
    for(const [code,canonical] of [['await app.type("draft");','typeText'],['await app.key("Return");','pressKey'],
      ['const editor = app; await editor.press("Return");','pressKey'],
      ['await app.click(1,{button:"right"});','click']]) {
      const before=methods.length,result=await js(code);
      assert.equal(result.isError,false,text(result));
      const called=methods.slice(before).filter(row=>row.method===canonical);
      assert.equal(called.length,1,`${code}: ${JSON.stringify(methods.slice(before))}`);
      if(canonical==='click') assert.deepEqual(called[0].params.args,[1,{mouseButton:'right'}]);
    }
    const before=methods.length,result=await js('await app.click("9007199254740992",{button:"right"});');
    assert.equal(result.isError,true); assert.equal(methods.length,before);
  } finally { await owner.close(); }
});

const receiverForms = [
  ['parenthesized receiver', 'await (app).key("4");', undefined, '4', true],
  ['parenthesized acquisition', 'await (await cua.getApp("TextEdit")).key("4");', undefined, '4', true],
  ['nested parentheses', 'await (((app))).key("4");', undefined, '4', true],
  ['parenthesized optional receiver', 'await (app)?.key("4");', undefined, '4', true],
  ['parenthesized optional callee', 'await (app?.key)("4");', 'await app.pressKey("4");', '4', false],
  ['parenthesized computed receiver', 'await (app)["key"]("4");', 'await app.pressKey("4");', '4', false],
  ['container key', 'let apps=[app]; await apps[0].key("4");', 'let apps=[app]; await apps[0].pressKey("4");', '4', false],
  ['nested type', 'let o={a:app}; await o.a.type("secret");', 'let o={a:app}; await o.a.typeText("secret");', 'secret', false],
  ['destructured key', 'const {key}=app; await key("4");', 'await app.pressKey("4");', '4', false],
  ['extracted type', 'const type=app.type; await type("secret");', 'await app.typeText("secret");', 'secret', false],
  ['computed key', 'await app["key"]("4");', undefined, '4', true],
  ['computed optional key', 'await app?.["key"]("4");', undefined, '4', true, true],
  ['computed type', 'await app[`type`]("secret");', undefined, 'secret', true],
  ['optional receiver', 'await app?.key("4");', undefined, '4', true],
  ['optional type receiver', 'await app?.type("secret");', undefined, 'secret', true],
  ['optional call', 'await app.key?.("4");', 'await app.pressKey("4");', '4', false],
  ['optional container', 'let apps=[app]; await apps[0]?.key("4");', 'let apps=[app]; await apps[0]?.pressKey("4");', '4', false],
  ['computed container', 'let apps=[app]; await apps[0]["key"]("4");', 'let apps=[app]; await apps[0].pressKey("4");', '4', false],
];
for (const [name, source, correction, value, accepted, nullable] of receiverForms) test(`${name}: rewrite or refuse, and flow rules inspect the canonical text`, async t => {
  const checked = normalizeRuntimeCell(source);
  assert.equal(!checked.fix, accepted, checked.fix ?? checked.code);
  if (!accepted) {
    assert.match(checked.fix, /Use app\.(?:pressKey|typeText)\(/);
    const f = fake(), client = createMacReplClient({ platform: 'darwin', driver:f.driver, spawn() { assert.fail('refused alias must not spawn'); } });
    t.after(() => client.close());
    assert.equal((await client.execute({code:source})).isError, true);
    assert.equal(f.requests.length, 0);
  }
  const canonical = accepted ? checked.code : correction;
  if (accepted) assert.equal(normalizeRuntimeCell(checked.code).code, checked.code, 'normalization is a fixed point');
  const inspected = calls(canonical, new Map([['app',{app:'TextEdit'}]]), {app:'TextEdit'}, new Set());
  assert.equal(inspected.inputs.some(input => input.value === value), true, JSON.stringify(inspected.inputs));
  const flow = new FlowRules({version:1,rules:[{id:'typed',kind:'pattern',pattern:value,destinations:['*']}]});
  assert.equal(flow.analyze('js',{code:canonical},{app:'TextEdit'}).violations.length, 1);
  const f = fake(), evaluator = createEvaluator({platform:'darwin',request:f.driver.request});
  t.after(() => evaluator.close());
  await evaluator.evaluate('let app=await cua.getApp("TextEdit");');
  const result = await evaluator.evaluate(canonical);
  assert.equal(result.isError, false, text(result));
  assert.deepEqual(f.requests.at(-1).params.args, [value]);
  if (nullable) {
    await evaluator.evaluate('app=null;');
    const before=f.requests.length, skipped=await evaluator.evaluate(canonical);
    assert.equal(skipped.isError,false,text(skipped));
    assert.equal(f.requests.length,before,'an optional alias on null must not dispatch');
  }
});

test('parenthesized alias with missing arguments gives a fix without a parse error or worker', async t => {
  const client = createMacReplClient({ platform: 'darwin', spawn() { assert.fail('invalid alias arguments must not spawn'); }});
  t.after(() => client.close());
  const result = await client.execute({code:'await (await cua.getApp("X")).key();'});
  assert.equal(result.isError, true);
  assert.match(text(result), /Use app\.pressKey\(/);
  assert.doesNotMatch(text(result), /SyntaxError/);
});

const untrackedReceivers = [
  ['callback parameter', 'await cua.getApp("TextEdit").then(editor => editor.METHOD("4"));'],
  ['shadowed app parameter', 'await cua.getApp("TextEdit").then(app => app.METHOD("4"));'],
  ['destructured binding', 'const {editor} = {editor:await cua.getApp("TextEdit")}; await editor.METHOD("4");'],
  ['array binding', 'const [editor] = [await cua.getApp("TextEdit")]; await editor.METHOD("4");'],
];
for (const [name, template] of untrackedReceivers) test(`${name}: canonical calls dispatch and aliases refuse`, { skip: replWorkerSkip }, async t => {
  const f = fake(), client = createMacReplClient({ platform: 'darwin', driver:f.driver, admit:async () => true});
  t.after(() => client.close());
  const canonical = template.replace('METHOD', 'pressKey');
  assert.equal(normalizeRuntimeCell(canonical).code, canonical);
  const result = await client.execute({code:canonical});
  assert.equal(result.isError, false, text(result));
  assert.deepEqual(f.requests.map(row => row.method), ['getApp', 'pressKey']);
  assert.deepEqual(f.requests.at(-1).params.args, ['4']);
  for (const alias of ['key', 'press', 'type', 'read', 'screenshot']) {
    const before = f.requests.length;
    const refused = await client.execute({code:template.replace('METHOD', alias)});
    assert.equal(refused.isError, true);
    assert.match(text(refused), /Use app\.(?:pressKey|typeText|getAXState|getScreenshot)\(/);
    assert.equal(f.requests.length, before, alias);
  }
});

test('acquisition promise callbacks preserve driver errors without API misuse advice', { skip: replWorkerSkip }, async t => {
  let code;
  const requests = [];
  const client = createMacReplClient({ platform: 'darwin', admit:async () => true, driver:{
    async request(method) { requests.push(method); throw Object.assign(Error('fixture driver failure'), {code}); },
    async close() {}, async restart() {},
  }});
  t.after(() => client.close());
  for (code of ['DRIVER_PROTOCOL', 'APP_NOT_FOUND', 'DEADLINE_EXCEEDED']) {
    const result = await client.execute({code:'await cua.getApp("TextEdit").then(editor => editor.click(0));'});
    assert.equal(result.isError, true);
    assert.match(text(result), new RegExp(code));
    assert.doesNotMatch(text(result), /Use (?:app\.|the documented app methods)|Fix:|Operation not sent/);
  }
  assert.deepEqual(requests, Array(3).fill('getApp'));
});

test('acquisition callback action with unknown delivery gives no duplicate-input advice', { skip: replWorkerSkip }, async t => {
  const requests = [];
  const client = createMacReplClient({ platform: 'darwin', admit:async () => true, driver:{
    async request(method) {
      requests.push(method);
      if (method === 'getApp') return {window, text:tree, readId:1};
      assert.equal(method, 'click');
      throw Object.assign(Error('fixture action deadline'), {code:'DEADLINE_EXCEEDED', delivery:'unknown', retry:'read-first'});
    },
    async close() {}, async restart() {},
  }});
  t.after(() => client.close());
  const result = await client.execute({code:'await cua.getApp("TextEdit").then(editor => editor.click(0));'});
  assert.equal(result.isError, true);
  assert.match(text(result), /DEADLINE_EXCEEDED/);
  assert.match(text(result), /delivery=unknown; retry=read-first/);
  assert.doesNotMatch(text(result), /Operation not sent|Fix:/);
  assert.deepEqual(requests, ['getApp', 'click']);
});

test('facade exposes only canonical methods, including on containers, with no data-property throwers', async () => {
  const f = fake(), cua = createCua({platform:'darwin',request:f.driver.request,write(){},emitImage(){}});
  const app = await cua.getApp('TextEdit');
  for (const [alias, canonical] of [['key','pressKey'],['type','typeText'],['press','pressKey'],['read','getAXState'],['screenshot','getScreenshot']]) {
    assert.equal(Object.hasOwn(app,alias), false);
    const before = f.requests.length;
    assert.throws(() => app[alias]('4'), new RegExp(`Use app\\.${canonical}`));
    assert.equal(f.requests.length, before);
  }
  assert.equal(app.windowId, undefined); assert.equal(app.title, undefined);
  assert.equal(app.toJSON, undefined); assert.equal(JSON.stringify(app), '{}');
});

test('parse errors retain location, start no worker and do not count toward misuse escalation', async t => {
  const f = fake(), client=createMacReplClient({ platform: 'darwin', driver:f.driver,spawn(){assert.fail('no worker');}});
  t.after(() => client.close());
  for(let i=0;i<5;i++) {
    const result=await client.execute({code:'await app.click('});
    assert.match(text(result),/^SyntaxError: .+\(line 1, column \d+\)$/);
    assert.equal(result.content.length,1);
    assert.doesNotMatch(text(result),/Operation not sent/);
  }
  for(let i=1;i<=4;i++) {
    const result=await client.execute({code:'await app.typeText(2,"bad");'});
    assert.equal(result.content.length,i===4?2:1);
  }
  assert.equal(f.requests.length,0);
});

for (const [name, code, expected] of [
  ['reference','await app.click(1); missingFixtureBinding;',/ReferenceError: missingFixtureBinding is not defined/],
  ['type','await app.click(1); let missingValue; missingValue.trim();',/TypeError: .*undefined.*trim/],
  ['computed argument','await app.click(1); let badTarget=null; await app.typeText(badTarget,"bad");',/Use app.typeText\(text\)/],
]) test(`${name} failure keeps the real message and earlier action history`, { skip: replWorkerSkip }, async t => {
  const f=fake(), client=createMacReplClient({ platform: 'darwin', driver:f.driver,admit:async()=>true});
  t.after(() => client.close());
  assert.equal((await client.execute({code:'let app=await cua.getApp("TextEdit");'})).isError,false);
  const result=await client.execute({code});
  assert.equal(result.isError,true); assert.match(text(result),expected);
  assert.match(text(result),/1 click\(1\) unknown[\s\S]*next=read-again: effects may have occurred/);
  assert.doesNotMatch(text(result),/Operation not sent/);
  assert.equal(f.requests.filter(row=>row.method==='click').length,1);
});

test('runtime JavaScript errors keep their messages without escalating API misuse', { skip: replWorkerSkip }, async t => {
  const f=fake(), client=createMacReplClient({ platform: 'darwin', driver:f.driver,admit:async()=>true});
  t.after(() => client.close());
  for(let i=0;i<5;i++) {
    const result=await client.execute({code:'absentFixtureName;'});
    assert.match(text(result),/ReferenceError: absentFixtureName is not defined/);
    assert.match(text(result),/Fix: Check bindings/);
    assert.equal(result.content.length,2);
    assert.match(result.content[0].text,/0 requests arrived/);
  }
});

test('length caps give fixes naming the actual maximum and accept the boundary', () => {
  assert.equal(normalizeMacAction('typeText',['a'.repeat(16384)]).args[0].length,16384);
  assert.throws(()=>normalizeMacAction('typeText',['a'.repeat(16385)]),/at most 16384 characters/);
  assert.equal(normalizeMacAction('scroll',[1,'down',100]).args[2],100);
  assert.throws(()=>normalizeMacAction('scroll',[1,'down',101]),/at most 100 pages or 100000 pixels/);
  assert.deepEqual(normalizeMacAction('scroll',[1,'down',{pixels:100000}]).args[2],{pixels:100000});
  assert.throws(()=>normalizeMacAction('scroll',[1,'down',{pixels:100001}]),/at most 100 pages or 100000 pixels/);
});

test('runtime transport preserves non-js and unchanged js lines byte for byte', () => {
  for(const line of [
    ' { "jsonrpc" : "2.0", "id":9007199254740993123,"method":"initialize", "params":{} } ',
    '{"jsonrpc":"2.0", "method":"notifications/initialized"}',
    ' {"method":"tools/call","params":{"name":"js","arguments":{"code":"await app.pressKey(\\"4\\");"}}} ',
    'not json',
  ]) assert.equal(normalizeRuntimeLine(line,normalizeRuntimeCell).line,line);
  const result=normalizeRuntimeLine(JSON.stringify({method:'tools/call',params:{name:'js',arguments:{code:'await app.key("4");'}}}),normalizeRuntimeCell);
  assert.equal(JSON.parse(result.line).params.arguments.code,'await app.pressKey("4");');
});

test('pre-relay rejection failures answer the original id with a JSON-RPC error', async () => {
  const f=fake(),input=new PassThrough(),output=new PassThrough(),messages=[];
  output.on('data',bytes=>messages.push(...String(bytes).trim().split('\n').map(JSON.parse)));
  const owner=await runOwnRuntime({input,output,signals:new EventEmitter(),driver:f.driver,
    lease:{close(){},release(){}},policy:()=>({allow:true}),permissions:{app(){},page(){},sitesLimited:()=>false},
    targetParents: () => [1], ancestry:()=>[],allowForbidden:()=>false,ownHostPid:()=>false,
    approvalStorage:{load:()=>({}),live:()=>({list:()=>[],allows:()=>false})},grantAudit(){},relayOptions:{idleTurnEndMs:0}});
  owner.runtime.rejectMisuse=async()=>{throw Error('fixture rejection failed');};
  try {
    input.write(JSON.stringify({jsonrpc:'2.0',id:77,method:'tools/call',params:{name:'js',arguments:{code:'await app.key(1,"bad");'}}})+'\n');
    for(let i=0;i<100&&!messages.length;i++) await new Promise(resolve=>setTimeout(resolve,10));
    assert.deepEqual(messages,[{jsonrpc:'2.0',id:77,error:{code:-32603,message:'fixture rejection failed'}}]);
    assert.equal(f.requests.length,0);
  } finally {await owner.close();}
});

test('runtime listener refuses an unexpected preflight error and serves the next cell', { skip: replWorkerSkip,timeout:10000}, async t => {
  const f=fake(), input=new PassThrough(), output=new PassThrough(), pending=new Map(), forwarded=[];
  output.on('data', bytes => { for (const line of String(bytes).trim().split('\n')) {
    const message=JSON.parse(line); pending.get(message.id)?.(message);
  } });
  const owner=await runOwnRuntime({input,output,signals:new EventEmitter(),driver:f.driver,
    lease:{close(){},release(){}},policy:()=>({allow:true}),permissions:{app(){},page(){},sitesLimited:()=>false},
    targetParents: () => [1], ancestry:()=>[],allowForbidden:()=>false,ownHostPid:()=>false,
    approvalStorage:{load:()=>({}),live:()=>({list:()=>[],allows:()=>false})},grantAudit(){},relayOptions:{idleTurnEndMs:0}});
  t.after(() => owner.close());
  owner.runtime.serverIn.on('data', bytes => forwarded.push(String(bytes)));
  const normalize=owner.runtime.normalizeCode;
  owner.runtime.normalizeCode=() => { throw Error('arbitrary fixture preflight failure'); };
  const js=(id,code) => {
    const reply=new Promise(resolve => pending.set(id,resolve));
    assert.doesNotThrow(() => input.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:'js',arguments:{code}}})+'\n'));
    return reply;
  };
  const refused=await js(81,'await cua.getApp("TextEdit"); await app.click(0);');
  assert.deepEqual(refused,{jsonrpc:'2.0',id:81,error:{code:-32603,message:'Runtime preflight failed'}});
  assert.equal(forwarded.length,0);
  assert.equal(f.requests.length,0);
  owner.runtime.normalizeCode=normalize;
  const next=await js(82,'nodeRepl.write("next cell");');
  assert.equal(next.result.isError,false,text(next.result));
  assert.match(text(next.result),/next cell/);
  assert.equal(forwarded.length,1);
  assert.equal(f.requests.length,0);
});

test('the real relay passes normalized alias text to flow rules before any action request', { skip: replWorkerSkip }, async () => {
  const f=fake(),input=new PassThrough(),output=new PassThrough(),pending=new Map(),inspected=[];
  output.on('data',bytes=>{for(const line of String(bytes).trim().split('\n')){const message=JSON.parse(line);pending.get(message.id)?.(message.result);}});
  const flow=new FlowRules({version:1,rules:[{id:'typed',kind:'pattern',pattern:'4|secret',destinations:['*']}]});
  const analyze=flow.analyze.bind(flow);
  flow.analyze=(name,args,...rest)=>{if(name==='js')inspected.push(args.code);return analyze(name,args,...rest);};
  const owner=await runOwnRuntime({input,output,signals:new EventEmitter(),driver:f.driver,
    lease:{close(){},release(){},renew(){},acquire:()=>'fixture'},policy:()=>({allow:true}),
    permissions:{app(){},page(){},sitesLimited:()=>false},targetParents: () => [1], ancestry:()=>[{pid:500,path:'/fixture/Host'}],
    allowForbidden:()=>false,ownHostPid:()=>false,
    approvalStorage:{load:()=>({}),live:()=>({list:()=>[],allows:()=>false})},grantAudit(){},
    relayOptions:{idleTurnEndMs:0,flowRules:flow}});
  const methods=[];
  owner.runtime.safety.request=async(method,params,context)=>{context.beforeRequest();methods.push(method);return f.driver.request(method,params);};
  let id=0;
  const js=code=>{const current=++id,result=new Promise(resolve=>pending.set(current,resolve));input.write(JSON.stringify({jsonrpc:'2.0',id:current,method:'tools/call',params:{name:'js',arguments:{code}}})+'\n');return result;};
  try {
    assert.equal((await js('let app=await cua.getApp("TextEdit");')).isError,false);
    for(const source of ['await app.key("4");','await app["type"]("secret");','await app?.key("4");']) {
      const before=methods.length;
      const result=await js(source);
      assert.equal(result.isError,true,text(result));
      assert.match(text(result),/typed/);
      assert.equal(methods.length,before);
      assert.ok(inspected.some(code=>code.includes(source.includes('secret')?'.typeText("secret")':'.pressKey("4")')));
    }
  } finally {await owner.close();}
});

for (const consequential of [false,true]) test(`RT11G/H keeps delivery, remapping notices and consequential refusal, consequential=${consequential}`, { skip: replWorkerSkip }, async t => {
  const initial='Window: "Draft", App: TextEdit.\n0 standard window Draft\n\t1 button Add\n\t2 text Ready\n\t3 button '+(consequential?'Submit':'Cancel, ID: cancel');
  const changed=initial.replace('\t3 button','\t3 button Undo Banner\n\t4 button');
  const runtime=createOwnRuntime({driver:{async close(){},async restart(){}},
    lease:{close(){},release(){},renew(){},acquire:()=>'fixture'},policy:()=>({allow:true}),
    permissions:{app(){},page(){},sitesLimited:()=>false}});
  t.after(()=>runtime.close());
  let current=initial,readId=0,id=0;
  const requests=[],pending=new Map();
  runtime.safety.request=async(method,params,context)=>{
    context.beforeRequest();requests.push({method,params:structuredClone(params)});
    if(method==='click')current=changed;
    return {window,text:current,readId:++readId,delivery:'sent-unverified',retry:'read-first'};
  };
  runtime.serverOut.on('data',bytes=>{for(const line of String(bytes).trim().split('\n')){
    const message=JSON.parse(line);runtime.safety.guardResult(message);
    const result=runtime.safety.displayResult(message.id,message.result);
    runtime.safety.recordDelivery(result);pending.get(message.id)?.(result);
  }});
  const js=code=>{const current=++id,result=new Promise(resolve=>pending.set(current,resolve));runtime.serverIn.write(JSON.stringify({id:current,method:'tools/call',params:{name:'js',arguments:{code}}})+'\n');return result;};
  assert.equal((await js('let app=await cua.getApp("TextEdit");')).isError,false);
  const result=await js('await app.click(1); await app.click(3); await app.click(3); void 0;');
  assert.equal(result.isError,consequential,text(result));
  const targets=requests.filter(row=>row.method==='click').map(row=>row.params.args);
  if(consequential) {
    assert.match(text(result),/STALE_READ/);assert.deepEqual(targets,[[1]]);
    assert.doesNotMatch(text(result),/Submit\(3\) went to element 4/);
  } else {
    assert.match(text(result),/button Cancel, ID: cancel\(3\) went to element 4/);
    assert.deepEqual(targets,[[1],[4],[4]]);
    assert.equal((await js('await app.click(4); void 0;')).isError,false);
  }
});

test('a caught and printed misuse after input also reports earlier action requests', { skip: replWorkerSkip }, async t => {
  const f=fake(),client=createMacReplClient({ platform: 'darwin', driver:f.driver,admit:async()=>true});
  t.after(()=>client.close());
  await client.execute({code:'let app=await cua.getApp("TextEdit");'});
  const result=await client.execute({code:'await app.click(1); let bad=null; try { await app.typeText(bad,"wrong"); } catch(error) { nodeRepl.write(error.message); }'});
  assert.equal(result.isError,false,text(result));
  assert.match(text(result),/1 click\(1\) unknown[\s\S]*next=read-again: effects may have occurred/);
  assert.doesNotMatch(text(result),/Operation not sent/);
});
