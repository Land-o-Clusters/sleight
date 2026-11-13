import { windowsWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { foregroundFallback } from '../plugins/sleight/lib/windows-driver/routes.mjs';

const binding = { windowId: '101', processStart: '3', readId: 1 };
const unavailable = () => { throw Object.assign(Error('drag: WPF does not accept background drag'), { code: 'BACKGROUND_UNAVAILABLE' }); };

// Source tripwires run on Mac. Only the Windows fixture can prove native behavior.
test('native same-depth hit-test tripwire requires a refusal before returning a winner', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/DriverActions.cs', import.meta.url), 'utf8');
  const hitTest = source.slice(source.indexOf('    internal static DriverNode HitTest('), source.indexOf('    static double[] RectangleOf('))
    .replace(/\/\/[^\n]*/g, '');
  assert.match(hitTest, /if \(hits\.Skip\(1\)\.Any\(n => n\.Host\.Handle == node\.Host\.Handle && n\.RootOrder == node\.RootOrder && n\.Depth == node\.Depth\)\)\s*throw new DriverFault\("BACKGROUND_UNAVAILABLE",[\s\S]*?\);\s*return node;/);
});

test('native coordinate tie refusal tripwire uses coordinate wording at target resolution', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/DriverActions.cs', import.meta.url), 'utf8');
  const resolve = source.slice(source.indexOf('    DriverNode ResolveTarget('), source.indexOf('    internal static DriverNode HitTest('));
  assert.match(resolve, /return HitTest\(latest.Values, window.Handle, p, true\);/);
  const hitTest = source.slice(source.indexOf('    internal static DriverNode HitTest('), source.indexOf('    static double[] RectangleOf('));
  assert.match(hitTest, /bool coordinate = false/);
  assert.match(hitTest, /throw new DriverFault\("BACKGROUND_UNAVAILABLE", coordinate\s*\? "hit point overlaps elements at the same depth; coordinate target cannot be proved"\s*: "hit point overlaps elements at the same depth; named element cannot be proved"\)/);
});

test('background success preserves an observed foreground change without invoking the foreground callback', async () => {
  const result = await foregroundFallback({ action: 'click', identity: binding, args: [3],
    background: async () => ({ route: 'Invoke', window: binding, foregroundChanged: true, foregroundExecutable: 'Calculator.exe' }), verify: () => assert.fail(),
    foreground: () => assert.fail() });
  assert.equal(result.route, 'Invoke'); assert.equal(result.foregroundChanged, true);
  assert.equal(result.foregroundExecutable, 'Calculator.exe'); assert.equal(Object.hasOwn(result, 'tookFocus'), false);
});

test('background results preserve unchanged and unavailable foreground observations', async () => {
  for (const foregroundExecutable of ['explorer.exe', null]) {
    const result = await foregroundFallback({ action: 'click', identity: binding, args: [3],
      background: async () => ({ foregroundChanged: false, foregroundExecutable }) });
    assert.deepEqual(result, { foregroundChanged: false, foregroundExecutable });
  }
});

test('native posted pointer guard binds named centers before any input callback', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/DriverActions.cs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /PatternAtPoint/); // A pattern miss must not re-run the same pattern.
  assert.match(source, /PostedRoute\(plan, latest.Values, window.Handle, node,/);
  const guard = source.slice(source.indexOf('    internal static string PostedRoute('), source.indexOf('    internal static bool RequiresPostedSurface('));
  assert.match(guard, /HitTest\(nodes, window, point\)/);
  assert.match(guard, /hit != anchor/);
  assert.match(guard, /hit.Host.Handle != anchor.Host.Handle/);
  assert.ok(guard.indexOf('hit != anchor') < guard.indexOf('return post(point)'));
  assert.match(guard, /Edit, Document, Text and Pane/);
  assert.match(guard, /coordinate click/);
  assert.match(source, /scroll does not search ancestors/);
});

test('posted surface restrictions apply to pointer input while text keeps its proved HWND route', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/DriverActions.cs', import.meta.url), 'utf8');
  assert.match(source, /return action == "click" \|\| action == "doubleClick" \|\| action == "rightClick" \|\| action == "scroll" \|\| action == "drag"/);
  const reason = source.slice(source.indexOf('    internal static string PostedReason('), source.indexOf('    static void RequirePosted('));
  assert.match(reason, /if \(!RequiresPostedSurface\(action\)\) return null;/);
  assert.ok(reason.indexOf('if (!RequiresPostedSurface(action)) return null;') < reason.indexOf('if (offscreen)'));
  const require = source.slice(source.indexOf('    static void RequirePosted('), source.indexOf('    // A miss'));
  assert.match(require, /if \(!RequiresPostedSurface\(action\)\) return;/);
  assert.ok(require.indexOf('if (!RequiresPostedSurface(action)) return;') < require.indexOf('GetCurrentPropertyValueEx(IsOffscreen'));
  assert.match(source, /DriverInput\.Type\(node\.Host, FocusHandle\(node\), plan\.Text\)/);
  assert.match(source, /DriverClipboard\.Paste\(node\.Host, FocusHandle\(node\), plan\.Text\)/);
  assert.match(source, /DriverInput\.Keys\(node\.Host, FocusHandle\(node\), plan\.Chord/);
  assert.match(source, /DriverInput\.SetValue\(node\.Host, TargetHandle\(node\), plan\.Text\)/);
});

