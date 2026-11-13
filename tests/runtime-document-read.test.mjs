import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, writeFile, readdir, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDocumentDisplay, documentReadText, documentDeliveryContent } from '../plugins/sleight/lib/repl/document-read.mjs';
import { createOwnRuntime } from '../plugins/sleight/lib/runtime-select.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { createMacReadState } from '../plugins/sleight/lib/mac-driver/diff.mjs';
import { createRuntimeActionEvents } from '../plugins/sleight/lib/mac-driver/action-events.mjs';
import { createCua } from '../plugins/sleight/lib/repl/cua.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { ActionLog } from '../plugins/sleight/lib/action-outcomes.mjs';
import { createStartupCache } from '../plugins/sleight/lib/startup-cache.mjs';

const marker = 'DT1_CONTENT_MUST_NOT_BE_RECORDED_a981';
const window = { windowId: '101', pid: 120, processStart: '100.25', bundleId: 'com.example.Editor',
  app: 'Editor', title: 'Draft', identityVerified: true, bounds: { x: 0, y: 0, width: 800, height: 600 } };
const canonical = 'Window: "Draft", App: Editor.\n0 standard window Draft\n\t1 text entry area\n\t2 button Save';
const payload = () => ({ version: 1, sections: [{ element: 1, text: `para H1 "${marker}"\npara P "Body"\ncursor para 2 col 1` }], needsPixels: false, protected: false });
const row = () => ({ window, text: canonical, readId: 1, truncated: false, document: payload() });

test('DT1E worker writes always carry structure until the parent knows what was delivered', async () => {
  const output = [], read = row();
  const cua = createCua({ platform: 'darwin', write: text => output.push(text), emitImage() {}, request: async () => read });
  const app = await cua.getApp('Editor'); output.length = 0;
  await app.getAXState();
  assert.ok(output.includes(documentReadText(read)));
});

test('DT1E sixteen delivered windows evict the oldest and same-title replacements never inherit a digest', () => {
  const display = createDocumentDisplay();
  const read = id => ({ ...row(), window: { ...window, windowId: String(id) } });
  for (let id = 1; id <= 16; id++) { const block = display.prepare(read(id)); assert.match(block.text, /document element/); block.commit(); }
  assert.match(display.prepare(read(1)).text, /struct =/);
  display.prepare(read(17)).commit();
  assert.match(display.prepare(read(1)).text, /document element/, 'the seventeenth delivered window evicts the first');
  assert.match(display.prepare(read(2)).text, /struct =/, 'the second window remains cached');
  for (const patch of [{ windowId: '18' }, { pid: 121 }, { processStart: '101.25' }, { bundleId: 'com.example.OtherEditor' }]) {
    const replaced = { ...read(2), window: { ...read(2).window, ...patch } };
    assert.equal(replaced.window.title, 'Draft');
    assert.match(display.prepare(replaced).text, /document element/);
  }
});

test('DT1E heading-only lines repeat no level already present in the same numbered tree row', () => {
  const read = { ...row(), text: canonical + '\n\t3 heading Shipping, Value: 2', document: { ...payload(),
    sections: [{ element: 1, text: 'element 3 heading H2' }] } };
  assert.equal(documentReadText(read), '');
  const mixed = { ...read, document: { ...read.document, sections: [{ element: 1,
    text: 'element 3 heading H2\nelement 1 cursor offset 4\nelement 3 table 2x3' }] } };
  assert.equal(documentReadText(mixed), '\tdocument element 1\n\telement 1 cursor offset 4\n\telement 3 table 2x3');
  for (const tree of [canonical + '\n\t3 heading Shipping', canonical + '\n\t3 heading Shipping, Value: 1',
    canonical + '\n\t3 text Shipping, Value: 2', canonical + '\n\t3 heading Value: 2 is a title',
    canonical + '\n\t3 heading Shipping, Value: 2 is a title, Value: 3',
    canonical + '\n\t3 heading Shipping, Value: 2, Value: 20',
    canonical + '\n\t3 heading Shipping, Value: 20']) assert.match(documentReadText({ ...read, text: tree }), /element 3 heading H2/);
});

