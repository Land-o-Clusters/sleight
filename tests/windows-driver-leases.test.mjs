import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WindowsInputLease } from '../plugins/sleight/lib/windows-driver/leases.mjs';
import { fakeWindows } from './fixtures/windows-driver-fake.mjs';
import { windowsLeaseTarget } from '../plugins/sleight/lib/windows-driver/safety.mjs';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';

function fixture(t) {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-win-lease-'))), directory = join(root, 'leases');
  const calls = [], proofs = []; let unsafe = false;
  const permissions = {
    privateDirectory: path => { proofs.push(['directory', path]); return { ok: !unsafe, reason: 'fixture ACL' }; },
    privateFile: path => { proofs.push(['file', path]); return { ok: !unsafe, reason: 'fixture ACL' }; },
    privateCoordinator: path => { proofs.push(['coordinator', path]); return { ok: !unsafe, reason: 'fixture ACL' }; },
  };
  const operate = request => {
    calls.push(request);
    if (request.operation === 'lease-init') {
      mkdirSync(directory, { recursive: true });
      const coordinator = join(directory, '.coordinator.sqlite');
      if (!existsSync(coordinator)) writeFileSync(coordinator, '', { flag: 'wx' });
      return { ok: true };
    }
    if (request.operation === 'lease-write') writeFileSync(request.path, request.text);
    return existsSync(request.path) ? { ok: true, text: readFileSync(request.path, 'utf8') } : { ok: true, absent: true };
  };
  const lease = new WindowsInputLease({ directory, operate, permissions });
  t.after(() => { unsafe = false; lease.close(); removeTemp(root); });
  return { lease, directory, calls, proofs, unsafe() { unsafe = true; } };
}

test('Windows leases create and revalidate the directory, coordinator and protected records', async t => {
  const f = fixture(t); await f.lease.ready();
  const key = f.lease.acquire(windowsLeaseTarget(fakeWindows[0]));
  assert.equal(f.calls[0].operation, 'lease-init');
  assert.ok(f.proofs.some(([kind]) => kind === 'directory'));
  assert.ok(f.proofs.some(([, path]) => path.endsWith('.coordinator.sqlite')));
  assert.ok(f.proofs.some(([, path]) => path.endsWith(key + '.json')));
  assert.ok(f.calls.some(c => c.operation === 'lease-write'));
  const before = f.proofs.length;
  f.lease.renew([key]); assert.ok(f.proofs.length > before);
  assert.equal(f.lease.inspect(key).window.title, '101');
});

test('Windows lease ACL failures refuse acquisition and every later renewal', async t => {
  const f = fixture(t); await f.lease.ready();
  const key = f.lease.acquire(windowsLeaseTarget(fakeWindows[0]));
  f.unsafe();
  assert.throws(() => f.lease.renew([key]), /WINDOWS_LEASE_UNPROVED/);
  assert.throws(() => f.lease.acquire(windowsLeaseTarget(fakeWindows[1])), /WINDOWS_LEASE_UNPROVED/);
});

test('native lease operations constrain names and roots and use handle ACL validation', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/platform/win32-files.ps1', import.meta.url), 'utf8');
  const lease = source.slice(source.indexOf('public static string Lease('), source.indexOf('public static string Settings('));
  for (const contract of ['Canonical(path)', 'Path.Combine(root, "leases")', '@"\\A[a-f0-9]{64}\\.json\\z"',
    'Parents(root)', 'Open(directory, true, false)', 'Open(coordinator, false, false)', 'SetAccessRuleProtection(true, false)',
    'FileMode.CreateNew', 'FileAcl()', 'File.Replace', 'Descriptor(file.SafeFileHandle, false)', 'handle.Dispose()'])
    assert.ok(lease.includes(contract), contract);
  const adapter = readFileSync(new URL('../plugins/sleight/lib/windows-driver/leases.mjs', import.meta.url), 'utf8');
  assert.match(adapter, /createWindowsFilePermissions/);
  assert.match(adapter, /privateDirectory\(path\)/);
  assert.match(adapter, /privateFile\(path\)/);
  assert.match(adapter, /win32\.join\(win32Paths\(\)\.settings, 'leases'\)/);
});

test('stuck Escape native source samples idle immediately at the post and skips accelerators', () => {
  const directory = new URL('../plugins/sleight/lib/direct-browser/native/win/', import.meta.url);
  const input = readFileSync(new URL('DriverInput.cs', directory), 'utf8');
  assert.match(input, /GetLastInputInfo\(ref input\)/);
  assert.match(input, /age >= 2000 && age < 0x80000000u/);
  // The idle sample runs first inside every post attempt and retry, before identity, the person check and the send.
  assert.match(input, /Idle = RequireIdle,/);
  assert.match(input, /RetryPost\(\(\) => \{\s*if \(idle\) api\.Idle\(\);[^]*?api\.Person\(window\);\s*return api\.Send\(hwnd, message, wParam, lParam\);/);
  const actions = readFileSync(new URL('DriverActions.cs', directory), 'utf8');
  assert.match(actions, /if \(plan.Method == "pressKey" && !plan.StuckEscape\) \{\s*var matches = latest.Values.Where\(n => AcceleratorMatches\(n.Accelerator, plan.Chord\)\)/);
  assert.match(actions, /DriverInput.Keys\(node.Host, FocusHandle\(node\), plan.Chord, plan.StuckEscape, plan.ResolvedKey\)/);
  const dispatch = readFileSync(new URL('Driver.cs', directory), 'utf8');
  assert.match(dispatch, /request.Method == "stuckMenuEscape"/);
  assert.match(dispatch, /Json.Text\(args\[0\]\) != "Escape"/);
});

test('coordinator ACL proof permits the SQLite write handle while forbidding delete sharing', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/BrowserGate.cs', import.meta.url), 'utf8');
  assert.match(source, /if \(leaf && coordinator\) share = 3u/);
  assert.match(source, /!coordinator \|\| !read && !browser && kind == "file"/);
  assert.match(source, /SpecialFolder.LocalApplicationData\), "sleight", "leases", ".coordinator.sqlite"/);
  assert.match(source, /leaf \? browser \? BrowserFileAcl\(acl, user\) : StrictPrivateAcl\(acl, user\)/);
});
