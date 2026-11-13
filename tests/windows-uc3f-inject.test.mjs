import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Offline contracts only. PowerShell, C# and native input run only in the VM sitting.
const path = new URL('../bench/windows/uc3f-inject.ps1', import.meta.url);
const source = existsSync(path) ? readFileSync(path, 'utf8') : '';
const body = (text, signature) => {
  const at = text.indexOf(signature);
  assert.notEqual(at, -1, `missing ${signature}`);
  const start = text.indexOf('{', at);
  let depth = 1, end = start + 1;
  for (; end < text.length && depth; end++) {
    if (text[end] === '{') depth++;
    if (text[end] === '}') depth--;
  }
  assert.equal(depth, 0, `unclosed ${signature}`);
  return text.slice(start + 1, end - 1);
};
const ordered = (text, ...parts) => {
  let from = 0;
  for (const part of parts) {
    const at = text.indexOf(part, from);
    assert.notEqual(at, -1, `missing or out of order: ${part}`);
    from = at + part.length;
  }
};

// Execute the actual pure C# decision body as its shared boolean/string subset.
// No native interop, PowerShell parsing or C# compilation is claimed by this check.
function decide(text, values) {
  const code = body(text, 'public static string Decide(');
  assert.match(code, /^\s*(?:if\s*\([^{};]+\)\s*return "[A-Z_]+";\s*)+return "OK";\s*$/);
  return runInNewContext(`(function(desktop, foregroundPid, fixturePid, identityMatches) {${code}})(...values)`,
    { values: values.slice(1) }, { timeout: 100 });
}
const cases = [
  { name: 'fixture', values: [1000, 'Default', 42, 42, true], want: 'OK' },
  { name: 'maximum', values: [900000, 'Default', 42, 42, true], want: 'OK' },
  { name: 'Winlogon', values: [1000, 'Winlogon', 42, 42, true], want: 'SECURE_DESKTOP_NO_INJECT' },
  { name: 'unavailable', values: [1000, '', 42, 42, true], want: 'SECURE_DESKTOP_NO_INJECT' },
  { name: 'screensaver', values: [1000, 'Screen-saver', 42, 42, true], want: 'SECURE_DESKTOP_NO_INJECT' },
  { name: 'case mismatch', values: [1000, 'default', 42, 42, true], want: 'SECURE_DESKTOP_NO_INJECT' },
  { name: 'owner Explorer', values: [1000, 'Default', 99, 42, true], want: 'FOREGROUND_NOT_FIXTURE' },
  { name: 'no foreground', values: [1000, 'Default', 0, 42, true], want: 'FOREGROUND_NOT_FIXTURE' },
  { name: 'no fixture', values: [1000, 'Default', 42, 0, true], want: 'FOREGROUND_NOT_FIXTURE' },
  { name: 'PID recycled', values: [1000, 'Default', 42, 42, false], want: 'FOREGROUND_NOT_FIXTURE' },
];
const checkDecision = (text, selection = cases) => {
  for (const row of selection) assert.equal(decide(text, row.values), row.want, row.name);
};

function checkKeySet(text) {
  assert.match(text, /\[ValidateSet\('key','lock','screensaver','session-switch'\)\]\[string\]\$Operation/);
  assert.match(text, /\[ValidateSet\('q','escape'\)\]\[string\]\$Key = 'q'/);
  assert.match(text, /\[ValidateRange\(0,5000\)\]\[int\]\$LeadMs = 100/);
  assert.match(text, /\[ValidateRange\(100,900000\)\]\[int\]\$WaitMs = 30000/);
  assert.match(text, /\[ValidateRange\(1,2147483647\)\]\[int\]\$FixturePid/);
  assert.match(text, /\[ValidatePattern\('\^\[1-9\]\[0-9\]\{0,18\}\$'\)\]\[string\]\$FixtureStart/);
  const run = body(text, 'public static Result Run(');
  ordered(run, 'operation != "key"', 'throw new InvalidOperationException("INVALID_OPERATION")',
    'key != "q" && key != "escape"', 'throw new InvalidOperationException("INVALID_KEY")', 'RequireTarget(');
  assert.match(run, /if \(key != "q" && key != "escape"\) throw new InvalidOperationException\("INVALID_KEY"\);/);
  assert.match(text, /\$Operation -ne 'key' -and \$PSBoundParameters.ContainsKey\('Key'\)/);
}
test('G2 admits only two fixed single keys and four bounded operations', () => checkKeySet(source));

