import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';

const root = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-call-recovery-'))));
after(() => rmSync(root, { recursive: true, force: true }));
const variant = process.env.CHV4R_BROKEN;
let binary;
function host() {
  if (binary) return binary;
  let source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  // The compile-only selftest accepts only this test's owned bank, on every system temp volume.
  const bankGuard = `arguments[1].hasPrefix(${JSON.stringify(join('/', 'private', 'tmp') + '/')})`;
  assert.ok(source.includes(bankGuard), 'production selftest bank guard');
  source = source.replace(bankGuard, `arguments[1].hasPrefix(${JSON.stringify(root + '/')})`);
  const mutations = {
    'drop-callback': ['self?.invalidate() }', '/* dropped input callback */ }'],
    'drop-fallback': ['if request != 1 && !ready && result < 2 { result += 3 }', 'if request != 1 && !ready { result = 2 }'],
    'drop-safety': ['if result == 0 { return 2 }', 'if result == 0 { continue }'],
    'drop-restart': ['self?.invalidate(reset: true)', 'self?.invalidate()'],
    'drop-observing-reset': ['if failed || fallback { self?.observing = false }', '/* lost observing reset */'],
    'drop-wake-reset': ['func refreshSubscription() { worker.refreshSubscription() }', 'func refreshSubscription() {}'],
    'drop-hide': ['else if !self.stageActive { self.observeLegacyCall() }', 'else if !self.stageActive { /* dropped hide */ }'],
    'dirty-before-write': ['if write(pipeEnds[1], &byte, 1) == 1 { dirty = true }', 'dirty = true; _ = write(pipeEnds[1], &byte, 1)'],
    'drop-removal-deadline': ['if changed == 2 { alarm(2); watch.stop(); alarm(0) }', 'if changed == 2 { watch.stop() }'],
  };
  if (variant) {
    const pair = mutations[variant]; assert.ok(pair && source.includes(pair[0]), 'production mutation site');
    source = source.replace(pair[0], pair[1]);
  }
  // Keep the real poll/timeout branch; compress only its clock for offline safety tests.
  assert.match(source, /let deadline = CACurrentMediaTime\(\) \+ 30/);
  source = source.replace('let deadline = CACurrentMediaTime() + 30', 'let deadline = CACurrentMediaTime() + (testState()["safetySeconds"] as? Double ?? 30)');
  source = source.replace('if arguments == ["--stage-call-worker"]', 'if arguments.first == "--stage-call-worker"');
  source = source.replace('let stageCall = StageCallMonitor()',
    'let stageCall = StageCallMonitor(arguments: ["--stage-call-worker", "--test-audio", CommandLine.arguments.last!])');
  let worker = source.slice(source.indexOf('struct StageCallWatchAudio {'), source.indexOf('final class StageCallMonitor {'));
  const originalWorker = worker;
  worker = worker.replace('processes: NarrationAudio.system.processes', 'processes: testAudio.processes')
    .replace('AudioObjectAddPropertyListenerBlock(object, &address, queue, block)', 'testAdd(object, selector, queue, block)')
    .replace('AudioObjectRemovePropertyListenerBlock(object, &address, queue, block)', 'testRemove(object, selector)')
    .replaceAll('NarrationAudio.system.', 'testAudio.')
    .replace('write(pipeEnds[1], &byte, 1)', 'testWakeWrite(pipeEnds[1], &byte, 1)');
  source = source.replace(originalWorker, worker);
  source = source.replace('        } else if let state = row["sample"] as? String,', `
        } else if let data = row["audio"] as? [String: Any] {
            if !perch.stageActive, perch.runtime.timers.contains(where: { $0.action == "park" }), let plan = perch.runtime.plan {
                perch.callTestClock = max(perch.now, perch.runtime.began + plan.duration + 0.001)
                perch.perform(perch.runtime.advance(to: perch.now, env: perch.environment))
            }
            // Prove completion-driven hiding without a renderer timer rescuing a lost callback.
            perch.wake?.cancel(); perch.wake = nil
            let file = CommandLine.arguments.last! + "/state.json"
            try! FileManager.default.createDirectory(atPath: CommandLine.arguments.last!, withIntermediateDirectories: true)
            try! JSONSerialization.data(withJSONObject: data).write(to: URL(fileURLWithPath: file), options: .atomic)
            if data["wake"] as? Bool == true { perch.stageCall.refreshSubscription() }
            if data["prefetch"] as? Bool == true {
                perch.stageCall.requested = -Double.infinity
                perch.stageCall.prefetch(CACurrentMediaTime())
            }
            if let expected = data["waitForAdds"] as? Int {
                // Deliver this fake OS notification before overwriting its file
                // with the next generation. The production safety timer stays 30 s.
                let deadline = Date(timeIntervalSinceNow: 1)
                while Date() < deadline {
                    let events = (try? String(contentsOfFile: CommandLine.arguments.last! + "/events", encoding: .utf8)) ?? ""
                    if events.split(separator: "\\n").filter({ $0 == "add" }).count >= expected { break }
                    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.01))
                }
            } else {
                RunLoop.current.run(until: Date(timeIntervalSinceNow: data["wait"] as? Double ?? 0.1))
            }
        } else if let state = row["sample"] as? String,`);
  source = source.replace('"shown": perch.stageActive ? perch.stage.shown', '"callState": perch.stageCall.sampleState, "shown": perch.stageActive ? perch.stage.shown');
  source = source.replace('    perch.takeDown()\n}\n#endif', '    stageCallWorker.stop(); perch.takeDown()\n}\n#endif');
  const adapter = readFileSync(new URL('fixtures/call-recovery-audio.swift', import.meta.url), 'utf8');
  source = source.replace('let arguments = Array(CommandLine.arguments.dropFirst(channelValidationOnly ? 2 : 1))',
    adapter + '\nlet arguments = Array(CommandLine.arguments.dropFirst(channelValidationOnly ? 2 : 1))');
  const file = join(root, 'host.swift'); binary = join(root, 'host'); writeFileSync(file, source);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-D', 'SLEIGHT_CALL_SELFTEST', '-module-cache-path', swiftModuleCache(), file, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr); return binary;
}
const entry = { sheet: 'sheet', row: 0, frames: [0, 1], ms: [200, 200], loop: true, flip: false,
  hotspot: [96, 104], size: [1536, 208], scale: 0.5 };
