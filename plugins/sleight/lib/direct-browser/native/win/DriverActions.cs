using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;

namespace Sleight.Driver
{
internal sealed partial class DriverUia
{
    readonly DriverClipboardWatch clipboardWatch = new DriverClipboardWatch();
    uint? clipboardAdmission;
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    static object Pattern(DriverNode node, int id)
    {
        return ReadPattern(() => node.Element.GetCurrentPattern(id));
    }
    internal static object ReadPattern(Func<object> read)
    {
        try { return read(); }
        catch (COMException e) {
            // Only absence is a ladder miss. An attempted action is never retried.
            if (e.ErrorCode == unchecked((int)0x80040204) || e.ErrorCode == unchecked((int)0x80004002)) return null;
            throw;
        }
    }
    internal static string ClickLadder(Func<int, object> get, Action<object, string> act, int type = 0, Func<object, string> defaultAction = null)
    {
        if (type == 50004 || type == 50030 || type == 50020 || type == 50033) return null;
        var ids = new[] { 10000, 10015, 10010, 10005, 10018 };
        var names = new[] { "Invoke", "Toggle", "Select", "Expand/Collapse", "DoDefaultAction" };
        for (int i = 0; i < ids.Length; i++) {
            object pattern = get(ids[i]);
            if (pattern == null) continue;
            try {
                if (ids[i] == 10018 && String.IsNullOrWhiteSpace(defaultAction == null ? ((ILegacy)pattern).CurrentDefaultAction() : defaultAction(pattern))) continue;
                act(pattern, names[i]); return names[i];
            }
            finally { Release(pattern); }
        }
        return null;
    }
    internal static void ExpandCollapse(Func<int> readState, Action checkpoint, Action expand, Action collapse)
    {
        int state = readState();
        checkpoint();
        DriverOperationCounters.Mark(DriverOperationCounters.Kind.PatternCall);
        if (state == 1) collapse(); else expand();
    }
    // Provider lookup/state work precedes this seam. No provider call belongs
    // between the final root/element validation and the requested effect.
    internal static void Effect(Action checkpoint, Action effect)
    {
        checkpoint();
        DriverOperationCounters.Mark(DriverOperationCounters.Kind.PatternCall);
        effect();
    }
    void EffectBoundary(DriverNode node, WindowRecord window)
    {
        EffectBoundary(() => {
            DriverInput.EnsureBudget();
            // State checks can call a provider too. Check identity after them.
            if (Masked(node)) throw new DriverFault("PASSWORD_TARGET");
            Live(node, window);
            DriverIdentity.Verify(window, DriverInventory.Observe(window.Handle));
        }, () => DriverPerson.Require(window), DriverInput.MarkInput);
    }
    internal static void EffectBoundary(Action observe, Action person, Action mark)
    {
        observe();
        person();
        mark();
    }
    void Apply(object pattern, string name, DriverNode node, WindowRecord window)
    {
        Action checkpoint = () => EffectBoundary(node, window);
        if (name == "Expand/Collapse") {
            DriverSession.Require();
            var expand = (IExpand)pattern;
            ExpandCollapse(expand.State, checkpoint, expand.Expand, expand.Collapse);
            return;
        }
        Effect(checkpoint, () => { switch (name) {
        case "Invoke": ((IInvoke)pattern).Invoke(); break;
        case "Toggle": ((IToggle)pattern).Toggle(); break;
        case "Select": ((ISelectionItem)pattern).Select(); break;
        case "Expand": ((IExpand)pattern).Expand(); break;
        case "Collapse": ((IExpand)pattern).Collapse(); break;
        case "ScrollIntoView": ((IScrollItem)pattern).ScrollIntoView(); break;
        case "DoDefaultAction": ((ILegacy)pattern).DoDefaultAction(); break;
        default: throw new DriverFault("INVALID_PARAMS");
        } });
    }
    DriverNode ResolveTarget(object target, WindowRecord window)
    {
        var point = target as object[];
        if (point != null) {
            DriverPoint p = DriverInput.PhysicalPoint(window, point);
            // Hit-test the approved window's read map. Global ElementFromPoint would hit its cover.
            return HitTest(latest.Values, window.Handle, p, true);
        }
        var selector = target as Dictionary<string, object>;
        if (selector != null) {
            string key = selector.Keys.First(), value = (string)selector.Values.First();
            var matches = latest.Values.Where(n => key == "id" ? n.Id == value : key == "label" ? !n.Password && Clean(n.Name) == value : n.Line == value.TrimStart('\t')).ToList();
            if (matches.Count != 1) throw new DriverFault(matches.Count == 0 ? "ELEMENT_NOT_FOUND" : "AMBIGUOUS_ELEMENT");
            return matches[0];
        }
        DriverNode node;
        if (!latest.TryGetValue((int)Json.Integer(target, 0, LineBudget - 1), out node)) throw new DriverFault("ELEMENT_NOT_FOUND");
        return node;
    }
    internal static DriverNode HitTest(IEnumerable<DriverNode> nodes, IntPtr window, DriverPoint point, bool coordinate = false)
    {
        // Owned popups precede the main root, in inventory z-order. Tree depth is
        // meaningful only within the same root, never across overlapping windows.
        var hits = nodes.Where(n => !n.Offscreen && Contains(n.Rectangle, point))
            .OrderBy(n => n.Host.Handle == window ? 1 : 0).ThenBy(n => n.RootOrder).ThenByDescending(n => n.Depth).ToArray();
        if (hits.Length == 0) throw new DriverFault("ELEMENT_NOT_FOUND");
        var node = hits[0];
        // UIA tree order proves no sibling z-order. A tie cannot prove either target form.
        if (hits.Skip(1).Any(n => n.Host.Handle == node.Host.Handle && n.RootOrder == node.RootOrder && n.Depth == node.Depth))
            throw new DriverFault("BACKGROUND_UNAVAILABLE", coordinate
                ? "hit point overlaps elements at the same depth; coordinate target cannot be proved"
                : "hit point overlaps elements at the same depth; named element cannot be proved");
        return node;
    }
    static double[] RectangleOf(object rectangle)
    {
        var r = rectangle as double[];
        if (r == null || r.Length != 4 || r.Any(n => Double.IsNaN(n) || Double.IsInfinity(n) || Math.Abs(n) > 1000000) || r[2] <= 0 || r[3] <= 0)
            throw new DriverFault("INVALID_COORDINATES");
        return r;
    }
    static bool Contains(object rectangle, DriverPoint p)
    {
        try { var r = RectangleOf(rectangle); return p.X >= r[0] && p.Y >= r[1] && p.X < r[0] + r[2] && p.Y < r[1] + r[3]; }
        catch (DriverFault) { return false; }
    }
    static DriverPoint Center(DriverNode node)
    {
        var r = RectangleOf(node.Element.GetCurrentPropertyValueEx(BoundingRectangle, true));
        return new DriverPoint((int)Math.Round(r[0] + r[2] / 2), (int)Math.Round(r[1] + r[3] / 2));
    }
    void Live(DriverNode node, WindowRecord window)
    {
        if (node == null || node.Element == null || node.RuntimeId == null || node.RuntimeId.Length == 0 ||
            !node.RuntimeId.SequenceEqual(node.Element.GetRuntimeId())) throw new DriverFault("STALE_ELEMENT");
        if (!OwnedProcess(node.Element.GetCurrentPropertyValueEx(ProcessId, true), window.Pid)) throw new DriverFault("IDENTITY_CHANGED");
        if (!node.Enabled || !DriverUia.Enabled(node.Element.GetCurrentPropertyValueEx(IsEnabled, true))) throw new DriverFault("ELEMENT_DISABLED");
        var host = DriverInventory.Observe(node.Host.Handle);
        if (host == null) throw new DriverFault("IDENTITY_CHANGED");
        host.RequireReadable();
        if (!node.Host.SameIdentity(host) || host.Pid != window.Pid || host.ProcessStart != window.ProcessStart ||
            host.Handle != window.Handle && !DriverInventory.PopupFor(host, window)) throw new DriverFault("IDENTITY_CHANGED");
        // Prove the live element still descends from its observed HWND, including windowless providers.
        IUIAutomationElement current = node.Element; bool owned = false;
        try {
            for (int depth = 0; current != null && depth <= DepthBudget + 1; depth++) {
                if (!OwnedProcess(current.GetCurrentPropertyValueEx(ProcessId, true), window.Pid)) throw new DriverFault("IDENTITY_CHANGED");
                object value = current.GetCurrentPropertyValueEx(NativeWindowHandle, true);
                if (value is int && (int)value != 0) {
                    DriverInput.Check(host, new IntPtr((long)(uint)(int)value)); return;
                }
                var parent = walker.GetParentElement(current);
                if (owned) Release(current);
                current = parent; owned = true;
            }
            throw new DriverFault("STALE_ELEMENT");
        } finally { if (owned) Release(current); }
    }
    IntPtr TargetHandle(DriverNode node)
    {
        for (var n = node; n != null; n = n.Parent) {
            object value = n.Element.GetCurrentPropertyValueEx(NativeWindowHandle, true);
            if (value is int && (int)value != 0) {
                IntPtr hwnd = new IntPtr((long)(uint)(int)value); DriverInput.Check(node.Host, hwnd); return hwnd;
            }
        }
        throw new DriverFault("BACKGROUND_UNAVAILABLE");
    }
    static bool Masked(DriverNode node)
    {
        return node.Password || Password((property, ignore) => node.Element.GetCurrentPropertyValueEx(property, ignore), node.Type);
    }
    internal static string PostedRoute(DriverActionPlan plan, IEnumerable<DriverNode> nodes, IntPtr window, DriverNode anchor,
        Action live, Action surface, Func<DriverPoint> locate, Func<DriverPoint, string> post)
    {
        try {
            live();
            // A named label must not become a coordinate click on its enclosing control.
            if (plan.Method == "click" && !(plan.Target is object[]))
                throw new DriverFault("BACKGROUND_UNAVAILABLE", "named element has no supported click pattern; Edit, Document, Text and Pane have no named click route. Use an explicit coordinate click from a fresh screenshot where posted input is supported");
            surface();
            var point = new DriverPoint();
            if (plan.Method == "click" || plan.Method == "doubleClick" || plan.Method == "rightClick" || plan.Method == "scroll") {
                point = locate();
                if (!(plan.Target is object[])) {
                    if (!nodes.Any(n => n.Host.Handle == anchor.Host.Handle && n.Depth == 0 && !n.Offscreen && Contains(n.Rectangle, point)))
                        throw new DriverFault("BACKGROUND_UNAVAILABLE", "named element center is outside its window surface");
                    DriverNode hit;
                    try { hit = HitTest(nodes, window, point); }
                    catch (DriverFault e) {
                        if (e.Code != "ELEMENT_NOT_FOUND") throw;
                        throw new DriverFault("BACKGROUND_UNAVAILABLE", "named element center has no hit in the window read map");
                    }
                    if (hit != anchor || hit.Host.Handle != anchor.Host.Handle)
                        throw new DriverFault("BACKGROUND_UNAVAILABLE", "named element center hits a covering element or another HWND");
                }
            }
            return post(point);
        } catch (DriverFault e) {
            string code = e.Code, message = e.Message;
            if (code == "INVALID_COORDINATES" && !(plan.Target is object[])) {
                code = "BACKGROUND_UNAVAILABLE"; message = "named element has no valid center in the window";
            }
            if (plan.Method == "scroll" && code == "BACKGROUND_UNAVAILABLE")
                throw new DriverFault(code, message + "; scroll does not search ancestors. Target the scrollable control itself");
            if (code != e.Code) throw new DriverFault(code, message);
            throw;
        }
    }
    internal static bool RequiresPostedSurface(string action)
    {
        return action == "click" || action == "doubleClick" || action == "rightClick" || action == "scroll" || action == "drag";
    }
    internal static string PostedReason(string action, string framework, string cls, bool offscreen, bool ole)
    {
        if (!RequiresPostedSurface(action)) return null;
        if (offscreen) return "target has no visible background surface";
        if (String.Equals(framework, "Chrome", StringComparison.OrdinalIgnoreCase) || (cls ?? "").StartsWith("Chrome_WidgetWin", StringComparison.Ordinal))
            return "Chromium does not support this posted input route";
        if (action == "drag") {
            if (String.Equals(framework, "WPF", StringComparison.OrdinalIgnoreCase) || (cls ?? "").StartsWith("HwndWrapper[", StringComparison.Ordinal))
                return "WPF drag requires foreground input";
            if (ole) return "OLE drag requires foreground input";
        }
        return null;
    }
    static void RequirePosted(DriverNode node, string action)
    {
        // Text/key messages target a proved HWND, so they need no painted surface.
        if (!RequiresPostedSurface(action)) return;
        object offscreen = node.Element.GetCurrentPropertyValueEx(IsOffscreen, true);
        bool ole = new[] { "explorer", "winword", "excel", "powerpnt", "outlook", "onenote" }.Contains((node.Host.App ?? "").ToLowerInvariant());
        string reason = PostedReason(action, node.Element.GetCurrentPropertyValueEx(30024, true) as string, node.Host.ClassName,
            node.Offscreen || !(offscreen is bool) || (bool)offscreen, ole);
        if (reason != null) throw new DriverFault("BACKGROUND_UNAVAILABLE", reason);
    }
    // A miss is distinct from a failed attempted action. Never replay an uncertain effect.
    internal static string BackgroundRoute(string action, Func<string> pattern, Func<string> posted)
    {
        try {
            foreach (var attempt in new[] { pattern, posted }) {
                string route = attempt();
                if (route != null) return route;
                if (DriverInput.InputAttempted) throw new DriverFault("ACTION_UNCONFIRMED", action + ": input may have landed; read again before repeating.");
            }
        } catch (DriverFault e) {
            if (DriverInput.InputAttempted || !new[] { "BACKGROUND_UNAVAILABLE", "NO_BACKGROUND_FOCUS", "CHORD_NEEDS_FOREGROUND", "KEY_LAYOUT_UNAVAILABLE", "BACKGROUND_INPUT_FAILED" }.Contains(e.Code)) throw;
            throw new DriverFault("BACKGROUND_UNAVAILABLE", action + ": " + e.Message);
        }
        throw new DriverFault("BACKGROUND_UNAVAILABLE", action + ": no matching UIA pattern or supported HWND message route");
    }
    string ActionPattern(DriverActionPlan plan, DriverNode node, WindowRecord window)
    {
        Live(node, window);
        RefuseClipboardTarget(node, plan);
        if (Masked(node)) throw new DriverFault("PASSWORD_TARGET");
        switch (plan.Method) {
        case "click": return ClickLadder(id => Pattern(node, id), (pattern, name) => Apply(pattern, name, node, window), node.Type);
        case "pressKey":
            if (!AcceleratorMatches(node.Accelerator, plan.Chord)) return null;
            return ClickLadder(id => Pattern(node, id), (pattern, name) => Apply(pattern, name, node, window), node.Type);
        case "setValue": case "typeText":
            // Value replaces a whole value. It is equivalent to typing only in an empty focused field.
            if (plan.Method == "typeText" && (!node.Focused || plan.Text.Any(c => c < 32))) return null;
            object value = Pattern(node, 10002);
            if (value == null) return null;
            try {
                var p = (IValue)value;
                if (p.ReadOnly()) throw new DriverFault("ELEMENT_READ_ONLY");
                if (plan.Method == "typeText" && p.CurrentValue() != "") return null;
                if (plan.Method == "typeText") {
                    object focus = node.Element.GetCurrentPropertyValueEx(HasKeyboardFocus, true);
                    if (!(focus is bool) || !(bool)focus) throw new DriverFault("NO_BACKGROUND_FOCUS", "focused UIA element changed");
                }
                Effect(() => EffectBoundary(node, window), () => p.SetValue(plan.Text));
                if (plan.Method == "typeText") DriverInput.RecordTyped(plan.Text.Length);
                return "Value";
            } finally { Release(value); }
        case "scroll":
            object scroll = Pattern(node, 10004);
            if (scroll == null) return null;
            try {
                int amount = plan.Direction == "up" || plan.Direction == "left" ? 1 : 4;
                for (int i = 0; i < plan.Amount; i++) {
                    Effect(() => EffectBoundary(node, window), () => ((IScroll)scroll).Scroll(
                        plan.Direction == "left" || plan.Direction == "right" ? amount : 2,
                        plan.Direction == "up" || plan.Direction == "down" ? amount : 2));
                }
                return "Scroll";
            } finally { Release(scroll); }
        }
        // UIA has no generic action pattern for a double/right click or a drag.
        return null;
    }
    internal static DriverNode FocusedTarget(IEnumerable<DriverNode> nodes, Func<DriverNode, bool> accepts)
    {
        DriverNode selected = null;
        foreach (var candidate in nodes) {
            if (!candidate.Focused || !accepts(candidate)) continue;
            if (selected != null) throw new DriverFault("NO_BACKGROUND_FOCUS");
            selected = candidate;
        }
        if (selected == null) throw new DriverFault("NO_BACKGROUND_FOCUS");
        return selected;
    }
    internal static bool NativeFocusMatches(IntPtr focus, IntPtr expected, Func<IntPtr, IntPtr, bool> child)
    {
        return focus != IntPtr.Zero && expected != IntPtr.Zero && (focus == expected || child(expected, focus));
    }
    IntPtr FocusHandle(DriverNode node)
    {
        IntPtr focus = DriverInput.Focus(node.Host), expected = TargetHandle(node);
        if (!NativeFocusMatches(focus, expected, DriverInput.IsChild))
            throw new DriverFault("NO_BACKGROUND_FOCUS");
        IUIAutomationElement element = automation.ElementFromHandleBuildCache(focus, cache);
        if (element == null) throw new DriverFault("NO_BACKGROUND_FOCUS");
        try {
            object type = element.GetCurrentPropertyValueEx(ControlType, true);
            if (!(type is int) || Password((property, ignore) => element.GetCurrentPropertyValueEx(property, ignore), (int)type))
                throw new DriverFault("PASSWORD_TARGET");
            // A windowless WPF editor shares its container's HWND. Its own UIA
            // focus is authoritative; the container need not claim UIA focus.
            if (!(node.Element.GetCurrentPropertyValueEx(HasKeyboardFocus, true) is bool) ||
                !(bool)node.Element.GetCurrentPropertyValueEx(HasKeyboardFocus, true)) throw new DriverFault("NO_BACKGROUND_FOCUS");
        } finally { Release(element); }
        DriverInput.Check(node.Host, focus);
        if (DriverInput.Focus(node.Host) != focus) throw new DriverFault("NO_BACKGROUND_FOCUS");
        return focus;
    }
    internal static string ProviderCode(int hresult)
    {
        switch (unchecked((uint)hresult)) {
        case 0x80040201: return "STALE_ELEMENT";
        case 0x80040200: return "ELEMENT_DISABLED";
        case 0x80131505: return "PROVIDER_TIMEOUT";
        case 0x80070005: return "ACCESS_DENIED";
        case 0x80131509: return "ACTION_REFUSED";
        default: return "UIA_UNAVAILABLE";
        }
    }
    internal static DriverFault ActionFailure(string code, string detail, bool sent, bool text, int typed)
    {
        string message = detail;
        if (text && message.IndexOf("typed=", StringComparison.Ordinal) < 0) message += " typed=" + typed + " UTF-16 units.";
        if (sent && message.IndexOf("input may have landed", StringComparison.OrdinalIgnoreCase) < 0) message += " input may have landed; read again before repeating.";
        return new DriverFault(code, message) { Disposition = Json.Map("delivery", sent ? "sent-unverified" : "not-sent",
            "retry", sent ? "read-first" : "safe", "typed", typed) };
    }
    internal object Action(DriverActionPlan plan, long deadline)
    {
        using (DriverInput.WithDeadline(deadline)) {
            clipboardAdmission = null;
            try { return RunAction(plan, deadline); }
            catch (Exception error) {
                InvalidateRead();
                var typedFault = error as DriverFault;
                // A desktop/person refusal forbids the clipboard watcher from
                // masking it with a later diagnostic or returning success.
                if (typedFault != null && DriverSession.IsSafety(typedFault)) throw;
                // Late-change and zero-count refusals retain typed fields across
                // the frozen Windows transport as results for its parent adapter.
                if (clipboardAdmission.HasValue) {
                    try {
                        if (clipboardWatch.Finish(clipboardAdmission.Value)) return ClipboardChangeResult();
                    } catch (DriverFault unavailable) { return unavailable.Disposition; }
                }
                if (typedFault != null && typedFault.Disposition != null) return typedFault.Disposition;
                string code = typedFault != null ? typedFault.Code : error is COMException ? ProviderCode(((COMException)error).ErrorCode) :
                    error is InvalidOperationException ? "ACTION_REFUSED" : DriverInput.InputAttempted ? "ACTION_UNCONFIRMED" : "UIA_UNAVAILABLE";
                string detail = typedFault != null ? typedFault.Message : error is COMException || error is InvalidOperationException ? code : "Windows automation failed.";
                if (new[] { "BACKGROUND_UNAVAILABLE", "NO_BACKGROUND_FOCUS", "CHORD_NEEDS_FOREGROUND" }.Contains(code)) {
                    detail = detail.StartsWith(plan.Method + ":", StringComparison.Ordinal) ? detail : plan.Method + ": " + detail;
                    code = DriverInput.InputAttempted ? "ACTION_UNCONFIRMED" : "BACKGROUND_UNAVAILABLE";
                }
                throw ActionFailure(code, detail, DriverInput.InputAttempted, plan.Method == "typeText" || plan.Method == "paste", DriverInput.Typed);
            }
        }
    }
    Dictionary<string, object> ClipboardChangeResult()
    {
        return Json.Map("clipboardChanged", true, "delivery", DriverInput.InputAttempted ? "sent-unverified" : "not-sent",
            "retry", DriverInput.InputAttempted ? "read-first" : "safe");
    }
    internal static void RefuseClipboardTarget(DriverNode node, bool labelBlocked, Func<DriverChord, DriverInput.ResolvedKey> resolve)
    {
        if (DriverClipboardRule.TargetRefused(node, labelBlocked, resolve)) throw DriverClipboardRule.Refusal();
    }
    void RefuseClipboardTarget(DriverNode node, DriverActionPlan plan)
    {
        if (node == null) return;
        if (Masked(node)) throw new DriverFault("PASSWORD_TARGET");
        if (DriverClipboardRule.UseSharedLabelPolicy && plan.ClipboardBlocked == null) throw DriverClipboardRule.Refusal("clipboard-labels-unavailable");
        if (node.Element != null) {
            // UIA providers can rename or rebind a retained element. A changed
            // name invalidates the parent's shared-label verdict before input.
            string currentName = node.Element.GetCurrentPropertyValueEx(Name, true) as string;
            if (!node.Password && Clean(currentName) != Clean(node.Name)) throw new DriverFault("STALE_ELEMENT");
            node.Accelerator = node.Element.GetCurrentPropertyValueEx(AcceleratorKey, true) as string;
        }
        bool blocked = plan.ClipboardBlocked != null && plan.ClipboardBlocked.Any(id => latest.ContainsKey(id) && latest[id] == node);
        RefuseClipboardTarget(node, blocked, chord => DriverInput.ResolveKeys(node.Host, TargetHandle(node), chord));
    }
    object RunAction(DriverActionPlan plan, long deadline)
    {
        IntPtr foregroundBefore = GetForegroundWindow();
        if (latestWindow == null || plan.ReadId != readId || plan.WindowId != WindowRecord.Id(latestWindow.Handle) || plan.ProcessStart != latestWindow.ProcessStart)
            throw new DriverFault("STALE_READ");
        var window = DriverInventory.Observe(latestWindow.Handle);
        if (window == null) throw new DriverFault("IDENTITY_CHANGED");
        window.RequireReadable();
        if (!latestWindow.SameIdentity(window)) throw new DriverFault("IDENTITY_CHANGED");
        if (Driver.Now() + 2900 + (plan.Method == "drag" ? plan.Duration + 500 : 0) >= deadline) throw DriverSession.BudgetFault();
        if (DriverClipboardRule.UseSharedLabelPolicy && plan.ClipboardBlocked == null) throw DriverClipboardRule.Refusal("clipboard-labels-unavailable");
        DriverNode node = null, destination = null;
        if (plan.Target != null) {
            node = ResolveTarget(plan.Target, window); Live(node, window);
            if (plan.Target is object[] && !Contains(node.Element.GetCurrentPropertyValueEx(BoundingRectangle, true), DriverInput.PhysicalPoint(window, (object[])plan.Target)))
                throw new DriverFault("STALE_ELEMENT");
        }
        if (plan.Destination != null) {
            destination = ResolveTarget(plan.Destination, window); Live(destination, window);
            if (plan.Destination is object[] && !Contains(destination.Element.GetCurrentPropertyValueEx(BoundingRectangle, true), DriverInput.PhysicalPoint(window, (object[])plan.Destination)))
                throw new DriverFault("STALE_ELEMENT");
        }
        if (plan.Method == "typeText" || plan.Method == "paste" || plan.Method == "pressKey") {
            // WinUI can report focus on several sibling input bridges. Keep
            // only the node whose proved native focus route actually matches.
            node = FocusedTarget(latest.Values, candidate => {
                try { FocusHandle(candidate); return true; }
                catch (DriverFault error) { if (error.Code == "NO_BACKGROUND_FOCUS") return false; throw; }
            });
            Live(node, window);
            if (!(node.Element.GetCurrentPropertyValueEx(HasKeyboardFocus, true) is bool) ||
                !(bool)node.Element.GetCurrentPropertyValueEx(HasKeyboardFocus, true)) throw new DriverFault("NO_BACKGROUND_FOCUS");
        }
        if (node == null) throw new DriverFault("ELEMENT_NOT_FOUND");
        // Sign-in policy and a secure credential channel belong to WDR5. No plaintext password writes here.
        if (Masked(node) || destination != null && Masked(destination)) throw new DriverFault("PASSWORD_TARGET");
        if (plan.Method == "pressKey") {
            plan.ResolvedKey = DriverInput.ResolveKeys(node.Host, FocusHandle(node), plan.Chord);
            DriverClipboardRule.RefuseKey(plan.ResolvedKey);
        }
        // PumpText posts Return for either line break. Check before the first character.
        if (DriverClipboardRule.TextActivates(plan) || plan.Method != "typeText" && plan.Method != "paste" &&
            (plan.Method != "pressKey" || plan.ResolvedKey.Key == 13 || plan.ResolvedKey.Key == 32)) RefuseClipboardTarget(node, plan);
        RefuseClipboardTarget(destination, plan);
        if (plan.Method == "pressKey" && !plan.StuckEscape && plan.Chord.Key == null && plan.Chord.Modifiers.Contains(18))
            throw DriverClipboardRule.Refusal("key-tip-target-unresolved");
        DriverNode acceleratorTarget = null;
        if (plan.Method == "pressKey" && !plan.StuckEscape) {
            var matches = latest.Values.Where(n => AcceleratorMatches(n.Accelerator, plan.Chord)).ToList();
            if (matches.Count == 1) { acceleratorTarget = matches[0]; RefuseClipboardTarget(acceleratorTarget, plan); }
            bool menuOpen = latest.Values.Any(n => n.Role == "menu" || n.Host.ClassName == "#32768");
            if ((menuOpen || plan.Chord.Modifiers.Contains(18)) && plan.Chord.Key != null && plan.Chord.Key.Length == 1 && plan.Chord.Modifiers.All(m => m == 16 || m == 18)) {
                if (!DriverClipboardRule.AllowMenuMnemonics) throw DriverClipboardRule.Refusal();
                var accessTargets = latest.Values.Where(n => DriverClipboardRule.AccessMatches(n.Access, plan.Chord)).ToList();
                if (plan.Chord.Modifiers.Contains(18) && accessTargets.Count == 0)
                    throw DriverClipboardRule.Refusal("key-tip-target-unresolved");
                foreach (var item in accessTargets) {
                    Live(item, window);
                    string access = item.Element.GetCurrentPropertyValueEx(AccessKey, true) as string;
                    if (access != item.Access) throw new DriverFault("STALE_ELEMENT");
                    RefuseClipboardTarget(item, plan);
                }
            }
        }
        string before = node.Value, route = null;
        string[] limits = new string[0];
        object timing;
        using (var settle = new DriverSettle(automation, latest.Values.Where(n => n.Depth == 0).Select(n => n.Element).ToArray(), window.Pid)) {
            ++readId; // Invalidate the caller's map even if an action fails after a partial effect.
            DriverInput.EnsureBudget();
            clipboardAdmission = clipboardWatch.Admit();
            DriverPerson.Require(window);
            settle.Begin();
            if (plan.Method == "performSecondaryAction") {
                var names = new[] { "Invoke", "Toggle", "Select", "Expand", "Collapse", "ScrollIntoView", "DoDefaultAction" };
                var ids = new[] { 10000, 10015, 10010, 10005, 10005, 10017, 10018 };
                object secondary = Pattern(node, ids[Array.IndexOf(names, plan.Secondary)]);
                if (secondary == null) throw new DriverFault("BACKGROUND_UNAVAILABLE", plan.Method + ": requested UIA pattern is absent");
                try { Apply(secondary, plan.Secondary, node, window); } finally { Release(secondary); }
                route = plan.Secondary;
            } else if (plan.Method == "selectText") {
                object text = Pattern(node, 10014);
                if (text == null) throw new DriverFault("BACKGROUND_UNAVAILABLE", plan.Method + ": Text pattern is absent");
                ITextRange document = null, found = null;
                try {
                    document = ((IText)text).DocumentRange(); found = document.FindText(plan.Text, false, false);
                    if (found == null) throw new DriverFault("TEXT_NOT_FOUND");
                    Effect(() => EffectBoundary(node, window), found.Select); route = "Text";
                } finally { Release(found); Release(document); Release(text); }
            } else {
                route = BackgroundRoute(plan.Method, () => {
                    if (plan.Method == "pressKey" && !plan.StuckEscape) {
                        return acceleratorTarget != null ? ActionPattern(plan, acceleratorTarget, window) : null;
                    }
                    return ActionPattern(plan, node, window);
                }, () => PostedRoute(plan, latest.Values, window.Handle, node,
                    () => Live(node, window), () => RequirePosted(node, plan.Method),
                    () => plan.Target is object[] ? DriverInput.PhysicalPoint(window, (object[])plan.Target) : Center(node), point => {
                    switch (plan.Method) {
                    case "click": case "doubleClick": case "rightClick":
                        DriverInput.Click(node.Host, TargetHandle(node), point, plan.Method);
                        return "posted-mouse";
                    case "setValue":
                        object handle = node.Element.GetCurrentPropertyValueEx(NativeWindowHandle, true);
                        if ((node.Type != 50004 && node.Type != 50030) || !(handle is int) || (int)handle == 0)
                            throw new DriverFault("BACKGROUND_UNAVAILABLE", "Value pattern absent and target has no native edit HWND");
                        DriverInput.SetValue(node.Host, TargetHandle(node), plan.Text); return "WM_SETTEXT";
                    case "pressKey":
                        limits = DriverInput.Keys(node.Host, FocusHandle(node), plan.Chord, plan.StuckEscape, plan.ResolvedKey);
                        return plan.StuckEscape ? "posted-stuck-escape" : "posted-key";
                    case "typeText": return DriverInput.Type(node.Host, FocusHandle(node), plan.Text);
                    case "paste": return DriverClipboard.Paste(node.Host, FocusHandle(node), plan.Text);
                    case "scroll":
                        int delta = (plan.Direction == "down" || plan.Direction == "left" ? -120 : 120) * plan.Amount;
                        DriverInput.Post(node.Host, TargetHandle(node), plan.Direction == "left" || plan.Direction == "right" ? 0x20eu : 0x20au,
                            unchecked((uint)(ushort)(short)delta << 16), DriverInput.Pack(DriverInput.LogicalScreen(TargetHandle(node), point)));
                        return "posted-wheel";
                    case "drag":
                        Live(destination, window); RequirePosted(destination, plan.Method);
                        IntPtr fromHandle = TargetHandle(node), toHandle = TargetHandle(destination);
                        if (fromHandle != toHandle || node.Host.Handle != destination.Host.Handle)
                            throw new DriverFault("BACKGROUND_UNAVAILABLE", "drag crosses HWND boundaries");
                        DriverInput.Drag(node.Host, fromHandle, plan.Target is object[] ? DriverInput.PhysicalPoint(window, (object[])plan.Target) : Center(node),
                            plan.Destination is object[] ? DriverInput.PhysicalPoint(window, (object[])plan.Destination) : Center(destination), plan.Steps, plan.Duration);
                        limits = new[] { "ole-drag-not-supported" }; return "posted-drag";
                    }
                    return null;
                }));
            }
            try { timing = settle.Wait(deadline, () => Snapshot(window, deadline)); }
            catch (COMException e) { throw new DriverFault("ACTION_UNCONFIRMED", ProviderCode(e.ErrorCode)); }
            catch (DriverFault e) { if (DriverSession.IsSafety(e)) throw; throw new DriverFault("ACTION_UNCONFIRMED", e.Code == "ACTION_BUDGET" ? e.Message : e.Code); }
        }
        Dictionary<string, object> result;
        try { DriverSession.Require(); DriverOperationCounters.Mark(DriverOperationCounters.Kind.FinalRead); result = Json.Object(Read(window, DriverInventory.Windows(), deadline)); }
        catch (COMException e) { throw new DriverFault("ACTION_UNCONFIRMED", ProviderCode(e.ErrorCode)); }
        catch (DriverFault e) { if (DriverSession.IsSafety(e)) throw; throw new DriverFault("ACTION_UNCONFIRMED", e.Code == "ACTION_BUDGET" ? e.Message : e.Code); }
        uint baseline = clipboardAdmission.Value;
        clipboardAdmission = null;
        bool clipboardChanged = clipboardWatch.Finish(baseline);
        result.Add("clipboardChanged", clipboardChanged);
        result.Add("delivery", DriverInput.InputAttempted ? "sent-unverified" : "not-sent");
        result.Add("retry", DriverInput.InputAttempted ? "read-first" : "safe");
        result.Add("action", plan.Method); result.Add("route", route); result.Add("settle", timing);
        if (plan.Method == "scroll") limits = new[] { "scroll does not search ancestors; target the scrollable control itself" };
        IntPtr foregroundAfter = GetForegroundWindow();
        var settleResult = Json.Object(timing);
        if (settleResult.ContainsKey("limits")) limits = limits.Concat((string[])settleResult["limits"]).Distinct().ToArray();
        result.Add("limits", limits);
        result.Add("foregroundChanged", foregroundBefore != foregroundAfter);
        result.Add("foregroundExecutable", DriverInventory.ExecutableName(foregroundAfter));
        if (plan.Method == "typeText" || plan.Method == "paste") result.Add("typed", DriverInput.Typed);
        // A tree change is evidence for the model to inspect, never proof of input delivery.
        result.Add("confirmation", "unconfirmed");
        if (plan.Method == "typeText") result.Add("valueChanged", before != null && latest.Values.Any(n => !n.Password && n.Value != null &&
            n.Host.Handle == node.Host.Handle && n.RuntimeId != null && n.RuntimeId.SequenceEqual(node.RuntimeId) && n.Value != before));
        return result;
    }
    static bool AcceleratorMatches(string text, DriverChord chord)
    {
        if (String.IsNullOrEmpty(text)) return false;
        try { return DriverChord.ParseAccelerator(text).Canonical == chord.Canonical; } catch (DriverFault) { return false; }
    }
    string Snapshot(WindowRecord window, long deadline)
    {
        var session = new DriverSession.ReadProbe();
        var nodes = new List<DriverNode>(); int calls = 0;
        try {
            bool partial = Fetch(window, nodes, () => { session.Require(); return nodes.Count < LineBudget && calls++ < FetchCallBudget && Driver.Now() < deadline - 2750; });
            if (partial) { session.Finish(); return null; }
            bool truncated; string value = Serialize(window.Title, window.App, nodes, new Dictionary<int, DriverNode>(), out truncated);
            session.Finish();
            return truncated ? null : value;
        } finally { foreach (var node in nodes) Release(node.Element); }
    }
}
}
