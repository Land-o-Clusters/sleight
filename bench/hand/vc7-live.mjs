// The live pieces VC7's checks share with H5 (h5-capture.mjs): building the capture helper and the hand host, the TextEdit
// fixture window, and starting a hand host in a capture mode and cursor style. Only the scripts' main() functions call
// these, after --owner-away and the live lock; the tests cover the pure parts.
import { execFile, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const TEXTEDIT = 'com.apple.TextEdit';
// As bench/real-fixture.mjs: without these TextEdit restores the owner's windows and iCloud "Untitled" documents.
export const DOCUMENT_LAUNCH = ['--args', '-ApplePersistenceIgnoreState', 'YES', '-NSShowAppCentricOpenPanelInsteadOfUntitledFile', 'NO',
  '-NSDocumentSaveNewDocumentsToCloud', 'NO'];
export const HOST_SOURCE = join(ROOT, 'plugins/sleight/lib/direct-browser/native/consent-host.swift');
export const HELPER_SOURCE = join(ROOT, 'bench/hand/capture.swift');
export const RECORDER_SOURCE = join(ROOT, 'bench/capture/recorder.swift');
const home = homedir();
export const tilde = text => String(text).split(home).join('~');
export const stamp = (date = new Date()) => date.toISOString().replace(/[:.]/g, '-');
export const logsRoot = () => join(home, 'Library/Logs/sleight');

/** The compiler command, as host.mjs builds the product's host (no -O), so costs match the shipped build. */
export function compileArgs(source, binary, moduleCache) {
  return ['swiftc', '-module-cache-path', moduleCache, source, '-o', binary];
}
export async function compileSwift(source, binary) {
  const { swiftModuleCache } = await import('../swift-cache.mjs');
  await execute('/usr/bin/xcrun', compileArgs(source, binary, swiftModuleCache()), { timeout: 300000 });
  return binary;
}

/** The capture helper as a function: its last JSON line, and a refusal throws (except for hit, which may miss). */
export function helperClient(binary, run = execute) {
  return async args => {
    const { stdout } = await run(binary, args, { timeout: 20000, maxBuffer: 8 << 20 }).catch(error => ({ stdout: error.stdout ?? '' }));
    const answer = JSON.parse(String(stdout).trim().split('\n').at(-1) || '{}');
    if (!answer.ok && args[0] !== 'hit') throw new Error(`capture helper ${args[0]}: ${answer.error ?? 'no answer'}`);
    return answer;
  };
}

/** The host's arguments for a capture mode and cursor style. No --menu or --consent: no menu bar item and no consent
 *  channel, as H5 ran it, so only the cursor's own drawing is measured. */
export function hostArgs({ capture = 'hidden', style = 'glove' } = {}) {
  if (!['hidden', 'visible'].includes(capture)) throw new Error(`capture must be hidden or visible, not ${capture}`);
  if (!['glove', 'ring', 'seam', 'sprite'].includes(style)) throw new Error(`unknown cursor style ${style}`);
  return ['--hand', `--capture=${capture}`, ...(style === 'glove' ? [] : [`--cursor-style=${style}`])];
}

/** Whether this host build draws the sprite style: VC4's --check-character reads one frame on stdin and draws nothing.
 *  A host without it exits 64 (usage). Returns { sprite, detail }. */
export async function spriteSupport(hostBin, frameLine, env) {
  return new Promise(done => {
    const child = spawn(hostBin, ['--check-character'], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...env } });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.stdout.on('data', c => { out += c; });
    child.once('error', error => { clearTimeout(timer); done({ sprite: false, detail: error.message }); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return done({ sprite: false, detail: `--check-character exited ${code} (a host without the sprite renderer exits 64)` });
      try {
        const answer = JSON.parse(out.trim().split('\n').at(-1));
        done(answer.loaded ? { sprite: true, detail: `loaded${answer.warnings?.length ? ` with warnings ${answer.warnings.join(', ')}` : ''}` }
          : { sprite: false, detail: `the host refused the synthetic character (${answer.reason})` });
      } catch { done({ sprite: false, detail: 'no answer from --check-character' }); }
    });
    child.stdin.end(frameLine);
  });
}

/** Starts a hand host; hosts (a Set) collects every child so a cleanup can kill what is left. */
export async function startHandHost({ hostBin, capture, style, env = {}, hosts }) {
  const child = spawn(hostBin, hostArgs({ capture, style }), { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, ...env } });
  hosts?.add(child);
  await new Promise((ok, no) => { child.once('spawn', ok); child.once('error', no); });
  const exited = new Promise(r => child.once('exit', (code, signal) => r({ code, signal })));
  child.stdin.on('error', () => {});
  return { pid: child.pid, child, exited, write: line => child.stdin.write(line),
    close: async () => { child.stdin.end(); const t = setTimeout(() => child.kill('SIGKILL'), 3000); const end = await exited; clearTimeout(t); return end; } };
}
export const killHosts = hosts => { for (const child of hosts) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };

/** Opens a throwaway document in a TextEdit this run starts (refusing when TextEdit already runs: it may be the owner's)
 *  and finds its one window. receipt, when given, gets { bundle, pid, startedAt } as soon as the pid is known, so a
 *  runner can quit it after a crash. Registers the quit in cleanups before the launch. */
