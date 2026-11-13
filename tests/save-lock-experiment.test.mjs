// Constructed macOS paths are synthetic validation and redaction data, never allocation roots.
const MAC_TMP = ['', 'private', 'tmp'].join('/');
const MAC_USERS = ['', 'Users', ''].join('/');
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import {
  VARIANTS, GATE_RUNS, GATE_MIN_HANGS, DELIVERY_WAIT_MS,
  buildPlan, buildDeliveryCheckPlan, countByVariant, gateDecision, runExperiment,
  ownedTrialPath, probeClientOptions, trialSteps, dryRunPlan,
  mayCapture, scrubEvidence, parseArgs, unconfirmedCloseDetail,
} from '../bench/textedit-save-lock.mjs';

const runner = fileURLToPath(new URL('../bench/textedit-save-lock.mjs', import.meta.url));
const helper = readFileSync(new URL('../bench/textedit-save-lock.js', import.meta.url), 'utf8');
const runnerSource = readFileSync(new URL('../bench/textedit-save-lock.mjs', import.meta.url), 'utf8');
const path = `${MAC_TMP}/sleight-save-lock-Zk4nfu/trial.txt`;

test('cleanup accepts only an owned temporary trial document', () => {
  assert.equal(ownedTrialPath(path), path);
  for (const wrong of [`${MAC_TMP}/other/trial.txt`, path + '/../other.txt',
    `${MAC_TMP}/sleight-save-lock-Zk4nfu/other.txt`, '~/Documents/notes.txt',
    '/tmp/sleight-save-lock-Zk4nfu/trial.txt']) {
    assert.throws(() => ownedTrialPath(wrong), /owned temporary/);
  }
});

test('the plan runs five no-event gate runs, then five interleaved cycles of the variants', () => {
  const plan = buildPlan();
  assert.equal(plan.length, 30);
  assert.deepEqual(plan.slice(0, 5).map(s => [s.phase, s.variant]), Array(5).fill(['gate', 'none']));
  assert.deepEqual(VARIANTS, ['none', 'shift-pair', 'escape', 'keyup-only', 'applescript-read']);
  const rest = plan.slice(5);
  for (let cycle = 0; cycle < 5; cycle++) {
    assert.deepEqual(rest.slice(cycle * 5, cycle * 5 + 5).map(s => s.variant), VARIANTS);
    assert.ok(rest.slice(cycle * 5, cycle * 5 + 5).every(s => s.phase === 'variants' && s.cycle === cycle + 1));
  }
  assert.deepEqual(plan.map(s => s.index), plan.map((_, i) => i + 1));
  assert.equal(GATE_RUNS, 5);
  assert.equal(GATE_MIN_HANGS, 3);
});

test('hangs are counted per variant, apart from skipped and undelivered runs', () => {
  const counts = countByVariant([
    { variant: 'none', hang: true }, { variant: 'none', hang: false, msToSave: 120 }, { variant: 'none', skipped: 'Attach refused' },
    { variant: 'escape', hang: true }, { variant: 'escape', hang: true },
    { variant: 'applescript-read', delivered: false, hang: true }, { variant: 'applescript-read', delivered: true, hang: false, msToSave: 90 },
  ]);
  assert.deepEqual(counts.none, { runs: 3, completed: 2, hangs: 1, saved: 1, skipped: 1, notDelivered: 0, msToSave: [120] });
  assert.equal(counts.escape.hangs, 2); assert.equal(counts.escape.completed, 2);
  assert.deepEqual(counts['applescript-read'], { runs: 2, completed: 1, hangs: 0, saved: 1, skipped: 0, notDelivered: 1, msToSave: [90] });
});

async function experiment(gateHangs, { skipGate = 0 } = {}) {
  const seen = [], report = {};
  let gate = 0;
  await runExperiment({ plan: buildPlan(), report, runOne: async run => {
    seen.push(run.phase);
    if (run.phase === 'gate') {
      gate++;
      if (gate <= skipGate) run.skipped = 'Attach refused';
      else run.hang = gate - skipGate <= gateHangs;
    } else run.hang = run.variant === 'none';
  } });
  return { seen, report };
}

