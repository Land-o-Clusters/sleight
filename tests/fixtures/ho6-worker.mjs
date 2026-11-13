// Headless IPC fixture. Atomics.wait hangs the event loop without using CPU.
if (process.env.HO6_IGNORE_TERM === '1') process.on('SIGTERM', () => {});
process.send({ version: 3, session: 'fixture-session', nonce: 'a'.repeat(64), browser: 'bfixture' });
process.on('message', frame => {
  const reply = result => process.send({ version: 3, id: frame.id, result });
  if (frame.method === 'begin') reply({ available: true });
  else if (frame.method === 'call') {
    process.send({ version: 3, id: frame.id, handoffState: true });
    reply({ resultId: 'fixture-result', result: { text: 'fixture card pending', isError: false } });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
});
