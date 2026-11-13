// Guest commands have bounded waits and output, but only a VM restore cleans up.
import { spawn as nodeSpawn } from 'node:child_process';
import { ROOT } from './kit.mjs';
export function runGuestChild(command, args, { cwd = ROOT, env = process.env, input = '', timeout = 60000,
  maxBytes = 4 * 1024 * 1024, signal: abortSignal, onStderr, spawn = nodeSpawn } = {}) {
  return new Promise(resolve => {
    const stdout = [], stderr = [];
    let size = 0, finished = false, timer;
    const child = spawn(command, args, { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const finish = (status, signal, reason = null) => {
      if (finished) return; finished = true;
      clearTimeout(timer); abortSignal?.removeEventListener('abort', abort);
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      if (reason) {
        child.unref?.();
        for (const stream of [child.stdin, child.stdout, child.stderr]) stream.unref?.();
      }
      resolve({ status, signal, reason, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    };
    const abort = () => finish(null, null, 'aborted'), interrupt = () => finish(null, null, 'interrupted');
    for (const [stream, output] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', bytes => {
      if (finished) return;
      const data = Buffer.from(bytes); size += data.length;
      if (size > maxBytes) { finish(null, null, 'output-limit'); return; }
      output.push(data); if (stream === child.stderr) onStderr?.(data.toString('utf8'));
    });
    child.stdin.on('error', () => finish(null, null, 'stdin-error'));
    child.once('error', () => finish(null, null, 'spawn-error'));
    child.once('close', (status, signal) => finish(status, signal));
    abortSignal?.addEventListener('abort', abort, { once: true });
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    timer = setTimeout(() => finish(null, null, 'timeout'), timeout);
    if (abortSignal?.aborted) abort();
    // End the command source pipe. No process-close command or signal is sent.
    if (!finished) child.stdin.end(input);
  });
}
