// Startup and per-call costs of the candidates in ROADMAP track 3 step 3,
// with no model: engine launch to the first tools/list answer (with and
// without SLEIGHT_SURFACES=computer), the launch-time extension discovery,
// osascript spawns and SQLite opens per local tool call, the keyboard-tap
// scan at turn end, and the pane snapshot's in-engine decode.
//
//   node bench/startup-costs.mjs [--only launch,probe,osascript,lease,taps,snapshot] [--reps 10]
//        [--out docs/benchmarks/2026-10-10-startup-costs.json]
//
// Engine sections hold /tmp/sleight-live.lock and only start the engine or
// read the screen; no app is driven and no pointer or keyboard is touched.
import { execFile, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { acquireLiveLock } from './live-lock.mjs';
import { baseClient } from './other-hosts-client.mjs';
import { InputLease } from '../plugins/sleight/lib/input-lease.mjs';
import { createAppHealthHelper } from '../plugins/sleight/lib/read-failure.mjs';
import { createClipboardCoordinator } from '../plugins/sleight/lib/clipboard.mjs';
import { resolveServer, probeSurfaces } from '../plugins/sleight/lib/launch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const LAUNCHER = join(root, 'plugins/sleight/bin/sleight-mcp');
const execute = promisify(execFile);
const reps = Number(process.argv[process.argv.indexOf('--reps') + 1] ?? 10) || 10;
const onlyArg = process.argv.indexOf('--only') >= 0 ? process.argv[process.argv.indexOf('--only') + 1] : undefined;
const only = onlyArg?.split(',') ?? ['launch', 'probe', 'osascript', 'lease', 'taps', 'snapshot'];
const outPath = process.argv.indexOf('--out') >= 0 ? process.argv[process.argv.indexOf('--out') + 1]
  : join(root, 'docs/benchmarks/2026-10-10-startup-costs.json');
const want = section => only.includes(section);

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};
const summary = values => values.length
  ? { median: Math.round(median(values) * 10) / 10, min: Math.round(Math.min(...values) * 10) / 10,
      max: Math.round(Math.max(...values) * 10) / 10, n: values.length }
  : { n: 0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Distinct descendant pids of this process, sampled while a measured window
// runs. Short-lived children are caught only if a sample lands on them, so
// counts are a lower bound for those.
function pollDescendants(intervalMs = 50) {
  const seen = new Set();
  const sample = () => {
    let rows;
    try { rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 }); }
    catch { return; }
    const parent = new Map(rows.split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(f => f.length === 2 && f[0]));
    let frontier = [process.pid];
    while (frontier.length) {
      const pid = frontier.pop();
      for (const [child, ppid] of parent) if (ppid === pid && !seen.has(child)) { seen.add(child); frontier.push(child); }
    }
  };
  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref?.();
  return { stop: () => { clearInterval(timer); sample(); return [...seen].sort((a, b) => a - b); } };
}

// The discovery engine can outlive its launcher briefly; wait so one rep's
// children never contend with the next.
async function waitForEnginesToExit(maxMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    let rows = '';
    try { rows = execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8', timeout: 5000 }); } catch {}
    if (!rows.includes('unified-computer-use')) return Date.now() - started;
    await sleep(250);
  }
  return -1;
}

const cacheFile = () => join(homedir(), 'Library/Caches/sleight/extensions.json');
const cacheCheckedAt = () => { try { return JSON.parse(readFileSync(cacheFile(), 'utf8')).checkedAt; } catch { return undefined; } };

async function launchOnce(extraEnv) {
  delete process.env.SLEIGHT_SURFACES;
  const checkedBefore = extraEnv.SLEIGHT_SURFACES ? undefined : cacheCheckedAt();
  const poll = pollDescendants();
  const t0 = performance.now();
  const client = await baseClient({ command: LAUNCHER, env: { ...extraEnv } }, { timeoutMs: 30000 });
  const toolsListMs = Math.round((performance.now() - t0) * 10) / 10;
  const tools = await client.request('tools/list', {});
  // The first js call is the first call that runs engine code and needs the
  // computer-use helper; the launch-time discovery engine can still be
  // running while it answers. A standalone getState is what the input lease
  // asks a first call to be.
  const first = await client.call('js', { code: 'await cua.getState()', title: 'sleight startup-costs first call' });
  const firstJsMs = performance.now() - t0;
  const firstJsError = first.isError
    ? (first.content ?? []).map(block => block.text ?? '').join('\n').slice(0, 200) : undefined;
  // A real session stays open while the model answers. The dwell sits inside
  // the child-count window, so a deferred inventory refresh counts too, and
  // has time to publish before the close.
  await sleep(2500);
  const children = poll.stop();
  await client.close();
  const enginesWaitMs = await waitForEnginesToExit();
  // Automatic surfaces refresh the extension cache every session; verify the
  // refresh still lands once it no longer runs during the first call.
  const cacheRefreshed = checkedBefore === undefined ? undefined : (() => {
    const after = cacheCheckedAt();
    return typeof after === 'number' && typeof checkedBefore === 'number' ? after > checkedBefore : undefined;
  })();
  return { toolsListMs, ms: firstJsMs, children: children.length, enginesWaitMs, cacheRefreshed, firstJsError, tools: tools.tools.length };
}

