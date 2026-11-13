import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from 'node:vm';
import { native, body, method, topologySeam, bindingsSeam, row, DriverFault } from './fixtures/windows-review-seams.mjs';

// Preserve lock scopes as observable critical sections in the source adapter.
// This checks placement of native walks and callbacks, not OS scheduling.
function observeLocks(source) {
  const match = /lock \((sync|diagnosticSync)\)\s*/.exec(source);
  if (!match) return source;
  const start = match.index + match[0].length;
  let end;
  if (source[start] === '{') {
    let depth = 1; end = start + 1;
    for (; depth; end++) { if (source[end] === '{') depth++; if (source[end] === '}') depth--; }
  } else end = source.indexOf(';', start) + 1;
  const name = match[1] === 'sync' ? 'epoch' : 'diagnostic';
  return source.slice(0, match.index) + `{ enter('${name}'); try { ` + observeLocks(source.slice(start, end)) +
    ` } finally { leave('${name}'); } }` + observeLocks(source.slice(end));
}

// Execute production bodies. Only scalar declarations, locks and Win32 calls
// are adapted; all decisions and diagnostic state changes remain in the source.
function topology(source = native('DriverInventory.cs'), enabled = true) {
  const held = { epoch: 0, diagnostic: 0 };
  const epoch = topologySeam(source), Dictionary = epoch.roots.constructor;
  Dictionary.prototype.ContainsKey = function (key) { return this.has(key); };
  const HashSet = epoch.members([]).constructor;
  class Ring {
    static get Enabled() { return enabled; }
    constructor(incarnation = null) {
      this.Incarnation = incarnation;
      const scope = createContext({ entries: Array(64), next: 0, count: 0, total: 0, overflow: false,
        Focus: 0, Path: new HashSet(), HashSet, IntPtr: { Zero: 0 }, WindowRecord: { Id: String },
        Json: { Map: (...pairs) => Object.fromEntries(Array.from({ length: pairs.length / 2 }, (_, i) => pairs.slice(i * 2, i * 2 + 2))) } });
      for (const [name, signature, args] of [
        ['Record', 'internal void Record(Dictionary<string, object> value)', ['value']],
        ['Relation', 'internal static string Relation(', ['root', 'focus', 'hwnd', 'ancestor', 'retained']],
        ['RememberFocus', 'internal void RememberFocus(', ['focus', 'path']],
        ['Advance', 'internal void Advance(', ['root', 'epoch', 'kind', 'hwnd', 'objectId', 'childId', 'pid', 'thread', 'className', 'retained']],
      ]) this[name] = scope[name] = method(source, signature, args, scope);
      this.state = scope;
    }
  }
  const diagnostics = new Dictionary();
  const bindings = bindingsSeam(source);
  const scope = createContext({ epoch, diagnostics, DriverLifecycleRing: Ring, IsWindow: () => true,
    enter: name => { if (name === 'diagnostic') assert.equal(held.epoch, 0, 'no diagnostic lock under epoch.sync'); held[name]++; },
    leave: name => { held[name]--; },
    Object: { ReferenceEquals: (a, b) => a === b },
    Tuple: { Create: (Item1, Item2, Item3) => ({ Item1, Item2, Item3 }) },
    StringBuilder: class { Capacity = 256; ToString() { return 'SyntheticClass'; } },
    GetClassNameW: () => { assert.equal(held.epoch, 0); return 1; },
    DriverInventory: { Bindings: bindings }, injectedPid: 41,
    GetWindowThreadProcessId: () => 51, IsChild: () => scope.descendant,
    IntPtr: { Zero: 0 }, HashSet, GetParent: hwnd => {
      assert.equal(held.diagnostic, 0, 'native parent walks must run outside diagnosticSync');
      return ({ 103: 102, 102: 101, 104: 101 })[hwnd] ?? 0;
    } });
  const region = source.slice(source.indexOf('internal sealed class DriverTopology :'), source.indexOf('internal static class DriverInventory'))
    .replaceAll('DriverLifecycleRing ring;', 'var ring = null;').replaceAll('DriverLifecycleRing latest;', 'var latest = null;')
    .replaceAll('diagnostics[root]', 'diagnostics.get(root)')
    .replaceAll('List<Tuple<IntPtr, long, bool>> pending', 'var pending')
    .replaceAll('new List<Tuple<IntPtr, long, bool>>()', '[]').replaceAll('pending.Add(', 'pending.push(')
    .replaceAll('(Action<IntPtr, long, bool>)', '')
    .replaceAll('uint pid; GetWindowThreadProcessId(hwnd, out pid);', 'var pid = injectedPid; GetWindowThreadProcessId(hwnd);');
  for (const [name, args] of [['Track', ['root', 'pid', 'members', 'life = null']], ['Focus', ['root', 'focus']],
    ['OnEvent', ['hook', 'kind', 'hwnd', 'objectId', 'childId', 'thread', 'time']]])
    scope[name] = method(observeLocks(region), (name === 'OnEvent' ? 'void ' : 'internal void ') + name + '(', args, scope);
  // The real epoch body invokes the real OnEvent lambda; only expose its lock
  // boundary to the callback to ensure it queues scalars without diagnostics.
  const record = epoch.Record;
  epoch.Record = (...args) => { held.epoch++; try { return record(...args); } finally { held.epoch--; } };
  return { epoch, diagnostics, scope, bindings, held, track: scope.Track, focus: scope.Focus,
    event: (kind, hwnd, objectId = 0, childId = 0) => scope.OnEvent(0, kind, hwnd, objectId, childId, 51, 0) };
}

