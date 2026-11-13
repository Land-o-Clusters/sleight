import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import vm from 'node:vm';
import { FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease, leaseKey } from '../plugins/sleight/lib/input-lease.mjs';

const appId = 'com.apple.TextEdit', app = 'TextEdit';
const window = name => ({ appId, app, title: `${name}.txt`, url: `file:///tmp/${name}.txt` });
const identityScript = readFileSync(new URL('../plugins/sleight/lib/window-identity.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, options = {}) {
  const root = options.root ?? '/tmp';
  const window = name => ({ appId, app, title: `${name}.txt`, url: `file://${root}/${name}.txt`, ...options.document });
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const sent = [], received = [], selections = [], leases = [], drags = [], invalidRequests = [], actions = [], censuses = [];
  let current, broken = false, epoch = 1, focusOverride;
  const observations = [], released = [], active = new Set();
  const windows = ['Source', 'Target'].map((name, i) => ({ AXTitle: `${name}.txt`, AXDocument: `file://${root}/${name}.txt`, AXWindowNumber: 11 + i }));
  const list = values => ({ count: values.length, objectAtIndex: i => values[i] });
  const axApp = { AXWindows: list(windows) };
  let context;
  const resetIdentity = () => {
    const $ = Object.assign(value => value, {
      NSUUID: { UUID: { UUIDString: `fixture-${epoch++}` } }, AXIsProcessTrusted: () => true,
      NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => list([{ processIdentifier: 7, launchDate: { timeIntervalSince1970: 1 } }]) },
      AXUIElementCreateApplication: () => { axApp.AXFocusedWindow = windows[focusOverride ?? (current?.title === 'Source.txt' ? 0 : 1)]; return axApp; },
      AXUIElementSetMessagingTimeout: () => 0,
      AXUIElementCopyAttributeValue: (el, key, out) => { if (el[key] === undefined) return -25205; out[0] = el[key]; return 0; },
      CFEqual: (a, b) => a === b, CGEventSourceSecondsSinceLastEventType: () => 20,
    });
    context = vm.createContext({ $, Ref: () => [], ObjC: { import() {}, unwrap: v => v, deepUnwrap: v => v, castRefToObject: v => v } });
    vm.runInContext(identityScript, context);
  };
  resetIdentity();
  const snapshot = () => options.tree?.(current) ?? `Window: "${current.title}", App: ${app}.\nURL: ${current.url}\n0 standard window ${current.title}\n\t1 text area Value: sample\n\t2 text area Value: alpha move-62f9a451 omega`;
  let output;
  const raw = { getScreenshot: async () => 'screenshot', getAXState: async (args = {}) => {
    const text = snapshot(); if (args.emit !== false) output.push(text); return text;
  } };
  for (const name of ['click', 'pressKey', 'performSecondaryAction', 'typeText']) raw[name] = async (...args) => {
    actions.push([name, ...args]); options.action?.(name, args);
  };
  const engine = vm.createContext({ app: raw, cua: { getApp: async () => { output.push(snapshot()); return raw; } },
    setTimeout, clearTimeout, nodeRepl: { write: value => output.push(String(value)) } });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, changeReview: options.changeReview ?? false, flowRules: options.flowRules,
    restartEngine: async () => ({ serverIn, serverOut }),
    stopEngine: options.stopEngine ?? (async () => ({ collected: true, cutOff: false })), stopGraceMs: 20,
    confirmPayments: options.confirmPayments,
    ask: options.ask ?? (async () => 'accept'),
    inputLease: options.inputLease ?? { acquire: (target, scope = 'window') => {
      options.beforeAcquire?.(target, scope);
      if (options.busy && scope === 'app' && target.title === 'Source.txt' && current?.title === 'Target.txt') throw Error('Input lease: held by another session, retry after 20 seconds');
      if (options.busyWindow && scope === 'window') throw Error('Input lease: window action refused');
      leases.push(target); const key = `${scope}:${target.title}`; active.add(key); return key;
    }, grant: () => ({}), renew() {}, release: keys => { for (const key of keys) { released.push(key); active.delete(key); } }, close: () => active.clear() },
    windowIdentity: async target => {
      observations.push(structuredClone(target));
      await options.beforeIdentity?.(target);
      const observed = broken ? { status: 'unknown' } : JSON.parse(context.run([JSON.stringify(target)]));
      return { ...observed, ...options.nativeMutation };
    },
    localTools: { tools: [{ name: 'open_file' }, { name: 'select_window' }, { name: 'drag' }],
      target: async () => options.resolved ?? { appId, app, pid: 7 },
      selectionWindow: async target => { censuses.push(target); return options.selection ?? { ok: true, target: { ...window('Source'), windowNumber: 11 }, pid: 7 }; },
      call: async (name, args, approve) => {
        if (name === 'drag') { drags.push(args); return { content: [] }; }
        if (name === 'select_window') {
          selections.push(args);
          if (options.decline || !await approve(['select_window', appId], 'Select?')) return { isError: true, content: [] };
          current = options.wrongRead ? window('Target') : window('Source');
          if (options.unfocusedSelection) focusOverride = 1;
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, target: options.selectionTarget ?? window('Source'), identity: { pid: 7, windowNumber: options.noNumber ? null : options.wrongNumber ? 12 : 11 } }) }] };
        }
        current = window(args.path.includes('Source') ? 'Source' : 'Target');
        return { content: [], _meta: { 'sleight/openedApp': appId,
          'sleight/openedFile': { path: args.path, real: args.path, size: 30 } } };
      } } });
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); });
  clientOut.on('data', bytes => received.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  serverIn.on('data', async bytes => {
    for (const msg of bytes.toString().trim().split('\n').map(JSON.parse)) {
      sent.push(msg);
      if (msg.method !== 'tools/call') continue;
      options.onEngineCall?.(msg);
      if (msg.params.name === 'turn_ended') {
        serverOut.write(JSON.stringify({ id: msg.id, result: { content: [] } }) + '\n'); continue;
      }
      if (options.strictProtocol && msg.jsonrpc !== '2.0') {
        invalidRequests.push(msg);
        queueMicrotask(() => relay.engineEnded('Engine exited (0).'));
        continue;
      }
      if (options.holdOpenedRead && String(msg.id).startsWith('sleight-opened-window-')) continue;
      output = [];
      let isError;
      if (options.execute) {
        try { await vm.runInContext(`(async () => { ${msg.params.arguments.code} })()`, engine,
          { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }); }
        catch (error) { isError = true; output.push(error.message); }
        const proxy = engine.__sleightDocumentGuard?.wrap(raw) ?? raw;
        engine.app = proxy;
        for (const [handle] of msg.params.arguments.code.matchAll(/\b__sleightOpenedApp\d+\b/g)) engine[handle] = proxy;
      } else output.push(snapshot());
      serverOut.write(JSON.stringify({ id: msg.id, result: { ...(isError ? { isError } : {}), content: [{ type: 'text', text: output.join('\n') }],
      _meta: { 'codex/toolSurface': { app: { appId: options.engineAppId ?? appId } } } } }) + '\n');
    }
  });
  const call = async (id, name, args) => {
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    // A full-suite load can stretch the fake engine round trip past 50 ticks (2026-10-20 full check); wait up to 5 s.
    for (const end = Date.now() + 5000; Date.now() < end && !received.some(msg => msg.id === id);) await tick();
    const reply = received.find(msg => msg.id === id);
    assert.ok(reply, `no reply for ${id}`);
    return reply.result;
  };
  const open = async name => {
    const result = await call(name, 'open_file', { app, path: `${root}/${name}.txt` });
    return /Window handle: `([^`]+)`/.exec(result.content.map(c => c.text ?? '').join('\n'))[1];
  };
  return { call, open, sent, selections, leases, drags, censuses, relay, received, invalidRequests, actions, setCurrent: name => { current = window(name); }, send: (id, name, args) => clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n'), released, active, observations, resetIdentity, focusDuplicate: () => { Object.assign(windows[1], { AXTitle: 'Source.txt', AXDocument: window('Source').url }); focusOverride = 1; }, breakIdentity: () => { broken = true; } };
}

// Refused call shapes from wordmemo-study.md, B 09-50 runs 1 and 2.
// Execute the generated guards as well as checking that each request is forwarded.
for (const root of ['0 Table, Secondary Actions: Cancel\n\t1 menu Secondary Actions: Cancel',
  '0 dialog\n\t1 button Cancel', '0 sheet\n\t1 button Cancel']) {
  test(`OH4 opened-only word-memo refusals execute on a URL-less child: ${root.split('\n')[0]}`, async t => {
    let child = false;
    const directory = mkdtempSync('/tmp/oh4-runtime-leases-');
    const inputLease = new InputLease({ directory, holder: 'OH4' });
    t.after(() => { inputLease.close(); rmSync(directory, { recursive: true, force: true }); });
    const h = fixture(t, { execute: true, inputLease,
      tree: current => child ? childTree({ ...current, url: undefined }, root) + '\n\t5 button Table\n\t47 button Table...' : undefined });
    const source = await h.open('Source');
    assert.ok(!(await h.call('menu', 'js', { code: `let app = ${source}; await app.click(1);` })).isError);
    child = true;
    const calls = [
      ['run1-178', `await ${source}.getAXState();`],
      ['run1-198', 'let app = await cua.getApp("TextEdit");'],
      ['run1-205', `let app = ${source}; await app.click(19);`],
      ['run1-237', 'await app.click(47);'],
      ['run1-258', 'await app.performSecondaryAction(1, "Cancel"); "closed";'],
      ['run1-292', 'await app.performSecondaryAction(1, "Cancel"); let s = await app.getAXState(); s;'],
      ['run1-308', `await ${source}.getAXState();`],
      ['run2-85', `await ${source}.click(5);`],
      ['run2-99', 'await app.click(5);'],
      ['run2-106', 'await app.performSecondaryAction(1, "Cancel"); nodeRepl.write("cancelled");'],
      ['run2-112', 'await app.pressKey("Escape"); nodeRepl.write("closed");'],
      ['run2-121', 'await app.performSecondaryAction(0, "Cancel"); nodeRepl.write("cancelled");'],
      ['run2-128', 'await app.pressKey("Escape"); nodeRepl.write("cancelled");'],
      ['run2-146', `let app = await cua.getApp("TextEdit"); await app.getAXState(); nodeRepl.write("read");`],
    ];
    for (const [id, code] of calls) {
      const before = h.actions.length;
      const result = await h.call(id, 'js', { code });
      assert.ok(!result.isError, `${id}: ${JSON.stringify(result)}`);
      assert.ok(h.sent.some(msg => msg.id === id), `${id} reaches the engine`);
      if (/\.(click|pressKey|performSecondaryAction)\(/.test(code)) assert.equal(h.actions.length, before + 1, id);
    }
    assert.equal(h.selections.length, 0, 'opened-only calls never invoke select_window');
  });
}

async function selectSource(h) {
  assert.ok(!(await h.call('explicit-source', 'select_window', { app: appId, url: window('Source').url })).isError);
  assert.ok(!(await h.call('confirm-source', 'js', { code: 'let app = await cua.getApp("TextEdit");' })).isError);
}

for (const code of ['await app.click(47);', 'await app.click(5);',
  'await app.performSecondaryAction(1, "Cancel"); "closed";',
  'await app.performSecondaryAction(1, "Cancel"); let s = await app.getAXState(); s;',
  'await app.performSecondaryAction(1, "Cancel"); nodeRepl.write("cancelled");',
  'await app.pressKey("Escape"); nodeRepl.write("closed");',
  'await app.performSecondaryAction(0, "Cancel"); nodeRepl.write("cancelled");']) {
  test(`OH4 explicit selection retains the study call refusal: ${code}`, async t => {
    let child = false;
    const h = fixture(t, { tree: current => child ? childTree({ ...current, url: undefined }) +
      '\n\t5 button Table\n\t47 button Table...' : undefined });
    await h.open('Source');
    await selectSource(h);
    child = true;
    assert.ok(!(await h.call('child', 'js', { code: 'let app = await cua.getApp("TextEdit");' })).isError);
    const result = await h.call('refused', 'js', { code });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.match(JSON.stringify(result), /selected window is not confirmed/);
    assert.equal(h.sent.some(msg => msg.id === 'refused'), false);
  });
}

// B transcript lines 120-184: opened alias, URL-less Edit menu, fresh getApp,
// advertised Cancel and Escape. Other input needs the document URL again.
const childTree = (window, root = '0 Edit, Secondary Actions: Cancel, Pick\n\t1 menu Secondary Actions: Cancel') =>
  `Window: "${window.title}", App: ${window.app}.\n${window.url ? `URL: ${window.url}\n` : ''}${root}\n\t\t19 Replace..., ID: replace:`;

test('OH1 B actions execute through the generated runtime guards, including both menu dismissals', async t => {
  let child = false;
  const directory = mkdtempSync('/tmp/oh1-runtime-leases-');
  const inputLease = new InputLease({ directory, holder: 'OH1' });
  t.after(() => { inputLease.close(); rmSync(directory, { recursive: true, force: true }); });
  const h = fixture(t, { execute: true, inputLease,
    action: (name, args) => { if (name === 'click') child = true; else if (name === 'pressKey' || name === 'performSecondaryAction') child = false; },
    tree: current => child ? childTree({ ...current, url: undefined }) : undefined });
  const source = await h.open('Source');
  await selectSource(h);
  for (const [id, code] of [
    ['menu', `let app = ${source}; await app.click(1);`],
    ['replace', `let app = ${source}; await app.click(19);`],
    ['fresh', 'let app = await cua.getApp("TextEdit");'],
    ['cancel', 'let app = await cua.getApp("TextEdit"); await app.performSecondaryAction(1, "Cancel");'],
    ['menu-again', `let app = ${source}; await app.click(1);`],
    ['escape', 'let app = await cua.getApp("TextEdit"); await app.pressKey("Escape");'],
    ['reacquire', 'let app = await cua.getApp("TextEdit");'],
    ['continued', 'await app.typeText("continued");'],
  ]) {
    const result = await h.call(id, 'js', { code });
    if (id === 'replace') assert.equal(result.isError, true, JSON.stringify(result));
    else assert.ok(!result.isError, `${id}: ${JSON.stringify(result)}`);
  }
  assert.deepEqual(h.actions, [['click', 1], ['performSecondaryAction', 1, 'Cancel'],
    ['click', 1], ['pressKey', 'Escape'], ['typeText', 'continued']]);
});

for (const root of ['0 Edit, Secondary Actions: Cancel, Pick\n\t1 menu Secondary Actions: Cancel',
  '0 menu Secondary Actions: Cancel', '0 sheet\n\t1 button Cancel', '0 dialog\n\t1 button Cancel']) {
  test(`OH1 B sequence keeps the selected document through a URL-less child: ${root.split('\n')[0]}`, async t => {
    let child = false;
    const options = { onEngineCall: msg => { if (msg.id === 'menu') child = true; if (msg.id === 'reacquire') child = false; },
      tree: current => child ? childTree({ ...current, url: undefined }, root) : undefined };
    const h = fixture(t, options), source = await h.open('Source');
    await selectSource(h);
    const cancel = root.includes('menu') ? `await app.performSecondaryAction(${root.startsWith('0 menu') ? 0 : 1}, "Cancel");`
      : 'await app.click(1);';
    for (const [id, code] of [
      ['menu', `let app = ${source}; await app.click(1);`],
      ['replace', `let app = ${source}; await app.click(19);`],
      ['fresh', 'let app = await cua.getApp("TextEdit");'],
      ['cancel', cancel],
      ['acquire-cancel', `let app = await cua.getApp("TextEdit"); ${cancel}`],
      ['escape', 'let app = await cua.getApp("TextEdit"); await app.pressKey("Escape");'],
      ['reacquire', 'let app = await cua.getApp("TextEdit");'],
      ['continued', 'await app.typeText("continued");'],
    ]) {
      const result = await h.call(id, 'js', { code });
      if (id === 'replace') {
        assert.equal(result.isError, true, JSON.stringify(result));
        assert.equal(h.sent.some(msg => msg.id === id), false, 'ordinary input must stop before the engine');
        continue;
      }
      assert.ok(!result.isError, `${id}: ${JSON.stringify(result)}`);
      assert.ok(h.sent.some(msg => msg.id === id), `${id} must reach the engine`);
      if (id === 'reacquire') assert.doesNotMatch(JSON.stringify(result), /selected window not observed/);
    }
    assert.equal(h.selections.length, 1, 'a child must not trigger another window selection');
    assert.ok(h.observations.some(o => o.url === window('Source').url && o.nativeIdentity?.pid === 7));
  });
}

test('OH1 fresh acquisition verifies a URL-less menu after explicit selection', async t => {
  let child = false;
  const h = fixture(t, { tree: current => child ? childTree({ ...current, url: undefined }) : undefined });
  const source = await h.open('Source');
  await selectSource(h);
  await h.call('first', 'js', { code: `await ${source}.click(1);` });
  await h.call('select', 'select_window', { app: appId, url: window('Source').url });
  child = true;
  const result = await h.call('recovered', 'js', { code: 'let app = await cua.getApp("TextEdit"); await app.performSecondaryAction(1, "Cancel");' });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(h.sent.some(msg => msg.id === 'recovered'));
});

for (const root of ['0 menu Secondary Actions: Cancel', '0 sheet\n\t1 button Cancel', '0 dialog\n\t1 button Cancel']) {
  for (const bound of [false, true]) test(`OH3 another same-title window cannot inherit selection (${root.split('\n')[0]}, handle: ${bound})`, async t => {
    let child = false, binding = false;
    const h = fixture(t, { tree: current => child ? childTree({ ...current, url: undefined }, root) : binding
      ? childTree({ ...current, url: 'file:///tmp/other/Source.txt' }, '0 standard window Source.txt') : undefined });
    await h.open('Source');
    if (bound) {
      binding = true;
      await h.call('bind', 'js', { code: 'let other = await cua.getApp({ windowId: 12 });' });
      binding = false;
    }
    await h.call('select', 'select_window', { app: appId, url: window('Source').url });
    child = true;
    const read = await h.call('wrong-read', 'js', { code: bound ? 'await other.getAXState();' : 'let other = await cua.getApp({ windowId: 12 });' });
    assert.equal(read.isError, true, JSON.stringify(read));
    const result = await h.call('dismiss', 'js', { code: 'await other.pressKey("Escape");' });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(h.sent.some(msg => msg.id === 'dismiss'), false);
  });
}

for (const bound of [false, true]) test(`OH3 the selected numbered window retains dismissal (handle: ${bound})`, async t => {
  let child = false;
  const h = fixture(t, { tree: current => child ? childTree({ ...current, url: undefined }) : undefined });
  await h.open('Source');
  if (bound) await h.call('bind', 'js', { code: 'let app = await cua.getApp({ windowId: 11 });' });
  await h.call('select', 'select_window', { app: appId, url: window('Source').url });
  child = true;
  const read = await h.call('read', 'js', { code: bound ? 'await app.getAXState();' : 'let app = await cua.getApp({ windowId: 11 });' });
  assert.ok(!read.isError, JSON.stringify(read));
  const result = await h.call('dismiss', 'js', { code: 'await app.performSecondaryAction(1, "Cancel");' });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(h.sent.some(msg => msg.id === 'dismiss'));
});

test('OH3 dismissal cannot use another numbered handle while the selected child is leased', async t => {
  let child = false;
  const h = fixture(t, { tree: current => child ? childTree({ ...current, url: undefined }) : undefined });
  await h.open('Source');
  await h.call('bind', 'js', { code: 'let other = await cua.getApp({ windowId: 12 });' });
  await h.call('select', 'select_window', { app: appId, url: window('Source').url });
  child = true;
  await h.call('child', 'js', { code: 'let app = await cua.getApp("TextEdit");' });
  const result = await h.call('dismiss', 'js', { code: 'await other.pressKey("Escape");' });
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(h.sent.some(msg => msg.id === 'dismiss'), false);
});

test('OH3 a wrong meta appId cannot certify a selected child', async t => {
  let child = false;
  const options = { tree: current => child ? childTree({ ...current, url: undefined }) : undefined };
  const h = fixture(t, options);
  await h.open('Source');
  await h.call('select', 'select_window', { app: appId, url: window('Source').url });
  options.engineAppId = 'org.example.Other'; child = true;
  await h.call('wrong-read', 'js', { code: 'let other = await cua.getApp("TextEdit");' });
  const result = await h.call('dismiss', 'js', { code: 'await other.pressKey("Escape");' });
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(h.sent.some(msg => msg.id === 'dismiss'), false);
});

for (const missing of ['URL', 'window number']) test(`OH3 a selection without ${missing} cannot inherit a child`, async t => {
  let child = false;
  const h = fixture(t, { noNumber: missing === 'window number', document: missing === 'URL' ? { url: undefined } : {},
    tree: current => child ? childTree({ ...current, url: undefined }) : undefined });
  await h.open('Source');
  await h.call('select', 'select_window', { app: appId, title: 'Source.txt' });
  child = true;
  const observations = h.observations.length;
  await h.call('read', 'js', { code: 'let app = await cua.getApp("TextEdit");' });
  assert.equal(h.observations.length, observations, 'no native child exception may run without the complete selection');
  const result = await h.call('dismiss', 'js', { code: 'await app.performSecondaryAction(1, "Cancel");' });
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(h.sent.some(msg => msg.id === 'dismiss'), false);
});

test('OH3 selection seeds its native identity before the first child observation', async t => {
  let child = false;
  const options = { tree: current => child ? childTree({ ...current, url: undefined }) : undefined };
  const h = fixture(t, options);
  await h.open('Source');
  assert.ok(!(await h.call('select', 'select_window', { app: appId, url: window('Source').url })).isError);
  assert.ok(h.observations.some(o => o.windowNumber === 11), 'selection must sample its native window');
  options.nativeMutation = { processStart: 2 }; child = true;
  const result = await h.call('read', 'js', { code: 'let app = await cua.getApp("TextEdit");' });
  assert.equal(result.isError, true, JSON.stringify(result));
});

test('OH3 a stopped child identity check still settles its client reply once', async t => {
  let child = false, entered, release;
  const waiting = new Promise(resolve => { entered = resolve; });
  const options = { stopEngine: async () => ({ collected: false, cutOff: false }),
    tree: current => child ? childTree({ ...current, url: undefined }) : undefined };
  const h = fixture(t, options);
  await h.open('Source');
  await h.call('select', 'select_window', { app: appId, url: window('Source').url });
  options.beforeIdentity = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  child = true;
  h.send('read', 'js', { code: 'let app = await cua.getApp("TextEdit");' });
  await waiting;
  h.send('stop', 'turn_ended', { sleight_stop: true });
  release();
  for (let i = 0; i < 100 && !h.received.some(msg => msg.id === 'stop'); i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(h.received.filter(msg => msg.id === 'read').length, 1);
  assert.equal(h.received.find(msg => msg.id === 'read').result.isError, true);
  assert.match(JSON.stringify(h.received.find(msg => msg.id === 'read')), /stopped/);
  assert.ok(h.received.some(msg => msg.id === 'stop'));
});

test('OH3 a menu closing onto another same-title document loses its selected parent', async t => {
  let child = false, other = false;
  const h = fixture(t, { tree: current => child ? childTree({ ...current, url: undefined }) :
    other ? childTree({ ...current, url: 'file:///tmp/other/Source.txt' }, '0 standard window Source.txt') : undefined });
  const source = await h.open('Source');
  await selectSource(h);
  await h.call('menu', 'js', { code: `let app = ${source}; await app.click(1);` }); child = true;
  await h.call('child', 'js', { code: 'let app = await cua.getApp("TextEdit");' });
  child = false; other = true;
  await h.call('closed', 'js', { code: 'await app.getAXState();' });
  const result = await h.call('dismiss', 'js', { code: 'await app.pressKey("Escape");' });
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(h.sent.some(msg => msg.id === 'dismiss'), false);
});

test('OH3 a lease parent cannot retain the selected-child shortcut', async t => {
  let phase;
  const h = fixture(t, { tree: current => phase === 'standard' ? childTree({ ...current, url: undefined }, '0 standard window Source.txt') :
    phase === 'menu' ? childTree({ ...current, url: undefined }) :
    phase === 'dialog' ? childTree({ ...current, title: 'Panel', url: undefined }, '0 sheet\n\t1 button Cancel') : undefined });
  const source = await h.open('Source');
  await selectSource(h);
  phase = 'standard';
  await h.call('standard', 'js', { code: 'let app = await cua.getApp("TextEdit");' });
  await h.call('select', 'select_window', { app: appId, url: window('Source').url });
  phase = 'menu';
  await h.call('menu', 'js', { code: 'let app = await cua.getApp("TextEdit");' });
  phase = 'dialog';
  await h.call('dialog', 'js', { code: 'await app.getAXState();' });
  phase = undefined;
  const selections = h.selections.length;
  const result = await h.call('source', 'js', { code: `await ${source}.pressKey("Escape");` });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(h.selections.length, selections + 1, 'explicit selection retains opened-handle recovery');
});

test('OH3 a selected child sheet cannot bypass the runtime payment guard', async t => {
  let child = false, confirmed = false;
  const directory = mkdtempSync('/tmp/oh3-runtime-leases-');
  const inputLease = new InputLease({ directory, holder: 'OH3' });
  t.after(() => { inputLease.close(); rmSync(directory, { recursive: true, force: true }); });
  const h = fixture(t, { execute: true, inputLease, confirmPayments: 'always',
    tree: current => child ? childTree({ ...current, url: confirmed ? current.url : undefined },
      '0 sheet Confirm payment\n\t1 button Cancel\n\t2 text Total $268.00\n\t3 button Pay now') : undefined });
  await h.open('Source');
  await h.call('select', 'select_window', { app: appId, url: window('Source').url });
  child = true;
  await h.call('child', 'js', { code: 'let app = await cua.getApp("TextEdit");' });
  const refused = await h.call('unconfirmed-payment', 'js', { code: 'await app.click(3);' });
  assert.equal(refused.isError, true, JSON.stringify(refused));
  assert.equal(h.sent.some(msg => msg.id === 'unconfirmed-payment'), false);
  // Once the sheet exposes its document URL, selection admits input and the payment gate still applies.
  confirmed = true;
  await h.call('confirm', 'js', { code: 'let app = await cua.getApp("TextEdit");' });
  const result = await h.call('payment', 'js', { code: 'await app.click(3);' });
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.match(JSON.stringify(result), /sleight stopped this payment/);
  assert.deepEqual(h.actions, [], 'neither unconfirmed selection nor payment refusal sends input');
});

test('OH3 a consent-host sheet cannot inherit a selected document or receive input', async t => {
  let child = false;
  const options = { tree: current => child ? childTree({ ...current, url: undefined },
    '0 sheet Allow debugger\n\t1 button Always allow\n\t2 button Cancel') : undefined };
  const h = fixture(t, options);
  await h.open('Source');
  await h.call('select', 'select_window', { app: appId, url: window('Source').url });
  options.engineAppId = 'consent-host'; child = true;
  const read = await h.call('child', 'js', { code: 'let app = await cua.getApp("TextEdit");' });
  assert.equal(read.isError, true, JSON.stringify(read));
  assert.match(JSON.stringify(read), /only you can answer/);
  const result = await h.call('allow', 'js', { code: 'await app.click(1);' });
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(h.sent.some(msg => msg.id === 'allow'), false);
});

test('OH3 a real focused duplicate cannot inherit the selected child', async t => {
  let child = false;
  const h = fixture(t, { tree: current => child ? childTree({ ...current, url: undefined }) : undefined });
  await h.open('Source');
  await h.call('select', 'select_window', { app: appId, url: window('Source').url });
  h.focusDuplicate(); child = true;
  const result = await h.call('read', 'js', { code: 'let app = await cua.getApp("TextEdit");' });
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.match(JSON.stringify(result), /focused|identity|window/i);
});

for (const root of ['0 standard window Source.txt', '0 sheet']) test(`OH3 advertised Cancel outside its child root refuses (${root})`, async t => {
  let child = false;
  const h = fixture(t, { tree: current => child ? childTree({ ...current, url: undefined },
    `${root}\n\t1 menu Secondary Actions: Cancel\n9 text Secondary Actions: Cancel`) : undefined });
  const source = await h.open('Source');
  await selectSource(h);
  await h.call('menu', 'js', { code: `let app = ${source}; await app.click(1);` }); child = true;
  await h.call('read', 'js', { code: 'let app = await cua.getApp("TextEdit");' });
  const result = await h.call('forged', 'js', { code: 'await app.performSecondaryAction(9, "Cancel");' });
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(h.sent.some(msg => msg.id === 'forged'), false);
});

test('OH1 menu dismissal still requires the window lease', async t => {
  let child = false;
  const options = { onEngineCall: msg => { if (msg.id === 'menu') child = true; },
    tree: current => child ? childTree({ ...current, url: undefined }) : undefined };
  const h = fixture(t, options), source = await h.open('Source');
  await selectSource(h);
  await h.call('menu', 'js', { code: `let app = ${source}; await app.click(1);` });
  options.busyWindow = true;
  const result = await h.call('cancel', 'js', { code: 'await app.performSecondaryAction(1, "Cancel");' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /window action refused/);
  assert.equal(h.sent.some(msg => msg.id === 'cancel'), false);
});

for (const [label, change] of [
  ['different URL', { url: 'file:///tmp/Other.txt' }],
  ['different title', { title: 'Other.txt', url: undefined }],
  ['other app', { app: 'Other', url: undefined }],
  ['standard document without URL', { url: undefined, root: '0 standard window' }],
]) test(`OH1 a ${label} never inherits the selected document`, async t => {
  let child = false;
  const options = { onEngineCall: msg => { if (msg.id === 'menu') child = true; },
    tree: current => child ? childTree({ ...current, ...change }, change.root) : undefined };
  const h = fixture(t, options), source = await h.open('Source');
  await selectSource(h);
  await h.call('menu', 'js', { code: `let app = ${source}; await app.click(1);` });
  await h.call('select-changed', 'select_window', { app: appId, url: window('Source').url });
  await h.call('read-changed', 'js', { code: 'let app = await cua.getApp("TextEdit");' });
  options.decline = true;
  const result = await h.call('wrong', 'js', { code: `await ${source}.typeText("must not run");` });
  assert.equal(result.isError, true);
  assert.equal(h.sent.some(msg => msg.id === 'wrong'), false);
});

for (const nativeMutation of [{ pid: 99 }, { processStart: 99 }, { epoch: 'different-helper' }, { windowNumber: 99 }, { window: 99 },
  { status: 'unknown' }, { matches: 2 }, { url: 'file:///tmp/Other.txt' }, { appId: 'org.example.Other' }]) {
  test(`OH1 a URL-less menu cannot hide changed native identity: ${JSON.stringify(nativeMutation)}`, async t => {
    let child = false;
    const options = { onEngineCall: msg => { if (msg.id === 'menu') child = true; },
      tree: current => child ? childTree({ ...current, url: undefined }) : undefined };
    const h = fixture(t, options), source = await h.open('Source');
    await selectSource(h);
    await h.call('menu', 'js', { code: `let app = ${source}; await app.click(1);` });
    assert.ok(!(await h.call('same-app', 'js', { code: 'let app = await cua.getApp("TextEdit");' })).isError);
    options.nativeMutation = nativeMutation;
    for (const [id, code] of [['cancel', 'await app.performSecondaryAction(1, "Cancel");'],
      ['escape', 'await app.pressKey("Escape");']]) {
      const result = await h.call(id, 'js', { code });
      assert.equal(result.isError, true);
      assert.equal(h.sent.some(msg => msg.id === id), false);
    }
    const fresh = await h.call('fresh', 'js', { code: 'let app = await cua.getApp("TextEdit");' });
    assert.equal(fresh.isError, true, 'a fresh read must not certify a different process or document');
  });
}

test('explicit selection: the app reservation survives prepareLease through the internal read and final handle action', async t => {
  const directory = mkdtempSync('/tmp/wd6c-leases-');
  const inputLease = new InputLease({ directory, holder: 'WD6c' });
  t.after(() => { inputLease.close(); rmSync(directory, { recursive: true, force: true }); });
  const h = fixture(t, { inputLease, onEngineCall: msg => {
    if (msg.id !== 'action' && !String(msg.id).startsWith('sleight-opened-window-')) return;
    assert.equal(inputLease.inspect(leaseKey(window('Source'), 'app'))?.active, true);
  } });
  const source = await h.open('Source'); await h.open('Target');
  await h.call('explicit', 'select_window', { app: appId, url: window('Source').url });
  const result = await h.call('action', 'js', { code: `await ${source}.selectText(2, "move-62f9a451")` });
  assert.ok(!result.isError);
  assert.equal(inputLease.owned.has(leaseKey(window('Source'), 'app')), false);
});

for (const reset of [false, true]) test(`explicit selection: engine exit during an internal opened-window read recovers${reset ? ' through js_reset' : ''}`, async t => {
  const options = { holdOpenedRead: true };
  const h = fixture(t, options), source = await h.open('Source');
  await h.open('Target');
  await h.call('explicit', 'select_window', { app: appId, url: window('Source').url });
  h.send('interrupted', 'js', { code: `await ${source}.selectText(2, "move-62f9a451")` });
  for (let i = 0; i < 50 && !h.sent.some(msg => String(msg.id).startsWith('sleight-opened-window-')); i++) await tick();
  assert.ok(h.sent.some(msg => String(msg.id).startsWith('sleight-opened-window-')));
  assert.equal(h.active.has('app:Source.txt'), true);
  h.relay.engineEnded('Engine exited (0).');
  await tick();
  assert.equal(h.received.filter(msg => msg.id === 'interrupted').length, 1);
  assert.match(h.received.find(msg => msg.id === 'interrupted').result.content[0].text, /Engine exited/);
  assert.equal(h.active.size, 0, 'a dead engine retains no lease or heartbeat');
  if (reset) assert.ok(!(await h.call('reset', 'js_reset', {})).isError);
  const unsafe = await h.call('unsafe', 'js', { code: `await ${source}.typeText("never replay")` });
  assert.equal(unsafe.isError, true, 'a new app read is required after engine death');
  assert.equal(h.sent.some(msg => msg.id === 'unsafe'), false);
  assert.ok(!(await h.call('state', 'js', { code: 'await cua.getState()' })).isError);
  assert.ok(!(await h.call('fresh', 'js', { code: 'let fresh = await cua.getApp("TextEdit")' })).isError);
  assert.ok(!(await h.call('action', 'js', { code: 'await fresh.typeText("recovered")' })).isError);
  assert.ok(!(await h.call('select', 'select_window', { app: appId, url: window('Source').url })).isError);
});

test('WD6 an opened handle acting on Target cannot supply Source as the drag default', async t => {
  const h = fixture(t), source = await h.open('Source');
  await h.open('Target');
  const action = await h.call('source', 'js', { code: `await ${source}.selectText(2, "move-62f9a451");` });
  assert.ok(!action.isError, JSON.stringify(action));
  assert.equal(h.selections.length, 0);
  assert.ok(!(await h.call('drag', 'drag', { app, from: [10, 20], to: [20, 98] })).isError);
  assert.equal(h.drags[0].windowId, undefined);
  assert.equal(h.drags[0].toWindowId, undefined);
  assert.equal(h.observations.length, 0);
});

for (const options of [{ decline: true }, { wrongRead: true }, { wrongNumber: true }, { unfocusedSelection: true },
  { nativeMutation: { status: 'unknown' } }, { nativeMutation: { matches: 0 } }]) {
  test(`OH4 opened hints add no selection admission: ${JSON.stringify(options)}`, async t => {
    const h = fixture(t, options), source = await h.open('Source');
    await h.open('Target');
    const result = await h.call('action', 'js', { code: `await ${source}.selectText(2, "move-62f9a451");` });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.ok(h.sent.some(msg => msg.id === 'action'));
    assert.equal(h.selections.length, 0);
    assert.equal(h.observations.length, 0);
  });
}

for (const aliasOnly of [false, true]) test(`WD6 opened alias cannot override the later Target lease (${aliasOnly})`, async t => {
  const h = fixture(t), source = await h.open('Source');
  await h.call('alias', 'js', { code: `let doc = ${source};${aliasOnly ? '' : ' await doc.selectText(1, "sample");'}` });
  await h.open('Target');
  const result = await h.call('act', 'js', { code: 'await doc.typeText("text");' });
  assert.ok(!result.isError, JSON.stringify(result));
  await h.call('drag', 'drag', { app, from: [10, 20], to: [30, 40] });
  assert.equal(h.drags[0].windowId, undefined);
  assert.equal(h.selections.length, 0);
});

for (const unavailable of [false, true]) test(`OH4 unconfirmed drag hint falls through to ordinary drag handling (${unavailable})`, async t => {
  const h = fixture(t, { nativeMutation: unavailable ? { status: 'unknown' } : { matches: 2 } });
  await h.open('Source');
  const result = await h.call('drag', 'drag', { app, from: [10, 20], to: [30, 40] });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(h.drags[0].windowId, undefined);
});

test('WD3 call 13: the sole selected window supplies only the drag source windowId', async t => {
  const h = fixture(t);
  await h.open('Source'); await h.open('Target');
  const result = await h.call('drag', 'drag', { app, from: 'the current text selection', to: [20, 98] });
  assert.ok(!result.isError);
  assert.equal(h.drags[0].windowId, 11);
  assert.equal(h.drags[0].toWindowId, undefined);
});

test('an explicit drag source and destination stay unchanged', async t => {
  const h = fixture(t);
  await h.open('Source'); await h.open('Target');
  await h.call('drag', 'drag', { app, windowId: 12, toWindowId: 11, from: 'the current text selection', to: [100, 120] });
  assert.equal(h.drags[0].windowId, 12);
  assert.equal(h.drags[0].toWindowId, 11);
});

test('WD6 an explicit coordinate drag source overrides the opened hint', async t => {
  const h = fixture(t);
  await h.open('Source');
  await h.call('drag', 'drag', { app, windowId: 12, toWindowId: 11, from: [10, 20], to: [30, 40] });
  assert.equal(h.drags[0].windowId, 12);
  assert.equal(h.drags[0].toWindowId, 11);
  assert.equal(h.observations.length, 0);
});

test('OH4 reset clears the advisory opened drag hint', async t => {
  const h = fixture(t);
  await h.open('Source');
  await h.call('reset', 'js_reset', {});
  await h.call('drag', 'drag', { app, from: [10, 20], to: [30, 40] });
  assert.equal(h.drags[0].windowId, undefined);
  assert.equal(h.observations.length, 0);
});

for (const read of ['acquisition', 'opened handle']) test(`OH5 a later ${read} of Target clears the opened Source hint`, async t => {
  const h = fixture(t), source = await h.open('Source');
  h.setCurrent('Target');
  const code = read === 'acquisition' ? 'let fresh = await cua.getApp({ windowId: 12 });' : `await ${source}.getAXState();`;
  assert.ok(!(await h.call('target-read', 'js', { code })).isError);
  h.setCurrent('Source');
  assert.ok(!(await h.call('source-read', 'js', { code: 'let fresh = await cua.getApp("TextEdit");' })).isError);
  const before = h.observations.length;
  assert.ok(!(await h.call('drag', 'drag', { app, from: [10, 20], to: [30, 40] })).isError);
  assert.equal(h.drags[0].windowId, undefined, 'returning to Source must not restore the cleared hint');
  assert.equal(h.observations.length, before);
});

test('OH5 a read that moves the lease during native hint lookup prevents injection', async t => {
  const options = {};
  const h = fixture(t, options);
  await h.open('Source');
  let moved = false;
  options.beforeIdentity = async target => {
    if (!target.allowUnfocused || moved) return;
    moved = true; h.setCurrent('Target');
    assert.ok(!(await h.call('target-read', 'js', { code: 'let fresh = await cua.getApp({ windowId: 12 });' })).isError);
  };
  const result = await h.call('drag', 'drag', { app, from: [10, 20], to: [30, 40] });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(moved, true);
  assert.equal(h.drags[0].windowId, undefined);
});

for (const from of [[10, 20], 'the current text selection']) test(`OH5 an explicit destination never gains an inferred source: ${JSON.stringify(from)}`, async t => {
  const h = fixture(t);
  await h.open('Source');
  const before = h.observations.length;
  await h.call('drag', 'drag', { app, toWindowId: 12, from, to: [30, 40] });
  assert.equal(h.drags[0]?.windowId, undefined);
  assert.equal(h.drags[0]?.toWindowId, 12);
  assert.equal(h.observations.length, before);
  assert.equal(h.censuses.length, 0);
});

for (const numbered of [false, true]) for (const [from, to] of [
  [1, 2], [{ line: 'button Source, ID: source' }, 2], [1, [30, 40]],
  [[10, 20], 2], [[10, 20], { line: 'button Target, ID: target' }],
]) {
  test(`OH5 opened drag preserves observed element identities (${numbered}, ${JSON.stringify([from, to])})`, async t => {
    const h = fixture(t, { tree: current => `Window: "${current.title}", App: ${app}.\nURL: ${current.url}\n0 standard window ${current.title}\n\t1 button Source, ID: source\n\t2 button Target, ID: target` });
    await h.open('Source');
    if (numbered) await h.call('numbered', 'js', { code: 'let app = await cua.getApp({ windowId: 11 });' });
    const before = h.observations.length;
    const result = await h.call('drag', 'drag', { app, from, to });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.deepEqual(h.drags[0].from, Array.isArray(from) ? from : 1);
    assert.deepEqual(h.drags[0].to, Array.isArray(to) ? to : 2);
    // A numbered acquisition alone does not attach a certified number to the lease.
    assert.equal(h.drags[0].windowId, undefined);
    assert.equal(h.observations.length, before, 'unbound elements need no native hint lookup');
    if (!Array.isArray(from)) assert.equal(h.drags[0].elementLines[1], 'button Source, ID: source');
    if (!Array.isArray(to)) assert.equal(h.drags[0].elementLines[2], 'button Target, ID: target');
  });
}

for (const otherApp of [false, true]) test(`OH5 explicit selection refuses a different opened target (${otherApp})`, async t => {
  const options = {};
  const h = fixture(t, options), target = await h.open('Target');
  await h.open('Source');
  if (otherApp) {
    options.noNumber = true;
    options.resolved = { appId: 'org.test.Other', app: 'Other', pid: 8 };
    options.selectionTarget = { ...options.resolved, title: 'Other', url: 'file:///tmp/Other.txt' };
  }
  assert.ok(!(await h.call('explicit', 'select_window', { app: options.resolved?.appId ?? appId, url: window('Source').url })).isError);
  const before = h.observations.length, selections = h.selections.length;
  const result = await h.call('conflict', 'js', { code: `await ${target}.typeText("never");` });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /Call select_window/);
  assert.equal(h.selections.length, selections, 'no internal reselect');
  assert.equal(h.observations.length, before, 'refuse before native admission');
  assert.equal(h.sent.some(msg => msg.id === 'conflict'), false);
});

test('OH5 clearSelection removes selectedParent even when the next selection fails', async t => {
  let child = false, held;
  const options = { tree: current => child ? childTree({ ...current, url: undefined }) : undefined,
    beforeAcquire: (target, scope) => { if (scope === 'window') held = target; } };
  const h = fixture(t, options);
  await h.open('Source');
  await selectSource(h);
  child = true;
  assert.ok(!(await h.call('child', 'js', { code: 'let app = await cua.getApp("TextEdit");' })).isError);
  options.busyWindow = true;
  assert.equal((await h.call('blocked', 'js', { code: 'await app.pressKey("Escape");' })).isError, true);
  assert.equal(held.selectedParent.url, window('Source').url);
  options.decline = true;
  assert.equal((await h.call('failed-select', 'select_window', { app, url: window('Target').url })).isError, true);
  assert.equal(held.selectedParent, undefined);
});

test('OH5 an ordinary acquired handle cannot trigger the text-selection census', async t => {
  const h = fixture(t);
  h.setCurrent('Source');
  assert.ok(!(await h.call('acquire', 'js', { code: 'let app = await cua.getApp("TextEdit");' })).isError);
  await h.call('drag', 'drag', { app, from: 'the current text selection', to: [30, 40] });
  assert.equal(h.censuses.length, 0);
  assert.equal(h.drags[0].windowId, undefined);
});

test('OH5 textedit-window-drag keeps open_file then coordinate drag in that document', async t => {
  const h = fixture(t);
  await h.open('Source');
  const result = await h.call('drag', 'drag', { app, from: [10, 20], to: [30, 40] });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(h.drags[0].windowId, 11);
  assert.equal(h.drags[0].toWindowId, undefined);
  assert.equal(h.selections.length, 0);
  assert.ok(h.observations.some(target => target.url === window('Source').url && target.allowUnfocused));
});

for (const selection of [{ ok: false }, { ok: true, target: window('Source'), pid: 99 }]) test(`unproven selection retains drag ambiguity: ${JSON.stringify(selection)}`, async t => {
  const h = fixture(t, { selection });
  await h.open('Source');
  await h.call('drag', 'drag', { app, from: 'the current text selection', to: [100, 120] });
  assert.equal(h.drags[0]?.windowId, undefined);
});


test('opened bindings survive a helper epoch change after a fresh app read', async t => {
  const h = fixture(t), source = await h.open('Source');
  assert.ok(!(await h.call('first', 'js', { code: `await ${source}.typeText("text")` })).isError);
  h.resetIdentity();
  await h.call('fresh', 'js', { code: 'let fresh = await cua.getApp("TextEdit")' });
  const result = await h.call('second', 'js', { code: `await ${source}.typeText("text")` });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.ok(h.observations.filter(o => o.allowUnfocused).every(o => o.nativeIdentity === undefined));
});

for (const rebound of [
  'doc &&= other', 'doc ||= other', 'doc ??= other', 'doc += 1', 'doc++',
  'for (doc of items) {}', 'for (let doc of items) {}', 'for (doc in items) {}',
  '[doc] = items', '({ value: doc } = other)', 'let { value: doc } = other',
  '((doc) => doc)(other)', '(doc => doc)(other)', '(function(doc) { return doc; })(other)',
  'let doc = other',
]) test(`a mixed call forgets a non-trivial opened alias rebinding: ${rebound}`, async t => {
  const h = fixture(t), source = await h.open('Source');
  await h.call('alias', 'js', { code: `let doc = ${source};` });
  await h.call('mixed', 'js', { code: `${rebound}; await ${source}.typeText("text")` });
  await h.open('Target');
  const before = h.selections.length;
  await h.call('later', 'js', { code: 'await doc.typeText("text")' });
  assert.equal(h.selections.length, before, 'a forgotten alias must not select Source');
});

test('flow refusal happens before opened-window selection', async t => {
  const flowRules = new FlowRules({ version: 1, rules: [{ id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] }] });
  const h = fixture(t, { flowRules }), source = await h.open('Source');
  await h.open('Target');
  const result = await h.call('blocked', 'js', { code: `await ${source}.typeText("SECRET")` });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Flow rules:/);
  assert.equal(h.selections.length, 0);
});

test('an opened-window call cannot select while a flow decision is pending', async t => {
  let decide;
  const flowRules = new FlowRules({ version: 1, rules: [{ id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] }] });
  const h = fixture(t, { flowRules, ask: (_message, _scope, options) => options?.kind === 'flow'
    ? new Promise(resolve => { decide = resolve; }) : Promise.resolve('accept') });
  const source = await h.open('Source'), target = await h.open('Target');
  await h.call('blocked', 'js', { code: `await ${target}.typeText("SECRET")` });
  h.send('exception', 'flow_exception', {});
  await tick();
  assert.equal(typeof decide, 'function');
  const result = await h.call('while-asking', 'js', { code: `await ${source}.typeText("text")` });
  assert.equal(result.isError, true);
  assert.equal(h.selections.length, 0);
  decide('cancel'); await tick();
});

test('a flow exception permits one identical opened-window retry', async t => {
  const flowRules = new FlowRules({ version: 1, rules: [{ id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] }] });
  const h = fixture(t, { flowRules }), source = await h.open('Source');
  await h.open('Target');
  const code = `await ${source}.typeText("SECRET")`;
  assert.equal((await h.call('blocked', 'js', { code })).isError, true);
  assert.ok(!(await h.call('exception', 'flow_exception', {})).isError);
  const result = await h.call('permitted', 'js', { code });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(h.selections.length, 0);
});


test('drag inference uses the census number when a different window of the same file is focused', async t => {
  const h = fixture(t);
  await h.open('Source'); h.focusDuplicate();
  await h.call('drag', 'drag', { app, from: 'the current text selection', to: [20, 98] });
  assert.equal(h.drags[0].windowId, 11);
});

test('a selection census without a window number cannot infer the focused duplicate', async t => {
  const h = fixture(t, { selection: { ok: true, target: window('Source'), pid: 7 } });
  await h.open('Source'); h.focusDuplicate();
  await h.call('drag', 'drag', { app, from: 'the current text selection', to: [20, 98] });
  assert.equal(h.drags[0].windowId, undefined);
});

test('an opened-window call cannot select while saved changes await a review decision', async t => {
  const root = mkdtempSync('/tmp/lane-wd6b-review-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['Source', 'Target']) writeFileSync(`${root}/${name}.txt`, 'before');
  let decide;
  const h = fixture(t, { root, changeReview: true, ask: (_message, _scope, options) => options?.kind === 'review'
    ? new Promise(resolve => { decide = resolve; }) : Promise.resolve('accept') });
  const source = await h.open('Source');
  assert.ok(!(await h.call('edit', 'js', { code: `await ${source}.typeText("text")` })).isError);
  await h.open('Target');
  h.send('review', 'review_changes', { op: 'review' }); await tick();
  assert.equal(typeof decide, 'function');
  const result = await h.call('while-reviewing', 'js', { code: `await ${source}.typeText("text")` });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /reviewing changes/);
  assert.equal(h.selections.length, 0);
  decide('cancel'); await tick();
});


test('OH4 ordinary window lease refusal still stops an opened handle', async t => {
  const h = fixture(t, { busyWindow: true }), source = await h.open('Source');
  await h.open('Target');
  const result = await h.call('refusal', 'js', { code: `await ${source}.typeText("text")` });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /window action refused/);
  assert.equal(h.selections.length, 0);
  assert.equal(h.sent.some(msg => msg.id === 'refusal'), false);
});
