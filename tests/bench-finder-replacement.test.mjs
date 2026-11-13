import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { check4FinderObservation } from '../bench/hand/check4-bench.mjs';
import { openFixture } from '../bench/real-fixture.mjs';
import { executeRealTask, releaseFixtureLock } from '../bench/real-run.mjs';

function trial(change = () => {}) {
  let source = readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8');
  const variants = {
    time: ['!(first[0].firstSeenAtMs > receipt.createdAtMs)', 'false'],
    title: ["api.text(window, 'AXTitle') !== title", 'false'],
    bank: ["target.indexOf(root + '/') !== 0", 'false'],
    number: ['finderReplacementNumber(window, request, app, api) !== numbers[index]', 'false'],
    confirmation: ['listed(window) || api.windowNumberPresent(numbers[index], app)', 'false'],
    scope: ['  {\n    var replacements = inventory()', '  if (request.finderAdoption) {\n    var replacements = inventory()'],
  };
  const variant = variants[process.env.CHV1C_BROKEN_VARIANT];
  if (variant) { assert.ok(source.includes(variant[0])); source = source.split(variant[0]).join(variant[1]); }
  const s = { ObjC: { import() {} } }; runInNewContext(source, s);
  const original = {}, baseline = { id: 10 }, replacement = { id: 30, title: 'Files-run-0123456789abcdef' };
  const root = '/bank/run', target = `${root}/${replacement.title}`;
  const f = { current: [baseline, replacement], actions: [], replacement, cgPresent: false, beforePress() {} };
  const request = { bundle: 'com.apple.finder', mode: 'folder', finderAdoption: true, fixtureRoot: root, target,
    finderOwnership: { schema: 'finder-role-baseline-v1', baseline: [{ reference: baseline, role: 'AXWindow' }],
      created: [original], windowNumber: 20, createdAtMs: 1000 },
    finderObservation: { schema: 'finder-sampler-witness/1', pid: 42, createdAtMs: 1000, observedFromMs: 900,
      sampledAtMs: 1200, windows: [{ id: 30, pid: 42, firstSeenAtMs: 1100 }] } };
  const api = { equal: (a, b) => a === b, windows: () => f.current, finderRole: () => 'AXWindow',
    text: (w, key) => { assert.notEqual(w, original, 'never query the stale original');
      return key === 'AXTitle' ? w.title : key === 'AXDocument' ? w.document || '' : ''; },
    path: value => value, windowNumber: w => w.id, processId: () => 42,
    windowNumberPresent: () => f.cgPresent, dialog: () => [], wait() {},
    closeButton: (w, validate) => { f.beforePress(); validate(); f.actions.push(w.id); f.current = f.current.filter(item => item !== w); },
  };
  f.request = request; f.api = api;
  change(f);
  f.close = () => s.closeFinderFixtureWindows(original, request, {}, api);
  return f;
}

test('replacement Finder window closes by its observed number while baseline windows stay untouched', () => {
  const f = trial(); f.close(); assert.deepEqual(f.actions, [30]); assert.equal(f.current.length, 1);
});
for (const [name, change] of [
  ['first seen before creation', f => { f.request.finderObservation.windows[0].firstSeenAtMs = 999; }],
  ['first seen at creation', f => { f.request.finderObservation.windows[0].firstSeenAtMs = 1000; }],
  ['unobserved number', f => { f.request.finderObservation.windows = []; }],
  ['no sampler baseline', f => { f.request.finderObservation.observedFromMs = 1001; }],
  ['another run timestamp', f => { f.request.finderObservation.createdAtMs = 999; }],
  ['another PID', f => { f.request.finderObservation.pid = 43; }],
  ['no witness', f => { f.request.finderObservation = null; }],
  ['no sampler policy outside Check 4', f => { f.request.finderAdoption = false; }],
  ['wrong exact title', f => { f.replacement.title += '-other'; }],
  ['folder outside this bank', f => { f.request.fixtureRoot = '/bank/other'; }],
  ['bank prefix sibling', f => { f.request.fixtureRoot = '/bank/ru'; }],
  ['URL names another folder', f => { f.replacement.document = '/owner/folder'; }],
]) test(`replacement refuses ${name} and leaves the window`, () => {
  const f = trial(change); assert.throws(f.close, /ownership|identity/); assert.deepEqual(f.actions, []); assert.equal(f.current.length, 2);
});
test('replacement rechecks window number immediately before AX close', () => {
  const f = trial(); f.beforePress = () => {
    f.replacement.id = 31;
    f.request.finderObservation.windows.push({ id: 31, pid: 42, firstSeenAtMs: 1150 });
  };
  assert.throws(f.close, /identity changed/); assert.deepEqual(f.actions, []);
});
test('replacement requires the WindowServer number to disappear after AX close', () => {
  const f = trial(f => { f.cgPresent = true; });
  assert.throws(f.close, /still open/); assert.deepEqual(f.actions, [30]);
});
test('a late foreign window remains and prevents cleanup confirmation', () => {
  const f = trial(); f.beforePress = () => { f.current.push({ id: 99, title: 'Owner folder' }); };
  assert.throws(f.close, /ownership/); assert.deepEqual(f.actions, [30]); assert.ok(f.current.some(w => w.id === 99));
});

