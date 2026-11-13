import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsDriverSources } from '../plugins/sleight/lib/direct-browser/windows-host.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const native = new URL('../plugins/sleight/lib/direct-browser/native/win/', import.meta.url);
const variants = [
  ['INT23D-topology-write', 'DriverInventory.cs', 'known.Value = ++next;', 'known.Value = ++next; DriverInput.Post(null, hwnd, 0x102, 0, IntPtr.Zero);'],
  ['INT23D-helper-write', 'DriverInventory.cs', 'internal WindowRecord Copy() {', 'internal WindowRecord Copy() { DriverInput.Post(this, Handle, 0x102, 0, IntPtr.Zero);'],
  ['INT23L-uia-write', 'DriverInventory.cs', 'known.Value = ++next;', 'known.Value = ++next; ((IInvoke)null).Invoke();'],
  ['INT23H-unlisted-import', 'DriverInventory.cs', 'known.Value = ++next;', 'known.Value = ++next; DriverInput.SetCursorPos(0, 0);',
    'DriverInput.cs', 'static extern bool PostMessageW(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam);',
    'static extern bool PostMessageW(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam);\n    [DllImport("user32.dll")] internal static extern bool SetCursorPos(int x, int y);'],
  ['INT23B-inventory-write', 'DriverInventory.cs', 'var candidate = metadata(hwnd);',
    'var candidate = metadata(hwnd); DriverInput.Post(candidate, hwnd, 0x102, 0, IntPtr.Zero);'],
  ['INT23B-foreign-child', 'DriverInventory.cs', 'if (!(retained || descendant(root, hwnd))) continue;',
    'if (!(pid == known.Pid && (retained || descendant(root, hwnd)) || pid == 0 && kind == 0x8001 && retained)) continue;'],
  ['INT23B-overflow-global', 'DriverInventory.cs', 'if (known.Members.Count > 4096) { known.Unavailable = true; known.Members = new HashSet<IntPtr>(); }',
    'if (known.Members.Count > 4096) { roots.Remove(root); throw new DriverFault("TARGET_UNAVAILABLE"); }'],
  ['H4-name-includes-popup', 'DriverInventory.cs', 'w.Refused == null && !w.Popup && new[]', 'w.Refused == null && new[]'],
  ['H4-topology-scope', 'DriverInventory.cs', 'if (!(retained || descendant(root, hwnd))) continue;', ''],
  ['H4-destroy-prune', 'DriverInventory.cs', 'if (hwnd == root) roots.Remove(root);', ''],
  ['H4-post-final-person', 'DriverInput.cs', 'if (!cleanup) api.Person(window);', ''],
  ['H4-effect-person-order', 'DriverActions.cs', 'observe();\n        person();', 'person();\n        observe();'],
  ['B1-frame-policy', 'DriverInventory.cs', 'String.Equals(window.ClassName, "ApplicationFrameWindow", StringComparison.OrdinalIgnoreCase) && (!PackagedFramesOpen() || window.CoreHandle == IntPtr.Zero)', 'false'],
  ['B3-native-read-entry', 'DriverInventory.cs', 'return DriverIdentity.Verify(admitted, observe(hwnd));', 'return observe(hwnd);'],
  ['H4-thread-birth-proof', 'DriverInventory.cs', 'ThreadBirth + ":" + ClassAtom', '0 + ":" + ClassAtom'],
  ['B3-ignore-topology-events', 'DriverInventory.cs', 'known.Value = ++next;', 'known.Value = known.Value;'],
  ['B3-ignore-client-topology', 'DriverInventory.cs', 'objectId != 0 && objectId != -4', 'objectId != 0'],
  ['B3-drop-grandchildren', 'DriverInventory.cs', 'parents.Push(child);', ''],
  ['B3-accept-incomplete-topology', 'DriverInventory.cs', 'if (!enumerated.SetEquals(walked)) throw new DriverFault("TARGET_UNAVAILABLE", "window topology enumeration is incomplete");', ''],
  ['B3-skip-native-final-lifetime', 'DriverInventory.cs', 'if (!before.SequenceEqual(lifetime(hwnd))) throw new DriverFault("IDENTITY_CHANGED");', ''],
  ['B3-mutable-admission', 'DriverInventory.cs', 'var admitted = window.Copy();', 'var admitted = window;'],
  ['B3-revive-revoked-map', 'DriverInventory.cs', '(BindingId == null || other.BindingId == null || BindingId == other.BindingId)', 'true'],
  ['B3-skip-post-identity', 'DriverInput.cs', 'internal static bool InputEffect(Action identity, Func<bool> post)\n    {\n        identity();', 'internal static bool InputEffect(Action identity, Func<bool> post)\n    {'],
  ...['Pid', 'ProcessStart', 'ThreadId', 'FrameThreadId', 'WindowGeneration', 'TopologyGeneration'].map(field =>
    ['B3-ignore-' + field, 'DriverInventory.cs', field + ' == other.' + field + ' && ', '']),
  ['B4-effect-boundary', 'DriverActions.cs', 'checkpoint();\n        DriverOperationCounters.Mark(DriverOperationCounters.Kind.PatternCall);\n        effect();', 'DriverOperationCounters.Mark(DriverOperationCounters.Kind.PatternCall);\n        effect();'],
  ['B4-expansion-state-boundary', 'DriverActions.cs', 'int state = readState();\n        checkpoint();', 'int state = readState();'],
  ['B5-ignore-desktop', 'DriverInventory.cs', 'DesktopId == other.DesktopId && ', ''],
  ['B5-ignore-membership', 'DriverInventory.cs', 'OnCurrentDesktop == other.OnCurrentDesktop &&', ''],
  ['B5-allow-unknown-membership', 'DriverInventory.cs', '!OnCurrentDesktop.HasValue || ', ''],
  ['B6-first-window', 'DriverInventory.cs', 'if (matches.Count != 1) throw new DriverFault("AMBIGUOUS_APP");', ''],
  ['B6-ownerless-menu', 'DriverInventory.cs', 'return false;\n    }\n    internal static object State', 'return popup.ClassName == "#32768" && popup.Owner == IntPtr.Zero;\n    }\n    internal static object State'],
  ['B7-root-surface', 'DriverInput.cs', 'if (surface.Right <= surface.Left || surface.Bottom <= surface.Top || point.X < surface.Left || point.Y < surface.Top ||\n            point.X >= surface.Right || point.Y >= surface.Bottom)', 'if (false)'],
  ['B7-final-geometry', 'DriverInput.cs', 'RequireInside(point(), surface());', ''],
  ['B7-post-time-identity', 'DriverInput.cs', 'RequireInside(physical, surface());\n        identity();', 'RequireInside(physical, surface());'],
  ['B1-host-elevation', 'DriverInventory.cs', 'return PackagedFramesOpen() && String.Equals(row.ClassName, "ApplicationFrameWindow", StringComparison.OrdinalIgnoreCase);', 'return false;'],
  ['B1-non-system-host', 'DriverInventory.cs', '!SystemFrameHost(frame.Image, sight.SystemDirectory)', 'false'],
  ['B1-gate-ignored', 'DriverIdentity.cs', '!(window.CoreHandle != IntPtr.Zero && DriverInventory.PackagedFramesOpen())', '!(window.CoreHandle != IntPtr.Zero)'],
  ['B2-raw-host-pid', 'DriverInput.cs', 'if (!app.HasValue) return rawPid;\n        if (app.Value == 0 && (target == null || target.CoreHandle == IntPtr.Zero)) return rawPid;\n        return app.Value;', 'return rawPid;'],
  ['B2-unresolved-pid0', 'DriverInput.cs', 'if (app.Value == 0 && (target == null || target.CoreHandle == IntPtr.Zero)) return rawPid;\n        return app.Value;', 'return app.Value;'],
  ['B2-unresolved-frame-null', 'DriverInventory.cs', 'if (found == null || found.Count != 1) return 0;', 'if (found == null || found.Count != 1) return null;'],
  ['B2-require-owned-pid', 'DriverInput.cs', 'pid == 0 || pid != window.Pid || hwnd != window.InputRoot && !child', 'pid == 0 || hwnd != window.InputRoot && !child'],
  ['B3-skip-recount', 'DriverInventory.cs', 'if (recount == null || recount.Count != 1 || recount[0] != core) return frame;', 'if (false) return frame;'],
  ['B6-packaged-popup', 'DriverInventory.cs', 'if (window.CoreHandle != IntPtr.Zero) return false;\n        if (!popup.Popup', 'if (false) return false;\n        if (!popup.Popup'],
  ['B7-drag-commit', 'DriverInput.cs', 'Post(window, hwnd, 0x200, 1, packed);\n                last = packed;', 'last = packed;\n                Post(window, hwnd, 0x200, 1, packed);'],
];

