#!/usr/bin/env node
// H5, the ghost hand capture test (fable-1018-ghost-hand.md section 5 item 5, ledger/p130/live-runbook-1019.md step 3a).
// It shows the real hand host (consent-host --hand, built here from this checkout's source) over a TextEdit window this run
// opens, in each capture mode, and takes every kind of capture while the panel is on screen: sleight's own screenshots (the
// engine's window screenshot through a sleight session, and the hover tool's region capture 100 ms after a hide), the
// user's own captures (a region selection and the launch film's window-plus-hand recording) and two one-window captures.
// bench/hand/pixels.mjs holds the pixel rules and the verdicts. Captures are single windows or a region inside the target
// window that no other app covers (LAWS: never the whole screen); the report holds counts, pids and frames, never pixels,
// titles or names, and images stay local (--keep-images keeps one PNG per capture path and mode, never a region capture).
//
//   node bench/hand/h5-capture.mjs --owner-away [--cursor-style glove|ring|seam|sprite] [--samples 5] [--out DIR] [--keep-images]
//        [--host PATH] [--helper PATH] [--receipt PATH] [--dry-run]
//
// --cursor-style (VC7, the agent cursor) runs the same test on a ring style. sprite installs a synthetic character
// (synthetic-character.mjs) into a temporary characters root under the host's test override and needs a host with the
// sprite renderer (VC4); without one it stops with exit 2. Ring pixels are judged by pixels.mjs's cursorColoured rule.
// --dry-run prints the steps and commands and opens nothing.
//
// Run from sleight-arch's own Terminal shell (it holds Screen Recording), never double-forked. It waits for nothing: with
// /tmp/sleight-hold present, the live lock held or TextEdit already running (it may be the owner's) it stops at once.
// Exit 0: both modes pass. 1: a mode failed or was inconclusive. 2: setup refused. 3: busy.
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compareFrames, classify, modeVerdict, decision, colourRule, SOURCES, TOLERANCE, MIN_HAND, CURSOR_STYLES } from './pixels.mjs';
import { characterWire } from './synthetic-character.mjs';
import { DOCUMENT_LAUNCH as LAUNCH_ARGS, hostArgs } from './vc7-live.mjs';

const execute = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const TEXTEDIT = 'com.apple.TextEdit';
// As bench/real-fixture.mjs: without these TextEdit restores the owner's windows and iCloud "Untitled" documents.
export const DOCUMENT_LAUNCH = LAUNCH_ARGS;
const CAPTURE_ORDER = ['engine', 'region', 'window-l', 'sck-window', 'composite'];
const HOVER_WAIT_MS = 100; // hover.js's shortest waitMs: the relay hides the hand, then hover captures this much later
const KEEPALIVE_MS = 700;  // a frame this often keeps the panel up: each holds the hand 1.5 s after its lift (HandTiming.silence)

const intersects = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const rectArg = r => [r.x, r.y, r.width, r.height].map(Math.round).join(',');

/** Windows in front of the target (CGWindowList order, front first) that overlap rect, at any layer (the Dock, the menu bar
 *  and floating panels too), other than the target's own and the hand's. A region capture over any of them would hold
 *  another window's pixels, which LAWS rules out. With no target in the list, every window counts. */
export function covering(rect, target, windows, ignorePids = []) {
  const at = windows.findIndex(w => w.id === target.id);
  const above = at < 0 ? windows : windows.slice(0, at);
  return above.filter(w => w.alpha > 0 && w.pid !== target.pid && !ignorePids.includes(w.pid) && intersects(rect, w.bounds));
}

/** The region the hand plays in and region captures cover: the window below its title bar, inset, or else the first of its
 *  four quarters no other window covers. { rect } or { covered }. */
