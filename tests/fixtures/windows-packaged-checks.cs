// Synthetic observations only. Never calls a Windows API, UIA or input.
using System;
using System.Collections.Generic;
using System.Linq;
namespace Sleight.Driver {
internal static class PackagedChecks {
    static int passed;
    static void Check(bool value) { if (!value) throw new Exception("Packaged row " + (passed + 1)); passed++; }
    static void Refused(Action call) {
        try { call(); throw new Exception("Packaged admission survived"); }
        catch (DriverFault e) { Check(e.Code == "HOSTED_APP_UNRESOLVED"); }
    }
    static WindowRecord Row(string name, bool aumid) {
        return new WindowRecord { Handle = new IntPtr(99), Pid = 4240, ProcessStart = "134381325118728105",
            ClassName = name, App = "CalculatorApp", Title = "Calculator", Image = @"C:\Apps\CalculatorApp.exe",
            Aumid = aumid ? "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" : null, Integrity = "medium",
            WindowGeneration = "life", TopologyGeneration = "epoch:tree", OnCurrentDesktop = true,
            DesktopId = "11111111-2222-3333-4444-555555555555" };
    }
    static void ScanChecks() {
        var api = new DriverInventory.PackagedApi {
            Windows = visit => {
                foreach (int id in new[] { 101, 102, 103 }) if (!visit(new IntPtr(id))) return false;
                return true;
            },
            Children = (root, visit) => { if (root == new IntPtr(103)) visit(new IntPtr(104)); },
            Pid = hwnd => hwnd == new IntPtr(101) ? 41u : hwnd == new IntPtr(102) ? 42u : hwnd == new IntPtr(103) ? 53u : 44u,
            ClassName = hwnd => hwnd == new IntPtr(102) ? "Windows.UI.Core.CoreWindow" : hwnd == new IntPtr(103) ? "ApplicationFrameWindow" : "OrdinaryWindow",
            Executable = hwnd => "Fixture.exe", Exists = hwnd => true, PackageStatus = pid => 122
        };
        Check(!DriverInventory.HasPackagedWindow(41, api));
        foreach (uint pid in new uint[] { 42, 44, 53 }) Check(DriverInventory.HasPackagedWindow(pid, api));
        api.Windows = visit => false;
        Check(DriverInventory.HasPackagedWindow(41, api));
        api.Windows = visit => {
            for (int i = 0; i < 16385; i++) if (!visit(new IntPtr(101))) return false;
            return true;
        };
        Check(DriverInventory.HasPackagedWindow(41, api));
    }
    public static int Main() {
        try {
            ScanChecks();
            foreach (string kind in new[] { "ApplicationFrameWindow", "Windows.UI.Core.CoreWindow", "OtherHostedClass" })
            foreach (bool aumid in new[] { false, true }) {
                var row = Row(kind, aumid);
                // The third case is a different class owned by a hosted app PID.
                Check(DriverInventory.RefusePackaged(row, pid => kind == "OtherHostedClass" && pid == 4240));
                Check(row.Refused == "HOSTED_APP_UNRESOLVED");
                foreach (string selector in DriverInventory.HostedSelectors(row))
                    Refused(() => DriverInventory.Resolve(selector, new[] { row }).RequireReadable());
                Refused(() => DriverInventory.Resolve(Json.Map("windowId", "99"), new[] { row }).RequireReadable());
                var bindings = new DriverBindings();
                var admitted = Row("OrdinaryWindow", false); bindings.Remember(admitted);
                var binding = Json.Map("windowId", "99", "processStart", admitted.ProcessStart, "bindingId", admitted.BindingId);
                // UIA, capture and action identity all use this resolver before effects.
                foreach (string route in new[] { "UIA", "capture", "input" }) {
                    int effects = 0;
                    bindings.Remember(admitted);
                    binding["bindingId"] = admitted.BindingId;
                    Refused(() => { DriverIdentity.Resolve(binding, bindings, hwnd => row); effects++; });
                    Check(effects == 0);
                }
                string json = Json.Codec.Serialize(row.JsonValue());
                Check(!json.Contains("Calculator") && !json.Contains("CoreWindow") && json.Contains("hostedSelectorHashes"));
                Check(DriverInventory.HostedSelectorHashes(row).All(hash => hash.Length == 64));
            }
            var ordinary = Row("OrdinaryWindow", true);
            Check(!DriverInventory.RefusePackaged(ordinary, pid => false));
            ordinary.RequireReadable(); Check(true);
            // Execute the very C# guard embedded in the production guest script.
            Action<uint[], string[], string[]> receipt = (pids, births, frames) => Uc3fWindow.RequireCalculatorReceipt(4240,
                "134381325118728105", "134381325118000000", pids, births, frames, "99");
            receipt(new uint[] { 4240 }, new[] { "134381325118728105" }, new[] { "99" }); Check(true);
            foreach (int bad in Enumerable.Range(0, 5)) {
                try {
                    receipt(bad == 0 ? new uint[] { 4240, 5052 } : new uint[] { bad == 1 ? 5052u : 4240u },
                        bad == 2 ? new[] { "134381325118728106" } : new[] { "134381325118728105" },
                        bad == 3 ? new[] { "99", "100" } : bad == 4 ? new[] { "100" } : new[] { "99" });
                    throw new Exception("Unsafe Calculator receipt survived");
                } catch (InvalidOperationException e) { Check(e.Message == "FIXTURE_CALCULATOR_OWNERSHIP_UNPROVED"); }
            }
            try {
                Uc3fWindow.RequireCalculatorReceipt(4240,"134381325118728105","134381325118728105",new uint[] {4240},new[] {"134381325118728105"},new[] {"99"},"99");
                throw new Exception("Equal birth survived");
            } catch (InvalidOperationException e) { Check(e.Message == "FIXTURE_CALCULATOR_OWNERSHIP_UNPROVED"); }
            Console.WriteLine(Json.Codec.Serialize(Json.Map("passed", passed, "failed", 0, "drawing", false)));
            return 0;
        } catch (Exception e) { Console.Error.WriteLine(e); return 1; }
    }
}
}
