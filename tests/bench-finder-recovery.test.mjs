import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import * as lifecycle from '../bench/real-run.mjs';
const { executeRealTask } = lifecycle;
const finderSetupRetryable = result => {
  assert.equal(typeof lifecycle.finderSetupRetryable, 'function', 'Finder infrastructure classifier is missing');
  return lifecycle.finderSetupRetryable(result);
};

function source() {
  const sandbox = { ObjC: { import() {}, unwrap: v => v } };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), sandbox);
  return sandbox;
}

function health({ codes = [-25204, -25204, -25204], recoveredAt = 0, bundle = 'com.apple.finder', force = true } = {}) {
  const s = source(), events = [];
  let time = 0, probes = 0, terminations = 0, forcedAt;
  const old = { processIdentifier: 42, bundleIdentifier: bundle, launchDate: { timeIntervalSince1970: 1 },
    get forceTerminate() { terminations++; forcedAt = time; return force; } };
  const successor = { processIdentifier: 43, bundleIdentifier: 'com.apple.finder', launchDate: { timeIntervalSince1970: 2, isNil: () => false } };
  const api = {
    birth: pid => pid === 42 ? '1.000000' : '2.000000',
    exited: () => forcedAt !== undefined,
    application: () => forcedAt === undefined ? old : time - forcedAt >= recoveredAt ? successor : null,
    probe: () => { time += 500; return forcedAt === undefined ? codes[Math.min(probes++, codes.length - 1)] : time - forcedAt >= recoveredAt ? 0 : -25204; },
  };
  const clock = { now: () => time, check() {}, wait: ms => { time += ms; }, emit: e => events.push(e) };
  return { run: () => s.ensureFinderAX(api, clock), events,
    get time() { return time; }, get probes() { return probes; }, get terminations() { return terminations; } };
}

for (const [name, fields, reason, reads] of [
  ['missing target', null, 'target-unavailable', []],
  ['wrong bundle before invalid pid and start', { bundle: 'owner-private-bundle', pid: 0, start: null }, 'bundle-mismatch', ['pid', 'bundle']],
  ...[undefined, null, 0, -1, 1.5, NaN, Infinity].map(pid => [
    `invalid pid ${String(pid)}`, { pid, start: null }, 'pid-invalid', ['pid', 'bundle'],
  ]),
  ...[null, {}, '0.000001', '1.000001\n', '1.000000x'].map((start, index) => [
    `unavailable start ${index}`, { start }, 'start-unavailable', ['pid', 'bundle', 'birth'],
  ]),
  ['terminated target', { terminated: true }, 'terminated', ['pid', 'bundle', 'birth', 'pid', 'bundle', 'birth', 'terminated']],
]) test(`Finder identity reason identifies ${name} without probing or recovery`, () => {
  const s = source(), seen = [], events = []; let probes = 0, terminations = 0;
  const values = fields && { pid: 42, start: '1.000000', bundle: 'com.apple.finder', ...fields };
  const app = values && {
    get processIdentifier() { seen.push('pid'); return values.pid; },
    get launchDate() { assert.fail('Finder birth cannot depend on AppKit launchDate'); },
    get bundleIdentifier() { seen.push('bundle'); return values.bundle; },
    get isTerminated() { seen.push('terminated'); return values.terminated; },
    get forceTerminate() { terminations++; return true; },
  };
  assert.throws(() => s.ensureFinderAX({ application: () => app, birth: pid => {
    assert.equal(pid, values.pid); seen.push('birth'); return values.start;
  }, probe: () => { probes++; return 0; } }, {
    now: () => 0, check() {}, wait: () => assert.fail('no retry without identity'), emit: event => events.push(event),
  }), error => {
    assert.equal(error.identityReason, reason);
    assert.equal(error.attribute, 'AXWindows');
    assert.equal(error.code, undefined);
    assert.equal(error.finderAX, true);
    assert.doesNotMatch(error.message, /owner-private-bundle/);
    return true;
  });
  assert.deepEqual(seen, reads, 'kernel lookup follows target, bundle and PID validation');
  assert.equal(probes, 0);
  assert.equal(terminations, 0);
  assert.deepEqual(events, []);
});

for (const [field, value, reason] of [
  ['processIdentifier', 43, 'pid-changed'],
  ['pidBirth', '1.000001', 'start-changed'],
  ['isTerminated', true, 'terminated'],
]) for (const boundary of ['after-first-probe', 'before-force'])
  test(`Finder identity reason reports ${reason} ${boundary} and refuses recovery`, () => {
    const s = source(), events = []; let probes = 0, terminations = 0, time = 0;
    const app = { processIdentifier: 42, bundleIdentifier: 'com.apple.finder', pidBirth: '1.000000',
      get forceTerminate() { terminations++; return true; } };
    assert.throws(() => s.ensureFinderAX({ application: () => app, birth: () => app.pidBirth, probe: () => {
      time += 500; probes++;
      if (boundary === 'after-first-probe') app[field] = value;
      return -25204;
    } }, { now: () => time, check() {}, wait: ms => { time += ms; }, emit: event => {
      events.push(event); if (boundary === 'before-force') app[field] = value;
    } }), error => {
      assert.equal(error.identityReason, reason);
      assert.equal(error.code, -25204);
      assert.equal(error.attribute, 'AXWindows');
      return true;
    });
    assert.equal(probes, boundary === 'after-first-probe' ? 1 : 3);
    assert.equal(terminations, 0);
    assert.equal(events.some(event => event.stage === 'finder-recovered'), false);
  });

test('Finder identity reason allowlist strips arbitrary metadata while retaining code and attribute', async () => {
  const { finderDiagnostic } = await import('../bench/real-fixture.mjs');
  for (const identityReason of ['target-unavailable', 'bundle-mismatch', 'pid-invalid', 'start-unavailable', 'pid-changed', 'start-changed', 'terminated']) {
    assert.deepEqual(finderDiagnostic({ finderAXError: { code: -25204, attribute: 'AXWindows', identityReason,
      message: 'owner-private-title', stderr: '/owner/private/path' } }), {
      finderAXError: { code: -25204, attribute: 'AXWindows', identityReason },
    });
  }
  for (const identityReason of ['owner-private-title', 'start-unavailable /owner/private/path', '', null, 42, {}, ['terminated']]) {
    assert.deepEqual(finderDiagnostic({ finderAXError: { code: -25204, attribute: 'AXWindows', identityReason } }), {
      finderAXError: { code: -25204, attribute: 'AXWindows' },
    });
  }
});

test('Finder identity reason survives helper failure collection without raw helper text', async t => {
  const { openFixture } = await import('../bench/real-fixture.mjs');
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-finder-identity-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir, lockPath: join(dir, 'synthetic-lock') };
  await assert.rejects(openFixture(ctx, { app: 'Finder', bundle: 'com.apple.finder', mode: 'folder' }, {
    helper: async () => ({ command: 'fake', args: [] }),
    open: () => assert.fail('identity failure cannot launch Finder'),
    run: async (_command, _args, { onStdout }) => {
      const stdout = JSON.stringify({ stage: 'setup-failure', actionTaken: false, cleanup: 'nothing created',
        finderAXError: { attribute: 'AXWindows', identityReason: 'start-unavailable', message: 'owner-private-title' } }) + '\n';
      onStdout(stdout);
      return { stdout, stderr: 'owner-private-title /owner/private/path', groupClean: true, exit: { code: 1 } };
    },
  }), error => {
    assert.deepEqual(error.fixtureDiagnostics.finderAXError, { attribute: 'AXWindows', identityReason: 'start-unavailable' });
    assert.equal(error.fixtureSetupFailure, 'finder-ax');
    assert.doesNotMatch(error.message, /owner-private-title|\/owner\/private/);
    return true;
  });
  assert.equal(await ctx.windowLeases[0].dispose(), true);
  assert.equal(ctx.fixtureDiagnostics[0].windowCleanupConfirmed, true);
});

test('Finder probes twice after its first failure, then force-terminates only the hung Finder and waits for its successor', () => {
  const f = health({ recoveredAt: 1600 });
  assert.equal(f.run().processIdentifier, 43);
  assert.equal(f.probes, 3);
  assert.equal(f.terminations, 1);
  assert.equal(f.events.length, 2);
  assert.equal(f.events[1].finderRecovery.originalExitConfirmed, true);
  assert.equal(f.events[0].stage, 'finder-relaunch');
  assert.match(f.events[0].finderRelaunch.reason, /AX.*timeout/i);
});

for (const codes of [[0], [-25204, 0], [-25204, -25204, 0]]) test(`responsive Finder is never terminated (${codes})`, () => {
  const f = health({ codes });
  assert.equal(f.run().processIdentifier, 42);
  assert.equal(f.terminations, 0);
  assert.equal(f.events.length, 0);
});

test('non-timeout AX errors fail without terminating Finder', () => {
  const f = health({ codes: [-25205] });
  assert.throws(f.run, /Finder AX/);
  assert.equal(f.probes, 3);
  assert.equal(f.terminations, 0);
});

