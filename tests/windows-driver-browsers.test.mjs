import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { matchBlockedWindowsApp, forbiddenWindowsTarget, windowsForbiddenWarning } from '../plugins/sleight/lib/blocked-apps-windows.mjs';
import { WINDOWS_DRIVER_ERRORS } from '../plugins/sleight/lib/windows-driver/errors.mjs';
import { createWindowsSafety } from '../plugins/sleight/lib/driver-safety.mjs';

const names = ['chrome', 'chromium', 'msedge', 'brave', 'firefox', 'opera', 'vivaldi', 'iexplore', 'helium', 'arc',
  'microsoft edge', 'google chrome', 'mozilla firefox'];
const code = 'BROWSER_TARGET_REFUSED';
const policy = { matchBlockedWindowsApp, forbiddenWindowsTarget, windowsForbiddenWarning };
const nativeWindow = (extra = {}) => ({ windowId: '101', processStart: '134059077770000001', pid: 44, threadId: 45,
  image: 'C:\\Apps\\notes.exe', originalFilename: '', productName: '', aumid: '', className: 'OrdinaryWindow',
  app: 'Notes', title: 'Private fixture title', integrity: 'medium', imageIdentity: '1:2', ...extra });
const browserWindow = (extra = {}) => nativeWindow({ app: 'msedge', image: 'C:\\Apps\\msedge.exe',
  className: 'Chrome_WidgetWin_1', ...extra });

function assertBrowser(api, window) {
  assert.deepEqual(api.matchBlockedWindowsApp(window), { browser: true });
  for (const allowForbidden of [false, true]) {
    const refusal = api.forbiddenWindowsTarget(window, { allowForbidden });
    assert.deepEqual(refusal, { code, ...WINDOWS_DRIVER_ERRORS[code] });
  }
  assert.equal(api.windowsForbiddenWarning(window), undefined, 'unsupported browsers never get approval warnings');
}

function assertAllowed(api, window, warning) {
  assert.equal(api.matchBlockedWindowsApp(window), undefined);
  for (const allowForbidden of [false, true]) assert.equal(api.forbiddenWindowsTarget(window, { allowForbidden }), undefined);
  assert.equal(api.windowsForbiddenWarning(window), warning);
}

const browserCases = [
  ...['image', 'originalFilename', 'productName'].flatMap(field => names.map(name => [
    `browser ${name} refuses by ${field}, including the override`, nativeWindow({
      [field]: field === 'productName' ? name.toUpperCase() : `C:\\UserApps\\${name.toUpperCase()}.EXE`,
    }),
  ])),
  ['renamed Edge with original filename', nativeWindow({ originalFilename: 'msedge.exe' })],
  ['renamed Edge with product name', nativeWindow({ productName: 'Microsoft Edge' })],
  ['packaged Edge AUMID', nativeWindow({ image: 'C:\\Windows\\ApplicationFrameHost.exe',
    aumid: 'Microsoft.MicrosoftEdge_8wekyb3d8bbwe!MicrosoftEdge', className: 'ApplicationFrameWindow' })],
  ['Edge AUMID prefix', nativeWindow({ aumid: 'MICROSOFT.MICROSOFTEDGE.Stable!App' })],
  ['Firefox class without filename', nativeWindow({ className: 'MozillaWindowClass' })],
  ['Firefox class case', nativeWindow({ className: 'mozillawindowclass' })],
  ['browser settings title', browserWindow({ title: 'Settings' })],
  ['browser with terminal metadata', browserWindow({ originalFilename: 'cmd.exe' })],
  ['browser with approval-host metadata', browserWindow({ productName: 'Visual Studio Code' })],
];
for (const [name, window] of browserCases) test(name, () => assertBrowser(policy, window));

