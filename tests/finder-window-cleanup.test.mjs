import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function fixture() {
  const source = { ObjC: { import() {} } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), source);
  const request = { bundle: 'com.apple.finder', mode: 'folder', target: '/scratch/sleight-bench/run/Files-12345678',
    fixtureRoot: '/scratch/sleight-bench', token: 'Files-12345678' };
  const windows = [
    { title: 'Files-12345678', document: 'file:///scratch/sleight-bench/run/Files-12345678' },
    { title: 'Created', document: 'file:///scratch/sleight-bench/run/Files-12345678/Created' },
    { title: 'sleight-bench', document: 'file:///scratch/sleight-bench' },
    { title: 'Files-12345678', document: '' },
    { title: 'sleight-bench', document: 'file:///owner/sleight-bench' },
    { title: 'sleight-bench', document: '' },
    { title: 'Files-12345678', document: 'file:///scratch/sleight-bench-other/Files-12345678' },
    { title: 'Files-12345678', document: 'file:///scratch/sleight-bench/run/Files-12345678' },
    { title: 'sleight-bench', document: 'file:///scratch/sleight-bench' },
    { title: 'Files-12345678', document: '' },
  ];
  for (const window of windows) window.role = 'AXWindow';
  request.finderOwnership = { schema: 'finder-role-baseline-v1',
    baseline: windows.slice(4).map(reference => ({ reference, role: 'AXWindow' })), created: windows.slice(0, 4) };
  const closed = [], app = {};
  const api = {
    windows: () => windows.filter(w => !w.closed), equal: (a, b) => a === b,
    finderRole: w => w.role,
    text: (w, attr) => attr === 'AXDocument' ? w.document : attr === 'AXURL' ? w.url || '' : w.title,
    path: value => { try { return value.startsWith('file:') ? decodeURIComponent(new URL(value).pathname) : value.startsWith('/') ? value : null; } catch { return null; } },
    dialog: () => [], wait() {},
    closeButton(w, validate) { validate(); closed.push(w); w.closed = true; },
  };
  return { source, request, windows, closed, app, api,
    close() { return source.closeOwnedWindow(windows[0], request, app, api); } };
}

test('Finder cleanup closes windows with creation receipts and preserves baseline windows at matching fixture paths', () => {
  const f = fixture();
  assert.equal(typeof f.source.closeFinderFixtureWindows, 'function', 'Finder enumeration cleanup is missing');
  f.close();
  assert.deepEqual(f.closed, f.windows.slice(0, 4));
  assert.deepEqual(f.api.windows(), f.request.finderOwnership.baseline.map(entry => entry.reference));
});

test('Finder cleanup presses only owned AXCloseButtons and preserves a baseline scroll area through the native adapter', () => {
  const f = fixture(), presses = [];
  f.windows[4].role = 'AXScrollArea';
  f.request.finderOwnership.baseline[0].role = 'AXScrollArea';
  f.source.ObjC.unwrap = value => value;
  f.source.ObjC.castRefToObject = value => value;
  f.source.Ref = () => [];
  const native = value => value;
  native.CFEqual = (a, b) => a === b;
  native.AXUIElementCopyAttributeValue = (element, attribute, output) => {
    const value = element[attribute] ?? null;
    output[0] = Array.isArray(value) ? { count: value.length, objectAtIndex: i => value[i] } : value;
    return 0;
  };
  native.AXUIElementPerformAction = (button, action) => {
    assert.equal(action, 'AXPress');
    presses.push(button);
    f.app.AXWindows = f.app.AXWindows.filter(w => w.AXCloseButton !== button);
    return 0;
  };
  native.NSThread = { sleepForTimeInterval() {} };
  native.NSURL = {
    fileURLWithPath: path => ({ absoluteString: `file://${path}` }),
    URLWithString: value => ({ isNil: () => false, isFileURL: value.startsWith('file:'),
      URLByResolvingSymlinksInPath: { path: decodeURIComponent(new URL(value).pathname) } }),
  };
  f.source.$ = native;
  for (const w of f.windows) Object.assign(w, { AXRole: w.role, AXDocument: w.document, AXTitle: w.title, AXCloseButton: {} });
  f.app.AXWindows = [...f.windows];
  const api = f.source.nativeAX({ cleanup: true }, { check() {}, emit() {}, now: () => 0 });
  f.source.closeOwnedWindow(f.windows[0], f.request, f.app, api);
  assert.deepEqual(presses, f.windows.slice(0, 4).map(w => w.AXCloseButton));
  assert.deepEqual(f.app.AXWindows, f.windows.slice(4));
});

