// Offline interpretation of independent WindowServer samples. No host frame supplies measured geometry.
export const SAMPLE_MS = 50, MAX_GAP_MS = 100, TARGET_MARGIN_PT = 48;
const rect = value => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) && value[2] > 0 && value[3] > 0;
const expand = r => [r[0] - 48, r[1] - 48, r[2] + 96, r[3] + 96];
// Contact counts, including an exactly shared edge.
export const touches = (a, b) => rect(a) && rect(b) && a[0] <= b[0] + b[2] && b[0] <= a[0] + a[2] && a[1] <= b[1] + b[3] && b[1] <= a[1] + a[3];
export function createWindowSampler() {
  let lastValidStatus;
  return input => {
    const row = sampleWindows({ ...input, lastValidStatus });
    if (row.valid) lastValidStatus = structuredClone(input.status);
    return row;
  };
}
export function sampleWindows({ t, status, windows, appPids = [], lastValidStatus, accessibility = [] }) {
  const validStatus = Number.isFinite(t) && Number.isFinite(status?.hostTimeMs) && t >= status.hostTimeMs && t - status.hostTimeMs <= MAX_GAP_MS &&
    Number.isSafeInteger(status.pid) && Array.isArray(status.wideWindows) && Array.isArray(status.protectedRects) &&
    status.wideWindows.every(w => Number.isSafeInteger(w.pid) && Number.isSafeInteger(w.id)) && status.protectedRects.every(rect);
  const list = Array.isArray(windows) ? [...windows] : [];
  // Keep the last fresh protection identity during a host stall. Window frames still come from this tick's independent list.
  const protection = validStatus && Array.isArray(windows) ? status : lastValidStatus;
  const host = protection ?? status;
  if (Number.isSafeInteger(host?.pid) && host.pid > 0 &&
      Number.isSafeInteger(host?.panelID) && host.panelID > 0) {
    const matches = accessibility.filter(w => w.pid === host.pid && w.title === 'sleight check 4 character' &&
      w.identifier === 'sleight.check4.character' && w.role === 'AXWindow');
    if (matches.length === 1 && matches[0].hidden === false && matches[0].minimized === false && rect(matches[0].frame)) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].pid === host.pid && list[i].id === host.panelID) list.splice(i, 1);
      list.push({ pid: host.pid, id: host.panelID, layer: 3, alpha: 1, frame: matches[0].frame, source: 'Accessibility' });
    }
  }
  const panels = list.filter(w => w.pid === host?.pid && w.id === host?.panelID && rect(w.frame));
  const panel = { pid: host?.pid ?? null, id: host?.panelID ?? null, onScreen: panels.length === 1 && panels[0].alpha > 0,
    frame: panels.length === 1 ? panels[0].frame : null, alpha: panels.length === 1 ? panels[0].alpha : 0 };
  if (panels.length === 1 && panels[0].source) panel.source = panels[0].source;
  const intersections = [], artIntersections = [];
  // CA7 removed panel padding. The independently observed panel encloses the drawn cell.
  const independentArt = panel.onScreen ? panel.frame : null;
  if (panel.onScreen && protection) {
    for (const key of protection.wideWindows) for (const w of list.filter(w => w.pid === key.pid && w.id === key.id && rect(w.frame) && w.alpha > 0))
      {
        if (touches(panel.frame, expand(w.frame))) intersections.push({ kind: 'wide-window', pid: w.pid, id: w.id, frame: expand(w.frame) });
        if (touches(independentArt, expand(w.frame))) artIntersections.push({ kind: 'wide-window', pid: w.pid, id: w.id });
      }
    for (const [index, frame] of protection.protectedRects.entries()) {
      if (touches(panel.frame, frame)) intersections.push({ kind: 'protected-rectangle', index, frame });
      if (touches(independentArt, frame)) artIntersections.push({ kind: 'protected-rectangle', index });
    }
  }
  return { t, source: 'CGWindowListCopyWindowInfo', valid: validStatus && Array.isArray(windows), status,
    panel, independentArt, artIntersections, windows: list.filter(w => appPids.includes(w.pid)), intersections };
}
export function summarizeSamples(rows, { start, end, requestedSize = 'stage' }) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return { measured: false, visibleShare: null, reason: 'missing driving interval' };
  const sorted = rows.filter(r => Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
  let visibleMs = 0, fullStageMs = 0, anyRungMs = 0, measuredMs = 0, samplerIntersections = 0;
  const gaps = [];
  const timeByRungMs = { stage: 0, 'three-quarter': 0, small: 0, medium: 0, unknown: 0 };
  const timeByRendererMs = { stage: 0, 'legacy-perch': 0, unknown: 0 };
  for (const row of sorted) if (row.t >= start && row.t <= end) samplerIntersections += row.intersections?.length ?? 0;
  for (let i = 1; i < sorted.length; i++) {
    const before = sorted[i - 1], after = sorted[i], durationMs = after.t - before.t;
    const span = Math.max(0, Math.min(end, after.t) - Math.max(start, before.t));
    if (span <= 0) continue;
    if (durationMs > MAX_GAP_MS) { gaps.push({ start: before.t, end: after.t, durationMs }); continue; }
    if (before.valid && after.valid) {
      measuredMs += span;
      const sameRung = before.status?.size === after.status?.size && ['stage', 'three-quarter', 'medium', 'small'].includes(before.status?.size);
      const sameRenderer = before.status?.rendererPath === after.status?.rendererPath &&
        ['stage', 'legacy-perch'].includes(before.status?.rendererPath);
      if (sameRung) timeByRungMs[before.status.size] += span;
      if (sameRenderer) timeByRendererMs[before.status.rendererPath] += span;
      if (sameRung && sameRenderer && before.status.rendererPath === 'stage' && before.panel?.onScreen && after.panel?.onScreen &&
          before.status?.shown === true && after.status?.shown === true) {
        anyRungMs += span;
        if (before.status.size === 'stage') fullStageMs += span;
        if (before.status.size === requestedSize || requestedSize === 'stage' && before.status.size === 'three-quarter') visibleMs += span;
      }
    }
  }
  const durationMs = end - start;
  timeByRungMs.unknown = durationMs - timeByRungMs.stage - timeByRungMs['three-quarter'] - timeByRungMs.small - timeByRungMs.medium;
  timeByRendererMs.unknown = durationMs - timeByRendererMs.stage - timeByRendererMs['legacy-perch'];
  const shown = sorted.filter(r => r.t >= start && r.t <= end && r.status?.shown === true);
  const differences = shown.filter(r => r.panel?.onScreen && rect(r.panel.frame) && rect(r.status.panel))
    .map(r => Math.max(...r.panel.frame.map((n, i) => Math.abs(n - r.status.panel[i]))));
  const agreeingSamples = differences.filter(n => n <= 2).length;
  const within2PtShare = shown.length ? agreeingSamples / shown.length : null;
  const panelAgreement = { shownSamples: shown.length, observedSamples: differences.length, agreeingSamples,
    within2PtShare, maxDifferencePt: differences.length ? Math.max(...differences) : null,
    passed: shown.length > 0 && within2PtShare >= 0.95 };
  const shownFrames = sorted.filter(r => r.t >= start && r.t <= end && r.valid && r.status?.shown === true && r.panel?.onScreen);
  const firstStageFamily = shownFrames.find(r => r.status.rendererPath === 'stage' && ['stage', 'three-quarter'].includes(r.status.size));
  const fixtureFrames = [...new Map(sorted.filter(r => r.t >= start && r.t <= end).flatMap(r =>
    (r.windows ?? []).filter(w => w.layer === 0 && w.alpha > 0 && rect(w.frame)).map(w => {
      const usable = r.status?.usableFrame;
      const free = rect(usable) ? { left: Math.max(0, w.frame[0] - 48 - usable[0]),
        right: Math.max(0, usable[0] + usable[2] - w.frame[0] - w.frame[2] - 48),
        above: Math.max(0, w.frame[1] - 48 - usable[1]), below: Math.max(0, usable[1] + usable[3] - w.frame[1] - w.frame[3] - 48) } : null;
      return [JSON.stringify([w.pid, w.id, w.frame]), { pid: w.pid, id: w.id, frame: w.frame, freeSpacePt: free }];
    }))).values()];
  const artRows = sorted.filter(r => r.t >= start && r.t <= end && r.panel?.onScreen);
  const independentArtIntersections = artRows.length && artRows.every(r => Array.isArray(r.artIntersections) && rect(r.independentArt))
    ? artRows.reduce((n, r) => n + r.artIntersections.length, 0) : null;
  return { measured: measuredMs > 0, durationMs, visibleMs, hiddenMs: durationMs - visibleMs, measuredMs, panelAgreement,
    timeToFirstFrameMs: shownFrames.length ? shownFrames[0].t - start : null,
    timeToFirstStageFamilyFrameMs: firstStageFamily ? firstStageFamily.t - start : null, fixtureFrames, independentArtIntersections,
    visibleShare: visibleMs / durationMs, fullStageShare: fullStageMs / durationMs, visibleAnyRung: anyRungMs / durationMs, requestedSize, timeByRungMs, timeByRendererMs, samplerIntersections, gaps,
    samples: sorted.filter(r => r.t >= start && r.t <= end).length };
}
export const RESEAT_GRACE_MS = 2000;
export function smokeResult(result, rows) {
  const statuses = rows.filter(r => r.valid && r.t >= result.driving?.start && r.t <= result.driving?.end).map(r => r.status);
  const shownAtStage = statuses.some(s => s.shown === true && s.rendererPath === 'stage' && s.size === 'stage');
  const shownAtStageFamily = statuses.some(s => s.shown === true && s.rendererPath === 'stage' && ['stage', 'three-quarter'].includes(s.size));
  const targetsReceived = statuses.some(s => s.turnTargets > 0 || s.protectedRects?.length > 0);
  const panelAgreement = summarizeSamples(rows, { start: result.driving?.start, end: result.driving?.end }).panelAgreement;
  const passed = result.benchmarkPassed === true && result.cleanupConfirmed === true && shownAtStageFamily && targetsReceived && panelAgreement?.passed;
  return { ...result, panelAgreement, smoke: { shownAtStage, shownAtStageFamily, targetsReceived }, verdict: passed ? 'pass' : 'fail',
    reason: passed ? null : result.characterNeverShown ? result.reason :
      !shownAtStageFamily ? 'Smoke: character never shown at stage family size during driving' :
      !targetsReceived ? 'Smoke: host received no turn targets during driving' :
      !panelAgreement?.passed ? 'Smoke: independent panel agreement below 95% within 2 pt' : result.reason ?? 'Smoke: benchmark or cleanup failed' };
}
export function taskResult({ taskId, replay, rows = [], start, end, audit, reseated = false, requestedSize = 'stage', requiresWide = taskId === 'finder-move' }) {
  const figures = summarizeSamples(rows, { start, end, requestedSize });
  // The verdict covers driving plus the turn-end re-seat (live check 3 re-seated within 1 s). Later setup and cleanup
  // samples, which model runs also record, are reported in samplerIntersections but never decide the task.
  const judgeEnd = end + RESEAT_GRACE_MS, judged = rows.filter(r => r.t >= start && r.t <= judgeEnd);
  const drivingStatuses = rows.filter(r => r.t >= start && r.t <= end && r.valid).map(r => r.status);
  const statuses = judged.filter(r => r.valid).map(r => r.status);
  const characterNeverShown = drivingStatuses.length > 0 && drivingStatuses.every(s => s.shown !== true);
  const drivingHideSamples = {};
  for (const status of drivingStatuses) if (status.shown !== true) {
    const reason = typeof status.hideReason === 'string' ? status.hideReason : 'unknown';
    drivingHideSamples[reason] = (drivingHideSamples[reason] ?? 0) + 1;
  }
  const dominantHideReason = Object.entries(drivingHideSamples).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  const protectionObserved = drivingStatuses.some(s => s.protectedRects.length > 0 || s.wideWindows.length > 0);
  const wideObserved = drivingStatuses.some(s => s.wideWindows.length > 0);
  const protectionReason = !protectionObserved ? 'No protection observed during driving' :
    requiresWide && !wideObserved ? 'No wide protection observed during drag or scroll driving' : null;
  const counts = {}, differences = [];
  for (const status of statuses) {
    for (const [key, value] of Object.entries(status.hideReasonCounts ?? {})) counts[key] = Math.max(counts[key] ?? 0, value);
    if (Number.isFinite(status.maxWindowBoundsDifferencePt)) differences.push(status.maxWindowBoundsDifferencePt);
  }
  const fixtureFailure = replay?.lifecycle?.passed !== true;
  const areaGeometry = judged.some(r => r.valid && r.status?.areaProtection === true && r.status.wideWindows?.some(key =>
    r.windows?.some(w => w.pid === key.pid && w.id === key.id && rect(w.frame) && w.alpha > 0)));
  const measured = !fixtureFailure && replay?.verdict === 'pass' && replay.cleanupConfirmed === true && figures.measured &&
    audit?.complete === true && Number.isSafeInteger(audit.intersections) && (differences.length > 0 || areaGeometry) && !protectionReason;
  const samplerIntersections = rows.reduce((sum, row) => sum + (row.intersections?.length ?? 0), 0);
  const judgedSamplerIntersections = judged.reduce((sum, row) => sum + (row.intersections?.length ?? 0), 0);
  const artRows = judged.filter(r => r.panel?.onScreen);
  const judgedIndependentArtIntersections = artRows.length && artRows.every(r => Array.isArray(r.artIntersections) && rect(r.independentArt))
    ? artRows.reduce((n, r) => n + r.artIntersections.length, 0) : null;
  return { ...figures, measured, fixtureFailure, cleanupConfirmed: replay?.cleanupConfirmed === true,
    samplerIntersections, drivingSamplerIntersections: figures.samplerIntersections, judgedSamplerIntersections, judgedIndependentArtIntersections,
    visibleShare: measured ? figures.visibleShare : null, visibleMs: measured ? figures.visibleMs : null, auditStageTrace: audit ?? null,
    hideReasonCounts: counts, characterNeverShown, dominantHideReason, drivingHideSamples,
    protectionObserved, wideObserved, geometryBasis: differences.length ? 'measured-action-frame' : areaGeometry ? 'window-area' : null,
    maxWindowBoundsDifferencePt: differences.length ? Math.max(...differences) : null,
    turnEndedReseated: reseated, reason: characterNeverShown ? `character never shown (dominant hide reason: ${dominantHideReason})` :
      protectionReason ?? replay?.reason ?? (!measured ? 'fixture, sampler, real-frame status or trace evidence incomplete' : null),
    verdict: characterNeverShown ? 'fail' : !measured ? 'unmeasured' : figures.visibleShare >= 0.8 && judgedSamplerIntersections === 0 && audit.intersections === 0 && !audit.errors?.length ? 'pass' : 'fail' };
}
