function Test-HostAccess([string]$Operation, [string]$Target) {
  if (![IO.Path]::IsPathRooted($Target) -or $Target.StartsWith('\\') -or [IO.Path]::GetFullPath($Target) -ne $Target) { throw 'path' }
  $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $trusted = @($user.Value, 'S-1-5-18', 'S-1-5-32-544')
  $installer = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
  $ancestorOwners = $trusted + @($installer)
  if ($Operation -eq 'system') {
    $trusted = @('S-1-5-18', 'S-1-5-32-544', $installer)
    $ancestorOwners = $trusted
  }
  $replace = [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
  # Check reparse points before creation, including parents that already exist.
  $cursor = $Target
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      if ((Get-Item -Force -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'reparse' }
      $parentAcl = Get-Acl -LiteralPath $cursor
      if (!$parentAcl.AreAccessRulesCanonical -or $parentAcl.Access.Count -eq 0 -or
        $ancestorOwners -notcontains $parentAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'parent owner' }
      foreach ($rule in $parentAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
        if ($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value -and
          ($rule.FileSystemRights -band $(if ($Operation -eq 'system') {
            # AddSubdirectory alone at C:\ cannot replace an existing protected path.
            # WriteData on a directory can plant a DLL, so it is refused too.
            $replace -bor $(if ($cursor -eq $Target) { [Security.AccessControl.FileSystemRights]::Write }
              else { [Security.AccessControl.FileSystemRights]::WriteData })
          } else { $replace }))) { throw 'parent replacement' }
      }
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
  if ($Operation -eq 'create' -and !(Test-Path -LiteralPath $Target)) {
    $parent = [IO.Path]::GetDirectoryName($Target)
    if (!(Test-Path -LiteralPath $parent)) { throw 'missing parent' }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($user)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in $trusted) {
      $identity = New-Object Security.Principal.SecurityIdentifier($sid)
      $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($rule)
    }
    [void][IO.Directory]::CreateDirectory($Target, $acl)
  }
  $acl = Get-Acl -LiteralPath $Target
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if (($trusted + $(if ($Operation -eq 'source') { @($installer) } else { @() })) -notcontains $owner) { throw 'owner' }
  if ($Operation -ne 'source' -and $Operation -ne 'system' -and $owner -ne $user.Value) { throw 'private owner' }
  # Empty/null DACLs cannot prove privacy. Sources may be readable by other users,
  # but writable authority is restricted to this user, SYSTEM and Administrators.
  if (!$acl.AreAccessRulesCanonical -or $acl.Access.Count -eq 0) { throw 'acl' }
  $write = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.IdentityReference.Value -eq 'S-1-3-0' -and
      ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
    if ($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value) {
      if (($Operation -ne 'source' -and $Operation -ne 'system') -or ($rule.FileSystemRights -band $write)) { throw 'other principal' }
    }
  }
}
function Invoke-HostChecks([string]$Encoded) {
  $ErrorActionPreference = 'Stop'
  try {
    # Bootstrap uses a fixed OS path, then proves the running checker itself.
    Test-HostAccess 'system' 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
    $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Encoded)) | ConvertFrom-Json
    foreach ($check in $request.checks) {
      if (@('create','private','source','system') -notcontains $check[0]) { throw 'operation' }
      Test-HostAccess $check[0] $check[1]
    }
    $started = 'unknown'
    if ($request.ownerPid -and $request.ownerPid -gt 0) {
      try {
        $process = [Diagnostics.Process]::GetProcessById([int]$request.ownerPid)
        try { $started = [Math]::Floor(($process.StartTime.ToUniversalTime() - [DateTime]'1970-01-01').TotalMilliseconds) }
        finally { $process.Dispose() }
      } catch [ArgumentException] { $started = $null }
      catch { $started = 'unknown' }
    }
    [Console]::Out.WriteLine((@{ownerStarted=$started} | ConvertTo-Json -Compress))
  } catch { [Console]::Error.WriteLine('HOST_CACHE_UNSAFE'); exit 65 }
}
