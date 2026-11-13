import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { callLocalTool, localToolDefinitions } from './fixtures/local-tools.mjs';
import { createRelay } from '../plugins/sleight/lib/relay.mjs';
import { createMacDriverTools } from '../plugins/sleight/lib/mac-driver/tools.mjs';
import { createMacRuntimeTools } from '../plugins/sleight/lib/mac-driver/runtime-tools.mjs';
import { prepareMacInputRegistrar } from '../plugins/sleight/lib/mac-driver/input-registrar.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { removeTemp } from '../scripts/temp-leftovers.mjs';

const text = value => value?.content?.map(item => item.text ?? '').join('\n') ?? '';
const tick = () => new Promise(resolve => setImmediate(resolve));
const good = {
  hover: { app: 'Fixture', at: [1, 2] },
  drag: { app: 'Fixture', from: [1, 2], to: [3, 4] },
  select_window: { app: 'Fixture', title: 'Draft' },
  open_file: { app: 'Fixture', path: '/fixture/document.txt' },
  menu_bar: { op: 'open', app: 'Fixture' },
  notifications: { op: 'list' },
};

function relay(t, options = {}) {
  const clientIn = new PassThrough(), clientOut = new PassThrough();
  const serverIn = new PassThrough(), serverOut = new PassThrough();
  serverIn.resume();
  const replies = [];
  clientOut.on('data', data => replies.push(...String(data).trim().split('\n').map(JSON.parse)));
  const instance = createRelay({ clientIn, clientOut, serverIn, serverOut, sessionId: 'local-admission', ...options });
  t.after(() => instance.dispose());
  let id = 0;
  return async (name, args) => {
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    for (let i = 0; i < 30 && !replies.some(reply => reply.id === id); i++) await tick();
    const reply = replies.find(reply => reply.id === id);
    assert.ok(reply, 'local call settled');
    return reply.result ?? { isError: true, content: [{ type: 'text', text: reply.error?.message }] };
  };
}

for (const op of ['open', 'choose', 'press', 'close']) test(`SA1Q menu ${op} keeps policy identity separate from its real lease`, async t => {
  for (const [label, app, appId, refused, resolvedApp = app] of [
    ['unresolved status item', 'Control Center', '', false],
    ['normal app', 'Fixture', 'org.test.fixture', false],
    ['forbidden name', 'Terminal', '', true],
    ['forbidden resolved alias', 'Harmless alias', 'com.apple.Terminal', true],
    ['forbidden resolved name', 'Harmless alias', '', true, 'Terminal'],
  ]) await t.test(label, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'sleight-sa1q-lease-'));
    const inputLease = new InputLease({ directory, holder: 'sa1q' });
    let cards = 0, dispatches = 0, resolutions = 0;
    const call = relay(t, { inputLease, ask: async () => { cards++; return 'accept'; },
      localTools: { tools: localToolDefinitions({}),
        resolve: async () => { resolutions++; return { app: resolvedApp, appId }; },
        call: async (_name, _args, approve, _run, resolved) => {
          assert.deepEqual(resolved, { app: resolvedApp, appId }, 'helper reuses the policy lookup');
          assert.equal(await approve(['menu_bar', app], 'Allow fixture?'), true);
          const leases = [...inputLease.owned.keys()].map(key => inputLease.inspect(key));
          assert.equal(leases.length, 1, 'input requires a real lease');
          assert.equal(leases[0].active, true);
          assert.equal(leases[0].scope, 'desktop');
          assert.equal(leases[0].window.appId, appId || 'desktop');
          dispatches++;
          return { content: [{ type: 'text', text: 'fixture dispatched' }] };
        } } });
    t.after(() => { inputLease.close(); removeTemp(directory); });
    const result = await call('menu_bar', { op, app });
    assert.equal(result.isError === true, refused, text(result));
    if (refused) assert.match(text(result), /ComputerUseAllowForbiddenTargets/);
    assert.equal(cards, refused ? 0 : 1);
    assert.equal(dispatches, refused ? 0 : 1);
    assert.equal(resolutions, label === 'forbidden name' ? 0 : 1);
  });
});

