import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { realBrowserPlan, checkBrowserOwner, launchRealBrowser, resetRealBrowser, observeRealBrowser } from '../bench/fowl/real-browser.mjs';
import { realGatePlan, runRealGate } from '../bench/fowl/real-gate.mjs';
import { taskSupport } from '../bench/fowl/support.mjs';
import { answer } from '../bench/fowl/origin-hook.mjs';
import { macCommandSkip } from './requirements.mjs';

// The launch proof resolves the real /Applications/Safari.app executable, so launches through the fake bridge need macOS.
const launchSkip = process.platform !== 'darwin' && 'the Safari launch proof resolves /Applications/Safari.app';

const task = { name: 'fixture', browser: 'chrome', prompt: 'Visit {browser}.', result: 'the answer' };
const profile = 'sleight benchmark';
const window = (id, title = 'Start Page', url = 'about:blank') => ({ id, title,
  toolbar: [{ id: id + '-profile', role: 'AXMenuButton', description: profile }], tabs: [{ id: id + '-tab', title, url }] });
function fixture(t) {
  const plan = realBrowserPlan({ browser: 'safari', round: 'test-' + randomUUID() });
  t.after(() => rmSync(dirname(plan.profileRoot), { recursive: true, force: true }));
  const calls = []; let running = false, windows = [], serial = 0, pid = 4100;
  const bridge = { request: async (op, input = {}) => {
    calls.push([op, input]);
    if (op === 'launch') { running = true; pid += 1; return { pid, executable: plan.executable, launchDate: Date.now() / 1000 }; }
    if (op === 'snapshot') return { windows: structuredClone(windows) };
    if (op === 'close-launch-window') { windows = windows.filter(w => w.id !== input.window); return {}; }
    if (op === 'new-profile') { windows.push(window('fresh-' + ++serial)); return { menuEscapePosted: true, menuCleared: true, menuEscapes: 1 }; }
    if (op === 'navigate') { const w = windows.find(w => w.id === input.window); w.title = plan.marker; w.tabs = [{ id: w.id + '-tab', title: plan.marker, url: input.url }]; return {}; }
    if (op === 'close-window') { windows = windows.filter(w => w.id !== input.window); return {}; }
    if (op === 'quit') { running = false; windows = []; return { browserClosed: true }; }
    throw Error('unexpected operation ' + op);
  }, close: async () => calls.push(['bridge-closed']) };
  const options = { safariBridge: async () => bridge, timeoutMs: 50,
    restoreWait: async ms => { assert.equal(ms, 2000); calls.push(['restore-wait', { ms }]); },
    listProcesses: async () => running ? [{ pid, ppid: 1, executable: plan.executable }] : [] };
  return { plan, options, bridge, calls, windows: value => { if (value) windows = value; return windows; } };
}

test('Safari plan uses the owner-created named profile and background native launch without WebDriver', () => {
  const plan = realBrowserPlan({ browser: 'safari', round: 'safari-plan' });
  assert.equal(plan.executable, '/Applications/Safari.app/Contents/MacOS/Safari');
  assert.equal(plan.profileName, profile);
  assert.equal(plan.connectionMode, 'engine-computer');
  assert.equal(plan.launchMode, 'NSWorkspace-background');
  assert.equal(plan.resetMode, 'fresh-profile-window');
  assert.equal(plan.inventoryMode, 'AX-tab-bar');
  assert.equal(plan.profileOwned, false);
  assert.ok(!JSON.stringify(plan).match(/safaridriver|remote-debugging/));
});

test('Safari census includes bundle helpers, short names and Safari WebContent with strict ancestry', async () => {
  const plan = realBrowserPlan({ browser: 'safari', round: 'census' });
  for (const executable of ['(sAfArI)', 'Safari Web Content', '/Applications/Safari.app/Contents/XPCServices/helper', 'com.apple.WebKit.WebContent (com.apple.Safari)']) {
    await assert.rejects(checkBrowserOwner(plan, { responsibleFor: async () => new Map(), listProcesses: async () => [{ pid: 7, ppid: 1, executable }] }), /PID 7/);
  }
  const rows = [{ pid: 40, ppid: 1, executable: plan.executable }, { pid: 41, ppid: 40, executable: 'intermediate' },
    { pid: 42, ppid: 41, executable: 'Safari Web Content' }];
  assert.equal((await checkBrowserOwner(plan, { ownedPid: 40, listProcesses: async () => rows })).ok, true);
  await assert.rejects(checkBrowserOwner(plan, { ownedPid: 40, listProcesses: async () => [...rows, { pid: 43, ppid: 1, executable: 'Safari Web Content' }] }), /PID 43/);
  await assert.rejects(checkBrowserOwner(plan, { ownedPid: 40, listProcesses: async () => [...rows, rows[0]] }), /INVALID/);
});

