import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { macCommandSkip } from './requirements.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { prepareStageCharacter, stageCostSource } from '../bench/hand/stage-live.mjs';
import { stageSequence } from '../bench/hand/stage-cost.mjs';
import { cursorWire } from '../bench/hand/cursor-sequence.mjs';

let binary, pack, folder;
after(() => { if (folder) rmSync(folder, { recursive: true, force: true }); });
function build() {
  if (binary) return;
  folder = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-chv12-'))));
  let source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  const mutations = {
    exact: ['stageWindowEdgeDifference(a, b) <= 2', 'a == b'],
    'no-anchor': ['moving ?? reseatAnchor ?? seat.frame', 'moving ?? seat.frame'],
    'no-order-out': ['if panel.isVisible && panel.frame != appKitRect(target) { panel.orderOut(nil) }', '// Visible relocation left on screen.'],
    'no-badge': ['host?.pauseOverlay.translate(delta, owner: panel)', '// Badge translation omitted.'],
    'old-art': ['root?.removeFromSuperlayer() // Exclude old art before AppKit can submit a frame change.', '// Old art retained across the frame assignment.'],
  };
  if (process.env.CHV12_BROKEN && process.env.CHV12_BROKEN !== 'no-pause-target') {
    const [site, replacement] = mutations[process.env.CHV12_BROKEN] ?? [];
    assert.ok(site && source.includes(site), 'mutation site'); source = source.replace(site, replacement);
  }
  const start = source.indexOf('    func install(_ plan: PerchPlan'), end = source.indexOf('    // Three z glyphs', start);
  assert.ok(start >= 0 && end > start);
  const install = source.slice(start, end).replaceAll('makeHandPanel(', 'chv9MakePanel(').replaceAll('appKitRect(', 'chv9AppKitRect(')
    .replace('root?.removeFromSuperlayer() // Exclude old art before AppKit can submit a frame change.', 'root?.removeFromSuperlayer(); panel.record("detach")')
    .replaceAll('CATransaction.commit()', 'CATransaction.commit(); panel.record("commit")')
    .replaceAll('CATransaction.flush()', 'CATransaction.flush(); panel.record("flush")')
    .replace(/^#if SLEIGHT_STAGE_BENCH\n[\s\S]*?^#endif\n/gm, '');
  const zsStart = source.indexOf('    func perchZs('), zsEnd = source.indexOf('    func fadeOut(', zsStart);
  const reseatStart = source.indexOf('    @discardableResult func reseat('), reseatEnd = source.indexOf('    func install(_ plan: PerchPlan', reseatStart);
  assert.ok(reseatStart >= 0 && reseatEnd > reseatStart);
  const reseat = source.slice(reseatStart, reseatEnd).replaceAll('appKitRect(', 'chv9AppKitRect(');
  const overlayStart = source.indexOf('final class CursorPauseOverlay {');
  const overlayEnd = source.indexOf('// Validation and geometry only.', overlayStart);
  assert.ok(overlayStart >= 0 && overlayEnd > overlayStart);
  // Keep production scheduling, ownership and translation; replace only window/view construction.
  const overlay = source.slice(overlayStart, overlayEnd).replace('class CursorPauseOverlay', 'class Chv12Badge')
    .replaceAll('CursorPausePanel', 'Chv12BadgePanel')
    .replace(/            let panel = Chv12BadgePanel\(contentRect:[\s\S]*?            self.panel = panel/, '            let panel = Chv12BadgePanel(frame: chv9AppKitRect(badge))\n            self.panel = panel')
    .replace('DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)', 'chv12BadgeScheduled.append(item)');
  let fixture = readFileSync(new URL('./fixtures/chv9-install.swift', import.meta.url), 'utf8')
    .replace('final class Chv9Owner {', `
var chv12BadgeScheduled: [DispatchWorkItem] = []
final class Chv12BadgePanel {
    var frame: CGRect, contentView: AnyObject?, ignoresMouseEvents = true
    init(frame: CGRect) { self.frame = frame }
    func setFrame(_ frame: CGRect, display: Bool) { self.frame = frame }
    func orderFrontRegardless() {}
    func orderOut(_ sender: Any?) {}
    func close() {}
}
${overlay}
final class Chv9Owner {
    let pauseOverlay = Chv12Badge()`)
    .replace('// PRODUCTION INSTALL', reseat + install + source.slice(zsStart, zsEnd)).replace('// BROKEN INSTALLERS', '')
    .replace('var frame = CGRect.null, panelGenerations = 0', 'var frame = CGRect.null, panelGenerations = 0; var bubble: Chv9Panel?')
    .replace(/    switch broken \{[\s\S]*?    default: break\n    \}/, '')
    .replace('    func setFrame(_ r: CGRect, display: Bool) {', `
    var operations: [[String: Any]] = []
    func record(_ op: String) {
        operations.append(["op": op, "disabled": CATransaction.disableActions(),
            "oldLayers": contentView?.layer?.sublayers?.count ?? 0, "visible": isVisible])
    }
    func setFrame(_ r: CGRect, display: Bool) { record("frame");`)
    .replace('func orderOut(_ sender: Any?) { isVisible = false }', 'func orderOut(_ sender: Any?) { record("out"); isVisible = false }')
    .replace('func orderFrontRegardless() { isVisible = true }', 'func orderFrontRegardless() { record("front"); isVisible = true }')
    .replace('        installer.install(plan, stageMetrics: stage ? metrics : nil, stagePose: art)\n        let layer', `
        installer.install(plan, stageMetrics: stage ? metrics : nil, stagePose: art)
        installer.panel!.operations = []
        let relocation = raw["same"] as? Bool == true ? CGPoint.zero : CGPoint(x: 17, y: 9)
        plan.positions = plan.positions.map { ($0.0, CGPoint(x: $0.1.x + relocation.x, y: $0.1.y + relocation.y)) }
        installer.install(plan, stageMetrics: stage ? metrics : nil, stagePose: art)
        let operations = installer.panel!.operations
        let layer`)
    .replace('        let logical = stage ?', '        var logical = stage ?')
    .replace('        let clip = stage ?', '        var clip = stage ?')
    .replace('        let operations = installer.panel!.operations', `
        logical = logical.offsetBy(dx: relocation.x, dy: relocation.y); clip = clip.offsetBy(dx: relocation.x, dy: relocation.y)
        let operations = installer.panel!.operations`)
    .replace('rows.append(["extra": extra,', 'rows.append(["operations": operations, "extra": extra,');
  const worldStart = source.indexOf('func perchWorld('), worldEnd = source.indexOf('// END PERCH', worldStart);
  source = source.slice(0, worldStart) + source.slice(worldStart, worldEnd).replaceAll('NSScreen.screens', 'chv12Screens') + source.slice(worldEnd);
  fixture += '\n' + readFileSync(new URL('./fixtures/chv12-runtime.swift', import.meta.url), 'utf8');
  let bench = readFileSync(new URL('../bench/hand/stage-fixture.swift', import.meta.url), 'utf8');
  if (process.env.CHV12_BROKEN === 'no-pause-target') bench = bench.replaceAll(/            host.pauseTarget = .*\n/g, '');
  const ingress = bench.slice(bench.indexOf('        case let .aim(_, ev), let .status(_, ev):', bench.indexOf('    func command(')), bench.indexOf('    func cleanup()'));
  const pauseStart = source.indexOf('    func pauseChanged(_ paused: Bool)'), pauseEnd = source.indexOf('    var settingsMenu', pauseStart);
  assert.ok(ingress.includes('host.ringFrame') && pauseStart >= 0 && pauseEnd > pauseStart);
  fixture += '\n' + readFileSync(new URL('./fixtures/chv14-park.swift', import.meta.url), 'utf8')
    .replace('// PRODUCTION PAUSE', source.slice(pauseStart, pauseEnd))
    .replace('// FIXTURE INGRESS', ingress);
  source = stageCostSource(source);
  const seam = 'let arguments = Array(CommandLine.arguments.dropFirst(channelValidationOnly ? 2 : 1))';
  assert.equal(source.split(seam).length, 2);
  source = source.replace(seam, fixture + '\n' + seam) + '\n' + readFileSync(new URL('../bench/hand/stage-fixture.swift', import.meta.url), 'utf8');
  // Admit only this test's canonical bank on every temporary volume.
  const bankGuard = 'env["SLEIGHT_CURSOR_CHARACTERS_ROOT"], p.hasPrefix(' + JSON.stringify(join('/', 'private', 'tmp') + '/') + ')';
  assert.ok(source.includes(bankGuard), 'character bank guard');
  source = source.replace(bankGuard, 'env["SLEIGHT_CURSOR_CHARACTERS_ROOT"], p.hasPrefix(' + JSON.stringify(folder + '/') + ')');
  const input = join(folder, 'main.swift'); binary = join(folder, 'host'); writeFileSync(input, source);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-O', '-D', 'CHV9_GEOMETRY', '-D', 'SLEIGHT_STAGE_BENCH',
    '-module-cache-path', swiftModuleCache(), input, '-o', binary],
  { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr);
  pack = prepareStageCharacter(folder, process.env.CHV12_BENCH_PACK);
}
function run(mode, input = {}) {
  build();
  const ran = spawnSync(binary, [mode === 'runtime' ? '--chv12-runtime' : mode === 'park' ? '--chv14-park' : '--chv9-install'], {
    input: JSON.stringify({ mode: 'crop', path: 'stage', frame: pack.frame, windows: [], ...input }) + '\n',
    encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 4 << 20,
    env: { ...process.env, SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: pack.root },
  });
  assertChildStatus(ran, 0, ran.stderr); return JSON.parse(ran.stdout);
}
const native = { skip: macCommandSkip('xcrun'), timeout: 900000 };
test('CHV12 recorded pair silently re-seats in both directions without resetting the plan clock', native, t => {
  const rows = run('runtime'); t.diagnostic(JSON.stringify(rows));
  for (const row of rows) {
    assert.equal(row.hides, 0); assert.equal(row.draws, 0); assert.equal(row.reseats, 1);
    assert.equal(row.shown, true); assert.deepEqual(row.seatFrame, row.observed);
    assert.equal(row.began, row.originalBegan); assert.deepEqual(row.timers, row.originalTimers);
    assert.equal(row.diagnostics.legacySilentReseats, 1); assert.equal(row.diagnostics.legacyMaxSilentReseatDifferencePt, 1);
  }
});
test('CHV12 a three-point move hides until the original half-second return', native, () => {
  for (const row of run('runtime', { dx: 3 })) {
    assert.equal(row.hides, 1); assert.equal(row.reseats, 0);
    assert.equal(row.shown, false); assert.equal(row.beforeReturn, false); assert.equal(row.afterReturn, true);
    assert.deepEqual(row.returnFrame, row.observed);
  }
});
test('CHV12 alternating CG frames never hide or accumulate seat drift', native, () => {
  for (const row of run('runtime', { repeats: 100 })) {
    assert.equal(row.hides, 0); assert.equal(row.draws, 0); assert.equal(row.reseats, 100);
    assert.equal(row.maximumSeatError, 0); assert.equal(row.diagnostics.legacySilentReseats, 100);
    assert.equal(row.diagnostics.legacyMaxSilentReseatDifferencePt, 1);
  }
});
test('CHV12 movement compares every edge including the far edge at the two-point boundary', native, () => {
  const [row] = run('runtime', { edges: true });
  assert.deepEqual(row.accepted, [true, true, false, false]);
});
test('CHV12 stage uses the same movement boundary while retaining distant geometry protection', native, t => {
  const [row] = run('runtime', { stage: true }); t.diagnostic(JSON.stringify(row));
  assert.equal(row.hides, 0); assert.equal(row.shown, true); assert.equal(row.wide, 0);
  assert.equal(row.draws, 0); assert.equal(row.reseats, 1); assert.equal(row.clockPreserved, true);
  assert.equal(row.distantWide, 1);
});
test('CHV12 stage alternation preserves its clock and stays at the observed window', native, () => {
  for (const row of run('runtime', { stage: true, repeats: 100, bothDirections: true })) {
    assert.equal(row.hides, 0); assert.equal(row.draws, 0); assert.equal(row.reseats, 100);
    assert.equal(row.clockPreserved, true); assert.equal(row.maximumSeatError, 0);
  }
});
test('CHV12 a one-point seating correction still widens an uncertified action target', native, () => {
  const [row] = run('runtime', { stage: true, target: true });
  assert.equal(row.wide, 1, 'seating tolerance cannot certify target geometry');
  assert.equal(row.distantWide, 1, 'a later observation retains the widened obligation');
});
test('CHV12 a small correction never postpones the end of an authored stage reaction', native, () => {
  for (const noStage of [false, true]) {
    const [row] = run('runtime', { stage: true, reaction: true, noStage });
    assert.equal(row.reaction, 'perch'); assert.equal(row.installedReaction, 'perch'); assert.equal(row.draws, 1);
  }
});
test('CHV12 a late active-call result suppresses a stage re-seat at application', native, () => {
  const [row] = run('runtime', { call: true });
  assert.equal(row.hidden, true); assert.equal(row.reason, 'call'); assert.equal(row.shown, false);
});
test('CHV12 small decisions retain contemporaneous fixture AppKit and CG rectangles', native, () => {
  for (const dx of [1, 3]) {
    for (const row of run('runtime', { dx, fixture: true })) {
      const decision = row.diagnostics.legacyWindowDecisions.at(-1);
      assert.equal(decision.decision, dx === 1 ? 'silent-reseat' : 'moved');
      assert.deepEqual(decision.observed, row.observed);
      assert.deepEqual(decision.fixture.appKitFrame, [30, 40, 666, 350]);
      assert.deepEqual(decision.fixture.topLeftFrame, [30, 592, 666, 350]);
      assert.equal(decision.time, 0.1);
    }
  }
});
test('CHV12 silent legacy re-seat moves only the panel and preserves the installed layers', native, () => {
  const [row] = run('runtime', { panel: true });
  assert.equal(row.sameRoot, true); assert.equal(row.sameLayer, true);
  assert.deepEqual(row.delta, [1, 0]); assert.deepEqual(row.operations.map(op => op.op), ['frame']);
  assert.equal(row.operations[0].disabled, true); assert.equal(row.shown, true);
});
for (const path of ['stage', 'legacy']) {
  test(`CHV14 ${path} cropped relocation hides old art before frame submission and preserves pixels`, native, t => {
    const [row] = run('install', { path }); t.diagnostic(JSON.stringify(row));
    assert.equal(row.changed, 0); assert.equal(row.comparisons, 192); assert.equal(row.enclosed, true);
    assert.deepEqual(row.operations.map(op => op.op), ['out', 'detach', 'frame', 'commit', 'front']);
    assert.equal(row.operations[2].disabled, true); assert.equal(row.operations[2].oldLayers, 0);
    assert.equal(row.operations[2].visible, false);
    assert.equal(row.operations[1].disabled, true);
  });
}

test('CHV14 small cost sequence publishes a panel at active-end and throughout parking', native, t => {
  const windows = [{ pid: 42, id: 7, bounds: { x: 30, y: 592, width: 666, height: 350 } },
    { pid: 42, id: 8, bounds: { x: 816, y: 592, width: 666, height: 350 } }];
  const wire = cursorWire('a'.repeat(64));
  const steps = stageSequence(windows).steps.map(step => ({ atMs: step.atMs, frame: JSON.parse(wire[step.type](step.args)) }));
  const [row] = run('park', { windows, steps }); t.diagnostic(JSON.stringify(row));
  assert.equal(row.steps, 127); assert.ok(row.installs > 100);
  assert.equal(row.savedTarget, true); assert.equal(row.paused, true);
  for (const boundary of row.boundaries) {
    assert.equal(boundary.shown, true, boundary.name);
    assert.ok(boundary.panelID > 0, boundary.name);
  }
  assert.equal(row.boundaries[1].panelID, row.boundaries[2].panelID);
  assert.equal(row.parkedInstalls, 0); assert.equal(row.parkedHides, 0);
});

test('CHV12B monotone one-point polls hide at three points and return through full placement', native, t => {
  const [row] = run('runtime', { walk: true }); t.diagnostic(JSON.stringify(row));
  assert.deepEqual(row.hideAt, [3]); assert.equal(row.reseats, 2);
  assert.equal(row.beforeReturn, false); assert.equal(row.afterReturn, true);
  assert.equal(row.returnKind, 'return'); assert.deepEqual(row.returnFrame, [32, 592, 668, 350]);
  assert.deepEqual(row.afterNewAnchor, [true, true, false]);
});
test('CHV12B slow upward movement rechecks headroom on return', native, () => {
  const [row] = run('runtime', { walk: true, headroom: true });
  assert.deepEqual(row.hideAt, [3]); assert.equal(row.afterReturn, false);
  assert.equal(row.returnReason, 'headroom');
});
test('CHV12B silent re-seat translates badge and bubble with the panel', native, () => {
  for (const [dy, delta, pending, delayed] of [
    [0, [1, 0], [101, 200, 24, 24], [101, 758, 24, 24]],
    [-2, [1, 2], [101, 198, 24, 24], [101, 760, 24, 24]],
  ]) {
    const [row] = run('runtime', { panel: true, dy });
    assert.deepEqual(row.badgeDelta, delta); assert.deepEqual(row.bubbleDelta, delta);
    assert.deepEqual(row.pendingBadge, pending);
    assert.deepEqual(row.delayedBadge, delayed);
    assert.equal(row.otherOwnerUnchanged, true); assert.equal(row.pendingCancelled, false);
    assert.equal(row.pendingCount, 1); assert.equal(row.pendingAfterShow, false);
  }
});

for (const path of ['stage', 'legacy']) {
  test(`CHV12B ${path} unchanged panel rebuild keeps one transaction without a blank flush`, native, () => {
    const [row] = run('install', { path, same: true });
    assert.equal(row.changed, 0); assert.equal(row.comparisons, 192);
    assert.deepEqual(row.operations.map(op => op.op), ['detach', 'commit']);
  });
}
