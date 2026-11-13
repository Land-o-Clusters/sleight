// .NET Framework 4.8 / in-box C# 5 compiler. No UI dependency in protocol or planner.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

namespace Sleight.Cursor
{
public static class J
{
    public static readonly JavaScriptSerializer Serializer =
        new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024, RecursionLimit = 100 };
    public static Dictionary<string, object> Map(params object[] pairs)
    {
        var d = new Dictionary<string, object>();
        for (int i = 0; i < pairs.Length; i += 2)
            d.Add((string)pairs[i], pairs[i + 1]);
        return d;
    }
    public static object Get(Dictionary<string, object> d, string key)
    {
        object v;
        return d.TryGetValue(key, out v) ? v : null;
    }
    public static double Number(object o)
    {
        if (!(o is int || o is long || o is double || o is decimal || o is float))
            throw new FrameFault();
        double n = Convert.ToDouble(o, CultureInfo.InvariantCulture);
        if (Double.IsNaN(n) || Double.IsInfinity(n))
            throw new FrameFault();
        return n;
    }
    public static double N(object o, double low, double high)
    {
        double n = Number(o);
        if (n < low || n > high)
            throw new FrameFault();
        return n;
    }
    public static long Integer(object o, double low, double high)
    {
        double n = N(o, low, high);
        if (n != Math.Truncate(n))
            throw new FrameFault();
        return (long)n;
    }
    public static string S(object o)
    {
        var s = o as string;
        if (s == null)
            throw new FrameFault();
        return s;
    }
    public static bool B(object o)
    {
        if (!(o is bool))
            throw new FrameFault();
        return (bool)o;
    }
    public static object[] A(object o)
    {
        var a = o as object[];
        if (a == null)
        {
            var list = o as ArrayList;
            if (list != null)
                a = list.ToArray();
        }
        if (a == null)
            throw new FrameFault();
        return a;
    }
    public static Dictionary<string, object> D(object o)
    {
        var d = o as Dictionary<string, object>;
        if (d == null)
            throw new FrameFault();
        return d;
    }
    public static void Keys(Dictionary<string, object> d, string required, string optional = "")
    {
        var r = required.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
        var allowed =
            new HashSet<string>(r.Concat(optional.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)));
        if (r.Any(k => !d.ContainsKey(k)) || d.Keys.Any(k => !allowed.Contains(k)))
            throw new FrameFault();
    }
    public static bool Equal(object a, object b)
    {
        if (Object.ReferenceEquals(a, b))
            return true;
        if (a == null || b == null)
            return false;
        var aa = a as Array;
        var bb = b as Array;
        if (aa != null && bb != null)
        {
            if (aa.Length != bb.Length)
                return false;
            for (int i = 0; i < aa.Length; i++)
                if (!Equal(aa.GetValue(i), bb.GetValue(i)))
                    return false;
            return true;
        }
        return a.Equals(b);
    }
    public static double Clamp(double x, double lo, double hi)
    {
        return Math.Min(hi, Math.Max(lo, x));
    }
    public static Pt Point(object o)
    {
        var a = A(o);
        if (a.Length != 2)
            throw new FrameFault();
        return new Pt(N(a[0], -100000, 100000), N(a[1], -100000, 100000));
    }
    public static Rect Rectangle(object o)
    {
        var a = A(o);
        if (a.Length != 4)
            throw new FrameFault();
        double w = N(a[2], 0, 100000), h = N(a[3], 0, 100000);
        if (w == 0 || h == 0)
            throw new FrameFault();
        return new Rect(N(a[0], -100000, 100000), N(a[1], -100000, 100000), w, h);
    }
}
public sealed class FrameFault : Exception
{
}
public struct Pt
{
    public double X, Y;
    public Pt(double x, double y)
    {
        X = x;
        Y = y;
    }
    public double[] Json
    {
        get {
            return new[] { X, Y };
        }
    }
    public static double Distance(Pt a, Pt b)
    {
        return Math.Sqrt((a.X - b.X) * (a.X - b.X) + (a.Y - b.Y) * (a.Y - b.Y));
    }
    public static Pt Lerp(Pt a, Pt b, double f)
    {
        return new Pt(a.X + (b.X - a.X) * f, a.Y + (b.Y - a.Y) * f);
    }
    public static Pt Bezier(Pt a, Pt c, Pt b, double q)
    {
        double u = 1 - q;
        return new Pt(u * u * a.X + 2 * u * q * c.X + q * q * b.X, u * u * a.Y + 2 * u * q * c.Y + q * q * b.Y);
    }
}
public struct Rect
{
    public double X, Y, W, H;
    public Rect(double x, double y, double w, double h)
    {
        X = x;
        Y = y;
        W = w;
        H = h;
    }
    public double Right
    {
        get {
            return X + W;
        }
    }
    public double Bottom
    {
        get {
            return Y + H;
        }
    }
    public double[] Json
    {
        get {
            return new[] { X, Y, W, H };
        }
    }
    public bool Contains(Pt p, double pad = 0)
    {
        return p.X >= X - pad && p.X < Right + pad && p.Y >= Y - pad && p.Y < Bottom + pad;
    }
    public Rect Intersect(Rect r)
    {
        double x = Math.Max(X, r.X), y = Math.Max(Y, r.Y);
        return new Rect(x, y, Math.Max(0, Math.Min(Right, r.Right) - x), Math.Max(0, Math.Min(Bottom, r.Bottom) - y));
    }
    public Rect Union(Rect r)
    {
        double x = Math.Min(X, r.X), y = Math.Min(Y, r.Y);
        return new Rect(x, y, Math.Max(Right, r.Right) - x, Math.Max(Bottom, r.Bottom) - y);
    }
    public static Rect Box(IEnumerable<Pt> points, double pad = 48)
    {
        var p = points.ToArray();
        double x = p.Min(v => v.X), y = p.Min(v => v.Y);
        return new Rect(x - pad, y - pad, p.Max(v => v.X) - x + 2 * pad, p.Max(v => v.Y) - y + 2 * pad);
    }
}
public sealed class CursorEvent
{
    public long Seq;
    public string State, Label;
    public int Pid;
    public uint Window;
    public Pt? At;
    public Rect? Rect;
    public Pt[] Path = new Pt[0];
    public int Beats = 1, HoldMs;
    public double? CaretX;
    public bool Ok;
}
public sealed class HostFrame
{
    public string Tag, Nonce, Capture;
    public bool Enabled;
    public double Delay;
    public CursorEvent Event;
    public CharacterFrame Character;
    public static readonly HashSet<string> Kinds =
        new HashSet<string>(new[] { "click", "double", "right", "key", "type", "drag", "scroll" });
    public static readonly HashSet<string> Statuses =
        new HashSet<string>(new[] { "waiting", "error", "done", "handback", "thinking" });
    public static string Label(string text)
    {
        var kept = new StringBuilder();
        for (int i = 0; i < text.Length; i++)
        {
            var category = CharUnicodeInfo.GetUnicodeCategory(text, i);
            int length =
                Char.IsHighSurrogate(text[i]) && i + 1 < text.Length && Char.IsLowSurrogate(text[i + 1]) ? 2 : 1;
            if (category != UnicodeCategory.Control && category != UnicodeCategory.Format &&
                category != UnicodeCategory.LineSeparator && category != UnicodeCategory.ParagraphSeparator &&
                category != UnicodeCategory.Surrogate && category != UnicodeCategory.PrivateUse &&
                category != UnicodeCategory.OtherNotAssigned)
                kept.Append(text, i, length);
            i += length - 1;
        }
        var result = new StringBuilder();
        var elements = StringInfo.GetTextElementEnumerator(kept.ToString());
        int count = 0, scalars = 0;
        while (count < 40 && elements.MoveNext())
        {
            string s = elements.GetTextElement();
            int n = 0;
            for (int i = 0; i < s.Length; i++, n++)
                if (Char.IsHighSurrogate(s[i]) && i + 1 < s.Length && Char.IsLowSurrogate(s[i + 1]))
                    i++;
            if (scalars + n > 80)
                break;
            result.Append(s);
            scalars += n;
            count++;
        }
        return result.ToString();
    }
    public static HostFrame Parse(Dictionary<string, object> d)
    {
        var f = new HostFrame { Tag = J.S(J.Get(d, "hand")), Nonce = J.S(J.Get(d, "nonce")) };
        if (!Regex.IsMatch(f.Nonce, "\\A[0-9a-f]{64}\\z"))
            throw new FrameFault();
        if (f.Tag == "hide")
        {
            J.Keys(d, "hand nonce");
            return f;
        }
        if (f.Tag == "character")
        {
            f.Character = CharacterFrame.Parse(d);
            return f;
        }
        if (f.Tag == "menu")
        {
            J.Keys(d, "hand nonce enabled capture version", "permissions usage");
            // Windows has no menu UI. Admit only object-shaped optional menu data,
            // bound by the 8 KiB frame limit, then discard it without displaying it.
            if (d.ContainsKey("permissions")) J.D(d["permissions"]);
            if (d.ContainsKey("usage")) J.D(d["usage"]);
            f.Enabled = J.B(d["enabled"]);
            f.Capture = J.S(d["capture"]);
            if (!new[] { "hidden", "visible" }.Contains(f.Capture) ||
                !Regex.IsMatch(J.S(d["version"]), "\\A[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\z"))
                throw new FrameFault();
            return f;
        }
        if (f.Tag == "act")
            J.Keys(d, "hand nonce seq kind pid windowId at path delayMs beats", "label rect caretX");
        else if (f.Tag == "aim")
            J.Keys(d, "hand nonce seq kind pid windowId at", "rect holdMs label");
        else if (f.Tag == "status")
            J.Keys(d, "hand nonce seq state pid windowId", "at ok");
        else
            throw new FrameFault();
        var e = new CursorEvent { Seq = J.Integer(d["seq"], 0, 9007199254740991),
                                  Pid = (int)J.Integer(d["pid"], 1, 2147483647),
                                  Window = (uint)J.Integer(d["windowId"], 1, 4294967295) };
        if (d.ContainsKey("at"))
            e.At = J.Point(d["at"]);
        if (d.ContainsKey("rect"))
            e.Rect = J.Rectangle(d["rect"]);
        if (d.ContainsKey("label"))
            e.Label = Label(J.S(d["label"]));
        if (f.Tag == "status")
        {
            e.State = J.S(d["state"]);
            if (!Statuses.Contains(e.State))
                throw new FrameFault();
            if (d.ContainsKey("ok"))
            {
                if (e.State != "done")
                    throw new FrameFault();
                e.Ok = J.B(d["ok"]);
            }
        }
        else
        {
            string kind = J.S(d["kind"]);
            if (!Kinds.Contains(kind))
                throw new FrameFault();
            e.State = f.Tag == "aim" ? "aim" : kind;
        }
        if (f.Tag == "aim" && d.ContainsKey("holdMs"))
            e.HoldMs = (int)J.Integer(d["holdMs"], 0, 600);
        if (f.Tag == "act")
        {
            var path = J.A(d["path"]);
            if (path.Length < 1 || path.Length > 64)
                throw new FrameFault();
            e.Path = path.Select(J.Point).ToArray();
            f.Delay = J.Integer(d["delayMs"], 0, 10000) / 1000.0;
            e.Beats = (int)J.Integer(d["beats"], 1, 20);
            if (d.ContainsKey("caretX"))
            {
                if (e.State != "type" && e.State != "key")
                    throw new FrameFault();
                e.CaretX = J.N(d["caretX"], -100000, 100000);
            }
        }
        f.Event = e;
        return f;
    }
}
public sealed class FrameReader
{
    readonly Stream input;
    readonly UTF8Encoding utf8 = new UTF8Encoding(false, true);
    string nonce;
    long last = -1;
    public FrameReader(Stream input)
    {
        this.input = new BufferedStream(input, 16384);
    }
    public Dictionary<string, object> Read()
    {
        var bytes = new List<byte>();
        int b;
        while ((b = input.ReadByte()) != -1 && b != 10)
        {
            if (bytes.Count >= 32768)
                throw new FrameFault();
            bytes.Add((byte)b);
        }
        if (b == -1)
        {
            if (bytes.Count > 0)
                throw new FrameFault();
            return null;
        }
        var d = J.D(J.Serializer.DeserializeObject(utf8.GetString(bytes.ToArray())));
        if (bytes.Count > 8192 && J.Get(d, "hand") as string != "character")
            throw new FrameFault();
        return d;
    }
    public HostFrame Bind(Dictionary<string, object> d)
    {
        var f = HostFrame.Parse(d);
        if (nonce != null && nonce != f.Nonce)
            throw new FrameFault();
        nonce = f.Nonce;
        long? seq = f.Event != null ? (long?)f.Event.Seq : f.Character != null ? (long?)f.Character.Seq : null;
        if (seq.HasValue)
        {
            if (seq.Value <= last)
                throw new FrameFault();
            last = seq.Value;
        }
        return f;
    }
}
}
