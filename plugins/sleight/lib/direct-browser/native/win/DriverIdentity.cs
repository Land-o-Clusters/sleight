using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Sleight.Driver
{
// All caller-controlled bindings are checked here, including requests forged by a REPL escape.
internal static class DriverIdentity
{
    static readonly bool AllowForbiddenTargets = Environment.GetEnvironmentVariable("SLEIGHT_ALLOW_FORBIDDEN_TARGETS") == "1";
    static readonly string[] TerminalNames = { "windowsterminal", "wt", "conhost", "openconsole", "powershell", "pwsh", "powershell_ise",
        "cmd", "mintty", "bash", "git-bash", "wsl", "ubuntu", "debian", "kali", "conemu", "conemu64", "cmder",
        "alacritty", "wezterm", "wezterm-gui", "hyper", "tabby" };
    static readonly string[] AiNames = { "chatgpt", "codex", "atlas" };
    const string TerminalAumid = @"\Amicrosoft\.windowsterminal(?:preview)?_";
    const string AiAumid = @"\Aopenai\.(?:chatgpt|codex|atlas)(?:[._!-]|\z)";
    const string TerminalClass = "ConsoleWindowClass";
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHGetKnownFolderPath(ref Guid folder, uint flags, IntPtr token, out IntPtr path);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern uint GetLongPathNameW(string shortPath, StringBuilder longPath, uint capacity);
    internal static string LongImagePath(string path)
    {
        var full = new StringBuilder(32768);
        uint length = GetLongPathNameW(path, full, (uint)full.Capacity);
        if (length == 0 || length >= full.Capacity || !Path.IsPathRooted(full.ToString())) throw new DriverFault("TARGET_UNAVAILABLE");
        return full.ToString();
    }
    internal static bool UnresolvedHost(WindowRecord window)
    {
        if (String.Equals(Path.GetFileName(window.Image), "ApplicationFrameHost.exe", StringComparison.OrdinalIgnoreCase)) return true;
        // A proved frame carries the app image and the one admitted CoreWindow.
        // The shipped gate is closed, so a frame class stays unresolved.
        if (String.Equals(window.ClassName, "ApplicationFrameWindow", StringComparison.OrdinalIgnoreCase) &&
            !(window.CoreHandle != IntPtr.Zero && DriverInventory.PackagedFramesOpen())) return true;
        return String.Equals(window.ClassName, "Windows.UI.Core.CoreWindow", StringComparison.OrdinalIgnoreCase);
    }
    [ThreadStatic] static OwnHostCatalog hosts;
    [ThreadStatic] static Exception catalogFault;
    internal static void BeginRequest() { hosts = null; catalogFault = null; }
    internal static OwnHostCatalog Catalog(Func<OwnHostCatalog> create)
    {
        if (catalogFault != null) throw catalogFault;
        if (hosts == null) {
            try { hosts = create(); }
            catch (Exception error) { catalogFault = error; throw; }
        }
        return hosts;
    }
    internal static string Birth(object value)
    {
        string text = Json.Text(value); long birth;
        if (!Regex.IsMatch(text, "\\A[1-9][0-9]{0,18}\\z") ||
            !Int64.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out birth)) throw new DriverFault("INVALID_PARAMS");
        return text;
    }
    internal static IntPtr Binding(Dictionary<string, object> p)
    {
        Json.Keys(p, "windowId processStart bindingId");
        Birth(p["processStart"]);
        if (!Regex.IsMatch(Json.Text(p["bindingId"]), "\\A[a-f0-9]{32}\\z")) throw new DriverFault("INVALID_PARAMS");
        return DriverInventory.Hwnd(Json.Text(p["windowId"]));
    }
    internal static WindowRecord Resolve(Dictionary<string, object> p)
    {
        return Resolve(p, DriverInventory.Bindings, DriverInventory.Observe);
    }
    internal static WindowRecord Resolve(Dictionary<string, object> p, DriverBindings bindings, Func<IntPtr, WindowRecord> observe)
    {
        IntPtr hwnd = Binding(p);
        return bindings.Resolve((string)p["bindingId"], hwnd, (string)p["processStart"], observe);
    }
    internal static WindowRecord Verify(WindowRecord before, WindowRecord after)
    {
        before.RequireReadable();
        if (after == null) throw new DriverFault("IDENTITY_CHANGED");
        after.RequireReadable();
        if (!before.SameIdentity(after)) throw new DriverFault("IDENTITY_CHANGED");
        return after;
    }
    internal static bool ForbiddenTarget(WindowRecord window)
    {
        var identities = new[] { window.Image, window.OriginalFilename, window.ProductName }
            .Select(value => Regex.Replace(Path.GetFileName(value ?? ""), @"\.exe\z", "", RegexOptions.IgnoreCase).ToLowerInvariant());
        string aumid = (window.Aumid ?? "").ToLowerInvariant();
        return TerminalNames.Intersect(identities).Any() || AiNames.Intersect(identities).Any() ||
            window.ClassName == TerminalClass || Regex.IsMatch(aumid, TerminalAumid) || Regex.IsMatch(aumid, AiAumid);
    }
    // This check also runs for each owned popup and for the live root of an
    // action. Allowing a terminal never allows its safety/settings surface.
    internal static bool ForbiddenSettings(WindowRecord window)
    {
        return ForbiddenTarget(window) && Regex.IsMatch((window.Title ?? "").Trim(),
            @"\A(?:(?:settings|preferences|réglages|einstellungen|impostazioni|configuración|ajustes|preferencias|設定|设置|偏好设置)(?:…|\.{3})?|(?:settings|preferences)(?:\s*[-:|]\s*.+)?|.+?\s*[-:|]\s*(?:settings|preferences)|general|profiles|startup|interaction|appearance|rendering|compatibility|actions|defaults)\z",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }
    internal static void ApplyPolicy(WindowRecord window)
    {
        if (UnresolvedHost(window)) { window.Refused = "HOSTED_APP_UNRESOLVED"; window.RefusalStep = "frame"; return; }
        if (window.Refused != null) return;
        if (ForbiddenSettings(window)) { window.Refused = "FORBIDDEN_SETTINGS"; return; }
        if (!AllowForbiddenTargets && ForbiddenTarget(window)) { window.Refused = "FORBIDDEN_TARGET"; return; }
        window.RefusalStep = "catalog";
        try {
            var catalog = Catalog(() => {
                Guid folder = new Guid("f1b32785-6fba-4fcf-9d55-7b8e7f157091");
                IntPtr value;
                if (SHGetKnownFolderPath(ref folder, 0, IntPtr.Zero, out value) != 0) throw new DriverFault("TARGET_UNAVAILABLE");
                string local;
                try { local = Marshal.PtrToStringUni(value); } finally { Marshal.FreeCoTaskMem(value); }
                if (String.IsNullOrEmpty(local) || !Path.IsPathRooted(local)) throw new DriverFault("TARGET_UNAVAILABLE");
                return new OwnHostCatalog(new[] { Path.Combine(local, "sleight", "turbo-host"),
                    Path.Combine(local, "sleight", "cursor-host") }, Assembly.GetExecutingAssembly().Location);
            });
            if (catalog.Contains(window.Image)) window.Refused = "OWN_HOST";
        } catch { window.Refused = "TARGET_UNAVAILABLE"; }
    }
}

// Paths in either host cache always refuse. Hashes also catch a copied host at another path.
// One bounded catalog per request; it is shared across that request's inventory and final checks.
internal sealed class OwnHostCatalog
{
    const long FileLimit = 32 * 1024 * 1024, TotalLimit = 128 * 1024 * 1024;
    readonly string[] roots;
    readonly HashSet<string> hashes = new HashSet<string>(StringComparer.Ordinal);
    readonly HashSet<long> sizes = new HashSet<long>();
    long bytes;
    int entries;
    static bool Below(string path, string root)
    {
        return path.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar,
            StringComparison.OrdinalIgnoreCase);
    }
    internal OwnHostCatalog(IEnumerable<string> cacheRoots, string ownImage)
    {
        roots = cacheRoots.Select(Path.GetFullPath).ToArray();
        // Only failure to hash this running driver invalidates the whole catalog.
        Add(ownImage);
        foreach (string root in roots) {
            try {
                if (!Exists(root, true)) continue;
                Ordinary(root);
                Bank(root);
                foreach (string directory in Directory.EnumerateDirectories(root)) {
                    if (entries >= 256) break;
                    try { Ordinary(directory); if (Bank(directory)) entries++; }
                    catch (IOException) { }
                    catch (UnauthorizedAccessException) { }
                    catch (DriverFault) { }
                }
            } catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            catch (DriverFault) { }
        }
    }
    static bool Exists(string path, bool directory)
    {
        try {
            var attributes = File.GetAttributes(path);
            if (((attributes & FileAttributes.Directory) != 0) != directory) throw new DriverFault("TARGET_UNAVAILABLE");
            return true;
        } catch (FileNotFoundException) { return false; }
        catch (DirectoryNotFoundException) { return false; }
        // The caller skips an inaccessible bank; its cache path still always refuses.
    }
    static void Ordinary(string path)
    {
        // Reject a reparse point in any ancestor, as well as on the leaf.
        for (string part = Path.GetFullPath(path); part != null; part = Path.GetDirectoryName(part)) {
            if ((File.GetAttributes(part) & FileAttributes.ReparsePoint) != 0) throw new DriverFault("TARGET_UNAVAILABLE");
            if (Path.GetPathRoot(part) == part) break;
        }
    }
    bool Bank(string directory)
    {
        bool present = false;
        foreach (string name in new[] { "cursor-host.exe", "driver-host.exe", "person-host.exe" }) {
            string image = Path.Combine(directory, name);
            try {
                if (!Exists(image, false)) continue;
                present = true; Add(image);
            } catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            catch (DriverFault) { }
        }
        return present;
    }
    void Add(string image)
    {
        Ordinary(image);
        using (var file = new FileStream(image, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            if (file.Length < 1 || file.Length > FileLimit || bytes + file.Length > TotalLimit) throw new DriverFault("TARGET_UNAVAILABLE");
            string hash;
            using (var digest = SHA256.Create()) hash = Convert.ToBase64String(digest.ComputeHash(file));
            bytes += file.Length; sizes.Add(file.Length); hashes.Add(hash);
        }
    }
    internal bool Contains(string image)
    {
        if (String.IsNullOrEmpty(image) || !Path.IsPathRooted(image)) throw new DriverFault("TARGET_UNAVAILABLE");
        string full = Path.GetFullPath(image);
        if (roots.Any(root => Below(full, root))) return true;
        // Attribute-only size lookup permits junctions and unreadable packaged images
        // unless their size could actually match one of our hosts.
        if (!sizes.Contains(new FileInfo(full).Length)) return false;
        using (var file = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            if (!sizes.Contains(file.Length)) return false;
            using (var digest = SHA256.Create()) return hashes.Contains(Convert.ToBase64String(digest.ComputeHash(file)));
        }
    }
}
}
