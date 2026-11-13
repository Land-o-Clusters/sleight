param([Parameter(Mandatory=$true)][string]$Bank)
$ErrorActionPreference='Stop'
# This task runs only in the disposable test guest's limited interactive session.
# Restore discards fixtures and processes. Never terminate a guest process.
if ($Bank -cnotmatch '^C:\\sleight-setup\\uc3f-[a-f0-9]{16}$') { exit 64 }
function Hash([string]$Value) {
  $h=[Security.Cryptography.SHA256]::Create()
  try { ([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value.Trim().ToLowerInvariant())))).Replace('-','').ToLowerInvariant() }
  finally { $h.Dispose() }
}
try {
  $request=Get-Content -LiteralPath (Join-Path $Bank 'request.json') -Raw | ConvertFrom-Json
  $session=[Diagnostics.Process]::GetCurrentProcess().SessionId
  $principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if ($session -ne 1 -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'INTERACTIVE_LIMITED_REQUIRED' }
  $system=Get-CimInstance Win32_ComputerSystem
  $guid=(Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography').MachineGuid
  $actual=@{manufacturer=$system.Manufacturer;model=$system.Model;build=[int](Get-CimInstance Win32_OperatingSystem).BuildNumber;
    hostnameSha256=(Hash $system.Name);machineGuidSha256=(Hash $guid)}
  if ($actual.manufacturer -cne 'QEMU') { throw 'NOT_VM' }
  foreach ($key in $actual.Keys) { if ($actual[$key] -cne $request.expected.$key) { throw 'VM_IDENTITY_MISMATCH' } }
  foreach ($path in @('C:\', 'C:\sleight-setup', $Bank, 'C:\sleight')) {
    if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'PATH_UNSAFE' }
  }
  $utf8=New-Object Text.UTF8Encoding($false)
  $folderName='wrt1-files-'+$request.token
  $folder=Join-Path $Bank $folderName
  New-Item -ItemType Directory -Path $folder | Out-Null
  $filename='wrt1-known-file.txt'
  [IO.File]::WriteAllText((Join-Path $folder $filename),'WRT1 Explorer fixture',$utf8)
  $notepad='wrt1-note-'+$request.token+'.txt'
  $notePath=Join-Path $Bank $notepad
  [IO.File]::WriteAllText($notePath,'',$utf8)
  $fixture=@{line='Sleight WRT1 saved this known line.';filename=$filename;folder=$folderName;notepad=$notepad;notePath=$notePath;edgeTitle='Sleight WDR7 page'}
  [IO.File]::WriteAllText((Join-Path $Bank 'fixtures.json'),($fixture | ConvertTo-Json -Compress),$utf8)
  # Setup alone opens windows. MCP only acquires them and performs the task actions.
  Start-Process notepad.exe -ArgumentList ('"'+$notePath+'"') | Out-Null
  Start-Process explorer.exe -ArgumentList ('"'+$folder+'"') | Out-Null
  $edge=Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
  if (!(Test-Path -LiteralPath $edge)) { $edge=Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe' }
  Start-Process $edge -ArgumentList '--inprivate --new-window "file:///C:/sleight/bench/windows/fixtures/driver-page.html"' | Out-Null
  Start-Process charmap.exe | Out-Null
  Start-Process 'C:\Windows\System32\cmd.exe' -ArgumentList '/d /k title Sleight WRT1 forbidden fixture' | Out-Null
  Start-Sleep -Seconds 5
  $start=New-Object Diagnostics.ProcessStartInfo
  $start.FileName='C:\Program Files\nodejs\node.exe'
  $start.Arguments='"C:\sleight\bench\windows\real-tasks-guest.mjs" "'+$Bank+'"'
  $start.WorkingDirectory=$Bank
  $start.UseShellExecute=$false
  $start.CreateNoWindow=$true
  $config=Join-Path $Bank 'claude-config'
  New-Item -ItemType Directory -Path $config | Out-Null
  $start.EnvironmentVariables['CLAUDE_CONFIG_DIR']=$config
  $child=[Diagnostics.Process]::Start($start)
  # A bounded wait never signals the child. The host stops the disposable VM.
  if (!$child.WaitForExit(360000)) { exit 124 }
  exit $child.ExitCode
} catch {
  [Console]::Error.WriteLine('REAL_TASKS_TASK_FAILED: '+$_.Exception.Message)
  exit 1
}
