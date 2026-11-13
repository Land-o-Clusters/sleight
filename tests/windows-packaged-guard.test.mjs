import test from 'node:test';
import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { body, native } from './fixtures/windows-review-seams.mjs';
import { createDriverSafety } from '../plugins/sleight/lib/driver-safety.mjs';

function guardOrder(source) {
  assert.equal((source.match(/static readonly bool EnablePackagedFrames = false;/g) ?? []).length, 1);
  const observe = body(source, 'static WindowRecord Observe(IntPtr hwnd, bool hosted)');
  const refusal = observe.indexOf('if (RefusePackaged(row, HasPackagedWindow))');
  const style = observe.indexOf('if ((style & 0x80)');
  const process = observe.indexOf('IntPtr process = OpenProcess');
  assert.ok(refusal >= 0 && refusal < style && style < process);
  assert.match(observe.slice(refusal, style), /PackagedLookupIdentity\(row\);\s*return row;/);
}
test('Mac native source check pins the disabled packaged guard before filters and process observation', () => guardOrder(native('DriverInventory.cs')));
test('packaged frame test gate is closed in product source and has no environment or protocol setter', () => {
  const inventory = native('DriverInventory.cs');
  const driver = native('Driver.cs');
  const input = native('DriverInput.cs');
  assert.equal((inventory.match(/PackagedFrameTestGate\.Admit\s*=/g) ?? []).length, 0);
  assert.equal((driver + input).includes('PackagedFrameTestGate'), false);
  assert.doesNotMatch(inventory, /GetEnvironmentVariable\([\s\S]{0,80}Packaged|Packaged[\s\S]{0,80}GetEnvironmentVariable/);
  assert.match(inventory, /internal static class PackagedFrameTestGate \{ internal static bool Admit; \}/);
  assert.match(inventory, /return EnablePackagedFrames \|\| PackagedFrameTestGate\.Admit;/);
});
test('native guard order catches switch and late-guard broken variants', () => {
  const source = native('DriverInventory.cs');
  const guard = /        if \(RefusePackaged\(row, HasPackagedWindow\)\) \{[^]*?            return row;\n        \}\n/.exec(source)?.[0];
  assert.ok(guard);
  assert.ok(source.includes(guard));
  for (const broken of [
    source.replace('static readonly bool EnablePackagedFrames = false;', 'static readonly bool EnablePackagedFrames = true;'),
    source.replace(guard, '').replace('        if (process == IntPtr.Zero) return row;', '        if (process == IntPtr.Zero) return row;\n' + guard),
    source.replace('if (RefusePackaged(row, HasPackagedWindow))', 'if (false)'),
  ]) assert.throws(() => guardOrder(broken), assert.AssertionError);
});
function identityContract(source) {
  const unresolved = runInNewContext(`window => { ${body(source, 'internal static bool UnresolvedHost(')} }`, {
    Path: { GetFileName: value => win32.basename(value ?? '') }, StringComparison: { OrdinalIgnoreCase: 0 },
    String: { Equals: (a, b) => a?.toLowerCase() === b?.toLowerCase(), IsNullOrEmpty: value => !value },
    IntPtr: { Zero: 0 }, DriverInventory: { PackagedFramesOpen: () => false },
  });
  for (const ClassName of ['ApplicationFrameWindow', 'Windows.UI.Core.CoreWindow', 'applicationframewindow', 'WINDOWS.UI.CORE.COREWINDOW']) for (const Aumid of [null, 'Fixture.Package!App'])
    assert.equal(unresolved({ ClassName, Aumid, Image: 'C:\\Apps\\Fixture.exe' }), true);
  assert.equal(unresolved({ ClassName: 'OrdinaryWindow', Image: 'C:\\Apps\\Fixture.exe' }), false);
  assert.equal(unresolved({ ClassName: 'Other', Image: 'C:\\Windows\\ApplicationFrameHost.exe' }), true);
}
test('native UnresolvedHost refuses both packaged classes with or without an AUMID', () => identityContract(native('DriverIdentity.cs')));
test('native identity defense catches an AUMID bypass broken variant', () => {
  const source = native('DriverIdentity.cs');
  const before = 'return String.Equals(window.ClassName, "Windows.UI.Core.CoreWindow", StringComparison.OrdinalIgnoreCase);';
  assert.ok(source.includes(before));
  assert.throws(() => identityContract(source.replace(before, 'return String.Equals(window.ClassName, "Windows.UI.Core.CoreWindow", StringComparison.OrdinalIgnoreCase) && String.IsNullOrEmpty(window.Aumid);')), assert.AssertionError);
});

function nativeSelectors(source) {
  const code = body(source, 'internal static string[] HostedSelectors(').replace('new[] {', '[')
    .replace(/\}\s*\.Where\(s => !String.IsNullOrEmpty\(s\)\)\.ToArray\(\)/, '].filter(s => !String.IsNullOrEmpty(s))');
  return runInNewContext(`row => { ${code} }`, {
    Path: { GetFileName: value => value === null ? null : win32.basename(value) },
    String: { IsNullOrEmpty: value => !value }, CultureInfo: { InvariantCulture: null },
  });
}
function basenameContract(source) {
  const values = nativeSelectors(source)({ App: 'CalculatorApp', Image: 'C:\\Apps\\CalculatorApp.exe', Aumid: 'Package!App',
    Title: 'Calculator', Pid: { ToString: () => '4240' } });
  assert.ok(values.includes('CalculatorApp.exe'));
}
test('native hosted lookup exports the image basename for private refusal hashes', () => basenameContract(native('DriverInventory.cs')));
test('basename regression catches a missing selector broken variant', () => {
  const source = native('DriverInventory.cs'); assert.ok(source.includes('Path.GetFileName(row.Image), '));
  assert.throws(() => basenameContract(source.replace('Path.GetFileName(row.Image), ', '')), assert.AssertionError);
});

