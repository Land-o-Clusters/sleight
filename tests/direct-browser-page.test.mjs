import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { hookAnswer } from './adversarial/fixtures/hook.mjs';
import { createPageRegistry, backgroundClick, frameShield, popupHook, hookProof, hookOpen, hookSource, newHook } from '../plugins/sleight/lib/direct-browser/page.mjs';
import { activationKey } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { setViewport } from '../plugins/sleight/lib/direct-browser/viewport.mjs';
import { createToolDispatcher } from '../plugins/sleight/lib/direct-browser/tools.mjs';

function fixture(options = {}) {
  const calls = [], pages = [], context = new EventEmitter();
  context.pages = () => pages;
  context.newCDPSession = async page => page.cdp;
  const browser = { contexts: () => [context] };
  let sequence = 0;
  function page(targetId, openerId) {
    const p = new EventEmitter();
    p.info = { targetId, type: 'page', ...(openerId ? { openerId } : {}) };
    p.closed = false;
    p.isClosed = () => p.closed;
    p.url = () => 'https://fixture.invalid/' + targetId;
    p.title = async () => targetId;
    p.frames = () => [{ evaluate: async () => 'absent', url: () => 'https://cross-site.invalid/' }];
    p.keyboard = { up: async key => calls.push(['up', key]) };
    p.cdp = Object.assign(new EventEmitter(), { async send(method, params) {
      calls.push([method, params, targetId]);
      if (method === 'Target.getTargetInfo') return { targetInfo: p.info };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-' + targetId };
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      return {};
    }, detach: async () => calls.push(['detach', targetId]) });
    p.goto = async url => { calls.push(['goto', url, targetId]); };
    p.evaluate = async (_fn, name) => {
      if (name && typeof name === 'object' && 'proof' in name) return 'absent';
      if (name !== undefined) { p.windowName = name; return name; }
      return { name: p.windowName ?? '', origin: new URL(p.url()).origin };
    };
    p.close = async () => { calls.push(['close', targetId]); p.closed = true; p.emit('close'); };
    pages.push(p); context.emit('page', p); return p;
  }
  const session = { async send(method, params) {
    calls.push([method, params]);
    assert.equal(method, 'Target.createTarget');
    const targetId = 'target-' + ++sequence;
    page(targetId); return { targetId };
  } };
  const registry = createPageRegistry({ browser, session, timeoutMs: 100, popupWaitMs: 5, canResumeHandoff: async () => true, ...options });
  return { registry, calls, page, pages, session, context };
}

// No browser is launched. Exercise the real dispatcher receipt and owned-tab cleanup together.
async function inputTurn() {
  const f = fixture(), opened = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  let observation = { text: '- button "Done" [ref=e1]', number: 1 }, action = { lines: ['1 click e1: input sent'] }, fields = { rows: [] };
  const d = createToolDispatcher({ pages: f.registry, siteMemory: null,
    snapshot: async () => observation, runSteps: async () => typeof action === 'function' ? action() : action, fillFields: async () => fields });
  const read = async (tab = opened.tab, deliver = true) => {
    const result = await d.call({ name: 'browser_read', arguments: { tab } });
    if (deliver) d.delivered(result);
    return result;
  };
  return { ...f, d, tab: opened.tab, read,
    observe(value) { observation = { ...observation, ...value }; },
    action(value) { action = value; }, fields(value) { fields = value; } };
}

for (const kind of ['dialog', 'modal', 'payment', 'sign-in', 'edited form']) test('turn end preserves the delivered ' + kind + ' for the user', async () => {
  const f = await inputTurn(), entry = f.registry.tab(f.tab), fence = { startedAt: 1 };
  entry.state.submitUnconfirmed = fence;
  let result;
  if (kind === 'dialog') {
    entry.state.dialog = { type: () => 'confirm', message: () => 'Private dialog' };
    f.action({ lines: ['dialog confirm is waiting; message (untrusted page content): "Private dialog"'] });
    result = await f.d.call({ name: 'browser_act', arguments: { tab: f.tab, steps: [{ do: 'click', ref: 'e1' }] } });
  } else if (kind === 'payment') {
    f.action({ lines: ['1 click e1: not run: confirmation required through the trusted consent UI'], confirmation: { step: 1 } });
    result = await f.d.call({ name: 'browser_act', arguments: { tab: f.tab, steps: [{ do: 'click', ref: 'e1' }] } });
  } else if (kind === 'edited form') {
    f.fields({ rows: [{ ref: 'e1', status: 'set' }] });
    result = await f.d.call({ name: 'browser_fill', arguments: { tab: f.tab, fields: [{ ref: 'e1', value: 'Edited' }] } });
  } else {
    f.observe({ pendingUserInput: true });
    result = await f.read(f.tab, false);
  }
  assert.match(result.text, /Tab stays open at turn end for your input\./);
  f.d.delivered(result);
  const beforeEnd = f.calls.length;
  assert.deepEqual(await f.d.end(), { revoked: true, cleanup: [] });
  assert.equal((await f.registry.endTurn()).cleanedUp, true, 'worker cleanup repeats registry cleanup');
  assert.equal(entry.page.isClosed(), false);
  assert.equal(entry.released, false, 'automatic retention never releases target ownership');
  assert.equal(entry.state.submitUnconfirmed, fence, 'retention never clears a submit fence');
  assert.equal(f.calls.slice(beforeEnd).some(row => row[0] === 'detach'), false);
  assert.throws(() => f.registry.tab(f.tab), /ended/);
});

test('ordinary finished pages still close at turn end', async () => {
  const f = await inputTurn(); await f.read(); await f.d.end();
  assert.equal(f.pages[0].isClosed(), true);
});

test('only the last delivered pending tab survives, bounding automatic keeps to one', async () => {
  const f = await inputTurn(), second = await f.registry.openTab({ url: 'https://fixture.invalid/second' });
  f.observe({ pendingUserInput: true });
  await f.read(); await f.read(second.tab); await f.d.end();
  assert.equal(f.pages.filter(page => !page.isClosed()).length, 1);
  assert.equal(f.pages[1].isClosed(), false);
});

for (const delivery of ['missing', 'copied', 'changed']) test('a ' + delivery + ' delivery receipt cannot preserve a pending tab', async () => {
  const f = await inputTurn(); f.observe({ pendingUserInput: true });
  const result = await f.read(f.tab, false);
  if (delivery === 'copied') f.d.delivered({ ...result });
  if (delivery === 'changed') { result.text += '\nchanged'; f.d.delivered(result); }
  await f.d.end(); assert.equal(f.pages[0].isClosed(), true);
});

test('a newer ordinary result replaces a pending result', async () => {
  const f = await inputTurn(); f.observe({ pendingUserInput: true }); await f.read();
  f.observe({ pendingUserInput: false, number: 2 }); await f.read(); await f.d.end();
  assert.equal(f.pages[0].isClosed(), true);
});

test('a delivered form submit clears the earlier edit retention', async () => {
  const f = await inputTurn();
  f.fields({ rows: [{ ref: 'e1', status: 'set' }] });
  const edit = await f.d.call({ name: 'browser_fill', arguments: { tab: f.tab, fields: [{ ref: 'e1', value: 'Edited' }] } });
  f.d.delivered(edit);
  f.fields({ rows: [{ ref: 'e1', status: 'set' }], submitted: { status: 'done' } });
  const submit = await f.d.call({ name: 'browser_fill', arguments: { tab: f.tab, fields: [{ ref: 'e1', value: 'Edited' }], submit: 'e2' } });
  f.d.delivered(submit); await f.d.end(); assert.equal(f.pages[0].isClosed(), true);
});

test('navigation after a delivered pending result invalidates its retention', async () => {
  const f = await inputTurn(); f.observe({ pendingUserInput: true }); await f.read();
  f.pages[0].emit('domcontentloaded'); await f.d.end(); assert.equal(f.pages[0].isClosed(), true);
});

test('a later undelivered call invalidates the earlier pending receipt', async () => {
  const f = await inputTurn(); f.observe({ pendingUserInput: true }); await f.read();
  await f.read(f.tab, false); await f.d.end(); assert.equal(f.pages[0].isClosed(), true);
});

test('edited form state survives a later read without granting another task the tab', async () => {
  const f = await inputTurn();
  f.fields({ rows: [{ ref: 'e1', status: 'set' }] });
  const edit = await f.d.call({ name: 'browser_fill', arguments: { tab: f.tab, fields: [{ ref: 'e1', value: 'Edited' }] } });
  f.d.delivered(edit); await f.read(); await f.d.end(); assert.equal(f.pages[0].isClosed(), false);
  const next = createPageRegistry({ browser: { contexts: () => [f.context] }, session: f.session, timeoutMs: 100, popupWaitMs: 5 });
  assert.deepEqual(await next.list(), []); await next.endTurn();
  assert.equal(f.pages[0].isClosed(), false);
});

test('automatic retention clears viewport emulation and retries failed restoration without closing the tab', async () => {
  const f = await inputTurn(), entry = f.registry.tab(f.tab);
  entry.page.context = () => f.context; entry.page.emulateMedia = async () => {};
  await setViewport(entry.page, { reduced_motion: true });
  const send = entry.cdp.send.bind(entry.cdp); let fail = true;
  entry.cdp.send = async (method, params) => {
    if (fail && method === 'Emulation.setEmulatedMedia') throw Error('restore failed');
    return send(method, params);
  };
  f.observe({ pendingUserInput: true }); await f.read();
  assert.deepEqual((await f.d.end()).cleanup, [{ resource: 'owned-tabs', status: 'retained', code: 'CLEANUP_UNPROVED' }]);
  assert.equal(entry.page.isClosed(), false);
  fail = false;
  assert.equal((await f.registry.endTurn()).cleanedUp, true);
  assert.ok(f.calls.some(row => row[0] === 'Emulation.setEmulatedMedia' && row[1].media === ''));
  assert.equal(entry.page.isClosed(), false);
});

test('a late old receipt cannot replace the newest ordinary result', async () => {
  const f = await inputTurn(); f.observe({ pendingUserInput: true });
  const old = await f.read(f.tab, false);
  f.observe({ pendingUserInput: false, number: 2 }); await f.read();
  f.d.delivered(old); await f.d.end(); assert.equal(f.pages[0].isClosed(), true);
});

test('an edit that navigates cannot mark the new finished document as an unsubmitted form', async () => {
  const f = await inputTurn();
  f.action(() => { f.pages[0].emit('domcontentloaded'); return { lines: ['1 type e1: navigated'], input: { edited: true } }; });
  const result = await f.d.call({ name: 'browser_act', arguments: { tab: f.tab, steps: [{ do: 'type', ref: 'e1', text: 'Edited' }] } });
  f.d.delivered(result); await f.d.end(); assert.equal(f.pages[0].isClosed(), true);
});

test('a payment ask remains pending across a delivered wait and read', async () => {
  const f = await inputTurn();
  f.action({ lines: ['1 click e1: not run: confirmation required through the trusted consent UI'], confirmation: { step: 1 } });
  const ask = await f.d.call({ name: 'browser_act', arguments: { tab: f.tab, steps: [{ do: 'click', ref: 'e1' }] } });
  f.d.delivered(ask); f.action({ lines: ['1 wait: settled'] });
  const wait = await f.d.call({ name: 'browser_act', arguments: { tab: f.tab, steps: [{ do: 'wait' }] } });
  f.d.delivered(wait); await f.read(); await f.d.end(); assert.equal(f.pages[0].isClosed(), false);
});

test('waiting handoff switches hooks off, blocks access, and resumes the same tab with new hooks', async () => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const entry = f.registry.tab(tab), hook = entry.hook;
  const suspended = await f.registry.beginHandoff(tab);
  assert.throws(() => f.registry.tab(tab), /handoff/i);
  assert.ok(f.calls.some(row => row[0] === 'Page.removeScriptToEvaluateOnNewDocument'));
  assert.equal(await suspended.finish(false), tab);
  assert.equal(f.registry.tab(tab), entry);
  assert.notEqual(entry.hook, hook);
  assert.equal(entry.state.snapshotNo, 0);
  assert.equal(await suspended.finish(true), tab, 'finishing twice cannot release a resumed tab');
  assert.equal(f.registry.tab(tab), entry);
  await f.registry.endTurn();
});
test('developer capture stops throughout handoff and starts fresh after Continue', async t => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  t.after(() => f.registry.endTurn());
  const entry = f.registry.tab(tab), before = entry.developer;
  entry.cdp.emit('Runtime.consoleAPICalled', { timestamp: Date.now() + 1, type: 'log', args: [{ type: 'string', value: 'before handoff' }] });
  const suspended = await f.registry.beginHandoff(tab);
  await assert.rejects(before.read({ console: true }), /ended/);
  assert.equal(entry.cdp.listenerCount('Runtime.consoleAPICalled'), 0);
  entry.cdp.emit('Runtime.consoleAPICalled', { timestamp: Date.now() + 1, type: 'log', args: [{ type: 'string', value: 'handoff private' }] });
  assert.equal(await suspended.finish(false), tab);
  assert.notEqual(entry.developer, before);
  entry.cdp.emit('Runtime.consoleAPICalled', { timestamp: Date.now() + 1, type: 'log', args: [{ type: 'string', value: 'resumed ready' }] });
  const text = await entry.developer.read({ console: true });
  assert.match(text, /resumed ready/);
  assert.doesNotMatch(text, /before handoff|handoff private/);
  await f.registry.endTurn();
  assert.equal(entry.cdp.listenerCount('Runtime.consoleAPICalled'), 0);
});

test('cancel and turn end preserve tabs used for the secret handoff', async () => {
  for (const end of [false, true]) {
    const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
    const suspended = await f.registry.beginHandoff(tab);
    if (end) await f.registry.endTurn();
    assert.equal(await suspended.finish(true), null);
    assert.throws(() => f.registry.tab(tab), /unknown|releasing|ended/);
    assert.equal(f.pages[0].closed, false);
  }
});

test('a cancel racing a completed resume preserves tabs and revokes access', async () => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const suspended = await f.registry.beginHandoff(tab);
  assert.equal(await suspended.finish(false), tab);
  await suspended.cancel();
  assert.throws(() => f.registry.tab(tab), /unknown|releasing/);
  await f.registry.endTurn();
  assert.equal(f.pages[0].closed, false);
});

test('an inconclusive secret check keeps every tab suspended until another Continue', async () => {
  let inconclusive = true;
  const f = fixture({ canResumeHandoff: async () => { if (inconclusive) throw Error('frame changed'); return true; } });
  const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const suspended = await f.registry.beginHandoff(tab);
  assert.equal(await suspended.finish(false), false);
  assert.throws(() => f.registry.tab(tab), /handoff.*pending/i);
  inconclusive = false;
  assert.equal(await suspended.finish(false), tab);
  await f.registry.endTurn();
});

test('handoff of a self-closed sign-in popup resumes its owned opener', async () => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const popup = f.page('popup', 'target-1'); await f.registry.idle();
  const child = (await f.registry.list()).find(row => row.targetId === 'popup').tab;
  const suspended = await f.registry.beginHandoff(child);
  await popup.close();
  assert.equal(await suspended.finish(false), tab);
  await f.registry.endTurn();
});

test('handoff detach failure preserves every user tab and reports cleanup unproved', async () => {
  const f = fixture(), first = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  await f.registry.openTab({ url: 'https://fixture.invalid/second' });
  const suspended = await f.registry.beginHandoff(first.tab);
  f.pages[0].cdp.detach = async () => { throw Error('detach failed'); };
  await assert.rejects(suspended.finish(true));
  const cleanup = await f.registry.endTurn();
  assert.equal(cleanup.cleanedUp, false);
  assert.equal(f.pages.some(page => page.closed), false);
});

test('handoff reinstallation failure keeps tabs and never leaves an input-capable registry', async () => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const suspended = await f.registry.beginHandoff(tab), original = f.pages[0].cdp.send;
  f.pages[0].cdp.send = async (method, params) => {
    if (method === 'Page.addScriptToEvaluateOnNewDocument') throw Error('install failed');
    return original(method, params);
  };
  await assert.rejects(suspended.finish(false));
  assert.throws(() => f.registry.tab(tab), /unknown|releasing/);
  await f.registry.endTurn();
  assert.equal(f.pages[0].closed, false);
});

test('resumed tabs and later popups share the registry hook used for cross-window guards', async () => {
  const f = fixture(), first = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const second = await f.registry.openTab({ url: 'https://fixture.invalid/second' });
  const suspended = await f.registry.beginHandoff(first.tab);
  await suspended.finish(false);
  const hook = f.registry.tab(first.tab).hook;
  assert.ok(f.registry.tab(second.tab).hook === hook);
  f.page('later-popup', 'target-1'); await f.registry.idle();
  const child = (await f.registry.list()).find(row => row.targetId === 'later-popup').tab;
  assert.ok(f.registry.tab(child).hook === hook);
  await f.registry.endTurn();
});

test('opens blank in the background, installs the hook before navigation, exposes fixed state', async () => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/start' });
  assert.match(tab, /^t/);
  assert.deepEqual(f.registry.tab(tab).state, { snapshotNo: 0, submitUnconfirmed: false });
  assert.deepEqual(f.calls[0], ['Target.createTarget', { url: 'about:blank', background: true }]);
  const install = f.calls.findIndex(c => c[0] === 'Page.addScriptToEvaluateOnNewDocument');
  assert.ok(install >= 0 && install < f.calls.findIndex(c => c[0] === 'goto'));
  assert.ok(f.calls.some(c => c[0] === 'Emulation.setFocusEmulationEnabled' && c[1].enabled));
  await f.registry.endTurn();
});

test('FD3B native navigation reports attempts and an unexpectedly detached auxiliary session reattaches only its owned target', async () => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/start' }), entry = f.registry.tab(tab);
  const first = entry.cdp, next = Object.assign(new EventEmitter(), { send: first.send.bind(first), detach: first.detach });
  f.context.newCDPSession = async page => { assert.equal(page, entry.page); return next; };
  first.emit('Page.frameRequestedNavigation', { frameId: 'fixture', url: 'mailto:fixture@example.invalid', reason: 'scriptInitiated' });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(f.calls.some(row => row[0] === 'Page.stopLoading'));
  assert.equal(entry.state.nativeNavigationNo, 1);
  first.emit('close'); await f.registry.idle();
  assert.equal(entry.cdp, next); assert.equal(f.registry.tab(tab), entry);
  assert.equal(f.calls.filter(row => row[0] === 'Target.createTarget').length, 1);
  assert.equal(entry.state.nativeAttachmentLost, false);
  await f.registry.keep(tab); next.emit('close'); await f.registry.idle();
  assert.equal(entry.cdp, next, 'release must not trigger reattachment');
  await f.registry.endTurn();
});
test('developer capture follows only the verified replacement session after detach', async t => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  t.after(() => f.registry.endTurn());
  const entry = f.registry.tab(tab), before = entry.developer, first = entry.cdp;
  const next = Object.assign(new EventEmitter(), { send: first.send.bind(first), detach: first.detach });
  f.context.newCDPSession = async () => next;
  first.emit('close'); await f.registry.idle();
  await assert.rejects(before.read({ console: true }), /ended/);
  assert.equal(first.listenerCount('Runtime.consoleAPICalled'), 0);
  assert.notEqual(entry.developer, before);
  first.emit('Runtime.consoleAPICalled', { timestamp: Date.now() + 1, type: 'log', args: [{ type: 'string', value: 'stale private' }] });
  next.emit('Runtime.consoleAPICalled', { timestamp: Date.now() + 1, type: 'log', args: [{ type: 'string', value: 'current ready' }] });
  const text = await entry.developer.read({ console: true });
  assert.match(text, /current ready/); assert.doesNotMatch(text, /stale private/);
});

