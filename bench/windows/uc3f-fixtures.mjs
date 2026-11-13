// Guest fixture launch, binding and native metadata reads. Snapshot restore owns fixture teardown.
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT } from './kit.mjs';
import { runGuestChild as runChild } from './guest-child.mjs';
import { guestCommandOutput } from './guest-stdin.mjs';
import { directReply } from './uc3f-diagnostics.mjs';
import * as sitting from './driver-sitting.mjs';
import { windowBinding } from '../../plugins/sleight/lib/windows-repl/identity.mjs';
import { windowsHostExecutable } from '../../plugins/sleight/lib/direct-browser/windows-host.mjs';
import { TYPING_DIAGNOSTIC } from './typing-diagnostic.mjs';
import { projectReply, rowFilePrefix, checkBank } from './uc3f-collect.mjs';
const fail = code => { throw Object.assign(Error(code), { code }); };
const uint = n => Number.isSafeInteger(n) && n >= 0;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const delay = ms => new Promise(done => setTimeout(done, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function proveFixtureLaunch(proof, { target, token }) {
  if (proof?.activation) return proof.refusalOnly ? proveRefusedCalculator(proof, { token: token }) : proveActivatedFixture(proof, { target, token: token });
  const birth = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
  const pid = value => Number.isSafeInteger(value) && value > 0;
  const sameImage = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  const launcher = proof?.launcher;
  if (!pid(launcher?.pid) || !birth(launcher.processStart) || !birth(launcher.observedEnd) ||
      BigInt(launcher.observedEnd) < BigInt(launcher.processStart)) fail('FIXTURE_LAUNCH_UNPROVED');
  const windows = proof?.windows?.filter(w => {
    if (!pid(w?.pid) || !birth(w.processStart) || !sameImage(w.image, proof.expectedImage)) return false;
    if (target === 'wpf' && (w.title !== 'Sleight WDR7 WPF' || !w.className?.startsWith('HwndWrapper['))) return false;
    if (['metadata-stub', 'neutral-stub'].includes(target) && (w.title !== 'Sleight UC3F browser stub' || w.className !== 'SleightUc3fBrowserStub')) return false;
    const direct = w.pid === launcher.pid && w.processStart === launcher.processStart && sameImage(w.image, launcher.image);
    const child = w.pid !== launcher.pid && w.parentPid === launcher.pid && BigInt(w.processStart) >= BigInt(launcher.processStart) &&
      BigInt(w.processStart) <= BigInt(launcher.observedEnd);
    return (direct || child) && (direct && ['calculator', 'cover', 'wpf', 'metadata-stub', 'neutral-stub'].includes(target) ||
      typeof w.title === 'string' && (target === 'notepad' ? w.title.replace(/^\*/, '') === `driver-notepad.txt-${token}.txt - Notepad` : w.title.includes(token)));
  });
  if (!Array.isArray(windows) || windows.length !== 1) fail('FIXTURE_LAUNCH_UNPROVED');
  const fixture = windows[0];
  if (!uint(fixture.pid) || !/^[1-9][0-9]*$/.test(fixture.processStart ?? '') ||
      !/^[1-9][0-9]*$/.test(fixture.windowId ?? '') || !win32.isAbsolute(fixture.image ?? '') ||
      fixture.image.toLowerCase() !== proof.expectedImage?.toLowerCase()) fail('FIXTURE_LAUNCH_UNPROVED');
  return { ...fixture, target, ...(proof.activation && { activation: proof.activation }), ...(proof.refusalOnly && { refusalOnly: true, refused: 'HOSTED_APP_UNRESOLVED', activationSince: proof.activationSince, baselineWindows: proof.baselineWindows }) };
}

export function bindRefusedFixture(receipt, window, native, target) {
  if (!['cover', 'terminal'].includes(target) || window?.refused !== 'FORBIDDEN_TARGET' ||
      !['low', 'medium'].includes(window.integrity) || window.cloaked || window.minimized || window.popup || window.onCurrentDesktop !== true ||
      ['pid', 'processStart', 'windowId'].some(k => window[k] !== receipt[k]) ||
      ['pid', 'processStart', 'image', 'title', 'className'].some(k => native?.[k] !== receipt[k]) ||
      typeof receipt.className !== 'string' || !receipt.className.length ||
      target === 'cover' && (win32.basename(receipt.image).toLowerCase() !== 'powershell.exe' || receipt.title !== 'Sleight WDR7 cover') ||
      target === 'terminal' && win32.basename(receipt.image).toLowerCase() !== 'windowsterminal.exe') fail('FIXTURE_IDENTITY_CHANGED');
  // Refused inventory has no admitted binding. Preserve its refusal and the
  // independent launch receipt without treating null as a valid read token.
  const { bindingId: _bindingId, ...refusedWindow } = window;
  return { ...refusedWindow, ...receipt, target, refusalOnly: true };
}

// Settings remains a refused target. Its redacted inventory is joined only to
// WindowIdentity metadata checked against the same owned HWND and fixed title.
export function bindTerminalSettingsFixture(previous, window, native) {
  if (previous?.target !== 'terminal' || previous.refusalOnly !== true || previous.refusalObserved !== true || previous.refused !== 'FORBIDDEN_TARGET' ||
      win32.basename(previous.image ?? '').toLowerCase() !== 'windowsterminal.exe' ||
      window?.refused !== 'FORBIDDEN_SETTINGS' || !['low', 'medium'].includes(window.integrity) ||
      window.cloaked || window.minimized || window.popup || window.onCurrentDesktop !== true ||
      ['pid', 'processStart', 'windowId'].some(k => window[k] !== previous[k]) ||
      ['pid', 'processStart', 'image', 'className'].some(k => native?.[k] !== previous[k]) ||
      native?.title !== 'Settings') fail('FIXTURE_IDENTITY_CHANGED');
  const { bindingId: _bindingId, ...refusedWindow } = window;
  const fixture = { ...refusedWindow, ...native, windowId: previous.windowId, target: 'terminal',
    refusalOnly: true, refusalObserved: previous.refusalObserved };
  windowBinding(fixture);
  return fixture;
}

// Title association identifies the refusal-only fixture.
// It grants no UIA or input route. A pre-existing frame can never be adopted.
export function proveRefusedCalculator(proof, { token }) {
  const copy = structuredClone(proof);
  if (!copy || copy.refusalOnly !== true || !Array.isArray(copy.baselineWindows) ||
      !/^[1-9][0-9]{0,19}$/.test(copy.activationSince ?? '') ||
      !/^[1-9][0-9]{0,19}$/.test(copy.launcher?.processStart ?? '') ||
      BigInt(copy.launcher.processStart) <= BigInt(copy.activationSince) || copy.windows?.length !== 1)
    fail('FIXTURE_LAUNCH_UNPROVED');
  const w = copy.windows[0];
  if (!Array.isArray(copy.calculatorProcesses) || copy.calculatorProcesses.length !== 1 ||
      copy.calculatorProcesses[0].pid !== copy.launcher.pid || copy.calculatorProcesses[0].processStart !== copy.launcher.processStart ||
      !Array.isArray(copy.newFrameIds) || copy.newFrameIds.length !== 1 || copy.newFrameIds[0] !== w.windowId)
    fail('FIXTURE_CALCULATOR_OWNERSHIP_UNPROVED');
  if (w.refusalOnly !== true || copy.baselineWindows.includes(w.windowId) || typeof w.title !== 'string' ||
      !w.title.length || w.coreTitle !== w.title) fail('FIXTURE_LAUNCH_UNPROVED');
  // Reuse the activation PID/birth/image and system-frame checks. Containment
  // is deliberately excluded from this refusal-only receipt.
  const coreParentId = w.coreParentId;
  w.coreParentId = w.windowId;
  const verified = proveActivatedFixture(copy, { target: 'calculator', token });
  return { ...verified, coreParentId, refusalOnly: true, refused: 'HOSTED_APP_UNRESOLVED',
    activationSince: copy.activationSince, baselineWindows: copy.baselineWindows };
}

export async function requireCalculatorRefusals(receipt, send, { identityRetries = 0, sleep = delay } = {}) {
  const aumid = 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App';
  const requests = [
    ...['Calculator', aumid, String(receipt.pid), { windowId: receipt.windowId }, { windowId: receipt.coreWindowId }]
      .map(selector => ['getApp', { selector }]),
    ...[receipt.windowId, receipt.coreWindowId].flatMap(windowId =>
      ['getAXState', 'getScreenshot', 'getAXStateAndScreenshot'].map(method => [method, { windowId, processStart: receipt.processStart }])),
  ];
  for (const [method, params] of requests) {
    // Refused inventory entries have no bindingId. Resolve the HWND on this
    // driver first, as every bound read requires; an admission refusal ends it.
    const read = ['getAXState', 'getScreenshot', 'getAXStateAndScreenshot'].includes(method);
    let refused = false;
    for (let attempt = 0; ; attempt++) {
      try { await send(read ? 'getApp' : method, read ? { selector: { windowId: params.windowId } } : params, read ? method : undefined); }
      catch (error) {
        if (error.code === 'HOSTED_APP_UNRESOLVED') { refused = true; break; }
        // Setup has sent no input. Repeat only a read-only inventory refusal
        // while newly launched fixture windows finish creating their children.
        if (error.code === 'IDENTITY_CHANGED' && attempt < identityRetries) { await sleep(100); continue; }
        throw error;
      }
      break;
    }
    if (refused) continue;
    fail('FIXTURE_REFUSAL_UNPROVED');
  }
  return requests.length;
}

// The frame host is shared. Only containment of the activated app's exact
// CoreWindow grants ownership of one frame, never its title or host PID.
export function proveActivatedFixture(proof, { target, token }) {
  const birth = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
  const pid = value => Number.isSafeInteger(value) && value > 0;
  const hwnd = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value);
  const app = proof?.launcher;
  const aumids = { calculator: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App',
    terminal: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App', notepad: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' };
  if (!app || !pid(app.pid) || !birth(app.processStart) || !birth(app.observedEnd) ||
      BigInt(app.observedEnd) < BigInt(app.processStart) || !Object.hasOwn(aumids, target) || proof.activation.aumid !== aumids[target] ||
      proof.activation.pid !== app.pid || proof.activation.processStart !== app.processStart ||
      typeof app.image !== 'string' || typeof proof.expectedImage !== 'string' || app.image.toLowerCase() !== proof.expectedImage.toLowerCase() ||
      !/^uc3f-[a-f0-9]{16}$/.test(token ?? '') || !Array.isArray(proof.windows)) fail('FIXTURE_LAUNCH_UNPROVED');
  if (typeof proof.activation.exited !== 'boolean') fail('FIXTURE_LAUNCH_UNPROVED');
  if (proof.activation.exited === true) fail('FIXTURE_EXITED');
  const candidates = proof.windows.filter(w => {
    if (!w || w.pid !== app.pid || w.processStart !== app.processStart || typeof w.image !== 'string' ||
        w.image.toLowerCase() !== app.image.toLowerCase() || !hwnd(w.windowId)) return false;
    if (w.className === 'ApplicationFrameWindow') {
      return pid(w.framePid) && birth(w.frameProcessStart) &&
        typeof w.frameImage === 'string' && typeof proof.frameHostImage === 'string' &&
        w.frameImage.toLowerCase() === proof.frameHostImage.toLowerCase() && typeof proof.systemDirectory === 'string' &&
        win32.isAbsolute(proof.systemDirectory) && proof.frameHostImage.toLowerCase() === win32.join(proof.systemDirectory, 'ApplicationFrameHost.exe').toLowerCase() &&
        hwnd(w.coreWindowId) && w.coreWindowId !== w.windowId && w.coreParentId === w.windowId &&
        w.corePid === app.pid && w.coreProcessStart === app.processStart && w.coreClassName === 'Windows.UI.Core.CoreWindow';
    }
    // WinUI desktop apps such as Notepad and Terminal own their top-level HWND.
    return target !== 'calculator' && w.className !== 'Windows.UI.Core.CoreWindow' && w.windowOwnerPid === app.pid && w.windowOwnerStart === app.processStart &&
      typeof w.title === 'string' && w.title.includes(token);
  });
  if (candidates.length > 1) fail('FIXTURE_LAUNCH_AMBIGUOUS');
  if (candidates.length !== 1) fail('FIXTURE_WINDOW_NOT_SEEN');
  return { ...candidates[0], activation: { ...proof.activation } };
}

// This dispatcher contains only the guest fixture lifecycle. The sole injector
// is G2's reviewed script. No fallback synthesizes input or clears a prompt.
export const GUEST_FAILURE = String.raw`
function GuestFailure($record, $fallback = 'GUEST_EXCEPTION_UNCLASSIFIED') {
  $code = [string]$record.Exception.Message
  if ($code -cmatch '^[A-Z][A-Z0-9_]{0,79}\z') { return $code }
  if ($record.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { return 'FIXTURE_PROCESS_GONE' }
  $types = @{
    'System.Management.Automation.ParameterBindingValidationException' = 'PARAMETER_BINDING_FAILED'
    'System.Management.Automation.ParameterBindingException' = 'PARAMETER_BINDING_FAILED'
    'System.ComponentModel.Win32Exception' = 'NATIVE_CALL_FAILED'
    'System.InvalidOperationException' = 'INVALID_OPERATION_FAILED'
    'System.UnauthorizedAccessException' = 'FIXTURE_ACCESS_DENIED'
    'System.Security.SecurityException' = 'FIXTURE_ACCESS_DENIED'
    'System.Windows.Automation.ElementNotAvailableException' = 'FIXTURE_WINDOW_GONE'
  }
  $exception = $record.Exception
  $typed = $null
  for ($depth = 0; $null -ne $exception -and $depth -lt 4; $depth++) {
    $innerCode = [string]$exception.Message
    if ($innerCode -cmatch '^[A-Z][A-Z0-9_]{0,79}\z') { return $innerCode }
    $type = $exception.GetType().FullName
    if ($type -ceq 'System.ComponentModel.Win32Exception' -and $exception.NativeErrorCode -eq 5) { return 'FIXTURE_ACCESS_DENIED' }
    if ($null -eq $typed -and $types.ContainsKey($type)) { $typed = $types[$type] }
    $exception = $exception.InnerException
  }
  if ($null -ne $typed) { return $typed }
  return $fallback
}
`;

export const GUEST_OPERATIONS = String.raw`
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Uc3fWindow {
  public static void RequireCalculatorReceipt(uint activatedPid, string birth, string since,
      uint[] pids, string[] births, string[] frames, string selected) {
    long started, activation;
    if (!Int64.TryParse(birth,out started) || !Int64.TryParse(since,out activation) || started <= activation ||
        pids == null || births == null || pids.Length != 1 || births.Length != 1 || pids[0] != activatedPid || births[0] != birth ||
        frames == null || frames.Length != 1 || frames[0] != selected)
      throw new InvalidOperationException("FIXTURE_CALCULATOR_OWNERSHIP_UNPROVED");
  }
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int size, out int needed);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr w, out RECT rect);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  public static string ProcessBirth(uint pid) {
    IntPtr handle=OpenProcess(0x1000,false,pid);
    if (handle == IntPtr.Zero) throw new InvalidOperationException("FIXTURE_ACCESS_DENIED");
    try {
      long created, exited, kernel, user;
      if (!GetProcessTimes(handle,out created,out exited,out kernel,out user) || created <= 0)
        throw new InvalidOperationException("FIXTURE_BIRTH_UNPROVED");
      return created.ToString(System.Globalization.CultureInfo.InvariantCulture);
    } finally { if (!CloseHandle(handle)) throw new InvalidOperationException("HANDLE_RELEASE_FAILED"); }
  }
  [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint id);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  static string ObjectName(IntPtr handle) {
    var name=new StringBuilder(256); uint needed;
    if (handle == IntPtr.Zero || !GetUserObjectInformationW(handle,2,name,512,out needed))
      throw new InvalidOperationException("SESSION_UNAVAILABLE");
    return name.ToString();
  }
  public static string Station() { return ObjectName(GetProcessWindowStation()); }
  public static string Desktop() { return ObjectName(GetThreadDesktop(GetCurrentThreadId())); }
  public static string ProcessIntegrity(IntPtr process) {
    IntPtr token = IntPtr.Zero, data = IntPtr.Zero;
    try {
      if (!OpenProcessToken(process, 0x0008, out token)) throw new InvalidOperationException("FIXTURE_INTEGRITY_UNPROVED");
      int needed;
      GetTokenInformation(token, 25, IntPtr.Zero, 0, out needed);
      if (needed < IntPtr.Size + 4 || needed > 65536) throw new InvalidOperationException("FIXTURE_INTEGRITY_UNPROVED");
      data = Marshal.AllocHGlobal(needed);
      if (!GetTokenInformation(token, 25, data, needed, out needed)) throw new InvalidOperationException("FIXTURE_INTEGRITY_UNPROVED");
      IntPtr sid = Marshal.ReadIntPtr(data);
      if (sid == IntPtr.Zero) throw new InvalidOperationException("FIXTURE_INTEGRITY_UNPROVED");
      IntPtr countAt = GetSidSubAuthorityCount(sid);
      if (countAt == IntPtr.Zero) throw new InvalidOperationException("FIXTURE_INTEGRITY_UNPROVED");
      byte count = Marshal.ReadByte(countAt);
      if (count < 1 || count > 15) throw new InvalidOperationException("FIXTURE_INTEGRITY_UNPROVED");
      IntPtr ridAt = GetSidSubAuthority(sid, (uint)(count - 1));
      if (ridAt == IntPtr.Zero) throw new InvalidOperationException("FIXTURE_INTEGRITY_UNPROVED");
      uint rid = unchecked((uint)Marshal.ReadInt32(ridAt));
      return rid >= 0x4000 ? "system" : rid >= 0x3000 ? "high" : rid >= 0x2000 ? "medium" : "low";
    } finally {
      if (data != IntPtr.Zero) Marshal.FreeHGlobal(data);
      if (token != IntPtr.Zero && !CloseHandle(token)) throw new InvalidOperationException("HANDLE_RELEASE_FAILED");
    }
  }
  public delegate bool EnumCallback(IntPtr w, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback cb, IntPtr data);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumCallback cb, IntPtr data);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr w);
  public static IntPtr[] AllWindows() {
    var windows = new System.Collections.Generic.List<IntPtr>();
    if (!EnumWindows((w, data) => { windows.Add(w); return windows.Count < 4096; }, IntPtr.Zero))
      throw new InvalidOperationException("FIXTURE_WINDOW_ENUM_LIMIT");
    return windows.ToArray();
  }
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr w, int attribute, out int value, int size);
  public static bool Uncloaked(IntPtr w) { int value; return DwmGetWindowAttribute(w,14,out value,4) == 0 && value == 0; }
  public static IntPtr[] CoreWindows(IntPtr frame) {
    var windows = new System.Collections.Generic.List<IntPtr>(); int count = 0; bool overflow = false;
    EnumChildWindows(frame, (w, data) => {
      if (++count > 4096) { overflow = true; return false; }
      var name = new StringBuilder(256); GetClassNameW(w,name,256);
      if (name.ToString() == "Windows.UI.Core.CoreWindow" && IsChild(frame,w)) windows.Add(w);
      return true;
    }, IntPtr.Zero);
    if (overflow) throw new InvalidOperationException("FIXTURE_WINDOW_ENUM_LIMIT");
    return windows.ToArray();
  }
  [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IApplicationActivationManager {
    [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string aumid,
      [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint pid);
    [PreserveSig] int ActivateForFile(IntPtr aumid, IntPtr items, IntPtr verb, out uint pid);
    [PreserveSig] int ActivateForProtocol(IntPtr aumid, IntPtr items, out uint pid);
  }
  public static uint Activate(string aumid, string arguments) {
    object manager = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("45ba127d-10a8-46ea-8ab7-56ea9078943c"),true));
    try {
      uint pid; int hr = ((IApplicationActivationManager)manager).ActivateApplication(aumid,arguments,0,out pid);
      if (hr < 0) Marshal.ThrowExceptionForHR(hr);
      if (pid == 0) throw new InvalidOperationException("FIXTURE_ACTIVATION_FAILED");
      return pid;
    } finally { Marshal.ReleaseComObject(manager); }
  }
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr w);
  public static IntPtr[] VisibleWindows() {
    var windows = new System.Collections.Generic.List<IntPtr>();
    if (!EnumWindows((w, data) => { if (IsWindowVisible(w)) windows.Add(w); return windows.Count < 4096; }, IntPtr.Zero))
      throw new InvalidOperationException("FIXTURE_LAUNCH_UNPROVED");
    return windows.ToArray();
  }
  [DllImport("kernel32.dll")] public static extern ulong GetTickCount64();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO value);
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint size, tick; }
  [DllImport("wtsapi32.dll")] static extern bool WTSQuerySessionInformationW(IntPtr server, uint session, int kind, out IntPtr data, out uint size);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr data);
  public static bool Connected() {
    IntPtr data; uint size;
    if(!WTSQuerySessionInformationW(IntPtr.Zero,(uint)System.Diagnostics.Process.GetCurrentProcess().SessionId,8,out data,out size)) return false;
    try { return size >= 4 && Marshal.ReadInt32(data) == 0; } finally { WTSFreeMemory(data); }
  }
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr w, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr w, uint command);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr w, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr w, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint f, bool inherit, uint access);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformationW(IntPtr h, int i, StringBuilder s, uint n, out uint needed);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
  public static bool DefaultDesktop() {
    var h = OpenInputDesktop(0,false,1); if(h == IntPtr.Zero) return false;
    try { var s = new StringBuilder(256); uint n; return GetUserObjectInformationW(h,2,s,512,out n) && s.ToString() == "Default"; }
    finally { if(!CloseDesktop(h)) throw new InvalidOperationException("HANDLE_RELEASE_FAILED"); }
  }
}
'@
function Birth($p) {
  if ($null -eq $p) { throw 'FIXTURE_PROCESS_GONE' }
  if ($p.HasExited) { throw 'FIXTURE_PROCESS_GONE' }
  [Uc3fWindow]::ProcessBirth([uint32]$p.Id)
}
function ProcessOrGone($id) {
  try { return Get-Process -Id $id -ErrorAction Stop }
  catch {
    if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { return $null }
    throw
  }
}
function Bound($f) {
  try { $p = Get-Process -Id $f.pid -ErrorAction Stop }
  catch {
    if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { throw 'FIXTURE_PROCESS_GONE' }
    throw
  }
  if ($p.HasExited) { throw 'FIXTURE_PROCESS_GONE' }
  if ((Birth $p) -cne $f.processStart) { throw 'FIXTURE_BIRTH_CHANGED' }
  if ([string]::IsNullOrWhiteSpace($p.Path)) { throw 'FIXTURE_ACCESS_DENIED' }
  if ($p.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId -or $p.Path -ine $f.image) {
    # Preserve the first precise mismatch without changing the refusal, even if
    # the diagnostic cannot be written. Raw evidence survives normal cleanup.
    try {
      $diagnostic = @{ operation=$r.operation; target=$r.fixture.target; pid=$p.Id;
        recordedStart=$f.processStart; liveStart=(Birth $p); image=$p.Path; expectedImage=$f.image;
        sessionId=$p.SessionId; expectedSessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId }
      $path = Join-Path (Join-Path $r.bank 'raw') ('identity-' + $p.Id + '.json')
      $bytes = [Text.Encoding]::UTF8.GetBytes(($diagnostic | ConvertTo-Json -Compress))
      $stream = [IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      try { $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
    } catch { }
    throw 'FIXTURE_IDENTITY_CHANGED'
  }
  return $p
}
function HasField($f,$key) {
  if ($f -is [hashtable]) { return $f.ContainsKey($key) }
  return $null -ne $f.PSObject.Properties[$key]
}
function NotepadTitle($title,$leaf) { return $title.TrimStart('*') -ceq ($leaf + ' - Notepad') }
function CalculatorReceipt($f) {
  $processes = @(Get-Process -Name CalculatorApp -ErrorAction SilentlyContinue)
  $pids = @($processes | ForEach-Object { [uint32]$_.Id })
  $births = @($processes | ForEach-Object { Birth $_ })
  $frames = @()
  foreach ($h in [Uc3fWindow]::AllWindows()) {
    $title = New-Object Text.StringBuilder(1024); $class = New-Object Text.StringBuilder(256)
    [void][Uc3fWindow]::GetWindowTextW($h,$title,1024); [void][Uc3fWindow]::GetClassNameW($h,$class,256)
    # Count cloaked and hidden frames too, before sending any close.
    if ($class.ToString() -ceq 'ApplicationFrameWindow' -and $title.ToString() -ceq $f.title -and
        $h.ToInt64().ToString() -cnotin $f.baselineWindows) { $frames += $h.ToInt64().ToString() }
  }
  [Uc3fWindow]::RequireCalculatorReceipt($f.pid,$f.processStart,$f.activationSince,[uint32[]]$pids,[string[]]$births,[string[]]$frames,$f.windowId)
  return @{ calculatorProcesses = @($processes | ForEach-Object { @{ pid = $_.Id; processStart = (Birth $_) } }); newFrameIds = $frames }
}
function WindowIdentity($f) {
  $p = Bound $f
  $h = [IntPtr]([Int64]$f.windowId); [uint32]$windowPid = 0
  if (-not [Uc3fWindow]::IsWindow($h)) { throw 'FIXTURE_WINDOW_GONE' }
  [void][Uc3fWindow]::GetWindowThreadProcessId($h,[ref]$windowPid)
  $title = New-Object Text.StringBuilder(1024); $class = New-Object Text.StringBuilder(256)
  [void][Uc3fWindow]::GetWindowTextW($h,$title,1024)
  if ([Uc3fWindow]::GetClassNameW($h,$class,256) -le 0 -or -not [Uc3fWindow]::IsWindow($h)) { throw 'FIXTURE_WINDOW_GONE' }
  if ($class.ToString() -cne $f.className) { throw 'FIXTURE_WINDOW_CHANGED' }
  if ($title.ToString().TrimStart('*') -cne $f.title.TrimStart('*')) { throw 'FIXTURE_IDENTITY_CHANGED' }
  if ((HasField $f 'coreWindowId') -and $null -ne $f.coreWindowId) {
    $frame = Bound @{ pid = $f.framePid; processStart = $f.frameProcessStart; image = $f.frameImage }
    $core = [IntPtr]([Int64]$f.coreWindowId); [uint32]$corePid = 0
    [void][Uc3fWindow]::GetWindowThreadProcessId($core,[ref]$corePid)
    if ((HasField $f 'refusalOnly') -and $f.refusalOnly) {
      [void](CalculatorReceipt $f)
      $coreTitle = New-Object Text.StringBuilder(1024); $coreClass = New-Object Text.StringBuilder(256)
      [void][Uc3fWindow]::GetWindowTextW($core,$coreTitle,1024)
      [void][Uc3fWindow]::GetClassNameW($core,$coreClass,256)
      if (-not [Uc3fWindow]::IsWindow($core) -or $corePid -ne $p.Id -or $windowPid -ne $frame.Id -or
          $coreClass.ToString() -cne 'Windows.UI.Core.CoreWindow' -or $coreTitle.ToString() -cne $f.title -or
          $class.ToString() -cne 'ApplicationFrameWindow' -or $frame.Path -ine (Join-Path ([Environment]::SystemDirectory) 'ApplicationFrameHost.exe')) { throw 'FIXTURE_WINDOW_CHANGED' }
    } else {
    $cores = @([Uc3fWindow]::CoreWindows($h))
    if ($windowPid -ne $frame.Id -or $cores.Count -ne 1 -or $cores[0] -ne $core -or $corePid -ne $p.Id -or
        $class.ToString() -cne 'ApplicationFrameWindow' -or -not [Uc3fWindow]::IsChild($h,$core)) { throw 'FIXTURE_WINDOW_CHANGED' }
    }
  } elseif ($windowPid -ne $p.Id) { throw 'FIXTURE_WINDOW_CHANGED' }
  [void](Bound $f)
  return @{ pid = $p.Id; processStart = (Birth $p); image = $p.Path; title = $title.ToString(); className = $class.ToString() }
}
function Hash($s) {
  $h = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($s)))).Replace('-','').ToLowerInvariant() }
  finally { $h.Dispose() }
}
if ($env:OS -ne 'Windows_NT') { throw 'WINDOWS_REQUIRED' }
if ([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) { throw 'INTERACTIVE_SESSION_REQUIRED' }
$who = & "$env:SystemRoot\System32\whoami.exe" /groups /fo csv /nh
if ($LASTEXITCODE -ne 0 -or ($who -join ' ') -notmatch 'S-1-16-(4096|8192)(?:[^0-9]|$)' -or ($who -join ' ') -match 'S-1-16-(12288|16384)') { throw 'UNELEVATED_REQUIRED' }
$machine = Get-CimInstance Win32_ComputerSystem
if ($machine.Manufacturer -cne 'QEMU') { throw 'NOT_VM' }
if ($r.bank -cnotmatch '^C:\\sleight-setup\\uc3f-[a-f0-9]{16}$') { throw 'BANK_IDENTITY' }
foreach ($path in @('C:\','C:\sleight-setup',$r.bank)) {
  $item = Get-Item -LiteralPath $path -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'BANK_IDENTITY' }
}
switch ($r.operation) {
  'preflight' {
    $guid = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography').MachineGuid
    @{ vmId = $r.vmId; manufacturer = [string]$machine.Manufacturer; model = [string]$machine.Model;
       build = [int](Get-CimInstance Win32_OperatingSystem).BuildNumber;
       hostnameSha256 = (Hash ([string]$machine.Name).Trim().ToLowerInvariant());
       machineGuidSha256 = (Hash ([string]$guid).Trim().ToLowerInvariant()); tickMs = [Uc3fWindow]::GetTickCount64() } | ConvertTo-Json -Compress
  }
  'available' {
    $installed = switch ($r.target) {
      'firefox' { Test-Path -LiteralPath ($env:ProgramFiles + '\Mozilla Firefox\firefox.exe') }
      'edge' { Test-Path -LiteralPath ((Get-Item -LiteralPath 'Env:ProgramFiles(x86)').Value + '\Microsoft\Edge\Application\msedge.exe') }
      'terminal' { @(Get-AppxPackage -Name Microsoft.WindowsTerminal).Count -eq 1 }
      'calculator-refused' { @(Get-AppxPackage -Name Microsoft.WindowsCalculator).Count -eq 1 }
      default { throw 'FIXTURE_MISSING' }
    }
    @{ installed = [bool]$installed } | ConvertTo-Json -Compress
  }
  'notepad-idle' {
    if (@(Get-Process -Name Notepad -ErrorAction SilentlyContinue).Count -ne 0) { throw 'FIXTURE_ALREADY_RUNNING' }
    @{ localState = (Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.WindowsNotepad_8wekyb3d8bbwe\LocalState') } | ConvertTo-Json -Compress
  }
  'readiness' {
    $foreground = [Uc3fWindow]::GetForegroundWindow()
    [uint32]$pidValue = 0
    [void][Uc3fWindow]::GetWindowThreadProcessId($foreground,[ref]$pidValue)
    $inputValue = New-Object Uc3fWindow+LASTINPUTINFO
    $inputValue.size = [Runtime.InteropServices.Marshal]::SizeOf($inputValue)
    if (-not [Uc3fWindow]::GetLastInputInfo([ref]$inputValue)) { throw 'OWNER_STATE_UNPROVED' }
    $p = Get-Process -Id $pidValue -ErrorAction Stop
    @{ tickMs = [Uc3fWindow]::GetTickCount64(); lastInputTickMs = $inputValue.tick;
       foregroundPid = $pidValue; word = ($p.ProcessName -ceq 'WINWORD');
       foregroundWindowId = $foreground.ToInt64().ToString(); foregroundProcessStart = (Birth $p); foregroundImage = $p.Path;
       unlocked = [Uc3fWindow]::DefaultDesktop(); connected = [Uc3fWindow]::Connected() } | ConvertTo-Json -Compress
  }
  'foreground' {
    $hwnd = [Uc3fWindow]::GetForegroundWindow()
    [uint32]$pidValue = 0
    [void][Uc3fWindow]::GetWindowThreadProcessId($hwnd,[ref]$pidValue)
    $title = New-Object Text.StringBuilder 1024
    $class = New-Object Text.StringBuilder 256
    [void][Uc3fWindow]::GetWindowTextW($hwnd,$title,1024)
    [void][Uc3fWindow]::GetClassNameW($hwnd,$class,256)
    $p = if ($pidValue -gt 0) { Get-Process -Id $pidValue -ErrorAction Stop } else { $null }
    @{ tickMs = [Uc3fWindow]::GetTickCount64(); windowId = $hwnd.ToInt64().ToString(); pid = $pidValue;
       process = $(if ($null -ne $p) { $p.ProcessName } else { '' });
       processStart = $(if ($null -ne $p) { Birth $p } else { '' });
       image = $(if ($null -ne $p) { $p.Path } else { '' }); className = $class.ToString(); title = $title.ToString();
       isDefault = [Uc3fWindow]::DefaultDesktop() } | ConvertTo-Json -Compress
  }
${TYPING_DIAGNOSTIC}
  'inspect' {
    WindowIdentity $r.fixture | ConvertTo-Json -Compress
  }
  'launch' {
    $refusalOnly = $r.target -ceq 'calculator-refused'
    $target = if ($refusalOnly) { 'calculator' } else { $r.target }
    $launchFailure = 'FIXTURE_RESOLVE_FAILED'
    $expectedImage = $null; $aumid = $null
    # PowerShell 5.1 joins ArgumentList with spaces. Refuse ambiguous elements.
    foreach ($argument in @($r.args)) {
      if ($argument -isnot [string] -or $argument.Length -eq 0 -or $argument -match '[\s"'']') { throw 'FIXTURE_ARGUMENT_UNSAFE' }
    }
    if ($target -eq 'wpf') {
      $program = Join-Path $r.bank $(if ((HasField $r 'typingTarget') -and $r.typingTarget -eq $true) { 'typing-receiver.exe' } else { 'receiver.exe' })
    } elseif ($target -ceq 'metadata-stub' -or $target -ceq 'neutral-stub') {
      $leaf = if ($target -ceq 'metadata-stub') { 'uc3f-metadata-stub.exe' } else { 'uc3f-neutral-stub.exe' }
      $program = Join-Path $r.bank $leaf
    } elseif ($target -eq 'cover') {
      $program = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    } else {
      $names = @{ notepad = 'notepad'; calculator = 'CalculatorApp'; edge = 'msedge'; firefox = 'firefox'; terminal = 'WindowsTerminal' }
      if (-not $names.ContainsKey($target)) { throw 'FIXTURE_MISSING' }
      $programs = @{ notepad = "$env:SystemRoot\System32\notepad.exe"; calculator = "$env:SystemRoot\System32\calc.exe";
        edge = ((Get-Item -LiteralPath 'Env:ProgramFiles(x86)').Value + '\Microsoft\Edge\Application\msedge.exe');
        firefox = "$env:ProgramFiles\Mozilla Firefox\firefox.exe"; terminal = "$env:LOCALAPPDATA\Microsoft\WindowsApps\wt.exe" }
      if ($target -eq 'edge' -and (HasField $r 'renamed') -and $r.renamed) { $programs.edge = Join-Path $r.bank 'msedge-harness.exe' }
      if ($target -eq 'edge' -and (HasField $r 'stagedControl') -and $r.stagedControl) {
        if (-not (HasField $r 'renamed') -or -not $r.renamed) { throw 'INVALID_REQUEST' }
        $programs.edge = Join-Path $r.bank 'msedge.exe'
      }
      $packages = @{ notepad = @('Microsoft.WindowsNotepad','Notepad\Notepad.exe'); calculator = @('Microsoft.WindowsCalculator','CalculatorApp.exe'); terminal = @('Microsoft.WindowsTerminal','WindowsTerminal.exe') }
      if ($packages.ContainsKey($target)) {
        $package = @(Get-AppxPackage -Name $packages[$target][0])
        if ($package.Count -ne 1) { throw 'FIXTURE_LAUNCH_UNPROVED' }
        $expectedImage = Join-Path $package[0].InstallLocation $packages[$target][1]
        $packageId = $package[0].PackageFamilyName + '!App'
        $aumid = if ($target -in @('notepad','terminal')) { $null } else { $packageId }
        $activationIds = @{ calculator = 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App';
          notepad = 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App'; terminal = 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App' }
        if ($packageId -cne $activationIds[$target]) { throw 'FIXTURE_ACTIVATION_UNSUPPORTED' }
      } else { $expectedImage = $programs[$target] }
      $program = $programs[$target]
      if ($target -in @('terminal','notepad')) { $program = $expectedImage }
    }
    if ($null -eq $expectedImage) { $expectedImage = $program }
    $launchFailure = 'FIXTURE_START_FAILED'
    if ($null -ne $aumid) {
      $baselineWindows = @([Uc3fWindow]::AllWindows() | ForEach-Object { $_.ToInt64().ToString() })
      $activationSince = [DateTime]::UtcNow.ToFileTimeUtc()
      $launchMayHaveStarted = $true
      $activatedPid = [Uc3fWindow]::Activate($aumid,($r.args -join ' '))
      try { $p = Get-Process -Id $activatedPid -ErrorAction Stop }
      catch {
        if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { throw 'FIXTURE_EXITED' }
        throw
      }
      try {
        $handle = $p.Handle; $launchStart = Birth $p; $launchImage = $p.Path
        if ([Int64]$launchStart -lt $activationSince -or $launchImage -ine $expectedImage) { throw 'FIXTURE_ACTIVATION_UNPROVED' }
        $app = @{ pid = $p.Id; processStart = $launchStart; image = $launchImage }
        $frameHostImage = Join-Path ([Environment]::SystemDirectory) 'ApplicationFrameHost.exe'
        if ($refusalOnly) {
          # Refusal fixture only. Title association is never a product input route.
          $deadline = [DateTime]::UtcNow.AddSeconds(15)
          $refusalProof = $null
          do {
            [void](Bound $app)
            $cores = @(); $frames = @()
            foreach ($h in [Uc3fWindow]::AllWindows()) {
              $title = New-Object Text.StringBuilder(1024); $class = New-Object Text.StringBuilder(256)
              [void][Uc3fWindow]::GetWindowTextW($h,$title,1024); [void][Uc3fWindow]::GetClassNameW($h,$class,256)
              [uint32]$owner = 0; [void][Uc3fWindow]::GetWindowThreadProcessId($h,[ref]$owner)
              if ($class.ToString() -ceq 'Windows.UI.Core.CoreWindow' -and $owner -eq $p.Id) {
                $cores += @{ windowId = $h.ToInt64().ToString(); title = $title.ToString() }
              }
              if ($class.ToString() -ceq 'ApplicationFrameWindow' -and
                  $h.ToInt64().ToString() -cnotin $baselineWindows) {
                $frame = Get-Process -Id $owner -ErrorAction Stop
                if ($frame.Path -ieq $frameHostImage -and $frame.SessionId -eq $p.SessionId) {
                  $frames += @{ windowId = $h.ToInt64().ToString(); title = $title.ToString(); framePid = $owner;
                    frameProcessStart = (Birth $frame); frameImage = $frame.Path }
                }
              }
            }
            if ($cores.Count -eq 1 -and $frames.Count -eq 1 -and $cores[0].title -ceq $frames[0].title -and $cores[0].title.Length -gt 0 -and
                [Uc3fWindow]::Uncloaked([IntPtr]([Int64]$frames[0].windowId))) {
              $candidate = $frames[0]
              $candidate.pid = $p.Id; $candidate.processStart = $launchStart; $candidate.image = $launchImage
              $candidate.className = 'ApplicationFrameWindow'; $candidate.coreWindowId = $cores[0].windowId
              $candidate.corePid = $p.Id; $candidate.coreProcessStart = $launchStart; $candidate.coreClassName = 'Windows.UI.Core.CoreWindow'
              $candidate.coreTitle = $cores[0].title; $candidate.refusalOnly = $true
              $candidate.activationSince = $activationSince.ToString(); $candidate.baselineWindows = $baselineWindows
              $candidate.integrity = [Uc3fWindow]::ProcessIntegrity($p.Handle)
              $ownership = CalculatorReceipt $candidate
              [void](WindowIdentity $candidate)
              $refusalProof = @{ launcher = @{ pid = $p.Id; processStart = $launchStart; image = $launchImage; observedEnd = [DateTime]::UtcNow.ToFileTimeUtc().ToString() };
                activation = @{ aumid = $aumid; pid = $p.Id; processStart = $launchStart; exited = $false };
                expectedImage = $expectedImage; systemDirectory = [Environment]::SystemDirectory; frameHostImage = $frameHostImage; refusalOnly = $true;
                activationSince = $activationSince.ToString(); baselineWindows = $baselineWindows; windows = @($candidate);
                calculatorProcesses = $ownership.calculatorProcesses; newFrameIds = $ownership.newFrameIds }
              break
            }
            Start-Sleep -Milliseconds 50
          } while ([DateTime]::UtcNow -lt $deadline)
          if ($null -eq $refusalProof) { throw 'FIXTURE_WINDOW_NOT_SEEN' }
          $refusalProof | ConvertTo-Json -Depth 6 -Compress
        } else {
        $launchFailure = 'FIXTURE_WINDOW_NOT_SEEN'
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
          if ($p.HasExited) { throw 'FIXTURE_EXITED' }
          [void](Bound $app)
          $windows = @()
          foreach ($h in [Uc3fWindow]::VisibleWindows()) {
            $class = New-Object Text.StringBuilder(256); $title = New-Object Text.StringBuilder(1024)
            [void][Uc3fWindow]::GetClassNameW($h,$class,256)
            [void][Uc3fWindow]::GetWindowTextW($h,$title,1024)
            [uint32]$owner = 0; [void][Uc3fWindow]::GetWindowThreadProcessId($h,[ref]$owner)
            if ($class.ToString() -ceq 'ApplicationFrameWindow') {
              if (-not [Uc3fWindow]::Uncloaked($h)) { continue }
              $cores = @([Uc3fWindow]::CoreWindows($h))
              if ($cores.Count -ne 1) { continue }
              [uint32]$corePid = 0; [void][Uc3fWindow]::GetWindowThreadProcessId($cores[0],[ref]$corePid)
              if ($corePid -ne $p.Id) { continue }
              $frame = Get-Process -Id $owner -ErrorAction Stop
              if ($frame.Path -ine $frameHostImage -or $frame.SessionId -ne $p.SessionId) { continue }
              $candidate = @{ pid = $p.Id; processStart = $launchStart; image = $launchImage; windowId = $h.ToInt64().ToString();
                title = $title.ToString(); className = $class.ToString(); framePid = $owner; frameProcessStart = (Birth $frame); frameImage = $frame.Path;
                coreWindowId = $cores[0].ToInt64().ToString(); coreParentId = $h.ToInt64().ToString(); corePid = $corePid;
                coreProcessStart = $launchStart; coreClassName = 'Windows.UI.Core.CoreWindow' }
            } else {
              if ($target -ceq 'calculator' -or $class.ToString() -ceq 'Windows.UI.Core.CoreWindow' -or $owner -ne $p.Id -or -not $title.ToString().Contains((Split-Path $r.bank -Leaf))) { continue }
              $candidate = @{ pid = $p.Id; processStart = $launchStart; image = $launchImage; windowId = $h.ToInt64().ToString();
                title = $title.ToString(); className = $class.ToString(); windowOwnerPid = $owner; windowOwnerStart = $launchStart }
            }
            [void](WindowIdentity $candidate)
            $windows += $candidate
          }
          if ($p.HasExited) { throw 'FIXTURE_EXITED' }
          [void](Bound $app)
          if ($windows.Count -gt 0) { break }
          Start-Sleep -Milliseconds 50
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($windows.Count -eq 0) { throw 'FIXTURE_WINDOW_NOT_SEEN' }
        @{ launcher = @{ pid = $p.Id; processStart = $launchStart; image = $launchImage; observedEnd = [DateTime]::UtcNow.ToFileTimeUtc().ToString() };
          activation = @{ aumid = $aumid; pid = $p.Id; processStart = $launchStart; exited = $false };
          expectedImage = $expectedImage; systemDirectory = [Environment]::SystemDirectory; frameHostImage = $frameHostImage; windows = $windows } | ConvertTo-Json -Depth 6 -Compress
        }
      } catch {
        if ($p.HasExited) { throw 'FIXTURE_EXITED' }
        throw
      } finally { $p.Dispose() }
    } else {
    $start = @{ FilePath = $program; WorkingDirectory = $r.bank; PassThru = $true; ErrorAction = 'Stop' }
    # Windows PowerShell rejects an empty ArgumentList.
    if (@($r.args).Count -gt 0) { $start.ArgumentList = $r.args }
    $launchMayHaveStarted = $true
    $p = Start-Process @start
    $handle = $p.Handle; $launchStart = Birth $p
    $launchImage = $null
    try {
    $wait = [Diagnostics.Stopwatch]::StartNew()
    do {
      $p.Refresh()
      if ([string]::IsNullOrWhiteSpace([string]$launchImage)) { $launchImage = $p.Path }
      if ([string]::IsNullOrWhiteSpace([string]$expectedImage)) { $expectedImage = $launchImage }
      $windows = @()
      $family = @(Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.Id + " OR ParentProcessId=" + $p.Id))
      foreach ($h in [Uc3fWindow]::VisibleWindows()) {
        [uint32]$owner = 0; [void][Uc3fWindow]::GetWindowThreadProcessId($h,[ref]$owner)
        if ($owner -notin @($family | ForEach-Object { $_.ProcessId })) { continue }
        $child = Get-Process -Id $owner -ErrorAction SilentlyContinue
        if ($null -eq $child -or $child.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId -or $child.Path -ine $expectedImage) { continue }
        $childStart = Birth $child
        $meta = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $owner)
        $again = Get-Process -Id $owner -ErrorAction Stop
        [uint32]$ownerAgain = 0; [void][Uc3fWindow]::GetWindowThreadProcessId($h,[ref]$ownerAgain)
        if ($null -eq $meta -or (Birth $again) -cne $childStart -or $ownerAgain -ne $owner) { continue }
        $direct = $owner -eq $p.Id -and $childStart -ceq $launchStart
        if (-not $direct -and $meta.ParentProcessId -ne $p.Id) { continue }
        $title = New-Object Text.StringBuilder(1024); $class = New-Object Text.StringBuilder(256)
        [void][Uc3fWindow]::GetWindowTextW($h,$title,1024); [void][Uc3fWindow]::GetClassNameW($h,$class,256)
        if ($target -eq 'notepad' -and -not (NotepadTitle $title.ToString() (Split-Path $r.args[0] -Leaf))) { continue }
        if ($target -ceq 'wpf' -and ($title.ToString() -cne 'Sleight WDR7 WPF' -or -not $class.ToString().StartsWith('HwndWrapper[',[StringComparison]::Ordinal))) { continue }
        if ((-not $direct -or $target -notin @('calculator','cover','wpf','metadata-stub','neutral-stub')) -and -not $title.ToString().Contains((Split-Path $r.bank -Leaf))) { continue }
        $windows += @{ pid=$owner; processStart=$childStart; image=$child.Path; parentPid = [int]$meta.ParentProcessId;
          windowId=$h.ToInt64().ToString(); title=$title.ToString(); className=$class.ToString() }
      }
      $p.Refresh()
      $end = if ($p.HasExited) { $p.ExitTime.ToFileTimeUtc() } else { [DateTime]::UtcNow.ToFileTimeUtc() }
      if (-not $p.HasExited -and $end -lt $p.StartTime.ToFileTimeUtc()) { $end = $p.StartTime.ToFileTimeUtc() }
      if ($windows.Count) { break }
      Start-Sleep -Milliseconds 50
    } while ($wait.ElapsedMilliseconds -lt 15000)
    if ($windows.Count -ne 1) { throw 'FIXTURE_LAUNCH_UNPROVED' }
    @{ launcher=@{ pid=$p.Id; processStart=$launchStart; image=$launchImage; observedEnd = $end.ToString() };
      expectedImage=$expectedImage; windows=$windows } | ConvertTo-Json -Depth 6 -Compress
    } finally { $p.Dispose() }
    }
  }
  'compile-fixture' {
    $source = [IO.File]::ReadAllText((Join-Path $r.bank $(if ((HasField $r 'typingTarget') -and $r.typingTarget -eq $true) { 'typing-fixture-launcher.cs' } else { 'fixture-launcher.cs' })))
    $exe = Join-Path $r.bank $(if ((HasField $r 'typingTarget') -and $r.typingTarget -eq $true) { 'typing-receiver.exe' } else { 'receiver.exe' })
    if (Test-Path -LiteralPath $exe) { throw 'FIXTURE_ALREADY_EXISTS' }
    Add-Type -TypeDefinition $source -ReferencedAssemblies ([Management.Automation.PowerShell].Assembly.Location) -OutputAssembly $exe -OutputType WindowsApplication
    @{ sha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() } | ConvertTo-Json -Compress
  }
  'edge-metadata' {
    $source = (Get-Item -LiteralPath 'Env:ProgramFiles(x86)').Value + '\Microsoft\Edge\Application\msedge.exe'
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'EDGE_NOT_INSTALLED' }
    $info = (Get-Item -LiteralPath $source).VersionInfo
    @{ originalFilename = [string]$info.OriginalFilename; productName = [string]$info.ProductName;
       companyName = [string]$info.CompanyName; fileDescription = [string]$info.FileDescription } | ConvertTo-Json -Compress
  }
  'compile-stub' {
    $name = [string]$r.stub
    if ($name -cnotin @('uc3f-metadata-stub','uc3f-neutral-stub')) { throw 'FIXTURE_MISSING' }
    $sourcePath = Join-Path $r.bank 'uc3f-browser-stub.cs'
    $exe = Join-Path $r.bank ($name + '.exe')
    $res = Join-Path $r.bank ($name + '.res')
    if ((Test-Path -LiteralPath $exe) -or -not (Test-Path -LiteralPath $sourcePath -PathType Leaf) -or -not (Test-Path -LiteralPath $res -PathType Leaf)) { throw 'STUB_COMPILE_FAILED' }
    $source = [IO.File]::ReadAllText($sourcePath)
    $compiler = New-Object System.CodeDom.Compiler.CompilerParameters
    $compiler.GenerateExecutable = $true
    $compiler.OutputAssembly = $exe
    $compiler.CompilerOptions = '/target:winexe /debug- /win32res:' + $res
    [void]$compiler.ReferencedAssemblies.Add('mscorlib.dll')
    [void]$compiler.ReferencedAssemblies.Add('System.dll')
    try { Add-Type -TypeDefinition $source -CompilerParameters $compiler -ErrorAction Stop }
    catch {
      $detail = [string]$_.Exception
      if ($detail.Length -gt 4000) { $detail = $detail.Substring(0, 4000) }
      [IO.File]::WriteAllText((Join-Path $r.bank 'stub-compile-error.txt'), $detail, (New-Object Text.UTF8Encoding($false)))
      throw 'STUB_COMPILE_FAILED'
    }
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'STUB_COMPILE_FAILED' }
    @{ sha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() } | ConvertTo-Json -Compress
  }
  'stub-metadata' {
    $name = [string]$r.stub
    if ($name -cnotin @('uc3f-metadata-stub','uc3f-neutral-stub')) { throw 'FIXTURE_MISSING' }
    $info = (Get-Item -LiteralPath (Join-Path $r.bank ($name + '.exe'))).VersionInfo
    @{ originalFilename = [string]$info.OriginalFilename; productName = [string]$info.ProductName;
       companyName = [string]$info.CompanyName; fileDescription = [string]$info.FileDescription } | ConvertTo-Json -Compress
  }
  'register-injector' {
    $name = 'sleight-uc3f-' + (Split-Path $r.bank -Leaf).Substring(5) + '-collector-' + $r.invocation
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw 'TASK_ALREADY_EXISTS' }
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument $r.arguments -WorkingDirectory $r.bank
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings | Out-Null
    Start-ScheduledTask -TaskName $name
    @{ name = $name } | ConvertTo-Json -Compress
  }
  'desktop' { @{ isDefault = [Uc3fWindow]::DefaultDesktop() } | ConvertTo-Json -Compress }
  'raise-prompt' {
    if (-not [Uc3fWindow]::DefaultDesktop()) { throw 'SECURE_DESKTOP_NO_INJECT' }
    $p = Bound $r.fixture
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
    $w = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]([Int64]$r.fixture.windowId))
    if ($null -eq $w -or $w.Current.ProcessId -ne $p.Id) { throw 'FIXTURE_IDENTITY_CHANGED' }
    $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty,'UacButton')
    $b = $w.FindAll([Windows.Automation.TreeScope]::Descendants,$condition)
    if ($b.Count -ne 1) { throw 'FIXTURE_ELEMENT_MISSING' }
    [void](Bound $r.fixture)
    if (-not [Uc3fWindow]::DefaultDesktop()) { throw 'SECURE_DESKTOP_NO_INJECT' }
    $b[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
    '{"raised":true}'
  }
  'terminal-control-tree' {
    $p = Bound $r.fixture
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
    $w = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]([Int64]$r.fixture.windowId))
    if ($null -eq $w -or $w.Current.ProcessId -ne $p.Id) { throw 'FIXTURE_IDENTITY_CHANGED' }
    $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $queue = New-Object 'Collections.Generic.Queue[Windows.Automation.AutomationElement]'
    $queue.Enqueue($w); $controls = @()
    while ($queue.Count -gt 0) {
      if ($controls.Count -ge 256 -or $clock.ElapsedMilliseconds -gt 1500) { throw 'TERMINAL_CONTROL_TREE_LIMIT' }
      $element = $queue.Dequeue(); $info = $element.Current
      if ($info.ProcessId -ne $p.Id) { throw 'FIXTURE_IDENTITY_CHANGED' }
      $record = @{ type = $info.ControlType.ProgrammaticName; id = $info.AutomationId }
      if ($info.ControlType -in @([Windows.Automation.ControlType]::Button,[Windows.Automation.ControlType]::MenuItem,[Windows.Automation.ControlType]::SplitButton)) {
        $record.name = $info.Name
        $record.invoke = [bool]$element.GetCurrentPropertyValue([Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty)
        $record.expand = [bool]$element.GetCurrentPropertyValue([Windows.Automation.AutomationElement]::IsExpandCollapsePatternAvailableProperty)
      }
      $controls += $record
      for ($child = $walker.GetFirstChild($element); $null -ne $child; $child = $walker.GetNextSibling($child)) {
        if ($queue.Count + $controls.Count -ge 256 -or $clock.ElapsedMilliseconds -gt 1500) { throw 'TERMINAL_CONTROL_TREE_LIMIT' }
        $queue.Enqueue($child)
      }
    }
    [void](Bound $r.fixture)
    @{ controls = $controls } | ConvertTo-Json -Depth 5 -Compress
  }
  'terminal-settings-open' {
    if (-not [Uc3fWindow]::DefaultDesktop()) { throw 'SECURE_DESKTOP_NO_INJECT' }
    $p = Bound $r.fixture
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
    $w = [Windows.Automation.AutomationElement]::FromHandle([IntPtr]([Int64]$r.fixture.windowId))
    if ($null -eq $w -or $w.Current.ProcessId -ne $p.Id) { throw 'FIXTURE_IDENTITY_CHANGED' }
    # Terminal 1.24 exposes the flyout on this exact SplitButton.
    $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::AutomationIdProperty,'NewTabButton')
    $dropdown = @($w.FindAll([Windows.Automation.TreeScope]::Descendants,$condition) | Where-Object {
      $_.Current.ControlType -eq [Windows.Automation.ControlType]::SplitButton -and $_.Current.ProcessId -eq $p.Id
    })
    if ($dropdown.Count -ne 1) { throw 'TERMINAL_SETTINGS_CONTROL_UNAVAILABLE' }
    if (-not $dropdown[0].GetCurrentPropertyValue([Windows.Automation.AutomationElement]::IsExpandCollapsePatternAvailableProperty)) {
      throw 'TERMINAL_SETTINGS_CONTROL_UNAVAILABLE'
    }
    [void](Bound $r.fixture)
    if (-not [Uc3fWindow]::DefaultDesktop()) { throw 'SECURE_DESKTOP_NO_INJECT' }
    $dropdown[0].GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()
    '{"opened":true}'
  }
  'terminal-settings' {
    if (-not [Uc3fWindow]::DefaultDesktop()) { throw 'SECURE_DESKTOP_NO_INJECT' }
    $p = Bound $r.fixture
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
    $condition = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ProcessIdProperty,$p.Id)
    $roots = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,$condition)
    $settings = @()
    foreach ($root in $roots) {
      $menus = $root.FindAll([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::MenuItem)))
      $settings += @($menus | Where-Object { $_.Current.Name -ceq 'Settings' -and $_.Current.ProcessId -eq $p.Id })
    }
    if ($settings.Count -ne 1) { throw 'TERMINAL_SETTINGS_CONTROL_UNAVAILABLE' }
    [void](Bound $r.fixture)
    if (-not [Uc3fWindow]::DefaultDesktop()) { throw 'SECURE_DESKTOP_NO_INJECT' }
    $settings[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
    '{"opened":true}'
  }
  default { throw 'INVALID_OPERATION' }
}
`;

export const FIXTURE_LAUNCHER = String.raw`
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Management.Automation;
using System.Management.Automation.Runspaces;
public static class Uc3fFixtureMain {
  static string Safe(string value) {
    return value != null && System.Text.RegularExpressions.Regex.IsMatch(value, @"\A[A-Za-z0-9_.]{1,160}\z") ? value : "UNAVAILABLE";
  }
  static void StartupFailure(string bank, IEnumerable<ErrorRecord> errors) {
    try {
      var records = new StringBuilder("{\"errors\":["); int count = 0;
      foreach(var error in errors) {
        if (count++ == 8) break;
        if (count > 1) records.Append(',');
        int line = error.InvocationInfo == null ? 0 : Math.Max(0, error.InvocationInfo.ScriptLineNumber);
        records.Append("{\"line\":").Append(line).Append(",\"type\":\"")
          .Append(Safe(error.Exception.GetType().FullName)).Append("\",\"category\":\"")
          .Append(Safe(error.CategoryInfo.Category.ToString())).Append("\"}");
      }
      records.Append("]}");
      using(var file = new FileStream(Path.Combine(bank, "receiver-startup.json"), FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
        var bytes = new UTF8Encoding(false).GetBytes(records.ToString()); file.Write(bytes, 0, bytes.Length);
      }
    } catch { /* Missing diagnostics never turns a failed launch into success. */ }
  }
  [STAThread] public static int Main(string[] args) {
    if(args.Length != 1 || !System.Text.RegularExpressions.Regex.IsMatch(args[0], @"\AC:\\sleight-setup\\uc3f-[a-f0-9]{16}\z")) return 1;
    using(var runspace = RunspaceFactory.CreateRunspace()) {
      runspace.ApartmentState = System.Threading.ApartmentState.STA;
      runspace.ThreadOptions = PSThreadOptions.UseCurrentThread; runspace.Open();
      using(var ps = PowerShell.Create()) {
        ps.Runspace = runspace;
        ps.AddScript(File.ReadAllText(Path.Combine(args[0], "receiver.ps1"))).AddParameter("Bank",args[0]).AddParameter("Token",Path.GetFileName(args[0]));
        try {
          ps.Invoke();
          if (ps.HadErrors) StartupFailure(args[0], ps.Streams.Error);
          return ps.HadErrors ? 1 : 0;
        } catch (RuntimeException error) {
          StartupFailure(args[0], new[] { error.ErrorRecord }); return 1;
        }
      }
    }
  }
}
`;

// Disposable WPF receiver. It records message numbers, key state and ticks only.
// The prompt button starts one short-lived elevated no-op after an owner go.
export const GUEST_FIXTURE = String.raw`
param([string]$Bank,[string]$Token)
$ErrorActionPreference = 'Stop'
if ($Bank -cnotmatch '^C:\\sleight-setup\\uc3f-[a-f0-9]{16}$' -or $Token -cnotmatch '^uc3f-[a-f0-9]{16}$') { exit 1 }
# UC3F_PREFLIGHT
Add-Type -AssemblyName PresentationFramework,PresentationCore,WindowsBase
Add-Type -ReferencedAssemblies WindowsBase,PresentationCore -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Windows.Interop;
public static class Uc3fReceiver {
  [DllImport("kernel32.dll")] public static extern ulong GetTickCount64();
  public static readonly HwndSourceHook Callback = Hook;
  public static long posts, ups, downs, escapes;
  public static HashSet<long> held = new HashSet<long>();
  public static List<string> events = new List<string>();
  public static bool truncated;
  public static void Publish(string path, string record) {
    string pending = path + ".pending";
    File.WriteAllText(pending, record, new UTF8Encoding(false));
    if (File.Exists(path)) File.Replace(pending, path, null);
    else File.Move(pending, path);
  }
  public static IntPtr Hook(IntPtr w,int message,IntPtr key,IntPtr data,ref bool handled) {
    if(message == 0x100 || message == 0x101 || message == 0x102 || message == 0x104 || message == 0x105) {
      posts++;
      if(message == 0x100 || message == 0x104) { downs++; held.Add(key.ToInt64()); if(key.ToInt64() == 27) escapes++; }
      if(message == 0x101 || message == 0x105) { ups++; held.Remove(key.ToInt64()); }
      if(events.Count < 32768) events.Add("{\"tickMs\":"+GetTickCount64()+",\"message\":"+message+"}");
      else truncated=true;
    }
    return IntPtr.Zero;
  }
}
'@
$window = New-Object Windows.Window
$window.Title = 'Sleight WDR7 WPF'
$window.Width = 640; $window.Height = 480
$stack = New-Object Windows.Controls.StackPanel
$editor = New-Object Windows.Controls.TextBox
[Windows.Automation.AutomationProperties]::SetAutomationId($editor,'Editor')
$editor.AcceptsReturn = $true; $editor.Height = 160; $editor.Text = 'UC3F'
$button = New-Object Windows.Controls.Button
[Windows.Automation.AutomationProperties]::SetAutomationId($button,'InvokeButton')
$button.Content = 'Invoke fixture'
$script:invocations = 0
$button.Add_Click({ $script:invocations++ })
$uac = New-Object Windows.Controls.Button
[Windows.Automation.AutomationProperties]::SetAutomationId($uac,'UacButton')
$uac.Content = 'Raise one owner-answered prompt'
$script:promptPending = $false
$script:promptChildExitConfirmed = $true
$uac.Add_Click({
  if ($script:promptPending) { return }
  if ($r.presence -cne 'present' -or -not [Uc3fWindow]::DefaultDesktop()) { return }
  $script:promptPending = $true
  try {
    $p = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Verb RunAs -WorkingDirectory $Bank -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-Command','exit') -PassThru
    $script:promptChildExitConfirmed = $false
    if (-not $p.WaitForExit(10000)) { throw 'PROMPT_CHILD_EXIT_UNPROVED' }
    $script:promptChildExitConfirmed = $true
  } catch { } finally { $script:promptPending = $false }
})
[void]$stack.Children.Add($editor); [void]$stack.Children.Add($button); [void]$stack.Children.Add($uac)
$window.Content = $stack
$window.Add_ContentRendered({ [void]$editor.Focus() })
$script:hook = [Uc3fReceiver]::Callback
$window.Add_SourceInitialized({
  $handle = (New-Object Windows.Interop.WindowInteropHelper($window)).Handle
  $script:source = [Windows.Interop.HwndSource]::FromHwnd($handle)
  $script:source.AddHook($script:hook)
})
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(10)
$timer.Add_Tick({
  $record = @{ tickMs = [Uc3fReceiver]::GetTickCount64(); postedMessages = [Uc3fReceiver]::posts;
    keyUps = [Uc3fReceiver]::ups; keyDowns = [Uc3fReceiver]::downs; escapeDowns = [Uc3fReceiver]::escapes;
    keyUpsDelivered = ([Uc3fReceiver]::held.Count -eq 0); truncated = [Uc3fReceiver]::truncated;
    textLength = $editor.Text.Length; invocations = $script:invocations;
    promptChildExitConfirmed = $script:promptChildExitConfirmed;
    events = @([Uc3fReceiver]::events | ForEach-Object { $_ | ConvertFrom-Json }) } | ConvertTo-Json -Depth 4 -Compress
  $path = Join-Path $Bank 'receiver.json'
  [Uc3fReceiver]::Publish($path,$record)
})
$window.Add_Closed({ $timer.Stop(); if($null -ne $script:source) { $script:source.RemoveHook($script:hook) } })
$timer.Start()
[void]$window.ShowDialog()
`;

function guestContext(o, operation) {
  const json = JSON.stringify({ bank: o.bank, operation, presence: o.ownerAway ? 'away' : 'present' });
  return `$r = '${json.replaceAll("'", "''")}' | ConvertFrom-Json\n`;
}

export function guestFixtureSource(o = {}) {
  // The embedded GUI runspace has no console. Only CLI protocol writers set
  // Console.OutputEncoding. The receiver publishes its own UTF-8 files.
  const preflight = GUEST_OPERATIONS.split('switch ($r.operation)')[0]
    .replace('[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\n', '');
  const source = GUEST_FIXTURE.replace('# UC3F_PREFLIGHT', () => guestContext(o, 'fixture') + preflight);
  return o.typingTarget ? source.replaceAll('receiver.json', 'typing-receiver.json')
    .replace("$editor.Text = 'UC3F'", "$editor.Text = 'Owner typing target ' + $Token") : source;
}

export async function openTerminalSettings({ beforeInput, check, inspect, call }, fixture) {
  for (const operation of ['terminal-settings-open', 'terminal-settings']) {
    await beforeInput?.();
    await check(); await inspect(fixture);
    await call(operation, { fixture });
  }
}

// The task receives one read frame and a new nonce. It does not inherit the
// parent's client or approval state. Native text is projected inside the task.
export async function runDirectTrial({ target, override, bank, tick, now, psCall, prepare,
  writeOwned, read, check, sleep, nextInvocation, rowId, ownerAway, transportInvocation, executableOf = windowsHostExecutable, exists = existsSync }) {
  await check();
  const host = await prepare({ platform: 'win32', kind: 'driver' });
  if (host.status !== 'ready') fail('DRIVER_UNAVAILABLE');
  const executable = executableOf(host.receipt, { platform: 'win32' });
  const invocation = nextInvocation(), nonce = randomBytes(32).toString('hex');
  if (!/^[0-9]{1,4}$/.test(invocation)) fail('INVOCATION_LIMIT');
  const frame = { protocol: 'sleight.windows-driver/1', nonce, id: 1, method: 'getApp', params: { selector: { windowId: target.windowId } } };
  const quote = s => "'" + String(s).replaceAll("'", "''") + "'";
  const prefix = transportInvocation ? rowFilePrefix(transportInvocation, rowId) : '';
  const output = win32.join(bank, `${prefix}direct-${invocation}.jsonl`);
  const script = GUEST_FAILURE + '\ntry {\n' + guestContext({ bank, ownerAway }, 'direct') +
    GUEST_OPERATIONS.split('switch ($r.operation)')[0] + `\n` + String.raw`
$child = New-Object Diagnostics.Process
$started = $false
$child.StartInfo.WorkingDirectory = $r.bank
$child.StartInfo.UseShellExecute = $false
$child.StartInfo.CreateNoWindow = $true
$child.StartInfo.RedirectStandardInput = $true
$child.StartInfo.RedirectStandardOutput = $true
$child.StartInfo.RedirectStandardError = $true
$child.StartInfo.EnvironmentVariables.Clear()
foreach ($key in @('SystemRoot','WINDIR','TEMP','TMP')) {
  $value = [Environment]::GetEnvironmentVariable($key)
  if ($null -ne $value) { $child.StartInfo.EnvironmentVariables[$key] = $value }
}
` + `$child.StartInfo.EnvironmentVariables['SLEIGHT_DRIVER_NONCE'] = ${quote(nonce)}\n` +
    `$child.StartInfo.EnvironmentVariables['SLEIGHT_DRIVER_COUNTERS'] = '1'\n` +
    (override ? `$child.StartInfo.EnvironmentVariables['SLEIGHT_ALLOW_FORBIDDEN_TARGETS'] = '1'\n` : '') +
    `$child.StartInfo.FileName = ${quote(executable)}\n$child.StartInfo.Arguments = '--driver'\n` +
    `$frame = ${quote(JSON.stringify(frame))} | ConvertFrom-Json\n` + String.raw`
$frame | Add-Member -NotePropertyName deadline -NotePropertyValue ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+30000)
try {
  if (-not $child.Start()) { throw 'DIRECT_LAUNCH_FAILED' }
  $started = $true
  $errors = $child.StandardError.ReadToEndAsync()
  $line = $child.StandardOutput.ReadLineAsync()
  $child.StandardInput.WriteLine(($frame | ConvertTo-Json -Depth 5 -Compress))
  if (-not $line.Wait(35000)) { throw 'DIRECT_REPLY_TIMEOUT' }
  if ($line.Result.Length -gt 4194304) { throw 'DIRECT_REPLY_INVALID' }
  $reply = $line.Result | ConvertFrom-Json
  if ($reply.nonce -cne $frame.nonce -or $reply.protocol -cne $frame.protocol -or $reply.id -ne 1) { throw 'DIRECT_REPLY_INVALID' }
  $data = if ($reply.ok) { $reply.result } else { $reply.error }
  $raw = @{ ok = [bool]$reply.ok }
  foreach ($key in @('code','reason','delivery','retry','unhealthy','typed','escapeStops','counters')) {
    if ($data.PSObject.Properties.Name -contains $key) { $raw[$key] = $data.$key }
  }
  if ($reply.ok -and $data.PSObject.Properties.Name -contains 'window') {
    $raw.window = @{}
    foreach ($key in @('windowId','pid','processStart','image')) {
      if ($data.window.PSObject.Properties.Name -contains $key) { $raw.window[$key] = $data.window.$key }
    }
  }
` + `  @{ id = 1; replyId = $reply.id; pid = $child.Id; raw = $raw } | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath ${quote(output)} -Encoding UTF8\n` + String.raw`
} finally {
  $child.Dispose()
}
` + `\n} catch { @{ guestCode = (GuestFailure $_) } | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quote(output)} -Encoding UTF8 }\n`;
  const scriptPath = writeOwned(`${prefix}direct-${invocation}.ps1`, script);
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
  await psCall('register-injector', { invocation, arguments: args.map(a => '"' + a.replaceAll('"', '') + '"').join(' ') });
  const started = tick(), deadline = now() + 45000;
  let busyReads = 0;
  while (now() < deadline) {
    await check();
    if (exists(output)) {
      let result;
      try { result = JSON.parse(read(output)); }
      catch (error) {
        // Set-Content can briefly hold this owned reply open while publishing.
        // Recheck the row on each retry; identity and parse failures still stop.
        if (error.code !== 'EBUSY' || busyReads++ >= 3) throw error;
        await sleep(50); continue;
      }
      if (typeof result.guestCode === 'string') fail(/^[A-Z][A-Z0-9_]{0,79}$/.test(result.guestCode) ? result.guestCode : 'DIRECT_REPLY_INVALID');
      if (result.id !== 1 || result.replyId !== 1 || !uint(result.pid) || !object(result.raw)) fail('DIRECT_REPLY_INVALID');
      return { driver: [{ tickMs: started, replyTickMs: tick(), raw: directReply(result.raw, target, projectReply) }],
        parent: { jobId: result.id, jobReplyId: result.replyId, driverPid: result.pid },
        launch: { source: 'scheduled-direct', override, nonceSha256: digest(nonce) } };
    }
    await sleep(10);
  }
  fail('DIRECT_REPLY_TIMEOUT');
}

export function inspectorBinding(fixture) {
  return Object.fromEntries(['pid', 'processStart', 'windowId', 'image', 'title', 'className',
    'coreWindowId', 'framePid', 'frameProcessStart', 'frameImage', 'refusalOnly', 'activationSince', 'baselineWindows']
    .filter(k => Object.hasOwn(fixture, k)).map(k => [k, fixture[k]]));
}

export function createGuestInspector({ bank, ownerAway, executable, env, writeOwned, spawnChild = spawn }) {
  const nonce = randomBytes(32).toString('hex');
  const header = GUEST_OPERATIONS.split('switch ($r.operation)')[0];
  const inspectBody = /'inspect' \{\n([^]*?)\n  \}\n  'launch'/.exec(GUEST_OPERATIONS)?.[1];

  if (!inspectBody) fail('INSPECTOR_SOURCE_INVALID');
  const script = 'param([string]$Bank,[string]$Nonce)\n[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\n[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)\n' + GUEST_FAILURE + guestContext({ bank, ownerAway }, 'inspect') +
    '\ntry {\n' + header + '\n} catch { [Console]::Error.WriteLine((GuestFailure $_)); exit 1 }\n' +
    '\nwhile ($null -ne ($line = [Console]::ReadLine())) {\ntry {\n' +
    '$message = $null\n$message = $line | ConvertFrom-Json\nif ($message.nonce -cne $Nonce) { throw "INSPECTOR_PROTOCOL" }\n' +
    '$r | Add-Member -NotePropertyName fixture -NotePropertyValue $message.fixture -Force\n' +
    '\n$value = & {\n' + inspectBody + '\n} | ConvertFrom-Json\n' +
    '@{ nonce = $Nonce; id = $message.id; ok = $true; value = $value } | ConvertTo-Json -Depth 4 -Compress\n' +
    '} catch {\n$id = if ($null -ne $message) { $message.id } else { 0 }\n@{ nonce = $Nonce; id = $id; ok = $false; code = (GuestFailure $_) } | ConvertTo-Json -Compress\n}\n}\n';
  const path = writeOwned(`identity-worker-${nonce}.ps1`, script);
  const child = spawnChild(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path,
    '-Bank', bank, '-Nonce', nonce], { cwd: bank, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let next = 0, buffer = '', stderr = '', dead = false, closing = false, closeResolve;
  const pending = new Map(), closed = new Promise(done => { closeResolve = done; });
  const rejectAll = () => {
    dead = true;
    const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(stderr.trim()) ? stderr.trim() : 'INSPECTOR_EXIT';
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(Object.assign(Error(code), { code })); }
    pending.clear();
  };
  child.on('error', rejectAll);
  child.on('close', () => { rejectAll(); closeResolve(); });
  child.stdin.on('error', rejectAll);
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(0, 128); });
  child.stdout.on('data', bytes => {
    buffer += bytes.toString('utf8');
    if (Buffer.byteLength(buffer) > 16384) { rejectAll(); return; }
    for (let at; (at = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, at).replace(/^\uFEFF/, ''); buffer = buffer.slice(at + 1);
      let reply;
      try { reply = JSON.parse(line); } catch { rejectAll(); return; }
      const call = pending.get(reply.id);
      if (!call || reply.nonce !== nonce || typeof reply.ok !== 'boolean') { rejectAll(); return; }
      clearTimeout(call.timer); pending.delete(reply.id);
      if (reply.ok) call.resolve(reply.value);
      else {
        const code = typeof reply.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(reply.code) ? reply.code : 'INSPECTOR_PROTOCOL';
        call.reject(Object.assign(Error(code), { code }));
      }
    }
  });
  return {
    inspect(fixture) {
      if (dead || closing || pending.size >= 8) return Promise.reject(Object.assign(Error('INSPECTOR_EXIT'), { code: 'INSPECTOR_EXIT' }));
      return new Promise((resolveCall, reject) => {
        const id = ++next, timer = setTimeout(() => { rejectAll(); }, 10000);
        pending.set(id, { resolve: resolveCall, reject, timer });
        child.stdin.write(JSON.stringify({ id, nonce, fixture: inspectorBinding(fixture) }) + '\n');
      });
    },
    async close() {
      closing = true; child.stdin.end();
      let timer;
      try {
        await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => {
          child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
          reject(Object.assign(Error('INSPECTOR_EXIT'), { code: 'INSPECTOR_EXIT' }));
        }, 5000); })]);
      } finally { clearTimeout(timer); }
    },
  };
}

