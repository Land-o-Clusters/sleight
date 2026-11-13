import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { awaitEngineIdle } from '../bench/runtime-evidence.mjs';

// Every child has a hard timeout and SIGKILL, including the compiler. All host
// modes below return before NSApplication startup and create zero windows.
const boundedSpawn = (command, args, options = {}) => spawnSync(command, args, {
  encoding: 'utf8', timeout: 5000, ...options, killSignal: 'SIGKILL',
});
let binary = process.env.RT13_WITNESS_TEST_BIN;
let compileResult, compileSkip, compileBytes;
if (process.platform !== 'darwin') compileSkip = 'macOS only';
else if (binary) compileSkip = 'operator supplied RT13_WITNESS_TEST_BIN';
else {
  // Query selection first so an unconfigured Mac never invokes a tool shim
  // that could offer to install developer tools.
  const selected = boundedSpawn('/usr/bin/xcode-select', ['-p']);
  const unavailable = result => result.error?.code === 'ENOENT' ||
    (result.status !== 0 && !result.error && !result.signal);
  const find = unavailable(selected) ? selected : (() => {
    assert.equal(selected.status, 0, selected.stderr || String(selected.error));
    return boundedSpawn('/usr/bin/xcrun', ['--find', 'swiftc']);
  })();
  if (unavailable(find)) compileSkip = 'swiftc unavailable';
  else {
    assert.equal(find.status, 0, find.stderr || String(find.error));
    const compiler = find.stdout.trim();
    if (!existsSync(compiler)) compileSkip = 'swiftc unavailable';
    else {
      const bank = mkdtempSync(join(tmpdir(), 'rt25b-host-'));
      after(() => rmSync(bank, { recursive: true, force: true }));
      const output = join(bank, 'runtime-probe-host');
      compileResult = boundedSpawn('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'module-cache'),
        fileURLToPath(new URL('../bench/runtime-probe-host.swift', import.meta.url)), '-o', output], { timeout: 120000 });
      if (compileResult.status === 0) { binary = output; compileBytes = statSync(output).size; }
    }
  }
}
test('macOS compiles the probe witness for non-drawing host tests without an external binary', { skip: compileSkip, timeout: 125000 }, t => {
  assert.equal(compileResult.status, 0, compileResult.stderr || String(compileResult.error));
  assert.equal(compileResult.signal, null);
  t.diagnostic(`compiled witness: ${compileBytes} bytes`);
});
const options = { skip: !binary };
const call = (mode, input) => boundedSpawn(binary, [mode], { input });

// These are synthetic receiving-side records, not evidence from a live sitting.
// Losing a source field, changing event order or rounding timestamps breaks replay.
const receivedEvent = {
  record: 'event', type: 10, subtype: null, timestamp: 123.456789, receivedAt: 123.457,
  flags: 1048576, keyCode: 1, keyboardType: 40, sourceStateID: -1, sourceUnixProcessID: 321,
  clickState: 0, field91: 17, field92: 23, windowNumber: 7, location: [120.5, 80.25],
  deltaX: null, deltaY: null, phase: null, momentumPhase: null, precise: null,
};
const recording = [
  { ...receivedEvent, type: 13, subtype: 1, keyCode: null },
  { record: 'state', timestamp: 123.46, isActive: true, keyWindow: 7, frontmostPID: 999, hidIdleMs: 18000, secureInput: false, secureInputPID: null, secureFieldFocused: false },
  receivedEvent,
  { record: 'callback', timestamp: 123.461, name: 'performKeyEquivalent', target: 'menu', details: { handled: true } },
  { record: 'callback', timestamp: 123.462, name: 'save', target: 'save', details: { count: 1 } },
  { ...receivedEvent, type: 11, timestamp: 123.47 },
  { ...receivedEvent, type: 1, keyCode: null, clickState: 2, flags: 0 },
  { ...receivedEvent, type: 2, keyCode: null, clickState: 2, flags: 0 },
  { ...receivedEvent, type: 22, keyCode: null, deltaX: 0, deltaY: -12.5, phase: 2, momentumPhase: 0, precise: true },
  { record: 'callback', timestamp: 123.48, name: 'scroll', target: 'scroll', details: { x: 0, y: 300, pageHeight: 240 } },
  { ...receivedEvent, type: 6, keyCode: null },
  { record: 'callback', timestamp: 123.49, name: 'drop', target: 'drop-target', details: { accepted: true, item: 'RT25-owned-item', x: 40, y: 50 } },
  { record: 'windows', timestamp: 123.5, onScreenWindows: 1 },
  { record: 'state', timestamp: 123.52, isActive: false, keyWindow: null, frontmostPID: null, hidIdleMs: 18060, secureInput: true, secureInputPID: 321, secureFieldFocused: true },
  { ...receivedEvent, type: 12, keyCode: 55, keyboardType: null, sourceStateID: null, sourceUnixProcessID: null, field91: null, field92: null, clickState: null },
  { record: 'windows', timestamp: 123.55, onScreenWindows: null },
];
const jsonLines = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

