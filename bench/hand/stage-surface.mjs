// Judge the helper's front-to-back list. This module never opens or moves a window.
const rect = r => r && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k])) && r.width > 0 && r.height > 0;
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const encloses = (a, b) => a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height;
// CGWindowList reports "Window Server" on current macOS; the pid must also match the verified executable.
const WINDOW_SERVER_OWNERS = new Set(['WindowServer', 'Window Server']);
const sameRect = (a, b) => rect(a) && rect(b) && ['x', 'y', 'width', 'height'].every(k => Math.abs(a[k] - b[k]) < 1);
export function stageSurfaceObservation(snapshot, receipt, { surface = 'quiet', requiresPanel = true,
  startedAtMs, completedAtMs } = {}) {
  const { pid, panel, panelID, backdrop, fixtureIDs, fixtureWindows } = snapshot ?? {};
  const { windows, observedAtMs, windowServerPid = null } = receipt ?? {};
  const evidence = { pid, panel, panelID, backdrop, fixtureIDs, fixtureWindows, windows, windowServerPid, observedAtMs, startedAtMs, completedAtMs, surface, requiresPanel };
  const refuse = reason => ({ ...evidence, valid: false, reason, interfering: [], overlapping: [] });
  // Swift's wall clock has sub-ms precision; Date.now truncates to whole ms.
  if (![startedAtMs, completedAtMs, observedAtMs].every(Number.isFinite) ||
      observedAtMs < startedAtMs || observedAtMs > completedAtMs + 1 || completedAtMs - startedAtMs > 2000)
    return refuse('missing or stale window list');
  if (!['quiet', 'changing'].includes(surface) || !Number.isSafeInteger(pid) || pid < 1 || !Array.isArray(windows) || !windows.length ||
      windows.some((w, i) => !w || !Number.isSafeInteger(w.id) || !Number.isSafeInteger(w.pid) || !Number.isInteger(w.layer) ||
        !Number.isFinite(w.alpha) || !rect(w.bounds) || i > 0 && w.layer > windows[i - 1].layer) ||
      new Set(windows.map(w => w.id)).size !== windows.length) return refuse('invalid window list');
  const index = windows.findIndex(w => w.pid === pid && w.id === panelID);
  const owned = windows[index];
  if (requiresPanel && (!rect(panel) || !owned || owned.alpha <= 0 || !sameRect(panel, owned.bounds)))
    return refuse('missing or stale panel identity');
  if (!requiresPanel && (panel != null || panelID != null)) return refuse('hidden control or baseline has a panel');
  let backdropIndex = -1;
  if (surface === 'changing') {
    if (!backdrop || backdrop.raised !== true || backdrop.visible !== true || backdrop.level !== 1 ||
        backdrop.ignoresMouseEvents !== true || backdrop.canBecomeKey !== false || backdrop.canBecomeMain !== false ||
        !Array.isArray(fixtureIDs) || fixtureIDs.length !== 3 || new Set(fixtureIDs).size !== 3)
      return refuse('changing backdrop was not raised safely');
    if (!Array.isArray(fixtureWindows) || fixtureWindows.length !== 3 || new Set(fixtureWindows.map(w => w?.id)).size !== 3 ||
        fixtureWindows.some(w => !fixtureIDs.includes(w?.id) || w.ignoresMouseEvents !== true ||
          w.canBecomeKey !== false || w.canBecomeMain !== false)) return refuse('raised targets are not click-through and non-activating');
    backdropIndex = windows.findIndex(w => w.pid === pid && w.id === backdrop.id);
    const background = windows[backdropIndex];
    if (!background || background.layer !== 1 || background.alpha <= 0 ||
        fixtureIDs.some(id => !windows.some((w, i) => w.id === id && w.pid === pid && w.layer === 2 && w.alpha > 0 && i < backdropIndex)) ||
        requiresPanel && (index >= backdropIndex || owned.layer < 3 || !encloses(background.bounds, panel)))
      return refuse('fixture ordering or backdrop coverage changed');
  }
  // A hidden control has no character panel. Check the whole fixture surface conservatively.
  const area = requiresPanel ? panel : surface === 'changing' ? windows[backdropIndex]?.bounds : backdrop?.bounds;
  if (!rect(area)) return refuse('missing control surface bounds');
  const overlapping = area ? windows.filter(w => w.pid !== pid && w.alpha > 0 && overlaps(w.bounds, area)) : [];
  const candidates = overlapping.filter(w => (requiresPanel ? w.layer >= owned.layer : surface === 'quiet' && w.layer >= 3) ||
    surface === 'changing' && windows.indexOf(w) < backdropIndex && (!requiresPanel || windows.indexOf(w) > index));
  const interfering = candidates.map(w => {
    const server = Number.isSafeInteger(windowServerPid) && windowServerPid > 0 && w.pid === windowServerPid && WINDOW_SERVER_OWNERS.has(w.owner);
    const opaqueContent = w.alpha >= 1 && encloses(w.bounds, area);
    return { ...w, invalidates: !server || opaqueContent,
      reason: server ? opaqueContent ? 'opaque WindowServer content covers panel' : 'WindowServer cursor or system overlay' : 'foreign app content' };
  });
  return { ...evidence, valid: !interfering.some(w => w.invalidates), interfering, overlapping };
}
export async function collectSurfaceCheck({ session, helper, surface, requiresPanel, boundary, now = Date.now, log = console.log }) {
  const startedAtMs = now(), snapshot = await session.request({ bench: 'query' });
  const receipt = await helper(['windows']);
  const check = { ...stageSurfaceObservation(snapshot, receipt, { surface, requiresPanel, startedAtMs, completedAtMs: now() }), boundary };
  log(`ST9 surface ${surface} ${requiresPanel ? 'phase' : 'control/baseline'} ${boundary}: valid=${check.valid}; reason=${check.reason ?? 'none'}; interfering=${JSON.stringify(check.interfering)}`);
  return check;
}
export function stageSurfaceChecksValid(checks, boundaries, surface, requiresPanel = true) {
  return Array.isArray(checks) && checks.length === boundaries.length && checks.every((c, i) => c?.boundary === boundaries[i] &&
    c.surface === surface && c.requiresPanel === requiresPanel && c.valid === true && stageSurfaceObservation(c, c, c).valid);
}

