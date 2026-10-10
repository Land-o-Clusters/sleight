// Real helper proof and background discovery CPU. No model calls or input actions.
// The parent owns timed workers; workers own their helpers, engine, and mkdir lock.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLiveLock } from './live-lock.mjs';
import { createAppHealthHelper, spawnAppHealthHelper } from '../plugins/sleight/lib/read-failure.mjs';
import { discoverExtensions } from '../plugins/sleight/lib/browser-discovery.mjs';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';

const scrub = value => String(value).replace(/\/Users\/[^/\s"']+/g, '~');
const available = () => { if (existsSync('/tmp/sleight-hold')) throw new Error('/tmp/sleight-hold exists; probe refused'); };

async function worker(mode, output, cancelFile) {
  const report = { mode, started: new Date().toISOString(), load: loadavg(), calls: [], failures: [] };
  const controller = new AbortController(), collected = [], children = [], replies = [];
  let unlock, helper, discoveryStarted = false, interrupted = false, cleanup = true;
  const cancel = () => { interrupted = true; controller.abort(); void helper?.close(); };
  const cancellation = setInterval(() => { if ((existsSync(cancelFile) || existsSync('/tmp/sleight-hold')) && !interrupted) cancel(); }, 100);
  cancellation.unref(); process.once('SIGINT', cancel);
  const ready = () => { available(); assert.equal(interrupted, false, 'interrupted'); };
  const timed = async (name, run) => {
    ready(); const start = performance.now();
    try { return await run(); }
    finally { report.calls.push({ name, ms: performance.now() - start, load: loadavg() }); }
  };
  try {
    ready(); unlock = await acquireLiveLock(); ready();
    if (mode === 'proof') {
      helper = createAppHealthHelper({ spawnHelper: kind => {
        ready();
        const child = spawnAppHealthHelper(kind);
        children.push(child); collected.push(new Promise(resolve => child.once('close', resolve)));
        let buffer = '';
        child.stdout.on('data', data => {
          buffer += data; let end;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            try { const reply = JSON.parse(line); replies.push({ lane: kind, id: reply.id, ok: reply.ok, error: reply.error }); }
            catch { /* The helper client refuses malformed replies. */ }
          }
        });
        return child;
      } });
      const target = await timed('real Calculator lease-target', () => helper.target({ app: 'Calculator' }));
      report.target = { ok: target.ok, appId: target.target?.appId, error: target.error };
      // Still record the tap proof if Calculator is absent or resolution fails.
      const taps = await timed('real keyboard-taps', () => helper.keyboardTaps());
      report.taps = { ok: replies.findLast(reply => reply.lane === 'taps')?.ok === true, count: taps.length };
      assert.equal(target.ok, true, target.error);
      assert.equal(target.target.appId, 'com.apple.calculator');
      assert.equal(report.taps.ok, true, 'tap helper did not return a successful native result');
    } else {
      assert.ok(['discovery', 'discovery-long'].includes(mode), 'unknown probe mode');
      const server = resolveServer(process.env); assert.ok(!server.error, server.error);
      report.engineVersion = server.version;
      report.timeoutMs = mode === 'discovery-long' ? 30000 : 4000;
      discoveryStarted = true;
      const inventory = await timed('background extension discovery', () => discoverExtensions(server,
        { timeoutMs: report.timeoutMs, signal: controller.signal, strict: true }));
      report.connected = inventory.length > 0; report.extensionCount = inventory.length;
      report.engineCollected = true;
    }
  } catch (error) { report.failures.push(scrub(error.message)); }
  finally {
    try {
      await helper?.close();
      for (const child of children) { child.ref(); child.stdin?.ref?.(); child.stdout?.ref?.(); child.stderr?.ref?.(); }
      await Promise.all(collected);
      if (helper) { report.helpersCollected = true; report.helperSpawns = children.length; report.replies = replies; }
      // discoverExtensions settles only after its child has been collected, including failures.
      if (discoveryStarted) report.engineCollected = true;
    } catch (error) { cleanup = false; report.failures.push(scrub(error.message)); }
    clearInterval(cancellation); process.removeListener('SIGINT', cancel);
    if (unlock && cleanup) { await unlock(); report.lockReleased = true; }
    else if (unlock) report.lockRetained = true;
    if (interrupted) report.failures.push('interrupted');
    const own = process.cpuUsage(); report.workerCpuSeconds = (own.user + own.system) / 1e6;
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  }
  return report.failures.length ? 1 : 0;
}

async function measure(mode, output) {
  available();
  const report = { mode, started: new Date().toISOString(), runs: [] };
  const bank = mkdtempSync('/private/tmp/sleight-footprint-followup-'), cancelFile = join(bank, 'cancel');
  let interrupted = false;
  const cancel = () => { interrupted = true; writeFileSync(cancelFile, 'cancel\n'); };
  process.once('SIGINT', cancel);
  try {
    for (let repetition = 1; repetition <= (mode === 'proof' ? 1 : 3); repetition++) {
      available(); if (interrupted) break;
      const target = join(bank, `run-${repetition}.json`);
      const child = spawn('/usr/bin/time', ['-p', process.execPath, fileURLToPath(import.meta.url), 'worker', mode, target, cancelFile],
        { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.resume(); let stderr = ''; child.stderr.on('data', data => { stderr += data; });
      const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
      const result = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : { failures: ['worker produced no report'] };
      const time = /real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys\s+([\d.]+)/.exec(stderr);
      const cpuSeconds = time ? Number(time[2]) + Number(time[3]) : null;
      const run = { repetition, ...exit, cpuSeconds, realSeconds: time ? Number(time[1]) : null,
        childCpuSecondsEstimate: cpuSeconds === null ? null : Math.max(0, cpuSeconds - result.workerCpuSeconds), stderr: scrub(stderr), ...result };
      report.runs.push(run); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ repetition, cpuSeconds, childCpuSecondsEstimate: run.childCpuSecondsEstimate, calls: run.calls, target: run.target, taps: run.taps, failures: run.failures }));
      if (!result.lockReleased || interrupted) break;
    }
    return interrupted || report.runs.some(run => run.code !== 0 || run.signal) ? 1 : 0;
  } finally { process.removeListener('SIGINT', cancel); rmSync(bank, { recursive: true, force: true }); }
}

try {
  process.exitCode = process.argv[2] === 'worker' ? await worker(process.argv[3], process.argv[4], process.argv[5])
    : await measure(process.argv[2], process.argv[3]);
} catch (error) { console.error(scrub(error.message)); process.exitCode = 1; }
