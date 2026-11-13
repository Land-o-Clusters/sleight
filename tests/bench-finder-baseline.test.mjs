import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { executeRealTask, releaseFixtureLock } from '../bench/real-run.mjs';
import { finderDiagnostic, openFixture } from '../bench/real-fixture.mjs';

function trial({ windowCount = 1, cleanup = false } = {}) {
  const s = { ObjC: { import() {} } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), s);
  const area = { role: 'AXScrollArea', document: '/fixture/target' };
  const baseline = [area, ...Array.from({ length: windowCount }, () => ({ role: 'AXWindow', document: '/fixture/target' }))];
  const owned = { role: 'AXWindow', document: cleanup ? '/fixture/target' : '', title: 'Recents' }, sheet = {};
  const f = { area, baseline, owned, current: [...baseline, ...(cleanup ? [owned] : [])], actions: [], retained: [], hooks: {}, hits: [] };
  const hit = name => { f.hits.push(name); f.hooks[name]?.(); };
  const request = { bundle: 'com.apple.finder', mode: 'folder', target: '/fixture/target', fixtureRoot: '/fixture', token: 'fixture' };
  if (cleanup) request.finderOwnership = { schema: 'finder-role-baseline-v1', baseline: baseline.map(reference => ({ reference, role: reference.role })), created: [owned] };
  const api = {
    windows: () => { hit('inventory'); return f.current; }, equal: (a, b) => !!a && !a.stale && a === b,
    exists: w => w.role === 'AXWindow' && !w.stale,
    finderRole: w => { hit('role'); return w.stale ? null : w.role; },
    fileMenu: (_a, _t, validate) => { hit('new-menu'); validate(); f.actions.push(['new']); f.current.push(owned); },
    finderFolderGuard: (_a, w) => { hit(w ? 'owned-guard' : 'baseline-guard'); assert.ok(!w || w === owned); },
    menu: (_a, _n, _t, validate) => { hit('go-menu'); validate(); f.actions.push(['go', owned]); },
    folderSheet: w => { assert.equal(w, owned); hit('sheet'); return sheet; },
    submitFolder: (w, _sheet, target, validate) => { hit('submit'); validate(); f.actions.push(['write', w]); w.document = target; },
    dialog: () => { hit('dialog'); return []; },
    text: (w, attr) => { hit('location'); return attr === 'AXDocument' ? w.document : attr === 'AXURL' ? w.url || '' : w.title || ''; }, path: value => value,
    closeButton: (w, validate) => { hit('close-control'); validate(); f.actions.push(['close', w]); f.current = f.current.filter(item => item !== w); hit('after-close'); },
    wait() {}, emit: event => f.events.push(JSON.parse(JSON.stringify(event))),
  };
  f.api = api; f.request = request; f.events = []; f.source = s;
  f.open = () => s.openFinderFolder(request, {}, baseline[0], api, { check() {}, now: () => 0, wait: () => assert.fail('no polling') }, w => f.retained.push(w));
  f.close = () => s.closeFinderFixtureWindows(owned, request, {}, api);
  f.failure = {};
  f.recover = () => s.recoverSetup(f.retained[0], request, api, {}, f.failure);
  api.matches = w => w.document === request.target;
  return f;
}

for (const windowCount of [0, 1, 3]) test(`stable baseline scroll area with ${windowCount} owner windows is retained without being acted on`, () => {
  const f = trial({ windowCount });
  let inventories = 0;
  f.api.windows = () => ++inventories % 2 ? f.current.slice().reverse() : f.current.slice();
  assert.equal(f.open(), f.owned);
  const ledger = f.request.finderOwnership;
  assert.equal(ledger.schema, 'finder-role-baseline-v1');
  assert.deepEqual(new Map(Array.from(ledger.baseline, item => [item.reference, item.role])), new Map(f.baseline.map(item => [item, item.role])));
  assert.deepEqual(Array.from(ledger.created), [f.owned]);
  f.current.reverse(); f.close();
  assert.deepEqual(f.retained, [f.owned]);
  assert.ok(f.actions.every(([, target]) => !target || target === f.owned));
  assert.deepEqual(new Set(f.current), new Set(f.baseline));
});

