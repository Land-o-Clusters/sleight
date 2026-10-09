// What sleight's guard costs on a busy Mac, with no model in the loop. The same Calculator calls go
// straight to the engine (what Codex pays) and through sleight's relay, alternating call by call so
// both see the same load, at the Mac's own load and with CPU-bound workers added.
//
//   node bench/load-cost.mjs [--workers 0,20] [--reps 5]
//
// Writes every run to docs/benchmarks/. Calculator is approved through the benchmark allowlist.
import { loadavg } from 'node:os';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { probeClient } from './double-keys-client.mjs';
import { acquireLiveLock } from './live-lock.mjs';
import { calculatorValue } from './calculator-value.mjs';
import { startWindowObserver } from './window-observer.mjs';
import { requestNativeWindow } from './window-observer-client.mjs';
import { startLoadWorkers } from './load-workers.mjs';

const option = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const levels = option('workers', '0,20').split(',').map(Number);
const reps = Number(option('reps', '5'));
const warmup = Number(option('warmup-ms', '5000'));
if (levels.some(n => ![0, 20].includes(n)) || !Number.isInteger(reps) || reps < 1 || reps > 10 ||
  !Number.isInteger(warmup) || warmup < 0 || warmup > 180000) throw new Error('Invalid benchmark options');
const ARMS = ['direct', 'sleight'];
const DIGITS = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
// The engine clicks element numbers, taken from a full read of the arm's own session.
function calls(tree) {
  const number = id => {
    const line = tree.split('\n').find(l => new RegExp(`ID: ${id}\\b`).test(l));
    const n = line?.match(/^\s*(\d+) /)?.[1];
    if (!n) throw new Error(`no Calculator element with ID ${id}`);
    return Number(n);
  };
  const n = Object.fromEntries(DIGITS.map(id => [id, number(id)]));
  return {
    'eight-clicks': DIGITS.slice(0, 8).map(id => `await app.click(${n[id]});`).join(' '),
    'one-click': `await app.click(${n.Nine});`,
    // Keys after a click need no element tree, but the current guard still reads one.
    'click-then-keys': `await app.click(${n.Nine}); await app.pressKey("1"); await app.pressKey("2"); await app.pressKey("3");`,
    'read': 'await app.getAXState({ disableDiffing: true })',
  };
}

