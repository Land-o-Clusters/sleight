#!/usr/bin/env node
// C10, the companion to VC7 for the combined 1.5.0 release. Import and --dry-run have no live side effects.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { acquireLiveLock } from '../live-lock.mjs';
import { createInputDetector } from './owner-watch.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const NIGHT = join(homedir(), 'Projects/sleight-wt/ledger/vc/night');
export const steps = Object.freeze([
  { id: 'pause', estimateSeconds: 20, what: 'pause before next action, resume, host respawn; hardware menu and character clicks require a person' },
  { id: 'narration', estimateSeconds: 15, what: 'sentence before tool row, late prose excluded, fake card redaction, bubble above label, clear hides all' },
  { id: 'voice', estimateSeconds: 20, what: 'off by default; opt-in one system voice line; pause cancellation and in-flight speech limit' },
  { id: 'picker', estimateSeconds: 15, what: 'built-in catalog if C8 is present; character load and next frame; hardware selection remains unverified' },
  { id: 'perch', estimateSeconds: 30, what: 'real fixture seat, cover and uncover, 80 pt traffic-light margin and measured cluster, two displays if present; 600 s covered stop is dump-only unless a test flag exists' },
  { id: 'lines', estimateSeconds: 35, what: 'start, first-click, error, done; important 3 s and ordinary 8 s spacing with boundary probes' },
  { id: 'replay', estimateSeconds: 10, what: 'off by default; record filtered fixture events and screenshots, replay every position; withheld content never enters the recording' },
]);
const cleanText = s => String(s).replaceAll(homedir(), '~').replace(/[|\r\n]/g, ' ');
const jsonWrite = (path, value) => {
  const tmp = path + '.' + randomBytes(8).toString('hex');
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(tmp, path);
};
export function parseArgs(argv) {
  const result = { night: NIGHT, ownerAway: false, dryRun: false, fresh: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--night') { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('--night needs a directory'); result.night = resolve(argv[++i]); }
    else if (flag === '--owner-away') result.ownerAway = true;
    else if (flag === '--dry-run') result.dryRun = true;
    else if (flag === '--fresh') result.fresh = true;
    else throw Error(`Unknown option: ${flag}`);
  }
  return result;
}
export function dryRunPlan({ root = ROOT, night = NIGHT } = {}) {
  return [
    'C10: combined 1.5.0 release, companion to VC7 (dry run, opens nothing).',
    'Live requires --owner-away, macOS, a clean pinned checkout, existing Screen Recording permission and 15 s without input.',
    'No model calls, Apple events, posted input, owner apps, personal characters, settings or microphone recording.',
    'Refuse a hold or busy live lock; stop on any owner input, a new hold, unknown input telemetry or a signal.',
    `Resume: ${join(night, 'c10-state.json')}; passed steps reuse only intact hashed evidence on the same HEAD.`,
    'Identity: /usr/bin/git rev-parse HEAD; /usr/bin/git status --porcelain --untracked-files=normal (separate subprocesses).',
    `Build serial: /usr/bin/xcrun swiftc -module-cache-path <private-temp>/modules ${join(root, 'plugins/sleight/lib/direct-browser/native/consent-host.swift')} -o <out>/bin/consent-host`,
    `Build serial: /usr/bin/xcrun swiftc -module-cache-path <private-temp>/modules ${join(root, 'bench/hand/c10-fixture.swift')} -o <out>/bin/c10-fixture`,
    '<out>/bin/c10-fixture --preflight (no window, no prompt); then --serve <attempt-directory> <out>/bin/consent-host',
    '<out>/bin/consent-host --hand --capture=visible --cursor-style=sprite --menu (fixture frames only)',
    ...steps.map((s, i) => `${i + 1}. ${s.id}: ${s.what} (${s.estimateSeconds} s estimate, screenshot paths in result.json)`),
    'pause: pause-ack restore true, paused status, EOF, new host, restore true, paused status, restore false. No synthesized clicks.',
    'narration: host --ring-plan-dump --cursor-style=ring --clip=<fixture x,y,w,h>, 3 traces (sentence, redaction, clear). Live menu bubbles, 2 act frames, clear and clear-ready.',
    'voice: host --narration-voices; host --narration-selftest < cancellation fixture. Live menu voice, one act, pause restore and paused status; close host after capture.',
    'picker: host --cursor-menu-dump < catalog; parent catalog frame, ring style and aim, sprite style and character load, first aim after the load acknowledgment.',
    'perch: host --perch-dump < real geometry and dumpDecode; --perch-dump --seed=1 < covered trace, dumpClock 604. Fixture cover on, cover off, display index 1 if present.',
    'lines: live frames at 0, 8, 11, 14 and 17 s; host --perch-dump --seed=1 for the 5 boundary and moment traces.',
    'replay: production in-process relay and recorder with 4 authored replies (1 delivered, 3 withheld); /usr/bin/sips -Z 960 -s format jpeg -s formatOptions 55 <temp-source> --out <temp-image>.',
    'replay viewer: fixture replay command loads replay.html into its own WebKit view, scrubs every record and reports positions and withheld text count.',
    'Voice and replay are off by default. Only the isolated check enables them. Voice playback has no audible-start telemetry; that observation stays unverified.',
    'OCR checks narration and lines on owned fixture captures; replay.html loads in the fixture WebKit view and scrubs every position.',
    'Capture: ScreenCaptureKit includes only the fixture, its cover and this run\'s host, cropped around the fixture. Never a display screenshot.',
    'Reports: result.json and screenshots per attempt, host-dump.jsonl, replay.html; summary.md with numeric pass/fail/skip counts.',
    'EOF closes owned windows and hosts. Wait for child exits before releasing the lock. Cleanup failure retains the lock.',
    `Launch later: CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node ${join(root, 'bench/hand/c10-night.mjs')} --night ${night} --owner-away`,
  ];
}
export function totals(results) {
  const n = { pass: 0, fail: 0, skip: 0, requiredSkipped: 0 };
  for (const r of results) for (const c of r.checks ?? []) { n[c.status]++; if (c.status === 'skip' && c.required) n.requiredSkipped++; }
  return n;
}
export function validateResult(result, directory) {
  if (!steps.some(s => s.id === result.id) || !Array.isArray(result.checks) || !result.checks.length) throw Error('Invalid result');
  for (const c of result.checks) {
    if (!c.name || !['pass', 'fail', 'skip'].includes(c.status) || !c.numbers || !Object.keys(c.numbers).length ||
        !Object.values(c.numbers).every(Number.isFinite)) throw Error('Invalid numeric result');
    if (c.status === 'skip') { if (!c.reason) throw Error('Skipped check needs a reason'); if (c.screenshot === null) continue; }
    if (typeof c.screenshot !== 'string' || basename(c.screenshot) !== c.screenshot) throw Error('Invalid screenshot path');
    const path = join(directory, c.screenshot), st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink() || st.size < 45) throw Error('Invalid PNG evidence');
    const b = readFileSync(path);
    if (b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || b.toString('ascii', 12, 16) !== 'IHDR' || !b.readUInt32BE(16) || !b.readUInt32BE(20)) throw Error('Invalid PNG evidence');
  }
}
export function evidenceDigest(directory) {
  const hash = createHash('sha256');
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name), st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink()) throw Error('Evidence must contain ordinary files only');
    hash.update(name + '\0').update(readFileSync(path));
  }
  return hash.digest('hex');
}
export function reusable(marker) {
  try { return marker?.status === 'pass' && marker.digest === evidenceDigest(marker.directory); } catch { return false; }
}
export function assertIdentity(state, identity) {
  if (state.root !== identity.root || state.head !== identity.head) throw Error('Resume checkout differs; use --fresh for a new bank');
}
export function assertBank(path, parent) {
  const st = lstatSync(path);
  if (!path.startsWith(parent + '/') || resolve(path) !== path || realpathSync(path) !== path ||
      st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o700) throw Error('Unsafe evidence bank');
}
export function summaryMarkdown(state, stopped) {
  const results = Object.values(state.markers), n = totals(results);
  return ['# C10 combined release live checks', '', `Checkout ${cleanText(state.root)}, commit ${state.head}. Started ${state.startedAt}.`,
    `${n.pass} passed, ${n.fail} failed, ${n.skip} skipped, ${n.requiredSkipped} required checks unverified.`,
    ...(stopped ? [`Stopped: ${cleanText(stopped)}.`] : []), '',
    '| Step | Check | Result | Numbers | Screenshot | Limit or reason |', '| --- | --- | --- | --- | --- | --- |',
    ...steps.flatMap(s => {
      const m = state.markers[s.id];
      if (!m?.checks) return [`| ${s.id} | ${m?.status ?? 'not run'} | incomplete | attempts=${m?.attempts ?? 0} | none | ${cleanText(m?.reason ?? '')} |`];
      return m.checks.map(c => `| ${s.id} | ${cleanText(c.name)} | ${c.status} | ${Object.entries(c.numbers).map(([k,v]) => `${k}=${v}`).join(', ')} | ${c.screenshot ? cleanText(join(m.directory, c.screenshot)) : 'none (not captured)'} | ${cleanText(c.reason ?? '')} |`);
    }), '', 'A dump proves a runtime plan. A screenshot proves captured pixels. Neither proves a physical click or audible speech.',
    'Required skipped checks keep the run incomplete. Failed, skipped and interrupted steps retry on the next launch. Passed evidence is hashed.', ''].join('\n');
}
export async function executeSteps(plan, state, { run, save, canReuse = reusable }) {
  for (const step of plan) {
    if (canReuse(state.markers[step.id])) continue;
    const attempts = (state.markers[step.id]?.attempts ?? 0) + 1;
    try {
      const r = await run(step, attempts), n = totals([r]);
      state.markers[step.id] = { ...r, attempts, status: n.fail ? 'fail' : n.requiredSkipped ? 'incomplete' : 'pass' };
    } catch (error) {
      state.markers[step.id] = { status: 'interrupted', attempts, reason: error.code ?? error.message };
      save();
      if (['OWNER', 'HOLD', 'TELEMETRY', 'SIGNAL', 'CLEANUP'].includes(error.code)) return { stopped: error.code };
      continue;
    }
    save();
  }
  return {};
}