test('immediate CannotComplete errors do not prove a hung main thread', () => {
  const s = source(); let terminations = 0, time = 0;
  const app = { processIdentifier: 42, bundleIdentifier: 'com.apple.finder', launchDate: { timeIntervalSince1970: 1 }, get forceTerminate() { terminations++; return true; } };
  assert.throws(() => s.ensureFinderAX({ application: () => app, birth: () => '1.000000', probe: () => -25204 }, {
    now: () => time, check() {}, wait: ms => { time += ms; }, emit() {},
  }), /probe failed/);
  assert.equal(terminations, 0);
});

test('timeouts across changing Finder processes never authorize termination', () => {
  const s = source(); let pid = 40, terminations = 0, time = 0;
  const app = () => ({ processIdentifier: pid++, bundleIdentifier: 'com.apple.finder', launchDate: { timeIntervalSince1970: 1 }, get forceTerminate() { terminations++; return true; } });
  assert.throws(() => s.ensureFinderAX({ application: app, birth: () => '1.000000', probe: () => { time += 500; return -25204; } }, {
    now: () => time, check() {}, wait: ms => { time += ms; }, emit() {},
  }), /process changed/);
  assert.equal(terminations, 0);
  assert.equal(pid, 42, 'fail at the first changed process');
});

test('raw Finder probe sets a short timeout and accepts an empty AXWindows response', () => {
  const s = source(), calls = [], native = v => v;
  Object.assign(native, {
    AXUIElementCreateApplication: pid => ({ pid }),
    AXUIElementSetMessagingTimeout: (app, seconds) => { calls.push([app.pid, seconds]); return 0; },
    AXUIElementCopyAttributeValue: (_app, name, output) => { assert.equal(name, 'AXWindows'); output[0] = { count: 0 }; return 0; },
  });
  s.$ = native; s.Ref = () => []; s.ObjC.castRefToObject = v => v;
  assert.equal(s.probeFinderAX({ processIdentifier: 42 }, 0.5), 0);
  assert.deepEqual(calls, [[42, 0.5]]);
});

test('Finder relaunch has a thirty-second deadline and never force-terminates twice', () => {
  const f = health({ recoveredAt: Infinity });
  assert.throws(f.run, /Finder AX.*thirty seconds/);
  assert.ok(f.time <= 32000, String(f.time));
  assert.equal(f.terminations, 1);
});

for (const options of [{ bundle: 'com.apple.TextEdit' }, { force: false }]) test(`Finder recovery refuses unsafe or rejected termination ${JSON.stringify(options)}`, () => {
  const f = health(options);
  assert.throws(f.run, /Finder/);
  assert.equal(f.terminations, options.bundle ? 0 : 1);
});

test('folder setup refuses a focus switch to another pre-existing owner window', () => {
  const s = source(), previous = { id: 'owner-window-1' }, foreign = { id: 'owner-window-2' };
  const navigations = [], retained = [];
  let time = 0;
  const api = {
    fileMenu() {}, focused: () => foreign, equal: (a, b) => a === b,
    windows: () => [previous, foreign], menu() {}, folderSheet: () => ({}),
    exists: () => true, finderRole: () => 'AXWindow', finderFolderGuard() {},
    submitFolder: (window, _sheet, target) => navigations.push({ window, target }),
  };
  const clock = { check() {}, now: () => time, wait: ms => { time += ms; } };
  let failure;
  try { s.openFinderFolder({ target: '/fixture/Collections-review' }, {}, previous, api, clock, w => retained.push(w)); }
  catch (error) { failure = error; }
  assert.deepEqual(navigations, [], 'never navigate an owner window');
  assert.deepEqual(retained, [], 'never adopt an owner window for cleanup');
  assert.match(failure?.message ?? '', /New Finder fixture window unconfirmed/);
});

test('folder navigation creates a separate window and uses only its own AX Go to Folder sheet', () => {
  const s = source(), previous = {}, window = {}, sheet = {}, calls = [];
  let navigated = false, retained, created = false;
  const api = { fileMenu: (_app, titles, validate) => { validate(); calls.push(titles[0]); created = true; },
    focused: () => window, equal: (a, b) => a === b, exists: () => true, finderRole: () => 'AXWindow',
    windows: () => created ? [previous, window] : [previous],
    finderFolderGuard: (_app, w) => { if (w) assert.equal(w, window); },
    menu: (_app, menu, titles, validate) => { validate(); calls.push(menu + ':' + titles[0]); },
    folderSheet: w => { assert.equal(w, window); return sheet; },
    submitFolder: (w, dialog, path) => { assert.equal(w, window); assert.equal(dialog, sheet); calls.push(path); navigated = true; },
    matches: w => w === window && navigated,
  };
  const clock = { check() {}, now: () => 0, wait: () => assert.fail('ready without polling') };
  assert.equal(s.openFinderFolder({ target: '/fixture/Collections-1' }, {}, previous, api, clock, w => { retained = w; }), window);
  assert.equal(retained, window);
  assert.deepEqual(calls, ['New Finder Window', 'Go:Go to Folder…', '/fixture/Collections-1']);
});

function folderTrial(change = () => {}) {
  const s = source(), previous = { id: 'owner-1' }, foreign = { id: 'owner-2' }, window = { id: 'fixture' }, sheet = {};
  const f = { previous, foreign, window, sheet, current: [previous, foreign], focused: previous, dialog: null,
    retained: [], navigations: [], commands: [], time: 0 };
  const api = {
    windows: () => f.current, exists: w => f.current?.includes(w), equal: (a, b) => !!a && a === b,
    finderRole: w => api.exists(w) ? 'AXWindow' : null,
    focused: () => f.focused,
    fileMenu: (_app, _titles, validate) => {
      validate(); f.commands.push('new'); f.current = [previous, foreign, window]; f.focused = window;
    },
    finderFolderGuard: (_app, w, dialog) => {
      if (f.dialog && f.dialog !== dialog) throw new Error('Foreign Finder dialog');
      if (w && f.focused !== w && (!dialog || f.focused !== dialog)) throw new Error('Finder folder window lost focus');
    },
    menu: (_app, _name, _titles, validate) => { validate(); f.commands.push('go'); },
    folderSheet: () => sheet,
    submitFolder: (w, dialog, target, validate) => { validate(); f.navigations.push({ window: w, sheet: dialog, target }); },
  };
  const clock = { check() {}, now: () => f.time, wait: ms => { f.time += ms; } };
  change(f, api, clock);
  return Object.assign(f, { api, run: () => s.openFinderFolder({ target: '/fixture/Collections-review' }, {}, previous, api, clock, w => f.retained.push(w)) });
}

for (const [name, change, detail] of [
  ['malformed list', f => { f.current = { title: 'private-owner-title' }; }, 'reason=malformed-list'],
  ['missing element', f => { f.current[1] = null; }, 'reason=missing-element count=2 index=1'],
  ['failed self identity', (f, api) => { api.equal = (a, b) => a !== f.foreign && a === b; }, 'reason=failed-self-identity count=2 index=1'],
  ['non-window or stale element', (f, api) => { api.exists = w => w !== f.foreign; }, 'reason=non-window-or-stale count=2 index=1'],
  ['duplicate identity', f => { f.current.push(f.previous); }, 'reason=duplicate-identity count=3 index=2 duplicateIndex=0'],
]) test(`inventory diagnostic identifies ${name} without acting or exposing content`, () => {
  const f = folderTrial((f, api) => {
    f.previous.AXTitle = 'private-owner-title'; f.previous.AXDocument = '/private/owner/document';
    change(f, api);
  });
  assert.throws(f.run, error => {
    assert.ok(error.message.includes(`Finder fixture window inventory unconfirmed [${detail}]`), error.message);
    assert.doesNotMatch(error.message, /private-owner-title|\/private\/owner|Collections-review/);
    assert.equal(error.finderWindowRequested, undefined);
    return true;
  });
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.retained, []);
  assert.deepEqual(f.navigations, []);
  assert.equal(f.time, 0, 'no retry on an unconfirmed inventory');
});

test('Finder smoke keeps retention and navigation receipts before a later refusal', () => {
  const events = [];
  const f = folderTrial((_f, _api, clock) => { clock.emit = event => events.push(event); });
  f.run();
  assert.deepEqual(events.map(event => event.stage), ['finder-window-retained', 'finder-folder-submitted']);
  assert.equal(events[0].referenceExported, false);
  assert.equal(events[1].target, '/fixture/Collections-review');
  const refused = [];
  const g = folderTrial((_f, api, clock) => {
    clock.emit = event => refused.push(event);
    api.menu = () => { throw new Error('late focus refusal'); };
  });
  assert.throws(g.run, /late focus refusal/);
  assert.deepEqual(refused.map(event => event.stage), ['finder-window-retained']);
});

test('delayed creation polls the inventory without adopting the focused owner window', () => {
  const f = folderTrial((f, api, clock) => {
    api.fileMenu = () => { f.focused = f.foreign; };
    clock.wait = ms => { f.time += ms; f.current = [f.previous, f.foreign, f.window]; f.focused = f.window; };
  });
  assert.equal(f.run(), f.window);
  assert.equal(f.time, 100);
  assert.deepEqual(f.retained, [f.window]);
  assert.equal(f.navigations[0].window, f.window);
});

