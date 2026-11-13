using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.RegularExpressions;

namespace Sleight.Cursor
{
public sealed class SpriteEntry
{
    public string Sheet, Then;
    public int Row;
    public int[] Columns;
    public double[] Ms, Size;
    public bool Loop, Flip;
    public Pt Hotspot;
    public double Scale = 1;
}
public sealed class CharacterFrame
{
    public long Seq;
    public string Id, Sheet, Extra;
    public Pt Cell;
    public Dictionary<string, SpriteEntry> Table = new Dictionary<string, SpriteEntry>();
    public static readonly HashSet<string> States =
        new HashSet<string>(new[] { "idle", "move", "aim", "click", "double-click", "right-click", "type", "key",
                                    "scroll-up", "scroll-down", "drag-grab", "drag-carry", "drag-drop",
                                    "waiting-approval", "error", "success", "thinking", "handoff", "working" });
    static readonly HashSet<string> Directional =
        new HashSet<string>(new[] { "move", "aim", "drag-carry", "move-far", "drag-carry-far" });
    static string PathValue(object o)
    {
        string s = J.S(o);
        if (s.Length > 4096 || s.IndexOf('\0') >= 0 || !Regex.IsMatch(s, "\\A[A-Za-z]:\\\\") ||
            Path.GetFullPath(s) != s || s.Substring(2).Contains(":"))
            throw new FrameFault();
        return s;
    }
    static double[] Pair(object o, double lo, double hi)
    {
        var a = J.A(o);
        if (a.Length != 2)
            throw new FrameFault();
        return a.Select(x => J.N(x, lo, hi)).ToArray();
    }
    public static CharacterFrame Parse(Dictionary<string, object> d)
    {
        J.Keys(d, "hand nonce seq id sheet extra cell table");
        var f = new CharacterFrame { Seq = J.Integer(d["seq"], 0, 9007199254740991), Id = J.S(d["id"]),
                                     Sheet = PathValue(d["sheet"]),
                                     Extra = d["extra"] == null ? null : PathValue(d["extra"]) };
        if (!Regex.IsMatch(f.Id, "\\A[a-z0-9-]{1,48}\\z"))
            throw new FrameFault();
        var cell = Pair(d["cell"], 64, 512);
        if (cell[0] != Math.Truncate(cell[0]) || cell[1] != Math.Truncate(cell[1]) || cell[0] > 192 || cell[1] > 208)
            throw new FrameFault();
        f.Cell = new Pt(cell[0], cell[1]);
        var raw = J.D(d["table"]);
        if (!raw.ContainsKey("idle") || raw.Count > 99)
            throw new FrameFault();
        foreach (var kv in raw)
        {
            var parts = kv.Key.Split('@');
            if (parts.Length == 1 ? !States.Contains(kv.Key)
                                  : parts.Length != 2 || !Directional.Contains(parts[0]) ||
                                        !Regex.IsMatch(parts[1], "\\A(?:[0-9]|1[0-5])\\z"))
                throw new FrameFault();
            var v = J.D(kv.Value);
            J.Keys(v, "sheet row frames ms loop flip hotspot", "size scale then");
            var entry = new SpriteEntry { Sheet = J.S(v["sheet"]), Row = (int)J.Integer(v["row"], 0, 63),
                                          Loop = J.B(v["loop"]), Flip = J.B(v["flip"]) };
            if (entry.Sheet != "sheet" && entry.Sheet != "extra" || entry.Sheet == "extra" && f.Extra == null)
                throw new FrameFault();
            var spot = Pair(v["hotspot"], -1024, 1024);
            if (spot[0] < -cell[0] || spot[0] > 2 * cell[0] || spot[1] < -cell[1] || spot[1] > 2 * cell[1])
                throw new FrameFault();
            entry.Hotspot = new Pt(spot[0], spot[1]);
            if (v["frames"] is int || v["frames"] is long || v["frames"] is double || v["frames"] is decimal)
                entry.Columns = Enumerable.Range(0, (int)J.Integer(v["frames"], 1, 8)).ToArray();
            else
            {
                var a = J.A(v["frames"]);
                if (a.Length < 1 || a.Length > 16)
                    throw new FrameFault();
                entry.Columns = a.Select(x => (int)J.Integer(x, 0, 7)).ToArray();
            }
            object[] durations = v["ms"] is object[] || v["ms"] is System.Collections.ArrayList
                                     ? J.A(v["ms"])
                                     : Enumerable.Repeat(v["ms"], entry.Columns.Length).ToArray();
            entry.Ms = durations.Select(x => J.N(x, entry.Loop ? 40 : 20, 2000)).ToArray();
            if (entry.Ms.Length != entry.Columns.Length || entry.Ms.Sum() > 8000)
                throw new FrameFault();
            if (v.ContainsKey("scale"))
                entry.Scale = J.N(v["scale"], .25, 2);
            if (v.ContainsKey("then"))
            {
                entry.Then = J.S(v["then"]);
                if (!States.Contains(entry.Then))
                    throw new FrameFault();
            }
            if (v.ContainsKey("size"))
            {
                entry.Size = Pair(v["size"], 1, 2288);
                if (entry.Size.Any(x => x != Math.Truncate(x)) || entry.Size[0] != cell[0] * 8 ||
                    entry.Size[0] > 1536 || entry.Size[1] % cell[1] != 0 || (entry.Row + 1) * cell[1] > entry.Size[1])
                    throw new FrameFault();
            }
            f.Table.Add(kv.Key, entry);
        }
        return f;
    }
}
// Windows storage checks use SIDs, not POSIX modes. Reparse components and links
// refuse; keep the file open with no write/delete sharing through read and hash.
public static class PrivateFiles
{
    static void Security(FileSystemSecurity acl, bool privateRead, bool ancestor)
    {
        string user = WindowsIdentity.GetCurrent().User.Value;
        string owner = acl.GetOwner(typeof(SecurityIdentifier)).Value;
        var trusted = new[] { user, "S-1-5-18", "S-1-5-32-544" };
        if (!(ancestor ? trusted.Concat(new[] { "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464" })
                             .Contains(owner)
                       : owner == user) ||
            !acl.AreAccessRulesCanonical)
            throw new IOException("permissions");
        var rules = acl.GetAccessRules(true, true, typeof(SecurityIdentifier));
        if (rules.Count == 0)
            throw new IOException("permissions");
        var replace = FileSystemRights.Delete | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership |
                      FileSystemRights.DeleteSubdirectoriesAndFiles;
        foreach (FileSystemAccessRule rule in rules)
        {
            bool inheritOnly = (rule.PropagationFlags & PropagationFlags.InheritOnly) != 0;
            if (inheritOnly && (ancestor || rule.IdentityReference.Value == "S-1-3-0"))
                continue;
            if (rule.AccessControlType == AccessControlType.Allow && !trusted.Contains(rule.IdentityReference.Value) &&
                (!ancestor && privateRead ||
                 (rule.FileSystemRights & (ancestor ? replace : replace | FileSystemRights.Write)) != 0))
                throw new IOException("permissions");
        }
    }
    public static void Check(string path, bool privateRead = true)
    {
        string full = Path.GetFullPath(path);
        if (!String.Equals(full, path, StringComparison.OrdinalIgnoreCase) || path.StartsWith("\\\\") ||
            path.Substring(2).Contains(":"))
            throw new IOException("path");
        for (string p = path; !String.IsNullOrEmpty(p); p = Path.GetDirectoryName(p))
        {
            if ((File.GetAttributes(p) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("path");
            FileSystemSecurity acl =
                Directory.Exists(p) ? (FileSystemSecurity)Directory.GetAccessControl(p) : File.GetAccessControl(p);
            Security(acl, privateRead, p != path);
        }
    }
    [StructLayout(LayoutKind.Sequential)]
    struct FileInformation
    {
        public uint Attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle handle,
                                                  out FileInformation info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandle(Microsoft.Win32.SafeHandles.SafeFileHandle handle,
                                                System.Text.StringBuilder path, uint count, uint flags);
    public static byte[] Read(string path)
    {
        Check(path);
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            var final = new System.Text.StringBuilder(4096);
            uint length = GetFinalPathNameByHandle(stream.SafeFileHandle, final, 4096, 0);
            if (length == 0 || length >= 4096 ||
                !String.Equals(final.ToString(), "\\\\?\\" + path, StringComparison.OrdinalIgnoreCase))
                throw new IOException("path");
            Security(stream.GetAccessControl(), true, false);
            FileInformation info;
            if (!GetFileInformationByHandle(stream.SafeFileHandle, out info) || info.Links != 1 ||
                (info.Attributes & (uint)FileAttributes.ReparsePoint) != 0 || stream.Length < 24 ||
                stream.Length > 8 * 1024 * 1024)
                throw new IOException("size");
            var bytes = new byte[(int)stream.Length];
            int at = 0, n;
            while (at < bytes.Length && (n = stream.Read(bytes, at, bytes.Length - at)) > 0)
                at += n;
            if (at != bytes.Length)
                throw new IOException("changed");
            return bytes;
        }
    }
}
// A bounded PNG reader, so the overlay never hands untrusted compressed art to
// GDI+'s native image decoder. 8-bit RGBA, RGB, palette, gray and gray-alpha PNGs
// are supported. VP8L uses the bounded managed reader. Lossy WebP, animation,
// interlace and unsupported bit depths refuse. No codec is installed.
public sealed class SpriteSheet : IDisposable
{
    public readonly HashSet<string> Warnings = new HashSet<string>();
    public readonly int Width, Height;
    public readonly byte[] Pixels;
    public readonly Bitmap Bitmap;
    public SpriteSheet(int width, int height, byte[] pixels)
    {
        Width = width;
        Height = height;
        Pixels = pixels;
        Bitmap = new Bitmap(width, height, PixelFormat.Format32bppPArgb);
        var bits =
            Bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
        try
        {
            for (int y = 0; y < height; y++)
                Marshal.Copy(pixels, y * width * 4, IntPtr.Add(bits.Scan0, y * bits.Stride), width * 4);
        }
        finally
        {
            Bitmap.UnlockBits(bits);
        }
    }
    public void Dispose()
    {
        Bitmap.Dispose();
    }
    static uint Be(byte[] b, int i)
    {
        return (uint)b[i] << 24 | (uint)b[i + 1] << 16 | (uint)b[i + 2] << 8 | b[i + 3];
    }
    static uint Crc(byte[] b, int at, int length, Func<bool> cancelled)
    {
        uint c = 0xffffffff;
        for (int i = at; i < at + length; i++)
        {
            if ((i & 4095) == 0 && cancelled != null && cancelled())
                throw new IOException("cancelled");
            c ^= b[i];
            for (int k = 0; k < 8; k++)
                c = (c >> 1) ^ ((c & 1) != 0 ? 0xedb88320U : 0);
        }
        return c ^ 0xffffffff;
    }
    static int Paeth(int a, int b, int c)
    {
        int p = a + b - c, pa = Math.Abs(p - a), pb = Math.Abs(p - b), pc = Math.Abs(p - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    public static SpriteSheet Decode(byte[] bytes, CharacterFrame f, string name, Func<bool> cancelled = null)
    {
        if (bytes.Length >= 12 && System.Text.Encoding.ASCII.GetString(bytes, 0, 4) == "RIFF")
        {
            int w, h;
            var bgra = WebPLossless.Decode(bytes, out w, out h, cancelled);
            return FromPixels(w, h, bgra, f, name, cancelled);
        }
        if (bytes.Length < 33 || !bytes.Take(8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }))
            throw new IOException("type");
        int width = 0, height = 0, type = -1, channels = 0;
        byte[] palette = null, transparency = null;
        bool ended = false, header = false, idat = false;
        var compressed = new MemoryStream();
        for (int at = 8; at < bytes.Length;)
        {
            if (cancelled != null && cancelled())
                throw new IOException("cancelled");
            if (bytes.Length - at < 12)
                throw new IOException("decode");
            uint rawLength = Be(bytes, at);
            if (rawLength > bytes.Length - at - 12)
                throw new IOException("decode");
            int length = (int)rawLength;
            string tag = System.Text.Encoding.ASCII.GetString(bytes, at + 4, 4);
            if (Crc(bytes, at + 4, length + 4, cancelled) != Be(bytes, at + 8 + length))
                throw new IOException("decode");
            int data = at + 8;
            if (!header && tag != "IHDR")
                throw new IOException("decode");
            if (tag == "IHDR")
            {
                if (header || length != 13)
                    throw new IOException("decode");
                uint w = Be(bytes, data), h = Be(bytes, data + 4);
                if (w == 0 || w > 1536 || h == 0 || h > 2288)
                    throw new IOException("size");
                width = (int)w;
                height = (int)h;
                type = bytes[data + 9];
                if (bytes[data + 8] != 8 || bytes[data + 10] != 0 || bytes[data + 11] != 0 || bytes[data + 12] != 0)
                    throw new IOException("type");
                channels = type == 6 ? 4 : type == 2 ? 3 : type == 4 ? 2 : type == 0 || type == 3 ? 1 : 0;
                if (channels == 0)
                    throw new IOException("type");
                header = true;
            }
            else if (tag == "PLTE")
            {
                if (idat || palette != null || length == 0 || length > 768 || length % 3 != 0)
                    throw new IOException("decode");
                palette = bytes.Skip(data).Take(length).ToArray();
            }
            else if (tag == "tRNS")
            {
                if (idat || transparency != null || length > 256)
                    throw new IOException("decode");
                transparency = bytes.Skip(data).Take(length).ToArray();
            }
            else if (tag == "IDAT")
            {
                idat = true;
                compressed.Write(bytes, data, length);
            }
            else if (tag == "IEND")
            {
                if (length != 0 || !idat || at + 12 != bytes.Length)
                    throw new IOException("decode");
                ended = true;
                break;
            }
            else if (tag == "acTL" || tag == "fcTL" || tag == "fdAT" || Char.IsUpper(tag[0]))
                throw new IOException("type");
            at += length + 12;
        }
        if (!ended || width != (int)f.Cell.X * 8 || height % (int)f.Cell.Y != 0)
            throw new IOException("size");
        foreach (var entry in f.Table.Values.Where(e => e.Sheet == name))
            if ((entry.Row + 1) * f.Cell.Y > height ||
                entry.Size != null && (entry.Size[0] != width || entry.Size[1] != height))
                throw new IOException("size");
        if (type == 3 && (palette == null || transparency == null) || type == 2 && transparency == null ||
            type == 0 && transparency == null)
            throw new IOException("alpha");
        byte[] z = compressed.ToArray();
        compressed.Dispose();
        if (z.Length < 6 || (z[0] & 15) != 8 || ((z[0] << 8) + z[1]) % 31 != 0 || (z[1] & 32) != 0)
            throw new IOException("decode");
        int stride = width * channels, expected = (stride + 1) * height;
        var scan = new byte[expected];
        using (var input = new MemoryStream(z, 2, z.Length - 6)) using (
            var inflater = new DeflateStream(input, CompressionMode.Decompress))
        {
            int pos = 0, n;
            while (pos < expected && (n = inflater.Read(scan, pos, Math.Min(65536, expected - pos))) > 0)
            {
                pos += n;
                if (cancelled != null && cancelled())
                    throw new IOException("cancelled");
            }
            if (pos != expected || inflater.ReadByte() != -1)
                throw new IOException("decode");
        }
        uint adlerA = 1, adlerB = 0;
        foreach (byte value in scan)
        {
            adlerA = (adlerA + value) % 65521;
            adlerB = (adlerB + adlerA) % 65521;
        }
        if ((adlerB << 16 | adlerA) != Be(z, z.Length - 4))
            throw new IOException("decode");
        var pixels = new byte[width * height * 4];
        var previous = new byte[stride];
        var current = new byte[stride];
        for (int y = 0; y < height; y++)
        {
            if (cancelled != null && cancelled())
                throw new IOException("cancelled");
            int start = y * (stride + 1), filter = scan[start];
            if (filter > 4)
                throw new IOException("decode");
            for (int x = 0; x < stride; x++)
            {
                int a = x >= channels ? current[x - channels] : 0, b = previous[x],
                    c = x >= channels ? previous[x - channels] : 0,
                    predict = filter == 0   ? 0
                              : filter == 1 ? a
                              : filter == 2 ? b
                              : filter == 3 ? (a + b) / 2
                                            : Paeth(a, b, c);
                current[x] = unchecked((byte)(scan[start + 1 + x] + predict));
            }
            for (int x = 0; x < width; x++)
            {
                int i = x * channels, r, g, b, alpha = 255;
                if (type == 6 || type == 2)
                {
                    r = current[i];
                    g = current[i + 1];
                    b = current[i + 2];
                    if (type == 6)
                        alpha = current[i + 3];
                    else if (transparency.Length == 6 && r == ((transparency[0] << 8) | transparency[1]) &&
                             g == ((transparency[2] << 8) | transparency[3]) &&
                             b == ((transparency[4] << 8) | transparency[5]))
                        alpha = 0;
                }
                else if (type == 3)
                {
                    int index = current[i];
                    if (index * 3 + 2 >= palette.Length)
                        throw new IOException("decode");
                    r = palette[index * 3];
                    g = palette[index * 3 + 1];
                    b = palette[index * 3 + 2];
                    alpha = index < transparency.Length ? transparency[index] : 255;
                }
                else
                {
                    r = g = b = current[i];
                    if (type == 4)
                        alpha = current[i + 1];
                    else if (transparency.Length == 2 && r == ((transparency[0] << 8) | transparency[1]))
                        alpha = 0;
                }
                int p = (y * width + x) * 4;
                pixels[p] = (byte)(b * alpha / 255);
                pixels[p + 1] = (byte)(g * alpha / 255);
                pixels[p + 2] = (byte)(r * alpha / 255);
                pixels[p + 3] = (byte)alpha;
            }
            var swap = previous;
            previous = current;
            current = swap;
        }
        return FromPixels(width, height, pixels, f, name, cancelled);
    }
    static SpriteSheet FromPixels(int width, int height, byte[] pixels, CharacterFrame f, string name, Func<bool> cancelled)
    {
        if (width != (int)f.Cell.X * 8 || height % (int)f.Cell.Y != 0)
            throw new IOException("size");
        foreach (var entry in f.Table.Values.Where(e => e.Sheet == name))
            if ((entry.Row + 1) * f.Cell.Y > height || entry.Size != null && (entry.Size[0] != width || entry.Size[1] != height))
                throw new IOException("size");
        var used = new HashSet<int>(f.Table.Values.Where(e => e.Sheet == name)
                                        .SelectMany(entry => entry.Columns.Select(column => entry.Row * 8 + column)));
        var warnings = new HashSet<string>();
        foreach (int row in f.Table.Values.Where(e => e.Sheet == name).Select(entry => entry.Row).Distinct())
            for (int column = 0; column < 8; column++)
            {
                if (cancelled != null && cancelled())
                    throw new IOException("cancelled");
                int ink = 0, opaque = 0, green = 0;
                for (int y = row * (int)f.Cell.Y; y < (row + 1) * f.Cell.Y; y++)
                    for (int x = column * (int)f.Cell.X; x < (column + 1) * f.Cell.X; x++)
                    {
                        byte alpha = pixels[(y * width + x) * 4 + 3];
                        if (alpha > 0)
                            ink++;
                        if (alpha == 255)
                            opaque++;
                        int p = (y * width + x) * 4;
                        if (alpha > 0 && pixels[p + 1] > 100 && pixels[p + 1] > pixels[p] * 2 &&
                            pixels[p + 1] > pixels[p + 2] * 2)
                            green++;
                    }
                if (used.Contains(row * 8 + column))
                {
                    if (ink < 50 || opaque >= .95 * f.Cell.X * f.Cell.Y)
                        throw new IOException("pixels");
                    if (green > 0)
                        warnings.Add("chroma fringe");
                }
                else if (ink > 0 && !(row == 0 && column == 6))
                    warnings.Add("ink in an unused cell");
            }
        var sheet = new SpriteSheet(width, height, pixels);
        sheet.Warnings.UnionWith(warnings);
        return sheet;
    }
}
public sealed class SpriteCharacter : IDisposable
{
    public string[] Warnings
    {
        get {
            return Sheets.Values.SelectMany(s => s.Warnings)
                .Distinct()
                .OrderBy(s => s, StringComparer.Ordinal)
                .ToArray();
        }
    }
    public readonly CharacterFrame Frame;
    public readonly Dictionary<string, SpriteSheet> Sheets = new Dictionary<string, SpriteSheet>();
    public SpriteCharacter(CharacterFrame frame)
    {
        Frame = frame;
    }
    public void Dispose()
    {
        foreach (var s in Sheets.Values)
            s.Dispose();
        Sheets.Clear();
    }
    public static SpriteCharacter Load(CharacterFrame f, string testRoot = null, Func<bool> cancelled = null)
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
               bank = testRoot ?? Path.Combine(local, "sleight", "characters"), folder = Path.Combine(bank, f.Id);
        PrivateFiles.Check(bank);
        PrivateFiles.Check(folder);
        var c = new SpriteCharacter(f);
        try
        {
            foreach (string name in f.Table.Values.Select(e => e.Sheet).Distinct())
            {
                if (cancelled != null && cancelled())
                    throw new IOException("cancelled");
                string path = name == "sheet" ? f.Sheet : f.Extra;
                if (path == null ||
                    !String.Equals(Path.GetDirectoryName(path), folder, StringComparison.OrdinalIgnoreCase) ||
                    !new[] { ".png", ".webp" }.Contains(Path.GetExtension(path).ToLowerInvariant()))
                    throw new IOException("path");
                c.Sheets.Add(name, SpriteSheet.Decode(PrivateFiles.Read(path), f, name, cancelled));
            }
            return c;
        }
        catch
        {
            c.Dispose();
            throw;
        }
    }
}
public sealed class SpritePose
{
    public double Time;
    public string State;
    public SpriteEntry Entry;
    public int Column, Direction;
}
public sealed class SpritePlan
{
    public readonly List<SpritePose> Poses = new List<SpritePose>();
    public SpriteCharacter Character;
    public double Duration;
    public Rect Clip;
    static int Direction(Pt a, Pt b)
    {
        if (Pt.Distance(a, b) < 1)
            return -1;
        return (Seam.Round(Math.Atan2(b.X - a.X, a.Y - b.Y) * 180 / Math.PI / 22.5) + 16) % 16;
    }
    SpriteEntry Entry(string name, int direction, bool far)
    {
        SpriteEntry e;
        var table = Character.Frame.Table;
        if (far && table.TryGetValue(name + "-far@" + direction, out e))
            return e;
        if (table.TryGetValue(name + "@" + direction, out e))
            return e;
        if (table.TryGetValue(name, out e))
            return e;
        return table["idle"];
    }
    public static SpritePlan Make(RingPlan ring, SpriteCharacter character, bool reduced, bool secure, Rect clip)
    {
        var p = new SpritePlan { Character = character, Duration = ring.Total, Clip = clip };
        Pt first = ring.Positions.Count > 0 ? ring.Positions[0].Item2 : ring.At;
        int d = Direction(first, ring.At);
        bool far = Pt.Distance(first, ring.At) > 60;
        var names = new Dictionary<string, string> { { "double", "double-click" },      { "right", "right-click" },
                                                     { "waiting", "waiting-approval" }, { "done", "success" },
                                                     { "handback", "handoff" },         { "scroll", "scroll-down" } };
        string state;
        if (secure && (ring.State == "type" || ring.State == "key"))
            state = "idle";
        else if (!names.TryGetValue(ring.State, out state))
            state = ring.State;
        var stages = new List<Tuple<double, string, int, bool>> { Tuple.Create(0.0, state, d, false) };
        if (ring.GlideEnd > 0 && !reduced)
            stages = new List<Tuple<double, string, int, bool>> { Tuple.Create(0.0, "move", d, far),
                                                                  Tuple.Create(ring.GlideEnd, state, d, false) };
        if (ring.State == "drag")
        {
            stages.RemoveAll(s => s.Item2 != "move");
            foreach (string phase in new[] { "grab", "carry", "drop" })
            {
                double[] span;
                if (ring.Phases.TryGetValue(phase, out span))
                {
                    Pt a = ring.Position(span[0]), b = ring.Position(span[0] + span[1]);
                    stages.Add(Tuple.Create(span[0], "drag-" + phase, Direction(a, b), Pt.Distance(a, b) > 60));
                }
            }
            if (stages.Count == 0)
                stages.Add(Tuple.Create(0.0, "drag-drop", d, false));
        }
        stages = stages.OrderBy(s => s.Item1).ToList();
        for (int i = 0; i < stages.Count; i++)
        {
            var s = stages[i];
            double start = s.Item1, end = i + 1 < stages.Count ? stages[i + 1].Item1 : ring.Total, time = start;
            string name = s.Item2;
            SpriteEntry entry = p.Entry(name, s.Item3, s.Item4);
            bool hopped = false;
            int index = 0;
            while (true)
            {
                p.Poses.Add(new SpritePose { Time = time, State = name, Entry = entry, Column = entry.Columns[index],
                                             Direction = s.Item3 });
                if (reduced)
                    break;
                time += entry.Ms[index] / 1000;
                index++;
                if (index == entry.Columns.Length)
                {
                    index = 0;
                    if (!entry.Loop)
                    {
                        if (entry.Then == null || hopped)
                            break;
                        hopped = true;
                        name = entry.Then;
                        entry = p.Entry(name, -1, false);
                    }
                }
                if (time >= end - 1e-9)
                    break;
                if (time >= start + 4.8 - 1e-9)
                {
                    var last = p.Poses[p.Poses.Count - 1];
                    if (entry.Loop && (last.Column != entry.Columns[0] || last.Entry.Row != entry.Row))
                        p.Poses.Add(new SpritePose { Time = start + 4.8, State = name, Entry = entry,
                                                     Column = entry.Columns[0], Direction = s.Item3 });
                    break;
                }
            }
        }
        if (p.Poses.Count > 0 && p.Poses[0].Time > 0)
        {
            var head = p.Poses[0];
            p.Poses.Insert(0, new SpritePose { Time = 0, State = head.State, Entry = head.Entry, Column = head.Column,
                                               Direction = head.Direction });
        }
        p.Poses.RemoveAll(pose => pose.Time > ring.Total + 1e-9);
        return p;
    }
    public Pt Origin(Pt at, SpriteEntry entry)
    {
        double w = Character.Frame.Cell.X * entry.Scale, h = Character.Frame.Cell.Y * entry.Scale;
        return new Pt(at.X + 18 + w <= Clip.Right ? at.X + 18 : at.X - 18 - w,
                      at.Y + 18 + h <= Clip.Bottom ? at.Y + 18 : at.Y - 18 - h);
    }
    public Rect Bounds(RingPlan ring)
    {
        var points = new List<Pt>();
        foreach (var at in ring.Positions.Select(s => s.Item2).Concat(new[] { ring.At }))
            foreach (var pose in Poses)
            {
                Pt o = Origin(at, pose.Entry);
                points.Add(o);
                points.Add(new Pt(o.X + Character.Frame.Cell.X * pose.Entry.Scale,
                                  o.Y + Character.Frame.Cell.Y * pose.Entry.Scale));
            }
        return Rect.Box(points, 0);
    }
    public object Json(RingPlan ring, bool reduced)
    {
        if (Poses.Count == 0)
            return null;
        var last = Poses[Poses.Count - 1];
        var samples = Poses
                          .Concat(new[] { new SpritePose { Time = Duration, State = last.State, Entry = last.Entry,
                                                           Column = last.Column, Direction = last.Direction } })
                          .ToArray();
        double length = Math.Max(Duration, .001);
        Func<double, double> unit = time => J.Clamp(time / length, 0, 1);
        Func<SpritePose, double[]> rect = pose =>
        {
            var image = Character.Sheets[pose.Entry.Sheet];
            var cell = Character.Frame.Cell;
            return new[] { (pose.Column * cell.X + .5) / image.Width, (pose.Entry.Row * cell.Y + .5) / image.Height,
                           (cell.X - 1) / image.Width, (cell.Y - 1) / image.Height };
        };
        var times = samples.Select(p => unit(p.Time)).ToArray();
        var moments = ring.Positions.Select(p => p.Item1)
                          .Concat(samples.Select(p => p.Time))
                          .Concat(Poses.Skip(1).Select(p => p.Time - 1e-4).Where(time => time > 0))
                          .Concat(new[] { 0.0, Duration })
                          .Where(time => time >= 0 && time <= Duration)
                          .Distinct()
                          .OrderBy(time => time)
                          .ToArray();
        var positions = moments
                            .Select(time =>
                                    {
                                        var entry = (samples.LastOrDefault(p => p.Time <= time) ?? Poses[0]).Entry;
                                        var point = Origin(ring.Position(time), entry);
                                        if (entry.Flip)
                                            point.X += Character.Frame.Cell.X * entry.Scale;
                                        return point.Json;
                                    })
                            .ToArray();
        return J.Map(
            "duration", Duration, "reduced", reduced, "layers", 1, "calculationMode", "discrete", "keyPath",
            "contentsRect", "values", samples.Select(rect).ToArray(), "times", times, "tracks",
            new object[] { J.Map("keyPath", "contents", "keyTimes", times, "values", samples.Length, "discrete", true),
                           J.Map("keyPath", "contentsRect", "keyTimes", times, "values", samples.Length, "discrete",
                                 true),
                           J.Map("keyPath", "transform", "keyTimes", times, "values", samples.Length, "discrete", true),
                           J.Map("keyPath", "position", "keyTimes", moments.Select(unit).ToArray(), "values",
                                 moments.Length, "discrete", reduced) },
            "positions", positions, "placements",
            Poses
                .Select(p =>
                        {
                            var origin = Origin(ring.Position(p.Time), p.Entry);
                            return new[] { origin.X, origin.Y, Character.Frame.Cell.X * p.Entry.Scale,
                                           Character.Frame.Cell.Y * p.Entry.Scale };
                        })
                .ToArray(),
            "poses",
            Poses
                .Select(p => J.Map("time", p.Time, "state", p.State, "row", p.Entry.Row, "column", p.Column, "sheet",
                                   p.Entry.Sheet, "direction", p.Direction, "flip", p.Entry.Flip, "rect", rect(p)))
                .ToArray());
    }
    public Rect CurrentBounds(RingPlan ring, double time)
    {
        if (Poses.Count == 0) return Rect.Box(new[] {ring.Position(time)},0);
        var pose = Poses.LastOrDefault(p => p.Time <= time) ?? Poses[0];
        var origin = Origin(ring.Position(time),pose.Entry);
        return new Rect(origin.X,origin.Y,Character.Frame.Cell.X*pose.Entry.Scale,Character.Frame.Cell.Y*pose.Entry.Scale);
    }
    public void Draw(Graphics graphics, RingPlan ring, double time, double alpha)
    {
        if (Poses.Count == 0)
            return;
        SpritePose pose = Poses.LastOrDefault(p => p.Time <= time) ?? Poses[0];
        var entry = pose.Entry;
        Pt o = Origin(ring.Position(time), entry);
        double w = Character.Frame.Cell.X, h = Character.Frame.Cell.Y;
        var state = graphics.Save();
        try
        {
            graphics.TranslateTransform((float)(o.X + (entry.Flip ? w * entry.Scale : 0)), (float)o.Y);
            graphics.ScaleTransform((float)(entry.Scale * (entry.Flip ? -1 : 1)), (float)entry.Scale);
            using (var attributes = new ImageAttributes())
            {
                var matrix = new ColorMatrix();
                matrix.Matrix33 = (float)J.Clamp(alpha, 0, 1);
                attributes.SetColorMatrix(matrix);
                attributes.SetWrapMode(System.Drawing.Drawing2D.WrapMode.TileFlipXY);
                var image = Character.Sheets[entry.Sheet].Bitmap;
                var cell = new RectangleF((float)(pose.Column * w), (float)(entry.Row * h), (float)w, (float)h);
                var src = RectangleF.Intersect(new RectangleF(cell.X + .5f, cell.Y + .5f, cell.Width - 1, cell.Height - 1),
                    new RectangleF(0, 0, image.Width, image.Height));
                if (src.Width <= 0 || src.Height <= 0) return;
                graphics.DrawImage(image, new Rectangle(0, 0, (int)w, (int)h), src.X,
                                   src.Y, src.Width, src.Height, GraphicsUnit.Pixel, attributes);
            }
        }
        finally
        {
            graphics.Restore(state);
        }
    }
}
}
