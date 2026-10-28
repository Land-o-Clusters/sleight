import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './fixtures/finder-ax.mjs';
import { finderDiagnostic, openFixture } from '../bench/real-fixture.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

function finderAX({ closeAt = 100, onCheck = () => {}, measuredSheet = false } = {}) {
  const f = fixture({ measuredPanel: !measuredSheet, measuredSheet, submitCloseAfterMs: closeAt });
  f.clock.check = () => { if (f.submittedAt !== null) onCheck(f); };
  f.run = f.open;
  return f;
}

function singleSubmit(f) {
  const menuItems = f.app.AXMenuBar.AXChildren;
  assert.deepEqual(f.actions, [[menuItems[0], 'AXPress'], [f.newItem, 'AXPress'],
    [menuItems[1], 'AXPress'], [f.goItem, 'AXPress']]);
  assert.deepEqual(f.keys, [[36, true], [36, false]]);
  assert.deepEqual(f.writes, [[f.field, 'AXValue', '/fixture/target']]);
}

for (const measuredSheet of [false, true]) for (const closeAt of [0, 100, 4900, 5000, 5100, 12300, 15000]) {
  test(`owned ${measuredSheet ? 'AXSheet' : 'macOS 27 AXWindow'} close at ${closeAt} ms records its measured deadline`, () => {
    const f = finderAX({ closeAt, measuredSheet });
    assert.equal(f.run(), f.window);
    assert.equal(f.clock.now(), closeAt);
    assert.deepEqual(JSON.parse(JSON.stringify(f.events.find(event => event.finderFolderWait))), { stage: 'finder-folder-dismiss', finderFolderWait: {
      reason: 'closed', elapsedMs: closeAt, deadlineMs: 5000, hardCapMs: 15000, late: closeAt > 5000,
    } });
    singleSubmit(f);
    if (!measuredSheet) {
      assert.equal(f.panel.AXRole, 'AXWindow');
      assert.equal(f.panel.AXWindow, f.panel);
      assert.equal(f.panel.AXParent, f.app);
      assert.equal(f.request.finderOwnership.folderPanel.reference, f.panel);
      assert.equal(f.request.finderOwnership.folderPanel.sheetGeometry, undefined);
    }
  });
}

test('owned sheet still present at the hard cap fails with a timing receipt and no input', () => {
  const f = finderAX({ closeAt: Infinity });
  assert.throws(f.run, /sheet still open after submission/);
  assert.equal(f.clock.now(), 15000);
  assert.equal(f.events.at(-1).finderFolderWait.reason, 'deadline');
  assert.equal(f.events.at(-1).finderFolderWait.elapsedMs, 15000);
  singleSubmit(f);
});

for (const at of [200, 5200]) for (const change of ['focus', 'parent', 'replacement', 'foreign-dialog', 'window', 'baseline', 'role', 'identifier']) {
  test(`${change} change at ${at} ms stops the wait without input`, () => {
    const f = finderAX({ closeAt: 12000, onCheck(f) {
      if (f.clock.now() < at) return;
      if (change === 'focus') f.app.AXFocusedWindow = f.owner;
      if (change === 'parent') f.panel.AXParent = f.owner;
      if (change === 'replacement') {
        const replacement = { ...f.panel };
        f.app.AXWindows = f.app.AXWindows.map(w => w === f.panel ? replacement : w);
        f.app.AXChildren = [replacement]; f.app.AXFocusedWindow = replacement;
      }
      if (change === 'foreign-dialog') f.owner.AXSheets = [{ AXRole: 'AXSheet', AXParent: f.owner }];
      if (change === 'window') f.app.AXWindows = [f.owner];
      if (change === 'baseline') f.app.AXWindows = f.app.AXWindows.filter(w => w !== f.owner);
      if (change === 'role') f.panel.AXRole = 'AXGroup';
      if (change === 'identifier') f.panel.AXIdentifier = 'ForeignPanel';
    } });
    assert.throws(f.run, /focus|identity|Foreign|inventory|vanished/);
    assert.equal(f.clock.now(), at);
    assert.equal(f.events.at(-1).finderFolderWait.reason, 'error');
    singleSubmit(f);
  });
}

test('cancellation during the recovery wait is immediate and measured', () => {
  const f = finderAX({ closeAt: 12000, onCheck(f) { if (f.clock.now() >= 5200) throw new Error('cancelled'); } });
  assert.throws(f.run, /cancelled/);
  assert.equal(f.clock.now(), 5200);
  assert.equal(f.events.at(-1).finderFolderWait.reason, 'error');
  singleSubmit(f);
});

test('timing receipt passes the Finder privacy filter without paths or titles', () => {
  const receipt = { reason: 'closed', elapsedMs: 6300, deadlineMs: 5000, hardCapMs: 15000, late: true };
  assert.deepEqual(finderDiagnostic({ stage: 'finder-folder-dismiss', finderFolderWait: {
    ...receipt, target: '/owner/private', title: 'owner title', reference: { id: 'private' },
  } }), { stage: 'finder-folder-dismiss', finderFolderWait: receipt });
});