test('FD5 failed media restoration prevents a browser keep from releasing ownership', async () => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/start' });
  const entry = f.registry.tab(tab); let fail = false;
  // VP1 clears media over CDP, so the failure comes from that call.
  entry.page.emulateMedia = async () => {};
  entry.page.context = () => f.context;
  const send = entry.page.cdp.send.bind(entry.page.cdp);
  entry.page.cdp.send = async (method, params) => {
    if (fail && method === 'Emulation.setEmulatedMedia') throw Error('restore failed');
    return send(method, params);
  };
  await setViewport(entry.page, { reduced_motion: true }); fail = true;
  await assert.rejects(f.registry.keep(tab), /restore failed/);
  assert.equal(f.registry.tab(tab), entry); assert.equal(entry.released, false);
  fail = false; await f.registry.keep(tab); assert.equal(entry.released, true);
  assert.equal((await f.registry.endTurn()).cleanedUp, true);
});

test('FD3C failed reattachment clears dead handles and permits keep, handoff and release', async () => {
  for (const stage of ['attach', 'identity', 'install']) for (const kind of ['keep', 'handoff', 'waiting']) {
    const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/start' }), entry = f.registry.tab(tab);
    const first = entry.cdp, original = first.send.bind(first);
    const next = Object.assign(new EventEmitter(), { detach: async () => {}, send: async (method, params) => {
      if (stage === 'identity' || stage === 'install' && method === 'Page.addScriptToEvaluateOnNewDocument') throw Error('reattach failed');
      return original(method, params);
    } });
    f.context.newCDPSession = async () => { if (stage === 'attach') throw Error('reattach failed'); return next; };
    first.send = async () => { throw Error('dead session'); };
    first.emit('close'); await f.registry.idle();
    assert.equal(entry.cdp, null, stage);
    assert.equal(entry.script, null, stage);
    await assert.rejects(entry.checkAttachment(), /dead.*cleared/i);
    if (kind === 'waiting') { const suspended = await f.registry.beginHandoff(tab); await suspended.finish(true); }
    else await f.registry[kind](tab);
    assert.equal(entry.released, true);
    assert.equal(entry.page.closed, false);
    assert.equal((await f.registry.endTurn()).cleanedUp, true);
  }
});

test('FD3C a main-frame load retries failed Fetch cleanup without throwing or acting on child loads', async () => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/start' }), entry = f.registry.tab(tab);
  entry.state.recoveryFetchDisablePending = true; entry.state.recoveryFrameId = 'main';
  entry.cdp.emit('Page.frameStartedLoading', { frameId: 'child' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(row => row[0] === 'Fetch.disable').length, 0);
  entry.cdp.emit('Page.frameStartedLoading', { frameId: 'main' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(row => row[0] === 'Fetch.disable').length, 1);
  assert.equal(entry.state.recoveryFetchDisablePending, false);
  await f.registry.endTurn();
});

test('FD5B keep reports an unknown original size after safely clearing the override', async () => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/start' });
  const entry = f.registry.tab(tab);
  entry.page.context = () => f.context;
  entry.page.setViewportSize = async () => {};
  await setViewport(entry.page, { width: 390, height: 844 });
  assert.match((await f.registry.keep(tab)).viewport, /previous size unknown/);
  assert.ok(f.calls.some(call => call[0] === 'Emulation.clearDeviceMetricsOverride'));
  assert.equal(entry.released, true);
  assert.equal((await f.registry.endTurn()).cleanedUp, true);
});

test('open phase events bracket allocation, attachment, adoption, readiness and navigation without page data', async () => {
  const f = fixture(), phases = [];
  await f.registry.openTab({ url: 'https://fixture.invalid/private', tracePhase: phase => phases.push([phase, f.calls.at(-1)?.[0]]) });
  assert.deepEqual(phases.map(row => row[0]), ['browser-open-create-start', 'browser-open-create-end', 'browser-open-attach-end',
    'browser-open-identify-end', 'browser-open-adopt-end', 'browser-open-ready-end', 'browser-open-goto-start', 'browser-open-navigated', 'browser-open-goto-end']);
  assert.equal(phases[0][1], undefined);
  assert.equal(phases.at(-1)[1], 'goto');
  assert.doesNotMatch(JSON.stringify(phases), /private|fixture\.invalid/);
  await f.registry.endTurn();
});

test('an unsuccessful goto retains the tab without reporting the navigated phase', async () => {
  const f = fixture(), phases = [];
  f.context.on('page', page => { page.goto = async () => { throw Error('navigation failed'); }; });
  await assert.rejects(f.registry.openTab({ url: 'https://fixture.invalid/private', tracePhase: phase => phases.push(phase) }),
    error => error.message === 'navigation failed' && typeof error.ownedTab === 'string');
  assert.equal(phases.at(-1), 'browser-open-goto-start');
  assert.ok(!phases.includes('browser-open-navigated'));
  assert.equal(f.pages[0].closed, false);
  assert.equal((await f.registry.endTurn()).cleanedUp, true);
});

test('never exposes an existing user page or a popup with a foreign opener', async () => {
  const f = fixture(); f.page('user'); f.page('foreign', 'user');
  await f.registry.idle();
  assert.deepEqual(await f.registry.list(), []);
  assert.throws(() => f.registry.tab('user'), /unknown|owned/i);
  await f.registry.endTurn();
  assert.equal(f.pages.some(p => p.closed), false);
});

test('developer capture starts on owned tabs before navigation and stops on keep, close and turn end', async () => {
  const f = fixture(), foreign = f.page('foreign');
  const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/start' });
  const entry = f.registry.tab(tab), developer = entry.developer;
  assert.ok(developer);
  for (const method of ['Runtime.enable', 'Network.enable'])
    assert.ok(f.calls.findIndex(c => c[0] === method) < f.calls.findIndex(c => c[0] === 'goto'));
  assert.equal(foreign.cdp.listenerCount('Runtime.consoleAPICalled'), 0);
  await f.registry.keep(tab);
  assert.equal(entry.cdp.listenerCount('Runtime.consoleAPICalled'), 0);
  await assert.rejects(developer.read({ console: true }), /ended/);
  const second = await f.registry.openTab({ url: 'https://fixture.invalid/second' });
  const closed = f.registry.tab(second.tab).developer;
  await f.registry.close(second.tab); await assert.rejects(closed.read({ network: true }), /ended/);
  const third = await f.registry.openTab({ url: 'https://fixture.invalid/third' });
  const ended = f.registry.tab(third.tab).developer;
  await f.registry.endTurn(); await assert.rejects(ended.read({ performance: true }), /ended/);
});

test('adopts only a popup whose CDP opener is owned, retaining opener through self-close', async () => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const popup = f.page('popup', 'target-1'); await f.registry.idle();
  const rows = await f.registry.list(), child = rows.find(r => r.targetId === 'popup');
  assert.equal(child.opener, tab);
  assert.equal(f.registry.tab(child.tab).page, popup);
  await popup.close();
  assert.equal(f.registry.tab(tab).popups.at(-1).closed, true);
  assert.equal(f.registry.tab(tab).popups.at(-1).opener, tab);
  assert.throws(() => f.registry.tab(child.tab), /closed/i);
  await f.registry.endTurn();
});

test('closedOpener names the owned opener of a tab the page closed itself, and nothing else', async () => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  assert.equal(f.registry.closedOpener(tab), undefined); // open, no opener
  const popup = f.page('popup', 'target-1'); await f.registry.idle();
  const child = (await f.registry.list()).find(r => r.targetId === 'popup').tab;
  assert.equal(f.registry.closedOpener(child), undefined); // still open
  await popup.close();
  assert.equal(f.registry.closedOpener(child), tab);
  assert.equal(f.registry.closedOpener('tnone'), undefined);
  const mine = f.page('mine', 'target-1'); await f.registry.idle();
  const closedByUs = (await f.registry.list()).find(r => r.targetId === 'mine').tab;
  await f.registry.close(closedByUs); // sleight's own close is not the page's
  assert.equal(f.registry.closedOpener(closedByUs), undefined);
  f.pages.find(p => p.info.targetId === 'target-1').closed = true; // a closed opener has nothing to read
  assert.equal(f.registry.closedOpener(child), undefined);
  await f.registry.endTurn();
});

test('adopts popup descendants and does not duplicate a named popup', async () => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const popup = f.page('popup', 'target-1'); await f.registry.idle();
  const child = (await f.registry.list()).find(r => r.targetId === 'popup');
  f.page('grandchild', 'popup'); await f.registry.idle();
  assert.equal((await f.registry.list()).find(r => r.targetId === 'grandchild').opener, child.tab);
  popup.emit('domcontentloaded'); await f.registry.idle();
  assert.equal(f.registry.tab(tab).popups.length, 1);
  await f.registry.endTurn();
});

test('turn end closes owned pages, preserves keep and handoff, and removes their hooks', async () => {
  const f = fixture(); f.page('user');
  const a = await f.registry.openTab({ url: 'https://fixture.invalid/a' });
  const b = await f.registry.openTab({ url: 'https://fixture.invalid/b' });
  const c = await f.registry.openTab({ url: 'https://fixture.invalid/c' });
  await f.registry.keep(b.tab); await f.registry.handoff(c.tab);
  const result = await f.registry.endTurn();
  assert.equal(result.cleanedUp, true);
  assert.equal(f.pages.find(p => p.info.targetId === 'target-1').closed, true);
  for (const id of ['user', 'target-2', 'target-3']) assert.equal(f.pages.find(p => p.info.targetId === id).closed, false);
  assert.equal(f.calls.filter(c => c[0] === 'Page.removeScriptToEvaluateOnNewDocument').length, 2);
  assert.throws(() => f.registry.tab(a.tab), /closed|ended/i);
  await assert.rejects(f.registry.openTab({ url: 'https://fixture.invalid/' }), /ended/i);
});

test('failed cleanup stays retryable and never claims closure', async () => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const p = f.registry.tab(tab).page, close = p.close;
  p.close = async () => { throw Error('busy'); };
  assert.equal((await f.registry.endTurn()).cleanedUp, false);
  p.close = close;
  assert.equal((await f.registry.endTurn()).cleanedUp, true);
});

test('per-tab queues serialize mutations and recover after a failed task', async () => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const order = [];
  const a = f.registry.enqueue(tab, async () => { order.push(1); await new Promise(r => setTimeout(r, 5)); order.push(2); throw Error('failure'); });
  const b = f.registry.enqueue(tab, async () => { order.push(3); return 4; });
  await assert.rejects(a, /failure/); assert.equal(await b, 4); assert.deepEqual(order, [1, 2, 3]);
  await f.registry.endTurn();
});

test('invalid URLs allocate nothing', async () => {
  const f = fixture();
  for (const url of ['javascript:alert(1)', 'file:///tmp/fixture', 'https://user:password@fixture.invalid/'])
    await assert.rejects(f.registry.openTab({ url }), /URL/i);
  assert.deepEqual(f.calls, []); await f.registry.endTurn();
});

function clickFixture(probe) {
  const calls = [], entry = { page: { keyboard: { up: async key => calls.push(['up', key]) },
    evaluate: async (fn, arg) => { calls.push(['disarm']); return hookAnswer(entry.hook, fn, arg); } }, popups: [], popupWaitMs: 1 };
  Object.defineProperty(entry, 'hook', { value: newHook(), enumerable: false });
  const locator = { evaluate: async (fn, arg) => hookAnswer(entry.hook, fn, arg, { prepare: probe }) };
  return { calls, entry, locator };
}

test('MTb missing popup hooks keep capability routing advice', () => {
  for (const call of [() => hookSource({}), () => hookProof({}, 'prepare')])
    assert.throws(call, /background popup hook unavailable; use the engine browser path/);
});
test('MTb unavailable click guard keeps capability routing and sends nothing', async () => {
  const f = clickFixture(true), evaluate = f.locator.evaluate;
  f.locator.evaluate = (fn, arg) => arg?.guard ? hookAnswer(f.entry.hook, fn, arg, { guard: false }) : evaluate(fn, arg);
  await assert.rejects(backgroundClick(f.entry, f.locator, async () => f.calls.push(['click'])), /click guard unavailable; use the engine browser path/);
  assert.equal(f.calls.filter(row => row[0] === 'click').length, 0);
});
test('MTb missing owned registry keeps capability routing without replaying a link', async () => {
  const f = clickFixture({ kind: 'link' });
  f.entry.page.evaluate = async (fn, arg) => hookAnswer(f.entry.hook, fn, arg, { request: { url: 'https://fixture.invalid/' } });
  await assert.rejects(backgroundClick(f.entry, f.locator, async () => f.calls.push(['click'])), /owned page registry; use the engine browser path/);
  assert.equal(f.calls.filter(row => row[0] === 'click').length, 1);
});

test('same-tab links receive an ordinary Playwright click', async () => {
  const f = clickFixture(false);
  const value = await backgroundClick(f.entry, f.locator, async options => { f.calls.push(['click', options]); return 'landed'; });
  assert.equal(value, 'landed'); assert.deepEqual(f.calls, [['click', {}], ['disarm']]);
});

test('popup-intent click carries background modifier, then always releases and disarms', async () => {
  const f = clickFixture(true);
  await backgroundClick(f.entry, f.locator, async options => f.calls.push(['click', options]));
  assert.deepEqual(f.calls, [['click', { modifiers: ['ControlOrMeta'] }], ['up', 'ControlOrMeta'], ['disarm']]);
});

test('throwing popup click is never replayed and still releases its modifier', async () => {
  const f = clickFixture(true);
  await assert.rejects(backgroundClick(f.entry, f.locator, async options => { f.calls.push(['click', options]); throw Error('dispatch uncertain'); }), /dispatch uncertain/);
  assert.equal(f.calls.filter(c => c[0] === 'click').length, 1);
  assert.deepEqual(f.calls.slice(-2), [['up', 'ControlOrMeta'], ['disarm']]);
});

test('unproved popup preparation refuses before input and disarms a possible late probe', async () => {
  const f = clickFixture(false); f.locator.evaluate = async () => { throw Error('probe timed out'); };
  await assert.rejects(backgroundClick(f.entry, f.locator, async () => f.calls.push(['click'])), /background|prepare/i);
  assert.deepEqual(f.calls, [['disarm']]);
});

function hookFixture({ clock = Date, handle, credentials: given, parent, rewritable = false, children = [], fresh = false, globals = {}, windowProps = {} } = {}) {
  class Event {
    get defaultPrevented() { return !!this.nativePrevented; }
    get returnValue() { return !this.nativePrevented; }
    set returnValue(value) { if (!value) this.nativePrevented = true; }
    preventDefault() { this.nativePrevented = true; }
    composedPath() { return this.nodes; }
    stopPropagation() { this.propagationStopped = true; }
    stopImmediatePropagation() { this.stopped = this.propagationStopped = true; }
  }
  class MouseEvent extends Event {
    constructor(type = 'click') { super(); this.type = type; }
    get ctrlKey() { return this.control; }
    get metaKey() { return this.meta; }
    getModifierState(name) { return name === 'Control' ? this.control : this.meta; }
  }
  class Element {
    constructor(localName = 'button', attrs = {}) { Object.assign(this, { localName, attrs, isConnected: true }); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
    querySelectorAll() { return (this.children ?? []).flatMap(child => [child, ...child.querySelectorAll('*')]); }
    matches() { return !!this.interactive; }
    getRootNode() { return {}; }
    scrollIntoView(options) { (this.scrolls ??= []).push(options.block); }
    getBoundingClientRect() { return this.rect ?? { x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0 }; }
    blur() { this.blurred = true; if (!this.keepsFocus && document.activeElement === this) document.activeElement = null; }
    get isContentEditable() {
      for (let node = this; node; node = node.parentElement ?? node.getRootNode().host) {
        if (node.attrs.contenteditable === 'false') return false;
        if (Object.hasOwn(node.attrs, 'contenteditable')) return true;
      }
      return document.designMode === 'on';
    }
  }
  class HTMLButtonElement extends Element {
    constructor(attrs = {}, form) { super('button', attrs); this.nativeForm = form; }
    get form() { return this.nativeForm ?? null; }
    get type() { const type = (this.attrs.type ?? '').toLowerCase(); return ['button', 'reset'].includes(type) ? type : 'submit'; }
  }
  class HTMLInputElement extends Element {
    constructor(attrs = {}, form) { super('input', attrs); this.nativeForm = form; }
    get form() { return this.nativeForm ?? null; }
    get type() { return (this.attrs.type ?? 'text').toLowerCase(); }
  }
  class HTMLSelectElement extends Element {
    constructor(attrs = {}) { super('select', attrs); }
    get multiple() { return Object.hasOwn(this.attrs, 'multiple'); }
  }
  class HTMLLabelElement extends Element {
    constructor(control) { super('label'); this.nativeControl = control; }
    get control() { return this.nativeControl ?? null; }
  }
  class EventTarget {
    addEventListener(name, fn, capture) {
      (this.listeners[name] ??= new Set()).add(fn);
      if (capture) (this.captureListeners[name] ??= new Set()).add(fn);
    }
    removeEventListener(name, fn) { this.listeners[name]?.delete(fn); this.captureListeners[name]?.delete(fn); }
  }
  // The page's mutation observer: tests call `callback` themselves, standing in for the microtask after a listener.
  const observers = [];
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() { this.observing = true; }
    disconnect() { this.disconnected = true; }
  }
  const opens = [], window = { listeners: {}, captureListeners: {}, parent, open(...args) { opens.push(args); return handle ?? { real: true }; } };
  Object.assign(window, windowProps);
  const navigator = { userActivation: { isActive: true } };
  // Child windows by index and a native length getter, as a window has them; `fresh` is a document no script has run in yet.
  if (children.length) { Object.defineProperty(window, 'length', { get: () => children.length }); children.forEach((child, index) => { window[index] = child; }); }
  const document = { baseURI: 'https://fixture.invalid/', scripts: fresh ? [] : [{ textContent: "window.open('/identity')" }], querySelector: () => null };
  // document.open() erases every listener on its window; a fixture asks for it with `rewritable`.
  class Document {
    open() { window.listeners = {}; window.captureListeners = {}; }
    write() { this.open(); }
    writeln() { this.open(); }
    get defaultView() { return window; }
  }
  if (rewritable) Object.setPrototypeOf(document, Document.prototype);
  const credentials = given ?? newHook();
  const context = vm.createContext({ window, document, navigator,
    MouseEvent, Element, HTMLElement: Element, ...(rewritable ? { Document } : {}), HTMLButtonElement, HTMLInputElement, HTMLSelectElement, HTMLLabelElement,
    Event, EventTarget, MutationObserver, URL, Date: clock, setTimeout, clearTimeout, queueMicrotask, ...globals });
  const installed = vm.runInContext(hookSource(credentials), context);
  const raw = window[credentials.key];
  // Each call carries its own proof, as the controller sends it; tests that look at the proof use raw.
  // A watch (a plain same-context click the hook only observes) reads as the plain click earlier tests mean, so those
  // tests keep asserting "no modifier, no capture"; tests that look at a watch call f.call('prepare', ...).
  const call = (name, ...args) => {
    const answer = raw[name](hookProof(credentials, name), ...args);
    if (name === 'cancel') return answer;
    return answer && typeof answer.then === 'function' ? answer.then(value => hookOpen(credentials, value)) : hookOpen(credentials, answer);
  };
  const hook = Object.fromEntries(['guard', 'reveal', 'settle', 'verdict', 'prepare', 'takeRequest', 'finish', 'cancel', 'take', 'off']
    .map(name => [name, (...args) => { const result = call(name, ...args); return name === 'prepare' && result?.kind === 'watch' ? false : result; }]));
  return { window, document, navigator, hook, raw, call, credentials, context, installed, Element, HTMLButtonElement, HTMLInputElement, HTMLSelectElement, HTMLLabelElement,
    MouseEvent, Event, EventTarget, opens, observers };
}

