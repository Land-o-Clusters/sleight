import test from 'node:test';
import assert from 'node:assert/strict';
import { native } from './fixtures/windows-review-seams.mjs';
import { packagedSeams, packagedFixture } from './fixtures/windows-packaged-seams.mjs';

const ordinary = { id: 1, pid: 41, className: 'OrdinaryWindow' };
const layouts = [
  ['top-level CoreWindow', [{ id: 2, pid: 42, className: 'Windows.UI.Core.CoreWindow' }]],
  ['frame child', [{ id: 2, pid: 52, className: 'ApplicationFrameWindow' }, { id: 3, parent: 2, pid: 42 }]],
  ['renamed frame class', [{ id: 2, pid: 52, className: 'Other', image: 'applicationframehost.EXE' }, { id: 3, parent: 2, pid: 42 }]],
];
function scanContract(source) {
  const { has } = packagedSeams(source);
  for (const [name, rows] of layouts) {
    const { api, calls } = packagedFixture([ordinary, ...rows]);
    assert.equal(has(42, api), true, name);
    assert.equal(has(41, api), false, name + ': unrelated process');
    assert.ok(calls.some(([kind]) => kind === 'windows'));
    if (rows.length > 1) assert.ok(calls.some(([kind]) => kind === 'children'));
  }
  assert.equal(has(41, packagedFixture([ordinary]).api), false);
}
test('real HasPackagedWindow walks top-level and hosted-child PIDs', () => scanContract(native('DriverInventory.cs')));
test('real scan refuses incomplete classification and bounds both enumerations', () => {
  const { has } = packagedSeams();
  assert.equal(has(41, packagedFixture([ordinary], { complete: false }).api), true);
  assert.equal(has(41, packagedFixture([ordinary, { id: 2, pid: 42 }]).api), true);
  assert.equal(has(41, packagedFixture([{ id: 2, pid: 42, className: 'ApplicationFrameWindow' }, { id: 3, parent: 2, pid: 0 }]).api), true);
  const rows = Array.from({ length: 16385 }, (_, i) => ({ ...ordinary, id: i + 1, pid: 42 }));
  const top = packagedFixture(rows);
  assert.equal(has(41, top.api), true);
  assert.equal(top.calls.filter(([kind]) => kind === 'class').length, 16384);
  const child = packagedFixture([{ id: 20000, pid: 52, className: 'ApplicationFrameWindow' }, ...rows.map(row => ({ ...row, parent: 20000 }))]);
  assert.equal(has(41, child.api), true);
  assert.equal(child.calls.filter(([kind]) => kind === 'pid').length, 16384);
});
for (const [name, before, after] of [
  ['CoreWindow PID omitted', 'if (package != 15700) result.Pids.Add(pid);', ''],
  ['hosted child PID omitted', 'else result.Pids.Add(childPid);', ''],
  ['host executable omitted', 'String.Equals(api.Executable(hwnd), "ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase)', 'false'],
]) test('scan behavior catches broken variant: ' + name, () => {
  const source = native('DriverInventory.cs'); assert.ok(source.includes(before));
  assert.throws(() => scanContract(source.replace(before, after)), assert.AssertionError);
});
test('scan bounds and incomplete classification have failing broken variants', () => {
  const source = native('DriverInventory.cs');
  for (const [before, after, fixture] of [
    ['return result.Incomplete || result.Pids.Contains(target);', 'return result.Pids.Contains(target);', packagedFixture([ordinary], { complete: false })],
    ['++count > 16384', 'false', packagedFixture(Array.from({ length: 16385 }, (_, i) => ({ ...ordinary, id: i + 1, pid: 42 })))],
  ]) {
    assert.ok(source.includes(before));
    assert.equal(packagedSeams(source.replaceAll(before, after)).has(41, fixture.api), false);
  }
});

