import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import * as live from '../bench/hand/stage-live.mjs';
import { behaviorChecks } from '../bench/hand/stage-cost.mjs';

const owned = { id: 5, pid: 9, alpha: 1, bounds: { x: 100, y: 200, width: 360, height: 300 } };
const unrelated = { id: 8, pid: 3, alpha: 1, bounds: { x: 700, y: 500, width: 100, height: 100 } };
const snapshot = { pid: 9, panelID: 5, pointerTarget: [280, 350], hostTimeMs: 1000 };
const verdict = result => behaviorChecks(result).find(c => c.name === 'pointer dodge or fade').verdict;
const dump = { pointer: [{ outcome: 'hidden', reason: 'pointer-covered', panelOnScreen: false, elapsedMs: 0 }], hides: [{ event: 'gone' }] };

// The fake replaces only the process and window server. The live collector and receipt builder run unchanged.
function fixture({ outcome = 'hidden', reason = outcome === 'move' ? 'pointer-near' : outcome === 'fade' ? null : 'pointer-covered',
  after, settled, crash = false, receiptPatch = {}, effectPatch = {}, receiptOverride, harnessHide = false,
  crashAtSettled = false, delayedMove = false, decisionMs = 4, helperMs = 0, durationMs = outcome === 'hidden' ? 0 : 200 } = {}) {
  let phase = 'before', time = 1000, alive = true;
  const order = [], waits = [];
  after ??= outcome === 'move' ? [{ ...owned, bounds: { ...owned.bounds, x: 220 } }] : outcome === 'fade' ? [owned] : [];
  settled ??= after;
  const session = { pid: 9, get alive() { return alive; }, async request(input) {
    order.push(input.bench);
    if (!alive) throw Error('fixture exited');
    if (input.bench === 'query') return { reply: 'query', pid: 9, hostTimeMs: time += 10 };
    if (input.bench === 'hide') { phase = 'after'; return { reply: 'hide', pid: 9, hideReason: 'pointer-covered' }; }
    assert.equal(input.bench, 'pointer'); assert.deepEqual(input.position, [280, 350]);
    assert.match(input.inputID, /^[a-f0-9]{32}$/);
    phase = 'after'; if (crash) alive = false;
    const receipt = receiptOverride ?? { reply: 'pointer', source: harnessHide ? 'harness-hide' : 'stage-pointer-input/1', pid: 9, panelID: 5,
      inputID: input.inputID, inputSeq: input.inputSeq, position: input.position, inputHostMs: time + 1, completedHostMs: time + 1 + decisionMs,
      effects: [{ outcome, reason, durationMs, ...(outcome === 'hidden' ? {} : {
        inputSeq: input.inputSeq, opacity: outcome === 'fade' ? 0.35 : 1, box: [124, 224, 312, 252],
      }), ...effectPatch }],
      ...receiptPatch };
    time += 1 + decisionMs;
    return receipt;
  } };
  const helper = async args => {
    assert.deepEqual(args, ['windows']); order.push('windows:' + phase);
    time += helperMs;
    return { windows: phase === 'before' ? [owned, unrelated] : phase === 'settled' ? settled : delayedMove ? [owned] : after };
  };
  const wait = async ms => { waits.push(ms); phase = 'settled'; if (crashAtSettled) alive = false; time += ms; };
  return { session, helper, wait, clock: () => time, order, waits, snapshot };
}

async function collect(options = {}, module = live) {
  const fake = fixture(options);
  return { fake, result: await module.collectLivePointerBehavior(dump, fake) };
}

test('live pointer hide requires its own input receipt between owned window samples', async () => {
  const { result, fake } = await collect();
  assert.equal(verdict(result), 'pass');
  assert.equal(result.pointer.length, 1);
  assert.equal(result.pointer[0].panelOnScreen, false);
  assert.equal(result.pointer[0].reason, 'pointer-covered');
  assert.equal(result.pointer[0].elapsedMs, 4);
  assert.equal(result.pointer[0].evidence.before.alive, true);
  assert.equal(result.pointer[0].evidence.after.alive, true);
  assert.deepEqual(result.hides, dump.hides);
  assert.deepEqual(fake.order, ['windows:before', 'query', 'pointer', 'windows:after', 'query']);
  assert.equal(dump.pointer[0].elapsedMs, 0, 'dump remains separate evidence');
});

