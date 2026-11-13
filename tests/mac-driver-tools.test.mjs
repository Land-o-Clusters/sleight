import test, { before } from 'node:test';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createMacDriverTools, createMacDriverToolScheduler, createMacDriverToolFallback, macDriverStuckEscapeNote, MAC_LOCAL_TOOL_SCRIPTS, MAC_LOCAL_TOOL_NOTICES } from '../plugins/sleight/lib/mac-driver/tools.mjs';
import { nativeToolsCache, nativeToolsRequirement, nativeToolsSkip, nativeLocal, nativeToolsClient, localInputFixture, prepareNativeToolsFixture } from './fixtures/mac-driver-tools.mjs';
import { stuckEscapeNote } from '../plugins/sleight/lib/relay.mjs';
import { createMacDriverClient } from '../plugins/sleight/lib/mac-driver/client.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

// Compile before starting the short-lived fixture leases and result-age clocks.
before(() => { if (!nativeToolsSkip) prepareNativeToolsFixture(); });

test('conditional local tool result notices have their own hash and no startup wording', () => {
  const baseline = JSON.parse(readFileSync(new URL('fixtures/prompt-default.json', import.meta.url)));
  assert.equal(createHash('sha256').update(JSON.stringify(MAC_LOCAL_TOOL_NOTICES)).digest('hex'), baseline.macLocalToolNotices);
  assert.equal(Object.keys(MAC_LOCAL_TOOL_NOTICES).length, 3);
  assert.ok(Buffer.byteLength(Object.values(MAC_LOCAL_TOOL_NOTICES).join('\n')) < 450);
});

test('missing Xcode tools produce the repository skip reason before any fixture compile', async () => {
  assert.equal(await nativeToolsRequirement({ command: () => 'xcrun requires macOS', tools: () => assert.fail('no preflight on another platform') }),
    'xcrun requires macOS');
  assert.equal(await nativeToolsRequirement({ command: () => false, tools: async () => false }),
    'requires Xcode command-line tools (xcrun swiftc unavailable)');
  assert.equal(await nativeToolsRequirement({ command: () => false, tools: async () => true }), false);
  // Explicit private banks override the runner bank, including across separate
  // node --test invocations. Isolated files otherwise share their parent bank.
  assert.equal(nativeToolsCache({ override: null, context: 'child-v8', parent: 123, uid: 501, temporary: '/fixture' }),
    '/fixture/sleight-rt15-runner-501-123');
  assert.equal(nativeToolsCache({ override: null, context: 'child-v8', parent: 124, uid: 501, temporary: '/fixture' }),
    '/fixture/sleight-rt15-runner-501-124');
  assert.equal(nativeToolsCache({ override: null, context: 'in-process', parent: 123, uid: 501, temporary: '/fixture' }), undefined);
});

test('supported tools use the existing script runner only after unavailable preparation', async () => {
  for (const code of ['DRIVER_UNAVAILABLE', 'PLATFORM', 'DRIVER_VERSION_MISMATCH', 'DRIVER_EXIT']) {
    const calls = [];
    const fallback = createMacDriverToolFallback({ run: async (...args) => { calls.push(args); return { ok: true }; } });
    const driver = { ping: async () => { throw Object.assign(new Error(code), { code }); },
      request: () => assert.fail('unavailable helper must not dispatch') };
    const tools = createMacDriverTools({ driver, fallback });
    assert.deepEqual(await tools.run('menubar.js', { op: 'apps' }), { ok: true });
    assert.deepEqual(calls, [['menubar.js', { op: 'apps' }, {}]]);
    const onlyDriver = createMacDriverTools({ driver, fallback: null });
    await assert.rejects(onlyDriver.run('menubar.js', { op: 'apps' }), error => {
      assert.equal(error.code, code); assert.equal(error.unavailable, true);
      assert.equal(error.refused, false); assert.equal(error.delivery, 'not-sent'); return true;
    });
    await assert.rejects(fallback('not-a-tool.js', {}), /Unsupported local helper/);
    assert.equal(calls.length, 1);
  }
  let scripts = 0;
  const missingMethod = createMacDriverTools({ driver: { ping: async () => ({ methods: ['ping'] }),
    request: () => assert.fail('an unadvertised method must never dispatch') },
    fallback: async () => { scripts++; return { ok: true }; } });
  assert.deepEqual(await missingMethod.run('menubar.js', { op: 'apps' }), { ok: true });
  assert.equal(scripts, 1);
});

