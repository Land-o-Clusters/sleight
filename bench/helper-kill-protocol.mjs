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
