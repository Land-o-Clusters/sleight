using System;
using System.Collections.Generic;

namespace Sleight.Driver
{
internal static class IdentityChecks
{
    static int passed, failed;
    static readonly Guid Desktop = new Guid("11111111-2222-3333-4444-555555555555");
    static void Check(bool value) { if (value) passed++; else failed++; }
    static WindowRecord Popup()
    {
        return new WindowRecord { Handle = new IntPtr(1), Owner = new IntPtr(2), Pid = 41, Popup = true,
            ThreadId = 51, ProcessStart = "134059077770000001", Image = @"C:\Apps\charmap.exe", Integrity = "medium" };
    }
    static DriverInventory.DesktopSight Sight(uint ownerPid, bool current, Guid id)
    {
        return new DriverInventory.DesktopSight {
            Current = hwnd => hwnd == new IntPtr(1) || current,
            Id = hwnd => hwnd == new IntPtr(1) ? Guid.Empty : id,
            Owner = hwnd => hwnd == new IntPtr(1) ? new IntPtr(2) : IntPtr.Zero,
            Pid = hwnd => ownerPid, Exists = hwnd => hwnd == new IntPtr(2)
        };
    }
    static void Package(int status, bool frame, bool refused)
    {
        var api = new DriverInventory.PackagedApi {
            Windows = visit => visit(new IntPtr(3)) && visit(new IntPtr(4)),
            Children = (root, visit) => { visit(new IntPtr(5)); },
            Pid = hwnd => frame && hwnd != new IntPtr(5) ? 52u : 42u,
            ClassName = hwnd => frame ? "ApplicationFrameWindow" : hwnd == new IntPtr(3) ? "CabinetWClass" : "Windows.UI.Core.CoreWindow",
            Executable = hwnd => frame ? "ApplicationFrameHost.exe" : status == 122 ? "CalculatorApp.exe" : "explorer.exe",
            Exists = hwnd => true, PackageStatus = pid => status
        };
        var scan = DriverInventory.ScanPackagedWindows(api);
        var row = new WindowRecord { Pid = 42, ClassName = "CabinetWClass" };
        Check(DriverInventory.RefusePackaged(row, pid => DriverInventory.HasPackagedWindow(pid, api)) == refused);
        Check(scan.Pids.Contains(42) == refused);
        Check(!scan.Incomplete);
        Check(scan.PackageUnproved.Contains(42) == (status != 122 && status != 15700 && !frame));
        if (refused) Check(row.Refused == "HOSTED_APP_UNRESOLVED");
    }
    public static int Main()
    {
        try { Run(); } catch { failed++; }
        Console.WriteLine(Json.Codec.Serialize(Json.Map("passed", passed, "failed", failed, "drawing", false)));
        return failed == 0 ? 0 : 1;
    }
    static void Run()
    {
        var popup = Popup();
        DriverInventory.ReadDesktop(popup, Sight(41, true, Desktop));
        Check(popup.DesktopId == Desktop.ToString("D") && popup.OnCurrentDesktop == true);
        popup.RequireReadable(); Check(true);
        foreach (var sight in new[] { Sight(42, true, Desktop), Sight(41, false, Desktop), Sight(41, true, Guid.Empty) }) {
            var refused = Popup(); DriverInventory.ReadDesktop(refused, sight);
            Check(refused.DesktopId == null && refused.OnCurrentDesktop == null);
            try { refused.RequireReadable(); Check(false); }
            catch (DriverFault error) { Check(error.Code == "TARGET_UNAVAILABLE" && error.Step == "desktop-owner" && error.Message.Contains("step=desktop-owner")); }
        }
        foreach (string code in new[] { "TARGET_UNAVAILABLE", "HOSTED_APP_UNRESOLVED" }) {
            var fault = new DriverFault(code, code, "integrity"); Check(fault.Message == code + ": step=integrity");
            var refused = Popup(); refused.Refused = code; refused.RefusalStep = "frame-class";
            Check((string)refused.JsonValue()["refusalStep"] == "frame-class");
            var invalid = new DriverFault(code, code, @"C:\private\title");
            Check(invalid.Step == (code == "TARGET_UNAVAILABLE" ? "identity" : "frame"));
            Check(!invalid.Message.Contains("private"));
        }
        var explorer = new WindowRecord { Handle = new IntPtr(3), Pid = 42, Image = @"C:\Windows\explorer.exe",
            ClassName = "CabinetWClass", Integrity = "medium", ProcessStart = "134059077770000002",
            DesktopId = Desktop.ToString("D"), OnCurrentDesktop = true };
        Check(!DriverIdentity.UnresolvedHost(explorer)); explorer.RequireReadable(); Check(true);
        Check(!DriverInventory.RefusePackaged(explorer, pid => false));
        explorer.ClassName = "ApplicationFrameWindow";
        Check(DriverInventory.RefusePackaged(explorer, pid => false));
        try { explorer.RequireReadable(); Check(false); }
        catch (DriverFault error) { Check(error.Code == "HOSTED_APP_UNRESOLVED" && error.Step == "frame"); }
        Package(15700, false, false);
        Package(122, false, true);
        Package(-1, false, true);
        Package(15700, true, true);
        var packageFault = new DriverFault("HOSTED_APP_UNRESOLVED", "HOSTED_APP_UNRESOLVED", "frame-package");
        Check(packageFault.Step == "frame-package" && packageFault.Message.Contains("step=frame-package"));
    }
}
}