for (const [name, change, pattern] of [
  ['unknown baseline', (f) => { f.current = null; }, /inventory/],
  ['unknown identity', (_f, api) => { api.equal = () => false; }, /inventory/],
  ['duplicate baseline', f => { f.current.push(f.previous); }, /inventory/],
  ['stale previous', f => { f.current = [f.foreign]; }, /previous window/],
  ['window appears while New menu opens', (f, api) => { api.fileMenu = (_a, _t, validate) => { f.current.push(f.window); validate(); }; }, /before New/],
  ['unknown post-action inventory', (f, api) => { api.fileMenu = () => { f.current = undefined; }; }, /inventory/],
  ['multiple new windows', (f, api) => { api.fileMenu = () => { f.current.push(f.window, {}); }; }, /ambiguous/],
  ['vanished candidate', (f, api) => { api.exists = w => w !== f.window; }, /inventory/],
  ['owner window closes during creation', (f, api) => { api.fileMenu = () => { f.current = [f.foreign, f.window]; }; }, /pre-action/],
  ['foreign dialog before creation', f => { f.dialog = {}; }, /Foreign/],
]) test(`folder ownership refuses ${name} before retention or navigation`, () => {
  const f = folderTrial(change);
  assert.throws(f.run, pattern);
  assert.deepEqual(f.retained, []);
  assert.deepEqual(f.navigations, []);
});

for (const [name, change, pattern] of [
  ['new window has no focus', (f, api) => { const create = api.fileMenu; api.fileMenu = (...args) => { create(...args); f.focused = f.foreign; }; }, /lost focus/],
  ['missing focus', (f, api) => { const create = api.fileMenu; api.fileMenu = (...args) => { create(...args); f.focused = null; }; }, /lost focus/],
  ['focus switch while Go menu opens', (f, api) => { api.menu = (_a, _n, _t, validate, refuse) => {
    assert.equal(refuse, true); f.focused = f.foreign; validate(); f.commands.push('go');
  }; }, /lost focus/],
  ['vanished retained window', (f, api) => { api.menu = (_a, _n, _t, validate) => { f.current.pop(); validate(); }; }, /identity changed/],
  ['replacement candidate', (f, api) => { api.menu = (_a, _n, _t, validate) => { f.current[2] = {}; validate(); }; }, /identity changed/],
  ['extra candidate', (f, api) => { api.menu = (_a, _n, _t, validate) => { f.current.push({}); validate(); }; }, /identity changed/],
  ['foreign dialog while Go menu opens', (f, api) => { api.menu = (_a, _n, _t, validate) => { f.dialog = {}; validate(); }; }, /Foreign/],
  ['focus switch while sheet appears', (f, api) => { api.folderSheet = () => { f.focused = f.foreign; return f.sheet; }; }, /lost focus/],
  ['foreign sheet', (f, api) => { api.folderSheet = () => { f.dialog = {}; return f.sheet; }; }, /Foreign/],
]) test(`folder navigation refuses ${name} and keeps only the proven window`, () => {
  const f = folderTrial(change);
  assert.throws(f.run, pattern);
  assert.deepEqual(f.retained, [f.window]);
  assert.deepEqual(f.navigations, []);
});

function nativeFolderTrial(clockChanges = {}) {
  const s = source(), writes = [], presses = [], native = v => v;
  const field = { AXRole: 'AXTextField', AXChildren: [] }, button = { AXRole: 'AXButton', AXTitle: 'Go', AXChildren: [] };
  const window = { AXRole: 'AXWindow' }, sheet = { AXRole: 'AXSheet', AXParent: window, AXChildren: [field, button] };
  window.AXSheets = [sheet];
  const app = { AXWindows: [window], AXFocusedWindow: window, AXChildren: [] };
  Object.assign(native, {
    CFEqual: (a, b) => a === b,
    AXUIElementGetPid: (_window, ref) => { ref[0] = 42; return 0; },
    AXUIElementCreateApplication: () => app, AXUIElementSetMessagingTimeout() {},
    AXUIElementCopyAttributeValue: (el, name, output) => {
      const value = el[name];
      output[0] = Array.isArray(value) ? { count: value.length, objectAtIndex: i => value[i] } : value;
      return 0;
    },
    AXUIElementSetAttributeValue: (el, name, value) => { writes.push([el, name, value]); return 0; },
    AXUIElementPerformAction: (el, action) => { presses.push([el, action]); return 0; },
  });
  s.$ = native; s.Ref = () => []; s.ObjC.castRefToObject = v => v;
  const api = s.nativeAX({ setup: true, bundle: 'com.apple.finder' }, { check() {}, emit() {}, ...clockChanges });
  return { s, api, app, window, sheet, field, button, writes, presses, native };
}

test('native folder submission refuses a foreign sheet and writes only the owned path field', () => {
  const { api, window, sheet, field, button, writes, presses } = nativeFolderTrial();
  api.submitFolder(window, sheet, '/fixture/Collections-1');
  assert.deepEqual(writes, [[field, 'AXValue', '/fixture/Collections-1']]);
  assert.deepEqual(presses, [[button, 'AXPress']]);
  sheet.AXParent = { AXRole: 'AXWindow' };
  assert.throws(() => api.submitFolder(window, sheet, '/foreign'), /sheet identity changed/);
  assert.equal(writes.length, 1);
});

test('native Finder AXValue write failure retains its operation in the closed diagnostic', () => {
  const f = nativeFolderTrial();
  f.native.AXUIElementSetAttributeValue = () => -25203;
  assert.throws(() => f.api.submitFolder(f.window, f.sheet, '/fixture/target'), error => {
    assert.equal(error.message, 'Finder folder AXValue failed: -25203');
    assert.equal(error.code, -25203);
    assert.equal(error.attribute, 'AXValue');
    assert.deepEqual(JSON.parse(JSON.stringify(f.s.finderStaticFailure(error))),
      { failureReason: 'ax-write-failed', errorName: 'Error', errorCode: -25203 });
    return true;
  });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.presses, []);
});

for (const boundary of ['write', 'press']) test(`native folder ${boundary} revalidates baseline after its nested folder guard`, () => {
  const f = nativeFolderTrial(), area = { AXRole: 'AXWindow' };
  f.app.AXWindows.push(area);
  const ledger = { schema: 'finder-role-baseline-v1', baseline: [{ reference: area, role: 'AXWindow' }], created: [f.window] };
  let guards = 0;
  f.api.finderFolderGuard = () => { if (++guards === (boundary === 'write' ? 1 : 2)) area.AXRole = 'AXScrollArea'; };
  const validate = () => f.s.finderRoleInventory(f.app, f.api, ledger);
  assert.throws(() => f.api.submitFolder(f.window, f.sheet, '/fixture/target', validate), /baseline/);
  assert.equal(f.writes.length, boundary === 'write' ? 0 : 1);
  assert.deepEqual(f.presses, []);
});

test('native window inventory refuses a malformed AX array', () => {
  const { api, app, writes, presses } = nativeFolderTrial();
  for (const count of [undefined, null, NaN, -1, 1.5, Infinity]) {
    app.AXWindows = { count };
    assert.throws(() => api.windows(app), /inventory malformed/);
  }
  assert.deepEqual(writes, []);
  assert.deepEqual(presses, []);
});

test('native malformed inventory diagnostics include only a finite known count', () => {
  const { api, app } = nativeFolderTrial();
  for (const count of [undefined, null, NaN, -1, 1.5, Infinity, 'private-owner-title']) {
    app.AXWindows = { count };
    assert.throws(() => api.windows(app), error => {
      const known = count != null && Number.isFinite(Number(count));
      assert.equal(error.message, `Fixture window inventory malformed [reason=malformed-list${known ? ` count=${Number(count)}` : ''}]`);
      return true;
    });
  }
  app.AXWindows = null;
  assert.throws(() => api.windows(app), /inventory unavailable \[reason=malformed-list\]/);
});

test('native inventory reads the raw ObjC count once before validating or enumerating', () => {
  const { api, app, window } = nativeFolderTrial();
  for (const rawCount of [0, '1', { valueOf: () => 1 }, undefined, null, NaN, -1, 1.5, Infinity, 'private-owner-title']) {
    let reads = 0, enumerated = 0;
    app.AXWindows = {
      get count() { reads++; return rawCount; },
      objectAtIndex(index) { assert.equal(index, enumerated++); return window; },
    };
    const count = Number(rawCount);
    if (rawCount != null && Number.isFinite(count) && Number.isInteger(count) && count >= 0) {
      const windows = api.windows(app);
      assert.equal(windows.length, count);
      assert.ok(windows.every(value => value === window));
      assert.equal(enumerated, count);
    } else {
      assert.throws(() => api.windows(app), /inventory malformed/);
      assert.equal(enumerated, 0);
    }
    assert.equal(reads, 1);
  }
});

