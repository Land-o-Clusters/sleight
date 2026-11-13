import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { body, native } from './fixtures/windows-review-seams.mjs';
import { createWindowsSafety } from '../plugins/sleight/lib/driver-safety.mjs';
import { formatWindowsDriverError } from '../plugins/sleight/lib/windows-driver/errors.mjs';

const empty = '00000000-0000-0000-0000-000000000000';
const desktop = '11111111-2222-3333-4444-555555555555';
function desktopRead(source = native('DriverInventory.cs')) {
  const code = body(source, 'internal static void ReadDesktop(WindowRecord row, DesktopSight sight)')
    .replace(/\b(?:string|Guid|var|IntPtr) (\w+)\s*=/g, 'let $1 =')
    .replace(/for \(int /g, 'for (let ')
    .replace(/new HashSet<IntPtr>\(\)/g, 'new Seen()')
    .replace('catch {', 'catch (error) {')
    .replace('id.ToString("D")', 'id');
  return runInNewContext(`(row, sight) => { ${code} }`, {
    Guid: { Empty: empty }, IntPtr: { Zero: 0 }, DriverFault: Error,
    Seen: class extends Set { Add(value) { const added = !this.has(value); this.add(value); return added; } },
  });
}
function fixture(overrides = {}) {
  const rows = new Map([
    [1, { owner: 2, current: true, id: empty, pid: 41 }],
    [2, { owner: 0, current: true, id: desktop, pid: 41 }],
  ]);
  const calls = [];
  const sight = Object.fromEntries(Object.entries({ Current: 'current', Id: 'id', Owner: 'owner', Pid: 'pid' })
    .map(([method, key]) => [method, hwnd => { calls.push([method, hwnd]); return rows.get(hwnd)?.[key]; }]));
  sight.Exists = hwnd => rows.has(hwnd);
  return { rows, calls, sight, window: { Handle: 1, Owner: 2, Pid: 41, Popup: true, ...overrides } };
}
function popupContract(source) {
  const f = fixture(); desktopRead(source)(f.window, f.sight);
  assert.equal(f.window.DesktopId, desktop); assert.equal(f.window.OnCurrentDesktop, true);
  assert.deepEqual(f.calls.filter(([method]) => method === 'Id'), [['Id', 1], ['Id', 2]]);
  const nested = fixture(); nested.rows.get(2).id = empty; nested.rows.get(2).owner = 3;
  nested.rows.set(3, { owner: 0, current: true, id: desktop, pid: 41 });
  desktopRead(source)(nested.window, nested.sight);
  assert.equal(nested.window.DesktopId, desktop);
}
test('owned current-desktop popup inherits a proved same-process owner desktop', () => popupContract(native('DriverInventory.cs')));
test('an existing desktop id is retained without reading the owner', () => {
  const f = fixture(); f.rows.get(1).id = desktop; f.rows.get(2).current = false;
  desktopRead()(f.window, f.sight); assert.equal(f.window.DesktopId, desktop);
  assert.ok(f.calls.every(([, hwnd]) => hwnd === 1));
});
for (const [label, mutate] of [
  ['different process', f => { f.rows.get(2).pid = 42; }],
  ['other desktop owner', f => { f.rows.get(2).current = false; }],
  ['unknown desktop owner', f => { f.rows.get(2).current = null; }],
  ['destroyed owner', f => { f.rows.delete(2); }],
  ['changed owner', f => { f.rows.get(1).owner = 3; }],
  ['owner cycle', f => { f.rows.get(2).id = empty; f.rows.get(2).owner = 1; }],
  ['owner has empty desktop', f => { f.rows.get(2).id = empty; }],
  ['other desktop popup', f => { f.rows.get(1).current = false; }],
  ['unowned popup', f => { f.window.Owner = 0; }],
  ['ordinary window', f => { f.window.Popup = false; }],
  ['provider exception', f => { f.sight.Id = () => { throw Error('private provider detail'); }; }],
  ['owner chain limit', f => {
    for (let i = 2; i <= 66; i++) f.rows.set(i, { owner: i + 1, current: true, id: i === 66 ? desktop : empty, pid: 41 });
  }],
]) test('empty GUID stays unreadable: ' + label, () => {
  const f = fixture(); mutate(f); desktopRead()(f.window, f.sight);
  assert.equal(f.window.DesktopId, null); assert.equal(f.window.OnCurrentDesktop, null);
  assert.ok(['desktop', 'desktop-owner'].includes(f.window.RefusalStep));
  assert.doesNotMatch(JSON.stringify(f.window), /private provider detail/);
});
for (const [label, before, after] of [
  ['fallback removed', 'if (id == Guid.Empty && row.OnCurrentDesktop == true && row.Popup && row.Owner != IntPtr.Zero)', 'if (false)'],
  ['empty GUID accepted', 'if (id == Guid.Empty) throw new DriverFault("TARGET_UNAVAILABLE");', ''],
  ['owner process ignored', 'sight.Pid(owner) != row.Pid', 'false'],
  ['owner desktop ignored', '!sight.Current(owner)', 'false'],
]) test('popup assertions detect broken variant: ' + label, () => {
  const source = native('DriverInventory.cs'); assert.ok(source.includes(before));
  const broken = source.replace(before, after);
  if (label === 'fallback removed') assert.throws(() => popupContract(broken), assert.AssertionError);
  else {
    const f = fixture(); f.rows.get(2).id = label === 'empty GUID accepted' ? empty : desktop;
    if (label === 'owner process ignored') f.rows.get(2).pid = 42;
    if (label === 'owner desktop ignored') f.rows.get(2).current = false;
    desktopRead(broken)(f.window, f.sight);
    assert.notEqual(f.window.DesktopId, null, 'the broken variant wrongly admits the popup');
  }
});

for (const [code, step] of [['TARGET_UNAVAILABLE', 'integrity'], ['HOSTED_APP_UNRESOLVED', 'frame-class'],
  ['HOSTED_APP_UNRESOLVED', 'frame-package']]) test('parent carries ' + code + ' ' + step + ' failure step to the error', async t => {
  const window = { windowId: '101', pid: 41, processStart: '134059077770000001', integrity: 'medium',
    image: 'C:\\Apps\\explorer.exe', app: 'explorer', refused: code, refusalStep: step };
  const calls = [];
  const safety = createWindowsSafety({ driver: { async request(method) { calls.push(method); return { windows: [window] }; } },
    approve: () => assert.fail('approval'), lease: { acquire: () => assert.fail('lease'), close() {} } });
  t.after(() => safety.close());
  if (code === 'HOSTED_APP_UNRESOLVED')
    window.hostedSelectorHashes = [createHash('sha256').update('folder fixture').digest('hex')];
  for (const selector of [{ windowId: '101' }, ...code === 'HOSTED_APP_UNRESOLVED' ? ['folder fixture'] : []]) {
    await assert.rejects(safety.request('getApp', { selector }), error => {
      assert.equal(error.code, code); assert.ok(error.message.includes('step=' + window.refusalStep));
      assert.ok(formatWindowsDriverError(error).includes('step=' + window.refusalStep)); return true;
    });
  }
  assert.ok(calls.every(method => method === 'getState'));
});

test('native metadata probes mark process, image, integrity, catalog and desktop failures', () => {
  const inventory = native('DriverInventory.cs');
  const observe = body(inventory, 'static WindowRecord Observe(IntPtr hwnd, bool hosted)');
  for (const [step, call] of [['birth', 'GetProcessTimes(process'], ['image', 'QueryFullProcessImageNameW(process'],
    ['session', 'ProcessIdToSessionId(pid'], ['version', 'FileVersionInfo.GetVersionInfo(row.Image)'],
    ['integrity', 'uint ownIntegrity'], ['image', 'var executable = new FileInfo(row.Image)']])
    assert.ok(observe.lastIndexOf('row.RefusalStep = "' + step + '";', observe.indexOf(call)) >= 0, step);
  assert.ok(observe.indexOf('if (RefusePackaged') < observe.indexOf('OpenProcess('));
  assert.match(observe, /row.RefusalStep = packagedSnapshot.Value.FailureStep \?\? "frame-scan"/);
  assert.match(observe, /packagedSnapshot.Value.PackageUnproved.Contains\(pid\)\)\s*row.RefusalStep = "frame-package"/);
  assert.match(inventory, /candidate.RefusalStep = error.Step/);
  assert.match(inventory, /result\["refusalStep"\] = step/);
  const policy = body(native('DriverIdentity.cs'), 'internal static void ApplyPolicy(');
  assert.ok(policy.indexOf('window.RefusalStep = "catalog"') < policy.indexOf('var catalog = Catalog'));
});
