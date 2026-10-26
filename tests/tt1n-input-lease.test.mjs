import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext, constants } from 'node:vm';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { SELECT_WINDOW_TOOL } from '../plugins/sleight/lib/select-window.mjs';

const document = 'Window: "report.txt", App: Fixture Editor.\n0 standard window report.txt, URL: file:///tmp/report.txt\n\t1 menu bar\n\t\t2 File, ID: file-menu\n\t3 button Other';
const menu = 'Window: "report.txt", App: Fixture Editor.\n0 File, Secondary Actions: Cancel, Pick\n\t1 menu Secondary Actions: Cancel\n\t\t4 Save, ID: save-item';
const tick = () => new Promise(resolve => setTimeout(resolve, 1));

// TT1N's string-read VM fixture, now joined to the real relay. Native truth stays outside
// the engine realm: only the relay's injected read-only identity helper can observe it.
// errorFirst: the real engine's order, the exception as the first content item ahead of what the call wrote.
async function fixture(t, { initial, base = document, after = menu, nativeChange, identity, afterItem = after, actionOutput = false,
  retryFirst, beforeRetry, onAction, onRead, errorFirst = false, windows = [{ title: 'report.txt' }], engineMs, landingRead, ...options } = {}) {
  let text = base, writes = [];
  const clicks = [], keys = [], values = [], typed = [], sent = [], received = [];
  let identityChecks = 0;
  const native = { windowNumber: 22, hidIdleSeconds: 1000, status: 'ok' };
  // onAction(name, argument, text) returns the window an action leaves, for a scripted sequence.
  const raw = { getAXState: async () => { onRead?.(); return text; }, getAXStateAndScreenshot: async () => { onRead?.(); return { state: text }; }, click: async number => {
    clicks.push(number); text = onAction ? onAction('click', number, text) : clicks.length === 1 ? after : afterItem;
    if (actionOutput) writes.push('clicked:' + number);
    if (nativeChange === 'window') native.windowNumber = 23;
    if (nativeChange === 'focus') native.hidIdleSeconds = 0;
    if (nativeChange === 'unfocused') native.status = 'mismatch';
  }, pressKey: async key => {
    keys.push(key); text = onAction ? onAction('pressKey', key, text) : keys.length + clicks.length === 1 ? after : afterItem;
    if (nativeChange === 'window') native.windowNumber = 23;
    if (nativeChange === 'focus') native.hidIdleSeconds = 0;
    if (nativeChange === 'unfocused') native.status = 'mismatch';
  }, setValue: async (number, value) => { values.push([number, value]); if (onAction) text = onAction('setValue', number, text); },
  typeText: async value => { typed.push(value); if (onAction) text = onAction('typeText', value, text); } };
  const context = createContext({ setTimeout, cua: { getApp: async () => raw, listApps: async () => [
    { id: 'org.test.editor', windows }
  ] }, nodeRepl: { write: value => writes.push(String(value)) } });
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-tt1n-'))));
  const inputLease = new InputLease({ directory, holder: 'TT1N2 test' });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease, changeReview: false, ck3: false,
    // Recovery needs a running check; this app is always running.
    runningProbe: () => ({ status: 'responding' }),
    windowIdentity: async expected => { identityChecks++; return identity ? identity(expected, native, identityChecks) : ({ ...expected, ...native,
      matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1 }); }, ...options });
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); });
  clientOut.on('data', data => received.push(...data.toString().trim().split('\n').map(JSON.parse)));
  serverIn.on('data', data => sent.push(...data.toString().trim().split('\n').map(JSON.parse)));
  let next = 0, cursor = 0, retried = false;
  const call = async (code, name = 'js') => {
    const id = ++next;
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { code } } }) + '\n');
    for (let i = 0; i < (retryFirst ? 1500 : 100); i++) {
      await tick();
      while (cursor < sent.length) {
        const request = sent[cursor++]; writes = [];
        if (retryFirst && next > 1 && !retried) {
          retried = true; beforeRetry(native);
          serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { isError: true,
            content: [{ type: 'text', text: 'Sky Computer Use native pipe startup failed' }] } }) + '\n');
          continue;
        }
        let error;
        try { await runInContext(`(async () => { ${request.params.arguments.code} })()`, context,
          { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }); }
        catch (e) { error = e; }
        // Acquisitions print their header in the real engine even without an explicit read.
        if (/cua\.getApp\(/.test(request.params.arguments.code) && !error) writes.push(text);
        // The relay's own read after a tab continuation's Return (LB6) prints the window, as a bare read does in the engine.
        if (String(request.id).startsWith('sleight-tab-landing-') && !error) writes.push(landingRead ? landingRead() : text);
        if (error && !errorFirst) writes.push(String(error));
        serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { isError: !!error,
          content: [...(error && errorFirst ? [{ type: 'text', text: String(error?.message ?? error) }] : []), { type: 'text', text: writes.join('\n') }],
          _meta: { 'codex/toolSurface': { app: { appId: 'org.test.editor' } }, ...(engineMs ? { 'codex/nodeReplExecutionDurationMs': engineMs() } : {}) } } }) + '\n');
      }
      const reply = received.find(msg => msg.id === id);
      if (reply) return reply.result;
    }
    throw new Error('Fixture did not receive a client result');
  };
  await call('await cua.getApp("Fixture Editor");');
  // The setup read's process probe doesn't count.
  sent.length = received.length = 0; cursor = 0; text = initial ?? base; identityChecks = 0;
  return { clicks, keys, values, typed, native, sent, received, relay, call, send: msg => clientIn.write(JSON.stringify(msg) + '\n'), identityChecks: () => identityChecks, setText: value => { text = value; } };
}

const navigation = 'Window: "Parent", App: Fixture Editor.\n0 standard window Parent, URL: file:///tmp/Parent\n\t2 row Child, ID: child\n\t3 button Other';
const child = navigation.replaceAll('Parent', 'Child');
for (const action of ['pressKey("Super+Down")', 'pressKey("Super+Up")', 'pressKey("Return")',
  'click("Child")', 'click({ id: "child" })', 'click(2)', 'click([20, 40])']) {
  test(`TW2: own ${action} retitles the same window and continues once`, async t => {
    const h = await fixture(t, { base: navigation, after: child });
    const result = await h.call(`await app.${action}; await app.pressKey("Tab");`);
    assert.notEqual(result.isError, true);
    assert.equal(h.sent.length, 2);
    assert.equal(h.received.length, 1);
    assert.equal(h.identityChecks(), 3, 'shared admission baseline, post-stop, and immediately before forwarding');
    assert.equal(h.keys.at(-1), 'Tab');
    assert.doesNotMatch(JSON.stringify(result), /guard-stop|window or URL changed/);
  });
}

for (const [name, options] of [
  ['another window number', { nativeChange: 'window' }],
  ['user HID input', { nativeChange: 'focus' }],
  ['lost focus', { nativeChange: 'unfocused' }],
  ['sheet root', { after: child.replace('standard window', 'sheet') }],
  ['dialog root', { after: child.replace('standard window', 'dialog') }],
  ['nested sheet', { after: child + '\n\t4 sheet Confirm' }],
  ['another app', { after: child.replace('App: Fixture Editor.', 'App: Other Editor.') }],
  ['careful mode', { guardMode: 'careful' }],
  ['a document opened into the window', { after: child + '\n\t4 text area (settable) Value: draft' }],
  ['a page opened into the window', { after: child + '\n\t4 web area Child page' }],
  ['a page whose role is capitalized', { after: child + '\n\t4 HTML Content Child page' }],
]) test(`TW2: navigation stops on ${name}`, async t => {
  const h = await fixture(t, { base: navigation, after: child, ...options });
  const result = await h.call('await app.pressKey("Return"); await app.click("Other");');
  assert.equal(result.isError, true);
  assert.deepEqual(h.keys, ['Return']);
  assert.deepEqual(h.clicks, []);
  assert.equal(h.sent.length, 1);
});

test('TW2: a second navigation in the remainder stops the following action', async t => {
  const h = await fixture(t, { base: navigation, after: child, afterItem: navigation });
  const result = await h.call('await app.pressKey("Return"); await app.pressKey("Return"); await app.click("Other");');
  assert.equal(result.isError, true);
  assert.deepEqual(h.keys, ['Return', 'Return']);
  assert.deepEqual(h.clicks, []);
  assert.equal(h.sent.length, 2);
});

for (const shape of ['menu', 'navigation']) for (const failure of ['hid', 'window', 'focus', 'error', 'missing', 'timeout']) {
  test(`TW2: ${shape} returns its original stop when final evidence fails (${failure})`, async t => {
    const h = await fixture(t, { ...(shape === 'navigation' ? { base: navigation, after: child } : {}),
      menuContinuationTimeoutMs: 5, identity: async (expected, native, count) => {
        const observed = { ...expected, ...native, matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1 };
        if (count !== 3) return observed;
        if (failure === 'error') throw Error('final check unavailable');
        if (failure === 'missing') return {};
        if (failure === 'timeout') return new Promise(() => {});
        return { ...observed, ...(failure === 'hid' ? { hidIdleSeconds: 0 } :
          failure === 'window' ? { windowNumber: 23 } : { status: 'mismatch' }) };
      } });
    const result = await h.call(shape === 'navigation' ? 'await app.pressKey("Return"); await app.click("Other");' :
      'await app.click("File"); await app.click("Save");');
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /window or URL changed/);
    assert.doesNotMatch(JSON.stringify(result), /guard-stop/);
    assert.equal(h.sent.length, 1);
    assert.equal(h.identityChecks(), 3);
    assert.equal(h.received.length, 1);
    assert.deepEqual(h.clicks, shape === 'menu' ? [2] : []);
  });
}

test('TW2: final refusal releases a pending clipboard transaction and returns the original stop', async t => {
  let held = false;
  const h = await fixture(t, { clipboardMode: 'preserve', clipboardIO: async request => {
    if (request.op === 'acquire') { assert.equal(held, false); held = true; }
    if (request.op === 'release') held = false;
    if (request.op === 'read') return { count: 1, items: [] };
  }, identity: async (expected, native, count) => ({ ...expected, ...native, matches: 1,
    epoch: 'helper', window: 1, pid: 123, processStart: 1, ...(count === 3 ? { hidIdleSeconds: 0 } : {}) }) });
  const result = await h.call('await app.click("File"); await app.pressKey("Super+C");');
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /window or URL changed/);
  assert.equal(held, false);
  assert.deepEqual(h.clicks, [2]);
  assert.deepEqual(h.keys, []);
  assert.equal(h.sent.length, 1);
});

test('TW2: input during remainder clipboard preparation is caught by the final check', async t => {
  let h, acquisitions = 0, held = false;
  h = await fixture(t, { clipboardMode: 'preserve', clipboardIO: async request => {
    if (request.op === 'acquire') { acquisitions++; held = true; }
    if (request.op === 'release') held = false;
    if (request.op === 'read') {
      if (acquisitions === 2) h.native.hidIdleSeconds = 0;
      return { count: 1, items: [] };
    }
  } });
  const result = await h.call('await app.click("File"); await app.pressKey("Super+C");');
  assert.equal(result.isError, true);
  assert.equal(acquisitions, 2);
  assert.equal(h.identityChecks(), 3);
  assert.equal(held, false);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.keys, []);
});

test('TW2: a late final helper result cannot forward after the deadline', async t => {
  let finish;
  const h = await fixture(t, { menuContinuationTimeoutMs: 5, identity: async (expected, native, count) => {
    const observed = { ...expected, ...native, matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1 };
    return count === 3 ? new Promise(resolve => { finish = () => resolve(observed); }) : observed;
  } });
  const result = await h.call('await app.click("File"); await app.click("Save");');
  assert.equal(result.isError, true);
  finish(); await tick();
  assert.equal(h.received.length, 1);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.clicks, [2]);
});

test('TW2: disposal during final evidence collection never forwards the remainder', async t => {
  let h;
  h = await fixture(t, { identity: async (expected, native, count) => {
    if (count === 3) h.relay.dispose();
    return { ...expected, ...native, matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1 };
  } });
  const result = await h.call('await app.click("File"); await app.click("Save");');
  assert.equal(result.isError, true);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.clicks, [2]);
});

test('TW2: helper startup retry cannot reset the original call forwarding time', async t => {
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  const h = await fixture(t, { retryFirst: true, beforeRetry: native => {
    now = 2100; native.hidIdleSeconds = 0.15;
  } });
  const result = await h.call('await app.click("File"); await app.click("Save");');
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /window or URL changed/);
  assert.equal(h.sent.length, 2, 'only the original call and its startup retry');
  assert.deepEqual(h.clicks, [2]);
});

for (const [kind, first, second] of [['label', '{ label: "File" }', '{ label: "Save" }'],
  ['ID', '{ id: "file-menu" }', '{ id: "save-item" }']]) {
  test(`TT1N: own ${kind} click opens the matching menu before its item click`, async t => {
    const h = await fixture(t);
    const result = await h.call(`await app.click(${first}); await app.click(${second});`);
    assert.deepEqual(h.clicks, [2, 4]);
    assert.notEqual(result.isError, true);
    assert.equal(h.received.length, 1);
    assert.doesNotMatch(JSON.stringify(result), /sleight:guard-stop|window or URL changed/);
  });
}

const cases = [
  ['the same menu without a preceding click in this call', { initial: menu }, 'await app.click("Save");', []],
  ['a different native window number with the same menu text', { nativeChange: 'window' }],
  ['focus leaving and returning with the same menu text', { nativeChange: 'focus' }],
  ['a focused window change', { nativeChange: 'unfocused' }],
  ['a retitled ordinary window', { after: document.replaceAll('report.txt', 'other.txt') }],
  ['another app', { after: menu.replace('App: Fixture Editor.', 'App: Other Editor.') }],
  ['a numeric click', {}, 'await app.click(2); await app.click("Save");'],
  ['an ordinary button click', {}, 'await app.click("Other"); await app.click("Save");', [3]],
  ['a different menu title', { after: menu.replace('0 File,', '0 Edit,') }],
  ['a helper error', { identity: async () => { throw Error('helper unavailable'); } }],
  ['missing native fields', { identity: async () => ({ status: 'ok' }) }],
  ['a helper timeout', { identity: () => new Promise(() => {}), menuContinuationTimeoutMs: 5 }],
  ['code that does not split', {}, 'if (true) { await app.click("File"); await app.click("Save"); }'],
];
for (const [name, options, code = 'await app.click("File"); await app.click("Save");', clicks = [2]] of cases) {
  test(`TT1N: ${name} stops`, async t => {
    const h = await fixture(t, options);
    const result = await h.call(code);
    assert.equal(result.isError, true);
    assert.deepEqual(h.clicks, clicks);
    assert.doesNotMatch(JSON.stringify(result), /sleight:guard-stop:/);
  });
}

