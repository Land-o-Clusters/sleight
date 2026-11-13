import { tmpdir } from 'node:os';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const folder = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-parked-worker-'))));
after(() => rmSync(folder, { recursive: true, force: true }));
let binary;
function host() {
  if (binary) return binary;
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  let worker = source.slice(source.indexOf('func stageCallQuery()'), source.indexOf('final class StageCallMonitor {'));
  worker = worker.replace('let result = poll(&fds, 2, Int32(ceil(remaining * 1000)))',
    'let result = poll(&fds, 2, Int32(ceil(remaining * 1000))); if result == 0 { fputs("idle-wake\\n", stderr) }');
  const mutations = {
    'timed-idle': ['let deadline = CACurrentMediaTime() + 30', 'let deadline = CACurrentMediaTime() + 0.05'],
    'no-process-list-listener': ['guard audio.add(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList, queue, listener) == noErr', 'guard noErr == noErr'],
    'no-input-listener': ['guard audio.add(object, kAudioProcessPropertyIsRunningInput, queue, listener) == noErr', 'guard noErr == noErr'],
    'notification-is-quiet': ['var result = UInt8(stageCallQueryMain())', 'var result: UInt8 = 0'],
  };
  if (process.env.CHV4Q_WORKER_BROKEN) {
    const pair = mutations[process.env.CHV4Q_WORKER_BROKEN];
    assert.ok(pair && worker.includes(pair[0]), 'production worker mutation site'); worker = worker.replace(pair[0], pair[1]);
  }
  // Only metadata reads and the OS listener adapter are fake. The protocol, pipes,
  // invalidation/coalescing, listener census and blocking wait are production code.
  worker = worker.replace('AudioObjectAddPropertyListenerBlock(object, &address, queue, block)', 'fakeAdd(object, selector, queue, block)')
    .replace('AudioObjectRemovePropertyListenerBlock(object, &address, queue, block)', 'fakeRemove(object, selector)');
  const file = join(folder, 'worker.swift'), output = join(folder, 'worker');
  writeFileSync(file, `import Foundation
import CoreAudio
import QuartzCore
import Darwin
func spriteTrack(_ pid: pid_t) -> Bool { true }
func spriteUntrack(_ pid: pid_t) {}
let fakeLock = NSLock()
var fakeInput: UInt32 = 0, fakeObjects: [AudioObjectID] = [42], unavailable = false
var listeners: [String: (DispatchQueue, AudioObjectPropertyListenerBlock)] = [:]
func fakeAdd(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ queue: DispatchQueue,
    _ block: @escaping AudioObjectPropertyListenerBlock) -> OSStatus {
    fakeLock.lock(); defer { fakeLock.unlock() }
    listeners[String(object) + ":" + String(selector)] = (queue, block); return noErr
}
func fakeRemove(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> OSStatus {
    fakeLock.lock(); defer { fakeLock.unlock() }
    listeners.removeValue(forKey: String(object) + ":" + String(selector)); return noErr
}
struct FakeAudio {
    func processes() -> [AudioObjectID]? {
        fakeLock.lock(); defer { fakeLock.unlock() }; fputs("census\\n", stderr)
        return unavailable ? nil : fakeObjects
    }
    func word(_ object: AudioObjectID, _ selector: UInt32, _ scope: UInt32, _ element: UInt32) -> UInt32? {
        fakeLock.lock(); defer { fakeLock.unlock() }; return unavailable ? nil : fakeInput
    }
}
enum NarrationAudio { static let system = FakeAudio() }
${worker}
DispatchQueue.global(qos: .utility).async {
    var command: UInt8 = 0
    while read(3, &command, 1) == 1 {
        fakeLock.lock()
        fakeInput = command == 1 || command == 4 ? 1 : 0; unavailable = command == 2
        if command == 4 { fakeObjects = [42, 44] }
        let object = command == 4 ? AudioObjectID(kAudioObjectSystemObject) : command == 5 ? 44 : 42
        let selector = command == 4 ? kAudioHardwarePropertyProcessObjectList : kAudioProcessPropertyIsRunningInput
        let callback = listeners[String(object) + ":" + String(selector)]
        fakeLock.unlock()
        if let (queue, block) = callback {
            queue.async {
                var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
                block(1, &address)
            }
        }
    }
}
exit(stageCallWorkerMain())
`);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), file, '-o', output],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr); binary = output; return binary;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function start(t) {
  const child = spawn(host(), [], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
  let bytes = [], stderr = '', notify;
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  child.stdout.on('data', data => { bytes.push(...data); notify?.(); });
  child.stderr.on('data', data => { stderr += data; });
  child.stdin.on('error', () => {}); child.stdio[3].on('error', () => {});
  t.after(async () => {
    child.stdin.end(); child.stdio[3].end(); let timer;
    try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('worker EOF timeout')), 3000); })]); }
    finally { clearTimeout(timer); if (child.exitCode == null && child.signalCode == null) { child.kill('SIGKILL'); await closed; } }
  });
  return {
    child, closed, stats: () => ({ censuses: stderr.split('census\n').length - 1,
      idleWakes: stderr.split('idle-wake\n').length - 1, bytes: bytes.length }),
    request(byte) { child.stdin.write(Buffer.from([byte])); },
    change(byte) { child.stdio[3].write(Buffer.from([byte])); },
    async reply() {
      let timer;
      try {
        return await Promise.race([new Promise(resolve => {
          notify = () => { if (bytes.length) { notify = null; resolve(bytes.shift()); } }; notify();
        }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('metadata reply timeout: ' + stderr)), 1000); })]);
      } finally { clearTimeout(timer); notify = null; }
    },
  };
}
const native = { skip: process.platform !== 'darwin' };
test('CHV4Q subscribed idle worker performs zero additional censuses or replies while blocked', native, async t => {
  const worker = start(t); worker.request(3); assert.equal(await worker.reply(), 0);
  await delay(30); const before = worker.stats(); assert.equal(before.censuses, 2);
  worker.request(4); await delay(250);
  assert.equal(worker.child.exitCode, null, 'idle subscription must keep blocking');
  assert.deepEqual(worker.stats(), before, 'idle worker cannot poll or read Core Audio');
  worker.child.stdin.end(); assert.deepEqual(await worker.closed, { code: 0, signal: null });
});
test('CHV4Q an input callback returns a fresh active reading then quiet without a poll deadline', native, async t => {
  const worker = start(t); worker.request(3); assert.equal(await worker.reply(), 0);
  worker.request(4); worker.change(1); assert.equal(await worker.reply(), 1);
  worker.request(4); worker.change(0); assert.equal(await worker.reply(), 0);
  worker.request(4); worker.change(2); assert.equal(await worker.reply(), 2, 'unavailable is never quiet');
});
test('CHV4Q process-list changes subscribe new inputs before reading and retain changes before the next request', native, async t => {
  const worker = start(t); worker.request(3); assert.equal(await worker.reply(), 0);
  worker.change(4); await delay(30); worker.request(4); assert.equal(await worker.reply(), 1);
  worker.request(4); worker.change(5); assert.equal(await worker.reply(), 0, 'new process input has a listener');
});