test('event replay preserves receiving-side fields, nulls and order without AppKit startup', options, () => {
  const result = call('--serve-events', jsonLines(recording));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.stdout.trim().split('\n').map(JSON.parse), recording);
  assert.equal(call('--serve-events', result.stdout).stdout, result.stdout);
});

test('native event extraction reads CG fields and AppKit subtypes without posting or drawing', options, () => {
  const result = call('--selftest-events');
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const rows = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.record === 'event').length, 3,
    'queue then dispatch logs once; queue-only and direct dispatch each log once');
  assert.equal(rows.length, 4);
  const [key, activation, mouse, original] = rows;
  assert.equal(key.type, 10); assert.equal(key.keyCode, 1); assert.equal(key.keyboardType, 40);
  assert.equal(key.timestamp, 123.456789); assert.ok(key.receivedAt > 0);
  assert.ok(Number.isInteger(key.sourceStateID)); assert.equal(key.sourceStateID, original.details.originalKeyStateID);
  assert.equal(key.sourceUnixProcessID, 321); assert.equal(original.details.originalKeyPID, 321);
  // The two window fields apply to mouse events, and read back as zero on keys.
  assert.equal(key.field91, 0); assert.equal(key.field92, 0);
  assert.equal(original.details.originalKey91, 0);
  assert.ok((key.flags & 1048576) !== 0); assert.equal(key.subtype, null);
  assert.equal(activation.type, 13); assert.equal(activation.subtype, 1);
  assert.equal(mouse.type, 1); assert.equal(mouse.subtype, 0); assert.equal(mouse.clickState, 2);
  assert.equal(mouse.field91, 17); assert.equal(mouse.field92, 23);
  assert.equal(original.details.originalMouse91, 17); assert.equal(original.details.originalMouse92, 23);
  assert.equal(mouse.location[0], 12.5); assert.ok(Number.isFinite(mouse.location[1])); assert.equal(mouse.keyCode, null);
  assert.equal(mouse.deltaX, null); assert.equal(mouse.precise, null);
  assert.equal(call('--serve-events', result.stdout).stdout, result.stdout);
});

test('event replay refuses malformed, incomplete, extra-field and nonnumeric records', options, () => {
  const { field92, ...missing } = receivedEvent;
  for (const row of [missing, { ...receivedEvent, field92: '23' }, { ...receivedEvent, timestamp: -1 },
    { ...receivedEvent, type: true }, { ...receivedEvent, keyCode: 1.5 }, { ...receivedEvent, flags: -1 },
    { ...receivedEvent, location: [1] }, { ...receivedEvent, extra: 1 }, { ...receivedEvent, record: 'post' },
    { ...recording[1], isActive: 1 }, { ...recording[1], hidIdleMs: -1 },
    { ...recording[1], secureInputPID: '321' }, { ...recording[1], secureInputPID: -1 },
    { ...recording[1], secureInputPID: true }, { ...recording[1], secureFieldFocused: 1 },
    { record: 'secureEvent', type: 10, count: 0 },
    { record: 'secureEvent', type: 10, count: 1, keyCode: 1 },
    { ...recording[3], name: 'postEvent' }, { ...recording[3], details: { nested: { text: 'x' } } },
    { ...recording[12], onScreenWindows: -1 }, [], null, 'invalid']) {
    const result = call('--serve-events', jsonLines([row]));
    assert.equal(result.status, 65, JSON.stringify(row));
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.record, 'summary'); assert.equal(summary.status, 65);
    assert.match(result.stderr, /invalid.*log/);
  }
});

