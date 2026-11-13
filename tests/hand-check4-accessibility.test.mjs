import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { sampleWindows, summarizeSamples, smokeResult } from '../bench/hand/check4-measurement.mjs';

const status = { pid: 40, panelID: 7, hostTimeMs: 1000, panel: [900, 900, 20, 20],
  wideWindows: [{ pid: 42, id: 9 }], protectedRects: [], shown: true, rendererPath: 'stage', size: 'stage', turnTargets: 1 };
const ax = { pid: 40, title: 'sleight check 4 character', identifier: 'sleight.check4.character',
  role: 'AXWindow', frame: [158, 50, 20, 20], minimized: false, hidden: false };
const input = { t: 1000, status, appPids: [42], accessibility: [ax],
  windows: [{ pid: 42, id: 9, frame: [100, 50, 10, 10], alpha: 1 }] };

test('capture-hidden panels use independently read Accessibility geometry with exact identity and reject ambiguity',
  { skip: process.platform !== 'darwin' }, t => {
    const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-check4-ax-')));
    const main = join(root, 'main.swift'), binary = join(root, 'sampler');
    let source = readFileSync(new URL('../bench/hand/check4-sampler.swift', import.meta.url), 'utf8');
    if (process.env.CA6F_BROKEN_VARIANT === 'ax-host-frame') {
      const original = '"frame": frame, "source": "Accessibility"';
      assert.ok(source.includes(original));
      source = source.replace(original, '"frame": rectangle(status?["panel"]) ?? frame, "source": "Accessibility"');
    }
    source = source.replace('let args = Array(CommandLine.arguments.dropFirst())', `
let args = Array(CommandLine.arguments.dropFirst())
if args == ["--native-geometry-selftest"] {
    let status: [String: Any] = ["pid": 40, "panelID": 7, "hostTimeMs": 1000.0, "wideWindows": [], "protectedRects": []]
    let ax: [String: Any] = ["pid": 40, "title": "sleight check 4 character", "identifier": "sleight.check4.character",
        "role": "AXWindow", "hidden": false, "minimized": false, "frame": [CGFloat(158), CGFloat(50), CGFloat(20), CGFloat(20)]]
    emit(sample(1000, status, [], [], nil, [ax])); exit(0)
}`);
    writeFileSync(main, source);
    const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), main, '-o', binary],
      { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
    assertChildStatus(built, 0, built.stderr);
    const rejected = [{ pid: 99 }, { title: 'Person stand-in' }, { identifier: 'other' }, { role: 'AXButton' },
      { minimized: true }, { hidden: true }, { minimized: null }, { hidden: null }, { frame: [1, 2, 0, 20] }];
    const cases = [input, ...rejected.map(extra => ({ ...input, accessibility: [{ ...ax, ...extra }] })),
      { ...input, accessibility: [ax, ax] }, { ...input, accessibility: [] }];
    const ran = spawnSync(binary, ['--selftest'], { input: cases.map(JSON.stringify).join('\n') + '\n',
      encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
    assertChildStatus(ran, 0, ran.stderr);
    const rows = ran.stdout.trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows[0].panel.frame, [158, 50, 20, 20]);
    assert.equal(rows[0].panel.source, 'Accessibility');
    assert.equal(rows[0].panel.onScreen, true);
    assert.equal(rows[0].intersections.length, 1);
    for (const row of rows.slice(1)) assert.equal(row.panel.onScreen, false);
    assert.deepEqual(rows, cases.map(row => sampleWindows(row)));
    const native = spawnSync(binary, ['--native-geometry-selftest'], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
    assertChildStatus(native, 0, native.stderr);
    assert.equal(JSON.parse(native.stdout).panel.onScreen, true, 'native AXValue and CGRect components are CGFloat arrays');
    assert.deepEqual(JSON.parse(native.stdout).panel.frame, [158, 50, 20, 20]);
  });

test('independent frame agreement counts all host-shown samples, missing and wrong observations included', () => {
  const row = (t, panel, extra = {}) => ({ t, valid: true, status: { ...status, panel: [1, 2, 20, 20], ...extra }, panel,
    intersections: [] });
  const observed = { onScreen: true, frame: [3, 0, 22, 18], source: 'Accessibility' };
  const rows = Array.from({ length: 20 }, (_, i) => row(1000 + i * 50, observed));
  rows[19] = row(1950, { onScreen: false, frame: null });
  const figures = summarizeSamples(rows, { start: 1000, end: 2000 });
  assert.deepEqual(figures.panelAgreement, { shownSamples: 20, observedSamples: 19, agreeingSamples: 19,
    within2PtShare: 0.95, maxDifferencePt: 2, passed: true });
  const result = { driving: { start: 1000, end: 2000 }, benchmarkPassed: true, cleanupConfirmed: true };
  assert.equal(smokeResult(result, rows).verdict, 'pass');
  rows[18] = row(1900, { ...observed, frame: [3.01, 0, 22, 18] });
  const failed = smokeResult(result, rows);
  assert.equal(failed.verdict, 'fail');
  assert.match(failed.reason, /independent panel/i);
  assert.equal(smokeResult(result, rows.map(r => ({ ...r, panel: { onScreen: false, frame: null } }))).verdict, 'fail');
});
