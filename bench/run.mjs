#!/usr/bin/env node
// Runs the sleight benchmark: each task through headless `claude -p` with the
// plugin loaded, checked outside the agent. Writes bench/results/<stamp>.json
// and prints a table.
//
//   node bench/run.mjs [--arm sleight|lcu|codex|all|a,b] [--suite default|real] [--tasks id,id] [--runs N] [--model M] [--effort E]
//     [--codex-model M] [--codex-effort E] [--dry-run]
//
// Model and effort default to Sonnet 5.5 at medium (owner, 2026-10-03). Runs
// before that used Claude Code's default, Opus 5.5.
//
// Arms: `sleight` loads this repo's plugin. `lcu` runs from a folder where LCU
// (github.com/amontlabs/lcu) was registered for Claude Code at project scope:
//   lcu setup --agent claude-code --scope project --project <dir> --no-chrome --no-audio --yes
// The folder is LCU_ARM_DIR (default ~/Library/Caches/sleight-bench/lcu-arm), and LCU needs Python 3.12+
// first on PATH (LCU_PATH_PREFIX, default .dev/py). BENCH_ROOT tells the
// approval hook where this repo is, since an arm may run from another folder.
//
// A live run AUTO-APPROVES BENCH_APPS for either arm (approve.mjs), because -p
// can't show approval prompts. Run it only when you're fine with Claude
// driving the selected task's apps unattended. --dry-run sets up and checks
// tasks without a model call. Every run first checks that each arm loads its
// own tool and not the other's.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENCH_APPS, closeBenchTextEdit, quitChess, quitSimApp, getTasks } from './tasks.mjs';
import { approveOnly, codexReady, runCodex } from './codex-arm.mjs';
import { watchAppWindows } from './app-windows.mjs';
import { runTiming, traceTiming } from './timing.mjs';
import { executeRealTask } from './real-run.mjs';
import { observePermission } from './real-permission.mjs';
import { runOwned } from './preapproved-process.mjs';
import { acquireLiveLock } from './live-lock.mjs';
import { runDriver } from './driver.mjs';
import { benchmarkArm } from './arm-env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 5 * 60 * 1000;

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
// The git repo a folder belongs to, if any.
function gitRoot(dir) {
  try { return execFileSync('/usr/bin/git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return undefined; }
}
const isDryRun = process.argv.includes('--dry-run');
const suite = option('suite', 'default');
const suiteTasks = getTasks(suite);
const controller = new AbortController();
process.on('SIGINT', () => controller.abort(new Error('run interrupted')));
process.on('SIGTERM', () => controller.abort(new Error('run interrupted')));
const armOption = option('arm', 'sleight');
const ARM_HOME = join(homedir(), 'Library', 'Caches', 'sleight-bench');
const ARMS = {
  // Each arm runs from its own empty folder outside any git repo, so neither
  // gets this repo's CLAUDE.md or project memory. Until 2026-10-03 the sleight
  // arm ran here, and until 2026-10-05 in .dev/, which is still inside the repo:
  // Claude Code loads CLAUDE.md from parent folders and keys project memory by
  // the git root, so both arms got them.
  sleight: {
    cwd: (() => {
      const dir = process.env.SLEIGHT_ARM_DIR || join(ARM_HOME, 'sleight-arm');
      if (suite === 'default') mkdirSync(dir, { recursive: true });
      return dir;
    })(),
    args: ['--plugin-dir', join(ROOT, 'plugins', 'sleight'), // Every sleight tool, as a user who approves its prompts would have. Without
    // them Claude lost 8 turns to refused select_window and menu_bar calls (2026-10-07).
    '--allowedTools', ['js', 'js_reset', 'drag', 'hover', 'menu_bar', 'notifications', 'select_window', 'blocked_app'].map(t => `mcp__plugin_sleight_computer__${t}`).join(',')],
    env: {},
    server: 'plugin:sleight:computer',
  },
  // Native Codex computer use, for the head-to-head (owner, 2026-10-08). See codex-arm.mjs.
  codex: {
    cwd: (() => { const dir = join(ARM_HOME, 'codex-arm'); mkdirSync(dir, { recursive: true }); return dir; })(),
    codex: true,
    check: codexReady,
  },
  lcu: (() => {
    const dir = process.env.LCU_ARM_DIR || join(ARM_HOME, 'lcu-arm');
    const prefix = process.env.LCU_PATH_PREFIX || join(ROOT, '.dev', 'py');
    return {
      cwd: dir,
      args: ['--mcp-config', join(dir, '.mcp.json'), '--allowedTools', 'mcp__lcu__js'],
      env: { PATH: `${prefix}:${process.env.PATH}` },
      server: 'lcu',
      check: () => existsSync(join(dir, '.mcp.json')) || `no LCU registration in ${dir}`,
    };
  })(),
};
const armNames = armOption === 'all' ? ['sleight', 'lcu'] : armOption.split(',');
for (const name of armNames) {
  if (!ARMS[name]) throw new Error(`unknown arm ${name}`);
  const ok = ARMS[name].check?.() ?? true;
  if (ok !== true) throw new Error(ok);
  const repo = gitRoot(ARMS[name].cwd);
  if (repo) throw new Error(`${name} arm folder ${ARMS[name].cwd} is inside the git repo ${repo}, so its runs would load that repo's CLAUDE.md and project memory. Use a folder outside any repo.`);
}
const runs = Number(option('runs', '1'));
const model = option('model', 'claude-sonnet-5-5');
const effort = option('effort', 'medium');
const codexModel = option('codex-model', 'gpt-6.1-sol');
const codexEffort = option('codex-effort', effort);
const wanted = option('tasks', undefined)?.split(',');
const claudeBin = process.env.CLAUDE_BIN || 'claude';
const selected = wanted ? suiteTasks.filter(t => wanted.includes(t.id)) : suiteTasks;
if (!selected.length) throw new Error(`no tasks match ${wanted}`);
if (wanted?.some(id => !suiteTasks.some(task => task.id === id))) throw new Error('unknown task in selected suite');

// SLEIGHT_APPROVAL_PROMPT=client keeps approvals going to approve.mjs, even
// when the benchmark runs from a desktop app session.
const armEnv = (arm, extra = {}) => benchmarkArm(suite, arm, { root: ROOT, extra }).env;

// The MCP servers an arm's Claude Code starts, read from its init event and
// stopped before any model call.
function armServers(arm) {
  const args = ['-p', 'hi', '--output-format', 'stream-json', '--verbose', ...arm.args, '--settings', join(ROOT, 'bench', 'settings.json')];
  {
    const initialized = new AbortController();
    let buffer = '', servers;
    return runOwned(claudeBin, args, { cwd: arm.cwd, env: armEnv(arm), timeoutMs: 60000,
      signal: AbortSignal.any([initialized.signal, controller.signal]),
      onStdout: data => {
        buffer += data;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (event.type === 'system' && event.subtype === 'init') { servers = event.mcp_servers; initialized.abort(); }
        }
      },
    }).then(result => {
      if (!result.groupClean) throw new Error('Arm preflight process group cleanup unconfirmed');
      if (!servers) throw new Error('Arm preflight returned no init event');
      controller.signal.throwIfAborted();
      return servers;
    });
  }
}

// Each arm must have its own tool connected and not the other's. A user-level
// install of either would otherwise leak into both arms (it did, 2026-10-03,
// until settings.json turned off the installed sleight).
const otherServers = Object.values(ARMS).map(a => a.server).filter(Boolean);
for (const name of armNames.filter(n => !ARMS[n].codex)) {
  const arm = ARMS[name];
  const servers = await armServers(arm);
  const own = servers.find(s => s.name === arm.server);
  if (own?.status !== 'connected') throw new Error(`${name} arm: ${arm.server} is ${own?.status ?? 'missing'}`);
  const leaked = servers.filter(s => s.name !== arm.server && otherServers.includes(s.name));
  if (leaked.length) throw new Error(`${name} arm also loads ${leaked.map(s => s.name).join(', ')}`);
}

// Keyboard filter taps held by benchmark apps after a run's cleanup. Device Hub kept one after the
// simulator runs and every key on the Mac stalled (2026-10-09), so a pass stops on any.
const TAPS_BIN = join(ARM_HOME, 'keyboard-taps');
function benchKeyboardTaps() {
  try {
    if (!existsSync(TAPS_BIN)) execFileSync('swiftc', ['-O', join(ROOT, 'bench', 'keyboard-taps.swift'), '-o', TAPS_BIN], { stdio: 'ignore', timeout: 180000 });
    const names = new Set(['Calculator', 'TextEdit', 'Chess', 'Simulator', 'DeviceHub', 'Device Hub']);
    return JSON.parse(execFileSync(TAPS_BIN, { encoding: 'utf8', timeout: 10000 })).filter(t => names.has(t.app));
  } catch (err) { return [{ app: 'unknown', error: `keyboard tap check failed: ${err.message}` }]; }
}

// Tools that act outside the app. A user's own settings can allow them (the owner's allow Bash(*)),
// and with them a run could pass a check without touching the app: no run did, in 716 transcripts
// checked on 2026-10-09, but Claude opened task files with `open` from Bash, which the Codex arm
// (no shell) can't. Every Claude arm runs without them.
const OUTSIDE_TOOLS = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'];

function runClaude(prompt, arm, env = {}, { signal, evidenceDir, onPermissionRefusal } = {}) {
  const args = [
    '-p', prompt,
    ...arm.args,
    '--disallowedTools', OUTSIDE_TOOLS.join(','),
    '--settings', join(ROOT, 'bench', 'settings.json'),
    '--output-format', suite === 'real' ? 'stream-json' : 'json',
    ...(suite === 'real' ? ['--verbose'] : []),
    '--model', model,
    '--effort', effort,
  ];
  return runDriver(claudeBin, args, { cwd: arm.cwd, env: armEnv(arm, env), timeoutMs: TIMEOUT_MS,
    signal: signal ?? controller.signal, evidenceDir, onPermissionRefusal, format: suite === 'real' ? 'stream-json' : 'json' });
}

// Window titles can carry the user's name (Chess: "Game 1 | Name - Computer"),
// and Claude quotes them. Results are published, so answers lose it.
const fullName = (() => { try { return execFileSync('id', ['-F'], { encoding: 'utf8' }).trim(); } catch { return ''; } })();
const scrub = text => {
  if (typeof text !== 'string') return text;
  if (suite === 'real') text = text.replaceAll(homedir(), '~').replaceAll(realpathSync(tmpdir()), '<temp>').replaceAll(tmpdir(), '<temp>');
  return fullName.length > 2 ? text.split(fullName).join('<user>') : text;
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const results = [];
const resultsDir = join(ROOT, 'bench', 'results');
mkdirSync(resultsDir, { recursive: true });
const file = join(resultsDir, `${stamp}${isDryRun ? '-dry' : ''}.json`);
// Written after every run, so a run cut short keeps what it finished.
const save = () => {
  const json = JSON.stringify({ stamp, ...benchmarkArm(suite, ARMS.sleight, { root: ROOT }).resultMetadata,
    arms: armNames, model, effort, claude: claudeBin, results }, null, 2);
  writeFileSync(file, (suite === 'real' ? scrub(json) : json) + '\n');
};
// The runner owns the pass lock. Real tasks reuse it, so they cannot wait on
// themselves. This extends main's pass lock through driver collection.
let unlock, lockIdentity;
if (!isDryRun) {
  save();
  console.error('Waiting for /tmp/sleight-live.lock if another live run holds it.');
  unlock = await acquireLiveLock(undefined, { wait: true, signal: controller.signal, interval: 2000 });
  lockIdentity = statSync('/tmp/sleight-live.lock');
  // Codex can't answer app prompts headless, so the engine's "Always allow" list holds exactly the
  // benchmark apps for the pass, then goes back to what it was (exit handler below).
  if (armNames.some(n => ARMS[n].codex)) {
    const backup = join(homedir(), 'Library', 'Logs', 'sleight', `ComputerUseAppApprovals.before-${stamp}.json`);
    mkdirSync(dirname(backup), { recursive: true });
    const restore = approveOnly(BENCH_APPS.filter(a => /^com\./.test(a)), backup);
    process.once('exit', () => { try { restore(); } catch (err) { console.error(`Restore the app approvals from ${backup}: ${err.message}`); } });
    console.error(`App approvals set to the benchmark apps; saved the previous list to ${backup}.`);
  }
  process.once('exit', () => {
    if (!unlock) return;
    try {
      const current = statSync('/tmp/sleight-live.lock');
      if (current.dev === lockIdentity.dev && current.ino === lockIdentity.ino) rmdirSync('/tmp/sleight-live.lock');
    } catch {}
  });
}
// Arms alternate task by task, so both see the same conditions over time.
pass: for (let run = 1; run <= runs; run++) {
  for (const task of selected) {
    for (const armName of armNames) {
      if (controller.signal.aborted) break pass;
      const nonce = randomBytes(4).toString('hex');
      const dir = join(suite === 'real' ? realpathSync(tmpdir()) : tmpdir(), 'sleight-bench', stamp, `${armName}-${task.id}-${run}`);
      mkdirSync(dir, { recursive: true });
      const ctx = { dir, nonce };
      if (suite === 'real') {
        const evidenceDir = join(tmpdir(), 'sleight-real-evidence', stamp, `${armName}-${task.id}-${run}`);
        mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
        const result = await executeRealTask(task, ctx, { dryRun: isDryRun, signal: controller.signal,
          lockHeld: !isDryRun,
          stop: () => controller.abort(new Error('macOS permission prompt')),
          permissionCheck: observePermission,
          drive: async (prompt, _ctx, callbacks) => {
            const response = await runClaude(prompt, ARMS[armName], armName === 'sleight' ? { SLEIGHT_TRACE: evidenceDir } : {},
              { signal: controller.signal, evidenceDir, ...callbacks });
            response.timing = runTiming(response.out, armName === 'sleight' ? traceTiming(evidenceDir) : undefined);
            return response;
          },
        });
        const { out, code, ...rest } = result;
        results.push({ arm: armName, task: task.id, run, ...rest,
          reason: scrub(result.reason), cleanupError: scrub(result.cleanupError), prompt: scrub(result.prompt),
          turns: out?.num_turns, costUsd: out?.total_cost_usd, models: Object.keys(out?.modelUsage ?? {}),
          usage: out?.usage && { input: out.usage.input_tokens, cacheRead: out.usage.cache_read_input_tokens,
            cacheWrite: out.usage.cache_creation_input_tokens, output: out.usage.output_tokens },
          exitCode: code, answer: scrub(out?.result?.slice(0, 300)), stderr: code === 0 ? undefined : scrub(rest.stderr),
        });
        save();
        console.error(`${result.passed ? 'PASS' : isDryRun ? 'DRY' : 'FAIL'} ${armName} ${task.id} #${run} ${result.seconds ?? 0}s${result.reason ? ` (${scrub(result.reason)})` : ''}`);
        if (result.cleanupError || result.permissionPrompt || result.permissionRefusal || result.observerError) {
          console.error(`STOP: ${scrub(result.cleanupError ?? result.reason ?? 'permission stop')}`);
          controller.abort(new Error('live safety stop'));
          process.exitCode = 1;
        }
        if (!result.passed && !isDryRun) process.exitCode = 1;
        continue;
      }
      // A setup this Mac can't do (no iOS runtime for the simulator task) skips
      // the run rather than ending the pass; skipped runs stay out of the table.
      try { await task.setup?.(ctx); } catch (err) {
        results.push({ arm: armName, task: task.id, run, skipped: true, reason: `setup: ${err.message}` });
        save();
        console.error(`SKIP ${armName} ${task.id} #${run} (setup: ${err.message})`);
        continue;
      }
      const prompt = task.prompt(ctx);

      if (isDryRun) {
        results.push({ arm: armName, task: task.id, run, prompt, dryRun: true, check: String(task.check({ ...ctx, answer: '' })) });
        continue;
      }

      const started = Date.now();
      const stopWatching = watchAppWindows(ctx.sim?.app ?? task.app);
      // sleight traces into the run's scratch folder, so its timing comes from this run alone.
      const arm = ARMS[armName];
      const codexRun = arm.codex ? await runCodex(prompt, { cwd: arm.cwd, model: codexModel, effort: codexEffort, timeoutMs: TIMEOUT_MS }) : undefined;
      const { code, out, stderr, groupClean = true, cancelled } = codexRun ?? await runClaude(prompt, arm, armName === 'sleight' ? { SLEIGHT_TRACE: dir } : {});
      const appWindows = await stopWatching();
      const answer = out?.result ?? '';
      let verdict;
      try { verdict = groupClean ? task.check({ ...ctx, answer }) : 'Driver process group cleanup unconfirmed'; } catch (err) { verdict = err.message; }
      // A shell or file edit could pass a check without the app, so it fails the run.
      if (codexRun?.forbidden.length) verdict = `used ${[...new Set(codexRun.forbidden)].join(' and ')}`;
      if (groupClean) try { await task.cleanup?.(ctx); } catch {} // leaving an app open doesn't change the verdict
      else { controller.abort(new Error('Driver cleanup unconfirmed')); process.exitCode = 1; }
      const heldTaps = isDryRun ? [] : benchKeyboardTaps();
      results.push({
        arm: armName,
        task: task.id,
        run,
        passed: verdict === true,
        reason: verdict === true ? undefined : scrub(verdict),
        seconds: Math.round((Date.now() - started) / 100) / 10,
        turns: out?.num_turns,
        costUsd: out?.total_cost_usd,
        // Input, cached and output tokens: what a smaller result would save.
        usage: out?.usage && { input: out.usage.input_tokens, cacheRead: out.usage.cache_read_input_tokens,
          cacheWrite: out.usage.cache_creation_input_tokens, output: out.usage.output_tokens },
        timing: runTiming(out, armName === 'sleight' ? traceTiming(dir) : undefined),
        // Samples every 5 s of the app's windows: on the current Space, only off it, or none.
        appWindows,
        exitCode: code,
        groupClean, cancelled,
        answer: scrub(answer.slice(0, 300)),
        // What Claude Code reports it used, to catch a model setting that didn't apply.
        models: Object.keys(out?.modelUsage ?? {}),
        ...(codexRun && { toolCalls: codexRun.toolCalls, engineMs: codexRun.engineMs }),
        ...(heldTaps.length && { keyboardTaps: heldTaps }),
        stderr: code === 0 ? undefined : scrub(stderr),
      });
      save();
      const r = results.at(-1);
      console.error(`${r.passed ? 'PASS' : 'FAIL'} ${armName} ${task.id} #${run} ${r.seconds}s${r.reason ? ` (${r.reason})` : ''}`);
      if (heldTaps.length) {
        quitSimApp(); quitChess();
        console.error(`STOP: ${heldTaps.map(t => t.app).join(', ')} still holds a keyboard event tap after cleanup, which can stall every key on the Mac. The pass stopped.`);
        process.exitCode = 1; break pass;
      }
    }
  }
}

save();

// Leave the desktop as we found it: close the TextEdit documents the runs
// made (under the scratch folder, or untitled ones this pass opened) and quit Chess cleanly.
if (!isDryRun) {
  closeBenchTextEdit();
  quitChess();
  quitSimApp();
}
await unlock?.();
unlock = undefined;
if (controller.signal.aborted && !process.exitCode) process.exitCode = 130;

if (!isDryRun) {
  console.log('\n| Arm | Task | Passed | Median s | Model s | Engine s | Local tools s | Relay ms | Median turns | API-price cost |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  const median = xs => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : '–'; };
  for (const task of selected) {
    for (const armName of armNames) {
      const rs = results.filter(r => r.task === task.id && r.arm === armName && !r.skipped);
      const cost = rs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
      const ms = (key, scale) => { const m = median(rs.map(r => r.timing?.[key])); return m === '–' ? m : Math.round(m / scale * 10) / 10; };
      console.log(`| ${armName} | ${task.id} | ${rs.filter(r => r.passed).length}/${rs.length} | ${median(rs.map(r => r.seconds))} | ${ms('modelMs', 1000)} | ${ms('engineMs', 1000)} | ${ms('localMs', 1000)} | ${ms('relayMs', 1)} | ${median(rs.map(r => r.turns))} | $${cost.toFixed(2)} |`);
    }
  }
}
console.log(`\nresults: ${file}`);
