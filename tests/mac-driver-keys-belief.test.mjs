import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

test('keyboard transport stays private-source and PID-only', async () => {
  const source = await readFile(new URL('../plugins/sleight/lib/mac-driver/native/DriverKeyboard.swift', import.meta.url), 'utf8');
  assert.match(source, /CGEventSource\(stateID: \.privateState\)/);
  assert.equal((source.match(/\.postToPid\(/g) ?? []).length, 1);
  // The Stop registry's post records a release beside a PID-only transport.
  // It is separate from the global CGEvent.post API this scan refuses.
  const transport = source.replaceAll('registry.post("keyboard",', 'registry.postInput("keyboard",');
  assert.doesNotMatch(transport, /\bCGEventPost(?:ToPid)?\s*\(|\.post\s*\(|\bCGS\w*|\bSkyLight\b/);
  assert.doesNotMatch(source, /\.activate\s*\(|AXUIElementSetAttributeValue|AXUIElementPostKeyboardEvent/);
  assert.equal((source.match(/AXUIElementPerformAction\(/g) ?? []).length, 1);
  assert.match(source, /AXUIElementPerformAction\(element, kAXPressAction as CFString\)/);
  const focus = await readFile(new URL('../plugins/sleight/lib/mac-driver/native/DriverFocusBelief.swift', import.meta.url), 'utf8');
  assert.equal((focus.match(/\.postToPid\(/g) ?? []).length, 1);
  assert.doesNotMatch(focus, /\bCGEventPost(?:ToPid)?\s*\(|\.post\s*\(|\bCGS\w*|\bSkyLight\b|AXUIElementSetAttributeValue|AXUIElementPostKeyboardEvent/);
  assert.equal((focus.match(/\.activate\(/g) ?? []).length, 1);
  assert.match(focus, /start\(app\) == previous\.processStart/);
});

// This is RT5B's prerequisite gate, not a delivery or focus-isolation test.
// A failure here blocks the posting implementation under the lane's brief.
test('public activation and deactivation survive the CGEvent round trip without posting', {
  skip: process.platform !== 'darwin', timeout: 300000,
}, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-focus-belief-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'readback');
  const source = fileURLToPath(new URL('./fixtures/mac-driver-focus-belief.swift', import.meta.url));
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-module-cache-path',
    join(root, 'modules'), source, '-o', binary], {
    killSignal: 'SIGKILL', encoding: 'utf8', timeout: 240000, maxBuffer: 65536,
  });
  assert.equal(compile.status, 0, compile.stderr);
  t.diagnostic(`binaryBytes=${(await stat(binary)).size}`);
  const run = spawnSync(binary, [], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  assert.equal(run.status, 0, run.stderr);
  if (run.stderr) t.diagnostic(run.stderr);
  const result = JSON.parse(run.stdout);
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.events.length, 4);
  for (const [index, event] of result.events.entries()) {
    const [windowNumber, subtype] = [[0, 1], [0, 2], [7, 1], [7, 2]][index];
    assert.equal(event.constructed, true, JSON.stringify(event));
    assert.equal(event.windowNumber, windowNumber);
    assert.equal(event.type, 13);
    assert.equal(event.subtype, subtype);
    assert.equal(event.cgEvent, true, `RT5B blocked: no public CGEvent carrier: ${JSON.stringify(event)}`);
    assert.equal(event.roundTrip, true, JSON.stringify(event));
    assert.equal(event.roundTripType, 13, JSON.stringify(event));
    assert.equal(event.roundTripSubtype, subtype, JSON.stringify(event));
  }
});