export function pickRegion(target, windows, { titleBar = 60, inset = 24, min = { width: 220, height: 160 } } = {}) {
  const b = target.bounds;
  const body = { x: b.x + inset, y: b.y + titleBar, width: b.width - 2 * inset, height: b.height - titleBar - inset };
  if (body.width < min.width || body.height < min.height) return { covered: 'the TextEdit window is too small' };
  const halves = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([i, j]) => ({ x: body.x + i * body.width / 2, y: body.y + j * body.height / 2,
    width: body.width / 2, height: body.height / 2 })).filter(r => r.width >= min.width && r.height >= min.height);
  for (const rect of [body, ...halves]) if (!covering(rect, target, windows).length) return { rect };
  return { covered: `other windows cover every part of the TextEdit window (${covering(body, target, windows).length} over it)` };
}

/** Whether the hand host has an on-screen window over the target. */
export function panelUp(windows, hostPid, target) {
  return Boolean(hostPid) && windows.some(w => w.pid === hostPid && w.alpha > 0 && intersects(w.bounds, target.bounds));
}

/** The host's wire frames (consent-host.swift HAND FRAME), bound to one nonce. */
export function handWire(nonce = randomBytes(32).toString('hex')) {
  let seq = 0;
  return {
    nonce,
    act: ({ pid, windowId, at, from }) => JSON.stringify({ hand: 'act', nonce, seq: seq++, kind: 'click', pid, windowId, at,
      path: from ? [from, at] : [at], delayMs: 0, beats: 1 }) + '\n',
    hide: () => JSON.stringify({ hand: 'hide', nonce }) + '\n',
    // VC4's sprite frame: it shares the acts' seq, as the relay's client numbers them.
    character: character => JSON.stringify(characterWire(character, { nonce, seq: seq++ })) + '\n',
  };
}

/** The two points the keepalive alternates between, and where the AX hit test looks: on the glove's body, which sits down
 *  and right of the fingertip (spec.md: about 30 by 30 pt). */
export function spots(rect) {
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  const points = [[cx - 40, cy - 20], [cx + 20, cy + 10]].map(p => p.map(n => Math.round(n)));
  return { points, body: ([x, y]) => [x + 14, y + 18] };
}

/** The whole test against its boundary. deps: windows() → { front, windows }, capture(source, { hostPid, label }) → frame,
 *  hit(x, y) → pid or undefined, startHost(mode) → { pid, write(line), close() }, sleep(ms), log(line). */
