import { trackTemp } from '../scripts/temp-leftovers.mjs';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { runOwnRuntime } from '../plugins/sleight/lib/runtime-select.mjs';
import { PreapprovedApps } from '../plugins/sleight/lib/preapproved.mjs';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createMacSafety, loadMacAppPolicy, macWindowNote, MAC_WINDOW_NOTICES, MAC_WINDOW_REFUSALS } from '../plugins/sleight/lib/mac-safety.mjs';
import { DRIVER_ACTION_METHODS } from '../plugins/sleight/lib/mac-driver/protocol.mjs';
import { prepareMacInputRegistrar } from '../plugins/sleight/lib/mac-driver/input-registrar.mjs';
import { launcherChains, classifiedChain } from './fixtures/mac-policy-ancestry.mjs';
import * as macSafety from '../plugins/sleight/lib/mac-safety.mjs';

const window = { windowId: '42', pid: 50, processStart: '100.25', bundleId: 'com.example.App',
  app: 'Example', title: 'Document', identityVerified: true, bounds: { x: 0, y: 0, width: 500, height: 500 } };

test('Space result notes have a separate conditional hash and a 1400 byte budget', () => {
  const notices = [...Object.values(MAC_WINDOW_NOTICES), ...Object.values(MAC_WINDOW_REFUSALS)];
  const baseline = JSON.parse(readFileSync(new URL('fixtures/prompt-default.json', import.meta.url)));
  assert.equal(createHash('sha256').update(JSON.stringify(notices)).digest('hex'), baseline.macSpaceNotices);
  assert.ok(Buffer.byteLength(notices.join('\n')) < 1400);
});
function fixture(options = {}) {
  const calls = [], cards = [];
  let observed = { ...structuredClone(window), ...options.window }, contentReads = 0, released = 0;
  const safety = createMacSafety({
    driver: { async request(method, params) {
      calls.push([method, params]);
      if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app, pid: options.absent ? null : window.pid,
        processStart: options.absent ? null : window.processStart, running: !options.absent,
        path: '/Applications/Example.app' }, windows: options.noWindows ? [] : [structuredClone(observed)] };
      if (method === 'verifyWindowIdentity') {
        if (options.verifyError) throw Object.assign(Error(options.verifyMessage ?? options.verifyError), { code: options.verifyError });
        return { window: structuredClone(observed) };
      }
      if (method === 'getAXState') {
        contentReads++;
        const result = { window: options.afterRead ?? structuredClone(observed), text: 'private content', readId: contentReads };
        // Inject missing metadata at the cache boundary, after identity checks.
        if (options.dropCachedBundle || options.cachedBundle) Object.defineProperty(result, 'readId', { get() {
          if (options.cachedBundle) result.window.bundleId = options.cachedBundle;
          else delete result.window.bundleId;
          return contentReads;
        } });
        return result;
      }
      assert.fail('unexpected request ' + method);
    } },
    lease: { acquire: () => 'lease', renew() {}, release() { released++; options.release?.(); }, close() {} },
    approve: async card => { cards.push(card); return options.approve ? options.approve(card) : true; },
    approvalScope: options.approvalScope, beforeLeaseEnd: options.beforeLeaseEnd,
    policy: options.policy ?? (() => ({ allow: true })),
    targetParents: () => [1], ancestry: () => [{ pid: 90, path: '/Applications/Host.app/Contents/MacOS/Host' }],
    allowForbidden: options.allowForbidden ?? (() => false),
    permissions: Object.hasOwn(options, 'permissions') ? options.permissions :
      { app() {}, page() {}, sitesLimited: () => false },
  });
  return { safety, calls, cards, patch: patch => { observed = { ...observed, ...patch }; }, reads: () => contentReads, releases: () => released };
}
test('submenu disclosure requests come from parent policy and clear on the next read', async t => {
  const h = fixture(); t.after(() => h.safety.close());
  let requests = ['Open Recent']; h.safety.setPolicy({ menuReadRequests: () => requests });
  await h.safety.request('getApp', { selector: 'Example' });
  assert.deepEqual(h.calls.find(([method]) => method === 'getAXState')[1].menuRequests, ['Open Recent']);
  requests = [];
  await h.safety.request('getAXState', { windowId: '42', processStart: '100.25' });
  assert.deepEqual(h.calls.filter(([method]) => method === 'getAXState').at(-1)[1].menuRequests, []);
  await assert.rejects(h.safety.request('getAXState', { windowId: '42', processStart: '100.25', menuRequests: ['Services'] }), { code: 'INVALID_PARAMS' });
});

// SA2J: use the shipped classifier, with every OS boundary held offline.
function realPolicyFixture(policy, { id = 'com.apple.TextEdit', name = 'TextEdit', lifted = false,
  metadata = {}, ancestry = [{ pid: 90, path: '/bin/zsh' }], path,
  targetParents = () => [50, 1], ownHostPid = () => false, now, diagnostics, omitPid = false } = {}) {
  const calls = [], cards = [];
  const observed = { ...structuredClone(window), bundleId: id, app: name, ...metadata };
  const safety = createMacSafety({ policy, ancestry: typeof ancestry === 'function' ? ancestry : () => ancestry,
    targetParents, ownHostPid, now, diagnostics,
    allowForbidden: () => typeof lifted === 'function' ? lifted() : lifted,
    driver: { async request(method) {
      calls.push(method);
      if (method === 'resolveApp') return { app: { id, name, ...omitPid ? {} : { pid: observed.pid }, processStart: observed.processStart, path }, windows: [observed] };
      if (method === 'verifyWindowIdentity') return { window: observed };
      assert.equal(method, 'getAXState');
      return { window: observed, text: 'offline fixture', readId: 1 };
    } },
    approve: async card => { cards.push(card); return true; },
    lease: { acquire: () => 'test', renew() {}, release() {}, close() {} },
    permissions: { app() {}, page() {}, sitesLimited: () => false },
  });
  return { safety, calls, cards };
}

