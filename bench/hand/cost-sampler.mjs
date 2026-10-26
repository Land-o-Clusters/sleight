// H6's sampler: the ghost hand host's CPU and memory and WindowServer's CPU, once a second, from ps. It counts only hand
// hosts started under one process tree (the benchmark pass it watches), so the owner's own sessions' hands stay out.
// WindowServer is shared, so its figure is the whole Mac's; the cost pass alternates hand on and off to compare like with like.
// Measured from fable-1018-ghost-hand.md section 2: `ps -o cputime,rss` per host and WindowServer CPU per interval.
import { execFile } from 'node:child_process';
import { cpuSeconds } from '../footprint.mjs';

const defaultPs = () => new Promise(resolve => execFile('/bin/ps', ['-A', '-o', 'pid=,ppid=,time=,rss=,command='],
  { maxBuffer: 16 << 20 }, (error, out) => resolve(error ? '' : out)));

export const isHandHost = command => /\/consent-host(\s|$)/.test(command) && /\s--hand(\s|$)/.test(command);
export const isWindowServer = command => /\/WindowServer(\s|$)/.test(command);
/** The cursor style a hand host was started with (VC2B's --cursor-style=), glove without the flag. */
export const hostStyle = command => /\s--cursor-style=([a-z]+)(\s|$)/.exec(command)?.[1] ?? 'glove';

/** ps rows: { pid, ppid, cpu (seconds), rssKb, command }. */
export function parsePs(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: cpuSeconds(m[3]), rssKb: Number(m[4]), command: m[5] });
  }
  return rows;
}

/** start() takes the first sample and samples every intervalMs; stop() takes a last one and returns the samples:
 *  [{ t, ws, hosts: { pid: { cpu, rssKb } } }]. Hosts are consent-host --hand processes below rootPid, kept by pid after
 *  their parent goes. */
export function createCostSampler({ rootPid, ps = defaultPs, now = Date.now, intervalMs = 1000 } = {}) {
  const samples = [], members = new Set([rootPid].filter(Number.isSafeInteger)), hosts = new Set();
  let timer, chain = Promise.resolve();
  const sample = () => chain = chain.then(async () => {
    const rows = parsePs(await ps());
    for (let grew = true; grew;) {
      grew = false;
      for (const row of rows) if (!members.has(row.pid) && members.has(row.ppid)) { members.add(row.pid); grew = true; }
    }
    const entry = { t: now(), ws: undefined, hosts: {} };
    for (const row of rows) {
      if (isWindowServer(row.command)) entry.ws = row.cpu;
      if (isHandHost(row.command) && (members.has(row.pid) || hosts.has(row.pid))) {
        hosts.add(row.pid);
        entry.hosts[row.pid] = { cpu: row.cpu, rssKb: row.rssKb, style: hostStyle(row.command) };
      }
    }
    samples.push(entry);
  });
  return {
    samples,
    start() { const first = sample(); timer = setInterval(sample, intervalMs); timer.unref?.(); return first; },
    sample,
    async stop() { clearInterval(timer); await sample(); return samples; },
  };
}

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)];
};

/** The cost over [from, to] (ms, the samples' clock; the whole run when left out). A host first seen after the window's
 *  first sample started inside it and counts from 0, as footprint.mjs counts late processes. */
export function summarize(samples, { from = -Infinity, to = Infinity } = {}) {
  const inside = samples.filter(s => s.t >= from && s.t <= to);
  if (inside.length < 2) return { wallS: 0, samples: inside.length, windowServer: null, hand: null };
  const first = inside[0], last = inside.at(-1), wallS = (last.t - first.t) / 1000;
  const ws = inside.filter(s => Number.isFinite(s.ws));
  const intervals = [];
  for (let i = 1; i < ws.length; i++) {
    const seconds = (ws[i].t - ws[i - 1].t) / 1000;
    if (seconds > 0) intervals.push((ws[i].ws - ws[i - 1].ws) / seconds * 100);
  }
  const windowServer = ws.length >= 2 ? { cpuS: round(ws.at(-1).ws - ws[0].ws), avgPct: round((ws.at(-1).ws - ws[0].ws) / ((ws.at(-1).t - ws[0].t) / 1000) * 100),
    peakPct: round(Math.max(...intervals)), p95Pct: round(percentile(intervals, 95)) } : null;
  const pids = [...new Set(inside.flatMap(s => Object.keys(s.hosts)))];
  let cpuS = 0, peakKb = 0, busy = 0, live = 0;
  const styles = [...new Set(inside.flatMap(s => Object.values(s.hosts).map(h => h.style).filter(Boolean)))].sort();
  for (const pid of pids) {
    const seen = inside.filter(s => s.hosts[pid]);
    const start = seen[0] === first ? seen[0].hosts[pid].cpu : 0;
    cpuS += seen.at(-1).hosts[pid].cpu - start;
    peakKb = Math.max(peakKb, ...seen.map(s => s.hosts[pid].rssKb));
  }
  for (let i = 1; i < inside.length; i++) {
    const now = inside[i].hosts, before = inside[i - 1].hosts;
    const alive = Object.keys(now).filter(pid => before[pid]);
    if (!alive.length) continue;
    live++;
    if (alive.some(pid => now[pid].cpu > before[pid].cpu)) busy++;
  }
  return { wallS: round(wallS), samples: inside.length, windowServer,
    hand: { hosts: pids.length, cpuS: round(cpuS), avgPct: wallS > 0 ? round(cpuS / wallS * 100, 3) : null, peakRssMB: round(peakKb / 1024, 1),
      liveIntervals: live, idleIntervals: live - busy, styles } };
}