const allowedCases = [
  ['VS Code shares the Chromium class', nativeWindow({ image: 'C:\\Apps\\Code.exe', className: 'Chrome_WidgetWin_1' }),
    'This app can show approval cards, and Claude could approve its own later actions in it.'],
  ['stripped renamed copy has no B1 proof (D2 backstop deferred)', nativeWindow({ className: 'Chrome_WidgetWin_1' })],
  ['Electron http document has no B1 proof (D2 backstop deferred)', nativeWindow({ className: 'Chrome_WidgetWin_1',
    app: 'Kiosk', title: 'https://fixture.invalid/' })],
  ['WebView2 child is outside B1', nativeWindow({ image: 'C:\\Apps\\msedgewebview2.exe' })],
  ['browser words in the title are not identity', nativeWindow({ title: 'msedge' })],
  ['browser words in the app label are not identity', nativeWindow({ app: 'msedge' })],
  ['name suffix is not an exact match', nativeWindow({ originalFilename: 'mychrome.exe', productName: 'Chrome Helper' })],
  ['foreign AUMID prefix is not Edge', nativeWindow({ aumid: 'Other.Microsoft.MicrosoftEdge!App' })],
  ['Firefox class prefix is not exact', nativeWindow({ className: 'MozillaWindowClassHelper' })],
  ['missing metadata', {}],
  ['non-string metadata', { image: null, originalFilename: 3, productName: [], aumid: {}, className: false }],
];
for (const [name, window, warning] of allowedCases) test(name, () => assertAllowed(policy, window, warning));

function fixture(t, windows, options = {}, create = createWindowsSafety) {
  const calls = [], cards = [], leases = [];
  let readId = 0;
  const safety = create({ driver: { async request(method, params) {
    calls.push(method);
    if (method === 'getState') return { windows };
    const window = windows.find(w => w.windowId === params.windowId);
    if (method === 'verifyWindowIdentity') return { window };
    return { window, text: '1 window\n\t2 document Value: https://fixture.invalid/', readId: ++readId };
  } }, approve: async card => { cards.push(card); return true; },
  lease: { ready() {}, acquire(target) { leases.push(target); return 'fixture lease'; }, renew() {}, release() {}, close() {} },
  stuckEscape: false, ...options });
  t.after(() => safety.close());
  return { safety, calls, cards, leases };
}

function assertNoContent(f) {
  assert.equal(f.cards.length, 0);
  assert.equal(f.leases.length, 0);
  assert.deepEqual(f.calls, ['getState'], 'no verification, UIA tree, capture or input call');
}

async function assertRefused(t, create, window, selector, options) {
  const f = fixture(t, [window], options, create);
  await assert.rejects(f.safety.request('getApp', { selector }), { code });
  assertNoContent(f);
}

for (const allowForbidden of [false, true]) {
  for (const [label, window] of [['Edge', browserWindow()], ['renamed Edge', nativeWindow({ productName: 'Microsoft Edge' })],
    ['Firefox', nativeWindow({ className: 'MozillaWindowClass' })]]) {
    test(`parent refuses ${label} by HWND before approval, override=${allowForbidden}`, t =>
      assertRefused(t, createWindowsSafety, window, { windowId: '101' }, { allowForbidden }));
  }
}

for (const allowForbidden of [false, true]) test(`parent preserves the browser code by name, override=${allowForbidden}`, t =>
    assertRefused(t, createWindowsSafety, browserWindow(), 'msedge', { allowForbidden }));

async function assertNameRefused(t, create) {
  for (const allowForbidden of [false, true]) {
    const f = fixture(t, [browserWindow()], { allowForbidden }, create);
    await assert.rejects(f.safety.request('getApp', { selector: 'msedge' }));
    assertNoContent(f);
  }
}
test('parent refuses a browser name without approval, a lease or content', t => assertNameRefused(t, createWindowsSafety));

async function assertInventory(t, create, method) {
  const f = fixture(t, [browserWindow()], {}, create);
  const inventory = await f.safety.request(method, {});
  assert.ok(inventory.windows[0].refused);
  for (const field of ['title', 'image', 'originalFilename', 'productName', 'className', 'app', 'aumid'])
    assert.equal(inventory.windows[0][field], null, field);
  assertNoContent(f);
  return inventory;
}

for (const method of ['getState', 'listApps']) test(`${method} preserves the browser refusal code and redacts metadata`, async t => {
    const inventory = await assertInventory(t, createWindowsSafety, method);
    assert.equal(inventory.windows[0].refused, code);
  });

