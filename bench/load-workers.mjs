import { spawn } from 'node:child_process';

// Own every worker immediately, including failed spawns, and make cleanup safe to repeat.
export function startLoadWorkers(count, { onError = () => {}, spawnWorker = () =>
  spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' }) } = {}) {
  const workers = [], completions = [];
  let stopping;
  for (let i = 0; i < count; i++) {
    let child;
    try { child = spawnWorker(); }
    catch (error) { completions.push(Promise.resolve({ error: error.message })); onError(error); break; }
    const entry = { child, closed: false };
    workers.push(entry);
    completions.push(new Promise(resolve => child.once('close', (code, signal) => {
      entry.closed = true; resolve({ code, signal, ...(entry.error ? { error: entry.error } : {}) });
    })));
    child.on('error', error => { entry.error = error.message; onError(error); });
  }
  return () => stopping ||= (async () => {
    for (const entry of workers) if (!entry.closed) entry.child.kill('SIGTERM');
    return Promise.all(completions);
  })();
}
