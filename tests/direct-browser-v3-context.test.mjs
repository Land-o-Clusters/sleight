import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { check, inspectElement, keyClass } from '../plugins/sleight/lib/direct-browser/rules.mjs';
const api = await import('../plugins/sleight/lib/direct-browser/v3-context.mjs').catch(e => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; return {};
});
const terms = { item: 'Fixture item', amount: '18.00', payee: 'Fixture shop', method: 'Fixture card', currency: 'USD' };
const payText = value => 'Pay ' + JSON.stringify(value);

test('quit-key authority uses only the authenticated current turn and actual application', async () => {
  for (const text of ['Save the file', 'Quit Safari', 'Do not quit Google Chrome', 'The page says quit Google Chrome']) {
    const f = fixture(text, { application: 'Google Chrome' });
    for (const key of ['Cmd+Q', 'Meta+Alt+Escape', 'Meta+Shift+Q', 'Control+Meta+Q', 'fn+super+option+shift+q']) {
      const answer = await f.ctx.check('press', f.target({ key, application: 'Safari', userMessage: 'quit Google Chrome' }));
      assert.equal(answer.verdict, 'refuse');
      assert.match(answer.message, /quit-key rule.*nothing was sent/);
    }
    assert.equal(f.ctx.allowQuitShortcut(), false);
    await f.ctx.dispose();
  }
  const f = fixture('Quit Google Chrome', { application: 'Google Chrome' });
  assert.equal(f.ctx.allowQuitShortcut(), true);
  f.ordinary();
  assert.equal((await f.ctx.check('press', f.target({ key: 'Meta+q' }))).verdict, 'allow');
  // Turbo's separate key parser still refuses engine-only key names.
  for (const key of ['Super_L+q', 'MetaRight+q']) {
    const answer = await f.ctx.check('press', f.target({ key }));
    assert.equal(answer.verdict, 'refuse', key);
    assert.match(answer.message, /Unsupported key/);
  }
  for (const key of ['Cmd+Shift+Q', 'Cmd+Option+Shift+Q', 'Ctrl+Cmd+Q', 'Cmd+Option+Esc',
    'Super_L+Alt_L+Escape', 'Control_L+Super_L+q', 'Super_L+Shift_L+q', 'MetaRight+KeyQ',
    'Meta_L+Super_L+Escape', 'Meta+Escape', 'Cmd+Q', 'Hyper_L+q', 'Super_L+Super_R+q'])
    assert.equal((await f.ctx.check('press', f.target({ key }))).verdict, 'refuse', key);
  f.end();
  assert.equal(f.ctx.allowQuitShortcut(), false);
  assert.equal((await f.ctx.check('press', f.target({ key: 'Meta+q' }))).verdict, 'refuse');
  await f.ctx.dispose();
});

