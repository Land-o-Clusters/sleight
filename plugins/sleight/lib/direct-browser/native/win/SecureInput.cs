using System;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Automation;

namespace Sleight.Cursor
{
// This observation never relaxes phase 1's unconditional suppression of labels,
// caret motion and key taps. One hung provider retains at most one MTA worker.
public sealed class SecureInput
{
    int busy;
    readonly Func<int, bool> query;
    public SecureInput(Func<int, bool> query = null)
    {
        this.query = query ?? Query;
    }
    static bool Query(int pid)
    {
        var element = AutomationElement.FocusedElement;
        if (element == null)
            return true;
        var current = element.Current;
        return current.ProcessId != pid || current.IsPassword;
    }
    public bool IsSecure(int pid)
    {
        if (Interlocked.CompareExchange(ref busy, 1, 0) != 0)
            return true;
        var result = new TaskCompletionSource<bool>();
        var thread = new Thread(() => {
            bool secure = true;
            try { secure = query(pid); } catch { }
            result.TrySetResult(secure);
            Interlocked.Exchange(ref busy, 0);
        });
        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.MTA);
        try { thread.Start(); }
        catch { Interlocked.Exchange(ref busy, 0); return true; }
        return !result.Task.Wait(150) || result.Task.Result;
    }
}
}
