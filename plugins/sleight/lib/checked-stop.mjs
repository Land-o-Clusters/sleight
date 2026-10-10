// Only the launcher's own engine is signaled. Shared native services are never stopped.
export async function collectOwnedEngine({ child, closed, graceMs = 2000, forceMs = 2000 }) {
  const signals = [];
  const signal = name => { signals.push(name); child.kill(name); };
  child.stdin.end();
  const gentle = setTimeout(() => signal('SIGTERM'), graceMs);
  const force = setTimeout(() => signal('SIGKILL'), graceMs + forceMs);
  let deadline;
  try {
    const exit = await Promise.race([closed, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('Owned engine exit is unconfirmed')), graceMs + forceMs * 2);
    })]);
    return { ...exit, collected: true, cutOff: signals.length > 0, signals };
  } finally { clearTimeout(gentle); clearTimeout(force); clearTimeout(deadline); }
}

export async function checkedStop({ inFlight, endTurn, collect, release, inspect }) {
  const report = { inFlight, engine: 'unconfirmed', resources: 'unconfirmed', leases: 'unconfirmed' };
  try {
    const ended = await endTurn();
    report.turn = ended ? 'finished' : 'unconfirmed';
    const engine = await collect();
    if (engine?.collected !== true) throw new Error('Owned engine exit is unconfirmed');
    report.engine = engine.cutOff ? 'cut off and collected' : 'exited and collected';
    await release();
    report.leases = 'released and checked';
    const state = await inspect();
    report.resources = state?.ok === true ? 'clear' : 'unconfirmed';
    report.observed = state;
  } catch (error) { report.error = error.message; }
  return report;
}

export function stopText(report) {
  return `sleight stop: in flight: ${report.inFlight.length ? report.inFlight.join(', ') : 'none'}. ` +
    `Engine ${report.engine}; turn ${report.turn ?? 'unconfirmed'}. Input leases ${report.leases}. ` +
    (report.resources === 'clear'
      ? 'Checked: owned helpers exited, no pressed pointer button or keyboard filter tap was found.'
      : `Input cleanup unconfirmed: ${report.error ?? report.observed?.error ?? 'resource inspection unavailable'}.`) +
    ' Claude is stopped. The next use needs a fresh engine connection and app read.';
}