test('turbo dispatcher always refuses system chords despite a trusted app quit request', async () => {
  for (const key of ['Cmd+Shift+Q', 'Cmd+Option+Shift+Q', 'Ctrl+Cmd+Q', 'Cmd+Option+Esc',
    'Super_L+Alt_L+Escape', 'Control_L+Super_L+q', 'Meta_L+Super_L+Escape', 'Meta+Escape',
    'Meta+Shift+q', 'Cmd+Q', 'Hyper_L+q', 'Super_L+Super_R+q', 'cmd+q+Left', 'cmd+KeyQ']) for (const ref of [undefined, 'e1']) {
    const f = fixture('Quit Google Chrome', { application: 'Google Chrome' });
    f.ordinary();
    const page = new EventEmitter(), sent = [];
    page.keyboard = { press: async key => sent.push(key) };
    const run = createActionRunner({ check, snapshot: async () => ({ text: 'fixture', number: 1 }) });
    const result = await run({ page, state: f.state }, [{ do: 'press', key, ...(ref ? { ref } : {}) }], f.ctx);
    assert.match(result.lines.join('\n'), /quit-key rule.*earlier actions in this cell may already have run/, key);
    assert.deepEqual(sent, []);
    await f.ctx.dispose();
  }
});
function fixture(text = payText(terms), options = {}) {
  assert.equal(typeof api.createV3Context, 'function', 'trusted v3 context is required');
  let document = {}, origin = 'https://fixture.invalid', payment = true, inputName = 'Resume', ended = false;
  const frame = { url: () => origin + '/checkout' }, state = { snapshotNo: 0, submitUnconfirmed: false };
  const element = { tag: 'button', kind: 'button', connected: true, visible: true, enabled: true, hit: true,
    submit: true, payment: true, form: true, formPayment: true };
  const handle = {
    ownerFrame: async () => frame, dispose: async () => {},
    async evaluate(fn, arg) {
      if (fn.name === 'focusCheckedNode') return f.focusOk;
      if (fn.name === 'samePageDocument') return arg === document;
      if (fn.name === 'ownDocument') return document;
      if (fn.name === 'inspectConsent') return undefined; // G11F: no cookie wall on this fixture
      if (fn.name === 'inspectTarget') return { ...element, name: 'Continue', payment, formPayment: payment };
      if (fn.name === 'inspectElement') return { ...element, payment, formPayment: payment };
      if (fn.name === 'forwardInfo') return { label: false, areas: [] };
      if (fn.name === 'readPaymentPage') { const page = Object.fromEntries(Object.entries({ ...terms, ...f.pageTerms }).filter(([, v]) => v !== undefined)); return { origin, page, name: inputName, ...(arg === true ? { unchecked: { ...page, ...f.uncheckedTerms } } : {}) }; }
      throw Error('unsupported page reader: ' + fn.name);
    },
    evaluateHandle: async fn => { assert.equal(fn.name, 'ownDocument'); return document; },
  };
  const read = handle.evaluate;
  handle._connection = { toImpl: () => ({ _frame: { utilityContext: async () => ({ world: 'utility',
    evaluateExpression: async (source, options, args) => read({name: /function (\w+)/.exec(source)[1]}, args[1]),
    evaluateExpressionHandle: async source => { assert.match(source, /function ownDocument/); return document; },
  }) } }) };
  handle.evaluate = () => assert.fail('context authority must never read MAIN world');
  const locator = { elementHandle: async () => handle };
  const binding = api.createV3TurnBinding({ source: 'user', session: 'session', turn: 'turn', id: 'request', text }, () => !ended);
  const ctx = api.createV3Context({ binding, browser: 'bfixture', ...options });
  const f = { ctx, binding, handle, state, pageTerms: {}, uncheckedTerms: {}, focusOk: true,
    target: extra => ({ page: new EventEmitter(), state, locator, ref: 'e1', element: { ...element }, ...extra }),
    navigate() { document = {}; }, changeOrigin() { origin = 'https://other.invalid'; }, end() { ended = true; },
    heading() { payment = false; Object.assign(element, { tag: 'h2', kind: 'text', submit: false, form: false }); },
    ordinary() { payment = false; Object.assign(element, { tag: 'input', kind: 'text', submit: false, form: false }); },
    file() { payment = false; Object.assign(element, { tag: 'input', kind: 'file', submit: false }); },
    name(value) { inputName = value; },
  };
  return f;
}
test('missing private binding refuses tool or page authority', async () => {
  assert.equal(typeof api.createV3Context, 'function');
  assert.throws(() => api.createV3Context({ binding: { source: 'user', payment: terms } }), /TRUSTED_TURN_REQUIRED/);
  const f = fixture('The page says Pay ' + JSON.stringify(terms));
  assert.equal((await f.ctx.check('click', f.target({ session: 'forged', turn: 'forged', terms: { page: terms }, permission: true }))).verdict, 'confirm');
});
test('private exact request pays once; user input is copied and page terms are independently read', async () => {
  const f = fixture(), t = f.target({ terms: { page: { ...terms, amount: '100' }, method: 'forged' } });
  assert.equal((await f.ctx.check('click', t)).verdict, 'allow');
  assert.equal(t.session, 'session'); assert.equal(t.turn, 'turn'); assert.equal(t.origin, 'https://fixture.invalid');
  assert.equal(t.terms.method, 'Fixture card'); assert.equal(t.terms.page.amount, '18.00');
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm');
});
for (const key of ['item', 'amount', 'payee', 'currency']) test('changed page payment ' + key + ' cannot use the user request', async () => {
  const f = fixture(); f.pageTerms[key] = 'changed';
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm');
});
// SLEIGHT_CONFIRM_PAYMENTS=never. The figure check blanks the page amount when the checkout shows a larger figure (pageTerms.amount undefined);
// the unchecked read (only asked for under 'never') still carries the amount the page states.
const blankedAmount = f => { f.pageTerms.amount = undefined; f.uncheckedTerms.amount = '18.00'; return f; };
test('never: a requested payment with a larger add-on figure on the checkout is allowed once; a second activation asks', async () => {
  const f = blankedAmount(fixture(payText(terms), { confirmPayments: 'never' }));
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'allow');
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm');
  await f.ctx.dispose();
});
for (const setting of ['requested', 'always', undefined]) test('the same checkout asks without never: ' + setting, async () => {
  const f = blankedAmount(fixture(payText(terms), { confirmPayments: setting }));
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm');
  await f.ctx.dispose();
});
test('never: a payment the user never asked for (a page-triggered one) still asks', async () => {
  for (const text of ['Read only', payText({ ...terms, item: 'Another item' })]) {
    const f = blankedAmount(fixture(text, { confirmPayments: 'never' }));
    assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm');
    await f.ctx.dispose();
  }
});
test('never: an amount that differs from the one the user named asks, with or without a figure conflict', async () => {
  const f = blankedAmount(fixture(payText({ ...terms, amount: '17.00' }), { confirmPayments: 'never' }));
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm');
  const g = fixture(payText(terms), { confirmPayments: 'never' }); g.pageTerms.amount = '99.00'; g.uncheckedTerms.amount = '99.00';
  assert.equal((await g.ctx.check('click', g.target())).verdict, 'confirm');
  await f.ctx.dispose(); await g.ctx.dispose();
});
test('never: a page-supplied unchecked field on the target is replaced by the trusted read', async () => {
  const f = blankedAmount(fixture('Read only', { confirmPayments: 'never' })), t = f.target({ terms: { unchecked: { ...terms } } });
  assert.equal((await f.ctx.check('click', t)).verdict, 'confirm');
  assert.equal(t.terms.unchecked.amount, '18.00'); assert.equal(t.terms.page.amount, undefined);
  await f.ctx.dispose();
});
for (const key of ['item', 'amount', 'payee', 'method']) test('missing requested payment ' + key + ' confirms', async () => {
  const requested = { ...terms }; delete requested[key]; const f = fixture(payText(requested));
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm');
});
test('final Enter risk comes from the target frame and retains prior payment risk', async () => {
  const f = fixture('Read only');
  assert.equal((await f.ctx.check('press', f.target({ key: 'Enter', element: { tag: 'input', form: true, payment: false, formPayment: false } }))).verdict, 'confirm');
  f.ordinary();
  assert.equal((await f.ctx.check('press', f.target({ key: 'Enter', prior: { tag: 'input', kind: 'text', form: true, formPayment: true, submit: true, payment: true } }))).verdict, 'confirm');
});
test('end-turn fences an already prepared private context', async () => {
  const f = fixture(); f.end();
  assert.equal((await f.ctx.check('click', f.target())).verdict, 'refuse');
});
test('upload stages only exact user-named bytes bound to this event, document and input', async t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'v3-file-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'resume.txt'); writeFileSync(path, 'fixture bytes');
  const f = fixture(`Upload "${path}" to Resume`); f.file();
  const target = f.target({ paths: [path] });
  assert.equal((await f.ctx.check('upload', target)).verdict, 'allow');
  const stage = await f.ctx.stageUploads(target, [path]);
  assert.equal(stage.payloads[0].buffer.toString(), 'fixture bytes'); stage.cleanup();
  await assert.rejects(f.ctx.stageUploads(target, [path]), /USER_NAMED_FILE_REQUIRED/);
  await f.ctx.dispose();
});
for (const change of ['different-path', 'different-input', 'changed-document', 'ended']) test('upload refuses ' + change, async t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'v3-file-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'resume.txt'); writeFileSync(path, 'fixture bytes');
  const f = fixture(`Upload "${path}" to Resume`); f.file(); const target = f.target({ paths: [path] });
  assert.equal((await f.ctx.check('upload', target)).verdict, 'allow');
  if (change === 'different-input') f.name('Other'); if (change === 'changed-document') f.navigate(); if (change === 'ended') f.end();
  await assert.rejects(f.ctx.stageUploads(target, change === 'different-path' ? [path + '.other'] : [path]));
  await f.ctx.dispose();
});

