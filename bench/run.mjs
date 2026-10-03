#!/usr/bin/env node
// Runs the sleight benchmark: each task through headless `claude -p` with the
// plugin loaded, checked outside the agent. Writes bench/results/<stamp>.json
// and prints a table.
//
//   node bench/run.mjs [--arm sleight|lcu|all] [--tasks id,id] [--runs N] [--model M] [--dry-run]
//
// Arms: `sleight` loads this repo's plugin. `lcu` runs from a folder where LCU
// (github.com/0xpolarzero/lcu) was registered for Claude Code at project scope:
//   lcu setup --agent claude-code --scope project --project <dir> --no-chrome --no-audio --yes
// The folder is LCU_ARM_DIR (default .dev/lcu-arm), and LCU needs Python 3.12+
// first on PATH (LCU_PATH_PREFIX, default .dev/py). BENCH_ROOT tells the
// approval hook where this repo is, since an arm may run from another folder.
//
// A real run AUTO-APPROVES Calculator and TextEdit for either arm (approve.mjs),
// because -p can't show approval prompts. Run it only when you're fine with
// Claude driving those two apps unattended. --dry-run sets up and checks
// tasks without launching Claude.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
const armOption = option('arm', 'sleight');
const ARMS = {
  // Each arm runs from its own empty folder, so neither gets this repo's
  // CLAUDE.md or project memory (until 2026-10-03 the sleight arm ran here).
  sleight: {
    cwd: (() => {
      const dir = process.env.SLEIGHT_ARM_DIR || join(ROOT, '.dev', 'sleight-arm');
      mkdirSync(dir, { recursive: true });
      return dir;
    })(),
    args: ['--plugin-dir', join(ROOT, 'plugins', 'sleight'), '--allowedTools', 'mcp__plugin_sleight_computer__js'],
    env: {},
  },
  lcu: (() => {
    const dir = process.env.LCU_ARM_DIR || join(ROOT, '.dev', 'lcu-arm');
    const prefix = process.env.LCU_PATH_PREFIX || join(ROOT, '.dev', 'py');
    return {
      cwd: dir,
      args: ['--mcp-config', join(dir, '.mcp.json'), '--allowedTools', 'mcp__lcu__js'],
      env: { PATH: `${prefix}:${process.env.PATH}` },
      check: () => existsSync(join(dir, '.mcp.json')) || `no LCU registration in ${dir}`,
    };
  })(),
};
const armNames = armOption === 'all' ? Object.keys(ARMS) : [armOption];
for (const name of armNames) {
  if (!ARMS[name]) throw new Error(`unknown arm ${name}`);
  const ok = ARMS[name].check?.() ?? true;
  if (ok !== true) throw new Error(ok);
}
const runs = Number(option('runs', '1'));
const model = option('model', undefined);
const wanted = option('tasks', undefined)?.split(',');
const claudeBin = process.env.CLAUDE_BIN || 'claude';
const selected = wanted ? tasks.filter(t => wanted.includes(t.id)) : tasks;
if (!selected.length) throw new Error(`no tasks match ${wanted}`);

function runClaude(prompt, arm) {
  const args = [
    '-p', prompt,
    ...arm.args,
    '--settings', join(ROOT, 'bench', 'settings.json'),
    '--output-format', 'json',
    ...(model ? ['--model', model] : []),
  ];
  return new Promise(resolve => {
    // SLEIGHT_APPROVAL_PROMPT=client keeps approvals going to approve.mjs, even
    // when the benchmark runs from a desktop app session.
    const env = { ...process.env, BENCH_ROOT: ROOT, SLEIGHT_APPROVAL_PROMPT: 'client', ...arm.env };
    const child = spawn(claudeBin, args, { cwd: arm.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
const resultsDir = join(ROOT, 'bench', 'results');
mkdirSync(resultsDir, { recursive: true });
const file = join(resultsDir, `${stamp}${isDryRun ? '-dry' : ''}.json`);
// Written after every run, so a run cut short keeps what it finished.
const save = () =>
  writeFileSync(file, JSON.stringify({ stamp, arms: armNames, model: model ?? 'default', claude: claudeBin, results }, null, 2) + '\n');
// Arms alternate task by task, so both see the same conditions over time.
for (let run = 1; run <= runs; run++) {
  for (const task of selected) {
    for (const armName of armNames) {
      const nonce = randomBytes(4).toString('hex');
      const dir = join(tmpdir(), 'sleight-bench', stamp, `${armName}-${task.id}-${run}`);
      mkdirSync(dir, { recursive: true });
      const ctx = { dir, nonce };
      task.setup?.(ctx);
      const prompt = task.prompt(ctx);

      if (isDryRun) {
        results.push({ arm: armName, task: task.id, run, prompt, dryRun: true, check: String(task.check({ ...ctx, answer: '' })) });
        continue;
      }

      const started = Date.now();
      const { code, out, stderr } = await runClaude(prompt, ARMS[armName]);
      const answer = out?.result ?? '';
      let verdict;
      try { verdict = task.check({ ...ctx, answer }); } catch (err) { verdict = err.message; }
      results.push({
        arm: armName,
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
      save();
      const r = results.at(-1);
      console.error(`${r.passed ? 'PASS' : 'FAIL'} ${armName} ${task.id} #${run} ${r.seconds}s${r.reason ? ` (${r.reason})` : ''}`);
    }
  }
}

save();

if (!isDryRun) {
  console.log('\n| Arm | Task | Passed | Median s | Median turns | Total cost |');
  console.log('|---|---|---|---|---|---|');
  const median = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : '–'; };
  for (const task of selected) {
    for (const armName of armNames) {
      const rs = results.filter(r => r.task === task.id && r.arm === armName);
      const cost = rs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
      console.log(`| ${armName} | ${task.id} | ${rs.filter(r => r.passed).length}/${rs.length} | ${median(rs.map(r => r.seconds))} | ${median(rs.map(r => r.turns))} | $${cost.toFixed(2)} |`);
    }
  }
}
console.log(`\nresults: ${file}`);
