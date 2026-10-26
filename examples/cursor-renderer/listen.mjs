// Standalone sleight.cursor/1 reader. Node 24, no sleight imports.
import net from 'node:net';
import { mkdir, lstat, chmod, unlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

export const defaultDirectory = () => process.env.SLEIGHT_CURSOR_STREAM_DIR ||
  join(homedir(), 'Library/Application Support/sleight/cursor/renderers');
const fields = 'v seq ts session type state host version call index phase kind source timing point path rect window display count role reason label app'.split(' ');
const phases = new Set(['aim', 'act', 'done', 'failed', 'declined', 'skipped']);
const statuses = new Set(['thinking', 'waiting', 'error', 'done', 'handback', 'idle']);
const kinds = new Set(['click', 'double', 'right', 'key', 'type', 'drag', 'scroll', 'select', 'navigate', 'move']);
const point = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const rect = r => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] >= 0 && r[3] >= 0;
const object = o => o !== null && typeof o === 'object' && !Array.isArray(o);
const id = n => Number.isSafeInteger(n) && n >= 0;
const exposures = new Set(['exposed', 'covered', 'offscreen', 'other-space', 'minimized']);
const pick = (o, keys) => Object.fromEntries(keys.filter(k => Object.hasOwn(o, k)).map(k => [k, o[k]]));

// Unknown fields never enter the view or its output. Unknown types are ignored.
export function parseEvent(line, warn = () => {}) {
  let e;
  try { e = JSON.parse(line); } catch { return; }
  if (!e || typeof e !== 'object' || Array.isArray(e)) return;
  if (e.v !== 'sleight.cursor/1') { warn(); return; }
  if (!Number.isSafeInteger(e.seq) || e.seq < 1 || !Number.isFinite(e.ts) ||
      typeof e.session !== 'string' || e.session.length !== 32 || !/^[a-f0-9]{32}$/.test(e.session)) return;
  if (e.type === 'session') {
    if (!['start', 'end'].includes(e.state)) return;
  } else if (e.type === 'status') {
    if (!statuses.has(e.state)) return;
  } else if (e.type === 'action') {
    if (!phases.has(e.phase) || !kinds.has(e.kind)) return;
  } else return;
  if (e.type === 'action') delete e.state;
  else { delete e.phase; delete e.kind; }
  if (e.point !== undefined && !point(e.point)) return;
  if (e.path !== undefined && (!Array.isArray(e.path) || e.path.length > 64 || !e.path.every(point))) return;
  if (e.rect !== undefined && !rect(e.rect)) return;
  for (const key of ['call', 'host', 'version', 'source', 'timing', 'role', 'reason', 'label', 'app']) {
    if (e[key] !== undefined && typeof e[key] !== 'string') return;
  }
  for (const key of ['index', 'count']) if (e[key] !== undefined && !id(e[key])) return;
  if (e.window !== undefined && (!object(e.window) ||
    ['id', 'pid'].some(k => e.window[k] !== undefined && !id(e.window[k])) ||
    ['app', 'bundle'].some(k => e.window[k] !== undefined && typeof e.window[k] !== 'string') ||
    (e.window.rect !== undefined && !rect(e.window.rect)) ||
    (e.window.exposure !== undefined && !exposures.has(e.window.exposure)))) return;
  if (e.display !== undefined && (!object(e.display) ||
    (e.display.id !== undefined && !id(e.display.id)) ||
    (e.display.scale !== undefined && (!Number.isFinite(e.display.scale) || e.display.scale <= 0)))) return;
  const result = pick(e, fields);
  if (e.window) result.window = pick(e.window, ['id', 'pid', 'app', 'bundle', 'rect', 'exposure']);
  if (e.display) result.display = pick(e.display, ['id', 'scale']);
  return result;
}

export function isMain(url) {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url)); }
  catch { return false; }
}

async function recoverSocket(path) {
  const info = await lstat(path);
  if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o600) {
    throw new Error('Existing renderer socket must be user-owned, not a symlink, mode 0600 exactly');
  }
  await new Promise((resolve, reject) => {
    const probe = net.createConnection(path);
    const timer = setTimeout(() => { probe.destroy(); reject(new Error('Renderer socket probe timed out')); }, 1000);
    probe.once('connect', () => { clearTimeout(timer); probe.destroy(); reject(new Error('Renderer socket already in use')); });
    probe.once('error', error => { clearTimeout(timer); probe.destroy(); error.code === 'ECONNREFUSED' ? resolve() : reject(error); });
  });
  const current = await lstat(path);
  if (current.dev !== info.dev || current.ino !== info.ino || current.mode !== info.mode || current.uid !== info.uid) {
    throw new Error('Renderer socket changed during probe');
  }
  await unlink(path);
}

