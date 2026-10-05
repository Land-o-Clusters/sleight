// Only the child this benchmark spawned is signaled. Never the shared helper.
export async function collectEngine({ child, stopped, relay, graceMs = 6000, forceMs = 3000 }) {
  const signals = [];
  const signal = name => { child.stdin.end(); signals.push(name); child.kill(name); };
  const gentle = setTimeout(() => signal('SIGTERM'), graceMs);
  const force = setTimeout(() => signal('SIGKILL'), graceMs + forceMs);
  let deadline;
  let shutdownError;
  // Racing collection also bounds shutdown waiting on a timed-out relay call.
  relay.shutdown().then(() => child.stdin.end()).catch(error => {
    shutdownError = error.message; child.stdin.end();
  });
  try {
    const exit = await Promise.race([stopped, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Owned engine exit unconfirmed after cleanup deadline')),
        graceMs + forceMs * 2);
    })]);
    relay.close(); // Final disposal after collection; shutdown may already have closed an idle relay.
    return { ...exit, collected: true, signals, ...(shutdownError ? { shutdownError } : {}) };
  } catch (error) {
    // Preserve an explicit uncollected-child failure without holding up evidence.
    child.stdin.destroy?.(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref?.();
    throw error;
  } finally { clearTimeout(gentle); clearTimeout(force); clearTimeout(deadline); }
}
