import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from 'node:vm';
import { native, method, topologySeam, lifetimeSeams } from './fixtures/windows-review-seams.mjs';

function advances(source) {
  const epoch = topologySeam(source), observed = [], revoked = [];
  epoch.Track(101, 41, epoch.members([102, 103]));
  const record = (kind, hwnd, objectId = 0, childId = 0) => epoch.Record(kind, hwnd, objectId, childId, 41,
    (root, child) => root === 101 && child === 104, root => revoked.push(root),
    (root, value, retained) => observed.push({ root, value, retained }));
  const first = epoch.Sample(101);
  record(0x8000, 104); record(0x8004, 103, -4); record(0x800f, 102); record(0x8001, 104);
  assert.equal(observed.length, 4); assert.deepEqual(revoked, [101, 101, 101, 101]);
  assert.deepEqual(observed.map(row => row.value), [first + 1, first + 2, first + 3, first + 4]);
  assert.deepEqual(observed.map(row => row.retained), [false, true, true, true]);
  for (const args of [[0x8000, 0], [0x8000, 999], [0x8000, 102, 1], [0x8000, 102, 0, 1],
    [0x8005, 102], [0x800b, 102], [0x800e, 102]]) record(...args);
  assert.equal(observed.length, 4); assert.equal(epoch.Sample(101), first + 4);
}
test('each topology advance is recorded once without widening the existing filter', () => advances(native('DriverInventory.cs')));
test('missing advance recording is rejected as a broken variant', () => {
  const source = native('DriverInventory.cs'), anchor = 'if (advance != null) advance(root, known.Value, retained);';
  assert.ok(source.includes(anchor));
  assert.throws(() => advances(source.replace(anchor, '')), assert.AssertionError);
});
test('a diagnostic exception cannot stop epoch advance or token revocation', () => {
  const epoch = topologySeam(), revoked = [];
  epoch.Track(101, 41, epoch.members([102])); const first = epoch.Sample(101);
  epoch.Record(0x8001, 102, 0, 0, 0, () => false, root => revoked.push(root), () => { throw Error('diagnostic'); });
  assert.deepEqual(revoked, [101]); assert.equal(epoch.Sample(101), first + 1);
});
function ring(source) {
  const scope = createContext({ entries: Array(64), next: 0, count: 0, total: 0, overflow: false });
  const record = method(source, 'internal void Record(Dictionary<string, object> value)', ['value'], scope);
  for (let i = 1; i <= 130; i++) {
    record({ epoch: i });
    assert.equal(scope.count, Math.min(i, 64)); assert.equal(scope.total, i);
    assert.equal(scope.overflow, i > 64); assert.equal(scope.next, i % 64);
    const rows = Array.from({ length: scope.count }, (_, index) => scope.entries[(scope.next - scope.count + index + 64) % 64].epoch);
    assert.deepEqual(rows, Array.from({ length: Math.min(i, 64) }, (_, index) => Math.max(1, i - 63) + index));
  }
}
test('the 64-entry ring preserves chronological order and flags every overflow', () => ring(native('DriverInventory.cs')));
test('a ring that silently overwrites history fails the broken variant', () => {
  const source = native('DriverInventory.cs'); assert.ok(source.includes('else overflow = true;'));
  assert.throws(() => ring(source.replace('else overflow = true;', '')), assert.AssertionError);
});
test('event relations retain destroyed path members and separate sibling churn', () => {
  const relation = method(native('DriverInventory.cs'), 'internal static string Relation(', ['root', 'focus', 'hwnd', 'ancestor', 'retained']);
  assert.equal(relation(101, 103, 101, true, true), 'equals-root');
  assert.equal(relation(101, 103, 103, true, true), 'equals-focus');
  assert.equal(relation(101, 103, 102, true, true), 'ancestor-of-focus');
  assert.equal(relation(101, 103, 104, false, true), 'other-member');
  assert.equal(relation(101, 103, 105, false, false), 'descendant-not-retained');
});
test('whole-tree Lifetime remains sensitive to every recorded epoch', () => {
  const { life, lifetime, members } = lifetimeSeams();
  const before = lifetime(101, () => life(), () => members([]), () => 1);
  const after = lifetime(101, () => life(), () => members([]), () => 2);
  assert.notDeepEqual(before, after);
});
