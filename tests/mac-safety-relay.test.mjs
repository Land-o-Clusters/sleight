import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOwnRuntime, ownConfirmationPolicy } from '../plugins/sleight/lib/runtime-select.mjs';
import { macLeaseTarget, loadMacAppPolicy } from '../plugins/sleight/lib/mac-safety.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { PreapprovedApps, livePreapproved } from '../plugins/sleight/lib/preapproved.mjs';
import { createGrantAudit } from '../plugins/sleight/lib/preapproved-audit.mjs';
import { createPermissionCheck, appRefusal, pageRefusal, sitesLimited } from '../plugins/sleight/lib/permissions.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { approvalOptions, approvalCardText, shellRelayOptions } from '../plugins/sleight/lib/launch.mjs';
import { createPaymentCard } from '../plugins/sleight/lib/payment-card.mjs';
import { createV3Bridge, createV3Frontend, serveV3Worker } from '../plugins/sleight/lib/direct-browser/worker.mjs';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { launcherChains, classifiedChain } from './fixtures/mac-policy-ancestry.mjs';
import { replWorkerSkip } from './fixtures/repl-requirement.mjs';

const text = result => result?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
// A refused call cannot present a panel or emit a preparation notification.
// Observe its completion too, so a missing worker never strands the test.
async function beforeCallCompletes(ready, call) {
  let timer;
  try {
    await Promise.race([ready, call.then(result => assert.fail(`call completed before panel readiness: ${text(result)}`)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('panel readiness timed out')), 5000); })]);
  } finally { clearTimeout(timer); }
}
const root = t => { const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-rt8-'))); t.after(() => removeTemp(dir)); return dir; };
const initial = { windowId: '101', pid: 120, processStart: '1700000000.123456', bundleId: 'com.apple.TextEdit',
  app: 'TextEdit', title: 'Draft', bounds: { x: 20, y: 30, width: 800, height: 600 },
  identityVerified: true, onScreen: true, minimized: false };
const appPath = '/Applications/TextEdit.app';
const tree = window => `Window: "${window.title}", App: ${window.app}.\n0 standard window ${window.title}\n\t1 text field (focused) <redacted>\n\t2 button Done`;
async function fixture(t, options = {}) {
  const dir = root(t), requests = [], cards = [], writes = [];
  let window = { ...structuredClone(initial), ...options.window }, readId = 0;
  const driver = {
    async request(method, params) {
      requests.push({ method, params: structuredClone(params) });
      if (options.request) { const answer = await options.request(method, params); if (answer !== undefined) return answer; }
      const app = { id: window.bundleId, name: window.app, path: appPath, pid: window.pid,
        processStart: window.processStart, running: true, useCount: 0 };
      if (method === 'resolveApp') return { app, windows: options.noWindows ? [] : [structuredClone(window)] };
      if (method === 'getState') return { apps: [app], windows: [structuredClone(window)], errors: [] };
      if (method === 'verifyWindowIdentity') return { window: structuredClone(window) };
      if (method === 'rendererRestore') return { restored: true, token: params.args[0].lease.token };
      if (['getAXState', 'getAXStateAndScreenshot'].includes(method)) return { window: structuredClone(window),
        text: tree(window), readId: ++readId, truncated: false,
        ...method === 'getAXStateAndScreenshot' ? { screenshot: { data: 'iVBORw0KGgo=', mimeType: 'image/png' } } : {} };
      if (method === 'getScreenshot') return { window: structuredClone(window), screenshot: { data: 'iVBORw0KGgo=', mimeType: 'image/png' } };
      assert.fail(`unexpected driver request: ${method}`);
    }, async restart() {}, async close() {},
  };
  const input = new PassThrough(), output = new PassThrough(), pending = new Map(), elicitations = [], notifications = [];
  let next = 0, buffer = '';
  output.setEncoding('utf8').on('data', bytes => {
    buffer += bytes;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (message.method === 'elicitation/create') {
        elicitations.push(message);
        input.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { action: options.elicitationAnswer ?? 'accept' } }) + '\n');
      }
      if (message.method?.startsWith('notifications/')) { notifications.push(message); options.notification?.(message); }
      if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    }
  });
  const list = new PreapprovedApps({ version: 1, apps: options.preapproved ?? [] });
  const grantFile = join(dir, 'grants.json');
  writeFileSync(grantFile, JSON.stringify(options.preapproved ?? []), { mode: 0o600 });
  const live = livePreapproved(list, { file: grantFile,
    load: () => new PreapprovedApps({ version: 1, apps: JSON.parse(readFileSync(grantFile, 'utf8')) }) });
  const lease = new InputLease({ directory: join(dir, 'leases'), holder: 'rt8 test', ...options.leaseOptions });
  const runtime = await runOwnRuntime({ input, output, signals: new EventEmitter(), driver, lease,
    directBrowser: options.directBrowser,
    turboUnavailable: options.turboUnavailable,
    paymentCardFactory: options.paymentCardFactory,
    inputRegistrar: options.inputRegistrar,
    targetParents: options.targetParents ?? (() => [1]),
    ancestry: options.ancestry ?? (() => [{ pid: 500, path: '/Applications/TestHost.app/Contents/MacOS/Host' }]),
    allowForbidden: options.allowForbidden ?? (() => false),
    ownHostPid: options.defaultOwnHostPid ? undefined : options.ownHostPid ?? (() => false),
    policy: options.policy ?? (() => ({ allow: true, riskLevel: 'high' })),
    permissions: options.permissions ?? createPermissionCheck({ path: join(dir, 'permissions.json') }),
    // Production's own-runtime prompt is the JXA panel (askWithDialog), which can't verify a person's click,
    // so it never offers Always allow (F1). Mirror that unless a test says otherwise.
    ask: Object.assign(async (...args) => { cards.push(args); return options.ask ? options.ask(...args) : 'accept'; },
      { allowsAlways: options.allowsAlways ?? false }),
    approvalStorage: { load: () => list, live: () => live, add: (...args) => writes.push(args) },
    grantAudit: options.grantAudit ?? (() => {}),
    replOptions: { environment: () => ({ LANE_FIXTURE: '1' }), ...options.replOptions },
    relayOptions: { idleTurnEndMs: 0, ...options.relayOptions },
  });
  t.after(() => runtime.close());
  const request = (method, params) => new Promise(resolve => {
    const id = ++next; pending.set(id, resolve);
    if (options.turboUnavailable && method === 'tools/call') params = { ...params,
      _meta: { sleightShellDeadline: Date.now() + 300000, ...params._meta } };
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await request('initialize', { clientInfo: options.clientInfo ?? { name: 'claude-code', version: '1' },
    capabilities: options.capabilities ?? {} });
  const call = async code => (await request('tools/call', { name: 'js', arguments: { code } })).result;
  return { call, request, runtime, requests, cards, writes, dir, lease, elicitations, notifications,
    cancel: () => input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled',
      params: { requestId: next } }) + '\n'),
    revoke: () => writeFileSync(grantFile, '[]\n', { mode: 0o600 }),
    patch: value => { window = { ...window, ...value }; }, window: () => window };
}