export async function runCaptureTest(deps, { target, samples = 5, tol = TOLERANCE, minHand = MIN_HAND, style = 'glove', character } = {}) {
  const { log = () => {} } = deps;
  const coloured = colourRule(style);
  if (style === 'sprite' && !character) throw new Error('the sprite style needs a character');
  const report = { style, target: { pid: target.pid, id: target.id, bounds: target.bounds }, samples, tol, minHand, modes: {}, notes: [] };
  const listed = await deps.windows();
  const region = pickRegion(target, listed.windows);
  const skipRegion = region.covered;
  if (skipRegion) report.notes.push(`region and hover captures skipped: ${skipRegion}`);
  const rect = region.rect ?? { x: target.bounds.x + 24, y: target.bounds.y + 60, width: target.bounds.width - 48, height: target.bounds.height - 84 };
  report.region = rect;
  const { points, body } = spots(rect);
  const sources = CAPTURE_ORDER.filter(s => !(skipRegion && s === 'region'));
  const shot = (source, ctx) => deps.capture(source === 'hover' ? 'region' : source, { ...ctx, rect, target });

  // Two baselines per path with no hand anywhere: the second gives the path's noise.
  log('baselines');
  const baseline = {}, noise = {};
  for (const source of [...sources, ...(skipRegion ? [] : ['hover'])]) {
    if (source === 'hover') { baseline.hover = baseline.region; noise.hover = noise.region; continue; }
    const first = await shot(source, { hostPid: 0, label: `${source}-base-1` });
    const second = await shot(source, { hostPid: 0, label: `${source}-base-2` });
    baseline[source] = first;
    const c = compareFrames(first, second, { tol, coloured });
    noise[source] = c.sizeMismatch ? Infinity : c.differing;
  }
  report.noise = Object.fromEntries(Object.entries(noise).map(([k, v]) => [k, Number.isFinite(v) ? v : 'size-changed']));
  for (const [source, value] of Object.entries(noise)) if (value) report.notes.push(`${source}: its two baselines differ in ${Number.isFinite(value) ? value : 'size'} pixels, so it is judged by hand-coloured pixels only`);

  for (const mode of ['hidden', 'visible']) {
    log(`mode ${mode}`);
    const host = await deps.startHost(mode, style);
    const wire = handWire();
    if (character) host.write(wire.character(character));
    let k = 0, last = points[0], timer;
    const ping = () => {
      const at = points[k++ % 2];
      host.write(wire.act({ pid: target.pid, windowId: target.id, at, from: last })); last = at;
    };
    const keepalive = () => { ping(); timer = setInterval(ping, KEEPALIVE_MS); };
    const pause = () => clearInterval(timer);
    const result = [];
    const record = async (source, label, take, { hide = false } = {}) => {
      const before = await deps.windows();
      // A region capture is taken only while nothing but the target and the hand is over the region, checked each time.
      if (['region', 'hover'].includes(source) && covering(rect, target, before.windows, [host.pid]).length) {
        result.push({ source, sample: label, handUp: false, result: 'skipped', reason: 'covered', frontPid: before.front });
        return;
      }
      let up = panelUp(before.windows, host.pid, target), frame, error;
      if (hide) { host.write(wire.hide()); await deps.sleep(HOVER_WAIT_MS); }
      try { frame = await take(); } catch (e) { error = String(e?.message ?? e).slice(0, 200); }
      const after = await deps.windows();
      if (!hide) up = up && panelUp(after.windows, host.pid, target);
      const point = body(last);
      const hitPid = hide ? undefined : await deps.hit(...point);
      const c = frame ? compareFrames(baseline[source], frame, { tol, coloured }) : { sizeMismatch: true, error };
      result.push({ source, sample: label, handUp: up, result: frame ? classify(c, { noise: noise[source], minHand }) : 'error',
        differing: c.differing, handLike: c.handLike, ...(c.box ? { box: c.box } : {}), ...(error ? { error } : {}),
        // The composite's count of hand windows ScreenCaptureKit listed: 0 means the panel was not shareable at all.
        ...(Array.isArray(frame?.handWindows) ? { shareableHandWindows: frame.handWindows.length } : {}),
        ...(Number.isSafeInteger(hitPid) ? { hitPid } : {}), frontPid: before.front });
    };
    try {
      keepalive();
      await deps.sleep(1200); // the first frame's entry and glide
      for (let i = 1; i <= samples; i++) {
        for (const source of sources) await record(source, i, () => shot(source, { hostPid: host.pid, label: `${mode}-${source}-${i}` }));
        if (!skipRegion) {
          // Hover's path: a fresh frame, the hand settled in its hold, then the relay's hide and hover's shortest wait.
          pause(); ping();
          await deps.sleep(900);
          await record('hover', i, () => shot('hover', { hostPid: host.pid, label: `${mode}-hover-${i}` }), { hide: true });
          await deps.sleep(600); // the fade ends and the panel is released
          keepalive();
        }
      }
    } finally {
      pause();
      await host.close();
    }
    // The panel must be gone before the next mode's host starts.
    for (let i = 0; i < 20 && panelUp((await deps.windows()).windows, host.pid, target); i++) await deps.sleep(250);
    const listed = result.filter(s => s.source === 'composite' && Number.isInteger(s.shareableHandWindows));
    report.modes[mode] = { ...modeVerdict(mode, result, { hostPid: host.pid }), hostPid: host.pid,
      // Whether ScreenCaptureKit listed the hand's panel as shareable content at all (sharingType none should hide it).
      panelShareable: listed.length ? `${listed.filter(s => s.shareableHandWindows > 0).length} of ${listed.length}` : 'unknown', samples: result };
  }

  // The window must not have changed under the test: a third baseline against the first.
  report.drift = {};
  for (const source of sources) {
    const c = compareFrames(baseline[source], await shot(source, { hostPid: 0, label: `${source}-base-3` }), { tol, coloured });
    report.drift[source] = c.sizeMismatch ? 'size-changed' : c.differing;
    if (c.sizeMismatch || c.differing > (Number.isFinite(noise[source]) ? noise[source] : 0)) report.notes.push(`${source}: the window changed during the test (${report.drift[source]} pixels); rerun`);
  }
  report.decision = decision(report.modes.hidden, report.modes.visible);
  report.ok = report.modes.hidden.verdict === 'pass' && report.modes.visible.verdict === 'pass';
  return report;
}

