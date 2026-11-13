import { execFileSync } from 'node:child_process';

// Only called for the ChildProcess returned by this relay's fork. Retaining the
// handle until exit also prevents a reaped child's recycled pid from being used.
export function workerProcessIdentity(pid, { run = execFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    const text = run('/bin/ps', ['-o', 'pid=,ppid=,lstart=', '-p', String(pid)],
      { encoding: 'utf8', timeout: 500, maxBuffer: 1024, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, killSignal: 'SIGKILL' }).trim();
    const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(text);
    if (match && Number(match[1]) === pid && Number(match[2]) === process.pid && Number.isFinite(Date.parse(match[3])))
      return { pid, start: match[3] };
  } catch {}
}

// Capture birth immediately after fork, before any worker frame is trusted.
// Missing identity fails closed: the channel can close, but no signal is sent.
export function ownWorkerProcess(child, { identity = workerProcessIdentity } = {}) {
  let exited = child.exitCode != null || child.signalCode != null, stopping, settle;
  const timers = [];
  const finish = () => {
    for (const timer of timers) clearTimeout(timer);
    if (!exited) child.unref?.();
    settle?.();
  };
  child.once('exit', () => { exited = true; finish(); });
  const pid = child.pid;
  const read = () => { try { return identity(pid); } catch {} };
  const birth = Number.isSafeInteger(pid) && pid > 0 ? read() : undefined;
  const owned = !!birth && birth.pid === pid && typeof birth.start === 'string' && birth.start.length > 0;
  const signal = name => {
    if (exited || child.pid !== pid || child.exitCode != null || child.signalCode != null) { finish(); return; }
    const live = read();
    if (!owned || live?.pid !== pid || live.start !== birth.start) { finish(); return; }
    try { child.kill(name); } catch {}
  };
  return Object.freeze({ stop(close, { graceful = false } = {}) {
    if (stopping) return stopping;
    stopping = new Promise(resolve => { settle = resolve; });
    if (exited) { finish(); return stopping; }
    // Close is out of band in the worker, so even a call awaiting a card drains.
    try { close(); } catch {}
    if (!exited && owned) {
      // Healthy close drains CDP, Playwright and the Electron connection first.
      const grace = graceful ? 1000 : 0;
      timers.push(setTimeout(() => signal('SIGTERM'), 500 + grace));
      timers.push(setTimeout(() => signal('SIGKILL'), 1500 + grace));
      timers.push(setTimeout(finish, 2500 + grace));
    } else finish();
    return stopping;
  } });
}
