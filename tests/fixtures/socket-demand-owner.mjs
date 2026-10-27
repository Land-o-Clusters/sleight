import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnDetachedSession } from '../../plugins/sleight/lib/socket-bridge.mjs';

export async function demandWait(promise, waiting, ms = 5000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms waiting for ${waiting}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function sessionLog(directory) {
  try { return readFileSync(join(directory, 'session.log'), 'utf8'); }
  catch { return '(no session.log)'; }
}

// Register ownership before readiness or any assertion can fail. IPC also closes on parent death.
export function spawnDemand(f, options = {}) {
  return demandWait(spawnDetachedSession({ directory: f.directory,
    args: [fileURLToPath(new URL('socket-demand.mjs', import.meta.url)), f.directory,
      ...(options.fixtureArgs ?? [])],
    ...options,
    spawnChild(command, args, settings) {
      options.observe?.(settings);
      const child = spawn(command, args, { ...settings, stdio: [...settings.stdio, 'ipc'] });
      // Spawn is not admission. Wait for readiness or rejection while the winner still owns the lock.
      child.admission = new Promise(resolve => {
        const finish = result => {
          child.removeListener('message', message);
          child.removeListener('exit', exit);
          child.removeListener('error', error);
          resolve(result);
        };
        const message = value => { if (value.ready) finish({ ready: true }); };
        const exit = (code, signal) => finish({ code, signal });
        const error = error => finish({ error });
        child.on('message', message);
        child.once('exit', exit);
        child.once('error', error);
      });
      f.cleanup.push(async () => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
        if (child.connected) child.send({ stop: true }, () => {});
        try {
          await demandWait(child.sessionExit, `fixture ${child.pid} graceful shutdown`, options.cleanupMs ?? 2000);
        } catch (err) {
          // This fixture has no descendants. Collect the exact owned child even if its IPC stop is stuck.
          child.kill('SIGKILL');
          await demandWait(child.sessionExit, `fixture ${child.pid} exit after SIGKILL`, 2000);
          throw new Error(`${err.message}\n${sessionLog(f.directory)}`, { cause: err });
        }
      });
      return child;
    },
  }), 'detached fixture spawn');
}
