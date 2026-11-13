import { assertChildStatus } from './fixtures/child-status.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { macCommandSkip } from './requirements.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

test('host hide removes chips refreshed by a cancelled badge drag', { skip: macCommandSkip('xcrun') }, t => {
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  const host = source.slice(source.indexOf('final class HandHost:'));
  const hide = host.slice(host.indexOf('    func hide() {'), host.indexOf('    func pauseStage('));
  assert.ok(hide.startsWith('    func hide() {') && hide.endsWith('    }\n'));
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-hide-integration-'))));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const swift = join(root, 'hide.swift'), binary = join(root, 'hide');
  // Run the production hide method with inert boundary types. Drag cancellation models its
  // finished callback reaching pauseChanged, ringPerform and EdgeChipHost.refresh, without UI.
  writeFileSync(swift, `import Foundation
final class Chips {
    var visible = true, wakePending = true
    func hide() { visible = false; wakePending = false }
    func refresh() { visible = true; wakePending = true }
}
final class Drag {
    var active = true, finished: () -> Void = {}
    func cancel() { guard active else { return }; active = false; finished() }
}
final class Narrator { var stopped = false; func stop() { stopped = true } }
final class Perch { var down = false; func takeDown() { down = true } }
struct Ring { var hidden = false; mutating func hide(_ now: Double) -> Int { hidden = true; return 0 } }
final class Host {
    let edgeChips = Chips(), badgeDrag = Drag(), narrator = Narrator(), perch = Perch()
    var narrationWatch: DispatchWorkItem? = DispatchWorkItem {}
    var pending = [1: DispatchWorkItem {}]
    var ringWake: DispatchWorkItem? = DispatchWorkItem {}
    var ringRuntime = Ring(), fading: DispatchWorkItem? = DispatchWorkItem {}
    var released = false
    func release() { released = true }
${hide}
}
let host = Host()
let narration = host.narrationWatch!, pending = host.pending[1]!, wake = host.ringWake!, fade = host.fading!
host.badgeDrag.finished = { host.edgeChips.refresh() }
host.hide()
let result: [String: Bool] = ["chipsVisible": host.edgeChips.visible, "chipWakePending": host.edgeChips.wakePending,
    "dragActive": host.badgeDrag.active, "narratorStopped": host.narrator.stopped,
    "ownedWorkCancelled": narration.isCancelled && pending.isCancelled && wake.isCancelled && fade.isCancelled,
    "pendingCleared": host.pending.isEmpty, "ringHidden": host.ringRuntime.hidden,
    "released": host.released, "perchDown": host.perch.down]
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: result))
`);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), swift, '-o', binary], { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(run, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { chipsVisible: false, chipWakePending: false, dragActive: false,
    narratorStopped: true, ownedWorkCancelled: true, pendingCleared: true, ringHidden: true, released: true, perchDown: true });
});