test('event replay stops at the first invalid line and rejects oversized input', options, () => {
  const valid = call('--serve-events', jsonLines([receivedEvent])).stdout;
  const mixed = call('--serve-events', jsonLines([receivedEvent]) + 'not JSON\n' + jsonLines([receivedEvent]));
  assert.equal(mixed.status, 65); assert.ok(mixed.stdout.startsWith(valid));
  const final = JSON.parse(mixed.stdout.slice(valid.length));
  assert.equal(final.record, 'summary'); assert.equal(final.eventCount, 1);
  const huge = call('--serve-events', ' '.repeat(65537) + '\n');
  assert.equal(huge.status, 65); assert.equal(JSON.parse(huge.stdout).record, 'summary');
  assert.match(huge.stderr, /65536/);
  assert.equal(call('--serve-events', '').status, 0);
});

test('event replay streams across read boundaries and accepts an unterminated final record', options, () => {
  const rows = Array.from({ length: 300 }, (_, index) => ({ ...receivedEvent, timestamp: 200 + index / 1000 }));
  const input = jsonLines(rows).trimEnd();
  assert.ok(input.length > 65536);
  const result = call('--serve-events', input);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').map(JSON.parse), rows);
});

test('fixture dry run describes the shared layout and sample periods without drawing', options, () => {
  const result = call('--dry-run');
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const layout = JSON.parse(result.stdout);
  assert.equal(layout.schema, 'sleight.runtime-probe-fixture/1');
  assert.equal(layout.windowsCreated, 0); assert.equal(layout.inputGenerated, false);
  assert.deepEqual(layout.sampling, { stateMs: 20, windowsMs: 50 });
  assert.deepEqual(layout.windowSize, [640, 560]);
  assert.deepEqual(layout.lifetime, { defaultMaxSeconds: 1800, maximumMaxSeconds: 1800, quitKeyEquivalent: 'q' });
  assert.equal(layout.secureFocusOperation, 'focus-secure');
  assert.deepEqual(layout.save, { title: 'Save', keyEquivalent: 's', modifiers: ['command'], logs: 'performKeyEquivalent' });
  assert.deepEqual(layout.controls.map(row => [row.id, row.kind]), [
    ['probe-button', 'button'], ['plain', 'text-field'], ['secure', 'secure-text-field'],
    ['scroll', 'scroll-view'], ['drag-item', 'draggable'], ['drop-target', 'drop-target'],
  ]);
  const scroll = layout.controls.find(row => row.id === 'scroll');
  assert.equal(scroll.pageHeight, 240); assert.equal(scroll.documentHeight, 2400);
  for (const control of layout.controls) {
    assert.equal(control.frame.length, 4);
    assert.ok(control.frame[0] + control.frame[2] <= 640);
    assert.ok(control.frame[1] + control.frame[3] <= 560);
  }
});

test('fixture drag geometry converts view centers to full-window top-left points without drawing', options, () => {
  const result = call('--dump-drag-geometry');
  assert.equal(result.status, 0, result.stderr);
  const geometry = JSON.parse(result.stdout);
  assert.deepEqual(geometry, { dragWidth: 640, dragHeight: 582, dragFromX: 110, dragFromY: 487, dragToX: 470, dragToY: 487 });
  const replay = call('--serve-events', JSON.stringify({ record: 'callback', timestamp: 1, name: 'deliveryState', target: 'fixture',
    details: { onActiveSpace: true, visible: true, miniaturized: false, fullScreen: false, windowNumber: 1, ...geometry } }) + '\n');
  assert.equal(replay.status, 0, replay.stderr);
});

test('secure responder events retain only counts and types, including key equivalents', options, () => {
  const result = call('--selftest-secure-events');
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const rows = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 4);
  for (const [index, row] of rows.slice(0, 3).entries()) {
    assert.deepEqual(Object.keys(row).sort(), ['record', 'type', 'count'].sort());
    assert.equal(row.record, 'secureEvent'); assert.equal(row.count, index + 1);
  }
  assert.deepEqual(rows.slice(0, 3).map(row => row.type), [10, 13, 1]);
  assert.equal(rows[3].secureEventCount, 3); assert.equal(rows[3].eventCount, 0);
  assert.equal(call('--serve-events', result.stdout).stdout, result.stdout);
});

