import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';

const native = new URL('../plugins/sleight/lib/mac-driver/native/', import.meta.url);
const read = name => readFile(new URL(name, native), 'utf8');
const nonce = 'a'.repeat(64);
const active = { kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: true, CGSSessionScreenIsLocked: false };

function child(command, args, input = '', options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', bytes => { stdout += bytes; });
    proc.stderr.on('data', bytes => { stderr += bytes; });
    proc.once('error', reject);
    proc.stdin.on('error', () => {});
    proc.once('close', code => resolve({ code, stdout, stderr }));
    proc.stdin.end(input);
  });
}

// Lock samples, notification delivery and time below are fake. driverMain is
// removed, so this executable never starts the product loop. The product's
// NSPasteboard.general read and DriverFocusProviders.system stay in the compile
// and abort through fatalError traps. A call crashes this test.
const boardCall = 'return try NSPasteboard.general.changeCount';
const boardTrap = 'fatalError("real board forbidden")';
const focusAnchor = '    static var system: DriverFocusProviders {\n';
const focusTrap = 'fatalError("real focus provider forbidden")';

function withProviderTraps(source) {
  const boardLine = `        ${boardCall}\n`;
  assert.equal(source.split(boardLine).length, 2, 'pasteboard call');
  assert.equal(source.split(focusAnchor).length, 2, 'focus provider');
  return source.replace(boardLine, `        ${boardTrap}\n`).replace(focusAnchor, `${focusAnchor}        ${focusTrap}\n`);
}

function assertProviderTrap(result, message) {
  assert.notEqual(result.code, 0, result.stderr);
  assert.match(result.stderr, new RegExp(message));
}

