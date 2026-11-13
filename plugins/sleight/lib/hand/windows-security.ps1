# Current-user cursor rendezvous only. No settings, app inspection or input.
$ErrorActionPreference = 'Stop'
$output = [Console]::OpenStandardOutput()
$utf8 = [System.Text.UTF8Encoding]::new($false)
function Write-Reply([string]$text) {
    $bytes = $utf8.GetBytes($text + "`n")
    $output.Write($bytes, 0, $bytes.Length)
    $output.Flush()
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$keyPath = 'Software\sleight\cursor\renderers'
# Add-Type's compiler needs a writable account temp folder. Do not inherit a caller-selected TEMP.
$accountTemp = [IO.Path]::Combine([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData), 'Temp')
if (-not [IO.Directory]::Exists($accountTemp)) { throw 'Missing Windows account temp folder' }
$env:TEMP = $accountTemp
$env:TMP = $accountTemp

function Test-Descriptor($descriptor, $mask) {
    if ($null -eq $descriptor.Owner -or $descriptor.Owner.Value -ne $sid.Value) { return $false }
    if (($descriptor.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0) { return $false }
    $dacl = $descriptor.DiscretionaryAcl
    if ($null -eq $dacl -or $dacl.Count -ne 1) { return $false }
    $ace = $dacl[0]
    return ($ace -is [Security.AccessControl.CommonAce] -and -not $ace.IsCallback -and
        $ace.AceFlags -eq [Security.AccessControl.AceFlags]::None -and
        $ace.AceQualifier -eq [Security.AccessControl.AceQualifier]::AccessAllowed -and
        $ace.SecurityIdentifier.Value -eq $sid.Value -and $ace.AccessMask -eq $mask)
}
function Open-Registry([bool]$write = $false) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath, $write)
    if ($null -eq $key) { return $null }
    $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($key.GetAccessControl().GetSecurityDescriptorBinaryForm(), 0)
    if (-not (Test-Descriptor $raw 0xf003f)) { $key.Dispose(); throw 'Unsafe cursor registry ACL' }
    return $key
}
function Test-Entry {
    if ($entry.sid -ne $sid.Value -or $entry.name -cnotmatch '^[A-Za-z0-9_-]{1,32}$' -or
        $entry.token -cnotmatch '^[a-f0-9]{32}$' -or $entry.pid -le 0 -or
        $entry.pipe -cne "\\.\pipe\sleight-cursor-$($sid.Value)-$($entry.name)") { throw 'Invalid cursor entry' }
}
function Test-Marker($key) {
    if ($null -eq $key) { return $false }
    $value = $key.GetValue($entry.name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($value -isnot [string] -or $value.Length -gt 2048) { return $false }
    try { $current = $value | ConvertFrom-Json } catch { return $false }
    return ($current.token -ceq $entry.token -and $current.sid -ceq $entry.sid -and
        $current.pipe -ceq $entry.pipe -and $current.pid -eq $entry.pid -and $current.name -ceq $entry.name)
}
function Error-Code($failure) {
    for ($e = $failure.Exception; $null -ne $e; $e = $e.InnerException) {
        if (($e.HResult -band 0xffff) -eq 5) { return 'ACCESS_DENIED' }
    }
    return 'CHECK_FAILED'
}
try {
    if (-not ('CursorPipeSecurity' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CursorPipeSecurity {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool GetNamedPipeServerProcessId(SafeFileHandle pipe, out uint pid);
    [DllImport("advapi32.dll")]
    public static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")]
    public static extern uint SetSecurityInfo(SafeFileHandle handle, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError=true)]
    public static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
    [DllImport("advapi32.dll")]
    public static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")]
    public static extern IntPtr LocalFree(IntPtr memory);
}
'@ | Out-Null
    }
} catch {
    Write-Reply (@{ startupError = (Error-Code $_) } | ConvertTo-Json -Compress)
    exit 1
}
function Test-Pipe([bool]$seal = $false) {
    # A control-only client handle never sends event data. SQOS prevents server impersonation.
    $access = [uint32]0x20080 # READ_CONTROL | FILE_READ_ATTRIBUTES
    if ($seal) { $access = $access -bor 0x40000 } # WRITE_DAC
    $handle = [CursorPipeSecurity]::CreateFile($entry.pipe, $access, 0, [IntPtr]::Zero, 3, 0x100000, [IntPtr]::Zero)
    if ($handle.IsInvalid) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $handle.Dispose()
        if ($code -eq 5) { throw [UnauthorizedAccessException]::new() }
        return $false
    }
    try {
        [uint32]$serverPid = 0
        if (-not [CursorPipeSecurity]::GetNamedPipeServerProcessId($handle, [ref]$serverPid) -or $serverPid -ne $entry.pid) { return $false }
        $owner = $group = $dacl = $sacl = $descriptor = [IntPtr]::Zero
        if ([CursorPipeSecurity]::GetSecurityInfo($handle, 1, 5, [ref]$owner, [ref]$group, [ref]$dacl, [ref]$sacl, [ref]$descriptor) -ne 0) { return $false }
        try {
            $bytes = New-Object byte[] ([CursorPipeSecurity]::GetSecurityDescriptorLength($descriptor))
            [Runtime.InteropServices.Marshal]::Copy($descriptor, $bytes, 0, $bytes.Length)
            $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($bytes, 0)
            if ($raw.Owner.Value -ne $sid.Value) { return $false }
        } finally { [CursorPipeSecurity]::LocalFree($descriptor) | Out-Null }
        if ($seal) {
            $replacement = [IntPtr]::Zero; [uint32]$size = 0
            if ($entry.sddl -cne "O:$($sid.Value)D:P(A;;GA;;;$($sid.Value))") { return $false }
            if (-not [CursorPipeSecurity]::ConvertStringSecurityDescriptorToSecurityDescriptor($entry.sddl, 1, [ref]$replacement, [ref]$size)) { return $false }
            try {
                $present = $defaulted = $false; $newDacl = [IntPtr]::Zero
                if (-not [CursorPipeSecurity]::GetSecurityDescriptorDacl($replacement, [ref]$present, [ref]$newDacl, [ref]$defaulted) -or -not $present) { return $false }
                if ([CursorPipeSecurity]::SetSecurityInfo($handle, 1, [uint32]2147483652, [IntPtr]::Zero, [IntPtr]::Zero, $newDacl, [IntPtr]::Zero) -ne 0) { return $false }
            } finally { [CursorPipeSecurity]::LocalFree($replacement) | Out-Null }
        }
        $descriptor = [IntPtr]::Zero
        if ([CursorPipeSecurity]::GetSecurityInfo($handle, 1, 5, [ref]$owner, [ref]$group, [ref]$dacl, [ref]$sacl, [ref]$descriptor) -ne 0) { return $false }
        try {
            $bytes = New-Object byte[] ([CursorPipeSecurity]::GetSecurityDescriptorLength($descriptor))
            [Runtime.InteropServices.Marshal]::Copy($descriptor, $bytes, 0, $bytes.Length)
            $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($bytes, 0)
            return ((Test-Descriptor $raw 0x1f01ff) -or (Test-Descriptor $raw 0x10000000))
        } finally { [CursorPipeSecurity]::LocalFree($descriptor) | Out-Null }
    } finally { $handle.Dispose() }
}

