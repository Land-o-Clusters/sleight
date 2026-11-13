// Timing signals only, in Playwright's isolated utility world. No text, values,
// attribute contents, selectors or page callbacks cross this observer.
function clock() {
  let changedAt = 0, waiting, stopped = false;
  const stamp = () => performance.timeOrigin + performance.now();
  const observer = new MutationObserver(() => { changedAt = stamp(); waiting?.resolve(); });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const dispose = () => { stopped = true; observer.disconnect(); clearTimeout(lifetime); waiting?.resolve(); };
  // Own cleanup even if the host loses the utility context or its reply.
  const lifetime = setTimeout(dispose, 5000);
  const plan = ({ left, fallback, lead = 0, sampleAt, since, after }) => {
    // Native animation timing includes CSS transitions and Web Animations.
    // Infinite/paused animations have no finite end to spread samples across.
    let remaining = 0, active = changedAt > (since ?? after);
    for (const animation of document.getAnimations().slice(0, 64)) {
      const end = animation.effect?.getComputedTiming().endTime;
      if (animation.playState === 'running') active = true;
      if (animation.playState === 'running' && animation.playbackRate > 0 && Number.isFinite(end)
        && Number.isFinite(animation.currentTime)) remaining = Math.max(remaining, (end - animation.currentTime) / animation.playbackRate);
    }
    // A script-driven sequence has no duration. Once it mutates after input,
    // allow up to 500 ms for its next change, including between quiet phases.
    // Only genuinely quiet pages use the input grid, including capture work.
    const gap = remaining > 0 ? Math.min(1000, Math.max(0, remaining / left - lead))
      : active ? Math.max(500, fallback)
      : Number.isFinite(sampleAt) ? Math.max(0, sampleAt - stamp()) : Math.max(50, fallback);
    return { remaining, gap, active, changed: false };
  };
  return {
    plan,
    async next(options) {
      if (stopped) throw Error('motion clock ended');
      waiting?.resolve();
      const timing = plan(options), gap = options.waitMs ?? timing.gap;
      let own;
      if (changedAt <= options.after) {
        await new Promise(resolve => { own = { resolve, timer: setTimeout(resolve, gap) }; waiting = own; });
        clearTimeout(own.timer);
        if (waiting === own) waiting = undefined;
      }
      return { ...timing, active: timing.active || changedAt > (options.since ?? options.after), changed: changedAt > options.after };
    },
    dispose,
  };
}

async function bounded(task, ms = 500) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(task), new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('motion clock unavailable')), ms);
  })]); } finally { clearTimeout(timer); }
}

async function acquire(frame) {
  const impl = frame?._connection?.toImpl?.(frame);
  if (!impl || impl._page?.delegate?.noUtilityWorld?.()) return;
  const utility = await impl.utilityContext();
  if (utility?.world !== 'utility') return;
  const state = await utility.evaluateExpressionHandle(clock.toString(), { isFunction: true });
  const run = (method, arg) => utility.evaluateExpression('([state, method, arg]) => state[method](arg)', { isFunction: true }, [state, method, arg]);
  return {
    plan: options => run('plan', options),
    next: options => run('next', options),
    async dispose() {
      try { await bounded(() => run('dispose')); } catch { /* The utility clock also owns a lifetime cap. */ }
      try { await bounded(() => state.dispose()); } catch { /* Context loss releases the handle. */ }
    },
  };
}

export async function motionClock(entry) {
  const frames = entry.page.frames?.() ?? [entry.page.mainFrame?.()];
  if (!frames.length || frames.length > 32) return;
  let expired = false;
  const clocks = [];
  const pending = Promise.all(frames.map(async frame => {
    const value = await acquire(frame);
    if (value) { if (expired) await value.dispose(); else clocks.push(value); }
    return value;
  }));
  const dispose = async () => { expired = true; await Promise.all(clocks.splice(0).map(value => value.dispose())); };
  try {
    const values = await bounded(() => pending);
    if (values.some(value => !value)) { await dispose(); return; }
    return {
      async next(options) {
        // Page timers can be throttled in background tabs. Read numeric timing
        // first, then bound the mutation wait with a timer in this Node process.
        const plans = await Promise.all(clocks.map(value => value.plan(options)));
        // A quiet sibling must not win the race against an active frame. All
        // frames still observe mutations, with one shared timeout for the page.
        const active = plans.filter(plan => plan.active);
        const first = (active.length ? active : plans).reduce((a, b) => a.gap <= b.gap ? a : b);
        let timer;
        try {
          const result = await Promise.race([...clocks.map(value => value.next({ ...options, waitMs: first.gap })),
            new Promise(resolve => { timer = setTimeout(() => resolve(first), first.gap); })]);
          return { ...first, active: first.active || result.active, changed: result.changed };
        } finally { clearTimeout(timer); }
      },
      dispose,
    };
  } catch { await dispose(); }
}