test('harness hide and dump-process receipts cannot qualify live pointer rows', async () => {
  for (const options of [{ harnessHide: true }, { receiptOverride: dump.pointer[0] },
    { reason: 'paused' }, { receiptPatch: { pid: 4 } }, { receiptPatch: { panelID: 6 } },
    { receiptPatch: { inputID: 'b'.repeat(32) } }, { receiptPatch: { position: [0, 0] } },
    { receiptPatch: { inputSeq: 2 } }, { receiptPatch: { inputSeq: undefined } },
    { receiptPatch: { inputHostMs: 500, completedHostMs: 501 } }]) {
    const { result } = await collect(options);
    assert.equal(result.pointer[0].panelOnScreen, 'unmeasured', JSON.stringify(options));
    assert.equal(verdict(result), 'fail');
  }
  const fake = fixture();
  const samples = await live.readLivePointerSamples({ ...fake, input: { bench: 'pointer', inputID: 'a'.repeat(32), position: [280, 350] },
    between: async () => dump.pointer[0] });
  const result = live.livePointerBehavior(dump, samples);
  assert.equal(result.pointer[0].panelOnScreen, 'unmeasured');
  assert.equal(verdict(result), 'fail');
});

test('a crashed fixture is unmeasured even when its panel disappeared', async () => {
  const { result } = await collect({ crash: true });
  assert.equal(result.pointer[0].panelOnScreen, 'unmeasured');
  assert.equal(verdict(result), 'fail');
});

test('move rows require changed owned bounds and use the measured distance', async () => {
  const moved = await collect({ outcome: 'move' });
  assert.equal(verdict(moved.result), 'pass');
  assert.equal(moved.result.pointer[0].distancePt, 120);
  assert.equal(moved.result.pointer[0].panelOnScreen, true);
  for (const after of [[owned], [], [{ ...owned, bounds: { ...owned.bounds, x: 219 } }]]) {
    const { result } = await collect({ outcome: 'move', after });
    assert.equal(verdict(result), 'fail');
    if (after[0]?.bounds.x !== 219) assert.equal(result.pointer[0].panelOnScreen, 'unmeasured');
  }
});

test('a production draw fade with null reason and a listed panel cannot qualify the pointer bar', async () => {
  const faded = await collect({ outcome: 'fade', durationMs: 350 });
  const row = faded.result.pointer[0], effect = row.evidence.receipt.effects[0];
  assert.equal(effect.reason, null); assert.equal(effect.opacity, 0.35);
  assert.equal(effect.durationMs, 350);
  assert.deepEqual(Object.keys(effect).sort(), ['box', 'durationMs', 'inputSeq', 'opacity', 'outcome', 'reason']);
  assert.deepEqual(effect.box, [124, 224, 312, 252]);
  assert.equal(row.evidence.after.windows[0].id, owned.id);
  assert.equal(row.panelOnScreen, 'unmeasured');
  assert.match(row.notApplicable, /null reason/);
  assert.equal(verdict(faded.result), 'fail');
  assert.deepEqual(faded.fake.waits, []);
  const invented = await collect({ outcome: 'fade', reason: 'pointer-covered', after: [] });
  assert.equal(verdict(invented.result), 'fail', 'invented fade-hide receipt cannot pass either');
});

test('a 200 ms production dodge measures the immediate decision and confirms the same origin later', async () => {
  const { result, fake } = await collect({ outcome: 'move' });
  const row = result.pointer[0];
  assert.equal(verdict(result), 'pass'); assert.equal(row.elapsedMs, 4);
  assert.equal(row.reason, 'pointer-near'); assert.equal(row.inputSeq, 1);
  assert.deepEqual(fake.waits, [200]);
  assert.deepEqual(fake.order, ['windows:before', 'query', 'pointer', 'windows:after', 'query', 'windows:settled', 'query']);
  assert.equal(row.evidence.after.windows[0].bounds.x, 220);
  assert.equal(row.evidence.settled.windows[0].bounds.x, 220);
  for (const options of [{ delayedMove: true }, { settled: [owned] }, { settled: [] }, { crashAtSettled: true },
    { reason: null }, { reason: 'window-change' }, { effectPatch: { inputSeq: undefined } }, { effectPatch: { inputSeq: 2 } }]) {
    const broken = await collect({ outcome: 'move', ...options });
    assert.equal(verdict(broken.result), 'fail', JSON.stringify(options));
    assert.equal(broken.result.pointer[0].panelOnScreen, 'unmeasured');
  }
});

test('hidden decision latency excludes helper query cost and retains the measured query time', async () => {
  const { result } = await collect({ helperMs: 275 });
  const row = result.pointer[0];
  assert.equal(row.elapsedMs, 4); assert.equal(row.windowQueryMs, 275);
  assert.equal(row.evidence.after.windowQueryMs, 275); assert.equal(verdict(result), 'pass');
  assert.equal(200 - row.elapsedMs, 196, 'headroom is host decision time only');
  for (const outcome of ['hidden', 'move']) {
    const slow = await collect({ outcome, decisionMs: 201 });
    assert.equal(slow.result.pointer[0].elapsedMs, 201);
    assert.equal(verdict(slow.result), 'fail');
  }
});

