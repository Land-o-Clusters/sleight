#!/usr/bin/env node
// VC7's night runner: the agent cursor's five live checks in order, unattended, from ledger/vc/night/vc7.command.
//   1 capture exclusion (h5-capture.mjs --cursor-style ring, seam, sprite)   2 engine cursor (engine-cursor.mjs)
//   3 idle and active cost (cursor-cost.mjs)   4 the speed A/B (cost-pass.mjs --cursor-style ring, 5 rounds)
//   5 the visual record (cursor-record.mjs)
//
//   node bench/hand/vc7-night.mjs [--dry-run] [--fresh] [--night DIR]
//
// Resume: the first launch pins the checkout (HEAD, no tracked changes) and an output folder ~/Library/Logs/sleight/vc7-<stamp>
// in DIR/vc7-state.json; a later launch with the same HEAD continues there. A step is done only when it measured: exit 0 or
// 1 with a "VC7 RESULT:" line in that attempt's log. A build failure, a timeout, a thrown error or a crash is "failed",
// retried once after 60 s, and rerun on the next launch; a done step never reruns. --fresh starts a new folder.
//
// Before each attempt it waits up to 30 min while /tmp/sleight-hold exists and up to 20 min while /tmp/sleight-live.lock
// does, then skips the step with that reason. It never creates either and removes the lock only when a step's process
// tree it killed left it (newer than the attempt, every process of the tree dead). Then 15 s with no input of its own, and the HID
// idle time: input inside that gap is the owner (owner-watch.mjs). During a step it polls the hold (a new hold interrupts the
// step, which reruns after it) and the real pointer once a second (a pointer that moves and stays away, or in a check that
// makes no input any HID input, is the owner), and enforces a timeout of twice the step's estimate. Owner back: the step is
// interrupted and the night stops with STOPPED-owner. Steps run as children of this runner, never in a new session (Terminal
// keeps the Screen Recording grant), with host CLAUDE* variables dropped, a throwaway CLAUDE_CONFIG_DIR and (all but the A/B)
// a TMPDIR under the night's folder. caffeinate -dims holds the display and the Mac awake for the runner's life (-ims while
// a hold is waited out). After every step and on any exit it quits a TextEdit a step started, and any TextEdit or
// Calculator the step launched (quit, then SIGTERM, then SIGKILL, by the launched pid and its launch time only; no System
// Events), kills processes started from this run's bin/, and empties only the night's own temp folders. summary.md lists
// every step and every fixture that needed a signal.
// Exit 0: every step measured; 1: a step did not; 4: stopped for the owner; 129, 130 or 143: a signal.
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createOwnerWatch, ownerWords, parseInputLine, createInputDetector, QUIET_GAP_MS } from './owner-watch.mjs';
import { ROOT, HOST_SOURCE, HELPER_SOURCE, RECORDER_SOURCE, TEXTEDIT, tilde, stamp as makeStamp, logsRoot } from './vc7-live.mjs';

const execute = promisify(execFile);
export const HOLD = '/tmp/sleight-hold', LOCK = '/tmp/sleight-live.lock';
export const NIGHT = join(homedir(), 'Projects/sleight-wt/ledger/vc/night');
export const BUSY_RETRIES = 3;
export const FAILED_RETRIES = 1;
export const LOCK_WAIT_MS = 20 * 60000;
export const HOLD_WAIT_MS = 30 * 60000;
export const KILL_GRACE_MS = 60000;
export const TARGET_MIN = 90;
// The apps the checks and the A/B's tasks launch. One a step started (a new pid, launched after the attempt began) is quit
// in the sweep, as receipts' fixtures are.
export const FIXTURE_BUNDLES = Object.freeze(['com.apple.TextEdit', 'com.apple.calculator']);

/** The steps in order. est: minutes, from H5 (32 s a run, 2026-10-19) and H6 (18 runs in 7.3 min) plus setup. input: the
 *  step itself makes input (engine clicks and keys, the A/B's arms), so only the pointer can show the owner during it. */
