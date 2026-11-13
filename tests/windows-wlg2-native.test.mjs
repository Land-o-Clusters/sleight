import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { body } from './fixtures/windows-review-seams.mjs';

// Replace only external dependencies in copied sources. The production Check,
// Focus, Track and OnEvent bodies (including their counters branches) execute.
function headless(sources) {
  const inventory = sources['DriverInventory.cs'];
  return {
    ...sources,
    'DriverInput.cs': sources['DriverInput.cs']
      .replaceAll('GetWindowThreadProcessId(hwnd, out pid);', 'LifecycleReviewChecks.Thread(hwnd, out pid);')
      .replaceAll('GetWindowThreadProcessId(window.InputRoot, out pid);', 'LifecycleReviewChecks.Thread(window.InputRoot, out pid);')
      .replace('thread == 0 ? 0 : pid, IsChild, handle => DriverInventory.Observe(handle)',
        'thread == 0 ? 0 : pid, LifecycleReviewChecks.Child, handle => LifecycleReviewChecks.Observe(handle)')
      .replace('GetGUIThreadInfo(thread, ref info)', 'LifecycleReviewChecks.Gui(ref info.Focus)'),
    'DriverInventory.cs': inventory.replace(body(inventory, 'internal DriverTopology()'), '\n        callback = OnEvent; pump = null;\n')
      .replace('GetWindowThreadProcessId(hwnd, out pid);\n            List<Tuple', 'LifecycleReviewChecks.Thread(hwnd, out pid);\n            List<Tuple')
      .replace('pid, IsChild, DriverInventory.Bindings.Revoke,', 'pid, LifecycleReviewChecks.Child, DriverInventory.Bindings.Revoke,')
      .replace('GetClassNameW(hwnd, name, name.Capacity)', 'LifecycleReviewChecks.ClassName(name)')
      .replace('epoch.Prune(IsWindow);', 'epoch.Prune(LifecycleReviewChecks.Exists);')
      .replace('!IsWindow(old)', '!LifecycleReviewChecks.Exists(old)')
      .replace('current = GetParent(current);', 'current = LifecycleReviewChecks.Parent(current);')
      .replace('if (diagnostics.Count < 4096) diagnostics.Add(root, new DriverLifecycleRing(incarnation));',
        'if (LifecycleReviewChecks.ThrowDiagnostic) throw new Exception("diagnostic allocation");\n' +
        '                    if (diagnostics.Count < 4096) diagnostics.Add(root, new DriverLifecycleRing(incarnation));'),
  };
}

test('C# 5 lifecycle creation, revoke order and counters parity run headlessly with broken variants', {
  skip: process.platform !== 'win32' ? 'requires Windows csc.exe; synthetic metadata, draws nothing' : false,
}, t => {
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'wlg2-native-'))));
  t.after(() => removeTemp(root));
  const framework = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
  const native = new URL('../plugins/sleight/lib/direct-browser/native/win/', import.meta.url);
  const names = ['Driver.cs', 'DriverInventory.cs', 'DriverCapture.cs', 'DriverIdentity.cs', 'DriverUia.cs', 'DriverActions.cs',
    'DriverActionPlan.cs', 'DriverInput.cs', 'DriverHook.cs', 'DriverPatterns.cs', 'DriverSettle.cs', 'DriverClipboard.cs'];
  const originals = Object.fromEntries(['DriverInventory.cs', 'DriverInput.cs'].map(name =>
    [name, readFileSync(new URL(name, native), 'utf8').replace(/\r\n/g, '\n')]));
  const recording = 'try { if (advance != null) advance(root, known.Value, retained); } catch { }';
  for (const [name, mutate] of [
    ['pristine-compile', sources => sources],
    ['baseline', sources => sources],
    ['missing-fresh-root', sources => ({ ...sources, 'DriverInventory.cs': sources['DriverInventory.cs'].replace(
      'Members = new HashSet<IntPtr>(members) });\n            return true;', 'Members = new HashSet<IntPtr>(members) });\n            return false;') })],
    ['diagnostic-before-revoke', sources => ({ ...sources, 'DriverInventory.cs': sources['DriverInventory.cs'].replace(recording, '')
      .replace('revoke(root);', recording + '\n            revoke(root);') })],
    ['counters-bypass-guard', sources => ({ ...sources, 'DriverInput.cs': sources['DriverInput.cs'].replace(
      'RequireOwned(window, hwnd, pid,', 'if (DriverOperationCounters.Current != null) return;\n        RequireOwned(window, hwnd, pid,') })],
    ['missing-fresh-ring', sources => ({ ...sources, 'DriverInventory.cs': sources['DriverInventory.cs'].replace(
      'fresh || !diagnostics.ContainsKey(root)', '!diagnostics.ContainsKey(root)') })],
    ['ignored-birth', sources => ({ ...sources, 'DriverInventory.cs': sources['DriverInventory.cs'].replace(
      ' || diagnostics[root].Incarnation != incarnation', '') })],
    ['focus-before-check', sources => ({ ...sources, 'DriverInput.cs': sources['DriverInput.cs'].replace(
      'Check(window, info.Focus);\n        DriverInventory.LifecycleFocus(window, info.Focus);',
      'DriverInventory.LifecycleFocus(window, info.Focus);\n        Check(window, info.Focus);') })],
    ['uncaught-track-diagnostic', sources => {
      const inventory = sources['DriverInventory.cs'], track = body(inventory, 'internal void Track(');
      return { ...sources, 'DriverInventory.cs': inventory.replace(track, track.replace('} catch { }', '} catch { throw; }')) };
    }],
    ['wrapper-counters-disabled', sources => ({ ...sources, 'DriverInput.cs': sources['DriverInput.cs'].replace(
      'var counters = DriverOperationCounters.Current;', 'var counters = (DriverOperationCounters)null;') })],
  ]) {
    const mutated = mutate(originals);
    if (name !== 'baseline' && name !== 'pristine-compile') assert.notDeepEqual(mutated, originals, name + ': mutation anchor');
    const sources = name === 'pristine-compile' ? mutated : headless(mutated);
    for (const [file, source] of Object.entries(sources)) writeFileSync(join(root, file), source);
    const binary = join(root, name + '.exe');
    const built = spawnSync(join(framework, 'csc.exe'), ['/nologo', '/noconfig', '/langversion:5', '/target:exe',
      '/main:Sleight.Driver.LifecycleReviewChecks', '/out:' + binary,
      ...['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll'].map(file => '/r:' + join(framework, file)),
      ...names.map(file => originals[file] ? join(root, file) : fileURLToPath(new URL(file, native))),
      fileURLToPath(new URL('./fixtures/windows-wlg2-checks.cs', import.meta.url))],
    { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true, killSignal: 'SIGKILL' });
    assertChildStatus(built, 0, built.stdout + built.stderr);
    if (name === 'pristine-compile') continue; // Never start the real event pump.
    const result = spawnSync(binary, [], { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true, killSignal: 'SIGKILL' });
    assertChildStatus(result, name === 'baseline' ? 0 : 1, result.stdout + result.stderr);
    if (name === 'baseline') {
      const checks = JSON.parse(result.stdout);
      assert.equal(checks.passed, 48); assert.equal(checks.failed, 0); assert.equal(checks.drawing, false);
      t.diagnostic('LIFECYCLE_REVIEW_NATIVE ' + JSON.stringify(checks));
    }
    t.diagnostic(`LIFECYCLE_REVIEW_VARIANT ${name} exit=${result.status}`);
  }
});
