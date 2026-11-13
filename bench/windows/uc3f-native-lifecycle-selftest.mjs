// PowerShell/.NET boundary regression. No child, app, input or capture calls.
import { GUEST_OPERATIONS } from './uc3f-collect.mjs';

export function nativeLifecycleSelftestScript() {
  const birth = GUEST_OPERATIONS.split('function Birth($p) {')[1]?.split('function ProcessOrGone')[0];
  const query = GUEST_OPERATIONS.split('  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess')[1]
    ?.split('  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation')[0];
  if (!birth || !query) throw Error('SELFTEST_SOURCE_UNPROVED');
  return String.raw`& {
$ErrorActionPreference='Stop'
function LegacyBirth($p) { $p.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) }
function Birth($p) {` + birth + String.raw`
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Uc3fWindow {
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess` + query + String.raw`
}
public sealed class Uc3fBirthFixture {
  public System.DateTime? StartTime { get { return null; } }
  public bool HasExited { get; set; }
  public uint Id { get { return 0; } }
  public void Refresh() { }
}
'@
  $missing=New-Object Uc3fBirthFixture
  $missing.HasExited=$true
  $legacy=$null
  try { [void](LegacyBirth $missing) } catch {
    $legacy=@{type=$_.Exception.GetType().FullName;message=$_.Exception.Message;line=$_.InvocationInfo.Line.Trim()}
  }
  if ($null -eq $legacy -or $legacy.message -cne 'You cannot call a method on a null-valued expression.') { throw 'SELFTEST_LEGACY_NOT_REPRODUCED' }
  $code=$null
  try { [void](Birth $missing) } catch { $code=$_.Exception.Message }
  if ($code -cne 'FIXTURE_PROCESS_GONE') { throw 'SELFTEST_GONE_UNCLASSIFIED' }
  $live=[Diagnostics.Process]::GetCurrentProcess()
  try { $liveBirth=Birth $live } finally { $live.Dispose() }
  if ($liveBirth -cnotmatch '^[1-9][0-9]{0,19}$') { throw 'SELFTEST_LIVE_BIRTH_UNPROVED' }
  $missing.HasExited=$false
  $code=$null
  try { [void](Birth $missing) } catch { $code=$_.Exception.Message }
  if ($code -notlike '*FIXTURE_ACCESS_DENIED*') { throw 'SELFTEST_MISSING_BIRTH_ADMITTED' }
  @{schema='sleight.uc3f-native-lifecycle-selftest/1';passed=3;legacy=$legacy;gone='FIXTURE_PROCESS_GONE';missing='FIXTURE_ACCESS_DENIED';children=0;drawing=$false} | ConvertTo-Json -Depth 4 -Compress
} catch { [Console]::Error.WriteLine($_.Exception.Message+' line='+$_.InvocationInfo.ScriptLineNumber); exit 1 }
}

`;
}
