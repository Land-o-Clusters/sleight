#if SLEIGHT_DRIVER
namespace Sleight.Cursor
{
public static class Program
{
    [System.MTAThread]
    public static int Main(string[] args) { return Sleight.Driver.Driver.Entry(args); }
}
}
#else
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace Sleight.Cursor
{
public static class Program
{
    public static int ExitCode;
    public static string BoundNonce;
    sealed class Options
    {
        public string Mode, Style = "ring", Capture = "hidden", TestRoot;
        public bool Reduced, Secure;
        public Rect Clip = new Rect(0, 0, 1000, 1000);
        public ulong Seed = 1;
        public HashSet<uint> Gone = new HashSet<uint>();
        public static Options Parse(string[] args)
        {
            if (args.Length == 0 ||
                !new[] { "--hand", "--plan-dump", "--ring-plan-dump", "--validate", "--check-character", "--interop-selftest", "--security-selftest", "--decode-webp", "--capabilities", "--label-dump", "--browser-gate", "--gate-selftest", "--consent-selftest", "--consent-validate", "--consent" }.Contains(
                    args[0]))
                throw new ArgumentException();
            var o = new Options { Mode = args[0] };
            if (new[] { "--browser-gate", "--gate-selftest", "--consent-selftest", "--consent-validate", "--consent" }.Contains(o.Mode) && args.Length != 1) throw new ArgumentException();
            foreach (string arg in args.Skip(1))
            {
                if (arg == "--reduce-motion")
                    o.Reduced = true;
                else if (arg == "--secure-input")
                    o.Secure = true;
                else if (arg.StartsWith("--cursor-style=", StringComparison.Ordinal))
                {
                    o.Style = arg.Substring(15);
                    if (!new[] { "ring", "seam", "sprite" }.Contains(o.Style))
                        throw new ArgumentException();
                }
                else if (arg.StartsWith("--capture=", StringComparison.Ordinal))
                {
                    o.Capture = arg.Substring(10);
                    if (o.Capture != "hidden" && o.Capture != "visible")
                        throw new ArgumentException();
                }
                else if (arg.StartsWith("--seed=", StringComparison.Ordinal))
                {
                    if (!UInt64.TryParse(arg.Substring(7), NumberStyles.None, CultureInfo.InvariantCulture, out o.Seed))
                        throw new ArgumentException();
                }
                else if (arg.StartsWith("--clip=", StringComparison.Ordinal) && o.Mode != "--hand")
                {
                    var xy = arg.Substring(7)
                                 .Split(',')
                                 .Select(s => Double.Parse(s, CultureInfo.InvariantCulture))
                                 .ToArray();
                    if (xy.Length != 4 || xy.Any(x => Double.IsNaN(x) || Double.IsInfinity(x)) || xy[2] <= 0 ||
                        xy[3] <= 0)
                        throw new ArgumentException();
                    o.Clip = new Rect(xy[0], xy[1], xy[2], xy[3]);
                }
                else if (arg.StartsWith("--gone=", StringComparison.Ordinal) && o.Mode != "--hand")
                    o.Gone = new HashSet<uint>(arg.Substring(7).Split(',').Select(UInt32.Parse));
                else if (arg.StartsWith("--test-character-root=", StringComparison.Ordinal) &&
                         new[] { "--plan-dump", "--ring-plan-dump", "--check-character" }.Contains(o.Mode))
                {
                    o.TestRoot = arg.Substring(22);
                    string temp = Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\') + "\\";
                    if (Path.GetFullPath(o.TestRoot) != o.TestRoot ||
                        !o.TestRoot.StartsWith(temp, StringComparison.OrdinalIgnoreCase) ||
                        o.TestRoot.TrimEnd('\\').Length <= temp.TrimEnd('\\').Length)
                        throw new ArgumentException();
                }
                else
                    throw new ArgumentException();
            }
            return o;
        }
    }
    public static void Write(object value)
    {
        Console.Out.WriteLine(J.Serializer.Serialize(value));
        Console.Out.Flush();
    }
    static void Emit(IEnumerable<RingEffect> effects, SpriteCharacter character = null, Options options = null)
    {
        foreach (var effect in effects)
        {
            if (effect.Kind == "draw" && character != null)
            {
                var sprite = SpritePlan.Make(effect.Plan, character, options.Reduced, options.Secure, options.Clip);
                effect.Plan.SpriteJson = sprite.Json(effect.Plan, options.Reduced);
                var b = sprite.Bounds(effect.Plan);
                var frame = effect.Frame;
                effect.Frame = Rect.Box(new[] { new Pt(frame.X, frame.Y), new Pt(frame.Right, frame.Bottom),
                                                new Pt(b.X, b.Y), new Pt(b.Right, b.Bottom) },
                                        0)
                                   .Intersect(options.Clip);
            }
            Write(effect.Json);
        }
    }
    public static string CharacterReason(Exception error)
    {
        return new[] { "path", "permissions", "size", "type", "decode", "alpha", "pixels", "changed" }.Contains(
                   error.Message)
                   ? error.Message
                   : "decode";
    }
    static object CharacterResult(CharacterFrame frame, SpriteCharacter character, string reason)
    {
        return J.Map("id", frame.Id, "loaded", character != null, "reason", reason, "warnings",
                     character == null ? new string[0] : character.Warnings);
    }
    static void CheckCharacter(Options o)
    {
        var reader = new FrameReader(Console.OpenStandardInput());
        var d = reader.Read();
        if (d == null)
            throw new FrameFault();
        var frame = reader.Bind(d);
        if (frame.Character == null || reader.Read() != null)
            throw new FrameFault();
        SpriteCharacter character = null;
        string reason = null;
        try
        {
            character = SpriteCharacter.Load(frame.Character, o.TestRoot);
        }
        catch (Exception error)
        {
            reason = CharacterReason(error);
        }
        try
        {
            Write(CharacterResult(frame.Character, character, reason));
        }
        finally
        {
            if (character != null)
                character.Dispose();
        }
    }
    static void Validate()
    {
        var reader = new FrameReader(Console.OpenStandardInput());
        Dictionary<string, object> d;
        while ((d = reader.Read()) != null)
            reader.Bind(d);
    }
    static void Dump(Options o)
    {
        var reader = new FrameReader(Console.OpenStandardInput());
        double clock = 0;
        SpriteCharacter character = null;
        var runtime = new RingRuntime(
            RingTheme.For(o.Style), o.Seed) { Bounds = (pid, window) => o.Gone.Contains(window) ? (Rect?)null : o.Clip,
                                              Reduced = () => o.Reduced, Secure = () => o.Secure };
        runtime.ExtraBounds = (plan, clip) =>
            character == null ? (Rect?)null : SpritePlan.Make(plan, character, o.Reduced, o.Secure, clip).Bounds(plan);
        Dictionary<string, object> d;
        try
        {
            while ((d = reader.Read()) != null)
            {
                if (d.Count == 1 && d.ContainsKey("dumpAwait"))
                {
                    if (J.S(d["dumpAwait"]) != "character")
                        throw new FrameFault();
                    continue;
                }
                if (d.Count == 1 && d.ContainsKey("dumpClock"))
                {
                    double next = J.Number(d["dumpClock"]);
                    if (next < clock)
                        throw new FrameFault();
                    clock = next;
                    Emit(runtime.Advance(clock), character, o);
                    continue;
                }
                var f = reader.Bind(d);
                BoundNonce = f.Nonce;
                if (f.Tag == "hide")
                {
                    Emit(runtime.Hide(clock));
                    continue;
                }
                if (f.Tag == "menu")
                {
                    Write(J.Map("effect", "drop", "state", "menu", "dropped", true, "animations", new object[0], "time",
                                clock));
                    continue;
                }
                if (f.Tag == "character")
                {
                    if (character != null)
                    {
                        character.Dispose();
                        character = null;
                    }
                    string reason = null;
                    if (o.Style == "sprite")
                    {
                        Write(J.Map("effect", "character-start", "id", f.Character.Id, "handleMs", 0.0, "time", clock));
                        try
                        {
                            character = SpriteCharacter.Load(f.Character, o.TestRoot);
                        }
                        catch (Exception error)
                        {
                            reason = CharacterReason(error);
                        }
                    }
                    Write(J.Map("effect", "character", "id", f.Character.Id, "loaded", character != null, "reason",
                                reason, "warnings", character == null ? new string[0] : character.Warnings, "time",
                                clock));
                    continue;
                }
                Emit(runtime.Receive(f.Event, f.Delay, clock), character, o);
            }
            Emit(runtime.Advance(Double.MaxValue), character, o);
            Write(J.Map("effect", "end", "idle", runtime.Idle, "pending", runtime.Pending.Count, "timers",
                        runtime.Timers.Count));
        }
        finally
        {
            if (character != null)
                character.Dispose();
        }
    }
    [STAThread]
    public static int Main(string[] args)
    {
        // Person modes return before any overlay/window initialization.
        if (Sleight.Person.PersonHost.Handles(args))
            return Sleight.Person.PersonHost.Main(args);
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { NewLine = "\n", AutoFlush = true });
        Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { NewLine = "\n", AutoFlush = true });
        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
        CultureInfo.DefaultThreadCurrentUICulture = CultureInfo.InvariantCulture;
        Options options;
        try
        {
            options = Options.Parse(args);
        }
        catch
        {
            Console.Error.WriteLine("WINDOWS_HOST_ARGUMENTS");
            return 64;
        }
        try
        {
            Win.AssertLayout();
            if (options.Mode == "--capabilities")
                Write(J.Map("schema", "sleight.windows-host-capabilities/1", "drawing", false,
                    "modes", new[] {"--plan-dump", "--validate", "--check-character", "--decode-webp", "--interop-selftest", "--security-selftest", "--label-dump", "--browser-gate", "--gate-selftest", "--consent-selftest", "--consent-validate"}));
            else if (options.Mode == "--browser-gate") BrowserGate.Run();
            else if (options.Mode == "--gate-selftest") BrowserGate.SelfTest();
            else if (options.Mode == "--consent-selftest") ConsentInput.SelfTest();
            else if (options.Mode == "--consent-validate" || options.Mode == "--consent") ConsentWindow.Run(options.Mode == "--consent-validate");
            else if (options.Mode == "--label-dump")
            {
                var reader = new FrameReader(Console.OpenStandardInput());
                Dictionary<string, object> value;
                while ((value = reader.Read()) != null) {
                    var f = reader.Bind(value);
                    if (f.Event == null) throw new FrameFault();
                    Write(J.Map("label",f.Event.Label,"elements",new StringInfo(f.Event.Label ?? "").LengthInTextElements));
                }
            }
            else if (options.Mode == "--interop-selftest")
                Write(J.Map("osVersionSize", System.Runtime.InteropServices.Marshal.SizeOf(typeof(Win.OsVersion))));
            else if (options.Mode == "--security-selftest")
            {
                var gate = new System.Threading.ManualResetEvent(false);
                var slow = new SecureInput(pid => { gate.WaitOne(); return false; });
                bool timeout = slow.IsSecure(1), busy = slow.IsSecure(1);
                gate.Set();
                Write(J.Map("password", new SecureInput(pid => true).IsSecure(1),
                    "plain", new SecureInput(pid => false).IsSecure(1),
                    "failure", new SecureInput(pid => { throw new Exception(); }).IsSecure(1),
                    "timeout", timeout, "busy", busy));
            }
            else if (options.Mode == "--decode-webp")
            {
                // Headless decoder test surface: bounded bytes in, raw premultiplied BGRA out.
                using (var input = Console.OpenStandardInput()) using (var bytes = new MemoryStream())
                {
                    var buffer = new byte[8192]; int n;
                    while ((n = input.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        if (bytes.Length + n > 8 * 1024 * 1024) throw new ArgumentException();
                        bytes.Write(buffer, 0, n);
                    }
                    int w, h;
                    var pixels = WebPLossless.Decode(bytes.ToArray(), out w, out h);
                    using (var output = Console.OpenStandardOutput()) output.Write(pixels, 0, pixels.Length);
                }
            }
            else if (options.Mode == "--validate")
                Validate();
            else if (options.Mode == "--check-character")
                CheckCharacter(options);
            else if (options.Mode == "--plan-dump" || options.Mode == "--ring-plan-dump")
                Dump(options);
            else
            {
                if (Environment.OSVersion.Platform != PlatformID.Win32NT)
                    return 69;
                ulong seed;
                using (var rng = RandomNumberGenerator.Create())
                {
                    var bytes = new byte[8];
                    rng.GetBytes(bytes);
                    seed = BitConverter.ToUInt64(bytes, 0);
                }
                using (var host = new OverlayHost(options.Style, options.Capture == "hidden", seed)) host.Start();
            }
            return ExitCode;
        }
        catch (FrameFault)
        {
            return 65;
        }
        catch (System.Text.DecoderFallbackException)
        {
            return 65;
        }
        catch (ArgumentException)
        {
            return 65;
        }
        catch (InvalidOperationException error)
        {
            Console.Error.WriteLine(error.Message);
            return 70;
        }
        catch
        {
            Console.Error.WriteLine("WINDOWS_HOST_FAILED");
            return 65;
        }
    }
}
}

#endif
