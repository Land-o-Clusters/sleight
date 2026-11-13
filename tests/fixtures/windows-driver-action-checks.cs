// Headless checks of production functions. No UIA activation, P/Invoke or windows.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
namespace Sleight.Driver
{
internal static class DriverActionChecks
{
    static int passed;
    static void Check(bool value) { if (!value) throw new Exception("Action check " + (passed + 1)); passed++; }
    static Dictionary<string, object> Params(params object[] args) {
        return Json.Map("windowId", "101", "processStart", "134059077770000001", "readId", 1, "args", args);
    }
    static void Refuse(Action action) {
        try { action(); throw new Exception("Accepted invalid action"); }
        catch (DriverFault e) { Check(e.Code == "INVALID_PARAMS"); }
    }
    static void Validation()
    {
        foreach (var method in DriverActionPlan.Methods) {
            object[] args;
            switch (method) {
            case "typeText": case "paste": args = new object[] { "日本 🪄\r\n" }; break;
            case "pressKey": args = new object[] { "ctrl+s" }; break;
            case "setValue": case "selectText": args = new object[] { 3, "sample" }; break;
            case "performSecondaryAction": args = new object[] { 3, "Expand" }; break;
            case "scroll": args = new object[] { 3, Json.Map("direction", "down", "amount", 3) }; break;
            case "drag": args = new object[] { new object[] { 1, 2 }, new object[] { 30, 40 }, Json.Map("steps", 8, "durationMs", 500) }; break;
            default: args = new object[] { 3 }; break;
            }
            Check(DriverActionPlan.Parse(method, Params(args)).Method == method);
            var p = Params(args); p.Remove("processStart"); Refuse(() => DriverActionPlan.Parse(method, p));
            p = Params(args); p.Add("foreground", true); Refuse(() => DriverActionPlan.Parse(method, p));
            p = Params(args); p["readId"] = 0; Refuse(() => DriverActionPlan.Parse(method, p));
        }
        foreach (object target in new object[] { -1, 3000, 1.5, true, null, new object[] { 1, 2, 3 },
            new object[] { Double.NaN, 1 }, new object[] { -1, 0 }, Json.Map("id", "a", "label", "b"),
            Json.Map("label", "a\0b"), Json.Map("id", new object()), Json.Map("id", "") }) {
            object t = target; Refuse(() => DriverActionPlan.Parse("click", Params(new object[] { t })));
        }
        foreach (string s in new[] { "a\0b", "\ud800", "\udc00", new string('a', 65537) }) {
            string text = s; Refuse(() => DriverActionPlan.Parse("typeText", Params(text)));
        }
        Refuse(() => DriverActionPlan.Parse("paste", Params("x", Json.Map("format", "html"))));
        Refuse(() => DriverActionPlan.Parse("scroll", Params(3, Json.Map("direction", "down", "amount", -1))));
        Refuse(() => DriverActionPlan.Parse("scroll", Params(3, Json.Map("direction", "sideways"))));
        Refuse(() => DriverActionPlan.Parse("drag", Params(1, 2, Json.Map("steps", 65))));
        Refuse(() => DriverActionPlan.Parse("drag", Params(1, 2, Json.Map("durationMs", 499))));
        Refuse(() => DriverActionPlan.Parse("performSecondaryAction", Params(3, "activate")));
        foreach (string field in new[] { "windowId", "processStart" }) foreach (string bad in new[] { "0", "-1", "01", "1.5", "18446744073709551616" }) {
            var p = Params(3); p[field] = bad; Refuse(() => DriverActionPlan.Parse("click", p));
        }
        // Exercise JSON deserialization, rather than only hand-built arrays.
        var wire = Json.Object(Json.Codec.DeserializeObject("{\"windowId\":\"101\",\"processStart\":\"3\",\"readId\":1,\"args\":[[1,2],[30,40]]}"));
        Check(DriverActionPlan.Parse("drag", wire).Destination is object[]);
    }
    static void Ladder()
    {
        foreach (int code in new[] { unchecked((int)0x80040204), unchecked((int)0x80004002) }) {
            int status = code; Check(DriverUia.ReadPattern(() => { throw new COMException("not supported", status); }) == null);
        }
        foreach (int code in new[] { unchecked((int)0x80040200), unchecked((int)0x80131505) }) {
            int status = code;
            try { DriverUia.ReadPattern(() => { throw new COMException("disabled or timed out", status); }); Check(false); }
            catch (COMException e) { Check(e.ErrorCode == status); }
        }
        var ids = new[] { 10000, 10015, 10010, 10005, 10018 };
        var names = new[] { "Invoke", "Toggle", "Select", "Expand/Collapse", "DoDefaultAction" };
        for (int i = 0; i < ids.Length; i++) {
            int index = i, called = 0;
            string route = DriverUia.ClickLadder(id => ids.Skip(index).Contains(id) ? new object() : null,
                (p, name) => { Check(name == names[index]); called++; }, 0, p => "Press");
            Check(route == names[i] && called == 1);
        }
        Check(DriverUia.ClickLadder(id => null, (p, name) => { throw new Exception(); }) == null);
        int calls = 0;
        try {
            DriverUia.ClickLadder(id => new object(), (p, name) => { calls++; throw new InvalidOperationException(); });
            Check(false);
        } catch (InvalidOperationException) { Check(calls == 1); }
    }
    static void Chords()
    {
        foreach (var row in new[] { new[] { "return", "13" }, new[] { "escape", "27" }, new[] { "tab", "9" },
            new[] { "f1", "112" }, new[] { "f24", "135" }, new[] { "left", "37" }, new[] { "s", "0" }, new[] { "é", "0" } })
            Check(DriverChord.VirtualKey(row[0]).ToString() == row[1]);
        Check(DriverChord.Parse("ctrl+shift+enter").Canonical == DriverChord.Parse("shift+control+return").Canonical);
        Check(DriverChord.Parse("super+left").Modifiers.SequenceEqual(new[] { 91 }));
        Check(DriverChord.Parse("shift").Key == null);
        foreach (string s in new[] { "ctrl+ctrl+s", "ctrl+", "ctrl+alt", "a+b", "a+ctrl", "f25", "ctrl+🪄" }) {
            string chord = s; Refuse(() => DriverChord.Parse(chord));
        }
    }
    static void SettleAndDpi()
    {
        var main = new WindowRecord { Handle = new IntPtr(101) };
        var popup = new WindowRecord { Handle = new IntPtr(102) };
        var background = new DriverNode { Host = main, Depth = 9, RootOrder = 0, Rectangle = new double[] { 0, 0, 100, 100 } };
        var top = new DriverNode { Host = popup, Depth = 1, RootOrder = 10, Rectangle = new double[] { 0, 0, 100, 100 } };
        var lower = new DriverNode { Host = popup, Depth = 5, RootOrder = 20, Rectangle = new double[] { 0, 0, 100, 100 } };
        var nodes = new[] { background, lower, top };
        Check(DriverUia.HitTest(nodes, main.Handle, new DriverPoint(10, 20)) == top);
        top.Offscreen = true;
        Check(DriverUia.HitTest(nodes, main.Handle, new DriverPoint(10, 20)) == lower);
        lower.Offscreen = true;
        Check(DriverUia.HitTest(nodes, main.Handle, new DriverPoint(10, 20)) == background);
        Check(DriverSettle.Decision(119, 119, 1, true, false) == "wait");
        Check(DriverSettle.Decision(120, 120, 1, true, false) == "event-quiet");
        Check(DriverSettle.Decision(700, 5, 20, true, false) == "wait");
        Check(DriverSettle.Decision(1500, 1500, 1, true, true) == "cap");
        Check(DriverSettle.Decision(220, 220, 0, false, true) == "poll-stable");
        Check(DriverSettle.Decision(220, 220, 0, true, false) == "wait");
        foreach (double scale in new[] { 1.0, 1.25, 1.5, 2.0 }) foreach (int origin in new[] { 0, -1920 }) {
            var start = new DriverPoint(origin, -200);
            var physical = new DriverPoint(origin + (int)(200 * scale), -200 + (int)(100 * scale));
            var logical = DriverInput.ConvertPoint(physical, start, p => new DriverPoint((int)Math.Round(p.X / scale), (int)Math.Round(p.Y / scale)));
            Check(logical.X == 200 && logical.Y == 100);
            var aware = DriverInput.ConvertPoint(physical, start, p => p);
            Check(aware.X == 200 * scale && aware.Y == 100 * scale);
        }
        Check(DriverInput.Pack(new DriverPoint(-1, -2)).ToInt64() == 0xfffeffffL);
        try { DriverInput.Pack(new DriverPoint(32768, 0)); Check(false); }
        catch (DriverFault e) { Check(e.Code == "INVALID_COORDINATES"); }
    }
    static void Regressions()
    {
        foreach (string text in new[] { new string('a', 4001), "\x03", "\x16", "\x18", "\x1a", "\x1f" }) {
            string invalid = text; Refuse(() => DriverActionPlan.Parse("typeText", Params(invalid)));
        }
        Check(DriverActionPlan.Parse("typeText", Params(new string('a', 4000))).Text.Length == 4000);
        Check(DriverActionPlan.Parse("typeText", Params("\t\r\n🪄")).Text.Length == 5);
        Check(DriverActionPlan.Parse("paste", Params(new string('a', 4000))).Text.Length == 4000);
        string astralPaste = String.Concat(Enumerable.Repeat("🪄", 2000));
        Check(DriverActionPlan.Parse("paste", Params(astralPaste)).Text.Length == 4000);
        foreach (string oversized in new[] { new string('a', 4001), astralPaste + "a", new string('a', 65536) })
            Refuse(() => DriverActionPlan.Parse("paste", Params(oversized)));
        foreach (string text in new[] { "ctrl+s", "win+a", "shift+/", "ctrl+space" }) {
            var chord = DriverChord.Parse(text);
            try { chord.PostedLimits(chord.Modifiers); Check(false); }
            catch (DriverFault e) { Check(e.Code == "CHORD_NEEDS_FOREGROUND" && e.Message.Contains("foreground")); }
        }
        foreach (string input in new[] { "ctrl+left", "shift+tab", "super+left", "alt+f4" }) {
            var chord = DriverChord.Parse(input);
            try { chord.PostedLimits(chord.Modifiers); Check(false); }
            catch (DriverFault e) { Check(e.Code == "CHORD_NEEDS_FOREGROUND"); }
        }
        Check(DriverChord.Parse("a").PostedLimits(new int[0]).Length == 0);
        try { DriverChord.Parse("?").PostedLimits(new[] { 16 }); Check(false); }
        catch (DriverFault e) { Check(e.Code == "CHORD_NEEDS_FOREGROUND"); }
        foreach (int type in new[] { 50004, 50020, 50030, 50033 }) {
            Check(DriverUia.ClickLadder(id => { throw new Exception("Must skip patterns"); }, (p, name) => { }, type) == null);
        }
        int invoked = 0;
        Check(DriverUia.ClickLadder(id => id == 10018 ? new object() : null, (p, name) => invoked++, 0, p => "") == null);
        Check(invoked == 0);
        var codes = new[] { "STALE_ELEMENT", "ELEMENT_DISABLED", "PROVIDER_TIMEOUT", "ACCESS_DENIED", "ACTION_REFUSED", "UIA_UNAVAILABLE" };
        var hresults = new uint[] { 0x80040201, 0x80040200, 0x80131505, 0x80070005, 0x80131509, 0x80004005 };
        for (int i = 0; i < hresults.Length; i++) {
            Check(DriverUia.ProviderCode(unchecked((int)hresults[i])) == codes[i]);
            var fault = DriverUia.ActionFailure(codes[i], codes[i], true, true, 17);
            Check(fault.Code == codes[i] && fault.Message.Contains("input may have landed") && fault.Message.Contains("typed=17"));
            Check(!DriverUia.ActionFailure(codes[i], codes[i], false, false, 0).Message.Contains("may have landed"));
        }
        var events = new List<string>();
        Check(DriverClipboard.DirectPaste("café 日本 🪄", () => events.Add("validate"), () => { events.Add("characters"); return "WM_CHAR"; }) == "WM_CHAR");
        Check(String.Join(",", events) == "validate,characters");
        foreach (string unsupported in new[] { "a\tb", "a\r\nb", "a\nb", "\x03", "\x16", "\x7f" }) {
            events.Clear();
            try { DriverClipboard.DirectPaste(unsupported, () => events.Add("validate"), () => { events.Add("input"); return "WM_CHAR"; }); Check(false); }
            catch (DriverFault e) { Check(e.Code == "BACKGROUND_UNAVAILABLE" && e.Message.Contains("control characters")); }
            Check(events.Count == 0);
        }
        foreach (string refusal in new[] { "ELEMENT_READ_ONLY", "NO_BACKGROUND_FOCUS", "IDENTITY_CHANGED", "BACKGROUND_UNAVAILABLE" }) {
            events.Clear();
            try { DriverClipboard.DirectPaste("safe", () => { throw new DriverFault(refusal); }, () => { events.Add("input"); return "WM_CHAR"; }); Check(false); }
            catch (DriverFault e) { Check(e.Code == refusal); }
            Check(events.Count == 0);
        }
        int deliveries = 0;
        try { DriverClipboard.DirectPaste("safe", () => { }, () => { deliveries++; throw new DriverFault("ACTION_UNCONFIRMED"); }); Check(false); }
        catch (DriverFault e) { Check(e.Code == "ACTION_UNCONFIRMED" && deliveries == 1); }
        // No native paste dependency can import a clipboard API, even on failure paths.
        foreach (Type type in new[] { typeof(DriverClipboard), typeof(DriverInput), typeof(DriverUia) })
            foreach (var method in type.GetMethods(System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic))
                foreach (DllImportAttribute import in method.GetCustomAttributes(typeof(DllImportAttribute), false))
                    Check(import.EntryPoint.IndexOf("Clipboard", StringComparison.OrdinalIgnoreCase) < 0);
        DriverInput.RequireEditStyle("Edit", 0);
        DriverInput.RequireEditStyle("RichEdit50W", 0);
        foreach (string cls in new[] { "Edit", "RichEdit20W" }) {
            try { DriverInput.RequireEditStyle(cls, 0x800); Check(false); }
            catch (DriverFault e) { Check(e.Code == "ELEMENT_READ_ONLY"); }
        }
        foreach (string cls in new[] { "Chrome_RenderWidgetHostHWND", "Static", "HwndWrapper[fixture]" }) {
            try { DriverInput.RequireEditStyle(cls, 0); Check(false); }
            catch (DriverFault e) { Check(e.Code == "BACKGROUND_UNAVAILABLE"); }
        }
        int tries = 0, pauses = 0;
        DriverInput.RetryPost(() => ++tries == 4, () => 1816, () => pauses++, () => { }, true);
        Check(tries == 4 && pauses == 3);
        tries = pauses = 0;
        try { DriverInput.RetryPost(() => { tries++; return false; }, () => 1816, () => pauses++, () => { }, true); Check(false); }
        catch (DriverFault e) { Check(e.Code == "BACKGROUND_INPUT_FAILED"); }
        Check(tries == 11 && pauses == 10);
        tries = 0;
        try { DriverInput.RetryPost(() => { tries++; return false; }, () => 5, () => { throw new Exception(); }, () => { }, true); Check(false); }
        catch (DriverFault e) { Check(e.Code == "BACKGROUND_INPUT_FAILED" && tries == 1); }
        int posts = 0, checks = 0, flows = 0, last = 0, maxChunk = 0;
        DriverInput.PumpText(new string('a', 4000), false, (m, c, up) => posts++, () => checks++, () => { flows++; maxChunk = Math.Max(maxChunk, posts - last); last = posts; });
        Check(posts == 4000 && DriverInput.Typed == 4000 && checks == 63 && flows == 16 && maxChunk <= 256);
        posts = checks = flows = last = maxChunk = 0;
        DriverInput.PumpText(new string('\n', 4000), false, (m, c, up) => posts++, () => checks++, () => { flows++; maxChunk = Math.Max(maxChunk, posts - last); last = posts; });
        Check(posts == 12000 && DriverInput.Typed == 4000 && maxChunk <= 258);
        posts = 0;
        try { DriverInput.PumpText("abcdef", false, (m, c, up) => { if (posts == 3) throw new DriverFault("ACTION_BUDGET"); posts++; }, () => { }, () => { }); Check(false); }
        catch (DriverFault e) { Check(e.Code == "ACTION_BUDGET" && e.Message.Contains("typed=3")); }
        Check(posts == 3 && DriverInput.Typed == 3);
        var messages = new List<uint>();
        DriverInput.PumpText("🪄\r\n", true, (m, c, up) => messages.Add(m), () => { }, () => { });
        Check(DriverInput.Typed == 4 && messages.SequenceEqual(new uint[] { 0x109, 0x100, 0x102, 0x101 }));
        messages.Clear();
        try { DriverInput.PumpText("\n", false, (m, c, up) => { messages.Add(m); if (m == 0x102) throw new DriverFault("TEST"); }, () => { }, () => { }); Check(false); }
        catch (DriverFault e) { Check(e.Code == "TEST" && e.Message.Contains("typed=0")); }
        Check(messages.SequenceEqual(new uint[] { 0x100, 0x102, 0x101 }));
    }
    static void Routes()
    {
        DriverInput.InputAttempted = false;
        for (int route = 0; route < 2; route++) {
            int chosen = route; var calls = new List<int>();
            Func<int, string> attempt = n => { calls.Add(n); return n == chosen ? "route" + n : null; };
            Check(DriverUia.BackgroundRoute("click", () => attempt(0), () => attempt(1)) == "route" + chosen);
            Check(calls.SequenceEqual(Enumerable.Range(0, chosen + 1)));
        }
        foreach (string action in new[] { "click", "typeText", "pressKey", "paste", "scroll", "setValue", "drag" }) {
            try { DriverUia.BackgroundRoute(action, () => null, () => null); Check(false); }
            catch (DriverFault e) { Check(e.Code == "BACKGROUND_UNAVAILABLE" && e.Message.Contains(action)); }
            try { DriverUia.BackgroundRoute(action, () => null, () => { throw new DriverFault("BACKGROUND_UNAVAILABLE", "Chromium"); }); Check(false); }
            catch (DriverFault e) { Check(e.Code == "BACKGROUND_UNAVAILABLE" && e.Message.Contains(action) && e.Message.Contains("Chromium")); }
        }
        foreach (string code in new[] { "ACCESS_DENIED", "STALE_ELEMENT", "ACTION_UNCONFIRMED", "ACTION_BUDGET" }) {
            try { DriverUia.BackgroundRoute("click", () => { throw new DriverFault(code); }, () => { throw new Exception(); }); Check(false); }
            catch (DriverFault e) { Check(e.Code == code); }
        }
        foreach (string action in new[] { "click", "doubleClick", "rightClick", "scroll", "drag" }) {
            Check(DriverUia.RequiresPostedSurface(action));
            Check(DriverUia.PostedReason(action, "Chrome", "", false, false).Contains("Chromium"));
            Check(DriverUia.PostedReason(action, "", "Chrome_WidgetWin_1", false, false).Contains("Chromium"));
            Check(DriverUia.PostedReason(action, "", "", true, false).Contains("surface"));
            Check(DriverUia.PostedReason(action, "Win32", "Edit", false, false) == null);
        }
        foreach (string action in new[] { "typeText", "pressKey", "paste", "setValue" }) {
            Check(!DriverUia.RequiresPostedSurface(action));
            foreach (bool offscreen in new[] { false, true }) {
                Check(DriverUia.PostedReason(action, "Chrome", "", offscreen, false) == null);
                Check(DriverUia.PostedReason(action, "", "Chrome_WidgetWin_1", offscreen, false) == null);
                Check(DriverUia.PostedReason(action, "WPF", "HwndWrapper[fixture]", offscreen, true) == null);
            }
        }
        Check(DriverUia.PostedReason("drag", "WPF", "", false, false).Contains("WPF"));
        Check(DriverUia.PostedReason("drag", "", "HwndWrapper[fixture]", false, false).Contains("WPF"));
        Check(DriverUia.PostedReason("drag", "", "", false, true).Contains("OLE"));
        var main = new WindowRecord { Handle = new IntPtr(101) };
        var popup = new WindowRecord { Handle = new IntPtr(102) };
        var root = new DriverNode { Host = main, Depth = 0, Rectangle = new double[] { 0, 0, 100, 100 } };
        var target = new DriverNode { Host = main, Parent = root, Depth = 1, Rectangle = new double[] { 10, 10, 20, 20 } };
        var child = new DriverNode { Host = main, Parent = target, Depth = 2, Rectangle = target.Rectangle };
        var sibling = new DriverNode { Host = main, Parent = root, Depth = 1, Rectangle = target.Rectangle };
        var cover = new DriverNode { Host = popup, Depth = 0, Rectangle = root.Rectangle };
        var events = new List<string>();
        foreach (string action in new[] { "doubleClick", "rightClick", "scroll" }) {
            foreach (object selector in new object[] { 3, Json.Map("label", "target"), Json.Map("id", "target-id") }) {
                var plan = DriverActionPlan.Parse(action, action == "scroll" ? Params(selector, Json.Map("direction", "down", "amount", 1)) : Params(selector));
                Func<DriverNode[], DriverPoint, string> dispatch = (nodes, point) => DriverUia.BackgroundRoute(action, () => null,
                    () => DriverUia.PostedRoute(plan, nodes, main.Handle, target,
                        () => events.Add("live"), () => events.Add("surface"), () => point,
                        p => { events.Add("post"); Check(p.X == point.X && p.Y == point.Y); return "posted"; }));
                foreach (var nodes in new[] { new[] { root, target, cover }, new[] { root, target, child }, new[] { root } }) {
                    events.Clear();
                    try { dispatch(nodes, new DriverPoint(20, 20)); Check(false); }
                    catch (DriverFault e) { Check(e.Code == "BACKGROUND_UNAVAILABLE" && e.Message.Contains(action) && e.Message.Contains("named element")); }
                    Check(String.Join(",", events) == "live,surface");
                }
                foreach (var nodes in new[] { new[] { root, target, sibling }, new[] { root, sibling, target } }) {
                    // Anchor the first sibling in each order. Without the tie guard,
                    // either order would choose its anchor and wrongly reach post.
                    events.Clear();
                    try {
                        DriverUia.PostedRoute(plan, nodes, main.Handle, nodes[1],
                            () => events.Add("live"), () => events.Add("surface"), () => new DriverPoint(20, 20),
                            p => { events.Add("post"); return "posted"; });
                        Check(false);
                    } catch (DriverFault e) { Check(e.Code == "BACKGROUND_UNAVAILABLE" && e.Message.Contains("same depth") && e.Message.Contains("named element")); }
                    Check(String.Join(",", events) == "live,surface");
                }
                // A partly off-window element must refuse when its center falls outside its host root.
                target.Rectangle = new double[] { 90, 10, 30, 20 }; events.Clear();
                try { dispatch(new[] { root, target }, new DriverPoint(105, 20)); Check(false); }
                catch (DriverFault e) { Check(e.Code == "BACKGROUND_UNAVAILABLE" && e.Message.Contains("outside")); }
                Check(String.Join(",", events) == "live,surface");
                // The visible center of a partly clipped element remains eligible.
                target.Rectangle = new double[] { 90, 10, 15, 20 }; events.Clear();
                Check(dispatch(new[] { root, target }, new DriverPoint(98, 20)) == "posted");
                Check(String.Join(",", events) == "live,surface,post");
                target.Rectangle = new double[] { 10, 10, 20, 20 }; events.Clear();
                Check(dispatch(new[] { root, target }, new DriverPoint(20, 20)) == "posted");
                Check(String.Join(",", events) == "live,surface,post");
                target.Offscreen = true; events.Clear();
                try { dispatch(new[] { root, target }, new DriverPoint(20, 20)); Check(false); }
                catch (DriverFault e) { Check(e.Code == "BACKGROUND_UNAVAILABLE"); }
                Check(!events.Contains("post")); target.Offscreen = false;
            }
        }
        // A true sibling overlap refuses independent of enumeration order, including coordinate resolution.
        Check(sibling.Parent == target.Parent && sibling.Depth == target.Depth);
        foreach (var nodes in new[] { new[] { root, target, sibling }, new[] { root, sibling, target } }) {
            try { DriverUia.HitTest(nodes, main.Handle, new DriverPoint(20, 20)); Check(false); }
            catch (DriverFault e) { Check(e.Code == "BACKGROUND_UNAVAILABLE" && e.Message.Contains("same depth") && e.Message.Contains("named element")); }
            try { DriverUia.HitTest(nodes, main.Handle, new DriverPoint(20, 20), true); Check(false); }
            catch (DriverFault e) { Check(e.Code == "BACKGROUND_UNAVAILABLE" && e.Message.Contains("same depth") && e.Message.Contains("coordinate target") && !e.Message.Contains("named element")); }
        }
        sibling.Offscreen = true;
        Check(DriverUia.HitTest(new[] { root, target, sibling }, main.Handle, new DriverPoint(20, 20)) == target);
        sibling.Offscreen = false;
        sibling.Rectangle = new double[] { 70, 70, 10, 10 };
        Check(DriverUia.HitTest(new[] { root, target, sibling }, main.Handle, new DriverPoint(20, 20)) == target);
        foreach (int type in new[] { 50004, 50030, 50020, 50033 }) foreach (object selector in new object[] { 3, Json.Map("label", "field"), Json.Map("id", "field-id") }) {
            target.Type = type; int patterns = 0, posts = 0;
            var plan = DriverActionPlan.Parse("click", Params(selector));
            try {
                DriverUia.BackgroundRoute("click", () => { patterns++; return DriverUia.ClickLadder(id => new object(), (p, name) => { throw new Exception(); }, type); },
                    () => DriverUia.PostedRoute(plan, new[] { root, target }, main.Handle, target, () => { }, () => { }, () => new DriverPoint(20, 20), p => { posts++; return "posted"; }));
                Check(false);
            } catch (DriverFault e) { Check(e.Code == "BACKGROUND_UNAVAILABLE" && e.Message.Contains("Edit, Document, Text and Pane") && e.Message.Contains("coordinate click")); }
            Check(patterns == 1 && posts == 0);
        }
        // Naming an enclosing control still runs that control's own pattern exactly once.
        foreach (var row in new[] { new[] { 50002, 10015 }, new[] { 50007, 10010 }, new[] { 50000, 10000 }, new[] { 50026, 10005 } }) {
            int applied = 0;
            Check(DriverUia.BackgroundRoute("click", () => DriverUia.ClickLadder(id => id == row[1] ? new object() : null,
                (p, name) => applied++, row[0]), () => { throw new Exception(); }) != null);
            Check(applied == 1);
        }
        // Coordinates are explicitly chosen by the caller; the named-target guard must not reinterpret them.
        var coordinates = DriverActionPlan.Parse("click", Params(new object[] { new object[] { 20, 20 } }));
        Check(DriverUia.PostedRoute(coordinates, new[] { root, target, child }, main.Handle, target, () => { }, () => { },
            () => new DriverPoint(20, 20), p => "posted") == "posted");
        var scrollPlan = DriverActionPlan.Parse("scroll", Params(3, Json.Map("direction", "down", "amount", 1)));
        try { DriverUia.PostedRoute(scrollPlan, new[] { root, target }, main.Handle, target, () => { },
            () => { throw new DriverFault("BACKGROUND_UNAVAILABLE", "Chromium"); }, () => new DriverPoint(20, 20), p => { throw new Exception(); }); Check(false); }
        catch (DriverFault e) { Check(e.Code == "BACKGROUND_UNAVAILABLE" && e.Message.Contains("scroll does not search ancestors")); }
        try { DriverUia.PostedRoute(scrollPlan, new[] { root, target }, main.Handle, target, () => { }, () => { },
            () => { throw new DriverFault("INVALID_COORDINATES"); }, p => { throw new Exception(); }); Check(false); }
        catch (DriverFault e) { Check(e.Code == "BACKGROUND_UNAVAILABLE" && e.Message.Contains("scroll does not search ancestors")); }
        foreach (string failure in new[] { "STALE_ELEMENT", "BACKGROUND_UNAVAILABLE" }) {
            events.Clear();
            try { DriverUia.PostedRoute(scrollPlan, new[] { root, target }, main.Handle, target,
                () => { throw new DriverFault(failure); }, () => events.Add("surface"), () => new DriverPoint(20, 20), p => { events.Add("post"); return "posted"; }); Check(false); }
            catch (DriverFault e) { Check(e.Code == failure); }
            Check(events.Count == 0);
        }
        try { DriverUia.BackgroundRoute("click", () => { DriverInput.MarkInput(); return null; }, () => { throw new Exception(); }); Check(false); }
        catch (DriverFault e) { Check(e.Code == "ACTION_UNCONFIRMED"); }
        DriverInput.InputAttempted = false;
    }
    static void ClipboardRefused(Action action)
    {
        try { action(); throw new Exception("Clipboard admission sent input"); }
        catch (DriverFault e) {
            Check(e.Code == "ACTION_UNSUPPORTED");
            Check(e.Disposition != null && (string)e.Disposition["delivery"] == "not-sent" && (string)e.Disposition["retry"] == "safe");
        }
    }
    static DriverInput.ResolvedKey FixtureKey(string chord, short mapped = -1)
    {
        return DriverInput.ResolveKeys(DriverChord.Parse(chord), c => mapped == -1 ?
            (c >= 'a' && c <= 'z' ? (short)Char.ToUpperInvariant(c) : (short)-1) : mapped);
    }
    static void ClipboardChecks()
    {
        foreach (string text in new[] { "\n", "\r", "prefix\ntrailer", "prefix\r\ntrailer" })
            Check(DriverClipboardRule.TextActivates(DriverActionPlan.Parse("typeText", Params(text))));
        Check(!DriverClipboardRule.TextActivates(DriverActionPlan.Parse("typeText", Params("plain"))));
        foreach (string accelerator in new[] { "Ctrl+Ins", "Ctrl+Insert", "Ctrl + Insert", "Shift+Del", "Shift+Delete", "PrtSc", "Prt Scr", "PrtScn", "Print Screen" }) {
            var item = new DriverNode { Name = "Ordinary", Accelerator = accelerator };
            ClipboardRefused(() => DriverUia.RefuseClipboardTarget(item, false, c => DriverInput.ResolveKeys(c, ch => -1)));
        }
        int layouts = 0;
        Func<DriverChord, DriverInput.ResolvedKey> russian = c => { layouts++; return DriverInput.ResolveKeys(c, ch => ch == 'с' ? (short)0x43 : (short)-1); };
        Check(!DriverClipboardRule.TargetRefused(new DriverNode { Accelerator = "Ctrl+S" }, false, russian));
        ClipboardRefused(() => DriverUia.RefuseClipboardTarget(new DriverNode { Accelerator = "Ctrl+C" }, false, russian));
        for (char key = '0'; key <= '9'; key++) {
            var resolved = DriverClipboardRule.ResolveAccelerator(DriverChord.ParseAccelerator("Ctrl+" + key), russian);
            Check(resolved.Key == key && resolved.Modifiers.Contains(17));
        }
        string[] oemKeys = { ";", ":", "=", "+", ",", "<", "-", "_", ".", ">", "/", "?", "`", "~", "[", "{", "\\", "|", "]", "}", "'", "\"" };
        int[] oemValues = { 0xba, 0xba, 0xbb, 0xbb, 0xbc, 0xbc, 0xbd, 0xbd, 0xbe, 0xbe, 0xbf, 0xbf, 0xc0, 0xc0, 0xdb, 0xdb, 0xdc, 0xdc, 0xdd, 0xdd, 0xde, 0xde };
        for (int i = 0; i < oemKeys.Length; i++) {
            var chord = DriverChord.ParseAccelerator("Ctrl+" + oemKeys[i]);
            var resolved = DriverClipboardRule.ResolveAccelerator(chord, russian);
            Check(resolved.Key == oemValues[i] && resolved.Modifiers.Contains(17));
            Check(!DriverClipboardRule.TargetRefused(new DriverNode { Accelerator = "Ctrl+" + oemKeys[i] }, false, russian));
        }
        Check(layouts == 0);
        Check(DriverClipboardRule.AccessMatches("Alt, H, C", DriverChord.Parse("alt+h")));
        Check(DriverClipboardRule.AccessMatches("Alt, H, C", DriverChord.Parse("alt+c")));
        // WCB1 1 to 4 and 20: resolution precedes either route, not chord text.
        foreach (string chord in new[] { "ctrl+c", "ctrl+x", "win+c", "win+x", "ctrl+insert", "shift+delete", "shift+insert",
            "ctrl+v", "printscreen", "alt+printscreen", "ctrl+shift+c", "ctrl+alt+x", "win+shift+s" }) {
            var resolved = FixtureKey(chord);
            ClipboardRefused(() => DriverClipboardRule.RefuseKey(resolved));
        }
        foreach (string chord in new[] { "ctrl+с", "ctrl+j", "ctrl+c" }) {
            var resolved = FixtureKey(chord, 0x43);
            ClipboardRefused(() => DriverClipboardRule.RefuseKey(resolved));
        }
        try { DriverInput.ResolveKeys(DriverChord.Parse("ctrl+c"), c => -1); Check(false); }
        catch (DriverFault e) { Check(e.Code == "KEY_LAYOUT_UNAVAILABLE"); }
        // Layout-supplied Control and Shift bits participate too.
        ClipboardRefused(() => DriverClipboardRule.RefuseKey(FixtureKey("c", 0x243)));
        ClipboardRefused(() => DriverClipboardRule.RefuseKey(FixtureKey("ctrl+c", 0x143)));
        // WCB1 5: Alt and bare menu mnemonics use AccessKey without rendering it.
        foreach (string access in new[] { "c", "Alt+C", "&c" }) {
            Check(DriverClipboardRule.AccessMatches(access, DriverChord.Parse("c")));
            Check(DriverClipboardRule.AccessMatches(access, DriverChord.Parse("alt+c")));
        }
        Check(!DriverClipboardRule.AccessMatches("v", DriverChord.Parse("c")));
        Check(DriverChord.Parse("alt+e").PostedLimits(new[] { 18 }).Length == 0);
        // WCB1 6 to 11: parent shared-label verdicts and native equivalents cover
        // clicks, coordinates, submenus, focused activation and all patterns.
        foreach (string role in new[] { "button", "link", "list item", "text", "menu item" }) {
            var item = new DriverNode { Name = "Copy", Role = role };
            ClipboardRefused(() => DriverUia.RefuseClipboardTarget(item, true, c => FixtureKey(c.Key)));
        }
        var copy = new DriverNode { Name = "Копировать", Accelerator = "Ctrl+C" };
        ClipboardRefused(() => DriverUia.RefuseClipboardTarget(copy, false,
            c => DriverInput.ResolveKeys(c, ch => 0x43)));
        var german = new DriverNode { Name = "Kopieren", Accelerator = "Strg+C" };
        ClipboardRefused(() => DriverUia.RefuseClipboardTarget(german, true, c => FixtureKey(c.Key)));
        Check(!DriverClipboardRule.TargetRefused(german, false, c => FixtureKey(c.Key)));
        var paste = new DriverNode { Name = "Paste", Accelerator = "Ctrl+V" };
        Check(!DriverClipboardRule.TargetRefused(paste, false, c => DriverInput.ResolveKeys(c, ch => 0x56)));
        foreach (string pattern in new[] { "Invoke", "Toggle", "Select", "Expand", "Collapse", "ScrollIntoView", "DoDefaultAction" }) {
            int calls = 0;
            try { DriverUia.RefuseClipboardTarget(copy, false, c => DriverInput.ResolveKeys(c, ch => 0x43)); calls++; Check(false); }
            catch (DriverFault e) { Check(e.Code == "ACTION_UNSUPPORTED" && calls == 0 && pattern.Length > 0); }
        }
        var host = new WindowRecord { Handle = new IntPtr(101) };
        copy.Host = host; copy.Rectangle = new double[] { 0, 0, 30, 30 };
        var hit = DriverUia.HitTest(new[] { copy }, host.Handle, new DriverPoint(10, 10), true);
        ClipboardRefused(() => DriverUia.RefuseClipboardTarget(hit, false, c => DriverInput.ResolveKeys(c, ch => 0x43)));
        try { DriverUia.HitTest(new[] { copy, copy }, host.Handle, new DriverPoint(10, 10), true); Check(false); }
        catch (DriverFault e) { Check(e.Code == "BACKGROUND_UNAVAILABLE"); }
        foreach (string label in new[] { "Copy link", "Copy as path", "Kopieren", "Copy", "Cut" })
            ClipboardRefused(() => DriverUia.RefuseClipboardTarget(new DriverNode { Name = label }, true, c => FixtureKey(c.Key)));
        // WCB1 12/19/20: neither character message variant accepts C0 command text.
        foreach (bool unicode in new[] { false, true }) foreach (string text in new[] { "\u0003", "\u0018" }) {
            int posts = 0;
            try { DriverInput.PumpText(text, unicode, (m, c, clean) => posts++, () => { }, () => { }); Check(false); }
            catch (DriverFault e) { Check(e.Code == "INVALID_PARAMS" && posts == 0); }
        }
        int sent = 0;
        try { DriverClipboard.DirectPaste("a\tb", () => sent++, () => { sent++; return "sent"; }); Check(false); }
        catch (DriverFault e) { Check(e.Code == "BACKGROUND_UNAVAILABLE" && sent == 0); }
        // WCB1 13 to 18/21 to 23: these are counter schedules, not app timings.
        uint count = 10, person = 0; int samples = 0;
        var watch = new DriverClipboardWatch(() => { samples++; return Counter(count); }, () => person);
        uint baseline = watch.Admit(); Check(samples == 1); count++;
        Check(watch.Finish(baseline)); Check(samples == 2); // write during input/settle/read
        Check(!watch.Finish(watch.Admit()));
        count += 2; // late write, manager rewrite, cloud or another session
        try { watch.Admit(); Check(false); }
        catch (DriverFault e) { Check(e.Code == "CLIPBOARD_CHANGED" && (string)e.Disposition["reason"] == "since-last-action"); }
        Check(!watch.Finish(watch.Admit())); // exactly once
        count++; person++; Check(!watch.Finish(watch.Admit())); // person input resets the late baseline
        baseline = watch.Admit(); count++; person++; Check(watch.Finish(baseline)); // no attribution mid-action
        baseline = watch.Admit(); count = 2; Check(watch.Finish(baseline)); // !=, not >
        count = 1;
        try { watch.Admit(); Check(false); }
        catch (DriverFault e) { Check(e.Code == "CLIPBOARD_CHANGED"); }
        Check(new DriverClipboardWatch(() => Counter(count), () => person).Admit() == 1); // restart
        var peer = new DriverClipboardWatch(() => Counter(count), () => person); peer.Finish(peer.Admit());
        count++;
        try { peer.Admit(); Check(false); } catch (DriverFault e) { Check(e.Code == "CLIPBOARD_CHANGED"); }
        // WCB2 21a: every admitted action shares this same zero-baseline watcher.
        foreach (string method in new[] { "click", "pressKey", "typeText", "paste", "performSecondaryAction", "stuckMenuEscape" }) {
            count = 0; watch = new DriverClipboardWatch(() => Counter(count), () => person);
            baseline = watch.Admit(); int actions = 0; actions++;
            Check(baseline == 0 && !watch.Finish(baseline) && actions == 1 && method.Length > 0);
        }
        // 21b: input, settle and result-read jumps all reach Finish.
        foreach (uint jump in new uint[] { 1, 12, 999 }) foreach (string phase in new[] { "input", "settle", "read" }) {
            count = 0; watch = new DriverClipboardWatch(() => Counter(count), () => person);
            baseline = watch.Admit(); count = jump; Check(watch.Finish(baseline) && phase.Length > 0);
        }
        // 21c: stored zero is compared once; person input resets admission.
        foreach (bool moved in new[] { false, true }) {
            count = 0; watch = new DriverClipboardWatch(() => Counter(count), () => person); watch.Finish(watch.Admit());
            count = 12; if (moved) person++;
            if (!moved) LateClipboard(watch);
            Check(!watch.Finish(watch.Admit()));
        }
        // 21d: every nonzero error with zero refuses before input.
        foreach (uint error in new uint[] { 5, 6, 1300, 0xffffffff }) {
            uint denied = error;
            watch = new DriverClipboardWatch(() => Counter(0, denied), () => person);
            CounterUnavailable(() => watch.Admit(), false);
        }
        // 21e: a rejected session never reaches the effect's counter sampler.
        foreach (string reason in new[] { "input-desktop-unavailable", "session-disconnected" }) {
            samples = 0;
            watch = new DriverClipboardWatch(() => { samples++; return Counter(0); }, () => person);
            try {
                DriverUia.Effect(() => { throw DriverSession.Refusal("SCREEN_LOCKED", reason); }, () => watch.Admit());
                Check(false);
            } catch (DriverFault e) { Check(e.Code == "SCREEN_LOCKED" && samples == 0); }
        }
        // 21f: failed Finish and failed Admit retain the last finished value.
        foreach (uint initial in new uint[] { 0, 10 }) {
            uint error = 0; count = initial;
            watch = new DriverClipboardWatch(() => Counter(count, error), () => person);
            watch.Finish(watch.Admit()); baseline = watch.Admit(); count = 0; error = 5;
            CounterUnavailable(() => watch.Finish(baseline), true);
            CounterUnavailable(() => watch.Admit(), false);
            count = 11; error = 0; LateClipboard(watch); Check(!watch.Finish(watch.Admit()));
        }
        // 21g: even error zero cannot make a later zero valid. Restart clears history.
        foreach (bool admitted in new[] { false, true }) {
            count = 10; watch = new DriverClipboardWatch(() => Counter(count), () => person);
            baseline = watch.Admit(); count = 0;
            CounterUnavailable(() => { if (admitted) watch.Finish(baseline); else watch.Admit(); }, admitted);
            Check(new DriverClipboardWatch(() => Counter(0), () => person).Admit() == 0);
        }
        // 21h: nonzero values ignore a stale error.
        watch = new DriverClipboardWatch(() => Counter(12, 6), () => person);
        Check(watch.Admit() == 12 && !watch.Finish(12));
        watch = new DriverClipboardWatch(() => { throw new InvalidOperationException(); }, () => person);
        CounterUnavailable(() => watch.Admit(), false); CounterUnavailable(() => watch.Finish(0), true);

    }
    static DriverClipboardWatch.CounterSample Counter(uint value, uint error = 0)
    {
        return new DriverClipboardWatch.CounterSample { Value = value, Error = error };
    }
    static void LateClipboard(DriverClipboardWatch watch)
    {
        try { watch.Admit(); Check(false); }
        catch (DriverFault e) { Check(e.Code == "CLIPBOARD_CHANGED" && (string)e.Disposition["reason"] == "since-last-action"); }
    }
    static void CounterUnavailable(Action action, bool admitted)
    {
        try { action(); Check(false); }
        catch (DriverFault e) {
            Check(e.Code == "ACTION_UNSUPPORTED" && (string)e.Disposition["reason"] == "clipboard-count-unavailable" &&
                (string)e.Disposition["delivery"] == (admitted ? "unknown" : "not-sent") &&
                (string)e.Disposition["retry"] == (admitted ? "read-first" : "safe"));
        }
    }
    public static int Main()
    {
        try {
            Validation(); Ladder(); Chords(); SettleAndDpi(); Regressions(); Routes(); ClipboardChecks();
            Console.WriteLine(Json.Codec.Serialize(Json.Map("passed", passed, "failed", 0, "drawing", false)));
            return 0;
        } catch (Exception e) { Console.Error.WriteLine(e); return 1; }
    }
}
}