function variantPatches(variant) {
  const patches = [[variant[1], variant[2], variant[3]]];
  if (variant.length > 4) patches.push([variant[4], variant[5], variant[6]]);
  return patches;
}
test('UC3H4 native mutant anchors match LF and CRLF source', () => {
  for (const variant of variants) for (const [file, before] of variantPatches(variant)) {
    const original = readFileSync(new URL(file, native), 'utf8');
    for (const source of [original, original.replace(/\r?\n/g, '\r\n')])
      assert.ok(source.replace(/\r\n/g, '\n').includes(before), 'mutation anchor: ' + variant[0] + ' ' + file);
  }
});

function assertInventoryRecorder(source) {
  const start = source.indexOf('Case("H4 Observe inventory reads unselected root without effects"');
  const end = source.indexOf('Case("H4 Observe exposes', start);
  const row = source.slice(start, end);
  assert.match(row, /var writes = InventoryEffectAudit.Collect\(\)/);
  assert.ok(row.indexOf('Check(writes.Count == 0)') < row.indexOf('DriverInventory.Observe('));
  assert.match(row, /reads.Add\(w\); return Life\(\)/);
  assert.match(row, /reads.Count > 0 && writes.Count == 0/);
  const main = source.slice(source.indexOf('public static int Main()'));
  assert.ok(main.indexOf('InventoryEffectAudit.Collect()') < main.indexOf('Lifecycle()'));
}
test('native inventory audit is wired before observation and a vacuous recorder variant fails', () => {
  const source = readFileSync(new URL('./fixtures/windows-driver-confinement-checks.cs', import.meta.url), 'utf8');
  assertInventoryRecorder(source);
  assert.throws(() => assertInventoryRecorder(source.replaceAll('InventoryEffectAudit.Collect()', 'new List<IntPtr>()')), assert.AssertionError);
});

