import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from './fixtures/finder-ax.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { openFixture } from '../bench/real-fixture.mjs';

function trial() {
  let sourceText = readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8');
  if (process.env.CHV2C_BROKEN === 'unrecorded') sourceText = sourceText.replace(
    'request.finderOwnership.windowNumber = createdNumber;', '/* broken: creation number omitted */');
  if (process.env.CHV2C_BROKEN === 'old-role') sourceText = sourceText.replace(
    "if (nativeRole.roleNativeType === 'cf-string' && nativeRole.roleNativeWindowEqual === 'yes') raw = 'AXWindow';",
    '/* broken: shallow role comparison only */');
  const f = fixture({ sourceText, measuredSheet: true });
  f.advance(1000); f.request.finderAdoption = true;
  f.clock.finderObservation = () => ({ schema: 'finder-sampler-witness/1', pid: 42,
    createdAtMs: f.request.finderOwnership.createdAtMs, observedFromMs: 900, sampledAtMs: f.clock.now(),
    windows: [{ id: 10, pid: 42, firstSeenAtMs: 900 }, { id: 71, pid: 42, firstSeenAtMs: 1050 }] });
  return f;
}

test('Finder accepts an exact native CFString role when JXA leaves it wrapped', () => {
  const f = trial(), value = { nativeRole: 'AXWindow', toString: () => 'wrapped role' };
  const read = f.native.AXUIElementCopyAttributeValue;
  f.native.AXUIElementCopyAttributeValue = (element, name, out) => {
    if (element === f.window && name === 'AXRole') { out[0] = value; return 0; }
    return read(element, name, out);
  };
  f.native.CFGetTypeID = item => item === value ? 7 : 8;
  f.native.CFStringGetTypeID = () => 7;
  const equal = f.native.CFEqual;
  f.native.CFEqual = (a, b) => a === value ? b === 'AXWindow' : equal(a, b);
  assert.equal(f.api.finderRole(f.window), 'AXWindow');
  assert.equal(f.api.exists(f.window), true);
  f.open(); assert.equal(f.recover(), 'closed retained fixture');
  assert.deepEqual(f.app.AXWindows, [f.owner]);
});

test('creation records the sampler number before the first post-command AX inventory', () => {
  const f = trial();
  f.setHook((element, name) => {
    if (element === f.window && name === 'AXRole') {
      assert.equal(f.request.finderOwnership.windowNumber, 71);
      assert.equal(f.request.finderOwnership.createdAtMs, 1000);
    }
  });
  f.open();
  assert.equal(f.request.finderOwnership.creationWitness.pid, 42);
  assert.ok(f.events.some(e => e.stage === 'finder-creation-recorded' && e.windowNumber === 71));
  assert.equal(f.recover(), 'closed retained fixture');
  assert.deepEqual(f.app.AXWindows, [f.owner]);
});

test('a failed first role read recovers only the number recorded at creation', () => {
  const f = trial(); let failed = false;
  f.setHook((element, name) => {
    if (!failed && element === f.window && name === 'AXRole') { failed = true; throw Error('injected AX role failure'); }
  });
  assert.throws(f.open, /injected AX role failure/);
  assert.equal(f.request.finderOwnership.windowNumber, 71);
  assert.equal(f.request.finderOwnership.created.length, 0);
  assert.equal(f.recover(), 'closed retained fixture');
  assert.deepEqual(f.app.AXWindows, [f.owner]);
  assert.equal(f.actions.filter(([el]) => el === f.window.AXCloseButton).length, 1);
});

for (const [name, change] of [
  ['missing witness', () => null],
  ['wrong PID', w => ({ ...w, pid: 43 })],
  ['missing baseline', w => ({ ...w, observedFromMs: 1000 })],
  ['pre-existing window', w => ({ ...w, windows: w.windows.map(v => ({ ...v, firstSeenAtMs: 900 })) })],
  ['duplicate number', w => ({ ...w, windows: [...w.windows, w.windows[1]] })],
  ['noninteger number', w => ({ ...w, windows: [{ ...w.windows[1], id: 71.5 }] })],
  ['future observation', w => ({ ...w, sampledAtMs: w.sampledAtMs + 1000 })],
]) test(`creation refuses ${name} without closing an unproved window`, () => {
  const f = trial(), observe = f.clock.finderObservation;
  f.clock.finderObservation = () => change(observe());
  assert.throws(f.open, /New Finder fixture window unconfirmed/);
  assert.equal(f.request.finderOwnership.windowNumber, undefined);
  assert.equal(f.recover(), 'unconfirmed');
  assert.deepEqual(f.app.AXWindows, [f.owner, f.window]);
});

test('two sampler additions never choose a window to close', () => {
  const f = trial(), observe = f.clock.finderObservation;
  f.clock.finderObservation = () => { const w = observe(); w.windows.push({ id: 72, pid: 42, firstSeenAtMs: 1050 }); return w; };
  assert.throws(f.open, /ambiguous/);
  assert.equal(f.recover(), 'unconfirmed');
  assert.deepEqual(f.app.AXWindows, [f.owner, f.window]);
});

test('a creation witness for another number cannot authorize the AX window', () => {
  const f = trial(), observe = f.clock.finderObservation;
  f.clock.finderObservation = () => { const w = observe(); w.windows[1].id = 72; return w; };
  assert.throws(f.open, /identity changed/);
  assert.equal(f.recover(), 'unconfirmed');
  assert.ok(f.app.AXWindows.includes(f.window));
});

test('the private control carries sampler evidence during creation before ready', async t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'fixture-creation-')));
  let request, stream, finish, observed = 0;
  const witness = { schema: 'finder-sampler-witness/1', pid: 42, createdAtMs: 1000 };
  const lease = await openFixture({ dir, finderObservation: value => {
    observed++; assert.deepEqual(value, { pid: 42, createdAtMs: 1000 }); return witness;
  } }, { app: 'Finder', bundle: 'com.apple.finder', mode: 'folder' }, {
    helper: async () => ({ command: 'fake', args: [] }),
    run: (_command, args, { onStdout }) => {
      request = JSON.parse(args.at(-1)); stream = onStdout;
      stream('{"stage":"identified-process","pid":42}\n{"stage":"armed"}\n');
      return new Promise(resolve => { finish = resolve; queueMicrotask(() => {
        stream('{"stage":"finder-creation-start","finderCreatedAtMs":1000}\n');
        assert.deepEqual(JSON.parse(readFileSync(request.control)).finderObservation, witness);
        stream('{"stage":"finder-creation-poll","finderCreatedAtMs":1000}\n');
        stream('{"stage":"finder-creation-recorded","finderCreatedAtMs":1000,"windowNumber":71}\n{"stage":"ready"}\n');
      }); });
    },
  });
  assert.equal(lease.diagnostics.createdWindowNumber, 71);
  assert.ok(observed >= 2);
  const closed = lease.close();
  stream('{"stage":"closed"}\n'); finish({ groupClean: true, exit: { code: 0 }, stdout: '{"stage":"closed"}\n' });
  await closed;
});