/** The command and arguments each real capture path runs. png and raw are file paths. */
export function captureCommand(source, { target, rect, hostPid = 0, png, raw }) {
  if (source === 'region') return { tool: 'screencapture', args: ['-x', `-R${rectArg(rect)}`, png], decode: true }; // as hover.js
  if (source === 'window-l') return { tool: 'screencapture', args: ['-x', '-o', `-l${target.id}`, png], decode: true };
  if (source === 'sck-window') return { tool: 'helper', args: ['sck-window', String(target.id), raw] };
  if (source === 'composite') return { tool: 'helper', args: ['sck-composite', String(target.id), String(hostPid), raw] };
  if (source === 'engine') return { tool: 'engine', decode: true };
  throw new Error(`unknown capture ${source}`);
}

export function readFrame(path, { width, height }) {
  const data = readFileSync(path);
  if (data.length !== width * height * 4) throw new Error(`raw frame ${width} x ${height} has ${data.length} bytes`);
  return { width, height, data };
}

// The engine's screenshot of the leased window through a sleight session, as Claude gets it.
export const ENGINE_ACQUIRE = `var app = await cua.getApp(${JSON.stringify(TEXTEDIT)})`;
export const ENGINE_SHOT = 'await app.getScreenshot()';
export function engineImage(result) {
  const image = (result?.content ?? []).filter(block => block?.type === 'image' && typeof block.data === 'string').at(-1);
  if (!image) throw new Error('the engine returned no screenshot');
  return { bytes: Buffer.from(image.data, 'base64'), extension: /jpe?g/.test(image.mimeType ?? '') ? 'jpg' : 'png' };
}

// Approvals: only TextEdit, and only the benchmark's own decision for it.
export async function textEditApproval(params) {
  const message = params?.message ?? '';
  const app = /^Allow Computer Use to use "(.+)"\?$/.exec(message)?.[1];
  if (app !== 'TextEdit' && app !== TEXTEDIT) return { action: 'decline' };
  const { benchmarkDecision } = await import('../approve.mjs');
  const answer = benchmarkDecision({ mcp_server_name: 'plugin:sleight:computer', message, requested_schema: params.requestedSchema, mode: params.mode }, { BENCH_SUITE: 'real' });
  return answer?.hookSpecificOutput?.action === 'accept' ? { action: 'accept', content: answer.hookSpecificOutput.content ?? {} } : { action: 'decline' };
}

export function parseArgs(argv) {
  const value = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const samples = Number(value('--samples') ?? 5);
  if (!Number.isInteger(samples) || samples < 3 || samples > 20) throw new Error('--samples must be a whole number from 3 to 20');
  const style = value('--cursor-style') ?? 'glove';
  if (!CURSOR_STYLES.includes(style)) throw new Error(`--cursor-style must be one of ${CURSOR_STYLES.join(', ')}`);
  return { ownerAway: argv.includes('--owner-away'), samples, keepImages: argv.includes('--keep-images'), out: value('--out'), host: value('--host'),
    helper: value('--helper'), receipt: value('--receipt'), style, dryRun: argv.includes('--dry-run') };
}

