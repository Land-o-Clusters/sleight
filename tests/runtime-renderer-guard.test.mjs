// Offline: compile the sitting guard and run only its non-drawing replay mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { join } from 'node:path';

const sample = (t, idle, held = false) => ({ t, idle, held });
const cases = [
  ['30 seconds accepted', [sample(0, 30), sample(.02, 30.02)], [null, null]],
  ['below 30 seconds', [sample(0, 29.999)], ['PERSON_ACTIVE']],
  ['no idle evidence', [sample(0, null)], ['PERSON_ACTIVE']],
  ['hold at arm', [sample(0, 30, true)], ['TIMED_WINDOW_HOLD']],
  ['hold between trials', [sample(0, 30), sample(.02, 30.02, true)], [null, 'TIMED_WINDOW_HOLD']],
  ['person returns', [sample(0, 60), sample(.02, 0)], [null, 'PERSON_ACTIVE']],
  ['missed HID reset still above 30', [sample(0, 60), sample(.02, 40)], [null, 'PERSON_ACTIVE']],
  ['500 ms gap allowed', [sample(0, 60), sample(.5, 60.5)], [null, null]],
  ['stale guard', [sample(0, 60), sample(.501, 60.501)], [null, 'GUARD_STALE']],
  ['backwards time', [sample(1, 60), sample(.9, 60.1)], [null, 'GUARD_STALE']],
  ['stop stays latched', [sample(0, 60), sample(.02, 0), sample(.04, 60.04)], [null, 'PERSON_ACTIVE', 'PERSON_ACTIVE']],
];

test('renderer sitting guard replays idle, hold, staleness and owner-return refusals without drawing',
  { skip: process.platform !== 'darwin', timeout: 240000 }, () => {
    const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-renderer-guard-')));
    try {
      const binary = join(root, 'guard');
      const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'),
        'bench/sitting-guard.swift', '-o', binary], { timeout: 180000, killSignal: 'SIGKILL', encoding: 'utf8' });
      assert.equal(build.status, 0, build.stderr);
      const result = spawnSync(binary, ['--replay-renderer'], {
        input: cases.map(c => JSON.stringify(c[1])).join('\n') + '\n', timeout: 5000, killSignal: 'SIGKILL', encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      const rows = result.stdout.trim().split('\n').map(JSON.parse);
      assert.equal(rows.length, cases.length);
      for (const [index, [name, , stops]] of cases.entries()) assert.deepEqual(rows[index], { drawing: false, stops }, name);

      // Compile the exact pure production state with each single-check mutation.
      // All variants share one compilation and have no desktop API available.
      const source = readFileSync('bench/sitting-guard.swift', 'utf8');
      const detector = source.slice(source.indexOf('struct IdleDetector'), source.indexOf('// AX work may'));
      const state = source.slice(source.indexOf('struct RendererSittingState'), source.indexOf('struct FocusDetector'));
      const variants = [
        ['threshold', 'idle < 30', 'idle < 0'],
        ['hold', 'if held {', 'if false {'],
        ['reset', 'current.sample(now, idle: idle).0', 'false'],
        ['staleness', 'now - previous > 0.5', 'false'],
        ['latch', 'if stop != nil { return stop }', 'stop = nil'],
      ];
      let fixture = 'import Foundation\n' + detector;
      const names = ['Original', ...variants.map(v => v[0])];
      for (const name of names) {
        const variant = variants.find(v => v[0] === name);
        let body = state;
        if (variant) {
          assert.ok(body.includes(variant[1]), name);
          body = body.replace(variant[1], variant[2]);
        }
        fixture += body.replaceAll('RendererSittingState', 'State_' + name) + '\n';
      }
      fixture += 'let rows = try! JSONSerialization.jsonObject(with: Data(readLine()!.utf8)) as! [[[String: Any]]]\nvar result: [String: [[Any]]] = [:]\n';
      for (const name of names) fixture += `result["${name}"] = rows.map { steps in\n var state = State_${name}()\n return steps.map { s in state.sample(now: s["t"] as! Double, idle: s["idle"] as? Double ?? .nan, held: s["held"] as! Bool) as Any? ?? NSNull() }\n}\n`;
      fixture += 'print(String(decoding: try! JSONSerialization.data(withJSONObject: result), as: UTF8.self))\n';
      writeFileSync(join(root, 'variants.swift'), fixture);
      const compiled = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'),
        join(root, 'variants.swift'), '-o', join(root, 'variants')], { timeout: 60000, killSignal: 'SIGKILL', encoding: 'utf8' });
      assert.equal(compiled.status, 0, compiled.stderr);
      const replay = spawnSync(join(root, 'variants'), [], { input: JSON.stringify(cases.map(c => c[1])) + '\n',
        timeout: 5000, killSignal: 'SIGKILL', encoding: 'utf8' });
      assert.equal(replay.status, 0, replay.stderr);
      const results = JSON.parse(replay.stdout), expected = cases.map(c => c[2]);
      assert.deepEqual(results.Original, expected);
      for (const [name] of variants) assert.notDeepEqual(results[name], expected, name + ' survived');
      console.log(`rendererGuard: ${cases.length} replays, ${variants.length} broken variants detected, drawing=false`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