for (const method of ['getState', 'listApps']) test(`parent redacts ${method} browser inventory`, t =>
  assertInventory(t, createWindowsSafety, method));

test('T34 app identity behind a frame keeps its category and the frame host is unresolved', async t => {
  const edge = nativeWindow({ image: 'C:\\Program Files\\WindowsApps\\Microsoft.MicrosoftEdge\\msedge.exe',
    aumid: 'Microsoft.MicrosoftEdge_8wekyb3d8bbwe!MicrosoftEdge', className: 'ApplicationFrameWindow',
    app: 'msedge', coreWindowId: '301', framePid: 7 });
  assert.deepEqual(policy.matchBlockedWindowsApp(edge), { browser: true });
  assert.equal(policy.forbiddenWindowsTarget(edge).code, 'BROWSER_TARGET_REFUSED');
  const terminal = nativeWindow({ image: 'C:\\Windows\\System32\\cmd.exe', className: 'ApplicationFrameWindow',
    coreWindowId: '301', framePid: 7 });
  assert.equal(policy.forbiddenWindowsTarget(terminal).code, 'FORBIDDEN_TARGET');
  const openai = nativeWindow({ image: 'C:\\Apps\\ChatGPT.exe', aumid: 'OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0!ChatGPT',
    className: 'ApplicationFrameWindow', coreWindowId: '301', framePid: 7 });
  assert.equal(policy.forbiddenWindowsTarget(openai).code, 'FORBIDDEN_TARGET');
  const frame = nativeWindow({ image: 'C:\\Windows\\ApplicationFrameHost.exe',
    aumid: 'Microsoft.MicrosoftEdge_8wekyb3d8bbwe!MicrosoftEdge', className: 'ApplicationFrameWindow' });
  const hosted = fixture(t, [frame]);
  await assert.rejects(hosted.safety.request('getApp', { selector: { windowId: '101' } }), { code: 'HOSTED_APP_UNRESOLVED' });
  assertNoContent(hosted);
  for (const [label, mutate, expected] of [
    ['elevated', w => { w.integrity = 'high'; w.refused = 'ELEVATED_TARGET'; w.coreWindowId = '301'; w.framePid = 7; }, 'ELEVATED_TARGET'],
    ['own host', w => { w.refused = 'OWN_HOST'; w.coreWindowId = '301'; w.framePid = 7; }, 'OWN_HOST'],
  ]) {
    const window = nativeWindow(); mutate(window);
    const host = fixture(t, [window]);
    await assert.rejects(host.safety.request('getApp', { selector: { windowId: '101' } }), { code: expected }, label);
    assert.equal(host.cards.length, 0, label);
    assert.deepEqual(host.calls, ['getState'], label);
  }
});

async function assertBrowserNames(t, create) {
  const edge = browserWindow({ productName: 'Microsoft Edge', aumid: 'Microsoft.MicrosoftEdge.Stable!App' });
  for (const selector of ['msedge.exe', 'Microsoft Edge', edge.aumid, 'MSEDGE.EXE'])
    await assertRefused(t, create, edge, selector);
}
test('browser executable, product name and AUMID keep BROWSER_TARGET_REFUSED', t => assertBrowserNames(t, createWindowsSafety));

test('refused terminal names, browser title guesses and mixed identities stay private', async t => {
  for (const [windows, selector] of [
    [[nativeWindow({ image: 'C:\\Apps\\cmd.exe', app: 'cmd' })], 'cmd.exe'],
    [[browserWindow()], 'Private fixture title'],
    [[browserWindow(), nativeWindow({ windowId: '102', image: 'C:\\Apps\\cmd.exe', title: 'msedge.exe' })], 'msedge.exe'],
    [[browserWindow({ popup: true })], 'msedge.exe'],
    [[browserWindow({ refused: 'TARGET_UNAVAILABLE' })], 'msedge.exe'],
  ]) {
    const f = fixture(t, windows);
    await assert.rejects(f.safety.request('getApp', { selector }), { code: 'WINDOW_NOT_FOUND' });
    assertNoContent(f);
  }
});