test('fewer than three gate hangs records that Open panel does not reproduce and runs no variant', async () => {
  const { seen, report } = await experiment(2);
  assert.deepEqual(seen, Array(5).fill('gate'));
  assert.equal(report.gate.proceed, false);
  assert.equal(report.gate.conclusion, 'Open panel does not reproduce the hang');
  assert.equal(report.runs.length, 5); assert.deepEqual(report.counts.variants, {});
});

test('three gate hangs go on to every variant run, and each run is recorded', async () => {
  const { seen, report } = await experiment(3);
  assert.equal(seen.filter(p => p === 'variants').length, 25);
  assert.equal(report.gate.proceed, true);
  assert.equal(report.counts.variants.none.hangs, 5);
  assert.equal(report.counts.variants['shift-pair'].hangs, 0); assert.equal(report.counts.variants['shift-pair'].completed, 5);
});

test('skipped gate runs make a short gate inconclusive rather than a negative result', async () => {
  const { report } = await experiment(2, { skipGate: 2 });
  assert.equal(report.gate.proceed, false);
  assert.match(report.gate.conclusion, /^inconclusive: 3 of 5/);
  assert.equal(gateDecision([{ hang: true }, { hang: true }, { hang: false }, { hang: false }, { hang: false }]).conclusion, 'Open panel does not reproduce the hang');
});

test('a stop from a run ends the experiment there', async () => {
  const report = {}, seen = [];
  await runExperiment({ plan: buildPlan(), report, runOne: async run => { seen.push(run.index); return run.index === 2 ? { stop: 'Live hold exists' } : undefined; } });
  assert.deepEqual(seen, [1, 2]); assert.equal(report.stopped, 'Live hold exists');
});

function acceptOwnedWindows(rows) {
  const context = { ObjC: { import() {} } };
  runInNewContext(helper, context);
  return JSON.parse(JSON.stringify(context.acceptOwnedWindows(rows, `file://${MAC_TMP}/sleight-save-lock-abc123/trial.txt`)));
}
const owned = { document: `file://${MAC_TMP}/sleight-save-lock-abc123/trial.txt`, modal: false, sheet: false, text: 'seed\n' };

test('the owned document window alone is accepted', () => {
  assert.deepEqual(acceptOwnedWindows([owned]), { accept: true, owned: 0, artifacts: [] });
});
test('an extra empty untitled window or panel from the same app is tolerated', () => {
  assert.equal(acceptOwnedWindows([{ document: null, modal: false, sheet: false, text: '' }, owned]).accept, true);
  assert.equal(acceptOwnedWindows([{ document: null, modal: false, sheet: false, text: '' }, owned]).owned, 1);
  assert.deepEqual(acceptOwnedWindows([owned, { document: null, modal: false, sheet: false, text: null }]).artifacts, ['panel']);
});
test('an already-open owner document is tolerated; a second owned URL or a dialog is not', () => {
  assert.equal(acceptOwnedWindows([owned, { document: `file://${MAC_USERS}x/notes.txt`, modal: false, sheet: false, text: '' }]).accept, true);
  assert.equal(acceptOwnedWindows([owned, { document: null, modal: false, sheet: false, text: 'restored words' }]).accept, true);
  assert.equal(acceptOwnedWindows([owned, { ...owned }]).reason, 'Ambiguous owned windows');
  assert.equal(acceptOwnedWindows([{ ...owned, sheet: true }]).accept, false);
  assert.equal(acceptOwnedWindows([owned, { document: null, modal: true, sheet: false, text: null }]).accept, false);
});
test('no window, or no owned window yet, asks for a retry', () => {
  assert.equal(acceptOwnedWindows([]).retry, true);
  assert.equal(acceptOwnedWindows([{ document: null, modal: false, sheet: false, text: '' }]).retry, true);
});
test('an owned window whose AXDocument uses /tmp or localhost still matches', () => {
  const expected = `file://${MAC_TMP}/sleight-save-lock-abc123/trial.txt`;
  for (const document of [
    'file:///tmp/sleight-save-lock-abc123/trial.txt',
    `file://localhost${MAC_TMP}/sleight-save-lock-abc123/trial.txt`,
    'file://localhost/tmp/sleight-save-lock-abc123/trial.txt',
  ]) {
    assert.equal(acceptOwnedWindows([{ document, modal: false, sheet: false, text: 'seed\n' }], expected).accept, true);
  }
});
test('a skipped attach names that skip instead of undefined', () => {
  assert.equal(unconfirmedCloseDetail({ skipped: 'Attach refused: Retry: Owned document window not open yet' }),
    'Attach refused: Retry: Owned document window not open yet');
  assert.equal(unconfirmedCloseDetail({}), 'no close result');
});

