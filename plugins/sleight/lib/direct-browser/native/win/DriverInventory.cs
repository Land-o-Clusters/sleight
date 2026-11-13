using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Security.Cryptography;

namespace Sleight.Driver
{
// WTS and the input desktop are independent samples. Only the Win10/11 flag
// values are supported; the historical Windows 7 inversion is not applied.
internal static class DriverSession
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WtsLevel1 {
        public uint Session;
        public int State, Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 33)] public string Station;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 21)] public string User;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 18)] public string Domain;
        public long Logon, Connect, Disconnect, LastInput, Current;
        public uint InBytes, OutBytes, InFrames, OutFrames, InCompressed, OutCompressed;
    }
    [StructLayout(LayoutKind.Sequential)] struct WtsInfoEx { public uint Level; public WtsLevel1 Data; }
    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool WTSQuerySessionInformationW(IntPtr server, uint session, int infoClass, out IntPtr data, out uint bytes);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr data);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetUserObjectInformationW(IntPtr handle, int index, StringBuilder value, uint bytes, out uint needed);
    static int secure;
    internal static string Decide(bool wtsOk, int state, int flags, bool desktopOpened, string desktopName)
    {
        if (!wtsOk || flags != 0 && flags != 1) return "session-unknown";
        if (state != 0) return "session-disconnected";
        if (flags == 0) return "session-locked";
        if (!desktopOpened || desktopName == "Winlogon") return "secure-desktop";
        if (desktopName == "Screen-saver") return "screensaver";
        if (desktopName == "Default") return null;
        return "input-desktop-unavailable";
    }
    internal static string Sample()
    {
        var timing = DriverCheckpointTimings.Start(DriverCheckpointTimings.Kind.SessionProbe);
        try {
            bool wtsOk = false, opened = false; int state = -1, flags = -1;
            IntPtr data = IntPtr.Zero, desktop = IntPtr.Zero; string name = null;
            var lockTiming = DriverCheckpointTimings.Start(DriverCheckpointTimings.Kind.LockCheck);
            try {
                uint bytes;
                if (WTSQuerySessionInformationW(IntPtr.Zero, 0xffffffffu, 25, out data, out bytes) && data != IntPtr.Zero &&
                    bytes >= Marshal.SizeOf(typeof(WtsInfoEx))) {
                    var info = (WtsInfoEx)Marshal.PtrToStructure(data, typeof(WtsInfoEx));
                    wtsOk = info.Level == 1; state = info.Data.State; flags = info.Data.Flags;
                }
            } catch { wtsOk = false; }
            finally { try { if (data != IntPtr.Zero) WTSFreeMemory(data); } finally { lockTiming.Finish(); } }
            var desktopTiming = DriverCheckpointTimings.Start(DriverCheckpointTimings.Kind.DesktopCheck);
            try {
                desktop = OpenInputDesktop(0, false, 1); // DESKTOP_READOBJECTS
                opened = desktop != IntPtr.Zero;
                if (opened) {
                    var text = new StringBuilder(256); uint needed;
                    if (GetUserObjectInformationW(desktop, 2, text, (uint)text.Capacity * 2, out needed)) name = text.ToString(); // UOI_NAME
                }
            } catch { opened = false; }
            finally { try { if (desktop != IntPtr.Zero) CloseDesktop(desktop); } finally { desktopTiming.Finish(); } }
            string reason = Decide(wtsOk, state, flags, opened, name);
            System.Threading.Volatile.Write(ref secure, reason == "secure-desktop" ? 1 : 0);
            return reason;
        } finally { timing.Finish(); }
    }
    internal static DriverFault Refusal(string code, string reason, bool person = false)
    {
        bool sent = DriverInput.InputAttempted;
        var fields = Json.Map("code", code, "reason", reason, "unhealthy", false,
            "delivery", sent ? "sent-unverified" : "not-sent", "retry", sent ? "read-first" : "safe",
            "typed", DriverInput.Typed, "personTookOver", person);
        if (reason == "secure-desktop") fields["limits"] = new[] { "secure-desktop-seen" };
        return new DriverFault(code) { Disposition = fields };
    }
    internal static bool IsSafety(DriverFault fault)
    {
        return fault.Code == "USER_STOPPED" || fault.Code == "PERSON_TOOK_OVER" || fault.Code == "SCREEN_LOCKED" || fault.Code == "SECURE_DESKTOP_ACTIVE";
    }
    // Keep diagnostics useful for parents that do not yet consume the structured
    // disposition. Sent failures retain the read-before-repeating rule.
    internal static DriverFault WireFault(DriverFault fault)
    {
        var fields = fault.Disposition;
        if (fields == null) return fault;
        string message = fault.Code + ": reason=" + fields["reason"] + "; delivery=" + fields["delivery"] +
            "; retry=" + fields["retry"] + "; typed=" + fields["typed"] + "; personTookOver=" + fields["personTookOver"];
        if (fields.ContainsKey("limits")) message += "; limits=[secure-desktop-seen]";
        if ((string)fields["delivery"] != "not-sent") message += ". Read the app state before repeating any input.";
        return new DriverFault(fault.Code, message) { Disposition = fields };
    }
    internal static void Require()
    {
        DriverInput.EnsureNotCancelled();
        string reason = Sample();
        if (reason != null) throw Refusal(reason == "secure-desktop" ? "SECURE_DESKTOP_ACTIVE" : "SCREEN_LOCKED", reason);
    }
    // A memo belongs to one read, never to an action's input boundary. Start and
    // finish always sample fresh; only provider-walk checkpoints reuse a pass.
    internal sealed class ReadProbe
    {
        readonly Stopwatch clock = new Stopwatch();
        internal ReadProbe() { DriverSession.Require(); clock.Start(); }
        internal void Require()
        {
            if (clock.ElapsedMilliseconds < 50) return;
            DriverSession.Require(); clock.Restart();
        }
        internal void Finish() { DriverSession.Require(); }
    }
    internal static void AddHint(Dictionary<string, object> result)
    {
        Sample();
        if (System.Threading.Volatile.Read(ref secure) != 0) result["limits"] = new[] { "secure-desktop-seen" };
    }
    internal static string DeadlineHint()
    {
        var result = Json.Map(); AddHint(result);
        return result.ContainsKey("limits") ? " limits=[secure-desktop-seen]." : "";
    }
    internal static DriverFault BudgetFault()
    {
        var result = Json.Map(); AddHint(result);
        return new DriverFault("ACTION_BUDGET", "ACTION_BUDGET" +
            (result.ContainsKey("limits") ? " limits=[secure-desktop-seen]." : ""));
    }
}
internal sealed class WindowRecord
{
    internal IntPtr Handle, Owner, CoreHandle;
    internal uint Pid, ThreadId, FramePid, FrameThreadId;
    internal string FrameStart;
    internal string BindingId, WindowGeneration, TopologyGeneration, DesktopId;
    internal IntPtr InputRoot { get { return CoreHandle == IntPtr.Zero ? Handle : CoreHandle; } }
    internal string ProcessStart, Image, ImageIdentity, OriginalFilename, ProductName, Aumid, App, Title, ClassName, Integrity, Refused, RefusalStep;
    internal bool Cloaked, Minimized, Popup;
    internal bool? OnCurrentDesktop;
    internal static string Id(IntPtr hwnd) { return unchecked((ulong)hwnd.ToInt64()).ToString(CultureInfo.InvariantCulture); }
    internal void RequireReadable()
    {
        DriverInventory.RequireFramePolicy(this);
        if (DriverIdentity.UnresolvedHost(this)) throw new DriverFault("HOSTED_APP_UNRESOLVED");
        if (Refused != null) throw new DriverFault(Refused, Refused, RefusalStep);
        if ((Integrity != "medium" && Integrity != "low" && Integrity != "high" && Integrity != "system") || Pid == 0 ||
            String.IsNullOrEmpty(ProcessStart) || String.IsNullOrEmpty(Image)) throw new DriverFault("TARGET_UNAVAILABLE", "TARGET_UNAVAILABLE", RefusalStep);
        Guid desktop;
        if (!OnCurrentDesktop.HasValue || !Guid.TryParse(DesktopId, out desktop) || desktop == Guid.Empty)
            throw new DriverFault("TARGET_UNAVAILABLE", "virtual desktop identity is unavailable", RefusalStep ?? "desktop");
        if (Minimized && Aumid != null) throw new DriverFault("MINIMIZED_PACKAGED_WINDOW");
    }
    internal bool SameIdentity(WindowRecord other)
    {
        return other != null && Handle == other.Handle && Pid == other.Pid && CoreHandle == other.CoreHandle && FramePid == other.FramePid && FrameStart == other.FrameStart &&
            (BindingId == null || other.BindingId == null || BindingId == other.BindingId) &&
            OriginalFilename == other.OriginalFilename && ProductName == other.ProductName &&
            ProcessStart == other.ProcessStart && ImageIdentity == other.ImageIdentity && ThreadId == other.ThreadId && FrameThreadId == other.FrameThreadId && ClassName == other.ClassName &&
            WindowGeneration == other.WindowGeneration && TopologyGeneration == other.TopologyGeneration && Owner == other.Owner &&
            DesktopId == other.DesktopId && OnCurrentDesktop == other.OnCurrentDesktop &&
            String.Equals(Image, other.Image, StringComparison.OrdinalIgnoreCase) && Aumid == other.Aumid;
    }
    internal WindowRecord Copy() { return (WindowRecord)MemberwiseClone(); }
    internal Dictionary<string, object> JsonValue()
    {
        var result = Json.Map("windowId", Id(Handle), "pid", Pid, "threadId", ThreadId, "processStart", ProcessStart, "image", Refused == null || Refused == "ELEVATED_TARGET" ? Image : null,
            "imageIdentity", Refused == null ? ImageIdentity : null,
            "originalFilename", Refused == null || Refused == "ELEVATED_TARGET" ? OriginalFilename : null, "productName", Refused == null || Refused == "ELEVATED_TARGET" ? ProductName : null, "aumid", Refused == null ? Aumid : null,
            "app", Refused == null || Refused == "ELEVATED_TARGET" ? App : null, "title", Refused == null ? Title : null, "className", Refused == null ? ClassName : null, "integrity", Integrity, "cloaked", Cloaked,
            "onCurrentDesktop", OnCurrentDesktop, "minimized", Minimized, "popup", Popup, "ownerWindowId", Id(Owner), "refused", Refused,
            "bindingId", BindingId, "windowGeneration", WindowGeneration, "topologyGeneration", TopologyGeneration, "desktopId", DesktopId,
            "coreWindowId", CoreHandle == IntPtr.Zero ? null : Id(CoreHandle), "framePid", FramePid, "frameProcessStart", FrameStart,
            "frameThreadId", FrameThreadId);
        if (Refused == "HOSTED_APP_UNRESOLVED") result["hostedSelectorHashes"] = DriverInventory.HostedSelectorHashes(this);
        string step = DriverFault.FailureStep(Refused, RefusalStep);
        if (step != null) result["refusalStep"] = step;
        return result;
    }
}
// Tokens name immutable native admissions, never a caller's replacement tuple.
// Only the current token for an HWND remains resolvable. Revocation is permanent.
internal sealed class DriverBindings
{
    readonly object sync = new object();
    readonly Dictionary<IntPtr, WindowRecord> windows = new Dictionary<IntPtr, WindowRecord>();
    readonly Dictionary<string, WindowRecord> tokens = new Dictionary<string, WindowRecord>();
    internal void Revoke(IntPtr hwnd)
    {
        lock (sync) {
            WindowRecord old;
            if (windows.TryGetValue(hwnd, out old)) { tokens.Remove(old.BindingId); windows.Remove(hwnd); }
        }
    }
    internal int Count { get { lock (sync) return windows.Count; } }
    internal void Prune(Func<IntPtr, bool> exists)
    {
        lock (sync) foreach (var hwnd in windows.Keys.ToArray()) if (!exists(hwnd)) Revoke(hwnd);
    }
    internal WindowRecord Remember(WindowRecord window)
    {
        lock (sync) {
            WindowRecord old;
            if (windows.TryGetValue(window.Handle, out old) && old.SameIdentity(window)) {
                window.BindingId = old.BindingId; return window;
            }
            Revoke(window.Handle);
            window.RequireReadable();
            if (String.IsNullOrEmpty(window.WindowGeneration) || String.IsNullOrEmpty(window.TopologyGeneration) || windows.Count >= 4096)
                throw new DriverFault("TARGET_UNAVAILABLE");
            window.BindingId = Guid.NewGuid().ToString("N");
            var admitted = window.Copy();
            windows.Add(window.Handle, admitted); tokens.Add(window.BindingId, admitted);
            return window;
        }
    }
    internal WindowRecord Resolve(string token, IntPtr hwnd, string birth, Func<IntPtr, WindowRecord> observe)
    {
        WindowRecord admitted;
        lock (sync) {
            if (token == null || !tokens.TryGetValue(token, out admitted) || admitted.Handle != hwnd || admitted.ProcessStart != birth)
                throw new DriverFault("IDENTITY_CHANGED");
        }
        // Do not hold the registry lock while fencing the event thread.
        try { return DriverIdentity.Verify(admitted, observe(hwnd)); }
        catch { Revoke(hwnd); throw; }
    }
    internal void Clear() { lock (sync) { windows.Clear(); tokens.Clear(); } }
}