test('native consent remains one-use, exact-operation and authenticated', async () => {
  const f = fixture(payText({ ...terms, amount: '99.00' })), events = new WeakSet(), presentations = [];
  const ui = { authenticate: event => events.delete(event),
    present(id, data, choices, deliver) { presentations.push({ id, data, choices, deliver }); } };
  const ctx = api.createV3Context({ binding: f.binding, browser: 'bfixture', ui });
  assert.equal((await ctx.check('click', f.target())).verdict, 'confirm');
  assert.equal(presentations.length, 1); assert.equal(presentations[0].data.operation.payment.amount, '18.00');
  const event = { id: presentations[0].id, choice: 'once' }; events.add(event);
  await presentations[0].deliver(event);
  assert.equal((await ctx.check('click', f.target())).verdict, 'allow');
  assert.equal((await ctx.check('click', f.target())).verdict, 'confirm');
  assert.equal(presentations.length, 2); await ctx.dispose();
});

for (const amount of ['1 304', "1'304", '1’304']) for (const unchecked of [false, true])
  test(`PQ1 authenticated turbo asks once for ${amount}, unchecked=${unchecked}`, async () => {
    const requested = { ...terms, amount }, events = new WeakSet(), presentations = [];
    const ui = { authenticate: event => events.delete(event),
      present(id, data, choices, deliver) { presentations.push({ id, data, choices, deliver }); } };
    const f = fixture(payText(requested), { confirmPayments: 'never', ui });
    f.pageTerms.amount = unchecked ? undefined : amount;
    if (unchecked) f.uncheckedTerms.amount = amount;
    try {
      assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm');
      assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm');
      assert.equal(presentations.length, 1, 'a retry while waiting keeps the same card');
      assert.equal(presentations[0].data.operation.payment.amount, amount);
      const event = { id: presentations[0].id, choice: 'once' }; events.add(event);
      await presentations[0].deliver(event);
      assert.equal((await f.ctx.check('click', f.target())).verdict, 'allow');
      assert.equal((await f.ctx.check('click', f.target())).verdict, 'confirm');
      assert.equal(presentations.length, 2, 'the allowance pays once');
    } finally { await f.ctx.dispose(); }
  });

test('page DOM reads keep every free name inside the serialized function', () => {
  for (const fn of [api.ownDocument, api.samePageDocument, api.readPaymentPage]) assert.equal(typeof fn, 'function');
  assert.doesNotMatch(api.readPaymentPage.toString(), /requested|userMessage|consent/);
});

