import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { windowsDriverSources } from '../plugins/sleight/lib/direct-browser/windows-host.mjs';

test('native checkpoint buffer, units, cursor and private flag run without native calls or drawing', {
  skip: process.platform !== 'win32' ? 'requires Windows .NET Framework C# 5; no native APIs or windows' : false,
}, t => {
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-checkpoint-native-'))));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const framework = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319', binary = join(root, 'checkpoint-checks.exe');
  const sources = windowsDriverSources.filter(name => name.endsWith('.cs') && name !== 'Program.cs')
    .map(name => fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/native/win/' + name, import.meta.url)));
  const built = spawnSync(join(framework, 'csc.exe'), ['/nologo', '/langversion:5', '/target:exe',
    '/main:Sleight.Driver.DriverCheckpointChecks', '/out:' + binary,
    ...['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll'].map(name => '/r:' + join(framework, name)),
    ...sources, fileURLToPath(new URL('./fixtures/windows-checkpoint-checks.cs', import.meta.url))],
  { cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stdout + built.stderr);
  const ran = spawnSync(binary, [], { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true, killSignal: 'SIGKILL' });
  assertChildStatus(ran, 0, ran.stderr);
  const result = JSON.parse(ran.stdout);
  assert.equal(result.failed, 0); assert.equal(result.drawing, false); assert.ok(result.passed >= 30);
});
