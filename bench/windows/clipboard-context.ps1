& {
$ErrorActionPreference = 'Stop'
$task = $null
try {
  # Read-only native sampling. Own only this scratch bank and one bounded task.
  foreach ($old in @(Get-ScheduledTask -TaskName 'sleight-wt1c-context-*' -ErrorAction SilentlyContinue)) {
    $actions = @($old.Actions)
    if ($old.TaskName -cnotmatch '^sleight-wt1c-context-[a-f0-9]{32}$' -or $old.State -ne 'Ready' -or $actions.Count -ne 1 -or
        $actions[0].Execute -cnotmatch '^C:\\sleight-setup\\wt1c-context-[a-f0-9]{32}\\context.exe$') { throw 'PREVIOUS_PROBE_UNPROVED' }
    $oldBank = Split-Path $actions[0].Execute -Parent
    if ($actions[0].Arguments -cne ('launch "' + $oldBank + '"')) { throw 'PREVIOUS_PROBE_UNPROVED' }
    Unregister-ScheduledTask -TaskName $old.TaskName -Confirm:$false
  }
  $bank = Join-Path 'C:\sleight-setup' ('wt1c-context-' + [Guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($bank)
  [Console]::Out.WriteLine('CONTEXT_BANK_CREATED:' + $bank)
  $source = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
public static class ClipboardContext {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr Minimum, Maximum;
    public uint Processes; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernelbase.dll", SetLastError=true)] static extern bool CompareObjectHandles(IntPtr first, IntPtr second);
  [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder value, uint size, out uint needed);
  static string Name(IntPtr handle) {
    uint needed; var text = new StringBuilder(256);
    if (handle == IntPtr.Zero || !GetUserObjectInformationW(handle, 2, text, 512, out needed)) return null;
    return text.ToString();
  }
  public static int Main(string[] args) {
    try {
      if (args.Length == 2 && args[0] == "launch") {
        var start = new ProcessStartInfo(@"C:\Program Files\nodejs\node.exe");
        start.Arguments = "\"" + Path.Combine(args[1], "context.mjs") + "\"";
        start.WorkingDirectory = args[1]; start.UseShellExecute = false; start.CreateNoWindow = true;
        start.RedirectStandardOutput = true; start.RedirectStandardError = true;
        start.EnvironmentVariables["CLAUDE_CONFIG_DIR"] = Path.Combine(args[1], "claude-config");
        var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000;
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new InvalidOperationException("PROBE_JOB_UNAVAILABLE");
        try { using (var child = Process.Start(start)) {
          try {
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))) ||
                !AssignProcessToJobObject(job, child.Handle)) throw new InvalidOperationException("PROBE_JOB_UNPROVED");
            child.PriorityClass = ProcessPriorityClass.Idle;
            var output = child.StandardOutput.ReadToEndAsync(); var error = child.StandardError.ReadToEndAsync();
            if (!child.WaitForExit(70000)) throw new InvalidOperationException("PROBE_CHILD_TIMEOUT");
            if (!System.Threading.Tasks.Task.WaitAll(new[] { output, error }, 5000)) throw new InvalidOperationException("PROBE_DRAIN_TIMEOUT");
            File.WriteAllText(Path.Combine(args[1], "node.stdout"), output.Result);
            File.WriteAllText(Path.Combine(args[1], "node.stderr"), error.Result);
            return child.ExitCode;
          } finally { if (!child.HasExited) { child.Kill(); child.WaitForExit(10000); } }
        } } finally { CloseHandle(job); }
      }
      if (args.Length != 2 && args.Length != 3) return 64;
      using (var self = Process.GetCurrentProcess()) {
        object target = null;
        if (args.Length == 3) {
          using (var driver = Process.GetProcessById(Int32.Parse(args[2]))) {
            var desktops = new System.Collections.Generic.List<object>();
            foreach (ProcessThread thread in driver.Threads) {
              var handle = GetThreadDesktop((uint)thread.Id);
              var desktop = Name(handle); int error = desktop == null ? Marshal.GetLastWin32Error() : 0;
              bool sameDesktop = handle != IntPtr.Zero && CompareObjectHandles(handle, GetThreadDesktop(GetCurrentThreadId()));
              desktops.Add(new { threadId = thread.Id, desktop, error, sameDesktop });
            }
            target = new { pid = driver.Id, sessionId = driver.SessionId, processStart = driver.StartTime.ToFileTimeUtc().ToString(), desktops };
          }
        }
        var counts = new uint[5];
        for (int i = 0; i < counts.Length; i++) { counts[i] = GetClipboardSequenceNumber(); System.Threading.Thread.Sleep(20); }
        var sample = new { pid = self.Id, sessionId = self.SessionId, station = Name(GetProcessWindowStation()),
          desktop = Name(GetThreadDesktop(GetCurrentThreadId())), counts, target };
        File.WriteAllText(args[1], new JavaScriptSerializer().Serialize(sample), new UTF8Encoding(false));
      }
      return 0;
    } catch (Exception e) { File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "probe-error.txt"), e.ToString()); return 70; }
    finally { if (args.Length == 2 && args[0] == "launch") File.WriteAllText(Path.Combine(args[1], "task.done"), "done"); }
  }
}
'@
  $exe = Join-Path $bank 'context.exe'
  Add-Type -TypeDefinition $source -ReferencedAssemblies 'System.Web.Extensions.dll' -OutputAssembly $exe -OutputType WindowsApplication
  [Console]::Out.WriteLine('CONTEXT_COMPILED')
  $module = @'
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = 'C:/sleight', bank = process.cwd();
const { prepareWindowsHandHost } = await import(pathToFileURL(root + '/plugins/sleight/lib/direct-browser/windows-host.mjs'));
const { createWindowsDriverClient } = await import(pathToFileURL(root + '/plugins/sleight/lib/windows-driver/client.mjs'));
let driver, launch;
const host = await prepareWindowsHandHost({ kind: 'driver', run(command, args, options) {
  const child = spawn(command, args, options);
  if (args.includes('--driver')) { driver = child; launch = options; }
  return child;
} });
if (host.status !== 'ready') throw Error('HOST_NOT_READY:' + JSON.stringify(host));
const client = createWindowsDriverClient({ prepare: async () => host });
async function sample(name, options, target) {
  const output = join(bank, name + '.json');
  const child = spawn(join(bank, 'context.exe'), ['sample', output, ...target ? [String(target)] : []], options);
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); }, 10000);
    child.on('error', reject);
    child.on('close', (code, signal) => { clearTimeout(timer); code === 0 && !signal ? resolve() : reject(Error('PROBE_FAILED:' + code)); });
  });
  return JSON.parse(readFileSync(output, 'utf8'));
}
let ping, product, interactive;
try {
  ping = await client.request('ping');
  if (!driver?.pid || !launch) throw Error('DRIVER_LAUNCH_UNOBSERVED');
  product = await sample('product-spawn', launch, driver.pid);
  interactive = await sample('interactive', { cwd: bank, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
} finally { await client.close(); }
writeFileSync(join(bank, 'result.json'), JSON.stringify({ ping, product, interactive, driverExited: driver.exitCode !== null || driver.signalCode !== null,
  launch: { windowsHide: launch.windowsHide, cwd: launch.cwd, stdio: launch.stdio, envKeys: Object.keys(launch.env).sort() } }));
'@
  [IO.File]::WriteAllText((Join-Path $bank 'context.mjs'), $module, (New-Object Text.UTF8Encoding($false)))
  # The SSH launch is the noninteractive control, sampled before the task.
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $exe
  $start.Arguments = 'sample "' + (Join-Path $bank 'ssh.json') + '"'
  $start.UseShellExecute = $false; $start.CreateNoWindow = $true
  $control = [Diagnostics.Process]::Start($start)
  try { if (-not $control.WaitForExit(10000) -or $control.ExitCode -ne 0) { throw 'SSH_PROBE_FAILED' } }
  finally { if (-not $control.HasExited) { $control.Kill(); [void]$control.WaitForExit(10000) }; $control.Dispose() }
  $task = 'sleight-wt1c-context-' + [Guid]::NewGuid().ToString('N')
  $action = New-ScheduledTaskAction -Execute $exe -Argument ('launch "' + $bank + '"') -WorkingDirectory $bank
  $principal = New-ScheduledTaskPrincipal -UserId 'Sleight' -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 90)
  Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings | Out-Null
  Start-ScheduledTask -TaskName $task
  [Console]::Out.WriteLine('CONTEXT_TASK_STARTED:' + $task)
  $clock = [Diagnostics.Stopwatch]::StartNew()
  do {
    [Threading.Thread]::Sleep(200)
    if ($clock.ElapsedMilliseconds -gt 85000) { throw 'INTERACTIVE_PROBE_TIMEOUT' }
  } while (-not [IO.File]::Exists((Join-Path $bank 'task.done')))
  [Console]::Out.WriteLine('CONTEXT_TASK_FINISHED')
  $settle = [Diagnostics.Stopwatch]::StartNew()
  while ((Get-ScheduledTask -TaskName $task).State -in @('Running','Queued')) {
    if ($settle.ElapsedMilliseconds -gt 5000) { throw 'PROBE_TASK_EXIT_UNPROVED' }
    [Threading.Thread]::Sleep(100)
  }
  $info = Get-ScheduledTaskInfo -TaskName $task
  $result = @{ bank=$bank; logonType=[string]$principal.LogonType; runLevel=[string]$principal.RunLevel;
    taskResult=$info.LastTaskResult; ssh=(Get-Content -LiteralPath (Join-Path $bank 'ssh.json') -Raw | ConvertFrom-Json);
    kit=(Get-Content -LiteralPath 'C:\sleight\guest-manifest.json' -Raw | ConvertFrom-Json).commit }
  foreach ($file in @('result.json','node.stderr','probe-error.txt')) {
    if (Test-Path -LiteralPath (Join-Path $bank $file)) { $result[$file] = Get-Content -LiteralPath (Join-Path $bank $file) -Raw }
  }
  $result | ConvertTo-Json -Depth 12 -Compress
  if ($info.LastTaskResult -ne 0) { throw 'INTERACTIVE_PROBE_FAILED' }
  [Console]::Out.WriteLine('SLEIGHT_GUEST_OK')
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
finally {
  if ($task -and (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue)) {
    if ((Get-ScheduledTask -TaskName $task).State -in @('Running','Queued')) { Stop-ScheduledTask -TaskName $task }
    Unregister-ScheduledTask -TaskName $task -Confirm:$false
    if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) { throw 'PROBE_TASK_CLEANUP_UNPROVED' }
  }
}
}

