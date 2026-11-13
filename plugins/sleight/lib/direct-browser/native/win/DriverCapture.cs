using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Linq;
using System.Threading;

namespace Sleight.Driver
{
[StructLayout(LayoutKind.Sequential)]
internal struct DriverRect
{
    internal int Left, Top, Right, Bottom;
    internal bool Valid { get { return Right > Left && Bottom > Top; } }
    internal int[] JsonValue() { return new[] { Left, Top, Right - Left, Bottom - Top }; }
    internal bool Intersects(DriverRect other)
    {
        return Valid && other.Valid && Left < other.Right && other.Left < Right && Top < other.Bottom && other.Top < Bottom;
    }
}
internal sealed class DriverGeometry
{
    [StructLayout(LayoutKind.Sequential)] internal struct Point { internal int X, Y; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct MonitorInfo { internal int Size; internal DriverRect Monitor, Work; internal uint Flags; }
    delegate bool WindowCallback(IntPtr hwnd, IntPtr state);
    delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, ref DriverRect rect, IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorCallback callback, IntPtr state);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out DriverRect rect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out DriverRect rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfoW(IntPtr monitor, ref MonitorInfo info);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out DriverRect value, int size);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr state);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    internal DriverRect Rect;
    internal Point Origin;
    internal int Width, Height, Dpi;
    internal string Exposure = "unknown";
    internal readonly List<int[]> Covers = new List<int[]>();
    internal readonly List<int[]> Monitors = new List<int[]>();
    internal bool Stable(DriverGeometry after)
    {
        return after != null && Origin.X == after.Origin.X && Origin.Y == after.Origin.Y &&
            Width == after.Width && Height == after.Height && Dpi == after.Dpi &&
            Rect.Left == after.Rect.Left && Rect.Top == after.Rect.Top && Rect.Right == after.Rect.Right && Rect.Bottom == after.Rect.Bottom;
    }
    internal Dictionary<string, object> JsonValue()
    {
        return Json.Map("coordinateSpace", "physical-client-pixels", "clientOrigin", new[] { Origin.X, Origin.Y },
            "clientSize", new[] { Width, Height }, "rect", Rect.JsonValue(), "dpi", Dpi,
            "scale", Dpi / 96.0, "exposure", Exposure, "covers", Covers.ToArray(), "monitors", Monitors.ToArray());
    }
    static bool FrameBounds(IntPtr hwnd, out DriverRect rect)
    {
        // DWMWA_EXTENDED_FRAME_BOUNDS excludes invisible resize borders on both sides.
        if (DwmGetWindowAttribute(hwnd, 9, out rect, Marshal.SizeOf(typeof(DriverRect))) == 0 && rect.Valid) return true;
        return GetWindowRect(hwnd, out rect) && rect.Valid;
    }
    internal static DriverGeometry Observe(WindowRecord window)
    {
        var result = new DriverGeometry();
        DriverRect client, bounds;
        var origin = new Point();
        if (!GetClientRect(window.Handle, out client) || !client.Valid || !ClientToScreen(window.Handle, ref origin) ||
            !FrameBounds(window.Handle, out bounds)) throw new DriverFault("GEOMETRY_UNAVAILABLE");
        uint dpi = GetDpiForWindow(window.Handle);
        if (dpi < 48 || dpi > 768) throw new DriverFault("GEOMETRY_UNAVAILABLE");
        result.Rect = bounds; result.Origin = origin; result.Width = client.Right; result.Height = client.Bottom; result.Dpi = (int)dpi;
        bool monitorsComplete = true;
        bool monitorsRead = EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr handle, IntPtr dc, ref DriverRect rect, IntPtr state) {
            if (!rect.Valid || result.Monitors.Count >= 32) { monitorsComplete = false; return false; }
            result.Monitors.Add(rect.JsonValue()); return true;
        }, IntPtr.Zero);
        if (!monitorsRead || !monitorsComplete || result.Monitors.Count == 0) return result;
        if (window.Minimized) { result.Exposure = "minimized"; return result; }
        if (window.Cloaked || window.OnCurrentDesktop == false) { result.Exposure = "other-space"; return result; }
        IntPtr monitor = MonitorFromWindow(window.Handle, 0); // No nearest-monitor guess for an offscreen window.
        var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
        if (monitor == IntPtr.Zero) { result.Exposure = "offscreen"; return result; }
        if (!GetMonitorInfoW(monitor, ref info) || !IsWindowVisible(window.Handle)) return result;
        bool found = false, complete = true;
        int visited = 0;
        bool enumerated = EnumWindows((hwnd, state) => {
            if (hwnd == window.Handle) { found = true; return false; }
            if (++visited > 4096) { complete = false; return false; }
            try {
                if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return true;
                int cloaked;
                if (DwmGetWindowAttribute(hwnd, 14, out cloaked, sizeof(int)) != 0) { complete = false; return false; }
                if (cloaked != 0) return true;
                DriverRect rect;
                if (!FrameBounds(hwnd, out rect)) {
                    complete = false; return false;
                }
                // Include overlays and tool windows. There is no renderer PID exemption.
                if (rect.Intersects(bounds)) result.Covers.Add(rect.JsonValue());
            } catch { complete = false; return false; }
            return true;
        }, IntPtr.Zero);
        if (complete && found && !enumerated) result.Exposure = result.Covers.Count == 0 ? "exposed" : "covered";
        return result;
    }
}

