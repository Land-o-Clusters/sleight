using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace Sleight.Cursor
{
static class Win
{
    public const int Layered = 0x80000, Transparent = 0x20, ToolWindow = 0x80, NoActivate = 0x08000000,
                     Popup = unchecked((int)0x80000000);
    public const uint ExcludeCapture = 0x11, ExtendedFrameBounds = 9, Cloaked = 14;
    [StructLayout(LayoutKind.Sequential)]
    public struct Rectangle
    {
        public int Left, Top, Right, Bottom;
        public Rect Value
        {
            get {
                return new Rect(Left, Top, Right - Left, Bottom - Top);
            }
        }
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct Point
    {
        public int X, Y;
        public Point(int x, int y)
        {
            X = x;
            Y = y;
        }
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct Size
    {
        public int W, H;
        public Size(int w, int h)
        {
            W = w;
            H = h;
        }
    }
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    public struct Blend
    {
        public byte Op, Flags, Alpha, Format;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct OsVersion
    {
        public uint Size, Major, Minor, Build, Platform;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string ServicePack;
    }
    public delegate void EventProc(IntPtr hook, uint ev, IntPtr hwnd, int objectId, int child, uint thread, uint time);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")]
    public static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")]
    public static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
    [DllImport("user32.dll")]
    public static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hwnd, uint attr, out Rectangle rect, int size);
    [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")]
    public static extern int DwmGetCloaked(IntPtr hwnd, uint attr, out uint value, int size);
    [DllImport("dwmapi.dll")]
    public static extern int DwmIsCompositionEnabled(out bool enabled);
    [DllImport("ntdll.dll", CharSet = CharSet.Unicode)]
    public static extern int RtlGetVersion(ref OsVersion version);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PostMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern IntPtr SetWinEventHook(uint first, uint last, IntPtr module, EventProc proc, uint process,
                                                uint thread, uint flags);
    [DllImport("user32.dll")]
    public static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")]
    public static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")]
    public static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")]
    public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")]
    public static extern bool DeleteDC(IntPtr dc);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr dst, ref Point position, ref Size size,
                                                  IntPtr source, ref Point origin, uint key, ref Blend blend,
                                                  uint flags);
    [DllImport("user32.dll")]
    public static extern bool SystemParametersInfo(uint action, uint param, out bool value, uint flags);
    public static bool Reduced()
    {
        bool animation;
        return !SystemParametersInfo(0x1042, 0, out animation, 0) || !animation;
    }
    public static Rect? Bounds(int expected, uint window)
    {
        IntPtr hwnd = new IntPtr((long)window);
        uint pid, cloak;
        if (GetWindowThreadProcessId(hwnd, out pid) == 0 || pid != expected || !IsWindowVisible(hwnd) ||
            IsIconic(hwnd) || DwmGetCloaked(hwnd, Cloaked, out cloak, 4) != 0 || cloak != 0)
            return null;
        Rectangle rect;
        if (DwmGetWindowAttribute(hwnd, ExtendedFrameBounds, out rect, Marshal.SizeOf(typeof(Rectangle))) != 0 ||
            rect.Right <= rect.Left || rect.Bottom <= rect.Top)
            return null;
        uint second;
        if (GetWindowThreadProcessId(hwnd, out second) == 0 || second != pid)
            return null;
        return rect.Value;
    }
    public static void AssertLayout()
    {
        if (Marshal.SizeOf(typeof(OsVersion)) != 276)
            throw new InvalidOperationException("WINDOWS_VERSION_LAYOUT");
    }
    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr hwnd);
    public static void Initialize(bool hidden)
    {
        var v = new OsVersion { Size = (uint)Marshal.SizeOf(typeof(OsVersion)) };
        if (RtlGetVersion(ref v) != 0 || v.Major < 10 || hidden && v.Build < 19041)
            throw new InvalidOperationException("WINDOWS_VERSION_UNSUPPORTED");
        bool composition;
        if (DwmIsCompositionEnabled(out composition) != 0 || !composition)
            throw new InvalidOperationException("WINDOWS_COMPOSITION_REQUIRED");
        if (!SetProcessDpiAwarenessContext(new IntPtr(-4)) &&
            !AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4)))
            throw new InvalidOperationException("WINDOWS_DPI_UNAVAILABLE");
    }
}
sealed class OverlayWindow : NativeWindow, IDisposable
{
    readonly Action changed;
    Bitmap bitmap;
    IntPtr dc, dib, selected;
    int capacityW, capacityH;
    [StructLayout(LayoutKind.Sequential)]
    struct BitmapInfo
    {
        public uint Size; public int Width, Height; public ushort Planes, Bits;
        public uint Compression, ImageSize; public int XPels, YPels; public uint Colors, Important;
    }
    [DllImport("gdi32.dll")]
    static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfo info, uint usage, out IntPtr bits, IntPtr section, uint offset);
    public OverlayWindow(bool hidden, Action changed)
    {
        this.changed = changed;
        CreateHandle(new CreateParams { Caption = "sleight agent cursor", Style = Win.Popup,
                                        ExStyle = Win.Layered | Win.Transparent | Win.ToolWindow | Win.NoActivate });
        try
        {
            SetCapture(hidden);
        }
        catch
        {
            DestroyHandle();
            throw;
        }
    }
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x84)
        {
            m.Result = new IntPtr(-1);
            return;
        }
        if (m.Msg == 0x21)
        {
            m.Result = new IntPtr(3);
            return;
        }
        if (m.Msg == 0x7e || m.Msg == 0x2e0) changed();
        base.WndProc(ref m);
    }
    public void SetCapture(bool hidden)
    {
        if (hidden)
        {
            var version = new Win.OsVersion { Size = (uint)Marshal.SizeOf(typeof(Win.OsVersion)) };
            if (Win.RtlGetVersion(ref version) != 0 || version.Major < 10 || version.Build < 19041)
                throw new InvalidOperationException("WINDOWS_CAPTURE_EXCLUSION_UNPROVED");
        }
        uint expected = hidden ? Win.ExcludeCapture : 0, actual;
        if (!Win.SetWindowDisplayAffinity(Handle, expected) || !Win.GetWindowDisplayAffinity(Handle, out actual) ||
            actual != expected)
            throw new InvalidOperationException("WINDOWS_CAPTURE_EXCLUSION_UNPROVED");
    }
    void ReleaseSurface()
    {
        if (bitmap != null) { bitmap.Dispose(); bitmap = null; }
        if (selected != IntPtr.Zero) Win.SelectObject(dc, selected);
        if (dib != IntPtr.Zero) Win.DeleteObject(dib);
        if (dc != IntPtr.Zero) Win.DeleteDC(dc);
        dc = dib = selected = IntPtr.Zero;
    }
    public Bitmap Surface(int width, int height)
    {
        if (bitmap != null && width <= capacityW && height <= capacityH) return bitmap;
        ReleaseSurface();
        int nextW = Math.Max(capacityW, (width + 63) / 64 * 64);
        int nextH = Math.Max(capacityH, (height + 63) / 64 * 64);
        capacityW = (long)nextW * nextH <= 16000000 ? nextW : (width + 63) / 64 * 64;
        capacityH = (long)nextW * nextH <= 16000000 ? nextH : (height + 63) / 64 * 64;
        if ((long)capacityW * capacityH > 16000000) throw new InvalidOperationException("WINDOWS_SURFACE_TOO_LARGE");
        var info = new BitmapInfo { Size = (uint)Marshal.SizeOf(typeof(BitmapInfo)), Width = capacityW,
            Height = -capacityH, Planes = 1, Bits = 32 };
        IntPtr bits;
        dc = Win.CreateCompatibleDC(IntPtr.Zero);
        dib = CreateDIBSection(dc, ref info, 0, out bits, IntPtr.Zero, 0);
        if (dc == IntPtr.Zero || dib == IntPtr.Zero || bits == IntPtr.Zero)
        { ReleaseSurface(); throw new InvalidOperationException("WINDOWS_BITMAP_UNAVAILABLE"); }
        selected = Win.SelectObject(dc, dib);
        if (selected == IntPtr.Zero || selected == new IntPtr(-1))
        { selected = IntPtr.Zero; ReleaseSurface(); throw new InvalidOperationException("WINDOWS_BITMAP_UNAVAILABLE"); }
        bitmap = new Bitmap(capacityW, capacityH, capacityW * 4, PixelFormat.Format32bppPArgb, bits);
        return bitmap;
    }
    public void Present(int x, int y, int width, int height)
    {
        var position = new Win.Point(x, y);
        var size = new Win.Size(width, height);
        var origin = new Win.Point();
        var blend = new Win.Blend { Alpha = 255, Format = 1 };
        if (!Win.UpdateLayeredWindow(Handle, IntPtr.Zero, ref position, ref size, dc, ref origin, 0, ref blend, 2))
            throw new InvalidOperationException("WINDOWS_PRESENT_FAILED");
        if (!Win.SetWindowPos(Handle, new IntPtr(-1), x, y, width, height, 0x10 | 0x40))
            throw new InvalidOperationException("WINDOWS_SHOW_FAILED");
    }
    public void Dispose()
    {
        ReleaseSurface();
        if (Handle != IntPtr.Zero) DestroyHandle();
    }
}
static class RingPainter
{
    static readonly Bitmap measure = new Bitmap(1,1);
    static double N(Dictionary<string, object> props, string key, double fallback = 0)
    {
        object v;
        return props.TryGetValue(key, out v) && v is double ? (double)v : fallback;
    }
    static Color ColorOf(double[] c, double opacity)
    {
        return Color.FromArgb((int)Math.Round(J.Clamp(c[3] * opacity, 0, 1) * 255),
                              (int)Math.Round(J.Clamp(c[0], 0, 1) * 255), (int)Math.Round(J.Clamp(c[1], 0, 1) * 255),
                              (int)Math.Round(J.Clamp(c[2], 0, 1) * 255));
    }
    static GraphicsPath Path(double[][] commands)
    {
        var path = new GraphicsPath();
        PointF current = new PointF(), start = current;
        foreach (var v in commands)
        {
            if (v[0] == 0)
            {
                path.StartFigure();
                current = new PointF((float)v[1], (float)v[2]);
                start = current;
            }
            else if (v[0] == 1)
            {
                var end = new PointF((float)v[1], (float)v[2]);
                path.AddLine(current, end);
                current = end;
            }
            else if (v[0] == 2)
            {
                var control = new PointF((float)v[1], (float)v[2]);
                var end = new PointF((float)v[3], (float)v[4]);
                path.AddBezier(current,
                               new PointF(current.X + (control.X - current.X) * 2 / 3,
                                          current.Y + (control.Y - current.Y) * 2 / 3),
                               new PointF(end.X + (control.X - end.X) * 2 / 3, end.Y + (control.Y - end.Y) * 2 / 3),
                               end);
                current = end;
            }
            else if (v[0] == 4)
            {
                var end = new PointF((float)v[5], (float)v[6]);
                path.AddBezier(current, new PointF((float)v[1], (float)v[2]), new PointF((float)v[3], (float)v[4]),
                               end);
                current = end;
            }
            else if (v[0] == 3)
            {
                path.CloseFigure();
                current = start;
            }
        }
        return path;
    }
    static GraphicsPath Trim(GraphicsPath original, double from, double to)
    {
        var result = new GraphicsPath();
        if (to <= from || original.PointCount < 2)
            return result;
        using (var flat = (GraphicsPath)original.Clone())
        {
            flat.Flatten(null, .1f);
            var pts = flat.PathPoints;
            var types = flat.PathTypes;
            double total = 0;
            for (int i = 1; i < pts.Length; i++)
                if ((types[i] & 7) != 0)
                    total += Pt.Distance(new Pt(pts[i - 1].X, pts[i - 1].Y), new Pt(pts[i].X, pts[i].Y));
            double start = from * total, end = to * total, at = 0;
            bool continuous = false;
            for (int i = 1; i < pts.Length; i++)
            {
                if ((types[i] & 7) == 0)
                {
                    continuous = false;
                    continue;
                }
                Pt a = new Pt(pts[i - 1].X, pts[i - 1].Y), b = new Pt(pts[i].X, pts[i].Y);
                double length = Pt.Distance(a, b);
                if (length > 0 && at + length > start && at < end)
                {
                    Pt p = Pt.Lerp(a, b, J.Clamp((start - at) / length, 0, 1)),
                       q = Pt.Lerp(a, b, J.Clamp((end - at) / length, 0, 1));
                    if (!continuous)
                        result.StartFigure();
                    result.AddLine((float)p.X, (float)p.Y, (float)q.X, (float)q.Y);
                    continuous = true;
                }
                else
                    continuous = false;
                at += length;
            }
        }
        return result;
    }
    static void Transform(Graphics g, Dictionary<string, object> props)
    {
        object value;
        if (props.TryGetValue("transform", out value))
        {
            var v = (double[])value;
            using (var m = new Matrix((float)v[0], (float)v[1], (float)v[2], (float)v[3], (float)v[4], (float)v[5]))
                g.MultiplyTransform(m);
        }
        if (props.TryGetValue("transform.translation", out value))
        {
            var v = (double[])value;
            g.TranslateTransform((float)v[0], (float)v[1]);
        }
        g.TranslateTransform((float)N(props, "transform.translation.x"), 0);
    }
    public static Rect Bounds(RingPlan plan, RingPlan old, SpritePlan sprite, double time)
    {
        var props = plan.Layers.ToDictionary(l => l.Name, l => new Dictionary<string, object>(l.Props));
        foreach (var tr in plan.Tracks) if (props.ContainsKey(tr.Layer)) props[tr.Layer][tr.Key] = tr.Sample(time);
        Pt position = plan.Position(time);
        Rect bounds = Rect.Box(new[] { position }, 1);
        // A matrix-only Graphics surface avoids allocating a route-sized bitmap to measure it.
        using (var g = Graphics.FromImage(measure))
        foreach (var layer in plan.Layers.Where(l => l.Kind != "group"))
        {
            var p = props[layer.Name];
            if (N(p,"opacity",1) * (layer.Global ? 1 : N(props["cursor"],"opacity",1)) < .001) continue;
            var saved = g.Save();
            try
            {
                if (!layer.Global) {
                    g.TranslateTransform((float)position.X, (float)position.Y);
                    g.TranslateTransform((float)N(props["cursor"],"transform.translation.x"),0);
                    if (layer.Parent == "halves") Transform(g,props["halves"]);
                }
                Transform(g,p);
                object raw;
                if (layer.Kind == "text" && layer.Frame.HasValue) bounds = bounds.Union(layer.Frame.Value);
                else if (p.TryGetValue("path",out raw) && raw != null)
                using (var path = Path((double[][])raw))
                using (var visible = (N(p,"strokeStart") > 0 || N(p,"strokeEnd",1) < 1) && layer.Fill == null ?
                    Trim(path,N(p,"strokeStart"),N(p,"strokeEnd",1)) : (GraphicsPath)path.Clone())
                {
                    if (visible.PointCount > 0) {
                        using (var matrix = g.Transform) visible.Transform(matrix);
                        var r = visible.GetBounds();
                        double pad = layer.Width + (layer.Keyline ? 2 : 1) + 6;
                        bounds = bounds.Union(new Rect(r.X-pad,r.Y-pad,r.Width+2*pad,r.Height+2*pad));
                    }
                }
            } finally { g.Restore(saved); }
        }
        if (old != null && old.Chip != null && old.Label != plan.Label && time < .06) bounds = bounds.Union(old.Chip.Frame).Union(Rect.Box(new[] {old.At, plan.At},2));
        if (sprite != null) bounds = bounds.Union(sprite.CurrentBounds(plan,time));
        return bounds;
    }
    public static void Draw(Graphics g, RingPlan plan, RingPlan old, SpritePlan sprite, RingTheme theme, double time,
                            double rootOpacity)
    {
        var props = plan.Layers.ToDictionary(l => l.Name, l => new Dictionary<string, object>(l.Props));
        foreach (var tr in plan.Tracks)
            if (props.ContainsKey(tr.Layer))
                props[tr.Layer][tr.Key] = tr.Sample(time);
        var cursor = props["cursor"];
        Pt position = plan.Position(time);
        double cursorOpacity = N(cursor, "opacity", 1);
        var halves = props["halves"];
        foreach (var layer in plan.Layers.Where(l => l.Kind != "group").OrderBy(l => l.Under ? 0 : l.Global ? 2 : 1))
        {
            var p = props[layer.Name];
            double opacity = N(p, "opacity", 1) * rootOpacity * (layer.Global ? 1 : cursorOpacity);
            if (opacity < .001)
                continue;
            var saved = g.Save();
            try
            {
                if (!layer.Global)
                {
                    g.TranslateTransform((float)position.X, (float)position.Y);
                    g.TranslateTransform((float)N(cursor, "transform.translation.x"), 0);
                    if (layer.Parent == "halves")
                        Transform(g, halves);
                }
                Transform(g, p);
                if (layer.Kind == "text" && layer.Frame.HasValue)
                {
                    var f = layer.Frame.Value;
                    using (var background = new SolidBrush(ColorOf(layer.Fill, opacity)))
                        g.FillRectangle(background, (float)f.X, (float)f.Y, (float)f.W, (float)f.H);
                    using (var brush = new SolidBrush(ColorOf(layer.Stroke, opacity))) using (
                        var font = new Font("Segoe UI", 10, FontStyle.Regular, GraphicsUnit.Pixel))
                        g.DrawString(layer.Text, font, brush, (float)f.X + 6, (float)f.Y + 1,
                                     StringFormat.GenericTypographic);
                    continue;
                }
                object raw;
                if (!p.TryGetValue("path", out raw) || raw == null)
                    continue;
                using (var path = Path((double[][])raw))
                {
                    if (layer.Kind == "gradient")
                    {
                        var bounds = path.GetBounds();
                        if (bounds.Width > 0 && bounds.Height > 0)
                            using (var gradient = new LinearGradientBrush(bounds, ColorOf(theme.Warm, opacity),
                                                                          ColorOf(theme.Cool, opacity), 315))
                                g.FillPath(gradient, path);
                    }
                    else if (layer.Fill != null)
                    {
                        var fill = p.ContainsKey("fillColor") ? (double[])p["fillColor"] : layer.Fill;
                        using (var brush = new SolidBrush(ColorOf(fill, opacity))) g.FillPath(brush, path);
                    }
                    if (layer.Stroke != null && layer.Width > 0)
                    {
                        double from = N(p, "strokeStart"), to = N(p, "strokeEnd", 1);
                        using (var stroke = (from > 0 || to < 1) ? Trim(path, from, to) : (GraphicsPath)path.Clone())
                        {
                            var color = p.ContainsKey("strokeColor") ? (double[])p["strokeColor"] : layer.Stroke;
                            if (layer.Keyline)
                                using (var ink = new Pen(ColorOf(theme.Ink, opacity), (float)layer.Width + 2))
                                {
                                    ink.StartCap = ink.EndCap = LineCap.Round;
                                    g.DrawPath(ink, stroke);
                                }
                            using (var pen = new Pen(ColorOf(color, opacity), (float)layer.Width))
                            {
                                pen.StartCap = pen.EndCap = LineCap.Round;
                                pen.LineJoin = LineJoin.Round;
                                if (layer.Dash.Length > 0)
                                    pen.DashPattern = layer.Dash.Select(x => (float)(x / layer.Width)).ToArray();
                                if (stroke.PointCount > 0)
                                    g.DrawPath(pen, stroke);
                            }
                        }
                    }
                }
            }
            finally
            {
                g.Restore(saved);
            }
        }
        if (old != null && old.Chip != null && old.Label != plan.Label && time < .06)
        {
            double opacity = (1 - time / .06) * rootOpacity;
            var chip = old.Chip.Frame;
            using (var brush = new SolidBrush(ColorOf(theme.Ink, opacity)))
                g.FillRectangle(brush, (float)chip.X, (float)chip.Y, (float)chip.W, (float)chip.H);
            using (var brush = new SolidBrush(ColorOf(theme.White, opacity))) using (
                var font = new Font("Segoe UI", 10, FontStyle.Regular, GraphicsUnit.Pixel))
                g.DrawString(old.Label, font, brush, (float)chip.X + 6, (float)chip.Y + 1);
            using (var path = Path(old.Chip.Tether)) using (var pen = new Pen(ColorOf(theme.Ink, opacity), 1))
                g.DrawPath(pen, path);
        }
        if (sprite != null)
            sprite.Draw(g, plan, time, cursorOpacity * rootOpacity);
    }
}
// The sole wake-up is one-shot: frame clock while a plan or fade moves, otherwise
// the earliest scheduled act/park/fade/release. Fully idle means no timer/window.
public sealed class OverlayHost : NativeWindow, IDisposable
{
    const int Wake = 0x8001, Input = 0x8002, Invalidate = 0x8003, CharacterReady = 0x8004;
    readonly RingRuntime runtime;
    readonly Stopwatch clock = Stopwatch.StartNew();
    readonly ConcurrentQueue<object> incoming = new ConcurrentQueue<object>();
    readonly Dictionary<string, OverlayWindow> windows = new Dictionary<string, OverlayWindow>();
    readonly List<IntPtr> hooks = new List<IntPtr>();
    readonly Win.EventProc hookProc;
    System.Threading.Timer timer;
    bool hidden, enabled = true;
    volatile bool closed;
    readonly string style;
    RingPlan plan, previous;
    SpritePlan sprite;
    SpriteCharacter character;
    double began, fadeStart = Double.PositiveInfinity, fadeDuration;
    long generation;
    int queued;
    readonly AutoResetEvent queueSpace = new AutoResetEvent(false);
    double dpiScale = 1;
    Pt monitorOrigin;
    readonly object characterLock = new object();
    Tuple<long, CharacterFrame, SpriteCharacter, string> ready;
    Tuple<long, CharacterFrame> pendingCharacter;
    bool loadingCharacter;
    public OverlayHost(string style, bool hidden, ulong seed)
    {
        this.style = style;
        this.hidden = hidden;
        Win.Initialize(hidden);
        runtime = new RingRuntime(RingTheme.For(style), seed) { Bounds = LogicalBounds, Reduced = Win.Reduced,
                                                                Secure = () => true };
        runtime.ExtraBounds = (p, clip) =>
            this.style == "sprite" && character != null
                ? (Rect?)SpritePlan.Make(p, character, runtime.Reduced(), runtime.Secure(), clip).Bounds(p)
                : null;
        hookProc = OnWindowEvent;
        CreateHandle(new CreateParams { Caption = "sleight cursor dispatcher", Parent = new IntPtr(-3) });
    }
    Pt Logical(Pt p) { return new Pt(monitorOrigin.X+(p.X-monitorOrigin.X)/dpiScale, monitorOrigin.Y+(p.Y-monitorOrigin.Y)/dpiScale); }
    Rect Logical(Rect r) { var p = Logical(new Pt(r.X,r.Y)); return new Rect(p.X,p.Y,r.W/dpiScale,r.H/dpiScale); }
    Rect Physical(Rect r) { return new Rect(monitorOrigin.X+(r.X-monitorOrigin.X)*dpiScale, monitorOrigin.Y+(r.Y-monitorOrigin.Y)*dpiScale,r.W*dpiScale,r.H*dpiScale); }
    Rect? LogicalBounds(int pid, uint window) { var r = Win.Bounds(pid,window); return r.HasValue ? (Rect?)Logical(r.Value) : null; }
    bool Normalize(CursorEvent e)
    {
        if (!Win.Bounds(e.Pid,e.Window).HasValue) { Hide(); return false; }
        uint dpi = Win.GetDpiForWindow(new IntPtr((long)e.Window));
        if (dpi < 96 || dpi > 768) { Hide(); return false; }
        var screen = Screen.FromHandle(new IntPtr((long)e.Window));
        var origin = new Pt(screen.Bounds.X,screen.Bounds.Y);
        double scale = dpi/96.0;
        if (scale != dpiScale || origin.X != monitorOrigin.X || origin.Y != monitorOrigin.Y) {
            Apply(runtime.Hide(Now)); dpiScale = scale; monitorOrigin = origin;
        }
        if (e.At.HasValue) e.At = Logical(e.At.Value);
        if (e.Rect.HasValue) e.Rect = Logical(e.Rect.Value);
        e.Path = e.Path.Select(Logical).ToArray();
        if (e.CaretX.HasValue) e.CaretX = Logical(new Pt(e.CaretX.Value,monitorOrigin.Y)).X;
        return true;
    }
    double Now
    {
        get {
            return clock.Elapsed.TotalSeconds;
        }
    }
    public void Start()
    {
        var thread = new Thread(() =>
                                {
                                    try
                                    {
                                        var reader = new FrameReader(Console.OpenStandardInput());
                                        Dictionary<string, object> d;
                                        while ((d = reader.Read()) != null)
                                        {
                                            var f = reader.Bind(d);
                                            // WIN3: no UIA query while phase 1 suppresses labels, caret motion and key taps.
                                            while (Interlocked.CompareExchange(ref queued, 0, 0) >= 64 && !closed)
                                                queueSpace.WaitOne();
                                            if (closed) return;
                                            Interlocked.Increment(ref queued);
                                            incoming.Enqueue(f);
                                            Win.PostMessage(Handle, Input, IntPtr.Zero, IntPtr.Zero);
                                        }
                                        incoming.Enqueue(0);
                                    }
                                    catch
                                    {
                                        incoming.Enqueue(65);
                                    }
                                    Win.PostMessage(Handle, Input, IntPtr.Zero, IntPtr.Zero);
                                });
        thread.IsBackground = true;
        thread.Start();
        Application.Run();
    }
    void OnWindowEvent(IntPtr hook, uint ev, IntPtr hwnd, int objectId, int child, uint thread, uint time)
    {
        if (plan != null && hwnd == new IntPtr((long)runtime.Session.Window) && (objectId == 0 || ev < 0x8000))
            Win.PostMessage(Handle, Invalidate, IntPtr.Zero, IntPtr.Zero);
    }
    protected override void WndProc(ref Message m)
    {
        try
        {
            if (m.Msg == Input)
            {
                object item;
                while (incoming.TryDequeue(out item))
                {
                    if (item is int)
                    {
                        Program.ExitCode = (int)item;
                        Dispose();
                        Application.ExitThread();
                        break;
                    }
                    Interlocked.Decrement(ref queued);
                    queueSpace.Set();
                    Receive((HostFrame)item);
                }
                Schedule();
                return;
            }
            if (m.Msg == Wake)
            {
                Tick();
                return;
            }
            if (m.Msg == Invalidate)
            {
                Hide();
                Schedule();
                return;
            }
            if (m.Msg == CharacterReady)
            {
                JoinCharacter();
                return;
            }
        }
        catch
        {
            Program.ExitCode = 70;
            Dispose();
            Application.ExitThread();
        }
        base.WndProc(ref m);
    }
    void Receive(HostFrame f)
    {
        Program.BoundNonce = f.Nonce;
        double now = Now;
        if (f.Tag == "character")
        {
            long gen = Interlocked.Increment(ref generation);
            lock (characterLock)
            {
                if (character != null)
                {
                    character.Dispose();
                    character = null;
                }
                sprite = null;
            }
            Render(now);
            if (style != "sprite")
            {
                WriteCharacter(f.Character, false, null);
                return;
            }
            lock (characterLock)
            {
                pendingCharacter = Tuple.Create(gen, f.Character);
                if (loadingCharacter)
                    return;
                loadingCharacter = true;
            }
            ThreadPool.QueueUserWorkItem(
                _ => LoadCharacters());
            return;
        }
        if (f.Tag == "menu")
        {
            enabled = f.Enabled;
            if (f.Capture != null && f.Capture != (hidden ? "hidden" : "visible"))
            {
                foreach (var w in windows.Values)
                    w.SetCapture(f.Capture == "hidden");
                hidden = f.Capture == "hidden";
            }
            if (!enabled)
                Apply(runtime.Hide(now));
            return;
        }
        if (f.Tag == "hide")
        {
            Apply(runtime.Hide(now));
            return;
        }
        // Phase 1 remains conservative even when UIA reports a plain field.
        if (enabled && Normalize(f.Event))
            Apply(runtime.Receive(f.Event, f.Delay, now));
    }
    void LoadCharacters()
    {
        while (true)
        {
            Tuple<long, CharacterFrame> request;
            lock (characterLock)
            {
                request = pendingCharacter;
                pendingCharacter = null;
                if (closed || request == null)
                {
                    loadingCharacter = false;
                    return;
                }
            }
            SpriteCharacter loaded = null;
            string reason = null;
            try
            {
                loaded = SpriteCharacter.Load(request.Item2, null,
                                              () => closed || Interlocked.Read(ref generation) != request.Item1);
            }
            catch (Exception error)
            {
                reason = Program.CharacterReason(error);
            }
            lock (characterLock)
            {
                if (closed || Interlocked.Read(ref generation) != request.Item1)
                {
                    if (loaded != null)
                        loaded.Dispose();
                    continue;
                }
                if (ready != null && ready.Item3 != null)
                    ready.Item3.Dispose();
                ready = Tuple.Create(request.Item1, request.Item2, loaded, reason);
            }
            Win.PostMessage(Handle, CharacterReady, IntPtr.Zero, IntPtr.Zero);
        }
    }
    void JoinCharacter()
    {
        Tuple<long, CharacterFrame, SpriteCharacter, string> slot;
        lock (characterLock)
        {
            slot = ready;
            ready = null;
        }
        if (slot == null)
            return;
        if (closed || slot.Item1 != Interlocked.Read(ref generation))
        {
            if (slot.Item3 != null)
                slot.Item3.Dispose();
            return;
        }
        character = slot.Item3;
        WriteCharacter(slot.Item2, character != null, slot.Item4,
                       character == null ? new string[0] : character.Warnings);
    }
    static void WriteCharacter(CharacterFrame frame, bool loaded, string reason, string[] warnings = null)
    {
        Program.Write(J.Map("hand", "character", "nonce", Program.BoundNonce, "id", frame.Id, "loaded",
                            loaded, "reason", reason, "warnings", warnings ?? new string[0]));
    }
    void Apply(IEnumerable<RingEffect> effects)
    {
        foreach (var effect in effects)
        {
            if (effect.Kind == "draw")
            {
                previous = plan;
                plan = effect.Plan;
                began = effect.Time;
                fadeStart = Double.PositiveInfinity;
                Rect? clip = LogicalBounds(runtime.Session.Pid, runtime.Session.Window);
                if (!clip.HasValue)
                {
                    Hide();
                    continue;
                }
                sprite = style == "sprite" && character != null
                             ? SpritePlan.Make(plan, character, runtime.Reduced(), runtime.Secure(), clip.Value)
                             : null;
                BindHooks();
                Render(Now);
            }
            else if (effect.Kind == "hide" || effect.Kind == "release")
                Clear();
            else if (effect.Kind == "fade")
            {
                fadeStart = effect.Time;
                fadeDuration = effect.Duration;
                Render(Now);
            }
            else if (effect.Kind == "park")
                Render(Math.Max(Now, began + (plan == null ? 0 : plan.Total)));
        }
    }
    void BindHooks()
    {
        foreach (var h in hooks)
            Win.UnhookWinEvent(h);
        hooks.Clear();
        foreach (uint ev in new uint[] { 0x8001, 0x8003, 0x800b, 0x16 })
        {
            IntPtr h = Win.SetWinEventHook(ev, ev, IntPtr.Zero, hookProc, (uint)runtime.Session.Pid, 0, 2);
            if (h == IntPtr.Zero)
                throw new InvalidOperationException("WINDOWS_TARGET_WATCH_UNAVAILABLE");
            hooks.Add(h);
        }
    }
    void Tick()
    {
        if (closed)
            return;
        Apply(runtime.Advance(Now));
        if (plan != null)
            Render(Now);
        Schedule();
    }
    void Hide()
    {
        Apply(runtime.Hide(Now));
    }
    void Clear()
    {
        foreach (var window in windows.Values)
            window.Dispose();
        windows.Clear();
        foreach (var h in hooks)
            Win.UnhookWinEvent(h);
        hooks.Clear();
        plan = null;
        previous = null;
        sprite = null;
        fadeStart = Double.PositiveInfinity;
    }
    void Render(double now)
    {
        if (plan == null)
            return;
        Rect? clip = LogicalBounds(runtime.Session.Pid, runtime.Session.Window);
        if (!clip.HasValue)
        {
            Hide();
            return;
        }
        double time = Math.Max(0, now - began),
               opacity = now >= fadeStart ? 1 - J.Clamp((now - fadeStart) / fadeDuration, 0, 1) : 1;
        Rect area = Physical(RingPainter.Bounds(plan, previous, sprite, time).Intersect(clip.Value));
        var active = new HashSet<string>();
        foreach (var screen in Screen.AllScreens)
        {
            Rect r =
                area.Intersect(new Rect(screen.Bounds.X, screen.Bounds.Y, screen.Bounds.Width, screen.Bounds.Height));
            if (r.W < 1 || r.H < 1)
                continue;
            active.Add(screen.DeviceName);
            OverlayWindow window;
            if (!windows.TryGetValue(screen.DeviceName, out window))
            {
                window = new OverlayWindow(hidden, () => Win.PostMessage(Handle, Invalidate, IntPtr.Zero, IntPtr.Zero));
                windows.Add(screen.DeviceName, window);
            }
            int x = (int)Math.Floor(r.X), y = (int)Math.Floor(r.Y), w = (int)Math.Ceiling(r.Right) - x,
                h = (int)Math.Ceiling(r.Bottom) - y;
            if ((long)w * h > 16000000)
                throw new InvalidOperationException("WINDOWS_SURFACE_TOO_LARGE");
            var bitmap = window.Surface(w,h);
            using (var graphics = Graphics.FromImage(bitmap))
            {
                graphics.Clear(Color.Transparent);
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.InterpolationMode = InterpolationMode.HighQualityBilinear;
                graphics.TranslateTransform(-x,-y);
                graphics.SetClip(new RectangleF((float)r.X,(float)r.Y,(float)r.W,(float)r.H));
                graphics.TranslateTransform((float)monitorOrigin.X,(float)monitorOrigin.Y);
                graphics.ScaleTransform((float)dpiScale,(float)dpiScale);
                graphics.TranslateTransform((float)-monitorOrigin.X,(float)-monitorOrigin.Y);
                RingPainter.Draw(graphics,plan,previous,sprite,runtime.Theme,time,opacity);
                graphics.Flush();
            }
            window.Present(x,y,w,h);
        }
        foreach (string key in windows.Keys.Where(k => !active.Contains(k)).ToArray())
        {
            windows[key].Dispose();
            windows.Remove(key);
        }
    }
    void Schedule()
    {
        if (closed)
            return;
        double now = Now;
        double? due = runtime.Next;
        bool moving = plan != null && (now < began + plan.Total || now >= fadeStart && now < fadeStart + fadeDuration);
        if (moving)
            due = Math.Min(due ?? Double.PositiveInfinity, now + 1.0 / 60);
        if (!due.HasValue)
        {
            if (timer != null)
            {
                timer.Dispose();
                timer = null;
            }
            return;
        }
        int ms = (int)Math.Max(1, Math.Min(Int32.MaxValue, Math.Ceiling((due.Value - now) * 1000)));
        if (timer == null)
            timer = new System.Threading.Timer(
                _ => Win.PostMessage(Handle, Wake, IntPtr.Zero, IntPtr.Zero), null, ms, Timeout.Infinite);
        else
            timer.Change(ms, Timeout.Infinite);
    }
    public void Dispose()
    {
        if (closed)
            return;
        closed = true;
        queueSpace.Set();
        Interlocked.Increment(ref generation);
        if (timer != null)
        {
            timer.Dispose();
            timer = null;
        }
        Clear();
        lock (characterLock)
        {
            if (character != null)
                character.Dispose();
            character = null;
            if (ready != null && ready.Item3 != null)
                ready.Item3.Dispose();
            ready = null;
        }
        if (Handle != IntPtr.Zero)
            DestroyHandle();
    }
}
}
