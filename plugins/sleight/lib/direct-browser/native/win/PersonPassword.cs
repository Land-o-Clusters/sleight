using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.CompilerServices;
using System.Security.Principal;
using System.Threading;

namespace Sleight.Person
{
// CredUI is called only by this short-lived helper. Plaintext stays in explicitly wiped unmanaged buffers.
internal static class Password
{
    internal const uint PromptFlags = 0x200 | 0x10 | 0x1000; // ENUMERATE_CURRENT_USER | AUTHPACKAGE_ONLY | SECURE_PROMPT
    static int attempted;
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct CredInfo { public uint Size; public IntPtr Parent; public string Message, Caption; public IntPtr Banner; }
    [StructLayout(LayoutKind.Sequential)]
    struct LsaString { public ushort Length, MaximumLength; public IntPtr Buffer; }
    [DllImport("secur32.dll")] static extern uint LsaConnectUntrusted(out IntPtr handle);
    [DllImport("secur32.dll")] static extern uint LsaLookupAuthenticationPackage(IntPtr handle, ref LsaString name, out uint package);
    [DllImport("secur32.dll")] static extern uint LsaDeregisterLogonProcess(IntPtr handle);
    [DllImport("credui.dll", CharSet = CharSet.Unicode)]
    static extern uint CredUIPromptForWindowsCredentialsW(ref CredInfo info, uint error, ref uint package,
        IntPtr input, uint inputSize, out IntPtr output, out uint outputSize, IntPtr save, uint flags);
    [DllImport("credui.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredPackAuthenticationBufferW(uint flags, IntPtr user, IntPtr password, IntPtr buffer, ref uint size);
    [DllImport("credui.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredUnPackAuthenticationBufferW(uint flags, IntPtr buffer, uint size,
        IntPtr user, ref uint userSize, IntPtr domain, ref uint domainSize, IntPtr password, ref uint passwordSize);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool LogonUserW(IntPtr user, IntPtr domain, IntPtr password, uint type, uint provider, out IntPtr token);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern bool CredIsMarshaledCredentialW(IntPtr credential);
    // SecureZeroMemory is a C header inline, not a portable DLL export. Explicit Marshal.Copy writes are observable
    // unmanaged effects. Keep this erasure out of inlining/optimization, using a cleared array that never held secrets.
    [MethodImpl(MethodImplOptions.NoInlining | MethodImplOptions.NoOptimization)]
    static void SecureZeroMemory(IntPtr buffer, uint size) {
        var zeros = new byte[4096]; Array.Clear(zeros, 0, zeros.Length);
        for (uint at = 0; at < size; ) {
            int count = (int)Math.Min((uint)zeros.Length, size - at);
            Marshal.Copy(zeros, 0, IntPtr.Add(buffer, checked((int)at)), count); at += (uint)count;
        }
        GC.KeepAlive(zeros);
    }
    internal static void WipeFree(ref IntPtr buffer, uint bytes) {
        if (buffer == IntPtr.Zero) return;
        SecureZeroMemory(buffer, bytes); Marshal.FreeCoTaskMem(buffer); buffer = IntPtr.Zero;
    }
    static IntPtr Allocate(uint bytes) {
        if (bytes == 0 || bytes > 131072) throw new InvalidOperationException();
        IntPtr buffer = Marshal.AllocCoTaskMem((int)bytes); SecureZeroMemory(buffer, bytes); return buffer;
    }
    internal static bool PasswordBuffer(int messageType, bool marshaledUser, bool marshaledPassword, bool blank) {
        // KerbInteractiveLogon=2, KerbWorkstationUnlockLogon=7. Certificate, PIN/NGC, packed identity and unknown blobs refuse.
        return (messageType == 2 || messageType == 7) && !marshaledUser && !marshaledPassword && !blank;
    }
    internal static bool SameUser(string token, string launcher, string own) {
        return !String.IsNullOrEmpty(token) && token == launcher && token == own;
    }
    internal static object SelfTest() {
        IntPtr buffer = Allocate(16); Marshal.WriteInt32(buffer, 12345);
        SecureZeroMemory(buffer, 16); bool zero = true;
        for (int i = 0; i < 16; i++) zero &= Marshal.ReadByte(buffer, i) == 0;
        WipeFree(ref buffer, 16);
        return Native.Map("drawing", false, "attemptLimit", 1, "securePrompt", true, "promptFlags", PromptFlags,
            "zeroed", zero && buffer == IntPtr.Zero, "blankRefused", !PasswordBuffer(2, false, false, true),
            "nonPasswordRefused", !PasswordBuffer(13, false, false, false),
            "sidMismatchRefused", !SameUser("S-1-5-21-1", "S-1-5-21-2", "S-1-5-21-1"));
    }
    static uint NegotiatePackage() {
        IntPtr lsa = IntPtr.Zero, text = Marshal.StringToCoTaskMemAnsi("Negotiate");
        try {
            if (LsaConnectUntrusted(out lsa) != 0) throw new InvalidOperationException();
            var name = new LsaString { Length = 9, MaximumLength = 10, Buffer = text }; uint package;
            if (LsaLookupAuthenticationPackage(lsa, ref name, out package) != 0) throw new InvalidOperationException();
            return package;
        } finally { if (lsa != IntPtr.Zero) LsaDeregisterLogonProcess(lsa); WipeFree(ref text, 10); }
    }
    internal static int Confirm(string reason, IntPtr owner, string launcherSid, WaitHandle cancelled, Stopwatch clock) {
        if (Interlocked.Exchange(ref attempted, 1) != 0) return 1;
        if (cancelled.WaitOne(0)) return 2;
        if (clock.ElapsedMilliseconds >= Hello.TimeoutMs) return 3;
        if (!Native.Present()) return 4;
        IntPtr input = IntPtr.Zero, output = IntPtr.Zero, current = IntPtr.Zero, blank = IntPtr.Zero,
            user = IntPtr.Zero, domain = IntPtr.Zero, password = IntPtr.Zero, token = IntPtr.Zero;
        uint inputSize = 0, outputSize = 0, userBytes = 0, domainBytes = 0, passwordBytes = 0, currentBytes = 0;
        try {
            string ownSid, account;
            using (var identity = WindowsIdentity.GetCurrent()) { ownSid = identity.User.Value; account = identity.Name; }
            if (!SameUser(ownSid, launcherSid, ownSid)) return 1;
            currentBytes = checked((uint)(account.Length + 1) * 2); current = Marshal.StringToCoTaskMemUni(account);
            blank = Allocate(2);
            CredPackAuthenticationBufferW(0, current, blank, IntPtr.Zero, ref inputSize);
            if (Marshal.GetLastWin32Error() != 122 || inputSize == 0) return 69;
            input = Allocate(inputSize);
            if (!CredPackAuthenticationBufferW(0, current, blank, input, ref inputSize)) return 69;
            uint package = NegotiatePackage(), expectedPackage = package;
            var info = new CredInfo { Size = (uint)Marshal.SizeOf(typeof(CredInfo)), Parent = owner,
                Message = reason, Caption = "sleight: confirm with your Windows password" };
            // No retry, no save checkbox, and no insecure-desktop fallback. Only one LogonUser call per process.
            uint code = CredUIPromptForWindowsCredentialsW(ref info, 0, ref package, input, inputSize,
                out output, out outputSize, IntPtr.Zero, PromptFlags);
            if (code == 1223) return 2;
            if (code != 0) return 69;
            if (cancelled.WaitOne(0)) return 2;
            if (clock.ElapsedMilliseconds >= Hello.TimeoutMs) return 3;
            if (!Native.Present()) return 4;
            if (output == IntPtr.Zero || outputSize < 4 || outputSize > 131072 || package != expectedPackage) return 1;
            int messageType = Marshal.ReadInt32(output);
            if (messageType != 2 && messageType != 7) return 1;
            uint nu = 0, nd = 0, np = 0;
            CredUnPackAuthenticationBufferW(1, output, outputSize, IntPtr.Zero, ref nu, IntPtr.Zero, ref nd, IntPtr.Zero, ref np);
            if (Marshal.GetLastWin32Error() != 122 || nu < 2 || np < 2 || nu > 32768 || nd > 32768 || np > 32768) return 1;
            userBytes = nu * 2; domainBytes = Math.Max(1u, nd) * 2; passwordBytes = np * 2;
            user = Allocate(userBytes); domain = Allocate(domainBytes); password = Allocate(passwordBytes);
            nd = Math.Max(1u, nd);
            if (!CredUnPackAuthenticationBufferW(1, output, outputSize, user, ref nu, domain, ref nd, password, ref np)) return 1;
            if (!PasswordBuffer(messageType, CredIsMarshaledCredentialW(user), CredIsMarshaledCredentialW(password), Marshal.ReadInt16(password) == 0)) return 1;
            // INTERACTIVE validates this password locally. NEW_CREDENTIALS would accept an unchecked password and is forbidden.
            if (!LogonUserW(user, Marshal.ReadInt16(domain) == 0 ? IntPtr.Zero : domain, password, 2, 0, out token)) return 1;
            using (var identity = new WindowsIdentity(token)) {
                if (!SameUser(identity.User.Value, launcherSid, ownSid) || Native.LauncherSid() != launcherSid) return 1;
            }
            if (cancelled.WaitOne(0)) return 2;
            if (clock.ElapsedMilliseconds >= Hello.TimeoutMs) return 3;
            return Native.Present() ? 0 : 4;
        } catch { return 69; }
        finally {
            if (token != IntPtr.Zero) Native.CloseHandle(token);
            WipeFree(ref password, passwordBytes); WipeFree(ref user, userBytes); WipeFree(ref domain, domainBytes);
            WipeFree(ref output, outputSize); WipeFree(ref input, inputSize); WipeFree(ref blank, 2); WipeFree(ref current, currentBytes);
        }
    }
}
}
