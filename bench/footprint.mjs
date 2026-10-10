// CPU seconds a benchmark run costs the Mac: every process in the driver's own process group (Claude
// Code or Codex, and what they start: sleight's relay, the engine, helpers), plus the shared engine
// helper and the target app, which run outside it. Sampled with ps once a second. A process that
// exits between samples loses at most its last second.
import { execFile } from 'node:child_process';

const defaultPs = () => new Promise(resolve => execFile('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,time=,comm='],
  { maxBuffer: 16 << 20 }, (error, out) => resolve(error ? '' : out)));

// ps TIME is [[dd-]hh:]mm:ss.ss.
export function cpuSeconds(time) {
  const [days, rest] = time.includes('-') ? time.split('-') : ['0', time];
  return Number(days) * 86400 + rest.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

// What a process is, for the totals: the engine's own node, sleight's helpers, or the executable's name.
export function label(command) {
  if (command.includes('/cua_node/')) return 'engine node';
  if (/SkyComputerUse|Codex Computer Use/.test(command)) return 'engine helper';
  if (command.endsWith('/osascript')) return 'osascript';
  return command.split('/').pop();
}

export function startFootprint({ pgid, rootPid, apps = [], intervalMs = 1000, ps = defaultPs, baselineGroup = false }) {
  const seen = new Map(); // pid -> { label, group, first, last }
  let sampling = Promise.resolve(), firstSample = true;
  // Descendants of the group count as the group: Codex starts its engine server in a process group
  // of its own (2026-10-09), which a group-only sample missed.
  const members = new Set(rootPid === undefined ? [] : [String(rootPid)]);
  const sample = () => sampling = sampling.then(async () => {
    const rows = [];
    for (const line of (await ps()).split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
      if (m) rows.push({ pid: m[1], ppid: m[2], group: Number(m[3]), time: m[4], command: m[5] });
    }
    if (baselineGroup && !rows.some(row => row.group === pgid)) return false;
    for (const row of rows) if (row.group === pgid) members.add(row.pid);
    for (let grew = true; grew;) {
      grew = false;
      for (const row of rows) if (!members.has(row.pid) && members.has(row.ppid)) { members.add(row.pid); grew = true; }
    }
    for (const { pid, time, command } of rows) {
      const inGroup = members.has(pid);
      const name = label(command);
      const outside = name === 'engine helper' || apps.some(app => command.endsWith(`/${app}`));
      if (!inGroup && !outside) continue;
      const cpu = cpuSeconds(time), entry = seen.get(pid);
      // Whole-run measurements count all group CPU. Warm phases subtract the initial sample for
      // existing group members too. Anything first seen later counts from its start.
      if (entry) entry.last = cpu;
      else seen.set(pid, { label: name, group: inGroup, first: (inGroup && !baselineGroup) || !firstSample ? 0 : cpu, last: cpu });
    }
    firstSample = false;
    return true;
  });
  const ready = sample().then(observed => {
    if (!observed) throw new Error('Warm CPU baseline unavailable; no driver group observed');
  });
  const timer = setInterval(sample, intervalMs);
  const snapshot = async () => {
    if (!await sample()) throw new Error('Warm CPU final sample unavailable; no driver group observed');
    const group = {}, outside = {};
    for (const entry of seen.values()) {
      const into = entry.group ? group : outside;
      into[entry.label] = Math.round(((into[entry.label] ?? 0) + entry.last - entry.first) * 100) / 100;
    }
    const total = [...Object.values(group), ...Object.values(outside)].reduce((a, b) => a + b, 0);
    return { cpuSeconds: Math.round(total * 100) / 100, group, outside };
  };
  const stop = () => { clearInterval(timer); return snapshot(); };
  stop.snapshot = snapshot;
  stop.ready = ready;
  return stop;
}