test('LR1D whole guard refuses saved SharedWorker constructors, counts attempts, expires and restores', () => {
  let now = 0, constructions = 0;
  class SharedWorker { constructor() { constructions++; } }
  const f = hookFixture({ clock: { now: () => now }, globals: { SharedWorker }, windowProps: { navigation: { listeners: {}, captureListeners: {} } } });
  vm.runInContext('savedWorker = SharedWorker', f.context);
  assert.equal(f.call('whole', 'read', 1000), true);
  assert.equal(f.call('whole', 'read', 1000), true, 'frame installation may repeat the same token');
  assert.throws(() => vm.runInContext('new savedWorker()', f.context), /SharedWorker creation/);
  assert.throws(() => vm.runInContext('new SharedWorker.prototype.constructor()', f.context), /SharedWorker creation/);
  assert.equal(constructions, 0);
  assert.equal(f.call('wholeTake'), '\n2\n0\n0');
  assert.equal(f.call('wholeTake'), '\n0\n0\n0');
  assert.throws(() => f.raw.wholeWorker('forged'), /refused the call/);
  now = 1001; vm.runInContext('new savedWorker()', f.context); assert.equal(constructions, 1);
  assert.equal(f.call('whole', 'read', 0), true);
  f.call('off'); assert.equal(vm.runInContext('SharedWorker', f.context), SharedWorker);
  assert.equal(SharedWorker.prototype.constructor, SharedWorker);
});

// A frame created while its parent is armed reads the parent's state at install; the answer must be the hook's own.
test('AD1 a child frame inherits its parent\'s armed state only from a signed answer', () => {
  const parent = hookFixture();
  parent.call('adopt', 'tok', 60000, false);
  try {
    const child = hookFixture({ credentials: parent.credentials, parent: parent.window });
    try { assert.equal(child.call('armed')?.token, 'tok', 'a genuine parent arms the child'); } finally { child.call('release', 'tok'); }
    const until = Date.now() + 60000, key = parent.credentials.key;
    for (const [name, answer] of [
      ['unsigned', 'x.' + '0'.repeat(64) + '.atok\0' + until + '\0f'],
      ['not a string', { token: 'tok', until, keys: false }],
      ['signed for another method', parent.window[key].verdict(hookProof(parent.credentials, 'verdict'), 'tok')],
      ['right nonce, wrong tag', proof => proof.slice(0, proof.indexOf('.')) + '.' + '0'.repeat(64) + '.atok\0' + until + '\0f'],
    ]) {
      const forged = hookFixture({ credentials: parent.credentials, parent: { [key]: { armed: proof => typeof answer === 'function' ? answer(proof) : answer } } });
      assert.equal(forged.call('armed'), undefined, name + ' answer arms nothing');
    }
  } finally { parent.call('release', 'tok'); }
});

// The key path (backgroundClick with keys): locks, resync and the walk over child windows, every call with a proof and every
// answer signed. A trusted key is a keydown the page's listeners see, cancelled by the lock's own listener.
const trustedKey = (f, type = 'keydown') => {
  const event = Object.assign(new f.Event(), { type, key: 'Enter', isTrusted: true, nodes: [] });
  for (const fn of f.window.captureListeners[type] ?? []) fn(event);
  return event;
};
test('AD1 kb lock: a locked window cancels every trusted key and reports it once released, and refuses a retired token or a bad cap', () => {
  const f = hookFixture({ fresh: true });
  assert.equal(f.call('lock', 'k1', 60000), true);
  const down = trustedKey(f), up = trustedKey(f, 'keyup');
  assert.ok(down.stopped && down.nativePrevented && up.nativePrevented, 'the keys are cancelled');
  // (This fixture has no native Event.type getter, so the shield cancels with its fail-closed reason; the real-browser bank checks the deny texts.)
  assert.equal(typeof f.call('release', 'k1'), 'string', 'the veto is reported');
  assert.equal(f.call('lock', 'k1', 60000), false, 'a released token is retired');
  f.call('adopt', 'k2', 60000, false); // (this fixture cannot dispatch the liveness probe, so adopt and guard answer false here)
  assert.equal(f.call('lock', 'k2', 60000), true, 'a lock replaces a foreign shield of the same token');
  assert.equal(f.call('release', 'k2'), undefined, 'a key never pressed reports nothing');
  for (const [name, args] of [['lock', ['k9', 0]], ['lock', ['k9', Infinity]], ['resync', ['k9', -1]]]) assert.equal(f.call(name, ...args), false, name + ' ' + args);
});

test('AD1 kb walk: tree, lockAll, resyncAll and finishAll visit this window and the children that answer with the hook\'s own signature', () => {
  const sibling = hookFixture({ fresh: true }), credentials = sibling.credentials;
  const child = hookFixture({ credentials, fresh: true }), late = hookFixture({ credentials, fresh: false });
  const parent = hookFixture({ credentials, fresh: true, children: [child.window, late.window] });
  const tree = parent.call('tree');
  assert.equal(tree.length, 3);
  assert.deepEqual(tree.map(node => [node.n, node.fresh]), [[2, true], [0, true], [0, false]]);
  assert.equal(new Set(tree.map(node => node.id)).size, 3, 'each window has its own id');
  assert.equal(parent.call('lockAll', 't1', 60000, tree[0].id), true);
  assert.ok(trustedKey(child).nativePrevented && trustedKey(late).nativePrevented, 'the children are locked');
  assert.ok(!trustedKey(parent).nativePrevented, 'the skipped window is not');
  assert.equal(parent.call('resyncAll', 't1', 60000), true);
  const found = parent.call('finishAll', 't1');
  assert.deepEqual(found.map(([id]) => id).sort(), [tree[1].id, tree[2].id].sort());
  assert.ok(found.every(([, reason]) => typeof reason === 'string'));
  assert.deepEqual(parent.call('finishAll', 't1'), [], 'released windows report nothing the second time');
});

test('AD1 kb walk: a child that answers with anything but a signed answer for that call is a window with no hook, and arms and releases nothing', () => {
  const key = hookFixture().credentials.key;
  const credentials = hookFixture().credentials;
  const genuine = hookFixture({ credentials, fresh: true });
  for (const [name, answer] of [
    ['unsigned', () => 'x.' + '0'.repeat(64) + '.i0'],
    ['not a string', () => ({ id: 'x', n: 0, fresh: true })],
    ['signed for another method', proof => genuine.window[key].verdict(hookProof(credentials, 'verdict'), 'tok')],
    ['throws', () => { throw Error('cross-origin'); }],
  ]) {
    const forged = { [key]: { info: answer, lock: () => 't', resync: () => 't', release: () => 'u' } };
    const parent = hookFixture({ credentials, fresh: true, children: [forged] });
    assert.deepEqual(parent.call('tree').map(node => node.id === null), [false, true], name);
    assert.equal(parent.call('lockAll', 't2', 60000, null), false, name + ': a window that cannot be vouched for is not guarded');
    parent.call('release', 't2');
  }
  // A child with no hook object at all is the same; one that throws on access (another origin) is left to its own route.
  const bare = hookFixture({ credentials, fresh: true, children: [{}] });
  assert.deepEqual(bare.call('tree').map(node => node.id === null), [false, true]);
  const hidden = hookFixture({ credentials, fresh: true, children: [new Proxy({}, { get() { throw Error('cross-origin'); } })] });
  assert.equal(hidden.call('tree').length, 1);
});

test('CR8 pointer events stay plain when their first modifier read is after dispatch', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = hookFixture(), button = new f.Element(), retained = [];
  const types = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  const read = event => [event.ctrlKey, event.metaKey, event.getModifierState('Control'), event.getModifierState('Meta')];
  try {
    f.hook.prepare(button, 'pointer', 1000);
    for (const fn of f.window.listeners.keydown) fn(Object.assign(new f.Event(), { key: 'Meta', type: 'keydown', isTrusted: true }));
    for (const type of types) {
      const event = Object.assign(new f.MouseEvent(), { type, nodes: [button], isTrusted: true, control: true, meta: true });
      for (const fn of f.window.captureListeners[type] ?? []) fn(event);
      // Native composedPath is empty once dispatch has finished. No modifier
      // getter ran in the page's synchronous handler.
      event.nodes = []; retained.push(event);
    }
    t.mock.timers.tick(0);
    assert.equal(retained.find(event => event.type === 'mouseup').metaKey, false, 'deferred mouseup.metaKey');
    for (const event of retained) assert.deepEqual(read(event), [false, false, false, false], event.type);
    f.hook.finish('pointer');
    f.hook.prepare(button, 'next', 1000);
    for (const event of retained) assert.deepEqual(read(event), [false, false, false, false], event.type + ' after retirement');
  } finally { f.hook.off(); }
  for (const type of types) assert.equal(f.window.captureListeners[type]?.size ?? 0, 0, type + ' listener removed');
});

for (const [modifier, control] of [['Meta', true], ['Control', true], ['Control', false]]) test(`explicit ${modifier} clicks keep the requested modifier visible after retirement (native Control: ${control})`, t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = hookFixture(), option = new f.Element('div', { role: 'option' }), events = [];
  try {
    f.hook.prepare(option, 'explicit', 1000, false, modifier);
    for (const key of ['Meta', 'Control']) for (const fn of f.window.listeners.keydown)
      fn(Object.assign(new f.Event(), { key, type: 'keydown', isTrusted: true }));
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const event = Object.assign(new f.MouseEvent(), { type, nodes: [option], isTrusted: true, control, meta: true });
      for (const fn of f.window.captureListeners[type] ?? []) fn(event);
      event.nodes = []; events.push(event);
    }
    t.mock.timers.tick(0); f.hook.finish('explicit');
    f.hook.prepare(option, 'next', 1000);
    for (const event of events) assert.deepEqual([event.ctrlKey, event.metaKey, event.getModifierState('Control'), event.getModifierState('Meta')],
      modifier === 'Meta' ? [false, true, false, true] : [true, false, true, false]);
  } finally { f.hook.off(); }
});

test('explicit modifier clicks on links refuse before a native foreground action can run', () => {
  const f = hookFixture();
  try {
    const link = new f.Element('a', { href: '/destination' });
    assert.deepEqual(f.hook.prepare(link, 'explicit-link', 1000, false, 'Shift'), { kind: 'refuse', reason: 'modifier' });
  } finally { f.hook.off(); }
});

test('the Control carrier changes only trusted events on its armed target and restores native getters on teardown', () => {
  const f = hookFixture(), option = new f.Element('div', { role: 'option' }), other = new f.Element('div');
  const read = event => [event.ctrlKey, event.metaKey, event.getModifierState('Control'), event.getModifierState('Meta')];
  const event = (node, trusted) => Object.assign(new f.MouseEvent(), { nodes: [node], isTrusted: trusted, control: false, meta: true });
  const retained = event(option, true);
  try {
    f.hook.prepare(option, 'carrier', 1000, false, 'Control');
    for (const fn of f.window.listeners.keydown) fn(Object.assign(new f.Event(), { key: 'Meta', type: 'keydown', isTrusted: true }));
    assert.deepEqual(read(event(other, true)), [false, true, false, true]);
    assert.deepEqual(read(event(option, false)), [false, true, false, true]);
    assert.deepEqual(read(retained), [true, false, true, false]);
    f.hook.finish('carrier');
    assert.deepEqual(read(event(option, true)), [false, true, false, true]);
    assert.deepEqual(read(retained), [true, false, true, false]);
  } finally { f.hook.off(); }
  assert.deepEqual(read(retained), [false, true, false, true]);
});

for (const modifier of ['Meta', 'Control']) test(`explicit ${modifier} refuses links, controls and forwarded submits throughout the target tree`, () => {
  const f = hookFixture();
  try {
    const form = new f.Element('form'), submit = new f.HTMLButtonElement({}, form), label = new f.HTMLLabelElement(submit);
    const link = new f.Element('a', { href: '/destination' });
    const targets = [submit, label, link, new f.HTMLInputElement({ type: 'checkbox' }), new f.HTMLSelectElement({ multiple: '' }),
      new f.Element('textarea'), new f.Element('div', { role: 'button' })];
    for (const target of targets) {
      const inside = new f.Element('span'); inside.parentElement = target;
      const around = new f.Element('div'); around.children = [target];
      for (const element of [target, inside, around])
        assert.deepEqual(f.call('prepare', element, 'refused', 1000, false, modifier), { kind: 'refuse', reason: 'modifier' }, target.localName);
    }
    assert.deepEqual(f.opens, []);
  } finally { f.hook.off(); }
});

for (const modifier of ['Shift', 'Alt']) test(`explicit ${modifier} refuses even a plain ARIA option`, () => {
  const f = hookFixture();
  try { assert.deepEqual(f.hook.prepare(new f.Element('div', { role: 'option' }), 'bad-key', 1000, false, modifier), { kind: 'refuse', reason: 'modifier' }); }
  finally { f.hook.off(); }
});

test('explicit modifiers refuse inline window.open handlers and block indirect opens during dispatch', () => {
  const f = hookFixture();
  try {
    const option = new f.Element('div', { role: 'option', onclick: "window.open('/destination')" });
    assert.deepEqual(f.hook.prepare(option, 'inline-open', 1000, false, 'Meta'), { kind: 'refuse', reason: 'modifier' });
    delete option.attrs.onclick;
    option.onclick = () => window.open('/destination');
    assert.deepEqual(f.hook.prepare(option, 'property-open', 1000, false, 'Control'), { kind: 'refuse', reason: 'modifier' });
    delete option.onclick;
    assert.equal(f.hook.prepare(option, 'indirect-open', 1000, false, 'Meta'), true);
    const event = Object.assign(new f.MouseEvent(), { type: 'click', nodes: [option], isTrusted: true });
    for (const fn of f.window.listeners.click) fn(event);
    assert.equal(f.window.open('/destination', '_blank'), null);
    assert.deepEqual(f.opens, []);
  } finally { f.hook.off(); }
});

test('explicit modifiers refuse registered window.open listeners and allow a removed listener', () => {
  const f = hookFixture(), option = new f.Element('div', { role: 'option' });
  const listener = () => window.open('/destination');
  option.listeners = {}; option.captureListeners = {};
  try {
    f.EventTarget.prototype.addEventListener.call(option, 'click', listener);
    assert.deepEqual(f.hook.prepare(option, 'registered-open', 1000, false, 'Meta'), { kind: 'refuse', reason: 'modifier' });
    f.EventTarget.prototype.removeEventListener.call(option, 'click', listener);
    assert.equal(f.hook.prepare(option, 'removed-open', 1000, false, 'Meta'), true);
    f.hook.finish('removed-open');
    f.EventTarget.prototype.addEventListener.call(f.window, 'click', listener);
    assert.deepEqual(f.hook.prepare(option, 'delegated-open', 1000, false, 'Control'), { kind: 'refuse', reason: 'modifier' });
  } finally { f.hook.off(); }
});

for (const modifier of ['Meta', 'Control']) test(`explicit ${modifier} checks card-frame focus on an ARIA option`, () => {
  const f = hookFixture();
  try {
    const option = new f.Element('div', { role: 'option' }), card = new f.Element('iframe');
    f.document.activeElement = card;
    assert.equal(f.hook.prepare(option, 'blurred', 1000, false, modifier), true);
    assert.equal(card.blurred, true); f.hook.finish('blurred');
    card.keepsFocus = true; f.document.activeElement = card;
    assert.throws(() => f.hook.prepare(option, 'held', 1000, false, modifier), /document focus is inside a frame/);
  } finally { f.hook.off(); }
});

test('CR8 pointer capture masks only trusted events on the prepared element during its click', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = hookFixture(), button = new f.Element(), other = new f.Element(), retained = [];
  const dispatch = (type, nodes, isTrusted = true) => {
    const event = Object.assign(new f.MouseEvent(), { type, nodes, isTrusted, control: true, meta: true });
    for (const fn of f.window.captureListeners[type] ?? []) fn(event);
    event.nodes = []; retained.push(event);
  };
  try {
    dispatch('mouseup', [button]);
    f.hook.prepare(button, 'scoped', 1000);
    for (const fn of f.window.listeners.keydown) fn(Object.assign(new f.Event(), { key: 'Control', type: 'keydown', isTrusted: true }));
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      dispatch(type, [button], false); dispatch(type, [other]);
    }
    dispatch('click', [button]); retained.pop();
    dispatch('mouseup', [button]);
    t.mock.timers.tick(0);
    dispatch('pointerup', [button]);
    f.hook.finish('scoped');
    for (const event of retained) assert.deepEqual([event.ctrlKey, event.metaKey], [true, true], event.type);
  } finally { f.hook.off(); }
});

test('CR6 masked events stay plain after dispatch, finish, and another arm', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = hookFixture(), button = new f.Element();
  try {
    f.hook.prepare(button, 'first', 1000);
    for (const fn of f.window.listeners.keydown) fn(Object.assign(new f.Event(), { key: 'Control', type: 'keydown', isTrusted: true }));
    const event = Object.assign(new f.MouseEvent(), { nodes: [button], isTrusted: true, control: true, meta: true });
    for (const fn of f.window.listeners.click) fn(event);
    t.mock.timers.tick(0);
    const read = () => [event.ctrlKey, event.metaKey, event.getModifierState('Control'), event.getModifierState('Meta')];
    assert.deepEqual(read(), [false, false, false, false]);
    f.hook.finish('first');
    assert.deepEqual(read(), [false, false, false, false]);
    f.hook.prepare(button, 'second', 1000);
    assert.deepEqual(read(), [false, false, false, false]);
  } finally { f.hook.off(); }
});

