# Read sequence metadata in the autologon desktop. Never open or write clipboard data.
$bank=Join-Path 'C:\sleight-setup' ('wh1f-probe-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($bank)
& icacls.exe $bank /inheritance:r /grant:r "${guestUser}:(OI)(CI)M" 'SYSTEM:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /T /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'PROBE_ACL_FAILED' }
$source=@'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public static class VmClipboardProbe {
  [DllImport("user32.dll",SetLastError=true)] static extern uint GetClipboardSequenceNumber();
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint size, tick; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("kernel32.dll")] static extern ulong GetTickCount64();
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint parameter, out uint value, uint flags);
  [DllImport("kernel32.dll")] static extern void SetLastError(uint code);
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformationW(IntPtr h,int kind,StringBuilder value,uint size,out uint needed);
  static string Name(IntPtr h) { uint n; var s=new StringBuilder(256); return GetUserObjectInformationW(h,2,s,512,out n)?s.ToString():"unavailable"; }
  public static int Main(string[] args) {
    SetLastError(0); uint sequence=GetClipboardSequenceNumber(); int error=Marshal.GetLastWin32Error();
    var input=new LASTINPUTINFO { size=8 }; bool inputOk=GetLastInputInfo(ref input);
    uint foregroundPid, foregroundLockMs; GetWindowThreadProcessId(GetForegroundWindow(),out foregroundPid);
    bool lockOk=SystemParametersInfo(0x2000,0,out foregroundLockMs,0);
    uint age=unchecked((uint)GetTickCount64()-input.tick);
    string json="{\"sessionId\":"+Process.GetCurrentProcess().SessionId+",\"sequence\":"+sequence+",\"error\":"+error+
      ",\"station\":\""+Name(GetProcessWindowStation())+"\",\"desktop\":\""+Name(GetThreadDesktop(GetCurrentThreadId()))+"\",\"user\":\""+Environment.UserName+"\""+
      ",\"lastInputOk\":"+(inputOk?"true":"false")+",\"lastInputAgeMs\":"+age+
      ",\"foregroundLockOk\":"+(lockOk?"true":"false")+",\"foregroundLockMs\":"+foregroundLockMs+",\"foregroundPid\":"+foregroundPid+"}";
    File.WriteAllText(args[0],json,new UTF8Encoding(false)); return 0;
  }
}
'@
$exe=Join-Path $bank 'probe.exe'
$result=Join-Path $bank 'sample.json'
Add-Type -TypeDefinition $source -OutputAssembly $exe -OutputType WindowsApplication
$action=New-ScheduledTaskAction -Execute $exe -Argument ('"'+$result+'"') -WorkingDirectory $bank
$principal=New-ScheduledTaskPrincipal -UserId $guestUser -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero)
$task='sleight-wh1f-probe-'+[Guid]::NewGuid().ToString('N')
Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $task
$clock=[Diagnostics.Stopwatch]::StartNew()
while (-not [IO.File]::Exists($result)) {
  if ($clock.ElapsedMilliseconds -gt 30000) { throw 'PROBE_TIMEOUT' }
  [Threading.Thread]::Sleep(100)
}
$sample=Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
$foreground=if ($sample.foregroundPid -gt 0) {(Get-Process -Id $sample.foregroundPid -ErrorAction SilentlyContinue).ProcessName} else {$null}
@{whoami=$sample.user;clipboard=$sample;foregroundProcess=$foreground} | ConvertTo-Json -Depth 4 -Compress
# Restore discards the task and bank. No guest cleanup command follows.
