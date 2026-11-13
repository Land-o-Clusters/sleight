using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;

namespace Sleight.Driver
{
// External sources only. No HWND is created, no input API is called and no
// observer process runs. Queue barriers replace sleeps and virtual time drives idle.
internal sealed class PersonReviewClock
{
    internal long ElapsedMilliseconds { get { return Interlocked.Read(ref PersonReviewChecks.HookNow); } }
}
internal sealed class PersonReviewTimer : IDisposable
{
    readonly TimerCallback callback;
    readonly object sync = new object();
    long due = -1;
    int repeat = -1;
    internal PersonReviewTimer(TimerCallback callback, object state, int first, int period)
    {
        this.callback = callback; PersonReviewChecks.Timer = this; Change(first, period);
    }
    internal bool Change(int first, int period)
    {
        lock (sync) { due = first < 0 ? -1 : Interlocked.Read(ref PersonReviewChecks.HookNow) + first; repeat = period; }
        if (first == 0) Fire();
        return true;
    }
    internal void Fire()
    {
        bool fire;
        lock (sync) {
            fire = due >= 0 && Interlocked.Read(ref PersonReviewChecks.HookNow) >= due;
            if (fire) due = -1;
        }
        if (fire) callback(null);
    }
    internal void Retry()
    {
        bool retry;
        lock (sync) retry = repeat >= 0 && due < 0;
        if (retry) callback(null);
    }
    public void Dispose() { lock (sync) { due = -1; repeat = -1; } }
}
internal sealed class PersonReviewInput : Stream
{
    readonly BlockingCollection<byte> bytes = new BlockingCollection<byte>();
    internal void Send(string text) { foreach (byte value in Encoding.UTF8.GetBytes(text + "\n")) bytes.Add(value); }
    internal void Finish() { bytes.CompleteAdding(); }
    public override int Read(byte[] buffer, int offset, int count)
    {
        if (count == 0) return 0;
        byte value;
        if (!bytes.TryTake(out value, 5000)) {
            if (bytes.IsCompleted) return 0;
            throw new IOException("protocol input timed out");
        }
        buffer[offset] = value;
        int read = 1;
        while (read < count && bytes.TryTake(out value)) buffer[offset + read++] = value;
        return read;
    }
    public override bool CanRead { get { return true; } }
    public override bool CanWrite { get { return false; } }
    public override bool CanSeek { get { return false; } }
    public override long Length { get { throw new NotSupportedException(); } }
    public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
}
internal sealed class PersonReviewOutput : MemoryStream
{
    internal readonly BlockingCollection<string> Lines = new BlockingCollection<string>();
    public override void Write(byte[] buffer, int offset, int count)
    {
        for (int i = offset; i < offset + count; i++) {
            if (buffer[i] == 10) { Lines.Add(Encoding.UTF8.GetString(ToArray())); SetLength(0); Position = 0; }
            else WriteByte(buffer[i]);
        }
    }
}
internal static class PersonReviewChecks
{
    internal static PersonReviewInput ProtocolInput;
    internal static PersonReviewOutput ProtocolOutput;
    internal static MemoryStream ProtocolError;
    internal static long HookNow;
    internal static PersonReviewTimer Timer;
    static readonly BlockingCollection<uint> messages = new BlockingCollection<uint>();
    static readonly AutoResetEvent barrier = new AutoResetEvent(false);
    static readonly IntPtr root = new IntPtr(101), child = new IntPtr(102);
    internal static IntPtr Foreground = new IntPtr(201), Pointer = new IntPtr(202);
    internal static uint InputNow = 10000, LastInput = 9000;
    internal static bool LastOk = true, CursorOk = true, WtsOk = true, DesktopOpen = true, DesktopNameOk = true;
    internal static int State, Flags = 1, Level = 1, LastReads, WtsReads, WtsFrees, DesktopOpens, DesktopCloses;
    internal static string Desktop = "Default";
    internal static int Posts, Installs, Uninstalls, HookKind, NextCalls;
    static Delegate keyboard;
    static Action afterPost;
    static string property;
    static int passed;
    static bool bypassActionCompleted;
    static readonly Dictionary<string, int> counts = new Dictionary<string, int>();
    static WindowRecord target;
    internal static bool Child(IntPtr parent, IntPtr hwnd) { return parent == root && hwnd == child; }
    internal static uint Thread(IntPtr hwnd, out uint pid)
    {
        pid = hwnd == root || hwnd == child ? 41u : hwnd == IntPtr.Zero ? 0u : 42u;
        return pid == 0 ? 0u : 51u;
    }
    internal static uint? Hosted(IntPtr hwnd) { return null; }
    internal static WindowRecord Observe(IntPtr hwnd) { return target; }
    internal static bool Post(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam)
    {
        Posts++;
        if (afterPost != null) afterPost();
        return true;
    }
    internal static bool Wts(Type type, out IntPtr data, out uint bytes)
    {
        WtsReads++; data = IntPtr.Zero; bytes = 0;
        if (!WtsOk) return false;
        object info = Activator.CreateInstance(type), inner = Activator.CreateInstance(type.GetField("Data").FieldType);
        inner.GetType().GetField("State").SetValue(inner, State);
        inner.GetType().GetField("Flags").SetValue(inner, Flags);
        type.GetField("Level").SetValue(info, (uint)Level);
        type.GetField("Data").SetValue(info, inner);
        bytes = (uint)Marshal.SizeOf(type); data = Marshal.AllocHGlobal((int)bytes);
        Marshal.StructureToPtr(info, data, false);
        return true;
    }
    internal static void FreeWts(IntPtr data) { WtsFrees++; Marshal.FreeHGlobal(data); }
    internal static IntPtr OpenDesktop() { DesktopOpens++; return DesktopOpen ? new IntPtr(71) : IntPtr.Zero; }
    internal static bool CloseDesktop(IntPtr desktop) { DesktopCloses++; return true; }
    internal static IntPtr Install(int kind, Delegate callback, IntPtr module, uint thread)
    {
        Installs++; HookKind = kind; keyboard = callback; return new IntPtr(91);
    }
    internal static bool Uninstall(IntPtr hook) { Uninstalls++; return true; }
    internal static IntPtr NextHook(int code, IntPtr message, IntPtr data) { NextCalls++; return new IntPtr(73); }
    internal static bool QueueMessage(uint message) { messages.Add(message); return true; }
    internal static uint NextMessage()
    {
        // Change(0, 25) runs while Activate owns the gate, before Run can
        // publish threadId. Replay its periodic wake once the queue can receive.
        Timer.Retry();
        return messages.Take();
    }
    internal static void Dispatched(uint message) { if (message == 0x8002) barrier.Set(); }
    static void Flush()
    {
        messages.Add(0x8002);
        if (!barrier.WaitOne(2000)) throw new Exception("synthetic pump barrier timed out");
    }
    static void Advance(long milliseconds)
    {
        Interlocked.Exchange(ref HookNow, Interlocked.Read(ref HookNow) + milliseconds);
        Timer.Fire(); Flush();
    }
    static IntPtr HookHandle(DriverHook hook)
    {
        return (IntPtr)typeof(DriverHook).GetField("hook", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(hook);
    }
    static IntPtr Key(int code, long message, uint key, uint flags)
    {
        IntPtr data = Marshal.AllocHGlobal(24);
        try {
            for (int offset = 0; offset < 24; offset += 4) Marshal.WriteInt32(data, offset, 0);
            Marshal.WriteInt32(data, 0, (int)key); Marshal.WriteInt32(data, 8, (int)flags);
            return (IntPtr)keyboard.DynamicInvoke(code, new IntPtr(message), data);
        } finally { Marshal.FreeHGlobal(data); }
    }
    static void Check(bool value, string name)
    {
        property = name;
        if (!value) throw new Exception("assertion failed: " + name);
        passed++;
        if (!counts.ContainsKey(name)) counts[name] = 0;
        counts[name]++;
    }
    static DriverFault Fault(Action action)
    {
        try { action(); return null; } catch (DriverFault fault) { return fault; }
    }
    static bool Refuses(DriverFault fault, string code, string reason, int typed, bool sent)
    {
        return fault != null && fault.Code == code && fault.Disposition != null &&
            (string)fault.Disposition["reason"] == reason && (int)fault.Disposition["typed"] == typed &&
            (string)fault.Disposition["delivery"] == (sent ? "sent-unverified" : "not-sent") &&
            (string)fault.Disposition["retry"] == (sent ? "read-first" : "safe");
    }
    static void Reset()
    {
        DriverInput.InputAttempted = false; DriverInput.Typed = 0; DriverInput.PostedMessages = 0;
        DriverInput.Cancelled = null; DriverInput.Progress = new DriverInput.ProgressRecord();
        Foreground = new IntPtr(201); Pointer = new IntPtr(202); InputNow = 10000; LastInput = 9000;
        LastOk = CursorOk = WtsOk = DesktopOpen = DesktopNameOk = true;
        State = 0; Flags = 1; Level = 1; Desktop = "Default"; Posts = 0; afterPost = null;
    }
    static string Type(string text) { return DriverInput.Type(target, child, text); }
    static void PersonChecks()
    {
        foreach (uint age in new uint[] { 0, 1, 100, 499 }) {
            Reset(); Foreground = root; LastInput = InputNow - age;
            var fault = Fault(() => Type("ab"));
            Check(Refuses(fault, "PERSON_TOOK_OVER", "person-active", 0, false) && Posts == 0, "person-before");
            Check((bool)fault.Disposition["personTookOver"] && DriverInput.Progress.Attempted == 0, "person-before");
        }
        foreach (uint age in new uint[] { 500, 501, 2000 }) {
            Reset(); Foreground = root; Pointer = root; LastInput = InputNow - age;
            Check(Fault(() => Type("ab")) == null && Posts == 2 && DriverInput.Typed == 2, "person-boundary");
        }
        Reset(); LastInput = InputNow - 100; Pointer = child;
        Check(Refuses(Fault(() => Type("a")), "PERSON_TOOK_OVER", "person-active", 0, false) && Posts == 0, "pointer-target");
        Reset(); LastInput = InputNow - 100;
        Check(Fault(() => Type("ab")) == null && Posts == 2, "foreign-input");
        Reset(); LastInput = InputNow - 100; Foreground = child;
        Check(Refuses(Fault(() => Type("a")), "PERSON_TOOK_OVER", "person-active", 0, false) && Posts == 0, "same-process-child");
        // GetLastInputInfo has one timestamp, with no keyboard/pointer tag.
        // Pin both conservative refusals, including movement away from a
        // foreground target and typing elsewhere while hovering its child.
        Reset(); LastInput = InputNow - 100; Foreground = root;
        Check(Refuses(Fault(() => Type("a")), "PERSON_TOOK_OVER", "person-active", 0, false) && Posts == 0,
            "recent-input-foreground-over-refusal");
        Reset(); LastInput = InputNow - 100; Pointer = child;
        Check(Refuses(Fault(() => Type("a")), "PERSON_TOOK_OVER", "person-active", 0, false) && Posts == 0,
            "recent-input-pointer-over-refusal");
        // The timestamp wraps, exactly as GetLastInputInfo and TickCount do.
        Reset(); InputNow = 16; LastInput = 0xfffffff0; Foreground = root;
        Check(Refuses(Fault(() => Type("a")), "PERSON_TOOK_OVER", "person-active", 0, false), "input-age-wrap");
        foreach (string unknown in new[] { "last", "cursor", "foreground", "pointer", "future" }) {
            Reset();
            if (unknown == "last") LastOk = false;
            if (unknown == "cursor") CursorOk = false;
            if (unknown == "foreground") Foreground = IntPtr.Zero;
            if (unknown == "pointer") Pointer = IntPtr.Zero;
            if (unknown == "future") LastInput = InputNow + 1;
            Check(Refuses(Fault(() => Type("a")), "PERSON_TOOK_OVER", "person-unknown", 0, false) && Posts == 0, "person-unknown");
        }
        // The external post returns synchronously. Hardware activity appears
        // after the seventh post, before the eighth, without any clock race.
        foreach (string text in new[] { new string('a', 200), new string('a', 7) + "\U0001f9e4x" }) {
            Reset(); afterPost = () => { if (Posts == 7) { LastInput = InputNow; Foreground = root; } };
            var fault = Fault(() => Type(text));
            Check(Refuses(fault, "PERSON_TOOK_OVER", "person-active", 7, true) && Posts == 7 && DriverInput.Typed == 7, "mid-type");
            Check(DriverInput.Progress.Units == 7 && DriverInput.Progress.Posts == 7 && DriverInput.Progress.Attempted == 1, "mid-type-progress");
            Check(fault.Message.Contains("typed=7") && fault.Message.Contains("read again"), "mid-type-report");
        }
    }
    static void SessionChecks()
    {
        foreach (string scenario in new[] { "locked", "screensaver", "secure", "closed", "disconnected", "unknown", "bad-level", "bad-flags", "bad-name" }) {
            Reset();
            if (scenario == "locked") Flags = 0;
            if (scenario == "screensaver") Desktop = "Screen-saver";
            if (scenario == "secure") Desktop = "Winlogon";
            if (scenario == "closed") DesktopOpen = false;
            if (scenario == "disconnected") State = 4;
            if (scenario == "unknown") WtsOk = false;
            if (scenario == "bad-level") Level = 2;
            if (scenario == "bad-flags") Flags = 2;
            if (scenario == "bad-name") DesktopNameOk = false;
            string reason = scenario == "locked" ? "session-locked" : scenario == "screensaver" ? "screensaver" :
                scenario == "secure" || scenario == "closed" ? "secure-desktop" : scenario == "disconnected" ? "session-disconnected" :
                scenario == "bad-name" ? "input-desktop-unavailable" : "session-unknown";
            string name = "session-" + scenario;
            int inputReads = LastReads, opens = DesktopOpens, closes = DesktopCloses, reads = WtsReads, frees = WtsFrees;
            var fault = Fault(() => Type("a"));
            if (scenario == "screensaver" || scenario == "secure") {
                bypassActionCompleted = fault == null && Posts == 1 && DriverInput.Typed == 1;
                Check(fault != null && Posts == 0, name + "-bypass");
            }
            Check(Refuses(fault, reason == "secure-desktop" ? "SECURE_DESKTOP_ACTIVE" : "SCREEN_LOCKED", reason, 0, false) && Posts == 0, name);
            Check(LastReads == inputReads && WtsReads == reads + 1 && WtsFrees == frees + (WtsOk ? 1 : 0) &&
                DesktopOpens == opens + 1 && DesktopCloses == closes + (DesktopOpen ? 1 : 0), "session-native-sources");
        }
        Reset(); Check(Fault(() => Type("a")) == null && Posts == 1, "session-default");
        foreach (string scenario in new[] { "locked", "screensaver", "secure" }) {
            Reset(); afterPost = () => { if (Posts == 7) {
                if (scenario == "locked") Flags = 0;
                else Desktop = scenario == "secure" ? "Winlogon" : "Screen-saver";
            } };
            var fault = Fault(() => Type(new string('a', 200)));
            Check(Refuses(fault, scenario == "secure" ? "SECURE_DESKTOP_ACTIVE" : "SCREEN_LOCKED",
                scenario == "locked" ? "session-locked" : scenario == "secure" ? "secure-desktop" : "screensaver", 7, true) && Posts == 7, "session-mid-type");
        }
    }
    static void HookChecks()
    {
        Reset();
        using (var hook = new DriverHook()) {
            Check(Installs == 0, "hook-lazy");
            hook.BeginTurn(1); var owner = hook.CurrentTurn;
            Check(Installs == 0 && !owner.Escaped, "hook-lazy");
            hook.Activate(owner); Flush();
            Check(Installs == 1 && HookHandle(hook) != IntPtr.Zero, "hook-installed");
            Check(HookKind == 13, "keyboard-only");
            DriverInput.Cancelled = () => owner.Escaped ? DriverInput.StopReason.Escape : DriverInput.StopReason.None;
            foreach (uint flags in new uint[] { 0x10, 0x02, 0x12 }) {
                Key(0, 0x100, 0x1b, flags);
                Check(!owner.Escaped && Fault(() => Type("a")) == null, "injected-escape");
            }
            foreach (int code in new[] { -1, 0 }) foreach (long message in new long[] { 0x101, 0x104 }) {
                Key(code, message, 0x1b, 0);
                Check(!owner.Escaped, "non-keydown-escape");
            }
            Key(0, 0x100, 0x41, 0);
            Check(!owner.Escaped, "ordinary-key");
            Posts = 0;
            var posted = Fault(() => {
                DriverInput.Post(target, child, 0x100, 0x1b, new IntPtr(1));
                DriverInput.Post(target, child, 0x101, 0x1b, new IntPtr(1));
            });
            Check(posted == null && !owner.Escaped && Posts == 2, "posted-escape");
            int calls = NextCalls;
            IntPtr result = Key(0, 0x100, 0x1b, 0);
            Check(owner.Escaped, "physical-escape");
            Check(NextCalls == calls + 1 && result == new IntPtr(73), "escape-forwarded");
            // The callback does not sample focus. The person can be in any app.
            Reset(); DriverInput.Cancelled = () => owner.Escaped ? DriverInput.StopReason.Escape : DriverInput.StopReason.None;
            Check(Refuses(Fault(() => Type("abc")), "USER_STOPPED", "escape", 0, false) && Posts == 0, "escape-rest-of-turn");
            hook.BeginTurn(1);
            Check(owner.Escaped && Refuses(Fault(() => hook.Activate(owner)), "USER_STOPPED", "escape", 0, false), "escape-rest-of-turn");
            var ended = Json.Object(hook.EndTurn(1));
            Check(!(bool)ended["active"] && HookHandle(hook) == IntPtr.Zero && Uninstalls == 1, "hook-turn-end");
            Key(0, 0x100, 0x1b, 0);
            hook.BeginTurn(2); var next = hook.CurrentTurn;
            Check(!next.Escaped && owner.Escaped, "escape-turn-isolation");
            Reset(); hook.Activate(next); Flush();
            DriverInput.Cancelled = () => next.Escaped ? DriverInput.StopReason.Escape : DriverInput.StopReason.None;
            afterPost = () => { if (Posts == 7) Key(0, 0x100, 0x1b, 0); };
            Check(Refuses(Fault(() => Type(new string('a', 200))), "USER_STOPPED", "escape", 7, true) && Posts == 7, "escape-mid-type");
            Reset();
            int removed = Uninstalls;
            Advance(59999);
            Check(HookHandle(hook) != IntPtr.Zero && Uninstalls == removed, "hook-idle-before");
            Advance(1);
            Check(HookHandle(hook) == IntPtr.Zero, "hook-idle-at");
            Check(Uninstalls == removed + 1, "hook-native-removed");
            hook.EndTurn(2);
            hook.BeginTurn(3); var third = hook.CurrentTurn; hook.Activate(third); Flush();
            Advance(59000); hook.RequestSeen(); Advance(1000);
            QueueMessage(0x8001); Flush();
            Check(HookHandle(hook) != IntPtr.Zero, "hook-idle-refresh");
            Advance(58999); Check(HookHandle(hook) != IntPtr.Zero, "hook-idle-refresh");
            Advance(1); Check(HookHandle(hook) == IntPtr.Zero, "hook-idle-refresh");
            // Re-activation also refreshes an already installed hook. Keep the
            // timestamp and timer mutations distinguishable from RequestSeen.
            hook.Activate(third); Flush(); Advance(59000); hook.Activate(third); Advance(1000);
            QueueMessage(0x8001); Flush();
            Check(HookHandle(hook) != IntPtr.Zero, "hook-activate-refresh");
            Advance(58999); Check(HookHandle(hook) != IntPtr.Zero, "hook-activate-refresh");
            Advance(1); Check(HookHandle(hook) == IntPtr.Zero, "hook-activate-refresh");
            hook.EndTurn(3);
            Check(Installs == Uninstalls, "hook-balanced");
        }
    }
    static void ReadRequests(Func<string, Dictionary<string, object>, Dictionary<string, object>> request, int installs, string name)
    {
        foreach (string method in new[] { "ping", "getState", "listApps", "getApp", "getAXState", "getScreenshot", "getAXStateAndScreenshot", "verifyWindowIdentity" }) {
            bool state = method == "ping" || method == "getState" || method == "listApps", app = method == "getApp";
            var args = state ? Json.Map() : app ? Json.Map("selector", "missing-fixture") :
                Json.Map("windowId", "101", "processStart", "1", "bindingId", new string('b', 32));
            var reply = request(method, args);
            // Empty synthetic inventory and unissued binding tokens stop these
            // five reads before UIA/capture. The other three succeed normally.
            bool expected = state ? (bool)reply["ok"] : !(bool)reply["ok"] &&
                (string)Json.Object(reply["error"])["code"] == (app ? "WINDOW_NOT_FOUND" : "IDENTITY_CHANGED");
            Check(expected && Installs == installs, name);
        }
    }
    static void WiringChecks()
    {
        Reset(); Installs = Uninstalls = 0; Interlocked.Exchange(ref HookNow, 0);
        uint ignored; while (messages.TryTake(out ignored)) { }
        ProtocolInput = new PersonReviewInput(); ProtocolOutput = new PersonReviewOutput(); ProtocolError = new MemoryStream();
        TextWriter stdout = Console.Out, stderr = Console.Error;
        string previousNonce = Environment.GetEnvironmentVariable("SLEIGHT_DRIVER_NONCE"), nonce = new string('a', 64);
        Environment.SetEnvironmentVariable("SLEIGHT_DRIVER_NONCE", nonce);
        int exit = -1; Exception entryError = null;
        var entry = new Thread(() => { try { exit = Driver.Entry(new[] { "--driver" }); } catch (Exception error) { entryError = error; } });
        entry.IsBackground = true;
        long id = 0;
        Func<string, Dictionary<string, object>, Dictionary<string, object>> request = (method, args) => {
            long next = ++id;
            ProtocolInput.Send(Json.Codec.Serialize(Json.Map("protocol", Driver.Protocol, "nonce", nonce, "id", next,
                "method", method, "params", args, "deadline", Driver.Now() + 10000)));
            string line;
            if (!ProtocolOutput.Lines.TryTake(out line, 5000)) throw new Exception("protocol reply timed out");
            var reply = Json.Object(Json.Codec.DeserializeObject(line));
            Check(Json.Integer(reply["id"], 1, Int64.MaxValue) == next && (string)reply["nonce"] == nonce, "production-protocol");
            return reply;
        };
        try {
            entry.Start();
            Check((bool)request("turn-start", Json.Map("turn", 1))["ok"], "production-turn-start");
            ReadRequests(request, 0, "production-read-no-hook");
            var parameters = Json.Map("windowId", "101", "processStart", "1", "readId", 1, "args", new object[] { "abc" });
            var action = request("typeText", parameters);
            Check(!(bool)action["ok"] && (string)Json.Object(action["error"])["code"] == "STALE_READ" &&
                Installs == 1 && HookKind == 13, "production-hook-activated");
            Key(0, 0x100, 0x1b, 0);
            ReadRequests(request, 1, "production-read-after-escape");
            foreach (string method in DriverActionPlan.Methods.Concat(new[] { "stuckMenuEscape" })) {
                int reads = WtsReads;
                var stopped = request(method, parameters);
                var error = stopped.ContainsKey("error") ? Json.Object(stopped["error"]) : Json.Map();
                Check(!(bool)stopped["ok"] && error.ContainsKey("reason") && (string)error["code"] == "USER_STOPPED" &&
                    (string)error["reason"] == "escape" && (string)error["delivery"] == "not-sent" &&
                    WtsReads == reads && Posts == 0, "production-escape-cancelled");
            }
            var ended = request("turn-end", Json.Map("turn", 1));
            Check((bool)ended["ok"] && Uninstalls == 1, "production-turn-end");
            var after = request("getState", Json.Map());
            Check((bool)after["ok"] && Installs == 1, "production-read-no-hook");
        } finally {
            ProtocolInput.Finish();
            bool joined = entry.Join(3000);
            Console.SetOut(stdout); Console.SetError(stderr);
            Environment.SetEnvironmentVariable("SLEIGHT_DRIVER_NONCE", previousNonce);
            if (!joined) throw new Exception("production entry did not exit");
        }
        Check(exit == 0 && entryError == null && ProtocolError.Length == 0, "production-entry-exit");
    }
    static void Bindings()
    {
        foreach (var row in new[] {
            new[] { "DriverInput", "GetLastInputInfo", "user32.dll" },
            new[] { "DriverPerson", "GetForegroundWindow", "user32.dll" },
            new[] { "DriverPerson", "GetCursorPos", "user32.dll" },
            new[] { "DriverPerson", "WindowFromPoint", "user32.dll" },
            new[] { "DriverHook", "SetWindowsHookEx", "user32.dll" },
            new[] { "DriverHook", "UnhookWindowsHookEx", "user32.dll" },
            new[] { "DriverHook", "CallNextHookEx", "user32.dll" },
            new[] { "DriverSession", "WTSQuerySessionInformationW", "wtsapi32.dll" },
            new[] { "DriverSession", "OpenInputDesktop", "user32.dll" },
            new[] { "DriverSession", "GetUserObjectInformationW", "user32.dll" },
        }) {
            var type = typeof(Driver).Assembly.GetType("Sleight.Driver." + row[0]);
            var method = type.GetMethod(row[1], BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            var attribute = method == null ? null : (DllImportAttribute)Attribute.GetCustomAttribute(method, typeof(DllImportAttribute));
            Check(attribute != null && attribute.Value == row[2], "production-native-bindings");
        }
    }
    public static int Main(string[] args)
    {
        try {
            if (args.Length == 1 && args[0] == "--bindings") Bindings();
            else if (args.Length == 0 || args.Length == 1 && args[0] == "--wiring") {
                target = new WindowRecord { Handle = root, Pid = 41, ProcessStart = "1", Image = "fixture.exe",
                    Integrity = "medium", ClassName = "FixtureWindow", OnCurrentDesktop = true,
                    DesktopId = "12345678-1234-1234-1234-123456789abc", WindowGeneration = "1", TopologyGeneration = "1:tree" };
                if (args.Length == 1) WiringChecks();
                else { PersonChecks(); SessionChecks(); HookChecks(); }
            } else return 64;
            Console.WriteLine(Json.Codec.Serialize(Json.Map("passed", passed, "failed", 0, "properties", counts, "drawing", false)));
            return 0;
        } catch (Exception error) {
            Console.WriteLine(Json.Codec.Serialize(Json.Map("passed", passed, "failed", 1, "property", property,
                "bypassActionCompleted", bypassActionCompleted, "posts", Posts, "drawing", false)));
            Console.Error.WriteLine(error.Message); return 1;
        } finally { DriverInput.Cancelled = null; DriverInput.Progress = null; }
    }
}
}
