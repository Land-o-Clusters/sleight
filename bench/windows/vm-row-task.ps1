param([Parameter(Mandatory=$true)][string]$Bank)
$ErrorActionPreference = 'Stop'
# Limited interactive task, with restore as the only process cleanup.
if ($Bank -cnotmatch '^C:\\sleight-setup\\uc3f-[a-f0-9]{16}$') { exit 64 }
function Ordinary([string]$Path, [bool]$Directory) {
  $item=Get-Item -LiteralPath $Path -ErrorAction Stop
  if ($item.PSIsContainer -ne $Directory -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'BANK_PATH_UNSAFE' }
}
function Hash([string]$Value) {
  $h=[Security.Cryptography.SHA256]::Create()
  try { ([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value.Trim().ToLowerInvariant())))).Replace('-','').ToLowerInvariant() }
  finally { $h.Dispose() }
}
try {
  Ordinary 'C:\' $true
  Ordinary 'C:\sleight-setup' $true
  Ordinary $Bank $true
  $path=Join-Path $Bank 'row.json'
  Ordinary $path $false
  if ((Get-Item -LiteralPath $path).Length -gt 16384) { throw 'INVALID_REQUEST' }
  $request=Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  $session=[Diagnostics.Process]::GetCurrentProcess().SessionId
  $principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if ($session -le 0 -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'INTERACTIVE_LIMITED_REQUIRED' }
  $system=Get-CimInstance Win32_ComputerSystem
  $guid=(Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography').MachineGuid
  $current=@{vmId=$request.expected.vmId;manufacturer=$system.Manufacturer;model=$system.Model;
    build=[int](Get-CimInstance Win32_OperatingSystem).BuildNumber;hostnameSha256=(Hash $system.Name);
    machineGuidSha256=(Hash $guid);sessionId=$session;elevated=$false}
  if ($current.manufacturer -cne 'QEMU') { throw 'NOT_VM' }
  foreach ($field in @('vmId','manufacturer','model','build','hostnameSha256','machineGuidSha256')) {
    if ($null -eq $request.expected.$field -or $current[$field] -cne $request.expected.$field) { throw 'VM_IDENTITY_MISMATCH' }
  }
  [IO.File]::WriteAllText((Join-Path $Bank 'vm-identity.json'),($current | ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))
  $start=New-Object Diagnostics.ProcessStartInfo
  $start.FileName='C:\Program Files\nodejs\node.exe'
  $start.Arguments='"C:\sleight\bench\windows\vm-row-guest.mjs" "'+$Bank+'"'
  $start.WorkingDirectory=$Bank
  $start.UseShellExecute=$false
  $start.CreateNoWindow=$true
  $child=[Diagnostics.Process]::Start($start)
  # Never terminate this child, including when the host stops polling. A later
  # restore discards it. The host has its own bounded row wait.
  $child.WaitForExit()
  $rc=$child.ExitCode
  $child.Dispose()
  if ($rc -ne 0) { throw 'VM_ROW_FAILED' }
} catch {
  $result=Join-Path $Bank 'row-result.json'
  if (-not (Test-Path -LiteralPath $result)) {
    [IO.File]::WriteAllText(($result+'.failed'),'{"recorded":false}',(New-Object Text.UTF8Encoding($false)))
    [IO.File]::Move(($result+'.failed'),$result)
  }
  exit 1
}
