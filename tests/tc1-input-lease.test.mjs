import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, runInContext, constants } from 'node:vm';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { SELECT_WINDOW_TOOL } from '../plugins/sleight/lib/select-window.mjs';
import { FlowRules } from '../plugins/sleight/lib/flow-rules.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

const document = 'Window: "report.txt", App: Fixture Editor.\n0 standard window report.txt, URL: file:///tmp/report.txt\n\t1 menu bar\n\t\t2 File, ID: file-menu\n\t3 button Other';
const menu = 'Window: "report.txt", App: Fixture Editor.\n0 File, Secondary Actions: Cancel, Pick\n\t1 menu Secondary Actions: Cancel\n\t\t4 Save, ID: save-item';
const other = 'Window: "Other", App: Other Editor.\n0 standard window Other\n\t1 button Next';
const target = { appId: 'org.test.editor', app: 'Fixture Editor', title: 'report.txt', url: 'file:///tmp/report.txt' };
const tick = () => new Promise(resolve => setTimeout(resolve, 1));

// Only mock engine calls run in this realm; native window/focus evidence stays in the relay.
async function fixture(t, { selected = true, confirm = true, nativeChange, selectedTarget = { ...target, windowNumber: 22 }, rejectInput = false, ...options } = {}) {
  let text = document, active = 'org.test.editor', writes = [];
  const inputs = [], sent = [], received = [];
  const native = { windowNumber: 22, hidIdleSeconds: 1000, status: 'ok' };
  const input = (app, kind, value) => {
    if (rejectInput) throw new Error('Fixture input rejected');
    inputs.push({ app, kind, value });
    if (kind === 'click' && value === 2) text = menu;
    if (kind === 'click' && value === 4 || value === 'Escape') text = document;
    if (nativeChange === 'window') native.windowNumber = 23;
    if (nativeChange === 'focus') native.status = 'mismatch';
    if (nativeChange === 'hid') native.hidIdleSeconds = 0;
  };
  const raw = app => ({ getAXState: async () => { active = app; return app === 'org.test.editor' ? text : other; },
    click: async value => input(app, 'click', value), pressKey: async value => input(app, 'key', value),
    typeText: async value => input(app, 'text', value) });
  const apps = { 'org.test.editor': raw('org.test.editor'), 'org.test.other': raw('org.test.other') };
  const context = createContext({ cua: {
    getApp: async selector => {
      active = selector === 'Other Editor' ? 'org.test.other' : 'org.test.editor';
      return apps[active];
    }, listApps: async () => [{ id: 'org.test.editor', windows: [{ title: 'report.txt' }] }],
  }, nodeRepl: { write: value => writes.push(String(value)) } });
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const directory = registerTemp(t, trackTemp(mkdtempSync(join(tmpdir(), 'sleight-tc1-'))));
  const inputLease = new InputLease({ directory, holder: 'TC1 test' });
  const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease, changeReview: false,
    runningProbe: () => ({ status: 'responding' }),
    windowIdentity: async expected => ({ ...expected, ...native, matches: 1,
      epoch: 'helper', window: 1, pid: 123, processStart: 1 }),
    localTools: { tools: [SELECT_WINDOW_TOOL], target: async () => selectedTarget,
      call: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, target: selectedTarget,
        identity: { pid: 123, windowNumber: selectedTarget.windowNumber } }) }] }) }, ...options });
  t.after(() => { relay.dispose(); for (const stream of streams) stream.destroy(); });
  clientOut.on('data', data => received.push(...data.toString().trim().split('\n').map(JSON.parse)));
  serverIn.on('data', data => sent.push(...data.toString().trim().split('\n').map(JSON.parse)));
  let next = 0, cursor = 0;
  const call = async (code, name = 'js') => {
    const id = ++next;
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name,
      arguments: name === 'js' ? { code } : { app: target.appId, url: target.url } } }) + '\n');
    for (let i = 0; i < 200; i++) {
      await tick();
      while (cursor < sent.length) {
        const request = sent[cursor++]; writes = [];
        let error;
        const code = request.params.arguments.code.replace(/\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+cua\.getApp/g,
          'globalThis.$1 = await cua.getApp');
        try { await runInContext(`(async () => { ${code} })()`, context,
          { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER }); }
        catch (e) { error = e; }
        if (/cua\.getApp\(/.test(request.params.arguments.code) && !error) writes.push(active === 'org.test.editor' ? text : other);
        if (error) writes.push(String(error));
        serverOut.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { isError: !!error,
          content: [{ type: 'text', text: writes.join('\n') }],
          _meta: { 'codex/toolSurface': { app: { appId: active } } } } }) + '\n');
      }
      const reply = received.find(msg => msg.id === id);
      if (reply) return reply.result;
    }
    throw new Error('Fixture did not receive a client result');
  };
  await call('let other = await cua.getApp("Other Editor");');
  await call('let app = await cua.getApp("Fixture Editor");');
  if (selected) {
    await call(undefined, 'select_window');
    if (confirm) await call('app = await cua.getApp("Fixture Editor");');
  }
  sent.length = received.length = 0; cursor = 0;
  return { call, inputs, sent, native, setText: value => { text = value; } };
}