test('own relay reads through one approval, masks secure fields, and refuses all input', { skip: replWorkerSkip }, async t => {
  const h = await fixture(t);
  const first = await h.call('let app = await cua.getApp("TextEdit");');
  assert.equal(first.isError, false, text(first));
  assert.match(text(first), /Window: "Draft", App: TextEdit\./);
  assert.match(text(first), /<redacted>/);
  assert.ok(text(first).includes(ownConfirmationPolicy(undefined, {})));
  assert.equal(h.cards.length, 1);
  for (const code of ['await app.getAXState();', 'await app.getAXState({ emit: false });',
    'await app.getScreenshot();', 'await app.getAXStateAndScreenshot();'])
    assert.equal((await h.call(code)).isError, false, code);
  for (const code of ['app.click(2)', 'app.doubleClick(2)', 'app.rightClick(2)', 'app.scroll(2,"down",1)',
    'app.drag(2,[20,30])', 'app.pressKey("super+s")', 'app.typeText("secret")', 'app.setValue(1,"secret")',
    'app.selectText(1,"secret")', 'app.performSecondaryAction(2,"press")', 'app.paste("secret")']) {
    const result = await h.call(`await ${code};`);
    assert.equal(result.isError, true, code + ': ' + text(result));
    assert.match(text(result), /METHOD_NOT_FOUND/);
    assert.match(text(result), /delivery=not-sent/);
    if (text(result).includes('call failed')) assert.match(text(result), /call failed \(no input was sent\)/);
    assert.doesNotMatch(text(result), /STALE_READ|partial input possible/);
  }
  assert.equal(h.cards.length, 1); assert.equal(h.writes.length, 0);
  assert.ok(h.requests.every(row => ['resolveApp', 'verifyWindowIdentity', 'getAXState', 'getScreenshot', 'getAXStateAndScreenshot'].includes(row.method)));
});

test('SA2S own relay acquires and reads TextEdit through the real loaded app policy and Claude Desktop chain', { skip: replWorkerSkip }, async t => {
  const h = await fixture(t, {
    policy: await loadMacAppPolicy({ executable: () => '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit' }),
    ancestry: () => classifiedChain(launcherChains.Desktop),
  });
  const first = await h.call('let app = await cua.getApp("TextEdit");');
  assert.equal(first.isError, false, text(first));
  assert.match(text(first), /Window: "Draft", App: TextEdit\./);
  assert.equal((await h.call('await app.getAXState();')).isError, false);
  assert.equal(h.cards.length, 1);
  assert.equal(h.requests.filter(row => row.method === 'getAXState').length, 2);
  assert.equal(h.writes.length, 0);
});

test('a not-sent refusal after earlier input describes only the failed action', { skip: replWorkerSkip }, async t => {
  const h = await fixture(t);
  assert.equal((await h.call('let app = await cua.getApp("TextEdit");')).isError, false);
  const request = h.runtime.runtime.safety.request;
  h.runtime.runtime.safety.request = async (method, params, context) => {
    if (method !== 'pressKey') return request(method, params, context);
    context.beforeRequest();
    // Simulate a sent action at the admission seam. No native input is posted.
    return { delivery: 'sent-unverified', retry: 'read-first' };
  };
  const result = await h.call('await app.pressKey("Return"); await app.click(2);');
  assert.equal(result.isError, true);
  assert.match(text(result), /METHOD_NOT_FOUND/);
  assert.match(text(result), /call failed \(failed action sent no input\)/);
  assert.doesNotMatch(text(result), /partial input possible/);
  assert.doesNotMatch(text(result), /call failed \(no input was sent\)/);
  assert.equal(h.requests.some(row => ['pressKey', 'click'].includes(row.method)), false);
});

test('own and engine relays refuse the same blocked turbo browser and engine browser site', async t => {
  const perms = { state: 'ok', apps: [{ id: 'com.google.Chrome', name: 'Google Chrome' }], sites: ['https://blocked.example'] };
  const permissions = { app: query => appRefusal(perms, query), page: page => pageRefusal(perms, page),
    sitesLimited: () => sitesLimited(perms) };
  const directCalls = [];
  const child = new EventEmitter(), channel = new EventEmitter();
  child.connected = channel.connected = true;
  child.send = value => queueMicrotask(() => channel.emit('message', structuredClone(value)));
  channel.send = value => queueMicrotask(() => child.emit('message', structuredClone(value)));
  child.disconnect = () => { child.connected = channel.connected = false; channel.emit('disconnect'); child.emit('disconnect'); };
  child.unref = () => {};
  const worker = serveV3Worker({ channel, browser: 'bfixture', async begin() {
    return { call: async call => { directCalls.push(call); return { text: 'must not reach turbo', isError: false }; },
      delivered: () => true, async end() { return { revoked: true, cleanup: [] }; } };
  } });
  const bridge = await createV3Bridge({}, { readConfig: () => ({ executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }), acceptPackage: () => ({ current: () => true }),
    shareConsent: () => undefined, forkWorker() { queueMicrotask(() => worker.ready()); return child; } });
  t.after(() => bridge.detach());
  assert.equal(await bridge.bind({ ...bridge.bootstrapEnvelope(), event: 'begin', turn: 'fixture1', text: 'read' }), true);
  const directBrowser = createV3Frontend(bridge);
  const own = await fixture(t, { permissions, directBrowser, relayOptions: { engineBrowserOpen: true } });
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const replies = [], sent = [];
  clientOut.on('data', bytes => replies.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  serverIn.on('data', bytes => sent.push(...bytes.toString().trim().split('\n').map(JSON.parse)));
  const engine = createRelay({ clientIn, clientOut, serverIn, serverOut, permissions, directBrowser,
    engineBrowserOpen: true, idleTurnEndMs: 0, warmRepl: false, warmEngine: false });
  t.after(async () => { await engine.close(); streams.forEach(stream => stream.destroy()); });
  for (const [id, name, args, expected] of [
    [1, 'browser_read', { tab: 't1' }, /You blocked sleight in Google Chrome/],
    [2, 'js', { code: 'await cua.createBrowserTab("test", "https://blocked.example");' }, /can't check the site of an engine browser call/],
    [3, 'browser_open', { browser: 'Safari', url: 'https://blocked.example' }, /You blocked sleight on https:\/\/blocked.example/],
  ]) {
    const ownResult = (await own.request('tools/call', { name, arguments: args })).result;
    clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
    const engineResult = replies.find(row => row.id === id)?.result;
    assert.equal(ownResult.isError, true, `${name}: ${text(ownResult)}`); assert.match(text(ownResult), expected);
    assert.deepEqual(ownResult, engineResult);
  }
  assert.equal(directCalls.length, 0); assert.equal(sent.length, 0); assert.equal(own.requests.length, 0);
});

test('revoking Always allow drops cached own approvals and already acquired handles', { skip: replWorkerSkip }, async t => {
  for (const answer of ['saved', 'always']) {
    let revoked = false;
    const h = await fixture(t, {
      preapproved: answer === 'saved' ? [{ app: initial.bundleId, riskLevel: 'high' }] : [],
      ask: () => revoked ? 'decline' : 'always',
      // Exercises the Always storage path with a prompt that can verify a person's click (none ships in 1.6.0).
      allowsAlways: true,
    });
    assert.equal((await h.call('let app = await cua.getApp("TextEdit");')).isError, false);
    const before = h.requests.filter(row => row.method === 'getAXState').length;
    h.revoke(); revoked = true;
    const result = await h.call('await app.getAXState();');
    assert.equal(result.isError, true, text(result));
    assert.equal(h.requests.filter(row => row.method === 'getAXState').length, before);
    const reacquire = await h.call('await cua.getApp("TextEdit");');
    assert.equal(reacquire.isError, true, text(reacquire));
    assert.match(text(reacquire), /declined/);
    assert.equal(h.cards.length, answer === 'saved' ? 1 : 2);
  }
});

test('SA2U Glide keeps terminals, OpenAI apps and ancestry hosts refused under the override', { skip: replWorkerSkip }, async t => {
  for (const window of [{ bundleId: 'com.apple.Terminal', app: 'Terminal' },
    { bundleId: 'com.openai.codex', app: 'ChatGPT' }, { pid: 500 }]) {
    const h = await fixture(t, { window, allowForbidden: () => true });
    assert.equal((await h.call('await cua.getApp("target");')).isError, true);
    assert.equal(h.cards.length, 0);
    assert.equal(h.requests.filter(row => row.method === 'getAXState').length, 0);
  }
});

test('own facade forwards capture format and scale through parent admission', { skip: replWorkerSkip }, async t => {
  const h = await fixture(t);
  assert.equal((await h.call('let app = await cua.getApp("TextEdit");')).isError, false);
  for (const method of ['getScreenshot', 'getAXStateAndScreenshot']) {
    const token = [...h.lease.owned.values()][0];
    assert.equal(typeof token, 'string');
    const renderer = method === 'getAXStateAndScreenshot' ? { menuRequests: [], args: [{ renderer: true,
      lease: { pid: initial.pid, processStart: initial.processStart, bundleId: initial.bundleId, token } }] } : {};
    for (const format of ['png', 'jpeg']) for (const scale of ['pixel', 'point']) {
      assert.equal((await h.call(`await app.${method}({ format: "${format}", scale: "${scale}" });`)).isError, false);
      assert.deepEqual(h.requests.findLast(row => row.method === method).params,
        { windowId: initial.windowId, processStart: initial.processStart, format, scale, ...renderer });
    }
    assert.equal((await h.call(`await app.${method}();`)).isError, false);
    assert.deepEqual(h.requests.findLast(row => row.method === method).params,
      { windowId: initial.windowId, processStart: initial.processStart, ...renderer });
    for (const options of [{ format: 'jpg' }, { format: null }, { format: 1 }, { format: '' }, { format: ['png'] },
      { format: {} }, { format: true }, { scale: 'points' }, { scale: null }, { scale: 1 }, { scale: '' },
      { scale: ['pixel'] }, { scale: {} }, { scale: true }]) {
      const before = h.requests.length;
      const result = await h.call(`await app.${method}(${JSON.stringify(options)});`);
      // API1B answers bad capture options with its one-line fix instead of the raw INVALID_PARAMS code.
      assert.equal(result.isError, true);
      assert.match(text(result), /INVALID_PARAMS|formats: png\/jpeg; scales: pixel\/point\. Operation not sent\./);
      assert.equal(h.requests.length, before, `${method} ${JSON.stringify(options)} called a driver`);
    }
  }
});

test('own and engine cards use the same host wording and display app name', { skip: replWorkerSkip }, async t => {
  for (const [shellRoute, clientInfo, answer] of [
    [false, { name: 'claude-code' }, 'accept'], [false, { name: 'codex-mcp-client', title: 'Codex' }, 'accept'],
    [false, { name: 'cursor-vscode' }, 'accept'], [false, { name: '<unknown>' }, 'accept'],
  ]) {
    const cards = [], writes = [];
    const ask = async (...args) => { cards.push(args); return answer; };
    const options = shellRoute ? shellRelayOptions(ask) : approvalOptions({ SLEIGHT_APPROVAL_PROMPT: 'dialog' }, ask);
    const streams = Array.from({ length: 4 }, () => new PassThrough());
    const [clientIn, clientOut, serverIn, serverOut] = streams;
    const replies = [];
    serverIn.on('data', bytes => replies.push(...String(bytes).trim().split('\n').map(JSON.parse)));
    const engine = createRelay({ clientIn, clientOut, serverIn, serverOut, ...options,
      resolveApprovalApp: async () => initial.bundleId,
      alwaysAllow: (...args) => writes.push(args),
      idleTurnEndMs: 0, warmRepl: false, warmEngine: false, changeReview: false });
    t.after(async () => { await engine.close(); streams.forEach(stream => stream.destroy()); });
    const own = await fixture(t, { clientInfo, ask: () => answer,
      turboUnavailable: shellRoute ? options.turboUnavailable : undefined });
    clientIn.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo } }) + '\n');
    serverOut.write(JSON.stringify({ id: 'app-card', method: 'elicitation/create', params: {
      message: 'Allow Computer Use to use "TextEdit"?', _meta: { connector_id: 'computer-use',
        tool_params: { app: initial.bundleId }, persist: ['session', 'always'], riskLevel: 'high' },
    } }) + '\n');
    const result = await own.call('await cua.getApp("TextEdit");');
    for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(cards.length, 1); assert.equal(own.cards.length, 1);
    assert.equal(own.cards[0][0], 'Allow Computer Use to use "TextEdit"?');
    assert.equal(own.cards[0][2].always, false, 'the JXA panel never offers Always allow');
    assert.deepEqual(approvalCardText(...own.cards[0]), approvalCardText(...cards[0]));
    assert.equal(result.isError, answer === 'always' && shellRoute, text(result));
    assert.equal(replies.find(row => row.id === 'app-card')?.result.action,
      answer === 'always' && shellRoute ? 'cancel' : 'accept');
    assert.equal(writes.length, 0); assert.equal(own.writes.length, 0);
  }
});