// --- launch: the real launcher over stdio, spawn to the first tools/list
// answer and then to the first js answer. The browser-computer condition
// SLEIGHT_SURFACES=browser,computer separates what the engine itself does
// with browser surfaces enabled from what the discovery engine adds.
// Conditions interleave rep by rep, so a load burst lands on all of them.
async function sectionLaunch() {
  const conditions = { computer: { SLEIGHT_SURFACES: 'computer' },
    'browser-computer': { SLEIGHT_SURFACES: 'browser,computer' }, auto: {} };
  const names = Object.keys(conditions);
  const runs = Object.fromEntries(names.map(name => [name, []]));
  for (let i = 0; i < reps; i++) {
    for (const name of names) {
      let run;
      try { run = await launchOnce(conditions[name]); }
      catch (error) { run = { ms: NaN, children: 0, error: String(error.message || error).slice(0, 200) }; }
      if (!Number.isFinite(run.ms)) delete run.ms;
      delete run.tools;
      runs[name].push(run);
      process.stderr.write(`launch ${name} ${i + 1}/${reps}: tools/list ${run.toolsListMs ?? '?'} ms, first js ${Number.isFinite(run.ms) ? Math.round(run.ms) : run.error ?? 'failed'} ms, ${run.children} children\n`);
    }
  }
  const out = {};
  for (const name of names) {
    const list = runs[name];
    const ok = list.filter(r => Number.isFinite(r.ms));
    out[name] = { toolsListMs: summary(list.map(r => r.toolsListMs).filter(Number.isFinite)), wallMs: summary(ok.map(r => r.ms)),
      children: summary(list.map(r => r.children)), failed: list.length - ok.length, runs: list };
  }
  return out;
}

// --- probe: probeSurfaces directly (the doctor and discovery path): one real
// engine start, an inventory call, and its collection.
async function sectionProbe() {
  const runs = [];
  for (let i = 0; i < reps; i++) {
    const s = resolveServer(process.env);
    if (s.error) throw new Error(s.error);
    const poll = pollDescendants();
    const t0 = performance.now();
    await probeSurfaces(s, process.env);
    const ms = performance.now() - t0;
    const children = poll.stop();
    runs.push({ ms, children: children.length });
    process.stderr.write(`probeSurfaces ${i + 1}/${reps}: ${Math.round(ms)} ms, ${children.length} children\n`);
    await sleep(200);
  }
  return { wallMs: summary(runs.map(r => r.ms)), children: summary(runs.map(r => r.children)), runs };
}

// --- osascript: the unit spawn cost, a real cold and warm app-health probe
// (read-only Accessibility of Calculator), and per-call spawn counts from the
// stubbed counting child.
async function countScenario(name) {
  const hooks = fileURLToPath(new URL('./startup-costs-hooks.mjs', import.meta.url));
  const script = fileURLToPath(new URL('./startup-costs-count.mjs', import.meta.url));
  const result = await execute(process.execPath, ['--import', hooks, script, name, String(reps)],
    { timeout: 120000, env: { ...process.env, SLEIGHT_STUB_OSASCRIPT: '1' } });
  return JSON.parse(result.stdout.trim().split('\n').at(-1)).reps;
}

async function sectionOsascript() {
  const unit = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', '0']);
    unit.push(performance.now() - t0);
  }
  const helper = createAppHealthHelper();
  const probeCold = performance.now();
  await helper.probe('Calculator');
  const coldMs = performance.now() - probeCold;
  const warm = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    await helper.probe('Calculator');
    warm.push(performance.now() - t0);
  }
  await helper.close();
  const scenarios = {};
  for (const name of ['helper-target-cold', 'menu-bar-apps', 'notifications-list', 'drag-background', 'blocked-app-click', 'open-file']) {
    scenarios[name] = await countScenario(name);
    process.stderr.write(`counts ${name}: ${JSON.stringify(scenarios[name][0])}\n`);
  }
  return { osascriptSpawnMs: summary(unit), appHealthProbeColdMs: Math.round(coldMs * 10) / 10,
    appHealthProbeMs: summary(warm), spawnsPerCall: scenarios, unitRuns: unit };
}

