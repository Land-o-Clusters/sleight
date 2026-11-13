$ErrorActionPreference = 'Stop'
# Instantiation checks UIA availability without reading a window or generating input.
$key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion')
try {
  $build = [int]$key.GetValue('CurrentBuildNumber')
  $revision = [int]$key.GetValue('UBR')
} finally { $key.Close() }
$uia = $null
$available = $false
try {
  $type = [Type]::GetTypeFromCLSID([Guid]'ff48dba4-60ef-4201-aa87-54103eef594e', $true)
  $uia = [Activator]::CreateInstance($type)
  $available = $null -ne $uia
} catch {
  $available = $false
} finally {
  if ($null -ne $uia) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($uia) }
}
@{ build = $build; revision = $revision; architecture = $env:PROCESSOR_ARCHITECTURE; uiaAvailable = $available } | ConvertTo-Json -Compress