for (const acquisition of ['let editor = await cua.getApp("Fixture Editor");',
  'const editor = await cua.getApp("org.test.editor");', 'var editor = await cua.getApp({ windowId: 22 });',
  'app = await cua.getApp("Fixture Editor");', 'await cua.getApp("org.test.editor");']) {
  test(`TC1: selected acquisition confirms before its remaining action: ${acquisition}`, async t => {
    const h = await fixture(t, { confirm: false });
    const handle = acquisition.includes('editor =') ? 'editor' : 'app';
    const result = await h.call(`${acquisition} await ${handle}.click("Other");`);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.deepEqual(h.inputs, [{ app: target.appId, kind: 'click', value: 3 }]);
    assert.equal(h.sent.length, 2, 'acquisition is confirmed before forwarding the action');
  });
}

for (const mismatch of ['title', 'url', 'app']) test(`TC1: combined selection acquisition refuses a changed ${mismatch}`, async t => {
  const h = await fixture(t, { confirm: false });
  h.setText(mismatch === 'title' ? document.replaceAll('report.txt', 'other.txt') :
    mismatch === 'url' ? document.replace('file:///tmp/report.txt', 'file:///tmp/other.txt') : document);
  const result = await h.call(`let editor = await cua.getApp("${mismatch === 'app' ? 'Other Editor' : 'Fixture Editor'}"); await editor.click("Other");`);
  assert.equal(result.isError, true);
  assert.deepEqual(h.inputs, []);
  assert.equal(h.sent.length, 1, 'only the acquisition reaches the engine');
});

test('TC1R: selected menu Escape admits an omitted URL with native ownership proof', async t => {
  const h = await fixture(t, { confirm: false });
  h.setText(menu);
  await h.call('app = await cua.getApp("Fixture Editor");');
  const result = await h.call('await app.pressKey("Escape");');
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(h.inputs.map(input => input.value), ['Escape']);
});

test('TC1R: selected button Cancel admits an omitted URL with native ownership proof', async t => {
  const h = await fixture(t, { confirm: false });
  h.setText(menu + '\n\t5 button Cancel');
  await h.call('app = await cua.getApp("Fixture Editor");');
  const result = await h.call('await app.click(5);');
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(h.inputs.map(input => input.value), [5]);
});

for (const confirm of [false, true]) for (const cancel of ['await app.pressKey("Escape");', 'await app.click(5);']) {
  for (const proof of ['no helper', 'unavailable', 'missing epoch', 'missing window', 'missing pid', 'missing processStart', 'same-title different window number']) {
    test(`OH2: URL-less selected child refuses ${cancel} with ${proof} (confirmed: ${confirm})`, async t => {
      const observed = { status: 'ok', matches: 1, epoch: 'helper', window: 1, pid: 123, processStart: 1, windowNumber: 22 };
      if (proof === 'unavailable') observed.status = 'unknown';
      else if (proof === 'same-title different window number') observed.windowNumber = 23;
      else delete observed[proof.slice('missing '.length)];
      const noProof = await fixture(t, { confirm,
        windowIdentity: proof === 'no helper' ? undefined : async expected => ({ ...expected, ...observed }) });
      noProof.setText(menu + '\n\t5 button Cancel');
      await noProof.call('app = await cua.getApp("Fixture Editor");');
      const result = await noProof.call(cancel);
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.deepEqual(noProof.inputs, []);
    });
  }
}

