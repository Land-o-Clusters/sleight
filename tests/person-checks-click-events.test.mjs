import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { macCommandSkip } from './requirements.mjs';
import { registerTemp, trackTemp } from '../scripts/temp-leftovers.mjs';

test('person-check click encoding binds global and window points without posting or creating a window',
  { skip: macCommandSkip('xcrun') }, t => {
    const poster = readFileSync(new URL('../bench/person-checks-1-5-poster.swift', import.meta.url), 'utf8');
    const block = poster.match(/\/\/ BEGIN PERSON CHECK MOUSE EVENT\n([\s\S]*?)\/\/ END PERSON CHECK MOUSE EVENT/)?.[1];
    assert.ok(block);
    assert.doesNotMatch(block, /postToPid|\.post\(|eventSourceUnixProcessID|eventSourceStateID/);
    const dir = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-person-click-')))));
    const swift = join(dir, 'main.swift'), binary = join(dir, 'fixture');
    writeFileSync(swift, 'import AppKit\nimport Darwin\n' + block +
      readFileSync(new URL('./fixtures/person-checks-click-events.swift', import.meta.url), 'utf8'));
    const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(dir, 'cache'), swift, '-o', binary],
      { encoding: 'utf8', timeout: 120000 });
    assert.equal(built.status, 0, built.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const result = JSON.parse(run.stdout);
    assert.equal(result.oldWindow, 0, 'the old CGEvent constructor carries no target window');
    assert.equal(result.invalidRefused, 5);
    assert.equal(result.events.length, 4);
    for (const row of result.events) {
      assert.equal(row.window, row.expectedWindow);
      assert.deepEqual(row.global, row.expectedGlobal);
      assert.deepEqual(row.local, [310, 129]);
      assert.deepEqual(row.restoredLocal, row.local);
      assert.deepEqual(row.cocoaLocal, [310, 70]);
      assert.equal(row.clickCount, 1);
      // A private source has an allocated state ID, not the -1 constructor selector.
      assert.equal(row.sourceState, row.expectedSourceState, 'private source metadata is preserved');
      assert.notEqual(row.sourceState, 0, 'private source stays outside the HID state table');
      assert.equal(row.sourcePid, result.pid, 'source remains the fixture process');
      assert.equal(row.userData, 0);
    }
  });