export async function openTextEditFixture({ helper, live, work, cleanups, receipt, name = 'sleight-vc7.txt', text }) {
  if ((await live.appState(TEXTEDIT)).running) throw Object.assign(new Error('TextEdit is running and may be the owner\'s: quit it or run later'), { code: 'REFUSED', exitCode: 2 });
  const doc = join(work, name);
  writeFileSync(doc, text ?? Array.from({ length: 40 }, (_, i) => `sleight agent cursor check, line ${i + 1}. The quick brown fox jumps over the lazy dog.`).join('\n') + '\n');
  let launched;
  const startedAt = new Date().toISOString();
  cleanups.push(async () => {
    if (!launched) { const state = await live.appState(TEXTEDIT); if (state.pids?.length === 1) launched = { pid: state.pids[0] }; }
    if (launched) await quitFixture({ bundle: TEXTEDIT, pid: launched.pid, startedAfterMs: Date.parse(startedAt) }, { live });
  });
  await execute('/usr/bin/open', ['-g', '-a', 'TextEdit', doc, ...DOCUMENT_LAUNCH], { timeout: 15000 });
  for (let i = 0; i < 100 && !launched; i++) {
    const state = await live.appState(TEXTEDIT);
    if (state.pids?.length === 1) launched = { pid: state.pids[0] };
    else await new Promise(r => setTimeout(r, 100));
  }
  if (!launched) throw new Error('TextEdit did not start');
  if (receipt) writeFileSync(receipt, JSON.stringify({ bundle: TEXTEDIT, pid: launched.pid, startedAt }) + '\n');
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    const own = (await helper(['windows'])).windows.filter(w => w.pid === launched.pid && w.layer === 0 && w.bounds.width > 200);
    if (own.length === 1) target = { pid: launched.pid, id: own[0].id, bounds: own[0].bounds };
    else await new Promise(r => setTimeout(r, 200));
  }
  if (!target) throw new Error('TextEdit\'s window did not appear on this Space');
  return { target, doc, launched };
}

const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
/** A process's start time in ms from ps lstart, or undefined when it is gone. */
export async function processStartMs(pid, run = execute) {
  try {
    const { stdout } = await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' }, timeout: 5000 });
    const ms = Date.parse(String(stdout).trim());
    return Number.isFinite(ms) ? ms : undefined;
  } catch { return undefined; }
}

/** Quits a fixture app this run launched, escalating: quit (NSRunningApplication terminate, no Apple event), then SIGTERM,
 *  then SIGKILL. No System Events step: an Automation prompt would sit on screen until morning (sleight-arch, VC7HR2).
 *  Every signal goes to the launched pid only, and only while the app's one running process is that pid and, given
 *  startedAfterMs, it started no earlier than 5 s before it (a reused pid is never touched). Returns how it ended. */
export async function quitFixture({ bundle, pid, startedAfterMs }, { live, kill = (p, s) => process.kill(p, s), alive = isAlive,
  started = processStartMs, sleep = ms => new Promise(r => setTimeout(r, ms)), log = () => {} } = {}) {
  const ours = async () => {
    const state = await live.appState(bundle);
    if (!(state.running && state.pids?.length === 1 && state.pids[0] === pid)) return false;
    if (Number.isFinite(startedAfterMs)) { const at = await started(pid); if (!(at >= startedAfterMs - 5000)) return false; }
    return true;
  };
  if (!(await ours())) return 'gone';
  try { await live.quitApp(bundle, { pid }); return 'quit'; } catch (error) { log(`quit: ${error.message}`); }
  for (const [signal, waitMs] of [['SIGTERM', 5000], ['SIGKILL', 2000]]) {
    if (!(await ours())) return 'gone';
    try { kill(pid, signal); } catch {}
    for (let i = 0; i < waitMs / 100 && alive(pid); i++) await sleep(100);
    if (!alive(pid)) return signal === 'SIGTERM' ? 'terminated (SIGTERM)' : 'killed (SIGKILL)';
  }
  throw new Error(`${bundle} ${pid} survived SIGKILL`);
}

/** The region inside a window the cursor plays in: below the title bar, inset. */
export const playRect = (bounds, { titleBar = 60, inset = 24 } = {}) => ({ x: bounds.x + inset, y: bounds.y + titleBar,
  width: bounds.width - 2 * inset, height: bounds.height - titleBar - inset });

/** Common flags: --owner-away, --dry-run, --out DIR, --host PATH, --helper PATH, --receipt PATH. */
export function commonArgs(argv) {
  const value = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  for (const name of ['--out', '--host', '--helper', '--receipt']) {
    const v = value(name);
    if (argv.includes(name) && (!v || v.startsWith('--'))) throw new Error(`${name} needs a path`);
  }
  return { ownerAway: argv.includes('--owner-away'), dryRun: argv.includes('--dry-run'), out: value('--out'), host: value('--host'),
    helper: value('--helper'), receipt: value('--receipt'), value };
}

/** The live preconditions every VC7 check shares, before it takes the lock: { code, message } to stop, or undefined. */
export function liveRefusal({ ownerAway, platform = process.platform, hold = existsSync('/tmp/sleight-hold') }, what) {
  if (!ownerAway) return { code: 2, message: `${what} opens a TextEdit window and shows the cursor over it: pass --owner-away` };
  if (platform !== 'darwin') return { code: 2, message: 'macOS only' };
  if (hold) return { code: 3, message: '/tmp/sleight-hold exists (another project\'s timed window): run later' };
  return undefined;
}