test('hang trials open through the engine Open panel, write through Accessibility, and save with pressKey super+s', () => {
  const steps = trialSteps({ path, variant: 'none' });
  assert.deepEqual(steps.open.map(s => s.code), [
    'await app.pressKey("super+o")',
    'await app.pressKey("super+shift+g")',
    `await app.typeText(${JSON.stringify(path)})`,
    'await app.pressKey("Return")',
  ]);
  assert.equal(steps.open.every(s => s.source === 'engine'), true);
  assert.deepEqual(steps.edit, [{ source: 'fixture', op: 'edit', text: 'probe-1\n' }]);
  assert.deepEqual(steps.settle, []);
  assert.deepEqual(steps.save, { source: 'engine', code: 'await app.pressKey("super+s")' });
  assert.equal(steps.capture, false);
  assert.equal(JSON.stringify(steps).includes('open -g'), false);
  assert.equal(JSON.stringify(steps).includes('CGEventPostToPid'), false);
});

test('the shift variant still saves through the engine and only posts Shift after the Accessibility write', () => {
  const steps = trialSteps({ path, variant: 'shift-pair', marker: 'probe-1\n' });
  assert.deepEqual(steps.edit, [{ source: 'fixture', op: 'edit', text: 'probe-1\n' }]);
  assert.deepEqual(steps.settle, [{ source: 'fixture', op: 'event', variant: 'shift-pair' }]);
  assert.deepEqual(steps.save, { source: 'engine', code: 'await app.pressKey("super+s")' });
});

test('delivery-check types through the engine and requires Cmd+S to save within 2 s', () => {
  const steps = trialSteps({ path, deliveryCheck: true, marker: 'typed' });
  assert.equal(steps.edit.every(s => s.source === 'engine' && s.code.startsWith('await app.pressKey(')), true);
  assert.deepEqual(steps.edit.map(s => s.code), [...'typed'].map(ch => `await app.pressKey(${JSON.stringify(ch)})`));
  assert.deepEqual(steps.save, { source: 'engine', code: 'await app.pressKey("super+s")' });
  assert.equal(steps.saveWithinMs, DELIVERY_WAIT_MS);
  assert.equal(steps.saveWithinMs, 2000);
  assert.equal(steps.edit.some(s => s.op === 'edit'), false);
});

test('the probe talks to TextEdit through the relay with change review off and a space probe', () => {
  const probe = async () => ({ status: 'responding' });
  assert.deepEqual(probeClientOptions(probe), {
    relay: true,
    relayOptions: { changeReview: false, spaceProbe: probe },
  });
  assert.match(runnerSource, /probeClient/);
  assert.match(runnerSource, /changeReview:\s*false/);
  assert.match(runnerSource, /spaceProbe/);
});