test('DT1F a window label stays inside the 4000-unit supplement cap and omission count', () => {
  const read = { ...row(), document: { ...payload(), sections: [{ element: 1, text: 'para P "😀"\n'.repeat(330).trimEnd() }] } };
  const plain = documentReadText(read), label = '"A 😀 document"';
  const labelled = documentReadText(read, { label });
  assert.ok(labelled.length <= 4000); assert.ok(labelled.startsWith(label + ':\n'));
  const total = value => {
    const footer = /\n\t*\(…(\d+) more\)$/.exec(value);
    assert.ok(footer);
    return footer.index + Number(footer[1]);
  };
  assert.equal(total(labelled) - total(plain), label.length + 2);
  assert.equal(labelled.includes('\uFFFD'), false);
});

// A second Value anywhere in the line, before or after another field, makes the level ambiguous,
// so both supplement lines stay (DT1G review: page text in the title can precede the real Value).
for (const field of ['Details', 'Placeholder', 'ID', 'URL', 'Selected text', 'Secondary Actions'])
  for (const [title, real] of [['3', '2'], ['2', '3']])
    test(`DT1G a second Value around ${field} keeps both levels (${title} then ${real})`, () => {
      const read = { ...row(), text: canonical + `\n\t3 heading Shipping, Value: ${title}, ${field}: a, Value: ${real}`,
        document: { ...payload(), sections: [{ element: 1, text: 'element 3 heading H2\nelement 3 heading H3' }] } };
      const block = documentReadText(read);
      assert.match(block, /element 3 heading H2/); assert.match(block, /element 3 heading H3/);
    });

test('DT1G a single Value still lets the supplement drop its matching heading line', () => {
  const read = { ...row(), text: canonical + '\n\t3 heading Shipping, Value: 3, ID: a',
    document: { ...payload(), sections: [{ element: 1, text: 'element 3 heading H2\nelement 3 heading H3' }] } };
  const block = documentReadText(read);
  assert.match(block, /element 3 heading H2/); assert.doesNotMatch(block, /element 3 heading H3/);
});

test('DT1G ambiguous Value text in a heading title keeps the supplement level', () => {
  const read = { ...row(), text: canonical + '\n\t3 heading Shipping, Value: 2, Value: 3, ID: shipping',
    document: { ...payload(), sections: [{ element: 1, text: 'element 3 heading H2\nelement 3 heading H3' }] } };
  const block = documentReadText(read);
  assert.match(block, /element 3 heading H2/); assert.match(block, /element 3 heading H3/);
});

for (const reverse of [false, true]) test(`DT1G overlapping document batches merge only touched keys, reverse=${reverse}`, () => {
  const display = createDocumentDisplay();
  const read = (id, offset) => ({ ...row(), window: { ...window, windowId: String(id) },
    document: { ...payload(), sections: [{ element: 1, text: `cursor offset ${offset}` }] } });
  for (const id of [101, 202]) display.prepare(read(id, 4)).commit();
  const first = display.begin(), second = display.begin();
  first.prepare(read(101, 5)); second.prepare(read(202, 6));
  for (const batch of reverse ? [second, first] : [first, second]) batch.commit();
  assert.equal(display.prepare(read(101, 5)).text, 'struct =');
  assert.equal(display.prepare(read(202, 6)).text, 'struct =');
  for (const id of [101, 202]) assert.match(display.prepare(read(id, 4)).text, /cursor offset 4/);
});

for (const reverse of [false, true]) test(`DT1G overlapping batches preserve key deletion, reverse=${reverse}`, () => {
  const display = createDocumentDisplay(), first = row(), second = { ...row(), window: { ...window, windowId: '202' } };
  display.prepare(first).commit(); display.prepare(second).commit();
  const cleared = display.begin(), changed = display.begin();
  cleared.prepare({ ...first, document: undefined });
  const updated = { ...second, document: { ...payload(), sections: [{ element: 1, text: 'cursor offset 5' }] } };
  changed.prepare(updated);
  for (const batch of reverse ? [changed, cleared] : [cleared, changed]) batch.commit();
  assert.match(display.prepare(first).text, /document element/);
  assert.equal(display.prepare(updated).text, 'struct =');
});

test('DT1G overlapping batches retain the sixteen-window limit after merging keys', () => {
  const display = createDocumentDisplay(), read = id => ({ ...row(), window: { ...window, windowId: String(id) } });
  for (let id = 1; id <= 15; id++) display.prepare(read(id)).commit();
  const first = display.begin(), second = display.begin();
  first.prepare(read(16)); second.prepare(read(17)); first.commit(); second.commit();
  assert.match(display.prepare(read(1)).text, /document element/);
  for (let id = 2; id <= 17; id++) assert.equal(display.prepare(read(id)).text, 'struct =', `window ${id}`);
});

