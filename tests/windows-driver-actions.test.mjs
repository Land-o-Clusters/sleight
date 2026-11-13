import { windowsWorkerSkip } from './fixtures/repl-requirement.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACTION_METHODS, parseChord, validateActionParams } from '../plugins/sleight/lib/windows-driver/actions.mjs';
import { createWindowsDriverClient } from '../plugins/sleight/lib/windows-driver/client.mjs';
import { windowsDriverSources, windowsHostSources, windowsPersonSources } from '../plugins/sleight/lib/direct-browser/windows-host.mjs';
import { clickRoute, clickPatterns, settleDecision, scriptedSettle, logicalClientPoint } from './fixtures/windows-action-model.mjs';
import { windowsReplFixture } from './fixtures/windows-repl-client.mjs';

const identity = { windowId: '101', processStart: '134059077770000001', readId: 1 };
const request = args => ({ ...identity, args });
const native = name => readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/' + name, import.meta.url), 'utf8');
const output = result => result.content.filter(i => i.type === 'text').map(i => i.text).join('\n');

const forms = { click: [3], doubleClick: [{ id: 'TextEditor' }], rightClick: [[10, 20]], setValue: [3, '日本 🪄'],
  typeText: ['a\r\nb\t🪄'], pressKey: ['ctrl+shift+s'], paste: ['hello', { format: 'text' }],
  scroll: [3, { direction: 'down', amount: 3 }], selectText: [3, 'hello'],
  performSecondaryAction: [3, 'Expand'], drag: [[1, 2], [30, 40], { durationMs: 500, steps: 8 }] };
