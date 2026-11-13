import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macCommandSkip } from './requirements.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';

// Compile the production hide dispatch, panel release and dump recorder together.
// Only the NSPanel implementation is replaced. No AppKit application or window exists.
test('stage hide receipts follow production release and detect a skipped release or a fabricated false', {
  skip: macCommandSkip('xcrun'), timeout: 900000,
}, t => {
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  function region(name) {
    const start = source.indexOf('// BEGIN ' + name + '\n'), end = source.indexOf('// END ' + name + '\n', start);
    assert.ok(start >= 0 && end > start, 'missing production region: ' + name);
    return source.slice(start, end);
  }
  function perchHostRelease(text) {
    const start = text.indexOf('final class PerchHost {\n');
    const end = text.indexOf('\n}\n// The bubble', start);
    assert.ok(start >= 0 && end > start, 'PerchHost');
    const host = text.slice(start, end);
    const at = host.indexOf('\n    func release() {\n');
    const next = host.indexOf('\n    func ', at + 20);
    assert.ok(at >= 0 && next > at, 'PerchHost.release');
    return host.slice(at, next);
  }
  const releaseBody = perchHostRelease(source);
  assert.match(releaseBody, /panelLifetime\.release\(\); frame = \.null/);
  assert.doesNotMatch(releaseBody, /panelFadeEnd/);
  const droppedRelease = source.replace('panelLifetime.release(); frame = .null', 'panel = nil');
  assert.notEqual(droppedRelease, source);
  assert.match(droppedRelease, /panelLifetime\.release\(\)/, 'dump sites still mention release');
  assert.throws(() => assert.match(perchHostRelease(droppedRelease), /panelLifetime\.release\(\); frame = \.null/),
    assert.AssertionError, 'PerchHost.release must release the panel');
  const lifetime = region('STAGE PANEL LIFETIME'), recorder = region('STAGE PANEL RECORDER');
  const skipped = lifetime.replace('if reason != "hide" || duration == 0 { release(); return }',
    'if reason == "pointer-covered" { return }; if reason != "hide" || duration == 0 { release(); return }');
  const constant = recorder.replace('"panelOnScreen": lifetime.panelOnScreen', '"panelOnScreen": false');
  assert.notEqual(skipped, lifetime, 'production hide mutation site');
  assert.notEqual(constant, recorder, 'dump recorder mutation site');
  // Keep the live host and the dump bound to the same tested dispatch and release.
  assert.match(source, /panelLifetime\.hide\(reason, duration: duration, release: release\)/);
  const body = `
    static func run() -> [String: Any] {
        let lifetime = StagePanelLifetime<StageDumpPanel>()
        let window = StageDumpPanel(); lifetime.panel = window
        let before = stageHideRow(lifetime, reason: "pointer-covered", duration: 0, time: 0)
        var fades = 0
        lifetime.hide("pointer-covered", duration: 0.12, release: { lifetime.release() }) { _ in fades += 1 }
        let after = stageHideRow(lifetime, reason: "pointer-covered", duration: 0, time: 0)
        let retained = lifetime.panel != nil
        let actualAfter = lifetime.panel?.isVisible == true
        lifetime.release()
        let releasedWindowVisible = window.isVisible
        lifetime.panel = StageDumpPanel()
        lifetime.hide("hide", duration: 0.12, release: { lifetime.release() }) { _ in fades += 1 }
        let duringFade = lifetime.panelOnScreen
        lifetime.release() // The production fade completion calls the same release.
        let afterFade = lifetime.panelOnScreen
        lifetime.panel = StageDumpPanel(); lifetime.panel?.orderOut(nil)
        let orderedOut = lifetime.panelOnScreen
        return ["before": before["panelOnScreen"]!, "after": after["panelOnScreen"]!,
            "retained": retained, "actualAfter": actualAfter, "releasedWindowVisible": releasedWindowVisible,
            "duringFade": duringFade, "afterFade": afterFade, "orderedOut": orderedOut, "fades": fades]
    }
  `;
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-stage-panel-'))));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const swift = join(root, 'panels.swift'), binary = join(root, 'panels');
  writeFileSync(swift, 'import Foundation\n' + [
    ['Baseline', lifetime, recorder], ['Skipped', skipped, recorder], ['Fabricated', skipped, constant],
  ].map(([name, life, record]) => `enum ${name} {\n${life}\n${record.replace('func stageHideRow', 'static func stageHideRow')}\n${body}\n}`).join('\n') + `
    let result: [String: Any] = ["baseline": Baseline.run(), "skipped": Skipped.run(), "fabricated": Fabricated.run()]
    print(String(data: try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
  `);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), swift, '-o', binary], {
    encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL',
  });
  assertChildStatus(built, 0, built.stderr);
  const ran = spawnSync(binary, [], { encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL' });
  assertChildStatus(ran, 0, ran.stderr);
  const rows = JSON.parse(ran.stdout);
  function assertReleased(row) {
    assert.equal(row.before, true, 'visible panel before production hide');
    assert.equal(row.after, false, 'pointer-covered hide must release the visible panel');
    assert.equal(row.retained, false, 'production hide must release its panel');
  }
  const assertMeasured = row => assert.equal(row.after, row.actualAfter, 'dump must report the actual visible panel after hide');
  assertMeasured(rows.baseline);
  assertMeasured(rows.skipped);
  assertReleased(rows.baseline);
  assert.equal(rows.baseline.releasedWindowVisible, false);
  assert.equal(rows.baseline.duringFade, true);
  assert.equal(rows.baseline.afterFade, false);
  assert.equal(rows.baseline.orderedOut, false);
  assert.equal(rows.baseline.fades, 1, 'only the explicit hide uses the fade callback');
  assert.equal(rows.skipped.after, true, 'a skipped release must remain visible in the receipt');
  assert.throws(() => assertReleased(rows.skipped), /must release the visible panel/);
  assert.throws(() => assertMeasured(rows.fabricated), /actual visible panel after hide/);
  assert.equal(rows.fabricated.retained, true, 'the fabricated measurement cannot release a real panel');
  t.diagnostic('2 broken variants detected; 1 small Swift build; 0 applications or windows');
});