export function nightSteps({ out, bin }) {
  const tools = ['--host', join(bin, 'consent-host'), '--helper', join(bin, 'capture-helper')];
  const live = id => ['--owner-away', '--out', join(out, id), '--receipt', join(out, `${id}.fixture.json`)];
  return [
    { id: 'build', check: 0, est: 4, input: false, internal: true, what: 'build the hand host, the capture helper and the recorder (xcrun swiftc, no -O)' },
    ...['ring', 'seam', 'sprite'].map(style => ({ id: `capture-${style}`, check: 1, est: 2, input: false, what: `capture exclusion, ${style}`,
      script: 'bench/hand/h5-capture.mjs', args: [...live(`capture-${style}`), '--cursor-style', style, '--samples', '5', ...tools] })),
    { id: 'engine-cursor', check: 2, est: 3, input: true, what: 'engine cursor double-up and timing', script: 'bench/hand/engine-cursor.mjs',
      args: [...live('engine-cursor'), '--helper', join(bin, 'capture-helper')] },
    { id: 'cursor-cost', check: 3, est: 8, input: false, what: 'idle and active cost, ring, seam and sprite', script: 'bench/hand/cursor-cost.mjs',
      args: [...live('cursor-cost'), ...tools] },
    { id: 'speed-ab', check: 4, est: 15, input: true, what: 'speed A/B, ring on against hand off, 5 rounds, Haiku 5.5 high', script: 'bench/hand/cost-pass.mjs',
      args: ['--owner-away', '--cursor-style', 'ring', '--capture', 'hidden', '--rounds', '5', '--tasks', 'calculator-click,textedit-save,textedit-drag',
        '--model', 'claude-haiku-5-5', '--effort', 'high', '--stop-on-owner', '--out', join(out, 'speed-ab')] },
    { id: 'record', check: 5, est: 3, input: false, what: '20 s recordings, ring and sprite, visible capture, cropped to the fixture', script: 'bench/hand/cursor-record.mjs',
      args: [...live('record'), '--seconds', '20', ...tools, '--recorder', join(bin, 'capture-recorder')] },
  ];
}
export const estimate = steps => steps.reduce((n, s) => n + s.est, 0);
export const timeoutMs = step => step.est * 2 * 60000;
// The gaps before each step, the A/B's four round gaps, and one failed-step retry pause are the fixed overhead.
export const overheadMin = steps => Math.ceil((steps.length * QUIET_GAP_MS + 4 * QUIET_GAP_MS) / 60000);

/** What an attempt means for the night. measured: its log has a "VC7 RESULT:" line. reason: why the runner ended it. */
export function outcome(rc, { signal, measured = false, reason } = {}) {
  if (reason === 'owner') return { status: 'stopped for the owner', done: false, stop: true };
  if (reason === 'hold') return { status: 'paused for a hold', done: false, hold: true };
  if (reason === 'timeout') return { status: 'failed (timeout)', done: false, failed: true };
  if (reason === 'interrupted') return { status: 'interrupted', done: false, stop: true };
  if (reason === 'build') return { status: 'failed (build)', done: false, failed: true };
  if (rc === 0 && measured) return { status: 'passed', done: true };
  if (rc === 1 && measured) return { status: 'measured, not passed', done: true };
  if (rc === 2) return { status: 'refused', done: false };
  if (rc === 3) return { status: 'busy', done: false, retry: true };
  if (rc === 4) return { status: 'stopped for the owner', done: false, stop: true };
  if (rc === 5) return { status: 'incomplete (runs errored)', done: false, failed: true };
  if (signal || [129, 130, 143].includes(rc)) return { status: `failed (${signal ?? `exit ${rc}`})`, done: false, failed: true };
  if (rc === 0 || rc === 1) return { status: `failed (exit ${rc} without a result)`, done: false, failed: true };
  return { status: `failed (exit ${rc})`, done: false, failed: true };
}

/** The child environment: no host CLAUDE* variable, a throwaway config, no auto-update and no hub, as the A/B queue runs. */
export function childEnv(env, configDir, { tmp, charactersBase } = {}) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('CLAUDE')));
  return { ...clean, CLAUDE_CONFIG_DIR: configDir, DISABLE_AUTOUPDATER: '1', SLEIGHT_NO_HUB: '1', SLEIGHT_REMOTE_APPROVALS: '0',
    ...(tmp ? { TMPDIR: tmp } : {}), ...(charactersBase ? { VC7_CHARACTERS_BASE: charactersBase } : {}) };
}

