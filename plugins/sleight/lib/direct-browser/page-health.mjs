// Renderer failures retain the owned tab. Only an explicit recovery or release
// terminates its scripts; a timeout never creates a replacement tab.
const pending = new WeakMap();
const recoveryGuards = new WeakMap(), fetchDisables = new WeakMap();
const fetchOwners = new WeakMap(), closedRecoverySessions = new WeakSet();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export const stuckPageMessage = 'Script seems stuck; tab retained. Use navigate with url to recover, or close, keep or handoff.';
const stuckError = () => Object.assign(Error(stuckPageMessage), { stuckPage: true });
export function assertPageResponsive(tab) {
  if (tab.state.stuck) throw stuckError();
}
export async function ensurePageResponsive(tab) {
  if (!tab.state.stuck) return;
  // A timeout describes an observation, not a permanent state of the page.
  if (typeof tab.page.evaluate === 'function' && await probePage(tab, 1000)) {
    tab.state.stuck = false;
    delete tab.state.stuckOrigin;
  }
  assertPageResponsive(tab);
}
async function deadline(task, ms) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(task), new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(Error('renderer probe timed out'), { probeTimeout: true })), ms);
  })]); } finally { clearTimeout(timer); }
}
export async function probePage(tab, probeMs = 3000, current = () => true) {
  if (tab.closed || tab.page.isClosed?.()) return false;
  // A stuck child renderer matters too. These evaluations carry no user gesture.
  const frames = tab.page.frames?.() ?? [tab.page];
  try {
    const results = await deadline(() => Promise.allSettled(frames.map(async frame => {
      if (frame.isDetached?.()) return false;
      try { await frame.evaluate(() => 0); return !frame.isDetached?.(); }
      catch (error) { if (!frame.isDetached?.()) throw error; }
    })), probeMs);
    return !tab.closed && !tab.page.isClosed?.() && results.some(result => result.value === true) && results.every(result => result.status === 'fulfilled');
  } catch (error) {
    if (!error.probeTimeout) return false; // Navigation or closure is not proof of a stuck script.
    if (!current() || tab.closed || tab.page.isClosed?.()) return false;
    tab.state.stuck = true;
    try { tab.state.stuckOrigin ??= new URL(tab.page.url()).origin; } catch { /* No web origin. */ }
    throw stuckError();
  }
}
export async function guardPageTask(tab, task, { afterMs = 7000, probeMs = 3000 } = {}) {
  await ensurePageResponsive(tab);
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
    if (!error.stuckPage && /timed out|deadline|Snapshot (unavailable|acquisition)/i.test(error.message)) await probePage(tab, probeMs, () => watching);
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
      tab.state.recoveryScriptsTerminated = true;
    } finally { await Promise.all(sessions.map(session => session.detach().catch(() => {}))); }
  }, timeoutMs);
  const bank = pending.get(tab);
  if (bank?.size) await deadline(() => Promise.allSettled([...bank]), timeoutMs);
  // Let Playwright unwind its exact pending input before the recovery navigation.
  const until = Date.now() + timeoutMs;
  while (tab.state.actionPending && Date.now() < until) await pause(10);
  if (tab.state.actionPending) throw Error('Earlier input still pending after script termination; tab retained. Close or hand off the tab.');
}
export async function disableRecoveryFetch(tab, cdp = tab.cdp) {
  if (!cdp) return;
  if (fetchDisables.has(cdp)) return fetchDisables.get(cdp);
  if (closedRecoverySessions.has(cdp)) return;
  fetchOwners.set(tab, cdp);
  tab.state.recoveryFetchDisablePending = true;
  const work = (async () => {
    try {
      // Cleanup has its own budget and cannot replace a navigation's result.
      await deadline(() => cdp.send('Fetch.disable'), 500);
      recoveryGuards.get(cdp)?.();
      if (fetchOwners.get(tab) === cdp) {
        fetchOwners.delete(tab);
        tab.state.recoveryFetchDisablePending = false;
      }
    } catch { /* Keep the guard until cleanup succeeds or this session closes. */ }
    finally { fetchDisables.delete(cdp); }
  })();
  fetchDisables.set(cdp, work);
  return work;
}
export function sameRecoveryURL(left, right) {
  const a = new URL(left), b = new URL(right);
  a.hash = ''; b.hash = '';
  return a.href === b.href;
}
function namedRecoveryOrigin(hop, named) {
  // Permit the named host's www spelling and an HTTP to HTTPS upgrade. Do not
  // collapse arbitrary subdomains or ports into the user's named destination.
  return hop.hostname.replace(/^www\./, '') === named.hostname.replace(/^www\./, '') && hop.port === named.port &&
    (hop.protocol === named.protocol || named.protocol === 'http:' && hop.protocol === 'https:');
}
export async function recoverPage(tab, url, { siteCheck, allowCrossOrigin = false } = {}) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Error('HTTP(S) URL without credentials required');
  const refused = siteCheck?.(parsed.href);
  if (refused) throw Error(refused);
  if (!tab.state.stuck) throw Error('navigate with url is only for a stuck tab; use a link ref or browser_open');
  let origin;
  try { origin = tab.state.stuckOrigin ?? new URL(tab.page.url()).origin; } catch { /* Unknown origin refuses below. */ }
  if (parsed.origin !== origin && !allowCrossOrigin) throw Error('Recovery stays on the stuck page origin unless the user message named the destination URL');
  if (tab.state.recoveryFetchDisablePending) {
    await disableRecoveryFetch(tab);
    if (tab.state.recoveryFetchDisablePending) throw Error('Recovery navigation cleanup pending; tab retained');
  }
  tab.state.recoveryScriptsTerminated = false;
  await terminatePageScripts(tab);
  // Only a successful navigation clears the mark. A failed escape keeps the handle.
  // Fetch sees redirect requests too. Checking only the initial URL would let
  // a same-origin endpoint silently send recovery to an unrelated site.
  const cdp = tab.cdp;
  let navigationGuard;
  if (cdp?.on && cdp?.off) {
    const { frameTree } = await deadline(() => cdp.send('Page.getFrameTree'), 3000);
    if (!frameTree?.frame?.id) throw Error('Recovery navigation origin guard unavailable; tab retained');
    const frameId = frameTree.frame.id;
    tab.state.recoveryFrameId = frameId;
    let first = true;
    const retryCleanup = () => {
      if (tab.cdp === cdp && tab.state.recoveryFetchDisablePending) void disableRecoveryFetch(tab, cdp);
    };
    navigationGuard = event => {
      let blocked = false;
      try {
        const hop = new URL(event.request.url);
        blocked = !['http:', 'https:'].includes(hop.protocol) || !!hop.username || !!hop.password || !!siteCheck?.(hop.href);
        if (event.frameId === frameId) {
          const named = allowCrossOrigin && (first ? sameRecoveryURL(hop.href, parsed.href) : namedRecoveryOrigin(hop, parsed));
          first = false;
          blocked ||= !named && hop.origin !== origin;
        }
      } catch { blocked = true; }
      cdp.send(blocked ? 'Fetch.failRequest' : 'Fetch.continueRequest', {
        requestId: event.requestId, ...(blocked ? { errorReason: 'BlockedByClient' } : {}),
      }).catch(() => {});
      retryCleanup();
    };
    const removeGuard = () => {
      cdp.off('Fetch.requestPaused', navigationGuard);
      cdp.off('close', closed);
      tab.page.off?.('request', retryCleanup);
      recoveryGuards.delete(cdp);
    };
    const closed = () => {
      closedRecoverySessions.add(cdp);
      removeGuard();
      if (fetchOwners.get(tab) === cdp) {
        fetchOwners.delete(tab);
        tab.state.recoveryFetchDisablePending = false;
      }
    };
    recoveryGuards.set(cdp, removeGuard);
    cdp.on('Fetch.requestPaused', navigationGuard);
    cdp.on('close', closed);
    tab.page.on?.('request', retryCleanup);
  }
  try {
    if (navigationGuard) await deadline(() => cdp.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] }), 3000);
    await tab.page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: 5000 });
    const landed = new URL(tab.page.url());
    if (!['http:', 'https:'].includes(landed.protocol) || landed.username || landed.password || siteCheck?.(landed.href) ||
      landed.origin !== origin && !(allowCrossOrigin && namedRecoveryOrigin(landed, parsed))) throw Error('Recovery left the allowed destination; tab retained');
  } finally {
    if (navigationGuard) {
      await disableRecoveryFetch(tab, cdp);
    }
  }
  tab.state.stuck = false;
  delete tab.state.stuckOrigin;
}