test('browser name regression assertions fail when category fallback is removed', async t => {
  const source = changed(readFileSync(safetyUrl, 'utf8'), "if (matching.length && matching.every", "if (false && matching.every");
  const broken = await import(moduleUrl(source, safetyUrl));
  await assert.rejects(() => assertBrowserNames(t, broken.createWindowsSafety), assert.AssertionError);
});

async function assertUnresolved(t, create) {
  const window = nativeWindow({ image: 'C:\\Windows\\ApplicationFrameHost.exe', className: 'ApplicationFrameWindow' });
  const f = fixture(t, [window], {}, create);
  await assert.rejects(f.safety.request('getApp', { selector: { windowId: '101' } }), { code: 'HOSTED_APP_UNRESOLVED' });
  assertNoContent(f);
}
test('packaged frame without AUMID keeps HOSTED_APP_UNRESOLVED before browser policy', t => assertUnresolved(t, createWindowsSafety));

async function assertNativeAcquisition(t, create, image) {
  const window = nativeWindow({ image: `C:\\Apps\\${image}.exe`, className: image === 'Code' ? 'Chrome_WidgetWin_1' : 'Window' });
  const f = fixture(t, [window], {}, create);
  const result = await f.safety.request('getApp', { selector: { windowId: '101' } });
  assert.equal(result.window, window);
  assert.equal(f.cards.length, 1);
  assert.equal(f.leases.length, 1);
  assert.deepEqual(f.calls, ['getState', 'verifyWindowIdentity', 'getAXState']);
}
test('ordinary native apps and VS Code still acquire', async t => {
  for (const image of ['notepad', 'Calculator', 'WpfFixture', 'Code']) await assertNativeAcquisition(t, createWindowsSafety, image);
});