test('worker begin creates a private binding and fences it synchronously on end', async () => {
  const { serveV3Worker } = await import('../plugins/sleight/lib/direct-browser/worker.mjs');
  const channel = new EventEmitter(), sent = [], waits = new Map(); channel.connected = true;
  channel.send = frame => { sent.push(frame); waits.get(frame.id)?.(frame.result); };
  let privateContext;
  const server = serveV3Worker({ channel, browser:'bfixture', async begin(message,binding) {
    privateContext = api.createV3Context({ binding, browser:'bfixture' });
    return { call:async () => ({text:'fixture',isError:false}), delivered:() => true,
      async end() { await privateContext.dispose(); return {revoked:true,cleanup:[]}; } };
  } }); server.ready();
  const request = (id,method,params) => new Promise(resolve => { waits.set(id,resolve); channel.emit('message',{version:3,id,method,params}); });
  assert.equal((await request('q1','begin',{turn:'turn',text:payText(terms),payment:terms})).available,false);
  assert.equal((await request('q2','begin',{turn:'turn',text:payText(terms),apps:[]})).available,true);
  assert.equal(privateContext.userMessage().text,payText(terms));
  const ended = request('q3','end',{});
  assert.equal(privateContext.userMessage(),undefined,'end fences before asynchronous cleanup');
  assert.equal((await ended).revoked,true);
  channel.emit('disconnect');
});

test('worker turn runtime supplies the branded context to actions and collects it at end', async () => {
  const { createV3TurnRuntime } = await import('../plugins/sleight/lib/direct-browser/worker.mjs');
  const f = fixture(), entry = {page:{},state:f.state}; let captured;
  const pages = { tab:() => entry, enqueue:async (id,run) => run(entry), endTurn:async () => ({cleanedUp:true,rows:[]}) };
  const runtime = await createV3TurnRuntime({ binding:f.binding, browser:'bfixture', pages,
    snapshot:async () => ({text:'untrusted',number:1}), dependencies:{runSteps:async (tab,steps,ctx) => {
      assert.equal(api.isV3Context(ctx),true); captured=ctx; return {lines:['fixture'],observe:{text:'untrusted',number:1,capturedAt:Date.now()}};
    }} });
  const result = await runtime.call({name:'browser_act',arguments:{tab:'t1',steps:[{do:'click',ref:'e1'}]}});
  assert.equal(result.isError,false); assert.equal(captured.userMessage().text,payText(terms));
  assert.equal(runtime.delivered(result),true); assert.deepEqual(await runtime.end(),{revoked:true,cleanup:[]});
  assert.equal(captured.userMessage(),undefined);
});

for (const revoke of [false, true]) test('pinned drag interpolates owned-page input and releases after revocation=' + revoke, async () => {
  const f=fixture('Move the fixture'); f.ordinary(); const events=[]; let point;
  f.handle.hover=async () => {events.push('hover'); point={x:3,y:7};};
  f.handle.boundingBox=async () => ({x:0,y:0,width:10,height:10});
  assert.equal(f.handle.dragTo,undefined);
  const destination={...f.handle,hover:async () => {events.push('hover'); point={x:103,y:7};},
    boundingBox:async () => ({x:100,y:0,width:10,height:10})};
  const moves=[];
  const page=new EventEmitter(); page.mouse={down:async () => events.push('down'),up:async () => events.push('up'),
    move:async (x,y) => {moves.push([x,y]); if(revoke) f.end();}};
  page._connection={toImpl:value => {assert.equal(value,page); return {mouse:{_currentPoint:() => ({...point})}};}};
  const source=f.target({page}); assert.equal((await f.ctx.check('drag',source)).verdict,'allow');
  const run=f.ctx.dragTo(source,{elementHandle:async () => destination});
  if(revoke) {
    await assert.rejects(run,/TRUSTED_TARGET_REQUIRED/);
    assert.equal(moves.length,2); assert.deepEqual(moves.at(-1),[3,7]);
    assert.deepEqual(events,['hover','hover','down','up']);
  } else {
    await run;
    assert.ok(moves.length>=5 && moves.length<=40);
    assert.deepEqual(moves.at(-1),[103,7]);
    assert.ok(moves.every(([x,y],i) => y===7 && x>3 && (!i || x>moves[i-1][0])));
    assert.deepEqual(events,['hover','hover','down','hover','hover','up']);
  }
  await f.ctx.dispose();
});

test('vendored Playwright Mouse retains _currentPoint without launching a browser', async () => {
  const { server } = createRequire(import.meta.url)('../plugins/sleight/vendor/playwright-core/lib/coreBundle.js');
  const sent = [], page = new server.Page({ rawMouse: { move: async (_progress, x, y) => sent.push([x, y]) } }, {
    attribution: {}, instrumentation: { addListener() {} }, isCreatingStorageStatePage: () => false,
  });
  assert.equal(typeof page.mouse._currentPoint, 'function');
  assert.deepEqual(page.mouse._currentPoint(), { x: 0, y: 0 });
  await page.mouse.move({}, 103, 7);
  assert.deepEqual(sent, [[103, 7]]);
  assert.deepEqual(page.mouse._currentPoint(), { x: 103, y: 7 });
});

