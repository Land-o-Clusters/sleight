# Run through probe-engine.mjs. Inventory only; no engine launch, pipe write, or injected input.
[CmdletBinding()]
param(
    [string]$PipeName = '',
    [ValidateRange(100,10000)][int]$ConnectMs = 1000,
    [ValidateRange(100,10000)][int]$ReadMs = 1000,
    [ValidateRange(0,120)][int]$ObserveSeconds = 0,
    [string]$SearchRoot1 = '', [string]$SearchRoot2 = '',
    [string]$SearchRoot3 = '', [string]$SearchRoot4 = ''
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if ($env:OS -ne 'Windows_NT') { throw 'This probe requires Windows.' }
if ($PipeName -and ($PipeName -notmatch '^[a-zA-Z0-9_.{}-]{1,240}$' -or $PipeName -in @('.','..'))) {
    throw 'Use one local pipe leaf name.'
}

# Original interop, written from Win32/.NET documentation and the study's behavior notes.
# Capture sends zero bytes. A silent server leaves the handshake unknown.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;
public static class SleightEngineProbe {
    // All capture I/O passes through this counter. The underlying pipe is opened read-only.
    sealed class CountedStream : Stream {
        readonly Stream inner;
        public long BytesWritten { get; private set; }
        public CountedStream(Stream stream) { inner = stream; }
        public override bool CanRead { get { return inner.CanRead; } }
        public override bool CanWrite { get { return inner.CanWrite; } }
        public override bool CanSeek { get { return false; } }
        public override long Length { get { throw new NotSupportedException(); } }
        public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
        public override void Flush() { inner.Flush(); }
        public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
        public override void SetLength(long length) { throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) { return inner.Read(buffer, offset, count); }
        public override System.Threading.Tasks.Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken token) {
            return inner.ReadAsync(buffer, offset, count, token);
        }
        public override void Write(byte[] buffer, int offset, int count) {
            inner.Write(buffer, offset, count); BytesWritten += count;
        }
    }
    public static void VerifyByteCounter() {
        // No pipe or native API: prove synchronous, byte and async writes affect the reported count.
        using (var memory = new MemoryStream()) {
            var counted = new CountedStream(memory);
            counted.Write(new byte[3], 0, 3);
            counted.WriteByte(1);
            counted.WriteAsync(new byte[2], 0, 2).Wait();
            if (counted.BytesWritten != 6 || memory.Length != 6) throw new InvalidOperationException("pipe-byte-counter-selftest");
        }
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint server);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    delegate IntPtr MouseCallback(int code, IntPtr message, IntPtr data);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetWindowsHookEx(int kind, MouseCallback callback, IntPtr module, uint thread);
    [DllImport("user32.dll", SetLastError=true)] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct MouseEvent {
        public Point point; public uint mouseData, flags, time; public UIntPtr extraInfo;
    }
    [StructLayout(LayoutKind.Sequential)] struct Message {
        public IntPtr window; public uint message; public UIntPtr wParam; public IntPtr lParam;
        public uint time; public Point point; public uint reserved;
    }
    public sealed class CaptureResult {
        public bool connected; public uint serverPid; public int serverPidError;
        public long bytesWritten; public byte[] bytes = new byte[0];
        public string outcome = "not-requested"; public double elapsedMs;
    }
    public static CaptureResult Capture(string name, int connectMs, int readMs) {
        var result = new CaptureResult(); var watch = Stopwatch.StartNew();
        using (var pipe = new NamedPipeClientStream(".", name, PipeDirection.In, PipeOptions.Asynchronous)) {
            var counted = new CountedStream(pipe);
            try {
                pipe.Connect(connectMs); result.connected = true;
                uint server;
                if (GetNamedPipeServerProcessId(pipe.SafePipeHandle, out server)) result.serverPid = server;
                else result.serverPidError = Marshal.GetLastWin32Error();
                // Keep only the initial bounded prefix. Disposal cancels a pending asynchronous read.
                using (var prefix = new MemoryStream()) {
                    var deadline = watch.ElapsedMilliseconds + readMs;
                    while (prefix.Length < 16384 && watch.ElapsedMilliseconds < deadline) {
                        var buffer = new byte[Math.Min(4096, 16384 - (int)prefix.Length)];
                        var read = counted.ReadAsync(buffer, 0, buffer.Length);
                        if (!read.Wait((int)Math.Max(1, deadline - watch.ElapsedMilliseconds))) {
                            result.outcome = "read-timeout"; break;
                        }
                        int count = read.Result;
                        if (count == 0) { result.outcome = "eof"; break; }
                        prefix.Write(buffer, 0, count);
                    }
                    result.bytes = prefix.ToArray();
                    if (prefix.Length == 16384) result.outcome = "byte-limit";
                }
            } catch (TimeoutException) { result.outcome = "connect-timeout"; }
            catch (UnauthorizedAccessException) { result.outcome = "access-denied"; }
            catch (Exception) { result.outcome = "pipe-error"; }
            finally { result.bytesWritten = counted.BytesWritten; }
        }
        result.elapsedMs = watch.Elapsed.TotalMilliseconds; return result;
    }
    public sealed class Foreground {
        public string hwnd; public uint pid; public double ms;
    }
    static Foreground Snapshot(Stopwatch watch) {
        IntPtr window = GetForegroundWindow(); uint process;
        GetWindowThreadProcessId(window, out process);
        return new Foreground { hwnd = "0x" + window.ToInt64().ToString("x"), pid = process, ms = watch.Elapsed.TotalMilliseconds };
    }
    public sealed class Click {
        public double downMs; public Nullable<double> upMs;
        public uint eventTickMs; public bool injected, lowerIntegrityInjected;
        public Foreground before; public Foreground atDown; public Foreground after;
    }
    public sealed class Observation {
        public string attribution = "external-input: injected flags identify injection, not the originating process";
        public string clock = "Stopwatch milliseconds since observation start";
        public int pollMs = 10; public string startedUtc; public Foreground initial; public Foreground final;
        public List<Foreground> transitions = new List<Foreground>();
        public List<Click> clicks = new List<Click>(); public bool truncated, hookInstalled, hookRemoved, callbackError;
        public int hookError;
    }
    public static Observation Observe(int seconds) {
        var watch = Stopwatch.StartNew(); var result = new Observation { startedUtc = DateTime.UtcNow.ToString("o") };
        var previous = Snapshot(watch); result.initial = previous;
        Click current = null;
        IntPtr hook = IntPtr.Zero;
        MouseCallback callback = delegate(int code, IntPtr message, IntPtr data) {
            try {
                // WH_MOUSE_LL observes down/up even when both happen inside a single polling interval.
                if (code == 0 && message.ToInt64() == 0x201) {
                    var input = (MouseEvent)Marshal.PtrToStructure(data, typeof(MouseEvent));
                    current = new Click { downMs = watch.Elapsed.TotalMilliseconds, eventTickMs = input.time,
                        injected = (input.flags & 1) != 0, lowerIntegrityInjected = (input.flags & 2) != 0,
                        before = previous, atDown = Snapshot(watch) };
                    if (result.clicks.Count < 128) result.clicks.Add(current); else result.truncated = true;
                } else if (code == 0 && message.ToInt64() == 0x202 && current != null) {
                    current.upMs = watch.Elapsed.TotalMilliseconds; current = null;
                }
            } catch { result.callbackError = true; }
            // Always forward the input without consuming or changing it.
            return CallNextHookEx(hook, code, message, data);
        };
        hook = SetWindowsHookEx(14, callback, GetModuleHandle(null), 0);
        if (hook == IntPtr.Zero) { result.hookError = Marshal.GetLastWin32Error(); result.final = previous; return result; }
        result.hookInstalled = true;
        Console.Error.WriteLine("SLEIGHT_OBSERVER_READY");
        try {
            while (watch.Elapsed.TotalSeconds < seconds) {
                Message message;
                for (int n = 0; n < 1024 && PeekMessage(out message, IntPtr.Zero, 0, 0, 1); n++) {
                    TranslateMessage(ref message); DispatchMessage(ref message);
                }
                var now = Snapshot(watch);
                if (now.hwnd != previous.hwnd) {
                    if (result.transitions.Count < 512) result.transitions.Add(now); else result.truncated = true;
                }
                foreach (var click in result.clicks) if (click.after == null && now.ms >= click.downMs + 100) click.after = now;
                previous = now;
                Thread.Sleep(10);
            }
        } finally {
            result.hookRemoved = UnhookWindowsHookEx(hook);
            GC.KeepAlive(callback);
        }
        result.final = previous; return result;
    }
}
'@
[SleightEngineProbe]::VerifyByteCounter()

