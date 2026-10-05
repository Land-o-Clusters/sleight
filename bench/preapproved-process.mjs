import { spawn } from 'node:child_process';

// A fresh process group contains only this driver's Claude and its descendants.
// Return after close, which also collects inherited output pipes.
export async function runOwned(command, args, { cwd, timeoutMs = 180000, graceMs = 7000, signal, onStdout } = {}) {
  const child = spawn(command, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', spawnError, timedOut = false, cancelled = false, stopping = false, force;
  child.stdout.on('data', data => { stdout += data; onStdout?.(data); });
  child.stderr.on('data', data => { stderr += data; });
  function signalGroup(name) {
    if (!child.pid) return;
    try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  function stop() {
    if (stopping) return;
    stopping = true;
    signalGroup('SIGTERM');
    force = setTimeout(() => signalGroup('SIGKILL'), graceMs);
  }
  const abort = () => { cancelled = true; stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  child.on('error', error => { spawnError = error.message; });
  const exit = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  clearTimeout(timer); clearTimeout(force); signal?.removeEventListener('abort', abort);
  const alive = async () => {
    if (!child.pid) return false;
    const deadline = Date.now() + graceMs;
    for (;;) {
      try { process.kill(-child.pid, 0); return true; } catch (error) {
        if (error.code === 'ESRCH') return false;
        // After close, macOS can briefly deny a probe of the dying group.
        // A denial never proves collection: retry within the cleanup budget,
        // then fail unless the OS confirms absence or a signalable group.
        if (error.code !== 'EPERM' || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  };
  // Redirected descendant stdio can close before the group exits. Finish that
  // group too, before the caller releases the app-driving lock.
  if (await alive()) {
    signalGroup('SIGTERM');
    let deadline = Date.now() + graceMs;
    while (await alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (await alive()) {
      signalGroup('SIGKILL'); deadline = Date.now() + graceMs;
      while (await alive() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  return { exit, timedOut, cancelled, spawnError, stdout, stderr, groupClean: !await alive() };
}
