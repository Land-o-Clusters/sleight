import { spawn } from 'node:child_process';

// A fresh process group contains only this driver's Claude and its descendants.
// Return after close, which also collects inherited output pipes.
export async function runOwned(command, args, { cwd, env, timeoutMs = 180000, graceMs = 7000, signal, onStdout, onSpawn } = {}) {
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // The new process group's ID, which is the leader's pid (detached).
  if (child.pid) onSpawn?.(child.pid);
  let leaderExited = false, groupCollected = false;
  child.once('exit', () => { leaderExited = true; });
  let stdout = '', stderr = '', spawnError, timedOut = false, cancelled = false, stopping = false, force;
  child.stdout.on('data', data => { stdout += data; onStdout?.(data); });
  child.stderr.on('data', data => { stderr += data; });
  function collected(error) {
    if (error.code !== 'ESRCH' && !(leaderExited && error.code === 'EPERM')) return false;
    // After the owned leader exits, macOS can report a dying or reused group
    // as EPERM. Stop probing or signaling that group once collection is known.
    if (leaderExited) groupCollected = true;
    return true;
  }
  function signalGroup(name) {
    if (!child.pid || groupCollected) return;
    try { process.kill(-child.pid, name); } catch (error) { if (!collected(error)) throw error; }
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
  const alive = () => {
    if (!child.pid || groupCollected) return false;
    try { process.kill(-child.pid, 0); return true; } catch (error) {
      if (collected(error)) return false;
      throw error;
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
