import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createWindowsDriverClient } from '../plugins/sleight/lib/driver-client.mjs';
import { createWindowsDriverClient as wrappedClient } from '../plugins/sleight/lib/windows-driver/client.mjs';
import { createDriverSafety, createWindowsSafety } from '../plugins/sleight/lib/driver-safety.mjs';

const lib = new URL('../plugins/sleight/lib/', import.meta.url);
const source = name => readFileSync(new URL(name, lib), 'utf8');
const bank = () => ({
  hook: source('direct-browser/native/win/DriverHook.cs'),
  driver: source('direct-browser/native/win/Driver.cs'),
  fixture: readFileSync(new URL('./fixtures/windows-driver-checks.cs', import.meta.url), 'utf8'),
});
const region = (text, start, end) => {
  const first = text.indexOf(start), last = text.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, start);
  return text.slice(first, last);
};
function outsideGate(text) {
  // Ignore comments and literals, then inspect every balanced gate body.
  const code = text.replace(/\/\/[^\n]*|\/\*[^]*?\*\/|"(?:\\.|[^"\\])*"/g, s => ' '.repeat(s.length));
  for (const match of code.matchAll(/lock\s*\(gate\)\s*\{/g)) {
    let depth = 1, i = match.index + match[0].length;
    const start = i;
    for (; depth && i < code.length; i++) { if (code[i] === '{') depth++; if (code[i] === '}') depth--; }
    assert.equal(depth, 0);
    assert.doesNotMatch(code.slice(start, i), /(?:UnhookWindowsHookEx|SetWindowsHookEx|WaitOne|Join)\s*\(/);
  }
}
function removal({ hook, driver }) {
  const end = region(hook, 'internal object EndTurn(', 'internal static bool HardwareEscape(');
  const dispose = hook.slice(hook.indexOf('public void Dispose('));
  const remove = region(hook, 'bool Remove()', 'void Run()');
  const run = region(hook, 'void Run()', 'public void Dispose(');
  assert.doesNotMatch(end + dispose, /\bRemove\(\)|UnhookWindowsHookEx/);
  assert.equal((hook.match(/\bRemove\(\);/g) ?? []).length, 2);
  assert.equal((run.match(/\bRemove\(\);/g) ?? []).length, 2);
  outsideGate(hook);
  assert.match(end, /removed.Reset\(\); removalPending = true;\s*timer.Change\(0, 25\)/);
  assert.match(end, /bool receipt = removed.WaitOne\(200\)/);
  assert.match(end, /if \(!receipt && removalPending\) removalFailure = "hook-removal-timeout"/);
  assert.match(end, /if \(removalFailure != null\) throw Unavailable\(removalFailure\)/);
  assert.match(end, /if \(hook != IntPtr.Zero\) throw Unavailable\("hook-unhook-failed"\)/);
  assert.match(hook, /PostThreadMessageW\(threadId, Wake, UIntPtr.Zero, IntPtr.Zero\)/);
  assert.match(run, /if \(remove\) \{\s*Remove\(\);\s*lock \(gate\) \{\s*removalPending = false;\s*timer.Change\(Timeout.Infinite, Timeout.Infinite\);\s*removed.Set\(\)/);
  assert.match(remove, /bool success = removing == IntPtr.Zero \|\| UnhookWindowsHookEx\(removing\)/);
  assert.match(remove, /if \(!success\) success = UnhookWindowsHookEx\(removing\);/);
  assert.equal((remove.match(/UnhookWindowsHookEx\(removing\)/g) ?? []).length, 2);
  assert.doesNotMatch(remove, /\b(?:while|for)\s*\(/);
  assert.match(remove, /if \(!success\) \{ removalFailure = "hook-unhook-failed"; return false; \}\s*hook = IntPtr.Zero; removalFailure = null;/);
  assert.doesNotMatch(remove, /failed\s*=/);
  for (const method of [region(hook, 'internal void BeginTurn(', 'internal object EndTurn('),
    region(hook, 'internal void Activate(', 'void WakePump(')])
    assert.match(method, /if \(removalPending \|\| removalFailure != null\) throw Unavailable\(removalFailure \?\? "hook-removal-pending"\)/);
  assert.match(hook, /Disposition = Json.Map\("delivery", "not-sent", "retry", "safe", "reason", reason, "typed", 0\)/);
  assert.match(hook, /code \+ ": reason=" \+ reason \+ "; delivery=not-sent; retry=safe; typed=0\."/);
  assert.match(driver, /result = hooks.EndTurn\(id\)/);
  assert.match(driver, /catch \(DriverFault e\) \{\s*if \(e.Code == "INVALID_PARAMS"\) throw;\s*WriteResponse\([^]*?"ok", false, "error", ErrorValue\(e\)\)\);\s*continue;/);
  const begin = region(hook, 'internal void BeginTurn(', 'internal object EndTurn(');
  assert.match(begin, /if \(failed\) throw Unavailable\(failureReason \?\? "hook-pump-exited"\)/);
  assert.match(begin, /retry = removalFailure != null && !removalPending && threadId != 0/);
  assert.match(begin, /if \(retry\) \{ removed.Reset\(\); removalPending = true; timer.Change\(0, 25\); \}/);
  assert.match(begin, /if \(retry\) \{\s*WakePump\(\);\s*bool receipt = removed.WaitOne\(200\)/);
  assert.match(begin, /if \(!receipt && removalPending\) removalFailure = "hook-removal-timeout"/);
  assert.match(end, /if \(failed && threadId == 0\) throw Unavailable\(failureReason \?\? "hook-pump-exited"\)/);
  assert.ok(end.indexOf('if (failed && threadId == 0)') < end.indexOf('removed.Reset()'));
  assert.match(end, /if \(wait\) \{\s*WakePump\(\);[^]*?removed.WaitOne\(200\)/);
}
const preparations = [
  'RuntimeHelpers.PrepareMethod(callback.Method.MethodHandle);', 'RuntimeHelpers.PrepareDelegate(callback);',
  'Prepare(typeof(DriverHook), "HardwareEscape", typeof(int), typeof(long), typeof(uint), typeof(uint));',
  'Prepare(typeof(DriverHookSamples), "Record", typeof(long));', 'Prepare(typeof(Stopwatch), "GetTimestamp");',
  'Prepare(typeof(IntPtr), "ToInt64");', 'Prepare(typeof(Marshal), "ReadInt32", typeof(IntPtr), typeof(int));',
  'Prepare(typeof(Volatile), "Read", typeof(int).MakeByRefType());',
  'Prepare(typeof(Volatile), "Write", typeof(int).MakeByRefType(), typeof(int));',
  'Prepare(typeof(Volatile), "Write", typeof(long).MakeByRefType(), typeof(long));',
  'Prepare(typeof(DriverHook), "CallNextHookEx", typeof(IntPtr), typeof(int), typeof(IntPtr), typeof(IntPtr));',
];
function callbackCost({ hook, driver }) {
  assert.match(hook, /new Thread\(Run\) \{ IsBackground = true, Priority = ThreadPriority.AboveNormal \}/);
  assert.match(hook, /RuntimeHelpers.PrepareMethod\(type.GetMethod\([^]*?parameters, null\).MethodHandle\)/);
  const prepare = region(hook, 'void PrepareCallback()', 'internal static DriverFault Unavailable(');
  for (const line of preparations) assert.ok(prepare.includes(line), line);
  const run = region(hook, 'void Run()', 'public void Dispose(');
  assert.ok(run.indexOf('PrepareCallback();') >= 0 && run.indexOf('PrepareCallback();') < run.indexOf('SetWindowsHookEx(13,'));
  const callback = region(hook, 'IntPtr Keyboard(', 'static void Prepare(');
  const record = region(hook, 'internal void Record(', 'internal void Drain(');
  assert.doesNotMatch(callback + record, /lock\s*\(|\bnew\b|\b(?:while|for|foreach)\s*\(|Array\.|Json\.|Drain\(|WriteLine|Interlocked|Sleep|Task|Invoke|DriverSession|GetForegroundWindow/);
  assert.match(callback, /long started = Stopwatch.GetTimestamp\(\)/);
  assert.match(callback, /owner.Samples.Record\(Stopwatch.GetTimestamp\(\) - started\)/);
  assert.match(callback, /long beforeNext = Stopwatch.GetTimestamp\(\);\s*IntPtr next = CallNextHookEx/);
  assert.match(callback, /owner.OwnSamples.Record\(beforeNext - started\)/);
  assert.match(hook, /"hookOwnCallbacks", ended.OwnSamples.JsonValue\("before-next-hook"\)/);
  assert.match(callback, /IntPtr next = CallNextHookEx\(IntPtr.Zero, code, message, data\);[^]*owner.Samples.Record\([^]*return next;/);
  assert.match(record, /if \(duration > maximum\) Volatile.Write\(ref maximum, duration\)/);
  assert.match(record, /if \(callbacks < Int32.MaxValue\) Volatile.Write\(ref callbacks, callbacks \+ 1\)/);
  assert.match(record, /if \(index < Capacity\) \{\s*ticks\[index\] = duration;\s*Volatile.Write\(ref published, index \+ 1\)/);
  assert.ok(record.indexOf('duration > maximum') < record.indexOf('index < Capacity'));
  assert.match(hook, /Capacity = 8192;/);
  assert.match(hook, /readonly long\[\] ticks = new long\[Capacity\], drained = new long\[Capacity\]/);
  assert.match(hook, /int count = Volatile.Read\(ref published\);\s*while \(read < count\) \{ drained\[read\] = ticks\[read\]; read\+\+; \}/);
  assert.doesNotMatch(region(hook, 'internal void RequestSeen(', 'internal void Activate('), /\.Drain\(\)/);
  assert.match(region(hook, 'internal object JsonValue(', '// One keyboard-only pump'), /Drain\(\)/);
  assert.match(hook, /double us = 1000000.0 \/ Stopwatch.Frequency/);
  assert.match(hook, /"p50Us", read == 0 \? \(object\)null : sorted\[\(int\)Math.Ceiling\(read \* 0.50\) - 1\] \* us/);
  assert.match(hook, /"p99Us", read == 0 \? \(object\)null : sorted\[\(int\)Math.Ceiling\(read \* 0.99\) - 1\] \* us/);
  assert.match(hook, /"maxUs", total == 0 \? \(object\)null : Volatile.Read\(ref maximum\) \* us/);
  assert.match(hook, /"omitted", total - read, "capacity", Capacity, "samplesUs", samples, "saturated", total == Int32.MaxValue/);
  assert.match(hook, /JsonValue\(string scope = "through-next-hook"\)/);
  assert.match(hook, /"scope", scope/);
  assert.match(hook, /"hookCallbacks", ended.Samples.JsonValue\(\)/);
  assert.match(driver, /"ok", true, "result", result\)\)/);
}
function fixtureRows({ fixture }) {
  assert.match(fixture, /int turnRows = TurnChecks\(\), sampleRows = SampleChecks\(\)/);
  for (const line of ['hook.BeginTurn(1); check(Object.ReferenceEquals(old, hook.CurrentTurn));',
    'old.Escape = 1; hook.BeginTurn(1); check(old.Escaped);', 'Json.Object(hook.EndTurn(1))',
    'old.Active == 0 && hook.CurrentTurn == null', 'hook.BeginTurn(0)', 'hook.Activate(old)',
    '(double)result["p99Us"] == 99 * us', '(int)result["omitted"] == 3']) assert.ok(fixture.includes(line), line);
}
for (const [name, check] of Object.entries({ removal, callbackCost, fixtureRows }))
  test('UC3B2C source: ' + name, () => check(bank()));

const variants = [
  ['reader unhooks', removal, 'hook', 'ended = turn;', 'ended = turn; Remove();'],
  ['dispose unhooks', removal, 'hook', 'bool stopped = pump.Join(1000);', 'Remove(); bool stopped = pump.Join(1000);'],
  ['reader waits under gate', removal, 'hook', 'bool receipt = removed.WaitOne(200);', 'bool receipt; lock (gate) { receipt = removed.WaitOne(200); }'],
  ['native unhook holds reader gate', removal, 'hook', 'bool success = removing == IntPtr.Zero || UnhookWindowsHookEx(removing);',
    'bool success; lock (gate) { success = removing == IntPtr.Zero || UnhookWindowsHookEx(removing); }'],
  ['no removal request', removal, 'hook', 'removed.Reset(); removalPending = true;', 'removed.Reset();'],
  ['no bounded receipt', removal, 'hook', 'removed.WaitOne(200)', 'removed.WaitOne()'],
  ['receipt exceeds cancel budget', removal, 'hook', 'removed.WaitOne(200)', 'removed.WaitOne(1000)'],
  ['receipt precedes unhook', removal, 'hook', 'if (remove) {\n                        Remove();', 'if (remove) {\n                        removed.Set(); Remove();'],
  ['lost timeout reason', removal, 'hook', 'removalFailure = "hook-removal-timeout"', 'removalFailure = null'],
  ['failed removal hidden', removal, 'hook', 'if (removalFailure != null) throw Unavailable(removalFailure);', ''],
  ['failed handle forgotten', removal, 'hook', 'if (!success) { removalFailure = "hook-unhook-failed"; return false; }', 'if (!success) { hook = IntPtr.Zero; }'],
  ['no bounded pump retry', removal, 'hook', 'if (!success) success = UnhookWindowsHookEx(removing);', ''],
  ['unbounded pump retry', removal, 'hook', 'if (!success) success = UnhookWindowsHookEx(removing);', 'while (!success) success = UnhookWindowsHookEx(removing);'],
  ['no recovery on next start', removal, 'hook', 'retry = removalFailure != null && !removalPending && threadId != 0;', 'retry = false;'],
  ['dead pump reason masked at end', removal, 'hook', 'if (failed && threadId == 0) throw Unavailable(failureReason ?? "hook-pump-exited");', ''],
  ['dead pump reason masked at start', removal, 'hook', 'if (failed) throw Unavailable(failureReason ?? "hook-pump-exited");', ''],
  ['no immediate reader wake', removal, 'hook', 'WakePump(); // Reader posts immediately; the timer retries a missing queue.', '// Timer only.'],
  ['unhook failure permanently fails pump', removal, 'hook', 'removalFailure = "hook-unhook-failed";', 'failed = true; removalFailure = "hook-unhook-failed";'],
  ['begin skips removal barrier', removal, 'hook', 'if (removalPending || removalFailure != null)', 'if (false)'],
  ['missing disposition', removal, 'hook', '"delivery", "not-sent", "retry", "safe", "reason", reason, "typed", 0', '"reason", reason'],
  ['lifecycle error retires reader', removal, 'driver', 'if (e.Code == "INVALID_PARAMS") throw;', 'throw;'],
  ['normal priority', callbackCost, 'hook', 'Priority = ThreadPriority.AboveNormal', 'Priority = ThreadPriority.Normal'],
  ...preparations.map((line, i) => ['missing callback preparation ' + i, callbackCost, 'hook', line, '']),
  ['preparation after installation', callbackCost, 'hook', 'PrepareCallback();', ''],
  ['callback takes lock', callbackCost, 'hook', 'long started = Stopwatch.GetTimestamp();', 'lock (gate) {} long started = Stopwatch.GetTimestamp();'],
  ['callback allocates', callbackCost, 'hook', 'long started = Stopwatch.GetTimestamp();', 'var scratch = new long[1]; long started = Stopwatch.GetTimestamp();'],
  ['no per-callback duration', callbackCost, 'hook', 'owner.Samples.Record(Stopwatch.GetTimestamp() - started)', 'owner.Samples.Record(0)'],
  ['no own callback stamp', callbackCost, 'hook', 'long beforeNext = Stopwatch.GetTimestamp();', 'long beforeNext = started;'],
  ['own cost includes chain', callbackCost, 'hook', 'owner.OwnSamples.Record(beforeNext - started)', 'owner.OwnSamples.Record(Stopwatch.GetTimestamp() - started)'],
  ['own samples lost at end', callbackCost, 'hook', '"hookOwnCallbacks", ended.OwnSamples.JsonValue("before-next-hook")', '"missing", null'],
  ['unbounded sample writes', callbackCost, 'hook', 'if (index < Capacity)', 'if (true)'],
  ['maximum not recorded', callbackCost, 'hook', 'if (duration > maximum) Volatile.Write(ref maximum, duration);', ''],
  ['callback count not recorded', callbackCost, 'hook', 'if (callbacks < Int32.MaxValue) Volatile.Write(ref callbacks, callbacks + 1);', ''],
  ['sample published before data', callbackCost, 'hook', 'ticks[index] = duration;\n            Volatile.Write(ref published, index + 1);', 'Volatile.Write(ref published, index + 1);\n            ticks[index] = duration;'],
  ['request drain holds gate', callbackCost, 'hook', 'lastRequest = clock.ElapsedMilliseconds;', 'lastRequest = clock.ElapsedMilliseconds; turn.Samples.Drain();'],
  ['wrong duration units', callbackCost, 'hook', '1000000.0 / Stopwatch.Frequency', '1000.0 / Stopwatch.Frequency'],
  ['wrong p50', callbackCost, 'hook', 'Math.Ceiling(read * 0.50)', 'Math.Ceiling(read * 0.99)'],
  ['wrong p99', callbackCost, 'hook', 'Math.Ceiling(read * 0.99)', 'Math.Ceiling(read * 0.50)'],
  ['max loses omitted samples', callbackCost, 'hook', 'Volatile.Read(ref maximum) * us', 'sorted[read - 1] * us'],
  ['turn result loses samples', callbackCost, 'hook', '"hookCallbacks", ended.Samples.JsonValue()', '"missing", null'],
  ['fixture turn checks not called', fixtureRows, 'fixture', 'turnRows = TurnChecks()', 'turnRows = 13'],
  ['fixture sample checks not called', fixtureRows, 'fixture', 'sampleRows = SampleChecks()', 'sampleRows = 8'],
];
for (const [name, check, file, before, after] of variants) test('UC3B2C rejects broken source: ' + name, () => {
  const s = bank(); assert.ok(s[file].includes(before), name + ' anchor');
  s[file] = s[file].replace(before, after);
  assert.throws(() => check(s), { code: 'ERR_ASSERTION' });
});

async function variant(name, before, after) {
  const url = new URL(name, lib), original = source(name); assert.ok(original.includes(before), before);
  const changed = original.replace(before, after).replace(/from (['"])(\.[^'"]+)\1/g,
    (_, q, path) => 'from ' + q + new URL(path, url).href + q);
  return import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'));
}
function peer(t, factory = createWindowsDriverClient, { stats, ownStats, endError } = {}) {
  const frames = [], children = [];
  let busy = false;
  const client = factory({ platform: 'win32', lineLimit: 1024 * 1024, prepare: async () => ({ status: 'ready', spawn({ nonce }) {
    let active = false, blocked = false;
    const child = new EventEmitter(); children.push(child);
    child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.stderr = new PassThrough();
    Object.defineProperty(child.stdin, 'writableLength', { get: () => busy ? 2 * 1024 * 1024 : 0 });
    const close = () => queueMicrotask(() => child.emit('close', 0));
    child.kill = close; child.stdin.on('finish', close);
    child.stdin.on('data', bytes => {
      const r = JSON.parse(bytes.toString()); frames.push(r);
      let result = {}, error;
      if (r.method === 'turn-start') {
        if (blocked) error = endError;
        else { active = true; result = { turn: r.params.turn, active: true }; }
      } else if (r.method === 'turn-end') {
        active = false; blocked = !!endError;
        error = endError; result = { turn: r.params.turn, active: false, ...stats ? { hookCallbacks: stats } : {},
          ...ownStats ? { hookOwnCallbacks: ownStats } : {} };
      } else if (r.method === 'typeText' && !active) error = { code: 'TURN_INACTIVE', message: 'fixture', unhealthy: false };
      queueMicrotask(() => child.stdout.write(JSON.stringify({ protocol: r.protocol, nonce, id: r.id,
        ...error ? { ok: false, error } : { ok: true, result } }) + '\n'));
    });
    return child;
  } }) });
  t.after(() => client.close());
  return { client, frames, children, set busy(value) { busy = value; } };
}
async function synchronousStart(t, factory = createWindowsDriverClient) {
  const h = peer(t, factory); await h.client.ping(); h.busy = true;
  await assert.rejects(h.client.request('typeText', { args: ['x'] }), { code: 'DRIVER_BUSY' });
  h.busy = false;
  assert.equal(await h.client.request('typeText', { args: ['x'] }).then(() => true, () => false), true);
  assert.equal(h.frames.filter(r => r.method === 'turn-start').length, 1);
}
test('a synchronous start send refusal leaves the turn eligible for retry', synchronousStart);
test('retry witness rejects publishing the turn before send returns', async t => {
  const broken = await variant('driver-client.mjs',
    "g.turnReady = send(g, 'turn-start', { turn: windowsTurn }, timeoutMs);\n        g.turn = windowsTurn;",
    "g.turn = windowsTurn;\n        g.turnReady = send(g, 'turn-start', { turn: windowsTurn }, timeoutMs);");
  await assert.rejects(synchronousStart(t, broken.createWindowsDriverClient), { code: 'ERR_ASSERTION' });
});
const refusal = { code: 'HOOK_UNAVAILABLE', message: 'Hook removal failed: reason=hook-unhook-failed; delivery=not-sent; retry=safe; typed=0.',
  unhealthy: false, delivery: 'not-sent', retry: 'safe', reason: 'hook-unhook-failed', typed: 0 };
async function removalRefusal(t, factory = wrappedClient) {
  const h = peer(t, factory, { endError: refusal });
  await h.client.request('typeText', { args: ['x'] });
  await assert.rejects(h.client.endWindowsTurn(), refusal);
  await h.client.ping(); assert.equal(h.children.length, 1);
  await assert.rejects(h.client.request('typeText', { args: ['x'] }), refusal);
  assert.equal(h.frames.filter(r => r.method === 'typeText').length, 1);
}
test('removal refusal retains its reason and closes input while reads keep the peer', removalRefusal);
test('refusal witness rejects replacing a removal reason with DRIVER_PROTOCOL', async t => {
  const broken = await variant('driver-client.mjs',
    "['turn-start', 'turn-end'].includes(call?.method) && value.ok && (",
    "['turn-start', 'turn-end'].includes(call?.method) && (!value.ok ||");
  await assert.rejects(removalRefusal(t, broken.createWindowsDriverClient), { code: 'ERR_ASSERTION' });
});
async function refusedStartEnd(t, factory = wrappedClient) {
  const h = peer(t, factory, { endError: refusal });
  await h.client.request('typeText', { args: ['x'] });
  await assert.rejects(h.client.endWindowsTurn(), refusal);
  await assert.rejects(h.client.request('typeText', { args: ['x'] }), refusal);
  assert.equal(await h.client.endWindowsTurn(), undefined);
  await h.client.ping(); assert.equal(h.children.length, 1);
  assert.equal(h.frames.filter(f => f.method === 'turn-end').length, 1);
}
test('a refused start owns no turn and a later end keeps the peer healthy', refusedStartEnd);
test('refused-start witness rejects relying on an INVALID_PARAMS end', async t => {
  const broken = await variant('driver-client.mjs', 'if (g.turn === startingTurn) g.turn = undefined;', '');
  await assert.rejects(refusedStartEnd(t, broken.createWindowsDriverClient));
});
const statsFor = total => {
  const samplesUs = Array.from({ length: Math.min(total, 8192) }, (_, i) => i + 1);
  return { scope: 'through-next-hook', callbacks: total, sampled: samplesUs.length, omitted: total - samplesUs.length,
    capacity: 8192, samplesUs, saturated: false, p50Us: samplesUs[Math.ceil(samplesUs.length * 0.50) - 1] ?? null,
    p99Us: samplesUs[Math.ceil(samplesUs.length * 0.99) - 1] ?? null, maxUs: total || null };
};
for (const count of [0, 1, 100, 8195]) test('turn result carries bounded duration samples and quantiles: ' + count, async t => {
  const stats = statsFor(count), h = peer(t, wrappedClient, { stats });
  await h.client.request('typeText', { args: ['x'] });
  assert.deepEqual((await h.client.endWindowsTurn()).hookCallbacks, stats);
  await h.client.request('typeText', { args: ['x'] }); assert.equal(h.children.length, 1);
});
const malformed = [
  ['wrong scope', s => { s.scope = 'all-keyboard-latency'; }], ['wrong capacity', s => { s.capacity++; }],
  ['negative count', s => { s.callbacks = -1; }], ['wrong sampled', s => { s.sampled--; }],
  ['missing omitted', s => { delete s.omitted; }], ['wrong p50', s => { s.p50Us++; }],
  ['wrong p99', s => { s.p99Us++; }], ['missing max', s => { s.maxUs = null; }],
  ['impossible max', s => { s.maxUs = 1; }], ['extra key', s => { s.key = 27; }],
  ['negative sample', s => { s.samplesUs[0] = -1; }], ['missing samples', s => { delete s.samplesUs; }],
  ['nonfinite sample', s => { s.samplesUs[0] = Infinity; }], ['wrong saturation', s => { s.saturated = true; }],
];
for (const [name, change] of malformed) test('malformed callback statistics retire the peer: ' + name, async t => {
  const stats = statsFor(100); change(stats);
  const h = peer(t, createWindowsDriverClient, { stats });
  await h.client.request('typeText', { args: ['x'] });
  await assert.rejects(h.client.endWindowsTurn(), { code: 'DRIVER_PROTOCOL' });
});
test('statistics witness rejects dropping the result validation', async t => {
  const broken = await variant('driver-client.mjs', '!validHookCallbacks(value.result.hookCallbacks)', 'false');
  const stats = statsFor(100); stats.p99Us = 1;
  const h = peer(t, broken.createWindowsDriverClient, { stats });
  await h.client.request('typeText', { args: ['x'] });
  await assert.rejects(async () => {
    await assert.rejects(h.client.endWindowsTurn(), { code: 'DRIVER_PROTOCOL' });
  }, { code: 'ERR_ASSERTION' });
});
async function endingReason(factory = createDriverSafety) {
  const safety = factory({ platform: 'win32' }, { queue: { serial: Promise.resolve(), queued: 0 }, epoch: () => 0,
    fail: assert.fail, dispatch: assert.fail });
  let release;
  const end = safety.endWindowsTurn(() => new Promise(resolve => { release = resolve; }));
  assert.throws(() => safety.checkUserStop('typeText'), { code: 'USER_STOPPED', reason: 'turn-ending', typed: 0, delivery: 'not-sent' });
  release(); await end; safety.checkUserStop('typeText');
}
test('an action racing an end receipt has a distinct turn-ending reason', () => endingReason());
test('end reason witness rejects claiming an Escape that did not happen', async () => {
  const broken = await variant('driver-safety.mjs', "userStopped === 'turn-ending' ? 'turn-ending' : 'escape'", "'escape'");
  await assert.rejects(endingReason(broken.createDriverSafety), { code: 'ERR_ASSERTION' });
});

async function failedEnd(factory = createDriverSafety, reason = 'hook-unhook-failed') {
  let dispatched = 0;
  const safety = factory({ platform: 'win32' }, { queue: { serial: Promise.resolve(), queued: 0 }, epoch: () => 0,
    fail: assert.fail, dispatch: () => ++dispatched });
  safety.windowsLifecycleAttributed();
  const error = Object.assign(Error('fixture'), { code: 'HOOK_UNAVAILABLE', reason });
  await assert.rejects(safety.endWindowsTurn(() => Promise.reject(error)), error);
  for (const method of ['typeText', 'click', 'stuckMenuEscape']) {
    await assert.rejects(safety.request(method, {}), error => {
      assert.equal(error.reason, reason); assert.equal(error.delivery, 'not-sent');
      assert.match(error.message, /Windows turn cleanup failed/);
      assert.match(error.message, /until a successful trusted turn end or a new session/);
      assert.doesNotMatch(error.message, /Escape|turn-ending/);
      if (method === 'typeText') assert.equal(error.typed, 0);
      return true;
    });
  }
  assert.equal(dispatched, 0);
  await safety.request('getState', {}); assert.equal(dispatched, 1);
  await safety.endWindowsTurn(() => {}); await safety.request('click', {}); assert.equal(dispatched, 2);
}
for (const reason of ['hook-unhook-failed', 'hook-removal-timeout', 'hook-pump-exited'])
  test('safety retains failed-end reason and refuses until a trusted end: ' + reason, () => failedEnd(createDriverSafety, reason));
test('failed-end witness rejects the old stuck turn-ending state', async () => {
  const broken = await variant('driver-safety.mjs', "userStopped = 'turn-end-failed';", "userStopped = 'turn-ending';");
  await assert.rejects(failedEnd(broken.createDriverSafety), { code: 'ERR_ASSERTION' });
});
test('failed-end witness rejects dropping the native reason', async () => {
  const broken = await variant('driver-safety.mjs', "? error.reason : 'turn-end-failed'", "? 'turn-end-failed' : 'turn-end-failed'");
  await assert.rejects(failedEnd(broken.createDriverSafety), { code: 'ERR_ASSERTION' });
});
test('an old failed end cannot close a newer successfully ended turn', async () => {
  const safety = createDriverSafety({ platform: 'win32' }, { queue: { serial: Promise.resolve(), queued: 0 }, epoch: () => 0,
    fail: assert.fail, dispatch: () => true });
  let reject;
  const old = safety.endWindowsTurn(() => new Promise((_resolve, no) => { reject = no; }));
  const rejected = assert.rejects(old);
  await safety.endWindowsTurn(() => {});
  reject(Object.assign(Error('old'), { reason: 'hook-unhook-failed' })); await rejected;
  assert.equal(await safety.request('click', {}), true);
});
async function queuedFailure(factory = createDriverSafety) {
  let release;
  const queue = { serial: new Promise(resolve => { release = resolve; }), queued: 0 };
  const safety = factory({ platform: 'win32' }, { queue, epoch: () => 0, fail: assert.fail, dispatch: assert.fail,
    onError(error) { error.message = 'Escape'; } });
  const input = safety.request('typeText', {});
  await assert.rejects(safety.endWindowsTurn(() => Promise.reject(Object.assign(Error('fixture'), { reason: 'hook-unhook-failed' }))));
  release();
  await assert.rejects(input, error => { assert.match(error.message, /cleanup failed/); assert.match(error.message, /successful trusted turn end/); return true; });
}
test('queued input keeps failed-end guidance after error formatting', () => queuedFailure());
test('queued-input witness rejects formatting cleanup failure as Escape', async () => {
  const broken = await variant('driver-safety.mjs', 'error.message = windowsTurnEndFailure(endFailure);\n        if (sessionStopped', 'error.message = error.message;\n        if (sessionStopped');
  await assert.rejects(queuedFailure(broken.createDriverSafety), { code: 'ERR_ASSERTION' });
});
async function endTelemetry(factory = createWindowsSafety) {
  const result = { turn: 1, active: false, hookCallbacks: statsFor(100) };
  const safety = factory({ driver: { cancel() {}, endWindowsTurn: async () => result }, lease: { release() {}, close() {} } });
  assert.deepEqual(await safety.endTurn({ windowsTurnEnded: true }), result);
}
test('both safety layers return private turn telemetry', () => endTelemetry());
async function failedLeaseCleanup(factory = createWindowsSafety) {
  let fail = true;
  const safety = factory({ driver: { cancel() {}, endWindowsTurn: async () => ({ turn: 1, active: false }) },
    lease: { release() { if (fail) throw Error('lease cleanup'); }, close() {} } });
  await assert.rejects(safety.endTurn({ windowsTurnEnded: true }));
  await assert.rejects(safety.request('typeText', {}), { code: 'USER_STOPPED', reason: 'turn-end-failed', typed: 0 });
  fail = false; await safety.reset();
  await assert.rejects(safety.request('click', {}), { code: 'USER_STOPPED', reason: 'turn-end-failed' });
  await safety.endTurn({ windowsTurnEnded: false });
  assert.throws(() => safety.checkUserStop('click'), { reason: 'turn-end-failed' });
  await safety.endTurn({ windowsTurnEnded: true }); safety.checkUserStop('click');
}
test('failed lease cleanup retains the input fence after a successful native end', () => failedLeaseCleanup());
test('lease-cleanup witness rejects clearing the fence before both cleanups succeed', async () => {
  const broken = await variant('driver-safety.mjs',
    'return requests.endWindowsTurn(() => Promise.all([cleanup, driver.endWindowsTurn?.()]).then(([, result]) => result));',
    'return Promise.all([cleanup, requests.endWindowsTurn(() => driver.endWindowsTurn?.())]).then(([, result]) => result);');
  await assert.rejects(failedLeaseCleanup(broken.createWindowsSafety), { code: 'ERR_ASSERTION' });
});
for (const [name, before, after] of [
  ['inner drops result', 'return result;\n    },\n    checkUserStop', 'return undefined;\n    },\n    checkUserStop'],
  ['outer drops result', 'then(([, result]) => result)', 'then(() => undefined)'],
]) test('telemetry witness rejects broken safety: ' + name, async () => {
  const broken = await variant('driver-safety.mjs', before, after);
  await assert.rejects(endTelemetry(broken.createWindowsSafety), { code: 'ERR_ASSERTION' });
});
test('turn result separates own cost from the hook chain', async t => {
  const stats = statsFor(100), ownStats = { ...stats, scope: 'before-next-hook' };
  const h = peer(t, wrappedClient, { stats, ownStats });
  await h.client.request('typeText', { args: ['x'] });
  assert.deepEqual((await h.client.endWindowsTurn()).hookOwnCallbacks, ownStats);
});
for (const [name, change] of [
  ['wrong scope', s => { s.scope = 'through-next-hook'; }],
  ['mismatched count', s => { s.callbacks++; }],
  ['own cost exceeds chain', s => { s.samplesUs[0] = 100; }],
  ['own maximum exceeds chain', s => { s.maxUs = 101; }],
]) test('invalid own callback telemetry retires the peer: ' + name, async t => {
  const stats = statsFor(100), ownStats = { ...statsFor(100), scope: 'before-next-hook' }; change(ownStats);
  const h = peer(t, wrappedClient, { stats, ownStats }); await h.client.request('typeText', { args: ['x'] });
  await assert.rejects(h.client.endWindowsTurn(), { code: 'DRIVER_PROTOCOL' });
});
test('own-cost witness rejects accepting a maximum above the chain maximum', async t => {
  const broken = await variant('driver-client.mjs', 'value.result.hookOwnCallbacks.maxUs > value.result.hookCallbacks.maxUs ||', '');
  const stats = statsFor(100), ownStats = { ...statsFor(100), scope: 'before-next-hook', maxUs: 101 };
  const h = peer(t, broken.createWindowsDriverClient, { stats, ownStats }); await h.client.request('typeText', { args: ['x'] });
  await assert.rejects(async () => { await assert.rejects(h.client.endWindowsTurn(), { code: 'DRIVER_PROTOCOL' }); }, { code: 'ERR_ASSERTION' });
});


test('INT22L exhausted native unhook retires the peer and the next trusted turn starts fresh', async t => {
  const fatal = { ...refusal, reason: 'hook-unhook-exhausted' };
  const h = peer(t, wrappedClient, { endError: fatal });
  await h.client.request('typeText', { args: ['x'] });
  await assert.rejects(h.client.endWindowsTurn(), error => error.reason === fatal.reason && error.unhealthy);
  await h.client.ping();
  assert.equal(h.children.length, 2);
  await h.client.request('typeText', { args: ['x'] });
  assert.equal(h.frames.filter(frame => frame.method === 'turn-start').length, 2);
});