const mutations = {
  missing: f => { f.current = f.current.filter(item => item !== f.baseline[1]); },
  replaced: f => { f.current[f.current.indexOf(f.baseline[1])] = { role: 'AXWindow' }; },
  'window-role': f => { f.baseline[1].role = 'AXScrollArea'; },
  duplicate: f => { f.current.push(f.area); },
  stale: f => { f.area.stale = true; },
  nil: f => { f.current.push(null); },
  nonwindow: f => { f.current.push({ role: 'AXGroup' }); },
};

const scrollChanges = {
  missing: f => { f.current = f.current.filter(item => item !== f.area); },
  replaced: f => { f.current[f.current.indexOf(f.area)] = { role: 'AXScrollArea' }; },
  added: f => { f.current.push({ role: 'AXScrollArea' }); },
};

for (const [name, mutate] of Object.entries(scrollChanges)) {
  test(`setup tolerates ${name} inert scroll area without adopting it`, () => {
    const f = trial(); f.hooks['owned-guard'] = () => { mutate(f); delete f.hooks['owned-guard']; };
    assert.equal(f.open(), f.owned);
    assert.deepEqual(f.retained, [f.owned]);
    f.close();
    assert.deepEqual(f.actions.filter(([action]) => action === 'close'), [['close', f.owned]]);
    assert.deepEqual(f.request.finderScrollAreas && JSON.parse(JSON.stringify(f.request.finderScrollAreas)), {
      scrollAreasBaseline: 1, scrollAreasMatched: name === 'added' ? 1 : 0,
    });
    assert.deepEqual(f.events.at(-1), { stage: 'finder-cleanup', scrollAreasBaseline: 1, scrollAreasMatched: name === 'added' ? 1 : 0 });
  });
  test(`cleanup tolerates ${name} inert scroll area`, () => {
    const f = trial({ cleanup: true }); mutate(f); f.close();
    assert.deepEqual(f.actions, [['close', f.owned]]);
    assert.ok(f.current.includes(f.baseline[1]));
  });
}

test('token-based AX equality tolerates a desktop reference replaced by New Finder Window', () => {
  const f = trial({ windowCount: 0 });
  f.area.token = 'desktop-before'; f.owned.token = 'fixture-window';
  f.api.equal = (a, b) => !!a && !!b && a.token === b.token;
  f.api.finderFolderGuard = (_app, w) => assert.ok(!w || f.api.equal(w, f.owned));
  f.api.folderSheet = w => { assert.ok(f.api.equal(w, f.owned)); return {}; };
  f.api.fileMenu = (_app, _titles, validate) => {
    validate();
    f.current = [{ role: 'AXScrollArea', token: 'desktop-after' }, { ...f.owned }];
  };
  assert.notEqual(f.api.equal(f.area, { token: 'desktop-after' }), true);
  const result = f.open();
  assert.equal(result, f.current[1]);
  assert.deepEqual(f.retained, [result]);
  assert.deepEqual(Array.from(f.request.finderOwnership.created), [result]);
});

for (const failure of ['first-validation', 'retention-receipt']) test(`candidate is recorded before ${failure} fails and recovery closes it`, () => {
  const f = trial();
  if (failure === 'first-validation') f.hooks['owned-guard'] = () => { throw new Error('Finder folder window lost focus'); };
  else f.api.finderFolderGuard = () => {};
  const clock = { check() {}, now: () => 0, wait() {}, emit() { throw new Error('receipt failure'); } };
  assert.throws(() => failure === 'first-validation' ? f.open() :
    f.source.openFinderFolder(f.request, {}, f.baseline[1], f.api, clock, w => f.retained.push(w)), /lost focus|receipt failure/);
  assert.deepEqual(f.retained, [f.owned]);
  assert.deepEqual(Array.from(f.request.finderOwnership.created), [f.owned]);
  assert.equal(f.owned.document, '', 'failure precedes navigation');
  assert.equal(f.owned.title, 'Recents');
  assert.equal(f.recover(), 'closed retained fixture');
  assert.deepEqual(f.actions.filter(([action]) => action === 'close'), [['close', f.owned]]);
  assert.ok(f.current.includes(f.baseline[1]));
});