function input(inputSource = native('DriverInput.cs'), inventory = native('DriverInventory.cs'), enabled = true) {
  const topo = topology(inventory, enabled);
  topo.track(101, 41, topo.epoch.members([102, 103, 104]));
  const focusScope = createContext({ lifecycleFocused: false, DriverLifecycleRing: { Enabled: enabled }, topology: { Focus: topo.focus } });
  const lifecycleFocus = method(inventory, 'internal static void LifecycleFocus(', ['window', 'focus'], focusScope);
  let identityChecks = 0;
  const scope = createContext({ DriverFault, observed: row({ InputRoot: 101 }), injectedPid: 41, focus: 103,
    DriverOperationCounters: { Current: enabled ? { IdentityCheck() { identityChecks++; } } : null },
    System: { Diagnostics: { Stopwatch: { GetTimestamp: () => 1 } } }, IntPtr: { Zero: 0 },
    Marshal: { SizeOf: () => 1 }, IsChild: (root, child) => root === 101 && [102, 103, 104].includes(child),
    GetWindowThreadProcessId: () => 51, GetGUIThreadInfo: () => true,
    DriverInventory: { LifecycleFocus: lifecycleFocus, Observe: () => scope.observed } });
  const adapted = inputSource.replaceAll('uint pid; uint thread =', 'var pid = injectedPid; var thread =')
    .replaceAll(', out pid)', ')').replaceAll('ref info', 'info')
    .replace('new GuiInfo { Size = (uint)Marshal.SizeOf(typeof(GuiInfo)) }', '{ Focus: focus }');
  scope.RequireOwned = method(adapted, 'internal static void RequireOwned(', ['window', 'hwnd', 'pid', 'child'], scope);
  const checked = method(adapted, 'internal static void Check(WindowRecord window, IntPtr hwnd, uint pid,', ['window', 'hwnd', 'pid', 'child', 'observe'], scope);
  const wrapper = method(adapted, 'internal static void Check(WindowRecord window, IntPtr hwnd)', ['window', 'hwnd'], scope);
  scope.Check = (...args) => args.length === 2 ? wrapper(...args) : checked(...args);
  return { ...topo, scope, focusScope, check: wrapper,
    identityChecks: () => identityChecks,
    focusInput: method(adapted, 'internal static IntPtr Focus(', ['window'], scope),
    window: row({ InputRoot: 101 }) };
}

function focusContract(inputSource = native('DriverInput.cs')) {
  const env = input(inputSource);
  env.check(env.window, 104); // A UIA target's nearest HWND is not the focus.
  assert.equal(env.diagnostics.get(101).state.Focus, 0);
  assert.equal(env.focusInput(env.window), 103);
  const ring = env.diagnostics.get(101);
  assert.equal(ring.state.Focus, 103);
  assert.deepEqual([...ring.state.Path].sort(), [101, 102, 103]);
  ring.Advance(101, 2, 0x8004, 102, 0, 0, 41, 51, 'SyntheticClass', true);
  assert.equal(ring.state.entries[0].focusRelation, 'ancestor-of-focus');
  assert.equal(ring.state.entries[0].focusHwnd, '103');
  const failed = input(inputSource);
  failed.scope.observed = null;
  assert.throws(() => failed.focusInput(failed.window), { code: 'IDENTITY_CHANGED' });
  assert.equal(failed.diagnostics.get(101).state.Focus, 0, 'unproved focus is never recorded');
  const brokenDiagnostic = input(inputSource);
  brokenDiagnostic.focusScope.topology.Focus = () => { throw Error('diagnostic'); };
  assert.equal(brokenDiagnostic.focusInput(brokenDiagnostic.window), 103);
  const disabled = input(inputSource, native('DriverInventory.cs'), false);
  assert.equal(disabled.focusInput(disabled.window), 103); assert.equal(disabled.diagnostics.size, 0);
}
test('only proved native focus supplies the lifecycle focus label after arbitrary target checks', () => focusContract());