for (const name of ['hover', 'drag']) test(`SA1Q direct launcher ${name} returns an unknown-app refusal`, async () => {
  const result = await callLocalTool(name, good[name], () => assert.fail('unknown app must not approve'),
    () => assert.fail('unknown app must not dispatch'), undefined, undefined,
    { resolve: async () => { throw Error('Unknown app: Fixture'); } });
  assert.equal(result.isError, true);
  assert.match(text(result), /Unknown app: Fixture/);
});

for (const name of ['menu_bar', 'select_window']) test(`SA1Q Glide ${name} returns an unknown-app refusal`, async () => {
  const tools = createMacDriverTools({ driver: { ping: () => assert.fail('unknown app must not ping'),
    request: () => assert.fail('unknown app must not dispatch') },
    resolve: async () => { throw Error('Unknown app: Fixture'); } });
  const result = await tools.call(name, good[name], () => assert.fail('unknown app must not approve'));
  assert.equal(result.isError, true);
  assert.match(text(result), /Unknown app: Fixture/);
});

test('SA1Q Glide drag returns an unknown-app refusal from driver resolution', async () => {
  let resolves = 0;
  const driver = { ping: async () => ({ build: 'a'.repeat(64) }), request: async method => {
    if (method === 'inputGateState') return { enabled: true };
    assert.equal(method, 'resolveApp'); resolves++;
    throw Error('Unknown app: Fixture');
  } };
  const inputRegistrar = await prepareMacInputRegistrar(driver, 'a'.repeat(64));
  const { localTools } = createMacRuntimeTools({ driver, inputRegistrar,
    bindings: () => assert.fail('unknown app must not bind'),
    runLocal: () => assert.fail('unknown app must not dispatch') });
  const result = await localTools.call('drag', good.drag, () => assert.fail('unknown app must not approve'));
  assert.equal(result.isError, true);
  assert.match(text(result), /Unknown app: Fixture/);
  assert.equal(resolves, 1);
});

