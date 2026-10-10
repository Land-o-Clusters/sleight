#!/usr/bin/env node
// Elicitation hook for benchmark runs only (bench/settings.json). Headless
// `claude -p` can't show sleight's app approval prompts, so this accepts
// them for the benchmark's own apps (BENCH_APPS in tasks.mjs), on either arm's
// server, and nothing else. Any other request falls through to Claude Code's default.
import { BENCH_APPS, REAL_APPS } from './tasks.mjs';
import { writeFileSync } from 'node:fs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const e = JSON.parse(input);
// BENCH_HOOK_LOG=<file> records each request, for debugging an arm.
if (process.env.BENCH_HOOK_LOG) {
  (await import('node:fs')).appendFileSync(process.env.BENCH_HOOK_LOG, JSON.stringify(e) + '\n');
}
// The engine asks 'Allow Computer Use to use "App"?'; local pointer tools ask
// 'Allow Claude to drag/hover in App? …'.
const app = /^Allow Computer Use to use "(.+)"\?$/.exec(e.message ?? '')?.[1] ??
  /^Allow Claude to (?:drag|hover|open files) in (.+?)\? /.exec(e.message ?? '')?.[1] ??
  /^Allow Claude to use (.+)'s menu bar item\?$/.exec(e.message ?? '')?.[1] ??
  /^Allow Claude to select a window in (.+?)\? /.exec(e.message ?? '')?.[1];
// The computer-use server of each benchmark arm (see run.mjs).
const generic = Boolean(process.env.BENCH_ARM_SERVERS);
const SERVERS = generic ? JSON.parse(process.env.BENCH_ARM_SERVERS) : ['plugin:sleight:computer', 'lcu'];
const apps = [...BENCH_APPS, ...(process.env.BENCH_SUITE === 'real' ? REAL_APPS : [])];
const choices = e.requested_schema?.properties?.choice?.enum ?? [];
const supported = (!choices.length || choices.includes('session') || choices.includes('once')) &&
  (!generic || (e.requested_schema?.required ?? []).every(key => key === 'choice' && choices.length));
if (SERVERS.includes(e.mcp_server_name) && apps.includes(app) && supported && e.mode !== 'url') {
  // LCU turns the approval into a form with a required `choice` (once,
  // session, always, decline). Answer "session" where offered, as sleight
  // scopes approvals, else "once". Never "always".
  const content = choices.length ? { choice: choices.includes('session') ? 'session' : 'once' } : {};
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content } }));
} else if (generic) {
  if (process.env.BENCH_APPROVAL_STOP) writeFileSync(process.env.BENCH_APPROVAL_STOP,
    'unsupported approval: elicitation is outside the benchmark app allowlist or uses an unsupported form\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Elicitation', action: 'decline' } }));
}