// Read-only incarnation evidence. Same-thread HWND reuse between samples still
// needs the root-scoped lifecycle events; no window property is ever written.
internal sealed class DriverWindowLife
{
    internal uint Pid, Thread;
    internal long ProcessBirth, ThreadBirth;
    internal ushort ClassAtom;
    internal IntPtr Parent, Owner;
    internal string Proof()
    {
        if (Pid == 0 || Thread == 0 || ProcessBirth <= 0 || ThreadBirth <= 0 || ClassAtom == 0)
            throw new DriverFault("TARGET_UNAVAILABLE");
        return Pid + ":" + Thread + ":" + ProcessBirth + ":" + ThreadBirth + ":" + ClassAtom + ":" +
            WindowRecord.Id(Parent) + ":" + WindowRecord.Id(Owner);
    }
}
// Diagnostic metadata only. It neither revokes bindings nor supplies identity proof.
internal sealed class DriverLifecycleRing
{
    internal readonly string Incarnation;
    internal DriverLifecycleRing(string incarnation = null) { Incarnation = incarnation; }
    readonly object sync = new object();
    readonly Dictionary<string, object>[] entries = new Dictionary<string, object>[64];
    int next, count;
    long total;
    bool overflow;
    internal IntPtr Focus;
    internal HashSet<IntPtr> Path = new HashSet<IntPtr>();
    internal static bool Enabled { get { return Environment.GetEnvironmentVariable("SLEIGHT_DRIVER_COUNTERS") == "1"; } }
    internal void Record(Dictionary<string, object> value)
    {
        lock (sync) {
            entries[next] = value;
            next = (next + 1) % 64;
            if (count < 64) count++; else overflow = true;
            total++;
        }
    }
    internal static string Relation(IntPtr root, IntPtr focus, IntPtr hwnd, bool ancestor, bool retained)
    {
        if (hwnd == focus && focus != IntPtr.Zero) return "equals-focus";
        if (hwnd == root) return "equals-root";
        if (ancestor) return "ancestor-of-focus";
        return retained ? "other-member" : "descendant-not-retained";
    }
    internal void RememberFocus(IntPtr focus, HashSet<IntPtr> path)
    {
        lock (sync) { Focus = focus; Path = new HashSet<IntPtr>(path); }
    }
    internal void Advance(IntPtr root, long epoch, uint kind, IntPtr hwnd, int objectId, int childId,
        uint pid, uint thread, string className, bool retained)
    {
        lock (sync) Record(Json.Map("epoch", epoch, "kind", kind, "hwnd", WindowRecord.Id(hwnd),
            "objectId", objectId, "childId", childId, "pid", pid, "thread", thread, "className", className,
            "rootRelation", hwnd == root ? "equals-root" : retained ? "retained-member" : "descendant-not-retained",
            "focusRelation", Relation(root, Focus, hwnd, Path.Contains(hwnd), retained),
            "focusHwnd", WindowRecord.Id(Focus), "focusPathKnown", Focus != IntPtr.Zero));
    }
    internal object Snapshot(IntPtr root)
    {
        lock (sync) {
            var rows = new object[count];
            for (int i = 0; i < count; i++) rows[i] = entries[(next - count + i + 64) % 64];
            return Json.Map("rootHwnd", WindowRecord.Id(root), "focusHwnd", WindowRecord.Id(Focus),
                "focusPath", Path.Select(WindowRecord.Id).OrderBy(id => id, StringComparer.Ordinal).ToArray(),
                "capacity", 64, "total", total, "overflow", overflow, "events", rows);
        }
    }
}
internal sealed class DriverTopologyEpoch
{
    sealed class Root { internal uint Pid; internal long Value; internal HashSet<IntPtr> Members; internal bool Unavailable; }
    readonly object sync = new object();
    readonly Dictionary<IntPtr, Root> roots = new Dictionary<IntPtr, Root>();
    long next;
    internal int Count { get { lock (sync) return roots.Count; } }
    internal bool Track(IntPtr root, uint pid, HashSet<IntPtr> members)
    {
        lock (sync) {
            Root known;
            if (roots.TryGetValue(root, out known)) {
                if (known.Unavailable) throw new DriverFault("TARGET_UNAVAILABLE");
                if (known.Pid != pid) throw new DriverFault("IDENTITY_CHANGED");
                // Retain detached/destroyed members until their event is fenced.
                known.Members.UnionWith(members);
                if (known.Members.Count > 4096) {
                    known.Unavailable = true; known.Members = new HashSet<IntPtr>();
                    throw new DriverFault("TARGET_UNAVAILABLE");
                }
                return false;
            }
            if (roots.Count >= 4096 || members.Count > 4096) throw new DriverFault("TARGET_UNAVAILABLE");
            roots.Add(root, new Root { Pid = pid, Value = ++next, Members = new HashSet<IntPtr>(members) });
            return true;
        }
    }
    internal long Sample(IntPtr root)
    {
        lock (sync) {
            Root known;
            if (!roots.TryGetValue(root, out known)) throw new DriverFault("IDENTITY_CHANGED");
            if (known.Unavailable) throw new DriverFault("TARGET_UNAVAILABLE");
            return known.Value;
        }
    }
    internal void Prune(Func<IntPtr, bool> exists)
    {
        lock (sync) foreach (var root in roots.Keys.ToArray()) if (!exists(root)) roots.Remove(root);
    }
    internal void Clear() { lock (sync) roots.Clear(); }
    internal void Record(uint kind, IntPtr hwnd, int objectId, int childId, uint pid, Func<IntPtr, IntPtr, bool> descendant, Action<IntPtr> revoke,
        Action<IntPtr, long, bool> advance = null)
    {
        if (hwnd == IntPtr.Zero || childId != 0 || objectId != 0 && objectId != -4 ||
            !(kind == 0x8000 || kind == 0x8001 || kind == 0x8004 || kind == 0x800f)) return;
        lock (sync) foreach (var pair in roots.ToArray()) {
            var root = pair.Key; var known = pair.Value;
            if (known.Unavailable) {
                if (kind == 0x8001 && hwnd == root) roots.Remove(root);
                continue;
            }
            bool retained = hwnd == root || known.Members.Contains(hwnd);
            if (!(retained || descendant(root, hwnd))) continue;
            known.Value = ++next;
            // Every relevant structural event retires old tokens, even if the
            // numeric HWND and the complete sampled tuple later match again.
            revoke(root);
            // Retire the token before recording can wait on diagnostic locks.
            try { if (advance != null) advance(root, known.Value, retained); } catch { }
            if (kind == 0x8001) {
                known.Members.Remove(hwnd);
                if (hwnd == root) roots.Remove(root);
            } else if (hwnd != root) {
                if (!descendant(root, hwnd)) known.Members.Remove(hwnd);
                else known.Members.Add(hwnd);
                if (known.Members.Count > 4096) { known.Unavailable = true; known.Members = new HashSet<IntPtr>(); }
            }
        }
    }
}

