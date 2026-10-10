// No-model, background Calculator reads only. Each worker owns and collects its children.
// Refuse the shared hold or a busy mkdir lock before starting any helper or engine.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { acquireLiveLock } from './live-lock.mjs';
import { probeClient } from './double-keys-client.mjs';

const scrub = value => String(value).replace(/\/Users\/[^/\s"']+/g, '~');
const available = () => { if (existsSync('/tmp/sleight-hold')) throw new Error('/tmp/sleight-hold exists; live probe refused'); };
const currentRoot = fileURLToPath(new URL('../', import.meta.url));

async function worker(root, output, cancelFile) {
  const report = { root: scrub(root), started: new Date().toISOString(), load: loadavg(), calls: [], failures: [] };
  let unlock, helper, client, bank, cleanup = true;
  const children = [], handles = [];
  const helperReplies = [];
  let interrupted = false;
  const cancel = () => { interrupted = true; void client?.close(); void helper?.close(); };
  process.once('SIGINT', cancel);
  const cancellation = setInterval(() => { if (cancelFile && existsSync(cancelFile) && !interrupted) cancel(); }, 100);
  cancellation.unref();
  function ready() { available(); if (interrupted) throw new Error('interrupted'); }
  try {
    ready(); unlock = await acquireLiveLock(); ready();
    bank = mkdtempSync('/private/tmp/sleight-footprint-live-');
    const { createAppHealthHelper } = await import(pathToFileURL(join(root, 'plugins/sleight/lib/read-failure.mjs')));
    const { runScript, stopHelpers } = await import(pathToFileURL(join(root, 'plugins/sleight/lib/launch.mjs')));
    let shared;
    helper = createAppHealthHelper({ spawnHelper: kind => {
      ready();
      const lib = join(root, 'plugins/sleight/lib');
      const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', join(lib, 'app-health.js'),
        ...(shared && kind !== 'probe' ? ['--session', lib] : [])], { stdio: ['pipe', 'pipe', 'pipe'] });
      const operations = new Map();
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (line, ...args) => {
        const request = JSON.parse(line); operations.set(request.id, request.op ?? 'health');
        return write(line, ...args);
      };
      let stderr = '';
      let buffer = '';
      child.stdout.on('data', data => {
        buffer += data;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const reply = JSON.parse(line);
            helperReplies.push({ lane: kind ?? 'original', op: operations.get(reply.id), ok: reply.ok, status: reply.status, error: reply.error });
          } catch { /* The helper's own client handles malformed protocol. */ }
        }
      });
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
      child.once('close', () => { if (stderr.trim()) (report.helperErrors ??= []).push(scrub(stderr.trim())); });
      handles.push(child);
      children.push(new Promise(resolve => child.once('close', resolve)));
      return child;
    } });
    shared = typeof helper.keyboardTaps === 'function';
    const timed = async (name, run) => {
      ready(); const start = performance.now(); const result = await run();
      report.calls.push({ name, ms: performance.now() - start, load: loadavg() });
      return result;
    };
    const before = await timed('helper cold health', () => helper.probe('Calculator'));
    assert.ok(['responding', 'absent'].includes(before.status), `native health unavailable (${before.status})`);
    report.appStatus = before.status;
    ready();
    const started = performance.now();
    client = await probeClient({ command: process.execPath, args: [join(root, 'tests/fixtures/lease-launcher.mjs'), join(bank, 'leases')],
      env: { SLEIGHT_SURFACES: 'computer', SLEIGHT_APPROVAL_PROMPT: 'client', SLEIGHT_TRACE: join(bank, 'trace') } },
    { relay: false, label: 'footprint', record: () => {} });
    report.initializeMs = performance.now() - started;
    async function call(name, code) {
      const result = await timed(name, () => client.call('js', { code, timeout_ms: 60000 }));
      assert.ok(!result.isError, scrub(JSON.stringify(result.content).slice(0, 500)));
      return result;
    }
    if (before.status === 'responding') {
      await call('acquisition', 'var app = await cua.getApp("com.apple.calculator")');
      await call('read', 'await app.getAXState({ disableDiffing: true })');
      // Read only an existing app; no launch, activation, input or pointer work.
      const taps = await timed('turn end', () => client.call('turn_ended', { hook_event_name: 'Stop' }));
      assert.ok(!taps.isError);
    } else {
      report.acquisitionSkipped = 'Calculator was absent; startup and helper queries only';
      const result = await call('runtime readiness', 'nodeRepl.write("footprint-ready")');
      assert.ok(result.content?.some(block => block.type === 'text' && block.text.includes('footprint-ready')), 'engine did not execute the readiness marker');
    }
    report.queries = [];
    let oneShotSpawns = 0;
    const local = (script, args) => runScript(script, args, (command, argv, options, callback) => {
      ready(); oneShotSpawns++; return execFile(command, argv, options, callback);
    });
    for (let i = 0; i < 5; i++) {
      const health = await timed('helper warm health', () => helper.probe('Calculator'));
      assert.equal(health.status, before.status, 'Calculator changed during the probe');
      const target = await timed('target', () => shared ? helper.target({ app: 'Calculator' }) : local('lease-target.js', { app: 'Calculator' }));
      assert.equal(target.ok, before.status === 'responding', target.error);
      if (target.ok) assert.equal(target.target.appId, 'com.apple.calculator');
      else assert.match(target.error, /needs one running app with a bundle ID/);
      const taps = await timed('keyboard taps', async () => shared ? helper.keyboardTaps() : (await local('keyboard-taps.js', {})).taps);
      assert.ok(Array.isArray(taps));
      if (shared) assert.equal(helperReplies.at(-1)?.ok, true, helperReplies.at(-1)?.error);
      report.queries.push({ target: target.target?.appId ?? 'absent', tapCount: taps.length });
    }
    report.helperSpawns = children.length + oneShotSpawns;
    await stopHelpers();
  } catch (error) { report.failures.push(scrub(error.message)); }
  finally {
    if (client) { try { await client.close(); report.engineCollected = true; } catch (error) { cleanup = false; report.failures.push(scrub(error.message)); } }
    // The baseline helper unrefs its handles and close() returns synchronously.
    // Keep those owned handles referenced until every close event is collected.
    for (const child of handles) { child.ref(); child.stdin?.ref?.(); child.stdout?.ref?.(); child.stderr?.ref?.(); }
    await helper?.close(); await Promise.all(children); report.helpersCollected = true;
    report.helperReplies = helperReplies;
    if (interrupted) { report.cancelled = true; report.failures.push('interrupted'); }
    clearInterval(cancellation); process.removeListener('SIGINT', cancel);
    if (bank) {
      report.trace = existsSync(join(bank, 'trace')) ? (await import('node:fs/promises')).readdir(join(bank, 'trace')).then(files => files.flatMap(f =>
        readFileSync(join(bank, 'trace', f), 'utf8').trim().split('\n').map(JSON.parse).map(e => ({ t: e.t, direction: e.direction, id: e.msg?.id, method: e.msg?.method })))) : [];
      report.trace = await report.trace;
      if (cleanup) rmSync(bank, { recursive: true, force: true });
    }
    if (unlock && cleanup) { await unlock(); report.lockReleased = true; }
    else if (unlock) report.lockRetained = true;
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  }
  return report.failures.length ? 1 : 0;
}

