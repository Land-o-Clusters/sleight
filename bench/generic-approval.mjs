import { existsSync, readFileSync } from 'node:fs';

// Collect the owned driver before returning a refusal. Application dialogs are
// observed by the retained fixture helper; preflight has only the system observer.
export async function guardGenericOperation(operation, { signal, stopFile, permissionCheck, onStop,
  held = () => existsSync('/tmp/sleight-hold'), interval = 1000 } = {}) {
  const controller = new AbortController();
  let reason, observing;
  const stop = message => { reason ??= message; controller.abort(); onStop?.(); };
  const observe = async () => {
    try {
      if (held()) return stop('live run stopped: /tmp/sleight-hold exists');
      if (stopFile && existsSync(stopFile)) return stop(readFileSync(stopFile, 'utf8').trim());
      if (await permissionCheck?.()) stop('unsupported approval: macOS permission dialog');
    } catch (error) { stop(`unsupported approval: permission observation unavailable: ${error.message}`); }
  };
  await observe();
  if (reason) return { code: 1, groupClean: true, approvalStop: reason };
  signal?.throwIfAborted();
  const monitor = setInterval(() => { if (!observing) observing = observe().finally(() => { observing = undefined; }); }, interval);
  try {
    const response = await operation(AbortSignal.any([signal, controller.signal].filter(Boolean)), stop);
    await observing; await observe();
    return { ...response, ...(reason && { approvalStop: reason }) };
  } finally { clearInterval(monitor); await observing; }
}
