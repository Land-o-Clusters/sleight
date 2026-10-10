import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HEALTH_SCRIPT = fileURLToPath(new URL('./app-health.js', import.meta.url));

// Each lane dispatches one operation at a time. Its deadline starts at dispatch, so killing a
// timed-out helper cannot interrupt queued work. Probes never share a process with slow queries.
function helperLane(kind, timeoutMs, spawnHelper) {
  let child, active, retiring, nextId = 0, closed = false;
  const queue = [];
  function retire() {
    if (!child) return;
    const old = child; child = undefined;
    // An idle helper is unref'd. Collection must keep the caller alive even after the force
    // timer fires, until libuv has reaped the child and closed its pipes.
    old.ref?.(); old.stdin.ref?.(); old.stdout.ref?.();
    retiring = new Promise(resolve => {
      const force = setTimeout(() => old.kill('SIGKILL'), 2000);
      old.once('close', () => { clearTimeout(force); resolve(); });
    });
    retiring.then(() => { retiring = undefined; pump(); });
    old.stdin.end(); old.kill();
  }
  function finish(reply, replace = false) {
    if (!active) return;
    const request = active; active = undefined;
    clearTimeout(request.timer); request.resolve(reply ?? request.fallback);
    if (replace) retire();
    pump();
  }
  function start() {
    const current = child = spawnHelper(kind);
    current.once('error', () => { if (child === current) finish(undefined, true); });
    current.once('close', () => { if (child === current) { child = undefined; finish(); } });
    current.stdin.on('error', () => { if (child === current) finish(undefined, true); });
    current.unref?.(); current.stdin.unref?.(); current.stdout.unref?.();
    createInterface({ input: current.stdout }).on('line', line => {
      let reply;
      try { reply = JSON.parse(line); } catch { return; }
      if (child !== current || reply?.id !== active?.id) return;
      delete reply.id; finish(reply);
    });
  }
  function pump() {
    if (closed || active || retiring || !queue.length) return;
    active = queue.shift();
    try {
      if (!child) start();
      active.id = nextId++;
      active.timer = setTimeout(() => finish(undefined, true), timeoutMs);
      child.stdin.write(JSON.stringify({ id: active.id, ...active.payload }) + '\n');
    } catch { finish(undefined, true); }
  }
  function request(payload, fallback) {
    if (closed) return Promise.resolve(fallback);
    return new Promise(resolve => {
      queue.push({ payload, fallback, resolve }); pump();
    });
  }
  return { request, close() {
    closed = true;
    for (const item of queue.splice(0)) item.resolve(item.fallback);
    finish(); retire();
    return retiring;
  } };
}

export function spawnAppHealthHelper(kind) {
  return spawn('/usr/bin/osascript', ['-l', 'JavaScript', HEALTH_SCRIPT,
    ...(kind === 'probe' ? [] : ['--session', dirname(HEALTH_SCRIPT)])], { stdio: ['pipe', 'pipe', 'ignore'] });
}

// Three lazy lanes: 2 s probes, 30 s targets, 30 s taps. A stuck scan cannot delay a target.
export function createAppHealthHelper({ timeoutMs = 2000, operationTimeoutMs = 30000,
  spawnHelper = spawnAppHealthHelper } = {}) {
  const probe = helperLane('probe', timeoutMs, spawnHelper);
  const target = helperLane('target', operationTimeoutMs, spawnHelper);
  const taps = helperLane('taps', operationTimeoutMs, spawnHelper);
  return {
    probe: app => probe.request({ app }, { status: 'unknown' }),
    target: args => target.request({ op: 'lease-target', app: args.app }, { ok: false,
      error: `Lease-target resolution failed: its helper was unavailable or did not answer within ${operationTimeoutMs / 1000} s. Stop this local action; reading the app again won't help.` }),
    keyboardTaps: async () => { const r = await taps.request({ op: 'keyboard-taps' }, { ok: false }); return r.ok ? r.taps : []; },
    close: () => Promise.all([probe.close(), target.close(), taps.close()]),
  };
}

export function probeAppHealth(app) {
  return new Promise(resolve => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', HEALTH_SCRIPT, JSON.stringify(app)],
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