test('capture notes identify the client DC and the limited PrintWindow pixel check', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/DriverCapture.cs', import.meta.url), 'utf8');
  assert.match(source, /Copy from the target HWND client DC/);
  assert.match(source, /PrintWindow[^\n]*nonzero RGB[^\n]*complete painting is unverified/);
  assert.doesNotMatch(source, /Screen copy of the exposed window/);
});
test('foreground requires an explicit per-action callback and verifies identity first', async () => {
  const events = [];
  const result = await foregroundFallback({ action: 'drag', identity: binding, args: [1, 2],
    background: unavailable, verify: async () => { events.push('verify'); },
    foreground: async request => { events.push(request.action); assert.deepEqual(request.identity, binding);
      assert.deepEqual(request.args, [1, 2]); return { confirmation: 'unconfirmed', route: 'engine' }; } });
  assert.deepEqual(events, ['verify', 'drag']);
  assert.equal(result.route, 'foreground'); assert.equal(result.foregroundRoute, 'engine'); assert.equal(result.tookFocus, true);
  await assert.rejects(foregroundFallback({ action: 'drag', identity: binding, args: [1, 2], background: unavailable }),
    { code: 'BACKGROUND_UNAVAILABLE' });
});
for (const code of ['ACTION_UNCONFIRMED', 'STALE_READ', 'IDENTITY_CHANGED', 'ACCESS_DENIED', 'USER_ACTIVE', 'ACTION_BUDGET']) {
  test(`foreground never retries ${code}`, async () => {
    await assert.rejects(foregroundFallback({ action: 'click', identity: binding, args: [3],
      background: async () => { throw Object.assign(Error(code), { code }); }, verify: () => assert.fail(),
      foreground: () => assert.fail() }), { code });
  });
}
test('identity changes and malformed foreground options refuse without input', async () => {
  await assert.rejects(foregroundFallback({ action: 'drag', identity: binding, args: [1, 2], background: unavailable,
    verify: async () => { throw Object.assign(Error('changed'), { code: 'IDENTITY_CHANGED' }); },
    foreground: () => assert.fail() }), { code: 'IDENTITY_CHANGED' });
  for (const foreground of [true, 'engine', {}, null]) {
    await assert.rejects(foregroundFallback({ action: 'click', identity: binding, args: [3], background: () => assert.fail(),
      foreground }), { code: 'INVALID_PARAMS' });
  }
});
test('partial input is never retried even if a provider returns the background refusal code', async () => {
  await assert.rejects(foregroundFallback({ action: 'drag', identity: binding, args: [1, 2],
    background: async () => { throw Object.assign(Error('input may have landed; read again'), { code: 'BACKGROUND_UNAVAILABLE' }); },
    verify: () => assert.fail(), foreground: () => assert.fail() }), { code: 'BACKGROUND_UNAVAILABLE' });
});

