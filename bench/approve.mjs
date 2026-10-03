#!/usr/bin/env node
// Elicitation hook for benchmark runs only (bench/settings.json). Headless
// `claude -p` can't show undertow's app approval prompts, so this accepts
// them for the benchmark's own apps (BENCH_APPS in tasks.mjs) and nothing
// else. Any other request falls through to Claude Code's default.
import { BENCH_APPS } from './tasks.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const e = JSON.parse(input);
const app = /^Allow Computer Use to use "(.+)"\?$/.exec(e.message ?? '')?.[1];
if (e.mcp_server_name === 'plugin:undertow:computer' && BENCH_APPS.includes(app)) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'Elicitation', action: 'accept', content: {} } }));
}
