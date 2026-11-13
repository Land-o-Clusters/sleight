// Synthetic stdin/stdout peer. No Windows APIs, windows, input or native helpers.
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { fakeWindows } from './windows-driver-fake.mjs';

export function slowDriverHost(t, scenario = 'normal') {
  const children = [], frames = [], events = [];
  let onFrame;
  const waiters = [];
  t.after(async () => {
    for (const child of children) {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null)
        await new Promise(resolve => child.once('close', resolve));
    }
  });
  return { children, frames, events, set onFrame(value) { onFrame = value; },
    waitFor(method) {
      const found = frames.find(row => row.method === method);
      return found ? Promise.resolve(found) : new Promise(resolve => waiters.push({ method, resolve }));
    },
    waitForEvent(event) {
      const found = events.find(row => row.event === event);
      return found ? Promise.resolve(found) : new Promise(resolve => waiters.push({ event, resolve }));
    },
    prepare: async () => ({ status: 'ready', spawn({ nonce }) {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), scenario], {
        stdio: ['pipe', 'pipe', 'pipe'], env: { SLEIGHT_DRIVER_NONCE: nonce },
      });
      children.push(child);
      createInterface({ input: child.stderr }).on('line', line => {
        const row = JSON.parse(line);
        if (row.event) events.push(row);
        else { frames.push(row); onFrame?.(row); }
        for (let i = waiters.length - 1; i >= 0; i--) if (row.event ? waiters[i].event === row.event : waiters[i].method === row.method) {
          waiters[i].resolve(row); waiters.splice(i, 1);
        }
      });
      return child;
    } }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const nonce = process.env.SLEIGHT_DRIVER_NONCE, scenario = process.argv[2];
  const jobs = new Map(), timers = new Set();
  let typed = 0, cleanup = 0, escaped = false, readId = 0;
  const observation = () => ({ window: fakeWindows[0], readId: ++readId,
    text: 'Window: "Untitled - Notepad", App: Notepad.\n0 standard window Untitled - Notepad\n\t1 text entry area Text editor (focused)' });
  const later = (fn, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer);
  };
  const reply = (request, body) => process.stdout.write(JSON.stringify({ protocol: request.protocol, nonce,
    id: request.id, ...body }) + '\n');
  const stop = (job, reason) => {
    jobs.delete(job.request.id); cleanup++;
    process.stderr.write(JSON.stringify({ event: 'cleanup', id: job.request.id, typed: job.typed }) + '\n');
    reply(job.request, { ok: false, error: { code: 'USER_STOPPED', message: 'fixture diagnostic', unhealthy: false,
      delivery: job.typed ? 'sent-unverified' : 'not-sent', retry: job.typed ? 'read-first' : 'safe',
      reason, typed: job.typed, personTookOver: false, limits: ['secure-desktop-seen'] } });
  };
  const pump = job => {
    if (!jobs.has(job.request.id)) return;
    if (job.cancelled) {
      if (scenario === 'stalled-cleanup') return;
      if (scenario === 'slow-cleanup') return later(() => stop(job, 'cancel'), 80);
      return stop(job, 'cancel');
    }
    if (scenario === 'escape' && !escaped && job.typed === 3) { escaped = true; return stop(job, 'escape'); }
    if (job.typed === job.total) {
      jobs.delete(job.request.id); cleanup++;
      return reply(job.request, { ok: true, result: { ...observation(), typed: job.typed, cleanup } });
    }
    job.typed++; typed++;
    if (job.typed === 1) process.stderr.write(JSON.stringify({ event: 'progress', id: job.request.id }) + '\n');
    later(() => pump(job), 10);
  };
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => {
    const request = JSON.parse(line);
    process.stderr.write(JSON.stringify(request) + '\n');
    if (request.method === 'turn-start' || request.method === 'turn-end') {
      reply(request, { ok: true, result: { turn: request.params.turn, active: request.method === 'turn-start' } });
    } else if (request.method === 'cancel') {
      const job = jobs.get(request.params.id);
      if (job) job.cancelled = true;
      if (scenario !== 'silent-cancel') later(() => reply(request, { ok: true,
        result: { cancelled: request.params.id, inFlight: !!job } }), scenario === 'late-cancel' ? 450 : 0);
    } else if (request.method === 'ping') reply(request, { ok: true, result: { typed, cleanup, pending: jobs.size } });
    else if (request.method === 'getState') reply(request, { ok: true, result: { windows: [fakeWindows[0]] } });
    else if (request.method === 'verifyWindowIdentity' || request.method === 'getAXState' && !request.params.args)
      reply(request, { ok: true, result: observation() });
    else if (request.method === 'refuse') reply(request, { ok: false, error: request.params });
    else {
      const job = { request, typed: 0, total: request.params.args?.[0]?.length ?? 100 };
      jobs.set(request.id, job); later(() => pump(job), 10);
    }
  });
  lines.on('close', () => { for (const timer of timers) clearTimeout(timer); jobs.clear(); });
}
