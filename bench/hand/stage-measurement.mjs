import { stageUnitFailure, stageFailureKind } from './stage-progress.mjs';
// ST9 measurement protocols. All host and clock access is supplied by the caller.
import { createHash } from 'node:crypto';
import { playSequence } from './cursor-sequence.mjs';
import { summarize } from './cost-sampler.mjs';

const finite = n => Number.isFinite(n) && n >= 0;
export const STAGE_DISPATCH_TOLERANCE_MS = 250;
export const STAGE_CONTROL_LAYOUT = 'bracketed/1';
export function stageScriptDigest(actions, windows) {
  if (!Array.isArray(actions) || !actions.length || !Array.isArray(windows)) return null;
  const steps = [];
  for (const [i, action] of actions.entries()) {
    const { frame, scheduledMs, dispatchedMs } = action ?? {};
    const slot = windows.findIndex(w => w.id === frame?.windowId && w.pid === frame?.pid);
    if (action?.order !== i || !finite(scheduledMs) || !finite(dispatchedMs) || slot < 0 ||
        Math.abs(dispatchedMs - scheduledMs) > STAGE_DISPATCH_TOLERANCE_MS ||
        !['aim', 'act', 'status'].includes(frame?.hand) || i && dispatchedMs < actions[i - 1].dispatchedMs) return null;
    const { nonce, seq, pid, windowId, ...payload } = frame;
    steps.push({ scheduledMs, frame: { ...payload, pid: 'fixture', windowId: slot } });
  }
  return createHash('sha256').update(JSON.stringify(steps)).digest('hex');
}

export function stageScriptReceipt(actions, windows) {
  const scriptDigest = stageScriptDigest(actions, windows);
  const maxDispatchErrorMs = actions?.length ? Math.max(...actions.map(a => Math.abs(a.dispatchedMs - a.scheduledMs))) : null;
  if (!scriptDigest) throw stageUnitFailure('fixture-seat', `script dispatch or identity refused; largest error ${maxDispatchErrorMs} ms`, { actions, maxDispatchErrorMs });
  return { scriptDigest, maxDispatchErrorMs };
}

export function stageControlFigures(control) {
  if (control?.layout !== undefined) {
    if (control.layout !== STAGE_CONTROL_LAYOUT) return null;
    const { before, after } = control;
    if (!before || !after || before.layout !== undefined || after.layout !== undefined ||
        !finite(control.phaseStart) || !finite(control.phaseEnd) ||
        !(before.end <= control.phaseStart && control.phaseStart < control.phaseEnd && control.phaseEnd <= after.start) ||
        !['scriptDigest', 'size', 'surface', 'changing'].every(key => before[key] === after[key])) return null;
    const a = stageControlFigures(before), b = stageControlFigures(after);
    if (!a || !b) return null;
    const mean = (before, after, key) => Number.isFinite(before[key]) && Number.isFinite(after[key]) ? (before[key] + after[key]) / 2 : null;
    return { ...Object.fromEntries(['activeS', 'hostAvgPct', 'hostCpuS', 'wsAvgPct', 'wsPeakPct', 'wsRunnerUpPct'].map(key => [key, mean(a, b, key)])),
      before: a, after: b, spread: Object.fromEntries(['wsAvgPct', 'wsPeakPct', 'hostAvgPct'].map(key =>
        [key, Number.isFinite(a[key]) && Number.isFinite(b[key]) ? Math.abs(a[key] - b[key]) : null])) };
  }
  const firstSample = control?.firstSample ?? 0;
  const rows = Array.isArray(control?.samples) && Number.isSafeInteger(firstSample) && firstSample >= 0 ?
    control.samples.slice(firstSample).filter(s => s && s.t >= control.start && s.t <= control.end) : [];
  const valid = control?.scriptDigest === stageScriptDigest(control?.actions, control?.windows) && finite(control?.start) && finite(control?.end) && rows?.length >= 60 &&
    rows[0].t === control.start && rows.at(-1).t === control.end && /^[a-f0-9]{64}$/.test(control.scriptDigest ?? '') && rows.every((s, i) =>
    finite(s.ws) && s.status?.pid === control.pid && s.status?.characterHiddenControl === true && s.status.shown === false &&
    (!i || s.t > rows[i - 1].t && s.t - rows[i - 1].t <= 1500 && s.ws >= rows[i - 1].ws));
  if (!valid) return null;
  const hostValid = rows.every((s, i) => Object.keys(s.hosts ?? {}).length === 1 && finite(s.hosts[control.pid]?.cpu) &&
    (!i || s.hosts[control.pid].cpu >= rows[i - 1].hosts?.[control.pid]?.cpu));
  const result = summarize(rows.map(s => ({ ...s, hosts: hostValid ? s.hosts : {} })), { peakSamplePeriodMs: 1000 });
  return result.wallS >= 60 ? { activeS: result.wallS, wsAvgPct: result.windowServer?.avgPct,
    hostAvgPct: hostValid ? result.hand.avgPct : null, hostCpuS: hostValid ? result.hand.cpuS : null,
    wsPeakPct: result.windowServer?.peakPct, wsRunnerUpPct: result.windowServer?.runnerUpPct } : null;
}

