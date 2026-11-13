// Owner-run only: this intentionally loads four CPUs beside headless fixtures.
// The caller supplies its test-window marker; no private ledger path ships here.
import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, createWriteStream, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!isMainThread) {
  const stop = new Int32Array(workerData.stop), until = Date.now() + 300000;
  let value = 0;
  while (!Atomics.load(stop, 0) && Date.now() < until) {
    for (let i = 0; i < 10000; i++) value = Math.imul(value + i, 1664525);
  }
} else {
  const [flag, gate, count = '10', ...extra] = process.argv.slice(2);
  if (flag !== '--gate' || !gate || !/^([1-9]|10)$/.test(count) || extra.length) {
    throw Error('Usage: nice -n 20 node scripts/fl3-load-check.mjs --gate FILE [1..10]');
  }
  const root = fileURLToPath(new URL('..', import.meta.url)), gateFile = resolve(gate);
  const output = mkdtempSync(join(tmpdir(), 'fl3-load-')), results = [];
  const files = ['tests/direct-browser-export.real.test.mjs', 'tests/direct-browser-points.real.test.mjs',
    'tests/direct-browser-forms.real.test.mjs'];
  let stopped = false, child, stop, collected = [];
  const stopLoad = () => { if (stop) Atomics.store(stop, 0, 1); };
  const interrupt = () => { if (stopped) return; stopped = true; stopLoad(); child?.kill('SIGINT'); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  console.log(JSON.stringify({ output, rounds: +count, files, loadWorkers: 4, loadLimitMs: 300000 }));
  try {
    for (let round = 1; round <= +count && !stopped; round++) {
      while (!existsSync(gateFile) && !stopped) {
        console.log('Waiting for the supplied test-window marker');
        await new Promise(resolveWait => setTimeout(resolveWait, 60000));
      }
      if (stopped) break;
      const config = mkdtempSync('/tmp/lane-claude-');
      const log = join(output, round + '.tap'), stream = createWriteStream(log), start = Date.now();
      let watch;
      try {
        // Recheck immediately before starting either load or tests.
        if (!existsSync(gateFile)) { stopped = true; break; }
        stop = new Int32Array(new SharedArrayBuffer(4));
        const workers = Array.from({ length: 4 }, () => new Worker(new URL(import.meta.url), { workerData: { stop: stop.buffer } }));
        collected = workers.map(worker => once(worker, 'exit'));
        child = spawn('/usr/bin/nice', ['-n', '20', process.execPath, '--test', '--test-concurrency=4',
          '--test-timeout=240000', '--test-reporter=tap', ...files], {
          cwd: root, env: { ...process.env, CLAUDE_CONFIG_DIR: config, SLEIGHT_LIVE_DOM_TEST: '1' },
          stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000, killSignal: 'SIGINT',
        });
        child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
        watch = setInterval(() => { if (!existsSync(gateFile)) interrupt(); }, 1000);
        const [code, signal] = await once(child, 'close');
        const result = { round, code, signal, elapsedMs: Date.now() - start, log };
        results.push(result);
        writeFileSync(join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
      } finally {
        clearInterval(watch); stopLoad();
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGINT'); await once(child, 'close');
        }
        child = undefined;
        await Promise.all(collected); collected = [];
        await new Promise(resolveEnd => stream.end(resolveEnd));
        rmSync(config, { recursive: true, force: true });
      }
      console.log(JSON.stringify({ ...results.at(-1), workersCollected: 4 }));
    }
  } finally {
    stopLoad(); await Promise.all(collected);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
  process.exitCode = stopped || results.length !== +count || results.some(result => result.code !== 0) ? 1 : 0;
}