function reuseContract(source = native('DriverInventory.cs')) {
  const env = topology(source), { epoch } = env;
  const life = { Proof: () => '41:51:birth1:thread1:class:0:0' };
  env.track(101, 41, epoch.members([102, 103]), life);
  const old = env.diagnostics.get(101);
  env.focus(101, 103);
  for (let i = 0; i < 65; i++) old.Record({ epoch: i });
  env.track(101, 41, epoch.members([104]), life);
  assert.equal(env.diagnostics.get(101), old, 'same incarnation retains its ring');
  const before = epoch.Sample(101);
  const nextLife = { Proof: () => '41:51:birth2:thread2:class:0:0' };
  env.track(101, 41, epoch.members([102]), nextLife);
  const reused = env.diagnostics.get(101);
  assert.notEqual(reused, old, 'same PID with changed birth resets before DESTROY is processed');
  assert.equal(epoch.Sample(101), before, 'diagnostic identity must not change the guard epoch');
  assert.equal(reused.state.total, 0); assert.equal(reused.state.Focus, 0); assert.equal(reused.state.Path.size, 0);
  reused.Record({ epoch: 1 }); env.focus(101, 103);
  epoch.Record(0x8001, 101, 0, 0, 0, () => false, () => {});
  env.track(101, 41, epoch.members([102]), nextLife);
  const fresh = env.diagnostics.get(101);
  assert.notEqual(fresh, reused, 'processed root destruction gets a new diagnostic ring');
  assert.equal(fresh.state.total, 0); assert.equal(fresh.state.count, 0);
  assert.equal(fresh.state.overflow, false); assert.equal(fresh.state.Focus, 0);
  assert.equal(fresh.state.Path.size, 0);
  env.diagnostics.Add = () => { throw Error('diagnostic allocation'); };
  assert.doesNotThrow(() => env.track(201, 41, epoch.members([])));
  assert.ok(epoch.Sample(201) > 0, 'diagnostic failures leave root tracking available');
}
test('HWND reuse resets before delayed DESTROY when birth evidence changes, and after processed DESTROY', () => reuseContract());

function revokeContract(source = native('DriverInventory.cs')) {
  const epoch = topologySeam(source), bindings = bindingsSeam(source);
  epoch.Track(101, 41, epoch.members([102]));
  const before = epoch.Sample(101), admitted = bindings.Remember(row());
  let atDiagnostic;
  epoch.Record(0x8004, 102, 0, 0, 41, () => false, bindings.Revoke, () => {
    try { bindings.Resolve(admitted.BindingId, 101, admitted.ProcessStart, () => admitted); atDiagnostic = 'allowed'; }
    catch (error) { atDiagnostic = error.code; }
    throw Error('recording failed');
  });
  assert.equal(atDiagnostic, 'IDENTITY_CHANGED', 'token is retired before diagnostic work or lock contention');
  assert.equal(epoch.Sample(101), before + 1);
}
test('revocation precedes optional recording and survives a diagnostic exception', () => revokeContract());