test('document structure is a separate item after the byte-identical tree', async () => {
  const output = [], read = row(), block = documentReadText(read);
  const cua = createCua({ platform: 'darwin', write: text => output.push({ type: 'text', text }), emitImage() {}, request: async () => read });
  const app = await cua.getApp('Editor');
  assert.equal(output[0].text, canonical);
  assert.equal(output[1].text, block);
  assert.match(block, /document element 1\n\tpara H1/);
  assert.doesNotMatch(block, /^\s*\d+ /m);
  output.length = 0;
  assert.equal(await app.getAXState(), canonical);
  assert.deepEqual(output, [{ type: 'text', text: canonical }, { type: 'text', text: block }], 'the parent decides suppression after worker output');
  assert.deepEqual(documentDeliveryContent(output, [read]), [{ type: 'text', text: canonical }]);
});

test('structure deduplication follows delivered windows and changes, never read IDs or body text', () => {
  let read = row();
  const output = [], display = createDocumentDisplay();
  const deliver = () => { const prepared = display.prepare(read); output.push(prepared.text); prepared.commit(); };
  deliver();
  const blocks = () => output.filter(text => text.startsWith('\tdocument element'));
  assert.equal(blocks().length, 1);
  output.length = 0;
  read = { ...read, readId: 2, text: canonical + '\n\t3 text Changed body' };
  deliver(); assert.equal(blocks().length, 0);
  assert.equal(output.at(-1), 'struct =');
  read = { ...read, readId: 3, document: { ...payload(), sections: [{ element: 1, text: 'para offset 0 length 4 H2\ncursor offset 4\nselection offset 4 length 2' }] } };
  deliver(); assert.equal(blocks().length, 1);
  output.length = 0;
  deliver(); assert.equal(blocks().length, 0, 'full-read action replies share the same display baseline');
  read = { ...read, document: { ...read.document, sections: [] } };
  deliver(); assert.equal(blocks().length, 0);
  assert.equal(output.at(-1), '', 'absent structure has no unchanged marker');
  read = { ...read, document: payload() };
  deliver(); assert.equal(blocks().length, 1, 'empty structure invalidates the old baseline');
  read = { ...row(), window: { ...window, windowId: '102' } };
  output.length = 0;
  deliver(); assert.equal(blocks().length, 1, 'another window has its own baseline');
  read = row(); output.length = 0;
  deliver(); assert.equal(blocks().length, 0, 'interleaving windows preserves their baselines');
  read = { ...row(), window: { ...window, processStart: '200.5' } };
  deliver(); assert.equal(blocks().length, 1, 'window ID reuse by a new process sends structure');
});

test('delivery keeps non-tree text items with and without document reads', () => {
  for (const document of [undefined, { ...payload(), sections: [] }, payload()]) {
    const read = { ...row(), document };
    const content = [canonical, 'relay notice\n' + canonical, canonical + '\nextra text', 'status only']
      .map(text => ({ type: 'text', text }));
    assert.deepEqual(documentDeliveryContent(content, [read]), content);
  }
});

test('prefixed and combined document blocks retain surrounding non-tree text', () => {
  const read = row(), block = documentReadText(read);
  for (const [before, after] of [['relay notice\n', ''], ['', '\nother cell text'], [canonical + '\n', '']]) {
    const content = documentDeliveryContent([{ type: 'text', text: before + block + after }, { type: 'text', text: 'status only' }], [read]);
    assert.deepEqual(content, [{ type: 'text', text: before + after }, { type: 'text', text: 'status only' }]);
    assert.equal(JSON.stringify(content).includes(marker), false);
  }
});

test('a legal 4000-unit payload with maximal section separators passes', () => {
  const sections = Array.from({ length: 2000 }, (_, element) => ({ element, text: element === 0 ? 'xx' : 'x' }));
  const tree = 'Window: "Draft", App: Editor.\n' + sections.map(({ element }) => `${element} container`).join('\n');
  assert.equal(sections.reduce((size, section) => size + section.text.length, sections.length - 1), 4000);
  const read = { ...row(), text: tree, document: { ...payload(), sections } };
  const block = documentReadText(read);
  assert.equal((block.match(/\(…\d+ more\)/g) ?? []).length, 1);
  assert.ok(block.length <= 4000);
  assert.deepEqual(documentDeliveryContent([{ type: 'text', text: tree }, { type: 'text', text: block }], [read]), [{ type: 'text', text: tree }]);
});