for (const key of ['Control', 'Meta']) test('CR6 swallows the matching trusted keyup after dispatch: ' + key, t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = hookFixture(), button = new f.Element();
  const keyEvent = (type, isTrusted = true) => {
    const event = Object.assign(new f.Event(), { key, type, isTrusted });
    for (const fn of f.window.listeners[type]) fn(event);
    return event;
  };
  try {
    f.hook.prepare(button, 'keys', 1000);
    assert.equal(keyEvent('keydown').stopped, true);
    const event = Object.assign(new f.MouseEvent(), { nodes: [button], isTrusted: true, control: true });
    for (const fn of f.window.listeners.click) fn(event);
    t.mock.timers.tick(0);
    assert.equal(keyEvent('keyup', false).stopped, undefined);
    assert.equal(keyEvent('keyup').stopped, true);
    assert.equal(keyEvent('keyup').stopped, true, 'the explicit cleanup keyup is also hidden until finish');
    f.hook.finish('keys');
    assert.equal(keyEvent('keyup').stopped, undefined, 'later unrelated keyups are visible after finish');
  } finally { f.hook.off(); }
});

test('CR6 captured link requests retain exact target and rel', () => {
  const f = hookFixture(), link = new f.Element('a', { href: '/landed', target: 'child', rel: 'noopener noreferrer' });
  try {
    f.hook.prepare(link, 'link', 1000);
    for (const fn of f.window.listeners.click) fn(Object.assign(new f.MouseEvent(), { nodes: [link], isTrusted: true }));
    assert.deepEqual(JSON.parse(JSON.stringify(f.hook.takeRequest('link'))),
      { url: 'https://fixture.invalid/landed', target: 'child', rel: 'noopener noreferrer' });
  } finally { f.hook.off(); }
});

test('CR6 named links reuse only an unchanged owned target and replace released or renamed targets', async () => {
  const f = fixture();
  try {
    const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/start' }), parent = f.registry.tab(tab);
    const first = await parent.openChild('https://fixture.invalid/first', { target: 'destination', rel: 'noopener' });
    const again = await parent.openChild('https://fixture.invalid/second', { target: 'destination', rel: 'noopener' });
    assert.equal(again.tab, first.tab);
    assert.equal(f.registry.tab(first.tab).page.windowName, 'destination');
    f.registry.tab(first.tab).page.windowName = 'page-renamed';
    const replacement = await parent.openChild('https://fixture.invalid/third', { target: 'destination' });
    assert.notEqual(replacement.tab, first.tab);
    const kept = f.registry.tab(replacement.tab);
    await f.registry.keep(replacement.tab);
    const afterKeep = await parent.openChild('https://fixture.invalid/fourth', { target: 'destination' });
    assert.notEqual(afterKeep.tab, replacement.tab);
    assert.equal(kept.released, true);
    assert.equal(f.calls.filter(call => call[0] === 'Target.createTarget').length, 4);
  } finally { await f.registry.endTurn(); }
});

for (const changed of ['origin', 'identity', 'closed']) test('CR6 named link rejects a stale reuse proof: ' + changed, async () => {
  const f = fixture();
  try {
    const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/start' }), parent = f.registry.tab(tab);
    const first = await parent.openChild('https://fixture.invalid/first', { target: 'destination' });
    const child = f.registry.tab(first.tab);
    if (changed === 'origin') child.page.url = () => 'https://other.invalid/';
    if (changed === 'identity') child.page.info.targetId = 'replaced-target';
    if (changed === 'closed') await child.page.close();
    const next = await parent.openChild('https://fixture.invalid/second', { target: 'destination' });
    assert.notEqual(next.tab, first.tab);
    assert.equal(f.registry.tab(next.tab).page.windowName, 'destination');
  } finally { await f.registry.endTurn(); }
});

test('CR6 a busy named destination refuses before joining its input queue', async () => {
  const f = fixture(); let release;
  try {
    const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/start' }), parent = f.registry.tab(tab);
    const child = await parent.openChild('https://fixture.invalid/first', { target: 'destination' });
    const hold = f.registry.enqueue(child.tab, () => new Promise(resolve => { release = resolve; }));
    await Promise.resolve();
    const before = f.calls.filter(call => call[0] === 'goto').length;
    await assert.rejects(parent.openChild('https://fixture.invalid/second', { target: 'destination' }), /named link target is busy/);
    assert.equal(f.calls.filter(call => call[0] === 'goto').length, before);
    release(); await hold; release = undefined;
    assert.equal((await parent.openChild('https://fixture.invalid/second', { target: 'destination' })).tab, child.tab);
  } finally { release?.(); await f.registry.endTurn(); }
});

test('CR3 arms every command without inspecting script or listener source', () => {
  const f = hookFixture();
  try {
    Object.defineProperty(f.document, 'scripts', { get() { throw Error('source inspection is forbidden'); } });
    assert.equal(f.hook.prepare(new f.Element(), 'external-handler', 1000), true);
  } finally { f.hook.off(); }
});

for (const attrs of [{ rel: 'noopener' }, { target: '_self', rel: 'noreferrer' },
  { target: 'content', rel: 'noopener' }, { target: '_parent' }, { target: '_top' }])
test('CR3 same-context link stays plain: ' + JSON.stringify(attrs), () => {
  const f = hookFixture(), child = {}; f.window.frames = Object.assign([child], { content: child });
  try { assert.equal(f.hook.prepare(new f.Element('a', { href: '/next', ...attrs }), 'same', 1000), false); }
  finally { f.hook.off(); }
});

for (const target of ['_blank', 'new-context']) test('CR3 independent link target is captured: ' + target, () => {
  const f = hookFixture();
  try { assert.equal(f.hook.prepare(new f.Element('a', { href: '/next', target }), 'new', 1000)?.kind, 'link'); }
  finally { f.hook.off(); }
});

test('CR3 base target selects an existing context without treating rel as a new window', () => {
  const f = hookFixture(), child = {}; f.window.frames = Object.assign([child], { content: child });
  f.document.querySelector = () => new f.Element('base', { target: 'content' });
  try { assert.equal(f.hook.prepare(new f.Element('a', { href: '/next', rel: 'noopener' }), 'base', 1000), false); }
  finally { f.hook.off(); }
});

test('CR3 built-in Window properties are not existing named frame contexts', () => {
  const f = hookFixture(); f.window.frames = Object.assign([], { top: f.window });
  try { assert.equal(f.hook.prepare(new f.Element('a', { href: '/next', target: 'top' }), 'builtin', 1000)?.kind, 'link'); }
  finally { f.hook.off(); }
});

test('CR3 captures composedPath and Date.now before page wrappers can change masking', () => {
  let now = 10;
  const clock = { now: () => now }, f = hookFixture({ clock }), button = new f.Element();
  try {
    f.hook.prepare(button, 'native', 1000);
    f.Event.prototype.composedPath = () => [];
    clock.now = () => 1e9;
    for (const listener of f.window.listeners.keydown)
      listener(Object.assign(new f.Event(), { key: 'Control', type: 'keydown', isTrusted: true }));
    now += 5;
    const event = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [button], control: true });
    assert.equal(event.ctrlKey, false);
  } finally { f.hook.off(); }
});

test('CR3 preparation arm outlasts the actionability timeout by one second', async () => {
  const f = clickFixture(true); let cap;
  // The first call is the preparation arm; the shield sealed afterwards outlasts the click by four seconds.
  f.locator.evaluate = async (fn, args) => { cap ??= args.capMs; return hookAnswer(f.entry.hook, fn, args, { prepare: true }); };
  await backgroundClick(f.entry, f.locator, async () => {}, { timeoutMs: 2000 });
  assert.equal(cap, 3000);
});

test('CR3 a link-kind self-close returns closure without evaluating takeRequest', async () => {
  const f = clickFixture({ kind: 'link' });
  f.entry.opener = 'parent'; f.entry.parent = { page: { isClosed: () => false } };
  let requestReads = 0;
  f.entry.page.evaluate = async (fn, arg) => {
    if (String(fn).includes('takeRequest')) { requestReads++; throw Error('page closed'); }
    return hookAnswer(f.entry.hook, fn, arg);
  };
  const result = await backgroundClick(f.entry, f.locator, async () => {
    f.entry.closed = true; throw Error('Target page has been closed');
  });
  assert.deepEqual(result, { closed: true, opener: 'parent' });
  assert.equal(requestReads, 0);
});

test('CR2 HTML navigable containers and plugin elements reject focus through open shadow roots', () => {
  // HTML document-sequences.html#navigable-container and iframe-embed-object.html;
  // obsolete.html#frames and WICG fenced-frame/#fenced-frame-element extend the set.
  const f = hookFixture();
  try {
    for (const tag of ['iframe', 'object', 'embed', 'frame', 'fencedframe']) {
      const focused = new f.Element(tag);
      f.document.activeElement = { shadowRoot: { activeElement: { shadowRoot: { activeElement: focused } } } };
      assert.throws(() => f.hook.prepare(new f.Element(), tag, 1000), /frame|focus/i);
    }
    f.document.activeElement = { shadowRoot: { activeElement: new f.Element('input') } };
    assert.equal(f.hook.prepare(new f.Element(), 'ordinary-focus', 1000), true);
  } finally { f.hook.off(); }
});

test('CR2 a frame left holding focus is blurred before a modified click, and one that keeps focus still refuses', () => {
  const f = hookFixture();
  try {
    const card = new f.Element('iframe');
    f.document.activeElement = card;
    assert.equal(f.hook.prepare(new f.Element(), 'after-fill', 1000), true); assert.equal(card.blurred, true);
    const stubborn = new f.Element('iframe'); stubborn.keepsFocus = true;
    f.document.activeElement = stubborn;
    assert.throws(() => f.hook.prepare(new f.Element(), 'refocused', 1000), /document focus is inside a frame/);
  } finally { f.hook.off(); }
});

test('a refusal because focus is inside a frame is named, not reported as a failed preparation', async () => {
  const f = clickFixture(false); f.locator.evaluate = async () => { throw Error('locator.evaluate: Error: document focus is inside a frame\n    at ...'); };
  await assert.rejects(backgroundClick(f.entry, f.locator, async () => f.calls.push(['click'])), /focus is held inside a frame .*click a page element outside it first/);
  assert.deepEqual(f.calls, [['disarm']]);
});

test('reveal scrolls nearest, then tries centre and each edge while a fixed or sticky bar covers the element', () => {
  const run = covers => {
    let element, bar, inner, page;
    const names = { bar: () => bar, inner: () => inner, page: () => page, none: () => null };
    class Document { elementFromPoint() { return names[covers[Math.min(element.scrolls.length - 1, covers.length - 1)]](); } }
    const f = hookFixture({ globals: { Document, innerHeight: 600 }, windowProps: { getComputedStyle: n => ({ position: n.position }) } });
    const node = (position, parent = null) => Object.assign(new f.Element('div'), { position, parentElement: parent, parentNode: parent });
    bar = node('fixed'); inner = node('static', bar); page = node('static');
    element = new f.Element(); element.rect = { x: 0, y: 590, width: 20, height: 5, top: 590, bottom: 595 };
    try { f.hook.reveal(element); return element.scrolls; } finally { f.hook.off(); }
  };
  assert.deepEqual(run(['none']), ['nearest']);
  assert.deepEqual(run(['inner', 'page']), ['nearest', 'center']);
  assert.deepEqual(run(['bar', 'bar', 'page']), ['nearest', 'center', 'end']);
  assert.deepEqual(run(['bar']), ['nearest', 'center', 'end', 'start']);
  assert.deepEqual(run(['page']), ['nearest']);
});

test('CR5 native controls and ARIA roles without a measured modifier default use masking', () => {
  const f = hookFixture();
  try {
    for (const type of ['', 'invalid', 'hidden', 'text', 'search', 'tel', 'url', 'email', 'password', 'date',
      'month', 'week', 'time', 'datetime-local', 'number', 'range', 'color', 'checkbox', 'radio', 'file']) {
      assert.equal(f.hook.prepare(new f.Element('input', { type }), 'input-' + type, 1000), true, type);
      f.hook.finish('input-' + type);
    }
    for (const type of ['button', 'submit', 'reset', 'image', 'SUBMIT']) {
      assert.equal(f.hook.prepare(new f.Element('input', { type }), 'button-' + type, 1000), true, type);
      f.hook.finish('button-' + type);
    }
    for (const tag of ['select', 'option', 'textarea', 'label', 'summary']) {
      assert.equal(f.hook.prepare(new f.Element(tag), tag, 1000), true, tag); f.hook.finish(tag);
    }
    for (const role of ['checkbox', 'radio', 'switch', 'option', 'menuitemcheckbox', 'menuitemradio', 'tab',
      'treeitem', 'textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton', 'scrollbar']) {
      assert.equal(f.hook.prepare(new f.Element('div', { role }), 'role-' + role, 1000), true, role); f.hook.finish('role-' + role);
    }
    for (const [role, attribute] of [['button', 'aria-pressed'], ['gridcell', 'aria-selected'], ['row', 'aria-selected']]) {
      assert.equal(f.hook.prepare(new f.Element('div', { role, [attribute]: 'false' }), role, 1000), true, role); f.hook.finish(role);
    }
    for (const tag of ['button', 'input']) {
      assert.equal(f.hook.prepare(new f.Element(tag, { type: 'button', 'aria-pressed': 'false' }), 'toggle-' + tag, 1000), true, tag); f.hook.finish('toggle-' + tag);
    }
    assert.equal(f.hook.prepare(new f.Element('button'), 'popup-button', 1000), true);
  } finally { f.hook.off(); }
});

test('CR4 masking survives 300 ms load until click dispatch completes and respects arm cap', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = hookFixture(), button = new f.Element();
  const mouse = () => Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [button], control: true });
  try {
    f.hook.prepare(button, 'loaded', 1000);
    for (const listener of f.window.listeners.keydown)
      listener(Object.assign(new f.Event(), { key: 'Control', type: 'keydown', isTrusted: true }));
    t.mock.timers.tick(300);
    const click = mouse();
    for (const listener of f.window.listeners.click) listener(click);
    assert.equal(click.ctrlKey, false);
    assert.equal(f.window.open('/loaded', 'loaded').real, true);
    t.mock.timers.tick(0);
    assert.equal(mouse().ctrlKey, true);
    assert.equal(f.window.open('/too-late', 'late'), null);
    f.hook.prepare(button, 'cap', 1000);
    for (const listener of f.window.listeners.keydown)
      listener(Object.assign(new f.Event(), { key: 'Control', type: 'keydown', isTrusted: true }));
    t.mock.timers.tick(1000);
    assert.equal(mouse().ctrlKey, true);
  } finally { f.hook.off(); }
});

test('serialized popup hook hides only the prepared trusted click and strips window sizing', () => {
  const f = hookFixture(), button = new f.Element();
  try {
    assert.equal(f.hook.prepare(button, 'click', 1000), true);
    const key = Object.assign(new f.Event(), { key: 'Control', type: 'keydown', isTrusted: true });
    for (const listener of f.window.listeners.keydown) listener(key);
    assert.equal(key.stopped, true);
    const click = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [button], control: true, meta: false });
    assert.equal(click.ctrlKey, false); assert.equal(click.getModifierState('Control'), false);
    const other = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [new f.Element()], control: true });
    assert.equal(other.ctrlKey, true);
    const untrusted = Object.assign(new f.MouseEvent(), { isTrusted: false, nodes: [button], control: true });
    assert.equal(untrusted.ctrlKey, true);
    assert.equal(f.window.open('/identity', 'identity', 'popup,width=420,noopener=yes').real, true);
    assert.deepEqual(f.opens[0], ['/identity', 'identity', 'noopener=yes']);
    f.hook.finish('click');
    assert.equal(f.window.open('/unarmed', '_blank'), null);
    assert.equal(f.hook.prepare(button, 'click', 1000), false, 'a timed-out token cannot rearm late');
  } finally { f.hook.off(); }
});

test('serialized popup hook leaves same-tab links plain and restores native methods on release', () => {
  const f = hookFixture(), link = new f.Element('a', { href: '/checkout' });
  const nativeOpen = f.window.open;
  assert.equal(f.hook.prepare(link, 'same-tab', 1000), false);
  assert.equal(f.window.open('/self', '_self').real, true);
  assert.equal(f.hook.off(), true);
  assert.notEqual(f.window.open, nativeOpen);
  assert.throws(() => f.hook.prepare(link, 'after-off', 1000), /hook is off/);
  const event = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [link], control: true });
  assert.equal(event.ctrlKey, true);
  assert.equal(f.window.listeners.keydown.size, 0);
});

test('opening does not attach persistent sessions to existing user pages', async () => {
  const f = fixture(); f.page('user'); await f.registry.idle();
  const before = f.calls.filter(c => c[0] === 'Target.getTargetInfo' && c[2] === 'user').length;
  await f.registry.openTab({ url: 'https://fixture.invalid/' });
  assert.equal(f.calls.filter(c => c[0] === 'Target.getTargetInfo' && c[2] === 'user').length, before);
  await f.registry.endTurn();
});

test('turn end closes an allocated target even when Playwright never produces its page', async t => {
  const calls = [], f = fixture({ timeoutMs: 20, session: { async send(method, params) {
    calls.push([method, params]);
    return method === 'Target.createTarget' ? { targetId: 'unseen' } : { success: true };
  } } });
  const opening = f.registry.openTab({ url: 'https://fixture.invalid/' });
  opening.catch(() => {});
  t.after(async () => { f.page('unseen'); await f.registry.idle(); await f.registry.endTurn(); });
  await new Promise(resolve => setTimeout(resolve, 1));
  const result = await f.registry.endTurn();
  assert.equal(result.cleanedUp, true);
  assert.deepEqual(calls.at(-1), ['Target.closeTarget', { targetId: 'unseen' }]);
  await assert.rejects(opening, /ended|pending/i);
});

test('popup click waits for delayed owned adoption after windowOpen without delaying ordinary clicks', async () => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const entry = f.registry.tab(tab);
  entry.page.evaluate = async (fn, arg) => hookAnswer(entry.hook, fn, arg);
  await backgroundClick(entry, { evaluate: async (fn, arg) => hookAnswer(entry.hook, fn, arg) }, async () => {
    entry.cdp.emit('Page.windowOpen', { url: 'https://fixture.invalid/popup' });
    setTimeout(() => f.page('delayed-popup', 'target-1'), 2);
  });
  assert.equal(entry.popups.length, 1);
  assert.equal(f.registry.tab(entry.popups[0].tab).page.info.targetId, 'delayed-popup');
  await f.registry.endTurn();
});

test('filtered popup is admitted from trusted CDP opener metadata before Playwright can see it', async () => {
  const owned = [], f = fixture({
    upstream: { async send(method) {
      assert.equal(method, 'Target.getTargets');
      return { targetInfos: [{ type: 'page', targetId: 'child', openerId: 'target-1' },
        { type: 'page', targetId: 'foreign', openerId: 'user' }, { type: 'worker', targetId: 'worker', openerId: 'target-1' }] };
    } },
    ownTarget: async targetId => { owned.push(targetId); f.page(targetId, 'target-1'); },
  });
  const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  f.registry.tab(tab).cdp.emit('Page.windowOpen', {});
  await f.registry.idle();
  assert.deepEqual(owned, ['child']);
  assert.equal(f.registry.tab(tab).popups.length, 1);
  await f.registry.endTurn();
});