// Native object events supply a monotonic topology epoch. A lost pump refuses;
// it cannot silently become a polling-only lifetime guarantee.
internal sealed class DriverTopology : IDisposable
{
    delegate void EventCallback(IntPtr hook, uint kind, IntPtr hwnd, int objectId, int childId, uint thread, uint time);
    [StructLayout(LayoutKind.Sequential)] struct Message {
        internal IntPtr Window; internal uint Kind; internal UIntPtr WParam; internal IntPtr LParam;
        internal uint Time; internal DriverPoint Point; internal uint Private;
    }
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint first, uint last, IntPtr module, EventCallback callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll", ExactSpelling = true)] static extern int GetMessageW(out Message message, IntPtr window, uint first, uint last);
    [DllImport("user32.dll", ExactSpelling = true)] static extern bool PeekMessageW(out Message message, IntPtr window, uint first, uint last, uint remove);
    [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)] static extern bool PostThreadMessageW(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hwnd, StringBuilder text, int length);
    const uint Fence = 0x8002;
    readonly ManualResetEvent ready = new ManualResetEvent(false), fenced = new ManualResetEvent(false);
    readonly EventCallback callback;
    readonly Thread pump;
    uint threadId;
    readonly DriverTopologyEpoch epoch = new DriverTopologyEpoch();
    readonly object diagnosticSync = new object();
    readonly Dictionary<IntPtr, DriverLifecycleRing> diagnostics = new Dictionary<IntPtr, DriverLifecycleRing>();
    volatile bool healthy;
    volatile bool stopping;
    internal DriverTopology()
    {
        callback = OnEvent;
        pump = new Thread(Run) { IsBackground = true };
        pump.Start();
        if (!ready.WaitOne(1000) || !healthy) { Dispose(); throw new DriverFault("TARGET_UNAVAILABLE", "window topology observer unavailable"); }
    }
    void OnEvent(IntPtr hook, uint kind, IntPtr hwnd, int objectId, int childId, uint thread, uint time)
    {
        // CREATE, DESTROY, REORDER, PARENTCHANGE. Ignore value/location events.
        try {
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            List<Tuple<IntPtr, long, bool>> pending = null;
            try { if (DriverLifecycleRing.Enabled) pending = new List<Tuple<IntPtr, long, bool>>(); } catch { }
            epoch.Record(kind, hwnd, objectId, childId, pid, IsChild, DriverInventory.Bindings.Revoke,
                pending == null ? null : (Action<IntPtr, long, bool>)((root, value, retained) => {
                    pending.Add(Tuple.Create(root, value, retained));
                }));
            // Record has released epoch.sync. Diagnostic contention cannot hold
            // that lock or delay token retirement and member maintenance.
            if (pending != null) foreach (var item in pending) {
                try {
                    lock (diagnosticSync) {
                        DriverLifecycleRing ring;
                        if (!diagnostics.TryGetValue(item.Item1, out ring)) continue;
                        var name = new StringBuilder(256);
                        string cls = GetClassNameW(hwnd, name, name.Capacity) == 0 ? null : name.ToString();
                        ring.Advance(item.Item1, item.Item2, kind, hwnd, objectId, childId, pid, thread, cls, item.Item3);
                    }
                } catch { }
            }
        } catch { healthy = false; }
    }
    void Run()
    {
        IntPtr hook = IntPtr.Zero;
        try {
            threadId = unchecked((uint)AppDomain.GetCurrentThreadId());
            Message message;
            PeekMessageW(out message, IntPtr.Zero, 0, 0, 0); // Establish this pump's queue.
            hook = SetWinEventHook(0x8000, 0x800f, IntPtr.Zero, callback, 0, 0, 0); // WINEVENT_OUTOFCONTEXT
            healthy = hook != IntPtr.Zero && !stopping; ready.Set();
            if (!healthy) return;
            while (GetMessageW(out message, IntPtr.Zero, 0, 0) > 0) {
                if (message.Kind == Fence) {
                    // Peek pumps pending nonqueued callbacks before receipting.
                    PeekMessageW(out message, IntPtr.Zero, 0, 0, 0);
                    fenced.Set();
                }
            }
        } catch { healthy = false; }
        finally {
            healthy = false;
            if (hook != IntPtr.Zero) UnhookWinEvent(hook);
            ready.Set(); fenced.Set(); GC.KeepAlive(callback);
        }
    }
    internal void Track(IntPtr root, uint pid, HashSet<IntPtr> members, DriverWindowLife life = null)
    {
        epoch.Prune(IsWindow); bool fresh = epoch.Track(root, pid, members);
        // A fresh epoch or changed sampled lifetime starts an empty ring.
        // Same-thread, same-class reuse still needs its queued DESTROY event.
        // Diagnostic allocation or pruning failures cannot change admission.
        try {
            if (DriverLifecycleRing.Enabled) lock (diagnosticSync) {
                string incarnation = life == null ? null : life.Proof();
                if (fresh || !diagnostics.ContainsKey(root) || diagnostics[root].Incarnation != incarnation) {
                    diagnostics.Remove(root);
                    foreach (var old in diagnostics.Keys.ToArray()) if (!IsWindow(old)) diagnostics.Remove(old);
                    if (diagnostics.Count < 4096) diagnostics.Add(root, new DriverLifecycleRing(incarnation));
                }
            }
        } catch { }
    }
    internal void Focus(IntPtr root, IntPtr focus)
    {
        if (!DriverLifecycleRing.Enabled) return;
        DriverLifecycleRing ring;
        lock (diagnosticSync) if (!diagnostics.TryGetValue(root, out ring)) return;
        var path = new HashSet<IntPtr>();
        IntPtr current = focus;
        while (current != IntPtr.Zero && path.Count < 4096 && path.Add(current)) {
            if (current == root) break;
            current = GetParent(current);
        }
        // Unknown ancestry is reported as unknown, never used to admit input.
        if (current != root) { focus = IntPtr.Zero; path = new HashSet<IntPtr>(); }
        lock (diagnosticSync) {
            DriverLifecycleRing latest;
            if (diagnostics.TryGetValue(root, out latest) && Object.ReferenceEquals(ring, latest)) ring.RememberFocus(focus, path);
        }
    }
    internal object Lifecycle(IntPtr root)
    {
        if (!DriverLifecycleRing.Enabled) return null;
        lock (diagnosticSync) {
            DriverLifecycleRing ring;
            return diagnostics.TryGetValue(root, out ring) ? ring.Snapshot(root) : null;
        }
    }
    internal long Sample(IntPtr root)
    {
        if (!healthy) throw new DriverFault("TARGET_UNAVAILABLE", "window topology observer lost");
        fenced.Reset();
        if (!PostThreadMessageW(threadId, Fence, UIntPtr.Zero, IntPtr.Zero) || !fenced.WaitOne(200) || !healthy) {
            healthy = false;
            throw new DriverFault("TARGET_UNAVAILABLE", "window topology fence unavailable");
        }
        return epoch.Sample(root);
    }
    public void Dispose()
    {
        stopping = true; healthy = false;
        if (threadId != 0) PostThreadMessageW(threadId, 0x12, UIntPtr.Zero, IntPtr.Zero);
        if (pump.Join(1000)) { ready.Dispose(); fenced.Dispose(); }
        epoch.Clear();
    }
}
internal static class DriverInventory
{
    [ThreadStatic] static bool lifecycleFocused;
    internal static void BeginLifecycleRequest() { lifecycleFocused = false; }
    internal static void LifecycleFocus(WindowRecord window, IntPtr focus)
    {
        if (lifecycleFocused || !DriverLifecycleRing.Enabled || topology == null) return;
        try { topology.Focus(window.Handle, focus); lifecycleFocused = true; } catch { }
    }
    internal static object Lifecycle(IntPtr root)
    {
        try { return topology == null ? null : topology.Lifecycle(root); } catch { return null; }
    }
    internal static void RequireFramePolicy(WindowRecord window)
    {
        if (String.Equals(window.ClassName, "ApplicationFrameWindow", StringComparison.OrdinalIgnoreCase) && (!PackagedFramesOpen() || window.CoreHandle == IntPtr.Zero))
            throw new DriverFault("HOSTED_APP_UNRESOLVED");
        if (String.Equals(window.ClassName, "Windows.UI.Core.CoreWindow", StringComparison.OrdinalIgnoreCase))
            throw new DriverFault("HOSTED_APP_UNRESOLVED");
    }
    internal static readonly DriverBindings Bindings = new DriverBindings();
    static DriverTopology topology;
    static bool topologyAttempted;
    delegate bool EnumCallback(IntPtr hwnd, IntPtr state);
    [StructLayout(LayoutKind.Sequential)] struct Bounds { internal int Left, Top, Right, Bottom; }
    [ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IVirtualDesktopManager
    {
        [return: MarshalAs(UnmanagedType.Bool)] bool IsWindowOnCurrentVirtualDesktop(IntPtr hwnd);
        Guid GetWindowDesktopId(IntPtr hwnd);
        void Slot02();
    }
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumCallback callback, IntPtr state);
    [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Bounds bounds);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll", EntryPoint = "GetClassLongPtrW")] static extern UIntPtr GetClassLongPtrW(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "GetClassLongW")] static extern uint GetClassLongW(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern IntPtr GetWindowLongPtrW(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int length);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hwnd, StringBuilder text, int length);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern IntPtr OpenThread(uint access, bool inherit, uint thread);
    [DllImport("kernel32.dll")] static extern bool GetThreadTimes(IntPtr thread, out long birth, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long birth, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref uint length);
    [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetApplicationUserModelId(IntPtr process, ref uint length, StringBuilder id);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, uint length, out uint needed);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    internal static IntPtr Hwnd(string value)
    {
        ulong number;
        if (value == null || !System.Text.RegularExpressions.Regex.IsMatch(value, "\\A[1-9][0-9]{0,19}\\z") ||
            !UInt64.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out number) ||
            IntPtr.Size == 4 && number > UInt32.MaxValue) throw new DriverFault("INVALID_PARAMS");
        return new IntPtr(unchecked((long)number));
    }
    static DriverFault TokenFault(bool target)
    {
        return new DriverFault(target && Marshal.GetLastWin32Error() == 5 ? "ELEVATED_TARGET" : "TARGET_UNAVAILABLE");
    }
    static uint IntegrityOf(IntPtr process, bool target)
    {
        IntPtr token;
        if (!OpenProcessToken(process, 8, out token)) throw TokenFault(target);
        try {
            uint length;
            if (!GetTokenInformation(token, 25, IntPtr.Zero, 0, out length) && Marshal.GetLastWin32Error() == 5) throw TokenFault(target);
            if (length < IntPtr.Size || length > 65536) throw new DriverFault("TARGET_UNAVAILABLE");
            IntPtr data = Marshal.AllocHGlobal((int)length);
            try {
                if (!GetTokenInformation(token, 25, data, length, out length)) throw TokenFault(target);
                IntPtr sid = Marshal.ReadIntPtr(data);
                byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                if (count == 0) throw new DriverFault("TARGET_UNAVAILABLE");
                uint rid = unchecked((uint)Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1))));
                return rid;
            } finally { Marshal.FreeHGlobal(data); }
        } finally { CloseHandle(token); }
    }
    static uint OwnIntegrity()
    {
        IntPtr process = OpenProcess(0x1000, false, GetCurrentProcessId());
        if (process == IntPtr.Zero) throw new DriverFault("TARGET_UNAVAILABLE");
        try { return IntegrityOf(process, false); }
        finally { CloseHandle(process); }
    }
    static readonly Lazy<uint> CachedOwnIntegrity = new Lazy<uint>(OwnIntegrity);
    // Only the basename is returned. A protected or disappearing foreground is unknown.
    internal static string ExecutableName(IntPtr hwnd)
    {
        uint pid;
        if (hwnd == IntPtr.Zero || GetWindowThreadProcessId(hwnd, out pid) == 0) return null;
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return null;
        try {
            var image = new StringBuilder(32768); uint size = (uint)image.Capacity;
            return QueryFullProcessImageNameW(process, 0, image, ref size) ? Path.GetFileName(image.ToString()) : null;
        } finally { CloseHandle(process); }
    }
    [ThreadStatic] static IVirtualDesktopManager desktop;
    [ThreadStatic] static bool desktopAttempted;
    static IVirtualDesktopManager Desktop()
    {
        if (!desktopAttempted) {
            desktopAttempted = true;
            try { desktop = (IVirtualDesktopManager)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a"), true)); } catch { }
        }
        return desktop;
    }
    internal static void CloseDesktop()
    {
        try { if (desktop != null) Marshal.ReleaseComObject(desktop); }
        finally {
            desktop = null; desktopAttempted = false;
            try { if (topology != null) topology.Dispose(); }
            finally {
                topology = null; topologyAttempted = false;
                Bindings.Clear();
            }
        }
    }
    // UC3H must qualify the complete packaged route before enabling it.
    // The shipped constant stays false. PackagedFrameTestGate.Admit is a
    // same-assembly test seam: production commands never assign it, and no
    // environment variable, protocol field, page or model tool can set it.
    static readonly bool EnablePackagedFrames = false;
    internal static class PackagedFrameTestGate { internal static bool Admit; }
    internal static bool PackagedFramesOpen() { return EnablePackagedFrames || PackagedFrameTestGate.Admit; }
    // These seams are also used by the headless native resolver fixture. AUMID
    // is lookup metadata only and cannot change the switch's admission verdict.
    internal static bool RefusePackaged(WindowRecord row, Func<uint, bool> hostedProcess)
    {
        if (PackagedFramesOpen()) return false;
        if (!String.Equals(row.ClassName, "ApplicationFrameWindow", StringComparison.OrdinalIgnoreCase) &&
            !String.Equals(row.ClassName, "Windows.UI.Core.CoreWindow", StringComparison.OrdinalIgnoreCase) &&
            !hostedProcess(row.Pid)) return false;
        row.Refused = "HOSTED_APP_UNRESOLVED";
        row.RefusalStep = "frame";
        return true;
    }
    internal static string[] HostedSelectors(WindowRecord row)
    {
        return new[] { row.App, row.Image, Path.GetFileName(row.Image), row.Aumid, row.Title, row.Pid.ToString(CultureInfo.InvariantCulture) }
            .Where(s => !String.IsNullOrEmpty(s)).ToArray();
    }
    internal static string[] HostedSelectorHashes(WindowRecord row)
    {
        using (var hash = System.Security.Cryptography.SHA256.Create())
            return HostedSelectors(row).Select(s => BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(s.ToLowerInvariant()))).Replace("-", "").ToLowerInvariant()).ToArray();
    }
    internal sealed class PackagedApi
    {
        internal Func<Func<IntPtr, bool>, bool> Windows;
        internal Action<IntPtr, Func<IntPtr, bool>> Children;
        internal Func<IntPtr, uint> Pid;
        internal Func<IntPtr, string> ClassName, Executable;
        internal Func<IntPtr, bool> Exists;
        internal Func<uint, int> PackageStatus;
    }
    internal sealed class PackagedProcesses
    {
        internal readonly HashSet<uint> Pids = new HashSet<uint>();
        internal readonly HashSet<uint> PackageUnproved = new HashSet<uint>();
        internal bool Incomplete;
        internal string FailureStep;
        internal void Fail(string step) { Incomplete = true; if (FailureStep == null) FailureStep = step; }
    }
    [ThreadStatic] static Lazy<PackagedProcesses> packagedSnapshot;
    // A snapshot lasts for one inventory or observation call, including nested
    // metadata reads. Later action checkpoints build a fresh classification.
    static T WithPackagedSnapshot<T>(Func<T> read)
    {
        return WithPackagedSnapshot(read, () => ScanPackagedWindows(NativePackagedApi()));
    }
    internal static T WithPackagedSnapshot<T>(Func<T> read, Func<PackagedProcesses> scan)
    {
        if (packagedSnapshot != null) return read();
        packagedSnapshot = new Lazy<PackagedProcesses>(scan);
        try { return read(); }
        finally { packagedSnapshot = null; }
    }
    static PackagedApi NativePackagedApi()
    {
        return new PackagedApi {
            Windows = visit => EnumWindows((hwnd, state) => visit(hwnd), IntPtr.Zero),
            Children = (root, visit) => { EnumChildWindows(root, (child, state) => visit(child), IntPtr.Zero); },
            Pid = hwnd => { uint pid; return GetWindowThreadProcessId(hwnd, out pid) == 0 ? 0 : pid; },
            ClassName = hwnd => {
                var name = new StringBuilder(256);
                return GetClassNameW(hwnd, name, name.Capacity) == 0 ? null : name.ToString();
            },
            Executable = ExecutableName, Exists = IsWindow, PackageStatus = ProcessPackageStatus
        };
    }
    static int ProcessPackageStatus(uint pid)
    {
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return -1;
        try {
            uint length = 0;
            return GetPackageFullName(process, ref length, null);
        } catch { return -1; }
        finally { CloseHandle(process); }
    }
    static bool HasPackagedWindow(uint target) { return HasPackagedWindow(target, NativePackagedApi()); }
    internal static bool HasPackagedWindow(uint target, PackagedApi api)
    {
        var result = packagedSnapshot == null ? ScanPackagedWindows(api) : packagedSnapshot.Value;
        return result.Incomplete || result.Pids.Contains(target);
    }
    internal static PackagedProcesses ScanPackagedWindows(PackagedApi api)
    {
        var result = new PackagedProcesses();
        int count = 0;
        if (!api.Windows(hwnd => {
            if (++count > 16384) { result.Fail("frame-limit"); return false; }
            if (!api.Exists(hwnd)) return true;
            uint pid = api.Pid(hwnd);
            string name = api.ClassName(hwnd);
            if (name == null || pid == 0) {
                if (api.Exists(hwnd)) result.Fail(name == null ? "frame-class" : "frame-pid");
                return true;
            }
            // Explorer also owns hidden cores. Only NO_PACKAGE proves that a
            // core's process is unpackaged; unknown package identity stays shut.
            if (String.Equals(name, "Windows.UI.Core.CoreWindow", StringComparison.OrdinalIgnoreCase)) {
                int package = api.PackageStatus(pid);
                if (package != 15700) result.Pids.Add(pid); // APPMODEL_ERROR_NO_PACKAGE
                if (package != 15700 && package != 122) result.PackageUnproved.Add(pid); // ERROR_INSUFFICIENT_BUFFER
            }
            if (String.Equals(name, "ApplicationFrameWindow", StringComparison.OrdinalIgnoreCase) ||
                String.Equals(api.Executable(hwnd), "ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase)) {
                result.Pids.Add(pid);
                api.Children(hwnd, child => {
                    if (++count > 16384) { result.Fail("frame-limit"); return false; }
                    if (!api.Exists(child)) return true;
                    uint childPid = api.Pid(child);
                    if (childPid == 0) { if (api.Exists(child)) result.Fail("frame-child"); }
                    else result.Pids.Add(childPid);
                    return true;
                });
            }
            return true;
        })) result.Fail("frame-scan");
        // Incomplete classification cannot admit a possibly hosted surface.
        return result;
    }
    static void PackagedLookupIdentity(WindowRecord row)
    {
        IntPtr process = OpenProcess(0x1000, false, row.Pid);
        if (process == IntPtr.Zero) return;
        try {
            long birth, exit, kernel, user;
            if (GetProcessTimes(process, out birth, out exit, out kernel, out user) && birth > 0)
                row.ProcessStart = birth.ToString(CultureInfo.InvariantCulture);
            var image = new StringBuilder(32768); uint size = (uint)image.Capacity;
            if (QueryFullProcessImageNameW(process, 0, image, ref size)) {
                row.Image = image.ToString(); row.App = Path.GetFileNameWithoutExtension(row.Image);
            }
            uint length = 0;
            if (GetApplicationUserModelId(process, ref length, null) == 122 && length > 0 && length < 32768) {
                var aumid = new StringBuilder((int)length);
                if (GetApplicationUserModelId(process, ref length, aumid) == 0) row.Aumid = aumid.ToString();
            }
        } catch { /* Lookup failure never changes the refusal. */ }
        finally { CloseHandle(process); }
    }
    internal static HashSet<IntPtr> NativeDescendants(IntPtr root, Func<IntPtr, IntPtr> firstChild,
        Func<IntPtr, IntPtr> nextSibling, Func<IntPtr, IntPtr> parentOf)
    {
        var result = new HashSet<IntPtr>(); var parents = new Stack<IntPtr>(); parents.Push(root);
        while (parents.Count != 0) {
            IntPtr parent = parents.Pop();
            for (IntPtr child = firstChild(parent); child != IntPtr.Zero; child = nextSibling(child)) {
                if (child == root || !result.Add(child) || result.Count > 4096 || parentOf(child) != parent)
                    throw new DriverFault("TARGET_UNAVAILABLE", "window topology is incomplete or changing");
                parents.Push(child);
            }
        }
        return result;
    }
    internal static void RequireCompleteTopology(HashSet<IntPtr> enumerated, HashSet<IntPtr> walked)
    {
        if (!enumerated.SetEquals(walked)) throw new DriverFault("TARGET_UNAVAILABLE", "window topology enumeration is incomplete");
    }
    static DriverWindowLife ReadLife(IntPtr hwnd)
    {
        uint pid; uint thread = GetWindowThreadProcessId(hwnd, out pid);
        if (thread == 0 || pid == 0) throw new DriverFault("IDENTITY_CHANGED");
        IntPtr process = OpenProcess(0x1000, false, pid), worker = OpenThread(0x800, false, thread);
        try {
            long birth, exit, kernel, user, threadBirth;
            if (process == IntPtr.Zero || worker == IntPtr.Zero ||
                !GetProcessTimes(process, out birth, out exit, out kernel, out user) ||
                !GetThreadTimes(worker, out threadBirth, out exit, out kernel, out user)) throw new DriverFault("TARGET_UNAVAILABLE");
            var life = new DriverWindowLife { Pid = pid, Thread = thread, ProcessBirth = birth, ThreadBirth = threadBirth,
                ClassAtom = (ushort)(IntPtr.Size == 8 ? GetClassLongPtrW(hwnd, -32).ToUInt64() : GetClassLongW(hwnd, -32)),
                Parent = GetParent(hwnd), Owner = GetWindow(hwnd, 4) };
            uint again;
            if (!IsWindow(hwnd) || GetWindowThreadProcessId(hwnd, out again) != thread || again != pid) throw new DriverFault("IDENTITY_CHANGED");
            life.Proof(); return life;
        } finally { if (worker != IntPtr.Zero) CloseHandle(worker); if (process != IntPtr.Zero) CloseHandle(process); }
    }
    internal static string[] Lifetime(IntPtr hwnd)
    {
        if (topology == null) {
            if (topologyAttempted) throw new DriverFault("TARGET_UNAVAILABLE", "window topology observer unavailable");
            topologyAttempted = true; topology = new DriverTopology();
        }
        var root = ReadLife(hwnd);
        var members = NativeDescendants(hwnd, parent => GetWindow(parent, 5), child => GetWindow(child, 2), GetParent);
        topology.Track(hwnd, root.Pid, members, root);
        return Lifetime(hwnd, ReadLife, handle => {
            var enumerated = new HashSet<IntPtr>(); bool failed = false;
            EnumChildWindows(handle, (child, state) => {
                if (!enumerated.Add(child) || enumerated.Count > 4096) { failed = true; return false; }
                return true;
            }, IntPtr.Zero);
            if (failed) throw new DriverFault("TARGET_UNAVAILABLE");
            RequireCompleteTopology(enumerated, NativeDescendants(handle, parent => GetWindow(parent, 5), child => GetWindow(child, 2), GetParent));
            return enumerated;
        }, () => topology.Sample(hwnd));
    }
    // This is the production lifetime proof with a read-only Win32 seam. It
    // cannot prove same-thread HWND reuse when no lifecycle event was observed.
    internal static string[] Lifetime(IntPtr hwnd, Func<IntPtr, DriverWindowLife> sample,
        Func<IntPtr, HashSet<IntPtr>> descendants, Func<long> epoch)
    {
        long before = epoch();
        string root = sample(hwnd).Proof();
        var parts = new List<string>();
        var members = descendants(hwnd);
        if (members.Count > 4096) throw new DriverFault("TARGET_UNAVAILABLE");
        foreach (var child in members) parts.Add(WindowRecord.Id(child) + ":" + sample(child).Proof());
        IntPtr parent = sample(hwnd).Parent;
        var ancestors = new HashSet<IntPtr>(); ancestors.Add(hwnd);
        while (parent != IntPtr.Zero) {
            if (!ancestors.Add(parent) || ancestors.Count > 64) throw new DriverFault("TARGET_UNAVAILABLE");
            var life = sample(parent); parts.Add("parent:" + WindowRecord.Id(parent) + ":" + life.Proof()); parent = life.Parent;
        }
        if (sample(hwnd).Proof() != root || epoch() != before) throw new DriverFault("IDENTITY_CHANGED");
        parts.Sort(StringComparer.Ordinal);
        string fingerprint;
        using (var hash = SHA256.Create()) fingerprint = Convert.ToBase64String(hash.ComputeHash(Encoding.UTF8.GetBytes(String.Join(";", parts))));
        return new[] { root, before.ToString(CultureInfo.InvariantCulture) + ":" + fingerprint };
    }
    internal static WindowRecord Observe(IntPtr hwnd)
    {
        return WithPackagedSnapshot(() => {
            Bindings.Prune(IsWindow);
            return Observe(hwnd, IsWindow, handle => Observe(handle, true), Lifetime, ReadDesktop, Bindings);
        });
    }
    internal static WindowRecord Observe(IntPtr hwnd, Func<IntPtr, bool> exists, Func<IntPtr, WindowRecord> metadata,
        Func<IntPtr, string[]> lifetime, Action<WindowRecord> desktop, DriverBindings bindings)
    {
        if (!exists(hwnd)) { bindings.Revoke(hwnd); return null; }
        var candidate = metadata(hwnd);
        if (candidate == null || candidate.Refused != null) { bindings.Revoke(hwnd); return candidate; }
        try { return ObserveBound(hwnd, lifetime, metadata, desktop, bindings); }
        catch (DriverFault error) {
            // Keep failures visible in inventory, without leaking content or a
            // usable admission. Direct reads receive the same fixed refusal.
            bindings.Revoke(hwnd); candidate.Refused = error.Code; candidate.RefusalStep = error.Step; return candidate;
        }
    }
    internal static WindowRecord ObserveBound(IntPtr hwnd, Func<IntPtr, string[]> lifetime, Func<IntPtr, WindowRecord> observe,
        Action<WindowRecord> desktop, DriverBindings bindings)
    {
        try {
            var before = lifetime(hwnd);
            var row = observe(hwnd);
            if (row == null || row.Refused != null) { bindings.Revoke(hwnd); return row; }
            var after = lifetime(hwnd);
            if (!before.SequenceEqual(after)) throw new DriverFault("IDENTITY_CHANGED");
            bool? membership = row.OnCurrentDesktop; string desktopId = row.DesktopId;
            desktop(row);
            if (row.OnCurrentDesktop != membership || row.DesktopId != desktopId) throw new DriverFault("IDENTITY_CHANGED");
            if (!before.SequenceEqual(lifetime(hwnd))) throw new DriverFault("IDENTITY_CHANGED");
            row.WindowGeneration = before[0]; row.TopologyGeneration = before[1];
            return bindings.Remember(row);
        } catch { bindings.Revoke(hwnd); throw; }
    }
    static WindowRecord Observe(IntPtr hwnd, bool hosted)
    {
        uint pid;
        if (!IsWindow(hwnd)) return null;
        uint threadId = GetWindowThreadProcessId(hwnd, out pid);
        if (threadId == 0) return null;
        var title = new StringBuilder(4096); GetWindowTextW(hwnd, title, title.Capacity);
        var className = new StringBuilder(256); GetClassNameW(hwnd, className, className.Capacity);
        int cloaked;
        if (DwmGetWindowAttribute(hwnd, 14, out cloaked, sizeof(int)) != 0) cloaked = 0;
        long style = IntPtr.Size == 8 ? GetWindowLongPtrW(hwnd, -20).ToInt64() : GetWindowLongW(hwnd, -20);
        IntPtr owner = GetWindow(hwnd, 4); // GW_OWNER
        var row = new WindowRecord { Handle = hwnd, Owner = owner, Pid = pid, ThreadId = threadId, Title = title.ToString(), ClassName = className.ToString(),
            Cloaked = cloaked != 0, Minimized = IsIconic(hwnd), Popup = owner != IntPtr.Zero || className.ToString() == "#32768",
            Refused = "TARGET_UNAVAILABLE", RefusalStep = "process", Integrity = "unknown", App = "Unknown" };
        if (RefusePackaged(row, HasPackagedWindow)) {
            // A failed global scan is not evidence that this PID is a frame host.
            // Keep admission closed and report the first unreadable scan step.
            if (packagedSnapshot != null && packagedSnapshot.IsValueCreated && packagedSnapshot.Value.Incomplete)
                row.RefusalStep = packagedSnapshot.Value.FailureStep ?? "frame-scan";
            else if (packagedSnapshot != null && packagedSnapshot.IsValueCreated && packagedSnapshot.Value.PackageUnproved.Contains(pid))
                row.RefusalStep = "frame-package";
            PackagedLookupIdentity(row);
            return row;
        }
        // Apply this filter even when a protected process cannot be queried.
        if ((style & 0x80) != 0 && !row.Popup) return null;
        IntPtr process = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (process == IntPtr.Zero) return row;
        try {
            long birth, exit, kernel, user; uint session, current;
            var image = new StringBuilder(32768); uint size = (uint)image.Capacity;
            row.RefusalStep = "birth";
            if (!GetProcessTimes(process, out birth, out exit, out kernel, out user) || birth <= 0) return row;
            row.ProcessStart = birth.ToString(CultureInfo.InvariantCulture);
            row.RefusalStep = "image";
            if (!QueryFullProcessImageNameW(process, 0, image, ref size)) return row;
            row.Image = DriverIdentity.LongImagePath(image.ToString());
            row.RefusalStep = "session";
            if (!ProcessIdToSessionId(pid, out session) || !ProcessIdToSessionId(GetCurrentProcessId(), out current)) return row;
            if (session != current) { row.Refused = "OTHER_SESSION"; return row; }
            row.App = Path.GetFileNameWithoutExtension(row.Image);
            row.RefusalStep = "version";
            var version = FileVersionInfo.GetVersionInfo(row.Image);
            row.OriginalFilename = version.OriginalFilename; row.ProductName = version.ProductName;
            row.RefusalStep = "integrity";
            uint ownIntegrity = CachedOwnIntegrity.Value, integrity = IntegrityOf(process, true);
            row.Integrity = integrity >= 0x4000 ? "system" : integrity >= 0x3000 ? "high" : integrity >= 0x2000 ? "medium" : "low";
            // ApplicationFrameHost is a system process. When the test gate is open
            // the frame is not the target, so host elevation must not return before
            // the contained app is proved. Every other elevated process still refuses.
            if ((integrity > ownIntegrity || integrity >= 0x3000) && !FrameHostElevationContinues(row, integrity, ownIntegrity))
            { row.Refused = "ELEVATED_TARGET"; return row; }
            row.RefusalStep = "image";
            var executable = new FileInfo(row.Image);
            row.ImageIdentity = executable.CreationTimeUtc.ToFileTimeUtc().ToString(CultureInfo.InvariantCulture) + ":" + executable.Length.ToString(CultureInfo.InvariantCulture);
            uint length = 0;
            if (GetApplicationUserModelId(process, ref length, null) == 122 && length > 0 && length < 32768) {
                var aumid = new StringBuilder((int)length);
                if (GetApplicationUserModelId(process, ref length, aumid) == 0) row.Aumid = aumid.ToString();
            }
            row.Refused = row.Minimized && row.Aumid != null ? "MINIMIZED_PACKAGED_WINDOW" : null;
            DriverIdentity.ApplyPolicy(row);
            if (row.Refused == null) { row.RefusalStep = null; ReadDesktop(row); }
        } catch (DriverFault error) { row.Refused = error.Code; }
        catch { row.Refused = "TARGET_UNAVAILABLE"; }
        finally { CloseHandle(process); }
        if (hosted && String.Equals(row.ClassName, "ApplicationFrameWindow", StringComparison.OrdinalIgnoreCase)) return Hosted(row);
        return row;
    }
    static void ReadDesktop(WindowRecord row)
    {
        var manager = Desktop();
        ReadDesktop(row, manager == null ? null : new DesktopSight {
            Current = manager.IsWindowOnCurrentVirtualDesktop, Id = manager.GetWindowDesktopId,
            Owner = hwnd => GetWindow(hwnd, 4), Pid = PidOf, Exists = IsWindow
        });
    }
    internal sealed class DesktopSight
    {
        internal Func<IntPtr, bool> Current, Exists;
        internal Func<IntPtr, Guid> Id;
        internal Func<IntPtr, IntPtr> Owner;
        internal Func<IntPtr, uint> Pid;
    }
    internal static void ReadDesktop(WindowRecord row, DesktopSight sight)
    {
        row.OnCurrentDesktop = null; row.DesktopId = null;
        string step = "desktop";
        try {
            if (sight == null) throw new DriverFault("TARGET_UNAVAILABLE");
            row.OnCurrentDesktop = sight.Current(row.Handle);
            Guid id = sight.Id(row.Handle);
            if (id == Guid.Empty && row.OnCurrentDesktop == true && row.Popup && row.Owner != IntPtr.Zero) {
                step = "desktop-owner";
                var seen = new HashSet<IntPtr>(); seen.Add(row.Handle);
                IntPtr owner = row.Owner, child = row.Handle;
                for (int i = 0; owner != IntPtr.Zero && i < 64; i++) {
                    if (!seen.Add(owner) || sight.Owner(child) != owner || !sight.Exists(owner) ||
                        row.Pid == 0 || sight.Pid(owner) != row.Pid || !sight.Current(owner)) throw new DriverFault("TARGET_UNAVAILABLE");
                    id = sight.Id(owner);
                    if (id != Guid.Empty) break;
                    child = owner; owner = sight.Owner(owner);
                }
            }
            if (id == Guid.Empty) throw new DriverFault("TARGET_UNAVAILABLE");
            row.DesktopId = id.ToString("D");
        } catch { row.OnCurrentDesktop = null; row.DesktopId = null; row.RefusalStep = step; }
    }
    internal sealed class HostedSight
    {
        internal string SystemDirectory;
        internal Func<IntPtr, IList<IntPtr>> Cores;
        internal Func<IntPtr, WindowRecord> Observe;
        internal Func<IntPtr, IntPtr, bool> Contained;
        internal Action<WindowRecord> Policy;
    }
    // Host elevation is not the app. A system frame continues into the core proof.
    internal static bool FrameHostElevationContinues(WindowRecord row, uint integrity, uint ownIntegrity)
    {
        if (row == null || !(integrity > ownIntegrity || integrity >= 0x3000)) return false;
        return PackagedFramesOpen() && String.Equals(row.ClassName, "ApplicationFrameWindow", StringComparison.OrdinalIgnoreCase);
    }
    // The system ApplicationFrameHost image is the only frame host. A different
    // name, directory, core count or a changed sample stays a refused frame.
    internal static bool SystemFrameHost(string image, string systemDirectory)
    {
        if (String.IsNullOrEmpty(image) || String.IsNullOrEmpty(systemDirectory)) return false;
        string expected = Path.Combine(systemDirectory, "ApplicationFrameHost.exe");
        return String.Equals(image, expected, StringComparison.OrdinalIgnoreCase);
    }
    internal static WindowRecord ResolveHosted(WindowRecord frame, HostedSight sight)
    {
        frame.Refused = "HOSTED_APP_UNRESOLVED";
        frame.CoreHandle = IntPtr.Zero;
        if (!PackagedFramesOpen() || sight == null || !SystemFrameHost(frame.Image, sight.SystemDirectory) || String.IsNullOrEmpty(frame.ProcessStart))
            return frame;
        IList<IntPtr> cores;
        try { cores = sight.Cores(frame.Handle); }
        catch (DriverFault) { return frame; }
        if (cores == null || cores.Count != 1) return frame;
        IntPtr core = cores[0];
        if (core == IntPtr.Zero || core == frame.Handle || !sight.Contained(frame.Handle, core)) return frame;
        var app = sight.Observe(core);
        if (!CoreProved(frame, app)) return frame;
        var again = sight.Observe(core); var frameAgain = sight.Observe(frame.Handle);
        if (again == null || frameAgain == null || !app.SameIdentity(again) || !frame.SameIdentity(frameAgain) || !sight.Contained(frame.Handle, core)) return frame;
        IList<IntPtr> recount;
        try { recount = sight.Cores(frame.Handle); }
        catch (DriverFault) { return frame; }
        if (recount == null || recount.Count != 1 || recount[0] != core) return frame;
        var admitted = app.Copy();
        admitted.CoreHandle = core; admitted.FramePid = frame.Pid; admitted.FrameStart = frame.ProcessStart; admitted.FrameThreadId = frame.ThreadId;
        admitted.Handle = frame.Handle; admitted.Owner = frame.Owner; admitted.Title = frame.Title; admitted.ClassName = frame.ClassName;
        admitted.Cloaked = app.Cloaked; admitted.Minimized = frame.Minimized; admitted.Popup = false; admitted.OnCurrentDesktop = frame.OnCurrentDesktop;
        admitted.DesktopId = frame.DesktopId; admitted.Refused = null;
        if (sight.Policy != null) sight.Policy(admitted);
        if (admitted.Refused != null || admitted.CoreHandle == IntPtr.Zero || !String.Equals(Path.GetFileName(admitted.Image), Path.GetFileName(app.Image), StringComparison.OrdinalIgnoreCase))
            return frame;
        return admitted;
    }
    static bool CoreProved(WindowRecord frame, WindowRecord app)
    {
        if (app == null || app.Pid == 0 || app.Pid == frame.Pid || String.IsNullOrEmpty(app.Aumid) || String.IsNullOrEmpty(app.ProcessStart) ||
            String.IsNullOrEmpty(app.Image) || String.Equals(Path.GetFileName(app.Image), "ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(app.ClassName, "ApplicationFrameWindow", StringComparison.OrdinalIgnoreCase)) return false;
        if (!String.Equals(app.ClassName, "Windows.UI.Core.CoreWindow", StringComparison.OrdinalIgnoreCase)) return false;
        // The bare core is an unresolved public row. That class refusal is expected
        // on the sample and is not a failed app identity.
        return app.Refused == null || app.Refused == "HOSTED_APP_UNRESOLVED";
    }
    static IList<IntPtr> CoresOf(IntPtr frame)
    {
        var cores = new List<IntPtr>(); int count = 0; bool overflow = false;
        EnumChildWindows(frame, (child, state) => {
            if (++count > 4096) { overflow = true; return false; }
            var name = new StringBuilder(256); GetClassNameW(child, name, name.Capacity);
            if (String.Equals(name.ToString(), "Windows.UI.Core.CoreWindow", StringComparison.OrdinalIgnoreCase) && IsChild(frame, child)) cores.Add(child);
            return true;
        }, IntPtr.Zero);
        if (overflow) throw new DriverFault("TARGET_UNAVAILABLE");
        return cores;
    }
    internal static IntPtr RootWindow(IntPtr hwnd)
    {
        IntPtr root = hwnd;
        for (int i = 0; hwnd != IntPtr.Zero && i < 64; i++) {
            IntPtr parent = GetParent(hwnd);
            if (parent == IntPtr.Zero) return hwnd;
            hwnd = parent; root = hwnd;
        }
        return root;
    }
    internal static int DiagnosticCoreCount(IntPtr hwnd)
    {
        try { var cores = CoresOf(hwnd); return cores == null ? -2 : cores.Count; }
        catch { return -1; }
    }
    internal static string[] DiagnosticChildClasses(IntPtr hwnd)
    {
        var names = new List<string>();
        try {
            EnumChildWindows(hwnd, (child, state) => {
                if (names.Count >= 6) return false;
                var name = new StringBuilder(256); GetClassNameW(child, name, name.Capacity);
                names.Add(name.ToString());
                return true;
            }, IntPtr.Zero);
        } catch { names.Add("error"); }
        return names.ToArray();
    }
    internal static string ClassOf(IntPtr handle)
    {
        var name = new StringBuilder(256);
        return GetClassNameW(handle, name, name.Capacity) == 0 ? null : name.ToString();
    }
    internal static uint PidOf(IntPtr handle)
    {
        uint pid;
        return GetWindowThreadProcessId(handle, out pid) == 0 ? 0 : pid;
    }
    internal static uint? LiveHostedAppPid(IntPtr hwnd)
    {
        return LiveHostedAppPid(hwnd, RootWindow, ClassOf, CoresOf, PidOf);
    }
    // null: the root is not an ApplicationFrameWindow. 0: the frame's app is unproved.
    // Otherwise the single contained CoreWindow's pid.
    internal static uint? LiveHostedAppPid(IntPtr hwnd, Func<IntPtr, IntPtr> root, Func<IntPtr, string> className, Func<IntPtr, IList<IntPtr>> cores, Func<IntPtr, uint> pidOf)
    {
        if (hwnd == IntPtr.Zero || root == null || className == null || cores == null || pidOf == null) return 0;
        try {
            IntPtr frame = root(hwnd);
            string name = className(frame);
            if (name == null) return 0;
            if (!String.Equals(name, "ApplicationFrameWindow", StringComparison.OrdinalIgnoreCase)) return null;
            IList<IntPtr> found = cores(frame);
            if (found == null || found.Count != 1) return 0;
            uint pid = pidOf(found[0]);
            if (pid == 0) return 0;
            return pid;
        } catch { return 0; }
    }
    // Resolve one frame through its actual CoreWindow. Title and the shared
    // frame-host PID never identify the app. Every Observe repeats this proof.
    static WindowRecord Hosted(WindowRecord frame)
    {
        return ResolveHosted(frame, new HostedSight {
            SystemDirectory = Environment.SystemDirectory,
            Cores = CoresOf,
            Observe = hwnd => Observe(hwnd, false),
            Contained = IsChild,
            Policy = DriverIdentity.ApplyPolicy
        });
    }
    internal static List<WindowRecord> Windows()
    {
        return WithPackagedSnapshot(() => WindowsSnapshot());
    }
    static List<WindowRecord> WindowsSnapshot()
    {
        var result = new List<WindowRecord>();
        if (!EnumWindows((hwnd, state) => {
            try {
                Bounds bounds;
                if (!IsWindowVisible(hwnd) || !GetWindowRect(hwnd, out bounds) || bounds.Right <= bounds.Left || bounds.Bottom <= bounds.Top) return true;
                var row = Observe(hwnd);
                if (row != null) result.Add(row);
            } catch { } // A disappearing window cannot unwind through a native callback.
            return true;
        }, IntPtr.Zero)) throw new DriverFault("TARGET_UNAVAILABLE");
        // Some Windows builds enumerate an app's cloaked CoreWindow separately.
        // The frame is the only public surface after a successful hosted proof.
        var cores = new HashSet<IntPtr>(result.Where(w => w.CoreHandle != IntPtr.Zero).Select(w => w.CoreHandle));
        return result.Where(w => !cores.Contains(w.Handle)).ToList();
    }
    internal static WindowRecord Window(string id, IList<WindowRecord> windows)
    {
        IntPtr handle = Hwnd(id);
        var window = windows.FirstOrDefault(w => w.Handle == handle);
        if (window == null) throw new DriverFault("WINDOW_NOT_FOUND");
        return window;
    }
    internal static WindowRecord Resolve(object selector, IList<WindowRecord> windows)
    {
        var id = selector as Dictionary<string, object>;
        if (id != null) {
            Json.Keys(id, "windowId");
            var chosen = Window(Json.Text(id["windowId"]), windows);
            // A packaged root has no separate popup admission. Ordinary popups,
            // whose process has no proved core, keep the explicit HWND route.
            if (chosen.Popup && windows.Any(w => w.CoreHandle != IntPtr.Zero && w.Pid == chosen.Pid && w.ProcessStart == chosen.ProcessStart))
                throw new DriverFault("HOSTED_APP_UNRESOLVED");
            return chosen;
        }
        string name = Json.Text(selector);
        if (String.IsNullOrWhiteSpace(name) || name.Length > 32768) throw new DriverFault("INVALID_PARAMS");
        if (windows.Any(w => w.Refused == "HOSTED_APP_UNRESOLVED" && HostedSelectors(w).Any(s => String.Equals(s, name, StringComparison.OrdinalIgnoreCase))))
            throw new DriverFault("HOSTED_APP_UNRESOLVED");
        var matches = windows.Where(w => w.Refused == null && !w.Popup && new[] { w.App, w.Image, w.Aumid, w.Title }.Any(s => String.Equals(s, name, StringComparison.OrdinalIgnoreCase))).ToList();
        if (matches.Count == 0) {
            if (windows.Any(w => w.Refused == "ELEVATED_TARGET" && new[] { w.App, w.Image, w.Aumid }.Any(s => String.Equals(s, name, StringComparison.OrdinalIgnoreCase))))
                throw new DriverFault("ELEVATED_TARGET");
            throw new DriverFault("WINDOW_NOT_FOUND");
        }
        if (matches.Count != 1) throw new DriverFault("AMBIGUOUS_APP");
        return matches[0];
    }
    internal static bool PopupFor(WindowRecord popup, WindowRecord window)
    {
        return PopupFor(popup, window, owner => GetWindow(owner, 4));
    }
    internal static bool PopupFor(WindowRecord popup, WindowRecord window, Func<IntPtr, IntPtr> nextOwner)
    {
        if (window.CoreHandle != IntPtr.Zero) return false;
        if (!popup.Popup || popup.Handle == window.Handle || popup.Pid != window.Pid || popup.ProcessStart != window.ProcessStart) return false;
        IntPtr owner = popup.Owner;
        for (int i = 0; owner != IntPtr.Zero && i < 64; i++, owner = nextOwner(owner)) if (owner == window.Handle) return true;
        return false;
    }
    internal static object State(IList<WindowRecord> windows)
    {
        var apps = windows.GroupBy(w => w.Pid.ToString() + ":" + w.ProcessStart).Select(g => {
            var first = g.First();
            return Json.Map("id", first.Refused == null ? first.Aumid ?? first.Image : null, "name", first.Refused == null ? first.App : null, "pid", first.Pid,
                "processStart", first.ProcessStart, "windows", g.Select(w => w.JsonValue()).ToArray());
        }).ToArray();
        return Json.Map("apps", apps, "windows", windows.Select(w => w.JsonValue()).ToArray());
    }
}
}