test('all 11 client action calls serialize bound identity and complete argument vectors', async t => {
  assert.deepEqual(Object.keys(forms), ACTION_METHODS);
  for (const [method, args] of Object.entries(forms)) assert.deepEqual(validateActionParams(method, request(args)), request(args));
  const { driver } = windowsReplFixture(t, { driverScenario: 'actions' });
  let read = await driver.getApp('Notepad');
  for (const [method, args] of Object.entries(forms)) {
    read = await driver[method]({ windowId: read.window.windowId, processStart: read.window.processStart, readId: read.readId }, args);
    assert.equal(read.action, method);
  }
});
for (const [name, patch] of [
  ['missing process incarnation', p => { delete p.processStart; }], ['extra envelope field', p => { p.pid = 41; }],
  ['zero read', p => { p.readId = 0; }], ['fractional read', p => { p.readId = 1.5; }],
  ['forged hwnd', p => { p.windowId = '0x65'; }], ['overflow hwnd', p => { p.windowId = '18446744073709551616'; }],
  ['unsafe creation time', p => { p.processStart = '9223372036854775808'; }],
  ['bad arity', p => { p.args.push('extra'); }], ['array-like args', p => { p.args = { 0: 3, length: 1 }; }],
  ['negative element', p => { p.args[0] = -1; }], ['unseen element', p => { p.args[0] = 3000; }],
  ['infinite point', p => { p.args[0] = [Infinity, 0]; }], ['negative point', p => { p.args[0] = [-1, 0]; }],
  ['third coordinate', p => { p.args[0] = [1, 2, 3]; }], ['extra selector field', p => { p.args[0] = { id: 'a', label: 'b' }; }],
  ['object selector', p => { p.args[0] = { id: {} }; }], ['nul selector', p => { p.args[0] = { label: 'a\0b' }; }],
]) test(`forged action refuses ${name}`, () => {
  const p = request([3]); patch(p); assert.throws(() => validateActionParams('click', p), { code: 'INVALID_PARAMS' });
});
test('nested options, text, method and secondary action are closed sets', () => {
  for (const [method, args] of [
    ['scroll', [3, { direction: 'sideways' }]], ['scroll', [3, { direction: 'down', amount: 0 }]],
    ['scroll', [3, { direction: 'up', delta: 1 }]], ['paste', ['x', { format: 'html' }]],
    ['paste', ['x', { clipboard: 'replace' }]], ['drag', [1, 2, { durationMs: 2001 }]],
    ['drag', [1, 2, { steps: 1 }]], ['drag', [1, 2, { foreground: true }]],
    ['setValue', [3, '\ud800']], ['typeText', ['\udc00']], ['paste', ['a\0b']],
    ['typeText', ['a'.repeat(65537)]], ['selectText', [3, '']],
    ['performSecondaryAction', [3, 'activate']], ['unknown', []],
  ]) assert.throws(() => validateActionParams(method, request(args)), { code: 'INVALID_PARAMS' }, method);
});
for (const [text, key, vk, modifiers] of [
  ['Return', 'return', 13, []], ['Escape', 'escape', 27, []], ['ctrl+s', 's', 0, [17]],
  ['control+shift+S', 's', 0, [16, 17]], ['alt+F4', 'f4', 115, [18]], ['super+left', 'left', 37, [91]],
  ['option+Tab', 'tab', 9, [18]], ['F24', 'f24', 135, []], ['shift', undefined, undefined, [16]],
  ['é', 'é', 0, []], ['ctrl+/', '/', 0, [17]], ['delete', 'delete', 46, []],
]) test(`chord mapping ${text}`, () => {
  const parsed = parseChord(text); assert.equal(parsed.key, key); assert.equal(parsed.virtualKey, vk); assert.deepEqual(parsed.modifiers, modifiers);
});
test('chords reject duplicate modifiers, multiple keys, malformed names and control units', () => {
  for (const value of ['ctrl+ctrl+s', 'a+b', 'ctrl+alt', 'a+ctrl', 'ctrl+', 'F25', 'ctrl+🪄', '\n', 'a\0', '', 'constructor', '__proto__'])
    assert.throws(() => parseChord(value), { code: 'INVALID_PARAMS' }, value);
  assert.equal(parseChord('shift+control+enter').canonical, parseChord('ctrl+shift+return').canonical);
});
for (const [patterns, expected] of [
  [[10000, 10015, 10010], 'Invoke'], [[10015, 10010], 'Toggle'], [[10010, 10005], 'Select'],
  [[10005, 10018], 'Expand/Collapse'], [[10018], 'DoDefaultAction'], [[], 'posted-mouse'],
]) test(`scripted provider ladder chooses ${expected}`, () => {
  const calls = []; assert.equal(clickRoute(patterns, name => calls.push(name)), expected); assert.deepEqual(calls, [expected]);
});
test('a pattern exception never falls through to another mutating action', () => {
  let calls = 0;
  assert.throws(() => clickRoute([10000, 10015], () => { calls++; throw Error('provider timeout'); }), /provider timeout/);
  assert.equal(calls, 1);
  assert.throws(() => clickRoute([], () => assert.fail(), false), { code: 'BACKGROUND_UNAVAILABLE' });
});
for (const [elapsed, quiet, count, subscribed, stable, expected] of [
  [0, 0, 0, true, false, 'wait'], [119, 119, 1, true, false, 'wait'],
  [120, 120, 1, true, false, 'event-quiet'], [700, 5, 20, true, false, 'wait'],
  [1500, 0, 100, true, false, 'cap'], [1500, 1500, 0, false, true, 'cap'],
  [220, 220, 0, false, true, 'poll-stable'], [220, 220, 0, true, false, 'wait'],
  [220, 220, 0, true, true, 'poll-stable'], [120, 120, 1, false, false, 'wait'],
]) test(`settle ${expected} at ${elapsed}/${quiet}, ${count} events, subscribed ${subscribed}`, () => {
  assert.equal(settleDecision(elapsed, quiet, count, subscribed, stable), expected);
});
test('settle scripts reset quiet time on bursts and require two complete silent-provider snapshots', () => {
  assert.deepEqual(scriptedSettle({ events: [0, 50, 120] }), { mode: 'event-quiet', settled: true, elapsedMs: 240, events: 3 });
  assert.deepEqual(scriptedSettle(), { mode: 'poll-stable', settled: true, elapsedMs: 220, events: 0 });
  assert.equal(scriptedSettle({ subscribed: false, events: [0] }).mode, 'poll-stable');
  assert.equal(scriptedSettle({ snapshots: [null, null] }).mode, 'cap');
  assert.equal(scriptedSettle({ events: Array.from({ length: 16 }, (_, i) => i * 100) }).mode, 'cap');
  assert.deepEqual(scriptedSettle({ events: [0], budgetMs: 100 }), { mode: 'budget', settled: false, elapsedMs: 100, events: 1 });
});
for (const scale of [1, 1.25, 1.5, 2]) for (const origin of [[0, 0], [-1920, -200]]) {
  test(`per-HWND logical client at ${scale * 100}% and origin ${origin}`, () => {
    const physical = [origin[0] + 200 * scale, origin[1] + 100 * scale];
    assert.deepEqual(logicalClientPoint(physical, origin, p => p.map(n => Math.round(n / scale))), [200, 100]);
    assert.deepEqual(logicalClientPoint(physical, origin, p => p), [200 * scale, 100 * scale]); // PM-aware destination.
  });
}
test('packed message coordinates refuse signed-16 overflow', () => {
  assert.throws(() => logicalClientPoint([32768, 0], [0, 0], p => p), /INVALID_COORDINATES/);
});
test('client action validation refuses before host preparation on any platform', async () => {
  let prepared = 0;
  const client = createWindowsDriverClient({ prepare: () => { prepared++; assert.fail(); } });
  assert.throws(() => client.click(identity, [null]), { code: 'INVALID_PARAMS' });
  await assert.rejects(client.click(identity, [3]), { code: 'PLATFORM' }); assert.equal(prepared, 0); await client.close();
});
test('real worker updates read ids across a four-action Calculator batch against the fake driver', { skip: windowsWorkerSkip }, async t => {
  const { js, requests } = windowsReplFixture(t, { driverScenario: 'actions' });
  const result = await js('let calc = await cua.getApp("Calculator"); for (const id of ["num7Button", "plusButton", "num5Button", "equalButton"]) await calc.click({id});');
  assert.equal(result.isError, false, output(result)); assert.match(output(result), /Display is 12/);
  const actions = requests.filter(r => r.method === 'click');
  assert.deepEqual(actions.map(r => r.params.readId), [1, 2, 3, 4]);
  assert.ok(actions.every(r => r.params.windowId === '102' && r.params.processStart === identity.processStart));
});
test('real worker maps all 11 methods and emits fresh full trees without claiming delivery', { skip: windowsWorkerSkip }, async t => {
  const { js, requests } = windowsReplFixture(t, { driverScenario: 'actions' });
  await js('let note = await cua.getApp("Notepad");');
  const calls = ['click(3)', 'doubleClick(3)', 'rightClick(3)', 'setValue(3,"first")', 'typeText(" second")',
    'pressKey("ctrl+s")', 'paste(" third",{format:"text"})', 'scroll(3,{direction:"down",amount:2})',
    'selectText(3,"first")', 'performSecondaryAction(2,"Expand")', 'drag([1,2],[30,40])'];
  for (const call of calls) {
    const result = await js(`nodeRepl.write(await note.${call});`);
    assert.equal(result.isError, false, output(result)); assert.match(output(result), /Window:/); assert.match(output(result), /unconfirmed/);
  }
  assert.deepEqual(requests.filter(r => ACTION_METHODS.includes(r.method)).map(r => r.method), ACTION_METHODS);
  assert.match(output(await js('await note.getAXState();')), /first second third/);
});
test('forged IPC, a stale map, and a password target refuse in the fake without poisoning the warm driver', { skip: windowsWorkerSkip }, async t => {
  const { js, requests } = windowsReplFixture(t, { driverScenario: 'actions' });
  await js('let note = await cua.getApp("Notepad");');
  const result = await js('try { await note.click(4); } catch(e) { nodeRepl.write(e.code); }');
  assert.match(output(result), /PASSWORD_TARGET/);
  await js('let calc = await cua.getApp("Calculator");');
  assert.match(output(await js('await note.click(3);')), /STALE_READ/);
  const forged = await js('cua.constructor.constructor("return process")().send({type:"driver",id:9999,cell:5,method:"click",params:{windowId:"101",readId:1,args:[3]}}); await new Promise(r=>setTimeout(r,30));');
  assert.equal(forged.isError, false);
  assert.deepEqual(requests.at(-1), { method: 'click', params: { windowId: '101', readId: 1, args: [3] } });
  assert.equal((await js('await calc.getAXState();')).isError, false);
});
test('native action sources retain C# 5 and exclude foreground APIs, UI frameworks and external processes', () => {
  for (const name of windowsDriverSources.filter(n => n.endsWith('.cs') && n !== 'Program.cs')) {
    const source = native(name);
    assert.doesNotMatch(source, /SendInput|SetForegroundWindow|AttachThreadInput|SetFocus|BringWindowToTop|ShowWindow|Process\.Start|System\.Windows\.Automation|System\.Windows\.Forms/);
    assert.doesNotMatch(source, /\$"|\?\.|nameof\(|using var |out var /);
  }
  for (const name of ['DriverActions.cs', 'DriverInput.cs', 'DriverSettle.cs', 'DriverClipboard.cs']) {
    assert.ok(windowsDriverSources.includes(name)); assert.ok(!windowsHostSources.includes(name)); assert.ok(!windowsPersonSources.includes(name));
  }
});
test('native and portable ladder, key and settle tables match the specified wire contract', () => {
  const actions = native('DriverActions.cs'), plan = native('DriverActionPlan.cs'), settle = native('DriverSettle.cs');
  assert.ok(actions.includes(`new[] { ${clickPatterns.map(p => p[0]).join(', ')} }`));
  for (const [name, vk] of Object.entries({ return: 13, escape: 27, tab: 9, left: 37, delete: 46 }))
    assert.ok(plan.includes(`{ "${name}", ${vk} }`));
  assert.match(settle, /QuietMs = 120, CapMs = 1500, PollMs = 100/);
  assert.match(settle, /RemovePropertyChangedEventHandler/); assert.match(settle, /RemoveStructureChangedEventHandler/);
  assert.match(settle, /RemoveFocusChangedEventHandler/); assert.match(settle, /previous != null && current != null && previous == current/);
  assert.match(actions, /plan\.ReadId != readId/); assert.match(actions, /SequenceEqual\(node\.Element\.GetRuntimeId\(\)\)/);
  assert.match(actions, /plan\.ProcessStart != latestWindow\.ProcessStart/); assert.match(actions, /PASSWORD_TARGET/);
  assert.match(native('DriverInput.cs'), /GetGUIThreadInfo/); assert.match(native('DriverInput.cs'), /VkKeyScanExW/);
  assert.match(native('DriverInput.cs'), /MapVirtualKeyExW/); assert.match(native('DriverInput.cs'), /PhysicalToLogicalPointForPerMonitorDPI/);
  assert.doesNotMatch(native('DriverClipboard.cs'), /SetClipboardData|EmptyClipboard/);
  assert.deepEqual(native('DriverClipboard.cs').match(/\[DllImport[^\n]+/g), [
    '[DllImport("user32.dll", EntryPoint = "GetClipboardSequenceNumber", SetLastError = true)] static extern uint Sequence();',
    '[DllImport("kernel32.dll")] static extern void SetLastError(uint error);',
  ]);
});
test('COM action and event declarations preserve SDK vtable slots and pattern GUIDs', () => {
  const slots = (source, name) => source.match(new RegExp(`interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`))[1]
    .replace(/\/\/[^\n]*/g, '').replace(/\[[^\]]*\]/g, '').match(/\w+\([^;]*?\);/g).map(m => m.slice(0, m.indexOf('(')));
  const source = native('DriverUia.cs'), automation = slots(source, 'IUIAutomation');
  for (const [index, method] of [[31, 'AddPropertyChangedEventHandlerNativeArray'], [33, 'RemovePropertyChangedEventHandler'],
    [34, 'AddStructureChangedEventHandler'], [35, 'RemoveStructureChangedEventHandler'],
    [36, 'AddFocusChangedEventHandler'], [37, 'RemoveFocusChangedEventHandler']]) assert.equal(automation[index], method);
  assert.equal(slots(native('DriverPatterns.cs'), 'ILegacy')[12], 'CurrentDefaultAction');
  const element = slots(source, 'IUIAutomationElement');
  assert.equal(element[1], 'GetRuntimeId'); assert.equal(element[8], 'GetCurrentPropertyValueEx'); assert.equal(element[13], 'GetCurrentPattern');
  assert.equal(slots(source, 'IUIAutomationTreeWalker')[0], 'GetParentElement');
  const patterns = native('DriverPatterns.cs');
  assert.equal(slots(patterns, 'IText')[4], 'DocumentRange');
  assert.equal(slots(patterns, 'ITextRange')[5], 'FindText'); assert.equal(slots(patterns, 'ITextRange')[13], 'Select');
  for (const guid of ['fb377fbe-8ea6-46d5-9c73-6499642d3059', 'a94cd8b1-0844-4cd6-9d2d-640537ab39e9',
    '94cf8058-9b8d-4ab9-8bfd-4cd0a33c8c70', '32eba289-3583-42c9-9c59-3b6d9a1e9b6a',
    'a543cc6a-f4ae-494b-8239-c814481187a8', 'e81d1b4e-11c5-42f8-9754-e7036c79f054',
    '40cd37d4-c756-4b0c-8c6f-bddfeeb13b50', 'c270f6b5-5c69-4290-9745-7a7f97169468']) assert.ok(patterns.includes(guid));
  assert.match(native('DriverActions.cs'), /0x80040204/); assert.doesNotMatch(native('DriverActions.cs').split('internal static string ClickLadder')[0], /0x80040200/);
});

test('typeText refuses over 4000 UTF-16 units and C0 commands before preparing the driver', () => {
  assert.equal(validateActionParams('typeText', request(['a'.repeat(4000)])).args[0].length, 4000);
  assert.equal(validateActionParams('typeText', request(['\t\r\n🪄'])).args[0], '\t\r\n🪄');
  for (const s of ['a'.repeat(4001), '\x03', '\x16', '\x18', '\x1a', '\x1f'])
    assert.throws(() => validateActionParams('typeText', request([s])), { code: 'INVALID_PARAMS' });
});
test('paste caps posted work at 4000 UTF-16 units and refuses larger input before host preparation', async () => {
  for (const text of ['a'.repeat(4000), '🪄'.repeat(2000)])
    assert.equal(validateActionParams('paste', request([text])).args[0].length, 4000);
  let prepared = 0;
  const client = createWindowsDriverClient({ platform: 'win32', prepare: () => { prepared++; assert.fail(); } });
  for (const text of ['a'.repeat(4001), '🪄'.repeat(2000) + 'a', 'a'.repeat(65536)])
    assert.throws(() => client.paste(identity, [text]), { code: 'INVALID_PARAMS' });
  assert.equal(prepared, 0);
  await client.close();
});
// This source tripwire covers Mac CI; the C# boundary fixture still needs Windows.
test('native paste cap tripwire keeps both posted text routes at 4000 UTF-16 units', () => {
  const plan = native('DriverActionPlan.cs').replace(/\/\/[^\n]*/g, '');
  assert.match(plan, /if \(method == "typeText" \|\| method == "paste" \|\| method == "pressKey"\)\s*\{\s*plan.Text = String\(a\[0\], method == "pressKey" \? 128 : 4000, method != "pressKey"\);/);
});
test('paste returns the direct edit character route through the client', async t => {
  const { driver } = windowsReplFixture(t, { driverScenario: 'actions' });
  const read = await driver.getApp('Notepad');
  const result = await driver.paste({ windowId: read.window.windowId, processStart: read.window.processStart, readId: read.readId }, [' pasted']);
  assert.equal(result.route, 'WM_CHAR');
  assert.match(result.text, /Hello 日本 🪄 pasted/);
  assert.equal(result.confirmation, 'unconfirmed');
});
test('action watchdog reports uncertain input without obsolete clipboard recovery advice', async t => {
  const { driver } = windowsReplFixture(t, { driverScenario: 'stall-action' });
  await assert.rejects(driver.paste(identity, ['a'], { timeoutMs: 30 }), error => {
    assert.equal(error.code, 'DEADLINE_EXCEEDED');
    assert.equal(error.unhealthy, true);
    assert.match(error.message, /Input may have landed; read again before repeating\./);
    assert.doesNotMatch(error.message, /clipboard/i);
    return true;
  });
});
test('native key policy refuses modifier chords except the named Alt mnemonic default after layout resolution', () => {
  const input = native('DriverInput.cs'), plan = native('DriverActionPlan.cs'), actions = native('DriverActions.cs');
  assert.match(plan, /CHORD_NEEDS_FOREGROUND/);
  assert.match(plan, /if \(modifiers\.Length != 0 && !\(DriverClipboardRule.AllowMenuMnemonics && Key != null && Key.Length == 1/);
  assert.doesNotMatch(plan, /modifier-state-not-applied/);
  assert.match(input, /chord\.PostedLimits\(modifiers\)/);
  assert.match(actions, /"limits"/);
});
test('native paste uses only a writable edit character route beside the read-only counter', () => {
  const source = native('DriverClipboard.cs');
  for (const name of windowsDriverSources.filter(name => name.endsWith('.cs'))) {
    assert.doesNotMatch(native(name), /\b(?:OpenClipboard|CloseClipboard|EmptyClipboard|GetClipboardData|SetClipboardData|OleSetClipboard)\s*\(/, name);
  }
  assert.doesNotMatch(source, /ClipboardData|EmptyClipboard|OpenClipboard|0x302|WM_PASTE/);
  assert.equal((source.match(/GetClipboardSequenceNumber/g) ?? []).length, 1);
  assert.match(source, /DirectPaste\(/);
  assert.match(source, /RequireWritableEdit/);
  assert.match(source, /DriverInput.Type\(window, focus, text, true\)/);
  const input = native('DriverInput.cs');
  assert.match(input, /RequireWritableEdit/);
  assert.match(input, /0x800/); // ES_READONLY must also protect WM_SETTEXT.
  assert.match(input, /GetWindowLongW/);
  assert.doesNotMatch(native('DriverActions.cs'), /return "WM_PASTE"/);
});
test('native text pump bounds chunks and reports partial progress without treating WM_NULL as a queue drain', () => {
  const source = native('DriverInput.cs');
  assert.match(source, /PumpText/); assert.match(source, /typed=/);
  assert.match(source, /1816/); assert.match(source, /256/); assert.match(source, /64/);
});
test('native provider mapping and cached focus callbacks preserve specific failures', () => {
  const actions = native('DriverActions.cs'), settle = native('DriverSettle.cs');
  for (const code of ['STALE_ELEMENT', 'ELEMENT_DISABLED', 'PROVIDER_TIMEOUT', 'ACCESS_DENIED', 'ACTION_REFUSED', 'ACTION_UNCONFIRMED']) assert.ok(actions.includes(code));
  assert.match(actions, /input may have landed/);
  assert.match(settle, /AddFocusChangedEventHandler\(focusCache, this\)/);
  assert.match(settle, /GetCachedPropertyValueEx\(30002, true\)/);
  assert.doesNotMatch(settle, /element\.GetCurrentPropertyValueEx/);
});

for (const type of [50004, 50020, 50030, 50033]) test(`scripted ${type} uses posted click despite a legacy pattern`, () => {
  const calls = [];
  assert.equal(clickRoute([10018], name => calls.push(name), true, { type }), 'posted-mouse');
  assert.deepEqual(calls, ['posted-mouse']);
});
test('scripted legacy without a default action continues to posted click', () => {
  const calls = [];
  assert.equal(clickRoute([10018], name => calls.push(name), true, { defaultAction: '' }), 'posted-mouse');
  assert.deepEqual(calls, ['posted-mouse']);
});

test('bare cua actions emit returned limitations beside the tree', async () => {
  const { createWindowsCua } = await import('../plugins/sleight/lib/windows-repl/cua.mjs');
  const window = { windowId: '101', processStart: '3', pid: 41, image: 'C:\\Windows\\notepad.exe', integrity: 'medium', refused: null };
  const writes = [];
  const cua = createWindowsCua({ write: text => writes.push(text), request: async method => ({ window, readId: 1,
    text: 'Window: "Fixture", App: Notepad.\n0 standard window Fixture',
    ...(method === 'pressKey' ? { action: method, route: 'posted-key', limits: ['modifier-state-not-applied'], confirmation: 'unconfirmed' } : {}),
  }) });
  const app = await cua.getApp('Notepad'); writes.length = 0;
  await app.pressKey('ctrl+left');
  assert.ok(writes.some(text => text.includes('modifier-state-not-applied')));
});

test('native settle polling preserves the read reserve and provider reads cannot bypass cancellation', () => {
  const source = native('DriverActions.cs');
  const snapshot = source.slice(source.indexOf('    string Snapshot('));
  assert.match(snapshot, /Driver\.Now\(\) < deadline - 2750/);
  assert.match(source, /Effect\(\(\) => EffectBoundary\(node, window\), \(\) => p.SetValue\(plan.Text\)\)/);
  assert.match(source, /Effect\(\(\) => EffectBoundary\(node, window\), found.Select\)/);
});
