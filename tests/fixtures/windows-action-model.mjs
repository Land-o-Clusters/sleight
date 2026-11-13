// Executable behavior model for scripted providers on macOS. Native parity is VM-only.
export const clickPatterns = [[10000, 'Invoke'], [10015, 'Toggle'], [10010, 'Select'],
  [10005, 'Expand/Collapse'], [10018, 'DoDefaultAction']];
export function clickRoute(patterns, act, postedAllowed = true, { type = 0, defaultAction = 'Press' } = {}) {
  for (const [id, name] of clickPatterns) if (![50004, 50020, 50030, 50033].includes(type) && patterns.includes(id) && (id !== 10018 || defaultAction.trim())) { act(name); return name; }
  if (!postedAllowed) throw Object.assign(Error('BACKGROUND_UNAVAILABLE'), { code: 'BACKGROUND_UNAVAILABLE' });
  act('posted-mouse'); return 'posted-mouse';
}
export function settleDecision(elapsed, sinceEvent, count, subscribed, stable = false) {
  if (elapsed >= 1500) return 'cap';
  if (subscribed && count > 0 && sinceEvent >= 120) return 'event-quiet';
  if (stable) return 'poll-stable';
  return 'wait';
}
export function scriptedSettle({ events = [], snapshots = ['same', 'same'], subscribed = true, budgetMs = 5000 } = {}) {
  let eventIndex = 0, count = 0, last = 0, nextPoll = 120, previous;
  const samples = [...snapshots];
  for (let elapsed = 0; elapsed <= 1500; elapsed += 10) {
    while (eventIndex < events.length && events[eventIndex] <= elapsed) { last = events[eventIndex++]; count++; }
    let mode = elapsed >= budgetMs ? 'budget' : settleDecision(elapsed, elapsed - last, count, subscribed);
    if (mode === 'wait' && (!subscribed || count === 0) && elapsed >= nextPoll) {
      const current = samples.shift() ?? null;
      if (previous != null && current != null && previous === current) mode = 'poll-stable';
      previous = current; nextPoll = elapsed + 100;
    }
    if (mode !== 'wait') return { mode, settled: ['event-quiet', 'poll-stable'].includes(mode), elapsedMs: elapsed, events: count };
  }
  throw Error('unbounded settle script');
}
export function logicalClientPoint(physical, origin, convert) {
  const p = convert(physical), o = convert(origin), result = [p[0] - o[0], p[1] - o[1]];
  if (result.some(v => !Number.isInteger(v) || v < -32768 || v > 32767)) throw Error('INVALID_COORDINATES');
  return result;
}