for (const [name, before, after] of [
  ['user folder title', { title: 'Documents' }],
  ['unknown default title', { title: 'Recent Items' }],
  ['empty title', { title: '' }],
  ['fixture-location-mismatch', { document: '/owner/Collections-1' }],
  ['foreign AXURL', { url: '/owner/Collections-1' }],
  ['title changed after creation', {}, f => { f.owned.title = 'Documents'; }],
  ['default title was not observed at creation', { title: 'Documents' }, f => { f.owned.title = 'Recents'; }],
  ['document added after creation', {}, f => { f.owned.document = '/owner/Collections-1'; }],
  ['URL added after creation', {}, f => { f.owned.url = '/owner/Collections-1'; }],
  ['missing creation-title receipt', {}, f => { delete f.request.finderOwnership.documentless; }],
  ['duplicate creation-title receipt', {}, f => { f.request.finderOwnership.documentless.push(f.request.finderOwnership.documentless[0]); }],
]) test(`recovery leaves the retained window open for ${name}`, () => {
  const f = trial(); Object.assign(f.owned, before);
  f.hooks['owned-guard'] = () => { throw new Error('Finder folder window lost focus'); };
  assert.throws(f.open, /lost focus/);
  assert.deepEqual(f.retained, [f.owned]);
  after?.(f);
  assert.equal(f.recover(), 'unconfirmed');
  assert.equal(f.failure.failureReason, 'fixture-location-mismatch');
  assert.deepEqual(f.actions.filter(([action]) => action === 'close'), []);
  assert.ok(f.current.includes(f.owned));
  assert.ok(f.current.includes(f.baseline[1]));
});

test('navigation revokes the documentless default-title fallback', () => {
  const f = trial();
  f.api.submitFolder = (_window, _sheet, _target, _validate, onNavigate) => { onNavigate(); throw new Error('navigation failed'); };
  assert.throws(f.open, /navigation failed/);
  assert.equal(f.recover(), 'unconfirmed');
  assert.equal(f.failure.failureReason, 'fixture-location-mismatch');
  assert.equal(f.actions.some(([action]) => action === 'close'), false);
});

test('documentless recovery rechecks the creation title at the close press boundary', () => {
  const f = trial();
  f.hooks['owned-guard'] = () => { throw new Error('Finder folder window lost focus'); };
  assert.throws(f.open, /lost focus/);
  f.hooks['close-control'] = () => { f.owned.title = 'Owner folder'; };
  assert.throws(f.recover, /identity changed/);
  assert.equal(f.actions.some(([action]) => action === 'close'), false);
  assert.ok(f.current.includes(f.owned));
});

for (const name of ['missing', 'replaced', 'window-role']) test(`cleanup closes its fixture despite ${name} baseline window and reports drift`, () => {
  const f = trial({ cleanup: true }); mutations[name](f); f.close();
  assert.deepEqual(f.actions, [['close', f.owned]]);
  const diagnostic = f.events.find(event => event.finderBaselineChange)?.finderBaselineChange;
  assert.deepEqual(diagnostic, { failureReason: 'baseline-changed', errorName: 'Error', errorCode: 'unavailable',
    phase: 'cleanup', baselineCount: 2, currentCount: name === 'missing' ? 2 : 3, missingRole: 'AXWindow', missingIndex: 1,
    scrollAreasBaseline: 1, scrollAreasMatched: 1 });
  assert.deepEqual(finderDiagnostic({ finderBaselineChange: diagnostic }), { finderBaselineChange: diagnostic });
  assert.ok(f.current.every(item => item !== f.owned));
});

for (const phase of ['pre-press', 'poll', 'validate']) test(`setup attaches ${phase} to a vanished baseline window`, () => {
  const f = trial(), remove = () => { f.current = f.current.filter(item => item !== f.baseline[1]); };
  if (phase === 'pre-press') f.hooks['new-menu'] = remove;
  if (phase === 'poll') {
    const create = f.api.fileMenu;
    f.api.fileMenu = (...args) => { create(...args); remove(); };
  }
  if (phase === 'validate') f.hooks['owned-guard'] = remove;
  assert.throws(f.open, error => {
    assert.deepEqual(JSON.parse(JSON.stringify(f.source.finderStaticFailure(error))), {
      failureReason: 'baseline-changed', errorName: 'Error', errorCode: 'unavailable', phase,
      baselineCount: 2, currentCount: phase === 'pre-press' ? 1 : 2, missingRole: 'AXWindow', missingIndex: 1,
      scrollAreasBaseline: 1, scrollAreasMatched: 1,
    });
    return true;
  });
});