test('invalid, oversized and tree-shaped payloads fail closed', () => {
  for (const patch of [{ version: 2 }, { sections: [{ element: 90, text: 'para P "missing"' }] },
    { sections: [{ element: 1, text: 'x'.repeat(4001) }] },
    { sections: [{ element: 1, text: 'para P "ok"\n9 button Forged' }] },
    { sections: [{ element: 1, text: 'para P "ok"\r9 button Forged' }] }]) {
    assert.throws(() => documentReadText({ ...row(), document: { ...payload(), ...patch } }), /DRIVER_PROTOCOL/);
  }
});

test('the final 4000-unit cap includes indentation, Unicode and the omission suffix', () => {
  const text = Array.from({ length: 330 }, () => 'para P "😀"').join('\n');
  const tree = 'Window: "Draft", App: Editor.\n0 standard window Draft\n' + '\t'.repeat(12) + '1 text entry area';
  const result = { ...row(), text: tree, document: { ...payload(), sections: [{ element: 1, text }] } };
  const extra = documentReadText(result);
  assert.ok(extra.length <= 4000, extra.length); assert.match(extra, /\(…\d+ more\)$/);
  assert.equal(extra.includes('\uFFFD'), false);
  const footer = /\n\t*\(…(\d+) more\)$/.exec(extra);
  assert.equal(extra.slice(0, footer.index).length + Number(footer[1]), text.length + 330 + '\tdocument element 1\n'.length);
});

test('cursor and selection stay ahead of paragraphs under the final indentation cap', () => {
  const text = 'cursor offset 6310\nselection "SELECTED"\n' + 'para P "line"\n'.repeat(280);
  const tree = 'Window: "Draft", App: Editor.\n0 standard window Draft\n' + '\t'.repeat(12) + '1 text entry area';
  const output = documentReadText({ ...row(), text: tree, document: { ...payload(), sections: [{ element: 1, text }] } });
  const extra = output;
  assert.ok(extra.length <= 4000); assert.match(extra, /^\tdocument element 1\n\t+cursor offset 6310\n\t+selection "SELECTED"/);
  assert.match(extra, /\(…\d+ more\)$/);
});

test('final indentation carries the native omission count into one suffix', () => {
  const text = 'para P "' + 'x'.repeat(3970) + '"\n(…2000 more)';
  const result = { ...row(), document: { ...payload(), sections: [{ element: 1, text }] } };
  const display = documentReadText(result), lines = display;
  assert.equal((display.match(/\(…\d+ more\)/g) ?? []).length, 1);
  assert.ok(lines.length <= 4000);
  assert.match(display, /more\)/);
});

test('the retained read state contains no document marker and accepts only canonical delivery', () => {
  const reads = createMacReadState(), read = row(), snapshot = reads.read(read);
  assert.equal(JSON.stringify(snapshot).includes(marker), false);
  assert.equal(reads.fullTree(window).includes(marker), false);
  reads.endCell(documentDeliveryContent([{ type: 'text', text: canonical }, { type: 'text', text: documentReadText(read) }], [read]), [snapshot]);
  assert.doesNotThrow(() => reads.assertCurrent('click', { ...window, readId: 1, target: 2 }));
});

test('automatic capture is emitted once on a read and explicit screenshot still works', async () => {
  const calls = [], images = [], texts = [], screenshot = { data: 'AAAA', mimeType: 'image/png' };
  const cua = createCua({ platform: 'darwin', write: value => texts.push(value), emitImage: image => images.push(image),
    request: async method => { calls.push(method); return { ...row(), automaticScreenshot: true, screenshot, capture: { note: 'fixture frame' } }; } });
  const app = await cua.getApp('Editor'); assert.equal(images.length, 1);
  await app.getAXState(); assert.equal(images.length, 2);
  await app.getAXState({ emit: false }); assert.equal(images.length, 2);
  await app.getAXStateAndScreenshot(); assert.equal(images.length, 3);
  await app.getScreenshot(); assert.equal(images.length, 4);
  assert.deepEqual(calls, ['getApp', 'getAXState', 'getAXState', 'getAXStateAndScreenshot', 'getScreenshot']);
  assert.ok(texts.some(text => text.includes(marker)));
});