// Every completed phase, including a visibility failure, keeps both controls in the same unit.
// Global stops still abort immediately instead of starting another hidden session.
export async function collectBracketedPhase({ collectControl, collectPhase }) {
  let before, after, phase, failure;
  try {
    before = await collectControl();
    try { phase = await collectPhase(); }
    catch (error) { if (error.runStop || !stageFailureKind(error)) throw error; failure = error; phase = error.unitEvidence; }
    after = await collectControl();
  } catch (error) {
    const primary = failure && !error.runStop ? failure : error;
    primary.unitEvidence = { ...phase, control: { layout: STAGE_CONTROL_LAYOUT, before, after },
      controlFailure: { kind: stageFailureKind(error), message: error.message, evidence: error.unitEvidence },
      ...(failure ? { phaseFailure: failure.message } : {}) };
    throw primary;
  }
  const control = { layout: STAGE_CONTROL_LAYOUT, before, after, phaseStart: phase?.marks?.start, phaseEnd: phase?.marks?.idleEnd };
  if (phase?.figures) phase.figures.control = control;
  if (failure) { failure.unitEvidence = { ...phase, control }; throw failure; }
  return phase;
}

export async function collectHiddenControl({ session, sequence, wait, surface, size, checkSurface = async () => null, now = Date.now }) {
  const surfaceChecks = [await checkSurface('active-start')];
  await session.sampler.sample();
  const firstSample = session.sampler.samples.length - 1, start = session.sampler.samples[firstSample].t;
  const actions = [];
  await playSequence(sequence, { wire: session.wire, write: session.write, sleep: wait, now, record: row => actions.push(row) });
  await wait(Math.max(0, 61000 - (now() - start)));
  await session.sampler.pause();
  // Keep a terminal endpoint distinct even when a periodic read just finished in the same clock millisecond.
  await wait(2);
  await session.sampler.stop();
  const end = session.sampler.samples.at(-1).t;
  surfaceChecks.push(await checkSurface('active-end'));
  return { start, end, firstSample, pid: session.pid, surface, size, changing: surface === 'changing', surfaceChecks,
    windows: session.ready.windows, ...stageScriptReceipt(actions, session.ready.windows), samples: session.sampler.samples, actions };
}

