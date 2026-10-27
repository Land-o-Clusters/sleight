// Count installed-worker package checks with real protocol, context and runners.
// Only browser transport, pages, DOM reads and native UI are fixtures. No app runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { startInstalledV3Worker, createV3TurnRuntime, createV3Bridge, serveV3Worker } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { createActionRunner } from '../plugins/sleight/lib/direct-browser/act.mjs';
import { check } from '../plugins/sleight/lib/direct-browser/rules.mjs';

test('count package checks through first open, history navigation, one field and ten fields', async t => {
  let checks = 0, serial = 0, snapshotNo = 0, document = {}, fills = 0, navigations = 0;
  const replies = new Map(), channel = new EventEmitter(); channel.connected = true;
  channel.send = frame => replies.get(frame.id)?.(frame.result);
  const request = (method, params) => new Promise(resolve => {
    const id = 'q' + ++serial; replies.set(id, resolve);
    channel.emit('message', { version: 3, id, method, params });
  });
  const page = new EventEmitter(), handles = new Map();
  page.url = () => 'https://fixture.invalid/form'; page.title = async () => 'Fixture'; page.mainFrame = () => page;
  page.frames = () => [page]; page.evaluate = async () => undefined;
  page.goBack = async () => { navigations++; document = {}; page.emit('framenavigated', page); };
  page.getByRef = ref => {
    if (handles.has(ref)) return handles.get(ref);
    let value = '';
    const element = { tag: ref === 'e20' ? 'a' : 'input', kind: ref === 'e20' ? 'link' : 'text',
      role: ref === 'e20' ? 'link' : 'textbox', link: ref === 'e20', connected: true, visible: true, enabled: true,
      hit: true, submit: false, payment: false, form: false, formPayment: false };
    const read = (source, arg) => {
      const name = /function (\w+)/.exec(source)?.[1];
      if (name === 'inspect') return { ...element, editableText: true, matched: value === String(arg) };
      if (name === 'inspectElement' || name === 'inspectTarget') return { ...element, name: 'Field' };
      if (name === 'readPaymentPage') return { origin: 'https://fixture.invalid', name: 'Field' };
      if (name === 'readNativeEditContext') return { native: false, eligible: false };
      if (name === 'samePageDocument') return arg === document;
      if (name === 'forwardInfo') return { label: false, areas: [] };
      if (name === 'inspectConsent') return { blocked: false };
      if (name === 'overlaySignature') return { count: 0, hash: 1 };
      if (name === 'placeClear') return 'clear';
      if (name === 'scrollPoint') return { x: 10, y: 20 };
      throw Error('unsupported fixture reader: ' + name);
    };
    const handle = { ownerFrame: async () => page, dispose: async () => {},
      async fill(text) { value = text; fills++; },
      async click() { navigations++; document = {}; page.emit('framenavigated', page); } };
    handle._connection = { toImpl: () => ({ _frame: { utilityContext: async () => ({ world: 'utility',
      evaluateExpression: async (source, _options, args) => read(source, args[1]),
      evaluateExpressionHandle: async source => { assert.match(source, /function ownDocument/); return document; },
    }) } }) };
    handles.set(ref, handle); return handle;
  };
  const entry = { page, state: { snapshotNo: 0, submitUnconfirmed: false } };
  const snapshot = async () => ({ text: 'Fixture fields', number: ++snapshotNo });
  const pages = { openTab: async () => ({ tab: 't1' }), tab: tab => { assert.equal(tab, 't1'); return entry; },
    enqueue: async (tab, fn) => { assert.equal(tab, 't1'); return fn(entry); },
    endTurn: async () => ({ cleanedUp: true }) };
  const upstream = {}, selected = { selectedBrowser: 'bfixture', session: upstream,
    endpoint: 'ws://127.0.0.1:9222/devtools/browser/fixture',
    connect: async () => upstream, verifyConnection: async () => true, disconnect: async () => true,
    onConnectionLoss: () => () => {}, createFilter: () => ({
      listen: async () => ({ endpoint: 'private', close: async () => {} }), dispose: async () => true }) };
  const host = await startInstalledV3Worker({ channel }, {
    recoverClipboard: async () => {}, readConfig: () => ({}), readConfigFile: () => null,
    acceptPackage: () => ({ current: () => { checks++; return true; } }),
    readHand: () => ({ state: 'off' }), sites: () => false, schedule: () => undefined,
    prepareHelpers: async () => ({ status: 'ready', receipt: {} }), selectConnection: async () => selected,
    createUi: () => ({ present() {}, authenticate: () => false, close() {} }),
    loadPlaywright: () => ({ inprocess: { playwright: { chromium: { connectOverCDP: async () => ({
      newBrowserCDPSession: async () => ({}), close: async () => {} }) } } } }),
    createPages: () => pages,
    snapshot,
    createRuntime: options => createV3TurnRuntime({ ...options,
      dependencies: { ...options.dependencies, recordingSupported: false, runSteps: createActionRunner({ check, snapshot,
        backgroundClick: (_tab, _locator, click) => click({}, async () => true) }) } }),
  });
  try {
    const startup = checks;
    assert.equal((await request('begin', { turn: 'one', text: 'Fill the form.', apps: [] })).available, true);
    const begin = checks - startup, counts = {};
    const call = async (label, name, args) => {
      const before = checks, result = await request('call', { name, arguments: args });
      assert.equal(result.result.isError, false, result.result.text);
      const callChecks = checks - before;
      const hash = createHash('sha256').update(JSON.stringify(result.result)).digest('hex');
      assert.equal(await request('delivered', { resultId: result.resultId, hash }), true);
      counts[label] = { call: callChecks, delivered: checks - before - callChecks };
      return result.result;
    };
    await call('firstOpen', 'browser_open', { url: 'https://fixture.invalid/form' });
    await call('navigation', 'browser_act', { tab: 't1', steps: [{ do: 'back' }] });
    assert.equal(navigations, 1);
    const link = await call('linkNavigation', 'browser_act', { tab: 't1', steps: [{ do: 'navigate', ref: 'e20' }] });
    assert.match(link.text, /navigated/); assert.equal(navigations, 2);
    const single = await call('oneField', 'browser_fill', { tab: 't1', fields: [{ ref: 'e1', value: 'one' }] });
    assert.match(single.text, /set/); assert.equal(fills, 1);
    await call('tenFields', 'browser_fill', { tab: 't1', fields: Array.from({ length: 10 }, (_, i) => ({ ref: 'e' + (i + 1), value: String(i) })) });
    assert.equal(fills, 11);
    t.diagnostic(JSON.stringify({ startup, begin, counts }));
    for (const row of Object.values(counts)) { assert.ok(row.call > 0); assert.equal(row.delivered, 1); }
    assert.ok(counts.tenFields.call > counts.oneField.call);
  } finally { await host.close(); }
});

