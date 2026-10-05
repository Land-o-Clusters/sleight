// The caller owns the live lock. Every new Chess window is closed before return.
export async function stackedChessTrial(paths, api) {
  const baseline = new Set((await api.snapshot()).map(w => w.id));
  const run = { paths, placements: [], cleanup: [] };
  const opened = new Set();
  try {
    for (const path of paths) {
      if (api.cancelled()) throw new Error('Run interrupted');
      opened.add(path); // A failed open can still create a window.
      await api.open(path); await api.wait(1000);
      run.placements.push(await api.place(path));
    }
    if (api.cancelled()) throw new Error('Run interrupted');
    const [source, other] = run.placements;
    if (!source.ok || !other.ok || source.windowId === other.windowId ||
        JSON.stringify(source.bounds) !== JSON.stringify(other.bounds)) throw new Error('Two distinct owned games must have identical stacked frames');
    const square = (state, suffix) => {
      const matches = state.squares.filter(s => s.title.endsWith(suffix));
      if (matches.length !== 1) throw new Error(`Missing unique ${suffix} square`);
      return matches[0];
    };
    const from = square(source, 'e2'), to = square(source, 'e4');
    if (!/white pawn/i.test(from.title) || /pawn/i.test(to.title)) throw new Error('Owned game must start with e2 occupied and e4 empty');
    const relative = s => [s.center[0] - source.bounds[0], s.center[1] - source.bounds[1]];
    run.request = { app: 'Chess', windowId: source.windowId, from: relative(from), to: relative(to) };
    run.reply = await api.drag(run.request);
    await api.wait(1000);
    run.sourceAfter = await api.read(paths[0]); run.otherAfter = await api.read(paths[1]);
    run.passed = !run.reply.result?.isError && run.sourceAfter.ok && run.otherAfter.ok &&
      !/pawn/i.test(square(run.sourceAfter, 'e2').title) && /white pawn/i.test(square(run.sourceAfter, 'e4').title) &&
      /white pawn/i.test(square(run.otherAfter, 'e2').title) && !/pawn/i.test(square(run.otherAfter, 'e4').title);
  } catch (e) { run.error = String(e.message || e); run.passed = false; }
  finally {
    // Exact document paths establish ownership. A concurrent new game is not ours.
    const owned = windows => windows.filter(w => !baseline.has(w.id) && paths.includes(w.path));
    const pending = new Set(opened);
    for (let attempt = 0; attempt < 3 && pending.size; attempt++) {
      for (const path of pending) {
        try {
          const result = await api.closePath(path);
          run.cleanup.push({ path, result });
          if (result.ok) pending.delete(path);
        } catch (e) { run.cleanup.push({ path, error: String(e.message || e) }); }
      }
      api.checkpoint(run);
      if (pending.size) await api.wait(1000);
    }
    // CG-to-AX mappings are diagnostic only. Exact AX document absence is the
    // closePath contract, including windows which cannot be mapped to CG.
    try { run.remainingWindows = owned(await api.snapshot()); }
    catch (e) { run.cleanup.push({ error: String(e.message || e) }); }
    run.remainingPaths = [...pending];
    run.closedAllOpenedWindows = pending.size === 0;
  }
  return run;
}