for (const [launcher, paths] of Object.entries(launcherChains)) {
  test(`SA2S ${launcher} chain acquires TextEdit with one card and one read`, async () => {
    const h = realPolicyFixture(await loadMacAppPolicy({ executable: () => '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit' }),
      { ancestry: () => classifiedChain(paths) });
    try {
      assert.equal((await h.safety.request('getApp', { selector: 'TextEdit' })).text, 'offline fixture');
      assert.equal(h.cards.length, 1);
      assert.equal(h.calls.filter(method => method === 'getAXState').length, 1);
    } finally { h.safety.close(); }
  });
  for (const [id, name] of [['com.apple.Terminal', 'Terminal'], ['com.1password.1password', '1Password']]) {
    test(`SA2S ${launcher} chain keeps ${name} refused by category`, async () => {
      const h = realPolicyFixture(await loadMacAppPolicy({ executable: () => `/Applications/${name}.app/Contents/MacOS/${name}` }),
        { id, name, ancestry: () => classifiedChain(paths) });
      try {
        await assert.rejects(h.safety.request('getApp', { selector: name }), error =>
          error.code === 'FORBIDDEN_TARGET' && error.message.includes(name === 'Terminal' ? 'terminals' : 'password managers'));
        assert.deepEqual(h.calls, ['resolveApp']); assert.equal(h.cards.length, 0);
      } finally { h.safety.close(); }
    });
  }
}

for (const [label, options] of [
  ['Claude Desktop host', { id: 'com.anthropic.claudefordesktop', name: 'Claude', ancestry: () => classifiedChain(launcherChains.Desktop) }],
  ['second-copy VS Code host', { id: 'com.microsoft.VSCode', name: 'Code', path: '/Volumes/Other/Visual Studio Code.app',
    ancestry: () => classifiedChain(launcherChains.VSCode) }],
  ['disclaimer pid', { metadata: { pid: 897 }, ancestry: () => classifiedChain(launcherChains.Desktop) }],
]) test(`SA2S refuses ${label} before approval`, async () => {
  const h = realPolicyFixture(await loadMacAppPolicy({ executable: () => '/Applications/Editor.app/Contents/MacOS/Editor' }), options);
  try {
    await assert.rejects(h.safety.request('getApp', { selector: 'target' }), { code: 'FORBIDDEN_TARGET' });
    assert.equal(h.cards.length, 0); assert.deepEqual(h.calls, ['resolveApp']);
  } finally { h.safety.close(); }
});

for (const [label, readBundleId] of [['throw', () => { throw Error('plist unavailable'); }], ['empty', () => '']]) {
  test(`SA2S plist ${label} refuses with row cause before approval`, async () => {
    const h = realPolicyFixture(await loadMacAppPolicy({ executable: () => '/Applications/Editor.app/Contents/MacOS/Editor' }),
      { ancestry: () => classifiedChain(['/opt/homebrew/bin/node', '/Applications/Host.app/Contents/MacOS/Host'], readBundleId) });
    try {
      await assert.rejects(h.safety.request('getApp', { selector: 'TextEdit' }),
        { code: 'APP_POLICY_INVALID_METADATA', cause: 'processAncestry[1]' });
      assert.deepEqual(h.calls, ['resolveApp']); assert.equal(h.cards.length, 0);
    } finally { h.safety.close(); }
  });
}

test('SA2S renamed shell is non-app and host ancestry is read once across requests and turns', async () => {
  let reads = 0;
  const h = realPolicyFixture(await loadMacAppPolicy({ executable: () => '/Applications/Editor.app/Contents/MacOS/Editor' }),
    { ancestry: () => { reads++; return classifiedChain(['/fixture/bin/zsh']); } });
  try {
    await h.safety.request('getApp', { selector: 'TextEdit' });
    await h.safety.request('getAXState', { windowId: '42', processStart: '100.25' });
    await h.safety.endTurn();
    await h.safety.request('getApp', { selector: 'TextEdit' });
    assert.equal(reads, 1); assert.equal(h.cards.length, 1);
  } finally { h.safety.close(); }
});

for (const ancestor of [process.pid, 1234567]) test(`SA2S target parent walk refuses owned pid ${ancestor} by identity`, async () => {
  const h = realPolicyFixture(await loadMacAppPolicy({ executable: () => '/Applications/Editor.app/Contents/MacOS/Editor' }),
    { targetParents: () => [50, 60, ancestor, 1], ownHostPid: pid => pid === 1234567 });
  try {
    await assert.rejects(h.safety.request('getApp', { selector: 'TextEdit' }), { code: 'OWN_HOST_REFUSED' });
    assert.deepEqual(h.calls, ['resolveApp']); assert.equal(h.cards.length, 0);
  } finally { h.safety.close(); }
});

test('SA2S unrelated target acquires when parent pids are unrelated', async () => {
  const h = realPolicyFixture(await loadMacAppPolicy({ executable: () => '/Applications/Editor.app/Contents/MacOS/Editor' }),
    { targetParents: () => [50, 60, 1] });
  try { assert.equal((await h.safety.request('getApp', { selector: 'TextEdit' })).readId, 1); }
  finally { h.safety.close(); }
});

test('SA2S empty host chain refuses in mac-safety', async () => {
  const h = realPolicyFixture(await loadMacAppPolicy({ executable: () => '/Applications/Editor.app/Contents/MacOS/Editor' }), { ancestry: [] });
  try {
    await assert.rejects(h.safety.request('getApp', { selector: 'TextEdit' }), { code: 'ANCESTRY_UNAVAILABLE' });
    assert.deepEqual(h.calls, ['resolveApp']); assert.equal(h.cards.length, 0);
  } finally { h.safety.close(); }
});

