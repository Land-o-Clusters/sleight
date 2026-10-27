# One-turn mod connection smoke

Sleight-arch runs this after the quiet window, once per A and B checkout. Use this BM2
harness for both, with `SLEIGHT_SMOKE_REPO` naming the product checkout. It checks the
clean arm's launch contract through `sleightPluginLaunch`, the builder used by the
benchmark. It is a connection check, with no speed claim. Keep each checkout's evidence
separate. Do not run it from a headless build lane.

Use the benchmark's pinned Claude Code 2.1.289 executable and a disposable account-login
config. If that config needs authentication, the owner completes the login first. Never
fall back to an API key. The command below creates a fresh config; stop at the login
failure if the host cannot use the account there.

From the BM2 harness checkout (the product checkout defaults to that same directory):

```sh
CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) nice -n 20 node --input-type=module <<'JS'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sleightPluginLaunch } from './bench/sleight-plugin-launch.mjs';
import { sleightInitProblems } from './bench/mcp-catalog.mjs';
import { runOwned } from './bench/preapproved-process.mjs';
const repo = process.env.SLEIGHT_SMOKE_REPO || process.cwd(), dir = mkdtempSync('/private/tmp/bm2-smoke-');
const own = 'plugin:sleight:computer', trace = join(dir, 'relay');
mkdirSync(trace);
const config = { mcpServers: { [own]: {
  command: join(repo, 'plugins/sleight/bin/sleight-mcp'),
  env: { SLEIGHT_TRACE: trace, SLEIGHT_HAND: '0', SLEIGHT_TURBO: '0', SLEIGHT_SURFACES: 'computer' }
} } };
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
  !k.startsWith('ANTHROPIC_') && !k.startsWith('CLAUDE') || k === 'CLAUDE_CONFIG_DIR'));
const plan = sleightPluginLaunch({ mcpConfig: config, env, settingsOverrides: {}, args: [
  '-p', '--model', 'claude-haiku-5-5', '--effort', 'high', '--permission-mode', 'default',
  '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
  '--plugin-dir', join(repo, 'plugins/sleight'), '--setting-sources', '', '--no-chrome',
  '--mcp-config', join(dir, 'mcp.json'), '--settings', join(dir, 'settings.json'),
  '--debug-file', join(dir, 'host.log'), '--tools', '',
  '--allowedTools', 'mcp__plugin_sleight_computer__js,mcp__plugin_sleight_computer__turn_ended'
] });
writeFileSync(join(dir, 'mcp.json'), JSON.stringify(config), { mode: 0o600 });
writeFileSync(join(dir, 'settings.json'), JSON.stringify(plan.settingsOverrides), { mode: 0o600 });
writeFileSync(join(dir, 'args.json'), JSON.stringify(plan.args));
const command = join(homedir(), '.config/sleight-bench/world/arms/sleight/node_modules/.bin/claude');
const prompt = 'Make exactly four separate js calls, each only console.log("BM2-N") with N from 1 to 4 in order. Do not acquire or drive any app. Then reply DONE.';
console.log(dir);
const run = await runOwned(command, [...plan.args, prompt], {
  cwd: dir, env: plan.env, timeoutMs: 120000
});
writeFileSync(join(dir, 'events.jsonl'), run.stdout);
writeFileSync(join(dir, 'stderr.txt'), run.stderr);
const events = run.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const problems = sleightInitProblems(events, config);
console.log({ exit: run.exit, groupClean: run.groupClean, problems });
if (run.exit.code !== 0 || !run.groupClean || problems.length) process.exitCode = 1;
JS
```

Before accepting the smoke, inspect `host.log`, `events.jsonl` and the relay trace:

- The ordinary descriptor path must log `$.mcp.connect (<plugin>): computer: runs as its twin plugin:sleight:computer`.
  A host that takes the fresh connection path must log `computer: connecting` followed by
  `connected after Nms` for that same server. Record which path ran. A twin connection
  need not also print `connected after`.
- Reject a refusal containing `strict`, `connects no plugin servers`, or
  `Your organization's MCP policy does not allow`. Reject `Suppressing plugin MCP server`
  when it points at a different server name. A missing mod connection line also fails.
- Exactly 1 system init event must list `plugin:sleight:computer`, connected, with no other server.
  For a later turbo or combined-arm smoke, use that arm's descriptor and require exactly
  its keys, all connected. The rounds and real gate enforce this after every sleight run.
- Record a process-tree observation during the calls proving exactly 1 sleight-mcp relay
  belongs to this Claude process. The executable can appear as Node running `lib/launch.mjs`.
  An init catalog alone cannot prove the process count. Missing process evidence leaves
  this check unverified.
- Require 4 separate js calls and their 4 markers in order. If PF4 is in the tested
  revision, also require its `sleight_stats_begin` frame and relay `mod-turn-begin` row.
  BM1 alone does not provide that frame. Preserve the exact revision, launch arguments,
  settings, MCP descriptor, logs and process observation with the result.

Older strict-config runs did not exercise the mod connection. Startup probe results
from before BM2 also used different settings sources and MCP mode in the control arms;
do not compare those deltas with the matched BM2 controls.