test('Safari dry plans support all five arms with plain sleight, explicit limits and profile fences', t => {
  const dir = mkdtempSync(join(tmpdir(), 'br2s-plan-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const armHome = join(dir, 'arms'); mkdirSync(join(armHome, 'lcu-arm'), { recursive: true });
  writeFileSync(join(armHome, 'lcu-arm/.mcp.json'), JSON.stringify({ mcpServers: { lcu: { command: '/fixture/lcu' } } }));
  const tasks = [task, { ...task, name: 'mobile', viewport: {} }, { ...task, name: 'download', downloads: {} }, { ...task, name: 'takeover', takeover: {} }];
  for (const surface of [undefined, 'sleight', 'lcu', 'cua', 'peekaboo', 'codex']) {
    const plan = realGatePlan({ args: { 'real-browser': 'safari', surface, out: join(dir, 'never') }, tasks, armHome, round: 'dry' });
    assert.equal(plan.arms.length, 1);
    assert.match(plan.arms[0].prompt, /dedicated Safari window/);
    assert.match(plan.arms[0].prompt, /sleight benchmark/);
    assert.equal(plan.arms[0].metadata.profile, profile);
    assert.deepEqual(plan.unsupported.map(row => row.task.name), ['mobile', 'download', 'takeover']);
    if (!surface || surface === 'sleight') {
      assert.equal(plan.surface, 'sleight');
      assert.deepEqual(Object.keys(plan.arms[0].mcpConfig.mcpServers), ['plugin:sleight:computer']);
      assert.deepEqual(plan.arms[0].settingsOverrides.hooks.PreToolUse.map(h => h.matcher), ['mcp__plugin_sleight_computer__select_window']);
      assert.equal(plan.arms[0].mcpConfig.mcpServers['plugin:sleight:computer'].env.SLEIGHT_TURBO, '0');
      assert.deepEqual(JSON.parse(plan.arms[0].env.FOWL_GATE_WINDOW).apps, ['Safari', 'com.apple.Safari', '/Applications/Safari.app']);
    }
  }
  assert.equal(existsSync(join(dir, 'never')), false);
  assert.throws(() => realGatePlan({ args: { 'real-browser': 'safari', surface: 'sleight-turbo' }, tasks: [task] }), /turbo/i);
  assert.match(taskSupport(tasks[1], 'sleight', { realBrowser: 'safari' }), /viewport/);
  assert.equal(answer({ mcp_server_name: 'plugin:sleight:computer', message: 'Allow Computer Use to use "Safari"?' }), 'accept');
});

test('Safari gives each task its own Safari, quit by pid before the next launch, and never closes a window between tasks', { skip: launchSkip }, async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, f.options);
  assert.equal(browser.pid, 4101);
  assert.equal(browser.profileEvidence.attribute, 'AXDescription');
  assert.equal(browser.profileEvidence.value, profile);
  const first = await resetRealBrowser(browser);
  assert.equal(Object.values(first)[0].title, f.plan.marker);
  assert.equal(f.calls.filter(([op]) => op === 'launch').length, 1);
  assert.equal(f.calls.filter(([op]) => op === 'quit').length, 0);
  const firstWindow = f.windows()[0].id;
  f.windows().push(window('popup-from-the-task'));
  const second = await resetRealBrowser(browser);
  assert.equal(Object.values(second)[0].title, f.plan.marker);
  assert.equal(browser.pid, 4102);
  assert.equal(f.windows().length, 1);
  assert.notEqual(f.windows()[0].id, firstWindow);
  assert.ok(!f.calls.some(([op]) => op === 'close-window'));
  const ops = f.calls.map(([op]) => op);
  assert.ok(ops.lastIndexOf('quit') < ops.lastIndexOf('launch'));
  const observed = await observeRealBrowser(browser);
  assert.equal(observed.observed, true);
  assert.equal(Object.values(observed.tabs)[0].url, f.plan.markerUrl);
  assert.deepEqual(await browser.stop(), { browserClosed: true, profileDeleted: false, harnessDeleted: true });
  assert.equal(existsSync(dirname(f.plan.profileRoot)), false);
  assert.equal(f.calls.filter(([op]) => op === 'quit').length, 2);
  assert.equal(browser.collections.length, 2);
  assert.deepEqual(browser.collections.map(row => row.pid), [4101, 4102]);
  assert.equal(browser.launches.length, 2);
  assert.ok(browser.launches.every(row => Number.isFinite(row.launchMs) && Number.isFinite(row.readyMs)));
});

test('Safari refuses owner restored windows before opening a profile or mutating windows', { skip: launchSkip }, async t => {
  for (const restored of [[{ id: 'owner', toolbar: [] }], [window('profile'), { id: 'owner', toolbar: [] }]]) {
    const f = fixture(t); f.windows(restored);
    await assert.rejects(launchRealBrowser(f.plan, f.options), /BENCH_SAFARI_RESTORED_WINDOWS: Safari restored windows from another profile; close your Safari windows or turn off window restore, then retry/);
    assert.ok(!f.calls.some(([op]) => ['new-profile', 'navigate', 'close-window'].includes(op)));
    assert.ok(f.calls.some(([op]) => op === 'quit'));
  }
});

test('Safari waits for delayed restore and never closes even a restored benchmark window', { skip: launchSkip }, async t => {
  const f = fixture(t), request = f.bridge.request; let snapshots = 0;
  f.bridge.request = async (op, input) => {
    if (op === 'snapshot' && ++snapshots === 1) f.windows([{ id: 'late-owner', toolbar: [] }]);
    return request(op, input);
  };
  await assert.rejects(launchRealBrowser(f.plan, f.options), /RESTORED_WINDOWS/);
  assert.ok(!f.calls.some(([op]) => ['new-profile', 'navigate', 'close-window'].includes(op)));
  const g = fixture(t); g.windows([window('restored-profile')]);
  await assert.rejects(launchRealBrowser(g.plan, g.options), /EXTRA_WINDOWS/);
  assert.ok(!g.calls.some(([op]) => ['navigate', 'close-window'].includes(op)));
});

const startPage = (id, proven = false) => ({ id, startPage: true, ...(proven ? { profileEvidence: { element: id + '-p', role: 'AXMenuButton', attribute: 'AXIdentifier', value: profile } } : { profileEvidence: null }) });

test('Safari closes the Start Page window it opened at launch before creating the benchmark window', { skip: launchSkip }, async t => {
  for (const proven of [false, true]) {
    const f = fixture(t); f.windows([startPage('launch-start', proven)]);
    const browser = await launchRealBrowser(f.plan, f.options);
    const ops = f.calls.map(([op]) => op);
    assert.deepEqual(f.calls.filter(([op]) => op === 'close-launch-window').map(([, data]) => data.window), ['launch-start']);
    assert.ok(ops.indexOf('close-launch-window') < ops.indexOf('new-profile'));
    assert.ok(!ops.includes('close-window'));
    assert.equal(f.windows().length, 1);
    assert.equal(f.windows()[0].id, 'fresh-1');
    await browser.stop();
  }
});

test('only Start Page windows are closed at launch; anything else stops the round untouched', { skip: launchSkip }, async t => {
  // An unproven window that is not a Start Page, next to a Start Page: restored, so nothing is closed.
  const mixed = fixture(t); mixed.windows([startPage('launch-start'), { id: 'owner', profileEvidence: null }]);
  await assert.rejects(launchRealBrowser(mixed.plan, mixed.options), /BENCH_SAFARI_RESTORED_WINDOWS/);
  // A proven profile window with pages (no startPage flag) is extra, not ours to close.
  const extra = fixture(t); extra.windows([startPage('launch-start'), window('profile-with-pages')]);
  await assert.rejects(launchRealBrowser(extra.plan, extra.options), /EXTRA_WINDOWS/);
  for (const f of [mixed, extra]) assert.ok(!f.calls.some(([op]) => ['close-launch-window', 'close-window', 'new-profile', 'navigate'].includes(op)));
});

