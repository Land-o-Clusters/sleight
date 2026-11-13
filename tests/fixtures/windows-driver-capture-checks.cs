// All images and windows below are synthetic data. No UIA, HWND calls or windows are created.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;

namespace Sleight.Driver
{
internal static class CaptureChecks
{
    static int passed;
    static void Check(bool value) { if (!value) throw new Exception("Check " + (passed + 1)); passed++; }
    static void Refuses(string code, Action action)
    {
        try { action(); throw new Exception("Expected " + code); }
        catch (DriverFault error) { Check(error.Code == code); }
    }
    static WindowRecord Window()
    {
        return new WindowRecord { Handle = new IntPtr(101), Pid = 41, ProcessStart = "134059077770000001",
            Image = "fixture.exe", ImageIdentity = "134059077770000000:4096", Aumid = "Fixture.App", Title = "old", ClassName = "FixtureWindow", ThreadId = 51, Integrity = "medium",
            OnCurrentDesktop = true, DesktopId = "11111111-2222-3333-4444-555555555555" };
    }
    static void Identity()
    {
        var before = Window(); var after = Window();
        after.Title = "new"; Check(DriverIdentity.Verify(before, after) == after);
        after.Handle = new IntPtr(102); Refuses("IDENTITY_CHANGED", () => DriverIdentity.Verify(before, after));
        after = Window(); after.Pid++; Refuses("IDENTITY_CHANGED", () => DriverIdentity.Verify(before, after));
        after = Window(); after.ProcessStart = "134059077770000002"; Refuses("IDENTITY_CHANGED", () => DriverIdentity.Verify(before, after));
        after = Window(); after.Image = "other.exe"; Refuses("IDENTITY_CHANGED", () => DriverIdentity.Verify(before, after));
        after = Window(); after.ImageIdentity = "134059077770000001:4096"; Refuses("IDENTITY_CHANGED", () => DriverIdentity.Verify(before, after));
        after = Window(); after.ImageIdentity = "134059077770000000:8192"; Refuses("IDENTITY_CHANGED", () => DriverIdentity.Verify(before, after));
        after = Window(); after.Aumid = "Other.App"; Refuses("IDENTITY_CHANGED", () => DriverIdentity.Verify(before, after));
        after = Window(); after.ClassName = "RecycledWindow"; Refuses("IDENTITY_CHANGED", () => DriverIdentity.Verify(before, after));
        after = Window(); after.ThreadId++; Refuses("IDENTITY_CHANGED", () => DriverIdentity.Verify(before, after));
        Refuses("IDENTITY_CHANGED", () => DriverIdentity.Verify(before, null));
        foreach (string code in new[] { "OWN_HOST", "ELEVATED_TARGET", "OTHER_SESSION", "TARGET_UNAVAILABLE" }) {
            after = Window(); after.Refused = code;
            Refuses(code, () => DriverIdentity.Verify(before, after));
            string json = Json.Codec.Serialize(after.JsonValue());
            Check((code == "ELEVATED_TARGET" || !json.Contains("fixture.exe")) && !json.Contains("Fixture.App") && !json.Contains("old"));
            Check(!json.Contains(after.ImageIdentity));
        }
        foreach (string level in new[] { "high", "system" }) {
            after = Window(); after.Integrity = level;
            Check(DriverIdentity.Verify(before, after) == after);
            after.Refused = "ELEVATED_TARGET";
            Refuses("ELEVATED_TARGET", () => DriverIdentity.Verify(before, after));
        }
        foreach (string level in new[] { "unknown", null }) {
            after = Window(); after.Integrity = level;
            Refuses("TARGET_UNAVAILABLE", () => DriverIdentity.Verify(before, after));
        }
        after = Window(); after.Minimized = true; Refuses("MINIMIZED_PACKAGED_WINDOW", () => DriverIdentity.Verify(before, after));
        var valid = Json.Map("windowId", "101", "processStart", before.ProcessStart, "bindingId", new string('a', 32));
        Check(DriverIdentity.Binding(valid) == before.Handle);
        foreach (var bad in new[] { Json.Map(), Json.Map("windowId", "101"), Json.Map("windowId", 101, "processStart", before.ProcessStart),
            Json.Map("windowId", "101", "processStart", 134059077770000001L), Json.Map("windowId", "101", "processStart", before.ProcessStart, "args", new object[0]) }) {
            Refuses("INVALID_PARAMS", () => DriverIdentity.Binding(bad));
        }
        foreach (string bad in new[] { "0", "01", "-1", "1\n", "1e2", "9223372036854775808" })
            Refuses("INVALID_PARAMS", () => DriverIdentity.Birth(bad));
        foreach (string bad in new[] { "0", "01", "-1", "1\n", "18446744073709551616" })
            Refuses("INVALID_PARAMS", () => DriverInventory.Hwnd(bad));
        Check(DriverIdentity.Birth("9223372036854775807") == "9223372036854775807");
        if (IntPtr.Size == 8) Check(WindowRecord.Id(DriverInventory.Hwnd("18446744073709551615")) == "18446744073709551615");
    }
    static void CaptureAndGeometry()
    {
        Check(DriverCapture.Stride(1920, 1080) == 7680);
        Check(DriverCapture.Stride(2560, 1440) == 10240);
        foreach (int[] size in new[] { new[] { 0, 1 }, new[] { 1, -1 }, new[] { 8193, 1 }, new[] { 8192, 8192 }, new[] { Int32.MaxValue, 1 } })
            Refuses("CAPTURE_LIMIT", () => DriverCapture.Stride(size[0], size[1]));
        Check(DriverCapture.PrintFlags == 3);
        foreach (string note in new[] { "minimized", "cloaked", "black", "failed" }) {
            var result = DriverCapture.Note(note);
            Check((string)result["status"] == note && result.ContainsKey("note") && !result.ContainsKey("screenshot"));
        }
        foreach (string code in new[] { "CAPTURE_LIMIT", "CAPTURE_UNAVAILABLE", "GEOMETRY_CHANGED" }) {
            int verified = 0;
            var result = DriverCapture.CaptureForRead(() => { throw new DriverFault(code); }, () => { verified++; return Window(); });
            var note = Json.Object(result["capture"]);
            Check(verified == 1 && (string)note["status"] == "failed" && (string)note["code"] == code);
            Check(((string)note["note"]).Contains(code) && !result.ContainsKey("screenshot"));
            Refuses("IDENTITY_CHANGED", () => DriverCapture.CaptureForRead(() => { throw new DriverFault(code); },
                () => DriverIdentity.Verify(Window(), null)));
        }
        foreach (string code in new[] { "IDENTITY_CHANGED", "OWN_HOST", "ELEVATED_TARGET", "TARGET_UNAVAILABLE", "OTHER_SESSION" })
            Refuses(code, () => DriverCapture.CaptureForRead(() => { throw new DriverFault(code); },
                () => { throw new Exception("Unexpected identity fallback"); }));
        var success = Json.Map("screenshot", "fixture");
        Check(DriverCapture.CaptureForRead(() => success, () => { throw new Exception(); }) == success);
        foreach (int dpi in new[] { 96, 120, 144, 192 }) {
            var geometry = new DriverGeometry { Origin = new DriverGeometry.Point { X = -1920, Y = -200 }, Width = 800, Height = 600,
                Rect = new DriverRect { Left = -1930, Top = -230, Right = -1110, Bottom = 410 }, Dpi = dpi, Exposure = "covered" };
            var json = geometry.JsonValue();
            Check((double)json["scale"] == dpi / 96.0);
            Check(((int[])json["clientOrigin"])[0] == -1920 && ((int[])json["clientSize"])[0] == 800);
            Check(geometry.Stable(geometry));
            var changed = new DriverGeometry { Origin = geometry.Origin, Width = 800, Height = 600, Rect = geometry.Rect, Dpi = dpi + 1 };
            Check(!geometry.Stable(changed));
            var cover = new DriverRect { Left = -1800, Top = -100, Right = -1600, Bottom = 0 };
            Check(geometry.Rect.Intersects(cover));
            cover.Left = -1110; Check(!geometry.Rect.Intersects(cover));
        }
        // Adjacent visible DWM frames do not overlap even when invisible resize borders do.
        var frame = new DriverRect { Left = 0, Top = 0, Right = 800, Bottom = 600 };
        var outer = new DriverRect { Left = -7, Top = 0, Right = 807, Bottom = 607 };
        var adjacent = new DriverRect { Left = 800, Top = 0, Right = 1600, Bottom = 600 };
        Check(!frame.Intersects(adjacent) && outer.Intersects(adjacent));
        adjacent.Left--; Check(frame.Intersects(adjacent));
        IntPtr bits = Marshal.AllocHGlobal(16);
        try {
            // BGRA input: red, green, blue, white. Alpha bytes are deliberately zero.
            byte[] source = { 0, 0, 255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0 };
            Marshal.Copy(source, 0, bits, source.Length);
            byte[] png = DriverCapture.EncodePng(bits, 2, 2);
            Check(png.Length < 1024 && png[0] == 137 && png[1] == 80);
            using (var stream = new MemoryStream(png)) using (var image = new Bitmap(stream)) {
                Check(image.Width == 2 && image.Height == 2);
                Check(image.GetPixel(0, 0).ToArgb() == Color.Red.ToArgb());
                Check(image.GetPixel(1, 0).ToArgb() == Color.Lime.ToArgb());
                Check(image.GetPixel(0, 1).ToArgb() == Color.Blue.ToArgb());
                Check(image.GetPixel(1, 1).ToArgb() == Color.White.ToArgb());
            }
        } finally { Marshal.FreeHGlobal(bits); }
    }
    static void OwnHosts()
    {
        string temp = Path.Combine(Path.GetTempPath(), "driver-identity-" + Guid.NewGuid().ToString("N"));
        try {
            string root = Path.Combine(temp, "cache"), bank = Path.Combine(root, "bank");
            Directory.CreateDirectory(bank);
            string host = Path.Combine(bank, "cursor-host.exe"), self = Path.Combine(temp, "driver.exe"),
                copy = Path.Combine(temp, "renamed.exe"), other = Path.Combine(temp, "other.exe"), sameSize = Path.Combine(temp, "same-size.exe");
            File.WriteAllText(host, "fixture-host-image"); File.WriteAllText(self, "fixture-driver");
            File.Copy(host, copy); File.WriteAllText(other, "another-app-image!-different-size"); File.WriteAllText(sameSize, "another-app-image!");
            var catalog = new OwnHostCatalog(new[] { root }, self);
            Check(catalog.Contains(host)); Check(catalog.Contains(copy)); Check(catalog.Contains(self)); Check(!catalog.Contains(other));
            Check(!catalog.Contains(sameSize));
            Check(catalog.Contains(Path.Combine(root, "not-created.exe")));
            // Broken cache entries still refuse by path, but cannot poison ordinary targets.
            Directory.CreateDirectory(Path.Combine(bank, "person-host.exe"));
            File.WriteAllBytes(Path.Combine(bank, "driver-host.exe"), new byte[0]);
            var broken = new OwnHostCatalog(new[] { root }, self);
            Check(broken.Contains(host) && broken.Contains(copy) && !broken.Contains(other));
            using (var locked = new FileStream(host, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) {
                var skipLocked = new OwnHostCatalog(new[] { root }, self);
                Check(skipLocked.Contains(host) && skipLocked.Contains(self) && !skipLocked.Contains(other));
            }
            // Attribute-only length reads work while data access is locked.
            using (var locked = new FileStream(other, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
                Check(!catalog.Contains(other));
            using (var locked = new FileStream(copy, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) {
                bool refused = false;
                try { catalog.Contains(copy); } catch (IOException) { refused = true; }
                Check(refused);
            }
            // Empty/non-bank directories do not consume the 256-host-bank allowance.
            string many = Path.Combine(temp, "many"); Directory.CreateDirectory(many);
            for (int i = 0; i < 300; i++) Directory.CreateDirectory(Path.Combine(many, "empty-" + i));
            string last = Path.Combine(many, "host-bank"); Directory.CreateDirectory(last);
            File.Copy(host, Path.Combine(last, "cursor-host.exe"));
            var manyEmpty = new OwnHostCatalog(new[] { many }, self);
            Check(manyEmpty.Contains(copy) && !manyEmpty.Contains(other));
            for (int i = 0; i < 260; i++) {
                string directory = Path.Combine(many, "host-" + i); Directory.CreateDirectory(directory);
                File.Copy(host, Path.Combine(directory, "cursor-host.exe"));
            }
            var capped = new OwnHostCatalog(new[] { many }, self);
            Check(!capped.Contains(other) && capped.Contains(copy));
            Check(capped.Contains(Path.Combine(many, "host-259", "arbitrary.exe")));
            File.WriteAllBytes(self, new byte[0]);
            Refuses("TARGET_UNAVAILABLE", () => new OwnHostCatalog(new[] { root }, self));
            File.WriteAllText(self, "fixture-driver");
            int attempts = 0;
            Func<OwnHostCatalog> fail = () => { attempts++; throw new DriverFault("TARGET_UNAVAILABLE"); };
            DriverIdentity.BeginRequest();
            Refuses("TARGET_UNAVAILABLE", () => DriverIdentity.Catalog(fail));
            Refuses("TARGET_UNAVAILABLE", () => DriverIdentity.Catalog(fail));
            Check(attempts == 1);
            DriverIdentity.BeginRequest();
            var rebuilt = DriverIdentity.Catalog(() => { attempts++; return new OwnHostCatalog(new[] { root }, self); });
            Check(attempts == 2 && rebuilt.Contains(self));
            Check(DriverIdentity.Catalog(fail) == rebuilt && attempts == 2);
        } finally { if (Directory.Exists(temp)) Directory.Delete(temp, true); }
    }
    static void VanishedPopups()
    {
        var popup = Window(); popup.Popup = true;
        int fetched = 0, discarded = 0, observed = 0;
        Check(DriverUia.FetchChecked(popup, () => { fetched++; return false; }, () => null, () => discarded++));
        Check(fetched == 0 && discarded == 0);
        Check(DriverUia.FetchChecked(popup, () => false, () => ++observed == 1 ? popup : null, () => discarded++));
        Check(discarded == 1);
        foreach (bool com in new[] { true, false }) {
            observed = 0;
            Check(DriverUia.FetchChecked(popup, () => { if (com) throw new COMException(); throw new DriverFault("TARGET_UNAVAILABLE"); },
                () => ++observed == 1 ? popup : null, () => discarded++));
        }
        Check(discarded == 3);
        Refuses("IDENTITY_CHANGED", () => DriverUia.FetchChecked(Window(), () => false, () => null, () => discarded++));
        observed = 0;
        Refuses("IDENTITY_CHANGED", () => DriverUia.FetchChecked(Window(), () => false,
            () => ++observed == 1 ? Window() : null, () => discarded++));
        var reused = Window(); reused.ClassName = "NewPopup";
        observed = 0;
        Refuses("IDENTITY_CHANGED", () => DriverUia.FetchChecked(popup, () => false,
            () => ++observed == 1 ? popup : reused, () => discarded++));
        var refused = Window(); refused.Refused = "OWN_HOST";
        Refuses("OWN_HOST", () => DriverUia.FetchChecked(popup, () => false, () => refused, () => discarded++));
        Check(discarded == 3);
    }
    static void Routes()
    {
        for (int chosen = 0; chosen < 3; chosen++) {
            int success = chosen; var calls = new List<string>();
            var result = DriverCapture.CaptureChain(route => {
                calls.Add(route);
                if (calls.Count - 1 < success) return calls.Count % 2 == 0 ? null : new DriverFrame(1, 1, new byte[4]);
                return new DriverFrame(1, 1, new byte[] { 0, 1, 0, 0 });
            });
            Check(result.Frame != null && result.Method == DriverCapture.Routes[chosen]);
            Check(calls.Count == chosen + 1 && result.Attempts.Count == chosen + 1);
        }
        var black = DriverCapture.CaptureChain(route => new DriverFrame(1, 1, new byte[4]));
        Check(black.Frame == null && black.Attempts.Count == 3);
        foreach (var attempt in black.Attempts) Check((string)attempt["status"] == "black");
        var failed = DriverCapture.CaptureChain(route => { throw new DriverFault("CAPTURE_UNAVAILABLE"); });
        Check(failed.Frame == null && failed.Attempts.Count == 3);
        foreach (string code in new[] { "IDENTITY_CHANGED", "GEOMETRY_CHANGED", "CAPTURE_LIMIT", "ELEVATED_TARGET", "ACTION_BUDGET" }) {
            int calls = 0;
            Refuses(code, () => DriverCapture.CaptureChain(route => { calls++; throw new DriverFault(code); }));
            Check(calls == 1);
        }
        var geometry = new DriverGeometry { Origin = new DriverGeometry.Point { X = -100, Y = 0 }, Width = 100, Height = 100,
            Exposure = "exposed", Rect = new DriverRect { Left = -100, Top = 0, Right = 0, Bottom = 100 } };
        geometry.Monitors.Add(new[] { -100, 0, 100, 100 });
        Check(DriverCapture.ScreenCopyAllowed(geometry));
        foreach (string exposure in new[] { "covered", "unknown", "offscreen", "minimized", "other-space" }) {
            geometry.Exposure = exposure; Check(!DriverCapture.ScreenCopyAllowed(geometry));
        }
        geometry.Exposure = "exposed"; geometry.Width++; Check(!DriverCapture.ScreenCopyAllowed(geometry));
        geometry.Width--; geometry.Covers.Add(new[] { -50, 0, 10, 10 }); Check(!DriverCapture.ScreenCopyAllowed(geometry));
        Check(!new DriverFrame(1, 1, new byte[] { 0, 0, 0, 255 }).HasColor());
        Check(new DriverFrame(1, 1, new byte[] { 1, 0, 0, 0 }).HasColor());
        // Nonzero RGB is only a black-frame check, not proof that the provider painted the whole frame.
        foreach (var pixels in new[] {
            new byte[] { 255, 255, 255, 0, 255, 255, 255, 0 }, // white
            new byte[] { 128, 128, 128, 0, 128, 128, 128, 0 }, // grey
            new byte[] { 0, 0, 0, 0, 255, 255, 255, 0 }, // half black
            new byte[] { 0, 0, 0, 0, 1, 0, 0, 0 } // one lit channel
        }) {
            int calls = 0;
            var partial = DriverCapture.CaptureChain(route => { calls++; return new DriverFrame(2, 1, pixels); });
            Check(calls == 1 && partial.Method == "PrintWindow" && partial.Frame != null);
            Check((string)partial.Attempts[0]["status"] == "ok");
        }
        Refuses("CAPTURE_UNAVAILABLE", () => new DriverFrame(2, 1, new byte[4]).HasColor());
    }
    public static int Main()
    {
        try {
            Identity(); CaptureAndGeometry(); OwnHosts(); VanishedPopups(); Routes();
            Console.WriteLine(Json.Codec.Serialize(Json.Map("passed", passed, "failed", 0, "drawing", false)));
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
}
