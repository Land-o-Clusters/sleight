import assert from 'node:assert/strict';

export const driverFiles = ['Driver.cs', 'DriverInventory.cs', 'DriverCapture.cs', 'DriverIdentity.cs', 'DriverUia.cs',
  'DriverActions.cs', 'DriverActionPlan.cs', 'DriverInput.cs', 'DriverHook.cs', 'DriverPatterns.cs', 'DriverSettle.cs', 'DriverClipboard.cs'];

// As in wlg2, adapt copied sources only. Preserve guard, typing, callback and
// pump bodies; replace external metadata, transport, timer and clock sources.
function once(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, 'unique native seam: ' + before);
  return source.replace(before, after);
}
function external(source, name, implementation) {
  const pattern = new RegExp('\\[DllImport\\([^\\n]+\\)\\]\\s*((?:internal )?static) extern ([^;]+?\\b' + name + '\\([^;]*?\\));', 'g');
  let count = 0;
  const changed = source.replace(pattern, (_all, modifiers, signature) => {
    count++;
    return modifiers + ' ' + signature + ' { ' + implementation + ' }';
  });
  assert.equal(count, 1, 'unique external declaration: ' + name);
  return changed;
}
export function headlessPerson(sources) {
  let input = sources['DriverInput.cs'], inventory = sources['DriverInventory.cs'], hook = sources['DriverHook.cs'];
  for (const [name, implementation] of [
    ['GetForegroundWindow', 'return PersonReviewChecks.Foreground;'],
    ['GetCursorPos', 'point = new DriverPoint(10, 20); return PersonReviewChecks.CursorOk;'],
    ['WindowFromPoint', 'return PersonReviewChecks.Pointer;'],
    ['GetWindowThreadProcessId', 'return PersonReviewChecks.Thread(hwnd, out pid);'],
    ['IsChild', 'return PersonReviewChecks.Child(parent, child);'],
    ['GetLastInputInfo', 'PersonReviewChecks.LastReads++; input.Time = PersonReviewChecks.LastInput; return PersonReviewChecks.LastOk;'],
    ['PostMessageW', 'return PersonReviewChecks.Post(hwnd, message, wParam, lParam);'],
    ['SendMessageTimeoutW', 'result = new UIntPtr(1); return new IntPtr(1);'],
    ['GetKeyboardLayout', 'return new IntPtr(1);'],
    ['MapVirtualKeyExW', 'return code;'],
  ]) input = external(input, name, implementation);
  input = once(input, 'age = unchecked((uint)Environment.TickCount - last);', 'age = unchecked(PersonReviewChecks.InputNow - last);');
  input = once(input, 'handle => DriverInventory.Observe(handle)', 'handle => PersonReviewChecks.Observe(handle)');
  for (const point of ['foreground', 'pointer']) input = once(input,
    `ActivityPid(${point}, ${point}Pid, window, DriverInput.IsChild, DriverInventory.LiveHostedAppPid)`,
    `ActivityPid(${point}, ${point}Pid, window, DriverInput.IsChild, PersonReviewChecks.Hosted)`);
  for (const [name, implementation] of [
    ['WTSQuerySessionInformationW', 'return PersonReviewChecks.Wts(typeof(WtsInfoEx), out data, out bytes);'],
    ['WTSFreeMemory', 'PersonReviewChecks.FreeWts(data);'],
    ['OpenInputDesktop', 'return PersonReviewChecks.OpenDesktop();'],
    ['CloseDesktop', 'return PersonReviewChecks.CloseDesktop(desktop);'],
    ['GetUserObjectInformationW', 'needed = 0; value.Append(PersonReviewChecks.Desktop); return PersonReviewChecks.DesktopNameOk;'],
  ]) inventory = external(inventory, name, implementation);
  for (const [name, implementation] of [
    ['SetWindowsHookEx', 'return PersonReviewChecks.Install(kind, callback, module, thread);'],
    ['UnhookWindowsHookEx', 'return PersonReviewChecks.Uninstall(hook);'],
    ['CallNextHookEx', 'return PersonReviewChecks.NextHook(code, message, data);'],
    ['GetModuleHandle', 'return new IntPtr(1);'],
    ['GetMessageW', 'message = new Message { Kind = PersonReviewChecks.NextMessage() }; return 1;'],
    ['TranslateMessage', 'return true;'],
    ['DispatchMessageW', 'PersonReviewChecks.Dispatched(message.Kind); return IntPtr.Zero;'],
    ['PostThreadMessageW', 'return PersonReviewChecks.QueueMessage(message);'],
  ]) hook = external(hook, name, implementation);
  hook = once(hook, 'readonly Stopwatch clock = Stopwatch.StartNew();', 'readonly PersonReviewClock clock = new PersonReviewClock();');
  hook = once(hook, 'Timer timer;', 'PersonReviewTimer timer;');
  hook = once(hook, 'timer = new Timer(', 'timer = new PersonReviewTimer(');
  return { ...sources, 'DriverInput.cs': input, 'DriverInventory.cs': inventory, 'DriverHook.cs': hook };
}

