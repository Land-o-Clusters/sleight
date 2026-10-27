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
    assert.doesNotMatch(block, /postToPid|\.post\(/);
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
    assert.equal(result.events.length, 8);
    for (const row of result.events) {
      assert.equal(row.window, row.expectedWindow);
      assert.deepEqual(row.global, row.expectedGlobal);
      assert.deepEqual(row.local, [310, 129]);
      assert.deepEqual(row.restoredLocal, row.local);
      assert.deepEqual(row.cocoaLocal, [310, 70]);
      assert.equal(row.clickCount, 1);
      // A private source has an allocated state ID, not the -1 constructor selector.
      assert.equal(row.sourceState, row.expectedSourceState, 'private source metadata is preserved');
      if (row.hidpid) assert.equal(row.sourceState, 1, 'forgery selects the HID state table');
      else assert.notEqual(row.sourceState, 1, 'private source stays outside the HID state table');
      assert.equal(row.sourcePid, row.hidpid ? 0 : result.pid, 'only the explicit forgery changes source PID');
      assert.equal(row.userData, 0);
    }
  });

// Exercise event construction alone. Neither a poster entry point nor its posting calls are included.
test('consent probe constructs HID PID-zero forgery metadata without posting',
  { skip: macCommandSkip('xcrun') }, t => {
    const poster = readFileSync(new URL('../bench/consent-guard-poster.swift', import.meta.url), 'utf8');
    const block = poster.match(/\/\/ BEGIN CONSENT PROBE MOUSE EVENT\n([\s\S]*?)\/\/ END CONSENT PROBE MOUSE EVENT/)?.[1];
    assert.ok(block); assert.doesNotMatch(block, /postToPid|\.post\(/);
    const dir = registerTemp(t, trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-hidpid-encoding-')))));
    const swift = join(dir, 'main.swift'), binary = join(dir, 'fixture');
    writeFileSync(swift, 'import ApplicationServices\nimport Foundation\nimport Darwin\n' + block + `
      var rows: [[String: Any]] = []
      for mode in ["pid", "hid", "hidpid"] {
        for type in [CGEventType.leftMouseDown, .leftMouseUp] {
          let event = consentProbeMouseEvent(mode: mode, type: type, point: CGPoint(x: 20, y: 40))!
          rows.append(["mode": mode, "state": event.getIntegerValueField(.eventSourceStateID),
            "pid": event.getIntegerValueField(.eventSourceUnixProcessID),
            "data": event.getIntegerValueField(.eventSourceUserData)])
        }
      }
      precondition(consentProbeMouseEvent(mode: "invalid", type: .leftMouseDown, point: .zero) == nil)
      precondition(consentProbeMouseEvent(mode: "hidpid", type: .keyDown, point: .zero) == nil)
      precondition(consentProbeMouseEvent(mode: "hidpid", type: .leftMouseUp, point: CGPoint(x: CGFloat.nan, y: 0)) == nil)
      print(String(data: try! JSONSerialization.data(withJSONObject: rows), encoding: .utf8)!)
    `);
    const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(dir, 'cache'), swift, '-o', binary],
      { encoding: 'utf8', timeout: 120000 });
    assert.equal(built.status, 0, built.stderr);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const rows = JSON.parse(run.stdout); assert.equal(rows.length, 6);
    for (const row of rows) {
      assert.equal(row.data, 0);
      if (row.mode === 'pid') { assert.notEqual(row.state, 1); assert.ok(row.pid > 0); }
      else { assert.equal(row.state, 1); assert.equal(row.pid, 0); }
    }
    // The only global path is the existing tap probe; hidpid must stay on the supplied PID.
    assert.match(poster, /if mode == "pid" \|\| mode == "hidpid" \{ event.postToPid\(pid\) \} else \{ event.post\(tap: \.cghidEventTap\) \}/);
  });