function engineCards(t, { scope = 'session', ask, panel, promptSetting = 'dialog', capabilities = {},
  clientInfo = { name: 'claude-code' }, documentAnswer = 'accept',
  env = { SLEIGHT_APPROVAL_PROMPT: promptSetting } } = {}) {
  const streams = Array.from({ length: 4 }, () => new PassThrough());
  const [clientIn, clientOut, serverIn, serverOut] = streams;
  const options = panel ? shellRelayOptions(undefined, panel) : approvalOptions(env, ask);
  const elicitations = [], pending = new Map();
  clientOut.on('data', bytes => {
    for (const row of String(bytes).trim().split('\n').map(JSON.parse)) {
      if (row.method === 'elicitation/create') {
        elicitations.push(row);
        clientIn.write(JSON.stringify({ id: row.id, result: {
          action: row.params.message.startsWith('Allow Claude to use') ? documentAnswer : 'accept',
        } }) + '\n');
      }
      if (pending.has(row.id)) { pending.get(row.id)(row.result); pending.delete(row.id); }
    }
  });
  const engine = createRelay({ clientIn, clientOut, serverIn, serverOut, ...options, approvalScope: scope,
    resolveApprovalApp: async () => initial.bundleId, alwaysAllow() { assert.fail('unexpected persistent grant'); },
    idleTurnEndMs: 0, warmRepl: false, warmEngine: false, changeReview: false });
  t.after(async () => { await engine.close(); streams.forEach(stream => stream.destroy()); });
  clientIn.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo, capabilities } }) + '\n');
  let next = 0;
  return { elicitations, document() {
    const id = `document-scope-${++next}`;
    return new Promise(resolve => {
      pending.set(id, resolve);
      clientIn.write(JSON.stringify({ id, method: 'tools/call', params: { name: 'document_scope', arguments: {} } }) + '\n');
    });
  }, async card() {
    const id = `scope-card-${++next}`;
    const waitMessage = (stream, expected) => new Promise(resolve => {
      const receive = bytes => {
        for (const row of String(bytes).trim().split('\n').map(JSON.parse)) if (row.id === expected) {
          stream.off('data', receive); resolve(row);
        }
      };
      stream.on('data', receive);
    });
    const callId = `document-read-${next}`;
    let completed;
    if (scope === 'document') {
      const forwarded = waitMessage(serverIn, callId);
      completed = waitMessage(clientOut, callId);
      clientIn.write(JSON.stringify({ id: callId, method: 'tools/call', params: {
        name: 'js', arguments: { code: 'await cua.getApp("TextEdit");' },
      } }) + '\n');
      await forwarded;
    }
    const reply = new Promise(resolve => {
      const receive = bytes => {
        for (const row of String(bytes).trim().split('\n').map(JSON.parse)) if (row.id === id) {
          serverIn.off('data', receive); resolve(row);
        }
      };
      serverIn.on('data', receive);
    });
    serverOut.write(JSON.stringify({ id, method: 'elicitation/create', params: {
      message: 'Allow Computer Use to use "TextEdit"?', _meta: { connector_id: 'computer-use',
        tool_params: { app: initial.bundleId }, persist: ['session', 'always'], riskLevel: 'high' },
    } }) + '\n');
    const result = (await reply).result;
    if (completed) {
      serverOut.write(JSON.stringify({ id: callId, result: { content: [{ type: 'text', text: tree(initial) }] } }) + '\n');
      await completed;
    }
    return result;
  }, marker: options.turboUnavailable };
}

