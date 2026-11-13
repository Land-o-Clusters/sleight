param([Parameter(Mandatory=$true)][string]$Bank, [Parameter(Mandatory=$true)][string]$Invocation)
$ErrorActionPreference = 'Stop'
# One Limited interactive task. No input, logon, desktop recovery or Mac control.
if ($Bank -cnotmatch '^C:\\sleight-setup\\uc3f-[a-f0-9]{16}$' -or $Invocation -cnotmatch '^[1-9][0-9]{0,5}$') { exit 64 }
function Ordinary([string]$Path, [bool]$Directory = $false) {
  $item = Get-Item -LiteralPath $Path -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -ne $Directory) { throw 'BANK_PATH_UNSAFE' }
}
function Write-New([string]$Path, [string]$Text) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
}
Ordinary 'C:\sleight-setup' $true
Ordinary $Bank $true
Set-Location -LiteralPath $Bank
$requestPath = Join-Path $Bank "$Invocation.request.json"
Ordinary $requestPath
if ((Get-Item -LiteralPath $requestPath).Length -gt 16384) { exit 65 }
$request = Get-Content -LiteralPath $requestPath -Raw | ConvertFrom-Json
$resultPath = Join-Path $Bank "$Invocation.result.json"
$rcPath = Join-Path $Bank "$Invocation.rc"
if ((Test-Path -LiteralPath $resultPath) -or (Test-Path -LiteralPath $rcPath)) { exit 65 }
$reply = @{protocol='sleight.uc3f-transport/1'; invocation=$Invocation; token=$request.token; operation=$request.operation}
$rc = '1'
function Hash([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw 'VM_IDENTITY_REQUIRED' }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value.Trim().ToLowerInvariant())))).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
try {
  if ($request.protocol -cne 'sleight.uc3f-transport/1' -or $request.invocation -cne $Invocation -or
      $request.token -cnotmatch '^[a-f0-9]{16}$' -or $Bank -cne ('C:\sleight-setup\uc3f-'+$request.token) -or
      $request.operation -cnotin @('preflight','row','selftest','export') -or $request.presence -cnotin @('away','present')) { throw 'INVALID_REQUEST' }
  $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
  if ($session -le 0) { throw 'INTERACTIVE_SESSION_REQUIRED' }
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'UNELEVATED_REQUIRED' }
  $system = Get-CimInstance Win32_ComputerSystem
  if ($system.Manufacturer -cne 'QEMU') { throw 'NOT_VM' }
  $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Cryptography')
  try { $guidHash = Hash ([string]$key.GetValue('MachineGuid')) } finally { if ($key) { $key.Close() } }
  $current = @{vmId=$request.vmId; manufacturer=$system.Manufacturer; model=$system.Model;
    build=[int](Get-CimInstance Win32_OperatingSystem).BuildNumber;
    hostnameSha256=(Hash ([string]$system.Name)); machineGuidSha256=$guidHash; sessionId=$session; elevated=$false}
  foreach ($field in @('vmId','manufacturer','model','build','hostnameSha256','machineGuidSha256')) {
    if ($null -eq $request.expected.$field -or $current[$field] -cne $request.expected.$field) { throw 'VM_IDENTITY_MISMATCH' }
  }
  if ($request.expected.provenance.hostname -cne 'Win32_ComputerSystem.Name' -or
      $request.expected.provenance.machineGuid -cne 'HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid' -or
      $request.expected.provenance.encoding -cne 'sha256:utf8:trim:lowercase') { throw 'VM_RECORD_PROVENANCE_REQUIRED' }
  $operation = $request.operation
  if ($operation -ceq 'preflight') {
    # A reviewed guest adapter opts into the file-request contract. Never launch
    # an older collector with unfamiliar flags that it might silently ignore.
    foreach ($name in @('uc3f-collect.mjs','uc3f-export.mjs')) {
      $entry = Join-Path 'C:\sleight\bench\windows' $name
      if (-not (Test-Path -LiteralPath $entry)) { throw 'UC3F_GUEST_ADAPTER_REQUIRED' }
      Ordinary $entry
      if ((Get-Item -LiteralPath $entry).Length -gt 1048576 -or
          (Get-Content -LiteralPath $entry -Raw) -cnotmatch '(?m)^// sleight\.uc3f-transport/1: file-request\r?$') { throw 'UC3F_GUEST_ADAPTER_REQUIRED' }
    }
    $reply.value = $current
  }
  else {
    if ($operation -ceq 'selftest' -and $request.presence -cne 'away') { throw 'INVALID_REQUEST' }
    if ($operation -ceq 'row') {
      $present = @('lock-refused','lock-during-type','screensaver-refused','session-switch-refused','uac-refused','uac-hint','escape-stop-hardware')
      $away = @('person-key-before','person-key-during','escape-ignored-injected','escape-ignored-posted','cancel-frame',
        'direct-launch-terminal','direct-launch-override','browser-refused-edge','browser-refused-firefox','browser-refused-renamed')
      $row = $request.payload.row
      if ($row.presence -cne $request.presence -or
          ($row.id -cne 'person-idle' -and (($request.presence -ceq 'present' -and $row.id -cnotin $present) -or
          ($request.presence -ceq 'away' -and $row.id -cnotin $away)))) { throw 'ROW_MODE_MISMATCH' }
      if ($row.id -ceq 'person-idle' -and (($request.presence -ceq 'present' -and ($row.cases -join ',') -cne 'background-word') -or
          ($request.presence -ceq 'away' -and ($row.cases -join ',') -cne 'notepad,wpf,calculator-refused'))) { throw 'ROW_MODE_MISMATCH' }
    }
    # Guest collector/exporter implement this file-request interface. A missing
    # implementation refuses before any row rather than fabricating evidence.
    $script = if ($operation -ceq 'export') { 'uc3f-export.mjs' } else { 'uc3f-collect.mjs' }
    $scriptPath = Join-Path 'C:\sleight\bench\windows' $script
    if (-not (Test-Path -LiteralPath $scriptPath)) { throw 'UC3F_GUEST_ADAPTER_REQUIRED' }
    Ordinary $scriptPath
    $valuePath = Join-Path $Bank "$Invocation.value.json"
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = 'C:\Program Files\nodejs\node.exe'
    $start.Arguments = '"'+$scriptPath+'" --transport-request "'+$requestPath+'" --transport-result "'+$valuePath+'"'
    $start.WorkingDirectory = $Bank
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $child = [Diagnostics.Process]::Start($start)
    try {
      $stdout = $child.StandardOutput.ReadToEndAsync()
      $stderr = $child.StandardError.ReadToEndAsync()
      $budget = if ($operation -cin @('row','selftest')) { 900000 } else { 45000 }
      if (-not $child.WaitForExit($budget)) { throw 'GUEST_REPLY_LIMIT' }
      if (-not [Threading.Tasks.Task]::WaitAll(@($stdout,$stderr),5000) -or $stdout.Result.Length -gt 32768 -or $stderr.Result.Length -gt 32768) { throw 'GUEST_REPLY_LIMIT' }
      $LASTEXITCODE = $child.ExitCode
    } finally {
      $child.Dispose()
    }
    if ($LASTEXITCODE -ne 0) {
      if (Test-Path -LiteralPath $valuePath) {
        Ordinary $valuePath
        if ((Get-Item -LiteralPath $valuePath).Length -le 32768) {
          try {
            $failure = Get-Content -LiteralPath $valuePath -Raw | ConvertFrom-Json
            if ($failure.guestCode -is [string] -and $failure.guestCode -cmatch '^[A-Z][A-Z0-9_]{0,79}\z') { $reply.guestCode = $failure.guestCode }
          } catch { $reply.guestCode = 'GUEST_FAILURE_FILE_INVALID' }
        }
      }
      throw 'UC3F_GUEST_OPERATION_FAILED'
    }
    Ordinary $valuePath
    if ((Get-Item -LiteralPath $valuePath).Length -gt 32768) { throw 'GUEST_REPLY_LIMIT' }
    $reply.value = Get-Content -LiteralPath $valuePath -Raw | ConvertFrom-Json
  }
  $rc = '0'
} catch {
  $known = @('BANK_PATH_UNSAFE','FIXTURE_ACCESS_DENIED','FIXTURE_PROCESS_GONE','FIXTURE_WINDOW_GONE','GUEST_EXCEPTION_UNCLASSIFIED','GUEST_REPLY_LIMIT','INTERACTIVE_SESSION_REQUIRED','INVALID_REQUEST','NOT_VM','PARAMETER_BINDING_FAILED','ROW_MODE_MISMATCH','UC3F_GUEST_ADAPTER_REQUIRED','UC3F_GUEST_OPERATION_FAILED','UNELEVATED_REQUIRED','VM_IDENTITY_MISMATCH','VM_IDENTITY_REQUIRED','VM_RECORD_PROVENANCE_REQUIRED')
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
  $reply.error = $code
}
Write-New $resultPath ($reply | ConvertTo-Json -Depth 20 -Compress)
# The rc is last so the Mac never consumes a partial reply.
Write-New $rcPath $rc
if ($rc -ne '0') { exit 1 }