test('G2 decision refuses secure desktops and foreign or recycled PIDs', () => checkDecision(source));

for (const [invariant, remove, selection] of [
  [3, 'if (fixturePid == 0 || foregroundPid != fixturePid || !identityMatches) return "FOREGROUND_NOT_FIXTURE";', ['owner Explorer', 'PID recycled']],
  [5, 'if (desktop != "Default") return "SECURE_DESKTOP_NO_INJECT";', ['Winlogon', 'unavailable']],
]) test(`invariant ${invariant}: broken decision is caught by the same refusal fixtures`, () => {
  assert.ok(source.includes(remove), 'mutation must change the source');
  assert.throws(() => checkDecision(source.replace(remove, ''), cases.filter(r => selection.includes(r.name))), assert.AssertionError);
});

function checkDispatch(text) {
  const run = body(text, 'public static Result Run(');
  ordered(run, 'RequireTarget(fixturePid, fixtureStart)', 'result.tickMs = GetTickCount64()', 'if (operation == "key")');
  assert.equal((text.match(/\bSendInput\(/g) ?? []).length, 2, 'one declaration and one call, no retry');
  assert.equal((run.match(/\bSendInput\(/g) ?? []).length, 1);
  assert.match(run, /SendInput\(2, inputs, Marshal.SizeOf\(typeof\(INPUT\)\)\)/);
  assert.match(run, /inputs\[1\]\.data\.keyboard\.flags = 0x0002/);
  assert.match(run, /key == "escape" \? 0x1b : 0x51/);
  assert.match(run, /LockWorkStation\(\)/);
  assert.match(run, /SendMessageTimeoutW\(hwnd, 0x0112, new UIntPtr\(0xf140\), IntPtr.Zero, 0x0002, 1000, out ignored\)/);
  assert.match(run, /WTSDisconnectSession\(IntPtr.Zero, Process.GetCurrentProcess\(\).SessionId, false\)/);
}

test('every side effect follows the shared native guard and sends no activation or credential input', () => checkDispatch(source));
test('invariant 5: bypassing the final native guard is caught', () => {
  const needle = 'RequireTarget(fixturePid, fixtureStart)';
  assert.ok(source.includes(needle));
  assert.throws(() => checkDispatch(source.replace(needle, 'IntPtr.Zero')), /RequireTarget/);
});

test('native guard samples the desktop, foreground and live start time for every action', () => {
  const guard = body(source, 'static IntPtr RequireTarget(');
  ordered(guard, 'Process.GetProcessById(',
    'process.StartTime.ToFileTimeUtc()', 'process.SessionId == Process.GetCurrentProcess().SessionId',
    'ReadDesktop()', 'GetForegroundWindow()', 'GetWindowThreadProcessId(',
    'Decide(', 'throw new InvalidOperationException(code)', 'return hwnd');
  const desktop = body(source, 'static string ReadDesktop(');
  ordered(desktop, 'OpenInputDesktop(0, false, 1)', 'GetUserObjectInformationW(', 'finally', 'CloseDesktop(');
  assert.match(desktop, /if \(!CloseDesktop\(handle\)\) throw/);
});

test('foreground and desktop are sampled after the potentially slow process-start query', () => {
  const guard = body(source, 'static IntPtr RequireTarget(');
  ordered(guard, 'process.StartTime.ToFileTimeUtc()', 'ReadDesktop()', 'GetForegroundWindow()', 'GetWindowThreadProcessId(',
    'Decide(desktop, foregroundPid, fixturePid, identityMatches)');
});

function checkWait(text) {
  const wait = body(text, 'while (-not (Test-Path -LiteralPath $goPath))');
  ordered(wait, '$watch.ElapsedMilliseconds -ge $WaitMs', "throw 'GO_TIMEOUT'", 'Start-Sleep -Milliseconds 10');
  ordered(text.slice(text.indexOf('$watch = [Diagnostics.Stopwatch]::StartNew()')), 'while (-not (Test-Path',
    'Assert-BankFile $goPath', 'Start-Sleep -Milliseconds $LeadMs',
    '[SleightUc3fInject]::Run($Operation, $Key, $FixturePid, $FixtureStart)');
}

// Evaluate only the gate's variable/string comparisons and boolean operators.
// This exercises its truth table without claiming to execute PowerShell.
function checkPresence(text) {
  const lease = text;
  const match = /if \(([^\n]+)\) \{ throw 'OWNER_PRESENT_REQUIRED' \}/.exec(lease);
  assert.ok(match, 'presence refusal must exist');
  const expression = match[1];
  const tokens = /\$Operation|\$Presence|'(?:key|lock|screensaver|session-switch|away|present)'|-c?ne|-c?eq|-and|-or|\$false|\$true|[()\s]/g;
  assert.equal(expression.replace(tokens, ''), '', 'presence gate uses the reviewed expression subset');
  const js = expression.replaceAll('$Operation', 'operation').replaceAll('$Presence', 'presence')
    .replace(/-c?ne/g, '!==').replace(/-c?eq/g, '===').replaceAll('-and', '&&').replaceAll('-or', '||')
    .replaceAll('$false', 'false').replaceAll('$true', 'true');
  for (const operation of ['key', 'lock', 'screensaver', 'session-switch']) {
    for (const presence of ['away', 'present']) {
      assert.equal(runInNewContext(js, { operation, presence }, { timeout: 100 }),
        operation !== 'key' && presence !== 'present', `${operation}/${presence}`);
    }
  }
}
test('lock, screensaver and disconnect require presence; key admits either presence', () => checkPresence(source));

test('go-file and lead waits are bounded before the final native check', () => checkWait(source));

test('guest preflight refuses non-Windows, session zero, elevated tokens and non-VM manufacturers', () => {
  ordered(source, "$env:OS -ne 'Windows_NT'", 'SessionId -eq 0', 'RequireStandardUser()', 'Get-CimInstance Win32_ComputerSystem',
    'VMware, Inc.', "throw 'NOT_VM'", '[SleightUc3fInject]::Run(');
  const integrity = body(source, 'public static void RequireStandardUser(');
  ordered(integrity, 'OpenProcessToken(', 'GetTokenInformation(', 'GetSidSubAuthorityCount(', 'GetSidSubAuthority(',
    'rid != 4096 && rid != 8192', 'throw new InvalidOperationException("UNELEVATED_REQUIRED")', 'finally', 'CloseHandle(');
});

function checkLogClaim(text) {
  const code = text.replace(/^\s*#[^\n]*/gm, '');
  assert.ok(code.includes("'^C:\\\\sleight-setup\\\\uc3f-[a-f0-9]{16}$'"));
  assert.match(code, /\$Invocation = '0'/);
  assert.match(code, /\[ValidatePattern\('\^\[0-9\]\{1,4\}\$'\)\]/);
  assert.match(body(code, 'function Assert-BankFile'), /ReparsePoint/);
  ordered(code, "@('C:\\', 'C:\\sleight-setup', $Bank)",
    '$stream = [IO.File]::Open($logPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)',
    '$writer = New-Object IO.StreamWriter', 'while (-not (Test-Path');
  assert.match(code, /Join-Path \$Bank "go-\$Invocation"/);
  assert.match(code, /Join-Path \$Bank "inject-\$Invocation.jsonl"/);
}
test('bank paths are fixed, ordinary files only, and log creation prevents invocation replay', () => checkLogClaim(source));

for (const [name, check, mutate] of [
  ['presence gate removed', checkPresence, s => s.replace("if ($Operation -ne 'key' -and $Presence -cne 'present') { throw 'OWNER_PRESENT_REQUIRED' }", '')],
  ['presence gate only covers saver', checkPresence, s => s.replace("if ($Operation -ne 'key' -and $Presence -cne 'present')", "if ($Operation -eq 'screensaver' -and $Presence -cne 'present')")],
  ['presence accepts away', checkPresence, s => s.replace("$Presence -cne 'present'", "$Presence -cne 'away'")],
  ['PowerShell key set widened', checkKeySet, s => s.replace("ValidateSet('q','escape')", "ValidateSet('q','escape','enter')")],
  ['native key set widened', checkKeySet, s => s.replace('key != "q" && key != "escape")', 'key != "q" && key != "escape" && key != "enter")')],
  ['log overwritten', checkLogClaim, s => s.replace('[IO.FileMode]::CreateNew', '[IO.FileMode]::Create')],
  ['log appended', checkLogClaim, s => s.replace('[IO.FileMode]::CreateNew', '[IO.FileMode]::Append')],
  ['log claim removed', checkLogClaim, s => s.replace('$stream = [IO.File]::Open($logPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)', '$stream = $null')],
]) test(`broken variant caught: ${name}`, () => {
  check(source);
  const broken = mutate(source);
  assert.notEqual(broken, source, 'mutation must apply');
  assert.throws(() => check(broken), assert.AssertionError);
});

const windowsDirectory = new URL('../bench/windows/', import.meta.url);
function windowsSources(directory = windowsDirectory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name, url = new URL(entry.name, directory);
    if (entry.isDirectory()) return windowsSources(new URL(entry.name + '/', directory), name + '/');
    return entry.isFile() ? [[name, readFileSync(url, 'utf8')]] : [];
  });
}
function checkSendInputOwners(files) {
  // RT31's comment-only lines describe its input ban. Keep strings and code in the scan.
  const code = text => text.replace(/^\s*#[^\n]*/gm, '');
  // These exact acceptance descriptions and source labels are data, not API use.
  // Replace each reviewed occurrence once; additions in these same files still fail.
  const descriptions = new Map([
    ['driver-sitting.mjs', [
      "'scheduled-sendinput'", "'scheduled-sendinput'", "'scheduled-sendinput'",
      "'10 scheduled SendInput Escapes have injected flags and zero Escape stops.'",
    ]],
    ['driver-sitting.schema.json', ['"scheduled-sendinput"']],
    ['uc3f-export.mjs', ["'scheduled-sendinput'", "'scheduled-sendinput'"]],
    ['driver-sitting-runbook.md', [
      '20 scheduled SendInput keys, measured 50 to 150 ms before foreground Notepad typing.',
      '10 scheduled SendInput Escapes with an injected hook flag, none stopping input through the Escape hook.',
    ]],
  ]);
  const remaining = (name, text) => (descriptions.get(name) ?? []).reduce((value, description) => value.replace(description, ''), code(text));
  assert.deepEqual(files.filter(([name, text]) => /\bSendInput\b/i.test(remaining(name, text))).map(([name]) => name).sort(), ['uc3f-inject.ps1']);
}
test('SendInput appears only in uc3f-inject.ps1 across bench/windows', () => checkSendInputOwners(windowsSources()));
test('broken variant caught: SendInput in another Windows script or a nested helper', () => {
  const files = windowsSources();
  checkSendInputOwners(files);
  for (const name of ['uc3f-observer.ps1', 'nested/unreviewed.ps1', 'nested/unreviewed.mjs']) {
    assert.throws(() => checkSendInputOwners([...files, [name, 'SendInput(2, inputs, size)']]), assert.AssertionError);
  }
  assert.throws(() => checkSendInputOwners([...files, ['nested/alias.ps1', '$entry = "SendInput"']]), assert.AssertionError);
  for (const reviewed of ['driver-sitting.mjs', 'driver-sitting.schema.json', 'driver-sitting-runbook.md', 'uc3f-export.mjs']) {
    for (const addition of ['\nSendInput(2, inputs, size)', "\n'scheduled-sendinput'"]) {
      const changed = files.map(([name, text]) => [name, text + (name === reviewed ? addition : '')]);
      assert.throws(() => checkSendInputOwners(changed), assert.AssertionError);
    }
  }
});

const fields = ['schema', 'kind', 'invocation', 'operation', 'key', 'tickMs', 'eventTickMs', 'vk', 'sentInputs', 'code'];
function line(raw) {
  assert.ok(Buffer.byteLength(raw) <= 1024);
  const value = JSON.parse(raw);
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort());
  assert.equal(value.schema, 'sleight.windows-uc3f-inject/1');
  assert.equal(value.kind, 'injector');
  assert.match(value.invocation, /^[0-9]{1,4}$/);
  assert.ok(['key', 'lock', 'screensaver', 'session-switch'].includes(value.operation));
  assert.ok(['escape', 'other', 'none'].includes(value.key));
  assert.match(value.code, /^[A-Z][A-Z0-9_]{0,63}$/);
  for (const field of ['tickMs', 'eventTickMs', 'vk', 'sentInputs']) assert.ok(Number.isSafeInteger(value[field]) && value[field] >= 0);
  assert.ok(value.eventTickMs <= 0xffffffff && value.eventTickMs === value.tickMs % 0x100000000);
  assert.ok(value.sentInputs <= 2 && [0, 27, 81].includes(value.vk));
  assert.equal(value.vk, value.operation === 'key' ? value.key === 'escape' ? 27 : 81 : 0);
  if (value.operation !== 'key' || value.code !== 'OK') assert.ok(value.sentInputs < 2);
  return value;
}
const record = extra => ({ schema: 'sleight.windows-uc3f-inject/1', kind: 'injector', invocation: '1', operation: 'key',
  key: 'escape', tickMs: 4294967301, eventTickMs: 5, vk: 27, sentInputs: 2, code: 'OK', ...extra });

test('injector JSONL has fixed metadata keys and native ticks, never row-plan hardware attribution', () => {
  const output = body(source, '$line = [ordered]@');
  assert.deepEqual([...output.matchAll(/^\s*(\w+)\s*=/gm)].map(m => m[1]), fields);
  assert.match(output, /tickMs = \$result.tickMs/);
  assert.match(output, /eventTickMs = \$result.eventTickMs/);
  assert.match(output, /sentInputs = \$result.sentInputs/);
  assert.doesNotMatch(source, /owner-keyboard|source\s*=|injectedFlag\s*=|windowTitle|screenshot|ToBase64String/);
  assert.equal(line(JSON.stringify(record())).sentInputs, 2);
  for (const operation of ['lock', 'screensaver', 'session-switch'])
    assert.equal(line(JSON.stringify(record({ operation, key: 'none', vk: 0, sentInputs: 0 }))).operation, operation);
  for (const code of ['FOREGROUND_NOT_FIXTURE', 'SECURE_DESKTOP_NO_INJECT', 'LEASE_EXPIRED', 'GO_TIMEOUT'])
    assert.equal(line(JSON.stringify(record({ code, sentInputs: 0 }))).sentInputs, 0);
  assert.equal(line(JSON.stringify(record({ code: 'INPUT_PARTIAL', sentInputs: 1 }))).sentInputs, 1);
});

test('malformed or privacy-bearing line fixtures cannot be mistaken for valid injection evidence', () => {
  for (const change of [{ source: 'owner-keyboard' }, { windowTitle: 'private' }, { vk: 13 }, { sentInputs: 3 },
    { eventTickMs: 6 }, { tickMs: -1 }, { key: 'Enter' }, { invocation: '../2' }, { operation: 'unlock' },
    { code: 'LEASE_EXPIRED', sentInputs: 2 }]) assert.throws(() => line(JSON.stringify(record(change))));
  assert.throws(() => line('{'));
  assert.throws(() => line(JSON.stringify(record({ code: 'x'.repeat(1024) }))));
});

test('source policy admits only reviewed native entry points and no alternate input, logon or app launch route', () => {
  const allowed = ['GetTickCount64', 'GetForegroundWindow', 'GetWindowThreadProcessId', 'OpenInputDesktop',
    'GetUserObjectInformationW', 'CloseDesktop', 'SendInput', 'LockWorkStation', 'SendMessageTimeoutW', 'WTSDisconnectSession',
    'OpenProcessToken', 'GetTokenInformation', 'GetSidSubAuthorityCount', 'GetSidSubAuthority', 'CloseHandle'];
  const imports = [...source.matchAll(/\[DllImport\("([^"]+)"[^\]]*\)\]\s*(?:static|public|internal|private|extern|\s)+\w+ (\w+)\(/g)];
  assert.equal(imports.length, allowed.length);
  assert.deepEqual(imports.map(m => m[2]).sort(), allowed.sort());
  assert.equal((source.match(/DllImport/g) ?? []).length, imports.length);
  assert.doesNotMatch(source, /EntryPoint|LibraryImport|GetProcAddress|DynamicInvoke|Invoke-Expression|Invoke-Command|Start-Process|Process\.Start\s*\(|SetForegroundWindow|SetFocus|SetActiveWindow|keybd_event|mouse_event|PostMessage|LogonUser|CredUI|\btscon\b|consent|password|\bPIN\b|clipboard|https?:|System\.Net/i);
  assert.doesNotMatch(source, /SLEIGHT_DRIVE_LOCKED|\/Users\//);
});

test('injector retains process-gone, birth and access-denied codes with a bounded exception walk', () => {
  for (const text of ['FIXTURE_PROCESS_GONE', 'FIXTURE_BIRTH_CHANGED', 'FIXTURE_ACCESS_DENIED', '$depth -lt 4', '$result.code = $code'])
    assert.ok(source.includes(text), text);
  assert.doesNotMatch(source, /catch \{ identityMatches = false; \}/);
});