// --- lease: real InputLease operation times in a private directory, and the
// clipboard coordinator's open + acquire + release cycle with a counting
// DatabaseSync (its constructor is injectable).
async function sectionLease() {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-startup-costs-lease-'));
  const window = { appId: 'com.apple.calculator', app: 'Calculator', title: 'Calculator' };
  const lease = new InputLease({ directory: dir, holder: 'bench' });
  const cold = performance.now();
  lease.acquire({ ...window, title: 'seed' });
  const coldMs = performance.now() - cold;
  const acquire = [], renew = [], release = [];
  for (let i = 0; i < reps; i++) {
    let t0 = performance.now();
    const key = lease.acquire({ ...window, title: `run ${i}` });
    acquire.push(performance.now() - t0);
    t0 = performance.now();
    lease.renew([key]);
    renew.push(performance.now() - t0);
    t0 = performance.now();
    lease.release([key]);
    release.push(performance.now() - t0);
  }
  rmSync(dir, { recursive: true, force: true });

  const clipboardDir = mkdtempSync(join(tmpdir(), 'sleight-startup-costs-clipboard-'));
  let opens = 0;
  class CountingDatabaseSync extends DatabaseSync {
    constructor(...args) { super(...args); opens++; }
  }
  const coordinator = createClipboardCoordinator(CountingDatabaseSync, join(clipboardDir, 'clipboard.sqlite'));
  const clipboardAcquire = [], clipboardRelease = [];
  for (let i = 0; i < reps; i++) {
    let t0 = performance.now();
    coordinator.acquire();
    clipboardAcquire.push(performance.now() - t0);
    t0 = performance.now();
    coordinator.release();
    clipboardRelease.push(performance.now() - t0);
  }
  const clipboardOpens = opens;
  rmSync(clipboardDir, { recursive: true, force: true });
  return { leaseColdAcquireMs: Math.round(coldMs * 10) / 10, leaseAcquireMs: summary(acquire),
    leaseRenewMs: summary(renew), leaseReleaseMs: summary(release),
    clipboardAcquireMs: summary(clipboardAcquire), clipboardReleaseMs: summary(clipboardRelease),
    clipboardOpensPerAcquire: clipboardOpens / reps, clipboardOpens,
    runs: { acquire, renew, release, clipboardAcquire, clipboardRelease } };
}

// --- taps: the keyboard-tap scan the relay runs at turn end, cold (includes
// the helper spawn) and warm, through the real helper.
async function sectionTaps() {
  const helper = createAppHealthHelper();
  const cold = performance.now();
  await helper.keyboardTaps();
  const coldMs = performance.now() - cold;
  const warm = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    await helper.keyboardTaps();
    warm.push(performance.now() - t0);
  }
  await helper.close();
  return { coldMs: Math.round(coldMs * 10) / 10, warmMs: summary(warm) };
}

// --- snapshot: the pane's decode of a real engine screenshot of Calculator
// (read-only; preapproved), timed inside the engine, plus the production
// snapshot code end to end through the relay.
function snapshotCodeFromFile(app, cols, rows, terminal) {
  const source = readFileSync(join(root, 'plugins/sleight/hooks/snapshot.ts'), 'utf8');
  const template = /const SNAPSHOT_JS = `([\s\S]*?)`\n/.exec(source)?.[1];
  if (!template) throw new Error('could not read SNAPSHOT_JS from hooks/snapshot.ts');
  return template
    .replace('__APP__', JSON.stringify(app))
    .replace('__TERMINAL__', String(terminal))
    .replace('__COLS__', String(cols))
    .replace('__ROWS__', String(rows));
}

