import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { SELECT_WINDOW_TOOL } from '../plugins/sleight/lib/select-window.mjs';
const header = 'Window: "a.txt", App: TextEdit\nURL: file:///tmp/a.txt';
const rpc = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const result = (id, text = header) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }],
  _meta: { 'codex/toolSurface': { app: { appId: 'com.apple.TextEdit' } } } } });
test('normal action results and app acquisitions have no window note', t => {
  const { a } = setup(t);
  a.send(rpc(1, 'js', { code: 'app = await cua.getApp("TextEdit")' })); a.reply(result(1));
  assert.equal(a.received.at(-1).result.content.length, 1);
  a.send(rpc(2, 'js', { code: 'await app.typeText("x")' })); a.reply(result(2));
  assert.equal(a.received.at(-1).result.content.length, 1);
  a.send(rpc(3, 'js', { code: 'await app.typeText("x")' }));
  const failure = result(3); failure.result.isError = true; a.reply(failure);
  assert.equal(a.received.at(-1).result.content.length, 1);
});
test('action window mismatch names the intended and observed document only with a selection', async t => {
  const { h: a } = await selectedHarness(t);
  a.send(rpc(1, 'js', { code: 'await app.typeText("x")' }));
  a.reply(result(1, 'Window: "b.txt", App: TextEdit'));
  assert.match(a.received.at(-1).result.content.at(-1).text, /outcome unconfirmed.*a.txt.*b.txt/);
});
test('missing or ambiguous action headers leave a selected outcome unconfirmed', async t => {
  for (const response of ['done', header + '\nWindow: "b.txt", App: TextEdit']) {
    const { h: a } = await selectedHarness(t);
    a.send(rpc(1, 'js', { code: 'await app.typeText("x")' })); a.reply(result(1, response));
    assert.match(a.received.at(-1).result.content.at(-1).text, /outcome unconfirmed.*a.txt.*missing full window header/);
  }
});
test('ordinary window changes and missing headers have no selection note', t => {
  for (const response of ['Window: "b.txt", App: TextEdit', 'done']) {
    const { a } = setup(t);
    a.send(rpc(1, 'js', { code: 'await app.pressKey("super+n")' })); a.reply(result(1, response));
    assert.equal(a.received.at(-1).result.content.length, 1);
  }
});
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sleight-relay-lease-'));
  const path = join(directory, 'a.txt');
  writeFileSync(path, 'before\n');
  const relays = [];
  t.after(() => { for (const r of relays) r.close(); rmSync(directory, { recursive: true, force: true }); });
  const harness = (holder, options = {}) => {
    const clientIn = new PassThrough(), clientOut = new PassThrough(), serverIn = new PassThrough(), serverOut = new PassThrough();
    const forwarded = [], received = [];
    for (const [stream, output] of [[serverIn, forwarded], [clientOut, received]]) {
      stream.setEncoding('utf8').on('data', d => d.split('\n').filter(Boolean).forEach(line => output.push(JSON.parse(line))));
    }
    const inputLease = new InputLease({ directory, holder });
    const relay = createRelay({ clientIn, clientOut, serverIn, serverOut, inputLease, changeReview: true, ...options });
    relays.push(relay);
    const send = msg => clientIn.write(JSON.stringify(msg) + '\n');
    const reply = msg => serverOut.write(JSON.stringify(msg).replaceAll('file:///tmp/a.txt', pathToFileURL(path).href) + '\n');
    send(rpc('read', 'js', { code: 'let app = await cua.getApp("TextEdit")' })); reply(result('read'));
    forwarded.length = received.length = 0;
    return { send, reply, forwarded, received, relay, inputLease, serverIn, clientOut };
  };
  return { a: harness('A'), b: harness('B'), directory, path, harness };
}
async function selectedHarness(t, options = {}) {
  const { harness, path } = setup(t);
  const target = { appId: 'com.apple.TextEdit', app: 'TextEdit', title: 'a.txt', url: pathToFileURL(path).href };
  let failSelection = false;
  const h = harness('selection lifecycle', { changeReview: false, localTools: {
    tools: [SELECT_WINDOW_TOOL], target: async () => target,
    call: async () => failSelection ? { isError: true, content: [{ type: 'text', text: 'Selection failed' }] }
      : { content: [{ type: 'text', text: JSON.stringify({ ok: true, target }) }] },
  }, ...options });
  h.send(rpc('select', 'select_window', { app: 'TextEdit', url: target.url })); await new Promise(resolve => setImmediate(resolve));
  h.send(rpc('verify', 'js', { code: 'app = await cua.getApp("TextEdit")' })); h.reply(result('verify'));
  h.forwarded.length = h.received.length = 0;
  return { h, target, failSelection: () => { failSelection = true; } };
}
test('hidden recovery for another app keeps the confirmed selected window and its action note', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { h } = await selectedHarness(t);
  for (const id of [1, 2]) {
    h.send(rpc(id, 'js', { code: 'let calc = await cua.getApp("Calculator")' }));
    h.reply({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: '-10005 timeoutReached' }] } });
  }
  h.send(rpc(3, 'js', { code: 'app = await cua.getApp("TextEdit")' })); h.reply(result(3));
  t.mock.timers.tick(20000);
  const probe = h.forwarded.at(-1);
  assert.match(String(probe.id), /^sleight-helper-/);
  h.reply({ jsonrpc: '2.0', id: probe.id, result: { content: [{ type: 'text', text: 'Window: "Calculator", App: Calculator' }],
    _meta: { 'codex/toolSurface': { app: { appId: 'com.apple.calculator' } } } } });
  h.send(rpc(4, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(h.forwarded.at(-1).id, 4);
  h.reply(result(4, 'Window: "b.txt", App: TextEdit'));
  assert.match(h.received.at(-1).result.content.at(-1).text, /outcome unconfirmed.*a.txt.*b.txt/);
});