test('TT1N: a second header change in the rest stops before the following action', async t => {
  const h = await fixture(t, { afterItem: document });
  const result = await h.call('await app.click("File"); await app.click("Save"); await app.click("Other");');
  assert.equal(result.isError, true);
  assert.deepEqual(h.clicks, [2, 4]);
  assert.equal(h.sent.length, 2);
});

for (const failure of ['error', 'missing', 'timeout']) test(`TT1N: ${failure} from the fresh post-stop helper stops`, async t => {
  const h = await fixture(t, { menuContinuationTimeoutMs: 5, identity: async (expected, native, count) => {
    if (count === 2) {
      if (failure === 'error') throw Error('post-stop helper unavailable');
      if (failure === 'missing') return { status: 'ok' };
      return new Promise(() => {});
    }
    return { ...expected, ...native, matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1 };
  } });
  const result = await h.call('await app.click("File"); await app.click("Save");');
  assert.equal(result.isError, true);
  assert.equal(h.identityChecks(), 2);
  assert.deepEqual(h.clicks, [2]);
  assert.equal(h.sent.length, 1);
});

test('TT1N: a role-menu root also continues and preserves head output before tail output', async t => {
  const h = await fixture(t, { after: menu.replace('0 File, Secondary Actions: Cancel, Pick', '0 menu File'), actionOutput: true });
  const result = await h.call('await app.click("File"); await app.click("Save");');
  assert.deepEqual(h.clicks, [2, 4]);
  const output = result.content.map(c => c.text ?? '').join('\n');
  assert.ok(output.indexOf('clicked:2') < output.indexOf('clicked:4'));
  assert.doesNotMatch(output, /guard-stop|window or URL changed/);
  assert.notEqual(result.isError, true);
});

for (const mode of ['document', 'review']) test(`TT1N: ${mode} mode never probes or continues a stopped call`, async t => {
  const base = document.replace(', URL: file:///tmp/report.txt', '');
  const h = await fixture(t, { base, after: menu.replace('0 File,', '0 File, URL: file:///tmp/other.txt,'),
    ...(mode === 'document' ? { approvalScope: 'document', ask: async () => 'accept' } : { changeReview: true }) });
  if (mode === 'document') {
    await h.call(undefined, 'document_scope'); h.received.length = 0;
  }
  const result = await h.call('await app.click("File"); await app.click("Save");');
  assert.equal(result.isError, true);
  assert.deepEqual(h.clicks, [2]);
  assert.equal(h.sent.length, 1);
  assert.equal(h.identityChecks(), 0);
});

test('TT1N: flow rules still refuse the whole call before its opening click', async t => {
  const flowRules = new FlowRules({ version: 1, rules: [{ id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] }] });
  const h = await fixture(t, { flowRules });
  const result = await h.call('await app.click("File"); await app.click("Save"); await app.typeText("SECRET");');
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /secret/);
  assert.deepEqual(h.clicks, []);
  assert.equal(h.sent.length, 0);
});

test('TT1N: a late post-stop helper result cannot resume after its timeout', async t => {
  let finish;
  const h = await fixture(t, { menuContinuationTimeoutMs: 5, identity: async (expected, native, count) => {
    const observed = { ...expected, ...native, matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1 };
    return count === 2 ? new Promise(resolve => { finish = () => resolve(observed); }) : observed;
  } });
  const result = await h.call('await app.click("File"); await app.click("Save");');
  assert.equal(result.isError, true);
  finish(); await tick();
  assert.deepEqual(h.clicks, [2]);
  assert.equal(h.received.length, 1);
  assert.equal(h.sent.length, 1);
});

test('TT1N: disposal during the fresh helper check prevents the remainder', async t => {
  let h;
  h = await fixture(t, { identity: async (expected, native, count) => {
    if (count === 2) h.relay.dispose();
    return { ...expected, ...native, matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1 };
  } });
  const result = await h.call('await app.click("File"); await app.click("Save");');
  assert.equal(result.isError, true);
  assert.deepEqual(h.clicks, [2]);
  assert.equal(h.sent.length, 1);
});

// DR1: Word's Replace All alert (word-edit, 2026-10-17). The lease moved from the document to the alert; the next
// call's OK closed it and the rest stopped as 'window changed' in 7 of 8 runs.
const page = 'Window: "report.txt", App: Fixture Editor.\n0 standard window report.txt, URL: file:///tmp/report.txt\n\t1 text area (settable) Value: draft\n\t2 button Replace All';
const alert = 'Window: "", App: Fixture Editor.\n0 dialog Description: alert\n\t1 text All done. We made 1 replacement.\n\t2 button OK, ID: ok';
const dialogIdentity = (expected, native) => ({ ...expected, ...native, matches: 1, headerMatches: 1, epoch: 'helper', pid: 123, processStart: 1,
  ...(expected.title === '' ? { windowNumber: 31, window: 2 } : { window: 1 }) });
async function dialogFixture(t, { bare, ...options } = {}) {
  const h = await fixture(t, bare ? { base: alert, after: page, identity: dialogIdentity, ...options } :
    { base: page, after: alert, afterItem: options.base ?? page, identity: dialogIdentity, ...options });
  if (!bare) assert.match(JSON.stringify(await h.call('await app.click({ label: "Replace All" });')), /\\n0 dialog /);
  const start = h.sent.length;
  return { ...h, sentSince: () => h.sent.length - start };
}
const dismiss = 'await app.click({ id: "ok" }); await app.pressKey("super+End");';
// The document loses focus once the alert is up (the alert's own probe has an empty title).
const lostFocus = () => {
  let alerted = false;
  return (expected, native) => expected.title === '' ? (alerted = true, dialogIdentity(expected, native))
    : alerted ? { status: 'mismatch', error: 'Focused window differs' } : dialogIdentity(expected, native);
};

test('DR1: OK on an alert the lease moved to continues on the document it covered', async t => {
  const h = await dialogFixture(t);
  const result = await h.call(dismiss);
  assert.notEqual(result.isError, true);
  assert.deepEqual(h.keys, ['super+End']);
  assert.equal(h.sentSince(), 2);
  assert.doesNotMatch(JSON.stringify(result), /guard-stop|window or URL changed/);
});

test('DR1: a filtered trailing read still continues', async t => {
  const h = await dialogFixture(t);
  const result = await h.call(dismiss + ' const s = await app.getAXState(); s.split("\\n").filter(l => /draft/.test(l)).join("\\n")');
  assert.notEqual(result.isError, true);
  assert.deepEqual(h.keys, ['super+End']);
});

for (const [name, options] of [
  ['another document', { afterItem: page.replaceAll('report.txt', 'other.txt') }],
  ['the same title at another URL', { afterItem: page.replace('file:///tmp/report.txt', 'file:///tmp/copy/report.txt') }],
  ['another app', { afterItem: page.replace('App: Fixture Editor.', 'App: Other Editor.') }],
  ['another window of the app', { afterItem: 'Window: "Styles", App: Fixture Editor.\n0 standard window Styles\n\t1 button Apply' }],
  ['user input during the call', { identity: (expected, native) => ({ ...dialogIdentity(expected, native), ...(expected.title ? { hidIdleSeconds: 0 } : {}) }) }],
  ['a lost focus', { identity: lostFocus() }],
  ['a dialog read without the window it covered', { bare: true }],
  // LW1 review: window-identity narrows two same-title windows to the focused one.
  ['a second window with the same title and URL', { identity: (expected, native) => ({ ...dialogIdentity(expected, native), ...(expected.title ? { headerMatches: 2 } : {}) }) }],
  // LW1 review: a parent recorded from a dialog would continue into that dialog.
  ['a covered window that was itself a dialog', { base: 'Window: "Find", App: Fixture Editor.\n0 dialog Find, URL: file:///tmp/find\n\t1 text area (settable) Value: \n\t2 button Replace All' }],
]) test(`DR1: closing the dialog onto ${name} stops`, async t => {
  const h = await dialogFixture(t, options);
  const result = await h.call(dismiss);
  assert.equal(result.isError, true);
  assert.deepEqual(h.keys, []);
  assert.equal(h.sentSince(), 1);
});

test('DR1: a re-acquire of the same alert keeps the covered window and continues', async t => {
  const h = await dialogFixture(t);
  const result = await h.call('let app = await cua.getApp("Fixture Editor"); ' + dismiss);
  assert.notEqual(result.isError, true);
  assert.deepEqual(h.keys, ['super+End']);
});

// LW2: word-edit 2026-10-17T19-02-45-300Z. open_file's handle renamed, the document shown as a dialog root while the
// Find sidebar is open, Replace All's alert, then OK and the rest in one call.
const sheetRoot = page.replace('0 standard window report.txt', '0 dialog report.txt');
test('LW2: OK on the alert continues after the document showed a dialog root, through a renamed open_file handle', async t => {
  const events = [];
  const h = await fixture(t, { base: page, after: alert, afterItem: page, identity: dialogIdentity,
    trace: (direction, msg) => { if (process.env.LW2_DEBUG) events.push(direction + ' ' + JSON.stringify(msg).slice(0, 300)); } });
  await h.call('globalThis.__sleightOpenedApp3 = await cua.getApp("Fixture Editor");');
  h.setText(sheetRoot);
  assert.match(JSON.stringify(await h.call('let app = __sleightOpenedApp3; let s = await app.getAXState(); s')), /0 dialog report/);
  const replaced = await h.call('let app = __sleightOpenedApp3; await app.click({ label: "Replace All" }); let s = await app.getAXState({ disableDiffing: true }); nodeRepl.write(s.split("\\n").filter(l => /MATCHES|Report/.test(l)).slice(0, 10).join("\\n"));');
  assert.match(JSON.stringify(replaced), /All done/, JSON.stringify(replaced));
  const result = await h.call('let app = __sleightOpenedApp3; await app.click({ label: "OK" }); await app.pressKey("super+End"); await app.pressKey("Return"); let s = await app.getAXState({ disableDiffing: true }); nodeRepl.write(s.split("\\n").filter(l => /Table|Insert|menu|Window:/i.test(l)).slice(0, 40).join("\\n"));');
  if (process.env.LW2_DEBUG) console.log(events.join('\n'), JSON.stringify(result).slice(0, 1500));
  assert.notEqual(result.isError, true);
  assert.deepEqual(h.keys, ['super+End', 'Return']);
});

// LW2: the whole of that run from the Styles gallery on, with Word's window shapes (paths shortened).
const wordTitle = 'Report-2001a6ad  -  Compatibility Mode';
const wordDoc = `Window: "${wordTitle}", App: Microsoft Word.\n0 standard window ${wordTitle}, Secondary Actions: Raise, URL: file:///tmp/Report-2001a6ad.docx\n\t1 split group\n\t\t2 tab Description: Find and Replace, Value: 0, ID: sidebar_tab_findAndReplace\n\t3 text entry area (disabled, settable) Description: Page 1 content, Value: Report\n\t4 button Styles\n\t5 combo box (settable) Description: Search Document\n\t6 combo box (settable) Description: Replace With\n\t7 button Replace All`;
const wordSheet = wordDoc.replace(`0 standard window ${wordTitle}`, `0 dialog ${wordTitle}`);
const wordStyles = 'Window: "Styles", App: Microsoft Word.\n0 window Styles, Secondary Actions: Raise\n\t1 container';
const wordAlert = 'Window: "", App: Microsoft Word.\n0 dialog Description: alert, Secondary Actions: Raise\n\t1 image Word alert\n\t2 text Microsoft Word All done. We made 1 replacement.\n\t3 button OK, ID: action-button--998\n4 menu bar';
const wordActions = (name, argument, text) => name === 'click' && argument === 4 ? wordStyles : argument === 'Escape' ? wordDoc
  : argument === 'super+h' ? wordSheet : name === 'click' && argument === 7 ? wordAlert : text === wordAlert ? wordDoc : text;
const filtered = pattern => ` let s = await app.getAXState({ disableDiffing: true }); nodeRepl.write(s.split("\\n").filter(l => /${pattern}/i.test(l)).slice(0, 40).join("\\n"));`;
test('LW2: the 19-02-45 word-edit sequence continues past Escape on Styles and OK on the alert', async t => {
  const events = [];
  const h = await fixture(t, { base: wordDoc, onAction: wordActions, identity: dialogIdentity,
    trace: (direction, msg) => { if (process.env.LW2_DEBUG && !/^(?:to-server|to-client|from-server|call-received)$/.test(direction)) events.push(direction + ' ' + JSON.stringify(msg).slice(0, 300)); } });
  const step = async code => { const result = await h.call('let app = __sleightOpenedApp3; ' + code); if (process.env.LW2_DEBUG) console.log('STEP', code.slice(0, 60), '=>', JSON.stringify(result).slice(0, 700), '\n', events.splice(0).join('\n')); return result; };
  await h.call('globalThis.__sleightOpenedApp3 = await cua.getApp("Microsoft Word");');
  await step('let s = await app.getAXState(); s');
  assert.match(JSON.stringify(await step('await app.click({ label: "Styles" });' + filtered('Heading|Normal'))), /Styles/);
  const escape = await step('await app.pressKey("Escape"); await app.pressKey("super+h");' + filtered('Find|Replace|Window|dialog|sheet|Description'));
  assert.notEqual(escape.isError, true);
  assert.deepEqual(h.keys, ['Escape', 'super+h']);
  // The run's "degraded read": a second header without the URL, so the lease lost its window and the relay re-acquired
  // the document, now a dialog root, before the next two calls (acquisition-split for ids 13 and 14).
  await step(`await app.click({ id: "sidebar_tab_findAndReplace" }); nodeRepl.write('Window: "${wordTitle}", App: Microsoft Word.\\n');`);
  await step('await app.setValue(5, "amber"); await app.setValue(6, "violet");' + filtered('Search Document|Replace With'));
  assert.match(JSON.stringify(await step('await app.click({ label: "Replace All" });' + filtered('MATCHES|Report'))), /All done/);
  const ok = await step('await app.click({ label: "OK" }); await app.pressKey("super+End"); await app.pressKey("Return");' + filtered('Table|Insert|menu|Window:'));
  assert.notEqual(ok.isError, true);
  assert.deepEqual(h.keys, ['Escape', 'super+h', 'super+End', 'Return']);
});