async function surfaceWorker(surfaces, output, cancelFile) {
  const report = { surfaces, started: new Date().toISOString(), load: loadavg(), calls: [], failures: [] };
  let unlock, client, interrupted = false, cleanup = true;
  const cancel = () => { interrupted = true; void client?.close(); };
  process.once('SIGINT', cancel);
  const cancellation = setInterval(() => { if (existsSync(cancelFile) && !interrupted) cancel(); }, 100);
  cancellation.unref();
  try {
    available(); unlock = await acquireLiveLock(); available();
    const { resolveServer } = await import('../plugins/sleight/lib/launch.mjs');
    const server = resolveServer({ ...process.env, SLEIGHT_SURFACES: surfaces });
    assert.ok(!server.error, server.error);
    server.env.BROWSER_USE_AVAILABLE_BACKENDS = 'chrome';
    report.engineVersion = server.version;
    const start = performance.now();
    available(); assert.equal(interrupted, false);
    client = await probeClient(server, { relay: false, label: 'surfaces', record: event => {
      if (event.event === 'engine-close') report.engineExit = { code: event.code, signal: event.signal };
    }, approve: async () => ({ action: 'decline' }) });
    report.initializeMs = performance.now() - start;
    for (let i = 0; i < 3; i++) {
      available(); assert.equal(interrupted, false);
      const callStart = performance.now();
      const result = await client.call('js', { code: 'nodeRepl.write("footprint-surface-ready")' });
      report.calls.push({ name: i ? 'warm js' : 'first js', ms: performance.now() - callStart, load: loadavg(),
        textBytes: result.content?.filter(b => b.type === 'text').reduce((n, b) => n + Buffer.byteLength(b.text), 0) });
      assert.ok(!result.isError && result.content?.some(b => b.type === 'text' && b.text.includes('footprint-surface-ready')), 'readiness marker missing');
    }
  } catch (error) { report.failures.push(scrub(error.message)); }
  finally {
    if (client) {
      try { await client.close(); report.engineCollected = true; }
      catch (error) { cleanup = false; report.failures.push(scrub(error.message)); }
    }
    if (unlock && cleanup) { await unlock(); report.lockReleased = true; }
    else if (unlock) report.lockRetained = true;
    clearInterval(cancellation); process.removeListener('SIGINT', cancel);
    if (interrupted) report.failures.push('interrupted');
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  }
  return report.failures.length ? 1 : 0;
}