test('a Start Page window that does not close stops the round before the profile window is created', { skip: launchSkip }, async t => {
  const f = fixture(t), request = f.bridge.request; f.windows([startPage('stuck')]);
  f.bridge.request = async (op, input) => op === 'close-launch-window' ? (f.calls.push([op, input]), {}) : request(op, input);
  await assert.rejects(launchRealBrowser(f.plan, f.options), /LAUNCH_WINDOW_UNCLOSED/);
  assert.ok(!f.calls.some(([op]) => ['new-profile', 'navigate'].includes(op)));
});

test('a process that predates the launch request is refused before any window is read or closed', async t => {
  const f = fixture(t), request = f.bridge.request; f.windows([startPage('old')]);
  f.bridge.request = async (op, input) => { const result = await request(op, input); return op === 'launch' ? { ...result, launchDate: Date.now() / 1000 - 60 } : result; };
  await assert.rejects(launchRealBrowser(f.plan, f.options), /LAUNCH_UNPROVED/);
  assert.ok(!f.calls.some(([op]) => ['snapshot', 'close-launch-window', 'new-profile'].includes(op)));
});

test('profile evidence reads the Safari 26 toolbar identifier and nothing looser', async () => {
  const { safariProfileEvidence, identifierProfile } = await import('../bench/fowl/safari-browser.mjs');
  const id = 'TabGroupPickerButton?Profile=sleight%20benchmark&Icon=hammer.fill';
  assert.equal(identifierProfile(id), profile);
  assert.equal(identifierProfile('TabGroupPickerButton?Icon=x&Profile=sleight%20benchmark'), profile);
  for (const other of ['TabGroupPickerButton?Profile=owner', 'Other?Profile=sleight%20benchmark', 'TabGroupPickerButton?Profile=sleight%20benchmark%20x',
    'TabGroupPickerButton?Profile=%E0%A4%A', 'TabGroupPickerButton', undefined]) assert.notEqual(identifierProfile(other), profile);
  assert.deepEqual(safariProfileEvidence({ toolbar: [{ id: 'picker', role: 'AXMenuButton', identifier: id }] }),
    { element: 'picker', role: 'AXMenuButton', identifier: id, attribute: 'AXIdentifier', value: profile });
  assert.equal(safariProfileEvidence({ toolbar: [{ id: 'picker', role: 'AXStaticText', identifier: id }] }), null);
  assert.equal(safariProfileEvidence({ toolbar: [{ id: 'picker', role: 'AXMenuButton', identifier: 'TabGroupPickerButton?Profile=owner' }] }), null);
  const native = { value: profile, element: 'button', role: 'AXMenuButton', attribute: 'AXIdentifier' };
  assert.deepEqual(safariProfileEvidence({ profileEvidence: native }), native);
});

test('profile evidence cannot come from page content, window title or a substring', async () => {
  const { safariProfileEvidence } = await import('../bench/fowl/safari-browser.mjs');
  assert.equal(safariProfileEvidence({ title: profile, toolbar: [], content: [{ description: profile }] }), null);
  assert.equal(safariProfileEvidence({ toolbar: [{ role: 'AXMenuButton', description: profile + ' other' }] }), null);
  assert.equal(safariProfileEvidence({ toolbar: [{ role: 'AXStaticText', value: profile }] }), null);
  assert.deepEqual(safariProfileEvidence({ toolbar: [{ id: 'profile', role: 'AXMenuButton', title: profile }] }),
    { element: 'profile', role: 'AXMenuButton', attribute: 'AXTitle', value: profile });
});

test('profile evidence prefers the profile button and records the matching element', async () => {
  const { safariProfileEvidence } = await import('../bench/fowl/safari-browser.mjs');
  const toolbar = [{ id: 'other', role: 'AXButton', title: profile },
    { id: 'profile', identifier: 'ProfileButton', role: 'AXMenuButton', description: profile }];
  assert.deepEqual(safariProfileEvidence({ toolbar }), { element: 'profile', role: 'AXMenuButton', identifier: 'ProfileButton',
    attribute: 'AXDescription', value: profile });
});

test('ambiguous toolbar matches and malformed native evidence cannot prove a profile', async () => {
  const { safariProfileEvidence } = await import('../bench/fowl/safari-browser.mjs');
  assert.equal(safariProfileEvidence({ toolbar: [{ id: 'one', role: 'AXMenuButton', title: profile },
    { id: 'two', role: 'AXMenuButton', title: profile }] }), null);
  for (const evidence of [{}, { value: profile, element: 'web', role: 'AXStaticText', attribute: 'AXTitle' }]) {
    assert.equal(safariProfileEvidence({ profileEvidence: evidence }), null);
  }
  const evidence = { value: profile, element: 'button', role: 'AXMenuButton', attribute: 'AXDescription' };
  assert.deepEqual(safariProfileEvidence({ profileEvidence: evidence }), evidence);
});

test('missing or ambiguous new profile evidence stops before navigating or closing restored windows', { skip: launchSkip }, async t => {
  for (const ambiguous of [false, true]) {
    const f = fixture(t), original = f.bridge.request;
    f.bridge.request = async (op, input) => {
      const result = await original(op, input);
      if (op === 'new-profile') f.windows(ambiguous ? [window('a'), window('b')] : [{ ...window('a'), toolbar: [] }]);
      return result;
    };
    await assert.rejects(launchRealBrowser(f.plan, f.options), error => {
      assert.match(error.message, /BENCH_SAFARI_PROFILE_WINDOW_UNPROVED/);
      const seen = ambiguous ? [{ title: 'Start Page', tabs: 1, profile: true }, { title: 'Start Page', tabs: 1, profile: true }] :
        [{ title: 'Start Page', tabs: 1, profile: false }];
      assert.ok(error.message.includes(`${seen.length} new windows ${JSON.stringify(seen)}`));
      if (!ambiguous) assert.ok(error.message.endsWith(', 0 before'));
      return true;
    });
    assert.ok(!f.calls.some(([op]) => ['navigate', 'close-window'].includes(op)));
    assert.ok(f.calls.some(([op]) => op === 'quit'));
  }
});

