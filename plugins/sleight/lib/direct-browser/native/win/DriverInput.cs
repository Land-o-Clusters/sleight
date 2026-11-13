using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;

namespace Sleight.Driver
{
internal static class DriverPerson
{
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetCursorPos(out DriverPoint point);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(DriverPoint point);
    internal static string Decide(uint ageMs, uint foregroundPid, uint pointerPid, uint targetPid)
    {
        if (ageMs >= 0x80000000u || foregroundPid == 0 || pointerPid == 0 || targetPid == 0) return "person-unknown";
        if (ageMs < 500 && (foregroundPid == targetPid || pointerPid == targetPid)) return "person-active";
        return null;
    }
    // hosted returns null for an ordinary surface, 0 when a frame's app cannot
    // be proved, and the contained app PID otherwise. The frame-host PID is never
    // that app. A second frame of the target app therefore counts as the person.
    // An unproved frame is unknown only for a packaged root. An ordinary target
    // keeps the host pid, which is never that target's pid.
    internal static uint ActivityPid(IntPtr hwnd, uint rawPid, WindowRecord target, Func<IntPtr, IntPtr, bool> child, Func<IntPtr, uint?> hosted)
    {
        if (hwnd == IntPtr.Zero || rawPid == 0) return 0;
        if (target != null && target.CoreHandle != IntPtr.Zero && (hwnd == target.Handle || child(target.Handle, hwnd))) return target.Pid;
        if (hosted == null) return rawPid;
        uint? app = hosted(hwnd);
        if (!app.HasValue) return rawPid;
        if (app.Value == 0 && (target == null || target.CoreHandle == IntPtr.Zero)) return rawPid;
        return app.Value;
    }
    internal static void Require(WindowRecord window)
    {
#if SLEIGHT_TEST_SEAMS
        if (DriverInput.DragScript.Person != null) { DriverInput.DragScript.Person(window); return; }
#endif
        DriverSession.Require();
        var timing = DriverCheckpointTimings.Start(DriverCheckpointTimings.Kind.PersonInput);
        try {
            uint foregroundPid = 0, pointerPid = 0, age = 0xffffffffu;
            try {
                uint last = DriverInput.LastPersonInput();
                age = unchecked((uint)Environment.TickCount - last);
                IntPtr foreground = GetForegroundWindow(); DriverPoint point;
                if (foreground == IntPtr.Zero || DriverInput.GetWindowThreadProcessId(foreground, out foregroundPid) == 0 ||
                    !GetCursorPos(out point)) throw new InvalidOperationException();
                IntPtr pointer = WindowFromPoint(point);
                if (pointer == IntPtr.Zero || DriverInput.GetWindowThreadProcessId(pointer, out pointerPid) == 0) throw new InvalidOperationException();
                foregroundPid = ActivityPid(foreground, foregroundPid, window, DriverInput.IsChild, DriverInventory.LiveHostedAppPid);
                pointerPid = ActivityPid(pointer, pointerPid, window, DriverInput.IsChild, DriverInventory.LiveHostedAppPid);
            } catch { throw DriverSession.Refusal("PERSON_TOOK_OVER", "person-unknown"); }
            string reason = Decide(age, foregroundPid, pointerPid, window.Pid);
            if (reason != null) throw DriverSession.Refusal("PERSON_TOOK_OVER", reason, reason == "person-active");
        } finally { timing.Finish(); }
    }
}
internal static class DriverInput
{
    [ThreadStatic] static long actionDeadline;
    [ThreadStatic] internal static bool InputAttempted;
    [ThreadStatic] internal static int Typed, PostedMessages;
    internal enum StopReason { None, Deadline, Cancel, Escape }
    [ThreadStatic] internal static Func<StopReason> Cancelled;
    internal sealed class ProgressRecord { internal int Units, Posts, Attempted; }
    [ThreadStatic] internal static ProgressRecord Progress;
    internal static void MarkInput() { InputAttempted = true; if (Progress != null) Volatile.Write(ref Progress.Attempted, 1); }
    internal static void RecordTyped(int units) { SetTyped(units); }
    static void SetTyped(int units) { Typed = units; if (Progress != null) Volatile.Write(ref Progress.Units, units); }
    sealed class Budget : IDisposable {
        readonly long previous;
        internal Budget(long deadline) {
            previous = actionDeadline; actionDeadline = deadline - 2750;
            InputAttempted = false; Typed = 0; PostedMessages = 0;
        }
        public void Dispose() { actionDeadline = previous; }
    }
    internal static IDisposable WithDeadline(long deadline) { return new Budget(deadline); }
    internal static void EnsureNotCancelled() {
        StopReason reason = Cancelled == null ? StopReason.None : Cancelled();
        if (reason == StopReason.Cancel || reason == StopReason.Escape)
            throw DriverSession.WireFault(DriverSession.Refusal("USER_STOPPED", reason == StopReason.Escape ? "escape" : "cancel"));
        if (reason == StopReason.Deadline) throw DriverSession.BudgetFault();
    }
    internal static void EnsureBudget() {
        var timing = DriverCheckpointTimings.Start(DriverCheckpointTimings.Kind.BudgetCheck);
        try {
            EnsureNotCancelled();
            if (actionDeadline != 0 && Driver.Now() >= actionDeadline) throw DriverSession.BudgetFault();
        } finally { timing.Finish(); }
    }
    internal static void Pause(int milliseconds)
    {
#if SLEIGHT_TEST_SEAMS
        if (DragScript.Pause != null) { DragScript.Pause(milliseconds); return; }
#endif
        var clock = System.Diagnostics.Stopwatch.StartNew();
        for (;;) {
            EnsureBudget();
            long remaining = milliseconds - clock.ElapsedMilliseconds;
            if (remaining <= 0) break;
            Thread.Sleep((int)Math.Min(10, remaining));
        }
        EnsureBudget();
    }
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { internal int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct GuiInfo {
        internal uint Size, Flags;
        internal IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        internal Rect CaretRect;
    }
    [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiInfo info);
    [DllImport("user32.dll")] internal static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("user32.dll")] internal static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] internal static extern bool ClientToScreen(IntPtr hwnd, ref DriverPoint point);
    [DllImport("user32.dll")] static extern bool PhysicalToLogicalPointForPerMonitorDPI(IntPtr hwnd, ref DriverPoint point);
    [DllImport("user32.dll")] static extern bool LogicalToPhysicalPointForPerMonitorDPI(IntPtr hwnd, ref DriverPoint point);
    [DllImport("user32.dll")] internal static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool PostMessageW(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    internal static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint message, UIntPtr wParam, IntPtr lParam,
        uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hwnd, System.Text.StringBuilder name, int count);
    [DllImport("user32.dll", SetLastError = true)] static extern int GetWindowLongW(IntPtr hwnd, int index);
    [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
    [StructLayout(LayoutKind.Sequential)] struct LastInput { internal uint Size, Time; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput input);
    internal static bool IdleEnough(uint now, uint last) { uint age = unchecked(now - last); return age >= 2000 && age < 0x80000000u; }
    internal static uint LastPersonInput() {
        var input = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) };
        if (!GetLastInputInfo(ref input)) throw new DriverFault("IDLE_UNAVAILABLE");
        return input.Time;
    }
    internal static void RequireIdle() {
        if (!IdleEnough(unchecked((uint)Environment.TickCount), LastPersonInput())) throw new DriverFault("USER_ACTIVE");
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScanExW(char ch, IntPtr layout);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint MapVirtualKeyExW(uint code, uint kind, IntPtr layout);
    internal static void RequireOwned(WindowRecord window, IntPtr hwnd, uint pid, bool child)
    {
        if (window == null || hwnd == IntPtr.Zero || pid == 0 || pid != window.Pid || hwnd != window.InputRoot && !child)
            throw new DriverFault("IDENTITY_CHANGED");
    }
    internal static void Check(WindowRecord window, IntPtr hwnd)
    {
        var counters = DriverOperationCounters.Current;
        long started = counters == null ? 0 : System.Diagnostics.Stopwatch.GetTimestamp();
        try {
            uint pid; uint thread = GetWindowThreadProcessId(hwnd, out pid);
            Check(window, hwnd, thread == 0 ? 0 : pid, IsChild, handle => DriverInventory.Observe(handle));
        } finally { if (counters != null) counters.IdentityCheck(started); }
    }
    internal static void Check(WindowRecord window, IntPtr hwnd, uint pid, Func<IntPtr, IntPtr, bool> child, Func<IntPtr, WindowRecord> observe)
    {
        RequireOwned(window, hwnd, pid, hwnd != window.InputRoot && child(window.InputRoot, hwnd));
        var current = observe(window.Handle);
        if (current == null) throw new DriverFault("IDENTITY_CHANGED");
        current.RequireReadable();
        if (!window.SameIdentity(current)) throw new DriverFault("IDENTITY_CHANGED");
    }
    internal static IntPtr Focus(WindowRecord window)
    {
        uint pid; uint thread = GetWindowThreadProcessId(window.InputRoot, out pid);
        var info = new GuiInfo { Size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
        if (thread == 0 || !GetGUIThreadInfo(thread, ref info) || info.Focus == IntPtr.Zero) throw new DriverFault("NO_BACKGROUND_FOCUS");
        Check(window, info.Focus);
        DriverInventory.LifecycleFocus(window, info.Focus);
        return info.Focus;
    }
    internal static DriverPoint PhysicalPoint(WindowRecord window, object[] point)
    {
        var p = new DriverPoint((int)Math.Round(DriverActionPlan.Number(point[0], 0, 1000000)),
            (int)Math.Round(DriverActionPlan.Number(point[1], 0, 1000000)));
        Rect r;
        if (!GetClientRect(window.InputRoot, out r) || p.X < r.Left || p.Y < r.Top || p.X >= r.Right || p.Y >= r.Bottom || !ClientToScreen(window.InputRoot, ref p))
            throw new DriverFault("INVALID_COORDINATES");
        return p;
    }
    internal static bool PointerMessage(uint message) { return message >= 0x200 && message <= 0x20e; }
    internal static void RequireInside(DriverPoint point, Rect surface)
    {
        if (surface.Right <= surface.Left || surface.Bottom <= surface.Top || point.X < surface.Left || point.Y < surface.Top ||
            point.X >= surface.Right || point.Y >= surface.Bottom) throw new DriverFault("INVALID_COORDINATES");
    }
    internal static bool PointerEffect(Action identity, Func<DriverPoint> point, Func<Rect> surface, Func<bool> post)
    {
        identity();
        DriverPoint physical = point();
        RequireInside(physical, surface());
        identity();
        // Full identity observation can query native metadata. Refresh packet
        // conversion and client bounds after it, directly beside the post.
        RequireInside(point(), surface());
        return post();
    }
    internal static bool InputEffect(Action identity, Func<bool> post)
    {
        identity();
        return post();
    }
    static Rect RootSurface(WindowRecord window)
    {
        Rect r;
        if (!GetClientRect(window.InputRoot, out r)) throw new DriverFault("INVALID_COORDINATES");
        var first = new DriverPoint(r.Left, r.Top); var last = new DriverPoint(r.Right, r.Bottom);
        if (!ClientToScreen(window.InputRoot, ref first) || !ClientToScreen(window.InputRoot, ref last)) throw new DriverFault("INVALID_COORDINATES");
        return new Rect { Left = first.X, Top = first.Y, Right = last.X, Bottom = last.Y };
    }
    static DriverPoint PostedPoint(IntPtr hwnd, uint message, IntPtr packed)
    {
        long bits = packed.ToInt64();
        var point = new DriverPoint(unchecked((short)bits), unchecked((short)(bits >> 16)));
        if (message != 0x20a && message != 0x20e) {
            var origin = new DriverPoint(0, 0);
            if (!ClientToScreen(hwnd, ref origin)) throw new DriverFault("INVALID_COORDINATES");
            origin = LogicalScreen(hwnd, origin);
            point.X += origin.X; point.Y += origin.Y;
        }
        if (!LogicalToPhysicalPointForPerMonitorDPI(hwnd, ref point)) throw new DriverFault("INVALID_COORDINATES");
        return point;
    }
    // UIA rectangles and public points are physical. Conversion is per destination HWND,
    // including a child with a different awareness, never a guessed monitor-wide scale.
    internal static DriverPoint LogicalClient(IntPtr hwnd, DriverPoint physical)
    {
#if SLEIGHT_TEST_SEAMS
        if (DragScript.Logical != null) return DragScript.Logical(hwnd, physical);
#endif
        DriverPoint origin = new DriverPoint(0, 0);
        if (!ClientToScreen(hwnd, ref origin)) throw new DriverFault("INVALID_COORDINATES");
        return ConvertPoint(physical, origin, p => LogicalScreen(hwnd, p));
    }
    internal static DriverPoint LogicalScreen(IntPtr hwnd, DriverPoint physical)
    {
        if (!PhysicalToLogicalPointForPerMonitorDPI(hwnd, ref physical)) throw new DriverFault("INVALID_COORDINATES");
        return physical;
    }
    internal static DriverPoint ConvertPoint(DriverPoint physical, DriverPoint origin, Func<DriverPoint, DriverPoint> convert)
    {
        DriverPoint p = convert(physical), o = convert(origin);
        p.X -= o.X; p.Y -= o.Y; Pack(p); return p;
    }
    internal static IntPtr Pack(DriverPoint p)
    {
        if (p.X < Int16.MinValue || p.X > Int16.MaxValue || p.Y < Int16.MinValue || p.Y > Int16.MaxValue)
            throw new DriverFault("INVALID_COORDINATES");
        return new IntPtr(unchecked((long)((ushort)p.X | ((uint)(ushort)p.Y << 16))));
    }
#if SLEIGHT_TEST_SEAMS
    // The confinement fixture assigns these so Drag can run without a posted message.
    internal static class DragScript
    {
        internal static Action<WindowRecord, IntPtr, uint, uint, IntPtr, bool> Post;
        internal static Action<WindowRecord> Person;
        internal static Func<IntPtr, DriverPoint, DriverPoint> Logical;
        internal static Action<int> Pause;
    }
#endif
    internal static void Post(WindowRecord window, IntPtr hwnd, uint message, uint wParam, IntPtr lParam, bool cleanup = false,
        bool validated = false, bool backpressure = false, bool idle = false)
    {
#if SLEIGHT_TEST_SEAMS
        if (DragScript.Post != null) { DragScript.Post(window, hwnd, message, wParam, lParam, cleanup); return; }
#endif
        Post(window, hwnd, message, wParam, lParam, cleanup, validated, backpressure, idle, new PostApi {
            Identity = Check, Person = DriverPerson.Require, Idle = RequireIdle,
            Send = NativePost,
            Point = PostedPoint, Surface = RootSurface, Error = Marshal.GetLastWin32Error, Pause = () => Thread.Sleep(10)
        });
    }
    static bool NativePost(IntPtr hwnd, uint message, uint wParam, IntPtr lParam)
    {
        DriverOperationCounters.Mark(DriverOperationCounters.Kind.PostedMessage);
        return PostMessageW(hwnd, message, new UIntPtr(wParam), lParam);
    }
    internal sealed class PostApi
    {
        internal Action<WindowRecord, IntPtr> Identity;
        internal Action<WindowRecord> Person;
        internal Action Idle, Pause;
        internal Func<IntPtr, uint, uint, IntPtr, bool> Send;
        internal Func<IntPtr, uint, IntPtr, DriverPoint> Point;
        internal Func<WindowRecord, Rect> Surface;
        internal Func<int> Error;
    }
    internal static void Post(WindowRecord window, IntPtr hwnd, uint message, uint wParam, IntPtr lParam, bool cleanup,
        bool validated, bool backpressure, bool idle, PostApi api)
    {
        RequirePostMessage(message);
        if (!cleanup) EnsureBudget();
        if (!validated) api.Identity(window, hwnd);
        if (!cleanup) EnsureBudget();
        RetryPost(() => {
            if (idle) api.Idle();
            // Identity and person safety are sampled for every post and retry.
            return InputEffect(() => api.Identity(window, hwnd), () => {
                Func<bool> post = () => {
                    if (!cleanup) api.Person(window);
                    return api.Send(hwnd, message, wParam, lParam);
                };
                return PointerMessage(message) ? PointerEffect(() => api.Identity(window, hwnd), () => api.Point(hwnd, message, lParam),
                    () => api.Surface(window), post) : post();
            });
        }, api.Error, api.Pause, () => { if (!cleanup) EnsureBudget(); api.Identity(window, hwnd); }, backpressure);
        MarkInput(); PostedMessages++;
        if (Progress != null) Volatile.Write(ref Progress.Posts, PostedMessages);
    }
    internal static void RequirePostMessage(uint message)
    {
        switch (message) {
        case 0x100: case 0x101: case 0x102: case 0x103: case 0x104: case 0x105: case 0x109:
        case 0x200: case 0x201: case 0x202: case 0x203: case 0x204: case 0x205: case 0x20a: case 0x20e: return;
        default: throw new DriverFault("INVALID_MESSAGE");
        }
    }
    internal static void RetryPost(Func<bool> post, Func<int> error, Action pause, Action check, bool backpressure)
    {
        for (int attempt = 0; ; attempt++) {
            if (post()) return;
            // ERROR_NOT_ENOUGH_QUOTA means this message was not enqueued. Only that
            // failure can be retried without duplicating input, with a 100 ms bound.
            if (!backpressure || error() != 1816 || attempt == 10)
                throw new DriverFault("BACKGROUND_INPUT_FAILED");
            pause(); check();
        }
    }
    static IntPtr KeyData(int key, bool up, bool previous, bool alt, IntPtr layout)
    {
        uint scan = MapVirtualKeyExW((uint)key, 4, layout);
        uint bits = 1 | ((scan & 255) << 16);
        if ((scan & 0xff00) == 0xe000) bits |= 1u << 24;
        if (alt) bits |= 1u << 29;
        if (previous) bits |= 1u << 30;
        if (up) bits |= 1u << 31;
        return new IntPtr(unchecked((long)bits));
    }
    // Resolve once before route selection. Posted input consumes these exact codes
    // and this layout; a later layout switch cannot introduce an unchecked key.
    internal sealed class ResolvedKey {
        internal int Key;
        internal int[] Modifiers;
        internal IntPtr Layout;
    }
    internal static ResolvedKey ResolveKeys(DriverChord chord, Func<char, short> map)
    {
        var modifiers = new List<int>(chord.Modifiers);
        int key = chord.Key == null ? 0 : DriverChord.VirtualKey(chord.Key);
        if (chord.Key != null && key == 0) {
            short mapped = map(chord.Key[0]);
            if (mapped == -1 || (mapped & 0xf800) != 0) throw new DriverFault("KEY_LAYOUT_UNAVAILABLE");
            key = mapped & 255;
            if ((mapped & 0x100) != 0 && !modifiers.Contains(16)) modifiers.Add(16);
            if ((mapped & 0x200) != 0 && !modifiers.Contains(17)) modifiers.Add(17);
            if ((mapped & 0x400) != 0 && !modifiers.Contains(18)) modifiers.Add(18);
        }
        return new ResolvedKey { Key = key, Modifiers = modifiers.ToArray() };
    }
    internal static ResolvedKey ResolveKeys(WindowRecord window, IntPtr hwnd, DriverChord chord)
    {
        Check(window, hwnd);
        uint pid; uint thread = GetWindowThreadProcessId(hwnd, out pid);
        IntPtr layout = GetKeyboardLayout(thread);
        if (thread == 0 || layout == IntPtr.Zero) throw new DriverFault("KEY_LAYOUT_UNAVAILABLE");
        var resolved = ResolveKeys(chord, c => VkKeyScanExW(c, layout));
        resolved.Layout = layout; return resolved;
    }
    internal static string[] Keys(WindowRecord window, IntPtr hwnd, DriverChord chord, bool idle = false, ResolvedKey resolved = null)
    {
        resolved = resolved ?? ResolveKeys(window, hwnd, chord);
        DriverClipboardRule.RefuseKey(resolved);
        int key = resolved.Key;
        var modifiers = resolved.Modifiers;
        IntPtr layout = resolved.Layout;
        var limits = chord.PostedLimits(modifiers);
        var down = new List<int>(); bool alt = false;
        try {
            foreach (int m in modifiers) {
                Post(window, hwnd, alt || m == 18 ? 0x104u : 0x100u, (uint)m, KeyData(m, false, false, alt, layout));
                down.Add(m); if (m == 18) alt = true;
            }
            if (key != 0) {
                Post(window, hwnd, alt ? 0x104u : 0x100u, (uint)key, KeyData(key, false, false, alt, layout), false, false, false, idle); down.Add(key);
                Post(window, hwnd, alt ? 0x105u : 0x101u, (uint)key, KeyData(key, true, true, alt, layout)); down.RemoveAt(down.Count - 1);
            }
        } finally {
            Exception cleanup = null;
            for (int i = down.Count - 1; i >= 0; i--) {
                int m = down[i];
                try { Post(window, hwnd, alt ? 0x105u : 0x101u, (uint)m, KeyData(m, true, true, alt, layout), true); }
                catch (Exception e) { if (cleanup == null) cleanup = e; }
                if (m == 18) alt = false;
            }
            if (cleanup != null) throw cleanup;
        }
        return limits;
    }
    internal static void SetValue(WindowRecord window, IntPtr hwnd, string text)
    {
        Check(window, hwnd);
        // WM_SETTEXT is an edit-control operation, never a window-title fallback.
        RequireWritableEdit(hwnd);
        IntPtr data = Marshal.StringToHGlobalUni(text);
        try {
            EnsureBudget(); Check(window, hwnd); DriverPerson.Require(window); MarkInput(); UIntPtr result;
            // System messages below WM_USER marshal their data across process boundaries.
            if (SendMessageTimeoutW(hwnd, 0x000c, UIntPtr.Zero, data, 0x22, 500, out result) == IntPtr.Zero || result == UIntPtr.Zero)
                throw new DriverFault("ACTION_UNCONFIRMED", "WM_SETTEXT did not confirm completion");
        } finally { Marshal.FreeHGlobal(data); }
    }
    internal static void RequireEditStyle(string cls, int style)
    {
        if (!(cls.Equals("Edit", StringComparison.OrdinalIgnoreCase) || cls.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase)))
            throw new DriverFault("BACKGROUND_UNAVAILABLE", "direct text input needs a writable native Edit or RichEdit HWND; the system clipboard was not accessed");
        if ((style & 0x800) != 0) throw new DriverFault("ELEMENT_READ_ONLY"); // ES_READONLY
    }
    internal static void RequireWritableEdit(IntPtr hwnd)
    {
        var name = new System.Text.StringBuilder(256);
        if (GetClassNameW(hwnd, name, name.Capacity) == 0) throw new DriverFault("BACKGROUND_UNAVAILABLE", "native edit class could not be proved");
        SetLastError(0);
        int style = GetWindowLongW(hwnd, -16); // GWL_STYLE, a 32-bit value on both architectures.
        if (style == 0 && Marshal.GetLastWin32Error() != 0) throw new DriverFault("BACKGROUND_UNAVAILABLE", "native edit style could not be proved");
        RequireEditStyle(name.ToString(), style);
    }
    internal static string Type(WindowRecord window, IntPtr hwnd, string text, bool requireFocus = false)
    {
        Action check = () => {
            DriverPerson.Require(window);
            Check(window, hwnd);
            if (requireFocus) {
                if (Focus(window) != hwnd) throw new DriverFault("NO_BACKGROUND_FOCUS");
                RequireWritableEdit(hwnd);
            }
        };
        check(); EnsureBudget();
        UIntPtr answer;
        bool unicode = SendMessageTimeoutW(hwnd, 0x109, new UIntPtr(0xffff), IntPtr.Zero, 0x22, 100, out answer) != IntPtr.Zero && answer != UIntPtr.Zero;
        uint pid; IntPtr layout = GetKeyboardLayout(GetWindowThreadProcessId(hwnd, out pid));
        PumpText(text, unicode, (message, code, cleanup) => {
            IntPtr data = message == 0x100 || message == 0x101 ? KeyData(13, cleanup, cleanup, false, layout) : new IntPtr(1);
            Post(window, hwnd, message, code, data, cleanup, !cleanup, true);
        }, check, () => {
            check(); EnsureBudget(); UIntPtr ignored;
            // Sent WM_NULL checks responsiveness. It does not drain the posted queue;
            // quota errors are handled by bounded retries of the failed post above.
            if (SendMessageTimeoutW(hwnd, 0, UIntPtr.Zero, IntPtr.Zero, 0x22, 500, out ignored) == IntPtr.Zero)
                throw new DriverFault("TEXT_UNCONFIRMED");
        });
        return unicode ? "WM_UNICHAR" : "WM_CHAR";
    }
    internal static bool TextCheckpoint(int index, int units, int nextCheck)
    {
        return index >= nextCheck || index + units > nextCheck;
    }
    internal static void PumpText(string text, bool unicode, Action<uint, uint, bool> post, Action check, Action flow)
    {
        if (text.Any(c => c < 32 && c != '\t' && c != '\r' && c != '\n')) throw new DriverFault("INVALID_PARAMS");
        Typed = 0; int nextCheck = 0, pending = 0;
        Action<uint, uint, bool> send = (message, code, cleanup) => { post(message, code, cleanup); pending++; };
        try {
            for (int i = 0; i < text.Length; i++) {
                char c = text[i];
                int units = (unicode && Char.IsHighSurrogate(c) || c == '\r' && i + 1 < text.Length && text[i + 1] == '\n') ? 2 : 1;
                if (TextCheckpoint(i, units, nextCheck)) { check(); nextCheck = i + 64; }
                if (c == '\r' || c == '\n') {
                    if (units == 2) i++;
                    send(0x100, 13, false);
                    try { send(0x102, 13, false); SetTyped(Typed + units); }
                    finally { send(0x101, 13, true); }
                } else if (unicode) {
                    uint code = c;
                    if (Char.IsHighSurrogate(c)) code = (uint)Char.ConvertToUtf32(c, text[++i]);
                    send(0x109, code, false); SetTyped(Typed + units);
                } else { send(0x102, c, false); SetTyped(Typed + 1); }
                if (pending >= 256) { flow(); pending = 0; }
            }
            if (pending != 0) flow();
        } catch (DriverFault e) {
            throw new DriverFault(e.Code, e.Message + "; typed=" + Typed + " UTF-16 units; postedMessages=" + PostedMessages + ". Input may have landed; read again before repeating.") { Disposition = e.Disposition };
        }
    }
    internal static void Click(WindowRecord window, IntPtr hwnd, DriverPoint physical, string method)
    {
        IntPtr p = Pack(LogicalClient(hwnd, physical));
        Post(window, hwnd, 0x200, 0, p);
        uint down = method == "rightClick" ? 0x204u : 0x201u, up = method == "rightClick" ? 0x205u : 0x202u;
        uint button = method == "rightClick" ? 2u : 1u;
        Post(window, hwnd, down, button, p);
        try { } finally { Post(window, hwnd, up, 0, p, true); }
        if (method == "doubleClick") {
            Post(window, hwnd, 0x203, 1, p);
            try { } finally { Post(window, hwnd, 0x202, 0, p, true); }
        }
    }
    // An outside step throws inside Post, so last stays at the previous inside point.
    internal static void Drag(WindowRecord window, IntPtr hwnd, DriverPoint from, DriverPoint to, int steps, int duration)
    {
        DriverPoint start = LogicalClient(hwnd, from), end = LogicalClient(hwnd, to);
        IntPtr last = Pack(start);
        Post(window, hwnd, 0x200, 0, last); Post(window, hwnd, 0x201, 1, last);
        try {
            Pause(500);
            for (int i = 1; i <= steps; i++) {
                DriverPerson.Require(window);
                DriverPoint point = new DriverPoint(start.X + (int)Math.Round((end.X - start.X) * (double)i / steps),
                    start.Y + (int)Math.Round((end.Y - start.Y) * (double)i / steps));
                IntPtr packed = Pack(point);
                Post(window, hwnd, 0x200, 1, packed);
                last = packed;
                Pause(duration / steps);
            }
        } finally { Post(window, hwnd, 0x202, 0, last, true); }
    }
}
}
