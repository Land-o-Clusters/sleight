import test from 'node:test';
import assert from 'node:assert/strict';
import { native, topologySeam, observeSeams, row } from './fixtures/windows-review-seams.mjs';

function overflowContract(source) {
  const epoch = topologySeam(source);
  epoch.Track(101, 41, epoch.members(Array.from({ length: 4096 }, (_, i) => i + 1000)));
  epoch.Track(201, 42, epoch.members([]));
  const before = epoch.Sample(201), revoked = [];
  let healthy = true;
  try { epoch.Record(0x8000, 9000, 0, 0, 41, root => root === 101, root => revoked.push(root)); }
  catch { healthy = false; }
  assert.equal(healthy, true, 'the hook callback must not disable the shared observer');
  assert.deepEqual(revoked, [101]);
  assert.throws(() => epoch.Sample(101), { code: 'TARGET_UNAVAILABLE' });
  assert.throws(() => epoch.Track(101, 41, epoch.members([])), { code: 'TARGET_UNAVAILABLE' });
  assert.equal(epoch.Sample(201), before);
  const { observe, bindings } = observeSeams(source);
  for (const root of [101, 201]) {
    const observed = observe(root, () => true, handle => row({ Handle: handle }),
      handle => [String(epoch.Sample(handle)), 'tree'], () => {}, bindings);
    assert.equal(observed.Refused, root === 101 ? 'TARGET_UNAVAILABLE' : null);
    assert.equal(observed.BindingId === null, root === 101);
  }
  for (let i = 0; i < 100; i++) epoch.Record(0x8000, i + 10000, 0, 0, 41, root => root === 101, () => {});
  assert.equal(epoch.roots.get(101).Members.size, 0, 'failed root retains no growing member set');
  epoch.Record(0x8001, 101, 0, 0, 0, () => false, () => {});
  assert.equal(epoch.roots.has(101), false);
  epoch.Track(101, 41, epoch.members([]));
  assert.equal(typeof epoch.Sample(101), 'number');
}
test('late topology overflow refuses one root and leaves other observations available', () => overflowContract(native('DriverInventory.cs')));
for (const [name, before, after] of [
  ['callback throws globally', 'if (known.Members.Count > 4096) { known.Unavailable = true; known.Members = new HashSet<IntPtr>(); }',
    'if (known.Members.Count > 4096) { roots.Remove(root); throw new DriverFault("TARGET_UNAVAILABLE"); }'],
  ['failed root still samples', 'if (known.Unavailable) throw new DriverFault("TARGET_UNAVAILABLE");\n            return known.Value;', 'return known.Value;'],
  ['failed root can track again', 'if (known.Unavailable) throw new DriverFault("TARGET_UNAVAILABLE");\n                if (known.Pid', 'if (known.Pid'],
]) test('root overflow catches broken variant: ' + name, () => {
  const source = native('DriverInventory.cs'); assert.ok(source.includes(before));
  assert.throws(() => overflowContract(source.replace(before, after)), assert.AssertionError);
});

function foreignContract(source) {
  for (const kind of [0x8000, 0x8001, 0x8004, 0x800f]) {
    const epoch = topologySeam(source);
    epoch.Track(101, 41, epoch.members(kind === 0x8000 ? [] : [102]));
    epoch.Track(201, 42, epoch.members([]));
    const { observe, bindings } = observeSeams(source);
    const read = handle => observe(handle, () => true, h => row({ Handle: h }),
      h => ['root', String(epoch.Sample(h))], () => {}, bindings);
    const selected = read(101), other = read(201);
    const before = epoch.Sample(101), otherBefore = epoch.Sample(201);
    const revoked = [];
    epoch.Record(kind, 102, 0, 0, 99, (root, child) => root === 101 && child === 102 && kind !== 0x8001 && kind !== 0x800f,
      root => { revoked.push(root); bindings.Revoke(root); });
    assert.notEqual(epoch.Sample(101), before, 'foreign-process event ' + kind);
    assert.equal(epoch.Sample(201), otherBefore);
    assert.deepEqual(revoked, [101]);
    assert.equal(bindings.windows.has(101), false);
    assert.equal(bindings.windows.get(201).BindingId, other.BindingId);
    assert.notEqual(read(101).BindingId, selected.BindingId);
  }
}
test('foreign-process child lifecycle changes retire only their admitted root', () => foreignContract(native('DriverInventory.cs')));
test('foreign-child behavior catches a same-process-only broken variant', () => {
  const source = native('DriverInventory.cs');
  const before = 'if (!(retained || descendant(root, hwnd))) continue;';
  assert.ok(source.includes(before));
  assert.throws(() => foreignContract(source.replace(before,
    'if (!(pid == known.Pid && (retained || descendant(root, hwnd)) || pid == 0 && kind == 0x8001 && retained)) continue;')), assert.AssertionError);
});
