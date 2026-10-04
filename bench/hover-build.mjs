// Build before taking the live lock. This script owns its compiler child.
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
await mkdir('bench/results/hover-fixture-cache', { recursive: true });
const child = spawn('/usr/bin/swiftc', ['-module-cache-path', 'bench/results/hover-fixture-cache',
  'bench/hover-window-fixture.swift', '-o', 'bench/results/hover-window-fixture'], { stdio: 'inherit' });
process.once('SIGINT', () => child.kill('SIGINT'));
process.once('SIGTERM', () => child.kill('SIGTERM'));
child.once('error', err => { console.error(err.message); process.exitCode = 1; });
child.once('close', code => { process.exitCode = code ?? 1; });
