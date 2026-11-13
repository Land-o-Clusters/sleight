import { assertChildStatus } from './fixtures/child-status.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

test('C# 5 identity, forged bindings, PNG pixels and geometry checks draw nothing', {
  skip: process.platform !== 'win32' ? 'requires Windows csc.exe and System.Drawing; draws nothing' : false,
}, t => {
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-driver-capture-native-'))));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const framework = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
  const binary = join(root, 'capture-checks.exe');
  const sources = ['Driver.cs', 'DriverInventory.cs', 'DriverUia.cs', 'DriverIdentity.cs', 'DriverCapture.cs', 'DriverActions.cs', 'DriverActionPlan.cs', 'DriverInput.cs', 'DriverHook.cs', 'DriverPatterns.cs', 'DriverSettle.cs', 'DriverClipboard.cs'].map(name =>
    fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/native/win/' + name, import.meta.url)));
  const build = spawnSync(join(framework, 'csc.exe'), ['/nologo', '/noconfig', '/langversion:5', '/target:exe', '/platform:anycpu',
    '/main:Sleight.Driver.CaptureChecks', '/out:' + binary,
    ...['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll'].map(name => '/r:' + join(framework, name)),
    ...sources, fileURLToPath(new URL('./fixtures/windows-driver-capture-checks.cs', import.meta.url))],
  { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true, killSignal: 'SIGKILL' });
  assertChildStatus(build, 0, build.stdout + build.stderr);
  const result = spawnSync(binary, [], { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stdout + result.stderr);
  const checks = JSON.parse(result.stdout);
  assert.equal(checks.failed, 0); assert.equal(checks.drawing, false); assert.ok(checks.passed >= 80);
});
