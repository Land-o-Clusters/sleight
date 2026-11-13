// Read only, scoped to a fixture whose process and HWND the collector owns.
// No names, values, text, screenshots or input are collected.
export function typingReadMetadata(read) {
  return { focusedElement: read.focusedElement, partialTree: read.partialTree,
    focusedRows: [...read.text.matchAll(/^([\t ]*)(\d+) ([^\n]*?) \(focused\)/gm)].map(m => ({
      depth: m[1].length, index: Number(m[2]),
      role: /^(?:text entry area|text field|standard window|group)\b/.exec(m[3])?.[0] ?? 'other',
    })) };
}

export const TYPING_DIAGNOSTIC = String.raw`
  'typing-diagnostic' {
    [void](WindowIdentity $r.fixture)
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TypingFocus {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int l,t,r,b; }
  [StructLayout(LayoutKind.Sequential)] public struct GUI {
    public uint size, flags;
    public IntPtr active, focus, capture, menu, move, caret;
    public RECT rect;
  }
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref GUI info);
}
'@
    $root = [IntPtr]([Int64]$r.fixture.windowId)
    $handles = New-Object 'Collections.Generic.List[IntPtr]'
    $handles.Add($root)
    [void][Uc3fWindow]::EnumChildWindows($root, {
      param($h,$data)
      $handles.Add($h)
      return $handles.Count -lt 256
    },[IntPtr]::Zero)
    if ($handles.Count -ge 256) { throw 'TYPING_DIAGNOSTIC_LIMIT' }
    $native = @()
    foreach ($h in $handles) {
      [uint32]$owner = 0
      $thread = [Uc3fWindow]::GetWindowThreadProcessId($h,[ref]$owner)
      if ($owner -ne $r.fixture.pid) { continue }
      $class = New-Object Text.StringBuilder(256)
      [void][Uc3fWindow]::GetClassNameW($h,$class,256)
      $gui = New-Object TypingFocus+GUI
      $gui.size = [Runtime.InteropServices.Marshal]::SizeOf($gui)
      $ok = [TypingFocus]::GetGUIThreadInfo($thread,[ref]$gui)
      $native += @{ hwnd=$h.ToInt64().ToString(); className=$class.ToString(); thread=$thread;
        guiOk=$ok; focus=$gui.focus.ToInt64().ToString(); active=$gui.active.ToInt64().ToString() }
    }
    $tree = @()
    $queue = New-Object Collections.Queue
    $queue.Enqueue(@{ element=[Windows.Automation.AutomationElement]::FromHandle($root); depth=0 })
    $walker = [Windows.Automation.TreeWalker]::RawViewWalker
    while ($queue.Count -gt 0) {
      if ($tree.Count -ge 256) { throw 'TYPING_DIAGNOSTIC_LIMIT' }
      $entry=$queue.Dequeue(); $element=$entry.element; $current=$element.Current
      if ($current.ProcessId -ne $r.fixture.pid) { continue }
      $patterns=@($element.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName })
      $tree += @{ depth=$entry.depth; hwnd=$current.NativeWindowHandle; className=$current.ClassName;
        type=$current.ControlType.Id; focused=$current.HasKeyboardFocus; enabled=$current.IsEnabled;
        password=$current.IsPassword; patterns=$patterns }
      if ($entry.depth -lt 16) {
        $child=$walker.GetFirstChild($element)
        while ($null -ne $child) {
          if ($queue.Count -ge 256) { throw 'TYPING_DIAGNOSTIC_LIMIT' }
          $queue.Enqueue(@{ element=$child; depth=($entry.depth+1) }); $child=$walker.GetNextSibling($child)
        }
      }
    }
    [void](WindowIdentity $r.fixture)
    $version=[Diagnostics.FileVersionInfo]::GetVersionInfo($r.fixture.image).FileVersion
    @{ schema='sleight.typing-diagnostic/1'; version=$version; target=$r.fixture.target;
      native=$native; tree=$tree; inputSent=0 } | ConvertTo-Json -Depth 8 -Compress
  }
`;