// LW2: word-edit 2026-10-17T19-00-39-523Z. Replace All's result still showed the document; the next call's re-acquire
// showed the alert, and its numbered click after OK stopped as "an earlier action in this call changed what element 28
// is", a stop that no continuation reads. The window change now wins over that element check.
test('LW2: the 19-00-39 shape continues to a numbered click after OK on an alert its re-acquire showed', async t => {
  const events = [];
  const h = await fixture(t, { base: wordDoc, identity: dialogIdentity, onAction: (name, argument, text) => text === wordAlert ? wordDoc : text,
    trace: direction => events.push(direction) });
  assert.doesNotMatch(JSON.stringify(await h.call('let app = await cua.getApp("Microsoft Word"); await app.setValue(5, "amber"); await app.setValue(6, "violet"); await app.click(7);' + filtered('amber|violet|MATCHES'))), /isError":true/);
  h.setText(wordAlert);
  const result = await h.call('let app = await cua.getApp("Microsoft Word"); await app.click({ id: "action-button--998" }); await app.click(3); await app.pressKey("super+End"); await app.pressKey("Return");' + filtered('Table|menu|Insert'));
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(events.includes('menu-continuation'));
  assert.deepEqual(h.clicks.slice(-2), [3, 3], 'OK in the alert, then the document\'s element 3');
  assert.deepEqual(h.keys, ['super+End', 'Return']);
});

test('LW2: a window change outranks a stale number, and the stop is a window stop the relay can read', async t => {
  const h = await fixture(t, { base: wordDoc, identity: dialogIdentity, onAction: (name, argument, text) => text === wordAlert ? wordDoc.replaceAll('Report-2001a6ad', 'Other') : text });
  h.setText(wordAlert);
  await h.call('let s = await app.getAXState(); s');
  const result = await h.call('await app.click({ id: "action-button--998" }); await app.click(3);');
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /window or URL changed/);
  assert.doesNotMatch(JSON.stringify(result), /changed what element/);
  assert.deepEqual(h.clicks, [3]);
});

for (const [name, options, reason] of [
  ['no covered window', { bare: true }, 'no-covered-window'],
  ['another document', { afterItem: page.replaceAll('report.txt', 'other.txt') }, 'other-title'],
  ['a second same-title window', { identity: (expected, native) => ({ ...dialogIdentity(expected, native), ...(expected.title ? { headerMatches: 2 } : {}) }) }, 'header-matches-2'],
  ['HID input', { identity: (expected, native) => ({ ...dialogIdentity(expected, native), ...(expected.title ? { hidIdleSeconds: 0 } : {}) }) }, 'hid-input'],
  ['lost focus', { identity: lostFocus() }, 'identity: Input lease: Focused window differs'],
]) test(`LW2: the trace names why a dialog stop did not continue (${name})`, async t => {
  const events = [];
  const h = await dialogFixture(t, { ...options, trace: (direction, msg) => { if (direction === 'dialog-continuation-refused') events.push(msg.reason); } });
  assert.equal((await h.call(dismiss)).isError, true);
  assert.ok(events.some(event => event.startsWith(reason)), JSON.stringify(events));
});

// LW3 review 1: the bundle ID comes from the handle's metadata, so another app's dialog looked like the document's own.
// SecurityAgent itself is now refused outright (VC10, relay-own-host.test.mjs), so another system app's dialog stands in here.
test('LW3: another app\'s dialog over the document never continues onto it', async t => {
  const security = 'Window: "", App: UserNotificationCenter.\n0 dialog Description: alert\n\t1 text Word wants to make changes.\n\t2 button OK, ID: ok';
  const events = [];
  const h = await dialogFixture(t, { after: security, trace: (direction, msg) => { if (direction === 'dialog-continuation-refused') events.push(msg.reason); } });
  const result = await h.call(dismiss);
  assert.equal(result.isError, true);
  assert.deepEqual(h.keys, []);
  assert.ok(events.includes('no-covered-window'), JSON.stringify(events));
});

test('LW3: no baseline for the dialog, no continuation', async t => {
  const events = [];
  const h = await dialogFixture(t, { identity: (expected, native) => expected.title === '' ? { status: 'ok', matches: 2 } : dialogIdentity(expected, native),
    trace: (direction, msg) => { if (direction === 'dialog-continuation-refused') events.push(msg.reason); } });
  assert.equal((await h.call(dismiss)).isError, true);
  assert.deepEqual(h.keys, []);
  assert.ok(events.includes('no-baseline'), JSON.stringify(events));
});

// LW3 review 2: a palette that stays open hands focus back without closing.
const palette = 'Window: "Formatting Palette", App: Fixture Editor.\n0 floating window Formatting Palette\n\t1 button Bold, ID: bold\n\t2 button Close, ID: close';
for (const [name, open, code, continues] of [
  ['a palette button that leaves it open stops', true, 'await app.click({ id: "bold" }); await app.pressKey("super+End");', false],
  ['a palette button that closes it continues', false, 'await app.click({ id: "close" }); await app.pressKey("super+End");', true],
  ['Escape on an open palette continues', true, 'await app.pressKey("Escape"); await app.pressKey("super+End");', true],
]) test(`LW3: ${name}`, async t => {
  let clicked = false;
  const h = await fixture(t, { base: page, onAction: (action, argument, text) => text === page && argument === 2 ? palette : text === palette ? (clicked = true, page) : text,
    identity: (expected, native) => expected.title !== 'Formatting Palette' || !clicked ? dialogIdentity(expected, native)
      : open ? { status: 'mismatch', error: 'Focused window differs' } : { status: 'ok', matches: 0, headerMatches: 0 } });
  assert.match(JSON.stringify(await h.call('await app.click({ label: "Replace All" });')), /Formatting Palette/);
  const result = await h.call(code);
  assert.equal(result.isError === true, !continues, JSON.stringify(result).slice(0, 400));
  assert.deepEqual(h.keys.filter(key => key === 'super+End'), continues ? ['super+End'] : []);
});

// LW3 review 3: a dialog closing onto another dialog under the document's title and URL is not the document.
test('LW3: the alert closing onto a dialog root under the document\'s title stops', async t => {
  const events = [];
  const h = await dialogFixture(t, { afterItem: sheetRoot, trace: (direction, msg) => { if (direction === 'dialog-continuation-refused') events.push(msg.reason); } });
  assert.equal((await h.call(dismiss)).isError, true);
  assert.deepEqual(h.keys, []);
  assert.ok(events.includes('returned-root-not-standard'), JSON.stringify(events));
});

// LW3 review 4: HID idle runs from when the covered window was last seen standard, and a new process forgets it.
// The relay's clock is injected: the document is seen standard at 1 s, the alert opens and closes at 11 s, and the
// helper reports the last input 5 s ago (at 6 s, after the document was seen). With 20 s idle the same calls continue.
for (const [idleSeconds, continues] of [[5, false], [20, true]]) test(`LW3: ${continues ? 'no input' : 'input'} since the document was last seen standard ${continues ? 'continues' : 'stops'}`, async t => {
  let ms = 1000;
  const events = [];
  const h = await fixture(t, { base: page, after: alert, afterItem: page, clock: () => ms,
    identity: (expected, native) => ({ ...dialogIdentity(expected, native), hidIdleSeconds: idleSeconds }),
    trace: (direction, msg) => { if (direction === 'dialog-continuation-refused') events.push(msg.reason); } });
  ms = 11000;
  assert.match(JSON.stringify(await h.call('await app.click({ label: "Replace All" });')), /All done/);
  assert.equal((await h.call(dismiss)).isError === true, !continues);
  assert.deepEqual(h.keys, continues ? ['super+End'] : []);
  assert.deepEqual(events, continues ? [] : ['hid-input']);
});

test('LW3: a relaunched app forgets the standard windows it showed before', async t => {
  let pid = 123;
  const events = [];
  const h = await fixture(t, { base: page, identity: (expected, native) => ({ ...dialogIdentity(expected, native), pid }),
    onAction: (action, argument, text) => text === page && argument === 2 ? alert : text === alert ? page : text,
    trace: (direction, msg) => { if (direction === 'dialog-continuation-refused') events.push(msg.reason); } });
  assert.notEqual((await h.call('await app.click(1); await app.pressKey("a");')).isError, true);
  pid = 456;
  assert.match(JSON.stringify(await h.call('await app.click({ label: "Replace All" });')), /All done/);
  assert.equal((await h.call(dismiss)).isError, true);
  assert.deepEqual(h.keys, ['a']);
  assert.ok(events.includes('no-covered-window'), JSON.stringify(events));
});

// LW4 review 1: nothing noted a process before the alert, so a relaunch between the document's read and the alert left
// the old process's window looking current. The read now asks for the process, and a note drops windows it can't place.
for (const [name, unknownAtRead] of [['the read learned', false], ['the read could not learn', true]]) test(`LW4: a relaunch after the document's read, before any other process note, never continues (${name} the process)`, async t => {
  let pid = 123, alerted = false;
  const events = [];
  const h = await fixture(t, { base: page, after: alert, afterItem: page,
    identity: (expected, native) => {
      if (expected.title === '') alerted = true;
      return unknownAtRead && !alerted ? { status: 'unknown', error: 'probe unavailable' } : { ...dialogIdentity(expected, native), pid };
    },
    trace: (direction, msg) => { if (direction === 'dialog-continuation-refused') events.push(msg.reason); } });
  pid = 456;
  assert.match(JSON.stringify(await h.call('await app.click({ label: "Replace All" });')), /All done/);
  assert.equal((await h.call(dismiss)).isError, true);
  assert.deepEqual(h.keys, []);
  assert.deepEqual(events, ['no-covered-window']);
});

// LW4 review 2: "Don't Save" on a never-saved document's alert closes the document, and focus can land on another
// window with its title. Without a URL, a dialog needs the covered window's certified native identity. (A title of
// Untitled or Untitled n doesn't reach this: the guard adopts it as a window the click opened.)
test('LW4: a document without a URL or a certified window never continues after its dialog closes', async t => {
  const untitled = page.replace(', URL: file:///tmp/report.txt', '').replaceAll('report.txt', 'Document1');
  const events = [];
  const h = await fixture(t, { base: untitled, after: alert, afterItem: untitled, identity: dialogIdentity,
    trace: (direction, msg) => { if (direction === 'dialog-continuation-refused') events.push(msg.reason); } });
  assert.match(JSON.stringify(await h.call('await app.click({ label: "Replace All" });')), /All done/);
  assert.equal((await h.call(dismiss)).isError, true);
  assert.deepEqual(h.keys, []);
  assert.deepEqual(events, ['untitled-needs-certified-window']);
});

// LW1 review: two untitled dialogs compare equal, so a later one could inherit an earlier one's parent. Continuing
// needs HID idle since the parent was recorded.
test('LW1: input after the dialog appeared, though none during the call, stops', async t => {
  let ms = 1000;
  const h = await dialogFixture(t, { clock: () => ms, identity: (expected, native) => ({ ...dialogIdentity(expected, native), hidIdleSeconds: 5 }) });
  ms = 11000;
  const result = await h.call(dismiss);
  assert.equal(result.isError, true);
  assert.deepEqual(h.keys, []);
});

test('DR1: a lease stop says which actions ran and which were not sent', async t => {
  const h = await dialogFixture(t, { afterItem: page.replaceAll('report.txt', 'other.txt') });
  const text = (await h.call(dismiss + ' await app.typeText("secret words");')).content.map(c => c.text ?? '').join('\n');
  assert.match(text, /sleight: this call ran 1 action \(click id "ok"\); not sent: pressKey "super\+End", typeText\./);
  assert.doesNotMatch(text, /secret words/);
  const unsplit = await dialogFixture(t, { afterItem: page.replaceAll('report.txt', 'other.txt') });
  const plain = (await unsplit.call('await app.click({ id: "ok" }); if (true) await app.pressKey("super+End");')).content.map(c => c.text ?? '').join('\n');
  assert.match(plain, /sleight: this call ran 1 action; the stopped pressKey and everything after it were not sent\./);
});

// OF1: the real engine puts the exception first, so a call that went on past its own OK still opened with "Input lease
// stopped" in 6 of 6 Office runs (2026-10-17), and 4 cost a turn redoing an action that had run. The calls are those runs'
// (transcript lines in ledger/fable-1017-office-turns.md), on Word's shapes.
const allText = result => result.content.map(c => c.text ?? '').join('\n');
const wordMenus = wordDoc + '\n8 menu bar\n\t9 Table';
const replaceAll = (name, argument, text) => name === 'click' && argument === 7 && text !== wordAlert ? wordAlert : text === wordAlert ? wordMenus : text;
const continued = `then pressKey "super+End"`, inDoc = ` in "${wordTitle}".`;
for (const [run, code, lead] of [
  ['21-55 L92', 'await __sleightOpenedApp3.click({ id: "action-button--998" }); await __sleightOpenedApp3.pressKey("super+End"); const s = await __sleightOpenedApp3.getAXState(); nodeRepl.write(s.split("\\n").filter(l => /MATCHES|Page 1 content|dialog|Window|focused/i.test(l)).join("\\n"));',
    `sleight: all 2 actions ran: click id "action-button--998" closed the dialog, ${continued}${inDoc}`],
  ['22-00 L75', 'await app.click({ label: "OK" });\nawait app.pressKey("super+End");\nawait app.pressKey("Return");\nnodeRepl.write("ok");',
    `sleight: all 3 actions ran: click closed the dialog, ${continued}, pressKey "Return"${inDoc}`],
  ['22-03 L56', 'let app = await cua.getApp("Microsoft Word"); await app.click({ id: "action-button--998" }); await app.click([600, 390]); await app.pressKey("super+End"); nodeRepl.write("ready");',
    `sleight: all 3 actions ran: click id "action-button--998" closed the dialog, then click, pressKey "super+End"${inDoc}`],
  ['22-18 L61', 'await app.click({ label: "OK" });\nawait app.click([700, 402]);\nawait app.pressKey("super+End");\nawait app.click({ label: "Table" });\nconst s = await app.getAXState();\nnodeRepl.write(s.slice(0, 3000));',
    `sleight: all 4 actions ran: click closed the dialog, then click, pressKey "super+End", click${inDoc}`],
  ['22-20 L79', 'await app.click({ id: "action-button--998" });\nawait app.pressKey("super+End");\nawait app.pressKey("Return");\nlet r = await app.getAXStateAndScreenshot({ disableDiffing: true });\nnodeRepl.write(r.state.split("\\n").filter(l => /Window:|alert|dialog|Page 1 content|violet|shipment|Keep this|Undo/i.test(l)).join("\\n"));',
    `sleight: all 3 actions ran: click id "action-button--998" closed the dialog, ${continued}, pressKey "Return"${inDoc}`],
]) test(`OF1: the ${run} continued call leads with what ran, not the stop`, async t => {
  const h = await fixture(t, { base: wordDoc, identity: dialogIdentity, onAction: replaceAll, errorFirst: true });
  await h.call('globalThis.__sleightOpenedApp3 = await cua.getApp("Microsoft Word");');
  assert.match(allText(await h.call('await app.click(7);')), /All done/);
  const result = await h.call(code);
  assert.notEqual(result.isError, true, allText(result).slice(0, 600));
  assert.equal(result.content[0].text, lead);
  assert.doesNotMatch(allText(result), /Input lease stopped/);
});

