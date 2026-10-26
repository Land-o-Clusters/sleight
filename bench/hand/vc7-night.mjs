#!/usr/bin/env node
// VC7's night runner: the agent cursor's five live checks in order, unattended, from ledger/vc/night/vc7.command.
//   1 capture exclusion (h5-capture.mjs --cursor-style ring, seam, sprite)   2 engine cursor (engine-cursor.mjs)
//   3 idle and active cost (cursor-cost.mjs)   4 the speed A/B (cost-pass.mjs --cursor-style ring, 5 rounds)
//   5 the visual record (cursor-record.mjs)
//
//   node bench/hand/vc7-night.mjs [--dry-run] [--fresh] [--night DIR]
//
// Resume: the first launch pins the checkout (HEAD, no tracked changes) and an output folder ~/Library/Logs/sleight/vc7-<stamp>
// in DIR/vc7-state.json; a later launch with the same HEAD continues there and skips each step whose marker says it measured
// (exit 0 or 1). --fresh starts a new folder. Before each step it waits while /tmp/sleight-hold or /tmp/sleight-live.lock
// exists (it never creates or removes either; each check takes the live lock itself), then stops if the owner is back
// (owner-watch.mjs: input after the run's last own input). Each step runs as a child (no new session) with host CLAUDE*
// variables dropped and a throwaway CLAUDE_CONFIG_DIR. After every step and on any exit it quits a TextEdit a step started
// (by the step's receipt) and kills any host, recorder or sampler started from this run's binaries. summary.md lists every
// step. Exit 0: every step measured; 1: a step did not; 4: stopped for the owner; 130 or 143: interrupted.
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createOwnerWatch, ownerWords } from './owner-watch.mjs';
import { ROOT, HOST_SOURCE, HELPER_SOURCE, RECORDER_SOURCE, TEXTEDIT, tilde, stamp as makeStamp, logsRoot } from './vc7-live.mjs';

const execute = promisify(execFile);
export const HOLD = '/tmp/sleight-hold', LOCK = '/tmp/sleight-live.lock';
export const NIGHT = join(homedir(), 'Projects/sleight-wt/ledger/vc/night');
export const BUSY_RETRIES = 3;
export const TARGET_MIN = 90;

/** The steps in order. est: minutes, from H5 (32 s a run, 2026-10-19) and H6 (18 runs in 7.3 min) plus setup. */
export function nightSteps({ out, bin }) {
  const tools = ['--host', join(bin, 'consent-host'), '--helper', join(bin, 'capture-helper')];
  const live = id => ['--owner-away', '--out', join(out, id), '--receipt', join(out, `${id}.fixture.json`)];
  return [
    { id: 'build', check: 0, est: 4, internal: true, what: 'build the hand host, the capture helper and the recorder (xcrun swiftc, no -O)' },
    ...['ring', 'seam', 'sprite'].map(style => ({ id: `capture-${style}`, check: 1, est: 2, what: `capture exclusion, ${style}`,
      script: 'bench/hand/h5-capture.mjs', args: [...live(`capture-${style}`), '--cursor-style', style, '--samples', '5', ...tools] })),
    { id: 'engine-cursor', check: 2, est: 3, what: 'engine cursor double-up and timing', script: 'bench/hand/engine-cursor.mjs',
      args: [...live('engine-cursor'), '--helper', join(bin, 'capture-helper')] },
    { id: 'cursor-cost', check: 3, est: 8, what: 'idle and active cost, ring, seam and sprite', script: 'bench/hand/cursor-cost.mjs',
      args: [...live('cursor-cost'), ...tools] },
    { id: 'speed-ab', check: 4, est: 14, what: 'speed A/B, ring on against hand off, 5 rounds, Haiku 5.5 high', script: 'bench/hand/cost-pass.mjs',
      args: ['--owner-away', '--cursor-style', 'ring', '--rounds', '5', '--tasks', 'calculator-click,textedit-save,textedit-drag',
        '--model', 'claude-haiku-5-5', '--effort', 'high', '--stop-on-owner', '--out', join(out, 'speed-ab')] },
    { id: 'record', check: 5, est: 3, what: '20 s recordings, ring and sprite, visible capture, cropped to the fixture', script: 'bench/hand/cursor-record.mjs',
      args: [...live('record'), '--seconds', '20', ...tools, '--recorder', join(bin, 'capture-recorder')] },
  ];
}
export const estimate = steps => steps.reduce((n, s) => n + s.est, 0);