for (const lockHeld of [false, true]) test(`unproved replacement retains the ${lockHeld ? 'delegated' : 'task'} live lock`, async t => {
  const f = trial(f => { f.request.finderAdoption = false; });
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'fixture-unproved-lock-')));
  const ctx = { dir, lockPath: join(dir, 'synthetic-lock') }; let releases = 0;
  const diagnostic = { bundle: 'com.apple.finder', cleanup: 'unconfirmed', windowCleanupConfirmed: false };
  const task = { setup() {
    ctx.windowLeases = [{ diagnostics: diagnostic, dispose: async () => { try { f.close(); return true; } catch { return false; } } }];
    ctx.fixtureDiagnostics = [diagnostic];
  }, prompt: () => 'offline', cleanup: f.close };
  const release = async () => { releases++; };
  const result = await executeRealTask(task, ctx, { lockHeld, setupOnly: true, lock: async () => release });
  if (lockHeld) assert.equal(await releaseFixtureLock([ctx], release), false);
  assert.equal(releases, 0); assert.equal(ctx.fixtureLockUnconfirmed, true); assert.equal(result.liveLockKept, ctx.lockPath);
  assert.deepEqual(f.actions, []); assert.ok(f.current.includes(f.replacement));
});

function sampler(t, mutate = rows => rows) {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'fixture-observation-')));
  const row = (epochMs, ids) => ({ source: 'CGWindowListCopyWindowInfo', epochMs, appPids: [42],
    windows: ids.map(id => ({ id, pid: 42, layer: 0, alpha: 1 })) });
  const rows = mutate([row(900, [10]), row(1001, [10, 20]), row(1100, [10, 30]), row(1200, [10, 30])]);
  writeFileSync(join(dir, 'sampler.jsonl'), rows.map(JSON.stringify).join('\n') + '\n{"partial":', { mode: 0o600 });
  return check4FinderObservation({ dir }, { pid: 42, createdAtMs: 1000 }, 1250);
}
test('sampler retains the first appearance rather than the latest appearance', { skip: typeof process.getuid !== 'function' }, t => {
  const result = sampler(t);
  assert.equal(result.observedFromMs, 900);
  assert.deepEqual(result.windows, [{ id: 10, pid: 42, firstSeenAtMs: 900 }, { id: 20, pid: 42, firstSeenAtMs: 1001 },
    { id: 30, pid: 42, firstSeenAtMs: 1100 }]);
});
test('sampler excludes transient Finder menus and invisible windows from creation evidence', { skip: typeof process.getuid !== 'function' }, t => {
  const result = sampler(t, rows => rows.map(row => ({ ...row, windows: [...row.windows,
    { id: 99, pid: 42, layer: 101, alpha: 1 }, { id: 100, pid: 42, layer: 0, alpha: 0 }] })));
  assert.deepEqual(result.windows.map(w => w.id), [10, 20, 30]);
});
for (const [name, mutate] of [
  ['unobserved baseline', rows => rows.map(row => ({ ...row, appPids: row.epochMs < 1000 ? [] : [42] }))],
  ['stale sampler', rows => rows.slice(0, 1).map(row => ({ ...row, epochMs: -2000 }))],
  ['clock reversal', rows => rows.reverse()],
]) test(`sampler refuses ${name}`, { skip: typeof process.getuid !== 'function' }, t => { assert.equal(sampler(t, mutate), null); });

test('Finder lease carries its own ready timestamp and sampler witness only in close control', async t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'fixture-control-')));
  let request, finish, stream, witnessCalls = 0;
  const witness = { schema: 'finder-sampler-witness/1' };
  const ctx = { dir, fixtureRoot: '/other-bank', finderObservation: value => {
    witnessCalls++; assert.deepEqual(value, { pid: 42, createdAtMs: 1000 }); return witness;
  } };
  const lease = await openFixture(ctx, { bundle: 'com.apple.finder', app: 'Finder', mode: 'folder' }, {
    helper: async () => ({ command: 'fake', args: [] }),
    run: (_command, args, { onStdout }) => {
      stream = onStdout;
      request = JSON.parse(args.at(-1));
      onStdout('{"stage":"identified-process","pid":42}\n{"stage":"armed"}\n{"stage":"ready","finderCreatedAtMs":1000}\n');
      return new Promise(resolve => { finish = resolve; });
    },
  });
  assert.equal(request.fixtureRoot, dir); assert.equal(request.finderAdoption, true); assert.equal(witnessCalls, 0);
  const closed = lease.close();
  assert.deepEqual(JSON.parse(readFileSync(request.control)).finderObservation, witness);
  stream('{"stage":"finder-cleanup","windowNumber":30,"windowCleanupConfirmed":true,"title":"private-title"}\n');
  finish({ groupClean: true, exit: { code: 0 }, stdout: '{"stage":"closed"}\n' });
  await closed; assert.equal(witnessCalls, 1); assert.equal(lease.diagnostics.windowCleanupConfirmed, true);
  assert.deepEqual(lease.diagnostics.adoptedWindowNumbers, [30]);
  assert.doesNotMatch(JSON.stringify(lease.diagnostics), /private-title/);
});
