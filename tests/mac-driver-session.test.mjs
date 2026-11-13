import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, rm, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const exec = promisify(execFile);
// Independent fixture names copied from remote-approvals.js readPresence.
const sessionKeys = ['kCGSSessionOnConsoleKey', 'kCGSessionLoginDoneKey', 'CGSSessionScreenIsLocked'];
const [consoleKey, loginKey, lockKey] = sessionKeys;
const active = { [consoleKey]: true, [loginKey]: true, [lockKey]: false };

test('session key names match the existing remote approvals reader', () => {
  const reader = readFileSync(new URL('../plugins/sleight/lib/remote-approvals.js', import.meta.url), 'utf8');
  const swift = readFileSync(new URL('../plugins/sleight/lib/mac-driver/native/DriverSession.swift', import.meta.url), 'utf8');
  assert.deepEqual([...new Set([...reader.matchAll(/session\.(\w+)/g)].map(match => match[1]))].sort(), [...sessionKeys].sort());
  assert.deepEqual([...new Set([...swift.matchAll(/dictionary\?\["([^"]+)"\]/g)].map(match => match[1]))].sort(), [...sessionKeys].sort());
});

// Only these fake closures execute. The production entry point is removed before
// compilation; no NSApplication, session API, assertion or desktop call runs.
// Linking the real RT2 sources took 165 s in the first review build, hence 300 s.
const harness = `
while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let input = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { exit(64) }
    var dictionaryCalls = 0, idleCalls = 0, nextID: UInt32 = 10
    var clock = 0.0
    var events: [String] = []
    let providers = DriverSessionProviders(
        dictionary: {
            dictionaryCalls += 1
            if dictionaryCalls > 1, let changed = input["afterSession"] as? [String: Any] { return changed }
            return input["session"] as? [String: Any]
        },
        hidIdle: { idleCalls += 1
            if input["idleKind"] as? String == "nan" { return .nan }
            if input["idleKind"] as? String == "infinity" { return .infinity }
            return (input["idle"] as? NSNumber)?.doubleValue ?? 12.5
        },
        acquireSleep: {
            if input["failAcquire"] as? Bool == true { events.append("acquire-failed"); throw DriverFault("DRIVER_INTERNAL", unhealthy: true) }
            nextID += 1; events.append("acquire-\\(nextID)"); return nextID
        },
        releaseSleep: { id in events.append("release-\\(id)"); return input["failRelease"] as? Bool == true ? -1 : 0 })
    let session = DriverSession(providers: providers, now: { clock })
    var output: [String: Any] = [:]
    do {
        switch input["op"] as? String ?? "sample" {
        case "sample":
            let sample = session.sample(); output = sample.health; output["available"] = sample.available
        case "check":
            output = try session.checkBeforeDesktop(allowLocked: input["allowLocked"] as? Bool ?? false).health
        case "repeat":
            _ = session.sample(); _ = session.sample()
        case "transition":
            _ = session.sample(); _ = session.sample(); clock = 0.1
            output = try session.checkBeforeDesktop().health
        case "inert": break
        case "power":
            output["value"] = try session.withRequestPower {
                events.append("body")
                if input["throwBody"] as? Bool == true { throw DriverFault("DEADLINE_EXCEEDED", unhealthy: true) }
                return 42
            }
        case "guarded":
            try session.withRequestPower {
                try session.checkBeforeDesktop()
                events.append("input")
            }
        case "nested":
            try session.withRequestPower {
                events.append("outer")
                try session.withRequestPower { events.append("inner") }
                events.append("outer-end")
            }
        default: exit(64)
        }
    } catch let fault as DriverFault { output["error"] = fault.json }
      catch { exit(65) }
    output["dictionaryCalls"] = dictionaryCalls; output["idleCalls"] = idleCalls; output["events"] = events
    let reply = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
    FileHandle.standardOutput.write(reply); FileHandle.standardOutput.write(Data([10]))
}
`;

test('session sampler and request power scope use only fake providers', { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
  const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-session-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'session.swift'), binary = join(root, 'session');
  const production = macDriverSource();
  const entry = production.indexOf('// Source: DriverMain.swift\n');
  assert.ok(entry > 0);
  await writeFile(source, production.slice(0, entry) + harness);
  await exec('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-module-cache-path', join(root, 'modules'), source, '-o', binary], { maxBuffer: 65536 });
  t.diagnostic(`fake-only session binary ${(await stat(binary)).size} bytes`);
  const run = async input => {
    const child = execFile(binary, [], { encoding: 'utf8', maxBuffer: 65536 });
    const completion = new Promise((resolve, reject) => {
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.once('error', reject);
      child.once('close', code => {
        try { assert.equal(code, 0, stderr); assert.equal(stderr, ''); resolve(JSON.parse(stdout)); }
        catch (error) { reject(error); }
      });
    });
    child.stdin.end(JSON.stringify({ session: active, ...input }) + '\n');
    return completion;
  };
  await t.test('construction has no session, HID or power side effects', async () => {
    const value = await run({ op: 'inert' });
    assert.equal(value.dictionaryCalls, 0); assert.equal(value.idleCalls, 0); assert.deepEqual(value.events, []);
  });
  await t.test('health reports five sampled values without a power assertion', async () => {
    const value = await run({ idle: 321.25 });
    assert.equal(value.onConsole, true); assert.equal(value.loginDone, true); assert.equal(value.sessionLocked, false);
    assert.equal(value.hidIdleSeconds, 321.25); assert.equal(value.available, true);
    assert.equal(value.secureInput, false);
    assert.equal(value.dictionaryCalls, 1); assert.equal(value.idleCalls, 1); assert.deepEqual(value.events, []);
  });
  await t.test('sampling never caches session or HID state', async () => {
    const value = await run({ op: 'repeat' });
    assert.equal(value.dictionaryCalls, 2); assert.equal(value.idleCalls, 2);
  });
  await t.test('pre-input check observes a lock after an earlier unlocked health sample', async () => {
    const value = await run({ op: 'transition', afterSession: { ...active, [lockKey]: true } });
    assert.equal(value.error.code, 'SCREEN_LOCKED'); assert.equal(value.dictionaryCalls, 3);
  });
  await t.test('pre-input check confirms an unlock with two samples after a locked health sample', async () => {
    const value = await run({ op: 'transition', session: { ...active, [lockKey]: true }, afterSession: active });
    assert.equal(value.error, undefined); assert.equal(value.sessionLocked, false); assert.equal(value.dictionaryCalls, 3);
  });
  for (const locked of [true, 1]) await t.test(`locked flag ${JSON.stringify(locked)} refuses before input`, async () => {
    const value = await run({ op: 'guarded', session: { ...active, [lockKey]: locked } });
    assert.equal(value.error.code, 'SCREEN_LOCKED'); assert.deepEqual(value.events, ['acquire-11', 'release-11']);
  });
  await t.test('explicit allowLocked passes only a valid logged-in console session', async () => {
    const value = await run({ op: 'check', allowLocked: true, session: { ...active, [lockKey]: true } });
    assert.equal(value.sessionLocked, true); assert.equal(value.error, undefined);
  });
  await t.test('absence with valid console flags retains the unmeasured unlocked assumption', async () => {
    const value = await run({ session: { [consoleKey]: true, [loginKey]: true } });
    assert.equal(value.sessionLocked, false); assert.equal(value.available, true);
    const checked = await run({ op: 'check', session: { [consoleKey]: true, [loginKey]: true } });
    assert.equal(checked.sessionLocked, false); assert.equal(checked.error, undefined);
  });
  for (const session of [null, {}, { ...active, [consoleKey]: false },
    { ...active, [loginKey]: false }, { ...active, [lockKey]: 'false' },
    { ...active, [consoleKey]: 'true' }, { ...active, [loginKey]: 2 }]) {
    await t.test(`unavailable or inactive session refuses: ${JSON.stringify(session)}`, async () => {
      const value = await run({ op: 'check', session, allowLocked: true });
      assert.equal(value.error.code, 'DRIVER_INTERNAL'); assert.equal(value.error.unhealthy, true);
    });
  }
  await t.test('unavailable health uses JSON null, never a false unlocked claim', async () => {
    const value = await run({ session: null, idleKind: 'nan' });
    for (const field of ['onConsole', 'loginDone', 'sessionLocked', 'hidIdleSeconds']) assert.equal(value[field], null);
    assert.equal(value.available, false);
  });
  for (const input of [{ idle: -1 }, { idleKind: 'nan' }, { idleKind: 'infinity' }]) {
    await t.test(`invalid HID sample refuses: ${JSON.stringify(input)}`, async () => {
      const value = await run({ ...input, op: 'check' }); assert.equal(value.error.code, 'DRIVER_INTERNAL');
    });
  }
  await t.test('zero HID idle is a valid measurement', async () => {
    const value = await run({ idle: 0 }); assert.equal(value.hidIdleSeconds, 0); assert.equal(value.available, true);
  });
  await t.test('successful request holds and releases its assertion once', async () => {
    const value = await run({ op: 'power' }); assert.equal(value.value, 42);
    assert.deepEqual(value.events, ['acquire-11', 'body', 'release-11']);
  });
  await t.test('throwing request releases before propagating the original fault', async () => {
    const value = await run({ op: 'power', throwBody: true }); assert.equal(value.error.code, 'DEADLINE_EXCEEDED');
    assert.deepEqual(value.events, ['acquire-11', 'body', 'release-11']);
  });
  await t.test('failed acquisition never runs the request or releases an unowned id', async () => {
    const value = await run({ op: 'power', failAcquire: true }); assert.equal(value.error.code, 'DRIVER_INTERNAL');
    assert.deepEqual(value.events, ['acquire-failed']);
  });
  await t.test('failed release retires the helper instead of reporting success', async () => {
    const value = await run({ op: 'power', failRelease: true }); assert.equal(value.error.code, 'DRIVER_INTERNAL');
    assert.equal(value.error.unhealthy, true); assert.deepEqual(value.events, ['acquire-11', 'body', 'release-11']);
  });
  await t.test('nested scopes retain separate assertion ownership', async () => {
    const value = await run({ op: 'nested' });
    assert.deepEqual(value.events, ['acquire-11', 'outer', 'acquire-12', 'inner', 'release-12', 'outer-end', 'release-11']);
  });
});
