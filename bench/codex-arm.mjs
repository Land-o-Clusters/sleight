// The Codex arm of the head-to-head: native Codex computer use through `codex exec`, from its own
// Codex home (~/.codex-bench) with only the engine server configured, so the owner's AGENTS.md,
// memories, plugins and hooks stay out. Research: .dev/research/2026-10-08-codex-head-to-head.md.

import { runOwned } from './preapproved-process.mjs';
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CODEX_HOME = process.env.CODEX_BENCH_HOME || join(homedir(), '.codex-bench');

export function codexReady() {
  return existsSync(join(CODEX_HOME, 'auth.json')) ||
    `no Codex login in ${CODEX_HOME}: run CODEX_HOME=${CODEX_HOME} codex login`;
}

// The [mcp_servers.<name>] tables in the bench Codex home's config. A clean-arm pass publishes
// this list to confirm the home configures only the engine server, so the owner's MCP servers
// stay out of the comparison.
export function codexConfigServers(home = CODEX_HOME) {
  const text = readFileSync(join(home, 'config.toml'), 'utf8');
  return [...text.matchAll(/^\[mcp_servers\.([^\].]+)\]/gm)].map(match => match[1]);
}

// Headless Codex cancels the engine's app prompts, so apps are approved only through the engine's
// own "Always allow" list (the owner allowed setting it to the benchmark apps, 2026-10-08). The
// runner saves the list first and puts it back on exit; both arms see the same list.
const APPROVALS = join(homedir(), 'Library', 'Group Containers', '2DC432GLL2.com.openai.sky.CUAService',
  'Library', 'Application Support', 'Software', 'ComputerUseAppApprovals.json');

export function approveOnly(bundleIds, backupPath) {
  const had = existsSync(APPROVALS);
  if (had) copyFileSync(APPROVALS, backupPath);
  writeFileSync(APPROVALS, JSON.stringify({ approvedBundleIdentifiers: bundleIds }));
  return () => {
    if (had) copyFileSync(backupPath, APPROVALS);
    else writeFileSync(APPROVALS, JSON.stringify({ approvedBundleIdentifiers: [] }));
  };
}

// The rollout Codex writes for a thread: one token_count event per model response, which is the
// counterpart of Claude Code's num_turns, and one turn_context per turn, which names the model Codex actually ran.
function rolloutLines(threadId, home = CODEX_HOME) {
  const walk = dir => readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : name.includes(threadId) ? [path] : [];
  });
  const sessions = join(home, 'sessions');
  const file = existsSync(sessions) && walk(sessions)[0];
  return file ? readFileSync(file, 'utf8').split('\n') : undefined;
}
// What the rollout says ran, not what was asked for: the model ids and efforts from its turn_context events, and the CLI
// version from its session_meta (cli_version, which `codex exec` 0.160.0 writes). Empty or undefined when the rollout has none.
export function rolloutFacts(lines) {
  const models = new Set(), efforts = new Set();
  let cliVersion, requests = 0;
  for (const line of lines ?? []) {
    if (line.includes('"token_count"')) requests++;
    if (!line.includes('"turn_context"') && !line.includes('"session_meta"')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; } // a cut line
    const payload = event.payload ?? {};
    if (event.type === 'session_meta' && typeof payload.cli_version === 'string') cliVersion ??= payload.cli_version;
    if (event.type !== 'turn_context') continue;
    if (typeof payload.model === 'string' && payload.model) models.add(payload.model);
    if (typeof payload.effort === 'string' && payload.effort) efforts.add(payload.effort);
  }
  return { models: [...models], efforts: [...efforts], cliVersion, requests };
}
export const modelsRan = lines => rolloutFacts(lines).models;

// Finds a numeric key anywhere in a tool result, such as the engine's own execution time.
function findNumber(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  if (typeof value[key] === 'number') return value[key];
  for (const child of Object.values(value)) {
    const found = findNumber(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

// The process group is owned (runOwned): an abort or the timeout stops Codex and the engine server
// it started, and the result says whether the whole group is gone, as the real suite requires.
export function codexExecPlan(prompt, { cwd, model, effort }) {
  return ['exec', '--json', '-s', 'read-only', '--disable', 'shell_tool', '-m', model,
    '-c', `model_reasoning_effort="${effort}"`, '--skip-git-repo-check', '-C', cwd, prompt];
}

export async function runCodex(prompt, { cwd, model, effort, timeoutMs, signal, onSpawn, auditDrag = false, home = CODEX_HOME, onEvent, command = 'codex', env = {} }) {
  // No shell and a read-only sandbox: the checks read files and a form server, so a shell could
  // pass them without touching the apps. The Claude arm has no Bash either.
  const args = codexExecPlan(prompt, { cwd, model, effort });
  let buffer = '', threadId, answer = '', usage, toolCalls = 0, engineMs = 0;
  const forbidden = [], toolServers = {};
  const onStdout = chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      onEvent?.(event);
      if (event.type === 'thread.started') threadId = event.thread_id;
      if (event.type === 'turn.completed') usage = event.usage;
      if (event.type !== 'item.completed') continue;
      const item = event.item ?? {};
      if (item.type === 'agent_message') answer = item.text ?? answer;
      if (item.type === 'mcp_tool_call') {
        toolCalls++; engineMs += findNumber(item, 'codex/nodeReplExecutionDurationMs') ?? 0;
        // Which MCP server each call went to: an isolated home shows only its own.
        if (typeof item.server === 'string') toolServers[item.server] = (toolServers[item.server] ?? 0) + 1;
      }
      if (['command_execution', 'file_change'].includes(item.type)) forbidden.push(item.type);
    }
  };
  const run = await runOwned(command, args, { cwd, env: { ...process.env, ...env, CODEX_HOME: home }, timeoutMs, signal, onStdout, onSpawn });
  const lines = threadId ? rolloutLines(threadId, home) : undefined;
  const facts = rolloutFacts(lines), ran = facts.models;
  return {
    code: run.exit.code ?? (run.spawnError ? 127 : 1), stderr: (run.spawnError ?? run.stderr).slice(-2000), forbidden,
    groupClean: run.groupClean, cancelled: run.cancelled, timedOut: run.timedOut,
    agentSeconds: run.agentSeconds, agentTiming: run.agentTiming, stamps: run.stamps,
    // Shaped like Claude Code's JSON result, so the runner records both arms the same way.
    out: { result: answer, num_turns: lines ? facts.requests : undefined,
      usage: usage && { input_tokens: usage.input_tokens, cache_read_input_tokens: usage.cached_input_tokens,
        cache_creation_input_tokens: usage.cache_write_input_tokens, output_tokens: usage.output_tokens },
      // The ids Codex ran when its rollout names them, else the one asked for.
      modelUsage: Object.fromEntries((ran.length ? ran : [model]).map(id => [id, {}])) },
    modelRequested: model, modelsRan: ran, effortRequested: effort, effortsRan: facts.efforts, codexCliVersion: facts.cliVersion ?? null,
    toolCalls, toolServers, engineMs,
    ...(auditDrag && { methodAudit: (await import('./world/method-check.mjs')).dragMethodAudit(run.stdout) }),
  };
}
