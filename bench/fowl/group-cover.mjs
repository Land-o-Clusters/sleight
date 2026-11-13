// Browser-group admission runs under the group's live lock, after its owned window exists.
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { beginWindowControl } from '../pass-hygiene.mjs';
import { countedCover, COVER_MIN, OVERLAY_OWNER } from './real-gate-grade.mjs';

export const benchmarkFixtureRoots = () => [...new Set([tmpdir(), realpathSync(tmpdir())])].map(base => join(base, 'sleight-bench'));
const frameOK = f => f && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(f[k])) && f.width > 1 && f.height > 1;
const coverKey = w => JSON.stringify([w.bundle ?? w.name ?? w.owner, w.pid, w.start, w.id]);

// CGWindowList order is front to back. Same-app windows and windows behind the browser cannot cover it.
export function browserCovers(state, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Array.isArray(state?.windows)) throw Error('Browser window inventory unavailable');
  const visible = state.windows.filter(w => w.onScreen && (w.alpha ?? 1) > 0 && frameOK(w.frame));
  const target = visible.filter(w => w.pid === pid && w.layer === 0)
    .sort((a, b) => b.frame.width * b.frame.height - a.frame.width * a.frame.height)[0];
  if (!target) throw Error('Browser window unavailable');
  const covering = visible.slice(0, visible.indexOf(target))
    .filter(w => w.pid !== pid && !OVERLAY_OWNER.test(w.name ?? w.owner ?? '')).flatMap(w => {
    const a = w.frame, b = target.frame;
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return width > 0 && height > 0 ? [{ ...w, owner: w.name ?? w.owner, fraction: width * height / (b.width * b.height) }] : [];
  });
  return { frame: target.frame, covering: countedCover(covering).filter(w => w.fraction >= COVER_MIN) };
}

function fixtureCover(window, roots) {
  if (window.bundle !== 'com.apple.finder' || typeof window.document !== 'string') return false;
  let path;
  try { path = window.document.startsWith('file:') ? fileURLToPath(window.document) : window.document; } catch { return false; }
  if (!isAbsolute(path)) return false;
  // Never let dot traversal or a symlink turn an apparent scratch path into the owner's folder.
  try { path = realpathSync(path); } catch { return false; }
  return roots.some(root => path === root || path.startsWith(root + '/'));
}

export async function waitForBrowserUncovered(pid, { roots = benchmarkFixtureRoots(), snapshot, act, log = console.log,
  coverWaits = new Map(), signal, warn = console.error, held = () => existsSync('/tmp/sleight-hold'), wait = ms => delay(ms, undefined, { signal }) } = {}) {
  const closed = new Set();
  const check = () => {
    signal?.throwIfAborted();
    if (held()) throw Error('Benchmark hold is active');
  };
  const read = async () => {
    check();
    const cover = browserCovers(await snapshot(), pid);
    check();
    log({ event: 'browser-group-cover', frame: cover.frame, covering: cover.covering.map(({ document, title, ...window }) => window) });
    return cover;
  };
  for (let waits = 0;; waits++) {
    check();
    let mustWait = false, pending = [];
    try {
      let cover = await read();
      if (!cover.covering.length) return;
      for (const window of cover.covering) {
        check();
        const key = `${window.pid}:${window.start}:${window.id}`;
        if (closed.has(key) || !fixtureCover(window, roots)) { mustWait = true; continue; }
        const result = await act({ action: 'close', finderOnly: true, pid: window.pid, start: window.start,
          bundle: window.bundle, id: window.id, fixtures: { fixturePaths: roots, fixtureNames: [] } });
        log({ event: 'finder-fixture-close', id: window.id, result });
        if (result?.closed !== true || result.dialog) mustWait = true;
        else closed.add(key);
      }
      // Verify claimed closes immediately, but new fixture IDs cannot bypass the retry budget.
      if (!mustWait) cover = await read();
      if (!cover.covering.length) return;
      pending = [...new Set(cover.covering.map(coverKey))];
    } catch (error) { check(); log({ event: 'browser-group-cover-error', error: error.message }); }
    check();
    // The map belongs to the round, so a persistent owner window cannot cost three minutes per task.
    if (waits === 3 || (pending.length && pending.every(key => (coverWaits.get(key) ?? 0) >= 3))) {
      log({ event: 'browser-group-cover-cap', waits, ...(waits < 3 && { reason: 'round-cover-budget' }) });
      warn('Browser group cover check reached 3 waits of 60 s; starting task with cover recorded.');
      return;
    }
    await wait(60000);
    for (const key of pending) coverWaits.set(key, Math.min(3, (coverWaits.get(key) ?? 0) + 1));
  }
}

export async function guardBrowserGroup(pid, { cacheDir, coverWaits, log, signal } = {}) {
  const control = await beginWindowControl({ cacheDir, signal, includeFloating: true });
  await waitForBrowserUncovered(pid, { ...control, coverWaits, log, signal });
}
