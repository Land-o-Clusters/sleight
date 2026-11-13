#!/usr/bin/env node
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, access, lstat, copyFile, chmod } from 'node:fs/promises';
import { constants, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rows = ['move', 'click', 'mapped-keys', 'belief-keys', 'unicode'];
const reasons = new Set(['ACCESSIBILITY_REQUIRED', 'BELIEF_INTERVAL_EXCEEDED', 'BELIEF_REQUIRES_BACKGROUND',
  'BELIEF_TIMEOUT', 'BELIEF_UNAVAILABLE', 'CANCELLED', 'CLEANUP_UNCONFIRMED', 'CRITICAL_SECTION_EXCEEDED', 'DEADLINE_EXCEEDED',
  'EVENT_CONSTRUCTION_FAILED', 'EVENT_NOT_PREPARED', 'HEIGHT_MISMATCH', 'HOST_STATE_UNAVAILABLE', 'INPUT_LIMIT', 'INVALID_POINT',
  'INVALID_REQUEST', 'NOT_EXACT_UTM', 'PERSON_ACTIVE', 'PERSON_HOLDS_MODIFIER', 'PERSON_OR_HOST_CHANGED', 'POINT_OUTSIDE_WINDOW', 'POINT_OUTSIDE_CONTENT',
  'PROBE_FAILED', 'PROCESS_IDENTITY_CHANGED', 'PROCESS_IDENTITY_UNAVAILABLE', 'SECURE_INPUT_ACTIVE',
  'SENT_UNVERIFIED', 'UNICODE_REQUIRES_MAPPED_Q', 'WINDOW_AMBIGUOUS', 'WINDOW_IDENTITY_CHANGED',
  'WINDOW_UNAVAILABLE', 'WINDOW_BLOCKED', 'WRONG_FOREGROUND_STATE', 'TIMED_WINDOW_HOLD', 'INSPECTED_NO_POST']);
const fail = code => { throw new Error(code); };
const integer = (v, max) => Number.isInteger(v) && v > 0 && v <= max;

export function planRow(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('INVALID_REQUEST');
  const { version, pid, window, row, mode, point, mappedQConfirmed, idleSeconds, toolbarHeight, titleBarHeight, coordinateMapping } = request;
  const keys = ['version', 'pid', 'window', 'row', 'mode'];
  if (row === 'move' || row === 'click') keys.push('point', 'toolbarHeight', 'titleBarHeight', 'coordinateMapping');
  if (row === 'unicode') keys.push('mappedQConfirmed');
  if (idleSeconds !== undefined) keys.push('idleSeconds');
  if (Object.keys(request).sort().join() !== keys.sort().join() || version !== 1 ||
      !integer(pid, 2147483647) || !integer(window, 2147483647) || !rows.includes(row) ||
      !['background', 'foreground'].includes(mode)) fail('INVALID_REQUEST');
  if (point !== undefined && (!Array.isArray(point) || point.length !== 2 || !point.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100000))) fail('INVALID_POINT');
  if ((row === 'move' || row === 'click') && !point) fail('INVALID_POINT');
  if (idleSeconds !== undefined && (typeof idleSeconds !== 'number' || !Number.isFinite(idleSeconds) || idleSeconds < 2 || idleSeconds > 3600)) fail('INVALID_REQUEST');
  if ((row === 'move' || row === 'click') && (typeof toolbarHeight !== 'number' || !Number.isFinite(toolbarHeight) || toolbarHeight < 1 || toolbarHeight > 512)) fail('INVALID_REQUEST');
  if ((row === 'move' || row === 'click') && (typeof titleBarHeight !== 'number' || !Number.isFinite(titleBarHeight) || titleBarHeight < 1 || titleBarHeight > 512 || coordinateMapping !== 'window-bottom-left-to-cg-top-left')) fail('INVALID_REQUEST');
  if (row === 'belief-keys' && mode !== 'background') fail('BELIEF_REQUIRES_BACKGROUND');
  if (row === 'unicode' && (mode !== 'foreground' || mappedQConfirmed !== true)) fail('UNICODE_REQUIRES_MAPPED_Q');
  const base = { pid, window, source: 'private', flags: 0, timestamp: 'monotonic-at-post' };
  const event = (type, fields = {}) => ({ ...base, type, delayBeforeMs: 0, ...fields });
  const mouse = (type, pressure, delayBeforeMs = 0) => event(type, { point, clickCount: type === 'mouseMoved' ? 0 : 1, pressure, eventNumber: 0, delayBeforeMs });
  const key = (type, keyCode, unicode) => {
    const characters = unicode ?? (keyCode === 12 ? 'q' : keyCode === 123 ? '\uf702' : '\r');
    return event(type, { keyCode, point: [0, 0], characters, charactersIgnoringModifiers: characters,
      autorepeat: false, keyboardType: 'host-LMGetKbdType', delayBeforeMs: type === 'keyUp' ? 10 : 0,
      ...(unicode === undefined ? {} : { unicode }) });
  };
  let events;
  if (row === 'move') events = [mouse('mouseMoved', 0)];
  if (row === 'click') events = [mouse('mouseMoved', 0), mouse('leftMouseDown', 1), mouse('leftMouseUp', 0, 50)];
  if (row === 'mapped-keys' || row === 'belief-keys') events = [12, 123, 36].flatMap(code => [key('keyDown', code), key('keyUp', code)]);
  if (row === 'belief-keys') {
    const belief = type => event(type, { point: [0, 0], subtype: type, data1: 0, data2: 0 });
    events = [belief('applicationActivated'), ...events, belief('applicationDeactivated')];
  }
  if (row === 'unicode') events = [key('keyDown', 0, 'q'), key('keyUp', 0, 'q')];
  return { version: 1, row, mode, coordinateSpace: 'window-bottom-left-points',
    ...(point ? { titleBarHeight, toolbarHeight, coordinateMapping } : {}),
    beliefWaitMs: row === 'belief-keys' ? 150 : 0, beliefLimitMs: row === 'belief-keys' ? 400 : 0, events };
}