test('native action entry uses a single pattern attempt followed by guarded messages', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/DriverActions.cs', import.meta.url), 'utf8');
  assert.match(source, /internal static string BackgroundRoute\(/);
  assert.match(source, /internal static string PostedRoute\(/);
  for (const method of ['click', 'doubleClick', 'rightClick', 'setValue', 'typeText', 'pressKey', 'scroll', 'drag'])
    assert.ok(source.includes(`case "${method}"`), method);
  assert.match(source, /BackgroundRoute\(plan\.Method,/);
  assert.doesNotMatch(source, /"tookFocus", false/);
  assert.match(source, /IntPtr foregroundBefore = GetForegroundWindow\(\)/);
  assert.match(source, /IntPtr foregroundAfter = GetForegroundWindow\(\)/);
  assert.match(source, /"foregroundChanged", foregroundBefore != foregroundAfter/);
  assert.match(source, /"foregroundExecutable", DriverInventory.ExecutableName\(foregroundAfter\)/);
  const run = source.slice(source.indexOf('    object RunAction('));
  assert.ok(run.indexOf('foregroundBefore =') < run.indexOf('Apply(secondary,'));
  assert.ok(run.indexOf('foregroundAfter =') > run.indexOf('settle.Wait('));
  assert.ok(run.indexOf('foregroundAfter =') > run.indexOf('Json.Object(Read('));
});

for (const scenario of ['actions', 'foreground-changed'])
  test(`client and worker carry foreground observations from a fake driver (${scenario})`, { skip: windowsWorkerSkip }, async t => {
    const { windowsReplFixture } = await import('./fixtures/windows-repl-client.mjs');
    const { js } = windowsReplFixture(t, { driverScenario: scenario });
    const acquired = await js('let app = await cua.getApp("Notepad");');
    assert.equal(acquired.isError, false);
    const result = await js('const observed = await app.click(2); nodeRepl.write({ changed: observed.foregroundChanged, exe: observed.foregroundExecutable, tookFocus: observed.tookFocus });');
    assert.equal(result.isError, false);
    const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    assert.ok(text.includes(JSON.stringify({ changed: scenario === 'foreground-changed',
      exe: scenario === 'foreground-changed' ? 'Calculator.exe' : 'explorer.exe' })), text);
  });

test('capture uses the per-window chain and withholds covered screen pixels', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/DriverCapture.cs', import.meta.url), 'utf8');
  assert.match(source, /CaptureChain\(/);
  assert.match(source, /new\[\] \{ "PrintWindow", "Windows.Graphics.Capture", "BitBlt" \}/);
  assert.match(source, /ScreenCopyAllowed\(/);
  assert.match(source, /"attempts"/);
  assert.match(source, /CreateFreeThreaded/);
});

test('foreground adapter failures retain focus-taking metadata', async () => {
  await assert.rejects(foregroundFallback({ action: 'drag', identity: binding, args: [1, 2], background: unavailable,
    verify: async () => {}, foreground: async () => { throw Object.assign(Error('adapter failed'), { code: 'ENGINE_FAILED' }); } }),
  error => error.code === 'ENGINE_FAILED' && error.tookFocus === true && error.route === 'foreground' && /foreground/i.test(error.message));
});

test('client action fallback is per-call and never sent in driver IPC', async t => {
  const { createWindowsDriverClient } = await import('../plugins/sleight/lib/windows-driver/client.mjs');
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const client = createWindowsDriverClient({ platform: 'win32', prepare: async () => ({ status: 'ready', spawn({ nonce }) {
    return spawn(process.execPath, [fileURLToPath(new URL('./fixtures/windows-driver-fake.mjs', import.meta.url)), 'background-unavailable'],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { SLEIGHT_DRIVER_NONCE: nonce } });
  } }) });
  t.after(() => client.close());
  const read = await client.getApp('Notepad');
  const identity = { windowId: read.window.windowId, processStart: read.window.processStart, readId: read.readId };
  let calls = 0;
  const result = await client.drag(identity, [1, 2], { foreground: async request => {
    calls++; assert.deepEqual(request.identity, identity); return { route: 'fake-engine' };
  } });
  assert.equal(result.route, 'foreground'); assert.equal(result.tookFocus, true); assert.equal(calls, 1);
  await assert.rejects(client.drag(identity, [1, 2]), { code: 'BACKGROUND_UNAVAILABLE' });
  assert.equal(calls, 1);
  await assert.rejects(client.drag(identity, [1, 2], { foreground: true }), { code: 'INVALID_PARAMS' });
});

test('WGC COM declarations keep the Microsoft ABI slots without dynamic dispatch', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/DriverCapture.cs', import.meta.url), 'utf8');
  const slots = name => source.match(new RegExp(`interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`))[1]
    .replace(/\/\/[^\n]*/g, '').replace(/\[[^\]]*\]/g, '').match(/\w+\([^;]*?\);/g).map(m => m.slice(0, m.indexOf('(')));
  for (const [name, index, method] of [['IWgcItem', 4, 'Size'], ['IWgcPoolFactory', 3, 'CreateFreeThreaded'],
    ['IWgcPool', 4, 'TryGetNextFrame'], ['IWgcPool', 7, 'CreateCaptureSession'], ['IWgcFrame', 3, 'Surface'],
    ['IWgcFrame', 5, 'ContentSize'], ['IWgcDevice', 2, 'CreateTexture2D'], ['IWgcTexture', 7, 'GetDesc'],
    ['IWgcContext', 11, 'Map'], ['IWgcContext', 12, 'Unmap'], ['IWgcContext', 44, 'CopyResource']])
    assert.equal(slots(name)[index], method, `${name} slot ${index}`);
  assert.match(source, /0x100000/); // D3D11_MAP_FLAG_DO_NOT_WAIT
  assert.match(source, /Driver\.Now\(\) \+ 750/);
  assert.match(source, /Release\(frame, true\); Release\(session, true\); Release\(pool, true\)/);
  assert.match(source, /ReleaseDC\(window\.Handle, source\)/);
  assert.doesNotMatch(source, /CreateForMonitor|GraphicsCapturePicker|GetDelegateForFunctionPointer|GetProcAddress/);
});

test('an unhealthy background refusal cannot enter the foreground route', async () => {
  await assert.rejects(foregroundFallback({ action: 'drag', identity: binding, args: [1, 2],
    background: async () => { throw Object.assign(Error('driver unhealthy'), { code: 'BACKGROUND_UNAVAILABLE', unhealthy: true }); },
    verify: () => assert.fail(), foreground: () => assert.fail() }), { code: 'BACKGROUND_UNAVAILABLE', unhealthy: true });
});