test('Open panel stages are never captured and evidence drops panel frames', () => {
  assert.equal(mayCapture('open'), false);
  assert.equal(mayCapture('go-to-folder'), false);
  assert.equal(mayCapture('open-panel'), false);
  assert.equal(mayCapture('document'), true);
  const raw = {
    path: `${MAC_USERS}exampleuser/Projects/sleight`,
    frames: [
      { stage: 'open-panel', title: 'Open', image: { type: 'image', data: 'pixels' } },
      { stage: 'document', title: 'trial.txt', text: 'probe-1' },
    ],
    content: [{ type: 'image', data: 'panel' }, { type: 'text', text: 'ok' }],
  };
  const clean = scrubEvidence(raw, { home: `${MAC_USERS}exampleuser`, names: ['exampleuser'] });
  assert.equal(clean.path, '~/Projects/sleight');
  assert.equal(JSON.stringify(clean).includes('pixels'), false);
  assert.equal(JSON.stringify(clean).includes('panel'), false);
  assert.equal(JSON.stringify(clean).includes(`${MAC_USERS}exampleuser`), false);
  assert.equal(clean.frames.length, 1);
  assert.equal(clean.frames[0].title, 'trial.txt');
  assert.deepEqual(clean.content, [{ type: 'text', text: 'ok' }]);
});

