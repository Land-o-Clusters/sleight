// This child owns hide/unhide through task success, task failure and parent pipe loss.
import { jsonChild } from './stage-live.mjs';
export function areaRefusalCollected(taskStarted, records) {
  const last = records.findLast(r => r.phase === 'restored');
  return !taskStarted && last?.restored === true && [0, 1].includes(last.exit?.code) && last.exit.signal == null;
}

const phases = ['ready', 'refused', 'waiting'];
export async function fixtureArea(binary, { spawnChild, record = () => {}, log = line => console.error(line) } = {}) {
  const guard = jsonChild(binary, ['--guard'], {}, { spawnChild });
  let closing;
  const close = () => closing ??= (async () => {
    const exit = await guard.close();
    const restored = guard.rows.findLast(r => r.phase === 'restored');
    record({ exit, ...restored });
    if (![0, 1].includes(exit.code) || restored?.restored !== true) throw Error('Fixture area restoration unproved');
    return restored;
  })();
  try {
    let ready = await guard.wait(r => phases.includes(r.phase), 10000);
    // The guard waits out a system banner over the area before any task starts and reports once a minute.
    // That wait is not a task attempt. Only a ready or refused row is recorded.
    while (ready.phase === 'waiting') {
      log(`Fixture area waiting ${ready.waitedS} s for a system window: ${ready.windows?.map(w => w.owner).join(', ')}`);
      ready = await guard.wait(r => phases.includes(r.phase), 90000, guard.rows.indexOf(ready) + 1);
    }
    record(ready);
    if (ready.phase !== 'ready' || ready.clear !== true) throw Error(`Fixture area refused: ${ready.reason ?? 'still covered'}`);
    return { ready, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], cleanup.message); }
    throw error;
  }
}

export async function withFixtureArea(open, task) {
  const area = await open();
  try { return await task(area.ready); }
  finally { await area.close(); }
}