test('lifecycle self-test releases the activity, resolves holder PIDs and summarizes achieved sampling', options, () => {
  const result = call('--selftest-lifecycle');
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const rows = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2, 'finish is idempotent');
  assert.deepEqual(rows[0].details, { activityHeld: true, activityReleased: true, secureInputPID: 321,
    windowsCreated: 0, inputGenerated: false });
  const summary = rows[1];
  assert.equal(summary.record, 'summary'); assert.equal(summary.reason, 'selftest-lifecycle');
  assert.equal(summary.status, 0); assert.equal(summary.maxSeconds, 1800);
  assert.equal(summary.stateIntervalsMs.count, 5);
  assert.ok(Math.abs(summary.stateIntervalsMs.median - 20) < 1e-6);
  assert.ok(Math.abs(summary.stateIntervalsMs.p95 - 200) < 1e-6);
  assert.ok(Math.abs(summary.stateIntervalsMs.max - 200) < 1e-6);
  assert.equal(summary.windowIntervalsMs.count, 2);
  assert.ok(Math.abs(summary.windowIntervalsMs.median - 50) < 1e-6);
  assert.ok(Math.abs(summary.windowIntervalsMs.p95 - 50) < 1e-6);
  assert.equal(call('--serve-events', result.stdout).stdout, result.stdout);
});

test('deadline exits with one final summary even without harness input', options, () => {
  const result = boundedSpawn(binary, ['--selftest-deadline', '--max-seconds', '0.05']);
  assert.equal(result.status, 0, result.stderr || String(result.error)); assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  const rows = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].record, 'summary'); assert.equal(rows[0].reason, 'max-seconds');
  assert.equal(rows[0].maxSeconds, 0.05); assert.ok(rows[0].elapsedMs >= 40);
  assert.deepEqual(rows[0].stateIntervalsMs, { count: 0, median: null, p95: null, max: null });
});

const pausedOutput = async mode => {
  const child = spawn(binary, [mode], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 6000, killSignal: 'SIGKILL',
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  // Do not attach a data listener until the pause ends: the OS pipe must fill.
  const resume = setTimeout(() => child.stdout.on('data', chunk => { stdout += chunk; }), 1000);
  const [code, signal] = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve([code, signal]));
  }).finally(() => clearTimeout(resume));
  assert.equal(code, 0, stderr); assert.equal(signal, null); assert.equal(stderr, '');
  return stdout;
};

test('a reader paused for one second survives backpressure with complete ordered rows', { ...options, timeout: 10000 }, async () => {
  const stdout = await pausedOutput('--selftest-output-stall');
  const rows = stdout.trim().split('\n').map(JSON.parse), summary = rows.pop();
  assert.equal(rows.length, 10000);
  assert.deepEqual(rows.map(row => row.details.count), Array.from({ length: 10000 }, (_, index) => index));
  assert.equal(summary.record, 'summary'); assert.equal(summary.status, 0);
  assert.equal(summary.stdoutDroppedRows, 0); assert.equal(summary.stdoutDroppedBytes, 0);
});

test('large pending rows survive a paused pipe without duplicated or missing bytes', { ...options, timeout: 10000 }, async () => {
  const stdout = await pausedOutput('--selftest-output-partial');
  const rows = stdout.trim().split('\n').map(JSON.parse), summary = rows.pop();
  assert.deepEqual(rows, Array.from({ length: 16 }, (_, count) => ({ count, padding: 'x'.repeat(60000) })));
  assert.equal(summary.record, 'summary'); assert.equal(summary.status, 0);
  assert.equal(summary.stdoutDroppedRows, 0); assert.equal(summary.stdoutDroppedBytes, 0);
});

test('a reader that stops forever gets a two-second deadline reason and drop counts', { ...options, timeout: 10000 }, async () => {
  const started = performance.now();
  const child = spawn(binary, ['--selftest-output-stall'], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, killSignal: 'SIGKILL',
  });
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  // Keep stdout paused until the child exits, then drain it to collect close.
  child.once('exit', () => child.stdout.resume());
  let exitedAt;
  child.once('exit', () => { exitedAt = performance.now(); });
  const [code, signal] = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve([code, signal]));
  });
  assert.equal(code, 74, stderr); assert.equal(signal, null);
  const lines = stderr.trim().split('\n');
  assert.match(lines[0], /stdout unavailable: write deadline expired after 2000 ms/); assert.equal(lines.length, 2);
  assert.ok(exitedAt - started >= 1900, `exited early after ${exitedAt - started} ms`);
  assert.ok(exitedAt - started < 3500, `exited late after ${exitedAt - started} ms`);
  const summary = JSON.parse(lines[1]);
  assert.equal(summary.record, 'summary'); assert.equal(summary.reason, 'stdout-unavailable'); assert.equal(summary.status, 74);
  assert.equal(summary.stdoutDroppedRows, 1);
  assert.ok(summary.stdoutDroppedBytes > 0 && summary.stdoutDroppedBytes <= 65536);
  assert.equal(call('--serve-events', lines[1]).stdout.trim(), lines[1]);
});