for (const confirm of [false, true]) for (const root of [menu,
  'Window: "report.txt", App: Fixture Editor.\n0 sheet\n\t4 button Save\n\t5 button Cancel',
  'Window: "report.txt", App: Fixture Editor.\n0 dialog\n\t4 button Save\n\t5 button Cancel']) {
  for (const action of ['await app.click(4);', 'await app.typeText("must not run");', 'await app.pressKey("Super+S");',
    'await app.pressKey("Escape"); await app.click(4);']) {
    test(`OH2: URL-less child refuses ordinary input (${confirm}, ${root.split('\n')[1]}, ${action})`, async t => {
      const h = await fixture(t, { confirm });
      h.setText(root);
      await h.call('app = await cua.getApp("Fixture Editor");');
      const result = await h.call(action);
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.deepEqual(h.inputs, []);
    });
  }
}

for (const mismatch of ['title', 'app']) test(`TC1: Cancel cannot bypass selected ${mismatch} identity`, async t => {
  const h = await fixture(t, { confirm: false });
  h.setText(mismatch === 'title' ? menu.replace('"report.txt"', '"other.txt"') : menu.replace('App: Fixture Editor.', 'App: Other Editor.'));
  await h.call('app = await cua.getApp("Fixture Editor");');
  const result = await h.call('await app.pressKey("Escape");');
  assert.equal(result.isError, true);
  assert.deepEqual(h.inputs, []);
});

test('TC1: an unconfirmed selected menu still refuses Save', async t => {
  const h = await fixture(t, { confirm: false });
  h.setText(menu);
  await h.call('app = await cua.getApp("Fixture Editor");');
  const result = await h.call('await app.click("Save");');
  assert.equal(result.isError, true);
  assert.deepEqual(h.inputs, []);
});

for (const change of ['window', 'focus']) for (const cancel of ['await app.pressKey("Escape");', 'await app.click(5);']) {
  test(`TC1: selected Cancel retains native ${change} protection: ${cancel}`, async t => {
    const h = await fixture(t, { confirm: false });
    h.setText(menu + `\nURL: ${target.url}\n\t5 button Cancel`);
    await h.call('app = await cua.getApp("Fixture Editor");');
    if (change === 'window') h.native.windowNumber = 23;
    else h.native.status = 'mismatch';
    const result = await h.call(cancel);
    assert.equal(result.isError, true);
    assert.deepEqual(h.inputs, []);
  });
}

for (const nativeChange of [undefined, 'window', 'focus', 'hid']) {
  test(`TC1: selected File then Save retains menu continuation checks (${nativeChange ?? 'unchanged'})`, async t => {
    const h = await fixture(t, { nativeChange });
    const result = await h.call('await app.click("File"); await app.click("Save");');
    assert.equal(!!result.isError, !!nativeChange, JSON.stringify(result));
    assert.deepEqual(h.inputs.map(input => input.value), nativeChange ? [2] : [2, 4]);
  });
}

for (const selected of [false, true]) for (const earlier of [0, 1, 2]) {
  test(`TC1: cross-app stop counts ${earlier} earlier actions and releases selection (${selected})`, async t => {
    const h = await fixture(t, { selected });
    const result = await h.call(`${'await app.pressKey("Super+C"); '.repeat(earlier)}await other.click("Next");`);
    assert.equal(result.isError, true);
    assert.deepEqual(h.inputs.map(input => input.value), Array(earlier).fill('Super+C'));
    const output = JSON.stringify(result);
    assert.match(output, new RegExp(`${earlier} earlier action${earlier === 1 ? '' : 's'} in this call ran`));
    assert.match(output, /nothing was sent to (?:the new app|Other Editor)/i);
    assert.match(output, /The lease moves to Other Editor\./);
    assert.doesNotMatch(output, /lease is now on the observed window/i);
    assert.match(output, /Not run: this click\(\\"Next\\"\) and every action after it/);
    if (earlier) assert.match(output, new RegExp(`ran, in Fixture Editor: ${Array(earlier).fill('pressKey\\(\\\\"Super\\+C\\\\"\\)').join(', ')}\\.`));
    assert.match(output, /Send the actions that didn't run in a new call that starts with let <handle> = await cua\.getApp\(\\"Other Editor\\"\) and acts through that handle, without select_window\./);
    const remaining = await h.call('await other.click("Next");');
    assert.notEqual(remaining.isError, true, JSON.stringify(remaining));
    assert.deepEqual(h.inputs.at(-1), { app: 'org.test.other', kind: 'click', value: 1 });
  });
}

test('TC1: flow rules refuse a combined selected acquisition before input', async t => {
  const flowRules = new FlowRules({ version: 1, rules: [{ id: 'secret', kind: 'pattern', pattern: 'SECRET', destinations: ['*'] }] });
  const h = await fixture(t, { confirm: false, flowRules });
  const result = await h.call('let editor = await cua.getApp("Fixture Editor"); await editor.typeText("SECRET");');
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /secret/);
  assert.deepEqual(h.inputs, []);
});