/** What a step's exit code means for the night. */
export function outcome(rc, signal) {
  if (signal || rc === 130 || rc === 143) return { status: 'interrupted', done: false, stop: true };
  if (rc === 0) return { status: 'passed', done: true };
  if (rc === 1) return { status: 'measured, not passed', done: true };
  if (rc === 2) return { status: 'refused', done: false };
  if (rc === 3) return { status: 'busy', done: false, retry: true };
  if (rc === 4) return { status: 'stopped for the owner', done: false, stop: true };
  return { status: `crashed (exit ${rc})`, done: false };
}

/** The child environment: no host CLAUDE* variable, a throwaway config, no auto-update and no hub, as the A/B queue runs. */
export function childEnv(env, configDir) {
  const clean = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('CLAUDE')));
  return { ...clean, CLAUDE_CONFIG_DIR: configDir, DISABLE_AUTOUPDATER: '1', SLEIGHT_NO_HUB: '1', SLEIGHT_REMOTE_APPROVALS: '0' };
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
  console.log(`  estimate ${estimate(steps)} min of steps (target under ${TARGET_MIN}); waits for ${HOLD} and ${LOCK} add to it`);
  console.log(`  before each step: wait while ${HOLD} or ${LOCK} exists; stop (exit 4) if the owner used the keyboard or pointer after the last step`);
  console.log(`  each step: a child of this runner (no new session), env without CLAUDE*, CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX), DISABLE_AUTOUPDATER=1 SLEIGHT_NO_HUB=1 SLEIGHT_REMOTE_APPROVALS=0`);
  console.log(`  after each step and on exit: quit a TextEdit a step started (its receipt), kill processes started from ${tilde(bin)}/`);
  for (const step of steps) {
    const marker = saved && existsSync(join(out, 'markers', `${step.id}.json`)) ? json(join(out, 'markers', `${step.id}.json`)) : undefined;
    const skip = marker && outcome(marker.rc).done ? `  [done: ${marker.status}, skipped on resume]` : '';
    console.log(`\n# ${step.check ? `check ${step.check}` : 'setup'}: ${step.id}, about ${step.est} min: ${step.what}${skip}`);
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
  const out = state.out, bin = join(out, 'bin'), markersDir = join(out, 'markers');
  mkdirSync(markersDir, { recursive: true });
  const runnerLog = join(out, 'runner.log');
  const log = text => { const line = `${new Date().toISOString()} ${text}`; console.log(line); appendFileSync(runnerLog, line + '\n'); };
  const steps = nightSteps({ out, bin });
  const markers = {};
  for (const step of steps) if (existsSync(join(markersDir, `${step.id}.json`))) markers[step.id] = json(join(markersDir, `${step.id}.json`));
  const live = await import('../compat/live.mjs');
  const watch = createOwnerWatch();
  let child, interrupted = false, stoppedFor;
  // A closed Terminal window must not end the night: ignore the hangup, and keep logging to runner.log with no terminal.
  process.on('SIGHUP', () => log('ignored SIGHUP'));
  process.stdout.on('error', () => {});
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.on(signal, () => {
    if (interrupted) return;
    interrupted = code;
    log(`${signal}: stopping the current step and cleaning up`);
    // Ctrl-C already reached the step through Terminal's process group, and a second SIGINT would skip its cleanup
    // (h5-capture.mjs underLiveLock), so only a SIGTERM is passed on.
    if (child && signal === 'SIGTERM') { try { child.kill('SIGINT'); } catch {} }
  });
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const sweep = async () => {
    for (const step of steps) {
      const receipt = join(out, `${step.id}.fixture.json`);
      if (!existsSync(receipt)) continue;
      try {
        const { pid } = json(receipt);
        const now = await live.appState(TEXTEDIT);
        if (now.running && now.pids?.length === 1 && now.pids[0] === pid) { await live.quitApp(TEXTEDIT, { pid }); log(`cleanup: quit the fixture TextEdit ${pid} left by ${step.id}`); }
        rmSync(receipt, { force: true });
      } catch (error) { log(`cleanup: ${step.id}'s TextEdit: ${tilde(error.message)}`); }
    }
    const { stdout } = await execute('/bin/ps', ['-A', '-o', 'pid=,command='], { maxBuffer: 16 << 20 }).catch(() => ({ stdout: '' }));
    for (const stray of strays(stdout, bin)) {
      try { process.kill(stray.pid, stray.command === 'capture-recorder' ? 'SIGTERM' : 'SIGKILL'); log(`cleanup: stopped ${stray.command} ${stray.pid}`); } catch {}
    }
  };

  const runStep = async step => {
    const cfg = mkdtempSync('/tmp/lane-claude-');
    const fd = openSync(join(out, `${step.id}.log`), 'a');
    try {
      writeFileSync(fd, `\n# ${new Date().toISOString()} node ${step.script} ${step.args.join(' ')}\n`);
      return await new Promise(done => {
        // Not detached: a new session would no longer count Terminal as the responsible app, and a capture step could then
        // put a Screen Recording prompt on screen at night (the "no double-forked capture runs" rule). Ctrl-C reaches the
        // whole tree through Terminal's process group; a SIGTERM to the runner is passed on as SIGINT.
        child = spawn(process.execPath, [join(ROOT, step.script), ...step.args], { cwd: ROOT, env: childEnv(process.env, cfg), stdio: ['ignore', fd, fd] });
        child.once('error', error => { child = undefined; done({ rc: 127, error: error.message }); });
        child.once('close', (rc, signal) => { child = undefined; done({ rc, signal }); });
      });
    } finally { closeSync(fd); rmSync(cfg, { recursive: true, force: true }); }
  };

  const build = async () => {
    mkdirSync(bin, { recursive: true });
    const { compileSwift } = await import('./vc7-live.mjs');
    const wanted = Object.fromEntries([[HOST_SOURCE, 'consent-host'], [HELPER_SOURCE, 'capture-helper'], [RECORDER_SOURCE, 'capture-recorder']].map(([s, n]) => [n, { source: s, sha: sha(s) }]));
    const built = existsSync(join(bin, 'sources.json')) ? json(join(bin, 'sources.json')) : {};
    await Promise.all(Object.entries(wanted).map(async ([name, { source, sha: hash }]) => {
      if (built[name] === hash && existsSync(join(bin, name))) return;
      log(`build ${name}`);
      await compileSwift(source, join(bin, name));
      built[name] = hash;
    }));
    atomic(join(bin, 'sources.json'), JSON.stringify(built, null, 2) + '\n');
    return { rc: 0 };
  };

  log(`VC7 night run at ${head.slice(0, 12)} into ${tilde(out)}; estimate ${estimate(steps)} min`);
  try {
    for (const step of steps) {
      if (interrupted) break;
      if (markers[step.id] && outcome(markers[step.id].rc).done) { log(`skip ${step.id} (${markers[step.id].status})`); continue; }
      let result, started;
      for (let attempt = 1; attempt <= BUSY_RETRIES + 1; attempt++) {
        // Wait out another project's window and any other live run; their input isn't the owner's.
        let waited = false;
        while (!interrupted && (existsSync(HOLD) || existsSync(LOCK))) {
          if (!waited) log(`waiting: ${existsSync(HOLD) ? HOLD : LOCK} exists`);
          waited = true;
          await sleep(10000);
        }
        if (interrupted) break;
        if (waited) watch.quiet();
        const back = await watch.check();
        if (back.back) { stoppedFor = ownerWords(back); break; }
        started = Date.now();
        log(`start ${step.id}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
        try { result = step.internal ? await build() : await runStep(step); }
        catch (error) { result = { rc: 1, error: error.message }; log(`${step.id}: ${tilde(error.message)}`); }
        watch.quiet();
        await sweep();
        if (!outcome(result.rc, result.signal).retry) break;
        log(`${step.id} found the Mac busy; waiting before attempt ${attempt + 1}`);
        await sleep(30000);
      }
      if (stoppedFor || !result) break;
      const meaning = outcome(result.rc, result.signal);
      const text = step.internal ? '' : readFileSync(join(out, `${step.id}.log`), 'utf8');
      markers[step.id] = { rc: result.rc ?? null, ...(result.signal ? { signal: result.signal } : {}), status: meaning.status,
        minutes: Math.round((Date.now() - started) / 6000) / 10, endedAt: new Date().toISOString(),
        ...(resultLine(text) ? { result: resultLine(text) } : result.error ? { result: result.error.slice(0, 200) } : {}) };
      atomic(join(markersDir, `${step.id}.json`), JSON.stringify(markers[step.id], null, 2) + '\n');
      log(`end ${step.id}: ${meaning.status}${markers[step.id].result ? `: ${markers[step.id].result}` : ''}`);
      if (step.internal && result.rc !== 0) { log('the build failed; no check can run'); break; }
      if (meaning.stop) { if (result.rc === 4) stoppedFor = 'the speed A/B saw the owner return'; break; }
    }
  } finally {
    if (child) { try { child.kill('SIGKILL'); } catch {} }
    await sweep().catch(error => log(`cleanup: ${tilde(error.message)}`));
    if (stoppedFor) { writeFileSync(join(out, 'STOPPED-owner'), stoppedFor + '\n'); log(`stopped: ${stoppedFor}`); }
    const md = summaryMarkdown(state, markers, steps, { stoppedFor });
    writeFileSync(join(out, 'summary.md'), md);
    log(`summary: ${tilde(join(out, 'summary.md'))}`);
  }
  if (interrupted) return interrupted;
  if (stoppedFor) return 4;
  return steps.every(step => markers[step.id] && outcome(markers[step.id].rc).done) ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
