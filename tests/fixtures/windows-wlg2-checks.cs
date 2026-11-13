// Synthetic handles and metadata only. No UIA, windows or native input calls.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text;
namespace Sleight.Driver
{
internal static class LifecycleReviewChecks
{
    static int passed;
    internal static uint TargetPid = 41;
    internal static WindowRecord Observed;
    internal static bool ThrowDiagnostic;
    internal static bool Exists(IntPtr hwnd) { return true; }
    internal static uint Thread(IntPtr hwnd, out uint pid) { pid = TargetPid; return 51; }
    internal static bool Child(IntPtr root, IntPtr hwnd) { return root == new IntPtr(101) && hwnd == new IntPtr(102); }
    internal static IntPtr Parent(IntPtr hwnd) { return hwnd == new IntPtr(102) ? new IntPtr(101) : IntPtr.Zero; }
    internal static bool Gui(ref IntPtr focus) { focus = new IntPtr(102); return true; }
    internal static WindowRecord Observe(IntPtr hwnd) { return Observed; }
    internal static int ClassName(StringBuilder name) { name.Append("SyntheticClass"); return name.Length; }
    static DriverWindowLife Life(long birth)
    {
        return new DriverWindowLife { Pid = 41, Thread = 51, ProcessBirth = birth, ThreadBirth = birth + 1, ClassAtom = 1 };
    }
    static void Event(DriverTopology topology, uint kind, IntPtr hwnd)
    {
        typeof(DriverTopology).GetMethod("OnEvent", BindingFlags.NonPublic | BindingFlags.Instance).Invoke(topology,
            new object[] { IntPtr.Zero, kind, hwnd, 0, 0, 51u, 0u });
    }
    static Dictionary<string, object> Snapshot(DriverTopology topology)
    {
        return Json.Object(topology.Lifecycle(new IntPtr(101)));
    }
    static void Check(bool value) { if (!value) throw new Exception("Lifecycle review row " + (passed + 1)); passed++; }
    static WindowRecord Window()
    {
        return new WindowRecord { Handle = new IntPtr(101), Pid = 41, ProcessStart = "1", Image = "fixture.exe",
            Integrity = "medium", ClassName = "FixtureWindow", OnCurrentDesktop = true,
            DesktopId = "12345678-1234-1234-1234-123456789abc", WindowGeneration = "1", TopologyGeneration = "1:tree" };
    }
    static string Decision(Action action)
    {
        try { action(); return "allowed"; } catch (DriverFault fault) { return fault.Code; }
    }
    public static int Main()
    {
        string saved = Environment.GetEnvironmentVariable("SLEIGHT_DRIVER_COUNTERS");
        try {
            var root = new IntPtr(101); var child = new IntPtr(102);
            var epoch = new DriverTopologyEpoch();
            Check(epoch.Track(root, 41, new HashSet<IntPtr> { child }));
            Check(!epoch.Track(root, 41, new HashSet<IntPtr>()));
            long first = epoch.Sample(root); int revoked = 0; string atDiagnostic = null;
            epoch.Record(0x8004, child, 0, 0, 41, (r,h) => false, r => revoked++, (r,e,retained) => {
                atDiagnostic = revoked == 1 ? "revoked" : "live";
                throw new Exception("diagnostic failure");
            });
            Check(atDiagnostic == "revoked" && revoked == 1 && epoch.Sample(root) == first + 1);
            epoch.Record(0x8001, root, 0, 0, 0, (r,h) => false, r => revoked++);
            Check(Decision(() => epoch.Sample(root)) == "IDENTITY_CHANGED");
            Check(epoch.Track(root, 42, new HashSet<IntPtr>()));
            Check(epoch.Sample(root) > first);
            string[] expected = { "allowed", "allowed", "IDENTITY_CHANGED", "IDENTITY_CHANGED", "IDENTITY_CHANGED",
                "IDENTITY_CHANGED", "IDENTITY_CHANGED", "ELEVATED_TARGET" };
            string[] off = null;
            foreach (string flag in new[] { "0", "1" }) {
                Environment.SetEnvironmentVariable("SLEIGHT_DRIVER_COUNTERS", flag);
                DriverOperationCounters.Current = flag == "1" ? new DriverOperationCounters() : null;
                var decisions = new List<string>();
                var topology = new DriverTopology();
                typeof(DriverInventory).GetField("topology", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, topology);
                topology.Track(root, 41, new HashSet<IntPtr> { child }, Life(1));
                Check((topology.Lifecycle(root) != null) == (flag == "1"));
                for (int i = 0; i < expected.Length; i++) {
                    var admitted = Window(); var observed = Window();
                    IntPtr target = i == 1 ? root : i == 2 ? new IntPtr(999) : child;
                    TargetPid = i == 3 ? 42u : 41u;
                    if (i == 4) observed = null;
                    if (i == 5) observed.TopologyGeneration = "2:tree";
                    if (i == 6) observed.ProcessStart = "2";
                    if (i == 7) observed.Refused = "ELEVATED_TARGET";
                    Observed = observed;
                    string result = Decision(() => DriverInput.Check(admitted, target));
                    Check(result == expected[i]); decisions.Add(result);
                }
                TargetPid = 41;
                // A failed Focus proof cannot populate the label.
                Observed = null; DriverInventory.BeginLifecycleRequest();
                Check(Decision(() => DriverInput.Focus(Window())) == "IDENTITY_CHANGED");
                if (flag == "1") Check((string)Snapshot(topology)["focusHwnd"] == "0");
                Observed = Window(); DriverInventory.BeginLifecycleRequest();
                Check(DriverInput.Focus(Window()) == child);
                if (flag == "1") {
                    Check((string)Snapshot(topology)["focusHwnd"] == "102");
                    Event(topology, 0x8004, child);
                    Check((long)Snapshot(topology)["total"] == 1);
                    topology.Track(root, 41, new HashSet<IntPtr> { child }, Life(2));
                    Check((long)Snapshot(topology)["total"] == 0 && (string)Snapshot(topology)["focusHwnd"] == "0");
                    Event(topology, 0x8004, child);
                    Event(topology, 0x8001, root);
                    // Same proof: only fresh can reset this ring.
                    topology.Track(root, 41, new HashSet<IntPtr> { child }, Life(2));
                    Check((long)Snapshot(topology)["total"] == 0);
                    ThrowDiagnostic = true;
                    Check(Decision(() => topology.Track(new IntPtr(201), 41, new HashSet<IntPtr>(), Life(1))) == "allowed");
                    ThrowDiagnostic = false;
                }
                // Execute the production OnEvent callback and binding registry.
                foreach (uint kind in new uint[] { 0x8000, 0x8001, 0x8004, 0x800f, 0x800b, 0x8005 }) {
                    topology.Track(root, 41, new HashSet<IntPtr> { child }, Life(2));
                    var token = DriverInventory.Bindings.Remember(Window());
                    Event(topology, kind, child);
                    string result = Decision(() => DriverInventory.Bindings.Resolve(token.BindingId, root, token.ProcessStart, h => token));
                    Check(result == (kind == 0x800b || kind == 0x8005 ? "allowed" : "IDENTITY_CHANGED"));
                    decisions.Add(result);
                }
                if (flag == "1") {
                    var reply = Json.Map(); DriverOperationCounters.Attach(reply, DriverOperationCounters.Current, null);
                    Check((long)Json.Object(reply["identityChecks"])["count"] == 10);
                }
                if (off == null) off = decisions.ToArray(); else Check(off.SequenceEqual(decisions));
            }
            Console.WriteLine(Json.Codec.Serialize(Json.Map("passed", passed, "failed", 0, "drawing", false)));
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
        finally {
            DriverOperationCounters.Current = null; Environment.SetEnvironmentVariable("SLEIGHT_DRIVER_COUNTERS", saved);
            typeof(DriverInventory).GetField("topology", BindingFlags.NonPublic | BindingFlags.Static).SetValue(null, null);
            DriverInventory.Bindings.Clear();
        }
    }
}
}
