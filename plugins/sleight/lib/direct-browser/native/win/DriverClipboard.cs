using System;
using System.Linq;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace Sleight.Driver
{
// Source name retained for the existing build manifest. Paste has no clipboard route.
internal static class DriverClipboard
{
    internal static string DirectPaste(string text, Action validate, Func<string> send)
    {
        // Character messages for these values can invoke commands instead of inserting text.
        if (text.Any(c => c < 32 || c == 127))
            throw new DriverFault("BACKGROUND_UNAVAILABLE", "paste cannot deliver control characters, tabs or newlines through direct character input; the system clipboard was not accessed");
        validate();
        return send(); // Never replay a failed or partial character delivery.
    }
    internal static string Paste(WindowRecord window, IntPtr focus, string text)
    {
        return DirectPaste(text, () => {
            DriverInput.Check(window, focus);
            DriverInput.RequireWritableEdit(focus);
            if (DriverInput.Focus(window) != focus) throw new DriverFault("NO_BACKGROUND_FOCUS");
        }, () => DriverInput.Type(window, focus, text, true));
    }
}
// Only the resolved key and modifiers decide structural refusal. The parent
// supplies label verdicts from the single shared normalizer and table.
internal static class DriverClipboardRule
{
    internal const bool RefuseControlCopy = true;
    internal const bool RefuseAlternateClipboardKeys = true;
    internal const bool RefuseInaccessibleSequence = true;
    internal const bool RefuseRequestedCopy = true;
    internal const bool AllowMenuMnemonics = true;
    internal const bool UseSharedLabelPolicy = true;
    internal const bool ExposeMenuKeysInTree = false;
    internal static bool KeyRefused(DriverInput.ResolvedKey resolved, bool target = false)
    {
        int key = resolved.Key; var modifiers = resolved.Modifiers;
        bool control = modifiers.Contains(17), win = modifiers.Contains(91), shift = modifiers.Contains(16);
        return RefuseControlCopy && (control || win) && (key == 0x43 || key == 0x58) ||
            RefuseAlternateClipboardKeys && (key == 0x2d && control || key == 0x2e && shift || key == 0x2c || key == 0x53 && win && shift) ||
            !target && (key == 0x56 && control || key == 0x2d && shift);
    }
    internal static DriverFault Refusal(string reason = "clipboard-action")
    {
        return new DriverFault("ACTION_UNSUPPORTED") { Disposition = Json.Map("clipboardRefused", true,
            "delivery", "not-sent", "retry", "safe", "clipboard", "untouched", "reason", reason) };
    }
    internal static void RefuseKey(DriverInput.ResolvedKey resolved)
    {
        if (KeyRefused(resolved)) throw Refusal();
    }
    internal static bool TargetRefused(DriverNode node, bool labelBlocked, Func<DriverChord, DriverInput.ResolvedKey> resolve)
    {
        if (node == null) return false;
        if (UseSharedLabelPolicy && RefuseRequestedCopy && labelBlocked) return true;
        if (String.IsNullOrEmpty(node.Accelerator)) return false;
        try {
            var chord = DriverChord.ParseAccelerator(node.Accelerator);
            return KeyRefused(ResolveAccelerator(chord, resolve), true);
        }
        catch (DriverFault e) {
            // Localized modifier names are not chord grammar. The label layer
            // remains authoritative; unavailable layout evidence refuses closed.
            if (e.Code == "INVALID_PARAMS") return false;
            throw;
        }
    }
    internal static DriverInput.ResolvedKey ResolveAccelerator(DriverChord chord, Func<DriverChord, DriverInput.ResolvedKey> resolve)
    {
        // Accelerator labels identify Latin virtual keys on every keyboard layout.
        if (chord.Key != null && chord.Key.Length == 1 &&
            (chord.Key[0] >= 'a' && chord.Key[0] <= 'z' || chord.Key[0] >= '0' && chord.Key[0] <= '9'))
            return new DriverInput.ResolvedKey { Key = Char.ToUpperInvariant(chord.Key[0]), Modifiers = chord.Modifiers };
        int oem = 0;
        switch (chord.Key) {
        case ";": case ":": oem = 0xba; break;
        case "=": oem = 0xbb; break;
        case ",": case "<": oem = 0xbc; break;
        case "-": case "_": oem = 0xbd; break;
        case ".": case ">": oem = 0xbe; break;
        case "/": case "?": oem = 0xbf; break;
        case "`": case "~": oem = 0xc0; break;
        case "[": case "{": oem = 0xdb; break;
        case "\\": case "|": oem = 0xdc; break;
        case "]": case "}": oem = 0xdd; break;
        case "'": case "\"": oem = 0xde; break;
        }
        if (oem != 0) return new DriverInput.ResolvedKey { Key = oem, Modifiers = chord.Modifiers };
        return resolve(chord);
    }
    internal static bool TextActivates(DriverActionPlan plan)
    {
        return plan.Method == "typeText" && plan.Text.Any(c => c == '\r' || c == '\n');
    }
    internal static bool AccessMatches(string access, DriverChord chord)
    {
        if (String.IsNullOrEmpty(access) || chord.Key == null || chord.Key.Length != 1 || chord.Modifiers.Any(m => m != 16 && m != 18)) return false;
        var tips = access.ToLowerInvariant().Split(',').Select(s => s.Trim()).ToArray();
        if (tips.Length > 1 && tips[0] == "alt" && tips.Skip(1).All(s => s.Length == 1)) return tips.Skip(1).Contains(chord.Key);
        try { return DriverChord.Parse(access).Key == chord.Key; }
        catch (DriverFault) { return access.TrimStart('&').Equals(chord.Key, StringComparison.OrdinalIgnoreCase); }
    }
}
internal sealed class DriverClipboardWatch
{
    internal struct CounterSample { internal uint Value; internal uint Error; }
    // One reviewed API name and boundary, pinned by the source scan.
    [DllImport("user32.dll", EntryPoint = "GetClipboardSequenceNumber", SetLastError = true)] static extern uint Sequence();
    [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
    readonly Func<CounterSample> sample;
    readonly Func<uint> personInput;
    uint? last;
    uint lastPerson;
    bool seenNonzero;
    internal DriverClipboardWatch(Func<CounterSample> sample = null, Func<uint> personInput = null)
    {
        this.sample = sample ?? (() => {
            SetLastError(0); uint v = Sequence();
            return new CounterSample { Value = v, Error = (uint)Marshal.GetLastWin32Error() };
        });
        this.personInput = personInput ?? new Func<uint>(DriverInput.LastPersonInput);
    }
    uint Read(bool admitted)
    {
        try {
            CounterSample current = sample();
            if (DriverClipboardRule.RefuseInaccessibleSequence && current.Value == 0 && (current.Error != 0 || seenNonzero))
                throw new InvalidOperationException();
            if (current.Value != 0) seenNonzero = true;
            return current.Value;
        } catch {
            throw new DriverFault("ACTION_UNSUPPORTED") { Disposition = Json.Map("clipboardRefused", true,
                "delivery", admitted ? "unknown" : "not-sent", "retry", admitted ? "read-first" : "safe",
                "reason", "clipboard-count-unavailable") };
        }
    }
    uint Person(bool admitted)
    {
        try { return personInput(); }
        catch {
            throw new DriverFault("ACTION_UNSUPPORTED") { Disposition = Json.Map("clipboardRefused", true,
                "delivery", admitted ? "unknown" : "not-sent", "retry", admitted ? "read-first" : "safe",
                "reason", "person-input-unavailable") };
        }
    }
    internal uint Admit()
    {
        uint current = Read(false);
        if (last.HasValue && current != last.Value && Person(false) == lastPerson) {
            last = current;
            throw new DriverFault("CLIPBOARD_CHANGED") { Disposition = Json.Map("clipboardChanged", true,
                "delivery", "not-sent", "retry", "safe", "reason", "since-last-action") };
        }
        return current;
    }
    internal bool Finish(uint baseline)
    {
        uint current = Read(true);
        last = current; lastPerson = Person(true);
        return current != baseline;
    }
}

}