export function parseArgs(args) {
  const flags = new Set(['--dry-run', '--inspect', '--live', '--build-only', '--foreground', '--mapped-q-confirmed', '--capture-off-confirmed']);
  const values = new Set(['--pid', '--window', '--row', '--x', '--y', '--tool', '--idle-seconds', '--toolbar-height', '--title-bar-height', '--coordinate-mapping']);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (Object.hasOwn(options, name) || (!flags.has(name) && !values.has(name))) fail('INVALID_ARGUMENT');
    if (flags.has(name)) options[name] = true;
    else {
      if (i + 1 === args.length || args[i + 1].startsWith('--')) fail('MISSING_ARGUMENT');
      options[name] = args[++i];
    }
  }
  if (['--dry-run', '--inspect', '--live', '--build-only'].filter(k => options[k]).length !== 1) fail('CHOOSE_ONE_MODE');
  const tool = options['--tool'];
  if (tool && (!isAbsolute(tool) || resolve(tool) !== tool)) fail('INVALID_TOOL_PATH');
  if (options['--build-only']) {
    if (!tool || Object.keys(options).length !== 2) fail('BUILD_REQUIRES_NEW_TOOL_PATH');
    return { buildOnly: true, tool };
  }
  const number = name => {
    const value = options[name];
    if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value ?? '')) fail('INVALID_NUMBER');
    return Number(value);
  };
  const request = { version: 1, pid: number('--pid'), window: number('--window'), row: options['--row'], mode: options['--foreground'] ? 'foreground' : 'background' };
  if (options['--x'] !== undefined || options['--y'] !== undefined) request.point = [number('--x'), number('--y')];
  if (options['--mapped-q-confirmed']) request.mappedQConfirmed = true;
  if (options['--idle-seconds'] !== undefined) request.idleSeconds = number('--idle-seconds');
  if (options['--toolbar-height'] !== undefined) request.toolbarHeight = number('--toolbar-height');
  if (options['--title-bar-height'] !== undefined) request.titleBarHeight = number('--title-bar-height');
  if (options['--coordinate-mapping'] !== undefined) request.coordinateMapping = options['--coordinate-mapping'];
  planRow(request);
  if (options['--live'] && (!tool || !options['--capture-off-confirmed'])) fail('LIVE_REQUIRES_TOOL_AND_CAPTURE_OFF');
  if (options['--inspect'] && !tool) fail('INSPECT_REQUIRES_TOOL');
  return { request, tool, dryRun: !!options['--dry-run'], inspect: !!options['--inspect'] };
}

export function assertNoHold(stat = lstatSync) {
  try { stat('/tmp/sleight-hold'); }
  catch (error) { if (error?.code === 'ENOENT') return; }
  fail('TIMED_WINDOW_HOLD');
}

