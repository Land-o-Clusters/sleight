import { trackTemp } from '../scripts/temp-leftovers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertChildStatus } from './fixtures/child-status.mjs';

test('C# 5 popup desktop and diagnostic steps run headlessly against production methods and broken variants', {
  skip: process.platform !== 'win32' ? 'requires in-box Windows csc.exe; no windows or UIA' : false,
}, t => {
  const root = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-identity-native-'))));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const framework = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
  const directory = new URL('../plugins/sleight/lib/direct-browser/native/win/', import.meta.url);
  const names = ['Driver.cs', 'DriverInventory.cs', 'DriverCapture.cs', 'DriverIdentity.cs', 'DriverUia.cs', 'DriverActions.cs',
    'DriverActionPlan.cs', 'DriverInput.cs', 'DriverHook.cs', 'DriverPatterns.cs', 'DriverSettle.cs', 'DriverClipboard.cs'];
  const inventory = readFileSync(new URL('DriverInventory.cs', directory), 'utf8');
  for (const [label, before, after] of [
    ['baseline'],
    ['fallback removed', 'if (id == Guid.Empty && row.OnCurrentDesktop == true && row.Popup && row.Owner != IntPtr.Zero)', 'if (false)'],
    ['owner process ignored', 'sight.Pid(owner) != row.Pid', 'false'],
    ['owner desktop ignored', '!sight.Current(owner)', 'false'],
    ['unpackaged core poisons Explorer', 'if (package != 15700) result.Pids.Add(pid);', 'result.Pids.Add(pid);'],
    ['packaged Calculator omitted', 'if (package != 15700) result.Pids.Add(pid);', ''],
    ['failed package probe ignored', 'if (package != 15700 && package != 122) result.PackageUnproved.Add(pid);', ''],
    ['frame child omitted', 'else result.Pids.Add(childPid);', ''],
  ]) {
    if (before) assert.ok(inventory.includes(before));
    const local = join(root, 'DriverInventory.cs'), binary = join(root, 'identity-checks.exe');
    writeFileSync(local, before ? inventory.replace(before, after) : inventory);
    const built = spawnSync(join(framework, 'csc.exe'), ['/nologo', '/noconfig', '/langversion:5', '/target:exe',
      '/main:Sleight.Driver.IdentityChecks', '/out:' + binary,
      ...['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll'].map(file => '/r:' + join(framework, file)),
      ...names.map(file => file === 'DriverInventory.cs' ? local : fileURLToPath(new URL(file, directory))),
      fileURLToPath(new URL('./fixtures/windows-identity-checks.cs', import.meta.url))],
    { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true, killSignal: 'SIGKILL' });
    assertChildStatus(built, 0, label + ': ' + built.stdout + built.stderr);
    const result = spawnSync(binary, [], { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true, killSignal: 'SIGKILL' });
    if (label === 'baseline') {
      assertChildStatus(result, 0, result.stdout + result.stderr);
      const checks = JSON.parse(result.stdout);
      assert.equal(checks.failed, 0); assert.equal(checks.drawing, false); assert.equal(checks.passed, 41);
    } else assertChildStatus(result, 1, label + ' must fail the production-method assertions: ' + result.stdout + result.stderr);
    t.diagnostic(label + ': exit=' + result.status);
  }
});
