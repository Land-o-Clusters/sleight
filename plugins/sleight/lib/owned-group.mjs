// Call only for a detached child this process spawned. Relay leader exit can begin
// collection before pipe closure, since surviving descendants may retain those pipes.
export async function collectOwnedGroup(pid, { graceMs = 5000, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  alive = () => { try { process.kill(-pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } },
  signal = name => { try { process.kill(-pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } },
} = {}) {
  if (!pid) return;
  try {
    for (const name of ['SIGTERM', 'SIGKILL']) {
      if (!alive()) return;
      signal(name);
      const deadline = now() + graceMs;
      while (alive() && now() < deadline) await sleep(20);
    }
    if (!alive()) return;
    throw new Error('process group still exists');
  } catch (error) {
    throw Object.assign(new Error(`owned group cleanup unconfirmed: ${error.message}`), { cleanupUnconfirmed: true });
  }
}
