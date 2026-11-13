# Test data only: add replacement authority to one owned temporary parent.
param([string]$Target)
$ErrorActionPreference = 'Stop'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (![IO.Path]::GetFullPath($Target).StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { exit 65 }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $Target
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]) -ne $user) { exit 65 }
$users = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
$rule = New-Object Security.AccessControl.FileSystemAccessRule($users, 'DeleteSubdirectoriesAndFiles', 'None', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $Target -AclObject $acl