for (const role of ['AXSheet', 'AXDialog', '', 'private-owner-title']) test(`inventory refuses role ${JSON.stringify(role)} using only the existing role read`, () => {
  const { api: nativeApi, native } = nativeFolderTrial(), reads = [];
  const read = native.AXUIElementCopyAttributeValue;
  native.AXUIElementCopyAttributeValue = (el, name, output) => { reads.push(name); return read(el, name, output); };
  const f = folderTrial((f, api) => {
    f.previous.AXRole = 'AXWindow'; f.foreign.AXRole = role;
    api.exists = nativeApi.exists; api.finderRole = nativeApi.finderRole;
  });
  assert.throws(f.run, error => {
    const detail = /^AX[A-Za-z][A-Za-z0-9]*$/.test(role) ? ` role=${role}` : '';
    const roleState = !role ? 'empty' : role === 'AXSheet' || role === 'AXDialog' ? 'known-nonwindow' : 'other-string';
    const known = role === 'AXSheet' || role === 'AXDialog' ? ` roleKnown=${role}` : '';
    assert.equal(error.message, `Finder fixture window inventory unconfirmed [reason=non-window-or-stale count=2 index=1${detail} axCode=0 roleReadCode=0 roleState=${roleState}${known} roleNativeType=unavailable roleNativeWindowEqual=unavailable roleDeepWindowEqual=unavailable]`);
    return true;
  });
  assert.deepEqual(reads, ['AXRole', 'AXRole']);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.retained, []);
  assert.deepEqual(f.navigations, []);
});

test('inventory reports a stale element from the existing failed role read without retrying', () => {
  const { api: nativeApi, native } = nativeFolderTrial(), reads = [];
  const read = native.AXUIElementCopyAttributeValue;
  const f = folderTrial((f, api) => {
    f.previous.AXRole = 'AXWindow';
    api.exists = nativeApi.exists; api.finderRole = nativeApi.finderRole;
    native.AXUIElementCopyAttributeValue = (el, name, output) => {
      reads.push(name);
      return el === f.foreign ? -25202 : read(el, name, output);
    };
  });
  assert.throws(f.run, /reason=non-window-or-stale count=2 index=1 axCode=-25202/);
  assert.deepEqual(reads, ['AXRole', 'AXRole']);
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.retained, []);
  assert.deepEqual(f.navigations, []);
  assert.equal(f.time, 0);
});

for (const when of ['before-value', 'after-value']) test(`native submission stops a focus switch ${when}`, () => {
  const { api, app, window, sheet, native, writes, presses } = nativeFolderTrial();
  if (when === 'before-value') app.AXFocusedWindow = { AXRole: 'AXWindow' };
  else {
    const write = native.AXUIElementSetAttributeValue;
    native.AXUIElementSetAttributeValue = (...args) => { const result = write(...args); app.AXFocusedWindow = { AXRole: 'AXWindow' }; return result; };
  }
  assert.throws(() => api.submitFolder(window, sheet, '/fixture/Collections-review'), /lost focus/);
  assert.equal(writes.length, when === 'before-value' ? 0 : 1);
  assert.deepEqual(presses, []);
});

for (const location of ['AXWindows', 'AXChildren', 'AXSheets', 'window-children', 'focused-element']) test(`native guard refuses a foreign dialog in ${location}`, () => {
  const { api, app, window, sheet, writes, presses } = nativeFolderTrial();
  const foreign = { AXRole: 'AXWindow', AXSubrole: 'AXDialog' };
  if (location === 'AXSheets') app.AXWindows.push({ AXRole: 'AXWindow', AXSheets: [foreign] });
  else if (location === 'window-children') window.AXChildren = [foreign];
  else if (location === 'focused-element') app.AXFocusedUIElement = { AXRole: 'AXTextField', AXParent: foreign };
  else app[location].push(foreign);
  assert.throws(() => api.submitFolder(window, sheet, '/fixture/Collections-review'), /Foreign Finder/);
  assert.deepEqual(writes, []);
  assert.deepEqual(presses, []);
});

test('native submission refuses a foreign sheet appearing after the path write', () => {
  const { api, app, window, sheet, native, writes, presses } = nativeFolderTrial();
  const write = native.AXUIElementSetAttributeValue;
  native.AXUIElementSetAttributeValue = (...args) => {
    const result = write(...args);
    app.AXChildren.push({ AXRole: 'AXSheet' });
    return result;
  };
  assert.throws(() => api.submitFolder(window, sheet, '/fixture/Collections-review'), /Foreign Finder/);
  assert.equal(writes.length, 1);
  assert.deepEqual(presses, []);
});

test('native Go press rechecks focus after action bookkeeping', () => {
  let app;
  const f = nativeFolderTrial({ emit: () => { app.AXFocusedWindow = { AXRole: 'AXWindow' }; } });
  app = f.app;
  assert.throws(() => f.api.submitFolder(f.window, f.sheet, '/fixture/Collections-review'), /lost focus/);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.presses, []);
});

test('native Go menu rechecks focus after command bookkeeping and cancels only its menu', () => {
  let app, events = 0;
  const f = nativeFolderTrial({ emit: e => {
    if (e.stage === 'action' && ++events === 2) app.AXFocusedWindow = { AXRole: 'AXWindow' };
  } });
  app = f.app;
  const item = { AXRole: 'AXMenuItem', AXTitle: 'Go to Folder…', AXEnabled: 1 };
  const menu = { AXRole: 'AXMenu', AXChildren: [item] };
  const go = { AXRole: 'AXMenuBarItem', AXTitle: 'Go', AXChildren: [menu] };
  app.AXMenuBar = { AXChildren: [go] };
  let cancelled = 0;
  const press = f.native.AXUIElementPerformAction;
  f.native.AXUIElementPerformAction = (el, action) => {
    if (action === 'AXCancel') { assert.equal(el, menu); cancelled++; return 0; }
    assert.notEqual(el, item, 'the app-wide command must not act after focus changes');
    return press(el, action);
  };
  assert.throws(() => f.api.menu(app, 'Go', ['Go to Folder…'], () => f.api.finderFolderGuard(app, f.window, f.sheet), true), /lost focus/);
  assert.deepEqual(f.presses, [[go, 'AXPress']]);
  assert.equal(cancelled, 1);
  assert.deepEqual(f.writes, []);
});

for (const name of ['File', 'Go']) for (const attribute of ['AXMenuBar', 'AXChildren', 'AXTitle'])
  test(`Finder ${name} opening refuses baseline mutation during ${attribute} lookup without cancelling an unowned menu`, () => {
    const f = nativeFolderTrial(), area = { AXRole: 'AXWindow' };
    f.app.AXWindows.push(area);
    const ledger = { schema: 'finder-role-baseline-v1', baseline: [{ reference: area, role: 'AXWindow' }], created: [f.window] };
    const item = { AXRole: 'AXMenuItem', AXTitle: 'Command', AXEnabled: 1 }, menu = { AXRole: 'AXMenu', AXChildren: [item] };
    const top = { AXRole: 'AXMenuBarItem', AXTitle: name, AXChildren: [menu] };
    f.app.AXMenuBar = { AXChildren: [top] };
    let changed = false;
    const read = f.native.AXUIElementCopyAttributeValue, actions = [];
    f.native.AXUIElementCopyAttributeValue = (element, key, output) => {
      if (!changed && key === attribute) { changed = true; area.AXRole = 'AXScrollArea'; }
      return read(element, key, output);
    };
    f.native.AXUIElementPerformAction = (element, action) => { actions.push([element, action]); return 0; };
    const validate = () => f.s.finderRoleInventory(f.app, f.api, ledger);
    assert.throws(() => name === 'File' ? f.api.fileMenu(f.app, ['Command'], validate, true, true) :
      f.api.menu(f.app, name, ['Command'], validate, true, true), /baseline/);
    assert.equal(changed, true);
    assert.deepEqual(actions, [], 'neither AXPress nor AXCancel is authorized before the menu opening');
  });

test('Finder menu still cancels its observed menu after a later baseline refusal', () => {
  const f = nativeFolderTrial(), area = { AXRole: 'AXWindow' };
  f.app.AXWindows.push(area);
  const ledger = { schema: 'finder-role-baseline-v1', baseline: [{ reference: area, role: 'AXWindow' }], created: [f.window] };
  const item = { AXRole: 'AXMenuItem', AXTitle: 'Command', AXEnabled: 1 }, menu = { AXRole: 'AXMenu', AXChildren: [item] };
  const top = { AXRole: 'AXMenuBarItem', AXTitle: 'File', AXChildren: [menu] }, actions = [];
  f.app.AXMenuBar = { AXChildren: [top] };
  const read = f.native.AXUIElementCopyAttributeValue;
  f.native.AXUIElementCopyAttributeValue = (element, key, output) => {
    if (element === menu && key === 'AXChildren') area.AXRole = 'AXScrollArea';
    return read(element, key, output);
  };
  f.native.AXUIElementPerformAction = (element, action) => { actions.push([element, action]); return 0; };
  assert.throws(() => f.api.fileMenu(f.app, ['Command'], () => f.s.finderRoleInventory(f.app, f.api, ledger), true, true), /baseline/);
  assert.deepEqual(actions, [[top, 'AXPress'], [menu, 'AXCancel']]);
});

test('ordinary non-Finder menu retains command-only validation callback semantics', () => {
  const f = nativeFolderTrial(), item = { AXRole: 'AXMenuItem', AXTitle: 'Command', AXEnabled: 1 };
  const menu = { AXRole: 'AXMenu', AXChildren: [item] }, top = { AXRole: 'AXMenuBarItem', AXTitle: 'File', AXChildren: [menu] };
  f.app.AXMenuBar = { AXChildren: [top] };
  const api = f.s.nativeAX({ setup: true, bundle: 'com.apple.TextEdit' }, { check() {}, emit() {} });
  let validations = 0;
  api.fileMenu(f.app, ['Command'], () => { validations++; }, true);
  assert.equal(validations, 1);
  assert.deepEqual(f.presses, [[top, 'AXPress'], [item, 'AXPress']]);
});