test('parent fixture receipt retains sanitized cleanup drift without failing the close', async t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-fb1-receipt-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const drift = { failureReason: 'baseline-changed', errorName: 'Error', errorCode: 'unavailable',
    phase: 'cleanup', baselineCount: 2, currentCount: 2, missingRole: 'AXWindow', missingIndex: 1,
    scrollAreasBaseline: 1, scrollAreasMatched: 0 };
  const ctx = { dir, lockPath: join(dir, 'synthetic-lock') };
  const lease = await openFixture(ctx, { app: 'Finder', bundle: 'com.apple.finder', mode: 'folder' }, {
    helper: async () => ({ command: 'fake', args: [] }), open: () => assert.fail('no app launch'),
    run: async (_command, _args, { onStdout }) => {
      const events = [{ stage: 'armed' }, { stage: 'ready', scrollAreasBaseline: 1, scrollAreasMatched: 0 },
        { stage: 'finder-baseline-changed', finderBaselineChange: { ...drift, title: 'owner-private-title', path: '/owner/private' } },
        { stage: 'finder-cleanup', scrollAreasBaseline: 1, scrollAreasMatched: 0 },
        { stage: 'closed' }];
      const stdout = events.map(event => JSON.stringify(event)).join('\n') + '\n';
      onStdout(stdout);
      return { stdout, groupClean: true, exit: { code: 0 } };
    },
  });
  await lease.close();
  assert.deepEqual(lease.diagnostics.finderBaselineChange, drift);
  assert.equal(lease.diagnostics.scrollAreasBaseline, 1);
  assert.equal(lease.diagnostics.scrollAreasMatched, 0);
  assert.equal(lease.diagnostics.windowCleanupConfirmed, true);
  assert.doesNotMatch(JSON.stringify(lease.diagnostics), /owner-private|\/owner\/private/);
  assert.equal(await lease.dispose(), true);
});

for (const boundary of ['new-menu', 'baseline-guard', 'owned-guard', 'go-menu', 'sheet', 'submit']) {
  for (const [name, mutate] of Object.entries(mutations)) test(`setup refuses ${name} baseline mutation at ${boundary}`, () => {
    const f = trial(); let changed = false;
    f.hooks[boundary] = () => { if (!changed) { changed = true; mutate(f); } };
    assert.throws(f.open, /inventory|identity|baseline/);
    assert.equal(changed, true, 'the requested nested boundary must be reached');
    assert.ok(f.actions.every(([, target]) => !target || target === f.owned));
    assert.equal(f.actions.some(([action]) => action === 'write'), false);
    assert.ok(f.retained.every(item => item === f.owned));
  });
}

for (const boundary of ['dialog', 'location', 'close-control', 'after-close']) {
  for (const [name, mutate] of Object.entries(mutations)) test(`cleanup handles ${name} baseline mutation at ${boundary}`, () => {
    const f = trial({ cleanup: true }); let changed = false;
    f.hooks[boundary] = () => { if (!changed) { changed = true; mutate(f); } };
    if (['missing', 'replaced', 'window-role'].includes(name)) f.close();
    else assert.throws(f.close, /inventory|identity|baseline|ownership/);
    assert.equal(changed, true, 'the requested close boundary must be reached');
    assert.ok(f.actions.every(([, target]) => target === f.owned));
    if (['missing', 'replaced', 'window-role'].includes(name)) assert.deepEqual(f.actions, [['close', f.owned]]);
    else if (boundary !== 'after-close') assert.deepEqual(f.actions, []);
  });
}

for (const schema of ['missing', 'old', 'entry-missing-role', 'bad-role']) test(`cleanup refuses ${schema} role ledger without guessing`, () => {
  const f = trial({ cleanup: true }), ledger = f.request.finderOwnership;
  if (schema === 'missing') delete ledger.schema;
  if (schema === 'old') ledger.baseline = [...f.baseline];
  if (schema === 'entry-missing-role') delete ledger.baseline[0].role;
  if (schema === 'bad-role') ledger.baseline[0].role = 'AXOwnerPrivateRole';
  assert.throws(f.close, /ledger|ownership/);
  assert.deepEqual(f.actions, []);
});