const usage = `RT31 single-row probe
--build-only --tool ABSENT_PATH
--dry-run | --inspect --tool PATH | --live --tool PATH --capture-off-confirmed
  --pid PID --window NUMBER --row move|click|mapped-keys|belief-keys|unicode
  [--foreground] [--mapped-q-confirmed] [--idle-seconds 2..3600]
Pointer rows also require --x X --y Y --title-bar-height 1..512 --toolbar-height 1..512
  --coordinate-mapping window-bottom-left-to-cg-top-left
Points are window-frame bottom-left points; CG = (frame.x + x, frame.y + frame.height - y).
Pointer rows measure AX window, toolbar and content frames at startup and before every post.
Typed heights may differ from measured heights by at most 2 points; points must be inside content.
First use --inspect with --row mapped-keys for AX window, toolbar and content frames,
  measured titleBarHeight and toolbarHeight, with zero posts. Copy those measured heights
  into pointer arguments, then --inspect each point against the AX content frame.
--dry-run prints only a plan and never starts a helper. --inspect reads host metadata.
Never pause or stop the helper. SIGSTOP and SIGKILL cannot be caught; a held input can
remain down for the entire stop. Do not renice a running helper. Set nice before launch.
Down/up pairs hold keys 10 ms and clicks 50 ms, with no full identity read while held.
Before release: one kernel start-time read, a hold lstat, and AX geometry for pointer input.
A failed check still releases held input, then stops.
maxCriticalSectionMs measures each row's longest pair; above 100 ms stops the sitting.
Catchable stop/continue signals cancel permanently. No input is replayed.
/tmp/sleight-hold is checked with lstat at startup, before each row and each post.
A hold stops new input; an already held input is released before the row stops.
`;

// No raw child output reaches the report stream. Only this bounded metadata schema is accepted.
function validRecord(r) {
  const numeric = ['attempted', 'releases', 'pending', 'elapsedMs', 'maxCriticalSectionMs', 'pid', 'window', 'hidIdleBeforeMs', 'hidIdleAfterMs', 'hidIdleMs', 'idleThresholdMs', 'cgWindowCount', 'axWindowCount', 'sheetCount', 'childCount', 'blockingChildCount', 'modalCount'];
  const bools = ['ok', 'focusChanged', 'pointerChanged', 'personInput', 'beliefCleared', 'criticalSectionExceeded'];
  const strings = ['record', 'reason', 'row'];
  const inspectionNumbers = ['hostPid', 'processStartSeconds', 'processStartMicroseconds', 'hostStartSeconds', 'hostStartMicroseconds', 'titleBarHeight', 'toolbarHeight'];
  const arrays = { windowFrame: 4, axWindowFrame: 4, axToolbarFrame: 4, axContentFrame: 4, windowPoint: 2, cgPoint: 2, appKitCGPoint: 2 };
  if (!r || Array.isArray(r) || !['summary', 'inspection'].includes(r.record) || typeof r.ok !== 'boolean' ||
      !reasons.has(r.reason)) return false;
  if (typeof r.maxCriticalSectionMs !== 'number' || !Number.isFinite(r.maxCriticalSectionMs) || r.maxCriticalSectionMs < 0) return false;
  if (r.record === 'inspection' && (r.reason !== 'INSPECTED_NO_POST' || r.ok !== true || r.attempted !== 0 || r.releases !== 0 || r.pending !== 0 || r.beliefCleared !== true)) return false;
  if (r.record === 'inspection' && !['windowFrame', 'axWindowFrame', 'axToolbarFrame', 'axContentFrame', 'titleBarHeight', 'toolbarHeight'].every(k => Object.hasOwn(r, k))) return false;
  return (!Object.hasOwn(r, 'row') || rows.includes(r.row)) && Object.entries(r).every(([k, v]) => {
    if (numeric.includes(k) || (r.record === 'inspection' && inspectionNumbers.includes(k))) return typeof v === 'number' && Number.isFinite(v) && v >= 0;
    if (bools.includes(k)) return typeof v === 'boolean';
    if (r.record === 'inspection' && Object.hasOwn(arrays, k)) return Array.isArray(v) && v.length === arrays[k] && v.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 200000);
    if (r.record === 'inspection' && k === 'coordinateMapping') return v === 'window-bottom-left-to-cg-top-left';
    return strings.includes(k) && typeof v === 'string';
  }) &&
    ['attempted', 'releases', 'pending'].every(k => Number.isInteger(r[k]));
}