test('own and engine honor each approval scope for card choices and repeated acquisitions', { skip: replWorkerSkip }, async t => {
  for (const [setting, scope, count] of [[undefined, 'session', 1], ['session', 'session', 1],
    ['once', 'once', 2], ['document', 'document', 2], ['invalid', 'session', 1]]) {
    await t.test(`SLEIGHT_APPROVAL_SCOPE=${setting}`, async t => {
      const old = process.env.SLEIGHT_APPROVAL_SCOPE;
      t.after(() => { if (old === undefined) delete process.env.SLEIGHT_APPROVAL_SCOPE; else process.env.SLEIGHT_APPROVAL_SCOPE = old; });
      if (setting === undefined) delete process.env.SLEIGHT_APPROVAL_SCOPE; else process.env.SLEIGHT_APPROVAL_SCOPE = setting;
      const cards = [];
      const engine = engineCards(t, { scope, ask: async (...args) => { cards.push(args); return 'accept'; } });
      const own = await fixture(t);
      for (let i = 0; i < 2; i++) {
        assert.equal((await engine.card()).action, 'accept');
        const result = await own.call('await cua.getApp("TextEdit");');
        assert.equal(result.isError, false, text(result));
      }
      assert.equal(cards.length, count); assert.equal(own.cards.length, count);
      for (let i = 0; i < count; i++) {
        assert.equal(own.cards[i][1], scope === 'session');
        assert.equal(own.cards[i][2].always, false, 'the JXA panel never offers Always allow');
        assert.equal(cards[i][1], scope === 'session');
        assert.equal(cards[i][2]?.always === true, false, 'dialog mode never offers Always allow');
        if (scope !== 'document') assert.deepEqual(approvalCardText(...own.cards[i]), approvalCardText(...cards[i]));
      }
      assert.equal(own.writes.length, 0);
    });
  }
});

test('non-shell own and engine route document questions through the same host selection', { skip: replWorkerSkip }, async t => {
  for (const [setting, capabilities, route] of [
    [undefined, {}, 'dialog'], [undefined, { elicitation: { form: {} } }, 'client'],
    ['dialog', { elicitation: { form: {} } }, 'dialog'], ['client', { elicitation: { form: {} } }, 'client'],
  ]) for (const answer of ['accept', 'decline']) await t.test(`${setting ?? 'default'} ${route} ${answer}`, async t => {
    const env = { SLEIGHT_APPROVAL_SCOPE: 'document', SLEIGHT_APPROVAL_PROMPT: setting, CLAUDE_CODE_ENTRYPOINT: undefined };
    const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
    t.after(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    });
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    const engineAsked = [];
    const engine = engineCards(t, { scope: 'document', env, capabilities, documentAnswer: answer,
      ask: async (...args) => { engineAsked.push(args); return args[0].startsWith('Allow Claude to use') ? answer : 'accept'; } });
    const own = await fixture(t, { capabilities, elicitationAnswer: answer,
      ask: message => message.startsWith('Allow Claude to use') ? answer : 'accept' });
    assert.equal((await engine.card()).action, 'accept');
    assert.equal((await own.call('await cua.getApp("TextEdit");')).isError, false);
    const before = [engineAsked.length, engine.elicitations.length, own.cards.length, own.elicitations.length];
    const expected = await engine.document();
    const actual = (await own.request('tools/call', { name: 'document_scope', arguments: {} })).result;
    assert.equal(actual.isError, expected.isError);
    assert.equal(text(actual), text(expected));
    assert.match(text(actual), answer === 'accept' ? /Approved.*Draft/ : /user did not approve this document/);
    assert.deepEqual([engineAsked.length - before[0], engine.elicitations.length - before[1],
      own.cards.length - before[2], own.elicitations.length - before[3]], route === 'dialog' ? [1, 0, 1, 0] : [0, 1, 0, 1]);
    if (route === 'dialog') assert.deepEqual(own.cards.at(-1), engineAsked.at(-1));
    else assert.deepEqual(own.elicitations.at(-1).params, engine.elicitations.at(-1).params);
    assert.equal(own.writes.length, 0);
  });
});

test('own never persists an Always answer when the scope excludes it', { skip: replWorkerSkip }, async t => {
  for (const scope of ['once', 'document']) await t.test(scope, async t => {
    const old = process.env.SLEIGHT_APPROVAL_SCOPE;
    t.after(() => { if (old === undefined) delete process.env.SLEIGHT_APPROVAL_SCOPE; else process.env.SLEIGHT_APPROVAL_SCOPE = old; });
    process.env.SLEIGHT_APPROVAL_SCOPE = scope;
    const own = await fixture(t, { ask: () => 'always' });
    assert.equal((await own.call('await cua.getApp("TextEdit");')).isError, true);
    assert.equal(own.writes.length, 0);
    assert.equal(own.requests.some(row => row.method === 'getAXState'), false);
  });
});

test('once own and engine ask on each action using the same acquired app', { skip: replWorkerSkip }, async t => {
  const old = process.env.SLEIGHT_APPROVAL_SCOPE;
  t.after(() => { if (old === undefined) delete process.env.SLEIGHT_APPROVAL_SCOPE; else process.env.SLEIGHT_APPROVAL_SCOPE = old; });
  process.env.SLEIGHT_APPROVAL_SCOPE = 'once';
  const cards = [];
  const engine = engineCards(t, { scope: 'once', ask: async (...args) => { cards.push(args); return 'accept'; } });
  const own = await fixture(t);
  for (const code of ['let app = await cua.getApp("TextEdit");', 'await app.getAXState();',
    'await app.getScreenshot();', 'await app.getAXStateAndScreenshot();']) {
    assert.equal((await engine.card()).action, 'accept');
    const result = await own.call(code);
    assert.equal(result.isError, false, text(result));
  }
  assert.equal(own.cards.length, 4); assert.equal(cards.length, 4);
  assert.deepEqual(own.cards.map(card => approvalCardText(...card)), cards.map(card => approvalCardText(...card)));
  assert.equal(own.writes.length, 0);
});

test('shell document scope uses the trusted panel even when the client would auto-accept', { skip: replWorkerSkip }, async t => {
  const old = process.env.SLEIGHT_APPROVAL_SCOPE;
  t.after(() => { if (old === undefined) delete process.env.SLEIGHT_APPROVAL_SCOPE; else process.env.SLEIGHT_APPROVAL_SCOPE = old; });
  process.env.SLEIGHT_APPROVAL_SCOPE = 'document';
  const panel = fakePanel(t, 'once');
  const own = await fixture(t, { turboUnavailable: shellRelayOptions(undefined, null).turboUnavailable,
    paymentCardFactory: () => panel.card, capabilities: { elicitation: { form: {} } } });
  const read = await own.call('let app = await cua.getApp("TextEdit");');
  assert.equal(read.isError, false, text(read));
  const result = (await own.request('tools/call', { name: 'document_scope', arguments: {} })).result;
  assert.equal(result.isError, undefined, text(result));
  assert.match(text(result), /Approved.*Draft/);
  assert.equal(own.elicitations.length, 0);
  assert.equal(own.cards.length, 0); assert.equal(panel.shown.length, 2);
  assert.match(panel.shown[1].payload.operation.request, /Draft/);
  assert.deepEqual(panel.shown[1].choices, ['once', 'cancel']);
  own.patch({ windowId: '102', title: 'Second Draft' });
  assert.equal((await own.call('let second = await cua.getApp("TextEdit");')).isError, false);
  const second = (await own.request('tools/call', { name: 'document_scope', arguments: {} })).result;
  assert.match(text(second), /Approved.*Second Draft/);
  assert.equal(own.elicitations.length, 0); assert.equal(panel.shown.length, 4);
  assert.match(panel.shown[3].payload.operation.request, /Second Draft/);
});

