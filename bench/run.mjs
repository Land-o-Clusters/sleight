#!/usr/bin/env node
// Runs the undertow benchmark: each task through headless `claude -p` with the
// plugin loaded, checked outside the agent. Writes bench/results/<stamp>.json
// and prints a table.
//
//   node bench/run.mjs [--tasks id,id] [--runs N] [--model M] [--dry-run]
//
// A real run AUTO-APPROVES Calculator and TextEdit for undertow (approve.mjs),
// because -p can't show approval prompts. Run it only when you're fine with
// Claude driving those two apps unattended. --dry-run sets up and checks
// tasks without launching Claude.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tasks } from './tasks.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 5 * 60 * 1000;

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const isDryRun = process.argv.includes('--dry-run');
const runs = Number(option('runs', '1'));
const model = option('model', undefined);
const wanted = option('tasks', undefined)?.split(',');
const claudeBin = process.env.CLAUDE_BIN || 'claude';
const selected = wanted ? tasks.filter(t => wanted.includes(t.id)) : tasks;
if (!selected.length) throw new Error(`no tasks match ${wanted}`);

function runClaude(prompt) {
  const args = [
    '-p', prompt,
    '--plugin-dir', join(ROOT, 'plugins', 'undertow'),
    '--settings', join(ROOT, 'bench', 'settings.json'),
    '--allowedTools', 'mcp__plugin_undertow_computer__js',
    '--output-format', 'json',
    ...(model ? ['--model', model] : []),
  ];
  return new Promise(resolve => {
    const child = spawn(claudeBin, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    child.on('close', code => {
      clearTimeout(timer);
      let out;
      try { out = JSON.parse(stdout); } catch { out = undefined; }
      resolve({ code, out, stderr: stderr.slice(-2000) });
    });
  });
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const results = [];
for (const task of selected) {
  for (let run = 1; run <= runs; run++) {
    const nonce = randomBytes(4).toString('hex');
    const dir = join(tmpdir(), 'undertow-bench', stamp, `${task.id}-${run}`);
    mkdirSync(dir, { recursive: true });
    const ctx = { dir, nonce };
    task.setup?.(ctx);
    const prompt = task.prompt(ctx);

    if (isDryRun) {
      results.push({ task: task.id, run, prompt, dryRun: true, check: String(task.check({ ...ctx, answer: '' })) });
      continue;
    }

    const started = Date.now();
    const { code, out, stderr } = await runClaude(prompt);
    const answer = out?.result ?? '';
    let verdict;
    try { verdict = task.check({ ...ctx, answer }); } catch (err) { verdict = err.message; }
    results.push({
      task: task.id,
      run,
      passed: verdict === true,
      reason: verdict === true ? undefined : verdict,
      seconds: Math.round((Date.now() - started) / 100) / 10,
      turns: out?.num_turns,
      costUsd: out?.total_cost_usd,
      exitCode: code,
      answer: answer.slice(0, 300),
      stderr: code === 0 ? undefined : stderr,
    });
    const r = results.at(-1);
    console.error(`${r.passed ? 'PASS' : 'FAIL'} ${task.id} #${run} ${r.seconds}s${r.reason ? ` (${r.reason})` : ''}`);
  }
}

const resultsDir = join(ROOT, 'bench', 'results');
mkdirSync(resultsDir, { recursive: true });
const file = join(resultsDir, `${stamp}${isDryRun ? '-dry' : ''}.json`);
writeFileSync(file, JSON.stringify({ stamp, model: model ?? 'default', claude: claudeBin, results }, null, 2) + '\n');

if (!isDryRun) {
  console.log('\n| Task | Passed | Median s | Median turns | Total cost |');
  console.log('|---|---|---|---|---|');
  const median = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : '–'; };
  for (const task of selected) {
    const rs = results.filter(r => r.task === task.id);
    const cost = rs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
    console.log(`| ${task.id} | ${rs.filter(r => r.passed).length}/${rs.length} | ${median(rs.map(r => r.seconds))} | ${median(rs.map(r => r.turns))} | $${cost.toFixed(2)} |`);
  }
}
console.log(`\nresults: ${file}`);
