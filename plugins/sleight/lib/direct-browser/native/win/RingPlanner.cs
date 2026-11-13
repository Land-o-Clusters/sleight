using System;
using System.Collections.Generic;
using System.Linq;

namespace Sleight.Cursor
{
// Port of sleight's own RingTheme, SeamTimeline and RingPlanner. Pure data:
// no clock, process, filesystem, graphics or Windows API calls in this module.
public sealed class RingTheme
{
    public string Name = "ring";
    public double[] Warm = { 1, 122.0 / 255, 61.0 / 255, 1 }, Cool = { 91.0 / 255, 141.0 / 255, 1, 1 },
                    Ink = { 11.0 / 255, 13.0 / 255, 20.0 / 255, .55 }, White = { 1, 1, 1, 1 },
                    Error = { 1, 61.0 / 255, 96.0 / 255, 1 };
    public double Silence = 1.2, Fade = .22, Gap = 6, Size = 28, Carry = .42, WaitingCap = 120;
    public bool Wrap = true, Momentum = true, Reach = true, Pixels = true, Caret = true, Burst = true, Seeded = true;
    public static RingTheme For(string name)
    {
        return name == "seam"
                   ? new RingTheme { Name = name,   Fade = .3,      Gap = 8,       Wrap = false,  Momentum = false,
                                     Reach = false, Pixels = false, Caret = false, Burst = false, Seeded = false }
                   : new RingTheme();
    }
}
public static class Seam
{
    public static readonly Func<double, double> Linear = x => x, Out = x => 1 - Math.Pow(1 - x, 3),
                                                CubicIn = x => x * x * x,
                                                InOut = x => x < .5 ? 4 * x * x * x : 1 - Math.Pow(-2 * x + 2, 3) / 2,
                                                Back = x =>
                                                    1 + 2.70158 * Math.Pow(x - 1, 3) + 1.70158 * Math.Pow(x - 1, 2),
                                                QuadIn = x => x * x, QuadOut = x => 1 - (1 - x) * (1 - x);
    public static double Random(ulong seed, long seq, int salt)
    {
        unchecked
        {
            ulong z = seed + (ulong)seq * 0x9E3779B97F4A7C15UL;
            z ^= (ulong)salt * 0xD1B54A32D192ED03UL;
            z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9UL;
            z = (z ^ (z >> 27)) * 0x94D049BB133111EBUL;
            z ^= z >> 31;
            return (z >> 11) / 9007199254740992.0;
        }
    }
    public static Pt[] Points(IEnumerable<Pt> source)
    {
        var outp = new List<Pt>();
        foreach (var p in source)
            if (outp.Count == 0 || !outp[outp.Count - 1].Equals(p))
                outp.Add(p);
        return outp.ToArray();
    }
    public static int Round(double x)
    {
        return (int)Math.Round(x, MidpointRounding.AwayFromZero);
    }
}
public sealed class SeamGeo
{
    public readonly double W, H, R, EW, EH, A, P;
    public SeamGeo(double w, double h, double r)
    {
        W = Math.Max(.5, w);
        H = Math.Max(.5, h);
        R = Math.Max(.01, Math.Min(r, Math.Min(W / 2, H / 2)));
        EW = W - 2 * R;
        EH = H - 2 * R;
        A = Math.PI * R / 2;
        P = 2 * EW + 2 * EH + 4 * A;
    }
    double X
    {
        get {
            return -W / 2;
        }
    }
    double Y
    {
        get {
            return -H / 2;
        }
    }
    double[] Arc(double cx, double cy, double a0, double a1, double ox, double oy)
    {
        double t0 = a0 * Math.PI / 180, t1 = a1 * Math.PI / 180, k = 4.0 / 3 * Math.Tan((t1 - t0) / 4),
               x0 = cx + R * Math.Cos(t0), y0 = cy + R * Math.Sin(t0), x3 = cx + R * Math.Cos(t1),
               y3 = cy + R * Math.Sin(t1);
        return new[] { 4,
                       x0 - k * R * Math.Sin(t0) + ox,
                       y0 + k * R * Math.Cos(t0) + oy,
                       x3 + k * R * Math.Sin(t1) + ox,
                       y3 - k * R * Math.Cos(t1) + oy,
                       x3 + ox,
                       y3 + oy };
    }
    public double[][] Path(double ox, double oy, int laps, bool close = false)
    {
        double s = Math.PI * 225 / 180;
        var result = new List<double[]> { new[] { 0, X + R + R * Math.Cos(s) + ox, Y + R + R * Math.Sin(s) + oy } };
        var lap = new[] { Arc(X + R, Y + R, 225, 270, ox, oy),      new[] { 1, X + W - R + ox, Y + oy },
                          Arc(X + W - R, Y + R, 270, 360, ox, oy),  new[] { 1, X + W + ox, Y + H - R + oy },
                          Arc(X + W - R, Y + H - R, 0, 90, ox, oy), new[] { 1, X + R + ox, Y + H + oy },
                          Arc(X + R, Y + H - R, 90, 180, ox, oy),   new[] { 1, X + ox, Y + R + oy },
                          Arc(X + R, Y + R, 180, 225, ox, oy) };
        for (int i = 0; i < laps; i++)
            result.AddRange(lap);
        if (close)
            result.Add(new double[] { 3 });
        return result.ToArray();
    }
    public double[] Point(double start)
    {
        double s = start % P;
        if (s < 0)
            s += P;
        for (int i = 0; i < 9; i++)
        {
            double length = i == 0 || i == 8 ? A / 2 : i % 2 == 0 ? A : i == 1 || i == 5 ? EW : EH;
            if (s <= length || i == 8)
            {
                double f = length > 0 ? J.Clamp(s / length, 0, 1) : 0;
                if (i % 2 == 0)
                {
                    double cx = i == 2 || i == 4 ? X + W - R : X + R, cy = i == 4 || i == 6 ? Y + H - R : Y + R,
                           from = i == 0 ? 225 : (i / 2) * 90 + 180, span = i == 0 || i == 8 ? 45 : 90,
                           angle = (from % 360 + span * f) * Math.PI / 180;
                    return new[] { cx + R * Math.Cos(angle), cy + R * Math.Sin(angle), Math.Cos(angle),
                                   Math.Sin(angle) };
                }
                if (i == 1)
                    return new[] { X + R + EW * f, Y, 0, -1 };
                if (i == 3)
                    return new[] { X + W, Y + R + EH * f, 1, 0 };
                if (i == 5)
                    return new[] { X + W - R - EW * f, Y + H, 0, 1 };
                return new[] { X, Y + H - R - EH * f, -1, 0 };
            }
            s -= length;
        }
        return new double[4];
    }
    public double Rotation(double x)
    {
        double xx = J.Clamp(x, X + R, X + W - R), bottom = A / 2 + EW + A + EH + A;
        return (bottom + (X + W - R) - xx - P / 2) / P;
    }
}
public sealed class RingLayer
{
    public string Name, Kind = "shape", Parent = "cursor", Text;
    public bool Global, Under, Keyline;
    public double Width;
    public double[] Stroke, Fill, Dash = new double[0];
    public Rect? Frame;
    public Dictionary<string, object> Props = new Dictionary<string, object>();
    public object Json
    {
        get {
            var d = J.Map("name", Name, "kind", Kind, "parent", Parent, "global", Global, "width", Width, "keyline",
                          Keyline, "props", Props);
            if (Stroke != null)
                d["color"] = Stroke;
            if (Fill != null)
                d["fill"] = Fill;
            if (Dash.Length > 0)
                d["dash"] = Dash;
            if (Text != null)
                d["text"] = Text;
            return d;
        }
    }
}
public sealed class RingTrack
{
    public string Layer, Key;
    public double Begin, Duration;
    public object[] Values;
    public double[] Times;
    public object Json
    {
        get {
            return J.Map("layer", Layer, "keyPath", Key, "beginTime", Begin, "duration", Duration, "from", Values[0],
                         "to", Values[Values.Length - 1], "values", Values, "times", Times);
        }
    }
    public object Sample(double t)
    {
        if (t <= Begin)
            return Values[0];
        if (t >= Begin + Duration)
            return Values[Values.Length - 1];
        double q = (t - Begin) / Duration;
        int i = 1;
        while (i < Times.Length - 1 && Times[i] < q)
            i++;
        double f = Times[i] > Times[i - 1] ? (q - Times[i - 1]) / (Times[i] - Times[i - 1]) : 1;
        return Interpolate(Values[i - 1], Values[i], f);
    }
    static object Interpolate(object a, object b, double f)
    {
        if (a is double)
            return (double)a + ((double)b - (double)a) * f;
        var aa = a as double[];
        var bb = b as double[];
        if (aa != null && bb != null)
            return aa.Select((n, i) => n + (bb[i] - n) * f).ToArray();
        var ap = a as double[][];
        var bp = b as double[][];
        if (ap != null && bp != null && ap.Length == bp.Length)
            return ap.Select((row, i) => row.Select((n, k) => k == 0 ? n : n + (bp[i][k] - n) * f).ToArray()).ToArray();
        return f < 1 ? a : b;
    }
}
public sealed class RingChip
{
    public Rect Frame;
    public double[][] Tether;
    public object Json
    {
        get {
            return J.Map("frame", Frame.Json, "tether", Tether);
        }
    }
    public static RingChip Make(string text, Pt at, Rect clip)
    {
        double width = Math.Min(clip.W,
                                Math.Min(240, new System.Globalization.StringInfo(text).LengthInTextElements * 8 + 12)),
               height = Math.Min(16, clip.H);
        bool right = at.X + 18 + width <= clip.Right, above = at.Y - 25 - height >= clip.Y;
        double x = J.Clamp(right ? at.X + 18 : at.X - 18 - width, clip.X, clip.Right - width),
               y = J.Clamp(above ? at.Y - 25 - height : at.Y + 25, clip.Y, clip.Bottom - height);
        return new RingChip { Frame = new Rect(x, y, width, height),
                              Tether = new[] { new[] { 0, at.X + (right ? 11 : -11), at.Y - 11 },
                                               new[] { 1, right ? x : x + width, above ? y + height : y } } };
    }
}
public sealed class RingPlan
{
    public object SpriteJson;
    public string State, Label, OldLabel, Entrance;
    public Pt At;
    public Rect? Rect;
    public RingChip Chip;
    public double? Variation;
    public List<RingLayer> Layers = new List<RingLayer>();
    public List<RingTrack> Tracks = new List<RingTrack>();
    public double Total, Glide, GlideEnd, Fade = .22;
    public bool Dropped;
    public Dictionary<string, double> Shape = new Dictionary<string, double>(),
                                      Budget = new Dictionary<string, double>();
    public Dictionary<string, double[]> Phases = new Dictionary<string, double[]>();
    public List<Pt> Points = new List<Pt>();
    public List<Tuple<double, Pt>> Positions = new List<Tuple<double, Pt>>();
    public List<Tuple<double, string>> Timers = new List<Tuple<double, string>>();
    public Pt Position(double time)
    {
        if (Positions.Count == 0)
            return At;
        if (time <= Positions[0].Item1)
            return Positions[0].Item2;
        for (int i = 1; i < Positions.Count; i++)
            if (time <= Positions[i].Item1)
            {
                var a = Positions[i - 1];
                var b = Positions[i];
                return Pt.Lerp(a.Item2, b.Item2, b.Item1 > a.Item1 ? (time - a.Item1) / (b.Item1 - a.Item1) : 1);
            }
        return Positions[Positions.Count - 1].Item2;
    }
    public Dictionary<string, object> Json
    {
        get {
            return J.Map("state", State, "at", At.Json, "layers", Layers.Select(l => l.Json).ToArray(), "animations",
                         Tracks.Select(a => a.Json).ToArray(), "total", Total, "glide", Glide, "glideEnd", GlideEnd,
                         "dropped", Dropped, "label", Label, "rect", Rect.HasValue? Rect.Value.Json: null, "chip",
                         Chip == null ? null : Chip.Json, "phases", Phases, "timers",
                         Timers.Select(t => new object[] { t.Item1, t.Item2 }).ToArray(), "budget", Budget, "shape",
                         Shape, "entrance", Entrance, "variation", Variation, "sprite", SpriteJson);
        }
    }
}
public sealed class RingContext
{
    public Pt? From, Destination;
    public RingPlan Previous;
    public double Elapsed = Double.PositiveInfinity;
    public bool Reduced, Secure;
    public Rect Clip = new Rect(0, 0, 1000, 1000);
    public ulong Seed = 1;
}
public enum K
{
    o,
    w,
    h,
    rr,
    qz,
    ox,
    oy,
    gap,
    fray,
    rot,
    sep,
    sq,
    sqa,
    tw,
    tc,
    fillO,
    sp,
    ss,
    sr,
    sx,
    sy,
    hol,
    err,
    sh,
    ml,
    ho,
    xo,
    px,
    pstep,
    pdim,
    pdis,
    porb,
    tph,
    pm,
    burst,
    bo,
    bx,
    by,
    bs
}
public sealed class SeamTimeline
{
    public sealed class Tween
    {
        public double Start, Duration, From, To;
        public Func<double, double> Ease;
    }
    public sealed class Move
    {
        public double Start, Duration, UX, UY;
        public Pt A, C, B;
        public bool Windup, Curved;
        public Func<double, double> Ease;
    }
    readonly double[] initial;
    readonly Pt origin;
    readonly List<Tween>[] tweens;
    public readonly List<Move> Moves = new List<Move>();
    public readonly List<double> Marks = new List<double> { 0 };
    public SeamTimeline(double[] initial, Pt origin)
    {
        this.initial = initial;
        this.origin = origin;
        tweens = initial.Select(x => new List<Tween>()).ToArray();
    }
    public double Value(K key, double t)
    {
        var list = tweens[(int)key];
        int i = list.Count - 1;
        while (i >= 0 && list[i].Start > t + 1e-9)
            i--;
        if (i < 0)
            return initial[(int)key];
        var w = list[i];
        return w.Duration <= 0 || t >= w.Start + w.Duration
                   ? w.To
                   : w.From + (w.To - w.From) * w.Ease((t - w.Start) / w.Duration);
    }
    public double[] State(double t)
    {
        return ((K[])Enum.GetValues(typeof(K))).Select(k => Value(k, t)).ToArray();
    }
    public double To(Dictionary<K, double> values, double start, double duration, Func<double, double> ease = null)
    {
        foreach (var p in values)
        {
            var w = new Tween { Start = start, Duration = duration, From = Value(p.Key, start), To = p.Value,
                                Ease = ease ?? Seam.Out };
            var list = tweens[(int)p.Key];
            int i = list.Count;
            while (i > 0 && list[i - 1].Start > start)
                i--;
            list.Insert(i, w);
        }
        Marks.Add(start);
        Marks.Add(start + duration);
        return start + duration;
    }
    public void Set(Dictionary<K, double> values, double time)
    {
        To(values, time, 0, Seam.Linear);
    }
    public void AddMove(Move move)
    {
        Moves.Add(move);
        Marks.Add(move.Start);
        Marks.Add(move.Start + move.Duration);
    }
    Move Current(double t)
    {
        int i = Moves.Count - 1;
        while (i >= 0 && Moves[i].Start > t + 1e-9)
            i--;
        return i >= 0 ? Moves[i] : null;
    }
    public Pt Position(double t)
    {
        var m = Current(t);
        if (m == null)
            return origin;
        if (m.Duration <= 0 || t >= m.Start + m.Duration)
            return m.B;
        double q = m.Ease((t - m.Start) / m.Duration);
        Pt p = Pt.Bezier(m.A, m.C, m.B, q);
        if (m.Windup && q < .18)
        {
            double k = Math.Sin(Math.PI * q / .18) * 2.2;
            p.X -= m.UX * k;
            p.Y -= m.UY * k;
        }
        return p;
    }
    public Pt? Velocity(double t)
    {
        var m = Current(t);
        if (m == null || !m.Curved || m.Duration <= 0 || t >= m.Start + m.Duration)
            return null;
        double t0 = Math.Max(m.Start, t - .004), t1 = Math.Min(m.Start + m.Duration - 1e-6, t + .004);
        if (t1 <= t0)
            return null;
        Pt a = Position(t0), b = Position(t1);
        return new Pt((b.X - a.X) / ((t1 - t0) * 1000), (b.Y - a.Y) / ((t1 - t0) * 1000));
    }
}
public sealed class RingPlanner
{
    static readonly K[] Keys = (K[])Enum.GetValues(typeof(K));
    static readonly string[] Pixels = { "px0", "px1", "px2", "px3" };
    static readonly double[] OrbitHome = { 0, .035, .07, .5, .535, .57 }, OrbitSpeed = { 1, 2, -1, 1, -2, 1 };
    sealed class Segment
    {
        public double Start, Duration;
        public Pt A, C, B;
        public Func<double, double> Ease;
    }
    readonly CursorEvent e;
    readonly RingTheme theme;
    readonly RingContext c;
    readonly SeamTimeline tl;
    readonly Pt[] route;
    double t, glideEnd, glideTime;
    Pt at;
    Rect? wrap;
    string entrance;
    double? variation;
    bool cross;
    double[][] tintPath, markPath;
    readonly Dictionary<string, double[]> phases = new Dictionary<string, double[]>();
    readonly List<Segment> ribbon = new List<Segment>();
    Segment reach;
    static Dictionary<K, double> V(params object[] pairs)
    {
        var d = new Dictionary<K, double>();
        for (int i = 0; i < pairs.Length; i += 2)
            d[(K)pairs[i]] = Convert.ToDouble(pairs[i + 1]);
        return d;
    }
    public RingPlanner(CursorEvent e, RingTheme theme, RingContext context)
    {
        this.e = e;
        this.theme = theme;
        c = context;
        at = e.At ?? c.Destination ?? c.From ?? new Pt();
        route = Seam.Points((c.From.HasValue ? new[] { c.From.Value } : new Pt[0]).Concat(new[] { at }));
        if (!c.From.HasValue && e.Path.Length > 1 && e.State != "drag")
            route = Seam.Points(e.Path.Concat(new[] { at }));
        var initial = new double[Keys.Length];
        foreach (var k in new[] { K.o, K.ss, K.ho })
            initial[(int)k] = 1;
        initial[(int)K.gap] = theme.Gap;
        initial[(int)K.w] = initial[(int)K.h] = theme.Size;
        initial[(int)K.rr] = theme.Size / 2;
        if (c.Previous != null)
            foreach (var k in Keys)
            {
                double value;
                if (c.Previous.Shape.TryGetValue(k.ToString(), out value))
                    initial[(int)k] = value;
            }
        tl = new SeamTimeline(initial, route.Length > 0 ? route[0] : at);
        wrap = c.Previous == null ? null : c.Previous.Rect;
    }
    bool Reduced
    {
        get {
            return c.Reduced;
        }
    }
    double R(int salt)
    {
        return theme.Seeded ? Seam.Random(c.Seed, e.Seq, salt) : .5;
    }
    double Value(K key)
    {
        return tl.Value(key, t);
    }
    bool Wrapped
    {
        get {
            return Math.Max(Value(K.w), Value(K.h)) > theme.Size + 1;
        }
    }
    void Mark(string name, double start)
    {
        phases[name] = new[] { start, t - start };
    }
    Dictionary<K, double> Circle
    {
        get {
            return V(K.w, theme.Size, K.h, theme.Size, K.rr, theme.Size / 2, K.rot, 0, K.gap, theme.Gap, K.ox, 0, K.oy,
                     0, K.qz, 0);
        }
    }
    Dictionary<K, double> Shape(Rect r, double pad, double radius, Dictionary<K, double> extra)
    {
        var d = V(K.w, r.W + pad, K.h, r.H + pad, K.rr, radius, K.ox, r.X + r.W / 2 - at.X, K.oy, r.Y + r.H / 2 - at.Y);
        foreach (var kv in extra)
            d[kv.Key] = kv.Value;
        return d;
    }
    Rect? Target()
    {
        return e.Rect ?? (wrap.HasValue && wrap.Value.Contains(at, 1) ? wrap : null);
    }
    void WrapTo(Dictionary<K, double> values, double duration)
    {
        if (Reduced)
        {
            tl.To(V(K.o, 0), t, .06, Seam.Linear);
            tl.Set(values, t + .06);
            t = tl.To(V(K.o, 1), t + .06, .08, Seam.Linear);
        }
        else
            t = tl.To(values, t, duration);
    }
    public RingPlan Plan()
    {
        if (c.Previous == null)
            Enter();
        else
            Leave(c.Previous.State);
        Glide();
        switch (e.State)
        {
        case "aim":
            Aim();
            break;
        case "click":
            Click();
            break;
        case "double":
            DoubleClick();
            break;
        case "right":
            Right();
            break;
        case "type":
            Type(false);
            break;
        case "key":
            Type(true);
            break;
        case "scroll":
            Scroll();
            break;
        case "drag":
            Drag();
            break;
        case "thinking":
            Thinking();
            break;
        case "waiting":
            Waiting();
            break;
        case "error":
            Error();
            break;
        default:
            Done();
            break;
        }
        return Finish();
    }
    void Enter()
    {
        if (Reduced || !theme.Seeded)
        {
            tl.Set(V(K.o, 0), 0);
            t = tl.To(V(K.o, 1), 0, .12, Seam.Linear);
            entrance = "fade";
            Mark("entrance", 0);
            return;
        }
        int pick = (int)(R(1) * 3) % 3;
        entrance = new[] { "clasp", "assemble", "pop" }[pick];
        if (pick == 0)
        {
            tl.Set(V(K.o, 0, K.sep, 10), 0);
            t = tl.To(V(K.o, 1, K.sep, 0), 0, .18, Seam.Back);
        }
        else if (pick == 1)
        {
            tl.Set(V(K.ho, 0, K.pm, 1, K.px, 1, K.pdis, 1), 0);
            t = tl.To(V(K.pdis, 0), 0, .15);
            t = tl.To(V(K.px, 0, K.ho, 1), t, .07, Seam.Linear);
            tl.Set(V(K.pm, 0), t);
        }
        else
        {
            tl.Set(V(K.fray, 22, K.sp, 1, K.ss, 0), 0);
            tl.To(V(K.ss, 1.4), 0, .09);
            tl.To(V(K.ss, 1, K.sp, 0), .09, .11, Seam.Linear);
            t = tl.To(V(K.fray, 0), 0, .2, Seam.Back);
        }
        Mark("entrance", 0);
    }
    void Leave(string previous)
    {
        if (previous == e.State)
            return;
        double start = t;
        if (previous == "thinking")
            t = tl.To(V(K.fray, 0, K.porb, 0, K.sx, 0, K.sy, 0, K.sp, 0, K.ss, 1, K.o, 1), t, .12);
        else if (previous == "waiting")
            t = tl.To(V(K.ho, 1, K.fray, 0, K.px, 0, K.pdim, 0, K.hol, 0, K.sp, 0, K.ss, 1, K.sep, 0, K.gap, theme.Gap,
                        K.qz, 0),
                      t, .14);
        else if (previous == "error")
            t = tl.To(V(K.err, 0, K.sep, 0, K.xo, 0, K.gap, theme.Gap), t, .16);
        else
            return;
        Mark("exit", start);
    }
    void Glide(Pt[] points = null, bool carry = false)
    {
        points = points ?? route;
        if (points.Length < 2)
            return;
        var lengths = points.Skip(1).Select((p, i) => Pt.Distance(points[i], p)).ToArray();
        double distance = lengths.Sum();
        if (distance < .5)
            return;
        bool snap = !carry && c.Previous != null && c.Elapsed < c.Previous.GlideEnd;
        double duration = carry ? theme.Carry : snap ? .06 : Math.Min(.32, Math.Max(.16, .14 + distance * .00055));
        double start = t;
        bool unwrap = !carry && Wrapped;
        if (unwrap)
        {
            wrap = null;
            if (!Reduced)
                tl.To(Circle, t, .12);
        }
        if (Reduced)
        {
            tl.To(V(K.o, 0), t, .07, Seam.Linear);
            tl.AddMove(new SeamTimeline.Move { Start = t + .07, Duration = 0, A = points[0], C = points[0],
                                               B = points[points.Length - 1], Ease = Seam.Linear });
            if (unwrap)
                tl.Set(Circle, t + .07);
            t = tl.To(V(K.o, 1), t + .07, .07, Seam.Linear);
        }
        else
        {
            double time = t;
            bool momentum = theme.Momentum && !carry && !snap;
            for (int i = 0; i < lengths.Length; i++)
            {
                Pt a = points[i], b = points[i + 1];
                double d = lengths[i], ms = duration * d / distance;
                bool first = i == 0, last = i == lengths.Length - 1;
                if (d <= 0)
                    continue;
                double ux = (b.X - a.X) / d, uy = (b.Y - a.Y) / d, bow = Math.Min(d * .12, 26);
                var control = new Pt((a.X + b.X) / 2 - uy * bow, (a.Y + b.Y) / 2 + ux * bow);
                double over = last && momentum ? Math.Min(4, d * .025) * (.55 + .45 * R(10)) : 0;
                var end = new Pt(b.X + ux * over, b.Y + uy * over);
                Func<double, double> ease = lengths.Length == 1 ? (snap ? Seam.Out : Seam.InOut)
                                            : first             ? Seam.QuadIn
                                            : last              ? Seam.QuadOut
                                                                : Seam.Linear;
                tl.AddMove(new SeamTimeline.Move { Start = time, Duration = ms, A = a, C = control, B = end, UX = ux,
                                                   UY = uy, Windup = first && momentum,
                                                   Curved = theme.Momentum && !snap, Ease = ease });
                ribbon.Add(new Segment { Start = time, Duration = ms, A = a, C = control, B = b, Ease = ease });
                if (last && theme.Reach && !carry && !snap && d >= 30)
                    reach = new Segment {
                        Start = time,
                        Duration = ms,
                        A = new Pt(a.X + theme.Size / 2 * Math.Sqrt(.5), a.Y - theme.Size / 2 * Math.Sqrt(.5)),
                        C = control,
                        B = b,
                        Ease = ease
                    };
                time += ms;
                if (last)
                {
                    tl.Set(V(K.sqa, Math.Atan2(uy, ux)), time);
                    if (momentum)
                    {
                        tl.AddMove(new SeamTimeline.Move { Start = time, Duration = .06, A = end,
                                                           C = Pt.Lerp(end, b, .5), B = b, Ease = Seam.Out });
                        tl.To(V(K.sq, -.12), time, .06);
                        tl.To(V(K.sq, 0), time + .06, .09, Seam.Back);
                    }
                }
            }
            if (theme.Reach && !carry && !snap)
            {
                Pt a = points[0], b = points[points.Length - 1];
                double ux = (b.X - a.X) / distance, uy = (b.Y - a.Y) / distance;
                tl.To(V(K.sx, ux * 3, K.sy, uy * 3, K.sp, .7, K.ss, .7), t, .07);
                tl.To(V(K.sx, 0, K.sy, 0, K.sp, 0, K.ss, 1), t + .07, Math.Max(.06, duration - .07), Seam.InOut);
            }
            t = time;
        }
        at = points[points.Length - 1];
        if (!carry)
        {
            glideEnd = t;
            glideTime = t - start;
            Mark(snap ? "snap" : "glide", start);
        }
        else
            Mark("carry", start);
    }
    void Aim()
    {
        double start = t, hold = e.HoldMs / 1000.0;
        if (e.Rect.HasValue)
        {
            wrap = e.Rect;
            WrapTo(Shape(e.Rect.Value, 8, 7, V(K.gap, 16, K.sp, .55, K.ss, .8, K.sx, 0, K.sy, 0, K.rot, 0, K.qz, 0)),
                   .14);
            Mark("wrap", start);
            Breathe(V(K.qz, -2.5), V(K.qz, 0), 1.2, hold);
        }
        else
        {
            t = tl.To(Reduced ? V(K.gap, 14, K.sp, .55) : V(K.gap, 14, K.qz, -4, K.sp, .55, K.ss, .8), t, .12);
            Mark("open", start);
            Breathe(V(K.qz, -2.6), V(K.qz, -4.4), .9, hold);
        }
    }
    void Breathe(Dictionary<K, double> low, Dictionary<K, double> high, double period, double total)
    {
        if (total <= 0 || Reduced)
            return;
        double start = t, elapsed = 0;
        bool down = true;
        while (elapsed < total - 1e-9)
        {
            double d = Math.Min(period / 2, total - elapsed);
            t = tl.To(down ? low : high, t, d, Seam.InOut);
            elapsed += d;
            down = !down;
        }
        Mark("hold", start);
    }
    void UseTint()
    {
        tintPath = new SeamGeo(Value(K.w), Value(K.h), Value(K.rr)).Path(Value(K.ox), Value(K.oy), 1, true);
    }
    void Click()
    {
        double start = t, value = R(20), q = Wrapped ? 6 : 8;
        bool wide = Wrapped;
        variation = value;
        if (wide)
            UseTint();
        tl.Set(V(K.sr, value * 45), t);
        if (Reduced)
        {
            tl.To(V(K.gap, 0, K.sp, 1, K.fillO, wide ? .25 : 0), t, .06, Seam.Linear);
            t = tl.To(V(K.gap, theme.Gap, K.sp, 0, K.fillO, 0), t + .06, .15);
        }
        else
        {
            tl.To(V(K.gap, 0, K.qz, q, K.sp, 1, K.ss, 1.5 + .4 * value, K.fillO, wide ? .28 : 0, K.sx, 0, K.sy, 0), t,
                  .06, Seam.CubicIn);
            tl.To(V(K.qz, -(1 + 1.6 * value), K.sp, 0, K.ss, 1, K.fillO, 0, K.gap, theme.Gap), t + .06, .09);
            t = tl.To(V(K.qz, 0), t + .15, .06, Seam.InOut);
        }
        Mark("click", start);
    }
    void DoubleClick()
    {
        double start = t, value = R(21), q = Reduced ? 0 : Wrapped ? 6 : 8;
        bool wide = Wrapped;
        variation = value;
        if (wide)
            UseTint();
        tl.Set(V(K.sr, value * 45), t);
        tl.To(V(K.gap, 0, K.qz, q * .8, K.sp, 1, K.ss, Reduced ? 1 : 1.2 + .2 * value, K.fillO, wide ? .2 : 0), t, .05,
              Seam.CubicIn);
        tl.To(V(K.gap, 4, K.qz, q * .1, K.sp, .3, K.ss, 1, K.fillO, wide ? .04 : 0), t + .05, .06);
        tl.To(V(K.gap, 0, K.qz, q, K.sp, 1, K.ss, Reduced ? 1 : 1.7 + .3 * value, K.sr, value * 45 + 45, K.fillO,
                wide ? .3 : 0),
              t + .13, .05, Seam.CubicIn);
        t = tl.To(V(K.gap, theme.Gap, K.qz, 0, K.sp, 0, K.ss, 1, K.fillO, 0), t + .18, .07);
        Mark("double", start);
    }
    void Right()
    {
        double start = t, turn = Value(K.rot), q = Wrapped ? 5 : 6, w = Value(K.w), h = Value(K.h), ox = Value(K.ox),
               oy = Value(K.oy);
        markPath = new[] { new[] { 0, ox + w / 2 + 3, oy + h / 2 - 5 }, new[] { 1, ox + w / 2 + 3, oy + h / 2 + 3 },
                           new[] { 1, ox + w / 2 - 5, oy + h / 2 + 3 } };
        if (Reduced)
        {
            tl.To(V(K.gap, 0, K.ml, 1), t, .09);
            t = tl.To(V(K.gap, theme.Gap, K.ml, 0), t + .09, .13);
        }
        else
        {
            tl.To(V(K.rot, turn + .25, K.gap, 0, K.qz, q, K.ml, 1), t, .09);
            t = tl.To(V(K.rot, turn, K.gap, theme.Gap, K.qz, 0, K.ml, 0), t + .09, .13, Seam.InOut);
        }
        Mark("right", start);
    }
    void Type(bool single)
    {
        double start = t;
        double? caret = !c.Secure && theme.Caret ? e.CaretX : null;
        bool riding = false;
        if (!single)
        {
            var target = Target();
            if (theme.Wrap && target.HasValue)
            {
                wrap = target;
                var values = Shape(target.Value, 8, 7, V(K.gap, 3, K.qz, 0, K.rot, 0, K.sp, 0));
                if (caret.HasValue)
                {
                    double w = values[K.w], h = values[K.h], ox = values[K.ox], oy = values[K.oy],
                           local = caret.Value - at.X - ox;
                    values[K.rot] = new SeamGeo(w, h, 7).Rotation(local);
                    values[K.sx] = ox + J.Clamp(local, -w / 2 + 7, w / 2 - 7);
                    values[K.sy] = oy + h / 2;
                    values[K.sp] = .95;
                    values[K.ss] = .6;
                    riding = true;
                }
                WrapTo(values, .14);
            }
            else
            {
                var values = V(K.qz, Reduced ? 0 : theme.Size - 19, K.gap, 8);
                if (caret.HasValue)
                {
                    values[K.ox] = caret.Value - at.X;
                    riding = true;
                }
                t = tl.To(values, t, .12);
            }
            Mark("enter", start);
        }
        if (c.Secure)
            return;
        double keys = t;
        for (int i = 0; i < (single ? 1 : e.Beats); i++)
        {
            K half = i % 2 == 0 ? K.tw : K.tc;
            if (!Reduced)
            {
                tl.To(V(half, 1.8), t, .025);
                tl.To(V(half, 0), t + .025, .035);
            }
            if (riding && caret.HasValue)
            {
                double x = caret.Value + 5.5 * (i + 1) - at.X;
                if (Wrapped)
                {
                    double w = Value(K.w), local = x - Value(K.ox);
                    tl.To(V(K.rot, new SeamGeo(w, Value(K.h), Value(K.rr)).Rotation(local), K.sx,
                            Value(K.ox) + J.Clamp(local, -w / 2 + 7, w / 2 - 7)),
                          t, .04);
                }
                else
                    tl.To(V(K.ox, x), t, .04);
            }
            t += .06;
        }
        Mark("keys", keys);
    }
    void Scroll()
    {
        double start = t;
        var rect = Target();
        if (theme.Wrap && rect.HasValue)
        {
            wrap = rect;
            WrapTo(Shape(rect.Value, 8, 7, V(K.sp, 0, K.gap, theme.Gap, K.rot, 0, K.qz, 0)), .14);
        }
        else
            t = tl.To(V(K.sp, 0, K.gap, theme.Gap), t, .14);
        Mark("enter", start);
        double turn = Value(K.rot), ticks = t;
        for (int i = 0; i < Math.Min(e.Beats, 4); i++)
        {
            if (!Reduced)
                tl.To(V(K.rot, turn + .035 * (i + 1)), t, .12, Seam.InOut);
            t += .12;
        }
        Mark("ticks", ticks);
        double exit = t;
        t = tl.To(V(K.rot, turn), t, .12);
        Mark("exit", exit);
    }
    void Drag()
    {
        double start = t;
        var rect = Target();
        if (theme.Wrap && rect.HasValue)
        {
            wrap = rect;
            WrapTo(Shape(rect.Value, 4, 6, V(K.gap, 0, K.sp, 0, K.qz, 0)), .12);
        }
        else
            t = tl.To(V(K.gap, 0, K.qz, Reduced ? 0 : 3, K.sp, .9, K.ss, .75), t, .09);
        Mark("grab", start);
        Glide(Seam.Points(new[] { at }.Concat(e.Path)), true);
        double drop = t;
        bool wide = Wrapped;
        if (wide)
            UseTint();
        tl.To(V(K.gap, 14, K.qz, Reduced ? 0 : -8, K.fillO, wide ? .25 : 0, K.sp, 0), t, .09);
        t = tl.To(V(K.gap, theme.Gap, K.qz, 0, K.fillO, 0), t + .09, .11);
        Mark("drop", drop);
    }
    void Thinking()
    {
        double start = t;
        if (!theme.Pixels)
        {
            t = tl.To(V(K.o, .35), t, .12);
            Mark("enter", start);
            return;
        }
        tl.Set(V(K.tph, 0), t);
        t = tl.To(V(K.fray, 4.5, K.porb, 1, K.sp, .8, K.ss, .75), t, .14);
        Mark("enter", start);
        if (Reduced)
            return;
        double cycles = t;
        for (int cycle = 0; cycle < 3; cycle++)
        {
            tl.To(V(K.tph, cycle + 1), t, 1.6, Seam.Linear);
            double elapsed = 0;
            int k = 0;
            while (elapsed + .14 <= 1.6 + 1e-9)
            {
                double angle = R(100 + cycle * 8 + k) * 2 * Math.PI;
                tl.To(V(K.sx, Math.Cos(angle) * 2.6, K.sy, Math.Sin(angle) * 2.6), t + elapsed, .14, Seam.InOut);
                elapsed += .533;
                k++;
            }
            t += 1.6;
        }
        Mark("cycles", cycles);
        double settle = t;
        t = tl.To(V(K.sx, 0, K.sy, 0), t, .16, Seam.InOut);
        Mark("settle", settle);
    }
    void Waiting()
    {
        double start = t;
        if (!theme.Pixels)
        {
            t = tl.To(V(K.gap, 18, K.sep, 5, K.qz, -2, K.sp, 0), t, .16);
            Mark("enter", start);
            return;
        }
        tl.Set(V(K.pm, 0, K.pstep, 0, K.pdim, 1), t);
        t = tl.To(
            V(K.ho, 0, K.fray, 6, K.px, 1, K.sp, .9, K.hol, 1, K.ss, 1.1, K.sx, 0, K.sy, 0, K.gap, theme.Gap, K.qz, 0),
            t, .16);
        Mark("enter", start);
        if (Reduced)
            return;
        double steps = t;
        for (int n = 0; n < 6; n++)
        {
            tl.To(V(K.sy, -1.4), t, .1);
            tl.To(V(K.sy, 0), t + .1, .16, Seam.InOut);
            tl.To(V(K.pstep, (n + 1) / 12.0), t, .2, Seam.InOut);
            t += .8;
        }
        Mark("steps", steps);
    }
    void Error()
    {
        double start = t;
        cross = true;
        tl.To(V(K.err, 1, K.sep, 3.5, K.xo, 1, K.gap, 14, K.sp, 0, K.ho, 1, K.px, 0, K.porb, 0, K.o, 1), t, .09);
        if (!Reduced)
        {
            double s = t;
            foreach (double value in new double[] { 3, -3, 2, -2, 1, 0 })
            {
                tl.To(V(K.sh, value), s, .04, Seam.InOut);
                s += .04;
            }
        }
        t += .24;
        Mark("error", start);
    }
    void Done()
    {
        if (e.State == "done" && e.Ok && theme.Burst && !Reduced)
        {
            double burst = t;
            tl.Set(V(K.bx, Value(K.sx), K.by, Value(K.sy), K.bs, R(30) * 60, K.burst, 0, K.bo, 1), t);
            t = tl.To(V(K.burst, 1), t, .22);
            tl.Set(V(K.bo, 0), t);
            Mark("burst", burst);
        }
        double start = t;
        if (Reduced)
            t = tl.To(V(K.o, 0), t, .38);
        else
        {
            tl.Set(V(K.pm, 1, K.pdis, 0, K.pstep, 0, K.pdim, 0, K.porb, 0), t);
            tl.To(V(K.ho, 0, K.px, 1, K.sp, 0, K.xo, 0), t, .06);
            t = tl.To(V(K.pdis, 1), t + .06, .32);
            tl.Set(V(K.o, 0), t);
        }
        Mark("dissolve", start);
    }