test('a trusted document decline cannot be replaced by the shell client approval', { skip: replWorkerSkip }, async t => {
  const old = process.env.SLEIGHT_APPROVAL_SCOPE;
  t.after(() => { if (old === undefined) delete process.env.SLEIGHT_APPROVAL_SCOPE; else process.env.SLEIGHT_APPROVAL_SCOPE = old; });
  process.env.SLEIGHT_APPROVAL_SCOPE = 'document';
  let questions = 0;
  const panel = fakePanel(t, () => ++questions === 1 ? 'once' : 'cancel');
  const own = await fixture(t, { turboUnavailable: shellRelayOptions(undefined, null).turboUnavailable,
    paymentCardFactory: () => panel.card, capabilities: { elicitation: { form: {} } } });
  assert.equal((await own.call('let app = await cua.getApp("TextEdit");')).isError, false);
  const result = (await own.request('tools/call', { name: 'document_scope', arguments: {} })).result;
  assert.equal(result.isError, true); assert.match(text(result), /user did not approve this document/);
  assert.equal(own.elicitations.length, 0); assert.equal(panel.shown.length, 2);
});

test('shell cards reject missing or expired request deadlines before showing or reading', { skip: replWorkerSkip }, async t => {
  let panel;
  const own = await fixture(t, { turboUnavailable: shellRelayOptions(undefined, null).turboUnavailable,
    paymentCardFactory: options => (panel = fakePanel(t, 'once', options)).card });
  for (const deadline of [undefined, Date.now() - 1]) {
    const result = (await own.request('tools/call', { name: 'js', arguments: { code: 'await cua.getApp("TextEdit");' },
      _meta: { sleightShellDeadline: deadline } })).result;
    assert.equal(result.isError, true); assert.match(text(result), /consent panel unavailable/);
  }
  assert.equal(panel.shown.length, 0); assert.equal(own.cards.length, 0);
  assert.equal(own.requests.some(row => row.method === 'getAXState'), false);
});

test('shell cancellation retires a pending card and never reads the app', { skip: replWorkerSkip }, async t => {
  let panel;
  const own = await fixture(t, { turboUnavailable: shellRelayOptions(undefined, null).turboUnavailable,
    paymentCardFactory: options => (panel = fakePanel(t, undefined, options)).card });
  const call = own.call('await cua.getApp("TextEdit");');
  await beforeCallCompletes(panel.ready, call); own.cancel();
  const result = await call;
  assert.equal(result.isError, true); assert.match(text(result), /consent panel unavailable/);
  assert.equal(panel.shown.length, 1); assert.equal(own.cards.length, 0);
  assert.equal(own.requests.some(row => row.method === 'getAXState'), false);
});

test('shell preparation uses the 175 second budget and rejects a 20 second budget', { skip: replWorkerSkip }, async t => {
  for (const [budget, elapsed, approved] of [[175000, 21000, true], [20000, 21000, false], [175000, 175000, false]]) {
    await t.test(`budget=${budget} elapsed=${elapsed}`, async t => {
      let finish, started = 0, opened = 0, requesting;
      let now = Date.now(), nextTimer = 0;
      const timers = new Map();
      const clock = {
        setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; },
        clearTimeout(id) { timers.delete(id); },
      };
      const requested = new Promise(resolve => { requesting = resolve; });
      const built = new Promise(resolve => { finish = resolve; });
      t.after(() => finish({ status: 'ready' }));
      const own = await fixture(t, { turboUnavailable: shellRelayOptions(undefined, null).turboUnavailable,
        notification: message => { if (message.params?.state === 'preparing') requesting(); },
        paymentCardFactory: options => {
          assert.equal(options.prepareTimeoutMs, 175000);
          return createPaymentCard({ ...options, prepareTimeoutMs: budget, clock, now: () => now,
            prepare: () => { started++; return built; },
            open: async () => { opened++; return {
              present(_id, _payload, _choices, answer) { answer({ choice: 'once' }); },
              authenticate: () => true, close() {},
            }; },
          });
        } });
      await Promise.resolve(); await Promise.resolve();
      assert.equal(started, 1, 'preparation must start before the first tool call');
      const pending = own.runtime.runtime.safety.request('getApp', { selector: 'TextEdit' });
      // Direct safety calls have no shell envelope, so use the normal transport for the cold request.
      await assert.rejects(pending, { code: 'SLEIGHT_PROMPT_UNAVAILABLE' });
      const call = own.call('await cua.getApp("TextEdit");');
      await beforeCallCompletes(requested, call);
      assert.ok(own.notifications.some(row => row.params?.state === 'preparing'));
      assert.deepEqual([...timers.values()].map(timer => timer.at - now), [budget]);
      now += elapsed;
      for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); }
      finish({ status: 'ready' });
      const result = await call;
      assert.equal(result.isError, !approved, text(result)); assert.equal(opened, approved ? 1 : 0); assert.equal(started, 1);
      assert.ok(own.notifications.some(row => row.params?.state === (approved ? 'answered' : 'unavailable')));
      assert.equal(timers.size, 0);
    });
  }
});

function fakePanel(t, choice, options = {}) {
  const shown = [], closed = [];
  let presented;
  const ready = new Promise(resolve => { presented = resolve; });
  const card = createPaymentCard({ ...options, prepare: async () => ({ status: 'ready' }), open: async () => ({
    present(id, payload, choices, answer) {
      shown.push({ payload, choices }); presented();
      if (choice !== undefined) queueMicrotask(() => answer({ choice: typeof choice === 'function' ? choice() : choice }));
    },
    authenticate: () => true, close() { closed.push(true); },
  }) });
  t.after(() => card.close());
  return { card, shown, closed, ready };
}

test('shell own and engine use the consent panel, never the dialog adapter', { skip: replWorkerSkip }, async t => {
  for (const choice of ['once', 'cancel', 'always']) await t.test(choice, async t => {
    const enginePanel = fakePanel(t, choice), ownPanel = fakePanel(t, choice);
    const engine = engineCards(t, { panel: enginePanel.card });
    let built = 0;
    const own = await fixture(t, { turboUnavailable: engine.marker, ask: () => 'cancel',
      paymentCardFactory: () => { built++; return ownPanel.card; } });
    const result = await own.call('await cua.getApp("TextEdit");');
    const answer = await engine.card();
    assert.equal(own.cards.length, 0, 'shell approval reached the osascript dialog adapter');
    assert.equal(built, 1); assert.equal(ownPanel.shown.length, 1); assert.equal(enginePanel.shown.length, 1);
    assert.deepEqual(ownPanel.shown, enginePanel.shown);
    assert.deepEqual(ownPanel.shown[0].choices, ['once', 'cancel']);
    assert.equal(ownPanel.shown[0].payload.presentation.kind, 'app');
    assert.equal(result.isError, choice !== 'once', text(result));
    assert.equal(answer.action, choice === 'once' ? 'accept' : 'cancel');
    assert.equal(own.writes.length, 0);
    await own.runtime.close();
    assert.equal(ownPanel.closed.length, 1, 'own shutdown must collect its consent host');
  });
});

test('closing own cancels its pending shell panel before any content read', async t => {
  const panel = fakePanel(t);
  const own = await fixture(t, { turboUnavailable: shellRelayOptions(undefined, null).turboUnavailable,
    paymentCardFactory: () => panel.card });
  const pending = assert.rejects(own.runtime.runtime.safety.request('getApp', { selector: 'TextEdit' }),
    { code: 'SLEIGHT_PROMPT_UNAVAILABLE' });
  await beforeCallCompletes(panel.ready, pending);
  await own.runtime.close(); await pending;
  assert.equal(panel.closed.length, 1); assert.equal(own.cards.length, 0);
  assert.equal(own.requests.some(row => row.method === 'getAXState'), false);
});