export function summary(report) {
  const what = !report.style || report.style === 'glove' ? 'H5 ghost hand capture test' : `VC7 capture test, cursor style ${report.style}`;
  const lines = [`${what}: ${report.ok ? 'PASS' : 'NOT PASSED'} (${report.decision.capture})`, `  ${report.decision.words}`];
  for (const mode of ['hidden', 'visible']) {
    const m = report.modes[mode];
    lines.push(`  ${mode}: ${m.verdict} (ScreenCaptureKit listed the panel in ${m.panelShareable} composite captures)`);
    for (const [source, t] of Object.entries(m.sources)) {
      lines.push(`    ${source.padEnd(10)} ${SOURCES[source].padEnd(7)} counted ${t.counted}/${t.taken}  excluded ${t.excluded}  shown ${t.shown}  trace ${t.trace}  error ${t.error}${t.skipped ? `  skipped ${t.skipped}` : ''}`);
    }
    for (const reason of m.reasons) lines.push(`    - ${reason}`);
    for (const note of m.notes) lines.push(`    note: ${note}`);
  }
  for (const note of report.notes) lines.push(`  note: ${note}`);
  return lines.join('\n');
}

const home = homedir();
const tilde = text => String(text).split(home).join('~');

/** Runs work(state) holding the live lock. Everything after the lock is inside the try: setup that throws, a normal end, a
 *  SIGINT or a SIGTERM all run state.cleanups (last added first) and then release the lock. On a signal the process exits
 *  with 130 or 143 after cleanup; a second signal exits at once. Returns work's exit code, 1 when it threw, 3 when busy. */
export async function underLiveLock({ acquire, signals = process, exit = code => process.exit(code), log = message => console.error(message) }, work) {
  let unlock;
  try { unlock = await acquire(); } catch (error) { log(error.message); return 3; }
  const state = { cleanups: [] };
  let cleaning, signalled = false;
  const cleanup = () => cleaning ??= (async () => {
    for (const fn of [...state.cleanups].reverse()) { try { await fn(); } catch (error) { log(`cleanup: ${tilde(error.message)}`); } }
    try { await unlock(); } catch (error) { log(`live lock: ${error.message}`); }
  })();
  const handlers = Object.fromEntries([['SIGINT', 130], ['SIGTERM', 143]].map(([name, code]) => [name, () => {
    if (signalled) return exit(code);
    signalled = true;
    log(`${name}: cleaning up and releasing the live lock`);
    cleanup().finally(() => exit(code));
  }]));
  for (const [name, handler] of Object.entries(handlers)) signals.on(name, handler);
  try { return await work(state); }
  // A setup refusal thrown from inside (vc7-live.mjs: TextEdit already running) carries exitCode 2, so a runner retries it.
  catch (error) { log(`H5 stopped: ${tilde(error.message)}`); return error?.exitCode === 2 ? 2 : 1; }
  finally {
    await cleanup();
    for (const [name, handler] of Object.entries(handlers)) signals.removeListener(name, handler);
  }
}