$errors = New-Object 'System.Collections.Generic.List[string]'
$packages = @()
try {
    $packages = @(Get-AppxPackage | Where-Object { $_.Name -match '(?i)openai|chatgpt|codex' } |
        Select-Object Name, Version, Architecture, InstallLocation)
} catch { $errors.Add('appx-inventory-unavailable') }
$processes = @()
$allProcesses = @()
try {
    $allProcesses = @(Get-CimInstance Win32_Process)
    $processes = @($allProcesses | Where-Object { $_.Name -match '(?i)^(chatgpt|codex.*|cua.*|node)\.exe$' } | ForEach-Object {
        [ordered]@{ pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId; name = $_.Name;
            path = $_.ExecutablePath; created = [string]$_.CreationDate }
    })
} catch { $errors.Add('process-inventory-unavailable') }

$roots = New-Object 'System.Collections.Generic.List[string]'
foreach ($package in $packages) { if ($package.InstallLocation) { $roots.Add($package.InstallLocation) } }
foreach ($process in $processes) {
    if ($process.path -and $process.name -match '(?i)chatgpt|codex|cua') { $roots.Add([IO.Path]::GetDirectoryName($process.path)) }
}
if ($env:USERPROFILE) {
    $pluginRoot = Join-Path $env:USERPROFILE '.codex\plugins\cache\openai-bundled\unified-computer-use'
    if (Test-Path -LiteralPath $pluginRoot -PathType Container) { $roots.Add($pluginRoot) }
}
foreach ($root in @($SearchRoot1,$SearchRoot2,$SearchRoot3,$SearchRoot4)) {
    if ($root) {
        if ($root -notmatch '^[a-zA-Z]:\\' -or $root.Contains('..')) { throw 'Search roots must be local absolute paths without traversal.' }
        $roots.Add($root)
    }
}
# No whole-disk or WindowsApps ownership changes. Reparse points are never traversed.
$engines = New-Object 'System.Collections.Generic.List[object]'
$nodes = New-Object 'System.Collections.Generic.List[object]'
$enginePaths = @{}; $nodePaths = @{}
$searchComplete = $true; $entries = 0; $scan = [Diagnostics.Stopwatch]::StartNew()
$queue = New-Object 'System.Collections.Generic.Queue[object]'
foreach ($root in @($roots | Select-Object -Unique)) {
    try {
        $ancestor = New-Object -TypeName System.IO.DirectoryInfo -ArgumentList ([IO.Path]::GetFullPath($root))
        $plain = $true
        while ($null -ne $ancestor) {
            if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { $plain = $false; break }
            $ancestor = $ancestor.Parent
        }
        if ($plain) { $queue.Enqueue(@{ path = $root; depth = 0 }) }
        else { $errors.Add('search-root-reparse-point'); $searchComplete = $false }
    } catch { $errors.Add('search-root-unreadable'); $searchComplete = $false }
}
while ($queue.Count -gt 0) {
    if ($entries -ge 30000 -or $scan.Elapsed.TotalSeconds -gt 15) { $errors.Add('search-limit'); $searchComplete = $false; break }
    $item = $queue.Dequeue()
    try {
        $directory = Get-Item -LiteralPath $item.path -Force
        if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { $searchComplete = $false; continue }
        foreach ($file in @(Get-ChildItem -LiteralPath $item.path -Force)) {
            $entries++
            if ($entries -gt 30000) { break }
            if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { $searchComplete = $false; continue }
            if ($file.PSIsContainer) {
                if ($item.depth -lt 10) { $queue.Enqueue(@{ path = $file.FullName; depth = $item.depth + 1 }) }
                else { $searchComplete = $false }
            } elseif ($file.Name -match '^codex-computer-use(?:-arm64)?\.exe$' -and !$enginePaths.ContainsKey($file.FullName)) {
                $enginePaths[$file.FullName] = $true
                $engines.Add([ordered]@{ path = $file.FullName; bytes = $file.Length; architecture = 'unchecked' })
            } elseif ($file.Name -eq 'node.exe' -and !$nodePaths.ContainsKey($file.FullName)) {
                $nodePaths[$file.FullName] = $true; $nodes.Add([ordered]@{ path = $file.FullName; bytes = $file.Length; launched = $false })
            }
        }
    } catch { $errors.Add('search-directory-unreadable'); $searchComplete = $false }
}
if ($roots.Count -eq 0) { $searchComplete = $false; $errors.Add('no-install-roots') }
$pipes = @()
$pipeCandidates = @()
try {
    $allPipes = @([IO.Directory]::GetFiles('\\.\pipe\') | ForEach-Object { $_ -replace '^\\\\\.\\pipe\\', '' } | Sort-Object -Unique)
    $pipes = @($allPipes | Select-Object -First 2048)
    $pipeCandidates = @($allPipes | Where-Object { $_ -match '(?i)codex|sky|cua|chatgpt|openai' } | Select-Object -First 256)
    if ($allPipes.Count -gt 2048) { $errors.Add('pipe-list-limit') }
} catch { $errors.Add('pipe-enumeration-unavailable') }

# Only schema keys and types survive. No arbitrary string, id, token, value, text or document content is saved.
$shapeKeys = @('jsonrpc','id','method','params','result','error','code','message','data','name','arguments',
    'capabilities','protocolVersion','serverInfo','clientInfo','tools','riskLevel','allowPersistentApproval',
    'x-codex-turn-metadata','session_id','turn_id','tool_name','tool_params','app','content','type')
function Frame-Shape($value, [int]$depth = 0) {
    if ($null -eq $value) { return 'null' }
    if ($depth -ge 5) { return 'depth-limit' }
    if ($value -is [string]) { return 'string' }
    if ($value -is [bool]) { return 'boolean' }
    if ($value -is [ValueType]) { return 'number' }
    if ($value -is [array]) { return ,@('array', @($value | Select-Object -First 4 | ForEach-Object { Frame-Shape $_ ($depth+1) })) }
    $shape = [ordered]@{}; $other = 0
    foreach ($property in $value.PSObject.Properties) {
        if ($shapeKeys -ccontains $property.Name) { $shape[$property.Name] = Frame-Shape $property.Value ($depth+1) } else { $other++ }
    }
    if ($other) { $shape['otherKeyCount'] = $other }
    return $shape
}
$connection = [ordered]@{ requested = [bool]$PipeName; pipe = $PipeName; connected = $false; serverPid = 0;
    bytesWritten = 0; bytesRead = 0; framing = 'unknown'; frames = @(); outcome = 'not-requested'; elapsedMs = 0 }
if ($PipeName) {
    $capture = [SleightEngineProbe]::Capture($PipeName, $ConnectMs, $ReadMs)
    $connection.bytesWritten = $capture.bytesWritten
    $connection.connected = $capture.connected; $connection.serverPid = $capture.serverPid
    $connection['serverPidError'] = $capture.serverPidError
    $connection.bytesRead = $capture.bytes.Length; $connection.outcome = $capture.outcome; $connection.elapsedMs = $capture.elapsedMs
    if ($capture.serverPid) {
        # The measured pipe server can have an unexpected name. Include its parent metadata as well.
        try { $allProcesses = @(Get-CimInstance Win32_Process) }
        catch { $allProcesses = @(); $errors.Add('pipe-server-metadata-unavailable') }
        $connection['serverSnapshotUtc'] = [DateTime]::UtcNow.ToString('o')
        foreach ($id in @($capture.serverPid)) {
            $server = @($allProcesses | Where-Object { $_.ProcessId -eq $id })
            foreach ($proc in $server) {
                $connection['server'] = [ordered]@{ pid = [int]$proc.ProcessId; parentPid = [int]$proc.ParentProcessId;
                    name = $proc.Name; path = $proc.ExecutablePath; created = [string]$proc.CreationDate }
                $parent = @($allProcesses | Where-Object { $_.ProcessId -eq $proc.ParentProcessId } | Select-Object -First 1)
                if ($parent.Count) { $connection['parent'] = [ordered]@{ pid = [int]$parent[0].ProcessId; name = $parent[0].Name; path = $parent[0].ExecutablePath } }
            }
        }
    }
    $text = [Text.Encoding]::UTF8.GetString($capture.bytes)
    $frames = New-Object 'System.Collections.Generic.List[object]'
    # Recognize JSON lines and Content-Length framing, preserving at most four complete frames.
    if ($text -match '^(?i)Content-Length:') {
        $connection.framing = 'content-length'
        $offset = 0
        while ($frames.Count -lt 4 -and $offset -lt $capture.bytes.Length) {
            $tail = [Text.Encoding]::UTF8.GetString($capture.bytes, $offset, $capture.bytes.Length - $offset)
            if ($tail -notmatch '^(?i)Content-Length: ([0-9]{1,5})\r\n\r\n') { break }
            $headerBytes = [Text.Encoding]::ASCII.GetByteCount($Matches[0]); $length = [int]$Matches[1]
            if ($length -gt 16384 -or $offset + $headerBytes + $length -gt $capture.bytes.Length) { break }
            try {
                $body = [Text.Encoding]::UTF8.GetString($capture.bytes, $offset + $headerBytes, $length)
                $frames.Add((Frame-Shape (ConvertFrom-Json -InputObject $body)))
            } catch { break }
            $offset += $headerBytes + $length
        }
    } else {
        foreach ($line in @($text -split "`n" | Select-Object -First 4)) {
            if (!$line.Trim()) { continue }
            try { $frames.Add((Frame-Shape (ConvertFrom-Json -InputObject $line))); $connection.framing = 'json-lines' } catch { break }
        }
    }
    $connection.frames = @($frames.ToArray())
}
$observation = $null
if ($ObserveSeconds -gt 0) { $observation = [SleightEngineProbe]::Observe($ObserveSeconds) }
[ordered]@{
    schema = 'sleight.windows-engine-probe/1'; observedUtc = [DateTime]::UtcNow.ToString('o')
    os = [Environment]::OSVersion.VersionString; architecture = $env:PROCESSOR_ARCHITECTURE
    packages = @($packages); searchedRoots = @($roots.ToArray()); searchComplete = $searchComplete; searchEntries = $entries
    engines = @($engines.ToArray()); bundledNodes = @($nodes.ToArray()); processes = @($processes); pipes = @($pipes); pipeCandidates = @($pipeCandidates)
    connection = $connection; observation = $observation; errors = @($errors.ToArray() | Select-Object -Unique)
} | ConvertTo-Json -Depth 16 -Compress