test('shell panel readiness fails fast when the real client refuses an unsupported worker', async t => {
  let panel;
  const own = await fixture(t, { turboUnavailable: shellRelayOptions(undefined, null).turboUnavailable,
    replOptions: { selectNode: () => undefined },
    paymentCardFactory: options => (panel = fakePanel(t, undefined, options)).card });
  const call = own.call('await cua.getApp("TextEdit");');
  await assert.rejects(beforeCallCompletes(panel.ready, call), /call completed before panel readiness: REPL_NODE_UNSUPPORTED/);
  assert.equal(panel.shown.length, 0); assert.equal(own.cards.length, 0);
  assert.equal(own.requests.length, 0);
});

test('unavailable shell consent never falls back to a dialog or grants access', { skip: replWorkerSkip }, async t => {
  const card = createPaymentCard({ prepare: async () => undefined, open: async () => assert.fail('unprepared host') });
  const own = await fixture(t, { turboUnavailable: shellRelayOptions(undefined, null).turboUnavailable,
    paymentCardFactory: () => card });
  const result = await own.call('await cua.getApp("TextEdit");');
  assert.equal(result.isError, true); assert.match(text(result), /consent panel unavailable/);
  assert.equal(own.cards.length, 0); assert.equal(own.writes.length, 0);
  assert.equal(own.requests.some(row => row.method === 'getAXState'), false);
});

test('ordinary own startup creates no consent card', { skip: replWorkerSkip }, async t => {
  const own = await fixture(t, { paymentCardFactory: () => assert.fail('unused consent card') });
  const result = await own.call('await cua.getApp("TextEdit");');
  assert.equal(result.isError, false, text(result)); assert.equal(own.cards.length, 1);
});

