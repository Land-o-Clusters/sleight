// Cold versus persistent JXA observations. Calculator alone, through the benchmark approval hook.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadavg } from 'node:os';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { probeClient } from './double-keys-client.mjs';
import { acquireLiveLock } from './live-lock.mjs';

const source = fileURLToPath(new URL('./guard-window-native.js', import.meta.url));
const report = { started: new Date().toISOString(), engine: resolveServer().version, addedWorkers: 0, rows: [], events: [] };
const children = new Set();
let client, unlock, worker, ownApp = false, acquired = false;
function launch(args) {
  const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', source, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  child.stopped = new Promise(resolve => child.once('close', (code, signal) => { children.delete(child); resolve({ code, signal }); }));
  child.on('error', error => report.events.push({ error: error.message }));
  child.stderr.on('data', chunk => report.events.push({ stderr: String(chunk) }));
  return child;
}
const abort = new AbortController();
process.once('SIGINT', () => abort.abort(new Error('interrupted')));
async function stop(child) {
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGTERM'), 1000);
  try { return await child.stopped; } finally { clearTimeout(timer); }
}
const plain = result => (result.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
try {
  unlock = await acquireLiveLock();
  const preflight = launch([JSON.stringify({ id: 0, appId: 'com.apple.calculator' })]);
  let output = ''; preflight.stdout.on('data', chunk => { output += chunk; });
  await preflight.stopped;
  report.before = JSON.parse(output);
  if (!['absent', 'ok'].includes(report.before.status)) throw new Error('Native preflight unavailable: ' + report.before.status);
  ownApp = report.before.status === 'absent';
  client = await probeClient(resolveServer(), { relay: false, record: event => {
    if (event.event || event.direction === 'received') report.events.push(event);
  } });
  const result = await client.call('js', { code: 'var app = await cua.getApp("com.apple.calculator")', timeout_ms: 20000 });
  if (result.isError) throw new Error(plain(result));
  acquired = true;
  for (let i = 0; i < 3; i++) {
    abort.signal.throwIfAborted();
    const start = performance.now(), child = launch([JSON.stringify({ id: i, appId: 'com.apple.calculator' })]);
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    const exit = await child.stopped;
    const response = JSON.parse(output);
    report.rows.push({ mode: 'cold', ms: performance.now() - start, load: loadavg()[0], response, exit });
    if (response.status !== 'ok') throw new Error('Native observation unavailable: ' + JSON.stringify(response));
  }
  worker = launch([]);
  const lines = createInterface({ input: worker.stdout });
  for (let i = 0; i < 20; i++) {
    abort.signal.throwIfAborted();
    const start = performance.now();
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('native observation deadline')), 3000);
      lines.once('line', line => { clearTimeout(timer); resolve(JSON.parse(line)); });
      worker.stdin.write(JSON.stringify({ id: i, appId: 'com.apple.calculator' }) + '\n');
    });
    report.rows.push({ mode: i ? 'warm' : 'startup', ms: performance.now() - start, load: loadavg()[0], response });
    if (response.status !== 'ok') throw new Error('Native observation unavailable: ' + JSON.stringify(response));
  }
  lines.close();
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  report.cleanup = [];
  for (const child of children) report.cleanup.push(await stop(child));
  if (client) {
    if (ownApp && acquired) {
      try { report.quit = await client.call('js', { code: 'await app.pressKey("super+q")', timeout_ms: 10000 }); }
      catch (error) { report.quitError = error.message; }
    }
    await client.close();
  }
  if (unlock) await unlock();
  report.finished = new Date().toISOString();
  const file = new URL(`../docs/benchmarks/2026-10-09-guard-native-${report.started.replace(/[:.]/g, '-')}.json`, import.meta.url);
  const data = JSON.stringify(report, null, 2).replaceAll(process.env.HOME, '~');
  console.log(JSON.stringify({ file: file.pathname.replace(process.env.HOME, '~'), rows: report.rows, error: report.error }));
  await writeFile(file, data + '\n');
}
