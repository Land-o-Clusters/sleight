import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp, removeTemp } from '../scripts/temp-leftovers.mjs';
import * as processGuard from '../bench/sitting-process.mjs';

const path = '/System/Library/CoreServices/NotificationCenter.app/Contents/MacOS/NotificationCenter';
test('kernel executable and layer identify only the banner container, with appearance durations', { skip: process.platform !== 'darwin' }, t => {
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-overlay-test-'))); t.after(() => removeTemp(bank));
  const source = readFileSync(new URL('../bench/sitting-guard.swift', import.meta.url), 'utf8');
  assert.ok(source.includes('// System overlay metadata.'), 'overlay classifier is implemented');
  const part = source.slice(source.indexOf('// System overlay metadata.'), source.indexOf('// End system overlay metadata.'));
  const variants = [
    ['good', part],
    ['owner-name', part.replace('executable == notificationExecutable', 'owner == "NotificationCenter"')],
    ['any-layer', part.replace('layer == 21 && ', '')],
  ];
  let swift = 'import Foundation\n';
  for (const [i, [name, text]] of variants.entries()) {
    const code = text.replace('layer: Int) -> Bool', 'layer: Int, owner: String = "") -> Bool')
      .replaceAll('notificationExecutable', `notificationExecutable${i}`).replaceAll('systemOverlayExempt', `systemOverlayExempt${i}`).replaceAll('SystemOverlayTracker', `SystemOverlayTracker${i}`);
    swift += code + `
var tracker${i} = SystemOverlayTracker${i}()
let yes${i} = systemOverlayExempt${i}(executable: "${path}", layer: 21, owner: "ignored")
let no${i} = systemOverlayExempt${i}(executable: "/tmp/NotificationCenter", layer: 21, owner: "NotificationCenter")
let layer${i} = systemOverlayExempt${i}(executable: "${path}", layer: 0, owner: "NotificationCenter")
let unreadable${i} = systemOverlayExempt${i}(executable: nil, layer: 21, owner: "NotificationCenter")
let start${i} = tracker${i}.sample([34: (pid: 734, layer: 21)], now: 10, utcMs: 10000)
let middle${i} = tracker${i}.sample([34: (pid: 734, layer: 21)], now: 11, utcMs: 11000)
let end${i} = tracker${i}.sample([:], now: 12.5, utcMs: 12500)
let again${i} = tracker${i}.sample([34: (pid: 734, layer: 21)], now: 13, utcMs: 13000)
let result${i}: [String: Any] = ["name": "${name}", "yes": yes${i}, "spoof": no${i}, "layer": layer${i}, "unreadable": unreadable${i}, "start": start${i}, "middle": middle${i}, "end": end${i}, "again": again${i}]
print(String(data: try! JSONSerialization.data(withJSONObject: result${i}), encoding: .utf8)!)
`;
  }
  writeFileSync(join(bank, 'test.swift'), swift);
  const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'modules'), join(bank, 'test.swift'), '-o', join(bank, 'test')],
    { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(join(bank, 'test'), [], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assert.equal(run.status, 0, run.stderr);
  const [good, ...broken] = run.stdout.trim().split('\n').map(JSON.parse);
  const verify = row => { assert.equal(row.yes, true); assert.equal(row.spoof, false); assert.equal(row.layer, false); assert.equal(row.unreadable, false); };
  verify(good); for (const row of broken) assert.throws(() => verify(row), assert.AssertionError, row.name);
  assert.deepEqual(good.start, [{ record: 'system-overlay', state: 'appeared', pid: 734, window: 34, layer: 21, timeUtcMs: 10000, onscreenMs: 0 }]);
  assert.deepEqual(good.middle, []);
  assert.deepEqual(good.end, [{ record: 'system-overlay', state: 'cleared', pid: 734, window: 34, layer: 21, timeUtcMs: 12500, onscreenMs: 2500 }]);
  assert.equal(good.again.length, 1); assert.equal(good.again[0].onscreenMs, 0);
  assert.doesNotMatch(JSON.stringify(good), /title|content/i);
});

