import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Pure decisions of the select-all check and its fixture, tested without any app driving.
// The fixture loads in a sandbox exactly as tests/textedit-live-count.test.mjs does; the lib is
// imported dynamically so a missing or changed export fails its own test, not the whole file.
const fixturePath = new URL('../bench/small-fixes-textedit.js', import.meta.url);
function loadFixture(globals = {}) {
  const sandbox = { ObjC: { import() {}, unwrap: value => value }, ...globals };
  runInNewContext(readFileSync(fixturePath, 'utf8'), sandbox, { filename: fixturePath.href });
  return sandbox;
}
const lib = () => import('../bench/small-fixes-textedit-lib.mjs');

// Window collections shaped like the AX list bridges hand to JavaScript.
const list = items => ({ count: items.length, objectAtIndex: i => items[i] });
// A soft AX reader stub: values or null, throwing with AX error codes like the fixture's own
// reader. Elements answer from the table by id, or from their own properties for children.
const reader = table => (el, name) => {
  const entry = table[el.id]?.[name] ?? el[name];
  if (typeof entry === 'string' && /^-?\d+$/.test(entry)) throw new Error(name + ' failed: ' + entry);
  return entry ?? null;
};

test('lib plans a launch when no TextEdit runs', async () => {
  const { planForPreflight } = await lib();
  assert.deepEqual(planForPreflight({ running: false, foregroundTextEdit: false }), { launch: true });
});
test('lib attaches to the one already-running background TextEdit', async () => {
  const { planForPreflight } = await lib();
  assert.deepEqual(planForPreflight({ running: true, foregroundTextEdit: false }), { launch: false });
});
test('lib refuses a foreground TextEdit without activation', async () => {
  const { planForPreflight } = await lib();
  const plan = planForPreflight({ running: true, foregroundTextEdit: true });
  assert.equal(plan.launch, false);
  assert.match(plan.refuse, /foreground/);
  const none = planForPreflight({ running: false, foregroundTextEdit: true });
  assert.equal(none.launch, false);
  assert.match(none.refuse, /foreground/);
});
test('lib launches TextEdit in the background with persistence and open-panel defaults off', async () => {
  const { launchCommand } = await lib();
  const [command, argv] = launchCommand('/private/tmp/sleight-exact-X/exact.txt');
  assert.equal(command, '/usr/bin/open');
  assert.equal(argv[0], '-g');
  assert.deepEqual(argv.slice(1, 3), ['-b', 'com.apple.TextEdit']);
  assert.ok(argv.includes('/private/tmp/sleight-exact-X/exact.txt'));
  const args = argv.slice(argv.indexOf('--args') + 1);
  assert.deepEqual(args, ['-ApplePersistenceIgnoreState', 'YES', '-NSShowAppCentricOpenPanelInsteadOfUntitledFile', 'NO']);
});
test('lib retries launch races and busy reads, not refusals', async () => {
  const { isRetry } = await lib();
  assert.equal(isRetry('Retry: New TextEdit process not registered yet'), true);
  assert.equal(isRetry('AXWindows failed: -25204'), true);
  assert.equal(isRetry('Retry: Owned document not open yet'), true);
  assert.equal(isRetry('Owned window shows a dialog (child role AXSheet); no action will be sent'), false);
  assert.equal(isRetry('Expected one owned AX window'), false);
});
test('lib retains the lock only for an owned TextEdit instance not confirmed gone', async () => {
  const { shouldRetainLock } = await lib();
  assert.equal(shouldRetainLock({ ownedInstance: true, quitConfirmed: false }), true);
  assert.equal(shouldRetainLock({ ownedInstance: true, quitConfirmed: true }), false);
  // A failed document close in a pre-existing instance is reported, but nothing of this run's
  // is still running, so the lock releases and the chain behind it does not stall.
  assert.equal(shouldRetainLock({ ownedInstance: false, quitConfirmed: false }), false);
  assert.equal(shouldRetainLock({ ownedInstance: false, quitConfirmed: true }), false);
});

test('fixture names each dialog signal on one window', () => {
  const { dialogSignal } = loadFixture();
  assert.equal(dialogSignal('AXStandardWindow', false, ['AXScrollArea']), null);
  assert.equal(dialogSignal(null, null, ['AXScrollArea', 'AXGroup']), null);
  assert.match(dialogSignal('AXDialog', false, []), /AXDialog/);
  assert.match(dialogSignal('AXSystemDialog', false, []), /AXSystemDialog/);
  assert.match(dialogSignal('AXStandardWindow', true, []), /modal/);
  assert.match(dialogSignal('AXStandardWindow', false, ['AXScrollArea', 'AXSheet']), /AXSheet/);
  assert.match(dialogSignal('AXStandardWindow', false, ['AXDialog']), /AXDialog/);
});

