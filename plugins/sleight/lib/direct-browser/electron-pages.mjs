// The page registry for an opted-in Electron app (EPV3-3), in place of page.mjs's browser registry.
// It seeds the app's existing renderers: a member target (electron-targets.mjs) whose geometry joins
// exactly one native window of the instance (electron-native-join.mjs) is granted, owned by the CDP
// filter and paired with its Playwright page. It never creates, closes or navigates app windows, never
// installs popup hooks or focus emulation, and a turn's end releases control without closing anything.
// Before each mutation it rechecks the target epoch, the join and the instance fence; a change during an
// awaited preparation (guard) stops the dispatch and parks the page. Nothing imports this file in the
// installed path yet (EPV3-7 wires it beside createPageRegistry).
import { tabHandle } from './tab-handle.mjs';
import { restoreViewport } from './viewport.mjs';

const fail = code => { throw Error(code); };
const handoff = 'ELECTRON_NATIVE_HANDOFF: app windows open and close through the app itself, so use the app tools (its own Quit or close keeps unsaved-work review)';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sameWindow = (a, b) => a?.id === b?.id && a?.epoch === b?.epoch;
const parkReason = error => {
  const message = String(error?.message ?? '');
  if (message.startsWith('ELECTRON_JOIN_PARKED: ')) return message.slice('ELECTRON_JOIN_PARKED: '.length);
  if (message === 'ELECTRON_JOIN_CHANGED') return 'window-changed';
  return 'identity';
};