async function sectionSnapshot() {
  delete process.env.SLEIGHT_SURFACES;
  const client = await baseClient({ command: LAUNCHER, env: { SLEIGHT_SURFACES: 'computer' } }, { timeoutMs: 60000 });
  try {
    const benchCode = `
const app = await cua.getApp('Calculator');
const captureStart = performance.now();
const shot = Buffer.from(await app.getScreenshot({ emit: false }));
const captureMs = performance.now() - captureStart;
const jpeg = await import('jpeg-js');
const decode = [];
let decoded;
for (let i = 0; i < 10; i++) {
  const t = performance.now();
  decoded = jpeg.decode(shot, { useTArray: true });
  decode.push(performance.now() - t);
}
const { width, height, data } = decoded;
const COLS = 46, ROWS = 11;
const scale = Math.max(width / COLS, height / (ROWS * 2));
const outW = Math.max(1, Math.min(COLS, Math.round(width / scale)));
const outH = Math.max(2, Math.min(ROWS * 2, Math.round(height / scale)));
const px = (x, y) => {
  const x0 = Math.floor(x * width / outW), x1 = Math.max(x0 + 1, Math.floor((x + 1) * width / outW));
  const y0 = Math.floor(y * height / outH), y1 = Math.max(y0 + 1, Math.floor((y + 1) * height / outH));
  let r = 0, g = 0, b = 0, n = 0;
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
    const i = (yy * width + xx) * 4;
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
  }
  return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n);
};
const downsample = [];
for (let i = 0; i < 10; i++) {
  const t = performance.now();
  let cells = 0;
  for (let r = 0; r < outH; r++) for (let c = 0; c < outW; c++) { px(c, r); cells++; }
  downsample.push(performance.now() - t);
}
nodeRepl.write('SLEIGHT_BENCH ' + JSON.stringify({ bytes: shot.length, width, height, captureMs, decode, downsample }));
`;
    const bench = await client.call('js', { code: benchCode, title: 'sleight startup-costs bench' });
    const benchText = bench.content.map(block => block.text ?? '').join('\n');
    const marker = /SLEIGHT_BENCH (\{.*\})/.exec(benchText);
    if (bench.isError || !marker) throw new Error(`engine bench call failed: ${benchText.slice(0, 300)}`);
    const inEngine = JSON.parse(marker[1]);
    const code = snapshotCodeFromFile('Calculator', 46, 11, true);
    const calls = [];
    let frames = 0;
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now();
      const result = await client.call('js', { code, title: 'sleight pane snapshot' });
      const ms = performance.now() - t0;
      const line = result.content.map(block => block.text ?? '').join('\n').split('\n').find(l => l.startsWith('SLEIGHT_FRAME '));
      if (line) frames++;
      calls.push(ms);
      process.stderr.write(`snapshot call ${i + 1}/${reps}: ${Math.round(ms)} ms${line ? '' : ' (no frame)'}\n`);
    }
    return { ...inEngine, snapshotCallMs: summary(calls), snapshotCalls: calls, framesDrawn: frames };
  } finally { await client.close(); }
}

// --- run
const report = { meta: {} };
// Rerunning a section (bench/startup-costs.mjs --only launch) keeps the other
// sections already in the file; a fresh path starts fresh.
try {
  const previous = JSON.parse(readFileSync(outPath, 'utf8'));
  for (const [key, value] of Object.entries(previous)) {
    if ((key === 'meta' || !want(key)) && key !== 'fixed') report[key] = value;
  }
} catch { /* Fresh output. */ }
const helperRunning = (() => {
  try { return execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8', timeout: 5000 }).includes('SkyComputerUseService'); }
  catch { return null; }
})();
const scrub = text => text.replaceAll(homedir(), '~').replaceAll(userInfo().username, '~');
function writeReport() {
  if (outPath === '-') process.stdout.write(scrub(JSON.stringify(report, null, 1) + '\n'));
  else writeFileSync(outPath, scrub(JSON.stringify(report, null, 1) + '\n'));
}
delete process.env.SLEIGHT_SURFACES;
const server = resolveServer(process.env);
if (server.error) throw new Error(server.error);
let cache = {};
try { cache = JSON.parse(readFileSync(join(homedir(), 'Library/Caches/sleight/extensions.json'), 'utf8')); } catch {}
report.meta = {
  date: new Date().toISOString(),
  node: process.version,
  reps,
  hold: (() => { try { statSync('/tmp/sleight-hold'); return true; } catch { return false; } })(),
  engineVersion: server.version,
  helperRunning,
  surfaceCache: { present: Object.keys(cache).length > 0, connected: cache.connected ?? null,
    ageHours: Number.isFinite(cache.checkedAt) ? Math.round((Date.now() - cache.checkedAt) / 360000) / 10 : null },
};
process.stderr.write(`${JSON.stringify(report.meta)}\n`);

if (want('launch') || want('probe') || want('snapshot')) {
  const releaseLock = await acquireLiveLock();
  // A crash must not leave the lock: on exit, remove it only if it is still
  // the one this process took.
  const ownedLockIno = statSync('/tmp/sleight-live.lock').ino;
  process.once('exit', () => { try { if (statSync('/tmp/sleight-live.lock').ino === ownedLockIno) rmSync('/tmp/sleight-live.lock', { recursive: true }); } catch {} });
  try {
    if (want('launch')) { report.launch = await sectionLaunch(); writeReport(); }
    if (want('probe')) { report.probeSurfaces = await sectionProbe(); writeReport(); }
    if (want('snapshot')) { report.snapshot = await sectionSnapshot(); writeReport(); }
  } finally { await releaseLock(); }
}
if (want('osascript')) { report.osascript = await sectionOsascript(); writeReport(); }
if (want('lease')) { report.lease = await sectionLease(); writeReport(); }
if (want('taps')) { report.taps = await sectionTaps(); writeReport(); }

process.stderr.write('\n=== medians ===\n');
for (const [section, data] of Object.entries(report)) {
  if (section === 'meta') continue;
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'median' in value) process.stderr.write(`${section}.${key}: ${value.median}\n`);
  }
}
writeReport();
if (outPath !== '-') process.stderr.write(`raw written to ${outPath.replaceAll(homedir(), '~')}\n`);
