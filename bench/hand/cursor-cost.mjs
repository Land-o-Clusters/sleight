#!/usr/bin/env node
// VC7 check 3, the agent cursor's idle and active cost. For ring, seam and sprite it starts the hand host (the product's
// build flags, hidden capture, no menu item) over a TextEdit fixture, plays the scripted 30-action sequence
// (cursor-sequence.mjs: aim, act and thinking frames as the relay sends them), then leaves it 60 s idle. cost-sampler.mjs
// samples the host's CPU and RSS and WindowServer's CPU once a second. Two phases with no host, one before and one after,
// play the same timeline and give WindowServer's baseline.
//
// Budgets (VC7 brief, R1 section 5): peak RSS 50 MiB for ring and seam and 64 MiB for sprite; host CPU under 1% averaged
// over the sequence; no host CPU at all in the idle minute once the park and fade are over (SETTLE_MS after the last
// frame); WindowServer under 2% added on average and under 10% added at its busiest second, against the baseline phases.
//
//   node bench/hand/cursor-cost.mjs --owner-away [--styles ring,seam,sprite] [--out DIR] [--host PATH] [--helper PATH]
//        [--receipt PATH] [--dry-run]
//
// Exit 0: every style within its budget. 1: a style over or not measured. 2: setup refused. 3: busy.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { summarize } from './cost-sampler.mjs';
import { autoSequence } from './cursor-sequence.mjs';
import { ROOT, tilde, stamp, logsRoot, commonArgs, liveRefusal, hostArgs, playRect } from './vc7-live.mjs';

export const STYLES = Object.freeze(['ring', 'seam', 'sprite']);
export const ACTIONS = 30;
export const SPACING_MS = 1300;
export const IDLE_MS = 60000;
// The longest plan the sequence draws ends within about 1.5 s; the ring then parks, fades after its 1.2 s silence (0.22 s,
// RingTheme) and releases. 6 s leaves room for a slow last frame.
export const SETTLE_MS = 6000;
export const COST_BUDGET = Object.freeze({ rssMiB: 50, spriteRssMiB: 64, hostAvgPct: 1, idleHostCpuS: 0, wsAddedPct: 2, wsAddedPeakPct: 10 });
export const rssBudget = (style, budget = COST_BUDGET) => style === 'sprite' ? budget.spriteRssMiB : budget.rssMiB;

/** The phases in order: a baseline, each style, a baseline. */
export const phases = (styles = STYLES) => [{ id: 'baseline-1', style: null }, ...styles.map(style => ({ id: style, style })), { id: 'baseline-2', style: null }];

/** One phase's figures from its samples and its marks ({ start, activeEnd, idleEnd } in the samples' ms clock). */
export function phaseFigures(samples, { start, activeEnd, idleEnd }) {
  const active = summarize(samples, { from: start, to: activeEnd });
  const settled = idleEnd ? summarize(samples, { from: activeEnd + SETTLE_MS, to: idleEnd }) : null;
  const whole = summarize(samples, { from: start, to: idleEnd ?? activeEnd });
  return {
    activeS: active.wallS, idleS: settled?.wallS ?? 0,
    wsAvgPct: active.windowServer?.avgPct ?? null, wsPeakPct: active.windowServer?.peakPct ?? null,
    hostAvgPct: active.hand?.avgPct ?? null, hostCpuS: active.hand?.cpuS ?? null,
    // null when no host was alive through the idle minute: a host that died must not read as idle.
    idleHostCpuS: settled?.hand?.hosts ? settled.hand.cpuS : null,
    idleIntervals: settled?.hand?.hosts ? `${settled.hand.idleIntervals} of ${settled.hand.liveIntervals}` : null,
    peakRssMiB: whole.hand?.peakRssMB ?? null, hosts: whole.hand?.hosts ?? 0,
  };
}

const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const round = (n, d = 2) => n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d;

