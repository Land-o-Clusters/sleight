# UC3F guest observer. Run as a Limited interactive task inside the disposable VM.
# Use C:\sleight-setup\uc3f-<16 lowercase hex> as Bank. The row request fixes its identity.
# Streams <RequestInvocation>.<row>.observer-<Invocation>.jsonl in bounded chunks, then records hook cleanup.
# Key labels are escape or other. No characters, titles, pointer positions or pixels.
# tickMs comes from GetTickCount64. eventTickMs and lastInputTickMs are raw wrapping DWORDs.
# Both hooks always forward. End flags expose failed installs, removals and truncation.
# Node tests check source policy and synthetic lines. Win32 behavior needs the VM sitting.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Bank,
    [ValidatePattern('^[0-9]{1,4}$')][string]$Invocation = '0',
    [ValidateRange(1,900)][int]$Seconds = 120,
    [Parameter(Mandatory=$true)][ValidatePattern('^[1-9][0-9]{0,5}$')][string]$RequestInvocation
)
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_REQUIRED' }
    if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { throw 'INTERACTIVE_SESSION_REQUIRED' }
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'UNELEVATED_REQUIRED' }
    $machine = Get-CimInstance Win32_ComputerSystem
    $maker = [string]$machine.Manufacturer
    if ($maker -notmatch '^(?:QEMU|VMware, Inc\.|innotek GmbH|Parallels Software International Inc\.)$' -and
        -not ($maker -ceq 'Microsoft Corporation' -and $machine.Model -ceq 'Virtual Machine')) { throw 'NOT_VM' }
    if ($Bank -cnotmatch '^C:\\sleight-setup\\uc3f-[a-f0-9]{16}$') { throw 'BANK_IDENTITY' }
    $directory = New-Object IO.DirectoryInfo($Bank)
    if (-not $directory.Exists) { throw 'BANK_MISSING' }
    while ($null -ne $directory) {
        if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'BANK_REPARSE_POINT' }
        $directory = $directory.Parent
    }
    # Reuse the exact G7 row envelope as the stop request. No new G7 operation.
    $requestPath = Join-Path $Bank "$RequestInvocation.request.json"
    $requestItem = Get-Item -LiteralPath $requestPath -Force
    if ($requestItem.PSIsContainer -or $requestItem.Length -gt 16384 -or
        ($requestItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'INVALID_REQUEST' }
    $requestBytes = [IO.File]::ReadAllBytes($requestPath)
    $request = [Text.Encoding]::UTF8.GetString($requestBytes) | ConvertFrom-Json
    if ((($request.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'expected,invocation,operation,payload,presence,protocol,token,vmId' -or
        $request.protocol -cne 'sleight.uc3f-transport/1' -or $request.operation -cnotin @('row','selftest') -or
        $request.invocation -cne $RequestInvocation -or $Bank -cne ('C:\sleight-setup\uc3f-' + $request.token) -or
        $request.token -cnotmatch '^[a-f0-9]{16}$' -or $request.presence -cnotin @('away','present') -or
        $request.payload.row.presence -cne $request.presence -or $request.payload.row.id -cnotmatch '^[a-z][a-z0-9-]{0,63}$') { throw 'INVALID_REQUEST' }
    $stopPath = Join-Path $Bank "$RequestInvocation.observer-$Invocation.stop.request.json"
    if (Test-Path -LiteralPath $stopPath) { throw 'STOP_REQUEST_REPLAY' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $requestHash = [Convert]::ToBase64String($sha.ComputeHash($requestBytes)) } finally { $sha.Dispose() }

    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.IO;
using System.Security.Cryptography;
using System.Web.Script.Serialization;

public static class UC3FObserver {
    const string Schema = "sleight.windows-uc3f-observer/2";
    const int MaxSeconds = 900;
    const int PollMs = 10;
    const int HeartbeatMs = 1000;
    const int MaxPollGapMs = 100;
    const int StopReadRetries = 10;
    const int MaxRecords = 32768;
    const int MaxBufferedRecords = 128;
    const int MaxBytes = 8 * 1024 * 1024;
    // Hook callbacks enqueue only. The message loop drains at most 128 records.
    static List<Dictionary<string, object>> rows;
    static long records, bytesWritten, polls, previousPoll, maxPollGap, lastStateTick;
    static string lastState;
    static int stopReadAttempts;
    static long lastMouseFlush, inputChanges;
    static uint firstInputTick, latestInputTick;
    static bool inputSeen;
    // Five phases and four injection-flag combinations, independent of input rate.
    static Dictionary<string, Dictionary<string, object>> mouse;
    sealed class StopRequestException : Exception { }
    static bool truncated, callbackError, pollError, diskError;
    static FileStream stream;
    static JavaScriptSerializer json = new JavaScriptSerializer();
    static IntPtr keyboardHook, mouseHook;
    static HookCallback keyboardCallback, mouseCallback;
    delegate IntPtr HookCallback(int code, IntPtr message, IntPtr data);

    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct KeyboardInput {
        public uint vkCode, scanCode, flags, time;
        public UIntPtr extraInfo;
    }
    [StructLayout(LayoutKind.Sequential)] struct MouseInput {
        public Point point;
        public uint mouseData, flags, time;
        public UIntPtr extraInfo;
    }
    [StructLayout(LayoutKind.Sequential)] struct Message {
        public IntPtr window; public uint message; public UIntPtr wParam; public IntPtr lParam;
        public uint time; public Point point; public uint reserved;
    }
    [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint size, tick; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct WtsLevel1 {
        public uint Session; public int State, Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 33)] public string Station;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 21)] public string User;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 18)] public string Domain;
        public long Logon, Connect, Disconnect, LastInput, Current;
        public uint InBytes, OutBytes, InFrames, OutFrames, InCompressed, OutCompressed;
    }
    [StructLayout(LayoutKind.Sequential)] struct WtsInfoEx { public uint Level; public WtsLevel1 Data; }

    [DllImport("kernel32.dll")] static extern ulong GetTickCount64();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, uint length, out uint needed);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput input);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr SetWindowsHookExW(int kind, HookCallback callback, IntPtr module, uint thread);
    [DllImport("user32.dll", SetLastError = true)] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool PeekMessageW(out Message message, IntPtr window, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr DispatchMessageW(ref Message message);
    [DllImport("user32.dll", SetLastError = true)] static extern uint MsgWaitForMultipleObjectsEx(uint count, IntPtr handles, uint milliseconds, uint wakeMask, uint flags);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder value, uint bytes, out uint needed);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool WTSQuerySessionInformationW(IntPtr server, uint session, int infoClass, out IntPtr data, out uint bytes);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr data);

    // Each call below spells out the whole record. No native input structure is serialized.
    static Dictionary<string, object> Row(string kind, params object[] pairs) {
        var row = new Dictionary<string, object>();
        row.Add("schema", Schema); row.Add("kind", kind); row.Add("tickMs", GetTickCount64());
        for (int n = 0; n < pairs.Length; n += 2) row.Add((string)pairs[n], pairs[n + 1]);
        return row;
    }
    static void Add(Dictionary<string, object> row) {
        // Reserve a terminal record and 2048 disk bytes for the removal receipt.
        if (truncated || rows.Count >= MaxBufferedRecords || records >= MaxRecords - 1) { truncated = true; return; }
        row["seq"] = records + 1;
        rows.Add(row); records++;
    }
    static void Flush(bool terminal) {
        if (rows.Count == 0) return;
        foreach (var row in rows) {
            byte[] bytes = Encoding.UTF8.GetBytes(json.Serialize(row) + "\n");
            if (bytes.Length > 2048 || bytesWritten + bytes.Length > MaxBytes - (terminal ? 0 : 2048)) {
                truncated = diskError = true; throw new IOException("OBSERVER_DISK_LIMIT");
            }
            stream.Write(bytes, 0, bytes.Length); bytesWritten += bytes.Length;
        }
        // Durable flushing happens only after both hooks have been removed.
        stream.Flush(terminal);
        rows.Clear();
    }
    static byte[] ReadOrdinary(string path, int limit) {
        var info = new FileInfo(path);
        if (!info.Exists || (info.Attributes & FileAttributes.ReparsePoint) != 0 || info.Length > limit)
            throw new IOException("REQUEST_INVALID");
        using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            if (file.Length > limit) throw new IOException("REQUEST_INVALID");
            byte[] bytes = new byte[(int)file.Length];
            int at = 0, n;
            while (at < bytes.Length && (n = file.Read(bytes, at, bytes.Length - at)) > 0) at += n;
            if (at != bytes.Length) throw new IOException("REQUEST_INVALID");
            return bytes;
        }
    }
    static bool RetryStopRead(int win32, string message) {
        // A legacy writer or scanner may briefly share or expose incomplete bytes.
        bool retry = win32 == 32 || win32 == 33 || message == "STOP_IDENTITY_MISMATCH" || message == "REQUEST_INVALID";
        if (retry && ++stopReadAttempts <= StopReadRetries) return true;
        if (retry) throw new StopRequestException();
        return false;
    }
    static bool StopRequested(string path, string requestHash) {
        if (!File.Exists(path)) { stopReadAttempts = 0; return false; }
        try {
            byte[] bytes = ReadOrdinary(path, 16384);
            using (var sha = SHA256.Create()) {
                if (Convert.ToBase64String(sha.ComputeHash(bytes)) != requestHash) throw new IOException("STOP_IDENTITY_MISMATCH");
            }
            stopReadAttempts = 0;
            return true;
        } catch (IOException error) {
            int win32 = error.HResult & 0xffff;
            if (RetryStopRead(win32, error.Message)) return false;
            throw;
        }
    }
    static void Foreground(out string hwnd, out uint pid) {
        IntPtr window = GetForegroundWindow();
        GetWindowThreadProcessId(window, out pid);
        hwnd = "0x" + window.ToInt64().ToString("x", CultureInfo.InvariantCulture);
    }
    static IntPtr Keyboard(int code, IntPtr message, IntPtr data) {
        try {
            long m = message.ToInt64();
            if (code == 0 && (m == 0x100 || m == 0x101 || m == 0x104 || m == 0x105)) {
                var input = (KeyboardInput)Marshal.PtrToStructure(data, typeof(KeyboardInput));
                string hwnd; uint pid; Foreground(out hwnd, out pid);
                Add(Row("key", "foregroundHwnd", hwnd, "foregroundPid", pid, "eventTickMs", input.time,
                    "key", input.vkCode == 0x1b ? "escape" : "other", "phase", m == 0x100 || m == 0x104 ? "down" : "up",
                    "injected", (input.flags & 0x10) != 0, "lowerIntegrityInjected", (input.flags & 0x02) != 0));
            }
        } catch { callbackError = true; }
        return CallNextHookEx(keyboardHook, code, message, data);
    }
    static IntPtr Mouse(int code, IntPtr message, IntPtr data) {
        try {
            if (code == 0) {
                long m = message.ToInt64();
                var input = (MouseInput)Marshal.PtrToStructure(data, typeof(MouseInput));
                string hwnd; uint pid; Foreground(out hwnd, out pid);
                string phase = m == 0x200 ? "move" : m == 0x201 || m == 0x204 || m == 0x207 || m == 0x20b ? "down" :
                    m == 0x202 || m == 0x205 || m == 0x208 || m == 0x20c ? "up" : m == 0x20a || m == 0x20e ? "wheel" : "other";
                CoalesceMouse(Row("mouse", "foregroundHwnd", hwnd, "foregroundPid", pid, "eventTickMs", input.time,
                    "phase", phase, "injected", (input.flags & 0x01) != 0, "lowerIntegrityInjected", (input.flags & 0x02) != 0));
            }
        } catch { callbackError = true; }
        return CallNextHookEx(mouseHook, code, message, data);
    }
    static void CoalesceMouse(Dictionary<string, object> row) {
        string key = row["phase"] + ":" + row["injected"] + ":" + row["lowerIntegrityInjected"];
        if (!mouse.ContainsKey(key)) {
            row["firstTickMs"] = row["tickMs"];
            row["firstEventTickMs"] = row["eventTickMs"];
            row["firstForegroundHwnd"] = row["foregroundHwnd"];
            row["firstForegroundPid"] = row["foregroundPid"];
            row["eventCount"] = 0L;
            mouse[key] = row;
        }
        var pending = mouse[key];
        pending["eventCount"] = (long)pending["eventCount"] + 1;
        pending["lastTickMs"] = row["tickMs"];
        pending["eventTickMs"] = row["eventTickMs"];
        pending["foregroundHwnd"] = row["foregroundHwnd"];
        pending["foregroundPid"] = row["foregroundPid"];
    }
    static void FlushMouse(bool force) {
        long tick = (long)GetTickCount64();
        if (!force && tick - lastMouseFlush < HeartbeatMs) return;
        foreach (var pending in mouse.Values) {
            // tickMs is publication time. Preserve both original event clocks.
            pending["tickMs"] = GetTickCount64(); Add(pending);
        }
        mouse.Clear(); lastMouseFlush = tick;
    }
    static string Integrity() {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 8, out token)) throw new InvalidOperationException("INTEGRITY_UNPROVED");
        try {
            uint length; GetTokenInformation(token, 25, IntPtr.Zero, 0, out length);
            if (length < IntPtr.Size || length > 65536) throw new InvalidOperationException("INTEGRITY_UNPROVED");
            IntPtr data = Marshal.AllocHGlobal((int)length);
            try {
                if (!GetTokenInformation(token, 25, data, length, out length)) throw new InvalidOperationException("INTEGRITY_UNPROVED");
                IntPtr sid = Marshal.ReadIntPtr(data);
                byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                if (count == 0) throw new InvalidOperationException("INTEGRITY_UNPROVED");
                uint rid = unchecked((uint)Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1))));
                if (rid >= 0x3000) throw new InvalidOperationException("UNELEVATED_REQUIRED");
                if (rid < 0x1000) throw new InvalidOperationException("INTEGRITY_UNPROVED");
                return rid >= 0x2000 ? "medium" : "low";
            } finally { Marshal.FreeHGlobal(data); }
        } finally { CloseHandle(token); }
    }
    static bool RetainState(bool changed, long tick, long lastTick, bool force) {
        return changed || tick - lastTick >= HeartbeatMs || force;
    }
    static void TrackLastInput(bool inputOk, uint tick) {
        if (inputOk && (!inputSeen || tick != latestInputTick)) {
            if (inputChanges == 0) firstInputTick = tick;
            inputChanges++; latestInputTick = tick; inputSeen = true;
        }
    }
    static void Poll(uint sessionId, bool force) {
        string hwnd; uint pid; Foreground(out hwnd, out pid);
        var input = new LastInput { size = (uint)Marshal.SizeOf(typeof(LastInput)) };
        bool inputOk = GetLastInputInfo(ref input);
        TrackLastInput(inputOk, input.tick);
        IntPtr buffer = IntPtr.Zero; uint bytes;
        bool wtsOk = false; int state = -1, flags = -1;
        try {
            if (WTSQuerySessionInformationW(IntPtr.Zero, sessionId, 25, out buffer, out bytes) && buffer != IntPtr.Zero &&
                bytes >= Marshal.SizeOf(typeof(WtsInfoEx))) {
                var info = (WtsInfoEx)Marshal.PtrToStructure(buffer, typeof(WtsInfoEx));
                if (info.Level == 1 && info.Data.Session == sessionId) {
                    wtsOk = true; state = info.Data.State; flags = info.Data.Flags;
                }
            }
        } finally { if (buffer != IntPtr.Zero) WTSFreeMemory(buffer); }
        string desktopName = "unavailable"; bool desktopOpened = false;
        IntPtr desktop = OpenInputDesktop(0, false, 0x0001); // DESKTOP_READOBJECTS
        if (desktop != IntPtr.Zero) {
            try {
                var value = new StringBuilder(256); uint needed;
                if (GetUserObjectInformationW(desktop, 2, value, (uint)value.Capacity * 2, out needed)) {
                    desktopOpened = true;
                    string name = value.ToString();
                    desktopName = name == "Default" || name == "Winlogon" || name == "Screen-saver" ? name : "other";
                }
            } finally { CloseDesktop(desktop); }
        }
        var snapshot = Row("poll", "foregroundHwnd", hwnd, "foregroundPid", pid,
            "lastInputOk", inputOk, "lastInputTickMs", inputOk ? input.tick : 0,
            "wtsOk", wtsOk, "wtsState", state, "wtsFlags", flags, "desktopOpened", desktopOpened, "desktop", desktopName);
        snapshot.Add("lastInputFirstTickMs", inputChanges > 0 ? firstInputTick : inputOk ? input.tick : 0);
        snapshot.Add("lastInputChanges", inputChanges);
        long tick = (long)(ulong)snapshot["tickMs"];
        if (polls > 0) maxPollGap = Math.Max(maxPollGap, tick - previousPoll);
        polls++; previousPoll = tick;
        if (maxPollGap > MaxPollGapMs) { pollError = true; throw new InvalidOperationException("POLL_GAP"); }
        // Compare only state fields. Counters and clocks must not force a record per poll.
        var signature = new Dictionary<string, object>(snapshot);
        signature.Remove("tickMs"); signature.Remove("seq");
        signature.Remove("lastInputTickMs"); signature.Remove("lastInputFirstTickMs"); signature.Remove("lastInputChanges");
        string current = json.Serialize(signature);
        if (RetainState(current != lastState, tick, lastStateTick, force)) {
            snapshot.Add("pollCount", polls); snapshot.Add("maxGapMs", maxPollGap);
            Add(snapshot); lastState = current; lastStateTick = tick; inputChanges = 0;
        }
    }
    public static bool Run(int seconds, string output, string stopPath,
        string requestHash, string rowToken, string rowId, string invocation) {
        if (seconds < 1 || seconds > MaxSeconds) throw new ArgumentOutOfRangeException("seconds");
        uint sessionId = (uint)Process.GetCurrentProcess().SessionId;
        if (sessionId == 0) throw new InvalidOperationException("INTERACTIVE_SESSION_REQUIRED");
        string integrity = Integrity();
        rows = new List<Dictionary<string, object>>();
        records = bytesWritten = polls = previousPoll = maxPollGap = lastStateTick = 0;
        lastState = null;
        stopReadAttempts = 0; lastMouseFlush = (long)GetTickCount64(); inputChanges = 0; inputSeen = false;
        mouse = new Dictionary<string, Dictionary<string, object>>();
        truncated = callbackError = pollError = diskError = false;
        stream = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        keyboardHook = mouseHook = IntPtr.Zero;
        keyboardCallback = Keyboard; mouseCallback = Mouse;
        Add(Row("start", "sessionId", sessionId, "integrity", integrity, "pollMs", PollMs,
            "maxRecords", MaxRecords, "heartbeatMs", HeartbeatMs, "maxBytes", MaxBytes,
            "invocation", invocation, "rowToken", rowToken, "rowId", rowId));
        bool keyboardInstalled = false, mouseInstalled = false, keyboardRemoved = false, mouseRemoved = false;
        int keyboardError = 0, mouseError = 0;
        string reason = "completed";
        var watch = Stopwatch.StartNew();
        try {
            Flush(false);
            keyboardHook = SetWindowsHookExW(13, keyboardCallback, GetModuleHandleW(null), 0);
            keyboardInstalled = keyboardHook != IntPtr.Zero;
            if (!keyboardInstalled) keyboardError = Marshal.GetLastWin32Error();
            mouseHook = SetWindowsHookExW(14, mouseCallback, GetModuleHandleW(null), 0);
            mouseInstalled = mouseHook != IntPtr.Zero;
            if (!mouseInstalled) mouseError = Marshal.GetLastWin32Error();
            if (!keyboardInstalled || !mouseInstalled) reason = "hook-install-failed";
            else {
                Poll(sessionId, false); Flush(false);
                Console.Error.WriteLine("SLEIGHT_UC3F_OBSERVER_READY");
                long nextPoll = 0;
                while (watch.Elapsed.TotalSeconds < seconds) {
                    Message message;
                    for (int n = 0; n < 1024 && PeekMessageW(out message, IntPtr.Zero, 0, 0, 1); n++) {
                        TranslateMessage(ref message); DispatchMessageW(ref message);
                    }
                    if (callbackError) { reason = "observer-error"; break; }
                    if (truncated) { reason = "record-limit"; break; }
                    if (watch.ElapsedMilliseconds >= nextPoll) {
                        if (StopRequested(stopPath, requestHash)) { reason = "stop-requested"; break; }
                        FlushMouse(false);
                        Poll(sessionId, false);
                        nextPoll = watch.ElapsedMilliseconds + PollMs;
                    }
                    if (truncated) { reason = "record-limit"; break; }
                    Flush(false);
                    // QS_ALLINPUT, MWMO_INPUTAVAILABLE: wake for new or queued messages.
                    // Keep the poll deadline separate so input cannot increase the poll rate.
                    uint waitMs = (uint)Math.Max(0L, Math.Min(nextPoll, seconds * 1000L) - watch.ElapsedMilliseconds);
                    if (MsgWaitForMultipleObjectsEx(0, IntPtr.Zero, waitMs, 0x04ff, 0x0004) == 0xffffffff)
                        throw new InvalidOperationException("MESSAGE_WAIT_FAILED");
                }
            }
            if (!truncated && !callbackError && !pollError) { Poll(sessionId, true); Flush(false); }
        } catch (StopRequestException) { pollError = true; reason = "stop-invalid"; }
        catch (IOException) { diskError = true; reason = "disk-error"; }
        catch { pollError = true; reason = "observer-error"; }
        finally {
            if (keyboardHook != IntPtr.Zero) keyboardRemoved = UnhookWindowsHookEx(keyboardHook);
            if (mouseHook != IntPtr.Zero) mouseRemoved = UnhookWindowsHookEx(mouseHook);
            GC.KeepAlive(keyboardCallback); GC.KeepAlive(mouseCallback);
        }
        // Persist any remaining accepted data after removing the hooks.
        // A failed write can leave a partial line, so never retry it.
        if (!diskError) {
            try { FlushMouse(true); Flush(false); if (truncated) reason = "record-limit"; } catch { diskError = true; reason = "disk-error"; }
        }
        rows.Clear();
        var terminal = Row("end", "keyboardHookInstalled", keyboardInstalled, "mouseHookInstalled", mouseInstalled,
            "keyboardHookRemoved", keyboardRemoved, "mouseHookRemoved", mouseRemoved, "hookRemoved", keyboardRemoved && mouseRemoved,
            "keyboardHookError", keyboardError, "mouseHookError", mouseError,
            "truncated", truncated, "callbackError", callbackError, "pollError", pollError,
            "diskError", diskError, "stopReason", reason, "records", records + 1, "pollCount", polls);
        terminal["seq"] = records + 1; rows.Add(terminal);
        try { Flush(true); } finally { stream.Dispose(); }
        return keyboardRemoved && mouseRemoved && !truncated && !callbackError && !pollError && !diskError &&
            (reason == "completed" || reason == "stop-requested");
    }
}
'@ -ReferencedAssemblies @('System.dll','System.Web.Extensions.dll')
    $output = Join-Path $Bank "$RequestInvocation.$($request.payload.row.id).observer-$Invocation.jsonl"
    $ok = [UC3FObserver]::Run($Seconds, $output, $stopPath, $requestHash,
        ($request.token + $request.token), $request.payload.row.id, $Invocation)
    if (-not $ok) { exit 1 }
} catch {
  $known = @('BANK_IDENTITY','BANK_MISSING','BANK_REPARSE_POINT','FIXTURE_ACCESS_DENIED','FIXTURE_PROCESS_GONE','FIXTURE_WINDOW_GONE','GUEST_EXCEPTION_UNCLASSIFIED','INTEGRITY_UNPROVED','INTERACTIVE_SESSION_REQUIRED','INVALID_REQUEST','MESSAGE_WAIT_FAILED','NOT_VM','PARAMETER_BINDING_FAILED','POLL_GAP','STOP_REQUEST_REPLAY','UNELEVATED_REQUIRED','WINDOWS_REQUIRED')
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
  [Console]::Error.WriteLine($code)
    exit 1
}