export function stageParkedChildFigures(first, last) {
  const a = first?.processTree, b = last?.processTree;
  const delta = (x, y) => finite(x) && finite(y) && y >= x ? y - x : null;
  const workerLifetimeStable = typeof a?.microphoneWorker?.startID === 'string' &&
    a.microphoneWorker.startID === b?.microphoneWorker?.startID;
  return { workerLifetimeStable,
    microphoneWorkerCpuS: workerLifetimeStable ? delta(a.microphoneWorker.cpuS, b.microphoneWorker.cpuS) : null,
    reapedChildrenCpuS: delta(a?.reapedChildrenCpuS, b?.reapedChildrenCpuS),
    childrenCpuS: delta(a?.childrenCpuS, b?.childrenCpuS),
    scope: 'persistent microphone worker separately from all collected children; totals remain judged' };
}
// No ps, status reply or tree walk is requested between these two endpoint reads.
// Lifetime and hide counters at both ends catch process replacement and transient panel loss.
export async function collectParkedInterval({ session, wait, size, recordVisibility, checkSurface = async () => null }) {
  const sampler = session.sampler;
  await sampler.pause();
  await wait(6000);
  // Any final park-pose decode must settle before the CPU baseline, never be subtracted from the judged total.
  if (session.ready?.parkedReady === true) {
    let settled;
    for (let attempt = 0; attempt <= 20; attempt++) {
      settled = await session.request({ bench: 'parkReady' });
      if (settled.ready === true) break;
      if (attempt < 20) await wait(250);
    }
    if (settled.ready !== true) throw stageUnitFailure('child', 'park decode did not settle before the CPU baseline', settled);
  }
  const endpoint = async () => {
    await sampler.sample({ observer: () => session.request({ bench: 'tree' }) });
    const row = sampler.samples.at(-1);
    recordVisibility(row.status, size, row.t);
    return row;
  };
  await checkSurface('parked-start');
  const first = await endpoint();
  await wait(61000);
  const last = await endpoint();
  await checkSurface('parked-end');
  await sampler.stop({ finalSample: false });
  const a = first.status, b = last.status;
  const stable = a.panelID > 0 && a.panelID === b.panelID && a.processTree?.startID === b.processTree?.startID &&
    Number.isSafeInteger(a.installCount) && a.installCount === b.installCount &&
    typeof a.processTree?.startID === 'string' &&
    a.hideReasonCounts && b.hideReasonCounts && JSON.stringify(a.hideReasonCounts) === JSON.stringify(b.hideReasonCounts);
  if (!stable) throw Object.assign(Error('invalid parked visibility or process lifetime'), {
    invalidVisibility: { reason: 'parked panel or lifetime changed between endpoints', first: a, last: b },
  });
  return { parkedStart: first.t, idleEnd: last.t,
    ...(a.processTree?.reapedChildrenCpuS !== undefined ? { parkedChildren: stageParkedChildFigures(a, b) } : {}) };
}

export function stageMemoryFigures(samples, baseline, pid) {
  const rows = samples.map(s => s.hosts?.[pid]).filter(Boolean), base = baseline?.hosts?.[pid];
  const peak = rows => rows.length && rows.every(h => finite(h.rssKb)) ? Math.max(...rows.map(h => h.rssKb)) / 1024 : null;
  const fixtureMiB = base?.tree?.liveChildren === 0 && finite(base.rssKb) ? base.rssKb / 1024 : null;
  const peakMiB = peak(rows);
  const endpointSample = samples.at(-1);
  const endpoint = endpointSample?.status?.pid === Number(pid) && endpointSample.status.reply === 'tree' ? endpointSample.hosts?.[pid] : null;
  // Old banks have no child argv. Infer a transient decoder only when pending art and extra live children
  // coincide, relative to the parked endpoint's resident worker count. Never discard the worker itself.
  const decodeSample = s => {
    const host = s.hosts?.[pid];
    if (Array.isArray(host?.rssTree)) return host.rssTree.some(row => row.kind === 'decode');
    return finite(endpoint?.tree?.liveChildren) && s.status?.pid === Number(pid) && s.status.pending > 0 &&
      host?.tree?.liveChildren > endpoint.tree.liveChildren;
  };
  const filtered = endpoint ? samples.filter(s => !decodeSample(s)).map(s => s.hosts?.[pid]).filter(Boolean) : [];
  return { fixtureMiB, fixtureSample: baseline ?? null, treePeakMiB: peakMiB,
    incrementMiB: fixtureMiB !== null && peakMiB !== null ? peakMiB - fixtureMiB : null,
    treePeakWithLiveChildrenMiB: peak(rows.filter(h => h.tree?.liveChildren > 0)),
    treePeakWithoutLiveChildrenMiB: peak(rows.filter(h => h.tree?.liveChildren === 0)),
    parkedEndpointTreeMiB: endpoint ? endpoint.rssKb / 1024 : null,
    parkedEndpointSelfMiB: finite(endpoint?.selfRssKb) ? endpoint.selfRssKb / 1024 : null,
    treePeakWithoutDecodeChildMiB: peak(filtered),
    excludedDecodeSamples: endpoint ? samples.filter(decodeSample).length : null,
    decodeClassification: 'explicit child kind when available; otherwise inferred from pending art and children above the parked endpoint count',
    rendererOnlyMeasured: false, scope: 'fixture windows and renderer share one process; descendants included' };
}