for (const cancel of ['await app.pressKey("Escape");', 'await app.click(5);']) {
  for (const url of ['file:///tmp/report.txt', 'file:///tmp/elsewhere/report.txt', null]) {
    test(`TC1R: selected Cancel ${url === null ? 'admits an omitted URL with native ownership proof' : 'requires equal URLs on both sides'}: ${url}, ${cancel}`, async t => {
      const h = await fixture(t, { confirm: false });
      h.setText(menu + (url ? `\nURL: ${url}` : '') + '\n\t5 button Cancel');
      await h.call('app = await cua.getApp("Fixture Editor");');
      const result = await h.call(cancel);
      assert.equal(!!result.isError, url !== null && url !== target.url, JSON.stringify(result));
      assert.equal(h.inputs.length, url === null || url === target.url ? 1 : 0);
    });
  }
  for (const windowNumber of [22, undefined]) {
    test(`TC1R: URL-less selection Cancel requires a selected native number: ${windowNumber}, ${cancel}`, async t => {
      const h = await fixture(t, { confirm: false, selectedTarget: { ...target, url: null, windowNumber } });
      h.setText(menu + '\n\t5 button Cancel');
      await h.call('app = await cua.getApp("Fixture Editor");');
      const result = await h.call(cancel);
      assert.equal(!!result.isError, windowNumber === undefined, JSON.stringify(result));
      assert.equal(h.inputs.length, windowNumber === undefined ? 0 : 1);
    });
  }
  test(`TC1R: Cancel refuses a URL when the selection has none: ${cancel}`, async t => {
    const h = await fixture(t, { confirm: false, selectedTarget: { ...target, url: null, windowNumber: 22 } });
    h.setText(menu + `\nURL: ${target.url}\n\t5 button Cancel`);
    await h.call('app = await cua.getApp("Fixture Editor");');
    const result = await h.call(cancel);
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.deepEqual(h.inputs, []);
  });
}

for (const selected of [false, true]) test(`TC1R: acquisition read cannot authorize a stale app handle (${selected})`, async t => {
  const h = await fixture(t, { selected: false });
  await h.call('app = await cua.getApp("Other Editor");');
  if (selected) await h.call(undefined, 'select_window');
  const result = await h.call('let editor = await cua.getApp("Fixture Editor"); await app.pressKey("Super+C");');
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.deepEqual(h.inputs, [], 'no key may reach the stale handle');
});

for (const earlier of [0, 1, 2]) test(`TC1R: cross-app count excludes caught guard refusals after ${earlier} completions`, async t => {
  const h = await fixture(t, { selected: false });
  const result = await h.call(`${'await app.pressKey("Super+C"); '.repeat(earlier)}try { await app.click("Missing"); } catch {} await other.click("Next");`);
  assert.equal(result.isError, true);
  assert.deepEqual(h.inputs.map(input => input.value), Array(earlier).fill('Super+C'));
  assert.match(JSON.stringify(result), new RegExp(`${earlier} earlier action${earlier === 1 ? '' : 's'} in this call ran`));
});

test('TC1R: cross-app count excludes a caught engine rejection', async t => {
  const h = await fixture(t, { selected: false, rejectInput: true });
  const result = await h.call('try { await app.pressKey("Super+C"); } catch {} await other.click("Next");');
  assert.equal(result.isError, true);
  assert.deepEqual(h.inputs, []);
  assert.match(JSON.stringify(result), /0 earlier actions in this call ran/);
});

test('TC1R: combined windowId acquisition cannot confirm a different native number', async t => {
  const h = await fixture(t, { confirm: false });
  const result = await h.call('let editor = await cua.getApp({ windowId: 23 }); await editor.click("Other");');
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.deepEqual(h.inputs, []);
});