test('stdout caps a pending row at 65536 bytes and reports oversized drops in its summary', options, () => {
  const result = call('--selftest-output-cap');
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const [callback, summary] = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(callback.target, 'selftest-output-cap'); assert.equal(summary.record, 'summary');
  assert.equal(summary.stdoutDroppedRows, 1);
  assert.equal(summary.stdoutDroppedBytes, Buffer.byteLength(JSON.stringify({ padding: 'x'.repeat(65536) }) + '\n'));
  assert.equal(call('--serve-events', result.stdout).stdout, result.stdout);
});

test('usage explains timing exposure and secure-input readiness without activating the witness', options, () => {
  const result = call('--help');
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  assert.match(result.stdout, /type only a dummy value/);
  assert.match(result.stdout, /hidIdleMs every 20 ms/);
  assert.match(result.stdout, /focus-secure does not activate the app/);
  assert.match(result.stdout, /bring the\nwitness to the front first/);
  assert.match(result.stdout, /secureFieldFocused true, secureInput true and secureInputPID equal to the witness pid/);
});

test('invalid deadlines are refused before AppKit or the headless deadline starts', options, () => {
  for (const mode of ['--witness-events', '--selftest-deadline']) {
    for (const args of [['--max-seconds'], ['--max-seconds', '0'], ['--max-seconds', '-1'],
      ['--max-seconds', '1801'], ['--max-seconds', 'nan'], ['--max-seconds', 'inf'],
      ['--max-seconds', '1', '--extra'], ['--other', '1']]) {
      const result = boundedSpawn(binary, [mode, ...args]);
      assert.equal(result.status, 64, JSON.stringify([mode, ...args])); assert.equal(result.stdout, '');
    }
  }
});

test('every shutdown reason uses the common cleanup and emits exactly one final summary without a window', options, () => {
  for (const reason of ['cmd-q', 'window-close', 'stdin-quit', 'stdin-eof', 'parent-exit']) {
    const result = boundedSpawn(binary, ['--selftest-shutdown', reason]);
    assert.equal(result.status, 0, result.stderr || String(result.error)); assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.record, 'summary'); assert.equal(summary.reason, reason); assert.equal(summary.status, 0);
    assert.equal(call('--serve-events', result.stdout).stdout, result.stdout);
  }
});

test('invalid live log number prints a reason and final summary before exit 70', options, () => {
  const result = call('--selftest-invalid-log');
  assert.equal(result.status, 70); assert.equal(result.signal, null);
  assert.match(result.stderr, /invalid log number: deltaX/);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.record, 'summary'); assert.equal(summary.status, 70);
  assert.equal(summary.reason, 'invalid log number: deltaX');
  assert.equal(summary.eventCount, 0);
  assert.equal(call('--serve-events', result.stdout).stdout, result.stdout);
});

