// No-model CPU probes. Own the engine and helpers, hold the live lock, and publish every attempt.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadavg } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { acquireLiveLock } from './live-lock.mjs';
import { startFootprint } from './footprint.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const mode = process.argv[2] ?? 'profile';
assert.ok(['profile', 'helpers', 'helpers-pairs', 'source-pairs', 'relay-reads'].includes(mode));
const stamp = new Date().toISOString();
const output = new URL(`../docs/benchmarks/${stamp.slice(0, 10)}-footprint-parity-${mode}-${stamp.replace(/[:.]/g, '-')}.json`, import.meta.url);
const scrub = value => String(value).replace(/\/Users\/[^/\s"']+/g, '~');
const report = { started: stamp, mode, modelTurns: 0, modelMs: 0, loadStart: loadavg(), trials: [], failures: [] };
const save = () => writeFileSync(output, scrub(JSON.stringify(report, null, 2)) + '\n');
const text = result => (result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const baseline = '332e3ca0260d7eee0b003882d95d8b64ec431dd3';
const root = fileURLToPath(new URL('../', import.meta.url));
let cancelled = false, unlock, client, health, footprint, bank;
let resolveServer, createAppHealthHelper, guardedCode, readCode, probeClient, benchmarkApproval;
const sourceHashes = () => Object.fromEntries(['app-health.js', 'document-scope.mjs', 'relay.mjs'].map(file =>
  [file, createHash('sha256').update(readFileSync(join(root, 'plugins/sleight/lib', file))).digest('hex')]));
function unchanged() { assert.deepEqual(sourceHashes(), report.sources, 'production source changed during the probe'); }
const waiting = new AbortController();
process.once('SIGINT', () => { cancelled = true; waiting.abort(); });
function ready() {
  if (cancelled) throw new Error('interrupted');
  if (existsSync('/tmp/sleight-hold')) throw new Error('/tmp/sleight-hold exists; probe refused');
}
const approvals = new Map();
async function approve(params) {
  const key = JSON.stringify([params.message, params._meta?.tool_params?.app, params._meta?.riskLevel, params.requestedSchema]);
  if (approvals.has(key)) return approvals.get(key);
  const answer = await benchmarkApproval(params);
  if (answer.action === 'accept') approvals.set(key, answer);
  return answer;
}
async function call(code) {
  ready();
  const result = await client.call('js', { code, timeout_ms: 60000 });
  // Error content can contain the app's AX tree. Preserve the failed call without publishing it.
  if (result.isError) throw new Error('Engine js returned isError; response content omitted from the CPU report');
  return text(result);
}
async function sample() {
  return footprint.snapshot();
}
async function trial(name, iterations, code) {
  const source = i => typeof code === 'function' ? code(i) : code;
  const entry = { name, iterations, codeBytes: Buffer.byteLength(source(0)), load: loadavg() };
  report.trials.push(entry); save();
  const cpu = await sample(), local = process.cpuUsage(), start = performance.now();
  try {
    for (let i = 0; i < iterations; i++) {
      const result = await call(source(i));
      const marker = /^parity-read:(.*)$/m.exec(result);
      if (marker) (entry.reads ??= []).push(JSON.parse(marker[1]));
    }
    entry.ms = performance.now() - start;
    const end = await sample(), used = process.cpuUsage(local);
    entry.cpu = Object.fromEntries(['group', 'outside'].map(section => [section,
      Object.fromEntries(Object.entries(end[section]).map(([label, seconds]) => [label, Math.round((seconds - (cpu[section][label] ?? 0)) * 100) / 100]))]));
    entry.probeCpuSeconds = (used.user + used.system) / 1e6;
    entry.passed = true;
  } catch (error) { entry.error = scrub(error.message); throw error; }
  finally { entry.loadEnd = loadavg(); save(); console.log(JSON.stringify(entry)); }
}
async function timedHelper(part, app, repetitions, source = join(root, 'plugins/sleight/lib/app-health.js'), arm) {
  ready();
  const entry = { part, app, repetitions, arm, load: loadavg(), sourceSha256: createHash('sha256').update(readFileSync(source)).digest('hex') };
  report.trials.push(entry); save();
  const child = spawn('/usr/bin/time', ['-p', '/usr/bin/osascript', '-l', 'JavaScript',
    fileURLToPath(new URL('./footprint-parity-health.js', import.meta.url)),
    source, part, app, String(repetitions)],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { err += chunk; });
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  Object.assign(entry, exit);
  const measured = /real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys\s+([\d.]+)/.exec(err);
  if (measured) Object.assign(entry, { realSeconds: +measured[1], osascriptCpuSeconds: +measured[2] + +measured[3] });
  try { entry.result = JSON.parse(out); } catch { entry.error = scrub(err); }
  save(); console.log(JSON.stringify(entry));
  assert.equal(exit.code, 0, scrub(err));
  assert.ok(entry.result, 'helper report missing');
}
try {
  save(); ready(); unlock = await acquireLiveLock(undefined, { wait: true, signal: waiting.signal, interval: 1000 }); ready();
  report.lockAcquired = new Date().toISOString(); report.loadAtLock = loadavg(); save();
  bank = trackTemp(mkdtempSync('/private/tmp/sleight-footprint-parity-'));
  const oldSource = file => {
    const target = join(bank, file);
    writeFileSync(target, execFileSync('/usr/bin/git', ['show', `${baseline}:plugins/sleight/lib/${file}`], { cwd: root }));
    return target;
  };
  report.baseline = baseline;
  report.sources = sourceHashes();
  // Load after the lock: a queued run must not measure pre-edit imports under post-edit hashes.
  ({ resolveServer } = await import('../plugins/sleight/lib/launch.mjs'));
  ({ createAppHealthHelper } = await import('../plugins/sleight/lib/read-failure.mjs'));
  ({ guardedCode, readCode } = await import('../plugins/sleight/lib/document-scope.mjs'));
  ({ probeClient, benchmarkApproval } = await import('./double-keys-client.mjs'));
  unchanged();
  health = createAppHealthHelper();
  report.apps = {};
  for (const app of ['com.apple.calculator', 'com.apple.TextEdit']) {
    ready(); report.apps[app] = await health.probe(app); save();
  }
  if (mode === 'helpers-pairs') {
    const before = oldSource('app-health.js');
    for (let repetition = 1; repetition <= 3; repetition++) for (const [app, state] of Object.entries(report.apps)) {
      if (!state.pid) continue;
      const arms = [['before', before], ['after', join(root, 'plugins/sleight/lib/app-health.js')]];
      for (const [arm, source] of repetition % 2 ? arms : arms.toReversed()) await timedHelper('probe', app, 100, source, `${arm}-${repetition}`);
    }
  } else if (mode === 'helpers') {
    for (const [app, state] of Object.entries(report.apps)) {
      if (!state.pid) continue;
      for (const part of ['startup', 'probe', 'spaces', 'cg-on', 'cg-all']) await timedHelper(part, app, part === 'startup' ? 0 : 100);
    }
  } else if (mode === 'relay-reads') {
    const server = resolveServer(); assert.ok(!server.error, server.error); report.engine = server.version;
    report.relay = { calls: [], probes: 0, reads: [] };
    client = await probeClient(server, { relay: true, approve,
      relayOptions: { changeReview: false, guardTiming: true,
        spaceProbe: app => { report.relay.probes++; return health.probe(app); } },
      record: event => {
        if (event.event === 'engine-close') report.engineExit = { code: event.code, signal: event.signal };
        if (event.direction === 'to-server' && event.msg?.params?.name === 'js') {
          const code = event.msg.params.arguments.code;
          report.relay.calls.push({ codeBytes: Buffer.byteLength(code),
            installation: code.includes('globalThis.__sleightDocumentGuardSetup = update =>') });
        }
        if (event.direction === 'guard-read') report.relay.reads.push(event.msg);
      } });
    footprint = startFootprint({ rootPid: client.pid, apps: ['Calculator', 'TextEdit'], intervalMs: 250 });
    const acquiredApps = [];
    for (const [app, state] of Object.entries(report.apps)) {
      if (!state.pid) continue;
      assert.equal((await health.probe(app)).pid, state.pid, 'app must still be running');
      let acquired = await call(`var app = await cua.getApp(${JSON.stringify(app)});`);
      if (!/^Window: /m.test(acquired)) acquired = await call(`var app = await cua.getApp(${JSON.stringify(app)});`);
      assert.ok(/^Window: /m.test(acquired), 'acquisition returned no full window header');
      acquiredApps.push(app);
      await trial(`${app}-relay-full-read`, 3, 'await app.getAXState({ disableDiffing: true });');
      await trial(`${app}-relay-guarded-no-input`, 3, 'nodeRepl.write("parity-check");');
    }
    assert.ok(acquiredApps.length, 'reset needs an existing acquired app');
    const resetApp = acquiredApps[0];
    assert.equal((await health.probe(resetApp)).pid, report.apps[resetApp].pid, 'reset app must still be running');
    const reset = await client.call('js_reset', {}); assert.ok(!reset.isError, 'engine reset returned isError');
    await call(`var app = await cua.getApp(${JSON.stringify(resetApp)});`);
    await call(`var app = await cua.getApp(${JSON.stringify(resetApp)});`);
    assert.ok(report.relay.calls.filter(c => c.installation).length >= 2, 'reset must reinstall');
    assert.ok(report.relay.calls.some(c => !c.installation && c.codeBytes < 2500), 'warm call must be compact');
    assert.ok(report.relay.probes >= acquiredApps.length * 4 + 2, 'acquisitions and each handle read must still probe');
  } else {
    const server = resolveServer(); assert.ok(!server.error, server.error); report.engine = server.version;
    client = await probeClient(server, { relay: false, approve, record: event => {
      if (event.event === 'engine-close') report.engineExit = { code: event.code, signal: event.signal };
    } });
    footprint = startFootprint({ rootPid: client.pid, apps: ['Calculator', 'TextEdit'], intervalMs: 250 });
    for (let i = 0; i < 2; i++) await call('nodeRepl.write("parity-ready")');
    if (mode === 'source-pairs') {
      const before = await import(pathToFileURL(oldSource('document-scope.mjs')));
      const target = { app: 'Calculator', title: 'Calculator', url: null };
      await trial('after-install', 1, readCode('void 0;'));
      for (let repetition = 1; repetition <= 3; repetition++) {
        const arms = ['before', 'after'];
        for (const arm of repetition % 2 ? arms : arms.toReversed()) await trial(`${arm}-${repetition}`, 30, i =>
          (arm === 'before' ? before.guardedCode : guardedCode)(`void ${repetition * 100 + i};`, target,
            'window changed', undefined, { reuseSetup: arm === 'after' }));
      }
    } else {
    for (let repetition = 0; repetition < 3; repetition++) {
      const cases = [['plain', 'void 0;'], ['guard-setup', readCode('void 0;')],
        ['guarded-empty', guardedCode('void 0;', { app: 'Calculator', title: 'Calculator', url: null })]];
      for (const [name, code] of repetition % 2 ? cases.toReversed() : cases) await trial(name, 10, code);
    }
    // Restore direct acquisitions, since the source-processing trial installed Sleight's proxy.
    await call('cua.getApp = globalThis.__sleightDocumentGuard.getApp; delete globalThis.__sleightDocumentGuard;');
    for (const [app, state] of Object.entries(report.apps)) {
      if (!state.pid) continue;
      await call(`var app = await cua.getApp(${JSON.stringify(app)});`);
      for (let repetition = 0; repetition < 3; repetition++) {
        for (const full of repetition % 2 ? [false, true] : [true, false]) {
          await trial(`${app}-${full ? 'full' : 'diff'}`, 10, `{
            const start = performance.now();
            const tree = await app.getAXState({ emit: false, disableDiffing: ${full} });
            nodeRepl.write('parity-read:' + JSON.stringify({ chars: tree.length, ms: performance.now() - start,
              hasWindow: /^Window: /m.test(tree) }));
          }`);
        }
      }
    }
    }
  }
  unchanged();
} catch (error) { report.failures.push(scrub(error.message)); process.exitCode = 1; }
finally {
  if (footprint) report.footprint = await footprint();
  if (client) {
    try { await client.close(); report.engineCollected = true; }
    catch (error) { report.failures.push(scrub(error.message)); process.exitCode = 1; }
  }
  await health?.close(); report.helpersCollected = true;
  if (bank) rmSync(bank, { recursive: true, force: true });
  if (unlock && (!client || report.engineCollected)) { await unlock(); report.lockReleased = true; }
  report.cancelled = cancelled; report.finished = new Date().toISOString(); report.loadEnd = loadavg(); save();
  console.log(scrub(output.pathname));
  if (report.failures.length) console.error(report.failures.join('\n'));
}
