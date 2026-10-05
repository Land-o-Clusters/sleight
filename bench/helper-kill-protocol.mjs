import { homedir } from 'node:os';
import { join } from 'node:path';

export async function inspectHelperProcesses(pids, execute, home = homedir()) {
  if (!pids.length) return [];
  try {
    return JSON.parse((await execute(join(home, '.codex/bin/codex-macos-inspect'), ['process-status', ...pids.map(String)])).stdout);
  } catch (err) {
    if (err.code !== 70) throw err;
    return [{ pids, inspectionUnavailable: err.stderr?.trim() || err.message }];
  }
}

export function requirePendingKill(result) {
  if (!result.killed?.pending?.length) throw new Error('Trial did not SIGKILL an engine with a pending request. Publish it as incomplete.');
}
export function killHelper(pid, cancelled, signal = process.kill) {
  if (cancelled) throw new Error('cancelled before helper signal');
  signal(pid, 'SIGKILL');
}
export function requireIdleKill(receipt) {
  if (!receipt?.pid) throw new Error('Idle trial did not produce a kill receipt. Publish it as incomplete.');
}