/** Each style's budget checks against the baselines' mean. results: { [phaseId]: figures | { skipped } }. */
export function costVerdict(results, budget = COST_BUDGET) {
  const bases = Object.entries(results).filter(([id, r]) => id.startsWith('baseline') && !r.skipped && !r.error).map(([, r]) => r);
  const baseAvg = mean(bases.map(b => b.wsAvgPct).filter(Number.isFinite)), basePeak = mean(bases.map(b => b.wsPeakPct).filter(Number.isFinite));
  const styles = {};
  for (const [id, r] of Object.entries(results)) {
    if (id.startsWith('baseline')) continue;
    if (r.skipped || r.error) { styles[id] = { verdict: 'not-measured', reason: r.skipped ?? r.error, checks: [] }; continue; }
    const checks = [
      { name: 'host RSS, peak', value: r.peakRssMiB, unit: 'MiB', limit: rssBudget(id, budget), ok: v => v <= rssBudget(id, budget) },
      { name: 'host CPU over the sequence', value: r.hostAvgPct, unit: '%', limit: budget.hostAvgPct, ok: v => v < budget.hostAvgPct },
      { name: 'host CPU after the park and fade', value: r.idleHostCpuS, unit: 'CPU s', limit: budget.idleHostCpuS, ok: v => v <= budget.idleHostCpuS },
      { name: 'WindowServer added, average', value: baseAvg === null || r.wsAvgPct === null ? null : round(r.wsAvgPct - baseAvg), unit: '%', limit: budget.wsAddedPct, ok: v => v < budget.wsAddedPct },
      { name: 'WindowServer added, busiest second', value: basePeak === null || r.wsPeakPct === null ? null : round(r.wsPeakPct - basePeak), unit: '%', limit: budget.wsAddedPeakPct, ok: v => v < budget.wsAddedPeakPct },
    ].map(({ ok, ...c }) => ({ ...c, ok: c.value !== null && Number.isFinite(c.value) && ok(c.value) }));
    const invalid = r.hosts === 0 ? 'no host was sampled' : undefined;
    styles[id] = { verdict: invalid ? 'not-measured' : checks.every(c => c.ok) ? 'within' : 'over', ...(invalid ? { reason: invalid } : {}), checks };
  }
  const verdicts = Object.values(styles).map(s => s.verdict);
  return { baseline: { wsAvgPct: round(baseAvg), wsPeakPct: round(basePeak), phases: bases.length }, styles,
    verdict: !verdicts.length ? 'not-measured' : verdicts.every(v => v === 'within') ? 'within' : verdicts.includes('over') ? 'over' : 'not-measured' };
}

export function reportMarkdown(verdict, meta) {
  const lines = [`# Agent cursor cost (VC7 check 3)`, '',
    `${meta.actions} actions ${meta.spacingMs} ms apart, then ${meta.idleMs / 1000} s idle; ${meta.started} to ${meta.finished} (UTC). Verdict: **${verdict.verdict}**.`, '',
    `WindowServer baseline (no host, ${verdict.baseline.phases} phases): ${verdict.baseline.wsAvgPct ?? 'none'}% average, ${verdict.baseline.wsPeakPct ?? 'none'}% busiest second.`, ''];
  for (const [style, s] of Object.entries(verdict.styles)) {
    lines.push(`## ${style}: ${s.verdict}${s.reason ? ` (${s.reason})` : ''}`, '');
    if (!s.checks.length) continue;
    lines.push('| Check | Value | Limit | Within |', '|---|---|---|---|', ...s.checks.map(c => `| ${c.name} | ${c.value ?? 'none'} ${c.unit} | ${c.limit} ${c.unit} | ${c.ok ? 'yes' : 'no'} |`), '');
  }
  return lines.join('\n');
}

export function parseArgs(argv) {
  const common = commonArgs(argv);
  const styles = (common.value('--styles') ?? STYLES.join(',')).split(',').filter(Boolean);
  if (!styles.length || styles.some(s => !STYLES.includes(s)) || new Set(styles).size !== styles.length) throw new Error(`--styles must be a list of ${STYLES.join(', ')}`);
  return { ...common, styles };
}

