import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/finder-ax.mjs';
import { finderDiagnostic } from '../bench/real-fixture.mjs';

test('a successful Finder transaction leaves time to observe navigation under bounded AX latency', t => {
  const f = fixture({ measuredSheet: true });
  let reads = 0, elapsed = 0, cleanup = false;
  f.setHook(() => { reads++; elapsed += 6; });
  f.clock.now = () => elapsed;
  f.clock.wait = ms => { elapsed += ms; };
  f.clock.beginCleanup = () => { cleanup = true; };
  f.clock.check = () => {
    if (!cleanup && elapsed >= 20000) throw new Error('Finder probe deadline reached');
  };
  const result = f.probe();
  assert.equal(result.passed, true, JSON.stringify({ result, reads, elapsed }));
  assert.ok(reads < 1700, `one transaction used ${reads} AX reads`);
  assert.deepEqual(f.app.AXWindows, [f.owner]);
  t.diagnostic(`AX reads: ${reads}; simulated total: ${elapsed} ms at 6 ms/read; live latency unmeasured`);
});

test('the overall deadline can fire after successful navigation but before its first observation', () => {
  const f = fixture({ measuredSheet: true }), emit = f.clock.emit;
  let elapsed = 0, cleanup = false;
  f.clock.now = () => elapsed;
  f.clock.check = () => { if (!cleanup && elapsed >= 20000) throw new Error('Finder probe deadline reached'); };
  f.clock.beginCleanup = () => { cleanup = true; };
  f.clock.emit = event => { emit(event); if (event.stage === 'finder-folder-submitted') elapsed = 20000; };
  const result = f.probe();
  assert.equal(result.failure.failureReason, 'probe-deadline');
  assert.equal(result.navigationConfirmed, undefined);
  assert.equal(f.window.AXDocument, '/fixture/target', 'navigation succeeded in the fake Finder');
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.snapshots.some(row => row.phase === 'after-navigation'), false);
  assert.deepEqual(f.app.AXWindows, [f.owner]);
});

for (const owners of [0, 1, 3]) test(`desktop reference churn never authorizes an action with ${owners} owner windows`, () => {
  const f = fixture({ measuredSheet: true });
  const baseline = Array.from({ length: owners }, () => ({ AXRole: 'AXWindow', AXSubrole: 'AXStandardWindow' }));
  let desktop = { AXRole: 'AXScrollArea' };
  f.app.AXWindows = [desktop, ...baseline];
  f.app.AXFocusedWindow = baseline[0] ?? null;
  const action = f.native.AXUIElementPerformAction;
  f.native.AXUIElementPerformAction = (element, name) => {
    assert.ok(!baseline.includes(element) && element !== desktop);
    const result = action(element, name);
    if (element === f.newItem) {
      const replacement = { AXRole: 'AXScrollArea' };
      f.app.AXWindows = f.app.AXWindows.map(w => w === desktop ? replacement : w);
      desktop = replacement;
    }
    return result;
  };
  f.setHook((element, name) => {
    if (baseline.includes(element)) assert.ok(!['AXTitle', 'AXDocument', 'AXURL', 'AXValue'].includes(name));
  });
  const result = f.probe();
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.deepEqual(f.app.AXWindows, [desktop, ...baseline]);
  assert.equal(result.snapshots[1].scrollAreasMatched, 1); // still before the command
  assert.equal(result.snapshots.find(row => row.phase === 'after-new').scrollAreasMatched, 0);
  assert.ok(result.snapshots.every(row => row.ownerWindowsEqual));
});

test('a successful AX write that leaves the path unchanged never submits', () => {
  const f = fixture({ measuredSheet: true });
  f.native.AXUIElementSetAttributeValue = () => 0;
  const result = f.probe();
  assert.equal(result.failure.failureReason, 'folder-path-unconfirmed');
  assert.equal(result.cleanupConfirmed, true);
  assert.ok(f.keys.every(([key]) => key === 53), 'only cancellation can post a key');
  assert.deepEqual(f.app.AXWindows, [f.owner]);
});

for (const boundary of ['event creation', 'final focus check']) test(`a path changed at ${boundary} cannot be submitted`, () => {
  const f = fixture({ measuredSheet: true });
  if (boundary === 'event creation') {
    const create = f.native.CGEventCreateKeyboardEvent;
    f.native.CGEventCreateKeyboardEvent = (...args) => {
      if (args[1] === 36) f.field.AXValue = '/owner/unrelated';
      return create(...args);
    };
  } else {
    let eventsCreated = false;
    const create = f.native.CGEventCreateKeyboardEvent;
    f.native.CGEventCreateKeyboardEvent = (...args) => {
      if (args[1] === 36) eventsCreated = true;
      return create(...args);
    };
    f.setHook((element, name) => {
      if (eventsCreated && element === f.app && name === 'AXFocusedUIElement' && f.field.AXValue)
        f.field.AXValue = '/owner/unrelated';
    });
  }
  const result = f.probe();
  assert.equal(result.failure.failureReason, 'folder-path-unconfirmed', JSON.stringify(result));
  assert.equal(result.cleanupConfirmed, true);
  assert.ok(f.keys.every(([key]) => key !== 36));
});

test('Return consumed by a suggestion without dismissal fails once and retains the cleanup boundary', () => {
  const f = fixture({ measuredSheet: true }), post = f.native.CGEventPostToPid;
  f.native.CGEventPostToPid = (pid, event) => {
    if (event.key === 36) { f.keys.push([event.key, event.down]); return; }
    post(pid, event);
  };
  const result = f.probe();
  assert.equal(result.failure.failureReason, 'folder-panel-submit-unconfirmed');
  assert.equal(result.cleanupConfirmed, false, 'unknown navigation cannot revive Recents cleanup');
  assert.equal(f.keys.filter(([key, down]) => key === 36 && down).length, 1);
  assert.equal(f.present(), false, 'only the owned panel is cancelled');
  assert.ok(f.app.AXWindows.includes(f.owner));
  assert.ok(f.app.AXWindows.includes(f.window));
});