const harness = `
if CommandLine.arguments.contains("--prove-board-trap") {
    do {
        _ = try DriverClipboardWatch.systemCount()
        FileHandle.standardError.write(Data("board reached real pasteboard".utf8))
        FileHandle.standardError.write(Data([10]))
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("board threw".utf8))
        FileHandle.standardError.write(Data([10]))
        exit(2)
    }
}
if CommandLine.arguments.contains("--prove-focus-trap") {
    _ = DriverFocusProviders.system
    FileHandle.standardError.write(Data("focus reached real provider".utf8))
    FileHandle.standardError.write(Data([10]))
    exit(0)
}
var clock = 0.0, dictionaryCalls = 0, idleCalls = 0
var dictionary: [String: Any]? = ["kCGSSessionOnConsoleKey": true, "kCGSessionLoginDoneKey": true, "CGSSessionScreenIsLocked": false]
var notify: ((Bool) -> Void)?, notifyWhileSampling: Bool?
var acquired = 0, released = 0, cancelled = 0, workAfterCheckpoint = 0
var sleeps: [Double] = [], sleepScale = 1.0, sleepElapsed: Double?
var dictionaryDelay = 0.0
var notifyWhileSleeping: Bool?, dictionaryWhileSleeping: [String: Any]?
func makeSession() -> DriverSession {
    DriverSession(providers: DriverSessionProviders(
        dictionary: {
            dictionaryCalls += 1
            clock += dictionaryDelay
            if let locked = notifyWhileSampling { notifyWhileSampling = nil; notify?(locked) }
            return dictionary
        }, hidIdle: { idleCalls += 1; return 10 },
        acquireSleep: { acquired += 1; return 1 }, releaseSleep: { _ in released += 1; return 0 }),
        lockEvents: DriverLockEvents(observe: { callback in notify = callback; return { cancelled += 1; notify = nil } }),
        now: { clock }, sleep: { duration in
            sleeps.append(duration); clock += sleepElapsed ?? duration * sleepScale
            if let changed = dictionaryWhileSleeping { dictionary = changed; dictionaryWhileSleeping = nil }
            if let locked = notifyWhileSleeping { notifyWhileSleeping = nil; notify?(locked) }
        })
}
if CommandLine.arguments.contains("--runtime") {
    let core = DriverCore(fixture: [:])
    core.session = makeSession()
    let runtime = DriverRuntime(core: core, nonce: String(repeating: "a", count: 64))
    for method in ["getAXState", "setValue"] {
        runtime.register(method: method) { request, _ in
            if request.params["args"] as? [String] == ["admit"] { try request.admitInput() }
            let args = request.params["args"] as? [String] ?? []
            if args == ["original-fault"] || args == ["invalid-fault"] {
                if args == ["invalid-fault"] { dictionary = nil }
            }
            else if args.first == "dictionary" || args.first == "dictionary-copy" { dictionary?["CGSSessionScreenIsLocked"] = true }
            else { notify?(true) }
            if ["checkpoint", "checkpoint-copy", "dictionary", "dictionary-copy"].contains(args.first ?? "") {
                let guarded = args.first?.hasSuffix("copy") == true ? DriverRequest(copying: request, method: "settle", params: [:]) : request
                try guarded.check()
                workAfterCheckpoint += 1
                throw DriverFault("ACTION_UNCONFIRMED")
            }
            if ["fault", "original-fault", "invalid-fault"].contains(args.first ?? "") {
                var fault = DriverFault("ACTION_UNCONFIRMED")
                fault.disposition = ["delivery": "sent-unverified", "retry": "read-first", "settled": false]
                throw fault
            }
            return ["text": "must not escape after lock"]
        }
    }
    runtime.register(method: "health") { _, core in
        var value = core.session.sample().health; value["workAfterCheckpoint"] = workAfterCheckpoint; return value
    }
    runtime.serve()
} else {
    var session: DriverSession? = makeSession()
    while let line = readLine() {
        let input = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
        if let value = input["at"] as? Double { clock = value }
        if let raw = input["dictionary"] { dictionary = raw as? [String: Any] }
        notifyWhileSampling = input["notifyWhileSampling"] as? Bool
        notifyWhileSleeping = input["notifyWhileSleeping"] as? Bool
        dictionaryWhileSleeping = input["dictionaryWhileSleeping"] as? [String: Any]
        sleepScale = input["sleepScale"] as? Double ?? 1
        sleepElapsed = input["sleepElapsed"] as? Double
        dictionaryDelay = input["dictionaryDelay"] as? Double ?? 0
        let started = clock
        var output: [String: Any] = [:]
        do {
            switch input["op"] as? String ?? "sample" {
            case "lock": notify?(true)
            case "unlock": notify?(false)
            case "cached": output["locked"] = session!.cachedLockFlag
            case "drop": session = nil
            case "check": output = try session!.checkBeforeDesktop(allowLocked: input["allowLocked"] as? Bool ?? false).health
            case "desktop":
                output["value"] = try session!.withDesktopRequest { check in
                    try check(); workAfterCheckpoint += 1; return 42
                }
            case "mid":
                output["value"] = try session!.withDesktopRequest { check in
                    notify?(true)
                    if input["unlock"] as? Bool == true {
                        notify?(false); _ = session!.sample(); clock += 0.1; _ = session!.sample()
                    }
                    if input["checkpoint"] as? Bool == true { try check() }
                    workAfterCheckpoint += 1
                    return 42
                }
            default: output = session!.sample().health
            }
        } catch let fault as DriverFault { output["error"] = fault.json }
        output["dictionaryCalls"] = dictionaryCalls; output["idleCalls"] = idleCalls
        output["acquired"] = acquired; output["released"] = released; output["cancelled"] = cancelled
        output["workAfterCheckpoint"] = workAfterCheckpoint
        output["sleeps"] = sleeps; output["elapsed"] = clock - started
        let bytes = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
        FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data([10]))
    }
}
`;