function Invoke-Operation($Operation, $entry) {
$result = $true
switch ($Operation) {
    'identity' { $result = $sid.Value }
    'prepare' {
        $key = Open-Registry $true
        if ($null -eq $key) {
            $acl = [System.Security.AccessControl.RegistrySecurity]::new()
            $acl.SetSecurityDescriptorSddlForm("O:$($sid.Value)D:P(A;;KA;;;$($sid.Value))")
            $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($keyPath, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, $acl)
        }
        $key.Dispose(); $key = Open-Registry; $key.Dispose()
    }
    'list' {
        $key = Open-Registry
        $result = @()
        if ($null -ne $key) {
            try {
                foreach ($name in @($key.GetValueNames() | Sort-Object | Select-Object -First 16)) {
                    try {
                        $value = $key.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                        if ($value -is [string] -and $value.Length -le 2048) {
                            $item = $value | ConvertFrom-Json
                            if ($item.name -ceq $name) { $result += $item }
                        }
                    } catch { }
                }
            } finally { $key.Dispose() }
        }
    }
    'seal' { Test-Entry; if (-not (Test-Pipe $true)) { throw 'Could not seal cursor pipe' } }
    'verify' {
        Test-Entry; $key = Open-Registry
        try { $result = ((Test-Marker $key) -and (Test-Pipe)) } finally { if ($key) { $key.Dispose() } }
    }
    'publish' {
        Test-Entry
        if (-not (Test-Pipe)) { throw 'Unsafe cursor pipe' }
        $key = Open-Registry $true
        if ($null -eq $key) { throw 'Missing cursor registry' }
        try { $key.SetValue($entry.name, ($entry | ConvertTo-Json -Compress), [Microsoft.Win32.RegistryValueKind]::String) }
        finally { $key.Dispose() }
    }
    'remove' {
        Test-Entry; $key = Open-Registry $true
        if ($null -ne $key) {
            try { if (Test-Marker $key) { $key.DeleteValue($entry.name, $false) } } finally { $key.Dispose() }
        }
    }
}
return ,$result
}

# Compilation is complete before per-operation deadlines start.
Write-Reply '{"ready":true}'
while ($null -ne ($line = [Console]::ReadLine())) {
    $request = $null
    try {
        if ($line.Length -gt 65536) { throw 'Cursor request too large' }
        $request = $line | ConvertFrom-Json
        if ($request.operation -cnotin @('identity', 'prepare', 'list', 'seal', 'verify', 'publish', 'remove')) { throw 'Invalid cursor operation' }
        $result = Invoke-Operation $request.operation $request.entry
        $reply = @{ id = $request.id; ok = $true; result = $result }
    } catch { $reply = @{ id = $request.id; ok = $false; error = (Error-Code $_) } }
    Write-Reply (ConvertTo-Json -InputObject $reply -Compress -Depth 8)
}