test('reset releases a selection and a new document read permits later actions', async t => {
  const { h } = await selectedHarness(t);
  h.send(rpc(1, 'js_reset')); h.reply(result(1, 'reset'));
  h.send(rpc(2, 'js', { code: 'app = await cua.getApp("TextEdit")' })); h.reply(result(2, 'Window: "b.txt", App: TextEdit'));
  h.send(rpc(3, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(h.forwarded.at(-1).id, 3); h.reply(result(3, 'Window: "b.txt", App: TextEdit'));
});
test('Save As and closing a selected window release selection after a confirmed change', async t => {
  for (const firstResponse of ['Window: "b.txt", App: TextEdit\nURL: file:///tmp/b.txt', 'closed']) {
    const { h } = await selectedHarness(t);
    h.send(rpc(1, 'js', { code: 'await app.pressKey("super+w")' })); h.reply(result(1, firstResponse));
    h.send(rpc(2, 'js', { code: 'app = await cua.getApp("TextEdit")' })); h.reply(result(2, 'Window: "b.txt", App: TextEdit'));
    h.send(rpc(3, 'js', { code: 'await app.typeText("x")' }));
    assert.equal(h.forwarded.at(-1).id, 3); h.reply(result(3, 'Window: "b.txt", App: TextEdit'));
    assert.equal(h.received.at(-1).result.content.length, 1);
  }
});
test('failed reselection releases the previous selected window', async t => {
  const { h, failSelection } = await selectedHarness(t); failSelection();
  h.send(rpc(1, 'select_window', { app: 'TextEdit', title: 'missing' })); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.received.at(-1).result.isError, true);
  h.send(rpc(2, 'js', { code: 'app = await cua.getApp("TextEdit")' })); h.reply(result(2, 'Window: "b.txt", App: TextEdit'));
  h.send(rpc(3, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(h.forwarded.at(-1).id, 3); h.reply(result(3, 'Window: "b.txt", App: TextEdit'));
});
test('document mode retains its document_scope guard after window selection', async t => {
  const { h } = await selectedHarness(t, { approvalScope: 'document', ask: async () => 'accept' });
  h.send(rpc(1, 'document_scope')); await new Promise(resolve => setImmediate(resolve));
  h.send(rpc(2, 'js', { code: 'await app.typeText("x")' }));
  const code = h.forwarded.at(-1).params.arguments.code;
  assert.match(code, /Document scope stopped.*document_scope/);
  assert.doesNotMatch(code, /Selected window changed/); h.reply(result(2));
});
test('lease refusal occurs before forwarding; standalone reads still pass', t => {
  const { a, b } = setup(t);
  a.send(rpc(1, 'js', { code: 'await app.typeText("x")' }));
  b.send(rpc(2, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(a.forwarded.length, 1);
  assert.equal(b.forwarded.length, 0);
  assert.equal(b.relay.snapshotDirectory, undefined, 'a refused contender captures no snapshot');
  assert.match(b.received[0].result.content[0].text, /Input lease.*A.*30 s/);
  b.send(rpc(3, 'js', { code: 'await app.getAXState({ disableDiffing: true })' }));
  assert.equal(b.forwarded.length, 1);
  a.reply(result(1)); b.reply(result(3));
});

test('actions carry both guards and retain the original saved snapshot across turns', t => {
  const { a, path } = setup(t);
  assert.equal(a.relay.snapshotDirectory, undefined, 'discovery remains a read');
  a.send(rpc(1, 'js', { code: 'await app.typeText("first")' }));
  const bank = a.relay.snapshotDirectory;
  assert.ok(existsSync(bank), 'snapshot exists before forwarding');
  const code = a.forwarded[0].params.arguments.code;
  assert.match(code, /record.token !== state.lease.token/);
  assert.match(code, /observed\[key\] !== state.expected\[key\]/);
  writeFileSync(path, 'first\n'); a.reply(result(1));
  a.send(rpc(2, 'turn_ended'));
  assert.ok(existsSync(bank), 'turn end retains review snapshots');
  a.send(rpc(3, 'js', { code: 'await app.typeText("second")' }));
  writeFileSync(path, 'second\n'); a.reply(result(3));
  a.send(rpc(4, 'review_changes', { op: 'list' }));
  assert.match(a.received.at(-1).result.content[0].text, /-before\n\+second/);
  a.relay.close(); assert.equal(existsSync(bank), false);
  assert.equal(a.inputLease.owned.size, 0);
});

for (const [binding, reread, handle] of [
  ['reassignment', 'app = await cua.getApp("TextEdit")', 'app'],
  ['let', 'let app = await cua.getApp("TextEdit")', 'app'],
  ['const', 'const x = await cua.getApp("TextEdit")', 'x'],
  ['bare', 'await cua.getApp("TextEdit")', 'app'],
]) {
  test(`TextEdit transcript reread captures a later copy with ${binding}, despite overlapping Open`, t => {
    const events = [];
    const { directory, harness } = setup(t);
    const a = harness('transcript', { trace: (direction, msg) => events.push({ direction, msg }) });
    const path = join(realpathSync(directory), `${binding}.txt`);
    writeFileSync(path, 'alpha beta gamma\n');
    const document = `Window: "${binding}.txt", App: TextEdit.\n0 standard window ${binding}.txt, Secondary Actions: Raise, URL: ${pathToFileURL(path).href}\n2 text entry area Value: alpha beta gamma`;
    const dialog = 'Window: "Open", App: TextEdit.\n0 standard window Open\n64 button Open';
    a.send(rpc(1, 'js', { code: 'await app.pressKey("super+o"); await app.getAXState()' }));
    a.reply(result(1, dialog));
    a.send(rpc(2, 'js', { code: `await app.pressKey("super+shift+g"); await app.typeText(${JSON.stringify(path)}); await app.pressKey("Return"); await app.getAXState()` }));
    a.reply(result(2, dialog));
    a.send(rpc(3, 'js', { code: 'await app.click(64)' }));
    a.send(rpc(4, 'js', { code: reread })); // Both benchmark transcripts sent this before click returned.
    a.reply(result(3, document));
    assert.equal(events.some(e => e.direction === 'snapshot-after-read' && e.msg.path === path), false);
    a.reply(result(4, document));
    const snapshot = events.find(e => e.direction === 'snapshot-after-read' && e.msg.path === path);
    assert.ok(snapshot, 'the completed standalone read captures the newly discovered document');
    assert.equal(readFileSync(snapshot.msg.snapshot, 'utf8'), 'alpha beta gamma\n');
    a.send(rpc(5, 'js', { code: `await ${handle}.selectText(2, "beta"); await ${handle}.typeText("delta"); await ${handle}.pressKey("super+s"); await ${handle}.getAXState()` }));
    assert.ok(a.forwarded.some(m => m.id === 5), 'the edit reaches the engine with leases and change review enabled');
    writeFileSync(path, 'alpha delta gamma\n'); a.reply(result(5, document));
    a.send(rpc(6, 'review_changes', { op: 'list' }));
    assert.match(a.received.at(-1).result.content[0].text, /Undo starts at the later copy[\s\S]*-alpha beta gamma\n\+alpha delta gamma/);
  });
}

test('an early reread waits for the pending action, then a fresh read captures the later copy', t => {
  const events = [];
  const { directory, harness } = setup(t);
  const a = harness('early read', { trace: (direction, msg) => events.push({ direction, msg }) });
  const path = join(realpathSync(directory), 'early.txt');
  writeFileSync(path, 'before\n');
  const document = `Window: "early.txt", App: TextEdit\nURL: ${pathToFileURL(path).href}`;
  a.send(rpc(1, 'js', { code: 'await app.pressKey("super+o")' }));
  a.reply(result(1, 'Window: "Open", App: TextEdit\n0 standard window Open\n64 button Open'));
  a.send(rpc(2, 'js', { code: 'await app.click(64)' }));
  a.send(rpc(3, 'js', { code: 'const x = await cua.getApp("TextEdit")' }));
  a.reply(result(3, document));
  assert.equal(a.received.at(-1).result.isError, undefined, 'the read remains available');
  assert.match(a.received.at(-1).result.content.at(-1).text, /action is still pending.*another standalone cua.getApp read/);
  assert.equal(events.some(e => e.direction === 'snapshot-after-read'), false);
  a.reply(result(2, document));
  a.send(rpc(4, 'js', { code: 'await cua.getApp("TextEdit")' }));
  a.reply(result(4, document));
  assert.ok(events.some(e => e.direction === 'snapshot-after-read' && e.msg.path === path));
  a.send(rpc(5, 'js', { code: 'await app.typeText("after")' }));
  assert.ok(a.forwarded.some(m => m.id === 5));
  a.reply(result(5, document));
});

test('leases and change review allow Cmd+O followed by typing a path into its sheet', async t => {
  const { a, path } = setup(t);
  let ui = `Window: "a.txt", App: TextEdit\nURL: ${pathToFileURL(path).href}`;
  const writes = [];
  const raw = { getAXState: async () => ui,
    pressKey: async key => { if (key === 'super+o') ui = 'Window: "Open", App: TextEdit\n0 standard window Open';
      if (key === 'super+shift+g') ui = 'Window: "", App: TextEdit\n0 sheet ID: GoToWindow'; },
    typeText: async value => writes.push(value) };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  t.after(() => { delete globalThis.__sleightDocumentGuard; });
  for (const [id, code] of [[1, 'await app.pressKey("super+o");'],
    [2, 'await app.pressKey("super+shift+g"); await app.typeText("/tmp/next.txt"); await app.pressKey("Return");']]) {
    a.send(rpc(id, 'js', { code }));
    const forwarded = a.forwarded.find(m => m.id === id);
    assert.ok(forwarded, 'dialog actions are forwarded with both features on');
    await new AsyncFunction('app', 'cua', 'nodeRepl', forwarded.params.arguments.code)(raw, { getApp: async () => raw }, { write() {} });
    a.reply(result(id, ui));
  }
  assert.deepEqual(writes, ['/tmp/next.txt']);
  assert.equal(a.inputLease.owned.size, 2, 'both action calls acquired their observed window lease');
  const key = [...a.inputLease.owned.keys()].at(-1);
  const leasePath = join(a.inputLease.directory, key + '.json');
  const record = readFileSync(leasePath, 'utf8');
  const code = a.forwarded.find(m => m.id === 2).params.arguments.code;
  try {
    writeFileSync(leasePath, JSON.stringify({ ...JSON.parse(record), token: 'replaced' }));
    await assert.rejects(new AsyncFunction('app', 'cua', 'nodeRepl', code)(raw, { getApp: async () => raw }, { write() {} }), /ownership lost/);
    assert.deepEqual(writes, ['/tmp/next.txt'], 'dialog allowance never bypasses the lease token');
  } finally { writeFileSync(leasePath, record); }
});

test('ordinary leased actions leave change review off', t => {
  const { harness } = setup(t);
  const h = harness('default lease', { changeReview: false });
  h.send(rpc(1, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(h.forwarded.length, 1);
  assert.equal(h.relay.snapshotDirectory, undefined);
  assert.match(h.forwarded[0].params.arguments.code, /record.token !== state.lease.token/);
  h.reply(result(1));
});

test('window selection holds the app lease and needs a matching standalone acquisition', async t => {
  const { harness, path, b } = setup(t);
  const target = { appId: 'com.apple.TextEdit', app: 'TextEdit', title: 'a.txt', url: pathToFileURL(path).href };
  let selections = 0;
  const h = harness('selector', { localTools: { tools: [SELECT_WINDOW_TOOL], target: async () => target,
    call: async (_, args) => { assert.equal(args.expectedAppId, target.appId); selections++;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, target }) }] }; } } });
  h.send(rpc(1, 'select_window', { app: 'TextEdit', url: target.url })); await new Promise(resolve => setImmediate(resolve));
  assert.equal(selections, 1);
  b.send(rpc(9, 'js', { code: 'await app.typeText("x")' })); assert.equal(b.forwarded.length, 0);
  h.send(rpc(2, 'js', { code: 'await app.typeText("x")' })); assert.equal(h.forwarded.length, 0);
  assert.match(h.received.at(-1).result.content[0].text, /selected window is not confirmed.*select_window/);
  h.send(rpc(3, 'js', { code: 'app = await cua.getApp("TextEdit")' })); h.reply(result(3, 'Window: "b.txt", App: TextEdit'));
  assert.match(h.received.at(-1).result.content.at(-1).text, /selected window not observed/);
  h.send(rpc(4, 'js', { code: 'await app.typeText("x")' })); assert.equal(h.forwarded.length, 1);
  h.send(rpc(5, 'js', { code: 'app = await cua.getApp("TextEdit")' })); h.reply(result(5));
  assert.equal(h.received.at(-1).result.content.length, 1);
  h.send(rpc(6, 'js', { code: 'await app.typeText("x")' })); assert.equal(h.forwarded.length, 3);
  assert.match(h.forwarded.at(-1).params.arguments.code, /Selected window changed.*select_window/);
  h.reply(result(6));
  h.send(rpc(7, 'js_reset')); h.reply(result(7, 'reset'));
  h.send(rpc(8, 'js', { code: 'await app.typeText("x")' }));
  assert.doesNotMatch(h.received.at(-1).result.content[0].text, /select_window/);
  h.send(rpc(10, 'js', { code: 'app = await cua.getApp("Calculator")' }));
  const other = result(10, 'Window: "Calculator", App: Calculator');
  other.result._meta['codex/toolSurface'].app.appId = 'com.apple.calculator'; h.reply(other);
  h.send(rpc(11, 'js', { code: 'await app.pressKey("1")' }));
  assert.equal(h.forwarded.at(-1).id, 11); h.reply(other);
});

test('window selection cannot raise an app while another session holds one of its documents', async t => {
  const { a, harness } = setup(t);
  let selections = 0;
  const h = harness('selector', { localTools: { tools: [SELECT_WINDOW_TOOL], target: async () => ({ appId: 'com.apple.TextEdit' }),
    call: async () => { selections++; return { content: [] }; } } });
  a.send(rpc(1, 'js', { code: 'await app.typeText("x")' })); a.reply(result(1));
  h.send(rpc(2, 'select_window', { app: 'TextEdit', title: 'b.txt' })); await new Promise(resolve => setImmediate(resolve));
  assert.equal(selections, 0); assert.match(h.received.at(-1).result.content[0].text, /Input lease.*A/);
});
test('a retained same-name handle cannot replace the selected bundle through an AX read', async t => {
  const { harness, path } = setup(t);
  const target = { appId: 'com.apple.TextEdit', app: 'TextEdit', title: 'a.txt', url: pathToFileURL(path).href };
  const h = harness('bundle selector', { localTools: { tools: [SELECT_WINDOW_TOOL], target: async () => target,
    call: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, target }) }] }) } });
  h.send(rpc(1, 'select_window', { app: 'TextEdit', url: target.url })); await new Promise(resolve => setImmediate(resolve));
  h.send(rpc(2, 'js', { code: 'app = await cua.getApp("TextEdit")' })); h.reply(result(2));
  h.send(rpc(3, 'js', { code: 'await other.getAXState({ disableDiffing: true })' }));
  const other = result(3); other.result._meta['codex/toolSurface'].app.appId = 'another.bundle'; h.reply(other);
  h.send(rpc(4, 'js', { code: 'await other.typeText("x")' }));
  assert.equal(h.forwarded.length, 2); assert.match(h.received.at(-1).result.content[0].text, /selected window is not confirmed/);
});
test('document mode permits selection but still requires document approval after its matching read', async t => {
  const { harness, path } = setup(t);
  const target = { appId: 'com.apple.TextEdit', app: 'TextEdit', title: 'a.txt', url: pathToFileURL(path).href };
  const h = harness('document selector', { approvalScope: 'document', ask: async () => 'accept',
    localTools: { tools: [SELECT_WINDOW_TOOL], target: async () => target,
      call: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, target }) }] }) } });
  h.send(rpc(1, 'select_window', { app: 'TextEdit', url: target.url })); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.received.at(-1).result.isError, undefined);
  h.send(rpc(2, 'js', { code: 'app = await cua.getApp("TextEdit")' })); h.reply(result(2));
  h.send(rpc(3, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(h.forwarded.length, 1); assert.match(h.received.at(-1).result.content[0].text, /not approved/);
  h.send(rpc(4, 'document_scope')); await new Promise(resolve => setImmediate(resolve));
  h.send(rpc(5, 'js', { code: 'await app.typeText("x")' })); assert.equal(h.forwarded.length, 2); h.reply(result(5));
});