function dragFixture(t, onHover) {
  const f = fixture('Move the fixture'); f.ordinary();
  const events = []; let point, hovers = 0;
  const sourceBox = { x: 10, y: 10, width: 10, height: 10 }, endBox = { x: 110, y: 10, width: 10, height: 10 };
  const hover = async (name, at) => {
    events.push(['hover', name]); point = at; await onHover?.(++hovers, name, at);
  };
  f.handle.hover = () => hover('source', { x: 13, y: 17 });
  f.handle.boundingBox = async () => sourceBox;
  const destination = { ...f.handle, hover: () => hover('destination', { x: 113, y: 17 }),
    boundingBox: async () => endBox, dispose: async () => events.push(['dispose']) };
  const page = new EventEmitter();
  page.mouse = { down: async () => events.push(['down']), up: async () => events.push(['up', point.x, point.y]),
    move: async (x, y) => { point = { x, y }; events.push(['move', x, y]); } };
  page._connection = { toImpl: () => ({ mouse: { _currentPoint: () => point } }) };
  const source = f.target({ page }); t.after(() => f.ctx.dispose());
  return { f, events, source, destination, page, start: async () => {
    assert.equal((await f.ctx.check('drag', source)).verdict, 'allow');
    return f.ctx.dragTo(source, { elementHandle: async () => destination });
  } };
}

for (const failedHover of [3, 4]) test('drag returns to source when final hover ' + failedHover + ' throws', async t => {
  const d = dragFixture(t, count => { if (count === failedHover) throw Error('destination moved'); });
  await assert.rejects(d.start(), /destination moved/);
  assert.deepEqual(d.events.slice(-3), [['move', 13, 17], ['up', 13, 17], ['dispose']]);
  assert.equal(d.events.filter(([kind]) => kind === 'down').length, 1);
});

test('drag releases the mouse and destination when returning to source throws', async t => {
  const d = dragFixture(t, count => { if (count === 3) throw Error('destination moved'); });
  const move = d.page.mouse.move;
  d.page.mouse.move = async (x, y) => {
    if (x === 13 && y === 17) { d.events.push(['return failed']); throw Error('return failed'); }
    await move(x, y);
  };
  await assert.rejects(d.start(), /return failed/);
  assert.equal(d.events.filter(([kind]) => kind === 'down').length, 1);
  assert.deepEqual(d.events.slice(-3), [['return failed'], ['up', 113, 17], ['dispose']]);
});

for (const hover of [1, 2, 3, 4]) test('drag refuses a saved point outside the box after hover ' + hover, async t => {
  const d = dragFixture(t, (count, _name, point) => { if (count === hover) Object.assign(point, { x: 0, y: 0 }); });
  await assert.rejects(d.start(), /TRUSTED_TARGET_REQUIRED/);
  assert.equal(d.events.filter(([kind]) => kind === 'down').length, hover <= 2 ? 0 : 1);
  if (hover >= 3) assert.deepEqual(d.events.slice(-3), [['move', 13, 17], ['up', 13, 17], ['dispose']]);
});

for (const box of [null, { x: 110, y: 10, width: 0, height: 10 }, { x: NaN, y: 10, width: 10, height: 10 }])
test('drag refuses missing or invalid endpoint geometry: ' + JSON.stringify(box), async t => {
  const d = dragFixture(t); d.destination.boundingBox = async () => box;
  await assert.rejects(d.start(), /TRUSTED_TARGET_REQUIRED/);
  assert.equal(d.events.filter(([kind]) => kind === 'down').length, 0);
});

test('drag refuses when vendored mouse point is unavailable', async t => {
  const d = dragFixture(t); d.page._connection.toImpl = () => ({ mouse: {} });
  await assert.rejects(d.start(), /TRUSTED_TARGET_REQUIRED/);
  assert.equal(d.events.filter(([kind]) => kind === 'down').length, 0);
});

test('worker end receipts clear recovered upload cleanup without mutating earlier receipts', async () => {
  const { createV3TurnRuntime }=await import('../plugins/sleight/lib/direct-browser/worker.mjs');
  const f=fixture();let retained=1;
  const runtime=await createV3TurnRuntime({binding:f.binding,browser:'bfixture',pages:{endTurn:async()=>({cleanedUp:true})},
    snapshot:async()=>({text:'fixture',number:1}),dependencies:{createContext:()=>({dispose:async()=>({retained})})}});
  const first=await runtime.end();assert.equal(first.cleanup.length,1);retained=0;
  const second=await runtime.end();assert.deepEqual(second.cleanup,[]);assert.equal(first.cleanup.length,1);
});
for (const key of ['Enter', 'Space']) test('V10R1 refuses ' + key + ' when the pinned ref cannot retain focus', async () => {
  const f = fixture('Read only'); f.heading(); f.focusOk = false;
  const result = await f.ctx.check('press', f.target({key, ref:'e9'}));
  assert.equal(result.verdict, 'refuse'); await f.ctx.dispose();
});
test('V10R1 dispatch never calls ElementHandle.press after checking focus', async () => {
  const f = fixture('Read only'); f.ordinary(); const keys = [], page = new EventEmitter();
  Object.assign(f.handle, { press: async () => { throw Error('unsafe refocusing press'); } });
  page.getByRef = () => ({elementHandle:async () => f.handle, evaluate:async () => ({submit:false,form:false})});
  // Enter goes out through the owned page keyboard under the key shield (backgroundClick with keys), never ElementHandle.press.
  page.keyboard = {press:async key => keys.push(key)};
  page.frames = () => [];
  let clock = 0;
  const run = createActionRunner({check, snapshot:async () => ({text:'fixture',number:1}), now:() => clock, sleep:async ms => {clock += ms;}});
  const result = await run({page,state:f.state},[{do:'press',ref:'e1',key:'Enter'}],f.ctx);
  assert.deepEqual(keys,['Enter']); assert.doesNotMatch(result.lines[0],/not run|unconfirmed/); await f.ctx.dispose();
});