test('folder setup submits once and recovers a twelve-second owned-sheet close', () => {
  const f = finderAX({ closeAt: 12000 });
  assert.equal(f.open(), f.window);
  assert.equal(f.clock.now(), 12000);
  singleSubmit(f);
  assert.equal(f.events.find(event => event.finderFolderWait).finderFolderWait.elapsedMs, 12000);
  assert.equal(f.events.at(-1).stage, 'finder-folder-submitted');
  assert.deepEqual(f.app.AXWindows, [f.owner, f.window]);
});

test('a close during the identity guard is revalidated without a second submit', () => {
  const f = finderAX({ closeAt: Infinity });
  const guard = f.api.finderFolderGuard;
  let raced = false;
  f.api.finderFolderGuard = function (...args) {
    if (!raced && f.submittedAt !== null && args[2]) { raced = true; f.dismiss(); }
    return guard.apply(this, args);
  };
  f.run();
  assert.equal(raced, true);
  assert.equal(f.events.find(event => event.finderFolderWait).finderFolderWait.reason, 'closed');
  singleSubmit(f);
});

test('a foreign dialog appearing as the owned sheet closes is refused', () => {
  const f = finderAX({ closeAt: 6200, onCheck(f) {
    if (f.clock.now() >= 6200) f.owner.AXSheets = [{ AXRole: 'AXSheet', AXParent: f.owner }];
  } });
  assert.throws(f.run, /Foreign Finder dialog/);
  assert.equal(f.events.at(-1).finderFolderWait.reason, 'error');
  assert.equal(f.clock.now(), 6200);
  singleSubmit(f);
});

test('an AX read error during recovery is reported without being treated as a close', () => {
  const f = finderAX({ closeAt: 12000 });
  const readPanel = f.api.finderPanelExists;
  const failure = Object.assign(new Error('AX read failed'), { code: -25204, attribute: 'AXSheets' });
  f.api.finderPanelExists = function (...args) {
    if (f.clock.now() >= 5300) throw failure;
    return readPanel.apply(this, args);
  };
  assert.throws(f.run, error => error === failure);
  assert.equal(f.events.at(-1).finderFolderWait.reason, 'error');
  assert.equal(f.clock.now(), 5300);
  singleSubmit(f);
});

test('the last polling delay is bounded by the remaining hard-cap budget', () => {
  let advanced = false;
  const f = finderAX({ closeAt: Infinity, onCheck(f) {
    if (!advanced && f.clock.now() >= 14900) { advanced = true; f.advance(27); }
  } });
  assert.throws(f.run, /sheet still open after submission/);
  assert.equal(f.clock.now(), 15000);
  assert.equal(f.waits.at(-1), 73);
  singleSubmit(f);
});

for (const failure of [false, true]) test(`timing survives helper collection on ${failure ? 'failed' : 'successful'} setup`, async t => {
  const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-finder-dismiss-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = { dir, lockPath: join(dir, 'synthetic-lock') };
  const timing = { reason: failure ? 'deadline' : 'closed', elapsedMs: failure ? 15000 : 6200,
    deadlineMs: 5000, hardCapMs: 15000, late: true };
  const operation = openFixture(ctx, { app: 'Finder', bundle: 'com.apple.finder', mode: 'folder' }, {
    helper: async () => ({ command: 'fake', args: [] }),
    open: () => assert.fail('offline helper must never launch Finder'),
    run: async (_command, _args, { onStdout }) => {
      const events = [{ stage: 'armed', running: true, pid: 42 },
        { stage: 'finder-folder-dismiss', finderFolderWait: { ...timing, title: 'private-title' } },
        ...(failure ? [{ stage: 'setup-failure', cleanup: 'unconfirmed',
          finderFailure: { failureReason: 'folder-panel-submit-unconfirmed' } }] : [{ stage: 'ready' }, { stage: 'closed' }])];
      const stdout = events.map(event => JSON.stringify(event)).join('\n') + '\n';
      onStdout(stdout);
      return { stdout, groupClean: true, exit: { code: failure ? 1 : 0 } };
    },
  });
  if (failure) await assert.rejects(operation, error => {
    assert.deepEqual(error.fixtureDiagnostics.finderFolderWait, timing);
    assert.equal(error.fixtureDiagnostics.finderFailure.failureReason, 'folder-panel-submit-unconfirmed');
    return true;
  });
  else { const lease = await operation; await lease.close(); assert.equal(await lease.dispose(), true); }
  assert.deepEqual(ctx.fixtureDiagnostics[0].finderFolderWait, timing);
  assert.doesNotMatch(JSON.stringify(ctx.fixtureDiagnostics), /private-title/);
});