test('Finder uncertain opening still attempts cleanup without cancelling an unobserved menu', () => {
  const f = nativeFolderTrial(), top = { AXRole: 'AXMenuBarItem', AXTitle: 'File', AXChildren: [] };
  f.app.AXMenuBar = { AXChildren: [top] };
  const actions = [];
  f.native.AXUIElementPerformAction = (element, action) => { actions.push([element, action]); return -25204; };
  assert.throws(() => f.api.fileMenu(f.app, ['Command'], () => {}, true, true), error => {
    assert.match(error.message, /press failed/);
    assert.match(error.menuCleanupError, /not an observed menu/);
    assert.deepEqual(JSON.parse(JSON.stringify(error.finderMenuCleanupFailure)),
      { failureReason: 'menu-cancel-target-unconfirmed', errorName: 'Error', errorCode: 'unavailable' });
    return true;
  });
  assert.deepEqual(actions, [[top, 'AXPress']]);
});

for (const when of ['before-attempt', 'uncertain-open', 'command-failure']) test(`tracked menu cleanup handles ${when} without guessing whether opening ran`, () => {
  const s = source(), file = {}, menu = {}, item = {}, cancelled = [];
  const api = { tracksOpeningAttempt: true,
    press(element, onAttempt) {
      if (element === file) {
        if (when === 'before-attempt') throw new Error('opening guard refused');
        if (onAttempt) onAttempt();
        if (when === 'uncertain-open') throw new Error('opening press uncertain');
      } else throw new Error('command refused');
    }, children: element => element === file ? [menu] : [item],
    text: (_element, key) => key === 'AXRole' ? 'AXMenu' : 'Command',
    cancel: element => cancelled.push(element),
  };
  assert.throws(() => s.chooseFileMenu(file, ['Command'], api), /refused|uncertain/);
  assert.deepEqual(cancelled, when === 'before-attempt' ? [] : [when === 'uncertain-open' ? file : menu]);
});

test('native guard accepts focus on the owned sheet and refuses a focus change during inspection', () => {
  const { api, app, window, sheet, native, writes, presses } = nativeFolderTrial();
  app.AXFocusedWindow = sheet;
  api.finderFolderGuard(app, window, sheet);
  const read = native.AXUIElementCopyAttributeValue;
  let focusReads = 0;
  native.AXUIElementCopyAttributeValue = (el, name, output) => {
    if (el === app && name === 'AXFocusedWindow' && ++focusReads === 2) app.AXFocusedWindow = { AXRole: 'AXWindow' };
    return read(el, name, output);
  };
  assert.throws(() => api.finderFolderGuard(app, window, sheet), /focus changed during validation/);
  assert.deepEqual(writes, []);
  assert.deepEqual(presses, []);
});

function finderRun(change = () => {}) {
  const s = source(), events = [], calls = []; let time = 0, forced = false, armed = false, ready = false, navigated = false;
  const old = { processIdentifier: 42, bundleIdentifier: 'com.apple.finder', launchDate: { timeIntervalSince1970: 1, isNil: () => false }, get isTerminated() { return forced; }, get forceTerminate() { calls.push('force'); forced = true; return true; } };
  const successor = { processIdentifier: 43, bundleIdentifier: 'com.apple.finder', launchDate: { timeIntervalSince1970: 2, isNil: () => false } };
  const previous = {}, window = {}, sheet = {}, native = value => ({ dataUsingEncoding: () => value });
  Object.assign(native, {
    AXIsProcessTrusted: () => true,
    NSRunningApplication: { runningApplicationWithProcessIdentifier: () => old, runningApplicationsWithBundleIdentifier: bundle => {
      assert.equal(bundle, 'com.apple.finder'); return { count: 1, objectAtIndex: () => forced ? successor : old };
    } },
    AXUIElementCreateApplication: pid => ({ pid }), AXUIElementSetMessagingTimeout() {},
    NSFileHandle: { fileHandleWithStandardOutput: { writeData: data => {
      const e = JSON.parse(data); events.push(e); if (e.stage === 'armed') armed = true; if (e.stage === 'ready') ready = true;
    } } },
    NSData: { dataWithContentsOfFile: () => ({ isNil: () => false }) },
    NSString: { alloc: { initWithDataEncoding: () => JSON.stringify({ command: ready ? 'close' : armed ? 'opened' : 'launching', launched: false }) } },
  });
  s.$ = native; s.Date = { now: () => time };
  s.finderProcessBirth = pid => pid === 42 ? '1.000000' : '2.000000';
  s.waitForLaunch = seconds => { time += (seconds ?? 0.1) * 1000; };
  s.probeFinderAX = () => { calls.push('probe'); time += 500; return forced ? 0 : -25204; };
  const api = {
    focused: app => { assert.equal(app.pid, 43, 'never read the hung process'); calls.push('focused'); return navigated ? window : previous; },
    dialog: () => [], fileMenu: () => { navigated = true; calls.push('new-window'); },
    menu: () => calls.push('go-menu'), folderSheet: () => sheet, submitFolder: () => calls.push('submit'),
    windows: () => navigated ? [previous, window] : [previous], exists: () => true, finderRole: () => 'AXWindow', finderFolderGuard() {},
    equal: (a, b) => a === b, readiness: () => ({}), matches: () => true, wait: () => { time += 100; },
  };
  s.nativeAX = () => api;
  s.closeOwnedWindow = (owned, _request, app) => { assert.equal(owned, window); assert.equal(app.pid, 43); calls.push('close'); };
  change({ s, api, previous, window, sheet, calls, old, successor });
  const run = () => s.run([JSON.stringify({ app: 'Finder', bundle: 'com.apple.finder', mode: 'folder', control: 'fake', target: '/fixture/Collections-1', token: 'Collections-1' })]);
  return { run, events, calls };
}

test('JXA Finder identity refusal exports only its closed reason before any probe or action', () => {
  const { run, events, calls } = finderRun(({ s }) => {
    s.finderProcessBirth = () => null;
    s.$.NSRunningApplication.runningApplicationsWithBundleIdentifier = () => ({ count: 1, objectAtIndex: () => ({
      processIdentifier: 42, bundleIdentifier: 'com.apple.finder', launchDate: null,
      get forceTerminate() { assert.fail('identity refusal cannot terminate Finder'); },
    }) });
  });
  assert.throws(run, error => {
    assert.equal(error.identityReason, 'start-unavailable');
    return true;
  });
  const failure = events.find(event => event.stage === 'setup-failure');
  assert.deepEqual(failure.finderAXError, { attribute: 'AXWindows', identityReason: 'start-unavailable' });
  assert.equal(failure.actionTaken, false);
  assert.equal(failure.cleanup, 'nothing created');
  assert.deepEqual(calls, []);
  assert.equal(events.some(event => ['identified', 'identified-process', 'ready', 'finder-relaunch'].includes(event.stage)), false);
});

test('JXA setup probes and recovers before any Finder read, then opens and closes one new window', () => {
  const { run, events, calls } = finderRun();
  run();
  assert.equal(events.filter(e => e.stage === 'finder-relaunch').length, 1);
  assert.equal(events.find(e => e.stage === 'ready').pid, 43);
  assert.deepEqual(calls.slice(0, 6), ['probe', 'probe', 'probe', 'force', 'probe', 'focused']);
  assert.equal(calls.filter(c => c === 'submit').length, 1);
  assert.equal(calls.at(-1), 'close');
});

test('JXA Finder cleanup exports closed failure objects before rethrowing a cleanup guard', () => {
  const { run, events } = finderRun(({ s }) => {
    s.closeOwnedWindow = () => { throw new Error('Finder fixture identity changed'); };
  });
  assert.throws(run, /fixture identity changed/);
  const failure = events.find(event => event.stage === 'finder-failure');
  assert.deepEqual(failure.finderFailure, { failureReason: 'fixture-identity-changed', errorName: 'Error', errorCode: 'unavailable' });
  assert.deepEqual(failure.finderCleanupFailure, failure.finderFailure);
});

test('JXA retains the candidate before first validation fails and closes only its fixture despite baseline drift', () => {
  let closed = false;
  const { run, events, calls } = finderRun(({ api, window, previous }) => {
    let drifted = false;
    const inventory = api.windows;
    api.windows = () => inventory().filter(w => !(drifted && w === previous) && !(closed && w === window));
    api.exists = w => w !== window || !closed;
    api.finderFolderGuard = (_app, w) => {
      if (w) { drifted = true; throw new Error('Finder folder window lost focus'); }
    };
    api.text = (w, attribute) => {
      assert.equal(w, window, 'never read owner window content for cleanup');
      return attribute === 'AXDocument' ? '/fixture/Collections-1' : '';
    };
    api.path = value => value;
    api.closeButton = (w, validate) => {
      assert.equal(w, window); validate(); closed = true; calls.push('recover-close');
    };
    api.emit = event => events.push(event);
  });
  assert.throws(run, /lost focus/);
  assert.equal(closed, true);
  assert.equal(calls.filter(call => call === 'recover-close').length, 1);
  assert.equal(calls.includes('go-menu'), false);
  const failure = events.find(event => event.stage === 'setup-failure');
  assert.equal(failure.cleanup, 'closed retained fixture');
  assert.equal(failure.finderFailure.failureReason, 'window-focus-lost');
  assert.equal(failure.finderCleanupFailure, undefined);
  const drift = events.find(event => event.stage === 'finder-baseline-changed');
  assert.equal(drift.finderBaselineChange.phase, 'cleanup');
  assert.equal(drift.finderBaselineChange.missingRole, 'AXWindow');
});