async function pairs(baseline, output, surfaces = false) {
  available();
  const report = { started: new Date().toISOString(), mode: surfaces ? 'session engine surfaces' : 'live helper pairs; computer surface', runs: [] };
  const bank = mkdtempSync('/private/tmp/sleight-footprint-pairs-');
  const cancelFile = join(bank, 'cancel');
  let interrupted = false;
  // Workers run in their own group so terminal cancellation reaches this owner.
  // A private cancellation file lets their normal close path collect all children.
  const cancel = () => { interrupted = true; writeFileSync(cancelFile, 'cancel\n'); };
  process.once('SIGINT', cancel);
  try {
    for (let repetition = 1; repetition <= 3; repetition++) {
      const arms = surfaces ? [['computer', 'computer'], ['browser,computer', 'browser,computer']] : [['before', baseline], ['after', currentRoot]];
      for (const [arm, root] of repetition % 2 ? arms : arms.toReversed()) {
        available(); if (interrupted) return 1;
        const target = join(bank, `${arm}-${repetition}.json`);
        const child = spawn('/usr/bin/time', ['-p', process.execPath, fileURLToPath(import.meta.url), surfaces ? 'surface-worker' : 'worker', root, target, cancelFile], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = ''; child.stdout.resume(); child.stderr.on('data', data => { stderr += data; });
        const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
        const result = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : { failures: ['worker produced no report'] };
        const time = /real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys\s+([\d.]+)/.exec(stderr);
        report.runs.push({ arm, repetition, ...exit, cpuSeconds: time ? Number(time[2]) + Number(time[3]) : null, realSeconds: time ? Number(time[1]) : null,
          stderr: scrub(stderr), ...result });
        if (interrupted) report.cancelled = true;
        writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify({ arm, repetition, code: exit.code, cpuSeconds: report.runs.at(-1).cpuSeconds, initializeMs: result.initializeMs, calls: result.calls, failures: result.failures }));
        if (exit.code !== 0 || exit.signal || interrupted) return 1;
      }
    }
    return 0;
  } finally { process.removeListener('SIGINT', cancel); rmSync(bank, { recursive: true, force: true }); }
}
try {
  process.exitCode = process.argv[2] === 'worker' ? await worker(resolve(process.argv[3]), process.argv[4], process.argv[5])
    : process.argv[2] === 'surface-worker' ? await surfaceWorker(process.argv[3], process.argv[4], process.argv[5])
      : process.argv[2] === 'surfaces' ? await pairs(undefined, process.argv[3], true) : await pairs(resolve(process.argv[2]), process.argv[3]);
} catch (error) { console.error(scrub(error.message)); process.exitCode = 1; }