for (const kind of ['reload','back','forward']) test('V10R2 ' + kind + ' cannot retry an unknown payment or revisit its document', async () => {
  const f = fixture(), target = f.target();
  assert.equal((await f.ctx.check('click',target)).verdict,'allow');
  for (const pending of [true,false]) {
    f.state.submitUnconfirmed = pending ? {startedAt:1,snapshotNo:0} : false;
    const result = await f.ctx.check(kind,{page:target.page,state:f.state});
    assert.equal(result.verdict,'refuse',kind + ' pending=' + pending);
  }
  await f.ctx.dispose();
});

for (const change of ['same-document','changed-document-and-origin']) test('V10R3 upload request cannot be offered again after transfer: ' + change, async t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()),'v3-file-')); t.after(() => rmSync(directory,{recursive:true,force:true}));
  const path = join(directory,'resume.txt'); writeFileSync(path,'bytes');
  const f = fixture(`Upload "${path}" to Resume`); f.file(); const first = f.target({paths:[path]});
  assert.equal((await f.ctx.check('upload',first)).verdict,'allow'); (await f.ctx.stageUploads(first,[path])).cleanup();
  if (change !== 'same-document') { f.navigate(); f.changeOrigin(); }
  assert.equal((await f.ctx.check('upload',f.target({paths:[path]}))).verdict,'refuse'); await f.ctx.dispose();
});

test('V10R4 a checked click cannot preapprove an unrelated later dialog', async () => {
  const f = fixture(), target = f.target();
  assert.equal((await f.ctx.check('click',target)).verdict,'allow');
  assert.equal((await f.ctx.check('click',f.target())).verdict,'confirm');
  const result = await f.ctx.check('dialog',{page:target.page,state:f.state,type:'confirm',accept:true,
    message:payText({item:terms.item,amount:terms.amount,payee:terms.payee,currency:'USD'})});
  assert.equal(result.verdict,'refuse'); await f.ctx.dispose();
});

test('V10R5 classification uses the associated form for a control outside it', async () => {
  const { classify } = await import('./direct-browser-rules-fixture.mjs');
  const element = classify(({Element,HTMLInputElement,HTMLButtonElement}) => {
    const form = new Element('form'); new HTMLButtonElement('button',{},'Pay now',form);
    const input = new HTMLInputElement('input'); Object.defineProperty(input,'form',{value:form}); return input;
  });
  assert.equal(element.form,true); assert.equal(element.formPayment,true);
});
test('V10R5 payment terms follow el.form and exclude an opacity-zero amount decoy', () => {
  const node = (value,visible=true) => ({localName:'p',innerText:value,textContent:value,
    getBoundingClientRect:() => ({left:0,top:0,right:10,bottom:10,width:10,height:10}),
    getClientRects:() => [{left:0,top:0,right:10,bottom:10,width:10,height:10}], checkVisibility:() => visible,
    getAttribute:() => null});
  const hidden=node('Amount: 18.00',false), shown=node('Amount: 99.00');
  const root={...node(''),querySelectorAll:selector => selector.includes('amount') ? [hidden,shown] : []};
  const wrong={querySelectorAll:() => [],innerText:''};
  const paint={color:'rgb(0, 0, 0)',webkitTextFillColor:'rgb(0, 0, 0)',backgroundColor:'rgba(0, 0, 0, 0)',backgroundImage:'none',filter:'none',maskImage:'none',mixBlendMode:'normal',fontSize:'16px'};
  const doc={documentElement:{},createRange() {let node; return {selectNodeContents(n) {node=n;},getClientRects:() => (node.parentElement ?? node).getClientRects()};},
    createTreeWalker(node) { let read=false; return {nextNode() { if (read) return null; read=true; return node.innerText ? {parentElement:node,textContent:node.innerText} : null; }}; },
    defaultView:{innerWidth:800,innerHeight:600,location:{origin:'https://fixture.invalid'},getComputedStyle:() => ({...paint,visibility:'visible',display:'block',opacity:'1'})}};
  const observed=api.readPaymentPage({ownerDocument:doc,form:root,closest:() => wrong,getAttribute:() => null});
  assert.equal(observed.page.amount,undefined);
});

