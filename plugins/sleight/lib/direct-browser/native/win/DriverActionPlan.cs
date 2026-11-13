using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace Sleight.Driver
{
// Parse the whole request before consulting UIA or posting a single message.
internal sealed class DriverActionPlan
{
    internal static readonly string[] Methods = { "click", "doubleClick", "rightClick", "setValue", "typeText", "pressKey",
        "paste", "scroll", "selectText", "performSecondaryAction", "drag" };
    internal string Method, WindowId, ProcessStart, Text, Secondary, Direction;
    internal object Target, Destination;
    internal long ReadId;
    internal int Amount = 3, Steps = 16, Duration = 500;
    internal DriverChord Chord;
    internal bool StuckEscape;
    internal int[] ClipboardBlocked;
    internal DriverInput.ResolvedKey ResolvedKey;
    internal static double Number(object value, double min, double max)
    {
        if (!(value is int || value is long || value is double || value is decimal)) throw new DriverFault("INVALID_PARAMS");
        double n = Convert.ToDouble(value, CultureInfo.InvariantCulture);
        if (Double.IsNaN(n) || Double.IsInfinity(n) || n < min || n > max) throw new DriverFault("INVALID_PARAMS");
        return n;
    }
    internal static string String(object value, int max, bool empty)
    {
        string s = Json.Text(value);
        if ((!empty && System.String.IsNullOrWhiteSpace(s)) || s.Length > max || s.IndexOf('\0') >= 0) throw new DriverFault("INVALID_PARAMS");
        // Reject broken UTF-16, including lone surrogates in forged IPC.
        for (int i = 0; i < s.Length; i++) {
            if (Char.IsHighSurrogate(s[i])) { if (++i >= s.Length || !Char.IsLowSurrogate(s[i])) throw new DriverFault("INVALID_PARAMS"); }
            else if (Char.IsLowSurrogate(s[i])) throw new DriverFault("INVALID_PARAMS");
        }
        return s;
    }
    internal static object TargetValue(object value)
    {
        if (value is int || value is long || value is double || value is decimal) {
            Json.Integer(value, 0, DriverUia.LineBudget - 1); return value;
        }
        var point = value as object[];
        if (point != null) {
            if (point.Length != 2) throw new DriverFault("INVALID_PARAMS");
            Number(point[0], 0, 1000000); Number(point[1], 0, 1000000); return value;
        }
        var target = Json.Object(value);
        if (target.Count != 1 || !target.Keys.Any(k => k == "id" || k == "label" || k == "line")) throw new DriverFault("INVALID_PARAMS");
        String(target.Values.First(), 16384, false); return value;
    }
    internal static DriverActionPlan Parse(string method, Dictionary<string, object> p)
    {
        if (!Methods.Contains(method)) throw new DriverFault("METHOD_NOT_FOUND");
        Json.Keys(p, "windowId processStart readId args", "clipboardBlocked");
        var plan = new DriverActionPlan { Method = method, WindowId = Json.Text(p["windowId"]),
            ProcessStart = String(p["processStart"], 20, false), ReadId = Json.Integer(p["readId"], 1, 9007199254740991) };
        if (p.ContainsKey("clipboardBlocked")) {
            var blocked = p["clipboardBlocked"] as object[];
            if (blocked == null || blocked.Length > DriverUia.LineBudget) throw new DriverFault("INVALID_PARAMS");
            plan.ClipboardBlocked = blocked.Select(n => (int)Json.Integer(n, 0, DriverUia.LineBudget - 1)).ToArray();
        }
        DriverInventory.Hwnd(plan.WindowId);
        ulong birth;
        if (!System.Text.RegularExpressions.Regex.IsMatch(plan.ProcessStart, "\\A[1-9][0-9]{0,19}\\z") ||
            !UInt64.TryParse(plan.ProcessStart, NumberStyles.None, CultureInfo.InvariantCulture, out birth) || birth == 0 || birth > Int64.MaxValue)
            throw new DriverFault("INVALID_PARAMS");
        var a = p["args"] as object[];
        if (a == null) throw new DriverFault("INVALID_PARAMS");
        int count = method == "setValue" || method == "performSecondaryAction" || method == "selectText" || method == "scroll" || method == "drag" ? 2 : 1;
        bool options = method == "paste" || method == "drag";
        if (a.Length < count || a.Length > count + (options ? 1 : 0)) throw new DriverFault("INVALID_PARAMS");
        if (method == "typeText" || method == "paste" || method == "pressKey") {
            // Both text routes post per UTF-16 unit and share the same bounded workload.
            plan.Text = String(a[0], method == "pressKey" ? 128 : 4000, method != "pressKey");
            if (method == "typeText" && plan.Text.Any(c => c < 32 && c != '\t' && c != '\r' && c != '\n'))
                throw new DriverFault("INVALID_PARAMS");
            if (method == "pressKey") plan.Chord = DriverChord.Parse(plan.Text);
        } else plan.Target = TargetValue(a[0]);
        if (method == "setValue" || method == "selectText") plan.Text = String(a[1], 65536, method == "setValue");
        if (method == "performSecondaryAction") {
            plan.Secondary = String(a[1], 32, false);
            if (!new[] { "Invoke", "Toggle", "Select", "Expand", "Collapse", "ScrollIntoView", "DoDefaultAction" }.Contains(plan.Secondary))
                throw new DriverFault("INVALID_PARAMS");
        }
        if (method == "scroll") {
            var o = Json.Object(a[1]); Json.Keys(o, "direction", "amount");
            plan.Direction = Json.Text(o["direction"]);
            if (!new[] { "up", "down", "left", "right" }.Contains(plan.Direction)) throw new DriverFault("INVALID_PARAMS");
            if (o.ContainsKey("amount")) plan.Amount = (int)Json.Integer(o["amount"], 1, 100);
        }
        if (method == "drag") {
            plan.Destination = TargetValue(a[1]);
            if (a.Length == 3) {
                var o = Json.Object(a[2]); Json.Keys(o, "", "durationMs steps");
                if (o.ContainsKey("durationMs")) plan.Duration = (int)Json.Integer(o["durationMs"], 500, 2000);
                if (o.ContainsKey("steps")) plan.Steps = (int)Json.Integer(o["steps"], 2, 64);
            }
        }
        if (method == "paste" && a.Length == 2) {
            var o = Json.Object(a[1]); Json.Keys(o, "", "format");
            if (o.ContainsKey("format") && Json.Text(o["format"]) != "text") throw new DriverFault("INVALID_PARAMS");
        }
        return plan;
    }
}
internal sealed class DriverChord
{
    internal string Key, Canonical;
    internal int[] Modifiers;
    internal string[] PostedLimits(IEnumerable<int> resolvedModifiers)
    {
        var modifiers = resolvedModifiers.ToArray();
        if (modifiers.Length != 0 && !(DriverClipboardRule.AllowMenuMnemonics && Key != null && Key.Length == 1 && modifiers.Contains(18) && modifiers.All(m => m == 18 || m == 16)))
            throw new DriverFault("CHORD_NEEDS_FOREGROUND", "Modifier chords need a matching UIA accelerator or an explicit foreground adapter. No key was sent.");
        return new string[0];
    }
    internal static readonly Dictionary<string, int> Named = new Dictionary<string, int> {
        { "return", 13 }, { "enter", 13 }, { "escape", 27 }, { "esc", 27 }, { "tab", 9 }, { "space", 32 },
        { "backspace", 8 }, { "delete", 46 }, { "insert", 45 }, { "printscreen", 44 }, { "home", 36 }, { "end", 35 },
        { "pageup", 33 }, { "pagedown", 34 }, { "left", 37 }, { "up", 38 }, { "right", 39 }, { "down", 40 }
    };
    internal static int Modifier(string s) {
        switch (s) {
        case "ctrl": case "control": return 17;
        case "shift": return 16;
        case "alt": case "option": return 18;
        case "win": case "super": case "meta": return 91;
        default: return 0;
        }
    }
    internal static DriverChord Parse(string text)
    {
        var parts = text.ToLowerInvariant().Split('+');
        var mods = new List<int>(); string key = null;
        foreach (string raw in parts) {
            string part = raw.Trim(); int modifier = Modifier(part);
            if (modifier != 0) { if (key != null || mods.Contains(modifier)) throw new DriverFault("INVALID_PARAMS"); mods.Add(modifier); }
            else { if (key != null || part.Length == 0) throw new DriverFault("INVALID_PARAMS"); key = part; }
        }
        if (key == null && mods.Count != 1) throw new DriverFault("INVALID_PARAMS");
        if (key != null) VirtualKey(key); // Validate names even before the target layout is available.
        mods.Sort();
        return new DriverChord { Key = key, Modifiers = mods.ToArray(),
            Canonical = String.Join("+", mods.Select(m => m.ToString(CultureInfo.InvariantCulture)).Concat(key == null ? new string[0] : new[] { key == "enter" ? "return" : key == "esc" ? "escape" : key })) };
    }
    internal static DriverChord ParseAccelerator(string text)
    {
        text = System.Text.RegularExpressions.Regex.Replace(text.TrimEnd(), @"(^|\+)\s*\+\z", "$1=");
        return Parse(String.Join("+", text.Split('+').Select(raw => {
            string part = raw.Trim().ToLowerInvariant();
            switch (part) {
            case "ins": return "insert";
            case "del": return "delete";
            case "prtsc": case "prtscn": case "prt scr": case "print screen": return "printscreen";
            default: return part;
            }
        })));
    }
    internal static int VirtualKey(string key)
    {
        int vk, f;
        if (Named.TryGetValue(key, out vk)) return vk;
        if (key.Length >= 2 && key[0] == 'f' && Int32.TryParse(key.Substring(1), out f) && f >= 1 && f <= 24) return 111 + f;
        if (key.Length == 1 && !Char.IsControl(key[0]) && !Char.IsSurrogate(key[0])) return 0; // VkKeyScanEx on target layout.
        throw new DriverFault("INVALID_PARAMS");
    }
}
}
