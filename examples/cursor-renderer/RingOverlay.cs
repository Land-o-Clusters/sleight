// Own plain-circle example. Reads the validated JSONL output of listen.mjs from stdin.
// .NET Framework 4.8: csc /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll RingOverlay.cs
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

sealed class RingOverlay : Form {
    const int WS_EX_LAYERED = 0x00080000, WS_EX_TRANSPARENT = 0x00000020;
    const int WS_EX_TOOLWINDOW = 0x00000080, WS_EX_NOACTIVATE = 0x08000000;
    const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetWindowDisplayAffinity(IntPtr window, uint affinity);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct OsVersion {
        public uint size, major, minor, build, platform;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string servicePack;
    }
    [DllImport("ntdll.dll", CharSet = CharSet.Unicode)]
    static extern int RtlGetVersion(ref OsVersion version);

    double scale = 1;
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get {
            CreateParams p = base.CreateParams;
            p.ExStyle |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
            return p;
        }
    }
    RingOverlay() {
        FormBorderStyle = FormBorderStyle.None;
        AutoScaleMode = AutoScaleMode.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = TransparencyKey = Color.Magenta;
        DoubleBuffered = true;
    }
    protected override void OnHandleCreated(EventArgs e) {
        base.OnHandleCreated(e);
        // Refuse to show when the OS rejects the capture-exclusion request.
        if (!SetWindowDisplayAffinity(Handle, WDA_EXCLUDEFROMCAPTURE)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    protected override void WndProc(ref Message m) {
        if (m.Msg == 0x0021) { m.Result = new IntPtr(3); return; } // WM_MOUSEACTIVATE: MA_NOACTIVATE
        if (m.Msg == 0x0084) { m.Result = new IntPtr(-1); return; } // WM_NCHITTEST: HTTRANSPARENT
        base.WndProc(ref m);
    }
    protected override void OnPaint(PaintEventArgs e) {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        float stroke = (float)(3 * scale), inset = stroke * 2;
        using (Pen pen = new Pen(Color.FromArgb(43, 164, 255), stroke))
            e.Graphics.DrawEllipse(pen, inset, inset, ClientSize.Width - inset * 2, ClientSize.Height - inset * 2);
    }
    void Place(double x, double y, double dpiScale) {
        scale = dpiScale;
        int size = (int)Math.Round(48 * scale);
        // Per-monitor-v2 coordinates are physical pixels. Only the ring's size scales.
        if (!SetWindowPos(Handle, new IntPtr(-1), (int)Math.Round(x - size / 2.0),
            (int)Math.Round(y - size / 2.0), size, size, 0x0010)) // SWP_NOACTIVATE
            throw new Win32Exception(Marshal.GetLastWin32Error());
        if (!Visible) Show();
        Invalidate();
    }

    sealed class View {
        public RingOverlay panel;
        public double x, y, scale = 1;
        public bool point, overflow;
        public DateTime received;
        public readonly HashSet<string> drags = new HashSet<string>();
    }
    static readonly Queue<Dictionary<string, object>> pending = new Queue<Dictionary<string, object>>();
    static readonly Dictionary<string, View> views = new Dictionary<string, View>();
    static bool eof;
    static string FieldText(Dictionary<string, object> e, string k) { object v; return e.TryGetValue(k, out v) ? v as string : null; }
    static bool Number(object o, out double n) {
        n = 0;
        if (!(o is int || o is long || o is decimal || o is double)) return false;
        n = Convert.ToDouble(o); return !Double.IsNaN(n) && !Double.IsInfinity(n) && Math.Abs(n) <= 100000;
    }
    static void Remove(string session) {
        View view;
        if (!views.TryGetValue(session, out view)) return;
        if (view.panel != null) view.panel.Dispose();
        views.Remove(session);
    }
    static void Accept(Dictionary<string, object> e) {
        string session = FieldText(e, "session"), type = FieldText(e, "type"), state = FieldText(e, "state"), phase = FieldText(e, "phase");
        if (FieldText(e, "v") != "sleight.cursor/1" || session == null ||
            !System.Text.RegularExpressions.Regex.IsMatch(session, "^[a-f0-9]{32}$")) return;
        if (type == "session" && state == "end" || type == "status" &&
            (state == "done" || state == "handback" || state == "idle" || state == "error")) { Remove(session); return; }
        if (type != "session" && type != "status" && type != "action") return;
        View view;
        if (!views.TryGetValue(session, out view)) {
            if (views.Count == 4) {
                string oldest = null; DateTime at = DateTime.MaxValue;
                foreach (KeyValuePair<string, View> item in views) if (item.Value.received < at) { at = item.Value.received; oldest = item.Key; }
                Remove(oldest);
            }
            view = new View(); views.Add(session, view);
        }
        view.received = DateTime.UtcNow;
        object value;
        IList point = e.TryGetValue("point", out value) ? value as IList : null;
        if (point != null && point.Count == 2) {
            double x, y;
            if (Number(point[0], out x) && Number(point[1], out y)) { view.x = x; view.y = y; view.point = true; }
        }
        Dictionary<string, object> display = e.TryGetValue("display", out value) ? value as Dictionary<string, object> : null;
        double dpi;
        if (display != null && display.TryGetValue("scale", out value) && Number(value, out dpi) && dpi > 0 && dpi <= 8) view.scale = dpi;
        bool dragging = view.drags.Count > 0 || view.overflow;
        if (type == "action" && FieldText(e, "kind") == "drag") {
            string key = FieldText(e, "call") + ":" + (e.TryGetValue("index", out value) ? Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture) : "0");
            if (phase == "aim" || phase == "act") {
                if (view.drags.Count < 64 || view.drags.Contains(key)) view.drags.Add(key); else view.overflow = true;
                dragging = true;
            } else if (phase == "done" || phase == "failed" || phase == "declined" || phase == "skipped") {
                view.drags.Remove(key);
                // A terminal event resets overflow. Tracked drags still keep the panel hidden.
                view.overflow = false;
            }
        }
        if (dragging || type == "action" && (phase == "failed" || phase == "declined" || phase == "skipped")) {
            if (type == "action" && (phase == "failed" || phase == "declined" || phase == "skipped")) view.overflow = false;
            if (view.panel != null) view.panel.Hide(); return;
        }
        if (type != "action" || point == null || !view.point) return;
        if (view.panel == null) view.panel = new RingOverlay();
        view.panel.Place(view.x, view.y, view.scale);
    }
    static void ReadInput() {
        var json = new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 32 };
        var utf8 = new UTF8Encoding(false, true);
        Stream input = Console.OpenStandardInput();
        byte[] chunk = new byte[4096], line = new byte[65536]; int used = 0, count; bool oversized = false;
        try {
            while ((count = input.Read(chunk, 0, chunk.Length)) > 0) for (int i = 0; i < count; i++) {
                if (chunk[i] != 10) { if (used < line.Length && !oversized) line[used++] = chunk[i]; else oversized = true; continue; }
                if (!oversized) try {
                    var record = json.Deserialize<Dictionary<string, object>>(utf8.GetString(line, 0, used));
                    if (record != null) lock (pending) { if (pending.Count == 128) pending.Dequeue(); pending.Enqueue(record); }
                } catch (Exception) { }
                used = 0; oversized = false;
            }
        } finally { lock (pending) { eof = true; } }
    }
    [STAThread]
    static int Main(string[] args) {
        if (args.Length != 0) { Console.Error.WriteLine("Usage: node listen.mjs | RingOverlay.exe"); return 64; }
        try {
            // Windows 10 2004+ is required for WDA_EXCLUDEFROMCAPTURE. Never use DPI-virtualized placement.
            OsVersion version = new OsVersion(); version.size = (uint)Marshal.SizeOf(typeof(OsVersion));
            if (RtlGetVersion(ref version) != 0 || version.major < 10 || version.build < 19041)
                throw new InvalidOperationException("The ring requires Windows 10 2004 or later");
            if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) throw new Win32Exception(Marshal.GetLastWin32Error());
            Application.EnableVisualStyles();
            using (var timer = new System.Windows.Forms.Timer { Interval = 16 }) {
                timer.Tick += delegate {
                    try {
                        for (int i = 0; i < 32; i++) {
                            Dictionary<string, object> record;
                            lock (pending) { if (pending.Count == 0) break; record = pending.Dequeue(); }
                            Accept(record);
                        }
                        var expired = new List<string>();
                        foreach (var item in views) if ((DateTime.UtcNow - item.Value.received).TotalSeconds >= 3) expired.Add(item.Key);
                        foreach (var session in expired) Remove(session);
                        lock (pending) { if (eof && pending.Count == 0) Application.ExitThread(); }
                    } catch (Exception error) { Console.Error.WriteLine(error.Message); Environment.ExitCode = 1; Application.ExitThread(); }
                };
                var reader = new Thread(ReadInput) { IsBackground = true }; reader.Start();
                timer.Start(); Application.Run();
            }
            return Environment.ExitCode;
        } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
        finally { foreach (var view in views.Values) if (view.panel != null) view.panel.Dispose(); views.Clear(); }
    }
}