test('the production window filter uses the kernel resolver for each candidate', { skip: process.platform !== 'darwin' }, t => {
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-overlay-filter-'))); t.after(() => removeTemp(bank));
  const source = readFileSync(new URL('../bench/sitting-guard.swift', import.meta.url), 'utf8');
  const part = source.slice(source.indexOf('// System overlay metadata.'), source.indexOf('// End system overlay metadata.'));
  const method = source.slice(source.indexOf('    func overlayWindows('), source.indexOf('    func recordOverlayEnd('));
  const swift = `import Foundation
let kCGWindowLayer = "layer", kCGWindowOwnerPID = "pid", kCGWindowNumber = "id"
func num(_ row: [String: Any], _ key: String) -> Int { row[key] as? Int ?? -1 }
func kernelExecutable(_ pid: Int32) -> String? { nil }
${part}
struct Replay { ${method} }
let rows: [[String: Any]] = [["pid": 734, "id": 34, "layer": 21], ["pid": 734, "id": 35, "layer": 0], ["pid": 9, "id": 90, "layer": 21]]
var reads: [Int32] = []
let ids = Replay().overlayWindows(rows, readExecutable: { reads.append($0); return $0 == 734 ? "${path}" : "/tmp/NotificationCenter" })
print(String(data: try! JSONSerialization.data(withJSONObject: ["ids": ids.sorted(), "reads": reads]), encoding: .utf8)!)
`;
  writeFileSync(join(bank, 'test.swift'), swift);
  const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'modules'), join(bank, 'test.swift'), '-o', join(bank, 'test')],
    { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync(join(bank, 'test'), [], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { ids: [34], reads: [734, 9] });
});

async function pauseProof(waitForOverlay, { persistent = false, person = false } = {}) {
  let now = 0, sent = 0, checks = 0, preflights = 0;
  const calls = [];
  const operation = async () => { sent++; calls.push('input'); };
  const check = async () => { checks++; if (person && now > 0) throw Error('PERSON_ACTIVE'); return { systemOverlayActive: persistent || now < 200 }; };
  const run = async () => {
    await waitForOverlay({ check, now: () => now, wait: async ms => { now += ms; calls.push('wait'); },
      preflight: async () => { preflights++; calls.push('preflight'); } });
    await operation();
  };
  if (persistent || person) { await assert.rejects(run(), new RegExp(person ? 'PERSON_ACTIVE' : 'SYSTEM_OVERLAY_PERSISTENT')); assert.equal(sent, 0); }
  else { await run(); assert.equal(sent, 1); assert.ok(now >= 200); assert.equal(preflights, 1); assert.ok(checks >= 4); assert.deepEqual(calls.slice(-2), ['preflight', 'input']); }
  if (persistent) assert.equal(now, 30000);
}
test('input waits for clearance then repeats preflight, with no input on a 30 second or HID stop', async () => {
  assert.equal(typeof processGuard.waitForSystemOverlay, 'function');
  await pauseProof(processGuard.waitForSystemOverlay);
  await pauseProof(processGuard.waitForSystemOverlay, { persistent: true });
  await pauseProof(processGuard.waitForSystemOverlay, { person: true });
});
test('broken send-while-onscreen variant fails the input ordering proof', async () => {
  const source = readFileSync(new URL('../bench/sitting-process.mjs', import.meta.url), 'utf8');
  const before = 'if (!sample.systemOverlayActive) return sample;';
  assert.ok(source.includes(before));
  const broken = await import('data:text/javascript;base64,' + Buffer.from(source.replace(before, 'return sample;')).toString('base64'));
  await assert.rejects(pauseProof(broken.waitForSystemOverlay), assert.AssertionError);
});

