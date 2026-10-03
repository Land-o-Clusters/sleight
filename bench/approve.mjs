#!/usr/bin/env node
// Elicitation hook for benchmark runs only (bench/settings.json). Headless
// `claude -p` can't show sleight's app approval prompts, so this accepts
// them for the benchmark's own apps (BENCH_APPS in tasks.mjs), on either arm's
// server, and nothing else. Any other request falls through to Claude Code's default.
import { BENCH_APPS } from './tasks.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const e = JSON.parse(input);
// BENCH_HOOK_LOG=<file> records each request, for debugging an arm.
if (process.env.BENCH_HOOK_LOG) {
  (await import('node:fs')).appendFileSync(process.env.BENCH_HOOK_LOG, JSON.stringify(e) + '\n');
}
const app = /^Allow Computer Use to use "(.+)"\?$/.exec(e.message ?? '')?.[1];
// The computer-use server of each benchmark arm (see run.mjs).
const SERVERS = ['plugin:sleight:computer', 'lcu'];
if (SERVERS.includes(e.mcp_server_name) && BENCH_APPS.includes(app)) {
  // LCU turns the approval into a form with a required `choice` (once,
  // session, always, decline). Answer "session" where offered, as sleight
  // scopes approvals, else "once". Never "always".
  const choices = e.requested_schema?.properties?.choice?.enum ?? [];
  const content = choices.length ? { choice: choices.includes('session') ? 'session' : 'once' } : {};
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content } }));
}
