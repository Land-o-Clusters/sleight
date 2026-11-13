using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Sleight.Driver
{
// Read-only guest inventory. No posted input, no UIA patterns, no window creation.
internal static class PackagedGuestRead
{
    static string Label(WindowRecord row)
    {
        if (row.Aumid != null && row.Aumid.IndexOf("WindowsCalculator", StringComparison.OrdinalIgnoreCase) >= 0) return "Calculator";
        if (row.Aumid != null && row.Aumid.IndexOf("ImmersiveControlPanel", StringComparison.OrdinalIgnoreCase) >= 0) return "Settings";
        if (row.Title == "Calculator" || row.Title == "Settings") return row.Title;
        return null;
    }
    static bool Interesting(WindowRecord row)
    {
        if (row == null) return false;
        if (Label(row) != null) return true;
        return String.Equals(row.ClassName, "ApplicationFrameWindow", StringComparison.OrdinalIgnoreCase) ||
            String.Equals(row.ClassName, "Windows.UI.Core.CoreWindow", StringComparison.OrdinalIgnoreCase);
    }
    static Dictionary<string, object> Brief(WindowRecord row)
    {
        uint? hosted = DriverInventory.LiveHostedAppPid(row.Handle);
        int cores = String.Equals(row.ClassName, "ApplicationFrameWindow", StringComparison.OrdinalIgnoreCase) ? DriverInventory.DiagnosticCoreCount(row.Handle) : -1;
        return Json.Map("label", Label(row), "className", row.ClassName, "refused", row.Refused, "pid", row.Pid,
            "framePid", row.FramePid, "frameThreadId", row.FrameThreadId, "hasCore", row.CoreHandle != IntPtr.Zero,
            "popup", row.Popup, "hostedPid", hosted.HasValue ? (object)hosted.Value : null, "cores", cores,
            "childClasses", String.Equals(row.ClassName, "ApplicationFrameWindow", StringComparison.OrdinalIgnoreCase) ? DriverInventory.DiagnosticChildClasses(row.Handle) : new string[0],
            "imageName", Path.GetFileName(row.Image ?? ""), "titleLength", (row.Title ?? "").Length,
            "desktopKnown", row.DesktopId != null, "onCurrentDesktop", row.OnCurrentDesktop,
            "windowId", WindowRecord.Id(row.Handle));
    }
    static Dictionary<string, object> Pass(bool admit)
    {
        DriverInventory.PackagedFrameTestGate.Admit = admit;
        try {
            var windows = DriverInventory.Windows();
            var rows = windows.Where(Interesting).Select(Brief).ToArray();
            int admitted = windows.Count(row => row.Refused == null && row.CoreHandle != IntPtr.Zero);
            int unresolved = windows.Count(row => row.Refused == "HOSTED_APP_UNRESOLVED");
            return Json.Map("admit", admit, "open", DriverInventory.PackagedFramesOpen(), "windows", windows.Count,
                "admitted", admitted, "unresolved", unresolved, "rows", rows, "error", null);
        } catch (DriverFault error) {
            return Json.Map("admit", admit, "open", DriverInventory.PackagedFramesOpen(), "windows", 0,
                "admitted", 0, "unresolved", 0, "rows", new object[0], "error", error.Code);
        } finally { DriverInventory.PackagedFrameTestGate.Admit = false; }
    }
    static Dictionary<string, object> Lifetime()
    {
        DriverInventory.PackagedFrameTestGate.Admit = true;
        try {
            var first = DriverInventory.Windows();
            var second = DriverInventory.Windows();
            int compared = 0, same = 0, resolved = 0;
            foreach (var row in first) {
                if (row.Refused != null || row.CoreHandle == IntPtr.Zero || Label(row) == null) continue;
                compared++;
                var again = second.FirstOrDefault(item => item.Handle == row.Handle);
                if (again != null && row.SameIdentity(again)) same++;
                try {
                    var chosen = DriverInventory.Resolve(Json.Map("windowId", WindowRecord.Id(row.Handle)), second);
                    if (chosen != null && chosen.SameIdentity(row)) resolved++;
                } catch (DriverFault) { }
            }
            return Json.Map("compared", compared, "same", same, "resolved", resolved, "error", null);
        } catch (DriverFault error) {
            return Json.Map("compared", 0, "same", 0, "resolved", 0, "error", error.Code);
        } finally { DriverInventory.PackagedFrameTestGate.Admit = false; }
    }
    public static int Main()
    {
        int posts = DriverInput.PostedMessages;
        var closed = Pass(false);
        var open = Pass(true);
        var life = Lifetime();
        bool inputSent = DriverInput.PostedMessages != posts;
        Console.WriteLine(Json.Codec.Serialize(Json.Map("drawing", false, "nativeInput", inputSent,
            "gateAfter", DriverInventory.PackagedFramesOpen(), "closed", closed, "open", open, "lifetime", life)));
        return inputSent ? 3 : 0;
    }
}
}