test('lock observers use the sitting notification names and own their cancellation', async () => {
  const source = await read('DriverSession.swift');
  assert.match(source, /com\.apple\.screenIsLocked/);
  assert.match(source, /com\.apple\.screenIsUnlocked/);
  assert.match(source, /hammerspoon\.org\/docs\/hs\.caffeinate\.watcher/);
  assert.match(source, /DistributedNotificationCenter/);
  assert.match(source, /removeObserver/);
  assert.doesNotMatch(source, /postNotification|postToPid|\.activate\(/);
});

test('lock state and request endings use fake notifications and samples', { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-driver-lock-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'lock.swift'), binary = join(root, 'lock');
  let composed = macDriverSource();
  const replace = (from, to) => {
    assert.equal(composed.split(from).length, 2, `fixture anchor: ${from}`);
    composed = composed.replace(from, to);
  };
  replace('\ndriverMain()\n', '\n');
  // Only the temporary executable permits injecting the fake lock session.
  replace('let session: DriverSession', 'var session: DriverSession');
  composed = withProviderTraps(composed);
  await writeFile(source, composed + harness);
  const compile = await child('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), source, '-o', binary]);
  assert.equal(compile.code, 0, compile.stderr);
  t.diagnostic(`trapped lock binary ${(await stat(binary)).size} bytes`);
  const boardProbe = await child(binary, ['--prove-board-trap']);
  assertProviderTrap(boardProbe, 'real board forbidden');
  const focusProbe = await child(binary, ['--prove-focus-trap']);
  assertProviderTrap(focusProbe, 'real focus provider forbidden');
  const run = async operations => {
    const result = await child(binary, [], operations.map(op => JSON.stringify(op) + '\n').join(''));
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
    return result.stdout.trim().split('\n').map(line => JSON.parse(line));
  };
  await t.test('notifications flip the cached flag without sampling providers', async () => {
    const out = await run([{ op: 'lock' }, { op: 'cached' }, { op: 'unlock' }, { op: 'cached' }, { op: 'drop' }]);
    assert.equal(out[1].locked, true); assert.equal(out[3].locked, false);
    assert.equal(out[4].cancelled, 1);
    for (const row of out) { assert.equal(row.dictionaryCalls, 0); assert.equal(row.idleCalls, 0); assert.equal(row.acquired, 0); }
  });
  await t.test('first health after unlock reports the raw dictionary value', async () => {
    const out = await run([{ dictionary: { ...active, CGSSessionScreenIsLocked: true } },
      { op: 'unlock' }, { dictionary: active }]);
    assert.equal(out[0].sessionLocked, true);
    assert.equal(out[2].sessionLocked, false);
    assert.equal(out[2].dictionaryCalls, 2);
  });
  await t.test('first desktop request confirms unlock inside that request', async () => {
    const out = await run([{ dictionary: { ...active, CGSSessionScreenIsLocked: true } },
      { op: 'unlock' }, { op: 'check', at: 1, dictionary: active }]);
    assert.equal(out[2].error, undefined);
    assert.equal(out[2].sessionLocked, false);
    assert.equal(out[2].dictionaryCalls, 3);
    assert.equal(out[2].sleeps.length, 1);
    assert.ok(Math.abs(out[2].sleeps[0] - 0.1) < 1e-9);
    assert.ok(Math.abs(out[2].elapsed - 0.1) < 1e-9);
  });
  await t.test('a lock appearing in the second sample refuses before desktop work', async () => {
    const out = await run([{ op: 'lock' }, { op: 'check', dictionaryWhileSleeping: { ...active, CGSSessionScreenIsLocked: true } }]);
    assert.equal(out[1].error.code, 'SCREEN_LOCKED'); assert.equal(out[1].dictionaryCalls, 2);
    assert.equal(out[1].sleeps.length, 1);
  });
  await t.test('unlock needs two samples at least 100 ms apart', async () => {
    const out = await run([{ op: 'lock' }, { op: 'unlock' }, { op: 'check', at: 1, sleepScale: 0 },
      { op: 'check', at: 1.099, sleepScale: 0 }, { op: 'check', at: 1.1 }]);
    assert.equal(out[2].error.code, 'SCREEN_LOCKED'); assert.equal(out[3].error.code, 'SCREEN_LOCKED');
    assert.equal(out[4].sessionLocked, false); assert.equal(out[4].error, undefined);
  });
  await t.test('each lock cycle confirms in its first request with no later wait', async () => {
    const out = await run([{ op: 'check' }, { op: 'lock' }, { op: 'unlock' }, { op: 'check' },
      { op: 'check' }, { op: 'lock' }, { op: 'unlock' }, { op: 'check', at: 2 }]);
    for (const index of [0, 3, 4, 7]) assert.equal(out[index].error, undefined);
    assert.deepEqual(out[0].sleeps, []);
    assert.equal(out[3].sleeps.length, 1); assert.equal(out[4].sleeps.length, 1);
    assert.equal(out[7].sleeps.length, 2);
  });
  await t.test('desktop scopes admit their first post-unlock handler in each cycle', async () => {
    const out = await run([{ op: 'lock' }, { op: 'unlock' }, { op: 'desktop' },
      { op: 'lock' }, { op: 'unlock' }, { op: 'desktop', at: 2 }]);
    assert.equal(out[2].error, undefined); assert.equal(out[2].value, 42);
    assert.equal(out[2].workAfterCheckpoint, 1); assert.equal(out[2].sleeps.length, 1);
    assert.equal(out[5].error, undefined); assert.equal(out[5].value, 42);
    assert.equal(out[5].workAfterCheckpoint, 2); assert.equal(out[5].sleeps.length, 2);
  });
  await t.test('a prior raw health sample reduces the remaining confirmation wait', async () => {
    const out = await run([{ op: 'lock' }, { op: 'unlock' }, { at: 1 }, { op: 'check', at: 1.04 }]);
    assert.equal(out[2].sessionLocked, false); assert.equal(out[3].error, undefined);
    assert.equal(out[3].sleeps.length, 1);
    assert.ok(Math.abs(out[3].elapsed - 0.06) < 1e-9);
  });
  await t.test('confirmation accepts 150 ms but refuses an oversleep without a second sample', async () => {
    for (const [sleepElapsed, passes] of [[0.15, true], [0.150001, false]]) {
      const out = await run([{ op: 'lock' }, { op: 'check', sleepElapsed }]);
      assert.equal(out[1].sleeps.length, 1);
      assert.equal(out[1].dictionaryCalls, passes ? 2 : 1);
      assert.equal(out[1].error?.code, passes ? undefined : 'SCREEN_LOCKED');
    }
  });
  await t.test('a slow first sample leaves too little budget to start the wait', async () => {
    const out = await run([{ op: 'lock' }, { op: 'check', dictionaryDelay: 0.06 }]);
    assert.equal(out[1].error.code, 'SCREEN_LOCKED');
    assert.deepEqual(out[1].sleeps, []); assert.equal(out[1].dictionaryCalls, 1);
    assert.ok(out[1].elapsed <= 0.15);
  });
  await t.test('a slow second sample cannot admit desktop work past the budget', async () => {
    const out = await run([{ op: 'lock' }, { op: 'check', dictionaryDelay: 0.03 }]);
    assert.equal(out[1].error.code, 'SCREEN_LOCKED');
    assert.equal(out[1].sleeps.length, 1); assert.equal(out[1].dictionaryCalls, 2);
  });
  await t.test('a notification during the wait refuses without a second wait', async () => {
    for (const notifyWhileSleeping of [true, false]) {
      const out = await run([{ op: 'lock' }, { op: 'check', notifyWhileSleeping }]);
      assert.equal(out[1].error.code, 'SCREEN_LOCKED');
      assert.equal(out[1].sleeps.length, 1); assert.equal(out[1].dictionaryCalls, 2);
    }
  });
  await t.test('invalid or inactive confirmation samples refuse with no further wait', async () => {
    for (const dictionaryWhileSleeping of [{}, { ...active, kCGSSessionOnConsoleKey: false },
      { ...active, kCGSessionLoginDoneKey: false }, { ...active, CGSSessionScreenIsLocked: 'false' }]) {
      const out = await run([{ op: 'lock' }, { op: 'check', dictionaryWhileSleeping }]);
      assert.equal(out[1].error.code, 'SCREEN_LOCKED'); assert.equal(out[1].sleeps.length, 1);
    }
  });
  await t.test('an absent lock key confirms as unlocked under the sitting assumption', async () => {
    const out = await run([{ op: 'lock' }, { op: 'check', dictionary: {
      kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: true } }]);
    assert.equal(out[1].error, undefined); assert.equal(out[1].sessionLocked, false);
    assert.equal(out[1].dictionaryCalls, 2); assert.equal(out[1].sleeps.length, 1);
  });
  await t.test('dictionary lock overrides an unlock notification and restarts confirmation', async () => {
    const out = await run([{ op: 'unlock' }, { at: 1 }, { at: 1.2, dictionary: { ...active, CGSSessionScreenIsLocked: true } },
      { op: 'check', at: 2, dictionary: active, sleepScale: 0 }, { op: 'check', at: 2.11 }]);
    assert.equal(out[2].sessionLocked, true); assert.equal(out[3].error.code, 'SCREEN_LOCKED'); assert.equal(out[4].error, undefined);
  });
  await t.test('unknown or inactive samples break the unlocked pair', async () => {
    for (const dictionary of [null, {}, { ...active, kCGSSessionOnConsoleKey: false }, { ...active, CGSSessionScreenIsLocked: 'false' }]) {
      const out = await run([{ op: 'lock' }, { op: 'unlock' }, { at: 1 }, { at: 1.2, dictionary },
        { op: 'check', at: 2, dictionary: active, sleepScale: 0 }, { op: 'check', at: 2.11 }]);
      assert.equal(out[4].error.code, 'SCREEN_LOCKED'); assert.equal(out[5].error, undefined);
    }
  });
  await t.test('a missed notification still locks from the dictionary and recovers with two samples', async () => {
    const out = await run([{ dictionary: { ...active, CGSSessionScreenIsLocked: true } },
      { op: 'check', at: 1, dictionary: active, sleepScale: 0 }, { op: 'check', at: 1.11 }]);
    assert.equal(out[0].sessionLocked, true); assert.equal(out[1].error.code, 'SCREEN_LOCKED'); assert.equal(out[2].error, undefined);
  });
  await t.test('a second notification resets the pair', async () => {
    const out = await run([{ op: 'lock' }, { op: 'unlock' }, { at: 1 }, { op: 'lock' }, { op: 'unlock' },
      { op: 'check', at: 1.2, sleepScale: 0 }, { op: 'check', at: 1.31 }]);
    assert.equal(out[5].error.code, 'SCREEN_LOCKED'); assert.equal(out[6].error, undefined);
  });
  await t.test('an unlock arriving during the dictionary read cannot count that read toward confirmation', async () => {
    const out = await run([{ op: 'lock' }, { at: 1, notifyWhileSampling: false },
      { op: 'check', at: 1.2, sleepScale: 0 }, { op: 'check', at: 1.31 }]);
    assert.equal(out[1].sessionLocked, false); assert.equal(out[2].error.code, 'SCREEN_LOCKED'); assert.equal(out[3].error, undefined);
  });
  await t.test('allowLocked remains an explicit valid-session override', async () => {
    const out = await run([{ op: 'lock' }, { op: 'check', allowLocked: true },
      { op: 'check', allowLocked: true, dictionary: null }]);
    assert.equal(out[1].error, undefined); assert.equal(out[1].sessionLocked, false); assert.equal(out[2].error.code, 'DRIVER_INTERNAL');
    assert.deepEqual(out[1].sleeps, []);
  });
  await t.test('a cached lock cannot turn an invalid dictionary flag into a valid allowLocked session', async () => {
    const out = await run([{ op: 'lock' }, { dictionary: { ...active, CGSSessionScreenIsLocked: 'false' } },
      { op: 'check', allowLocked: true }, { op: 'check' }]);
    assert.equal(out[1].sessionLocked, null);
    assert.equal(out[2].error.code, 'DRIVER_INTERNAL'); assert.equal(out[3].error.code, 'SCREEN_LOCKED');
  });
  await t.test('a lock ends the current request at a checkpoint or at completion', async () => {
    for (const checkpoint of [false, true]) {
      const out = await run([{ op: 'mid', checkpoint }]);
      assert.equal(out[0].error.code, 'SCREEN_LOCKED'); assert.equal(out[0].value, undefined);
      assert.equal(out[0].workAfterCheckpoint, checkpoint ? 0 : 1);
    }
  });
  await t.test('lock and unlock within one request still end that request', async () => {
    const out = await run([{ op: 'mid', unlock: true }, { op: 'check' }]);
    assert.equal(out[0].error.code, 'SCREEN_LOCKED'); assert.equal(out[1].error, undefined);
  });
  const runtime = async (method, args) => {
    const request = { protocol: 'sleight.driver/1', platform: 'darwin', nonce, id: 1, method,
      params: method === 'getAXState' ? {} : { windowId: '7', processStart: '1.2', readId: 1, args }, deadline: Date.now() + 5000 };
    const health = { ...request, id: 2, method: 'health', params: {} };
    const result = await child(binary, ['--runtime'], JSON.stringify(request) + '\n' + JSON.stringify(health) + '\n');
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
    const [reply, metrics] = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(metrics.ok, true);
    return { ...reply, metrics: metrics.result };
  };
  await t.test('runtime discards a read result if lock arrives during its handler', async () => {
    const out = await runtime('getAXState');
    assert.equal(out.ok, false); assert.equal(out.error.code, 'SCREEN_LOCKED'); assert.equal(out.result, undefined);
  });
  await t.test('runtime preserves usual disposition before and after input admission', async () => {
    for (const args of [[], ['admit'], ['checkpoint'], ['checkpoint-copy'], ['fault'], ['dictionary'], ['dictionary-copy']]) {
      const out = await runtime('setValue', args);
      assert.equal(out.error.code, 'SCREEN_LOCKED');
      assert.equal(out.error.delivery, args[0] === 'fault' ? 'sent-unverified' : args[0] === 'admit' ? 'unknown' : 'not-sent');
      assert.equal(out.error.retry, ['admit', 'fault'].includes(args[0]) ? 'read-first' : 'safe');
      assert.equal(out.metrics.workAfterCheckpoint, 0);
    }
  });
  await t.test('runtime preserves the original fault if resampling finds no lock', async () => {
    for (const args of [['original-fault'], ['invalid-fault']]) {
      const out = await runtime('setValue', args);
      assert.equal(out.error.code, 'ACTION_UNCONFIRMED'); assert.equal(out.error.unhealthy, false);
      assert.equal(out.error.delivery, 'sent-unverified'); assert.equal(out.error.retry, 'read-first');
      assert.equal(out.error.settled, false);
    }
  });
  const recordingBoard = `
final class RecordingBoard {
    static let general = RecordingBoard()
    var changeCount: Int {
        FileHandle.standardError.write(Data("board reached pasteboard API\\n".utf8))
        return 0
    }
}
`;
  const recordingFocus = `
enum RecordingFocus {
    static var provider: DriverFocusProviders {
        FileHandle.standardError.write(Data("focus reached focus API\\n".utf8))
        return DriverFocusProviders(
            secureInput: { false },
            heldModifiers: { 0 },
            snapshot: { (_: Double) throws -> DriverFocusSnapshot in throw DriverFault("KEY_FOCUS_UNAVAILABLE") },
            belief: { _, _ in false },
            makeEvent: { _ in { _ in } },
            now: { 0 },
            pause: { _ in },
            restore: { _, _, _ in false },
            frontmost: { () throws -> DriverFocusSnapshot in throw DriverFault("KEY_FOCUS_UNAVAILABLE") },
            personInputSince: { _ in false })
    }
}
`;
  await t.test('removing the pasteboard trap lets the recording stand-in fail the crash probe', async () => {
    assert.equal(composed.split(boardTrap).length, 2);
    const openedSource = composed.replace(boardTrap, 'return try RecordingBoard.general.changeCount');
    assert.equal(openedSource.includes(boardTrap), false);
    assert.equal(openedSource.includes('NSPasteboard.general'), false);
    assert.equal(openedSource.split(focusTrap).length, 2);
    const openedFile = join(root, 'lock-opened.swift'), openedBinary = join(root, 'lock-opened');
    await writeFile(openedFile, openedSource + harness + recordingBoard);
    const openedCompile = await child('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), openedFile, '-o', openedBinary]);
    assert.equal(openedCompile.code, 0, openedCompile.stderr);
    const opened = await child(openedBinary, ['--prove-board-trap']);
    assert.equal(opened.code, 0, opened.stderr);
    assert.match(opened.stderr, /board reached pasteboard API/);
    assert.doesNotMatch(opened.stderr, /real board forbidden/);
    assert.throws(() => assertProviderTrap(opened, 'real board forbidden'), { code: 'ERR_ASSERTION' });
  });
  await t.test('removing the focus trap lets the recording stand-in fail the crash probe', async () => {
    assert.equal(composed.split(focusTrap).length, 2);
    const openedSource = composed.replace(focusTrap, 'return RecordingFocus.provider');
    assert.equal(openedSource.includes(focusTrap), false);
    assert.equal(openedSource.split(boardTrap).length, 2);
    assert.equal(openedSource.includes('NSPasteboard.general'), false);
    const openedFile = join(root, 'lock-focus-opened.swift'), openedBinary = join(root, 'lock-focus-opened');
    await writeFile(openedFile, openedSource + harness + recordingFocus);
    const openedCompile = await child('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), openedFile, '-o', openedBinary]);
    assert.equal(openedCompile.code, 0, openedCompile.stderr);
    const opened = await child(openedBinary, ['--prove-focus-trap']);
    assert.equal(opened.code, 0, opened.stderr);
    assert.match(opened.stderr, /focus reached focus API/);
    assert.match(opened.stderr, /focus reached real provider/);
    assert.doesNotMatch(opened.stderr, /real focus provider forbidden/);
    assert.throws(() => assertProviderTrap(opened, 'real focus provider forbidden'), { code: 'ERR_ASSERTION' });
  });
});