test('fixture scans only the owned window, so another window never refuses the run', () => {
  const { firstOwnedDialogSignal } = loadFixture();
  const windows = list([{ id: 1 }, { id: 2 }]);
  const table = {
    1: { AXChildren: list([]), AXSubrole: 'AXStandardWindow', AXModal: false },
    // A real dialog elsewhere in the instance: recorded by the diagnostic, never a refusal here.
    2: { AXChildren: list([]), AXSubrole: 'AXDialog', AXModal: false },
  };
  assert.equal(firstOwnedDialogSignal(windows, reader(table), el => el.id === 1), null);
});

test('fixture still refuses dialog signals on the owned window', () => {
  const { firstOwnedDialogSignal } = loadFixture();
  const windows = list([{ id: 1 }]);
  const table = { 1: { AXChildren: list([{ AXRole: 'AXSheet' }]), AXSubrole: 'AXStandardWindow', AXModal: false } };
  assert.match(firstOwnedDialogSignal(windows, reader(table), () => true), /AXSheet/);
  const dialogTable = { 1: { AXChildren: list([]), AXSubrole: 'AXDialog', AXModal: false } };
  assert.match(firstOwnedDialogSignal(windows, reader(dialogTable), () => true), /AXDialog/);
  const modalTable = { 1: { AXChildren: list([]), AXSubrole: 'AXStandardWindow', AXModal: true } };
  assert.match(firstOwnedDialogSignal(windows, reader(modalTable), () => true), /modal/);
});

test('fixture treats unsupported dialog metadata as no dialog and busy metadata as retryable', () => {
  const { firstOwnedDialogSignal } = loadFixture();
  const windows = list([{ id: 1 }]);
  const unsupported = { 1: { AXChildren: list([]), AXSubrole: 'AXStandardWindow', AXModal: false } };
  // The reader already applies the soft classes: -25205 and -25212 read as null.
  unsupported[1].AXSubrole = null;
  assert.equal(firstOwnedDialogSignal(windows, reader(unsupported), () => true), null);
  const busy = { 1: { AXChildren: list([]), AXSubrole: 'AXStandardWindow', AXModal: false } };
  busy[1].AXSubrole = '-25204';
  assert.throws(() => firstOwnedDialogSignal(windows, reader(busy), () => true), /-25204/);
});

test('fixture refuses a dialog only when a second scan confirms it', () => {
  const { confirmedDialogSignal } = loadFixture({ delay: () => {} });
  const windows = list([{ id: 1 }]);
  const dirty = { 1: { AXChildren: list([{ AXRole: 'AXSheet' }]), AXSubrole: 'AXStandardWindow', AXModal: false } };
  const clean = { 1: { AXChildren: list([]), AXSubrole: 'AXStandardWindow', AXModal: false } };
  // A blink: the first scan sees a sheet, the second doesn't. That is a settling tree, the
  // shape every 2026-10-11 refusal had, not a dialog.
  const tables = [dirty, clean];
  let scan = 0, current;
  const readWindows = () => { current = reader(tables[Math.min(scan++, 1)]); return windows; };
  assert.equal(confirmedDialogSignal(readWindows, (el, name) => current(el, name), () => true), null);
  // Confirmed twice is a dialog and refuses.
  scan = 0;
  assert.match(confirmedDialogSignal(() => windows, reader(dirty), () => true), /AXSheet/);
  // A clean first scan returns without a second scan.
  let scansMade = 0;
  assert.equal(confirmedDialogSignal(() => { scansMade++; return windows; }, reader(clean), () => true), null);
  assert.equal(scansMade, 1);
});

test('fixture records title, subrole and identifier of every window on a refusal', () => {
  const { collectWindowRecords } = loadFixture();
  const windows = list([{ id: 1 }, { id: 2 }]);
  const table = {
    1: { AXTitle: 'exact.txt', AXSubrole: 'AXStandardWindow', AXIdentifier: 'doc-window', AXDocument: 'file:///private/tmp/sleight-exact-X/exact.txt', AXModal: false, AXChildren: list([{ AXRole: 'AXTextArea' }]) },
    2: { AXTitle: 'Open', AXSubrole: 'AXDialog', AXIdentifier: '-25205', AXModal: false, AXChildren: '-25204' },
  };
  const rows = collectWindowRecords(windows, (el, name) => {
    const entry = table[el.id]?.[name] ?? el[name];
    if (typeof entry === 'string' && /^-25/.test(entry)) return { ok: false, code: entry };
    return { ok: true, value: entry ?? null };
  });
  // The record object is built inside the fixture's VM realm; JSON makes it same-realm for deepEqual.
  assert.deepEqual(JSON.parse(JSON.stringify(rows[0])), { index: 0, title: 'exact.txt', subrole: 'AXStandardWindow', identifier: 'doc-window',
    document: 'file:///private/tmp/sleight-exact-X/exact.txt', modal: false, childrenError: null,
    childRoles: ['AXTextArea'] });
  assert.equal(rows[1].title, 'Open');
  assert.equal(rows[1].subrole, 'AXDialog');
  assert.equal(rows[1].identifier, null);
  assert.equal(rows[1].identifierError, '-25205');
  assert.equal(rows[1].childrenError, '-25204');
});
