// What sleight's guard costs on a busy Mac, with no model in the loop. The same Calculator calls go
// straight to the engine (what Codex pays) and through sleight's relay, alternating call by call so
// both see the same load, at the Mac's own load and with CPU-bound workers added.
//
//   node bench/load-cost.mjs [--workers 0,20] [--reps 5]
//
// Writes bench/results/load-cost-<stamp>.json. Calculator is approved through the benchmark allowlist.
import { spawn } from 'node:child_process';
import { loadavg } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { probeClient } from './double-keys-client.mjs';
import { acquireLiveLock } from './live-lock.mjs';

const option = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const levels = option('workers', '0,20').split(',').map(Number);
const reps = Number(option('reps', '5'));
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
    // Keys after a click need no tree, so the guard checks them against the inventory.
    'click-then-keys': `await app.click(${n.Nine}); await app.pressKey("1"); await app.pressKey("2"); await app.pressKey("3");`,
    'read': 'await app.getAXState({ disableDiffing: true })',
  };
}

// Busy loops, one process each, killed on exit.
function startLoad(count) {
  const workers = Array.from({ length: count }, () => spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' }));
  const stop = () => workers.forEach(w => w.kill('SIGKILL'));
  process.once('exit', stop);
  return stop;
}

const plain = result => (result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const server = resolveServer();
const report = { engine: server.version, started: new Date().toISOString(), reps, interleaved: true, levels: [] };
const unlock = await acquireLiveLock(undefined, { wait: true });
const clients = {};
try {
  for (const arm of ARMS) clients[arm] = await probeClient(server, { relay: arm === 'sleight', record: () => {}, timeoutMs: 120000 });
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
    const stopLoad = startLoad(workers);
    await sleep(workers ? 5000 : 0);
    const level = { workers, rows: [] };
    for (const name of Object.keys(measured.direct)) {
      for (let rep = 0; rep < reps; rep++) {
        for (const arm of rep % 2 ? [...ARMS].reverse() : ARMS) {
          const load = loadavg()[0], start = performance.now();
          let row;
          try {
            const result = await clients[arm].call('js', { code: measured[arm][name], timeout_ms: 60000 });
            row = { isError: !!result.isError, ...(result.isError ? { error: plain(result).slice(0, 300) } : {}) };
          } catch (error) { row = { isError: true, error: error.message }; }
          level.rows.push({ arm, call: name, rep, load: Math.round(load * 10) / 10, ms: Math.round(performance.now() - start), ...row });
        }
      }
      for (const arm of ARMS) await clients[arm].call('js', { code: 'await app.pressKey("Escape")', timeout_ms: 60000 }).catch(() => {});
    }
    stopLoad();
    report.levels.push(level);
    await sleep(workers ? 10000 : 0);
  }
} finally {
  for (const client of Object.values(clients)) await client.close().catch(() => {});
  await unlock();
}

const median = list => { const s = list.map(r => r.ms).sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
const file = new URL(`./results/load-cost-${report.started.replace(/[:.]/g, '-')}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
console.log('| Workers | Load | Call | Engine only ms | sleight ms | sleight stops |');
console.log('|---:|---:|---|---:|---:|---:|');
for (const level of report.levels) for (const name of [...new Set(level.rows.map(r => r.call))]) {
  const rows = arm => level.rows.filter(r => r.arm === arm && r.call === name);
  const loads = level.rows.filter(r => r.call === name).map(r => r.load);
  console.log(`| ${level.workers} | ${Math.min(...loads).toFixed(0)}–${Math.max(...loads).toFixed(0)} | ${name} | ${median(rows('direct'))} | ${median(rows('sleight'))} | ${rows('sleight').filter(r => r.isError).length}/${rows('sleight').length} |`);
}
console.log(`results: ${file.pathname}`);