test('UC3H4 production native resolver, read and dispatch seams run without UIA or native calls', {
  skip: process.platform !== 'win32' ? 'requires Windows C# 5; scripted proof, no windows or input' : false,
}, t => {
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-confinement-native-'))));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const framework = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
  const names = windowsDriverSources.filter(name => name.endsWith('.cs') && name !== 'Program.cs');
  function buildAndRun(variant) {
    const binary = join(root, 'confinement-' + (variant?.[0] ?? 'baseline') + '.exe');
    const patches = variant ? variantPatches(variant) : [];
    const sources = names.map(name => {
      const path = fileURLToPath(new URL(name, native));
      const patch = patches.find(item => item[0] === name);
      if (!patch) return path;
      const source = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
      assert.ok(source.includes(patch[1]), 'mutation anchor: ' + variant[0]);
      const changed = join(root, name); writeFileSync(changed, source.replace(patch[1], patch[2])); return changed;
    });
    const built = spawnSync(join(framework, 'csc.exe'), ['/nologo', '/noconfig', '/langversion:5', '/define:SLEIGHT_TEST_SEAMS', '/target:exe',
      '/main:Sleight.Driver.DriverConfinementChecks', '/out:' + binary,
      ...['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll'].map(name => '/r:' + join(framework, name)),
      ...sources, fileURLToPath(new URL('./fixtures/windows-driver-confinement-checks.cs', import.meta.url)),
      fileURLToPath(new URL('./fixtures/windows-inventory-effects.cs', import.meta.url))],
    { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true, killSignal: 'SIGKILL' });
    assertChildStatus(built, 0, built.stdout + built.stderr);
    const result = spawnSync(binary, [], { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true, killSignal: 'SIGKILL' });
    assertChildStatus(result, variant ? 1 : 0, result.stdout + result.stderr);
    const checks = JSON.parse(result.stdout);
    assert.equal(checks.drawing, false); assert.equal(checks.nativeCalls, 0);
    assert.equal(checks.auditNamespace, 'Sleight.Driver');
    assert.equal(checks.auditInputNamespace, 'Sleight.Driver');
    assert.equal(checks.auditUiaNamespace, 'Sleight.Driver');
    assert.ok(Array.isArray(checks.auditWriteLines));
    if (!variant) {
      assert.equal(checks.auditWrites, 0); assert.deepEqual(checks.auditWriteLines, []);
      assert.equal(checks.failed, 0); assert.equal(checks.passed, 101);
    } else if (variant[0] === 'INT23H-unlisted-import') {
      assert.equal(checks.auditWrites, 1, JSON.stringify(checks.auditWriteLines));
      assert.equal(checks.auditWriteLines.length, 1);
      assert.match(checks.auditWriteLines[0], /DriverInput\.SetCursorPos$/);
      assert.equal(checks.failed, 1);
    } else if (String(variant[0]).startsWith('INT23D-')) {
      assert.equal(checks.auditWrites, 42, JSON.stringify(checks.auditWriteLines));
      assert.ok(checks.auditWriteLines.some(line => line.includes('PostMessageW')), JSON.stringify(checks.auditWriteLines));
      assert.equal(checks.failed, 1);
    } else { assert.ok(checks.failed > 0); t.diagnostic(variant[0] + ': exit 1, failed cases=' + checks.failed); }
  }
  buildAndRun();
  for (const variant of variants) buildAndRun(variant);
});