test('a refused new-profile frame stops before navigation and collects the owned browser and helper', { skip: launchSkip }, async t => {
  for (const reason of ['BENCH_SAFARI_FRAME_WINDOW_UNPROVED', 'BENCH_SAFARI_FRAME_REFUSED: [-25205]',
    'BENCH_SAFARI_FRAME_UNPROVED: [width: 600] for 1280 x 900', 'BENCH_SAFARI_DISPLAY_TOO_SMALL']) {
    const f = fixture(t), request = f.bridge.request;
    f.bridge.request = async (op, input) => {
      const result = await request(op, input);
      if (op === 'new-profile') throw Error(reason);
      return result;
    };
    await assert.rejects(launchRealBrowser(f.plan, f.options), error => {
      assert.equal(error.message, reason);
      assert.equal(error.cleanupConfirmed, true);
      return true;
    });
    assert.ok(!f.calls.some(([op]) => ['navigate', 'close-window'].includes(op)));
    assert.deepEqual(f.calls.slice(-2).map(([op]) => op), ['quit', 'bridge-closed']);
    assert.equal(existsSync(dirname(f.plan.profileRoot)), false);
  }
});

test('missing tab URLs and duplicate IDs report unobserved rather than certifying partial inventory', { skip: launchSkip }, async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, f.options);
  f.windows()[0].tabs.push({ id: 'new', title: 'page without URL' });
  let observed = await observeRealBrowser(browser);
  assert.equal(observed.observed, false); assert.deepEqual(observed.tabs, {});
  assert.ok(observed.unavailableGraders.includes('handoff'));
  f.windows()[0].tabs = [{ id: 'same', title: 'a', url: 'https://a.test' }, { id: 'same', title: 'b', url: 'https://b.test' }];
  observed = await observeRealBrowser(browser);
  assert.equal(observed.observed, false);
  await browser.stop();
});

test('a task that opened a second tab still observes: the marker tab keeps its known URL, any other unselected tab does not', { skip: launchSkip }, async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, f.options);
  const w = f.windows()[0];
  w.tabs = [{ id: 'marker', title: f.plan.marker, url: '' }, { id: 'page', title: 'Mount Kilimanjaro - Wikipedia', url: 'en.wikipedia.org/wiki/Mount_Kilimanjaro' }];
  const observed = await observeRealBrowser(browser);
  assert.equal(observed.observed, true);
  assert.equal(observed.tabs['safari:marker'].url, f.plan.markerUrl);
  assert.equal(observed.tabs['safari:page'].url, 'en.wikipedia.org/wiki/Mount_Kilimanjaro');
  w.tabs.push({ id: 'other', title: 'Somewhere else', url: '' });
  assert.equal((await observeRealBrowser(browser)).observed, false);
  await browser.stop();
});

const unproven = (id, subrole) => ({ id, profileEvidence: null, role: 'AXWindow', ...(subrole ? { subrole } : {}),
  frame: { x: 1060, y: 40, width: 400, height: 300 }, minimized: false, focused: false, childRoles: ['AXButton', 'AXGroup'] });

test('an unproven non-standard window during a task is recorded as auxiliary and the profile window still observes', { skip: launchSkip }, async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, f.options);
  const profileTabs = Object.keys(await observeRealBrowser(browser).then(row => row.tabs));
  f.windows().push(unproven('aux', 'AXFloatingWindow'));
  const observed = await observeRealBrowser(browser);
  assert.equal(observed.observed, true);
  assert.equal(observed.auxiliaryWindows.length, 1);
  assert.equal(observed.auxiliaryWindows[0].subrole, 'AXFloatingWindow');
  assert.deepEqual(observed.auxiliaryWindows[0].frame, { x: 1060, y: 40, width: 400, height: 300 });
  assert.ok(!('title' in observed.auxiliaryWindows[0]) && !('tabs' in observed.auxiliaryWindows[0]));
  assert.deepEqual(Object.keys(observed.tabs), profileTabs);
  await browser.stop();
});

test('an unproven standard window (or one with no subrole) is an extra window and its shape is reported', { skip: launchSkip }, async t => {
  for (const subrole of ['AXStandardWindow', undefined]) {
    const f = fixture(t), browser = await launchRealBrowser(f.plan, f.options);
    f.windows().push(unproven('second', subrole));
    const observed = await observeRealBrowser(browser);
    assert.equal(observed.observed, false);
    assert.equal(observed.reason, 'BENCH_SAFARI_EXTRA_WINDOWS');
    assert.equal(observed.extraWindows.length, 1);
    assert.equal(observed.extraWindows[0].subrole, subrole);
    assert.equal(observed.extraWindows[0].profileEvidence, false);
    assert.deepEqual(observed.extraWindows[0].childRoles, ['AXButton', 'AXGroup']);
    assert.equal(observed.extraWindows[0].minimized, false);
    assert.ok(!('title' in observed.extraWindows[0]));
    await browser.stop();
  }
});

test('a second window with profile evidence stays an extra window whatever its subrole', { skip: launchSkip }, async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, f.options);
  f.windows().push({ ...window('size-guide', 'Size guide'), subrole: 'AXFloatingWindow' });
  const observed = await observeRealBrowser(browser);
  assert.equal(observed.observed, false);
  assert.equal(observed.reason, 'BENCH_SAFARI_EXTRA_WINDOWS');
  assert.equal(observed.extraWindows.length, 1);
  assert.equal(observed.extraWindows[0].profileEvidence, true);
  assert.ok(!('title' in observed.extraWindows[0]) && !('tabs' in observed.extraWindows[0]));
  await browser.stop();
});

test('an unproven non-Start-Page window at launch still stops the round even with a non-standard subrole', { skip: launchSkip }, async t => {
  const f = fixture(t); f.windows([startPage('launch-start'), unproven('owner', 'AXFloatingWindow')]);
  await assert.rejects(launchRealBrowser(f.plan, f.options), /BENCH_SAFARI_RESTORED_WINDOWS/);
  assert.ok(!f.calls.some(([op]) => ['close-launch-window', 'close-window', 'new-profile', 'navigate'].includes(op)));
});

