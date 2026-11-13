import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { macCommandSkip } from './requirements.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { prepareStageCharacter } from '../bench/hand/stage-live.mjs';
import { checkBuiltinCharacter, installCharacter, loadCharacter, resolveCharacterStates } from '../plugins/sleight/lib/hand/character.mjs';
import { characterFrame } from '../plugins/sleight/lib/hand/character-frame.mjs';

const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
function region(name) {
  const start = source.indexOf('// BEGIN ' + name + '\n'), end = source.indexOf('// END ' + name + '\n', start);
  assert.ok(start >= 0 && end > start, 'missing production region: ' + name);
  return source.slice(start, end);
}
function native(t, name, code) {
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-chv7-'))));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, name + '.swift'), binary = join(root, name);
  writeFileSync(input, 'import Foundation\nimport Darwin\nimport AppKit\n' + code);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-O', '-module-cache-path', swiftModuleCache(), input, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr);
  const ran = spawnSync(binary, [], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  assertChildStatus(ran, 0, ran.stderr);
  return JSON.parse(ran.stdout);
}

test('CHV7 decode reap uses a one-shot exit event with a half-second deadline and forced collection', {
  skip: macCommandSkip('xcrun'), timeout: 900000,
}, t => {
  let reap = region('SPRITE REAP');
  assert.doesNotMatch(reap, /usleep|Thread\.sleep/);
  if (process.env.CHV7_REAP_BROKEN) {
    const site = 'let ready = kevent(event.queue, nil, 0, &notification, 1, &timeout)';
    assert.equal(reap.split(site).length, 2, 'exit-event mutation site');
    reap = reap.replace(site, 'let ready: Int32 = 0');
  }
  const rows = native(t, 'reap', reap + `
    func trial(_ delay: String) -> [String: Any] {
        var pid: pid_t = 0
        let argv = ["/bin/sleep", delay].map { strdup($0) } + [nil]
        defer { argv.forEach { free($0) } }
        var attributes: posix_spawnattr_t? = nil
        posix_spawnattr_init(&attributes); defer { posix_spawnattr_destroy(&attributes) }
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_START_SUSPENDED))
        precondition(posix_spawn(&pid, "/bin/sleep", nil, &attributes, argv, environ) == 0)
        let event = SpriteExitEvent(pid); precondition(event.registered)
        precondition(kill(pid, SIGCONT) == 0)
        let start = ProcessInfo.processInfo.systemUptime
        let result = spriteReap(pid, wait: true, event: event)
        var status: Int32 = 0
        let collected = waitpid(pid, &status, WNOHANG)
        return ["reaped": result.reaped, "status": result.status,
            "ms": (ProcessInfo.processInfo.systemUptime - start) * 1000, "collected": collected, "errno": errno]
    }
    let rows = [trial("0"), trial("0.023"), trial("5")]
    print(String(data: try! JSONSerialization.data(withJSONObject: rows), encoding: .utf8)!)
  `);
  for (const row of rows) assert.equal(row.collected, -1, 'no zombie remains');
  assert.equal(rows[0].reaped, true); assert.equal(rows[1].reaped, true);
  assert.equal(rows[0].status, 0); assert.equal(rows[1].status, 0);
  assert.equal(rows[2].reaped, false); assert.ok(rows[2].ms >= 450 && rows[2].ms < 2000);
  t.diagnostic('reap timings ms ' + JSON.stringify(rows.map(r => r.ms)));
});

test('CHV7 actual decode parent does not sleep in ten-millisecond reap polls after EOF', {
  skip: macCommandSkip('xcrun'), timeout: 900000,
}, t => {
  const parentSource = process.env.CHV7_PARENT_SOURCE ? readFileSync(process.env.CHV7_PARENT_SOURCE, 'utf8') : source;
  const start = parentSource.indexOf('func spriteDecodeInChild('), end = parentSource.indexOf('// BEGIN BUILTIN CHARACTER HASHES', start);
  assert.ok(start >= 0 && end > start);
  const eventStart = parentSource.indexOf('// BEGIN SPRITE REAP\n'), eventEnd = parentSource.indexOf('// END SPRITE REAP\n', eventStart);
  const event = eventStart < 0 ? '' : parentSource.slice(eventStart, eventEnd);
  const parent = parentSource.slice(start, end).replaceAll('usleep(', 'chv7Sleep(');
  const measured = parentSource.includes('telemetry: SpriteDecodeTelemetry?') ? ', telemetry: SpriteDecodeTelemetry()' : '';
  const row = native(t, 'parent', `
    enum SpriteLoadError: Error { case child, cancelled, timeout, type, size, alpha, decode, sandbox }
    var tracked = false, telemetrySawTrackedPID = false
    final class SpriteDecodeTelemetry {
        func record(_ key: String, since start: Double) {
            if key == "reapMs" && tracked { telemetrySawTrackedPID = true }
        }
    }
    func spriteTrack(_ pid: pid_t) -> Bool { tracked = true; return true }
    func spriteUntrack(_ pid: pid_t) { tracked = false }
    var pollSleeps = 0
    func chv7Sleep(_ amount: useconds_t) -> Int32 {
        if amount == 10_000 { pollSleeps += 1 }; return Darwin.usleep(amount)
    }
    ${event}
    ${parent}
    if CommandLine.arguments.dropFirst().first == "--decode-sheet" {
        let count = Int(CommandLine.arguments[2])! * Int(CommandLine.arguments[3])! * 4
        let pixels = calloc(count, 1)!
        var sent = 0
        while sent < count { let n = write(1, pixels + sent, count - sent); if n > 0 { sent += n } }
        close(1); Darwin.usleep(23_000); exit(0)
    }
    let fd = open("/dev/null", O_RDONLY)
    let start = ProcessInfo.processInfo.systemUptime
    let buffer = try! spriteDecodeInChild(fd: fd, width: 64, height: 64, format: "png"${measured})
    close(fd); free(buffer)
    print(String(data: try! JSONSerialization.data(withJSONObject: ["pollSleeps": pollSleeps, "tracked": tracked,
        "telemetrySawTrackedPID": telemetrySawTrackedPID,
        "ms": (ProcessInfo.processInfo.systemUptime - start) * 1000]), encoding: .utf8)!)
  `);
  assert.equal(row.pollSleeps, 0, 'EOF-to-exit uses the event instead of 10 ms sleeps');
  assert.equal(row.tracked, false, 'the collected PID is removed from cleanup ownership');
  assert.equal(row.telemetrySawTrackedPID, false, 'release the collected PID before telemetry allocation');
  t.diagnostic(JSON.stringify(row));
});

test('CHV7 tracks the suspended child before arming its exit observer', () => {
  const parent = source.slice(source.indexOf('func spriteDecodeInChild('), source.indexOf('// BEGIN BUILTIN CHARACTER HASHES'));
  assert.ok(parent.indexOf('spriteTrack(pid)') < parent.indexOf('let exitEvent = SpriteExitEvent(pid)'),
    'exit handlers must own the suspended child before the observer is allocated');
});

test('CHV7 legacy physical crop preserves the existing AppKit rounding phase', {
  skip: macCommandSkip('xcrun'), timeout: 900000,
}, t => {
  assert.ok(source.includes('func spritePanelRoundingOffset('), 'legacy crop must preserve the original physical point phase');
  const rows = native(t, 'rounding', region('SPRITE DRAWING BOUNDS') + `
    let panels = [CGRect(x: 76.125, y: 733.625, width: 144, height: 192),
        CGRect(x: -24.875, y: 500.125, width: 144.5, height: 192.75),
        CGRect(x: 100, y: 500, width: 192, height: 208)]
    let rows = panels.map { p -> [String: Any] in
        let offset = spritePanelRoundingOffset(p)
        let actual = CGRect(x: floor(p.minX), y: floor(p.minY), width: ceil(p.width), height: ceil(p.height))
        return ["offset": [offset.x, offset.y], "actual": [actual.minX, actual.minY, actual.width, actual.height],
            "sameX": p.minX + offset.x == actual.minX,
            "sameTop": 982 - p.maxY + offset.y == 982 - actual.maxY]
    }
    print(String(data: try! JSONSerialization.data(withJSONObject: rows), encoding: .utf8)!)
  `);
  for (const row of rows) { assert.equal(row.sameX, true); assert.equal(row.sameTop, true); }
  assert.deepEqual(rows[0].offset, [-0.125, 0.625]);
  assert.deepEqual(rows[2].offset, [0, 0]);
  const install = source.slice(source.indexOf('    func install(_ plan: PerchPlan'), source.indexOf('    func fadeOut(_ duration:', source.indexOf('    func install(_ plan: PerchPlan')));
  assert.match(install, /spritePanelRoundingOffset\(appKitRect\(logicalPanel\)\)/);
  assert.match(install, /p\.x \+ drawingOffset\.x - target\.minX/);
  assert.match(install, /p\.y \+ drawingOffset\.y - target\.minY/);
});

test('CHV7 drawing surface uses decoded alpha bounds while logical clearance stays full size', () => {
  assert.ok(source.includes('spriteDrawingBounds('), 'physical crop is installed');
  const install = source.slice(source.indexOf('    func install(_ plan: PerchPlan'), source.indexOf('    func fadeOut(_ duration:', source.indexOf('    func install(_ plan: PerchPlan')));
  assert.match(install, /spritePanelGeometry\(/);
  assert.match(install, /stagePanelBounds\(plan, metrics\)/);
  assert.match(source, /clear\(stagePanelBounds\(pose, metrics\), next.world, pointer: 40\)/);
  assert.match(source, /clear\(stagePanelBounds\(previous.pose, previous.metrics\), world, pointer: 40\)/);
});

test('CHV7 stage decode telemetry keeps the total and all component durations', () => {
  for (const key of ['validationMs', 'spawnMs', 'transferMs', 'reapMs', 'scanMs', 'imageMs', 'otherMs'])
    assert.ok(source.includes('"' + key + '"'), key);
  assert.match(source, /decodeSpans\.append\(.*merging/s);
});

test('CHV7 every bench and shipped frame keeps identical native pixels in a cropped physical surface', {
  skip: macCommandSkip('xcrun'), timeout: 900000,
}, t => {
  const root = registerTemp(t, realpathSync(mkdtempSync(join('/private', 'tmp', 'sleight-chv7-pixels-'))));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = join(root, 'main.swift'), binary = join(root, 'host');
  const seam = 'let arguments = Array(CommandLine.arguments.dropFirst(channelValidationOnly ? 2 : 1))';
  const harness = readFileSync(new URL('./fixtures/chv7-pixels.swift', import.meta.url), 'utf8');
  assert.equal(source.split(seam).length, 2);
  let text = source.replace(seam, seam + '\n' + harness);
  if (process.env.CHV7_CROP_BROKEN) {
    const site = 'let cropped = extent.integral.intersection(clip)';
    const replacement = process.env.CHV7_CROP_BROKEN === 'no-crop' ? 'let cropped = clip' :
      'let cropped = extent.integral.insetBy(dx: 40, dy: 40).intersection(clip)';
    assert.equal(text.split(site).length, 2, 'physical crop mutation site');
    text = text.replace(site, replacement);
  }
  writeFileSync(input, text);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-O', '-module-cache-path', swiftModuleCache(), input, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr);
  const bench = prepareStageCharacter(root, process.env.CHV7_BENCH_PACK);
  const shipped = checkBuiltinCharacter('mabel'), files = new Map(shipped.files);
  files.set('character.json', Buffer.from(JSON.stringify({ ...shipped.manifest, id: 'chv7-mabel' })));
  const folder = installCharacter({ files }, { root }), pack = loadCharacter(folder);
  const frame = characterFrame(pack, { nonce: 'a'.repeat(64), seq: 0, resolve: resolveCharacterStates });
  const results = [];
  for (const [name, request, bank] of [['bench', bench.frame, bench.root], ['mabel', frame, root]]) {
    const ran = spawnSync(binary, ['--chv7-pixels'], { input: JSON.stringify({ name, frame: request }) + '\n',
      encoding: 'utf8', timeout: 240000, maxBuffer: 8 << 20, killSignal: 'SIGKILL',
      env: { ...process.env, SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: bank } });
    assertChildStatus(ran, 0, ran.stderr || ran.stdout);
    const row = JSON.parse(ran.stdout); results.push(row);
    assert.ok(row.comparisons > 100); assert.equal(row.changed, 0, name + ' native pixel differences: ' + JSON.stringify(row.differences));
    assert.ok(row.visiblePixels > 0); assert.ok(row.areas.some(a => a.reductionPct > 10));
    for (const area of row.areas.filter(a => Object.keys(a.telemetry).length)) {
      for (const key of ['validationMs', 'spawnMs', 'transferMs', 'reapMs', 'scanMs', 'imageMs'])
        assert.ok(Number.isFinite(area.telemetry[key]) && area.telemetry[key] >= 0, key);
    }
    t.diagnostic(JSON.stringify(row));
  }
  const cache = spawnSync(binary, ['--stage-cache-dump'], {
    input: [{ ...bench.frame, size: 'stage' }, { stageState: 'stage-think' }, { stageAwait: true }, { stageState: 'stage-think' }]
      .map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 30000, maxBuffer: 1 << 20, killSignal: 'SIGKILL',
    env: { ...process.env, SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: bench.root },
  });
  assertChildStatus(cache, 0, cache.stderr);
  const spans = JSON.parse(cache.stdout.trim().split('\n').at(-1)).decodeSpans;
  assert.ok(spans.length > 0);
  for (const span of spans) {
    const parts = ['validationMs', 'spawnMs', 'transferMs', 'reapMs', 'scanMs', 'imageMs', 'otherMs'].map(key => span[key]);
    assert.ok(parts.every(part => Number.isFinite(part) && part >= 0));
    assert.ok(Math.abs(parts.reduce((a, b) => a + b, 0) - span.decodeMs) < 0.001, 'components account for the whole decode');
  }
  t.diagnostic('production cache spans ' + JSON.stringify(spans));
  if (process.env.CHV7_PIXEL_RESULTS) writeFileSync(process.env.CHV7_PIXEL_RESULTS, JSON.stringify(results, null, 2) + '\n');
});