const banner = { pid: 734, id: 34, layer: 21, executable: path };
function compileGuard(source, bank) {
  writeFileSync(join(bank, 'guard.swift'), source);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'modules'), join(bank, 'guard.swift'), '-o', join(bank, 'guard')],
    { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
  assert.equal(built.status, 0, built.stderr);
  return join(bank, 'guard');
}
function dumpOverlay(binary, row) {
  const run = spawnSync(binary, ['--dump-overlay'], { input: JSON.stringify(row) + '\n', encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.drawing, false);
  return parsed;
}
test('a banner stays foreign for every guard kind unless that arm opts in', { skip: process.platform !== 'darwin', timeout: 600000 }, t => {
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-overlay-dump-'))); t.after(() => rmSync(bank, { recursive: true, force: true }));
  const source = readFileSync(new URL('../bench/sitting-guard.swift', import.meta.url), 'utf8');
  const binary = compileGuard(source, bank);
  for (const kind of ['vm', 'runtime', 'uc3f-away', 'uc3f-present', 'renderer']) {
    const row = dumpOverlay(binary, { kind, windows: [banner] });
    assert.equal(row.exempt, false, kind);
    assert.deepEqual(row.overlayIDs, []);
    assert.equal(row.foreign, true, kind);
    assert.equal(row.stop, 'FOREIGN_WINDOW', kind);
  }
  const opted = dumpOverlay(binary, { kind: 'uc3f-away', exemptSystemOverlay: true, windows: [banner] });
  assert.equal(opted.exempt, true);
  assert.deepEqual(opted.overlayIDs, [34]);
  assert.equal(opted.foreign, false);
  assert.equal(opted.stop, null);
  const mixed = dumpOverlay(binary, { kind: 'runtime', exemptSystemOverlay: true, windows: [banner, { pid: 734, id: 35, layer: 0, executable: path }] });
  assert.deepEqual(mixed.overlayIDs, [34]);
  assert.equal(mixed.foreign, true);
  const spoof = dumpOverlay(binary, { kind: 'vm', exemptSystemOverlay: true, windows: [{ pid: 9, id: 90, layer: 21, executable: '/tmp/NotificationCenter' }] });
  assert.deepEqual(spoof.overlayIDs, []);
  assert.equal(spoof.foreign, true);
  const renderer = dumpOverlay(binary, { kind: 'renderer', exemptSystemOverlay: true, windows: [banner] });
  assert.equal(renderer.exempt, false);
  assert.equal(renderer.foreign, true);
  const text = dumpOverlay(binary, { kind: 'vm', exemptSystemOverlay: 'true', windows: [banner] });
  assert.equal(text.exempt, false);
  assert.equal(text.foreign, true);
  const brokenBank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-overlay-default-on-')));
  t.after(() => rmSync(brokenBank, { recursive: true, force: true }));
  const needle = 'kind != "renderer" && (requested as? Bool) == true';
  assert.ok(source.includes(needle));
  const broken = compileGuard(source.replace(needle, 'true'), brokenBank);
  const widened = dumpOverlay(broken, { kind: 'vm', windows: [banner] });
  assert.throws(() => assert.equal(widened.foreign, true), assert.AssertionError);
});

function resumeGuard(startGuard, later) {
  let n = 0;
  return startGuard('unused', { kind: 'runtime', resetCounts: { engine: 0 }, childFactory: (_tool, _args, hooks) => ({
    async call(row) {
      if (row.op === 'input-readiness') return { schema: 'sleight.input-readiness/1', qualification: false, drawing: false,
        ready: true, error: null, grants: { quartzListen: 'granted', hidListen: 'granted' },
        idleMs: { quartzHID: 1, quartzSession: 1, ioHIDSystem: 1 },
        permissionRequests: 0, tapOpens: 0, deviceOpens: 0, actionCalls: 0 };
      if (row.op === 'arm') hooks.onRecord({ record: 'guard', stop: null, hidIdleMs: 4000, systemOverlayActive: false, identityField: null });
      if (row.op === 'check') {
        n += 1;
        const body = n < 3 ? { systemOverlayActive: n === 1, hidIdleMs: 4000, stop: null, identityField: null } : later;
        hooks.onRecord({ record: 'guard', ...body });
      }
      return { reply: row.op, ok: true, tailMs: 0 };
    },
    async close() {},
  }) });
}
async function proveResume(startGuard, later, expected) {
  const guard = resumeGuard(startGuard, later);
  try {
    await guard.start();
    let sent = 0;
    await assert.rejects(guard.engineWindow(async () => { sent += 1; }, 'engine', 'engine'), expected);
    assert.equal(sent, 0);
  } finally { await guard.close(); }
}
test('production resume preflight repeats identity, cover and idle, and a missing preflight fails', async () => {
  const clean = { systemOverlayActive: false, hidIdleMs: 4000, stop: null, identityField: null };
  const guard = resumeGuard(processGuard.startGuard, clean);
  try {
    await guard.start();
    let sent = 0;
    assert.equal(await guard.engineWindow(async () => { sent += 1; return 7; }, 'engine', 'engine'), 7);
    assert.equal(sent, 1);
  } finally { await guard.close(); }
  await proveResume(processGuard.startGuard, { ...clean, identityField: 'WINDOW_ID' }, /IDENTITY_CHANGED/);
  await proveResume(processGuard.startGuard, { ...clean, hidIdleMs: Number.NaN }, /PERSON_ACTIVE/);
  await proveResume(processGuard.startGuard, { ...clean, stop: 'UTM_NOT_UNCOVERED' }, /UTM_NOT_UNCOVERED/);
  const source = readFileSync(new URL('../bench/sitting-process.mjs', import.meta.url), 'utf8');
  const call = 'await this.beforeInput(async () => resumeAfterOverlay(await this.check()));';
  assert.ok(source.includes(call));
  for (const after of ['await this.beforeInput();', 'await this.beforeInput(async () => {});']) {
    const broken = await import('data:text/javascript;base64,' + Buffer.from(source.replace(call, after)).toString('base64'));
    await assert.rejects(proveResume(broken.startGuard, { ...clean, identityField: 'WINDOW_ID' }, /IDENTITY_CHANGED/), assert.AssertionError);
  }
  const sitting = readFileSync(new URL('../bench/windows/uc3f-sitting.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(sitting, /guard\.beforeInput|resumeAfterOverlay|startGuard/);
});
