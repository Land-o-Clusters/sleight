import { tmpdir } from 'node:os';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { macCommandSkip } from './requirements.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { prepareStageCharacter, stageCostSource } from '../bench/hand/stage-live.mjs';

let binary, pack, folder;
after(() => { if (folder) rmSync(folder, { recursive: true, force: true }); });
function build() {
  if (binary) return;
  folder = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-chv11-'))));
  let source = readFileSync(process.env.CHV11_PARENT_SOURCE ?? new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  if (process.env.CHV11_BROKEN === 'policy') {
    const site = 'if panel.sharingType != sharing { panel.sharingType = sharing }';
    assert.ok(source.includes(site), 'policy mutation site');
    source = source.replace(site, 'panel.sharingType = sharing');
  }
  const start = source.indexOf('    func install(_ plan: PerchPlan'), end = source.indexOf('    // Three z glyphs', start);
  assert.ok(start >= 0 && end > start);
  const install = source.slice(start, end).replaceAll('makeHandPanel(', 'chv9MakePanel(').replaceAll('appKitRect(', 'chv9AppKitRect(')
    .replace(/^#if SLEIGHT_STAGE_BENCH\n[\s\S]*?^#endif\n/gm, '');
  const zsStart = source.indexOf('    func perchZs('), zsEnd = source.indexOf('    func fadeOut(', zsStart);
  let fixture = readFileSync(new URL('./fixtures/chv9-install.swift', import.meta.url), 'utf8')
    .replace('// PRODUCTION INSTALL', install + source.slice(zsStart, zsEnd)).replace('// BROKEN INSTALLERS', '')
    .replace('var frame = CGRect.zero, isVisible = false, sharingType = NSWindow.SharingType.none, ignoresMouseEvents = true', `
    var frame = CGRect.zero, isVisible = false
    var sharingWrites = 0, hitWrites = 0
    var sharingType = NSWindow.SharingType.none { didSet { sharingWrites += 1 } }
    var ignoresMouseEvents = true { didSet { hitWrites += 1 } }`)
    .replace('func chv9MakePanel(capture: String) -> Chv9Panel { Chv9Panel() }', `
func chv9MakePanel(capture: String) -> Chv9Panel {
    let panel = Chv9Panel(); panel.sharingType = handCaptureModes[capture] ?? .none
    panel.sharingWrites = 0; return panel
}`)
    .replace('installer.runtime.book.enabled = false', 'installer.runtime.book.enabled = false; installer.host!.capture = raw["capture"] as? String ?? "hidden"')
    .replace(/    switch broken \{[\s\S]*?    default: break\n    \}/, '')
    .replace('rows.append(["extra": extra,', `
        let firstWrites = [installer.panel!.sharingWrites, installer.panel!.hitWrites]
        installer.install(plan, stageMetrics: stage ? metrics : nil, stagePose: art)
        let repeatWrites = [installer.panel!.sharingWrites, installer.panel!.hitWrites]
        installer.panel!.sharingType = .readOnly; installer.panel!.ignoresMouseEvents = false
        let beforeRepair = [installer.panel!.sharingWrites, installer.panel!.hitWrites]
        installer.install(plan, stageMetrics: stage ? metrics : nil, stagePose: art)
        let repairWrites = [installer.panel!.sharingWrites - beforeRepair[0], installer.panel!.hitWrites - beforeRepair[1]]
        rows.append(["firstWrites": firstWrites, "repeatWrites": repeatWrites, "repairWrites": repairWrites,
            "safe": HandPanelPolicy(installer.panel!).stageSafe, "sharing": HandPanelPolicy(installer.panel!).captureName, "hitAreas": HandPanelPolicy(installer.panel!).hitAreas, "extra": extra,`);
  const worldStart = source.indexOf('func perchWorld('), worldEnd = source.indexOf('// END PERCH', worldStart);
  source = source.slice(0, worldStart) + source.slice(worldStart, worldEnd).replaceAll('NSScreen.screens', 'chv11Screens') + source.slice(worldEnd);
  fixture += '\n' + readFileSync(new URL('./fixtures/chv11-world.swift', import.meta.url), 'utf8');
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
  pack = prepareStageCharacter(folder, process.env.CHV11_BENCH_PACK);
}
function run(mode, input = {}) {
  build();
  const ran = spawnSync(binary, [mode === 'world' ? '--chv11-world' : '--chv9-install'], {
    input: JSON.stringify({ mode: 'crop', path: 'stage', frame: pack.frame, windows: [], ...input }) + '\n',
    encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 4 << 20,
    env: { ...process.env, SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: pack.root },
  });
  assertChildStatus(ran, 0, ran.stderr); return JSON.parse(ran.stdout);
}
const native = { skip: macCommandSkip('xcrun'), timeout: 900000 };
test('CHV11 stage install preserves art and avoids repeated window policy writes', native, t => {
  const [row] = run('policy'); t.diagnostic(JSON.stringify(row));
  assert.equal(row.changed, 0); assert.equal(row.comparisons, 192);
  assert.deepEqual(row.firstWrites, [0, 0]); assert.deepEqual(row.repeatWrites, [0, 0]);
  assert.deepEqual(row.repairWrites, [1, 1]); assert.equal(row.safe, true);
});
test('CHV11 legacy install repairs unsafe panel policy', native, () => {
  const [row] = run('policy', { path: 'legacy' });
  assert.equal(row.changed, 0); assert.deepEqual(row.firstWrites, [0, 0]);
  assert.deepEqual(row.repeatWrites, [0, 0]); assert.deepEqual(row.repairWrites, [1, 1]); assert.equal(row.safe, true);
});
test('CHV11 recorded CG rectangles silently re-seat in both directions under CHV12', native, t => {
  const rows = run('world'); t.diagnostic(JSON.stringify(rows));
  for (const row of rows) {
    assert.equal(row.hides, 0); assert.equal(row.reason, 'none');
    assert.equal(row.afterMoveShown, true); assert.equal(row.afterReturnShown, true);
    assert.deepEqual(row.afterReturnFrame, row.observed);
  }
});
test('CHV11 three-point move hides and returns under CHV12', native, () => {
  const rows = run('world', { threePoint: true });
  for (const row of rows) {
    assert.equal(row.hides, 1); assert.equal(row.reason, 'moved');
    assert.equal(row.afterMoveShown, false); assert.equal(row.afterReturnShown, true);
    assert.deepEqual(row.afterReturnFrame, row.observed);
  }
});

test('CHV11 legacy visible capture survives install and repair', native, () => {
  const [row] = run('policy', { path: 'legacy', capture: 'visible' });
  assert.equal(row.changed, 0); assert.equal(row.sharing, 'readOnly'); assert.equal(row.hitAreas, 0);
  assert.deepEqual(row.firstWrites, [0, 0]); assert.deepEqual(row.repeatWrites, [0, 0]);
  assert.deepEqual(row.repairWrites, [0, 1]);
});
test('CHV11 stage capture policy follows the requested visible capture like the legacy path', native, () => {
  // Owner, 2026-11-09: stage panels honor `hand capture visible` (hidden stays the default) so recordings can show them.
  const [row] = run('policy', { capture: 'visible' });
  assert.equal(row.changed, 0); assert.equal(row.sharing, 'readOnly'); assert.equal(row.hitAreas, 0);
  assert.deepEqual(row.firstWrites, [0, 0]); assert.deepEqual(row.repeatWrites, [0, 0]);
  assert.deepEqual(row.repairWrites, [0, 1]);
});
test('CHV11 stage capture policy stays hidden when the requested capture is hidden', native, () => {
  const [row] = run('policy', { capture: 'hidden' });
  assert.equal(row.changed, 0); assert.equal(row.safe, true); assert.equal(row.sharing, 'none'); assert.equal(row.hitAreas, 0);
});