test('a noopener link dispatches once and opens its captured default destination in the background', async () => {
  const f = clickFixture({ kind: 'link' });
  f.entry.page.evaluate = async (fn, arg) => hookAnswer(f.entry.hook, fn, arg, { request: { url: 'https://fixture.invalid/shipping' } });
  f.entry.openChild = async url => f.calls.push(['openChild', url]);
  await backgroundClick(f.entry, f.locator, async options => f.calls.push(['click', options]));
  assert.deepEqual(f.calls.filter(c => ['click', 'openChild'].includes(c[0])), [
    ['click', { modifiers: ['ControlOrMeta'] }], ['openChild', 'https://fixture.invalid/shipping'],
  ]);
});

test('a prepared new-tab link carries background disposition even if page handlers stop bubbling', async () => {
  const f = clickFixture({ kind: 'link' });
  f.entry.page.evaluate = async (fn, arg) => hookAnswer(f.entry.hook, fn, arg, { request: undefined });
  await backgroundClick(f.entry, f.locator, async options => f.calls.push(['click', options]));
  assert.deepEqual(f.calls.find(call => call[0] === 'click'), ['click', { modifiers: ['ControlOrMeta'] }]);
  assert.equal(f.calls.filter(call => call[0] === 'click').length, 1);
  assert.ok(f.calls.some(call => call[0] === 'up'));
});

test('a popup closing during its click returns the observed closure and its living opener', async () => {
  const f = clickFixture(false);
  f.entry.opener = 'parent'; f.entry.parent = { page: { isClosed: () => false } };
  f.entry.closed = true;
  const click = async () => { throw Error('locator.click: Target page, context or browser has been closed'); };
  const result = await backgroundClick(f.entry, f.locator, click);
  assert.deepEqual(result, { closed: true, opener: 'parent' });
  f.entry.parent.page.isClosed = () => true;
  await assert.rejects(backgroundClick(f.entry, f.locator, click), /Target page/);
});

test('serialized link hook replaces only an uncancelled trusted default open', () => {
  const f = hookFixture(), link = new f.Element('a', { target: '_blank', href: '/shipping' });
  try {
    assert.equal(f.hook.prepare(link, 'link', 1000).kind, 'link');
    const click = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [link] });
    for (const listener of f.window.listeners.click) listener(click);
    assert.equal(click.nativePrevented, true);
    assert.equal(click.defaultPrevented, false);
    assert.equal(f.hook.takeRequest('link').url, 'https://fixture.invalid/shipping');
    assert.equal(f.hook.takeRequest('link').unavailable, true);
    f.hook.finish('link'); f.hook.prepare(link, 'cancelled', 1000);
    const cancelled = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [link] });
    cancelled.preventDefault();
    for (const listener of f.window.listeners.click) listener(cancelled);
    assert.equal(f.hook.takeRequest('cancelled'), undefined);
    assert.deepEqual(f.opens, []);
  } finally { f.hook.off(); }
});

for (const stop of ['stopPropagation', 'stopImmediatePropagation']) for (const cancel of [false, true])
test(`capture suppresses the native default before ${stop}, preserving page cancellation=${cancel}`, () => {
  const f = hookFixture(), link = new f.Element('a', { target: '_blank', href: '/shipping' });
  try {
    f.hook.prepare(link, 'link', 1000);
    const click = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [link] });
    for (const listener of f.window.captureListeners.click) listener(click);
    assert.equal(click.nativePrevented, true, 'the native open must be suppressed before page handlers');
    assert.equal(click.defaultPrevented, false, 'the page has not cancelled its own default');
    click[stop]();
    if (cancel) click.preventDefault();
    assert.equal(click.defaultPrevented, cancel);
    const request = f.hook.takeRequest('link');
    assert.equal(request?.url, cancel ? undefined : 'https://fixture.invalid/shipping');
  } finally { f.hook.off(); }
});

for (const cancel of ['returnFalse', 'returnValue']) test(`captured link respects ${cancel} cancellation without a bubble listener`, () => {
  const f = hookFixture(), link = new f.Element('a', { target: '_blank', href: '/shipping' });
  link.onclick = event => {
    event.stopImmediatePropagation();
    if (cancel === 'returnValue') event.returnValue = false;
    return false;
  };
  try {
    f.hook.prepare(link, 'link', 1000);
    const click = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [link] });
    for (const listener of f.window.captureListeners.click) listener(click);
    assert.equal(click.nativePrevented, true);
    link.onclick(click);
    assert.equal(f.hook.takeRequest('link'), undefined);
  } finally { f.hook.off(); }
});

test('keep waits for queued input, fences new input, then releases filter ownership', async () => {
  const released = [], f = fixture({ releaseTarget: target => released.push(target) });
  const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  let finish, started;
  const begun = new Promise(resolve => { started = resolve; });
  const pending = f.registry.enqueue(tab, async () => { started(); await new Promise(resolve => { finish = resolve; }); });
  await begun;
  const keeping = f.registry.keep(tab);
  assert.throws(() => f.registry.enqueue(tab, async () => {}), /owned|releas/i);
  assert.deepEqual(released, []);
  finish(); await pending; await keeping;
  assert.deepEqual(released, ['target-1']);
  assert.equal(f.pages[0].isClosed(), false);
  await f.registry.endTurn();
});

for (const kind of ['keep', 'handoff']) test(`${kind} accepted before turn end preserves the page during hook removal`, async t => {
  const f = fixture(), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = f.registry.tab(tab).page, send = page.cdp.send.bind(page.cdp);
  let releaseHook, entered;
  const begun = new Promise(resolve => { entered = resolve; });
  page.cdp.send = (method, params) => {
    if (method === 'Page.removeScriptToEvaluateOnNewDocument') {
      entered(); return new Promise(resolve => { releaseHook = resolve; });
    }
    return send(method, params);
  };
  const releasing = f.registry[kind](tab);
  await begun;
  const ending = f.registry.endTurn();
  await new Promise(resolve => setImmediate(resolve));
  const closedDuringRelease = page.isClosed();
  releaseHook({});
  assert.equal((await releasing).kept, true);
  const result = await ending;
  assert.equal(closedDuringRelease, false);
  assert.equal(result.cleanedUp, true);
  assert.equal(result.rows.find(row => row.tab === tab).kept, true);
  assert.equal(page.isClosed(), false);
});

for (const kind of ['keep', 'handoff']) test(`${kind} pending detach has bounded cleanup and can settle without closing the page`, async t => {
  const f = fixture({ timeoutMs: 1000 }), { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const page = f.registry.tab(tab).page;
  let detach, entered;
  const begun = new Promise(resolve => { entered = resolve; });
  page.cdp.detach = () => { entered(); return new Promise(resolve => { detach = resolve; }); };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const releasing = f.registry[kind](tab);
  let rejection;
  releasing.catch(error => { rejection = error; });
  t.after(async () => { detach?.(); await releasing.catch(() => {}); await f.registry.endTurn(); });
  await begun;
  t.mock.timers.tick(1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(rejection?.message ?? 'no rejection', /pending|timed out/i);
  assert.throws(() => f.registry.enqueue(tab, async () => {}), /owned|releas/i);
  const ending = f.registry.endTurn();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(1000);
  const result = await ending;
  assert.equal(result.cleanedUp, false);
  assert.equal(page.isClosed(), false);
  assert.equal(result.rows.find(row => row.tab === tab).cleanupRequired, true);
  detach(); await f.registry.idle();
  const retried = await f.registry.endTurn();
  assert.equal(retried.cleanedUp, true);
  assert.equal(retried.rows.find(row => row.tab === tab).kept, true);
  assert.equal(page.isClosed(), false);
});

test('a page closing during release is refused instead of acknowledged as kept', async () => {
  const f = fixture({ releaseTarget: () => f.pages[0].close() });
  const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  await assert.rejects(f.registry.keep(tab), /closed during release/);
  const result = await f.registry.endTurn();
  assert.equal(result.cleanedUp, true);
  assert.equal(result.rows.find(row => row.tab === tab).kept, false);
});

for (const tag of ['textarea', 'select', 'option', 'label', 'input'])
  test('CR5 does not infer a modifier default from an arbitrary ancestor: ' + tag, () => {
    const f = hookFixture(), button = new f.Element();
    button.parentElement = new f.Element(tag);
    try { assert.equal(f.hook.prepare(button, tag, 1000), true); } finally { f.hook.off(); }
  });
for (const role of ['checkbox', 'radio', 'switch', 'option', 'menuitemcheckbox', 'menuitemradio'])
  test('CR5 custom shadow widget handlers receive masking: ' + role, () => {
    const f = hookFixture(), button = new f.Element();
    button.getRootNode = () => ({ host: new f.Element('custom-control', { role }) });
    try { assert.equal(f.hook.prepare(button, role, 1000), true); } finally { f.hook.off(); }
  });

test('CR7 leaves editable content plain and refuses detached nodes, frame focus and retired tokens', () => {
  const f = hookFixture();
  try {
    assert.equal(f.hook.prepare(new f.Element('div', { contenteditable: '' }), 'editable', 1000), false);
    const detached = new f.Element(); detached.isConnected = false;
    assert.equal(f.hook.prepare(detached, 'detached', 1000), false);
    f.hook.finish('late');
    assert.equal(f.hook.prepare(new f.Element(), 'late', 1000), false);
    for (const localName of ['iframe', 'frame', 'fencedframe', 'object', 'embed']) {
      f.document.activeElement = new f.Element(localName); f.document.activeElement.keepsFocus = true; // one that refuses to let go
      assert.throws(() => f.hook.prepare(new f.Element(), localName, 1000), /frame|focus/i);
    }
  } finally { f.hook.off(); }
});

test('CR1 preparation and modifier masking expire independently', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = hookFixture(), button = new f.Element();
  const mouse = () => Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [button], control: true, meta: true });
  try {
    f.hook.prepare(button, 'expire', 3000);
    assert.equal(mouse().ctrlKey, true);
    for (const listener of f.window.listeners.keydown) listener(Object.assign(new f.Event(), { key: 'Meta', type: 'keydown', isTrusted: true }));
    const captured = mouse();
    assert.equal(captured.metaKey, false);
    t.mock.timers.tick(1001);
    assert.equal(captured.metaKey, false, 'masking follows dispatch rather than a fixed clock window');
    assert.equal(mouse().metaKey, false);
    t.mock.timers.tick(2000);
    assert.equal(f.hook.prepare(button, 'expire', 1000), false);
  } finally { f.hook.off(); }
});

test('CR1 window opening needs an arm while same-context names remain native', () => {
  const f = hookFixture();
  try {
    for (const target of ['_self', '_parent', '_top']) assert.equal(f.window.open('/same', target).real, true);
    assert.equal(f.window.open('/popup', '_blank'), null);
    f.hook.prepare(new f.Element(), 'active', 1000);
    for (const listener of f.window.listeners.keydown) listener(Object.assign(new f.Event(), { key: 'Control', type: 'keydown', isTrusted: true }));
    f.window.open('/popup', 'named', 'left=10,noreferrer,top=20,noopener=yes,width=100');
    assert.deepEqual(f.opens.at(-1), ['/popup', 'named', 'noreferrer,noopener=yes']);
  } finally { f.hook.off(); }
});

test('a window.open handle is offered the hook\'s own source once: key and secret bytes included, built inside the hook', () => {
  const evals = [], f = hookFixture({ handle: { eval(source) { evals.push(source); } } });
  const arm = token => {
    f.hook.prepare(new f.Element(), token, 1000);
    for (const listener of f.window.listeners.keydown) listener(Object.assign(new f.Event(), { key: 'Control', type: 'keydown', isTrusted: true }));
  };
  try {
    arm('first');
    assert.ok(f.window.open('/popup', 'named'));
    assert.deepEqual(evals, [hookSource(f.credentials)], 'the source is the install source for these credentials');
    f.hook.finish('first'); arm('second');
    f.window.open('/popup', 'named');
    assert.equal(evals.length, 1, 'a handle the hook already offered the source to is not offered it again');
  } finally { f.hook.off(); }
});

test('CR1 changed link destinations refuse a stale captured default', () => {
  const f = hookFixture(), link = new f.Element('a', { target: '_blank', href: '/first' });
  try {
    f.hook.prepare(link, 'changed', 1000);
    const event = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [link] });
    for (const listener of f.window.captureListeners.click) listener(event);
    link.attrs.href = '/second';
    assert.equal(f.hook.takeRequest('changed').unavailable, true);
    assert.equal(event.returnValue, true);
    event.returnValue = false;
    assert.equal(event.defaultPrevented, true);
  } finally { f.hook.off(); }
});

test('CR1 teardown preserves a later replacement of window.open', () => {
  const f = hookFixture(), replacement = () => 'page replacement';
  f.window.open = replacement;
  f.hook.off();
  assert.equal(f.window.open, replacement);
});

test('CR1 preparation timeout sends no input, retires the late token and disarms', async () => {
  const f = clickFixture(false);
  f.locator.evaluate = () => new Promise(() => {});
  await assert.rejects(backgroundClick(f.entry, f.locator, async () => f.calls.push(['click']), { timeoutMs: 5 }),
    /background popup preparation failed; use the engine browser path/);
  assert.deepEqual(f.calls, [['disarm']]);
});

test('a refused proof or unavailable hook sends the model to the engine path from every stage, not to "read again"', async () => {
  const refuse = () => { throw Error('Error: background popup hook refused the call'); };
  const stages = {
    prepare: f => { f.locator.evaluate = async () => refuse(); },
    guard: f => { const prepared = f.locator.evaluate; f.locator.evaluate = async (fn, arg) => arg?.guard ? refuse() : prepared(fn, arg); },
    'guard answer': f => { const prepared = f.locator.evaluate; f.locator.evaluate = async (fn, arg) => arg?.guard ? 'x.' + '0'.repeat(64) + '.t' : prepared(fn, arg); },
    takeRequest: f => { f.entry.page.evaluate = async (fn, arg) => /\.takeRequest\(/.test(String(fn)) ? refuse() : hookAnswer(f.entry.hook, fn, arg, {}); },
  };
  for (const [stage, break_] of Object.entries(stages)) {
    const f = clickFixture(stage === 'takeRequest' ? { kind: 'link' } : true);
    break_(f);
    // The finish that follows is refused too: the clearer error must win over "page changed".
    const finish = f.entry.page.evaluate;
    f.entry.page.evaluate = async (fn, arg) => /\.conclude\(/.test(String(fn)) ? refuse() : finish(fn, arg);
    await assert.rejects(backgroundClick(f.entry, f.locator, async options => f.calls.push(['click', options])),
      error => /use the engine browser path/.test(error.message) && !/read again/.test(error.message), stage);
  }
  // A guard that times out is the page changing, not the hook failing.
  const f = clickFixture(true), prepared = f.locator.evaluate;
  f.locator.evaluate = (fn, arg) => arg?.guard ? new Promise(() => {}) : prepared(fn, arg);
  await assert.rejects(backgroundClick(f.entry, f.locator, async () => {}, { timeoutMs: 5 }), /page changed during the click; read again/);
  // A vetoed click still reads as changed.
  const g = clickFixture(true);
  g.entry.page.evaluate = async (fn, arg) => hookAnswer(g.entry.hook, fn, arg, { verdict: 'the checked element changed', passed: false });
  await assert.rejects(backgroundClick(g.entry, g.locator, async () => {}), /page changed during the click; read again/);
  // The page saw part of the click, or the hook could not say: the retry is not known to be safe.
  for (const passed of [true, undefined]) {
    const h = clickFixture(true);
    h.entry.page.evaluate = async (fn, arg) => hookAnswer(h.entry.hook, fn, arg, { verdict: 'the checked element changed', passed });
    await assert.rejects(backgroundClick(h.entry, h.locator, async () => {}), /page changed during the click; the page had already received part of it/);
  }
});

test('CR1 unavailable link default and missing registry never replay input', async () => {
  for (const request of [{ unavailable: true }, { url: 'https://fixture.invalid/' }]) {
    const f = clickFixture({ kind: 'link' });
    f.entry.page.evaluate = async (fn, arg) => hookAnswer(f.entry.hook, fn, arg, { request });
    await assert.rejects(backgroundClick(f.entry, f.locator, async options => f.calls.push(['click', options])),
      request.url ? /owned page registry/ : /link default changed or was not captured/);
    assert.equal(f.calls.filter(call => call[0] === 'click').length, 1);
    assert.equal(f.calls.filter(call => call[0] === 'up').length, 1);
  }
});

test('CR3 same-context links stay plain without source inspection even with registered handlers', () => {
  const f = hookFixture(), link = new f.Element('a', { href: '/checkout' });
  link.listeners = {}; link.captureListeners = {};
  try {
    f.EventTarget.prototype.addEventListener.call(link, 'click', () => window.open('/popup'));
    assert.equal(f.hook.prepare(link, 'registered', 1000), false);
  } finally { f.hook.off(); }
});

test('CR1 no live user activation means no window, including during an armed click', () => {
  const f = hookFixture(), button = new f.Element();
  try {
    f.hook.prepare(button, 'activation', 1000);
    for (const listener of f.window.listeners.keydown) listener(Object.assign(new f.Event(), { key: 'Control', type: 'keydown', isTrusted: true }));
    f.navigator.userActivation.isActive = false;
    assert.equal(f.window.open('/popup', '_blank'), null);
    assert.deepEqual(f.opens, []);
  } finally { f.hook.off(); }
});

test('CR1 observes an inline cancellation installed after preparation and before dispatch', () => {
  const f = hookFixture(), link = new f.Element('a', { target: '_blank', href: '/shipping' });
  try {
    f.hook.prepare(link, 'late-handler', 1000);
    link.onclick = () => false;
    const click = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [link] });
    for (const listener of f.window.captureListeners.click) listener(click);
    link.onclick(click);
    assert.equal(f.hook.takeRequest('late-handler'), undefined);
  } finally { f.hook.off(); }
});

test('CR1 a handler installed during dispatch makes an uncancelled default unavailable', () => {
  const f = hookFixture(), link = new f.Element('a', { target: '_blank', href: '/shipping' });
  try {
    f.hook.prepare(link, 'during-dispatch', 1000);
    const click = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [link] });
    for (const listener of f.window.captureListeners.click) listener(click);
    link.onclick = () => {};
    assert.equal(f.hook.takeRequest('during-dispatch').unavailable, true);
  } finally { f.hook.off(); }
});

test('CR6 a new arm keeps a retired event masked under its original token', () => {
  const f = hookFixture(), button = new f.Element();
  const keydown = () => {
    for (const listener of f.window.listeners.keydown)
      listener(Object.assign(new f.Event(), { key: 'Control', type: 'keydown', isTrusted: true }));
  };
  try {
    f.hook.prepare(button, 'first', 1000); keydown();
    const first = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [button], control: true });
    for (const listener of f.window.captureListeners.click) listener(first);
    assert.equal(first.ctrlKey, false);
    const second = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [button], control: true });
    assert.equal(second.ctrlKey, true, 'only the first click belongs to the arm');
    f.hook.finish('first');
    f.hook.prepare(button, 'second', 1000); keydown();
    assert.equal(first.ctrlKey, false, 'an old event retains its original mask');
    assert.equal(second.ctrlKey, false);
  } finally { f.hook.off(); }
});
test('endpoint popup adoption closes before hook installation, for any host spelling or pending URL', async () => {
  for (const info of [{ url: 'http://alias.invalid:9222/json/list' }, { url: 'about:blank', pendingUrl: 'http://localhost:9222/json/list' }]) {
    const f = fixture({ endpoint: 'ws://127.0.0.1:9222/devtools/browser/private' });
    const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
    const popup = f.page('endpoint-child', 'target-1'); Object.assign(popup.info, info);
    await f.registry.idle();
    assert.equal(popup.closed, true);
    assert.equal(f.calls.some(c => c[0] === 'Runtime.evaluate' && c[2] === 'endpoint-child'), false);
    assert.equal(f.registry.tab(tab).popups.at(-1).blocked, true);
    assert.equal((await f.registry.list()).length, 1);
    assert.equal((await f.registry.endTurn()).cleanedUp, true);
  }
});

