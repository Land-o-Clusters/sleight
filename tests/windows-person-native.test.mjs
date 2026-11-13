import { assertChildStatus } from './fixtures/child-status.mjs';
import test from 'node:test';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compileWindowsHost, windowsPersonSources } from '../plugins/sleight/lib/direct-browser/windows-host.mjs';

test('password source pins one interactive logon with protected unpack and unmanaged erasure', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/PersonPassword.cs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('internal static int Confirm('));
  assert.equal((source.match(/\bLogonUserW\s*\(/g) ?? []).length, 2); // one declaration and one call
  assert.equal((body.match(/\bLogonUserW\s*\(/g) ?? []).length, 1);
  assert.match(body, /LogonUserW\(user, [^\n]*, password, 2, 0, out token\)/); // LOGON32_LOGON_INTERACTIVE
  assert.equal((body.match(/CredUnPackAuthenticationBufferW\(1,/g) ?? []).length, 2); // CRED_PACK_PROTECTED_CREDENTIALS
  assert.doesNotMatch(source, /PtrToString\w*\s*\(|new\s+string\s*\(|(?:string|String)\s+password\b/);
  assert.doesNotMatch(source, /new\s+String\s*\(|SecureString|GetString\s*\(/i);
  assert.match(source, /LogonUserW\(IntPtr user, IntPtr domain, IntPtr password,/);
  assert.match(source, /NoInlining\s*\|\s*MethodImplOptions.NoOptimization/);
  assert.match(source, /SecureZeroMemory\(buffer, bytes\);\s*Marshal.FreeCoTaskMem\(buffer\)/);
  assert.match(body, /finally\s*\{[\s\S]*WipeFree\(ref password, passwordBytes\)/);
  assert.match(body, /SameUser\(identity.User.Value, launcherSid, ownSid\).*Native.LauncherSid\(\) != launcherSid/);
});

// This test never requests authentication. The only executed native modes draw nothing.
for (const winrt of ['abi', 'metadata']) test(`Windows ${winrt} csc builds WIN5 and runs no-draw reason, result and password selftests`, { skip: process.platform !== 'win32' && 'Windows csc required' }, async t => {
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-win5-native-'))));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, 'person-host.exe');
  await compileWindowsHost({ binary, winrt, sources: windowsPersonSources.filter(name => name.endsWith('.cs')).map(name =>
    fileURLToPath(new URL('../plugins/sleight/lib/direct-browser/native/win/' + name, import.meta.url))) });
  const run = args => spawnSync(binary, args, { encoding: 'utf8', windowsHide: true, timeout: 5000, killSignal: 'SIGKILL' });
  const selftest = run(['--person-selftest']); assertChildStatus(selftest, 0, selftest.stderr);
  const data = JSON.parse(selftest.stdout);
  assert.deepEqual(data.results, [69, 0, 69, 69, 69, 69, 1, 2, 69, 69]);
  assert.equal(data.timeoutMs, 60000); assert.equal(data.drawing, false);
  assert.deepEqual(data.passwordFallback, [false, false, true, true, true, false, false, false]);
  const password = run(['--password-selftest']); assertChildStatus(password, 0, password.stderr);
  assert.deepEqual(JSON.parse(password.stdout), { drawing: false, attemptLimit: 1, securePrompt: true, promptFlags: 4624,
    zeroed: true, blankRefused: true, nonPasswordRefused: true, sidMismatchRefused: true });
  const check = run(['--confirm-person-check', 'turbo-on', 'Google Chrome']); assertChildStatus(check, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout.trim().split('\n')[1]).reason, 'turn on sleight turbo for Google Chrome');
  for (const args of [[], ['--confirm-person-check'], ['--confirm-person-check', 'unknown'],
    ['--confirm-person-check', 'turbo-on', 'untrusted text'], ['--confirm-person-check', 'settings', 'Google Chrome']]) assertChildStatus(run(args), 64);
});