/** Whether the runner may remove the live lock after it killed a step's tree: the lock is newer than the attempt (the
 *  step made it) and every process of the tree is dead (nothing can still be using it). The runner never removes it otherwise. */
export function orphanedLock({ lockMtimeMs, attemptStartMs, alive }) {
  return Number.isFinite(lockMtimeMs) && lockMtimeMs >= attemptStartMs && Array.isArray(alive) && alive.every(a => a === false);
}

/** Apps a step launched: pids of FIXTURE_BUNDLES running after the attempt that were not running before it.
 *  before and after: { [bundle]: [pid] }. */
export function launchedApps(before, after) {
  return Object.entries(after).flatMap(([bundle, pids]) => pids.filter(pid => !(before[bundle] ?? []).includes(pid)).map(pid => ({ bundle, pid })));
}

/** Processes started from this run's binaries (the bin folder), from `ps -A -o pid=,command=`: hosts, recorders, samplers. */
export function strays(psText, bin) {
  const prefix = bin.endsWith('/') ? bin : bin + '/';
  const rows = [];
  for (const line of String(psText).split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (m && m[2].startsWith(prefix)) rows.push({ pid: Number(m[1]), command: m[2].slice(prefix.length).split(/\s/)[0] });
  }
  return rows;
}

/** Every descendant of root, from `ps -A -o pid=,ppid=`, children before their parents' parents (deepest last). */
export function descendants(psText, root) {
  const kids = new Map();
  for (const line of String(psText).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (m) { const [pid, ppid] = [Number(m[1]), Number(m[2])]; if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid); }
  }
  const out = [], queue = [root];
  while (queue.length) for (const pid of kids.get(queue.shift()) ?? []) { out.push(pid); queue.push(pid); }
  return out;
}

/** The last "VC7 RESULT:" line of a step's log, or undefined. */
export const resultLine = text => [...String(text).matchAll(/^VC7 RESULT: (.+)$/gm)].at(-1)?.[1];

export function summaryMarkdown(state, markers, steps, { stoppedFor } = {}) {
  const rows = steps.map(step => {
    const m = markers[step.id];
    return `| ${step.check || '-'} | ${step.id} | ${m ? m.status : 'not run'} | ${m?.rc ?? ''} | ${m ? m.minutes : ''} | ${m?.result ?? ''} |`;
  });
  return [`# VC7 agent cursor live checks`, '',
    `Checkout ${tilde(state.root)} at ${state.head.slice(0, 12)}, output ${tilde(state.out)}, started ${state.startedAt} (UTC).`,
    ...(stoppedFor ? ['', `Stopped: ${stoppedFor}. Rerun the same command to resume.`] : []), '',
    '| Check | Step | Status | Exit | Minutes | Result |', '|---|---|---|---|---|---|', ...rows, '',
    ...(() => {
      const forced = steps.flatMap(step => (markers[step.id]?.cleanup ?? []).filter(note => /SIGTERM|SIGKILL|survived/.test(note)).map(note => `- ${step.id}: ${note}`));
      return forced.length ? ['Fixture cleanup that needed a signal (a quit did not end the app):', ...forced, ''] : [];
    })(),
    `Reports: each step's folder under ${tilde(state.out)}, and its log as <step>.log.`, ''].join('\n');
}

export function parseArgs(argv) {
  const value = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const known = new Set(['--dry-run', '--fresh', '--night']);
  for (const [i, arg] of argv.entries()) {
    if (arg.startsWith('--') && !known.has(arg)) throw new Error(`unknown option ${arg}`);
    if (!arg.startsWith('--') && argv[i - 1] !== '--night') throw new Error(`unexpected argument ${arg}`);
  }
  if (argv.includes('--night') && !value('--night')) throw new Error('--night needs a folder');
  return { dryRun: argv.includes('--dry-run'), fresh: argv.includes('--fresh'), night: resolve(value('--night') ?? NIGHT) };
}

