import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fork } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createOwnRuntime, MAC_RENDERER_RETAINED_NOTICE } from '../plugins/sleight/lib/runtime-select.mjs';
import { REPL_NODE_UNSUPPORTED } from '../plugins/sleight/lib/repl/client.mjs';
import { createReplClient } from '../plugins/sleight/lib/repl/client.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { formFixture } from './fixtures/runtime-helpers.mjs';
import { prepareMacInputRegistrar } from '../plugins/sleight/lib/mac-driver/input-registrar.mjs';

const worker = { skip: !process.allowedNodeEnvironmentFlags.has('--allow-net') && REPL_NODE_UNSUPPORTED, timeout: 10000 };
const window = { windowId: '101', pid: 120, processStart: '100.25', bundleId: 'com.example.Editor',
  app: 'Editor', title: 'Draft', identityVerified: true, bounds: { x: 0, y: 0, width: 800, height: 600 } };
const before = 'Window: "Draft", App: Editor.\n0 standard window Draft\n\t1 button Add\n\t2 text Ready\n\t3 button Cancel, ID: cancel';
const banner = before.replace('3 button Cancel, ID: cancel', '3 button Undo Banner $500, ID: banner\n\t4 button Cancel, ID: cancel');
const text = result => result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');

async function outcomeFixture(t, options = {}) {
  let readId = 0, captureId = 0;
  let tree=options.tree ?? before;
  const requests = [], observed = { ...window, onScreen: true, minimized: false };
  const image = { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', mimeType: 'image/png' };
  const driver = { ping: async () => ({ build: 'a'.repeat(64) }), async restart() {}, async close() {}, async request(method, params) {
    requests.push([method, structuredClone(params)]);
    if (method === 'inputGateState') return { enabled: true };
    if (method === 'resolveApp') return { app: { id: observed.bundleId, name: observed.app, pid: observed.pid, processStart: observed.processStart }, windows: [observed] };
    if (method === 'verifyWindowIdentity') return { window: observed };
    if (method === 'rendererRestore') return { restored: true, token: params.args[0].lease.token };
    if (method === 'personState') return { token: 'fixture', personTookOver: false };
    if (method === 'getAXState') return { window: observed, text: tree, readId: ++readId, truncated: false };
    if (method === 'getScreenshot') return { window: observed, screenshot: image, coordinateReadId: ++captureId };
    if (method === 'click' && options.afterClick) tree=options.afterClick(tree,params);
    if (method === 'setValue' && options.afterSetValue) tree=options.afterSetValue(tree,params);
    if (method === 'click') return { window: observed, ...options.delivery === 'sent-unverified' ? {text: tree, readId: ++readId, truncated:false} : {}, delivery: options.delivery ?? 'unknown', retry: 'read-first' };
    if (method === 'setValue' && options.reflectWrites) {
      const [n,value]=params.args;
      tree=tree.split('\n').map(line=>Number(/^\t*(\d+) /.exec(line)?.[1])===n
        ? line.replace(/, Value:.*$/,'')+', Value: '+value : line).join('\n');
    }
    if (['typeText', 'setValue', 'pressKey'].includes(method)) return { window: observed, text: tree, readId: ++readId, truncated:false, delivery: 'sent-unverified' };
    assert.fail(method);
  } };
  const inputRegistrar = await prepareMacInputRegistrar(driver, 'a'.repeat(64));
  const f = fixture(t, { ...options, realSafety: true, driver, inputRegistrar });
  f.runtime.safety.setPolicy({ checkPause() {}, inspectHelperStep:()=>true, beforeAction: ({ args }) => ({ args }) });
  assert.equal((await f.js('let app = await cua.getApp("Editor");')).isError, false);
  return { ...f, driverRequests: requests };
}


test('INT22C compacted reads cannot clear unknown input until a full read is delivered', worker, async t => {
  const tree = before + '\n' + Array.from({ length: 70 }, (_, i) => '\t' + (i + 4) + ' text Stable row ' + i).join('\n');
  const f = await outcomeFixture(t, { compactReads: true, tree });
  assert.equal((await f.js('await app.click(1); void 0;')).isError, false);
  const compact = await f.js('await app.getAXState();');
  assert.match(text(compact), /no change since/);
  assert.match(text(await f.js('await app.click(1); void 0;')), /READ_FIRST_REQUIRED/);
  await f.js('await app.getAXState({disableDiffing:true});');
  assert.equal((await f.js('await app.click(1); void 0;')).isError, false);
  assert.equal(f.driverRequests.filter(([method]) => method === 'click').length, 2);
});

test('UC2D2 ordinary input replies permit two inputs inside one real worker cell', worker, async t => {
  const f = await outcomeFixture(t, {delivery: 'sent-unverified'});
  const result = await f.js('await app.click(1); await app.typeText("x"); void 0;');
  assert.equal(result.isError, false, text(result));
  assert.deepEqual(f.driverRequests.filter(([method]) => ['click', 'typeText'].includes(method)).map(([method]) => method), ['click', 'typeText']);
});

test('UC2D delivery callbacks enforce unknown input, hidden reads and failed writes', worker, async t => {
  const f = await outcomeFixture(t);
  assert.equal((await f.js('await app.click(1); void 0;')).isError, false);
  assert.match(text(await f.js('await app.click(1);')), /READ_FIRST_REQUIRED/);
  await f.js('await app.getAXState({emit:false}); void 0;');
  assert.match(text(await f.js('await app.click(1);')), /READ_FIRST_REQUIRED/);
  f.delivery('failed'); await f.js('await app.getAXState();'); f.delivery('success');
  assert.match(text(await f.js('await app.click(1);')), /READ_FIRST_REQUIRED/);
  await f.js('await app.getAXState();');
  assert.equal((await f.js('await app.click(1); void 0;')).isError, false);
  assert.equal(f.driverRequests.filter(([method]) => method === 'click').length, 2);
});

test('UC2D an old held callback cannot clear a later unknown input', worker, async t => {
  const f = await outcomeFixture(t);
  f.delivery('held'); await f.js('await app.getAXState();'); f.delivery('success');
  await f.js('await app.click(1); void 0;');
  f.completeDelivery();
  assert.match(text(await f.js('await app.click(1);')), /READ_FIRST_REQUIRED/);
  assert.equal(f.driverRequests.filter(([method]) => method === 'click').length, 1);
});

test('UC2D an identical hidden read after input cannot borrow an earlier visible read', worker, async t => {
  const f = await outcomeFixture(t);
  const result = await f.js('await app.getAXState(); await app.click(1); await app.getAXState({emit:false}); void 0;');
  assert.equal(result.isError, false);
  assert.match(text(await f.js('await app.click(1);')), /READ_FIRST_REQUIRED/);
});

test('UC2D equal image bytes from distinct captures cannot authorize a hidden snapshot', worker, async t => {
  const f = await outcomeFixture(t);
  await f.js('await app.getScreenshot(); await app.getScreenshot({emit:false}); void 0;');
  assert.match(text(await f.js('await app.click([40,30]);')), /TARGET_CHANGED/);
  assert.equal(f.driverRequests.filter(([method]) => method === 'click').length, 0);
});

test('UC2D only an image acknowledged at the final delivery boundary binds coordinates', worker, async t => {
  const f = await outcomeFixture(t);
  await f.js('await app.getScreenshot({emit:false}); void 0;');
  assert.match(text(await f.js('await app.click([40,30]);')), /TARGET_CHANGED/);
  f.delivery('failed'); await f.js('await app.getScreenshot();'); f.delivery('success');
  assert.match(text(await f.js('await app.click([40,30]);')), /TARGET_CHANGED/);
  await f.js('await app.getScreenshot();');
  assert.equal((await f.js('await app.click([40,30]); void 0;')).isError, false);
  const click = f.driverRequests.find(([method]) => method === 'click')[1];
  assert.equal(click.coordinateReadId, 3);
  assert.ok(click.readId > 1, 'the fresh internal map is separate from the delivered image');
  await f.js('await app.getScreenshot();');
  assert.equal((await f.js('await app.click([40,30]); void 0;')).isError, false, 'a delivered screenshot recovers coordinate input');
});

function fixture(t, { realSafety = false, project = result => result, transport = false, runtimeFactory = createOwnRuntime,
  afterAction = () => banner, readPatch = () => ({}), localToolOptions, initial = before, driver: fixtureDriver, inputRegistrar, compactReads } = {}) {
  let next = 0, readId = 0, current = initial, failRead = false, replyPatch = {}, buffer = '';
  let delivery = 'success';
  const requests = [], children = [], pending = new Map(), workerReplies = [], unwritten = [];
  const runtime = runtimeFactory({
    inputRegistrar, compactReads,
    driver: fixtureDriver ?? { async request(method, params) {
      requests.push([method, params]);
      if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app, pid: window.pid, processStart: window.processStart, running: true }, windows: [window] };
      if (method === 'verifyWindowIdentity') return { window };
      if (method === 'rendererRestore') return { restored: true, token: params.args[0].lease.token };
      if (method === 'getAXState') return { window, text: current, readId: ++readId, truncated: false };
      assert.fail('unregistered input reached real driver: ' + method);
    }, async restart() {}, async close() {} },
    lease: { acquire: () => 'fixture', grant: () => ({ token: 'fixture-token' }), renewGrant() {}, renew() {}, release() {}, close() {} },
    approve: () => true, policy: () => ({ allow: true }), targetParents: () => [1], ancestry: () => [{ pid: 500, path: '/fixture/Host' }],
    permissions: { app() {}, page() {}, sitesLimited: () => false },
    localToolOptions,
    replOptions: { environment: () => ({}), spawn: (...args) => {
      const child = fork(...args); children.push(child);
      child.on('message', message => { if (message?.type === 'result') workerReplies.push(message.result); });
      return child;
    } },
  });
  t.after(async () => { await runtime.close(); for (const child of children) assert.notEqual(child.exitCode ?? child.signalCode, null); });
  // Production preview refuses input. Replace only that external admission seam
  // to exercise future input through the real parent's dispatcher and worker.
  if (!realSafety) runtime.safety.request = async (method, params, context) => {
    context.beforeRequest();
    requests.push([method, structuredClone(params)]);
    if (failRead && method === 'getAXState') throw Object.assign(Error('fixture read failure'), { code: 'AX_UNAVAILABLE' });
    if (['getApp', 'getAXState', 'getAXStateAndScreenshot'].includes(method))
      return { window, text: current, readId: ++readId, truncated: false, ...replyPatch, ...readPatch(readId) };
    current = afterAction(current, method, params);
    return { window, text: current, readId: ++readId, truncated: false, delivery: 'sent-unverified', retry: 'read-first', ...replyPatch };
  };
  const input = transport ? new PassThrough() : runtime.serverIn;
  const output = transport ? new PassThrough() : runtime.serverOut;
  if (transport) {
    // Hold only the final destination's acknowledgment. The real relay and own
    // transport still build, serialize and write their actual result objects.
    const write = output.write.bind(output);
    output.write = (bytes, callback) => {
      const outcome = delivery;
      return write(bytes, error => {
        if (outcome === 'held') unwritten.push(failure => callback(failure ?? error));
        else callback(outcome === 'failed' ? Error('fixture write failed') : error);
      });
    };
    const bridge = runtime.createTransport(output);
    const relay = createRelay({ clientIn: input, clientOut: bridge.clientOut, serverIn: runtime.serverIn, serverOut: runtime.serverOut,
      nativeMac: true, nativeSession: bridge.nativeSession, documentationTrust: runtime.documentationTrust,
      permissions: { app() {}, page() {}, sitesLimited: () => false }, ownHostPid: () => false,
      changeReview: false, warmRepl: false, warmEngine: false, simFocusNote: false, idleTurnEndMs: 0 });
    t.after(async () => { await relay.close(); bridge.close(); input.destroy(); output.destroy(); });
  }
  output.setEncoding('utf8').on('data', bytes => {
    buffer += bytes;
    for (let at; (at = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      if (!transport) runtime.safety.guardResult(message);
      const result = transport ? message.result : runtime.safety.displayResult(message.id, project(message.result));
      // Module-only tests acknowledge here. Transport tests use the real final
      // output callback above, through the facade's delivery adapter.
      if (!transport) {
        if (delivery === 'held') unwritten.push(result);
        else runtime.safety.recordDelivery(result, delivery === 'failed' ? Error('fixture write failed') : undefined);
      }
      pending.get(message.id)?.(result); pending.delete(message.id);
    }
  });
  const call = (name, args = {}) => new Promise(resolve => {
    const id = ++next; pending.set(id, resolve);
    input.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  return { runtime, requests, workerReplies, js: code => call('js', { code }), call,
    change: value => { current = value; }, failRead: value => { failRead = value; }, patchReply: value => { replyPatch = value; },
    delivery: value => { delivery = value; },
    completeDelivery: (error, index) => { for (const result of index === undefined ? unwritten.splice(0) : unwritten.splice(index, 1)) {
      if (transport) result(error); else runtime.safety.recordDelivery(result, error);
    } } };
}

const compactTree = value => before.replace('text Ready', `text Value: ${value}`) +
  Array.from({ length: 30 }, (_, i) => `\n\t${i + 4} button Row ${i}, ID: row-${i}`).join('');

for (const partial of ['truncated', 'slice']) for (const sameCell of [false, true])
  test(`UC2E2 review repro through transport: ${partial}, sameCell=${sameCell}`, worker, async t => {
    const baseline = compactTree('Ready');
    const shifted = baseline.split('\n').map(line => line.replace(/^(\t*)(\d+) /,
      (_, indent, n) => `${indent}${Number(n) >= 4 ? Number(n) + 1 : n} `))
      .toSpliced(5, 0, '\t4 button Inserted, ID: inserted').join('\n');
    const f = fixture(t, { compactReads: true, transport: true, initial: baseline, afterAction: value => value,
      readPatch: n => n === 2 ? { text: shifted, truncated: partial === 'truncated' } : {} });
    await f.js('let app = await cua.getApp("Editor");');
    const code = partial === 'truncated' ? 'await app.getAXState();' :
      'const saved = await app.getAXState({emit:false}); nodeRepl.write(saved.split("\\n").slice(6,10).join("\\n"));';
    f.delivery('held');
    const result = await f.js(code + (sameCell ? 'await app.getAXState(); void 0;' : 'void 0;'));
    if (sameCell) {
      // GLS4-2: an exact parent tree beside a worker slice may compact. The
      // held final callback below must still prevent number admission.
      if (partial === 'slice') assert.match(text(result), /no change since|standard window Draft/);
      else assert.ok(text(result).includes(baseline));
    }
    else {
      f.completeDelivery();
      assert.equal(text(await f.js('await app.getAXState(); void 0;')), baseline);
    }
    const refused = await f.js('await app.click(5); void 0;');
    const redundantCopy = partial === 'slice' && sameCell;
    // The current parent tree equals the already delivered baseline here. A
    // redundant slice cannot revoke its unchanged row 5 (GLS4-2).
    assert.equal(refused.isError, !redundantCopy, text(refused));
    assert.equal(f.requests.filter(([method]) => method === 'click').length, redundantCopy ? 1 : 0);
    f.completeDelivery(); f.delivery('success');
    const accepted = await f.js('await app.click(5); void 0;');
    assert.equal(accepted.isError, false, text(accepted));
    assert.equal(f.requests.filter(([method]) => method === 'click').length, redundantCopy ? 2 : 1);
    assert.match(baseline, /\t5 button Row 1,/);
  });

async function mutatedModule(relative, replacements) {
  const url = new URL(relative, import.meta.url);
  let source = readFileSync(url, 'utf8')
    .replace(/(from\s+)(['"])(\.[^'"]+)\2/g, (_, prefix, quote, path) => prefix + quote + new URL(path, url).href + quote)
    .replace(/new URL\((['"])(\.[^'"]+)\1, import.meta.url\)/g, (_, quote, path) => `new URL(${JSON.stringify(new URL(path, url).href)})`);
  for (const [from, to] of replacements) {
    assert.ok(source.includes(from), 'boundary mutation must apply'); source = source.replace(from, to);
  }
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

test('UC2E2 error-result exclusion detects a broken boundary', worker, async t => {
  async function check(factory) {
    let error = false;
    const f = fixture(t, { runtimeFactory: factory, compactReads: true, initial: compactTree('Ready'),
      project: result => ({ ...result, isError: error }) });
    await f.js('let app = await cua.getApp("Editor");');
    error = true;
    const failed = await f.js('await app.getAXState(); void 0;');
    assert.equal(text(failed), compactTree('Ready'));
    error = false;
    assert.equal(text(await f.js('await app.getAXState(); void 0;')), compactTree('Ready'));
    assert.match(text(await f.js('await app.getAXState(); void 0;')), /no change since/);
  }
  await check(createOwnRuntime);
  const mutant = await mutatedModule('../plugins/sleight/lib/runtime-select.mjs', [
    ['allowDelivery: !compactReads || !result.isError,', 'allowDelivery: true,'],
  ]);
  await assert.rejects(() => check(mutant.createOwnRuntime), { name: 'AssertionError' });
  t.diagnostic('production PASS; error delivery exclusion removed: FAIL (detected)');
});

for (const dispatch of [false, true]) test(`UC2E2 client strip detects a broken boundary, dispatch=${dispatch}`, worker, async t => {
  async function check(factory) {
    const requests = [];
    let readId = 0;
    const request = async (method, params) => {
      requests.push([method, params]);
      return { window, text: compactTree('Ready'), readId: ++readId, truncated: false,
        ...(method === 'getAXStateAndScreenshot' ? { screenshot: { data: 'iVBORw0KGgo=', mimeType: 'image/png' } } : {}) };
    };
    const repl = factory({ platform: 'darwin', environment: () => ({}),
      driver: { request, async restart() {}, async close() {} }, admit: async () => true,
      ...(dispatch ? { dispatch: request } : {}) });
    t.after(() => repl.close());
    assert.equal((await repl.execute({ code: 'let app = await cua.getApp("Editor");' })).isError, false);
    for (const method of ['getAXState', 'getAXStateAndScreenshot']) {
      const result = await repl.execute({ code: `await app.${method}({disableDiffing:true}); void 0;` });
      assert.equal(result.isError, false, text(result));
      assert.equal(Object.hasOwn(requests.at(-1)[1], 'disableDiffing'), false);
    }
  }
  await check(createReplClient);
  const mutant = await mutatedModule('../plugins/sleight/lib/repl/client.mjs', [
    ["if (displayRead && requestParams && Object.hasOwn(requestParams, 'disableDiffing'))", 'if (false)'],
  ]);
  await assert.rejects(() => check(mutant.createReplClient), { name: 'AssertionError' });
  t.diagnostic('production PASS; client option strip removed: FAIL (detected)');
});

for (const transport of [false, true]) test(`UC2E compacts parent display, keeps worker reads whole, transport=${transport}`, worker, async t => {
  const f = fixture(t, { compactReads: true, transport, initial: compactTree('Ready'), afterAction: value => value });
  assert.equal((await f.js('let app = await cua.getApp("Editor");')).isError, false);
  f.change(compactTree('Changed'));
  const changed = await f.js('await app.getAXState(); void 0;');
  assert.match(text(changed), /^\+ \t2 text Value: Changed$/m);
  assert.doesNotMatch(text(changed), /button Row 0,/);
  assert.ok(text(f.workerReplies.at(-1)).includes(compactTree('Changed')), 'worker retains the full read');
  const unchanged = await f.js('const value = await app.getAXState(); nodeRepl.write(value.includes("button Row 29"));');
  assert.match(text(unchanged), /no change since/); assert.match(text(unchanged), /true/);
  assert.equal((await f.js('await app.click(2); void 0;')).isError, false, 'parent commits full current map from its diff');
  assert.ok(text(await f.js('await app.getAXState({disableDiffing:true}); void 0;')).includes(compactTree('Changed')));
  assert.ok(text(await f.js('await app.getAXStateAndScreenshot({disableDiffing:true}); void 0;')).includes(compactTree('Changed')));
  assert.equal(f.requests.some(([, p]) => Object.hasOwn(p, 'disableDiffing')), false, 'display option never reaches native protocol');
});

test('UC2E defaults to changed lines through the real transport', worker, async t => {
  const f = fixture(t, { transport: true, initial: compactTree('Ready') });
  await f.js('let app = await cua.getApp("Editor");');
  assert.match(text(await f.js('await app.getAXState(); void 0;')), /no change since/);
});

test('UC2E runtime samples lean notice wording at startup', worker, async t => {
  const previous = process.env.SLEIGHT_PROMPT;
  let f;
  try {
    process.env.SLEIGHT_PROMPT = 'lean';
    f = fixture(t, { compactReads: true, initial: compactTree('Ready') });
  } finally {
    if (previous === undefined) delete process.env.SLEIGHT_PROMPT;
    else process.env.SLEIGHT_PROMPT = previous;
  }
  await f.js('let app = await cua.getApp("Editor");'); f.change(compactTree('Changed'));
  assert.match(text(await f.js('await app.getAXState(); void 0;')), /sleight: lines changed since your last full tree/);
});

test('UC2E opted-in failed delivery, slices, caps and turn end do not advance compact baselines', worker, async t => {
  let cap = false;
  const f = fixture(t, { compactReads: true, initial: compactTree('Ready'), project: result => cap ?
    { ...result, content: result.content.map(item => item.type === 'text' && item.text.startsWith('Window:') ?
      { ...item, text: item.text.slice(0, 80) } : item) } : result });
  await f.js('let app = await cua.getApp("Editor");'); f.change(compactTree('Changed'));
  await f.js('let saved = await app.getAXState({emit:false}); nodeRepl.write(saved.slice(0,80));');
  cap = true; await f.js('await app.getAXState(); void 0;'); cap = false;
  f.delivery('failed'); await f.js('await app.getAXState(); void 0;'); f.delivery('success');
  const retry = await f.js('await app.getAXState(); void 0;');
  assert.equal(text(retry), compactTree('Changed'));
  await f.call('turn_ended');
  assert.equal(text(await f.js('await app.getAXState(); void 0;')), compactTree('Changed'));
});

test('reviewer batch refuses the banner before dispatching its second click', worker, async t => {
  const f = fixture(t);
  assert.equal((await f.js('let app = await cua.getApp("Editor");')).isError, false);
  const result = await f.js('await app.click(1); await app.click(3);');
  assert.equal(result.isError, true, text(result)); assert.match(text(result), /STALE_READ/);
  assert.deepEqual(f.requests.filter(([method]) => method === 'click').map(([, p]) => p.args), [[1]]);
  assert.match(text(result), /Undo Banner \$500/);
  assert.equal((await f.js('await app.click(3); void 0;')).isError, true, 'an error cell grants no numbered context');
  await f.js('await app.getAXState(); void 0;');
  assert.equal((await f.js('await app.click(3); void 0;')).isError, false, 'a successful reread delivers the banner');
});

test('retained renderer notes survive the worker and final delivery as result text', worker, async t => {
  const f = fixture(t, { transport: true });
  f.patchReply({ rendererAttributeChanged: true, rendererNotes: [
    'activation-cleanup-retained:assistive-technology-running',
    'activation-cleanup-retained:assistive-technology-running',
    'activation-cleanup-retained:PRIVATE APP CONTENT',
  ] });
  const result = await f.js('let app = await cua.getApp("Editor");');
  assert.equal(result.isError, false);
  assert.ok(text(result).includes(MAC_RENDERER_RETAINED_NOTICE));
  assert.equal(text(result).match(/activation-cleanup-retained:assistive-technology-running/g)?.length, 1);
  assert.doesNotMatch(text(result), /PRIVATE APP CONTENT/);
  assert.ok(text(result).includes(before));
});

test('a read without retained renderer notes adds no cleanup notice', worker, async t => {
  const f = fixture(t);
  f.patchReply({ rendererAttributeChanged: true, rendererNotes: ['tree-still-thin'] });
  const result = await f.js('let app = await cua.getApp("Editor");');
  assert.equal(result.isError, false);
  assert.equal(text(result).includes(MAC_RENDERER_RETAINED_NOTICE), false);
});

test('acquisition and click in one cell cannot use an as-yet undelivered tree', worker, async t => {
  const f = fixture(t), result = await f.js('let app = await cua.getApp("Editor"); await app.click(3);');
  assert.equal(result.isError, true); assert.match(text(result), /STALE_READ/);
  assert.deepEqual(f.requests.map(([method]) => method), ['getApp']);
});

test('emit:false hidden read cannot rebind a number in the cell or the next one', worker, async t => {
  const f = fixture(t); await f.js('let app = await cua.getApp("Editor");'); f.change(banner);
  const hidden = await f.js('const saved = await app.getAXState({emit:false}); void 0;');
  assert.equal(text(hidden), '', 'parent must not append suppressed observations');
  assert.equal((await f.js('await app.click(3);')).isError, true);
  assert.equal(f.requests.some(([method]) => method === 'click'), false);
  assert.equal(text(await f.js('nodeRepl.write(saved);')), banner, 'later printed stored tree remains full text');
  // A cached string alone is not a new parent read in this cell.
  assert.equal((await f.js('await app.click(3);')).isError, true);
});

test('hidden reread followed by a click refuses within that same cell', worker, async t => {
  const f = fixture(t); await f.js('let app = await cua.getApp("Editor");'); f.change(banner);
  const result = await f.js('await app.getAXState({emit:false}); await app.click(3);');
  assert.equal(result.isError, true); assert.match(text(result), /STALE_READ/);
  assert.equal(f.requests.some(([method]) => method === 'click'), false);
});

test('sliced print never enables its unprinted tail and a repeat read returns the full tree', worker, async t => {
  const f = fixture(t); await f.js('let app = await cua.getApp("Editor");'); f.change(banner);
  const partial = await f.js('let saved = await app.getAXState({emit:false}); nodeRepl.write(saved.slice(0,80));');
  assert.equal(text(partial), banner.slice(0, 80));
  assert.equal((await f.js('await app.click(3);')).isError, true);
  assert.equal(text(await f.js('await app.getAXState();')), banner);
  assert.equal((await f.js('await app.click(3); void 0;')).isError, false);
});

test('only a full intermediate read printed by code becomes the delivered map', worker, async t => {
  const f = fixture(t); await f.js('let app = await cua.getApp("Editor");');
  const result = await f.js('await app.getAXState(); await app.click(1);');
  assert.equal(result.isError, false, text(result));
  assert.match(text(result), /button Cancel/); assert.match(text(result), /Undo Banner \$500/);
});

test('parent delivery caps cannot authorize numbers from the uncapped native observation', worker, async t => {
  let cap = false;
  const f = fixture(t, { project: result => cap ? { ...result, content: result.content.map(item =>
    item.type === 'text' && item.text.startsWith('Window:') ? { ...item, text: item.text.slice(0, 80) } : item) } : result });
  await f.js('let app = await cua.getApp("Editor");'); f.change(banner); cap = true;
  await f.js('await app.getAXState();'); cap = false;
  const result = await f.js('await app.click(3);');
  assert.equal(result.isError, true); assert.match(text(result), /STALE_READ/);
  assert.equal(f.requests.some(([method]) => method === 'click'), false);
});

const documentPayload = { version: 1, sections: [{ element: 2, text: 'element 2 cursor offset 4' }], needsPixels: false, protected: false };
const documentAt = offset => ({ ...documentPayload, sections: [{ element: 2, text: `element 2 cursor offset ${offset}` }] });

for (const reverse of [false, true]) test(`DT1G overlapping held cells preserve both window baselines, reverse=${reverse}`, worker, async t => {
  const f = fixture(t, { transport: true });
  const request = f.runtime.safety.request;
  let changed = false;
  f.runtime.safety.request = async (method, params, context) => {
    const result = await request(method, params, context);
    const other = params.selector === 'Other' || params.windowId === '202';
    return { ...result, text: other ? before.replaceAll('Draft', 'Other') : before,
      window: { ...window, windowId: other ? '202' : '101', title: other ? 'Other' : 'Draft' },
      document: documentAt(changed ? other ? 6 : 5 : 4) };
  };
  assert.equal((await f.js('let app = await cua.getApp("Editor"); let other = await cua.getApp("Other");')).isError, false);
  changed = true; f.delivery('held');
  assert.match(text(await f.js('await app.getAXState(); void 0;')), /cursor offset 5/);
  assert.match(text(await f.js('await other.getAXState(); void 0;')), /cursor offset 6/);
  // Both actual final-write callbacks are pending before either is acknowledged.
  await new Promise(resolve => setImmediate(resolve));
  f.completeDelivery(undefined, reverse ? 1 : 0); f.completeDelivery(); f.delivery('success');
  assert.match(text(await f.js('await app.getAXState(); void 0;')), /struct =/);
  assert.match(text(await f.js('await other.getAXState(); void 0;')), /struct =/);
  changed = false;
  for (const name of ['app', 'other']) {
    const result = text(await f.js(`await ${name}.getAXState(); void 0;`));
    assert.match(result, /cursor offset 4/); assert.doesNotMatch(result, /struct =/);
  }
});

test('DT1G js_reset clears document suppression and rejects old callbacks', worker, async t => {
  const f = fixture(t, { transport: true }); f.patchReply({ document: documentAt(4) });
  await f.js('let app = await cua.getApp("Editor");');
  assert.match(text(await f.js('await app.getAXState(); void 0;')), /struct =/);
  f.patchReply({ document: documentAt(5) }); f.delivery('held');
  await f.js('await app.getAXState(); void 0;'); f.delivery('success');
  assert.notEqual((await f.call('js_reset')).isError, true);
  f.completeDelivery();
  assert.match(text(await f.js('let app = await cua.getApp("Editor");')), /cursor offset 5/);
  assert.match(text(await f.js('await app.getAXState(); void 0;')), /struct =/);
});

test('DT1G equal-title windows with different blocks have distinct labels', worker, async t => {
  const f = fixture(t, { transport: true }), request = f.runtime.safety.request;
  let changed = false;
  f.runtime.safety.request = async (method, params, context) => {
    const result = await request(method, params, context);
    const other = params.selector === 'Other' || params.windowId === '202';
    return { ...result, window: { ...window, windowId: other ? '202' : '101' }, document: documentAt(other ? changed ? 7 : 5 : changed ? 6 : 4) };
  };
  await f.js('let app = await cua.getApp("Editor"); let other = await cua.getApp("Other");');
  const result = await f.js('await app.getAXState(); await other.getAXState(); void 0;');
  assert.equal(result.isError, false, text(result));
  const blocks = result.content.filter(item => /struct =/.test(item.text ?? '')).map(item => item.text);
  assert.deepEqual(blocks, ['"Draft" [101]: struct =', '"Draft" [202]: struct =']);
  t.diagnostic(`equal-title markers: ${blocks.map(block => Buffer.byteLength(block)).join(', ')} UTF-8 bytes`);
  changed = true;
  const full = await f.js('await app.getAXState(); await other.getAXState(); void 0;');
  assert.match(text(full), /"Draft" \[101\]:\n\tdocument element 2\n\telement 2 cursor offset 6/);
  assert.match(text(full), /"Draft" \[202\]:\n\tdocument element 2\n\telement 2 cursor offset 7/);
});

test('DT1F S0, S1, S0 in display order resends the return to S0', worker, async t => {
  const f = fixture(t, { transport: true }); f.patchReply({ document: documentAt(4) });
  await f.js('let app = await cua.getApp("Editor");');
  const request = f.runtime.safety.request, offsets = [5, 4];
  f.runtime.safety.request = async (...args) => ({ ...await request(...args), document: documentAt(offsets.shift() ?? 4) });
  const result = await f.js('await app.getAXState(); await app.getAXState(); void 0;');
  assert.equal(result.isError, false, text(result));
  const blocks = result.content.filter(item => /cursor offset|struct =/.test(item.text ?? '')).map(item => item.text);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /cursor offset 5/);
  assert.match(blocks[1], /cursor offset 4/);
  assert.doesNotMatch(text(result), /struct =/);
  assert.match(text(await f.js('await app.getAXState(); void 0;')), /struct =/);
});

for (const outcome of ['held', 'failed']) test(`DT1F ${outcome} cell discards its scratch baseline`, worker, async t => {
  const f = fixture(t, { transport: true }); f.patchReply({ document: documentAt(4) });
  await f.js('let app = await cua.getApp("Editor");');
  f.patchReply({ document: documentAt(5) }); f.delivery(outcome);
  const result = await f.js('await app.getAXState(); await app.getAXState(); void 0;');
  const blocks = result.content.filter(item => /cursor offset|struct =/.test(item.text ?? '')).map(item => item.text);
  assert.match(blocks[0], /cursor offset 5/); assert.equal(blocks[1], 'struct =');
  f.delivery('success');
  assert.match(text(await f.js('await app.getAXState(); void 0;')), /cursor offset 5/);
  f.completeDelivery(Error('fixture write failed'));
  assert.match(text(await f.js('await app.getAXState(); void 0;')), /struct =/);
});

test('DT1F hidden reads never update the parent document baseline', worker, async t => {
  const f = fixture(t, { transport: true }); f.patchReply({ document: documentAt(4) });
  await f.js('let app = await cua.getApp("Editor");');
  f.patchReply({ document: documentAt(5) });
  assert.doesNotMatch(text(await f.js('await app.getAXState({emit:false}); void 0;')), /cursor offset|struct =/);
  f.patchReply({ document: documentAt(4) });
  assert.match(text(await f.js('await app.getAXState(); void 0;')), /struct =/);
  f.patchReply({ document: documentAt(5) });
  assert.match(text(await f.js('await app.getAXState(); void 0;')), /cursor offset 5/);
});

test('DT1F an unhealthy helper clears the parent document cache and invalidates pending delivery', worker, async t => {
  const f = fixture(t, { transport: true }); f.patchReply({ document: documentPayload });
  await f.js('let app = await cua.getApp("Editor");');
  assert.match(text(await f.js('await app.getAXState(); void 0;')), /struct =/);
  f.patchReply({ document: documentAt(5) }); f.delivery('held'); await f.js('await app.getAXState(); void 0;');
  f.delivery('success'); f.patchReply({ unhealthy: true });
  const unhealthy = await f.js('await app.getAXState(); void 0;');
  assert.equal(unhealthy.isError, true); assert.match(text(unhealthy), /DRIVER_UNHEALTHY/);
  f.completeDelivery(); f.patchReply({ document: documentAt(5) });
  assert.match(text(await f.js('app = await cua.getApp("Editor"); void 0;')), /cursor offset 5/);
});

for (const changed of [false, true]) test(`DT1F two windows attribute every document item, changed=${changed}`, worker, async t => {
  const f = fixture(t, { transport: true });
  const request = f.runtime.safety.request;
  let changeOther = false;
  f.runtime.safety.request = async (method, params, context) => {
    const result = await request(method, params, context);
    const other = params.selector === 'Other' || params.windowId === '202';
    return { ...result, text: other ? before.replaceAll('Draft', 'Other') : before,
      window: { ...window, windowId: other ? '202' : '101', title: other ? 'Other' : 'Draft' },
      document: documentAt(other ? changeOther ? 6 : 5 : 4) };
  };
  const acquired = await f.js('let app = await cua.getApp("Editor"); let other = await cua.getApp("Other"); void 0;');
  assert.equal(acquired.isError, false, text(acquired));
  changeOther = changed;
  const result = await f.js('await app.getAXState(); await other.getAXState(); void 0;');
  assert.equal(result.isError, false, text(result));
  const blocks = result.content.filter(item => /cursor offset|struct =/.test(item.text ?? '')).map(item => item.text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0], '"Draft": struct =');
  if (changed) assert.equal(blocks[1], '"Other":\n\tdocument element 2\n\telement 2 cursor offset 6');
  else assert.equal(blocks[1], '"Other": struct =');
  t.diagnostic(`document items: ${blocks.map(block => Buffer.byteLength(block)).join(', ')} UTF-8 bytes`);
});

test('DT1F attribution that clips structure never establishes a parent baseline', worker, async t => {
  const f = fixture(t, { transport: true });
  const document = { ...documentPayload, sections: [{ element: 2, text: 'para P "😀"\n'.repeat(330).trimEnd() }] };
  const request = f.runtime.safety.request;
  f.runtime.safety.request = async (method, params, context) => {
    const result = await request(method, params, context);
    const other = params.selector === 'Other' || params.windowId === '202';
    const title = other ? 'Other document' : 'Draft document';
    return { ...result, text: before.replaceAll('Draft', title),
      window: { ...window, title, windowId: other ? '202' : '101' },
      document: other ? documentAt(6) : document };
  };
  const result = await f.js('let app = await cua.getApp("Editor"); let other = await cua.getApp("Other"); void 0;');
  assert.equal(result.isError, false, text(result));
  const block = result.content.find(item => item.text?.startsWith('"Draft document":'))?.text;
  assert.ok(block); assert.ok(block.length <= 4000); assert.match(block, /more\)/);
  assert.doesNotMatch(text(await f.js('await app.getAXState(); void 0;')), /struct =/);
});

for (const mode of ['guard-suppressed', 'capped']) test(`DT1E ${mode} structure is sent in full on the next delivered read`, worker, async t => {
  let suppress = true;
  const f = fixture(t, { project: result => !suppress ? result : { ...result, content: mode === 'guard-suppressed'
    ? [{ type: 'text', text: 'guard refused this read' }]
    : result.content.map(item => item.type === 'text' ? { ...item, text: item.text.slice(0, 80) } : item) } });
  f.patchReply({ document: documentPayload });
  const first = await f.js('let app = await cua.getApp("Editor");');
  assert.doesNotMatch(text(first), /cursor offset|struct =/);
  suppress = false;
  const delivered = await f.js('await app.getAXState(); void 0;');
  assert.match(text(delivered), /element 2 cursor offset 4/);
  const repeated = await f.js('await app.getAXState(); void 0;');
  assert.doesNotMatch(text(repeated), /cursor offset/);
  assert.match(text(repeated), /struct =/);
});

for (const outcome of ['held', 'failed']) test(`DT1E ${outcome} final transport callback never consumes an unseen document block`, worker, async t => {
  const f = fixture(t, { transport: true }); f.patchReply({ document: documentPayload });
  f.delivery(outcome);
  await f.js('let app = await cua.getApp("Editor");');
  f.delivery('success');
  const delivered = await f.js('await app.getAXState(); void 0;');
  assert.match(text(delivered), /element 2 cursor offset 4/);
  f.completeDelivery(Error('fixture write failed'));
  const repeated = await f.js('await app.getAXState(); void 0;');
  assert.match(text(repeated), /struct =/);
  assert.doesNotMatch(text(repeated), /cursor offset/);
});

test('DT1E a late callback from an ended turn cannot restore document suppression', worker, async t => {
  const f = fixture(t); f.patchReply({ document: documentPayload }); f.delivery('held');
  await f.js('let app = await cua.getApp("Editor");');
  f.runtime.safety.endTurn(); f.completeDelivery(); f.delivery('success');
  assert.match(text(await f.js('await app.getAXState(); void 0;')), /element 2 cursor offset 4/);
});

test('DT1E identical blocks in same-title windows in one cell cannot inherit another window baseline', worker, async t => {
  const f = fixture(t); f.patchReply({ document: documentPayload });
  const request = f.runtime.safety.request;
  f.runtime.safety.request = async (method, params, context) => {
    const result = await request(method, params, context);
    return { ...result, window: { ...result.window, windowId: params.selector === 'Other' || params.windowId === '202' ? '202' : '101' } };
  };
  await f.js('let app = await cua.getApp("Editor");');
  const result = await f.js('await app.getAXState(); let other = await cua.getApp("Other"); void 0;');
  assert.equal(result.isError, false, text(result));
  assert.match(text(result), /element 2 cursor offset 4/);
  assert.match(text(await f.js('await other.getAXState(); void 0;')), /element 2 cursor offset 4/);
  assert.match(text(await f.js('await other.getAXState(); void 0;')), /struct =/);
});

for (const boundary of ['reset', 'revoke']) test(`DT1E ${boundary} clears document suppression and rejects old callbacks`, worker, async t => {
  const f = fixture(t); f.patchReply({ document: documentPayload });
  await f.js('let app = await cua.getApp("Editor");');
  f.delivery('held'); await f.js('await app.getAXState(); void 0;');
  await f.runtime.safety[boundary]([window.bundleId]); f.completeDelivery(); f.delivery('success');
  assert.match(text(await f.js('await app.getAXState(); void 0;')), /element 2 cursor offset 4/);
});

for (const patch of [{ document: undefined }, { document: { ...documentPayload, sections: [] } }, { truncated: true }])
  test(`DT1E delivered ${JSON.stringify(patch)} resets the document baseline`, worker, async t => {
    const f = fixture(t); f.patchReply({ document: documentPayload });
    await f.js('let app = await cua.getApp("Editor");');
    f.patchReply({ document: documentPayload, ...patch });
    const changed = await f.js('await app.getAXState(); void 0;');
    assert.doesNotMatch(text(changed), /struct =/);
    f.patchReply({ document: documentPayload });
    assert.match(text(await f.js('await app.getAXState(); void 0;')), /element 2 cursor offset 4/);
  });

test('notices after a capped tree survive without enabling its numbers', worker, async t => {
  let cap = false;
  const notice = 'sleight: 4 tree lines omitted.\nsleight: guard requires a new read.';
  const f = fixture(t, { project: result => cap ? { ...result, content: result.content.map(item =>
    item.type === 'text' && item.text.startsWith('Window:') ? { ...item,
      text: 'sleight: preceding notice.\n' + item.text.slice(0, 80) + '\n' + notice } : item) } : result });
  await f.js('let app = await cua.getApp("Editor");'); f.change(banner); cap = true;
  const result = await f.js('await app.getAXState();');
  assert.match(text(result), /preceding notice/); assert.ok(text(result).includes(notice));
  assert.doesNotMatch(text(result), /Window:|standard window|button Add|Undo Banner \$500/);
  cap = false;
  assert.equal((await f.js('await app.click(3);')).isError, true);
  assert.equal(f.requests.some(([method]) => method === 'click'), false);
});

test('delivery waits for a successful callback; a failed callback never enables numbers', worker, async t => {
  for (const outcome of ['success', 'failed']) {
    const f = fixture(t); f.delivery('held'); await f.js('let app = await cua.getApp("Editor");');
    const refused = await f.js('await app.click(3);');
    assert.equal(refused.isError, true); assert.match(text(refused), /Read the current app state/);
    assert.equal(f.requests.some(([method]) => method === 'click'), false);
    f.completeDelivery(outcome === 'failed' ? Error('fixture write failed') : undefined);
    assert.equal((await f.js('await app.click(3);')).isError, outcome === 'failed');
    assert.equal(f.requests.filter(([method]) => method === 'click').length, outcome === 'failed' ? 0 : 1);
  }
});

test('a late successful write callback from the old turn cannot enable numbers', worker, async t => {
  const f = fixture(t); f.delivery('held'); await f.js('let app = await cua.getApp("Editor");');
  f.runtime.safety.endTurn(); f.completeDelivery();
  assert.equal((await f.js('await app.click(3);')).isError, true);
  assert.equal(f.requests.some(([method]) => method === 'click'), false);
});

test('reviewer Alice/Bob rows refuse Delete before parent dispatch', worker, async t => {
  const f = fixture(t), people = names => before.split('\n').slice(0, 2).join('\n') + '\n\t1 list' +
    names.map((name, i) => `\n\t\t${2 + i * 3} row\n\t\t\t${3 + i * 3} text ${name}\n\t\t\t${4 + i * 3} button Delete`).join('');
  f.change(people(['Alice', 'Carol'])); await f.js('let app = await cua.getApp("Editor");');
  f.change(people(['Bob', 'Alice', 'Carol']));
  const result = await f.js('await app.getAXState({emit:false}); await app.click(4);');
  assert.equal(result.isError, true, text(result));
  assert.match(text(result), /STALE_READ.*next=read-again/);
  assert.doesNotMatch(text(result), /went to element/);
  assert.deepEqual(f.requests.filter(([method]) => method === 'click'), []);
});

test('focus then setValue in one cell allows the focus flag to change', worker, async t => {
  const f = fixture(t, { afterAction: current => current.replace('(settable)', '(focused, settable)') });
  f.change(before.split('\n').slice(0, 2).join('\n') + '\n\t1 text field (settable) Name');
  await f.js('let app = await cua.getApp("Editor");');
  const result = await f.js('await app.click(1); await app.setValue(1, "Alice");');
  assert.equal(result.isError, false, text(result));
  assert.equal(f.requests.filter(([method]) => method === 'click').length, 1);
  assert.equal(f.requests.some(([method]) => method === 'setValue'), true);
  assert.equal((await f.js('await app.setValue(1, "Alice"); void 0;')).isError, false);
});

test('unchanged trees and changes strictly after the target subtree allow batched actions', worker, async t => {
  for (const afterAction of [current => current, current => current.replace('text Ready', 'text Later')]) {
    const f = fixture(t, { afterAction }); await f.js('let app = await cua.getApp("Editor");');
    const result = await f.js('await app.click(1); await app.click(1);');
    assert.equal(result.isError, false, text(result));
    assert.equal(f.requests.filter(([method]) => method === 'click').length, 2);
  }
});

test('turn_ended and relay turn boundaries both revoke delivered numbers', worker, async t => {
  for (const boundary of ['tool', 'relay']) {
    const f = fixture(t); await f.js('let app = await cua.getApp("Editor");');
    if (boundary === 'tool') await f.call('turn_ended'); else f.runtime.safety.endTurn();
    const result = await f.js('await app.click(3);');
    assert.equal(result.isError, true, boundary); assert.match(text(result), /STALE_READ/);
    assert.equal(f.requests.some(([method]) => method === 'click'), false);
    assert.equal(text(await f.js('await app.getAXState();')), before);
    assert.equal((await f.js('await app.click(3); void 0;')).isError, false);
  }
});

test('computed numbers and aliases encounter the parent check', worker, async t => {
  const f = fixture(t); await f.js('let app = await cua.getApp("Editor");');
  const result = await f.js('const alias = app.click; await app.click(1); await alias(1 + 2);');
  assert.equal(result.isError, true); assert.match(text(result), /STALE_READ/);
  assert.equal(f.requests.filter(([method]) => method === 'click').length, 1);
});

test('simultaneous input calls serialize the check with the preceding post-action read', worker, async t => {
  const f = fixture(t); await f.js('let app = await cua.getApp("Editor");');
  const result = await f.js('await Promise.all([app.click(1), app.click(3)]);');
  assert.equal(result.isError, true); assert.match(text(result), /STALE_READ/);
  assert.deepEqual(f.requests.filter(([method]) => method === 'click').map(([, p]) => p.args), [[1]]);
});

test('read failure revokes its numbers without losing the safe stale-number error', worker, async t => {
  const f = fixture(t); await f.js('let app = await cua.getApp("Editor");'); f.failRead(true);
  assert.equal((await f.js('await app.getAXState();')).isError, true);
  const result = await f.js('await app.click(3);');
  assert.equal(result.isError, true); assert.match(text(result), /STALE_READ/);
  assert.equal(f.requests.some(([method]) => method === 'click'), false);
});

test('secure-field full-tree fallback stays redacted in model output and code return values', worker, async t => {
  const f = fixture(t); f.change(before + '\n\t4 secure text field <redacted>');
  await f.js('let app = await cua.getApp("Editor");');
  const result = await f.js('const full = await app.getAXState({emit:false}); nodeRepl.write(full);');
  assert.match(text(result), /4 secure text field <redacted>/);
  assert.doesNotMatch(text(result), /Password|Value:/);
  assert.equal(text(result), f.workerReplies.at(-1).content[0].text);
  assert.equal((await f.js('await app.click(4); void 0;')).isError, false);
});

test('production safety still refuses every input after a delivered read', worker, async t => {
  const f = fixture(t, { realSafety: true });
  assert.equal((await f.js('let app = await cua.getApp("Editor");')).isError, false);
  const result = await f.js('await app.click(1);');
  assert.equal(result.isError, true); assert.match(text(result), /METHOD_NOT_FOUND/);
  assert.equal(f.requests.some(([method]) => method === 'click'), false);
  const again = await f.js('await app.doubleClick(1);');
  assert.match(text(again), /METHOD_NOT_FOUND/);
});

test('the facade drag adapter uses only acquired leased windows and drops them at turn end', worker, async t => {
  const calls = [], driverRequests = [];
  let readId = 0;
  const driver = { ping: async () => ({ build: 'a'.repeat(64) }), async close() {}, async request(method, params) {
    driverRequests.push(method);
    if (method === 'inputGateState') return { enabled: true };
    if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app,
      pid: window.pid, processStart: window.processStart, running: true }, windows: [window] };
    if (method === 'verifyWindowIdentity') return { window };
    if (method === 'getAXState') return { window, text: before, readId: ++readId, truncated: false };
    if (method === 'rendererRestore') return { restored: true, token: params.args[0].lease.token };
    assert.fail('unexpected fixture method: ' + method);
  } };
  const inputRegistrar = await prepareMacInputRegistrar(driver, 'a'.repeat(64));
  const f = fixture(t, { realSafety: true, driver, inputRegistrar, localToolOptions: { runLocal: async (script, request, options) => {
    calls.push(script);
    if (script === 'drag-focus.js') return { ok: true };
    assert.equal(typeof options.run, 'function');
    return { ok: true, path: 'background', windowId: 101, deliveryVerified: false };
  } } });
  await f.js('let app = await cua.getApp("Editor");');
  const args = { app: 'Editor', windowId: 101, from: [1, 2], to: [3, 4] };
  const call = () => f.runtime.localServices.localTools.call('drag', args, async () => true);
  const drag = await call();
  assert.notEqual(drag.isError, true, text(drag));
  assert.equal(calls.filter(script => script === 'drag.js').length, 1);
  assert.equal(driverRequests.filter(method => method === 'verifyWindowIdentity').length, 4);
  f.runtime.safety.endTurn();
  const refused = await call();
  assert.equal(refused.isError, true); assert.match(text(refused), /IDENTITY_UNVERIFIED/);
  assert.equal(calls.filter(script => script === 'drag.js').length, 1);
});

test('real relay acknowledges delivered numbers and refuses a later moved target', worker, async t => {
  const f = fixture(t, { transport: true });
  assert.equal((await f.js('let app = await cua.getApp("Editor");')).isError, false);
  assert.match(text(await f.js('await app.getAXState();')), /3 button Cancel, ID: cancel/);
  const result = await f.js('await app.click(1); await app.click(3);');
  assert.equal(result.isError, true, text(result)); assert.match(text(result), /STALE_READ/);
  assert.deepEqual(f.requests.filter(([method]) => method === 'click').map(([, params]) => params.args), [[1]]);
  const hidden = await f.js('await app.getAXState({emit:false}); void 0;');
  assert.doesNotMatch(text(hidden), /Window:|Undo Banner \$500|Cancel/);
});

test('real relay grants no numbers before a successful final write callback', worker, async t => {
  for (const outcome of ['success', 'failed']) {
    const f = fixture(t, { transport: true }); f.delivery('held');
    await f.js('let app = await cua.getApp("Editor");');
    assert.match(text(await f.js('await app.click(3);')), /STALE_READ/);
    assert.equal(f.requests.some(([method]) => method === 'click'), false);
    f.completeDelivery(outcome === 'failed' ? Error('fixture write failed') : undefined);
    f.delivery('success');
    assert.equal((await f.js('await app.click(3);')).isError, outcome === 'failed');
    assert.equal(f.requests.filter(([method]) => method === 'click').length, outcome === 'failed' ? 0 : 1);
  }
});

test('real relay ignores a successful final callback from an ended turn', worker, async t => {
  const f = fixture(t, { transport: true }); f.delivery('held');
  await f.js('let app = await cua.getApp("Editor");');
  f.runtime.safety.endTurn(); f.completeDelivery(); f.delivery('success');
  assert.match(text(await f.js('await app.click(3);')), /STALE_READ/);
  assert.equal(f.requests.some(([method]) => method === 'click'), false);
});

test('an emit:false read returned as the cell value counts because the model received it', worker, async t => {
  const f = fixture(t); await f.js('let app = await cua.getApp("Editor");'); f.change(banner);
  assert.equal(text(await f.js('await app.getAXState({emit:false});')), banner);
  assert.equal((await f.js('await app.click(3); void 0;')).isError, false);
});

test('forged driver IPC bypassing the app facade still receives the parent stale-number refusal', worker, async t => {
  const f = fixture(t); await f.js('let app = await cua.getApp("Editor");');
  const result = await f.js(`await app.click(1);
    const escaped = nodeRepl.write.constructor('return process')();
    const reply = await new Promise(resolve => {
      const receive = message => {
        if (message.type === 'driver-result' && message.id === 700) {
          escaped.off('message', receive); resolve(message);
        }
      };
      escaped.on('message', receive);
      escaped.send({ type: 'driver', cell: 2, id: 700, method: 'click',
        params: { windowId: '101', processStart: '100.25', readId: 2, args: [3] } });
    }); nodeRepl.write(reply);`);
  assert.equal(result.isError, true, text(result)); // Parent facts retain the refused IPC even when code catches it.
  const refusal = JSON.parse(f.workerReplies.at(-1).content.at(-1).text).error;
  assert.equal(refusal.code, 'STALE_READ'); assert.equal(refusal.delivery, 'not-sent'); assert.equal(refusal.retry, 'safe');
  assert.deepEqual(f.requests.filter(([method]) => method === 'click').map(([, p]) => p.args), [[1]]);
});

test('an unhealthy successful reply cannot leave parent numbers usable through forged IPC', worker, async t => {
  const f = fixture(t); await f.js('let app = await cua.getApp("Editor");'); f.patchReply({ unhealthy: true });
  const result = await f.js(`try { await app.getAXState({emit:false}); } catch {}
    const escaped = nodeRepl.write.constructor('return process')();
    const reply = await new Promise(resolve => {
      const receive = message => {
        if (message.type === 'driver-result' && message.id === 700) {
          escaped.off('message', receive); resolve(message);
        }
      };
      escaped.on('message', receive);
      escaped.send({ type: 'driver', cell: 2, id: 700, method: 'click',
        params: { windowId: '101', processStart: '100.25', readId: 2, args: [3] } });
    }); nodeRepl.write(reply);`);
  assert.equal(result.isError, true, text(result));
  assert.equal(f.requests.some(([method]) => method === 'click'), false);
  assert.equal(JSON.parse(f.workerReplies.at(-1).content.at(-1).text).error.code, 'STALE_READ');
});

test('malformed post-input text preserves delivery uncertainty and cannot authorize another input', worker, async t => {
  const f = fixture(t); await f.js('let app = await cua.getApp("Editor");'); f.patchReply({ text: 'malformed tree' });
  const result = await f.js('await app.click(1);');
  assert.equal(result.isError, true); assert.match(text(result), /delivery=sent-unverified; retry=read-first/);
  assert.equal((await f.js('await app.click(1);')).isError, true);
  assert.equal(f.requests.filter(([method]) => method === 'click').length, 1);
});

test('an in-flight read from the ended turn cannot enter the new delivery baseline', worker, async t => {
  const f = fixture(t); await f.js('let app = await cua.getApp("Editor");');
  const request = f.runtime.safety.request;
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  f.runtime.safety.request = async (...args) => { entered(); await held; return request(...args); };
  const pending = f.js('await app.getAXState();'); await started;
  f.runtime.safety.endTurn(); release();
  const result = await pending;
  assert.equal(result.isError, true); assert.match(text(result), /REPL_CELL_ENDED/);
  assert.doesNotMatch(text(result), /Window:/);
  f.runtime.safety.request = request;
  assert.equal((await f.js('await app.click(3);')).isError, true);
  assert.equal(f.requests.some(([method]) => method === 'click'), false);
});

const root = before.split('\n').slice(0, 2).join('\n');
test('two inputs dispatch when only a Value above the target changes', worker, async t => {
  const f = fixture(t, { afterAction: current => current.replace('Value: 0', 'Value: 7') });
  f.change(root + '\n\t1 scroll area ID: display\n\t\t2 text Description: Display, Value: 0\n\t3 button Seven\n\t4 button Multiply');
  await f.js('let app = await cua.getApp("Editor");');
  const result = await f.js('await app.click(3); await app.click(4);');
  assert.equal(result.isError, false, text(result));
  assert.deepEqual(f.requests.filter(([method]) => method === 'click').map(([, p]) => p.args), [[3], [4]]);
});

test('recorded setValue(18) then click(21) dispatches both requests', worker, async t => {
  const pair = JSON.parse(readFileSync(new URL('./fixtures/rt11d-notes-own-write.json', import.meta.url), 'utf8'));
  const asEditor = tree => root + '\n' + tree.split('\n').slice(2).join('\n');
  const f = fixture(t, { afterAction: () => asEditor(pair.current) });
  f.change(asEditor(pair.delivered)); await f.js('let app = await cua.getApp("Editor");');
  const result = await f.js('await app.setValue(18, "violet"); await app.click(21);');
  assert.equal(result.isError, false, text(result));
  assert.deepEqual(f.requests.filter(([method]) => ['setValue', 'click'].includes(method)).map(([method, p]) =>
    [method, p.args]), [['setValue', [18, 'violet']], ['click', [21]]]);
});

for (const prior of ['', 'old']) {
  test(`click(18), typeText, click(21) ${prior ? 'refuses appended prior content' : 'allows an empty field'}`, worker, async t => {
    const prefix = root + Array.from({ length: 17 }, (_, i) => `\n\t${i + 1} button Earlier ${i}`).join('');
    const field = value => prefix + `\n\t18 text field (settable) ${value}\n\t19 container\n\t\t20 button Replace\n\t\t21 button All`;
    const f = fixture(t, { afterAction: (current, method) => method === 'typeText' ?
      field(`Value: ${prior}x, Placeholder: Replace`) : current });
    f.change(field(prior ? `Value: ${prior}, Placeholder: Replace` : 'Replace'));
    await f.js('let app = await cua.getApp("Editor");');
    const result = await f.js('await app.click(18); await app.typeText("x"); await app.click(21);');
    assert.equal(result.isError, !!prior, text(result));
    if (prior) assert.match(text(result), /STALE_READ.*delivery=not-sent; retry=safe/);
    assert.deepEqual(f.requests.filter(([method]) => ['click', 'typeText'].includes(method)).map(([method, p]) =>
      [method, p.args]), prior ? [['click', [18]], ['typeText', ['x']]] : [['click', [18]], ['typeText', ['x']], ['click', [21]]]);
  });
}

test('a form fill dispatches both writes but Submit waits for a delivered read', worker, async t => {
  const f = fixture(t, { afterAction: (current, method, p) => method === 'setValue' ?
    current.replace(`${p.args[0]} text field (settable) ${p.args[0] === 1 ? 'Name' : 'Email'}`,
      `${p.args[0]} text field (settable) Value: ${p.args[1]}, Placeholder: ${p.args[0] === 1 ? 'Name' : 'Email'}`) : current });
  f.change(root + '\n\t1 text field (settable) Name\n\t2 text field (settable) Email\n\t3 button Submit');
  await f.js('let app = await cua.getApp("Editor");');
  const result = await f.js('await app.setValue(1, "Ann"); await app.setValue(2, "a@b"); await app.click(3);');
  assert.equal(result.isError, true, text(result));
  assert.match(text(result), /STALE_READ.*next=read-again/);
  assert.deepEqual(f.requests.filter(([method]) => ['setValue', 'click'].includes(method)).map(([method, p]) => [method, p.args]),
    [['setValue', [1, 'Ann']], ['setValue', [2, 'a@b']]]);
  await f.js('await app.getAXState();');
  assert.equal((await f.js('await app.click(3);')).isError, false);
});

test('drag refuses a stale second endpoint even when its first endpoint remains bound', worker, async t => {
  const f = fixture(t); await f.js('let app = await cua.getApp("Editor");');
  const result = await f.js('await app.click(1); await app.drag(1, 3);');
  assert.equal(result.isError, true); assert.match(text(result), /STALE_READ.*delivery=not-sent; retry=safe/);
  assert.equal(f.requests.filter(([method]) => method === 'click').length, 1);
  assert.equal(f.requests.filter(([method]) => method === 'drag').length, 0);
});

test('forged numeric-string target needs a matching unique ID in the parent', worker, async t => {
  const f = fixture(t); await f.js('let app = await cua.getApp("Editor");');
  const result = await f.js(`const escaped = nodeRepl.write.constructor('return process')();
    const reply = await new Promise(resolve => {
      const receive = message => {
        if (message.type === 'driver-result' && message.id === 700) {
          escaped.off('message', receive); resolve(message);
        }
      };
      escaped.on('message', receive);
      escaped.send({ type: 'driver', cell: 2, id: 700, method: 'click',
        params: { windowId: '101', processStart: '100.25', readId: 1, args: ['3'] } });
    }); nodeRepl.write(reply);`);
  assert.equal(result.isError, true, text(result));
  const refusal = JSON.parse(f.workerReplies.at(-1).content.at(-1).text).error;
  assert.equal(refusal.code, 'STALE_READ');
  assert.match(refusal.message,/exactly one matching ID/);
  assert.equal(f.requests.filter(([method]) => method === 'click').length, 0);
});

test('a refused write cannot authorize a matching external value change', worker, async t => {
  const f = fixture(t, { afterAction: current => current });
  const original = root + '\n\t1 text field (settable) Name\n\t2 button Submit';
  const changed = original.replace('(settable) Name', '(settable) Value: Ann, Placeholder: Name');
  f.change(original); await f.js('let app = await cua.getApp("Editor");');
  const request = f.runtime.safety.request;
  f.runtime.safety.request = async (method, ...args) => {
    if (method === 'setValue') {
      f.change(changed);
      throw Object.assign(Error('fixture refusal'), { code: 'REFUSED', parentSafety: true, delivery: 'not-sent', retry: 'safe' });
    }
    return request(method, ...args);
  };
  const result = await f.js('try { await app.setValue(1, "Ann"); } catch {} await app.getAXState({emit:false}); await app.click(2);');
  assert.equal(result.isError, true, text(result)); assert.match(text(result), /STALE_READ/);
  assert.equal(f.requests.filter(([method]) => method === 'click').length, 0);
});

for (const transport of [false, true]) test(`remap notice survives final output with transport=${transport}`, worker, async t => {
  const harmless = banner.replace('Undo Banner $500', 'Undo Banner');
  const f = fixture(t, { transport, afterAction: () => harmless });
  await f.js('let app = await cua.getApp("Editor");');
  const result = await f.js('await app.click(1); await app.click(3); await app.click(3); void 0;');
  assert.equal(result.isError, false, text(result));
  assert.match(text(result), /button Cancel, ID: cancel\(3\) went to element 4/);
  assert.deepEqual(f.requests.filter(([method]) => method === 'click').map(([, p]) => p.args), [[1], [4], [4]]);
  assert.equal((await f.js('await app.click(4); void 0;')).isError, false, 'new cell uses the newly delivered numbers');
});

test('a remapped write uses its delivered field index but cannot remap Submit', worker, async t => {
  const form = root + '\n\t1 text field (settable) Name\n\t2 text field (settable) Email\n\t3 button Submit';
  const shifted = root + '\n\t1 text field (settable) Value: Ann, Placeholder: Name\n\t\t2 button AutoFill\n\t3 text field (settable) Email\n\t4 button Submit';
  const f = fixture(t, { afterAction: (current, method, p) => method === 'setValue' ? p.args[0] === 1 ? shifted :
    current.replace('3 text field (settable) Email', '3 text field (settable) Value: a@b, Placeholder: Email') : current });
  f.change(form); await f.js('let app = await cua.getApp("Editor");');
  const result = await f.js('await app.setValue(1, "Ann"); await app.setValue(2, "a@b"); await app.click(3);');
  assert.equal(result.isError, true, text(result));
  assert.match(text(result), /STALE_READ.*next=read-again/);
  assert.deepEqual(f.requests.filter(([method]) => ['setValue','click'].includes(method)).map(([method,p]) => [method,p.args]),
    [['setValue',[1,'Ann']], ['setValue',[3,'a@b']]]);
  assert.match(text(result), /Email\(2\) went to element 3/); assert.doesNotMatch(text(result), /Submit\(3\) went to element 4/);
  await f.js('await app.getAXState();');
  assert.equal((await f.js('await app.click(4);')).isError, false);
});

test('not-sent replies cannot establish own-action exemptions', worker, async t => {
  const original = root + '\n\t1 checkbox (boolean) Choice, Value: 0\n\t2 button Submit';
  const f = fixture(t, { afterAction: current => current }); f.change(original);
  await f.js('let app = await cua.getApp("Editor");'); f.patchReply({ delivery: 'not-sent' });
  const request = f.runtime.safety.request;
  f.runtime.safety.request = async (method, params, context) => {
    const result = await request(method, params, context);
    if (method === 'click') f.change(original.replace('Value: 0', 'Value: 1'));
    return result;
  };
  const result = await f.js('await app.click(1); await app.getAXState({emit:false}); await app.click(2);');
  assert.equal(result.isError, true, text(result)); assert.match(text(result), /STALE_READ/);
  assert.equal(f.requests.filter(([method]) => method === 'click').length, 1);
});

for (const label of ['Pay now', 'Confirm', 'Submit', 'Send', 'Transfer', 'Order', 'Place order', 'Book', 'Buy', 'Delete', 'Save', 'Finish', 'Complete', 'Reserve'])
  test(`RT11H ${label} refuses a later Total change before dispatch and permits a fresh delivered read`, worker, async t => {
    const original = root + '\n\t1 button ' + label + '\n\t2 text Description: Total, Value: $5';
    const f = fixture(t, { afterAction: current => current });
    f.change(original); await f.js('let app = await cua.getApp("Editor");');
    f.change(original.replace('Value: $5', 'Value: $500'));
    const result = await f.js('await app.getAXState({emit:false}); await app.click(1);');
    assert.equal(result.isError, true, text(result));
    assert.match(text(result), /STALE_READ.*delivery=not-sent; retry=safe; next=read-again/);
    assert.equal(f.requests.some(([method]) => method === 'click'), false);
    await f.js('await app.getAXState();');
    const retry = await f.js('await app.click(1);');
    assert.equal(retry.isError, false, text(retry));
    assert.deepEqual(f.requests.filter(([method]) => method === 'click').map(([, p]) => p.args), [[1]]);
  });

for (const method of ['click', 'performSecondaryAction']) test(`runtime worker refuses menu clipboard writes via ${method}`, worker, async t => {
  const initial = 'Window: "Draft", App: Editor.\n0 standard window Draft\n\t1 menu item C\u200boρy Link, ID: copy-link\n\t2 menu item Paste';
  const f = fixture(t, { initial, afterAction: () => initial });
  assert.equal((await f.js('let app = await cua.getApp("Editor");')).isError, false);
  const extra = method === 'performSecondaryAction' ? ', "Activate"' : '';
  for (const target of ['1', '{id:"copy-link"}', '{label:"C\u200boρy Link"}']) {
    const result = await f.js(`await app.${method}(${target}${extra});`);
    assert.equal(result.isError, true, text(result));
    assert.match(text(result), /would overwrite the clipboard/i);
  }
  assert.equal(f.requests.filter(([name]) => name === method).length, 0);
  assert.equal((await f.js(`await app.${method}(2${extra});`)).isError, false);
  assert.equal(f.requests.filter(([name]) => name === method).length, 1);
});

test('UC2D2 a coordinate click retires earlier numbered click/type evidence', worker, async t => {
  const prefix = 'Window: "Draft", App: Editor.\n0 standard window Draft';
  const original = prefix+'\n\t1 text field (settable) Name\n\t2 container\n\t3 button Submit';
  const changed = original.replace('(settable) Name','(settable) Value: x, Placeholder: Name');
  const f=fixture(t,{initial:original,afterAction:(current,method)=>method==='typeText'?changed:current});
  await f.js('let app=await cua.getApp("Editor");');
  const result=await f.js('await app.click(1); await app.click([40,30]); await app.typeText("x"); await app.click(3);');
  assert.equal(result.isError,true,text(result)); assert.match(text(result),/STALE_READ/);
  assert.deepEqual(f.requests.filter(([m])=>m==='click').map(([,p])=>p.args),[[1],[[40,30]]]);
});

test('UC2D2 fillForm completes two fields through real worker and parent admission', worker, async t=>{
  const tree='Window: "Draft", App: Editor.\n0 standard window Draft\n\t1 text field (settable) Description: Name, Value: , Placeholder: Name\n\t2 text field (settable) Description: Email, Value: , Placeholder: Email';
  const f=await outcomeFixture(t,{delivery:'sent-unverified',tree,afterSetValue:(current,params)=>{
    const [number,value]=params.args, label=number===1?'Name':'Email';
    return current.replace(new RegExp('(\\t'+number+' text field[^\\n]*Value: )[^\\n]*'),
      (_row,prefix)=>prefix+value+', Placeholder: '+label);
  }});
  const result=await f.js(`const h=(${formFixture.toString()})({Name:{},Email:{}},app);
    nodeRepl.write(await sleight.fillForm(h.tab,[{label:"Name",value:"Ada"},{label:"Email",value:"a@b"}]));`);
  assert.equal(result.isError,false,text(result)); assert.match(text(result),/Filled 2 of 2 fields/);
  assert.match(text(result),/Value: Ada, Placeholder: Name/);
  assert.match(text(result),/Value: a@b, Placeholder: Email/);
  assert.equal(f.driverRequests.filter(([m])=>m==='setValue').length,2);
  const read=await f.js('await app.getAXState();');
  assert.match(text(read),/Description: Name, Value: Ada/);
  assert.match(text(read),/Description: Email, Value: a@b/);
});

test('UC2D2 pickFromList and the following key complete through real parent admission', worker, async t=>{
  const tree='Window: "Draft", App: Editor.\n0 standard window Draft\n\t1 list (focused) Places\n\t\t2 text (selectable) Port Alpha\n\t\t3 text (selected) Port Beta\n\t\t4 text (selectable) Port Gamma\nThe focused UI element is 1 list (focused) Places';
  const f=await outcomeFixture(t,{delivery:'sent-unverified',tree});
  const result=await f.js('await app.pickFromList("Port Beta"); await app.pressKey("Return"); void 0;');
  assert.equal(result.isError,false,text(result));
  assert.deepEqual(f.driverRequests.filter(([m])=>['click','pressKey'].includes(m)).map(([m])=>m),['click','pressKey']);
});

test('UC2D2 pickFromList can focus its list and then click its row inside one cell', worker,async t=>{
  let clicks=0;
  const state=(focused,selected)=>'Window: "Draft", App: Editor.\n0 standard window Draft\n\t1 list Places\n\t\t2 text (selectable) Port Alpha\n\t\t3 text (selectable) Port Beta\n\t\t4 text ('+(selected?'selected':'selectable')+') Port Gamma\nThe focused UI element is '+(focused?'1 list Places':'0 standard window Draft');
  const f=await outcomeFixture(t,{delivery:'sent-unverified',tree:state(false,false),afterClick:()=>state(true,++clicks>=2)});
  const result=await f.js('await app.pickFromList(1,"Port Gamma"); void 0;');
  assert.equal(result.isError,false,text(result));
  assert.deepEqual(f.driverRequests.filter(([m])=>m==='click').map(([,p])=>p.args),[[3],[4]]);
});