test('SA2S TextEdit settings subrole refuses reads without relying on its title', async () => {
  const h = realPolicyFixture(await loadMacAppPolicy({ executable: () => '/Applications/Editor.app/Contents/MacOS/Editor' }),
    { metadata: { windowSubrole: 'AXSettingsWindow', windowIdentifier: 'document' } });
  try {
    await assert.rejects(h.safety.request('getApp', { selector: 'TextEdit' }), error =>
      error.code === 'FORBIDDEN_TARGET' && error.message.includes('settings window'));
    assert.deepEqual(h.calls, ['resolveApp']); assert.equal(h.cards.length, 0);
  } finally { h.safety.close(); }
});

for (const [flags, code] of [[{}, 'SECURE_INPUT_ACTIVE'], [{ secureInput: false }, 'SECURE_FIELD'],
  [{ secureInput: false, focusedSecureField: false }, null]]) {
  test(`SA2S typeText with window flags ${JSON.stringify(flags)} ${code ?? 'allows'}`, async () => {
    let posts = 0;
    const observed = { ...window, bundleId: 'com.apple.TextEdit', app: 'TextEdit', onScreen: true, minimized: false, ...flags };
    const driver = { ping: async () => ({ build: 'a'.repeat(64) }), async request(method) {
      if (method === 'inputGateState') return { enabled: true };
      if (method === 'resolveApp') return { app: { id: observed.bundleId, name: observed.app, pid: observed.pid,
        processStart: observed.processStart }, windows: [observed] };
      if (method === 'verifyWindowIdentity') return { window: observed };
      if (method === 'personState') return { token: 'fixture-person', personTookOver: false };
      if (method === 'typeText') { posts++; return { window: observed, delivery: 'sent-unverified' }; }
      assert.equal(method, 'getAXState');
      return { window: observed, text: 'Window: "Document", App: TextEdit.\n0 standard window\n\t1 text field', readId: 1 };
    } };
    const safety = createMacSafety({ driver, targetParents: () => [50, 1], ancestry: () => classifiedChain(launcherChains.Desktop),
      policy: await loadMacAppPolicy({ executable: () => '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit' }),
      inputRegistrar: await prepareMacInputRegistrar(driver, 'a'.repeat(64)),
      approve: () => true, lease: { acquire: () => 'test', renew() {}, release() {}, close() {} },
      permissions: { app() {}, page() {}, sitesLimited: () => false } });
    safety.setPolicy({ checkPause() {}, beforeAction: async ({ args }) => ({ args }) });
    try {
      await safety.request('getApp', { selector: 'TextEdit' });
      const request = () => safety.request('typeText', { windowId: '42', processStart: '100.25', readId: 1, args: ['fixture'] });
      if (code) await assert.rejects(request(), { code });
      else await request();
      assert.equal(posts, code ? 0 : 1);
    } finally { safety.close(); }
  });
}