test('profile changes during a task and owner arrivals invalidate observation', { skip: launchSkip }, async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, f.options);
  f.windows()[0].toolbar = [];
  assert.equal((await observeRealBrowser(browser)).observed, false);
  await browser.stop();
  const g = fixture(t); let other = false;
  const b = await launchRealBrowser(g.plan, { ...g.options, listProcesses: async () => [...await g.options.listProcesses(),
    ...(other ? [{ pid: 999, ppid: 1, executable: 'Safari' }] : [])] });
  other = true;
  const result = await observeRealBrowser(b);
  assert.equal(result.ownerCheck.ok, false);
  assert.equal(result.observed, false);
  await b.stop();
});

test('owner arriving during bridge preparation prevents launch', async t => {
  const f = fixture(t); let ready = false;
  await assert.rejects(launchRealBrowser(f.plan, { ...f.options,
    safariBridge: async () => { ready = true; return f.bridge; },
    listProcesses: async () => ready ? [{ pid: 999, ppid: 1, executable: 'Safari' }] : [] }), /PID 999/);
  assert.ok(!f.calls.some(([op]) => ['launch', 'quit'].includes(op)));
});

test('failed Safari collection retains the harness and never deletes the dedicated profile', { skip: launchSkip }, async t => {
  const f = fixture(t), original = f.bridge.request;
  const browser = await launchRealBrowser(f.plan, f.options);
  f.bridge.request = async (op, input) => { if (op === 'quit') throw Error('quit refused'); return original(op, input); };
  await assert.rejects(browser.stop(), /CLEANUP_UNPROVED/);
  assert.equal(existsSync(dirname(f.plan.profileRoot)), true);
  assert.ok(!f.calls.some(([op]) => op === 'bridge-closed'));
});

test('a quit that needed the unsubmitted-form alert confirmed is recorded in the collection receipt', { skip: launchSkip }, async t => {
  const f = fixture(t), request = f.bridge.request, browser = await launchRealBrowser(f.plan, f.options);
  f.bridge.request = async (op, input) => op === 'quit' ? (await request(op, input), { browserClosed: true, unsubmittedFormQuitConfirmed: true }) : request(op, input);
  await browser.stop();
  assert.equal(browser.collections.at(-1).unsubmittedFormQuitConfirmed, true);
});

test('a failed fresh launch still quits the launched Safari, and a forced termination is recorded', { skip: launchSkip }, async t => {
  const f = fixture(t), request = f.bridge.request, browser = await launchRealBrowser(f.plan, f.options);
  await resetRealBrowser(browser);
  f.bridge.request = async (op, input) => {
    const result = await request(op, input);
    if (op === 'new-profile') f.windows([{ ...window('a'), toolbar: [] }]);
    return op === 'quit' ? { ...result, forceTerminated: true } : result;
  };
  await assert.rejects(resetRealBrowser(browser), /PROFILE_WINDOW_UNPROVED/);
  await browser.stop();
  assert.equal(browser.collections.at(-1).forceTerminated, true);
  assert.equal(f.calls.filter(([op]) => op === 'quit').length, 2);
});

test('a post-quit receipt failure still collects the helper before reporting the error', { skip: launchSkip }, async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, f.options), request = f.bridge.request;
  f.bridge.request = async (op, input) => {
    const result = await request(op, input);
    if (op === 'quit') Object.defineProperty(result, 'menuCleanup', { get() { throw Error('receipt unavailable'); } });
    return result;
  };
  await assert.rejects(browser.stop(), error => {
    assert.equal(error.message, 'BENCH_BROWSER_CLEANUP_UNPROVED');
    assert.equal(error.cause.message, 'receipt unavailable');
    return true;
  });
  assert.deepEqual(f.calls.slice(-2).map(([op]) => op), ['quit', 'bridge-closed']);
  assert.equal(existsSync(dirname(f.plan.profileRoot)), false);
  assert.equal((await browser.stop()).browserClosed, true);
  assert.equal(f.calls.filter(([op]) => op === 'quit').length, 1);
});

test('Safari stop is idempotent after proven collection', { skip: launchSkip }, async t => {
  const f = fixture(t), browser = await launchRealBrowser(f.plan, f.options);
  const first = await browser.stop();
  assert.deepEqual(await browser.stop(), first);
  assert.equal(f.calls.filter(([op]) => op === 'quit').length, 1);
  assert.equal(f.calls.filter(([op]) => op === 'bridge-closed').length, 1);
});

test('Safari gate uses structured observation and stable AX tab IDs for retention', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'br2s-gate-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const lockPath = join(dir, 'lock'); let browser;
  const rows = await runRealGate({ args: { surface: 'codex', 'real-browser': 'safari', out: join(dir, 'out') }, tasks: [task],
    runner: { gradeOutcome: input => { assert.equal(input.observed, true); assert.deepEqual([...input.startKeys], ['safari:tab-1']); return { problems: [] }; }, gradeSite: () => ({ problems: [] }) },
    runtime: { lockPath, admit: async () => {}, startSites: async () => ({ close: async () => {} }),
      launchBrowser: async plan => browser = { ...plan, pid: 40, stop: async () => ({ browserClosed: true }) },
      checkOwner: async () => ({ ok: true }), resetBrowser: async () => ({ 'safari:tab-1': { url: browser.markerUrl, title: browser.marker } }),
      runAgent: async arm => { mkdirSync(arm.dir); return { groupClean: true, exitCode: 0, result: { result: 'RESULT: fixture' } }; },
      observeBrowser: async () => ({ observed: true, tabs: { 'safari:tab-1': { url: 'https://changed.test', title: 'Changed' } } }) } });
  assert.equal(rows[0].outcome.ok, true);
  assert.equal(existsSync(lockPath), false);
});