// connectionParked() names the host's reason once it parked this session's app connection (electron-connection.mjs parked),
// so a page stopped by a revocation says "revoked" rather than the failed read that followed it.
export function createAppPageRegistry({ browser, filter, targets, join, fence, owner, timeoutMs = 5000, connectionParked = () => undefined } = {}) {
  if (typeof browser?.contexts !== 'function' || typeof filter?.own !== 'function' || typeof filter?.release !== 'function' ||
      typeof targets?.geometry !== 'function' || typeof targets?.sync !== 'function' || typeof targets?.grant !== 'function' || typeof join?.resolve !== 'function' ||
      typeof join?.check !== 'function' || typeof fence?.acquire !== 'function' || typeof owner !== 'string' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || typeof connectionParked !== 'function') fail('ELECTRON_PAGES_REQUIRED');
  // kept: targets this session released to the user (keep or handoff) at that epoch, never re-admitted this turn.
  const records = new Map(), byTarget = new Map(), kept = new Map(), metadata = new WeakMap(), claimed = new WeakSet(), tasks = new Set();
  let ended = false, refreshing = Promise.resolve(), cleanup;
  const track = promise => { tasks.add(promise); promise.then(() => tasks.delete(promise), () => tasks.delete(promise)); return promise; };
  const idle = async () => { while (tasks.size) await Promise.allSettled([...tasks]); };
  const bounded = (task, message) => {
    let timer;
    return Promise.race([task(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), timeoutMs); })]).finally(() => clearTimeout(timer));
  };
  const parkedError = entry => Error('ELECTRON_PARKED: ' + entry.parked + '. The app window needs native handling or a fresh read; nothing was sent.');
  const park = (entry, reason) => { if (!entry.revoked && !entry.released) entry.parked = reason; };
  const lost = () => { try { const reason = connectionParked(); return typeof reason === 'string' && reason ? reason : undefined; } catch { return 'host failure'; } };
  // The host parked the whole connection: every later check names that reason, before any other evidence.
  const parkLost = entry => { const reason = lost(); if (!reason) return false; if (entry.parked !== reason) { entry.parked = null; park(entry, reason); } return true; };

  const offRevoke = targets.onRevoke((targetId, epoch) => {
    // Synchronous: the route goes before any later command can use it.
    try { filter.release(targetId); } catch { /* filter already disposed */ }
    const entry = byTarget.get(targetId);
    if (!entry || entry.epoch !== epoch) return;
    entry.revoked = true; byTarget.delete(targetId);
    entry.cdp?.detach().catch(() => {});
  });

  const identify = page => {
    if (!metadata.has(page)) metadata.set(page, (async () => {
      const context = browser.contexts().find(row => row.pages().includes(page));
      const cdp = await context.newCDPSession(page);
      const { targetInfo } = await cdp.send('Target.getTargetInfo');
      if (targetInfo?.type !== 'page' || !targetInfo.targetId) { await cdp.detach().catch(() => {}); fail('ELECTRON_PAGE_UNAVAILABLE'); }
      return { cdp, targetId: targetInfo.targetId };
    })());
    return metadata.get(page);
  };
  // Playwright makes the page once the filter owns the target; pair it by its own target info.
  async function pageFor(targetId) {
    const until = Date.now() + timeoutMs;
    while (!ended && Date.now() < until) {
      for (const context of browser.contexts()) for (const page of context.pages()) {
        if (claimed.has(page)) continue;
        const info = await identify(page).catch(() => undefined);
        if (info?.targetId === targetId) { claimed.add(page); return { page, cdp: info.cdp }; }
      }
      await sleep(10);
    }
    fail('ELECTRON_PAGE_UNAVAILABLE');
  }

  async function admit(record, window, renderer) {
    targets.grant(record.targetId, record.epoch, window);
    try {
      await filter.own(record.targetId);
      const { page, cdp } = await pageFor(record.targetId);
      if (ended || !targets.current(record.targetId, record.epoch)) { await cdp.detach().catch(() => {}); fail('ELECTRON_TARGET_CHANGED'); }
      const entry = { tab: tabHandle(records), targetId: record.targetId, epoch: record.epoch, window, page, cdp,
        state: { snapshotNo: 0, submitUnconfirmed: false }, queue: Promise.resolve(), parked: null, joinNo: 1,
        released: false, revoked: false, app: true, renderer };
      records.set(entry.tab, entry); byTarget.set(entry.targetId, entry);
    } catch {
      targets.ungrant(record.targetId);
      try { filter.release(record.targetId); } catch { /* disposed */ }
    }
  }
  // One pass over the graph: admit newly joined pages, park admitted ones whose join no longer holds.
  async function pass() {
    if (ended) fail('turn ended');
    await targets.sync();
    const candidates = [];
    for (const record of targets.members()) {
      try { candidates.push({ record, geometry: await targets.geometry(record.targetId) }); }
      catch { const entry = byTarget.get(record.targetId); if (entry) park(entry, 'geometry-unavailable'); }
    }
    const results = await join.resolve(candidates.map(({ record, geometry }) => ({ targetId: record.targetId, geometry })));
    for (const { record } of candidates) {
      const row = results.get(record.targetId), entry = byTarget.get(record.targetId);
      if (entry) {
        if (row.status === 'joined' && sameWindow(row.window, entry.window)) {
          entry.renderer = row.renderer;
          if (entry.parked) { entry.parked = null; entry.joinNo++; }
        } else park(entry, row.status === 'joined' ? 'window-changed' : row.reason ?? row.status);
      } else if (row.status === 'joined' && kept.get(record.targetId) !== record.epoch && targets.current(record.targetId, record.epoch)) await admit(record, row.window, row.renderer);
    }
  }
  const refresh = () => {
    const run = refreshing.then(pass);
    refreshing = run.catch(() => {});
    return track(run);
  };

  function tab(id) {
    const entry = records.get(id);
    if (!entry) fail('unknown or released app page');
    if (ended) fail('turn ended');
    if (entry.revoked) fail('owned app page is gone; list again');
    if (entry.released || entry.releasing) fail('app page released');
    return entry;
  }
  // The checks right before a mutation: instance fence, target epoch, a fresh unique join to the same window.
  async function fenceEntry(entry) {
    tab(entry.tab);
    if (parkLost(entry) || entry.parked) throw parkedError(entry);
    // The host fence caches a 30 s lease; after an idle pause it must ask the host again before the synchronous check.
    if (typeof fence.renew === 'function') { await fence.renew(); tab(entry.tab); }
    if (!fence.acquire(owner)) fail('ELECTRON_BUSY: another session is acting in this app; nothing was sent');
    const start = join.generation();
    try {
      const geometry = await targets.geometry(entry.targetId);
      tab(entry.tab);
      await join.check(entry.targetId, entry.window, geometry);
    } catch (error) {
      tab(entry.tab);
      if (!parkLost(entry)) park(entry, parkReason(error));
      throw parkedError(entry);
    }
    tab(entry.tab);
    if (parkLost(entry)) throw parkedError(entry);
    if (join.generation() !== start) { park(entry, 'native-change'); throw parkedError(entry); }
    if (entry.parked) throw parkedError(entry);
  }
  async function release(id, kind) {
    const entry = tab(id);
    entry.releasing = true;
    try {
      await bounded(() => entry.queue, 'app page release pending; wait before retrying');
      const viewport = await bounded(() => restoreViewport(entry.page, { release: true }), 'app viewport restore pending; wait before retrying');
      await entry.cdp.detach().catch(() => {});
      targets.ungrant(entry.targetId);
      filter.release(entry.targetId);
      byTarget.delete(entry.targetId); kept.set(entry.targetId, entry.epoch);
      entry.released = true;
      return { tab: id, kept: true, handoff: kind === 'handoff',
        ...(viewport.includes('previous size unknown') ? { viewport } : {}) };
    } finally { entry.releasing = false; }
  }

  const api = {
    tab, idle,
    // The host's reason for parking this session's app connection, or undefined while it stands.
    connectionParked: lost,
    // The entry for the page object snapshot() was handed (EPV3-4's read header); none once released or revoked.
    entryOf(page) {
      for (const entry of records.values()) if (entry.page === page && !entry.released && !entry.revoked) return entry;
      return undefined;
    },
    seed: () => refresh(),
    async list() {
      await refresh();
      return [...records.values()].filter(entry => !entry.revoked && !entry.released).map(entry => ({ tab: entry.tab, targetId: entry.targetId,
        url: targets.record(entry.targetId)?.url, window: { ...entry.window }, status: entry.parked ? 'parked' : 'joined',
        ...(entry.parked ? { reason: entry.parked } : {}), joinNo: entry.joinNo, ...(entry.renderer ? { renderer: entry.renderer } : {}) }));
    },
    // Reads may pass { mutation: false }: they skip the fence and join checks, never the ownership checks.
    enqueue(id, run, { mutation = true } = {}) {
      const entry = tab(id);
      const task = entry.queue.then(async () => { tab(id); if (mutation) await fenceEntry(entry); return run(entry); });
      entry.queue = task.catch(() => {});
      return track(task);
    },
    // For a mutation that awaits a preparation (scroll, actionability): checks before and after it.
    async guard(entry, prepare) {
      if (records.get(entry?.tab) !== entry || typeof prepare !== 'function') fail('unknown or released app page');
      await fenceEntry(entry);
      const start = join.generation();
      const value = await prepare(entry);
      if (join.generation() !== start) { park(entry, 'native-change'); throw parkedError(entry); }
      await fenceEntry(entry);
      return value;
    },
    openTab: async () => fail(handoff),
    async close(id) { tab(id); fail(handoff); },
    closedOpener: () => undefined,
    keep: id => release(id, 'keep'), handoff: id => release(id, 'handoff'),
    endTurn() {
      ended = true;
      if (!cleanup) cleanup = (async () => {
        let settled = true;
        try { await bounded(idle, 'turn cleanup pending'); } catch { settled = false; }
        const rows = [];
        for (const entry of records.values()) {
          if (entry.revoked) { rows.push({ tab: entry.tab, kept: false, closed: true }); continue; }
          let viewport;
          if (!entry.released) {
            try {
              viewport = await bounded(() => restoreViewport(entry.page, { release: true }), 'app viewport restore pending');
              await entry.cdp.detach().catch(() => {});
              targets.ungrant(entry.targetId); filter.release(entry.targetId); byTarget.delete(entry.targetId);
              entry.released = true;
            } catch { rows.push({ tab: entry.tab, kept: false, closed: false, cleanupRequired: true }); continue; }
          }
          rows.push({ tab: entry.tab, kept: true, closed: false,
            ...(viewport?.includes('previous size unknown') ? { viewport } : {}) });
        }
        fence.release(owner); offRevoke();
        return { cleanedUp: settled && rows.every(row => row.kept || row.closed), rows };
      })();
      return cleanup;
    },
  };
  return Object.freeze(api);
}
