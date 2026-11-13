import test from 'node:test';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { glideStopSource } from './fixtures/glide-stop-source.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const source = glideStopSource();
test('Stop source follows its role after a rename and diagnoses missing or ambiguous roles', t => {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-stop-source-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => glideStopSource(root), /Expected exactly one Glide Stop control source.*found 0/);
  writeFileSync(join(root, 'glide-engine.swift'), source);
  assert.equal(glideStopSource(root), source);
  writeFileSync(join(root, 'duplicate.swift'), source);
  assert.throws(() => glideStopSource(root), /found 2/);
});
test('Stop uses the consent host person guard and never makes a shareable panel', () => {
  const block = source.match(/\/\/ BEGIN GLIDE STOP\n([\s\S]*?)\/\/ END GLIDE STOP/);
  assert.ok(block, 'Stop control absent');
  assert.match(block[1], /personActivation/);
  assert.match(block[1], /override func accessibilityPerformPress\(\) -> Bool \{ false \}/);
  assert.match(block[1], /sharingType = \.none/);
  assert.doesNotMatch(block[1], /\.post\(|CGEventPost|AXUIElementPerformAction|addGlobalMonitor|\.makeKeyAndOrderFront/);
});

test('headless control rejects AX and posted events; its AX-accepting mutant fails',
  { skip: process.platform !== 'darwin', timeout: 720000 }, t => {
    const block = source.match(/\/\/ BEGIN GLIDE STOP\n([\s\S]*?)\/\/ END GLIDE STOP/);
    assert.ok(block, 'Stop control absent');
    const person = source.match(/\/\/ BEGIN PERSON INPUT\n([\s\S]*?)\/\/ END PERSON INPUT/)[1];
    const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-stop-control-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const fixture = readFileSync(new URL('./fixtures/glide-stop-control.swift', import.meta.url), 'utf8');
    const path = join(root, 'main.swift'), binary = join(root, 'fixture');
    const variants = [
      ['baseline', block[1], null],
      ['ax', block[1].replace('override func accessibilityPerformPress() -> Bool { false }',
        'override func accessibilityPerformPress() -> Bool { stop(); return true }'), /AX press accepted/],
      ['geometry', block[1].replace('"phase": "control-unavailable"', '"phase": "stop"'), /geometry manufactured Stop/],
      ['full-screen', block[1].replace('return CGRect(x: screen.maxX - size.width, y: screen.minY, width: size.width, height: size.height)',
        'return nil'), /full-screen control missing/],
    ];
    for (const [name, code, failure] of variants) {
      if (failure) assert.notEqual(code, block[1], `${name} mutation anchor absent`);
      writeFileSync(path, 'import AppKit\nimport Carbon.HIToolbox\nimport ObjectiveC\nimport Darwin\nimport os.log\n' + person + code + fixture);
      const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), path, '-o', binary],
        { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
      assert.equal(built.status, 0, JSON.stringify({ name, error: built.error?.code, signal: built.signal, stderr: built.stderr }));
      const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
      assert.equal(run.status, failure ? 1 : 0, name + run.stderr + run.stdout);
      if (failure) assert.match(run.stdout, failure);
      else t.diagnostic(run.stdout.trim() + ` binaryBytes=${readFileSync(binary).length}`);
    }
  });