// Excel 22-10 L125: Close on Name Manager, then twelve more actions into the workbook.
test('OF1: the excel 22-10 L125 continued call names the first four and counts the rest', async t => {
  const book = 'Window: "Inventory-4a8bd91b", App: Microsoft Excel.\n0 standard window Inventory-4a8bd91b, URL: file:///tmp/Inventory-4a8bd91b.xlsx\n\t1 text field Name Box, ID: NameBox\n\t2 table Sheet1\n\t3 button Name Manager';
  const names = 'Window: "Name Manager", App: Microsoft Excel.\n0 dialog Name Manager\n\t1 button Close\n\t2 button New…';
  const h = await fixture(t, { base: book, identity: dialogIdentity, errorFirst: true,
    onAction: (name, argument, text) => name === 'click' && argument === 3 && text === book ? names : text === names ? book : text });
  assert.match(allText(await h.call('await app.click({ label: "Name Manager" });')), /0 dialog Name Manager/);
  const result = await h.call('await app.click({ label: "Close" }); await app.click({ id: "NameBox" }); await app.typeText("D1"); await app.pressKey("Return"); await app.typeText("Budget"); await app.pressKey("Return"); await app.typeText("11"); await app.pressKey("Return"); await app.typeText("4"); await app.pressKey("Return"); await app.typeText("=SUM(D2:D3)"); await app.pressKey("Return");');
  assert.notEqual(result.isError, true, allText(result).slice(0, 600));
  assert.equal(result.content[0].text, 'sleight: all 12 actions ran: click closed the dialog, then click id "NameBox", typeText, pressKey "Return", typeText and 7 more in "Inventory-4a8bd91b".');
  assert.doesNotMatch(result.content[0].text, /Budget|SUM/, 'no typed text');
  assert.doesNotMatch(allText(result), /Input lease stopped/);
});

test('OF1: when the rest stops, the lead says the call went on and the rest\'s ran/not-sent line follows it', async t => {
  const other = page.replaceAll('report.txt', 'other.txt');
  const h = await fixture(t, { base: page, identity: dialogIdentity, errorFirst: true,
    onAction: (name, argument, text) => text === alert ? page : name === 'pressKey' ? other : name === 'click' && argument === 2 ? alert : text });
  assert.match(allText(await h.call('await app.click({ label: "Replace All" });')), /All done/);
  const result = await h.call('await app.click({ id: "ok" }); await app.pressKey("super+End"); await app.typeText("secret words");');
  assert.equal(result.isError, true);
  assert.deepEqual(h.keys, ['super+End']);
  assert.deepEqual(h.typed, []);
  assert.equal(result.content[0].text, 'sleight: click id "ok" closed the dialog, and the call went on in "report.txt" with pressKey "super+End", typeText until an error stopped it.');
  assert.match(result.content[1].text, /^sleight: this call ran 2 actions; the stopped typeText and everything after it were not sent\./);
  assert.doesNotMatch(allText(result), /secret words/);
});

test('OF1: a remainder the final check refuses returns the original stop, with no continued lead', async t => {
  // Admission, the check after the stop, then the final check just before the rest goes to the engine.
  let checks;
  const h = await dialogFixture(t, { errorFirst: true, identity: (expected, native) => checks !== undefined && ++checks === 3
    ? { ...dialogIdentity(expected, native), hidIdleSeconds: 0 } : dialogIdentity(expected, native) });
  checks = 0;
  const result = await h.call(dismiss);
  assert.equal(checks, 3);
  assert.equal(result.isError, true, allText(result).slice(0, 400));
  assert.deepEqual(h.keys, []);
  assert.match(result.content[0].text, /^sleight: this call ran 1 action \(click id "ok"\); not sent: pressKey "super\+End"\./);
  assert.doesNotMatch(allText(result), /sleight: all |went on/);
});

test('OF1 lean: the continued lead is shorter', async t => {
  const h = await fixture(t, { base: wordDoc, identity: dialogIdentity, onAction: replaceAll, errorFirst: true, prompt: 'lean' });
  assert.match(allText(await h.call('await app.click(7);')), /All done/);
  const result = await h.call('await app.click({ id: "action-button--998" }); await app.pressKey("super+End");');
  assert.equal(result.content[0].text, `sleight: 2 actions ran: click id "action-button--998" closed the dialog, ${continued}${inDoc}`);
});

// OF2: OK, then a click in the page, then keys: 6 of the 15 Office mid-call stops (2026-10-17), each followed by a retry.
test('OF2: a stop after the call\'s own OK closed the dialog says so first, and that the next call can send the rest', async t => {
  const h = await dialogFixture(t, { afterItem: page.replaceAll('report.txt', 'other.txt'), errorFirst: true });
  const result = await h.call('await app.click({ id: "ok" }); await app.click(1); await app.pressKey("super+End");');
  assert.equal(result.isError, true);
  assert.deepEqual(h.keys, []);
  assert.equal(result.content[0].text, 'sleight: this call ran 1 action (click id "ok"); not sent: click 1, pressKey "super+End". ' +
    'Closing the dialog stopped the rest; the next call can send it to the window shown here with no new read.');
});

// 21-53 L61's call: its awaited write keeps it unsplit, so no continuation; the note rises above the acquisition's tree.
test('OF2: the 21-53 L61 unsplit call after OK leads with the stop note and the dialog sentence', async t => {
  for (const prompt of [undefined, 'lean']) {
    const h = await dialogFixture(t, { errorFirst: true, prompt });
    const result = await h.call('let app = await cua.getApp("Fixture Editor");\nawait app.click({ id: "ok" });\nawait app.click([600, 402]);\nawait app.pressKey("super+End");\nawait app.click({ label: "Replace All" });\nawait nodeRepl.write(await app.getAXState());');
    assert.equal(result.isError, true);
    assert.deepEqual(h.keys, []);
    assert.equal(result.content[0].text, (prompt ? 'sleight: this call ran 1 action; not sent: the stopped click onward.' : 'sleight: this call ran 1 action; the stopped click and everything after it were not sent.') + (prompt
      ? ' Dialog closed: rest not sent; send it next call, no new read.'
      : ' Closing the dialog stopped the rest; the next call can send it to the window shown here with no new read.'));
  }
});

test('OF2: a stop that closed no dialog keeps the tab and page advice', async t => {
  const h = await fixture(t, { base: navigation, after: child, guardMode: 'careful', errorFirst: true });
  const result = await h.call('await app.pressKey("Return"); await app.click("Other");');
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^sleight: this call ran 1 action \(pressKey "Return"\); not sent: click\. After an action that opens a tab or page/);
  assert.doesNotMatch(allText(result), /Closing the dialog/);
});

// AB3: a date picker re-rendered its days after the first date's click, so the engine refused the next date's number
// from the call's bound capture (Firefox travel, 2026-10-17). A diff read, a full read and a lone click followed (9.4 s).
// lp1 (fix 4): with one inserted row the refused click goes once more to its new number. `split` also inserts a second
// row between the days and the guests, which no single block explains, so the stop paths below keep their shape.
const picker = (rendered, split = false) => 'Window: "report.txt", App: Fixture Editor.\n0 standard window report.txt, URL: file:///tmp/report.txt\n' +
  '\t1 text field Dates' + (rendered ? ', Value: Dec 14\n\t2 text Check-in set' : '') + '\n' +
  ['button Monday, December 14, ID: d14', 'button Saturday, December 19, ID: d19', ...rendered && split ? ['text Pick check-out'] : [],
    'button Add adult, ID: add-adult', 'button Add child, ID: add-child']
    .map((line, i) => `\t${i + (rendered ? 3 : 2)} ${line}`).join('\n');
async function pickerFixture(t, { failRead = false, split = true } = {}) {
  // The engine's capture: a read takes a new one, and any click replaces the elements it holds.
  let stale = false;
  return fixture(t, { base: picker(false), onRead: () => { if (failRead && stale) throw new Error('read failed'); stale = false; },
    onAction: (name, number) => {
      if (stale) throw new Error(`Computer Use server error -10005: ${number} is an invalid element ID`);
      stale = true;
      return picker(true, split);
    } });
}

test('lp1: the date picker\'s refused click goes once more to its new number, and the call goes on', async t => {
  const h = await pickerFixture(t, { split: false });
  const result = await h.call('await app.click({ label: "Monday, December 14" }); await app.click({ label: "Saturday, December 19" }); ' +
    'await app.click({ label: "Add adult" }); await app.click(5);');
  assert.notEqual(result.isError, true, JSON.stringify(result));
  // 3 refused, resent to 4; click(5) was Add child in the tree Claude saw, now 6.
  assert.deepEqual(h.clicks, [2, 3, 4, 5, 6]);
  assert.match(allText(result), /sleight: click\(3\) went to element 4, the same "button Saturday, December 19, ID: d19": an earlier action in this call renumbered the window\./);
  assert.doesNotMatch(allText(result), /refused/);
});

