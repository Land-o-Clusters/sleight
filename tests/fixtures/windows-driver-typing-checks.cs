// Headless production focus decisions and a hidden, process-owned Win32 Edit.
// Never show a window, change focus, send global input or activate UI Automation.
using System;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
namespace Sleight.Driver
{
internal static class DriverTypingChecks
{
    static int passed, editCases;
    static void Check(bool value, string detail = null) {
        if (!value) throw new Exception("Typing check " + (passed + 1) + (detail == null ? "" : ": " + detail));
        passed++;
    }
    static void Refuse(Action work) {
        try { work(); throw new Exception("Expected focus refusal"); }
        catch (DriverFault error) { Check(error.Code == "NO_BACKGROUND_FOCUS"); }
    }
    static void FocusCases() {
        var editor = new DriverNode { Focused = true, NativeHandle = 700 };
        var bridge = new DriverNode { Focused = true, NativeHandle = 101 };
        Func<DriverNode, bool> accepts = n => (int)n.NativeHandle == 700;
        Check(DriverUia.FocusedTarget(new[] { bridge, editor, bridge, bridge }, accepts) == editor);
        Check(DriverUia.FocusedTarget(new[] { editor, bridge }, accepts) == editor);
        Refuse(() => DriverUia.FocusedTarget(new DriverNode[0], accepts));
        Refuse(() => DriverUia.FocusedTarget(new[] { bridge }, accepts));
        Refuse(() => DriverUia.FocusedTarget(new[] { editor, editor }, accepts));
        editor.Focused = false;
        Refuse(() => DriverUia.FocusedTarget(new[] { editor }, accepts));
        Func<IntPtr, IntPtr, bool> child = (p, h) => p == new IntPtr(100) && h == new IntPtr(700);
        Check(DriverUia.NativeFocusMatches(new IntPtr(700), new IntPtr(700), child));
        Check(DriverUia.NativeFocusMatches(new IntPtr(700), new IntPtr(100), child));
        Check(!DriverUia.NativeFocusMatches(new IntPtr(100), new IntPtr(700), child));
        Check(!DriverUia.NativeFocusMatches(IntPtr.Zero, new IntPtr(700), child));
        Check(!DriverUia.NativeFocusMatches(new IntPtr(700), IntPtr.Zero, child));
    }
    [StructLayout(LayoutKind.Sequential)] struct MSG {
        internal IntPtr hwnd; internal uint message; internal UIntPtr key; internal IntPtr data;
        internal uint time; internal int x, y; internal uint privateData;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint ex, string cls, string name, uint style,
        int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool PostMessageW(IntPtr window, uint message, UIntPtr key, IntPtr data);
    [DllImport("user32.dll")] static extern bool PeekMessageW(out MSG message, IntPtr window, uint first, uint last, uint remove);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG message);
    static UIntPtr Send(IntPtr window, uint message, UIntPtr key, IntPtr data) {
        UIntPtr answer;
        if (DriverInput.SendMessageTimeoutW(window, message, key, data, 0x22, 500, out answer) == IntPtr.Zero)
            throw new Exception("Hidden Edit message timed out");
        return answer;
    }
    static void Drain(IntPtr window) {
        MSG message; int count = 0;
        while (PeekMessageW(out message, window, 0, 0, 1)) {
            if (++count > 8192) throw new Exception("Hidden Edit queue limit");
            DispatchMessageW(ref message);
        }
    }
    static string Text(IntPtr window) {
        int length = checked((int)Send(window, 0x000e, UIntPtr.Zero, IntPtr.Zero).ToUInt64());
        if (length > 8192) throw new Exception("Hidden Edit text limit");
        IntPtr buffer = Marshal.AllocHGlobal((length + 1) * 2);
        try { Send(window, 0x000d, new UIntPtr((uint)(length + 1)), buffer); return Marshal.PtrToStringUni(buffer); }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    static void NativeEdit() {
        IntPtr before = GetForegroundWindow(), parent = IntPtr.Zero, edit = IntPtr.Zero;
        try {
            // Neither HWND has WS_VISIBLE. WS_EX_NOACTIVATE is also set.
            parent = CreateWindowExW(0x08000080, "Static", "WT1 hidden unit", 0x80000000, 0, 0, 800, 300, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            Check(parent != IntPtr.Zero);
            // ES_AUTOHSCROLL and ES_AUTOVSCROLL let a hidden multiline control
            // accept input independently of how much text fits its client area.
            edit = CreateWindowExW(0x08000000, "Edit", "", 0x400000c4, 0, 0, 800, 300, parent, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            Check(edit != IntPtr.Zero && !IsWindowVisible(parent) && !IsWindowVisible(edit));
            DriverInput.RequireWritableEdit(edit);
            foreach (string replacement in new[] { "plain", "東京", "\ud83e\ude84", "e\u0301" }) {
                IntPtr initial = Marshal.StringToHGlobalUni("alpha beta");
                try { Send(edit, 0x000c, UIntPtr.Zero, initial); } finally { Marshal.FreeHGlobal(initial); }
                Send(edit, 0x00b1, new UIntPtr(6), new IntPtr(10)); // EM_SETSEL, this process's hidden control only.
                int checkpoints = 0;
                DriverInput.PumpText(replacement, false, (message, code, cleanup) => {
                    if (!PostMessageW(edit, message, new UIntPtr(code), new IntPtr(1))) throw new Exception("Hidden Edit post failed");
                }, () => checkpoints++, () => Drain(edit));
                Drain(edit);
                string actual = Text(edit);
                Check(actual == "alpha " + replacement, "replacement " + editCases + ", actual UTF-16 " + BitConverter.ToString(Encoding.Unicode.GetBytes(actual)));
                Check(checkpoints > 0 && DriverInput.Typed == replacement.Length);
                editCases++;
            }
            Check(!IsWindowVisible(parent) && !IsWindowVisible(edit) && GetForegroundWindow() == before);
        } finally {
            if (parent != IntPtr.Zero && !DestroyWindow(parent)) throw new Exception("Hidden Edit cleanup unproved");
        }
    }
    public static int Main(string[] args) {
        try {
            if (args.Length != 1 || args[0] != "--selftest") throw new Exception("Headless selftest mode required");
            FocusCases(); NativeEdit();
            Console.WriteLine(Json.Codec.Serialize(Json.Map("passed", passed, "failed", 0, "drawing", false,
                "editCases", editCases, "visibleWindows", 0, "uiaActivations", 0, "foregroundChanged", false)));
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
}
