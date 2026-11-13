import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { registerHooks } from 'node:module';
import { createWindowsDriverClient } from '../plugins/sleight/lib/windows-driver/client.mjs';
import { withoutTestSeams } from './fixtures/windows-review-seams.mjs';
import { CHECKPOINT_NAMES, validCheckpointTimings } from '../plugins/sleight/lib/windows-driver/checkpoint-timings.mjs';
import { COST_FIELDS, costSamples, measureGuestTrial } from '../bench/windows/uc3f-collect.mjs';

const lib = new URL('../plugins/sleight/lib/', import.meta.url);
const read = path => readFileSync(new URL(path, lib), 'utf8');
const native = path => read('direct-browser/native/win/' + path);
const sources = () => ({ driver: native('Driver.cs'), input: native('DriverInput.cs'),
  session: native('DriverInventory.cs'), hook: native('DriverHook.cs'), client: read('driver-client.mjs'),
  launch: read('windows-launch.mjs'), cua: read('repl/cua.mjs'), tools: read('repl/arguments.mjs') });
const mask = s => s.replace(/\/\/[^\n]*|\/\*[^]*?\*\/|"(?:\\.|[^"\\])*"/g, token => ' '.repeat(token.length));
function block(text, opening) {
  const code = mask(text); let depth = 1, end = opening + 1;
  for (; depth && end < code.length; end++) { if (code[end] === '{') depth++; if (code[end] === '}') depth--; }
  assert.equal(depth, 0); return { body: text.slice(opening + 1, end - 1), end };
}
function body(text, anchor) {
  const start = text.indexOf(anchor); assert.ok(start >= 0, anchor);
  return block(text, text.indexOf('{', start)).body;
}
const normalize = text => text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[^]*?\*\//g,
  token => token.startsWith('//') || token.startsWith('/*') ? '' : token).replace(/\s+/g, '');
