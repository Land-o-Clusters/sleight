// ABI declarations from Microsoft's UIAutomationClient.h. C# 5, no managed UIA wrapper.
using System;
using System.Runtime.InteropServices;

namespace Sleight.Driver
{
[ComImport, Guid("fb377fbe-8ea6-46d5-9c73-6499642d3059"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IInvoke { void Invoke(); }
[ComImport, Guid("a94cd8b1-0844-4cd6-9d2d-640537ab39e9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IValue {
    void SetValue([MarshalAs(UnmanagedType.BStr)] string value);
    [return: MarshalAs(UnmanagedType.BStr)] string CurrentValue();
    [return: MarshalAs(UnmanagedType.Bool)] bool ReadOnly();
}
[ComImport, Guid("94cf8058-9b8d-4ab9-8bfd-4cd0a33c8c70"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IToggle { void Toggle(); }
[ComImport, Guid("a8efa66a-0fda-421a-9194-38021f3578ea"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface ISelectionItem { void Select(); }
[ComImport, Guid("619be086-1f4e-4ee4-bafa-210128738730"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IExpand { void Expand(); void Collapse(); int State(); }
[ComImport, Guid("88f4d42a-e881-459d-a77c-73bbbb7e02dc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IScroll { void Scroll(int horizontal, int vertical); void SetScrollPercent(double horizontal, double vertical); }
[ComImport, Guid("b488300f-d015-4f19-9c29-bb595e3645ef"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IScrollItem { void ScrollIntoView(); }
[ComImport, Guid("828055ad-355b-4435-86d5-3b51c14a9b1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface ILegacy {
    void Select(int flags);
    void DoDefaultAction();
    void SetValue([MarshalAs(UnmanagedType.BStr)] string value);
    int CurrentChildId();
    [return: MarshalAs(UnmanagedType.BStr)] string CurrentName();
    [return: MarshalAs(UnmanagedType.BStr)] string CurrentValue();
    [return: MarshalAs(UnmanagedType.BStr)] string CurrentDescription();
    uint CurrentRole(); uint CurrentState();
    [return: MarshalAs(UnmanagedType.BStr)] string CurrentHelp();
    [return: MarshalAs(UnmanagedType.BStr)] string CurrentKeyboardShortcut();
    IUIAutomationElementArray GetCurrentSelection();
    [return: MarshalAs(UnmanagedType.BStr)] string CurrentDefaultAction();
}
[StructLayout(LayoutKind.Sequential)]
internal struct DriverPoint { internal int X, Y; internal DriverPoint(int x, int y) { X = x; Y = y; } }
[ComImport, Guid("32eba289-3583-42c9-9c59-3b6d9a1e9b6a"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IText {
    ITextRange RangeFromPoint(DriverPoint point);
    void Slot01(); void Slot02(); void Slot03();
    ITextRange DocumentRange();
}
[ComImport, Guid("a543cc6a-f4ae-494b-8239-c814481187a8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface ITextRange {
    void Slot00(); void Slot01(); void Slot02(); void Slot03(); void Slot04();
    ITextRange FindText([MarshalAs(UnmanagedType.BStr)] string text, [MarshalAs(UnmanagedType.Bool)] bool backward, [MarshalAs(UnmanagedType.Bool)] bool ignoreCase);
    void Slot06(); void Slot07(); void Slot08(); void Slot09(); void Slot10(); void Slot11();
    void MoveEndpointByRange(int endpoint, ITextRange range, int otherEndpoint);
    void Select();
}
[ComVisible(true), Guid("e81d1b4e-11c5-42f8-9754-e7036c79f054"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationStructureChangedEventHandler {
    void HandleStructureChangedEvent([MarshalAs(UnmanagedType.Interface)] object sender, int changeType,
        [MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_I4)] int[] runtimeId);
}
[ComVisible(true), Guid("40cd37d4-c756-4b0c-8c6f-bddfeeb13b50"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationPropertyChangedEventHandler {
    void HandlePropertyChangedEvent([MarshalAs(UnmanagedType.Interface)] object sender, int property,
        [MarshalAs(UnmanagedType.Struct)] object value);
}
[ComVisible(true), Guid("c270f6b5-5c69-4290-9745-7a7f97169468"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IUIAutomationFocusChangedEventHandler {
    void HandleFocusChangedEvent([MarshalAs(UnmanagedType.Interface)] object sender);
}
}