// Exercise Entry's real reader, worker and dispatch. Only its byte streams,
// DPI APIs and window enumeration are synthetic. No UIA reader is constructed:
// a valid action must activate the hook before returning STALE_READ.
export function headlessWiring(sources) {
  const adapted = headlessPerson(sources);
  let driver = adapted['Driver.cs'];
  for (const stream of ['Input', 'Output', 'Error']) driver = once(driver,
    `Console.OpenStandard${stream}()`, `PersonReviewChecks.Protocol${stream}`);
  return { ...adapted, 'Driver.cs': driver,
    'DriverInput.cs': external(adapted['DriverInput.cs'], 'SetProcessDpiAwarenessContext', 'return true;'),
    'DriverCapture.cs': external(adapted['DriverCapture.cs'], 'SetThreadDpiAwarenessContext', 'return new IntPtr(1);'),
    'DriverInventory.cs': once(adapted['DriverInventory.cs'], 'return WithPackagedSnapshot(() => WindowsSnapshot());',
      'return new List<WindowRecord>();'),
  };
}

// One native witness for each part of the contract. A variant changes the real
// guard or effect path, never the C# assertions or its external sources.
export const personVariants = [
  ['missing-person-before', 'DriverInput.cs', 'if (ageMs < 500 &&', 'if (ageMs < 0 &&', 'person-before'],
  ['wrong-500-boundary', 'DriverInput.cs', 'ageMs < 500 &&', 'ageMs <= 500 &&', 'person-boundary'],
  ['pointer-target-ignored', 'DriverInput.cs', ' || pointerPid == targetPid', '', 'pointer-target'],
  ['foreign-input-refuses', 'DriverInput.cs', 'foregroundPid == targetPid || pointerPid == targetPid', 'true', 'foreign-input'],
  ['missing-mid-type-person', 'DriverInput.cs', 'if (!cleanup) api.Person(window);', '', 'mid-type'],
  ['physical-escape-ignored', 'DriverHook.cs', 'Volatile.Write(ref owner.Escape, 1);', 'Volatile.Write(ref owner.Escape, 0);', 'physical-escape'],
  ['injected-escape-stops', 'DriverHook.cs', '(flags & 0x12) == 0', '(flags & 0x12) >= 0', 'injected-escape'],
  ['posted-escape-stops', 'DriverInput.cs', 'RequirePostMessage(message);', 'if (message == 0x100 && wParam == 0x1b) throw DriverSession.Refusal("USER_STOPPED", "escape"); RequirePostMessage(message);', 'posted-escape'],
  ['escape-eaten', 'DriverHook.cs', 'IntPtr next = CallNextHookEx(IntPtr.Zero, code, message, data);', 'IntPtr next = IntPtr.Zero;', 'escape-forwarded'],
  ['escape-replay-clears', 'DriverHook.cs', 'if (turn != null && turn.Id == id) return;', 'if (turn != null && turn.Id == id) { turn.Escape = 0; return; }', 'escape-rest-of-turn'],
  ['mouse-hook-installed', 'DriverHook.cs', 'SetWindowsHookEx(13, callback,', 'SetWindowsHookEx(14, callback,', 'keyboard-only'],
  ['hook-never-installed', 'DriverHook.cs', 'installed = SetWindowsHookEx(13, callback, GetModuleHandle(null), 0);', 'installed = new IntPtr(91);', 'hook-installed'],
  ['idle-removal-early', 'DriverHook.cs', 'internal const int IdleMs = 60000;', 'internal const int IdleMs = 59999;', 'hook-idle-before'],
  ['idle-removal-late', 'DriverHook.cs', 'internal const int IdleMs = 60000;', 'internal const int IdleMs = 60001;', 'hook-idle-at'],
  ['idle-unhook-skipped', 'DriverHook.cs', 'removing == IntPtr.Zero || UnhookWindowsHookEx(removing)',
    'removing == IntPtr.Zero || clock.ElapsedMilliseconds - lastRequest >= IdleMs || UnhookWindowsHookEx(removing)', 'hook-native-removed'],
  ['request-idle-not-refreshed', 'DriverHook.cs', 'lastRequest = clock.ElapsedMilliseconds;\n            // EndTurn',
    '// EndTurn', 'hook-idle-refresh'],
  ['activate-idle-not-refreshed', 'DriverHook.cs', 'lastRequest = clock.ElapsedMilliseconds; requested = true;',
    'if (hook == IntPtr.Zero) lastRequest = clock.ElapsedMilliseconds; requested = true;', 'hook-activate-refresh'],
  ['end-turn-unhook-skipped', 'DriverHook.cs', 'turn = null; requested = false;',
    'turn = null; requested = false; hook = IntPtr.Zero;', 'hook-turn-end'],
  ['locked-session-allowed', 'DriverInventory.cs', 'if (flags == 0) return "session-locked";', 'if (flags == 0) return null;', 'session-locked'],
  ['screensaver-allowed', 'DriverInventory.cs', 'if (desktopName == "Screen-saver") return "screensaver";', 'if (desktopName == "Screen-saver") desktopName = "Default";', 'session-screensaver-bypass'],
  ['secure-desktop-allowed', 'DriverInventory.cs', 'if (!desktopOpened || desktopName == "Winlogon") return "secure-desktop";',
    'if (desktopOpened && desktopName == "Winlogon") desktopName = "Default"; if (!desktopOpened) return "secure-desktop";', 'session-secure-bypass'],
];

export const wiringVariants = [
  ['production-cancel-not-assigned', 'Driver.cs', 'DriverInput.Cancelled = () => {', 'Func<DriverInput.StopReason> unusedCancellation = () => {', 'production-escape-cancelled'],
  ['production-escape-not-wired', 'Driver.cs', 'inputBearing && job.Turn != null && job.Turn.Escaped', 'false && job.Turn != null && job.Turn.Escaped', 'production-escape-cancelled'],
  ['production-hook-not-activated', 'Driver.cs', 'actionHook.Activate(actionTurn);', '', 'production-hook-activated'],
  ['production-read-installs-hook', 'Driver.cs', 'if (plan != null) {', 'if (plan == null) actionHook.Activate(actionTurn);\n            if (plan != null) {', 'production-read-no-hook'],
];

export function mutatePerson(sources, variant) {
  const [, file, before, after] = variant;
  return { ...sources, [file]: once(sources[file], before, after) };
}

export function fakeDefaultPerson(sources) {
  return { ...sources, 'DriverInput.cs': external(sources['DriverInput.cs'], 'GetLastInputInfo',
    'input.Time = 0; return true;') };
}
