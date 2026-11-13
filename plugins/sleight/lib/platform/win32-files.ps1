# Settings, window leases and ACL operations only.
$ErrorActionPreference = 'Stop'
# Use private byte-stream readers/writers. Console encodings mutate the caller's code page.
$inputReader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.UTF8Encoding]::new($false, $true), $false)
$outputWriter = [IO.StreamWriter]::new([Console]::OpenStandardOutput(), [Text.UTF8Encoding]::new($false))
$outputWriter.AutoFlush = $true
$account = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$env:TEMP = [IO.Path]::Combine($account, 'Temp')
$env:TMP = $env:TEMP
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class SleightFiles {
  [StructLayout(LayoutKind.Sequential)] struct Info {
    public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string p, uint a, uint s, IntPtr sec, uint c, uint f, IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info i);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandle(SafeFileHandle h, System.Text.StringBuilder p, uint size, uint flags);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle h, int t, uint i, out IntPtr o, out IntPtr g, out IntPtr d, out IntPtr s, out IntPtr sd);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr sd);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  static string User { get { return WindowsIdentity.GetCurrent().User.Value; } }
  static bool Private(string sid) { return sid == User || sid == "S-1-5-18"; }
  static bool Trusted(string sid) { return Private(sid) || sid == "S-1-5-32-544"; }
  static bool Allowed(string sid, bool parent, bool sharedRoot) { return (parent || sharedRoot) ? Trusted(sid) : Private(sid); }
  static void Require(bool ok) { if (!ok) throw new IOException("WINDOWS_FILE_UNSAFE"); }
  static string Canonical(string p) {
    Require(p != null && p.Length > 3 && p.Length < 1024 && p[1] == ':' && p[2] == '\\' && Char.IsLetter(p[0]) &&
      p.IndexOf(':', 2) < 0 && p.IndexOf('/') < 0 && Path.GetFullPath(p) == p);
    foreach (string part in p.Substring(3).Split('\\')) Require(part.Length > 0 && !part.EndsWith(".") && !part.EndsWith(" "));
    return p;
  }
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool SetKernelObjectSecurity(SafeFileHandle h, uint flags, byte[] descriptor);
  static void Descriptor(SafeFileHandle h, bool parent, bool repair = false, bool sharedRoot = false) {
    IntPtr o, g, d, s, sd;
    Require(GetSecurityInfo(h, 1, 5, out o, out g, out d, out s, out sd) == 0);
    try {
      byte[] bytes = new byte[GetSecurityDescriptorLength(sd)]; Marshal.Copy(sd, bytes, 0, bytes.Length);
      DescriptorBytes(bytes, parent, repair, sharedRoot);
    } finally { LocalFree(sd); }
  }
  static void DescriptorBytes(byte[] bytes, bool parent, bool repair, bool sharedRoot) {
      RawSecurityDescriptor raw = new RawSecurityDescriptor(bytes, 0);
      Require(raw.Owner != null && (parent ? Trusted(raw.Owner.Value) || raw.Owner.Value == "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464" : raw.Owner.Value == User));
      if (repair) return; // Owner proved; repair only the DACL.
      Require(raw.DiscretionaryAcl != null && raw.DiscretionaryAcl.Count > 0);
      FileSecurity security = new FileSecurity(); security.SetSecurityDescriptorBinaryForm(bytes);
      Require(security.AreAccessRulesCanonical && (parent || security.AreAccessRulesProtected));
      bool own = false;
      foreach (GenericAce ace in raw.DiscretionaryAcl) {
        CommonAce rule = ace as CommonAce; Require(rule != null && !rule.IsCallback);
        if ((rule.AceFlags & AceFlags.InheritOnly) != 0) continue;
        if (rule.AceQualifier != AceQualifier.AccessAllowed) continue;
        if (rule.SecurityIdentifier.Value == User) own = true;
        // Parent replacement rights: DELETE, DELETE_CHILD, WRITE_DAC, WRITE_OWNER.
        Require(Allowed(rule.SecurityIdentifier.Value, parent, sharedRoot) || parent && (rule.AccessMask & 0xd0040) == 0);
      }
      Require(parent || own);
  }
  static SafeFileHandle Open(string p, bool directory, bool parent, bool contents = false, bool repair = false) {
    uint access = (contents ? 0x80020080u : 0x20080u) | (repair ? 0x40000u : 0u);
    SafeFileHandle h = CreateFile(p, access, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    try {
      Require(!h.IsInvalid); Info i; Require(GetFileInformationByHandle(h, out i));
      Require((i.Attributes & 0x400) == 0 && ((i.Attributes & 0x10) != 0) == directory && (directory || i.Links == 1));
      System.Text.StringBuilder final = new System.Text.StringBuilder(2048);
      uint length = GetFinalPathNameByHandle(h, final, 2048, 0);
      Require(length > 4 && length < 2048 && final.ToString().StartsWith("\\\\?\\") &&
        final.ToString().Substring(4).Equals(p, StringComparison.OrdinalIgnoreCase));
      bool sharedRoot = directory && p.Equals(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "sleight"), StringComparison.OrdinalIgnoreCase);
      Descriptor(h, parent, repair, sharedRoot); return h;
    } catch { h.Dispose(); throw; }
  }
  static List<SafeFileHandle> Parents(string p) {
    List<string> names = new List<string>(); string at = Path.GetDirectoryName(p);
    while (at != null) { names.Add(at); at = Path.GetDirectoryName(at); }
    names.Reverse(); List<SafeFileHandle> held = new List<SafeFileHandle>();
    try { foreach (string name in names) held.Add(Open(name, true, true)); return held; }
    catch { foreach (SafeFileHandle h in held) h.Dispose(); throw; }
  }
  static FileSecurity FileAcl() {
    FileSecurity acl = new FileSecurity(); acl.SetOwner(new SecurityIdentifier(User)); acl.SetAccessRuleProtection(true, false);
    foreach (string sid in new string[] {User, "S-1-5-18"}) acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, AccessControlType.Allow));
    return acl;
  }
  public static void Inspect(string path, bool directory) {
    Canonical(path); List<SafeFileHandle> held = Parents(path);
    try { using (SafeFileHandle h = Open(path, directory, false)) {} }
    finally { foreach (SafeFileHandle h in held) h.Dispose(); }
  }
  public static int Selftest() {
    Canonical("C:\\Users\\Person\\AppData\\Local\\sleight\\hand.json");
    string[] bad = {"relative.json", "\\\\server\\share\\file", "C:\\file:stream", "C:\\folder.\\file", "C:\\folder \\file", "C:\\folder\\..\\file"};
    foreach (string p in bad) {
      bool refused = false; try { Canonical(p); } catch { refused = true; }
      Require(refused);
    }
    Require(FileAcl().AreAccessRulesProtected);
    Require(Allowed("S-1-5-32-544", false, true));
    Require(!Allowed("S-1-5-32-544", false, false));
    Require(!Allowed("S-1-5-32-545", false, true));
    // Same protected owner and inheritable user/SYSTEM/Administrators ACEs as cache-access.ps1 create.
    RawSecurityDescriptor hostFolder = new RawSecurityDescriptor("O:" + User + "D:P(A;OICI;FA;;;" + User + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)");
    byte[] bytes = new byte[hostFolder.BinaryLength]; hostFolder.GetBinaryForm(bytes, 0);
    DescriptorBytes(bytes, false, false, true);
    bool leafRefused = false;
    try { DescriptorBytes(bytes, false, false, false); } catch { leafRefused = true; }
    Require(leafRefused);
    return bad.Length + 7;
  }
  public static string Lease(string operation, string path, string text, string root) {
    Canonical(path); Canonical(root);
    string directory = Path.Combine(root, "leases");
    bool init = operation == "lease-init";
    Require(init ? path.Equals(directory, StringComparison.OrdinalIgnoreCase) :
      Path.GetDirectoryName(path).Equals(directory, StringComparison.OrdinalIgnoreCase) &&
      System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(path), @"\A[a-f0-9]{64}\.json\z"));
    Require(init || operation == "lease-read" || operation == "lease-write");
    List<SafeFileHandle> held = Parents(root);
    try {
      if (!Directory.Exists(root)) {
        DirectorySecurity acl = new DirectorySecurity(); acl.SetOwner(new SecurityIdentifier(User)); acl.SetAccessRuleProtection(true, false);
        foreach (string sid in new string[] {User, "S-1-5-18", "S-1-5-32-544"}) acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        Directory.CreateDirectory(root, acl);
      }
      held.Add(Open(root, true, false));
      if (!Directory.Exists(directory)) {
        Require(init);
        DirectorySecurity acl = new DirectorySecurity(); acl.SetOwner(new SecurityIdentifier(User)); acl.SetAccessRuleProtection(true, false);
        foreach (string sid in new string[] {User, "S-1-5-18"}) acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        Directory.CreateDirectory(directory, acl);
      }
      held.Add(Open(directory, true, false));
      if (init) {
        string coordinator = Path.Combine(directory, ".coordinator.sqlite");
        if (!File.Exists(coordinator) && !Directory.Exists(coordinator)) {
          try { using (FileStream file = new FileStream(coordinator, FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.WriteThrough, FileAcl())) {} }
          catch (IOException) { if (!File.Exists(coordinator)) throw; }
        }
        using (SafeFileHandle handle = Open(coordinator, false, false)) {}
        return null;
      }
      if (File.Exists(path) || Directory.Exists(path)) using (SafeFileHandle handle = Open(path, false, false)) {}
      if (operation == "lease-read") {
        if (!File.Exists(path)) return null;
        using (SafeFileHandle handle = Open(path, false, false, true))
        using (FileStream file = new FileStream(handle, FileAccess.Read)) {
          Info info; Require(GetFileInformationByHandle(file.SafeFileHandle, out info) && info.Links == 1 && (info.Attributes & 0x410) == 0);
          Descriptor(file.SafeFileHandle, false); Require(file.Length <= 262144);
          using (StreamReader reader = new StreamReader(file, new System.Text.UTF8Encoding(false, true), false)) return reader.ReadToEnd();
        }
      }
      Require(text != null && System.Text.Encoding.UTF8.GetByteCount(text) <= 262144);
      string temp = Path.Combine(directory, ".lease-" + Guid.NewGuid().ToString("N") + ".tmp");
      try {
        using (FileStream file = new FileStream(temp, FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.WriteThrough, FileAcl())) {
          byte[] bytes = new System.Text.UTF8Encoding(false).GetBytes(text); file.Write(bytes, 0, bytes.Length); file.Flush(true);
        }
        if (File.Exists(path)) File.Replace(temp, path, null); else File.Move(temp, path);
        using (SafeFileHandle handle = Open(path, false, false)) {}
      } finally { if (File.Exists(temp)) File.Delete(temp); }
      // Read through a verified handle before returning the stored lease.
      return Lease("lease-read", path, null, root);
    } finally { foreach (SafeFileHandle handle in held) handle.Dispose(); }
  }
  public static string Settings(string operation, string path, string text, string root) {
    Canonical(path); Canonical(root);
    Require(Path.GetDirectoryName(path).Equals(root, StringComparison.OrdinalIgnoreCase));
    string name = Path.GetFileName(path);
    Require(Array.IndexOf(new string[] {"hand.json", "turbo.json", "permissions.json", "preapproved.json", "electron-grants.json", "turbo-apps.json"}, name) >= 0);
    // Hold ancestors against rename until the transaction ends.
    List<SafeFileHandle> held = Parents(root);
    try {
      if (!Directory.Exists(root)) {
        if (operation == "read") return null;
        DirectorySecurity acl = new DirectorySecurity(); acl.SetOwner(new SecurityIdentifier(User)); acl.SetAccessRuleProtection(true, false);
        foreach (string sid in new string[] {User, "S-1-5-18", "S-1-5-32-544"}) acl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        Directory.CreateDirectory(root, acl);
      }
      held.Add(Open(root, true, false));
      bool repair = operation == "replace" || operation == "repair";
      Require(!repair || (operation == "replace" ? name == "hand.json" : name == "permissions.json"));
      if (File.Exists(path) || Directory.Exists(path)) {
        using (SafeFileHandle h = Open(path, false, false, false, repair)) {
          if (repair) { Require(SetKernelObjectSecurity(h, 0x80000004u, FileAcl().GetSecurityDescriptorBinaryForm())); Descriptor(h, false); }
        }
      }
      if (operation == "repair") return null;
      if (operation == "read") {
        if (!File.Exists(path)) return null;
        using (SafeFileHandle handle = Open(path, false, false, true))
        using (FileStream file = new FileStream(handle, FileAccess.Read)) {
          Info info; Require(GetFileInformationByHandle(file.SafeFileHandle, out info) && info.Links == 1 && (info.Attributes & 0x410) == 0);
          Descriptor(file.SafeFileHandle, false); Require(file.Length <= 262144);
          using (StreamReader reader = new StreamReader(file, new System.Text.UTF8Encoding(false, true), false)) return reader.ReadToEnd();
        }
      }
      Require((operation == "write" || operation == "replace") && text != null && System.Text.Encoding.UTF8.GetByteCount(text) <= 262144);
      string temp = Path.Combine(root, ".settings-" + Guid.NewGuid().ToString("N") + ".tmp");
      try {
        using (FileStream file = new FileStream(temp, FileMode.CreateNew, FileSystemRights.Write, FileShare.None, 4096, FileOptions.WriteThrough, FileAcl())) {
          byte[] bytes = new System.Text.UTF8Encoding(false).GetBytes(text); file.Write(bytes, 0, bytes.Length); file.Flush(true);
        }
        if (File.Exists(path)) File.Replace(temp, path, null); else File.Move(temp, path);
        using (SafeFileHandle h = Open(path, false, false)) {}
      } finally { if (File.Exists(temp)) File.Delete(temp); }
      return Settings("read", path, null, root);
    } finally { foreach (SafeFileHandle h in held) h.Dispose(); }
  }
}
'@ | Out-Null
function Invoke-SleightFileRequest($request) {
    if ($request.operation -ceq 'selftest') {
        return @{ ok = $true; checks = [SleightFiles]::Selftest() }
    } elseif ($request.operation -ceq 'inspect') {
        if ($request.kind -cnotin @('file', 'directory')) { throw 'kind' }
        [SleightFiles]::Inspect($request.path, ($request.kind -ceq 'directory'))
        return @{ ok = $true }
    } elseif ($request.operation -cin @('lease-init', 'lease-read', 'lease-write')) {
        $text = [SleightFiles]::Lease($request.operation, $request.path, $request.text, [IO.Path]::Combine($account, 'sleight'))
        return @{ ok = $true; absent = ($null -eq $text); text = $text }
    } elseif ($request.operation -cin @('read', 'write', 'replace', 'repair')) {
        $text = [SleightFiles]::Settings($request.operation, $request.path, $request.text, [IO.Path]::Combine($account, 'sleight'))
        return @{ ok = $true; absent = ($null -eq $text); text = $text }
    } else { throw 'operation' }
}
if ($sleightWorker) {
    $outputWriter.WriteLine('{"ready":true}')
    while ($null -ne ($line = $inputReader.ReadLine())) {
        try {
            if ($line.Length -gt 524288) { throw 'budget' }
            $request = $line | ConvertFrom-Json
            $reply = Invoke-SleightFileRequest $request
        } catch { $reply = @{ ok = $false } }
        $reply.id = $request.id
        $outputWriter.WriteLine(($reply | ConvertTo-Json -Compress))
    }
} else {
    try {
        $reply = Invoke-SleightFileRequest ($inputReader.ReadToEnd() | ConvertFrom-Json)
        $outputWriter.WriteLine(($reply | ConvertTo-Json -Compress))
    } catch { $outputWriter.WriteLine('{"ok":false}'); exit 65 }
}