function auditCoverage(source) {
  for (const name of ['DriverInventory', 'DriverBindings', 'DriverWindowLife', 'DriverTopology', 'DriverTopologyEpoch', 'WindowRecord'])
    assert.ok(source.includes(`typeof(${name})`), 'compiled audit root: ' + name);
  assert.match(source, /called\.Module\.Assembly == typeof\(DriverInventory\)\.Assembly/);
  assert.match(source, /called\.DeclaringType\.Namespace == typeof\(DriverInventory\)\.Namespace/);
  assert.doesNotMatch(source, /Namespace == "Sleight\.Driver"/);
  assert.match(source, /if \(intoDriverInput \|\|/, 'every DriverInput call must remain a write');
  assert.match(source, /if \(intoDriverInput \|\| intoDriverUiaWrite \|\|/, 'every UIA pattern write must remain a write');
  assert.match(source, /pending\.Enqueue\(called\)/, 'called project helpers must join the IL traversal');
  assert.match(source, /visited\.Add\(method\)/, 'helper recursion must be bounded');
}
test('compiled inventory audit includes topology and recursively follows helper calls', () => {
  const source = readFileSync(new URL('./fixtures/windows-inventory-effects.cs', import.meta.url), 'utf8');
  for (const name of ['DriverInventory.cs', 'DriverInput.cs', 'DriverActions.cs'])
    assert.match(readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/' + name, import.meta.url), 'utf8'), /^namespace Sleight\.Driver\b/m, name);
  auditCoverage(source);
  for (const name of ['DriverTopology', 'DriverTopologyEpoch', 'WindowRecord'])
    assert.throws(() => auditCoverage(source.replaceAll(`typeof(${name})`, 'typeof(DriverInventory)')), assert.AssertionError, 'audit-omits-' + name);
  assert.throws(() => auditCoverage(source.replace('pending.Enqueue(called);', '')), assert.AssertionError, 'audit-skips-helper-call');
  assert.throws(() => auditCoverage(source.replace('intoDriverInput ||', '')), assert.AssertionError, 'audit-drops-DriverInput-blanket');
  assert.throws(() => auditCoverage(source.replace('intoDriverUiaWrite ||', '')), assert.AssertionError, 'audit-drops-DriverUia-write');
  assert.throws(() => auditCoverage(source.replace(
    'called.DeclaringType.Namespace == typeof(DriverInventory).Namespace',
    'called.DeclaringType.Namespace == "Sleight.Cursor"')), assert.AssertionError, 'audit-wrong-namespace');
});

function assertAuditReceipts(fixture) {
  for (const name of ['baseline', 'INT23D-topology-write', 'INT23D-helper-write', 'INT23H-unlisted-import']) {
    const row = fixture[name];
    assert.equal(row.drawing, false, name);
    assert.equal(row.nativeCalls, 0, name);
    assert.equal(row.auditNamespace, 'Sleight.Driver', name);
    assert.equal(row.auditInputNamespace, 'Sleight.Driver', name);
    assert.equal(row.auditUiaNamespace, 'Sleight.Driver', name);
    assert.equal(row.auditWriteLines.length, row.auditWrites, name);
  }
  assert.equal(fixture.baseline.auditWrites, 0);
  assert.deepEqual(fixture.baseline.auditWriteLines, []);
  assert.equal(fixture.baseline.passed, 65);
  assert.equal(fixture.baseline.failed, 0);
  for (const name of ['INT23D-topology-write', 'INT23D-helper-write']) {
    assert.equal(fixture[name].auditWrites, 39, name);
    assert.ok(fixture[name].auditWriteLines.some(line => line.includes('PostMessageW')), name);
    assert.equal(fixture[name].failed, 1, name);
  }
  assert.match(fixture['INT23D-topology-write'].auditWriteLines[0], /DriverTopologyEpoch\.Record -> Sleight\.Driver\.DriverInput\.Post$/);
  assert.match(fixture['INT23D-helper-write'].auditWriteLines[0], /WindowRecord\.Copy -> Sleight\.Driver\.DriverInput\.Post$/);
  const unlisted = fixture['INT23H-unlisted-import'];
  assert.equal(unlisted.auditWrites, 1);
  assert.equal(unlisted.failed, 1);
  assert.match(unlisted.auditWriteLines[0], /DriverInput\.SetCursorPos$/);
}
function assertUiaReceipts(fixture) {
  for (const name of ['baseline', 'INT23L-uia-write']) {
    const row = fixture[name];
    assert.equal(row.drawing, false, name);
    assert.equal(row.nativeCalls, 0, name);
    assert.equal(row.auditNamespace, 'Sleight.Driver', name);
    assert.equal(row.auditInputNamespace, 'Sleight.Driver', name);
    assert.equal(row.auditUiaNamespace, 'Sleight.Driver', name);
    assert.equal(row.auditWriteLines.length, row.auditWrites, name);
  }
  assert.equal(fixture.baseline.auditWrites, 0);
  assert.deepEqual(fixture.baseline.auditWriteLines, []);
  assert.equal(fixture.baseline.passed, 65);
  assert.equal(fixture.baseline.failed, 0);
  assert.equal(fixture.baseline.cases, 65);
  const write = fixture['INT23L-uia-write'];
  assert.equal(write.passed, 0);
  assert.equal(write.failed, 1);
  assert.equal(write.cases, 1);
  assert.equal(write.auditWrites, 1);
  assert.match(write.auditWriteLines[0], /DriverTopologyEpoch\.Record -> Sleight\.Driver\.IInvoke\.Invoke$/);
}
test('recorded guest receipts report an inventory UIA Invoke write', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/int23l-audit-receipts.json', import.meta.url), 'utf8'));
  assertUiaReceipts(fixture);
  const broken = JSON.parse(JSON.stringify(fixture));
  broken['INT23L-uia-write'] = { ...broken['INT23L-uia-write'], auditWrites: 0, auditWriteLines: [], failed: 0 };
  assert.throws(() => assertUiaReceipts(broken), assert.AssertionError, 'uia write missed');
});
test('recorded guest receipts expose audit writes, namespaces and write lines', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/int23h-audit-receipts.json', import.meta.url), 'utf8'));
  assertAuditReceipts(fixture);
  const broken = JSON.parse(JSON.stringify(fixture));
  broken['INT23H-unlisted-import'] = { ...broken['INT23H-unlisted-import'], auditWrites: 0, auditWriteLines: [] };
  assert.throws(() => assertAuditReceipts(broken), assert.AssertionError, 'unlisted import missed');
});