test('AX re-read after a guard stop restores the known bundle identity', t => {
  const { a } = setup(t);
  a.send(rpc('unsaved', 'js', { code: 'app = await cua.getApp("TextEdit")' }));
  a.reply(result('unsaved', 'Window: "Untitled", App: TextEdit'));
  a.forwarded.length = 0;
  a.send(rpc(1, 'js', { code: 'await app.pressKey("super+s")' }));
  a.reply({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [
    { type: 'text', text: 'Input lease stopped this action: window or URL changed.' },
  ] } });
  a.send(rpc(2, 'js', { code: 'await app.getAXState({disableDiffing:true})' }));
  const reread = result(2, 'Window: "Untitled", App: TextEdit'); delete reread.result._meta; a.reply(reread);
  a.send(rpc(3, 'js', { code: 'await app.typeText("restored")' }));
  assert.equal(a.forwarded.length, 3, JSON.stringify(a.received));
  a.reply(result(3));
});

test('inventory reads do not erase a completed window target', t => {
  const { a } = setup(t);
  a.send(rpc(1, 'js', { code: 'await cua.listApps()' }));
  a.reply({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'TextEdit' }] } });
  a.send(rpc(2, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(a.forwarded.length, 2, JSON.stringify(a.received));
  a.reply(result(2));
});

