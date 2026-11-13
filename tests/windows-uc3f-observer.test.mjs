import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { syntheticObserver } from './fixtures/uc3f-observer-synthetic.mjs';

const scriptUrl = new URL('../bench/windows/uc3f-observer.ps1', import.meta.url);
const fixtureUrl = new URL('./fixtures/uc3f-observer-lines.jsonl', import.meta.url);
const schema = 'sleight.windows-uc3f-observer/2';
const common = ['schema', 'kind', 'tickMs', 'seq'];
const mouseSummary = ['firstTickMs', 'lastTickMs', 'firstEventTickMs', 'firstForegroundHwnd', 'firstForegroundPid', 'eventCount'];
const inputSummary = ['lastInputFirstTickMs', 'lastInputChanges'];
const foreground = ['foregroundHwnd', 'foregroundPid'];
const shapes = {
  start: ['sessionId', 'integrity', 'pollMs', 'maxRecords', 'heartbeatMs', 'maxBytes', 'invocation', 'rowToken', 'rowId'],
  poll: [...foreground, 'lastInputOk', 'lastInputTickMs', 'wtsOk', 'wtsState', 'wtsFlags', 'desktopOpened', 'desktop', 'pollCount', 'maxGapMs'],
  key: [...foreground, 'eventTickMs', 'key', 'phase', 'injected', 'lowerIntegrityInjected'],
  mouse: [...foreground, 'eventTickMs', 'phase', 'injected', 'lowerIntegrityInjected'],
  end: ['keyboardHookInstalled', 'mouseHookInstalled', 'keyboardHookRemoved', 'mouseHookRemoved', 'hookRemoved',
    'keyboardHookError', 'mouseHookError', 'truncated', 'callbackError', 'pollError', 'diskError', 'stopReason', 'records', 'pollCount'],
};
const bools = ['lastInputOk', 'wtsOk', 'desktopOpened', 'injected', 'lowerIntegrityInjected', 'keyboardHookInstalled',
  'mouseHookInstalled', 'keyboardHookRemoved', 'mouseHookRemoved', 'hookRemoved', 'truncated', 'callbackError', 'pollError', 'diskError'];
const uint32 = n => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff;
const maxSeconds = 900, pollMs = 10, maxRecords = 32768;
// Pin the values as well as the vocabulary. A DWORD-shaped raw key still leaks.
const projections = {
  start: { sessionId: 'sessionId', integrity: 'integrity', pollMs: 'PollMs', maxRecords: 'MaxRecords', heartbeatMs: 'HeartbeatMs', maxBytes: 'MaxBytes',
    invocation: 'invocation', rowToken: 'rowToken', rowId: 'rowId' },
  poll: { foregroundHwnd: 'hwnd', foregroundPid: 'pid', lastInputOk: 'inputOk', lastInputTickMs: 'inputOk ? input.tick : 0',
    wtsOk: 'wtsOk', wtsState: 'state', wtsFlags: 'flags', desktopOpened: 'desktopOpened', desktop: 'desktopName', pollCount: 'polls', maxGapMs: 'maxPollGap' },
  key: { foregroundHwnd: 'hwnd', foregroundPid: 'pid', eventTickMs: 'input.time',
    key: 'input.vkCode == 0x1b ? "escape" : "other"', phase: 'm == 0x100 || m == 0x104 ? "down" : "up"',
    injected: '(input.flags & 0x10) != 0', lowerIntegrityInjected: '(input.flags & 0x02) != 0' },
  mouse: { foregroundHwnd: 'hwnd', foregroundPid: 'pid', eventTickMs: 'input.time', phase: 'phase',
    injected: '(input.flags & 0x01) != 0', lowerIntegrityInjected: '(input.flags & 0x02) != 0' },
  end: { keyboardHookInstalled: 'keyboardInstalled', mouseHookInstalled: 'mouseInstalled',
    keyboardHookRemoved: 'keyboardRemoved', mouseHookRemoved: 'mouseRemoved', hookRemoved: 'keyboardRemoved && mouseRemoved',
    keyboardHookError: 'keyboardError', mouseHookError: 'mouseError', truncated: 'truncated', callbackError: 'callbackError',
    pollError: 'pollError', diskError: 'diskError', stopReason: 'reason', records: 'records + 1', pollCount: 'polls' },
};