test('count the relay bridge package checks in addition to the worker checks', async t => {
  let checks = 0;
  const child = new EventEmitter(), channel = new EventEmitter();
  child.connected = channel.connected = true;
  child.send = frame => queueMicrotask(() => channel.emit('message', structuredClone(frame)));
  channel.send = frame => queueMicrotask(() => child.emit('message', structuredClone(frame)));
  child.disconnect = () => { child.connected = channel.connected = false; channel.emit('disconnect'); child.emit('disconnect'); };
  child.unref = () => {};
  const server = serveV3Worker({ channel, browser: 'bfixture', begin: async () => ({
    call: async () => ({ text: 'Fixture result', isError: false }), delivered: () => true,
    end: async () => ({ revoked: true, cleanup: [] }),
  }) });
  const bridge = await createV3Bridge({}, { readConfig: () => ({}), shareConsent: async () => null,
    acceptPackage: () => ({ current: () => { checks++; return true; } }),
    forkWorker: () => { queueMicrotask(() => server.ready()); return child; } });
  try {
    const startup = checks;
    assert.equal(await bridge.bind({ ...bridge.bootstrapEnvelope(), event: 'begin', turn: 'one', text: 'Fill the form.' }), true);
    const begin = checks - startup, counts = [];
    for (const request of [
      { name: 'browser_open', arguments: { url: 'https://fixture.invalid/form' } },
      { name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'back' }] } },
      { name: 'browser_act', arguments: { tab: 't1', steps: [{ do: 'navigate', ref: 'e20' }] } },
      { name: 'browser_fill', arguments: { tab: 't1', fields: [{ ref: 'e1', value: 'one' }] } },
      { name: 'browser_fill', arguments: { tab: 't1', fields: Array.from({ length: 10 }, (_, i) => ({ ref: 'e' + (i + 1), value: String(i) })) } },
    ]) {
      const before = checks, result = await bridge.call(request), call = checks - before;
      assert.equal(result.isError, false); assert.equal(bridge.delivered(result), true);
      const delivered = checks - before - call;
      // Collect delivery's async reply before the next measured call.
      for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
      counts.push({ tool: request.name, call, delivered });
      assert.deepEqual({ call, delivered }, { call: 3, delivered: 2 });
    }
    t.diagnostic(JSON.stringify({ relayStartup: startup, relayBegin: begin, counts }));
  } finally { await bridge.detach(); }
});