test('Stop, lease and policy refusals never reach fallback, even during failed preparation', async () => {
  for (const mode of ['before', 'during', 'cancel', 'locked', 'guard-flag', 'closed', 'retirement']) {
    let refused = mode === 'before', tools;
    const driver = { request: () => assert.fail('refusal must not dispatch'), ping: async () => {
      if (mode === 'during') refused = true;
      if (mode === 'cancel') tools.cancelPending();
      const code = { locked: 'SCREEN_LOCKED', closed: 'DRIVER_CLOSED', retirement: 'DRIVER_RETIRE_TIMEOUT' }[mode] ?? 'DRIVER_UNAVAILABLE';
      throw Object.assign(new Error('preparation failed'), { code,
        ...mode === 'guard-flag' ? { refused: true } : {} });
    } };
    tools = createMacDriverTools({ driver, fallback: () => assert.fail('a refusal must never reach a script') });
    await assert.rejects(tools.run('menubar.js', { op: 'open' }, { beforeDispatch: () => {
      if (refused) throw new Error('Input lease ownership lost');
    } }), error => {
      assert.equal(error.refused, true); assert.equal(error.unavailable, false); assert.equal(error.delivery, 'not-sent'); return true;
    });
  }
  const tools = createMacDriverTools({ driver: { ping: async () => ({}), request: async () => ({ ok: false, error: 'guard refused' }) },
    fallback: () => assert.fail('a native refusal must never reach a script') });
  assert.deepEqual(await tools.run('menubar.js', { op: 'choose' }), { ok: false, error: 'guard refused' });
});

test('open fallback validates a background open and never mistakes the read-only script for a write', async t => {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-rt15-fallback-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'fixture.txt'); writeFileSync(path, 'fixture');
  const calls = [];
  const fallback = createMacDriverToolFallback({ run: async (...args) => { calls.push(['script', ...args]); return { ok: true, matches: false }; },
    exec: async (...args) => { calls.push(['open', ...args]); } });
  assert.deepEqual(await fallback('open-file-window.js', { op: 'open', appId: 'org.test.fixture', path }), { ok: true });
  assert.deepEqual(calls, [['open', '/usr/bin/open', ['-g', '-b', 'org.test.fixture', path], { timeout: 15000 }]]);
  assert.equal((await fallback('open-file-window.js', { op: 'open', appId: 'com.apple.Terminal', path })).ok, false);
  assert.equal(calls.length, 1);
  await fallback('open-file-window.js', { appId: 'org.test.fixture', path });
  assert.equal(calls[1][0], 'script');
  let checks = 0;
  await assert.rejects(fallback('open-file-window.js', { op: 'open', appId: 'org.test.fixture', path }, {
    beforeDispatch: () => { if (++checks === 2) throw new Error('stopped during fallback preparation'); },
  }), /stopped during fallback preparation/);
  assert.equal(calls.length, 2);
});

test('a hard local timeout restarts the real shared client and never replays its input', async t => {
  let spawns = 0, locals = 0, closes = 0;
  const driver = createMacDriverClient({ platform: 'darwin', requiredMethods: ['ping', 'localTool'], prepare: async () => ({
    status: 'ready', spawn: () => {
      spawns++;
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { closes++; queueMicrotask(() => child.emit('close', 0)); return true; };
      child.stdin.on('data', bytes => {
        const request = JSON.parse(bytes);
        if (request.method === 'localTool' && ++locals === 1) return; // Lost reply from this fake provider.
        const result = request.method === 'ping' ? { protocol: 'sleight.driver/1', apiVersion: 2,
          build: 'a'.repeat(64), platform: 'darwin', healthy: true, methods: ['ping', 'localTool'] } : { ok: true, taps: [] };
        child.stdout.write(JSON.stringify({ protocol: request.protocol, platform: request.platform, nonce: request.nonce,
          id: request.id, ok: true, result }) + '\n');
      });
      return child;
    },
  }) });
  t.after(() => driver.close());
  const tools = createMacDriverTools({ driver, fallback: () => assert.fail('a timed-out action must never fall back') });
  await assert.rejects(tools.run('menubar.js', { op: 'choose' }, { timeoutMs: 50 }), error => {
    assert.equal(error.code, 'DEADLINE_EXCEEDED'); assert.equal(error.helperRestarted, true);
    assert.equal(error.delivery, 'unknown'); assert.match(error.message, /helper was restarted[\s\S]*bindings expired[\s\S]*Input may have been delivered/);
    return true;
  });
  assert.equal(spawns, 2); assert.equal(closes, 1); assert.equal(locals, 1);
  assert.deepEqual(await tools.keyboardTapState(), { ok: true, taps: [] });
  assert.equal(spawns, 2); assert.equal(locals, 2);
});

test('a failed timeout restart is disclosed and never opens a fallback route', async () => {
  const tools = createMacDriverTools({ driver: { ping: async () => ({}),
    request: async () => { throw Object.assign(new Error('timed out'), { code: 'DEADLINE_EXCEEDED' }); },
    restart: async () => { throw new Error('restart failed'); } }, fallback: () => assert.fail('no replay') });
  const result = await tools.run('stuck-escape.js');
  assert.equal(result.helperRestarted, false); assert.equal(result.uncertain, true);
  assert.match(result.error, /could not restart[\s\S]*Stop and tell the user/);
});