test('an already closed retained Finder window does not prevent sibling fixture cleanup', () => {
  const f = fixture();
  f.windows[0].closed = true;
  f.close();
  assert.deepEqual(f.closed, f.windows.slice(1, 4));
});

test('Finder cleanup recognizes AXURL metadata when AXDocument is absent', () => {
  const f = fixture();
  const window = { role: 'AXWindow', title: 'Other fixture folder', document: '', url: 'file:///scratch/sleight-bench/run/Created' };
  const baseline = { ...window };
  f.windows.push(window, baseline);
  f.request.finderOwnership.created.push(window);
  f.request.finderOwnership.baseline.push({ reference: baseline, role: 'AXWindow' });
  f.close();
  assert.ok(window.closed, 'AXURL fixture window was left open');
  assert.equal(baseline.closed, undefined, 'AXURL location alone must not authorize a close');
});

for (const metadata of ['document', 'url']) test(`Finder cleanup rechecks ${metadata === 'url' ? 'AXURL' : 'AXDocument'} identity at the AX press boundary`, () => {
  const f = fixture();
  if (metadata === 'url') { f.windows[0].url = f.windows[0].document; f.windows[0].document = ''; }
  f.api.closeButton = (w, validate) => { w[metadata] = 'file:///owner/Files-12345678'; validate(); assert.fail('pressed changed window'); };
  assert.throws(() => f.close(), /identity changed/);
  assert.equal(f.closed.length, 0);
});

for (const [failure, expected, description] of [
  ['dialog', /dialog/, 'dialogs'], ['inventory', /inventory unavailable/, 'unavailable inventories'], ['stays', /still open/, 'windows that stay listed'],
]) test(`Finder cleanup refuses ${description} after creation ownership is established`, () => {
    const f = fixture();
    if (failure === 'dialog') f.api.dialog = () => [{ category: 'permission' }];
    if (failure === 'inventory') f.api.windows = () => { throw Error('inventory unavailable'); };
    if (failure === 'stays') f.api.closeButton = (_w, validate) => validate();
    assert.throws(() => f.close(), expected);
    assert.equal(f.closed.length, 0);
});

test('Finder cleanup refuses matching fixture paths without a creation receipt', () => {
  const f = fixture();
  delete f.request.finderOwnership;
  assert.throws(() => f.close(), /ownership unconfirmed/);
  assert.deepEqual(f.closed, []);
  assert.equal(f.api.windows().length, f.windows.length);
});

test('Finder cleanup preserves an unreceipted extra window even at the exact target path', () => {
  const f = fixture(), extra = { ...f.windows[0] };
  f.windows.push(extra);
  f.close();
  assert.deepEqual(f.closed, f.windows.slice(0, 4));
  assert.ok(f.api.windows().includes(extra));
});

test('Finder cleanup refuses a retained reference that belongs to the baseline', () => {
  const f = fixture();
  f.request.finderOwnership.baseline.push({ reference: f.windows[0], role: 'AXWindow' });
  assert.throws(() => f.close(), /ownership unconfirmed/);
  assert.deepEqual(f.closed, []);
});

for (const document of ['file:///owner/Files-12345678', 'file:///scratch/sleight-bench-other/Files-12345678', ''])
  test(`Finder creation ownership still requires fixture location (${document || 'wrong title without a path'})`, () => {
    const f = fixture();
    Object.assign(f.windows[0], { document, title: document ? 'Files-12345678' : 'sleight-bench' });
    assert.throws(() => f.close(), /identity changed/);
    assert.deepEqual(f.closed, []);
  });
