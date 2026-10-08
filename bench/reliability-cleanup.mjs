// A caller retains its live lock when this fails. No application-wide quit is
// allowed until the exact new game is closed and only initial owned games remain.
export async function cleanupChessTrial(api) {
  const step = async (name, run) => {
    try { const result = await run(); api.journal.push({ step: name, result }); return result; }
    catch (error) { api.journal.push({ step: name, error: error.message }); throw error; }
  };
  const identity = await step('ownership-before-cleanup', api.process);
  if (!identity.running) return identity;
  if (identity.pid !== api.pid) throw new Error('Chess process replaced; no cleanup input posted');
  await step('cancel-dialog', api.cancelDialog);
  const ownedTitles = api.titles ?? (api.title ? [api.title] : []);
  for (const title of ownedTitles) await step('close-owned-game', async () => {
    const closed = await api.close(title);
    if (!closed.closed) throw new Error('Owned game closure unconfirmed');
    return closed;
  });
  const remaining = await step('remaining-windows', api.snapshot);
  await step('ownership', async () => {
    if (remaining.running && remaining.pid !== api.pid) throw new Error('Chess process replaced; cleanup stopped');
    const games = remaining.windows.filter(w => w.title && w.bounds.Width > 400);
    if (games.some(w => ownedTitles.includes(w.title) || !api.initialTitles.includes(w.title))) throw new Error('Unexpected game remains; cleanup stopped');
    return { owned: true };
  });
  if (remaining.running) await step('quit', api.quit);
  for (let n = 0; n < 40; n++) {
    const state = await step('process-exit', api.process);
    if (!state.running) return state;
    if (state.pid !== api.pid) throw new Error('Chess process replaced while waiting for exit');
    await api.wait(250);
  }
  throw new Error('Chess did not exit; cleanup unconfirmed');
}