const plain = result => (result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const server = resolveServer();
const report = { engine: server.version, started: new Date().toISOString(), reps, warmupMs: warmup,
  modelTurns: 0, modelMs: 0, interleaved: true, levels: [], events: [] };
const file = new URL(`../docs/benchmarks/${report.started.slice(0, 10)}-load-cost-guard-speed-${report.started.replace(/[:.]/g, '-')}.json`, import.meta.url);
const save = () => writeFileSync(file, JSON.stringify(report, null, 2).replaceAll(process.env.HOME, '~') + '\n');
let unlock, observer, stopWorkers, ownApp = false;
const clients = {};
const abort = new AbortController();
process.once('SIGINT', () => {
  abort.abort(new Error('interrupted'));
  void stopWorkers?.();
  // Keep the direct handle alive for exact-app cleanup. The current bounded call drains first;
  // the abort check then prevents another trial, and finally closes Calculator before its clients.
});
try {
  save(); // Refuse an unwritable evidence destination before touching an app.
  unlock = await acquireLiveLock();
  observer = await startWindowObserver();
  report.before = await requestNativeWindow({ ...observer.endpoint, appId: 'com.apple.calculator' });
  if (!['ok', 'absent'].includes(report.before.status)) throw new Error('Calculator preflight unconfirmed: ' + report.before.status);
  ownApp = report.before.status === 'absent';
  for (const arm of ARMS) clients[arm] = await probeClient(server, { relay: arm === 'sleight',
    relayOptions: { changeReview: false, guardTiming: true }, record: event => {
      if (event.event || event.direction === 'guard-timing') report.events.push(event);
    }, timeoutMs: 150000 });
  const measured = {};
  for (const arm of ARMS) {
    const acquired = await clients[arm].call('js', { code: 'var app = await cua.getApp("com.apple.calculator")', timeout_ms: 60000 });
    if (acquired.isError) throw new Error(plain(acquired));
    // The engine diffs a read against the app's latest read by anyone, so each arm takes a full one.
    for (let attempt = 1; !measured[arm]; attempt++) {
      const full = await clients[arm].call('js', { code: 'await app.getAXState({ disableDiffing: true })', timeout_ms: 60000 });
      try { measured[arm] = calls(plain(full)); } catch (error) { if (attempt === 3) throw error; }
    }
  }
  for (const workers of levels) {
    const stopLoad = stopWorkers = startLoadWorkers(workers, { onError: error => abort.abort(error) });
    const level = { workers, loadStarted: new Date().toISOString(), rows: [] };
    report.levels.push(level); save();
    try {
    await sleep(workers ? warmup : 0, undefined, { signal: abort.signal });
    for (const name of Object.keys(measured.direct)) {
      for (let rep = 0; rep < reps; rep++) {
        for (const arm of rep % 2 ? [...ARMS].reverse() : ARMS) {
          abort.signal.throwIfAborted();
          const row = { arm, call: name, rep, started: new Date().toISOString() };
          level.rows.push(row); save();
          try {
            const reset = await clients[arm].call('js', { code: 'await app.pressKey("Escape"); await app.getAXState({ disableDiffing: true })', timeout_ms: 120000 });
            row.reset = plain(reset);
            if (reset.isError || calculatorValue(row.reset) !== '0') throw new Error('Calculator reset did not show zero: ' + row.reset);
            const code = calls(row.reset)[name];
            row.load = loadavg()[0]; const start = performance.now();
            let result;
            try { result = await clients[arm].call('js', { code, timeout_ms: 120000 }); }
            finally { row.ms = performance.now() - start; }
            row.result = result;
            if (result.isError) throw new Error(plain(result));
            const verification = await clients[arm].call('js', { code: 'await app.getAXState({disableDiffing:true})', timeout_ms: 120000 });
            row.verification = plain(verification);
            row.value = calculatorValue(row.verification);
            const wanted = { 'eight-clicks': '12345678', 'one-click': '9', 'click-then-keys': '9123', read: '0' }[name];
            if (verification.isError || row.value !== wanted) throw new Error(`Expected ${wanted}, saw ${row.value}`);
            row.isError = false;
          } catch (error) { row.isError = true; row.error = error.message; }
          row.finished = new Date().toISOString(); save();
          console.log(JSON.stringify({workers,arm,call:name,rep,ms:row.ms,load:row.load,isError:row.isError}));
        }
      }
      for (const arm of ARMS) await clients[arm].call('js', { code: 'await app.pressKey("Escape")', timeout_ms: 60000 }).catch(() => {});
    }
    } finally { level.workerCleanup = await stopLoad(); level.loadEnded = new Date().toISOString(); save(); }
  }
} catch (error) { report.error = error.message; process.exitCode = 1;
} finally {
  await stopWorkers?.();
  if (ownApp && clients.direct) {
    try { report.quit = await clients.direct.call('js', {code:'await app.pressKey("super+q")',timeout_ms:10000}); }
    catch (error) { report.quitError = error.message; }
  }
  for (const client of Object.values(clients)) await client.close().catch(() => {});
  if (observer && ownApp) {
    for (let i = 0; i < 20; i++) {
      report.after = await requestNativeWindow({...observer.endpoint,appId:'com.apple.calculator'});
      if (report.after.status === 'absent') break;
      await sleep(100);
    }
    if (report.after.status !== 'absent') { report.cleanupError = 'Calculator exit unconfirmed'; process.exitCode = 1; }
  }
  await observer?.close();
  if (unlock) await unlock();
  report.finished = new Date().toISOString(); save();
}

const median = list => { const s = list.map(r => r.ms).filter(Number.isFinite).sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? null; };
if (report.levels.some(level => level.rows.some(row => row.isError))) process.exitCode = 1;
console.log('| Workers | Load | Call | Engine only ms | sleight ms | sleight stops |');
console.log('|---:|---:|---|---:|---:|---:|');
for (const level of report.levels) for (const name of [...new Set(level.rows.map(r => r.call))]) {
  const rows = arm => level.rows.filter(r => r.arm === arm && r.call === name);
  const loads = level.rows.filter(r => r.call === name).map(r => r.load).filter(Number.isFinite);
  console.log(`| ${level.workers} | ${Math.min(...loads).toFixed(0)}–${Math.max(...loads).toFixed(0)} | ${name} | ${median(rows('direct'))} | ${median(rows('sleight'))} | ${rows('sleight').filter(r => r.isError).length}/${rows('sleight').length} |`);
}
console.log(`results: ${file.pathname.replace(process.env.HOME, '~')}`);