export async function createCursorListener({ dir = defaultDirectory(), name = 'reference', onEvent = () => {}, onRemove = () => {},
  onWarning = message => console.error(message) } = {}) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error('Invalid renderer name (1..32 letters, digits, _ or -)');
  dir = resolve(dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o7777) !== 0o700) {
    throw new Error('Stream directory must be user-owned, not a symlink, mode 0700');
  }
  const path = join(dir, name + '.sock');
  if (Buffer.byteLength(path) > 103) throw new Error('Socket path exceeds macOS limit of 103 bytes; use a shorter directory or name');
  const sessions = new Map(), clients = new Set();
  const lifetimes = new Map();
  let warned = false, closing;
  const warning = message => { try { onWarning(message); } catch { /* A warning must not kill the reader. */ } };
  const invoke = (callback, ...args) => { try { callback(...args); } catch (error) { warning(`Renderer callback failed: ${error?.message ?? String(error)}`); } };
  const remove = session => {
    const view = sessions.get(session);
    if (!view) return;
    view.visible = false;
    clearTimeout(lifetimes.get(session).timer);
    lifetimes.delete(session); sessions.delete(session);
    invoke(onRemove, session, view);
  };
  const warn = () => {
    if (!warned) { warned = true; warning('Ignoring unsupported cursor stream version'); }
  };
  const server = net.createServer(socket => {
    if (clients.size >= 16) { socket.destroy(); return; }
    clients.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => {
      clients.delete(socket);
      for (const [session, life] of lifetimes) {
        life.owners.delete(socket);
        if (!life.owners.size) remove(session);
      }
    });
    const buffer = Buffer.alloc(65536), decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0, oversized = false;
    socket.on('data', chunk => {
      // Count raw bytes once, with fixed storage even for one-byte chunks.
      for (let start = 0; start < chunk.length;) {
        const newline = chunk.indexOf(10, start), ended = newline !== -1;
        const end = ended ? newline : chunk.length, length = end - start;
        if (!oversized) {
          if (bytes + length > buffer.length) oversized = true;
          else { chunk.copy(buffer, bytes, start, end); bytes += length; }
        }
        start = end + (ended ? 1 : 0);
        if (!ended) continue;
        let event;
        if (!oversized) {
          try { event = parseEvent(decoder.decode(buffer.subarray(0, bytes)), warn); }
          catch { /* Discard invalid UTF-8 just as JSONSerialization does in Swift. */ }
        }
        bytes = 0; oversized = false;
        if (!event) continue;
        const view = sessions.get(event.session) || {};
        view.seq = event.seq;
        if (event.point) view.point = [...event.point];
        if (event.type === 'action') view.phase = event.phase;
        if (event.type === 'status') view.status = event.state;
        if (event.type === 'session') view.state = event.state;
        const terminal = (event.type === 'session' && event.state === 'end') ||
          (event.type === 'status' && ['done', 'handback', 'idle', 'error'].includes(event.state));
        if (terminal) {
          view.visible = false;
          invoke(onEvent, event, view);
          remove(event.session);
          continue;
        }
        if (!sessions.has(event.session) && sessions.size === 4) remove(sessions.keys().next().value);
        const life = lifetimes.get(event.session) || { owners: new Set(), drags: new Set(), overflow: false };
        life.owners.add(socket);
        clearTimeout(life.timer);
        life.timer = setTimeout(() => remove(event.session), 3000);
        lifetimes.set(event.session, life);
        const dragStart = event.type === 'action' && event.kind === 'drag' && ['aim', 'act'].includes(event.phase);
        if (dragStart) {
          const key = `${event.call ?? ''}:${event.index ?? 0}`;
          if (life.drags.has(key) || life.drags.size < 64) life.drags.add(key);
          else life.overflow = true; // Missing completions keep the ring hidden until expiry.
        }
        const dragging = life.drags.size > 0 || life.overflow;
        if (event.type === 'action' && event.kind === 'drag' && ['done', 'failed', 'declined', 'skipped'].includes(event.phase)) life.drags.delete(`${event.call ?? ''}:${event.index ?? 0}`);
        const hiddenAction = event.type === 'action' && ['skipped', 'failed', 'declined'].includes(event.phase);
        const visible = event.type === 'action' && event.point ? true : (view.visible ?? false);
        view.visible = visible && !dragging && !hiddenAction;
        sessions.set(event.session, view);
        invoke(onEvent, event, view);
      }
    });
  });
  // Probe only after EADDRINUSE, and retry the bind exactly once after a refused connection.
  try { server.listen(path); await once(server, 'listening'); }
  catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    await recoverSocket(path);
    server.listen(path); await once(server, 'listening');
  }
  server.on('error', error => warning(`Renderer server error: ${error.message}`));
  try { await chmod(path, 0o600); }
  catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
  return { path, sessions, close() {
    return closing ||= new Promise((resolve, reject) => {
      for (const client of clients) client.destroy();
      for (const session of sessions.keys()) remove(session);
      // Node removes the Unix socket created by this server on close.
      server.close(error => error ? reject(error) : resolve());
    });
  } };
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--name')) throw new Error('Usage: node listen.mjs [--name reference]');
    const listener = await createCursorListener({ name: args[1], onEvent: e => console.log(JSON.stringify(e)) });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => {
      listener.close().catch(error => { console.error(error.message); process.exitCode = 1; });
    });
    process.once('uncaughtException', error => {
      console.error(error?.message ?? String(error));
      process.exitCode = 1;
      listener.close().catch(error => console.error(error.message));
    });
    console.error(`Listening: ${listener.path}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