test('AB3: a refused element says what ran, what was not sent, and where the rest are now', async t => {
  const h = await pickerFixture(t);
  const result = await h.call('await app.click({ label: "Monday, December 14" }); await app.click({ label: "Saturday, December 19" }); ' +
    'await app.click({ label: "Add adult" }); await app.click(5);');
  assert.equal(result.isError, true);
  assert.deepEqual(h.clicks, [2, 3], 'the refused click is not resent and nothing after it runs');
  const text = result.content.map(c => c.text ?? '').join('\n');
  assert.match(text, /sleight: this call ran 1 action \(click\); the engine refused the next click \(element 3\): its number came from this call's first read, and the element changed \(perhaps replaced by an earlier action\)\. Not sent after it: click, click 5\./);
  // click(5) was Add child in the tree Claude saw; it is 7 now, below the second inserted row.
  assert.match(text, /In this result's window, the refused action and the rest are now click 4, click 6, click 7\. /);
  assert.match(text, /sleight now reads this window before each numbered or named action, so the rest can go in one call\./);
  assert.match(text, /Dates, Value: Dec 14/, 'the fresh tree is in the result');
  assert.ok(result.content[0].text.startsWith('sleight: this call ran'), 'the note comes before the tree');
  assert.doesNotMatch(result.content[0].text, /December 19|Add adult/, 'the note names no label text');
});

test('AB3 review: when the read after a refusal fails, the note claims no current window', async t => {
  const h = await pickerFixture(t, { failRead: true });
  const result = await h.call('await app.click({ label: "Monday, December 14" }); await app.click({ label: "Saturday, December 19" }); await app.click(5);');
  assert.equal(result.isError, true);
  assert.deepEqual(h.clicks, [2, 3]);
  const text = result.content.map(c => c.text ?? '').join('\n');
  assert.match(text, /Not sent after it: click 5\. sleight couldn't read the window after it, so read it before acting\./);
  assert.doesNotMatch(text, /is current|are now/);
});

test('AB3: after a refusal, the rest goes in one call', async t => {
  const h = await pickerFixture(t);
  await h.call('await app.click({ label: "Monday, December 14" }); await app.click({ label: "Saturday, December 19" });');
  const result = await h.call('await app.click({ label: "Saturday, December 19" }); await app.click({ label: "Add adult" }); ' +
    'await app.click({ label: "Add adult" }); await app.click({ label: "Add child" });');
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(h.clicks, [2, 3, 4, 6, 6, 7]);
});

// AB1: the Firefox race round's new-tab stops (2026-10-17). A leased browser-like window without a URL; Cmd+T adds a
// selected tab and retitles the window, with focus in the address field outside the page.
const marker = 'Window: "Marker", App: Fixture Editor.\n0 standard window Marker, Secondary Actions: Raise\n\t1 tab group\n' +
  '\t\t2 tab (selected) Value: Marker, Marker\nClose tab\n\t\t3 button Open a new tab\n\t4 combo box (settable) Address\n' +
  '\t5 HTML Content Description: Marker\n\t\t6 link Home\n\nThe focused UI element is 1 tab group';
const newTab = 'Window: "New Tab", App: Fixture Editor.\n0 standard window New Tab, Secondary Actions: Raise\n\t1 tab group\n' +
  '\t\t2 tab (selectable) Value: Marker, Marker\nClose tab\n\t\t3 tab (selected) Value: New Tab, New Tab\nClose tab\n\t\t4 button Open a new tab\n' +
  '\t5 combo box (settable) Address\n\t6 HTML Content Description: New Tab\n\t\t7 link Shortcuts\n\nThe focused UI element is 5 combo box (settable) Address';
const shop = newTab.replaceAll('New Tab', 'Shop').replace(/The focused UI element is .*/, 'The focused UI element is 7 link Shortcuts');
const fieldFocus = { sheets: 0, role: 'AXComboBox', subrole: null, inWindow: true, inPage: false };
const tabCall = 'await app.pressKey("super+t");\nawait app.typeText("http://127.0.0.1:5420/shop");\nawait app.pressKey("Return");\nawait app.getAXState();';
const tabScript = (opened = newTab) => (name, argument, text) => name === 'pressKey' && argument === 'super+t' ? opened
  : name === 'pressKey' && argument === 'Return' ? shop : text;
async function tabFixture(t, { opened, focus = fieldFocus, ...options } = {}) {
  const refusals = [], continued = [], traces = [];
  const h = await fixture(t, { base: marker, onAction: tabScript(opened), trace: (direction, msg) => {
    if (direction === 'tab-continuation-refused') refusals.push(msg.reason);
    if (direction.startsWith('tab-continuation-') || direction === 'tab-probe') traces.push({ direction, ...msg });
    if (direction === 'menu-continuation') continued.push(msg.kind);
  }, ...options });
  h.native.focus = focus;
  return { ...h, refusals, continued, traces };
}
const stoppedAtTab = (h, result) => {
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /window or URL changed|app changed/);
  assert.deepEqual(h.keys, ['super+t']);
  assert.deepEqual(h.typed, []);
  assert.equal(h.sent.length, 1);
};

test('AB1: the call\'s own Cmd+T into a new tab of the same window types the URL there in the same call', async t => {
  const h = await tabFixture(t);
  const result = await h.call(tabCall);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(h.keys, ['super+t', 'Return']);
  assert.deepEqual(h.typed, ['http://127.0.0.1:5420/shop']);
  assert.equal(h.sent.length, 2);
  assert.equal(h.identityChecks(), 3, 'admission baseline, post-stop, and immediately before forwarding');
  assert.deepEqual(h.continued, ['tab']);
  assert.deepEqual(h.refusals, []);
  assert.doesNotMatch(JSON.stringify(result), /guard-stop|window or URL changed/);
});

// 2026-10-18 mdn: the continued result carried the New Tab tree twice before the page (126,517 characters, rejected).
test('AB1: a continued tab call returns the page it reached once, not the new tab it passed through', async t => {
  const h = await tabFixture(t);
  const result = await h.call(tabCall);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const all = result.content.map(item => item.text).join('\n');
  assert.equal(all.match(/^Window: /gm).length, 1, all);
  assert.match(all, /^Window: "Shop"/m);
  assert.doesNotMatch(result.content.slice(1).map(item => item.text).join('\n'), /New Tab/);
  assert.doesNotMatch(all, /this call acted on "Marker" in Fixture Editor\. The window it shows now is "New Tab"/);
  assert.match(result.content[0].text, /^sleight: all 3 actions ran: pressKey "super\+t" opened a tab, then typeText, pressKey "Return"/);
});

test('AB1: Ctrl+T without a trailing read continues too', async t => {
  const h = await tabFixture(t, { onAction: (name, argument, text) => name === 'pressKey' && argument === 'ctrl+t' ? newTab : tabScript()(name, argument, text) });
  const result = await h.call('await app.pressKey("ctrl+t"); await app.typeText("example.org"); await app.pressKey("Return");');
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(h.typed, ['example.org']);
});

for (const [name, options, reason] of [
  ['the baseline flag', { tabContinuation: false }, 'off'],
  ['careful mode', { guardMode: 'careful' }, 'careful'],
  ['another window in front', { nativeChange: 'window' }, 'identity: Input lease: the selected window number changed. Changed target identity. Read the intended window again before acting. Next: await cua.getApp("org.test.editor").'],
  ['the window no longer focused', { nativeChange: 'unfocused' }, 'identity: Input lease: the native window changed. Unconfirmed target identity. Read the intended window again before acting. Next: await cua.getApp("org.test.editor").'],
  ['a new process', { identity: (expected, native, count) => ({ ...expected, ...native, matches: 1, epoch: 'helper', window: 1,
    pid: count === 1 ? 123 : 456, processStart: 1 }) }, 'identity: Input lease: the native window or its process changed. Changed target identity. Read the intended window again before acting. Next: await cua.getApp("org.test.editor").'],
  ['a sheet only the helper sees', { focus: { ...fieldFocus, sheets: 1 } }, 'native-sheet'],
  ['a password field in focus', { focus: { ...fieldFocus, role: 'AXTextField', subrole: 'AXSecureTextField' } }, 'secure-field'],
  ['focus outside the window', { focus: { ...fieldFocus, inWindow: false } }, 'focus-outside-window'],
  ['focus on the page', { opened: newTab.replace(/The focused UI element is .*/, 'The focused UI element is 7 link Shortcuts') }, 'focus-not-app-field'],
  ['a field inside the page', { opened: newTab.replace('\t\t7 link Shortcuts', '\t\t7 text field Search').replace(/The focused UI element is .*/,
    'The focused UI element is 7 text field Search') }, 'focus-in-document'],
  ['a tab switch (no new tab)', { opened: newTab.replace('\t\t2 tab (selectable) Value: Marker, Marker\nClose tab\n', '') }, 'no-new-tab'],
  ['two new tabs', { opened: newTab.replace('\t\t4 button', '\t\t8 tab (selectable) Value: Other, Other\n\t\t4 button') }, 'no-new-tab'],
  ['another app in front', { opened: newTab.replace('App: Fixture Editor.', 'App: Other Editor.') }, 'other-app'],
]) test(`AB1: a new-tab stop stays a stop on ${name}`, async t => {
  const h = await tabFixture(t, options);
  stoppedAtTab(h, await h.call(tabCall));
  assert.deepEqual(h.continued, []);
  if (reason) assert.deepEqual(h.refusals, [reason]);
});

for (const [name, code, reason] of [
  ['a click on a link in the page', 'await app.click(6); await app.typeText("example.org"); await app.pressKey("Return");', 'not-a-tab-shortcut'],
  ['a click on a tab', 'await app.click(2); await app.typeText("example.org"); await app.pressKey("Return");', 'not-a-tab-shortcut'],
  ['Cmd+Shift+T', 'await app.pressKey("super+shift+t"); await app.typeText("example.org"); await app.pressKey("Return");', 'not-a-tab-shortcut'],
  ['an unsplit call', 'await app.pressKey("super+t"); if (true) await app.typeText("example.org");', 'not-admitted'],
]) test(`AB1: ${name} stops before typing`, async t => {
  const h = await tabFixture(t, { onAction: (action, argument, text) => action === 'typeText' ? text : action === 'pressKey' && argument === 'Return' ? shop : newTab });
  const result = await h.call(code);
  assert.equal(result.isError, true);
  assert.deepEqual(h.typed, []);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.refusals, [reason]);
});

test('AB1: a window that changed during the remainder\'s final check stops it with the original stop', async t => {
  const h = await tabFixture(t, { identity: (expected, native, count) => ({ ...expected, ...native, matches: 1, epoch: 'helper', window: 1,
    pid: 123, processStart: 1, ...(count === 3 ? { windowNumber: 23 } : {}) }) });
  stoppedAtTab(h, await h.call(tabCall));
  assert.equal(h.identityChecks(), 3);
  assert.deepEqual(h.refusals, ['final-check']);
});

// 2026-10-18: the continuation fired 0 of 9 in the Firefox race. The engine's own key presses reset HID idle, so idle over the
// whole call refused it. It now asks for idle since the stop result arrived: the engine's presses all came before, and a user
// typing in the new tab's address bar afterwards could interleave with the rest's typing. A fake clock puts the call at 1.0 s,
// the engine's Cmd+T at 1.3 s and the stop result at 1.7 s; `user` makes the helper's check number n see a user key 0.1 s old.
async function timedTab(t, { user } = {}) {
  let now = 1000, enginePress, userPress;
  const script = tabScript();
  return tabFixture(t, { clock: () => now,
    onAction: (name, argument, text) => {
      if (name === 'pressKey' && argument === 'super+t') { now += 300; enginePress = now; now += 400; }
      return script(name, argument, text);
    },
    identity: (expected, native, count) => {
      if (count === user) { now += 300; userPress = now - 100; }
      return { ...expected, ...native, matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1,
        hidIdleSeconds: (now - (userPress ?? enginePress ?? 0)) / 1000 };
    } });
}
test('AB1: the engine\'s own key press before the stop does not stop the tab continuation, and the trace says idle did not cover the call', async t => {
  const h = await timedTab(t);
  const result = await h.call(tabCall);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(h.keys, ['super+t', 'Return']);
  assert.deepEqual(h.typed, ['http://127.0.0.1:5420/shop']);
  assert.deepEqual(h.continued, ['tab']);
  assert.deepEqual(h.refusals, []);
  const [checked] = h.traces.filter(trace => trace.direction === 'tab-continuation-checked');
  assert.deepEqual([checked.hidIdleSeconds, checked.idleSinceStop, checked.idleCoversCall], [0.4, true, false]);
});

// Loss study 2026-10-19 fix 5: every Firefox Cmd+T call spent 1.13 to 1.70 s beyond the engine time its result reported. That
// result's _meta is the second engine call's, so the first call (Cmd+T and the read that saw the new tab) and the helper's two
// probes were not split. The trace now carries each part: the stop reply's engine time and both probes' durations.
test('AB1: the tab continuation trace times the stopped engine call and both helper probes', async t => {
  let now = 1000;
  const engine = [5, 1180, 2400]; // the fixture's own acquisition, the stopped call, the rest
  const h = await tabFixture(t, { clock: () => now, engineMs: () => engine.shift() ?? 0,
    // Identity checks: 1 the call's admission baseline, 2 the probe after the stop, 3 the final probe before forwarding.
    identity: (expected, native, count) => {
      now += count === 2 ? 120 : count === 3 ? 80 : 0;
      return { ...expected, ...native, matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1 };
    } });
  const result = await h.call(tabCall);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const checked = h.traces.find(trace => trace.direction === 'tab-continuation-checked');
  const forwarded = h.traces.find(trace => trace.direction === 'tab-continuation-forwarded');
  assert.deepEqual([checked.stopEngineMs, checked.probeMs], [1180, 120]);
  assert.equal(forwarded.probeMs, 80);
});

// F2: a tab list inside the page is not the window's strip. The relay passes the earlier tree with its indentation, so the
// page's tab is left out of the count on both sides.
test('AB1: an ARIA tab list in the page does not change the tab count either way', async t => {
  const page = '\t\t7 tab (selected) Value: Page, Page\nClose tab';
  const h = await tabFixture(t, { base: marker.replace('\n\nThe focused', `\n${page}\n\nThe focused`),
    opened: newTab.replace('\n\nThe focused', `\n\t\t8 tab (selected) Value: Page, Page\nClose tab\n\nThe focused`) });
  const result = await h.call(tabCall);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(h.continued, ['tab']);
});

test('AB1: user HID input after the stop refuses the tab continuation at the first check', async t => {
  const h = await timedTab(t, { user: 2 });
  stoppedAtTab(h, await h.call(tabCall));
  assert.deepEqual(h.refusals, ['hid-input']);
  assert.deepEqual([h.traces.at(-1).hidIdleSeconds, h.traces.at(-1).idleSinceStop], [0.1, false]);
});

test('AB1: user HID input after the first check refuses the remainder at the final check', async t => {
  const h = await timedTab(t, { user: 3 });
  stoppedAtTab(h, await h.call(tabCall));
  assert.equal(h.identityChecks(), 3);
  assert.deepEqual(h.refusals, ['final-check']);
  assert.deepEqual([h.traces.at(-1).hidIdleSeconds, h.traces.at(-1).idleSinceStop], [0.1, false]);
});

test('AB1: a refusal after the helper answered records the idle sample it saw', async t => {
  const h = await tabFixture(t, { focus: { ...fieldFocus, sheets: 1 } });
  stoppedAtTab(h, await h.call(tabCall));
  assert.deepEqual(h.refusals, ['native-sheet']);
  assert.deepEqual([h.traces.at(-1).hidIdleSeconds, h.traces.at(-1).idleSinceStop], [1000, true]);
});

// Item 5 of the 2026-10-18 Firefox study: a selected window's stop told Claude to call select_window with the old title, which
// the benchmark refused (2 of 9 runs). The retitled window is the selected one, and its app handle addresses it.
// The wording holds whether or not the continuation runs: here a lost focus refuses it after the stop was judged a tab opening.
test('AB1: with a selected window, a tab-open stop says the window keeps its handle, not select_window', async t => {
  const target = { appId: 'org.test.editor', app: 'Fixture Editor', title: 'Marker', url: null };
  const h = await tabFixture(t, { nativeChange: 'unfocused', localTools: { tools: [SELECT_WINDOW_TOOL], target: async () => target,
    call: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, target }) }] }) } });
  h.send({ jsonrpc: '2.0', id: 50, method: 'tools/call', params: { name: 'select_window', arguments: { app: 'Fixture Editor', title: 'Marker' } } });
  for (let i = 0; i < 5; i++) await tick();
  await h.call('await cua.getApp("Fixture Editor");');
  const result = await h.call(tabCall);
  const text = result.content.map(item => item.text ?? '').join('\n');
  assert.equal(result.isError, true);
  assert.deepEqual(h.typed, []);
  assert.match(text, /Selected window changed\. This window keeps its handle; send the rest on it after reading the result\./);
  assert.match(text, /^sleight: this call ran 1 action \(pressKey "super\+t"\); not sent: typeText, pressKey "Return"\. .*this window keeps its app handle/);
  assert.doesNotMatch(text, /Call select_window with/);
});

test('AB1: with a selected window, a stop that is no tab opening keeps the select_window advice', async t => {
  const target = { appId: 'org.test.editor', app: 'Fixture Editor', title: 'Marker', url: null };
  const h = await tabFixture(t, { opened: shop.replace('Value: Marker', 'Value: Other'), localTools: { tools: [SELECT_WINDOW_TOOL], target: async () => target,
    call: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, target }) }] }) } });
  h.send({ jsonrpc: '2.0', id: 50, method: 'tools/call', params: { name: 'select_window', arguments: { app: 'Fixture Editor', title: 'Marker' } } });
  for (let i = 0; i < 5; i++) await tick();
  await h.call('await cua.getApp("Fixture Editor");');
  const result = await h.call(tabCall);
  assert.match(JSON.stringify(result), /Call select_window with/);
});

// 2026-10-18: 3 of 9 runs opened the tab with a click on the button among the tabs, which always stopped.
const clickOpens = (name, argument, text) => name === 'click' ? newTab : name === 'pressKey' && argument === 'Return' ? shop : text;
for (const click of ['click(3)', 'click({ label: "Open a new tab" })']) test(`AB1: a plain ${click} on the new-tab button types the URL in the new tab in the same call`, async t => {
  const h = await tabFixture(t, { onAction: clickOpens });
  const result = await h.call(`await app.${click}; await app.typeText("http://127.0.0.1:5420/shop"); await app.pressKey("Return"); await app.getAXState();`);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(h.typed, ['http://127.0.0.1:5420/shop']);
  assert.deepEqual(h.keys, ['Return']);
  assert.deepEqual(h.continued, ['tab']);
  assert.deepEqual(h.refusals, []);
  assert.equal(h.identityChecks(), 3, 'admission baseline, post-stop, and immediately before forwarding');
});

