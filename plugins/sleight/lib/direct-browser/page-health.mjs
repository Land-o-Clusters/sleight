// Renderer failures retain the owned tab. Only an explicit recovery or release
// terminates its scripts; a timeout never creates a replacement tab.
const pending = new WeakMap();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export const stuckPageMessage = 'Script seems stuck; tab retained. Use navigate with url to recover, or close, keep or handoff.';
const stuckError = () => Object.assign(Error(stuckPageMessage), { stuckPage: true });
export function assertPageResponsive(tab) {
  if (tab.state.stuck) throw stuckError();
}
async function deadline(task, ms) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(task), new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(Error('renderer probe timed out'), { probeTimeout: true })), ms);
  })]); } finally { clearTimeout(timer); }
}
export async function probePage(tab, probeMs = 3000, current = () => true) {
  // A stuck child renderer matters too. These evaluations carry no user gesture.
  const frames = tab.page.frames?.() ?? [tab.page];
  try {
    await deadline(() => Promise.allSettled(frames.map(frame => frame.evaluate(() => 0))), probeMs);
    return true;
  } catch (error) {
    if (!error.probeTimeout) return false; // Navigation or closure is not proof of a stuck script.
    if (!current()) return false;
    tab.state.stuck = true;
    throw stuckError();
  }
}
export async function guardPageTask(tab, task, { afterMs = 7000, probeMs = 3000 } = {}) {
  assertPageResponsive(tab);
  // Small offline fakes without evaluation keep their original boundary.
  if (typeof tab.page.evaluate !== 'function') return task();
  let timer, watching = true;
  const work = Promise.resolve().then(task);
  let bank = pending.get(tab);
  if (!bank) { bank = new Set(); pending.set(tab, bank); }
  bank.add(work);
  work.then(() => bank.delete(work), () => bank.delete(work));
  const watchdog = new Promise((_, reject) => {
    const check = async () => {
      try {
        await probePage(tab, probeMs, () => watching);
        if (watching) timer = setTimeout(check, afterMs);
      } catch (error) { reject(error); }
    };
    timer = setTimeout(check, afterMs);
  });
  try { return await Promise.race([work, watchdog]); }
  catch (error) {
    // The inner snapshot/action deadline may beat the watchdog by one timer turn.
    if (!error.stuckPage && /timed out|deadline|Snapshot unavailable/i.test(error.message)) await probePage(tab, probeMs, () => watching);
    throw error;
  } finally { watching = false; clearTimeout(timer); }
}
export async function terminatePageScripts(tab, timeoutMs = 3000) {
  if (!tab.cdp?.send) throw Error('Script termination unavailable; tab retained. Close or hand off the tab.');
  await deadline(async () => {
    const sessions = [];
    // Send this before attaching child sessions: a busy same-process child must
    // not prevent the main renderer's termination command from going out.
    const main = tab.cdp.send('Runtime.terminateExecution');
    main.catch(() => {});
    try {
      // OOPIFs need their own renderer session. Same-process children share the main one.
      for (const frame of tab.page.frames?.() ?? []) {
        if (frame === tab.page.mainFrame?.()) continue;
        const session = await tab.page.context().newCDPSession(frame).catch(() => null);
        if (session) sessions.push(session);
      }
      await Promise.all([main, ...sessions.map(session => session.send('Runtime.terminateExecution'))]);
    } finally { await Promise.all(sessions.map(session => session.detach().catch(() => {}))); }
  }, timeoutMs);
  const bank = pending.get(tab);
  if (bank?.size) await deadline(() => Promise.allSettled([...bank]), timeoutMs);
  // Let Playwright unwind its exact pending input before the recovery navigation.
  const until = Date.now() + timeoutMs;
  while (tab.state.actionPending && Date.now() < until) await pause(10);
  if (tab.state.actionPending) throw Error('Earlier input still pending after script termination; tab retained. Close or hand off the tab.');
}
export async function recoverPage(tab, url, { siteCheck } = {}) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Error('HTTP(S) URL without credentials required');
  const refused = siteCheck?.(parsed.href);
  if (refused) throw Error(refused);
  if (!tab.state.stuck) throw Error('navigate with url is only for a stuck tab; use a link ref or browser_open');
  await terminatePageScripts(tab);
  // Only a successful navigation clears the mark. A failed escape keeps the handle.
  await tab.page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: 5000 });
  tab.state.stuck = false;
}
