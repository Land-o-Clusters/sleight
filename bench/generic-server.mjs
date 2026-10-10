// Invoked through /usr/bin/env -i. Credentials remain in Claude's parent environment.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { constants } from 'node:os';

const { command, args, env } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const child = spawn(command, args, { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(`Generic MCP server could not start (${error.code ?? 'unknown'}).`); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? 128 + (constants.signals[signal] ?? 0); });
