param(
  [ValidateSet('editor', 'cover')][string]$Mode = 'editor'
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SleightWdr7Dpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
}
'@
# Keep fixture coordinates in WPF device-independent units, with per-monitor v2
# rendering. The driver records actual DPI; a refused awareness call is not proof.
[void][SleightWdr7Dpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
[void][SleightWdr7Dpi]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
# Owner-launched VM fixture only. The runner never starts this script.
$window = New-Object System.Windows.Window
$window.WindowStartupLocation = 'Manual'
$window.Left = 40
$window.Top = 40
$window.Width = 640
$window.Height = 480
$window.Title = 'Sleight WDR7 WPF'
$window.Background = [System.Windows.Media.Brushes]::White
if ($Mode -eq 'cover') {
  $window.Title = 'Sleight WDR7 cover'
  $window.Topmost = $true
  # Leave the right quarter of the primary work area free for guest consoles.
  $work = [System.Windows.SystemParameters]::WorkArea
  $window.Left = $work.Left
  $window.Top = $work.Top
  $window.Width = [Math]::Floor($work.Width * 0.75)
  $window.Height = [Math]::Floor($work.Height * 0.96)
  $label = New-Object System.Windows.Controls.TextBlock
  $label.Text = 'WDR7 cover. Put targets fully behind this window and consoles in the free right quarter. Keep this cover open across phases. Click it during the command delay, then wait for the result file.'
  $label.TextWrapping = 'Wrap'
  $label.Margin = '40'
  $window.Content = $label
} else {
  $canvas = New-Object System.Windows.Controls.Canvas
  $window.Content = $canvas
  $editor = New-Object System.Windows.Controls.TextBox
  [System.Windows.Automation.AutomationProperties]::SetAutomationId($editor, 'Editor')
  [System.Windows.Automation.AutomationProperties]::SetName($editor, 'WDR7 editor')
  $editor.AcceptsReturn = $true
  $editor.Text = 'WDR7 WPF initial text'
  $editor.Width = 560
  $editor.Height = 48
  [System.Windows.Controls.Canvas]::SetLeft($editor, 20)
  [System.Windows.Controls.Canvas]::SetTop($editor, 20)
  [void]$canvas.Children.Add($editor)
  $invoke = New-Object System.Windows.Controls.Button
  [System.Windows.Automation.AutomationProperties]::SetAutomationId($invoke, 'InvokeButton')
  $invoke.Content = 'Invoke fixture'
  $invoke.Width = 180
  $invoke.Height = 32
  [System.Windows.Controls.Canvas]::SetLeft($invoke, 20)
  [System.Windows.Controls.Canvas]::SetTop($invoke, 80)
  [void]$canvas.Children.Add($invoke)
  $status = New-Object System.Windows.Controls.TextBlock
  [System.Windows.Automation.AutomationProperties]::SetAutomationId($status, 'Status')
  $status.Text = 'Invoked: 0'
  [System.Windows.Controls.Canvas]::SetLeft($status, 20)
  [System.Windows.Controls.Canvas]::SetTop($status, 130)
  [void]$canvas.Children.Add($status)
  $chord = New-Object System.Windows.Controls.TextBlock
  [System.Windows.Automation.AutomationProperties]::SetAutomationId($chord, 'ChordState')
  $chord.Text = 'Chord: saved 0'
  [System.Windows.Controls.Canvas]::SetLeft($chord, 20)
  [System.Windows.Controls.Canvas]::SetTop($chord, 170)
  [void]$canvas.Children.Add($chord)
  $script:invocations = 0
  $script:chords = 0
  $invoke.Add_Click({ $script:invocations++; $status.Text = 'Invoked: ' + $script:invocations })
  $window.Add_PreviewKeyDown({
    param($sender, $event)
    if ($event.Key -eq [System.Windows.Input.Key]::S -and
        ([System.Windows.Input.Keyboard]::Modifiers -band [System.Windows.Input.ModifierKeys]::Control)) {
      $script:chords++
      $chord.Text = 'Chord: saved ' + $script:chords
      $event.Handled = $true
    }
  })
  $window.Add_ContentRendered({ [void]$editor.Focus() })
}
$window.Add_ContentRendered({
  $handle = (New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
  Write-Host ('WDR7 {0} HWND {1}' -f $Mode, $handle.ToInt64())
})
[void]$window.ShowDialog()
