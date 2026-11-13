import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { macCommandSkip } from './requirements.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

test('foreign-window click preserves both coordinates through serialization and provenance before posting', { skip: macCommandSkip('xcrun') }, t => {
  const poster = readFileSync(new URL('../bench/shell-card-poster.swift', import.meta.url), 'utf8');
  const block = poster.match(/\/\/ BEGIN SHELL MOUSE EVENT\n([\s\S]*?)\/\/ END SHELL MOUSE EVENT/)?.[1];
  assert.ok(block);
  const dir = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-click-encoding-')))));
  const swift = join(dir, 'main.swift'), binary = join(dir, 'fixture');
  writeFileSync(swift, 'import AppKit\nimport Darwin\n' + block +
    readFileSync(new URL('./fixtures/shell-card-events.swift', import.meta.url), 'utf8'));
  const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(dir, 'cache'), swift, '-o', binary], { encoding: 'utf8', timeout: 120000 });
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const records = JSON.parse(run.stdout);
  assert.equal(records.length, 8);
  assert.ok(records.some(event => event.expectedGlobal[0] < 0), 'cover a negative screen origin');
  for (const [index, event] of records.entries()) {
    assert.ok(event.expectedWindow > 0);
    assert.equal(event.window, event.expectedWindow, JSON.stringify(event));
    assert.equal(event.originalWindow, event.expectedWindow, JSON.stringify(event));
    assert.deepEqual(event.windowLocal, [310, 129], JSON.stringify(event));
    assert.deepEqual(event.originalWindowLocal, [310, 129], JSON.stringify(event));
    // The sender has no AppKit window transform. Read the serialized annotation
    // directly, then express it in Cocoa coordinates using the known height.
    assert.deepEqual(event.cocoaLocalFromAnnotation, [310, 70], JSON.stringify(event));
    assert.deepEqual(event.originalCocoaLocalFromAnnotation, [310, 70], JSON.stringify(event));
    assert.deepEqual(event.global, event.expectedGlobal);
    assert.deepEqual(event.originalGlobal, event.expectedGlobal);
    assert.equal(event.clickCount, 1);
    assert.equal(event.eventNumber, 1);
    assert.equal(event.type, index % 2 === 0 ? 1 : 2);
    assert.equal(event.mode, index < 4 ? 'pid' : 'hid');
    assert.equal(event.flags, 0);
    // Flattening reconstructs source metadata. Posting uses the original event,
    // whose provenance must match the selected source before it leaves the poster.
    assert.equal(event.originalState, event.expectedState);
    assert.equal(event.originalPid, event.expectedPid);
    assert.equal(event.originalUserData, 0);
    assert.equal(event.userData, 0);
  }
});
