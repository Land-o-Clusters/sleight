# Data-only discovery for sleight-mcp.cmd. Emit exactly one absolute node.exe path.
$ErrorActionPreference = 'Stop'
# Private UTF-8 streams leave a shared console's input and output code pages untouched.
$outputWriter = [IO.StreamWriter]::new([Console]::OpenStandardOutput(), [Text.UTF8Encoding]::new($false))
$outputWriter.AutoFlush = $true
$homeFolder = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
function Test-NodeLocation([string]$File) {
    $profileFolder = $homeFolder
    if ($File -notmatch '^[A-Za-z]:\\' -or [IO.Path]::GetFullPath($File) -cne $File) { return $false }
    $cursor = $File
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -Force -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint) { [Console]::Error.WriteLine('sleight: Node path contains a reparse point; nvm-windows, fnm and Scoop links are not supported.'); return $false }
        }
        if ([IO.Directory]::Exists($cursor)) {
            if ((Test-Path -LiteralPath ([IO.Path]::Combine($cursor, '.git'))) -or
                ($cursor -ine $profileFolder -and (Test-Path -LiteralPath ([IO.Path]::Combine($cursor, 'package.json'))))) { [Console]::Error.WriteLine('sleight: Node is under a project marker (.git or package.json).'); return $false }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    return [IO.File]::Exists($File)
}
$candidates = @()
# GetFolderPath reads Windows account/OS roots, not caller-supplied ProgramFiles variables.
foreach ($kind in @([Environment+SpecialFolder]::ProgramFiles, [Environment+SpecialFolder]::ProgramFilesX86)) {
    $root = [Environment]::GetFolderPath($kind)
    if ($root) { $candidates += [IO.Path]::Combine($root, 'nodejs', 'node.exe') }
}
foreach ($entry in ($env:PATH -split ';')) {
    $entry = $entry.Trim('"')
    if ($entry -match '^[A-Za-z]:[\\/]') { $candidates += [IO.Path]::Combine($entry, 'node.exe') }
}
if ($sleightInspect) {
    try {
        $inputReader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false, $true), $false)
        try { $node = ($inputReader.ReadToEnd() | ConvertFrom-Json).node } finally { $inputReader.Dispose() }
        $allowed = @($candidates | ForEach-Object { [IO.Path]::GetFullPath($_) }) -icontains $node
        $ok = $allowed -and (Test-NodeLocation $node)
        $outputWriter.WriteLine((@{ ok = [bool]$ok } | ConvertTo-Json -Compress))
        exit 0
    } catch { $outputWriter.WriteLine('{"ok":false}'); exit 1 }
}
foreach ($candidate in ($candidates | Select-Object -Unique)) {
    try {
        $candidate = [IO.Path]::GetFullPath($candidate)
        if (-not (Test-NodeLocation $candidate)) { continue }
        $version = & $candidate --version 2>$null
        if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v([0-9]+)\.[0-9]+\.[0-9]+$') { continue }
        if ([int]$Matches[1] -lt 24) {
            [Console]::Error.WriteLine('sleight: Node 24 or later is required; found ' + $version + '. Update this Node installation.')
            continue
        }
        $outputWriter.WriteLine($candidate)
        exit 0
    } catch { }
}
exit 1