test('JXA Finder setup and cleanup work with kernel births when AppKit launch dates are absent', () => {
  const { run, events, calls } = finderRun(({ old, successor }) => {
    old.launchDate = null; successor.launchDate = null;
  });
  run();
  assert.equal(events.find(event => event.stage === 'finder-relaunch').finderRelaunch.pidBirth, '1.000000');
  assert.equal(events.find(event => event.stage === 'finder-recovered').finderRecovery.toPidBirth, '2.000000');
  assert.equal(events.some(event => event.stage === 'ready'), true);
  assert.equal(calls.filter(call => call === 'force').length, 1);
  assert.equal(calls.at(-1), 'close');
});

test('setup refusal after New Window keeps cleanup unconfirmed and never adopts or closes an owner window', () => {
  const { run, events, calls } = finderRun(({ api, previous, s }) => {
    api.fileMenu = () => {};
    api.windows = () => [previous];
    api.matches = () => assert.fail('no unowned match probe');
    s.closeOwnedWindow = () => assert.fail('no owner close');
  });
  assert.throws(run, /New Finder fixture window unconfirmed/);
  const failure = events.find(e => e.stage === 'setup-failure');
  assert.equal(failure.cleanup, 'unconfirmed');
  assert.equal(failure.actionTaken, false, 'even without an AX action receipt, a delayed creation stays uncertain');
  assert.deepEqual(failure.finderFailure, { failureReason: 'new-window-unconfirmed', errorName: 'Error', errorCode: 'unavailable' });
  assert.deepEqual(failure.finderCleanupFailure, { failureReason: 'retained-reference-unavailable', errorName: 'unavailable', errorCode: 'unavailable' });
  assert.equal(events.some(e => e.stage === 'ready'), false);
  assert.equal(calls.includes('go-menu'), false);
  assert.equal(calls.includes('submit'), false);
});

test('setup refusal before New Window can confirm nothing created', () => {
  const { run, events } = finderRun(({ api }) => {
    api.windows = () => { throw new Error('inventory unavailable'); };
    api.fileMenu = () => assert.fail('no creation after failed inventory');
  });
  assert.throws(run, /inventory unavailable/);
  assert.equal(events.find(e => e.stage === 'setup-failure').cleanup, 'nothing created');
});

test('setup refusal after retaining a new window leaves its unrelated folder and owner windows untouched', () => {
  const { run, events } = finderRun(({ api, window }) => {
    api.menu = () => { throw new Error('Finder folder window lost focus'); };
    api.matches = w => { assert.equal(w, window); return false; };
    api.closeButton = () => assert.fail('no close before folder identity is confirmed');
  });
  assert.throws(run, /lost focus/);
  assert.equal(events.find(e => e.stage === 'setup-failure').cleanup, 'unconfirmed');
});

test('Finder folder launch never calls open or a custom launcher with its folder', async t => {
  const { openFixture } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'fh1-open-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir, lockPath: join(dir, 'synthetic-lock') }, diagnostics = [], logs = [];
  const run = async (_cmd, _args, { onStdout }) => {
    onStdout('{"stage":"finder-relaunch","finderRelaunch":{"reason":"three AXWindows timeouts","pid":41}}\n');
    onStdout('{"stage":"armed","running":true,"pid":42}\n');
    onStdout('{"stage":"ready","pid":42}\n');
    return { groupClean: true, exit: { code: 0 }, stdout: '{"stage":"closed"}\n' };
  };
  const lease = await openFixture(ctx, { app: 'Finder', bundle: 'com.apple.finder', mode: 'folder', target: '/fixture/Collections-1' }, {
    run, helper: async () => ({ command: 'fake', args: [] }), log: line => logs.push(line),
    open: () => assert.fail('open delivers an Apple Event'), launch: () => assert.fail('custom launch must not deliver an Apple Event'),
  });
  diagnostics.push(lease.diagnostics);
  assert.equal(lease.launched, false);
  assert.equal(diagnostics[0].launched, false);
  assert.deepEqual(logs, ['FINDER_RELAUNCH: three AXWindows timeouts (pid 41)']);
});

const finder = { app: 'Finder', bundle: 'com.apple.finder', launched: false,
  finderAXError: { code: -25204, attribute: 'AXWindows' }, helperCollectionConfirmed: true, windowCleanupConfirmed: true, cleanup: 'nothing created' };
const infrastructure = { passed: false, fixtureSetupFailure: 'finder-ax', groupClean: true, fixtureDiagnostics: [finder] };

test('parent keeps an unconfirmed Finder creation as a cleanup stop after helper collection', async t => {
  const { openFixture, closeFixtures } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'fh1r-refusal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir, lockPath: join(dir, 'synthetic-lock') };
  let runs = 0;
  const run = async (_cmd, _args, { onStdout }) => {
    runs++;
    const stdout = '{"stage":"armed","running":true,"pid":42}\n' +
      '{"stage":"setup-failure","running":true,"pid":42,"actionTaken":true,"cleanup":"unconfirmed",' +
      '"finderAXError":{"code":-25204,"attribute":"AXWindows"}}\n';
    onStdout(stdout);
    return { groupClean: true, exit: { code: 1 }, stdout, stderr: 'New Finder fixture window unconfirmed' };
  };
  await assert.rejects(openFixture(ctx, { app: 'Finder', bundle: 'com.apple.finder', mode: 'folder', target: '/fixture/Collections-review' }, {
    run, helper: async () => ({ command: 'fake', args: [] }),
    open: () => assert.fail('no Apple Event'), launch: () => assert.fail('no launch fallback'),
  }), error => { assert.notEqual(error.noMutation, true); return true; });
  await assert.rejects(closeFixtures(ctx), /cleanup unconfirmed/);
  assert.notEqual(ctx.fixtureDiagnostics[0].windowCleanupConfirmed, true);
  assert.equal(finderSetupRetryable({ ...infrastructure,
    fixtureDiagnostics: ctx.fixtureDiagnostics.map(d => ({ ...d, helperCollectionConfirmed: true })) }), false);
  assert.equal(runs, 1, 'no Finder quit or new helper');
});

test('Finder setup failures are retryable only after every launched app and helper exited', () => {
  assert.equal(finderSetupRetryable(infrastructure), true);
  const quit = { app: 'TextEdit', launched: true, appQuit: true, helperCollectionConfirmed: true, windowCleanupConfirmed: true };
  assert.equal(finderSetupRetryable({ ...infrastructure, fixtureDiagnostics: [finder, quit] }), true);
  for (const change of [{ appQuit: false }, { helperCollectionConfirmed: false }, { launched: undefined }])
    assert.equal(finderSetupRetryable({ ...infrastructure, fixtureDiagnostics: [finder, { ...quit, ...change }] }), false);
  for (const key of ['cleanupError', 'cleanupUnconfirmed', 'permissionPrompt', 'permissionRefusal', 'observerError', 'appDialog', 'approvalStop', 'cancelled', 'liveLockKept'])
    assert.equal(finderSetupRetryable({ ...infrastructure, [key]: true }), false, key);
  for (const change of [{ groupClean: false }, { taskPassed: false }, { fixtureSetupFailure: undefined }, { exitDisagreements: [{}] },
    { fixtureDiagnostics: [{ ...finder, windowCleanupConfirmed: false }] }])
    assert.equal(finderSetupRetryable({ ...infrastructure, ...change }), false);
});

test('an independent exit disagreement blocks the lifecycle infrastructure marker', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fh1-disagreement-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir: join(dir, 'fixture'), lockPath: join(dir, 'synthetic-lock'), exitDisagreements: [{ pid: 5 }] };
  const result = await executeRealTask({ setup(ctx) {
    ctx.fixtureDiagnostics = [finder];
    throw Object.assign(new Error('Finder AX failed'), { fixtureSetupFailure: 'finder-ax' });
  }, cleanup() {} }, ctx, { lockHeld: true });
  assert.equal(result.retryableInfrastructure, undefined);
});

test('lifecycle marks a pre-driver Finder AX failure only after collecting its helper', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fh1-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir: join(dir, 'fixture'), lockPath: join(dir, 'synthetic-lock') };
  const result = await executeRealTask({
    setup(ctx) {
      ctx.fixtureDiagnostics = [{ ...finder, helperCollectionConfirmed: false }];
      ctx.windowLeases = [{ dispose: async () => true, diagnostics: ctx.fixtureDiagnostics[0] }];
      throw Object.assign(new Error('Fixture setup failed: AX fixture read failed: -25204 (AXFocusedWindow)'), { fixtureSetupFailure: 'finder-ax' });
    }, cleanup() {}, prompt: () => assert.fail('no prompt after setup failure'),
  }, ctx, { lockHeld: true, drive: () => assert.fail('no driver after setup failure') });
  assert.equal(result.retryableInfrastructure, 'finder-ax');
  assert.equal(result.groupClean, true);
  assert.equal(result.passed, false);
});

