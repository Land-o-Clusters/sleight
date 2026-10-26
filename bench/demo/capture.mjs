#!/usr/bin/env node
// DM1. Import and --dry-run do not spawn, inspect the screen, read the hold/lock, or write anything.
// Run later, from a Terminal with Screen Recording already granted: node bench/demo/capture.mjs --owner-away.
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { encodePng } from '../hand/synthetic-character.mjs';
import { prepareCharacterImport, installCharacter, checkCharacter, checkBuiltinCharacter, builtinCharactersDirectory, characterCallout, resolveCharacterStates } from '../../plugins/sleight/lib/hand/character.mjs';
import { characterFrame } from '../../plugins/sleight/lib/hand/character-frame.mjs';
import { readHandConfig } from '../../plugins/sleight/lib/hand/settings.mjs';
import { writeHandSetting } from '../../plugins/sleight/lib/hand/command.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const LOGS = join(homedir(), 'Library/Logs/sleight');
const NIGHT = join(LOGS, 'demo-control');
const HOLD = '/tmp/sleight-hold', LOCK = '/tmp/sleight-live.lock';
const fail = code => Object.assign(Error(code), { code });
const digest = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const atomic = (p, data) => { writeFileSync(p + '.tmp', JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); renameSync(p + '.tmp', p); };
const safeText = s => String(s).replaceAll(homedir(), '~');
export const privateWork = () => realpathSync(mkdtempSync('/private/tmp/sleight-dm1-'));

