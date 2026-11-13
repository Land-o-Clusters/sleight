// Private card surface. No Button controls, Click handlers, UIA Invoke or automation answer channel.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace Sleight.Cursor
{
public sealed class ConsentCard
{
    public string Nonce, Id, Kind, Question, Detail; public string[] Choices; public long Deadline;
    public static ConsentCard Parse(Dictionary<string, object> d, bool allowApp = false)
    {
        J.Keys(d, "nonce id kind question detail choices deadline");
        var c = new ConsentCard { Nonce = J.S(d["nonce"]), Id = J.S(d["id"]), Kind = J.S(d["kind"]), Question = J.S(d["question"]), Detail = J.S(d["detail"]),
            Choices = J.A(d["choices"]).Select(J.S).ToArray(), Deadline = J.Integer(d["deadline"], 1, 9007199254740991) };
        if (!Regex.IsMatch(c.Nonce, @"\A[a-f0-9]{64}\z") || !Regex.IsMatch(c.Id, @"\A[a-zA-Z0-9-]{1,80}\z") ||
            !new[] { "debugger", "payment", "action", "relaunch", "app" }.Contains(c.Kind) || c.Question.Length < 1 || c.Question.Length > 512 || c.Detail.Length > 16384 ||
            c.Choices.Length < 2 || c.Choices.Length > 3 || c.Choices.Distinct().Count() != c.Choices.Length || c.Choices[0] != "cancel" ||
            c.Choices.Skip(1).Any(x => !new[] { "once", "session", "always", "relaunch" }.Contains(x)) ||
            ((c.Kind == "payment" || c.Kind == "action") && !c.Choices.SequenceEqual(new[] { "cancel", "once" })) ||
            (c.Kind == "relaunch" && !c.Choices.SequenceEqual(new[] { "cancel", "relaunch" })) ||
            (c.Kind == "app" && (!allowApp || !c.Choices.SequenceEqual(new[] { "cancel", "session" }))) ||
            (c.Kind == "debugger" && c.Choices.Skip(1).Any(x => x != "once" && x != "always" && x != "session")) ||
            (c.Question + c.Detail).Any(ch => Char.IsControl(ch) && ch != '\n' && ch != '\r' && ch != '\t' || ch >= '\u202a' && ch <= '\u202e' || ch >= '\u2066' && ch <= '\u2069')) throw new FrameFault();
        return c;
    }
    public static string Label(string choice) { return choice == "cancel" ? "Don't allow" : choice == "once" ? "Allow once" : choice == "always" ? "Always allow" : choice == "session" ? "Allow this session" : "Quit and reopen"; }
    public static string Lines(string text) { return Regex.Replace(text, @"\r\n|\r|\n", "\r\n"); }
}
// Drawn private word field, never an editable TextBox. Only authenticated key-down messages mutate it.
public sealed class ConsentPolicy
{
    public const uint ArmingDelay = 500;
    readonly Dictionary<string, string> words = new Dictionary<string, string>();
    uint paintedAt, activeAt, lastKey; bool painted, active, hasKey; string typed = "";
    public bool WordFocused { get; private set; }
    public string Mask { get { return new string('\u2022', typed.Length); } }
    public string Instructions { get; private set; }
    public ConsentPolicy(string[] choices)
    {
        var pool = new List<string>(new[] { "birch", "cedar", "coral", "daisy", "fern", "finch", "lake", "leaf", "maple", "moss", "oak", "pearl", "pine", "plum", "reed", "rose" });
        using (var rng = RandomNumberGenerator.Create()) foreach (string choice in choices.Skip(1)) {
            var bytes = new byte[4]; rng.GetBytes(bytes); int n = (int)(BitConverter.ToUInt32(bytes, 0) % (uint)pool.Count);
            words.Add(pool[n], choice); pool.RemoveAt(n);
        }
        Instructions = String.Join("  ", words.Select(w => ConsentCard.Label(w.Value) + ": type " + w.Key + ", then Return."));
    }
    public void Paint(uint now) { if (!painted) { paintedAt = now; painted = true; } }
    public void Activate(uint now) { activeAt = now; active = true; Reset(); }
    public void Deactivate() { active = false; Reset(); }
    public void Reset() { typed = ""; WordFocused = false; hasKey = false; }
    public bool Armed(uint now, uint time)
    { return painted && active && Elapsed(now, paintedAt) && Elapsed(now, activeAt) && Elapsed(time, paintedAt) && Elapsed(time, activeAt); }
    static bool Elapsed(uint now, uint start) { uint age = unchecked(now - start); return age >= ArmingDelay && age < 0x80000000u; }
    public void FocusWord() { Reset(); WordFocused = true; }
    public string Key(int vk, uint now, uint time, bool trusted, bool repeat, bool modifiers)
    {
        if (!trusted || repeat || modifiers || !Armed(now, time) || hasKey && unchecked(time - lastKey) >= 0x80000000u || hasKey && time == lastKey) { Reset(); return null; }
        lastKey = time; hasKey = true;
        if (vk == 27) { Reset(); return "cancel"; }
        if (vk == 9) { typed = ""; WordFocused = !WordFocused; return null; }
        if (!WordFocused) return null;
        if (vk == 13) { string choice; bool found = words.TryGetValue(typed, out choice); Reset(); return found ? choice : null; }
        if (vk == 8) { if (typed.Length > 0) typed = typed.Substring(0, typed.Length - 1); }
        else if (vk >= 65 && vk <= 90) { if (typed.Length >= 12) Reset(); else typed += (char)('a' + vk - 65); }
        return null;
    }
    public static void Test(Dictionary<string, bool> cases)
    {
        foreach (string kind in new[] { "payment", "action", "relaunch", "debugger", "app" }) {
            var choices = new[] { "cancel", kind == "relaunch" ? "relaunch" : kind == "app" ? "session" : "once" };
            var p = new ConsentPolicy(choices); uint t = 1000; p.Activate(t); p.Paint(t);
            cases[kind + "-early-tab"] = p.Key(9, t + 499, t + 499, true, false, false) == null && !p.WordFocused;
            cases[kind + "-early-mouse"] = !p.Armed(t + 499, t + 499);
            cases[kind + "-queued-input"] = !p.Armed(t + 600, t + 499);
            p.FocusWord();
            foreach (char ch in p.words.Keys.First()) p.Key(Char.ToUpperInvariant(ch), t + 100, t + 100, true, false, false);
            cases[kind + "-early-typing-cleared"] = p.Mask.Length == 0 && p.Key(13, t + 500, t + 500, true, false, false) == null;
            cases[kind + "-enter-on-open"] = p.Key(13, ++t + 500, t + 500, true, false, false) == null;
            p.Key(9, ++t + 500, t + 500, true, false, false);
            cases[kind + "-tab-space"] = p.Key(32, ++t + 500, t + 500, true, false, false) == null;
            string word = p.words.Keys.First();
            foreach (char ch in word) p.Key(Char.ToUpperInvariant(ch), ++t + 500, t + 500, true, false, false);
            cases[kind + "-typed-return"] = p.Key(13, ++t + 500, t + 500, true, false, false) == choices[1] && p.Mask.Length == 0;
            cases[kind + "-one-shot"] = p.Key(13, ++t + 500, t + 500, true, false, false) == null;
            p.FocusWord(); p.Key(65, ++t + 500, t + 500, true, false, false);
            p.Key(66, ++t + 500, t + 500, false, false, false);
            cases[kind + "-injection-clears"] = p.Mask.Length == 0 && !p.WordFocused;
            p.FocusWord(); p.Key(65, ++t + 500, t + 500, true, true, false);
            cases[kind + "-repeat-refused"] = p.Mask.Length == 0 && !p.WordFocused;
            p.FocusWord(); p.Key(65, ++t + 500, t + 500, true, false, true);
            cases[kind + "-modifiers-refused"] = p.Mask.Length == 0 && !p.WordFocused;
            cases[kind + "-escape"] = p.Key(27, ++t + 500, t + 500, true, false, false) == "cancel";
            p.Activate(t + 500); cases[kind + "-reactivation"] = !p.Armed(t + 999, t + 999);
            p.Deactivate(); cases[kind + "-inactive"] = !p.Armed(t + 1500, t + 1500);
        }
        cases["detail-newline"] = ConsentCard.Lines("one\ntwo\rthree\r\nfour") == "one\r\ntwo\r\nthree\r\nfour";
    }
}
// One measured layout supplies both drawing and hit testing. Pixel fonts are sized for the window's
// monitor DPI explicitly, so Framework autoscaling cannot resize controls but leave drawn targets behind.
public sealed class ConsentLayout : IDisposable
{
    public readonly Font Small, Title, Body;
    public readonly Size Size;
    public readonly Rectangle Icon, Brand, Question, Detail, Feedback, Instructions, WordField;
    public readonly Rectangle[] Buttons;
    public readonly int Padding;
    public readonly float Stroke;
    public const TextFormatFlags TextFlags = TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding;
    public const TextFormatFlags LabelFlags = TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix | TextFormatFlags.NoPadding;
    public ConsentLayout(Graphics g, uint dpi, string[] choices, string question, string instructions, string feedback, Size? maximum = null)
    {
        if (dpi < 48 || dpi > 768) throw new FrameFault();
        float scale = dpi / 96f;
        Small = new Font("Segoe UI", 12 * scale, FontStyle.Regular, GraphicsUnit.Pixel);
        Title = new Font("Segoe UI", 44f / 3 * scale, FontStyle.Bold, GraphicsUnit.Pixel);
        Body = new Font("Segoe UI", 40f / 3 * scale, FontStyle.Regular, GraphicsUnit.Pixel);
        int line = TextRenderer.MeasureText(g, "Ag", Small, System.Drawing.Size.Empty, LabelFlags).Height;
        int bodyLine = TextRenderer.MeasureText(g, "Ag", Body, System.Drawing.Size.Empty, LabelFlags).Height;
        int titleLine = TextRenderer.MeasureText(g, "Ag", Title, System.Drawing.Size.Empty, LabelFlags).Height;
        Padding = line; int gap = Math.Max(1, (line + 1) / 2); Stroke = Math.Max(1, scale);
        int labelWidth = choices.Max(c => TextRenderer.MeasureText(g, ConsentCard.Label(c), Small, System.Drawing.Size.Empty, LabelFlags).Width);
        int inner = Math.Max(36 * line, choices.Length * (labelWidth + 2 * Padding) + (choices.Length - 1) * gap);
        if (maximum.HasValue) inner = Math.Min(inner, maximum.Value.Width - 2 * Padding);
        int buttonWidth = (inner - (choices.Length - 1) * gap) / choices.Length;
        if (inner <= 4 * line || buttonWidth < labelWidth + 2 * Padding) { Dispose(); throw new FrameFault(); }
        int textLeft = 5 * line, textWidth = inner + Padding - textLeft;
        Icon = new Rectangle(Padding, Padding, 3 * line, 3 * line);
        Brand = new Rectangle(textLeft, Padding, textWidth, line);
        int titleHeight = Math.Min(3 * titleLine, Measure(g, question, Title, textWidth));
        Question = new Rectangle(textLeft, Brand.Bottom + gap, textWidth, Math.Max(titleLine, titleHeight));
        int detailTop = Math.Max(Icon.Bottom, Question.Bottom) + gap;
        int feedbackHeight = Math.Max(2 * line, Measure(g, feedback, Small, inner));
        int instructionsHeight = Measure(g, instructions, Small, inner);
        int detailHeight = 10 * bodyLine;
        if (maximum.HasValue) detailHeight = Math.Min(detailHeight, maximum.Value.Height -
            (detailTop + 4 * gap + feedbackHeight + instructionsHeight + 2 * (line + 2 * gap) + Padding));
        if (detailHeight < 3 * bodyLine) { Dispose(); throw new FrameFault(); }
        Detail = new Rectangle(textLeft, detailTop, textWidth, detailHeight);
        Feedback = new Rectangle(Padding, Detail.Bottom + gap, inner, feedbackHeight);
        Instructions = new Rectangle(Padding, Feedback.Bottom + gap, inner, instructionsHeight);
        WordField = new Rectangle(Padding, Instructions.Bottom + gap, inner, line + 2 * gap);
        Buttons = Enumerable.Range(0, choices.Length).Select(n => new Rectangle(Padding + n * (buttonWidth + gap), WordField.Bottom + gap, buttonWidth, line + 2 * gap)).ToArray();
        Size = new Size(inner + 2 * Padding, Buttons[0].Bottom + Padding);
    }
    static int Measure(Graphics g, string text, Font font, int width)
    { return TextRenderer.MeasureText(g, text, font, new Size(width, Int32.MaxValue), TextFlags & ~TextFormatFlags.EndEllipsis).Height; }
    public int Hit(System.Drawing.Point point) { return Array.FindIndex(Buttons, r => r.Contains(point)); }
    public void Dispose() { Small.Dispose(); Title.Dispose(); Body.Dispose(); }
}
public sealed class ConsentInput : IDisposable
{
    [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct Mouse { public Point Point; public uint Data, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct Key { public uint Vk, Scan, Flags, Time; public UIntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] struct Source { public int Device, Origin; }
    [StructLayout(LayoutKind.Sequential)] struct Bounds { public int Left, Top, Right, Bottom; }
    delegate IntPtr Hook(int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int kind, Hook callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll")] static extern uint GetTickCount();
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern int GetMessageTime();
    [DllImport("user32.dll")] static extern bool GetCurrentInputMessageSource(out Source source);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Bounds bounds);
    sealed class Evidence { public uint Message, Time, Code; public int X, Y; }
    readonly IntPtr window; readonly Hook mouseCallback, keyCallback; IntPtr mouse, key;
    readonly List<Evidence> pending = new List<Evidence>(); bool ownDown;
    public void Clear() { pending.Clear(); ownDown = false; }
    public static bool HardwareSource(int origin, int device, bool keyboard) { return origin == 1 && device == (keyboard ? 1 : 2); }
    public static bool Fresh(uint now, uint time, uint flags, bool keyboard, bool ownWindow, bool hardware)
    { return ownWindow && hardware && (flags & (keyboard ? 0x12u : 3u)) == 0 && unchecked(now - time) < 5000; }
    public ConsentInput(IntPtr hwnd)
    {
        window = hwnd; mouseCallback = MouseHook; keyCallback = KeyHook;
        mouse = SetWindowsHookEx(14, mouseCallback, GetModuleHandle(null), 0);
        key = SetWindowsHookEx(13, keyCallback, GetModuleHandle(null), 0);
        if (mouse == IntPtr.Zero || key == IntPtr.Zero) { Dispose(); throw new InvalidOperationException("PERSON_INPUT_UNAVAILABLE"); }
    }
    void Save(Evidence e) { pending.RemoveAll(p => unchecked(GetTickCount() - p.Time) >= 5000); if (pending.Count >= 16) pending.RemoveAt(0); pending.Add(e); }
    IntPtr MouseHook(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0) {
            var m = (Mouse)Marshal.PtrToStructure(data, typeof(Mouse)); uint msg = unchecked((uint)message.ToInt64());
            // Hit testing can call another process. Do it only on button-down, never on mouse move or up.
            if (!Fresh(GetTickCount(), m.Time, m.Flags, false, true, true)) Clear();
            else if (msg == 0x201) {
                Clear(); ownDown = GetAncestor(WindowFromPoint(m.Point), 2) == window;
                if (ownDown) Save(new Evidence { Message = msg, Time = m.Time, X = m.Point.X, Y = m.Point.Y });
            } else if (msg == 0x202) {
                if (ownDown) Save(new Evidence { Message = msg, Time = m.Time, X = m.Point.X, Y = m.Point.Y }); ownDown = false;
            }
        }
        return CallNextHookEx(mouse, code, message, data);
    }
    IntPtr KeyHook(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0) {
            var k = (Key)Marshal.PtrToStructure(data, typeof(Key)); uint msg = unchecked((uint)message.ToInt64());
            if (!Fresh(GetTickCount(), k.Time, k.Flags, true, GetForegroundWindow() == window, true)) pending.Clear();
            else if (msg == 0x100) Save(new Evidence { Message = msg, Time = k.Time, Code = k.Vk });
        }
        return CallNextHookEx(key, code, message, data);
    }
    bool Consume(int msg, IntPtr wparam, Point screen)
    {
        Source source; uint time = unchecked((uint)GetMessageTime()), now = GetTickCount();
        bool hardware = GetCurrentInputMessageSource(out source) && HardwareSource(source.Origin, source.Device, msg == 0x100);
        Bounds bounds; bool own = GetForegroundWindow() == window && (msg == 0x100 || GetWindowRect(window, out bounds) && screen.X >= bounds.Left && screen.X < bounds.Right && screen.Y >= bounds.Top && screen.Y < bounds.Bottom);
        if (!Fresh(now, time, 0, msg == 0x100, own, hardware)) { Clear(); return false; }
        int n = pending.FindIndex(e => e.Message == msg && e.Time == time && (msg == 0x100 ? e.Code == unchecked((uint)wparam.ToInt64()) : e.X == screen.X && e.Y == screen.Y));
        if (n < 0) { Clear(); return false; } pending.RemoveRange(0, n + 1); return true;
    }
    public bool ConsumeMessage(int msg, IntPtr wparam, System.Drawing.Point screen) { return Consume(msg, wparam, new Point { X = screen.X, Y = screen.Y }); }
    public void Dispose() { if (mouse != IntPtr.Zero) { UnhookWindowsHookEx(mouse); mouse = IntPtr.Zero; } if (key != IntPtr.Zero) { UnhookWindowsHookEx(key); key = IntPtr.Zero; } pending.Clear(); }
    public static void SelfTest()
    {
        var cases = new Dictionary<string, bool> { { "mouse", Fresh(101, 100, 0, false, true, true) }, { "key", Fresh(101, 100, 0, true, true, true) },
            { "mouse-injected", !Fresh(101, 100, 1, false, true, true) }, { "mouse-lower", !Fresh(101, 100, 2, false, true, true) },
            { "key-injected", !Fresh(101, 100, 16, true, true, true) }, { "key-lower", !Fresh(101, 100, 2, true, true, true) },
            { "old", !Fresh(5100, 100, 0, false, true, true) }, { "future", !Fresh(100, 101, 0, false, true, true) },
            { "foreign-window", !Fresh(101, 100, 0, false, false, true) }, { "automation", !Fresh(101, 100, 0, false, true, false) },
            { "wrap", Fresh(10, UInt32.MaxValue - 10, 0, false, true, true) } };
        foreach (int device in new[] { 4, 8, 16 }) cases["refused-device-" + device] = !HardwareSource(1, device, false);
        cases["dpi-null-bounds"] = !ConsentWindow.DpiChangeAllowed(IntPtr.Zero, 144);
        foreach (uint dpi in new uint[] { 0, 47, 769, UInt32.MaxValue }) cases["dpi-refused-" + dpi] = !ConsentWindow.DpiChangeAllowed(new IntPtr(1), dpi);
        foreach (uint dpi in new uint[] { 48, 144, 768 }) cases["dpi-accepted-" + dpi] = ConsentWindow.DpiChangeAllowed(new IntPtr(1), dpi);
        cases["hardware-mouse-source"] = HardwareSource(1, 2, false); cases["hardware-key-source"] = HardwareSource(1, 1, true);
        cases["injected-source"] = !HardwareSource(2, 2, false);
        ConsentPolicy.Test(cases);
        // A memory DC measures actual Windows font metrics without constructing a Form or HWND.
        int baseWidth = 0, baseHeight = 0;
        foreach (uint dpi in new uint[] { 96, 120, 144, 192 }) using (var bitmap = new Bitmap(1, 1)) {
            bitmap.SetResolution(dpi, dpi);
            using (var g = Graphics.FromImage(bitmap)) {
                var choices = new[] { "cancel", "session", "always" };
                const string instructions = "Allow this session: type birch, then Return.  Always allow: type cedar, then Return.";
                using (var layout = new ConsentLayout(g, dpi, choices, new string('W', 512), instructions, ConsentWindow.KeyboardHelp)) {
                    var bounds = new Rectangle(System.Drawing.Point.Empty, layout.Size);
                    var rectangles = new[] { layout.Icon, layout.Brand, layout.Question, layout.Detail, layout.Feedback, layout.Instructions, layout.WordField }.Concat(layout.Buttons).ToArray();
                    cases["layout-bounds-" + dpi] = rectangles.All(r => r.Width > 0 && r.Height > 0 && bounds.Contains(r));
                    cases["layout-labels-" + dpi] = choices.Select((c, n) => TextRenderer.MeasureText(g, ConsentCard.Label(c), layout.Small, Size.Empty, ConsentLayout.LabelFlags).Width + 2 * layout.Padding <= layout.Buttons[n].Width).All(x => x);
                    cases["layout-text-" + dpi] = TextRenderer.MeasureText(g, instructions, layout.Small, new Size(layout.Instructions.Width, Int32.MaxValue), ConsentLayout.TextFlags & ~TextFormatFlags.EndEllipsis).Height <= layout.Instructions.Height &&
                        TextRenderer.MeasureText(g, ConsentWindow.KeyboardHelp, layout.Small, new Size(layout.Feedback.Width, Int32.MaxValue), ConsentLayout.TextFlags & ~TextFormatFlags.EndEllipsis).Height <= layout.Feedback.Height;
                    cases["layout-hit-" + dpi] = layout.Buttons.Select((r, n) => layout.Hit(new System.Drawing.Point(r.Left + r.Width / 2, r.Top + r.Height / 2)) == n &&
                        layout.Hit(new System.Drawing.Point(r.Left, r.Bottom)) == -1).All(x => x) && layout.Hit(layout.WordField.Location) == -1;
                    if (dpi == 96) { baseWidth = layout.Size.Width; baseHeight = layout.Size.Height; }
                    double scale = dpi / 96.0;
                    cases["layout-scale-" + dpi] = Math.Abs(layout.Size.Width / (double)baseWidth - scale) < 0.15 && Math.Abs(layout.Size.Height / (double)baseHeight - scale) < 0.2;
                }
            }
        }
        using (var bitmap = new Bitmap(1, 1)) using (var g = Graphics.FromImage(bitmap)) {
            // 1280 x 720 at 150 percent, reserving 24 px borders, 60 px caption and 48 px taskbar.
            var maximum = new Size(1256, 612);
            foreach (int count in new[] { 2, 3 }) {
                var choices = count == 2 ? new[] { "cancel", "once" } : new[] { "cancel", "session", "always" };
                using (var layout = new ConsentLayout(g, 144, choices, new string('W', 512),
                    "Allow this session: type birch, then Return.  Always allow: type cedar, then Return.", ConsentWindow.KeyboardHelp, maximum)) {
                    cases["layout-work-area-" + count] = layout.Size.Width <= maximum.Width && layout.Size.Height <= maximum.Height;
                    cases["layout-work-area-buttons-" + count] = layout.Buttons.Select((r, n) => new Rectangle(System.Drawing.Point.Empty, layout.Size).Contains(r) &&
                        r.Width >= TextRenderer.MeasureText(g, ConsentCard.Label(choices[n]), layout.Small, Size.Empty, ConsentLayout.LabelFlags).Width + 2 * layout.Padding).All(x => x);
                    int bodyLine = TextRenderer.MeasureText(g, "Ag", layout.Body, Size.Empty, ConsentLayout.LabelFlags).Height;
                    cases["layout-work-area-scroll-" + count] = layout.Detail.Height >= 3 * bodyLine && layout.Detail.Height < 10 * bodyLine;
                    var shortArea = new Size(maximum.Width, layout.Size.Height - layout.Detail.Height + 3 * bodyLine - 1);
                    cases["layout-refuses-short-" + count] = false;
                    try { using (var tiny = new ConsentLayout(g, 144, choices, new string('W', 512),
                        "Allow this session: type birch, then Return.  Always allow: type cedar, then Return.", ConsentWindow.KeyboardHelp, shortArea)) {} }
                    catch (FrameFault) { cases["layout-refuses-short-" + count] = true; }
                    using (var minimum = new ConsentLayout(g, 144, choices, new string('W', 512),
                        "Allow this session: type birch, then Return.  Always allow: type cedar, then Return.", ConsentWindow.KeyboardHelp, new Size(shortArea.Width, shortArea.Height + 1))) {
                        cases["layout-minimum-lines-" + count] = minimum.Detail.Height == 3 * bodyLine;
                    }
                    int labelWidth = choices.Max(c => TextRenderer.MeasureText(g, ConsentCard.Label(c), layout.Small, Size.Empty, ConsentLayout.LabelFlags).Width);
                    int gap = Math.Max(1, (layout.Padding + 1) / 2);
                    var narrowArea = new Size(2 * layout.Padding + count * (labelWidth + 2 * layout.Padding) + (count - 1) * gap - 1, 2000);
                    cases["layout-refuses-narrow-" + count] = false;
                    try { using (var tiny = new ConsentLayout(g, 144, choices, "Allow?", "Type birch, then Return.", ConsentWindow.KeyboardHelp, narrowArea)) {} }
                    catch (FrameFault) { cases["layout-refuses-narrow-" + count] = true; }
                    using (var minimum = new ConsentLayout(g, 144, choices, "Allow?", "Type birch, then Return.",
                        ConsentWindow.KeyboardHelp, new Size(narrowArea.Width + 1, narrowArea.Height))) {
                        cases["layout-minimum-labels-" + count] = minimum.Buttons.All(r => r.Width == labelWidth + 2 * minimum.Padding);
                    }
                }
            }
            using (var layout = new ConsentLayout(g, 144, new[] { "cancel", "once" }, "Allow?", "Type birch, then Return.",
                ConsentWindow.KeyboardHelp, new Size(640, 900))) {
                cases["layout-work-area-width"] = layout.Size.Width == 640;
            }
        }
        if (cases.Values.Any(x => !x)) throw new FrameFault(); Program.Write(J.Map("ok", true, "cases", cases));
    }
}
public sealed class ConsentWindow : Form
{
    sealed class RequestText : TextBox
    {
        public Action Released;
        protected override void WndProc(ref Message m) {
            base.WndProc(ref m);
            if (m.Msg == 0x202 && Released != null) Released();
        }
    }
    [DllImport("kernel32.dll")] static extern uint GetTickCount();
    [DllImport("user32.dll")] static extern int GetMessageTime();
    [DllImport("user32.dll")] static extern short GetKeyState(int key);
    public const string KeyboardHelp = "Use your own click. For keyboard confirmation, focus the word field with Tab or a click. Esc cancels.";
    [StructLayout(LayoutKind.Sequential)] struct DpiBounds { public int Left, Top, Right, Bottom; }
    readonly ConsentCard card; readonly Timer timer = new Timer(); readonly RequestText detail; ConsentInput input;
    readonly ConsentPolicy policy; ConsentLayout layout;
    int pressed = -1; bool answered; string feedback = KeyboardHelp;
    static long Now { get { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); } }
    public ConsentWindow(ConsentCard c)
    {
        card = c; policy = new ConsentPolicy(c.Choices); Text = "sleight"; FormBorderStyle = FormBorderStyle.FixedDialog;
        AccessibleName = c.Question + " " + policy.Instructions; AccessibleDescription = feedback;
        AutoScaleMode = AutoScaleMode.None;
        MaximizeBox = MinimizeBox = false; ShowInTaskbar = false; StartPosition = FormStartPosition.CenterScreen; TopMost = true;
        BackColor = Color.FromArgb(27, 29, 34); ForeColor = Color.White; DoubleBuffered = true;
        detail = new RequestText { Text = ConsentCard.Lines(c.Question + "\n\n" + c.Detail), ReadOnly = true, Multiline = true, ScrollBars = ScrollBars.Vertical,
            BorderStyle = BorderStyle.None, BackColor = BackColor, ForeColor = Color.LightGray, TabStop = false };
        Controls.Add(detail);
        detail.Released = () => { if (input != null) input.Clear(); policy.Reset(); pressed = -1; ActiveControl = null; Focus(); Invalidate(); };
        timer.Interval = 100; timer.Tick += (s, e) => { if (Now >= card.Deadline) Finish("cancel"); };
    }
    void LayoutCard(uint dpi, Rectangle workArea)
    {
        ConsentLayout next;
        // Reserve the caption and fixed-dialog borders as well as the client area.
        var border = SizeFromClientSize(System.Drawing.Size.Empty);
        var maximum = new Size(workArea.Width - border.Width, workArea.Height - border.Height);
        using (var g = CreateGraphics()) next = new ConsentLayout(g, dpi, card.Choices, card.Question, policy.Instructions, KeyboardHelp, maximum);
        var previous = layout; layout = next;
        MinimumSize = MaximumSize = System.Drawing.Size.Empty; ClientSize = layout.Size; MinimumSize = MaximumSize = Size;
        Location = new System.Drawing.Point(Math.Max(workArea.Left, Math.Min(Left, workArea.Right - Width)),
            Math.Max(workArea.Top, Math.Min(Top, workArea.Bottom - Height)));
        detail.Font = layout.Body; detail.Bounds = layout.Detail;
        if (previous != null) previous.Dispose();
        if (input != null) input.Clear(); policy.Reset(); pressed = -1; Invalidate();
    }
    protected override bool IsInputKey(Keys keyData) { return true; }
    protected override void OnActivated(EventArgs e) { policy.Activate(GetTickCount()); if (input != null) input.Clear(); pressed = -1; base.OnActivated(e); }
    protected override void OnDeactivate(EventArgs e) { policy.Deactivate(); if (input != null) input.Clear(); pressed = -1; Invalidate(); base.OnDeactivate(e); }
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        try { LayoutCard(Win.GetDpiForWindow(Handle), Screen.FromHandle(Handle).WorkingArea); }
        catch (FrameFault) { Answer("cancel"); BeginInvoke(new Action(Close)); return; }
        input = new ConsentInput(Handle); timer.Start();
    }
    protected override void OnFormClosed(FormClosedEventArgs e) { timer.Stop(); if (input != null) input.Dispose(); if (!answered) Answer("cancel"); base.OnFormClosed(e); }
    void Answer(string choice) { if (answered) return; answered = true; Program.Write(J.Map("nonce", card.Nonce, "id", card.Id, "choice", choice)); }
    void Finish(string choice) { if (input != null) input.Clear(); policy.Reset(); pressed = -1; Answer(Now < card.Deadline ? choice : "cancel"); Close(); }
    protected override void Dispose(bool disposing) { base.Dispose(disposing); if (disposing) { timer.Dispose(); if (layout != null) { layout.Dispose(); layout = null; } } }
    protected override void WndProc(ref Message m)
    {
        if (m.Msg == 0x2e0) {
            uint dpi = unchecked((uint)m.WParam.ToInt64()) & 65535u;
            if (!DpiChangeAllowed(m.LParam, dpi)) { m.Result = IntPtr.Zero; return; }
            var suggested = (DpiBounds)Marshal.PtrToStructure(m.LParam, typeof(DpiBounds));
            var workArea = Screen.FromRectangle(new Rectangle(suggested.Left, suggested.Top,
                suggested.Right - suggested.Left, suggested.Bottom - suggested.Top)).WorkingArea;
            base.WndProc(ref m); Location = new System.Drawing.Point(suggested.Left, suggested.Top);
            try { LayoutCard(dpi, workArea); }
            catch (FrameFault) { Finish("cancel"); }
            return;
        }
        // Default Form/read-only TextBox accessibility remains readable. Drawn decisions have no Invoke provider.
        if (m.Msg == 0x111 || m.Msg == 0xf5 || m.Msg == 0x102 || m.Msg == 0x103) { m.Result = IntPtr.Zero; return; }
        if (m.Msg == 0x201 || m.Msg == 0x202 || m.Msg == 0x100) {
            int packed = unchecked((int)m.LParam.ToInt64()); var point = new System.Drawing.Point((short)(packed & 65535), (short)(packed >> 16));
            uint now = GetTickCount(), time = unchecked((uint)GetMessageTime());
            bool trusted = input != null && input.ConsumeMessage(m.Msg, m.WParam, PointToScreen(point)) && Now < card.Deadline && policy.Armed(now, time);
            if (!trusted) { if (input != null) input.Clear(); policy.Reset(); pressed = -1; feedback = "Wait for the card, then use your own click or type a confirmation word."; Invalidate(); return; }
            if (m.Msg == 0x100) {
                bool repeat = (m.LParam.ToInt64() & (1L << 30)) != 0;
                bool modifiers = new[] { 17, 18, 91, 92 }.Any(key => (GetKeyState(key) & 0x8000) != 0);
                string choice = policy.Key((int)m.WParam, now, time, trusted, repeat, modifiers);
                if (choice != null) Finish(choice); else Invalidate();
            } else {
                int hit = layout.Hit(point);
                if (m.Msg == 0x201) { policy.Reset(); pressed = layout.WordField.Contains(point) ? -2 : hit; }
                else {
                    if (hit >= 0 && pressed == hit) Finish(card.Choices[hit]);
                    else if (layout.WordField.Contains(point) && pressed == -2) policy.FocusWord();
                    if (input != null) input.Clear(); pressed = -1; Invalidate();
                }
            }
            return;
        }
        base.WndProc(ref m);
    }
    public static bool DpiChangeAllowed(IntPtr bounds, uint dpi) { return bounds != IntPtr.Zero && dpi >= 48 && dpi <= 768; }
    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e); if (layout == null) return; var g = e.Graphics;
        using (var icon = new Pen(Color.FromArgb(110, 174, 255), 3 * layout.Stroke)) g.DrawEllipse(icon, layout.Icon);
        TextRenderer.DrawText(g, "sleight · computer use", layout.Small, layout.Brand, Color.Silver, ConsentLayout.TextFlags);
        TextRenderer.DrawText(g, card.Question, layout.Title, layout.Question, ForeColor, ConsentLayout.TextFlags);
        TextRenderer.DrawText(g, feedback, layout.Small, layout.Feedback, Color.Silver, ConsentLayout.TextFlags);
        TextRenderer.DrawText(g, policy.Instructions, layout.Small, layout.Instructions, Color.Silver, ConsentLayout.TextFlags);
        using (var pen = new Pen(policy.WordFocused ? Color.LightSkyBlue : Color.Gray, layout.Stroke)) g.DrawRectangle(pen, layout.WordField);
        TextRenderer.DrawText(g, policy.Mask.Length > 0 ? policy.Mask : "Type a word, then Return", layout.Small, layout.WordField, Color.Silver, ConsentLayout.LabelFlags | TextFormatFlags.VerticalCenter);
        for (int i = 0; i < layout.Buttons.Length; i++) { using (var pen = new Pen(Color.Gray, layout.Stroke)) g.DrawRectangle(pen, layout.Buttons[i]);
            TextRenderer.DrawText(g, ConsentCard.Label(card.Choices[i]), layout.Small, layout.Buttons[i], ForeColor, ConsentLayout.LabelFlags | TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter); }
        // Start only after the first paint completes; activation has its own delay, including reactivation.
        policy.Paint(GetTickCount());
    }
    public static void Run(bool validate)
    {
        var request = BrowserGate.ReadRequest();
        if (J.S(J.Get(request, "op")) != "consent") throw new FrameFault();
        request.Remove("op");
        var card = ConsentCard.Parse(request, Environment.GetEnvironmentVariable("SLEIGHT_WINDOWS_APP_CARD") == "1"); long remaining = card.Deadline - Now;
        if (remaining <= 0 || remaining > 300000) throw new FrameFault();
        if (validate) { Program.Write(J.Map("ok", true, "drawing", false)); return; }
        BrowserGate.NormalUser();
        if (!Win.SetProcessDpiAwarenessContext(new IntPtr(-4)) && !Win.AreDpiAwarenessContextsEqual(Win.GetThreadDpiAwarenessContext(), new IntPtr(-4)))
            throw new InvalidOperationException("WINDOWS_DPI_UNAVAILABLE");
        Application.EnableVisualStyles(); using (var window = new ConsentWindow(card)) Application.Run(window);
    }
}
}
