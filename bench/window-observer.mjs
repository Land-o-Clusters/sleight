// Research socket server for one persistent read-only AX helper.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export async function startWindowObserver({ timeoutMs = 250, spawnHelper = () => spawn('/usr/bin/osascript',
  ['-l', 'JavaScript', fileURLToPath(new URL('./guard-window-observer.js', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] }) } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sleight-window-'));
  await chmod(directory, 0o700);
  const endpoint = { path: join(directory, 'observer.sock'), token: randomUUID(), timeoutMs };
  let child, stopped, lines, pending, nextId = 0, failed = false, closing;
  const sockets = new Set();
  const fail = () => { failed = true; pending?.finish({ status: 'unavailable' }); pending = undefined; };
  function start() {
    if (child || failed) return;
    child = spawnHelper();
    stopped = new Promise(resolve => child.once('close', resolve));
    child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail);
    child.stderr.resume();
    lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let result;
      try { result = JSON.parse(line); } catch { fail(); return; }
      if (pending && result?.id === pending.id) {
        const reply = pending; pending = undefined; reply.finish(result);
      }
    });
  }
  function query(request) {
    if (failed || closing) return Promise.resolve({ status: 'unavailable' });
    if (pending) return Promise.resolve({ status: 'busy' });
    start();
    const remaining = Math.min(timeoutMs, request.expires - Date.now());
    if (remaining <= 0) return Promise.resolve({ status: 'expired' });
    return new Promise(resolve => {
      const id = nextId++;
      const finish = result => { clearTimeout(timer); resolve(Date.now() >= request.expires ? { status: 'expired' } : result); };
      // Keep the slot occupied after timeout until the exact reply arrives. Do not queue AX work.
      const timer = setTimeout(() => finish({ status: 'expired' }), remaining);
      pending = { id, finish };
      child.stdin.write(JSON.stringify({ id, appId: request.appId, expires: request.expires }) + '\n');
    });
  }
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.setTimeout(timeoutMs + 50, () => socket.destroy());
    let buffer = '', read = false;
    socket.on('data', async chunk => {
      if (read) return;
      buffer += chunk;
      if (buffer.length > 4096) { socket.destroy(); return; }
      const at = buffer.indexOf('\n'); if (at < 0) return;
      read = true;
      let request;
      try { request = JSON.parse(buffer.slice(0, at)); } catch { socket.destroy(); return; }
      if (request.token !== endpoint.token || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(request.appId ?? '') ||
        !Number.isFinite(request.expires) || request.expires > Date.now() + timeoutMs) {
        socket.end(JSON.stringify({ status: 'invalid' }) + '\n'); return;
      }
      try { socket.end(JSON.stringify(await query(request)) + '\n'); }
      catch { fail(); socket.destroy(); }
    });
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint.path, resolve); });
    await chmod(endpoint.path, 0o600);
  } catch (error) { server.close(); await rm(directory, { recursive: true, force: true }); throw error; }
  return { endpoint, close: () => closing ||= (async () => {
    fail(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    if (child) {
      child.stdin.end();
      const gentle = setTimeout(() => child.kill('SIGTERM'), 500);
      const force = setTimeout(() => child.kill('SIGKILL'), 1500);
      try { await stopped; } finally { clearTimeout(gentle); clearTimeout(force); lines.close(); }
    }
    await rm(directory, { recursive: true, force: true });
  })() };
}