test('SA2S bundle read uses plutil with the remaining shared budget and preserves raw identity', () => {
  let now = 0;
  const calls = [];
  const rows = macSafety.macProcessAncestry({ pid: 100, now: () => now,
    executable(pid, ms) { assert.equal(ms, 3000); now = 250; return '/Applications/Host.app/Contents/MacOS/Host'; },
    run(file, args, options) {
      calls.push({ file, args, options });
      if (file === '/usr/bin/plutil') { assert.equal(options.timeout, 2750); now = 400; return 'test.host\n'; }
      assert.equal(options.timeout, 2600); return '1\n';
    } });
  assert.deepEqual(rows, [{ pid: 100, ppid: 1, path: '/Applications/Host.app/Contents/MacOS/Host', bundleId: 'test.host' }]);
  assert.deepEqual(calls[0].args, ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', '/Applications/Host.app/Contents/Info.plist']);
  assert.ok(calls.every(row => row.options.killSignal === 'SIGKILL' && row.options.timeout > 0));
});

test('SA2S exhausted bundle budget refuses without granting a new timeout', () => {
  let now = 0, psCalls = 0;
  assert.throws(() => macSafety.macProcessAncestry({ pid: 100, now: () => now,
    executable: () => '/Applications/Host.app/Contents/MacOS/Host',
    readBundleId(_plist, ms) { assert.equal(ms, 3000); now = 3001; return 'test.host'; },
    run() { psCalls++; return '1'; } }), /ANCESTRY_UNAVAILABLE/);
  assert.equal(psCalls, 0);
});

test('SA2S real plutil reads an owned fixture bundle within the shared budget', { skip: process.platform !== 'darwin' }, t => {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-ancestry-plist-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outer = join(root, 'Outer.app', 'Contents');
  mkdirSync(outer, { recursive: true });
  writeFileSync(join(outer, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict>' +
    '<key>CFBundleIdentifier</key><string>test.outer</string></dict></plist>');
  let plists = 0;
  const began = Date.now();
  const rows = macSafety.macProcessAncestry({ pid: 100,
    executable: () => join(outer, 'Frameworks', 'Inner.app', 'Contents', 'MacOS', 'Helper'),
    run(file, args, options) {
      if (file === '/bin/ps') return '1';
      assert.equal(file, '/usr/bin/plutil'); plists++;
      assert.ok(options.timeout > 0 && options.timeout <= 3000);
      return execFileSync(file, args, { ...options, timeout: options.timeout, killSignal: 'SIGKILL' });
    } });
  assert.equal(rows[0].bundleId, 'test.outer'); assert.equal(plists, 1);
  t.diagnostic(`fixture plist and ancestry lookup ${Date.now() - began} ms; 1 plutil call, 0 real process queries`);
});

test('SA2S target parent reader walks only pids within one budget', () => {
  assert.equal(typeof macSafety.macProcessParents, 'function');
  const calls = [];
  assert.deepEqual(macSafety.macProcessParents({ pid: 50, run(file, args, options) {
    calls.push({ file, args, options }); return args[1] === '50' ? '60' : '1';
  } }), [50, 60]);
  assert.ok(calls.every(row => row.file === '/bin/ps' && row.args.at(-1) === 'ppid=' &&
    row.options.timeout > 0 && row.options.timeout <= 3000 && row.options.killSignal === 'SIGKILL'));
  for (const answer of ['50', '', 'claude', '0'])
    assert.throws(() => macSafety.macProcessParents({ pid: 50, run: () => answer }), /ANCESTRY_UNAVAILABLE/);
});

for (const [id, name, category] of [
  ['com.apple.Terminal', 'Terminal', 'terminals'],
  ['com.1password.1password', '1Password', 'password-managers'],
  ['com.apple.TextEdit', 'TextEdit', null],
]) test(`real loaded policy classifies ${name} at acquisition`, async () => {
  const policy = await loadMacAppPolicy({ executable: () => `/Applications/${name}.app/Contents/MacOS/${name}` });
  const h = realPolicyFixture(policy, { id, name });
  try {
    if (category) {
      await assert.rejects(h.safety.request('getApp', { selector: id }), error =>
        error.code === 'FORBIDDEN_TARGET' && error.message.includes(category === 'terminals' ? 'terminals' : 'password managers'));
      assert.deepEqual(h.calls, ['resolveApp']);
      assert.equal(h.cards.length, 0);
    } else {
      assert.equal((await h.safety.request('getApp', { selector: id })).text, 'offline fixture');
      assert.equal(h.cards.length, 1);
      assert.equal(h.calls.filter(method => method === 'getAXState').length, 1);
    }
  } finally { h.safety.close(); }
});

for (const [id, name] of [['com.apple.Terminal', 'Terminal'], ['com.openai.chat', 'ChatGPT']])
  test(`SA2U Glide refuses ${name} with the forbidden-target override enabled`, async () => {
    const calls = [], list = new PreapprovedApps({ version: 1, apps: [] });
    const owner = await runOwnRuntime({ input: new PassThrough(), output: new PassThrough(), signals: new EventEmitter(),
      driver: { async request(method) {
        calls.push(method);
        assert.equal(method, 'resolveApp');
        return { app: { id, name, pid: 50, processStart: '100.25' }, windows: [{ ...window, bundleId: id, app: name }] };
      }, async close() {} },
      lease: { acquire: () => assert.fail('no lease'), close() {} },
      approvalStorage: { load: () => list, live: () => ({ refresh() {}, list: () => [] }), add: () => assert.fail('no grant') },
      policy: await loadMacAppPolicy({ executable: () => `/Applications/${name}.app/Contents/MacOS/${name}` }),
      permissions: { app() {}, page() {}, sitesLimited: () => false },
      ancestry: () => [{ pid: 90, path: '/bin/zsh' }], targetParents: () => [50, 1], ownHostPid: () => false,
      allowForbidden: () => true, ask: () => assert.fail('no card'), grantAudit() {},
      relayOptions: { runtimeHandClient: { hide() {}, close() {} } },
    });
    try {
      await assert.rejects(owner.runtime.safety.request('getApp', { selector: name }), { code: 'FORBIDDEN_TARGET' });
      assert.deepEqual(calls, ['resolveApp']);
    } finally { await owner.close(); }
  });

test('loaded policy receives parent metadata and settings on every check', async () => {
  const seen = [], policy = await loadMacAppPolicy({
    executable: (pid, timeout) => { assert.equal(pid, 50); assert.ok(timeout > 0); return '/Applications/Editor.app/Contents/MacOS/Editor'; },
    load: async () => ({ evaluateAppPolicy(metadata, settings) { seen.push({ metadata, settings }); return { allow: true }; } }),
  });
  const metadata = { secureInput: true, focusedSecureField: true, windowSubrole: 'AXStandardWindow', windowIdentifier: 'document' };
  const h = realPolicyFixture(policy, { metadata, lifted: true });
  try {
    await h.safety.request('getApp', { selector: 'forged name' });
    await h.safety.request('getAXState', { windowId: '42', processStart: '100.25' });
    assert.equal(seen.length, 6);
    for (const [index, item] of seen.entries()) assert.deepEqual(item, {
      metadata: { bundleId: 'com.apple.TextEdit', executableName: 'Editor',
        executablePath: '/Applications/Editor.app/Contents/MacOS/Editor', processAncestry: [{ kind: 'non-app' }],
        windowTitle: 'Document', operation: index < 4 ? 'getApp' : 'getAXState', ...metadata },
      settings: { allowForbiddenTargets: true },
    });
  } finally { h.safety.close(); }
});

test('real loaded policy keeps unavailable executable and ancestry metadata closed', async () => {
  for (const [executable, ancestry, cause] of [[() => undefined, [{ pid: 90, path: '/bin/zsh' }], 'executableName'],
    [() => '/Applications/Editor.app/Contents/MacOS/Editor', [{ pid: 90, path: '/Applications/Unknown.app/Contents/MacOS/Unknown' }], 'processAncestry[0]']]) {
    const h = realPolicyFixture(await loadMacAppPolicy({ executable }), { ancestry });
    try {
      await assert.rejects(h.safety.request('getApp', { selector: 'TextEdit' }), { code: 'APP_POLICY_INVALID_METADATA', cause });
      assert.deepEqual(h.calls, ['resolveApp']);
      assert.equal(h.cards.length, 0);
    } finally { h.safety.close(); }
  }
});

test('an absent app or an empty window list never asks for approval or acquires a lease', async () => {
  for (const absent of [false, true]) {
    const h = fixture({ noWindows: true, absent });
    await assert.rejects(h.safety.request('getApp', { selector: 'Example' }), { code: 'NO_WINDOWS_AVAILABLE' });
    assert.equal(h.cards.length, 0); assert.equal(h.reads(), 0);
    assert.deepEqual(h.calls.map(([method]) => method), ['resolveApp']);
  }
});

for (const [name, state, note] of [
  ['current Space', { onScreen: true, fullScreen: false }, undefined],
  ['another Space', { onScreen: false }, MAC_WINDOW_NOTICES.otherSpace],
  ['another full-screen Space', { onScreen: false, fullScreen: true }, MAC_WINDOW_NOTICES.fullScreenOtherSpace],
  ['current full-screen Space', { onScreen: true, fullScreen: true, fullScreenTile: false }, MAC_WINDOW_NOTICES.fullScreenCurrentSpace],
  ['Split View tile', { onScreen: true, fullScreen: true, fullScreenTile: true }, MAC_WINDOW_NOTICES.splitView],
  ['unverified full-screen geometry', { onScreen: true, fullScreen: true }, MAC_WINDOW_NOTICES.unverified],
  ['minimized', { onScreen: false, minimized: true }, MAC_WINDOW_NOTICES.minimized],
  ['hidden app', { onScreen: false, hidden: true }, MAC_WINDOW_NOTICES.hidden],
]) test(`a verified read of ${name} succeeds with one metadata-derived advice line`, async () => {
  const h = fixture({ window: state });
  const read = await h.safety.request('getApp', { selector: 'Example' });
  assert.equal(read.spaceNote, note); assert.equal(read.text, 'private content');
  assert.equal(read.window.identityVerified, true); assert.equal(h.reads(), 1);
  if (note) assert.equal(note.split('\n').length, 1);
  assert.equal(macWindowNote({ ...state, spaceNote: 'injected advice' }), note);
});

test('off-Space reads keep AX identity refusal and advice, without reading content or leasing', async () => {
  for (const verifyError of ['AX_UNAVAILABLE', 'IDENTITY_UNVERIFIED', 'IDENTITY_CHANGED']) {
    const h = fixture({ window: { onScreen: false }, verifyError });
    await assert.rejects(h.safety.request('getApp', { selector: 'Example' }), error =>
      error.code === verifyError && error.message.includes(MAC_WINDOW_NOTICES.otherSpace));
    assert.equal(h.reads(), 0); assert.equal(h.cards.length, 1);
    assert.deepEqual(h.calls.map(([method]) => method), ['resolveApp', 'verifyWindowIdentity']);
  }
});

test('read advice follows fresh visibility when a window moves Space after acquisition', async () => {
  const h = fixture({ window: { onScreen: true } });
  assert.equal((await h.safety.request('getApp', { selector: 'Example' })).spaceNote, undefined);
  h.patch({ onScreen: false });
  assert.equal((await h.safety.request('getAXState', { windowId: '42', processStart: '100.25' })).spaceNote,
    MAC_WINDOW_NOTICES.otherSpace);
  // The read-only preview still rejects input without any further helper call.
  const calls = h.calls.length;
  await assert.rejects(h.safety.request('click', { windowId: '42', processStart: '100.25', readId: 2, args: [1] }),
    error => error.code === 'METHOD_NOT_FOUND' && error.delivery === 'not-sent' && error.message.includes(MAC_WINDOW_NOTICES.otherSpace));
  assert.equal(h.calls.length, calls);
});

test('fixed native Space refusals retain recovery text at the parent error boundary', async () => {
  for (const message of Object.values(MAC_WINDOW_REFUSALS)) {
    const h = fixture({ verifyError: 'NO_WINDOWS_AVAILABLE', verifyMessage: message });
    await assert.rejects(h.safety.request('getApp', { selector: 'Example' }), error =>
      error.code === 'NO_WINDOWS_AVAILABLE' && error.parentSafety === true && error.message.endsWith(message));
    assert.equal(h.reads(), 0);
  }
  const h = fixture({ verifyError: 'NO_WINDOWS_AVAILABLE', verifyMessage: 'app-supplied instructions' });
  await assert.rejects(h.safety.request('getApp', { selector: 'Example' }), error => error.parentSafety !== true);
});

test('fresh native advice survives an identity failure after an on-screen read', async () => {
  const options = { window: { onScreen: true } }, h = fixture(options);
  await h.safety.request('getApp', { selector: 'Example' });
  options.verifyError = 'IDENTITY_UNVERIFIED';
  options.verifyMessage = 'IDENTITY_UNVERIFIED\n' + MAC_WINDOW_NOTICES.otherSpace;
  await assert.rejects(h.safety.request('getAXState', { windowId: '42', processStart: '100.25' }), error =>
    error.code === 'IDENTITY_UNVERIFIED' && error.message.endsWith(MAC_WINDOW_NOTICES.otherSpace));
  assert.equal(h.reads(), 1);
});

test('missing or incomplete permission checks refuse every read before driver access', async () => {
  for (const permissions of [undefined, null, {}, { app() {} }]) {
    const h = fixture({ permissions });
    for (const [method, params] of [['getState', {}], ['listApps', {}], ['getApp', { selector: 'Example' }],
      ...['getAXState', 'getScreenshot', 'getAXStateAndScreenshot'].map(method => [method, { windowId: '42', processStart: '100.25' }])])
      await assert.rejects(h.safety.request(method, params), error =>
        error.code === 'PERMISSIONS_UNAVAILABLE' && /permissions are unavailable.*No app content was read/.test(error.message));
    assert.equal(h.calls.length, 0); assert.equal(h.cards.length, 0);
  }
});

test('forged input IPC and unknown helper methods never reach a driver', async () => {
  const h = fixture();
  for (const method of [...DRIVER_ACTION_METHODS, 'stuckMenuEscape', 'resolveElement', 'resolveApp', 'health', 'ping'])
    await assert.rejects(h.safety.request(method, {}), { code: 'METHOD_NOT_FOUND' });
  assert.equal(h.calls.length, 0); assert.equal(h.cards.length, 0);
});

test('strict IPC validation rejects missing bindings and extra native controls', async () => {
  const h = fixture();
  for (const [method, params] of [
    ['getApp', { selector: 'Example', allowLocked: true }], ['getApp', { selector: { windowId: 42 } }],
    ['getAXState', { windowId: '42', processStart: '100.25', allowLocked: true }],
    ['getScreenshot', { windowId: '42', processStart: '100.25', depth: 2 }],
    ['getAXState', { windowId: '42', processStart: '100.25', budgetMs: 0 }],
    ['getAXState', { windowId: '42', processStart: '100.25', format: 'png' }],
    ['getScreenshot', { windowId: '42', processStart: '100.25', format: 'jpg' }],
    ['getScreenshot', { windowId: '42', processStart: '100.25', scale: null }],
    ['getAXStateAndScreenshot', { windowId: '42', processStart: '100.25', scale: 1 }],
    ['getAXState', { windowId: '42' }], ['getState', { extra: true }],
  ]) await assert.rejects(h.safety.request(method, params), { code: 'INVALID_PARAMS' });
  assert.equal(h.calls.length, 0);
});

test('reset cancels an in-flight approval before it can read or remember a grant', async () => {
  let answer, shown;
  const cardShown = new Promise(resolve => { shown = resolve; });
  const h = fixture({ approve: () => { shown(); return new Promise(resolve => { answer = resolve; }); } });
  const pending = h.safety.request('getApp', { selector: 'Example' });
  await cardShown; h.safety.reset(); answer(true);
  await assert.rejects(pending, { code: 'REPL_CELL_ENDED' });
  assert.equal(h.reads(), 0); assert.equal(h.releases(), 1);
});

test('a throwing lease release cannot leave a revoked handle acquired', async () => {
  const h = fixture({ release() { throw Error('release failed'); } });
  await h.safety.request('getApp', { selector: 'Example' });
  const before = h.calls.length;
  // livePreapproved's onRemoved listener catches this error after invalidation.
  assert.throws(() => h.safety.revoke([window.bundleId]), { code: 'LEASE_REFUSED' });
  await assert.rejects(h.safety.request('getAXState', { windowId: '42', processStart: '100.25' }), { code: 'APP_NOT_ACQUIRED' });
  assert.equal(h.calls.length, before); assert.equal(h.reads(), 1); assert.equal(h.releases(), 1);
});

test('revocation matches both original and changed cached bundle ids', async () => {
  for (const app of [window.bundleId, 'com.example.Changed']) {
    const h = fixture({ cachedBundle: 'com.example.Changed' });
    await h.safety.request('getApp', { selector: 'Example' });
    const before = h.calls.length;
    h.safety.revoke([app]);
    await assert.rejects(h.safety.request('getAXState', { windowId: '42', processStart: '100.25' }), { code: 'APP_NOT_ACQUIRED' });
    assert.equal(h.calls.length, before); assert.equal(h.releases(), 1);
  }
});

test('non-session approvals remember neither a grant nor a decline across acquisitions', async () => {
  for (const approvalScope of ['once', 'document']) {
    let granted = false;
    const h = fixture({ approvalScope, approve: () => granted });
    await assert.rejects(h.safety.request('getApp', { selector: 'Example' }), { code: 'APP_DECLINED' });
    granted = true;
    await h.safety.request('getApp', { selector: 'Example' });
    granted = false;
    await assert.rejects(h.safety.request('getApp', { selector: 'Example' }), { code: 'APP_DECLINED' });
    assert.equal(h.cards.length, 3); assert.equal(h.reads(), 1);
  }
});

test('once asks again on a held handle and a decline prevents the next content read', async () => {
  let granted = true;
  const h = fixture({ approvalScope: 'once', approve: () => granted });
  await h.safety.request('getApp', { selector: 'Example' });
  granted = false;
  await assert.rejects(h.safety.request('getAXState', { windowId: '42', processStart: '100.25' }), { code: 'APP_DECLINED' });
  assert.equal(h.reads(), 1);
  granted = true;
  await h.safety.request('getAXState', { windowId: '42', processStart: '100.25' });
  assert.equal(h.cards.length, 3); assert.equal(h.reads(), 2);
});

test('revocation drops cached windows without a bundle id by original bundle or app name', async () => {
  for (const app of [window.bundleId, window.app]) {
    const h = fixture({ dropCachedBundle: true });
    const result = await h.safety.request('getApp', { selector: 'Example' });
    assert.equal(result.window.bundleId, undefined);
    const before = h.calls.length;
    assert.doesNotThrow(() => h.safety.revoke([app]));
    await assert.rejects(h.safety.request('getAXState', { windowId: '42', processStart: '100.25' }), { code: 'APP_NOT_ACQUIRED' });
    assert.equal(h.calls.length, before); assert.equal(h.reads(), 1); assert.equal(h.releases(), 1);
  }
});

test('identity change after a driver read suppresses the entire returned content', async () => {
  const h = fixture({ afterRead: { ...window, processStart: 'replacement' } });
  await assert.rejects(h.safety.request('getApp', { selector: 'Example' }), { code: 'IDENTITY_CHANGED' });
  assert.equal(h.reads(), 1);
});

test('title policy runs again before a bound window read', async () => {
  const titles = [];
  const h = fixture({ policy: (_bundle, _ancestry, title) => {
    titles.push(title);
    return title === 'Settings' ? { allow: false, code: 'SETTINGS', message: 'Settings are refused.' } : { allow: true };
  } });
  await h.safety.request('getApp', { selector: 'Example' });
  h.patch({ title: 'Settings' });
  await assert.rejects(h.safety.request('getAXState', { windowId: '42', processStart: '100.25' }), { code: 'SETTINGS' });
  assert.equal(h.reads(), 1); assert.equal(titles.at(-1), 'Settings');
});

test('the user switch lifts only policy refusals explicitly marked overridable', async () => {
  for (const overridable of [true, false]) {
    const h = fixture({ allowForbidden: () => true,
      policy: () => ({ allow: false, code: 'CATEGORY_REFUSED', message: 'Category refused.', overridable }) });
    if (overridable) assert.equal((await h.safety.request('getApp', { selector: 'Example' })).readId, 1);
    else { await assert.rejects(h.safety.request('getApp', { selector: 'Example' }), { code: 'CATEGORY_REFUSED' }); assert.equal(h.cards.length, 0); }
  }
});

test('policy loader accepts the RT28 function and fails closed on malformed modules', async () => {
  const evaluateAppPolicy = () => ({ allow: true });
  const loaded = await loadMacAppPolicy({ load: async () => ({ evaluateAppPolicy }), executable: () => undefined });
  assert.equal(loaded('test.editor', [], '').allow, true);
  const malformed = await loadMacAppPolicy({ load: async () => ({ evaluateAppPolicy: true }) });
  assert.equal(malformed().code, 'APP_POLICY_UNAVAILABLE');
});

test('a failed prior ending cannot suppress a later release', async () => {
  for (const failBoth of [false, true]) {
    let finish;
    const restoring = new Promise(resolve => { finish = resolve; });
    let releases = 0;
    const firstError = Error('release failed');
    const h = fixture({ beforeLeaseEnd: () => restoring, release() {
      if (++releases === 1) throw firstError;
      if (failBoth) throw Error('second release failed');
    } });
    await h.safety.request('getApp', { selector: 'Example' });
    const first = h.safety.endTurn();
    const second = h.safety.reset();
    const one = assert.rejects(first, error => error === firstError), two = assert.rejects(second, error => error === firstError);
    finish(); await Promise.all([one, two]);
    assert.equal(releases, 2);

  }
});

test('a failed current restore keeps its own lease reserved', async () => {
  const h = fixture({ beforeLeaseEnd: () => { throw Error('helper still running'); } });
  await h.safety.request('getApp', { selector: 'Example' });
  await assert.rejects(h.safety.endTurn(), /helper still running/);
  assert.equal(h.releases(), 0);
  await assert.rejects(h.safety.reset(), /helper still running/);
  await assert.rejects(h.safety.request('getApp', { selector: 'Example' }), { code: 'LEASE_REFUSED' });
  assert.equal(h.releases(), 0);
});


test('SA2U retries rejected host ancestry and logs only the first elapsed lookup', async () => {
  let attempts = 0, clock = 10;
  const lines = [];
  const h = realPolicyFixture(() => ({ allow: true }), { now: () => clock, diagnostics: line => lines.push(line),
    ancestry: () => { clock += 37; if (++attempts === 1) throw Error('transient'); return [{ pid: 90, path: '/bin/zsh' }]; } });
  try {
    await assert.rejects(h.safety.request('getApp', { selector: 'TextEdit' }), { code: 'ANCESTRY_UNAVAILABLE' });
    assert.equal((await h.safety.request('getApp', { selector: 'TextEdit' })).readId, 1);
    assert.equal(attempts, 2); assert.equal(h.cards.length, 1);
    assert.deepEqual(lines, ['sleight: Glide first host ancestry lookup 37 ms']);
  } finally { h.safety.close(); }
});

for (const [label, targetParents] of [['throw', () => { throw Error('gone'); }], ['empty', () => []],
  ['non-integer', () => [50, 1.5]]]) test(`SA2U invalid target parents ${label} refuses before approval`, async () => {
  const h = realPolicyFixture(() => ({ allow: true }), { targetParents });
  try {
    await assert.rejects(h.safety.request('getApp', { selector: 'TextEdit' }), { code: 'ANCESTRY_UNAVAILABLE' });
    assert.deepEqual(h.calls, ['resolveApp']); assert.equal(h.cards.length, 0);
  } finally { h.safety.close(); }
});

for (const pid of [undefined, '50', 1, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
  test(`SA2U invalid app pid ${String(pid)} refuses before target walk`, async () => {
    let walks = 0;
    const h = realPolicyFixture(() => ({ allow: true }), { metadata: { pid }, omitPid: pid === undefined, targetParents: () => { walks++; return [1]; } });
    try {
      await assert.rejects(h.safety.request('getApp', { selector: 'TextEdit' }), { code: 'ANCESTRY_UNAVAILABLE' });
      assert.equal(walks, 0); assert.equal(h.cards.length, 0); assert.deepEqual(h.calls, ['resolveApp']);
    } finally { h.safety.close(); }
  });

test('SA2U null pid skips target walk for a non-running app listing', async () => {
  let walks = 0;
  const safety = createMacSafety({ lease: { close() {} }, driver: { request: async () => ({ apps: [{ id: 'test.absent', pid: null, running: false }] }) },
    policy: () => ({ allow: true }), ancestry: () => [{ pid: 90, path: '/bin/zsh' }],
    targetParents: () => { walks++; throw Error('must not run'); },
    permissions: { app() {}, page() {}, sitesLimited: () => false } });
  try { assert.equal((await safety.request('listApps', {})).apps.length, 1); assert.equal(walks, 0); }
  finally { safety.close(); }
});

for (const method of ['listApps', 'getState']) test(`SA2U ${method} skips failed target walks and caches pid plus start for one listing`, async () => {
  const walks = [], owned = [];
  const apps = [
    { id: 'test.gone', pid: 50, processStart: '1' },
    { id: 'test.goneAgain', pid: 50, processStart: '1' },
    { id: 'test.good', pid: 60, processStart: '1' },
    { id: 'test.same', pid: 60, processStart: '1' },
    { id: 'test.reused', pid: 60, processStart: '2' },
  ];
  const safety = createMacSafety({ lease: { close() {} }, driver: { request: async () => ({ apps }) },
    policy: () => ({ allow: true }), ancestry: () => [{ pid: 90, path: '/bin/zsh' }],
    targetParents: pid => { walks.push(pid); if (pid === 50) throw Error('exited'); return [pid, 70, 1]; },
    ownHostPid: pid => { owned.push(pid); return false; },
    permissions: { app() {}, page() {}, sitesLimited: () => false } });
  try {
    for (let run = 1; run <= 2; run++) {
      const result = await safety.request(method, {});
      assert.deepEqual(result.apps.map(app => app.id), ['test.good', 'test.same', 'test.reused']);
      assert.deepEqual(walks, Array.from({ length: run }, () => [50, 60, 60]).flat());
    }
    assert.equal(owned.filter(pid => pid === 70).length, 4);
  } finally { safety.close(); }
});

test('SA2U shared target deadline bounds ownHostPid and refuses an overrun', async () => {
  let clock = 0, walks = 0;
  const budgets = [];
  const h = realPolicyFixture(() => ({ allow: true }), { now: () => clock,
    targetParents: (_pid, ms) => { walks++; budgets.push(ms); clock += 700; return [50, 60]; },
    ownHostPid: (_pid, ms) => { budgets.push(ms); clock += 1600; return false; } });
  try {
    await assert.rejects(h.safety.request('getApp', { selector: 'TextEdit' }), { code: 'ANCESTRY_UNAVAILABLE' });
    assert.equal(walks, 1); assert.deepEqual(budgets, [3000, 2300, 700]);
    assert.equal(h.cards.length, 0); assert.deepEqual(h.calls, ['resolveApp']);
  } finally { h.safety.close(); }
});

for (const pass of ['login', 'sudo', 'su', 'zsh']) test(`SA2U pass-through ${pass} resolves without lsof for a root-owned row`, () => {
  let lsof = 0;
  const rows = macSafety.macProcessAncestry({ pid: 100, run(file, args) {
    if (file === '/usr/sbin/lsof') { lsof++; return ''; }
    if (args.at(-1) === 'comm=') return '/usr/bin/' + pass;
    return '1';
  } });
  assert.deepEqual(rows, [{ pid: 100, ppid: 1, path: '/usr/bin/' + pass, kind: 'non-app' }]);
  assert.equal(lsof, 0);
});

for (const command of ['/Applications/Terminal.app/Contents/MacOS/Terminal', '/fixture/login'])
  test(`SA2U non-pass-through ${command} still requires lsof`, () => {
    let lsof = 0;
    assert.throws(() => macSafety.macProcessAncestry({ pid: 100, run(file, args) {
      if (file === '/usr/sbin/lsof') { lsof++; return ''; }
      return args.at(-1) === 'comm=' ? command : '1';
    } }), /ANCESTRY_UNAVAILABLE/);
    assert.equal(lsof, 1);
  });

test('SA2U executable failure midway through host chain fails closed', () => {
  const visited = [];
  assert.throws(() => macSafety.macProcessAncestry({ pid: 100, executable(pid) {
    visited.push(pid); if (pid === 99) throw Error('lsof timed out'); return '/bin/node';
  }, run: () => '99' }), /lsof timed out|ANCESTRY_UNAVAILABLE/);
  assert.deepEqual(visited, [100, 99]);
});

test('SA2U default plist reader over deadline refuses before parent lookup', () => {
  let clock = 0, parents = 0;
  assert.throws(() => macSafety.macProcessAncestry({ pid: 100, now: () => clock,
    executable: () => '/Applications/Host.app/Contents/MacOS/Host', run(file, _args, options) {
      if (file === '/usr/bin/plutil') { assert.equal(options.timeout, 3000); clock = 3001; return 'test.host'; }
      parents++; return '1';
    } }), /ANCESTRY_UNAVAILABLE/);
  assert.equal(parents, 0);
});


for (const method of ['getState', 'listApps']) test(`SA2U ${method} keeps host ancestry failure fatal`, async () => {
  const safety = createMacSafety({ lease: { close() {} },
    driver: { request: async () => ({ apps: [{ id: 'test.app', pid: 50, processStart: '1' }] }) },
    policy: () => ({ allow: true }), ancestry: () => { throw Error('host chain lost'); }, targetParents: () => [50, 1],
    permissions: { app() {}, page() {}, sitesLimited: () => false } });
  try { await assert.rejects(safety.request(method, {}), { code: 'ANCESTRY_UNAVAILABLE' }); }
  finally { safety.close(); }
});

test('SA2U Terminal root-owned chain keeps lsof for node and the app but skips login', () => {
  const terminal = '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal';
  const paths = { 100: '/opt/homebrew/bin/node', 99: '/usr/bin/login', 98: terminal }, lsof = [];
  const rows = macSafety.macProcessAncestry({ pid: 100, run(file, args, options) {
    assert.ok(options.timeout > 0 && options.timeout <= 3000);
    assert.equal(options.killSignal, 'SIGKILL');
    if (file === '/usr/bin/plutil') return 'com.apple.Terminal';
    const pid = Number(args[args.indexOf('-p') + 1]);
    if (file === '/usr/sbin/lsof') { lsof.push(pid); return pid === 99 ? '' : 'n' + paths[pid]; }
    assert.equal(file, '/bin/ps');
    return args.at(-1) === 'comm=' ? paths[pid] : String(pid === 98 ? 1 : pid - 1);
  } });
  assert.deepEqual(rows, [
    { pid: 100, ppid: 99, path: paths[100], kind: 'non-app' },
    { pid: 99, ppid: 98, path: paths[99], kind: 'non-app' },
    { pid: 98, ppid: 1, path: terminal, bundleId: 'com.apple.Terminal' },
  ]);
  assert.deepEqual(lsof, [100, 98]);
});