export function asciiJSON(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

export function assertFixtureArguments(args) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || !arg || /[\s"']/.test(arg))) fail('FIXTURE_ARGUMENT_UNSAFE');
  return args;
}

export function powershellCall(o, { execute = runChild, validateBank = checkBank } = {}) {
  const env = sitting.collectorWindowsEnv(process.env);
  const ps = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return async (operation, values = {}) => {
    if (operation === 'launch') assertFixtureArguments(values.args);
    validateBank(o.bank);
    const payload = asciiJSON({ ...values, operation, bank: o.bank, root: ROOT,
      presence: o.ownerAway ? 'away' : 'present', vmId: o.expected?.vmId ?? null }).replaceAll("'", "''");
    const input = `& {
${GUEST_FAILURE}
try {
$r = '${payload}' | ConvertFrom-Json
$launchFailure = 'GUEST_EXCEPTION_UNCLASSIFIED'
${GUEST_OPERATIONS}
[Console]::Out.WriteLine('SLEIGHT_GUEST_OK')
} catch { [Console]::Error.WriteLine((GuestFailure $_ ${operation === 'launch' ? '$launchFailure' : "'GUEST_EXCEPTION_UNCLASSIFIED'"})); exit 1 }
}

`;
    const result = await execute(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'],
      { cwd: o.bank, env, input, timeout: 60000, maxBytes: 32768, lowPriority: true });
    if (result.status !== 0 || result.signal || result.reason || result.cleanup === 'tree-unconfirmed') {
      const code = /^[A-Z][A-Z0-9_]{0,79}$/.test(result.stderr?.trim() ?? '') ? result.stderr.trim() : 'GUEST_OPERATION_FAILED';
      fail(code);
    }
    const output = guestCommandOutput(result.stdout);
    try { return JSON.parse(output); } catch { fail('GUEST_OPERATION_FAILED'); }
  };
}
