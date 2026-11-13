using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

namespace Sleight.Driver {
// Audit the compiled inventory before running a fixture. An unsafe mutant must
// fail without invoking its new native sender, even in later fixture cases.
internal static class InventoryEffectAudit {
    static IEnumerable<Type> Types(Type root) {
        yield return root;
        foreach (var nested in root.GetNestedTypes(BindingFlags.Public | BindingFlags.NonPublic))
            foreach (var type in Types(nested)) yield return type;
    }
    internal static List<string> Collect() {
        var writes = new List<string>();
        var codes = typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(field => field.FieldType == typeof(OpCode)).Select(field => (OpCode)field.GetValue(null))
            .ToDictionary(code => code.Value);
        var pending = new Queue<MethodBase>();
        var visited = new HashSet<MethodBase>();
        var roots = new[] { typeof(DriverInventory), typeof(DriverBindings), typeof(DriverWindowLife),
            typeof(DriverTopology), typeof(DriverTopologyEpoch), typeof(WindowRecord) };
        var flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly;
        foreach (var type in roots.SelectMany(Types))
            foreach (var method in type.GetMethods(flags).Cast<MethodBase>().Concat(type.GetConstructors(flags))) pending.Enqueue(method);
        while (pending.Count != 0) {
                var method = pending.Dequeue(); if (!visited.Add(method)) continue;
                var type = method.DeclaringType;
                var body = method.GetMethodBody(); if (body == null) continue;
                byte[] bytes = body.GetILAsByteArray(); int at = 0;
                while (at < bytes.Length) {
                    short value = bytes[at++];
                    if (value == 0xfe) value = unchecked((short)(0xfe00 | bytes[at++]));
                    var code = codes[value];
                    if (code.OperandType == OperandType.InlineMethod) {
                        var called = method.Module.ResolveMethod(BitConverter.ToInt32(bytes, at),
                            type.IsGenericType ? type.GetGenericArguments() : Type.EmptyTypes,
                            method.IsGenericMethod ? method.GetGenericArguments() : Type.EmptyTypes);
                        // Follow project helpers as well as direct native calls. A helper cannot hide a sender.
                        // The key is the inventory type's namespace, the same one DriverInput and DriverUia use.
                        if (called.DeclaringType != null && called.Module.Assembly == typeof(DriverInventory).Assembly &&
                            called.DeclaringType.Namespace == typeof(DriverInventory).Namespace && called.DeclaringType != typeof(InventoryEffectAudit))
                            pending.Enqueue(called);
                        var import = called.GetCustomAttributes(typeof(DllImportAttribute), false).Cast<DllImportAttribute>().FirstOrDefault();
                        string entry = import == null ? "" : import.EntryPoint ?? called.Name;
                        // Any call into DriverInput is a write, including an import the sender regex does not name.
                        // The namespace walk above still follows the helper to the native method.
                        bool intoDriverInput = called.DeclaringType == typeof(DriverInput);
                        // Pattern writes are Invoke, SetValue, and the other UIA pattern methods DriverActions calls.
                        bool intoDriverUiaWrite = UiaPatternWrite(called);
                        if (intoDriverInput || intoDriverUiaWrite || import != null &&
                            Regex.IsMatch(entry, "^(SetProp|RemoveProp|SendMessage|PostMessage|SetWindow|SetFocus|SetForeground|ShowWindow|SendInput|mouse_event|keybd_event)"))
                            writes.Add(type.FullName + "." + method.Name + " -> " + called.DeclaringType.FullName + "." + called.Name);
                    }
                    switch (code.OperandType) {
                    case OperandType.InlineNone: break;
                    case OperandType.ShortInlineBrTarget: case OperandType.ShortInlineI: case OperandType.ShortInlineVar: at += 1; break;
                    case OperandType.InlineVar: at += 2; break;
                    case OperandType.InlineBrTarget: case OperandType.InlineField: case OperandType.InlineI:
                    case OperandType.InlineMethod: case OperandType.InlineSig: case OperandType.InlineString:
                    case OperandType.InlineTok: case OperandType.InlineType: case OperandType.ShortInlineR: at += 4; break;
                    case OperandType.InlineI8: case OperandType.InlineR: at += 8; break;
                    case OperandType.InlineSwitch: at += 4 + 4 * BitConverter.ToInt32(bytes, at); break;
                    default: throw new Exception("unknown IL operand");
                    }
                    if (at > bytes.Length) throw new Exception("truncated IL operand");
                }
        }
        return writes;
    }
    static bool UiaPatternWrite(MethodBase called) {
        var type = called.DeclaringType;
        if (type == null) return false;
        var name = called.Name;
        if (type == typeof(IInvoke) && name == "Invoke") return true;
        if (type == typeof(IValue) && name == "SetValue") return true;
        if (type == typeof(IToggle) && name == "Toggle") return true;
        if (type == typeof(ISelectionItem) && name == "Select") return true;
        if (type == typeof(IExpand) && (name == "Expand" || name == "Collapse")) return true;
        if (type == typeof(IScrollItem) && name == "ScrollIntoView") return true;
        if (type == typeof(IScroll) && (name == "Scroll" || name == "SetScrollPercent")) return true;
        if (type == typeof(ILegacy) && (name == "DoDefaultAction" || name == "SetValue" || name == "Select")) return true;
        if (type == typeof(ITextRange) && name == "Select") return true;
        return false;
    }
}
}
