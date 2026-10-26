// Private, bounded recordings. Only projected cursor events and copies of existing screenshots enter this bank.
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { downscaleScreenshot } from './screenshot.mjs';

export const RUN_BYTES = 5 * 1024 * 1024;
export const SHOT_BYTES = 192 * 1024;
export const RETENTION_MS = 30 * 86400000;
export const runRoot = () => join(userInfo().homedir, 'Library/Application Support/sleight/runs');
export const runIdValid = id => typeof id === 'string' && /^\d{4}-\d{2}-\d{2}-[a-f0-9]{32}$/.test(id) &&
  Number.isFinite(Date.parse(id.slice(0, 10))) && new Date(id.slice(0, 10)).toISOString().slice(0, 10) === id.slice(0, 10);
const sessionValid = s => typeof s === 'string' && /^[a-f0-9]{32}$/.test(s);
const rect = r => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite) && r[2] > 0 && r[3] > 0;

async function bank(root, create = false) {
  if (!isAbsolute(root) || normalize(root) !== root) throw Error('RUNS_UNSAFE');
  if (create) {
    // Check the nearest existing ancestor before mkdir, so a linked parent cannot receive even an empty runs folder.
    let parent = root;
    for (;;) {
      try { if (await realpath(parent) !== parent || !(await lstat(parent)).isDirectory()) throw Error('RUNS_UNSAFE'); break; }
      catch (e) { if (e.code !== 'ENOENT' || dirname(parent) === parent) throw e; parent = dirname(parent); }
    }
    await mkdir(root, { recursive: true, mode: 0o700 });
  }
  try {
    const s = await lstat(root);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o7777) !== 0o700 || await realpath(root) !== root) throw Error('RUNS_UNSAFE');
    return true;
  } catch (e) { if (!create && e.code === 'ENOENT') return false; throw e; }
}
const privateFile = s => s.isFile() && s.uid === process.getuid() && (s.mode & 0o7777) === 0o600 && s.nlink === 1 && s.size <= RUN_BYTES;
async function file(root, id, flags = constants.O_RDONLY) {
  if (!runIdValid(id) || !await bank(root)) throw Error('RUN_NOT_FOUND');
  const fd = await open(join(root, id + '.jsonl'), flags | constants.O_NOFOLLOW);
  try { if (!privateFile(await fd.stat())) throw Error('RUNS_UNSAFE'); return fd; }
  catch (e) { await fd.close(); throw e; }
}
export async function listRuns({ root = runRoot() } = {}) {
  if (!await bank(root)) return [];
  const rows = [];
  for (const name of (await readdir(root)).sort()) {
    const id = name.replace(/\.jsonl$/, '');
    if (name !== id + '.jsonl' || !runIdValid(id)) continue;
    const fd = await file(root, id);
    try { rows.push({ id, bytes: (await fd.stat()).size }); } finally { await fd.close(); }
  }
  return rows.reverse();
}
export async function readRun(id, { root = runRoot() } = {}) {
  const fd = await file(root, id);
  try {
    // Read at most the cap even if another same-user process grows the file after stat.
    const bytes = Buffer.alloc(RUN_BYTES + 1);
    let total = 0;
    while (total < bytes.length) { const { bytesRead } = await fd.read(bytes, total, bytes.length - total, total); if (!bytesRead) break; total += bytesRead; }
    if (total > RUN_BYTES) throw Error('RUN_TOO_LARGE');
    const lines = bytes.subarray(0, total).toString('utf8').split('\n');
    lines.pop(); // An interrupted final append is never replayed.
    return lines.filter(Boolean).map(line => JSON.parse(line));
  } finally { await fd.close(); }
}
export async function clearRuns({ root = runRoot() } = {}) {
  const rows = await listRuns({ root }); // Validate the whole selection before removing anything.
  for (const { id } of [...rows].reverse()) { await bank(root); const fd = await file(root, id); await fd.close(); await unlink(join(root, id + '.jsonl')); }
  return rows.length;
}
export async function pruneRuns({ root = runRoot(), now = Date.now() } = {}) {
  const rows = await listRuns({ root });
  let removed = 0;
  for (const { id } of [...rows].reverse()) if (Date.parse(id.slice(0, 10)) < now - RETENTION_MS) {
    await bank(root); const fd = await file(root, id); await fd.close(); await unlink(join(root, id + '.jsonl')); removed++;
  }
  return removed;
}