/** The plan --dry-run prints: every step and the exact commands, with nothing opened. */
export function dryRunPlan(opts, { root = ROOT, out = '<out>' } = {}) {
  const host = tilde(opts.host ?? '<work>/consent-host'), helper = tilde(opts.helper ?? '<work>/capture-helper');
  const sprite = opts.style === 'sprite';
  return [
    `VC7/H5 capture test, cursor style ${opts.style}, ${opts.samples} samples per source and mode (dry run: nothing opened)`,
    '1. refuse with /tmp/sleight-hold present, take /tmp/sleight-live.lock (no wait)',
    ...(opts.helper ? [] : [`2. build: xcrun swiftc -module-cache-path <cache> ${tilde(join(root, 'bench/hand/capture.swift'))} -o ${helper}`]),
    ...(opts.host ? [] : [`   build: xcrun swiftc -module-cache-path <cache> ${tilde(join(root, 'plugins/sleight/lib/direct-browser/native/consent-host.swift'))} -o ${host}`]),
    `3. ${helper} preflight (Screen Recording and Accessibility, no prompt); refuse when TextEdit runs`,
    ...(sprite ? ['4. install the synthetic character into /private/tmp/sleight-vc7-characters-XXXXXX (0700, sheet.png 0600)',
      `   ${host} --check-character < <character frame>   (exit 64: no sprite renderer, stop with exit 2)`] : []),
    `5. /usr/bin/open -g -a TextEdit <work>/sleight-h5.txt ${DOCUMENT_LAUNCH.join(' ')}${opts.receipt ? `   (receipt ${tilde(opts.receipt)})` : ''}`,
    `6. sleight-mcp session (SLEIGHT_HAND=0, SLEIGHT_SURFACES=computer): ${ENGINE_ACQUIRE}`,
    `7. two baselines per source: engine (${ENGINE_SHOT}), screencapture -x -R<region>, screencapture -x -o -l<window>, ${helper} sck-window, ${helper} sck-composite`,
    ...['hidden', 'visible'].map((mode, i) => `${8 + i}. ${sprite ? `${Object.entries({ SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: '<root>' }).map(([k, v]) => `${k}=${v}`).join(' ')} ` : ''}${host} ${hostArgs({ capture: mode, style: opts.style }).join(' ')}; ` +
      `act frames every ${KEEPALIVE_MS} ms; ${opts.samples} samples of every source, hover after a hide and ${HOVER_WAIT_MS} ms`),
    '10. a third baseline per source (drift); quit the TextEdit this run started; kill any host left; release the lock',
    `11. report: ${tilde(join(out, 'h5-report.json'))}`,
  ];
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) { console.error(error.message); return 2; }
  const out = resolve(opts.out ?? join(home, 'Library/Logs/sleight', `h5-${opts.style === 'glove' ? '' : `${opts.style}-`}${new Date().toISOString().replace(/[:.]/g, '-')}`));
  if (opts.dryRun) { console.log(dryRunPlan(opts, { out }).join('\n')); return 0; }
  if (!opts.ownerAway) { console.error('H5 opens a TextEdit window and shows the hand over it: pass --owner-away'); return 2; }
  if (process.platform !== 'darwin') { console.error('macOS only'); return 2; }
  if (existsSync('/tmp/sleight-hold')) { console.error('/tmp/sleight-hold exists (another project\'s timed window): run later'); return 3; }
  const { acquireLiveLock } = await import('../live-lock.mjs');
  return underLiveLock({ acquire: () => acquireLiveLock('/tmp/sleight-live.lock', { wait: false }) }, async ({ cleanups }) => {
    mkdirSync(out, { recursive: true });
    const work = mkdtempSync(join(tmpdir(), 'sleight-h5-'));
    cleanups.push(() => rmSync(work, { recursive: true, force: true }));
    const live = await import('../compat/live.mjs');
    const { compileSwift, helperClient, openTextEditFixture, startHandHost, killHosts, spriteSupport } = await import('./vc7-live.mjs');
    console.log('Building the capture helper and the hand host (first time: a few minutes)');
    const helperBin = opts.helper ?? join(work, 'capture-helper');
    const hostBin = opts.host ?? join(work, 'consent-host');
    await Promise.all([opts.helper ? undefined : compileSwift(join(ROOT, 'bench/hand/capture.swift'), helperBin),
      opts.host ? undefined : compileSwift(join(ROOT, 'plugins/sleight/lib/direct-browser/native/consent-host.swift'), hostBin)]);
    const helper = helperClient(helperBin);
    const grants = await helper(['preflight']);
    if (!grants.screenRecording) {
      console.error('Screen Recording is not granted to the app that started this shell. Run it from the Terminal window that runs the Peekaboo arm.');
      return 2;
    }
    if ((await live.appState(TEXTEDIT)).running) { console.error('TextEdit is running and may be the owner\'s: quit it or run later'); return 2; }

    // The sprite style: a synthetic character in a temporary root, checked by the host before any window opens.
    let character, hostEnv = {};
    if (opts.style === 'sprite') {
      const { installSyntheticCharacter, characterEnv } = await import('./synthetic-character.mjs');
      character = installSyntheticCharacter();
      cleanups.push(() => rmSync(character.root, { recursive: true, force: true }));
      hostEnv = characterEnv(character.root);
      const probe = await spriteSupport(hostBin, JSON.stringify(characterWire(character, { nonce: randomBytes(32).toString('hex'), seq: 0 })) + '\n', hostEnv);
      if (!probe.sprite) { console.error(`The sprite style can't run on this host: ${probe.detail}`); return 2; }
    }

    const { target } = await openTextEditFixture({ helper, live, work, cleanups, receipt: opts.receipt, name: 'sleight-h5.txt',
      text: Array.from({ length: 40 }, (_, i) => `sleight ghost hand capture test, line ${i + 1}. The quick brown fox jumps over the lazy dog.`).join('\n') + '\n' });

    // Hand hosts this run started: killed on any stop, so no panel outlives the test.
    const hosts = new Set();
    cleanups.push(() => killHosts(hosts));
    const { openClient } = await import('../compat/client.mjs');
    const client = await openClient({ command: join(ROOT, 'plugins/sleight/bin/sleight-mcp'), approve: textEditApproval, timeoutMs: 60000, name: 'sleight-h5',
      env: { ...process.env, SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_SURFACES: 'computer', SLEIGHT_HAND: '0' } });
    cleanups.push(() => client.close());
    const acquired = await client.call('js', { code: ENGINE_ACQUIRE, timeout_ms: 60000 });
    if (acquired?.isError) throw new Error('the engine could not acquire TextEdit');

    const kept = new Set();
    const capture = async (source, { hostPid, label, rect }) => {
      const png = join(work, `${label}.png`), raw = join(work, `${label}.rgba`);
      const command = captureCommand(source, { target, rect, hostPid, png, raw });
      let size;
      if (command.tool === 'engine') {
        const image = engineImage(await client.call('js', { code: ENGINE_SHOT, timeout_ms: 60000 }));
        const file = join(work, `${label}.${image.extension}`); writeFileSync(file, image.bytes);
        size = await helper(['decode', file, raw]); rmSync(file, { force: true });
      } else if (command.tool === 'screencapture') {
        await execute('/usr/sbin/screencapture', command.args, { timeout: 15000 });
        size = await helper(['decode', png, raw]); rmSync(png, { force: true });
      } else size = await helper(command.args);
      const frame = readFrame(raw, size);
      if (Array.isArray(size.handWindows)) frame.handWindows = size.handWindows;
      const mode = label.split('-')[0], key = label.replace(/-\d+$/, '');
      // Region captures are never kept: they are screen regions, even if checked uncovered just before.
      if (opts.keepImages && ['hidden', 'visible'].includes(mode) && source !== 'region' && !kept.has(key)) {
        kept.add(key);
        await helper(['encode', raw, String(size.width), String(size.height), join(out, `${label}.png`)]);
      }
      rmSync(raw, { force: true });
      return frame;
    };
    const startHost = (mode, style) => startHandHost({ hostBin, capture: mode, style, env: hostEnv, hosts });
    const report = await runCaptureTest({
      windows: () => helper(['windows']), capture, startHost, sleep: ms => new Promise(r => setTimeout(r, ms)),
      hit: async (x, y) => grants.accessibility ? (await helper(['hit', String(x), String(y)])).pid || undefined : undefined,
      log: line => console.log(`  ${line}`),
    }, { target, samples: opts.samples, style: opts.style, character });
    report.grants = grants;
    writeFileSync(join(out, 'h5-report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(summary(report));
    console.log(`VC7 RESULT: capture ${opts.style} ${report.ok ? 'PASS' : 'NOT PASSED'}; hidden ${report.modes.hidden.verdict}, visible ${report.modes.visible.verdict} (${report.decision.capture})`);
    console.log(`Report: ${tilde(join(out, 'h5-report.json'))}`);
    return report.ok ? 0 : 1;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
