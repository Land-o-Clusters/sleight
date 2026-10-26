// The owner-returned rule for unattended VC7 runs. sleight's own away rule (lib/remote-approvals.mjs isPresent) reads the
// HID idle time; a person is present when it is under 120 s. A live run can't use that rule as it is, because its own
// engine clicks and keystrokes may reset the idle clock too. Two signals instead (sleight-arch, VC7HR):
//
// - Between checks: the run sleeps QUIET_GAP_MS with no input of its own, then reads the HID idle time (ioreg IOHIDSystem
//   HIDIdleTime). Idle shorter than the gap, by more than slackS, means someone else touched the keyboard or pointer.
// - During a check: the capture helper's watch-input reports the real pointer once a second. The engine acts on windows
//   and never moves the real pointer, so a pointer that leaves where it rested and stays away for MOVED_SAMPLES samples is
//   the owner (sleight's own foreground drag fallback moves the pointer and restores it at once, so a short excursion that
//   returns to the same point is not counted). In a check that makes no input at all, any HID input after the quiet mark
//   counts too.
import { idleSeconds as readIdle } from '../compat/live.mjs';

export const SLACK_S = 5;
export const QUIET_GAP_MS = 15000;
export const MOVED_SAMPLES = 3;

/** { back, idleS, quietS, unknown? }. unknown: the idle time could not be read, which never stops a run on its own. */
export function ownerBack({ idleS, quietSinceMs, nowMs, slackS = SLACK_S }) {
  const quietS = (nowMs - quietSinceMs) / 1000;
  if (!Number.isFinite(idleS) || idleS < 0 || !Number.isFinite(quietS)) return { back: false, unknown: true, idleS: null, quietS };
  return { back: quietS > slackS && idleS + slackS < quietS, idleS: Math.round(idleS * 10) / 10, quietS: Math.round(quietS * 10) / 10 };
}

/** A watcher: quiet() marks now as the run's last own input; check() applies ownerBack with a fresh idle reading;
 *  gapCheck() marks quiet, waits gapMs with no input of the run's own, then checks, so the gap is always real. */
export function createOwnerWatch({ idle = readIdle, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), slackS = SLACK_S, gapMs = QUIET_GAP_MS } = {}) {
  let quietSince = now();
  const check = async () => {
    let idleS;
    try { idleS = await idle(); } catch { idleS = undefined; }
    return ownerBack({ idleS, quietSinceMs: quietSince, nowMs: now(), slackS });
  };
  return {
    quiet(at = now()) { quietSince = at; },
    get quietSince() { return quietSince; },
    check,
    async gapCheck() { quietSince = now(); await sleep(gapMs); return check(); },
  };
}

export const ownerWords = result => result.reason ?? `the owner is back: input ${result.idleS} s ago, ${Math.round((result.quietS - result.idleS) * 10) / 10} s after this run's last own input`;

/** One watch-input line: { t, x, y, idle } (ms, global points, seconds). */
export function parseInputLine(line) {
  try {
    const v = JSON.parse(line);
    return Number.isFinite(v?.t) && Number.isFinite(v.x) && Number.isFinite(v.y) ? { t: v.t, x: v.x, y: v.y, idle: Number.isFinite(v.idle) ? v.idle : undefined } : undefined;
  } catch { return undefined; }
}

/** The mid-check detector, fed one sample at a time. harnessInput: the check itself makes input (engine clicks, arms), so
 *  only the pointer counts. quietSinceMs: the end of the quiet gap before the check. Returns { back, reason } once. */
export function createInputDetector({ harnessInput, quietSinceMs, slackS = SLACK_S, movedSamples = MOVED_SAMPLES, tolerance = 1 }) {
  let rest, away = 0, fired;
  return sample => {
    if (fired || !sample) return fired;
    if (!rest) rest = { x: sample.x, y: sample.y };
    const moved = Math.abs(sample.x - rest.x) > tolerance || Math.abs(sample.y - rest.y) > tolerance;
    away = moved ? away + 1 : 0;
    if (away >= movedSamples) {
      fired = { back: true, reason: `the owner is back: the pointer moved from ${Math.round(rest.x)},${Math.round(rest.y)} to ${Math.round(sample.x)},${Math.round(sample.y)} and stayed ${away} s` };
    } else if (!harnessInput && Number.isFinite(sample.idle)) {
      const sinceS = (sample.t - quietSinceMs) / 1000;
      if (sinceS > slackS && sample.idle + slackS < sinceS) fired = { back: true, reason: `the owner is back: HID input ${Math.round(sample.idle * 10) / 10} s ago during a check that makes no input` };
    }
    return fired;
  };
}
