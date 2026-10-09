import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function probeAppHealth(app) {
  return new Promise(resolve => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', fileURLToPath(new URL('./app-health.js', import.meta.url)), JSON.stringify(app)],
      { timeout: 2000, maxBuffer: 4096 }, (error, stdout) => {
        // A process deadline alone cannot attribute a hang to the target app.
        if (error) { resolve({ status: 'unknown' }); return; }
        try { resolve(JSON.parse(stdout)); } catch { resolve({ status: 'unknown' }); }
      });
  });
}

// The current Space is full screen or Split View, and the app has windows that aren't minimized,
// none of them on it (8 of 21 runs failed that way, 2026-10-08). A hidden app's windows are off
// screen too, which isn't this.
export function offSpace(health) {
  return health?.fullScreenSpace === true && health.hidden === false && health.onScreen === 0 &&
    health.allWindows - (health.minimized ?? 0) > 0;
}

export function offSpaceNote(app) {
  return `sleight: the user is in a full-screen or Split View Space, and none of ${app}'s windows are on it. Clicks and typing still reach the app, but drags fail and reads can time out. Before you drag, or if a read times out, ask the user to show ${app}'s window on the current desktop (leave full screen or Split View), then read it again.`;
}

export function classifyReadFailure({ target, control, read }) {
  if (offSpace(target)) return 'app-off-space';
  if (read?.status === 'responding') {
    if (target?.status === 'timeout') return 'app-hung';
    if (target?.status === 'responding') return target.windows === 0 ? 'app-windows' : 'app-read';
  }
  if (read?.status === 'timeout' && target?.status === 'responding' && target.windows > 0 &&
      control?.status === 'responding' && control.windows > 0) return 'helper-stuck';
  return 'unknown';
}

export async function diagnoseReadFailure(app, control, { probeApp = probeAppHealth, readControl } = {}) {
  const safe = async fn => { try { return await fn(); } catch { return { status: 'unknown' }; } };
  const target = await safe(() => probeApp(app));
  if (offSpace(target)) return { kind: 'app-off-space', target };
  if (!control || !readControl) return { kind: 'unknown', target };
  const other = await safe(() => probeApp(control));
  const read = await safe(() => readControl(control));
  return { kind: classifyReadFailure({ target, control: other, read }), target, other, read, control };
}

export function readFailureAdvice(app, diagnosis = { kind: 'unknown' }) {
  const recovery = 'Stop retrying. sleight will retry by itself with one standalone read every 20 s and resume this app after a successful read.';
  if (diagnosis.kind === 'app-off-space') return `${offSpaceNote(app)} ${recovery}`;
  if (diagnosis.kind === 'helper-stuck') return `The SkyComputerUseService read path appears stuck: ${app} and ${diagnosis.control} answer Accessibility, but the control app's engine read also timed out. ${recovery} Tell the user to restart ChatGPT to recover computer use. Restarting ends their Codex sessions; never restart or quit ChatGPT yourself.`;
  if (['app-hung', 'app-windows', 'app-read'].includes(diagnosis.kind)) {
    const reason = diagnosis.kind === 'app-hung' ? 'does not answer Accessibility' : diagnosis.kind === 'app-windows' ? 'has no Accessibility windows' : 'answers Accessibility but its engine reads fail';
    return `${app} ${reason}, while a fresh engine read of ${diagnosis.control} responds. ${recovery} Tell the user to save any unsaved work if possible, then quit and reopen ${app}. The helper answered the control read.`;
  }
  return `Reads of ${app} timed out twice. The app and helper cause was not determined; sleight could not distinguish them with its independent checks. ${recovery} Report the uncertainty to the user. A successful inventory alone does not prove app reads work.`;
}