test('readPaymentPage returns the unchecked amount only when asked; a larger figure blanks the page amount but not the unchecked one', () => {
  const box = { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 };
  const node = (value, extra = {}) => ({ localName: 'p', nodeType: 1, innerText: value, textContent: value, childNodes: [], getBoundingClientRect: () => box,
    getClientRects: () => [box], checkVisibility: () => true, getAttribute: () => null, ...extra });
  const read = (lenient, rendered) => {
    const text = { nodeType: 3, textContent: rendered };
    const root = node(rendered, { querySelectorAll: selector => selector.includes('amount') ? [node('Amount: 18.00')] : [], childNodes: [text] });
    text.parentElement = root;
    const paint = { color: 'rgb(0, 0, 0)', webkitTextFillColor: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', filter: 'none', maskImage: 'none', mixBlendMode: 'normal', fontSize: '16px' };
    const doc = { documentElement: {}, createRange() { let n; return { selectNodeContents(x) { n = x; }, getClientRects: () => (n.parentElement ?? n).getClientRects() }; },
      createTreeWalker(n) { let done = false; return { nextNode() { if (done) return null; done = true; return n.innerText ? { parentElement: n, textContent: n.innerText } : null; } }; },
      defaultView: { innerWidth: 800, innerHeight: 600, location: { origin: 'https://fixture.invalid' }, getComputedStyle: () => ({ ...paint, visibility: 'visible', display: 'block', opacity: '1' }) } };
    return api.readPaymentPage({ ownerDocument: doc, form: root, closest: () => ({ querySelectorAll: () => [], innerText: '' }), getAttribute: () => null }, lenient);
  };
  for (const lenient of [undefined, false]) assert.equal('unchecked' in read(lenient, 'Total 18.00'), false);
  const calm = read(true, 'Total $18.00');
  assert.equal(calm.page.amount, '18.00'); assert.equal(calm.unchecked.amount, '18.00');
  const busy = read(true, 'Total $18.00 Add-on $25.00');
  assert.equal(busy.page.amount, undefined); assert.equal(busy.unchecked.amount, '18.00');
  assert.equal(read(undefined, 'Total $18.00 Add-on $25.00').page.amount, undefined);
});

test('V10R6 dismissing a page dialog before an allowed click remains available', async () => {
  const f=fixture('Read only'), page=new EventEmitter();
  const result=await f.ctx.check('dialog',{page,state:f.state,type:'alert',message:'Pay now',accept:false});
  assert.equal(result.verdict,'allow'); await f.ctx.dispose();
});

for (const mode of ['own','other-dialog','long-lived','strict']) test('V10R4 only the initiating input can allow its exact dialog once: ' + mode, async () => {
  let clock=100; const events=new WeakSet(), presentations=[];
  const ui={authenticate:e => events.delete(e),present(id,data,choices,deliver) {presentations.push({id,deliver});}};
  const f=fixture(payText(terms),{now:() => clock,...(mode === 'strict' ? {confirmPayments:'always',ui} : {})});
  const page=new EventEmitter(), target=f.target({page});
  if (mode === 'strict') {
    assert.equal((await f.ctx.check('click',target)).verdict,'confirm');
    const e={id:presentations[0].id,choice:'once'}; events.add(e); await presentations[0].deliver(e);
  }
  assert.equal((await f.ctx.check('click',target)).verdict,'allow');
  f.ctx.beginInput(target); const dialog={}; f.state.dialog=dialog; page.emit('dialog',dialog); f.ctx.finishInput(target);
  if (mode === 'other-dialog') f.state.dialog={}; if (mode === 'long-lived' || mode === 'strict') clock+=60000;
  const d={page,state:f.state,type:'confirm',accept:true,message:payText({item:terms.item,amount:terms.amount,payee:terms.payee,currency:'USD'})};
  assert.equal((await f.ctx.check('dialog',d)).verdict,mode !== 'other-dialog' ? 'allow' : 'refuse');
  if (mode !== 'other-dialog') assert.equal((await f.ctx.check('dialog',d)).verdict,'refuse');
  await f.ctx.dispose();
});

for (const end of ['answer','dialogclosed','navigation','page-close','document-change']) test('V10R2B ordinary dialog lives until its own end: ' + end, async () => {
  let clock=0; const f=fixture('Continue',{now:() => clock}); f.ordinary();
  const page=new EventEmitter(), target=f.target({page}), dialog={};
  assert.equal((await f.ctx.check('click',target)).verdict,'allow');
  f.ctx.beginInput(target); f.state.dialog=dialog; page.emit('dialog',dialog); f.ctx.finishInput(target);
  if (end === 'answer') clock+=120000;
  const answer={page,state:f.state,type:'confirm',accept:true,message:'Continue with the fixture?'};
  if (end === 'dialogclosed') page.emit('dialogclosed',dialog);
  if (end === 'navigation') page.emit('framenavigated',await f.handle.ownerFrame());
  if (end === 'page-close') page.emit('close');
  if (end === 'document-change') { f.navigate(); page.emit('framenavigated',await f.handle.ownerFrame()); }
  if (end === 'answer') assert.equal((await f.ctx.check('dialog',answer)).verdict,'allow');
  assert.equal((await f.ctx.check('dialog',answer)).verdict,'refuse');
  await f.ctx.dispose();
  for (const event of ['dialog','dialogclosed','framenavigated','close']) assert.equal(page.listenerCount(event),0);
});
for (const kind of ['reload','back','forward']) test('V10R2 explicit user history request permits exactly one retry: ' + kind, async () => {
  const commands={reload:'Reload this page',back:'Go back',forward:'Go forward'};
  const f=fixture(commands[kind]); f.state.submitUnconfirmed={startedAt:1,snapshotNo:0};
  assert.equal((await f.ctx.check(kind,{state:f.state})).verdict,'allow');
  assert.equal((await f.ctx.check(kind,{state:f.state})).verdict,'refuse'); await f.ctx.dispose();
});

test('every spelling of an activating key is one name; keys off the safe list are unknown', () => {
  for (const key of ['Enter', 'Return', 'NumpadEnter', '\r', '\n']) assert.deepEqual(keyClass(key), { kind: 'Enter', name: 'Enter', chord: false }, key);
  for (const key of ['Space', ' ']) assert.deepEqual(keyClass(key), { kind: 'Space', name: 'Space', chord: false }, key);
  assert.equal(keyClass('Shift+NumpadEnter').chord, true); assert.equal(keyClass('Control+ ').name, 'Space');
  for (const key of ['Tab', 'Escape', 'ArrowLeft', 'End', 'a', '+', '@', 'Shift+Tab', 'Control+a', 'F4', 'Alt+ArrowDown', 'Numpad5']) assert.equal(keyClass(key).kind, 'safe', key);
  for (const key of ['', 'Enterr', 'NumpadEnterX', 'Bogus+Enter', 'Select', '\t\n', 'Accept']) assert.equal(keyClass(key).kind, 'unknown', key);
});
test('a pressed key the safe list does not know is refused before any input', async () => {
  const f = fixture('Read only'); f.ordinary();
  const result = await f.ctx.check('press', f.target({ key: 'Execute', ref: 'e1' }));
  assert.equal(result.verdict, 'refuse'); assert.match(result.message, /Unsupported key/); await f.ctx.dispose();
});

for (const [src, expected] of [
  // Default path (sleight-arch, fd2f review): a cross-origin frame in a form may hold hosted payment fields.
  ['/help', false], ['https://example.invalid/help', true], ['https://js.stripe.com/frame', true],
  ['https://www.paypal.com/frame', true], ['https://stripe.com.evil.invalid/frame', true], ['https://evilstripe.com/frame', true],
]) test('cross-origin iframe in a form marks it a payment form: ' + src, async () => {
  const { classify } = await import('./direct-browser-rules-fixture.mjs');
  const element = classify(({ Element, HTMLInputElement }) => {
    const form = new Element('form'); new Element('iframe', { src }, '', form);
    return new HTMLInputElement('input', {}, '', form);
  });
  assert.equal(element.formPayment, expected);
});

test('own-runtime browser paste refuses before target reads, keys, guard or clipboard factory', async () => {
  const calls = { factory: 0, guards: 0, keys: 0 };
  const f = fixture('Insert text', { strictText: true, clipboardIO() { calls.factory++; throw Error('pasteboard forbidden'); } });
  const target = { page: { keyboard: { press() { calls.keys++; } } } };
  await assert.rejects(f.ctx.pasteTarget(target, 'A😀\tB\nC', async () => { calls.guards++; }), error =>
    error.code === 'ACTION_UNSUPPORTED' && error.delivery === 'not-sent' && error.retry === 'safe' && /Read again/.test(error.message));
  await f.ctx.dispose();
  assert.deepEqual(calls, { factory: 0, guards: 0, keys: 0 });
});


test('strict text setup leaves explicit PDF authorization usable', () => {
  const f = fixture('Read PDF "/fixture.pdf"', { strictText: true });
  assert.equal(api.pdfFileAllowed(f.binding, '/fixture.pdf'), true);
  assert.equal(api.pdfFileAllowed(f.binding, '/other.pdf'), false);
});

test('own-runtime browser clipboard chords refuse before target reads or keyboard events', async () => {
  const f = fixture('Insert text', { strictText: true });
  let events = 0;
  const target = { page: { keyboard: { press() { events++; }, down() { events++; }, up() { events++; } } } };
  for (const modifier of ['Meta', 'ControlOrMeta', 'Control', 'Control+Shift']) {
    for (const key of ['C', 'X', 'V']) await assert.rejects(f.ctx.pressTarget(target, `${modifier}+${key}`),
      { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent', clipboard: 'untouched' });
  }
  assert.equal(events, 0);
  await f.ctx.dispose();
});

test('own-runtime browser checks the full shared clipboard chord table before reads or events', async () => {
  const { clipboardChords } = await import('./fixtures/clipboard-chords.mjs');
  const f = fixture('Insert text', { strictText: true });
  let inputs = 0, reads = 0;
  const target = f.target({ page: { keyboard: { async press() { inputs++; } } },
    locator: { async elementHandle() { reads++; throw Error('clipboard chord must refuse before resolution'); } } });
  for (const chord of clipboardChords) await assert.rejects(f.ctx.pressTarget(target, chord),
    { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent', clipboard: 'untouched' }, chord);
  assert.equal(inputs, 0); assert.equal(reads, 0);
  await f.ctx.dispose();
});
