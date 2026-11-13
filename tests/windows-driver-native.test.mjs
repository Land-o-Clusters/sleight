import { assertChildStatus } from './fixtures/child-status.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

test('C# 5 driver runs synthetic provider, identity, output and bounded traversal regressions without UIA', {
  skip: process.platform !== 'win32' ? 'requires in-box Windows csc.exe; draws nothing' : false,
}, t => {
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-driver-native-'))));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const framework = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
  const binary = join(root, 'driver-checks.exe');
  const sources = ['Driver.cs', 'DriverInventory.cs', 'DriverCapture.cs', 'DriverIdentity.cs', 'DriverUia.cs', 'DriverActions.cs', 'DriverActionPlan.cs',
    'DriverInput.cs', 'DriverHook.cs', 'DriverPatterns.cs', 'DriverSettle.cs', 'DriverClipboard.cs'].map(name =>
    fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/native/win/' + name, import.meta.url)));
  const built = spawnSync(join(framework, 'csc.exe'), ['/nologo', '/langversion:5', '/target:exe',
    '/main:Sleight.Driver.DriverChecks', '/out:' + binary,
    ...['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll'].map(name => '/r:' + join(framework, name)),
    ...sources, fileURLToPath(new URL('./fixtures/windows-driver-checks.cs', import.meta.url))],
  { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stdout + built.stderr);
  const result = spawnSync(binary, [], { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr);
  const checks = JSON.parse(result.stdout);
  t.diagnostic('DRIVER_NATIVE ' + JSON.stringify(checks));
  assert.equal(checks.failed, 0); assert.equal(checks.providerRows, 172); assert.equal(checks.drawing, false);
  assert.equal(checks.passed, 777);
  assert.equal(checks.stopRows, 28);
  assert.equal(checks.turnRows, 13); assert.equal(checks.sampleRows, 8);
  assert.equal(checks.telemetryRows, 23);
});

test('C# 5 action parser, ladder, chords, settle and DPI run headlessly against production functions', {
  skip: process.platform !== 'win32' ? 'requires in-box Windows csc.exe; 0 UIA activations' : false,
}, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sleight-driver-actions-native-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const framework = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
  const binary = join(root, 'driver-action-checks.exe');
  const sources = ['Driver.cs', 'DriverInventory.cs', 'DriverCapture.cs', 'DriverIdentity.cs', 'DriverUia.cs', 'DriverActions.cs', 'DriverActionPlan.cs',
    'DriverInput.cs', 'DriverHook.cs', 'DriverPatterns.cs', 'DriverSettle.cs', 'DriverClipboard.cs'].map(name =>
    fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/native/win/' + name, import.meta.url)));
  const built = spawnSync(join(framework, 'csc.exe'), ['/nologo', '/noconfig', '/langversion:5', '/target:exe', '/platform:anycpu',
    '/main:Sleight.Driver.DriverActionChecks', '/out:' + binary,
    ...['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll'].map(name => '/r:' + join(framework, name)),
    ...sources, fileURLToPath(new URL('./fixtures/windows-driver-action-checks.cs', import.meta.url))],
  { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stdout + built.stderr);
  const result = spawnSync(binary, [], { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr);
  const checks = JSON.parse(result.stdout);
  t.diagnostic('DRIVER_ACTION_NATIVE ' + JSON.stringify(checks));
  assert.equal(checks.failed, 0); assert.equal(checks.drawing, false); assert.ok(checks.passed >= 200, JSON.stringify(checks));
});

test('C# packaged switch and guest Calculator receipt execute production resolver seams headlessly', {
  skip: process.platform !== 'win32' ? 'requires Windows C# 5 compiler; no windows or UIA' : false,
}, async t => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { GUEST_OPERATIONS } = await import('../bench/windows/uc3f-collect.mjs');
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-packaged-native-'))));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const framework = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
  const names = ['Driver.cs', 'DriverInventory.cs', 'DriverCapture.cs', 'DriverIdentity.cs', 'DriverUia.cs', 'DriverActions.cs',
    'DriverActionPlan.cs', 'DriverInput.cs', 'DriverHook.cs', 'DriverPatterns.cs', 'DriverSettle.cs', 'DriverClipboard.cs'];
  const inventory = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/DriverInventory.cs', import.meta.url), 'utf8');
  const guest = GUEST_OPERATIONS.split("Add-Type -TypeDefinition @'\n")[1].split("\n'@")[0];
  const variants = {
    'native-core-admitted-by-name': { prefix: 'if (name == "Calculator" && windows.Any(w => w.ClassName == "Windows.UI.Core.CoreWindow" && !String.IsNullOrEmpty(w.Aumid))) { var core = windows.First(w => w.ClassName == "Windows.UI.Core.CoreWindow" && !String.IsNullOrEmpty(w.Aumid)); core.Refused = null; return core; }' },
    'native-core-admitted-by-aumid': { prefix: 'if (name == "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" && windows.Any(w => w.ClassName == "Windows.UI.Core.CoreWindow" && !String.IsNullOrEmpty(w.Aumid))) { var core = windows.First(w => w.ClassName == "Windows.UI.Core.CoreWindow" && !String.IsNullOrEmpty(w.Aumid)); core.Refused = null; return core; }' },
    'native-core-switch-ignored': { inventory: ['!String.Equals(row.ClassName, "Windows.UI.Core.CoreWindow", StringComparison.OrdinalIgnoreCase)', 'true'] },
    'native-hosted-process-ignored': { inventory: ['!hostedProcess(row.Pid)', 'true'] },
    'native-calculator-multiple-processes': { guest: ['pids.Length != 1', 'pids.Length < 1'] },
    'native-calculator-cloaked-frame-ignored': { guest: ['frames.Length != 1', 'frames.Length < 1'] },
    'native-calculator-birth-equal-accepted': { guest: ['started <= activation', 'started < activation'] },
  };
  for (const name of ['baseline', ...Object.keys(variants)]) {
    const mutation = variants[name];
    let source = inventory, guestSource = guest;
    if (mutation?.prefix) source = source.replace('string name = Json.Text(selector);', 'string name = Json.Text(selector);\n' + mutation.prefix);
    if (mutation?.inventory) {
      assert.ok(source.includes(mutation.inventory[0]), name + ': anchor');
      source = source.replace(...mutation.inventory);
    }
    if (mutation?.guest) {
      assert.ok(guestSource.includes(mutation.guest[0]), name + ': anchor');
      guestSource = guestSource.replace(...mutation.guest);
    }
    const local = join(root, 'DriverInventory.cs'), guestFile = join(root, 'Guest.cs'), binary = join(root, 'packaged.exe');
    writeFileSync(local, source); writeFileSync(guestFile, guestSource);
    const sources = names.map(file => file === 'DriverInventory.cs' ? local : fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/native/win/' + file, import.meta.url)));
    const built = spawnSync(join(framework, 'csc.exe'), ['/nologo', '/noconfig', '/langversion:5', '/target:exe', '/main:Sleight.Driver.PackagedChecks', '/out:' + binary,
      ...['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll'].map(file => '/r:' + join(framework, file)),
      ...sources, guestFile, fileURLToPath(new URL('./fixtures/windows-packaged-checks.cs', import.meta.url))],
    { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true, killSignal: 'SIGKILL' });
    assertChildStatus(built, 0, built.stdout + built.stderr);
    const result = spawnSync(binary, [], { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true, killSignal: 'SIGKILL' });
    assertChildStatus(result, name === 'baseline' ? 0 : 1, result.stdout + result.stderr);
    if (name === 'baseline') {
      const checks = JSON.parse(result.stdout);
      assert.equal(checks.failed, 0); assert.equal(checks.drawing, false); assert.ok(checks.passed >= 100);
    }
    console.log(`NATIVE_VARIANT ${name} exit=${result.status}`);
  }
});
