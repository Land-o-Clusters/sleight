// H6's sampler: the ghost hand host's CPU and memory and WindowServer's CPU, once a second, from ps. It counts only hand
// hosts started under one process tree (the benchmark pass it watches), so the owner's own sessions' hands stay out.
// WindowServer is shared, so its figure is the whole Mac's; the cost pass alternates hand on and off to compare like with like.
// Measured from fable-1018-ghost-hand.md section 2: `ps -o cputime,rss` per host and WindowServer CPU per interval.
import { execFile } from 'node:child_process';
import { cpuSeconds } from '../footprint.mjs';

const defaultPs = () => new Promise(resolve => execFile('/bin/ps', ['-A', '-o', 'pid=,ppid=,time=,rss=,command='],
  { maxBuffer: 16 << 20, timeout: 5000, killSignal: 'SIGKILL' }, (error, out) => resolve(error ? '' : out)));

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

/** Stock --hand has no bench counter channel. RSS-only mode sums the live tree from this one census.
 * CPU here is the parent's ps value, never a claim about collected children. Commands are classified, not saved. */
export function liveRssTree(rows, pid) {
  const root = rows.find(row => row.pid === pid && isHandHost(row.command));
  if (!root) return null;
  const members = new Set([pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (!members.has(row.pid) && members.has(row.ppid)) { members.add(row.pid); grew = true; }
  }
  const tree = rows.filter(row => members.has(row.pid)).sort((a, b) => a.pid - b.pid);
  return { selfRssKb: root.rssKb, rssKb: tree.reduce((n, row) => n + row.rssKb, 0),
    rssTree: tree.map(row => ({ pid: row.pid, ppid: row.ppid, rssKb: row.rssKb,
      kind: row.pid === pid ? 'host' : /\s--decode-sheet(?:\s|$)/.test(row.command) ? 'decode' :
        /\s--stage-call-worker(?:\s|$)/.test(row.command) ? 'worker' : 'other' })) };
}

/** start() takes the first sample and samples every intervalMs; stop() takes a last one and returns the samples:
 *  [{ t, ws, hosts: { pid: { cpu, rssKb } } }]. Hosts are consent-host --hand processes below rootPid, kept by pid after
 *  their parent goes. */
export function createCostSampler({ rootPid, ps = defaultPs, now = Date.now, intervalMs = 1000, observe, includeChildren = false } = {}) {
  const samples = [], members = new Set([rootPid].filter(Number.isSafeInteger)), hosts = new Set();
  let timer, stopping, chain = Promise.resolve();
  const sample = ({ observer = observe } = {}) => chain = chain.then(async () => {
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
    if (observer) {
      try { entry.status = await observer(); }
      catch (error) { entry.status = null; entry.statusError = String(error?.message ?? error).slice(0, 512); }
    }
    if (includeChildren === 'rss') {
      // Bind to this host, excluding another --hand descendant (and all foreign sessions).
      const tree = liveRssTree(rows, rootPid), host = entry.hosts[rootPid];
      entry.hosts = tree && host ? { [rootPid]: { ...host, ...tree } } : {};
      entry.rssTreeMeasured = Boolean(tree && host);
    } else if (includeChildren) {
      const tree = entry.status?.processTree;
      const valid = entry.status?.pid === rootPid && tree && ['cpuS', 'selfCpuS', 'childrenCpuS', 'rssKb', 'packageWakeups', 'interruptWakeups',
        'childrenPackageWakeups', 'childrenInterruptWakeups', 'querySpawns'].every(k =>
        Number.isFinite(tree[k]) && tree[k] >= 0);
      entry.processTreeMeasured = Boolean(valid);
      // The kernel includes collected children; a child which lives between polls is still charged.
      // A failed tree read must never silently fall back to the host-only figure.
      if (!valid) entry.hosts = {};
      else if (entry.hosts[rootPid]) entry.hosts[rootPid] = { ...entry.hosts[rootPid], selfRssKb: entry.hosts[rootPid].rssKb,
        cpu: tree.cpuS, rssKb: tree.rssKb, tree };
    }
    samples.push(entry);
  });
  return {
    samples,
    start() { const first = sample(); timer = setInterval(sample, intervalMs); timer.unref?.(); return first; },
    sample,
    // Drain an in-flight observation before starting an interval with no observer traffic.
    pause() { clearInterval(timer); return chain; },
    stop({ finalSample = true } = {}) { clearInterval(timer); return stopping ??= (finalSample ? sample() : chain).then(() => samples); },
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
export function summarize(samples, { from = -Infinity, to = Infinity, peakSamplePeriodMs = 0 } = {}) {
  const inside = samples.filter(s => s.t >= from && s.t <= to);
  if (inside.length < 2) return { wallS: 0, samples: inside.length, windowServer: null, hand: null };
  const first = inside[0], last = inside.at(-1), wallS = (last.t - first.t) / 1000;
  const ws = inside.filter(s => Number.isFinite(s.ws));
  const parts = [];
  for (let i = 1; i < ws.length; i++) {
    const seconds = (ws[i].t - ws[i - 1].t) / 1000;
    // Ordinary jitter remains. Only the final raw sub-half-period interval is a tail.
    const shortTail = i === ws.length - 1 && seconds * 1000 < peakSamplePeriodMs / 2;
    if (seconds > 0 && !shortTail) parts.push({ seconds, cpu: ws[i].ws - ws[i - 1].ws });
  }
  const merged = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i], short = part.seconds * 1000 < peakSamplePeriodMs / 2;
    // Retain each interior observation, including one immediately before the excluded terminal tail.
    const neighbor = short ? parts[i + 1] ?? merged.at(-1) : null;
    if (neighbor) { neighbor.seconds += part.seconds; neighbor.cpu += part.cpu; }
    else merged.push(part);
  }
  const intervals = merged.map(part => part.cpu / part.seconds * 100);
  const windowServer = ws.length >= 2 ? { cpuS: round(ws.at(-1).ws - ws[0].ws), avgPct: round((ws.at(-1).ws - ws[0].ws) / ((ws.at(-1).t - ws[0].t) / 1000) * 100),
    peakPct: intervals.length ? round(Math.max(...intervals)) : null, p95Pct: intervals.length ? round(percentile(intervals, 95)) : null,
    ...(peakSamplePeriodMs ? { runnerUpPct: intervals.length >= 2 ? round([...intervals].sort((a, b) => b - a)[1]) : null } : {}) } : null;
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
  let processTree;
  if (pids.length === 1 && inside.every(s => s.hosts[pids[0]]?.tree)) {
    const a = first.hosts[pids[0]].tree, b = last.hosts[pids[0]].tree;
    const delta = key => round(b[key] - a[key], 6);
    processTree = { selfCpuS: delta('selfCpuS'), childrenCpuS: delta('childrenCpuS'), packageWakeups: delta('packageWakeups'),
      interruptWakeups: delta('interruptWakeups'), childrenPackageWakeups: delta('childrenPackageWakeups'),
      childrenInterruptWakeups: delta('childrenInterruptWakeups'), querySpawns: delta('querySpawns'), querySpawnsPerS: round(delta('querySpawns') / wallS, 6) };
  }
  return { wallS: round(wallS), samples: inside.length, windowServer,
    hand: { hosts: pids.length, cpuS: round(cpuS), avgPct: wallS > 0 ? round(cpuS / wallS * 100, 3) : null, peakRssMB: round(peakKb / 1024, 1),
      liveIntervals: live, idleIntervals: live - busy, styles, ...(processTree ? { processTree } : {}) } };
}
