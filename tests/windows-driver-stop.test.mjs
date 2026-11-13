import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { windowsDriverSources } from '../plugins/sleight/lib/direct-browser/windows-host.mjs';
import { inspectDriverSource } from './fixtures/windows-source-policy.mjs';

const native = name => readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/win/' + name, import.meta.url), 'utf8');
const names = ['Driver.cs', 'DriverHook.cs', 'DriverInput.cs', 'DriverInventory.cs', 'DriverCapture.cs', 'DriverSettle.cs', 'DriverUia.cs', 'DriverActions.cs'];
const sources = () => Object.fromEntries(names.map(name => [name, native(name)]));
const region = (source, begin, end) => {
  const first = source.indexOf(begin), last = end ? source.indexOf(end, first + begin.length) : source.length;
  assert.ok(first >= 0 && last > first, begin + ' boundary');
  return source.slice(first, last);
};
function flagRule(source) {
  const body = /bool HardwareEscape\([^)]*\)\s*\{([^]*?)\n    \}/.exec(source)?.[1];
  assert.ok(body);
  return runInNewContext(`(code, message, key, flags) => { ${body} }`);
}
const flagRows = [
  [[0, 0x100, 27, 0], true], [[1, 0x100, 27, 0x80], true],
  [[0, 0x100, 27, 0x10], false], [[0, 0x100, 27, 0x02], false], [[0, 0x100, 27, 0x12], false],
  [[-1, 0x100, 27, 0], false], [[0, 0x101, 27, 0], false], [[0, 0x104, 27, 0], false], [[0, 0x100, 13, 0], false],
];
function assertFlags(s) {
  const rule = flagRule(s['DriverHook.cs']);
  for (const [args, expected] of flagRows) assert.equal(rule(...args), expected, JSON.stringify(args));
}
function assertCallback(s) {
  const callback = region(s['DriverHook.cs'], 'IntPtr Keyboard(', 'static void Prepare(');
  assert.match(callback, /HardwareEscape\(code, message.ToInt64\(\),\s*unchecked\(\(uint\)Marshal.ReadInt32\(data, 0\)\), unchecked\(\(uint\)Marshal.ReadInt32\(data, 8\)\)\)/);
  assert.match(callback, /Volatile.Write\(ref owner.Escape, 1\)/);
  assert.equal((callback.match(/\breturn\b/g) ?? []).length, 1);
  assert.match(callback, /catch \{ \}[^]*IntPtr next = CallNextHookEx\(IntPtr.Zero, code, message, data\);[^]*return next;/);
  assert.doesNotMatch(callback, /lock\s*\(|GetForegroundWindow|DriverSession|DriverInput|WriteLine|Sleep|Task|Invoke/);
  assert.doesNotMatch(s['DriverHook.cs'], /SetWindowsHookEx\(14|WH_MOUSE_LL|SendInput|SetForegroundWindow/);
}
function assertLifetime(s) {
  const hook = s['DriverHook.cs'];
  assert.match(hook, /IdleMs = 60000;/);
  assert.match(hook, /SetWindowsHookEx\(13, callback, GetModuleHandle\(null\), 0\)/);
  assert.match(hook, /status = GetMessageW\(out message, IntPtr.Zero, 0, 0\)/);
  assert.match(hook, /AppDomain.GetCurrentThreadId\(\)/);
  assert.doesNotMatch(hook, /ManagedThreadId\s*\)/);
  assert.match(hook, /PostThreadMessageW\(threadId, Wake, UIntPtr.Zero, IntPtr.Zero\)/);
  assert.match(hook, /if \(idle >= IdleMs\) \{\s*removalPending = true; remove = true; requested = false;\s*timer.Change\(Timeout.Infinite, Timeout.Infinite\);/);
  assert.match(hook, /if \(remove\) \{\s*Remove\(\);/);
  assert.match(hook, /finally \{\s*Remove\(\);\s*lock \(gate\)/);
  assert.match(region(hook, 'bool Remove()', 'void Run()'), /bool success = removing == IntPtr.Zero \|\| UnhookWindowsHookEx\(removing\);/);
  const dispose = region(hook, 'public void Dispose()');
  assert.match(dispose, /disposed = true;[^]*timer.Change\(0, 25\);[^]*pump.Join\(1000\);[^]*timer.Dispose\(\)/);
  assert.doesNotMatch(dispose, /Remove\(\)|UnhookWindowsHookEx/);
  assert.match(hook, /if \(!ready.WaitOne\(1000\)\) throw Unavailable\("hook-activation-timeout"\)/);
  assert.match(region(s['Driver.cs'], 'if (plan != null)', 'if (request.Method == "getState"'), /actionHook.Activate\(actionTurn\);\s*DriverInput.EnsureBudget\(\);/);
  assert.match(region(s['Driver.cs'], 'static object DispatchCore(', 'static string Encode('),
    /DriverActionPlan.Parse\(request.Method, p\);[^]*DriverSession.Require\(\);[^]*actionHook.Activate\(actionTurn\)/);
  const dispatch = region(s['Driver.cs'], 'static object DispatchCore(', 'static string Encode(');
  assert.ok(dispatch.indexOf('actionHook.Activate(actionTurn)') > dispatch.indexOf('DriverSession.Require();'));
  assert.match(s['Driver.cs'], /hooks.RequestSeen\(\)/);
  assert.match(s['Driver.cs'], /finally \{[^]*jobs.CompleteAdding\(\); worker.Join\(300\);\s*hooks.Dispose\(\);/);
}
function assertCancel(s) {
  const driver = s['Driver.cs'];
  assert.match(driver, /"stuckMenuEscape", "cancel"/);
  const cancel = region(driver, 'internal static object CancelRequest(', 'static readonly object writer');
  assert.match(cancel, /Json.Keys\(request.Params, "id"\)/);
  assert.match(cancel, /Json.Integer\(request.Params\["id"\], 1, 9007199254740991\)/);
  assert.match(cancel, /pending.TryGetValue\(id, out target\) && Volatile.Read\(ref target.Finished\) == 0/);
  assert.doesNotMatch(cancel, /target.Done/);
  assert.match(driver, /Volatile.Write\(ref job.Finished, 1\); job.Done.Set\(\)/);
  assert.match(driver, /pending.TryRemove\(request.Id, out removed\);[^]*?job.Done.Dispose\(\)/);
  assert.match(cancel, /if \(inFlight\) target.Stop\(DriverInput.StopReason.Cancel\)/);
  assert.match(cancel, /Json.Map\("cancelled", id, "inFlight", inFlight\)/);
  const reader = region(driver, 'var inputThread = new Thread(', 'inputThread.Start();');
  assert.match(reader, /Request.Parse\(line, nonce, previous\); previous = request.Id/);
  assert.match(reader, /if \(request.Method == "cancel"\) \{\s*WriteResponse\([^]*CancelRequest\(request, pending\)\)\);\s*continue;\s*\}\s*var job = new Job/);
  assert.match(reader, /pending.TryAdd\(request.Id, job\) \|\| !incoming.TryAdd\(job\)/);
  assert.doesNotMatch(reader, /jobs.Add\(|Done.WaitOne\((?!0\))/);
  assert.match(driver, /new BlockingCollection<Job>\(32\)/);
  assert.match(driver, /Interlocked.CompareExchange\(ref Cancel, \(int\)reason, 0\)/);
  assert.match(driver, /var reason = \(DriverInput.StopReason\)Volatile.Read\(ref job.Cancel\)/);
  assert.match(driver, /inputBearing && job.Turn != null && job.Turn.Escaped \? DriverInput.StopReason.Escape/);
  assert.match(driver, /job.Stop\(DriverInput.StopReason.Deadline\);\s*bool cleaned = job.Done.WaitOne\(300\)/);
  assert.match(driver, /WaitHandle.WaitAny\(new WaitHandle\[\] \{ job.Done, invalid \}/);
  assert.equal((driver.match(/Console.Out.WriteLine\(/g) ?? []).length, 2);
  assert.equal((driver.match(/lock \(writer\) \{ Console.Out.WriteLine\(line\); \}/g) ?? []).length, 2);
  assert.match(driver, /WriteResponse\(response\); return 70/);
}
function assertCheckpoints(s) {
  const input = s['DriverInput.cs'];
  assert.match(input, /Func<StopReason> Cancelled/);
  assert.match(input, /enum StopReason \{ None, Deadline, Cancel, Escape \}/);
  const cancel = region(input, 'internal static void EnsureNotCancelled()', 'internal static void EnsureBudget()');
  assert.match(cancel, /reason == StopReason.Cancel \|\| reason == StopReason.Escape/);
  assert.match(cancel, /DriverSession.WireFault\(DriverSession.Refusal\("USER_STOPPED", reason == StopReason.Escape \? "escape" : "cancel"\)\)/);
  assert.match(cancel, /reason == StopReason.Deadline\) throw DriverSession.BudgetFault\(\)/);
  assert.match(region(input, 'internal static void EnsureBudget()', 'internal static void Pause('), /EnsureNotCancelled\(\);/);
  assert.match(s['DriverInventory.cs'], /return fault.Code == "USER_STOPPED" \|\|/);
  assert.match(s['DriverInventory.cs'], /internal static void Require\(\)\s*\{\s*DriverInput.EnsureNotCancelled\(\)/);
  assert.equal((s['DriverCapture.cs'].match(/DriverInput.EnsureNotCancelled\(\)/g) ?? []).length, 2);
  assert.match(s['DriverSettle.cs'], /while \(mode == "wait"\) \{[^]*?DriverInput.EnsureNotCancelled\(\);\s*if \(Driver.Now\(\) >= deadline/);
  const drag = region(input, 'internal static void Drag(');
  assert.match(drag, /Pause\(500\)/); assert.match(drag, /Pause\(duration \/ steps\)/);
  assert.match(drag, /finally \{ Post\(window, hwnd, 0x202, 0, last, true\); \}/);
  assert.match(input, /EnsureBudget\(\);\s*long remaining = milliseconds - clock.ElapsedMilliseconds;\s*if \(remaining <= 0\) break;\s*Thread.Sleep\(\(int\)Math.Min\(10, remaining\)\)/);
  assert.match(input, /if \(!cleanup\) EnsureBudget\(\)/);
  const post = region(input, 'internal static void Post(', 'internal static void RequirePostMessage(');
  assert.match(post, /RequirePostMessage\(message\);\s*if \(!cleanup\) EnsureBudget\(\);/);
}
function assertReadLocals(s) {
  const all = Object.values(s).join('\n');
  assert.equal((all.match(/new DriverSession.ReadProbe\(\)/g) ?? []).length, 2);
  assert.doesNotMatch(all, /(?:^|\n)\s*(?:(?:static|readonly|private|internal|public)\s+)*(?:DriverSession\.)?ReadProbe\s+\w+\s*[;=]/);
  assert.doesNotMatch(s['DriverInput.cs'], /ReadProbe/);
  for (const [file, start, end] of [['DriverUia.cs', 'internal object Read(', 'public void Dispose('],
    ['DriverActions.cs', 'string Snapshot(', null]]) {
    const method = region(s[file], start, end);
    assert.equal((method.match(/var session = new DriverSession.ReadProbe\(\);/g) ?? []).length, 1);
    assert.equal((s[file].match(/new DriverSession.ReadProbe\(\)/g) ?? []).length, 1);
    assert.match(method, /\(\) => \{ session.Require\(\); return nodes.Count/);
  }
}
const allowlist = JSON.parse(readFileSync(new URL('./fixtures/windows-driver-interop.json', import.meta.url)));
function assertInterop(s, list = allowlist, built = windowsDriverSources) {
  assert.ok(built.includes('DriverHook.cs'));
  const expected = ['SetWindowsHookEx', 'UnhookWindowsHookEx', 'CallNextHookEx', 'GetModuleHandle', 'GetMessageW',
    'TranslateMessage', 'DispatchMessageW', 'PostThreadMessageW'];
  assert.deepEqual(list['DriverHook.cs'].map(line => /extern \w+ (\w+)\(/.exec(line)[1]), expected);
  inspectDriverSource('DriverHook.cs', s['DriverHook.cs'], list['DriverHook.cs']);
  assert.equal((s['DriverHook.cs'].match(/\[DllImport\(/g) ?? []).length, 8);
}
for (const [name, check] of Object.entries({ flags: assertFlags, callback: assertCallback, lifetime: assertLifetime,
  cancel: assertCancel, checkpoints: assertCheckpoints, readLocals: assertReadLocals, interop: assertInterop }))
  test('UC3B2 production source: ' + name, () => check(sources()));

function cancelRule(source) {
  const body = /object CancelRequest\([^)]*\)\s*\{([^]*?)\n    \}/.exec(source)?.[1];
  assert.ok(body);
  const js = body.replace('long id', 'let id').replace('Job target;', 'let target;').replace('bool inFlight', 'let inFlight')
    .replace('pending.TryGetValue(id, out target)', '((target = pending.get(id)) !== undefined)')
    .replace('Volatile.Read(ref target.Finished)', 'Number(target.done)');
  const Json = {
    Keys(p, required) { assert.equal(Object.keys(p).sort().join(' '), required); },
    Integer(value, min, max) { assert.ok(Number.isSafeInteger(value) && value >= min && value <= max); return value; },
    Map(...pairs) { return Object.fromEntries(Array.from({ length: pairs.length / 2 }, (_, i) => pairs.slice(i * 2, i * 2 + 2))); },
  };
  return runInNewContext(`(request, pending) => { ${js} }`, { Json, DriverInput: { StopReason: { Cancel: 2 } } });
}
function cancelDecisionWitness(source) {
  const cancel = cancelRule(source), pending = new Map();
  const job = { done: false, reason: 0, Stop(reason) { if (!this.reason) this.reason = reason; } };
  pending.set(11, job);
  const request = { Id: 12, Params: { id: 11 } };
  const result = cancel(request, pending);
  assert.equal(result.cancelled, 11); assert.equal(result.inFlight, true); assert.equal(job.reason, 2);
  job.done = true; job.reason = 0;
  assert.equal(cancel(request, pending).inFlight, false); assert.equal(job.reason, 0);
  request.Params.id = 10; assert.equal(cancel(request, pending).inFlight, false);
  for (const id of [0, -1, 1.5, '11', 9007199254740992])
    assert.throws(() => cancel({ Params: { id } }, pending));
  assert.throws(() => cancel({ Params: { id: 11, extra: true } }, pending));
}
test('UC3B2 production cancel decision addresses the stub job and leaves finished/unknown ids alone', () => cancelDecisionWitness(native('Driver.cs')));
test('UC3B2 stub-job witness rejects a dropped cancel and inverted completion check', () => {
  for (const [before, after] of [['if (inFlight) target.Stop(DriverInput.StopReason.Cancel);', ''],
    ['Volatile.Read(ref target.Finished) == 0', 'Volatile.Read(ref target.Finished) != 0']]) {
    const source = native('Driver.cs'); assert.ok(source.includes(before));
    assert.throws(() => cancelDecisionWitness(source.replace(before, after)), { code: 'ERR_ASSERTION' });
  }
});

const variants = [
  ['injected flag', assertFlags, 'DriverHook.cs', 'flags & 0x12', 'flags & 0x02'],
  ['lower IL flag', assertFlags, 'DriverHook.cs', 'flags & 0x12', 'flags & 0x10'],
  ['other key', assertFlags, 'DriverHook.cs', 'key == 0x1b', 'key != 0'],
  ['key up', assertFlags, 'DriverHook.cs', 'message == 0x100', 'message != 0'],
  ['negative code', assertFlags, 'DriverHook.cs', 'code >= 0', 'code >= -1'],
  ['callback bypasses flags', assertCallback, 'DriverHook.cs', 'HardwareEscape(code, message.ToInt64(),', 'OtherRule(code, message.ToInt64(),'],
  ['callback swallows', assertCallback, 'DriverHook.cs', 'return next;', 'return new IntPtr(1);'],
  ['early callback return', assertCallback, 'DriverHook.cs', 'Volatile.Write(ref owner.Escape, 1);', 'return IntPtr.Zero;'],
  ['idle duration', assertLifetime, 'DriverHook.cs', 'IdleMs = 60000', 'IdleMs = 600000'],
  ['idle unhook', assertLifetime, 'DriverHook.cs', 'removalPending = true; remove = true; requested = false;', 'requested = false;'],
  ['pump finally unhook', assertLifetime, 'DriverHook.cs', 'finally {\n            Remove();', 'finally {'],
  ['exit unhook', assertLifetime, 'Driver.cs', 'hooks.Dispose();', ''],
  ['unhook API', assertLifetime, 'DriverHook.cs', 'UnhookWindowsHookEx(removing)', 'true'],
  ['missing pump', assertLifetime, 'DriverHook.cs', 'status = GetMessageW(out message, IntPtr.Zero, 0, 0)', 'status = 1'],
  ['missing activation', assertLifetime, 'Driver.cs', 'actionHook.Activate(actionTurn);', ''],
  ['activation before validation', assertLifetime, 'Driver.cs', '        DriverSession.Require();\n        DriverIdentity.BeginRequest();', '        actionHook.Activate(actionTurn);\n        DriverIdentity.BeginRequest();'],
  ['activation before parameter parsing', assertLifetime, 'Driver.cs', 'plan = DriverActionPlan.Parse(request.Method, p);', 'actionHook.Activate(actionTurn); plan = DriverActionPlan.Parse(request.Method, p);'],
  ['cancel enqueued', assertCancel, 'Driver.cs', 'continue;\n                        }\n                        var job', '}\n                        var job'],
  ['cancel flag dropped', assertCancel, 'Driver.cs', 'if (inFlight) target.Stop(DriverInput.StopReason.Cancel);', ''],
  ['wrong cancel id', assertCancel, 'Driver.cs', 'pending.TryGetValue(id, out target)', 'pending.TryGetValue(request.Id, out target)'],
  ['cancel reader blocks', assertCancel, 'Driver.cs', 'hooks.RequestSeen();', 'hooks.RequestSeen(); jobs.Add(job);'],
  ['worker ignores cancel', assertCancel, 'Driver.cs', 'Volatile.Read(ref job.Cancel)', '0'],
  ['cancel reads disposed handle', assertCancel, 'Driver.cs', 'Volatile.Read(ref target.Finished) == 0', '!target.Done.WaitOne(0)'],
  ['worker ignores escape', assertCancel, 'Driver.cs', 'inputBearing && job.Turn != null && job.Turn.Escaped', 'false'],
  ['stdout unlocked', assertCancel, 'Driver.cs', 'lock (writer) { Console.Out.WriteLine(line); }', 'Console.Out.WriteLine(line);'],
  ['watchdog cleanup removed', assertCancel, 'Driver.cs', 'job.Done.WaitOne(300)', 'false'],
  ['cancel becomes budget', assertCheckpoints, 'DriverInput.cs', 'DriverSession.Refusal("USER_STOPPED",', 'DriverSession.Refusal("ACTION_BUDGET",'],
  ['capture cancel dropped', assertCheckpoints, 'DriverCapture.cs', 'DriverInput.EnsureNotCancelled();', ''],
  ['settle cancel dropped', assertCheckpoints, 'DriverSettle.cs', 'DriverInput.EnsureNotCancelled();', ''],
  ['stop masked by route', assertCheckpoints, 'DriverInventory.cs', 'fault.Code == "USER_STOPPED" || ', ''],
  ['read cancel dropped', assertCheckpoints, 'DriverInventory.cs', 'DriverInput.EnsureNotCancelled();', ''],
  ['uncancellable drag hold', assertCheckpoints, 'DriverInput.cs', 'Pause(500);', 'Thread.Sleep(500);'],
  ['uncancellable drag step', assertCheckpoints, 'DriverInput.cs', 'Pause(duration / steps);', 'Thread.Sleep(duration / steps);'],
  ['cleanup refused', assertCheckpoints, 'DriverInput.cs', 'if (!cleanup) EnsureBudget();', 'EnsureBudget();'],
  ['probe field hoisted', assertReadLocals, 'DriverUia.cs', 'var session = new DriverSession.ReadProbe();', 'session = new DriverSession.ReadProbe();'],
  ['extra probe', assertReadLocals, 'Driver.cs', 'public static int Entry(', 'static DriverSession.ReadProbe cached = new DriverSession.ReadProbe();\n    public static int Entry('],
  ['input memo', assertReadLocals, 'DriverInput.cs', 'DriverSession.Require();', 'new DriverSession.ReadProbe().Require();'],
];
for (const [name, check, file, before, after] of variants) test('UC3B2 rejects broken variant: ' + name, () => {
  const s = sources(); assert.ok(s[file].includes(before), name + ' anchor');
  s[file] = s[file].replace(before, after);
  assert.throws(() => check(s), { code: 'ERR_ASSERTION' });
});
test('UC3B2 rejects missing, extra and altered hook imports and a missing compiled hook', () => {
  const s = sources();
  assert.throws(() => assertInterop(s, allowlist, windowsDriverSources.filter(name => name !== 'DriverHook.cs')));
  for (let i = 0; i < 8; i++) {
    const list = structuredClone(allowlist); list['DriverHook.cs'].splice(i, 1);
    assert.throws(() => assertInterop(s, list));
  }
  const list = structuredClone(allowlist); list['DriverHook.cs'].push('[DllImport("user32.dll")] static extern void SendInput();');
  assert.throws(() => assertInterop(s, list));
  const changed = { ...s, 'DriverHook.cs': s['DriverHook.cs'].replace('GetModuleHandle(string name)', 'GetModuleHandle(int name)') };
  assert.throws(() => assertInterop(changed));
});