// A click is a tab opener only on a button beside the tabs. Here the base has a "Menu" button outside the tab strip.
const menuBase = marker.replace('\t4 combo box (settable) Address', '\t7 button Menu\n\t4 combo box (settable) Address');
const menuOpens = newTab.replace('\t5 combo box (settable) Address', '\t7 button Menu\n\t5 combo box (settable) Address');
for (const [name, base, opened, number, reason] of [
  ['a button that is not beside the tabs opened the tab', menuBase, menuOpens, 7, 'not-a-tab-button'],
  ['a second window with its own tabs', marker, newTab.replace('Value: Marker, Marker', 'Value: Other, Other'), 3, 'no-new-tab'],
]) test(`AB1: a click where ${name} stops before typing`, async t => {
  const h = await tabFixture(t, { base, onAction: (action, argument, text) => action === 'click' ? opened : text });
  const result = await h.call(`await app.click(${number}); await app.typeText("example.org"); await app.pressKey("Return");`);
  assert.equal(result.isError, true);
  assert.deepEqual(h.typed, []);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.refusals, [reason]);
});

test('AB1: a tab the remainder opens again stops before its next action', async t => {
  const h = await tabFixture(t, { onAction: (name, argument, text) => name === 'pressKey' && argument === 'super+t' ? (text === marker ? newTab : marker) : text });
  const result = await h.call('await app.pressKey("super+t"); await app.pressKey("super+t"); await app.typeText("example.org");');
  assert.equal(result.isError, true);
  assert.deepEqual(h.keys, ['super+t', 'super+t']);
  assert.deepEqual(h.typed, []);
});

test('AB1: a sheet the helper sees only at the final check stops the remainder, and the trace has the idle sample', async t => {
  const h = await tabFixture(t, { identity: (expected, native, count) => ({ ...expected, ...native, matches: 1, epoch: 'helper', window: 1,
    pid: 123, processStart: 1, ...(count === 3 ? { focus: { ...fieldFocus, sheets: 1 } } : {}) }) });
  stoppedAtTab(h, await h.call(tabCall));
  assert.equal(h.identityChecks(), 3);
  assert.deepEqual(h.refusals, ['final-check']);
  assert.deepEqual([h.traces.at(-1).hidIdleSeconds, h.traces.at(-1).idleSinceStop], [1000, true]);
});

const tabIdentity = change => async (expected, native, count) => ({ ...expected, ...native, matches: 1, epoch: 'helper', window: 1,
  pid: 123, processStart: 1, ...change(count) });
test('AB1 review: a baseline without a window number never continues', async t => {
  const h = await tabFixture(t, { identity: tabIdentity(count => count === 1 ? { windowNumber: null } : {}) });
  stoppedAtTab(h, await h.call(tabCall));
  assert.deepEqual(h.refusals, ['no-window-number']);
});

test('AB1 review: a helper that matches other than one window never continues', async t => {
  for (const matches of [0, 2]) {
    const h = await tabFixture(t, { identity: tabIdentity(count => count === 2 ? { matches } : {}) });
    stoppedAtTab(h, await h.call(tabCall));
    assert.deepEqual(h.refusals, [`identity: Input lease: window identity is ambiguous (${matches} matching windows). Unconfirmed target identity. Read the intended window again before acting. Next: await cua.getApp("org.test.editor").`]);
  }
});

test('AB1 review: reset refuses while the helper checks an active tab continuation', async t => {
  let h;
  h = await tabFixture(t, { identity: async (expected, native, count) => {
    if (count === 2) {
      h.send({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'js_reset', arguments: {} } });
      for (let i = 0; i < 5; i++) await tick();
    }
    return { ...expected, ...native, matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1 };
  } });
  const result = await h.call(tabCall);
  const reset = h.received.find(msg => msg.id === 99);
  assert.equal(reset.result.isError, true);
  assert.match(JSON.stringify(reset.result), /another call in this session is pending/);
  assert.equal(h.sent.some(msg => msg.params?.name === 'js_reset'), false);
  assert.equal(result.isError, false);
  assert.deepEqual(h.keys, ['super+t', 'Return']);
  assert.deepEqual(h.typed, ['http://127.0.0.1:5420/shop']);
  assert.equal(h.sent.filter(msg => msg.params?.name === 'js').length, 2, 'the original call and its checked remainder');
  assert.deepEqual(h.refusals, []);
});

// The remainder's numbers come from the tree Claude read before the call; the guard checks them against the new tab's.
test('AB1 review: a numbered click in the remainder after a tab continuation stops as stale', async t => {
  const h = await tabFixture(t);
  const result = await h.call('await app.pressKey("super+t"); await app.click(5);');
  assert.equal(result.isError, true);
  assert.deepEqual(h.clicks, []);
  assert.match(JSON.stringify(result), /element 5 changed since you read the window/);
});

// CC7, LB4 (race-1017): Safari's Cmd+T, replayed. Safari hides its tab strip for one tab and marks tabs Value: on or off; the
// new tab is its native Start Page (no page content), focus in the address field. menuRemainder's navigation branch claimed it
// and then refused on HID idle over the whole call, which the engine's own Cmd+T breaks: 36 of 36 Codex runs stopped, 7 of 7
// Claude Code ones. The fake clock puts the engine's press inside the call, as the real one is.
const sfTabLine = (title, active) => `tab ${title}${active ? ', Help: To interact with the items in this button, press Control-Option-Shift-Down Arrow.' : ''}, ` +
  `Value: ${active ? 'on' : 'off'}, Secondary Actions: close tab, ID: TabBarTab?isActive=${active}`;
const sfWindow = (title, { page, tabs = [], focus, header = title, root = title } = {}) => `Window: "bench — ${header}", App: Fixture Editor.\n` +
  `0 standard window bench — ${root}, ID: SafariWindow?UUID=85C2, Secondary Actions: Raise\n\t1 split group\n\t\t2 tab group\n\t\t\t3 scroll area\n` +
  (page ? `\t\t\t\t4 HTML content Description: ${page}, URL: 127.0.0.1:5413/${page.toLowerCase()}\n` : '\t\t\t\t4 collection StartPageCollectionView\n') +
  '\t5 toolbar\n\t\t6 text field (settable) Description: smart search field, ID: WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD\n\t\t7 button Description: New Tab, ID: NewTabButton\n' +
  (tabs.length ? `\t8 tab group Description: Tab bar, ${tabs.length} tabs, ID: TabBar\n` + tabs.map(([name, active], i) => `\t\t${9 + i} ${sfTabLine(name, active)}`).join('\n') + '\n' : '') +
  `\nThe focused UI element is ${focus ?? (page ? `4 HTML content Description: ${page}` : '6 text field (settable) Description: smart search field, ID: WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD')}`;
const sfGate = sfWindow('Gate', { page: 'Gate' });
const sfStart = sfWindow('Start Page', { tabs: [['Gate', false], ['Start Page', true]] });
const sfShop = sfWindow('Shop', { page: 'Shop', tabs: [['Gate', false], ['Shop', true]] });
// The engine's header already names the page while its tree is still the Start Page (LB6).
const sfLag = sfWindow('Start Page', { header: 'Shop', tabs: [['Gate', false], ['Start Page', true]] });
const sfCall = 'await app.pressKey("super+t");\nawait app.typeText("http://127.0.0.1:5413/shop");\nawait app.pressKey("Return");\nawait app.getAXState();';
async function safariTab(t, { opened = sfStart, landed = sfShop, user, ...options } = {}) {
  let now = 1000, enginePress, userPress;
  return tabFixture(t, { base: sfGate, focus: { ...fieldFocus, role: 'AXTextField' }, clock: () => now, tabLandingIntervalMs: 2,
    onAction: (name, argument, text) => {
      if (name === 'pressKey' && argument === 'super+t') { now += 300; enginePress = now; now += 400; return opened; }
      return name === 'pressKey' && argument === 'Return' ? landed : text;
    },
    identity: (expected, native, count) => {
      if (count === user) { now += 300; userPress = now - 100; }
      return { ...expected, ...native, matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1,
        hidIdleSeconds: (now - (userPress ?? enginePress ?? 0)) / 1000 };
    }, ...options });
}

test('LB4: Safari\'s Cmd+T, URL and Return run in one call, on the tab path', async t => {
  const h = await safariTab(t);
  const result = await h.call(sfCall);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(h.keys, ['super+t', 'Return']);
  assert.deepEqual(h.typed, ['http://127.0.0.1:5413/shop']);
  assert.deepEqual(h.continued, ['tab']);
  assert.deepEqual(h.refusals, []);
  const all = result.content.map(item => item.text).join('\n');
  assert.match(result.content[0].text, /^sleight: all 3 actions ran: pressKey "super\+t" opened a tab, then typeText, pressKey "Return"/);
  assert.match(all, /^Window: "bench — Shop"/m);
  assert.doesNotMatch(all, /Input lease stopped|guard-stop/);
});

test('LB4: SLEIGHT_TABC=0 replays the race: the navigation branch claims the Start Page and the call stops after Cmd+T', async t => {
  const h = await safariTab(t, { tabFirst: false });
  stoppedAtTab(h, await h.call(sfCall));
  assert.ok(!h.continued.includes('tab'));
  assert.deepEqual(h.refusals, ['other-continuation']);
});

for (const [name, options, reason, tabReason] of [
  // The user starts typing a URL in the window after the stop: their keys could interleave with the rest's.
  ['a user typing a URL after the stop', { user: 2 }, 'hid-input'],
  // The user typed a URL into the other tab during the call: that tab is selected and retitled, no tab was added.
  ['a user typing a URL into another tab', { opened: sfWindow('Mail', { page: 'Mail' }).replace('Gate', 'Mail') }, 'no-new-tab'],
  // A page that retitles itself: still one tab and no strip, its page still there (and the navigation branch refuses a page).
  ['a page that retitles itself', { opened: sfWindow('Gate (2)', { page: 'Gate' }) }, 'no-new-tab'],
  // The navigation branch then takes the stop and its own checks refuse it; the trace keeps the tab path's reason.
  ['focus left in the Start Page', { opened: sfWindow('Start Page', { tabs: [['Gate', false], ['Start Page', true]], focus: '4 collection StartPageCollectionView' }) }, 'other-continuation', 'focus-not-app-field'],
  ['a password field in focus', { focus: { ...fieldFocus, role: 'AXTextField', subrole: 'AXSecureTextField' } }, 'secure-field'],
]) test(`LB4: Safari's Cmd+T stays a stop on ${name}`, async t => {
  const h = await safariTab(t, options);
  stoppedAtTab(h, await h.call(sfCall));
  assert.ok(!h.continued.includes('tab'));
  assert.deepEqual(h.refusals, [reason]);
  if (tabReason) assert.equal(h.traces.find(trace => trace.reason === 'other-continuation').tab, tabReason);
});

// Another Safari window raised during the call, with a tab named as the leased window and its own address field focused,
// passes the tree checks; the helper's window number pins the window the call started in.
test('LB4: another window raised during the call stays a stop at the native check', async t => {
  const h = await safariTab(t, { nativeChange: 'window' });
  stoppedAtTab(h, await h.call(sfCall));
  assert.deepEqual(h.continued, []);
  assert.match(h.refusals[0], /^identity: Input lease: the selected window number changed/);
});

// LB6: the rest's Return result names the page in its header over the Start Page's tree; the relay reads again and delivers
// the page. Firefox mdn inside Codex (2 of 37) spent a 3.3 s turn reading it itself.
test('LB6: after the rest\'s Return, a tree still on the new tab is read again until it shows the page', async t => {
  const reads = [sfLag, sfShop];
  const h = await safariTab(t, { landed: sfLag, landingRead: () => reads.shift() ?? sfShop });
  const result = await h.call(sfCall);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const all = result.content.map(item => item.text).join('\n');
  assert.match(all, /^0 standard window bench — Shop,/m);
  assert.doesNotMatch(all, /StartPageCollectionView|standard window bench — Start Page/);
  assert.equal(h.sent.filter(msg => String(msg.id).startsWith('sleight-tab-landing-')).length, 2);
  assert.ok(h.sent.every(msg => !String(msg.id).startsWith('sleight-tab-landing-') || /^await app\.getAXState\(\{ disableDiffing: true \}\)$/.test(msg.params.arguments.code)));
});

// The same on the Firefox shape of firefox-codex-sleight-sol-b16-r2/mdn: "Window: <page>" over "0 standard window New Tab".
test('LB6: Firefox\'s continued Return delivers the page, not the New Tab tree under the page\'s header', async t => {
  const lagged = newTab.replace('Window: "New Tab"', 'Window: "Shop"');
  const h = await tabFixture(t, { tabLandingIntervalMs: 2, landingRead: () => shop,
    onAction: (name, argument, text) => name === 'pressKey' && argument === 'super+t' ? newTab : name === 'pressKey' && argument === 'Return' ? lagged : text });
  const result = await h.call(tabCall);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const all = result.content.map(item => item.text).join('\n');
  assert.match(all, /^0 standard window Shop,/m);
  assert.doesNotMatch(all, /standard window New Tab|Value: New Tab/);
  assert.equal(h.sent.filter(msg => String(msg.id).startsWith('sleight-tab-landing-')).length, 1);
});

test('LB6: a tree that never lands is delivered as last read once the cap passes', async t => {
  const h = await safariTab(t, { landed: sfLag, landingRead: () => sfLag, tabLandingMs: 50, tabLandingIntervalMs: 10 });
  const result = await h.call(sfCall);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(h.sent.filter(msg => String(msg.id).startsWith('sleight-tab-landing-')).length, 5, 'one read per interval within the cap, with a clock that stands still');
  assert.match(result.content.map(item => item.text).join('\n'), /^Window: "bench — Shop"/m);
});

// The landing read is the app's front window, not pinned. A read that shows another window (one the user raised during the
// wait) never stands in for the call's result, so the lease can't move to it.
test('LB6: a landing read that shows another window keeps the call\'s own result', async t => {
  const mail = sfWindow('Mail', { page: 'Mail', tabs: [['Mail', true]] });
  const h = await safariTab(t, { landed: sfLag, landingRead: () => mail });
  const result = await h.call(sfCall);
  const all = result.content.map(item => item.text).join('\n');
  assert.doesNotMatch(all, /bench — Mail|Description: Mail/);
  assert.match(all, /^Window: "bench — Shop"/m);
  assert.equal(h.sent.filter(msg => String(msg.id).startsWith('sleight-tab-landing-')).length, 1, 'no second read after another window');
});