test('dry-run prints the Open-panel plus engine-save plan and does not take the live lock', () => {
  const lock = '/tmp/sleight-live.lock';
  const before = existsSync(lock);
  const result = spawnSync(process.execPath, [runner, '--dry-run'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.lock, false);
  assert.equal(plan.captureOpenPanel, false);
  assert.equal(plan.cleanup, 'pid-lookup');
  assert.deepEqual(plan.probeClient, { relay: true, relayOptions: { changeReview: false, spaceProbe: true } });
  assert.equal(plan.gate.runs, 5);
  assert.equal(plan.gate.variantsIfHangs, 3);
  assert.equal(plan.gate.interleaved, true);
  assert.equal(plan.steps.save.code, 'await app.pressKey("super+s")');
  assert.equal(plan.steps.save.source, 'engine');
  assert.deepEqual(plan.steps.open.map(s => s.code), [
    'await app.pressKey("super+o")',
    'await app.pressKey("super+shift+g")',
    `await app.typeText(${JSON.stringify(`${MAC_TMP}/sleight-save-lock-dry/trial.txt`)})`,
    'await app.pressKey("Return")',
  ]);
  assert.equal(JSON.stringify(plan).includes('open -g'), false);
  assert.equal(JSON.stringify(plan).includes('CGEventPostToPid'), false);
  assert.equal(existsSync(lock), before);
  assert.deepEqual(plan, dryRunPlan());
});

test('delivery-check dry-run names typed keys, engine Cmd+S, and a 2 s save bound', () => {
  const result = spawnSync(process.execPath, [runner, '--dry-run', '--delivery-check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.deliveryCheck, true);
  assert.equal(plan.steps.saveWithinMs, 2000);
  assert.equal(plan.steps.edit[0].source, 'engine');
  assert.match(plan.steps.save.code, /pressKey\("super\+s"\)/);
});

test('--delivery-check is accepted and names a 2 s confirmation', () => {
  assert.deepEqual(parseArgs(['--delivery-check']), { dryRun: false, deliveryCheck: true });
  assert.deepEqual(parseArgs(['--dry-run', '--delivery-check']), { dryRun: true, deliveryCheck: true });
  assert.throws(() => parseArgs(['--live']), /supported/);
  assert.equal(DELIVERY_WAIT_MS, 2000);
  const plan = buildDeliveryCheckPlan();
  assert.equal(plan.length, 1);
  assert.equal(plan[0].phase, 'delivery-check');
});

test('a delivery-check plan runs its one step without a hang gate', async () => {
  const report = {}, seen = [];
  await runExperiment({
    plan: [{ index: 1, phase: 'delivery-check', variant: 'none', cycle: 1 }],
    report,
    runOne: async run => { seen.push(run.phase); run.hang = false; run.msToSave = 80; },
  });
  assert.deepEqual(seen, ['delivery-check']);
  assert.equal(report.runs.length, 1);
  assert.equal(report.gate.proceed, true);
});

test('save confirmation returns when the file changes or edited clears within 2 s', async () => {
  const { watchSaveStart } = await import('../bench/textedit-save-lock.mjs');
  let t = 0;
  const hit = await watchSaveStart({
    seed: 'seed\n', until: 2000, now: () => t, sleep: async ms => { t += ms; },
    readBytes: async () => (t >= 150 ? 'xseed\n' : 'seed\n'),
    readState: async () => ({ edited: true }),
  });
  assert.equal(hit.fileChanged, true);
  assert.ok(hit.at <= 2000);
  t = 0;
  const cleared = await watchSaveStart({
    seed: 'seed\n', until: 2000, now: () => t, sleep: async ms => { t += ms; },
    readBytes: async () => 'seed\n',
    readState: async () => ({ edited: t >= 100 ? false : true }),
  });
  assert.equal(cleared.editedCleared, true);
  t = 0;
  const miss = await watchSaveStart({
    seed: 'seed\n', until: 2000, now: () => t, sleep: async ms => { t += ms; },
    readBytes: async () => 'seed\n',
    readState: async () => ({ edited: true }),
  });
  assert.equal(miss, null);
  t = 0;
  const neverEdited = await watchSaveStart({
    seed: 'seed\n', until: 2000, now: () => t, sleep: async ms => { t += ms; }, editedBefore: false,
    readBytes: async () => 'seed\n',
    readState: async () => ({ edited: false }),
  });
  assert.equal(neverEdited, null);
});

function block(source, op) {
  const start = source.indexOf(`if (r.op === '${op}')`);
  assert.ok(start >= 0, `helper has op ${op}`);
  const next = source.indexOf('if (r.op ===', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

test('the fixture writes through Accessibility, looks up the TextEdit PID at cleanup, and does not post Cmd+S', () => {
  assert.match(helper, /AXUIElementSetAttributeValue/);
  assert.match(helper, /AXValue/);
  assert.match(helper, /lookup-pid|textEditPid/);
  assert.match(helper, /runningApplicationsWithBundleIdentifier/);
  assert.match(block(helper, 'edit'), /AXUIElementSetAttributeValue/);
  assert.match(block(helper, 'event'), /shift-pair/);
  assert.doesNotMatch(helper, /\bop === 'save'/);
  assert.equal(/kVK_ANSI_S|keycode 1|keyCode:\s*1/.test(helper), false);
  assert.equal(helper.includes('screencapture'), false);
  assert.equal(helper.includes('open -g'), false);
  assert.doesNotMatch(helper, /CGEventCreateKeyboardEvent\([^)]*1\s*,/);
  assert.doesNotMatch(helper, /key\(1,/);
});

test('the runner skips the Accessibility edit on a delivery-check step and never posts Cmd+S', () => {
  const start = runnerSource.indexOf("if (run.phase === 'delivery-check')");
  assert.ok(start >= 0, 'runOne branches on delivery-check');
  const end = runnerSource.indexOf('const expected', start);
  const chunk = runnerSource.slice(start, end);
  assert.match(chunk, /callEngine/);
  assert.match(chunk, /engineSave/);
  assert.doesNotMatch(chunk, /op: 'edit'/);
  assert.doesNotMatch(chunk, /op: 'save'/);
  assert.doesNotMatch(runnerSource, /open', \['-n', '-g'/);
  assert.match(runnerSource, /pressKey\("super\+s"\)/);
});

test('preflight refuses a TextEdit with documents the probe did not open', () => {
  // The probe types a path into TextEdit's Open panel. If the panel failed to open, that text would go
  // into whatever document has focus, so the user's own documents must not be open (review, 2026-10-11).
  const helper = readFileSync(new URL('../bench/textedit-save-lock.js', import.meta.url), 'utf8');
  const preflight = helper.slice(helper.indexOf("r.op === 'preflight'"), helper.indexOf("r.op === 'lookup-pid'"));
  assert.match(preflight, /documents\(\)/);
  assert.match(preflight, /OWNED_PATH\.test/);
  assert.match(preflight, /did not open; probe refused/);
});
