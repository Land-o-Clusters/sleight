// Execute the declared pairs. The wrapper acquires and releases a lock per trial.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
let cancelled = false;
process.once('SIGINT', () => { cancelled = true; });
const trials = [];
for (const repetition of ['1', '2']) {
  for (const task of ['calculator-click', 'calculator-menu', 'textedit-save']) {
    for (const arm of repetition === '1' ? ['off', 'on'] : ['on', 'off']) {
      if (arm === 'off' && task === 'calculator-click' && repetition === '1') continue; // collected separately
      trials.push({ arm, task, repetition });
    }
  }
}
let failed = false;
for (const trial of trials) {
  if (cancelled) break;
  console.log(`Starting ${JSON.stringify(trial)}`);
  const child = spawn('sh', ['bench/action-notes-live.sh', trial.arm, trial.task, trial.repetition, '6'], { stdio: 'inherit' });
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  appendFileSync('docs/benchmarks/2026-10-04-action-notes-series.jsonl', JSON.stringify({ ...trial, ...exit }) + '\n');
  if (exit.code !== 0) failed = true;
}
process.exitCode = failed || cancelled ? 1 : 0;