test('optional probes and the open-file result retain the hard-timeout recovery notice', async t => {
  let restarts = 0, opens = 0;
  const driver = { ping: async () => ({}), restart: async () => { restarts++; }, request: async (_method, { args }) => {
    if (args[0] === 'open-file-window.js' && args[1].op === 'open') { opens++; return { ok: true }; }
    throw Object.assign(new Error('provider timed out'), { code: 'DEADLINE_EXCEEDED' });
  } };
  const tools = createMacDriverTools({ driver, resolve: async () => 'org.test.fixture',
    fallback: () => assert.fail('a timeout must never fall back') });
  for (const result of [await tools.probe('Fixture'), await tools.frontRestore({ action: 'begin', selector: 'Fixture' }),
    await tools.keyboardTapState()]) {
    assert.equal(result.helperRestarted, true); assert.match(result.error, /helper was restarted[\s\S]*bindings expired/);
  }
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-rt15-open-timeout-'))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'fixture.txt'); writeFileSync(path, 'fixture');
  const result = await tools.openDocument({ app: 'Fixture', path }, { fast: true });
  assert.equal(result.isError, undefined); assert.equal(opens, 1); assert.equal(restarts, 4);
  assert.match(result.content.map(part => part.text).join('\n'), /Opened[\s\S]*helper was restarted[\s\S]*bindings expired/);
  const failed = createMacDriverTools({ driver: { ...driver, restart: async () => { throw new Error('restart failed'); } },
    resolve: async () => 'org.test.fixture', fallback: () => assert.fail('no timeout fallback') });
  const stopped = await failed.openDocument({ app: 'Fixture', path }, { fast: true });
  assert.equal(stopped.isError, true); assert.equal(opens, 1);
  assert.match(stopped.content[0].text, /could not restart[\s\S]*Stop and tell the user/);
});

test('local helper transport uses one driver method, never a script fallback after dispatch', async () => {
  const calls = [], fallback = [];
  const tools = createMacDriverTools({ driver: { ping: async () => ({}), request: async (...args) => { calls.push(args); return { ok: true }; } },
    fallback: async (...args) => { fallback.push(args); return { ok: true }; } });
  for (const script of MAC_LOCAL_TOOL_SCRIPTS) {
    await tools.run(script, { marker: script });
    assert.equal(calls.at(-1)[0], 'localTool');
    assert.deepEqual(calls.at(-1)[1], { args: [script, { marker: script }] });
  }
  assert.equal(calls.length, 7); assert.equal(fallback.length, 0);
  await assert.rejects(tools.run('unrelated.js', { x: 1 }), /Unsupported local helper/); assert.equal(fallback.length, 0);
  const failed = createMacDriverTools({ driver: { ping: async () => ({}), request: async () => { throw new Error('lost reply'); } },
    fallback: () => assert.fail('a driver action must never be repeated through JXA') });
  await assert.rejects(failed.run('menubar.js', { op: 'choose' }), error => {
    assert.match(error.message, /lost reply.*Input may have been delivered.*Read again before repeating/);
    assert.equal(error.delivery, 'unknown'); assert.equal(error.retry, 'read-first'); return true;
  });
  assert.deepEqual(await failed.run('stuck-escape.js', {}), { ok: false, posted: true, uncertain: true, text: MAC_LOCAL_TOOL_NOTICES.escapeUnknown, error: 'lost reply' });
  for (const code of ['DRIVER_UNAVAILABLE', 'PLATFORM', 'DRIVER_BUSY', 'INVALID_PARAMS']) {
    const f = createMacDriverTools({ driver: { ping: async () => ({}), request: async () => { throw Object.assign(new Error(code), { code }); } } });
    assert.equal((await f.run('stuck-escape.js')).posted, false, code);
  }
});

test('an uncertain Escape spends the episode without claiming a delivered key', async () => {
  const target = { appId: 'org.test.editor', title: 'Draft', url: null };
  const identity = async () => ({ ...target, status: 'ok', epoch: 'fixture', window: 1, pid: 321,
    processStart: 42, matches: 1, hidIdleSeconds: 20 });
  for (const code of ['DEADLINE_EXCEEDED', 'DRIVER_CLOSED', 'DRIVER_VERSION_MISMATCH', 'DRIVER_EXIT']) {
    const tools = createMacDriverTools({ driver: { ping: async () => ({}), request: async () => { throw Object.assign(new Error(code), { code }); } } });
    assert.equal(tools.stuckEscape({ identity, env: { SLEIGHT_STUCK_ESCAPE: '0' } }), undefined);
    const result = await tools.stuckEscape({ identity, env: {} }).send(target, { path: '/fixture-lease', token: 'owned' }, { since: 0, clock: () => 100 });
    assert.equal(result.posted, 'unknown');
    assert.match(result.text, /may have sent one Escape/);
    assert.match(macDriverStuckEscapeNote(result, stuckEscapeNote(result, 'Fixture', 1, 'original warning')), /may have sent one Escape[\s\S]*original warning/);
  }
});