test('Windows and reads with no document payload retain their exact text', async () => {
  const plain = { ...row(), document: undefined };
  assert.equal(documentReadText(plain), '');
  const output = [];
  const windows = { ...plain, window: { ...window, processStart: '10025', image: 'C:\\fixture\\Editor.exe', integrity: 'medium' } };
  const cua = createCua({ platform: 'win32', write: value => output.push(value), emitImage() {}, request: async () => windows });
  await cua.getApp('Editor'); assert.equal(output[0], canonical);
});

test('declined app approval prevents every document read and optional capture', async () => {
  const methods = [];
  const runtime = createOwnRuntime({
    driver: { async request(method) {
      methods.push(method);
      if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app, pid: window.pid,
        processStart: window.processStart, running: true }, windows: [window] };
      assert.fail('declined app reached content: ' + method);
    }, async close() {}, async restart() {} },
    lease: { acquire() { assert.fail('declined app leased'); }, release() {}, close() {} },
    approve: () => false, policy: () => ({ allow: true }), targetParents: () => [1], ancestry: () => [{ pid: 500, path: '/fixture/Host' }],
    permissions: { app() {}, page() {}, sitesLimited: () => false },
  });
  try { await assert.rejects(runtime.safety.request('getApp', { selector: 'Editor' }), { code: 'APP_DECLINED' }); }
  finally { await runtime.close(); }
  assert.deepEqual(methods, ['resolveApp']);
});