// Include failed and discarded payloads: an invalid first boundary never reaches a completed phase.
export function stageRecurringWindows(evidence) {
  const checks = new Map();
  const read = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(read); return; }
    if (Array.isArray(value.interfering) && typeof value.boundary === 'string' && Number.isFinite(value.observedAtMs)) {
      const key = JSON.stringify([value.observedAtMs, value.pid, value.panelID, value.surface, value.requiresPanel, value.boundary]);
      checks.set(key, value);
    }
    for (const key of ['surfaceChecks', 'surfaceCheck', 'phases']) {
      const child = value[key];
      if (Array.isArray(child)) read(child);
      else if (child && typeof child === 'object') Object.values(child).forEach(read);
    }
    read(value.control);
  };
  for (const run of evidence.runs ?? []) {
    for (const rows of Object.values(run.baselines ?? {})) read(rows);
    for (const size of Object.values(run.sizes ?? {})) read(size);
  }
  for (const attempt of [...evidence.collection?.attempts ?? [], ...evidence.collection?.inProgress ? [evidence.collection.inProgress] : []])
    read(attempt.evidence);
  const invalid = [...checks.values()].sort((a, b) => a.observedAtMs - b.observedAtMs)
    .map(check => ({ ...check, ...stageSurfaceObservation(check, check, check) })).filter(check => !check.valid);
  if (invalid.length < 2) return [];
  const [first, second] = invalid;
  return first.interfering.filter(w => w.invalidates && second.interfering.some(other =>
    other.invalidates && other.owner === w.owner && other.id === w.id)).map(w => ({
    owner: w.owner ?? 'unknown', pid: w.pid, windowId: w.id, level: w.layer, bounds: w.bounds,
    firstSeen: new Date(first.observedAtMs).toISOString(),
  }));
}