// This is a consumer contract for synthetic lines, not a Windows execution mirror.
function parseLine(text) {
  assert.ok(Buffer.byteLength(text) <= 2048, 'line limit');
  const r = JSON.parse(text);
  assert.ok(r && !Array.isArray(r) && Object.hasOwn(shapes, r.kind), 'kind');
  const summary = r.kind === 'mouse' && Object.hasOwn(r, 'eventCount') ? mouseSummary :
    r.kind === 'poll' && Object.hasOwn(r, 'lastInputChanges') ? inputSummary : [];
  assert.deepEqual(Object.keys(r).filter(k => k !== 'leaseExpiresUtc').sort(), [...common, ...shapes[r.kind], ...summary].sort(), 'exact keys');
  assert.equal(r.schema, schema);
  assert.ok(Number.isSafeInteger(r.tickMs) && r.tickMs >= 0, 'boot tick');
  for (const name of bools) if (Object.hasOwn(r, name)) assert.equal(typeof r[name], 'boolean', name);
  if (r.kind === 'start') {
    assert.ok(uint32(r.sessionId) && r.sessionId > 0);
    assert.ok(['low', 'medium'].includes(r.integrity));
    assert.equal(r.pollMs, 10);
    assert.equal(r.maxRecords, maxRecords);
  }
  if (['poll', 'key', 'mouse'].includes(r.kind)) {
    assert.match(r.foregroundHwnd, /^0x[0-9a-f]{1,16}$/);
    assert.ok(uint32(r.foregroundPid));
  }
  if (r.kind === 'poll') {
    assert.ok(uint32(r.lastInputTickMs));
    for (const k of ['wtsState', 'wtsFlags']) assert.ok(Number.isInteger(r[k]) && r[k] >= -0x80000000 && r[k] <= 0x7fffffff);
    assert.ok(['Default', 'Winlogon', 'Screen-saver', 'other', 'unavailable'].includes(r.desktop));
    if (!r.lastInputOk) assert.equal(r.lastInputTickMs, 0);
    if (!r.wtsOk) { assert.equal(r.wtsState, -1); assert.equal(r.wtsFlags, -1); }
    if (!r.desktopOpened) assert.equal(r.desktop, 'unavailable');
  }
  if (r.kind === 'key' || r.kind === 'mouse') {
    assert.ok(uint32(r.eventTickMs));
    assert.ok((r.kind === 'key' ? ['down', 'up'] : ['move', 'down', 'up', 'wheel', 'other']).includes(r.phase));
    if (r.kind === 'key') assert.ok(['escape', 'other'].includes(r.key), 'coarse key');
  }
  if (r.kind === 'end') {
    assert.equal(r.hookRemoved, r.keyboardHookRemoved && r.mouseHookRemoved);
    for (const k of ['keyboardHookError', 'mouseHookError', 'records']) assert.ok(uint32(r[k]));
    assert.ok(r.records >= 2 && r.records <= maxRecords);
    assert.ok(['completed', 'stop-requested', 'lease-expired', 'lease-revoked', 'record-limit', 'hook-install-failed', 'observer-error', 'disk-error', 'stop-invalid'].includes(r.stopReason));
  }
  for (const value of Object.values(r)) if (typeof value === 'string') {
    assert.ok(Buffer.byteLength(value) <= 256, 'field limit');
    assert.doesNotMatch(value, /iVBORw0KGgo|[\r\n]/);
  }
  return r;
}

const script = () => readFileSync(scriptUrl, 'utf8');
const uncomment = text => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|^\s*#[^\n]*/gm, '');
const csharp = text => /Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/.exec(text)?.[1] ?? '';
function body(text, signature) {
  const start = text.indexOf(signature);
  assert.ok(start >= 0, signature);
  const open = text.indexOf('{', start);
  let depth = 1, end = open + 1;
  for (; end < text.length && depth; end++) {
    if (text[end] === '{') depth++;
    if (text[end] === '}') depth--;
  }
  assert.equal(depth, 0, 'balanced body');
  return text.slice(open + 1, end - 1);
}

