// Touch emulation is target-scoped. Keep its CDP session alive until reset or
// release, and read the baseline in a pristine world, never page JavaScript.
const overrides = new WeakMap();

async function baseline(page) {
  const session = await page.context().newCDPSession(page);
  try {
    const { frameTree } = await session.send('Page.getFrameTree');
    const { executionContextId } = await session.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id, worldName: 'sleight-touch',
    });
    const { result, exceptionDetails } = await session.send('Runtime.evaluate', {
      expression: 'navigator.maxTouchPoints', contextId: executionContextId, returnByValue: true,
    });
    const points = result?.value;
    if (exceptionDetails || !Number.isInteger(points) || points < 0 || points > 16) throw Error('touch baseline unavailable');
    // Chromium clears this override when its session detaches, including an
    // override set by another client. Refuse a baseline we cannot give back.
    if (points !== 0) throw Error('touch emulation requires a tab with no existing touch capability');
    return { session, points };
  } catch (error) { await session.detach().catch(() => {}); throw error; }
}

function stateFor(page) {
  let state = overrides.get(page);
  if (!state) {
    state = { ready: baseline(page), tail: Promise.resolve() };
    overrides.set(page, state);
    state.ready.catch(() => {
      if (overrides.get(page) === state) overrides.delete(page);
      page.off('close', state.closed);
    });
    state.closed = () => {
      if (overrides.get(page) === state) overrides.delete(page);
      state.ready.then(({ session }) => session.detach()).catch(() => {});
    };
    page.once('close', state.closed);
  }
  return state;
}

function queued(state, run) {
  const task = state.tail.then(() => state.ready).then(run);
  state.tail = task.catch(() => {});
  return task;
}

const apply = (session, points) => session.send('Emulation.setTouchEmulationEnabled', {
  enabled: points > 0, ...(points > 0 ? { maxTouchPoints: points } : {}),
});

export function setTouch(page, enabled) {
  if (typeof enabled !== 'boolean') throw Error('touch must be boolean');
  return queued(stateFor(page), async ({ session }) => {
    await apply(session, enabled ? 1 : 0);
    return enabled ? 'touch on' : 'touch off';
  });
}

export async function restoreTouch(page) {
  const state = overrides.get(page);
  if (!state) return;
  return queued(state, async ({ session }) => {
    if (overrides.get(page) !== state) return;
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await session.send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
    try { await session.detach(); }
    finally {
      overrides.delete(page);
      page.off('close', state.closed);
    }
    return 'touch restored';
  });
}
