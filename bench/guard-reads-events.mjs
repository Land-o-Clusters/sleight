export function guardTrialTiming(events) {
  const reads = events.filter(e => e.direction === 'guard-read')
    .map(({ phase, ms, chars, failed }) => ({ phase, ms, chars, failed }));
  const sent = events.find(e => e.direction === 'to-server');
  // JSON-RPC requests from the engine use an independent ID namespace.
  const received = events.find(e => e.direction === 'from-server'
    && e.id === sent?.id && e.method === undefined);
  return { reads, guardMs: reads.reduce((sum, read) => sum + read.ms, 0),
    engineMs: received && sent ? received.t - sent.t : null };
}
