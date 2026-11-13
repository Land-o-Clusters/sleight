# Operator-run baseline for the disposable QEMU guest, never called by the collector.
# Finish the foreground UI through its normal controls. This script supplies no input.
[CmdletBinding()]
param(
  [switch]$PrepareTestGuest,
  [switch]$SetDefaultForegroundLockTimeout,
  [Parameter(Mandatory)][string]$Receipt
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
if (-not $PrepareTestGuest) { throw 'EXPLICIT_BASELINE_FLAG_REQUIRED' }
if ($env:OS -cne 'Windows_NT') { throw 'WINDOWS_REQUIRED' }
if ($env:USERNAME -cne 'sleight-test') { throw 'TEST_GUEST_USER_REQUIRED' }
if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { throw 'INTERACTIVE_SESSION_REQUIRED' }
if ((Get-CimInstance Win32_ComputerSystem).Manufacturer -cne 'QEMU') { throw 'NOT_VM' }
if ($Receipt -cnotmatch '^C:\\sleight-setup\\baseline-[a-f0-9]{16}\.json$') { throw 'BANK_IDENTITY' }
foreach ($path in @('C:\','C:\sleight-setup')) {
  $item = Get-Item -LiteralPath $path -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'BANK_IDENTITY' }
}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class BaselineForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr w, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr w, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr w, StringBuilder s, int n);
}
'@
function Foreground {
  $hwnd = [BaselineForeground]::GetForegroundWindow()
  [uint32]$pidValue = 0
  [void][BaselineForeground]::GetWindowThreadProcessId($hwnd,[ref]$pidValue)
  $title = New-Object Text.StringBuilder 1024
  $class = New-Object Text.StringBuilder 256
  [void][BaselineForeground]::GetWindowTextW($hwnd,$title,1024)
  [void][BaselineForeground]::GetClassNameW($hwnd,$class,256)
  $p = Get-Process -Id $pidValue -ErrorAction Stop
  @{ windowId=$hwnd.ToInt64().ToString(); pid=$pidValue; process=$p.ProcessName;
     processStart=$p.StartTime.ToFileTimeUtc().ToString(); className=$class.ToString(); title=$title.ToString() }
}
$stream = [IO.File]::Open($Receipt,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
$writer = New-Object IO.StreamWriter($stream,(New-Object Text.UTF8Encoding($false)))
try {
  $before = Foreground
  $settings = Get-ItemProperty -LiteralPath 'HKCU:\Control Panel\Desktop'
  $oldValue = if ($settings.PSObject.Properties.Name -contains 'ForegroundLockTimeout') { $settings.ForegroundLockTimeout } else { $null }
  $writer.WriteLine((@{ phase='before'; utc=[DateTime]::UtcNow.ToString('o'); foreground=$before;
    foregroundLockTimeout=$oldValue; user=$env:USERNAME } | ConvertTo-Json -Depth 4 -Compress))
  $writer.Flush()
  Write-Host ($before | ConvertTo-Json -Compress)
  Write-Host 'Finish any WWAHost UI through its normal controls in this test guest. Do not signal a process.'
  if ((Read-Host 'When the guest is signed in and ready for fixtures, enter READY') -cne 'READY') { throw 'BASELINE_NOT_READY' }
  $after = Foreground
  if ($after.process -ceq 'WWAHost') { throw 'BASELINE_UI_UNFINISHED' }
  if ($SetDefaultForegroundLockTimeout) {
    New-ItemProperty -LiteralPath 'HKCU:\Control Panel\Desktop' -Name ForegroundLockTimeout -PropertyType DWord -Value 200000 -Force | Out-Null
  }
  $settings = Get-ItemProperty -LiteralPath 'HKCU:\Control Panel\Desktop'
  $newValue = if ($settings.PSObject.Properties.Name -contains 'ForegroundLockTimeout') { $settings.ForegroundLockTimeout } else { $null }
  if ($SetDefaultForegroundLockTimeout -and $newValue -ne 200000) { throw 'BASELINE_POLICY_UNPROVED' }
  $writer.WriteLine((@{ phase='after'; utc=[DateTime]::UtcNow.ToString('o'); foreground=$after;
    foregroundLockTimeout=$newValue; changedPolicy=[bool]$SetDefaultForegroundLockTimeout;
    note='Registry value only. Effective policy after sign-in and fixture foreground admission remain unproved.' } | ConvertTo-Json -Depth 4 -Compress))
  $writer.Flush()
} catch {
  $writer.WriteLine((@{ phase='failed'; utc=[DateTime]::UtcNow.ToString('o'); code=[string]$_.Exception.Message } | ConvertTo-Json -Compress))
  $writer.Flush()
  throw
} finally { $writer.Dispose() }
