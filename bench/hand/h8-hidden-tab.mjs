#!/usr/bin/env node
// H8's live check (ledger/p130/h8-REPORT.md "Needs a live check", live-runbook-1019.md step 6): in a real Chrome turbo
// round with the ghost hand on, turbo's tabs open in the background, so every hand step should skip as hidden-tab and none
// should draw. A step that draws means a background tab reported visibilityState visible while Playwright's focus emulation
// was on, and the hand would have drawn over whatever tab the person has in front. The worker writes hand-skipped and
// hand-shown events (operation and reason only) to SLEIGHT_TRACE (lib/hand/browser-hand.mjs workerHandTrace).
//
//   node bench/hand/h8-hidden-tab.mjs <trace dir>...                     read a round's trace folder(s)
//   node bench/hand/h8-hidden-tab.mjs --run --owner-away --out DIR [--only demoid] [--model haiku]
//        one Chrome turbo round with SLEIGHT_BENCH_HAND=1 and SLEIGHT_TRACE=DIR.trace (bench/fowl/rounds.sh), then the read
//
// Exit 0: pass. 1: fail or inconclusive. 2: usage or setup.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Counts from trace lines: hand-skipped by reason, hand-shown by operation, and turbo-phase lines (proof the worker traced). */
export function readHandEvents(lines) {
  const skipped = {}, shown = {};
  let phases = 0;
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.direction === 'turbo-phase') phases++;
    else if (e.direction === 'hand-skipped') skipped[e.msg?.reason ?? 'unknown'] = (skipped[e.msg?.reason ?? 'unknown'] ?? 0) + 1;
    else if (e.direction === 'hand-shown') shown[e.msg?.op ?? 'unknown'] = (shown[e.msg?.op ?? 'unknown'] ?? 0) + 1;
  }
  const sum = o => Object.values(o).reduce((a, b) => a + b, 0);
  return { phases, skipped, shown, skips: sum(skipped), draws: sum(shown) };
}

/** pass: hidden-tab skips and no draws. fail: a draw. inconclusive: no hand event at all (says why it can tell). */
export function hiddenTabVerdict(events) {
  if (events.draws > 0) {
    return { verdict: 'fail', words: `the hand drew for ${events.draws} turbo step(s) (${Object.entries(events.shown).map(([k, v]) => `${k} ${v}`).join(', ')}). ` +
      "Unless turbo's tab was the one in front, a background tab reported visible under focus emulation: the hidden-tab skip doesn't hold" };
  }
  if (!events.skips) {
    return { verdict: 'inconclusive', words: events.phases
      ? 'the worker traced, but its hand never ran: check sleight-mcp hand status, the host build and SLEIGHT_BENCH_HAND=1'
      : 'no turbo trace at all: SLEIGHT_TRACE did not reach the worker, or the round made no turbo call' };
  }
  if (!events.skipped['hidden-tab']) {
    return { verdict: 'inconclusive', words: `the hand skipped ${events.skips} step(s), none as hidden-tab (${Object.entries(events.skipped).map(([k, v]) => `${k} ${v}`).join(', ')})` };
  }
  return { verdict: 'pass', words: `${events.skipped['hidden-tab']} of ${events.skips} step(s) skipped as hidden-tab and none drew: background tabs report hidden under focus emulation` };
}

export function traceLines(dirs) {
  const lines = [];
  for (const dir of dirs) {
    let files = [];
    try { files = readdirSync(dir).filter(f => /^trace-\d+\.jsonl$/.test(f)); } catch { continue; }
    for (const file of files) lines.push(...readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean));
  }
  return lines;
}

export function roundCommand({ out, only = 'demoid', model = 'haiku' }) {
  return { command: join(ROOT, 'bench/fowl/rounds.sh'), args: ['--world', '--real-browser', 'chrome', '--surface', 'sleight-turbo', '--model', model,
    '--effort', 'high', '--only', only, '--out', out], env: { DISABLE_AUTOUPDATER: '1', SLEIGHT_NO_HUB: '1', SLEIGHT_BENCH_HAND: '1', SLEIGHT_TRACE: `${out}.trace` } };
}

async function main(argv) {
  const value = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  let dirs = argv.filter((arg, i) => !arg.startsWith('--') && !['--out', '--only', '--model'].includes(argv[i - 1]));
  if (argv.includes('--run')) {
    const out = value('--out');
    if (!argv.includes('--owner-away')) { console.error('--run drives a Chrome turbo round with the hand on: pass --owner-away'); return 2; }
    if (!out) { console.error('--run needs --out DIR'); return 2; }
    const { handSetting } = await import('../../plugins/sleight/lib/hand/settings.mjs');
    if (!handSetting({ env: {} }).enabled) { console.error('The ghost hand is off: run plugins/sleight/bin/sleight-mcp hand on first'); return 2; }
    const { handHostBuilt, prepareHandHost } = await import('../../plugins/sleight/lib/direct-browser/host.mjs');
    if (!handHostBuilt() && (await prepareHandHost()).status !== 'ready') { console.error('The hand host did not build'); return 2; }
    const plan = roundCommand({ out: resolve(out), only: value('--only'), model: value('--model') });
    mkdirSync(plan.env.SLEIGHT_TRACE, { recursive: true });
    while (existsSync('/tmp/sleight-hold') || existsSync('/tmp/sleight-live.lock')) await new Promise(r => setTimeout(r, 20000));
    console.log(`Running one Chrome turbo round with the hand on: ${plan.args.join(' ')}`);
    const code = await new Promise(done => spawn(plan.command, plan.args, { cwd: ROOT, env: { ...process.env, ...plan.env }, stdio: 'inherit' }).once('close', done));
    if (code !== 0) console.error(`The round exited ${code}; reading its trace anyway`);
    dirs = [plan.env.SLEIGHT_TRACE];
  }
  if (!dirs.length) { console.error('usage: node bench/hand/h8-hidden-tab.mjs <trace dir>... | --run --owner-away --out DIR'); return 2; }
  const events = readHandEvents(traceLines(dirs));
  const result = hiddenTabVerdict(events);
  console.log(JSON.stringify({ ...result, ...events }, null, 2));
  return result.verdict === 'pass' ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
