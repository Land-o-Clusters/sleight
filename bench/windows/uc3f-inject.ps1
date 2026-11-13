# VM collector only. One fixed key or session intervention per invocation.
# The caller registers the task. Snapshot restore clears fixture state.
# Bank: C:\sleight-setup\uc3f-<16 hex>. Presence comes from the row request.
# Wait for go-<Invocation>, sleep LeadMs, then compare the Default desktop and foreground fixture PID.
# FixtureStart is StartTime.ToFileTimeUtc() as a decimal string, as in RT31.
# Stdout and inject-<Invocation>.jsonl hold one metadata line. Exit 0 means API acceptance only.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('key','lock','screensaver','session-switch')][string]$Operation,
  [Parameter(Mandatory)][string]$Bank,
  [Parameter(Mandatory)][ValidateSet('away','present')][string]$Presence,
  [ValidatePattern('^[0-9]{1,4}$')][string]$Invocation = '0',
  [Parameter(Mandatory)][ValidateRange(1,2147483647)][int]$FixturePid,
  [Parameter(Mandatory)][ValidatePattern('^[1-9][0-9]{0,18}$')][string]$FixtureStart,
  [ValidateSet('q','escape')][string]$Key = 'q',
  [ValidateRange(0,5000)][int]$LeadMs = 100,
  [ValidateRange(100,900000)][int]$WaitMs = 30000
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Assert-BankFile([string]$Path, [bool]$Directory = $false) {
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -ne $Directory) { throw 'BANK_IDENTITY' }
}
$writer = $null
$result = [pscustomobject]@{ tickMs = 0; eventTickMs = 0; sentInputs = 0; code = 'INJECTOR_FAILED' }
$status = 1
try {
  if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_REQUIRED' }
  if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { throw 'INTERACTIVE_SESSION_REQUIRED' }
  if ($Bank -cnotmatch '^C:\\sleight-setup\\uc3f-[a-f0-9]{16}$') { throw 'BANK_IDENTITY' }
  if ($Operation -ne 'key' -and $PSBoundParameters.ContainsKey('Key')) { throw 'INVALID_KEY' }
  foreach ($directory in @('C:\', 'C:\sleight-setup', $Bank)) { Assert-BankFile $directory $true }
  $goPath = Join-Path $Bank "go-$Invocation"
  $logPath = Join-Path $Bank "inject-$Invocation.jsonl"
  Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
public static class SleightUc3fInject {
    [DllImport("kernel32.dll")] static extern ulong GetTickCount64();
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder name, uint size, out uint needed);
    [DllImport("user32.dll", SetLastError=true)] static extern bool CloseDesktop(IntPtr handle);
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll", SetLastError=true)] static extern bool LockWorkStation();
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint message, UIntPtr wparam, IntPtr lparam, uint flags, uint timeout, out UIntPtr result);
    [DllImport("wtsapi32.dll", SetLastError=true)] static extern bool WTSDisconnectSession(IntPtr server, int session, bool wait);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr info, int size, out int needed);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT {
        public int dx, dy; public uint mouseData, flags, time; public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT {
        public ushort vk, scan; public uint flags, time; public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Sequential)] struct HARDWAREINPUT { public uint message; public ushort low, high; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION {
        [FieldOffset(0)] public MOUSEINPUT mouse;
        [FieldOffset(0)] public KEYBDINPUT keyboard;
        [FieldOffset(0)] public HARDWAREINPUT hardware;
    }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION data; }
    public sealed class Result {
        public ulong tickMs; public uint eventTickMs, sentInputs; public string code = "OK";
    }
    public static Result Stamp() {
        ulong tick = GetTickCount64();
        return new Result { tickMs = tick, eventTickMs = unchecked((uint)tick) };
    }
    public static void RequireStandardUser() {
        IntPtr token = IntPtr.Zero, info = IntPtr.Zero;
        try {
            if (!OpenProcessToken(Process.GetCurrentProcess().Handle, 0x0008, out token)) throw new InvalidOperationException("INTEGRITY_UNPROVED");
            int needed;
            GetTokenInformation(token, 25, IntPtr.Zero, 0, out needed);
            if (needed < IntPtr.Size + 4 || needed > 4096) throw new InvalidOperationException("INTEGRITY_UNPROVED");
            info = Marshal.AllocHGlobal(needed);
            if (!GetTokenInformation(token, 25, info, needed, out needed)) throw new InvalidOperationException("INTEGRITY_UNPROVED");
            IntPtr sid = Marshal.ReadIntPtr(info);
            byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
            if (count == 0) throw new InvalidOperationException("INTEGRITY_UNPROVED");
            int rid = Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
            if (rid != 4096 && rid != 8192) throw new InvalidOperationException("UNELEVATED_REQUIRED");
        } finally {
            if (info != IntPtr.Zero) Marshal.FreeHGlobal(info);
            if (token != IntPtr.Zero && !CloseHandle(token)) throw new InvalidOperationException("HANDLE_CLEANUP_FAILED");
        }
    }
    public static string Decide(string desktop, uint foregroundPid, uint fixturePid, bool identityMatches) {
        if (desktop != "Default") return "SECURE_DESKTOP_NO_INJECT";
        if (fixturePid == 0 || foregroundPid != fixturePid || !identityMatches) return "FOREGROUND_NOT_FIXTURE";
        return "OK";
    }
    static string ReadDesktop() {
        IntPtr handle = OpenInputDesktop(0, false, 1);
        if (handle == IntPtr.Zero) return "";
        try {
            var name = new StringBuilder(256); uint needed;
            return GetUserObjectInformationW(handle, 2, name, 512, out needed) ? name.ToString() : "";
        } finally {
            if (!CloseDesktop(handle)) throw new InvalidOperationException("HANDLE_CLEANUP_FAILED");
        }
    }
    static IntPtr RequireTarget(uint fixturePid, string fixtureStart) {
        bool identityMatches = false;
        try {
            using (var process = Process.GetProcessById((int)fixturePid)) {
                if (process.HasExited) throw new InvalidOperationException("FIXTURE_PROCESS_GONE");
                if (process.StartTime.ToFileTimeUtc().ToString(CultureInfo.InvariantCulture) != fixtureStart)
                    throw new InvalidOperationException("FIXTURE_BIRTH_CHANGED");
                identityMatches = process.SessionId == Process.GetCurrentProcess().SessionId;
            }
        } catch (ArgumentException) { throw new InvalidOperationException("FIXTURE_PROCESS_GONE"); }
        catch (System.ComponentModel.Win32Exception error) {
            throw new InvalidOperationException(error.NativeErrorCode == 5 ? "FIXTURE_ACCESS_DENIED" : "INTEGRITY_UNPROVED");
        }
        string desktop = ReadDesktop();
        IntPtr hwnd = GetForegroundWindow(); uint foregroundPid;
        GetWindowThreadProcessId(hwnd, out foregroundPid);
        string code = Decide(desktop, foregroundPid, fixturePid, identityMatches);
        if (code != "OK") throw new InvalidOperationException(code);
        return hwnd;
    }
    public static Result Run(string operation, string key, uint fixturePid, string fixtureStart) {
        if (operation != "key" && operation != "lock" && operation != "screensaver" && operation != "session-switch")
            throw new InvalidOperationException("INVALID_OPERATION");
        if (key != "q" && key != "escape") throw new InvalidOperationException("INVALID_KEY");
        var result = new Result();
        // Allocate the complete ABI-sized INPUT union before the final live check.
        var inputs = new INPUT[2];
        ushort vk = (ushort)(key == "escape" ? 0x1b : 0x51);
        inputs[0].type = 1; inputs[0].data.keyboard.vk = vk;
        inputs[1].type = 1; inputs[1].data.keyboard.vk = vk; inputs[1].data.keyboard.flags = 0x0002;
        IntPtr hwnd = RequireTarget(fixturePid, fixtureStart);
        result.tickMs = GetTickCount64(); result.eventTickMs = unchecked((uint)result.tickMs);
        if (operation == "key") {
            result.sentInputs = SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (result.sentInputs != 2) result.code = "INPUT_PARTIAL";
        } else if (operation == "lock") {
            if (!LockWorkStation()) result.code = "LOCK_FAILED";
        } else if (operation == "screensaver") {
            UIntPtr ignored;
            if (SendMessageTimeoutW(hwnd, 0x0112, new UIntPtr(0xf140), IntPtr.Zero, 0x0002, 1000, out ignored) == IntPtr.Zero)
                result.code = "SCREENSAVER_UNCONFIRMED";
        } else {
            // Disconnect only this interactive session. The owner reconnects.
            if (!WTSDisconnectSession(IntPtr.Zero, Process.GetCurrentProcess().SessionId, false)) result.code = "SESSION_DISCONNECT_FAILED";
        }
        return result;
    }
}
'@
  [SleightUc3fInject]::RequireStandardUser()
  $system = Get-CimInstance Win32_ComputerSystem -OperationTimeoutSec 5
  $virtual = $system.Manufacturer -iin @('QEMU','VMware, Inc.','innotek GmbH','Parallels Software International Inc.') -or
    ($system.Manufacturer -ceq 'Microsoft Corporation' -and $system.Model -ceq 'Virtual Machine')
  if (-not $virtual) { throw 'NOT_VM' }
  $result = [SleightUc3fInject]::Stamp()
  if ($Operation -ne 'key' -and $Presence -cne 'present') { throw 'OWNER_PRESENT_REQUIRED' }
  # CreateNew claims this invocation permanently. Reusing its go file cannot repeat an intervention.
  $stream = [IO.File]::Open($logPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  $writer = New-Object IO.StreamWriter($stream, (New-Object Text.UTF8Encoding($false)))
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while (-not (Test-Path -LiteralPath $goPath)) {
    if ($watch.ElapsedMilliseconds -ge $WaitMs) { throw 'GO_TIMEOUT' }
    Start-Sleep -Milliseconds 10
  }
  Assert-BankFile $goPath
  # A missing configured saver is unmeasured, never counted as a successful intervention.
  if ($Operation -eq 'screensaver') {
    $settings = Get-ItemProperty -LiteralPath 'HKCU:\Control Panel\Desktop'
    if ($settings.PSObject.Properties.Name -notcontains 'SCRNSAVE.EXE' -or
        [string]::IsNullOrWhiteSpace($settings.'SCRNSAVE.EXE')) { throw 'SCREENSAVER_NOT_CONFIGURED' }
  }
  Start-Sleep -Milliseconds $LeadMs
  $result = [SleightUc3fInject]::Run($Operation, $Key, $FixturePid, $FixtureStart)
  if ($result.code -ceq 'OK') { $status = 0 }
} catch {
  $known = @('BANK_IDENTITY','FIXTURE_ACCESS_DENIED','FIXTURE_BIRTH_CHANGED','FIXTURE_PROCESS_GONE','FIXTURE_WINDOW_GONE','FOREGROUND_NOT_FIXTURE','GO_TIMEOUT','GUEST_EXCEPTION_UNCLASSIFIED','HANDLE_CLEANUP_FAILED','INTEGRITY_UNPROVED','INTERACTIVE_SESSION_REQUIRED','INVALID_KEY','INVALID_OPERATION','NOT_VM','OWNER_PRESENT_REQUIRED','PARAMETER_BINDING_FAILED','SCREENSAVER_NOT_CONFIGURED','SECURE_DESKTOP_NO_INJECT','UNELEVATED_REQUIRED','WINDOWS_REQUIRED')
  $code = [string]$_.Exception.Message
  if ($code -cnotin $known) {
    $code = 'GUEST_EXCEPTION_UNCLASSIFIED'
    $exception = $_.Exception
    for ($depth = 0; $null -ne $exception -and $depth -lt 4; $depth++) {
      $innerCode = [string]$exception.Message
      if ($innerCode -cin $known) { $code = $innerCode; break }
      $type = $exception.GetType().FullName
      if ($type -cin @('System.UnauthorizedAccessException','System.Security.SecurityException') -or
          ($type -ceq 'System.ComponentModel.Win32Exception' -and $exception.NativeErrorCode -eq 5)) { $code = 'FIXTURE_ACCESS_DENIED'; break }
      if ($type -ceq 'System.Windows.Automation.ElementNotAvailableException') { $code = 'FIXTURE_WINDOW_GONE'; break }
      if ($type -like 'System.Management.Automation.ParameterBinding*Exception') { $code = 'PARAMETER_BINDING_FAILED'; break }
      $exception = $exception.InnerException
    }
    if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { $code = 'FIXTURE_PROCESS_GONE' }
  }
  $result.code = $code
}
$line = [ordered]@{
  schema = 'sleight.windows-uc3f-inject/1'
  kind = 'injector'
  invocation = $Invocation
  operation = $Operation
  key = $(if ($Operation -ne 'key') { 'none' } elseif ($Key -eq 'escape') { 'escape' } else { 'other' })
  tickMs = $result.tickMs
  eventTickMs = $result.eventTickMs
  vk = $(if ($Operation -ne 'key') { 0 } elseif ($Key -eq 'escape') { 27 } else { 81 })
  sentInputs = $result.sentInputs
  code = $result.code
} | ConvertTo-Json -Compress
try {
  if ($null -ne $writer) { $writer.WriteLine($line); $writer.Flush() }
  [Console]::WriteLine($line)
} finally { if ($null -ne $writer) { $writer.Dispose() } }
exit $status