const states = ['perch', 'perch-peek', 'perch-hop', 'perch-point-left', 'perch-point-right', 'sleep', 'high-five', 'perch-wait',
  'startle', 'jumping', 'running-right', 'running-left', 'error', 'handoff', 'paused'];
const character = size => ({ character: { hand: 'character', nonce: 'a'.repeat(64), seq: 1, id: 'fixture',
  sheet: join(root, 'sheet.png'), extra: null, cell: [192, 208], table: { idle: { ...entry, frames: 2 } },
  perch: { anchor: [96, 150], table: Object.fromEntries(states.map(state => [state, entry])) }, size, stageAttention: false } });
function dump(t, rows, size = 'small') {
  const bank = mkdtempSync(join(root, 'audio-'));
  const result = spawnSync(host(), ['--call-host-selftest', bank], {
    input: [character(size), { ring: true, state: 'paused' }, ...rows].map(JSON.stringify).join('\n') + '\n',
    encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr);
  const replies = result.stdout.trim().split('\n').map(JSON.parse);
  for (const row of replies) { assert.equal(row.windows, 0); assert.equal(row.layers, 0); }
  const events = readFileSync(join(bank, 'events'), 'utf8').trim().split('\n');
  t.diagnostic(JSON.stringify({ size, states: replies.map(r => r.callState), adds: events.filter(e => e === 'add').length }));
  return { replies, events };
}
const native = { skip: process.platform !== 'darwin' };
for (const size of ['small', 'medium', 'stage']) {
  test('native listener callback reaches monitor and hides parked ' + size, native, t => {
    const { replies } = dump(t, [{ audio: { active: false, prefetch: true } },
      { audio: { active: true, event: 'input', generation: 1 } }], size);
    assert.equal(replies.at(-2).visible, true);
    assert.equal(replies.at(-1).callState, 'input-active'); assert.equal(replies.at(-1).visible, false);
    assert.equal(replies.at(-1).reason, 'call');
  });
}
test('listener-add failure keeps per-wake active census hiding and retries subscription', native, t => {
  const { replies, events } = dump(t, [{ audio: { active: false, failAdd: true, prefetch: true } },
    { wait: 0.6 }, { audio: { active: true, failAdd: true, prefetch: true } },
    { wait: 0.6 }, { audio: { active: false, prefetch: true } },
    { audio: { active: true, event: 'input', generation: 1 } }]);
  assert.equal(replies[2].callState, 'quiet'); assert.equal(replies[4].callState, 'input-active');
  assert.equal(replies[4].visible, false); assert.equal(replies[6].visible, true);
  assert.equal(replies[7].visible, false); assert.ok(events.filter(e => e === 'add-failed').length >= 2);
});
test('30-second safety branch catches an active reading with no notification', native, t => {
  const { replies } = dump(t, [{ audio: { active: false, prefetch: true, safetySeconds: 0.2 } },
    { audio: { active: true, event: 'silent', generation: 1, wait: 0.5 } }]);
  assert.equal(replies.at(-2).visible, true); assert.equal(replies.at(-1).callState, 'input-active');
  assert.equal(replies.at(-1).visible, false);
});
test('coreaudiod restart reinstalls lost input listeners before the next call', native, t => {
  const { replies, events } = dump(t, [{ audio: { active: false, prefetch: true, waitForAdds: 3 } },
    { audio: { active: false, event: 'restart', generation: 1, waitForAdds: 6 } },
    { audio: { active: true, event: 'input', generation: 2 } }]);
  assert.equal(replies.at(-1).callState, 'input-active'); assert.equal(replies.at(-1).visible, false);
  assert.ok(events.filter(e => e === 'add').length >= 6, 'restart rebuilds all three listeners before safety deadline');
});
test('failed read clears observing and a later prefetch subscribes and hides', native, t => {
  const { replies } = dump(t, [{ audio: { active: false, prefetch: true } },
    { audio: { unavailable: true, event: 'input', generation: 1 } }, { wait: 0.6 },
    { audio: { active: true, prefetch: true } }]);
  assert.equal(replies[3].callState, 'unavailable'); assert.equal(replies[3].visible, true);
  assert.equal(replies.at(-1).callState, 'input-active'); assert.equal(replies.at(-1).visible, false);
});
test('sleep/wake control rebuilds the subscription without waiting for the safety deadline', native, t => {
  const { replies, events } = dump(t, [{ audio: { active: false, prefetch: true } },
    { audio: { active: true, event: 'silent', generation: 1, wake: true } }]);
  assert.equal(replies.at(-1).callState, 'input-active'); assert.equal(replies.at(-1).visible, false);
  assert.ok(events.filter(e => e === 'add').length >= 6);
});
test('failed invalidation write leaves dirty clear so the next callback still hides', native, t => {
  const { replies, events } = dump(t, [{ audio: { active: false, prefetch: true } },
    { audio: { active: true, event: 'input', generation: 1, failWakeWrite: true } },
    { audio: { active: true, event: 'input', generation: 2 } }]);
  assert.equal(replies[3].callState, 'quiet'); assert.equal(replies[3].visible, true);
  assert.equal(replies[4].callState, 'input-active'); assert.equal(replies[4].visible, false);
  assert.equal(events.filter(e => e === 'write-failed').length, 1);
});
test('wedged listener removal expires and retains the last successful active hide', native, t => {
  const { replies } = dump(t, [{ audio: { active: true, prefetch: true } },
    { audio: { active: true, event: 'silent', generation: 1, wake: true, hangRemove: true, wait: 2.3 } }]);
  assert.equal(replies.at(-2).callState, 'input-active');
  assert.equal(replies.at(-1).callState, 'unavailable'); assert.equal(replies.at(-1).visible, false);
});