function vanishedContract(source) {
  const { has } = packagedSeams(source);
  // Class lookup races a destroy after the first existence check.
  for (const child of [false, true]) {
    const fixture = packagedFixture([ordinary, { id: 2, pid: 52, className: 'ApplicationFrameWindow' },
      { id: 3, pid: child ? 0 : 42, ...child ? { parent: 2 } : {} }]);
    let checks = 0;
    const exists = fixture.api.Exists;
    fixture.api.Exists = id => id === 3 ? ++checks === 1 : exists(id);
    assert.equal(has(41, fixture.api), false, 'vanished ' + (child ? 'child' : 'top-level window'));
    assert.equal(checks, 2);
  }
  const stillLive = packagedFixture([ordinary, { id: 3, pid: 42 }]);
  assert.equal(has(41, stillLive.api), true, 'live unreadable class remains fail closed');
}
test('a window destroyed during classification cannot refuse an unrelated process', () => vanishedContract(native('DriverInventory.cs')));
function snapshotContract(source) {
  const seams = packagedSeams(source);
  const fixture = packagedFixture([ordinary, ...layouts[1][1]]);
  const scan = () => seams.scan(fixture.api);
  seams.snapshot(() => {
    for (let i = 0; i < 80; i++) {
      assert.equal(seams.has(41, fixture.api), false);
      assert.equal(seams.has(42, fixture.api), true);
    }
    seams.snapshot(() => assert.equal(seams.has(42, fixture.api), true), scan);
  }, scan);
  assert.equal(fixture.calls.filter(([kind]) => kind === 'windows').length, 1);
  assert.equal(fixture.calls.filter(([kind]) => kind === 'image').length, 1);
  assert.throws(() => seams.snapshot(() => { seams.has(42, fixture.api); throw Error('provider'); }, scan), /provider/);
  seams.snapshot(() => assert.equal(seams.has(42, fixture.api), true), scan);
  assert.equal(fixture.calls.filter(([kind]) => kind === 'windows').length, 3, 'normal and throwing scopes both clear the cache');
}
test('one call shares a scan, then clears it on return and exception', () => snapshotContract(native('DriverInventory.cs')));
for (const [name, contract, before, after] of [
  ['vanished class poisons every target', vanishedContract, 'if (api.Exists(hwnd)) result.Fail(name == null ? "frame-class" : "frame-pid");', 'result.Fail("frame-class");'],
  ['vanished child poisons every target', vanishedContract, 'if (api.Exists(child)) result.Fail("frame-child");', 'result.Fail("frame-child");'],
  ['lookup ignores snapshot', snapshotContract, 'packagedSnapshot == null ? ScanPackagedWindows(api) : packagedSnapshot.Value', 'ScanPackagedWindows(api)'],
  ['snapshot survives next call', snapshotContract, 'finally { packagedSnapshot = null; }', 'finally { }'],
]) test('snapshot behavior catches broken variant: ' + name, () => {
  const source = native('DriverInventory.cs'); assert.ok(source.includes(before));
  assert.throws(() => contract(source.replace(before, after)), assert.AssertionError);
});
test('native inventory and observation entry points scope the production snapshot', () => {
  const source = native('DriverInventory.cs');
  assert.match(source, /internal static WindowRecord Observe\(IntPtr hwnd\)\s*\{\s*return WithPackagedSnapshot/);
  assert.match(source, /internal static List<WindowRecord> Windows\(\)\s*\{\s*return WithPackagedSnapshot/);
});
function lazyContract(source) {
  const seams = packagedSeams(source); let scans = 0;
  assert.equal(seams.snapshot(() => 42, () => { scans++; return {}; }), 42);
  assert.equal(scans, 0, 'class-only refusal needs no process scan before its guard');
}
test('a class-only packaged refusal can complete without scanning processes', () => lazyContract(native('DriverInventory.cs')));
test('lazy guard ordering catches an eager scan broken variant', () => {
  const source = native('DriverInventory.cs');
  const before = 'packagedSnapshot = new Lazy<PackagedProcesses>(scan);'; assert.ok(source.includes(before));
  assert.throws(() => lazyContract(source.replace(before, 'packagedSnapshot = scan();')), assert.AssertionError);
});


function mixedCaseScan(source) {
  const { has } = packagedSeams(source);
  for (const className of ['windows.ui.core.corewindow', 'WINDOWS.UI.CORE.COREWINDOW', 'applicationframewindow', 'APPLICATIONFRAMEWINDOW']) {
    const core = className.toLowerCase().includes('corewindow');
    const rows = core ? [{ id: 2, pid: 42, className }] : [{ id: 2, pid: 52, className }, { id: 3, parent: 2, pid: 42 }];
    assert.equal(has(42, packagedFixture([ordinary, ...rows]).api), true, className);
  }
}
test('packaged process scan recognizes frame and core classes in every casing', () => mixedCaseScan(native('DriverInventory.cs')));
test('case-sensitive-class-scan broken variant fails', () =>
  assert.throws(() => mixedCaseScan(native('DriverInventory.cs').replaceAll('StringComparison.OrdinalIgnoreCase', 'StringComparison.Ordinal')), assert.AssertionError));

test('incomplete scan names its first failed step without identifying a window', () => {
  const { scan, has } = packagedSeams();
  for (const [rows, options, expected] of [
    [[ordinary], { complete: false }, 'frame-scan'],
    [[ordinary, { id: 2, pid: 42 }], {}, 'frame-class'],
    [[ordinary, { id: 2, pid: 0, className: 'Other' }], {}, 'frame-pid'],
    [[ordinary, { id: 2, pid: 52, className: 'ApplicationFrameWindow' }, { id: 3, parent: 2, pid: 0 }], {}, 'frame-child'],
    [Array.from({ length: 16385 }, (_, i) => ({ ...ordinary, id: i + 1 })), {}, 'frame-limit'],
  ]) {
    const result = scan(packagedFixture(rows, options).api);
    assert.equal(result.Incomplete, true); assert.equal(result.FailureStep, expected);
    assert.equal(has(41, packagedFixture(rows, options).api), true, 'unproved Explorer stays refused');
  }
  const explorer = { id: 4, pid: 44, className: 'CabinetWClass', image: 'explorer.exe' };
  const clean = scan(packagedFixture([explorer, ...layouts[1][1]]).api);
  assert.equal(clean.Incomplete, false); assert.equal(clean.Pids.Contains(44), false);
});

function corePackageContract(source, status, expected, frame = false) {
  const seams = packagedSeams(source);
  const rows = frame
    ? [{ id: 1, pid: 52, className: 'ApplicationFrameWindow', packageStatus: 15700 },
      { id: 2, parent: 1, pid: 42, className: 'OrdinaryWindow', packageStatus: 15700 }]
    : [{ id: 1, pid: 42, className: status === 15700 ? 'CabinetWClass' : 'Calculator',
      image: status === 15700 ? 'explorer.exe' : 'CalculatorApp.exe', packageStatus: status },
    { id: 2, pid: 42, className: 'Windows.UI.Core.CoreWindow', visible: false, packageStatus: status }];
  const fixture = packagedFixture(rows);
  const scan = seams.scan(fixture.api);
  assert.equal(scan.Pids.Contains(42), expected);
  assert.equal(seams.has(42, fixture.api), expected);
  if (status !== 122 && status !== 15700 && !frame) {
    assert.equal(scan.PackageUnproved.Contains(42), true);
  } else assert.equal(scan.PackageUnproved.Contains(42), false);
  assert.equal(scan.Incomplete, false);
  if (frame) assert.equal(fixture.calls.filter(([kind]) => kind === 'package').length, 0);
  else assert.ok(fixture.calls.some(([kind, pid]) => kind === 'package' && pid === 42));
}
for (const [name, status, expected, frame, before, after] of [
  ['unpackaged Explorer hidden CoreWindow is admitted', 15700, false, false,
    'if (package != 15700) result.Pids.Add(pid);', 'result.Pids.Add(pid);'],
  ['packaged Calculator hidden CoreWindow refuses', 122, true, false,
    'if (package != 15700) result.Pids.Add(pid);', ''],
  ['OpenProcess failure refuses with frame-package', -1, true, false,
    'if (package != 15700 && package != 122) result.PackageUnproved.Add(pid);', ''],
  ['ApplicationFrameHost child stays refused without a package', 15700, true, true,
    'else result.Pids.Add(childPid);', ''],
]) {
  const source = native('DriverInventory.cs');
  test(name, () => corePackageContract(source, status, expected, frame));
  test(name + ' catches broken variant', () => {
    assert.ok(source.includes(before));
    assert.throws(() => corePackageContract(source.replace(before, after), status, expected, frame), assert.AssertionError);
  });
}
test('every unexpected package result refuses only its PID and an incomplete scan retains its step', () => {
  for (const status of [0, 5, 87, 123, 15701]) corePackageContract(native('DriverInventory.cs'), status, true);
  const { scan } = packagedSeams();
  const rows = [ordinary, { id: 2, pid: 42, className: 'Windows.UI.Core.CoreWindow', packageStatus: -1 }];
  const result = scan(packagedFixture(rows, { complete: false }).api);
  assert.equal(result.FailureStep, 'frame-scan');
  assert.equal(result.PackageUnproved.Contains(42), true);
  assert.equal(packagedSeams().has(41, packagedFixture(rows).api), false);
});
test('native package probe uses query-only access and closes the process on every opened path', () => {
  const source = native('DriverInventory.cs');
  assert.match(source, /PackageStatus = ProcessPackageStatus/);
  assert.match(source, /static int ProcessPackageStatus\(uint pid\)\s*\{\s*IntPtr process = OpenProcess\(0x1000, false, pid\);\s*if \(process == IntPtr.Zero\) return -1;/);
  assert.match(source, /return GetPackageFullName\(process, ref length, null\);\s*\} catch \{ return -1; \}\s*finally \{ CloseHandle\(process\); \}/);
});
