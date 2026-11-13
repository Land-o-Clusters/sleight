import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { native, lifetimeSeams, topologySeam, bindingsSeam, observeSeams, inputSeams, effectBoundary, row, DriverFault, reviewClient, setValueBoundary } from './fixtures/windows-review-seams.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';

const variants = [
  ['setvalue-person-before-observe', 'SetValue samples person after Observe', 'DriverInput.cs', 'Check(window, hwnd); DriverPerson.Require(window); MarkInput();', 'DriverPerson.Require(window); Check(window, hwnd); MarkInput();'],
  ['inventory-unapproved-write', 'Inventory observes unselected windows with read-only Win32 calls', 'DriverInventory.cs', 'var candidate = metadata(hwnd);', 'var candidate = metadata(hwnd); DriverInput.Post(candidate, hwnd, 0x102, 0, IntPtr.Zero);'],
  ['foreground-token', 'Foreground verification retains the native binding', 'driver-client.mjs', '...bindingId !== undefined ? { bindingId } : {}', ''],
  ['wrapper-action-token', 'Foreground verification retains the native binding', 'windows-driver/client.mjs', 'args[0] = boundWindow(bind(args[0]));', 'args[0] = bind(args[0]);'],
  ['thread-id', 'Lifetime catches thread reuse', 'DriverInventory.cs', 'Thread + ":" + ProcessBirth', '0 + ":" + ProcessBirth'],
  ['thread-birth', 'Lifetime catches thread reuse', 'DriverInventory.cs', 'ThreadBirth + ":" + ClassAtom', '0 + ":" + ClassAtom'],
  ['root-final-sample', 'Lifetime catches turnover during proof', 'DriverInventory.cs', 'sample(hwnd).Proof() != root || ', ''],
  ['epoch-final-sample', 'Lifetime catches topology during proof', 'DriverInventory.cs', ' || epoch() != before', ''],
  ['event-filter', 'Topology ignores unrelated desktop events', 'DriverInventory.cs', 'if (!(retained || descendant(root, hwnd))) continue;', ''],
  ['event-epoch', 'Topology child changes revoke identity', 'DriverInventory.cs', 'known.Value = ++next;', 'known.Value = known.Value;'],
  ['destroy-prune', 'Topology destroys prune over 4096 sessions', 'DriverInventory.cs', 'if (hwnd == root) roots.Remove(root);', ''],
  ['binding-prune', 'Binding caps prune and release', 'DriverInventory.cs', 'if (!exists(hwnd)) Revoke(hwnd);', 'if (false) Revoke(hwnd);'],
  ['binding-cap', 'Binding caps prune and release', 'DriverInventory.cs', 'windows.Count >= 4096', 'false'],
  ['topology-cap', 'Topology cap refuses with a fixed code', 'DriverInventory.cs', 'roots.Count >= 4096', 'false'],
  ['observe-lifetime', 'Observe exposes refused inventory', 'DriverInventory.cs', 'return ObserveBound(hwnd, lifetime, metadata, desktop, bindings);', 'return candidate;'],
  ['post-person-before-observe', 'Post person sample follows Observe', 'DriverInput.cs', 'return InputEffect(() => api.Identity(window, hwnd), () => {', 'if (!cleanup) api.Person(window);\n            return InputEffect(() => api.Identity(window, hwnd), () => {'],
  ['post-no-final-person', 'Post person sample follows Observe', 'DriverInput.cs', 'if (!cleanup) api.Person(window);', ''],
  ['post-person-cleanup', 'Post cleanup stays identity bound', 'DriverInput.cs', 'if (!cleanup) api.Person(window);', 'api.Person(window);'],
  ['effect-person-before-observe', 'EffectBoundary person follows provider calls', 'DriverActions.cs', 'observe();\n        person();', 'person();\n        observe();'],
];
const selected = variants.find(v => v[0] === process.env.SLEIGHT_REVIEW_VARIANT);
const source = file => {
  let result = file.endsWith('.cs') ? native(file) : readFileSync(new URL('../plugins/sleight/lib/' + file, import.meta.url), 'utf8');
  if (selected?.[2] === file) { assert.ok(result.includes(selected[3]), 'mutation anchor ' + selected[0]); result = result.replace(selected[3], selected[4]); }
  return result;
};
const inventory = () => source('DriverInventory.cs');

