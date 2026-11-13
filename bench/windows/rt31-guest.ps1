param(
  [ValidateSet('setup','read','restore','close')][string]$Operation,
  [string]$Bank,
  [ValidatePattern('^[0-9]{1,4}$')][string]$Invocation = '0',
  [string]$GuestRoot = 'C:\sleight',
  [string]$Node = 'C:\Program Files\nodejs\node.exe',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
if ($DryRun) {
  @{ operation = $Operation; interactiveTask = $true; fixture = '0123456789'; layout = '00000409'; input = $false; capture = $false } | ConvertTo-Json -Compress
  exit 0
}
$log = Join-Path $Bank "$Operation-$Invocation.json"
$rc = Join-Path $Bank "$Operation-$Invocation.rc"
$statePath = Join-Path $Bank 'fixture.json'
$status = 1
function Backup-NotepadState([string]$phase) {
  try {
    # Rename opaque directories only. Never inspect a restored tab's contents.
    if (@(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -ieq 'Notepad' }).Count -ne 0) { throw 'NOTEPAD_ALREADY_RUNNING' }
    $localState = Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.WindowsNotepad_8wekyb3d8bbwe\LocalState'
    $backup = Join-Path $Bank ("notepad-state-{0}-{1}-{2}" -f $phase, $Invocation, [Guid]::NewGuid().ToString('N'))
    foreach ($name in @('TabState', 'WindowState')) {
      if (@(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -ieq 'Notepad' }).Count -ne 0) { throw 'NOTEPAD_ALREADY_RUNNING' }
      $source = Join-Path $localState $name
      if (-not (Test-Path -LiteralPath $source)) { continue }
      if (-not (Test-Path -LiteralPath $backup)) {
        New-Item -ItemType Directory -Path $backup -ErrorAction Stop | Out-Null
      }
      if (@(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -ieq 'Notepad' }).Count -ne 0) { throw 'NOTEPAD_ALREADY_RUNNING' }
      # Directory.Move is a rename, with no copy/delete fallback or overwrite.
      [IO.Directory]::Move($source, (Join-Path $backup $name))
    }
  } catch {
    if ($_.Exception.Message -ceq 'NOTEPAD_ALREADY_RUNNING') { throw }
    throw 'GUEST_NOTEPAD_STATE_BACKUP_FAILED'
  }
}
try {
  if ($Bank -notmatch '^C:\\sleight-setup\\rt31-[a-f0-9]{16}$') { throw 'BANK_IDENTITY' }
  if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { throw 'INTERACTIVE_SESSION_REQUIRED' }
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'UNELEVATED_REQUIRED' }
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class RT31Read {
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint idThread);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
}
'@
  if (-not [RT31Read]::SetProcessDpiAwarenessContext([IntPtr](-4))) { throw 'GUEST_DPI_CONTEXT_UNAVAILABLE' }
  if ($Operation -eq 'setup') {
    if (Test-Path $statePath) { throw 'FIXTURE_EXISTS' }
    if (@(Get-Process notepad -ErrorAction SilentlyContinue).Count -ne 0) { throw 'NOTEPAD_ALREADY_RUNNING' }
    Backup-NotepadState 'setup'
    $token = 'SIT1-' + (Split-Path $Bank -Leaf)
    $file = Join-Path $Bank "$token.txt"
    [IO.File]::WriteAllText($file, '0123456789', [Text.Encoding]::ASCII)
    @{ token = $token } | ConvertTo-Json -Compress | Set-Content $statePath -Encoding utf8
    Start-Process notepad.exe -ArgumentList @($file) | Out-Null
    $deadline = (Get-Date).AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 250
      $raw = & $Node (Join-Path $Bank 'rt31-guest-read.mjs') discover $GuestRoot $statePath 2>$null
      $found = $LASTEXITCODE -eq 0
    } while (-not $found -and (Get-Date) -lt $deadline)
    if (-not $found) { throw 'NOTEPAD_NOT_FIXTURE' }
    $state = $raw | ConvertFrom-Json
    $state | ConvertTo-Json -Compress | Set-Content $statePath -Encoding utf8
  } else {
    $state = Get-Content $statePath -Raw | ConvertFrom-Json
  }
  $boundRead = & $Node (Join-Path $Bank 'rt31-guest-read.mjs') read $GuestRoot $statePath
  if ($LASTEXITCODE -ne 0) { throw 'GUEST_DRIVER_IDENTITY_FAILED' }
  $hwnd = [IntPtr]([Int64]$state.windowId)
  if (-not [RT31Read]::IsWindowVisible($hwnd)) { throw 'GUEST_NOTEPAD_NOT_VISIBLE' }
  if ($Operation -ne 'close' -and [RT31Read]::GetForegroundWindow() -ne $hwnd) { throw 'GUEST_NOTEPAD_NOT_FRONTMOST' }
  $window = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $window -or $window.Current.Name -notlike "*$($state.token)*") { throw 'NOTEPAD_NOT_FIXTURE' }
  $notepadPid = $window.Current.ProcessId
  $process = Get-Process -Id $notepadPid
  if ($process.ProcessName -ne 'Notepad') { throw 'NOTEPAD_NOT_FIXTURE' }
  if ($process.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) -ne $state.processStart) { throw 'GUEST_PROCESS_IDENTITY_CHANGED' }
  $wp = $window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern)
  if ($wp.Current.IsModal -or $wp.Current.WindowInteractionState -notin @([Windows.Automation.WindowInteractionState]::Running,
      [Windows.Automation.WindowInteractionState]::ReadyForUserInteraction)) { throw 'GUEST_WINDOW_BLOCKED' }
  $menuCondition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Menu)
  foreach ($m in $window.FindAll([Windows.Automation.TreeScope]::Descendants, $menuCondition)) {
    if (-not $m.Current.IsOffscreen) { throw 'GUEST_MENU_OPEN' }
  }
  $tabCondition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)
  $tabs = $window.FindAll([Windows.Automation.TreeScope]::Descendants, $tabCondition)
  if ($tabs.Count -gt 1) { throw 'GUEST_EXTRA_TABS' }
  $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::IsTextPatternAvailableProperty, $true)
  $editors = $window.FindAll([Windows.Automation.TreeScope]::Descendants, $condition)
  $candidates = @()
  foreach ($e in $editors) {
    if ($e.Current.ProcessId -eq $notepadPid -and -not $e.Current.IsPassword -and -not $e.Current.IsOffscreen -and
        $e.Current.ControlType -in @([Windows.Automation.ControlType]::Document, [Windows.Automation.ControlType]::Edit)) { $candidates += $e }
  }
  if ($candidates.Count -ne 1) { throw 'NOTEPAD_NOT_FIXTURE' }
  $editor = $candidates[0]
  $pattern = $editor.GetCurrentPattern([Windows.Automation.TextPattern]::Pattern)
  if ($Operation -eq 'close') {
    # Normal close of the bound window only. No process kill, SendInput,
    # foreground request or clipboard access. Discard only its own save dialog.
    $wp.Close()
    $deadline = (Get-Date).AddSeconds(10)
    $discarded = $false
    $pidCondition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ProcessIdProperty, $notepadPid)
    do {
      if ($process.HasExited) { break }
      if ($process.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) -ne $state.processStart) { throw 'GUEST_PROCESS_IDENTITY_CHANGED' }
      $roots = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $pidCondition)
      $dialogs = @()
      foreach ($root in $roots) {
        if ($root.Current.NativeWindowHandle -ne $hwnd.ToInt64()) { $dialogs += $root }
        $dialogs += @($root.FindAll([Windows.Automation.TreeScope]::Descendants,
          (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Window))))
      }
      foreach ($dialog in $dialogs) {
        if ($dialog.Current.ProcessId -ne $notepadPid) { throw 'GUEST_CLOSE_DIALOG_IDENTITY' }
        $dialogPattern = $dialog.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern)
        if (-not $dialogPattern.Current.IsModal) { throw 'GUEST_CLOSE_EXTRA_WINDOW' }
        $texts = $dialog.FindAll([Windows.Automation.TreeScope]::Descendants,
          (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Text)))
        $dialogText = @($texts | ForEach-Object { $_.Current.Name }) -join "`n"
        if (-not $dialogText.Contains($state.token)) { throw 'GUEST_CLOSE_DIALOG_IDENTITY' }
        $buttons = @($dialog.FindAll([Windows.Automation.TreeScope]::Descendants,
          (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button))))
        $discard = @($buttons | Where-Object { $_.Current.Name -in @("Don't Save", "Don't save", 'Don’t Save', 'Don’t save') })
        $unknown = @($buttons | Where-Object { $_.Current.Name -notin @("Don't Save", "Don't save", 'Don’t Save', 'Don’t save', 'Save', 'Cancel', '') })
        if ($discarded -or $discard.Count -ne 1 -or $unknown.Count -ne 0) { throw 'GUEST_CLOSE_SHEET_REFUSED' }
        if ($process.HasExited -or $process.StartTime.ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) -ne $state.processStart) { throw 'GUEST_PROCESS_IDENTITY_CHANGED' }
        $discard[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
        $discarded = $true
      }
      Start-Sleep -Milliseconds 100
    } while ((Get-Date) -lt $deadline)
    if (-not $process.HasExited) { throw 'GUEST_CLOSE_UNCONFIRMED' }
    $stateBackup = 'saved'
    try { Backup-NotepadState 'close' } catch { $stateBackup = 'failed' }
    @{ fixture = $true; driverRead = $true; confirmed = $true; closed = $true; discarded = $discarded;
      windowId = $state.windowId; processStart = $state.processStart; stateBackup = $stateBackup } | ConvertTo-Json -Compress | Set-Content $log -Encoding utf8
    $status = 0
    return
  }
  if ($Operation -eq 'restore') {
    # Restore only this retained fixture through UIA. No SendInput, clipboard or preference change.
    $value = $editor.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
    $value.SetValue('0123456789')
    $range = $pattern.DocumentRange.Clone()
    $range.MoveEndpointByRange([Windows.Automation.TextPatternRangeEndpoint]::End, $range, [Windows.Automation.TextPatternRangeEndpoint]::Start)
    $range.Select()
  }
  $text = $pattern.DocumentRange.GetText(128).Replace("`r`n", "`n").TrimEnd("`r", "`n")
  if ($text -notmatch '^[0123456789q\n]{1,64}$') { throw 'GUEST_TEXT_OUTSIDE_FIXTURE' }
  $selected = $pattern.GetSelection()
  if ($selected.Count -ne 1) { throw 'CARET_UNAVAILABLE' }
  $prefix = $pattern.DocumentRange.Clone()
  $prefix.MoveEndpointByRange([Windows.Automation.TextPatternRangeEndpoint]::End, $selected[0], [Windows.Automation.TextPatternRangeEndpoint]::Start)
  $caret = $prefix.GetText(128).Replace("`r`n", "`n").Length
  $selectionLength = $selected[0].GetText(128).Length
  [uint32]$threadPid = 0
  $thread = [RT31Read]::GetWindowThreadProcessId($hwnd, [ref]$threadPid)
  $layout = '{0:x8}' -f ([RT31Read]::GetKeyboardLayout($thread).ToInt64() -band 0xffffffffL)
  if ($layout -ne '00000409') { throw 'GUEST_LAYOUT_NOT_US' }
  if ($Operation -eq 'setup' -and ($text -ne '0123456789' -or $selectionLength -ne 0 -or $caret -ne 0)) { throw 'FIXTURE_NOT_RESET' }
  $raw = & $Node (Join-Path $Bank 'rt31-guest-read.mjs') read $GuestRoot $statePath
  if ($LASTEXITCODE -ne 0) { throw 'GUEST_DRIVER_READ_FAILED' }
  $driver = $raw | ConvertFrom-Json
  $result = @{ fixture = $true; token = $state.token; windowId = $driver.windowId; processStart = $driver.processStart;
    text = $text; caret = $caret; selectionLength = $selectionLength; layout = $layout; driverRead = $driver.driverRead;
    windowsVersion = [Environment]::OSVersion.Version.ToString();
    editorBounds = @($editor.Current.BoundingRectangle.X, $editor.Current.BoundingRectangle.Y, $editor.Current.BoundingRectangle.Width, $editor.Current.BoundingRectangle.Height);
    confirmed = ($Operation -eq 'restore' -and $text -eq '0123456789' -and $caret -eq 0 -and $selectionLength -eq 0) }
  if ($Operation -eq 'setup') {
    if ([Windows.Forms.Screen]::AllScreens.Count -ne 1) { throw 'GUEST_DISPLAY_AMBIGUOUS' }
    $screen = [Windows.Forms.Screen]::PrimaryScreen.Bounds
    if ($screen.X -ne 0 -or $screen.Y -ne 0) { throw 'GUEST_DISPLAY_ORIGIN' }
    function Character-Rect([int]$index) {
      $r = $pattern.DocumentRange.Clone()
      $r.MoveEndpointByRange([Windows.Automation.TextPatternRangeEndpoint]::End, $r, [Windows.Automation.TextPatternRangeEndpoint]::Start)
      $null = $r.MoveEndpointByUnit([Windows.Automation.TextPatternRangeEndpoint]::End, [Windows.Automation.TextUnit]::Character, ($index + 1))
      $null = $r.MoveEndpointByUnit([Windows.Automation.TextPatternRangeEndpoint]::Start, [Windows.Automation.TextUnit]::Character, $index)
      $box = $r.GetBoundingRectangles()
      if ($box.Length -ne 4 -or $box[2] -le 0 -or $box[3] -le 0) { throw 'GUEST_CHARACTER_GEOMETRY' }
      return ,$box
    }
    $two = Character-Rect 2; $five = Character-Rect 5; $four = Character-Rect 4
    $bars = $window.FindAll([Windows.Automation.TreeScope]::Descendants,
      (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::ToolBar)))
    $buttons = @()
    foreach ($bar in $bars) {
      $buttons += @($bar.FindAll([Windows.Automation.TreeScope]::Descendants,
        (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button))))
    }
    $hover = @($buttons | Where-Object { -not $_.Current.IsOffscreen -and $_.Current.IsEnabled -and $_.Current.BoundingRectangle.Width -gt 0 })
    if ($hover.Count -eq 0) { throw 'GUEST_HOVER_GEOMETRY' }
    $h = $hover[0].Current.BoundingRectangle
    $result.guestDesktop = @($screen.Width, $screen.Height)
    $result.guestPoints = @{ text = @(($four[0]+$four[2]/2), ($four[1]+$four[3]/2)); toolbar = @(($h.X+$h.Width/2), ($h.Y+$h.Height/2));
      after5 = @(($five[0]+$five[2]), ($five[1]+$five[3]/2)); after2 = @(($two[0]+$two[2]), ($two[1]+$two[3]/2)) }
  }
  $result | ConvertTo-Json -Compress | Set-Content $log -Encoding utf8
  $status = 0
} catch {
  # Never publish exception text or unrelated UIA values.
  $reason = 'GUEST_FIXTURE_REFUSED'
  if ($_.Exception.Message -cmatch '^[A-Z][A-Z0-9_]{0,79}$') { $reason = $_.Exception.Message }
  @{ fixture = $false; error = $reason } | ConvertTo-Json -Compress | Set-Content $log -Encoding utf8
} finally {
  [IO.File]::WriteAllText($rc, [string]$status, [Text.Encoding]::ASCII)
}
exit $status