for (const [name, options, code = sfCall] of [
  ['a tree that already landed', {}],
  ['SLEIGHT_TABC=0', { tabFirst: false, landed: sfLag, opened: sfStart }],
  ['a rest that ends without Return', { landed: sfLag, onAction: undefined }, 'await app.pressKey("super+t");\nawait app.typeText("http://127.0.0.1:5413/shop");\nawait app.pressKey("Tab");'],
]) test(`LB6: no extra read on ${name}`, async t => {
  const h = await safariTab(t, options);
  await h.call(code);
  assert.equal(h.sent.filter(msg => String(msg.id).startsWith('sleight-tab-landing-')).length, 0);
});

// OT2 (SLEIGHT_POPOVER_CONTINUATION): a popover root covers the window under it like the palette path's plain window and
// floating window; =0 records only dialogs and sheets. An untitled palette can't be shown gone (the helper skips windows
// without a title), so its button close stops.
const closeButton = 'await app.click({ id: "close" }); await app.pressKey("super+End");';
for (const [name, root, title, { open = false, ...options }, continues, reason, code = closeButton] of [
  ['a popover its own button closed continues', 'popover', 'Format', {}, true],
  ['Escape on a popover continues', 'popover', 'Format', {}, true, undefined, 'await app.pressKey("Escape"); await app.pressKey("super+End");'],
  ['a popover with the flag off stops', 'popover', 'Format', { popoverContinuation: false }, false, 'no-covered-window'],
  ['a floating window with the flag off continues, as before', 'floating window', 'Format', { popoverContinuation: false }, true],
  ['an untitled window with the flag off continues, as before', 'window', '', { popoverContinuation: false }, true],
  ['an untitled popover its button closed stops', 'popover', '', {}, false, 'palette-untitled'],
  ['a popover still open after its button stops', 'popover', 'Format', { open: true }, false, 'palette-still-open'],
]) test(`OT2: ${name}`, async t => {
  const popover = `Window: ${JSON.stringify(title)}, App: Fixture Editor.\n0 ${root} ${title}\n\t1 button Bold, ID: bold\n\t2 button Close, ID: close`;
  let clicked = false;
  const events = [];
  const h = await fixture(t, { base: page, ...options,
    onAction: (action, argument, text) => text === page && argument === 2 ? popover : text === popover ? (clicked = true, page) : text,
    identity: (expected, native) => expected.title !== title || expected.url || !clicked ? dialogIdentity(expected, native)
      : open ? { status: 'ok', matches: 1, headerMatches: 1 } : { status: 'ok', matches: 0, headerMatches: 0 },
    trace: (direction, msg) => { if (direction === 'dialog-continuation-refused') events.push(msg.reason); } });
  assert.match(JSON.stringify(await h.call('await app.click({ label: "Replace All" });')), new RegExp(`0 ${root}`));
  const result = await h.call(code);
  assert.equal(result.isError === true, !continues, JSON.stringify(result).slice(0, 400));
  assert.deepEqual(h.keys.filter(key => key === 'super+End'), continues ? ['super+End'] : []);
  if (reason) assert.ok(events.includes(reason), JSON.stringify(events));
});

// OT2 (SLEIGHT_PARENT_LEASE): Insert Table and Word's alert (2026-10-17 office runs, 7 stale-lease refusals). The call's
// own OK closed the dialog, its result showed the document under a second header without a URL (a filtered write),
// so the lease dropped; the next call's recovery re-acquisition showed the document and stopped as stale.
const parentOf = (expected, native, extra = {}) => ({ ...dialogIdentity(expected, native), windowSubrole: 'AXStandardWindow',
  ...extra, focus: { sheets: 0, role: null, subrole: null, inWindow: false, inPage: false, ...extra.focus } });
// Insert Table has a title, so the helper can show it gone; Word's untitled alert can't be (untitled-cover).
const insertTable = 'Window: "Insert Table", App: Fixture Editor.\n0 dialog Insert Table\n\t1 text All done. We made 1 replacement.\n\t2 button OK, ID: ok';
async function parentFixture(t, { parent = {}, gone = true, reply, cover = insertTable, ...options } = {}) {
  const state = { closed: false };
  const events = [];
  const coverTitle = /^Window: "([^"]*)"/.exec(cover)[1];
  let h;
  h = await fixture(t, { base: page, after: cover, afterItem: page, ...options,
    identity: (expected, native) => !state.closed ? dialogIdentity(expected, native)
      : expected.title === coverTitle ? (typeof gone === 'function' ? gone(expected, native)
        : gone ? { status: 'ok', matches: 0, headerMatches: 0 } : dialogIdentity(expected, native))
      : typeof parent === 'function' ? parent(expected, native, h) : parentOf(expected, native, parent),
    trace: (direction, msg) => { if (/^parent-lease/.test(direction)) events.push(direction === 'parent-lease' ? 'accepted' : msg.reason); } });
  assert.match(JSON.stringify(await h.call('await app.click({ label: "Replace All" });')), /All done/);
  const closed = await h.call('await app.click({ id: "ok" }); nodeRepl.write(\'Window: "report.txt", App: Fixture Editor.\\n\');');
  assert.match(JSON.stringify(closed), /0 standard window report\.txt/);
  state.closed = true;
  if (reply) h.setText(reply);
  return Object.assign(h, { events });
}
const nextCall = 'await app.pressKey("super+End");';

test('OT2: the next call after OK closed Insert Table leases the document it covered and runs', async t => {
  const h = await parentFixture(t);
  const result = await h.call(nextCall);
  assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 600));
  assert.deepEqual(h.keys, ['super+End']);
  assert.deepEqual(h.events, ['accepted']);
  assert.doesNotMatch(JSON.stringify(result), /nothing from this call ran/);
});

test('OT2: the parent lease pins the native window for that call only', async t => {
  let epoch = 'helper';
  const h = await parentFixture(t, { parent: (expected, native) => parentOf(expected, native, { epoch }) });
  assert.notEqual((await h.call(nextCall)).isError, true);
  // A new helper epoch (it quits after about 20 s idle) refuses a pinned identity; the next call's keys still go.
  epoch = 'helper-2';
  const later = await h.call('await app.pressKey("Return");');
  assert.notEqual(later.isError, true, JSON.stringify(later).slice(0, 400));
  assert.deepEqual(h.keys, ['super+End', 'Return']);
});

test('OT2: the pinned native window must still match when the rest is admitted', async t => {
  // The real helper narrows by the pinned number and answers mismatch once that window is gone.
  const pinned = [];
  const h = await parentFixture(t, { parent: (expected, native) => {
    if (expected.nativeIdentity) { pinned.push(expected.nativeIdentity.windowNumber); return { status: 'mismatch', error: 'Known window number disappeared' }; }
    return parentOf(expected, native);
  } });
  const result = await h.call(nextCall);
  assert.equal(result.isError, true);
  assert.deepEqual(h.keys, []);
  assert.deepEqual(h.events, ['accepted']);
  assert.deepEqual(pinned, [22], 'the admission asked for the window number the parent check observed');
});

// Review A: the pinned admission fails closed. Unpinned, an unavailable or ambiguous identity drops the requirement.
for (const [name, answer] of [
  ['unavailable', { status: 'unknown', error: 'probe unavailable' }],
  ['ambiguous', { status: 'ok', matches: 2, headerMatches: 2, epoch: 'helper', window: 0, pid: 123, processStart: 1 }],
]) test(`OT2: an ${name} identity at the pinned admission stops`, async t => {
  const h = await parentFixture(t, { parent: (expected, native) => expected.nativeIdentity ? answer : parentOf(expected, native) });
  const result = await h.call(nextCall);
  assert.equal(result.isError, true);
  assert.deepEqual(h.keys, []);
  assert.deepEqual(h.events, ['accepted']);
});

// Re-review 1: a text write split from the pinned call (its head goes out as an internal call) is held to the pin too.
const pageWithBody = page.replace('1 text area (settable) Value: draft', '1 text area (settable) Value: draft, ID: body');
for (const [name, answer] of [
  ['unavailable', { status: 'unknown', error: 'probe unavailable' }],
  ['ambiguous', { status: 'ok', matches: 2, headerMatches: 2, epoch: 'helper', window: 0, pid: 123, processStart: 1 }],
]) test(`OT2: an ${name} identity stops a text write and save split from the parent-leased call before the write`, async t => {
  const settled = [];
  const h = await parentFixture(t, { base: pageWithBody, afterItem: pageWithBody, settleTextWrite: async target => { settled.push(target); },
    parent: (expected, native) => expected.nativeIdentity ? answer : parentOf(expected, native) });
  const result = await h.call('await app.setValue({ id: "body" }, "x"); await app.pressKey("super+s");');
  assert.equal(result.isError, true);
  assert.deepEqual(h.values, []);
  assert.deepEqual(h.keys, []);
  assert.deepEqual(settled, []);
  assert.deepEqual(h.events, ['accepted']);
});
test('OT2: with the pin satisfied, the split text write and save go on', async t => {
  const settled = [];
  const h = await parentFixture(t, { base: pageWithBody, afterItem: pageWithBody, settleTextWrite: async target => { settled.push(target); } });
  const result = await h.call('await app.setValue({ id: "body" }, "x"); await app.pressKey("super+s");');
  assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 400));
  assert.deepEqual(h.values, [[1, 'x']]);
  assert.deepEqual(h.keys, ['super+s']);
  assert.equal(settled.length, 1);
});

// Review C: labels and IDs resolve in the window the guard reads, so they go on.
test('OT2: a labelled click in the rest goes on after the parent lease', async t => {
  const h = await parentFixture(t);
  const clicks = h.clicks.length;
  const result = await h.call('await app.click({ label: "Replace All" });');
  assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 400));
  assert.equal(h.clicks.length, clicks + 1);
  assert.deepEqual(h.events, ['accepted']);
});

// Review D: a call that stops before any result is observed still ends its pin.
test('OT2: the pin ends with its call when the rest stops at admission', async t => {
  let epoch = 'helper', refuse = true;
  const h = await parentFixture(t, { parent: (expected, native) => expected.nativeIdentity && refuse
    ? { status: 'mismatch', error: 'Known window number disappeared' } : parentOf(expected, native, { epoch }) });
  assert.equal((await h.call(nextCall)).isError, true);
  refuse = false; epoch = 'helper-2';
  const later = await h.call('await app.pressKey("Return");');
  assert.notEqual(later.isError, true, JSON.stringify(later).slice(0, 400));
  assert.deepEqual(h.keys, ['Return']);
});

// Review F: the lease moving while the helper looks (a read in between) refuses.
test('OT2: a lease that moved during the parent check refuses', async t => {
  let sent = false;
  const h = await parentFixture(t, { parent: async (expected, native, fixture) => {
    if (!sent && !expected.nativeIdentity) {
      sent = true;
      fixture.send({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'js', arguments: { code: 'let s = await app.getAXState(); s' } } });
      for (let i = 0; i < 20; i++) await tick();
    }
    return parentOf(expected, native);
  } });
  const result = await h.call(nextCall);
  assert.equal(result.isError, true);
  assert.deepEqual(h.keys, []);
  assert.deepEqual(h.events, ['lease-moved']);
});

for (const [name, options, reason, code = nextCall] of [
  ['the flag off', { parentLease: false }, undefined],
  ['user input since the document was seen', { parent: { hidIdleSeconds: 0 } }, 'hid-input'],
  ['another window with the same title and URL', { parent: { headerMatches: 2 } }, 'header-matches-2'],
  ['a new process', { parent: { pid: 456 } }, 'covered-process-changed'],
  ['the dialog still present natively', { gone: false }, 'dialog-still-open'],
  ['a sheet in the returned tree', { reply: page + '\n\t5 sheet Confirm' }, 'dialog-present'],
  ['a sheet on the window natively', { parent: { focus: { sheets: 1 } } }, 'native-sheet'],
  ['a different window focused', { parent: () => ({ status: 'mismatch', error: 'Focused window differs' }) }, 'identity-mismatch'],
  ['a window that is not standard natively', { parent: { windowSubrole: 'AXFloatingWindow' } }, 'not-standard-native'],
  ['no native answer', { parent: () => ({ status: 'unknown', error: 'probe unavailable' }) }, 'identity-unavailable'],
  ['another document in front', { reply: page.replaceAll('report.txt', 'other.txt') }, 'not-the-covered-window'],
  // Review B: the helper skips untitled windows, so an untitled alert would always look gone.
  ['an untitled alert it covered', { cover: alert }, 'untitled-cover'],
  // Review C: a literal number may be the dialog's.
  ['an element number in the rest', {}, 'element-numbers', 'await app.click(2);'],
  // Review F.
  ['a missing HID idle time', { parent: { hidIdleSeconds: undefined } }, 'hid-input'],
  ['a non-finite HID idle time', { parent: { hidIdleSeconds: Number.NaN } }, 'hid-input'],
  ['a helper that never answers the dialog check', { menuContinuationTimeoutMs: 30, gone: () => new Promise(() => {}) }, 'dialog-still-open'],
  ['a helper that never answers the window check', { menuContinuationTimeoutMs: 30, parent: () => new Promise(() => {}) }, 'identity-unavailable'],
]) test(`OT2: the parent lease refuses ${name}`, async t => {
  const h = await parentFixture(t, options);
  const clicks = h.clicks.length;
  const result = await h.call(code);
  assert.equal(h.clicks.length, clicks);
  assert.equal(result.isError, true);
  assert.deepEqual(h.keys, []);
  assert.match(JSON.stringify(result), /nothing from this call ran/);
  assert.deepEqual(h.events, reason ? [reason] : []);
});

// SL4 (2026-10-18 Firefox runs, 7 stale-window refusals): a result with two trees, the acquisition's and the call's own
// read, left the relay's record on the first tree's title, and the next call was refused for a title Claude had seen.
// The runs sent `app = await cua.getApp(...)` with no `let`, so the relay did not split the acquisition and recovered
// the window it last confirmed.
const storePage = title => `Window: ${JSON.stringify(title)}, App: Fixture Editor.\n0 standard window ${title}\n\t1 button Other`;
const followUp = 'await app.click("Other");';
const echo = 'Window: "Shop", App: Fixture Editor.\n';
const twin = [{ title: 'Shop' }, { title: 'Shop' }];
const identityFor = number => (expected, native) => ({ ...expected, ...native, windowNumber: expected.title === 'Product' ? number : native.windowNumber,
  matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1 });