test('background link allocation refuses the endpoint port before creating a page', async () => {
  const f = fixture({ endpoint: 'ws://127.0.0.1:9222/devtools/browser/private' });
  await assert.rejects(f.registry.openTab({ url: 'http://alias.invalid:9222/json/list' }), /blocked: DevTools endpoint/);
  assert.equal(f.pages.length, 0);
  await f.registry.endTurn();
});

test('failed endpoint popup closure stays owned for cleanup without filter admission', async () => {
  const admitted = [], closes = [], f = fixture({ endpoint: 'ws://127.0.0.1:9222/devtools/browser/private',
    upstream: { async send(method, params) {
      if (method === 'Target.getTargets') return { targetInfos: [{ type: 'page', targetId: 'blocked-child', openerId: 'target-1', url: 'http://alias.invalid:9222/json/list' }] };
      assert.equal(method, 'Target.closeTarget'); closes.push(params.targetId);
      return { success: false };
    } }, ownTarget: async targetId => admitted.push(targetId) });
  const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  f.registry.tab(tab).cdp.emit('Page.windowOpen', { url: 'http://alias.invalid:9222/json/list' });
  await f.registry.idle();
  assert.deepEqual(admitted, []);
  const result = await f.registry.endTurn();
  assert.equal(result.cleanedUp, false);
  assert.deepEqual(result.rows.find(row => row.targetId === 'blocked-child'), { targetId: 'blocked-child', closed: false, cleanupRequired: true });
  assert.equal(closes.length, 2,'turn end retries the exact owned closure');
});

test('the default endpoint port does not classify about:blank as an endpoint page', async () => {
  const f = fixture({ endpoint: 'ws://127.0.0.1/devtools/browser/private' });
  // Fresh browser targets begin at about:blank, which has no network port.
  f.context.newCDPSession = async page => {
    page.url = () => 'about:blank';
    return page.cdp;
  };
  const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  assert.equal(f.registry.tab(tab).closed, false);
  await f.registry.endTurn();
});

test('REVIEW endpoint navigation closes the owned page', async t => {
  const f = fixture({endpoint:'ws://127.0.0.1:9222/devtools/browser/private'});
  t.after(() => f.registry.endTurn());
  const {tab} = await f.registry.openTab({url:'https://fixture.invalid/'}), entry=f.registry.tab(tab);
  entry.page.url=()=> 'http://localhost:9222/json/list';
  await assert.rejects(f.registry.enqueue(tab, async()=>assert.fail('no read')), /blocked: DevTools endpoint/);
  assert.equal(entry.page.isClosed(), true);
});
test('REVIEW listing preserves unrelated owned tabs', async t => {
  const f = fixture({endpoint:'ws://127.0.0.1:9222/devtools/browser/private'});
  t.after(() => f.registry.endTurn());
  const a=await f.registry.openTab({url:'https://fixture.invalid/'});
  await f.registry.openTab({url:'https://fixture.invalid/other'});
  f.registry.tab(a.tab).page.url=()=> 'http://localhost:9222/json/list';
  assert.ok((await f.registry.list()).some(row=>row.url.includes('target-2')));
});

test('simultaneous blank popups close only the exact blocked target', async t => {
  const f = fixture({ endpoint: 'ws://127.0.0.1:9222/devtools/browser/private', endpointBlocked: id => id === 'blocked-child' });
  t.after(() => f.registry.endTurn());
  const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const parent = f.registry.tab(tab);
  parent.cdp.emit('Page.windowOpen', { url: 'http://localhost:9222/json/list' });
  const safe = f.page('safe-child', 'target-1'), blocked = f.page('blocked-child', 'target-1');
  safe.url = blocked.url = () => 'about:blank';
  await f.registry.idle();
  assert.equal(safe.isClosed(), false);
  assert.equal(blocked.isClosed(), true);
  assert.equal((await f.registry.list()).length, 2);
  assert.deepEqual(parent.popups.find(row => row.blocked), { opener: tab, blocked: true, closed: true });
});

test('a blocked later navigation with failed closure stays private and cleanup retries it', async t => {
  const f = fixture({ endpoint: 'ws://127.0.0.1:9222/devtools/browser/private' });
  t.after(() => f.registry.endTurn());
  const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' }), entry = f.registry.tab(tab);
  const close = entry.page.close;
  entry.page.close = async () => { throw Error('busy'); };
  entry.page.url = () => 'http://localhost:9222/json/list';
  await assert.rejects(f.registry.enqueue(tab, async () => assert.fail('no read')), { message: 'blocked: DevTools endpoint' });
  assert.deepEqual(await f.registry.list(), []);
  assert.throws(() => f.registry.tab(tab), { message: 'blocked: DevTools endpoint' });
  assert.equal((await f.registry.endTurn()).cleanedUp, false);
  entry.page.close = close;
  assert.equal((await f.registry.endTurn()).cleanedUp, true);
});

test('an endpoint redirect rejected by goto still closes and reports only the block', async t => {
  const f = fixture({ endpoint: 'ws://127.0.0.1:9222/devtools/browser/private' });
  t.after(() => f.registry.endTurn());
  f.context.on('page', page => { page.goto = async () => {
    page.info.pendingUrl = 'http://localhost:9222/json/list';
    throw Error('net::ERR_BLOCKED_BY_CLIENT at private URL');
  }; });
  await assert.rejects(f.registry.openTab({ url: 'https://fixture.invalid/redirect' }), { message: 'blocked: DevTools endpoint' });
  assert.equal(f.pages[0].isClosed(), true);
});


for (const probe of [false, true, { kind: 'link' }]) test('CR4 self-closing click still waits for its popup: ' + JSON.stringify(probe), async () => {
  const f = clickFixture(probe), checkpoint = {};
  f.entry.opener = 'parent'; f.entry.parent = { page: { isClosed: () => false } };
  f.entry.popupCheckpoint = () => checkpoint;
  let settled = false;
  f.entry.settlePopups = async before => { assert.equal(before, checkpoint); settled = true; };
  await backgroundClick(f.entry, f.locator, async () => {
    f.entry.closed = true; throw Error('Target page has been closed');
  });
  assert.equal(settled, true);
});

for (const kind of ['sibling', 'grandchild', 'frame-attribute'])
test('CR4 existing named context stays plain: ' + kind, () => {
  const f = hookFixture(), child = { name: 'destination', frames: [] };
  const top = { name: '', frames: [] }; f.window.top = top;
  if (kind === 'sibling') top.frames.push(f.window, child);
  if (kind === 'grandchild') top.frames.push({ name: '', frames: [child] });
  if (kind === 'frame-attribute') f.document.querySelectorAll = () => [new f.Element('iframe', { name: 'destination' })];
  try {
    assert.equal(f.hook.prepare(new f.Element('a', { href: '/next', target: 'destination' }), 'named', 1000), false);
  } finally { f.hook.off(); }
});

// Navigating a window the page opened by name raises it, so a link to it is a new-context link that sleight
// opens in the background (AD1 A3). Only frames and the page's own names stay plain.
test('CR4 a link to an earlier popup by name is captured, not left plain', () => {
  const f = hookFixture();
  try {
    const button = new f.Element(); f.hook.prepare(button, 'first', 1000);
    for (const listener of f.window.listeners.keydown)
      listener(Object.assign(new f.Event(), { key: 'Control', type: 'keydown', isTrusted: true }));
    f.window.open('/first', 'destination'); f.hook.finish('first');
    assert.equal(f.hook.prepare(new f.Element('a', { href: '/next', target: 'destination' }), 'named', 1000).kind, 'link');
  } finally { f.hook.off(); }
});

test('AD1 A6 window.open without an agent click is counted as held until taken', () => {
  const f = hookFixture();
  try {
    assert.equal(f.hook.take(), 0);
    assert.equal(f.window.open('/late', '_blank'), null);
    assert.equal(f.window.open('/late2', 'named'), null);
    assert.equal(f.hook.take(), 2);
    assert.equal(f.hook.take(), 0);
  } finally { f.hook.off(); }
});

test('AD1 A4 press mode refuses a new-context form and leaves a plain control unarmed', () => {
  const f = hookFixture();
  const form = new f.Element('form', { target: '_blank' });
  try {
    assert.deepEqual({ ...f.hook.prepare(new f.HTMLInputElement({}, form), 'press-form', 1000, true) }, { kind: 'refuse', reason: 'form' });
    assert.equal(f.hook.prepare(new f.Element('div'), 'press-div', 1000, true), false);
  } finally { f.hook.off(); }
});

test('CR4 late popup adoption retains the closed owned opener', async () => {
  const f = fixture(), root = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const parent = f.registry.tab(root.tab), page = f.page('closing-child', parent.targetId);
  await f.registry.idle();
  const child = f.registry.tab(parent.popups[0].tab);
  child.page.evaluate = async (fn, arg) => hookAnswer(child.hook, fn, arg);
  await backgroundClick(child, { evaluate: async (fn, arg) => hookAnswer(child.hook, fn, arg) }, async () => {
    child.cdp.emit('Page.windowOpen', {});
    await page.close();
    setTimeout(() => f.page('survivor', 'closing-child'), 2);
    throw Error('Target page has been closed');
  });
  assert.equal(child.popups.length, 1);
  assert.equal(f.registry.tab(child.popups[0].tab).opener, child.tab);
  await f.registry.endTurn();
});

test('CR4 frame walk passes inaccessible names and documents without inventing a target', () => {
  const f = hookFixture(), child = { name: 'destination', frames: [] };
  const opaque = { frames: new Proxy([child], { get(array, key) {
    if (typeof key === 'string' && !/^(length|\d+)$/.test(key)) throw Error('cross-origin named access');
    return Reflect.get(array, key);
  } }) };
  Object.defineProperties(opaque, { name: { get() { throw Error('cross-origin'); } },
    document: { get() { throw Error('cross-origin'); } } });
  f.window.top = { frames: [opaque] };
  try {
    assert.equal(f.hook.prepare(new f.Element('a', { href: '/next', target: 'destination' }), 'found', 1000), false);
    assert.equal(f.hook.prepare(new f.Element('a', { href: '/next', target: 'unknown' }), 'missing', 1000).kind, 'link');
  } finally { f.hook.off(); }
});

for (const [kind, type] of [['button', undefined], ['button', 'invalid'], ['button', 'submit'], ['input', 'submit'], ['input', 'image']])
  for (const target of ['', '_self', '_blank']) test('CR4 native form owner and type decide submit disposition: ' + [kind, type, target], () => {
    const f = hookFixture(), form = new f.Element('form', { target });
    const control = kind === 'button' ? new f.HTMLButtonElement({ type }, form) : new f.HTMLInputElement({ type }, form);
    const span = new f.Element('span'); span.parentElement = control;
    // Captured IDL getters and attribute methods must survive later page overrides.
    Object.defineProperties(control, { form: { get() { throw Error('page form getter'); } },
      type: { get() { throw Error('page type getter'); } } });
    control.getAttribute = () => { throw Error('page attribute getter'); };
    try { assert.equal(f.hook.prepare(span, 'submit', 1000), target === '_blank'); }
    finally { f.hook.off(); }
  });

test('CR4 native submit formtarget overrides its form target and non-submit buttons remain commands', () => {
  const f = hookFixture(), form = new f.Element('form', { target: '_blank' });
  try {
    assert.equal(f.hook.prepare(new f.HTMLButtonElement({ formtarget: '_self' }, form), 'self', 1000), false);
    assert.equal(f.hook.prepare(new f.HTMLButtonElement({ type: 'button' }, form), 'button', 1000), true);
    f.hook.finish('button');
    assert.equal(f.hook.prepare(new f.HTMLInputElement({ type: 'reset' }, form), 'reset', 1000), true);
  } finally { f.hook.off(); }
});

for (const labelled of [false, true]) for (const row of [
  { form: '_blank', expected: true },
  { form: 'new-context', expected: true },
  { form: '_self', control: '_blank', expected: true },
  { form: '_blank', control: '', base: '_blank', expected: false },
  { form: '_blank', control: '_self', expected: false },
  { base: '_blank', expected: true },
  { base: 'new-context', expected: true },
  { form: 'existing-frame', expected: false },
  { form: 'own-window', expected: false },
  { base: '_blank', form: '', expected: false },
]) test('CR7 submit destination precedence, label=' + labelled + ': ' + JSON.stringify(row), () => {
  const f = hookFixture(), child = {};
  f.window.name = 'own-window'; f.window.frames = Object.assign([child], { 'existing-frame': child });
  f.document.querySelector = () => row.base === undefined ? null : new f.Element('base', { target: row.base });
  const form = new f.Element('form', row.form === undefined ? {} : { target: row.form });
  const submit = new f.HTMLInputElement({ type: 'submit', ...(row.control === undefined ? {} : { formtarget: row.control }) }, form);
  const node = labelled ? new f.HTMLLabelElement(submit) : submit;
  try { assert.equal(f.hook.prepare(node, 'target', 1000), row.expected); }
  finally { f.hook.off(); }
});

for (const mode of ['contenteditable', 'shadow', 'designMode']) for (const target of ['_self', '_blank', 'new-context'])
  test('CR7 link in editable ancestors stays plain: ' + mode + ' ' + target, () => {
    const f = hookFixture(), editor = new f.Element('div', { contenteditable: '' });
    const link = new f.Element('a', { href: '/landed', target }), text = new f.Element('span'); text.parentElement = link;
    if (mode === 'designMode') f.document.designMode = 'on';
    else if (mode === 'shadow') link.getRootNode = () => ({ host: editor });
    else link.parentElement = editor;
    try { assert.equal(f.hook.prepare(text, 'editable-link', 1000), false); }
    finally { f.hook.off(); }
  });

for (const target of ['_blank', 'new-context']) for (const island of ['link', 'wrapper', 'chip'])
  test('CR9 non-editable island keeps background input: ' + island + ' ' + target, () => {
    const f = hookFixture(), editor = new f.Element('div', { contenteditable: '' });
    const link = new f.Element(island === 'chip' ? 'button' : 'a', island === 'chip' ? {} : { href: '/landed', target });
    const barrier = island === 'wrapper' ? new f.Element('span', { contenteditable: 'false' }) : link;
    barrier.attrs.contenteditable = 'false'; barrier.parentElement = editor;
    if (barrier !== link) link.parentElement = barrier;
    const text = new f.Element('span'); text.parentElement = link;
    // A page override must not change the native inherited editability result.
    Object.defineProperty(text, 'isContentEditable', { get() { throw Error('page editable getter'); } });
    try {
      const result = f.hook.prepare(text, 'island', 1000);
      assert.equal(island === 'chip' ? result : result?.kind, island === 'chip' ? true : 'link');
    } finally { f.hook.off(); }
  });

test('CR9 re-enabled text and an editable link containing a non-editable child stay plain', () => {
  const f = hookFixture(), editor = new f.Element('div', { contenteditable: '' });
  const link = new f.Element('a', { href: '/landed', target: '_blank' }); link.parentElement = editor;
  const text = new f.Element('span', { contenteditable: 'false' }); text.parentElement = link;
  try {
    assert.equal(f.hook.prepare(text, 'editable-link', 1000), false);
    link.attrs.contenteditable = 'false'; text.attrs.contenteditable = 'true';
    assert.equal(f.hook.prepare(text, 'editable-text', 1000), false);
    text.attrs.contenteditable = 'false'; f.document.designMode = 'on';
    assert.equal(f.hook.prepare(text, 'design-mode', 1000), false);
  } finally { f.hook.off(); }
});

for (const multiple of [false, true]) test('CR5 select multiplicity comes from the captured native getter: ' + multiple, () => {
  const f = hookFixture(), select = new f.HTMLSelectElement(multiple ? { multiple: '' } : {}), option = new f.Element('option');
  option.parentElement = select;
  Object.defineProperty(select, 'multiple', { get() { throw Error('page multiple getter'); } });
  select.getAttribute = () => { throw Error('page attribute getter'); };
  try {
    assert.equal(f.hook.prepare(select, 'select', 1000), !multiple); f.hook.finish('select');
    assert.equal(f.hook.prepare(option, 'option', 1000), !multiple);
  } finally { f.hook.off(); }
});

test('CR5 label forwarding uses the captured native control and submit ownership getters', () => {
  const f = hookFixture(), control = new f.HTMLInputElement({ type: 'submit' }, new f.Element('form'));
  const label = new f.HTMLLabelElement(control), text = new f.Element('span'); text.parentElement = label;
  Object.defineProperty(label, 'control', { get() { throw Error('page control getter'); } });
  try { assert.equal(f.hook.prepare(text, 'label', 1000), false); }
  finally { f.hook.off(); }
});

test('CR5 a label does not forward a click on an interactive descendant to its submit control', () => {
  const f = hookFixture(), submit = new f.HTMLInputElement({ type: 'submit' }, new f.Element('form'));
  const label = new f.HTMLLabelElement(submit), button = new f.HTMLButtonElement({ type: 'button' });
  button.parentElement = label; button.interactive = true;
  button.matches = () => false;
  try { assert.equal(f.hook.prepare(button, 'nested-command', 1000), true); }
  finally { f.hook.off(); }
});

test('CR5 labels for selects do not inherit an option-selection exception', () => {
  const f = hookFixture(), select = new f.HTMLSelectElement({ multiple: '' }), label = new f.HTMLLabelElement(select);
  try { assert.equal(f.hook.prepare(label, 'select-label', 1000), true); }
  finally { f.hook.off(); }
});

test('CR4 successful link dispatch that observes closure skips takeRequest and still settles', async () => {
  const f = clickFixture({ kind: 'link' });
  f.entry.opener = 'parent'; f.entry.parent = { page: { isClosed: () => false } };
  let settled = false;
  f.entry.settlePopups = async () => { settled = true; };
  f.entry.page.evaluate = async (fn, arg) => {
    if (String(fn).includes('takeRequest')) throw Error('must not read a closed page');
    return hookAnswer(f.entry.hook, fn, arg);
  };
  await backgroundClick(f.entry, f.locator, async () => { f.entry.closed = true; });
  assert.equal(settled, true);
});