test('missing between is a protocol error instead of three unchanged reads', async () => {
  const fake = fixture();
  await assert.rejects(live.readLivePointerSamples(fake), /between/);
  assert.deepEqual(fake.order, []);
});

test('ambiguous ownership, missing before panels and read failures stay unmeasured', async () => {
  for (const before of [[], [owned, owned], [{ ...owned, pid: 4 }], null]) {
    const fake = fixture(), read = fake.helper; let calls = 0;
    fake.helper = args => ++calls === 1 ? { windows: before } : read(args);
    const result = await live.collectLivePointerBehavior(dump, fake);
    assert.equal(result.pointer[0].panelOnScreen, 'unmeasured');
    assert.equal(verdict(result), 'fail');
  }
  const fake = fixture(); fake.helper = async () => { throw Error('window server unavailable'); };
  const result = await live.collectLivePointerBehavior(dump, fake);
  assert.equal(result.pointer[0].panelOnScreen, 'unmeasured');
  assert.equal(verdict(result), 'fail');
});

async function mutated(t, transform) {
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'int23m-mutant-'))));
  const url = new URL('../bench/hand/stage-live.mjs', import.meta.url), original = readFileSync(url, 'utf8');
  let source = transform(original); assert.notEqual(source, original, 'mutation site must exist');
  source = source.replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g,
    (_, prefix, quote, path) => prefix + quote + new URL(path, url).href + quote);
  const file = join(root, 'stage-live.mjs'); writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}

test('executed broken variants reject end-of-animation timing and a late-only bounds change', async t => {
  const endTiming = await mutated(t, text => text.replace('elapsedMs: receipt.completedHostMs - receipt.inputHostMs',
    'elapsedMs: (samples.settled ?? samples.after).hostTimeMs - receipt.inputHostMs'));
  assert.equal(verdict((await collect({ outcome: 'move' }, endTiming)).result), 'fail');
  const waited = await mutated(t, text => text.replace('samples.after = await read();',
    "if (effect?.outcome === 'move') await wait(effect.durationMs);\n  samples.after = await read();"));
  assert.equal(verdict((await collect({ outcome: 'move', delayedMove: true })).result), 'fail');
  assert.equal(verdict((await collect({ outcome: 'move', delayedMove: true }, waited)).result), 'pass',
    'waiting before the first bounds sample hides a delayed move');
  const observerTiming = await mutated(t, text => text.replace('elapsedMs: receipt.completedHostMs - receipt.inputHostMs',
    'elapsedMs: samples.after.hostTimeMs - receipt.inputHostMs'));
  assert.equal(verdict((await collect({ helperMs: 275 }, observerTiming)).result), 'fail');
  const lostCause = await mutated(t, text => text.replace("if (effect.reason !== 'pointer-near' || effect.inputSeq !== receipt.inputSeq) return unmeasured();", ''));
  assert.equal(verdict((await collect({ outcome: 'move', reason: null }, lostCause)).result), 'pass');
  assert.equal(verdict((await collect({ outcome: 'move', effectPatch: { inputSeq: 2 } }, lostCause)).result), 'pass');
  const lostConfirmation = await mutated(t, text => text.replace('!settled || settled.x !== after.x || settled.y !== after.y ||', '!settled ||'));
  assert.equal(verdict((await collect({ outcome: 'move', settled: [owned] }, lostConfirmation)).result), 'pass');
  const fakeFade = await mutated(t, text => text.replace("return { ...unmeasured(), pointer: [{ panelOnScreen: 'unmeasured', evidence,\n      notApplicable: 'A draw fade with null reason does not measure the pointer decision bar.' }] };",
    'row.opacity = effect.opacity; row.panelOnScreen = true;'));
  assert.equal(verdict((await collect({ outcome: 'fade' }, fakeFade)).result), 'pass');
});

test('executed broken variants detect a dropped between call and a substituted dump row', async t => {
  const dropped = await mutated(t, text => text.replace('between: () => session.request(input)', 'between: undefined'));
  await assert.rejects(collect({}, dropped), /between/);
  const substituted = await mutated(t, text => text.replace('return livePointerBehavior(behavior, samples);', 'return livePointerBehavior(behavior, { ...samples, receipt: behavior.pointer[0] });'));
  const { result } = await collect({}, substituted);
  assert.equal(verdict(result), 'fail', 'dump row lacks the session input receipt');
  assert.equal(result.pointer[0].panelOnScreen, 'unmeasured');
  const harness = await mutated(t, text => text.replace('between: () => session.request(input)', "between: () => session.request({ bench: 'hide' })"));
  const hidden = await collect({}, harness);
  assert.equal(hidden.fake.session.alive, true);
  assert.equal(hidden.result.pointer[0].panelOnScreen, 'unmeasured', 'a live harness hide supplies no pointer decision');
  assert.equal(verdict(hidden.result), 'fail');
});

