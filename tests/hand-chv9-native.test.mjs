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
import { stageSequence } from '../bench/hand/stage-cost.mjs';

let binary, pack, folder;
after(() => { if (folder) rmSync(folder, { recursive: true, force: true }); });
function host(t) {
  if (binary) return binary;
  folder = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-chv9-'))));
  let source = readFileSync(process.env.CHV9_PARENT_SOURCE ?? new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  const start = source.indexOf('    func install(_ plan: PerchPlan'), end = source.indexOf('    // Three z glyphs', start);
  assert.ok(start >= 0 && end > start);
  const bench = source.includes('struct SpritePanelGeometry');
  const install = source.slice(start, end).replaceAll('makeHandPanel(', 'chv9MakePanel(').replaceAll('appKitRect(', 'chv9AppKitRect(')
    .replace(/^#if SLEIGHT_STAGE_BENCH\n[\s\S]*?^#endif\n/gm, '');
  const zsStart = source.indexOf('    func perchZs('), zsEnd = source.indexOf('    func fadeOut(', zsStart);
  assert.ok(zsStart >= 0 && zsEnd > zsStart);
  const geometryStart = source.indexOf('func spritePanelGeometry('), geometryEnd = source.indexOf('// END SPRITE PANEL GEOMETRY', geometryStart);
  const brokenGeometry = bench ? source.slice(geometryStart, geometryEnd).replace('func spritePanelGeometry(', 'func chv9BrokenFlipGeometry(')
    .replace('(pose.entry.flip ? metrics.size.width - size.width : 0)', '0') : '';
  const brokenInstallers = bench ? [
    ['NoCrop', install.replace('let target = geometry.target', 'let target = logicalPanel')],
    ['Extras', install.replace('clip: drawingClip, hasExtras: hasExtras)', 'clip: drawingClip, hasExtras: false)')],
    ['Flip', install.replace('let geometry = spritePanelGeometry(', 'let geometry = chv9BrokenFlipGeometry(')],
  ].map(([name, body]) => `final class Chv9Broken${name}: Chv9Installer {\n${body.replace('    func install(', '    override func install(')}\n}`).join('\n') + '\n' + brokenGeometry : '';
  const fixture = readFileSync(new URL('./fixtures/chv9-install.swift', import.meta.url), 'utf8')
    .replace('// PRODUCTION INSTALL', install + source.slice(zsStart, zsEnd)).replace('// BROKEN INSTALLERS', brokenInstallers);
  const seam = 'let arguments = Array(CommandLine.arguments.dropFirst(channelValidationOnly ? 2 : 1))';
  assert.equal(source.split(seam).length, 2);
  if (bench) source = stageCostSource(source);
  source = source.replace(seam, fixture + '\n' + seam);
  if (bench) source += '\n' + readFileSync(new URL('../bench/hand/stage-fixture.swift', import.meta.url), 'utf8');
  const mutations = {
    'no-crop': ['let target = geometry.target', 'let target = logicalPanel'],
    'extras': ['clip: drawingClip, hasExtras: hasExtras)', 'clip: drawingClip, hasExtras: false)'],
    'flip-shift': ['(pose.entry.flip ? metrics.size.width - size.width : 0)', '0'],
    'wrong-cell': ['let cell = stagePose?.cell ?? character.frame.cell', 'let cell = character.frame.cell'],
    'roundoff': ['!stageSameWindowBounds(world.window, still)', 'world.window != still'],
    'dedup': ['guard seen.insert(SpritePanelPoseKey(sheet: pose.entry.sheet, scale: pose.entry.scale, flip: pose.entry.flip)).inserted else { continue }',
      'seen.insert(SpritePanelPoseKey(sheet: pose.entry.sheet, scale: pose.entry.scale, flip: pose.entry.flip))'],
  };
  if (process.env.CHV9_BROKEN) {
    const pair = mutations[process.env.CHV9_BROKEN]; assert.ok(pair && source.includes(pair[0]), 'production mutation site');
    source = source.replaceAll(pair[0], pair[1]);
  }
  // Admit only this test's canonical bank on every temporary volume.
  const bankGuard = 'env["SLEIGHT_CURSOR_CHARACTERS_ROOT"], p.hasPrefix(' + JSON.stringify(join('/', 'private', 'tmp') + '/') + ')';
  assert.ok(source.includes(bankGuard), 'character bank guard');
  source = source.replace(bankGuard, 'env["SLEIGHT_CURSOR_CHARACTERS_ROOT"], p.hasPrefix(' + JSON.stringify(folder + '/') + ')');
  const input = join(folder, 'main.swift'); binary = join(folder, 'host'); writeFileSync(input, source);
  const flags = bench ? ['-D', 'CHV9_GEOMETRY', '-D', 'SLEIGHT_STAGE_BENCH'] : [];
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-O', ...flags, '-module-cache-path', swiftModuleCache(), input, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr);
  pack = prepareStageCharacter(folder, process.env.CHV9_BENCH_PACK);
  return binary;
}
function run(t, mode, extra = {}) {
  const executable = host(t);
  const windows = [{ pid: 42, id: 7, bounds: { x: 30, y: 592, width: 666, height: 350 } },
    { pid: 42, id: 8, bounds: { x: 816, y: 592, width: 666, height: 350 } }];
  const sequence = stageSequence(windows);
  const ran = spawnSync(executable, ['--chv9-install'], {
    input: JSON.stringify({ mode, frame: pack.frame, windows, steps: sequence.steps, ...extra }) + '\n',
    encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 4 << 20,
    env: { ...process.env, SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: pack.root },
  });
  assertChildStatus(ran, 0, ran.stderr);
  return JSON.parse(ran.stdout);
}
test('CHV9 small cost sequence keeps the target window frame through crop and observations', {
  skip: macCommandSkip('xcrun'), timeout: 900000,
}, t => {
  const row = run(t, 'sequence');
  t.diagnostic(JSON.stringify(row));
  assert.equal(row.hides.length, 0);
  assert.equal(row.shown, true);
  assert.ok(row.installs > 100);
  assert.ok(row.seatFrame[2] > 665 && row.panel[2] < 666, 'target frame stays separate from the cropped panel');
});
test('CHV9 exact cost geometry is a positive control without roundoff', {
  skip: macCommandSkip('xcrun'), timeout: 900000,
}, t => {
  const row = run(t, 'sequence-exact');
  assert.equal(row.hides.length, 0); assert.equal(row.shown, true); assert.equal(row.installs, 128);
});
test('CHV9 three-point target movement hides and returns after half a second under CHV12', {
  skip: macCommandSkip('xcrun'), timeout: 900000,
}, t => {
  const row = run(t, 'move');
  assert.equal(row.hides.length, 1); assert.equal(row.hides[0].reason, 'moved');
  assert.equal(row.shown, true); assert.equal(row.installs, 2);
});
test('CHV9 return accepts equivalent target bounds after a real move', {
  skip: macCommandSkip('xcrun'), timeout: 900000,
}, t => {
  const row = run(t, 'move-roundoff');
  assert.equal(row.hides.length, 1); assert.equal(row.hides[0].reason, 'moved');
  assert.equal(row.shown, true); assert.equal(row.installs, 2);
});
for (const path of ['legacy', 'stage']) {
  for (const mode of ['crop', 'extras', 'flip-shift']) {
    test('CHV9 production install ' + mode + ' via ' + path, { skip: macCommandSkip('xcrun'), timeout: 900000 }, t => {
      const rows = run(t, mode, { path });
      rows.forEach(row => t.diagnostic(JSON.stringify(row)));
      verifyInstall(rows, mode);
    });
  }
}
function verifyInstall(rows, mode) {
  for (const row of rows) {
    assert.equal(row.changed, 0); assert.ok(row.comparisons > 0);
    assert.equal(row.sameCell, true);
    assert.equal(row.enclosed, true, 'physical panel encloses the host-reported supported ink');
    assert.equal(row.inkLookups, 1, 'identical cell geometry is computed once');
    assert.equal(row.fullPanel, mode === 'extras');
    if (mode === 'flip-shift') assert.ok(row.flipShift > 0);
    if (mode === 'extras') assert.equal(row.offsetPreserved, true);
  }
  assert.equal(rows.length, mode === 'extras' ? 5 : 1);
}
for (const [broken, mode] of [['no-crop', 'crop'], ['extras', 'extras'], ['flip-shift', 'flip-shift']]) {
  test('CHV9 default run rejects broken install ' + broken, { skip: macCommandSkip('xcrun'), timeout: 900000 }, t => {
    for (const path of ['legacy', 'stage']) {
      const rows = run(t, mode, { path, broken });
      assert.throws(() => verifyInstall(rows, mode), assert.AssertionError);
      t.diagnostic(JSON.stringify({ broken, path, expectedFailures: 1, changed: rows.reduce((n, r) => n + r.changed, 0) }));
    }
  });
}
