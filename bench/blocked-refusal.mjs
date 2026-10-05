#!/usr/bin/env node
// Captures the engine's refusal for the apps it blocks, verbatim. The helper
// refuses these before any approval prompt, so this asks the user nothing and
// drives nothing: it is one getApp call per app that comes back as an error.
// Run it under the shared live lock (bench/live-lock.sh). Prints one JSON line
// per app: { app, error, raw }.
import { spawn } from 'node:child_process';
import { resolveServer } from '../plugins/sleight/lib/launch.mjs';

const apps = process.argv.slice(2);
if (!apps.length) {
  console.error('usage: node bench/blocked-refusal.mjs <app> [more apps]');
  process.exit(2);
}
const s = resolveServer();
if (s.error) { console.error(s.error); process.exit(1); }

const child = spawn(s.command, s.args, { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...s.env } });
let nextId = 0;
const pending = new Map();
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', chunk => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  }
});
function request(method, params) {
  const id = `probe-${nextId++}`;
  return new Promise(resolve => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const init = await request('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'sleight-refusal-probe', version: '0.0.0' },
});
console.log(JSON.stringify({ serverInfo: init.result?.serverInfo }));
await request('notifications/initialized', {});
for (const app of apps) {
  const reply = await request('tools/call', { name: 'js', arguments: { code: `await cua.getApp(${JSON.stringify(app)})` } });
  console.log(JSON.stringify({ app, ...(reply.error ? { error: reply.error } : { result: reply.result }) }));
}
child.kill('SIGTERM');
