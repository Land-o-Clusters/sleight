// Replay a synthetic JSONL recording without starting sleight or an app.
import net from 'node:net';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultDirectory, isMain } from './listen.mjs';

export async function discoverSockets(dir = defaultDirectory(), { platform = process.platform, windows } = {}) {
  if (platform === 'win32') {
    windows ??= (await import('../../plugins/sleight/lib/hand/windows-transport.mjs')).createWindowsTransport();
    return (await windows.discover()).map(e => e.path);
  }
  try {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o700) return [];
    const paths = [];
    for (const name of (await readdir(dir)).sort()) {
      if (!name.endsWith('.sock')) continue;
      const path = join(dir, name);
      const stat = await lstat(path).catch(() => null);
      if (stat?.isSocket() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o7777) === 0o600) paths.push(path);
    }
    return paths;
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function connect(path, network, validate = async () => true, timeoutMs = 1000) {
  return new Promise(resolve => {
    const socket = network.createConnection(path);
    // Dead or unresponsive renderers cannot hold the replay open.
    const timeout = setTimeout(() => socket.destroy(), timeoutMs);
    socket.on('error', () => {});
    socket.on('data', () => {}); // The protocol has no reply channel.
    socket.once('connect', async () => {
      try { if (!await validate() || socket.destroyed) return socket.destroy(); }
      catch { socket.destroy(); return; }
      clearTimeout(timeout); resolve(socket);
    });
    socket.once('close', () => { clearTimeout(timeout); resolve(null); });
  });
}

async function write(socket, line) {
  if (socket.destroyed) return;
  await new Promise(resolve => {
    const timeout = setTimeout(() => socket.destroy(), 1000);
    const done = () => { clearTimeout(timeout); socket.off('close', done); resolve(); };
    socket.once('close', done);
    socket.write(line + '\n', done);
  });
}

export async function replayFile({ file, dir = defaultDirectory(), speed = 1, sleep = delay, platform = process.platform, windows, net: network = net }) {
  if (!Number.isFinite(speed) || speed <= 0) throw new Error('Replay speed must be a positive number');
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/).filter(line => line.trim());
  // Validate all timestamps before connecting or sending any data.
  const records = lines.map((line, i) => {
    const event = JSON.parse(line);
    if (!Number.isFinite(event.ts)) throw new Error(`Missing timestamp on line ${i + 1}`);
    return { line, ts: event.ts };
  });
  let entries;
  if (platform === 'win32') {
    windows ??= (await import('../../plugins/sleight/lib/hand/windows-transport.mjs')).createWindowsTransport();
    entries = await windows.discover();
  } else entries = (await discoverSockets(dir)).map(path => ({ path }));
  const sockets = (await Promise.all(entries.map(entry => connect(entry.path, network,
    platform === 'win32' ? () => windows.validate(entry) : undefined, platform === 'win32' ? 5000 : 1000)))).filter(Boolean);
  try {
    for (let i = 0; i < records.length; i++) {
      if (i) {
        const gap = Math.max(0, records[i].ts - records[i - 1].ts) / speed;
        if (gap) await sleep(gap);
      }
      await Promise.all(sockets.map(socket => write(socket, records[i].line)));
    }
  } finally {
    await Promise.all(sockets.map(socket => new Promise(resolve => {
      if (socket.destroyed) return resolve();
      const timeout = setTimeout(() => socket.destroy(), 1000);
      socket.once('close', () => { clearTimeout(timeout); resolve(); });
      socket.end();
    })));
  }
  return { events: records.length, renderers: sockets.length };
}

if (isMain(import.meta.url)) {
  try {
    const [file, flag, speed, ...rest] = process.argv.slice(2);
    if (!file || rest.length || (flag !== undefined && (flag !== '--speed' || speed === undefined))) {
      throw new Error('Usage: node replay.mjs FILE.jsonl [--speed 4]');
    }
    const result = await replayFile({ file, speed: speed === undefined ? 1 : Number(speed) });
    console.error(`Replayed ${result.events} events to ${result.renderers} renderers`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