/** Nonblocking front end with one serial writer, 256 pending records and at most 2 pending image conversions.
 *  No retry after an unsafe path, a full file or clear. The tool result never awaits this work. */
export function createRunRecorder({ root = runRoot(), now = Date.now, encode = downscaleScreenshot, enabled = () => true } = {}) {
  let tail = Promise.resolve(), fd, id, session, size = 0, pending = 0, images = 0, closed = false, stopped = false, dropped = 0;
  const windows = new Map();
  const enqueue = task => {
    if (closed || stopped || pending >= 256) { dropped++; return false; }
    pending++;
    tail = tail.then(task).catch(async () => { stopped = true; if (fd) { await fd.close().catch(() => {}); fd = undefined; } })
      .finally(() => { pending--; });
    return true;
  };
  async function append(record) {
    if (stopped || !enabled()) return;
    if (!fd) {
      await bank(root, true); await pruneRuns({ root, now: now() });
      id = new Date(record.ts).toISOString().slice(0, 10) + '-' + record.session;
      fd = await open(join(root, id + '.jsonl'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    }
    await bank(root);
    const disk = await lstat(join(root, id + '.jsonl')), opened = await fd.stat();
    if (!privateFile(disk) || disk.ino !== opened.ino || disk.dev !== opened.dev || disk.size !== size) throw Error('RUNS_CHANGED');
    const line = Buffer.from(JSON.stringify(record) + '\n');
    if (size + line.length > RUN_BYTES) { stopped = true; dropped++; await fd.close(); fd = undefined; return; }
    let offset = 0;
    while (offset < line.length) { const { bytesWritten } = await fd.write(line, offset, line.length - offset); if (!bytesWritten) throw Error('RUN_WRITE_FAILED'); offset += bytesWritten; }
    size += line.length;
  }
  return {
    write(event) {
      if (!event || event.v !== 'sleight.cursor/1' || !sessionValid(event.session) || !Number.isFinite(event.ts)) return;
      session ??= event.session;
      if (event.session !== session) return;
      // Snapshot the already-filtered public event; subsequent caller mutations cannot enter the queue.
      const snapshot = JSON.parse(JSON.stringify(event));
      if (snapshot.window?.id && rect(snapshot.window.rect)) {
        windows.set(snapshot.window.id, snapshot.window.rect);
        if (windows.size > 64) windows.delete(windows.keys().next().value);
      }
      enqueue(() => append(snapshot));
    },
    screenshot(content, { windowId, source = 'native' } = {}) {
      if (closed || stopped || !session || !enabled() || images >= 2) return;
      const image = content?.filter(i => i?.type === 'image' && ['image/png', 'image/jpeg'].includes(i.mimeType)).at(-1);
      if (!image || typeof image.data !== 'string' || image.data.length > 24 * 1024 * 1024) return;
      const ts = now(), bounds = source === 'native' ? windows.get(windowId) : undefined;
      images++;
      if (!enqueue(async () => {
        try {
          if (stopped || !enabled()) return;
          let shot;
          try { shot = await encode(image); } catch { return; }
          if (!shot || shot.mimeType !== 'image/jpeg' || Buffer.from(shot.data, 'base64').length > SHOT_BYTES) return;
          await append({ v: 'sleight.run/1', type: 'screenshot', session, ts, source,
            ...(source === 'native' && Number.isSafeInteger(windowId) && windowId > 0 ? { window: { id: windowId, ...(bounds ? { rect: [...bounds] } : {}) } } : {}), image: shot });
        } finally { images--; }
      })) images--;
    },
    flush: () => tail,
    stats: () => ({ id, bytes: size, pending, dropped, stopped }),
    close() { closed = true; tail = tail.finally(async () => { if (fd) { await fd.close(); fd = undefined; } }); return tail; },
  };
}