test('Lifetime catches thread reuse', () => {
  const { life, lifetime, members } = lifetimeSeams(inventory());
  const sample = patch => lifetime(101, () => life(patch), () => members([]), () => 1);
  const original = sample();
  for (const patch of [{ Thread: 52 }, { ThreadBirth: '134059077770000003' }]) assert.notDeepEqual(sample(patch), original);
});
test('Lifetime catches turnover during proof', () => {
  const { life, lifetime, members } = lifetimeSeams(inventory()); let count = 0;
  assert.throws(() => lifetime(101, () => life({ Thread: ++count > 1 ? 52 : 51 }), () => members([]), () => 1), { code: 'IDENTITY_CHANGED' });
});
test('Lifetime catches topology during proof', () => {
  const { life, lifetime, members } = lifetimeSeams(inventory()); let epoch = 0;
  assert.throws(() => lifetime(101, () => life(), () => members([]), () => ++epoch), { code: 'IDENTITY_CHANGED' });
});
test('Inventory observes unselected windows with read-only Win32 calls', () => {
  const src = inventory();
  assert.doesNotMatch(src, /SetPropW|RemovePropW|GetPropW/);
  const { life, lifetime, members } = lifetimeSeams(src);
  const calls = []; const { observe, bindings } = observeSeams(src, calls);
  for (const hwnd of [101, 201, 301]) {
    const found = observe(hwnd, () => true, h => { calls.push(['metadata', h]); return row({ Handle: h }); },
      h => lifetime(h, target => { calls.push(['read', target]); return life(); }, () => members([]), () => 1), () => {}, bindings);
    assert.equal(found.Refused, null); assert.equal(found.Handle, hwnd);
  }
  assert.ok(calls.length > 0); assert.deepEqual([...new Set(calls.map(([kind]) => kind))].sort(), ['metadata', 'read']);
  // Native entry points are wired to the read-only seam; writes do not exist in inventory.
  assert.match(src, /return Observe\(hwnd, IsWindow, handle => Observe\(handle, true\), Lifetime, ReadDesktop, Bindings\);/);
  assert.match(src, /OpenThread\(0x800, false, thread\)/); assert.match(src, /GetThreadTimes\(worker/);
});
test('Observe exposes refused inventory', () => {
  const { observe, bindings } = observeSeams(inventory()); let samples = 0;
  const found = observe(101, () => true, () => row(), () => {
    if (++samples === 1) throw new DriverFault('TARGET_UNAVAILABLE'); return ['1', 'tree'];
  }, () => {}, bindings);
  assert.equal(found.Refused, 'TARGET_UNAVAILABLE'); assert.equal(found.BindingId, null); assert.equal(bindings.windows.size, 0);
});
test('Topology ignores unrelated desktop events', () => {
  const e = topologySeam(inventory()); e.Track(101, 41, e.members([102])); const before = e.Sample(101);
  for (const kind of [0x8000, 0x8001, 0x8004, 0x800f]) for (const pid of [41, 42])
    e.Record(kind, 201, 0, 0, pid, () => false, () => assert.fail('unrelated revocation'));
  assert.equal(e.Sample(101), before);
});
test('Topology child changes revoke identity', () => {
  const e = topologySeam(inventory()); e.Track(101, 41, e.members([])); const before = e.Sample(101); const revoked = [];
  e.Record(0x8000, 102, -4, 0, 41, () => true, h => revoked.push(h));
  assert.notEqual(e.Sample(101), before); assert.deepEqual(revoked, [101]);
  e.Record(0x8001, 102, 0, 0, 0, () => false, h => revoked.push(h)); assert.deepEqual(revoked, [101, 101]);
});
test('Topology destroys prune over 4096 sessions', () => {
  const e = topologySeam(inventory());
  for (let i = 1; i <= 5000; i++) {
    e.Track(i, 41, e.members([])); e.Record(0x8001, i, 0, 0, 0, () => false, () => {}); assert.equal(e.roots.size, 0);
  }
  e.Track(101, 41, e.members([])); e.Prune(() => false); assert.equal(e.roots.size, 0);
  e.Track(101, 41, e.members([])); e.Clear(); assert.equal(e.roots.size, 0);
});
test('Topology cap refuses with a fixed code', () => {
  const e = topologySeam(inventory()); for (let i = 1; i <= 4096; i++) e.Track(i, 41, e.members([]));
  assert.throws(() => e.Track(4097, 41, e.members([])), { code: 'TARGET_UNAVAILABLE' });
});
test('Binding caps prune and release', () => {
  const e = bindingsSeam(inventory()); for (let i = 1; i <= 4096; i++) e.Remember(row({ Handle: i }));
  assert.throws(() => e.Remember(row({ Handle: 4097 })), { code: 'TARGET_UNAVAILABLE' });
  e.Prune(() => false); assert.equal(e.windows.size, 0); assert.equal(e.tokens.size, 0);
  for (let i = 1; i <= 5000; i++) { e.Remember(row({ Handle: i })); e.Revoke(i); }
  assert.equal(e.windows.size, 0); e.Remember(row()); e.Clear(); assert.equal(e.windows.size, 0); assert.equal(e.tokens.size, 0);
});
test('Post person sample follows Observe', () => {
  for (const message of [0x102, 0x201]) for (const validated of [false, true]) {
    const { post } = inputSeams(source('DriverInput.cs')); const order = []; let active = false;
    const api = { Identity() { order.push('observe'); active = true; },
      Person() { order.push('person'); if (active) throw new DriverFault('PERSON_TOOK_OVER'); },
      Send() { order.push('send'); return true; }, Point() { return { X: 2, Y: 2 }; }, Surface() { return { Left: 0, Top: 0, Right: 10, Bottom: 10 }; } };
    assert.throws(() => post({}, 101, message, 0, 0, false, validated, false, false, api), { code: 'PERSON_TOOK_OVER' });
    assert.equal(order[0], 'observe'); assert.equal(order.at(-1), 'person'); assert.ok(!order.includes('send'));
  }
});
test('Post cleanup stays identity bound', () => {
  const { post } = inputSeams(source('DriverInput.cs')); const calls = [];
  const api = { Identity(w, h) { calls.push(['identity', h]); }, Person() { assert.fail('cleanup person sample'); },
    Send(h) { calls.push(['send', h]); return true; } };
  post({}, 101, 0x101, 0, 0, true, true, false, false, api); assert.deepEqual(calls, [['identity', 101], ['send', 101]]);
  api.Identity = () => { throw new DriverFault('IDENTITY_CHANGED'); }; calls.length = 0;
  assert.throws(() => post({}, 201, 0x101, 0, 0, true, true, false, false, api), { code: 'IDENTITY_CHANGED' }); assert.deepEqual(calls, []);
});
test('EffectBoundary person follows provider calls', () => {
  const calls = []; let active = false;
  assert.throws(() => effectBoundary(source('DriverActions.cs'))(() => { calls.push('observe'); active = true; },
    () => { calls.push('person'); if (active) throw new DriverFault('PERSON_TOOK_OVER'); }, () => calls.push('mark')), { code: 'PERSON_TOOK_OVER' });
  assert.deepEqual(calls, ['observe', 'person']);
});
test('SetValue samples person after Observe', () => {
  const calls = [];
  assert.throws(() => setValueBoundary(source('DriverInput.cs'), calls)({}, 101, 'fixture'), { code: 'PERSON_TOOK_OVER' });
  assert.deepEqual(calls, ['observe', 'edit-style', 'observe', 'person', 'free']);
});
test('Post quota retry samples person again after the retry Observe', () => {
  const { post } = inputSeams(source('DriverInput.cs')); const calls = []; let count = 0;
  const api = { Identity() { calls.push('observe'); }, Person() { calls.push('person'); },
    Send() { calls.push('send'); return ++count === 2; }, Error() { return 1816; }, Pause() { calls.push('pause'); } };
  post({}, 101, 0x102, 0, 0, false, true, true, false, api);
  assert.deepEqual(calls, ['observe', 'person', 'send', 'pause', 'observe', 'observe', 'person', 'send']);
});
test('Foreground verification retains the native binding', async t => {
  const { client, calls, token } = await reviewClient(source); t.after(() => client.close());
  const read = await client.getApp('Fixture'); let effects = 0;
  const result = await client.drag({ windowId: read.window.windowId, processStart: read.window.processStart, readId: read.readId },
    [1, 2], { foreground: async request => { effects++; assert.equal(request.identity.bindingId, token); return { route: 'fake' }; } });
  assert.equal(result.route, 'foreground'); assert.equal(effects, 1);
  assert.equal(calls.find(c => c.method === 'verifyWindowIdentity').params.bindingId, token);
  assert.equal(Object.hasOwn(calls.find(c => c.method === 'drag').params, 'bindingId'), false);
});
test('CRLF native mutation anchors normalize before replacement', () => {
  for (const file of ['DriverInventory.cs', 'DriverInput.cs', 'DriverActions.cs']) {
    const crlf = native(file).replace(/\n/g, '\r\n').replace(/\r\n/g, '\n'); assert.equal(crlf, native(file));
  }
});
if (!selected) for (const variant of variants) test('broken variant exits 1: ' + variant[0], t => {
  const env = { ...process.env, SLEIGHT_REVIEW_VARIANT: variant[0] }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=900000', '--test-name-pattern=^' + variant[1] + '$', fileURLToPath(import.meta.url)],
    { env, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 1, result.stdout + result.stderr); assert.match(result.stdout, /# fail 1/); assert.doesNotMatch(result.stdout + result.stderr, /SyntaxError|ReferenceError|mutation anchor/);
  t.diagnostic(variant[0] + ': exit 1');
});
