// Original Win32 gate implementation. .NET Framework 4.8, C# 5, no vendor source.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

namespace Sleight.Cursor
{
public static class BrowserGate
{
    const uint ReadControl = 0x20000, Attributes = 0x80, Reparse = 0x200000, Backup = 0x2000000;
    const string SystemSid = "S-1-5-18", AdminSid = "S-1-5-32-544";
    const string Installer = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
    // FILETIME fields inside BY_HANDLE_FILE_INFORMATION are DWORD aligned, not 8-byte aligned.
    [StructLayout(LayoutKind.Sequential, Pack = 4)] struct HandleInfo
    {
        public uint Attributes; public long Created, Accessed, Written; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out HandleInfo info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle h, StringBuilder name, uint length, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetDriveType(string root);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint QueryDosDevice(string name, StringBuilder target, int length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool GetVolumeInformation(string root, StringBuilder name, int n, out uint serial, out uint max, out uint flags, StringBuilder fs, int f);
    [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle h, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("advapi32.dll")] static extern bool GetAce(IntPtr acl, int index, out IntPtr ace);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
    [DllImport("kernel32.dll", SetLastError = true)] static extern SafeFileHandle OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(SafeFileHandle process, out long created, out long ended, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(SafeFileHandle process, uint flags, StringBuilder image, ref uint length);
    [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(SafeFileHandle handle, uint milliseconds);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(SafeFileHandle process, uint access, out SafeFileHandle token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(SafeFileHandle token, int kind, IntPtr buffer, uint length, out uint needed);
    [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int kind, uint reserved);
    [StructLayout(LayoutKind.Sequential)] struct TrustFile { public uint Size; public IntPtr Path, File, Subject; }
    [StructLayout(LayoutKind.Sequential)] struct TrustData
    {
        public uint Size; public IntPtr Policy, Sip; public uint Ui, Revocation, Choice; public IntPtr File; public uint StateAction;
        public IntPtr State, Url; public uint Flags, Context; public IntPtr SignatureSettings;
    }
    [DllImport("wintrust.dll", ExactSpelling = true)] static extern int WinVerifyTrust(IntPtr hwnd, ref Guid action, ref TrustData data);
    static void Need(bool ok) { if (!ok) throw new IOException("WINDOWS_GATE_UNPROVED"); }
    public static string PathValue(object value)
    {
        string p = J.S(value);
        Need(p.Length >= 4 && p.Length <= 4096 && Regex.IsMatch(p, @"\A[A-Za-z]:\\") && !p.Substring(2).Contains(":") &&
            !Regex.IsMatch(p, "[\\x00-\\x1f<>\"|?*/~]") && Path.GetFullPath(p) == p &&
            p.Substring(3).Split('\\').All(part => part.Length > 0 && !part.EndsWith(".") && !part.EndsWith(" ")));
        return p;
    }
    static string Final(SafeFileHandle h)
    {
        var b = new StringBuilder(32768); uint n = GetFinalPathNameByHandle(h, b, (uint)b.Capacity, 0);
        Need(n > 0 && n < b.Capacity && b.ToString().StartsWith(@"\\?\")); return b.ToString().Substring(4);
    }
    static HandleInfo Info(SafeFileHandle h) { HandleInfo i; Need(GetFileInformationByHandle(h, out i)); Need((i.Attributes & 0x400) == 0); return i; }
    static string Identity(HandleInfo i) { return i.Volume + ":" + i.IndexHigh + ":" + i.IndexLow; }
    static void CheckLabel(SafeFileHandle h)
    {
        IntPtr owner, group, dacl, sacl, sd;
        // LABEL_SECURITY_INFORMATION needs READ_CONTROL, not the privileged full SACL right.
        Need(GetSecurityInfo(h, 1, 16, out owner, out group, out dacl, out sacl, out sd) == 0);
        try {
            if (sacl == IntPtr.Zero) return; // An unlabeled object has implicit medium integrity.
            int count = (ushort)Marshal.ReadInt16(sacl, 4); Need(count <= 256);
            for (int n = 0; n < count; n++) {
                IntPtr ace; Need(GetAce(sacl, n, out ace)); Need(Marshal.ReadByte(ace) == 17 && (ushort)Marshal.ReadInt16(ace, 2) >= 20);
                string sid = new SecurityIdentifier(IntPtr.Add(ace, 8)).Value;
                uint level; Need(sid.StartsWith("S-1-16-") && UInt32.TryParse(sid.Substring(7), out level));
                Need(UInt32.Parse(sid.Substring(7)) >= 8192 && (Marshal.ReadInt32(ace, 4) & 1) != 0);
            }
        } finally { LocalFree(sd); }
    }
    static RawSecurityDescriptor Descriptor(SafeFileHandle h)
    {
        CheckLabel(h);
        IntPtr owner, group, dacl, sacl, sd;
        Need(GetSecurityInfo(h, 1, 5, out owner, out group, out dacl, out sacl, out sd) == 0);
        try { uint n = GetSecurityDescriptorLength(sd); Need(n > 0 && n <= 65536); var bytes = new byte[n]; Marshal.Copy(sd, bytes, 0, (int)n); return new RawSecurityDescriptor(bytes, 0); }
        finally { LocalFree(sd); }
    }
    // sleight-created state: explicit protected DACL, only the token user and SYSTEM.
    public static bool StrictPrivateAcl(RawSecurityDescriptor sd, string user)
    { return FileAcl(sd, user, false, false); }
    // Browser-created files: inherited ACEs are allowed, writers are user, SYSTEM or Administrators.
    public static bool BrowserFileAcl(RawSecurityDescriptor sd, string user)
    { return FileAcl(sd, user, false, true); }
    public static bool ParentAcl(RawSecurityDescriptor sd, string user)
    { return FileAcl(sd, user, true, false); }
    static bool FileAcl(RawSecurityDescriptor sd, string user, bool parent, bool browser)
    {
        var trusted = new[] { user, SystemSid, AdminSid, Installer };
        if (sd.Owner == null || !(parent ? trusted.Contains(sd.Owner.Value) : sd.Owner.Value == user) || sd.DiscretionaryAcl == null || sd.DiscretionaryAcl.Count == 0 ||
            !parent && !browser && (sd.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0) return false;
        bool userRead = false;
        foreach (GenericAce raw in sd.DiscretionaryAcl)
        {
            var ace = raw as CommonAce;
            if (ace == null || ace.IsCallback || (ace.AceQualifier != AceQualifier.AccessAllowed && ace.AceQualifier != AceQualifier.AccessDenied)) return false;
            if ((parent || browser) && (ace.AceFlags & AceFlags.InheritOnly) != 0) continue;
            if (!parent && !browser && ((ace.AceFlags & (AceFlags.Inherited | AceFlags.InheritOnly)) != 0 ||
                ace.SecurityIdentifier.Value != user && ace.SecurityIdentifier.Value != SystemSid)) return false;
            if (browser && ace.AceQualifier == AceQualifier.AccessAllowed &&
                !new[] { user, SystemSid, AdminSid }.Contains(ace.SecurityIdentifier.Value) &&
                ((uint)ace.AccessMask & 0x500d0156u) != 0) return false;
            // A broad parent's DELETE_CHILD can replace a protected child. Generic bits count as writes too.
            if (parent && ace.AceQualifier == AceQualifier.AccessAllowed && !trusted.Contains(ace.SecurityIdentifier.Value) &&
                ((uint)ace.AccessMask & 0x500d0040u) != 0) return false;
            if (!parent && ace.AceQualifier == AceQualifier.AccessAllowed && ace.SecurityIdentifier.Value == user &&
                ((uint)ace.AccessMask & 0x80000001u) != 0) userRead = true;
        }
        return parent || browser || userRead;
    }
    static string AclKey(RawSecurityDescriptor sd) { return sd.GetSddlForm(AccessControlSections.Owner | AccessControlSections.Access); }
    static uint Volume(string p)
    {
        string root = p.Substring(0, 3); Need(GetDriveType(root) == 3);
        var device = new StringBuilder(1024); Need(QueryDosDevice(root.Substring(0, 2), device, device.Capacity) > 0 &&
            Regex.IsMatch(device.ToString(), @"\A\\Device\\HarddiskVolume[0-9]+\z"));
        uint serial, max, flags; var fs = new StringBuilder(64);
        Need(GetVolumeInformation(root, null, 0, out serial, out max, out flags, fs, fs.Capacity) && fs.ToString() == "NTFS" && (flags & 8) != 0);
        return serial;
    }
    public static Dictionary<string, object> PrivateFile(string path, string kind, bool read, bool browser = false, bool coordinator = false)
    {
        Need(kind == "file" || kind == "directory"); Need(!read || kind == "file"); Need(!browser || kind == "file");
        Need(!browser || String.Equals(Path.GetFileName(path), "DevToolsActivePort", StringComparison.OrdinalIgnoreCase));
        Need(!coordinator || !read && !browser && kind == "file" && String.Equals(path,
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "sleight", "leases", ".coordinator.sqlite"), StringComparison.OrdinalIgnoreCase));
        string user = WindowsIdentity.GetCurrent().User.Value; uint volume = Volume(path);
        var handles = new List<SafeFileHandle>(); var keys = new List<string>(); var ids = new List<string>();
        string text = null; HandleInfo target = new HandleInfo();
        try
        {
            var chain = new List<string>(); for (string p = path; p != null; p = Path.GetDirectoryName(p)) chain.Add(p); chain.Reverse();
            foreach (string p in chain)
            {
                bool leaf = p == path;
                // 0x1 is FILE_LIST_DIRECTORY on parents, FILE_READ_DATA on files. It engages share access.
                // Parents and strict files share READ only. The browser leaf also shares WRITE so polling
                // cannot block Chrome's writer. No component shares DELETE; content and ACLs are rechecked.
                uint share = leaf && read && browser ? 3u : 1u;
                // SQLite retains a write handle. This metadata-only proof still
                // checks the strict DACL and excludes DELETE sharing.
                if (leaf && coordinator) share = 3u;
                var h = CreateFile(p, ReadControl | Attributes | 1u | (leaf && read ? 0x80000000u : 0), share, IntPtr.Zero, 3, Reparse | Backup, IntPtr.Zero);
                handles.Add(h); Need(!h.IsInvalid);
                var i = Info(h); Need(i.Volume == volume && String.Equals(Final(h), p, StringComparison.OrdinalIgnoreCase));
                Need(leaf ? ((i.Attributes & 16) != 0) == (kind == "directory") && (kind != "file" || i.Links == 1) : (i.Attributes & 16) != 0);
                var acl = Descriptor(h); Need(leaf ? browser ? BrowserFileAcl(acl, user) : StrictPrivateAcl(acl, user) : ParentAcl(acl, user));
                keys.Add(AclKey(acl)); ids.Add(Identity(i)); target = i;
            }
            if (read)
            {
                Need(target.SizeHigh == 0 && target.SizeLow > 0 && target.SizeLow <= 512);
                using (var stream = new FileStream(handles.Last(), FileAccess.Read, 512, false)) {
                    var bytes = new byte[target.SizeLow]; Need(stream.Read(bytes, 0, bytes.Length) == bytes.Length && stream.ReadByte() == -1);
                    text = new UTF8Encoding(false, true).GetString(bytes);
                    var after = Info(handles.Last()); Need(after.Written == target.Written && after.SizeHigh == target.SizeHigh && after.SizeLow == target.SizeLow && Identity(after) == Identity(target));
                    // FileStream owns the target handle, so revalidate it before leaving its scope.
                    Need(keys.Last() == AclKey(Descriptor(handles.Last())));
                }
            }
            for (int n = 0; n < handles.Count - (read ? 1 : 0); n++) Need(ids[n] == Identity(Info(handles[n])) && keys[n] == AclKey(Descriptor(handles[n])));
            Need(volume == Volume(path));
            return J.Map("path", path, "kind", kind, "volume", volume, "fileId", ids.Last(), "text", text,
                "mtime", (target.Written - 116444736000000000L) / 10000, "parents", handles.Count - 1);
        }
        finally { foreach (var h in handles) h.Dispose(); }
    }
    static IntPtr TokenData(SafeFileHandle token, int kind)
    {
        uint n; GetTokenInformation(token, kind, IntPtr.Zero, 0, out n); Need(n > 0 && n < 65536);
        IntPtr b = Marshal.AllocHGlobal((int)n);
        if (!GetTokenInformation(token, kind, b, n, out n)) { Marshal.FreeHGlobal(b); Need(false); }
        return b;
    }
    public static void NormalUser()
    {
        using (var p = OpenProcess(0x1000, false, GetCurrentProcessId())) { Need(!p.IsInvalid); TokenSid(p); }
    }
    static string TokenSid(SafeFileHandle process)
    {
        SafeFileHandle token; Need(OpenProcessToken(process, 8, out token));
        using (token) {
            IntPtr b = TokenData(token, 25);
            try { string integrity = new SecurityIdentifier(Marshal.ReadIntPtr(b)).Value; Need(integrity == "S-1-16-8192"); }
            finally { Marshal.FreeHGlobal(b); }
            b = TokenData(token, 29); try { Need(Marshal.ReadInt32(b) == 0); } finally { Marshal.FreeHGlobal(b); }
            b = TokenData(token, 1); try { return new SecurityIdentifier(Marshal.ReadIntPtr(b)).Value; } finally { Marshal.FreeHGlobal(b); }
        }
    }
    static void Publisher(string path, SafeFileHandle executable)
    {
        var names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
            { "chrome.exe", "Google LLC" }, { "msedge.exe", "Microsoft Corporation" }, { "brave.exe", "Brave Software, Inc." } };
        Need(names.ContainsKey(Path.GetFileName(path)));
        IntPtr name = Marshal.StringToCoTaskMemUni(path), file = IntPtr.Zero;
        var data = new TrustData(); var action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        try {
            var f = new TrustFile { Size = (uint)Marshal.SizeOf(typeof(TrustFile)), Path = name, File = executable.DangerousGetHandle() };
            file = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TrustFile))); Marshal.StructureToPtr(f, file, false);
            data = new TrustData { Size = (uint)Marshal.SizeOf(typeof(TrustData)), Ui = 2, Choice = 1, File = file, StateAction = 1, Flags = 0x1000 };
            Need(WinVerifyTrust(new IntPtr(-1), ref action, ref data) == 0);
            using (var cert = new X509Certificate2(X509Certificate.CreateFromSignedFile(path)))
                Need(cert.GetNameInfo(X509NameType.SimpleName, false) == names[Path.GetFileName(path)] &&
                    cert.SubjectName.Decode(X500DistinguishedNameFlags.UseNewLines).Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).Select(s => s.Trim()).Any(s => s == "O=" + names[Path.GetFileName(path)] || s == "O=\"" + names[Path.GetFileName(path)] + "\""));
        } finally { if (file != IntPtr.Zero) { data.StateAction = 2; WinVerifyTrust(new IntPtr(-1), ref action, ref data); Marshal.FreeHGlobal(file); } Marshal.FreeCoTaskMem(name); }
    }
    // Retry a growing table once. The second read is still bounded and fails closed on another growth.
    delegate uint TcpTableRead(IntPtr table, ref int size, bool sorted, int family, int tableClass, uint reserved);
    static IntPtr TcpTable(int family, int tableClass, out int size, TcpTableRead read = null)
    {
        if (read == null) read = GetExtendedTcpTable;
        size = 0; uint rc = read(IntPtr.Zero, ref size, false, family, tableClass, 0);
        Need(rc == 122 && size >= 4 && size <= 16 * 1024 * 1024);
        for (int attempt = 0; attempt < 2; attempt++) {
            int capacity = size; IntPtr b = Marshal.AllocHGlobal(capacity);
            rc = read(b, ref size, false, family, tableClass, 0);
            if (rc == 0 && size >= 4 && size <= capacity) return b;
            Marshal.FreeHGlobal(b);
            Need(rc == 122 && attempt == 0 && size > capacity && size <= 16 * 1024 * 1024);
        }
        throw new IOException("WINDOWS_GATE_UNPROVED");
    }
    static int Port(IntPtr row, int offset) { return (Marshal.ReadByte(row, offset) << 8) | Marshal.ReadByte(row, offset + 1); }
    static bool Loopback(IntPtr row, int family, bool remote)
    {
        int offset = family == 2 ? remote ? 12 : 4 : remote ? 24 : 0;
        return family == 2 ? Marshal.ReadByte(row, offset) == 127 && Enumerable.Range(1, 2).All(n => Marshal.ReadByte(row, offset + n) == 0) && Marshal.ReadByte(row, offset + 3) == 1 :
            Enumerable.Range(0, 15).All(n => Marshal.ReadByte(row, offset + n) == 0) && Marshal.ReadByte(row, offset + 15) == 1 && Marshal.ReadInt32(row, offset + 16) == 0;
    }
    // Inspect every listener at the selected port in both families. Wildcard, foreign and mixed owners refuse.
    public static int Listeners(int port, uint pid)
    {
        int matches = 0;
        foreach (int family in new[] { 2, 23 })
        {
            int size; IntPtr b = TcpTable(family, 3, out size);
            try {
                int count = Marshal.ReadInt32(b), stride = family == 2 ? 24 : 56;
                Need(count >= 0 && count <= (size - 4) / stride);
                for (int i = 0; i < count; i++) {
                    IntPtr row = IntPtr.Add(b, 4 + i * stride); int offset = family == 2 ? 8 : 20;
                    if (Port(row, offset) != port) continue;
                    uint owner = unchecked((uint)Marshal.ReadInt32(row, family == 2 ? 20 : 52));
                    Need(owner == pid && Loopback(row, family, false)); matches++;
                }
            } finally { Marshal.FreeHGlobal(b); }
        }
        Need(matches > 0); return matches;
    }
    // The server-side ESTABLISHED row binds the accepted socket, even after a foreign listener disappears.
    public static int ConnectionOwner(int port, int localPort, string address, uint pid)
    {
        Need(address == "127.0.0.1" || address == "::1");
        int family = address == "127.0.0.1" ? 2 : 23, size, matches = 0;
        IntPtr b = TcpTable(family, 4, out size);
        try {
            int stride = family == 2 ? 24 : 56, count = Marshal.ReadInt32(b);
            Need(count >= 0 && count <= (size - 4) / stride);
            for (int i = 0; i < count; i++) {
                IntPtr row = IntPtr.Add(b, 4 + i * stride);
                if (Port(row, family == 2 ? 8 : 20) != port || Port(row, family == 2 ? 16 : 44) != localPort) continue;
                Need(Marshal.ReadInt32(row, family == 2 ? 0 : 48) == 5 && Loopback(row, family, false) && Loopback(row, family, true) &&
                    unchecked((uint)Marshal.ReadInt32(row, family == 2 ? 20 : 52)) == pid);
                matches++;
            }
        } finally { Marshal.FreeHGlobal(b); }
        Need(matches == 1); return matches;
    }
    public static object Peer(Dictionary<string, object> d)
    {
        J.Keys(d, "nonce op pid application start ownerSid sessionId port", "incarnation connection");
        uint pid = (uint)J.Integer(d["pid"], 1, Int32.MaxValue), session = 0, mine = 0;
        long expected = J.Integer(d["start"], 1, 9007199254740991); int port = (int)J.Integer(d["port"], 1, 65535);
        string path = PathValue(d["application"]), sid = J.S(d["ownerSid"]);
        Need(sid == WindowsIdentity.GetCurrent().User.Value && ProcessIdToSessionId(pid, out session) && ProcessIdToSessionId(GetCurrentProcessId(), out mine) && session == mine && session == J.Integer(d["sessionId"], 0, Int32.MaxValue));
        using (var process = OpenProcess(0x1000 | 0x100000, false, pid)) {
            Need(!process.IsInvalid); long created, ended, kernel, user;
            Need(GetProcessTimes(process, out created, out ended, out kernel, out user) && WaitForSingleObject(process, 0) == 258 && (created - 116444736000000000L) / 10000 == expected);
            string incarnation = "p" + pid + "-t" + created;
            Need(!d.ContainsKey("incarnation") || J.S(d["incarnation"]) == incarnation);
            var image = new StringBuilder(32768); uint length = (uint)image.Capacity;
            Need(QueryFullProcessImageName(process, 0, image, ref length) && String.Equals(image.ToString(), path, StringComparison.OrdinalIgnoreCase) && TokenSid(process) == sid);
            using (var executable = CreateFile(path, 0x80000000u, 1, IntPtr.Zero, 3, Reparse, IntPtr.Zero)) {
                Need(!executable.IsInvalid); Info(executable); Need(String.Equals(Final(executable), path, StringComparison.OrdinalIgnoreCase)); Volume(path); Publisher(path, executable);
                Need(String.Equals(Final(executable), path, StringComparison.OrdinalIgnoreCase));
                int listeners = Listeners(port, pid); long after;
                Need(GetProcessTimes(process, out after, out ended, out kernel, out user) && after == created && WaitForSingleObject(process, 0) == 258);
                object connection = null;
                if (d.ContainsKey("connection")) {
                    var c = J.D(d["connection"]); J.Keys(c, "localPort address");
                    int localPort = (int)J.Integer(c["localPort"], 1, 65535); string address = J.S(c["address"]);
                    connection = J.Map("localPort", localPort, "address", address, "pid", pid, "matches", ConnectionOwner(port, localPort, address, pid));
                    Need(WaitForSingleObject(process, 0) == 258);
                }
                return J.Map("pid", pid, "application", path, "start", expected, "ownerSid", sid, "sessionId", session, "port", port, "incarnation", incarnation, "listeners", listeners, "publisher", true, "connection", connection);
            }
        }
    }
    public static Dictionary<string, object> ReadRequest()
    {
        using (var stream = Console.OpenStandardInput()) using (var bytes = new MemoryStream()) {
            int c; while ((c = stream.ReadByte()) >= 0) { Need(bytes.Length < 65536); bytes.WriteByte((byte)c); }
            string text = new UTF8Encoding(false, true).GetString(bytes.ToArray());
            var d = J.D(J.Serializer.DeserializeObject(text)); Need(Regex.IsMatch(J.S(d["nonce"]), @"\A[a-f0-9]{64}\z")); return d;
        }
    }
    public static void Run()
    {
        var d = ReadRequest(); NormalUser(); object result;
        if (J.S(d["op"]) == "peer") result = Peer(d);
        else {
            J.Keys(d, "nonce op path kind"); string op = J.S(d["op"]);
            Need(new[] { "private-file", "read-private-file", "browser-file", "read-browser-file", "lease-coordinator" }.Contains(op));
            result = PrivateFile(PathValue(d["path"]), J.S(d["kind"]), op.StartsWith("read-"), op.EndsWith("browser-file"), op == "lease-coordinator");
        }
        Program.Write(J.Map("nonce", d["nonce"], "ok", true, "evidence", result));
    }
    public static void SelfTest()
    {
        string user = "S-1-5-21-1-2-3-1000";
        string good = "O:" + user + "D:P(A;;FA;;;" + user + ")(A;;FA;;;SY)";
        var cases = new Dictionary<string, bool>();
        int reads = 0, tableSize;
        TcpTableRead growsOnce = delegate(IntPtr b, ref int size, bool sorted, int family, int tableClass, uint reserved) {
            reads++; if (b == IntPtr.Zero) { size = 4; return 122; }
            if (reads == 2) { size = 28; return 122; }
            Marshal.WriteInt32(b, 0); return 0;
        };
        IntPtr grown = TcpTable(2, 4, out tableSize, growsOnce);
        try { cases["tcp-table-grow-once"] = reads == 3 && tableSize == 28; } finally { Marshal.FreeHGlobal(grown); }
        reads = 0;
        TcpTableRead keepsGrowing = delegate(IntPtr b, ref int size, bool sorted, int family, int tableClass, uint reserved) {
            reads++; size = reads * 28; return 122;
        };
        try { grown = TcpTable(2, 4, out tableSize, keepsGrowing); Marshal.FreeHGlobal(grown); cases["tcp-table-growth-bounded"] = false; }
        catch { cases["tcp-table-growth-bounded"] = reads == 3; }
        cases["private"] = StrictPrivateAcl(new RawSecurityDescriptor(good), user);
        cases["broad"] = !StrictPrivateAcl(new RawSecurityDescriptor(good + "(A;;FR;;;WD)"), user);
        cases["unprotected"] = !StrictPrivateAcl(new RawSecurityDescriptor(good.Replace("D:P", "D:")), user);
        cases["owner"] = !StrictPrivateAcl(new RawSecurityDescriptor(good.Replace("O:" + user, "O:BA")), user);
        cases["parent-delete"] = !ParentAcl(new RawSecurityDescriptor("O:SYD:(A;;FA;;;SY)(A;;DC;;;WD)"), user);
        cases["null-dacl"] = !StrictPrivateAcl(new RawSecurityDescriptor("O:" + user), user);
        cases["inherited"] = !StrictPrivateAcl(new RawSecurityDescriptor(good.Replace("(A;;FA", "(A;ID;FA")), user);
        string inherited = good.Replace("D:P", "D:").Replace("(A;;FA", "(A;ID;FA") + "(A;ID;FA;;;BA)(A;ID;FR;;;WD)";
        cases["browser-inherited"] = BrowserFileAcl(new RawSecurityDescriptor(inherited), user);
        cases["strict-refuses-browser"] = !StrictPrivateAcl(new RawSecurityDescriptor(inherited), user);
        cases["browser-foreign-owner"] = !BrowserFileAcl(new RawSecurityDescriptor(inherited.Replace("O:" + user, "O:BA")), user);
        cases["browser-null-dacl"] = !BrowserFileAcl(new RawSecurityDescriptor("O:" + user), user);
        foreach (string right in new[] { "GW", "GA", "WD", "WO", "SD", "DC", "0x2", "0x4", "0x10", "0x100" })
            cases["browser-broad-" + right] = !BrowserFileAcl(new RawSecurityDescriptor(inherited + "(A;ID;" + right + ";;;WD)"), user);
        cases["browser-installer-write"] = !BrowserFileAcl(new RawSecurityDescriptor(inherited + "(A;;FA;;;" + Installer + ")"), user);
        cases["browser-empty-dacl"] = !BrowserFileAcl(new RawSecurityDescriptor("O:" + user + "D:"), user);
        var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
        try { int port = ((IPEndPoint)listener.LocalEndpoint).Port; cases["listener"] = Listeners(port, GetCurrentProcessId()) > 0;
            try { Listeners(port, GetCurrentProcessId() + 1); cases["foreign-pid"] = false; } catch { cases["foreign-pid"] = true; }
            using (var client = new TcpClient()) {
                client.Connect(IPAddress.Loopback, port);
                using (var accepted = listener.AcceptTcpClient()) {
                    int localPort = ((IPEndPoint)client.Client.LocalEndPoint).Port;
                    cases["accepted-connection"] = ConnectionOwner(port, localPort, "127.0.0.1", GetCurrentProcessId()) == 1;
                    try { ConnectionOwner(port, localPort, "127.0.0.1", GetCurrentProcessId() + 1); cases["accepted-foreign-pid"] = false; } catch { cases["accepted-foreign-pid"] = true; }
                    try { ConnectionOwner(port, port, "127.0.0.1", GetCurrentProcessId()); cases["accepted-wrong-tuple"] = false; } catch { cases["accepted-wrong-tuple"] = true; }
                }
            }
        } finally { listener.Stop(); }
        cases["layout"] = Marshal.SizeOf(typeof(HandleInfo)) == 52;
        cases["trust-layout"] = Marshal.SizeOf(typeof(TrustData)) == (IntPtr.Size == 8 ? 88 : 52);
        cases["trust-file-layout"] = Marshal.SizeOf(typeof(TrustFile)) == (IntPtr.Size == 8 ? 32 : 16);
        NormalUser();
        string root = Path.Combine(Path.GetTempPath(), "sleight-gate-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try {
            var owner = WindowsIdentity.GetCurrent().User;
            var directoryAcl = new DirectorySecurity(); directoryAcl.SetOwner(owner); directoryAcl.SetAccessRuleProtection(true, false);
            directoryAcl.AddAccessRule(new FileSystemAccessRule(owner, FileSystemRights.FullControl, AccessControlType.Allow));
            directoryAcl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(SystemSid), FileSystemRights.FullControl, AccessControlType.Allow));
            // A browser writes a default-security child that inherits this protected directory's safe ACEs.
            var browserDirectoryAcl = new DirectorySecurity(); browserDirectoryAcl.SetOwner(owner); browserDirectoryAcl.SetAccessRuleProtection(true, false);
            foreach (var sid in new[] { owner, new SecurityIdentifier(SystemSid), new SecurityIdentifier(AdminSid) })
                browserDirectoryAcl.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            Directory.SetAccessControl(root, browserDirectoryAcl);
            string browserFile = Path.Combine(root, "DevToolsActivePort"); File.WriteAllText(browserFile, "9222\n/devtools/browser/test\n", new UTF8Encoding(false));
            cases["handle-browser-inherited"] = PrivateFile(browserFile, "file", true, true)["text"].Equals("9222\n/devtools/browser/test\n");
            using (var writer = new FileStream(browserFile, FileMode.Open, FileAccess.Write, FileShare.ReadWrite))
                cases["handle-browser-writer"] = PrivateFile(browserFile, "file", true, true)["text"].Equals("9222\n/devtools/browser/test\n");
            string otherFile = Path.Combine(root, "hand.json"); File.Copy(browserFile, otherFile);
            try { PrivateFile(otherFile, "file", true, true); cases["handle-browser-other-name"] = false; } catch { cases["handle-browser-other-name"] = true; }
            File.Delete(otherFile);
            try { PrivateFile(browserFile, "file", true); cases["handle-browser-strict-refused"] = false; } catch { cases["handle-browser-strict-refused"] = true; }
            File.Delete(browserFile);
            Directory.SetAccessControl(root, directoryAcl);
            string file = Path.Combine(root, "port"); File.WriteAllText(file, "9222\n/devtools/browser/test\n", new UTF8Encoding(false));
            var fileAcl = new FileSecurity(); fileAcl.SetOwner(owner); fileAcl.SetAccessRuleProtection(true, false);
            fileAcl.AddAccessRule(new FileSystemAccessRule(owner, FileSystemRights.FullControl, AccessControlType.Allow));
            fileAcl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(SystemSid), FileSystemRights.FullControl, AccessControlType.Allow));
            File.SetAccessControl(file, fileAcl);
            cases["handle-file"] = PrivateFile(file, "file", true)["text"].Equals("9222\n/devtools/browser/test\n");
            cases["handle-directory"] = PrivateFile(root, "directory", false)["kind"].Equals("directory");
            fileAcl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-1-0"), FileSystemRights.Read, AccessControlType.Allow));
            File.SetAccessControl(file, fileAcl);
            try { PrivateFile(file, "file", false); cases["file-acl-edit"] = false; } catch { cases["file-acl-edit"] = true; }
            fileAcl.RemoveAccessRuleAll(new FileSystemAccessRule(new SecurityIdentifier("S-1-1-0"), FileSystemRights.Read, AccessControlType.Allow));
            File.SetAccessControl(file, fileAcl);
            directoryAcl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier("S-1-1-0"), FileSystemRights.DeleteSubdirectoriesAndFiles, AccessControlType.Allow));
            Directory.SetAccessControl(root, directoryAcl);
            try { PrivateFile(file, "file", false); cases["parent-acl-edit"] = false; } catch { cases["parent-acl-edit"] = true; }
        } finally { Directory.Delete(root, true); }
        Need(cases.Values.All(x => x)); Program.Write(J.Map("ok", true, "cases", cases));
    }
}
}