// The first call's result shows Shop and then Product (the page loaded between the acquisition and the end of the
// call; the fixture prints the page as it stands last); `tail` is anything written between the two trees.
async function shown(t, { page = 'Product', tail = '', ...options } = {}) {
  const h = await fixture(t, { base: storePage('Shop'), ...options });
  h.setText(storePage(page));
  const first = await h.call(`app = await cua.getApp("Fixture Editor"); nodeRepl.write(${JSON.stringify(storePage('Shop') + tail)});`);
  return { h, first };
}

test('SL4: a result that ends on a second tree records that tree, and the next call on it runs', async t => {
  const { h, first } = await shown(t);
  const headers = first.content.map(item => item.text).join('\n').match(/^Window: .*$/gm);
  assert.equal(headers[0], 'Window: "Shop", App: Fixture Editor.');
  assert.equal(headers.at(-1), 'Window: "Product", App: Fixture Editor.');
  const result = await h.call(followUp);
  assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 500));
  assert.equal(h.clicks.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /nothing from this call ran/);
});

test('SL4: a window title Claude has not been shown still stops', async t => {
  const { h } = await shown(t);
  h.setText(storePage('Checkout'));
  const result = await h.call(followUp);
  assert.equal(result.isError, true);
  assert.equal(h.clicks.length, 0);
});

test('SL4: a result with a dialog among its trees leaves the window unknown, and the title change still refuses', async t => {
  const dialog = 'Window: "Insert", App: Fixture Editor.\n0 dialog Insert\n\t1 button OK';
  const { h } = await shown(t, { tail: '\n' + dialog });
  const result = await h.call(followUp);
  assert.equal(result.isError, true);
  assert.equal(h.clicks.length, 0);
  assert.match(JSON.stringify(result), /nothing from this call ran/);
});

// A title change under one native window number: the result's trees can't be read as one window (a header without a
// root in between), so the relay keeps the first title, and the next call shows a title that result displayed.
const retitles = events => direction => { if (/^retitle/.test(direction)) events.push(direction); };

test('SL4: a title change under the same window number runs when the previous result showed the new title', async t => {
  const events = [];
  const { h } = await shown(t, { windows: twin, identity: identityFor(22), tail: '\n' + echo, trace: retitles(events) });
  const result = await h.call(followUp);
  assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 500));
  assert.equal(h.clicks.length, 1);
  assert.deepEqual(events, ['retitle-accepted']);
});

test('SL4: a title change under another window number still refuses', async t => {
  const events = [];
  const { h } = await shown(t, { windows: twin, identity: identityFor(23), tail: '\n' + echo, trace: retitles(events) });
  const result = await h.call(followUp);
  assert.equal(result.isError, true);
  assert.equal(h.clicks.length, 0);
  assert.match(JSON.stringify(result), /nothing from this call ran/);
  assert.deepEqual(events, ['retitle-refused']);
});

test('SL4: a title change never shown refuses even under the same window number', async t => {
  const events = [];
  const { h } = await shown(t, { windows: twin, identity: identityFor(22), tail: '\n' + echo, trace: retitles(events) });
  h.setText(storePage('Checkout'));
  const result = await h.call(followUp);
  assert.equal(result.isError, true);
  assert.equal(h.clicks.length, 0);
  assert.match(JSON.stringify(result), /nothing from this call ran/);
  assert.deepEqual(events, []);
});

test('SL4: a title change with no known window number refuses', async t => {
  const events = [];
  const { h } = await shown(t, { tail: '\n' + echo, trace: retitles(events) });
  const result = await h.call(followUp);
  assert.equal(result.isError, true);
  assert.equal(h.clicks.length, 0);
  assert.deepEqual(events, []);
});

// S2/wikipedia:38: the page retitled after the last result, and a call that only filters and prints the tree was refused.
const filteredRead = 'const s = await app.getAXState(); nodeRepl.write(s.split("\\n").filter(l => l.includes("button")).join("\\n"));';

test('SL4: a read that only filters and prints runs on the window its acquisition showed', async t => {
  const events = [];
  const { h } = await shown(t, { tail: '\n' + echo, trace: (direction) => { if (direction === 'filtered-read-stale-window') events.push(direction); } });
  const result = await h.call(filteredRead);
  assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 500));
  assert.doesNotMatch(JSON.stringify(result), /nothing from this call ran/);
  assert.match(JSON.stringify(result), /button Other/);
  assert.deepEqual(events, ['filtered-read-stale-window']);
});

test('SL4: a filtered read that also clicks is still refused after the page retitled', async t => {
  const { h } = await shown(t, { tail: '\n' + echo });
  const result = await h.call(filteredRead.replace('nodeRepl.write', 'await app.click("Other"); nodeRepl.write'));
  assert.equal(result.isError, true);
  assert.equal(h.clicks.length, 0);
  assert.match(JSON.stringify(result), /nothing from this call ran/);
});

// WB1 (SLEIGHT_WB1=1): the call's own label click opened a gallery window titled like that label (Word's Styles button,
// 03-17-17 #3 call 5, 2026-10-18), and the gallery pick after it ran in the same call. Native truth: the gallery is the app's
// focused window, number 31, in the leased window's process.
const galleryDoc = document.replace('\t3 button Other', '\t3 button Other\n\t5 menu button Styles, Value: 0');
const gallery = 'Window: "Styles", App: Fixture Editor.\n0 window Styles, Secondary Actions: Raise\n\t1 container Styles\n\t\t6 button Description: Heading 1, Help: Heading 1, Value: 0, ID: gallery-heading-1';
const galleryIdentity = (change = {}) => async (expected, native) => expected.title === 'Styles'
  ? { ...expected, ...native, windowNumber: 31, matches: 1, headerMatches: 1, epoch: 'helper', window: 2, pid: 123, processStart: 1, ...change }
  : { ...expected, ...native, matches: 1, headerMatches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1 };
const galleryPick = 'await app.click({ label: "Styles" }); await app.click({ id: "gallery-heading-1" });';

test('WB1: a gallery the call\'s own click opened takes the rest of the call', async t => {
  const events = [];
  const h = await fixture(t, { base: galleryDoc, after: gallery, afterItem: galleryDoc, identity: galleryIdentity(), routeSteering: true,
    trace: (direction, msg) => { if (/continuation/.test(direction)) events.push(direction + ':' + (msg?.kind ?? msg?.reason)); } });
  const result = await h.call(galleryPick);
  assert.notEqual(result.isError, true, JSON.stringify(result).slice(0, 600));
  assert.deepEqual(h.clicks, [5, 6]);
  assert.equal(h.received.length, 1);
  assert.match(JSON.stringify(result), /opened a panel, then click id \\"gallery-heading-1\\" in \\"Styles\\"/);
  assert.doesNotMatch(JSON.stringify(result), /sleight:guard-stop|window or URL changed/);
  assert.ok(events.includes('menu-continuation:palette'), events.join(' '));
});

for (const [name, options] of [
  ['the flag off', { routeSteering: false }],
  ['user input since the call', { identity: galleryIdentity({ hidIdleSeconds: 0 }) }],
  ['the gallery reported as the leased window', { identity: galleryIdentity({ windowNumber: 22 }) }],
  ['another process', { identity: galleryIdentity({ pid: 999 }) }],
  ['two windows with that title', { identity: galleryIdentity({ headerMatches: 2 }) }],
  ['a gallery that is not the focused window', { identity: galleryIdentity({ status: 'mismatch', error: 'Focused window differs' }) }],
  ['a gallery titled otherwise', { after: gallery.replaceAll('Styles', 'Format') }],
  ['a gallery with a document area', { after: gallery + '\n\t\t7 text area (settable) Value: draft' }],
  ['careful mode', { guardMode: 'careful' }],
  // Review F1: a dialog subrole, a secure field in the opened window, or typing after the click.
  ['a native dialog subrole', { identity: galleryIdentity({ windowSubrole: 'AXDialog' }) }],
  ['a window with a secure field', { after: gallery + '\n\t\t7 secure text field (settable) Description: Password' }],
]) test(`WB1: the gallery continuation stops on ${name}`, async t => {
  const h = await fixture(t, { base: galleryDoc, after: gallery, afterItem: galleryDoc, identity: galleryIdentity(), routeSteering: true, ...options });
  const result = await h.call(galleryPick);
  assert.equal(result.isError, true);
  assert.deepEqual(h.clicks, [5]);
  assert.doesNotMatch(JSON.stringify(result), /sleight:guard-stop:/);
});

test('WB1 F1: typing after the click that opened the window stops there', async t => {
  const h = await fixture(t, { base: galleryDoc, after: gallery, afterItem: galleryDoc, identity: galleryIdentity(), routeSteering: true });
  const result = await h.call('await app.click({ label: "Styles" }); await app.typeText("secret");');
  assert.equal(result.isError, true);
  assert.deepEqual(h.clicks, [5]);
  assert.deepEqual(h.typed, []);
});

// The relay hands both flags to its read compactor: a changed Undo item (WB2) and a clicked field the typing missed (WB1).
const undoDoc = document.replace('\t3 button Other', "\t3 button Other\n\t7 menu button (disabled) Can't Undo\n\t8 combo box (settable) Description: Search Document");
for (const on of [true, false]) test(`WB2 and WB1 notes reach the result through the relay only when on (${on})`, async t => {
  const styled = await fixture(t, { base: undoDoc, after: undoDoc.replace("(disabled) Can't Undo", 'Undo Style'), undoReceipts: on });
  const undone = JSON.stringify(await styled.call('await app.pressKey("super+alt+1");'));
  assert.equal(/the Undo item changed from \\"Can't Undo\\" to \\"Undo Style\\"/.test(undone), on, undone.slice(0, 800));
  const typed = await fixture(t, { base: undoDoc, after: undoDoc, routeSteering: on });
  const missed = JSON.stringify(await typed.call('await app.click(8); await app.typeText("amber");'));
  assert.deepEqual(typed.typed, ['amber']);
  assert.equal(/the text typed after clicking element 8 \(Search Document\) isn't in that field/.test(missed), on, missed.slice(0, 800));
});

test('WB1: a plain menu still continues as a menu with the flag on', async t => {
  const events = [];
  const h = await fixture(t, { routeSteering: true, trace: (direction, msg) => { if (direction === 'menu-continuation') events.push(msg.kind); } });
  const result = await h.call('await app.click("File"); await app.click("Save");');
  assert.notEqual(result.isError, true);
  assert.deepEqual(h.clicks, [2, 4]);
  assert.deepEqual(events, ['menu']);
});

test('CK3: the admitted tab remainder probes while the original tab-tree and final identity checks stay in place', async t => {
  let reads = 0;
  const h = await tabFixture(t, { ck3: true, onRead: () => { reads++; }, identity: (expected, native) => ({ ...expected, ...native,
    matches: 1, headerMatches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1, windowSubrole: 'AXStandardWindow',
    ...(expected.focus ? { chrome: ckChrome(true) } : {}) }) });
  reads = 0;
  const result = await h.call(tabCall);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(h.keys, ['super+t', 'Return']);
  assert.deepEqual(h.typed, ['http://127.0.0.1:5420/shop']);
  assert.deepEqual(h.continued, ['tab']);
  assert.ok(h.identityChecks() >= 5, 'admission, tab check, final boundary and two fresh action probes');
  assert.equal(reads, 2, 'the original stop tree and final read remain, neither remainder action reads');
  const decisions = h.traces.filter(trace => trace.direction === 'tab-probe');
  assert.equal(decisions.length, 2);
  for (const decision of decisions) {
    assert.equal(decision.decision, 'probe');
    assert.equal(decision.channel, 'read-fifo');
    assert.equal(decision.failureStep, null);
    assert.equal(decision.errno, null);
    assert.equal(decision.syscall, null);
    assert.ok(Number.isFinite(decision.sampleMs));
  }
});

const ckChrome = added => ({ complete: true, group: 8, children: added ? [10, 11] : [10], childCount: added ? 2 : 1,
  tabCount: added ? 2 : 1, tabs: added ? [{ ref: 10, selected: false }, { ref: 11, selected: true }] : [{ ref: 10, selected: true }],
  addressField: 20, focused: 20 });

test('CK3: the real relay certifies Cmd+T before its first changed-window read', async t => {
  let opened = false, reads = 0;
  const h = await tabFixture(t, { ck3: true, onRead: () => { reads++; },
    onAction: (name, arg, text) => { if (name === 'pressKey' && arg === 'super+t') opened = true; return tabScript()(name, arg, text); },
    identity: (expected, native) => ({ ...expected, ...native, title: opened ? 'New Tab' : 'Marker', url: null,
      matches: 1, headerMatches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1,
      windowSubrole: 'AXStandardWindow', focus: fieldFocus, chrome: ckChrome(opened) }) });
  reads = 0;
  const result = await h.call(tabCall);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(h.keys, ['super+t', 'Return']);
  assert.deepEqual(h.typed, ['http://127.0.0.1:5420/shop']);
  assert.deepEqual(h.continued, [], 'no stopped engine call needs a continuation');
  assert.equal(h.sent.length, 1);
  assert.equal(reads, 1, 'the final engine read remains');
});

test('CK3: a certified chain still performs the existing landing read on a lagging page tree', async t => {
  let opened = false;
  const lagged = newTab.replace('Window: "New Tab"', 'Window: "Shop"');
  const h = await tabFixture(t, { ck3: true, tabLandingIntervalMs: 2, landingRead: () => shop,
    onAction: (name, arg, text) => {
      if (name === 'pressKey' && arg === 'super+t') opened = true;
      return name === 'pressKey' && arg === 'Return' ? lagged : tabScript()(name, arg, text);
    }, identity: (expected, native) => ({ ...expected, ...native, title: opened ? 'New Tab' : 'Marker', url: null,
      matches: 1, headerMatches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1,
      windowSubrole: 'AXStandardWindow', focus: fieldFocus, chrome: ckChrome(opened) }) });
  const result = await h.call(tabCall);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(h.sent.filter(r => String(r.id).startsWith('sleight-tab-landing-')).length, 1);
  assert.match(JSON.stringify(result), /standard window Shop/);
});