test('unknown and mixed modes fail before starting the witness', options, () => {
  for (const args of [[], ['--dry-run', '--witness-events'], ['--serve-events', '--witness-events'], ['--unknown']]) {
    const result = boundedSpawn(binary, args);
    assert.equal(result.status, 64); assert.equal(result.stdout, '');
  }
});
test('native witness checks Finder process age without creating an application or windows', options, () => {
  const result = call('--selftest'); assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { windowsCreated: 0, apps: 6, inputGenerated: false });
  assert.equal(result.stderr, '');
});
test('native stdin validation accepts the closed observation and owned-window protocol', options, () => {
  for (const row of [{ op: 'inventory' }, { op: 'bind', bundle: 'com.apple.TextEdit' }, { op: 'bind', bundle: 'com.apple.finder' }, { op: 'sample', marker: 'RT13-test' },
    { op: 'cover', marker: '' }, { op: 'before-new' }, { op: 'retain-new' }, { op: 'close-new' }, { op: 'uncover' },
    { op: 'image', marker: 'fixture', base64: 'ZmFrZQ==' }]) {
    const result = call('--validate', JSON.stringify(row));
    assert.equal(result.status, 0, JSON.stringify(row)); assert.deepEqual(JSON.parse(result.stdout), { valid: true, windowsCreated: 0 });
  }
});
test('native stdin validation rejects arbitrary apps, input verbs, extra keys and malformed JSON', options, () => {
  for (const row of [{ op: 'bind', bundle: 'com.apple.Terminal' }, { op: 'click', at: [1, 2] }, { op: 'inventory', extra: true },
    { op: 'sample', marker: 'x\nWindow: fake' }, { op: 'image', base64: '', marker: 'x' }, { op: 'cover' }, 'not json']) {
    const result = call('--validate', typeof row === 'string' ? row : JSON.stringify(row));
    assert.equal(result.status, 65); assert.deepEqual(JSON.parse(result.stdout), { valid: false, windowsCreated: 0 });
  }
});