function recordFields(cs) {
  const fields = {};
  for (const match of cs.matchAll(/\bRow\("([a-z]+)"/g)) {
    let depth = 1, quoted = false, start = match.index + 4;
    const args = [];
    for (let n = start; n < cs.length && depth; n++) {
      const c = cs[n];
      if (c === '"' && cs[n - 1] !== '\\') quoted = !quoted;
      if (quoted) continue;
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (c === ',' && depth === 1 || depth === 0) { args.push(cs.slice(start, n).trim()); start = n + 1; }
    }
    assert.equal(depth, 0);
    assert.equal(args.length % 2, 1, 'record key/value pairs');
    assert.equal(Object.hasOwn(fields, match[1]), false, 'one projection per kind');
    fields[match[1]] = Object.fromEntries(args.flatMap((s, n) => n % 2 === 1 ? [[JSON.parse(s), args[n + 1]]] : []));
    assert.equal(Object.keys(fields[match[1]]).length, (args.length - 1) / 2, 'unique record keys');
  }
  for (const [, name, value] of cs.matchAll(/snapshot\.Add\("([^"\n]+)", ([^)]+)\)/g)) if (!inputSummary.includes(name)) fields.poll[name] = value;
  return fields;
}

// These are the reviewed read/observe/handle-lifetime imports. No dynamic binding.
const native = {
  GetTickCount64: 'kernel32.dll', GetModuleHandleW: 'kernel32.dll', GetCurrentProcess: 'kernel32.dll', CloseHandle: 'kernel32.dll',
  OpenProcessToken: 'advapi32.dll', GetTokenInformation: 'advapi32.dll', GetSidSubAuthorityCount: 'advapi32.dll', GetSidSubAuthority: 'advapi32.dll',
  GetForegroundWindow: 'user32.dll', GetWindowThreadProcessId: 'user32.dll', GetLastInputInfo: 'user32.dll',
  SetWindowsHookExW: 'user32.dll', UnhookWindowsHookEx: 'user32.dll', CallNextHookEx: 'user32.dll',
  PeekMessageW: 'user32.dll', TranslateMessage: 'user32.dll', DispatchMessageW: 'user32.dll',
  MsgWaitForMultipleObjectsEx: 'user32.dll',
  OpenInputDesktop: 'user32.dll', GetUserObjectInformationW: 'user32.dll', CloseDesktop: 'user32.dll',
  WTSQuerySessionInformationW: 'wtsapi32.dll', WTSFreeMemory: 'wtsapi32.dll',
};

function readOnlyPolicy(text) {
  const code = uncomment(text), cs = csharp(code);
  assert.ok(cs, 'embedded C#');
  assert.doesNotMatch(code, /\b(?:SendInput|keybd_event|mouse_event|SetForegroundWindow|SetFocus|AttachThreadInput|SetCursorPos|PostMessage\w*|SendMessage\w*|GetWindowText\w*|GetKeyboardState|GetAsyncKeyState|ToUnicode\w*|Clipboard\w*|LogonUser\w*|CredUI\w*|tscon|LockWorkStation|Process\.Start)\b/i, 'read-only');
  assert.doesNotMatch(code, /\b(?:System\.Net|HttpClient|WebClient|TcpClient|Socket|Invoke-WebRequest|Invoke-RestMethod|Invoke-Expression|Start-Process|curl|wget|ssh|scp|iwr|irm)\b/i, 'no network or launcher');
  assert.doesNotMatch(code, /\b(?:BitBlt|PrintWindow|GetDC|CopyFromScreen|Bitmap|ScreenCapture|Graphics)\b/i, 'no capture');
  assert.doesNotMatch(cs, /\b(?:EntryPoint|LibraryImport|GetProcAddress|NativeLibrary|DynamicInvoke|GetDelegateForFunctionPointer)\b|\\[uU][0-9a-fA-F]|\busing\s+\w+\s*=/, 'no hidden import');
  const imports = [...cs.matchAll(/\[DllImport\("([^"\n]+)"[^\]]*\)\]\s*static extern \w+ (\w+)\([^;]+;/g)];
  assert.equal(imports.length, (cs.match(/\bDllImport\b/g) ?? []).length, 'all imports parsed');
  assert.deepEqual(imports.map(m => m[2]).sort(), Object.keys(native).sort(), 'native import set');
  for (const [, dll, name] of imports) assert.equal(dll, native[name], name);
  const fields = recordFields(cs);
  assert.deepEqual(Object.keys(fields).sort(), Object.keys(shapes).sort(), 'record kinds');
  for (const [kind, values] of Object.entries(fields)) {
    assert.deepEqual(Object.keys(values).sort(), shapes[kind].toSorted(), kind + ': output keys');
    assert.deepEqual(values, projections[kind], kind + ': output values');
  }
  const aggregate = body(cs, 'static void CoalesceMouse(');
  assert.match(aggregate, /row\["firstTickMs"\] = row\["tickMs"\];/);
  assert.match(aggregate, /row\["firstEventTickMs"\] = row\["eventTickMs"\];/);
  assert.match(aggregate, /row\["firstForegroundHwnd"\] = row\["foregroundHwnd"\];/);
  assert.match(aggregate, /row\["firstForegroundPid"\] = row\["foregroundPid"\];/);
  assert.doesNotMatch(aggregate, /input\./);
  const keyboard = body(cs, 'static IntPtr Keyboard(');
  const coarseOnly = keyboard.replace('input.vkCode == 0x1b ? "escape" : "other"', '"coarse"');
  assert.doesNotMatch(coarseOnly, /input\.(?:vkCode|scanCode|extraInfo)/, 'raw key used outside coarse label');
  assert.doesNotMatch(body(cs, 'static IntPtr Mouse('), /input\.(?:point|mouseData|extraInfo)/, 'raw mouse details');
  assert.deepEqual([...cs.matchAll(/\brow\.Add\("([^"]+)"/g)].map(m => m[1]), common.filter(k => k !== 'seq'), 'shared keys');
  assert.match(cs, /const string Schema = "sleight\.windows-uc3f-observer\/2";/);
}

function guardsPolicy(text) {
  const code = uncomment(text);
  assert.match(code, /\[ValidateRange\(1,900\)\]\[int\]\$Seconds/);
  assert.match(code, /\$env:OS -ne 'Windows_NT'/);
  assert.match(code, /SessionId -eq 0\) \{ throw 'INTERACTIVE_SESSION_REQUIRED'/);
  assert.match(code, /IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)\) \{ throw 'UNELEVATED_REQUIRED'/);
  assert.match(code, /\$maker -notmatch '\^\(\?:QEMU\|VMware, Inc\\\.\|innotek GmbH\|Parallels Software International Inc\\\.\)\$'/);
  assert.match(code, /\$maker -ceq 'Microsoft Corporation' -and \$machine\.Model -ceq 'Virtual Machine'/);
  assert.match(code, /throw 'NOT_VM'/);
  assert.match(code, /\$Bank -cnotmatch '\^C:\\\\sleight-setup\\\\uc3f-\[a-f0-9\]\{16\}\$'/);
  assert.match(code, /FileAttributes\]::ReparsePoint/);
  assert.ok(code.indexOf("throw 'NOT_VM'") < code.indexOf('Add-Type -TypeDefinition'));
  assert.match(code, /FileMode\.CreateNew/);
  assert.match(code, /FileShare\.Read/);
  assert.match(code, /finally \{ stream\.Dispose\(\); \}/);
}

function observationPolicy(text) {
  const cs = csharp(uncomment(text));
  const run = body(cs, 'public static bool Run(');
  assert.doesNotMatch(cs, /Thread\.Sleep|Task\.Delay/);
  assert.match(cs, /static extern uint MsgWaitForMultipleObjectsEx\(uint count, IntPtr handles, uint milliseconds, uint wakeMask, uint flags\);/);
  assert.match(run, /long nextPoll = 0;/);
  assert.match(run, /if \(watch\.ElapsedMilliseconds >= nextPoll\)\s*\{[\s\S]*?Poll\(sessionId, false\);\s*nextPoll = watch\.ElapsedMilliseconds \+ PollMs;\s*\}/);
  assert.match(run, /uint waitMs = \(uint\)Math\.Max\(0L, Math\.Min\(nextPoll, seconds \* 1000L\) - watch\.ElapsedMilliseconds\);/);
  assert.match(run, /MsgWaitForMultipleObjectsEx\(0, IntPtr\.Zero, waitMs, 0x04ff, 0x0004\) == 0xffffffff/);
  assert.match(run, /throw new InvalidOperationException\("MESSAGE_WAIT_FAILED"\)/);
  assert.match(run, /SetWindowsHookExW\(13, keyboardCallback, GetModuleHandleW\(null\), 0\)/);
  assert.match(run, /SetWindowsHookExW\(14, mouseCallback, GetModuleHandleW\(null\), 0\)/);
  assert.match(run, /finally\s*\{[\s\S]*UnhookWindowsHookEx\(keyboardHook\)[\s\S]*UnhookWindowsHookEx\(mouseHook\)[\s\S]*GC\.KeepAlive\(keyboardCallback\)[\s\S]*GC\.KeepAlive\(mouseCallback\)/);
  assert.match(run, /"hookRemoved", keyboardRemoved && mouseRemoved/);
  assert.match(run, /"truncated", truncated, "callbackError", callbackError, "pollError", pollError/);
  capacityPolicy(text);
  for (const name of ['Keyboard', 'Mouse']) {
    const callback = body(cs, `static IntPtr ${name}(`);
    assert.equal((callback.match(/\breturn\b/g) ?? []).length, 1, 'never swallow');
    assert.match(callback, /return CallNextHookEx\(/);
    assert.match(callback, /code == 0/);
  }
  const keyboard = body(cs, 'static IntPtr Keyboard(');
  assert.match(keyboard, /"key", input\.vkCode == 0x1b \? "escape" : "other"/);
  assert.match(keyboard, /"injected", \(input\.flags & 0x10\) != 0/);
  assert.match(keyboard, /"lowerIntegrityInjected", \(input\.flags & 0x02\) != 0/);
  const mouse = body(cs, 'static IntPtr Mouse(');
  assert.match(mouse, /"injected", \(input\.flags & 0x01\) != 0/);
  assert.match(mouse, /"lowerIntegrityInjected", \(input\.flags & 0x02\) != 0/);
  const poll = body(cs, 'static void Poll(');
  assert.match(poll, /GetLastInputInfo\(ref input\)/);
  assert.match(poll, /WTSQuerySessionInformationW\(IntPtr\.Zero, sessionId, 25,/);
  assert.match(poll, /bytes >= Marshal\.SizeOf\(typeof\(WtsInfoEx\)\)/);
  assert.match(poll, /info\.Level == 1 && info\.Data\.Session == sessionId/);
  assert.match(poll, /finally \{ if \(buffer != IntPtr\.Zero\) WTSFreeMemory\(buffer\); \}/);
  assert.match(poll, /OpenInputDesktop\(0, false, 0x0001\)/);
  assert.match(poll, /finally \{ CloseDesktop\(desktop\); \}/);
  assert.match(poll, /name == "Default" \|\| name == "Winlogon" \|\| name == "Screen-saver" \? name : "other"/);
  assert.match(cs, /rid >= 0x3000\) throw new InvalidOperationException\("UNELEVATED_REQUIRED"\)/);
  assert.match(cs, /"integrity", integrity/);
}

test('observer script and synthetic line fixtures exist', () => {
  assert.equal(existsSync(scriptUrl), true, 'observer script');
  assert.equal(existsSync(fixtureUrl), true, 'synthetic fixture');
});

test('observer uses only reviewed read-only APIs and no content or network route', () => readOnlyPolicy(script()));
test('observer requires an interactive unelevated VM, a fixed bank and a bounded row request', () => guardsPolicy(script()));
test('observer forwards both hooks, samples at 10 ms and reports cleanup and truncation', () => observationPolicy(script()));

function capacityPolicy(text) {
  const cs = csharp(uncomment(text));
  assert.match(cs, /const int MaxSeconds = 900;/);
  assert.match(cs, /const int PollMs = 10;/);
  assert.match(cs, /const int MaxRecords = 32768;/);
  assert.match(cs, /const int MaxBufferedRecords = 128;/);
  assert.match(cs, /const int MaxBytes = 8 \* 1024 \* 1024;/);
  assert.match(cs, /seconds < 1 \|\| seconds > MaxSeconds/);
  assert.match(body(cs, 'static void Add('), /truncated \|\| rows\.Count >= MaxBufferedRecords \|\| records >= MaxRecords - 1/);
  assert.match(cs, /bytesWritten \+ bytes\.Length > MaxBytes - \(terminal \? 0 : 2048\)/);
  assert.match(cs, /stream\.Write\(bytes, 0, bytes\.Length\); bytesWritten \+= bytes\.Length;/);
  assert.match(cs, /stream\.Flush\(terminal\);\s*rows\.Clear\(\);/);
  assert.match(cs, /var terminal = Row\("end"/);
  assert.match(cs, /row\["seq"\] = records \+ 1;/);
  assert.match(cs, /"diskError", diskError/);
  assert.match(cs, /!diskError/);
}
test('capacity is fixed for memory and disk and reserves the terminal receipt', () => capacityPolicy(script()));

test('the actual Add body bounds the queue and leaves a terminal record', () => {
  const add = body(csharp(script()), 'static void Add(');
  const result = runInNewContext(`
    let truncated = false, records = 0;
    const rows = { Count: 0, Add() { this.Count++; } };
    function Add(row) { ${add} }
    for (let n = 0; n < 128; n++) Add({});
    const full = rows.Count === 128 && records === 128 && !truncated;
    Add({});
    const overflow = rows.Count === 128 && truncated;
    ({ full, overflow, records });
  `, { MaxRecords: maxRecords, MaxBufferedRecords: 128 }, { timeout: 100 });
  assert.equal(result.full, true);
  assert.equal(result.overflow, true);
  assert.equal(result.records, 128);
});

function streamingPolicy(text) {
  const cs = csharp(uncomment(text)), run = body(cs, 'public static bool Run(');
  assert.match(cs, /const int HeartbeatMs = 1000;/);
  assert.match(cs, /return changed \|\| tick - lastTick >= HeartbeatMs \|\| force;/);
  assert.match(cs, /signature\.Remove\("tickMs"\); signature\.Remove\("seq"\);/);
  assert.match(cs, /if \(RetainState\(current != lastState, tick, lastStateTick, force\)\)/);
  assert.match(cs, /snapshot\.Add\("pollCount", polls\); snapshot\.Add\("maxGapMs", maxPollGap\);/);
  assert.match(cs, /maxPollGap > MaxPollGapMs/);
  assert.match(run, /Poll\(sessionId, false\); Flush\(false\);/);
  assert.match(run, /Flush\(false\);/);
  assert.match(run, /Poll\(sessionId, true\); Flush\(false\);/);
  assert.match(run, /StopRequested\(stopPath, requestHash\)/);
  assert.match(cs, /info\.Attributes & FileAttributes\.ReparsePoint/);
  assert.match(cs, /ReadOrdinary\(path, 16384\)/);
  assert.match(cs, /Convert\.ToBase64String\(sha\.ComputeHash\(bytes\)\) != requestHash/);
  assert.ok(text.includes('$request.invocation -cne $RequestInvocation'));
  assert.ok(text.includes("$request.operation -cnotin @('row','selftest')"));
  assert.ok(text.includes('$requestItem.Length -gt 16384'));
  assert.ok(text.includes('STOP_REQUEST_REPLAY'));
}
test('streaming keeps state changes and heartbeats, binds stop bytes and bounds its duration', () => streamingPolicy(script()));

const mutations = [
  ['input injection', readOnlyPolicy, s => s + '\nSendInput(1);'],
  ['activation', readOnlyPolicy, s => s + '\nSetForegroundWindow(window);'],
  ['clipboard read', readOnlyPolicy, s => s + '\nGet-Clipboard'],
  ['network', readOnlyPolicy, s => s + '\nInvoke-WebRequest https://example.invalid'],
  ['managed screen capture', readOnlyPolicy, s => s + '\nGraphics.CopyFromScreen();'],
  ['unreviewed native import', readOnlyPolicy, s => s.replace('GetLastInputInfo(ref', 'GetKeyboardState(ref')],
  ['import alias', readOnlyPolicy, s => s.replace('[DllImport("user32.dll")]', '[DllImport("user32.dll", EntryPoint="SendInput")]')],
  ['raw key output', readOnlyPolicy, s => s.replace('"key", input.vkCode == 0x1b ? "escape" : "other"', '"vkCode", input.vkCode')],
  ...Object.entries(projections.key).map(([field, value]) => [`raw key in ${field}`, readOnlyPolicy,
    s => s.replace(`"${field}", ${value}`, `"${field}", input.vkCode`)]),
  ...['scanCode', 'extraInfo'].map(field => [`raw ${field} in event clock`, readOnlyPolicy,
    s => s.replace('"eventTickMs", input.time', `"eventTickMs", input.${field}`)]),
  ['mouse position in event clock', readOnlyPolicy, s => s.replaceAll('"eventTickMs", input.time', '"eventTickMs", input.point.x')],
  ['mouse data hidden in phase', readOnlyPolicy, s => s.replace('"phase", phase,', '"phase", input.mouseData,')],
  ['mouse extraInfo hidden in phase', readOnlyPolicy, s => s.replace('"phase", phase,', '"phase", input.extraInfo,')],
  ['unbounded queue', capacityPolicy, s => s.replace('rows.Count >= MaxBufferedRecords', 'false')],
  ['unbounded disk', capacityPolicy, s => s.replace('bytesWritten + bytes.Length > MaxBytes - (terminal ? 0 : 2048)', 'false')],
  ['terminal slot consumed', capacityPolicy, s => s.replace('records >= MaxRecords - 1', 'records >= MaxRecords')],
  ['every poll retained', streamingPolicy, s => s.replace('RetainState(current != lastState, tick, lastStateTick, force)', 'true')],
  ['missing heartbeat', streamingPolicy, s => s.replace('tick - lastTick >= HeartbeatMs', 'false')],
  ['missing poll gap check', streamingPolicy, s => s.replace('maxPollGap > MaxPollGapMs', 'false')],
  ['no streaming flush', capacityPolicy, s => s.replace('stream.Flush(terminal);', '')],
  ['stop accepts another request', streamingPolicy, s => s.replace('Convert.ToBase64String(sha.ComputeHash(bytes)) != requestHash', 'false')],
  ['stop follows reparse point', streamingPolicy, s => s.replace('info.Attributes & FileAttributes.ReparsePoint', 'info.Attributes & FileAttributes.Directory')],
  ['stop permits large request', streamingPolicy, s => s.replace('ReadOrdinary(path, 16384)', 'ReadOrdinary(path, 999999)')],
  ['stop replays stale invocation', streamingPolicy, s => s.replace('$request.invocation -cne $RequestInvocation', '$false')],
  ['sleep blocks hook thread', observationPolicy, s => s.replace('uint waitMs =', 'Thread.Sleep(10); uint waitMs =')],
  ['wait ignores input', observationPolicy, s => s.replace('waitMs, 0x04ff, 0x0004', 'waitMs, 0, 0x0004')],
  ['wait ignores already queued input', observationPolicy, s => s.replace('waitMs, 0x04ff, 0x0004', 'waitMs, 0x04ff, 0')],
  ['poll on every message wake', observationPolicy, s => s.replace('if (watch.ElapsedMilliseconds >= nextPoll)', 'if (true)')],
  ['session zero allowed', guardsPolicy, s => s.replace('SessionId -eq 0', 'SessionId -lt 0')],
  ['elevation allowed', guardsPolicy, s => s.replace("throw 'UNELEVATED_REQUIRED'", "Write-Verbose 'UNELEVATED_REQUIRED'")],
  ['physical Mac manufacturer allowed', guardsPolicy, s => s.replace('(?:QEMU|VMware', '(?:Apple|QEMU|VMware')],
  ['clobber existing log', guardsPolicy, s => s.replace('FileMode.CreateNew', 'FileMode.Create')],
  ['keyboard hook missing', observationPolicy, s => s.replace('SetWindowsHookExW(13,', 'SetWindowsHookExW(14,')],
  ['mouse hook missing', observationPolicy, s => s.replace('SetWindowsHookExW(14,', 'SetWindowsHookExW(13,')],
  ['Escape swallowed', observationPolicy, s => s.replace('return CallNextHookEx(keyboardHook', 'return new IntPtr(1); // CallNextHookEx(keyboardHook')],
  ['keyboard flags relabeled hardware', observationPolicy, s => s.replace('(input.flags & 0x10) != 0', 'false')],
  ['lower integrity flag dropped', observationPolicy, s => s.replace('(input.flags & 0x02) != 0', 'false')],
  ['keyboard hook leaks', observationPolicy, s => s.replace('UnhookWindowsHookEx(keyboardHook)', 'true')],
  ['mouse hook leaks', observationPolicy, s => s.replace('UnhookWindowsHookEx(mouseHook)', 'true')],
  ['missing truncation cap', observationPolicy, s => s.replace('records >= MaxRecords - 1', 'false')],
  ['truncation hidden', observationPolicy, s => s.replace('"truncated", truncated', '"truncated", false')],
  ['WTS memory leaks', observationPolicy, s => s.replace('WTSFreeMemory(buffer)', 'GC.KeepAlive(buffer)')],
  ['desktop handle leaks', observationPolicy, s => s.replace('CloseDesktop(desktop)', 'GC.KeepAlive(desktop)')],
];
for (const [name, policy, mutate] of mutations) test(`broken variant caught: ${name}`, () => {
  const original = script(), broken = mutate(original);
  policy(original);
  assert.notEqual(broken, original, 'mutation must apply');
  assert.throws(() => policy(broken), assert.AssertionError);
});

test('synthetic observer lines retain boot and event clocks, coarse keys and raw injection flags', () => {
  const rows = readFileSync(fixtureUrl, 'utf8').trim().split('\n').map(parseLine);
  assert.equal(rows.length, 15);
  assert.deepEqual([...new Set(rows.map(r => r.kind))], ['start', 'poll', 'key', 'mouse', 'end']);
  const keys = rows.filter(r => r.kind === 'key');
  assert.deepEqual(keys.map(r => [r.key, r.phase, r.injected, r.lowerIntegrityInjected]), [
    ['escape', 'down', false, false], ['escape', 'up', false, false],
    ['escape', 'down', true, false], ['other', 'up', true, true],
  ]);
  // A DWORD event clock wraps independently of GetTickCount64. Never relabel it.
  assert.equal(keys[0].tickMs - keys[0].eventTickMs, 0x100000000);
  assert.deepEqual(rows.filter(r => r.kind === 'poll').map(r => [r.wtsOk, r.wtsFlags, r.desktop]), [
    [true, 1, 'Default'], [true, 0, 'unavailable'], [true, 1, 'Winlogon'],
    [true, 1, 'Screen-saver'], [true, 1, 'Default'], [false, -1, 'unavailable'], [true, 1, 'other'],
  ]);
  assert.equal(rows.at(-1).records, 15);
  assert.equal(rows.at(-1).hookRemoved, true);
});

test('line contract rejects character data, unknown fields, pixels and malformed flags', () => {
  const rows = readFileSync(fixtureUrl, 'utf8').trim().split('\n').map(JSON.parse);
  const key = rows.find(r => r.kind === 'key'), poll = rows.find(r => r.kind === 'poll'), end = rows.at(-1);
  for (const r of [
    { ...key, key: 'A' }, { ...key, vkCode: 65 }, { ...key, windowTitle: 'private' },
    { ...key, screenshot: 'iVBORw0KGgo' }, { ...key, injected: 0 }, { ...key, lowerIntegrityInjected: null },
    { ...key, eventTickMs: 0x100000000 }, { ...key, tickMs: -1 }, { ...key, phase: 'typed' },
    { ...poll, desktop: 'private'.repeat(50) }, { ...poll, lastInputOk: false, lastInputTickMs: 99 },
    { ...poll, wtsOk: false }, { ...poll, desktopOpened: false },
    { ...end, hookRemoved: false }, { ...end, records: maxRecords + 1 }, { ...end, truncated: 'false' },
  ]) assert.throws(() => parseLine(JSON.stringify(r)), assert.AssertionError);
  assert.throws(() => parseLine('x'.repeat(2049)), /line limit/);
});

test('failed hook cleanup and incomplete observations remain visible in the line contract', () => {
  const end = JSON.parse(readFileSync(fixtureUrl, 'utf8').trim().split('\n').at(-1));
  const incomplete = { ...end, keyboardHookRemoved: false, hookRemoved: false, truncated: true, stopReason: 'record-limit' };
  assert.deepEqual(parseLine(JSON.stringify(incomplete)), incomplete);
  for (const reason of ['lease-expired', 'hook-install-failed', 'observer-error']) {
    assert.equal(parseLine(JSON.stringify({ ...incomplete, stopReason: reason })).stopReason, reason);
  }
});

test('900 seconds at 10 ms produces 901 retained polls and a counted receipt', () => {
  const lease = { expiresUtc: '2026-11-02T01:15:00.000Z', token: 'c'.repeat(32), row: 'person-key-before' };
  const rows = syntheticObserver({ lease });
  assert.equal(rows.length, 903);
  assert.equal(rows.filter(r => r.kind === 'poll').length, 901);
  assert.equal(rows.at(-1).pollCount, 90001);
  assert.equal(rows.at(-1).records, rows.length);
  assert.ok(Buffer.byteLength(rows.map(JSON.stringify).join('\n')) < 512 * 1024);
  rows.forEach(r => parseLine(JSON.stringify(r)));
});

test('the actual Add body reserves the final slot after repeated streaming drains', () => {
  const add = body(csharp(script()), 'static void Add(');
  const result = runInNewContext(`
    let truncated = false, records = MaxRecords - 2;
    const rows = { Count: 0, Add() { this.Count++; } };
    function Add(row) { ${add} }
    Add({}); rows.Count = 0;
    const lastAccepted = records === MaxRecords - 1 && !truncated;
    Add({});
    ({ lastAccepted, records, truncated, buffered: rows.Count });
  `, { MaxRecords: maxRecords, MaxBufferedRecords: 128 }, { timeout: 100 });
  assert.equal(result.lastAccepted, true);
  assert.equal(result.records, maxRecords - 1);
  assert.equal(result.truncated, true);
  assert.equal(result.buffered, 0);
});

test('the actual disk limit expression reserves receipt bytes and rejects oversized lines', () => {
  const cs = csharp(script());
  const expression = /if \((bytes.Length > 2048[^\n]+)\) \{/.exec(cs)?.[1];
  assert.ok(expression);
  const rejects = runInNewContext(`(bytesWritten, length, terminal) => {
    const bytes = { Length: length }; return ${expression};
  }`, { MaxBytes: 8 * 1024 * 1024 }, { timeout: 100 });
  const limit = 8 * 1024 * 1024;
  assert.equal(rejects(limit - 2049, 1, false), false);
  assert.equal(rejects(limit - 2048, 1, false), true);
  assert.equal(rejects(limit - 1, 1, true), false);
  assert.equal(rejects(limit, 1, true), true);
  assert.equal(rejects(0, 2049, false), true);
});

function fixRoundPolicy(text) {
  const cs = csharp(uncomment(text)), run = body(cs, 'public static bool Run(');
  assert.ok(text.includes('"$RequestInvocation.$($request.payload.row.id).observer-$Invocation.jsonl"'));
  assert.match(cs, /stream\.Flush\(terminal\);/);
  assert.doesNotMatch(body(cs, 'static Dictionary<string, object> Row('), /"seq"/);
  assert.match(body(cs, 'static void Add('), /row\["seq"\] = records \+ 1;/);
  assert.match(cs, /const int StopReadRetries = 10;/);
  assert.match(cs, /error\.HResult & 0xffff/);
  assert.match(cs, /win32 == 32 \|\| win32 == 33/);
  assert.match(cs, /\+\+stopReadAttempts <= StopReadRetries/);
  assert.match(cs, /reason = "stop-invalid"/);
  assert.match(cs, /signature\.Remove\("lastInputTickMs"\);/);
  assert.match(cs, /CoalesceMouse\(Row\("mouse"/);
  assert.match(cs, /FlushMouse\(true\)/);
  const deadline = run.indexOf('if (watch.ElapsedMilliseconds >= nextPoll)');
  const stopCheck = run.indexOf('StopRequested(stopPath');
  const deadlineEnd = run.indexOf('nextPoll = watch.ElapsedMilliseconds + PollMs;', deadline);
  assert.ok(deadline < stopCheck && stopCheck < deadlineEnd, 'stop reads occur only at poll deadline');
}
test('fix round: observer scopes files, retries stop reads, coalesces and keeps durable flush after unhook', () => fixRoundPolicy(script()));

test('fix round: actual coalescer retains first and last mouse events and counts a full interval', () => {
  const cs = csharp(script());
  const coalesce = body(cs, 'static void CoalesceMouse(')
    .replace('string key =', 'const key =').replaceAll('(long)', '').replaceAll('0L', '0');
  const result = runInNewContext(`
    const mouse = {};
    Object.defineProperty(mouse, 'ContainsKey', { value: key => Object.hasOwn(mouse, key) });
    function CoalesceMouse(row) { ${coalesce} }
    for (let n = 0; n < 10000; n++) CoalesceMouse({ phase: 'move', injected: false, lowerIntegrityInjected: false,
      tickMs: n, eventTickMs: n, foregroundHwnd: '0x' + n, foregroundPid: n });
    const values = Object.values(mouse);
    ({ size: values.length, row: values[0] });
  `, {}, { timeout: 1000 });
  assert.equal(result.size, 1);
  assert.equal(result.row.eventCount, 10000);
  assert.equal(result.row.firstTickMs, 0); assert.equal(result.row.lastTickMs, 9999);
  assert.equal(result.row.firstEventTickMs, 0); assert.equal(result.row.eventTickMs, 9999);
  assert.equal(result.row.firstForegroundPid, 0); assert.equal(result.row.foregroundPid, 9999);
  assert.match(body(cs, 'static void FlushMouse('), /tick - lastMouseFlush < HeartbeatMs/);
  assert.match(body(cs, 'static void FlushMouse('), /mouse.Clear\(\); lastMouseFlush = tick;/);
  // 20 distinct phase/flag buckets at most once per second, plus 901 steady-state polls.
  assert.ok(20 * 900 + 901 + 2 < maxRecords);
});

for (const [name, before, after] of [
  ['durable pump flush', 'stream.Flush(terminal);', 'stream.Flush(true);'],
  ['unscoped observer output', '$RequestInvocation.$($request.payload.row.id).observer-$Invocation.jsonl', 'observer-$Invocation.jsonl'],
  ['stop retry removed', '++stopReadAttempts <= StopReadRetries', 'false'],
  ['input tick forces records', 'signature.Remove("lastInputTickMs");', ''],
  ['mouse coalescing removed', 'CoalesceMouse(Row("mouse"', 'Add(Row("mouse"'],
  ['sequence assigned before enqueue', 'row["seq"] = records + 1;', ''],
]) test(`fix round broken source variant: ${name}`, () => {
  const original = script(), broken = original.replace(before, after);
  assert.notEqual(original, broken);
  fixRoundPolicy(original);
  assert.throws(() => fixRoundPolicy(broken), assert.AssertionError);
});

test('fix round: actual last-input tracker counts changes while retaining first and last ticks', () => {
  const track = body(csharp(script()), 'static void TrackLastInput(');
  const result = runInNewContext(`
    let inputSeen = false, latestInputTick = 0, firstInputTick = 0, inputChanges = 0;
    function TrackLastInput(inputOk, tick) { ${track} }
    for (let n = 0; n <= 100; n++) TrackLastInput(true, n);
    TrackLastInput(false, 0); TrackLastInput(true, 100);
    ({ latestInputTick, firstInputTick, inputChanges });
  `, {}, { timeout: 100 });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { latestInputTick: 100, firstInputTick: 0, inputChanges: 101 });
});

test('fix round: actual stop retry policy tolerates a partial stop and sharing locks for ten polls', () => {
  const retry = body(csharp(script()), 'static bool RetryStopRead(')
    .replace('bool retry =', 'const retry =').replace('new StopRequestException()', 'new Error("stop-invalid")');
  const make = runInNewContext(`() => {
    let stopReadAttempts = 0;
    return (win32, message) => { ${retry} };
  }`, { StopReadRetries: 10 }, { timeout: 100 });
  for (const [win32, message] of [[32, 'sharing'], [33, 'lock'], [0, 'STOP_IDENTITY_MISMATCH'], [0, 'REQUEST_INVALID']]) {
    const attempt = make();
    for (let n = 0; n < 10; n++) assert.equal(attempt(win32, message), true);
    assert.throws(() => attempt(win32, message), /stop-invalid/);
  }
  assert.equal(make()(5, 'access denied'), false, 'unrelated disk errors are not retried');
});

function highInputExercise(text) {
  const cs = csharp(text);
  const coalesce = body(cs, 'static void CoalesceMouse(')
    .replace('string key =', 'const key =').replaceAll('(long)', '').replaceAll('0L', '0');
  const flush = body(cs, 'static void FlushMouse(')
    .replace('long tick = (long)GetTickCount64();', 'const tick = GetTickCount64();')
    .replace('foreach (var pending in mouse.Values)', 'for (const pending of Object.values(mouse))');
  const track = body(cs, 'static void TrackLastInput(');
  const retain = /static bool RetainState\([^)]*\)\s*\{\s*return ([^;]+);/.exec(cs)[1];
  const removals = [...body(cs, 'static void Poll(').matchAll(/signature\.Remove\("([^"]+)"\);/g)].map(m => m[1]);
  return runInNewContext(`
    let clock = 0, lastMouseFlush = 0, inputSeen = false, inputChanges = 0, firstInputTick = 0, latestInputTick = 0;
    let lastTick = 0, lastSignature, pollRecords = 0, mouseRecords = 0, events = 0, changes = 0;
    const mouse = {};
    Object.defineProperty(mouse, 'ContainsKey', { value: key => Object.hasOwn(mouse, key) });
    Object.defineProperty(mouse, 'Clear', { value: () => { for (const key of Object.keys(mouse)) delete mouse[key]; } });
    const GetTickCount64 = () => clock;
    function CoalesceMouse(row) { ${coalesce} }
    function FlushMouse(force) { ${flush} }
    function TrackLastInput(inputOk, tick) { ${track} }
    function Add(row) {
      mouseRecords++; events += row.eventCount;
      if (!(row.firstTickMs <= row.lastTickMs && row.lastTickMs <= row.tickMs)) throw Error('event clocks');
    }
    for (clock = 0; clock <= 900000; clock++) {
      CoalesceMouse({ phase: 'move', injected: false, lowerIntegrityInjected: false, tickMs: clock, eventTickMs: clock,
        foregroundHwnd: '0x1', foregroundPid: 1 });
      if (clock % 10) continue;
      FlushMouse(false); TrackLastInput(true, clock);
      const snapshot = { kind: 'poll', tickMs: clock, lastInputTickMs: clock, lastInputChanges: inputChanges,
        lastInputFirstTickMs: firstInputTick, foregroundHwnd: '0x1' };
      const signature = { ...snapshot };
      for (const key of removals) delete signature[key];
      const current = JSON.stringify(signature), changed = current !== lastSignature;
      const tick = clock, force = clock === 900000;
      if (${retain}) {
        pollRecords++; changes += inputChanges; inputChanges = 0; lastTick = tick; lastSignature = current;
      }
    }
    FlushMouse(true);
    ({ pollRecords, mouseRecords, events, changes, records: pollRecords + mouseRecords + 2 });
  `, { HeartbeatMs: 1000, removals }, { timeout: 5000 });
}
test('fix round: 900 seconds of changing last-input and 1000 mouse events per second stays below the record cap', () => {
  const result = highInputExercise(script());
  assert.equal(result.pollRecords, 901);
  assert.equal(result.mouseRecords, 900);
  assert.equal(result.events, 900001); assert.equal(result.changes, 90001);
  assert.equal(result.records, 1803);
  assert.ok(result.records < maxRecords);
  const broken = script().replace('signature.Remove("lastInputTickMs");', '');
  assert.ok(highInputExercise(broken).records > maxRecords, 'broken input signature exceeds the cap');
});

test('observer startup retains fixed refusals and maps typed exceptions without text', () => {
  const source = readFileSync(scriptUrl, 'utf8');
  assert.match(source, /\$code -cnotin \$known/);
  assert.match(source, /\$depth -lt 4/);
  assert.match(source, /\[Console\]::Error.WriteLine\(\$code\)/);
  for (const code of ['FIXTURE_PROCESS_GONE', 'FIXTURE_ACCESS_DENIED', 'FIXTURE_WINDOW_GONE', 'PARAMETER_BINDING_FAILED'])
    assert.ok(source.includes(code), code);
});
