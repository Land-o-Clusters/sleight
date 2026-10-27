import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { macCommandSkip } from './requirements.mjs';
import { makePet, privateWork } from '../bench/demo/capture.mjs';

test('demo fixture compiles and exercises only arithmetic and stdin validation without windows', { skip: macCommandSkip('xcrun') }, t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-dm1-native-'))), binary = join(dir, 'fixture');
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), 'bench/demo/fixture.swift', '-o', binary], { encoding: 'utf8', timeout: 600000 });
  assert.equal(built.status, 0, built.stderr);
  const run = input => spawnSync(binary, ['--selftest'], { input: JSON.stringify(input), encoding: 'utf8', timeout: 5000 });
  const good = run({ op: 'click', index: 0 });
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(JSON.parse(good.stdout), { windowsCreated: 0, valid: true, clicks: 1, drags: 1, destination: [440, 120] });
  for (const row of [{ op: 'click', index: 20 }, { op: 'drag', to: [9999, 0] }, { op: 'open', app: 'TextEdit' }, { op: 'click', index: 0, pid: 1 }]) assert.equal(run(row).status, 65);
  const visible = { width: 850, height: 780 };
  for (const [input, reason] of [[{ asleep: false, locked: false, ...visible }, null], [{ asleep: true, locked: false, ...visible }, 'display-asleep'],
    [{ asleep: false, locked: true, ...visible }, 'screen-locked'], [{ asleep: false, ...visible }, 'screen-lock-state-unknown'],
    [{ asleep: false, locked: false, width: 849, height: 780 }, 'screen-too-small'],
    [{ asleep: false, locked: false, width: 850, height: 779 }, 'screen-too-small'],
    [{ asleep: false, locked: false }, 'screen-too-small']]) {
    const p = spawnSync(binary, ['--display-selftest'], { input: JSON.stringify(input), encoding: 'utf8', timeout: 5000 });
    assert.equal(p.status, 0, p.stderr); assert.deepEqual(JSON.parse(p.stdout), { windowsCreated: 0, reason });
  }
  const pet = makePet(registerTemp(t, privateWork()));
  const layout = spawnSync(binary, ['--layout-selftest'], { input: pet.callout, encoding: 'utf8', timeout: 5000 });
  assert.equal(layout.status, 0, layout.stderr);
  const measured = JSON.parse(layout.stdout);
  assert.equal(measured.windowsCreated, 0); assert.equal(measured.fits, true, layout.stdout);
  assert.equal(measured.fontPoints, 13); assert.equal(measured.gifWidth, 720); assert.ok(measured.gifFontPixels >= 11);
  assert.ok(measured.height + 8 <= measured.availableHeight);
  t.diagnostic(`calloutCharacters=${pet.callout.length} layout=${layout.stdout.trim()}`);
  const refusal = spawnSync(binary, ['--serve'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(refusal.status, 64);
});