const processBinary = process.env.RT13_PROCESS_TEST_BIN;
test('process witness selftest checks nine classifier cases without reading the process table', { skip: !processBinary }, () => {
  const result = boundedSpawn(processBinary, ['--selftest'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { checks: 9, windowsCreated: 0, inputGenerated: false });
});
test('process witness dumps both classifier rules and their observation sources without an inventory', { skip: !processBinary }, () => {
  const result = boundedSpawn(processBinary, ['--dump-classifiers'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  const dump = JSON.parse(result.stdout);
  assert.equal(dump.windowsCreated, 0); assert.equal(dump.inputGenerated, false); assert.equal(dump.processesStarted, 0);
  assert.equal(dump.classifiers.length, 2);
  const [driver, helper] = dump.classifiers;
  assert.equal(driver.name, 'glide-engine'); assert.equal(driver.pathContains, '/mac-driver/');
  assert.match(driver.observedAt, /mac-driver\/build\.mjs/);
  assert.equal(helper.name, 'SkyComputerUseService');
  assert.equal(helper.pathSuffix, '/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService');
  assert.match(helper.observedAt, /R4-engine-cursor\.md/);
});
test('process witness stdin validation accepts only its fixed read-only inventory request', { skip: !processBinary }, () => {
  for (const row of [{ op: 'inventory' }, { op: 'inventory', pid: 123 }, { op: 'kill' }, 'not json']) {
    const result = boundedSpawn(processBinary, ['--validate'], { input: JSON.stringify(row), encoding: 'utf8', timeout: 5000 });
    const valid = typeof row === 'object' && row.op === 'inventory' && !row.pid;
    assert.equal(result.status, valid ? 0 : 65); assert.deepEqual(JSON.parse(result.stdout), { valid, windowsCreated: 0 });
  }
});

const processRow = (pid, path) => ({ pid, path, started: `${pid}.123` });
const driver = processRow(102, '/cache/mac-driver/build/glide-engine');
const helper = processRow(103, '/engine/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService');
const nearMiss = processRow(104, '/engine/SkyComputerUseService-other');
const fixtureCall = (mode, rows) => {
  const result = boundedSpawn(processBinary, [mode, '--fixture-stdin'], {
    input: JSON.stringify(rows) + '\n' + (mode === '--serve' ? '{"op":"inventory"}\n' : ''),
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
};
test('process dry run counts an unreadable peer and retains exact matches and a near-miss', { skip: !processBinary }, () => {
  const diagnostic = fixtureCall('--dry-run', [processRow(101, null), driver, helper, nearMiss]);
  assert.deepEqual(Object.keys(diagnostic).sort(), ['schema', 'classifiers', 'sightings', 'inventory', 'counts',
    'windowsCreated', 'inputGenerated', 'processesStarted'].sort());
  assert.equal(diagnostic.schema, 'sleight.runtime-process-diagnostic/1');
  assert.equal(diagnostic.classifiers.length, 2);
  assert.deepEqual(diagnostic.counts, { unreadable: 1, drivers: 1, helpers: 1, nearMisses: 1 });
  assert.deepEqual(diagnostic.inventory.drivers, [driver]);
  assert.deepEqual(diagnostic.inventory.helpers, [helper]);
  const candidate = { ...nearMiss, expectedKind: 'helpers', classified: 'nearMisses' };
  assert.deepEqual(diagnostic.inventory.nearMisses, [candidate]);
  assert.deepEqual(diagnostic.sightings, [
    { ...driver, expectedKind: 'drivers', classified: 'drivers' },
    { ...helper, expectedKind: 'helpers', classified: 'helpers' }, candidate,
  ]);
  assert.equal(diagnostic.windowsCreated, 0); assert.equal(diagnostic.processesStarted, 0);
  assert.equal(diagnostic.inputGenerated, false);
});
test('process inventory counts near-miss paths without stopping or classifying them as exact matches', { skip: !processBinary }, async () => {
  const rows = [
    nearMiss,
    processRow(105, '/cache/mac-driver/build/peer-host'),
    processRow(106, '/engine/Codex Computer Use.app/Contents/MacOS/new-helper'),
    processRow(107, '/other/SkyComputerUseService'),
    processRow(108, '/cache/mac-driver/build/glide-engine-other'),
    processRow(109, '/cache/glide-engine'),
  ];
  const unrelated = processRow(110, '/unrelated/application');
  for (const table of [rows, [...rows, driver, helper, processRow(101, null)]]) {
    const value = fixtureCall('--serve', [...table, unrelated]);
    const exact = table.includes(driver) ? 1 : 0;
    assert.deepEqual(value.counts, { nearMisses: 6, drivers: exact, helpers: exact, unreadable: exact });
    assert.deepEqual(value.drivers, exact ? [driver] : []);
    assert.deepEqual(value.helpers, exact ? [helper] : []);
    assert.deepEqual(value.nearMisses.map(row => row.pid), rows.map(row => row.pid));
    assert.ok(value.nearMisses.every(row => row.classified === 'nearMisses'));
    if (exact) await assert.rejects(awaitEngineIdle(async () => value, { timeoutMs: 0 }), /ENGINE_HELPER_PRESENT/);
    else assert.equal((await awaitEngineIdle(async () => value, { timeoutMs: 0 })).outcome, 'idle');
  }
});
test('process dry run returns complete zero counts for empty and unreadable-only tables', { skip: !processBinary }, () => {
  for (const rows of [[], [processRow(101, null), processRow(102, null)]]) {
    const value = fixtureCall('--dry-run', rows);
    assert.deepEqual(value.counts, { helpers: 0, drivers: 0, nearMisses: 0, unreadable: rows.length });
    assert.deepEqual(value.inventory, { helpers: [], drivers: [], nearMisses: [] });
    assert.deepEqual(value.sightings, []);
  }
});
test('an exact helper match takes precedence over a broad driver-cache candidate', { skip: !processBinary }, () => {
  const nestedHelper = processRow(111, '/cache/mac-driver/build/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService');
  const value = fixtureCall('--dry-run', [nestedHelper]);
  assert.deepEqual(value.counts, { helpers: 1, drivers: 0, nearMisses: 0, unreadable: 0 });
  assert.deepEqual(value.inventory.helpers, [nestedHelper]);
  assert.equal(value.sightings[0].expectedKind, 'helpers');
  assert.equal(value.sightings[0].classified, 'helpers');
});

const productionProcessBinary = process.env.RT13_PROCESS_PRODUCTION_TEST_BIN;
test('production process witness refuses synthetic tables before any process inventory', { skip: !productionProcessBinary }, () => {
  for (const mode of ['--dry-run', '--serve']) {
    const result = boundedSpawn(productionProcessBinary, [mode, '--fixture-stdin'], {
      input: '[]\n{"op":"inventory"}\n', encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.status, 64);
    assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  }
});

test('OS2 witness metadata and menu callbacks replay without creating a menu or window', options, () => {
  const callbacks = [
    { record: 'callback', timestamp: 1, name: 'deliveryState', target: 'fixture', details: { onActiveSpace: false, visible: true, miniaturized: false, fullScreen: false, windowNumber: 8 } },
    { record: 'callback', timestamp: 2, name: 'contextMenuReady', target: 'fixture', details: {} },
    { record: 'callback', timestamp: 3, name: 'contextMenuClosed', target: 'fixture', details: { opened: false } },
  ];
  const result = call('--serve-events', jsonLines(callbacks));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n').map(JSON.parse), callbacks);
});