// Removing validation at any one of these three entry points admits these calls.
const invalid = [
  ...Object.entries(good).map(([name, args]) => [name, { ...args, unexpected: true }]),
  ...Object.entries(good).map(([name, args]) => [name, Object.fromEntries(Object.entries(args).filter(([key]) => key !== (name === 'menu_bar' || name === 'notifications' ? 'op' : 'app')))]),
  ['hover', { app: 'Fixture', at: [1], waitMs: 99 }],
  ['hover', { app: 'Fixture', at: [-1, 2] }],
  ['hover', { app: 'Fixture', at: [1, 2], waitMs: 4001 }],
  ['hover', { app: 'Fixture', at: [1, 2], waitMs: 100.5 }],
  ['drag', { ...good.drag, windowId: 0 }],
  ['select_window', { ...good.select_window, windowNumber: 1.5 }],
  ['menu_bar', { op: 'notifications', app: 'Fixture' }],
  ['menu_bar', { op: 'notify-press', app: 'Fixture', banner: 0, button: 'Open' }],
  ['menu_bar', { op: 'Notifications', app: 'Fixture' }],
  ['menu_bar', { op: 'open ', app: 'Fixture' }],
  ['menu_bar', { op: 'open', app: 'Fixture', item: '0' }],
  ['menu_bar', { op: 'choose', app: 'Fixture', path: [1] }],
  ['notifications', { op: 'press', banner: 0.5, button: 'Open' }],
  ['open_file', { app: 'Fixture', path: 7 }],
  ['menu_bar', { op: 'open', app: 'Fixture', banner: 0, button: 'Open' }],
  ['drag', { ...good.drag, screenshot: [10, 10] }],
  ['select_window', { ...good.select_window, expectedAppId: 'com.apple.Terminal' }],
  ['hover', { app: '', at: [1, 2] }],
  ['hover', { app: 'Fixture', at: [1, 2, 3] }],
  ['hover', { app: 'Fixture', at: [1, 2], windowTitle: '' }],
  ['open_file', { app: 'Fixture', path: '' }],
];
for (const boundary of ['relay', 'launcher', 'glide']) test(`SA1C schema validation at ${boundary} precedes effects`, async t => {
  let effects = 0;
  const tools = createMacDriverTools({ driver: {
    ping: async () => { effects++; return {}; }, request: async () => { effects++; return { ok: true }; },
  }, resolve: async () => { effects++; return 'org.test.fixture'; } });
  const call = relay(t, { localTools: { tools: localToolDefinitions({}),
    target: async () => { effects++; return {}; }, call: async () => { effects++; return { content: [] }; } } });
  for (const [name, args] of invalid) {
    if (boundary === 'glide' && ['drag', 'hover'].includes(name)) continue;
    const approve = async () => { effects++; return true; };
    const result = boundary === 'relay' ? await call(name, args) : boundary === 'launcher'
      ? await callLocalTool(name, args, approve, async () => { effects++; return { ok: true }; })
      : await tools.call(name, args, approve);
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)} must refuse`);
    assert.match(text(result), /inputSchema/, 'invalid calls point back to the advertised contract');
    assert.equal(effects, 0, `${boundary}: invalid ${name} must not approve, resolve or dispatch`);
  }
});

const targets = [
  ['Terminal', undefined], ['com.apple.Terminal', undefined], ['iTerm2', undefined],
  ['ChatGPT Beta.app', undefined], ['Codex', undefined],
  ['Harmless alias', { app: 'Alias', appId: 'com.openai.codex' }],
  ['Harmless alias', { app: 'Alias', appId: 'com.apple.Terminal' }],
  ['Terminal', { app: 'Fixture', appId: 'org.test.fixture' }],
];
for (const boundary of ['relay', 'launcher', 'glide']) test(`SA1C forbidden local targets at ${boundary} never reach approval`, async t => {
  for (const name of ['hover', 'drag', 'select_window', 'menu_bar']) {
    if (boundary === 'glide' && ['hover', 'drag'].includes(name)) continue;
    for (const [app, resolved] of targets) {
      let approvals = 0, dispatches = 0;
      const approve = async () => { approvals++; return true; };
      const run = async () => { dispatches++; return { ok: true, path: 'none' }; };
      const args = { ...good[name], app };
      const call = relay(t, { ask: async () => { approvals++; return 'accept'; },
        preapproved: { allows: () => true }, localTools: { tools: localToolDefinitions({}),
          target: async () => resolved, resolve: async () => resolved,
          call: async (_name, _args, allow) => { await allow([name, app], 'Allow?'); dispatches++; return { content: [] }; } } });
      const tools = createMacDriverTools({ driver: { ping: async () => ({}), request: run } });
      const result = boundary === 'relay' ? await call(name, args) : boundary === 'launcher'
        ? await callLocalTool(name, args, approve, run, resolved)
        : await tools.call(name, args, approve, resolved);
      assert.equal(result.isError, true, `${boundary} ${name} ${app}`);
      assert.match(text(result), /ComputerUseAllowForbiddenTargets/);
      assert.equal(approvals, 0); assert.equal(dispatches, 0);
    }
  }
});

test('SA1C lifted forbidden local targets warn and cannot use list grants', async t => {
  let cards = 0, grants = 0;
  const call = relay(t, { engineForbiddenTargets: true,
    preapproved: { allows: () => { grants++; return true; } },
    ask: async (_message, _scoped, options) => { cards++; assert.match(options.appWarning, /terminal|AI app/); return 'accept'; },
    localTools: { tools: localToolDefinitions({}), target: async () => ({ appId: 'com.apple.Terminal', app: 'Terminal' }),
      call: async (_name, _args, approve) => {
        assert.equal(await approve(['drag', 'Terminal'], 'Allow Claude to drag in Terminal?'), true);
        return { content: [{ type: 'text', text: 'admitted' }] };
      } } });
  assert.equal((await call('drag', { ...good.drag, app: 'Terminal' })).isError, undefined);
  assert.equal(cards, 1); assert.equal(grants, 0);
});

test('SA1C menu and notifications send separate fixed helper envelopes', async () => {
  const calls = [], approvals = [];
  const run = async (script, request) => { calls.push([script, request]); return { ok: true }; };
  const approve = async key => { approvals.push(key); return true; };
  await callLocalTool('menu_bar', { op: 'choose', app: 'Fixture', path: ['One'], element: 8, item: 1 }, approve, run);
  await callLocalTool('notifications', { op: 'list', banner: 3, button: 'unused' }, approve, run);
  await callLocalTool('notifications', { op: 'press', banner: 0, button: 'Open' }, approve, run);
  assert.deepEqual(approvals, [['menu_bar', 'Fixture'], ['notifications'], ['notifications']]);
  assert.deepEqual(calls, [
    ['menubar.js', { caller: 'menu_bar', op: 'choose', app: 'Fixture', item: 1, path: ['One'] }],
    ['menubar.js', { caller: 'notifications', op: 'notifications' }],
    ['menubar.js', { caller: 'notifications', op: 'notify-press', banner: 0, button: 'Open' }],
  ]);
});

test('SA1C menubar helper refuses mismatched and missing caller tags before native reads', () => {
  let effects = 0;
  const context = vm.createContext({ ObjC: { import() {} }, Application: () => new Proxy({}, { get() { effects++; throw Error('native access'); } }) });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/menubar.js', import.meta.url), 'utf8'), context);
  for (const request of [{ caller: 'menu_bar', op: 'notifications' }, { caller: 'menu_bar', op: 'notify-press' },
    { caller: 'notifications', op: 'open', app: 'Fixture' }, { op: 'notifications' }]) {
    const result = JSON.parse(context.run([JSON.stringify(request)]));
    assert.equal(result.ok, false); assert.match(result.error, /caller/); assert.equal(effects, 0);
  }
});

test('SA1C launcher and Glide lifted targets still require the warned card', async () => {
  for (const name of ['hover', 'drag', 'select_window', 'menu_bar']) {
    const args = { ...good[name], app: 'Harmless alias' };
    const resolved = { app: 'Alias', appId: 'com.apple.Terminal' };
    const boundaries = [approve => callLocalTool(name, args, approve, () => assert.fail('declined action'), resolved, undefined, { allowForbidden: true })];
    if (!['hover', 'drag'].includes(name)) {
      const tools = createMacDriverTools({ driver: { ping: () => assert.fail('declined action'), request: () => assert.fail('declined action') } });
      boundaries.push(approve => tools.call(name, args, approve, resolved, undefined, { allowForbidden: true }));
    }
    for (const call of boundaries) {
      let cards = 0;
      const result = await call(async (_key, _message, options) => {
        cards++; assert.match(options.appWarning, /terminal/); assert.equal(options.noPreapproved, true); return false;
      });
      assert.equal(result.isError, true); assert.equal(cards, 1);
    }
  }
});

test('SA1C Glide resolves status-only aliases before their app card', async () => {
  const tools = createMacDriverTools({ driver: { ping: () => assert.fail('no action'), request: () => assert.fail('no action') },
    resolve: async () => 'com.openai.codex' });
  const result = await tools.call('menu_bar', { op: 'open', app: 'Alias' }, () => assert.fail('no card'));
  assert.equal(result.isError, true); assert.match(text(result), /ComputerUseAllowForbiddenTargets/);
});

test('SA1C direct launcher and Glide window calls resolve aliases before approval', async () => {
  for (const name of ['hover', 'drag', 'select_window', 'menu_bar']) {
    let resolved = 0, approved = 0, dispatched = 0;
    const result = await callLocalTool(name, { ...good[name], app: 'Alias' }, async () => { approved++; return true; },
      async () => { dispatched++; return { ok: true, path: 'background' }; }, undefined, undefined,
      { resolve: async () => { resolved++; return 'com.apple.Terminal'; } });
    assert.equal(result.isError, true, name); assert.match(text(result), /ComputerUseAllowForbiddenTargets/);
    assert.equal(resolved, 1); assert.equal(approved, 0); assert.equal(dispatched, 0);
  }
  const tools = createMacDriverTools({ driver: { ping: async () => ({}), request: async () => ({ ok: true }) },
    resolve: async () => 'com.openai.codex' });
  const result = await tools.call('select_window', { app: 'Alias', title: 'Draft' }, () => assert.fail('no card'));
  assert.equal(result.isError, true); assert.match(text(result), /ComputerUseAllowForbiddenTargets/);
});

test('SA1C Glide drag facade propagates the trusted forbidden-target setting', async () => {
  const driver = { ping: async () => ({ build: 'a'.repeat(64) }), request: async method => {
    if (method === 'resolveApp') return { app: { id: 'com.apple.Terminal' } };
    assert.equal(method, 'inputGateState'); return { enabled: true };
  } };
  const inputRegistrar = await prepareMacInputRegistrar(driver, 'a'.repeat(64));
  for (const lifted of [false, true]) {
    let cards = 0;
    const { localTools } = createMacRuntimeTools({ driver, inputRegistrar, allowForbidden: () => lifted,
      bindings: () => assert.fail('declined drag must not bind') });
    const result = await localTools.call('drag', { ...good.drag, app: 'Terminal' }, async (_key, _message, options) => {
      cards++; assert.match(options.appWarning, /terminal/); return false;
    });
    assert.equal(result.isError, true); assert.equal(cards, lifted ? 1 : 0);
  }
});

test('SA1C private relay evidence remains usable after public validation', async () => {
  const args = { ...good.drag, screenshot: [640, 480], elementLines: { 1: 'button One' } };
  const result = await callLocalTool('drag', args, async () => true, async (script, request) => {
    if (script === 'drag.js') { assert.deepEqual(request.screenshot, [640, 480]); assert.deepEqual(request.elementLines, { 1: 'button One' }); }
    return { ok: true, path: 'background' };
  }, undefined, undefined, { internal: true });
  assert.notEqual(result.isError, true, text(result));
  let selected = false;
  const selection = await callLocalTool('select_window', { ...good.select_window, expectedAppId: 'org.test.fixture' },
    async () => true, async (_script, request) => { selected = true; assert.equal(request.expectedAppId, 'org.test.fixture'); return { ok: true }; },
    undefined, undefined, { internal: true });
  assert.notEqual(selection.isError, true, text(selection)); assert.equal(selected, true);
});

test('SA1C every advertised schema accepts its valid call without a helper on decline', async () => {
  for (const [name, args] of Object.entries(good)) {
    let cards = 0;
    const result = await callLocalTool(name, args, async () => { cards++; return false; }, () => assert.fail('declined action'));
    assert.equal(cards, 1, name); assert.equal(result.isError, true);
  }
  const result = await callLocalTool('unknown', {}, () => assert.fail('unknown tool must not approve'), () => assert.fail('unknown tool must not run'));
  assert.equal(result.isError, true);
});

test('SA1C lifted forbidden settings windows remain refused before a card', async () => {
  for (const name of ['hover', 'drag', 'select_window', 'menu_bar']) {
    const result = await callLocalTool(name, { ...good[name], app: 'Terminal' },
      () => assert.fail('settings must not approve'), () => assert.fail('settings must not run'),
      { appId: 'com.apple.Terminal', app: 'Terminal', title: 'Profiles' }, undefined, { allowForbidden: true });
    assert.equal(result.isError, true); assert.match(text(result), /settings window is refused/);
  }
});

test('SA1C a requested settings title cannot hide behind a different resolved window', async () => {
  const result = await callLocalTool('select_window', { app: 'Terminal', title: 'Settings' },
    () => assert.fail('requested settings must not approve'), () => assert.fail('requested settings must not run'),
    { appId: 'com.apple.Terminal', app: 'Terminal', title: 'Untitled' }, undefined, { allowForbidden: true });
  assert.equal(result.isError, true); assert.match(text(result), /settings window is refused/);
});

test('SA1C unconstrained endpoint schemas still require finite bounded JSON', async () => {
  let nested = 1;
  for (let i = 0; i < 16; i++) nested = { child: nested };
  for (const from of [NaN, nested]) {
    let effects = 0;
    const result = await callLocalTool('drag', { ...good.drag, from }, async () => { effects++; return true; },
      async () => { effects++; return { ok: true, path: 'background' }; });
    assert.equal(result.isError, true); assert.match(text(result), /inputSchema/); assert.equal(effects, 0);
  }
});