const worker = { skip: !process.allowedNodeEnvironmentFlags.has('--allow-net'), timeout: 15000 };
test('real relay logs, journal callbacks, event feed and retained evidence never see document text', worker, async t => {
  const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-document-privacy-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  let readId = 0, next = 0;
  const requests = [], traces = [], callbacks = [], events = [], messages = [], receipts = [], actionLogReplies = [], actionCallIds = [], waiting = new Map(), children = [];
  const actionEvents = createRuntimeActionEvents(); actionEvents.connect(event => events.push(event));
  const runtime = createOwnRuntime({
    driver: { async request(method, params) {
      requests.push([method, params]);
      if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app, pid: window.pid, processStart: window.processStart, running: true }, windows: [window] };
      if (method === 'verifyWindowIdentity') return { window };
      if (method === 'rendererRestore') return { restored: true, token: params.args[0].lease.token };
      if (method === 'getAXState') return { ...row(), readId: ++readId };
      throw Error('unexpected fixture request ' + method);
    }, async restart() {}, async close() {} },
    lease: { acquire: () => 'fixture', grant: () => ({ token: 'fixture-token' }), renewGrant() {}, renew() {}, release() {}, close() {} },
    approve: () => true, policy: () => ({ allow: true }), targetParents: () => [1], ancestry: () => [{ pid: 500, path: '/fixture/Host' }],
    permissions: { app() {}, page() {}, sitesLimited: () => false }, actionEvents,
    replOptions: { environment: () => ({}), spawn: (...args) => { const child = fork(...args); children.push(child); return child; } },
  });
  const realSafetyRequest = runtime.safety.request.bind(runtime.safety);
  let actionReplies = 0;
  runtime.safety.request = async (method, params, context) => {
    if (!['click', 'typeText'].includes(method)) return realSafetyRequest(method, params, context);
    params.read = 'full';
    context.beforeRequest();
    requests.push([method, structuredClone(params)]);
    actionReplies++;
    const id = ++readId;
    return { ...row(), readId: id, delivery: 'sent-unverified', retry: 'read-first', document: {
      ...payload(), sections: [{ element: 1, text: payload().sections[0].text + `\ncursor offset ${id}` }],
    } };
  };
  const input = new PassThrough(), output = new PassThrough(), errorOutput = new PassThrough();
  let stderr = '', buffer = '';
  errorOutput.on('data', bytes => { stderr += bytes; });
  const transport = runtime.createTransport(output);
  const actionLog = new ActionLog({ path: join(root, 'actions.jsonl'), root, names: [], home: root });
  const logReply = actionLog.reply.bind(actionLog);
  actionLog.reply = message => { actionLogReplies.push(structuredClone(message)); return logReply(message); };
  const relay = createRelay({ clientIn: input, clientOut: transport.clientOut, serverIn: runtime.serverIn, serverOut: runtime.serverOut,
    stderr: errorOutput, nativeMac: true, nativeSession: transport.nativeSession,
    permissions: { app() {}, page() {}, sitesLimited: () => false }, ownHostPid: () => false,
    changeReview: false, warmRepl: false, warmEngine: false, simFocusNote: false, idleTurnEndMs: 0,
    receipts: true, receiptWriter: receipt => { receipts.push(structuredClone(receipt)); },
    startupCache: createStartupCache({ identity: { engine: 'offline-dt1', sleight: 'offline-dt1' }, directory: join(root, 'handshakes') }),
    ...(runtime.documentationTrust ? { documentationTrust: runtime.documentationTrust } : {}),
    trace: (direction, message) => traces.push([direction, structuredClone(message)]),
    onClientReply: message => callbacks.push(structuredClone(message)),
    actionLog,
  });
  output.on('data', bytes => {
    buffer += bytes;
    while (buffer.includes('\n')) {
      const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      const message = JSON.parse(line); messages.push(message);
      if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
    }
  });
  t.after(async () => { await relay.close(); transport.close(); await runtime.close(); for (const child of children) assert.notEqual(child.exitCode ?? child.signalCode, null); });
  const rpc = (method, params) => new Promise(resolve => {
    const id = ++next; waiting.set(id, resolve);
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = (code, name = 'js') => rpc('tools/call', { name, arguments: name === 'js' ? { code } : {} });
  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await rpc('tools/list', {});
  const first = await call('let app = await cua.getApp("Editor");');
  assert.notEqual(first.result.isError, true, JSON.stringify(first));
  assert.ok(JSON.stringify(first).includes(marker), 'the model receives approved content');
  const treeIndex = first.result.content.findIndex(item => item.text === canonical);
  const blockIndex = first.result.content.findIndex(item => item.text === documentReadText(row()));
  assert.ok(treeIndex >= 0 && blockIndex === treeIndex + 1);
  const repeated = await call('await app.getAXState(); void 0;');
  assert.notEqual(repeated.result.isError, true, JSON.stringify(repeated));
  assert.equal(JSON.stringify(repeated).includes(marker), false, 'unchanged structure is omitted at the final model boundary');
  for (const code of ['await app.click(2); void 0;', 'await app.typeText("fixture input"); void 0;']) {
    const reply = await call(code);
    assert.notEqual(reply.result.isError, true, JSON.stringify(reply));
    assert.ok(JSON.stringify(reply).includes(marker), 'post-action structure reaches the model');
    actionCallIds.push(reply.id);
  }
  assert.equal(actionReplies, 2);
  const hidden = await call('await app.getAXState({emit:false}); void 0;');
  assert.equal(JSON.stringify(hidden).includes(marker), false);
  // The preview refuses drag before endpoint lookup or dispatch. The transient
  // document must not appear in the requests or the refusal evidence.
  const drag = await call('await app.drag(1, 2);');
  assert.match(JSON.stringify(drag), /METHOD_NOT_FOUND/);
  assert.equal(requests.some(([method]) => method === 'drag'), false);
  await call(undefined, 'turn_ended');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(traces.length > 0); assert.ok(callbacks.length > 0); assert.ok(events.length > 0);
  assert.ok(receipts.length > 0, 'the enabled receipt journal was flushed');
  for (const kind of ['click', 'key']) assert.ok(events.some(event => event.kind === kind && event.phase === 'done'), kind + ' action reply reached the event feed');
  assert.equal(requests.filter(([method, params]) => ['click', 'typeText'].includes(method) && params.read === 'full').length, 2);
  for (const id of actionCallIds) assert.ok(actionLogReplies.some(message => message.id === id), 'action reply reached ActionLog.reply');
  for (const method of ['click', 'typeText']) assert.ok(receipts.some(receipt => receipt.calls.some(call => call.actions?.some(action => action.action === method))), method + ' action reached receipts');
  for (const [name, value] of Object.entries({ traces, callbacks, events, requests, receipts, actionLogReplies, stderr })) {
    assert.equal(JSON.stringify(value).includes(marker), false, name);
    await writeFile(join(root, name + '.json'), JSON.stringify(value));
  }
  assert.ok((await readdir(join(root, 'handshakes'))).length > 0, 'the handshake cache was exercised');
  const outputs = await readdir(root); assert.ok(outputs.includes('actions.jsonl'), 'the real action log wrote an output');
  async function scan(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await scan(path);
      else assert.equal((await readFile(path)).includes(Buffer.from(marker)), false, entry.name);
    }
  }
  await scan(root);
  const logRows = (await readFile(join(root, 'actions.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).length;
  t.diagnostic(`privacy: ${actionCallIds.length} full-read action replies, ${events.length} feed events, ${actionLogReplies.length} ActionLog replies, ${logRows} stored log rows, ${receipts.length} receipts, 0 marker matches`);
});