export function dryRunPlan(opts, { out }) {
  const host = opts.host ?? '<work>/consent-host', est = phases(opts.styles).reduce((ms, p) => ms + (ACTIONS - 1) * SPACING_MS + 900 + (p.style ? IDLE_MS + 2000 : 1000), 0);
  return [
    `VC7 cursor cost check, styles ${opts.styles.join(', ')} (dry run: nothing opened); about ${Math.round(est / 60000 * 10) / 10} min of phases`,
    '1. refuse with /tmp/sleight-hold present, take /tmp/sleight-live.lock (no wait); refuse when TextEdit runs',
    ...(opts.host && opts.helper ? [] : ['2. build the capture helper and the hand host with xcrun swiftc (no -O, as the product)']),
    `3. /usr/bin/open -g -a TextEdit <work>/sleight-vc7-cost.txt --args -ApplePersistenceIgnoreState YES ...${opts.receipt ? `   (receipt ${tilde(opts.receipt)})` : ''}`,
    ...phases(opts.styles).map((p, i) => `${4 + i}. ${p.id}: ${p.style ? `${p.style === 'sprite' ? 'SLEIGHT_CURSOR_TEST=1 SLEIGHT_CURSOR_CHARACTERS_ROOT=<root> ' : ''}${host} ${hostArgs({ style: p.style }).join(' ')}; ` : 'no host; '}` +
      `${ACTIONS} actions every ${SPACING_MS} ms${p.style ? `, then ${IDLE_MS / 1000} s idle` : ''}; ps -A -o pid=,ppid=,time=,rss=,command= once a second`),
    `${4 + phases(opts.styles).length}. quit the TextEdit this run started; kill any host left; release the lock; report ${tilde(join(out, 'cursor-cost.md'))}`,
  ];
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) { console.error(error.message); return 2; }
  const out = resolve(opts.out ?? join(logsRoot(), `vc7-cost-${stamp()}`));
  if (opts.dryRun) { console.log(dryRunPlan(opts, { out }).join('\n')); return 0; }
  const refusal = liveRefusal(opts, 'The cursor cost check');
  if (refusal) { console.error(refusal.message); return refusal.code; }
  const { acquireLiveLock } = await import('../live-lock.mjs');
  const { underLiveLock } = await import('./h5-capture.mjs');
  return underLiveLock({ acquire: () => acquireLiveLock('/tmp/sleight-live.lock', { wait: false }) }, async ({ cleanups }) => {
    mkdirSync(out, { recursive: true });
    const work = mkdtempSync(join(tmpdir(), 'sleight-vc7-cost-'));
    cleanups.push(() => rmSync(work, { recursive: true, force: true }));
    const live = await import('../compat/live.mjs');
    const { compileSwift, helperClient, openTextEditFixture, startHandHost, killHosts, spriteSupport } = await import('./vc7-live.mjs');
    const { createCostSampler } = await import('./cost-sampler.mjs');
    const { cursorWire, playSequence } = await import('./cursor-sequence.mjs');
    const { installSyntheticCharacter, characterEnv, characterWire } = await import('./synthetic-character.mjs');
    const helperBin = opts.helper ?? join(work, 'capture-helper'), hostBin = opts.host ?? join(work, 'consent-host');
    await Promise.all([opts.helper ? undefined : compileSwift(join(ROOT, 'bench/hand/capture.swift'), helperBin),
      opts.host ? undefined : compileSwift(join(ROOT, 'plugins/sleight/lib/direct-browser/native/consent-host.swift'), hostBin)]);
    const helper = helperClient(helperBin);
    const hosts = new Set();
    cleanups.push(() => killHosts(hosts));
    let character, spriteSkip;
    if (opts.styles.includes('sprite')) {
      character = installSyntheticCharacter();
      cleanups.push(() => rmSync(character.root, { recursive: true, force: true }));
      const probe = await spriteSupport(hostBin, JSON.stringify(characterWire(character, { nonce: randomBytes(32).toString('hex'), seq: 0 })) + '\n', characterEnv(character.root));
      if (!probe.sprite) spriteSkip = probe.detail;
    }
    const { target } = await openTextEditFixture({ helper, live, work, cleanups, receipt: opts.receipt, name: 'sleight-vc7-cost.txt' });
    const sequence = autoSequence({ pid: target.pid, windowId: target.id, rect: playRect(target.bounds), count: ACTIONS, spacingMs: SPACING_MS });
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const meta = { actions: ACTIONS, spacingMs: SPACING_MS, idleMs: IDLE_MS, styles: opts.styles, started: new Date().toISOString(), finished: null };
    const results = {};
    const sampler = createCostSampler({ rootPid: process.pid });
    await sampler.start();
    for (const phase of phases(opts.styles)) {
      if (phase.style === 'sprite' && spriteSkip) { results[phase.id] = { skipped: `the sprite style can't run on this host: ${spriteSkip}` }; continue; }
      console.log(`  phase ${phase.id}`);
      let host;
      try {
        if (phase.style) {
          host = await startHandHost({ hostBin, capture: 'hidden', style: phase.style, env: phase.style === 'sprite' ? characterEnv(character.root) : {}, hosts });
          await sleep(1000);
        }
        const wire = cursorWire();
        if (phase.style === 'sprite') host.write(wire.character(character));
        const start = Date.now();
        await playSequence(sequence, { wire, write: line => host?.write(line), sleep });
        await sleep(Math.max(0, sequence.lengthMs - (Date.now() - start)) + 500);
        const activeEnd = Date.now();
        let idleEnd;
        if (phase.style) { await sleep(IDLE_MS); idleEnd = Date.now(); }
        await sleep(1100); // one more sample inside the window
        const exit = host ? await host.close() : undefined;
        results[phase.id] = { ...phaseFigures(sampler.samples, { start, activeEnd, idleEnd }), ...(exit && exit.code !== 0 && exit.signal !== 'SIGKILL' ? { hostExit: exit.code ?? exit.signal } : {}) };
        if (exit && exit.code === 65) results[phase.id].error = 'the host refused a frame (exit 65)';
      } catch (error) {
        results[phase.id] = { error: String(error.message).slice(0, 200) };
        if (host) await host.close().catch(() => {});
      }
    }
    await sampler.stop();
    meta.finished = new Date().toISOString();
    const verdict = costVerdict(results);
    writeFileSync(join(out, 'cursor-cost.json'), JSON.stringify({ meta, results, verdict, samples: sampler.samples }, null, 2) + '\n');
    const md = reportMarkdown(verdict, meta);
    writeFileSync(join(out, 'cursor-cost.md'), md);
    console.log(md);
    console.log(`VC7 RESULT: cursor cost ${verdict.verdict}; ${Object.entries(verdict.styles).map(([s, v]) => `${s} ${v.verdict}`).join(', ')}`);
    return verdict.verdict === 'within' ? 0 : 1;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