test('app approvals, decline, current-call checks and Accessibility hints keep the existing boundary', async () => {
  const events = [];
  const tools = createMacDriverTools({ resolve: async () => 'org.test.fixture',
    driver: { ping: async () => ({}), request: async (...args) => { events.push(args); return { ok: false, accessibility: true, error: '-25211' }; } } });
  for (const [name, args] of [['menu_bar', { op: 'open', app: 'Fixture' }], ['notifications', { op: 'list' }],
    ['select_window', { app: 'Fixture', title: 'Untitled' }], ['open_file', { app: 'Fixture', path: '/missing' }]]) {
    const result = await tools.call(name, args, async () => false);
    assert.equal(result.isError, true); assert.equal(events.length, 0);
  }
  const result = await tools.call('notifications', { op: 'list' }, async parts => { assert.deepEqual(parts, ['notifications']); return true; });
  assert.match(result.content[0].text, /Accessibility permission/);
  assert.deepEqual(events[0][1], { args: ['menubar.js', { caller: 'notifications', op: 'notifications' }] });
  await assert.rejects(tools.call('menu_bar', { op: 'apps' }, async () => true, undefined, undefined,
    { current: () => { throw new Error('handed off'); } }), /handed off/);
  assert.equal(events.length, 1);
  let declined = false;
  const pending = tools.call('open_file', { app: 'Fixture', path: '/missing' }, async () => false, undefined,
    { bundleId: new Promise(() => {}) }).then(result => { declined = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(declined, true, 'a declined open must not wait for pending app resolution');
  assert.equal((await pending).isError, true);
  let prompts = 0;
  const blockedCalls = [];
  const blocked = createMacDriverTools({ driver: { ping: async () => ({}), request: () => assert.fail('blocked target must not reach driver') },
    resolve: async () => 'org.test.fixture' });
  const refused = await blocked.call('open_file', { app: 'Fixture', path: '/missing' }, async () => { prompts++; return true; },
    undefined, undefined, { blocked: id => { blockedCalls.push(id); return 'Fixture is blocked'; } });
  assert.equal(refused.isError, true); assert.equal(prompts, 0);
  assert.deepEqual(blockedCalls, ['org.test.fixture']);
});

test('short probes wait outside driver deadlines and queued actions recheck Stop', async () => {
  let release;
  const calls = [];
  const tools = createMacDriverTools({ driver: { ping: async () => ({}), request: async (_method, { args }) => {
    calls.push(args[0]);
    if (args[0] === 'menubar.js') return new Promise(resolve => { release = resolve; });
    return args[0] === 'app-health.js' ? { status: 'responding' } : { ok: true };
  } } });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const menu = tools.run('menubar.js', { op: 'open', app: 'Fixture' }); await tick();
  const probe = tools.probe('Fixture'); await tick();
  try { assert.deepEqual(calls, ['menubar.js']); } finally { release({ ok: true }); }
  await menu; assert.equal((await probe).status, 'responding');
  assert.deepEqual(calls, ['menubar.js', 'app-health.js']);
  calls.length = 0;
  const otherMenu = tools.run('menubar.js', { op: 'open', app: 'Fixture' }); await tick();
  let stopped = false;
  const selection = tools.call('select_window', { app: 'Fixture', title: 'Draft' }, async () => true,
    undefined, undefined, { current: () => { if (stopped) throw new Error('stopped'); } });
  const rejection = assert.rejects(selection, /stopped/);
  await tick(); stopped = true; release({ ok: true });
  await otherMenu; await rejection;
  assert.deepEqual(calls, ['menubar.js']);
});

test('shared scheduling bounds the queue and cancellation fences pending work', async () => {
  const schedule = createMacDriverToolScheduler(), calls = [];
  let release;
  const driver = { ping: async () => ({}), request: async (method, params) => {
    calls.push([method, params]);
    if (method === 'getAXState') return new Promise(resolve => { release = resolve; });
    return { status: 'responding' };
  } };
  const tools = createMacDriverTools({ driver, schedule });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const read = schedule(() => driver.request('getAXState', {})); await tick();
  const probe = tools.probe('Fixture'); tools.cancelPending(); release({});
  await read; assert.deepEqual(await probe, { status: 'unknown' });
  assert.equal(calls.length, 1);
  assert.equal((await tools.probe('Fixture')).status, 'responding');
  const queue = createMacDriverToolScheduler();
  let finish;
  const first = queue(() => new Promise(resolve => { finish = resolve; })); await tick();
  const rest = Array.from({ length: 31 }, () => queue(() => true));
  await assert.rejects(queue(() => assert.fail('overflow must not dispatch')), { code: 'DRIVER_BUSY', delivery: 'not-sent' });
  finish(); await first; assert.equal((await Promise.all(rest)).length, 31);
});

test('Stop during lazy startup cannot deliver a local action afterward', async t => {
  let release, preparing = false, localCalls = 0;
  const ready = new Promise(resolve => { release = resolve; });
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; };
  child.stdin.on('data', bytes => {
    const request = JSON.parse(bytes);
    const result = request.method === 'ping' ? { protocol: 'sleight.driver/1', apiVersion: 2,
      build: 'a'.repeat(64), platform: 'darwin', healthy: true, methods: ['ping', 'localTool'] } : { ok: true };
    if (request.method === 'localTool') localCalls++;
    child.stdout.write(JSON.stringify({ protocol: request.protocol, platform: request.platform, nonce: request.nonce,
      id: request.id, ok: true, result }) + '\n');
  });
  const driver = createMacDriverClient({ platform: 'darwin', requiredMethods: ['ping', 'localTool'], prepare: async () => {
    preparing = true; await ready; return { status: 'ready', spawn: () => child };
  } });
  t.after(() => driver.close());
  const tools = createMacDriverTools({ driver });
  const action = tools.run('menubar.js', { op: 'open', app: 'Fixture' });
  const outcome = action.then(() => 'delivered', error => error.message);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(preparing, true);
  tools.cancelPending(); release();
  assert.match(await outcome, /stopped/); assert.equal(localCalls, 0);
});

test('SA1C native menu helper rejects mismatched and missing caller tags', { skip: nativeToolsSkip }, () => {
  for (const request of [{ caller: 'menu_bar', op: 'notifications' }, { caller: 'menu_bar', op: 'notify-press' },
    { caller: 'notifications', op: 'open', app: 'Fixture' }, { op: 'notifications' }]) {
    const reply = nativeLocal('menubar.js', request, { apps: [] });
    assert.equal(reply.result.ok, false);
    assert.match(reply.result.error, /caller/);
    assert.deepEqual(reply.events, []);
  }
});

test('native status menus, notifications and tap filters use fixture data only', { skip: nativeToolsSkip }, () => {
  const menu = { AXRole: 'AXMenu', AXChildren: [
    { AXTitle: 'Checked', AXMenuItemMarkChar: '✓', AXEnabled: false }, { AXTitle: '' },
    { AXTitle: 'Nested', AXChildren: [{ AXRole: 'AXMenu', AXChildren: [{ AXTitle: 'Leaf' }] }] },
  ] };
  const app = { name: 'Fixture', appId: 'org.test.fixture', pid: 42, tree: { AXChildren: [
    { AXRole: 'AXMenuBar' }, { AXRole: 'AXMenuBar', AXChildren: [{ AXChildren: [menu] }] },
  ] } };
  const call = (args, fixture = { apps: [app] }) => {
    const input = localInputFixture();
    return nativeLocal('menubar.js', { ...input.args, caller: ['notifications', 'notify-press'].includes(args.op) ? 'notifications' : 'menu_bar', ...args }, { ...input.fixture, ...fixture });
  };
  // Listing is read-only and needs neither a driver identity nor an input lease.
  const listed = nativeLocal('menubar.js', { caller: 'menu_bar', op: 'apps' }, { apps: [app] });
  assert.deepEqual(listed.result, { ok: true, apps: ['Fixture'] });
  assert.deepEqual(listed.events, []);
  // Opening reads a menu only after AXPress and dismisses it with AXCancel.
  // All four mutation paths must still refuse the old unbound arguments.
  for (const op of ['open', 'choose', 'press', 'close']) {
    const refused = nativeLocal('menubar.js', { caller: 'menu_bar', op, app: 'Fixture', path: ['Nested', 'Leaf'], element: 0 }, { apps: [app] });
    assert.equal(refused.result.ok, false);
    assert.equal(refused.result.error, 'The leased window changed');
    assert.deepEqual(refused.events, []);
  }
  const extra = { ...app, tree: { AXChildren: [{ AXRole: 'AXMenuBar' }],
    AXExtrasMenuBar: { AXRole: 'AXMenuBar', AXChildren: [{ AXChildren: [menu] }] } } };
  assert.deepEqual(call({ op: 'apps' }, { apps: [extra] }).result.apps, ['Fixture']);
  assert.equal(call({ op: 'open', app: 'Fixture' }, { apps: [extra] }).result.opened, 'menu');
  const opened = call({ op: 'open', app: 'Fixture' });
  assert.deepEqual(opened.result.menu, [ { title: 'Checked', disabled: true, checked: true },
    { title: 'Nested', submenu: [{ title: 'Leaf' }] } ]);
  assert.equal(opened.events.at(-1)[2], 'AXCancel');
  const closed = call({ op: 'close', app: 'Fixture' });
  assert.equal(closed.result.closed, true); assert.equal(closed.events.at(-1)[2], 'AXCancel');
  assert.equal(call({ op: 'choose', app: 'Fixture', path: ['Nested', 'Leaf'] }).result.ok, true);
  const missing = call({ op: 'choose', app: 'Fixture', path: ['Missing'] });
  assert.match(missing.result.error, /no menu item/); assert.equal(missing.events.at(-1)[2], 'AXCancel');
  for (const args of [{ op: 'open', app: 'Fixture', item: '1' }, { op: 'choose', app: 'Fixture', path: [] },
    { op: 'choose', app: 'Fixture', path: [3] }]) {
    const invalid = call(args); assert.equal(invalid.result.ok, false); assert.deepEqual(invalid.events, []);
  }
  assert.match(call({ op: 'open', app: 'consent-host' }, { apps: [{ ...app, name: 'consent-host' }] }).result.error, /own confirmation window/);
  const popover = { ...app, tree: { AXChildren: [{ AXRole: 'AXMenuBar' }, { AXRole: 'AXMenuBar', AXChildren: [
    { pid: 42, AXPosition: [100, 20], AXSize: [30, 10] },
  ] }], AXWindows: [{ AXRole: 'AXWindow', AXPosition: [0, 0], AXChildren: [
    { key: 'popover-button', AXRole: 'AXButton', AXPosition: [10, 15] },
    { AXRole: 'AXTextField', AXSubrole: 'AXSecureTextField', AXValue: 'secret', AXChildren: [
      { AXRole: 'AXStaticText', AXValue: 'secret descendant' },
    ] },
  ] }] } };
  const window = call({ op: 'open', app: 'Fixture' }, { apps: [popover] });
  assert.equal(window.events.filter(e => e[0] === 'post').length, 2);
  assert.equal(window.result.opened, 'window');
  assert.deepEqual(window.result.elements, [{ element: 0, role: 'Button', text: 'Button at (10, 15)' }]);
  assert.doesNotMatch(JSON.stringify(window.result), /secret/);
  const windowClosed = call({ op: 'close', app: 'Fixture' }, { apps: [popover] });
  assert.equal(windowClosed.result.closed, true); assert.equal(windowClosed.result.windowStillOpen, true);
  assert.equal(windowClosed.events.filter(e => e[0] === 'post').length, 2);
  const pressed = call({ op: 'press', app: 'Fixture', element: 0 }, { apps: [popover] });
  assert.equal(pressed.result.pressed, 0); assert.deepEqual(pressed.events[0], ['action', 'popover-button', 'AXPress']);
  const noElement = call({ op: 'press', app: 'Fixture', element: 1 }, { apps: [popover] });
  assert.equal(noElement.result.ok, false); assert.deepEqual(noElement.events, []);
  const banners = { apps: [{ name: 'NotificationCenter', tree: { AXWindows: [{ AXChildren: [
    { actions: ['Name:Close\nTarget:1', 'AXPress'], AXChildren: [{ AXRole: 'AXStaticText', AXValue: 'Fixture alert' }] },
  ] }] } }] };
  const notifications = nativeLocal('menubar.js', { caller: 'notifications', op: 'notifications' }, banners);
  assert.deepEqual(notifications.result, { ok: true, banners: [{ banner: 0, texts: ['Fixture alert'], buttons: ['Close'] }] });
  assert.deepEqual(notifications.events, []);
  const localized = { apps: [{ ...banners.apps[0], name: 'Notification Center',
    executable: '/System/Library/CoreServices/NotificationCenter.app/Contents/MacOS/NotificationCenter' }] };
  assert.equal(call({ op: 'notifications' }, localized).result.banners.length, 1);
  assert.deepEqual(call({ op: 'notify-press', banner: 0, button: 'Close' }, banners).result, { ok: true, pressed: 'Close', banner: 0 });
  assert.match(call({ op: 'notify-press', banner: 0, button: 'Other' }, banners).result.error, /has no "Other" button/);
  const taps = nativeLocal('keyboard-taps.js', {}, { apps: [app], taps: [
    { pid: 42, enabled: true, options: 0, events: 1 << 10 },
    { pid: 43, enabled: true, options: 1, events: 1 << 10 },
    { pid: 44, enabled: false, options: 0, events: 1 << 10 },
    { pid: 45, enabled: true, options: 0, events: 1 << 1 },
    { pid: 46, enabled: true, options: 0, events: 1 << 12 },
  ] });
  assert.deepEqual(taps.result.taps, [{ pid: 42, app: 'Fixture', bundleId: 'org.test.fixture' }, { pid: 46, app: '', bundleId: '' }]);
  const input = localInputFixture();
  const delayedEscape = nativeLocal('stuck-escape.js', { ...input.args,
    quietSeconds: 0.5, waitSeconds: 1.5, resultAt: Date.now() - 5000 },
  { ...input.fixture, idle: 1, menuState: { selected: true, open: false } });
  assert.equal(delayedEscape.result.posted, false); assert.match(delayedEscape.result.error, /User input/);
  assert.ok(!delayedEscape.events.some(e => e[0] === 'key'));
});

test('local Escape and real click share the fail-closed Space gate before any input', { skip: nativeToolsSkip }, async t => {
  for (const [name, patch, allowed, reason, idle = 20] of [
    ['current Space', () => {}, true],
    ['other Space', f => { f.windows[0].onScreen = false; }, false, /another Space or off screen/],
    ['omitted CG key', f => { delete f.windows[0].onScreen; }, false, /another Space or off screen/],
    ['unreadable CG value', f => { f.windows[0].onScreen = null; }, false, /could not be verified/],
    ['hidden', f => { f.windows[0].hidden = true; }, false, /hidden/],
    ['minimized', f => { f.trees[7].AXMinimized = true; }, false, /minimized/],
    ['current full screen', f => { f.trees[7].AXFullScreen = true; }, true],
    ['Split View tile', f => { f.trees[7].AXFullScreen = true; f.displays[0].width *= 2; }, false, /Split View/],
    ['unreadable full-screen geometry', f => { f.trees[7].AXFullScreen = true; delete f.displays; }, false, /could not be verified/],
    ['no window', f => { f.windows = []; }, false, /WINDOW_NOT_FOUND/],
    // OS1D binds window 7 explicitly, so an unrelated sibling is now admitted.
    ['verified window among siblings', f => { f.windows.push({ ...f.windows[0], windowId: '8' }); }, true],
    ['ambiguous AX matches', f => { f.axWindows = [{ ...f.trees[7] }, { ...f.trees[7] }]; }, false, /IDENTITY_UNVERIFIED/],
    ['missing AX window', f => { f.axWindows = []; }, false, /IDENTITY_UNVERIFIED/],
    ['off-Space AX missing', f => { delete f.windows[0].onScreen; f.axWindows = []; }, false, /another Space or off screen/],
    ['unknown minimized', f => { delete f.trees[7].AXMinimized; }, false, /could not be verified/],
    ['unknown full screen', f => { delete f.trees[7].AXFullScreen; }, false, /could not be verified/],
    ['user input during Space checks', () => {}, false, /User input at the Mac/, [20, 0]],
  ]) for (const script of ['real-click', 'stuck-escape.js']) await t.test(`${script}: ${name}`, () => {
    const input = localInputFixture(); patch(input.fixture.spaceInventory);
    // Escape reads result-idle, quiet-idle and result-idle before its first
    // Space check; realClick reads quiet-idle before that check. Interrupt the
    // first post-Space idle read in both paths.
    const inputIdle = script === 'stuck-escape.js' && Array.isArray(idle) ? [20, 20, ...idle] : idle;
    const fixture = { ...input.fixture, clickPID: 42, idle: inputIdle,
      menuState: { selected: true, open: false }, afterEscape: false };
    const row = nativeLocal(script, { ...input.args,
      quietSeconds: 0.5, waitSeconds: 1.5, resultAt: Date.now() - 100 }, fixture);
    assert.equal(row.result.ok, allowed, JSON.stringify(row));
    assert.equal(row.events.filter(e => ['key', 'post'].includes(e[0])).length, allowed ? 2 : 0);
    if (!allowed) {
      assert.match(row.result.error, reason);
      assert.equal(row.events.filter(e => e[0] === 'restore').length, 0);
      if (script === 'stuck-escape.js') assert.equal(row.result.posted, false);
    }
  });
});

test('menu_bar apps preserves Accessibility denial and the System Settings hint', { skip: nativeToolsSkip }, async t => {
  const apps = [{ name: 'Fixture', appId: 'org.test.fixture', pid: 42 }];
  const client = nativeToolsClient({ localTools: { apps, trusted: false } }); t.after(() => client.close());
  const tools = createMacDriverTools({ driver: client, fallback: () => assert.fail('Accessibility denial is a refusal') });
  const result = await tools.run('menubar.js', { caller: 'menu_bar', op: 'apps' });
  assert.equal(result.ok, false); assert.equal(result.accessibility, true); assert.match(result.error, /-25211/);
  const reply = await tools.call('menu_bar', { op: 'apps' }, () => assert.fail('apps needs no app approval'));
  assert.equal(reply.isError, true);
  assert.match(reply.content[0].text, /Accessibility permission[\s\S]*System Settings → Privacy & Security → Accessibility/);
  assert.deepEqual(nativeLocal('menubar.js', { caller: 'menu_bar', op: 'apps' }, { apps: [] }).result, { ok: true, apps: [] });
  const first = nativeLocal('menubar.js', { caller: 'menu_bar', op: 'apps' }, { apps: [
    { ...apps[0], rootError: 'first Accessibility error (-25211)' }, { name: 'Other', rootError: 'second error' },
  ] }).result;
  assert.equal(first.error, 'first Accessibility error (-25211)'); assert.equal(first.accessibility, true);
  const partial = nativeLocal('menubar.js', { caller: 'menu_bar', op: 'apps' }, { apps: [apps[0], { name: 'Readable', tree: {} }] }).result;
  assert.deepEqual(partial, { ok: true, apps: [] });
});

test('a cooperative local timeout leaves the same compiled helper healthy', { skip: nativeToolsSkip }, async t => {
  const input = localInputFixture();
  const client = nativeToolsClient({ localTools: { ...input.fixture, realTime: true,
    frontState: { time: 10, idleSeconds: 20, front: { bundleId: 'org.test.previous', pid: 7 }, targets: [] },
    apps: [{ name: 'Fixture', appId: input.args.appId, pid: 42,
    tree: { AXExtrasMenuBar: { AXChildren: [{ pid: 42, AXPosition: [100, 20], AXSize: [30, 10] }] } } }] } });
  t.after(() => client.close());
  const before = await client.ping();
  // Keep a front-restore token to prove the process and its state survive.
  const tools = createMacDriverTools({ driver: client, fallback: () => assert.fail('no fallback after dispatch') });
  const { token } = await tools.frontRestore({ action: 'begin', selector: 'Missing' }); assert.ok(token);
  const reply = await tools.run('menubar.js', { ...input.args, caller: 'menu_bar', op: 'open', app: 'Fixture' }, { timeoutMs: 1500 });
  assert.equal(reply.ok, false); assert.equal(reply.timedOut, true); assert.equal(reply.helperHealthy, true);
  assert.equal(reply.delivery, 'unknown'); assert.equal(reply.retry, 'read-first');
  assert.match(reply.error, /shared helper is still healthy[\s\S]*Input may have been delivered/);
  assert.deepEqual(await client.ping(), before);
  assert.deepEqual(await tools.frontRestore({ action: 'arm', token }), { armed: true });
  assert.deepEqual(await tools.keyboardTapState(), { ok: true, taps: [] });
});

test('real client and native registrar preserve framing, session refusal and argument validation', { skip: nativeToolsSkip }, async t => {
  const client = nativeToolsClient(); t.after(() => client.close());
  assert.ok((await client.ping()).methods.includes('localTool'));
  const tools = createMacDriverTools({ driver: client });
  assert.deepEqual(await tools.probe('Missing fixture app'), { status: 'absent' });
  assert.deepEqual(await tools.keyboardTapState(), { ok: true, taps: [] });
  assert.deepEqual(await tools.frontRestore({ action: 'begin', selector: 'Missing fixture app' }), {});
  const target = { appId: 'org.test.fixture', app: 'Fixture', title: 'Draft', url: null };
  const window = { windowId: '1', pid: 42, processStart: '100.25', bundleId: target.appId, app: target.app,
    title: target.title, onScreen: true, layer: 0, hidden: false, identityVerified: true, bounds: { x: 0, y: 0, width: 400, height: 300 } };
  const escapeClient = nativeToolsClient({ windows: [window],
    trees: { 1: { AXRole: 'AXWindow', AXTitle: target.title, AXMinimized: false, AXFullScreen: false, pid: 42, frame: window.bounds } },
    localTools: { apps: [{ appId: target.appId, name: target.app, pid: 42, processStart: 9 }], focusedWindowId: '1',
    spaceInventory: localInputFixture(window).fixture.spaceInventory,
    idle: 20, menuState: { selected: true, open: false }, afterEscape: false,
    lease: { token: 'owned', expires: Date.now() + 30000,
      window: { appId: target.appId, title: JSON.stringify(['1', 42, '100.25']), url: null } } } });
  t.after(() => escapeClient.close());
  const escapeTools = createMacDriverTools({ driver: escapeClient });
  const escape = escapeTools.stuckEscape({ env: {}, binding: () => window });
  assert.deepEqual(await escape.send(target, { path: '/fixture', token: 'owned' }, { since: 0, clock: () => 100 }),
    { posted: true, selected: false });
  for (const args of [[], ['not-a-helper.js', {}], ['menubar.js', null], ['menubar.js', {}, 'extra']]) {
    await assert.rejects(client.request('localTool', { args }), { code: 'INVALID_PARAMS' });
  }
  const locked = nativeToolsClient({ session: { kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: true, CGSSessionScreenIsLocked: true } });
  t.after(() => locked.close());
  await assert.rejects(locked.request('localTool', { args: ['menubar.js', { op: 'apps' }] }), { code: 'SCREEN_LOCKED' });
});


test('GL1A 9: driver tools refuse their current and stale identities and omit them from apps', { skip: nativeToolsSkip }, () => {
  const line = "That is sleight's Glide engine; tools never act on it.";
  const path = '/fixture/Library/Caches/sleight/turbo-host/mac-driver/k2/glide-engine';
  const apps = [
    { name: 'glide-engine', appId: 'com.example.glide', pid: 501, executable: '/usr/local/bin/glide-engine' },
    { name: 'Glide Engine.app', appId: 'com.example.glide2', pid: 502 },
    { name: 'Helper', appId: 'com.example.helper', pid: 503, executable: path },
    { name: 'consent-host', appId: 'com.example.consent', pid: 504 },
    { name: 'Chess', appId: 'com.apple.Chess', pid: 505 },
  ];
  for (const [script, args] of [['menubar.js', { caller: 'menu_bar', op: 'open', app: 'glide-engine' }],
    ['select-window.js', { app: 'Glide Engine.app', title: 'Private' }]]) {
    const result = nativeLocal(script, args, { apps });
    assert.equal(result.result.ok, false);
    assert.equal(result.result.error, line);
    assert.deepEqual(result.events, []);
  }
  // Hover remains the runtime's JXA tool; DriverLocalTools has no hover opcode.
  const application = { localizedName: 'Helper', bundleIdentifier: 'com.example.helper',
    executableURL: { path }, bundleURL: { isNil: () => false, path: '/Applications/Helper.app' } };
  const context = vm.createContext({ ObjC: { import() {}, unwrap: value => value },
    $: { NSWorkspace: { sharedWorkspace: { runningApplications: { count: 1, objectAtIndex: () => application } } } } });
  vm.runInContext(readFileSync(new URL('../plugins/sleight/lib/hover.js', import.meta.url), 'utf8'), context);
  assert.throws(() => context.nativeHover().resolve('Helper'), { message: line });
  assert.deepEqual(nativeLocal('menubar.js', { caller: 'menu_bar', op: 'apps' }, { apps: apps.map(app => ({ ...app,
    tree: { AXChildren: [{ AXRole: 'AXMenuBar' }, { AXRole: 'AXMenuBar', AXChildren: [{ key: app.name }] }] } })) }).result.apps, ['Chess']);
});