function parityContract(inputSource = native('DriverInput.cs'), inventory = native('DriverInventory.cs')) {
  const rows = [
    { name: 'owned child', hwnd: 103, want: 'allowed' },
    { name: 'root', hwnd: 101, want: 'allowed' },
    { name: 'foreign child', hwnd: 999, want: 'IDENTITY_CHANGED' },
    { name: 'wrong pid', hwnd: 103, pid: 42, want: 'IDENTITY_CHANGED' },
    { name: 'no observation', hwnd: 103, patch: null, want: 'IDENTITY_CHANGED' },
    { name: 'changed topology', hwnd: 103, patch: { TopologyGeneration: '2:tree' }, want: 'IDENTITY_CHANGED' },
    { name: 'changed birth', hwnd: 103, patch: { ProcessStart: 'new' }, want: 'IDENTITY_CHANGED' },
    { name: 'policy refusal', hwnd: 103, patch: { Refused: 'ELEVATED_TARGET' }, want: 'ELEVATED_TARGET' },
  ];
  const decisions = [];
  for (const enabled of [false, true]) {
    const observed = [];
    for (const fixture of rows) {
      const env = input(inputSource, inventory, enabled);
      env.scope.injectedPid = fixture.pid ?? 41;
      env.scope.observed = fixture.patch === null ? null : row({ InputRoot: 101, ...fixture.patch });
      let result = 'allowed';
      try { env.check(env.window, fixture.hwnd); } catch (error) { result = error.code; }
      assert.equal(result, fixture.want, fixture.name + ', counters=' + enabled);
      assert.equal(env.identityChecks(), enabled ? 1 : 0, 'production wrapper accounts for success and refusal');
      observed.push(result);
    }
    decisions.push(observed);
  }
  assert.deepEqual(decisions[0], decisions[1]);
  const lifecycleDecisions = [];
  for (const enabled of [false, true]) {
    const observed = [];
    for (const [kind, hwnd, descendant, want] of [
      [0x8000, 104, true, 'IDENTITY_CHANGED'], [0x8001, 102, false, 'IDENTITY_CHANGED'],
      [0x8004, 102, false, 'IDENTITY_CHANGED'], [0x800f, 102, false, 'IDENTITY_CHANGED'],
      [0x8004, 999, false, 'allowed'], [0x800b, 102, false, 'allowed'], [0x8005, 102, false, 'allowed'],
    ]) {
      const env = topology(inventory, enabled), { bindings } = env;
      env.track(101, 41, env.epoch.members([102, 103]));
      const admitted = bindings.Remember(row());
      env.scope.descendant = descendant;
      env.event(kind, hwnd);
      let result = 'allowed';
      try { bindings.Resolve(admitted.BindingId, 101, admitted.ProcessStart, () => admitted); }
      catch (error) { result = error.code; }
      assert.equal(result, want, 'lifecycle ' + kind + ', counters=' + enabled);
      assert.equal(env.diagnostics.size, enabled ? 1 : 0);
      if (enabled) assert.equal(env.diagnostics.get(101).state.total, want === 'allowed' ? 0 : 1);
      assert.notEqual(env.scope.healthy, false, 'production OnEvent survives diagnostics');
      observed.push(result);
    }
    lifecycleDecisions.push(observed);
  }
  assert.deepEqual(lifecycleDecisions[0], lifecycleDecisions[1]);
}
test('eight input and seven lifecycle guard decisions match with driver counters disabled and enabled', () => parityContract());

test('Track preserves admission with counters on, off and diagnostic allocation failure', () => {
  const decisions = [];
  for (const enabled of [false, true]) {
    const env = topology(native('DriverInventory.cs'), enabled), results = [];
    env.diagnostics.Add = () => { throw Error('diagnostic allocation'); };
    for (const pid of [41, 41, 42]) {
      let result = 'allowed';
      try { env.track(101, pid, env.epoch.members([102])); } catch (error) { result = error.code; }
      results.push(result);
    }
    assert.deepEqual(results, ['allowed', 'allowed', 'IDENTITY_CHANGED']);
    assert.equal(env.epoch.Sample(101), 1);
    decisions.push(results);
  }
  assert.deepEqual(decisions[0], decisions[1]);
});

test('Focus cannot publish an old path into a ring replaced during the parent walk', () => {
  const env = topology(), life = { Proof: () => 'new' };
  env.track(101, 41, env.epoch.members([102, 103]));
  const previous = env.diagnostics.get(101), parent = env.scope.GetParent;
  env.scope.GetParent = hwnd => { env.track(101, 41, env.epoch.members([102, 103]), life); return parent(hwnd); };
  env.focus(101, 103);
  assert.equal(env.diagnostics.get(101).state.Focus, 0);
  assert.equal(previous.state.Focus, 0);
});

test('Focus bounds a parent walk at 4096 and leaves unknown ancestry unlabelled', () => {
  const env = topology();
  env.track(101, 41, env.epoch.members([]));
  let calls = 0;
  env.scope.GetParent = hwnd => { assert.equal(env.held.diagnostic, 0); calls++; return hwnd + 1; };
  env.focus(101, 1000);
  assert.equal(calls, 4096);
  assert.equal(env.diagnostics.get(101).state.Focus, 0);
  assert.equal(env.diagnostics.get(101).state.Path.size, 0);
});

