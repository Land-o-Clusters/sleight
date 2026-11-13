using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace Sleight.Person
{
public static class PersonHost
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 131072 };
    static void Write(object value) { Console.Out.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
    static void Identity()
    {
        string path = Process.GetCurrentProcess().MainModule.FileName;
        using (var file = File.OpenRead(path)) using (var sha = SHA256.Create())
            Write(Native.Map("path", path, "sha256", BitConverter.ToString(sha.ComputeHash(file)).Replace("-", "").ToLowerInvariant()));
    }
    // WIN3 may dispatch these modes here before parsing its drawing modes. This also builds as its own tiny host.
    public static bool Handles(string[] args)
    {
        return args.Length > 0 && new[] { "--confirm-person", "--confirm-person-check", "--person-snapshot", "--person-presence", "--person-selftest", "--password-selftest" }.Contains(args[0]);
    }
    [MTAThread]
    public static int Main(string[] args)
    {
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { NewLine = "\n", AutoFlush = true });
        if (!Handles(args)) return 64;
        string mode = args[0];
        try {
            if (mode == "--confirm-person" || mode == "--confirm-person-check") {
                string reason = Hello.Reason(args.Skip(1).ToArray());
                if (reason == null) return 64;
                Identity();
                if (mode == "--confirm-person-check") { Write(Native.Map("reason", reason, "timeoutMs", Hello.TimeoutMs)); return 0; }
                if (Environment.OSVersion.Platform != PlatformID.Win32NT) return 69;
                return Hello.Confirm(reason);
            }
            if (mode == "--person-selftest" && args.Length == 1) {
                Write(Native.Map("results", Enumerable.Range(-1, 10).Select(Hello.Result).ToArray(), "timeoutMs", Hello.TimeoutMs,
                    "requestIid", typeof(IConsentOperation).GUID.ToString(), "availabilityIid", typeof(IAvailabilityOperation).GUID.ToString(),
                    "passwordFallback", Enumerable.Range(-1, 8).Select(Hello.NeedsPassword).ToArray(), "drawing", false));
                return 0;
            }
            if (mode == "--password-selftest" && args.Length == 1) { Write(Password.SelfTest()); return 0; }
            if (Environment.OSVersion.Platform != PlatformID.Win32NT) return 69;
            if (mode == "--person-presence" && args.Length == 1) { Write(Native.Presence()); return 0; }
            uint pid;
            if (mode == "--person-snapshot" && args.Length == 2 && UInt32.TryParse(args[1], out pid) && pid > 0) { Write(Native.Snapshot(pid)); return 0; }
            return 64;
        } catch { Console.Error.WriteLine("PERSON_HELPER_UNAVAILABLE"); return 69; }
    }
}
}
