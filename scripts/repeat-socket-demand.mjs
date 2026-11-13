// Offline SD1 stress check: node scripts/repeat-socket-demand.mjs RUNS PARALLEL
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [runs, parallel] = process.argv.slice(2).map(Number);
if (!Number.isInteger(runs) || runs < 1 || runs > 100 || !Number.isInteger(parallel) || parallel < 1 || parallel > 3) {
  throw new Error('Usage: node scripts/repeat-socket-demand.mjs RUNS(1..100) PARALLEL(1..3)');
}
const gate = join(process.env.HOME, 'Projects/sleight-wt/ledger/vc/night/lanes-may-test');
const directory = mkdtempSync('/private/tmp/sleight-demand-repeat-');
const active = new Set(), results = [];
let next = 0, interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  // These groups contain only test processes this script launched.
  for (const child of active) signalGroup(child, signal);
});
function signalGroup(child, signal) {
  try { process.kill(-child.pid, signal); }
  catch (err) { if (err.code !== 'ESRCH') throw err; }
}
async function run(index) {
  while (!existsSync(gate) && !interrupted) await delay(1000);
  if (interrupted) return;
  const config = mkdtempSync('/tmp/lane-claude-');
  const started = performance.now();
  const child = spawn('nice', ['-n', '20', process.execPath, '--test', '--test-concurrency=1',
    '--test-reporter=tap', 'tests/socket-demand.test.mjs'], {
    detached: true, env: { ...process.env, CLAUDE_CONFIG_DIR: config }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  active.add(child);
  let output = '', force, error;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const timer = setTimeout(() => {
    error = 'waiting for socket-demand test file completion after 45 seconds';
    signalGroup(child, 'SIGTERM');
    force = setTimeout(() => signalGroup(child, 'SIGKILL'), 2000);
  }, 45000);
  try {
    const exit = await new Promise(resolve => {
      child.once('error', err => { error = err.message; });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const count = name => Number(output.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? 0);
    const result = { index, ...exit, ms: Math.round(performance.now() - started),
      tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped'), error };
    results.push(result);
    writeFileSync(join(directory, `${index}.tap`), output);
    console.log(JSON.stringify(result));
  } finally {
    clearTimeout(timer); clearTimeout(force); active.delete(child);
    rmSync(config, { recursive: true, force: true });
  }
}
await Promise.all(Array.from({ length: parallel }, async () => {
  while (next < runs && !interrupted) await run(++next);
}));
const passed = results.filter(result => result.code === 0 && result.tests > 0 && result.pass === result.tests && !result.error).length;
const summary = { runs, parallel, completed: results.length, passed, failed: results.length - passed,
  slowestMs: Math.max(0, ...results.map(result => result.ms)), results, directory };
writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ ...summary, results: undefined }));
if (passed !== runs || interrupted) process.exitCode = 1;
