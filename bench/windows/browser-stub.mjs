// Harness window used where a renamed browser cannot show one. The product
// policy is unchanged. Inventory fields come from the driver read.
import { win32 } from 'node:path';
import { matchBlockedWindowsApp, forbiddenWindowsTarget } from '../../plugins/sleight/lib/blocked-apps-windows.mjs';
import { createWindowsSafety } from '../../plugins/sleight/lib/windows-driver/safety.mjs';

export const STUB_TITLE = 'Sleight UC3F browser stub';
export const STUB_CLASS = 'SleightUc3fBrowserStub';
export const METADATA_STUB = 'uc3f-metadata-stub.exe';
export const NEUTRAL_STUB = 'uc3f-neutral-stub.exe';
export const NEUTRAL_VERSION = Object.freeze({
  originalFilename: NEUTRAL_STUB,
  productName: 'Sleight UC3F stub',
  companyName: 'Sleight harness',
  fileDescription: 'Sleight UC3F neutral window',
});
const fail = code => { throw Object.assign(Error(code), { code }); };
const browserFields = ['image', 'originalFilename', 'productName'];

export function browserMatchFields(window, match = matchBlockedWindowsApp) {
  return browserFields.filter(field => {
    const value = window?.[field];
    return typeof value === 'string' && value.length > 0 && match({ [field]: value })?.browser === true;
  });
}

export function qualifyMetadataStub(window, source, match = matchBlockedWindowsApp) {
  const refusal = forbiddenWindowsTarget(window);
  if (refusal?.code !== 'BROWSER_TARGET_REFUSED') fail('BROWSER_REFUSAL_UNPROVED');
  const matched = browserMatchFields(window, match).filter(field => field !== 'image');
  if (!matched.length) fail('BROWSER_REFUSAL_UNPROVED');
  for (const field of matched) if (window[field] !== source?.[field]) fail('STUB_METADATA_MISMATCH');
  if (win32.basename(window.image ?? '').toLowerCase() === 'msedge.exe') fail('BROWSER_REFUSAL_UNPROVED');
  return { code: 'BROWSER_TARGET_REFUSED', matchedFields: matched };
}

export function qualifyNeutralStub(window) {
  if (matchBlockedWindowsApp(window)?.browser === true || window?.refused === 'BROWSER_TARGET_REFUSED') fail('NEUTRAL_STUB_REFUSED');
  if (window?.originalFilename !== NEUTRAL_VERSION.originalFilename || window?.productName !== NEUTRAL_VERSION.productName) fail('NEUTRAL_STUB_MISMATCH');
  return { code: 'OK', browser: false };
}

// The product's getApp read, on the driver's inventory. A direct matcher result is not a pass.
export async function productBrowserRefusal(window, driver) {
  if (typeof driver?.request !== 'function' || typeof window?.windowId !== 'string') fail('PRODUCT_REFUSAL_REQUIRED');
  const methods = [];
  const safety = createWindowsSafety({
    driver: { request: async (method, params) => {
      if (method !== 'getState') fail('PRODUCT_READ_ONLY');
      methods.push(method);
      return driver.request(method, params ?? {});
    } },
    lease: { acquire: () => 'uc3f-stub', renew() {}, release() {}, close() {} },
    approve: async () => false,
  });
  try {
    await safety.request('getApp', { selector: { windowId: window.windowId } });
    return { code: 'ADMITTED', methods };
  } catch (error) {
    return { code: error.code || 'PRODUCT_REFUSAL_UNPROVED', methods };
  }
}

// Both windows have to be up. Launch alone is not a pass.
export async function qualifyRenamedStubs({ metadataWindow, neutralWindow, source, launched, driver } = {}) {
  if (launched !== true) fail('FIXTURE_LAUNCH_UNPROVED');
  const metadataRefusal = await productBrowserRefusal(metadataWindow, driver);
  if (metadataRefusal.code !== 'BROWSER_TARGET_REFUSED' || !metadataRefusal.methods.includes('getState')) fail('BROWSER_REFUSAL_UNPROVED');
  const neutralRefusal = await productBrowserRefusal(neutralWindow, driver);
  if (neutralRefusal.code !== 'APP_DECLINED' || !neutralRefusal.methods.includes('getState')) fail('NEUTRAL_STUB_UNPROVED');
  return {
    metadata: qualifyMetadataStub(metadataWindow, source),
    neutral: qualifyNeutralStub(neutralWindow),
    product: { metadata: metadataRefusal.code, neutral: neutralRefusal.code },
  };
}

export const STUB_SOURCE = `using System;
using System.Runtime.InteropServices;
public static class Uc3fStubMain {
  const string Title = "${STUB_TITLE}";
  const string ClassName = "${STUB_CLASS}";
  const uint WM_DESTROY = 2;
  delegate IntPtr WndProc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  static WndProc callback;
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct WNDCLASS {
    public uint style;
    public WndProc lpfnWndProc;
    public int cbClsExtra;
    public int cbWndExtra;
    public IntPtr hInstance;
    public IntPtr hIcon;
    public IntPtr hCursor;
    public IntPtr hbrBackground;
    public string lpszMenuName;
    public string lpszClassName;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct MSG {
    public IntPtr hwnd;
    public uint message;
    public IntPtr wParam;
    public IntPtr lParam;
    public uint time;
    public int x;
    public int y;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern ushort RegisterClassW(ref WNDCLASS wc);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint ex, string cls, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] static extern int GetMessageW(out MSG message, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG message);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG message);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr DefWindowProcW(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] static extern void PostQuitMessage(int code);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);
  static IntPtr Proc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam) {
    if (message == WM_DESTROY) { PostQuitMessage(0); return IntPtr.Zero; }
    return DefWindowProcW(hwnd, message, wParam, lParam);
  }
  public static void Main() {
    callback = new WndProc(Proc);
    IntPtr instance = GetModuleHandleW(null);
    WNDCLASS wc = new WNDCLASS();
    wc.lpfnWndProc = callback;
    wc.hInstance = instance;
    wc.hbrBackground = (IntPtr)6;
    wc.lpszClassName = ClassName;
    if (RegisterClassW(ref wc) == 0) Environment.Exit(2);
    IntPtr hwnd = CreateWindowExW(0, ClassName, Title, 0x10CF0000, 40, 40, 480, 240, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
    if (hwnd == IntPtr.Zero) Environment.Exit(3);
    ShowWindow(hwnd, 5);
    MSG message;
    while (GetMessageW(out message, IntPtr.Zero, 0, 0) > 0) {
      TranslateMessage(ref message);
      DispatchMessageW(ref message);
    }
  }
}
`;