test('own capture reaches relay image processing with its parent frame note exactly once', { skip: replWorkerSkip }, async t => {
  const bytes = Buffer.alloc(25);
  bytes.writeUInt32BE(0x89504e47, 0); bytes.writeUInt32BE(800, 16); bytes.writeUInt32BE(600, 20);
  const screenshot = { data: bytes.toString('base64'), mimeType: 'image/png' }, delivered = [];
  const note = 'Screenshot frame: 800x600 pixels; window bounds (20, 30, 800, 600) points; scale 1.0000x1.0000 pixels per point; origin top-left; window-only, overlays excluded.';
  const h = await fixture(t, { request: method => method === 'getScreenshot'
    ? { window: structuredClone(initial), screenshot, capture: { status: 'ok', note } } : undefined,
    relayOptions: { cursor: { screenshot: images => delivered.push(images), close() {} } } });
  await h.call('let app = await cua.getApp("TextEdit");');
  const result = await h.call('await app.getScreenshot({scale:"point"});');
  assert.equal(result.isError, false, text(result));
  assert.equal(result.content.filter(item => item.type === 'image').length, 1);
  assert.equal(result.content.filter(item => item.text === note).length, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(delivered, [[{ type: 'image', ...screenshot }]], 'relay must observe the parent image before display output is appended');
  const hidden = await h.call('await app.getScreenshot({emit:false}); void 0;');
  assert.equal(hidden.content.some(item => item.type === 'image' || item.text === note), false);
  assert.equal(delivered.length, 1);
});

test('decline is remembered for the session before the first content read', { skip: replWorkerSkip }, async t => {
  const h = await fixture(t, { ask: () => 'decline' });
  for (let i = 0; i < 2; i++) {
    const result = await h.call('await cua.getApp("TextEdit");');
    assert.equal(result.isError, true); assert.match(text(result), /declined/);
    assert.doesNotMatch(text(result), /Window: "Draft"/);
  }
  assert.equal(h.cards.length, 1);
  assert.deepEqual(h.requests.map(row => row.method), ['resolveApp', 'resolveApp']);
});

test('Allow and Always allow persist across reset and turn end, only the card writes Always allow', { skip: replWorkerSkip }, async t => {
  for (const answer of ['accept', 'always']) {
    // A prompt that can verify a person's click; the JXA panel can't, and the case below checks it refuses Always.
    const h = await fixture(t, { ask: () => answer, allowsAlways: true });
    assert.equal((await h.call('let app = await cua.getApp("TextEdit");')).isError, false);
    await h.request('tools/call', { name: 'turn_ended', arguments: {} });
    assert.equal((await h.call('await app.getAXState();')).isError, true, 'turn end expires parent bindings');
    await h.request('tools/call', { name: 'js_reset', arguments: {} });
    assert.equal((await h.call('let app = await cua.getApp("TextEdit");')).isError, false);
    assert.equal(h.cards.length, 1); assert.equal(h.writes.length, answer === 'always' ? 1 : 0);
    if (answer === 'always') assert.deepEqual(h.writes, [['com.apple.TextEdit', 'high']]);
  }
});

test('terminals, OpenAI apps and the ancestry host refuse before any card or content', { skip: replWorkerSkip }, async t => {
  for (const window of [
    { bundleId: 'com.apple.Terminal', app: 'Terminal' },
    { bundleId: 'com.openai.codex', app: 'ChatGPT' },
    { bundleId: 'com.openai.future', app: 'Other AI' },
    { pid: 500 },
  ]) {
    const h = await fixture(t, { window });
    const result = await h.call('await cua.getApp("target");');
    assert.equal(result.isError, true, JSON.stringify(window) + ': ' + text(result)); assert.match(text(result), /Only the user may lift/);
    assert.equal(h.cards.length, 0); assert.deepEqual(h.requests.map(row => row.method), ['resolveApp']);
  }
});

test('SA2U Glide ignores forbidden override and never lifts sleight cards', { skip: replWorkerSkip }, async t => {
  for (const window of [{ bundleId: 'com.apple.Terminal', app: 'Terminal' },
    { bundleId: 'com.openai.chat', app: 'ChatGPT' }]) {
    const h = await fixture(t, { window, allowForbidden: () => true });
    const result = await h.call('await cua.getApp("target");');
    assert.equal(result.isError, true); assert.match(text(result), /terminal or agent host/);
    assert.equal(h.requests.filter(row => row.method === 'getAXState').length, 0);
    assert.equal(h.cards.length, 0);
  }
  const own = await fixture(t, { window: { bundleId: 'com.example.Consent', app: 'consent-host' }, allowForbidden: () => true });
  assert.match(text(await own.call('await cua.getApp("target");')), /only you can answer/);
  assert.equal(own.cards.length, 0);
});

test('RT28 policy, missing policy and failed ancestry stop before reads', { skip: replWorkerSkip }, async t => {
  const calls = [];
  const h = await fixture(t, { policy: (...args) => { calls.push(args); return { allow: false, code: 'PASSWORD_MANAGER', message: 'Password managers are refused.' }; } });
  assert.match(text(await h.call('await cua.getApp("target");')), /Password managers are refused/);
  assert.equal(calls[0][0], initial.bundleId); assert.ok(Array.isArray(calls[0][1])); assert.equal(calls[0][2], 'Draft');
  const missing = await fixture(t, { policy: await loadMacAppPolicy({ load: async () => { throw Error('missing'); } }) });
  assert.match(text(await missing.call('await cua.getApp("target");')), /app policy is unavailable/);
  const ancestry = await fixture(t, { ancestry: () => { throw Error('unavailable'); } });
  assert.match(text(await ancestry.call('await cua.getApp("target");')), /host could not be verified/);
  assert.equal(h.cards.length + missing.cards.length + ancestry.cards.length, 0);
  assert.match(text(await missing.call('await cua.getState();')), /app policy is unavailable/);
});

test('owned approval helper PIDs refuse even when app metadata uses an alias', { skip: replWorkerSkip }, async t => {
  const h = await fixture(t, { ownHostPid: pid => pid === initial.pid, allowForbidden: () => true });
  const result = await h.call('await cua.getApp("Some Alias");');
  assert.equal(result.isError, true); assert.match(text(result), /only you can answer/);
  assert.equal(h.cards.length, 0); assert.deepEqual(h.requests.map(row => row.method), ['resolveApp']);
});

test('leases bind window number and process start, block another session and expire', { skip: replWorkerSkip }, async t => {
  const h = await fixture(t);
  const other = new InputLease({ directory: join(h.dir, 'leases'), holder: 'other session' });
  t.after(() => other.close());
  other.acquire(macLeaseTarget(h.window()), 'window');
  const refused = await h.call('await cua.getApp("TextEdit");');
  assert.equal(refused.isError, true); assert.match(text(refused), /Input lease/);
  assert.equal(h.requests.filter(row => row.method === 'getAXState').length, 0);
  other.release();
  assert.equal((await h.call('let app = await cua.getApp("TextEdit");')).isError, false);
  h.lease.release();
  const lost = await h.call('await app.getAXState();');
  assert.equal(lost.isError, true); assert.match(text(lost), /Input lease/);
  assert.notDeepEqual(macLeaseTarget(initial), macLeaseTarget({ ...initial, processStart: 'replacement' }));
  let now = 100000;
  const expired = await fixture(t, { leaseOptions: { now: () => now } });
  await expired.call('let app = await cua.getApp("TextEdit");'); now += 30001;
  assert.match(text(await expired.call('await app.getAXState();')), /ownership lost or expired/);
  assert.equal(expired.requests.filter(row => row.method === 'getAXState').length, 1);
});

test('window, PID, process start, bundle or unverified replacement cannot reach a read', { skip: replWorkerSkip }, async t => {
  for (const patch of [{ windowId: '102' }, { pid: 121 }, { processStart: 'restarted' },
    { bundleId: 'com.example.Other' }, { identityVerified: false }]) {
    const h = await fixture(t);
    assert.equal((await h.call('let app = await cua.getApp("TextEdit");')).isError, false);
    h.patch(patch);
    const result = await h.call('await app.getAXState();');
    assert.equal(result.isError, true, JSON.stringify(patch));
    assert.match(text(result), /IDENTITY_CHANGED|IDENTITY_UNVERIFIED/);
    assert.equal(h.requests.filter(row => row.method === 'getAXState').length, 1);
  }
});

test('title changes with stable identity and bounds pass, title plus bounds change refuses', { skip: replWorkerSkip }, async t => {
  const h = await fixture(t);
  await h.call('let app = await cua.getApp("TextEdit");');
  h.patch({ title: 'Saved.txt' });
  const saved = await h.call('await app.getAXState();');
  assert.equal(saved.isError, false, text(saved)); assert.match(text(saved), /Window: "Saved.txt"/);
  h.patch({ title: 'Other', bounds: { ...initial.bounds, x: 40 } });
  assert.equal((await h.call('await app.getAXState();')).isError, true);
});

test('app blocks and site limits apply before content, including session-approved apps', { skip: replWorkerSkip }, async t => {
  let blocked = false;
  const h = await fixture(t, { permissions: { app: () => blocked ? 'User blocked this app.' : undefined,
    page() {}, sitesLimited: () => false } });
  await h.call('let app = await cua.getApp("TextEdit");'); blocked = true;
  assert.match(text(await h.call('await app.getAXState();')), /User blocked this app/);
  assert.equal(h.requests.filter(row => row.method === 'getAXState').length, 1);
  const limited = await fixture(t, { permissions: { app() {}, sitesLimited: () => true, page: () => 'Site identity is unproven.' } });
  assert.match(text(await limited.call('await cua.getApp("target");')), /Site identity is unproven/);
  assert.equal(limited.requests.filter(row => row.method === 'getAXState').length, 0);
});

test('inventory exposes no unapproved windows, title or paths', { skip: replWorkerSkip }, async t => {
  const h = await fixture(t);
  const result = await h.call('await cua.getState();');
  assert.equal(result.isError, false, text(result));
  assert.match(text(result), /"windows":\[\]/); assert.doesNotMatch(text(result), /Window: "Draft"|\/Applications\/TextEdit/);
  assert.equal(h.cards.length, 0);
});

test('GL3 saved bundle grants admit Glide at every ceiling and write an audit line', { skip: replWorkerSkip }, async t => {
  for (const riskLevel of ['low', 'medium', 'high']) {
    const directory = root(t), audit = createGrantAudit(directory);
    const grants = [];
    const h = await fixture(t, { preapproved: [{ app: initial.bundleId, riskLevel, source: 'always-allow' }],
      policy: () => ({ allow: true }), grantAudit: grant => { audit(grant); grants.push(grant); } });
    assert.equal((await h.call('await cua.getApp("TextEdit");')).isError, false);
    assert.equal(h.cards.length, 0);
    assert.equal(grants.length, 1); assert.equal(h.writes.length, 0);
    const lines = readFileSync(join(directory, `preapproved-${process.pid}.jsonl`), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.direction, 'preapproved-app');
    assert.deepEqual(record.grant, { app: initial.bundleId, riskLevel: 'high', tool: 'own',
      source: '~/Library/Application Support/sleight/preapproved.json' });
  }
});

test('saved app grants require a successful audit', { skip: replWorkerSkip }, async t => {
  const auditFailed = await fixture(t, { preapproved: [{ app: initial.bundleId, riskLevel: 'high' }],
    grantAudit: () => { throw Error('audit unavailable'); }, ask: () => 'decline' });
  assert.equal((await auditFailed.call('await cua.getApp("TextEdit");')).isError, true);
  assert.equal(auditFailed.cards.length, 1); assert.equal(auditFailed.requests.filter(row => row.method === 'getAXState').length, 0);
});

test('GL3 name-only grants never admit Glide', { skip: replWorkerSkip }, async t => {
  for (const name of ['TextEdit', 'Helium']) {
    const grants = [];
    const h = await fixture(t, { window: { app: name },
      preapproved: [{ app: name, riskLevel: 'high' }], ask: () => 'decline',
      grantAudit: grant => grants.push(grant) });
    assert.equal((await h.call(`await cua.getApp(${JSON.stringify(name)});`)).isError, true);
    assert.equal(h.cards.length, 1);
    assert.deepEqual(grants, []);
    assert.equal(h.requests.filter(row => row.method === 'getAXState').length, 0);
  }
});

test('GL3 a different bundle grant never admits Glide', { skip: replWorkerSkip }, async t => {
  const grants = [];
  const h = await fixture(t, { preapproved: [{ app: 'com.apple.Preview', riskLevel: 'high' }], ask: () => 'decline',
    grantAudit: grant => grants.push(grant) });
  assert.equal((await h.call('await cua.getApp("TextEdit");')).isError, true);
  assert.equal(h.cards.length, 1);
  assert.deepEqual(grants, []);
  assert.equal(h.requests.filter(row => row.method === 'getAXState').length, 0);
});

test('GL3 a saved grant never overrides a forbidden category', { skip: replWorkerSkip }, async t => {
  const grants = [];
  const policy = await loadMacAppPolicy({ executable: () => '/System/Applications/Passwords.app/Contents/MacOS/Passwords' });
  const h = await fixture(t, { policy, window: { bundleId: 'com.apple.Passwords', app: 'Passwords' },
    ancestry: () => [{ pid: 500, path: '/Applications/TestHost.app/Contents/MacOS/Host', bundleId: 'test.host' }],
    preapproved: [{ app: 'com.apple.Passwords', riskLevel: 'high' }],
    grantAudit: grant => grants.push(grant) });
  const result = await h.call('await cua.getApp("Passwords");');
  assert.equal(result.isError, true);
  assert.match(text(result), /refuses password managers/);
  assert.equal(h.cards.length, 0);
  assert.deepEqual(grants, []);
  assert.equal(h.requests.filter(row => row.method === 'getAXState').length, 0);
});

test('GL3 a warning verdict still asks with a saved grant', { skip: replWorkerSkip }, async t => {
  for (const riskLevel of ['low', 'medium', 'high']) {
    const grants = [];
    const h = await fixture(t, { preapproved: [{ app: initial.bundleId, riskLevel }], ask: () => 'decline',
      policy: () => ({ allow: true, warning: 'Fixture policy warning.' }),
      grantAudit: grant => grants.push(grant) });
    assert.equal((await h.call('await cua.getApp("TextEdit");')).isError, true);
    assert.equal(h.cards.length, 1);
    assert.deepEqual(grants, []);
    assert.equal(h.cards[0][2].appWarning, 'Fixture policy warning.');
    assert.equal(h.requests.filter(row => row.method === 'getAXState').length, 0);
  }
});

test('GL3 the ChatGPT engine ceiling API still rejects high against a low grant', () => {
  const list = new PreapprovedApps({ version: 1, apps: [{ app: initial.bundleId, riskLevel: 'low' }] });
  assert.equal(list.allows(initial.bundleId, 'high'), false);
  assert.equal(list.allows(initial.bundleId, 'low'), true);
});

test('GL3 Always allow from a Glide card still writes high', { skip: replWorkerSkip }, async t => {
  const h = await fixture(t, { policy: () => ({ allow: true }), allowsAlways: true, ask: () => 'always' });
  assert.equal((await h.call('await cua.getApp("TextEdit");')).isError, false);
  assert.equal(h.cards.length, 1);
  assert.equal(h.cards[0][2].always, true);
  assert.deepEqual(h.writes, [[initial.bundleId, 'high']]);
});

test('the preview never launches apps or exposes local input tools', { skip: replWorkerSkip }, async t => {
  const h = await fixture(t, { noWindows: true });
  const result = await h.call('await cua.getApp("TextEdit");');
  assert.equal(result.isError, true); assert.match(text(result), /NO_WINDOWS_AVAILABLE/);
  assert.equal(h.cards.length, 0);
  assert.deepEqual(h.requests.map(row => row.method), ['resolveApp']);
  const tools = (await h.request('tools/list')).result.tools;
  for (const name of ['open_file', 'select_window', 'drag', 'hover', 'menu_bar', 'notifications', 'app_handoff'])
    assert.equal(tools.some(tool => tool.name === name), false, name);
});

for (const [name, window, note] of [
  ['other Space', { onScreen: false }, 'the window is on another Space or off screen'],
  ['full-screen Space', { onScreen: false, fullScreen: true }, 'the window is in a full-screen Space outside the current Space'],
  ['minimized', { onScreen: false, minimized: true }, 'the window is minimized'],
  ['hidden', { onScreen: false, hidden: true }, 'the app is hidden'],
]) test(`own relay retains one ${name} advice line on reads and captures`, { skip: replWorkerSkip }, async t => {
  const h = await fixture(t, { window });
  for (const code of ['let app = await cua.getApp("TextEdit");', 'await app.getAXState();',
    'await app.getScreenshot();', 'await app.getAXStateAndScreenshot();']) {
    const result = await h.call(code);
    assert.equal(result.isError, false, text(result));
    assert.equal(text(result).split('\n').filter(line => line.startsWith(`sleight: ${note};`)).length, 1, text(result));
    assert.match(text(result), /ask the user.*this Space before input/);
  }
  assert.equal(h.cards.length, 1);
});

test('own relay explains another Space when AX cannot prove that window identity', { skip: replWorkerSkip }, async t => {
  const h = await fixture(t, { window: { onScreen: false }, request(method) {
    if (method === 'verifyWindowIdentity') throw Object.assign(Error('IDENTITY_UNVERIFIED'), { code: 'IDENTITY_UNVERIFIED' });
  } });
  const result = await h.call('await cua.getApp("TextEdit");');
  assert.equal(result.isError, true); assert.match(text(result), /IDENTITY_UNVERIFIED/);
  assert.match(text(result), /on another Space or off screen; ask the user to bring it to this Space before input/);
  assert.deepEqual(h.requests.map(row => row.method), ['resolveApp', 'verifyWindowIdentity']);
});

test('helper input registrars stay absent from this preview', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/mac-driver/native/DriverMain.swift', import.meta.url), 'utf8');
  assert.match(source, /let driverRegistrars:.*registerCapture/);
  assert.doesNotMatch(source, /\.register(?:Pointer|Keyboard)\(/);
});


test('a forged registrar object cannot enable direct or helper input', { skip: replWorkerSkip }, async t => {
  const h = await fixture(t, { inputRegistrar: Object.freeze({ enabled: true }) });
  await h.call('var app = await cua.getApp("TextEdit");');
  const before = h.requests.length;
  for (const code of ['await app.click(2);', 'await app.pickFromList("Unseen row");']) {
    const result = await h.call(code);
    assert.equal(result.isError, true, text(result));
  }
  assert.equal(h.requests.slice(before).some(row => ['click','pressKey','setValue','drag','scroll'].includes(row.method)), false);
});


import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

test('GL1A 11: runOwnRuntime default pid gate refuses a consent host behind an ordinary window name', { skip: replWorkerSkip }, async t => {
  t.mock.method(childProcess, 'execFileSync', (file, args) => {
    assert.equal(file, '/bin/ps');
    assert.deepEqual(args, ['-p', '4242', '-o', 'comm=']);
    return '/fixture/Library/Caches/sleight/turbo-host/k1/consent-host\n';
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const h = await fixture(t, { defaultOwnHostPid: true, window: { bundleId: 'com.example.helper', app: 'Helper', pid: 4242 } });
  const result = await h.call('let app = await cua.getApp("Helper");');
  assert.equal(result.isError, true);
  assert.match(text(result), /OWN_HOST_REFUSED/);
  assert.equal(h.cards.length, 0);
  assert.equal(h.requests.some(r => r.method === 'getAXState'), false);
});

test('GL1A: safety refuses the Glide window with its own line', { skip: replWorkerSkip }, async t => {
  const h = await fixture(t, { window: { bundleId: 'com.example.helper', app: 'glide-engine', pid: 4242 }, ownHostPid: () => false });
  const result = await h.call('let app = await cua.getApp("Helper");');
  assert.equal(result.isError, true);
  assert.match(text(result), /That is sleight's Glide engine; tools never act on it\./);
  assert.equal(h.cards.length, 0);
});

test('GL1A 11: a pid-only Glide identity gets the Glide line through the default runtime gate', { skip: replWorkerSkip }, async t => {
  t.mock.method(childProcess, 'execFileSync', (file, args) => {
    assert.equal(file, '/bin/ps'); assert.deepEqual(args, ['-p', '4242', '-o', 'comm=']);
    return '/fixture/Library/Caches/sleight/turbo-host/mac-driver/k2/glide-engine\n';
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const h = await fixture(t, { defaultOwnHostPid: true, window: { bundleId: 'com.example.helper', app: 'Helper', pid: 4242 } });
  const result = await h.call('let app = await cua.getApp("Helper");');
  assert.equal(result.isError, true);
  assert.match(text(result), /OWN_HOST_REFUSED: That is sleight's Glide engine; tools never act on it\./);
  assert.equal(h.cards.length, 0);
  assert.equal(h.requests.some(row => row.method === 'getAXState'), false);
});

test('F1: the own runtime never writes Always allow from a panel that cannot verify a click', { skip: replWorkerSkip }, async t => {
  const h = await fixture(t, { ask: () => 'always' });
  const result = await h.call('let app = await cua.getApp("TextEdit");');
  assert.equal(h.cards[0][2].always, false);
  assert.equal(result.isError, true, 'an always answer to a card that offered no Always is not an accept');
  assert.equal(h.writes.length, 0);
});
