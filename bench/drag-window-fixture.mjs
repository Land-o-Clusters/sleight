// Keep fixture geometry changes settled before taking AX/CG snapshots.
export async function prepareWindowPair(paths, ops) {
  const check = () => { if (ops.cancelled()) throw new Error('Run interrupted'); };
  for (let i = 0; i < paths.length; i++) {
    check();
    await ops.open(paths[i]);
    await ops.wait(800);
    check();
    if (!await ops.place(paths[i], i ? 'other' : 'source')) throw new Error('Fixture placement failed');
    await ops.wait(1200);
    check();
  }
  const selections = paths.map(path => ops.select(path));
  if (selections.length !== 2 || selections.some(s => !s.ok || !s.windowId || !s.from || !s.to) || selections[0].windowId === selections[1].windowId) {
    throw new Error('Two distinct settled fixture windows are required');
  }
  return selections;
}