test('CR4 self-close settles popup readiness against the living opener after native reparenting', async () => {
  const f = fixture(), root = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const parent = f.registry.tab(root.tab), closing = f.page('closing', parent.targetId);
  await f.registry.idle();
  const child = f.registry.tab(parent.popups[0].tab);
  child.page.evaluate = async (fn, arg) => hookAnswer(child.hook, fn, arg);
  let release, entered;
  const held = new Promise(resolve => { release = resolve; }), installing = new Promise(resolve => { entered = resolve; });
  let finished = false;
  const clicking = backgroundClick(child, { evaluate: async (fn, arg) => hookAnswer(child.hook, fn, arg) }, async () => {
    child.cdp.emit('Page.windowOpen', {}); await closing.close();
    const survivor = f.page('reparented', parent.targetId), send = survivor.cdp.send;
    survivor.cdp.send = async (method, params) => {
      if (method === 'Runtime.evaluate') { entered(); await held; }
      return send(method, params);
    };
    throw Error('Target page has been closed');
  }).then(result => { finished = true; return result; });
  try {
    await installing;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(finished, false, 'backgroundClick must await the reparented popup installation');
  } finally { release(); await clicking; await f.registry.endTurn(); }
  assert.equal(parent.popups.length, 2);
});

// The controller's proof: HMAC-SHA-256 written in the hook with typed arrays only, checked against node:crypto.
test('hook proofs: each proof works once and only for its method, and a refused call does not burn it', () => {
  const f = hookFixture(), call = (name, ...args) => f.raw[name](hookProof(f.credentials, name), ...args);
  try {
    assert.equal(f.installed, true);
    for (let round = 0; round < 40; round++) {
      const proof = hookProof(f.credentials, 'take');
      assert.equal(hookOpen(f.credentials, f.raw.take(proof)), 0, 'a fresh proof is accepted');
      assert.throws(() => f.raw.take(proof), /refused the call/, 'the same proof is not accepted twice');
    }
    const forTake = hookProof(f.credentials, 'take');
    assert.throws(() => f.raw.finish(forTake, 'x'), /refused the call/, 'a proof made for take does not call finish');
    assert.equal(hookOpen(f.credentials, f.raw.take(forTake)), 0, 'a refused call does not burn the proof');
    assert.throws(() => f.raw.take(hookProof(newHook(), 'take')), /refused the call/, 'a proof made with another secret is refused');
    for (const bad of [undefined, null, 7, {}, '', '.', 'a.', '.b', 'abc', 'a.' + '0'.repeat(64), forTake.slice(0, -1), hookProof(f.credentials, 'take') + '0'])
      assert.throws(() => f.raw.take(bad), /refused the call/, String(bad));
    assert.ok(call('take'));
  } finally { f.hook.off(); }
});

test('hook answers: the tag is the HMAC of method, nonce and text, so the typed-array SHA-256 is exact for many lengths', async () => {
  const { createHmac } = await import('node:crypto');
  const f = hookFixture();
  try {
    for (const length of [1, 2, 3, 30, 31, 32, 33, 40, 41, 42, 55, 56, 57, 63, 64, 65, 100, 120]) {
      const nonce = Array.from({ length }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(i * 7 + length) % 36]).join('');
      const tag = createHmac('sha256', f.credentials.secret).update('take:' + nonce).digest('hex');
      const answer = f.raw.take(nonce + '.' + tag), [echoed, answerTag, ...text] = answer.split('.');
      assert.equal(echoed, nonce); assert.equal(text.join('.'), 'd0');
      assert.equal(answerTag, createHmac('sha256', f.credentials.secret).update('take:' + nonce + ':d0').digest('hex'), 'nonce length ' + length);
    }
    // A long answer: the request text carries a URL of several kilobytes.
    const proof = hookProof(f.credentials, 'prepare'), link = new f.Element('a', { href: '/' + 'p'.repeat(5000), target: '_blank' });
    assert.deepEqual(hookOpen(f.credentials, f.raw.prepare(proof, link, 'long', 1000)), { kind: 'link' });
    for (const fn of f.window.listeners.click) fn(Object.assign(new f.MouseEvent(), { nodes: [link], isTrusted: true }));
    assert.equal(hookOpen(f.credentials, f.raw.takeRequest(hookProof(f.credentials, 'takeRequest'), 'long')).url.length, 'https://fixture.invalid/'.length + 5000);
  } finally { f.hook.off(); }
});

test('hook answers: the tag is over the UTF-8 bytes of the text, as Node computes it', async () => {
  const { createHmac } = await import('node:crypto');
  const f = hookFixture();
  try {
    for (const nonce of ['\u00e9', 'a\u20ac', 'x\u{1F600}y', '\u{1F600}'.repeat(30), 'lone\ud800end', 'low\udc00end', 'end\ud83d', '\u07ff\u0800\uffff', 'mix\u00e9\u20ac\u{10000}'.repeat(8)]) {
      const tag = createHmac('sha256', f.credentials.secret).update('take:' + nonce).digest('hex');
      const answer = f.raw.take(nonce + '.' + tag), first = answer.indexOf('.'), second = answer.indexOf('.', first + 1);
      assert.equal(answer.slice(0, first), nonce);
      assert.equal(answer.slice(first + 1, second), createHmac('sha256', f.credentials.secret).update('take:' + nonce + ':d0').digest('hex'), JSON.stringify(nonce));
    }
  } finally { f.hook.off(); }
});

// A page can redefine %TypedArray%.prototype.length, every prototype method and the Math functions after the hook
// installs. Proofs and answers must neither change nor call any of them, and the secret must never reach them.
test('hook crypto: replaced typed-array length, string and array methods and Math are never called while proofs and answers are made', async () => {
  const { createHmac } = await import('node:crypto');
  const f = hookFixture();
  try {
    const seen = [];
    f.context.report = (name, value) => { seen.push(name); return value; };
    vm.runInContext(`
      (() => {
        const TA = Object.getPrototypeOf(Uint8Array.prototype), report = globalThis.report, apply = Reflect.apply;
        for (const name of ['length', 'byteLength', 'buffer', 'byteOffset']) {
          const descriptor = Object.getOwnPropertyDescriptor(TA, name);
          Object.defineProperty(TA, name, { configurable: true, get() { report('TypedArray.' + name); return descriptor.get.call(this); } });
        }
        for (const [owner, label] of [[String.prototype, 'String'], [Array.prototype, 'Array'], [Math, 'Math'], [Function.prototype, 'Function'], [Object, 'Object'], [Uint8Array.prototype, 'Uint8Array'], [Uint32Array.prototype, 'Uint32Array'], [TA, 'TypedArray'], [Set.prototype, 'Set']]) {
          for (const name of Object.getOwnPropertyNames(owner)) {
            const descriptor = Object.getOwnPropertyDescriptor(owner, name);
            if (!descriptor.configurable || typeof descriptor.value !== 'function' || name === 'constructor') continue;
            const original = descriptor.value;
            Object.defineProperty(owner, name, { ...descriptor, value: function () { report(label + '.' + name); return apply(original, this, arguments); } });
          }
        }
        Object.defineProperty(Object.prototype, 'length', { configurable: true, get() { report('Object.prototype.length'); return 0; } });
      })();`, f.context);
    seen.length = 0; // the installer above ran through its own traps
    for (let round = 0; round < 5; round++) {
      const nonce = 'abc' + round, tag = createHmac('sha256', f.credentials.secret).update('take:' + nonce).digest('hex');
      const answer = f.raw.take(nonce + '.' + tag), parts = answer.split('.');
      assert.equal(parts[1], createHmac('sha256', f.credentials.secret).update('take:' + nonce + ':d0').digest('hex'));
      assert.throws(() => f.raw.take(nonce + '.' + tag), /refused the call/);
      assert.throws(() => f.raw.take(nonce + 'x.' + tag), /refused the call/);
    }
    assert.deepEqual(seen, [], 'the hook called page-visible code: ' + seen.join(','));
  } finally { f.hook.off(); }
});

test('hook answers: hookOpen refuses a forged, replayed, re-labelled or unissued answer', () => {
  const f = hookFixture();
  try {
    const open = answer => hookOpen(f.credentials, answer);
    const proof = hookProof(f.credentials, 'take'), answer = f.raw.take(proof);
    const [nonce, tag, text] = answer.split('.');
    for (const forged of [undefined, null, 5, '', 'x', nonce + '.' + tag, nonce + '.' + '0'.repeat(64) + '.' + text, nonce + '.' + tag + '.d9', 'unissued.' + tag + '.' + text, answer + 'x'])
      assert.throws(() => open(forged), error => error.code === 'HOOK_ANSWER_REFUSED', String(forged));
    assert.equal(open(answer), 0);
    assert.throws(() => open(answer), error => error.code === 'HOOK_ANSWER_REFUSED', 'an answer opens once');
    // An answer for one method does not pass as the answer to a call of another.
    const offProof = hookProof(f.credentials, 'verdict'), takeAnswer = f.raw.take(hookProof(f.credentials, 'take'));
    assert.throws(() => open(takeAnswer.replace(/^[^.]+/, offProof.split('.')[0])), error => error.code === 'HOOK_ANSWER_REFUSED');
    assert.equal(open(f.raw.verdict(offProof, 'none')), undefined);
  } finally { f.hook.off(); }
});

test('hook install: an existing property at the key fails closed and changes nothing', () => {
  const credentials = newHook(), opens = [], real = () => 'native';
  const window = { open: real, listeners: {}, addEventListener() { opens.push('listener'); } }, planted = { prepare() { return false; } };
  Object.defineProperty(window, credentials.key, { value: planted });
  const context = vm.createContext({ window, document: { baseURI: 'https://fixture.invalid/' }, navigator: {}, URL, Date, setTimeout, clearTimeout });
  assert.equal(vm.runInContext(hookSource(credentials), context), false);
  assert.equal(window.open, real, 'no native was replaced');
  assert.deepEqual(opens, [], 'no listener was added');
  assert.equal(window[credentials.key], planted);
});

test('hook install: no options, a string secret, a short or long or malformed byte array, or an empty key install nothing', () => {
  const bytes = count => Array.from({ length: count }, (_, i) => i + 1);
  for (const options of [undefined, null, {}, { key: 'k', secret: 'x'.repeat(36) }, { key: 'k', secret: bytes(15) }, { key: 'k', secret: bytes(65) }, { key: '', secret: bytes(36) },
    { key: 7, secret: bytes(36) }, { key: 'k', secret: [...bytes(35), 256] }, { key: 'k', secret: [...bytes(35), -1] }, { key: 'k', secret: [...bytes(35), 1.5] },
    { key: 'k', secret: [...bytes(35), '7'] }, { key: 'k', secret: [...bytes(35), null] }, { key: 'k', secret: { length: 36 } }, { key: 'k', secret: null }]) {
    const window = { open() {}, listeners: {} };
    const context = vm.createContext({ window, document: {}, navigator: {}, URL, Date, setTimeout, clearTimeout });
    assert.equal(vm.runInContext(`(${popupHook})(${JSON.stringify(options)})`, context), false, JSON.stringify(options));
    assert.deepEqual(Object.keys(window).sort(), ['listeners', 'open']);
  }
});

test('hook install: the api is frozen and non-configurable, and off() switches the methods off for good', () => {
  const f = hookFixture(), descriptor = Object.getOwnPropertyDescriptor(f.window, f.credentials.key);
  assert.deepEqual({ ...descriptor, value: undefined }, { value: undefined, writable: false, enumerable: false, configurable: false });
  assert.equal(Object.isFrozen(f.raw), true);
  assert.throws(() => { 'use strict'; f.window[f.credentials.key] = {}; });
  assert.equal(f.hook.off(), true);
  assert.equal(f.window[f.credentials.key], f.raw, 'the property stays');
  assert.throws(() => f.hook.take(), /hook is off/);
  assert.equal(f.hook.off(), true, 'off is idempotent');
});

// popupHook reads these after install, so a page that replaces or deletes them must change nothing.
for (const mode of ['replace', 'delete']) test('hook globals: ' + mode + ' of every global in the page does not change what prepare, takeRequest and the window.open hold decide', () => {
  const sweepAll = `(() => { const junk = function() { return null; };
    for (const name of Object.getOwnPropertyNames(globalThis)) { if (name === 'window' || name === 'document' || name === 'globalThis') continue;
      try { ${mode === 'replace' ? 'globalThis[name] = junk' : 'delete globalThis[name]'}; } catch {} } })()`;
  const run = sweep => {
    const f = hookFixture(), link = new f.Element('a', { href: '/landed', target: '_blank' }), button = new f.Element('button'), same = new f.Element('a', { href: '/x' });
    if (sweep) vm.runInContext(sweepAll, f.context);
    try {
      const kinds = [f.hook.prepare(link, 'a', 1000)?.kind, f.hook.prepare(button, 'b', 1000), f.hook.prepare(same, 'c', 1000)];
      f.hook.finish('c');
      f.hook.prepare(link, 'd', 1000);
      for (const fn of f.window.listeners.click ?? []) fn(Object.assign(new f.MouseEvent(), { nodes: [link], isTrusted: true }));
      const request = f.hook.takeRequest('d');
      return { kinds, held: f.window.open('/danger', '_blank'), request: request && { url: request.url, target: request.target }, take: f.hook.take() };
    } finally { f.hook.off(); }
  };
  assert.deepEqual(run(true), run(false));
});

test('AD1 A4 every spelling of Enter and Space is an activation key, other keys are not', () => {
  for (const key of ['Enter', 'NumpadEnter', 'Return', '\r', '\n', 'Shift+Enter', 'Control+NumpadEnter']) assert.equal(activationKey(key), 'enter', key);
  for (const key of ['Space', ' ', 'Shift+Space']) assert.equal(activationKey(key), 'space', key);
  for (const key of ['a', 'Tab', 'Escape', 'ArrowDown', 'Control+a', '+']) assert.equal(activationKey(key), null, key);
});

test('AD1 A4 press arms a decidable link, watches a same-context one, refuses one it cannot decide', () => {
  const f = hookFixture();
  const link = attrs => new f.Element('a', { href: '/landed', ...attrs });
  try {
    assert.equal(f.call('prepare', link({ target: '_blank' }), 'blank', 1000, 'enter').kind, 'link');
    assert.equal(f.call('prepare', link({}), 'plain', 1000, 'enter').kind, 'watch');
    assert.equal(f.call('prepare', link({ target: '_blank', download: '' }), 'download', 1000, 'enter'), false);
    assert.equal(f.call('prepare', link({ target: '_blank' }), 'space', 1000, 'space'), false, 'Space never follows a link');
    for (const href of ['http://user:secret@fixture.invalid/x', 'about:blank', 'mailto:a@b.c'])
      assert.deepEqual({ ...f.call('prepare', link({ target: '_blank', href }), 'undecidable', 1000, 'enter') }, { kind: 'refuse', reason: 'link' }, href);
    // The same links under a click keep the Ctrl-click path.
    assert.equal(f.call('prepare', link({ target: '_blank', href: 'about:blank' }), 'click', 1000), true);
  } finally { f.call('off'); }
});

test('AD1 A4 press decides a form from its elements and the control\'s own form and formtarget', () => {
  const f = hookFixture(), form = new f.Element('form', {});
  const button = attrs => new f.HTMLButtonElement({ type: 'submit', ...attrs }, form);
  const field = new f.HTMLInputElement({}, form);
  try {
    // A submit button outside the form (form=) carries its own formtarget.
    assert.deepEqual({ ...f.call('prepare', button({ formtarget: '_blank' }), 'own', 1000, 'enter') }, { kind: 'refuse', reason: 'form' });
    // Enter in a field submits through the form's default button, the first submit control among form.elements.
    form.elements = [field, button({ formtarget: 'elsewhere' }), button({})];
    assert.deepEqual({ ...f.call('prepare', field, 'default', 1000, 'enter') }, { kind: 'refuse', reason: 'form' });
    form.elements = [field, button({}), button({ formtarget: '_blank' })];
    assert.equal(f.call('prepare', field, 'later', 1000, 'enter').kind, 'watch', 'a later button does not decide the default submission');
    // Space in a field types a space: it is no activation.
    assert.equal(f.call('prepare', field, 'space-field', 1000, 'space'), false);
    form.attrs.target = '_blank'; form.elements = [field];
    assert.deepEqual({ ...f.call('prepare', field, 'form-target', 1000, 'enter') }, { kind: 'refuse', reason: 'form' });
    assert.equal(f.call('prepare', new f.HTMLButtonElement({ type: 'button' }, form), 'plain-button', 1000, 'enter'), false);
  } finally { f.call('off'); }
});

function watchedClick(f, link, token = 'watch') {
  assert.equal(f.call('prepare', link, token, 1000).kind, 'watch');
  const click = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [link] });
  for (const listener of f.window.captureListeners.click) listener(click);
  return click;
}

test('AD1 flip: a same-tab link that a listener turns into a new-tab link is cancelled and opened in the background', () => {
  const f = hookFixture(), link = new f.Element('a', { href: '/landed', target: '_self' });
  try {
    const click = watchedClick(f, link);
    assert.equal(click.nativePrevented, undefined, 'a plain same-tab link keeps its default');
    link.attrs.target = '_blank'; f.observers[0].callback([]);
    assert.equal(click.nativePrevented, true, 'the browser must not open it itself');
    assert.equal(click.defaultPrevented, false);
    assert.deepEqual(JSON.parse(JSON.stringify(f.call('takeRequest', 'watch'))), { url: 'https://fixture.invalid/landed', target: '_blank', rel: '' });
  } finally { f.call('off'); }
});

test('AD1 flip: a page that cancels before it flips still gets no tab', () => {
  const f = hookFixture(), link = new f.Element('a', { href: '/landed', target: '_self' });
  try {
    const click = watchedClick(f, link);
    click.preventDefault(); link.attrs.target = '_blank'; f.observers[0].callback([]);
    assert.equal(f.call('takeRequest', 'watch'), undefined);
  } finally { f.call('off'); }
});

test('AD1 flip: a flip made before the click is seen at capture, a flip back is seen at takeRequest', () => {
  const f = hookFixture(), link = new f.Element('a', { href: '/landed', target: '_self' });
  try {
    f.call('prepare', link, 'early', 1000);
    link.attrs.target = '_blank';
    const click = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [link] });
    for (const listener of f.window.captureListeners.click) listener(click);
    assert.equal(click.nativePrevented, true);
    link.attrs.target = '_self';
    assert.equal(f.call('takeRequest', 'early').unavailable, true, 'the final target decides, not the earlier one');
  } finally { f.call('off'); }
});

test('AD1 flip: a link that turns into one sleight cannot check is cancelled and reported', () => {
  const f = hookFixture(), link = new f.Element('a', { href: '/landed', target: '_self' });
  try {
    const click = watchedClick(f, link);
    link.attrs.target = '_blank'; link.attrs.href = 'http://user:secret@fixture.invalid/x'; f.observers[0].callback([]);
    assert.equal(click.nativePrevented, true);
    assert.deepEqual({ ...f.call('takeRequest', 'watch') }, { blocked: 'link' });
  } finally { f.call('off'); }
});

