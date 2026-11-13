using System;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Threading;

namespace Sleight.Driver
{
// Each admitted job retains this object. Ending it cannot affect a later turn.
internal sealed class DriverTurn
{
    internal long Id;
    internal int Active = 1, Escape;
    internal readonly DriverHookSamples Samples = new DriverHookSamples();
    internal readonly DriverHookSamples OwnSamples = new DriverHookSamples();
    internal DriverCheckpointTimings Timings;
    internal bool Escaped { get { return Volatile.Read(ref Escape) != 0; } }
}
// Single pump writer, single reader. Keep the first 8192 durations, never keys.
// The maximum covers even omitted samples. Sorting and JSON stay on the reader.
internal sealed class DriverHookSamples
{
    internal const int Capacity = 8192;
    readonly long[] ticks = new long[Capacity], drained = new long[Capacity];
    int published, read, callbacks;
    long maximum;
    internal int Count { get { return Volatile.Read(ref published); } }
    internal void Record(long duration)
    {
        if (duration > maximum) Volatile.Write(ref maximum, duration);
        if (callbacks < Int32.MaxValue) Volatile.Write(ref callbacks, callbacks + 1);
        int index = published;
        if (index < Capacity) {
            ticks[index] = duration;
            Volatile.Write(ref published, index + 1);
        }
    }
    internal void Drain()
    {
        int count = Volatile.Read(ref published);
        while (read < count) { drained[read] = ticks[read]; read++; }
    }
    internal object JsonValue(string scope = "through-next-hook")
    {
        Drain();
        var sorted = new long[read]; Array.Copy(drained, sorted, read); Array.Sort(sorted);
        double us = 1000000.0 / Stopwatch.Frequency;
        var samples = new double[read];
        for (int i = 0; i < read; i++) samples[i] = drained[i] * us;
        int total = Volatile.Read(ref callbacks);
        return Json.Map("scope", scope, "callbacks", total, "sampled", read,
            "omitted", total - read, "capacity", Capacity, "samplesUs", samples, "saturated", total == Int32.MaxValue,
            "p50Us", read == 0 ? (object)null : sorted[(int)Math.Ceiling(read * 0.50) - 1] * us,
            "p99Us", read == 0 ? (object)null : sorted[(int)Math.Ceiling(read * 0.99) - 1] * us,
            "maxUs", total == 0 ? (object)null : Volatile.Read(ref maximum) * us);
    }
    internal bool FirstSince(int start, out double elapsedUs)
    {
        elapsedUs = 0;
        if (start >= Count) return false;
        elapsedUs = ticks[start] * (1000000.0 / Stopwatch.Frequency);
        return true;
    }
}
// One keyboard-only pump per driver. The callback never samples UIA or focus.
internal sealed class DriverHook : IDisposable
{
    delegate IntPtr Hook(int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr SetWindowsHookEx(int kind, Hook callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll", ExactSpelling = true)] static extern int GetMessageW(out Message message, IntPtr window, uint first, uint last);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll", ExactSpelling = true)] static extern IntPtr DispatchMessageW(ref Message message);
    [DllImport("user32.dll", ExactSpelling = true, SetLastError = true)] static extern bool PostThreadMessageW(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] struct Message {
        internal IntPtr Window;
        internal uint Kind;
        internal UIntPtr WParam;
        internal IntPtr LParam;
        internal uint Time;
        internal DriverPoint Point;
        internal uint Private;
    }
    const uint Wake = 0x8001;
    internal const int IdleMs = 60000;
    readonly object gate = new object();
    readonly Stopwatch clock = Stopwatch.StartNew();
    readonly ManualResetEvent ready = new ManualResetEvent(false);
    readonly ManualResetEvent removed = new ManualResetEvent(false);
    readonly Hook callback;
    Thread pump;
    Timer timer;
    IntPtr hook;
    uint threadId;
    long lastRequest;
    DriverTurn turn;
    volatile DriverTurn armedTurn;
    long lastTurn;
    bool disposed, requested, failed, removalPending;
    string failureReason, removalFailure;
    int removalFailures;
    internal DriverHook() { callback = Keyboard; }
    internal DriverTurn CurrentTurn { get { lock (gate) { return turn; } } }
    internal void BeginTurn(long id)
    {
        bool retry;
        lock (gate) {
            if (disposed || turn != null && turn.Id != id || id < lastTurn) throw new DriverFault("INVALID_PARAMS");
            if (removalFailures >= 3) throw Unavailable("hook-unhook-exhausted");
            if (failed) throw Unavailable(failureReason ?? "hook-pump-exited");
            retry = removalFailure != null && !removalPending && threadId != 0;
            if (retry) { removed.Reset(); removalPending = true; timer.Change(0, 25); }
        }
        if (retry) {
            WakePump();
            bool receipt = removed.WaitOne(200);
            lock (gate) { if (!receipt && removalPending) removalFailure = "hook-removal-timeout"; }
        }
        lock (gate) {
            if (removalFailures >= 3) throw Unavailable("hook-unhook-exhausted");
            if (removalPending || removalFailure != null) throw Unavailable(removalFailure ?? "hook-removal-pending");
            if (turn != null && turn.Id == id) return; // Replays never clear Escape.
            if (disposed || turn != null || id <= lastTurn) throw new DriverFault("INVALID_PARAMS");
            lastTurn = id; turn = new DriverTurn { Id = id };
        }
    }
    internal void EnableTimings(long id)
    {
        var timings = new DriverCheckpointTimings();
        lock (gate) {
            if (turn == null || turn.Id != id) throw new DriverFault("INVALID_PARAMS");
            if (turn.Timings == null) turn.Timings = timings;
        }
    }
    internal object EndTurn(long id)
    {
        DriverTurn ended;
        bool wait;
        lock (gate) {
            if (turn == null || turn.Id != id) throw new DriverFault("INVALID_PARAMS");
            ended = turn;
            Volatile.Write(ref turn.Active, 0);
            turn = null; requested = false;
            if (failed && threadId == 0) throw Unavailable(failureReason ?? "hook-pump-exited");
            wait = pump != null;
            if (wait) {
                removed.Reset(); removalPending = true;
                timer.Change(0, 25); // Post Wake until the installing pump receipts removal.
            }
        }
        // Never hold gate while waiting for the pump that needs it.
        if (wait) {
            WakePump(); // Reader posts immediately; the timer retries a missing queue.
            // Leave headroom under the reader's 300 ms cancel-frame budget.
            bool receipt = removed.WaitOne(200);
            lock (gate) {
                if (!receipt && removalPending) removalFailure = "hook-removal-timeout";
                if (removalFailures >= 3) throw Unavailable("hook-unhook-exhausted");
                if (removalFailure != null) throw Unavailable(removalFailure);
                if (hook != IntPtr.Zero) throw Unavailable("hook-unhook-failed");
            }
        }
        var result = Json.Map("turn", id, "active", false, "hookCallbacks", ended.Samples.JsonValue(),
            "hookOwnCallbacks", ended.OwnSamples.JsonValue("before-next-hook"));
        if (Environment.GetEnvironmentVariable("SLEIGHT_DRIVER_COUNTERS") == "1") result["escapeStops"] = DriverOperationCounters.EscapeStops(ended);
        return result;
    }
    internal static bool HardwareEscape(int code, long message, uint key, uint flags)
    {
        return code >= 0 && message == 0x100 && key == 0x1b && (flags & 0x12) == 0;
    }
    IntPtr Keyboard(int code, IntPtr message, IntPtr data)
    {
        long started = Stopwatch.GetTimestamp();
        var owner = armedTurn;
        try {
            if (owner != null && Volatile.Read(ref owner.Active) != 0 && code >= 0 && message.ToInt64() == 0x100 && HardwareEscape(code, message.ToInt64(),
                unchecked((uint)Marshal.ReadInt32(data, 0)), unchecked((uint)Marshal.ReadInt32(data, 8))))
                Volatile.Write(ref owner.Escape, 1);
        } catch { } // No managed exception may unwind through the native hook chain.
        long beforeNext = Stopwatch.GetTimestamp();
        IntPtr next = CallNextHookEx(IntPtr.Zero, code, message, data);
        try { if (owner != null) owner.Samples.Record(Stopwatch.GetTimestamp() - started); } catch { }
        try { if (owner != null) owner.OwnSamples.Record(beforeNext - started); } catch { }
        return next;
    }
    static void Prepare(Type type, string name, params Type[] parameters)
    {
        RuntimeHelpers.PrepareMethod(type.GetMethod(name, BindingFlags.Public | BindingFlags.NonPublic |
            BindingFlags.Static | BindingFlags.Instance, null, parameters, null).MethodHandle);
    }
    void PrepareCallback()
    {
        // Resolve managed methods and native/delegate stubs before installing.
        RuntimeHelpers.PrepareMethod(callback.Method.MethodHandle);
        RuntimeHelpers.PrepareDelegate(callback);
        Prepare(typeof(DriverHook), "HardwareEscape", typeof(int), typeof(long), typeof(uint), typeof(uint));
        Prepare(typeof(DriverHookSamples), "Record", typeof(long));
        Prepare(typeof(Stopwatch), "GetTimestamp");
        Prepare(typeof(IntPtr), "ToInt64");
        Prepare(typeof(Marshal), "ReadInt32", typeof(IntPtr), typeof(int));
        Prepare(typeof(Volatile), "Read", typeof(int).MakeByRefType());
        Prepare(typeof(Volatile), "Write", typeof(int).MakeByRefType(), typeof(int));
        Prepare(typeof(Volatile), "Write", typeof(long).MakeByRefType(), typeof(long));
        Prepare(typeof(DriverHook), "CallNextHookEx", typeof(IntPtr), typeof(int), typeof(IntPtr), typeof(IntPtr));
        Stopwatch.GetTimestamp(); // Initialize its frequency before the first key.
    }
    internal static DriverFault Unavailable(string reason, string code = "HOOK_UNAVAILABLE")
    {
        return new DriverFault(code, code + ": reason=" + reason + "; delivery=not-sent; retry=safe; typed=0.") {
            Disposition = Json.Map("delivery", "not-sent", "retry", "safe", "reason", reason, "typed", 0)
        };
    }
    internal void RequestSeen()
    {
        lock (gate) {
            lastRequest = clock.ElapsedMilliseconds;
            // EndTurn drains after the removal receipt; no sample copy holds gate.
            if (hook != IntPtr.Zero && !removalPending && !disposed) timer.Change(IdleMs, Timeout.Infinite);
        }
    }
    internal void Activate(DriverTurn owner)
    {
        lock (gate) {
            if (removalPending || removalFailure != null) throw Unavailable(removalFailure ?? "hook-removal-pending");
            if (owner == null || owner != turn || Volatile.Read(ref owner.Active) == 0) throw Unavailable("turn-inactive", "TURN_INACTIVE");
            if (owner.Escaped) throw DriverSession.Refusal("USER_STOPPED", "escape");
            if (disposed || failed) throw Unavailable(failureReason ?? "hook-disposed");
            lastRequest = clock.ElapsedMilliseconds; requested = true;
            if (hook != IntPtr.Zero) { timer.Change(IdleMs, Timeout.Infinite); return; }
            ready.Reset();
            if (pump == null) {
                pump = new Thread(Run) { IsBackground = true, Priority = ThreadPriority.AboveNormal };
                // Retry wakes until GetMessageW has created the thread's queue.
                timer = new Timer(state => WakePump(), null, Timeout.Infinite, Timeout.Infinite);
                pump.Start();
            }
            timer.Change(0, 25);
        }
        if (!ready.WaitOne(1000)) throw Unavailable("hook-activation-timeout");
        lock (gate) {
            if (removalPending || removalFailure != null) throw Unavailable(removalFailure ?? "hook-removal-pending");
            if (owner != turn || Volatile.Read(ref owner.Active) == 0) throw Unavailable("turn-inactive", "TURN_INACTIVE");
            if (failed || disposed || hook == IntPtr.Zero) throw Unavailable(failureReason ?? "hook-not-installed");
        }
    }
    void WakePump()
    {
        lock (gate) {
            if (threadId != 0) PostThreadMessageW(threadId, Wake, UIntPtr.Zero, IntPtr.Zero);
        }
    }
    bool Remove()
    {
        var owner = armedTurn;
        var timing = DriverCheckpointTimings.Start(owner == null || owner.Timings == null || hook == IntPtr.Zero ? null : owner.Timings.Lifecycle,
            DriverCheckpointTimings.Kind.HookRemove);
        try {
            armedTurn = null;
            IntPtr removing;
            lock (gate) { removing = hook; }
            // Native calls run outside gate so a delayed pump cannot block the reader.
            bool success = removing == IntPtr.Zero || UnhookWindowsHookEx(removing);
            // Keep B2D's same-pump retry before the removal receipt.
            if (!success) success = UnhookWindowsHookEx(removing);
            lock (gate) {
                if (!success) removalFailures++;
                if (!success) { removalFailure = "hook-unhook-failed"; return false; }
                hook = IntPtr.Zero; removalFailure = null; removalFailures = 0;
                return true;
            }
        } finally { timing.Finish(); }
    }
    void Run()
    {
        // Framework's physical OS thread id, never ManagedThreadId. This driver
        // runs on .NET Framework, not a host that moves managed threads to fibers.
        lock (gate) { threadId = unchecked((uint)AppDomain.GetCurrentThreadId()); }
        try {
            PrepareCallback();
            Message message; int status;
            while ((status = GetMessageW(out message, IntPtr.Zero, 0, 0)) > 0) {
                if (message.Kind == Wake) {
                    bool remove = false;
                    DriverTurn installOwner = null;
                    lock (gate) {
                        if (disposed) break;
                        if (removalPending) {
                            remove = true;
                        } else {
                            long idle = clock.ElapsedMilliseconds - lastRequest;
                            if (idle >= IdleMs) {
                                removalPending = true; remove = true; requested = false;
                                timer.Change(Timeout.Infinite, Timeout.Infinite);
                            } else if (requested && turn != null && Volatile.Read(ref turn.Active) != 0) {
                                if (hook == IntPtr.Zero) { armedTurn = turn; installOwner = turn; }
                                else { timer.Change((int)(IdleMs - idle), Timeout.Infinite); ready.Set(); }
                            }
                        }
                    }
                    if (remove) {
                        Remove();
                        lock (gate) {
                            removalPending = false;
                            timer.Change(Timeout.Infinite, Timeout.Infinite);
                            removed.Set(); // Receipt follows the native removal attempt.
                        }
                    } else if (installOwner != null) {
                        var timing = DriverCheckpointTimings.Start(installOwner.Timings == null ? null : installOwner.Timings.Lifecycle,
                            DriverCheckpointTimings.Kind.HookInstall);
                        IntPtr installed;
                        try { installed = SetWindowsHookEx(13, callback, GetModuleHandle(null), 0); }
                        finally { timing.Finish(); }
                        lock (gate) {
                            hook = installed;
                            if (hook == IntPtr.Zero) { failed = true; failureReason = "hook-install-failed"; }
                            if (!disposed && !removalPending && turn == installOwner)
                                timer.Change(IdleMs, Timeout.Infinite);
                            ready.Set();
                        }
                    }
                } else { TranslateMessage(ref message); DispatchMessageW(ref message); }
            }
        } catch { lock (gate) { failed = true; failureReason = "hook-pump-failed"; } }
        finally {
            Remove();
            lock (gate) {
                failed = !disposed;
                if (failed && failureReason == null) failureReason = "hook-pump-exited";
                threadId = 0; ready.Set(); removed.Set();
            }
            GC.KeepAlive(callback);
        }
    }
    public void Dispose()
    {
        lock (gate) {
            if (disposed) return;
            disposed = true;
            if (turn != null) Volatile.Write(ref turn.Active, 0);
            if (pump == null) { ready.Dispose(); removed.Dispose(); return; }
            timer.Change(0, 25);
        }
        bool stopped = pump.Join(1000);
        lock (gate) { timer.Dispose(); if (stopped) { ready.Dispose(); removed.Dispose(); } }
    }
}
}