test('merged top-level CoreWindow with an AUMID refuses name, AUMID, PID and HWND before approval', async () => {
  const source = native('DriverInventory.cs');
  const row = { Handle: 99, Pid: { ToString: () => '4240' }, ClassName: 'Windows.UI.Core.CoreWindow',
    App: 'CalculatorApp', Image: 'C:\\Apps\\CalculatorApp.exe', Aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', Title: 'Calculator' };
  const refuse = runInNewContext(`(row, hostedProcess) => { ${body(source, 'internal static bool RefusePackaged(')} }`, {
    PackagedFramesOpen: () => false, StringComparison: { OrdinalIgnoreCase: 0 },
    String: { Equals: (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase() },
  });
  assert.equal(refuse(row, () => assert.fail('class refusal must precede process scanning')), true);
  assert.equal(row.Refused, 'HOSTED_APP_UNRESOLVED');
  const hostedSelectorHashes = nativeSelectors(source)(row).map(value => createHash('sha256').update(value.toLowerCase()).digest('hex'));
  const observed = { windowId: '99', pid: 4240, className: row.ClassName, aumid: row.Aumid, app: row.App,
    image: row.Image, title: row.Title, refused: row.Refused, hostedSelectorHashes };
  const calls = [];
  const safety = createDriverSafety({ platform: 'win32', driver: { request: async method => { calls.push(method); return { windows: [observed] }; } },
    approve: () => assert.fail('approval'), lease: { acquire: () => assert.fail('lease'), close() {} } });
  try {
    for (const selector of ['Calculator', row.Aumid, '4240', { windowId: '99' }])
      await assert.rejects(safety.request('getApp', { selector }), { code: 'HOSTED_APP_UNRESOLVED' });
    assert.deepEqual(calls, Array(4).fill('getState'));
  } finally { await safety.close(); }
});


function mixedCaseGuard(source) {
  const refuse = runInNewContext(`(row, hostedProcess) => { ${body(source, 'internal static bool RefusePackaged(')} }`, {
    PackagedFramesOpen: () => false, StringComparison: { OrdinalIgnoreCase: 0, Ordinal: 1 },
    String: { Equals: (a, b, mode) => mode === 0 ? a?.toLowerCase() === b?.toLowerCase() : a === b },
  });
  for (const ClassName of ['applicationframewindow', 'APPLICATIONFRAMEWINDOW', 'windows.ui.core.corewindow', 'WINDOWS.UI.CORE.COREWINDOW'])
    assert.equal(refuse({ ClassName, Pid: 42 }, () => assert.fail('class refusal must run before process reads')), true);
}
test('packaged native classes refuse every casing before process reads', () => mixedCaseGuard(native('DriverInventory.cs')));
test('case-sensitive-class-guard broken variant fails before process reads', () =>
  assert.throws(() => mixedCaseGuard(native('DriverInventory.cs').replaceAll('StringComparison.OrdinalIgnoreCase', 'StringComparison.Ordinal')), assert.AssertionError));
