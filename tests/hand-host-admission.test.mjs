import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { macCommandSkip } from './requirements.mjs';

const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-host-admission-'))));
after(() => rmSync(root, { recursive: true, force: true }));
const entry = { sheet: 'sheet', row: 0, frames: [0, 1], ms: [200, 200], loop: true, flip: false,
  hotspot: [96, 104], size: [1536, 208], scale: 0.5 };
const states = ['perch', 'perch-peek', 'perch-hop', 'perch-point-left', 'perch-point-right', 'sleep', 'high-five', 'perch-wait',
  'startle', 'jumping', 'running-right', 'running-left', 'error', 'handoff', 'paused'];
const character = { hand: 'character', nonce: 'a'.repeat(64), seq: 1, id: 'fixture', sheet: join(root, 'sheet.png'), extra: null,
  cell: [192, 208], table: { idle: { ...entry, frames: 2 } },
  perch: { anchor: [96, 150], table: Object.fromEntries(states.map(state => [state, entry])) }, size: 'stage' };
let binary;
function host() {
  if (process.env.CHRET4_HOST_BINARY) return process.env.CHRET4_HOST_BINARY;
  if (binary) return binary;
  const original = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url);
  let source = readFileSync(original, 'utf8');
  const variant = process.env.CHRET4_GATE_VARIANT;
  if (variant === 'omit-paused-admission-trace') {
    const changed = source.replace('beginTrace("admission"', 'beginTrace("observe"');
    assert.notEqual(changed, source, 'production trace mutation site'); source = changed;
  } else if (variant?.startsWith('reader-')) {
    const start = source.indexOf('                if line.count <= 65536, let data = try? JSONSerialization.jsonObject(with: line) as? [String: Any], data["hand"] as? String == "stage-geometry"');
    const end = source.indexOf('                guard line.count <= 65536', start);
    assert.ok(start >= 0 && end > start);
    const body = source.slice(start, end);
    const changed = variant === 'reader-wrong-nonce' ? body.replace('nonceBook.admit("hand", nonce)', 'true') :
      variant === 'reader-old-sequence' ? body.replace('handSequenceFresh(seq, after: last)', 'true') :
      variant === 'reader-oversized' ? body.replace('line.count <= 65536', 'line.count <= 131072') : body;
    assert.notEqual(body, changed, 'production geometry reader mutation site'); source = source.slice(0, start) + changed + source.slice(end);
  } else if (variant === 'unloaded-character') {
    source = source.replace('host.perch.stage.load(frame); host.perch.stage.stageArt = true', 'host.perch.stage.load(nil); host.perch.stage.stageArt = true');
  } else if (variant === 'unknown-geometry-unlatched') {
    const changed = source.replace('} else if !turnEnd { invalidateGeometry(key) }', '} else if !turnEnd { /* lost unknown geometry */ }');
    assert.notEqual(source, changed); source = changed;
  } else if (variant?.startsWith('drop-held-')) {
    const method = { 'drop-held-act': 'receiveAct', 'drop-held-ring': 'ringFrame', 'drop-held-cursor': 'receiveCursor' }[variant];
    assert.ok(method);
    const start = source.indexOf(`    func ${method}(`), end = source.indexOf('\n    func ', start + 10);
    const body = source.slice(start, end), changed = body.replace(/if badgeDrag.active \|\| captureHeld \{ admitPausedStage\([^;]+; return \}/, 'if badgeDrag.active || captureHeld { return }');
    assert.notEqual(body, changed, 'held production admission site'); source = source.slice(0, start) + changed + source.slice(end);
  } else if (['paused-status-skipped', 'paused-aim-hide-skipped'].includes(variant)) {
    const start = source.indexOf('    func receiveCursor(_ event: RingEvent) {'), end = source.indexOf('\n    // Drag art', start);
    const body = source.slice(start, end), site = variant === 'paused-status-skipped' ? '        pauseVisibility.status(event.state)\n' : '        if event.state == "aim" { pauseOverlay.hide() }\n';
    assert.ok(body.includes(site)); source = source.slice(0, start) + body.replace(site, '') + source.slice(end);
  } else if (variant) {
    const method = { 'drop-receive-act': 'receiveAct', 'drop-ring-frame': 'ringFrame', 'drop-receive-cursor': 'receiveCursor' }[variant];
    assert.ok(method, 'known gate variant');
    const start = source.indexOf(`    func ${method}(`), end = source.indexOf('\n    func ', start + 10);
    const body = source.slice(start, end), changed = body.replace('admitPausedStage(', 'discardPausedStage(');
    assert.notEqual(body, changed, 'production gate mutation site');
    source = source.slice(0, start) + changed + source.slice(end);
    source = source.replace('    func admitPausedStage(', '    func discardPausedStage(_ event: RingEvent) {}\n    func admitPausedStage(');
  }
  const input = join(root, 'host.swift'); writeFileSync(input, source);
  binary = join(root, 'host');
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), input, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr);
  return binary;
}
for (const gate of ['act', 'ring', 'cursor']) test(`paused ${gate} entry admits geometry without drawing and retains it after resume`, { skip: macCommandSkip('xcrun') }, () => {
  const result = spawnSync(host(), ['--pause-control-dump'], { input: JSON.stringify({ character, stageAdmissionCheck: gate }) + '\n',
    encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr);
  const row = JSON.parse(result.stdout);
  assert.equal(row.fixtureLoaded, true); assert.equal(row.shownBeforeHold, true, 'fixture must be able to draw before the hold');
  assert.equal(row.admitted, true, `${gate}: paused host gate lost target`);
  assert.equal(row.afterResume, true, `${gate}: resumed host lost target`);
  assert.equal(row.shown, false, `${gate}: admission must draw nothing`);
  assert.equal(row.windows, 0); assert.equal(row.layers, 0);
});

test('paused production admission journals an exact replayable target transaction', { skip: macCommandSkip('xcrun') }, async () => {
  const result = spawnSync(host(), ['--pause-control-dump'], { input: JSON.stringify({ stageAdmissionCheck: 'act', trace: true }) + '\n',
    encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr);
  const captured = JSON.parse(result.stdout).trace;
  assert.equal(captured.records[0].input.op, 'admission', 'paused admission must be recorded before hiding');
  const input = [{ dumpTrace: true }, ...captured.records.map(row => ({ dumpTransaction: row.input })), { dumpTraceRead: true }];
  const replay = spawnSync(host(), ['--stage-dump'], { input: input.map(JSON.stringify).join('\n') + '\n',
    encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  assertChildStatus(replay, 0, replay.stderr);
  const actual = replay.stdout.trim().split('\n').map(JSON.parse).find(r => r.effect === 'stage-trace');
  const { compareStageReplay } = await import('../bench/hand/stage-trace.mjs');
  assert.deepEqual(compareStageReplay(captured, actual).mismatches, [], 'paused host target trace did not reproduce');
});


test('paused cursor terminals reset cleared visibility and aim hides the pause overlay', { skip: macCommandSkip('xcrun') }, () => {
  for (const state of ['done', 'error', 'aim']) {
    const result = spawnSync(host(), ['--pause-control-dump'], { input: JSON.stringify({ character, stageAdmissionCheck: 'cursor', state }) + '\n',
      encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
    assertChildStatus(result, 0, result.stderr);
    const row = JSON.parse(result.stdout);
    assert.equal(row.cleared, state === 'aim', 'paused terminal must reset cleared visibility');
    if (state === 'aim') assert.ok(row.pauseOverlayHides > 0, 'paused aim must hide the pause overlay');
    assert.equal(row.windows, 0); assert.equal(row.layers, 0);
  }
});


for (const hold of ['drag', 'capture']) for (const gate of ['act', 'ring', 'cursor'])
  test(`${hold} ${gate} entry protects targets until resume`, { skip: macCommandSkip('xcrun') }, () => {
    const result = spawnSync(host(), ['--pause-control-dump'], { input: JSON.stringify({ character, stageAdmissionCheck: gate, hold }) + '\n',
      encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
    assertChildStatus(result, 0, result.stderr);
    const row = JSON.parse(result.stdout);
    assert.equal(row.heldAtAdmission, true, 'fixture must exercise the active hold');
    assert.equal(row.admitted, true, `${hold} ${gate}: held host lost target`);
    assert.equal(row.afterResume, true); assert.equal(row.windows, 0); assert.equal(row.layers, 0);
  });


for (const gate of ['act', 'ring', 'cursor']) test(`unknown ${gate} geometry keeps wide protection and a clear edge seat after resume`, { skip: macCommandSkip('xcrun') }, () => {
  const result = spawnSync(host(), ['--pause-control-dump'], { input: JSON.stringify({ character, stageAdmissionCheck: gate, unknownGeometry: true }) + '\n',
    encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr);
  const row = JSON.parse(result.stdout);
  assert.equal(row.fixtureLoaded, true); assert.equal(row.shownBeforeHold, true);
  assert.equal(row.targetUnmapped, true, 'unknown geometry must latch protection');
  assert.equal(row.admitted, true); assert.equal(row.afterResume, true, 'the original target remains protected after resume');
  assert.equal(row.shownAfterResume, true, 'uncertain geometry can use a clear edge seat');
  assert.equal(row.windows, 0); assert.equal(row.layers, 0);
});


for (const bad of ['valid', 'wrong-nonce', 'old-sequence', 'oversized']) test(`production geometry reader ${bad} respects the hand-channel fault boundary`, { skip: macCommandSkip('xcrun') }, () => {
  const nonce = 'a'.repeat(64);
  const aim = { hand: 'aim', nonce, seq: 1, kind: 'click', pid: 42, windowId: 7, at: [650, 700] };
  const frame = { hand: 'stage-geometry', nonce, seq: 2, geometry: { pid: 42, windowId: 7, incarnation: 'b'.repeat(32),
    observation: 1, contentGeneration: 0, after: -1, mode: 'baseline', bounds: [200, 500, 900, 350], references: [] } };
  if (bad === 'wrong-nonce') frame.nonce = 'c'.repeat(64);
  if (bad === 'old-sequence') frame.seq = 1;
  if (bad === 'oversized') {
    frame.geometry.mode = 'scroll'; frame.geometry.after = 1;
    while (Buffer.byteLength(JSON.stringify(frame)) <= 65536)
      frame.geometry.references.push({ seq: frame.geometry.references.length + 1,
        rects: Array.from({ length: 4 }, () => [1.123456789, 2.123456789, 3.123456789, 4.123456789]), departed: false });
    assert.ok(frame.geometry.references.length <= 512); assert.ok(Buffer.byteLength(JSON.stringify(frame)) < 131072);
  }
  const result = spawnSync(host(), ['--channels-selftest', '--hand', '--cursor-style=ring'], {
    input: [aim, frame].map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  assertChildStatus(result, bad === 'valid' ? 0 : 65, `geometry reader ${bad} must enforce the channel boundary`);
});

function mutationCounts(stdout) {
  return Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key =>
    [key, Number(new RegExp('#\\s+' + key + '\\s+(\\d+)').exec(stdout)?.[1])]));
}
test('drag and capture admission mutations fail in the same run', { skip: !!process.env.CHRET4_GATE_VARIANT || macCommandSkip('xcrun'), timeout: 900000 }, () => {
  const file = fileURLToPath(import.meta.url);
  const original = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  let source = original;
  for (const method of ['receiveAct', 'ringFrame', 'receiveCursor']) {
    const start = source.indexOf(`    func ${method}(`), end = source.indexOf('\n    func ', start + 10);
    assert.ok(start >= 0 && end > start, method);
    const body = source.slice(start, end);
    const changed = body.replace(/if badgeDrag.active \|\| captureHeld \{ admitPausedStage\([^;]+; return \}/, 'if badgeDrag.active || captureHeld { return }');
    assert.notEqual(body, changed, 'held production admission site ' + method);
    source = source.slice(0, start) + changed + source.slice(end);
  }
  const input = join(root, 'mutant-host.swift'), mutant = join(root, 'mutant-host');
  writeFileSync(input, source);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), input, '-o', mutant],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr);
  for (const gate of ['act', 'ring', 'cursor']) {
    const env = { ...process.env, CHRET4_GATE_VARIANT: 'drop-held-' + gate, CHRET4_HOST_BINARY: mutant };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', '--test-timeout=900000',
      '--test-name-pattern=^(drag|capture) ' + gate + ' entry protects targets until resume$', file], {
      encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024, timeout: 900000, killSignal: 'SIGKILL' });
    assert.equal(r.status, 1, gate + '\n' + r.stderr.slice(-4000) + r.stdout.slice(-4000));
    assert.match(r.stdout, /held host lost target/);
    assert.doesNotMatch(r.stdout + r.stderr, /error: (?:cannot|expected|consecutive|value|type)|child: (?:ETIMEDOUT|SIGKILL)|host exit/, gate + ': host failure is not detection');
    const counts = mutationCounts(r.stdout);
    assert.equal(counts.tests, 2, gate); assert.equal(counts.fail, 2, gate); assert.equal(counts.pass, 0, gate);
  }
});