// The worker has no windows. Its thread uses physical coordinates for inventory, UIA and capture.
internal sealed class DriverDpiScope : IDisposable
{
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    readonly IntPtr previous;
    internal DriverDpiScope()
    {
        previous = SetThreadDpiAwarenessContext(new IntPtr(-4)); // PER_MONITOR_AWARE_V2
        if (previous == IntPtr.Zero) throw new DriverFault("DPI_UNAVAILABLE");
    }
    public void Dispose() { SetThreadDpiAwarenessContext(previous); }
}

internal sealed class DriverFrame
{
    internal readonly int Width, Height;
    internal readonly byte[] Pixels;
    internal DriverFrame(int width, int height, byte[] pixels) { Width = width; Height = height; Pixels = pixels; }
    internal bool HasColor()
    {
        int stride = DriverCapture.Stride(Width, Height);
        if (Pixels == null || Pixels.Length != stride * Height) throw new DriverFault("CAPTURE_UNAVAILABLE");
        for (int i = 0; i < Pixels.Length; i += 4) if (Pixels[i] != 0 || Pixels[i + 1] != 0 || Pixels[i + 2] != 0) return true;
        return false;
    }
}
internal sealed class DriverCaptureChoice
{
    internal DriverFrame Frame;
    internal string Method = "none";
    internal readonly List<Dictionary<string, object>> Attempts = new List<Dictionary<string, object>>();
}
internal static class DriverCapture
{
    internal static readonly string[] Routes = new[] { "PrintWindow", "Windows.Graphics.Capture", "BitBlt" };
    internal const int MaxSide = 8192, PixelLimit = 16 * 1024 * 1024, PngLimit = 4 * 1024 * 1024;
    internal const uint PrintFlags = 1 | 2; // PW_CLIENTONLY | PW_RENDERFULLCONTENT (0x2 is an SDK flag).
    [StructLayout(LayoutKind.Sequential)]
    struct BitmapInfo
    {
        internal uint Size;
        internal int Width, Height;
        internal ushort Planes, BitCount;
        internal uint Compression, SizeImage;
        internal int XPelsPerMeter, YPelsPerMeter;
        internal uint ClrUsed, ClrImportant, Color;
    }
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfo info, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr bitmap);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr value);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool GdiFlush();
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr destination, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, uint operation);
    internal static int Stride(int width, int height)
    {
        if (width < 1 || height < 1 || width > MaxSide || height > MaxSide || (long)width * height > PixelLimit)
            throw new DriverFault("CAPTURE_LIMIT");
        return checked(width * 4);
    }
    internal static Dictionary<string, object> Note(string status)
    {
        string text;
        switch (status) {
        case "minimized": text = "Screenshot unavailable: the window is minimized. Restore it before capturing."; break;
        case "cloaked": text = "Screenshot unavailable: the window is cloaked or on another virtual desktop."; break;
        case "black": text = "Screenshot contains only black pixels. The app may not support background capture."; break;
        default: status = "failed"; text = "Screenshot unavailable: all window capture routes failed."; break;
        }
        return Json.Map("status", status, "method", "none", "note", text);
    }
    internal static Dictionary<string, object> CaptureForRead(WindowRecord window)
    {
        return CaptureForRead(() => Capture(window), () => DriverIdentity.Verify(window, DriverInventory.Observe(window.Handle)));
    }
    internal static Dictionary<string, object> CaptureForRead(Func<Dictionary<string, object>> capture, Func<WindowRecord> verify)
    {
        try { return capture(); }
        catch (DriverFault error) {
            if (error.Code != "CAPTURE_LIMIT" && error.Code != "CAPTURE_UNAVAILABLE" && error.Code != "GEOMETRY_CHANGED") throw;
            // Capture may have failed before its final identity check. Never return a
            // successful tree if the main window changed while capture was failing.
            var after = verify();
            var note = Note("failed");
            note["code"] = error.Code;
            note["note"] = "Screenshot unavailable: " + error.Code + ".";
            return Json.Map("window", after.JsonValue(), "capture", note);
        }
    }
    // Save() can otherwise grow an unbounded MemoryStream before the final response limit.
    sealed class PngStream : MemoryStream
    {
        public override void Write(byte[] bytes, int offset, int count)
        {
            if (count < 0 || Position + count > PngLimit) throw new DriverFault("CAPTURE_LIMIT");
            base.Write(bytes, offset, count);
        }
        public override void WriteByte(byte value)
        {
            if (Position >= PngLimit) throw new DriverFault("CAPTURE_LIMIT");
            base.WriteByte(value);
        }
        public override void SetLength(long value)
        {
            if (value > PngLimit) throw new DriverFault("CAPTURE_LIMIT");
            base.SetLength(value);
        }
    }
    internal static byte[] EncodePng(IntPtr bits, int width, int height)
    {
        int stride = Stride(width, height);
        if (bits == IntPtr.Zero) throw new DriverFault("CAPTURE_UNAVAILABLE");
        using (var image = new Bitmap(width, height, stride, PixelFormat.Format32bppRgb, bits))
        using (var output = new PngStream()) { image.Save(output, ImageFormat.Png); return output.ToArray(); }
    }
    internal static DriverCaptureChoice CaptureChain(Func<string, DriverFrame> capture)
    {
        var result = new DriverCaptureChoice();
        foreach (string route in Routes) {
            string status = "failed", reason = null;
            DriverFrame frame = null;
            try {
                frame = capture(route);
                if (frame != null) status = frame.HasColor() ? "ok" : "black";
            } catch (DriverFault e) {
                if (e.Code != "CAPTURE_UNAVAILABLE") throw;
                reason = e.Message;
            } catch (COMException) { reason = "capture API unavailable"; }
              catch (InvalidCastException) { reason = "capture interface unavailable"; }
              catch (NotSupportedException) { reason = "capture API unsupported"; }
              catch (NotImplementedException) { reason = "capture API not implemented"; }
              catch (DllNotFoundException) { reason = "capture API not installed"; }
              catch (EntryPointNotFoundException) { reason = "capture API not supported by this Windows version"; }
            result.Attempts.Add(Json.Map("method", route, "status", status, "reason", reason));
            if (status == "ok") { result.Frame = frame; result.Method = route; return result; }
        }
        return result;
    }
    internal static bool ScreenCopyAllowed(DriverGeometry geometry)
    {
        if (geometry == null || geometry.Exposure != "exposed" || geometry.Covers.Count != 0) return false;
        return geometry.Monitors.Any(m => geometry.Origin.X >= m[0] && geometry.Origin.Y >= m[1] &&
            (long)geometry.Origin.X + geometry.Width <= (long)m[0] + m[2] &&
            (long)geometry.Origin.Y + geometry.Height <= (long)m[1] + m[3]);
    }
    static DriverFrame GdiFrame(WindowRecord window, DriverGeometry geometry, bool screen)
    {
        int stride = Stride(geometry.Width, geometry.Height);
        IntPtr dc = IntPtr.Zero, source = IntPtr.Zero, dib = IntPtr.Zero, previous = IntPtr.Zero, bits = IntPtr.Zero;
        try {
            if (screen && !ScreenCopyAllowed(geometry)) throw new DriverFault("CAPTURE_UNAVAILABLE", "BitBlt requires a fully exposed window; covered or uncertain pixels are withheld");
            dc = CreateCompatibleDC(IntPtr.Zero);
            if (dc == IntPtr.Zero) throw new DriverFault("CAPTURE_UNAVAILABLE");
            var info = new BitmapInfo { Size = 40, Width = geometry.Width, Height = -geometry.Height,
                Planes = 1, BitCount = 32, Compression = 0, SizeImage = (uint)(stride * geometry.Height) };
            dib = CreateDIBSection(dc, ref info, 0, out bits, IntPtr.Zero, 0);
            if (dib == IntPtr.Zero || bits == IntPtr.Zero) throw new DriverFault("CAPTURE_UNAVAILABLE");
            previous = SelectObject(dc, dib);
            if (previous == IntPtr.Zero || previous == new IntPtr(-1)) throw new DriverFault("CAPTURE_UNAVAILABLE");
            var pixels = new byte[stride * geometry.Height];
            Marshal.Copy(pixels, 0, bits, pixels.Length); // No uninitialized pixels on partial paints.
            bool ok;
            if (screen) {
                // A window client DC, never a desktop DC. Coordinates stay client-relative.
                source = GetDC(window.Handle);
                ok = source != IntPtr.Zero && BitBlt(dc, 0, 0, geometry.Width, geometry.Height, source, 0, 0, 0x00cc0020);
            } else ok = PrintWindow(window.Handle, dc, PrintFlags);
            if (!ok || !GdiFlush()) return null;
            Marshal.Copy(bits, pixels, 0, pixels.Length);
            return new DriverFrame(geometry.Width, geometry.Height, pixels);
        } finally {
            if (source != IntPtr.Zero) ReleaseDC(window.Handle, source);
            if (previous != IntPtr.Zero && previous != new IntPtr(-1) && dc != IntPtr.Zero) SelectObject(dc, previous);
            if (dib != IntPtr.Zero) DeleteObject(dib);
            if (dc != IntPtr.Zero) DeleteDC(dc);
        }
    }
    static WindowRecord VerifySurface(WindowRecord before, DriverGeometry geometry, bool screen)
    {
        DriverSession.Require();
        var after = DriverIdentity.Verify(before, DriverInventory.Observe(before.Handle));
        var observed = DriverGeometry.Observe(after);
        if (after.Minimized || after.Cloaked || after.OnCurrentDesktop == false || !geometry.Stable(observed))
            throw new DriverFault("GEOMETRY_CHANGED");
        if (screen && !ScreenCopyAllowed(observed)) throw new DriverFault("CAPTURE_UNAVAILABLE", "window exposure changed during BitBlt; pixels withheld");
        DriverInput.EnsureNotCancelled();
        return after;
    }
    internal static Dictionary<string, object> Capture(WindowRecord window)
    {
        DriverSession.Require();
        window.RequireReadable();
        var before = DriverIdentity.Verify(window, DriverInventory.Observe(window.Handle));
        if (before.Minimized || before.Cloaked || before.OnCurrentDesktop == false) {
            DriverIdentity.Verify(before, DriverInventory.Observe(before.Handle));
            return Json.Map("window", before.JsonValue(), "capture", Note(before.Minimized ? "minimized" : "cloaked"));
        }
        var geometry = DriverGeometry.Observe(before);
        Stride(geometry.Width, geometry.Height);
        var choice = CaptureChain(route => {
            bool screen = route == "BitBlt";
            VerifySurface(before, geometry, screen);
            DriverOperationCounters.Mark(DriverOperationCounters.Kind.Capture);
            DriverFrame frame = route == "Windows.Graphics.Capture" ? DriverWgc.Capture(before, geometry) : GdiFrame(before, geometry, screen);
            VerifySurface(before, geometry, screen);
            return frame;
        });
        var after = VerifySurface(before, geometry, choice.Method == "BitBlt");
        var capture = choice.Frame == null ? Note(choice.Attempts.All(a => (string)a["status"] == "black") ? "black" : "failed") :
            Json.Map("status", "ok", "method", choice.Method, "width", geometry.Width, "height", geometry.Height,
                "dpi", geometry.Dpi, "scale", geometry.Dpi / 96.0, "coordinateSpace", "physical-client-pixels");
        capture["attempts"] = choice.Attempts.ToArray();
        if (choice.Method == "BitBlt") capture["note"] = "Copy from the target HWND client DC; exposure checks passed before and after capture.";
        if (choice.Method == "PrintWindow") capture["note"] = "PrintWindow returned nonzero RGB pixels; complete painting is unverified.";
        var result = Json.Map("window", after.JsonValue(), "geometry", geometry.JsonValue(), "capture", capture);
        if (choice.Frame != null) {
            var pin = GCHandle.Alloc(choice.Frame.Pixels, GCHandleType.Pinned);
            try {
                byte[] png = EncodePng(pin.AddrOfPinnedObject(), geometry.Width, geometry.Height);
                result.Add("screenshot", Json.Map("mimeType", "image/png", "data", Convert.ToBase64String(png)));
            } finally { pin.Free(); }
        }
        return result;
    }
}
}