    static double[] Mix(double[] a, double[] b, double f)
    {
        return a.Select((v, i) => v + (b[i] - v) * f).ToArray();
    }
    static double[][] Squares(List<double[]> list)
    {
        if (list.Count == 0)
            return new double [0][];
        var p = new List<double[]>();
        for (int i = 0; i < 6; i++)
        {
            var v = i < list.Count ? list[i] : list[0];
            double x = v[0], y = v[1], s = v[2] / 2;
            p.Add(new[] { 0, x - s, y - s });
            p.Add(new[] { 1, x + s, y - s });
            p.Add(new[] { 1, x + s, y + s });
            p.Add(new[] { 1, x - s, y + s });
            p.Add(new double[] { 3 });
        }
        return p.ToArray();
    }
    double RibbonHead(double time, double[] lengths, double whole)
    {
        double done = 0;
        for (int i = 0; i < ribbon.Count; i++)
        {
            var seg = ribbon[i];
            if (time < seg.Start)
                return done / whole;
            if (time < seg.Start + seg.Duration)
                return (done + seg.Ease((time - seg.Start) / seg.Duration) * lengths[i]) / whole;
            done += lengths[i];
        }
        return 1;
    }
    Dictionary<string, object> Derive(double time, double[] lengths, double whole)
    {
        double[] s = tl.State(time);
        Func<K, double> n = k => s[(int)k];
        var row = new Dictionary<string, object>();
        Action<string, object> put = (name, value) => row.Add(name, value);
        Pt pos = tl.Position(time);
        double o = J.Clamp(n(K.o), 0, 1);
        put("cursor/position", pos.Json);
        put("cursor/opacity", o);
        put("cursor/transform.translation.x", n(K.sh));
        var g = new SeamGeo(n(K.w) - n(K.qz), n(K.h) - n(K.qz), n(K.rr));
        double ox = n(K.ox), oy = n(K.oy), P = g.P, d = Math.Sqrt(.5), sq = n(K.sq), angle = n(K.sqa), lx = 0, ly = 0;
        Pt? velocity = tl.Velocity(time);
        if (velocity.HasValue)
        {
            double vx = velocity.Value.X, vy = velocity.Value.Y, speed = Math.Sqrt(vx * vx + vy * vy),
                   stretch = Math.Min(.28, Math.Max(0, speed * .13));
            sq += stretch;
            if (speed > .05)
                angle = Math.Atan2(vy, vx);
            if (speed > 0)
            {
                double lean = 3 * stretch / .28, along = (vx - vy) * Math.Sqrt(.5) / speed;
                lx = vx / speed * lean * along;
                ly = vy / speed * lean * along;
            }
        }
        double ca = Math.Cos(angle), sa = Math.Sin(angle), kx = 1 + sq, ky = 1 - .6 * sq;
        put("halves/transform", new[] { ca * ca * kx + sa * sa * ky, ca * sa * (kx - ky), ca * sa * (kx - ky),
                                        sa * sa * kx + ca * ca * ky, 0, 0 });
        var path = g.Path(ox, oy, 3);
        double length = P / 2 - n(K.gap) - 2 * n(K.fray), shown = J.Clamp(length > .2 ? n(K.ho) : 0, 0, 1),
               span = Math.Max(length, .001), coolStart = P + J.Clamp(n(K.rot), -.9, .9) * P + n(K.gap) / 2 + n(K.fray);
        foreach (string side in new[] { "C", "W" })
        {
            double begin = coolStart + (side == "C" ? 0 : P / 2);
            var shift = side == "C" ? new[] { lx + d * n(K.sep) - d * n(K.tc), ly - d * n(K.sep) + d * n(K.tc) }
                                    : new[] { -lx - d * n(K.sep) + d * n(K.tw), -ly + d * n(K.sep) - d * n(K.tw) };
            double start = J.Clamp(begin / (3 * P), 0, 1), end = J.Clamp((begin + span) / (3 * P), 0, 1);
            foreach (string layer in new[] { "k", "a" })
            {
                put(layer + side + "/path", path);
                put(layer + side + "/strokeStart", start);
                put(layer + side + "/strokeEnd", end);
                put(layer + side + "/transform.translation", shift);
                put(layer + side + "/opacity", shown);
            }
        }
        put("aW/strokeColor", Mix(theme.Warm, theme.Error, n(K.err)));
        put("aC/strokeColor", Mix(theme.Cool, theme.Error, n(K.err)));
        if (tintPath != null)
            put("tint/opacity", n(K.fillO));
        double ss = n(K.ss), sr = n(K.sr) * Math.PI / 180;
        put("spark/transform",
            new[] { ss * Math.Cos(sr), ss * Math.Sin(sr), -ss * Math.Sin(sr), ss * Math.Cos(sr), n(K.sx), n(K.sy) });
        put("spark/opacity", J.Clamp(n(K.sp), 0, 1));
        put("spark/fillColor", new[] { 1, 1, 1, 1 - .85 * n(K.hol) });
        put("spark/strokeColor", Mix(theme.Ink, theme.White, n(K.hol)));
        if (cross)
            put("cross/opacity", n(K.xo));
        if (markPath != null)
            put("mark/opacity", n(K.ml));
        var spots = new[] { new List<double[]>(), new List<double[]>(), new List<double[]>(), new List<double[]>() };
        var alpha = new double[4];
        double turn = J.Clamp(n(K.rot), -.9, .9) * P;
        if (n(K.bo) > 0 && n(K.burst) < 1)
        {
            for (int k = 0; k < 6; k++)
            {
                double a = (n(K.bs) + k * 60) * Math.PI / 180, r = 5 + 10 * n(K.burst);
                spots[k % 2 == 0 ? 2 : 3].Add(
                    new[] { n(K.bx) + Math.Cos(a) * r, n(K.by) + Math.Sin(a) * r, 2.4 * (1 - .4 * n(K.burst)) });
            }
            alpha[2] = (1 - n(K.burst)) * n(K.bo);
            alpha[3] = alpha[2];
        }
        if (n(K.porb) > 0)
        {
            for (int k = 0; k < 6; k++)
            {
                double f = OrbitHome[k] + n(K.tph) * OrbitSpeed[k];
                var p = g.Point(turn + f * P);
                double lift = 3.2 + 1.2 * Math.Sin(2 * Math.PI * (n(K.tph) * 2 + k / 6.0));
                spots[k < 3 ? 0 : 1].Add(new[] { ox + p[0] + p[2] * lift, oy + p[1] + p[3] * lift, 3 });
            }
            alpha[0] = n(K.porb);
            alpha[1] = n(K.porb);
        }
        else if (n(K.px) > 0)
        {
            bool split = n(K.pm) > .5;
            for (int k = 0; k < 12; k++)
            {
                var p = g.Point(turn + (k / 12.0 + n(K.pstep)) * P);
                bool cool = k < 6;
                double x = ox + p[0], y = oy + p[1];
                if (n(K.pdis) > 0)
                {
                    double m = n(K.pdis) * (8 + Seam.Random(c.Seed, 0, 200 + k) * 16), dir = cool ? 1 : -1;
                    x += dir * m;
                    y -= dir * m;
                }
                spots[split || k % 2 == 0 ? (cool ? 1 : 0) : (cool ? 3 : 2)].Add(new[] { x, y, 3.4 });
            }
            double basis = n(K.px) * (1 - n(K.pdis));
            alpha[0] = basis;
            alpha[1] = basis;
            if (!split)
            {
                alpha[2] = basis * (1 - .75 * n(K.pdim));
                alpha[3] = alpha[2];
            }
        }
        for (int i = 0; i < Pixels.Length; i++)
        {
            put(Pixels[i] + "/opacity", J.Clamp(alpha[i], 0, 1));
            put(Pixels[i] + "/path", spots[i].Count == 0 ? null : Squares(spots[i]));
        }
        if (ribbon.Count > 0 && whole > 0)
        {
            double head = RibbonHead(time, lengths, whole), tail = RibbonHead(time - .17, lengths, whole);
            foreach (string name in new[] { "ribbonW", "ribbonC" })
            {
                put(name + "/strokeEnd", head);
                put(name + "/strokeStart", tail);
                put(name + "/opacity", head - tail > .002 ? o : 0);
            }
        }
        if (reach != null)
        {
            double f = (time - reach.Start) / reach.Duration;
            bool inside = f >= 0 && f <= 1;
            double grow = inside  ? Seam.Out(Math.Min(1, (time - reach.Start) / .06))
                          : f > 1 ? 1
                                  : 0,
                   q = inside  ? reach.Ease(f)
                       : f > 1 ? 1
                               : 0,
                   fade = inside ? (q < .75 ? 1 : (1 - q) / .25) : 0;
            foreach (string name in new[] { "reachInk", "reach" })
            {
                put(name + "/strokeEnd", grow);
                put(name + "/strokeStart", Math.Min(q, grow));
                put(name + "/opacity", fade * (name == "reachInk" ? .3 : .9) * o);
            }
        }
        return row;
    }
    RingPlan Finish()
    {
        var p = new RingPlan { State = e.State, At = at, Label = c.Secure ? null : e.Label, Rect = wrap };
        var lengths = ribbon
                          .Select(seg =>
                                  {
                                      double length = 0;
                                      Pt last = seg.A;
                                      for (int i = 1; i <= 8; i++)
                                      {
                                          Pt point = Pt.Bezier(seg.A, seg.C, seg.B, i / 8.0);
                                          length += Pt.Distance(point, last);
                                          last = point;
                                      }
                                      return length;
                                  })
                          .ToArray();
        double whole = lengths.Sum(), total = Math.Max(t, tl.Marks.Max());
        if (ribbon.Count > 0)
        {
            var last = ribbon[ribbon.Count - 1];
            total = Math.Max(total, last.Start + last.Duration + .17);
        }
        var keys = new HashSet<int>(tl.Marks.Where(x => x <= total + 1e-9).Select(x => Seam.Round(x * 10000)));
        double step = total > 1 ? .025 * 3 : .025;
        for (double s = 0; s < total; s += step)
            keys.Add(Seam.Round(s * 10000));
        foreach (var m in tl.Moves)
            if (m.Duration > 0)
                for (int i = 1; i < 12; i++)
                    keys.Add(Seam.Round((m.Start + m.Duration * i / 12.0) * 10000));
        keys.Add(Seam.Round(total * 10000));
        var times = keys.OrderBy(x => x).Select(x => x / 10000.0).ToArray();
        var rows = times.Select(time => Derive(time, lengths, whole)).ToArray();
        var statics = new Dictionary<string, object>();
        var tracks = new List<RingTrack>();
        foreach (string key in rows[0].Keys.OrderBy(k => k, StringComparer.Ordinal))
        {
            bool changed = false;
            for (int i = 1; i < rows.Length; i++)
                if (!J.Equal(rows[i - 1][key], rows[i][key]))
                {
                    changed = true;
                    break;
                }
            if (!changed)
            {
                if (rows[0][key] != null)
                    statics[key] = rows[0][key];
                continue;
            }
            object known = rows.Select(row => row[key]).FirstOrDefault(v => v != null);
            if (known == null)
                continue;
            var values = new List<object>();
            foreach (var row in rows)
            {
                object v = row[key] ?? (values.Count > 0 ? values[values.Count - 1] : known);
                values.Add(v);
            }
            statics[key] = values[0];
            int change = -1, end = -1;
            for (int i = 1; i < values.Count; i++)
                if (!J.Equal(values[i], values[i - 1]))
                {
                    if (change < 0)
                        change = i;
                    end = i;
                }
            if (change <= 0)
                continue;
            int from = change - 1;
            var kept = new List<int>();
            for (int i = from; i <= end; i++)
                if (i == from || i == end || !J.Equal(values[i], values[i - 1]) || !J.Equal(values[i], values[i + 1]))
                    kept.Add(i);
            double begin = times[from], duration = times[end] - begin;
            string[] parts = key.Split(new[] { '/' }, 2);
            tracks.Add(
                new RingTrack { Layer = parts[0], Key = parts[1], Begin = begin, Duration = duration,
                                Values = kept.Select(i => values[i]).ToArray(),
                                Times = kept.Select(i => duration > 0 ? (times[i] - begin) / duration : 0).ToArray() });
        }
        Func<string, Dictionary<string, object>> props = name =>
            statics.Where(kv => kv.Key.StartsWith(name + "/", StringComparison.Ordinal))
                .ToDictionary(kv => kv.Key.Substring(name.Length + 1), kv => kv.Value);
        var layers = new List<RingLayer> { new RingLayer { Name = "cursor", Kind = "group", Parent = "root",
                                                           Global = true, Props = props("cursor") },
                                           new RingLayer { Name = "halves", Kind = "group", Props = props("halves") } };
        if (tintPath != null)
        {
            var pr = props("tint");
            pr["path"] = tintPath;
            layers.Add(new RingLayer { Name = "tint", Kind = "gradient", Parent = "halves", Props = pr });
        }
        foreach (string name in new[] { "kW", "aW", "kC", "aC" })
            layers.Add(new RingLayer { Name = name, Parent = "halves",
                                       Stroke = name[0] == 'k'   ? theme.Ink
                                                : name[1] == 'W' ? theme.Warm
                                                                 : theme.Cool,
                                       Width = name[0] == 'k' ? 5 : 2.6, Props = props(name) });
        if (markPath != null)
        {
            var pr = props("mark");
            pr["path"] = markPath;
            layers.Add(new RingLayer { Name = "mark", Parent = "halves", Stroke = theme.White, Width = 1.5,
                                       Keyline = true, Props = pr });
        }
        for (int i = 0; i < Pixels.Length; i++)
            if (statics.ContainsKey(Pixels[i] + "/path"))
                layers.Add(new RingLayer { Name = Pixels[i], Stroke = theme.Ink,
                                           Fill = i % 2 == 0 ? theme.Warm : theme.Cool, Width = .8,
                                           Props = props(Pixels[i]) });
        tracks.RemoveAll(tr => Pixels.Contains(tr.Layer) && !statics.ContainsKey(tr.Layer + "/path"));
        var spark = props("spark");
        spark["path"] =
            new double[][] { new double[] { 0, 0, -3.4 }, new double[] { 1, 1, -1 },  new double[] { 1, 3.4, 0 },
                             new double[] { 1, 1, 1 },    new double[] { 1, 0, 3.4 }, new double[] { 1, -1, 1 },
                             new double[] { 1, -3.4, 0 }, new double[] { 1, -1, -1 }, new double[] { 3 } };
        layers.Add(new RingLayer { Name = "spark", Stroke = theme.Ink, Fill = theme.White, Width = .9, Props = spark });
        if (cross)
        {
            var pr = props("cross");
            pr["path"] = new[] { new[] { 0, -3.2, -3.2 }, new[] { 1, 3.2, 3.2 }, new[] { 0, 3.2, -3.2 },
                                 new[] { 1, -3.2, 3.2 } };
            layers.Add(new RingLayer { Name = "cross", Stroke = theme.White, Width = 1.6, Keyline = true, Props = pr });
        }
        if (reach != null)
        {
            var path =
                new[] { new[] { 0, reach.A.X, reach.A.Y }, new[] { 2, reach.C.X, reach.C.Y, reach.B.X, reach.B.Y } };
            foreach (string name in new[] { "reachInk", "reach" })
            {
                var pr = props(name);
                pr["path"] = path;
                layers.Add(new RingLayer { Name = name, Parent = "root", Global = true, Under = true,
                                           Stroke = name == "reachInk" ? theme.Ink : theme.Cool,
                                           Width = name == "reachInk" ? 2.6 : 1.1,
                                           Dash = name == "reach" ? new double[] { 2, 3 } : new double[0],
                                           Props = pr });
            }
        }
        if (ribbon.Count > 0)
        {
            Pt a = ribbon[0].A, b = ribbon[ribbon.Count - 1].B;
            double L = Math.Max(.001, Pt.Distance(a, b)), nx = -(b.Y - a.Y) / L, ny = (b.X - a.X) / L;
            if (-nx + ny < 0)
            {
                nx = -nx;
                ny = -ny;
            }
            foreach (string name in new[] { "ribbonW", "ribbonC" })
            {
                double sign = name == "ribbonW" ? 1 : -1;
                var path = new List<double[]> { new[] { 0, a.X + sign * nx * 2.4, a.Y + sign * ny * 2.4 } };
                foreach (var seg in ribbon)
                    path.Add(new[] { 2, seg.C.X + sign * nx * 2.4, seg.C.Y + sign * ny * 2.4, seg.B.X + sign * nx * 2.4,
                                     seg.B.Y + sign * ny * 2.4 });
                var pr = props(name);
                pr["path"] = path.ToArray();
                layers.Add(new RingLayer { Name = name, Parent = "root", Global = true, Under = true,
                                           Stroke = name == "ribbonW" ? theme.Warm : theme.Cool, Width = 1.4,
                                           Props = pr });
            }
        }
        string previous = c.Secure || c.Previous == null ? null : c.Previous.Label;
        if (!String.IsNullOrEmpty(p.Label))
        {
            var chip = RingChip.Make(p.Label, at, c.Clip);
            p.Chip = chip;
            bool fresh = previous != p.Label;
            layers.Add(new RingLayer { Name = "chip", Kind = "text", Parent = "root", Global = true,
                                       Stroke = theme.White, Fill = theme.Ink, Text = p.Label, Frame = chip.Frame,
                                       Props = J.Map("opacity", fresh ? 0.0 : 1.0) });
            layers.Add(new RingLayer { Name = "tether", Parent = "root", Global = true, Stroke = theme.Ink, Width = 1,
                                       Props = J.Map("path", chip.Tether, "opacity", fresh ? 0.0 : 1.0) });
            if (fresh)
            {
                double begin = String.IsNullOrEmpty(previous) ? 0 : .06;
                foreach (string name in new[] { "chip", "tether" })
                    tracks.Add(new RingTrack { Layer = name, Key = "opacity", Begin = begin, Duration = .09,
                                               Values = new object[] { 0.0, 1.0 }, Times = new double[] { 0, 1 } });
            }
        }
        if (!String.IsNullOrEmpty(previous) && previous != p.Label)
        {
            p.OldLabel = previous;
            foreach (string name in new[] { "oldChip", "oldTether" })
                tracks.Add(new RingTrack { Layer = name, Key = "opacity", Begin = 0, Duration = .06,
                                           Values = new object[] { 1.0, 0.0 }, Times = new double[] { 0, 1 } });
        }
        total = Math.Max(total, tracks.Count > 0 ? tracks.Max(tr => tr.Begin + tr.Duration) : 0);
        p.Layers = layers;
        p.Tracks = tracks;
        p.Total = total;
        p.Glide = glideTime;
        p.GlideEnd = glideEnd;
        p.Fade = theme.Fade;
        p.Phases = phases;
        p.Entrance = entrance;
        p.Variation = variation;
        p.Shape = Keys.ToDictionary(k => k.ToString(), k => tl.Value(k, total));
        for (int i = 0; i < times.Length; i++)
        {
            var xy = (double[])rows[i]["cursor/position"];
            p.Positions.Add(Tuple.Create(times[i], new Pt(xy[0], xy[1])));
        }
        double minX = Double.PositiveInfinity, minY = Double.PositiveInfinity, maxX = Double.NegativeInfinity,
               maxY = Double.NegativeInfinity;
        foreach (var item in p.Positions)
        {
            double time = item.Item1, w = tl.Value(K.w, time) / 2 + 4, h = tl.Value(K.h, time) / 2 + 4,
                   ox = tl.Value(K.ox, time), oy = tl.Value(K.oy, time);
            Pt point = item.Item2;
            minX = Math.Min(minX, point.X + ox - w);
            minY = Math.Min(minY, point.Y + oy - h);
            maxX = Math.Max(maxX, point.X + ox + w);
            maxY = Math.Max(maxY, point.Y + oy + h);
        }
        p.Points = route.ToList();
        if (!Double.IsInfinity(minX))
        {
            p.Points.Add(new Pt(minX, minY));
            p.Points.Add(new Pt(maxX, maxY));
        }
        double quiet = e.State == "waiting" ? Math.Max(total, theme.WaitingCap) : total + theme.Silence;
        p.Timers.Add(Tuple.Create(total, "park"));
        if (e.State == "done" || e.State == "handback")
            p.Timers.Add(Tuple.Create(total, "release"));
        else
        {
            p.Timers.Add(Tuple.Create(quiet, "fade"));
            p.Timers.Add(Tuple.Create(quiet + theme.Fade, "release"));
        }
        double chipCount = String.IsNullOrEmpty(p.Label) ? 0 : 2, oldCount = p.OldLabel == null ? 0 : 2,
               mostVisible = 0, mostAnimated = 0, clickAnimated = 0;
        double[] click;
        phases.TryGetValue("click", out click);
        if (click == null)
            phases.TryGetValue("double", out click);
        if (click == null)
            phases.TryGetValue("right", out click);
        var drawing = layers.Where(l => l.Kind != "group" && l.Kind != "text" && l.Name != "tether").ToArray();
        var groups = tracks.GroupBy(tr => tr.Layer).ToArray();
        for (int i = 0; i < times.Length; i++)
        {
            double time = times[i], opacity = (double)rows[i]["cursor/opacity"],
                   visible = chipCount + (time < .06 ? oldCount : 0);
            foreach (var layer in drawing)
            {
                object raw;
                if (!rows[i].TryGetValue(layer.Name + "/opacity", out raw) || raw == null)
                    layer.Props.TryGetValue("opacity", out raw);
                double alpha = raw == null ? 1 : (double)raw;
                if (alpha * (layer.Global ? 1 : opacity) > .01)
                    visible++;
            }
            mostVisible = Math.Max(mostVisible, visible);
            double active =
                groups.Count(group => group.Any(tr => tr.Begin <= time + 1e-9 && time < tr.Begin + tr.Duration - 1e-9));
            mostAnimated = Math.Max(mostAnimated, active);
            if (click != null && time >= click[0] - 1e-9 && time <= click[0] + click[1] + 1e-9)
                clickAnimated = Math.Max(clickAnimated, active);
        }
        p.Budget = new Dictionary<string, double> { { "layers", layers.Count + (tintPath == null ? 0 : 1) + oldCount },
                                                    { "visible", mostVisible },
                                                    { "animated", mostAnimated },
                                                    { "clickAnimated", clickAnimated },
                                                    { "samples", times.Length } };
        return p;
    }
}

public sealed class RingSession
{
    public Pt? Point;
    public int Pid;
    public uint Window;
    public RingPlan Previous;
    public double Began;
    public void Reset()
    {
        Point = null;
        Pid = 0;
        Window = 0;
        Previous = null;
    }
    public RingPlan Plan(CursorEvent e, RingTheme theme, double now, bool reduced, bool secure, Rect clip, ulong seed)
    {
        bool same = Pid == e.Pid && Window == e.Window;
        double elapsed = now - Began;
        RingPlan live = same && Previous != null && Previous.Shape["o"] > .01 && Previous.State != "done" &&
                                Previous.State != "handback"
                            ? Previous
                            : null;
        Pt? from = same ? Point : null;
        if (live != null && elapsed < live.GlideEnd)
            from = live.Position(elapsed);
        if (!e.At.HasValue && !from.HasValue)
            return new RingPlan { State = e.State, Dropped = true };
        var c = new RingContext { From = from,       Destination = same ? Point : null,
                                  Previous = live,   Elapsed = elapsed,
                                  Reduced = reduced, Secure = secure,
                                  Clip = clip,       Seed = seed };
        var p = new RingPlanner(e, theme, c).Plan();
        Point = p.At;
        Pid = e.Pid;
        Window = e.Window;
        Previous = p;
        Began = now;
        return p;
    }
}
public sealed class RingEffect
{
    public double Time, Duration;
    public string Kind, State;
    public RingPlan Plan;
    public Rect Frame;
    public Dictionary<string, object> Json
    {
        get {
            if (Kind == "draw")
            {
                var d = Plan.Json;
                d["effect"] = Kind;
                d["time"] = Time;
                d["frame"] = Frame.Json;
                return d;
            }
            if (Kind == "drop")
                return J.Map("effect", Kind, "state", State, "dropped", true, "animations", new object[0], "time",
                             Time);
            if (Kind == "hide")
                return J.Map("effect", Kind, "state", "hidden", "time", Time);
            if (Kind == "fade")
                return J.Map("effect", Kind, "duration", Duration, "time", Time);
            return J.Map("effect", Kind, "time", Time);
        }
    }
}
public sealed class RingRuntime
{
    public RingTheme Theme;
    public ulong Seed;
    public readonly RingSession Session = new RingSession();
    public bool Shown;
    public double Fade = .22;
    public readonly List<Tuple<double, CursorEvent>> Pending = new List<Tuple<double, CursorEvent>>();
    public readonly List<Tuple<double, string>> Timers = new List<Tuple<double, string>>();
    public Func<int, uint, Rect?> Bounds;
    public Func<RingPlan, Rect, Rect?> ExtraBounds;
    public Func<bool> Reduced = () => false, Secure = () => false;
    public RingRuntime(RingTheme theme, ulong seed)
    {
        Theme = theme;
        Seed = seed;
    }
    public bool Idle
    {
        get {
            return Pending.Count == 0 && Timers.Count == 0 && !Shown;
        }
    }
    public double? Next
    {
        get {
            var all = Pending.Select(p => p.Item1).Concat(Timers.Select(p => p.Item1)).ToArray();
            return all.Length > 0?(double?)all.Min() : null;
        }
    }
    public List<RingEffect> Receive(CursorEvent e, double delay, double now)
    {
        var list = Advance(now);
        bool terminal = new[] { "error", "done", "handback" }.Contains(e.State);
        if (terminal)
            Pending.Clear();
        if (HostFrame.Kinds.Contains(e.State) && delay > 0 || !terminal && Pending.Count > 0)
        {
            if (Pending.Count < 64)
                Pending.Add(
                    Tuple.Create(Math.Max(now + delay, Pending.Count > 0 ? Pending.Max(p => p.Item1) : now), e));
            return list;
        }
        list.AddRange(Draw(e, now));
        return list;
    }
    public List<RingEffect> Hide(double now)
    {
        Pending.Clear();
        Timers.Clear();
        Session.Reset();
        Shown = false;
        return new List<RingEffect> { new RingEffect { Kind = "hide", Time = now } };
    }
    public List<RingEffect> Advance(double now)
    {
        var list = new List<RingEffect>();
        while (Next.HasValue && Next.Value <= now)
        {
            double due = Next.Value;
            var item = Pending.OrderBy(p => p.Item1).FirstOrDefault();
            if (item != null && item.Item1 == due && !Timers.Any(p => p.Item1 < due))
            {
                Pending.Remove(item);
                list.AddRange(Draw(item.Item2, due));
                continue;
            }
            var timer = Timers.OrderBy(p => p.Item1).First();
            Timers.Remove(timer);
            if (timer.Item2 == "park")
                list.Add(new RingEffect { Kind = "park", Time = timer.Item1 });
            else if (timer.Item2 == "fade")
                list.Add(new RingEffect { Kind = "fade", Time = timer.Item1, Duration = Fade });
            else
            {
                Shown = false;
                Session.Reset();
                Timers.Clear();
                list.Add(new RingEffect { Kind = "release", Time = timer.Item1 });
            }
        }
        return list;
    }
    List<RingEffect> Draw(CursorEvent e, double now)
    {
        bool known = Session.Pid == e.Pid && Session.Window == e.Window && Session.Point.HasValue;
        if (!e.At.HasValue && !known)
            return new List<RingEffect> { new RingEffect { Kind = "drop", State = e.State, Time = now } };
        var last = Session.Previous;
        if (known && HostFrame.Statuses.Contains(e.State) && last != null && last.State == e.State &&
            (!e.At.HasValue || e.At.Value.Equals(last.At)) && e.Label == last.Label && now - Session.Began < last.Total)
            return new List<RingEffect>();
        Rect? clip = Bounds(e.Pid, e.Window);
        if (!clip.HasValue)
            return Hide(now);
        var p = Session.Plan(e, Theme, now, Reduced(), Secure(), clip.Value, Seed);
        if (p.Dropped)
            return new List<RingEffect> { new RingEffect { Kind = "drop", State = e.State, Time = now } };
        var points = p.Points.Concat(new[] { p.At }).ToList();
        if (p.Chip != null)
        {
            points.Add(new Pt(p.Chip.Frame.X, p.Chip.Frame.Y));
            points.Add(new Pt(p.Chip.Frame.Right, p.Chip.Frame.Bottom));
        }
        Rect frame = Rect.Box(points);
        Rect? extra = ExtraBounds == null ? null : ExtraBounds(p, clip.Value);
        if (extra.HasValue)
            frame = frame.Union(extra.Value);
        frame = frame.Intersect(clip.Value);
        if (frame.W < 1 || frame.H < 1)
            return Hide(now);
        Timers.Clear();
        Timers.AddRange(p.Timers.Select(item => Tuple.Create(now + item.Item1, item.Item2)));
        Fade = p.Fade;
        Shown = true;
        return new List<RingEffect> { new RingEffect { Kind = "draw", Plan = p, Frame = frame, Time = now } };
    }
}
}
