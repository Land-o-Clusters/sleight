using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace Sleight.Person
{
// Handwritten declarations of the public Windows ABI. No vendor engine code or generated SDK assembly is loaded.
[ComImport, Guid("39e050c3-4e74-441a-8dc0-b81104df949c"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUserConsentVerifierInterop
{
    [PreserveSig] int GetIids(out uint count, out IntPtr iids);
    [PreserveSig] int GetRuntimeClassName(out IntPtr name);
    [PreserveSig] int GetTrustLevel(out int level);
    [PreserveSig] int RequestVerificationForWindowAsync(IntPtr hwnd, IntPtr message, ref Guid iid, out IntPtr operation);
}
[ComImport, Guid("af4f3f91-564c-4ddc-b8b5-973447627c65"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IUserConsentVerifierStatics
{
    [PreserveSig] int GetIids(out uint count, out IntPtr iids);
    [PreserveSig] int GetRuntimeClassName(out IntPtr name);
    [PreserveSig] int GetTrustLevel(out int level);
    [PreserveSig] int CheckAvailabilityAsync(out IntPtr operation);
    [PreserveSig] int RequestVerificationAsync(IntPtr message, out IntPtr operation);
}
[ComImport, Guid("fd596ffd-2318-558f-9dbe-d21df43764a5"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IConsentOperation
{
    [PreserveSig] int GetIids(out uint count, out IntPtr iids);
    [PreserveSig] int GetRuntimeClassName(out IntPtr name);
    [PreserveSig] int GetTrustLevel(out int level);
    [PreserveSig] int PutCompleted(IntPtr handler);
    [PreserveSig] int GetCompleted(out IntPtr handler);
    [PreserveSig] int GetResults(out int result);
}
[ComImport, Guid("ddd384f3-d818-5d83-ab4b-32119c28587c"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAvailabilityOperation
{
    [PreserveSig] int GetIids(out uint count, out IntPtr iids);
    [PreserveSig] int GetRuntimeClassName(out IntPtr name);
    [PreserveSig] int GetTrustLevel(out int level);
    [PreserveSig] int PutCompleted(IntPtr handler);
    [PreserveSig] int GetCompleted(out IntPtr handler);
    [PreserveSig] int GetResults(out int result);
}
[ComImport, Guid("00000036-0000-0000-c000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAsyncInfo
{
    [PreserveSig] int GetIids(out uint count, out IntPtr iids);
    [PreserveSig] int GetRuntimeClassName(out IntPtr name);
    [PreserveSig] int GetTrustLevel(out int level);
    [PreserveSig] int GetId(out uint id);
    [PreserveSig] int GetStatus(out int status);
    [PreserveSig] int GetErrorCode(out int code);
    [PreserveSig] int Cancel();
    [PreserveSig] int Close();
}
internal static class Hello
{
    internal const int TimeoutMs = 60000;
    [DllImport("combase.dll")] static extern int RoInitialize(uint type);
    [DllImport("combase.dll")] static extern void RoUninitialize();
    [DllImport("combase.dll", CharSet = CharSet.Unicode)] static extern int WindowsCreateString(string value, uint length, out IntPtr text);
    [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr text);
    [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr name, ref Guid iid, out IntPtr factory);
    static readonly Dictionary<string, string[]> Reasons = new Dictionary<string, string[]> {
        { "owner-present-sitting", new[] { "start a hands-off input check on this PC" } },
        { "turbo-on", new[] { "turn on sleight turbo", "turn on sleight turbo for {0}" } },
        { "turbo-app-on", new[] { "let sleight turbo drive an app", "let sleight turbo drive {0}" } },
        { "permissions-unblock", new[] { "lift one of sleight's blocks", "let sleight act in {0} again" } },
        { "permissions-unblock-site", new[] { "lift one of sleight's site blocks", "let sleight act on {0} again" } },
        { "permissions-sites-only", new[] { "limit the sites sleight may act on", "limit sleight to {0} sites" } },
        { "permissions-sites-all", new[] { "lift the limit to chosen sites; blocked sites stay blocked" } },
        { "permissions-repair", new[] { "repair sleight's permissions file" } },
        { "permissions-repair-discard", new[] { "erase every sleight block and site limit" } },
        { "routine-add", new[] { "install a sleight routine" } },
        { "routine-unlock", new[] { "clear a sleight routine's run lock" } },
        { "watch-add", new[] { "install a sleight watch" } },
        { "watch-unlock", new[] { "clear a sleight watch's run lock" } },
        { "replay", new[] { "run a saved script" } },
        { "record", new[] { "record or convert a run" } },
        { "settings", new[] { "change sleight's settings" } }
    };
    static readonly HashSet<string> Browsers = new HashSet<string> {
        "Google Chrome", "Helium", "Google Chrome Beta", "Google Chrome Dev", "Google Chrome Canary", "Chromium",
        "Brave Browser", "Microsoft Edge", "Vivaldi"
    };
    internal static string Reason(string[] args)
    {
        string[] value;
        if (args.Length < 1 || args.Length > 2 || !Reasons.TryGetValue(args[0], out value)) return null;
        if (args[0] == "permissions-sites-only" || args[0] == "permissions-unblock-site") {
            if (args.Length != 2 || value.Length < 2) return null;
            int count;
            bool valid = args[0] == "permissions-sites-only" ?
                System.Text.RegularExpressions.Regex.IsMatch(args[1], @"\A[1-9][0-9]{0,2}\z") &&
                Int32.TryParse(args[1], out count) && count <= 256 : args[1].Length <= 2048 &&
                System.Text.RegularExpressions.Regex.IsMatch(args[1], @"\Ahttps?://(?:[a-z0-9*.-]+|\[[a-f0-9:.]+\])(?::[0-9]{1,5})?\z");
            return valid ? String.Format(System.Globalization.CultureInfo.InvariantCulture, value[1], args[1]) : null;
        }
        if (args.Length == 1) return value[0];
        if (value.Length < 2 || !(Browsers.Contains(args[1]) || args[1].Length <= 100 &&
            System.Text.RegularExpressions.Regex.IsMatch(args[1], @"\A[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\z"))) return null;
        return String.Format(System.Globalization.CultureInfo.InvariantCulture, value[1], args[1]);
    }
    internal static int Result(int value)
    {
        // UserConsentVerificationResult: Verified=0, DeviceNotPresent=1, NotConfigured=2, Disabled=3,
        // DeviceBusy=4, RetriesExhausted=5, Canceled=6. Unknown future values never grant.
        return value == 0 ? 0 : value == 6 ? 2 : value == 5 ? 1 : 69;
    }
    internal const int PasswordFallback = 70;
    // Availability policy: unknown and busy states refuse. Only absent/unconfigured/disabled Hello uses a password.
    internal static bool NeedsPassword(int availability) { return availability >= 1 && availability <= 3; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct OsVersion {
        public uint Size, Major, Minor, Build, Platform;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string ServicePack;
    }
    [DllImport("ntdll.dll")] static extern int RtlGetVersion(ref OsVersion version);
    static uint BuildNumber() {
        var version = new OsVersion { Size = (uint)Marshal.SizeOf(typeof(OsVersion)) };
        Marshal.ThrowExceptionForHR(RtlGetVersion(ref version)); return version.Build;
    }
    // 100+enum on success; the ordinary helper exit codes on cancellation/failure.
    static int Await(IntPtr pointer, bool availability, WaitHandle cancelled, Stopwatch clock) {
        object operation = null; IAsyncInfo info = null;
        try {
            operation = Marshal.GetObjectForIUnknown(pointer); info = (IAsyncInfo)operation;
            for (;;) {
                if (cancelled.WaitOne(0)) return 2;
                if (clock.ElapsedMilliseconds >= TimeoutMs) return 3;
                if (!Native.Present()) return 4;
                int status; Marshal.ThrowExceptionForHR(info.GetStatus(out status));
                if (status == 1) {
                    int result;
                    Marshal.ThrowExceptionForHR(availability ? ((IAvailabilityOperation)operation).GetResults(out result) :
                        ((IConsentOperation)operation).GetResults(out result));
                    return clock.ElapsedMilliseconds < TimeoutMs && Native.Present() ? 100 + result : 4;
                }
                if (status == 2) return 2;
                if (status != 0) return 1;
                cancelled.WaitOne(100);
            }
        } finally {
            if (info != null) { try { info.Cancel(); } catch {} try { info.Close(); } catch {} }
            if (operation != null) Marshal.FinalReleaseComObject(operation);
            if (pointer != IntPtr.Zero) Marshal.Release(pointer);
        }
    }
#if PERSON_WINRT_METADATA
    // Optional in-box projection variant. The VM runner selects this at compile time, never by installing a package.
    static int MetadataAvailability(WaitHandle cancelled, Stopwatch clock) {
        var operation = Windows.Security.Credentials.UI.UserConsentVerifier.CheckAvailabilityAsync();
        try {
            while (operation.Status == Windows.Foundation.AsyncStatus.Started) {
                if (cancelled.WaitOne(100)) return 2;
                if (clock.ElapsedMilliseconds >= TimeoutMs) return 3;
                if (!Native.Present()) return 4;
            }
            return operation.Status == Windows.Foundation.AsyncStatus.Completed ? 100 + (int)operation.GetResults() : 69;
        } finally { operation.Cancel(); operation.Close(); }
    }
    static int MetadataRequest(string reason, WaitHandle cancelled, Stopwatch clock) {
        var operation = Windows.Security.Credentials.UI.UserConsentVerifier.RequestVerificationAsync(reason);
        try {
            while (operation.Status == Windows.Foundation.AsyncStatus.Started) {
                if (cancelled.WaitOne(100)) return 2;
                if (clock.ElapsedMilliseconds >= TimeoutMs) return 3;
                if (!Native.Present()) return 4;
            }
            return operation.Status == Windows.Foundation.AsyncStatus.Completed ? Result((int)operation.GetResults()) : 69;
        } finally { operation.Cancel(); operation.Close(); }
    }
#endif
    static int Evaluate(string reason, IntPtr hwnd, WaitHandle cancelled, Stopwatch clock)
    {
        IntPtr className = IntPtr.Zero, message = IntPtr.Zero, factoryPtr = IntPtr.Zero;
        object factory = null; bool initialized = false;
        try {
            Marshal.ThrowExceptionForHR(RoInitialize(1)); initialized = true;
            const string name = "Windows.Security.Credentials.UI.UserConsentVerifier";
            Marshal.ThrowExceptionForHR(WindowsCreateString(name, (uint)name.Length, out className));
            var factoryIid = typeof(IUserConsentVerifierStatics).GUID;
            Marshal.ThrowExceptionForHR(RoGetActivationFactory(className, ref factoryIid, out factoryPtr));
            factory = Marshal.GetObjectForIUnknown(factoryPtr);
            var statics = (IUserConsentVerifierStatics)factory;
            int availability;
#if PERSON_WINRT_METADATA
            availability = MetadataAvailability(cancelled, clock);
#else
            IntPtr availabilityPtr;
            Marshal.ThrowExceptionForHR(statics.CheckAvailabilityAsync(out availabilityPtr));
            availability = Await(availabilityPtr, true, cancelled, clock);
#endif
            if (availability < 100) return availability;
            if (NeedsPassword(availability - 100)) return PasswordFallback;
            if (availability != 100) return 69;
            Marshal.ThrowExceptionForHR(WindowsCreateString(reason, (uint)reason.Length, out message));
            // The static method predates the desktop interop. Try it first on builds below 22000.
            if (BuildNumber() < 22000) {
                try {
#if PERSON_WINRT_METADATA
                    int result = MetadataRequest(reason, cancelled, clock);
#else
                    IntPtr staticPtr;
                    Marshal.ThrowExceptionForHR(statics.RequestVerificationAsync(message, out staticPtr));
                    int value = Await(staticPtr, false, cancelled, clock);
                    int result = value >= 100 ? Result(value - 100) : value;
#endif
                    if (result != 69) return result;
                } catch (COMException) { }
            }
            IntPtr interopPtr = IntPtr.Zero; object interop = null;
            try {
                var interopIid = typeof(IUserConsentVerifierInterop).GUID;
                Marshal.ThrowExceptionForHR(RoGetActivationFactory(className, ref interopIid, out interopPtr));
                interop = Marshal.GetObjectForIUnknown(interopPtr);
                var operationIid = typeof(IConsentOperation).GUID; IntPtr operationPtr;
                Marshal.ThrowExceptionForHR(((IUserConsentVerifierInterop)interop).RequestVerificationForWindowAsync(hwnd, message, ref operationIid, out operationPtr));
                int value = Await(operationPtr, false, cancelled, clock);
                return value >= 100 ? (NeedsPassword(value - 100) ? PasswordFallback : Result(value - 100)) : value;
            } finally {
                if (interop != null) Marshal.ReleaseComObject(interop);
                if (interopPtr != IntPtr.Zero) Marshal.Release(interopPtr);
            }
        }
        catch (COMException error) {
            // Class/interface absent on this Windows build is unavailable Hello. Other failures still refuse.
            return error.ErrorCode == unchecked((int)0x80040154) || error.ErrorCode == unchecked((int)0x80004002) ||
                error.ErrorCode == unchecked((int)0x80004001) ? PasswordFallback : 69;
        }
        catch { return 69; }
        finally {
            if (factory != null) Marshal.ReleaseComObject(factory);
            if (factoryPtr != IntPtr.Zero) Marshal.Release(factoryPtr);
            if (message != IntPtr.Zero) WindowsDeleteString(message);
            if (className != IntPtr.Zero) WindowsDeleteString(className);
            if (initialized) RoUninitialize();
        }
    }
    internal static int Confirm(string reason)
    {
        if (!Native.Present()) return 4;
        IntPtr owner = Native.ConfirmationOwner();
        if (owner == IntPtr.Zero) return 69;
        var cancel = new ManualResetEvent(false);
        var done = new ManualResetEvent(false);
        int result = 69;
        var clock = Stopwatch.StartNew();
        ConsoleCancelEventHandler onCancel = (sender, e) => { e.Cancel = true; cancel.Set(); };
        Console.CancelKeyPress += onCancel;
        var worker = new Thread(() => { try {
            result = Evaluate(reason, owner, cancel, clock);
            if (result == PasswordFallback && !cancel.WaitOne(0) && clock.ElapsedMilliseconds < TimeoutMs && Native.Present())
                result = Password.Confirm(reason, owner, Native.LauncherSid(), cancel, clock);
        } catch { result = 69; } finally { done.Set(); } });
        worker.IsBackground = true; worker.SetApartmentState(ApartmentState.MTA);
        try {
            worker.Start();
            int signalled = WaitHandle.WaitTimeout;
            while (clock.ElapsedMilliseconds < TimeoutMs) {
                signalled = WaitHandle.WaitAny(new WaitHandle[] { done, cancel }, 100);
                if (signalled != WaitHandle.WaitTimeout) break;
                if (!Native.Present()) { cancel.Set(); return 4; }
            }
            if (signalled == 0 && clock.ElapsedMilliseconds < TimeoutMs) return result;
            cancel.Set();
            // A blocked COM call can't hold the short-lived helper open. The background thread dies with this process.
            done.WaitOne(500);
            return signalled == 1 ? 2 : 3;
        } finally { Console.CancelKeyPress -= onCancel; }
    }
}
}