test('AD1 flip: a same-tab form whose target turns new-tab is cancelled at the click and at the submit event', () => {
  const f = hookFixture(), form = new f.Element('form', { action: '/landed' }), submit = new f.HTMLButtonElement({ type: 'submit' }, form);
  try {
    const click = watchedClick(f, submit, 'click-flip');
    form.attrs.target = '_blank'; f.observers[0].callback([]);
    assert.equal(click.nativePrevented, true);
    assert.deepEqual({ ...f.call('takeRequest', 'click-flip') }, { blocked: 'form' });
    f.call('finish', 'click-flip'); delete form.attrs.target;
    const second = watchedClick(f, submit, 'submit-flip');
    assert.equal(second.nativePrevented, undefined);
    const event = Object.assign(new f.Event(), { isTrusted: true, nodes: [form] });
    for (const listener of f.window.captureListeners.submit) listener(event);
    assert.equal(event.nativePrevented, undefined, 'still a same-tab form');
    form.attrs.target = '_blank'; f.observers.at(-1).callback([]);
    assert.equal(event.nativePrevented, true, 'the submit event is the one that must not proceed');
    assert.deepEqual({ ...f.call('takeRequest', 'submit-flip') }, { blocked: 'form' });
  } finally { f.call('off'); }
});

test('AD1 flip: the watch ends with its arm and ignores changes after the click was dispatched', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = hookFixture(), link = new f.Element('a', { href: '/landed', target: '_self' });
  try {
    const click = watchedClick(f, link);
    t.mock.timers.tick(0);
    link.attrs.target = '_blank'; f.observers[0].callback([]);
    assert.equal(click.nativePrevented, undefined, 'after dispatch there is nothing left to cancel');
    f.call('finish', 'watch');
    assert.equal(f.observers[0].disconnected, true);
  } finally { f.call('off'); }
});

test('AD1 flip: backgroundClick opens a flipped link, throws for a blocked one, and ignores a watch the navigation destroyed', async () => {
  const run = async (prepared, request) => {
    const f = clickFixture(prepared);
    f.entry.page.evaluate = async (fn, arg) => {
      if (String(fn).includes('takeRequest') && request instanceof Error) throw request;
      return hookAnswer(f.entry.hook, fn, arg, { request: request instanceof Error ? undefined : request });
    };
    f.entry.openChild = async (url, options) => f.calls.push(['openChild', url, options]);
    await backgroundClick(f.entry, f.locator, async options => f.calls.push(['click', options]));
    return f.calls;
  };
  const opened = await run({ kind: 'watch' }, { url: 'https://fixture.invalid/landed', target: '_blank', rel: '' });
  assert.deepEqual(opened.filter(c => ['click', 'openChild'].includes(c[0])), [['click', {}], ['openChild', 'https://fixture.invalid/landed', { target: '_blank', rel: '' }]]);
  await assert.rejects(run({ kind: 'watch' }, { blocked: 'form' }), /changed this form/);
  await assert.rejects(run({ kind: 'watch' }, { blocked: 'link' }), /changed this link/);
  await run({ kind: 'watch' }, { unavailable: true, lost: true });
  await run({ kind: 'watch' }, new Error('Execution context was destroyed'));
  await assert.rejects(run({ kind: 'watch' }, { unavailable: true }), /changed or was not captured/);
  await assert.rejects(run({ kind: 'link' }, { unavailable: true, lost: true }), /changed or was not captured/);
  await assert.rejects(run({ kind: 'refuse', reason: 'link' }, undefined), /cannot check where it goes/);
  await assert.rejects(run({ kind: 'refuse', reason: 'form' }, undefined), /click its submit button/);
});

test('AD1 backstop: a popup the page opens during a click without the background modifier is reported, one sleight opens is not', async () => {
  const f = fixture({ upstream: { async send() { return { targetInfos: [] }; } } });
  const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const entry = f.registry.tab(tab);
  entry.page.evaluate = async (fn, arg) => hookAnswer(entry.hook, fn, arg);
  const opener = f.pages.at(-1).info.targetId;
  const click = async (modified, opens) => {
    const before = entry.popups.length;
    await backgroundClick(entry, { evaluate: async (fn, arg) => hookAnswer(entry.hook, fn, arg, { prepare: modified }) }, async () => {
      entry.cdp.emit('Page.windowOpen', {});
      await opens();
    });
    return entry.popups.length - before;
  };
  assert.equal(await click(false, async () => { f.page('page-opened-1', opener); await new Promise(resolve => setTimeout(resolve, 2)); }), 1);
  assert.equal(await entry.takeForeground(), 1);
  assert.equal(await entry.takeForeground(), 0, 'reported once');
  assert.equal(await click(true, async () => { f.page('page-opened-2', opener); await new Promise(resolve => setTimeout(resolve, 2)); }), 1);
  assert.equal(await entry.takeForeground(), 0, 'a click that carried the background modifier expects its popup');
  await entry.openChild('https://fixture.invalid/second');
  assert.equal(await entry.takeForeground(), 0, 'a tab sleight opened itself is in the background');
  await f.registry.endTurn();
});

test('AD1 pop4: a modified or auxiliary synthetic click on a link is held and counted, a plain one is left alone', () => {
  const f = hookFixture(), link = new f.Element('a', { href: '/x' });
  link.interactive = true;
  const fire = init => {
    const event = Object.assign(new f.MouseEvent(), { isTrusted: false, nodes: [link], ...init });
    for (const fn of f.window.listeners.click) fn(event);
    return event;
  };
  try {
    assert.equal(fire({}).nativePrevented, undefined, 'a plain synthetic click on a same-tab link is not held');
    assert.equal(f.hook.take(), 0);
    assert.equal(fire({ shiftKey: true }).nativePrevented, true);
    assert.equal(fire({ control: true }).nativePrevented, true);
    assert.equal(fire({ altKey: true }).nativePrevented, true);
    assert.equal(fire({ button: 1 }).nativePrevented, true);
    assert.equal(fire({ button: 0, shiftKey: false }).nativePrevented, undefined);
    assert.equal(f.hook.take(), 4);
    const aux = Object.assign(new f.MouseEvent('auxclick'), { isTrusted: false, nodes: [link] });
    assert.ok(f.window.listeners.auxclick.size > 0, 'auxclick has the same guard');
    for (const fn of f.window.listeners.auxclick) fn(aux);
    assert.equal(aux.nativePrevented, true);
    const trusted = Object.assign(new f.MouseEvent(), { isTrusted: true, nodes: [link], button: 1 });
    for (const fn of f.window.listeners.click) fn(trusted);
    assert.equal(trusted.nativePrevented, undefined, 'a user\'s own middle click is not touched');
  } finally { f.hook.off(); }
  assert.equal(f.window.listeners.auxclick.size, 0, 'off() removes the auxclick guard');
});

test('AD1 pop4: changed and watching take a proof like every other call', () => {
  const f = hookFixture();
  try {
    assert.throws(() => f.raw.changed('forged.0000'), /refused/);
    assert.throws(() => f.raw.watching('forged.0000', true), /refused/);
    const proof = hookProof(f.credentials, 'changed');
    f.raw.changed(proof);
    assert.throws(() => f.raw.changed(proof), /refused/, 'a proof is good once');
    assert.throws(() => f.raw.changed(hookProof(f.credentials, 'take')), /refused/, 'and only for its own method');
    f.raw.watching(hookProof(f.credentials, 'watching'), true);
    f.raw.watching(hookProof(f.credentials, 'watching'), false);
  } finally { f.hook.off(); }
});

test('AD1 pop4: a popup opened after the click settled is reported once, and only a settled background popup is background', async () => {
  const f = fixture({ upstream: { async send() { return { targetInfos: [] }; } } });
  const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const entry = f.registry.tab(tab);
  entry.page.evaluate = async (fn, arg) => hookAnswer(entry.hook, fn, arg);
  const opener = f.pages.at(-1).info.targetId;
  let settled;
  await backgroundClick(entry, { evaluate: async (fn, arg) => hookAnswer(entry.hook, fn, arg, { prepare: true }) }, async () => {
    entry.cdp.emit('Page.windowOpen', {});
    settled = f.page('page-opened-1', opener); await new Promise(resolve => setTimeout(resolve, 2));
  });
  assert.equal(entry.popupIsBackground(settled), true, 'a modified click\'s settling classified it');
  assert.equal(await entry.takeForeground(), 0);
  const late = f.page('page-opened-late', opener); await f.registry.idle();
  assert.equal(entry.popupIsBackground(late), false, 'a popup nothing settled is not known to be in the background');
  assert.equal(await entry.takeForeground(), 1);
  assert.equal(await entry.takeForeground(), 0, 'reported once');
  const own = await entry.openChild('https://fixture.invalid/second');
  assert.equal(entry.popupIsBackground(f.registry.tab(own.tab).page), true);
  assert.equal(await entry.takeForeground(), 0, 'a tab sleight opened is in the background');
  await f.registry.endTurn();
});

test('AD1 pop4: raisablePopups lists open page-opened tabs on another origin that the page holds a handle to, and nothing else', async () => {
  const f = fixture({ upstream: { async send() { return { targetInfos: [] }; } } });
  const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const entry = f.registry.tab(tab), opener = f.pages.at(-1).info.targetId;
  entry.page.url = () => 'https://fixture.invalid/app';
  const same = f.page('same', opener), cross = f.page('cross', opener), blank = f.page('blank', opener), noopener = f.page('noopener', opener);
  same.url = () => 'https://fixture.invalid/same'; cross.url = () => 'https://idp.invalid/signin'; blank.url = () => 'about:blank';
  noopener.url = () => 'https://docs.invalid/page'; noopener.info.canAccessOpener = false;
  await f.registry.idle();
  const crossTab = (await f.registry.list()).find(row => row.targetId === 'cross').tab;
  await entry.openChild('https://idp.invalid/own');
  assert.deepEqual(await entry.raisablePopups(), [crossTab], 'not the same-origin, blank or noopener ones, not the one sleight opened');
  cross.info.canAccessOpener = false;
  assert.deepEqual(await entry.raisablePopups(), [], 'a popup that dropped its opener is not listed either');
  cross.info.canAccessOpener = true;
  await cross.close();
  assert.deepEqual(await entry.raisablePopups(), []);
  await f.registry.endTurn();
});

// document.open() and document.write erase the window's listeners; the hook puts every one back, auxclick and the click guard included.
test('AD1 pop4 + swap4: document.open and write re-add every listener the hook uses, auxclick too', () => {
  for (const name of ['open', 'write', 'writeln']) {
    const f = hookFixture({ rewritable: true });
    const before = Object.keys(f.window.listeners).sort();
    assert.ok(before.includes('auxclick') && before.includes('click') && before.includes('submit'), before.join());
    f.document[name]('<p>');
    assert.deepEqual(Object.keys(f.window.listeners).sort(), before, name + ' re-adds the same types');
    assert.ok(f.window.captureListeners.auxclick?.size > 0, name + ' re-adds the auxclick guard in the capture phase');
    // The guard it re-added still holds a modified click on a link.
    const link = new f.Element('a', { href: '/x' });
    link.interactive = true;
    const aux = Object.assign(new f.MouseEvent('auxclick'), { isTrusted: false, nodes: [link] });
    for (const listener of f.window.listeners.auxclick) listener(aux);
    assert.equal(aux.nativePrevented, true, name + ': an auxclick on a link is still held after the rewrite');
    assert.equal(f.hook.take(), 1);
    f.hook.off();
  }
});

test('AD1 pop5: takeForeground waits, for a bounded time, for a popup the page opened that is still being admitted', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ popupWaitMs: 400, upstream: { async send() { await gate; return { targetInfos: [{ type: 'page', targetId: 'late-child', openerId: 'target-1' }] }; } },
    ownTarget: async targetId => { f.page(targetId, 'target-1'); } });
  const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const entry = f.registry.tab(tab);
  entry.cdp.emit('Page.windowOpen', {});
  assert.equal(entry.popups.length, 0, 'not admitted yet');
  setTimeout(release, 30);
  assert.equal(await entry.takeForeground(), 1, 'the tab admitted while the result was being built is counted in it');
  assert.equal(entry.popups.length, 1);
  assert.equal(await entry.takeForeground(), 0, 'reported once');
  await f.registry.endTurn();
});

test('AD1 pop5: takeForeground gives up after the bound when no popup is ever admitted, and an idle page pays nothing', async () => {
  const f = fixture({ popupWaitMs: 300, upstream: { async send() { return { targetInfos: [] }; } }, ownTarget: async () => {} });
  const { tab } = await f.registry.openTab({ url: 'https://fixture.invalid/' });
  const entry = f.registry.tab(tab);
  let started = Date.now();
  assert.equal(await entry.takeForeground(), 0);
  assert.ok(Date.now() - started < 50, 'no window.open happened: no wait');
  entry.cdp.emit('Page.windowOpen', {});
  started = Date.now();
  assert.equal(await entry.takeForeground(), 0);
  assert.ok(Date.now() - started < 1100, 'bounded');
  await f.registry.endTurn();
});

// AD1 pop5, F-INT-1. A same-site frame that answers "absent" is hookless by design only when it cannot run scripts: its iframe's
// sandbox attribute, or an ancestor's, lacks allow-scripts. Otherwise it fails the arm closed and the message sends the model to
// the engine browser path, never "a retry is safe".
const shieldFrames = (specs, { throws = false, hooked = false } = {}) => {
  const hook = newHook();
  // hooked: the registry's script ran in the frame but its listeners never fire (scripts are off), so adopt answers that it could not arm.
  const evaluate = async (fn, arg) => hooked ? hookAnswer(hook, fn, arg, { adopt: false }) : 'absent';
  const main = { url: () => 'https://site.example/', parentFrame: () => null, evaluate, isDetached: () => false };
  const frames = specs.map(([url, sandbox, parent]) => ({ url: () => url, sandbox, parentFrame: () => parent ? frames[parent - 1] : main, evaluate, isDetached: () => false }));
  const page = { mainFrame: () => main, frames: () => [main, ...frames], url: () => main.url(), on() {}, off() {} };
  const sandboxOf = async frame => { if (throws) throw Error('owner unreachable'); return frame.sandbox ?? null; };
  return { main, frames, page, shield: () => frameShield(page, main, { hook, token: 't', capMs: 1000, timeoutMs: 50, sandboxOf }) };
};
const SAME = 'https://site.example/frame';
for (const [name, specs, expected] of [
  ['a plain same-site frame', [[SAME, null]], false],
  ['<iframe sandbox>', [['about:blank', '']], true],
  ['sandbox="allow-same-origin"', [[SAME, 'allow-same-origin']], true],
  ['sandbox="allow-forms allow-popups"', [[SAME, 'allow-forms allow-popups']], true],
  ['sandbox with allow-scripts', [[SAME, 'allow-scripts allow-same-origin']], false],
  ['sandbox with ALLOW-SCRIPTS in capitals and a tab', [[SAME, 'allow-same-origin\tALLOW-SCRIPTS']], false],
  ['sandbox="not-allow-scripts" (a different token)', [[SAME, 'not-allow-scripts']], true],
  ['a frame inside a script-less sandboxed frame', [[SAME, ''], [SAME, null, 1]], true],
  ['a script-less frame inside a frame that can run scripts and has no hook', [[SAME, null], [SAME, '', 1]], false],
  ['a plain frame inside a frame that can run scripts', [[SAME, 'allow-scripts allow-same-origin'], [SAME, null, 1]], false],
]) test('frameShield: ' + name + (expected ? ' is hookless by design and arms' : ' with no hook fails the arm closed'), async () => {
  const f = shieldFrames(specs), shield = f.shield();
  assert.equal(await shield.arm(), expected);
  assert.equal(shield.unarmable, !expected);
  await shield.release();
});
test('frameShield: a frame whose sandbox attribute cannot be read fails closed, a cross-site frame is still hookless', async () => {
  const unreadable = shieldFrames([[SAME, '']], { throws: true }).shield();
  assert.equal(await unreadable.arm(), false);
  assert.equal(unreadable.unarmable, true);
  const cross = shieldFrames([['https://elsewhere.example/', null]]).shield();
  assert.equal(await cross.arm(), true);
  assert.equal(cross.unarmable, false);
});
test('backgroundClick: a same-site frame that runs scripts and has no hook sends the model to the engine browser path, never a retry', async () => {
  const f = clickFixture(true), page = shieldFrames([[SAME, null]]).page;
  Object.assign(f.entry.page, { mainFrame: page.mainFrame, frames: page.frames, url: page.url, on() {}, off() {} });
  await assert.rejects(backgroundClick(f.entry, f.locator, async options => f.calls.push(['click', options])),
    error => /use the engine browser path/.test(error.message) && !/retry is safe|read again/.test(error.message));
  assert.equal(f.calls.filter(c => c[0] === 'click').length, 0, 'nothing was sent');
});
test('backgroundClick: a sandboxed frame whose owner cannot be read fails closed with the engine browser path message', async () => {
  const f = clickFixture(true), page = shieldFrames([['about:blank', '']]).page;
  Object.assign(f.entry.page, { mainFrame: page.mainFrame, frames: page.frames, url: page.url, on() {}, off() {} });
  // The default reader needs a real owner element; this fake page has none, so the sandbox cannot be read and the frame fails closed.
  await assert.rejects(backgroundClick(f.entry, f.locator, async () => {}), /use the engine browser path/);
});
test('frameShield: a frame whose hook cannot arm (scripts off) is skipped only when its sandbox lacks allow-scripts', async () => {
  for (const [sandbox, expected] of [['', true], ['allow-same-origin', true], [null, false], ['allow-scripts', false]]) {
    const shield = shieldFrames([[SAME, sandbox]], { hooked: true }).shield();
    assert.equal(await shield.arm(), expected, String(sandbox));
    assert.equal(shield.unarmable, !expected, String(sandbox));
  }
});


import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { withMT } from './fixtures/mt-env.mjs';
for (const mode of [undefined, '0']) test(`MT4 tab handles stay private to the owning registry, switch=${mode}`, async () => withMT(mode, async () => {
  const f = fixture(), other = fixture();
  try {
    const handles = await Promise.all(Array.from({ length: 20 }, () => f.registry.openTab({ url: 'https://fixture.invalid/' })));
    assert.equal(new Set(handles.map(row => row.tab)).size, 20);
    for (const { tab } of handles) {
      assert.match(tab, mode === '0' ? /^t[0-9a-f]{32}$/ : /^t[a-z2-7]{9}$/);
      assert.throws(() => other.registry.tab(tab), /unknown|owned/i);
    }
    assert.throws(() => f.registry.tab('tforged123'), /unknown|owned/i);
  } finally { await f.registry.endTurn(); await other.registry.endTurn(); }
}));
test('MT4 retries a random collision without replacing the live tab', async t => withMT(undefined, async () => {
  const original = crypto.randomBytes; let draws = 0;
  const mocked = t.mock.method(crypto, 'randomBytes', size => size === 9 ? Buffer.alloc(9, draws++ < 2 ? 0 : 1) : original(size));
  syncBuiltinESMExports();
  const f = fixture();
  try {
    const first = await f.registry.openTab({ url: 'https://fixture.invalid/first' });
    const firstPage = f.registry.tab(first.tab).page;
    const second = await f.registry.openTab({ url: 'https://fixture.invalid/second' });
    assert.equal(draws, 3); assert.notEqual(second.tab, first.tab);
    assert.equal(f.registry.tab(first.tab).page, firstPage);
    assert.notEqual(f.registry.tab(second.tab).page, firstPage);
    assert.equal((await f.registry.list()).length, 2);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); await f.registry.endTurn(); }
}));
