// Replay a synthetic JSONL recording without starting sleight or an app.
import net from 'node:net';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultDirectory } from './listen.mjs';

export async function discoverSockets(dir = defaultDirectory()) {
  try {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) return [];
    const paths = [];
    for (const name of (await readdir(dir)).sort()) {
      if (!name.endsWith('.sock')) continue;
      const path = join(dir, name);
      const stat = await lstat(path).catch(() => null);
      if (stat?.isSocket() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600) paths.push(path);
    }
    return paths;
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function connect(path) {
  return new Promise(resolve => {
    const socket = net.createConnection(path);
    // Dead or unresponsive renderers cannot hold the replay open.
    const timeout = setTimeout(() => socket.destroy(), 1000);
    socket.on('error', () => {});
    socket.on('data', () => {}); // The protocol has no reply channel.
    socket.once('connect', () => { clearTimeout(timeout); resolve(socket); });
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

export async function replayFile({ file, dir = defaultDirectory(), speed = 1, sleep = delay }) {
  if (!Number.isFinite(speed) || speed <= 0) throw new Error('Replay speed must be a positive number');
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/).filter(line => line.trim());
  // Validate all timestamps before connecting or sending any data.
  const records = lines.map((line, i) => {
    const event = JSON.parse(line);
    if (!Number.isFinite(event.ts)) throw new Error(`Missing timestamp on line ${i + 1}`);
    return { line, ts: event.ts };
  });
  const sockets = (await Promise.all((await discoverSockets(dir)).map(connect))).filter(Boolean);
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [file, flag, speed, ...rest] = process.argv.slice(2);
    if (!file || rest.length || (flag !== undefined && (flag !== '--speed' || speed === undefined))) {
      throw new Error('Usage: node replay.mjs FILE.jsonl [--speed 4]');
    }
    const result = await replayFile({ file, speed: speed === undefined ? 1 : Number(speed) });
    console.error(`Replayed ${result.events} events to ${result.renderers} renderers`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