/** All subprocesses belong to this controller; no detached process, owner app or process-name cleanup. */
export class Children {
  constructor(env, signal) { this.env = env; this.signal = signal; this.live = new Set(); }
  start(command, args, options = {}) {
    this.signal?.throwIfAborted();
    const child = spawn(command, args, { cwd: ROOT, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], ...options });
    this.live.add(child); child.stdin.on('error', () => {});
    let out = '', err = '', buffer = ''; const listeners = new Set(), rows = [];
    const closed = new Promise(resolve => {
      child.once('error', error => { err += error.message; });
      child.once('close', (code, signal) => { this.live.delete(child); resolve({ code, signal, stdout: out, stderr: err }); });
    });
    child.stdout.on('data', chunk => {
      out += chunk; buffer += chunk;
      if (out.length > 16 << 20) { child.kill('SIGTERM'); return; }
      while (buffer.includes('\n')) {
        const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try { const row = JSON.parse(line); rows.push(row); for (const f of listeners) f(row); } catch {}
      }
    });
    child.stderr.on('data', c => { if (err.length < 65536) err += c; });
    const channel = { child, closed, rows, listeners,
      send: row => { this.signal?.throwIfAborted(); if (child.exitCode !== null || child.signalCode) throw Error('Child already exited'); child.stdin.write(JSON.stringify(row) + '\n'); },
      wait: async (predicate, ms = 5000, after = 0) => {
        const found = rows.slice(after).find(predicate); if (found) return found;
        return new Promise((yes, no) => {
          const end = () => { clearTimeout(timer); listeners.delete(onRow); this.signal?.removeEventListener('abort', abort); };
          const onRow = row => { if (predicate(row)) { end(); yes(row); } };
          const abort = () => { end(); no(this.signal.reason); };
          const timer = setTimeout(() => { end(); no(Error('Child response timed out')); }, ms);
          listeners.add(onRow); this.signal?.addEventListener('abort', abort, { once: true });
          closed.then(() => { end(); no(Error('Child closed before response')); });
        });
      },
      close: async () => {
        child.stdin.end();
        const timer = setTimeout(() => child.kill('SIGTERM'), 3000), hard = setTimeout(() => child.kill('SIGKILL'), 6000);
        let deadline;
        try { return await Promise.race([closed, new Promise((_, reject) => {
          deadline = setTimeout(() => reject(Object.assign(Error('Child cleanup unproved'), { code: 'CLEANUP' })), 9000);
        })]); } finally { clearTimeout(timer); clearTimeout(hard); clearTimeout(deadline); }
      },
    };
    return channel;
  }
  async run(command, args, { input = '', timeout = 30000 } = {}) {
    const p = this.start(command, args); p.child.stdin.end(input);
    let hard, timedOut = false;
    const terminate = () => { p.child.kill('SIGTERM'); hard ??= setTimeout(() => p.child.kill('SIGKILL'), 2000); };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeout);
    const abort = terminate; this.signal?.addEventListener('abort', abort, { once: true });
    try {
      const r = await p.closed; this.signal?.throwIfAborted();
      if (timedOut) throw Error(`${basename(command)} timed out; child collected`);
      if (r.code !== 0) throw Error(`${basename(command)} exited ${r.code ?? r.signal}: ${r.stderr.slice(0, 1000)}`);
      return r.stdout;
    } finally { clearTimeout(timer); clearTimeout(hard); this.signal?.removeEventListener('abort', abort); }
  }
  async close() {
    const owned = [...this.live];
    for (const child of owned) child.stdin.end();
    const until = Date.now() + 3000;
    while (this.live.size && Date.now() < until) await sleep(50);
    for (const child of this.live) child.kill('SIGTERM');
    await sleep(300);
    for (const child of this.live) child.kill('SIGKILL');
    const deadline = Date.now() + 3000;
    while (this.live.size && Date.now() < deadline) await sleep(50);
    if (this.live.size) throw Object.assign(Error('Owned child cleanup unproved; live lock retained'), { code: 'CLEANUP' });
  }
}
export async function main(argv = process.argv.slice(2)) {
  let opts; try { opts = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (opts.dryRun) { console.log(dryRunPlan(opts).join('\n')); return 0; }
  if (!opts.ownerAway || process.platform !== 'darwin') { console.error('C10 requires macOS and --owner-away. Use --dry-run to inspect.'); return 2; }
  if (existsSync('/tmp/sleight-hold') || existsSync('/tmp/sleight-live.lock')) { console.error('C10 refused: hold or live lock exists.'); return 3; }
  const controller = new AbortController(); const stop = code => controller.abort(Object.assign(Error(code), { code }));
  const signalHandlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => stop('SIGNAL')]);
  for (const [signal, fn] of signalHandlers) process.once(signal, fn);
  const work = realpathSync(mkdtempSync('/private/tmp/c10-run-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CLAUDE') && !key.startsWith('SLEIGHT_')));
  env.CLAUDE_CONFIG_DIR = join(work, 'claude'); mkdirSync(env.CLAUDE_CONFIG_DIR, { mode: 0o700 });
  env.TMPDIR = work; env.DISABLE_AUTOUPDATER = '1'; env.SLEIGHT_NO_HUB = '1';
  const children = new Children(env, controller.signal);
  let unlock, interval, state, stopped, save;
  try {
    const head = (await children.run('/usr/bin/git', ['rev-parse', 'HEAD'])).trim();
    if ((await children.run('/usr/bin/git', ['status', '--porcelain', '--untracked-files=normal'])).trim()) throw Error('Live run requires a clean checkout');
    const identity = { root: realpathSync(ROOT), head }, statePath = join(opts.night, 'c10-state.json');
    if (!opts.fresh && existsSync(statePath)) {
      const st = lstatSync(statePath);
      if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o600 || st.size > 1 << 20) throw Error('Unsafe resume state');
      state = JSON.parse(readFileSync(statePath, 'utf8')); assertIdentity(state, identity);
    }
    else {
      const parent = join(homedir(), 'Library/Logs/sleight'); mkdirSync(parent, { recursive: true, mode: 0o700 });
      state = { ...identity, startedAt: new Date().toISOString(), out: mkdtempSync(join(parent, 'c10-')), markers: {} };
    }
    mkdirSync(opts.night, { recursive: true, mode: 0o700 });
    assertBank(state.out, join(homedir(), 'Library/Logs/sleight'));
    save = () => { jsonWrite(statePath, state); writeFileSync(join(state.out, 'summary.md'), summaryMarkdown(state, stopped), { mode: 0o600 }); };
    save();
    const bin = join(state.out, 'bin'); mkdirSync(bin, { recursive: true, mode: 0o700 });
    const cache = join(work, 'modules'); mkdirSync(cache, { mode: 0o700 });
    for (const [source, name] of [['plugins/sleight/lib/direct-browser/native/consent-host.swift', 'consent-host'], ['bench/hand/c10-fixture.swift', 'c10-fixture']]) {
      await children.run('/usr/bin/xcrun', ['swiftc', '-module-cache-path', cache, join(ROOT, source), '-o', join(bin, name)], { timeout: 600000 });
    }
    const preflight = async () => JSON.parse(await children.run(join(bin, 'c10-fixture'), ['--preflight']));
    const pre = await preflight();
    if (!pre.screenRecording) throw Error('Screen Recording permission missing; C10 never prompts');
    await sleep(15000, undefined, { signal: controller.signal });
    const idle = (await preflight()).idle;
    if (!Number.isFinite(idle)) throw Object.assign(Error('Unknown idle time'), { code: 'TELEMETRY' });
    if (idle < 10) throw Object.assign(Error('Input during quiet gap'), { code: 'OWNER' });
    if (existsSync('/tmp/sleight-hold')) throw Object.assign(Error('Hold before live lock'), { code: 'HOLD' });
    unlock = await acquireLiveLock();
    const detect = createInputDetector({ harnessInput: false, quietSinceMs: Date.now() - 15000 });
    let lastSampleAt;
    interval = setInterval(() => {
      if (existsSync('/tmp/sleight-hold')) stop('HOLD');
      if (lastSampleAt !== undefined && Date.now() - lastSampleAt > 5000) stop('TELEMETRY');
    }, 500);
    const { runCheck } = await import('./c10-checks.mjs');
    const outcome = await executeSteps(steps, state, { save, run: async (step, attempts) => {
      controller.signal.throwIfAborted();
      const directory = join(state.out, `${step.id}-${attempts}`); mkdirSync(directory, { mode: 0o700 });
      const fixture = children.start(join(bin, 'c10-fixture'), ['--serve', directory, join(bin, 'consent-host')]);
      lastSampleAt = Date.now();
      fixture.listeners.add(row => {
        if (row.event === 'input') {
          lastSampleAt = Date.now();
          if (!Number.isFinite(row.idle) || !Number.isFinite(row.x) || !Number.isFinite(row.y)) stop('TELEMETRY'); else if (detect(row)?.back) stop('OWNER');
        }
      });
      const timer = setTimeout(() => stop('TELEMETRY'), (step.estimateSeconds * 2 + 60) * 1000);
      let result;
      try {
        const ready = await fixture.wait(r => r.event === 'ready');
        result = await runCheck(step.id, { children, fixture, ready, directory, bin, work,
          signal: controller.signal, sleep: ms => sleep(ms, undefined, { signal: controller.signal }) });
      } finally { clearTimeout(timer); lastSampleAt = undefined; const end = await fixture.close(); if (end.code !== 0) throw Object.assign(Error('Fixture cleanup failed'), { code: 'CLEANUP' }); }
      controller.signal.throwIfAborted(); validateResult(result, directory);
      jsonWrite(join(directory, 'result.json'), result);
      return { ...result, directory, digest: evidenceDigest(directory) };
    } });
    stopped = outcome.stopped; save();
    const n = totals(Object.values(state.markers));
    console.log(summaryMarkdown(state, stopped));
    return stopped === 'OWNER' ? 4 : stopped || n.fail || n.requiredSkipped || steps.some(s => !reusable(state.markers[s.id])) ? 1 : 0;
  } catch (error) {
    stopped = error.code ?? error.message; if (save) save(); console.error(cleanText(stopped)); return stopped === 'OWNER' ? 4 : 1;
  } finally {
    clearInterval(interval);
    let cleaned = false;
    try { await children.close(); cleaned = true; } catch (e) { console.error(e.message); }
    if (cleaned) {
      try { if (unlock) await unlock(); rmSync(work, { recursive: true, force: true }); }
      catch (e) { cleaned = false; console.error(e.message); }
    }
    for (const [signal, fn] of signalHandlers) process.removeListener(signal, fn);
    if (!cleaned) { stopped = 'CLEANUP'; if (save) save(); return 1; }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
