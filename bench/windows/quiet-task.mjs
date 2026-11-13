// Windowless harness wrapper. Restore owns the child, including after a timeout.
export const QUIET_TASK_SOURCE = String.raw`using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
public static class QuietTask {
  [STAThread] public static int Main(string[] args) {
    if (args.Length != 3 || !Regex.IsMatch(args[0], @"\AC:\\sleight-setup\\uc3f-[a-f0-9]{16}\z") ||
        args[1].Length > 32768 || !Regex.IsMatch(args[1], @"\A[A-Za-z0-9+/]+={0,2}\z") ||
        !Regex.IsMatch(args[2], @"\A(?:collector-[0-9]{1,4}|row-launch(?:-cost)?)\z")) return 64;
    try { return Run(args); }
    catch (Exception) { return 65; }
  }
  static int Run(string[] args) {
    var info = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
      @"WindowsPowerShell\v1.0\powershell.exe"), Encoding.Unicode.GetString(Convert.FromBase64String(args[1])));
    info.WorkingDirectory = args[0]; info.UseShellExecute = false; info.CreateNoWindow = true;
    info.RedirectStandardInput = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
    using (var output = new FileStream(Path.Combine(args[0], args[2] + ".stdout.txt"), FileMode.CreateNew, FileAccess.Write, FileShare.ReadWrite))
    using (var errors = new FileStream(Path.Combine(args[0], args[2] + ".stderr.txt"), FileMode.CreateNew, FileAccess.Write, FileShare.ReadWrite))
    using (var child = new Process()) {
      child.StartInfo = info;
      if (!child.Start()) return 65;
      child.StandardInput.Close();
      Task stdout = child.StandardOutput.BaseStream.CopyToAsync(output);
      Task stderr = child.StandardError.BaseStream.CopyToAsync(errors);
      if (!child.WaitForExit(args[2] == "row-launch-cost" ? 1200000 : 900000)) return 124;
      if (!Task.WaitAll(new[] { stdout, stderr }, 10000)) return 125;
      return child.ExitCode;
    }
  }
}
`;

// r.arguments comes from the same fixed argument builder as the console task.
// Encoding preserves those bytes without a shell or another PowerShell layer.
export function quietTaskSetup(bank) {
  if (!['$bank', '$r.bank'].includes(bank)) throw Error('INVALID_BANK_EXPRESSION');
  return String.raw`
    $launcher = Join-Path ${bank} 'quiet-task.exe'
    $sourcePath = Join-Path ${bank} 'quiet-task.cs'
    $source = '${QUIET_TASK_SOURCE.replaceAll("'", "''")}'
    if (-not (Test-Path -LiteralPath $launcher)) {
      if (Test-Path -LiteralPath $sourcePath) { throw 'TASK_ALREADY_EXISTS' }
      [IO.File]::WriteAllText($sourcePath,$source,(New-Object Text.UTF8Encoding($false)))
      Add-Type -TypeDefinition $source -ReferencedAssemblies System.dll,System.Core.dll -OutputAssembly $launcher -OutputType WindowsApplication
    }
    foreach ($path in @($sourcePath,$launcher)) {
      $item=Get-Item -LiteralPath $path -Force
      if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'BANK_PATH_UNSAFE' }
    }
    if ([IO.File]::ReadAllText($sourcePath) -cne $source) { throw 'TASK_ALREADY_EXISTS' }
`;
}
export const QUIET_INJECTOR_ACTION = quietTaskSetup('$r.bank') + String.raw`
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([string]$r.arguments))
    $arguments = $r.bank+' '+$encoded+' collector-'+$r.invocation
    $action = New-ScheduledTaskAction -Execute $launcher -Argument $arguments -WorkingDirectory $r.bank
`;