function unwrap(text, name, kind) {
  const prefix = `var ${name} = DriverCheckpointTimings.Start(DriverCheckpointTimings.Kind.${kind});`;
  const start = text.indexOf(prefix); assert.ok(start >= 0, prefix);
  const tail = text.slice(start + prefix.length);
  assert.match(tail, /^\s*try\s*\{/);
  const opening = text.indexOf('{', start + prefix.length), inner = block(text, opening);
  const suffix = new RegExp(`^\\s*finally\\s*\\{\\s*${name}\\.Finish\\(\\);\\s*\\}`);
  assert.match(text.slice(inner.end), suffix);
  return text.slice(0, start) + inner.body + text.slice(inner.end).replace(suffix, '');
}
const baseline = JSON.parse(readFileSync(new URL('./fixtures/windows-checkpoint-baseline.json', import.meta.url), 'utf8')).bodies;
function safetyBodies(s) {
  s = { ...s, input: withoutTestSeams(s.input) };
  for (const [file, anchor, kind] of [
    ['input', 'internal static void Require(WindowRecord window)', 'PersonInput'],
    ['input', 'internal static void EnsureBudget()', 'BudgetCheck'],
    ['session', 'internal static string Sample()', 'SessionProbe'],
  ]) {
    let actual = unwrap(body(s[file], anchor), 'timing', kind);
    if (kind === 'SessionProbe') {
      for (const [name, part, check] of [['lockTiming', 'LockCheck', 'WTSFreeMemory(data)'],
        ['desktopTiming', 'DesktopCheck', 'CloseDesktop(desktop)']]) {
        assert.match(actual, new RegExp(`var ${name} = DriverCheckpointTimings.Start\\(DriverCheckpointTimings.Kind.${part}\\);`));
        actual = actual.replace(new RegExp(`var ${name} = DriverCheckpointTimings.Start\\(DriverCheckpointTimings.Kind.${part}\\);`), '');
        const finish = `finally { try { if (${name === 'lockTiming' ? 'data' : 'desktop'} != IntPtr.Zero) ${check}; } finally { ${name}.Finish(); } }`;
        assert.ok(actual.includes(finish), finish);
        actual = actual.replace(finish, `finally { if (${name === 'lockTiming' ? 'data' : 'desktop'} != IntPtr.Zero) ${check}; }`);
      }
    }
    assert.equal(normalize(actual), normalize(baseline[anchor]), anchor + ': original checks and order survive both flag values');
  }
}
function bufferPolicy(s) {
  const record = body(s.driver, 'internal void Record(DriverCheckpointTimings.Kind kind');
  assert.match(record, /if \(index == Capacity\)/);
  assert.match(record, /kinds\[index\] = \(int\)kind; ticks\[index\] = duration;\s*Volatile.Write\(ref published, index \+ 1\)/);
  assert.doesNotMatch(record, /\bnew\b|lock\s*\(|Json\.|WriteLine|Sleep/);
  assert.match(s.driver, /Checks = new DriverCheckpointBuffer\(65536\)/);
  assert.match(s.driver, /Lifecycle = new DriverCheckpointBuffer\(256\)/);
  assert.match(s.driver, /Stopwatch.GetTimestamp\(\) - Started/);
  assert.match(s.driver, /ticks\[i\] \* \(1000.0 \/ Stopwatch.Frequency\)/);
  assert.match(body(s.driver, 'internal void Finish()'), /try \{ if \(Buffer != null\) Buffer.Record\([^]*?\); \} catch \{ \}/);
  assert.match(s.driver, /var timings = job.Request.CheckpointTimings \?/);
  assert.match(s.driver, /if \(timings != null\) timings.Checks.Reset\(\)/);
  assert.match(s.driver, /if \(timingCursor != null\) timingCursor.Attach\(job.Result\)/);
  assert.match(s.driver, /finally \{\s*DriverCheckpointTimings.Current = null;/);
  assert.match(s.hook, /if \(turn.Timings == null\) turn.Timings = timings/);
  assert.match(s.driver, /if \(request.CheckpointTimings\) hooks.EnableTimings\(id\)/);
  assert.doesNotMatch(s.hook, /Timings\s*= new DriverCheckpointTimings\(\);[^]*?internal bool Escaped/);
}
function hookPolicy(s) {
  const remove = body(s.hook, 'bool Remove()'), run = body(s.hook, 'void Run()');
  assert.match(remove, /DriverCheckpointTimings.Start\([^]*?owner.Timings.Lifecycle,\s*DriverCheckpointTimings.Kind.HookRemove\)/);
  assert.match(remove, /try \{[^]*?UnhookWindowsHookEx\(removing\)[^]*?finally \{ timing.Finish\(\); \}/);
  assert.match(run, /DriverCheckpointTimings.Kind.HookInstall\);\s*IntPtr installed;\s*try \{ installed = SetWindowsHookEx\(13, callback, GetModuleHandle\(null\), 0\); \}\s*finally \{ timing.Finish\(\); \}/);
  assert.match(body(s.hook, 'IntPtr Keyboard('), /owner.Samples.Record\(Stopwatch.GetTimestamp\(\) - started\)/);
  assert.match(s.hook, /elapsedUs = ticks\[start\] \* \(1000000.0 \/ Stopwatch.Frequency\)/);
  assert.match(s.driver, /owner.OwnSamples.FirstSince\(callbacks, out elapsedUs\)/);
  assert.match(s.driver, /first\["hook-callback"\] = Json.Map\("elapsedUs", elapsedUs\)/);
}
function privateFlag(s) {
  assert.match(s.driver, /Json.Keys\(d, "protocol nonce id method params deadline", "checkpointTimings"\)/);
  assert.match(s.driver, /if \(!\(d\["checkpointTimings"\] is bool\) \|\| !\(bool\)d\["checkpointTimings"\]/);
  assert.match(s.client, /if \(!mac && Object.hasOwn\(params, 'checkpointTimings'\)\) throw fault\('INVALID_PARAMS'\)/);
  assert.match(s.client, /checkpointTimings = false/);
  assert.match(s.client, /!mac && checkpointTimings && !\['ping', 'cancel'\].includes\(method\) \? \{ checkpointTimings: true \} : \{\}/);
  for (const code of [s.launch, s.cua, s.tools]) assert.doesNotMatch(mask(code), /checkpointTimings/);
  // Check string keys too, since tool schemas commonly spell keys as strings.
  for (const code of [s.launch, s.cua, s.tools]) assert.doesNotMatch(code, /checkpointTimings/);
  assert.doesNotMatch(s.input + s.session, /if\s*\([^)]*(?:CheckpointTimings|Current|timing)[^)]*\)\s*(?:return|Driver|Ensure)/);
}
for (const [name, check] of Object.entries({ safetyBodies, bufferPolicy, hookPolicy, privateFlag }))
  test('checkpoint source contract: ' + name, () => check(sources()));

const variants = [
  ['person timer removed', safetyBodies, 'input', 'Kind.PersonInput', 'Kind.BudgetCheck'],
  ['budget timer removed', safetyBodies, 'input', 'Kind.BudgetCheck', 'Kind.PersonInput'],
  ['session timer removed', safetyBodies, 'session', 'Kind.SessionProbe', 'Kind.LockCheck'],
  ['lock timer removed', safetyBodies, 'session', 'Kind.LockCheck', 'Kind.SessionProbe'],
  ['desktop timer removed', safetyBodies, 'session', 'Kind.DesktopCheck', 'Kind.LockCheck'],
  ['person check skipped with timing off', safetyBodies, 'input', 'uint last = DriverInput.LastPersonInput();', 'if (DriverCheckpointTimings.Current == null) return; uint last = DriverInput.LastPersonInput();'],
  ['session check skipped with timing off', safetyBodies, 'session', 'uint bytes;', 'if (DriverCheckpointTimings.Current == null) return null; uint bytes;'],
  ['budget check skipped with timing off', safetyBodies, 'input', 'if (actionDeadline != 0', 'if (DriverCheckpointTimings.Current != null && actionDeadline != 0'],
  ['check order reversed', safetyBodies, 'input', 'DriverSession.Require();', 'DriverInput.EnsureBudget();'],
  ['person refusal outcome changed', safetyBodies, 'input', '"person-unknown"); }', '"person-active"); }'],
  ['lock check skipped with timing off', safetyBodies, 'session', 'if (WTSQuerySessionInformationW(', 'if (DriverCheckpointTimings.Current != null && WTSQuerySessionInformationW('],
  ['desktop check skipped with timing off', safetyBodies, 'session', 'desktop = OpenInputDesktop(0, false, 1);', 'desktop = DriverCheckpointTimings.Current == null ? IntPtr.Zero : OpenInputDesktop(0, false, 1);'],
  ['hook install timer removed', hookPolicy, 'hook', 'Kind.HookInstall', 'Kind.HookRemove'],
  ['hook removal timer removed', hookPolicy, 'hook', 'Kind.HookRemove', 'Kind.HookInstall'],
  ['callback timer removed', hookPolicy, 'hook', 'owner.Samples.Record(Stopwatch.GetTimestamp() - started)', 'owner.Samples.Record(0)'],
  ['callback sample relabeled', hookPolicy, 'driver', 'first["hook-callback"]', 'first["keyboard"]'],
  ['callback units changed', hookPolicy, 'hook', 'elapsedUs = ticks[start] * (1000000.0', 'elapsedUs = ticks[start] * (1000.0'],
  ['unbounded checkpoint buffer', bufferPolicy, 'driver', 'if (index == Capacity)', 'if (false)'],
  ['timing errors replace outcome', bufferPolicy, 'driver', 'Buffer.Record(Kind, Stopwatch.GetTimestamp() - Started); } catch { }', 'Buffer.Record(Kind, Stopwatch.GetTimestamp() - Started); } catch { throw; }'],
  ['timing enabled for normal requests', bufferPolicy, 'driver', 'var timings = job.Request.CheckpointTimings ?', 'var timings = true ?'],
  ['raw parameter can set flag', privateFlag, 'client', "if (!mac && Object.hasOwn(params, 'checkpointTimings')) throw fault('INVALID_PARAMS');", ''],
  ['tool schema exposes flag', privateFlag, 'tools', 'export ', 'const checkpointTimings = true; export '],
  ['product parent enables flag', privateFlag, 'launch', "createWindowsDriverClient({ platform: 'win32' })", "createWindowsDriverClient({ platform: 'win32', checkpointTimings: true })"],
];
for (const [name, check, file, before, after] of variants) test('checkpoint rejects broken source: ' + name, () => {
  const s = sources(); assert.ok(s[file].includes(before), 'mutation anchor: ' + before);
  s[file] = s[file].replace(before, after);
  assert.throws(() => check(s), { code: 'ERR_ASSERTION' });
});

function telemetry(samples = [['session-probe', 0.25]], hooks = [], callback) {
  const result = { checkpointTimings: {}, checkpointTimingSamples: {} };
  for (const [name, capacity, list] of [['checks', 65536, samples], ['hookLifecycle', 256, hooks]]) {
    result.checkpointTimingSamples[name] = { capacity, start: 0, sampled: list.length, omitted: 0,
      samples: list.map(([checkpoint, elapsedMs]) => ({ checkpoint, elapsedMs })) };
    for (const [checkpoint, elapsedMs] of list) result.checkpointTimings[checkpoint] ??= { elapsedMs };
  }
  if (callback !== undefined) result.checkpointTimings['hook-callback'] = { elapsedUs: callback };
  return result;
}
function callbackStats(samplesUs, scope) {
  const sorted = [...samplesUs].sort((a, b) => a - b);
  return { scope, callbacks: samplesUs.length, capacity: 8192, sampled: samplesUs.length, omitted: 0,
    samplesUs, saturated: false, p50Us: sorted[Math.ceil(sorted.length * 0.50) - 1] ?? null,
    p99Us: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null, maxUs: sorted.at(-1) ?? null };
}
function peer(t, { checkpointTimings = false, responseTimings, callbackSamples = [4.25], factory = createWindowsDriverClient } = {}) {
  const frames = [], children = [];
  const window = { windowId: '101', processStart: '3' };
  const client = factory({ platform: 'win32', checkpointTimings, prepare: async () => ({ status: 'ready', spawn({ nonce }) {
    const child = new EventEmitter(); children.push(child);
    child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; };
    child.stdin.on('data', bytes => {
      const r = JSON.parse(bytes); frames.push(r);
      let result = r.method === 'turn-start' ? { turn: r.params.turn, active: true } :
        r.method === 'turn-end' ? { turn: r.params.turn, active: false,
          hookCallbacks: callbackStats(callbackSamples.map(n => n + 2), 'through-next-hook'),
          hookOwnCallbacks: callbackStats(callbackSamples, 'before-next-hook') } :
          { window, text: 'Window: "Fixture", App: Fixture.\n0 standard window\n\t1 text field\n\t2 button Invoke, ID: InvokeButton', readId: 1 };
      if (!['ping', 'cancel', 'turn-start'].includes(r.method)) {
        const measured = responseTimings?.(r) ?? (r.checkpointTimings ? telemetry(
          r.method === 'turn-end' ? [] : [['session-probe', 0.125], ['lock-check', 0.075], ['desktop-check', 0.02], ['person-input', 0.031], ['budget-check', 0.001]],
          r.method === 'turn-end' ? [['hook-remove', 0.2]] : r.method === 'click' ? [['hook-install', 0.375]] : [],
          r.method === 'typeText' ? 4.25 : undefined) : {});
        result = { ...result, ...measured };
      }
      queueMicrotask(() => child.stdout.write(JSON.stringify({ protocol: r.protocol, nonce, id: r.id, ok: true, result }) + '\n'));
    });
    return child;
  } }) });
  t.after(() => client.close()); return { client, frames, children, window };
}
test('constructor alone enables timing on reads, actions and end, with one turn and unchanged params', async t => {
  const h = peer(t, { checkpointTimings: true });
  await h.client.ping(); const r = await h.client.getAXState('101', { processStart: '3' });
  assert.equal(r.checkpointTimings['session-probe'].elapsedMs, 0.125);
  const args = { ...h.window, readId: 1, args: [2] };
  assert.equal((await h.client.request('click', args)).checkpointTimings['hook-install'].elapsedMs, 0.375);
  assert.equal((await h.client.endWindowsTurn()).checkpointTimings['hook-remove'].elapsedMs, 0.2);
  assert.deepEqual(args, { ...h.window, readId: 1, args: [2] });
  assert.deepEqual(h.frames.map(r => r.method), ['ping', 'getAXState', 'turn-start', 'click', 'turn-end']);
  assert.equal(h.frames[0].checkpointTimings, undefined);
  assert.ok(h.frames.slice(1).every(r => r.checkpointTimings === true && !Object.hasOwn(r.params, 'checkpointTimings')));
});
test('disabled collection still sends every action, and per-call options cannot enable it', async t => {
  const h = peer(t);
  const r = await h.client.getAXState('101', { processStart: '3', checkpointTimings: true });
  assert.equal(r.checkpointTimings, undefined);
  await h.client.request('click', { ...h.window, readId: 1, args: [2] }, { checkpointTimings: true });
  await h.client.endWindowsTurn();
  assert.equal(h.frames.filter(r => r.method === 'click').length, 1);
  assert.ok(h.frames.every(r => !Object.hasOwn(r, 'checkpointTimings')));
  await assert.rejects(h.client.request('getState', { checkpointTimings: true }), { code: 'INVALID_PARAMS' });
  await assert.rejects(h.client.request('turn-start', { turn: 5, checkpointTimings: true }), { code: 'METHOD_NOT_FOUND' });
});
test('timing option rejects values other than booleans without preparing a child', () => {
  for (const checkpointTimings of [1, 'true', {}, null]) assert.throws(() => createWindowsDriverClient({ checkpointTimings }), { code: 'INVALID_PARAMS' });
});
function checkpointTrial(h, caseId, measure = measureGuestTrial) {
  return measure({ rowId: 'checkpoint-cost', caseId, trial: 0,
    fixtures: [{ target: 'wpf', ...h.window }], check: async () => {},
    request: async (client, method, target, params) => ({ method, reply: await (method === 'turn-end' ? client.endWindowsTurn() : client.request(method, { ...h.window, ...params })) }),
  }, { checkpointTimingProducer: true, client: async () => h.client });
}
for (const caseId of Object.keys(COST_FIELDS)) test('fake client reaches the pinned G3 intake: ' + caseId, async t => {
  const h = peer(t, { checkpointTimings: true });
  const result = await checkpointTrial(h, caseId);
  const expected = { 'session-probe': 0.125, 'lock-check': 0.075, 'desktop-check': 0.02,
    'person-input': 0.031, 'budget-check': 0.001, 'hook-install': 0.375, 'hook-remove': 0.2, 'hook-callback': 4.25 };
  assert.deepEqual(result.costSamples, [{ [caseId === 'hook-callback' ? 'elapsedUs' : 'elapsedMs']: expected[caseId] }]);
  assert.equal(result.unmeasured, undefined);
  assert.equal(h.frames.filter(r => r.method === 'turn-start').length, 1);
  assert.equal(h.frames.filter(r => r.method === 'turn-end').length, 1);

});
test('turn-end callback samples come from the native own-callback bank', async t => {
  const h = peer(t, { checkpointTimings: true });
  await h.client.request('typeText', { ...h.window, args: [1, 'q'] });
  const ended = await h.client.endWindowsTurn();
  assert.equal(ended.checkpointTimings['hook-callback'], undefined);
  assert.deepEqual(ended.hookOwnCallbacks.samplesUs, [4.25]);
});
test('G3 leaves an empty own-callback bank unmeasured despite an action callback timing', async t => {
  const h = peer(t, { checkpointTimings: true, callbackSamples: [] });
  const result = await checkpointTrial(h, 'hook-callback');
  assert.deepEqual(result.costSamples, []);
  assert.equal(result.unmeasured, 'CHECKPOINT_TIMING_UNAVAILABLE');
  assert.equal(result.driver.find(d => d.method === 'typeText').reply.checkpointTimings['hook-callback'].elapsedUs, 4.25);
});
test('deleting the own-callback intake fails the G3 measured-sample assertion', async t => {
  const url = new URL('../bench/windows/uc3f-collect.mjs', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const start = source.indexOf("    if (caseId === 'hook-callback') {");
  assert.ok(start >= 0);
  const intake = block(source, source.indexOf('{', start));
  url.search = '?int22o-without-own-callback';
  const hook = registerHooks({ load(specifier, context, next) {
    const loaded = next(specifier, context);
    return specifier === url.href ? { ...loaded, source: source.slice(0, start) + source.slice(intake.end) } : loaded;
  } });
  let mutant;
  try { mutant = await import(url.href); } finally { hook.deregister(); }
  const h = peer(t, { checkpointTimings: true });
  const result = await checkpointTrial(h, 'hook-callback', mutant.measureGuestTrial);
  assert.throws(() => assert.deepEqual(result.costSamples, [{ elapsedUs: 4.25 }]), assert.AssertionError);
  assert.equal(result.unmeasured, 'CHECKPOINT_TIMING_UNAVAILABLE');
});
test('Windows accepts a full 65536-object checkpoint bank below the native size cap', async t => {
  const measured = telemetry(Array.from({ length: 65536 }, () => ['budget-check', 0.001]));
  measured.checkpointTimingSamples.checks.omitted = 1;
  assert.ok(Buffer.byteLength(JSON.stringify(measured)) < 4 * 1024 * 1024);
  const h = peer(t, { checkpointTimings: true, responseTimings: () => measured });
  const result = await h.client.getState();
  assert.equal(result.checkpointTimingSamples.checks.samples.length, 65536);
  assert.equal(result.checkpointTimingSamples.checks.omitted, 1);
  await h.client.ping();
  assert.equal(h.children.length, 1);
});
test('G3 refuses to create a client until its private producer capability is enabled', async () => {
  const result = await measureGuestTrial({ rowId: 'checkpoint-cost', caseId: 'session-probe' }, { client: assert.fail });
  assert.deepEqual(result.costSamples, []); assert.equal(result.unmeasured, 'CHECKPOINT_TIMING_UNAVAILABLE');
});
test('action and turn-end replies pass actual hook lifecycle samples to G3 costSamples', async t => {
  const h = peer(t, { checkpointTimings: true });
  await h.client.getAXState('101', { processStart: '3' });
  const action = await h.client.request('click', { ...h.window, readId: 1, args: [2] });
  const end = await h.client.endWindowsTurn();
  assert.deepEqual(costSamples('hook-install', [action.checkpointTimings['hook-install']]), [{ elapsedMs: 0.375 }]);
  assert.deepEqual(costSamples('hook-remove', [end.checkpointTimings['hook-remove']]), [{ elapsedMs: 0.2 }]);
});
test('G3 field contract retains ms and us without conversion, substitutions or extra keys', () => {
  assert.deepEqual(costSamples('hook-install', [{ elapsedMs: 0.375 }]), [{ elapsedMs: 0.375 }]);
  assert.deepEqual(costSamples('hook-remove', [{ elapsedMs: 0.2 }]), [{ elapsedMs: 0.2 }]);
  for (const s of [[{ elapsedUs: 0.25 }], [{ elapsedMs: -1 }], [{ elapsedMs: null }], [{ elapsedMs: 1, extra: 0 }]])
    assert.throws(() => costSamples('session-probe', s), { code: 'CHECKPOINT_TIMING_INVALID' });
});
for (const [name, mutate] of [
  ['wrong units', r => { r.checkpointTimings['session-probe'] = { elapsedUs: 1 }; }],
  ['negative', r => { r.checkpointTimingSamples.checks.samples[0].elapsedMs = -1; }],
  ['summary not sampled', r => { r.checkpointTimings['session-probe'].elapsedMs++; }],
  ['missing samples', r => { delete r.checkpointTimingSamples; }],
  ['wrong capacity', r => { r.checkpointTimingSamples.checks.capacity++; }],
  ['count mismatch', r => { r.checkpointTimingSamples.checks.sampled++; }],
  ['early omission', r => { r.checkpointTimingSamples.checks.omitted++; }],
  ['invalid start', r => { r.checkpointTimingSamples.checks.start = -1; }],
  ['unexpected checkpoint', r => { r.checkpointTimings.keyboard = { beforeMs: 0, afterMs: 1 }; }],
  ['extra content', r => { r.checkpointTimingSamples.checks.samples[0].text = 'private'; }],
  ['wrong lane', r => { r.checkpointTimingSamples.checks.samples[0].checkpoint = 'hook-install'; }],
]) test('malformed checkpoint reply retires its fake peer: ' + name, async t => {
  const r = telemetry(); mutate(r); assert.equal(validCheckpointTimings(r), false);
  const h = peer(t, { checkpointTimings: true, responseTimings: () => r });
  await assert.rejects(h.client.getState(), { code: 'DRIVER_PROTOCOL' });
});
test('unsolicited telemetry is refused by the ordinary client', async t => {
  const h = peer(t, { responseTimings: () => telemetry() });
  await assert.rejects(h.client.getState(), { code: 'DRIVER_PROTOCOL' });
});
test('empty buffers keep missing measurements empty, and every repeated checkpoint is retained', () => {
  assert.equal(validCheckpointTimings(telemetry([])), true);
  const result = telemetry([['budget-check', 0.1], ['budget-check', 0.2]]);
  assert.equal(validCheckpointTimings(result), true);
  assert.equal(result.checkpointTimings['budget-check'].elapsedMs, 0.1);
  assert.equal(result.checkpointTimingSamples.checks.samples.length, 2);
  assert.equal(CHECKPOINT_NAMES.length, 8);
});


test('INT22L telemetry stays optional under output pressure and resets only the worker bank', () => {
  const s = sources();
  const attach = body(s.driver, 'internal void Attach(object result)');
  assert.match(attach, /Encoding.UTF8.GetByteCount\(Json.Codec.Serialize\(value\)\) > Json.OutputLimit \/ 2/);
  assert.match(attach, /value.Remove\("checkpointTimings"\); value.Remove\("checkpointTimingSamples"\)/);
  assert.match(s.driver, /if \(timings != null\) timings.Checks.Reset\(\);\s*DriverCheckpointTimings.Current = timings;/);
  assert.doesNotMatch(body(s.hook, 'IntPtr Keyboard('), /\bnew\b|Json\.|Checkpoint/);
});
test('INT22L timed inventory reads do not arm a hook or require a driving turn', async t => {
  const h = peer(t, { checkpointTimings: true });
  for (const method of ['getState', 'listApps', 'getApp']) await h.client.request(method, {});
  assert.deepEqual(h.frames.map(frame => frame.method), ['getState', 'listApps', 'getApp']);
});
function boundedUnhook(s) {
  assert.match(s.hook, /if \(!success\) removalFailures\+\+/);
  const begin = body(s.hook, 'internal void BeginTurn(');
  const exhausted = 'if (removalFailures >= 3) throw Unavailable("hook-unhook-exhausted");';
  assert.ok(begin.indexOf(exhausted) >= 0);
  const afterWait = begin.slice(begin.indexOf('removed.WaitOne(200)'));
  assert.ok(afterWait.indexOf(exhausted) >= 0 &&
    afterWait.indexOf(exhausted) < afterWait.indexOf('if (removalPending || removalFailure != null)'),
  'the third failed retry retires in the same BeginTurn call');
  assert.match(body(s.hook, 'internal object EndTurn('), /if \(removalFailures >= 3\) throw Unavailable\("hook-unhook-exhausted"\)/);
  assert.match(s.client, /if \(error.reason === 'hook-unhook-exhausted'\) error.unhealthy = true;\s*call.reject\(error\);\s*if \(error.unhealthy\) stop\(g, error\)/);
}
test('INT22L native unhook failures have three bounded rounds and retire the peer', () => boundedUnhook(sources()));
test('BeginTurn retirement audit catches a third failed round deferred until the next call', () => {
  const s = sources();
  const before = 'lock (gate) {\n            if (removalFailures >= 3) throw Unavailable("hook-unhook-exhausted");\n            if (removalPending';
  assert.ok(s.hook.includes(before));
  s.hook = s.hook.replace(before, 'lock (gate) {\n            if (removalPending');
  assert.throws(() => boundedUnhook(s), assert.AssertionError);
});
