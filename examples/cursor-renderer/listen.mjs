// Standalone sleight.cursor/1 reader. Node 24, no sleight imports.
import net from 'node:net';
import { mkdir, lstat, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

export const defaultDirectory = () => process.env.SLEIGHT_CURSOR_STREAM_DIR ||
  join(homedir(), 'Library/Application Support/sleight/cursor/renderers');
const fields = 'v seq ts session type state host version call index phase kind source timing point path rect window display count role reason label app'.split(' ');
const phases = new Set(['aim', 'act', 'done', 'failed', 'declined', 'skipped']);
const statuses = new Set(['thinking', 'waiting', 'error', 'done', 'handback', 'idle']);
const point = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);

// Unknown fields never enter the view or its output. Unknown types are ignored.
export function parseEvent(line, warn = () => {}) {
  let e;
  try { e = JSON.parse(line); } catch { return; }
  if (!e || typeof e !== 'object' || Array.isArray(e)) return;
  if (e.v !== 'sleight.cursor/1') { warn(); return; }
  if (!Number.isSafeInteger(e.seq) || e.seq < 1 || !Number.isFinite(e.ts) ||
      typeof e.session !== 'string' || !/^[a-f0-9]{32}$/.test(e.session)) return;
  if (e.type === 'session') {
    if (!['start', 'end'].includes(e.state)) return;
  } else if (e.type === 'status') {
    if (!statuses.has(e.state)) return;
  } else if (e.type === 'action') {
    if (!phases.has(e.phase) || typeof e.kind !== 'string') return;
    if (e.point !== undefined && !point(e.point)) return;
    if (e.path !== undefined && (!Array.isArray(e.path) || e.path.length > 64 || !e.path.every(point))) return;
  } else return;
  return Object.fromEntries(fields.filter(k => Object.hasOwn(e, k)).map(k => [k, e[k]]));
}

export async function createCursorListener({ dir = defaultDirectory(), name = 'reference', onEvent = () => {},
  onWarning = message => console.error(message) } = {}) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error('Invalid renderer name (1..32 letters, digits, _ or -)');
  dir = resolve(dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) {
    throw new Error('Stream directory must be user-owned, not a symlink, mode 0700');
  }
  const path = join(dir, name + '.sock');
  if (Buffer.byteLength(path) > 103) throw new Error('Socket path exceeds macOS limit of 103 bytes; use a shorter directory or name');
  // Never unlink an existing socket: another renderer may still own it.
  try { await lstat(path); throw new Error('Renderer socket already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sessions = new Map(), clients = new Set();
  let warned = false, closing;
  const warn = () => {
    if (!warned) { warned = true; onWarning('Ignoring unsupported cursor stream version'); }
  };
  const server = net.createServer(socket => {
    clients.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => clients.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '', oversized = false;
    socket.on('data', chunk => {
      // Bound partial records, including a line split over many chunks.
      for (const part of chunk.match(/[^\n]*\n|[^\n]+$/g) || []) {
        const ended = part.endsWith('\n');
        if (!oversized) {
          buffer += part;
          if (Buffer.byteLength(buffer) > 65536) { buffer = ''; oversized = true; }
        }
        if (!ended) continue;
        const event = oversized ? undefined : parseEvent(buffer, warn);
        buffer = ''; oversized = false;
        if (!event) continue;
        const view = sessions.get(event.session) || {};
        view.seq = event.seq;
        if (event.point) view.point = [...event.point];
        if (event.type === 'action') view.phase = event.phase;
        if (event.type === 'status') view.status = event.state;
        if (event.type === 'session') view.state = event.state;
        sessions.set(event.session, view);
        onEvent(event, view);
      }
    });
  });
  server.listen(path);
  await once(server, 'listening');
  try { await chmod(path, 0o600); }
  catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
  return { path, sessions, close() {
    return closing ||= new Promise((resolve, reject) => {
      for (const client of clients) client.destroy();
      // Node removes the Unix socket created by this server on close.
      server.close(error => error ? reject(error) : resolve());
    });
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--name')) throw new Error('Usage: node listen.mjs [--name reference]');
    const listener = await createCursorListener({ name: args[1], onEvent: e => console.log(JSON.stringify(e)) });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      listener.close().catch(error => { console.error(error.message); process.exitCode = 1; });
    });
    console.error(`Listening: ${listener.path}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
