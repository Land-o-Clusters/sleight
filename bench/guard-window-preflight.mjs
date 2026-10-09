// Own the native child, retain every result, and never request Accessibility.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { fileURLToPath } from 'node:url';

const report = { started: new Date().toISOString(), load: loadavg(), addedWorkers: 0,
  kind: 'native-window-preflight', permissionRequested: false };
const start = performance.now();
const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', fileURLToPath(new URL('./guard-window-preflight.js', import.meta.url))],
  { stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '';
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });
const interrupt = () => child.kill('SIGTERM');
process.once('SIGINT', interrupt);
const timer = setTimeout(interrupt, 10000);
try {
  await new Promise(resolve => {
    child.once('error', error => { report.error = error.message; });
    child.once('close', (code, signal) => { report.exitCode = code; report.signal = signal; resolve(); });
  });
  report.ms = performance.now() - start;
  try { report.result = JSON.parse(stdout); } catch { report.stdout = stdout; }
  if (stderr) report.stderr = stderr;
} finally {
  clearTimeout(timer); process.removeListener('SIGINT', interrupt);
  report.finished = new Date().toISOString();
  const file = new URL(`../docs/benchmarks/2026-10-09-guard-preflight-${report.started.replace(/[:.]/g, '-')}.json`, import.meta.url);
  const serialized = JSON.stringify(report, null, 2).replaceAll(process.env.HOME, '~');
  await writeFile(file, serialized + '\n');
  console.log(serialized);
}
if (report.exitCode !== 0 || report.result?.status === 'denied') process.exitCode = 1;
