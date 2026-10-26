// The owner-returned rule for unattended VC7 runs. sleight's own away rule (lib/remote-approvals.mjs isPresent) reads the
// HID idle time; a person is present when it is under 120 s. A live run can't use that rule as it is, because its own
// engine clicks and keystrokes may reset the idle clock too. So the run marks when it last made input itself (the end of a
// step, or the end of another project's hold), and the owner is back when the idle time is shorter than the time since then:
// someone else touched the keyboard or pointer after the run went quiet. slackS covers the idle reader's own latency.
import { idleSeconds as readIdle } from '../compat/live.mjs';

export const SLACK_S = 5;

/** { back, idleS, quietS, unknown? }. unknown: the idle time could not be read, which never stops a run on its own. */
export function ownerBack({ idleS, quietSinceMs, nowMs, slackS = SLACK_S }) {
  const quietS = (nowMs - quietSinceMs) / 1000;
  if (!Number.isFinite(idleS) || idleS < 0 || !Number.isFinite(quietS)) return { back: false, unknown: true, idleS: null, quietS };
  return { back: quietS > slackS && idleS + slackS < quietS, idleS: Math.round(idleS * 10) / 10, quietS: Math.round(quietS * 10) / 10 };
}

/** A watcher: quiet() marks now as the run's last own input; check() applies ownerBack with a fresh idle reading. */
export function createOwnerWatch({ idle = readIdle, now = Date.now, slackS = SLACK_S } = {}) {
  let quietSince = now();
  return {
    quiet(at = now()) { quietSince = at; },
    get quietSince() { return quietSince; },
    async check() {
      let idleS;
      try { idleS = await idle(); } catch { idleS = undefined; }
      return ownerBack({ idleS, quietSinceMs: quietSince, nowMs: now(), slackS });
    },
  };
}

export const ownerWords = result => `the owner is back: input ${result.idleS} s ago, ${Math.round((result.quietS - result.idleS) * 10) / 10} s after this run's last own input`;
