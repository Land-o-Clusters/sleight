// Native socket and abandoned-read experiment. No pointer input; all children belong to this run.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadavg } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';
import { startWindowObserver } from './window-observer.mjs';
import { requestNativeWindow } from './window-observer-client.mjs';
import { probeClient } from './double-keys-client.mjs';
import { acquireLiveLock } from './live-lock.mjs';
import { startLoadWorkers } from './load-workers.mjs';

const workers = Number(process.argv[process.argv.indexOf('--workers') + 1]) || 0;
if (![0, 20].includes(workers)) throw new Error('Use --workers 0 or --workers 20');
const report = { started: new Date().toISOString(), engine: resolveServer().version, workers, rows: [], events: [] };
const abort = new AbortController();
process.once('SIGINT', () => abort.abort(new Error('interrupted')));
let observer, nativeChild, client, unlock, stopWorkers, ownApp = false;
const plain = result => (result.content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
const file = new URL(`../docs/benchmarks/2026-10-09-guard-probe-${report.started.replace(/[:.]/g, '-')}.json`, import.meta.url);
async function save() {
  const data = JSON.stringify(report, null, 2).replaceAll(process.env.HOME, '~');
  await writeFile(file, data + '\n');
}
async function call(label, code) {
  abort.signal.throwIfAborted();
  const started = new Date().toISOString(), load = loadavg()[0], start = performance.now();
  const result = await client.call('js', { code, timeout_ms: 120000 });
  report.rows.push({ label, started, load, ms: performance.now() - start, result });
  await save();
  if (result.isError) throw new Error(plain(result));
  return result;
}
try {
  unlock = await acquireLiveLock();
  observer = await startWindowObserver({ spawnHelper: () => {
    nativeChild = spawn('/usr/bin/osascript', ['-l', 'JavaScript', fileURLToPath(new URL('./guard-window-observer.js', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    return nativeChild;
  } });
  const endpoint = { ...observer.endpoint, appId: 'com.apple.calculator' };
  report.before = await requestNativeWindow(endpoint);
  if (report.before.status === 'denied') throw new Error('Accessibility unavailable; no permission requested');
  if (!['absent', 'ok'].includes(report.before.status)) throw new Error('Native preflight unconfirmed: ' + report.before.status);
  ownApp = report.before.status === 'absent';
  client = await probeClient(resolveServer(), { relay: false, timeoutMs: 150000, record: event => {
    if (event.event) report.events.push(event);
  } });
  await call('acquire', 'var app = await cua.getApp("com.apple.calculator")');
  // The earlier published run established connect EPERM from the engine. Do not retry that path.
  report.loadStarted = new Date().toISOString();
  stopWorkers = startLoadWorkers(workers, { onError: error => abort.abort(error) });
  if (workers) await sleep(60000, undefined, { signal: abort.signal });
  for (let i = 0; i < 20; i++) {
    const start = performance.now(), response = await requestNativeWindow(endpoint);
    report.rows.push({ label: 'native', load: loadavg()[0], ms: performance.now() - start, response });
    if (response.status === 'denied') throw new Error('Accessibility unavailable; stopped without requesting permission');
  }
  // Only this script's native child is stopped, to prove a starved helper cannot authorize input.
  nativeChild.kill('SIGSTOP');
  try {
    const start = performance.now();
    report.rows.push({ label: 'helper-starved', load: loadavg()[0], response: await requestNativeWindow(endpoint), ms: performance.now() - start });
  } finally { nativeChild.kill('SIGCONT'); }
  await sleep(300);
  report.rows.push({ label: 'helper-recovered', response: await requestNativeWindow(endpoint) });
  await call('reset', 'await app.pressKey("Escape"); await app.getAXState({disableDiffing:true});');
  await call('abandon-read', `await app.pressKey("1");
    globalThis.lateReadDone = false;
    globalThis.lateRead = app.getAXState({emit:false,disableDiffing:true}).then(text => {globalThis.lateReadDone=true; return text;});
    nodeRepl.write(await Promise.race([lateRead.then(() => "read completed"), new Promise(resolve => setTimeout(() => resolve("read still pending at 100ms"),100))]));`);
  await call('next-pure-call', 'nodeRepl.write({lateReadDone:globalThis.lateReadDone});');
  await call('next-input-call', 'await app.pressKey("2"); nodeRepl.write({lateReadDone:globalThis.lateReadDone});');
  await call('collect-read', 'nodeRepl.write(await globalThis.lateRead);');
  await call('fresh-read', 'await app.getAXState({disableDiffing:true});');
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  nativeChild?.kill('SIGCONT');
  report.workerCleanup = await stopWorkers?.() ?? [];
  report.loadEnded = new Date().toISOString();
  if (client) {
    if (ownApp) {
      try { report.quit = await client.call('js', {code:'await app.pressKey("super+q")',timeout_ms:10000}); }
      catch (error) { report.quitError = error.message; }
    }
    await client.close();
    if (observer && ownApp) {
      const endpoint = { ...observer.endpoint, appId: 'com.apple.calculator' };
      for (let i = 0; i < 20; i++) {
        report.after = await requestNativeWindow(endpoint);
        if (report.after.status === 'absent') break;
        await sleep(100);
      }
      if (report.after.status !== 'absent') { report.cleanupError = 'Calculator exit unconfirmed'; process.exitCode = 1; }
    }
  }
  await observer?.close();
  if (unlock) await unlock();
  report.finished = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ file: file.pathname.replace(process.env.HOME, '~'), error: report.error,
    rows: report.rows.map(({label,ms,load,response,result})=>({label,ms,load,response,text:result && plain(result).slice(-300)})), after: report.after }));
}