test('the real 640-file world caller carries an AX setup refusal through acquisition and clean teardown', async t => {
  const { openFixture } = await import('../bench/real-fixture.mjs');
  const { ccHeldOutTasks } = await import('../bench/world/cc-held-out.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'fh1-world-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir: join(dir, 'fixture'), lockPath: join(dir, 'synthetic-lock'), nonce: 'fh1' };
  const failure = { stage: 'setup-failure', running: true, setupCase: 'already-running', actionTaken: false,
    cleanup: 'nothing created', finderAXError: { code: -25204, attribute: 'AXFocusedWindow' } };
  const task = ccHeldOutTasks((ctx, request) => openFixture(ctx, request, {
    helper: async () => ({ command: 'fake', args: [] }),
    run: async (_cmd, _args, { onStdout }) => {
      assert.equal(readdirSync(request.target).length, 640);
      const stdout = JSON.stringify(failure) + '\n'; onStdout(stdout);
      return { groupClean: true, exit: { code: 1 }, stdout, stderr: 'AX fixture read failed: -25204 (AXFocusedWindow) (-2700)' };
    }, open: () => assert.fail('no Finder Apple Events'),
  })).find(task => task.id === 'cc-list-native');
  const result = await executeRealTask(task, ctx, { lockHeld: true, drive: () => assert.fail('no model after fixture refusal') });
  assert.equal(ctx.pendingAcquisitions.size, 0);
  assert.equal(result.retryableInfrastructure, 'finder-ax');
  assert.match(result.reason, /-25204.*AXFocusedWindow/);
  assert.equal(result.fixtureDiagnostics[0].helperCollectionConfirmed, true);
});

// A4 review regressions. These use VM AX objects and fake children only.
for (const boundary of ['second-probe', 'window-wait', 'sheet-wait']) test(`R1 cancellation reaches active helper at ${boundary}`, async t => {
  const { openFixture } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'a4r-cancel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const abort = new AbortController(); let notified = false, destroyed = false;
  const ctx = { dir, lockPath: join(dir, 'synthetic-lock'), signal: abort.signal };
  await assert.rejects(openFixture(ctx, { app: 'Finder', bundle: 'com.apple.finder', mode: 'folder' }, {
    helper: async () => ({ command: 'fake', args: [] }),
    run: async (_cmd, args, options) => {
      const request = JSON.parse(args.at(-1));
      if (boundary !== 'second-probe') options.onStdout('{"stage":"armed","running":true}\n');
      await new Promise(resolve => setImmediate(resolve));
      abort.abort(new Error(boundary));
      try { const c = JSON.parse(readFileSync(request.control, 'utf8')); notified = c.cancelled === true; } catch {}
      destroyed = options.signal.aborted;
      const stdout = '{"stage":"setup-failure","cleanup":"nothing created"}\n';
      options.onStdout(stdout);
      return { stdout, groupClean: true, exit: { code: 1 } };
    }, open: () => assert.fail('no launch'),
  }));
  assert.equal(notified, true, 'cancellation must be visible before the helper takes another action');
  assert.equal(destroyed, false, 'retain the helper for exact-reference cleanup');
});

for (const boundary of ['probe', 'termination', 'window', 'sheet']) test(`R1 VM stops setup actions after cancellation during ${boundary}`, () => {
  let cancelled = false, probe = 0;
  if (boundary === 'probe' || boundary === 'termination') {
    const s = source(), app = { processIdentifier: 42, bundleIdentifier: 'com.apple.finder',
      launchDate: { isNil: () => false, timeIntervalSince1970: 1 },
      get forceTerminate() { assert.fail('no termination after cancellation'); } };
    let time = 0;
    assert.throws(() => s.ensureFinderAX({ application: () => app, birth: () => '1.000000', probe: () => {
      time += 500; if (++probe === (boundary === 'probe' ? 2 : 3)) cancelled = true; return -25204;
    } }, { now: () => time, wait: ms => { time += ms; }, emit() {}, check() { if (cancelled) throw new Error('cancelled'); } }), /cancelled/);
  } else {
    const f = folderTrial((f, api, clock) => {
      clock.check = () => { if (cancelled) throw new Error('cancelled'); };
      if (boundary === 'window') api.fileMenu = () => { cancelled = true; };
      else api.folderSheet = () => { cancelled = true; return f.sheet; };
    });
    assert.throws(f.run, /cancelled/);
    assert.deepEqual(f.navigations, []);
    assert.equal(f.commands.includes('go'), boundary === 'sheet');
  }
});

for (const extra of [false, true]) test(`R2 cleanup preserves baseline fixture-root windows (extra=${extra})`, () => {
  const s = source(), baseline = { AXDocument: '/fixture/old' }, owned = { AXDocument: '/fixture/current' },
    unknown = { AXDocument: '/fixture/extra' }, closed = [];
  let windows = [baseline, owned, ...(extra ? [unknown] : [])];
  const api = { windows: () => windows, equal: (a, b) => a === b, finderRole: () => 'AXWindow', dialog: () => [],
    text: (w, key) => w[key], path: v => v, wait() {},
    closeButton: (w, guard) => { guard(); closed.push(w); windows = windows.filter(item => item !== w); } };
  const request = { fixtureRoot: '/fixture', target: '/fixture/current', finderOwnership: {
    schema: 'finder-role-baseline-v1', baseline: [{ reference: baseline, role: 'AXWindow' }], created: [owned] } };
  s.closeFinderFixtureWindows(owned, request, {}, api);
  assert.ok(windows.includes(baseline));
  assert.ok(!closed.includes(baseline));
  if (extra) assert.ok(windows.includes(unknown));
  assert.deepEqual(closed, [owned]);
});

test('R2 path alone never authorizes Finder cleanup', () => {
  const s = source(), owned = { AXDocument: '/fixture/current' };
  assert.throws(() => s.closeFinderFixtureWindows(owned, { target: '/fixture/current' }, {}, {
    windows: () => [owned], equal: (a, b) => a === b, text: (w, k) => w[k], path: v => v,
    closeButton: () => assert.fail('no creation receipt'), dialog: () => [],
  }), /ownership unconfirmed/);
});

for (const kind of ['delayed-creation', 'retained-window', 'helper-collection']) for (const lockHeld of [false, true])
  test(`R3 ${kind} retains actual ${lockHeld ? 'outer' : 'task'} owning lock`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'a4r-release-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const ctx = { dir, lockPath: join(dir, 'synthetic-lock') }; let releases = 0;
    const release = async () => { releases++; };
    const task = { setup() {
      ctx.windowLeases = [{ diagnostics: { bundle: 'com.apple.finder', launched: false,
        cleanup: 'unconfirmed', windowCleanupConfirmed: false }, dispose: async () => kind !== 'helper-collection' }];
      ctx.fixtureDiagnostics = ctx.windowLeases.map(l => l.diagnostics);
      if (kind === 'delayed-creation') { ctx.pendingAcquisitions = new Set(['finder']); throw new Error('delayed creation'); }
    }, prompt: () => 'offline', cleanup() { throw new Error('Owned Finder fixture window cleanup unconfirmed'); } };
    const result = await executeRealTask(task, ctx, { lockHeld, lock: async () => release, setupOnly: true });
    if (lockHeld) {
      assert.equal(typeof lifecycle.releaseFixtureLock, 'function');
      assert.equal(await lifecycle.releaseFixtureLock([ctx], release), false);
    }
    assert.equal(releases, 0);
    assert.equal(ctx.fixtureLockUnconfirmed, true);
    assert.ok(result.liveLockKept);
  });

test('R3 outer runner uses the shared fail-closed release boundary', () => {
  const text = readFileSync(new URL('../bench/run.mjs', import.meta.url), 'utf8');
  assert.match(text, /releaseFixtureLock\(realContexts, unlock\)/);
});

for (const when of ['second-probe', 'last-probe', 'before-force', 'missing-start', 'original-alive'])
  test(`R5 recovery refuses changed or unproved process incarnation: ${when}`, () => {
    const s = source(); let time = 0, probes = 0, lookups = 0, forced = 0;
    const date = value => ({ isNil: () => false, timeIntervalSince1970: value });
    const old = { processIdentifier: 42, bundleIdentifier: 'com.apple.finder', launchDate: date(1), pidBirth: '1.000000', isTerminated: false,
      get forceTerminate() { forced++; return true; } };
    const replacement = { processIdentifier: when === 'original-alive' ? 43 : 42, bundleIdentifier: 'com.apple.finder', launchDate: date(2), pidBirth: '2.000000', get forceTerminate() { forced++; return true; } };
    if (when === 'missing-start') old.pidBirth = null;
    let current = old;
    const api = { application: () => {
      lookups++;
      if ((when === 'before-force' && lookups >= 4) || (when === 'second-probe' && probes >= 1) ||
          (when === 'last-probe' && probes >= 3) || (when === 'original-alive' && forced)) current = replacement;
      return current;
    }, birth: () => current.pidBirth, probe: () => { time += 500; probes++; return forced ? 0 : -25204; }, exited: () => false };
    assert.throws(() => s.ensureFinderAX(api, { now: () => time, check() {}, wait: ms => { time += ms; }, emit() {} }), /Finder AX/);
    assert.equal(forced, when === 'original-alive' ? 1 : 0);
  });

