import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { stageSurfaceFixture, stageSurfaceChecksFixture, recordedActions, measurementWindows, stageScriptFixture } from './fixtures/stage-surface.mjs';
import { cursorWire } from '../bench/hand/cursor-sequence.mjs';
import { stageSequence } from '../bench/hand/stage-cost.mjs';
const variant = process.env.CHV2Z_BROKEN_VARIANT;
async function load(file, variants = {}) {
  const url = new URL('../bench/hand/' + file, import.meta.url), original = readFileSync(url, 'utf8');
  if (!variants[variant]) return import(url.href);
  const [before, after] = variants[variant];
  assert.ok(original.includes(before), 'mutation site ' + variant);
  const source = original.replace(before, after).replace(/from (['"])(\.[^'"]+)\1/g,
    (_, q, path) => 'from ' + q + new URL(path, url).href + q).replaceAll('import.meta.url', JSON.stringify(url.href));
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
const surface = await load('stage-surface.mjs', {
  'ignore-high-layer': ["requiresPanel ? w.layer >= owned.layer : surface === 'quiet' && w.layer >= 3", 'false'],
  'ignore-between': ["surface === 'changing' && windows.indexOf(w) < backdropIndex", 'false'],
  'accept-stale': ['observedAtMs < startedAtMs', 'false'],
  'unsafe-targets': ['w.ignoresMouseEvents !== true', 'false'],
  'silent-boundary': ['  log(`ST9 surface', '  (() => {})(`ST9 surface'],
  'allow-missing-boundary': ['checks.length === boundaries.length', 'true'],
});
const meter = await load('stage-measurement.mjs', {
  'late-digest': ['Math.abs(dispatchedMs - scheduledMs) > STAGE_DISPATCH_TOLERANCE_MS', 'false'],
  'skip-active-end': ["surfaceChecks.push(await checkSurface('active-end'));", ''],
  'skip-parked-start': ["await checkSurface('parked-start');", ''],
  'ignore-played-frame': ["{ ...payload, pid: 'fixture', windowId: slot }", "{ hand: payload.hand, pid: 'fixture', windowId: slot }"],
});
const sampler = await load('cost-sampler.mjs', {
  'short-peaks': ['!shortTail', 'true'],
  'jitter-peaks': ['!shortTail', 'seconds * 1000 >= peakSamplePeriodMs'],
  'short-interior': ['part.seconds * 1000 < peakSamplePeriodMs / 2', 'false'],
});
const judge = await load('stage-cost.mjs', {
  'drop-marker-cli': ["'--character', '--owner-away-file'", "'--character'"],
  'silent-baseline': ['of r.baselineSurfaceChecks ?? []', 'of []'],
  'silent-report': ["['phase', phase.surfaceChecks], ['control', phase.control?.surfaceChecks]", "['phase', []], ['control', []]"],
  'short-watchdog': ['(estimateMinutes + compilationMinutes + marginMinutes) * 60000', 'estimateMinutes * 60000'],
});
const observe = c => surface.stageSurfaceObservation(c, c, c);

test('CHV2Z surface detects floating covers and foreign content between panel and backdrop', () => {
  const good = stageSurfaceFixture(); assert.equal(observe(good).valid, true);
  for (const layer of [3, 4, 25]) {
    const c = structuredClone(good), cover = { id: 101, pid: 99, layer, alpha: 1, bounds: c.panel };
    c.windows.unshift(cover);
    assert.equal(observe(c).valid, false, 'foreign level ' + layer);
    assert.deepEqual(observe(c).interfering.map(w => w.id), [101]);
  }
  const between = structuredClone(good), cover = { id: 102, pid: 99, layer: 2, alpha: 1, bounds: between.panel };
  between.windows.splice(1, 0, cover);
  assert.equal(observe(between).valid, false);
  assert.deepEqual(observe(between).interfering.map(w => w.id), [102]);
  const quiet = stageSurfaceFixture({ surface: 'quiet' }); assert.equal(observe(quiet).valid, true);
  quiet.windows.push({ ...cover, layer: 0 }); assert.equal(observe(quiet).valid, true);
});

test('CHV2Z surface rejects missing, stale, panel-less and impossible lists', () => {
  for (const mutate of [c => { c.observedAtMs = 98; }, c => { c.completedAtMs = 2200; },
    c => { delete c.windows; }, c => { c.windows.shift(); }, c => { c.panel = null; c.panelID = null; },
    c => { c.panel = { ...c.panel, x: c.panel.x + 1 }; }, c => { c.windows.reverse(); }, c => { c.backdrop.raised = false; },
    c => { c.backdrop.ignoresMouseEvents = false; }, c => { c.backdrop.canBecomeKey = true; },
    c => { c.windows = c.windows.filter(w => w.id !== c.backdrop.id); }, c => { c.fixtureIDs[1] = 123; }]) {
    const c = stageSurfaceFixture(); mutate(c); assert.equal(observe(c).valid, false);
  }
  const precise = stageSurfaceFixture(); precise.startedAtMs = precise.completedAtMs = 100; precise.observedAtMs = 100.75;
  assert.equal(observe(precise).valid, true, 'wall clock precision does not make a fresh reply look future-dated');
  const hidden = stageSurfaceFixture({ panel: false }); assert.equal(observe(hidden).valid, true);
  hidden.windows.unshift({ id: 200, pid: 99, layer: 3, alpha: 1, bounds: hidden.windows.at(-1).bounds });
  assert.equal(observe(hidden).valid, false, 'controls and baselines have the same raised content requirement');
  const quiet = stageSurfaceFixture({ panel: false, surface: 'quiet' });
  assert.equal(observe(quiet).valid, true); quiet.windows.unshift(hidden.windows[0]);
  assert.equal(observe(quiet).valid, false, 'hidden quiet controls reject floating interference conservatively');
});

test('CHV2ZA surface rejects each raised target that captures clicks or can activate', () => {
  for (let i = 0; i < 3; i++) for (const field of ['ignoresMouseEvents', 'canBecomeKey', 'canBecomeMain']) {
    const c = stageSurfaceFixture(); c.fixtureWindows[i][field] = field !== 'ignoresMouseEvents';
    assert.equal(observe(c).valid, false, `target ${i} ${field}`);
  }
  for (const replace of [undefined, [], [null], [{ id: 7 }, { id: 7 }, { id: 9 }]]) {
    const c = stageSurfaceFixture(); c.fixtureWindows = replace; assert.equal(observe(c).valid, false);
  }
});

test('CHV2ZA boundary console and report print raw interfering lists including cursor overlays', async () => {
  for (const name of ['quiet', 'changing']) for (const requiresPanel of [true, false]) {
    for (const boundary of requiresPanel ? ['active-start', 'active-end', 'parked-start', 'parked-end'] : ['active-start', 'active-end']) {
      const c = stageSurfaceFixture({ surface: name, panel: requiresPanel });
      const cursor = { id: 902, pid: 100, layer: 2147483630, alpha: 1, bounds: c.panel ?? c.backdrop.bounds };
      c.windows.unshift(cursor);
      const lines = [], check = await surface.collectSurfaceCheck({ session: { request: async () => c }, helper: async () => c,
        surface: name, requiresPanel, boundary, now: () => 100, log: line => lines.push(line) });
      assert.equal(check.valid, false); assert.deepEqual(check.interfering, [{ ...cursor, invalidates: true, reason: 'foreign app content' }]);
      assert.equal(lines.length, 1); assert.ok(lines[0].includes(`${name} `) && lines[0].includes(boundary));
      assert.ok(lines[0].includes('interfering=' + JSON.stringify(check.interfering)));
      const report = judge.reportMarkdown(judge.stageVerdict({ runs: [{ round: 1, sizes: { small: { phases: {
        [name]: requiresPanel ? { surfaceChecks: [check] } : { control: { surfaceChecks: [check] } },
      } } } }] }));
      assert.ok(report.includes(`${name} ${requiresPanel ? 'phase' : 'control'} ${boundary}`));
      assert.ok(report.includes('interfering=' + JSON.stringify(check.interfering)));
      if (!requiresPanel) for (const index of [0, 1]) {
        const rows = [{}, {}]; rows[index] = { surfaceChecks: [check] };
        const baselineReport = judge.reportMarkdown(judge.stageVerdict({ runs: [{ round: 1, baselines: { [name]: rows } }] }));
        assert.ok(baselineReport.includes(`${name} diagnostic baseline ${index ? 'after' : 'before'} ${boundary}`));
        assert.ok(baselineReport.includes('interfering=' + JSON.stringify(check.interfering)));
      }
    }
  }
});

test('CHV2Z all measured boundaries retain raw fresh checks and any failure invalidates', async () => {
  for (const name of ['quiet', 'changing']) {
    const checks = stageSurfaceChecksFixture(name), labels = checks.map(c => c.boundary);
    assert.equal(surface.stageSurfaceChecksValid(checks, labels, name), true);
    for (let i = 0; i < labels.length; i++) {
      const bad = structuredClone(checks); bad[i].windows = [];
      assert.equal(surface.stageSurfaceChecksValid(bad, labels, name), false);
    }
    assert.equal(surface.stageSurfaceChecksValid(checks.slice(0, -1), labels, name), false);
    assert.equal(surface.stageSurfaceChecksValid(stageSurfaceChecksFixture(name, false), ['active-start', 'active-end'], name), false);
    const fake = stageSurfaceFixture({ surface: name }); let clock = 99;
    const observed = await surface.collectSurfaceCheck({ session: { request: async () => fake }, helper: async args => {
      assert.deepEqual(args, ['windows']); clock = 101; return fake;
    }, surface: name, requiresPanel: true, boundary: 'active-start', now: () => clock });
    assert.equal(observed.valid, true); assert.equal(observed.observedAtMs, 100);
  }
});

test('CHV2Z collectors check control active and phase parked boundaries outside parked CPU endpoints', async () => {
  let clock = 0; const events = [], samples = [];
  const session = { pid: 42, wire: cursorWire(), write() {}, ready: { windows: measurementWindows },
    sampler: { samples, sample: async () => {
      events.push('sample'); samples.push({ t: clock, status: { pid: 42, panelID: 77, installCount: 1,
        hideReasonCounts: {}, processTree: { startID: 'same' } } });
    }, pause: async () => {}, stop: async () => {} } };
  const checkSurface = async boundary => { events.push(boundary); return { boundary, valid: true }; };
  await meter.collectHiddenControl({ session, sequence: stageSequence(measurementWindows), surface: 'changing', size: 'small',
    now: () => clock, wait: async ms => { clock += ms; }, checkSurface });
  assert.deepEqual(events, ['active-start', 'sample', 'active-end']);
  events.length = 0;
  await meter.collectParkedInterval({ session, wait: async ms => { events.push('wait ' + ms); clock += ms; },
    size: 'small', recordVisibility() {}, checkSurface });
  assert.deepEqual(events, ['wait 6000', 'parked-start', 'sample', 'wait 61000', 'sample', 'parked-end']);
});

test('CHV2Z busiest seconds exclude the 2 ms ps tail for control and phase', () => {
  const samples = Array.from({ length: 62 }, (_, i) => ({ t: i * 1000, ws: i * 0.1, hosts: { 42: { cpu: i * 0.01, rssKb: 1 } },
    status: { pid: 42, characterHiddenControl: true, shown: false } }));
  samples.push({ ...samples.at(-1), t: 61002, ws: 6.11 });
  const full = sampler.summarize(samples, { peakSamplePeriodMs: 1000 });
  assert.equal(full.windowServer.peakPct, 10); assert.equal(full.windowServer.runnerUpPct, 10);
  assert.equal(full.windowServer.avgPct, 10.02, 'average keeps all cumulative CPU');
  const control = { ...stageScriptFixture('quiet', 'small'), pid: 42, start: 0, end: 61002, samples };
  assert.equal(meter.stageControlFigures(control).wsPeakPct, 10);
  assert.equal(judge.stagePhaseFigures(samples, { start: 0, activeEnd: 61002 }, 42).wsPeakPct, 10);
  const fastTail = structuredClone(samples); fastTail.at(-1).ws = 6.1;
  assert.equal(sampler.summarize(fastTail, { peakSamplePeriodMs: 1000 }).windowServer.peakPct, 10);
});

test('CHV2ZA real six-series distribution retains peaks from ordinary sampling jitter', () => {
  const recorded = JSON.parse(readFileSync(new URL('./fixtures/stage-cost-intervals.json', import.meta.url), 'utf8'));
  assert.equal(recorded.length, 6);
  let jitterIntervals = 0, changedTails = 0;
  for (const series of recorded) {
    const allRows = series.samples.map(([t, ws]) => ({ t, ws, hosts: {} }));
    const rows = allRows.slice(2, 65);
    const differences = rows.slice(1).map((r, i) => r.t - rows[i].t);
    jitterIntervals += differences.filter(t => t >= 900 && t < 1000).length;
    const shortTail = differences.at(-1) < 500;
    const expected = sampler.summarize(shortTail ? rows.slice(0, -1) : rows).windowServer;
    const actual = sampler.summarize(rows, { peakSamplePeriodMs: 1000 }).windowServer;
    assert.equal(actual.peakPct, expected.peakPct, `${series.size} ${series.surface}`);
    assert.equal(judge.stagePhaseFigures(allRows, { startSample: 2, start: rows[0].t,
      activeEnd: rows.at(-1).t, idleEnd: rows.at(-1).t }, 42).wsPeakPct, actual.peakPct);
    assert.equal(actual.avgPct, sampler.summarize(rows).windowServer.avgPct);
    if (shortTail) changedTails++;
  }
  assert.equal(jitterIntervals, 145); assert.equal(changedTails, 6);
  // The largest interval's CPU follows a 980 ms gap, including when it is the final full sample.
  for (const tail of [false, true]) {
    const rows = [{ t: 0, ws: 0, hosts: {} }, { t: 1030, ws: 0.1, hosts: {} },
      { t: 2010, ws: 0.6, hosts: {} }, ...tail ? [{ t: 2012, ws: 0.61, hosts: {} }] : []];
    assert.equal(sampler.summarize(rows, { peakSamplePeriodMs: 1000 }).windowServer.peakPct, 51.02);
  }
});

test('CHV2Z digests bind recorded payloads while tolerating process identity and dispatch jitter', () => {
  const actions = recordedActions(), digest = meter.stageScriptDigest(actions, measurementWindows);
  for (const mutate of [a => { a[1].frame.kind = 'right'; }, a => { a[1].frame.at[0]++; },
    a => { a.splice(2, 1); a.forEach((r, i) => { r.order = i; }); }, a => { a[2].scheduledMs++; }]) {
    const bad = structuredClone(actions); mutate(bad);
    assert.notEqual(meter.stageScriptDigest(bad, measurementWindows), digest);
  }
  const other = measurementWindows.map(w => ({ ...w, id: w.id + 50, pid: 123 }));
  const jittered = recordedActions(other).map(a => ({ ...a, dispatchedMs: a.dispatchedMs + 25 }));
  assert.equal(meter.stageScriptDigest(jittered, other), digest);
  assert.equal(meter.stageScriptDigest([], measurementWindows), null);
});

test('CHV2ZA digests refuse late early and compressed dispatch beyond 250 ms', () => {
  const actions = recordedActions(), digest = meter.stageScriptDigest(actions, measurementWindows);
  for (const delta of [250, 251, 3000]) {
    const changed = actions.map(a => ({ ...a, dispatchedMs: a.dispatchedMs + delta }));
    assert.equal(meter.stageScriptDigest(changed, measurementWindows), delta === 250 ? digest : null);
  }
  for (const delta of [-250, -251]) {
    const changed = structuredClone(actions); changed.at(-1).dispatchedMs += delta;
    assert.equal(meter.stageScriptDigest(changed, measurementWindows), delta === -250 ? digest : null);
  }
  const compressed = actions.map(a => ({ ...a, dispatchedMs: a.dispatchedMs * 0.9 }));
  assert.equal(meter.stageScriptDigest(compressed, measurementWindows), null);
  const samples = Array.from({ length: 62 }, (_, i) => ({ t: i * 1000, ws: i * 0.1, hosts: {},
    status: { pid: 42, characterHiddenControl: true, shown: false } }));
  const control = { ...stageScriptFixture('quiet', 'small'), pid: 42, start: 0, end: 61000, samples };
  assert.ok(meter.stageControlFigures(control));
  control.actions = actions.map(a => ({ ...a, dispatchedMs: a.dispatchedMs + 251 }));
  assert.equal(meter.stageControlFigures(control), null, 'stored digest cannot conceal late control actions');
});

test('CHV2Z watchdog printed deadline follows all sizes and each one-size estimate', () => {
  assert.equal(judge.parseArgs(['--dry-run', '--owner-away-file', '/fixture/away']).ownerAwayFile, '/fixture/away');
  for (const size of ['all', 'small', 'medium', 'stage']) {
    const timing = judge.stageRunTiming({ size });
    assert.equal(timing.estimateMinutes, size === 'all' ? 112 : 54);
    assert.equal(timing.compilationMinutes, 15);
    assert.equal(timing.marginMinutes, Math.max(10, Math.ceil(timing.estimateMinutes / 4)));
    assert.equal(timing.watchdogMs / 60000, size === 'all' ? 155 : 83);
    assert.match(judge.dryRunPlan({ size }).join('\n'), new RegExp(timing.watchdogMs / 60000 + '-minute global deadline'));
  }
});

test('CHV2Z native backdrop levels and cleanup cover exits and catchable signals without windows',
  { skip: process.platform !== 'darwin' }, t => {
    const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'stage-surface-native-'))), main = join(root, 'main.swift'), binary = join(root, 'surface');
    let source = readFileSync(new URL('../bench/hand/stage-fixture.swift', import.meta.url), 'utf8').split('// BEGIN BACKDROP LIFECYCLE')[1].split('// END BACKDROP LIFECYCLE')[0];
    const mutations = {
      'exposure-cap': ['timeoutSeconds <= 240', 'true'],
      'control-deadline': ['control ? 180 : 240', '240'],
      'relative-marker': ['(path as NSString).isAbsolutePath', 'true'],
      'directory-marker': ['&& !directory.boolValue', ''],
      'fixture-argv': ['return args == ["--hand"]', 'return true || args == ["--hand"]'],
      'capture-targets': ['targets.forEach { $0.ignoresMouseEvents = true;', 'targets.forEach { $0.ignoresMouseEvents = false;'],
      'forget-mouse-restore': ['target.ignoresMouseEvents = saved.1', 'target.ignoresMouseEvents = true'],
      'no-end-cancel': ['        cancelWatches()\n        backdrop.surfaceOut()', '        backdrop.surfaceOut()'],
      'no-exposure-timer': ['source.setEventHandler { [weak self] in self?.end() }', 'source.setEventHandler {}'],
      'repeating-exposure': ['source.schedule(deadline: .now() + timeoutSeconds,', 'source.schedule(deadline: .now() + 0.01, repeating: 0.01,'],
      'allow-owner-present': [source.slice(source.indexOf('        guard timeoutSeconds.isFinite'), source.indexOf('        savedTargets =')),
        '        guard timeoutSeconds.isFinite && timeoutSeconds > 0 && timeoutSeconds <= 240 else { return false }\n'],
      'extend-deadline': ['guard !raised else { return true }', 'if raised { end() }'],
      'lower-backdrop': ['backdrop.surfaceLevel = normal + 1', 'backdrop.surfaceLevel = normal - 1'],
      'skip-backdrop-out': ['backdrop.surfaceOut();', ''],
      'skip-signal-cleanup': ['stageBenchCleanupOnMain(); exit(128 + number)', '_exit(128 + number)'],
    };
    if (mutations[variant]) { const [before, after] = mutations[variant]; assert.ok(source.includes(before)); source = source.replace(before, after); }
    writeFileSync(main, `import Foundation\nimport Darwin\n${source}\n` + `
final class Window: StageBenchSurfaceWindow {
  var ignoresMouseEvents = false { didSet { emit("mouse \\(name) \\(ignoresMouseEvents)") } }
  let name: String; var surfaceLevel: Int { didSet { emit("level \\(name) \\(surfaceLevel)") } }
  init(_ name: String, _ level: Int) { self.name = name; self.surfaceLevel = level }
  func surfaceFront() { emit("front \\(name) \\(surfaceLevel)") }
  func surfaceOut() { emit("out \\(name) \\(surfaceLevel)") }
}
func emit(_ text: String) { FileHandle.standardOutput.write(Data((text + "\\n").utf8)) }
let background = Window("backdrop", -1), targets = [Window("a", 0), Window("b", 0), Window("person", 0)]
let mode = CommandLine.arguments[1]
let marker = CommandLine.arguments[2]
FileManager.default.createFile(atPath: marker, contents: Data())
let automatic = ["deadline", "repeat"].contains(mode)
let surface = StageBenchSurface(backdrop: background, targets: targets, normal: 0, character: 3)
var closed = false
stageBenchInstallStops { if !closed { closed = true; surface.end(); emit("cleaned") } }
if mode == "bounds" {
  precondition(stageBenchExposureSeconds(control: true) == 180)
  precondition(stageBenchExposureSeconds(control: false) == 240)
  for timeout in [0.0, -1, 241, Double.infinity, Double.nan] {
    precondition(!surface.begin(timeoutSeconds: timeout, ownerAwayFile: marker))
  }
  precondition(surface.begin(timeoutSeconds: 240, ownerAwayFile: marker)); surface.end()
  let directory = marker + "-dir"
  FileManager.default.createFile(atPath: marker, contents: Data())
  FileManager.default.createFile(atPath: "relative-away", contents: Data())
  try! FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: false)
  precondition(stageBenchOwnerAway(marker))
  precondition(!stageBenchOwnerAway("relative-away"))
  precondition(!stageBenchOwnerAway(directory))
  precondition(stageBenchArgumentsValid(["--hand"]))
  precondition(stageBenchArgumentsValid(["--hand", "--owner-away-file", marker]))
  for invalid in [[], ["--hand", "--owner-away-file", "relative-away"], ["--hand", "--wrong", marker], ["--hand", "extra"]] {
    precondition(!stageBenchArgumentsValid(invalid))
  }
  emit("bounds checked"); exit(0)
}
if mode == "quiet" { emit("quiet \\(background.surfaceLevel)"); exit(0) }
if mode == "already-returned" {
  precondition(!surface.begin(ownerAwayFile: marker + "-absent"))
  precondition(!surface.raised); emit("refused"); exit(0)
}
if automatic || mode == "repeat" || mode == "restore-original" {
  FileManager.default.createFile(atPath: marker, contents: Data())
  if mode == "restore-original" { targets[1].ignoresMouseEvents = true; targets[1].surfaceLevel = -2 }
  precondition(surface.begin(timeoutSeconds: automatic ? 0.06 : 2, ownerAwayFile: marker))
  if mode == "restore-original" {
    surface.end(); surface.end()
    precondition(targets[1].ignoresMouseEvents && targets[1].surfaceLevel == -2)
    precondition(!targets[0].ignoresMouseEvents && targets[0].surfaceLevel == 0)
    emit("original restored"); exit(0)
  }
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) {
    precondition(surface.raised)
    if mode == "repeat" { precondition(surface.begin(timeoutSeconds: 240, ownerAwayFile: marker)) }
  }
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.10) {
    precondition(!surface.raised)
    precondition(surface.wakeSources.isEmpty)
    precondition(targets.allSatisfy { $0.surfaceLevel == 0 && !$0.ignoresMouseEvents })
    emit(mode == "repeat" ? "deadline not extended" : "automatic lowered"); exit(0)
  }
  RunLoop.main.run()
}
surface.begin(ownerAwayFile: marker)
if mode == "end" { surface.end(); emit("restored \\(background.surfaceLevel) \\(targets.map { $0.surfaceLevel })"); exit(0) }
if mode == "protocol" { DispatchQueue.global().async { exit(65) }; RunLoop.main.run() }
if mode == "crash" { raise(SIGKILL); exit(99) }
if let number = Int32(mode) { DispatchQueue.main.async { Darwin.kill(getpid(), number) }; RunLoop.main.run() }
exit(0)
`);
    const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), main, '-o', binary],
      { encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL' });
    assertChildStatus(build, 0, build.stderr);
    for (const mode of ['bounds', 'deadline', 'repeat', 'restore-original', 'already-returned']) {
      const result = spawnSync(binary, [mode, join(root, 'away-' + mode)], { cwd: root, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
      assertChildStatus(result, 0, mode + result.stderr);
      assert.match(result.stdout, mode === 'bounds' ? /bounds checked/ : mode === 'repeat' ? /deadline not extended/ : mode === 'restore-original' ? /original restored/ :
        mode === 'already-returned' ? /refused/ : /automatic lowered/);
      if (mode === 'already-returned') assert.doesNotMatch(result.stdout, /front backdrop/);
    }
    for (const [mode, code] of [['quiet', 0], ['end', 0], ['normal', 0], ['protocol', 65], ['2', 130], ['15', 143], ['1', 129], ['3', 131], ['13', 141]]) {
      const result = spawnSync(binary, [mode, join(root, 'away-' + mode)], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
      assertChildStatus(result, code, mode + result.stderr);
      if (mode !== 'quiet') assert.match(result.stdout, /front backdrop 1/);
      assert.match(result.stdout, /out backdrop/); assert.match(result.stdout, /level backdrop -1/);
      if (mode !== 'quiet') for (const name of ['a', 'b', 'person']) {
        assert.match(result.stdout, new RegExp('mouse ' + name + ' true'));
        assert.match(result.stdout, new RegExp('level ' + name + ' 0'));
        assert.match(result.stdout, new RegExp('mouse ' + name + ' false'));
        assert.ok(result.stdout.indexOf('out backdrop') < result.stdout.lastIndexOf('mouse ' + name + ' false'));
      }
      assert.match(result.stdout, /cleaned/);
    }
    const crash = spawnSync(binary, ['crash', join(root, 'away-crash')], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
    assert.equal(crash.signal, 'SIGKILL'); assert.match(crash.stdout, /front backdrop 1/);
    // Fatal process loss relies on WindowServer destroying process-owned windows. This fake creates zero windows.
  });

test('INT26 short interior WindowServer intervals retain CPU and time when merging with a neighbor', () => {
  for (const times of [[0, 40, 1000, 2000], [0, 1000, 1040, 2000]]) {
    const rows = times.map((t, i) => ({ t, ws: [0, 0.01, 0.1, 0.2][i], hosts: {} }));
    if (times[1] === 1000) rows.forEach((r, i) => { r.ws = [0, 0.1, 0.12, 0.2][i]; });
    assert.equal(sampler.summarize(rows, { peakSamplePeriodMs: 1000 }).windowServer.peakPct, 10);
    assert.equal(sampler.summarize(rows, { peakSamplePeriodMs: 1000 }).windowServer.avgPct, 10);
  }
  const ending = [[0, 0], [1000, 0.1], [1040, 0.12], [1042, 0.121]].map(([t, ws]) => ({ t, ws, hosts: {} }));
  assert.equal(sampler.summarize(ending, { peakSamplePeriodMs: 1000 }).windowServer.peakPct, 11.54,
    'an interior sample next to the short terminal tail merges backward instead of disappearing');
});