export function shotPlan() {
  return [
    ['01-ring', 'Split Seam+ follows fixture-local AppKit clicks and a drag, with target wrap. No engine or model call.'],
    ['02-states', 'Split Seam+ thinking and waiting for OK, driven by fixture status frames.'],
    ['03-tsugi', 'Tsugi perched on the fixture, with click, done and hand-back reactions.'],
    ['03-kit', 'Kit perched on the fixture, with click, done and hand-back reactions.'],
    ['04-narration', 'An authored fixture turn sentence in the production narration bubble.'],
    ['05-picker', 'Picker choices shown by fixture frames; settings switch ring to Tsugi. Hardware picker clicks are not demonstrated.'],
    ['06-import', 'A synthetic Codex v2 pet, imported unchanged, with the production missing-animation callout in a fixture panel. No vendor art.'],
  ].map(([id, caption]) => ({ id, caption, seconds: 8, sourceSeconds: 16, speed: 2, deadlineMs: 120000 }));
}
export function recipe(id) {
  const click = atMs => ({ atMs, op: 'click', index: 0 });
  const status = (atMs, state) => ({ atMs, op: 'status', state });
  if (id === '01-ring') return [click(500), { atMs: 2800, op: 'click', index: 1 }, { atMs: 5500, op: 'drag' }, click(9000), status(12500, 'done')];
  if (id === '02-states') return [status(400, 'thinking'), status(3500, 'thinking'), status(6500, 'waiting'), status(13000, 'done')];
  if (id === '03-tsugi' || id === '03-kit') return [click(800), click(4000), status(8000, 'done'), status(12000, 'handback')];
  if (id === '04-narration') return [{ ...click(800), say: 'I will move the blue tile into the tray.' }, { atMs: 4800, op: 'drag', say: 'I will move the blue tile into the tray.' }, status(12000, 'done')];
  if (id === '05-picker') return [click(800), { atMs: 5000, op: 'select', character: 'tsugi' }, click(7500), status(12000, 'done')];
  if (id === '06-import') return [click(800), status(5000, 'waiting'), { atMs: 9500, op: 'drag' }, status(13000, 'handback')];
  throw Error('Unknown shot');
}
export function recordPlan({ out, fixture, target, panel, seconds }) {
  const ids = [fixture, target, panel];
  if (!out?.startsWith('/') || !ids.every(n => Number.isSafeInteger(n) && n > 0) || new Set(ids).size !== 3 || !(seconds >= 12 && seconds <= 26)) throw Error('Invalid fixture recording');
  return { version: 1, out, fps: 60, duration: seconds, codec: 'hevc', scale: 2,
    streams: [{ name: 'take', windows: ids, composite: true, crop: 'first', followOwners: true }] };
}
export const gifFits = bytes => Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 2_000_000;
export function encodingPlan(source, out) {
  const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1', '-ss', '1', '-t', '16', '-i', source, '-an'];
  return {
    mp4: [...common, '-vf', 'setpts=PTS/2,fps=30,scale=960:-2', '-t', '8', '-c:v', 'libx264', '-threads', '1', '-preset', 'fast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(out, 'demo.mp4')],
    gifs: [[720, 128], [640, 96], [560, 64], [480, 48]].map(([width, colors]) => [...common, '-vf',
      `setpts=PTS/2,fps=12,scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      '-t', '8', '-loop', '0', join(out, 'demo.gif')]),
  };
}
const EVIDENCE = ['demo.gif', 'demo.mp4', 'poster.png', 'sync.json', 'events.json'];
export function completedMarker(directory, meta) {
  return { ...meta, directory, status: 'complete', files: Object.fromEntries(EVIDENCE.map(name => [name, digest(join(directory, name))])) };
}
export function reusable(marker) {
  try {
    return marker?.status === 'complete' && marker.cleanup === true && marker.encoder === 'ffmpeg' && marker.seconds === 8 && marker.fps === 30 && marker.gifFps === 12 &&
      gifFits(marker.gifBytes) && marker.mp4Bytes > 0 && EVIDENCE.every(name => {
        const p = join(marker.directory, name), st = lstatSync(p);
        return st.isFile() && !st.isSymbolicLink() && st.size > 0 && (name !== 'demo.gif' || st.size === marker.gifBytes) &&
          (name !== 'demo.mp4' || st.size === marker.mp4Bytes) && digest(p) === marker.files[name];
      });
  } catch { return false; }
}
export function assertIdentity(a, b) { if (a.head !== b.head || a.root !== b.root) throw Error('Resume checkout differs; use --fresh'); }
export function assertBank(path, parent) {
  const st = lstatSync(path);
  if (!path.startsWith(parent + '/') || resolve(path) !== path || realpathSync(path) !== path || !st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o700) throw Error('Unsafe demo bank');
}
export function parseArgs(argv) {
  const opts = { night: NIGHT, dryRun: false, ownerAway: false, fresh: false }, seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]; if (seen.has(flag)) throw Error('Repeated option'); seen.add(flag);
    if (flag === '--night') { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('--night needs a directory'); opts.night = resolve(argv[++i]); }
    else if (flag === '--dry-run') opts.dryRun = true;
    else if (flag === '--owner-away') opts.ownerAway = true;
    else if (flag === '--fresh') opts.fresh = true;
    else throw Error(`Unknown option: ${flag}`);
  }
  return opts;
}

// Original geometric art only. The exact Codex used-cell mask, including v2's neutral pose, is retained.
export function makePet(base) {
  const source = join(base, 'source-pet'), root = join(base, 'characters');
  mkdirSync(source, { mode: 0o700 }); mkdirSync(root, { mode: 0o700 });
  const counts = [7, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8], w = 1536, h = 2288, pixels = new Uint8Array(w * h * 4);
  for (let row = 0; row < 11; row++) for (let col = 0; col < counts[row]; col++) {
    for (let y = 60; y < 148; y++) for (let x = 56; x < 136; x++) {
      const d = Math.hypot(x - 96, y - 104), px = col * 192 + x, py = row * 208 + y;
      if (d < 32 + col % 3 * 2) pixels.set([80 + row * 9, 95, 230, 255], (py * w + px) * 4);
    }
  }
  const sourceSheet = join(source, 'sheet.png'); writeFileSync(sourceSheet, encodePng(w, h, pixels), { mode: 0o600 });
  writeFileSync(join(source, 'pet.json'), JSON.stringify({ id: 'dm1-orb', displayName: 'Demo Orb', author: 'sleight demo fixture', license: 'CC0-1.0',
    description: 'Synthetic geometry, no vendor art.', spriteVersionNumber: 2, spritesheetPath: 'sheet.png' }), { mode: 0o600 });
  const before = digest(sourceSheet), prepared = prepareCharacterImport(source);
  installCharacter(prepared, { root });
  const pack = checkCharacter('dm1-orb', { root });
  if (digest(sourceSheet) !== before || digest(join(pack.folder, pack.manifest.sheet)) !== before) throw Error('Import changed source pixels');
  return { sourceSheet, root, pack, callout: characterCallout(prepared) };
}

export function dryRunPlan(opts) {
  return ['DM1 dry run: no children, files, screen inspection or hold/lock access.',
    'Live requires --owner-away, macOS, a clean pinned checkout and existing Screen Recording permission. Never requests permissions.',
    'Wait at most 30 min for the hold and 20 min for the live lock. Acquire the lock only when clear; never remove a foreign lock.',
    'caffeinate -dims holds the display awake. Every child has a deadline. Every exit collects owned children before releasing the lock.',
    'Compile host, fixture, capture helper and recorder serially in a private temporary directory. No app installation or owner settings.',
    '15 s input-free gap, then HID/pointer watch; unknown telemetry or owner input stops. A new hold closes fixtures and stops for resume.',
    'Fixture-local AppKit mouse dispatch invokes actual mouseDown/mouseDragged/mouseUp handlers; no posted system input, engine, model or Apple events.',
    'ScreenCaptureKit includes only the fixture and renderer applications pinned by their window ids, cropped to the outer fixture at 2x resolution, 60 fps.',
    'Record 18 s per take including 1 s preroll and tail; cut 16 s to 8 s at 2x. MP4 30 fps, GIF 12 fps, silent.',
    'Encoder: ffmpeg if already installed; no pure Node GIF encoder exists in this checkout. Missing ffmpeg refuses before windows. Never installs anything.',
    'GIF budget: 2 MB (2,000,000 bytes). Retry 720/640/560/480 px and 128/96/64/48 colors; oversize fails without a completed marker.',
    ...shotPlan().map(s => `${s.id}: ${s.seconds} s at 2x; ${s.caption} Deadline ${s.deadlineMs / 1000} s.`),
    `resume state: ${safeText(join(opts.night, 'dm1-state.json'))}; only intact hashes, complete encodes and collected children count as done.`,
    'Output: ~/Library/Logs/sleight/demo-<stamp>/, shots.json, contact-sheet.png, contact-sheet.html, per-shot GIF/MP4/poster/sync/events and captions.',
    'Partial takes are kept. Signals, owner return, hold, deadline and cleanup failure never produce completion markers. Cleanup failure retains the lock.',
  ];
}

// Only directly spawned children, no pid/name sweeps or detached process groups. Pipe EOF is the fixture/host shutdown.
export class Children {
  constructor(env, signal) { this.env = env; this.signal = signal; this.live = new Set(); this.exits = new Map(); }
  start(command, args, options = {}) {
    this.signal?.throwIfAborted();
    const child = spawn(command, args, { cwd: ROOT, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], ...options });
    this.live.add(child); child.stdin.on('error', () => {});
    let buffer = '', stderr = '', stdout = ''; const rows = [], listeners = new Set();
    const closed = new Promise(done => {
      child.once('error', e => { stderr += e.message; });
      child.once('close', (code, signal) => { this.live.delete(child); done({ code, signal, stdout, stderr }); });
    });
    this.exits.set(child, closed); closed.then(() => this.exits.delete(child));
    child.stdout.on('data', b => {
      stdout += b; buffer += b;
      if (stdout.length > 8 << 20) { child.kill('SIGTERM'); return; }
      while (buffer.includes('\n')) {
        const i = buffer.indexOf('\n'), line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        try { const row = JSON.parse(line); rows.push(row); for (const f of listeners) f(row); } catch {}
      }
    });
    child.stderr.on('data', b => { if (stderr.length < 65536) stderr += b; });
    const channel = { child, rows, closed, send: row => {
      this.signal?.throwIfAborted(); if (child.exitCode !== null || child.signalCode) throw Error(`Child exited: ${stderr}`);
      child.stdin.write(JSON.stringify(row) + '\n');
    }, wait: (predicate, ms = 5000) => {
      this.signal?.throwIfAborted(); const found = rows.find(predicate); if (found) return Promise.resolve(found);
      return new Promise((yes, no) => {
        const end = () => { clearTimeout(timer); listeners.delete(check); this.signal?.removeEventListener('abort', abort); };
        const check = row => { if (predicate(row)) { end(); yes(row); } };
        const abort = () => { end(); no(this.signal.reason); };
        const timer = setTimeout(() => { end(); no(Error('Child response deadline')); }, ms);
        listeners.add(check); this.signal?.addEventListener('abort', abort, { once: true });
        closed.then(r => { end(); no(Error(`Child closed ${r.code}: ${r.stderr}`)); });
      });
    }, close: async () => {
      child.stdin.end();
      const soft = setTimeout(() => child.kill('SIGTERM'), 2000), hard = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { const result = await bounded(closed, 8000); if (result.signal === 'SIGKILL') throw fail('CLEANUP'); return result; }
      finally { clearTimeout(soft); clearTimeout(hard); }
    } };
    const abort = () => { child.stdin.end(); child.kill('SIGINT'); };
    this.signal?.addEventListener('abort', abort, { once: true }); closed.then(() => this.signal?.removeEventListener('abort', abort));
    channel.onRow = f => listeners.add(f);
    return channel;
  }
  async run(command, args, { timeoutMs = 30000, input, ...options } = {}) {
    const c = this.start(command, args, options);
    c.child.stdin.end(input);
    try {
      const result = await bounded(c.closed, timeoutMs, this.signal);
      if (result.code !== 0) throw Error(`${basename(command)} exit ${result.code}: ${result.stderr || result.stdout}`);
      return result.stdout;
    } finally { await c.close(); }
  }
  async close() {
    const results = await Promise.allSettled([...this.live].map(async child => {
      child.stdin.end(); child.kill('SIGINT');
      const hard = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { const result = await bounded(this.exits.get(child), 8000); if (result?.signal === 'SIGKILL') throw fail('CLEANUP'); }
      finally { clearTimeout(hard); }
    }));
    if (this.live.size || results.some(r => r.status === 'rejected')) throw fail('CLEANUP');
  }
}
export async function bounded(promise, ms, signal) {
  signal?.throwIfAborted(); let timer, abort;
  try { return await Promise.race([promise, new Promise((_, no) => {
    timer = setTimeout(() => no(fail('DEADLINE')), ms);
    abort = () => no(signal.reason); signal?.addEventListener('abort', abort, { once: true });
  })]); } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
export async function closeScene(channels) {
  const results = await Promise.allSettled(channels.map(c => c.close()));
  if (results.some(r => r.status === 'rejected')) throw fail('CLEANUP');
  const bad = results.find(r => r.value.code !== 0);
  if (bad) throw Error(`Native scene exited ${bad.value.code ?? bad.value.signal}`);
}
export async function waitClear({ exists = existsSync, now = Date.now, wait = sleep, signal } = {}) {
  let holdSince, lockSince;
  while (true) {
    signal?.throwIfAborted(); const held = exists(HOLD), locked = exists(LOCK);
    if (!held && !locked) return;
    if (held) holdSince ??= now(); else holdSince = undefined;
    if (locked) lockSince ??= now(); else lockSince = undefined;
    if (held && now() - holdSince >= 1800000 || locked && now() - lockSince >= 1200000) throw fail('BUSY');
    await wait(1000, undefined, { signal });
  }
}
export function inputWatch(quietSince) {
  let rest;
  return row => {
    if (![row?.t, row?.idle, row?.x, row?.y].every(Number.isFinite) || row.idle < 0) return 'TELEMETRY';
    rest ??= [row.x, row.y];
    if (Math.abs(rest[0] - row.x) > 1 || Math.abs(rest[1] - row.y) > 1 || row.idle * 1000 + 1000 < row.t - quietSince) return 'OWNER';
  };
}

export async function encode(children, dir) {
  const commands = encodingPlan(join(dir, 'take.mov'), dir);
  await children.run('ffmpeg', commands.mp4, { timeoutMs: 45000 });
  let gifBytes = 0;
  for (const args of commands.gifs) {
    await children.run('ffmpeg', args, { timeoutMs: 45000 }); gifBytes = statSync(join(dir, 'demo.gif')).size;
    if (gifFits(gifBytes)) break;
  }
  if (!gifFits(gifBytes)) throw Error(`GIF exceeds 2 MB: ${gifBytes} bytes`);
  await children.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', '-i', join(dir, 'demo.mp4'), '-ss', '4', '-frames:v', '1', '-threads', '1', join(dir, 'poster.png')]);
  const decoded = await children.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-progress', 'pipe:1', '-nostats', '-i', join(dir, 'demo.mp4'), '-an', '-f', 'null', '-']);
  const frames = Number([...decoded.matchAll(/^frame=(\d+)$/gm)].at(-1)?.[1]), seconds = Number([...decoded.matchAll(/^out_time_us=(\d+)$/gm)].at(-1)?.[1]) / 1e6;
  if (frames !== 240 || Math.abs(seconds - 8) > 0.05) throw Error(`Unexpected MP4 timing: ${frames} frames, ${seconds} seconds`);
  return { encoder: 'ffmpeg', seconds: 8, measuredSeconds: seconds, frames, fps: 30, gifFps: 12, gifBytes, mp4Bytes: statSync(join(dir, 'demo.mp4')).size };
}

async function captureShot(shot, directory, { bin, children, work, signal, abort }) {
  const events = [], nonce = randomBytes(32).toString('hex'); let seq = 0;
  const pet = shot.id === '06-import' ? makePet(work) : undefined;
  const env = { ...children.env, SLEIGHT_CURSOR_TEST: '1', SLEIGHT_CURSOR_CHARACTERS_ROOT: pet?.root ?? work,
    SLEIGHT_BUILTIN_CHARACTERS: builtinCharactersDirectory() };
  const fixture = children.start(join(bin, 'fixture'), ['--serve'], { env });
  const f = await fixture.wait(r => r.event === 'ready');
  const host = children.start(join(bin, 'consent-host'), ['--hand', '--capture=visible', '--cursor-style=ring'], { env });
  const request = async row => {
    const token = randomBytes(16).toString('hex'); fixture.send({ ...row, token });
    const reply = await fixture.wait(r => r.token === token); if (reply.error) throw Error(reply.error); return reply;
  };
  const send = row => { host.send(row); events.push({ t: Date.now(), frame: row }); };
  const settingPath = join(work, 'hand.json');
  const select = async (id, perch = true) => {
    writeHandSetting({ enabled: true, capture: 'visible', style: id ? 'sprite' : 'ring', ...id ? { character: id } : {}, perch, lines: 'off' }, { path: settingPath });
    const setting = readHandConfig(settingPath); if (setting.state !== 'on') throw Error('Fixture settings refused');
    send({ hand: 'picker', nonce, op: 'style', style: setting.style });
    if (id) {
      const pack = pet && id === pet.pack.manifest.id ? pet.pack : checkBuiltinCharacter(id);
      send(characterFrame(pack, { nonce, seq: seq++, resolve: resolveCharacterStates, perch }));
      const loaded = await host.wait(r => r.hand === 'character' && r.id === id);
      if (!loaded.loaded) throw Error(`Character refused: ${JSON.stringify(loaded)}`);
    }
    send({ hand: 'picker', nonce, op: 'options', perch, lines: false });
  };
  let lastTelemetry = Date.now(), recording = false, currentAction;
  const detect = inputWatch(Date.now());
  fixture.onRow(row => {
    if (row.event === 'action' && currentAction) {
      send({ nonce, seq: seq++, pid: f.pid, windowId: f.target, hand: 'act', kind: row.kind, at: row.at,
        path: row.path, rect: currentAction.rect, delayMs: 0, beats: 1, ...currentAction.say ? { say: currentAction.say } : {} });
      return;
    }
    if (row.event !== 'input') return;
    lastTelemetry = Date.now();
    if (![row.idle, row.x, row.y].every(Number.isFinite)) { abort('TELEMETRY'); return; }
    // Local AppKit dispatch posts no HID input and never moves the pointer, so every physical input is the owner.
    if (recording) { const reason = detect(row); if (reason) abort(reason); }
  });
  const telemetry = setInterval(() => { if (Date.now() - lastTelemetry > 3500) abort('TELEMETRY'); }, 500);
  try {
    await request({ op: 'caption', text: shot.caption + '  |  2x', notice: pet?.callout ?? (shot.id === '05-picker' ? 'Fixture picker preview\nRing     Tsugi     Kit\nSelection uses private hand.json settings, not a hardware picker click.' : '') });
    // No input is generated by any harness step. Fresh HID telemetry covers both quiet gap and the take.
    const idleRow = await fixture.wait(r => r.event === 'input');
    if (!Number.isFinite(idleRow.idle) || idleRow.idle < 15) throw fail('OWNER');
    recording = true;
    const character = shot.id === '03-tsugi' ? 'tsugi' : shot.id === '03-kit' ? 'kit' : pet ? pet.pack.manifest.id : undefined;
    await select(character, !pet);
    if (shot.id === '04-narration') send({ hand: 'menu', nonce, enabled: true, capture: 'visible', version: '1.5.0', narration: 'bubbles' });
    const at = [f.frame[0] + 180, f.frame[1] + 120];
    const base = () => ({ nonce, seq: seq++, pid: f.pid, windowId: f.target, at });
    // Waiting parks the panel long enough for a cold ScreenCaptureKit start; an aim would fade after 1.2 s.
    send({ ...base(), hand: 'status', state: 'waiting' });
    let panel;
    for (let i = 0; i < 50 && !panel; i++) {
      signal.throwIfAborted();
      const snapshot = await request({ op: 'panels', host: host.child.pid });
      panel = snapshot.panels?.find(w => w.id > 0); if (!panel) await sleep(100, undefined, { signal });
    }
    if (!panel) throw Error('Renderer panel never appeared');
    const plan = recordPlan({ out: directory, fixture: f.fixture, target: f.target, panel: panel.id, seconds: shot.sourceSeconds + 2 });
    const planPath = join(directory, 'capture-plan.json'); atomic(planPath, plan);
    const recorder = children.start(join(bin, 'recorder'), ['record', planPath]);
    await recorder.wait(r => r.event === 'ready', 10000);
    await sleep(1000, undefined, { signal }); const began = Date.now();
    for (const event of recipe(shot.id)) {
      await sleep(Math.max(0, event.atMs - (Date.now() - began)), undefined, { signal });
      if (event.op === 'select') {
        await select(event.character); await request({ op: 'caption', text: shot.caption + '  |  2x', notice: 'Fixture picker preview\nRing     [Tsugi selected]     Kit\nPrivate settings applied. Hardware selection not shown.' }); continue;
      }
      if (event.op === 'status') { send({ ...base(), hand: 'status', state: event.state, ...event.state === 'done' ? { ok: true } : {} }); continue; }
      const aimed = await request({ op: 'geometry', index: event.op === 'drag' ? 2 : event.index });
      const target = aimed.at, rect = aimed.rect;
      send({ ...base(), hand: 'aim', kind: event.op === 'drag' ? 'drag' : 'click', at: target, rect, ...event.say ? { say: event.say } : {} });
      await sleep(350, undefined, { signal });
      currentAction = { rect, say: event.say };
      const result = await request(event.op === 'drag' ? { op: 'drag', to: [440, 120] } : { op: 'click', index: event.index });
      currentAction = undefined;
      events.push({ t: Date.now(), input: result });
      if (event.op === 'click' && result.clicks < 1 || event.op === 'drag' && result.drags < 1) throw Error('Fixture input not acknowledged');
    }
    const recorded = await bounded(recorder.closed, 30000, signal);
    if (recorded.code !== 0) throw Error(`Recorder failed: ${recorded.stderr}`);
    const sync = JSON.parse(readFileSync(join(directory, 'sync.json'))), stream = sync.streams?.[0];
    if (sync.stoppedBy !== 'duration' || stream?.writer !== 'completed' || stream.error || !(stream.frames > 30) || stream.scale !== 2 || !(sync.stopHostTime - stream.firstFrameHostTime >= 17)) throw Error('Incomplete recording');
    atomic(join(directory, 'events.json'), events);
    writeFileSync(join(directory, 'caption.txt'), shot.caption + ' Playback: 2x.\n', { mode: 0o600 });
    return { seconds: sync.stopHostTime - stream.firstFrameHostTime, frames: stream.frames, droppedFrames: stream.droppedFrames,
      fps: 60, scale: stream.scale, bytes: statSync(join(directory, 'take.mov')).size };
  } finally { clearInterval(telemetry); await closeScene([host, fixture]); }
}

async function contactSheet(children, state) {
  const shots = shotPlan().map(s => ({ ...s, ...state.markers[s.id] }));
  atomic(join(state.out, 'shots.json'), { version: 1, head: state.head, encoder: 'ffmpeg', shots });
  const complete = shots.filter(reusable);
  if (!complete.length) return;
  const escape = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  writeFileSync(join(state.out, 'contact-sheet.html'), '<!doctype html><meta charset="utf-8"><title>sleight demo takes</title><style>body{background:#141a26;color:#eee;font:16px system-ui;margin:24px}main{display:grid;grid-template-columns:repeat(2,1fr);gap:24px}img{width:100%}p{max-width:70ch}</style><h1>sleight demo takes</h1><p>Fixture demonstrations, 2x playback. Review before publication.</p><main>' +
    complete.map(s => `<article><a href="${escape(basename(s.directory))}/demo.mp4"><img src="${escape(basename(s.directory))}/poster.png"></a><p>${escape(s.id)}: ${escape(s.caption)} GIF ${s.gifBytes} bytes; MP4 ${s.mp4Bytes} bytes; 8 s; 12/30 fps.</p></article>`).join('') + '</main>', { mode: 0o600 });
  const args = complete.flatMap(s => ['-i', join(s.directory, 'poster.png')]);
  const filters = complete.map((_, i) => `[${i}:v]scale=400:300:force_original_aspect_ratio=decrease,pad=400:300:(ow-iw)/2:(oh-ih)/2:color=0x141a26[v${i}]`);
  const positions = complete.map((_, i) => `${i % 2 * 400}_${Math.floor(i / 2) * 300}`).join('|');
  filters.push(complete.map((_, i) => `[v${i}]`).join('') + `xstack=inputs=${complete.length}:layout=${positions}:fill=0x141a26[out]`);
  await children.run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', '-filter_complex_threads', '1', ...args, '-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', '-threads', '1', join(state.out, 'contact-sheet.png')]);
}

export async function main(argv) {
  let opts; try { opts = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (opts.dryRun) { console.log(dryRunPlan(opts).join('\n')); return 0; }
  if (!opts.ownerAway) { console.error('Live capture requires --owner-away.'); return 2; }
  if (process.platform !== 'darwin') { console.error('macOS only.'); return 2; }
  if (!opts.night.startsWith(LOGS + '/')) { console.error('Live resume control must be under ~/Library/Logs/sleight/.'); return 2; }
  const controller = new AbortController(), signal = controller.signal;
  const abort = code => { if (!signal.aborted) controller.abort(fail(code)); };
  const signals = Object.fromEntries(['SIGINT', 'SIGTERM', 'SIGHUP'].map(s => [s, () => abort(s)]));
  for (const [s, f] of Object.entries(signals)) process.on(s, f);
  const work = privateWork();
  const cfg = mkdtempSync('/tmp/lane-claude-');
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('SLEIGHT_'))),
    CLAUDE_CONFIG_DIR: cfg, TMPDIR: work, DISABLE_AUTOUPDATER: '1', SLEIGHT_NO_HUB: '1', SLEIGHT_REMOTE_APPROVALS: '0' };
  const children = new Children(env, signal); let release, state, stopped, clean = false, holdPoll, telemetryPoll;
  try {
    const awake = children.start('/usr/bin/caffeinate', ['-dims', '-w', String(process.pid)]);
    awake.closed.then(() => { if (!clean) abort('TELEMETRY'); });
    await children.run('ffmpeg', ['-version'], { timeoutMs: 5000 });
    const git = (...args) => execFileSync('/usr/bin/git', ['-C', ROOT, ...args], { encoding: 'utf8', timeout: 5000 }).trim();
    const identity = { root: ROOT, head: git('rev-parse', 'HEAD') };
    if (git('status', '--porcelain', '--untracked-files=normal')) throw Error('Commit all checkout changes before a live launch');
    mkdirSync(opts.night, { recursive: true, mode: 0o700 }); assertBank(opts.night, realpathSync(LOGS));
    const statePath = join(opts.night, 'dm1-state.json');
    if (!opts.fresh && existsSync(statePath)) {
      const st = lstatSync(statePath); if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid()) throw Error('Unsafe state file');
      state = JSON.parse(readFileSync(statePath)); assertIdentity(state, identity); assertBank(state.out, realpathSync(LOGS));
      if (!basename(state.out).startsWith('demo-')) throw Error('Not a demo bank');
    } else {
      mkdirSync(LOGS, { recursive: true });
      const out = join(realpathSync(LOGS), 'demo-' + new Date().toISOString().replace(/[:.]/g, '-'));
      mkdirSync(out, { mode: 0o700 }); state = { ...identity, out, markers: {}, startedAt: new Date().toISOString() }; atomic(statePath, state);
    }
    await waitClear({ signal });
    const { acquireLiveLock } = await import('../live-lock.mjs'); release = await acquireLiveLock(LOCK, { wait: false, signal });
    // A hold between the clear check and mkdir must stop before any window can appear.
    if (existsSync(HOLD)) throw fail('HOLD');
    holdPoll = setInterval(() => { if (existsSync(HOLD)) abort('HOLD'); }, 250);
    const bin = join(work, 'bin'); mkdirSync(bin, { mode: 0o700 });
    for (const [source, name] of [['plugins/sleight/lib/direct-browser/native/consent-host.swift', 'consent-host'], ['bench/demo/fixture.swift', 'fixture'], ['bench/hand/capture.swift', 'helper'], ['bench/capture/recorder.swift', 'recorder']]) {
      await children.run('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(work, 'modules'), join(ROOT, source), '-o', join(bin, name)], { timeoutMs: 300000 });
    }
    const grants = JSON.parse(await children.run(join(bin, 'helper'), ['preflight']));
    if (!grants.screenRecording) throw Error('Existing Screen Recording grant required; no prompt requested');
    // A real input-free gap, before the first window, read by the compiled read-only helper.
    const detect = inputWatch(Date.now()), gap = children.start(join(bin, 'helper'), ['watch-input', '1000', '16']);
    const samples = [];
    gap.onRow(row => { if (!row.done) { samples.push(row); const reason = detect(row); if (reason) abort(reason); } });
    const watched = await bounded(gap.closed, 20000, signal);
    if (watched.code !== 0 || samples.length < 15 || samples.at(-1).idle < 15) throw fail('TELEMETRY');
    const monitor = children.start(join(bin, 'helper'), ['watch-input', '1000', '14400']);
    let lastTelemetry = Date.now(); const observe = inputWatch(Date.now());
    monitor.onRow(row => { lastTelemetry = Date.now(); const reason = observe(row); if (reason) abort(reason); });
    monitor.closed.then(() => { if (!clean) abort('TELEMETRY'); });
    telemetryPoll = setInterval(() => { if (Date.now() - lastTelemetry > 3500) abort('TELEMETRY'); }, 500);
    for (const shot of shotPlan()) {
      signal.throwIfAborted();
      if (reusable(state.markers[shot.id])) continue;
      const directory = join(state.out, shot.id + '-' + randomBytes(4).toString('hex')); mkdirSync(directory, { mode: 0o700 });
      const attemptWork = mkdtempSync(join(work, 'shot-'));
      const phase = new AbortController(), forward = () => phase.abort(signal.reason);
      signal.addEventListener('abort', forward, { once: true });
      const timer = setTimeout(() => phase.abort(fail('DEADLINE')), shot.deadlineMs);
      const shotChildren = new Children(env, phase.signal);
      try {
        const capture = await captureShot(shot, directory, { bin, children: shotChildren, work: attemptWork, signal: phase.signal, abort });
        await shotChildren.close();
        const meta = await encode(shotChildren, directory);
        await shotChildren.close(); phase.signal.throwIfAborted();
        state.markers[shot.id] = completedMarker(directory, { id: shot.id, caption: shot.caption, capture, ...meta, cleanup: true });
        if (!reusable(state.markers[shot.id])) throw Error('Completed marker failed validation');
      } catch (e) {
        state.markers[shot.id] = { status: 'failed', directory, reason: safeText(e.code ?? e.message) }; throw e;
      } finally {
        clearTimeout(timer); signal.removeEventListener('abort', forward);
        try { await shotChildren.close(); } catch { throw fail('CLEANUP'); }
        atomic(statePath, state); rmSync(attemptWork, { recursive: true, force: true });
      }
    }
    await contactSheet(children, state);
    console.log(`DM1: ${shotPlan().filter(s => reusable(state.markers[s.id])).length}/7 clips encoded with ffmpeg in ${safeText(state.out)}`);
  } catch (e) { stopped = e.code === 'CLEANUP' ? 'CLEANUP' : signal.reason?.code ?? e.code ?? e.message; console.error(`DM1 stopped: ${safeText(stopped)}`); }
  finally {
    clearInterval(holdPoll); clearInterval(telemetryPoll); clean = true;
    try { await children.close(); } catch { stopped = 'CLEANUP'; }
    if (state) {
      // Do not launch an encoder here: final cleanup also runs on signals and owner return.
      atomic(join(state.out, 'shots.json'), { version: 1, head: state.head, stopped: stopped ?? null, encoder: 'ffmpeg', shots: shotPlan().map(s => ({ ...s, ...state.markers[s.id] })) });
    }
    if (stopped !== 'CLEANUP') { if (release) await release(); rmSync(work, { recursive: true, force: true }); rmSync(cfg, { recursive: true, force: true }); }
    else console.error(`Cleanup unproved; lock retained. Private work: ${work}`);
    for (const [s, f] of Object.entries(signals)) process.removeListener(s, f);
  }
  return stopped ? ({ OWNER: 4, HOLD: 5, BUSY: 5, TELEMETRY: 6, SIGINT: 130, SIGTERM: 143, SIGHUP: 129 })[stopped] ?? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