test('each Safari task\'s prompt names the PID of the Safari launched for that task', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'br2s-pid-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let browser; const prompts = [];
  await runRealGate({ args: { surface: 'codex', 'real-browser': 'safari', out: join(dir, 'out') }, tasks: [task, { ...task, name: 'second' }],
    runner: { gradeOutcome: () => ({ problems: [] }), gradeSite: () => ({ problems: [] }) },
    runtime: { lockPath: join(dir, 'lock'), admit: async () => {}, startSites: async () => ({ close: async () => {} }),
      launchBrowser: async plan => browser = { ...plan, pid: 40, stop: async () => ({ browserClosed: true }) },
      checkOwner: async () => ({ ok: true }),
      resetBrowser: async () => { browser.pid += 1; return { 'safari:tab-1': { url: browser.markerUrl, title: browser.marker } }; },
      runAgent: async arm => { mkdirSync(arm.dir); prompts.push(JSON.stringify(arm)); return { groupClean: true, exitCode: 0, result: { result: 'RESULT: fixture' } }; },
      observeBrowser: async () => ({ observed: true, tabs: { 'safari:tab-1': { url: 'https://changed.test', title: 'Changed' } } }) } });
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /browser PID 41\b/); assert.doesNotMatch(prompts[0], /browser PID 40\b/);
  assert.match(prompts[1], /browser PID 42\b/); assert.doesNotMatch(prompts[1], /browser PID 41\b/);
});

test('a previous Safari still shutting down delays the next launch until its services are gone', { skip: launchSkip }, async t => {
  const f = fixture(t); let lingering = 0;
  const options = { ...f.options, settleMs: 2000, listProcesses: async () => [...await f.options.listProcesses(), ...(lingering-- > 0 ? [{ pid: 7777, ppid: 1, executable: 'Safari Web Content' }] : [])] };
  const browser = await launchRealBrowser(f.plan, options);
  await resetRealBrowser(browser);
  lingering = 3;
  await resetRealBrowser(browser);
  assert.equal(f.calls.filter(([op]) => op === 'launch').length, 2);
  await browser.stop();
});

test('ambiguous shared WebContent is refused rather than silently attributed to the round', async () => {
  const plan = realBrowserPlan({ browser: 'safari', round: 'shared-webcontent' });
  // No responsible pid known (lookup empty, failed, or naming a vanished process): the name rule refuses.
  for (const responsibleFor of [async () => new Map(), async () => { throw Error('osascript failed'); }, async () => new Map([[88, 5555]])]) {
    for (const executable of ['com.apple.WebKit.WebContent', '/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent']) {
      await assert.rejects(checkBrowserOwner(plan, { responsibleFor, listProcesses: async () => [{ pid: 88, ppid: 1, executable }] }), /PID 88/);
    }
  }
});

const webkit = name => `/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/${name}.xpc/Contents/MacOS/${name}`;

test('WebKit services count for Safari only when a Safari process is responsible for them', async () => {
  const plan = realBrowserPlan({ browser: 'safari', round: 'responsible-webkit' });
  const asked = [];
  const daemon = { pid: 51443, ppid: 1, executable: '/usr/libexec/textunderstandingd' };
  const shared = ['com.apple.WebKit.WebContent.EnhancedSecurity', 'com.apple.WebKit.Networking', 'com.apple.WebKit.GPU']
    .map((name, i) => ({ pid: 69405 + i, ppid: 1, executable: webkit(name) }));
  const responsibleFor = async pids => { asked.push(pids); return new Map(pids.map(pid => [pid, pid === 300 ? 200 : 51443])); };
  const check = await checkBrowserOwner(plan, { responsibleFor, listProcesses: async () => [daemon, ...shared] });
  assert.equal(check.ok, true);
  assert.deepEqual(check.sharedWebKit.map(row => row.responsible), [51443, 51443, 51443]);
  assert.deepEqual(asked, [shared.map(row => row.pid)]);
  // A WebContent whose responsible process is Safari (bundle path or the cryptex copy) still refuses.
  for (const executable of [plan.executable, '/System/Volumes/Preboot/Cryptexes/App/System/Applications/Safari.app/Contents/MacOS/Safari']) {
    await assert.rejects(checkBrowserOwner(plan, { responsibleFor, listProcesses: async () => [
      daemon, ...shared, { pid: 200, ppid: 1, executable }, { pid: 300, ppid: 1, executable: webkit('com.apple.WebKit.WebContent') }] }),
    error => { assert.deepEqual(error.ownerCheck.otherPids, [200, 300]); return true; });
  }
  // The owned Safari owns the services it is responsible for, though launchd parents them.
  const owned = await checkBrowserOwner(plan, { ownedPid: 200, responsibleFor, listProcesses: async () => [
    daemon, ...shared, { pid: 200, ppid: 1, executable: plan.executable }, { pid: 300, ppid: 1, executable: webkit('com.apple.WebKit.WebContent') }] });
  assert.equal(owned.ok, true);
  // Other browsers never ask.
  asked.length = 0;
  await checkBrowserOwner(realBrowserPlan({ browser: 'firefox', round: 'no-webkit-lookup' }), { responsibleFor, listProcesses: async () => shared });
  assert.deepEqual(asked, []);
});

test('the live responsibility lookup answers for this process and leaves pid 1 unknown', { skip: macCommandSkip('osascript') }, async () => {
  const { responsiblePids } = await import('../bench/fowl/real-browser.mjs');
  const result = await responsiblePids([process.pid, 1]);
  assert.ok(Number.isSafeInteger(result.get(process.pid)) && result.get(process.pid) > 0);
  assert.equal(result.has(1), false);
});