for (const boundary of ['probe', 'window', 'sheet']) test(`R1 JXA control cancellation stops setup during ${boundary}`, () => {
  let cancelled = false, probes = 0;
  const { run, calls, events } = finderRun(({ s, api }) => {
    const control = s.$.NSString.alloc.initWithDataEncoding;
    s.$.NSString.alloc.initWithDataEncoding = () => JSON.stringify({ ...JSON.parse(control()), cancelled });
    if (boundary === 'probe') {
      const probe = s.probeFinderAX;
      s.probeFinderAX = (...args) => { const code = probe(...args); if (++probes === 2) cancelled = true; return code; };
    } else if (boundary === 'window') api.fileMenu = () => { calls.push('new-window'); cancelled = true; };
    else api.folderSheet = () => { cancelled = true; return null; };
  });
  assert.throws(run, /opening interrupted/);
  assert.equal(calls.includes('submit'), false);
  if (boundary === 'probe') assert.equal(calls.includes('force'), false);
  if (boundary === 'window') assert.equal(calls.includes('go-menu'), false);
  assert.equal(events.some(e => e.stage === 'ready'), false);
});

test('R1 native press checks cancellation after action bookkeeping', () => {
  let cancelled = false;
  const f = nativeFolderTrial({ check() { if (cancelled) throw new Error('cancelled'); },
    emit(event) { if (event.stage === 'action') cancelled = true; } });
  assert.throws(() => f.api.submitFolder(f.window, f.sheet, '/fixture/target'), /cancelled/);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(f.presses, [], 'no Go press after cancellation was observed');
});

test('R2 successful setup carries exact creation and baseline identities into cleanup', () => {
  const s = source(), baseline = { AXDocument: '/fixture/old' }, owned = { AXDocument: '/fixture/new' }, sheet = {};
  const request = { target: '/fixture/new', fixtureRoot: '/fixture' };
  let windows = [baseline]; const closed = [];
  const api = { windows: () => windows, equal: (a, b) => a === b, exists: () => true, finderRole: () => 'AXWindow', finderFolderGuard() {},
    fileMenu: (_a, _t, validate) => { validate(); windows.push(owned); },
    menu: (_a, _n, _t, validate) => validate(), folderSheet: () => sheet, submitFolder() {},
    dialog: () => [], text: (w, key) => w[key], path: v => v,
    closeButton: (w, validate) => { validate(); closed.push(w); windows = windows.filter(item => item !== w); }, wait() {} };
  s.openFinderFolder(request, {}, baseline, api, { check() {}, now: () => 0 }, () => {});
  s.closeFinderFixtureWindows(owned, request, {}, api);
  assert.deepEqual(closed, [owned]);
  assert.deepEqual(windows, [baseline]);
});

test('R4 Finder menu diagnostics emit only fixed requested commands and numeric status', () => {
  const s = source(), seen = [];
  const safe = s.finderMenuDiagnostics([
    { title: 'Compress OWNER-SECRET-FILENAME', enabled: true },
    { title: 'New Finder Window', enabled: true }, { title: 'Go to Folder…', enabled: false },
  ], { text: item => item.title, enabled: item => { seen.push(item.title); return item.enabled; } });
  assert.equal(JSON.stringify(safe), '[{"command":"new-window","enabled":1},{"command":"go-to-folder","enabled":0}]');
  assert.deepEqual(seen, ['New Finder Window', 'Go to Folder…']);
});

for (const boundary of ['receipt', 'final-check']) test(`R5 replacement immediately before force at ${boundary} refuses termination`, () => {
  const s = source(); let time = 0, replaced = false, announced = false, checks = 0, forces = 0;
  const old = { processIdentifier: 42, bundleIdentifier: 'com.apple.finder', pidBirth: '1.000000',
    get isTerminated() { return replaced; }, get forceTerminate() { forces++; return true; } };
  const replacement = { processIdentifier: 42, bundleIdentifier: 'com.apple.finder', pidBirth: '2.000000',
    get forceTerminate() { forces++; return true; } };
  assert.throws(() => s.ensureFinderAX({ application: () => replaced ? replacement : old, birth: () => (replaced ? replacement : old).pidBirth,
    probe: () => { time += 500; return -25204; } }, {
    now: () => time, wait: ms => { time += ms; },
    emit() { announced = true; if (boundary === 'receipt') replaced = true; },
    check() { if (announced && ++checks === 1 && boundary === 'final-check') replaced = true; },
  }), /Finder AX.*process changed/);
  assert.equal(forces, 0);
});

test('R5 original exit requires both retained termination and independent PID lookup evidence', () => {
  const s = source(), original = { isTerminated: false }, receipt = { pid: 42, pidBirth: '1.000000' };
  let current = { isNil: () => true };
  s.finderProcessBirth = () => current.pidBirth;
  s.$ = { NSRunningApplication: { runningApplicationWithProcessIdentifier: () => current } };
  assert.equal(s.finderOriginalExited(original, receipt), false);
  original.isTerminated = true;
  assert.equal(s.finderOriginalExited(original, receipt), true);
  current = { pidBirth: '1.000000', isTerminated: false };
  assert.equal(s.finderOriginalExited(original, receipt), false);
  current.pidBirth = '1.000001';
  assert.equal(s.finderOriginalExited(original, receipt), true);
  current.pidBirth = null;
  assert.equal(s.finderOriginalExited(original, receipt), false);
});

test('R1 an already-aborted run never starts a helper or launch', async t => {
  const { openFixture } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'a4r-aborted-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const abort = new AbortController(); abort.abort(new Error('already stopped'));
  await assert.rejects(openFixture({ dir, lockPath: join(dir, 'synthetic-lock'), signal: abort.signal }, { bundle: 'com.apple.finder', mode: 'folder' }, {
    helper: () => assert.fail('no helper resolution after abort'), run: () => assert.fail('no helper after abort'),
    open: () => assert.fail('no launch after abort'),
  }), /already stopped/);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('R1 cancellation listener is removed after exact helper collection', async t => {
  const { openFixture } = await import('../bench/real-fixture.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'a4r-listener-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const abort = new AbortController();
  const lease = await openFixture({ dir, lockPath: join(dir, 'synthetic-lock'), signal: abort.signal }, { app: 'Finder', bundle: 'com.apple.finder', mode: 'folder' }, {
    helper: async () => ({ command: 'fake', args: [] }),
    run: async (_cmd, _args, { onStdout }) => {
      onStdout('{"stage":"armed"}\n{"stage":"ready"}\n');
      return { groupClean: true, exit: { code: 0 }, stdout: '{"stage":"closed"}\n' };
    },
  });
  assert.equal(await lease.dispose(), true);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('R5 identity lookup latency cannot turn an immediate AX error into timeout evidence', () => {
  const s = source(); let time = 0, forces = 0;
  const app = { processIdentifier: 42, bundleIdentifier: 'com.apple.finder', launchDate: { timeIntervalSince1970: 1 },
    get forceTerminate() { forces++; return false; } };
  assert.throws(() => s.ensureFinderAX({ application: () => { time += 500; return app; }, birth: () => '1.000000', probe: () => -25204 }, {
    check() {}, now: () => time, wait: ms => { time += ms; }, emit() {},
  }), /probe failed/);
  assert.equal(forces, 0);
});

test('R2 setup recovery leaves extra windows alone after the retained window disappears', () => {
  const s = source(), owned = {}, extra = {}, request = { bundle: 'com.apple.finder', mode: 'folder',
    finderOwnership: { schema: 'finder-role-baseline-v1', baseline: [], created: [owned] } };
  assert.equal(s.recoverSetup(owned, request, {
    exists: () => false, finderRole: () => 'AXWindow', windows: () => [extra], equal: (a, b) => a === b,
    closeButton: () => assert.fail('preserve an extra window without creation proof'),
  }, {}), 'closed retained fixture');
});

test('R3 default acquisition retains the exact synthetic task lock after Finder cleanup fails', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'a4r-synthetic-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir, lockPath: join(dir, 'synthetic-lock') };
  const diagnostic = { bundle: 'com.apple.finder', launched: false, cleanup: 'unconfirmed', windowCleanupConfirmed: false };
  const result = await executeRealTask({ setup() {
    assert.equal(existsSync(ctx.lockPath), true);
    ctx.windowLeases = [{ diagnostics: diagnostic, dispose: async () => true }];
    ctx.fixtureDiagnostics = [diagnostic];
  }, prompt: () => 'offline', cleanup() { throw new Error('Owned Finder fixture window cleanup unconfirmed'); } }, ctx, { setupOnly: true });
  assert.equal(existsSync(ctx.lockPath), true, 'the original acquired lock must survive collection and failed window cleanup');
  assert.equal(result.liveLockKept, ctx.lockPath);
  assert.equal(existsSync(dir), true);
});
