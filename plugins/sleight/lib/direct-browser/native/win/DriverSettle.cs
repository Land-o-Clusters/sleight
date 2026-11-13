using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace Sleight.Driver
{
// COM callbacks only mark a clock. No provider value is retained or printed here.
[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
internal sealed class DriverSettle : IUIAutomationStructureChangedEventHandler, IUIAutomationPropertyChangedEventHandler,
    IUIAutomationFocusChangedEventHandler, IDisposable
{
    readonly IUIAutomation automation;
    readonly IUIAutomationElement[] roots;
    readonly uint pid;
    readonly List<IUIAutomationElement> property = new List<IUIAutomationElement>(), structure = new List<IUIAutomationElement>();
    readonly Stopwatch clock = new Stopwatch();
    IUIAutomationCacheRequest focusCache;
    long last;
    int events;
    bool focus, subscribed;
    internal const int QuietMs = 120, CapMs = 1500, PollMs = 100;
    internal DriverSettle(IUIAutomation automation, IUIAutomationElement[] roots, uint pid)
    {
        this.automation = automation; this.roots = roots; this.pid = pid;
        try {
            var properties = new[] { 30005, 30086, 30022, 30001 };
            foreach (var root in roots) {
                automation.AddStructureChangedEventHandler(root, 7, null, this); structure.Add(root);
                automation.AddPropertyChangedEventHandlerNativeArray(root, 7, null, this, properties, properties.Length); property.Add(root);
            }
            focusCache = automation.CreateCacheRequest();
            focusCache.AddProperty(30002); focusCache.PutTreeScope(1); focusCache.PutElementMode(0);
            automation.AddFocusChangedEventHandler(focusCache, this); focus = true;
            subscribed = roots.Length > 0;
        } catch (COMException) { subscribed = false; }
    }
    internal void Begin() { Interlocked.Exchange(ref events, 0); Interlocked.Exchange(ref last, 0); clock.Restart(); }
    void Mark() { if (!clock.IsRunning) return; Interlocked.Exchange(ref last, clock.ElapsedMilliseconds); Interlocked.Increment(ref events); }
    public void HandleStructureChangedEvent(object sender, int changeType, int[] runtimeId) { Mark(); }
    public void HandlePropertyChangedEvent(object sender, int propertyId, object value) { Mark(); }
    public void HandleFocusChangedEvent(object sender)
    {
        try {
            var element = sender as IUIAutomationElement;
            if (element != null && Convert.ToInt64(element.GetCachedPropertyValueEx(30002, true)) == pid) Mark();
        } catch { } // Callbacks never unwind into a provider or record its error text.
    }
    internal static string Decision(long elapsed, long sinceEvent, int count, bool subscribed, bool stable)
    {
        if (elapsed >= CapMs) return "cap";
        if (subscribed && count > 0 && sinceEvent >= QuietMs) return "event-quiet";
        if (stable) return "poll-stable";
        return "wait";
    }
    internal object Wait(long deadline, Func<string> snapshot)
    {
        long began = clock.ElapsedMilliseconds;
        string mode = "wait", previous = null; long nextPoll = QuietMs;
        while (mode == "wait") {
            long elapsed = clock.ElapsedMilliseconds - began;
            DriverInput.EnsureNotCancelled();
            if (Driver.Now() >= deadline - 2750) { mode = "budget"; break; }
            mode = Decision(elapsed, clock.ElapsedMilliseconds - Interlocked.Read(ref last), Volatile.Read(ref events), subscribed, false);
            if (mode != "wait") break;
            if ((!subscribed || Volatile.Read(ref events) == 0) && elapsed >= nextPoll) {
                DriverSession.Require();
                string current = snapshot();
                if (Driver.Now() >= deadline - 2750) { mode = "budget"; break; }
                if (clock.ElapsedMilliseconds - began >= CapMs) { mode = "cap"; break; }
                // Two complete cached snapshots, at least 100 ms apart, for silent providers.
                bool stable = previous != null && current != null && previous == current;
                previous = current; nextPoll = clock.ElapsedMilliseconds - began + PollMs;
                if (stable) { mode = "poll-stable"; break; }
            }
            Thread.Sleep(10);
        }
        var result = Json.Map("mode", mode, "settled", mode == "event-quiet" || mode == "poll-stable",
            "elapsedMs", clock.ElapsedMilliseconds - began, "events", Volatile.Read(ref events));
        if (mode == "cap" || mode == "budget") DriverSession.AddHint(result);
        return result;
    }
    public void Dispose()
    {
        clock.Stop();
        if (focus) try { automation.RemoveFocusChangedEventHandler(this); } catch (COMException) { }
        foreach (var root in property) try { automation.RemovePropertyChangedEventHandler(root, this); } catch (COMException) { }
        foreach (var root in structure) try { automation.RemoveStructureChangedEventHandler(root, this); } catch (COMException) { }
        if (focusCache != null && Marshal.IsComObject(focusCache)) Marshal.ReleaseComObject(focusCache);
        GC.KeepAlive(roots);
    }
}
}
