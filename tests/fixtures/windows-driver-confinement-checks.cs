using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;

namespace Sleight.Driver
{
// Scripted native evidence, no UIA activation and no posted input.
// The resolver, retained bindings, read, effect and post seams are production code.
// The one-argument hosted-pid case creates one hidden window this process owns, then destroys it.
internal static class DriverConfinementChecks
{
    static readonly List<object> cases = new List<object>();
    static int passed, failed;
    static WindowRecord Window()
    {
        return new WindowRecord { Handle = new IntPtr(101), Pid = 41, ThreadId = 51, ProcessStart = "134059077770000001",
            Image = "fixture.exe", ImageIdentity = "134059077770000000:4096", App = "Fixture", Title = "Fixture",
            ClassName = "FixtureWindow", Integrity = "medium", WindowGeneration = "1", TopologyGeneration = "1:tree",
            OnCurrentDesktop = true, DesktopId = "11111111-2222-3333-4444-555555555555" };
    }
    static DriverWindowLife Life()
    {
        return new DriverWindowLife { Pid = 41, Thread = 51, ProcessBirth = 134059077770000001,
            ThreadBirth = 134059077770000002, ClassAtom = 123 };
    }
    static void Check(bool condition) { if (!condition) throw new Exception("behavior assertion failed"); }
    static void Refuses(string code, Action action)
    {
        try { action(); } catch (DriverFault error) { Check(error.Code == code); return; }
        throw new Exception("expected refusal " + code);
    }
    static void Case(string name, Action action)
    {
        try { action(); passed++; cases.Add(Json.Map("name", name, "passed", true)); }
        catch (Exception error) { failed++; cases.Add(Json.Map("name", name, "passed", false, "error", error.Message)); }
    }
    static Dictionary<string, object> Params(WindowRecord window)
    {
        return Json.Map("windowId", WindowRecord.Id(window.Handle), "processStart", window.ProcessStart, "bindingId", window.BindingId);
    }
    static void Lifecycle()
    {
        Case("T12 native topology walk includes children siblings and grandchildren", () => {
            var descendants = DriverInventory.NativeDescendants(new IntPtr(101),
                h => h.ToInt64() == 101 ? new IntPtr(102) : h.ToInt64() == 102 ? new IntPtr(104) : IntPtr.Zero,
                h => h.ToInt64() == 102 ? new IntPtr(103) : IntPtr.Zero,
                h => new IntPtr(h.ToInt64() == 104 ? 102 : 101));
            Check(descendants.SetEquals(new[] { new IntPtr(102), new IntPtr(103), new IntPtr(104) }));
        });
        Case("T12 native topology walk refuses cycles", () => {
            Refuses("TARGET_UNAVAILABLE", () => DriverInventory.NativeDescendants(new IntPtr(101), h => new IntPtr(102),
                h => new IntPtr(102), h => new IntPtr(101)));
        });
        Case("T12 incomplete native enumeration releases no content", () => {
            int content = 0;
            Refuses("TARGET_UNAVAILABLE", () => {
                DriverInventory.RequireCompleteTopology(new HashSet<IntPtr>(), new HashSet<IntPtr>(new[] { new IntPtr(102) })); content++;
            }); Check(content == 0);
        });
        Case("H4 Lifetime observes root and descendants without writes", () => {
            var calls = new List<string>();
            var proof = DriverInventory.Lifetime(new IntPtr(101), h => { calls.Add("read:" + h); return Life(); },
                h => new HashSet<IntPtr>(new[] { new IntPtr(102) }), () => 1);
            Check(proof.Length == 2 && calls.Contains("read:101") && calls.Contains("read:102"));
        });
        Case("H4 Lifetime catches owning thread replacement", () => {
            int samples = 0;
            Refuses("IDENTITY_CHANGED", () => DriverInventory.Lifetime(new IntPtr(101), h => {
                var life = Life(); if (++samples > 1) life.Thread++; return life;
            }, h => new HashSet<IntPtr>(), () => 1));
        });
        Case("H4 Lifetime catches thread birth replacement", () => {
            int samples = 0;
            Refuses("IDENTITY_CHANGED", () => DriverInventory.Lifetime(new IntPtr(101), h => {
                var life = Life(); if (++samples > 1) life.ThreadBirth++; return life;
            }, h => new HashSet<IntPtr>(), () => 1));
        });
        Case("H4 Observe inventory reads unselected root without effects", () => {
            var writes = InventoryEffectAudit.Collect(); var reads = new List<IntPtr>(); var bindings = new DriverBindings();
            Check(writes.Count == 0);
            var row = DriverInventory.Observe(new IntPtr(101), h => true, h => { reads.Add(h); return Window(); },
                h => DriverInventory.Lifetime(h, w => { reads.Add(w); return Life(); }, w => new HashSet<IntPtr>(), () => 1), w => { }, bindings);
            Check(row.Refused == null && row.BindingId != null && reads.Count > 0 && writes.Count == 0);
        });
        Case("H4 Observe exposes lifetime failure as refused inventory", () => {
            var bindings = new DriverBindings();
            var row = DriverInventory.Observe(new IntPtr(101), h => true, h => Window(),
                h => { throw new DriverFault("TARGET_UNAVAILABLE"); }, w => { }, bindings);
            Check(row.Refused == "TARGET_UNAVAILABLE" && row.BindingId == null && bindings.Count == 0);
        });
        Case("H4 topology ignores unrelated create destroy and reorder", () => {
            var epoch = new DriverTopologyEpoch(); epoch.Track(new IntPtr(101), 41, new HashSet<IntPtr>());
            long before = epoch.Sample(new IntPtr(101)); int revoked = 0;
            foreach (uint kind in new uint[] { 0x8000, 0x8001, 0x8004, 0x800f }) {
                epoch.Record(kind, new IntPtr(201), 0, 0, 42, (r, h) => false, h => revoked++);
                epoch.Record(kind, new IntPtr(202), 0, 0, 41, (r, h) => false, h => revoked++);
            }
            Check(epoch.Sample(new IntPtr(101)) == before && revoked == 0);
        });
        Case("H4 root child change revokes only its binding", () => {
            var epoch = new DriverTopologyEpoch(); epoch.Track(new IntPtr(101), 41, new HashSet<IntPtr>());
            long before = epoch.Sample(new IntPtr(101)); int revoked = 0;
            epoch.Record(0x8000, new IntPtr(102), -4, 0, 41, (r, h) => true, h => revoked++);
            Check(epoch.Sample(new IntPtr(101)) != before && revoked == 1);
            epoch.Record(0x8001, new IntPtr(102), 0, 0, 0, (r, h) => false, h => revoked++);
            Check(revoked == 2);
        });
        Case("H4 caps refuse and prune over 4096 root lifetimes", () => {
            var epoch = new DriverTopologyEpoch(); var bindings = new DriverBindings();
            for (int i = 1; i <= 4096; i++) {
                var row = Window(); row.Handle = new IntPtr(i); bindings.Remember(row);
                epoch.Track(row.Handle, 41, new HashSet<IntPtr>());
            }
            var extra = Window(); extra.Handle = new IntPtr(4097);
            Refuses("TARGET_UNAVAILABLE", () => bindings.Remember(extra));
            Refuses("TARGET_UNAVAILABLE", () => epoch.Track(extra.Handle, 41, new HashSet<IntPtr>()));
            bindings.Prune(h => false); epoch.Prune(h => false);
            Check(bindings.Count == 0 && epoch.Count == 0);
            for (int i = 1; i <= 5000; i++) {
                bindings.Remember(extra); epoch.Track(extra.Handle, 41, new HashSet<IntPtr>());
                epoch.Record(0x8001, extra.Handle, 0, 0, 0, (r, h) => false, bindings.Revoke);
                Check(bindings.Count == 0 && epoch.Count == 0);
            }
            bindings.Remember(extra); epoch.Track(extra.Handle, 41, new HashSet<IntPtr>());
            bindings.Clear(); epoch.Clear(); Check(bindings.Count == 0 && epoch.Count == 0);
        });
        Case("INT23B late topology overflow isolates the affected root", () => {
            var epoch = new DriverTopologyEpoch();
            epoch.Track(new IntPtr(101), 41, new HashSet<IntPtr>(Enumerable.Range(1000, 4096).Select(i => new IntPtr(i))));
            epoch.Track(new IntPtr(201), 42, new HashSet<IntPtr>());
            long before = epoch.Sample(new IntPtr(201)); bool healthy = true;
            try { epoch.Record(0x8000, new IntPtr(9000), 0, 0, 41, (root, hwnd) => root == new IntPtr(101), hwnd => { }); }
            catch { healthy = false; }
            Check(healthy);
            Refuses("TARGET_UNAVAILABLE", () => epoch.Sample(new IntPtr(101)));
            Refuses("TARGET_UNAVAILABLE", () => epoch.Track(new IntPtr(101), 41, new HashSet<IntPtr>()));
            Check(epoch.Sample(new IntPtr(201)) == before);
        });
        Case("INT23B foreign-process child events retire their root", () => {
            foreach (uint kind in new uint[] { 0x8000, 0x8001, 0x8004, 0x800f }) {
                var epoch = new DriverTopologyEpoch();
                epoch.Track(new IntPtr(101), 41, new HashSet<IntPtr>(kind == 0x8000 ? new IntPtr[0] : new[] { new IntPtr(102) }));
                epoch.Track(new IntPtr(201), 42, new HashSet<IntPtr>());
                long before = epoch.Sample(new IntPtr(101)), other = epoch.Sample(new IntPtr(201));
                int revoked = 0;
                epoch.Record(kind, new IntPtr(102), 0, 0, 99,
                    (root, child) => root == new IntPtr(101) && kind != 0x8001 && kind != 0x800f, root => { Check(root == new IntPtr(101)); revoked++; });
                Check(epoch.Sample(new IntPtr(101)) != before && epoch.Sample(new IntPtr(201)) == other && revoked == 1);
            }
        });
        Case("T16 production observation detects turnover during native identity lookup", () => {
            var bindings = new DriverBindings(); string generation = "1"; int content = 0;
            Refuses("IDENTITY_CHANGED", () => {
                DriverInventory.ObserveBound(new IntPtr(101), h => new[] { generation, "tree" }, h => { generation = "2"; return Window(); }, w => { }, bindings);
                content++;
            }); Check(content == 0);
        });
        Case("T17 production observation rechecks topology after desktop provider", () => {
            var bindings = new DriverBindings(); string generation = "1"; int content = 0;
            Refuses("IDENTITY_CHANGED", () => {
                DriverInventory.ObserveBound(new IntPtr(101), h => new[] { "1", generation }, h => Window(), w => generation = "2", bindings);
                content++;
            }); Check(content == 0);
        });
        Case("T14 production observation rejects desktop movement during lookup", () => {
            var bindings = new DriverBindings();
            Refuses("IDENTITY_CHANGED", () => DriverInventory.ObserveBound(new IntPtr(101), h => new[] { "1", "tree" }, h => Window(),
                w => w.DesktopId = "22222222-2222-3333-4444-555555555555", bindings));
        });
        Case("T15 production observation refuses unknown virtual desktop", () => {
            var bindings = new DriverBindings();
            Refuses("TARGET_UNAVAILABLE", () => DriverInventory.ObserveBound(new IntPtr(101), h => new[] { "1", "tree" },
                h => { var w = Window(); w.OnCurrentDesktop = null; return w; }, w => { }, bindings));
        });
        Case("T35 native admission is an immutable copy", () => {
            var bindings = new DriverBindings(); var admitted = bindings.Remember(Window()); var parameters = Params(admitted);
            admitted.Pid = 999;
            Check(DriverIdentity.Resolve(parameters, bindings, h => Window()).Pid == 41);
        });
    }
    static void ResolveChanged(Action<WindowRecord> change, string code = "IDENTITY_CHANGED")
    {
        var bindings = new DriverBindings(); var admitted = bindings.Remember(Window()); var next = Window(); change(next);
        int reads = 0, posts = 0;
        Refuses(code, () => { DriverIdentity.Resolve(Params(admitted), bindings, h => next); reads++; posts++; });
        Check(reads == 0 && posts == 0);
        // Returning to equal fields never revives the token after a failed proof.
        Refuses("IDENTITY_CHANGED", () => DriverIdentity.Resolve(Params(admitted), bindings, h => Window()));
    }
    static void Identity()
    {
        Case("T35 revoked binding cannot revive an old input map with equal fields", () => {
            var bindings = new DriverBindings(); var old = bindings.Remember(Window()); bindings.Revoke(old.Handle);
            var rebound = bindings.Remember(Window()); int posts = 0;
            Refuses("IDENTITY_CHANGED", () => DriverInput.InputEffect(() => DriverIdentity.Verify(old, rebound), () => { posts++; return true; }));
            Check(posts == 0);
        });
        Case("T16 native read entry retains complete admitted tuple", () => {
            var bindings = new DriverBindings(); var admitted = bindings.Remember(Window()); var next = Window();
            Check(DriverIdentity.Resolve(Params(admitted), bindings, h => next) == next);
            Refuses("INVALID_PARAMS", () => DriverIdentity.Resolve(Json.Map("windowId", "101", "processStart", admitted.ProcessStart), bindings, h => next));
        });
        Case("T06 ordinary PID changed before read", () => ResolveChanged(w => w.Pid++));
        Case("T06 process birth changed before read", () => ResolveChanged(w => w.ProcessStart = "134059077770000002"));
        Case("T08 changed lifetime evidence invalidates same-process HWND", () => ResolveChanged(w => w.WindowGeneration = "2"));
        Case("T09 window thread changed", () => ResolveChanged(w => w.ThreadId++));
        Case("T05 topology changed then restored", () => ResolveChanged(w => w.TopologyGeneration = "2:tree"));
        Case("T06 executable image changed", () => ResolveChanged(w => w.Image = "other.exe"));
        Case("T06 executable identity changed", () => ResolveChanged(w => w.ImageIdentity = "134059077770000000:8192"));
        Case("T14 desktop moved while current membership stays true", () => ResolveChanged(w => w.DesktopId = "22222222-2222-3333-4444-555555555555"));
        Case("T14 current desktop membership changed", () => ResolveChanged(w => w.OnCurrentDesktop = false));
        Case("T15 unknown desktop membership", () => ResolveChanged(w => w.OnCurrentDesktop = null, "TARGET_UNAVAILABLE"));
        Case("T15 unknown desktop ID", () => ResolveChanged(w => w.DesktopId = null, "TARGET_UNAVAILABLE"));
        Case("T17 identity change withholds read content", () => {
            var admitted = Window(); var current = Window(); int fetched = 0, released = 0;
            Refuses("IDENTITY_CHANGED", () => {
                DriverUia.FetchChecked(admitted, () => { fetched++; current.WindowGeneration = "2"; return false; }, () => current, () => { });
                released++;
            });
            Check(fetched == 1 && released == 0);
        });
    }
    static void Selection()
    {
        Case("T11 packaged frame class casing never enables it", () => {
            var frame = Window(); frame.ClassName = "applicationframewindow"; frame.Aumid = "Fixture.Package!App";
            Refuses("HOSTED_APP_UNRESOLVED", frame.RequireReadable);
        });
        Case("T24 two windows in one incarnation refuse", () => {
            var first = Window(); var second = Window(); second.Handle = new IntPtr(102);
            Refuses("AMBIGUOUS_APP", () => DriverInventory.Resolve("Fixture", new[] { first, second }));
            Check(DriverInventory.Resolve(Json.Map("windowId", "102"), new[] { first, second }) == second);
        });
        Case("H4 name selection excludes popups", () => {
            var root = Window(); var popup = Window(); popup.Handle = new IntPtr(102); popup.Popup = true; popup.Owner = root.Handle;
            Check(DriverInventory.Resolve("Fixture", new[] { root, popup }) == root);
        });
        Case("T23 ownerless menu refuses", () => {
            var popup = Window(); popup.Handle = new IntPtr(102); popup.Popup = true; popup.ClassName = "#32768";
            Check(!DriverInventory.PopupFor(popup, Window(), h => IntPtr.Zero));
            popup.Owner = new IntPtr(999); Check(!DriverInventory.PopupFor(popup, Window(), h => IntPtr.Zero));
            popup.Owner = new IntPtr(101); Check(DriverInventory.PopupFor(popup, Window(), h => IntPtr.Zero));
        });
        foreach (string image in new[] { "ApplicationFrameHost.exe", "different.exe" }) {
            string selectedImage = image;
            Case("T10/T11 packaged frame refused for " + image, () => {
                var frame = Window(); frame.ClassName = "ApplicationFrameWindow"; frame.Image = selectedImage; frame.Aumid = "Fixture.Package!App";
                Refuses("HOSTED_APP_UNRESOLVED", frame.RequireReadable);
            });
        }
    }
    static void Effects()
    {
        Case("T36 every post retains identity inside a validated typing chunk", () => {
            var admitted = Window(); var current = Window(); int posts = 0;
            Refuses("IDENTITY_CHANGED", () => {
                for (int i = 0; i < 64; i++) DriverInput.InputEffect(() => DriverIdentity.Verify(admitted, current), () => {
                    posts++; current.WindowGeneration = "2"; return true;
                });
            }); Check(posts == 1);
        });
        Case("T36 cleanup never posts into a replacement root", () => {
            var admitted = Window(); var current = Window(); current.WindowGeneration = "2"; int posts = 0;
            Refuses("IDENTITY_CHANGED", () => DriverInput.InputEffect(() => DriverIdentity.Verify(admitted, current), () => { posts++; return true; }));
            Check(posts == 0);
        });
        Case("T36 pre-effect failure reports zero delivery", () => {
            var error = Driver.ErrorValue(DriverUia.ActionFailure("IDENTITY_CHANGED", "binding revoked", false, true, 0));
            Check((string)error["delivery"] == "not-sent" && (string)error["retry"] == "safe" && (int)error["typed"] == 0);
        });
        Case("T36 partial effect failure preserves progress and read-first", () => {
            var error = Driver.ErrorValue(DriverUia.ActionFailure("IDENTITY_CHANGED", "binding revoked", true, true, 64));
            Check((string)error["delivery"] == "sent-unverified" && (string)error["retry"] == "read-first" && (int)error["typed"] == 64);
        });
        foreach (string effect in new[] { "Invoke", "Toggle", "Select", "Expand", "Collapse", "ScrollIntoView", "DoDefaultAction", "Value", "Text" }) {
            string selected = effect;
            Case("T19 " + effect + " provider lookup moves element", () => {
                var admitted = Window(); var current = Window(); int effects = 0; var order = new List<string>();
                // A pattern/state lookup has just changed the root/element evidence.
                order.Add("provider-" + selected); current.TopologyGeneration = "2:moved";
                Refuses("IDENTITY_CHANGED", () => DriverUia.Effect(() => {
                    order.Add("verify-root-element"); DriverIdentity.Verify(admitted, current);
                }, () => { order.Add("effect"); effects++; }));
                Check(effects == 0 && order.SequenceEqual(new[] { "provider-" + selected, "verify-root-element" }));
            });
        }
        Case("T19 Scroll revalidates each iteration", () => {
            var admitted = Window(); var current = Window(); int effects = 0;
            Refuses("IDENTITY_CHANGED", () => {
                for (int i = 0; i < 3; i++) DriverUia.Effect(() => DriverIdentity.Verify(admitted, current), () => {
                    effects++; current.TopologyGeneration = "2:moved";
                });
            });
            Check(effects == 1);
        });
        Case("T19 expansion state lookup precedes identity checkpoint", () => {
            var admitted = Window(); var current = Window(); int effects = 0;
            Refuses("IDENTITY_CHANGED", () => DriverUia.ExpandCollapse(() => { current.ThreadId++; return 0; },
                () => DriverIdentity.Verify(admitted, current), () => effects++, () => effects++));
            Check(effects == 0);
        });
    }
    static void Boundaries()
    {
        Case("H4 Post samples person after all identity observations", () => {
            var order = new List<string>(); bool active = false; int sends = 0;
            var api = new DriverInput.PostApi {
                Identity = (w, h) => { order.Add("observe"); active = true; },
                Person = w => { order.Add("person"); if (active) throw new DriverFault("PERSON_TOOK_OVER"); },
                Send = (h, m, k, p) => { order.Add("send"); sends++; return true; }
            };
            Refuses("PERSON_TOOK_OVER", () => DriverInput.Post(Window(), new IntPtr(101), 0x102, 65, IntPtr.Zero, false, true, false, false, api));
            Check(sends == 0 && order.SequenceEqual(new[] { "observe", "person" }));
        });
        Case("H4 Post cleanup keeps identity but bypasses person", () => {
            int sends = 0;
            var api = new DriverInput.PostApi {
                Identity = (w, h) => { }, Person = w => { throw new Exception("cleanup person call"); },
                Send = (h, m, k, p) => { sends++; return true; }
            };
            DriverInput.Post(Window(), new IntPtr(101), 0x101, 65, IntPtr.Zero, true, true, false, false, api);
            Check(sends == 1);
        });
        Case("H4 EffectBoundary resamples person after provider work", () => {
            var order = new List<string>(); bool active = false;
            Refuses("PERSON_TOOK_OVER", () => DriverUia.EffectBoundary(() => { order.Add("observe"); active = true; },
                () => { order.Add("person"); if (active) throw new DriverFault("PERSON_TOOK_OVER"); }, () => order.Add("effect")));
            Check(order.SequenceEqual(new[] { "observe", "person" }));
        });
    }
    static void Pointers()
    {
        Case("T21 geometry refresh follows the final identity lookup", () => {
            int posts = 0, checks = 0, width = 100;
            Refuses("INVALID_COORDINATES", () => DriverInput.PointerEffect(() => { if (++checks == 2) width = 10; },
                () => new DriverPoint(20, 20), () => new DriverInput.Rect { Right = width, Bottom = 100 }, () => { posts++; return true; }));
            Check(posts == 0);
        });
        Case("T21 oversized provider rectangle cannot extend the root surface", () => {
            int posts = 0;
            Refuses("INVALID_COORDINATES", () => DriverInput.PointerEffect(() => { }, () => new DriverPoint(150, 20),
                () => new DriverInput.Rect { Right = 100, Bottom = 100 }, () => { posts++; return true; }));
            Check(posts == 0);
        });
        foreach (var point in new[] { new DriverPoint(-1, 20), new DriverPoint(100, 20), new DriverPoint(20, -1), new DriverPoint(20, 100) }) {
            var selected = point;
            Case("T21 pointer outside root " + point.X + "," + point.Y, () => {
                int posts = 0;
                Refuses("INVALID_COORDINATES", () => DriverInput.PointerEffect(() => { }, () => selected,
                    () => new DriverInput.Rect { Right = 100, Bottom = 100 }, () => { posts++; return true; }));
                Check(posts == 0);
            });
        }
        Case("T21 geometry lookup loses root identity before post", () => {
            var admitted = Window(); var current = Window(); int posts = 0;
            Refuses("IDENTITY_CHANGED", () => DriverInput.PointerEffect(() => DriverIdentity.Verify(admitted, current),
                () => new DriverPoint(20, 20), () => { current.WindowGeneration = "2"; return new DriverInput.Rect { Right = 100, Bottom = 100 }; },
                () => { posts++; return true; }));
            Check(posts == 0);
        });
        Case("T22 drag stops before point outside moved root", () => {
            int posts = 0;
            Refuses("INVALID_COORDINATES", () => {
                for (int i = 1; i <= 4; i++) {
                    int step = i;
                    DriverInput.PointerEffect(() => { }, () => new DriverPoint(step * 20, 20),
                        () => new DriverInput.Rect { Left = step == 3 ? 90 : 0, Right = 100, Bottom = 100 },
                        () => { posts++; return true; });
                }
            });
            Check(posts == 2);
        });
        Case("T21 inside negative-origin root posts once", () => {
            int posts = 0;
            Check(DriverInput.PointerEffect(() => { }, () => new DriverPoint(-150, 20),
                () => new DriverInput.Rect { Left = -200, Right = -100, Bottom = 100 }, () => { posts++; return true; }));
            Check(posts == 1);
        });
    }
    static WindowRecord Frame()
    {
        var frame = Window();
        frame.Handle = new IntPtr(201); frame.Pid = 7; frame.ThreadId = 70; frame.ProcessStart = "134059077770000009";
        frame.Image = @"C:\Windows\System32\ApplicationFrameHost.exe"; frame.ClassName = "ApplicationFrameWindow";
        frame.App = "ApplicationFrameHost"; frame.Title = "Calculator"; frame.Aumid = null;
        return frame;
    }
    static WindowRecord Core()
    {
        var core = Window();
        core.Handle = new IntPtr(301); core.Pid = 41; core.ThreadId = 51; core.ClassName = "Windows.UI.Core.CoreWindow";
        core.Aumid = "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"; core.App = "CalculatorApp"; core.Title = "Calculator";
        core.Image = @"C:\Program Files\WindowsApps\Calculator\CalculatorApp.exe"; core.Refused = "HOSTED_APP_UNRESOLVED";
        return core;
    }
    static void WithGate(Action action)
    {
        DriverInventory.PackagedFrameTestGate.Admit = true;
        try { action(); } finally { DriverInventory.PackagedFrameTestGate.Admit = false; }
    }
    static Func<IntPtr, uint?> FrameApp(IntPtr frame, string className, IntPtr[] cores, uint corePid)
    {
        return hwnd => DriverInventory.LiveHostedAppPid(hwnd, h => frame, h => className, h => cores,
            h => cores.Length == 1 && h == cores[0] ? corePid : 0);
    }
    static DriverInventory.HostedSight Sight(WindowRecord frame, WindowRecord core, IList<IntPtr> cores, Func<int, IList<IntPtr>> later = null)
    {
        int calls = 0;
        return new DriverInventory.HostedSight {
            SystemDirectory = @"C:\Windows\System32",
            Cores = h => { int n = ++calls; return later != null && n > 1 ? later(n) : cores; },
            Observe = h => h == core.Handle ? core.Copy() : frame.Copy(),
            Contained = (parent, child) => parent == frame.Handle && child == core.Handle,
            Policy = w => { }
        };
    }
    static void Packaged()
    {
        Case("T01 an elevated system frame host still reaches the app proof", () => {
            var frame = Frame();
            Check(!DriverInventory.FrameHostElevationContinues(frame, 0x4000, 0x2000));
            WithGate(() => {
                Check(DriverInventory.FrameHostElevationContinues(frame, 0x4000, 0x2000));
                Check(!DriverInventory.FrameHostElevationContinues(frame, 0x2000, 0x2000));
                var ordinary = Frame(); ordinary.ClassName = "Notepad";
                Check(!DriverInventory.FrameHostElevationContinues(ordinary, 0x4000, 0x2000));
                var core = Core();
                var row = DriverInventory.ResolveHosted(frame, Sight(frame, core, new[] { core.Handle }));
                Check(row.Refused == null && row.Pid == core.Pid && row.CoreHandle == core.Handle);
            });
        });
        Case("T01 shipped gate refuses a complete system frame", () => {
            Check(DriverInventory.PackagedFrameTestGate.Admit == false);
            var frame = Frame(); var core = Core();
            var row = DriverInventory.ResolveHosted(frame, Sight(frame, core, new[] { core.Handle }));
            Check(row.Refused == "HOSTED_APP_UNRESOLVED" && row.CoreHandle == IntPtr.Zero && row.Pid == frame.Pid);
        });
        Case("T01 system frame with one core admits the app root", () => WithGate(() => {
            var frame = Frame(); var core = Core(); int effects = 0;
            var row = DriverInventory.ResolveHosted(frame, Sight(frame, core, new[] { core.Handle }));
            Check(row.Refused == null && row.Handle == frame.Handle && row.CoreHandle == core.Handle && row.InputRoot == core.Handle);
            Check(row.Pid == core.Pid && row.FramePid == frame.Pid && row.FrameThreadId == frame.ThreadId && row.FrameStart == frame.ProcessStart);
            Check(row.Image == core.Image && row.Aumid == core.Aumid && row.Popup == false);
            DriverInput.RequireOwned(row, core.Handle, core.Pid, false); effects++;
            Check(effects == 1);
        }));
        Case("T01 proved frame stays unresolved while the shipped gate is closed", () => {
            var row = Core(); row.Handle = new IntPtr(201); row.ClassName = "ApplicationFrameWindow"; row.CoreHandle = new IntPtr(301); row.Refused = null;
            Check(DriverIdentity.UnresolvedHost(row));
            Refuses("HOSTED_APP_UNRESOLVED", () => DriverInventory.RequireFramePolicy(row));
            WithGate(() => { Check(!DriverIdentity.UnresolvedHost(row)); row.RequireReadable(); });
        });
        Case("T02 cloaked core stays the input root", () => WithGate(() => {
            var frame = Frame(); var core = Core(); core.Cloaked = true;
            var row = DriverInventory.ResolveHosted(frame, Sight(frame, core, new[] { core.Handle }));
            Check(row.Refused == null && row.Cloaked && row.InputRoot == core.Handle && row.Image == core.Image);
        }));
        Case("T03 zero cores refuse and release nothing", () => WithGate(() => {
            var frame = Frame(); var core = Core(); int content = 0;
            var row = DriverInventory.ResolveHosted(frame, Sight(frame, core, new IntPtr[0]));
            Check(row.Refused == "HOSTED_APP_UNRESOLVED" && row.CoreHandle == IntPtr.Zero); content++;
            Check(content == 1 && row.Aumid == null);
        }));
        Case("T04 two cores refuse, including a hidden second core", () => WithGate(() => {
            var frame = Frame(); var core = Core();
            foreach (var cores in new[] { new[] { core.Handle, new IntPtr(302) }, new[] { new IntPtr(302), core.Handle } }) {
                var row = DriverInventory.ResolveHosted(frame, Sight(frame, core, cores));
                Check(row.Refused == "HOSTED_APP_UNRESOLVED" && row.CoreHandle == IntPtr.Zero);
            }
        }));
        Case("T05 a second core before admission refuses with no content", () => WithGate(() => {
            var frame = Frame(); var core = Core(); int content = 0;
            var row = DriverInventory.ResolveHosted(frame, Sight(frame, core, new[] { core.Handle }, n => new List<IntPtr> { core.Handle, new IntPtr(302) }));
            Check(row.Refused == "HOSTED_APP_UNRESOLVED" && row.CoreHandle == IntPtr.Zero); content++;
            Check(content == 1);
        }));
        Case("T06 core pid, birth, AUMID or image change refuses", () => WithGate(() => {
            foreach (Action<WindowRecord> change in new Action<WindowRecord>[] { w => w.Pid = 99, w => w.ProcessStart = "134059077770000008",
                w => w.Aumid = "Other.Package!App", w => w.Image = @"C:\Program Files\WindowsApps\Other\Other.exe" }) {
                var frame = Frame(); var core = Core(); int reads = 0;
                var sight = Sight(frame, core, new[] { core.Handle });
                sight.Observe = h => { if (h != core.Handle) return frame.Copy(); var sample = core.Copy(); if (++reads == 2) change(sample); return sample; };
                var row = DriverInventory.ResolveHosted(frame, sight);
                Check(row.Refused == "HOSTED_APP_UNRESOLVED" && row.CoreHandle == IntPtr.Zero && row.Pid != 99);
            }
        }));
        Case("T07 a replacement core of the same app refuses the old root", () => WithGate(() => {
            var frame = Frame(); var core = Core();
            var row = DriverInventory.ResolveHosted(frame, Sight(frame, core, new[] { core.Handle }, n => new List<IntPtr> { new IntPtr(302) }));
            Check(row.Refused == "HOSTED_APP_UNRESOLVED" && row.CoreHandle == IntPtr.Zero);
        }));
        Case("T08 reused core handle with a new birth or thread refuses", () => WithGate(() => {
            foreach (Action<WindowRecord> change in new Action<WindowRecord>[] { w => w.ProcessStart = "134059077770000008", w => w.ThreadId = 88 }) {
                var frame = Frame(); var core = Core(); int reads = 0;
                var sight = Sight(frame, core, new[] { core.Handle });
                sight.Observe = h => { if (h != core.Handle) return frame.Copy(); var sample = core.Copy(); if (++reads == 2) change(sample); return sample; };
                Check(DriverInventory.ResolveHosted(frame, sight).CoreHandle == IntPtr.Zero);
            }
        }));
        Case("T09 admitted frame thread is part of the binding", () => {
            var admitted = Window(); admitted.FrameThreadId = 70; var next = admitted.Copy(); next.FrameThreadId = 71;
            Refuses("IDENTITY_CHANGED", () => DriverIdentity.Verify(admitted, next));
        });
        Case("T09 reused host birth or host thread refuses", () => WithGate(() => {
            foreach (Action<WindowRecord> change in new Action<WindowRecord>[] { w => w.ProcessStart = "134059077770000010", w => w.ThreadId = 71 }) {
                var frame = Frame(); var core = Core(); int reads = 0;
                var sight = Sight(frame, core, new[] { core.Handle });
                sight.Observe = h => { if (h == core.Handle) return core.Copy(); var sample = frame.Copy(); if (++reads == 1) change(sample); return sample; };
                var row = DriverInventory.ResolveHosted(frame, sight);
                Check(row.Refused == "HOSTED_APP_UNRESOLVED" && row.CoreHandle == IntPtr.Zero);
            }
        }));
        Case("T10 a system-named host outside the system directory refuses", () => WithGate(() => {
            var frame = Frame(); frame.Image = @"D:\Copy\ApplicationFrameHost.exe"; var core = Core();
            var row = DriverInventory.ResolveHosted(frame, Sight(frame, core, new[] { core.Handle }));
            Check(row.Refused == "HOSTED_APP_UNRESOLVED" && row.CoreHandle == IntPtr.Zero && row.Pid == 7);
        }));
        Case("T11 a differently named frame with an AUMID is not an ordinary window", () => WithGate(() => {
            var frame = Frame(); frame.Image = @"C:\Apps\FakeHost.exe"; frame.Aumid = "Fake.Package!App"; frame.App = "FakeHost"; var core = Core();
            var row = DriverInventory.ResolveHosted(frame, Sight(frame, core, new[] { core.Handle }));
            Check(row.Refused == "HOSTED_APP_UNRESOLVED" && row.CoreHandle == IntPtr.Zero && row.Image == frame.Image);
            frame.ClassName = "applicationframewindow";
            Refuses("HOSTED_APP_UNRESOLVED", () => DriverInventory.RequireFramePolicy(frame));
        }));
        Case("T12 incomplete core enumeration refuses", () => WithGate(() => {
            var frame = Frame(); var core = Core();
            var sight = Sight(frame, core, new[] { core.Handle });
            sight.Cores = h => { throw new DriverFault("TARGET_UNAVAILABLE"); };
            var row = DriverInventory.ResolveHosted(frame, sight);
            Check(row.Refused == "HOSTED_APP_UNRESOLVED" && row.CoreHandle == IntPtr.Zero);
        }));
        Case("T14 desktop change during the frame proof refuses", () => WithGate(() => {
            var frame = Frame(); var core = Core(); int reads = 0;
            var sight = Sight(frame, core, new[] { core.Handle });
            sight.Observe = h => {
                if (h == core.Handle) return core.Copy();
                var sample = frame.Copy(); if (++reads == 1) sample.DesktopId = "22222222-2222-3333-4444-555555555555"; return sample;
            };
            Check(DriverInventory.ResolveHosted(frame, sight).Refused == "HOSTED_APP_UNRESOLVED");
        }));
        Case("T16 core replacement is refused before content is read", () => WithGate(() => {
            var admitted = Core(); admitted.ClassName = "ApplicationFrameWindow"; admitted.Handle = new IntPtr(201);
            admitted.CoreHandle = new IntPtr(301); admitted.Refused = null; admitted.FramePid = 7; admitted.FrameThreadId = 70;
            var replaced = admitted.Copy(); replaced.CoreHandle = new IntPtr(302); int content = 0;
            Refuses("IDENTITY_CHANGED", () => DriverUia.FetchChecked(admitted, () => { content++; return false; }, () => replaced, () => { }));
            Check(content == 0);
        }));
        Case("T20 frame, caption and host sink are not the app root", () => WithGate(() => {
            var frame = Frame(); var core = Core();
            var row = DriverInventory.ResolveHosted(frame, Sight(frame, core, new[] { core.Handle }));
            Refuses("IDENTITY_CHANGED", () => DriverInput.RequireOwned(row, frame.Handle, frame.Pid, false));
            Refuses("IDENTITY_CHANGED", () => DriverInput.RequireOwned(row, new IntPtr(250), frame.Pid, false));
            DriverInput.RequireOwned(row, core.Handle, core.Pid, false);
            Refuses("IDENTITY_CHANGED", () => DriverInput.RequireOwned(row, new IntPtr(251), core.Pid, false));
            Refuses("IDENTITY_CHANGED", () => DriverInput.RequireOwned(row, new IntPtr(250), frame.Pid, true));
            DriverInput.RequireOwned(row, new IntPtr(250), row.Pid, true);
            Refuses("IDENTITY_CHANGED", () => DriverInput.RequireOwned(row, core.Handle, 0, true));
            Refuses("IDENTITY_CHANGED", () => DriverInput.RequireOwned(null, core.Handle, row.Pid, true));
        }));
        Case("T21 a frame-client point outside the core posts nothing", () => {
            int posts = 0;
            Refuses("INVALID_COORDINATES", () => DriverInput.PointerEffect(() => { }, () => new DriverPoint(180, 20),
                () => new DriverInput.Rect { Left = 100, Top = 40, Right = 160, Bottom = 120 }, () => { posts++; return true; }));
            Check(posts == 0);
        });
        Case("T22 drag releases the last in-root point and does not post the outside step", () => {
            int moved = 0; int released = -1;
            DriverInput.DragScript.Post = (window, hwnd, message, wParam, lParam, cleanup) => {
                int x = unchecked((short)lParam.ToInt64());
                if (message == 0x200 && wParam == 1) {
                    if (x >= 60) throw new DriverFault("INVALID_COORDINATES");
                    moved++;
                }
                if (message == 0x202) released = x;
            };
            DriverInput.DragScript.Person = window => { };
            DriverInput.DragScript.Logical = (hwnd, point) => point;
            DriverInput.DragScript.Pause = milliseconds => { };
            try {
                Refuses("INVALID_COORDINATES", () => DriverInput.Drag(Window(), new IntPtr(11),
                    new DriverPoint(0, 10), new DriverPoint(80, 10), 4, 40));
                Check(moved == 2 && released == 40);
            } finally {
                DriverInput.DragScript.Post = null; DriverInput.DragScript.Person = null;
                DriverInput.DragScript.Logical = null; DriverInput.DragScript.Pause = null;
            }
        });
        Case("T23 a packaged root does not adopt another frame's popup or an ownerless menu", () => {
            var root = Window(); root.CoreHandle = new IntPtr(301); root.Pid = 41;
            var popup = Window(); popup.Handle = new IntPtr(401); popup.Popup = true; popup.Owner = new IntPtr(201); popup.Pid = 41; popup.ClassName = "#32768";
            Check(!DriverInventory.PopupFor(popup, root, h => h == new IntPtr(201) ? root.Handle : IntPtr.Zero));
            popup.Owner = IntPtr.Zero; Check(!DriverInventory.PopupFor(popup, root, h => root.Handle));
            Refuses("HOSTED_APP_UNRESOLVED", () => DriverInventory.Resolve(Json.Map("windowId", "401"), new[] { root, popup }));
        });
        Case("T24 two packaged frames refuse a shared name and an exact HWND selects one", () => WithGate(() => {
            var frame = Frame(); var core = Core();
            var first = DriverInventory.ResolveHosted(frame, Sight(frame, core, new[] { core.Handle }));
            var otherFrame = Frame(); otherFrame.Handle = new IntPtr(202); otherFrame.Title = "Calculator";
            var otherCore = Core(); otherCore.Handle = new IntPtr(302); otherCore.Pid = 42; otherCore.ProcessStart = "134059077770000003";
            var second = DriverInventory.ResolveHosted(otherFrame, Sight(otherFrame, otherCore, new[] { otherCore.Handle }));
            Check(first.Refused == null && second.Refused == null);
            Refuses("AMBIGUOUS_APP", () => DriverInventory.Resolve("Calculator", new[] { first, second }));
            Check(DriverInventory.Resolve(Json.Map("windowId", WindowRecord.Id(second.Handle)), new[] { first, second }) == second);
        }));
        Case("T27 a second frame of the same app pid is the person and posts nothing", () => {
            var target = Frame(); target.CoreHandle = new IntPtr(301); target.Pid = 41;
            uint foreground = DriverPerson.ActivityPid(new IntPtr(401), 7, target, (parent, child) => false,
                FrameApp(new IntPtr(401), "ApplicationFrameWindow", new[] { new IntPtr(301) }, 41));
            Check(foreground == 41u);
            int effects = 0;
            Refuses("PERSON_TOOK_OVER", () => {
                if (DriverPerson.Decide(100, foreground, 99, target.Pid) != null) throw new DriverFault("PERSON_TOOK_OVER");
                effects++;
            });
            Check(effects == 0);
        });
        Case("T28 another packaged app on the same host is not this app", () => WithGate(() => {
            var frame = Frame(); var core = Core();
            var target = DriverInventory.ResolveHosted(frame, Sight(frame, core, new[] { core.Handle }));
            var otherFrame = Frame(); otherFrame.Handle = new IntPtr(402);
            var otherCore = Core(); otherCore.Handle = new IntPtr(502); otherCore.Pid = 42;
            otherCore.ProcessStart = "134059077770000003"; otherCore.Aumid = "Microsoft.Windows.Photos_8wekyb3d8bbwe!App";
            var other = DriverInventory.ResolveHosted(otherFrame, Sight(otherFrame, otherCore, new[] { otherCore.Handle }));
            Check(target.Refused == null && target.Pid == 41 && other.Refused == null && other.Pid == 42 && other.CoreHandle == otherCore.Handle);
            uint foreground = DriverPerson.ActivityPid(otherFrame.Handle, otherFrame.Pid, target, (parent, child) => false,
                FrameApp(otherFrame.Handle, "ApplicationFrameWindow", new[] { other.CoreHandle }, other.Pid));
            Check(foreground == 42u && foreground != otherFrame.Pid && DriverPerson.Decide(100, foreground, 99, target.Pid) == null);
        }));
        Case("T28 an unresolved Calculator frame does not refuse Notepad", () => {
            var notepad = Window(); notepad.Pid = 1000; notepad.Handle = new IntPtr(500); notepad.CoreHandle = IntPtr.Zero;
            notepad.ClassName = "Notepad"; notepad.App = "Notepad"; notepad.Image = @"C:\Windows\System32\notepad.exe";
            uint foreground = DriverPerson.ActivityPid(new IntPtr(401), 7, notepad, (parent, child) => false,
                FrameApp(new IntPtr(401), "ApplicationFrameWindow", new IntPtr[0], 0));
            int effects = 0;
            string reason = DriverPerson.Decide(100, foreground, 99, notepad.Pid);
            if (reason != null) throw new DriverFault("PERSON_TOOK_OVER");
            effects++;
            Check(foreground == 7u && reason == null && effects == 1);
        });
        Case("T28 a person in Notepad refuses the Notepad action", () => {
            var notepad = Window(); notepad.Pid = 1000; notepad.Handle = new IntPtr(500); notepad.CoreHandle = IntPtr.Zero;
            notepad.ClassName = "Notepad";
            uint foreground = DriverPerson.ActivityPid(notepad.Handle, notepad.Pid, notepad, (parent, child) => false,
                FrameApp(notepad.Handle, "Notepad", new IntPtr[0], 0));
            int effects = 0;
            Refuses("PERSON_TOOK_OVER", () => {
                if (DriverPerson.Decide(100, foreground, 99, notepad.Pid) != null) throw new DriverFault("PERSON_TOOK_OVER");
                effects++;
            });
            Check(foreground == 1000u && DriverPerson.Decide(100, foreground, 99, notepad.Pid) == "person-active" && effects == 0);
        });
        Case("T28 an unresolved frame over a packaged root is person-unknown", () => {
            var target = Frame(); target.CoreHandle = new IntPtr(301); target.Pid = 41;
            uint foreground = DriverPerson.ActivityPid(new IntPtr(401), 7, target, (parent, child) => false,
                FrameApp(new IntPtr(401), "ApplicationFrameWindow", new IntPtr[0], 0));
            int effects = 0;
            Refuses("PERSON_TOOK_OVER", () => {
                if (DriverPerson.Decide(100, foreground, 99, target.Pid) != null) throw new DriverFault("PERSON_TOOK_OVER");
                effects++;
            });
            Check(foreground == 0u && DriverPerson.Decide(100, foreground, 99, target.Pid) == "person-unknown" && effects == 0);
        });
        Case("SF2 LiveHostedAppPid returns one core and zero when the frame is unresolved", () => {
            uint? one = DriverInventory.LiveHostedAppPid(new IntPtr(401), h => h, h => "ApplicationFrameWindow",
                h => new List<IntPtr> { new IntPtr(301) }, h => h == new IntPtr(301) ? 41u : 0u);
            uint? none = DriverInventory.LiveHostedAppPid(new IntPtr(401), h => h, h => "ApplicationFrameWindow",
                h => new List<IntPtr>(), h => 41u);
            uint? two = DriverInventory.LiveHostedAppPid(new IntPtr(401), h => h, h => "ApplicationFrameWindow",
                h => new List<IntPtr> { new IntPtr(301), new IntPtr(302) }, h => 41u);
            uint? ordinary = DriverInventory.LiveHostedAppPid(new IntPtr(500), h => h, h => "Notepad",
                h => new List<IntPtr>(), h => 41u);
            uint? unread = DriverInventory.LiveHostedAppPid(new IntPtr(401), h => h, h => (string)null,
                h => new List<IntPtr> { new IntPtr(301) }, h => 41u);
            uint? zeroPid = DriverInventory.LiveHostedAppPid(new IntPtr(401), h => h, h => "ApplicationFrameWindow",
                h => new List<IntPtr> { new IntPtr(301) }, h => 0u);
            Check(one == 41u && none == 0u && two == 0u && ordinary == null && unread == 0u && zeroPid == 0u);
        });
        Case("T29 frame chrome and a second app frame count, and another app's frame does not", () => {
            var target = Frame(); target.CoreHandle = new IntPtr(301); target.Pid = 41;
            uint chrome = DriverPerson.ActivityPid(new IntPtr(250), 7, target, (parent, child) => parent == target.Handle && child == new IntPtr(250),
                FrameApp(new IntPtr(250), "ApplicationFrameWindow", new IntPtr[0], 0));
            uint second = DriverPerson.ActivityPid(new IntPtr(401), 7, target, (parent, child) => false,
                FrameApp(new IntPtr(401), "ApplicationFrameWindow", new[] { new IntPtr(301) }, 41));
            uint other = DriverPerson.ActivityPid(new IntPtr(402), 7, target, (parent, child) => false,
                FrameApp(new IntPtr(402), "ApplicationFrameWindow", new[] { new IntPtr(502) }, 42));
            Check(chrome == 41u && DriverPerson.Decide(100, 99, chrome, 41) == "person-active");
            Check(second == 41u && DriverPerson.Decide(100, second, 99, 41) == "person-active");
            Check(other == 42u && DriverPerson.Decide(100, 99, other, 41) == null);
        });
        Case("T26 ages 0 and 499 refuse the bound packaged frame and 500 and 501 proceed", () => WithGate(() => {
            var frame = Frame(); var core = Core();
            var row = DriverInventory.ResolveHosted(frame, Sight(frame, core, new[] { core.Handle }));
            Check(row.Refused == null && row.Pid == core.Pid && row.Handle == frame.Handle);
            foreach (uint age in new uint[] { 0, 499, 500, 501 }) {
                uint foreground = DriverPerson.ActivityPid(row.Handle, frame.Pid, row, (parent, child) => false,
                    FrameApp(frame.Handle, "ApplicationFrameWindow", new[] { core.Handle }, row.Pid));
                Check(foreground == row.Pid);
                string reason = DriverPerson.Decide(age, foreground, 99, row.Pid);
                Check(age < 500 ? reason == "person-active" : reason == null);
            }
        }));
        Case("T31 a person check during drag stops later moves and releases the last inside point", () => {
            int moved = 0; int released = -1; int seen = 0;
            var window = Window();
            DriverInput.DragScript.Post = (ignored, hwnd, message, wParam, lParam, cleanup) => {
                int x = unchecked((short)lParam.ToInt64());
                if (message == 0x200 && wParam == 1) moved++;
                if (message == 0x202) released = x;
            };
            DriverInput.DragScript.Person = target => {
                seen++;
                string reason = DriverPerson.Decide(seen == 1 ? 600u : 100u, target.Pid, 99, target.Pid);
                if (reason != null) throw new DriverFault("PERSON_TOOK_OVER");
            };
            DriverInput.DragScript.Logical = (hwnd, point) => point;
            DriverInput.DragScript.Pause = milliseconds => { };
            try {
                Refuses("PERSON_TOOK_OVER", () => DriverInput.Drag(window, new IntPtr(11),
                    new DriverPoint(0, 10), new DriverPoint(80, 10), 4, 40));
                Check(seen == 2 && moved == 1 && released == 20);
            } finally {
                DriverInput.DragScript.Post = null; DriverInput.DragScript.Person = null;
                DriverInput.DragScript.Logical = null; DriverInput.DragScript.Pause = null;
            }
        });
        Case("T34 category policy refuses the app behind a valid frame", () => WithGate(() => {
            foreach (string image in new[] { @"C:\Windows\System32\cmd.exe", @"C:\Apps\ChatGPT.exe" }) {
                var frame = Frame(); var core = Core(); core.Image = image;
                var sight = Sight(frame, core, new[] { core.Handle });
                sight.Policy = DriverIdentity.ApplyPolicy;
                var row = DriverInventory.ResolveHosted(frame, sight);
                Check(row.Refused == "HOSTED_APP_UNRESOLVED" && row.CoreHandle == IntPtr.Zero && row.Pid == frame.Pid);
            }
            foreach (string code in new[] { "ELEVATED_TARGET", "OWN_HOST" }) {
                var frame = Frame(); var core = Core(); core.Refused = code;
                var row = DriverInventory.ResolveHosted(frame, Sight(frame, core, new[] { core.Handle }));
                Check(row.Refused == "HOSTED_APP_UNRESOLVED" && row.CoreHandle == IntPtr.Zero && row.Image == frame.Image);
            }
        }));
        Case("SF4 Check computes the child flag at the RequireOwned call", () => {
            var window = Window(); int calls = 0;
            Refuses("IDENTITY_CHANGED", () => DriverInput.Check(window, new IntPtr(250), 7,
                (parent, child) => { calls++; return true; }, h => window));
            Check(calls == 1);
            calls = 0; long parentSeen = 0; long childSeen = 0;
            DriverInput.Check(window, new IntPtr(250), window.Pid, (parent, child) => {
                calls++; parentSeen = parent.ToInt64(); childSeen = child.ToInt64(); return true;
            }, h => window);
            Check(calls == 1 && parentSeen == window.Handle.ToInt64() && childSeen == 250);
            calls = 0;
            DriverInput.Check(window, window.Handle, window.Pid, (parent, child) => { calls++; return true; }, h => window);
            Check(calls == 0);
            Refuses("IDENTITY_CHANGED", () => DriverInput.Check(window, new IntPtr(250), window.Pid,
                (parent, child) => false, h => window));
            Refuses("IDENTITY_CHANGED", () => DriverInput.Check(window, window.Handle, window.Pid,
                (parent, child) => false, h => null));
        });
        Case("SF4 the one-argument LiveHostedAppPid reads a harness window the test owns", () => {
            Check(DriverInventory.LiveHostedAppPid(IntPtr.Zero) == 0u);
            IntPtr frame = IntPtr.Zero, core = IntPtr.Zero;
            bool frameClass = false, coreClass = false;
            try {
                RegisterHarness("ApplicationFrameWindow"); frameClass = true;
                RegisterHarness("Windows.UI.Core.CoreWindow"); coreClass = true;
                frame = CreateHidden("ApplicationFrameWindow", IntPtr.Zero);
                core = CreateHidden("Windows.UI.Core.CoreWindow", frame);
                Check(frame != IntPtr.Zero && core != IntPtr.Zero);
                Check(!IsWindowVisible(frame) && !IsWindowVisible(core));
                uint? pid = DriverInventory.LiveHostedAppPid(frame);
                Check(pid.HasValue && pid.Value == GetCurrentProcessId());
                Check(DriverInventory.ClassOf(frame) == "ApplicationFrameWindow");
                Check(DriverInventory.RootWindow(frame) == frame);
                Check(DriverInventory.PidOf(core) == GetCurrentProcessId());
            } finally {
                if (core != IntPtr.Zero) DestroyWindow(core);
                if (frame != IntPtr.Zero) DestroyWindow(frame);
                IntPtr module = GetModuleHandleW(null);
                if (coreClass) UnregisterClassW("Windows.UI.Core.CoreWindow", module);
                if (frameClass) UnregisterClassW("ApplicationFrameWindow", module);
            }
        });
        Case("T30 an unresolved hosted surface is person-unknown and posts nothing", () => {
            var target = Frame(); target.CoreHandle = new IntPtr(301); target.Pid = 41;
            uint foreground = DriverPerson.ActivityPid(new IntPtr(401), 7, target, (parent, child) => false,
                FrameApp(new IntPtr(401), "ApplicationFrameWindow", new IntPtr[0], 0));
            int effects = 0;
            Refuses("PERSON_TOOK_OVER", () => {
                if (DriverPerson.Decide(100, foreground, 99, target.Pid) != null) throw new DriverFault("PERSON_TOOK_OVER");
                effects++;
            });
            Check(foreground == 0u && effects == 0);
        });
    }
    delegate IntPtr HarnessProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WndClass {
        public uint Style;
        public IntPtr WndProc;
        public int ClassExtra, WindowExtra;
        public IntPtr Instance, Icon, Cursor, Background;
        public string Menu, ClassName;
    }
    static HarnessProc harnessProc;
    static IntPtr HarnessPointer() {
        if (harnessProc == null) harnessProc = HarnessWndProc;
        return Marshal.GetFunctionPointerForDelegate(harnessProc);
    }
    static IntPtr HarnessWndProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam) {
        return DefWindowProcW(hwnd, msg, wParam, lParam);
    }
    static void RegisterHarness(string className) {
        var wc = new WndClass();
        wc.WndProc = HarnessPointer();
        wc.Instance = GetModuleHandleW(null);
        wc.ClassName = className;
        if (RegisterClassW(ref wc) != 0) return;
        throw new Exception("RegisterClass " + className + " failed " + Marshal.GetLastWin32Error().ToString());
    }
    static IntPtr CreateHidden(string className, IntPtr parent) {
        uint style = parent == IntPtr.Zero ? 0x80000000u : 0x40000000u;
        IntPtr hwnd = CreateWindowExW(0x08000080u, className, "SleightPk1dHarness", style, 0, 0, 10, 10, parent, IntPtr.Zero, GetModuleHandleW(null), IntPtr.Zero);
        if (hwnd == IntPtr.Zero) throw new Exception("CreateWindow " + className + " failed " + Marshal.GetLastWin32Error().ToString());
        return hwnd;
    }
    [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern ushort RegisterClassW(ref WndClass wc);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool UnregisterClassW(string className, IntPtr instance);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateWindowExW(uint exStyle, string className, string windowName, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string module);
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    public static int Main()
    {
        var writes = InventoryEffectAudit.Collect();
        if (writes.Count != 0) Case("H4 Observe inventory reads unselected root without effects", () => Check(writes.Count == 0));
        else { Lifecycle(); Identity(); Selection(); Effects(); Pointers(); Boundaries(); Packaged(); }
        Console.WriteLine(Json.Codec.Serialize(Json.Map("passed", passed, "failed", failed, "drawing", false, "nativeCalls", 0, "cases", cases,
            "auditWrites", writes.Count, "auditNamespace", typeof(DriverInventory).Namespace,
            "auditInputNamespace", typeof(DriverInput).Namespace, "auditUiaNamespace", typeof(DriverUia).Namespace,
            "auditWriteLines", writes.ToArray())));
        return failed == 0 ? 0 : 1;
    }
}
}