// Mutants are in-memory source variants. No repository sources, apps or native hosts are changed or launched.
const policyUrl = new URL('../plugins/sleight/lib/blocked-apps-windows.mjs', import.meta.url);
const safetyUrl = new URL('../plugins/sleight/lib/driver-safety.mjs', import.meta.url);
function moduleUrl(source, base, replacements = {}) {
  const absolute = source.replace(/from (['"])(\.[^'"]+)\1/g,
    (_match, quote, path) => `from ${quote}${replacements[path] ?? new URL(path, base).href}${quote}`);
  return `data:text/javascript;base64,${Buffer.from(absolute).toString('base64')}`;
}
function changed(source, before, after) {
  const result = source.replace(before, after);
  assert.notEqual(result, source, 'the broken source variant must change the production code');
  return result;
}

test('each browser identity assertion rejects a broken classifier', async () => {
  const source = readFileSync(policyUrl, 'utf8');
  const broken = await import(moduleUrl(changed(source, 'return { browser: true }', 'return undefined'), policyUrl));
  assert.notEqual(broken.matchBlockedWindowsApp, matchBlockedWindowsApp);
  for (const [name, window] of browserCases) assert.throws(() => assertBrowser(broken, window), assert.AssertionError, name);
});

test('each allowed identity assertion rejects an overbroad classifier', async () => {
  const source = readFileSync(policyUrl, 'utf8');
  const broken = await import(moduleUrl(changed(source, 'const names = identities(window);',
    'return { browser: true }; const names = identities(window);'), policyUrl));
  for (const [name, window, warning] of allowedCases)
    assert.throws(() => assertAllowed(broken, window, warning), assert.AssertionError, name);
});

for (const [name, before, after, window, allowed] of [
  ['image omitted', 'window?.image,', 'undefined,', browserWindow()],
  ['original filename omitted', 'window?.originalFilename,', 'undefined,', nativeWindow({ originalFilename: 'msedge.exe' })],
  ['product name omitted', 'window?.productName]', 'undefined]', nativeWindow({ productName: 'Microsoft Edge' })],
  ['AUMID omitted', "aumid.startsWith('microsoft.microsoftedge')", 'false', nativeWindow({ aumid: 'Microsoft.MicrosoftEdge!App' })],
  ['Firefox class omitted', "=== 'mozillawindowclass'", "=== 'unusedclass'", nativeWindow({ className: 'MozillaWindowClass' })],
  ['name case normalization broken', ".replace(/\\.exe$/i, '').toLowerCase()", ".replace(/\\.exe$/i, '').toUpperCase()", browserWindow()],
  ['forbidden override lifts browser refusal', 'if (blocked.browser)', 'if (blocked.browser && !allowForbidden)', browserWindow()],
  ['browser warning suppression omitted', 'if (blocked?.browser) return;', '', browserWindow({ productName: 'Visual Studio Code' })],
  ['Chromium class mistaken for browser', 'if (names.some(image => browsers.has(image))',
    "if (window?.className === 'Chrome_WidgetWin_1' || names.some(image => browsers.has(image))",
    nativeWindow({ className: 'Chrome_WidgetWin_1' }), true],
  ['AUMID substring mistaken for prefix', "aumid.startsWith('microsoft.microsoftedge')", "aumid.includes('microsoft.microsoftedge')",
    nativeWindow({ aumid: 'Other.Microsoft.MicrosoftEdge!App' }), true],
  ['title mistaken for identity', 'window?.productName]', 'window?.productName, window?.title]', nativeWindow({ title: 'msedge' }), true],
  ['app label mistaken for identity', 'window?.productName]', 'window?.productName, window?.app]', nativeWindow({ app: 'msedge' }), true],
]) test(`safety assertion detects broken variant: ${name}`, async () => {
  const source = changed(readFileSync(policyUrl, 'utf8'), before, after);
  const broken = await import(moduleUrl(source, policyUrl));
  assert.throws(() => allowed ? assertAllowed(broken, window) : assertBrowser(broken, window), assert.AssertionError);
});

test('parent HWND safety assertions reject a variant that bypasses browser policy', async t => {
  const source = readFileSync(policyUrl, 'utf8');
  const bypass = moduleUrl(changed(source, 'return { browser: true }', 'return undefined'), policyUrl);
  const broken = await import(moduleUrl(readFileSync(safetyUrl, 'utf8'), safetyUrl, { './blocked-apps-windows.mjs': bypass }));
  for (const allowForbidden of [false, true]) for (const window of [browserWindow(), nativeWindow({ productName: 'Microsoft Edge' }),
    nativeWindow({ className: 'MozillaWindowClass' })]) {
    await assert.rejects(() => assertRefused(t, broken.createWindowsSafety, window, { windowId: '101' }, { allowForbidden }),
      assert.AssertionError);
  }
  for (const method of ['getState', 'listApps'])
    await assert.rejects(() => assertInventory(t, broken.createWindowsSafety, method), assert.AssertionError);
  await assert.rejects(() => assertNameRefused(t, broken.createWindowsSafety), assert.AssertionError);
});

test('native acquisition assertions reject a variant that refuses every app as a browser', async t => {
  const source = changed(readFileSync(policyUrl, 'utf8'), 'const names = identities(window);',
    'return { browser: true }; const names = identities(window);');
  const broken = await import(moduleUrl(readFileSync(safetyUrl, 'utf8'), safetyUrl,
    { './blocked-apps-windows.mjs': moduleUrl(source, policyUrl) }));
  for (const image of ['notepad', 'Calculator', 'WpfFixture', 'Code'])
    await assert.rejects(() => assertNativeAcquisition(t, broken.createWindowsSafety, image), { code });
});

test('packaged-frame safety assertion rejects a variant missing hosted-identity admission', async t => {
  const identityUrl = new URL('../plugins/sleight/lib/repl/identity.mjs', import.meta.url);
  const source = changed(readFileSync(identityUrl, 'utf8'), "fail('HOSTED_APP_UNRESOLVED');", '{}');
  const broken = await import(moduleUrl(readFileSync(safetyUrl, 'utf8'), safetyUrl,
    { './windows-repl/identity.mjs': moduleUrl(source, identityUrl) }));
  await assert.rejects(() => assertUnresolved(t, broken.createWindowsSafety), assert.AssertionError);
});
