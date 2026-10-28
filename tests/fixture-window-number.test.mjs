import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const frame = { x: 10, y: 20, width: 400, height: 300 };
const bounds = { X: 10, Y: 20, Width: 400, Height: 300 };
const candidate = extra => ({ kCGWindowOwnerPID: 42, kCGWindowNumber: 71, kCGWindowLayer: 0,
  kCGWindowIsOnscreen: true, kCGWindowBounds: { ...bounds }, ...extra });

function fixture({ candidates = () => [candidate()], direct, debug = false, afterWait = () => {}, pollDuration = 0 } = {}) {
  const source = { ObjC: { import() {}, unwrap: v => v, deepUnwrap: v => v, castRefToObject: v => v }, Ref: () => [] };
  runInNewContext(readFileSync(new URL('../bench/real-fixture.js', import.meta.url), 'utf8'), source);
  const window = { AXRole: 'AXWindow', ...(direct === undefined ? {} : { AXWindowNumber: direct }) };
  const app = { AXWindows: [window] }, reads = [], diagnostics = [], events = [], waits = [];
  let time = 0, polls = 0;
  const native = value => value;
  Object.assign(native, {
    AXUIElementGetPid: (element, output) => { assert.equal(element, app); output[0] = 42; return 0; },
    AXUIElementCopyAttributeValue: (element, attribute, output) => {
      reads.push(attribute);
      assert.ok(['AXWindowNumber', 'AXWindows', 'AXRole'].includes(attribute), 'identity reads cannot read titles or paths');
      const value = element[attribute];
      output[0] = Array.isArray(value) ? { count: value.length, objectAtIndex: i => value[i] } : value;
      return value === undefined ? -25205 : 0;
    },
    CFEqual: (a, b) => a === b,
    CGWindowListCopyWindowInfo: () => { time += pollDuration; return candidates(++polls); },
  });
  source.$ = native;
  const clock = { check() {}, now: () => time, emit: event => events.push(event),
    wait: ms => { waits.push(ms); time += ms; afterWait(app, window); },
    ...(debug ? { debugFailure: (step, error) => source.finderProbeDebug(step, error, text => diagnostics.push(text)) } : {}),
  };
  const api = source.nativeAX({ setup: true }, clock);
  api.frame = element => { assert.equal(element, window); return { ...frame }; };
  return { app, window, api, reads, waits, events, diagnostics, polls: () => polls,
    resolve: () => api.windowNumber(window, app) };
}

test('missing AXWindowNumber resolves one onscreen bounds match without titles', () => {
  const f = fixture();
  assert.equal(f.resolve(), 71);
  assert.deepEqual(f.waits, []);
});

test('missing AXWindowNumber waits for a bounds match after two polls', () => {
  const f = fixture({ candidates: poll => poll <= 2 ? [] : [candidate()] });
  assert.equal(f.resolve(), 71);
  assert.deepEqual(f.waits, [100, 100]);
  assert.equal(f.polls(), 3);
});

for (const extra of [
  { kCGWindowLayer: 1 }, { kCGWindowLayer: -2147483623 }, { kCGWindowIsOnscreen: false },
  { kCGWindowIsOnscreen: undefined }, { kCGWindowOwnerPID: 43 },
]) test(`bounds matching excludes a second candidate ${JSON.stringify(extra)}`, () => {
  const f = fixture({ candidates: () => [candidate(), candidate({ kCGWindowNumber: 72, ...extra })] });
  assert.equal(f.resolve(), 71);
});

for (const [name, candidates] of [
  ['two onscreen layer-zero matches', () => [candidate(), candidate({ kCGWindowNumber: 72 })]],
  ['no matches', () => []],
]) test(`window number fails closed within one second for ${name}`, () => {
  const f = fixture({ candidates });
  assert.equal(f.resolve(), null);
  assert.equal(f.polls(), 11);
  assert.deepEqual(f.waits, Array(10).fill(100));
});

test('polling stops when the retained AX window is replaced with the same geometry and number', () => {
  const f = fixture({ candidates: poll => poll === 1 ? [] : [candidate()],
    afterWait: (app, window) => { app.AXWindows = [{ ...window }]; } });
  assert.equal(f.resolve(), null);
  assert.equal(f.polls(), 1, 'a replacement cannot supply the retained window identity');
});

test('polling rechecks AX equality after the successful CG read', () => {
  let f;
  f = fixture({ candidates: poll => {
    if (poll === 1) return [];
    f.app.AXWindows = [{ ...f.window }];
    return [candidate()];
  } });
  assert.equal(f.resolve(), null);
});

test('slow CG reads spend the same one-second polling budget', () => {
  const f = fixture({ candidates: () => [], pollDuration: 600 });
  assert.equal(f.resolve(), null);
  assert.equal(f.polls(), 2);
  assert.deepEqual(f.waits, [100]);
});

test('a cancellation during the poll wait propagates before another CG read', () => {
  const f = fixture({ candidates: () => [], afterWait: () => { throw new Error('cancelled'); } });
  assert.throws(f.resolve, /cancelled/);
  assert.equal(f.polls(), 1);
});

for (const direct of [undefined, 71]) for (const debug of [false, true])
  test(`unresolved window inputs use only debug stderr (AX number=${direct}, debug=${debug})`, () => {
    const raw = candidate({ kCGWindowLayer: 4, kCGWindowName: 'owner title /owner/private/path' });
    const f = fixture({ debug, direct, candidates: () => [raw] });
    assert.equal(f.resolve(), null);
    assert.deepEqual(f.events, [], 'raw inputs never enter receipt events');
    assert.equal(f.diagnostics.length, debug ? 1 : 0);
    if (debug) {
      const text = f.diagnostics[0];
      const inputs = JSON.parse(text.split('message: ')[1].split('\nstack:')[0]);
      assert.deepEqual(inputs, { axWindowNumberPresent: direct !== undefined, axFrame: frame, cgCandidateCount: 1,
        cgCandidates: [{ layer: 4, onscreen: true, bounds }], matchCount: 0 });
      assert.doesNotMatch(text, /owner title|owner\/private|kCGWindowName/);
    }
  });

test('an AXWindowNumber still requires an exact CG number and never falls back to matching bounds', () => {
  const f = fixture({ direct: 72 });
  assert.equal(f.resolve(), null);
});

test('a valid direct CG identity preserves offscreen retained-window recovery', () => {
  const f = fixture({ direct: 71, candidates: () => [candidate({ kCGWindowIsOnscreen: false })] });
  assert.equal(f.resolve(), 71);
});