test('bench pointer input only feeds coordinates to the production decision and observes its dispatch', () => {
  const swift = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  const fixture = readFileSync(new URL('../bench/hand/stage-fixture.swift', import.meta.url), 'utf8');
  const input = fixture.split('// BEGIN STAGE BENCH POINTER INPUT')[1].split('// END STAGE BENCH POINTER INPUT')[0];
  assert.match(input, /stageBenchPointerPosition = CGPoint/);
  assert.match(input, /stageBenchPointerPosition = nil/);
  assert.match(input, /inputSeq.doubleValue > Double\(pointerInputSeq\)/);
  const requireSequence = source => {
    assert.match(source, /"reason": draw.decisionReason as Any\? \?\? NSNull\(\), "inputSeq": inputSeq/);
    assert.match(source, /"inputID": inputID, "inputSeq": inputSeq, "position": position/);
  };
  requireSequence(input);
  assert.throws(() => requireSequence(input.replace('"inputID": inputID, "inputSeq": inputSeq', '"inputID": inputID')));
  assert.throws(() => requireSequence(input.replace('"reason": draw.decisionReason as Any? ?? NSNull(), "inputSeq": inputSeq', '"reason": draw.decisionReason as Any? ?? NSNull()')));
  assert.match(input, /host\.perch\.stagePointerChanged\(CACurrentMediaTime\(\)\)/);
  assert.doesNotMatch(input, /(?:host|perch|panel|stage)\.(?:hide|release|orderOut)\(/);
  assert.doesNotMatch(input, /stageEffects\s*=/);
  assert.match(swift, /#if SLEIGHT_STAGE_BENCH\s+\/\/[^\n]+\n\s+if let input = stageBenchPointerPosition \{ pointer = input \}\s+#endif/);
  const dispatch = swift.slice(swift.indexOf('func stagePointerChanged('), swift.indexOf('func stageEnvironment()'));
  assert.match(dispatch, /let effects = self\.stage\.pointerChanged\([\s\S]*?self\.performStage\(effects\)\s+#if SLEIGHT_STAGE_BENCH\s+stageBenchPointerObserved\?\(/);
  assert.match(dispatch, /#if SLEIGHT_STAGE_BENCH\s+let pointerPanelID = self\.panel\?\.windowNumber, pointerBox = self\.stage\.draw\?\.seat\.box\s+#endif/);
  const requireCause = source => assert.match(source, /decisionReason: dodge \? "pointer-near" : nil/);
  requireCause(swift);
  assert.throws(() => requireCause(swift.replace('decisionReason: dodge ? "pointer-near" : nil', 'decisionReason: nil')));
});

test('real protocol child reports death before a missing panel can count as a hide', async () => {
  const session = live.jsonChild(process.execPath, ['-e', `
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.bench === 'query') console.log(JSON.stringify({ reply: 'query', pid: process.pid, hostTimeMs: 1000 }));
      else process.exit(2);
    });`]);
  try {
    assert.equal(session.alive, true);
    assert.equal((await session.request({ bench: 'query' })).pid, session.pid);
    await assert.rejects(session.request({ bench: 'pointer' }), /child closed 2/);
    assert.equal(session.alive, false);
  } finally { assert.equal((await session.close()).code, 2); }
});

test('still listed hides fail and ambiguous after lists remain unmeasured', async () => {
  const stayed = await collect({ after: [owned] });
  assert.equal(stayed.result.pointer[0].panelOnScreen, true);
  assert.equal(verdict(stayed.result), 'fail');
  for (const after of [[{ ...owned, pid: 4 }], [owned, owned]]) {
    const { result } = await collect({ after });
    assert.equal(result.pointer[0].panelOnScreen, 'unmeasured');
    assert.equal(verdict(result), 'fail');
  }
  const fake = fixture(), read = fake.helper; let calls = 0;
  fake.helper = args => ++calls === 1 ? read(args) : { windows: null };
  const result = await live.collectLivePointerBehavior(dump, fake);
  assert.equal(result.pointer[0].panelOnScreen, 'unmeasured');
  assert.equal(verdict(result), 'fail');
});

test('dump move and fade rows receive no measurements from another session input', async () => {
  const behavior = { pointer: [...dump.pointer, { outcome: 'move', distancePt: 999 }, { outcome: 'fade', opacity: 0.35 }] };
  const result = await live.collectLivePointerBehavior(behavior, fixture());
  assert.equal(result.pointer.length, 1);
  assert.equal(result.pointer[0].outcome, 'hidden');
  assert.equal(result.pointer[0].distancePt, undefined);
  assert.equal(verdict(result), 'pass');
});
