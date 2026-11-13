// Synthetic metadata only. No window, UIA activation or posted input.
using System;
using System.Collections.Generic;
using System.Linq;
namespace Sleight.Driver
{
internal static class LifecycleChecks
{
    static int passed;
    static void Check(bool value) { if (!value) throw new Exception("Lifecycle row " + (passed + 1)); passed++; }
    public static int Main()
    {
        try {
            var root = new IntPtr(101); var focus = new IntPtr(103); var parent = new IntPtr(102);
            var ring = new DriverLifecycleRing(); ring.RememberFocus(focus, new HashSet<IntPtr> { root, parent, focus });
            for (int i = 1; i <= 130; i++) {
                ring.Advance(root, i, 0x8004, parent, -4, 0, 41, 51, "SyntheticClass", true);
                var value = Json.Object(ring.Snapshot(root)); var rows = (object[])value["events"];
                Check(rows.Length == Math.Min(i, 64)); Check((long)value["total"] == i);
                Check((bool)value["overflow"] == (i > 64));
                Check((long)Json.Object(rows[0])["epoch"] == Math.Max(1, i - 63));
                Check((long)Json.Object(rows[rows.Length - 1])["epoch"] == i);
                Check((string)Json.Object(rows[0])["focusRelation"] == "ancestor-of-focus");
                Check(Json.Object(rows[0]).Keys.OrderBy(k => k).SequenceEqual(new[] { "childId", "className", "epoch", "focusHwnd",
                    "focusPathKnown", "focusRelation", "hwnd", "kind", "objectId", "pid", "rootRelation", "thread" }));
            }
            Check(DriverLifecycleRing.Relation(root, focus, root, true, true) == "equals-root");
            Check(DriverLifecycleRing.Relation(root, focus, focus, true, true) == "equals-focus");
            Check(DriverLifecycleRing.Relation(root, focus, parent, true, true) == "ancestor-of-focus");
            Check(DriverLifecycleRing.Relation(root, focus, new IntPtr(104), false, true) == "other-member");
            Check(DriverLifecycleRing.Relation(root, focus, new IntPtr(105), false, false) == "descendant-not-retained");
            var epoch = new DriverTopologyEpoch(); epoch.Track(root, 41, new HashSet<IntPtr> { parent, focus });
            long first = epoch.Sample(root); int advances = 0, revokes = 0;
            epoch.Record(0x8001, focus, 0, 0, 0, (r,h) => false, r => revokes++, (r,e,retained) => {
                Check(r == root && retained && e == first + 1); advances++;
            });
            Check(advances == 1 && revokes == 1 && epoch.Sample(root) == first + 1);
            epoch.Record(0x8004, parent, -4, 0, 41, (r,h) => false, r => revokes++, (r,e,retained) => { throw new Exception(); });
            Check(revokes == 2 && epoch.Sample(root) == first + 2);
            string saved = Environment.GetEnvironmentVariable("SLEIGHT_DRIVER_COUNTERS");
            try {
                foreach (string flag in new[] { null, "0", "1" }) {
                    Environment.SetEnvironmentVariable("SLEIGHT_DRIVER_COUNTERS", flag);
                    var fault = new DriverFault("IDENTITY_CHANGED") { Disposition = Json.Map("lifecycleEvents", ring.Snapshot(root)) };
                    Check(Driver.ErrorValue(fault).ContainsKey("lifecycleEvents") == (flag == "1"));
                    var other = new DriverFault("TARGET_UNAVAILABLE") { Disposition = fault.Disposition };
                    Check(!Driver.ErrorValue(other).ContainsKey("lifecycleEvents"));
                }
            } finally { Environment.SetEnvironmentVariable("SLEIGHT_DRIVER_COUNTERS", saved); }
            Console.WriteLine(Json.Codec.Serialize(Json.Map("passed", passed, "failed", 0, "drawing", false)));
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
}
}