test('bare getApp after reset recovers the session window bundle identity', t => {
  const { a } = setup(t);
  a.send(rpc(1, 'js_reset')); a.reply(result(1, 'reset'));
  a.send(rpc(2, 'js', { code: 'await cua.getApp("TextEdit")' }));
  const reread = result(2); delete reread.result._meta; a.reply(reread);
  a.send(rpc(3, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(a.forwarded.length, 3, JSON.stringify(a.received));
  a.reply(result(3));
});

test('missing identity refusal supplies an executable recovery assignment', t => {
  const { a } = setup(t);
  a.send(rpc(1, 'js_reset')); a.reply(result(1, 'reset'));
  a.send(rpc(2, 'js', { code: 'await app.typeText("x")' }));
  const message = a.received.at(-1).result.content[0].text;
  const recovery = message.match(/`([^`]+)`/)?.[1];
  assert.equal(recovery, 'app = await cua.getApp("com.apple.TextEdit")');
  a.send(rpc(3, 'js', { code: recovery })); a.reply(result(3));
  a.send(rpc(4, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(a.forwarded.length, 3, JSON.stringify(a.received));
  a.reply(result(4));
});

test('bundle identity is not inherited by an unrelated window or another session', t => {
  const { a, b } = setup(t);
  a.send(rpc(1, 'js', { code: 'await cua.getApp("Chess")' }));
  const unknown = result(1, 'Window: "Game", App: Chess'); delete unknown.result._meta;
  a.reply(unknown);
  a.send(rpc(2, 'js', { code: 'await app.click(1)' }));
  assert.equal(a.forwarded.length, 1);
  assert.equal(a.received.at(-1).result.isError, true);
  b.send(rpc(3, 'js', { code: 'await app.typeText("x")' })); b.reply(result(3));
  assert.equal(b.forwarded.length, 1);
});

test('a new bundle with the same display name cannot inherit a cached lease target', t => {
  const { a } = setup(t);
  a.send(rpc(1, 'js', { code: 'let other = await cua.getApp("org.other.TextEdit")' }));
  const unknown = result(1, 'Window: "Other", App: TextEdit'); delete unknown.result._meta;
  a.reply(unknown);
  a.send(rpc(2, 'js', { code: 'await other.typeText("x")' }));
  assert.equal(a.forwarded.length, 1);
  assert.equal(a.received.at(-1).result.isError, true);
});

test('a const app recovery uses a bare acquisition instead of reassigning the binding', t => {
  const { a } = setup(t);
  a.send(rpc(1, 'js', { code: 'const app = await cua.getApp("TextEdit")' })); a.reply(result(1));
  a.send(rpc(2, 'js', { code: 'await app.pressKey("super+s")' }));
  a.reply({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text: 'stopped' }] } });
  a.send(rpc(3, 'js', { code: 'await app.click(1)' }));
  assert.match(a.received.at(-1).result.content[0].text, /`await cua.getApp\("com.apple.TextEdit"\)`/);
});

test('interleaving known and unknown same-name handles never lends the known bundle ID', t => {
  const { a } = setup(t);
  a.send(rpc(1, 'js', { code: 'let te = await cua.getApp("com.apple.TextEdit")' })); a.reply(result(1));
  a.send(rpc(2, 'js', { code: 'let other = await cua.getApp("org.other.TextEdit")' }));
  const unknown = result(2, 'Window: "Other", App: TextEdit'); delete unknown.result._meta;
  a.reply(unknown);
  a.send(rpc(3, 'js', { code: 'await te.getAXState({disableDiffing:true})' }));
  const knownRead = result(3); delete knownRead.result._meta; a.reply(knownRead);
  a.send(rpc(4, 'js', { code: 'await other.getAXState({disableDiffing:true})' }));
  a.reply({ ...unknown, id: 4 });
  a.send(rpc(5, 'js', { code: 'await other.typeText("x")' }));
  assert.equal(a.forwarded.length, 4);
  assert.equal(a.received.at(-1).result.isError, true);
});

test('recovery follows an unknown handle after an interleaved read of another app', t => {
  const { a } = setup(t);
  a.send(rpc(1, 'js', { code: 'let chess = await cua.getApp("Chess")' }));
  const unknown = result(1, 'Window: "Game", App: Chess'); delete unknown.result._meta; a.reply(unknown);
  a.send(rpc(2, 'js', { code: 'await app.getAXState({disableDiffing:true})' }));
  const knownRead = result(2); delete knownRead.result._meta; a.reply(knownRead);
  a.send(rpc(3, 'js', { code: 'await chess.getAXState({disableDiffing:true})' })); a.reply({ ...unknown, id: 3 });
  a.send(rpc(4, 'js', { code: 'await chess.click(1)' }));
  assert.match(a.received.at(-1).result.content[0].text, /`app = await cua.getApp\("Chess"\)`/);
});

test('inventory search strings that mention getApp do not erase the target', t => {
  const { a } = setup(t);
  a.send(rpc(1, 'js', { code: 'JSON.stringify((await cua.listApps()).filter(a => a.name === "cua.getApp("))' }));
  a.reply({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '[]' }] } });
  a.send(rpc(2, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(a.forwarded.length, 2);
  a.reply(result(2));
});

test('a failed snapshot prevents the leased action from reaching the engine', t => {
  const { a, path } = setup(t);
  rmSync(path);
  a.send(rpc(1, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(a.forwarded.length, 0);
  assert.match(a.received[0].result.content[0].text, /Change review.*cannot snapshot/);
  a.send(rpc(2, 'turn_ended'));
  assert.equal(a.inputLease.owned.size, 0);
});

test('a screenshot read cannot bypass the next action snapshot conflict check', t => {
  const { a, path } = setup(t);
  a.send(rpc(1, 'js', { code: 'await app.typeText("edit")' }));
  writeFileSync(path, 'edit\n'); a.reply(result(1));
  a.send(rpc(2, 'js', { code: 'await app.getScreenshot()' })); a.reply(result(2, 'image only'));
  writeFileSync(path, 'outside edit\n');
  a.send(rpc(3, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(a.forwarded.length, 2);
  assert.match(a.received.at(-1).result.content[0].text, /Change review.*cannot snapshot/);
  assert.equal(readFileSync(path, 'utf8'), 'outside edit\n');
});

test('review renews its reservation while the user decides and only the user can undo', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const { a, b, path } = setup(t);
  a.send(rpc(1, 'js', { code: 'await app.typeText("edit")' }));
  writeFileSync(path, 'edit\n'); a.reply(result(1));
  a.send(rpc(2, 'turn_ended'));
  a.send(rpc(3, 'review_changes', { op: 'review', decision: 'undo' }));
  assert.equal(a.received.at(-1).result.isError, true);
  assert.equal(readFileSync(path, 'utf8'), 'edit\n');
  a.send(rpc(4, 'review_changes', { op: 'review' }));
  await new Promise(resolve => setImmediate(resolve));
  const prompt = a.received.find(m => m.method === 'elicitation/create');
  assert.deepEqual(prompt.params.requestedSchema.properties.decision.enum, ['keep', 'undo', 'later']);
  for (let i = 0; i < 8; i++) t.mock.timers.tick(5000);
  b.send(rpc(5, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(b.forwarded.length, 0);
  assert.match(b.received.at(-1).result.content[0].text, /Input lease.*A/);
  b.send(rpc(6, 'js', { code: 'await app.getAXState()' })); b.reply(result(6));
  a.send({ jsonrpc: '2.0', id: prompt.id, result: { action: 'accept', content: { decision: 'undo' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readFileSync(path, 'utf8'), 'before\n');
  assert.match(a.received.find(m => m.id === 4).result.content[0].text, /undone/);
  assert.equal(a.inputLease.owned.size, 0, 'review releases its broad reservation after the decision');
  b.send(rpc(7, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(b.forwarded.length, 2); b.reply(result(7));
});

test('review refuses another holder before prompting, while review listing remains a read', async t => {
  const { a, b, path } = setup(t);
  a.send(rpc(1, 'js', { code: 'await app.typeText("edit")' }));
  writeFileSync(path, 'edit\n'); a.reply(result(1)); a.send(rpc(2, 'turn_ended'));
  b.send(rpc(3, 'js', { code: 'await app.typeText("x")' })); b.reply(result(3));
  a.send(rpc(4, 'review_changes', { op: 'list' }));
  assert.match(a.received.at(-1).result.content[0].text, /-before\n\+edit/);
  a.send(rpc(5, 'review_changes', { op: 'review' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.match(a.received.at(-1).result.content[0].text, /Input lease.*B/);
  assert.equal(a.received.some(m => m.method === 'elicitation/create'), false);
});

test('a user Undo still refuses if review ownership expired before the decision', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { a, b, path } = setup(t);
  a.send(rpc(1, 'js', { code: 'await app.typeText("edit")' }));
  writeFileSync(path, 'edit\n'); a.reply(result(1)); a.send(rpc(2, 'turn_ended'));
  a.send(rpc(3, 'review_changes', { op: 'review' }));
  await new Promise(resolve => setImmediate(resolve));
  const prompt = a.received.find(m => m.method === 'elicitation/create');
  t.mock.timers.tick(31000);
  b.send(rpc(4, 'js', { code: 'await app.typeText("x")' })); b.reply(result(4));
  a.send({ jsonrpc: '2.0', id: prompt.id, result: { action: 'accept', content: { decision: 'undo' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readFileSync(path, 'utf8'), 'edit\n');
  assert.equal(a.received.find(m => m.id === 3).result.isError, true);
  assert.match(a.received.find(m => m.id === 3).result.content[0].text, /Input lease.*expired/);
  assert.doesNotThrow(() => b.inputLease.renew(), 'the expired reviewer cannot remove its successor');
});
test('turn end releases; pending action cannot release early', t => {
  const { a, b, directory } = setup(t);
  a.send(rpc(1, 'js', { code: 'await app.typeText("x")' }));
  a.send(rpc(2, 'turn_ended'));
  assert.ok(a.received[0].result.isError);
  b.send(rpc(3, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(b.forwarded.length, 0);
  a.reply(result(1)); a.send(rpc(4, 'turn_ended'));
  assert.equal(readdirSync(directory).filter(f => f.endsWith('.json')).length, 0);
  b.send(rpc(5, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(b.forwarded.length, 1); b.reply(result(5));
});
test('missing or ambiguous observation refuses actions and reset clears the target', t => {
  const { a } = setup(t);
  a.send(rpc(1, 'js_reset')); a.reply(result(1, 'reset'));
  a.send(rpc(2, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(a.forwarded.length, 1);
  assert.match(a.received.at(-1).result.content[0].text, /read/i);
  a.send(rpc(3, 'js', { code: 'await cua.getState()' })); a.reply(result(3, header + '\nWindow: "b.txt", App: TextEdit'));
  a.send(rpc(4, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(a.forwarded.length, 2);
});
test('active calls renew every 5 s; completed calls stop renewing and close removes leases', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { a } = setup(t);
  a.send(rpc(1, 'js', { code: 'await app.typeText("x")' }));
  for (let i = 0; i < 8; i++) t.mock.timers.tick(5000);
  const values = [...a.inputLease.owned.keys()];
  assert.ok(values.length);
  assert.doesNotThrow(() => a.inputLease.renew());
  a.reply(result(1));
  t.mock.timers.tick(30000);
  assert.throws(() => a.inputLease.renew(), /expired/);
  a.relay.close(); assert.equal(a.inputLease.owned.size, 0);
});

test('shutdown drains the running action before releasing and rejects new work', async t => {
  const { a, b } = setup(t);
  a.send(rpc(1, 'js', { code: 'await app.typeText("x")' }));
  const done = a.relay.shutdown();
  a.send(rpc(2, 'js', { code: 'await app.typeText("x")' }));
  assert.match(a.received[0].result.content[0].text, /closing/);
  b.send(rpc(3, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(b.forwarded.length, 0);
  a.reply(result(1)); await new Promise(resolve => setImmediate(resolve));
  const end = a.forwarded.at(-1); assert.equal(end.params.name, 'turn_ended');
  a.reply(result(end.id, 'ended')); await done;
  b.send(rpc(4, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(b.forwarded.length, 1); b.reply(result(4));
});

test('document grants remain necessary and do not bypass another session lease', async t => {
  const { a, harness } = setup(t);
  const document = harness('document session', { approvalScope: 'document', ask: async () => 'accept' });
  document.send(rpc(1, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(document.forwarded.length, 0);
  assert.equal(document.inputLease.owned.size, 0);
  document.send(rpc(2, 'document_scope')); await new Promise(resolve => setImmediate(resolve));
  a.send(rpc(3, 'js', { code: 'await app.typeText("x")' }));
  document.send(rpc(4, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(document.forwarded.length, 0);
  assert.match(document.received.at(-1).result.content[0].text, /Input lease.*A/);
  a.reply(result(3));
});

test('approved document screenshot reads preserve identity without snapshots or leases', async t => {
  const { harness } = setup(t);
  const h = harness('document screenshot', { approvalScope: 'document', ask: async () => 'accept' });
  h.send(rpc(1, 'document_scope')); await new Promise(resolve => setImmediate(resolve));
  h.send(rpc(2, 'js', { code: 'await app.getScreenshot()' }));
  h.reply({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'image', data: '', mimeType: 'image/png' }] } });
  assert.equal(h.received.find(m => m.id === 2).result.isError, undefined);
  assert.equal(h.relay.snapshotDirectory, undefined);
  assert.equal(h.inputLease.owned.size, 0);
  h.send(rpc(3, 'js', { code: 'await app.typeText("x")' }));
  assert.equal(h.forwarded.length, 2, 'the approved document remains usable'); h.reply(result(3));
});

test('local actions take an app lease; inventory reads stay available', async t => {
  const { harness, b } = setup(t);
  const h = harness('local', { localTools: { tools: [{ name: 'drag' }, { name: 'menu_bar' }],
    call: async () => ({ content: [] }) } });
  h.send(rpc(1, 'drag', { app: 'TextEdit', from: [0, 0], to: [1, 1] }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.received[0].result.isError, undefined);
  assert.equal(h.inputLease.owned.size, 1);
  b.send(rpc(3, 'js', { code: 'await app.typeText("x")' }));
  assert.match(b.received[0].result.content[0].text, /Input lease.*local/);
  h.send(rpc(2, 'menu_bar', { op: 'apps' })); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.received.at(-1).result.isError, undefined);
});

test('hover reserves only its app and conflicts with another holder before approval', async t => {
  const { harness, b } = setup(t);
  let approvals = 0, actions = 0;
  const h = harness('hover', { ask: async () => { approvals++; return 'accept'; },
    localTools: { tools: [{ name: 'hover' }], target: async () => ({ appId: 'com.apple.TextEdit', app: 'TextEdit' }),
      call: async (_name, _args, approve) => { if (await approve(['hover', 'TextEdit'], 'Allow hover?')) actions++; return { content: [] }; } } });
  b.send(rpc(1, 'js', { code: 'await app.typeText("x")' })); b.reply(result(1));
  h.send(rpc(2, 'hover', { app: 'TextEdit', at: [1, 2] })); await new Promise(resolve => setImmediate(resolve));
  assert.equal(actions, 0); assert.equal(approvals, 0);
  b.send(rpc(3, 'turn_ended'));
  h.send(rpc(4, 'hover', { app: 'TextEdit', at: [1, 2] })); await new Promise(resolve => setImmediate(resolve));
  h.send(rpc(5, 'hover', { app: 'TextEdit', at: [1, 2] })); await new Promise(resolve => setImmediate(resolve));
  assert.equal(actions, 2); assert.equal(approvals, 1);
  assert.doesNotThrow(() => b.inputLease.acquire({ appId: 'com.apple.calculator', app: 'Calculator' }, 'app'));
});

test('a delayed local approval cannot act after expiry and another session takeover', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const { harness, b } = setup(t);
  let answer, actions = 0;
  const h = harness('local approval', { ask: () => new Promise(resolve => { answer = resolve; }),
    localTools: { tools: [{ name: 'drag' }], call: async (_name, _args, approve) => {
      if (await approve(['drag', 'TextEdit'], 'Allow drag?')) actions++;
      return { content: [] };
    } } });
  h.send(rpc(1, 'drag', { app: 'TextEdit' }));
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(31000);
  b.send(rpc(2, 'js', { code: 'await app.typeText("x")' })); b.reply(result(2));
  answer('accept'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(actions, 0);
  assert.match(h.received.find(m => m.id === 1).result.content[0].text, /Input lease.*expired/);
  assert.doesNotThrow(() => b.inputLease.renew());
});

test('a delayed local approval is cancelled while the session drains on shutdown', async t => {
  const { harness } = setup(t);
  let answer, actions = 0;
  const h = harness('local shutdown', { ask: () => new Promise(resolve => { answer = resolve; }),
    localTools: { tools: [{ name: 'drag' }], call: async (_name, _args, approve) => {
      if (await approve(['drag', 'TextEdit'], 'Allow drag?')) actions++;
      return { content: [] };
    } } });
  h.send(rpc(1, 'drag', { app: 'TextEdit' }));
  await new Promise(resolve => setImmediate(resolve));
  const done = h.relay.shutdown();
  answer('accept'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(actions, 0);
  assert.match(h.received.find(m => m.id === 1).result.content[0].text, /closing/);
  const end = h.forwarded.at(-1); h.reply(result(end.id, 'ended')); await done;
});

test('transient heartbeat contention retries; repeated contention stops the owned engine', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { harness, directory } = setup(t);
  const faults = [];
  const h = harness('heartbeat', { onLeaseFault: err => faults.push(err) });
  h.send(rpc(1, 'js', { code: 'await app.typeText("x")' }));
  const db = new DatabaseSync(join(directory, '.coordinator.sqlite'));
  db.exec('BEGIN IMMEDIATE'); t.mock.timers.tick(5000);
  db.exec('ROLLBACK'); t.mock.timers.tick(5000);
  assert.equal(faults.length, 0);
  assert.doesNotThrow(() => h.inputLease.renew());
  db.exec('BEGIN IMMEDIATE');
  for (let i = 0; i < 3; i++) t.mock.timers.tick(5000);
  assert.equal(faults.length, 1);
  h.send(rpc(2, 'js', { code: 'await app.typeText("x")' }));
  assert.match(h.received[0].result.content[0].text, /closing/);
  db.exec('ROLLBACK'); db.close(); h.reply(result(1));
});

test('release failure is traced without crashing; persistent renewal errors stop the engine', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { harness, directory } = setup(t);
  const traces = [], faults = [];
  const h = harness('failure', { trace: (direction, msg) => traces.push({ direction, msg }), onLeaseFault: err => faults.push(err) });
  h.send(rpc(1, 'js', { code: 'await app.typeText("x")' }));
  const path = join(directory, [...h.inputLease.owned.keys()][0] + '.json');
  const original = readFileSync(path); writeFileSync(path, '{}');
  t.mock.timers.tick(5000);
  assert.equal(faults.length, 1);
  assert.doesNotThrow(() => h.relay.close());
  assert.ok(traces.some(t => t.direction === 'input-lease-release-error'));
  writeFileSync(path, original);
});

test('read polling during an active call cannot reset the heartbeat deadline', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { a } = setup(t);
  a.send(rpc(1, 'js', { code: 'await app.typeText("x")' }));
  for (let id = 2; id < 42; id++) {
    a.send(rpc(id, 'js', { code: 'await app.getScreenshot()' }));
    a.reply(result(id)); t.mock.timers.tick(1000);
  }
  assert.doesNotThrow(() => a.inputLease.renew()); a.reply(result(1));
});

test('late approval after server input ends is suppressed; stream faults trigger teardown', async t => {
  const { harness } = setup(t);
  let answer;
  const traces = [], faults = [];
  const h = harness('late approval', { ask: () => new Promise(resolve => { answer = resolve; }),
    trace: (direction, msg) => traces.push({ direction, msg }), onLeaseFault: err => faults.push(err) });
  h.reply({ jsonrpc: '2.0', id: 'approval', method: 'elicitation/create', params: { message: 'Allow Computer Use?',
    _meta: { connector_id: 'computer-use', persist: ['session'], tool_params: { app: 'com.apple.TextEdit' } } } });
  await new Promise(resolve => setImmediate(resolve));
  h.serverIn.end(); answer('accept'); await new Promise(resolve => setImmediate(resolve));
  assert.ok(traces.some(t => t.direction === 'server-input-closed'));
  assert.equal(faults.length, 0);
  h.clientOut.emit('error', new Error('EPIPE'));
  assert.equal(faults.length, 1);
});