for (const lockHeld of [false, true]) test(`baseline failure during actual cleanup keeps the owning ${lockHeld ? 'outer' : 'task'} lock`, async t => {
  const f = trial({ cleanup: true });
  f.hooks.dialog = () => { f.current.push(null); };
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-finder-baseline-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir, lockPath: join(dir, 'synthetic-lock') }; let releases = 0;
  const diagnostics = { bundle: 'com.apple.finder', launched: false, cleanup: 'unconfirmed', windowCleanupConfirmed: false };
  const task = { setup() {
    ctx.windowLeases = [{ diagnostics, dispose: async () => { try { f.close(); return true; } catch { return false; } } }];
    ctx.fixtureDiagnostics = [diagnostics];
  }, prompt: () => 'offline', cleanup: () => f.close() };
  const release = async () => { releases++; };
  const result = await executeRealTask(task, ctx, { lockHeld, setupOnly: true, lock: async () => release });
  if (lockHeld) assert.equal(await releaseFixtureLock([ctx], release), false);
  assert.equal(releases, 0);
  assert.equal(ctx.fixtureLockUnconfirmed, true);
  assert.ok(result.liveLockKept);
  assert.deepEqual(f.actions, []);
});

for (const change of ['baseline drift', 'fixture location']) test(`production cleanup revalidates ${change} before native AXPress`, () => {
  const s = { ObjC: { import() {}, unwrap: value => value, castRefToObject: value => value } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), s);
  const area = { AXRole: 'AXWindow' }, window = { AXRole: 'AXWindow', AXDocument: '/fixture/target', AXCloseButton: {} }, app = { AXWindows: [area, window] };
  const ledger = { schema: 'finder-role-baseline-v1', baseline: [{ reference: area, role: 'AXWindow' }], created: [window] };
  let closeRead = false, changed = false, presses = 0;
  const events = [];
  const native = value => value;
  native.CFEqual = (a, b) => a === b;
  native.AXUIElementCopyAttributeValue = (element, attribute, output) => {
    if (attribute === 'AXCloseButton') closeRead = true;
    const value = element[attribute]; output[0] = Array.isArray(value) ? { count: value.length, objectAtIndex: i => value[i] } : value; return 0;
  };
  native.AXUIElementPerformAction = button => {
    assert.equal(button, window.AXCloseButton); presses++;
    app.AXWindows = app.AXWindows.filter(w => w !== window); return 0;
  };
  s.$ = native; s.Ref = () => [];
  const api = s.nativeAX({ cleanup: true }, { emit: e => events.push(e), check() {
    if (!closeRead || changed) return;
    changed = true;
    if (change === 'baseline drift') area.AXRole = 'AXScrollArea';
    else window.AXDocument = '/owner/private';
  } });
  api.path = value => value; api.dialog = () => [];
  const request = { bundle: 'com.apple.finder', mode: 'folder', target: '/fixture/target', fixtureRoot: '/fixture', finderOwnership: ledger };
  const close = () => s.closeOwnedWindow(window, request, app, api);
  if (change === 'fixture location') { assert.throws(close, /identity changed/); assert.equal(presses, 0); }
  else {
    close(); assert.equal(presses, 1);
    assert.equal(events.filter(e => e.stage === 'finder-baseline-changed').length, 1);
  }
  assert.equal(changed, true);
  assert.ok(app.AXWindows.includes(area));
});

test('ordinary native close preserves its existing single validation callback', () => {
  const s = { ObjC: { import() {}, castRefToObject: value => value } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), s);
  const native = value => value; let validations = 0, presses = 0;
  native.AXUIElementCopyAttributeValue = (_element, _attribute, output) => { output[0] = {}; return 0; };
  native.AXUIElementPerformAction = () => { presses++; return 0; };
  s.$ = native; s.Ref = () => [];
  const api = s.nativeAX({ cleanup: true }, { check() {} });
  api.closeButton({}, () => { validations++; });
  assert.equal(validations, 1);
  assert.equal(presses, 1);
});
