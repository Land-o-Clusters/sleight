using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;

namespace Sleight.Driver
{
// Hand-declared read subset of Microsoft's UIAutomationClient ABI. Unused slots are
// deliberately uncallable by convention. Their order, not their names, defines the ABI.
[ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IUIAutomation
{
    void Slot00(); void Slot01(); void Slot02(); void Slot03(); void Slot04(); void Slot05(); void Slot06();
    IUIAutomationElement ElementFromHandleBuildCache(IntPtr hwnd, IUIAutomationCacheRequest request);
    void Slot08(); void Slot09(); void Slot10();
    IUIAutomationTreeWalker ControlViewWalker();
    void Slot12(); void Slot13(); void Slot14();
    IUIAutomationCondition ControlViewCondition();
    void Slot16();
    IUIAutomationCacheRequest CreateCacheRequest();
    void Slot18(); void Slot19(); void Slot20(); void Slot21(); void Slot22(); void Slot23();
    void Slot24(); void Slot25(); void Slot26(); void Slot27(); void Slot28(); void Slot29(); void Slot30();
    void AddPropertyChangedEventHandlerNativeArray(IUIAutomationElement element, int scope, IUIAutomationCacheRequest cache,
        IUIAutomationPropertyChangedEventHandler handler, [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 5)] int[] properties, int count);
    void Slot32();
    void RemovePropertyChangedEventHandler(IUIAutomationElement element, IUIAutomationPropertyChangedEventHandler handler);
    void AddStructureChangedEventHandler(IUIAutomationElement element, int scope, IUIAutomationCacheRequest cache, IUIAutomationStructureChangedEventHandler handler);
    void RemoveStructureChangedEventHandler(IUIAutomationElement element, IUIAutomationStructureChangedEventHandler handler);
    void AddFocusChangedEventHandler(IUIAutomationCacheRequest cache, IUIAutomationFocusChangedEventHandler handler);
    void RemoveFocusChangedEventHandler(IUIAutomationFocusChangedEventHandler handler);
}
[ComImport, Guid("34723aff-0c9d-49d0-9896-7ab52df8cd8a"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IUIAutomation2
{
    // Repeat all 55 base slots explicitly; C# interface inheritance does not lay out COM slots.
    void Slot00(); void Slot01(); void Slot02(); void Slot03(); void Slot04();
    void Slot05(); void Slot06(); void Slot07(); void Slot08(); void Slot09();
    void Slot10(); void Slot11(); void Slot12(); void Slot13(); void Slot14();
    void Slot15(); void Slot16(); void Slot17(); void Slot18(); void Slot19();
    void Slot20(); void Slot21(); void Slot22(); void Slot23(); void Slot24();
    void Slot25(); void Slot26(); void Slot27(); void Slot28(); void Slot29();
    void Slot30(); void Slot31(); void Slot32(); void Slot33(); void Slot34();
    void Slot35(); void Slot36(); void Slot37(); void Slot38(); void Slot39();
    void Slot40(); void Slot41(); void Slot42(); void Slot43(); void Slot44();
    void Slot45(); void Slot46(); void Slot47(); void Slot48(); void Slot49();
    void Slot50(); void Slot51(); void Slot52(); void Slot53(); void Slot54();
    [return: MarshalAs(UnmanagedType.Bool)] bool GetAutomaticFocus();
    void PutAutomaticFocus([MarshalAs(UnmanagedType.Bool)] bool enabled);
    uint GetConnectionTimeout(); void PutConnectionTimeout(uint milliseconds);
    uint GetTransactionTimeout(); void PutTransactionTimeout(uint milliseconds);
}
[ComImport, Guid("352ffba8-0973-437c-a61f-f64cafd81df9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IUIAutomationCondition { }
[ComImport, Guid("b32a92b5-bc25-4078-9c08-d7ee95c48e03"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IUIAutomationCacheRequest
{
    void AddProperty(int property);
    void AddPattern(int pattern);
    IUIAutomationCacheRequest Clone();
    int GetTreeScope(); void PutTreeScope(int scope);
    IUIAutomationCondition GetTreeFilter(); void PutTreeFilter(IUIAutomationCondition filter);
    int GetElementMode(); void PutElementMode(int mode);
}
[ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IUIAutomationElement
{
    void Slot00();
    [return: MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_I4)] int[] GetRuntimeId();
    void Slot02(); void Slot03(); void Slot04(); void Slot05(); void Slot06();
    [return: MarshalAs(UnmanagedType.Struct)] object GetCurrentPropertyValue(int property);
    [return: MarshalAs(UnmanagedType.Struct)] object GetCurrentPropertyValueEx(int property, [MarshalAs(UnmanagedType.Bool)] bool ignoreDefault);
    void Slot09();
    [return: MarshalAs(UnmanagedType.Struct)] object GetCachedPropertyValueEx(int property, [MarshalAs(UnmanagedType.Bool)] bool ignoreDefault);
    void Slot11(); void Slot12();
    [return: MarshalAs(UnmanagedType.IUnknown)] object GetCurrentPattern(int pattern);
    void Slot14(); void Slot15();
    IUIAutomationElementArray GetCachedChildren();
}
[ComImport, Guid("14314595-b4bc-4055-95f2-58f2e42c9855"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IUIAutomationElementArray
{
    int Length();
    IUIAutomationElement GetElement(int index);
}
[ComImport, Guid("4042c624-389c-4afc-a630-9df854a541fc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IUIAutomationTreeWalker
{
    IUIAutomationElement GetParentElement(IUIAutomationElement element);
    void Slot01(); void Slot02(); void Slot03(); void Slot04(); void Slot05(); void Slot06();
    IUIAutomationElement GetFirstChildElementBuildCache(IUIAutomationElement element, IUIAutomationCacheRequest request);
    void Slot08();
    IUIAutomationElement GetNextSiblingElementBuildCache(IUIAutomationElement element, IUIAutomationCacheRequest request);
}
internal sealed class DriverNode
{
    internal int Depth, Type, RootOrder;
    internal string Role, Name, Id, Help, Value, Accelerator, Access, Line;
    internal bool Password, Offscreen, Enabled = true, Focused;
    internal int[] RuntimeId;
    internal IUIAutomationElement Element;
    internal WindowRecord Host;
    internal DriverNode Parent;
    internal object Rectangle, NativeHandle, Toggle, Selected, Expanded, RangeValue;
    internal readonly List<string> Actions = new List<string>();
}
internal sealed partial class DriverUia : IDisposable
{
    readonly IUIAutomation automation;
    readonly IUIAutomationCacheRequest cache;
    readonly IUIAutomationTreeWalker walker;
    readonly Dictionary<int, DriverNode> latest = new Dictionary<int, DriverNode>();
    long readId;
    WindowRecord latestWindow;
    internal const int LineBudget = 3000;
    internal const int TextBudget = 1024 * 1024, DepthBudget = 32, FetchCallBudget = 6000;
    // Cached property ids from the Windows SDK. All per-node access is cache-only.
    internal const int RuntimeId = 30000, BoundingRectangle = 30001, ProcessId = 30002, ControlType = 30003, Name = 30005,
        AcceleratorKey = 30006, AccessKey = 30007, HasKeyboardFocus = 30008, IsEnabled = 30010,
        AutomationId = 30011, HelpText = 30013, IsPassword = 30019, NativeWindowHandle = 30020,
        IsOffscreen = 30022, ValueValue = 30045, RangeValueValue = 30047, ExpandState = 30070,
        IsSelected = 30079, ToggleState = 30086, IsDialog = 30174;
    static readonly int[] Properties = { RuntimeId, BoundingRectangle, ProcessId, ControlType, 30004, Name, AcceleratorKey, AccessKey,
        HasKeyboardFocus, IsEnabled, AutomationId, HelpText, IsPassword, NativeWindowHandle, IsOffscreen,
        ValueValue, RangeValueValue, ExpandState, IsSelected, ToggleState, IsDialog,
        30028, 30031, 30033, 30034, 30035, 30036, 30040, 30041, 30043, 30044, 30090 };
    internal DriverUia()
    {
        // CUIAutomation8 exposes IUIAutomation2 and its provider deadlines.
        object instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("e22ad333-b25f-460c-83d0-0581107395c9"), true));
        try {
            automation = (IUIAutomation)instance;
            var options = (IUIAutomation2)instance;
            options.PutAutomaticFocus(false);
            options.PutConnectionTimeout(1000); options.PutTransactionTimeout(2000);
            cache = automation.CreateCacheRequest();
            walker = automation.ControlViewWalker();
            cache.PutTreeScope(1); // TreeScope_Element, never an unbounded subtree.
            cache.PutElementMode(1); // Full references retained for the next action lane.
            var condition = automation.ControlViewCondition();
            try { cache.PutTreeFilter(condition); } finally { Release(condition); }
            foreach (int property in Properties) cache.AddProperty(property);
        } catch { Release(walker); Release(cache); Release(instance); throw; }
    }
    static void Release(object value) { if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); }
    internal static bool SensitiveType(int type)
    {
        switch (type) {
        case 50003: case 50004: case 50025: case 50030: case 50033: return true;
        default: return type < 50000 || type > 50040;
        }
    }
    internal static bool Password(Func<int, bool, object> read, int type)
    {
        bool sensitive = SensitiveType(type);
        object value = read(IsPassword, sensitive);
        if (!sensitive) return value is bool && (bool)value;
        return !(value is bool) || (bool)value;
    }
    internal static bool OwnedProcess(object value, uint pid) { return value is int && (int)value > 0 && (uint)(int)value == pid; }
    internal static bool Enabled(object value) { return !(value is bool) || (bool)value; }
    static bool Flag(object value) { return value is bool && (bool)value; }
    static object StateProperty(object value) { return value is bool || value is int || value is double ? value : null; }
    internal static string Role(int type)
    {
        switch (type) {
        case 50000: return "button"; case 50001: return "calendar"; case 50002: return "checkbox";
        case 50003: return "combo box"; case 50004: return "text field"; case 50005: return "link";
        case 50006: return "image"; case 50007: return "list item"; case 50008: return "list";
        case 50009: return "menu"; case 50010: return "menu bar"; case 50011: return "menu item";
        case 50012: return "progress indicator"; case 50013: return "radio button"; case 50014: return "scroll bar";
        case 50015: return "slider"; case 50016: return "incrementor"; case 50017: return "group";
        case 50018: return "tab group"; case 50019: return "tab"; case 50020: return "text";
        case 50021: return "toolbar"; case 50022: return "help tag"; case 50023: return "outline";
        case 50024: return "row"; case 50025: return "group"; case 50026: return "group";
        case 50028: return "table"; case 50029: return "cell"; case 50030: return "text entry area";
        case 50032: return "standard window"; case 50033: return "group"; case 50036: return "table";
        case 50038: return "splitter";
        default: return "group";
        }
    }
    internal static string Clean(string value)
    {
        if (value == null) return "";
        var text = new StringBuilder(Math.Min(value.Length, 16384));
        for (int i = 0; i < value.Length && text.Length < 16384; i++) {
            char c = value[i];
            text.Append(Char.IsControl(c) || c == '\u2028' || c == '\u2029' ? ' ' : c);
        }
        return text.ToString();
    }
    internal static DriverNode Node(Func<int, bool, object> read, int depth)
    {
        object type = read(ControlType, true);
        if (!(type is int)) throw new DriverFault("UIA_UNAVAILABLE");
        var node = new DriverNode { Type = (int)type, Role = Role((int)type), Depth = depth,
            Password = Password(read, (int)type), Offscreen = Flag(read(IsOffscreen, true)), Enabled = Enabled(read(IsEnabled, true)),
            Focused = Flag(read(HasKeyboardFocus, true)), RuntimeId = read(RuntimeId, true) as int[],
            Rectangle = read(BoundingRectangle, true), NativeHandle = read(NativeWindowHandle, true),
            Id = read(AutomationId, true) as string, Accelerator = read(AcceleratorKey, true) as string, Access = read(AccessKey, true) as string };
        // Decide masking before retrieving a label, help or value from the cache.
        if (!node.Password) {
            node.Name = read(Name, true) as string; node.Help = read(HelpText, true) as string; node.Value = read(ValueValue, true) as string;
        }
        node.Toggle = StateProperty(read(ToggleState, true)); node.Selected = StateProperty(read(IsSelected, true));
        node.Expanded = StateProperty(read(ExpandState, true)); node.RangeValue = StateProperty(read(RangeValueValue, true));
        foreach (var action in new[] { new KeyValuePair<int,string>(30028, "Expand/Collapse"),
            new KeyValuePair<int,string>(30031, "Invoke"), new KeyValuePair<int,string>(30035, "ScrollIntoView"),
            new KeyValuePair<int,string>(30036, "Select"), new KeyValuePair<int,string>(30041, "Toggle"),
            new KeyValuePair<int,string>(30090, "DoDefaultAction") }) if (Flag(read(action.Key, true))) node.Actions.Add(action.Value);
        return node;
    }
    // Each navigation fetch caches only one element. No child array is materialized.
    // canFetch shares the node, call and time budgets across the main root and popups.
    internal static bool Walk<T>(T root, Func<T, T> child, Func<T, T> sibling,
        Func<T, int, bool> visit, Func<bool> canFetch) where T : class
    {
        var parents = new Stack<T>();
        T current = root;
        bool partial = false;
        while (current != null) {
            bool descend = visit(current, parents.Count);
            if (descend && parents.Count >= DepthBudget) { partial = true; descend = false; }
            if (descend) {
                if (!canFetch()) return true;
                T next = child(current);
                if (next != null) { parents.Push(current); current = next; continue; }
            }
            while (parents.Count > 0) {
                if (!canFetch()) return true;
                T next = sibling(current);
                if (next != null) { current = next; break; }
                current = parents.Pop();
            }
            if (parents.Count == 0) return partial;
        }
        return partial;
    }
    bool Fetch(WindowRecord window, List<DriverNode> nodes, Func<bool> canFetch)
    {
        if (!canFetch()) return true;
        int start = nodes.Count;
        var excluded = new List<IUIAutomationElement>();
        try { return FetchChecked(window, () => {
            DriverOperationCounters.Mark(DriverOperationCounters.Kind.UiaFetch);
            IUIAutomationElement root = automation.ElementFromHandleBuildCache(window.InputRoot, cache);
            if (root == null) throw new DriverFault("TARGET_UNAVAILABLE");
            var ancestry = new List<DriverNode>();
            int rootOrder = start;
            return Walk(root, e => { DriverOperationCounters.Mark(DriverOperationCounters.Kind.UiaFetch); return walker.GetFirstChildElementBuildCache(e, cache); },
            e => { DriverOperationCounters.Mark(DriverOperationCounters.Kind.UiaFetch); return walker.GetNextSiblingElementBuildCache(e, cache); }, (element, depth) => {
                DriverNode node;
                try {
                    if (!OwnedProcess(element.GetCachedPropertyValueEx(ProcessId, true), window.Pid)) {
                        excluded.Add(element); return false; // Drop the entire foreign or unknown provider subtree before reading text.
                    }
                    node = Node((property, ignoreDefault) => element.GetCachedPropertyValueEx(property, ignoreDefault), depth);
                }
                catch { Release(element); throw; }
                node.Element = element; node.Host = window; node.RootOrder = rootOrder;
                while (ancestry.Count > depth) ancestry.RemoveAt(ancestry.Count - 1);
                node.Parent = depth > 0 ? ancestry[depth - 1] : null;
                ancestry.Add(node); nodes.Add(node);
                if (depth == 0) node.Role = window.Popup ? (window.ClassName == "#32768" ? "menu" : "dialog") : "standard window";
                return !(node.Type == 50007 && node.Offscreen);
            }, canFetch);
        }, () => DriverInventory.Observe(window.Handle), () => {
            // A vanished popup contributes no stale element references to the read map.
            for (int i = start; i < nodes.Count; i++) Release(nodes[i].Element);
            nodes.RemoveRange(start, nodes.Count - start);
        }); } finally { foreach (var element in excluded) Release(element); }
    }
    internal static bool FetchChecked(WindowRecord window, Func<bool> fetch, Func<WindowRecord> observe, Action discard)
    {
        var before = observe();
        if (window.Popup && before == null) return true;
        DriverIdentity.Verify(window, before);
        bool partial;
        try { partial = fetch(); }
        catch (COMException) {
            // Providers can throw when a popup closes during navigation.
            if (window.Popup && observe() == null) { discard(); return true; }
            throw;
        } catch (DriverFault error) {
            if (error.Code == "TARGET_UNAVAILABLE" && window.Popup && observe() == null) { discard(); return true; }
            throw;
        }
        var after = observe();
        if (window.Popup && after == null) { discard(); return true; }
        DriverIdentity.Verify(window, after);
        return partial;
    }
    internal static string Serialize(string title, string app, IList<DriverNode> nodes,
        Dictionary<int, DriverNode> map, out bool truncated)
    {
        var lines = new List<string> { "Window: " + Json.Codec.Serialize(Clean(title)) + ", App: " + Clean(app) + "." };
        int bytes = Encoding.UTF8.GetByteCount(lines[0]);
        truncated = false;
        foreach (var node in nodes) {
            if (node.Type == 50007 && node.Offscreen) continue;
            if (map.Count >= LineBudget) { truncated = true; break; }
            int number = map.Count;
            string line = new string('\t', node.Depth) + number.ToString(CultureInfo.InvariantCulture) + " " + node.Role;
            string name = node.Password ? "<redacted>" : Clean(node.Name);
            if (name.Length > 0) line += " " + name;
            if (!node.Enabled) line += " (disabled)";
            if (node.Focused) line += " (focused)";
            if (node.Selected is bool && (bool)node.Selected) line += " (selected)";
            if (node.Toggle is int && (int)node.Toggle == 1) line += " (checked)";
            if (node.Toggle is int && (int)node.Toggle == 2) line += " (mixed)";
            if (node.Expanded is int && (int)node.Expanded == 0) line += " (collapsed)";
            if (node.Expanded is int && (int)node.Expanded == 1) line += " (expanded)";
            if (!String.IsNullOrEmpty(node.Id)) line += ", ID: " + Clean(node.Id);
            if (!node.Password && !String.IsNullOrEmpty(node.Value)) line += ", Value: " + Clean(node.Value);
            else if (!node.Password && node.RangeValue != null) line += ", Value: " + Convert.ToString(node.RangeValue, CultureInfo.InvariantCulture);
            if (!node.Password && !String.IsNullOrEmpty(node.Help)) line += ", Help: " + Clean(node.Help);
            if (node.Actions.Count > 0) line += ", Secondary Actions: " + String.Join(", ", node.Actions);
            int size = Encoding.UTF8.GetByteCount(line) + 1;
            if (bytes + size > TextBudget) { truncated = true; break; }
            bytes += size; node.Line = line.TrimStart('\t'); map.Add(number, node); lines.Add(line);
        }
        return String.Join("\n", lines);
    }
    internal object Read(WindowRecord window, IList<WindowRecord> inventory, long deadline)
    {
        var session = new DriverSession.ReadProbe();
        var clock = Stopwatch.StartNew();
        foreach (var old in latest.Values) Release(old.Element);
        latest.Clear();
        latestWindow = null;
        var nodes = new List<DriverNode>();
        try {
            int calls = 0;
            // Reserve one provider transaction plus response/identity work before the hard deadline.
            Func<bool> canFetch = () => { session.Require(); return nodes.Count < LineBudget && calls++ < FetchCallBudget && Driver.Now() < deadline - 2250; };
            bool partial = Fetch(window, nodes, canFetch);
            foreach (var popup in inventory.Where(w => DriverInventory.PopupFor(w, window))) {
                if (popup.Refused != null || popup.Minimized && popup.Aumid != null) { partial = true; continue; }
                partial |= Fetch(popup, nodes, canFetch);
            }
            var after = DriverInventory.Observe(window.Handle);
            if (after == null) throw new DriverFault("IDENTITY_CHANGED");
            after.RequireReadable();
            if (!window.SameIdentity(after))
                throw new DriverFault("IDENTITY_CHANGED");
            bool truncated;
            string text = Serialize(after.Title, after.App, nodes, latest, out truncated);
            latestWindow = after;
            var focused = latest.Where(pair => pair.Value.Focused).Select(pair => pair.Key).ToArray();
            session.Finish();
            return Json.Map("window", after.JsonValue(), "text", text, "focusedElement", focused.Length == 1 ? (object)focused[0] : null, "readId", ++readId, "truncated", truncated || partial, "partialTree", partial, "elapsedMs", clock.Elapsed.TotalMilliseconds);
        } catch (COMException e) {
            latest.Clear(); latestWindow = null;
            throw new DriverFault(ProviderCode(e.ErrorCode));
        } catch { latest.Clear(); latestWindow = null; throw; }
        finally {
            var retained = new HashSet<DriverNode>(latest.Values);
            foreach (var node in nodes) if (!retained.Contains(node)) Release(node.Element);
        }
    }
    internal void InvalidateRead()
    {
        foreach (var node in latest.Values) Release(node.Element);
        latest.Clear(); latestWindow = null; ++readId;
    }
    public void Dispose()
    {
        InvalidateRead(); Release(walker); Release(cache); Release(automation);
    }
}
}
