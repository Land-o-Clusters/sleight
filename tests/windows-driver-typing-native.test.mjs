import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTemp, trackTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';

test('C# focus selection and native WM_CHAR selection replacement on a hidden owned Edit', {
  skip: process.platform !== 'win32' ? 'requires Windows csc and hidden Win32 control; no visible window' : false,
}, t => {
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-typing-native-'))));
  t.after(() => removeTemp(root));
  const framework = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319', binary = join(root, 'typing-checks.exe');
  const names = ['Driver.cs', 'DriverInventory.cs', 'DriverCapture.cs', 'DriverIdentity.cs', 'DriverUia.cs', 'DriverActions.cs',
    'DriverActionPlan.cs', 'DriverInput.cs', 'DriverHook.cs', 'DriverPatterns.cs', 'DriverSettle.cs', 'DriverClipboard.cs'];
  const sources = names.map(name => fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/native/win/' + name, import.meta.url)));
  const built = spawnSync(join(framework, 'csc.exe'), ['/nologo', '/noconfig', '/langversion:5', '/target:exe',
    '/main:Sleight.Driver.DriverTypingChecks', '/out:' + binary,
    ...['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll'].map(name => '/r:' + join(framework, name)),
    ...sources, fileURLToPath(new URL('./fixtures/windows-driver-typing-checks.cs', import.meta.url))],
  { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stdout + built.stderr);
  const result = spawnSync(binary, ['--selftest'], { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stdout + result.stderr);
  const checks = JSON.parse(result.stdout);
  assert.equal(checks.failed, 0); assert.equal(checks.editCases, 4); assert.equal(checks.drawing, false);
  assert.equal(checks.visibleWindows, 0); assert.equal(checks.uiaActivations, 0); assert.equal(checks.foregroundChanged, false);
  assert.ok(checks.passed >= 20); console.log('TYPING_NATIVE ' + result.stdout.trim());
});
