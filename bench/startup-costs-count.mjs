// Counts child processes and SQLite opens on sleight's per-call paths, with
// osascript stubbed (SLEIGHT_STUB_OSASCRIPT=1, through the intercept hooks) so
// nothing real runs. One scenario per invocation; prints one JSON line.
//   node --import ./startup-costs-hooks.mjs startup-costs-count.mjs <scenario> [reps]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { createAppHealthHelper } from '../plugins/sleight/lib/read-failure.mjs';
import { callLocalTool } from '../plugins/sleight/lib/launch.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const scenario = process.argv[2];
const reps = Number(process.argv[3] ?? 10);
const lib = fileURLToPath(new URL('../plugins/sleight/lib/', import.meta.url));
const approve = async () => true;
const runLocal = (script, request, options) => runScriptStub(script, request, options);

// A stand-in for launch.mjs runScript bound to the counting child_process.
function runScriptStub(script, request, options = {}) {
  const { run = execFile } = typeof options === 'function' ? { run: options } : options;
  return new Promise(resolve => {
    run('osascript', ['-l', 'JavaScript', join(lib, script), JSON.stringify(request)], { timeout: 5000 },
      (err, stdout) => { try { resolve(JSON.parse(stdout)); } catch { resolve({ ok: false, error: 'stub' }); } });
  });
}

const reset = () => { globalThis.__childSpawns = 0; globalThis.__sqliteOpens = 0; };
const take = () => ({ spawns: globalThis.__childSpawns ?? 0, opens: globalThis.__sqliteOpens ?? 0 });

async function count(repeat) {
  const out = [];
  for (let i = 0; i < reps; i++) {
    reset();
    await repeat(i);
    out.push(take());
  }
  return out;
}

const health = createAppHealthHelper();
const lease = (directory) => new InputLease({ directory, holder: 'bench' });
const calculator = { appId: 'com.apple.calculator', app: 'Calculator', title: 'Calculator' };
const window = { ...calculator, title: 'Calculator' };

const scenarios = {
  // The first local tool call of a session resolves its target on a cold
  // target lane: rep[0] includes the helper spawn, later reps are warm.
  'helper-target-cold': () => count(async () => { await health.target({ app: 'Calculator' }); }),

  'menu-bar-apps': () => count(async () => {
    await health.target({ app: 'Calculator' });
    await callLocalTool('menu_bar', { op: 'apps' }, approve, runLocal);
  }),
  'notifications-list': () => count(async () => {
    await health.target({ app: 'Calculator' });
    await callLocalTool('notifications', { op: 'list' }, approve, runLocal);
  }),
  'drag-background': () => count(async () => {
    await health.target({ app: 'Calculator' });
    await callLocalTool('drag', { app: 'Calculator', from: [0, 0], to: [10, 10] }, approve, runLocal);
  }),
  'blocked-app-click': () => count(async () => {
    const target = (await health.target({ app: 'iTerm2' })).target;
    await callLocalTool('blocked_app', { app: 'iTerm2', op: 'click', element: 1 }, approve, runLocal, target);
  }),
  'open-file': () => count(async () => {
    await health.target({ app: 'Calculator' });
    await callLocalTool('open_file', { app: 'Calculator', path: join(lib, '..', 'assets', 'icon.png') }, approve, runLocal);
  }),

  // Lease operations against a private temp directory: opens per operation.
  'lease-cold-acquire': () => count(async i => {
    const dir = trackTemp(mkdtempSync(join(tmpdir(), `sleight-lease-${i}-`)));
    try { lease(dir).acquire(window); } finally { rmSync(dir, { recursive: true, force: true }); }
  }),
  'lease-warm-acquire': () => count(async () => {
    const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-lease-warm-')));
    const l = lease(dir);
    try {
      l.acquire({ ...window, title: 'seed' });
      reset();
      l.acquire({ ...window, title: 'other' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),
  'lease-renew': () => count(async () => {
    const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-lease-renew-')));
    const l = lease(dir);
    try {
      const key = l.acquire(window);
      reset();
      l.renew([key]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),
  'lease-release': () => count(async () => {
    const dir = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-lease-release-')));
    try {
      const l = lease(dir);
      const key = l.acquire(window);
      reset();
      l.release([key]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }),
};

if (!scenarios[scenario]) {
  process.stderr.write(`scenarios: ${Object.keys(scenarios).join(', ')}\n`);
  process.exit(2);
}

const samples = await scenarios[scenario]();
if (scenario.startsWith('helper-target')) await health.close();
process.stdout.write(JSON.stringify({ scenario, reps: samples }) + '\n');