namespace Sleight.Driver
{
// COM ABI only, so the in-box C# 5 compiler needs neither a Windows SDK nor WinRT projection assemblies.
// Interface identities and slots follow Microsoft's Windows metadata and d3d11.h.
[StructLayout(LayoutKind.Sequential)] internal struct WgcSize { internal int Width, Height; }
[StructLayout(LayoutKind.Sequential)] internal struct WgcTextureDesc {
    internal uint Width, Height, Mips, ArraySize, Format, SampleCount, SampleQuality, Usage, Bind, CpuAccess, Misc;
}
[StructLayout(LayoutKind.Sequential)] internal struct WgcMapped { internal IntPtr Data; internal uint RowPitch, DepthPitch; }
[ComImport, Guid("3628e81b-3cac-4c60-b7f4-23ce0e0c3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IWgcItemInterop {
    void CreateForWindow(IntPtr window, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IWgcItem item);
}
[ComImport, Guid("79c3f95b-31f7-4ec2-a464-632ef5d30760"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IWgcItem {
    void GetIids(); void GetRuntimeClassName(); void GetTrustLevel(); void DisplayName();
    void Size(out WgcSize size);
}
[ComImport, Guid("589b103f-6bbc-5df5-a991-02e28b3b66d5"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IWgcPoolFactory {
    void GetIids(); void GetRuntimeClassName(); void GetTrustLevel();
    void CreateFreeThreaded(IntPtr device, int format, int buffers, WgcSize size, out IWgcPool pool);
}
[ComImport, Guid("24eb6d22-1975-422e-82e7-780dbd8ddf24"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IWgcPool {
    void GetIids(); void GetRuntimeClassName(); void GetTrustLevel(); void Recreate();
    void TryGetNextFrame(out IWgcFrame frame);
    void FrameArrived(); void RemoveFrameArrived();
    void CreateCaptureSession(IWgcItem item, out IWgcSession session);
}
[ComImport, Guid("814e42a9-f70f-4ad7-939b-fddcc6eb880d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IWgcSession {
    void GetIids(); void GetRuntimeClassName(); void GetTrustLevel(); void StartCapture();
}
[ComImport, Guid("2c39ae40-7d2e-5044-804e-8b6799d4cf9e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IWgcCursor {
    void GetIids(); void GetRuntimeClassName(); void GetTrustLevel(); void GetCursorEnabled();
    void SetCursorEnabled([MarshalAs(UnmanagedType.U1)] bool enabled);
}
[ComImport, Guid("fa50c623-38da-4b32-acf3-fa9734ad800e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IWgcFrame {
    void GetIids(); void GetRuntimeClassName(); void GetTrustLevel();
    void Surface([MarshalAs(UnmanagedType.IUnknown)] out object surface);
    void SystemRelativeTime(); void ContentSize(out WgcSize size);
}
[ComImport, Guid("30d5a829-7fa4-4026-83bb-d75bae4ea99e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IWgcClosable {
    void GetIids(); void GetRuntimeClassName(); void GetTrustLevel(); void Close();
}
[ComImport, Guid("a9b3d012-3df2-4ee3-b8d1-8695f457d3c1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IWgcDxgiAccess { void GetInterface(ref Guid iid, out IntPtr result); }
[ComImport, Guid("db6f6ddb-ac77-4e88-8253-819df9bbf140"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IWgcDevice {
    void CreateBuffer(); void CreateTexture1D();
    void CreateTexture2D(ref WgcTextureDesc description, IntPtr data, out IWgcTexture texture);
}
[ComImport, Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IWgcTexture {
    void GetDevice(); void GetPrivateData(); void SetPrivateData(); void SetPrivateDataInterface();
    void GetResourceType(); void SetEvictionPriority(); void GetEvictionPriority();
    [PreserveSig] void GetDesc(out WgcTextureDesc description);
}
[ComImport, Guid("c0bfa96c-e089-44fb-8eaf-26f8796190da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IWgcContext {
    void GetDevice(); void GetPrivateData(); void SetPrivateData(); void SetPrivateDataInterface();
    void VSSetConstantBuffers(); void PSSetShaderResources(); void PSSetShader(); void PSSetSamplers();
    void VSSetShader(); void DrawIndexed(); void Draw();
    [PreserveSig] int Map(IWgcTexture resource, uint subresource, uint type, uint flags, out WgcMapped mapped);
    [PreserveSig] void Unmap(IWgcTexture resource, uint subresource);
    void PSSetConstantBuffers(); void IASetInputLayout(); void IASetVertexBuffers(); void IASetIndexBuffer();
    void DrawIndexedInstanced(); void DrawInstanced(); void GSSetConstantBuffers(); void GSSetShader();
    void IASetPrimitiveTopology(); void VSSetShaderResources(); void VSSetSamplers(); void Begin(); void End();
    void GetData(); void SetPredication(); void GSSetShaderResources(); void GSSetSamplers(); void OMSetRenderTargets();
    void OMSetRenderTargetsAndUnorderedAccessViews(); void OMSetBlendState(); void OMSetDepthStencilState();
    void SOSetTargets(); void DrawAuto(); void DrawIndexedInstancedIndirect(); void DrawInstancedIndirect();
    void Dispatch(); void DispatchIndirect(); void RSSetState(); void RSSetViewports(); void RSSetScissorRects();
    void CopySubresourceRegion();
    [PreserveSig] void CopyResource(IWgcTexture destination, IWgcTexture source);
}
internal static class DriverWgc
{
    [DllImport("combase.dll")] static extern int RoInitialize(uint type);
    [DllImport("combase.dll")] static extern void RoUninitialize();
    [DllImport("combase.dll", CharSet = CharSet.Unicode)] static extern int WindowsCreateString(string value, uint length, out IntPtr text);
    [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr text);
    [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr name, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object factory);
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, uint driver, IntPtr software, uint flags,
        IntPtr levels, uint count, uint sdk, out IWgcDevice device, out int level, out IWgcContext context);
    [DllImport("d3d11.dll")] static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgi, out IntPtr device);
    static void Hr(int result) {
        if (result < 0) throw new DriverFault("CAPTURE_UNAVAILABLE", "Windows.Graphics.Capture API failed: 0x" + unchecked((uint)result).ToString("x8"));
    }
    static object Factory(string name, Guid iid)
    {
        IntPtr text = IntPtr.Zero;
        try { Hr(WindowsCreateString(name, (uint)name.Length, out text)); object value; Hr(RoGetActivationFactory(text, ref iid, out value)); return value; }
        finally { if (text != IntPtr.Zero) WindowsDeleteString(text); }
    }
    static void Release(object value, bool close = false)
    {
        if (value == null) return;
        try { if (close) ((IWgcClosable)value).Close(); }
        catch (COMException) { }
        finally { if (Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); }
    }
    static void Check(long until)
    {
        DriverInput.EnsureNotCancelled();
        if (Driver.Now() >= until) throw new DriverFault("CAPTURE_UNAVAILABLE", "Windows.Graphics.Capture frame deadline expired");
    }
    internal static DriverFrame Capture(WindowRecord window, DriverGeometry geometry)
    {
        int initialized = RoInitialize(1); Hr(initialized); // Same MTA as the driver worker.
        object itemFactory = null, poolFactory = null, surface = null;
        IWgcItem item = null; IWgcDevice device = null; IWgcContext context = null;
        IWgcPool pool = null; IWgcSession session = null; IWgcFrame frame = null;
        IWgcTexture texture = null, staging = null;
        IntPtr unknown = IntPtr.Zero, dxgi = IntPtr.Zero, winDevice = IntPtr.Zero, nativeTexture = IntPtr.Zero;
        bool mapped = false;
        try {
            long until = Driver.Now() + 750;
            itemFactory = Factory("Windows.Graphics.Capture.GraphicsCaptureItem", typeof(IWgcItemInterop).GUID);
            Guid itemId = typeof(IWgcItem).GUID;
            ((IWgcItemInterop)itemFactory).CreateForWindow(window.Handle, ref itemId, out item);
            WgcSize size; item.Size(out size);
            DriverCapture.Stride(size.Width, size.Height);
            // WGC supplies the visible DWM frame. Refuse an unknown origin instead of guessing a border offset.
            if (size.Width != geometry.Rect.Right - geometry.Rect.Left || size.Height != geometry.Rect.Bottom - geometry.Rect.Top)
                throw new DriverFault("CAPTURE_UNAVAILABLE", "WGC frame bounds do not match the observed DWM frame");
            int level;
            Hr(D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out device, out level, out context));
            unknown = Marshal.GetIUnknownForObject(device);
            Guid dxgiId = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
            Hr(Marshal.QueryInterface(unknown, ref dxgiId, out dxgi));
            Hr(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out winDevice));
            poolFactory = Factory("Windows.Graphics.Capture.Direct3D11CaptureFramePool", typeof(IWgcPoolFactory).GUID);
            ((IWgcPoolFactory)poolFactory).CreateFreeThreaded(winDevice, 87, 1, size, out pool); // BGRA8 UNORM
            pool.CreateCaptureSession(item, out session);
            try { ((IWgcCursor)session).SetCursorEnabled(false); } catch (InvalidCastException) { }
            session.StartCapture();
            while (frame == null) { Check(until); pool.TryGetNextFrame(out frame); if (frame == null) Thread.Sleep(10); }
            WgcSize content; frame.ContentSize(out content);
            if (content.Width != size.Width || content.Height != size.Height) throw new DriverFault("GEOMETRY_CHANGED");
            frame.Surface(out surface);
            Guid textureId = typeof(IWgcTexture).GUID;
            ((IWgcDxgiAccess)surface).GetInterface(ref textureId, out nativeTexture);
            texture = (IWgcTexture)Marshal.GetObjectForIUnknown(nativeTexture);
            WgcTextureDesc desc; texture.GetDesc(out desc);
            DriverCapture.Stride(checked((int)desc.Width), checked((int)desc.Height));
            if (desc.Width < size.Width || desc.Height < size.Height || desc.Format != 87 || desc.SampleCount != 1 || desc.ArraySize != 1 || desc.Mips != 1)
                throw new DriverFault("CAPTURE_UNAVAILABLE", "WGC texture format or dimensions are unsupported");
            desc.Usage = 3; desc.Bind = 0; desc.CpuAccess = 0x20000; desc.Misc = 0;
            device.CreateTexture2D(ref desc, IntPtr.Zero, out staging);
            context.CopyResource(staging, texture);
            WgcMapped pixels;
            for (;;) {
                Check(until);
                int status = context.Map(staging, 0, 1, 0x100000, out pixels); // READ | DO_NOT_WAIT
                if (status == unchecked((int)0x887a000a)) { Thread.Sleep(10); continue; }
                Hr(status); mapped = true; break;
            }
            int x = geometry.Origin.X - geometry.Rect.Left, y = geometry.Origin.Y - geometry.Rect.Top;
            if (x < 0 || y < 0 || x + geometry.Width > size.Width || y + geometry.Height > size.Height || pixels.Data == IntPtr.Zero ||
                pixels.RowPitch < desc.Width * 4 || (long)pixels.RowPitch * desc.Height > Int32.MaxValue)
                throw new DriverFault("CAPTURE_UNAVAILABLE", "WGC client crop is outside the frame");
            int stride = DriverCapture.Stride(geometry.Width, geometry.Height);
            var result = new byte[stride * geometry.Height];
            for (int row = 0; row < geometry.Height; row++) {
                Check(until);
                Marshal.Copy(IntPtr.Add(pixels.Data, checked((int)((long)(row + y) * pixels.RowPitch + x * 4))), result, row * stride, stride);
            }
            return new DriverFrame(geometry.Width, geometry.Height, result);
        } finally {
            if (mapped) context.Unmap(staging, 0);
            Release(staging); Release(texture);
            if (nativeTexture != IntPtr.Zero) Marshal.Release(nativeTexture);
            Release(surface); Release(frame, true); Release(session, true); Release(pool, true);
            Release(poolFactory); Release(item); Release(itemFactory);
            if (winDevice != IntPtr.Zero) Marshal.Release(winDevice);
            if (dxgi != IntPtr.Zero) Marshal.Release(dxgi);
            if (unknown != IntPtr.Zero) Marshal.Release(unknown);
            Release(context); Release(device);
            RoUninitialize();
        }
    }
}
}