test('request reset collects no new focus label and a retained ring can carry historical focus', () => {
  const env = input();
  env.check(env.window, 104);
  assert.equal(env.diagnostics.get(101).state.Focus, 0, 'a Check-only request keeps unknown');
  env.focusInput(env.window);
  method(native('DriverInventory.cs'), 'internal static void BeginLifecycleRequest()', [], env.focusScope)();
  assert.equal(env.focusScope.lifecycleFocused, false);
  env.check(env.window, 104);
  assert.equal(env.diagnostics.get(101).state.Focus, 103, 'this is historical focus, not focus collected by Check');
});

// Each regression also rejects the corresponding reintroduced defect.
test('broken variant: arbitrary Check captures focus', () => {
  const source = native('DriverInput.cs');
  const changed = source.replace('try {\n            uint pid;', 'try {\n            DriverInventory.LifecycleFocus(window, hwnd);\n            uint pid;');
  assert.notEqual(changed, source);
  assert.throws(() => focusContract(changed), assert.AssertionError);
});
test('broken variant: a reused HWND keeps its previous ring', () => {
  const source = native('DriverInventory.cs');
  const changed = source.replace('fresh || !diagnostics.ContainsKey(root)', '!diagnostics.ContainsKey(root)');
  assert.notEqual(changed, source);
  assert.throws(() => reuseContract(changed), assert.AssertionError);
});
test('broken variant: birth evidence is ignored until epoch observes DESTROY', () => {
  const source = native('DriverInventory.cs');
  const changed = source.replace(' || diagnostics[root].Incarnation != incarnation', '');
  assert.notEqual(changed, source);
  assert.throws(() => reuseContract(changed), assert.AssertionError);
});
test('broken variant: Focus records before the native identity Check', () => {
  const source = native('DriverInput.cs');
  const changed = source.replace('Check(window, info.Focus);\n        DriverInventory.LifecycleFocus(window, info.Focus);',
    'DriverInventory.LifecycleFocus(window, info.Focus);\n        Check(window, info.Focus);');
  assert.notEqual(changed, source);
  assert.throws(() => focusContract(changed), assert.AssertionError);
});
test('broken variant: diagnostic Track exceptions escape into admission', () => {
  const source = native('DriverInventory.cs');
  const track = body(source, 'internal void Track(');
  const changed = source.replace(track, track.replace('} catch { }', '} catch { throw; }'));
  assert.notEqual(changed, source);
  assert.throws(() => reuseContract(changed), /diagnostic allocation/);
});
test('broken variant: native parent walk holds diagnosticSync', () => {
  const source = native('DriverInventory.cs');
  const changed = source.replace('current = GetParent(current);', 'lock (diagnosticSync) { current = GetParent(current); }');
  assert.notEqual(changed, source);
  assert.throws(() => reuseContract(changed), assert.AssertionError);
});
test('broken variant: OnEvent records directly under the epoch lock', () => {
  const source = native('DriverInventory.cs');
  const changed = source.replace('pending.Add(Tuple.Create(root, value, retained));',
    'lock (diagnosticSync) { diagnostics[root].Advance(root, value, kind, hwnd, objectId, childId, pid, thread, null, retained); }');
  assert.notEqual(changed, source);
  assert.throws(() => parityContract(native('DriverInput.cs'), changed), assert.AssertionError);
});
test('broken variant: diagnostics run before revocation', () => {
  const source = native('DriverInventory.cs');
  const record = 'try { if (advance != null) advance(root, known.Value, retained); } catch { }';
  const changed = source.replace(record, '').replace('revoke(root);', record + '\n            revoke(root);');
  assert.notEqual(changed, source);
  assert.throws(() => revokeContract(changed), assert.AssertionError);
});
test('broken variant: counters bypass the identity guard', () => {
  const source = native('DriverInput.cs');
  const changed = source.replace('RequireOwned(window, hwnd, pid,', 'if (DriverOperationCounters.Current != null) return;\n        RequireOwned(window, hwnd, pid,');
  assert.notEqual(changed, source);
  assert.throws(() => parityContract(changed), assert.AssertionError);
});
test('broken variant: the production wrapper stops reading counters', () => {
  const source = native('DriverInput.cs');
  const changed = source.replace('var counters = DriverOperationCounters.Current;', 'var counters = null;');
  assert.notEqual(changed, source);
  assert.throws(() => parityContract(changed), assert.AssertionError);
});