test('sheet disappearance without navigation is classified and cannot close an unproved location', () => {
  const f = fixture({ measuredSheet: true }), post = f.native.CGEventPostToPid;
  const outcomes = [];
  f.clock.debugStep = (name, outcome) => { if (name === 'cleanup') outcomes.push(outcome); };
  f.native.CGEventPostToPid = (pid, event) => {
    if (event.key === 36) { f.keys.push([event.key, event.down]); if (event.down) f.dismiss(); return; }
    post(pid, event);
  };
  const result = f.probe();
  assert.equal(result.failure.failureReason, 'navigation-unconfirmed');
  assert.equal(result.cleanupConfirmed, false);
  assert.ok(f.app.AXWindows.includes(f.window));
  assert.deepEqual(outcomes, ['start', 'unconfirmed']);
});

test('delayed location metadata is observed without another Return or a second window', () => {
  const f = fixture({ measuredSheet: true }), post = f.native.CGEventPostToPid, wait = f.clock.wait;
  let waits = 0, submitted = false;
  f.native.CGEventPostToPid = (pid, event) => {
    post(pid, event);
    if (event.key === 36 && event.down) {
      submitted = true;
      delete f.window.AXDocument;
      f.window.AXTitle = 'Recents';
    }
  };
  f.clock.wait = ms => {
    wait(ms);
    if (submitted && ++waits === 3) { f.window.AXTitle = 'target'; f.window.AXDocument = '/fixture/target'; }
  };
  assert.equal(f.probe().passed, true);
  assert.equal(waits, 3);
  assert.equal(f.keys.filter(([key, down]) => key === 36 && down).length, 1);
  assert.equal(f.actions.filter(([target]) => target === f.newItem).length, 1);
});

for (const boundary of ['before Return', 'cleanup']) test(`a changed CG window number at ${boundary} forbids input or closing`, () => {
  const f = fixture({ measuredSheet: true });
  if (boundary === 'before Return') {
    const write = f.native.AXUIElementSetAttributeValue;
    f.native.AXUIElementSetAttributeValue = (...args) => { const result = write(...args); f.window.AXWindowNumber = 72; return result; };
  } else f.clock.beginCleanup = () => { f.window.AXWindowNumber = 72; };
  const result = f.probe();
  assert.equal(result.passed, false);
  assert.equal(result.cleanupConfirmed, false);
  if (boundary === 'before Return') assert.ok(f.keys.every(([key]) => key !== 36));
  assert.equal(f.actions.some(([target]) => target === f.window.AXCloseButton), false);
  assert.ok(f.app.AXWindows.includes(f.owner));
});

test('a retained window changing to the desktop role cannot be closed', () => {
  const f = fixture({ measuredSheet: true });
  f.clock.beginCleanup = () => { f.window.AXRole = 'AXScrollArea'; };
  const result = f.probe();
  assert.equal(result.passed, false);
  assert.equal(f.actions.some(([target]) => target === f.window.AXCloseButton), false);
});

test('debug steps contain timing and outcomes without altering receipts or events', () => {
  const f = fixture({ measuredSheet: true }), traces = [];
  let now = 0;
  f.clock.now = () => now;
  f.setHook(() => { now += 1; });
  f.clock.debugStep = (name, outcome, elapsedMs) => traces.push({ name, outcome, elapsedMs });
  const result = f.probe();
  assert.equal(result.passed, true);
  for (const name of ['baseline', 'new-window-command', 'new-window-retain', 'folder-panel-command', 'folder-panel-bind',
    'folder-path-write', 'folder-return', 'folder-submit', 'folder-dismiss', 'navigation', 'cleanup']) {
    const steps = traces.filter(row => row.name === name);
    assert.deepEqual(steps.map(row => row.outcome), ['start', 'ok']);
    assert.equal(steps[0].elapsedMs, 0);
    assert.ok(steps[1].elapsedMs > 0);
  }
  assert.doesNotMatch(JSON.stringify([result, f.events]), /elapsedMs|outcome|folder-path-write|folder-return/);
});

test('failed steps have a terminal outcome and a broken debug sink cannot affect cleanup', () => {
  const f = fixture({ measuredSheet: true, fail: 'write-error' }), traces = [];
  f.clock.debugStep = (name, outcome) => traces.push([name, outcome]);
  const result = f.probe();
  assert.equal(result.cleanupConfirmed, true);
  assert.ok(traces.some(([name, outcome]) => name === 'folder-path-write' && outcome === 'failed'));
  assert.ok(traces.some(([name, outcome]) => name === 'folder-submit' && outcome === 'failed'));
  assert.ok(traces.some(([name, outcome]) => name === 'cleanup' && outcome === 'ok'));
  const other = fixture({ measuredSheet: true });
  other.clock.debugStep = () => { throw new Error('stderr closed'); };
  assert.equal(other.probe().passed, true);
});

for (const [message, reason] of [
  ['Finder folder path value unconfirmed', 'folder-path-unconfirmed'],
  ['Finder fixture navigation unconfirmed', 'navigation-unconfirmed'],
  ['Finder probe deadline reached', 'probe-deadline'],
]) test(`the ${reason} failure survives the closed receipt filter`, () => {
  const f = fixture();
  const failure = f.source.finderStaticFailure(new Error(message));
  assert.deepEqual(finderDiagnostic({ finderFailure: failure }), {
    finderFailure: { failureReason: reason, errorName: 'Error', errorCode: 'unavailable' },
  });
});
