import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HEALTH_SCRIPT = fileURLToPath(new URL('./app-health.js', import.meta.url));

// One long-lived app-health helper per session, started on first use. A probe that doesn't answer
// in time resolves 'unknown' and stops the helper, so a stuck Accessibility call can't hold up the
// next one, which starts a fresh helper.
export function createAppHealthHelper({ timeoutMs = 2000,
  spawnHelper = () => spawn('/usr/bin/osascript', ['-l', 'JavaScript', HEALTH_SCRIPT, '--session', dirname(HEALTH_SCRIPT)], { stdio: ['pipe', 'pipe', 'ignore'] }) } = {}) {
  let child, nextId = 0, closed = false;
  const pending = new Map();
  const stopping = new Set();
  const settleAll = () => { for (const finish of pending.values()) finish(); pending.clear(); };
  function stop() {
    if (!child) return;
    const old = child; child = undefined;
    // An idle helper is unref'd. Collection must keep the caller alive even after the force
    // timer fires, until libuv has reaped the child and closed its pipes.
    old.ref?.(); old.stdin.ref?.(); old.stdout.ref?.();
    const done = new Promise(resolve => {
      const force = setTimeout(() => old.kill('SIGKILL'), 2000);
      old.once('close', () => { clearTimeout(force); resolve(); });
    });
    stopping.add(done); done.then(() => stopping.delete(done));
    old.stdin.end(); old.kill(); settleAll();
  }
  function start() {
    const current = child = spawnHelper();
    current.once('error', () => { if (child === current) stop(); });
    current.once('exit', () => { if (child === current) { child = undefined; settleAll(); } });
    current.stdin.on('error', () => {});
    current.unref?.(); current.stdin.unref?.(); current.stdout.unref?.();
    createInterface({ input: current.stdout }).on('line', line => {
      let reply;
      try { reply = JSON.parse(line); } catch { return; }
      const finish = pending.get(reply?.id);
      if (!finish) return;
      pending.delete(reply.id); delete reply.id; finish(reply);
    });
  }
  function request(payload, fallback) {
    if (closed) return Promise.resolve(fallback);
    if (!child) start();
    return new Promise(resolve => {
      const id = nextId++;
      // A pending probe keeps the process alive until its reply or deadline; the idle helper doesn't.
      const timer = setTimeout(() => { if (pending.delete(id)) { resolve(fallback); stop(); } }, timeoutMs);
      pending.set(id, reply => { clearTimeout(timer); resolve(reply ?? fallback); });
      child.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });
  }
  return {
    probe: app => request({ app }, { status: 'unknown' }),
    target: args => request({ op: 'lease-target', app: args.app }, { ok: false, error: 'session helper unavailable; read the app again' }),
    keyboardTaps: async () => { const r = await request({ op: 'keyboard-taps' }, { ok: false }); return r.ok ? r.taps : []; },
    close() { closed = true; stop(); return Promise.all([...stopping]); },
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
