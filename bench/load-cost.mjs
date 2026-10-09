// What sleight's guard costs on a busy Mac, with no model in the loop. The same Calculator calls go
// straight to the engine (what Codex pays) and through sleight's relay, at the Mac's own load and
// with CPU-bound workers added.
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
const DIGITS = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
// The engine clicks element numbers. Both arms use the numbers from their own acquisition read.
function calls(tree) {
  const number = id => {
    const line = tree.split('\n').find(l => new RegExp(`ID: ${id}\\b`).test(l));
    const n = line?.match(/^\s*(\d+) /)?.[1];
    if (!n) throw new Error(`no Calculator element with ID ${id} in:\n${tree.slice(0, 1500)}`);
    return Number(n);
  };
  const n = Object.fromEntries(DIGITS.map(id => [id, number(id)]));
  return {
    'eight-clicks': DIGITS.slice(0, 8).map(id => `await app.click(${n[id]});`).join(' '),
    'one-click': `await app.click(${n.Nine});`,
    'read': 'await app.getAXState({ disableDiffing: true })',
    // The clear button is AllClear or Clear depending on the display, so Escape instead.
    clear: 'await app.pressKey("Escape");',
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
const report = { engine: server.version, started: new Date().toISOString(), reps, levels: [] };
const unlock = await acquireLiveLock(undefined, { wait: true });
try {
  for (const workers of levels) {
    const stopLoad = startLoad(workers);
    await sleep(workers ? 5000 : 0);
    const level = { workers, loadBefore: loadavg()[0], arms: {} };
    for (const arm of ['direct', 'sleight']) {
      const client = await probeClient(server, { relay: arm === 'sleight', record: () => {} });
      const rows = level.arms[arm] = {};
      try {
        const acquired = await client.call('js', { code: 'var app = await cua.getApp("com.apple.calculator")', timeout_ms: 60000 });
        if (acquired.isError) throw new Error(plain(acquired));
        // The engine diffs a read against the app's latest read by anyone, so the second arm's
        // acquisition shows no full tree. A full read gives both arms the numbers.
        let numbered;
        for (let attempt = 1; !numbered; attempt++) {
          const full = await client.call('js', { code: 'await app.getAXState({ disableDiffing: true })', timeout_ms: 60000 });
          try { numbered = calls(plain(full)); } catch (error) { if (attempt === 3) throw error; }
        }
        const { clear, ...measured } = numbered;
        for (const [name, code] of Object.entries(measured)) {
          rows[name] = [];
          for (let i = 0; i < reps; i++) {
            const start = performance.now();
            const result = await client.call('js', { code, timeout_ms: 60000 });
            rows[name].push({ ms: Math.round(performance.now() - start), isError: !!result.isError, ...(result.isError ? { error: plain(result).slice(0, 300) } : {}) });
          }
        }
        await client.call('js', { code: clear, timeout_ms: 60000 }).catch(() => {});
      } finally { await client.close(); }
    }
    level.loadAfter = loadavg()[0];
    stopLoad();
    report.levels.push(level);
    await sleep(workers ? 10000 : 0);
  }
} finally { await unlock(); }

const median = list => { const s = list.map(r => r.ms).sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
const file = new URL(`./results/load-cost-${report.started.replace(/[:.]/g, '-')}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
console.log('| Workers | Load | Call | Engine only ms | sleight ms |');
console.log('|---:|---:|---|---:|---:|');
for (const level of report.levels) for (const name of Object.keys(level.arms.direct)) {
  console.log(`| ${level.workers} | ${level.loadBefore.toFixed(0)}–${level.loadAfter.toFixed(0)} | ${name} | ${median(level.arms.direct[name])} | ${median(level.arms.sleight[name])} |`);
}
console.log(`results: ${file.pathname}`);