const git = (...args) => execFileSync('/usr/bin/git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim();
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const atomic = (path, value) => { writeFileSync(path + '.tmp', value); renameSync(path + '.tmp', path); };
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');

async function dryRun(opts) {
  const statePath = join(opts.night, 'vc7-state.json');
  const saved = !opts.fresh && existsSync(statePath) ? json(statePath) : undefined;
  const out = saved?.out ?? join(logsRoot(), `vc7-${makeStamp()}`), bin = join(out, 'bin');
  const steps = nightSteps({ out, bin });
  let head = '(unknown)', dirty = '';
  try { head = git('rev-parse', 'HEAD'); dirty = git('status', '--porcelain', '--untracked-files=no'); } catch {}
  console.log(`VC7 night runner (dry run: nothing opened, nothing written)`);
  console.log(`  checkout ${tilde(ROOT)} at ${head.slice(0, 12)}${dirty ? ' WITH TRACKED CHANGES (a live launch refuses)' : ''}`);
  console.log(`  output ${tilde(out)}${saved ? ' (resuming the saved run)' : ''}; state ${tilde(statePath)}`);
  console.log(`  estimate ${estimate(steps)} min of steps plus about ${overheadMin(steps)} min of quiet gaps (target under ${TARGET_MIN}); waits for ${HOLD} and ${LOCK} add to it`);
  console.log(`  /usr/bin/caffeinate -dims -w <runner pid> for the runner's life`);
  console.log(`  before each step: wait up to ${HOLD_WAIT_MS / 60000} min while ${HOLD} exists (caffeinate -ims, the display may sleep) and up to ${LOCK_WAIT_MS / 60000} min while ${LOCK} does, then skip the step; ${QUIET_GAP_MS / 1000} s with no input, then ioreg HIDIdleTime: input in that gap stops the night (exit 4)`);
  console.log(`  during each step: ${tilde(join(bin, 'capture-helper'))} watch-input 1000 (pointer moved and stayed away, or HID input in a step that makes none: stop); the hold polled every 5 s (interrupt, rerun after it); a timeout of twice the estimate (SIGINT, then SIGKILL of its process tree after ${KILL_GRACE_MS / 1000} s, then rmdir ${LOCK} only if it is newer than the attempt and the tree is dead)`);
  console.log(`  each step: a child of this runner (no new session), env without CLAUDE*, CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX), DISABLE_AUTOUPDATER=1 SLEIGHT_NO_HUB=1 SLEIGHT_REMOTE_APPROVALS=0, TMPDIR=${tilde(join(out, 'tmp'))}/<step>-XXXXXX (not the A/B), VC7_CHARACTERS_BASE=/private/tmp/sleight-vc7-night-XXXXXX`);
  console.log(`  done only with exit 0 or 1 and a "VC7 RESULT:" line; a failed step retries once after 60 s and reruns on resume`);
  console.log(`  after each step and on exit: quit a TextEdit a step started and any TextEdit or Calculator it launched (quit, SIGTERM, SIGKILL, by the launched pid and launch time; no System Events), kill processes started from ${tilde(bin)}/, empty only the night's tmp/ and characters folder`);
  for (const step of steps) {
    const marker = saved && existsSync(join(out, 'markers', `${step.id}.json`)) ? json(join(out, 'markers', `${step.id}.json`)) : undefined;
    const skip = marker?.done ? `  [done: ${marker.status}, skipped on resume]` : '';
    console.log(`\n# ${step.check ? `check ${step.check}` : 'setup'}: ${step.id}, about ${step.est} min (timeout ${timeoutMs(step) / 60000} min): ${step.what}${skip}`);
    if (step.internal) {
      for (const [source, name] of [[HOST_SOURCE, 'consent-host'], [HELPER_SOURCE, 'capture-helper'], [RECORDER_SOURCE, 'capture-recorder']]) {
        console.log(`xcrun swiftc -module-cache-path <swift cache> ${tilde(source)} -o ${tilde(join(bin, name))}`);
      }
      continue;
    }
    console.log(`cd ${tilde(ROOT)} && node ${step.script} ${step.args.map(a => tilde(a)).join(' ')} >> ${tilde(join(out, `${step.id}.log`))} 2>&1`);
    // The step's own plan, from its --dry-run, which opens nothing.
    const { stdout } = await execute(process.execPath, [join(ROOT, step.script), ...step.args, '--dry-run'], { cwd: ROOT, timeout: 30000 })
      .catch(error => ({ stdout: `(its dry run failed: ${error.message.split('\n')[0]})\n` }));
    for (const line of String(stdout).trimEnd().split('\n')) console.log(`    | ${line}`);
  }
  console.log(`\n# summary: ${tilde(join(out, 'summary.md'))}`);
  return 0;
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) { console.error(error.message); return 2; }
  if (opts.dryRun) return dryRun(opts);
  if (process.platform !== 'darwin') { console.error('macOS only'); return 2; }
  mkdirSync(opts.night, { recursive: true });
  const statePath = join(opts.night, 'vc7-state.json');
  const head = git('rev-parse', 'HEAD');
  if (git('status', '--porcelain', '--untracked-files=no')) { console.error(`Tracked changes in ${tilde(ROOT)}: commit or stash them first`); return 2; }
  let state = !opts.fresh && existsSync(statePath) ? json(statePath) : undefined;
  if (state && state.head !== head) { console.error(`The saved run pinned ${state.head.slice(0, 12)}; this checkout is at ${head.slice(0, 12)}. Pass --fresh for a new run.`); return 2; }
  if (state && state.root !== ROOT) { console.error(`The saved run used ${tilde(state.root)}; pass --fresh to start one here.`); return 2; }
  if (!state) {
    const out = join(logsRoot(), `vc7-${makeStamp()}`);
    state = { stamp: out.split('vc7-').at(-1), out, root: ROOT, head, startedAt: new Date().toISOString() };
    atomic(statePath, JSON.stringify(state, null, 2) + '\n');
  }
  const launchedAt = Date.now();
  const out = state.out, bin = join(out, 'bin'), markersDir = join(out, 'markers'), tmpRoot = join(out, 'tmp');
  mkdirSync(markersDir, { recursive: true });
  mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
  // The synthetic character must live under /private/tmp (the host's test override), so the night makes one folder there
  // for every step's character root and removes only that folder.
  const charactersBase = mkdtempSync('/private/tmp/sleight-vc7-night-');
  const runnerLog = join(out, 'runner.log');
  // A closed Terminal window takes stdout away; runner.log keeps the record.
  process.stdout.on('error', () => {});
  const log = text => { const line = `${new Date().toISOString()} ${text}`; try { console.log(line); } catch {} appendFileSync(runnerLog, line + '\n'); };
  const steps = nightSteps({ out, bin });
  const markers = {};
  for (const step of steps) if (existsSync(join(markersDir, `${step.id}.json`))) markers[step.id] = json(join(markersDir, `${step.id}.json`));
  const live = await import('../compat/live.mjs');
  const { quitFixture } = await import('./vc7-live.mjs');
  const running = async () => Object.fromEntries(await Promise.all(FIXTURE_BUNDLES.map(async bundle => {
    try { const st = await live.appState(bundle); return [bundle, st.running ? st.pids ?? [] : []]; } catch { return [bundle, []]; }
  })));
  const watch = createOwnerWatch();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let child, interrupted = false, stoppedFor, ending;
  // caffeinate for the runner's life: -dims while checks run, -ims (the display may sleep) while a hold is waited out.
  let caffeinate, caffeinateMode;
  const awake = mode => {
    if (mode === caffeinateMode) return;
    try { caffeinate?.kill(); } catch {}
    caffeinateMode = mode;
    caffeinate = spawn('/usr/bin/caffeinate', [mode, '-w', String(process.pid)], { stdio: 'ignore' });
    caffeinate.on('error', error => log(`caffeinate: ${error.message}`));
  };
  awake('-dims');
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) process.on(signal, () => {
    if (interrupted) return;
    interrupted = code;
    log(`${signal}: stopping the current step and cleaning up`);
    // Ctrl-C (and a closed Terminal's hangup) already reached the step through Terminal's process group, and a second
    // signal would skip its cleanup (h5-capture.mjs underLiveLock), so only a SIGTERM is passed on.
    if (child && signal === 'SIGTERM') ending?.('interrupted');
  });

  const ps = async args => (await execute('/bin/ps', args, { maxBuffer: 16 << 20 }).catch(() => ({ stdout: '' }))).stdout;
  // notes: what the cleanup had to do, for the step's marker and the summary.
  const sweep = async ({ launched = [], attemptStartMs } = {}) => {
    const notes = [];
    const quit = async (label, target) => {
      try {
        const how = await quitFixture(target, { live, log: line => log(`cleanup ${label}: ${tilde(line)}`) });
        if (how !== 'gone') { notes.push(`${label} ${target.pid}: ${how}`); log(`cleanup: ${label} ${target.pid}: ${how}`); }
        return true;
      } catch (error) { notes.push(`${label} ${target.pid}: ${error.message}`); log(`cleanup: ${label}: ${tilde(error.message)}`); return false; }
    };
    for (const step of steps) {
      const receipt = join(out, `${step.id}.fixture.json`);
      if (!existsSync(receipt)) continue;
      let pid, startedAt;
      try { ({ pid, startedAt } = json(receipt)); } catch { rmSync(receipt, { force: true }); continue; }
      if (await quit(`fixture TextEdit of ${step.id}`, { bundle: TEXTEDIT, pid, startedAfterMs: Date.parse(startedAt) })) rmSync(receipt, { force: true });
    }
    // Apps the step launched itself (the A/B's TextEdit or Calculator), by pid and launch time. Never after an owner stop:
    // an app the owner opened then can't be told from the step's.
    if (!stoppedFor) for (const app of launched) await quit(`${app.bundle} launched by the step`, { ...app, startedAfterMs: attemptStartMs });
    for (const stray of strays(await ps(['-A', '-o', 'pid=,command=']), bin)) {
      try { process.kill(stray.pid, stray.command === 'capture-recorder' ? 'SIGTERM' : 'SIGKILL'); log(`cleanup: stopped ${stray.command} ${stray.pid}`); } catch {}
    }
    // Only the night's own temp folders: each step's TMPDIR under tmp/, and the characters folder under /private/tmp.
    for (const dir of [tmpRoot, charactersBase]) {
      let names = [];
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names) { try { rmSync(join(dir, name), { recursive: true, force: true }); } catch {} }
    }
    return notes;
  };
  const killTree = async (pid, signal) => {
    const tree = descendants(await ps(['-A', '-o', 'pid=,ppid=']), pid);
    for (const p of [...tree].reverse()) { try { process.kill(p, signal); } catch {} }
    try { process.kill(pid, signal); } catch {}
    return [pid, ...tree];
  };
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
  // After a tree kill the step's underLiveLock never ran its release. The runner removes that lock only when it is newer
  // than the attempt and every process of the tree is dead (rmdir, never rm -r).
  const releaseOrphanedLock = async (tree, attemptStartMs) => {
    for (let i = 0; i < 50 && tree.some(alive); i++) await sleep(100);
    let lockMtimeMs;
    try { lockMtimeMs = lstatSync(LOCK).mtimeMs; } catch { return; }
    if (orphanedLock({ lockMtimeMs, attemptStartMs, alive: tree.map(alive) })) {
      try { rmdirSync(LOCK); log(`removed ${LOCK}, left by the step's killed process tree`); } catch (error) { log(`${LOCK}: ${error.message}`); }
    } else log(`${LOCK} stays: it is older than the attempt or a process of the tree is alive`);
  };

  // One attempt: the child, the pointer and hold watch, and the timeout. Resolves { rc, signal, reason, measured }.
  const runStep = async (step, attemptStartMs) => {
    const cfg = mkdtempSync('/tmp/lane-claude-');
    // Every check but the A/B gets its own TMPDIR under the night's folder. The A/B keeps the default one, as every
    // earlier A/B did: run.mjs keys its fixture, trace and evidence folders to it (bench/evidence.mjs tempRoots).
    const tmp = step.id === 'speed-ab' ? undefined : mkdtempSync(join(tmpRoot, `${step.id}-`));
    let treeKill;
    const logPath = join(out, `${step.id}.log`);
    const fd = openSync(logPath, 'a');
    const offset = statSync(logPath).size;
    let input, timer, holdPoll, grace;
    try {
      writeFileSync(fd, `\n# ${new Date().toISOString()} node ${step.script} ${step.args.join(' ')}\n`);
      const result = await new Promise(done => {
        let reason;
        child = spawn(process.execPath, [join(ROOT, step.script), ...step.args], { cwd: ROOT, env: childEnv(process.env, cfg, { tmp, charactersBase }), stdio: ['ignore', fd, fd] });
        const end = why => {
          if (reason || !child) return;
          reason = why;
          log(`${step.id}: ${why === 'owner' ? stoppedFor : why === 'hold' ? `${HOLD} appeared` : why}; sending SIGINT`);
          try { child.kill('SIGINT'); } catch {}
          grace = setTimeout(() => { log(`${step.id}: still running ${KILL_GRACE_MS / 1000} s after SIGINT; SIGKILL to its process tree`); if (child) treeKill = killTree(child.pid, 'SIGKILL'); }, KILL_GRACE_MS);
        };
        ending = end;
        child.once('error', error => { child = undefined; done({ rc: 127, error: error.message }); });
        child.once('close', (rc, signal) => { child = undefined; done({ rc, signal, reason }); });
        timer = setTimeout(() => end('timeout'), timeoutMs(step));
        holdPoll = setInterval(() => { if (existsSync(HOLD)) end('hold'); }, 5000);
        const helperBin = join(bin, 'capture-helper');
        if (existsSync(helperBin)) {
          input = spawn(helperBin, ['watch-input', '1000', String(Math.ceil(timeoutMs(step) / 1000) + 120)], { stdio: ['ignore', 'pipe', 'ignore'] });
          const detect = createInputDetector({ harnessInput: step.input, quietSinceMs: watch.quietSince });
          let buffer = '';
          input.stdout.on('data', chunk => {
            buffer += chunk;
            const lines = buffer.split('\n'); buffer = lines.pop();
            for (const line of lines) {
              const hit = detect(parseInputLine(line));
              if (hit && !stoppedFor) { stoppedFor = hit.reason; end('owner'); }
            }
          });
          input.on('error', () => {});
        }
      });
      if (treeKill) await releaseOrphanedLock(await treeKill, attemptStartMs);
      const text = readFileSync(logPath, 'utf8').slice(offset);
      return { ...result, measured: Boolean(resultLine(text)), result: resultLine(text) ?? /^VC7 INCOMPLETE: (.+)$/m.exec(text)?.[1] };
    } finally {
      clearTimeout(timer); clearTimeout(grace); clearInterval(holdPoll); ending = undefined;
      try { input?.kill('SIGKILL'); } catch {}
      closeSync(fd); rmSync(cfg, { recursive: true, force: true });
    }
  };

  const build = async () => {
    mkdirSync(bin, { recursive: true });
    const { compileSwift } = await import('./vc7-live.mjs');
    const wanted = Object.fromEntries([[HOST_SOURCE, 'consent-host'], [HELPER_SOURCE, 'capture-helper'], [RECORDER_SOURCE, 'capture-recorder']].map(([s, n]) => [n, { source: s, sha: sha(s) }]));
    const built = existsSync(join(bin, 'sources.json')) ? json(join(bin, 'sources.json')) : {};
    try {
      // One at a time: three parallel cold compiles on a loaded Mac can pass compileSwift's 300 s limit.
      for (const [name, { source, sha: hash }] of Object.entries(wanted)) {
        if (built[name] === hash && existsSync(join(bin, name))) continue;
        log(`build ${name}`);
        delete built[name];
        await compileSwift(source, join(bin, name));
        built[name] = hash;
      }
    } catch (error) {
      atomic(join(bin, 'sources.json'), JSON.stringify(built, null, 2) + '\n');
      return { rc: 5, reason: 'build', measured: false, result: `build failed: ${String(error.message).split('\n')[0].slice(0, 160)}` };
    }
    atomic(join(bin, 'sources.json'), JSON.stringify(built, null, 2) + '\n');
    return { rc: 0, measured: true, result: 'built' };
  };

  // Waits out a hold (up to HOLD_WAIT_MS, with the display allowed to sleep) and the live lock (up to LOCK_WAIT_MS).
  // Returns a reason to skip the step, or undefined.
  const waitClear = async () => {
    let lockSince, holdSince, said = 0;
    try {
      while (!interrupted) {
        const hold = existsSync(HOLD), lock = existsSync(LOCK);
        if (!hold && !lock) { if (holdSince || lockSince) watch.quiet(); return undefined; }
        if (hold) {
          holdSince ??= Date.now(); lockSince = undefined; awake('-ims');
          if (Date.now() - holdSince > HOLD_WAIT_MS) return `${HOLD} held for ${HOLD_WAIT_MS / 60000} min`;
        } else {
          lockSince ??= Date.now(); awake('-dims');
          if (Date.now() - lockSince > LOCK_WAIT_MS) return `${LOCK} held for ${LOCK_WAIT_MS / 60000} min`;
        }
        if (Date.now() - said > 600000) { said = Date.now(); log(`waiting: ${hold ? HOLD : LOCK} exists (${Math.round((Date.now() - (hold ? holdSince : lockSince)) / 60000)} min so far)`); }
        await sleep(10000);
      }
      return 'interrupted';
    } finally { awake('-dims'); }
  };

  log(`VC7 night run at ${head.slice(0, 12)} into ${tilde(out)}; estimate ${estimate(steps)} min plus ${overheadMin(steps)} min of gaps`);
  try {
    for (const step of steps) {
      if (interrupted || stoppedFor) break;
      if (markers[step.id]?.done) { log(`skip ${step.id} (${markers[step.id].status})`); continue; }
      let attempt = 0, busy = 0, failures = 0, meaning, result, started, cleanup = [];
      while (!interrupted && !stoppedFor) {
        const skip = await waitClear();
        if (skip === 'interrupted') break;
        if (skip) { result = { rc: null, result: `skipped: ${skip}` }; meaning = { status: `skipped (${skip})`, done: false }; break; }
        const back = await watch.gapCheck();
        if (back.back) { stoppedFor = ownerWords(back); break; }
        attempt++; started = Date.now();
        const before = step.internal ? {} : await running();
        log(`start ${step.id}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
        try { result = step.internal ? await build() : await runStep(step, started); }
        catch (error) { result = { rc: 1, measured: false, result: String(error.message).slice(0, 200) }; log(`${step.id}: ${tilde(error.message)}`); }
        if (interrupted && !result.reason) result.reason = 'interrupted';
        meaning = outcome(result.rc, result);
        watch.quiet();
        cleanup = await sweep({ launched: step.internal ? [] : launchedApps(before, await running()), attemptStartMs: started });
        if (meaning.hold) { log(`${step.id}: rerun after the hold`); continue; }
        if (meaning.retry && ++busy <= BUSY_RETRIES) { log(`${step.id} found the Mac busy; waiting 30 s`); await sleep(30000); continue; }
        if (meaning.failed && !step.internal && ++failures <= FAILED_RETRIES && !interrupted) {
          log(`${step.id} ${meaning.status}; one more attempt after 60 s`); await sleep(60000); continue;
        }
        break;
      }
      if (!meaning) break;
      markers[step.id] = { rc: result.rc ?? null, ...(result.signal ? { signal: result.signal } : {}), status: meaning.status, done: meaning.done,
        minutes: started ? Math.round((Date.now() - started) / 6000) / 10 : 0, endedAt: new Date().toISOString(), ...(result.result ? { result: result.result } : {}), ...(cleanup.length ? { cleanup } : {}) };
      atomic(join(markersDir, `${step.id}.json`), JSON.stringify(markers[step.id], null, 2) + '\n');
      log(`end ${step.id}: ${meaning.status}${result.result ? `: ${result.result}` : ''}`);
      if (step.internal && !meaning.done) { log('the build failed; no check can run'); break; }
      if (meaning.stop) { if (result.rc === 4 && !stoppedFor) stoppedFor = 'the speed A/B saw the owner return'; break; }
    }
  } finally {
    if (child) await killTree(child.pid, 'SIGKILL');
    await sweep().catch(error => log(`cleanup: ${tilde(error.message)}`));
    try { rmSync(charactersBase, { recursive: true, force: true }); } catch {}
    if (stoppedFor) { writeFileSync(join(out, 'STOPPED-owner'), stoppedFor + '\n'); log(`stopped: ${stoppedFor}`); }
    writeFileSync(join(out, 'summary.md'), summaryMarkdown(state, markers, steps, { stoppedFor }));
    log(`summary: ${tilde(join(out, 'summary.md'))}`);
    try { caffeinate.kill(); } catch {}
  }
  if (interrupted) return interrupted;
  if (stoppedFor) return 4;
  return steps.every(step => markers[step.id]?.done) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
