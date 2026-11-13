import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';

test('native lifecycle ring, error gate and diagnostic failure isolation with broken variants', {
  skip: process.platform !== 'win32' ? 'requires Windows csc.exe; synthetic metadata, draws nothing' : false,
}, t => {
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'wlg1-native-'))));
  t.after(() => removeTemp(root));
  const framework = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
  const native = new URL('../plugins/sleight/lib/direct-browser/native/win/', import.meta.url);
  const names = ['Driver.cs', 'DriverInventory.cs', 'DriverCapture.cs', 'DriverIdentity.cs', 'DriverUia.cs', 'DriverActions.cs',
    'DriverActionPlan.cs', 'DriverInput.cs', 'DriverHook.cs', 'DriverPatterns.cs', 'DriverSettle.cs', 'DriverClipboard.cs'];
  const originals = Object.fromEntries(['Driver.cs', 'DriverInventory.cs'].map(name =>
    [name, readFileSync(new URL(name, native), 'utf8').replace(/\r\n/g, '\n')]));
  for (const [name, file, before, after] of [
    ['baseline'],
    ['silent-overflow', 'DriverInventory.cs', 'else overflow = true;', ''],
    ['missing-event', 'DriverInventory.cs', 'if (advance != null) advance(root, known.Value, retained);', ''],
    ['ungated-error', 'Driver.cs', 'fault.Code == "IDENTITY_CHANGED" && DriverLifecycleRing.Enabled && fault.Disposition.ContainsKey("lifecycleEvents")',
      'fault.Code == "IDENTITY_CHANGED" && fault.Disposition.ContainsKey("lifecycleEvents")'],
  ]) {
    for (const [source, original] of Object.entries(originals)) {
      if (source === file) assert.ok(original.includes(before), name + ': mutation anchor');
      writeFileSync(join(root, source), source === file ? original.replace(before, after) : original);
    }
    const binary = join(root, name + '.exe');
    const built = spawnSync(join(framework, 'csc.exe'), ['/nologo', '/langversion:5', '/target:exe',
      '/main:Sleight.Driver.LifecycleChecks', '/out:' + binary,
      ...['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll'].map(file => '/r:' + join(framework, file)),
      ...names.map(file => originals[file] ? join(root, file) : fileURLToPath(new URL(file, native))),
      fileURLToPath(new URL('./fixtures/windows-wlg1-checks.cs', import.meta.url))],
    { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true, killSignal: 'SIGKILL' });
    assertChildStatus(built, 0, built.stdout + built.stderr);
    const result = spawnSync(binary, [], { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true, killSignal: 'SIGKILL' });
    assertChildStatus(result, name === 'baseline' ? 0 : 1, result.stdout + result.stderr);
    if (name === 'baseline') {
      const checks = JSON.parse(result.stdout); assert.equal(checks.passed, 924); assert.equal(checks.drawing, false);
      t.diagnostic('LIFECYCLE_NATIVE ' + JSON.stringify(checks));
    }
    t.diagnostic(`LIFECYCLE_VARIANT ${name} exit=${result.status}`);
  }
});