test('native Safari helper compiles and rejects unowned requests before any app lookup or input', { skip: macCommandSkip('xcrun') }, t => {
  const root = mkdtempSync(join(tmpdir(), 'br2s-native-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const executable = join(root, 'helper');
  const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(),
    fileURLToPath(new URL('../bench/fowl/safari-helper.swift', import.meta.url)), '-o', executable], { encoding: 'utf8', timeout: 60000 });
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(executable, [], { encoding: 'utf8', timeout: 1000,
    input: '{"op":"snapshot"}\n{"op":"navigate","window":"fake","url":"https://wrong.test"}\n{"op":"close-window","window":"fake"}\n' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.stdout.trim().split('\n').map(line => JSON.parse(line).error),
    ['BENCH_SAFARI_IDENTITY_UNPROVED:nil', 'BENCH_SAFARI_MARKER_INVALID', 'BENCH_SAFARI_IDENTITY_UNPROVED:nil']);
  const fixtureUrl = 'http://127.0.0.1:5431/held-out/list/recorded-failure/';
  const unsafe = ['https://127.0.0.1:5431/held-out/list/run/', 'http://localhost:5431/held-out/list/run/',
    'http://127.0.0.1/held-out/list/run/', 'http://127.0.0.1:0/held-out/list/run/',
    'http://127.0.0.1:65536/held-out/list/run/', 'http://user@127.0.0.1:5431/held-out/list/run/',
    'http://127.0.0.1:5431/other/', fixtureUrl + '?q=x', fixtureUrl + '#tail',
    'http://127.0.0.1:5431/held-out/list/%2e%2e/', 'http://127.0.0.1:5431/held-out/list/../run/'];
  const requests = [
    ...unsafe.map(url => ({ op: 'fixture-plan', url })),
    { op: 'navigate-fixture', window: 'fake', url: fixtureUrl },
    { op: 'fixture-plan', url: fixtureUrl },
    { op: 'fixture-plan', url: fixtureUrl.replace(':5431', ':5432') },
    ...[...unsafe, fixtureUrl.replace(':5431', ':5432'), fixtureUrl.replace('recorded-failure', 'other-run')]
      .map(url => ({ op: 'navigate-fixture', window: 'fake', url })),
    { op: 'navigate-fixture', window: 'fake', url: fixtureUrl },
  ];
  const fixtureRun = spawnSync(executable, [], { encoding: 'utf8', timeout: 1000,
    input: requests.map(input => JSON.stringify(input)).join('\n') + '\n' });
  assert.equal(fixtureRun.status, 0, fixtureRun.stderr);
  assert.deepEqual(fixtureRun.stdout.trim().split('\n').map(line => JSON.parse(line)), [
    ...unsafe.map(() => ({ error: 'BENCH_SAFARI_FIXTURE_INVALID' })),
    { error: 'BENCH_SAFARI_FIXTURE_INVALID' }, {}, { error: 'BENCH_SAFARI_FIXTURE_PLAN_LOCKED' },
    ...Array.from({ length: unsafe.length + 2 }, () => ({ error: 'BENCH_SAFARI_FIXTURE_INVALID' })),
    { error: 'BENCH_SAFARI_IDENTITY_UNPROVED:nil' },
  ]);
  const uncertain = spawnSync(executable, ['--self-test-unreceipted-launch'], { encoding: 'utf8', timeout: 1000 });
  assert.equal(uncertain.status, 0, uncertain.stderr);
  assert.deepEqual(JSON.parse(uncertain.stdout), { error: 'BENCH_SAFARI_LAUNCH_UNRECEIPTED' });
  const identity = spawnSync(executable, ['--self-test-identity-retry'], { encoding: 'utf8', timeout: 1000 });
  assert.equal(identity.status, 0, identity.stderr);
  assert.deepEqual(JSON.parse(identity.stdout), {
    immediate: { attempts: 1, waits: 0, verified: true },
    transient: { attempts: 4, waits: 3, verified: true },
    lastRetry: { attempts: 21, waits: 20, verified: true },
    nil: { attempts: 21, waits: 20, error: 'BENCH_SAFARI_IDENTITY_UNPROVED:nil' },
    date: { attempts: 21, waits: 20, error: 'BENCH_SAFARI_IDENTITY_UNPROVED:date' },
    exe: { attempts: 21, waits: 20, error: 'BENCH_SAFARI_IDENTITY_UNPROVED:exe' },
  });
  const safety = spawnSync(executable, ['--self-test-owner-safety'], { encoding: 'utf8', timeout: 1000 });
  assert.equal(safety.status, 0, safety.stderr);
  assert.deepEqual(JSON.parse(safety.stdout), {
    ownerSnapshot: { id: 'owner', profileEvidence: null }, ownerContentReads: 0, verifiedContentReads: 1,
    ownerShape: { id: 'owner', profileEvidence: null, subrole: 'AXFloatingWindow' }, verifiedShapeReads: 0,
    probe: { AXTitle: '[redacted]', AXDescription: profile, AXURL: '[redacted]', AXValue: '[redacted]' },
    wrongKey: 'BENCH_SAFARI_KEY_WINDOW_UNPROVED', missingKey: 'BENCH_SAFARI_KEY_WINDOW_UNPROVED',
    missingProfile: 'BENCH_SAFARI_KEY_WINDOW_UNPROVED', verifiedKey: true,
    menuEscapes: 1, menuEscapePosted: true, stuckEscapes: 1, stuckMenu: 'BENCH_SAFARI_MENU_STUCK',
    unsafeEscapes: 0, unsafeMenu: 'BENCH_SAFARI_KEY_WINDOW_UNPROVED',
    identifierProfile: true, identifierOther: false, identifierPrefix: true, identifierDuplicates: true, conflictingProfile: true,
    searchFieldReadable: true, menuChildrenUnreadable: false, menuWithoutVisible: true, menuVisibleUnknown: false,
    preferredElement: 'profile', ambiguousProfile: true, visibleMenuClear: false, selectedMenuClear: false,
    clearMenuEscapes: 0,
    unknownSelectedMenuClear: false, unknownRoleMenuClear: false, bridgedSelectedMenuClear: false,
    fixtureStartPage: true, fixtureNonStartPage: 'BENCH_SAFARI_START_PAGE_UNPROVED',
    fixtureSheet: 'BENCH_SAFARI_START_PAGE_UNPROVED',
  });
  const quitSafety = spawnSync(executable, ['--self-test-quit-safety'], { encoding: 'utf8', timeout: 1000 });
  assert.equal(quitSafety.status, 0, quitSafety.stderr);
  assert.deepEqual(JSON.parse(quitSafety.stdout), { passed: true });
  const setup = spawnSync(executable, ['--self-test-window-setup'], { encoding: 'utf8', timeout: 1000 });
  assert.equal(setup.status, 0, setup.stderr);
  assert.deepEqual(JSON.parse(setup.stdout), { passed: true });
  const frame = spawnSync(executable, [], { encoding: 'utf8', timeout: 1000,
    input: '{"op":"frame"}\n{"op":"frame","window":"unowned"}\n' });
  assert.equal(frame.status, 0, frame.stderr);
  assert.deepEqual(frame.stdout.trim().split('\n').map(line => JSON.parse(line).error),
    ['BENCH_SAFARI_WINDOW_UNPROVED', 'BENCH_SAFARI_IDENTITY_UNPROVED:nil']);
});

test('an Escape post without verified menu dismissal cannot navigate or close windows', { skip: launchSkip }, async t => {
  for (const receipt of [{ menuEscapePosted: true }, { menuEscapePosted: true, menuCleared: false, menuEscapes: 2 },
    { menuEscapePosted: true, menuCleared: true, menuEscapes: 2 }, { menuEscapePosted: true, menuCleared: true, menuEscapes: 3 }]) {
    const f = fixture(t), request = f.bridge.request;
    f.bridge.request = async (op, input) => { const result = await request(op, input); return op === 'new-profile' ? receipt : result; };
    await assert.rejects(launchRealBrowser(f.plan, f.options), /MENU_ESCAPE_UNPROVED/);
    assert.ok(!f.calls.some(([op]) => ['navigate', 'close-window'].includes(op)));
  }
});

test('a profile menu already confirmed clear needs no Escape before navigation', { skip: launchSkip }, async t => {
  const f = fixture(t), request = f.bridge.request;
  f.bridge.request = async (op, input) => {
    const result = await request(op, input);
    return op === 'new-profile' ? { menuEscapePosted: false, menuCleared: true, menuEscapes: 0 } : result;
  };
  const browser = await launchRealBrowser(f.plan, f.options);
  assert.ok(f.calls.some(([op]) => op === 'navigate'));
  await browser.stop();
});

test('Safari CLI dry plans enumerate pinned tasks for all five arms without creating a browser or output', t => {
  const tasks = join(homedir(), 'Library/Caches/sleight-bench/fowlbrowser/tools/agents/codex-h2h.json');
  if (!existsSync(tasks)) return t.skip('pinned FowlBrowser cache is absent');
  const home = mkdtempSync(join(tmpdir(), 'br2s-cli-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const lcu = join(home, 'Library/Caches/sleight-bench/lcu-arm'); mkdirSync(lcu, { recursive: true });
  writeFileSync(join(lcu, '.mcp.json'), JSON.stringify({ mcpServers: { lcu: { command: '/fixture/lcu' } } }));
  for (const surface of ['sleight', 'lcu', 'cua', 'peekaboo', 'codex']) {
    const out = join(home, 'never', surface);
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('../bench/fowl/real-gate.mjs', import.meta.url)),
      '--real-browser', 'safari', '--dry-run', '--surface', surface, '--tasks', tasks, '--out', out],
    { encoding: 'utf8', env: { HOME: home, PATH: process.env.PATH }, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(run.status, 0, run.stderr);
    const plan = JSON.parse(run.stdout);
    assert.equal(plan.arms.length, 12);
    assert.deepEqual(plan.unsupported.map(row => row.task.name), ['mobile', 'takeover']);
    assert.equal(plan.browser.profileName, profile);
    assert.equal(plan.browser.connectionMode, 'engine-computer');
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(dirname(plan.browser.profileRoot)), false);
    assert.equal(existsSync(join(home, '.config')), false);
  }
});

test('a profile menu without its pid-directed Escape receipt cannot navigate or close windows', { skip: launchSkip }, async t => {
  const f = fixture(t), request = f.bridge.request;
  f.bridge.request = async (op, input) => { const result = await request(op, input); return op === 'new-profile' ? {} : result; };
  await assert.rejects(launchRealBrowser(f.plan, f.options), /MENU_ESCAPE_UNPROVED/);
  assert.ok(!f.calls.some(([op]) => ['navigate', 'close-window'].includes(op)));
  assert.ok(f.calls.some(([op]) => op === 'quit'));
});

test('a broken helper transport collects its own helper through EOF and rejects future requests', async t => {
  const { prepareSafariBridge } = await import('../bench/fowl/safari-browser.mjs');
  const root = mkdtempSync(join(tmpdir(), 'br2s-bridge-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = new EventEmitter(); let ended = false;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); },
    final(callback) { ended = true; callback(); setImmediate(() => child.emit('close', 0)); } });
  // close() resolves on the fake's close event; the budget only bounds a missing one. 10 ms lost the race on Linux,
  // where node --test's own reporter work ran 10 to 13 ms ahead of the fake's setImmediate (2026-10-19).
  const bridge = await prepareSafariBridge(root, { compile: async () => {}, spawnBrowser: () => child, timeoutMs: 1000 });
  const pending = bridge.request('snapshot');
  child.stdout.write('not JSON\n');
  await assert.rejects(pending, /JSON/);
  assert.equal(ended, true);
  await assert.rejects(bridge.request('quit'), /JSON/);
  await bridge.close();
});


test('Safari profile proof refuses conflicting labels and malformed duplicate identifiers', async () => {
  const { safariProfileEvidence, identifierProfile } = await import('../bench/fowl/safari-browser.mjs');
  for (const identifier of ['TabGroupPickerButton?Profile=sleight%20benchmark&Profile=%ZZ', 'TabGroupPickerButton?Profile=', 'TabGroupPickerButton?Profile=sleight%20benchmark&Profile']) {
    assert.notEqual(identifierProfile(identifier), profile);
    assert.equal(safariProfileEvidence({ toolbar: [{ id: 'profile', role: 'AXButton', identifier, title: profile }] }), null);
  }
  for (const [identifier, title] of [['TabGroupPickerButton?Profile=Personal', profile], ['TabGroupPickerButton?Profile=sleight%20benchmark', 'Personal']]) {
    assert.equal(safariProfileEvidence({ toolbar: [{ id: 'profile', role: 'AXButton', identifier, title }] }), null);
  }
});


test('Safari menu Escape checks the environment, owner idle time and key profile before input', () => {
  const source = readFileSync(new URL('../bench/fowl/safari-helper.swift', import.meta.url), 'utf8');
  const release = source.slice(source.indexOf('func releaseProfileMenus('), source.indexOf('func newProfile('));
  for (const guard of ['keyProfileWindow()', 'SLEIGHT_STUCK_ESCAPE', 'requireProfileEscape(', '.combinedSessionState', 'UInt32.max']) {
    assert.ok(release.indexOf(guard) >= 0 && release.indexOf(guard) < release.indexOf('try key(53,'), guard);
  }
  const key = source.slice(source.indexOf('func key('), source.indexOf('func keyProfileWindow('));
  assert.ok(key.indexOf('try verifyKeyWindow(') < key.indexOf('down.postToPid('));
});