export function startTool(tool, request, { spawn = nodeSpawn, holdLstat = lstatSync, inspect = false } = {}) {
  planRow(request);
  assertNoHold(holdLstat);
  const child = spawn(tool, [inspect ? '--inspect' : '--live'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let interrupted = false, invalid = false, output = '', bytes = 0, spawnFailed = false;
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    if (child.stdin.writable !== false && !child.stdin.destroyed) child.stdin.write('cancel\n');
  };
  const done = new Promise(resolveDone => {
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 16384) { invalid = true; interrupt(); return; }
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', () => {});
    child.on('error', () => { spawnFailed = true; });
    child.on('close', (code, signal) => {
      child.stdin.destroy();
      let records = [];
      try {
        records = output.trim().split('\n').map(s => JSON.parse(s));
        if (records.length !== 1 || !records.every(validRecord)) invalid = true;
        if (records[0]?.ok && records[0].record !== (inspect ? 'inspection' : 'summary')) invalid = true;
      } catch { invalid = true; }
      if (!invalid && records[0]?.maxCriticalSectionMs > 100) {
        records[0].ok = false; records[0].criticalSectionExceeded = true;
        if (records[0].pending > 0 || records[0].beliefCleared === false || records[0].reason === 'CLEANUP_UNCONFIRMED') {
          records[0].reason = 'CLEANUP_UNCONFIRMED';
        } else records[0].reason = 'CRITICAL_SECTION_EXCEEDED';
      }
      resolveDone({ code: spawnFailed ? 70 : invalid ? 74 : signal ? 70 : code === 0 && (!records[0].ok || records[0].pending !== 0 || records[0].beliefCleared !== true) ? 1 : code ?? 70,
        reason: spawnFailed ? 'TOOL_START_FAILED' : invalid ? 'TOOL_OUTPUT_INVALID' : signal ? 'TOOL_SIGNALLED' : records[0]?.reason,
        records: invalid || spawnFailed ? [] : records });
    });
  });
  child.stdin.write(JSON.stringify(request) + '\n');
  return { child, interrupt, done };
}

// Stop and resume signals cancel the row permanently. Never resume posting after a stop.
export function superviseSignals(interrupt, emitter = process) {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGTSTP', 'SIGCONT'];
  for (const signal of signals) emitter.on(signal, interrupt);
  return () => { for (const signal of signals) emitter.off(signal, interrupt); };
}

export async function buildTool(destination) {
  if (!isAbsolute(destination) || resolve(destination) !== destination) fail('INVALID_TOOL_PATH');
  try { await lstat(destination); fail('TOOL_ALREADY_EXISTS'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // xcrun supplies the SDK for the selected developer directory. Preflight it
  // first so a machine without tools cannot show an installation dialog.
  const selected = spawnSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8', maxBuffer: 4096 });
  const developer = selected.stdout?.trim();
  if (selected.status !== 0 || !developer || !isAbsolute(developer) || resolve(developer) !== developer) fail('SWIFT_COMPILER_MISSING');
  let installed = false;
  for (const folder of ['usr/bin', 'Toolchains/XcodeDefault.xctoolchain/usr/bin']) {
    try { await access(join(developer, folder, 'swiftc'), constants.X_OK); installed = true; break; } catch {}
  }
  if (!installed) fail('SWIFT_COMPILER_MISSING');
  const root = await mkdtemp(join(tmpdir(), 'sleight-rt31-build-'));
  try {
    // The terminal interrupts this foreground process group. Keep Node alive until
    // swiftc closes, including after Ctrl-C, so the caller retains the TTY handle.
    const onInterrupt = () => {};
    const removeSignals = superviseSignals(onInterrupt);
    let failed = false, status;
    try {
      const child = nodeSpawn('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-module-cache-path', join(root, 'modules'), fileURLToPath(new URL('./rt31-probe.swift', import.meta.url)), '-o', join(root, 'tool')], { stdio: ['ignore', 'ignore', 'ignore'] });
      status = await new Promise(resolveDone => {
        child.on('error', () => { failed = true; });
        child.on('close', code => resolveDone(failed ? 70 : code ?? 70));
      });
    } finally { removeSignals(); }
    if (status !== 0) fail('BUILD_FAILED');
    await chmod(join(root, 'tool'), 0o700);
    await copyFile(join(root, 'tool'), destination, constants.COPYFILE_EXCL);
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function main() {
  if (process.argv.slice(2).join() === '--help') { console.log(usage); return; }
  assertNoHold();
  const options = parseArgs(process.argv.slice(2));
  if (options.buildOnly) { await buildTool(options.tool); console.log(JSON.stringify({ record: 'build', ok: true })); return; }
  if (options.dryRun) { console.log(JSON.stringify(planRow(options.request))); return; }
  let run, interrupted = false;
  const interrupt = () => { interrupted = true; run?.interrupt(); };
  const removeSignals = superviseSignals(interrupt);
  try {
    run = startTool(options.tool, options.request, { inspect: options.inspect });
    if (interrupted) run.interrupt();
    const result = await run.done;
    for (const record of result.records) console.log(JSON.stringify(record));
    if (!result.records.length) console.error(result.reason);
    process.exitCode = result.code;
  } finally { removeSignals(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message === 'TIMED_WINDOW_HOLD' ? 'TIMED_WINDOW_HOLD' : 'RT31_PROBE_REFUSED'); process.exitCode = 65; });
