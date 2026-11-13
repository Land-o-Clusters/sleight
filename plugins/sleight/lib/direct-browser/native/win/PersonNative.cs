using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Security.AccessControl;
using System.Text;

namespace Sleight.Person
{
// All observations come from Win32 handles. No environment-selected roots, commands or process names are trusted.
internal static class Native
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry
    {
        public uint Size, Usage, Pid;
        public UIntPtr Heap;
        public uint Module, Threads, Parent;
        public int Priority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
    }
    [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint Size, Tick; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WtsLevel1
    {
        public uint Session;
        public int State, Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 33)] public string Station;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 21)] public string User;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 18)] public string Domain;
        public long Logon, Connect, Disconnect, LastInput, Current;
        public uint InBytes, OutBytes, InFrames, OutFrames, InCompressed, OutCompressed;
    }
    [StructLayout(LayoutKind.Sequential)] struct WtsInfoEx { public uint Level; public WtsLevel1 Data; }
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] internal static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long birth, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetSystemDirectoryW(StringBuilder buffer, uint size);
    [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll")] internal static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll")] static extern uint GetConsoleProcessList([Out] uint[] processes, uint count);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput input);
    [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool WTSQuerySessionInformationW(IntPtr server, uint session, int infoClass, out IntPtr data, out uint bytes);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr data);

    internal static Dictionary<string, object> Map(params object[] pairs)
    {
        var result = new Dictionary<string, object>();
        for (int i = 0; i < pairs.Length; i += 2) result.Add((string)pairs[i], pairs[i + 1]);
        return result;
    }
    static void Require(bool value) { if (!value) throw new InvalidOperationException("PERSON_OBSERVATION_UNAVAILABLE"); }
    internal static uint Session(uint pid) { uint session; Require(ProcessIdToSessionId(pid, out session)); return session; }
    static string ProgramFiles()
    {
        var id = new Guid("905e63b6-c1bf-494e-b29c-65b732d3d21a"); // FOLDERID_ProgramFiles, native host architecture
        IntPtr buffer;
        Marshal.ThrowExceptionForHR(SHGetKnownFolderPath(ref id, 0, IntPtr.Zero, out buffer));
        try { return Marshal.PtrToStringUni(buffer); } finally { Marshal.FreeCoTaskMem(buffer); }
    }
    static string System32()
    {
        var buffer = new StringBuilder(32768);
        uint size = GetSystemDirectoryW(buffer, (uint)buffer.Capacity);
        Require(size > 0 && size < buffer.Capacity);
        return buffer.ToString();
    }
    static bool WindowsTerminal(string image)
    {
        var pattern = "\\A" + System.Text.RegularExpressions.Regex.Escape(Path.Combine(ProgramFiles(), "WindowsApps") + "\\") +
            @"Microsoft\.WindowsTerminal(?:Preview)?_[0-9.]+_(?:x64|x86|arm64)__8wekyb3d8bbwe\\WindowsTerminal\.exe\z";
        return System.Text.RegularExpressions.Regex.IsMatch(image, pattern, System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    }
    // Program Files is obtained from the account/OS known folder API, never an environment variable.
    // Require an administrator-only writable path, including replacement rights on its parents.
    static bool AdminShell(string image)
    {
        if (!String.Equals(image, Path.Combine(ProgramFiles(), @"PowerShell\7\pwsh.exe"), StringComparison.OrdinalIgnoreCase)) return false;
        for (string at = image; at != null; at = Path.GetDirectoryName(at)) {
            Require((File.GetAttributes(at) & FileAttributes.ReparsePoint) == 0);
            bool file = String.Equals(at, image, StringComparison.OrdinalIgnoreCase);
            FileSystemSecurity acl = file ? (FileSystemSecurity)File.GetAccessControl(at) : Directory.GetAccessControl(at);
            var trusted = new[] { "S-1-5-18", "S-1-5-32-544", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464" };
            Require(acl.AreAccessRulesCanonical && trusted.Contains(acl.GetOwner(typeof(SecurityIdentifier)).Value));
            var rules = acl.GetAccessRules(true, true, typeof(SecurityIdentifier)); Require(rules.Count > 0);
            var write = FileSystemRights.Delete | FileSystemRights.DeleteSubdirectoriesAndFiles |
                FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership |
                (file ? FileSystemRights.Write : FileSystemRights.WriteData);
            foreach (FileSystemAccessRule rule in rules) {
                if ((rule.PropagationFlags & PropagationFlags.InheritOnly) != 0) continue;
                Require(rule.AccessControlType != AccessControlType.Allow || trusted.Contains(rule.IdentityReference.Value) || (rule.FileSystemRights & write) == 0);
            }
        }
        return true;
    }
    sealed class Observation : IDisposable
    {
        internal IntPtr Handle;
        internal long Birth;
        internal uint Pid, Parent, SessionId;
        internal string Image, Sid;
        internal Observation(uint pid, uint parent, Observation child = null)
        {
            Pid = pid; Parent = parent;
            Handle = OpenProcess(0x1000, false, pid); // QUERY_LIMITED_INFORMATION, never VM_READ
            try
            {
                Require(Handle != IntPtr.Zero);
                Birth = ReadBirth();
                var text = new StringBuilder(32768); uint size = (uint)text.Capacity;
                Require(QueryFullProcessImageNameW(Handle, 0, text, ref size));
                Image = text.ToString();
                SessionId = Session(pid);
                IntPtr token;
                if (OpenProcessToken(Handle, 8, out token)) { // TOKEN_QUERY
                    try { using (var identity = new WindowsIdentity(token)) Sid = identity.User.Value; }
                    finally { CloseHandle(token); }
                } else {
                    // A standard user's token query can fail on the SYSTEM activation service. Only this exact
                    // session-zero parent of a path-verified Terminal may use image, session and birth instead.
                    Require(child != null && child.Parent == pid && SessionId == 0 && Birth <= child.Birth &&
                        String.Equals(Image, Path.Combine(System32(), "svchost.exe"), StringComparison.OrdinalIgnoreCase) &&
                        WindowsTerminal(child.Image));
                    Sid = null;
                }
            }
            catch { Dispose(); throw; }
        }
        long ReadBirth() { long birth, exit, kernel, user; Require(GetProcessTimes(Handle, out birth, out exit, out kernel, out user) && exit == 0 && birth > 0); return birth; }
        internal object Row()
        {
            long after = ReadBirth();
            Require(after == Birth);
            // Open the named PID again as well: a held handle alone can refer to an exited/replaced PID.
            IntPtr current = OpenProcess(0x1000, false, Pid);
            try {
                long birth, exit, kernel, user;
                Require(current != IntPtr.Zero && GetProcessTimes(current, out birth, out exit, out kernel, out user) && exit == 0 && birth == Birth);
            } finally { if (current != IntPtr.Zero) CloseHandle(current); }
            return Map("pid", Pid, "parent", Parent, "birth", Birth.ToString(CultureInfo.InvariantCulture),
                "after", after.ToString(CultureInfo.InvariantCulture), "image", Image, "session", SessionId, "sid", Sid,
                "adminWritableOnly", AdminShell(Image));
        }
        public void Dispose() { if (Handle != IntPtr.Zero) { CloseHandle(Handle); Handle = IntPtr.Zero; } }
    }
    static Dictionary<uint, uint> Parents()
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
        Require(snapshot != new IntPtr(-1));
        try {
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
            Require(Process32FirstW(snapshot, ref entry));
            var rows = new Dictionary<uint, uint>();
            do { Require(!rows.ContainsKey(entry.Pid)); rows.Add(entry.Pid, entry.Parent); }
            while (Process32NextW(snapshot, ref entry));
            Require(Marshal.GetLastWin32Error() == 18); // ERROR_NO_MORE_FILES
            return rows;
        } finally { CloseHandle(snapshot); }
    }
    internal static object Snapshot(uint self)
    {
        // Pin self before taking Toolhelp, then pin each ancestor and compare births to its child.
        var held = new Dictionary<uint, Observation>();
        try {
            var first = new Observation(self, 0); held.Add(self, first);
            var parents = Parents();
            Require(parents.ContainsKey(self)); first.Parent = parents[self];
            uint at = first.Parent;
            var system = System32();
            var desktop = Path.Combine(Path.GetDirectoryName(system), "explorer.exe");
            var activation = Path.Combine(system, "svchost.exe");
            var child = first;
            for (int n = 0; ; n++) {
                Require(n < 64 && at > 0 && parents.ContainsKey(at) && !held.ContainsKey(at));
                var row = new Observation(at, parents[at], child); held.Add(at, row);
                Require(row.Birth <= child.Birth);
                if (String.Equals(row.Image, desktop, StringComparison.OrdinalIgnoreCase)) break;
                if (String.Equals(row.Image, activation, StringComparison.OrdinalIgnoreCase) &&
                    WindowsTerminal(child.Image)) break;
                child = row; at = row.Parent;
            }
            FreeConsole();
            Require(AttachConsole(self));
            var members = new uint[256];
            uint count = GetConsoleProcessList(members, (uint)members.Length);
            Require(count > 0 && count <= members.Length);
            uint consolePid = 0;
            Require(GetConsoleWindow() != IntPtr.Zero && GetWindowThreadProcessId(GetConsoleWindow(), out consolePid) != 0);
            Require(parents.ContainsKey(consolePid));
            if (!held.ContainsKey(consolePid)) held.Add(consolePid, new Observation(consolePid, parents[consolePid]));
            var rows = held.Values.Select(row => row.Row()).ToArray();
            return Map("schema", "sleight.person-snapshot/1", "self", self, "session", first.SessionId, "sid", first.Sid,
                "system32", system, "programFiles", ProgramFiles(), "now", DateTime.UtcNow.ToFileTimeUtc().ToString(CultureInfo.InvariantCulture),
                "rows", rows, "console", Map("pid", consolePid, "members", members.Take((int)count).ToArray()));
        } finally { foreach (var row in held.Values) row.Dispose(); }
    }
    internal static object Presence()
    {
        uint session = Session(GetCurrentProcessId());
        Require(session > 0);
        IntPtr buffer; uint bytes;
        Require(WTSQuerySessionInformationW(IntPtr.Zero, session, 25, out buffer, out bytes)); // WTSSessionInfoEx
        bool unlocked = false, active = false;
        try {
            Require(bytes >= Marshal.SizeOf(typeof(WtsInfoEx)));
            var info = (WtsInfoEx)Marshal.PtrToStructure(buffer, typeof(WtsInfoEx));
            Require(info.Level == 1 && info.Data.Session == session);
            unlocked = info.Data.Flags == 1; active = info.Data.State == 0; // WTSActive, UNLOCK on Win10/11
        } finally { WTSFreeMemory(buffer); }
        var input = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) };
        Require(GetLastInputInfo(ref input));
        // DWORD subtraction handles GetTickCount's 49.7-day wrap. A future/non-monotonic sample refuses as idle.
        uint idle = unchecked((uint)Environment.TickCount - input.Tick);
        return Map("schema", "sleight.person-presence/1", "active", active, "unlocked", unlocked, "idleMs", idle);
    }
    internal static bool Present()
    {
        try { var p = (Dictionary<string, object>)Presence(); return (bool)p["active"] && (bool)p["unlocked"] && (uint)p["idleMs"] < 120000; }
        catch { return false; }
    }
    internal static string LauncherSid()
    {
        uint self = GetCurrentProcessId();
        var parents = Parents(); Require(parents.ContainsKey(self));
        using (var row = new Observation(parents[self], 0)) {
            Require(row.SessionId == Session(self) && row.Sid == WindowsIdentity.GetCurrent().User.Value);
            row.Row(); // repeat incarnation proof while the process handle is held
            return row.Sid;
        }
    }
    internal static IntPtr ConfirmationOwner()
    {
        // Redirected stdio doesn't prove which console owns the launcher. Attach explicitly to our parent.
        var parents = Parents();
        uint self = (uint)Process.GetCurrentProcess().Id;
        if (!parents.ContainsKey(self)) return IntPtr.Zero;
        FreeConsole();
        if (!AttachConsole(parents[self])) return IntPtr.Zero;
        var console = GetConsoleWindow();
        var foreground = GetForegroundWindow();
        if (console == IntPtr.Zero || foreground == IntPtr.Zero) return IntPtr.Zero;
        uint pid;
        if (GetWindowThreadProcessId(foreground, out pid) == 0) return IntPtr.Zero;
        using (var row = new Observation(pid, 0)) {
            if (row.SessionId != Session(self) || row.Sid != WindowsIdentity.GetCurrent().User.Value) return IntPtr.Zero;
            if (foreground == console && String.Equals(row.Image, Path.Combine(System32(), "conhost.exe"), StringComparison.OrdinalIgnoreCase)) return foreground;
            // Under ConPTY GetConsoleWindow is a message-only HWND. Only a verified Windows Terminal foreground
            // window may own the system prompt. Its tab-to-console relationship remains a VM qualification gate.
            string apps = Path.Combine(ProgramFiles(), "WindowsApps") + "\\";
            if (!row.Image.StartsWith(apps, StringComparison.OrdinalIgnoreCase)) return IntPtr.Zero;
            string relative = row.Image.Substring(apps.Length);
            return System.Text.RegularExpressions.Regex.IsMatch(relative,
                @"\AMicrosoft\.WindowsTerminal(?:Preview)?_[0-9.]+_(?:x64|x86|arm64)__8wekyb3d8bbwe\\WindowsTerminal\.exe\z",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase) ? foreground : IntPtr.Zero;
        }
    }
}
}
